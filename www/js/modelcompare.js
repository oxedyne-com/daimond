/* ============================================================
   Daimond -- the model Compare roll-up, the pure half (DaimondModelCompare)
   ------------------------------------------------------------
   One row per exact model id, a task kind, a window: what each model costs
   per accepted answer, how fast it starts and ends a turn, how often it
   stalls or fails a tool, and how its answers are judged. Every figure
   carries its count and a 90% band, or says how many more it needs.

   Plan: ~/usr/code/ai/claude/specs/daimond_model_compare_plan_20261009.md
   §1 (task kind), §2.4 (columns), §3 (accepted answer), §4 (confidence),
   §6.2 (the snapshot); unit MC2. Owner rulings 2026-10-09: the card shows
   count bands (10+, 30+, 100+, 300+), never exact counts.

   TASK KIND IS DERIVED HERE, AT READ TIME, never stamped: `prod` holds only
   what is known when a turn starts and a message is first-copy-wins, so a
   kind written after the tools ran would never reach a device that holds
   the message already. The same transcript gives the same kind everywhere.

   NO TEXT LEAVES THE WALK. `turns` reads a message's words (for a re-ask), a
   tool's path (for a revert, an extension) and drops them: a turn keeps the
   kind, a verdict and the handles the part already held. `snapshot` is built
   field by field from a whitelist, so nothing a person typed can reach it.

   Two facts are not in the transcript and come from the caller (C8): a
   History restore is recorded only as a `restore` version in the store, so
   `grid` takes `opts.reverted`, the file-product handles a restore put back
   over; and a retried answer is tombstoned whole, so it is no turn at all:
   what is left of it is its ledger spend, marked `tr` by `retryTurn` with the
   turn that replaced it (Q27), and `grid` counts that as a rejected answer.

   Pure: no DOM, no storage, no clock (a window's ends are passed in).
   Attaches `window.DaimondModelCompare`; reads `window.DaimondRatingRoll`,
   `window.DaimondRatings`, `window.DaimondProvenance` and, for spend not
   tied to an answer, `window.DaimondPricing` when it runs.
   ============================================================ */
