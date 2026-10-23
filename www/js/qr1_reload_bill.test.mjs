/* ============================================================
   Test -- U3a release QA (qr1): a worker cut off by a reload has its spend billed nowhere;
   app sentence must not seed a Resume made after the page reloads.
   ------------------------------------------------------------
   `Workers.resume` says it "works even after a reload". The fix subtracts
   `run.said` from `run.text`, but `persistNow` stores `text` and not `said`,
   so after `load` the sentence is back in the worker's "own words".
   Runs the REAL persistNow, load, resume and the seed block of start().
   ============================================================ */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
// The REAL agent grid helper the Workers record's stampEnds calls (r570s).
globalThis.DaimondAgentGrid = createRequire(import.meta.url)('./agentgrid.js');

const DAIMOND = readFileSync(new URL('./daimond.js', import.meta.url), 'utf8');
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
	const a = DAIMOND.indexOf('\t\t' + name + ': function (');
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
	const b = DAIMOND.indexOf('run.app.restore(seed', a);
	return DAIMOND.slice(a + '} else if (run.resume) {'.length, b) + 'run.app.restore(seed); } catch (e) {}';
}
const RESUMABLE = eval((DAIMOND.match(/var RESUMABLE_ENDINGS = (\[[^\]]*\]);/) || [])[1]);
const helper = lift('workerProse');
const SAID = 'The model made no progress for 120.0 s, so this worker was stopped.';

const store = {};
globalThis.localStorage = { setItem(k, v) { store[k] = v; }, getItem(k) { return store[k] ?? null; } };
globalThis.window = { addEventListener() {} };
const env = 'var WORKERS_KEY="daimond-workers"; var lastHold; function migrateWorkerHold(){} function workersHeld(){return null;}'
	+ ' function dsEvent(){} function readJson(k,f){var v=localStorage.getItem(k);return v==null?f:JSON.parse(v);}\n' + helper;

// The page that ran the worker is gone, so its run lock is free (U3a QRFIX2 F3: `settleCut`).
const navigator = { locks: { request: (n, o, cb) => Promise.resolve().then(() => cb({ name: n })) } };
const tick = () => new Promise((r) => setTimeout(r, 0));
const mk = (src) => new Function('navigator', 'RESUMABLE_ENDINGS', env + '\nreturn (' + src + ');')(navigator, RESUMABLE);
const persistNow = mk(liftMethod('persistNow')), load = mk(liftMethod('load')), settleCut = mk(liftMethod('settleCut')), resume = mk(liftResume()), stampEnds = mk(liftMethod('stampEnds'));
const W = () => ({ runs: [], queue: [], seq: 1, dropped: 0, PERSIST_MAX_CHARS: 1e9, FINISHED_KEEP: 40,
	prune() { return false; }, pinned() { return false; }, persist() {}, render() {}, pump() {}, persistNow() { persistNow.call(this); }, settleCut(r) { settleCut.call(this, r); }, stampEnds });


// A worker 14 minutes in, US$0.90 and 90k tokens spent on this leg, when the page reloads.
// `run.promptTokens` is written only in the `finally` (and the ledger only by `billAttempt`),
// so the record the reload leaves says the leg cost nothing. Resume then takes `prior*` from it.
console.log('a worker cut off by a reload mid-turn, then resumed');
{
	const a = W();
	const LIVE = { live_prompt_tokens: 90000, live_completion_tokens: 6000, live_cost_usd: 0.9 };
	a.runs = [{ id: 'w1', name: 'n', task: 'Survey the notes', status: 'running', text: 'I read three files.',
		said: [], tools: [], promptTokens: 0, completionTokens: 0, costUsd: 0, app: LIVE }];
	persistNow.call(a);
	const b = W();
	load.call(b);
	await tick();
	const run = b.runs[0];
	check('interrupted', run.status === 'interrupted', run.status);
	resume.call(b, run);
	check('the cut leg\'s spend reaches the resumed run\'s prior totals',
		run.priorPrompt === 90000 && run.priorCost === 0.9,
		'priorPrompt=' + run.priorPrompt + ' priorCost=' + run.priorCost + ' (the provider charged 90000 / US$0.90)');
}
console.log(`\nreload bill (qr1): ${ok} ok, ${bad} failed`);
process.exit(bad ? 1 : 0);
