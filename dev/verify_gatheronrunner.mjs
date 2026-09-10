// verify_gatheronrunner.mjs — a handed-off agentic turn's GATHER round runs ON THE
// RUNNER, and the errand reports `done` only AFTER it has settled.
//
// The bug (construct B, an ordinary agentic chat handed to a runner): the runner
// reconstructs the chat into a DETACHED `ctx.chat` and never sets the on-screen
// `current`, so `deliverToChat`'s `current === chat` guard was false and the
// worker-gather round NEVER ran on the device executing the turn. Meanwhile
// `runErrand` had already pushed, posted `done` and released the lease -- so the
// dispatcher believed the turn finished while the agent had stalled mid-iteration
// with already-paid-for worker output stranded in the runner's local transcript.
//
// The fix, both halves, is asserted here against the SHIPPED bodies (pulled out of
// www/js/daimond.js by literal slice, the verify_streammerge method), driven in pure
// node -- the logic is pure over Workers/chats/_runnerCtx/current, so no DOM, no wasm,
// no browser, no world:
//   (a) `chatShowingOrRunning` admits the runner (a live errand names the chat), so
//       the gather round runs against the reconstructed ctx.chat;
//   (b) `drainAgenticRounds` waits for the whole fan-out to settle, so `done` is
//       posted after the real end of the turn -- and it re-dispatches NOTHING, so it
//       introduces no double-run when the dispatcher later syncs.
//
//   node dev/verify_gatheronrunner.mjs
//   node dev/verify_gatheronrunner.mjs --break noadmit   # must fail something
//   node dev/verify_gatheronrunner.mjs --break nowait    # must fail something
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC  = readFileSync(join(HERE, '..', 'www/js/daimond.js'), 'utf8');

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return (i >= 0 && process.argv[i + 1]) ? process.argv[i + 1] : '';
})();
const BREAKS = ['noadmit', 'nowait'];
if (BREAK && !BREAKS.includes(BREAK)) {
	console.error(`unknown break '${BREAK}'; one of: ${BREAKS.join(', ')}`);
	process.exit(2);
}

