/* ============================================================
   Daimond -- the rating roll-up, the pure half (DaimondRatingRoll)
   ------------------------------------------------------------
   Every rating head in every chat, and every product stamp, rolled into
   cells: one per level (chat, Diamond, account) and key (model, family,
   class, role:model, provider:model). A cell holds what a reader needs to
   say how a model is doing and how far that can be trusted: counts, a
   faded weight, a shrunk estimate, a 90% interval, exposure.

   Plan: ~/usr/code/ai/claude/specs/daimond_optimiser_532_plan_20261004.md
   §5 U5a; design: daimond_product_rating_design_20260924.md §5.2, §6.3,
   §8.1. Rulings: O1 (older ratings fade by NEWER RATINGS, never by a
   stamp: the k-th newest in a cell weighs 2^(-k/H), H = infinity at the
   chat, 25 at the Diamond, 50 across the account) and P8 (a rating
   credited `via: 'command'` weighs half).

   NO STAMP IS READ AS AN AGE (sync contract §5 rule 3). `ts` only orders
   records, as the head rule does, so the same transcripts give the same
   cells on every device whatever its clock says. Nothing here is stored:
   the cells are a pure function of the parts `chatPart` makes from the
   transcripts, and a rebuild from cold equals a rebuild from memoised
   parts, byte for byte, whatever order the parts arrive in.

   THE DIGEST HOLDS NO FREE TEXT. A part carries no note and the cells carry
   no handle, so a file path, a message, a chat id or a tag a person typed
   cannot reach `digestText`. Diamond names come from the list the caller
   passes, never from a rating.

   Pure: no DOM, no storage, no clock. Attaches `window.DaimondRatingRoll`,
   and reads `window.DaimondRatings` and `window.DaimondProvenance`
   (loaded before it) when it runs.
   ============================================================ */
