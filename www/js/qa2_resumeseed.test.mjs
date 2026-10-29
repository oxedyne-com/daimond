/* ============================================================
   Test -- U3a QA2 finding 1 (UNBLOCK-16): a timed_out Resume must not seed
   the app's own sentence as the worker's prior answer.
   ------------------------------------------------------------
   A worker whose first round goes silent twice ends `timed_out`, and the sink
   appends the app's sentence ("The model made no progress ...") to `run.text`,
   keeping a copy in `run.said`. Resume used to test `run.text` for emptiness and
   seed it whole as the assistant's turn, so a worker that produced NOTHING was
   "continued" from the app's audit, read as its own words.

   Runs the REAL `Workers.resume` and the REAL seed block of `start()`, lifted out
   of daimond.js, with the shared `workerProse` helper when it exists.
   ============================================================ */
import { readPage } from '../../dev/pagesrc.mjs';
import { readFileSync } from 'node:fs';

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

// `Workers.resume`, as the object literal holds it.
function liftResume() {
	const a = DAIMOND.indexOf('\t\tresume: function (run) {');
	const b = DAIMOND.indexOf('\n\t\t},', a);
	if (a < 0 || b < 0) return null;
	return DAIMOND.slice(a + '\t\tresume: '.length, b + 4).replace(/,$/, '');
}

// The `run.resume` branch of `start()`: everything from the seed to the restore.
function liftSeed() {
	const a = DAIMOND.indexOf('} else if (run.resume) {');
	// Up to `seedSession`, the one restore every app of the run gets (qr1 #2): the seed is made above it.
	const b = DAIMOND.indexOf('seedSession = function', a);
	if (a < 0 || b < 0) return null;
	return DAIMOND.slice(a + '} else if (run.resume) {'.length, b) + 'run.app.restore(seed);';
}

const RESUMABLE = (DAIMOND.match(/var RESUMABLE_ENDINGS = (\[[^\]]*\]);/) || [])[1];
const helper = lift('workerProse');
const SAID = 'The model made no progress for 120.0 s, so this worker was stopped.';

function resumeRun(run) {
	const W = { queue: [], persist() {}, render() {}, pump() {} };
	const fn = new Function('RESUMABLE_ENDINGS', helper + '\nreturn (' + liftResume() + ');')(eval(RESUMABLE));
	fn.call(W, run);
	return W;
}

function seedOf(run) {
	let seed = null;
	run.app = { restore(s) { seed = s; } };
	new Function('run', helper + '\n' + liftSeed())(run);
	return seed;
}

check('resume() and the seed block are found', !!liftResume() && !!liftSeed() && !!RESUMABLE);

console.log('a timed_out worker that said nothing: started over, not continued');
{
	const run = { status: 'timed_out', task: 'Survey the notes', text: '\n' + SAID, said: [SAID] };
	resumeRun(run);
	check('queued', run.status === 'queued', run.status);
	check('run.resume is false (nothing of its own to continue)', run.resume === false, 'run.resume=' + run.resume);
}

console.log('a timed_out worker that did speak: the seed is its words alone');
{
	const mine = 'I read three of the five files.';
	const run = { status: 'timed_out', task: 'Survey the notes', text: mine + '\n' + SAID, said: [SAID] };
	resumeRun(run);
	check('run.resume is true', run.resume === true, 'run.resume=' + run.resume);
	const seed = seedOf(run);
	const asst = (seed || []).filter((m) => m.role === 'assistant');
	check('one assistant turn in the seed', asst.length === 1, JSON.stringify(seed));
	check("the app's sentence is not in it", asst.length === 1 && asst[0].content.indexOf(SAID) < 0,
		asst[0] && asst[0].content);
	check("the worker's own words are", asst.length === 1 && asst[0].content.indexOf(mine) >= 0);
}

console.log('a paused worker with no app sentence: unchanged');
{
	const run = { status: 'paused', task: 't', text: 'Half way.' };
	resumeRun(run);
	check('run.resume is true', run.resume === true);
	const seed = seedOf(run);
	check('seeded with its text', !!seed && seed.length === 2 && seed[1].content === 'Half way.', JSON.stringify(seed));
}

console.log(`\nresume seed (U3a QA2 #1): ${ok} ok, ${bad} failed`);
process.exit(bad ? 1 : 0);