// Pull a function out by name, verbatim -- `function NAME(` or `async function NAME(`
// at one-tab indent -- so this tests the shipped body and not a paraphrase.
function slice(name) {
	let start = SRC.indexOf('\tfunction ' + name + '(');
	if (start < 0) start = SRC.indexOf('\tasync function ' + name + '(');
	if (start < 0) throw new Error('could not find ' + name);
	let i = SRC.indexOf('{', start);
	let depth = 0, end = -1;
	for (; i < SRC.length; i++) {
		if (SRC[i] === '{') depth++;
		else if (SRC[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
	}
	return SRC.slice(start, end);
}

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The shared runner state the sliced bodies read. One set of objects, mutated over the
// life of a scenario the way the app mutates it: workers finish, the batch is deleted,
// a round goes pending then busy, the answer lands.
const Workers = { runs: [], batches: {}, roundPending: {} };
const chats   = [];
const _runnerCtx = {};

// Bind the sliced bodies over those objects and a chosen `current`. `current` is a
// scalar the shipped code reads by bare name, so it is bound at build time; the mutable
// objects above are shared refs, so a rebuild sees the same evolving state. Tiny settle
// caps make the timing tests run in well under a second.
function build(current, { absCap = 4000, stallCap = 500 } = {}) {
	// eslint-disable-next-line no-new-func
	const factory = new Function(
		'Workers', 'chats', '_runnerCtx', 'current',
		'AGENTIC_SETTLE_ABS_CAP_MS', 'AGENTIC_SETTLE_STALL_MS',
		slice('chatIsActiveErrand') + '\n'
		+ slice('chatShowingOrRunning') + '\n'
		+ slice('chatAgenticActive') + '\n'
		+ slice('chatAgenticProgressing') + '\n'
		+ slice('drainAgenticRounds') + '\n'
		+ 'return { chatIsActiveErrand, chatShowingOrRunning, chatAgenticActive,'
		+ ' chatAgenticProgressing, drainAgenticRounds };');
	return factory(Workers, chats, _runnerCtx, current, absCap, stallCap);
}

// The PRE-FIX guard, for the negative half: the bare `current === chat` that stranded
// the runner. `--break noadmit` runs the real checks against this so a green run proves
// the admission is doing the work, not that any function would pass.
function preFixShowingOrRunning(current) {
	return function (chat) {
		if (!chat) return false;
		return !!(current && current.id === chat.id);
	};
}
// The PRE-FIX runner turn: it does NOT wait for the fan-out. `--break nowait` runs the
// timing checks against this stub, which must fail them.
async function preFixDrain(/* chat */) { /* returns at once, fan-out unresolved */ }

function reset() {
	Workers.runs.length = 0;
	Workers.batches = {};
	Workers.roundPending = {};
	chats.length = 0;
	for (const k of Object.keys(_runnerCtx)) delete _runnerCtx[k];
}

// ── (a) The gather round is admitted on the runner, not only on screen ──────────
{
	reset();
	const chat = { id: 'c1', _generating: false };
	chats.push(chat);

	// On screen: the reader is looking at c1.
	const onscreen = build({ id: 'c1' }).chatShowingOrRunning(chat);
	check('a gather round is admitted when the chat is ON SCREEN', onscreen === true);

	// Runner: no on-screen `current` at all, but a live errand names c1.
	_runnerCtx['t1'] = { turnId: 't1', chatId: 'c1' };
	const admit = BREAK === 'noadmit'
		? preFixShowingOrRunning(null)(chat)
		: build(null).chatShowingOrRunning(chat);
	check('and admitted on the RUNNER — a live errand names the chat, though `current` is null',
		admit === true, admit ? 'admitted' : 'STRANDED (pre-fix behaviour)');

	// The guard still bites: a chat neither on screen nor running here is refused, so a
	// round is never spent on a surface the user walked away from that no runner holds.
	delete _runnerCtx['t1'];
	const idle = build({ id: 'other' }).chatShowingOrRunning(chat);
	check('but a chat neither on screen nor an active errand here is still refused',
		idle === false);
}

// ── (b) `done` is posted only AFTER the fan-out settles ─────────────────────────
{
	reset();
	const chat = { id: 'c1', _generating: false };
	chats.push(chat);
	// The errand turn has just ended having fanned out two workers: they are running and
	// their batch awaits its last worker. This is the state `drainAgenticRounds` inherits.
	Workers.runs.push({ id: 'w1', chatId: 'c1', status: 'running' });
	Workers.runs.push({ id: 'w2', chatId: 'c1', status: 'running' });
	Workers.batches['b1'] = { chatId: 'c1', expected: 2 };

	const api = build(null);
	check('the runner sees the fan-out as active while its workers run',
		api.chatAgenticActive('c1') === true);

	let gatherRan = false;
	let resolvedAt = 0;
	const t0 = Date.now();
	const drain = (BREAK === 'nowait' ? preFixDrain(chat) : api.drainAgenticRounds(chat))
		.then(() => { resolvedAt = Date.now(); });

	// While the workers run, the errand must NOT be reported done.
	await sleep(200);
	check('`done` is withheld while the workers are still running',
		resolvedAt === 0, resolvedAt ? 'reported done mid-fan-out' : 'withheld');

	// The workers finish. `deliverToChat` deletes the batch and marks a round pending in
	// the SAME macrotask, so there is no idle gap; the round has not gone busy yet.
	Workers.runs.forEach((r) => { r.status = 'done'; });
	delete Workers.batches['b1'];
	Workers.roundPending['c1'] = true;
	await sleep(200);
	check('`done` is still withheld across the gap before the gather round goes busy',
		resolvedAt === 0, resolvedAt ? 'reported done before the round ran' : 'withheld');

	// The gather round runs: it reads the reports and answers. (Here it produces the
	// final answer and dispatches nothing further.)
	chat._generating = true;
	delete Workers.roundPending['c1'];
	gatherRan = true;
	await sleep(200);
	check('`done` is withheld while the gather round itself is generating',
		resolvedAt === 0);

	// The round ends with the answer in the transcript and no new fan-out: settled.
	chat._generating = false;

	await drain;
	check('`done` is posted only once the fan-out has fully settled',
		resolvedAt > 0 && gatherRan && !api.chatAgenticActive('c1'),
		resolvedAt ? `after ${resolvedAt - t0}ms` : 'never');
	check('and the gather round had run before it was posted (worker output delivered, not stranded)',
		gatherRan === true);
}

// ── (c) No double-run: the drain is observational, and scoped to this chat ──────
{
	reset();
	const chat = { id: 'c1', _generating: false };
	chats.push(chat);
	// A running worker of a DIFFERENT chat, and a Diamond worker (no chatId). Neither is
	// this chat's, so neither may hold this chat's drain open or be re-run by it.
	Workers.runs.push({ id: 'wA', chatId: 'other', status: 'running' });
	Workers.runs.push({ id: 'wD', chatId: '', status: 'running' });
	// A spy: the drain must call nothing that dispatches. It only reads state.
	let dispatches = 0;
	Workers.dispatch = () => { dispatches++; };

	const api = build(null);
	check('an idle chat with only OTHER chats\' workers live is not seen as active',
		api.chatAgenticActive('c1') === false);

	const t0 = Date.now();
	await api.drainAgenticRounds(chat);		// returns at once: c1 has nothing in flight
	check('the drain returns at once for a turn that fanned out nothing of its own',
		Date.now() - t0 < 100);
	check('the drain re-dispatches nothing — it cannot introduce a double-run',
		dispatches === 0, `${dispatches} dispatch call(s)`);
}

// ── The bound: a fan-out wedged with nothing progressing hands back, never hangs ──
{
	reset();
	const chat = { id: 'c1', _generating: false };
	chats.push(chat);
	// A batch held open by a worker PARKED for a consent that will not come on a runner:
	// the batch stays (its last worker is not terminal) but nothing is progressing.
	Workers.runs.push({ id: 'wp', chatId: 'c1', status: 'paused' });
	Workers.batches['b1'] = { chatId: 'c1', expected: 1 };

	const api = build(null, { absCap: 60000, stallCap: 300 });
	check('a batch held open by a parked worker reads as active (nothing terminal it)',
		api.chatAgenticActive('c1') === true);
	check('but as NOT progressing, so the stall clock runs',
		api.chatAgenticProgressing('c1') === false);

	const t0 = Date.now();
	await api.drainAgenticRounds(chat);
	const took = Date.now() - t0;
	check('the drain hands the wedged turn back at the stall cap rather than hanging the lease',
		took >= 250 && took < 3000, `gave up after ${took}ms`);
}

// ── The absolute ceiling: a fan-out that never settles is bounded regardless ────
{
	reset();
	const chat = { id: 'c1', _generating: false };
	chats.push(chat);
	// A worker that stays 'running' for ever: progress keeps resetting the stall clock,
	// so only the ABSOLUTE cap can end this -- and it must, well under the lease deadline.
	Workers.runs.push({ id: 'wr', chatId: 'c1', status: 'running' });
	Workers.batches['b1'] = { chatId: 'c1', expected: 1 };

	const api = build(null, { absCap: 600, stallCap: 60000 });
	const t0 = Date.now();
	await api.drainAgenticRounds(chat);
	const took = Date.now() - t0;
	check('a fan-out that never settles is still bounded by the absolute cap',
		took >= 500 && took < 3000, `capped after ${took}ms`);
}

if (BREAK) {
	console.log(`\nbreak '${BREAK}': ${bad.length} check(s) failed`
		+ (bad.length ? '' : ' — NOTHING FAILED, so the checks above prove nothing'));
	process.exit(bad.length ? 0 : 1);
}
console.log(bad.length === 0 ? '\nall checks passed' : `\n${bad.length} check(s) FAILED`);
process.exit(bad.length === 0 ? 0 : 1);
