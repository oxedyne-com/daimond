// verify_continue_resume.mjs — Continue RESUMES a turn, it does not re-run the prompt.
//
// THE DEFECT (dev/PERSISTENCE_STUDY.md §1.3 and §4.4 item 2). `continueTurn` used to tombstone
// every message of the interrupted turn — the partial reply included — drop `chat.app`, and call
// `runTurn(chat, text)` with the ORIGINAL prompt. Output tokens the user had already paid for were
// thrown away and bought again, and the answer they had been READING was replaced by a different
// one.
//
// THE FIX. When something arrived, the partial STAYS as an ordinary assistant message, its badge
// comes off, `chat.app` is nulled so `ensureApp` rebuilds the session from the messages that remain
// — which now end with the partial — and the model is asked to carry on with `CONTINUE_NUDGE`. Only
// the pre-token case, where nothing arrived and nothing was billed, still re-runs the prompt.
//
// WHAT THIS FILE PROVES, without a browser or a model: that `continueTurn` builds a RESUME payload
// carrying the partial (the partial kept, not tombstoned, and the continuation dispatched rather
// than the original prompt), that the empty case still re-runs, and that the idempotency guards
// hold. The real function is LIFTED from www/js/daimond.js and run against stubbed dependencies, so
// a change to the shipped logic is what this measures.
//
// The visible append itself — the continuation text landing after the retained partial — is
// runTurn's job and is covered in a real page by dev/verify_dropped.mjs and dev/verify_predrop.mjs.
// Here the claim is the DISPATCH: partial retained + continue message, not a bare re-run.
//
// PROVED AGAINST THE PRE-FIX DISPATCH. `--break rerun` flips the one deciding line — the resume
// branch's `runTurn(chat, CONTINUE_NUDGE)` back to `runTurn(chat, text)`, which is what the old
// code did — and runs the SAME checks. The two dispatch assertions in section A then fail, which
// is the proof they bite on the resume and not on something incidental:
//
//   node dev/verify_continue_resume.mjs --break rerun   # the resume-dispatch checks fail
//   node dev/verify_continue_resume.mjs                 # and then, clean
//
//   node dev/verify_continue_resume.mjs
//
// Needs nothing running.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC  = fs.readFileSync(path.join(HERE, '..', 'www', 'js', 'daimond.js'), 'utf8');

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();
if (BREAK && BREAK !== 'rerun') {
	console.error(`unknown break '${BREAK}'; the only one is 'rerun'`);
	process.exit(2);
}

