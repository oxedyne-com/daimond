/* ============================================================
   Test -- THE ACCOUNT INDEX, THE DIGEST'S RATINGS SECTION AND THE IMPORT OF THE OLD COUNTS
   (www/js/daimond.js, "The ratings of the whole account (Rating U5b)"; unit U5b of 5.3.2).
   ------------------------------------------------------------
   Plan: ~/usr/code/ai/claude/specs/daimond_optimiser_532_plan_20261004.md, §5 U5b; invariants J1
   (no rating written, edited or moved), J2 (the index is a pure function of the transcripts:
   nothing stored, a cold rebuild equals the warm memo), J4 (no free text in the digest).
   Ruling O4: the old Models-page counts are imported once, kept apart, and their key removed.

   `daimond.js` is an ES module over the compiled wasm, so it cannot be run here (see
   collectheap.test.mjs). The functions are LIFTED out of the file's own text through
   dev/syncprobe.mjs, with what they reach declared: `ratingsAccount`, `ratingsDigest`,
   `ratingsDigestSoon`, `importModelCounts`, `writeUsageDigest` and the declarations they
   name run as written; the REAL provenance.js, ratings.js and ratingroll.js are loaded beside
   them. Only the store is stand-in, and the stand-in is a Proxy that refuses every call but the
   two reads and the two waits the walk is allowed (so a write, a save or a resident load is a
   FAIL, not a silence).

   Each check is proven able to fail:

     node www/js/ratingsaccount.test.mjs --break nomemo     # every pass reads every chat
     node www/js/ratingsaccount.test.mjs --break keyseed    # the memo key is the seed alone
     node www/js/ratingsaccount.test.mjs --break resident   # a resident chat is read from the store
     node www/js/ratingsaccount.test.mjs --break nodrop     # a deleted chat stays in the memo
     node www/js/ratingsaccount.test.mjs --break noagain    # a caller that arrives mid-pass is not served a fresh one
     node www/js/ratingsaccount.test.mjs --break keepkey    # the old key stays after the import
     node www/js/ratingsaccount.test.mjs --break mixed      # the old counts are added into the figures
     node www/js/ratingsaccount.test.mjs --break notail     # the digest drops the Ratings section
     node www/js/ratingsaccount.test.mjs --break before1st  # the closing block is written before the Ratings section
     node www/js/ratingsaccount.test.mjs --break notimer    # a burst of ratings never writes the digest
     node www/js/ratingsaccount.test.mjs                    # and then, clean
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeWindow, loadScript, liftSource, canon } from '../../dev/syncprobe.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', '..');

let failures = 0, cases = 0, bad = null;
function ok(cond, detail) { if (!cond && !bad) bad = detail || 'assertion'; }
function eq(got, want, what) {
	const a = JSON.stringify(got), b = JSON.stringify(want);
	if (a !== b && !bad) bad = (what || 'value') + ': got ' + a + ' want ' + b;
}
async function kase(name, fn) {
	cases++; bad = null;
	try { await fn(); } catch (e) { if (!bad) bad = 'threw ' + (e && e.message); }
	if (bad) { failures++; console.log('  FAIL ' + name + '  (' + bad + ')'); }
	else { console.log('  ok   ' + name); }
}

const BREAK = (() => { const i = process.argv.indexOf('--break'); return i >= 0 ? (process.argv[i + 1] || '') : ''; })();
const KNOWN = ['nomemo', 'keyseed', 'resident', 'nodrop', 'noagain', 'keepkey', 'mixed', 'notail', 'before1st', 'notimer'];
if (BREAK && !KNOWN.includes(BREAK)) { console.error('unknown break ' + JSON.stringify(BREAK) + '; known: ' + KNOWN.join(', ')); process.exit(2); }

/// Each break patches the lifted source and must match exactly once, or the run exits 2, so a
/// refactor cannot leave a break that damages nothing.
function patch(src) {
	function swap(needle, to) {
		const n = src.split(needle).length - 1;
		if (n !== 1) { console.error('break ' + BREAK + ': target matched ' + n + ' times, not once: ' + needle); process.exit(2); }
		src = src.replace(needle, to);
	}
	if (BREAK === 'nomemo')   swap('if (hit && hit.key === key) {', 'if (false) {');
	if (BREAK === 'keyseed')  swap("sum.seed + '|' + (sum.msgCount | 0) + '|' + (sum.standing || '')", 'sum.seed');
	if (BREAK === 'resident') swap('if (held && held._loaded && Array.isArray(held.messages)) {', 'if (false) {');
	if (BREAK === 'nodrop')   swap('Array.from(_ratingsMemo.keys()).forEach(function (id) { if (!live[id]) _ratingsMemo.delete(id); });', '');
	if (BREAK === 'noagain')  swap('do { _ratingsAgain = false; out = await ratingsWalk(); } while (_ratingsAgain);', 'out = await ratingsWalk();');
	if (BREAK === 'keepkey')  swap('try { localStorage.removeItem(MODEL_COUNTS_KEY); }', 'try { }');
	if (BREAK === 'mixed') {
		swap('var form = rateForm();', "var form = rateForm();\n\t\ttry { DaimondRatingRoll.legacy(localStorage.getItem(MODEL_COUNTS_KEY)).forEach(function (r) { for (var k = 0; k < r.up + r.down; k++) parts.push({ heads: [Object.assign({}, MIXED.heads[0], { cm: r.model, h: 'old' + r.model + k, mid: 'old' + k, s: k < r.up ? 1 : -1 })], made: [] }); }); } catch (e) { /* none */ }");
	}
	if (BREAK === 'notail')   swap("String(md).replace(/\\s+$/, '') + '\\n' + tail", "String(md).replace(/\\s+$/, '') + '\\n'");
	if (BREAK === 'before1st') {
		swap("out += '\\n' + DaimondRatingRoll.digestText(acct.roll,", "out += '\\n' + (await Wasm.store_read(USAGE_DIR + '/models-before.md').catch(function () { return ''; })) + DaimondRatingRoll.digestText(acct.roll,");
	}
	if (BREAK === 'notimer')  swap('_ratingsTimer = setTimeout(function () {', '_ratingsTimer = 0; (function () { return; }, function () {');
	return src;
}

