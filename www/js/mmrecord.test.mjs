/* ============================================================
   Test -- a Diamond's model record (D-20261018-09 U1a).
   ------------------------------------------------------------
   A clear is a stamped write, and each pick merges on its own
   stamp: `at` for the daimon pair, `wat` for Workers, `vat` for
   Images, `eat` for the Effort as before.

   The REAL functions are lifted from daimond.js and stamp.js
   (testlift.mjs) and run in one sandbox per device, each with its
   own localStorage and clock. `MM_SRC_REV=14ef947b` runs the same
   arms against the live record's code, which is how A1 and A2 are
   shown red.

   Run:  node www/js/mmrecord.test.mjs
   ============================================================ */
import { source, lift } from './testlift.mjs';

const APP   = source('daimond.js');
const STAMP = source('stamp.js');

let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail !== undefined ? '  (' + JSON.stringify(detail) + ')' : '')); failures++; }
}

const L = lift(APP, ['readJson', 'diamondModels', 'setDiamondModel', 'blankDiamondModel', 'mergeDiamondModel',
	'adoptDiamondModel'], ['DIAMOND_MODELS_KEY', 'DIAMOND_MODEL_HALF', 'DIAMOND_EFFORT_HALF']);
if (L.missing.length) console.log('  note: absent in this revision: ' + L.missing.join(', '));

const KEY = 'daimond-diamond-models';

/// One device: its own storage and clock, and the real code over them.
function device() {
	const store = new Map();
	const localStorage = {
		getItem: (k) => (store.has(k) ? store.get(k) : null),
		setItem: (k, v) => { store.set(k, String(v)); },
	};
	const clock = { t: 1000 };
	const DateStub = { now: () => clock.t };
	const win = {};
	new Function('window', 'Date', STAMP)(win, DateStub);
	const api = new Function('localStorage', 'Date', 'DaimondStamp', 'Notes', L.body +
		'\nreturn { diamondModels: diamondModels, setDiamondModel: setDiamondModel, adoptDiamondModel: adoptDiamondModel };'
	)(localStorage, DateStub, win.DaimondStamp, undefined);
	api.clock = clock;
	api.rec = (id) => api.diamondModels()[id];
	api.put = (id, r) => { const all = api.diamondModels(); all[id] = JSON.parse(JSON.stringify(r)); localStorage.setItem(KEY, JSON.stringify(all)); };
	api.raw = () => localStorage.getItem(KEY);
	return api;
}

const ID = 'dia-daimond';
const S  = 5000;
const copy = (r) => JSON.parse(JSON.stringify(r));

// ── A1 a clear of a pinned Diamond is a stamped tombstone, and it travels ──
{
	const A = device(), B = device();
	const held = { provider: 'openrouter', model: 'z-ai/glm-5.3', at: S };
	A.put(ID, held); B.put(ID, held);
	A.clock.t = 6000;
	A.setDiamondModel(ID, { provider: '', model: '' });
	const a = A.rec(ID);
	check('A1 a clear leaves a record with no model', a && a.model === '' && a.provider === '', a);
	check('A1 the clear moves the stamp past S', a && +a.at > S, a);
	const took = B.adoptDiamondModel(ID, copy(a), false);
	check('A1 the other device adopts the clear', took === true && B.rec(ID).model === '', B.rec(ID));
}

// ── A2 a bulk clear on A and an Images pick on B both survive, both ways ──
{
	const A = device(), B = device();
	const held = { provider: 'openrouter', model: 'z-ai/glm-5.3', workerProvider: 'openrouter',
		workerModel: 'z-ai/glm-5.3-flash', visionProvider: '', visionModel: '', effort: '', effortProvider: '',
		effortModel: '', at: S, eat: 0 };
	A.put(ID, held); B.put(ID, held);
	A.clock.t = 6000;
	A.setDiamondModel(ID, { provider: '', model: '', workerProvider: '', workerModel: '' });
	B.clock.t = 7000;
	B.setDiamondModel(ID, { visionProvider: 'openrouter', visionModel: 'google/gemini-2.5-flash-lite' });
	const a = copy(A.rec(ID)), b = copy(B.rec(ID));
	A.adoptDiamondModel(ID, b, false);
	B.adoptDiamondModel(ID, a, false);
	for (const [n, d] of [['A', A], ['B', B]]) {
		const r = d.rec(ID) || {};
		check('A2 ' + n + ' ends with the daimon cleared', r.model === '' && r.provider === '', r);
		check('A2 ' + n + ' ends with Workers cleared', r.workerModel === '' && r.workerProvider === '', r);
		check('A2 ' + n + ' ends with the Images pick', r.visionModel === 'google/gemini-2.5-flash-lite', r);
	}
	check('A2 both devices converge', JSON.stringify(A.rec(ID)) === JSON.stringify(B.rec(ID)), [A.rec(ID), B.rec(ID)]);
	// The same exchange the other way round in time: B's pick first, A's clear after.
	const C = device(), D = device();
	C.put(ID, held); D.put(ID, held);
	D.clock.t = 6000;
	D.setDiamondModel(ID, { visionProvider: 'openrouter', visionModel: 'google/gemini-2.5-flash-lite' });
	C.clock.t = 7000;
	C.setDiamondModel(ID, { provider: '', model: '', workerProvider: '', workerModel: '' });
	const c = copy(C.rec(ID)), d = copy(D.rec(ID));
	C.adoptDiamondModel(ID, d, false);
	D.adoptDiamondModel(ID, c, false);
	for (const [n, x] of [['C', C], ['D', D]]) {
		const r = x.rec(ID) || {};
		check('A2 reversed ' + n + ' keeps both', r.model === '' && r.workerModel === ''
			&& r.visionModel === 'google/gemini-2.5-flash-lite', r);
	}
}

