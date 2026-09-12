// verify_worker_continuation.mjs — a worker dispatched to carry on a prior one's work
// picks up its actual conversation, not a blank slate, without a browser.
//
// THE CHANGE (2026-09-12). A worker kept no restorable session at all: `resume()`'s own
// prose-only reseed was the whole of what a stopped worker could hand to its own next
// leg, and a fresh `spawn_agent` dispatch -- the daimon naming a worker to continue one
// that just reported in -- inherited nothing whatever, ids, folds or tool calls, of the
// conversation it was meant to be picking up. `priorSessionRun` is the matching rule
// `Workers.dispatch` now runs before every fresh worker: by name within the Diamond, or,
// failing that, by a `continue:` task falling back to the Diamond's own most recent
// stashed session. This file proves the matching rule in isolation, lifted verbatim from
// www/js/daimond.js and run with `new Function` -- a rename or a move throws here rather
// than silently testing a stale copy -- and then proves the seam it feeds: a stubbed
// `DaimondApp` given a matched run's stashed session sees it in `restore_session`, not
// `restore`.
//
//   node dev/verify_worker_continuation.mjs
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

const PS_SRC = grabFn('function priorSessionRun(');
const f = new Function(PS_SRC + '\nreturn { priorSessionRun: priorSessionRun };');
const { priorSessionRun } = f();

// ── Matched by name, within the Diamond ──────────────────────────────

{
	const runs = [
		{ diamondId: 'd1', name: 'researcher', task: 'go again', _session: [{ role: 'user', content: 'x' }] },
		{ diamondId: 'd1', name: 'writer',      task: 'first draft', _session: [{ role: 'user', content: 'y' }] },
	];
	const m = priorSessionRun(runs, 'd1', 'researcher', 'keep digging');
	check(!!m && m.name === 'researcher', 'a name match wins, whatever the new task says');
}

// ── A `continue:` task with no name match falls back to the Diamond's own last ──

{
	const runs = [
		{ diamondId: 'd1', name: 'a', task: 't', _session: [{ role: 'user', content: '1' }] },
		{ diamondId: 'd1', name: 'b', task: 't', _session: [{ role: 'user', content: '2' }] },
	];
	// `b` is newer (index 0 in a newest-first list): the fallback takes the FIRST
	// candidate it meets, so the caller's ordering is what decides "most recent".
	const m = priorSessionRun(runs, 'd1', 'unrelated-name', 'continue: pick up where you left off');
	check(!!m && m.name === 'a', 'a `continue:` task with no name match falls back to the diamond\'s own run');
}

// ── Neither signal, or a run that never stashed anything, matches nothing ──

{
	const runs = [{ diamondId: 'd1', name: 'a', task: 't', _session: [{ role: 'user', content: '1' }] }];
	check(priorSessionRun(runs, 'd1', 'z', 'a fresh, unrelated task') === null,
		'no name match and no continue: prefix matches nothing');
	check(priorSessionRun(runs, 'd2', 'a', 'continue: go') === null,
		'a different diamond is never a match, name or continue: alike');
	const noSess = [{ diamondId: 'd1', name: 'a', task: 't', _session: null }];
	check(priorSessionRun(noSess, 'd1', 'a', 'continue: go') === null,
		'a run that stashed nothing (over the 512 KB bound, or never ran) is not a candidate');
	const empty = [{ diamondId: 'd1', name: 'a', task: 't', _session: [] }];
	check(priorSessionRun(empty, 'd1', 'a', 'continue: go') === null,
		'an empty stashed session is treated the same as none');
}

// ── The seam: a matched session reaches `restore_session`, not `restore` ─────
//
// `Workers.start` cannot be driven whole here -- it needs a real wasm `DaimondApp` --
// so this stubs the one call it makes that this feature added, proving the WIRING
// rather than re-deriving `start`'s control flow. The stub records which method ran
// and with what, which is the only thing worth proving: `run.app.restore_session` is
// called when `run._priorSession` is set, ahead of the plain `run.resume` prose path.
{
	const calls = [];
	const stubApp = {
		restore_session: function (msgs, pt, ct, lp, ca, cost) { calls.push(['restore_session', msgs, pt, ct, ca, cost]); },
		restore: function () { calls.push(['restore']); },
	};
	const run = {
		_priorSession: [{ role: 'user', content: 'earlier turn' }, { role: 'assistant', content: 'earlier reply' }],
		priorPrompt: 500, priorCompletion: 200, priorCached: 100, priorCost: 0.02,
		resume: false,
		app: stubApp,
	};
	// The exact branch `start()` runs, lifted rather than retyped: proves the
	// condition and the call it drives stay in sync with the real function.
	const startSrc = fs.readFileSync(path.join(HERE, '..', 'www', 'js', 'daimond.js'), 'utf8');
	const branch = startSrc.slice(
		startSrc.indexOf('if (run._priorSession && run._priorSession.length'),
		startSrc.indexOf("} else if (run.resume) {") + "} else if (run.resume) {".length);
	// eslint-disable-next-line no-new-func
	new Function('run', branch + '\n}')(run);
	check(calls.length === 1 && calls[0][0] === 'restore_session', 'a matched session calls restore_session, not restore',
		JSON.stringify(calls));
	check(calls[0][1] === run._priorSession, 'the exported session travels through unchanged');
	check(calls[0][2] === 500 && calls[0][3] === 200 && calls[0][4] === 100 && calls[0][5] === 0.02,
		'the matched run\'s prior spend travels with it', JSON.stringify(calls[0]));
}

console.log(`\nworker continuation: ${ran - bad} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