// ── The page, as far as the lifted code reaches ────────────
const NAMES = ['ratingsKey', 'ratingsWalk', 'ratingsAccount', 'ratingsDigest', 'ratingsDigestSoon', 'importModelCounts', 'writeUsageDigest',
	'_ratingsMemo', 'MODEL_COUNTS_KEY'];
const STUBS = ['ChatStore', 'storedChats', 'chats', 'rateForm', 'diamonds', 'Wasm', 'steerRaise'];
const FORM = JSON.parse(readFileSync(join(APP, 'dev', 'fixtures', 'rating_form_daimond1.json'), 'utf8'));

function hashOf(s) { let h = 7; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h.toString(36); }

/// A page: its window with the real modules, a store that holds chats and refuses all but the reads
/// the walk may make, a chats list, a Wasm file store, and the lifted functions over them.
function page(o) {
	o = o || {};
	const timers = [];
	const win = makeWindow({ now: 1_790_000_000_000, extra: {
		setTimeout: (f, ms) => { timers.push({ f, ms, live: true }); return timers.length; },
		clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].live = false; },
	} });
	['provenance.js', 'ratings.js', 'ratingroll.js'].forEach((f) => loadScript(win, f));
	win.DaimondSignals = { digest: () => '# Usage\n\nturns: 3\n' };

	const disk = new Map();					// chat id -> { messages }
	const calls = [];						// every call the walk made into the store
	const files = new Map();				// the OPFS store the digest and the import write
	const fileWrites = [];
	const st = { order: null, hook: null, failWrite: false, formOk: true, tweak: {}, raised: 0 };
	const rows = () => (st.order || Array.from(disk.keys())).filter((id) => disk.has(id));
	const sum = (id) => {
		const m = disk.get(id).messages;
		return Object.assign({ id: id, seed: disk.get(id).noSeed ? '' : 's' + m.length + ':' + hashOf(JSON.stringify(m)), msgCount: m.length, standing: 'p0f0i0', messages: [], _loaded: false }, st.tweak[id] || {});
	};
	const store = new Proxy({
		booted: async () => { calls.push('booted'); },
		settled: async () => { calls.push('settled'); },
		// The walk reads through `readMessages` (no heal); `loadMessages` is not here, so a walk that calls it throws
		// below (round F, Opus A F4: the healing reader rewrote chunks and cleared a summary's fp).
		readMessages: async (id) => {
			calls.push('load:' + id);
			await Promise.resolve();
			if (st.hook) st.hook(id);
			const r = disk.get(id);
			return { messages: r ? JSON.parse(JSON.stringify(r.messages)) : [], session: null };
		},
	}, { get: (t, k) => (k in t ? t[k] : () => { throw new Error('ChatStore.' + String(k) + ' called: the walk may only read'); }) });
	const chats = [];
	const wasm = {
		store_write: async (p, t) => { if (st.failWrite) throw new Error('no store'); fileWrites.push(p); files.set(p, t); },
		store_read: async (p) => { if (!files.has(p)) throw new Error('absent'); return files.get(p); },
	};
	const diamonds = [{ id: 'D1', name: 'Thesis' }, { id: 'D2', name: 'Notes' }];
	const stub = {
		ChatStore: store, storedChats: () => rows().map(sum), chats: chats,
		rateForm: () => (st.formOk ? { tags: FORM.tags } : null), diamonds: diamonds, Wasm: wasm, steerRaise: () => { st.raised++; },
	};
	let src = liftSource(NAMES, STUBS).src;
	src = patch(src);
	const sk = Object.keys(stub);
	const body = 'with (window) { return (function (' + sk.join(', ') + ', MIXED) {\n' + src + '\nreturn { ' + NAMES.join(', ') + ' };\n}).apply(null, stubs); }';
	const MIXED = { heads: [Object.assign(headOf('legacy-model', 0, 1), { cm: 'glm-5.2' })], made: [] };
	const fns = new Function('window', 'stubs', body)(win, sk.map((k) => stub[k]).concat([MIXED]));
	return { win, disk, calls, files, fileWrites, st, chats, stub, fns, timers, R: win.DaimondRatings, RR: win.DaimondRatingRoll,
		put(id, messages, extra) { disk.set(id, Object.assign({ messages }, extra || {})); },
		loads() { return calls.filter((c) => c.startsWith('load:')).map((c) => c.slice(5)); },
		clearCalls() { calls.length = 0; } };
}

