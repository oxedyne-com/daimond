/* ============================================================
   Daimond -- ratings, the pure half (DaimondRatings)
   ------------------------------------------------------------
   The record a rating is written as (`rating_log` messages, plan §2),
   the one rule that says which record counts (§2.4), the lit state of
   the arrows, and the burst: the ratings made between two commits,
   which land together, once, at the end of the chat.

   Plan: ~/usr/code/ai/claude/specs/daimond_rating_u2_plan_20260930.md.
   The bytes are pinned by dev/fixtures/rating_u2.json, which U4's Rust
   must read and reproduce.

   A rating is only ever appended. A change of mind is a new record
   naming the one it supersedes (`sup`), so it wins at any clock skew;
   two records made without seeing each other are ordered by (ts, mid)
   the same way on every device. Nothing here is stored: the index is
   derived from a chat's messages each time it is read.

   Pure: no DOM and no storage. Attaches `window.DaimondRatings`, and
   reads `window.DaimondProvenance` (loaded before it) when it runs.
   ============================================================ */
(function () {
	'use strict';

	var FORM_ID   = 'daimond/1';	// the form this build writes
	var NOTE_MAX  = 8192;			// UTF-8 bytes of the user's words (rating.rs NOTE_MAX)
	var BURST_MS  = 10000;			// quiet that commits a burst
	var DIM_IDS   = ['correct', 'followed', 'length', 'style'];
	var SRCS      = ['tap', 'popup', 'typed', 'import:cc'];
	var TAG_RE    = /^[a-z0-9_]{1,32}$/;
	var MINUS     = '−';

	function prov() { return (typeof window !== 'undefined') ? window.DaimondProvenance : null; }
	function isInt(n, lo, hi) { return typeof n === 'number' && Math.floor(n) === n && n >= lo && n <= hi; }
	function side(s) { return s > 0 ? 'up' : (s < 0 ? 'down' : ''); }

	// ── The form ───────────────────────────────────────────────

	/// The form the wasm's `rating_form()` returns, as the widget needs it.
	/// `tagsFor` gives tag ids in form order; `keyOf` the catalogue key of one.
	function form(json) {
		var f = typeof json === 'string' ? JSON.parse(json) : json;
		if (!f || typeof f.form !== 'string' || !Array.isArray(f.scale) || !Array.isArray(f.dims) || !Array.isArray(f.tags)) {
			throw new Error('rating: not a rating form');
		}
		return {
			form:  f.form,
			scale: f.scale,
			dims:  f.dims,
			tags:  f.tags,
			tagsFor: function (kind, sd) {
				return f.tags.filter(function (t) {
					return t.side === sd && Array.isArray(t.kinds) && t.kinds.indexOf(kind) >= 0;
				}).map(function (t) { return t.id; });
			},
			keyOf: function (id) {
				for (var i = 0; i < f.tags.length; i++) if (f.tags[i].id === id) return f.tags[i].key;
				return 'rating.tag.' + id;		// a tag the form does not hold: the person's own
			},
		};
	}

	// ── Ids ────────────────────────────────────────────────────

	// Five base-36 characters from a string or a number in [0, 1).
	function r5(x) {
		var s;
		if (typeof x === 'string') s = x.toLowerCase().replace(/[^0-9a-z]/g, '');
		else s = Math.floor((Number(x) || 0) * 60466176).toString(36);		// 36^5
		while (s.length < 5) s = '0' + s;
		return s.slice(0, 5);
	}
	function bump(s) { return r5(((parseInt(s, 36) + 1) % 60466176).toString(36)); }

	/// A rating id: `r-<ms in base 36>-<five base-36 characters>` (rating.rs `is_rating_id`).
	function newId(now, rand5) {
		return 'r-' + Math.floor(Number(now) || 0).toString(36) + '-' + r5(rand5 === undefined ? Math.random() : rand5);
	}

	function mint(now, rand, used) {
		var r = r5(typeof rand === 'function' ? rand() : Math.random());
		var id = newId(now, r);
		while (used[id]) { r = bump(r); id = newId(now, r); }
		used[id] = 1;
		return id;
	}

	/// The answer's mid inside a product handle: what follows the first `/`.
	function midOf(h) {
		var s = String(h || ''), i = s.indexOf('/');
		return i < 0 ? '' : s.slice(i + 1);
	}

	var FILE_RE = /^p1:file:([^\/]+)\/v(\d+)\/(.+)$/;

	/// A file product's handle taken apart: `{ store, v, path }`, or null for anything else. The
	/// store is a Diamond id or `chat:<id>` and holds no `/`; what follows `/v<N>/` is the path.
	function fileOf(h) {
		var m = FILE_RE.exec(String(h == null ? '' : h));
		return m ? { store: m[1], v: Number(m[2]), path: m[3] } : null;
	}

	function isFile(h) { return fileOf(h) !== null; }

	// ── The record ─────────────────────────────────────────────

	function normTags(tags) {
		var seen = {}, out = [];
		(Array.isArray(tags) ? tags : []).forEach(function (t) {
			if (typeof t === 'string' && TAG_RE.test(t) && !seen[t]) { seen[t] = 1; out.push(t); }
		});
		return out.sort();
	}

	function normDims(d) {
		var out = {};
		DIM_IDS.forEach(function (id) {
			var v = d && typeof d === 'object' ? d[id] : -1;
			out[id] = isInt(v, 0, 4) ? v : -1;
		});
		return out;
	}

	// The note, cut to NOTE_MAX bytes of UTF-8 on a code-point boundary.
	function cutNote(note) {
		var s = String(note == null ? '' : note);
		if (s.length * 3 <= NOTE_MAX) return s;
		var used = 0, out = '', cps = Array.from(s);
		for (var i = 0; i < cps.length; i++) {
			var c = cps[i].codePointAt(0);
			var n = c < 0x80 ? 1 : (c < 0x800 ? 2 : (c < 0x10000 ? 3 : 4));
			if (used + n > NOTE_MAX) break;
			used += n;
			out += cps[i];
		}
		return out;
	}

	/// The exact `Rating` (plan §2.2): every key, in declared order.
	/// `clear` withdraws, and forces the rest to empty. Throws on a `prod` this
	/// build cannot read, on `s` outside -2..2, and on a source the form does not name.
	function build(o) {
		o = o || {};
		var P = prov();
		if (!P || !P.isProd(o.prod)) throw new Error('rating: the product is not a record this build reads');
		if (!isInt(o.s, -2, 2)) throw new Error('rating: score ' + o.s + ' is not a whole number from -2 to 2');
		if (SRCS.indexOf(o.src) < 0) throw new Error('rating: source ' + o.src + ' is not one the form names');
		var clear = o.clear === true;
		var prod = JSON.parse(JSON.stringify(o.prod));
		var file = prod.k === 'file';		// the bytes are pinned by `hash`; a tool path and a length are an answer's confounds (D6)
		return {
			h:      prod.h,
			hash:   String(prod.hash || ''),					// '' for an answer, and for a file that has gone
			s:      clear ? 0 : o.s,
			clear:  clear,
			tags:   clear ? [] : normTags(o.tags),
			dims:   normDims(clear ? null : o.dims),
			note:   clear ? '' : cutNote(o.note),
			form:   o.form == null ? FORM_ID : String(o.form),
			src:    o.src,
			sup:    o.sup ? String(o.sup) : '',
			priv:   false,
			hx:     'daimond',
			burst:  String(o.burst || ''),
			tools:  file ? '' : String(o.tools || ''),
			len:    file ? 0 : Math.max(0, Math.floor(Number(o.len) || 0)),
			prod:   prod,
		};
	}

	/// The `rating_log` message, keys in declared order. It has no `content`.
	function message(rating, mid, ts) {
		return { role: 'rating_log', mid: String(mid), ts: Math.floor(Number(ts) || 0), rating: rating };
	}

	function knownForm(f) { return f === FORM_ID || (typeof f === 'string' && f.indexOf(FORM_ID + '.') === 0 && /^\d+$/.test(f.slice(FORM_ID.length + 1))); }

	/// Is this a `rating_log` this build can read? A record from a later build is
	/// not drawn and not counted.
	function isRatingMsg(m) {
		if (!m || m.role !== 'rating_log' || typeof m.mid !== 'string' || !m.mid) return false;
		if (typeof m.ts !== 'number' || !isFinite(m.ts)) return false;
		var r = m.rating, P = prov();
		if (!r || typeof r !== 'object' || typeof r.h !== 'string' || !r.h) return false;
		if (!isInt(r.s, -2, 2) || typeof r.clear !== 'boolean') return false;
		if (!Array.isArray(r.tags) || !r.dims || typeof r.dims !== 'object') return false;
		if (typeof r.note !== 'string' || typeof r.sup !== 'string' || !knownForm(r.form)) return false;
		return !!(P && P.isProd(r.prod));
	}

	// ── The head rule (§2.4) ───────────────────────────────────

	function later(a, b) {
		if (a.ts !== b.ts) return a.ts > b.ts;
		return a.mid > b.mid;
	}

	// The head of one product's records: drop those another names in `sup`, then the
	// greatest (ts, mid). A ring of records each naming another cannot happen, but if
	// it did the rating would fall back to the greatest of all rather than vanish.
	function pick(recs) {
		var gone = {}, best = null, any = null;
		recs.forEach(function (r) { if (r.rating.sup && r.rating.sup !== r.mid) gone[r.rating.sup] = 1; });
		recs.forEach(function (r) {
			if (!any || later(r, any)) any = r;
			if (!gone[r.mid] && (!best || later(r, best))) best = r;
		});
		return best || any;
	}

	/// The head record of `h`, cleared or not, or null. It is what the next record
	/// for `h` names in `sup`.
	function headRaw(messages, h) {
		var recs = [], list = messages || [];
		for (var i = 0; i < list.length; i++) {
			if (isRatingMsg(list[i]) && list[i].rating.h === h) recs.push(list[i]);
		}
		return recs.length ? pick(recs) : null;
	}

	/// The head record of `h`, or null when it has none or the head withdraws.
	function head(messages, h) {
		var r = headRaw(messages, h);
		return r && !r.rating.clear ? r : null;
	}

	/// `Map<h, head>` for every product the chat holds a record for; a withdrawn one maps to null.
	function index(messages) {
		var byH = new Map(), out = new Map(), list = messages || [];
		for (var i = 0; i < list.length; i++) {
			var m = list[i];
			if (!isRatingMsg(m)) continue;
			var recs = byH.get(m.rating.h);
			if (!recs) { recs = []; byH.set(m.rating.h, recs); }
			recs.push(m);
		}
		byH.forEach(function (recs, h) {
			var r = pick(recs);
			out.set(h, r.rating.clear ? null : r);
		});
		return out;
	}

	// ── The lit state (I8) ─────────────────────────────────────

	function detailOf(s, clear, tags, dims, note) {
		if (clear) return false;
		if (s === 2 || s === -2 || s === 0) return true;
		if (tags && tags.length) return true;
		if (note) return true;
		return DIM_IDS.some(function (id) { return dims && isInt(dims[id], 0, 4); });
	}

	/// The lit state of `h` from its head (raw or not) and the pending burst. A draft
	/// takes precedence over the head. `detail` is true when the rating is more than a
	/// bare +1 or -1.
	function stateWith(headMsg, burst, h) {
		var live = headMsg && headMsg.rating && !headMsg.rating.clear ? headMsg : null;
		var d = burst && burst.drafts ? burst.drafts.get(h) : null;
		if (d) {
			var s = d.clear ? 0 : d.s;
			return { lit: side(s), s: s, detail: detailOf(s, d.clear, d.tags, d.dims, d.note), pending: true, head: live };
		}
		if (live) {
			var r = live.rating;
			return { lit: side(r.s), s: r.s, detail: detailOf(r.s, false, r.tags, r.dims, r.note), pending: false, head: live };
		}
		return { lit: '', s: 0, detail: false, pending: false, head: null };
	}

	function stateOf(messages, burst, h) { return stateWith(head(messages, h), burst, h); }

	/// The tool path of the answer, as the record holds it.
	function toolsOf(messages, prod, mid) {
		var P = prov();
		return P ? P.toolPath(messages, prod && prod.t, mid).join('>') : '';
	}

	// ── The burst ──────────────────────────────────────────────
	// b = { drafts: Map<h, draft>, last: ms of the latest action }. A draft is
	// { ctx, s, clear, tags, dims, note, src, sup }; `ctx` and `sup` are taken when
	// the draft is first made. `ctx`: { head, prod, tools, len, form }, where `head`
	// is the product's head record as `headRaw` gives it, or null.

	function createBurst() { return { drafts: new Map(), last: 0 }; }

	function clock(now) { return now == null ? Date.now() : now; }
	function ctxLive(ctx) { return !!(ctx && ctx.head && ctx.head.rating && !ctx.head.rating.clear); }
	function blank(ctx) {
		return { ctx: ctx, s: 0, clear: false, tags: [], dims: normDims(null), note: '', src: 'tap', sup: ctx && ctx.head ? ctx.head.mid : '' };
	}

	/// A tap on an arrow (`sign` > 0 up). A tap on the arrow already lit withdraws:
	/// a clear draft if the product has a head that stands, else the draft is dropped.
	/// Any other tap sets +1 or -1 with the source `tap`; the tags go when the side
	/// changes, and the dimensions and the words stay.
	function tap(b, ctx, h, sign, now) {
		var want = sign > 0 ? 'up' : 'down';
		var d = b.drafts.get(h);
		var c = d ? d.ctx : ctx;
		var lit = d ? (d.clear ? '' : side(d.s)) : (ctxLive(c) ? side(c.head.rating.s) : '');
		b.last = clock(now);
		if (lit === want) {
			if (ctxLive(c)) {
				var w = blank(c);
				w.clear = true;
				b.drafts.set(h, w);
			} else {
				b.drafts.delete(h);
			}
			return b.drafts.get(h) || null;
		}
		if (!d) { d = blank(c); b.drafts.set(h, d); }
		if (d.clear || side(d.s) !== want) d.tags = [];
		d.clear = false;
		d.s = sign > 0 ? 1 : -1;
		d.src = 'tap';
		return d;
	}

	/// Toggles a tag on the draft of `h`. Does nothing, and says so, without a draft.
	function toggleTag(b, h, id, now) {
		var d = b.drafts.get(h);
		if (!d || d.clear || typeof id !== 'string' || !TAG_RE.test(id)) return false;
		var i = d.tags.indexOf(id);
		if (i >= 0) d.tags.splice(i, 1); else d.tags = normTags(d.tags.concat([id]));
		b.last = clock(now);
		return true;
	}

	/// The popup's answer: replaces the draft of `h` whole and marks it `popup`.
	/// `draft`: { s, tags, dims, note }, or { clear: true }. `ctx` is needed only
	/// when `h` has no draft yet. A draft with no step and no clear is refused.
	function setDraft(b, h, draft, ctx, now) {
		draft = draft || {};
		var d0 = b.drafts.get(h);
		var c = d0 ? d0.ctx : ctx;
		if (!c) throw new Error('rating: a draft needs the context of its product');
		var clear = draft.clear === true;
		if (!clear && !isInt(draft.s, -2, 2)) return false;
		b.drafts.set(h, {
			ctx:   c,
			s:     clear ? 0 : draft.s,
			clear: clear,
			tags:  clear ? [] : normTags(draft.tags),
			dims:  normDims(clear ? null : draft.dims),
			note:  clear ? '' : cutNote(draft.note),
			src:   'popup',
			sup:   d0 ? d0.sup : blank(c).sup,
		});
		b.last = clock(now);
		return true;
	}

	// Does the draft say what the product's head already says?
	function isHead(d) {
		if (!ctxLive(d.ctx)) return d.clear;
		if (d.clear) return false;
		var r = d.ctx.head.rating;
		return r.s === d.s && r.note === d.note
			&& JSON.stringify(normTags(r.tags)) === JSON.stringify(d.tags)
			&& JSON.stringify(normDims(r.dims)) === JSON.stringify(d.dims);
	}

	/// The number of drafts a commit would write.
	function pendingCount(b) {
		var n = 0;
		b.drafts.forEach(function (d) { if (!isHead(d)) n++; });
		return n;
	}

	/// Is it time to commit? Quiet for BURST_MS, a draft held, and no turn in flight.
	function due(b, now, inFlight) {
		return !!(b && b.drafts.size > 0 && !inFlight && now - b.last >= BURST_MS);
	}

	/// The messages for every draft that differs from its head, in the order first
	/// touched. All share `ts = now`, their ids ascend in that order, and their `burst`
	/// is the first one's id. Empties the burst. `now` is the time the records are made
	/// at: the caller gives the clock's time passed beyond the chat's last message, so a
	/// slow clock cannot put a rating before the message it follows. `rand` gives the five random characters
	/// of each id.
	function take(b, now, rand) {
		var list = Array.from(b.drafts.values()), used = {};
		b.drafts.clear();
		b.last = 0;
		var keep = list.filter(function (d) { return !isHead(d); });
		// A merge orders records of one ts by mid, so the ids of one burst are minted, then sorted,
		// to ascend in the order the lines were made. The burst's id is the first line's.
		var mids = keep.map(function () { return mint(now, rand, used); }).sort();
		var first = mids.length ? mids[0] : '';
		return keep.map(function (d, i) {
			var c = d.ctx;
			return message(build({
				prod: c.prod, s: d.s, clear: d.clear, tags: d.tags, dims: d.dims, note: d.note,
				src: d.src, sup: d.sup, burst: first, tools: c.tools, len: c.len, form: c.form,
			}), mids[i], now);
		});
	}

	// ── The Rating tile's line ─────────────────────────────────

	function signed(s) { return s > 0 ? '+' + s : (s < 0 ? MINUS + (-s) : '0'); }

	/// The words of one Rating tile line, before they are formatted. `target` is
	/// the rated message (an answer's `{ mid }`) or the rated file row (`{ h }`), or null
	/// where it has gone. A withdrawn record has no figure. For a file, `path` is the
	/// file's name from its handle and `targetH` the row it jumps to.
	function lineOf(msg, target) {
		var r = msg.rating, f = fileOf(r.h);
		return {
			kind:      f ? 'file' : 'answer',
			score:     r.clear ? '' : signed(r.s),
			cleared:   r.clear,
			targetMid: !f && target ? String(target.mid) : null,
			targetH:   f && target ? String(target.h) : null,
			path:      f ? f.path : '',
			tags:      r.tags.slice(),
			said:      r.note,
		};
	}

	// ── The note on the person's next message (U4) ─────────────

	var NOTE_BUDGET = 16384;		// UTF-8 bytes of the whole note (plan D8)

	// The English words for the tags, by id. The note is fixed on the typing device, so a model
	// in any locale reads the same bytes (plan D7); a test holds this table to `rating.tag.*` in i18n/en.js.
	var TAG_EN = {
		wrong: 'Wrong', ignored: 'Ignored instructions', long: 'Too long', short: 'Too short', style: 'Tone or format',
		tool: 'Tool use', refused: 'Refused or hedged', slow: 'Slow', correct: 'Correct', followed: 'Did as instructed',
		concise: 'Concise', style_good: 'Good style', broke: 'Broke something', wrong_change: 'Wrong change',
		incomplete: 'Incomplete', scope: 'Changed too much', wiped: 'Lost content', clean: 'Clean', complete: 'Complete',
		lost: 'Lost information', bloated: 'Bloated', faithful: 'Faithful', tidy: 'Tidy', tone: 'Tone', ready: 'Ready to send',
		not_useful: 'Not useful', already_knew: 'Already knew', useful: 'Useful',
	};

	/// The English word for a tag; a tag from a newer form is named by its id.
	function tagWord(id) { return Object.prototype.hasOwnProperty.call(TAG_EN, id) ? TAG_EN[id] : String(id); }

	function u8len(s) {
		var n = 0;
		for (var i = 0; i < s.length; i++) {
			var c = s.charCodeAt(i);
			if (c < 0x80) n += 1;
			else if (c < 0x800) n += 2;
			else if (c >= 0xD800 && c < 0xDC00) { n += 4; i++; }
			else n += 3;
		}
		return n;
	}

	function hhmmLocal(ts) {
		var d = new Date(ts);
		return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
	}

	// A message a person wrote: not an app's note to the model (the tail note carries its records in `prod`), and not a
	// record the app made itself (a trigger, a preset, a gather round, the Continue nudge: `app` true, set at creation).
	// A record from before the mark has no `app`, so it reads as the person's.
	function isOwn(m) {
		return !!m && m.role === 'user' && !Array.isArray(m.prod) && m.app !== true && String(m.content || '').indexOf('[Daimond:') !== 0;
	}

	/// The note for the person's next message, or '' when there is nothing to say. It tells the model
	/// the head of each product rated after the person's last own message, by position (plan D8), and
	/// reads only `messages`, which is one chat. A rating given and withdrawn since that message,
	/// which the model never heard of, says nothing. `opts.own` says which messages are a person's,
	/// `opts.hhmm` formats an answer's time; the defaults are this file's own.
	function noteFor(messages, opts) {
		var list = Array.isArray(messages) ? messages : [], o = opts || {};
		var own = o.own || isOwn, hhmm = o.hhmm || hhmmLocal;
		var cut = -1, i;
		for (i = list.length - 1; i >= 0; i--) { if (own(list[i])) { cut = i; break; } }
		var recs = new Map(), at = new Map(), ans = new Map();
		for (i = 0; i < list.length; i++) {
			var m = list[i];
			if (m && m.role === 'assistant' && typeof m.mid === 'string') ans.set(m.mid, m);
			if (!isRatingMsg(m)) continue;
			var h = m.rating.h, rs = recs.get(h);
			if (!rs) { rs = []; recs.set(h, rs); }
			rs.push(m);
			at.set(m, i);
		}
		var told = [];		// heads since the boundary, in transcript order, then oldest dropped first by the budget
		recs.forEach(function (rs, h) {
			var hd = pick(rs), pos = at.get(hd);
			if (pos <= cut) return;
			var before = rs.filter(function (r) { return at.get(r) <= cut; });
			var heard = before.length > 0 && !pick(before).rating.clear;
			if (hd.rating.clear && !heard) return;
			told.push({ pos: pos, h: h, r: hd.rating });
		});
		if (!told.length) return '';
		told.sort(function (a, b) { return a.pos - b.pos; });
		function what(h) {
			var f = fileOf(h);
			if (f) return 'the change to ' + f.path;
			var a = ans.get(midOf(h));
			return a && typeof a.ts === 'number' && isFinite(a.ts) ? 'your answer of ' + hhmm(a.ts) : 'an earlier answer';
		}
		function render(from) {
			var rated = [], gone = [];
			for (var k = from; k < told.length; k++) {
				var t = told[k], r = t.r;
				if (r.clear) { gone.push(what(t.h)); continue; }
				var c = 'rated ' + what(t.h) + ' ' + signed(r.s);
				if (r.tags.length) c += ' (' + r.tags.map(tagWord).join(', ') + ')';
				if (r.note) c += ': "' + r.note + '"';
				rated.push(c);
			}
			if (gone.length) rated.push('withdrew their rating of ' + (gone.length > 1 ? gone.slice(0, -1).join(', ') + ' and ' + gone[gone.length - 1] : gone[0]));
			var out = rated.map(function (c, k) { return (k === 0 ? 'the user ' : 'They ') + c + '.'; }).join(' ');
			if (from > 0) out += ' And ' + from + ' earlier rating' + (from > 1 ? 's' : '') + ' in this chat.';
			return '[Daimond: ' + out + ']';
		}
		var from = 0, text = render(0);
		while (u8len(text) > NOTE_BUDGET && from < told.length - 1) { from++; text = render(from); }
		return text;
	}

	window.DaimondRatings = {
		FORM: FORM_ID, NOTE_MAX: NOTE_MAX, BURST_MS: BURST_MS,
		form: form, newId: newId, midOf: midOf, fileOf: fileOf, isFile: isFile,
		build: build, message: message, isRatingMsg: isRatingMsg,
		head: head, headRaw: headRaw, index: index,
		stateOf: stateOf, stateWith: stateWith, toolsOf: toolsOf,
		createBurst: createBurst, tap: tap, toggleTag: toggleTag, setDraft: setDraft,
		pendingCount: pendingCount, due: due, take: take,
		lineOf: lineOf, noteFor: noteFor, tagWord: tagWord,
	};
})();
