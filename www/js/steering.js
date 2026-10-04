/* ============================================================
   Daimond -- steering notes, the pure half (DaimondSteering)
   ------------------------------------------------------------
   What the page may PROPOSE from the rating cells, and in what words. The page, not a
   model, raises a proposal; nothing is applied without a press (design decision 6 (a),
   plan P4). This file holds only the rules, so that "no proposal below the floor" is a
   property a test can prove (J5). U6b adds the note file (parse, serialise, select) to
   this same object.

   Plan: ~/usr/code/ai/claude/specs/daimond_optimiser_532_plan_20261004.md §5 U7a (and
   U6b, U7b), P4 to P7, J5, J8, J9; ruling O3 (a proposed note is a FIXED sentence per
   tag, which the person may edit before Add; no model call).

   A proposal needs `ok && claim` on the cell it reads: trusted (the effective-count
   floor), and a good or bad claim (the 90% Wilson interval excludes one half). Both are
   flags of the cell, from DaimondRatingRoll.

   NO STAMP IS READ AS AN AGE (sync contract §5 rule 3). "20 new rated products" is a
   difference of two cell counts: the count a note or dismissal recorded, and the count
   now. A proposal's evidence holds numbers and model or tag ids only, and no line names
   a reaction (J9, `signals.js`).

   The sentences are `t()` keys (`steer.line.<tag>`) held as data: the page words them
   through `ctx.t`, and lane M adds the key to each locale. The engine's lint
   (`steering::refusal`) is the one authority on what may enter a prompt; a test here
   holds each sentence to a mirror of its word list.

   U7c: the Steering list's data (`listing`, `addedMs`), what a removal records (`retireAt`) and P5's
   review of a switch (the `switched` status and the `back` proposal). A Switch pressed on a tile is
   on file, so that 20 new rated answers on the model it went to can ask Keep or Switch back. The
   entry holds the whole model the Diamond left (`was`: provider and id), so that Switch back
   restores that model and not a copy of it on another provider. The list marks a note the
   selection would not tell a model (`off`), by asking `select` itself.

   Pure: no DOM, no storage, no clock. Attaches `window.DaimondSteering`, and reads
   `window.DaimondRatingRoll` (loaded before it) when it runs.
   ============================================================ */