function headOf(cm, i, s) {
	return { h: 'p1:answer:cx/' + cm + i, mid: cm + i, ts: 1000 + i, s: s, tags: [], dims: { correct: -1, followed: -1, length: -1, style: -1 }, len: 300, via: '',
		cm: cm, fam: 'fam', cls: 'frontier', role: 'chat', pv: 'pv', d: '', c: 'cx' };
}

// ── Builders: answers and their ratings, as the transcripts hold them ──
const BASE = { h: '', k: 'answer', m: 'accounts/fireworks/models/glm-5p2', pv: 'fireworks', cm: 'glm-5.2', fam: 'glm-5', fi: false,
	cls: 'open-frontier', role: 'chat', sp: 'sp1:3f9a0c12', d: '', c: 'c1', t: 'mfq19-0-abcde', dev: 'd-4f2a', at: 1790000000000,
	hash: '', run: '', via: '' };
let CLOCK = 1790000000000, SEQ = 0;
const tick = () => { CLOCK += 1000; SEQ++; return CLOCK; };
function prodOf(c, d, cm, fam) {
	const mid = 'a' + (++SEQ) + c;
	return { mid, prod: Object.assign({}, BASE, { h: 'p1:answer:' + c + '/' + mid, c: c, d: d || '', cm: cm, fam: fam || 'fam-x', cls: 'frontier' }) };
}
function answer(p) { return { role: 'assistant', mid: p.mid, ts: tick(), content: 'an answer', prod: [p.prod] }; }
function rate(R, p, s, o) {
	o = o || {};
	const ts = tick();
	const rec = R.build({ prod: p.prod, s: s, clear: o.clear === true, tags: o.tags || [], dims: {}, note: o.note || '', src: 'tap', sup: o.sup || '', burst: '', tools: '', len: 300 });
	return R.message(rec, 'r-' + ts.toString(36) + '-' + String(SEQ).padStart(5, '0'), ts);
}
/// The seeded account: four chats, two Diamonds, two models, a superseded and a cleared rating.
///   c1 (D1, model-a): four up.                                   c2 (D2, model-b): two up, one down.
///   c3 (no Diamond, model-a): P1 up then superseded down, P2 up then cleared, P3 down.      c4: empty.
function seed(pg) {
	const R = pg.R, out = {};
	const c1 = []; for (let i = 0; i < 4; i++) { const p = prodOf('c1', 'D1', 'model-a', 'fam-x'); c1.push(answer(p), rate(R, p, 1)); }
	const c2 = []; [1, 1, -1].forEach((s) => { const p = prodOf('c2', 'D2', 'model-b', 'fam-x'); c2.push(answer(p), rate(R, p, s, { note: 'ZEBRAWORD secret_plan' })); });
	const c3 = [];
	const p1 = prodOf('c3', '', 'model-a', 'fam-x'), r1 = rate(R, p1, 1);
	c3.push(answer(p1), r1, rate(R, p1, -1, { sup: r1.mid }));
	const p2 = prodOf('c3', '', 'model-a', 'fam-x'), r2 = rate(R, p2, 1);
	c3.push(answer(p2), r2, rate(R, p2, 0, { clear: true, sup: r2.mid }));
	const p3 = prodOf('c3', '', 'model-a', 'fam-x');
	c3.push(answer(p3), rate(R, p3, -1));
	pg.put('c1', c1); pg.put('c2', c2); pg.put('c3', c3); pg.put('c4', []);
	return out;
}
const cellOf = (pg, roll, lv, sc, kind, key) => pg.RR.cell(roll, lv, sc, kind, key);
const sameRoll = (a, b) => canon(a.roll) === canon(b.roll);

