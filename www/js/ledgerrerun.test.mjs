/* ============================================================
   Test -- r542 QA A, F1: a re-run of a handed-off turn patches ITS OWN ledger entry.
   ------------------------------------------------------------
   MC1 C1 keyed the daimon's entry on `dumid`, and for a handed-off turn that is the
   errand's turn id on every run of it (the runner, Run here, a take-back, a park
   recovery). `patchTurn` found "the MOST RECENT entry carrying that tid", so after a
   sync the second run's outcome and facts landed on the first run's entry. The chat
   path had the same shape (`umid` is the `iturn` of a handed-off chat turn).

   The fix: a run patches the entry its own `recordSpend` returned, by that entry's
   `ledgerKey`, and records an outcome-only entry when it billed nothing.

   Runs the REAL ledger.js and the REAL `recordSpend` and `recordTurnOutcome`, lifted
   out of daimond.js, with the clock handed in so B's can run behind A's.
   ============================================================ */
import { readFileSync } from 'node:fs';
import { loadStore } from './storefixture.mjs';

const LEDGER = readFileSync(new URL('./ledger.js', import.meta.url), 'utf8');
const DAIMOND = readFileSync(new URL('./daimond.js', import.meta.url), 'utf8');

let ok = 0, bad = 0;
const check = (name, cond, detail) => {
	if (cond) { ok++; console.log('  ok   ' + name); }
	else { bad++; console.log('  FAIL ' + name + (detail ? '  -- ' + detail : '')); }
};

function lift(name) {
	const a = DAIMOND.indexOf('\tfunction ' + name + '(');
	const b = DAIMOND.indexOf('\n\t}\n', a);
	if (a < 0 || b < 0) throw new Error(name + ' not found in daimond.js');
	return DAIMOND.slice(a, b + 3);
}

// One device: its own localStorage, store.js, ledger.js, and daimond.js's two ledger calls.
function device() {
	const store = new Map();
	const localStorage = {
		getItem:    (k) => (store.has(k) ? store.get(k) : null),
		setItem:    (k, v) => { store.set(k, String(v)); },
		removeItem: (k) => { store.delete(k); },
	};
	const win = {};
	loadStore(win, localStorage);
	new Function('window', 'localStorage', LEDGER)(win, localStorage);
	const clock = { now: 0 };
	const fakeDate = { now: () => clock.now };
	const fns = new Function('window', 'DaimondLedger', 'Date', 'writeUsageDigest',
		lift('recordSpend') + lift('recordTurnOutcome')
		+ '\nreturn { recordSpend: recordSpend, recordTurnOutcome: recordTurnOutcome };')(
		win, win.DaimondLedger, fakeDate, () => {});
	const rows = () => win.DaimondStore.get('daimond-ledger', []);
	return { L: win.DaimondLedger, clock, rows, ...fns };
}
const priceOf = (e) => JSON.stringify([e.u, e.e, e.r, e.rp, e.u0]);

const X = 'turn-errand-1';	// the errand's turn id: `dumid` on EVERY device that runs it

console.log('case 1: run A billed and completed; run B (Run here / park recovery) failed before a token');
{
	const A = device(), B = device();
	const t0 = Date.UTC(2026, 9, 9, 4, 0, 0);
	A.clock.now = t0;
	const spentA = A.recordSpend('m', 9000, 700, 0, 0.0421, 'pv', 'd1', X, null);
	check('recordSpend hands back the entry it wrote', !!spentA && spentA.t === t0 && spentA.tid === X,
		JSON.stringify(spentA));
	A.clock.now = t0 + 41000;
	A.recordTurnOutcome('m', 'pv', X, 41000, 'completed', { ft: 900, tc: 6, ro: 'd' }, spentA);
	check("A's own entry carries A's outcome and facts",
		A.rows().length === 1 && A.rows()[0].out === 'completed' && A.rows()[0].tc === 6,
		JSON.stringify(A.rows()));
	// Sync: B adopts A's ledger.
	B.L.adopt(A.rows());
	const before = JSON.stringify(B.rows());
	// B runs the SAME errand (dumid = X). Its provider refuses on the first call:
	// meterDiamondTurn bills nothing, so there is no entry of B's own to patch.
	B.clock.now = t0 + 90000;
	B.recordTurnOutcome('m', 'pv', X, 1200, 'failed', { ft: 0, ro: 'd' }, null);
	const after = B.rows();
	check('B recorded its own failed attempt (an outcome-only entry)',
		after.some((e) => e.ol === 1 && e.tid === X && e.out === 'failed'),
		'entries=' + after.length + ' ' + JSON.stringify(after));
	const aOnB = after.find((e) => e.t === t0);
	check("A's billed entry is untouched on B", JSON.stringify([aOnB]) === before,
		'was ' + before + ' now ' + JSON.stringify(aOnB));
	const merged = A.L.merge(A.rows(), after, t0 + 120000);
	const m = merged.find((e) => e.t === t0);
	check("after the merge A's completed run is still `completed`", m.out === 'completed',
		'out=' + m.out + ' dur=' + m.dur);
	check('no price field moved', priceOf(m) === priceOf(JSON.parse(before)[0]), priceOf(m));
}

