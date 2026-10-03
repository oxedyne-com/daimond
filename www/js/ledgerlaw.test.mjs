/* ============================================================
   Test -- the copies of one spend entry converge (the ledger law, F2).
   ------------------------------------------------------------
   THE BUG (soak R1, R2, the nightly: `ledger/N/rp`, `u0`). `merge` was
   "union by key, mine wins a tie", so two copies of one entry that
   differed in any field stayed different on each device for good. They
   differed because `reprice` -- run by any READ, once per page life --
   wrote an `rp` mark and a `u0` into the synced store for every entry
   the provider had not billed, whatever its age, and which entries each
   device had marked depended on when it first read. A mock or custom
   provider is unbilled, so every entry of every soak turn was marked on
   one device and not the other.

   THE LAW (`join`, ledger.js). A pair of copies sharing `ledgerKey` joins
   field by field, each field by its own rule:
     the price (`u`, `e`, `r`, `rp`, `u0`) is one claim about what the turn
       cost, so it travels whole: a billed copy (`r`) over a repriced one
       (`rp`) over a guess, then the greater `u` (a join never understates
       spend), then the canonical form;
     every other field: present over absent, and on a clash the greater
       value (numbers by value, the rest by canonical text, in code points).
   The output is the entry in one key order. And `reprice` is a pure view
   of entries older than 2026-07-31 (the table's correction): it neither
   saves from a read nor touches a newer entry.

   WHAT IS CHECKED, through the REAL `ledger.js` (`TREE=<checkout>` aims it
   at another checkout):
     A. the join laws on generated ledgers, BYTE FOR BYTE: idempotent,
        commutative, associative, a fixed point; and never lower over
        higher: the join prices at least as high as every copy, keeps a
        `dur`/`out`/`tid` any copy has, and never understates `u`;
     B. what the law must mean: the soak's pair (marked and unmarked)
        settles on the marked copy in either order; a billed copy beats a
        guess; `dur`/`out` present beat absent; a tie takes the greater
        spend; a field this build does not know survives; key order is
        not content;
     C. a read writes nothing: two devices that read at different times
        hold the same bytes, a newer entry is never repriced, and the
        view of an old one carries `u0` and `rp` without touching the store.
   On de0ee5a1 (first-wins, repricing on every read) A, B and C fail.
     node www/js/ledgerlaw.test.mjs      # ALL PASS
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadStore } from './storefixture.mjs';
import { rng } from '../../dev/syncprobe.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TREE = process.env.TREE;
const SRC = readFileSync(TREE ? join(TREE, 'www/js/ledger.js') : join(HERE, 'ledger.js'), 'utf8');

let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}

const DAY = 24 * 60 * 60 * 1000;
const KEY = 'daimond-ledger';
// The table was corrected on 2026-07-31; an entry before it is a migration candidate.
const OLD = Date.UTC(2026, 6, 31) - 10 * DAY;			// 21 July 2026
const NEW = Date.UTC(2026, 6, 31) + 10 * DAY;			// 10 August 2026
const NOW = NEW + 20 * DAY;								// all within 90 days of each other

/// A fresh `DaimondLedger` on the real source, over an in-memory localStorage that
/// counts its writes. A pricing stub prices every token at one milli-dollar.
function device() {
	const store = new Map();
	const writes = { n: 0 };
	const localStorage = {
		getItem: (k) => (store.has(k) ? store.get(k) : null),
		setItem: (k, v) => { writes.n++; store.set(k, String(v)); },
		removeItem: (k) => { store.delete(k); },
	};
	const win = {};
	loadStore(win, localStorage);
	win.DaimondPricing = { priceFor: (m, p, c) => ({ usd: 0.001 * (p + c), estimated: true }) };
	new Function('window', 'localStorage', SRC)(win, localStorage);
	return { L: win.DaimondLedger, store, writes, localStorage };
}
const { L } = device();

const bytes = (x) => JSON.stringify(x);
const clone = (x) => structuredClone(x);
const M = (a, b) => L.merge(clone(a), clone(b), NOW);
const J = (a, b) => M([a], [b]);
const joinOf = (...copies) => copies.slice(1).reduce((acc, c) => J(acc[0], c), [copies[0]]);

// ── A. The laws ─────────────────────────────────────────────────────

function shuffled(r, a) {
	const o = a.slice();
	for (let i = o.length - 1; i > 0; i--) { const j = r.int(i + 1); [o[i], o[j]] = [o[j], o[i]]; }
	return o;
}
/// One copy of the entry `t`: fields drawn from the shapes copies really take, in a
/// random key order.
function copy(r, t) {
	const f = [['t', t], ['m', 'mock/fast'], ['p', 100], ['c', 10]];
	if (r.chance(0.7)) f.push(['ca', 0]);
	if (r.chance(0.5)) f.push(['pv', 'mock']);
	// The price: a guess, a repriced guess, a billed figure.
	const kind = r.pick(['guess', 'guess', 'repriced', 'billed']);
	f.push(['u', r.pick([0.5, 0.25, 0.11, 0.0021, 0.11])]);
	if (r.chance(0.7)) f.push(['e', r.chance(0.5)]);
	if (kind === 'repriced') { f.push(['rp', 1]); f.push(['u0', r.pick([0.5, 0.3, 0.0000372])]); }
	if (kind === 'billed') f.push(['r', 1]);
	if (r.chance(0.5)) f.push(['tid', r.pick(['t1', 't2'])]);
	if (r.chance(0.4)) f.push(['dur', r.pick([90, 1200, 9, 100000])]);
	if (r.chance(0.4)) f.push(['out', r.pick(['completed', 'failed', 'interrupted'])]);
	if (r.chance(0.1)) f.push(['ol', 1]);
	if (r.chance(0.2)) f.push(['zz', r.pick([1, 'x', { a: 1 }])]);		// a field a later build adds
	const o = {};
	for (const [k, v] of shuffled(r, f)) o[k] = v;
	return o;
}
function ledger(r) {
	const out = [];
	for (const t of [NEW, NEW + 1, NEW + 2]) {
		const n = r.pick([0, 1, 1, 2]);
		for (let i = 0; i < n; i++) out.push(copy(r, t));
	}
	return shuffled(r, out);
}
const rank = (e) => (e.r ? 2 : e.rp ? 1 : 0);

console.log('\nA. the join laws, byte for byte, on generated ledgers\n');
{
	const r = rng(531);
	const TRIALS = 2000;
	const fail = { idempotent: 0, commutative: 0, associative: 0, 'fixed point': 0, 'never lower over higher': 0 };
	const first = {};
	for (let i = 0; i < TRIALS; i++) {
		const x = ledger(r), y = ledger(r), z = ledger(r);
		const x1 = bytes(M(x, []));
		const note = (law, d) => { fail[law]++; if (!first[law]) first[law] = d; };
		if (bytes(M(x, x)) !== x1) note('idempotent', { x });
		if (bytes(M(JSON.parse(x1), [])) !== x1) note('fixed point', { x });
		if (bytes(M(x, y)) !== bytes(M(y, x))) note('commutative', { x, y, xy: M(x, y), yx: M(y, x) });
		if (bytes(M(M(x, y), z)) !== bytes(M(x, M(y, z)))) note('associative', { x, y, z });
		const xy = M(x, y), ins = x.concat(y);
		for (const m of xy) {
			for (const c of ins.filter((k) => L.ledgerKey(k) === L.ledgerKey(m))) {
				const ok = rank(m) >= rank(c)
					&& (c.tid === undefined || m.tid !== undefined)
					&& (c.dur === undefined || m.dur !== undefined)
					&& (c.out === undefined || m.out !== undefined)
					&& (rank(m) > rank(c) || (m.u || 0) >= (c.u || 0));
				if (!ok) note('never lower over higher', { join: m, copy: c });
			}
		}
	}
	for (const law of Object.keys(fail)) {
		check(`${law} on ${TRIALS} generated triples`, fail[law] === 0,
			fail[law] ? fail[law] + ' failed; first: ' + JSON.stringify(first[law]).slice(0, 400) : '');
	}
}

// ── B. What the law means ───────────────────────────────────────────

const base = () => ({ t: NEW, m: 'mock/fast', p: 100, c: 10, ca: 0, u: 0.11, e: true, pv: 'mock' });
const both = (a, b) => [J(a, b), J(b, a)];
const same = (p) => bytes(p[0]) === bytes(p[1]);

console.log('\nB. the soak\'s pair: a marked and an unmarked copy of one entry\n');
{
	const marked = Object.assign(base(), { u: 0.11, u0: 0.5, rp: 1 });
	const p = both(marked, base());
	check('one entry, not two', p[0].length === 1 && p[1].length === 1, p[0].length + ',' + p[1].length);
	check('the marked copy, in either order, on one set of bytes',
		same(p) && p[0][0].rp === 1 && p[0][0].u0 === 0.5, bytes(p[0]));
}
console.log('\nB. a billed copy is money that moved, whatever stands beside it\n');
{
	const billed = Object.assign(base(), { u: 0.0021, r: 1 });
	const repriced = Object.assign(base(), { u: 0.9, u0: 0.5, rp: 1 });
	const guess = Object.assign(base(), { u: 0.5 });
	for (const [label, other] of [['a repriced copy', repriced], ['a guess', guess]]) {
		const p = both(billed, other);
		check('the billed figure over ' + label + ', though the other is greater',
			same(p) && p[0][0].r === 1 && p[0][0].u === 0.0021 && p[0][0].rp === undefined, bytes(p[0]));
	}
	const p = both(repriced, guess);
	check('a repriced copy over a guess, though the guess is greater',
		same(p) && p[0][0].rp === 1 && p[0][0].u === 0.9 && p[0][0].u0 === 0.5, bytes(p[0]));
}
console.log('\nB. what one copy knows and the other does not\n');
{
	const a = Object.assign(base(), { dur: 1200, out: 'completed' });
	const p = both(a, base());
	check('`dur` and `out` present over absent', same(p) && p[0][0].dur === 1200 && p[0][0].out === 'completed', bytes(p[0]));
	const q = both(Object.assign(base(), { tid: 't1' }), base());
	check('`tid` present over absent', same(q) && q[0][0].tid === 't1', bytes(q[0]));
	const z = both(Object.assign(base(), { zz: { a: 1 } }), base());
	check('a field this build does not know survives the join', same(z) && bytes(z[0][0].zz) === '{"a":1}', bytes(z[0]));
	const d = both(Object.assign(base(), { dur: 9 }), Object.assign(base(), { dur: 100000 }));
	check('two durations: the greater, by value and not by text', same(d) && d[0][0].dur === 100000, bytes(d[0]));
}
console.log('\nB. a tie takes the greater spend, and key order is not content\n');
{
	const p = both(Object.assign(base(), { u: 0.11 }), Object.assign(base(), { u: 0.25 }));
	check('two guesses: the greater `u`, so a join never understates spend', same(p) && p[0][0].u === 0.25, bytes(p[0]));
	const k1 = { t: NEW, m: 'mock/fast', p: 100, c: 10, ca: 0, u: 0.11, e: true, pv: 'mock' };
	const k2 = { pv: 'mock', e: true, u: 0.11, ca: 0, c: 10, p: 100, m: 'mock/fast', t: NEW };
	const k = both(k1, k2);
	check('two copies equal but for key order settle on one set of bytes', same(k) && k[0].length === 1, bytes(k[0]));
	check('and a lone entry in another key order is stored in that one order',
		bytes(M([k2], [])) === bytes(M([k1], [])), bytes(M([k2], [])));
	const absent = both(Object.assign(base(), { pv: undefined, ca: undefined }), Object.assign(base(), { pv: '', ca: 0 }));
	check('absent against zero or empty in a key field is one entry, on one set of bytes', same(absent) && absent[0].length === 1, bytes(absent[0]));
}

// ── C. A read writes nothing ────────────────────────────────────────

console.log('\nC. a read writes nothing: devices that read at different times hold the same bytes\n');
{
	const seed = [
		Object.assign(base(), { t: OLD }),
		Object.assign(base(), { t: OLD + 1000, u: 0.25 }),
		Object.assign(base(), { t: NEW }),						// a mock turn since the correction
		Object.assign(base(), { t: NEW + 1000, u: 0.0021, r: 1 }),
	];
	const a = device(), b = device();
	for (const d of [a, b]) d.localStorage.setItem(KEY, bytes(seed));
	const before = a.store.get(KEY), n0 = a.writes.n;
	// A reads: every getter that ran `reprice` and saved.
	a.L.totals(); a.L.perModel('month'); a.L.perProvider(0); a.L.samples(); a.L.repriced('month'); a.L.series(30);
	check('the reads wrote nothing to the store', a.writes.n === n0 && a.store.get(KEY) === before,
		(a.writes.n - n0) + ' writes');
	check('A, having read, and B, never having read, hold the same bytes', a.store.get(KEY) === b.store.get(KEY));
	check('and no entry of either carries an `rp` mark', !/"rp"/.test(a.store.get(KEY)) && !/"u0"/.test(a.store.get(KEY)));
	const ab = bytes(a.L.merge(JSON.parse(a.store.get(KEY)), JSON.parse(b.store.get(KEY)), NOW));
	check('and their merge is either of them', ab === bytes(a.L.merge(JSON.parse(b.store.get(KEY)), [], NOW)));
}
console.log('\nC. repricing is the migration it says it is\n');
{
	const d = device();
	const old = Object.assign(base(), { t: OLD, u: 0.5 }), fresh = Object.assign(base(), { t: NEW, u: 0.5 });
	const billed = Object.assign(base(), { t: OLD + 5, u: 0.0021, r: 1 });
	const ol = Object.assign(base(), { t: OLD + 6, u: 0, p: 0, c: 0, ol: 1 });
	const done = Object.assign(base(), { t: OLD + 7, u: 0.11, u0: 0.5, rp: 1 });
	const input = [old, fresh, billed, ol, done];
	const snap = bytes(input);
	const view = typeof d.L.reprice === 'function' ? d.L.reprice(input) : [];
	check('`reprice` is exported, a view of the entries', typeof d.L.reprice === 'function');
	check('an unbilled entry before 2026-07-31 is repriced, its first figure kept in `u0`',
		view[0] && view[0].u === 0.11 && view[0].u0 === 0.5 && view[0].rp === 1 && view[0].e === true, bytes(view[0]));
	check('an entry after it is not touched, though unbilled', view[1] && bytes(view[1]) === bytes(fresh), bytes(view[1]));
	check('a billed entry, an outcome-only one and a repriced one are not touched',
		[2, 3, 4].every((i) => view[i] && bytes(view[i]) === bytes(input[i])));
	check('the input is not edited: the view is a copy', bytes(input) === snap);
	d.localStorage.setItem(KEY, snap);
	const totals = d.L.perProvider(0)[0];
	check('the readers see the repriced figure for the old entry, the stored one for the rest',
		Math.abs(totals.usd - (0.11 + 0.5 + 0.0021 + 0 + 0.11)) < 1e-9, String(totals.usd));
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
if (failures) process.exitCode = 1;
