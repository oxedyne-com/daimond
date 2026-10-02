/* ============================================================
   Test -- THE PURE HALF OF RATING U2 (www/js/ratings.js).
   ------------------------------------------------------------
   Plan: ~/usr/code/ai/claude/specs/daimond_rating_u2_plan_20260930.md,
   Unit B. The record's bytes (§2.2, §2.3), the head rule (§2.4), the lit
   state, and the burst state machine that D drives from the page.

   The REAL provenance.js and ratings.js are loaded into a bare `window`
   scope, as immutable.test.mjs loads peer.js. There is no `document`, so a
   DOM or storage read in either file is a ReferenceError here.

   The fixture, dev/fixtures/rating_u2.json, is written once from the
   literal in plan §2.3 and read here; the inputs below are a second copy of
   that literal, so a drift in either shows as a byte difference.
   U4's Rust must parse the same bytes and reproduce them.

   Run:  node www/js/ratings.test.mjs
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', '..');
let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) { console.log('  ok   ' + name); }
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}
function same(name, got, want) {
	const a = JSON.stringify(got), b = JSON.stringify(want);
	check(name, a === b, 'got ' + a + ' want ' + b);
}
function throws(name, fn) {
	let err = null;
	try { fn(); } catch (e) { err = e; }
	check(name, !!err, 'did not throw');
}

function load() {
	const win = {};
	for (const f of ['provenance.js', 'ratings.js']) {
		const body = readFileSync(join(HERE, f), 'utf8');
		new Function('window', body)(win);
	}
	return win;
}

// ── Inputs: a second copy of plan §2.3 ─────────────────────
const P = { h: 'p1:answer:c7/mfq1a-1-xyz12', k: 'answer', m: 'accounts/fireworks/models/glm-5p2', pv: 'fireworks',
	cm: 'glm-5.2', fam: 'glm-5', fi: false, cls: 'open-frontier', role: 'chat', sp: 'sp1:3f9a0c12', d: '', c: 'c7',
	t: 'mfq19-0-abcde', dev: 'd-4f2a', at: 1790000000000, hash: '', run: '' };
const NOTE2 = 'Just give me the command — "no" preamble.\nÉtape 2: ✓';
const INPUTS = [
	{ mid: 'r-mfq1z2k0-a1b2c', ts: 1790000123456,
		o: { prod: P, s: 1, clear: false, tags: [], dims: {}, note: '', src: 'tap', sup: '',
			burst: 'r-mfq1z2k0-a1b2c', tools: '', len: 412 } },
	{ mid: 'r-mfq2a0b1-q9w8e', ts: 1790000200000,
		o: { prod: P, s: -2, clear: false, tags: ['long', 'ignored', 'long'], dims: { correct: 1, followed: 0 },
			note: NOTE2, src: 'popup', sup: 'r-mfq1z2k0-a1b2c', burst: 'r-mfq2a0b1-q9w8e',
			tools: 'file_read>file_edit', len: 412 } },
	{ mid: 'r-mfq2b7c2-z1x2c', ts: 1790000300000,
		o: { prod: P, s: 2, clear: true, tags: ['long'], dims: { style: 3 }, note: 'gone', src: 'tap',
			sup: 'r-mfq2a0b1-q9w8e', burst: 'r-mfq2b7c2-z1x2c', tools: 'file_read>file_edit', len: 412 } },
];

// ── Helpers for the head rule and the burst ────────────────
function prodFor(R, mid) { return Object.assign({}, P, { h: 'p1:answer:c7/' + mid }); }
function mk(R, h, mid, ts, o) {
	o = o || {};
	const rating = R.build({ prod: Object.assign({}, P, { h }), s: o.s === undefined ? 1 : o.s, clear: !!o.clear,
		tags: o.tags || [], dims: o.dims || {}, note: o.note || '', src: o.src || 'tap', sup: o.sup || '',
		burst: mid, tools: '', len: 10 });
	return R.message(rating, mid, ts);
}
const H = (n) => 'p1:answer:c7/m' + n;
function ctxOf(R, n, head) {
	return { head: head || null, prod: Object.assign({}, P, { h: H(n) }), tools: n === 2 ? 'file_read' : '', len: 100 + n, form: 'daimond/1' };
}
function counter() {
	let i = 0;
	return () => { i++; return ('aaa' + i.toString(36)).slice(-5).padStart(5, 'a'); };
}
function mids(msgs) { return msgs.map((m) => m.mid); }

function main() {
	const win = load();
	const R = win.DaimondRatings;
	check('DaimondRatings is attached with no DOM in scope', !!R && typeof R.build === 'function');

	// ── The fixture: both languages build to these bytes ────
	const fixtureText = readFileSync(join(APP, 'dev', 'fixtures', 'rating_u2.json'), 'utf8');
	const fixture = JSON.parse(fixtureText);
	check('the fixture holds three records', Array.isArray(fixture) && fixture.length === 3);
	const built = INPUTS.map((i) => R.build(Object.assign({ form: 'daimond/1' }, i.o)));
	for (let i = 0; i < 3; i++) {
		check('build of input ' + (i + 1) + ' is the fixture rating, byte for byte',
			JSON.stringify(built[i]) === JSON.stringify(fixture[i].rating),
			JSON.stringify(built[i]));
	}
	for (let i = 0; i < 3; i++) {
		check('build of the fixture rating\'s own fields is the same rating again (' + (i + 1) + ')',
			JSON.stringify(R.build(fixture[i].rating)) === JSON.stringify(fixture[i].rating));
	}
	const msgs = INPUTS.map((i, k) => R.message(built[k], i.mid, i.ts));
	for (let i = 0; i < 3; i++) {
		check('message ' + (i + 1) + ' is the fixture message, byte for byte',
			JSON.stringify(msgs[i]) === JSON.stringify(fixture[i]), JSON.stringify(msgs[i]));
	}
	check('the three messages are the fixture file, with no spaces', JSON.stringify(msgs) === fixtureText);
	same('a message has its keys in the declared order', Object.keys(msgs[0]), ['role', 'mid', 'ts', 'rating']);
	same('a rating has its keys in the declared order', Object.keys(built[0]),
		['h', 'hash', 's', 'clear', 'tags', 'dims', 'note', 'form', 'src', 'sup', 'priv', 'hx', 'burst', 'tools', 'len', 'prod']);
	same('dims keys are in the declared order', Object.keys(built[0].dims), ['correct', 'followed', 'length', 'style']);
	check('rating.prod is byte-equal to the product record', JSON.stringify(built[0].prod) === JSON.stringify(P));
	check('rating.prod is a copy, not the message\'s own object', built[0].prod !== P);
	check('a message has no content, so msgSig reads it as length 0', msgs[0].content === undefined);
	check('every fixture record reads as a rating_log', msgs.every(R.isRatingMsg));

	// ── The form ────────────────────────────────────────────
	const fj = readFileSync(join(APP, 'dev', 'fixtures', 'rating_form_daimond1.json'), 'utf8');
	const F = R.form(fj);
	check('form reads the exact string U1\'s wasm returns', F.form === 'daimond/1');
	same('the scale has five steps, -2 to 2', F.scale.map((s) => s.s), [-2, -1, 0, 1, 2]);
	same('the scale words are wrong poor fine good great', F.scale.map((s) => s.id), ['wrong', 'poor', 'fine', 'good', 'great']);
	same('the four dimensions are in form order', F.dims.map((d) => d.id), ['correct', 'followed', 'length', 'style']);
	same('tagsFor answer down, in form order', F.tagsFor('answer', 'down'),
		['wrong', 'ignored', 'long', 'short', 'style', 'tool', 'refused', 'slow']);
	same('tagsFor answer up, in form order', F.tagsFor('answer', 'up'), ['correct', 'followed', 'concise', 'style_good']);
	same('tagsFor file down', F.tagsFor('file', 'down'), ['style', 'broke', 'wrong_change', 'incomplete', 'scope', 'wiped']);
	same('tagsFor a kind with no tags', F.tagsFor('nothing', 'down'), []);
	check('keyOf gives the catalogue key the wasm names', F.keyOf('ignored') === 'rating.tag.ignored');
	check('keyOf a tag the form does not hold still names a key', F.keyOf('mine') === 'rating.tag.mine');
	check('form accepts the parsed object as well as the string', R.form(JSON.parse(fj)).form === 'daimond/1');
	throws('form refuses text that is not the form', () => R.form('{"nope":1}'));

	// ── Ids ─────────────────────────────────────────────────
	const id = R.newId(1790000123456, 'a1b2c');
	check('newId reads r-<ts36>-<five base 36>', id === 'r-' + (1790000123456).toString(36) + '-a1b2c' && /^r-[0-9a-z]+-[0-9a-z]{5}$/.test(id), id);
	check('newId with no random part still mints five characters', /^r-[0-9a-z]+-[0-9a-z]{5}$/.test(R.newId(1790000123456)));
	check('midOf reads the answer mid from a handle', R.midOf('p1:answer:c7/mfq1a-1-xyz12') === 'mfq1a-1-xyz12');
	check('midOf a handle with no slash is empty', R.midOf('p1:answer:c7') === '');

	// ── build refuses ───────────────────────────────────────
	const base = { prod: P, s: 1, src: 'tap', burst: 'r-a-aaaaa', len: 1 };
	throws('build refuses no prod', () => R.build(Object.assign({}, base, { prod: null })));
	throws('build refuses a prod without the handle version', () => R.build(Object.assign({}, base, { prod: Object.assign({}, P, { h: 'answer:c7/x' }) })));
	throws('build refuses a prod with no kind', () => R.build(Object.assign({}, base, { prod: Object.assign({}, P, { k: '' }) })));
	throws('build refuses s above 2', () => R.build(Object.assign({}, base, { s: 3 })));
	throws('build refuses s below -2', () => R.build(Object.assign({}, base, { s: -3 })));
	throws('build refuses a fractional s', () => R.build(Object.assign({}, base, { s: 0.5 })));
	throws('build refuses s that is not a number', () => R.build(Object.assign({}, base, { s: '1' })));
	throws('build refuses a source the form does not name', () => R.build(Object.assign({}, base, { src: 'voice' })));
	check('build accepts the four sources', ['tap', 'popup', 'typed', 'import:cc'].every((src) => !!R.build(Object.assign({}, base, { src }))));

	// ── Normalising ─────────────────────────────────────────
	const n1 = R.build(Object.assign({}, base, { tags: ['zeta', 'alpha', 'zeta', 'Bad Tag', '', 'a'.repeat(33), 'ok_9', 7, null] }));
	same('tags are filtered to valid ids, made unique and sorted', n1.tags, ['alpha', 'ok_9', 'zeta']);
	check('a 32-character tag id is kept', R.build(Object.assign({}, base, { tags: ['a'.repeat(32)] })).tags.length === 1);
	const n2 = R.build(Object.assign({}, base, { dims: { correct: 4, followed: 0, length: 5, style: 2.5 } }));
	same('a dimension out of range, or fractional, is not given', n2.dims, { correct: 4, followed: 0, length: -1, style: -1 });
	same('a dimension of -1 is not given', R.build(Object.assign({}, base, { dims: { correct: -1, followed: -2 } })).dims,
		{ correct: -1, followed: -1, length: -1, style: -1 });
	same('a dimension the form does not hold is left out', Object.keys(R.build(Object.assign({}, base, { dims: { wit: 3 } })).dims),
		['correct', 'followed', 'length', 'style']);
	const bytes = (s) => Buffer.byteLength(s, 'utf8');
	const plain = 'a'.repeat(9000);
	const n3 = R.build(Object.assign({}, base, { note: plain })).note;
	check('a 9000-byte note is cut to 8192 bytes', bytes(n3) === 8192 && plain.startsWith(n3), 'bytes ' + bytes(n3));
	const euro = '€'.repeat(3000);
	const n4 = R.build(Object.assign({}, base, { note: euro })).note;
	check('a three-byte note is cut on a character boundary, under 8192', bytes(n4) === 8190 && n4 === '€'.repeat(2730), 'bytes ' + bytes(n4));
	const emo = '😀'.repeat(3000);
	const n5 = R.build(Object.assign({}, base, { note: emo })).note;
	check('a four-byte note is cut without splitting a pair', bytes(n5) === 8192 && Array.from(n5).length === 2048 && n5 === emo.slice(0, 4096), 'bytes ' + bytes(n5));
	check('a note inside the limit is kept verbatim', R.build(Object.assign({}, base, { note: NOTE2 })).note === NOTE2);
	check('a note of exactly 8192 bytes is kept whole', R.build(Object.assign({}, base, { note: 'b'.repeat(8192) })).note.length === 8192);
	const nc = R.build(Object.assign({}, base, { s: 2, clear: true, tags: ['long'], dims: { correct: 3 }, note: 'words' }));
	check('clear forces s 0, no tags, no dimensions and no note',
		nc.clear === true && nc.s === 0 && nc.tags.length === 0 && nc.note === ''
		&& Object.values(nc.dims).every((v) => v === -1));
	check('a rating that is not cleared says clear false', n1.clear === false && n1.priv === false && n1.hx === 'daimond');
	check('len is a whole number of at least zero', R.build(Object.assign({}, base, { len: -5 })).len === 0 && R.build(Object.assign({}, base, { len: 3.9 })).len === 3);
	check('tools, sup and burst are strings', typeof n1.tools === 'string' && n1.sup === '' && n1.burst === 'r-a-aaaaa');

	// ── isRatingMsg ─────────────────────────────────────────
	check('isRatingMsg refuses a user message', !R.isRatingMsg({ role: 'user', mid: 'u1', ts: 1, content: 'hi' }));
	check('isRatingMsg refuses null', !R.isRatingMsg(null));
	check('isRatingMsg refuses a rating_log with no rating', !R.isRatingMsg({ role: 'rating_log', mid: 'r-a-aaaaa', ts: 1 }));
	check('isRatingMsg refuses a score out of range', !R.isRatingMsg(Object.assign({}, msgs[0], { rating: Object.assign({}, built[0], { s: 9 }) })));
	check('isRatingMsg refuses a form from a later build', !R.isRatingMsg(Object.assign({}, msgs[0], { rating: Object.assign({}, built[0], { form: 'daimond/2' }) })));
	check('isRatingMsg reads a minor version of the form', R.isRatingMsg(Object.assign({}, msgs[0], { rating: Object.assign({}, built[0], { form: 'daimond/1.3' }) })));
	check('isRatingMsg refuses a rating with no mid', !R.isRatingMsg(Object.assign({}, msgs[0], { mid: '' })));
	check('isRatingMsg refuses a record with no product', !R.isRatingMsg(Object.assign({}, msgs[0], { rating: Object.assign({}, built[0], { prod: null }) })));

	// ── The head rule (§2.4) ────────────────────────────────
	const a1 = mk(R, H(1), 'r-m1-aaaaa', 1000);
	const a2 = mk(R, H(1), 'r-m2-aaaaa', 2000, { s: -1, sup: 'r-m1-aaaaa' });
	const a3 = mk(R, H(1), 'r-m3-aaaaa', 3000, { s: 2, sup: 'r-m2-aaaaa' });
	check('a single record is the head', R.head([a1], H(1)) === a1);
	check('a chain: the last in the chain is the head', R.head([a1, a2, a3], H(1)) === a3);
	check('a chain in any order gives the same head', R.head([a3, a1, a2], H(1)) === a3 && R.head([a2, a3, a1], H(1)) === a3);
	const f1 = mk(R, H(2), 'r-f1-aaaaa', 5000);
	const f2 = mk(R, H(2), 'r-f2-aaaaa', 5001, { s: -1 });
	check('a fork is broken by ts, the greater winning', R.head([f1, f2], H(2)) === f2 && R.head([f2, f1], H(2)) === f2);
	const e1 = mk(R, H(3), 'r-e-aaaab', 7000);
	const e2 = mk(R, H(3), 'r-e-aaaaa', 7000, { s: -1 });
	check('equal ts is broken by mid, compared as a string', R.head([e1, e2], H(3)) === e1 && R.head([e2, e1], H(3)) === e1);
	const s1 = mk(R, H(4), 'r-s1-aaaaa', 1000);
	const s2 = mk(R, H(4), 'r-s2-aaaaa', 500, { s: -1, sup: 'r-s1-aaaaa' });
	check('a record made after seeing another wins at any clock skew', R.head([s1, s2], H(4)) === s2);
	const g1 = mk(R, H(5), 'r-g1-aaaaa', 1000);
	const g2 = mk(R, H(5), 'r-g2-aaaaa', 2000, { s: -1, sup: 'r-gone-aaaaa' });
	check('a sup naming a missing record drops nothing', R.head([g1, g2], H(5)) === g2);
	const g3 = mk(R, H(5), 'r-g3-aaaaa', 500, { s: 2, sup: 'r-gone-aaaaa' });
	check('a sup naming a missing record leaves the order to (ts, mid)', R.head([g1, g3], H(5)) === g1);
	const c1 = mk(R, H(6), 'r-c1-aaaaa', 1000);
	const c2 = mk(R, H(6), 'r-c2-aaaaa', 2000, { s: 0, clear: true, sup: 'r-c1-aaaaa' });
	check('a cleared head reads as unrated', R.head([c1, c2], H(6)) === null);
	check('headRaw still names the clear record, for the next sup', R.headRaw([c1, c2], H(6)) === c2);
	check('a rating made after a clear can beat it', R.head([c1, c2, mk(R, H(6), 'r-c3-aaaaa', 3000, { sup: 'r-c2-aaaaa' })], H(6)).mid === 'r-c3-aaaaa');
	check('another handle\'s records are not counted', R.head([a1, f1], H(2)) === f1 && R.head([a1], H(2)) === null);
	check('a product with no records has no head', R.head([], H(1)) === null && R.head(null, H(1)) === null);
	const junk = [{ role: 'rating_log', mid: 'r-x-aaaaa', ts: 9999 }, { role: 'rating_log', mid: 'r-y-aaaaa', ts: 9999, rating: { h: H(1), s: 9 } },
		{ role: 'user', mid: 'u1', ts: 1 }, null, { role: 'assistant', mid: 'm1', ts: 2, content: 'x' }];
	check('a malformed record is ignored by the head', R.head([a1].concat(junk), H(1)) === a1);
	check('a malformed record is ignored by the index', R.index(junk).size === 0);
	const wrongS = mk(R, H(1), 'r-w-aaaaa', 9000);
	wrongS.rating.s = 5;
	check('a record from a build that scores differently is not counted', R.head([a1, wrongS], H(1)) === a1);
	// A record that names itself supersedes nothing.
	const self = mk(R, H(7), 'r-self-aaaaa', 1000, { sup: 'r-self-aaaaa' });
	check('a record naming itself is still the head', R.head([self], H(7)) === self);

	// ── The index ───────────────────────────────────────────
	const many = [];
	let seed = 7, n = 0;
	const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
	const lastOf = {};
	for (let i = 0; i < 200; i++) {
		if (i % 10 === 5) {
			const hh = H(1 + Math.floor(rnd() * 6));
			const prev = lastOf[hh];
			const mid = 'r-i' + (n++).toString(36) + '-' + 'q1w2e';
			const clear = rnd() < 0.2;
			const m = mk(R, hh, mid, 100000 + i * 10, { s: clear ? 0 : Math.floor(rnd() * 5) - 2, clear, sup: rnd() < 0.7 && prev ? prev : '' });
			lastOf[hh] = mid;
			many.push(m);
		} else {
			many.push({ role: i % 2 ? 'user' : 'assistant', mid: 'x' + i, ts: 100000 + i * 10, content: 'line ' + i });
		}
	}
	check('the transcript holds 200 messages and 20 ratings', many.length === 200 && many.filter(R.isRatingMsg).length === 20);
	const handles = [1, 2, 3, 4, 5, 6, 7].map(H);
	const idx = R.index(many);
	check('index equals the per-handle head', handles.every((h) => (idx.has(h) ? idx.get(h) : null) === R.head(many, h)));
	check('index holds a handle only when it has a record', handles.every((h) => idx.has(h) === !!R.headRaw(many, h)));
	// Appending a burst leaves a fresh derivation equal to the per-handle one.
	const b = R.createBurst();
	R.tap(b, ctxOf(R, 1, R.headRaw(many, H(1))), H(1), -1, 1000);
	R.tap(b, ctxOf(R, 2, R.headRaw(many, H(2))), H(2), 1, 1001);
	const grown = many.concat(R.take(b, 2000, counter()));
	const idx2 = R.index(grown);
	check('after take\'s messages, index equals the per-handle head', handles.every((h) => (idx2.has(h) ? idx2.get(h) : null) === R.head(grown, h)));
	check('after take\'s messages, stateOf agrees with the index', handles.every((h) => R.stateOf(grown, null, h).head === (idx2.get(h) || null)));
	check('the earlier messages are untouched by an append', many.every((m, i) => grown[i] === m));

	// ── stateOf ─────────────────────────────────────────────
	const none = R.stateOf([], null, H(1));
	same('no records: nothing lit', [none.lit, none.s, none.detail, none.pending, none.head], ['', 0, false, false, null]);
	const up1 = mk(R, H(1), 'r-u1-aaaaa', 1000, { s: 1 });
	let st = R.stateOf([up1], null, H(1));
	same('a head of +1 lights up, with no detail', [st.lit, st.s, st.detail, st.pending], ['up', 1, false, false]);
	check('stateOf names its head', st.head === up1);
	const down2 = mk(R, H(1), 'r-d2-aaaaa', 2000, { s: -2, sup: 'r-u1-aaaaa' });
	st = R.stateOf([up1, down2], null, H(1));
	same('a head of -2 lights down, and is detail', [st.lit, st.s, st.detail], ['down', -2, true]);
	st = R.stateOf([mk(R, H(1), 'r-fi-aaaaa', 1000, { s: 0 })], null, H(1));
	same('a head of 0 that is not cleared lights nothing, and is detail', [st.lit, st.s, st.detail], ['', 0, true]);
	st = R.stateOf([mk(R, H(1), 'r-tg-aaaaa', 1000, { s: -1, tags: ['long'] })], null, H(1));
	same('a bare -1 with a tag is detail', [st.lit, st.detail], ['down', true]);
	st = R.stateOf([mk(R, H(1), 'r-dm-aaaaa', 1000, { s: 1, dims: { style: 0 } })], null, H(1));
	check('a +1 with a dimension is detail', st.lit === 'up' && st.detail === true);
	st = R.stateOf([mk(R, H(1), 'r-nt-aaaaa', 1000, { s: 1, note: 'ta' })], null, H(1));
	check('a +1 with words is detail', st.lit === 'up' && st.detail === true);
	st = R.stateOf([c1, c2], null, H(6));
	same('a cleared head lights nothing and is not detail', [st.lit, st.s, st.detail, st.head], ['', 0, false, null]);
	// A draft takes precedence over the head.
	const bs = R.createBurst();
	R.tap(bs, ctxOf(R, 1, up1), H(1), -1, 5000);
	st = R.stateOf([up1], bs, H(1));
	same('a draft down over a head up shows down and pending', [st.lit, st.s, st.pending, st.head], ['down', -1, true, up1]);
	same('another handle is not affected by the draft', R.stateOf([up1], bs, H(2)).pending, false);
	R.tap(bs, ctxOf(R, 1, up1), H(1), -1, 5100);
	st = R.stateOf([up1], bs, H(1));
	same('a withdrawing draft lights nothing, with no detail', [st.lit, st.s, st.detail, st.pending], ['', 0, false, true]);
	R.setDraft(bs, H(1), { s: -2, tags: ['wrong'], note: 'x' }, ctxOf(R, 1, up1), 5200);
	st = R.stateOf([up1], bs, H(1));
	same('a popup draft of -2 with a tag is detail', [st.lit, st.s, st.detail], ['down', -2, true]);

	// ── The burst ───────────────────────────────────────────
	let bu = R.createBurst();
	check('a new burst is empty and not due', R.due(bu, 999999, false) === false);
	R.tap(bu, ctxOf(R, 1), H(1), 1, 1000);
	let out = R.take(bu, 5000, counter());
	check('a tap up with no head makes one +1 record', out.length === 1 && out[0].rating.s === 1 && out[0].rating.src === 'tap' && out[0].rating.sup === '');
	check('the record carries the context taken at the tap', out[0].rating.tools === '' && out[0].rating.len === 101 && out[0].rating.h === H(1)
		&& JSON.stringify(out[0].rating.prod) === JSON.stringify(Object.assign({}, P, { h: H(1) })));
	check('the record is a rating_log at the commit time', out[0].role === 'rating_log' && out[0].ts === 5000 && R.isRatingMsg(out[0]));
	check('its burst is its own mid', out[0].rating.burst === out[0].mid);
	check('take empties the burst', R.take(bu, 6000, counter()).length === 0 && !R.stateOf([], bu, H(1)).pending);

	// Withdraw, with no head: the draft is dropped.
	bu = R.createBurst();
	R.tap(bu, ctxOf(R, 1), H(1), 1, 1000);
	R.tap(bu, ctxOf(R, 1), H(1), 1, 1100);
	check('a second tap on the lit arrow with no head drops the draft', R.take(bu, 3000, counter()).length === 0);
	// Withdraw, with a head: a clear record naming it.
	bu = R.createBurst();
	R.tap(bu, ctxOf(R, 1, up1), H(1), 1, 1000);
	out = R.take(bu, 3000, counter());
	check('a tap on the arrow the head lights withdraws with a clear record',
		out.length === 1 && out[0].rating.clear === true && out[0].rating.s === 0 && out[0].rating.sup === 'r-u1-aaaaa', JSON.stringify(out));
	check('a clear record has no tags, dimensions or words', out[0].rating.tags.length === 0 && out[0].rating.note === '' && out[0].rating.dims.correct === -1);
	// Withdraw replaces any draft.
	bu = R.createBurst();
	R.tap(bu, ctxOf(R, 1, up1), H(1), -1, 1000);
	R.toggleTag(bu, H(1), 'long', 1100);
	R.tap(bu, ctxOf(R, 1, up1), H(1), -1, 1200);
	out = R.take(bu, 3000, counter());
	check('a withdraw over a draft replaces it with a clear', out.length === 1 && out[0].rating.clear === true && out[0].rating.tags.length === 0);
	// A flip inside one burst gives one record.
	bu = R.createBurst();
	R.tap(bu, ctxOf(R, 1), H(1), 1, 1000);
	R.tap(bu, ctxOf(R, 1), H(1), -1, 1100);
	out = R.take(bu, 3000, counter());
	check('up then down in one burst is one record, -1', out.length === 1 && out[0].rating.s === -1 && out[0].rating.src === 'tap');
	// Tags reset when the side changes; dims and the note are kept.
	bu = R.createBurst();
	R.setDraft(bu, H(1), { s: -2, tags: ['long', 'wrong'], dims: { correct: 1 }, note: 'why' }, ctxOf(R, 1), 1000);
	R.tap(bu, ctxOf(R, 1), H(1), 1, 1100);
	out = R.take(bu, 3000, counter());
	check('a flip drops the tags and keeps the dimensions and the words',
		out.length === 1 && out[0].rating.s === 1 && out[0].rating.tags.length === 0
		&& out[0].rating.dims.correct === 1 && out[0].rating.note === 'why' && out[0].rating.src === 'tap', JSON.stringify(out[0] && out[0].rating));
	// A tap on the same side keeps the tags.
	bu = R.createBurst();
	R.tap(bu, ctxOf(R, 1), H(1), -1, 1000);
	R.toggleTag(bu, H(1), 'long', 1100);
	R.toggleTag(bu, H(1), 'slow', 1200);
	R.toggleTag(bu, H(1), 'long', 1300);
	out = R.take(bu, 3000, counter());
	same('a toggle adds a tag and a second toggle removes it', out[0].rating.tags, ['slow']);
	// A tag with no draft does nothing.
	bu = R.createBurst();
	check('toggleTag with no draft says so', R.toggleTag(bu, H(1), 'long', 1000) === false);
	check('toggleTag with no draft makes no draft', R.take(bu, 3000, counter()).length === 0 && R.due(bu, 999999, false) === false);
	R.tap(bu, ctxOf(R, 1, up1), H(1), 1, 1000);
	R.toggleTag(bu, H(1), 'long', 1100);
	out = R.take(bu, 3000, counter());
	check('toggleTag on a clear draft is ignored', out.length === 1 && out[0].rating.clear === true && out[0].rating.tags.length === 0);

	// due
	bu = R.createBurst();
	R.tap(bu, ctxOf(R, 1), H(1), 1, 1000);
	check('due is false before 10 s', R.due(bu, 10999, false) === false);
	check('due is true at 10 s of quiet', R.due(bu, 11000, false) === true);
	check('due is true after 10 s', R.due(bu, 60000, false) === true);
	check('due is false while a turn is in flight, however long', R.due(bu, 60000, true) === false);
	R.toggleTag(bu, H(1), 'long', 9000);
	check('a toggle restarts the quiet', R.due(bu, 11000, false) === false && R.due(bu, 19000, false) === true);
	R.setDraft(bu, H(1), { s: 1 }, null, 15000);
	check('a popup change restarts the quiet', R.due(bu, 19000, false) === false && R.due(bu, 25000, false) === true);
	R.tap(bu, ctxOf(R, 2), H(2), 1, 24000);
	check('a tap on another product restarts the quiet for the whole burst', R.due(bu, 25000, false) === false && R.due(bu, 34000, false) === true);

	// take: one ts, one burst, first-touched order, skips a draft equal to its head, carries sup.
	bu = R.createBurst();
	const h2head = mk(R, H(2), 'r-hh2-aaaaa', 500, { s: 1 });
	R.tap(bu, ctxOf(R, 2, h2head), H(2), -1, 1000);				// touched first, then flipped back
	R.tap(bu, ctxOf(R, 3), H(3), -1, 1001);
	R.tap(bu, ctxOf(R, 4, up1), H(4), -1, 1002);
	R.tap(bu, ctxOf(R, 2, h2head), H(2), 1, 1003);					// equal to its head again
	R.tap(bu, ctxOf(R, 5), H(5), 1, 1004);
	out = R.take(bu, 9000, counter());
	same('take skips a draft equal to its head, in first-touched order', out.map((m) => m.rating.h), [H(3), H(4), H(5)]);
	check('every record in a burst has the same ts', out.every((m) => m.ts === 9000));
	check('every record names the first record\'s id as its burst', out.every((m) => m.rating.burst === out[0].mid));
	check('the ids in a burst are all different', new Set(mids(out)).size === 3);
	check('a draft over a head carries that head\'s mid as sup', out[1].rating.sup === 'r-u1-aaaaa' && out[0].rating.sup === '');
	check('the burst is empty after take', R.take(bu, 9500, counter()).length === 0);
	// A constant random part cannot make two ids alike.
	bu = R.createBurst();
	R.tap(bu, ctxOf(R, 1), H(1), 1, 1000);
	R.tap(bu, ctxOf(R, 2), H(2), 1, 1001);
	R.tap(bu, ctxOf(R, 3), H(3), 1, 1002);
	out = R.take(bu, 9000, () => 'zzzzz');
	check('ids in a burst stay distinct under a constant random source', new Set(mids(out)).size === 3);
	check('ids in a burst ascend under a constant random source too', mids(out).every((m, i, a) => !i || a[i - 1] < m), mids(out).join(' '));
	// A merge orders one ts by mid, so a burst's ids must ascend in the order its lines were made.
	const inOrder = (msgs) => msgs.map((m) => m.rating.h);
	const byMerge = (msgs) => msgs.slice().sort((a, b) => a.ts - b.ts || (a.mid < b.mid ? -1 : a.mid > b.mid ? 1 : 0));
	bu = R.createBurst();
	[1, 2, 3, 4].forEach((n) => R.tap(bu, ctxOf(R, n), H(n), 1, 1000 + n));
	let down = 0.9;
	out = R.take(bu, 9000, () => { down -= 0.2; return down; });		// a random source that falls
	same('a burst made with falling random parts is still in first-touched order', inOrder(out), [H(1), H(2), H(3), H(4)]);
	same('a merge by (ts, mid) keeps the lines in the order they were made', inOrder(byMerge(out.slice().reverse())), inOrder(out));
	check('a burst\'s ids ascend in the order made', mids(out).every((m, i, a) => !i || a[i - 1] < m), mids(out).join(' '));
	check('a burst\'s ids still read as rating ids', mids(out).every((m) => /^r-[0-9a-z]+-[0-9a-z]{5}$/.test(m)), mids(out).join(' '));
	let swapped = 0;
	for (let k = 0; k < 200; k++) {
		bu = R.createBurst();
		[1, 2, 3, 4, 5].forEach((n) => R.tap(bu, ctxOf(R, n), H(n), 1, 1000 + n));
		out = R.take(bu, 9000 + k);
		if (JSON.stringify(inOrder(byMerge(out.slice().reverse()))) !== JSON.stringify(inOrder(out)) || new Set(mids(out)).size !== 5) swapped++;
	}
	check('200 bursts with the real random source never swap a line after a merge', swapped === 0, swapped + ' swapped');
	check('every taken message reads as a rating_log', out.every(R.isRatingMsg));
	// The context is taken when the draft is first made.
	bu = R.createBurst();
	R.tap(bu, ctxOf(R, 1, up1), H(1), -1, 1000);
	R.toggleTag(bu, H(1), 'long', 1100);
	R.tap(bu, ctxOf(R, 1, down2), H(1), -1, 1200);
	out = R.take(bu, 3000, counter());
	check('the first context stands: sup is the head at the first tap', out[0].rating.sup === 'r-u1-aaaaa');
	// setDraft.
	bu = R.createBurst();
	throws('setDraft with no draft and no context throws', () => R.setDraft(bu, H(1), { s: 1 }, null, 1000));
	R.setDraft(bu, H(1), { s: -2, tags: ['wrong'], dims: { style: 2 }, note: 'said' }, ctxOf(R, 1), 1000);
	out = R.take(bu, 3000, counter());
	check('setDraft marks the record as from the popup', out.length === 1 && out[0].rating.src === 'popup' && out[0].rating.s === -2
		&& out[0].rating.note === 'said' && out[0].rating.dims.style === 2);
	bu = R.createBurst();
	R.tap(bu, ctxOf(R, 1), H(1), 1, 1000);
	R.setDraft(bu, H(1), { s: -1, tags: ['slow'] }, null, 1100);
	out = R.take(bu, 3000, counter());
	check('setDraft replaces the draft rather than merging into it', out.length === 1 && out[0].rating.s === -1 && out[0].rating.tags[0] === 'slow' && out[0].rating.src === 'popup');
	bu = R.createBurst();
	R.setDraft(bu, H(1), { clear: true }, ctxOf(R, 1), 1000);
	check('a clear draft over no head writes nothing', R.take(bu, 3000, counter()).length === 0);
	bu = R.createBurst();
	R.setDraft(bu, H(1), { clear: true }, ctxOf(R, 1, up1), 1000);
	out = R.take(bu, 3000, counter());
	check('a clear draft over a head withdraws it', out.length === 1 && out[0].rating.clear === true && out[0].rating.sup === 'r-u1-aaaaa');
	bu = R.createBurst();
	R.setDraft(bu, H(1), { s: 1 }, ctxOf(R, 1, up1), 1000);
	check('a popup draft equal to its head writes nothing', R.take(bu, 3000, counter()).length === 0);
	bu = R.createBurst();
	R.setDraft(bu, H(1), { s: 1, tags: [], dims: {}, note: 'more' }, ctxOf(R, 1, up1), 1000);
	check('a popup draft that adds words to its head is written', R.take(bu, 3000, counter()).length === 1);
	// Cleared head: a new rating names the clear record.
	bu = R.createBurst();
	R.tap(bu, ctxOf(R, 6, c2), H(6), 1, 1000);
	out = R.take(bu, 3000, counter());
	check('a rating made over a cleared head names the clear record as sup', out.length === 1 && out[0].rating.sup === 'r-c2-aaaaa' && out[0].rating.clear === false);

	// ── toolsOf ─────────────────────────────────────────────
	const turn = [
		{ role: 'user', mid: 'u1', content: 'go' },
		{ role: 'tool_log', mid: 't1', name: 'file_read' }, { role: 'tool_log', mid: 't2', name: 'file_read' },
		{ role: 'tool_log', mid: 't3', name: 'file_edit' },
		{ role: 'assistant', mid: 'm1', content: 'done' },
		{ role: 'tool_log', mid: 't4', name: 'run' },
	];
	check('toolsOf joins the collapsed tool path with >', R.toolsOf(turn, { t: 'u1' }, 'm1') === 'file_read>file_edit');
	check('toolsOf is empty for a turn with no tools', R.toolsOf([{ role: 'user', mid: 'u2' }, { role: 'assistant', mid: 'm2' }], { t: 'u2' }, 'm2') === '');
	check('toolsOf is empty for a turn that is not there', R.toolsOf(turn, { t: 'nope' }, 'm1') === '');

	// ── lineOf ──────────────────────────────────────────────
	let ln = R.lineOf(msgs[1], { mid: 'mfq1a-1-xyz12' });
	same('lineOf: a score of -2 is drawn with a true minus', ln.score, '−2');
	same('lineOf: the record\'s tags, words and target', [ln.tags, ln.said, ln.targetMid, ln.cleared], [['ignored', 'long'], NOTE2, 'mfq1a-1-xyz12', false]);
	ln = R.lineOf(msgs[0], { mid: 'mfq1a-1-xyz12' });
	same('lineOf: a score of +1 carries a plus sign', ln.score, '+1');
	ln = R.lineOf(mk(R, H(1), 'r-z0-aaaaa', 1, { s: 0 }), { mid: 'x' });
	same('lineOf: a score of 0 is a bare 0', ln.score, '0');
	ln = R.lineOf(msgs[2], { mid: 'mfq1a-1-xyz12' });
	check('lineOf: a cleared record is cleared, with no figure', ln.cleared === true && ln.score === '' && ln.tags.length === 0 && ln.said === '');
	ln = R.lineOf(msgs[0], null);
	check('lineOf: a rated message that has gone has no target', ln.targetMid === null && ln.score === '+1');


	// ── File products (U3, P1a) ─────────────────────────────
	const FH = (st, v, path) => 'p1:file:' + st + '/v' + v + '/' + path;
	const FP = (h, extra) => Object.assign({}, P, { h, k: 'file', role: 'daimon', d: 'd-thesis', hash: 'ab'.repeat(32), run: '', via: '' }, extra || {});
	same('fileOf reads a Diamond file handle', R.fileOf(FH('d-thesis', 4, 'code/parse.rs')), { store: 'd-thesis', v: 4, path: 'code/parse.rs' });
	same('fileOf reads a chat store handle, the colon in the store and the slashes in the path', R.fileOf(FH('chat:c7', 12, 'notes/v2/a b.md')),
		{ store: 'chat:c7', v: 12, path: 'notes/v2/a b.md' });
	check('fileOf is null for an answer handle, a malformed one and nothing', R.fileOf(H(1)) === null && R.fileOf('p1:file:d-thesis/code/x') === null
		&& R.fileOf('p1:file:d-thesis/v4/') === null && R.fileOf('') === null && R.fileOf(undefined) === null);
	check('isFile says which handles are files', R.isFile(FH('d-thesis', 4, 'a.md')) && !R.isFile(H(1)) && !R.isFile(''));
	const frate = R.build({ prod: FP(FH('d-thesis', 4, 'a.md')), s: -1, tags: ['scope'], src: 'tap', burst: 'r-z0-aaaaa', tools: 'file_read>file_edit', len: 412, form: 'daimond/1' });
	check('build of a file product has tools empty and len 0, whatever it is given (D6)', frate.tools === '' && frate.len === 0, JSON.stringify([frate.tools, frate.len]));
	check('build of a file product takes its hash from the record', frate.hash === 'ab'.repeat(32) && frate.h === FH('d-thesis', 4, 'a.md') && frate.prod.hash === frate.hash);
	check('build of a gone file (hash empty) rates with hash empty', R.build({ prod: FP(FH('d-thesis', 4, 'g.md'), { hash: '' }), s: 1, src: 'tap', burst: 'r-z0-aaaaa' }).hash === '');
	check('build of an answer still takes its tools and len', R.build({ prod: P, s: 1, src: 'tap', tools: 'file_read', len: 7 }).tools === 'file_read'
		&& R.build({ prod: P, s: 1, src: 'tap', tools: 'file_read', len: 7 }).len === 7);
	check('a file rating keeps via in its copy of the product', R.build({ prod: FP(FH('chat:c7', 2, 'n.md'), { via: 'command' }), s: 1, src: 'tap' }).prod.via === 'command');
	// A head per file handle, withdrawing, and a burst across an answer and a file.
	const fa = FH('d-thesis', 4, 'a.md'), fb = FH('d-thesis', 4, 'b.md');
	const fmk = (h, mid, ts, o) => { o = o || {}; return R.message(R.build({ prod: FP(h), s: o.s === undefined ? 1 : o.s, clear: !!o.clear, tags: o.tags || [], src: o.src || 'tap', sup: o.sup || '', burst: mid }), mid, ts); };
	const fms = [fmk(fa, 'r-z0-aaaaa', 1000), fmk(fb, 'r-z0-bbbbb', 1001, { s: -1, tags: ['scope'] }), fmk(fa, 'r-z0-ccccc', 1002, { s: -1, sup: 'r-z0-aaaaa' })];
	const fidx = R.index(fms);
	check('a head per file handle: a file row is rated apart from its neighbour', fidx.get(fa).mid === 'r-z0-ccccc' && fidx.get(fb).mid === 'r-z0-bbbbb' && fidx.size === 2);
	same('stateOf is by handle, so a file row lights from its own head', [R.stateOf(fms, null, fa).lit, R.stateOf(fms, null, fb).lit, R.stateOf(fms, null, fb).detail], ['down', 'down', true]);
	const fwd = fms.concat([fmk(fa, 'r-z0-ddddd', 1003, { clear: true, sup: 'r-z0-ccccc' })]);
	check('withdrawing a file rating clears its head and leaves the neighbour', R.index(fwd).get(fa) === null && R.index(fwd).get(fb).mid === 'r-z0-bbbbb' && R.stateOf(fwd, null, fa).lit === '');
	const bfile = R.createBurst();
	const ans = { head: null, prod: Object.assign({}, P, { h: H(5) }), tools: 'file_read', len: 55, form: 'daimond/1' };
	const fctx = { head: null, prod: FP(fa), tools: '', len: 0, form: 'daimond/1' };
	R.tap(bfile, ans, H(5), 1, 100); R.tap(bfile, fctx, fa, -1, 101); R.toggleTag(bfile, fa, 'scope', 102);
	const bmsgs = R.take(bfile, 5000, counter());
	check('a burst across an answer and a file writes two messages sharing one burst', bmsgs.length === 2 && bmsgs[0].rating.burst === bmsgs[1].rating.burst && bmsgs[0].rating.burst === bmsgs[0].mid
		&& bmsgs[0].rating.h === H(5) && bmsgs[1].rating.h === fa, JSON.stringify(bmsgs.map((m) => [m.rating.h, m.rating.burst])));
	check('and the file one has tools empty, len 0 and its tag, the answer one its tools and len', bmsgs[1].rating.tools === '' && bmsgs[1].rating.len === 0
		&& bmsgs[1].rating.tags.join() === 'scope' && bmsgs[0].rating.tools === 'file_read' && bmsgs[0].rating.len === 55);
	// lineOf for a file.
	const fline = R.lineOf(fms[1], { h: fb });
	check('lineOf names a file rating by its path, with the row as the target', fline.kind === 'file' && fline.path === 'b.md' && fline.targetH === fb && fline.targetMid === null && fline.score === '−1', JSON.stringify(fline));
	check('lineOf for a file whose row has gone has no target but still the path', R.lineOf(fms[1], null).targetH === null && R.lineOf(fms[1], null).path === 'b.md');
	check('lineOf for an answer is unchanged in kind', R.lineOf(msgs[0], { mid: 'x' }).kind === 'answer' && R.lineOf(msgs[0], { mid: 'x' }).path === '' && R.lineOf(msgs[0], { mid: 'x' }).targetH === null);
	// The U3 fixture: a file-row rating, a files_log and a user message carrying `pre`.
	const u3Text = readFileSync(join(APP, 'dev', 'fixtures', 'rating_u3.json'), 'utf8'), u3 = JSON.parse(u3Text);
	check('the U3 fixture holds a rating_log, a files_log and a user message', u3.length === 3 && u3[0].role === 'rating_log' && u3[1].role === 'files_log' && u3[2].role === 'user');
	const M3 = { m: 'accounts/fireworks/models/glm-5p2', pv: 'fireworks', cm: 'glm-5.2', fam: 'glm-5', fi: false, cls: 'open-frontier', sp: 'sp1:3f9a0c12', dev: 'd-4f2a', run: '' };
	const rec3 = (o) => Object.assign({}, { h: '', k: 'file' }, { m: M3.m, pv: M3.pv, cm: M3.cm, fam: M3.fam, fi: M3.fi, cls: M3.cls, role: o.role, sp: M3.sp, d: o.d, c: o.c, t: o.t, dev: M3.dev, at: o.at, hash: o.hash, run: '', via: o.via }, { h: o.h });
	const G1 = rec3({ h: FH('d-thesis', 4, 'code/parse.rs'), role: 'daimon', d: 'd-thesis', c: 'c9', t: 'mfq3a-0-fghij', at: 1790000400000, hash: 'ab'.repeat(32), via: '' });
	const G2 = rec3({ h: FH('chat:c7', 2, 'n.md'), role: 'chat', d: '', c: 'c7', t: 'mfq3b-0-klmno', at: 1790000500000, hash: 'cd'.repeat(32), via: 'command' });
	const G3 = rec3({ h: FH('chat:c7', 2, 'o.md'), role: 'chat', d: '', c: 'c7', t: 'mfq3b-0-klmno', at: 1790000500000, hash: 'ef'.repeat(32), via: '' });
	const NOTE3 = 'Only touch parse.rs, not "lex.rs".\nÉtape 2: ✓';
	const u3rate = R.message(R.build({ prod: G1, s: -1, tags: ['scope'], note: NOTE3, src: 'popup', burst: 'r-mfq3c0d1-s1t2u', tools: '', len: 0 }), 'r-mfq3c0d1-s1t2u', 1790000600000);
	check('build of the fixture\'s file-row rating is its bytes, byte for byte', JSON.stringify(u3rate) === JSON.stringify(u3[0]), JSON.stringify(u3rate).slice(0, 200));
	check('the fixture\'s files_log records are the v2 shape, via last, one by a command and one by a file tool',
		JSON.stringify(u3[1].prod) === JSON.stringify([G2, G3]) && u3[1].prod.every((p) => Object.keys(p).pop() === 'via') && u3[1].prod[0].via === 'command' && u3[1].prod[1].via === '');
	check('the fixture\'s files_log has no content and its message keys are in the declared order, delta last', Object.keys(u3[1]).join() === 'role,mid,ts,prod,delta');
	check('its delta is { h, add, del } for rows of the same message\'s prod, whole numbers, once each, as the page\'s turnFileProds writes it',
		Array.isArray(u3[1].delta) && u3[1].delta.length === 2 && u3[1].delta.every((d) => Object.keys(d).join() === 'h,add,del' && Number.isInteger(d.add) && d.add >= 0 && Number.isInteger(d.del) && d.del >= 0 && u3[1].prod.some((p) => p.h === d.h && p.hash))
		&& new Set(u3[1].delta.map((d) => d.h)).size === u3[1].delta.length, JSON.stringify(u3[1].delta));
	check('the fixture\'s user message keeps pre apart from content', Object.keys(u3[2]).join() === 'role,content,mid,ts,pre' && u3[2].content === 'Now fix the lexer.' && u3[2].pre.indexOf('[Daimond: ') === 0);
	check('the three messages are the fixture file, with no spaces', JSON.stringify([u3rate, u3[1], u3[2]]) === u3Text);
	check('only the rating_log is a rating to this build (the other two are read by nothing here)', R.isRatingMsg(u3[0]) && !R.isRatingMsg(u3[1]) && !R.isRatingMsg(u3[2]));
	check('a v2 prod rated by this build is carried whole', JSON.stringify(u3[0].rating.prod) === JSON.stringify(G1));

	// ── noteFor (U4, P2a): the note on the person's next message ─────────
	{
		const hh = (ts) => new Date(ts).toISOString().slice(11, 16);		// UTC, so the test does not depend on the zone
		const B = Date.UTC(2026, 9, 2, 10, 0, 0);
		const U = (mid, ts, extra) => Object.assign({ role: 'user', content: 'say ' + mid, mid, ts }, extra || {});
		const A = (n, ts) => ({ role: 'assistant', content: 'answer ' + n, mid: 'm' + n, ts });
		const rate = (n, mid, ts, o) => mk(win.DaimondRatings, H(n), mid, ts, o);
		const NF = R.noteFor || (() => '<noteFor missing>'), TW = R.tagWord || (() => '<tagWord missing>');
		const note = (msgs) => NF(msgs, { hhmm: hh });
		check('noteFor is exported', typeof R.noteFor === 'function');
		const T = (m, mm) => B + (m * 60 + (mm || 0)) * 1000;
		// the plan's own example (section 2): words verbatim, tags by their English words, one withdrawal clause
		const FILE = 'p1:file:D1/v2/diamonds/D1/src/parse.rs';
		const mkf = (h, mid, ts, o) => R.message(R.build({ prod: FP(h), s: o.s === undefined ? 1 : o.s, clear: !!o.clear, tags: o.tags || [], dims: {}, note: o.note || '', src: 'tap', sup: o.sup || '', burst: mid, tools: '', len: 0 }), mid, ts);
		const ex = [U('u0', T(0)), A(1, T(1)), A(2, T(2)), rate(2, 'r-before', T(2, 30), { s: 1 }), U('u1', T(3)),
			rate(1, 'r-aaaa1', T(4), { s: -1, tags: ['long'], note: 'just give me the command' }),
			mkf(FILE, 'r-aaaa2', T(4, 1), { s: -1, tags: ['scope'] }),
			rate(2, 'r-aaaa4', T(4, 2), { clear: true, sup: 'r-before' })];
		same('noteFor: the plan example, a rating with words, a file, and a withdrawal of one the model already heard of',
			note(ex),
			'[Daimond: the user rated your answer of 10:01 −1 (Too long): "just give me the command". They rated the change to diamonds/D1/src/parse.rs −1 (Changed too much). They withdrew their rating of your answer of 10:02.]');
		// since the last person's message only
		const m1 = [U('u1', T(0)), A(1, T(1)), rate(1, 'r-b1', T(2), { s: 1 }), U('u2', T(3)), A(2, T(4)), rate(2, 'r-b2', T(5), { s: -1, tags: ['tool'] })];
		check('noteFor: only ratings made after the last user message are in it', /answer of 10:04/.test(note(m1)) && !/answer of 10:01/.test(note(m1)), note(m1));
		same('noteFor: nothing after the last user message is nothing', note(m1.slice(0, 5)), '');
		same('noteFor: no ratings, no messages, junk', [note([]), NF(null), NF(undefined), note([U('u1', T(0))])], ['', '', '', '']);
		// heads only
		const m2 = [U('u1', T(0)), A(1, T(1)), rate(1, 'r-c1', T(2), { s: -1, tags: ['long'] }), rate(1, 'r-c2', T(3), { s: 1, sup: 'r-c1' })];
		same('noteFor: a product rated twice is told once, by its head', note(m2), '[Daimond: the user rated your answer of 10:01 +1.]');
		// a withdrawal
		const m3 = [U('u1', T(0)), A(1, T(1)), rate(1, 'r-d1', T(2), { s: 1 }), U('u2', T(3)), rate(1, 'r-d2', T(4), { clear: true, sup: 'r-d1' })];
		same('noteFor: a withdrawal of a rating the model already heard of is told', note(m3), '[Daimond: the user withdrew their rating of your answer of 10:01.]');
		const m4 = [U('u1', T(0)), A(1, T(1)), rate(1, 'r-e1', T(2), { s: 1 }), rate(1, 'r-e2', T(3), { clear: true, sup: 'r-e1' })];
		same('noteFor: a rating given and withdrawn before any note says nothing', note(m4), '');
		// an app note (the tail note of a turn, user-role with records) is not the person's message
		const tail = U('u9', T(2), { content: '[Daimond: this turn changed 1 file (v2): diamonds/D1/a.md]', prod: [FP(FILE)] });
		const m5 = [U('u1', T(0)), A(1, T(1)), rate(1, 'r-f1', T(1, 30), { s: 1 }), tail, rate(2, 'r-f2', T(3), { s: -1 })];
		check('noteFor: a rating made before the turn\'s own tail note still counts (the note is not a person\'s message)', /answer of 10:01 \+1/.test(note(m5)), note(m5));
		// words verbatim: quotes, a newline, a non-Latin script
		const words = 'He said "no".\nÉtape 2: ✓ 日本語 — done';
		const m6 = [U('u1', T(0)), A(1, T(1)), rate(1, 'r-g1', T(2), { s: -2, tags: ['wrong', 'ignored'], note: words })];
		same('noteFor: the person\'s words go in verbatim, tags in English', note(m6), '[Daimond: the user rated your answer of 10:01 −2 (Ignored instructions, Wrong): "' + words + '".]');
		// the 16 KiB bound: newest kept, older heads summarised
		const big = 'x'.repeat(R.NOTE_MAX - 8);
		const m7 = [U('u1', T(0))];
		for (let i = 1; i <= 6; i++) { m7.push(A(i, T(1, i))); m7.push(rate(i, 'r-h' + i, T(2, i), { s: -1, note: big + i })); }
		const n7 = note(m7), bytes = Buffer.byteLength(n7, 'utf8');
		check('noteFor: at most 16 KiB', bytes <= 16384 && bytes > 8000, bytes + ' bytes');
		check('noteFor: the newest ratings are kept, the oldest summarised by a count', n7.includes(big + '6') && !n7.includes(big + '1') && /And \d+ earlier ratings? in this chat\.\]$/.test(n7), n7.slice(-70));
		const cnt = Number((n7.match(/And (\d+) earlier rating/) || [])[1]), kept = [1, 2, 3, 4, 5, 6].filter((i) => n7.includes(big + i)).length;
		check('noteFor: kept plus summarised is all six', kept + cnt === 6 && cnt >= 4, kept + ' kept, ' + cnt + ' summarised');
		// nothing from another chat: a chat is its own messages
		const chatA = [U('u1', T(0)), A(1, T(1)), rate(1, 'r-i1', T(2), { s: -1 })], chatB = [U('u1', T(0)), A(1, T(1))];
		same('noteFor: a chat with no ratings of its own has no note, whatever another chat holds', [note(chatA) !== '', note(chatB)], [true, '']);
		// a rating of a product that has gone from the chat still has words ("an earlier answer")
		const m8 = [U('u1', T(0)), rate(7, 'r-j1', T(2), { s: 1 })];
		same('noteFor: a rated answer no longer in the chat is "an earlier answer"', note(m8), '[Daimond: the user rated an earlier answer +1.]');
		// An app-made user record (a trigger, a preset, a gather-round instruction, the Continue nudge) is marked `app` at
		// creation, and it is no boundary: a rating made before such a turn is told on the person's next message, once.
		const ap = (mid, ts) => U(mid, ts, { app: true });
		const m9 = [U('u1', T(0)), A(1, T(1)), rate(1, 'r-k1', T(2), { s: -1, tags: ['long'] }), ap('p1', T(3)), A(2, T(4))];
		same('noteFor: a rating made before an app-made record (a preset between) is told on the person\'s next message',
			note(m9), '[Daimond: the user rated your answer of 10:01 −1 (Too long).]');
		same('noteFor: an older record with no mark reads as the person\'s, so the same rating is not told',
			note([U('u1', T(0)), A(1, T(1)), rate(1, 'r-k1', T(2), { s: -1, tags: ['long'] }), U('p1', T(3)), A(2, T(4))]), '');
		same('noteFor: only the boolean true marks a record (a string, a number or false is the person\'s)',
			[true, 'yes', 1, false, null].map((v) => note([U('u1', T(0)), A(1, T(1)), rate(1, 'r-k1', T(2), { s: -1 }), U('p1', T(3), { app: v })])),
			['[Daimond: the user rated your answer of 10:01 −1.]', '', '', '', '']);
		same('noteFor: told once: after the person\'s own message (which took the note) nothing more is told',
			note(m9.concat([U('u2', T(5), { pre: note(m9) })])), '');
		same('noteFor: a rating made after the app-made record is told with the one before it',
			note(m9.concat([rate(2, 'r-k2', T(5), { s: 1 })])), '[Daimond: the user rated your answer of 10:01 −1 (Too long). They rated your answer of 10:04 +1.]');
		same('noteFor: several app-made records in a row are all skipped',
			note([U('u1', T(0)), A(1, T(1)), rate(1, 'r-k1', T(2), { s: 1 }), ap('p1', T(3)), A(2, T(4)), ap('p2', T(5)), A(3, T(6)), ap('p3', T(7))]),
			'[Daimond: the user rated your answer of 10:01 +1.]');
		same('noteFor: a chat of app-made records alone has no person\'s message, so everything rated is told',
			note([ap('p1', T(0)), A(1, T(1)), rate(1, 'r-k1', T(2), { s: 1 })]), '[Daimond: the user rated your answer of 10:01 +1.]');
		// the English words are the catalogue's own (a drift here means a label was renamed)
		const en = readFileSync(join(APP, 'www', 'i18n', 'en.js'), 'utf8');
		const labels = {}; for (const m of en.matchAll(/'rating\.tag\.([a-z_]+)':\s*'([^']*)'/g)) labels[m[1]] = m[2];
		check('noteFor: its English tag words are the catalogue\'s, all ' + Object.keys(labels).length, Object.keys(labels).length >= 28 && Object.keys(labels).every((k) => TW(k) === labels[k]), Object.keys(labels).filter((k) => TW(k) !== labels[k]).join(','));
		check('noteFor: an unknown tag from a newer form is named by its id', TW('brand_new') === 'brand_new');
	}

	console.log(failures ? ('\nFAIL — ' + failures + '/' + checks + ' checks') : '\nALL PASS — ' + checks + ' checks');
	if (failures) process.exitCode = 1;
}

import('node:test').then(({ test }) => {
	test(fileURLToPath(import.meta.url), main);
}).catch(() => { main(); });