// ── The lift is small ──────────────────────────────────────
await kase('the lift reaches only the declarations the account index names (no page dragged in)', async () => {
	const { ordered } = liftSource(NAMES, STUBS);
	const allowed = new Set([...NAMES, '_ratingsRun', '_ratingsAgain', '_ratingsTimer', 'RATINGS_DIGEST_MS', 'USAGE_DIR']);
	const extra = ordered.filter((n) => !allowed.has(n));
	ok(extra.length === 0, 'also lifted: ' + extra.join(' '));
	ok(ordered.includes('writeUsageDigest') && ordered.includes('ratingsAccount'), 'lifted ' + ordered.join(' '));
});

// ── The walk ───────────────────────────────────────────────
await kase('cold: the cells match a hand count of the seeded account (superseded once, cleared never)', async () => {
	const pg = page(); seed(pg);
	const res = await pg.fns.ratingsAccount();
	const roll = res.roll;
	const a = cellOf(pg, roll, 3, '', 'cm', 'model-a'), b = cellOf(pg, roll, 3, '', 'cm', 'model-b');
	eq([a.n, a.pos, a.neg], [6, 4, 2], 'account model-a');
	eq([b.n, b.pos, b.neg], [3, 2, 1], 'account model-b');
	eq([cellOf(pg, roll, 2, 'D1', 'cm', 'model-a').n, cellOf(pg, roll, 2, 'D2', 'cm', 'model-b').n, cellOf(pg, roll, 2, 'D1', 'cm', 'model-b')], [4, 3, null], 'Diamonds');
	eq([cellOf(pg, roll, 1, 'c3', 'cm', 'model-a').n, cellOf(pg, roll, 1, 'c3', 'cm', 'model-a').neg], [2, 2], 'ordinary chat c3');
	eq(res.reads, 4, 'every chat read once');
	eq(res.chats, 4, 'chats');
	eq(pg.loads().sort(), ['c1', 'c2', 'c3', 'c4'], 'each stored chat loaded once');
});

await kase('warm: the second pass reads nothing and is byte-for-byte the cold roll (J2)', async () => {
	const pg = page(); seed(pg);
	const cold = await pg.fns.ratingsAccount();
	pg.clearCalls();
	const warm = await pg.fns.ratingsAccount();
	eq(warm.reads, 0, 'reads');
	eq(pg.loads(), [], 'no load on a warm pass');
	ok(sameRoll(cold, warm), 'warm differs from cold');
});

await kase('a cold rebuild in a second page over the same transcripts equals the first (nothing is stored)', async () => {
	const a = page(); seed(a);
	const ra = await a.fns.ratingsAccount();
	const b = page(); for (const [id, r] of a.disk) b.put(id, r.messages);
	const rb = await b.fns.ratingsAccount();
	ok(sameRoll(ra, rb), 'two pages disagree');
});

