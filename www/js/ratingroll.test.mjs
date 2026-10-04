/* ============================================================
   Test -- THE RATING ROLL-UP, PURE (www/js/ratingroll.js), U5a of 5.3.2.
   ------------------------------------------------------------
   Plan: ~/usr/code/ai/claude/specs/daimond_optimiser_532_plan_20261004.md, §5 U5a;
   design: daimond_product_rating_design_20260924.md §5.2, §6.3, §8.1.
   Rulings: O1 (fading by newer ratings, never by a stamp), P8 (a command's mark
   weighs half).

   The REAL provenance.js, ratings.js and ratingroll.js are loaded into a bare
   `window` scope, as ratings.test.mjs loads its own. There is no `document` and
   no storage, so a read of either in the module is a ReferenceError here.

   Every case is independent: one that throws is one FAIL and the rest still run,
   so the count of cases going from red to green means something.

   Run:  node www/js/ratingroll.test.mjs
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', '..');
let failures = 0, cases = 0, bad = null;

function ok(cond, detail) { if (!cond && !bad) bad = detail || 'assertion'; }
function eq(got, want, what) {
	const a = JSON.stringify(got), b = JSON.stringify(want);
	if (a !== b && !bad) bad = (what || 'value') + ': got ' + a + ' want ' + b;
}
function near(got, want, what, eps) {
	if (!(Math.abs(got - want) <= (eps || 1e-9)) && !bad) bad = (what || 'value') + ': got ' + got + ' want ' + want;
}
function kase(name, fn) {
	cases++; bad = null;
	try { fn(); } catch (e) { if (!bad) bad = 'threw ' + (e && e.message); }
	if (bad) { failures++; console.log('  FAIL ' + name + '  (' + bad + ')'); }
	else { console.log('  ok   ' + name); }
}

function load() {
	const win = {};
	for (const f of ['provenance.js', 'ratings.js', 'ratingroll.js']) {
		const body = readFileSync(join(HERE, f), 'utf8');
		new Function('window', body)(win);
	}
	return win;
}
const win = load();
const R = win.DaimondRatings, RR = win.DaimondRatingRoll;
const FORM = JSON.parse(readFileSync(join(APP, 'dev', 'fixtures', 'rating_form_daimond1.json'), 'utf8'));
const SIDES = {};
FORM.tags.forEach(t => { SIDES[t.id] = t.side; });
const OPTS = { sides: SIDES };

// ── Builders ───────────────────────────────────────────────
const BASE = { h: '', k: 'answer', m: 'accounts/fireworks/models/glm-5p2', pv: 'fireworks', cm: 'glm-5.2', fam: 'glm-5', fi: false,
	cls: 'open-frontier', role: 'chat', sp: 'sp1:3f9a0c12', d: '', c: 'c1', t: 'mfq19-0-abcde', dev: 'd-4f2a', at: 1790000000000,
	hash: '', run: '', via: '' };
let CLOCK = 1790000000000, SEQ = 0;
function tick() { CLOCK += 1000; SEQ++; return CLOCK; }
function resetClock() { CLOCK = 1790000000000; SEQ = 0; }

// One answer and its rating, in a chat. `o`: { c, d, cm, fam, cls, role, pv, s, tags, dims, len, via, note, k, h, ts }.
function pair(o) {
	const mid = 'a' + SEQ + 'x' + (o.c || 'c1');
	const k = o.k || 'answer';
	const h = o.h || ('p1:' + k + ':' + (o.c || 'c1') + '/' + mid);
	const prod = Object.assign({}, BASE, { h: h, k: k, c: o.c || 'c1', d: o.d || '' }, ['cm', 'fam', 'cls', 'role', 'pv', 'via'].reduce((a, f) => { if (o[f] !== undefined) a[f] = o[f]; return a; }, {}));
	const ts = o.ts || tick();
	const rec = R.build({ prod: prod, s: o.s, tags: o.tags || [], dims: o.dims || {}, note: o.note || '', src: 'tap', sup: o.sup || '',
		burst: '', tools: '', len: o.len === undefined ? 300 : o.len });
	const ans = { role: 'assistant', mid: mid, ts: ts - 1, content: 'an answer', prod: [prod] };
	const msg = R.message(rec, o.rid || ('r-' + ts.toString(36) + '-' + String(SEQ).padStart(5, '0')), ts);
	return { ans: ans, msg: msg, h: h, prod: prod };
}
// A chat: the answers and their ratings, as the transcript holds them.
function chat(specs) {
	const out = [];
	specs.forEach(sp => { const p = pair(sp); if (sp.noAnswer !== true && sp.k !== 'file') out.push(p.ans); out.push(p.msg); });
	return out;
}
function many(n, o) { return Array.from({ length: n }, () => Object.assign({}, o)); }
function roll(chats, opts) { return RR.cells(chats.map(m => RR.chatPart(m)), opts || OPTS); }
const A = { cm: 'model-a', fam: 'fam-x', cls: 'frontier' };
const B = { cm: 'model-b', fam: 'fam-x', cls: 'frontier' };
const C = { cm: 'model-c', fam: 'fam-y', cls: 'fast' };

// ── The module ─────────────────────────────────────────────
kase('the module attaches DaimondRatingRoll and its constants', () => {
	ok(RR && typeof RR.cells === 'function' && typeof RR.chatPart === 'function' && typeof RR.digestText === 'function', 'functions');
	eq(RR.FLOOR, { 1: 3, 2: 6, 3: 10 }, 'floors');
	eq(RR.K, 5, 'k');
	eq([RR.HALF[1], RR.HALF[2], RR.HALF[3]], [Infinity, 25, 50], 'half-lives');
});

// ── chatPart ───────────────────────────────────────────────
const U2 = JSON.parse(readFileSync(join(APP, 'dev', 'fixtures', 'rating_u2.json'), 'utf8'));
const ANSWER_C7 = { role: 'assistant', mid: 'mfq1a-1-xyz12', ts: 1790000000000, content: 'x',
	prod: [Object.assign({}, U2[0].rating.prod)] };

kase('chatPart: the U2 fixture head is the superseding record, with exactly the reduced keys', () => {
	const p = RR.chatPart([ANSWER_C7, U2[0], U2[1]]);
	eq(p.heads.length, 1, 'heads');
	const h = p.heads[0];
	eq(Object.keys(h).sort(), ['c', 'cls', 'cm', 'd', 'dims', 'fam', 'h', 'len', 'mid', 'pv', 's', 'role', 'tags', 'ts', 'via'].sort(), 'keys');
	eq([h.s, h.tags, h.len, h.cm, h.fam, h.cls, h.role, h.pv, h.c, h.d, h.via], [-2, ['ignored', 'long'], 412, 'glm-5.2', 'glm-5', 'open-frontier', 'chat', 'fireworks', 'c7', '', ''], 'values');
	eq(h.dims.correct, 1, 'dims');
});

kase('chatPart: a cleared head counts zero times (the whole U2 fixture)', () => {
	eq(RR.chatPart([ANSWER_C7, U2[0], U2[1], U2[2]]).heads.length, 0);
});

kase('chatPart: a superseded rating counts once, at the newer record', () => {
	const prod = Object.assign({}, BASE, { h: 'p1:answer:c1/m1', c: 'c1' });
	const r1 = R.message(R.build({ prod: prod, s: 1, src: 'tap', len: 10 }), 'r-aaa-00001', 100);
	const r2 = R.message(R.build({ prod: prod, s: -1, src: 'tap', sup: 'r-aaa-00001', len: 10 }), 'r-aaa-00002', 200);
	const p = RR.chatPart([r1, r2]);
	eq(p.heads.map(h => h.s), [-1]);
});

kase('chatPart: one product rated from two devices counts once, at the greater (ts, mid)', () => {
	const prod = Object.assign({}, BASE, { h: 'p1:answer:c1/m1', c: 'c1' });
	const r1 = R.message(R.build({ prod: prod, s: 1, src: 'tap', len: 10 }), 'r-aaa-00001', 200);
	const r2 = R.message(R.build({ prod: prod, s: -2, src: 'tap', len: 10 }), 'r-bbb-00002', 200);
	eq(RR.chatPart([r1, r2]).heads.map(h => h.s), [-2], 'mid breaks the tie');
	eq(RR.chatPart([r2, r1]).heads.map(h => h.s), [-2], 'in either order');
});

kase('chatPart: no note text, no handle of a rating survives in the reduced heads', () => {
	const p = RR.chatPart([ANSWER_C7, U2[0], U2[1]]);
	const j = JSON.stringify(p.heads);
	ok(j.indexOf('preamble') < 0 && j.indexOf('tape 2') < 0 && !('note' in p.heads[0]), 'note leaked');
});

kase('chatPart: made holds final answers only, once per handle', () => {
	const pr = (m) => Object.assign({}, BASE, { h: 'p1:answer:c1/' + m, c: 'c1' });
	const msgs = [
		{ role: 'assistant', mid: 'f1', ts: 1, content: 'final', prod: [pr('f1')] },
		{ role: 'assistant', mid: 'f1', ts: 1, content: 'final', prod: [pr('f1')] },
		{ role: 'assistant', mid: 'p1', ts: 2, content: 'part', provisional: true, prod: [pr('p1')] },
		{ role: 'assistant', mid: 'w1', ts: 3, content: 'cut', why: 'interrupted', prod: [pr('w1')] },
		{ role: 'assistant', mid: 'e1', ts: 4, content: '   ', prod: [pr('e1')] },
		{ role: 'assistant', mid: 'n1', ts: 5, content: 'no record' },
	];
	eq(RR.chatPart(msgs).made.map(m => m.h), ['p1:answer:c1/f1']);
});

kase('chatPart: file rows of a changed-files note and of files_log are made', () => {
	const fp = (path) => Object.assign({}, BASE, { h: 'p1:file:D1/v3/' + path, k: 'file', d: 'D1', c: 'c1' });
	const msgs = [
		{ role: 'user', mid: 'u1', ts: 1, content: '[Daimond: changed]', prod: [fp('a.md'), fp('b.md')] },
		{ role: 'files_log', mid: 'f1', ts: 2, prod: [fp('c.md')] },
		{ role: 'user', mid: 'u2', ts: 3, content: 'plain' },
	];
	eq(RR.chatPart(msgs).made.map(m => m.k), ['file', 'file', 'file']);
	eq(RR.chatPart(msgs).made.length, 3);
});

kase('chatPart: a record from a later form is not read', () => {
	const prod = Object.assign({}, BASE, { h: 'p1:answer:c1/m1' });
	const m = R.message(R.build({ prod: prod, s: 1, src: 'tap', len: 10 }), 'r-aaa-00001', 100);
	m.rating.form = 'daimond/2';
	eq(RR.chatPart([m]).heads.length, 0);
});

kase('chatPart: independent of the message order and JSON-safe', () => {
	const ms = chat(many(5, Object.assign({ s: 1 }, A)));
	const a = RR.chatPart(ms), b = RR.chatPart(ms.slice().reverse());
	eq(a, b);
	eq(JSON.parse(JSON.stringify(a)), a);
});

// ── cells: the keys, the levels, the counts ────────────────
kase('cells: the U2 fixture gives the expected cells', () => {
	const r = roll([[ANSWER_C7, U2[0], U2[1]]]);
	const c = RR.cell(r, 3, '', 'cm', 'glm-5.2');
	eq([c.n, c.w, c.w2, c.ws, c.pos, c.zero, c.neg, c.made], [1, 1, 1, -2, 0, 0, 1, 1], 'sums');
	eq(c.tags, { ignored: 1, long: 1 }, 'tags');
	eq([c.dims.correct, c.dims.followed], [{ n: 1, sum: 1 }, { n: 1, sum: 0 }], 'dims');
	eq([c.lenUp, c.lenDown], [null, 412], 'lengths');
	eq(c.rank, 0, 'rank');
	ok(RR.cell(r, 1, 'c7', 'cm', 'glm-5.2') !== null, 'L1 cell by the chat');
	eq(RR.cell(r, 2, '', 'cm', 'glm-5.2'), null, 'an ordinary chat has no L2');
});

kase('cells: a withdrawn rating adds nothing (the whole U2 fixture)', () => {
	const r = roll([[ANSWER_C7, U2[0], U2[1], U2[2]]]);
	eq(RR.cell(r, 3, '', 'cm', 'glm-5.2'), null);
});

kase('cells: the five keys exist at every level a Diamond chat reaches', () => {
	const r = roll([chat([Object.assign({ s: 1, d: 'D1', c: 'c1', role: 'daimon', pv: 'acme' }, A)])]);
	[1, 2, 3].forEach(lv => {
		const sc = lv === 1 ? 'c1' : (lv === 2 ? 'D1' : '');
		eq([RR.cell(r, lv, sc, 'cm', 'model-a').n, RR.cell(r, lv, sc, 'fam', 'fam-x').n, RR.cell(r, lv, sc, 'cls', 'frontier').n,
			RR.cell(r, lv, sc, 'role', 'daimon:model-a').n, RR.cell(r, lv, sc, 'pv', 'acme:model-a').n], [1, 1, 1, 1, 1], 'level ' + lv);
	});
});

kase('cells: an ordinary chat rolls L1 to L3, a Diamond chat L1 to L2 to L3', () => {
	const r = roll([chat([Object.assign({ s: 1, c: 'o1' }, A)]), chat([Object.assign({ s: 1, c: 'g1', d: 'D1' }, A)])]);
	eq(RR.cell(r, 3, '', 'cm', 'model-a').n, 2);
	eq(RR.cell(r, 2, 'D1', 'cm', 'model-a').n, 1);
	eq(RR.cell(r, 1, 'o1', 'cm', 'model-a').n, 1);
	eq(r.L2 && Object.keys(r.L2), ['D1']);
});

kase('cells: counts, tags, dimensions and mean lengths of up- and down-rated', () => {
	const r = roll([chat([
		Object.assign({ s: 2, tags: ['correct'], dims: { correct: 4 }, len: 100 }, A),
		Object.assign({ s: 1, tags: ['correct', 'concise'], dims: { correct: 2, style: 3 }, len: 300 }, A),
		Object.assign({ s: 0, len: 50 }, A),
		Object.assign({ s: -1, tags: ['long'], len: 900 }, A),
		Object.assign({ s: -2, tags: ['long', 'wrong'], dims: { correct: 0 }, len: 1100 }, A),
	])]);
	const c = RR.cell(r, 1, 'c1', 'cm', 'model-a');
	eq([c.n, c.pos, c.zero, c.neg, c.ws], [5, 2, 1, 2, 2 + 1 + 0 - 1 - 2], 'counts');
	eq(c.tags, { concise: 1, correct: 2, long: 2, wrong: 1 }, 'tags');
	eq(c.dims.correct, { n: 3, sum: 6 }, 'dims correct');
	eq(c.dims.style, { n: 1, sum: 3 }, 'dims style');
	eq([c.lenUp, c.lenDown], [200, 1000], 'mean lengths');
});

kase('cells: exposure reads rated of made, and a rated product absent from made still counts as made', () => {
	const ms = chat([Object.assign({ s: 1 }, A), Object.assign({ s: -1 }, A)]);
	ms.push({ role: 'assistant', mid: 'un', ts: 5, content: 'unrated', prod: [Object.assign({}, BASE, { h: 'p1:answer:c1/un', cm: 'model-a', fam: 'fam-x', cls: 'frontier' })] });
	let c = RR.cell(roll([ms]), 3, '', 'cm', 'model-a');
	eq([c.n, c.made], [2, 3], 'one unrated answer');
	c = RR.cell(roll([chat([Object.assign({ s: 1, noAnswer: true }, A)])]), 3, '', 'cm', 'model-a');
	ok(c.made >= c.n, 'rated never exceeds made');
	const gone = chat([Object.assign({ s: 1, noAnswer: true }, A), Object.assign({ s: 1, noAnswer: true }, A)]);
	gone.push(ms[ms.length - 1]);
	eq(RR.cell(roll([gone]), 3, '', 'cm', 'model-a').made, 3, 'two rated products with no answer, one unrated answer');
});

kase('cells: made is counted at each scope by the stamp (c, d), once per handle across chats', () => {
	const mk = (c, d, mid) => ({ role: 'assistant', mid: mid, ts: 1, content: 'x', prod: [Object.assign({}, BASE, { h: 'p1:answer:' + c + '/' + mid, c: c, d: d, cm: 'model-a', fam: 'fam-x', cls: 'frontier' })] });
	const withRated = (c, d) => chat([Object.assign({ s: 1, c: c, d: d }, A)]).concat([mk(c, d, 'u' + c)]);
	const c3 = withRated('c3', '');
	const r = roll([withRated('c1', 'D1'), withRated('c2', 'D1'), c3, c3]);
	eq([RR.cell(r, 3, '', 'cm', 'model-a'), RR.cell(r, 2, 'D1', 'cm', 'model-a'), RR.cell(r, 1, 'c3', 'cm', 'model-a')].map(c => c && c.made), [6, 4, 2]);
	eq(RR.cell(r, 3, '', 'cm', 'model-a').n, 3, 'a chat given twice rates once');
});

kase('cells: a product shown in two chats counts once at L2 and L3, at its latest', () => {
	const fp = { h: 'p1:file:D1/v3/x.md', k: 'file', d: 'D1' };
	const m1 = chat([Object.assign({ s: 1, c: 'c1' }, A, fp)]);
	const m2 = chat([Object.assign({ s: -2, c: 'c2' }, A, fp)]);
	const r = roll([m1, m2]);
	const c3 = RR.cell(r, 3, '', 'cm', 'model-a'), c2 = RR.cell(r, 2, 'D1', 'cm', 'model-a');
	eq([c3.n, c3.neg, c3.pos, c2.n], [1, 1, 0, 1]);
});

kase('cells: the sum of the L2 cells equals the L3 cell\'s Diamond share (compaction-free totals)', () => {
	const specs = (c, d, n, s) => chat(many(n, Object.assign({ c: c, d: d, s: s, tags: ['long'] }, A)));
	const r = roll([specs('c1', 'D1', 7, 1), specs('c2', 'D2', 5, -1), specs('c3', 'D1', 3, -2), specs('c4', '', 4, 1)]);
	const l3 = RR.cell(r, 3, '', 'cm', 'model-a'), d1 = RR.cell(r, 2, 'D1', 'cm', 'model-a'), d2 = RR.cell(r, 2, 'D2', 'cm', 'model-a');
	eq([d1.n + d2.n, l3.n - 4], [15, 15], 'n');
	eq([d1.pos + d2.pos, d1.neg + d2.neg, d1.made + d2.made], [7, 8, 15], 'pos neg made');
	eq(d1.tags.long + d2.tags.long, 15, 'tags');
});

// ── fading ─────────────────────────────────────────────────
function geo(n, H) { let s = 0; for (let k = 0; k < n; k++) s += Math.pow(2, -k / H); return s; }

kase('fading: the k-th newest weighs 2^(-k/H), H = infinity at L1, 25 at L2, 50 at L3', () => {
	const r = roll([chat(many(30, Object.assign({ s: 1, d: 'D1' }, A)))]);
	near(RR.cell(r, 1, 'c1', 'cm', 'model-a').w, 30, 'L1 weighs whole');
	near(RR.cell(r, 2, 'D1', 'cm', 'model-a').w, geo(30, 25), 'L2');
	near(RR.cell(r, 3, '', 'cm', 'model-a').w, geo(30, 50), 'L3');
	near(RR.cell(r, 2, 'D1', 'cm', 'model-a').w2, geo(30, 12.5), 'L2 sum of squares');
});

kase('fading: weight() is monotone in rank, constant at L1, and halves after H newer ratings', () => {
	for (let k = 1; k < 60; k++) { ok(RR.weight(2, k) < RR.weight(2, k - 1) && RR.weight(3, k) < RR.weight(3, k - 1), 'not decreasing at ' + k); }
	ok(RR.weight(1, 0) === 1 && RR.weight(1, 500) === 1, 'L1 constant');
	near(RR.weight(2, 25), 0.5, 'L2 half at 25');
	near(RR.weight(3, 50), 0.5, 'L3 half at 50');
	near(RR.weight(3, 3, 'command'), RR.weight(3, 3) / 2, 'command halves');
});

kase('fading: a 25-newer-ratings Diamond example from the owner\'s ruling (8 down in August weigh half)', () => {
	const old = many(8, Object.assign({ s: -1, d: 'T' }, A));
	const fresh = many(25, Object.assign({ s: 1, d: 'T' }, A));
	const c = RR.cell(roll([chat(old.concat(fresh))]), 2, 'T', 'cm', 'model-a');
	// The 8 old ones have 25..32 newer ratings, so each weighs 2^(-k/25) with k 25..32.
	let want = geo(25, 25) * 1;
	for (let k = 25; k < 33; k++) want -= Math.pow(2, -k / 25);
	near(c.ws, want, 'weighted sum of scores');
});

kase('fading: a command mark weighs half and still takes its place in the order', () => {
	let c = RR.cell(roll([chat([Object.assign({ s: 1, k: 'file', via: 'command', h: 'p1:file:D1/v1/a' }, A)])]), 3, '', 'cm', 'model-a');
	near(c.w, 0.5, 'one command mark');
	c = RR.cell(roll([chat([Object.assign({ s: 1, k: 'file', via: 'command', h: 'p1:file:D1/v1/a' }, A), Object.assign({ s: 1 }, A)])]), 3, '', 'cm', 'model-a');
	near(c.w, 1 + 0.5 * Math.pow(2, -1 / 50), 'older command mark, one newer');
});

function shifted(chats, f) {
	return chats.map(ms => ms.map(m => {
		const x = JSON.parse(JSON.stringify(m));
		x.ts = f(x.ts);
		return x;
	}));
}
const SKEWSET = () => {
	resetClock();
	const a = chat(many(12, Object.assign({ s: 1, d: 'D1', c: 'c1', tags: ['long'], len: 500 }, A)).concat(many(6, Object.assign({ s: -1, d: 'D1', c: 'c1', len: 800 }, B))));
	const b = chat(many(9, Object.assign({ s: -2, c: 'c2', tags: ['wrong'], len: 1700 }, A)).concat(many(4, Object.assign({ s: 2, c: 'c2', len: 80 }, C))));
	return [a, b];
};
const NAMES = { D1: 'Thesis' };

kase('skew (J3): every stamp moved by a day either way gives identical cells and digest', () => {
	const base = SKEWSET();
	const j0 = JSON.stringify(roll(base)), d0 = RR.digestText(roll(base), NAMES);
	[86400000, -86400000, 5 * 86400000].forEach(dt => {
		const s = shifted(base, t => t + dt);
		eq(JSON.stringify(roll(s)) === j0, true, 'cells at ' + dt);
		eq(RR.digestText(roll(s), NAMES) === d0, true, 'digest at ' + dt);
	});
});

kase('skew (J3): only the order of the stamps matters, never their size', () => {
	const base = SKEWSET();
	const j0 = JSON.stringify(roll(base));
	eq(JSON.stringify(roll(shifted(base, t => (t - 1790000000000) * 977 + 3))) === j0, true, 'stretched');
	eq(JSON.stringify(roll(shifted(base, t => 1700000000000 + (t - 1790000000000) / 1000))) === j0, true, 'squeezed');
});

kase('order: the cells do not depend on the order of the parts or of the records', () => {
	const base = SKEWSET();
	const j0 = JSON.stringify(roll(base));
	eq(JSON.stringify(roll(base.slice().reverse())) === j0, true, 'parts reversed');
	eq(JSON.stringify(roll(base.map(ms => ms.slice().reverse()))) === j0, true, 'records reversed');
});

kase('cold equals warm (J2): a rebuild from the same transcripts, or from stored parts, is byte for byte', () => {
	const base = SKEWSET();
	const parts = base.map(ms => RR.chatPart(ms));
	const cold = JSON.stringify(RR.cells(parts, OPTS));
	eq(JSON.stringify(RR.cells(parts.map(p => JSON.parse(JSON.stringify(p))), OPTS)) === cold, true, 'memo round trip');
	eq(JSON.stringify(RR.cells(base.map(ms => RR.chatPart(ms)), OPTS)) === cold, true, 'twice');
	eq(RR.digestText(RR.cells(parts, OPTS), NAMES) === RR.digestText(RR.cells(parts, OPTS), NAMES), true, 'digest');
});

kase('rank: the number of the scope\'s ratings newer than the cell\'s newest', () => {
	resetClock();
	const r = roll([chat([Object.assign({ s: 1 }, A), Object.assign({ s: 1 }, B), Object.assign({ s: 1 }, C), Object.assign({ s: 1 }, B)])]);
	eq([RR.cell(r, 3, '', 'cm', 'model-b').rank, RR.cell(r, 3, '', 'cm', 'model-c').rank, RR.cell(r, 3, '', 'cm', 'model-a').rank], [0, 1, 3]);
});

// ── trust and shrinkage ────────────────────────────────────
kase('trust: the floors are 3, 6 and 10 effective ratings at L1, L2 and L3 (fading takes a little off each)', () => {
	const eff = (n, H) => { const S = geo(n, H); return S * S / geo(n, H / 2); };
	const first = (H, floor) => { let n = 1; while (eff(n, H) < floor) n++; return n; };
	const mk = (n, d) => chat(many(n, Object.assign({ s: 1, d: d, c: 'c1' }, A)));
	const n1 = first(Infinity, 3), n2 = first(25, 6), n3 = first(50, 10);
	eq([n1, n2, n3], [3, 7, 11], 'the counts that reach the floors');
	eq([n1 - 1, n1].map(n => RR.cell(roll([mk(n, '')]), 1, 'c1', 'cm', 'model-a').ok), [false, true], 'L1');
	eq([n2 - 1, n2].map(n => RR.cell(roll([mk(n, 'D1')]), 2, 'D1', 'cm', 'model-a').ok), [false, true], 'L2');
	eq([n3 - 1, n3].map(n => RR.cell(roll([mk(n, '')]), 3, '', 'cm', 'model-a').ok), [false, true], 'L3');
});

kase('trust: the effective count (sum w)^2 / (sum w^2) counts a command mark as half a rating', () => {
	const mix = [].concat(
		many(3, Object.assign({ s: 1, d: 'D1' }, A)),
		many(3, Object.assign({ s: 1, d: 'D1', k: 'file', via: 'command' }, A)).map((o, i) => Object.assign(o, { h: 'p1:file:D1/v1/f' + i })));
	// Six ratings at L2, but H = 25 and half the weights halved: eff is below 6.
	const c = RR.cell(roll([chat(mix)]), 2, 'D1', 'cm', 'model-a');
	eq(c.n, 6, 'n');
	ok(c.eff < 6 && c.eff > 5, 'eff ' + c.eff);
	eq(c.ok, false, 'not trusted although six were rated');
	near(c.eff, (c.w * c.w) / c.w2, 'eff formula');
});

kase('trust: "N more" is exact, so N more full ratings make the cell trusted and N-1 do not', () => {
	const base = chat(many(4, Object.assign({ s: 1, d: 'D1' }, A)));
	const c = RR.cell(roll([base]), 2, 'D1', 'cm', 'model-a');
	ok(c.more >= 2 && c.more <= 4, 'more ' + c.more);
	const plus = (n) => RR.cell(roll([base.concat(chat(many(n, Object.assign({ s: 1, d: 'D1' }, A))))]), 2, 'D1', 'cm', 'model-a');
	eq([plus(c.more - 1).ok, plus(c.more).ok], [false, true]);
	eq(RR.cell(roll([chat(many(14, Object.assign({ s: 1 }, A)))]), 3, '', 'cm', 'model-a').more, 0, 'trusted needs none');
});

kase('wilson: the 90% interval agrees with a reference calculation', () => {
	const w = RR.wilson(0.7, 100);
	near(w.lo, 0.6201678660558755, 'lo', 1e-9);
	near(w.hi, 0.7692950456308546, 'hi', 1e-9);
});

function shareChat(up, down, extra) {
	return chat(many(up, Object.assign({ s: 1 }, A, extra)).concat(many(down, Object.assign({ s: -1 }, A, extra))));
}
kase('trust: a good or bad claim needs the Wilson interval to exclude one half', () => {
	const claim = (u, d) => RR.cell(roll([shareChat(u, d)]), 3, '', 'cm', 'model-a').claim;
	eq([claim(18, 2), claim(2, 18), claim(11, 9)], ['good', 'bad', '']);
});

kase('trust: no claim from a cell below its floor, however lopsided', () => {
	const c = RR.cell(roll([shareChat(5, 0, { d: 'D1' })]), 2, 'D1', 'cm', 'model-a');
	eq([c.ok, c.claim], [false, '']);
});

function theta(c, prior) { return (c.ws + 5 * prior) / (c.w + 5); }

kase('shrinkage: a thin cell reads as its parent and a trusted cell as itself', () => {
	const r = roll([chat(many(40, Object.assign({ s: 1, c: 'o1' }, A))), chat(many(2, Object.assign({ s: 2, c: 'g1', d: 'D1' }, A)))]);
	const l3 = RR.cell(r, 3, '', 'cm', 'model-a'), l2 = RR.cell(r, 2, 'D1', 'cm', 'model-a');
	eq([l3.ok, l2.ok, l2.prior], [true, false, 'up']);
	near(l2.theta, theta(l2, l3.theta), 'thin theta follows (sum ws + 5 prior)/(sum w + 5)');
	ok(Math.abs(l2.theta - l3.theta) < Math.abs(l2.ws / l2.w - l3.theta), 'nearer its parent than its own mean');
	const big = RR.cell(roll([chat(many(120, Object.assign({ s: 2 }, A)))]), 3, '', 'cm', 'model-a');
	ok(Math.abs(big.theta - 2) < 0.12, 'a trusted cell sits near its own mean, ' + big.theta);
});

kase('shrinkage: the prior is the first trusted of same key up, family here, family up, then zero', () => {
	const thin = (d, c) => chat(many(1, Object.assign({ s: 2, c: c, d: d }, A)));
	// (a) the same key one level up is trusted.
	let r = roll([thin('D1', 'g1'), chat(many(12, Object.assign({ s: 1, c: 'o1' }, A)))]);
	eq(RR.cell(r, 2, 'D1', 'cm', 'model-a').prior, 'up');
	// (b) not that, but the family at this level (the Diamond) is.
	r = roll([thin('D1', 'g1'), chat(many(8, Object.assign({ s: 1, c: 'g2', d: 'D1' }, B)))]);
	eq(RR.cell(r, 2, 'D1', 'cm', 'model-a').prior, 'fam');
	// (c) not those, but the family one level up is.
	r = roll([thin('D1', 'g1'), chat(many(12, Object.assign({ s: 1, c: 'g3', d: 'D2' }, B)))]);
	eq(RR.cell(r, 2, 'D1', 'cm', 'model-a').prior, 'famup');
	near(RR.cell(r, 2, 'D1', 'cm', 'model-a').theta, theta(RR.cell(r, 2, 'D1', 'cm', 'model-a'), RR.cell(r, 3, '', 'fam', 'fam-x').theta));
	// (d) nothing trusted: zero.
	r = roll([thin('D1', 'g1')]);
	const c = RR.cell(r, 2, 'D1', 'cm', 'model-a');
	eq(c.prior, 'none');
	near(c.theta, c.ws / (c.w + 5), 'shrunk to zero');
});

kase('shrinkage: an untrusted parent is never used as a prior', () => {
	const r = roll([chat(many(1, Object.assign({ s: 2, c: 'g1', d: 'D1' }, A))), chat(many(4, Object.assign({ s: -2, c: 'o1' }, A)))]);
	const l3 = RR.cell(r, 3, '', 'cm', 'model-a');
	eq(l3.ok, false, 'L3 has five, below ten');
	eq(RR.cell(r, 2, 'D1', 'cm', 'model-a').prior === 'up', false);
});

kase('shrinkage: a chat in a Diamond rolls through the Diamond; an ordinary chat through the account', () => {
	const r = roll([chat(many(2, Object.assign({ s: 2, c: 'g1', d: 'D1' }, A))), chat(many(8, Object.assign({ s: -1, c: 'g2', d: 'D1' }, A))), chat(many(12, Object.assign({ s: 1, c: 'o1' }, A)))]);
	eq(RR.cell(r, 1, 'g1', 'cm', 'model-a').prior, 'up', 'g1 reads the Diamond (trusted, 10 ratings)');
	near(RR.cell(r, 1, 'g1', 'cm', 'model-a').theta, theta(RR.cell(r, 1, 'g1', 'cm', 'model-a'), RR.cell(r, 2, 'D1', 'cm', 'model-a').theta));
	near(RR.cell(r, 1, 'o1', 'cm', 'model-a').theta, theta(RR.cell(r, 1, 'o1', 'cm', 'model-a'), RR.cell(r, 3, '', 'cm', 'model-a').theta), 'o1 reads the account');
});

// ── open negatives, fixed points, the trend ────────────────
kase('open negatives: a -2 with a later positive on the same model is closed, one with none is open', () => {
	const r = roll([chat([Object.assign({ s: -2 }, A), Object.assign({ s: 1 }, A), Object.assign({ s: -2 }, A)])]);
	eq(RR.cell(r, 3, '', 'cm', 'model-a').open, 1);
});

kase('open negatives: with no positive after, the -2 stays open; fixed points need the form\'s sides', () => {
	const ms = chat([Object.assign({ s: 2, tags: ['correct'] }, A), Object.assign({ s: -2 }, A), Object.assign({ s: -2 }, A)]);
	const c = RR.cell(roll([ms]), 3, '', 'cm', 'model-a');
	eq([c.open, c.fixed], [2, 1]);
	eq(RR.cell(roll([ms], {}), 3, '', 'cm', 'model-a').fixed, null, 'without sides the figure is unknown, not zero');
});

kase('trend: the newest ten ratings against the ten before, by count, from twenty ratings', () => {
	const c = RR.cell(roll([chat(many(10, Object.assign({ s: -1 }, A)).concat(many(10, Object.assign({ s: 1 }, A))))]), 3, '', 'cm', 'model-a');
	eq(c.trend, { recent: { n: 10, pos: 10 }, prior: { n: 10, pos: 0 } });
	eq(RR.cell(roll([chat(many(19, Object.assign({ s: 1 }, A)))]), 3, '', 'cm', 'model-a').trend, null, 'below twenty: no trend');
});

// ── the style confound ─────────────────────────────────────
function lens(model, band, n, s) { return many(n, Object.assign({ s: s, len: [100, 800, 2000][band], d: 'D1' }, model)); }
function cmp(specs) { resetClock(); return RR.compare(roll([chat(specs)]), 2, 'D1', 'model-a', 'model-b'); }

kase('confound: length bands are < 400, 400 to 1500 and > 1500 characters', () => {
	const r = roll([chat([399, 400, 1500, 1501].map(l => Object.assign({ s: 1, len: l }, A)))]);
	eq(RR.cell(r, 3, '', 'cm', 'model-a').bands.map(b => b.n), [1, 2, 1]);
});

kase('confound: files hold no length and fall in no band', () => {
	const c = RR.cell(roll([chat([Object.assign({ s: 1, k: 'file', len: 0, h: 'p1:file:D1/v1/a' }, A)])]), 3, '', 'cm', 'model-a');
	eq(c.bands.map(b => b.n), [0, 0, 0]);
});

kase('confound: a comparison is reported when the band-wise signs agree', () => {
	const r = cmp([].concat(lens(A, 0, 4, 1), lens(B, 0, 4, -1), lens(A, 1, 4, 2), lens(B, 1, 4, 0), lens(A, 2, 4, 1), lens(B, 2, 4, -2)));
	eq([r.report, r.dir, r.why], [true, 'a', '']);
});

kase('confound: the band-wise direction decides, not the pooled one', () => {
	// Pooled A beats B (A is mostly short and well rated), yet B wins inside both bands that both fill.
	const r = cmp([].concat(lens(A, 0, 12, 1), lens(B, 0, 3, 2), lens(A, 2, 3, -2), lens(B, 2, 12, -1)));
	eq([r.report, r.dir], [true, 'b']);
});

kase('confound: not reported when the bands disagree', () => {
	const r = cmp([].concat(lens(A, 0, 4, 2), lens(B, 0, 4, -1), lens(A, 2, 4, -2), lens(B, 2, 4, 1)));
	eq([r.report, r.why], [false, 'bands']);
});

kase('confound: not reported when the two models never share a length band', () => {
	const r = cmp([].concat(lens(A, 0, 6, 1), lens(B, 2, 6, -1)));
	eq([r.report, r.why], [false, 'overlap']);
});

kase('confound: a down-rate that follows length whatever the model is a length finding', () => {
	resetClock();
	const sp = (m) => [].concat(lens(m, 0, 7, 1), lens(m, 0, 1, -1), lens(m, 2, 2, 1), lens(m, 2, 6, -1));
	const f = RR.lengthFinding(roll([chat(sp(A).concat(sp(B)))]), 2, 'D1');
	eq([f.found, f.dir], [true, 'long']);
});

kase('confound: a small drift in down-rates across lengths is no length finding', () => {
	resetClock();
	const sp = (m) => [].concat(lens(m, 0, 4, 1), lens(m, 0, 4, -1), lens(m, 2, 3, 1), lens(m, 2, 5, -1));
	eq(RR.lengthFinding(roll([chat(sp(A).concat(sp(B)))]), 2, 'D1').found, false);
});

kase('confound: flat down-rates across lengths are no length finding', () => {
	resetClock();
	const sp = (m) => [].concat(lens(m, 0, 4, 1), lens(m, 0, 4, -1), lens(m, 2, 4, 1), lens(m, 2, 4, -1));
	eq(RR.lengthFinding(roll([chat(sp(A).concat(sp(B)))]), 2, 'D1').found, false);
});

// ── the digest ─────────────────────────────────────────────
function provoking() {
	resetClock();
	const notes = ['ZEBRAWORD keeps lecturing me', 'please never say QUOKKAPHRASE', 'plan at secret_plan_xyz'];
	const a = chat([].concat(
		many(12, Object.assign({ s: 1, d: 'D1', c: 'c-zq9', tags: ['correct', 'zebra_tag'], note: notes[0], len: 200 }, A)),
		many(7, Object.assign({ s: -2, d: 'D1', c: 'c-zq9', tags: ['long', 'zebra_tag'], note: notes[1], len: 1800 }, A)),
		[Object.assign({ s: -1, d: 'D1', c: 'c-zq9', k: 'file', h: 'p1:file:D1/v3/secret_plan_xyz.md', tags: ['broke'], note: notes[2], len: 0 }, B)]));
	const b = chat(many(5, Object.assign({ s: 1, c: 'c-oo1', note: 'ZEBRAWORD again' }, C)));
	return [a, b];
}

kase('digestText: a Ratings section with the counts, the interval, trust and the leading tags', () => {
	const t = RR.digestText(roll(provoking()), NAMES);
	ok(/^## Ratings/m.test(t), 'heading');
	ok(t.indexOf('model-a') >= 0 && t.indexOf('Thesis') >= 0, 'model and Diamond name');
	ok(/12 up/.test(t) && /7 down/.test(t), 'counts: ' + t.slice(0, 600));
	ok(t.indexOf('long') >= 0 && t.indexOf('correct') >= 0, 'leading tags');
	ok(/19 of 19 made/.test(t), 'exposure');
});

kase('digestText holds no free text (J4): no note word, no path, no handle, no chat id, no custom tag', () => {
	const t = RR.digestText(roll(provoking()), NAMES);
	['ZEBRAWORD', 'QUOKKAPHRASE', 'secret_plan', 'p1:', 'c-zq9', 'c-oo1', 'zebra_tag', 'accounts/fireworks'].forEach(w => ok(t.indexOf(w) < 0, 'leaked ' + w));
});

kase('digestText holds no stamp and no age (J3): no timestamp digit run, no "ago", no days', () => {
	const t = RR.digestText(roll(provoking()), NAMES);
	ok(!/17[0-9]{11}/.test(t) && !/\bago\b/i.test(t) && !/\bdays?\b/i.test(t) && !/\bweeks?\b/i.test(t), 'a time crept in');
});

kase('digestText: a thin cell says "not enough yet, N more", a trusted one does not', () => {
	const t = RR.digestText(roll(provoking()), NAMES);
	ok(/not enough yet, \d+ more/.test(t), 'thin');
	const only = RR.digestText(roll([chat(many(14, Object.assign({ s: 1 }, A)))]), NAMES);
	ok(only.indexOf('not enough yet') < 0, 'trusted');
});

kase('digestText: Diamond names come from the list; one not on it is never named from a rating', () => {
	const t = RR.digestText(roll(provoking()), {});
	ok(t.indexOf('Thesis') < 0, 'no name given');
	ok(/not in the Diamond list|no longer listed/i.test(t), 'placeholder');
	const t2 = RR.digestText(roll(provoking()), { D1: 'A | B\nC' });
	ok(t2.indexOf('A | B') < 0 && t2.indexOf('A / B C') >= 0, 'a name cannot break the table');
});

kase('digestText: open negatives, fixed points and the trend are written', () => {
	const t = RR.digestText(roll([chat(many(10, Object.assign({ s: -2 }, A)).concat(many(10, Object.assign({ s: 2, tags: ['correct'] }, A))))]), NAMES);
	ok(/open negatives/i.test(t) && /fixed points/i.test(t) && /newest 10/i.test(t), t.slice(0, 900));
});

kase('digestText: an empty roll says nothing is rated yet, and says it is counted on this device', () => {
	const t = RR.digestText(roll([]), NAMES);
	ok(/Nothing rated yet/.test(t) && /## Ratings/.test(t));
});

kase('digestText: the length finding and an unreported comparison are stated, never silently dropped', () => {
	resetClock();
	const sp = (m) => [].concat(lens(m, 0, 7, 1), lens(m, 0, 1, -1), lens(m, 2, 2, 1), lens(m, 2, 6, -1));
	const t = RR.digestText(roll([chat(sp(A).concat(sp(B)))]), NAMES);
	ok(/length/i.test(t) && /long/i.test(t), 'length finding');
});

kase('digestText: implicit signals are stated as not yet recorded (P9)', () => {
	ok(/implicit signals: not yet recorded/i.test(RR.digestText(roll(provoking()), NAMES)));
});

kase('digestText: bounded, however many models and Diamonds there are', () => {
	resetClock();
	const chats = [];
	for (let i = 0; i < 40; i++) chats.push(chat(many(3, { s: 1, c: 'cc' + i, d: 'DD' + i, cm: 'model-' + i, fam: 'f' + (i % 3), cls: 'fast' })));
	const t = RR.digestText(roll(chats), {});
	ok(t.length < 20000, 'length ' + t.length);
	ok(/and \d+ more/.test(t), 'says how many it left out');
});

// ── The old Models-page counts (U5b, O4) ───────────────────
kase('legacy: the old counts read as a list, busiest first, ties by model', () => {
	const raw = JSON.stringify({ 'glm-5.2': { up: 4, down: 2 }, 'b/two': { up: 1 }, 'a/one': { down: 1 }, 'z/none': { up: 0, down: 0 } });
	eq(RR.legacy(raw), [{ model: 'glm-5.2', up: 4, down: 2 }, { model: 'a/one', up: 0, down: 1 }, { model: 'b/two', up: 1, down: 0 }]);
});

kase('legacy: a store that is absent, corrupt or the wrong shape is an empty list, never a throw', () => {
	['', 'not json{{{', 'null', '[]', '"x"', '3', '{}'].forEach(raw => eq(RR.legacy(raw), [], 'raw ' + JSON.stringify(raw)));
	eq(RR.legacy(null), [], 'null');
	eq(RR.legacy(undefined), [], 'undefined');
});

kase('legacy: a count that is not a positive whole number reads as zero; a name is cleaned', () => {
	const raw = JSON.stringify({ 'a|b\nc': { up: 2.9, down: -3 }, 'x': { up: 'many', down: null } });
	eq(RR.legacy(raw), [{ model: 'a/b c', up: 2, down: 0 }]);
});

kase('legacy: two keys that clean to one name are one row', () => {
	eq(RR.legacy(JSON.stringify({ 'a|b': { up: 1, down: 0 }, 'a/b': { up: 2, down: 1 } })), [{ model: 'a/b', up: 3, down: 1 }]);
});

kase('beforeText: a closing block of one line per model, apart from the figures, with no date and no age', () => {
	const t = RR.beforeText(RR.legacy(JSON.stringify({ 'glm-5.2': { up: 4, down: 2 }, 'b/two': { up: 1, down: 0 } })));
	ok(/^## Before answer ratings \(this device, Models page\)/.test(t), 'heading: ' + t.slice(0, 80));
	ok(t.indexOf('- glm-5.2: 4 up, 2 down\n') >= 0 && t.indexOf('- b/two: 1 up, 0 down\n') >= 0, 'lines: ' + t);
	ok(/no figure above counts them/.test(t), 'says it is apart');
	ok(!/17[0-9]{11}/.test(t) && !/\bago\b|\bdays?\b|\bweeks?\b/i.test(t), 'a time crept in');
	ok(t.indexOf('## Ratings') < 0 && t.indexOf('theta') < 0, 'is not a Ratings section');
});

kase('beforeText: nothing to say is an empty string, and a long list is bounded and says how many it left out', () => {
	eq(RR.beforeText([]), '');
	eq(RR.beforeText(null), '');
	const many40 = {}; for (let i = 0; i < 40; i++) many40['model-' + i] = { up: 1, down: 1 };
	const t = RR.beforeText(RR.legacy(JSON.stringify(many40)));
	ok(t.split('\n').filter(l => l.startsWith('- ')).length === 20, 'rows');
	ok(/And 20 more models, left out\./.test(t), 'rest');
});

kase('beforeText: a model name cannot break a line, and the Ratings section never carries these counts', () => {
	const t = RR.beforeText(RR.legacy(JSON.stringify({ 'evil\n## Ratings\n- fake': { up: 1, down: 1 } })));
	ok(t.split('\n').filter(l => l.startsWith('## ')).length === 1, 'one heading: ' + t);
	const d = RR.digestText(roll([chat(many(3, Object.assign({ s: 1 }, A)))]), NAMES);
	ok(d.indexOf('Before answer ratings') < 0, 'the Ratings section holds no before block');
});

kase('purity: the module neither reads nor writes the DOM or storage (it loaded in a bare scope)', () => {
	const src = readFileSync(join(HERE, 'ratingroll.js'), 'utf8');
	ok(!/\b(document|localStorage|sessionStorage|indexedDB|fetch|XMLHttpRequest)\b/.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')), 'touches a browser global');
	ok(!/Date\.now|new Date|performance\.now/.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')), 'reads the clock');
});

console.log('\n' + cases + ' cases, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
