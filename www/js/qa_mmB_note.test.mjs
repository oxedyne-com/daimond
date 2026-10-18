/* ============================================================
   Test -- the model-change note and Notes.reapply move to a
   turn's start (D-20261018-09 U2c).
   ------------------------------------------------------------
   The history follows the model in force, not the button: at a
   daimon turn's start, where the pair it runs on is not the one
   its last turn ran on, the note is written and the notes are
   re-applied, with no toast. Change keeps its one receipt and
   writes no note of its own.

   The REAL functions are lifted from daimond.js and stamp.js
   (testlift.mjs) and run in one sandbox per device.
   `MM_SRC_REV=14ef947b` runs the same arms against the live
   record's code, which is how J1 is shown red.

   Run:  node www/js/mmnote.test.mjs
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
	'adoptDiamondModel', 'noteModelInForce', 'changeDiamondModel'],
	['DIAMOND_MODELS_KEY', 'DIAMOND_MODEL_HALF', 'DIAMOND_EFFORT_HALF']);
if (L.missing.length) console.log('  note: absent in this revision: ' + L.missing.join(', '));
const HAS = (name) => !L.missing.includes(name);

/// One device: its own storage, clock, history, toasts and reapply count, over the real code.
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
	const notes = [], toasts = [], reapplied = [];
	const app = { record_model_change: async (id, note) => { notes.push({ id, note }); } };
	const deps = {
		localStorage, Date: DateStub, DaimondStamp: win.DaimondStamp,
		Notes: { reapply: (id) => reapplied.push(id) },
		t: (k, a) => k + (a ? ' ' + JSON.stringify(a) : ''),
		toast: (m) => toasts.push(m),
		diag: () => {},
		DaimondModels: { effortAfterSwitch: () => ({ effort: '' }) },
		diamondEffort: () => '',
		resetDiamondApps: () => {},
		diamondApp: () => app,
		shortModel: (m) => m || '',
		effortClearedNote: () => '',
	};
	const names = Object.keys(deps);
	const api = new Function(...names, L.body + '\nreturn { diamondModels: diamondModels, setDiamondModel: setDiamondModel,'
		+ ' adoptDiamondModel: adoptDiamondModel,'
		+ ' noteModelInForce: typeof noteModelInForce === "function" ? noteModelInForce : null,'
		+ ' changeDiamondModel: typeof changeDiamondModel === "function" ? changeDiamondModel : null };'
	)(...names.map((n) => deps[n]));
	api.clock = clock; api.notes = notes; api.toasts = toasts; api.reapplied = reapplied; api.app = app;
	api.rec = (id) => api.diamondModels()[id];
	/// A daimon turn starting on `pair`: what `runSteer` does before its request.
	api.turn = async (id, pair) => { if (api.noteModelInForce) await api.noteModelInForce(id, pair, app); };
	return api;
}

const ID = 'dia-email';
const X  = { provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash' };
const Y  = { provider: 'fireworks',  model: 'accounts/fireworks/models/glm-5p3-flash' };
const copy = (r) => JSON.parse(JSON.stringify(r));
const fromTo = (n, a, b) => n && n.note.includes('"from":"' + a.model + '"') && n.note.includes('"to":"' + b.model + '"');

// ── QA-B N1: a Diamond with no `ran` (every Diamond on the day of deploy) gets its first Change noted ──
{
	const A = device();
	A.setDiamondModel(ID, { provider: X.provider, model: X.model, workerProvider: X.provider, workerModel: X.model });
	check('N1 pre-release record has no ran', !A.rec(ID).ranModel, A.rec(ID));
	A.clock.t = 3000;
	await A.changeDiamondModel(ID, X, Y);
	await A.turn(ID, Y);
	const n = A.notes.length;
	check('N1 the first Change after deploy reaches the history (note written at Change or next turn)',
		n === 1 && fromTo(A.notes[0], X, Y), A.notes);
}
// ── QA-B N2: a follower moved by the default before its first new-build turn ──
{
	const A = device();
	// follower: no record at all; ran 'X' many times on the old build. The migration at the
	// first new-build boot seeds its last-run pair with the default then in force, X
	// (`migrateInherit`; qa_mmB_migrate M2 checks the seed), as one stamped write.
	A.setDiamondModel(ID, { ranProvider: X.provider, ranModel: X.model });
	await A.turn(ID, Y);		// first new-build turn, default since moved X -> Y
	check('N2 a follower whose default moved before its first new-build turn gets a note', A.notes.length === 1 && fromTo(A.notes[0], X, Y), A.notes);
}
console.log((failures ? 'FAIL' : 'ok') + ' qa_note: ' + (checks - failures) + '/' + checks);
if (failures) process.exit(1);
