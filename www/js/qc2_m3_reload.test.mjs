/* ============================================================
   Test -- U3a QA2 confirm (qc2), M3 across a reload: a timed_out worker's
   app sentence must not seed a Resume made after the page reloads.
   ------------------------------------------------------------
   `Workers.resume` says it "works even after a reload". The fix subtracts
   `run.said` from `run.text`, but `persistNow` stores `text` and not `said`,
   so after `load` the sentence is back in the worker's "own words".
   Runs the REAL persistNow, load, resume and the seed block of start().
   ============================================================ */
import { readPage } from '../../dev/pagesrc.mjs';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
// The REAL agent grid helper the Workers record's stampEnds calls (r570s).
globalThis.DaimondAgentGrid = createRequire(import.meta.url)('./agentgrid.js');

const DAIMOND = readPage(new URL('./daimond.js', import.meta.url), 'utf8');
let ok = 0, bad = 0;
const check = (name, cond, detail) => {
	if (cond) { ok++; console.log('  ok   ' + name); }
	else { bad++; console.log('  FAIL ' + name + (detail ? '  -- ' + detail : '')); }
};
function lift(name) {
	const a = DAIMOND.indexOf('\tfunction ' + name + '(');
	const b = DAIMOND.indexOf('\n\t}\n', a);
	return a < 0 || b < 0 ? '' : DAIMOND.slice(a, b + 3);
}
function liftMethod(name) {
	const a = DAIMOND.indexOf('\t\t' + name + ': function () {');
	const b = DAIMOND.indexOf('\n\t\t},', a);
	return DAIMOND.slice(a + ('\t\t' + name + ': ').length, b + 4).replace(/,$/, '');
}
function liftResume() {
	const a = DAIMOND.indexOf('\t\tresume: function (run) {');
	const b = DAIMOND.indexOf('\n\t\t},', a);
	return DAIMOND.slice(a + '\t\tresume: '.length, b + 4).replace(/,$/, '');
}
function liftSeed() {
	const a = DAIMOND.indexOf('} else if (run.resume) {');
	// Up to `seedSession`, the one restore every app of the run gets (qr1 #2): the seed is made above it.
	const b = DAIMOND.indexOf('seedSession = function', a);
	return DAIMOND.slice(a + '} else if (run.resume) {'.length, b) + 'run.app.restore(seed);';
}
const RESUMABLE = eval((DAIMOND.match(/var RESUMABLE_ENDINGS = (\[[^\]]*\]);/) || [])[1]);
const helper = lift('workerProse');
const SAID = 'The model made no progress for 120.0 s, so this worker was stopped.';

const store = {};
globalThis.localStorage = { setItem(k, v) { store[k] = v; }, getItem(k) { return store[k] ?? null; } };
globalThis.window = { addEventListener() {} };
const env = 'var WORKERS_KEY="daimond-workers"; var lastHold; function migrateWorkerHold(){} function workersHeld(){return null;}'
	+ ' function dsEvent(){} function readJson(k,f){var v=localStorage.getItem(k);return v==null?f:JSON.parse(v);}\n' + helper;
const mk = (src) => new Function('RESUMABLE_ENDINGS', env + '\nreturn (' + src + ');')(RESUMABLE);
const persistNow = mk(liftMethod('persistNow')), load = mk(liftMethod('load')), resume = mk(liftResume()), stampEnds = mk(liftMethod('stampEnds'));
const W = () => ({ runs: [], queue: [], seq: 1, dropped: 0, PERSIST_MAX_CHARS: 1e9, FINISHED_KEEP: 40,
	prune() { return false; }, pinned() { return false; }, persist() {}, render() {}, pump() {}, persistNow() { persistNow.call(this); }, stampEnds });

for (const [label, mine] of [['said nothing', ''], ['did speak', 'I read three of the five files.']]) {
	console.log('a timed_out worker that ' + label + ', resumed after a reload');
	const a = W();
	a.runs = [{ id: 'w1', name: 'n', task: 'Survey the notes', status: 'timed_out', text: mine + '\n' + SAID, said: [SAID], tools: [] }];
	persistNow.call(a);
	const b = W();
	load.call(b);
	const run = b.runs[0];
	resume.call(b, run);
	check('queued', run.status === 'queued', run.status);
	let seed = null;
	run.app = { restore(s) { seed = s; } };
	if (run.resume) new Function('run', helper + '\n' + liftSeed())(run);
	const asst = (seed || []).filter((m) => m.role === 'assistant').map((m) => m.content).join('\n');
	if (!mine) check('started over (run.resume false)', run.resume === false, 'run.resume=' + run.resume + ' said=' + JSON.stringify(run.said));
	check("the app's sentence is not seeded", asst.indexOf(SAID) < 0, JSON.stringify(seed));
}

// The start() hold branch: a queued worker held by a pause gets the app's pause sentence as its
// whole `run.text`, and nothing on `run.said`; Resume then seeds it as the worker's own words.
console.log('a worker held by a pause at start, then resumed');
{
	const a0 = DAIMOND.indexOf('if (window.DaimondModels && DaimondModels.held(runNode)) {');
	const b0 = DAIMOND.indexOf('return;', a0);
	const branch = DAIMOND.slice(a0, b0) + 'return; }';
	const PAUSE = 'Survey is paused. No turn started, nothing spent. Press play on it to resume.';
	const run = { id: 'w2', task: 'Survey the notes', status: 'queued', text: 'I read three of the five files.', tools: [] };
	const self = { active: 1, render() {}, pump() {} };
	new Function('run', 'runNode', 'window', 'DaimondModels', 'friendlyError', 'closeEarly', branch)
		.call(self, run, 'd1', { DaimondModels: 1 }, { held: () => true, pauseError: () => new Error(PAUSE) },
			(e) => String(e && e.message || e), () => {});
	check('held: status paused', run.status === 'paused', run.status);
	const b = W();
	resume.call(b, run);
	let seed = null;
	run.app = { restore(s) { seed = s; } };
	if (run.resume) new Function('run', helper + '\n' + liftSeed())(run);
	const asst = (seed || []).filter((m) => m.role === 'assistant').map((m) => m.content).join('\n');
	check("the pause sentence is not seeded as the worker's words", asst.indexOf(PAUSE) < 0, JSON.stringify(seed));
}
console.log(`\nM3 across a reload (qc2): ${ok} ok, ${bad} failed`);
process.exit(bad ? 1 : 0);
