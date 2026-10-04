/* ============================================================
   Test -- THE PROPOSAL RULES, PURE (www/js/steering.js), U7a of 5.3.2.
   ------------------------------------------------------------
   Plan: ~/usr/code/ai/claude/specs/daimond_optimiser_532_plan_20261004.md, §5 U7a, §3 P4 to P7,
   §11 O3. The REAL provenance.js, ratings.js, ratingroll.js and steering.js are loaded into a bare
   `window` scope, as ratingroll.test.mjs loads its own: a read of the DOM, storage or the clock in
   the module is a ReferenceError here. Every case is independent.

   Run:  node www/js/steering.test.mjs
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
function kase(name, fn) {
	cases++; bad = null;
	try { fn(); } catch (e) { if (!bad) bad = 'threw ' + (e && e.message); }
	if (bad) { failures++; console.log('  FAIL ' + name + '  (' + bad + ')'); }
	else { console.log('  ok   ' + name); }
}

function load() {
	const win = {};
	for (const f of ['provenance.js', 'ratings.js', 'ratingroll.js', 'steering.js']) {
		new Function('window', readFileSync(join(HERE, f), 'utf8'))(win);
	}
	return win;
}
const win = load();
const R = win.DaimondRatings, RR = win.DaimondRatingRoll, S = win.DaimondSteering;
const FORM = JSON.parse(readFileSync(join(APP, 'dev', 'fixtures', 'rating_form_daimond1.json'), 'utf8'));
const SIDES = {};
FORM.tags.forEach(t => { SIDES[t.id] = t.side; });
const OPTS = { sides: SIDES };

// ── Builders (as ratingroll.test.mjs) ──────────────────────
const BASE = { h: '', k: 'answer', m: 'accounts/fireworks/models/glm-5p2', pv: 'fireworks', cm: 'glm-5.2', fam: 'glm-5', fi: false,
	cls: 'open-frontier', role: 'chat', sp: 'sp1:3f9a0c12', d: '', c: 'c1', t: 'mfq19-0-abcde', dev: 'd-4f2a', at: 1790000000000,
	hash: '', run: '', via: '' };
let CLOCK = 1790000000000, SEQ = 0;
function tick() { CLOCK += 1000; SEQ++; return CLOCK; }
function pair(o) {
	const mid = 'a' + SEQ + 'x' + (o.c || 'c1');
	const h = 'p1:answer:' + (o.c || 'c1') + '/' + mid;
	const prod = Object.assign({}, BASE, { h: h, c: o.c || 'c1', d: o.d || '' }, ['cm', 'fam', 'cls', 'role', 'pv', 'via'].reduce((a, f) => { if (o[f] !== undefined) a[f] = o[f]; return a; }, {}));
	const ts = o.ts || tick();
	const rec = R.build({ prod: prod, s: o.s, tags: o.tags || [], dims: {}, note: o.note || '', src: 'tap', sup: '', burst: '', tools: '', len: o.len === undefined ? 300 : o.len });
	const ans = { role: 'assistant', mid: mid, ts: ts - 1, content: 'an answer', prod: [prod] };
	return [ans, R.message(rec, 'r-' + ts.toString(36) + '-' + String(SEQ).padStart(5, '0'), ts)];
}
function chat(specs) { const out = []; specs.forEach(sp => { out.push.apply(out, pair(sp)); }); return out; }
function roll(chats) { return RR.cells(chats.map(m => RR.chatPart(m)), OPTS); }

// `g`: { d, c, cm, fam, up, down, tags: { long: n }, len, lenUp } -> specs, ups first, the first tags.* downs tagged.
function mk(g) {
	const out = [], base = { d: g.d || '', c: g.c || 'c1', cm: g.cm, fam: g.fam || 'fam-x', cls: 'frontier' };
	for (let i = 0; i < (g.up || 0); i++) out.push(Object.assign({}, base, { s: 1, len: g.lenUp || g.len || 300 }));
	const queue = [];
	Object.keys(g.tags || {}).forEach(t => { for (let i = 0; i < g.tags[t]; i++) queue.push(t); });
	for (let i = 0; i < (g.down || 0); i++) out.push(Object.assign({}, base, { s: -1, len: g.len || 300, tags: queue[i] ? [queue[i]] : [] }));
	return out;
}
const DIA = [{ d: 'dia1', name: 'Thesis', cm: 'model-a' }];
const NO = [];
// The account-level fixture: model-a rated 2 up, 10 down; `long` on 3 of the 10.
function acct(tags) { return roll([chat(mk({ cm: 'model-a', up: 2, down: 10, tags: tags || { long: 3 } }))]); }
const ctx = { diamonds: DIA };
const kinds = ps => ps.map(p => p.kind);
function ent(o) { return Object.assign({ id: 'n-1', status: 'active', cm: 'model-a', tag: 'long', level: 3, scope: '', at: { t: 3, n: 12 } }, o); }

// ── The module and the table (O3) ──────────────────────────
kase('the module attaches DaimondSteering with its functions and constants', () => {
	ok(S && typeof S.proposals === 'function' && typeof S.lineFor === 'function' && typeof S.cooling === 'function', 'functions');
	eq([S.NOTE_SHARE, S.NEW_MIN], [0.3, 20], 'thresholds');
});

kase('the table: every tag is a down tag the form holds, of answers or files', () => {
	const tags = Object.keys(S.LINES);
	eq(tags.length, 13, 'tags');
	tags.forEach(t => {
		const f = FORM.tags.find(x => x.id === t);
		ok(f && f.side === 'down' && (f.kinds.includes('answer') || f.kinds.includes('file')), 'tag ' + t);
	});
});

kase('the table: the owner example is exact, and each line is a t() key with a full stop', () => {
	eq(S.LINES.long.en, 'Keep answers under about 200 words unless asked for detail.', 'long');
	Object.keys(S.LINES).forEach(t => {
		const e = S.LINES[t];
		eq(e.key, 'steer.line.' + t, 'key of ' + t);
		ok(/[A-Za-z].*\.$/.test(e.en), 'full stop ' + t);
		ok(!/[\r\n\t]/.test(e.en), 'one line ' + t);
	});
	eq(new Set(Object.keys(S.LINES).map(t => S.LINES[t].en)).size, 13, 'distinct');
});

kase('the table: each line is short enough that five fit the 600 byte block', () => {
	Object.keys(S.LINES).forEach(t => { ok(Buffer.byteLength(S.LINES[t].en) <= 110, t + ' is ' + Buffer.byteLength(S.LINES[t].en)); });
});

// An over-inclusive mirror of the engine's steering::refusal: any stem, anywhere, case-folded.
const REFUSAL = /rat(e|ed|es|ing|ings)\b|scor|vot|pleas|approv|agree|agreement|thumb|prais|applau|reward|grade|rank|stars?\b|feedback|opinion|satisf|liked?\b|upvot|downvot/i;
kase('the table: no line asks for approval, ratings, praise or agreement (the engine word list, mirrored over-inclusively)', () => {
	Object.keys(S.LINES).forEach(t => { ok(!REFUSAL.test(S.LINES[t].en), t + ': ' + S.LINES[t].en); });
});

const SIGNALS = readFileSync(join(APP, 'dev', 'verify_signals.mjs'), 'utf8');
const BANNED = /frustrat|angry|upset|annoy|mood|swear|swore|profan|temper|emotion|stressed|irritat/i;
kase('J9: the reaction word list here is the one verify_signals.mjs holds', () => {
	ok(SIGNALS.indexOf('const banned = /frustrat|angry|upset|annoy|mood|swear|swore|profan|temper|emotion|stressed|irritat/i;') >= 0, 'pinned list moved');
});
kase('J9: no line names a reaction', () => {
	Object.keys(S.LINES).forEach(t => { ok(!BANNED.test(S.LINES[t].en), t); });
});

kase('lineFor: English by default; a translator gets the key and the English and its answer is used', () => {
	eq(S.lineFor('long'), S.LINES.long.en);
	eq(S.lineFor('long', (k, en) => k + '|' + en), 'steer.line.long|' + S.LINES.long.en);
	eq(S.lineFor('nope'), '', 'unknown tag');
});

// ── cooling (P7) ───────────────────────────────────────────
kase('cooling: 20 new rated products free a retired or dismissed entry; fewer leave the count still needed', () => {
	const e = ent({ status: 'dismissed', at: { t: 3, n: 12 } });
	eq(S.cooling(e, { n: 12 }), 20);
	eq(S.cooling(e, { n: 31 }), 1);
	eq(S.cooling(e, { n: 32 }), 0);
	eq(S.cooling(e, { n: 99 }), 0);
	eq(S.cooling(e, { n: 5 }), 20, 'a cell that shrank never goes below zero new');
	eq(S.cooling(e, null), 20, 'no cell');
});

// ── Note proposals ─────────────────────────────────────────
kase('note: a trusted cell whose leading down tag holds 30% of its down-rates proposes the fixed line', () => {
	const ps = S.proposals(acct(), NO, ctx);
	eq(kinds(ps), ['note']);
	const p = ps[0];
	eq([p.kind, p.level, p.scope, p.key, p.tag], ['note', 3, '', 'model-a', 'long']);
	eq(p.line, S.LINES.long.en);
	eq(p.lineKey, 'steer.line.long');
	eq(p.at, { t: 3, n: 12 }, 'counts to record at activation');
	eq(p.evidence.down, 10);
	eq(p.evidence.tagged, 3);
});

kase('note: 2 of 10 is below 30% and proposes nothing', () => {
	eq(S.proposals(acct({ long: 2 }), NO, ctx), []);
});

kase('J5: nothing from an untrusted cell', () => {
	const r = roll([chat(mk({ cm: 'model-a', up: 0, down: 9, tags: { long: 9 } }))]);
	eq(RR.cell(r, 3, '', 'cm', 'model-a').ok, false, 'precondition');
	eq(S.proposals(r, NO, ctx), []);
});

kase('J5: a trusted cell with no good or bad claim proposes nothing', () => {
	const r = roll([chat(mk({ cm: 'model-a', up: 6, down: 6, tags: { long: 6 } }))]);
	const c = RR.cell(r, 3, '', 'cm', 'model-a');
	eq([c.ok, c.claim], [true, ''], 'precondition');
	eq(S.proposals(r, NO, ctx), []);
});

kase('note: the leading tag wins; a tie goes to the lower tag id', () => {
	eq(S.proposals(acct({ long: 3, wrong: 5 }), NO, ctx)[0].tag, 'wrong');
	eq(S.proposals(acct({ long: 4, wrong: 4 }), NO, ctx)[0].tag, 'long');
});

kase('note: a leading tag with no sentence (a crystal tag) is passed over for the next with one', () => {
	const p = S.proposals(acct({ lost: 6, long: 4 }), NO, ctx);
	eq(p.map(x => x.tag), ['long']);
});

kase('note: a Diamond note is for the Diamond\'s current model only', () => {
	const r = roll([chat(mk({ d: 'dia1', cm: 'model-a', up: 1, down: 9, tags: { long: 4 } }))]);
	const l2 = S.proposals(r, NO, ctx).filter(p => p.level === 2);
	eq(l2.map(p => [p.scope, p.key, p.tag]), [['dia1', 'model-a', 'long']]);
	eq(S.proposals(r, NO, { diamonds: [{ d: 'dia1', name: 'Thesis', cm: 'model-b' }] }).filter(p => p.level === 2), []);
	eq(S.proposals(r, NO, { diamonds: [] }).filter(p => p.level === 2), [], 'a Diamond the page no longer lists');
	eq(S.proposals(r, NO, {}).filter(p => p.level === 2), [], 'no ctx');
});

kase('note: the same cell gives an account note too, and the two differ only by level and scope', () => {
	const r = roll([chat(mk({ d: 'dia1', cm: 'model-a', up: 1, down: 12, tags: { long: 5 } }))]);
	const ps = S.proposals(r, NO, ctx);
	eq(ps.map(p => [p.level, p.scope]).sort(), [[2, 'dia1'], [3, '']]);
});

kase('no duplicate: an active entry for the same level, scope, model and tag stops the proposal', () => {
	eq(S.proposals(acct(), [ent()], ctx), []);
	eq(S.proposals(acct(), [ent({ cm: 'all' })], ctx), [], 'an all-models entry');
});

kase('no duplicate: another tag or another model does not', () => {
	eq(S.proposals(acct(), [ent({ tag: 'short' })], ctx).length, 1);
	eq(S.proposals(acct(), [ent({ cm: 'model-b' })], ctx).length, 1);
});

kase('no duplicate: an active account note covers a Diamond proposal, but a Diamond note does not cover the account', () => {
	const r = roll([chat(mk({ d: 'dia1', cm: 'model-a', up: 1, down: 12, tags: { long: 5 } }))]);
	const acc = S.proposals(r, [ent({ level: 3, scope: '' })], ctx);
	eq(acc.map(p => p.level), [], 'covered at both levels');
	const dia = S.proposals(r, [ent({ level: 2, scope: 'dia1' })], ctx);
	eq(dia.map(p => p.level), [3]);
});

kase('P7: a dismissed entry holds the proposal until 20 new rated products of the key, and not before', () => {
	const e = ent({ status: 'dismissed', at: { t: 3, n: 12 } });
	eq(S.proposals(acct(), [e], ctx), [], 'now');
	const more = (k) => roll([chat(mk({ cm: 'model-a', up: 2, down: 10 + k, tags: { long: 3 + Math.ceil(k / 2) } }))]);
	eq(S.proposals(more(19), [e], ctx), [], '19 new');
	eq(S.proposals(more(20), [e], ctx).map(p => p.tag), ['long'], '20 new');
});

kase('P7: a retired entry holds it the same way', () => {
	const e = ent({ status: 'retired', at: { t: 3, n: 12 } });
	eq(S.proposals(acct(), [e], ctx), []);
	const r = roll([chat(mk({ cm: 'model-a', up: 2, down: 30, tags: { long: 12 } }))]);
	eq(S.proposals(r, [e], ctx).length, 1);
});

kase('a dismissed entry at another scope does not hold this one', () => {
	eq(S.proposals(acct(), [ent({ status: 'dismissed', level: 2, scope: 'dia1' })], ctx).length, 1);
});

kase('invalid entries are ignored and never throw', () => {
	const junk = [null, 3, 'x', {}, { status: 'active' }, { status: 'bogus', cm: 'model-a', tag: 'long', level: 3 }, ent({ at: null }), ent({ at: { t: 'x', n: -4 } })];
	eq(S.proposals(acct(), junk, ctx).length, 0, 'the two usable ones are active entries for the same tag, so they hold it');
	eq(S.proposals(acct(), 'not a list', ctx).length, 1);
	eq(S.proposals(null, NO, ctx), []);
	eq(S.proposals(undefined, undefined, undefined), []);
});

// ── Switch proposals ───────────────────────────────────────
function switchRoll(extra) {
	return roll([chat(mk({ d: 'dia1', cm: 'model-a', up: 1, down: 4, len: 300 }).concat(mk({ d: 'dia1', cm: 'model-a', down: 4, len: 800 }))
		.concat(mk({ d: 'dia1', cm: 'model-b', up: 5, len: 300 })).concat(mk({ d: 'dia1', cm: 'model-b', up: 4, down: 1, len: 800 })).concat(extra || []))]);
}
const sw = ps => ps.filter(p => p.kind === 'switch');

kase('switch: the Diamond\'s model trusted and bad, another model there trusted and good, bands agreeing', () => {
	const r = switchRoll();
	eq([RR.cell(r, 2, 'dia1', 'cm', 'model-a').claim, RR.cell(r, 2, 'dia1', 'cm', 'model-b').claim], ['bad', 'good'], 'precondition');
	const p = sw(S.proposals(r, NO, ctx));
	eq(p.length, 1);
	eq([p[0].level, p[0].scope, p[0].key, p[0].to, p[0].tag, p[0].line], [2, 'dia1', 'model-a', 'model-b', '', '']);
	eq(Object.keys(p[0].evidence).sort(), ['cmp', 'from', 'to']);
	eq(p[0].evidence.from.cm, 'model-a');
	eq(p[0].at.n, RR.cell(r, 2, 'dia1', 'cm', 'model-a').n, 'a dismissal records the count');
});

kase('Opus B F3: the dismissed switch Switch Back writes holds the same switch for 20 new rated answers of the model it returned to', () => {
	const r = switchRoll(), cur = RR.cell(r, 2, 'dia1', 'cm', 'model-a');
	eq(sw(S.proposals(r, NO, ctx)).length, 1, 'precondition: proposed with nothing on file');
	// What the page writes: cm the model the Diamond is back on, to the model it tried, at.n that model's count now.
	const back = ent({ id: 'n-bk', status: 'dismissed', level: 2, scope: 'dia1', cm: 'model-a', tag: 'switch', to: 'model-b', at: { t: 0, n: cur.n }, kept: 0, line: '' });
	eq(sw(S.proposals(r, [back], ctx)).length, 0, 'not offered again at once');
	const later = switchRoll(mk({ d: 'dia1', cm: 'model-a', down: 20, len: 300 }));
	eq(RR.cell(later, 2, 'dia1', 'cm', 'model-a').n - cur.n >= 20, true, 'precondition: 20 more rated answers of model-a');
	eq(sw(S.proposals(later, [back], ctx)).length, 1, 'and freed after them');
});

kase('switch: none when the Diamond\'s own model is not bad', () => {
	eq(sw(S.proposals(switchRoll(), NO, { diamonds: [{ d: 'dia1', name: 'Thesis', cm: 'model-b' }] })), []);
});

kase('switch: none when the other model is untrusted (too few ratings)', () => {
	const r = roll([chat(mk({ d: 'dia1', cm: 'model-a', up: 1, down: 8, len: 300 }).concat(mk({ d: 'dia1', cm: 'model-b', up: 2, len: 300 })))]);
	eq(RR.cell(r, 2, 'dia1', 'cm', 'model-b').ok, false, 'precondition');
	eq(sw(S.proposals(r, NO, ctx)), []);
});

kase('switch: none for an ordinary chat, which has no Diamond model (P6)', () => {
	const r = roll([chat(mk({ c: 'c9', cm: 'model-a', up: 1, down: 12 }).concat(mk({ c: 'c9', cm: 'model-b', up: 12 })))]);
	eq(sw(S.proposals(r, NO, ctx)), []);
	eq(sw(S.proposals(r, NO, { diamonds: [{ d: '', name: '', cm: 'model-a' }] })), []);
});

kase('switch: the style confound explains it when the length bands disagree', () => {
	const r = roll([chat(
		mk({ d: 'dia1', cm: 'model-a', up: 0, down: 14, len: 300 }).concat(mk({ d: 'dia1', cm: 'model-a', up: 3, down: 0, len: 800 }))
			.concat(mk({ d: 'dia1', cm: 'model-b', up: 8, len: 300 })).concat(mk({ d: 'dia1', cm: 'model-b', up: 2, down: 1, len: 800 })))]);
	eq([RR.cell(r, 2, 'dia1', 'cm', 'model-a').claim, RR.cell(r, 2, 'dia1', 'cm', 'model-b').claim], ['bad', 'good'], 'precondition');
	eq(RR.compare(r, 2, 'dia1', 'model-a', 'model-b').why, 'bands', 'precondition');
	eq(sw(S.proposals(r, NO, ctx)), []);
});

kase('switch: no comparison that the bands can support, no switch (no band holds both)', () => {
	const r = roll([chat(mk({ d: 'dia1', cm: 'model-a', up: 1, down: 8, len: 300 }).concat(mk({ d: 'dia1', cm: 'model-b', up: 9, len: 800 })))]);
	eq(RR.compare(r, 2, 'dia1', 'model-a', 'model-b').why, 'overlap', 'precondition');
	eq(sw(S.proposals(r, NO, ctx)), []);
});

kase('switch: a length finding in the Diamond explains it', () => {
	const r = roll([chat(
		mk({ d: 'dia1', cm: 'model-a', up: 2, down: 4, len: 300 }).concat(mk({ d: 'dia1', cm: 'model-a', down: 6, len: 2000 }))
			.concat(mk({ d: 'dia1', cm: 'model-b', up: 8, len: 300 })).concat(mk({ d: 'dia1', cm: 'model-b', up: 4, down: 2, len: 2000 })))]);
	eq([RR.cell(r, 2, 'dia1', 'cm', 'model-a').claim, RR.cell(r, 2, 'dia1', 'cm', 'model-b').claim], ['bad', 'good'], 'precondition');
	eq(RR.compare(r, 2, 'dia1', 'model-a', 'model-b').dir, 'b', 'precondition');
	eq(RR.lengthFinding(r, 2, 'dia1').found, true, 'precondition');
	eq(sw(S.proposals(r, NO, ctx)), []);
});

kase('switch: the Diamond\'s model trusted but with no claim, or the other model trusted with no claim, proposes nothing (J5)', () => {
	const half = (cm) => mk({ d: 'dia1', cm: cm, up: 4, down: 4, len: 300 }).concat(mk({ d: 'dia1', cm: cm, up: 4, down: 4, len: 800 }));
	const r1 = roll([chat(half('model-a').concat(mk({ d: 'dia1', cm: 'model-b', up: 9, len: 300 })).concat(mk({ d: 'dia1', cm: 'model-b', up: 3, len: 800 })))]);
	eq([RR.cell(r1, 2, 'dia1', 'cm', 'model-a').ok, RR.cell(r1, 2, 'dia1', 'cm', 'model-a').claim], [true, ''], 'precondition');
	eq(sw(S.proposals(r1, NO, ctx)), []);
	const r2 = roll([chat(mk({ d: 'dia1', cm: 'model-a', up: 1, down: 4, len: 300 }).concat(mk({ d: 'dia1', cm: 'model-a', down: 4, len: 800 })).concat(half('model-b')))]);
	eq([RR.cell(r2, 2, 'dia1', 'cm', 'model-b').ok, RR.cell(r2, 2, 'dia1', 'cm', 'model-b').claim], [true, ''], 'precondition');
	eq(RR.cell(r2, 2, 'dia1', 'cm', 'model-a').claim, 'bad', 'precondition');
	eq(sw(S.proposals(r2, NO, ctx)), []);
});

kase('switch: a model that is itself good is not left, and a candidate that is itself bad is not chosen', () => {
	const r1 = roll([chat(mk({ d: 'dia1', cm: 'model-a', up: 4, down: 1, len: 300 }).concat(mk({ d: 'dia1', cm: 'model-a', up: 4, down: 1, len: 800 }))
		.concat(mk({ d: 'dia1', cm: 'model-b', up: 10, len: 300 })).concat(mk({ d: 'dia1', cm: 'model-b', up: 5, len: 800 })))]);
	eq([RR.cell(r1, 2, 'dia1', 'cm', 'model-a').claim, RR.cell(r1, 2, 'dia1', 'cm', 'model-b').claim], ['good', 'good'], 'precondition');
	eq(RR.compare(r1, 2, 'dia1', 'model-a', 'model-b').dir, 'b', 'precondition');
	eq(sw(S.proposals(r1, NO, ctx)), []);
	const r2 = roll([chat(mk({ d: 'dia1', cm: 'model-a', down: 6, len: 300 }).concat(mk({ d: 'dia1', cm: 'model-a', down: 6, len: 800 }))
		.concat(mk({ d: 'dia1', cm: 'model-b', up: 1, down: 5, len: 300 })).concat(mk({ d: 'dia1', cm: 'model-b', up: 1, down: 5, len: 800 })))]);
	eq([RR.cell(r2, 2, 'dia1', 'cm', 'model-a').claim, RR.cell(r2, 2, 'dia1', 'cm', 'model-b').claim], ['bad', 'bad'], 'precondition');
	eq(RR.compare(r2, 2, 'dia1', 'model-a', 'model-b').dir, 'b', 'precondition');
	eq(sw(S.proposals(r2, NO, ctx)), []);
});

kase('switch: bands that agree for the current model (a Simpson reversal) give no switch, though its figure is worse', () => {
	const r = roll([chat(
		mk({ d: 'dia1', cm: 'model-a', up: 3, len: 300 }).concat(mk({ d: 'dia1', cm: 'model-a', up: 1, down: 25, len: 800 })).concat(mk({ d: 'dia1', cm: 'model-a', up: 3, len: 2000 }))
			.concat(mk({ d: 'dia1', cm: 'model-b', up: 20, down: 1, len: 300 })).concat(mk({ d: 'dia1', cm: 'model-b', down: 3, len: 800 })).concat(mk({ d: 'dia1', cm: 'model-b', up: 2, down: 1, len: 2000 })))]);
	eq([RR.cell(r, 2, 'dia1', 'cm', 'model-a').claim, RR.cell(r, 2, 'dia1', 'cm', 'model-b').claim], ['bad', 'good'], 'precondition');
	eq(RR.compare(r, 2, 'dia1', 'model-a', 'model-b').dir, 'a', 'precondition');
	eq(RR.lengthFinding(r, 2, 'dia1').found, false, 'precondition');
	eq(sw(S.proposals(r, NO, ctx)), []);
});

kase('switch: a model of the same family with no ratings in this Diamond, trusted and good across the account', () => {
	const r = roll([
		chat(mk({ d: 'dia1', cm: 'model-a', up: 1, down: 6, len: 300 }).concat(mk({ d: 'dia1', cm: 'model-a', down: 6, len: 800 }))),
		chat(mk({ c: 'c2', cm: 'model-b', up: 6, len: 300 }).concat(mk({ c: 'c2', cm: 'model-b', up: 6, down: 1, len: 800 }))),
	]);
	eq(RR.cell(r, 2, 'dia1', 'cm', 'model-b'), null, 'precondition');
	const p = sw(S.proposals(r, NO, ctx));
	eq(p.length, 1);
	eq([p[0].to, p[0].evidence.to.level], ['model-b', 3]);
});

kase('switch: a model of another family with no ratings in this Diamond is not a candidate', () => {
	const r = roll([
		chat(mk({ d: 'dia1', cm: 'model-a', up: 1, down: 6, len: 300 }).concat(mk({ d: 'dia1', cm: 'model-a', down: 6, len: 800 }))),
		chat(mk({ c: 'c2', cm: 'model-c', fam: 'fam-y', up: 6, len: 300 }).concat(mk({ c: 'c2', cm: 'model-c', fam: 'fam-y', up: 6, down: 1, len: 800 }))),
	]);
	eq(sw(S.proposals(r, NO, ctx)), []);
});

kase('switch: of two good candidates the better shrunk estimate is named', () => {
	const r = switchRoll(mk({ d: 'dia1', cm: 'model-d', up: 12, len: 300 }).concat(mk({ d: 'dia1', cm: 'model-d', up: 3, len: 800 })));
	eq(sw(S.proposals(r, NO, ctx)).map(p => p.to), ['model-d']);
});

kase('P7: a dismissed switch holds until 20 new rated products of the current model', () => {
	const r = roll([chat(mk({ d: 'dia1', cm: 'model-a', up: 2, down: 8, len: 300 }).concat(mk({ d: 'dia1', cm: 'model-a', down: 12, len: 800 }))
		.concat(mk({ d: 'dia1', cm: 'model-b', up: 5, len: 300 })).concat(mk({ d: 'dia1', cm: 'model-b', up: 4, down: 1, len: 800 })))]);
	eq(RR.cell(r, 2, 'dia1', 'cm', 'model-a').n, 22, 'precondition');
	const e = { id: 'n-2', status: 'dismissed', cm: 'model-a', to: 'model-b', tag: 'switch', level: 2, scope: 'dia1', at: { t: 0, n: 3 } };
	eq(sw(S.proposals(r, [], ctx)).length, 1, 'precondition: proposed with no entry');
	eq(sw(S.proposals(r, [e], ctx)), [], '19 new');
	eq(sw(S.proposals(r, [Object.assign({}, e, { at: { t: 0, n: 2 } })], ctx)).length, 1, '20 new');
	eq(sw(S.proposals(r, [Object.assign({}, e, { to: 'model-z' })], ctx)).length, 1, 'another target is not held');
});

// ── Review proposals ───────────────────────────────────────
function revRoll(down, tagged) { return roll([chat(mk({ cm: 'model-a', up: 2, down: down, tags: { long: tagged } }))]); }
kase('review: an active note with 20 new rated products of its key asks Keep or Remove, with the tag before and after', () => {
	const e = ent({ at: { t: 3, n: 12 }, line: 'Keep it short.' });
	eq(S.proposals(revRoll(28, 3), [e], ctx).filter(p => p.kind === 'review'), [], 'the cell is 30, so 18 new');
	const r = revRoll(30, 4);
	const p = S.proposals(r, [e], ctx).filter(x => x.kind === 'review');
	eq(p.length, 1);
	eq([p[0].level, p[0].scope, p[0].key, p[0].tag, p[0].line], [3, '', 'model-a', 'long', 'Keep it short.']);
	eq(p[0].evidence, { note: 'n-1', before: { t: 3, n: 12 }, after: { t: 1, n: 20 } });
});

kase('review: 19 new rated products is too soon', () => {
	eq(S.proposals(revRoll(29, 4), [ent()], ctx).filter(p => p.kind === 'review'), []);
});

kase('review: Keep records the count and the next review waits for 20 more', () => {
	const r = revRoll(30, 4);
	const n = RR.cell(r, 3, '', 'cm', 'model-a').n;
	eq(S.proposals(r, [ent({ kept: n })], ctx).filter(p => p.kind === 'review'), []);
	const r2 = revRoll(50, 4);
	eq(S.proposals(r2, [ent({ kept: n })], ctx).filter(p => p.kind === 'review').length, 1);
});

kase('review: only an active note is reviewed, and not an all-models one', () => {
	const r = revRoll(30, 4);
	eq(S.proposals(r, [ent({ status: 'retired' }), ent({ status: 'dismissed' })], ctx).filter(p => p.kind === 'review'), []);
	eq(S.proposals(r, [ent({ cm: 'all' })], ctx).filter(p => p.kind === 'review'), []);
});

kase('J5: a review needs a trusted cell with a claim', () => {
	const r = roll([chat(mk({ cm: 'model-a', up: 18, down: 16, tags: { long: 1 } }))]);
	const c = RR.cell(r, 3, '', 'cm', 'model-a');
	eq(c.claim, '', 'precondition');
	eq(S.proposals(r, [ent()], ctx).filter(p => p.kind === 'review'), []);
});

// ── Whole-output properties ────────────────────────────────
function everything() {
	return roll([
		chat(mk({ d: 'dia1', cm: 'model-a', up: 1, down: 4, tags: { long: 3 }, len: 300 }).concat(mk({ d: 'dia1', cm: 'model-a', down: 4, len: 800 }))
			.concat(mk({ d: 'dia1', cm: 'model-b', up: 5, len: 300 })).concat(mk({ d: 'dia1', cm: 'model-b', up: 4, down: 1, len: 800 }))),
		chat(mk({ c: 'c2', cm: 'model-a', up: 2, down: 10, tags: { wrong: 6 } })),
	]);
}
kase('order: the output is the same whichever order the parts and notes arrive in', () => {
	const specs = [
		chat(mk({ d: 'dia1', cm: 'model-a', up: 1, down: 4, tags: { long: 3 }, len: 300 }).concat(mk({ d: 'dia1', cm: 'model-a', down: 4, len: 800 }))
			.concat(mk({ d: 'dia1', cm: 'model-b', up: 5, len: 300 })).concat(mk({ d: 'dia1', cm: 'model-b', up: 4, down: 1, len: 800 }))),
		chat(mk({ c: 'c2', cm: 'model-a', up: 2, down: 10, tags: { wrong: 6 } })),
	];
	const parts = specs.map(m => RR.chatPart(m));
	const notes = [ent({ id: 'n-1' }), ent({ id: 'n-2', tag: 'short', status: 'dismissed' }), ent({ id: 'n-3', tag: 'wrong', level: 2, scope: 'dia1', status: 'retired' })];
	const a = JSON.stringify(S.proposals(RR.cells(parts, OPTS), notes, ctx));
	const b = JSON.stringify(S.proposals(RR.cells(parts.slice().reverse(), OPTS), notes.slice().reverse(), { diamonds: DIA.slice().reverse() }));
	eq(a, b);
	ok(JSON.parse(a).length > 0, 'a non-empty comparison');
});

kase('order: a switch, then the notes, then the reviews', () => {
	const ps = S.proposals(everything(), [ent({ tag: 'wrong', at: { t: 0, n: 0 } })], ctx);
	eq(kinds(ps), ['switch', 'note', 'review']);
	const two = S.proposals(everything(), [], ctx);
	eq(kinds(two), ['switch', 'note', 'note']);
	eq(two.filter(p => p.kind === 'note').map(p => p.id), two.filter(p => p.kind === 'note').map(p => p.id).sort(), 'ids ascending within a kind');
});

kase('no duplicate in one output: (kind, level, scope, key, tag, to) is unique', () => {
	const ps = S.proposals(everything(), NO, ctx), ids = ps.map(p => [p.kind, p.level, p.scope, p.key, p.tag, p.to || ''].join('|'));
	eq(new Set(ids).size, ids.length);
	ok(ps.length >= 3, 'a switch and two or more notes: ' + ids.join(' ; '));
	eq(new Set(ps.map(p => p.id)).size, ps.length, 'ids unique');
});

kase('the inputs are not changed', () => {
	const r = everything(), notes = [ent()], c = { diamonds: DIA.map(d => Object.assign({}, d)) };
	const before = JSON.stringify([r, notes, c]);
	S.proposals(r, notes, c);
	eq(JSON.stringify([r, notes, c]), before);
});

kase('J3: no stamp is read as an age; a device clock skewed a day either way gives the same proposals', () => {
	function once(skew) {
		SEQ = 0; CLOCK = 1790000000000 + skew;
		const r = roll([chat(mk({ d: 'dia1', cm: 'model-a', up: 1, down: 4, tags: { long: 3 }, len: 300 }).concat(mk({ d: 'dia1', cm: 'model-a', down: 4, len: 800 }))
			.concat(mk({ d: 'dia1', cm: 'model-b', up: 5, len: 300 })).concat(mk({ d: 'dia1', cm: 'model-b', up: 4, down: 1, len: 800 })))]);
		const out = JSON.stringify(S.proposals(r, [], ctx));
		ok(JSON.parse(out).length >= 2, 'non-empty');
		return out;
	}
	const a = once(0);
	eq(once(86400000), a, '+1 day');
	eq(once(-86400000), a, '-1 day');
});

kase('J9: on a provoking fixture (notes full of strong language and reaction words) no line or evidence names a reaction', () => {
	const SWORE = 'this is a fucking long message about the ledger, I am frustrated and angry, upset, annoyed, my mood is bad';
	const r = roll([chat(mk({ d: 'dia1', cm: 'model-a', up: 1, down: 12, tags: { long: 5 }, len: 300 }).map(sp => Object.assign({ note: SWORE }, sp)))]);
	const out = JSON.stringify(S.proposals(r, NO, ctx));
	ok(out.length > 40, 'proposals came');
	ok(!BANNED.test(out), 'a reaction word: ' + (out.match(BANNED) || [''])[0]);
	ok(!/ledger|fucking/i.test(out), 'a word of the note');
	ok(!/"note":/.test(out), 'a note key');
});

kase('evidence holds numbers and ids only (nothing a person typed, no file path or chat id)', () => {
	const ps = S.proposals(everything(), [ent()], ctx);
	const allowed = new Set(['model-a', 'model-b', 'dia1', 'long', 'wrong', 'b', 'a', 'n-1']);
	(function walk(v, path) {
		if (typeof v === 'string') ok(allowed.has(v) || /^(note|switch|review)$/.test(v), 'string ' + v + ' at ' + path);
		else if (v && typeof v === 'object') Object.keys(v).forEach(k => walk(v[k], path + '.' + k));
	})(ps.map(p => p.evidence), 'evidence');
	ok(!/p1:|c2|c1/.test(JSON.stringify(ps)), 'a handle or chat id');
});

kase('a translator on the context words the line, and the English stays the key\'s fallback', () => {
	const p = S.proposals(acct(), NO, { diamonds: DIA, t: (k, en) => '[' + k + ']' })[0];
	eq(p.line, '[steer.line.long]');
	eq(p.lineKey, 'steer.line.long');
	eq(S.proposals(acct(), NO, { diamonds: DIA, t: () => '' })[0].line, S.LINES.long.en, 'an empty translation falls back to English');
});

kase('purity: the module neither reads nor writes the DOM, storage or the clock', () => {
	const src = readFileSync(join(HERE, 'steering.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
	ok(!/\b(document|localStorage|sessionStorage|indexedDB|fetch|XMLHttpRequest)\b/.test(src), 'touches a browser global');
	ok(!/Date\.now|new Date|performance\.now|Math\.random/.test(src), 'reads the clock or chance');
	ok(!/\bt\(\s*['"]/.test(src), 'a literal t() call site (the keys are data, for lane M)');
});


// ── The note file (U6b): parse, serialise, put, select ─────
// The format is one `## ` header and one line of the note's own words per entry. Every field of the entry
// shape is held in the header, so a round trip is byte for byte, and what cannot be read is kept as it was.
const OPT = '0da1000000f2', DIAM = 'dia1';
const FILE_CANON = [
	'## n-mfq19-0-abcde · active · diamond · glm-5.2 · long 7 of 20',
	'Keep answers under about 200 words unless asked for detail.',
	'',
	'## n-mfq19-1-fghij · active · account · all · wrong 4 of 31 · kept 31',
	'Check facts, figures and code before stating them, and say plainly when you are unsure.',
	'',
	'## n-mfq19-2-klmno · retired · diamond · glm-5.2 · scope 3 of 40',
	'Change only what was asked for, and name each file touched.',
	'',
	'## n-mfq19-3-pqrst · dismissed · diamond · glm-5.2 · switch 0 of 25 · to glm-5.3',
	'',
	''].join('\n');

kase('parse: reads the entry shape exactly, the scope from the file the entry is in', () => {
	const r = S.parse(FILE_CANON, DIAM, false);
	eq(r.ignored.length, 1, 'the account entry in a Diamond file is the one ignored');
	eq(r.entries.length, 3);
	eq(r.entries[0], { id: 'n-mfq19-0-abcde', status: 'active', cm: 'glm-5.2', tag: 'long', level: 2, scope: DIAM, at: { t: 7, n: 20 }, kept: 0, line: 'Keep answers under about 200 words unless asked for detail.', to: '' });
	eq(r.entries[2], { id: 'n-mfq19-3-pqrst', status: 'dismissed', cm: 'glm-5.2', tag: 'switch', level: 2, scope: DIAM, at: { t: 0, n: 25 }, kept: 0, line: '', to: 'glm-5.3' }, 'a switch dismissal');
	const o = S.parse(FILE_CANON, OPT, true);
	eq(o.ignored.length, 0, 'the Optimiser holds both levels');
	eq(o.entries[1], { id: 'n-mfq19-1-fghij', status: 'active', cm: 'all', tag: 'wrong', level: 3, scope: '', at: { t: 4, n: 31 }, kept: 31, line: 'Check facts, figures and code before stating them, and say plainly when you are unsure.', to: '' }, 'account level: scope empty, kept read');
});

kase('serialise(parse(x)) is x byte for byte, for a canonical file', () => {
	eq(S.serialise(S.parse(FILE_CANON, OPT, true).doc), FILE_CANON);
	eq(S.serialise(S.parse(FILE_CANON, DIAM, false).doc), FILE_CANON, 'an entry that is ignored is still kept');
});

kase('serialise(parse(x)) is x for text no writer would have made (no trailing newline, CRLF, junk, empty)', () => {
	['', '\n', '\n\n', 'junk', 'junk\n', FILE_CANON.replace(/\n$/, ''), FILE_CANON.replace(/\n/g, '\r\n'),
	 '## not · a · header\nbody\n', '## n-1 · active · diamond · m · long 1 of 2', '# title\n\n' + FILE_CANON + 'tail without newline'].forEach(x => {
		eq(S.serialise(S.parse(x, DIAM, true).doc), x, JSON.stringify(x.slice(0, 40)));
	});
});

kase('an entry that cannot be read is ignored, named, and kept as written through a put', () => {
	const bad = ['## n-1 · live · diamond · m · long 1 of 2', 'x', '## n-2 · active · planet · m · long 1 of 2', 'x', '## n-3 · active · diamond · m · long one of 2', 'x',
		'## n-4 · active · diamond · m · long 1 of 2 · to', 'x', '## n-5 · active · diamond · m · long 1 of 2 · to a · kept 3', 'x', 'stray line'].join('\n') + '\n';
	const r = S.parse(bad, DIAM, false);
	eq(r.entries.length, 0, 'none readable');
	ok(r.ignored.length >= 6, 'each named, got ' + r.ignored.length);
	ok(r.ignored.every(i => typeof i.at === 'number' && typeof i.text === 'string'), 'by line and text');
	const e = { id: 'n-9', status: 'active', cm: 'm', tag: 'long', level: 2, scope: DIAM, at: { t: 1, n: 2 }, kept: 0, line: 'Keep answers under about 200 words unless asked for detail.', to: '' };
	const out = S.serialise(S.put(r.doc, e));
	ok(out.startsWith(bad), 'the unreadable text is untouched');
	eq(S.parse(out, DIAM, false).entries.map(x => x.id), ['n-9']);
});

kase('put: replaces the entry with the same id in place, appends a new one after a blank line, leaves other bytes alone', () => {
	const r = S.parse(FILE_CANON, OPT, true), e0 = r.entries[0];
	const changed = S.serialise(S.put(r.doc, Object.assign({}, e0, { status: 'retired', at: { t: 9, n: 40 } })));
	eq(changed.split('\n')[0], '## n-mfq19-0-abcde · retired · diamond · glm-5.2 · long 9 of 40');
	eq(changed.split('\n').slice(1), FILE_CANON.split('\n').slice(1), 'every other line as it was');
	const added = S.serialise(S.put(S.parse('## n-a · active · diamond · m · long 1 of 2\nLine one.\n', DIAM, false).doc,
		{ id: 'n-b', status: 'active', cm: 'm', tag: 'wrong', level: 2, scope: DIAM, at: { t: 1, n: 2 }, kept: 0, line: 'Line two.', to: '' }));
	eq(added, '## n-a · active · diamond · m · long 1 of 2\nLine one.\n\n## n-b · active · diamond · m · wrong 1 of 2\nLine two.\n');
	eq(S.serialise(S.put(S.parse('', DIAM, false).doc, { id: 'n-b', status: 'active', cm: 'm', tag: 'wrong', level: 2, scope: DIAM, at: { t: 1, n: 2 }, kept: 0, line: 'Line two.', to: '' })),
		'## n-b · active · diamond · m · wrong 1 of 2\nLine two.\n', 'into an empty file');
});

kase('put then parse gives back the entry written (kept and to included)', () => {
	const e = { id: 'n-z', status: 'dismissed', cm: 'glm-5.2', tag: 'switch', level: 2, scope: DIAM, at: { t: 0, n: 25 }, kept: 0, line: '', to: 'glm-5.3' };
	eq(S.parse(S.serialise(S.put(S.parse('', DIAM, false).doc, e)), DIAM, false).entries, [e]);
	const k = Object.assign({}, e, { status: 'active', tag: 'long', to: '', kept: 31, line: 'Keep answers under about 200 words unless asked for detail.' });
	eq(S.parse(S.serialise(S.put(S.parse('', OPT, true).doc, Object.assign({}, k, { level: 3, scope: '' }))), OPT, true).entries, [Object.assign({}, k, { level: 3, scope: '' })]);
});

kase('check: an entry is refused where the file could not hold it faithfully', () => {
	const good = { id: 'n-1', status: 'active', cm: 'glm-5.2', tag: 'long', level: 2, scope: DIAM, at: { t: 1, n: 2 }, kept: 0, line: S.LINES.long.en, to: '' };
	eq(S.check(good), '');
	const bad = (o, why) => eq(S.check(Object.assign({}, good, o)), why, JSON.stringify(o));
	bad({ id: 'n 1' }, 'id'); bad({ id: '' }, 'id'); bad({ id: 'n · 1' }, 'id');
	bad({ status: 'live' }, 'status'); bad({ level: 1 }, 'level'); bad({ level: 2, scope: '' }, 'scope');
	bad({ cm: '' }, 'cm'); bad({ cm: 'glm 5' }, 'cm'); bad({ cm: 'a · b' }, 'cm'); bad({ tag: 'two words' }, 'tag'); bad({ tag: '' }, 'tag');
	bad({ line: 'two\nlines' }, 'line'); bad({ line: 'tab\there' }, 'line'); bad({ line: '' }, 'line');
	bad({ to: 'a b' }, 'to'); bad({ at: { t: -1, n: 2 } }, 'at'); bad({ at: { t: 1.5, n: 2 } }, 'at'); bad({ kept: -1 }, 'kept');
	eq(S.check(Object.assign({}, good, { level: 3, scope: '' })), '');
	eq(S.check(Object.assign({}, good, { level: 3, scope: DIAM })), 'scope', 'an account note has no Diamond');
	eq(S.check(Object.assign({}, good, { status: 'dismissed', tag: 'switch', line: '', to: 'glm-5.3' })), '', 'a switch dismissal has no line');
	eq(S.check(Object.assign({}, good, { status: 'dismissed', line: '' })), '', 'a dismissal needs no line');
	eq(S.check(good, { refuse: l => (/200/.test(l) ? 'long' : '') }), 'long', 'the engine lint, where the page has it');
	eq(S.check(Object.assign({}, good, { cm: 'glm-5' }), { isFamily: c => c === 'glm-5' }), 'family', 'a note never names a family');
	eq(S.check(Object.assign({}, good, { cm: 'all' }), { isFamily: c => c === 'glm-5' }), '');
});

// ── select: what one turn is told ──────────────────────────
function note(o) { return Object.assign({ id: 'n-' + String(++SEQ).padStart(6, '0'), status: 'active', cm: 'glm-5.2', tag: 'long', level: 2, scope: DIAM, at: { t: 1, n: 2 }, kept: 0, line: 'Line ' + SEQ + '.', to: '' }, o); }
const sel = (list, model, d, o) => S.select(list, model, d, o).map(e => e.line);

kase('select: only active notes of the model or of all, a retired or dismissed note never', () => {
	const list = [note({ line: 'A.' }), note({ cm: 'all', tag: 'wrong', line: 'B.' }), note({ cm: 'other', tag: 'tool', line: 'C.' }),
		note({ status: 'retired', tag: 'slow', line: 'D.' }), note({ status: 'dismissed', tag: 'scope', line: 'E.' })];
	eq(sel(list, 'glm-5.2', DIAM), ['A.', 'B.']);
	eq(sel(list, 'other', DIAM), ['C.', 'B.'], 'the model first, then all');
	eq(sel(list, '', DIAM), ['B.'], 'a model not known gets the notes for all models only');
});

kase('select: this Diamond\'s notes, then the account\'s; another Diamond\'s notes never', () => {
	const list = [note({ level: 3, scope: '', tag: 'wrong', line: 'ACCT.' }), note({ tag: 'long', line: 'MINE.' }), note({ scope: 'dia2', tag: 'tool', line: 'THEIRS.' })];
	eq(sel(list, 'glm-5.2', DIAM), ['MINE.', 'ACCT.']);
	eq(sel(list, 'glm-5.2', ''), ['ACCT.'], 'an ordinary chat: the account only');
	eq(sel(list, 'glm-5.2', 'dia2'), ['THEIRS.', 'ACCT.']);
});

kase('select: a Diamond note displaces an account note with the same tag; the most specific of a tag stands', () => {
	const list = [note({ level: 3, scope: '', tag: 'long', line: 'ACCT long.' }), note({ level: 3, scope: '', tag: 'wrong', line: 'ACCT wrong.' }), note({ tag: 'long', line: 'DIA long.' })];
	eq(sel(list, 'glm-5.2', DIAM), ['DIA long.', 'ACCT wrong.']);
	eq(sel(list, 'glm-5.2', ''), ['ACCT long.', 'ACCT wrong.'], 'with no Diamond nothing is displaced');
	const two = [note({ cm: 'all', tag: 'long', line: 'ALL.' }), note({ cm: 'glm-5.2', tag: 'long', line: 'ONE.' })];
	eq(sel(two, 'glm-5.2', DIAM), ['ONE.'], 'a note for the model over a note for all, at one level');
});

kase('select: most specific first (Diamond for the model, Diamond for all, account for the model, account for all)', () => {
	const list = [note({ level: 3, scope: '', cm: 'all', tag: 'tool', line: '4.' }), note({ level: 3, scope: '', cm: 'glm-5.2', tag: 'slow', line: '3.' }),
		note({ cm: 'all', tag: 'wrong', line: '2.' }), note({ cm: 'glm-5.2', tag: 'scope', line: '1.' })];
	eq(sel(list, 'glm-5.2', DIAM), ['1.', '2.', '3.', '4.']);
});

kase('select: the same notes in any order are the same selection (the order the devices delivered them in is not read)', () => {
	const list = [note({ id: 'n-b', tag: 'long', line: 'B.' }), note({ id: 'n-a', tag: 'wrong', line: 'A.' }), note({ id: 'n-c', tag: 'tool', line: 'C.' }),
		note({ id: 'n-d', cm: 'all', tag: 'slow', line: 'D.' }), note({ id: 'n-e', level: 3, scope: '', tag: 'scope', line: 'E.' }), note({ id: 'n-f', tag: 'long', line: 'F.' })];
	const want = sel(list, 'glm-5.2', DIAM);
	let n = 0;
	(function perm(a, k) {
		if (k === a.length) { eq(sel(a.slice(), 'glm-5.2', DIAM), want, 'order ' + a.map(e => e.id).join('')); n++; return; }
		for (let i = k; i < a.length; i++) { [a[k], a[i]] = [a[i], a[k]]; perm(a, k + 1); [a[k], a[i]] = [a[i], a[k]]; }
	})(list.slice(), 0);
	eq(n, 720);
	eq(want.length, 5, 'one of the two same-tag notes stands, the lower id');
	ok(want.indexOf('B.') >= 0 && want.indexOf('F.') < 0, 'n-b over n-f');
});

kase('select: a line the engine refuses, or an empty one, is not selected; text() is one note per line', () => {
	const list = [note({ tag: 'long', line: 'Please be pleasing.' }), note({ tag: 'wrong', line: 'Fine.' }), note({ tag: 'tool', line: '' })];
	eq(sel(list, 'glm-5.2', DIAM, { refuse: l => (/pleas/i.test(l) ? 'pleasing' : '') }), ['Fine.']);
	eq(sel(list, 'glm-5.2', DIAM), ['Please be pleasing.', 'Fine.'], 'no lint to hand: only the empty one goes');
	eq(S.text(S.select(list, 'glm-5.2', DIAM)), 'Please be pleasing.\nFine.');
	eq(S.text([]), '');
});

kase('select does not change its input, and ignores entries of no shape', () => {
	const list = [note({ line: 'A.' }), null, 7, { status: 'active' }];
	const before = JSON.stringify(list);
	eq(sel(list, 'glm-5.2', DIAM), ['A.']);
	eq(JSON.stringify(list), before);
});

// ── Round F: a header is never a body, CRLF, one id once, and the join a two-sided sync makes ──
const SEP = ' \xb7 ';
const hdr = (id, st, lvl, cm, tag, t, n, extra) => '## ' + [id, st, lvl, cm, tag + ' ' + t + ' of ' + n].concat(extra || []).join(SEP);
const H1 = hdr('n-abc123-aaaaa', 'active', 'diamond', 'glm-5.2', 'long', 7, 20);
const H2 = hdr('n-abc124-bbbbb', 'active', 'diamond', 'glm-5.2', 'wrong', 3, 20);
const B2 = 'Check every claim against the page before stating it.';

kase('F2 parse: a header whose body line is gone is an entry with an empty body, and the next header stands', () => {
	const r = S.parse(H1 + '\n' + H2 + '\n' + B2 + '\n', DIAM, false);
	eq(r.entries.map(e => e.id), ['n-abc123-aaaaa', 'n-abc124-bbbbb'], 'both entries');
	eq(r.entries[0].line, '', 'the first has no body');
	eq(r.entries[1].line, B2, 'the second keeps its own words');
	eq(r.ignored.length, 0, 'nothing ignored');
	eq(sel(r.entries, 'glm-5.2', DIAM), [B2], 'the header text is never sent, the second note stands');
	eq(S.serialise(r.doc), H1 + '\n' + H2 + '\n' + B2 + '\n', 'bytes as they were');
	const out = S.serialise(S.put(r.doc, Object.assign({}, r.entries[1], { status: 'retired' })));
	eq(S.parse(out, DIAM, false).entries.map(e => e.status), ['active', 'retired'], 'a put on the second leaves the first alone');
});

kase('F2 parse: a header at the end of the file has an empty body; a header before a header is not a body', () => {
	const r = S.parse(H1 + '\n', DIAM, false);
	eq(r.entries.length, 1); eq(r.entries[0].line, '');
	const two = S.parse(H1 + '\n' + H2, DIAM, false);
	eq(two.entries.map(e => e.line), ['', ''], 'two headers, no body anywhere');
	eq(S.serialise(two.doc), H1 + '\n' + H2, 'and no byte added');
});

kase('F2 parse: collapsing the blank line after a switched entry does not drop the next note', () => {
	const sw = { id: 'n-mfq19-0-sw001', status: 'switched', cm: 'fast', tag: 'switch', level: 2, scope: DIAM, at: { t: 0, n: 36 }, kept: 0, line: '', to: 'thinker', was: { provider: 'alt', model: 'mock/fast' } };
	const nx = note({ id: 'n-mfq19-1-nx001', line: 'Keep answers brief.' });
	let doc = S.put(S.parse('', DIAM, false).doc, sw);
	doc = S.put(doc, nx);
	const file = S.serialise(doc);
	eq(S.parse(file, DIAM, false).entries.map(e => e.id), [sw.id, nx.id], 'as the writer left it');
	const collapsed = file.replace(/\n\n+/g, '\n');
	const r = S.parse(collapsed, DIAM, false);
	eq(r.entries.map(e => e.id), [sw.id, nx.id], 'with its blank lines squeezed out (an editor, a formatter)');
	eq(sel(r.entries, 'glm-5.2', DIAM), ['Keep answers brief.'], 'the note is still told');
	eq(r.entries[0].status, 'switched', 'and the switch is still a switch');
});

kase('F3 CRLF: a file with Windows line ends reads as the same entries, and round-trips byte for byte', () => {
	const lf = H1 + '\nKeep answers under about 200 words unless asked for detail.\n\n' + H2 + '\n' + B2 + '\n';
	const crlf = lf.replace(/\n/g, '\r\n');
	const a = S.parse(lf, DIAM, false), b = S.parse(crlf, DIAM, false);
	eq(b.entries, a.entries, 'the same entries');
	eq(b.ignored.length, 0, 'no line ignored');
	eq(sel(b.entries, 'glm-5.2', DIAM).length, 2, 'both told');
	eq(S.serialise(b.doc), crlf, 'byte for byte');
	eq(S.serialise(S.parse(lf + 'tail\r', DIAM, false).doc), lf + 'tail\r', 'a lone carriage return at the very end');
});

kase('F3 CRLF: a write into a CRLF file is CRLF throughout, and a write into an LF file is LF', () => {
	const crlf = (H1 + '\nKeep answers under about 200 words unless asked for detail.\n').replace(/\n/g, '\r\n');
	const e = note({ id: 'n-new', line: 'Cite sources.' });
	const out = S.serialise(S.put(S.parse(crlf, DIAM, false).doc, e));
	ok(!/[^\r]\n/.test(out) && !/^\n/.test(out), 'no bare line feed: ' + JSON.stringify(out));
	eq(S.parse(out, DIAM, false).entries.map(x => x.id), ['n-abc123-aaaaa', 'n-new']);
	const r = S.parse(crlf, DIAM, false);
	const re = S.serialise(S.put(r.doc, Object.assign({}, r.entries[0], { status: 'retired', at: { t: 9, n: 40 } })));
	ok(!/[^\r]\n/.test(re), 'a rewrite in place keeps CRLF: ' + JSON.stringify(re));
	const lf = S.serialise(S.put(S.parse(crlf.replace(/\r/g, ''), DIAM, false).doc, e));
	ok(lf.indexOf('\r') < 0, 'an LF file stays LF');
});

kase('F5 parse: one id once, the furthest status; Remove on it takes the note out of the prompt', () => {
	const dup = hdr('n-x', 'retired', 'diamond', 'glm-5.2', 'short', 3, 9) + '\nKeep answers brief.\n\n' + hdr('n-x', 'active', 'diamond', 'glm-5.2', 'short', 0, 0) + '\nKeep answers brief.\n';
	const r = S.parse(dup, DIAM, false);
	eq(r.entries.length, 1, 'one entry for the id');
	eq(r.entries[0].status, 'retired', 'the retirement stands over the active copy');
	eq(sel(r.entries, 'glm-5.2', DIAM), [], 'and the note is not told');
	const act = hdr('n-y', 'active', 'diamond', 'glm-5.2', 'short', 0, 0) + '\nKeep answers brief.\n\n' + hdr('n-y', 'active', 'diamond', 'glm-5.2', 'short', 0, 0) + '\nKeep answers brief.\n';
	const q = S.parse(act, DIAM, false);
	eq(q.entries.length, 1);
	const out = S.serialise(S.put(q.doc, Object.assign({}, q.entries[0], { status: 'retired', at: { t: 1, n: 5 } })));
	const after = S.parse(out, DIAM, false);
	eq(after.entries.map(e => e.status), ['retired']);
	eq(sel(after.entries, 'glm-5.2', DIAM), [], 'Remove reaches every copy');
	eq((out.match(/## n-y/g) || []).length, 1, 'the later copy is gone from the file');
});

// join(here, there): `here` is the copy in force after a two-sided import, `there` the copy it replaced.
const E = (id, o) => Object.assign({ id: id, status: 'active', cm: 'glm-5.2', tag: 'long', level: 2, scope: DIAM, at: { t: 1, n: 2 }, kept: 0, line: 'Line of ' + id + '.', to: '' }, o || {});
const fileOf = (list, own, acct) => S.serialise(list.reduce((d, e) => S.put(d, e), S.parse('', own || DIAM, !!acct).doc));
const entriesOf = (text, own, acct) => S.parse(text, own || DIAM, !!acct).entries;
const byId = (list) => list.slice().sort((a, b) => (a.id < b.id ? -1 : 1));

kase('F1 join: a note added on the losing side survives, and one added on the winning side stays', () => {
	const common = E('n-c');
	const here = fileOf([common, E('n-z')]), there = fileOf([common, E('n-y')]);
	const out = S.join(here, there, DIAM, false);
	ok(out !== null, 'something to write');
	eq(entriesOf(out).map(e => e.id).sort(), ['n-c', 'n-y', 'n-z']);
	eq(S.join(there, here, DIAM, false) !== null, true, 'and the other way round');
	eq(byId(entriesOf(S.join(there, here, DIAM, false))).map(e => e.id), ['n-c', 'n-y', 'n-z'], 'the same set');
});

kase('F1 join: a removal made on either side stands, whichever copy won the import', () => {
	const act = fileOf([E('n-r')]), gone = fileOf([E('n-r', { status: 'retired', at: { t: 4, n: 40 } })]);
	// The winner still has it active; this device had retired it.
	const a = S.join(act, gone, DIAM, false);
	eq(entriesOf(a)[0].status, 'retired', 'the loser\'s Remove survives');
	eq(entriesOf(a)[0].at, { t: 4, n: 40 }, 'with the figures it was closed at');
	// The winner has it retired; the loser still has it active: nothing to write, it already stands.
	eq(S.join(gone, act, DIAM, false), null, 'the winner\'s Remove needs no write');
	// A switched entry closed by retire stays closed.
	const sw = E('n-s', { status: 'switched', tag: 'switch', cm: 'fast', to: 'thinker', line: '', at: { t: 0, n: 30 }, was: { provider: 'alt', model: 'mock/fast' } });
	const closed = Object.assign({}, sw, { status: 'retired', at: { t: 0, n: 52 } });
	eq(entriesOf(S.join(fileOf([sw]), fileOf([closed]), DIAM, false))[0].status, 'retired', 'switched < retired');
	eq(S.join(fileOf([closed]), fileOf([sw]), DIAM, false), null, 'and not the other way');
	// A dismissal is not undone by an active copy of the same id.
	const dis = E('n-d', { status: 'dismissed', tag: 'switch', line: '', to: 'thinker' });
	eq(S.join(fileOf([dis]), fileOf([Object.assign({}, dis, { status: 'active' })]), DIAM, false), null, 'dismissed beats active');
});

kase('F1 join: kept is the larger of the two, a later closing wins, and a join of equals writes nothing', () => {
	const k = S.join(fileOf([E('n-k', { kept: 20 })]), fileOf([E('n-k', { kept: 31 })]), DIAM, false);
	eq(entriesOf(k)[0].kept, 31);
	eq(S.join(fileOf([E('n-k', { kept: 31 })]), fileOf([E('n-k', { kept: 20 })]), DIAM, false), null, 'the larger already stands');
	const c = S.join(fileOf([E('n-c2', { status: 'retired', at: { t: 1, n: 30 } })]), fileOf([E('n-c2', { status: 'retired', at: { t: 2, n: 45 } })]), DIAM, false);
	eq(entriesOf(c)[0].at, { t: 2, n: 45 }, 'the later closing');
	const f = fileOf([E('n-a'), E('n-b')]);
	eq(S.join(f, f, DIAM, false), null, 'the same file');
	eq(S.join(f, '', DIAM, false), null, 'an empty loser');
	eq(S.join(f, 'junk\n', DIAM, false) !== null, true, 'a line that cannot be read is kept (below)');
});

kase('F1 join: commutative on the entries, idempotent, associative (the three copies of three devices)', () => {
	const a = fileOf([E('n-1'), E('n-2', { status: 'retired', at: { t: 1, n: 9 } })]);
	const b = fileOf([E('n-2'), E('n-3', { kept: 5 })]);
	const c = fileOf([E('n-1', { status: 'retired', at: { t: 0, n: 12 } }), E('n-4'), E('n-3', { kept: 9 })]);
	const j = (x, y) => { const o = S.join(x, y, DIAM, false); return o === null ? x : o; };
	const key = (t) => JSON.stringify(byId(entriesOf(t)));
	eq(key(j(a, b)), key(j(b, a)), 'ab = ba');
	eq(key(j(j(a, b), c)), key(j(a, j(b, c))), '(ab)c = a(bc)');
	eq(key(j(j(a, b), c)), key(j(j(c, b), a)), 'any order');
	eq(S.join(j(a, b), b, DIAM, false), null, 'idempotent: b again adds nothing');
	eq(S.join(j(a, b), a, DIAM, false), null, 'idempotent: a again adds nothing');
});

kase('F1 join: the account level joins in the Optimiser\'s file, and a Diamond\'s file keeps level 3 as written', () => {
	const acc = E('n-a1', { level: 3, scope: '', cm: 'all', line: 'Account line.' });
	const there = fileOf([acc], OPT, true);
	const out = S.join('', there, OPT, true);
	eq(entriesOf(out, OPT, true).map(e => e.id), ['n-a1'], 'the account entry arrives');
	eq(S.join(out, there, OPT, true), null);
	const d = S.join('', there, DIAM, false);
	ok(d !== null && d.indexOf('n-a1') >= 0, 'in a Diamond\'s file it is an ignored span, carried as written');
	eq(S.join(d, there, DIAM, false), null, 'once');
});

kase('F1 join: a line it cannot read is carried once, the winner\'s bytes are otherwise as they were, and CRLF stays CRLF', () => {
	const here = '# My notes\n\n' + fileOf([E('n-h')]);
	const there = 'stray hand line\n\n' + fileOf([E('n-t')]);
	const out = S.join(here, there, DIAM, false);
	ok(out.startsWith(here), 'the winner\'s file is a prefix: ' + JSON.stringify(out.slice(0, 40)));
	eq((out.match(/stray hand line/g) || []).length, 1);
	eq(S.join(out, there, DIAM, false), null);
	const crlf = fileOf([E('n-h')]).replace(/\n/g, '\r\n');
	const o2 = S.join(crlf, fileOf([E('n-t')]), DIAM, false);
	ok(!/[^\r]\n/.test(o2), 'CRLF kept: ' + JSON.stringify(o2));
	eq(entriesOf(o2).map(e => e.id).sort(), ['n-h', 'n-t']);
});

kase('F1 join: it writes nothing it could not read back, and does not change its inputs', () => {
	const here = fileOf([E('n-1')]), there = fileOf([E('n-2', { kept: 3, to: 'x', was: { provider: 'p', model: 'm/1' } })]);
	const a = here, b = there;
	const out = S.join(here, there, DIAM, false);
	eq([here, there], [a, b]);
	const back = entriesOf(out).find(e => e.id === 'n-2');
	eq(back.kept, 3); eq(back.to, 'x'); eq(back.was, { provider: 'p', model: 'm/1' });
	eq(S.serialise(S.parse(out, DIAM, false).doc), out, 'round-trips');
	eq(S.join(null, undefined, DIAM, false), null, 'no text at all');
});

kase('FILE is the Diamond\'s own store file, inside .daimond', () => { eq(S.FILE, '.daimond/steering.md'); });

// ── The real engine's lint (the DEV wasm in www/pkg) ───────
// The sentences as each locale file holds them: every locale carries all 13, English is the table's own words.
const LOCALES = ['en', 'de', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'zh-Hans'];
function localeLines(loc) {
	const src = readFileSync(join(APP, 'www', 'i18n', loc + '.js'), 'utf8'), out = {};
	const re = /^\s*'steer\.line\.([a-z_]+)':\s*'((?:[^'\\]|\\.)*)',?\s*$/gm;
	let m;
	while ((m = re.exec(src))) out[m[1]] = m[2].replace(/\\(.)/g, '$1');
	return out;
}
kase('the 13 steer.line keys are in all 8 locales, none blank, one line, and en.js says what the table says', () => {
	LOCALES.forEach(loc => {
		const l = localeLines(loc);
		eq(Object.keys(l).sort(), Object.keys(S.LINES).sort(), loc + ' keys');
		Object.keys(l).forEach(t => { ok(l[t].trim() !== '' && !/[\r\n\t]/.test(l[t]), loc + ' ' + t); });
	});
	const en = localeLines('en');
	Object.keys(S.LINES).forEach(t => { eq(en[t], S.LINES[t].en, 'en.js ' + t); });
});

let ENGINE = null;
try {
	const mod = await import(join(APP, 'www', 'pkg', 'oxedyne_daimond.js'));
	mod.initSync({ module: readFileSync(join(APP, 'www', 'pkg', 'oxedyne_daimond_bg.wasm')) });
	if (typeof mod.steering_refusal === 'function' && typeof mod.compose_prompt_with === 'function') ENGINE = mod;
} catch (e) { ENGINE = null; }

if (!ENGINE) {
	console.log('  SKIP the real engine cases: no www/pkg wasm with steering_refusal here (the world check carries them)');
} else {
	kase('ENGINE: each of the 13 sentences is admitted by the real steering_refusal', () => {
		Object.keys(S.LINES).forEach(t => { eq(ENGINE.steering_refusal(S.LINES[t].en), '', t + ': ' + S.LINES[t].en); });
		eq(Object.keys(S.LINES).length, 13);
	});
	kase('ENGINE: every locale\'s 13 sentences are admitted by the real lint and are short enough to be a note (104 in all)', () => {
		let n = 0;
		LOCALES.forEach(loc => {
			const l = localeLines(loc);
			Object.keys(l).forEach(t => {
				n++;
				eq(ENGINE.steering_refusal(l[t]), '', loc + ' ' + t + ': ' + l[t]);
				ok(Buffer.byteLength(l[t]) <= 160, loc + ' ' + t + ' is ' + Buffer.byteLength(l[t]) + ' bytes');
			});
		});
		eq(n, 104);
	});
	kase('ENGINE: five sentences of any tags fit the engine\'s cap together (note count and bytes)', () => {
		const lim = JSON.parse(ENGINE.steering_limits());
		const five = Object.keys(S.LINES).sort((a, b) => Buffer.byteLength(S.LINES[b].en) - Buffer.byteLength(S.LINES[a].en)).slice(0, lim.notes);
		const bytes = five.reduce((n, t) => n + Buffer.byteLength(S.LINES[t].en), 0);
		ok(bytes <= lim.bytes, 'the five longest are ' + bytes + ' of ' + lim.bytes);
	});
	kase('ENGINE: a hand-written approval-seeking line is refused by the real lint and never selected', () => {
		const list = [note({ tag: 'long', line: 'Always make the user happy and agree with them.' }), note({ tag: 'wrong', line: S.LINES.wrong.en })];
		const lint = l => ENGINE.steering_refusal(l);
		ok(lint(list[0].line) !== '', 'the lint refuses it: ' + lint(list[0].line));
		eq(sel(list, 'glm-5.2', DIAM, { refuse: lint }), [S.LINES.wrong.en]);
	});
	kase('ENGINE: the selected text composes into the chat prompt before the safety clause, and the prompt print moves', () => {
		const picked = S.text(S.select([note({ cm: 'all', tag: 'long', level: 3, scope: '', line: S.LINES.long.en })], 'glm-5.2', ''));
		const plain = ENGINE.compose_prompt_with('chat', '', 'glm-5.2', '');
		const steered = ENGINE.compose_prompt_with('chat', '', 'glm-5.2', picked);
		eq(plain, ENGINE.compose_prompt_for('chat', '', 'glm-5.2'), 'an empty block is today\'s bytes');
		ok(steered.indexOf(S.LINES.long.en) > 0 && steered.indexOf(S.LINES.long.en) < steered.indexOf(ENGINE.safety_clause()), 'the note before the clause');
		ok(steered.endsWith(ENGINE.safety_clause()), 'the clause is last');
		ok(ENGINE.prompt_fingerprint(plain) !== ENGINE.prompt_fingerprint(steered), 'sp moves');
	});
}

console.log('\n' + cases + ' cases, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