await kase('the order the store lists the chats in does not matter', async () => {
	const pg = page(); seed(pg);
	const fwd = await pg.fns.ratingsAccount();
	const pg2 = page(); for (const [id, r] of pg.disk) pg2.put(id, r.messages);
	pg2.st.order = ['c4', 'c3', 'c2', 'c1'];
	ok(sameRoll(fwd, await pg2.fns.ratingsAccount()), 'order changed the roll');
});

await kase('one new rating re-reads only that chat, and the figures move by exactly it', async () => {
	const pg = page(); seed(pg);
	const before = await pg.fns.ratingsAccount();
	const p = prodOf('c2', 'D2', 'model-b', 'fam-x');
	pg.put('c2', pg.disk.get('c2').messages.concat([answer(p), rate(pg.R, p, -1)]));
	pg.clearCalls();
	const after = await pg.fns.ratingsAccount();
	eq(pg.loads(), ['c2'], 'only c2 re-read');
	eq(after.reads, 1, 'reads');
	const b0 = cellOf(pg, before.roll, 3, '', 'cm', 'model-b'), b1 = cellOf(pg, after.roll, 3, '', 'cm', 'model-b');
	eq([b1.n - b0.n, b1.neg - b0.neg], [1, 1], 'model-b moved by one down');
	eq(cellOf(pg, after.roll, 3, '', 'cm', 'model-a').n, 6, 'model-a unmoved');
});

await kase('the memo key is the summary row\'s seed, message count and standing: each moving alone re-reads that chat only', async () => {
	const moves = { seed: { seed: 'another' }, msgCount: { msgCount: 99 }, standing: { standing: 'p1f0i0' } };
	for (const field of Object.keys(moves)) {
		const pg = page(); seed(pg);
		await pg.fns.ratingsAccount();
		pg.st.tweak.c1 = moves[field];
		pg.clearCalls();
		await pg.fns.ratingsAccount();
		eq(pg.loads(), ['c1'], field + ' moved alone');
	}
});

await kase('a chat whose row has no seed is read every pass, and the figures are still right', async () => {
	const pg = page(); seed(pg);
	pg.disk.get('c1').noSeed = true;
	const one = await pg.fns.ratingsAccount();
	pg.clearCalls();
	const two = await pg.fns.ratingsAccount();
	eq(pg.loads(), ['c1'], 'only the seedless chat is read again');
	ok(sameRoll(one, two), 'figures changed');
	ok(!pg.fns._ratingsMemo.has('c1'), 'a seedless chat is not memoised');
});

await kase('a deleted chat drops out of the figures and out of the memo', async () => {
	const pg = page(); seed(pg);
	await pg.fns.ratingsAccount();
	ok(pg.fns._ratingsMemo.has('c1'), 'c1 memoised');
	pg.disk.delete('c1');
	const after = await pg.fns.ratingsAccount();
	eq(cellOf(pg, after.roll, 3, '', 'cm', 'model-a').n, 2, 'only c3\'s two down remain');
	ok(!pg.fns._ratingsMemo.has('c1'), 'c1 still in the memo');
	eq(Array.from(pg.fns._ratingsMemo.keys()).sort(), ['c2', 'c3', 'c4'], 'memo keys');
});

await kase('a resident chat is read from memory, not the store, and its unsaved rating counts', async () => {
	const pg = page(); seed(pg);
	const msgs = pg.disk.get('c2').messages.slice();
	const p = prodOf('c2', 'D2', 'model-b', 'fam-x');
	msgs.push(answer(p), rate(pg.R, p, 1));						// ahead of the store
	pg.chats.push({ id: 'c2', _loaded: true, messages: msgs, msgCount: msgs.length });
	const res = await pg.fns.ratingsAccount();
	ok(!pg.loads().includes('c2'), 'c2 was read from the store: ' + pg.loads().join(' '));
	eq(res.reads, 3, 'the other three read');
	eq(cellOf(pg, res.roll, 3, '', 'cm', 'model-b').n, 4, 'the unsaved rating counted');
});

