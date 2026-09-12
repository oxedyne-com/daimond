// verify_worker_status.mjs — a worker's tile status, and what `gather` says about it,
// honestly, without a browser.
//
// THE CHANGE (2026-09-12). A worker that hit its round or spend cap ended with
// `TurnEnd::Capped`/`SpendCapped` in the engine, but `start()` wrote `run.status = 'done'`
// regardless of how the turn actually stopped -- and `gather`'s report body is `_tail`,
// the text since the worker's last tool result, which a cap landing on a tool result
// leaves empty. The daimon read a silent "(no report)" from a worker that had, in fact,
// run out of rounds mid-answer, and re-dispatched a fresh one that started from nothing.
//
// `workerEndStatus` maps the engine's own `TurnEnd::wire()` word to the five statuses a
// worker's tile now carries; `workerEndingNote` is what `gather` appends to a worker's
// report heading for every one of them except `done`. Both are lifted verbatim from
// www/js/daimond.js and run with `new Function`, not retyped -- a rename or a move throws
// here rather than silently testing a stale copy.
//
//   node dev/verify_worker_status.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC  = fs.readFileSync(path.join(HERE, '..', 'www', 'js', 'daimond.js'), 'utf8');

let bad = 0, ran = 0;
const check = (pass, name, detail) => {
	ran++;
	if (!pass) bad++;
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

/// A function declaration by signature, brace-matched from its opening `{`. Same device as
/// dev/verify_report_cap.mjs's `grabFn`.
function grabFn(sig) {
	const start = SRC.indexOf(sig);
	if (start < 0) { console.error(`could not find '${sig}' in js/daimond.js`); process.exit(2); }
	const open = SRC.indexOf('{', start);
	let depth = 0, i = open;
	for (; i < SRC.length; i++) {
		const c = SRC[i];
		if (c === '{') depth++;
		else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
	}
	return SRC.slice(start, i);
}

const WC_SRC = grabFn('function withCommas(');
const WS_SRC = grabFn('function workerEndStatus(');
const WN_SRC = grabFn('function workerEndingNote(');
const f = new Function(WC_SRC + '\n' + WS_SRC + '\n' + WN_SRC
	+ '\nreturn { workerEndStatus: workerEndStatus, workerEndingNote: workerEndingNote };');
const { workerEndStatus, workerEndingNote } = f();

// ── The engine's wire word maps to the tile's own status word ───────

check(workerEndStatus('answered') === 'done', 'answered is done');
check(workerEndStatus('silent') === 'done', 'silent is done, not an unmapped ending');
check(workerEndStatus('stopped') === 'stopped', 'stopped carries straight through');
check(workerEndStatus('capped') === 'capped', 'capped is its own status, not folded into done');
check(workerEndStatus('spend_cap') === 'spend_cap', 'spend_cap is its own status, distinct from capped');
check(workerEndStatus('failed') === 'error', 'failed reads as error, the tile\'s own word');
check(workerEndStatus('something-unknown') === 'done', 'an unrecognised word still resolves, as done');

// ── `gather`'s heading names the ending honestly ─────────────────────

{
	const r = { status: 'done', ended: { rounds: 6 }, costUsd: 0.1234 };
	check(workerEndingNote(r) === '', 'a plain done answer gets no note at all');
}
{
	const r = { status: 'capped', ended: { rounds: 25 }, costUsd: 0.4567 };
	const note = workerEndingNote(r);
	check(note.indexOf('round cap') !== -1, 'a capped worker names the round cap', note);
	check(note.indexOf('25 rounds') !== -1, 'and how many rounds it ran', note);
	check(note.indexOf('0.4567') !== -1, 'and what it cost', note);
	check(note.indexOf('continue with resume') !== -1, 'and that it can be resumed', note);
}
{
	const r = { status: 'spend_cap', ended: { rounds: 9 }, costUsd: 2 };
	const note = workerEndingNote(r);
	check(note.indexOf('spend cap') !== -1, 'a spend-capped worker names the spend cap, not the round cap', note);
	check(note.indexOf('continue with resume') !== -1, 'and that it can be resumed', note);
}
{
	const r = { status: 'error', ended: null, costUsd: 0 };
	check(workerEndingNote(r) === ' — error', 'an errored worker says so plainly', workerEndingNote(r));
}
{
	const r = { status: 'stopped', ended: null, costUsd: 0 };
	check(workerEndingNote(r) === ' — stopped', 'a stopped (discarded) worker is not offered a resume');
}
{
	// No `ended` at all -- the turn produced no `ended` event, e.g. it failed before its
	// first round. `rounds` reads as 0 rather than throwing on a missing field.
	const r = { status: 'capped', costUsd: 0 };
	check(workerEndingNote(r).indexOf('after 0 rounds') !== -1, 'a missing `ended` does not throw; rounds reads as 0',
		workerEndingNote(r));
}

console.log(`\nworker status: ${ran - bad} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