let bad = 0, ran = 0;
const check = (pass, name, detail) => {
	ran++;
	if (!pass) bad++;
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

// ── Lift the real function and its nudge out of the source ───

/// A `var NAME = …;` statement, however many lines its right-hand side spans, up to the first `;`
/// that ends the statement. `CONTINUE_NUDGE` is a multi-line string concatenation with no `;`
/// inside its literals.
function grabVarStmt(name) {
	const start = SRC.indexOf('var ' + name + ' =');
	if (start < 0) { console.error(`could not find 'var ${name}' in js/daimond.js`); process.exit(2); }
	const end = SRC.indexOf(';', start);
	return SRC.slice(start, end + 1);
}

/// A function declaration by signature, brace-matched from its opening `{`.
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

const NUDGE_STMT = grabVarStmt('CONTINUE_NUDGE');
const CT_ORIG    = grabFn('function continueTurn(');   // the pristine lift, for the sentinels

// The source actually built. `--break rerun` flips the one deciding line to the pre-fix dispatch;
// the sentinels above still read CT_ORIG, so under break only the resume-dispatch checks fail.
let CT_SRC = CT_ORIG;
if (BREAK === 'rerun') {
	const from = 'runTurn(chat, CONTINUE_NUDGE);';
	if (CT_SRC.split(from).length !== 2) {
		console.error("the line '--break rerun' patches is not in continueTurn exactly once");
		process.exit(2);
	}
	CT_SRC = CT_SRC.replace(from, 'runTurn(chat, text);');
	console.log('\n*** RUNNING UNDER --break rerun: the resume-dispatch failures below are the point ***\n');
}

// Sentinels: a mis-lift or a rename must fail here, not silently test nothing. Read the pristine
// lift, so `--break rerun` leaves these green and trips only the dispatch checks in section A.
check(/CONTINUE_NUDGE/.test(CT_ORIG),
	'the lifted continueTurn references CONTINUE_NUDGE');
check(/runTurn\(chat, CONTINUE_NUDGE\)/.test(CT_ORIG),
	'and dispatches the continuation with runTurn(chat, CONTINUE_NUDGE)');
check(/runTurn\(chat, text\)/.test(CT_ORIG),
	'and keeps runTurn(chat, text) for the empty-partial case');

/// Build the real `continueTurn` with its free identifiers supplied as stubs. Everything else it
/// uses is a parameter or a local.
function makeContinueTurn(stubs) {
	const names = ['loadMsgTombs', 'msgTombstone', 'touchChat', 'persistChats', 'renderHistory', 'runTurn'];
	const f = new Function(
		...names,
		NUDGE_STMT + '\n' + CT_SRC + '\nreturn continueTurn;');
	return f(...names.map((n) => stubs[n]));
}

/// A spy set with sensible defaults; a test overrides `loadMsgTombs` where it needs to.
function spies(over) {
	const calls = { runTurn: [], msgTombstone: [] };
	const s = {
		loadMsgTombs:  () => ({}),
		msgTombstone:  (mids) => { calls.msgTombstone.push(mids); },
		touchChat:     () => {},
		persistChats:  () => {},
		renderHistory: () => {},
		runTurn:       (chat, text) => { calls.runTurn.push({ chat, text }); },
	};
	Object.assign(s, over || {});
	return { stubs: s, calls };
}

/// A fresh interrupted turn: the user's prompt and a half-written assistant answer, both tagged
/// with the same `iturn`.
function freshChat(partialText) {
	return {
		_generating: false,
		app: { marker: 1 },
		messages: [
			{ role: 'user',      iturn: 'T1', mid: 'u1', content: 'What is the capital of France?' },
			{ role: 'assistant', iturn: 'T1', mid: 'a1', interrupted: true, why: 'offline', content: partialText },
		],
	};
}

// The nudge value the real statement defines, to compare dispatch against it.
const NUDGE = new Function(NUDGE_STMT + '\nreturn CONTINUE_NUDGE;')();

console.log('the nudge is a real continuation instruction, distinct from any prompt');
check(typeof NUDGE === 'string' && NUDGE.length > 0, 'CONTINUE_NUDGE is a non-empty string');
check(NUDGE !== 'What is the capital of France?',
	'and it is not the original prompt', JSON.stringify(NUDGE.slice(0, 40)));

// ── A: something arrived → RESUME ────────────────────────────
console.log('\nA turn with a partial resumes, carrying the partial');
{
	const { stubs, calls } = spies();
	const ct = makeContinueTurn(stubs);
	const chat = freshChat('The capital of France is');
	ct(chat, 'T1', 'What is the capital of France?');

	check(calls.runTurn.length === 1 && calls.runTurn[0].text === NUDGE,
		'runTurn is called with the CONTINUE nudge',
		calls.runTurn.length ? JSON.stringify(String(calls.runTurn[0].text).slice(0, 40)) : 'not called');
	check(calls.runTurn.length === 1 && calls.runTurn[0].text !== 'What is the capital of France?',
		'and NOT with the original prompt — this is the whole fix');
	check(calls.msgTombstone.length === 0,
		'the partial is NOT tombstoned — it is being kept, not deleted from other devices');
	const asst = chat.messages.find((m) => m.mid === 'a1');
	check(!!asst && asst.content === 'The capital of France is',
		'the partial text is retained intact for the model to continue from',
		asst ? JSON.stringify(asst.content) : 'gone');
	check(!!asst && !('interrupted' in asst) && !('why' in asst),
		'and its badge is cleared — it is now an ordinary answer');
	check(chat.app === null,
		'chat.app is nulled so ensureApp rebuilds the session ENDING with the partial');
	check(chat.messages.filter((m) => m.role === 'user').length === 1,
		'the original prompt stays in the thread exactly once');
}

// ── B: nothing arrived → RE-RUN (the one right re-run) ───────
console.log('\na turn that died before the first token re-runs the prompt');
{
	const { stubs, calls } = spies();
	const ct = makeContinueTurn(stubs);
	const chat = freshChat('');           // no token ever came back
	ct(chat, 'T1', 'What is the capital of France?');

	check(calls.runTurn.length === 1 && calls.runTurn[0].text === 'What is the capital of France?',
		'runTurn is called with the ORIGINAL prompt — nothing to continue from',
		calls.runTurn.length ? JSON.stringify(String(calls.runTurn[0].text).slice(0, 40)) : 'not called');
	check(calls.runTurn.length === 1 && calls.runTurn[0].text !== NUDGE,
		'and NOT with the continue nudge — a model cannot continue an empty answer');
	check(calls.msgTombstone.length === 1,
		'the empty turn IS tombstoned, so the append-only merge cannot resurrect it beside the retry');
	check(chat.messages.filter((m) => m.iturn === 'T1').length === 0,
		'and its messages are dropped from this tab');
}

// ── C-F: the idempotency and safety guards ───────────────────
console.log('\nthe guards that stop a double-run or a wipe');
{
	// C. Already tombstoned by another tab: do nothing.
	const { stubs, calls } = spies({ loadMsgTombs: () => ({ u1: true, a1: true }) });
	const ct = makeContinueTurn(stubs);
	ct(freshChat('The capital of France is'), 'T1', 'What is the capital of France?');
	check(calls.runTurn.length === 0 && calls.msgTombstone.length === 0,
		'C: an already-continued turn does nothing — cross-tab idempotence');
}
{
	// D. No turn id: the filter would match every message, so the guard must fire FIRST.
	const { stubs, calls } = spies();
	const ct = makeContinueTurn(stubs);
	ct(freshChat('The capital of France is'), undefined, 'What is the capital of France?');
	check(calls.runTurn.length === 0,
		'D: a missing iturn is refused — never a whole-transcript wipe');
}
{
	// E. A turn already running: withTurnLock's partner guard.
	const { stubs, calls } = spies();
	const ct = makeContinueTurn(stubs);
	const chat = freshChat('The capital of France is');
	chat._generating = true;
	ct(chat, 'T1', 'What is the capital of France?');
	check(calls.runTurn.length === 0,
		'E: a chat mid-generation is not continued on top of itself');
}
{
	// F. No prompt at all: the `!text` guard.
	const { stubs, calls } = spies();
	const ct = makeContinueTurn(stubs);
	ct(freshChat('The capital of France is'), 'T1', '');
	check(calls.runTurn.length === 0, 'F: an empty prompt argument is refused');
}

// ── The count is pinned ──────────────────────────────────────
const EXPECTED = 20;
const ranBefore = ran;
check(ranBefore === EXPECTED,
	`exactly ${EXPECTED} checks ran — a displaced case trips this`,
	`ran ${ranBefore}`);

console.log(bad ? `\n${bad} check(s) FAILED` : '\nall checks passed');
process.exit(bad ? 1 : 0);