await kase('a chat that is only a summary stays one: nothing is made resident, no object is touched', async () => {
	const pg = page(); seed(pg);
	const summary = { id: 'c3', _loaded: false, messages: [], msgCount: 7 };
	pg.chats.push(summary);
	const snap = JSON.stringify(pg.chats);
	await pg.fns.ratingsAccount();
	eq(JSON.stringify(pg.chats), snap, 'the chats list was changed');
	ok(pg.loads().includes('c3'), 'c3 is read from the store');
	ok(summary._loaded === false && summary.messages.length === 0, 'c3 was made resident');
});

await kase('the walk reads the store settled, and makes no other call: no write, no save, no mirror change (J1)', async () => {
	const pg = page(); seed(pg);
	const snap = canon(Array.from(pg.disk.entries()));
	await pg.fns.ratingsAccount();
	await pg.fns.ratingsAccount();
	const kinds = new Set(pg.calls.map((c) => c.split(':')[0]));
	eq(Array.from(kinds).sort(), ['booted', 'load', 'settled'], 'calls');
	eq(canon(Array.from(pg.disk.entries())), snap, 'the transcripts moved');
	eq(pg.fileWrites, [], 'the OPFS store was written');
	ok(pg.win.localStorage._m.size === 0, 'localStorage was written');
});

await kase('callers that overlap share one pass, and one that asked after it began is served a fresh one', async () => {
	const pg = page(); seed(pg);
	// While the last chat is being read a rating lands in c3 (already read in this pass) and a second caller asks.
	let second = null;
	pg.st.hook = (id) => {
		if (id !== 'c4' || second) return;
		const p = prodOf('c3', '', 'model-a', 'fam-x');
		pg.put('c3', pg.disk.get('c3').messages.concat([answer(p), rate(pg.R, p, -1)]));
		second = pg.fns.ratingsAccount();
	};
	const first = await pg.fns.ratingsAccount();
	const late = await second;
	eq(cellOf(pg, late.roll, 3, '', 'cm', 'model-a').neg, 3, 'the second caller sees the rating that landed after its pass began');
	ok(first === late, 'the callers get one answer');
	eq(pg.loads().filter((id) => id === 'c3').length, 2, 'c3 read again, and only c3');
});

await kase('an empty account gives an empty roll and says so in the digest, rather than throwing', async () => {
	const pg = page();
	const empty = await pg.fns.ratingsAccount();
	eq([empty.reads, empty.chats], [0, 0], 'empty');
	await pg.fns.writeUsageDigest();
	ok(/Nothing rated yet/.test(pg.files.get('system/usage/digest.md')), 'digest');
});

await kase('tag sides come from the rating form, so fixed points are counted; an old wasm with no form gives none', async () => {
	const pg = page(); seed(pg);
	const withForm = await pg.fns.ratingsAccount();
	ok(withForm.roll.sides && Object.keys(withForm.roll.sides).length > 0, 'sides present');
	const pg2 = page(); seed(pg2); pg2.st.formOk = false;
	const noForm = await pg2.fns.ratingsAccount();
	eq(noForm.roll.sides, null, 'no sides');
});

// ── The digest ─────────────────────────────────────────────
await kase('the digest is the signals, then the Ratings section, written through the store at system/usage/digest.md', async () => {
	const pg = page(); seed(pg);
	await pg.fns.writeUsageDigest();
	const md = pg.files.get('system/usage/digest.md');
	ok(typeof md === 'string', 'digest not written');
	ok(md.startsWith('# Usage'), 'signals first');
	ok(md.indexOf('## Ratings') > md.indexOf('turns: 3'), 'Ratings after the signals');
	ok(/model-a/.test(md) && /Thesis/.test(md), 'a model and a Diamond name');
	eq(pg.fileWrites, ['system/usage/digest.md'], 'one file written');
});

await kase('the digest holds no word of any rating\'s note, no handle and no chat id (J4, end to end)', async () => {
	const pg = page(); seed(pg);
	await pg.fns.writeUsageDigest();
	const md = pg.files.get('system/usage/digest.md');
	['ZEBRAWORD', 'secret_plan', 'p1:answer', 'c1/', 'accounts/fireworks'].forEach((w) => ok(md.indexOf(w) < 0, 'leaked ' + w));
	ok(!/17[0-9]{11}/.test(md), 'a stamp leaked');
});