(function () {
	'use strict';

	var KIND_V     = 1;						// the kind rules' version, printed on the card
	var KINDS      = ['mail', 'image', 'code', 'writing', 'research', 'talk'];
	var FORM_MIN   = 'daimond/1.1';			// the first form with the honesty tags
	var Z90        = 1.6448536269514722;	// two-sided 90%
	var K          = 5;						// the prior's weight, as U5a
	var RATE_FLOOR = 10;					// turns (calls for tool errors) a rate needs
	var COST_MIN_A = 3;						// accepted answers the cost ratio needs
	var Q_FLOOR    = { 50: 10, 90: 30 };	// recorded turns a P50 and a P90 need
	var DOM_SHARE  = 6;						// a Diamond's dominant kind holds >= 6/10 ...
	var DOM_MIN    = 5;						// ... and at least this many of its classified turns
	var REASK_WORDS = 4;
	var REASK_J    = 0.6;

	var CODE_EXT = ['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rs', 'go', 'java', 'c', 'h', 'cc', 'cpp', 'hpp',
		'cs', 'rb', 'php', 'swift', 'kt', 'kts', 'scala', 'sh', 'bash', 'zsh', 'ps1', 'sql', 'html', 'htm', 'css',
		'scss', 'sass', 'less', 'vue', 'svelte', 'lua', 'pl', 'r', 'jl', 'dart', 'zig', 'nim', 'ex', 'exs', 'erl',
		'hs', 'ml', 'fs', 'clj', 'json', 'yaml', 'yml', 'toml', 'xml', 'ini', 'cfg', 'mk', 'cmake', 'gradle', 'wat'];
	var PROSE_EXT = ['md', 'typ', 'txt', 'tex', 'rst', 'org', 'docx', 'odt'];
	var WRITE_TOOLS = { file_write: 1, file_edit: 1, edits: 1 };
	var RUN_TOOLS   = { shell: 1, command: 1, run_net: 1 };

	// Column ids; `low` ones are better lower, and are inverted when ranked.
	var COLUMNS = ['cost', 'first', 'end', 'stall', 'toolerr', 'quality', 'following', 'honesty', 'selfverify'];
	var LOW     = { cost: 1, first: 1, end: 1, stall: 1, toolerr: 1 };
	var PRESETS = {
		cheapest: { cost: 3, quality: 2, following: 1 },
		fastest:  { first: 2, end: 3, stall: 1 },
		best:     { quality: 3, following: 2, honesty: 2, selfverify: 1 },
		balanced: { cost: 1, first: 1, end: 1, stall: 1, toolerr: 1, quality: 1, following: 1, honesty: 1, selfverify: 1 },
	};

	function str(x) { return typeof x === 'string' ? x : ''; }
	function num(x) { return typeof x === 'number' && isFinite(x) ? x : null; }
	function roll() { return (typeof window !== 'undefined') ? window.DaimondRatingRoll : null; }
	function ratings() { return (typeof window !== 'undefined') ? window.DaimondRatings : null; }
	function prov() { return (typeof window !== 'undefined') ? window.DaimondProvenance : null; }
	function pricing() { return (typeof window !== 'undefined') ? window.DaimondPricing : null; }
	function cmp(a, b) { return a < b ? -1 : (a > b ? 1 : 0); }

	// ── Extensions, words (C6) ─────────────────────────────────

	/// The lower-cased extension of a file-row handle (`p1:file:<store>/v<N>/<path>`) or of a
	/// path, '' where it has none. Only the extension is returned; nothing else is kept.
	function extOf(s) {
		var t = str(s), base = t.slice(t.lastIndexOf('/') + 1), dot = base.lastIndexOf('.');
		if (dot <= 0 || dot === base.length - 1) return '';
		var e = base.slice(dot + 1).toLowerCase();
		return /^[a-z0-9]{1,8}$/.test(e) ? e : '';
	}

	function extKind(e) {
		if (!e) return '';
		if (CODE_EXT.indexOf(e) >= 0) return 'code';
		return PROSE_EXT.indexOf(e) >= 0 ? 'writing' : '';
	}

	// The path inside the store, the same whether it came from a handle or a tool's arguments.
	function pathKey(p) {
		return str(p).replace(/^\/+/, '').replace(/^(chats\/[^/]+\/work|diamonds\/[^/]+)\//, '');
	}

	function handlePath(h) {
		var m = /^p1:file:[^/]*\/v\d+\/(.*)$/.exec(str(h));
		return m ? m[1] : '';
	}

	function wordSet(text) {
		var set = {}, n = 0;
		str(text).toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, ' ').split(/\s+/).forEach(function (w) {
			if (w && !set[w]) { set[w] = 1; n++; }
		});
		return { set: set, n: n };
	}

	/// Is `next` a re-ask of `asked`: four words or more, and a Jaccard similarity of their
	/// word sets of at least 0.6 (lower-cased, punctuation stripped)?
	function isReask(asked, next) {
		var a = wordSet(asked), b = wordSet(next);
		if (b.n < REASK_WORDS || !a.n) return false;
		var both = 0;
		Object.keys(b.set).forEach(function (w) { if (a.set[w]) both++; });
		return both / (a.n + b.n - both) >= REASK_J;
	}

	// ── Task kind (§1) ─────────────────────────────────────────

	/// The kind of one turn from its facts: `tools` (names that ran), `written` and `read` (the
	/// extensions of the files it wrote and read, one per file), `image` (the person's message
	/// carried an image) and `mail` (it made a mail product). The first rule that matches; 'other'
	/// where none does (the Diamond fallback is the grid's, which sees every turn).
	function turnKind(f) {
		f = f || {};
		var tools = Array.isArray(f.tools) ? f.tools : [], written = Array.isArray(f.written) ? f.written : [];
		var read = Array.isArray(f.read) ? f.read : [];
		var ran = function (pred) { return tools.some(function (n) { return pred(str(n)); }); };
		if (f.mail || ran(function (n) { return n.indexOf('mail_') === 0; })) return 'mail';
		if (f.image) return 'image';
		var code = 0, prose = 0;
		written.forEach(function (e) { var k = extKind(e); if (k === 'code') code++; else if (k === 'writing') prose++; });
		if (code && prose) return code >= prose ? 'code' : 'writing';	// mixed writes: the majority, a tie is code
		if (code || ran(function (n) { return !!RUN_TOOLS[n]; })) return 'code';
		if (prose || ran(function (n) { return n === 'typst_compile'; })) return 'writing';
		if (!written.length && read.length) {
			var kinds = read.map(extKind);
			if (kinds.every(function (k) { return k === 'code'; })) return 'code';
			if (kinds.every(function (k) { return k === 'writing'; })) return 'writing';
		}
		if (!written.length && ran(function (n) { return n.indexOf('web_') === 0; })) return 'research';
		if (!tools.length && !written.length) return 'talk';
		return 'other';
	}

	// ── The turns of one chat ──────────────────────────────────

	function argsOf(a) {
		if (a && typeof a === 'object') return a;
		try { var o = JSON.parse(str(a) || '{}'); return o && typeof o === 'object' ? o : {}; } catch (e) { return {}; }
	}

	function argPaths(o) {
		var out = [];
		if (typeof o.path === 'string') out.push(o.path);
		['edits', 'files'].forEach(function (k) {
			if (Array.isArray(o[k])) o[k].forEach(function (x) { if (x && typeof x.path === 'string') out.push(x.path); });
		});
		return out;
	}

	function hasImage(m) {
		if (Array.isArray(m.images) && m.images.length) return true;
		return Array.isArray(m.content) && m.content.some(function (p) {
			return p && (p.type === 'image_url' || p.type === 'image');
		});
	}

	function formAtLeast(f) {
		var m = /^daimond\/(\d+)(?:\.(\d+))?$/.exec(str(f));
		return !!m && (Number(m[1]) > 1 || (Number(m[1]) === 1 && Number(m[2] || 0) >= 1));
	}

	/// The turns one chat holds, for `chatPart`: one per answered turn and one per worker report,
	/// each `{ tid, c, d, role, cm, fam, pv, kind, accepted, up, at, hs, nf }`. `accepted` is the
	/// transcript's verdict (§3 rules 1-4, an up-rating accepting outright, `up`); the ledger's
	/// outcome and a History restore are the grid's. `hs` are the turn's product handles, `nf` those
	/// whose head rating was made on form 1.1 or later. `idx` is `DaimondRatings.index` of the list,
	/// when the caller has it.
	function turns(msgs, idx) {
		var list = Array.isArray(msgs) ? msgs : [], R = ratings(), P = prov();
		var heads = idx || (R ? R.index(list) : new Map());
		var segs = {}, order = [], cur = null, answers = {}, workers = [], files = {}, mails = {};
		var reverts = [];
		function seg(mid) {
			var s = segs[mid];
			if (!s) { s = segs[mid] = { mid: mid, text: '', image: false, tools: [], written: {}, read: [], next: null }; order.push(s); }
			return s;
		}
		list.forEach(function (m) {
			if (!m || typeof m !== 'object') return;
			if (m.role === 'user' && m.mid) {
				var s = seg(String(m.mid));
				s.text = typeof m.content === 'string' ? m.content : '';
				s.image = hasImage(m);
				if (cur && !cur.next) cur.next = s;
				cur = s;
				return;
			}
			if (m.role === 'tool_log') {
				var name = str(m.name), args = argsOf(m.args);
				if (name === 'file_revert') { argPaths(args).forEach(function (p) { reverts.push({ at: cur, p: pathKey(p) }); }); }
				if (!cur) return;
				cur.tools.push(name);
				if (WRITE_TOOLS[name]) argPaths(args).forEach(function (p) { cur.written[pathKey(p)] = extOf(p); });
				else if (name === 'file_read') argPaths(args).forEach(function (p) { cur.read.push(extOf(p)); });
				return;
			}
			var ps = P ? P.of(m) : [];
			ps.forEach(function (p) {
				var t = p.t || (cur ? cur.mid : '');
				if (p.k === 'answer' && m.role === 'assistant') {
					var a = answers[t] || (answers[t] = { prods: [], last: null, msg: null, inSeg: cur });
					a.prods.push(p); a.last = p; a.msg = m;
				} else if (p.k === 'file') {
					(files[t] || (files[t] = [])).push(p);
				} else if (p.k === 'mail') {
					mails[t] = 1;
				} else if (p.k === 'worker') {
					workers.push(p);
				}
			});
		});
		var RR = roll(), out = [], kinds = {};
		function headOf(h) { var r = heads.get(h); return r && r.rating ? r.rating : null; }
		Object.keys(answers).sort().forEach(function (t) {
			var a = answers[t], s = segs[t] || a.inSeg, p = a.last, hs = {}, nf = [];
			var written = {};
			if (s) Object.keys(s.written).forEach(function (k) { written[k] = s.written[k]; });
			(files[t] || []).forEach(function (f) { hs[f.h] = 1; var hp = handlePath(f.h); written[pathKey(hp)] = extOf(hp); });
			a.prods.forEach(function (x) { hs[x.h] = 1; });
			var kind = turnKind({ tools: s ? s.tools : [], written: Object.keys(written).map(function (k) { return written[k]; }),
				read: s ? s.read : [], image: !!(s && s.image), mail: !!mails[t] });
			kinds[t] = kind;
			var head = headOf(p.h), up = !!head && head.s > 0, neg = !!head && head.s < 0;
			var final = RR && RR.rateable ? RR.rateable(a.msg) : true;
			var reasked = !!(s && s.next && isReask(s.text, s.next.text));
			var mine = Object.keys(written);
			var reverted = reverts.some(function (r) { return r.at && r.at !== s && order.indexOf(r.at) > order.indexOf(s) && mine.indexOf(r.p) >= 0; });
			var hl = Object.keys(hs).sort();
			hl.forEach(function (h) { var r = headOf(h); if (r && formAtLeast(r.form)) nf.push(h); });
			out.push({
				tid: t, c: str(p.c), d: str(p.d), role: str(p.role), cm: str(p.cm), fam: str(p.fam), pv: str(p.pv),
				kind: kind, accepted: up || (final && !neg && !reasked && !reverted), up: up, at: Math.floor(Number(p.at) || 0),
				hs: hl, nf: nf,
			});
		});
		workers.forEach(function (p) {
			var rid = str(p.h).replace(/^p1:worker:/, ''), head = headOf(p.h), up = !!head && head.s > 0;
			out.push({
				tid: rid, c: str(p.c), d: str(p.d), role: str(p.role), cm: str(p.cm), fam: str(p.fam), pv: str(p.pv),
				kind: kinds[p.t] || 'other', accepted: up || !(head && head.s < 0), up: up, at: Math.floor(Number(p.at) || 0),
				hs: [p.h], nf: head && formAtLeast(head.form) ? [p.h] : [],
			});
		});
		var seen = {};
		return out.filter(function (x) { var k = x.role + '\u0001' + x.tid; if (seen[k]) return false; seen[k] = 1; return true; })
			.sort(function (a, b) { return cmp(a.role, b.role) || cmp(a.tid, b.tid); });
	}

	// ── Intervals (§4.2, §4.3) ─────────────────────────────────

	function wilson(p, n) {
		var RR = roll();
		if (RR && RR.wilson) return RR.wilson(p, n);
		throw new Error('modelcompare: DaimondRatingRoll is not loaded');
	}

	function notEnough(n, floor) { return { not_enough: true, n: n, more: Math.max(1, floor - n) }; }

	/// Quantile `q` (0.5, 0.9) of `xs` with its distribution-free 90% interval: the order
	/// statistics at ranks floor(nq - z·sqrt(nq(1-q))) and ceil(nq + z·sqrt(nq(1-q))) + 1, clamped
	/// to 1..n. The figure is the nearest-rank statistic, rank ceil(nq). Below its floor (10 for
	/// P50, 30 for P90) it says how many more it needs.
	function quantile(xs, q) {
		var v = (xs || []).filter(function (x) { return num(x) !== null; }).slice().sort(function (a, b) { return a - b; });
		var n = v.length, floor = Q_FLOOR[Math.round(q * 100)] || Q_FLOOR[90];
		if (n < floor) return notEnough(n, floor);
		var nq = n * q, d = Z90 * Math.sqrt(nq * (1 - q));
		var lo = Math.min(n, Math.max(1, Math.floor(nq - d))), hi = Math.min(n, Math.max(1, Math.ceil(nq + d) + 1));
		var at = Math.min(n, Math.max(1, Math.ceil(nq - 1e-9)));
		return { value: v[at - 1], lo: v[lo - 1], hi: v[hi - 1], n: n, rlo: lo, rhi: hi };
	}

	/// A share `k` of `n` with its Wilson 90% band, or not enough below `floor`.
	function rate(k, n, floor) {
		if (n < (floor || RATE_FLOOR)) return notEnough(n, floor || RATE_FLOOR);
		var p = k / n, iv = wilson(p, n);
		return { value: p, lo: iv.lo, hi: iv.hi, n: n, k: k };
	}

	/// Cost per accepted answer from the cost of each turn and how many were accepted: c̄ / a, band
	/// [(c̄ - z·se) / a_hi, (c̄ + z·se) / a_lo], conservative by construction. Floor: 10 turns and 3
	/// accepted.
	function costRatio(costs, acc) {
		var n = costs.length;
		if (n < RATE_FLOOR || acc < COST_MIN_A) {
			var more = Math.max(RATE_FLOOR - n, COST_MIN_A - acc, 1);
			return { not_enough: true, n: n, accepted: acc, more: more };
		}
		var sum = 0, ss = 0;
		costs.forEach(function (c) { sum += c; });
		var mean = sum / n;
		costs.forEach(function (c) { ss += (c - mean) * (c - mean); });
		var se = Math.sqrt(ss / (n - 1)) / Math.sqrt(n), a = acc / n, iv = wilson(a, n);
		return {
			value: mean / a, lo: Math.max(0, (mean - Z90 * se) / iv.hi), hi: (mean + Z90 * se) / iv.lo,
			n: n, accepted: acc, mean: mean, se: se,
		};
	}

	// ── The grid (§2.4, §3, §4) ────────────────────────────────

	function setOf(x) {
		var s = {};
		if (x instanceof Set) x.forEach(function (v) { s[v] = 1; });
		else if (Array.isArray(x)) x.forEach(function (v) { s[v] = 1; });
		return s;
	}

	function identifyOf(opts) {
		if (opts && typeof opts.identify === 'function') return opts.identify;
		var P = pricing();
		if (P && typeof P.identify === 'function') return function (m) { try { return P.identify(m); } catch (e) { return { cm: str(m) }; } };
		return function (m) { return { cm: str(m) }; };
	}

	function inWindow(t, o) {
		return (o.from == null || t >= o.from) && (o.to == null || t < o.to);
	}

	// The latest entry of a turn that carries `f`, by (t, then the bytes), so the pick is total.
	function latest(es, f) {
		var best = null;
		es.forEach(function (e) {
			if (num(e[f]) === null) return;
			if (!best || e.t > best.t || (e.t === best.t && JSON.stringify(e) > JSON.stringify(best))) best = e;
		});
		return best ? best[f] : null;
	}

	/// Is this turn an accepted answer, once the ledger and the store have their say? An
	/// up-rating accepts it outright; otherwise the transcript's verdict stands unless the ledger
	/// says it failed or was stopped (§3 rules 1 and 5) or a History restore put any of its files
	/// back (`reverted`, file-product handles, rule 4).
	function accepted(turn, entries, reverted) {
		if (!turn) return false;
		if (turn.up) return true;
		if (!turn.accepted || retriedBy(entries)) return false;
		var rv = setOf(reverted);
		if ((turn.hs || []).some(function (h) { return rv[h]; })) return false;
		return !(entries || []).some(function (e) { return e && (e.out === 'failed' || e.out === 'interrupted'); })
			|| (entries || []).some(function (e) { return e && e.out === 'completed'; });
	}

	// The turn that replaced a retried one, from its ledger entries (`tr`, Q27): the greatest,
	// so two devices that each retried it read the same; '' where it was never retried.
	function retriedBy(es) {
		var by = '';
		(es || []).forEach(function (e) { var r = e ? str(e.tr) : ''; if (r > by) by = r; });
		return by;
	}

	/// The rejected answers a retry left (Q27): one turn per ledger turn id marked `tr` that no part
	/// holds, as the model of its latest entry answered it, at that entry's time, not accepted. Its
	/// chat, Diamond, role and kind are those of the turn standing at the end of its chain of
	/// retries (`byId`), its prompt being that turn's; with none, kind `other`. No text and no
	/// handle: the answer is gone, and nothing can rate it.
	function rejected(byTid, byId, ident) {
		var out = [];
		Object.keys(byTid).sort().forEach(function (tid) {
			if (byId[tid]) return;
			var es = byTid[tid], to = retriedBy(es);
			if (!to) return;
			var seen = {}, cur = to;
			seen[tid] = 1;
			while (!byId[cur] && byTid[cur] && retriedBy(byTid[cur]) && !seen[cur]) { seen[cur] = 1; cur = retriedBy(byTid[cur]); }
			var stand = byId[cur] || null, last = null;
			es.forEach(function (e) {
				if (!last || e.t > last.t || (e.t === last.t && JSON.stringify(e) > JSON.stringify(last))) last = e;
			});
			var id = ident(last.m) || {};
			out.push({
				tid: tid, c: stand ? stand.c : '', d: stand ? stand.d : '', role: stand ? stand.role : '',
				cm: str(id.cm) || str(last.m), fam: str(id.fam), pv: str(last.pv), kind: stand ? stand.kind : 'other',
				accepted: false, up: false, at: Math.floor(Number(last.t) || 0), hs: [], nf: [],
			});
		});
		return out;
	}

	function newerHead(a, b) {
		if (a.ts !== b.ts) return a.ts > b.ts;
		if (a.mid !== b.mid) return a.mid > b.mid;
		return false;
	}

	// The judged cells of one row from the heads in scope, by the §4.1 prior chain.
	function judged(RR, kindRoll, allRoll, row, split, opts, heads) {
		var kd = split ? 'pv' : 'cm', key = split ? row.pv + ':' + row.cm : row.cm, out = {};
		var c = RR.cell(kindRoll, 3, '', kd, key);
		// The prior chain: the model's all-kinds cell (in one kind), the kind's family cell, then 0.
		var all = opts.kind && opts.kind !== 'all' ? RR.cell(allRoll, 3, '', kd, key) : null;
		var fam = row.fam ? RR.cell(kindRoll, 3, '', 'fam', row.fam) : null;
		var pr = all && all.ok ? all : (fam && fam.ok ? fam : null), src = pr === all ? 'cm' : (pr ? 'fam' : 'none');
		if (c && c.ok) {
			var theta = (c.ws + K * (pr ? pr.theta : 0)) / (c.w + K);
			out.quality = { value: theta, theta: theta, share: c.share, lo: c.lo, hi: c.hi, n: c.n, eff: c.eff, prior: src };
		} else if (all && all.ok) {
			// A thin kind:cm cell reads as the model's overall figure, shrunk by what little it holds.
			var w = c ? c.w : 0, ws = c ? c.ws : 0, th = (ws + K * all.theta) / (w + K);
			out.quality = { value: th, theta: th, share: all.share, lo: all.lo, hi: all.hi, n: c ? c.n : 0, eff: c ? c.eff : 0, prior: 'cm' };
		} else if (!c) out.quality = notEnough(0, RR.FLOOR[3]);
		else out.quality = { not_enough: true, n: c.n, more: c.more };
		var fol = 0, folN = 0, hon = 0, honN = 0, chk = 0, chkN = 0;
		heads.forEach(function (h) {
			var t = h.tags, d = h.dims.followed;
			var plus = d >= 3 || t.indexOf('followed') >= 0, minus = (d >= 0 && d <= 1) || t.indexOf('ignored') >= 0 || t.indexOf('scope') >= 0;
			if (plus && !minus) { fol++; folN++; } else if (minus) folN++;
			if (h.nf) { honN++; if (t.indexOf('made_up') < 0) hon++; }
			if (t.indexOf('checked') >= 0) { chk++; chkN++; }
			if (t.indexOf('unchecked') >= 0) chkN++;
		});
		out.following = rate(fol, folN);
		out.honesty = rate(hon, honN);
		out.selfverify = rate(chk, chkN);
		return out;
	}

	/// The Compare grid: one row per exact model id (or per provider and model with `split`) over
	/// the turns of `opts.kind` ('all' or one of the six) whose answer was made in [from, to).
	/// `parts` are `chatPart`s; `ledger` the ledger's entries. `opts.reverted` lists the
	/// file-product handles a History restore put back over; `opts.sides` the form's tag sides;
	/// `opts.identify` the catalogue (for spend no answer holds). Same parts in any order give
	/// the same grid.
	function grid(parts, ledger, opts) {
		var RR = roll();
		if (!RR) throw new Error('modelcompare: DaimondRatingRoll is not loaded');
		var o = opts || {}, kind = str(o.kind) || 'all', split = !!o.split, rv = setOf(o.reverted);
		var ident = identifyOf(o);

		// Every turn of the account once, in one order whatever order the parts came in.
		var byKey = {}, all = [];
		(parts || []).forEach(function (part) {
			((part && part.turns) || []).forEach(function (t) {
				var k = t.role + '\u0001' + t.tid, prev = byKey[k];
				if (!prev || JSON.stringify(t) < JSON.stringify(prev)) byKey[k] = t;
			});
		});
		Object.keys(byKey).sort().forEach(function (k) { all.push(Object.assign({}, byKey[k])); });

		// The Diamond fallback: an `other` turn takes its Diamond's dominant kind.
		var dk = {};
		all.forEach(function (t) {
			if (!t.d || t.kind === 'other') return;
			var c = dk[t.d] || (dk[t.d] = { n: 0 });
			c.n++; c[t.kind] = (c[t.kind] || 0) + 1;
		});
		all.forEach(function (t) {
			if (t.kind !== 'other' || !dk[t.d]) return;
			var c = dk[t.d];
			KINDS.forEach(function (k) { if ((c[k] || 0) >= DOM_MIN && (c[k] || 0) * 10 >= c.n * DOM_SHARE) t.kind = k; });
		});

		// The ledger, by turn id.
		var byTid = {}, tied = {};
		(ledger || []).forEach(function (e) {
			if (!e || typeof e !== 'object' || !e.tid) return;
			(byTid[e.tid] || (byTid[e.tid] = [])).push(e);
		});
		all.forEach(function (t) { if (byTid[t.tid]) tied[t.tid] = 1; });

		// A retried answer is a rejected answer (§3 rule 3), though the transcript no longer holds it.
		var byId = {};
		all.forEach(function (t) { if (!byId[t.tid]) byId[t.tid] = t; });
		rejected(byTid, byId, ident).forEach(function (t) { tied[t.tid] = 1; all.push(t); });

		var scope = all.filter(function (t) { return t.cm && inWindow(t.at, o) && (kind === 'all' || t.kind === kind); });
		var rows = {}, hsTurn = {};
		scope.forEach(function (t) {
			var key = split ? t.pv + ':' + t.cm : t.cm;
			var r = rows[key] || (rows[key] = { key: key, cm: t.cm, pv: split ? t.pv : '', fam: t.fam, turns: [] });
			if (!r.fam && t.fam) r.fam = t.fam;
			r.turns.push(t);
			t.hs.forEach(function (h) { hsTurn[h] = t; });
		});

		// The judged half: every head once (the head rule's newest), in scope by its turn.
		var best = {}, partsKind = [], partsAll = [];
		var inAll = {};
		all.forEach(function (t) { if (t.cm && inWindow(t.at, o)) t.hs.forEach(function (h) { inAll[h] = t; }); });
		(parts || []).forEach(function (part) {
			((part && part.heads) || []).forEach(function (h) {
				var b = best[h.h];
				if (!b || newerHead(h, b)) best[h.h] = h;
			});
		});
		var hk = [], ha = [];
		Object.keys(best).sort().forEach(function (h) {
			var x = best[h];
			if (inAll[h]) ha.push(x);
			if (hsTurn[h]) hk.push(x);
		});
		partsKind.push({ heads: hk, made: [] });
		partsAll.push({ heads: ha, made: [] });
		var cellOpts = { sides: o.sides || null };
		var kindRoll = RR.cells(partsKind, cellOpts), allRoll = RR.cells(partsAll, cellOpts);

		var untied = {};
		(ledger || []).forEach(function (e) {
			if (!e || typeof e !== 'object' || !(num(e.u) > 0) || !inWindow(e.t, o)) return;
			if (e.tid && tied[e.tid]) return;
			var id = ident(e.m) || {}, cm = str(id.cm) || str(e.m), key = split ? str(e.pv) + ':' + cm : cm;
			untied[key] = (untied[key] || 0) + e.u;
		});

		var out = Object.keys(rows).sort().map(function (key) {
			var r = rows[key], costs = [], acc = 0, accAll = 0, fts = [], durs = [], ftN = 0, stalls = 0;
			var tc = 0, te = 0, mc1 = 0, imT = 0, imF = 0, heads = [];
			r.turns.forEach(function (t) {
				var es = byTid[t.tid] || [], ok = accepted(t, es, rv);
				if (ok) accAll++;
				if (es.length) {
					var u = 0;
					es.forEach(function (e) { u += num(e.u) || 0; });
					costs.push(u);
					if (ok) acc++;
				}
				var ft = latest(es, 'ft'), dur = latest(es, 'dur');
				if (ft !== null) { fts.push(ft); ftN++; if (es.some(function (e) { return e.sg >= 1; })) stalls++; }
				if (dur !== null) durs.push(dur);
				if (es.some(function (e) { return typeof e.ro === 'string'; })) {
					mc1++;
					es.forEach(function (e) { tc += num(e.tc) || 0; te += num(e.te) || 0; });
					if (es.some(function (e) { return e.im >= 1; })) {
						imT++;
						if (es.some(function (e) { return e.out === 'failed'; }) && !es.some(function (e) { return e.out === 'completed'; })) imF++;
					}
				}
			});
			r.turns.forEach(function (t) {
				t.hs.forEach(function (h) {
					var x = best[h];
					if (x) heads.push({ tags: x.tags, dims: x.dims, nf: t.nf.indexOf(h) >= 0 });
				});
			});
			var NR = { not_recorded: true };
			var cells = {
				cost:    costRatio(costs, acc),
				accept:  rate(accAll, r.turns.length),
				first:   ftN ? { p50: quantile(fts, 0.5), p90: quantile(fts, 0.9) } : NR,
				end:     durs.length ? { p50: quantile(durs, 0.5), p90: quantile(durs, 0.9) } : NR,
				stall:   ftN ? rate(stalls, ftN) : NR,
				toolerr: mc1 ? rate(te, tc) : NR,
				images:  mc1 ? { declared: o.declared && typeof o.declared === 'function' ? o.declared(r.cm) : null,
					tried: imT, failed: imT ? rate(imF, imT) : null } : NR,
			};
			var j = judged(RR, kindRoll, allRoll, r, split, Object.assign({ kind: kind }, o), heads);
			Object.keys(j).forEach(function (k) { cells[k] = j[k]; });
			return { key: key, cm: r.cm, pv: r.pv, fam: r.fam, n: r.turns.length, cells: cells, untied: untied[key] || 0 };
		});
		var spare = 0;
		Object.keys(untied).forEach(function (k) { spare += untied[k]; });
		return { v: 1, kindV: KIND_V, kind: kind, split: split, from: o.from == null ? null : o.from, to: o.to == null ? null : o.to,
			rows: out, untied: spare };
	}

	// ── Ranking (§4.4) ─────────────────────────────────────────

	// The one figure a column ranks on, and its band ends; null where it is not trusted.
	function figure(cells, col) {
		var c = cells && cells[col];
		if (!c) return null;
		if (col === 'first' || col === 'end') c = c.p50;
		if (!c || c.not_enough || c.not_recorded || num(c.value) === null) return null;
		if (col === 'quality') {
			// Theta runs -2..2; its ends are the share's Wilson band carried to that scale.
			return { v: c.value, lo: c.value - 4 * (c.share - c.lo), hi: c.value + 4 * (c.hi - c.share) };
		}
		return { v: c.value, lo: num(c.lo) === null ? c.value : c.lo, hi: num(c.hi) === null ? c.value : c.hi };
	}

	function presetOf(weights) {
		var w = weights || {};
		var names = Object.keys(PRESETS);
		for (var i = 0; i < names.length; i++) {
			var p = PRESETS[names[i]];
			if (COLUMNS.every(function (c) { return (Number(w[c]) || 0) === (p[c] || 0); })) return names[i];
		}
		return 'custom';
	}

	/// The grid's rows in the person's order: each weighted column scaled 0..1 across the rows
	/// that hold a trusted value (cost, times, stalls and tool errors inverted), the score their
	/// weighted mean over the row's trusted columns. A row with under half the total weight trusted
	/// is not ranked and sits below. `approx` marks a row whose band-end scores overlap the row
	/// above's. Weights run 0..5; 0 leaves a column out of the score.
	function rank(g, weights) {
		var w = {}, total = 0;
		COLUMNS.forEach(function (c) {
			var x = Math.max(0, Math.min(5, Number((weights || {})[c]) || 0));
			if (x > 0) { w[c] = x; total += x; }
		});
		var rows = ((g && g.rows) || []).filter(function (r) { return !r.team; });
		var span = {};
		Object.keys(w).forEach(function (c) {
			var vs = rows.map(function (r) { return figure(r.cells, c); }).filter(Boolean).map(function (f) { return f.v; });
			if (vs.length) span[c] = { min: Math.min.apply(null, vs), max: Math.max.apply(null, vs) };
		});
		function z(c, v) {
			var s = span[c], t = s.max > s.min ? (v - s.min) / (s.max - s.min) : 1;
			t = Math.max(0, Math.min(1, t));
			return LOW[c] ? 1 - t : t;
		}
		var scored = rows.map(function (r) {
			var sw = 0, s = 0, sLo = 0, sHi = 0;
			Object.keys(w).forEach(function (c) {
				var f = figure(r.cells, c);
				if (!f) return;
				sw += w[c]; s += w[c] * z(c, f.v);
				var a = z(c, f.lo), b = z(c, f.hi);
				sLo += w[c] * Math.min(a, b); sHi += w[c] * Math.max(a, b);
			});
			var ranked = total > 0 && sw * 2 >= total;
			return { key: r.key, cm: r.cm, pv: r.pv, ranked: ranked,
				score: ranked ? s / sw : null, lo: ranked ? sLo / sw : null, hi: ranked ? sHi / sw : null, trusted: sw };
		});
		var on = scored.filter(function (r) { return r.ranked; }).sort(function (a, b) { return b.score - a.score || cmp(a.key, b.key); });
		var off = scored.filter(function (r) { return !r.ranked; }).sort(function (a, b) { return cmp(a.key, b.key); });
		on.forEach(function (r, i) {
			r.rank = i + 1;
			r.approx = i > 0 && on[i - 1].lo <= r.hi;
		});
		off.forEach(function (r) { r.rank = 'unranked'; r.approx = false; });
		return { preset: presetOf(weights), weights: w, rows: on.concat(off) };
	}

	// ── The snapshot (§6.2) ────────────────────────────────────

	// A civil date (UTC) from ms, without a Date: Howard Hinnant's days-from-civil, inverted.
	function ymd(ms) {
		if (num(ms) === null) return '';
		var z = Math.floor(ms / 86400000) + 719468, era = Math.floor(z / 146097), doe = z - era * 146097;
		var yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
		var y = yoe + era * 400, doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100)), mp = Math.floor((5 * doy + 2) / 153);
		var d = doy - Math.floor((153 * mp + 2) / 5) + 1, m = mp + (mp < 10 ? 3 : -9);
		if (m <= 2) y++;
		return y + '-' + (m < 10 ? '0' : '') + m + '-' + (d < 10 ? '0' : '') + d;
	}

	/// The card's count band (owner ruling 1): exact counts stay in the app.
	function countBand(n) {
		return n >= 300 ? '300+' : (n >= 100 ? '100+' : (n >= 30 ? '30+' : (n >= 10 ? '10+' : '')));
	}

	function modelId(s) { return str(s).replace(/[^A-Za-z0-9._:\/@+-]/g, '').slice(0, 96); }

	function snapCell(c) {
		if (!c || c.not_enough || c.not_recorded || num(c.value) === null || !countBand(c.n)) return 'not_enough';
		return { value: c.value, lo: num(c.lo), hi: num(c.hi), n: countBand(c.n) };
	}

	/// The whole of what a card or a shared Diamond carries: the window's dates, the kind, the
	/// exact model ids (with the provider where split), per cell its figure, band and count band,
	/// the weights, the ranks and the versions. Built from a whitelist; nothing else can enter.
	/// `opts`: { weights, build, form, ranked (from `rank`, else computed) }.
	function snapshot(g, opts) {
		var o = opts || {}, r = o.ranked || rank(g, o.weights || PRESETS.balanced), byKey = {};
		((g && g.rows) || []).forEach(function (row) { if (!row.team) byKey[row.key] = row; });
		var weights = {};
		COLUMNS.forEach(function (c) { if (r.weights[c]) weights[c] = r.weights[c]; });
		var rows = r.rows.filter(function (x) { return byKey[x.key]; }).map(function (x) {
			var row = byKey[x.key], c = row.cells, cells = {};
			cells.cost = snapCell(c.cost);
			cells.accept = snapCell(c.accept);
			['first', 'end'].forEach(function (k) {
				cells[k + '_p50'] = snapCell(c[k] && c[k].p50);
				cells[k + '_p90'] = snapCell(c[k] && c[k].p90);
			});
			['stall', 'toolerr', 'quality', 'following', 'honesty', 'selfverify'].forEach(function (k) { cells[k] = snapCell(c[k]); });
			cells.images_failed = snapCell(c.images && c.images.failed);
			var out = { cm: modelId(row.cm) };
			if (g.split) out.pv = modelId(row.pv);
			out.rank = typeof x.rank === 'number' ? x.rank : 'unranked';
			if (x.approx) out.approx = true;
			out.cells = cells;
			return out;
		});
		var kind = KINDS.indexOf(g && g.kind) >= 0 ? g.kind : 'all';
		return {
			v: 1, kindV: KIND_V, form: /^daimond\/\d+(\.\d+)?$/.test(str(o.form)) ? o.form : FORM_MIN,
			build: /^[0-9a-f]{6,40}$/.test(str(o.build)) ? o.build : '',
			from: ymd(g && g.from), to: ymd(g && g.to), kind: kind, weights: weights, preset: r.preset, rows: rows,
		};
	}

	window.DaimondModelCompare = {
		KIND_V: KIND_V, KINDS: KINDS, COLUMNS: COLUMNS, PRESETS: PRESETS,
		extOf: extOf, isReask: isReask, turnKind: turnKind, turns: turns, accepted: accepted,
		quantile: quantile, rate: rate, costRatio: costRatio, grid: grid, rank: rank, presetOf: presetOf,
		snapshot: snapshot, countBand: countBand, ymd: ymd,
	};
})();