console.log("case 2: both runs billed; B's clock is behind A's");
{
	const A = device(), B = device();
	const tA = Date.UTC(2026, 9, 9, 4, 10, 0);
	A.clock.now = tA;
	const spentA = A.recordSpend('m', 5000, 300, 0, 0.02, 'pv', 'd1', X, null);
	A.recordTurnOutcome('m', 'pv', X, 30000, 'interrupted', { ft: 800, tc: 2, ro: 'd' }, spentA);
	B.L.adopt(A.rows());
	// B runs it later in real time, but its clock reads 20 s behind A's entry.
	const tB = tA - 20000;
	B.clock.now = tB;
	const spentB = B.recordSpend('m', 7000, 900, 0, 0.05, 'pv', 'd1', X, null);
	B.recordTurnOutcome('m', 'pv', X, 52000, 'completed', { ft: 1500, tc: 11, te: 1, ro: 'd' }, spentB);
	const after = B.rows();
	const own = after.find((e) => e.t === tB);
	const other = after.find((e) => e.t === tA);
	check("B's facts land on B's own billed entry", own && own.tc === 11 && own.out === 'completed',
		'own=' + JSON.stringify(own));
	check("A's entry keeps A's facts", other && other.tc === 2 && other.out === 'interrupted',
		'A=' + JSON.stringify(other));
	check('no outcome-only entry was added beside two billed runs', !after.some((e) => e.ol), JSON.stringify(after));
}

console.log('case 3: the billed entry is gone (pruned or cleared) before the patch');
{
	const A = device();
	A.clock.now = Date.UTC(2026, 9, 9, 5, 0, 0);
	const spent = A.recordSpend('m', 10, 5, 0, 0.001, 'pv', '', 'u-1', null);
	A.L.clear();
	A.recordTurnOutcome('m', 'pv', 'u-1', 500, 'completed', { ro: 'c' }, spent);
	check('the outcome is still recorded, outcome-only', A.rows().length === 1 && A.rows()[0].ol === 1
		&& A.rows()[0].out === 'completed', JSON.stringify(A.rows()));
}

console.log('daimond.js: every path closes the turn on the entry it billed');
{
	check('the chat path keeps what recordSpend returned and hands it to recordTurnOutcome',
		/turnSpent = recordSpend\(chat\.model,/.test(DAIMOND)
		&& DAIMOND.includes("recordTurnOutcome(chat.model, chat.provider, umid, Date.now() - telT0, turnOutcome, tmeter.facts('c'), turnSpent);"));
	check('the daimon path keeps what meterDiamondTurn returned and hands it to recordTurnOutcome',
		DAIMOND.includes('dsSpent = meterDiamondTurn(fa, diamondId, dumid);')
		&& /recordTurnOutcome\(dsPair\.model, dsPair\.provider, dumid, Date\.now\(\) - dsT0,\s*\(out === 'error'\) \? 'failed' : 'completed', dmeter\.facts\('d'\), dsSpent\);/.test(DAIMOND));
	check('meterDiamondTurn returns the entry recordSpend wrote',
		/return recordSpend\(_diamondAppModel\.get\(app\)/.test(lift('meterDiamondTurn')));
}

console.log(`\nledger re-run (r542 QA A F1): ${ok} ok, ${bad} failed`);
process.exit(bad ? 1 : 0);