await kase('the digest is byte-identical cold and warm, and across the order of the chats (J2)', async () => {
	const pg = page(); seed(pg);
	await pg.fns.writeUsageDigest();
	const cold = pg.files.get('system/usage/digest.md');
	pg.clearCalls();
	await pg.fns.writeUsageDigest();
	eq(pg.loads(), [], 'a warm write reads nothing');
	ok(pg.files.get('system/usage/digest.md') === cold, 'warm digest differs');
	const pg2 = page(); for (const [id, r] of pg.disk) pg2.put(id, r.messages);
	pg2.st.order = ['c3', 'c1', 'c4', 'c2'];
	await pg2.fns.writeUsageDigest();
	ok(pg2.files.get('system/usage/digest.md') === cold, 'reordered digest differs');
});

await kase('a walk that fails leaves the signals digest written, and writeUsageDigest does not throw', async () => {
	const pg = page(); seed(pg);
	delete pg.win.DaimondRatingRoll;							// the roll-up not loaded: the walk throws
	await pg.fns.writeUsageDigest();
	const md = pg.files.get('system/usage/digest.md');
	ok(typeof md === 'string' && md.startsWith('# Usage') && md.indexOf('## Ratings') < 0, 'signals alone expected: ' + String(md).slice(0, 80));
});

await kase('a digest written raises the page\'s proposals once, after it (U7b); none written, none raised', async () => {
	const pg = page(); seed(pg);
	await pg.fns.writeUsageDigest();
	eq(pg.st.raised, 1, 'raised once, after the write');
	const off = page(); seed(off); delete off.win.DaimondSignals;
	await off.fns.writeUsageDigest();
	eq(off.st.raised, 0, 'a digest never written raises nothing');
});

await kase('no signals module: nothing is written, as before', async () => {
	const pg = page(); seed(pg);
	delete pg.win.DaimondSignals;
	await pg.fns.writeUsageDigest();
	eq(pg.fileWrites, [], 'writes');
});

// ── The import of the old counts (O4) ──────────────────────
const OLD = JSON.stringify({ 'glm-5.2': { up: 4, down: 2 }, 'b/two': { up: 1, down: 0 } });
await kase('import: the old counts become the closing block, the source file is written, and the key is removed', async () => {
	const pg = page(); seed(pg);
	pg.win.localStorage.setItem('daimond-model-ratings', OLD);
	await pg.fns.writeUsageDigest();
	const md = pg.files.get('system/usage/digest.md');
	ok(pg.win.localStorage.getItem('daimond-model-ratings') === null, 'the key is still there');
	ok(pg.files.get('system/usage/models-before.md').indexOf('- glm-5.2: 4 up, 2 down') >= 0, 'source file');
	ok(md.indexOf('## Before answer ratings (this device, Models page)') > md.indexOf('## Ratings'), 'closing block after the Ratings section');
	ok(md.trimEnd().endsWith('- b/two: 1 up, 0 down'), 'the block closes the digest: ' + md.slice(-120));
	ok(md.indexOf('glm-5.2: 4 up, 2 down') === md.lastIndexOf('glm-5.2: 4 up, 2 down'), 'the counts appear once');
});

await kase('import: it runs once; a later digest writes the source file no more, and the block stays', async () => {
	const pg = page(); seed(pg);
	pg.win.localStorage.setItem('daimond-model-ratings', OLD);
	await pg.fns.writeUsageDigest();
	const writes1 = pg.fileWrites.filter((p) => p === 'system/usage/models-before.md').length;
	await pg.fns.writeUsageDigest();
	await pg.fns.importModelCounts();
	eq(pg.fileWrites.filter((p) => p === 'system/usage/models-before.md').length, writes1, 'the source file was rewritten');
	eq(writes1, 1, 'written once');
	ok(pg.files.get('system/usage/digest.md').indexOf('## Before answer ratings') >= 0, 'the block is still in the digest');
});

await kase('import: the old counts never enter a figure: the cells are the same before the import, after it and without it', async () => {
	const a = page(); seed(a);
	const plain = await a.fns.ratingsAccount();
	const b = page(); for (const [id, r] of a.disk) b.put(id, r.messages);
	b.win.localStorage.setItem('daimond-model-ratings', JSON.stringify({ 'model-a': { up: 50, down: 50 } }));
	const pre = await b.fns.ratingsAccount();					// the key is still there
	ok(sameRoll(plain, pre), 'the roll moved while the old key stood');
	await b.fns.writeUsageDigest();							// the import
	ok(sameRoll(plain, await b.fns.ratingsAccount()), 'the roll moved with the import');
	const md = b.files.get('system/usage/digest.md');
	const ratingsPart = md.slice(md.indexOf('## Ratings'), md.indexOf('## Before answer ratings'));
	ok(!/\b50 (up|down)\b/.test(ratingsPart), 'the old counts are in the Ratings section');
});

