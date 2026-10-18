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

// ── J1 a following Diamond, default moved, next turn: one note, one reapply, no toast ──
{
	const A = device();
	let def = X;					// the default; the Diamond follows it, so its record holds no pick
	await A.turn(ID, def);			// a first turn: `ran` written, nothing said
	check('J1 a first turn writes no note', A.notes.length === 0, A.notes);
	check('J1 a first turn re-applies nothing', A.reapplied.length === 0, A.reapplied);
	check('J1 a first turn records the pair it ran on', HAS('noteModelInForce') && A.rec(ID)
		&& A.rec(ID).ranModel === X.model && A.rec(ID).ranProvider === X.provider && +A.rec(ID).rat > 0, A.rec(ID));
	check('J1 the record holds no pick: the Diamond still follows', !A.rec(ID) || !A.rec(ID).model, A.rec(ID));
	await A.turn(ID, def);
	check('J1 a second turn on the same pair writes no note', A.notes.length === 0, A.notes);
	A.clock.t = 2000;
	def = Y;						// the default moves; nothing writes to a follower
	check('J1 moving the default writes nothing yet', A.notes.length === 0 && A.reapplied.length === 0);
	await A.turn(ID, def);
	check('J1 the next turn writes exactly one note', A.notes.length === 1, A.notes);
	check('J1 the note names from and to', fromTo(A.notes[0], X, Y) && /tile\.model_change_note/.test(A.notes[0].note), A.notes[0]);
	check('J1 and re-applies the notes once', A.reapplied.length === 1 && A.reapplied[0] === ID, A.reapplied);
	check('J1 and toasts nothing', A.toasts.length === 0, A.toasts);
	await A.turn(ID, def);
	check('J1 the turn after says nothing more', A.notes.length === 1 && A.reapplied.length === 1, A.notes);
	// Same model id, another provider, is another model (§3 "Equal means").
	A.clock.t = 2500;
	await A.turn(ID, { provider: 'openrouter', model: Y.model });
	check('J1 the same id on another provider is a change', A.notes.length === 2, A.notes);
}

// ── J1 Change keeps its one receipt and writes no note; the next turn writes it ──
{
	const A = device();
	await A.turn(ID, X);
	A.clock.t = 3000;
	if (A.changeDiamondModel) await A.changeDiamondModel(ID, X, Y);
	check('J1 Change toasts its one receipt', A.toasts.length === 1 && /tile\.model_changed/.test(A.toasts[0]), A.toasts);
	check('J1 Change writes no note itself', A.notes.length === 0, A.notes);
	check('J1 Change stores the pick', A.rec(ID) && A.rec(ID).model === Y.model, A.rec(ID));
	const r0 = A.reapplied.length;
	await A.turn(ID, Y);
	check('J1 after Change, the next turn writes the one note', A.notes.length === 1 && fromTo(A.notes[0], X, Y), A.notes);
	check('J1 and re-applies once more', A.reapplied.length === r0 + 1, A.reapplied);
	check('J1 and no second toast', A.toasts.length === 1, A.toasts);
}

// ── J2 a turn running when the default moves finishes on its pair; the note comes next turn ──
{
	const A = device();
	let def = X;
	await A.turn(ID, def);
	A.clock.t = 4000;
	const set = { daimon: { provider: def.provider, model: def.model } };	// resolved once, at the start
	await A.turn(ID, set.daimon);		// turn 2 starts on X
	def = Y;							// the default moves while turn 2 runs
	await A.turn(ID, set.daimon);		// a gather round of turn 2 runs on the turn's own set
	check('J2 the running turn writes no note mid-turn', A.notes.length === 0, A.notes);
	check('J2 and still holds the old pair as the one it ran on', HAS('noteModelInForce') && A.rec(ID).ranModel === X.model, A.rec(ID));
	A.clock.t = 5000;
	await A.turn(ID, def);				// turn 3 resolves the new default
	check('J2 the next turn writes the note', A.notes.length === 1 && fromTo(A.notes[0], X, Y), A.notes);
	check('J2 and re-applies once', A.reapplied.length === 1, A.reapplied);
}

// ── J3 the pick changed on device B, B's `ran` arrives first: A writes no second note ──
{
	const A = device(), B = device();
	await A.turn(ID, X);
	// B holds A's record, `ran` X included, as a pull brings it.
	check('J3 B adopts A\'s ran', A.rec(ID) && B.adoptDiamondModel(ID, copy(A.rec(ID)), false) && B.rec(ID).ranModel === X.model, B.rec(ID));
	B.clock.t = 6000;
	B.setDiamondModel(ID, { provider: Y.provider, model: Y.model });	// the pick, on B
	await B.turn(ID, Y);
	check('J3 B writes the one note', B.notes.length === 1 && fromTo(B.notes[0], X, Y), B.notes);
	const took = A.adoptDiamondModel(ID, copy(B.rec(ID)), false);
	check('J3 A adopts B\'s pick and its ran', took && A.rec(ID).model === Y.model && A.rec(ID).ranModel === Y.model, A.rec(ID));
	A.clock.t = 7000;
	await A.turn(ID, Y);
	check('J3 A\'s next turn writes no second note', A.notes.length === 0, A.notes);
	// And the other order: A's own older `ran` never beats B's.
	const back = B.adoptDiamondModel(ID, copy(A.rec(ID)), false);
	check('J3 B keeps its ran', B.rec(ID).ranModel === Y.model, { back, rec: B.rec(ID) });
}

console.log((failures ? 'FAIL' : 'ok') + ' mmnote: ' + (checks - failures) + '/' + checks);
if (failures) process.exit(1);