(function () {
	'use strict';

	var K          = 5;						// the prior's weight in the shrunk estimate
	var FLOOR      = { 1: 3, 2: 6, 3: 10 };	// effective ratings that make a cell trusted
	var HALF       = { 1: Infinity, 2: 25, 3: 50 };	// newer ratings that halve an older one
	var Z90        = 1.6448536269514722;	// two-sided 90%
	var EDGES      = [400, 1500];			// length bands: < 400, 400 to 1500, > 1500 characters
	var BAND_MIN   = 3;						// ratings a model needs in a band to vote in a comparison
	var LEN_MIN    = 6;						// decisive ratings a band needs to speak for a length finding
	var LEN_GAP    = 0.3;					// share of down-rates that must rise or fall across the bands
	var TREND_W    = 10;					// the newest window, and the one before it
	var MORE_MAX   = 999;
	var ROWS       = 12;					// rows per table in the digest
	var ROWS_SMALL = 6;
	var DIAMONDS   = 12;
	var BEFORE_ROWS = 20;					// models in the closing block of the old counts
	var KINDS      = ['fam', 'cls', 'cm', 'role', 'pv'];	// families and classes first: models read them as priors
	var DIM_IDS    = ['correct', 'followed', 'length', 'style'];
	var TAG_RE     = /^[a-z0-9_]{1,32}$/;
	var LEVELS     = [3, 2, 1];

	function str(x) { return typeof x === 'string' ? x : ''; }
	function nat(x) { x = Number(x); return isFinite(x) && x > 0 ? Math.floor(x) : 0; }
	function ratings() { return (typeof window !== 'undefined') ? window.DaimondRatings : null; }
	function prov() { return (typeof window !== 'undefined') ? window.DaimondProvenance : null; }

	// ── The parts ──────────────────────────────────────────────

	// A is newer than B: the head rule's (ts, mid), then the handle, so the order is total.
	function newer(a, b) {
		if (a.ts !== b.ts) return a.ts > b.ts;
		if (a.mid !== b.mid) return a.mid > b.mid;
		return a.h > b.h;
	}

	function byNewest(a, b) { return newer(a, b) ? -1 : (newer(b, a) ? 1 : 0); }
	function byHandle(a, b) { return a.h < b.h ? -1 : (a.h > b.h ? 1 : 0); }

	function reduceHead(m) {
		var r = m.rating, p = r.prod, dims = {}, seen = {}, tags = [];
		DIM_IDS.forEach(function (id) {
			var v = r.dims ? r.dims[id] : -1;
			dims[id] = (typeof v === 'number' && Math.floor(v) === v && v >= 0 && v <= 4) ? v : -1;
		});
		(r.tags || []).forEach(function (t) { if (typeof t === 'string' && TAG_RE.test(t) && !seen[t]) { seen[t] = 1; tags.push(t); } });
		tags.sort();
		return {
			h: r.h, mid: m.mid, ts: m.ts, s: r.s, tags: tags, dims: dims, len: nat(r.len),
			via: p.via === 'command' ? 'command' : '',
			cm: str(p.cm), fam: str(p.fam), cls: str(p.cls), role: str(p.role), pv: str(p.pv), d: str(p.d), c: str(p.c),
		};
	}

	function stampOf(p) {
		return { h: p.h, k: p.k, cm: str(p.cm), fam: str(p.fam), cls: str(p.cls), role: str(p.role), pv: str(p.pv), d: str(p.d), c: str(p.c) };
	}

	// An answer that could be rated: final, written, not a streamed or interrupted partial.
	function rateable(m) {
		return !!m.mid && typeof m.content === 'string' && !!m.content.trim() && !m.provisional && !m.why;
	}

	/// What one chat gives the roll-up: `heads`, the head rating of each product it holds a record
	/// for (a withdrawn one is dropped), and `made`, every answer and changed-file row it holds a
	/// stamp for. Reduced to the keys a cell needs; no note and no text is copied. Memoisable.
	function chatPart(msgs) {
		var R = ratings(), P = prov(), list = Array.isArray(msgs) ? msgs : [];
		var heads = [], made = [], seen = {};
		if (R) {
			R.index(list).forEach(function (m) { if (m) heads.push(reduceHead(m)); });
		}
		if (P) {
			list.forEach(function (m) {
				if (!m || typeof m !== 'object') return;
				var want = m.role === 'assistant' ? (rateable(m) ? 'answer' : '') : ((m.role === 'user' || m.role === 'files_log') ? 'file' : '');
				if (!want) return;
				P.of(m).forEach(function (p) {
					if (p.k === want && !seen[p.h]) { seen[p.h] = 1; made.push(stampOf(p)); }
				});
			});
		}
		heads.sort(byHandle);
		made.sort(byHandle);
		return { heads: heads, made: made };
	}

	// ── Weights, trust, the interval ───────────────────────────

	/// The weight of the record with `k` newer ratings in its cell at `level` (1, 2, 3).
	function weight(level, k, via) {
		var H = HALF[level], w = H === Infinity ? 1 : Math.pow(2, -k / H);
		return via === 'command' ? w * 0.5 : w;
	}

	/// The 90% Wilson interval of a share `p` out of `n` (effective) ratings.
	function wilson(p, n) {
		if (!(n > 0)) return { lo: 0, hi: 1 };
		var z2 = Z90 * Z90, d = 1 + z2 / n, c = (p + z2 / (2 * n)) / d;
		var h = Z90 * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / d;
		return { lo: Math.max(0, c - h), hi: Math.min(1, c + h) };
	}

	// How many more full-weight ratings, newest of all, make the cell reach its floor.
	function moreFor(vias, level, floor) {
		var H = HALF[level];
		for (var j = 1; j <= MORE_MAX; j++) {
			var S = 0, Q = 0, i, x;
			for (i = 0; i < j; i++) { x = H === Infinity ? 1 : Math.pow(2, -i / H); S += x; Q += x * x; }
			for (i = 0; i < vias.length; i++) { x = (H === Infinity ? 1 : Math.pow(2, -(i + j) / H)) * vias[i]; S += x; Q += x * x; }
			if (S * S / Q >= floor) return j;
		}
		return MORE_MAX;
	}

	function band(len) { return len < EDGES[0] ? 0 : (len <= EDGES[1] ? 1 : 2); }

	function keyOf(kind, r) {
		switch (kind) {
			case 'cm':   return r.cm;
			case 'fam':  return r.fam;
			case 'cls':  return r.cls;
			case 'role': return r.role && r.cm ? r.role + ':' + r.cm : '';
			default:     return r.pv && r.cm ? r.pv + ':' + r.cm : '';
		}
	}

	function sidesOf(x) {
		if (!x) return null;
		var out = {};
		if (Array.isArray(x)) { x.forEach(function (t) { if (t && typeof t.id === 'string') out[t.id] = t.side === 'up' ? 'up' : 'down'; }); }
		else { Object.keys(x).forEach(function (id) { out[id] = x[id] === 'up' ? 'up' : 'down'; }); }
		var sorted = {};
		Object.keys(out).sort().forEach(function (id) { sorted[id] = out[id]; });
		return sorted;
	}

	// ── The cells ──────────────────────────────────────────────

	/// Rolls the parts (each from `chatPart`) into cells. `opts.sides` names each tag's side
	/// (`{ id: 'up' | 'down' }`, or the form's tag list) so fixed points can be counted.
	/// The result is the same for the same set of parts in any order. Read a cell with `cell`.
	function cells(parts, opts) {
		var sides = sidesOf(opts && opts.sides);
		var best = new Map(), prods = new Map();
		(parts || []).forEach(function (part) {
			((part && part.heads) || []).forEach(function (h) {
				var b = best.get(h.h);
				if (!b || newer(h, b)) best.set(h.h, h);
			});
			((part && part.made) || []).forEach(function (m) {
				var o = prods.get(m.h);
				if (!o || JSON.stringify(m) < JSON.stringify(o)) prods.set(m.h, m);
			});
		});
		var recs = Array.from(best.values()).sort(byNewest);
		recs.forEach(function (r) { if (!prods.has(r.h)) prods.set(r.h, stampOf({ h: r.h, k: '', cm: r.cm, fam: r.fam, cls: r.cls, role: r.role, pv: r.pv, d: r.d, c: r.c })); });

		var all = new Map(), famOf = {}, dOfChat = {}, seen = {};
		function acc(lv, sc, kind, key, fam) {
			var id = lv + '\u0001' + sc + '\u0001' + kind + '\u0001' + key, a = all.get(id);
			if (!a) {
				a = { level: lv, scope: sc, kind: kind, key: key, fam: fam, n: 0, w: 0, w2: 0, ws: 0, pos: 0, zero: 0, neg: 0,
					tags: {}, dims: {}, made: 0, up: [0, 0], dn: [0, 0], bands: [], rank: 0, open: 0, fixed: sides ? 0 : null,
					signs: [], vias: [], dw: 0, dw2: 0, dp: 0, newerPos: false };
				for (var i = 0; i < 3; i++) a.bands.push({ n: 0, w: 0, ws: 0, pos: 0, neg: 0 });
				all.set(id, a);
			}
			return a;
		}
		function scopeOf(lv, r) { return lv === 1 ? r.c : (lv === 2 ? r.d : ''); }

		recs.forEach(function (r) {
			if (r.cm && !famOf[r.cm]) famOf[r.cm] = r.fam;
			if (r.c && r.d && !dOfChat[r.c]) dOfChat[r.c] = r.d;
			[1, 2, 3].forEach(function (lv) {
				var sc = scopeOf(lv, r);
				if (lv < 3 && !sc) return;
				var sk = lv + '\u0001' + sc, at = seen[sk] || 0;
				seen[sk] = at + 1;
				KINDS.forEach(function (kind) {
					var key = keyOf(kind, r);
					if (!key) return;
					var a = acc(lv, sc, kind, key, kind === 'fam' ? key : (kind === 'cls' ? '' : r.fam));
					var wt = weight(lv, a.n, r.via);
					if (a.n === 0) a.rank = at;
					a.n++; a.w += wt; a.w2 += wt * wt; a.ws += wt * r.s;
					a.vias.push(r.via === 'command' ? 0.5 : 1);
					if (a.signs.length < 2 * TREND_W) a.signs.push(r.s > 0);
					if (r.s > 0) { a.pos++; a.dp += wt; a.dw += wt; a.dw2 += wt * wt; }
					else if (r.s < 0) { a.neg++; a.dw += wt; a.dw2 += wt * wt; }
					else a.zero++;
					r.tags.forEach(function (t) { a.tags[t] = (a.tags[t] || 0) + 1; });
					DIM_IDS.forEach(function (id) {
						if (r.dims[id] < 0) return;
						var d = a.dims[id] || (a.dims[id] = { n: 0, sum: 0 });
						d.n++; d.sum += r.dims[id];
					});
					if (r.len > 0) {
						var u = r.s > 0 ? a.up : (r.s < 0 ? a.dn : null);
						if (u) { u[0]++; u[1] += r.len; }
						var b = a.bands[band(r.len)];
						b.n++; b.w += wt; b.ws += wt * r.s;
						if (r.s > 0) b.pos++; else if (r.s < 0) b.neg++;
					}
					if (r.s === -2 && !a.newerPos) a.open++;
					if (r.s > 0) a.newerPos = true;
					if (sides && r.s === 2 && r.tags.some(function (t) { return sides[t] === 'up'; })) a.fixed++;
				});
			});
		});

		// Exposure: the products made at each scope, once per handle; a rated one always counts as made.
		prods.forEach(function (p) {
			[1, 2, 3].forEach(function (lv) {
				var sc = scopeOf(lv, p);
				if (lv < 3 && !sc) return;
				KINDS.forEach(function (kind) {
					var key = keyOf(kind, p);
					if (!key) return;
					var a = all.get(lv + '\u0001' + sc + '\u0001' + kind + '\u0001' + key);
					if (a) a.made++;
				});
			});
		});

		function get(lv, sc, kind, key) { return all.get(lv + '\u0001' + sc + '\u0001' + kind + '\u0001' + key) || null; }
		function parent(lv, sc) {
			if (lv === 3) return null;
			if (lv === 2) return { lv: 3, sc: '' };
			return dOfChat[sc] ? { lv: 2, sc: dOfChat[sc] } : { lv: 3, sc: '' };
		}

		// Trust, then the shrunk estimate, from the account down: a prior is a trusted cell above or beside.
		var ordered = Array.from(all.values()).sort(function (a, b) {
			if (a.level !== b.level) return b.level - a.level;
			if (a.kind !== b.kind) return KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind);
			if (a.scope !== b.scope) return a.scope < b.scope ? -1 : 1;
			return a.key < b.key ? -1 : (a.key > b.key ? 1 : 0);
		});
		ordered.forEach(function (a) {
			a.eff = a.w > 0 ? a.w * a.w / a.w2 : 0;
			a.floor = FLOOR[a.level];
			a.ok = a.eff >= a.floor;
			a.more = a.ok ? 0 : moreFor(a.vias, a.level, a.floor);
			var pw = a.dw > 0 ? a.dp / a.dw : 0, iv = a.dw > 0 ? wilson(pw, a.dw * a.dw / a.dw2) : { lo: 0, hi: 1 };
			a.share = a.dw > 0 ? pw : null;
			a.lo = a.dw > 0 ? iv.lo : null;
			a.hi = a.dw > 0 ? iv.hi : null;
			a.claim = a.ok && a.dw > 0 ? (iv.lo > 0.5 ? 'good' : (iv.hi < 0.5 ? 'bad' : '')) : '';
			var up = parent(a.level, a.scope), pr = null, src = 'none', f;
			if (up && (pr = get(up.lv, up.sc, a.kind, a.key)) && pr.ok) src = 'up';
			else {
				pr = null;
				if (a.fam && (a.kind === 'cm' || a.kind === 'role' || a.kind === 'pv')) {
					if ((f = get(a.level, a.scope, 'fam', a.fam)) && f.ok) { pr = f; src = 'fam'; }
					else if (up && (f = get(up.lv, up.sc, 'fam', a.fam)) && f.ok) { pr = f; src = 'famup'; }
				}
			}
			a.prior = src;
			a.theta = (a.ws + K * (pr ? pr.theta : 0)) / (a.w + K);
		});

		var out = { v: 1, sides: sides, products: { made: prods.size, rated: recs.length }, L1: {}, L2: {}, L3: {} };
		var byLevel = { 1: out.L1, 2: out.L2, 3: out.L3 };
		ordered.slice().sort(function (a, b) {
			if (a.level !== b.level) return a.level - b.level;
			if (a.scope !== b.scope) return a.scope < b.scope ? -1 : 1;
			if (a.kind !== b.kind) return KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind);
			return a.key < b.key ? -1 : (a.key > b.key ? 1 : 0);
		}).forEach(function (a) {
			var lvl = byLevel[a.level], sc = lvl[a.scope] || (lvl[a.scope] = {}), kd = sc[a.kind] || (sc[a.kind] = {});
			var tags = {}, dims = {};
			Object.keys(a.tags).sort().forEach(function (t) { tags[t] = a.tags[t]; });
			Object.keys(a.dims).sort().forEach(function (t) { dims[t] = a.dims[t]; });
			kd[a.key] = {
				level: a.level, scope: a.scope, kind: a.kind, key: a.key, fam: a.fam,
				n: a.n, w: a.w, w2: a.w2, ws: a.ws, pos: a.pos, zero: a.zero, neg: a.neg,
				tags: tags, dims: dims, made: Math.max(a.made, a.n),
				lenUp: a.up[0] ? Math.round(a.up[1] / a.up[0]) : null,
				lenDown: a.dn[0] ? Math.round(a.dn[1] / a.dn[0]) : null,
				bands: a.bands, rank: a.rank, open: a.open, fixed: a.fixed,
				trend: a.signs.length >= 2 * TREND_W ? {
					recent: { n: TREND_W, pos: a.signs.slice(0, TREND_W).filter(Boolean).length },
					prior: { n: TREND_W, pos: a.signs.slice(TREND_W).filter(Boolean).length } } : null,
				eff: a.eff, floor: a.floor, ok: a.ok, more: a.more,
				share: a.share, lo: a.lo, hi: a.hi, claim: a.claim, prior: a.prior, theta: a.theta,
			};
		});
		return out;
	}

	/// One cell, or null when the level and scope hold none: `level` 1 (scope the chat's id), 2 (the
	/// Diamond's id) or 3 (scope ''); `kind` one of cm, fam, cls, role, pv, and `key` as that kind
	/// reads (`role:model` and `provider:model` for the last two).
	function cell(roll, level, scope, kind, key) {
		var l = roll && roll['L' + level], s = l && l[scope || ''], k = s && s[kind];
		return (k && k[key]) || null;
	}

	// ── The style confound ─────────────────────────────────────

	function sign(x) { return Math.abs(x) < 1e-12 ? 0 : (x > 0 ? 1 : -1); }

	/// Compares two models in one scope without letting length decide: within each length band both
	/// fill, the better one is named, and the comparison is reported only if every band agrees.
	/// `why` says what stopped it: 'bands' (they disagree), 'overlap' (no band holds both), 'missing'.
	function compare(roll, level, scope, a, b) {
		var ca = cell(roll, level, scope, 'cm', a), cb = cell(roll, level, scope, 'cm', b), votes = [];
		if (!ca || !cb) return { report: false, dir: '', why: 'missing', bands: [] };
		for (var i = 0; i < 3; i++) {
			var x = ca.bands[i], y = cb.bands[i];
			if (x.n >= BAND_MIN && y.n >= BAND_MIN) votes.push({ band: i, vote: sign(x.ws / x.w - y.ws / y.w) });
		}
		if (!votes.length) return { report: false, dir: '', why: 'overlap', bands: votes };
		var v = votes[0].vote;
		var agree = v !== 0 && votes.every(function (t) { return t.vote === v; });
		return { report: agree, dir: agree ? (v > 0 ? 'a' : 'b') : '', why: agree ? '' : 'bands', bands: votes };
	}

	/// Do down-rates follow length whatever the model? True, with the direction ('long' when longer
	/// answers are down-rated more, 'short' for the reverse), when the pooled share of down-rates
	/// moves by at least a third across the bands that hold enough ratings, steadily, and no model
	/// with two such bands moves the other way.
	function lengthFinding(roll, level, scope) {
		var l = roll && roll['L' + level], s = l && l[scope || ''], cm = (s && s.cm) || {};
		var pool = [0, 1, 2].map(function () { return { dec: 0, neg: 0 }; }), models = [];
		Object.keys(cm).forEach(function (k) {
			var own = cm[k].bands.map(function (b, i) {
				pool[i].dec += b.pos + b.neg; pool[i].neg += b.neg;
				return { dec: b.pos + b.neg, neg: b.neg };
			});
			models.push(own);
		});
		function series(bs) { return bs.filter(function (b) { return b.dec >= LEN_MIN; }).map(function (b) { return b.neg / b.dec; }); }
		var sh = series(pool), none = { found: false, dir: '', bands: pool, models: 0 };
		if (sh.length < 2) return none;
		var move = sh[sh.length - 1] - sh[0], dir = move > 0 ? 1 : -1;
		if (Math.abs(move) < LEN_GAP) return none;
		for (var i = 1; i < sh.length; i++) { if ((sh[i] - sh[i - 1]) * dir < 0) return none; }
		var n = 0;
		for (var m = 0; m < models.length; m++) {
			var o = series(models[m]);
			if (o.length < 2) continue;
			n++;
			if ((o[o.length - 1] - o[0]) * dir <= 0) return none;
		}
		return { found: true, dir: dir > 0 ? 'long' : 'short', bands: pool, models: n };
	}

	// ── The digest ─────────────────────────────────────────────

	function clean(s, max) {
		s = String(s == null ? '' : s).replace(/\|/g, '/').replace(/[\r\n\t]+/g, ' ').replace(/ +/g, ' ').trim();
		return s.length > (max || 64) ? s.slice(0, max || 64) : s;
	}

	function pct(x) { return Math.round(x * 100) + '%'; }
	function num(x) { var t = (Math.round(x * 100) / 100).toFixed(2); return t === '-0.00' ? '0.00' : t; }

	function trustText(c) {
		if (!c.ok) return 'not enough yet, ' + c.more + ' more';
		return c.claim === 'good' ? 'trusted, good' : (c.claim === 'bad' ? 'trusted, bad' : 'trusted');
	}

	function countText(c) {
		return c.pos + ' up, ' + c.neg + ' down' + (c.zero ? ', ' + c.zero + ' neutral' : '');
	}

	function row(c, roll, extra) {
		var known = roll.sides, tags = '-';
		if (known) {
			var ts = Object.keys(c.tags).filter(function (t) { return known[t]; }).sort(function (a, b) { return c.tags[b] - c.tags[a] || (a < b ? -1 : 1); });
			if (ts.length) tags = ts.slice(0, 3).map(function (t) { return t + ' ' + c.tags[t]; }).join(', ');
		}
		var tr = c.trend ? 'newest ' + TREND_W + ': ' + c.trend.recent.pos + ' up; the ' + TREND_W + ' before: ' + c.trend.prior.pos + ' up' : '-';
		return '| ' + clean(c.key) + ' | ' + c.n + ' of ' + c.made + ' made | ' + countText(c) + ' | ' + num(c.theta) + ' | '
			+ (c.share === null ? '-' : pct(c.share) + ' (' + pct(c.lo) + ' to ' + pct(c.hi) + ')') + ' | ' + trustText(c) + ' | ' + tags
			+ ' | ' + c.open + ' | ' + (c.fixed === null ? '-' : c.fixed) + ' | ' + tr + ' |';
	}

	var HEAD = '| ' + ['model', 'rated of made', 'rated', 'theta', 'positive share (90%)', 'trust', 'leading tags', 'open negatives', 'fixed points', 'trend'].join(' | ') + ' |';
	var RULE = '|' + HEAD.split('|').slice(1, -1).map(function () { return '---|'; }).join('');

	function table(L, label, list, roll, limit, noun) {
		var sorted = list.slice().sort(function (a, b) { return b.n - a.n || (a.key < b.key ? -1 : 1); });
		if (label) { L.push(label); L.push(''); }
		L.push(HEAD.replace('model', noun || 'model'));
		L.push(RULE);
		sorted.slice(0, limit).forEach(function (c) { L.push(row(c, roll)); });
		if (sorted.length > limit) L.push('| and ' + (sorted.length - limit) + ' more ' + (noun || 'model') + 's | | | | | | | | | |');
		L.push('');
	}

	function values(map) { return map ? Object.keys(map).sort().map(function (k) { return map[k]; }) : []; }

	function findings(L, roll, level, scope) {
		var cm = values(roll['L' + level][scope] && roll['L' + level][scope].cm).filter(function (c) { return c.ok; })
			.sort(function (a, b) { return b.n - a.n || (a.key < b.key ? -1 : 1); }).slice(0, 4);
		var lf = lengthFinding(roll, level, scope), n = 0;
		if (lf.found) {
			L.push('- Length: down-rates ' + (lf.dir === 'long' ? 'rise as answers get longer' : 'rise as answers get shorter')
				+ ', whichever model answers (a `length` finding, not a difference between models).');
		}
		for (var i = 0; i < cm.length && n < ROWS_SMALL; i++) {
			for (var j = i + 1; j < cm.length && n < ROWS_SMALL; j++) {
				var r = compare(roll, level, scope, cm[i].key, cm[j].key);
				n++;
				L.push('- ' + clean(cm[i].key) + ' and ' + clean(cm[j].key) + ': ' + (r.report
					? (r.dir === 'a' ? clean(cm[i].key) : clean(cm[j].key)) + ' does better within every length band both fill (' + r.bands.length + ').'
					: (r.why === 'overlap' ? 'not compared: they share no length band.' : 'not compared: the length bands disagree.')));
			}
		}
		if (L[L.length - 1] !== '') L.push('');
	}

	/// The Ratings section of the Optimiser's digest, as markdown: per model, the counts, theta with
	/// the interval of the positive share, whether it is trusted, the leading tags of the form,
	/// exposure, open negatives, fixed points and the trend by count. `names` maps Diamond ids to
	/// the names in the Diamond list (an object, or a list of `{ id, name }`); nothing a rating
	/// holds is written.
	function digestText(roll, names) {
		var nm = {};
		if (Array.isArray(names)) names.forEach(function (d) { if (d && d.id) nm[d.id] = d.name; });
		else if (names && typeof names === 'object') nm = names;
		var L = [
			'## Ratings', '',
			'Counted on this device from the ratings in the chats it holds, never sent anywhere. No note, no message,',
			'no file path, no tag a person typed and no chat name is written here, and no date: an older rating counts',
			'less only because newer ones of the same model have followed it (the k-th newest weighs 2^(-k/H), with H = 25',
			'in a Diamond and 50 across the account, and a rating credited to a command counts half).',
			'Theta runs from -2 to +2 and is pulled towards the level above while a cell is thin. A cell is trusted at',
			'3, 6 or 10 effective ratings (chat, Diamond, account); a cell below that says how many more it needs',
			'and is used by nothing. Implicit signals: not yet recorded.', '',
		];
		var acct = roll && roll.L3 && roll.L3[''];
		if (!acct || !acct.cm) { L.push('Nothing rated yet.'); L.push(''); return L.join('\n'); }
		L.push('### Account, every Diamond and chat'); L.push('');
		table(L, '', values(acct.cm), roll, ROWS, 'model');
		['fam', 'cls', 'role', 'pv'].forEach(function (kind) {
			var noun = { fam: 'family', cls: 'class', role: 'role and model', pv: 'provider and model' }[kind];
			if (acct[kind]) table(L, 'By ' + noun + ':', values(acct[kind]), roll, ROWS_SMALL, noun);
		});
		findings(L, roll, 3, '');
		var ids = Object.keys(roll.L2 || {}).sort(function (a, b) {
			var x = roll.L2[a].cm, y = roll.L2[b].cm, nx = 0, ny = 0;
			values(x).forEach(function (c) { nx += c.n; }); values(y).forEach(function (c) { ny += c.n; });
			return ny - nx || (a < b ? -1 : 1);
		});
		ids.slice(0, DIAMONDS).forEach(function (id) {
			var label = typeof nm[id] === 'string' && nm[id].trim() ? clean(nm[id]) : clean(id) + ' (not in the Diamond list)';
			L.push('### Diamond: ' + label); L.push('');
			table(L, '', values(roll.L2[id].cm), roll, ROWS_SMALL, 'model');
			findings(L, roll, 2, id);
		});
		if (ids.length > DIAMONDS) { L.push('And ' + (ids.length - DIAMONDS) + ' more Diamonds, left out.'); L.push(''); }
		return L.join('\n');
	}

	// ── The old Models-page counts (O4) ────────────────────────

	/// The Models page's old counts (`{ model: { up, down } }`, as JSON or as the parsed object) as a
	/// list, the most tapped first and ties by model. A store that is absent, corrupt or another shape
	/// is an empty list; a count that is not a positive whole number reads as zero.
	function legacy(raw) {
		var obj = raw;
		if (typeof raw === 'string') { try { obj = JSON.parse(raw); } catch (e) { return []; } }
		if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [];
		var by = {}, out = [];
		Object.keys(obj).forEach(function (k) {
			var v = obj[k], model = clean(k), up = nat(v && v.up), down = nat(v && v.down);
			if (!model || up + down === 0) return;
			var o = by[model] || (by[model] = { model: model, up: 0, down: 0 });
			o.up += up; o.down += down;
		});
		Object.keys(by).forEach(function (k) { out.push(by[k]); });
		return out.sort(function (a, b) {
			return (b.up + b.down) - (a.up + a.down) || (a.model < b.model ? -1 : (a.model > b.model ? 1 : 0));
		});
	}

	/// The closing block of the digest: what those counts said, one line per model, kept apart from
	/// every figure above it, which none of them enters. Empty when there are none.
	function beforeText(list) {
		if (!Array.isArray(list) || !list.length) return '';
		var L = [
			'## Before answer ratings (this device, Models page)', '',
			'Taps the Models page counted on this device before answers could be rated. They name no answer, no Diamond',
			'and no date, so no figure above counts them.', '',
		];
		list.slice(0, BEFORE_ROWS).forEach(function (r) {
			L.push('- ' + clean(r.model) + ': ' + nat(r.up) + ' up, ' + nat(r.down) + ' down');
		});
		if (list.length > BEFORE_ROWS) L.push('And ' + (list.length - BEFORE_ROWS) + ' more models, left out.');
		L.push('');
		return L.join('\n');
	}

	window.DaimondRatingRoll = {
		K: K, FLOOR: FLOOR, HALF: HALF,
		chatPart: chatPart, cells: cells, cell: cell, weight: weight, wilson: wilson,
		compare: compare, lengthFinding: lengthFinding, digestText: digestText,
		legacy: legacy, beforeText: beforeText,
	};
})();