// ── A3 restating the Workers pick moves no stamp ──
{
	const A = device();
	A.clock.t = 2000;
	A.setDiamondModel(ID, { provider: 'p', model: 'M', workerProvider: 'p', workerModel: 'W' });
	const before = copy(A.rec(ID));
	A.clock.t = 3000;
	A.setDiamondModel(ID, { workerProvider: 'p', workerModel: 'W' });
	check('A3 restating the Workers pick moves no stamp', JSON.stringify(A.rec(ID)) === JSON.stringify(before),
		[before, A.rec(ID)]);
	A.clock.t = 4000;
	A.setDiamondModel(ID, { workerProvider: 'p', workerModel: 'W2' });
	const r = A.rec(ID);
	// The daimon pair keeps its stamp (`dat`); `at`, the half's clock for old builds, moves with it (S).
	check('A3 a Workers change moves only the Workers stamp', +r.dat === before.at && +r.wat === 4000 && !(+r.vat) && r.at === 4000, r);
}

// ── A4 an old-build record (only `at`) merges for Workers on its `at` ──
{
	const A = device();
	A.put(ID, { provider: 'p', model: 'M', workerProvider: 'p', workerModel: 'W', at: S });
	const newer = { provider: 'p', model: 'M', workerProvider: 'q', workerModel: 'W-old-build', visionProvider: '',
		visionModel: '', effort: '', effortProvider: '', effortModel: '', at: S + 100, eat: 0 };
	check('A4 a newer old-build record is adopted for Workers', A.adoptDiamondModel(ID, copy(newer), false) === true
		&& A.rec(ID).workerModel === 'W-old-build', A.rec(ID));
	const B = device();
	B.put(ID, { provider: 'p', model: 'M', workerProvider: 'p', workerModel: 'W', at: S });
	const older = Object.assign({}, newer, { at: S - 100 });
	check('A4 an older old-build record changes nothing', B.adoptDiamondModel(ID, copy(older), false) === false
		&& B.rec(ID).workerModel === 'W', B.rec(ID));
	// A record that never had a Workers or Images pick travels as the same bytes as before.
	const C = device();
	C.clock.t = 2000;
	C.setDiamondModel(ID, { provider: 'p', model: 'M' });
	check('A4 a record with no Workers or Images pick carries no wat or vat',
		!('wat' in C.rec(ID)) && !('vat' in C.rec(ID)), C.rec(ID));
}

// ── A4b `at` is the half's clock and `dat` the daimon pair's (D-20261018-09 S) ──
{
	// A Workers pick on a Diamond that follows the default: `at` moves for old builds, and the
	// daimon pair is held unstamped as `dat` 0, which is a stamp, not an absence.
	const A = device();
	A.clock.t = 2000;
	A.setDiamondModel(ID, { workerProvider: 'p', workerModel: 'W' });
	check('A4b a Workers pick alone moves at and holds dat 0', A.rec(ID).at === 2000 && A.rec(ID).dat === 0 && A.rec(ID).wat === 2000, A.rec(ID));
	// Another device's earlier daimon pick still outranks the unstamped daimon pair.
	const B = device();
	B.clock.t = 1500;
	B.setDiamondModel(ID, { provider: 'p', model: 'M' });
	check('A4b a daimon pick alone writes no dat', !('dat' in B.rec(ID)) && B.rec(ID).at === 1500, B.rec(ID));
	A.adoptDiamondModel(ID, copy(B.rec(ID)), false);
	check('A4b the daimon pick lands over dat 0, the Workers pick stays', A.rec(ID).model === 'M' && A.rec(ID).workerModel === 'W'
		&& A.rec(ID).at === 2000 && A.rec(ID).dat === 1500, A.rec(ID));
	B.adoptDiamondModel(ID, copy(A.rec(ID)), false);
	check('A4b both devices hold the same bytes', JSON.stringify(A.rec(ID)) === JSON.stringify(B.rec(ID)), [A.rec(ID), B.rec(ID)]);
}

// ── A5 an Effort-only change still moves `eat` alone ──
{
	const A = device();
	A.clock.t = 2000;
	A.setDiamondModel(ID, { provider: 'p', model: 'M', workerProvider: 'p', workerModel: 'W',
		visionProvider: 'p', visionModel: 'V' });
	const before = copy(A.rec(ID));
	A.clock.t = 3000;
	A.setDiamondModel(ID, { effort: 'high', effortProvider: 'p', effortModel: 'M' });
	const r = A.rec(ID);
	check('A5 an Effort change moves eat alone', r.eat === 3000 && r.at === before.at && r.wat === before.wat
		&& r.vat === before.vat, [before, r]);
}

// ── Invariants ──
{
	const A = device();
	A.setDiamondModel(ID, { provider: '', model: '' });
	check('a Diamond with no record and nothing to say writes none', A.rec(ID) === undefined, A.raw());
	A.put(ID, { provider: 'p', model: 'M', at: S });
	check('an absent record never clears a present one', A.adoptDiamondModel(ID, null, true) === false
		&& A.rec(ID).model === 'M');
	A.put(ID, { provider: 'p', model: 'M', workerProvider: 'p', workerModel: 'W', at: S, wat: S });
	check('an unstamped Workers half never beats a stamped one',
		A.adoptDiamondModel(ID, { workerProvider: 'q', workerModel: 'X' }, true) === false && A.rec(ID).workerModel === 'W',
		A.rec(ID));
}

console.log('\n' + (checks - failures) + '/' + checks + ' passed' + (failures ? ', ' + failures + ' FAILED' : ''));
process.exit(failures ? 1 : 0);