await kase('import: with no store yet the key stays for the next digest; once the store is there it goes', async () => {
	const pg = page(); seed(pg);
	pg.win.localStorage.setItem('daimond-model-ratings', OLD);
	pg.st.failWrite = true;
	await pg.fns.importModelCounts();
	ok(pg.win.localStorage.getItem('daimond-model-ratings') === OLD, 'the key was removed before the file held it');
	pg.st.failWrite = false;
	await pg.fns.importModelCounts();
	ok(pg.win.localStorage.getItem('daimond-model-ratings') === null, 'the key stayed after a good write');
	ok(pg.files.has('system/usage/models-before.md'), 'file');
});

await kase('import: an empty, corrupt or absent key writes no file; the first two are removed, the last is left absent', async () => {
	for (const raw of ['{}', 'not json{{{', '{"x":{"up":0,"down":0}}']) {
		const pg = page();
		pg.win.localStorage.setItem('daimond-model-ratings', raw);
		await pg.fns.importModelCounts();
		ok(pg.win.localStorage.getItem('daimond-model-ratings') === null, 'kept ' + raw);
		eq(pg.fileWrites, [], 'file written for ' + raw);
	}
	const none = page();
	await none.fns.importModelCounts();
	eq(none.fileWrites, [], 'nothing to import, nothing written');
});

await kase('import: no new storage name is made (the only key touched is the old one, and it only shrinks)', async () => {
	const pg = page(); seed(pg);
	const names = new Set();
	const ls = pg.win.localStorage, set = ls.setItem, rem = ls.removeItem;
	ls.setItem = (k, v) => { names.add('set:' + k); return set(k, v); };
	ls.removeItem = (k) => { names.add('remove:' + k); return rem(k); };
	set('daimond-model-ratings', OLD);
	await pg.fns.writeUsageDigest();
	eq(Array.from(names).sort(), ['remove:daimond-model-ratings'], 'storage touched');
});

// ── After a burst of ratings ───────────────────────────────
await kase('a burst of ratings writes the digest once, ten seconds after the last (debounced)', async () => {
	const pg = page(); seed(pg);
	pg.fns.ratingsDigestSoon(); pg.fns.ratingsDigestSoon(); pg.fns.ratingsDigestSoon();
	const live = pg.timers.filter((t) => t.live);
	eq(live.length, 1, 'one timer outstanding');
	eq(live[0].ms, 10000, 'ten seconds');
	live[0].f();
	for (let i = 0; i < 20; i++) await Promise.resolve();
	await new Promise((r) => setImmediate(r));
	ok(pg.files.has('system/usage/digest.md'), 'the digest was written when the timer fired');
});

await kase('source: commitRatings asks for the digest after a burst commits, and the page hands the Models page its source', async () => {
	const src = readFileSync(join(HERE, 'daimond.js'), 'utf8');
	const at = src.indexOf('function commitRatings(');
	ok(at > 0, 'commitRatings not found');
	const end = src.indexOf('\n\t}\n', at);
	const body = src.slice(at, end);
	ok(/persistChats\(\);[^\n]*\n\s*ratingsDigestSoon\(\);/.test(body), 'commitRatings does not call ratingsDigestSoon after persistChats');
	ok(/DaimondModelDash\.useRolls\(ratingsAccount\)/.test(src), 'the Models page is not given the account index');
	const keyUses = src.split("'daimond-model-ratings'").length - 1;
	eq(keyUses, 1, 'the old key is named once, by the import\'s constant');
	ok(!/localStorage\.setItem\(MODEL_COUNTS_KEY/.test(src), 'something writes the old key');
});

console.log('\n' + cases + ' cases, ' + failures + ' failed');
if (BREAK) { console.log('(--break ' + BREAK + ': failures above are the point)'); process.exit(failures > 0 ? 0 : 1); }
process.exit(failures ? 1 : 0);