(function () {
	'use strict';

	var NOTE_SHARE = 0.3;	// the leading down tag's share of the cell's down-rates that earns a note
	var NEW_MIN    = 20;	// new rated products of a key that free a dismissed or retired entry, or call for a review

	// One fixed sentence per down tag a note can answer (answers and file changes: the two kinds
	// the Chat and Daimon roles produce). Each is under 110 bytes so five fit the 600 byte block.
	function line(tag, en) { return { key: 'steer.line.' + tag, en: en }; }
	var LINES = {
		wrong:        line('wrong',        'Check facts, figures and code before stating them, and say plainly when you are unsure.'),
		ignored:      line('ignored',      'Follow every instruction in the request, and check the answer against them before sending it.'),
		long:         line('long',         'Keep answers under about 200 words unless asked for detail.'),
		short:        line('short',        'Give fuller answers, with the reasoning and a worked example, unless a short one is asked for.'),
		style:        line('style',        'Write in a plain, neutral tone, and use lists, headings and tables only where they help.'),
		tool:         line('tool',         'Use a tool only when the task needs one, and say in a line what it did.'),
		refused:      line('refused',      'Answer the question asked; decline or hedge only for a real reason, and say what it is.'),
		slow:         line('slow',         'Go straight to the answer: skip preambles, and skip steps and tools the task does not need.'),
		broke:        line('broke',        'After changing a file, check that it still works, and say what was checked.'),
		wrong_change: line('wrong_change', 'Make the change that was asked for, then read the file again to confirm it is the one wanted.'),
		incomplete:   line('incomplete',   'Finish the whole change, and list anything left undone.'),
		scope:        line('scope',        'Change only what was asked for, and name each file touched.'),
		wiped:        line('wiped',        'Never remove content that was not asked about, and ask before deleting a file.'),
	};
	var TAGS = Object.keys(LINES).sort();
	var RANK = { 'switch': 0, note: 1, review: 2, back: 3 };

	function rr() { return (typeof window !== 'undefined') ? window.DaimondRatingRoll : null; }
	function str(x) { return typeof x === 'string' ? x : ''; }
	function nat(x) { x = Number(x); return isFinite(x) && x > 0 ? Math.floor(x) : 0; }
	function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
	function trusted(c) { return !!(c && c.ok && c.claim); }

	/// The sentence for a tag, or '' for a tag with none. `tr(key, english)` words it for the
	/// page's language; an empty answer, or the bare key coming back, falls back to English.
	function lineFor(tag, tr) {
		if (!has(LINES, tag)) return '';
		var e = LINES[tag], s = typeof tr === 'function' ? tr(e.key, e.en) : '';
		return (typeof s === 'string' && s.trim() && s !== e.key) ? s : e.en;
	}

	// ── The entries ────────────────────────────────────────────

	// The notes as `proposals` reads them. An entry that cannot be read is ignored here (the
	// note file's parser names it; it never rewrites what it cannot read).
	function entries(list) {
		var out = [];
		(Array.isArray(list) ? list : []).forEach(function (e) {
			if (!e || typeof e !== 'object') return;
			var st = e.status, lv = e.level === 2 ? 2 : (e.level === 3 ? 3 : 0), sc = lv === 2 ? str(e.scope) : '';
			if (st !== 'active' && st !== 'retired' && st !== 'dismissed' && st !== 'switched') return;
			if (st === 'switched' && lv !== 2) return;		// a switch is a Diamond's, never the account's
			if (!lv || (lv === 2 && !sc) || typeof e.cm !== 'string' || !e.cm || typeof e.tag !== 'string' || !e.tag) return;
			var at = e.at && typeof e.at === 'object' ? e.at : {};
			var rec = { id: str(e.id), status: st, cm: e.cm, to: str(e.to), tag: e.tag, level: lv, scope: sc,
				at: { t: nat(at.t), n: nat(at.n) }, kept: nat(e.kept), line: str(e.line) };
			if (e.was && typeof e.was === 'object' && typeof e.was.model === 'string' && e.was.model !== '') rec.was = { provider: str(e.was.provider), model: e.was.model };
			out.push(rec);
		});
		return out;
	}

	/// How many more rated products of the key a retired or dismissed `entry` waits for before it
	/// may be proposed again (P7); 0 once `cell` holds 20 more than the entry recorded. A cell that
	/// shrank, or is absent, has no new products.
	function cooling(entry, cell) {
		var was = nat(entry && entry.at && entry.at.n), now = nat(cell && cell.n);
		return Math.max(0, NEW_MIN - Math.max(0, now - was));
	}

	// Is a note proposal already answered: held by an active entry, or cooling after a retirement or dismissal?
	function held(list, p, cell) {
		return list.some(function (e) {
			if (e.tag !== p.tag || (e.cm !== p.key && e.cm !== 'all')) return false;
			if (e.status === 'active') return e.level === 3 || (p.level === 2 && e.scope === p.scope);
			return e.level === p.level && e.scope === p.scope && cooling(e, cell) > 0;
		});
	}

	// ── The rules ──────────────────────────────────────────────

	// The leading down tag with a sentence, if it holds NOTE_SHARE of the cell's down-rates.
	function leading(c) {
		var best = null;
		if (!(c.neg > 0)) return null;
		Object.keys(c.tags || {}).forEach(function (t) {
			if (!has(LINES, t)) return;
			var k = c.tags[t];
			if (!best || k > best.k || (k === best.k && t < best.tag)) best = { tag: t, k: k };
		});
		return best && best.k * 10 >= c.neg * 3 ? best : null;
	}

	function make(kind, level, scope, name, key, tag, to) {
		return { kind: kind, level: level, scope: scope, name: name || '', key: key, tag: tag || '', to: to || '',
			id: [kind, level, scope, key, tag || '', to || ''].join('|') };
	}

	function brief(c, level) {
		return { cm: c.key, n: c.n, theta: c.theta, lo: c.lo, hi: c.hi, level: level };
	}

	/// What the page may propose, deterministically, from the cells (`DaimondRatingRoll.cells`),
	/// the notes the person's files hold and `ctx`: `{ diamonds: [{ d, name, cm }], t }`, the
	/// Diamonds the page lists with their current model, and the page's `t` for the sentences.
	/// Each proposal is `{ kind: 'switch' | 'note' | 'review', level, scope, name, key (the model),
	/// tag, to (a switch's target), id, evidence, line, lineKey, at }`. `at` is what Add, Dismiss or
	/// Keep records (`{ t, n }`: the tag's count and the cell's rated count now); `line` is the
	/// sentence, '' for a switch and the note's own words for a review. A switch needs a Diamond
	/// (P6); a note at a Diamond is for that Diamond's current model only; every proposal reads
	/// only a trusted cell with a good or bad claim (J5).
	function proposals(roll, notes, ctx) {
		var R = rr(), out = [];
		if (!R || !roll || typeof roll !== 'object') return out;
		var list = entries(notes), tr = ctx && ctx.t, dias = {};
		((ctx && Array.isArray(ctx.diamonds)) ? ctx.diamonds : []).forEach(function (d) {
			if (d && typeof d.d === 'string' && d.d && typeof d.cm === 'string' && d.cm) dias[d.d] = { cm: d.cm, name: str(d.name) };
		});
		var dids = Object.keys(dias).sort();
		function nameOf(level, scope) { return level === 2 && dias[scope] ? dias[scope].name : ''; }

		// Notes.
		function note(c, level, scope) {
			if (!trusted(c)) return;
			var top = leading(c);
			if (!top) return;
			var p = make('note', level, scope, nameOf(level, scope), c.key, top.tag);
			if (held(list, p, c)) return;
			p.line = lineFor(top.tag, tr); p.lineKey = LINES[top.tag].key;
			p.evidence = { n: c.n, down: c.neg, tagged: top.k };
			p.at = { t: top.k, n: c.n };
			out.push(p);
		}
		dids.forEach(function (d) { note(R.cell(roll, 2, d, 'cm', dias[d].cm), 2, d); });
		var l3 = (roll.L3 && roll.L3[''] && roll.L3[''].cm) || {};
		Object.keys(l3).sort().forEach(function (k) { note(l3[k], 3, ''); });

		// Switches, for a Diamond only: its own model bad; another trusted and good, in that Diamond
		// or (a model of the same family) across the account; the length bands agreeing, and no
		// length finding explaining the gap.
		dids.forEach(function (d) {
			var cm = dias[d].cm, cur = R.cell(roll, 2, d, 'cm', cm);
			if (!trusted(cur) || cur.claim !== 'bad') return;
			var l2 = (roll.L2 && roll.L2[d] && roll.L2[d].cm) || {}, cands = [];
			Object.keys(l2).sort().forEach(function (k) { if (k !== cm) cands.push({ lv: 2, sc: d, c: l2[k] }); });
			Object.keys(l3).sort().forEach(function (k) { if (k !== cm && !l2[k] && cur.fam && l3[k].fam === cur.fam) cands.push({ lv: 3, sc: '', c: l3[k] }); });
			var best = null;
			cands.forEach(function (x) {
				if (!trusted(x.c) || x.c.claim !== 'good') return;
				if (list.some(function (e) { return e.status === 'dismissed' && e.tag === 'switch' && e.level === 2 && e.scope === d && e.cm === cm && e.to === x.c.key && cooling(e, cur) > 0; })) return;
				var cmp = R.compare(roll, x.lv, x.sc, cm, x.c.key);
				if (!cmp.report || cmp.dir !== 'b' || R.lengthFinding(roll, x.lv, x.sc).found) return;
				if (!best || x.c.theta > best.c.theta || (x.c.theta === best.c.theta && x.c.key < best.c.key)) best = x;
			});
			if (!best) return;
			var p = make('switch', 2, d, dias[d].name, cm, '', best.c.key);
			p.line = ''; p.lineKey = '';
			p.evidence = { from: brief(cur, 2), to: brief(best.c, best.lv), cmp: 'b' };
			p.at = { t: 0, n: cur.n };
			out.push(p);
		});

		// Reviews: an active note for one model, 20 rated products after it began (or after the last Keep).
		list.forEach(function (e) {
			if (e.status !== 'active' || e.cm === 'all') return;
			var c = R.cell(roll, e.level, e.scope, 'cm', e.cm);
			if (!trusted(c) || c.n - Math.max(e.at.n, e.kept) < NEW_MIN) return;
			var tag = nat(c.tags && c.tags[e.tag]);
			var p = make('review', e.level, e.scope, nameOf(e.level, e.scope), e.cm, e.tag);
			p.line = e.line; p.lineKey = '';
			p.evidence = { note: e.id, before: { t: e.at.t, n: e.at.n }, after: { t: Math.max(0, tag - e.at.t), n: c.n - e.at.n } };
			p.at = { t: tag, n: c.n };
			out.push(p);
		});

		// Switch reviews (P5), for a Diamond only: a Switch pressed on a tile is on file as a `switched` entry,
		// and 20 new rated answers on the model it went to ask Keep or Switch back. A press of either
		// retires the entry, which is what stops the tile coming back (here or on another device). The
		// newest switch of a Diamond decides: an older one, or one a press has closed, asks nothing. This is a
		// count and not a claim: the person is asked how it went, whatever the figures say.
		var latest = {};
		list.forEach(function (e) {
			if (e.level !== 2 || e.tag !== 'switch' || (e.status !== 'switched' && e.status !== 'retired')) return;
			if (!has(latest, e.scope) || e.id > latest[e.scope].id) latest[e.scope] = e;
		});
		Object.keys(latest).sort().forEach(function (d) {
			var e = latest[d];
			if (e.status !== 'switched' || !dias[d] || dias[d].cm !== e.to) return;
			var c = R.cell(roll, 2, d, 'cm', e.to);
			if (!c || c.n - e.at.n < NEW_MIN) return;
			var p = make('back', 2, d, dias[d].name, e.to, '', e.cm);
			p.id += '|' + e.id;
			p.line = ''; p.lineKey = '';
			p.evidence = { note: e.id, n: c.n, up: nat(c.pos), down: nat(c.neg) };
			p.at = { t: 0, n: c.n };
			if (e.was) p.was = e.was;			// the model left, provider included, for the press that restores it
			out.push(p);
		});

		out.sort(function (a, b) { return RANK[a.kind] - RANK[b.kind] || (a.id < b.id ? -1 : (a.id > b.id ? 1 : 0)); });
		return out;
	}

	// ── The list ───────────────────────────────────────────────

	/// When a note was added, in milliseconds, read from its own id (`n-<time in base 36>-<five letters>`),
	/// or 0 for an id that does not say. A date to show a person; no rule reads it as an age (J3).
	function addedMs(id) {
		var m = /^n-([0-9a-z]{6,10})-[0-9a-z]{5}$/.exec(str(id));
		var v = m ? parseInt(m[1], 36) : 0;
		return Number.isSafeInteger(v) && v > 0 && v < 8.64e15 ? v : 0;
	}

	/// The active notes for the Steering list, grouped: the account's first, then each Diamond's by
	/// name. `ctx` is `{ diamonds: [{ d, name, cm }], diamond, refuse }`; with `diamond` set the list
	/// holds that Diamond's notes and the account's, and no other Diamond's. A group's notes go by id,
	/// which is the order they were made in. A retired, dismissed or switched entry, and a blank line,
	/// are not notes a turn is told. A Diamond the page does not list keeps its notes under an empty name.
	///
	/// A note the selection would not tell a model carries `off`, why: `model` (the Diamond runs another
	/// model), `diamond` (the Diamond's own note on the topic comes first), `taken` (another note on the
	/// topic comes first: one for the model before one for all, else the earlier) or `refused` (the
	/// engine's lint, `ctx.refuse`). It is `select`'s own answer for the turns the note could be told
	/// in: in one Diamond's view that Diamond's; on the account's list a Diamond's note in its Diamond,
	/// and an account note in any Diamond or an ordinary chat. `cm` is the model the Diamond runs, as the
	/// notes name it; with none given, nothing is said of that Diamond's notes. The engine's own cap
	/// (five notes, 600 bytes) is not applied here.
	function listing(notes, ctx) {
		var names = {}, cms = {}, only = ctx && typeof ctx.diamond === 'string' ? ctx.diamond : '', by = {};
		var refuse = ctx && typeof ctx.refuse === 'function' ? ctx.refuse : null, all = entries(notes);
		((ctx && Array.isArray(ctx.diamonds)) ? ctx.diamonds : []).forEach(function (d) {
			if (!d || typeof d.d !== 'string' || !d.d) return;
			names[d.d] = str(d.name);
			if (typeof d.cm === 'string') cms[d.d] = d.cm;
		});
		// The [model, Diamond] turns a note could be told in, or null where the page does not say.
		function turns(e) {
			if (only) return has(cms, only) ? [[cms[only], only]] : null;
			if (e.level === 2) return has(cms, e.scope) ? [[cms[e.scope], e.scope]] : null;
			var out = [[e.cm === 'all' ? '' : e.cm, '']];		// an ordinary chat on the note's own model
			Object.keys(cms).sort().forEach(function (d) { out.push([cms[d], d]); });
			return out;
		}
		function picks(e, t) {
			return select(all, t[0], t[1], { refuse: refuse }).some(function (x) { return x.id === e.id && x.level === e.level && x.scope === e.scope; });
		}
		function off(e) {
			var ts = turns(e);
			if (!ts || ts.some(function (t) { return picks(e, t); })) return '';
			if (refuse && refuse(e.line)) return 'refused';
			var t = ts[0];
			if (e.cm !== 'all' && e.cm !== t[0]) return 'model';
			var w = select(all, t[0], t[1], { refuse: refuse }).filter(function (x) { return x.tag === e.tag; })[0];
			return w && w.level === 2 && e.level === 3 ? 'diamond' : 'taken';
		}
		all.forEach(function (e) {
			if (e.status !== 'active' || e.line.trim() === '') return;
			if (only && e.level === 2 && e.scope !== only) return;
			var k = e.level === 3 ? '' : e.scope;
			var g = has(by, k) ? by[k] : (by[k] = { level: e.level, scope: e.scope, name: e.level === 2 && has(names, e.scope) ? names[e.scope] : '', notes: [] });
			var n = { id: e.id, level: e.level, scope: e.scope, cm: e.cm, tag: e.tag, line: e.line, added: addedMs(e.id) }, why = off(e);
			if (why) n.off = why;
			g.notes.push(n);
		});
		function lower(x) { return x.toLowerCase(); }
		return Object.keys(by).map(function (k) { return by[k]; }).sort(function (a, b) {
			return (b.level - a.level) || (lower(a.name) < lower(b.name) ? -1 : (lower(a.name) > lower(b.name) ? 1 : 0))
				|| (a.scope < b.scope ? -1 : (a.scope > b.scope ? 1 : 0));
		}).map(function (g) {
			g.notes.sort(function (a, b) { return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0); });
			return g;
		});
	}

	/// What to record when a note is removed (`retire`): the tag's count and the rated count of the note's
	/// cell now, so that the same note is not proposed again until 20 more rated answers (P7). A bare
	/// zero would let a removed note come straight back. A note for every model counts from the busiest
	/// model at its level. A cell that is not there has no count.
	function retireAt(roll, e) {
		var R = rr(), out = { t: 0, n: 0 };
		if (!R || !roll || !e || typeof e !== 'object') return out;
		var tag = str(e.tag), lv = e.level === 2 ? roll.L2 && roll.L2[str(e.scope)] : roll.L3 && roll.L3[''];
		var cells = lv && lv.cm && typeof lv.cm === 'object' ? lv.cm : {};
		(e.cm === 'all' ? Object.keys(cells) : [str(e.cm)]).forEach(function (k) {
			var c = has(cells, k) ? cells[k] : null;
			if (!c) return;
			out.n = Math.max(out.n, nat(c.n));
			out.t = Math.max(out.t, nat(c.tags && c.tags[tag]));
		});
		return out;
	}

	// ── The note file ──────────────────────────────────────────
	//
	// One file per Diamond, inside the Diamond's own store (`.daimond/`), so it travels in the
	// Diamond's export from every device and is fenced from every tool a daimon holds (the engine
	// refuses a write inside `.daimond/`). The Optimiser's file also holds the account's notes
	// (level 3). An entry is a header line and one line of the note's own words:
	//
	//   ## <id> · <status> · diamond|account · <cm|all> · <tag> <t> of <n>[ · kept <k>][ · to <model>][ · was <provider>/<model>]
	//   Keep answers under about 200 words unless asked for detail.
	//
	// A file is held as its lines, an entry being a header and the line after it, so that writing
	// one entry changes only its own bytes and a line that cannot be read is kept as written.

	var FILE = '.daimond/steering.md';
	var SEP  = ' \xb7 ';
	var WORD_LEVEL = { diamond: 2, account: 3 };
	var LEVEL_WORD = { 2: 'diamond', 3: 'account' };

	// One token of a header: no space, control character or middle dot, so the header splits back exactly.
	function word(x) { return typeof x === 'string' && x !== '' && !/[\x00-\x20\x7f\xa0\xb7\u2028\u2029]/.test(x); }
	function count(x) { return typeof x === 'string' && /^(0|[1-9][0-9]*)$/.test(x) && Number.isSafeInteger(Number(x)) ? Number(x) : -1; }
	function whole(x) { return typeof x === 'number' && Number.isSafeInteger(x) && x >= 0; }

	function headOf(e) {
		var parts = [e.id, e.status, LEVEL_WORD[e.level], e.cm, e.tag + ' ' + e.at.t + ' of ' + e.at.n];
		if (e.kept > 0) parts.push('kept ' + e.kept);
		if (e.to) parts.push('to ' + e.to);
		var w = wasToken(e.was);
		if (w) parts.push('was ' + w);
		return '## ' + parts.join(SEP);
	}

	// The model a Diamond left as one header token, `<provider>/<model>`, each part escaped as a URL
	// component (a slash or a colon in a model id is kept as it is, for the eye), or '' where there is
	// none or it cannot be written. A provider id holds no slash, so the first slash divides the two.
	function wasToken(w) {
		if (!w || typeof w !== 'object' || typeof w.provider !== 'string' || typeof w.model !== 'string' || w.model === '') return '';
		try {
			var tk = encodeURIComponent(w.provider) + '/' + encodeURIComponent(w.model).replace(/%2F/gi, '/').replace(/%3A/gi, ':');
			return word(tk) ? tk : '';
		} catch (x) { return ''; }		// a lone surrogate cannot be escaped
	}
	function wasFrom(tk) {
		var i = tk.indexOf('/');
		if (i < 0) return null;
		try {
			var w = { provider: decodeURIComponent(tk.slice(0, i)), model: decodeURIComponent(tk.slice(i + 1)) };
			return w.model !== '' && wasToken(w) === tk ? w : null;		// only what this writer would have written
		} catch (x) { return null; }
	}

	// The header's fields, or null where the line is not a header this writer would have made.
	function readHead(l) {
		if (l.slice(0, 3) !== '## ') return null;
		var p = l.slice(3).split(SEP);
		if (p.length < 5 || p.length > 8) return null;
		var level = has(WORD_LEVEL, p[2]) ? WORD_LEVEL[p[2]] : 0;
		var m = /^(\S+) ([0-9]+) of ([0-9]+)$/.exec(p[4]);
		if (!word(p[0]) || !(p[1] === 'active' || p[1] === 'retired' || p[1] === 'dismissed' || p[1] === 'switched') || !level || !word(p[3]) || !m || !word(m[1])) return null;
		var t = count(m[2]), n = count(m[3]), kept = 0, to = '', was = null, i = 5;
		if (t < 0 || n < 0) return null;
		if (i < p.length && p[i].slice(0, 5) === 'kept ') {
			kept = count(p[i].slice(5));
			if (kept < 1) return null;
			i++;
		}
		if (i < p.length && p[i].slice(0, 3) === 'to ') {
			to = p[i].slice(3);
			if (!word(to)) return null;
			i++;
		}
		if (i < p.length && p[i].slice(0, 4) === 'was ') {
			was = wasFrom(p[i].slice(4));
			if (!was) return null;
			i++;
		}
		if (i !== p.length) return null;
		return { id: p[0], status: p[1], cm: p[3], tag: m[1], level: level, at: { t: t, n: n }, kept: kept, to: to, was: was };
	}

	// Status only moves forward, so a note taken off on one side stays off: closed (retired or dismissed) over
	// switched over active. Dismissed and retired share a rank, an id never being both.
	var STATUS_RANK = { active: 0, switched: 1, dismissed: 2, retired: 2 };
	function head2(e) { return headOf(e) + '\n' + e.line; }
	function later(a, b) { return a.t !== b.t ? a.t - b.t : a.n - b.n; }

	// The two readings of one note, as one: the further status stands, with the figures it was closed at (the later,
	// where both are closed), and `kept` is the larger, a mark the cell reached never being taken back. The same
	// whichever is given first, so devices that meet in any order agree.
	function joinEntry(x, y) {
		var rx = STATUS_RANK[x.status], ry = STATUS_RANK[y.status], w;
		if (rx !== ry) w = rx > ry ? x : y;
		else {
			var d = later(x.at, y.at);
			w = d !== 0 ? (d > 0 ? x : y) : (head2(x) >= head2(y) ? x : y);
		}
		return Object.assign({}, w, { kept: Math.max(x.kept, y.kept) });
	}

	// A line without the carriage return a Windows editor leaves, for reading. The stored lines keep it, so that
	// a file comes back as it was found.
	function bare(l) { return l.charAt(l.length - 1) === '\r' ? l.slice(0, -1) : l; }

	/// Read a note file. `owner` is the Diamond whose file it is (a level 2 entry's scope), and
	/// `account` says whether this is the Optimiser's file, the only one an account entry may
	/// stand in. Returns `{ doc, entries, ignored }`: `doc` is what `put` and `serialise` take,
	/// `entries` the notes in the shape `proposals` reads, `ignored` each line it could not read
	/// as `{ at (line number), text }`. Nothing is rewritten that could not be read.
	///
	/// A header is never a note's words: where the line after one is itself a header, or there is
	/// none, the entry has an empty body and the next header stands as its own entry. A line ending
	/// in a carriage return reads without it. An id held twice is one entry, the furthest status.
	function parse(text, owner, account) {
		var lines = (typeof text === 'string' ? text : '').split('\n'), nl = false;
		if (lines.length && lines[lines.length - 1] === '') { lines.pop(); nl = true; }
		var cr = (lines.length && (nl || lines.length > 1) && lines[0].charAt(lines[0].length - 1) === '\r') ? '\r' : '';
		var items = [], entries = [], ignored = [], i = 0, at = {};
		while (i < lines.length) {
			var h = readHead(bare(lines[i]));
			if (h) {
				var bodied = i + 1 < lines.length && !readHead(bare(lines[i + 1])), body = bodied ? bare(lines[i + 1]) : '';
				var span = bodied ? [lines[i], lines[i + 1]] : [lines[i]];
				if (h.level === 3 && !account) {
					ignored.push({ at: i + 1, text: bare(lines[i]) });
					items.push({ e: null, lines: span });
				} else {
					var e = { id: h.id, status: h.status, cm: h.cm, tag: h.tag, level: h.level, scope: h.level === 2 ? str(owner) : '',
						at: h.at, kept: h.kept, line: body, to: h.to };
					if (h.was) e.was = h.was;
					items.push({ e: e, lines: span });
					if (has(at, e.id)) entries[at[e.id]] = joinEntry(entries[at[e.id]], e);
					else { at[e.id] = entries.length; entries.push(e); }
				}
				i += span.length;
				continue;
			}
			if (bare(lines[i]).trim() !== '') ignored.push({ at: i + 1, text: bare(lines[i]) });
			items.push({ e: null, lines: [lines[i]] });
			i++;
		}
		return { doc: { items: items, nl: nl, cr: cr }, entries: entries, ignored: ignored };
	}

	/// The bytes of a parsed file, as read where nothing was changed.
	function serialise(doc) {
		var lines = [];
		((doc && doc.items) || []).forEach(function (it) { lines.push.apply(lines, it.lines); });
		return lines.join('\n') + ((doc && doc.nl && lines.length) ? '\n' : '');
	}

	/// A file with `e` written into it: the entry of the same id replaced where it stands (a second copy
	/// of the id is dropped), else appended after a blank line. Every other line is as it was. The file
	/// now ends in a newline, and what is written ends its lines as the file's own did.
	function put(doc, e) {
		var cr = (doc && doc.cr) || '', made = { e: e, lines: [headOf(e) + cr, e.line + cr] }, items = [], placed = false;
		((doc && doc.items) || []).forEach(function (it) {
			if (it.e && it.e.id === e.id) {
				if (!placed) { items.push(made); placed = true; }
				return;
			}
			items.push(it);
		});
		if (!placed) {
			var last = items.length ? items[items.length - 1].lines : null;
			if (last && bare(last[last.length - 1]) !== '') items.push({ e: null, lines: [cr] });
			items.push(made);
		}
		return { items: items, nl: true, cr: cr };
	}

	/// The file a two-sided sync leaves. `here` is the copy now in force (the arriving one, which an
	/// import laid over this device's) and `there` the copy it replaced. Entries are joined by id, so a
	/// note added on either side stays, a note taken off on either side stays off, and the larger `kept`
	/// stands. The text is `here` with only what it lacks added to it, a line neither can read being
	/// carried as written; the result is null where `here` already holds all of `there`. Joined in
	/// either order the entries are the same, which is what lets two devices that meet each way agree.
	function join(here, there, owner, account) {
		var a = parse(here, owner, account), b = parse(there, owner, account), doc = a.doc, got = {}, changed = false, have = {};
		a.entries.forEach(function (e) { got[e.id] = e; });
		b.entries.forEach(function (e) {
			var w = has(got, e.id) ? got[e.id] : null, j = w ? joinEntry(w, e) : e;
			if (w && head2(j) === head2(w)) return;
			doc = put(doc, j);
			got[e.id] = j;
			changed = true;
		});
		function key(it) { return it.lines.map(bare).join('\n'); }
		doc.items.forEach(function (it) { if (!it.e) have[key(it)] = true; });
		b.doc.items.forEach(function (it) {
			if (it.e || key(it).trim() === '' || has(have, key(it))) return;
			var cr = doc.cr || '', last = doc.items.length ? doc.items[doc.items.length - 1].lines : null;
			if (last && bare(last[last.length - 1]) !== '') doc.items.push({ e: null, lines: [cr] });
			doc.items.push({ e: null, lines: it.lines.map(function (l) { return bare(l) + cr; }) });
			have[key(it)] = true;
			changed = true;
		});
		if (!changed) return null;
		doc.nl = true;
		return serialise(doc);
	}

	/// Why a note cannot be written, or '' where the file can hold it faithfully. `opts.refuse`
	/// is the engine's lint (`steering_refusal`) and `opts.isFamily(cm)` says a model id is a family:
	/// a note is for one model or for all, never a family (design decision 5 (a)).
	function check(e, opts) {
		opts = opts || {};
		if (!e || typeof e !== 'object') return 'entry';
		if (!word(e.id)) return 'id';
		if (!(e.status === 'active' || e.status === 'retired' || e.status === 'dismissed' || e.status === 'switched')) return 'status';
		if (e.level !== 2 && e.level !== 3) return 'level';
		if (e.level === 2 ? !word(e.scope) : e.scope !== '') return 'scope';
		if (!word(e.cm)) return 'cm';
		if (e.cm !== 'all' && typeof opts.isFamily === 'function' && opts.isFamily(e.cm)) return 'family';
		if (!word(e.tag)) return 'tag';
		if (typeof e.line !== 'string' || /[\x00-\x1f\x7f\u2028\u2029]/.test(e.line)) return 'line';
		if (e.status === 'active') {
			if (e.line.trim() === '') return 'line';
			if (typeof opts.refuse === 'function' && opts.refuse(e.line)) return str(opts.refuse(e.line)) || 'line';
		}
		if (e.to !== '' && !word(e.to)) return 'to';
		if (e.status === 'switched' && (e.level !== 2 || e.to === '')) return 'to';	// a Diamond's switch, and where it went
		if (e.was !== undefined && e.was !== null && wasToken(e.was) === '') return 'was';		// the model left: a provider and a model id
		if (!e.at || !whole(e.at.t) || !whole(e.at.n)) return 'at';
		if (!whole(e.kept)) return 'kept';
		return '';
	}

	// ── Selection ──────────────────────────────────────────────

	// 0 this Diamond's note for the model, 1 this Diamond's for all, 2 the account's for the model, 3 the account's for all.
	function rank(e) { return (e.level === 2 ? 0 : 2) + (e.cm === 'all' ? 1 : 0); }
	function cmp(a, b) {
		return rank(a) - rank(b) || (a.id < b.id ? -1 : (a.id > b.id ? 1 : 0)) || (a.line < b.line ? -1 : (a.line > b.line ? 1 : 0))
			|| (a.status < b.status ? -1 : (a.status > b.status ? 1 : 0));
	}

	/// The notes one turn is told, most specific first: the active notes for `model` or for all, of
	/// the Diamond `diamondId` ('' for an ordinary chat) and of the account. A Diamond's note
	/// displaces an account note of the same tag, and a note for the model displaces one for all.
	/// The order depends on the notes and not on the order they arrived in (rank, then id). The
	/// engine's own cap (five notes, 600 bytes) drops from the end. `opts.refuse` is the engine's lint.
	function select(list, model, diamondId, opts) {
		var refuse = opts && typeof opts.refuse === 'function' ? opts.refuse : null, m = str(model), d = str(diamondId), seen = {};
		return entries(list).filter(function (e) {
			if (e.status !== 'active' || e.line.trim() === '') return false;
			if (e.cm !== m && e.cm !== 'all') return false;
			if (!(e.level === 3 || (e.level === 2 && d !== '' && e.scope === d))) return false;
			return !(refuse && refuse(e.line));
		}).sort(cmp).filter(function (e) {
			if (has(seen, e.tag)) return false;
			seen[e.tag] = true;
			return true;
		});
	}

	/// The notes as the engine takes them: one per line.
	function text(sel) {
		return (Array.isArray(sel) ? sel : []).map(function (e) { return e.line; }).join('\n');
	}

	window.DaimondSteering = {
		NOTE_SHARE: NOTE_SHARE, NEW_MIN: NEW_MIN, LINES: LINES, TAGS: TAGS, FILE: FILE,
		lineFor: lineFor, cooling: cooling, proposals: proposals,
		parse: parse, serialise: serialise, put: put, join: join, check: check, select: select, text: text,
		listing: listing, addedMs: addedMs, retireAt: retireAt,
	};
})();
