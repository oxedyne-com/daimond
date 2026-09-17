/* ============================================================
   Test — the "worker finished" handover: a STATUS, not an error,
   and recoverable by a LATER turn.
   ------------------------------------------------------------
   Three residuals of the fan-out handover, all measured here from
   the REAL www/js/daimond.js (methods extracted from source and
   driven against stubs -- no browser, no wasm):

     FIX 1  `tellDaimon` writes the transcript half as `note_log`,
            the app's NEUTRAL voice, and draws it with `appendNote`
            -- never `error_log` / `appendError`, which painted a
            normal handover in --danger red.

     FIX 2  The composed note is terse and in the house voice: one
            fact, one action, no scolding. Guarded at source, since
            the strings are inline in `gather`.

     FIX 3  `finishAwait` recovers a finished worker's report BY
            NAME: a name a later turn's ledger no longer holds is
            matched against THIS diamond's terminal runs and handed
            back; a stranger name lands in `unresolved` so the
            engine can refuse it by name.

   Run:  node www/js/workerfinish.test.mjs
         node www/js/workerfinish.test.mjs --break norecover  # FIX 3 lookup off
         node www/js/workerfinish.test.mjs --break aserror     # FIX 1 role reverted
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC  = readFileSync(join(HERE, 'daimond.js'), 'utf8');

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return (i >= 0 && process.argv[i + 1]) ? process.argv[i + 1] : '';
})();
const BREAKS = ['norecover', 'aserror'];
if (BREAK && !BREAKS.includes(BREAK)) {
	console.error(`unknown break '${BREAK}'; one of: ${BREAKS.join(', ')}`);
	process.exit(2);
}

let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) { console.log('  ok   ' + name); }
	else { console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); failures++; }
}

// ── Pull one `name: function (args) { body }` method out of the source ──
//
// A depth counter over braces, started at the method's opening `{`. The
// finishAwait / tellDaimon bodies carry no brace-bearing string or regex
// literal, so a naive count is exact for them.
function methodSource(name) {
	const head = new RegExp(name + ':\\s*function\\s*\\(([^)]*)\\)\\s*\\{');
	const m = head.exec(SRC);
	if (!m) throw new Error('method not found: ' + name);
	const args = m[1];
	let i = SRC.indexOf('{', m.index + m[0].length - 1);
	let depth = 0, start = i;
	for (; i < SRC.length; i++) {
		const c = SRC[i];
		if (c === '{') depth++;
		else if (c === '}') { depth--; if (depth === 0) break; }
	}
	return { args: args, body: SRC.slice(start + 1, i) };
}

// The body of a top-level `function NAME(args) { ... }`, brace-matched so a
// check on it cannot leak into the next function (e.g. a later friendlyError).
function funcBody(name) {
	const head = new RegExp('function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{');
	const m = head.exec(SRC);
	if (!m) throw new Error('function not found: ' + name);
	let i = m.index + m[0].length - 1, depth = 0, start = i;
	for (; i < SRC.length; i++) {
		const c = SRC[i];
		if (c === '{') depth++;
		else if (c === '}') { depth--; if (depth === 0) break; }
	}
	return SRC.slice(start + 1, i);
}

// Build a callable from an extracted method, with the closure's free names
// supplied as leading parameters, then the method's own args.
function build(name, freeNames, transform) {
	const { args, body } = methodSource(name);
	const src = transform ? transform(body) : body;
	const params = freeNames.concat(args.split(',').map(s => s.trim()).filter(Boolean));
	// eslint-disable-next-line no-new-func
	return new Function(...params, src);
}

// ── FIX 3: finishAwait recovers a finished worker by name ────────────
{
	// The break: neuter the diamond match so `find` returns nothing and every
	// name falls through to `unresolved` -- exactly the pre-fix behaviour.
	const transform = (body) => BREAK === 'norecover'
		? body.replace(/return String\(x\.diamondId[\s\S]*?self\.isTerminal\(x\.status\);/,
			'return false; // --break norecover')
		: body;
	const finishAwait = build('finishAwait', ['dsEvent'], transform);

	function run(w, how) {
		let out = null;
		const self = {
			awaiting: [w],
			runs: RUNS,
			isTerminal: (s) => ['done', 'error', 'stopped', 'capped', 'spend_cap'].includes(s),
			persist: () => {}, render: () => {},
		};
		w.resolve = (json) => { out = JSON.parse(json); };
		finishAwait.call(self, () => {}, w, how);
		return out;
	}

	const RUNS = [
		// A finished worker of diamond D1, dispatched by an EARLIER turn (turnId t0).
		{ id: 'w34', name: 'survey', status: 'done', diamondId: 'D1', turnId: 't0',
			costUsd: 0.2, ended: { rounds: 6, calls: 9 }, report: 'SURVEYBODY' },
		// A finished worker of a DIFFERENT diamond, to prove the match is scoped.
		{ id: 'w99', name: 'survey', status: 'done', diamondId: 'D2', turnId: 't0',
			costUsd: 9.9, ended: { rounds: 1, calls: 1 }, report: 'WRONGDIAMOND' },
		// Still running: never a match, never recovered.
		{ id: 'w40', name: 'live', status: 'running', diamondId: 'D1', turnId: 't1' },
	];

	// A LATER turn (t2) of D1 asks for `survey` and `ghost` by name.
	const res = run({ turn: 't2', ids: [], names: ['survey', 'ghost'], diamond: 'D1',
		at: Date.now() }, 'done');

	const gotSurvey = res.reports.find(r => r.id === 'w34');
	check('FIX3 a finished worker is recovered by name', !!gotSurvey,
		JSON.stringify(res.reports));
	check('FIX3 the recovered report is the right diamond’s',
		gotSurvey && gotSurvey.report === 'SURVEYBODY' && !res.reports.some(r => r.id === 'w99'),
		JSON.stringify(res.reports));
	check('FIX3 a stranger name lands in unresolved', res.unresolved.includes('ghost'),
		JSON.stringify(res.unresolved));
	check('FIX3 a matched name does NOT land in unresolved', !res.unresolved.includes('survey'),
		JSON.stringify(res.unresolved));
	check('FIX3 the recovered run is marked gathered (no re-deliver)',
		RUNS.find(r => r.id === 'w34').gathered === 't2');

	// A cancelled settle recovers nothing and reports every name as unresolved.
	const RUNS2 = RUNS;
	const cancelled = (() => {
		let out = null;
		const self = { awaiting: [], runs: RUNS2,
			isTerminal: (s) => ['done'].includes(s), persist: () => {}, render: () => {} };
		const w = { turn: 't3', ids: [], names: ['survey'], diamond: 'D1', at: Date.now(),
			resolve: (j) => { out = JSON.parse(j); } };
		build('finishAwait', ['dsEvent'], transform).call(self, () => {}, w, 'cancelled');
		return out;
	})();
	check('FIX3 a cancelled settle recovers nothing',
		cancelled.reports.length === 0 && cancelled.unresolved.includes('survey'));
}

// ── FIX 1: tellDaimon uses the neutral note role, on screen and stored ─
{
	// The break: put the old error role back, to prove the assertions bite.
	const transform = (body) => BREAK === 'aserror'
		? body.replace("role: 'note_log'", "role: 'error_log'")
			.replace('appendNote(text)', 'appendError(text)')
		: body;
	let noteText = null, errorText = null;
	const rec = { id: 'c1', session: { v: 1, msgs: [], upto: '', uptoTs: 0 }, messages: [] };
	const diamonds = [{ id: 'D1' }];
	const scope = {
		diamonds,
		daimonChat: () => rec,
		touchChat: () => {}, persistChats: () => {},
		newMid: () => 'mid1',
		appendNote: (t) => { noteText = t; },
		appendError: (t) => { errorText = t; },
		current: { id: 'c1' },
	};
	const tellDaimon = build('tellDaimon',
		Object.keys(scope), transform);
	const ok = tellDaimon.call({}, ...Object.values(scope), 'D1', 'Worker w34 finished. Report below.');

	check('FIX1 tellDaimon returns true on delivery', ok === true);
	const stored = rec.messages[rec.messages.length - 1];
	check('FIX1 the transcript half is stored as note_log', stored && stored.role === 'note_log',
		stored && stored.role);
	check('FIX1 it is NOT stored as error_log', !(stored && stored.role === 'error_log'));
	check('FIX1 on screen it goes through appendNote, not appendError',
		noteText !== null && errorText === null);
	// The MODEL half is unchanged: still a plain user message it reads next turn.
	const modelMsg = rec.session.msgs[rec.session.msgs.length - 1];
	check('FIX1 the model half stays a user message',
		modelMsg && modelMsg.role === 'user' && modelMsg.content.includes('Worker w34 finished'));
}

// ── FIX 1: appendNote does not paint the note in the error colour ────
{
	const noteBody = funcBody('appendNote');
	check('FIX1 appendNote uses the neutral compacted class, not chat-msg-error',
		noteBody.includes('chat-msg-compacted') && !noteBody.includes('chat-msg-error'));
	check('FIX1 appendNote does not run text through friendlyError (danger path)',
		!noteBody.includes('friendlyError'));
}

// ── FIX 2: the composed note is terse and in the house voice ─────────
//
// Guarded at source: the strings are inline in `gather`, which cannot be run
// without the whole worker pump. The point is that the NEW terse wording is
// present and the OLD scolding / shouting wording is gone.
{
	check('FIX2 prefix names the worker and says reports are below',
		SRC.includes("'Worker ' + names.join(', ') + ' finished. Report' + (one ? '' : 's')"));
	check('FIX2 did-work points at files, forbids re-dispatch',
		SRC.includes("it wrote no final report. Its work is in its files: read them; do not re-dispatch."));
	check('FIX2 ran-nothing invites a narrower re-dispatch',
		SRC.includes("it did nothing. Re-dispatch with a narrower task if it still matters."));
	check('FIX2 depth cap is stated as round N of N',
		SRC.includes("'this was round '") && SRC.includes("'. Do not dispatch again.\\n\\n'"));
	check('FIX2 no-model clause is terse', SRC.includes("'this diamond has no model to run on.'"));
	check('FIX2 busy clause is terse', SRC.includes("'the diamond was busy.'"));
	check('FIX2 the (no report) body carries the run’s figures',
		SRC.includes("'(no report -- ' + calls + ' tool calls, ' + rounds"));
	check('FIX2 the old shouting prefix is gone',
		!SRC.includes('HAS') || !SRC.includes('HAVE') || !SRC.includes('FINISHED, and no round was'));
	check('FIX2 the old "ask again with a narrower task" scold is gone',
		!SRC.includes('Ask again with a narrower task if the work still matters.'));
}

if (BREAK) {
	console.log(`\nbreak '${BREAK}': ${failures} check(s) failed`
		+ (failures ? '' : ' — NOTHING FAILED, so the checks above prove nothing'));
	process.exit(failures ? 0 : 1);
}
console.log(failures === 0
	? `\nworkerfinish: all ${checks} checks passed`
	: `\nworkerfinish: ${failures} of ${checks} checks FAILED`);
process.exit(failures === 0 ? 0 : 1);
