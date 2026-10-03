// gateway: none
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
// hold, INCLUDING a person's pause (`a450d2ce`, release 3): Continue is refused exactly as a fresh
// turn would be, in the door's own pause sentence, and the partial is never touched. The real
// function is LIFTED from www/js/daimond.js and run against stubbed dependencies, so a change to
// the shipped logic is what this measures.
//
// The visible append itself — the continuation text landing after the retained partial — is
// runTurn's job and is covered in a real page by dev/verify_dropped.mjs and dev/verify_predrop.mjs.
// Here the claim is the DISPATCH: partial retained + continue message, not a bare re-run.
//
// PROVED AGAINST THE PRE-FIX DISPATCH. `--break rerun` flips the one deciding line — the resume
// branch's `runTurn(chat, CONTINUE_NUDGE)` back to `runTurn(chat, text)`, which is what the old
// code did — and runs the SAME checks. Section A's dispatch assertions then fail, and so does its
// journal check (the break sends every Continue down the path that tombstones instead), which is
// the proof they bite on the resume and not on something incidental:
//
//   node dev/verify_continue_resume.mjs --break rerun   # the resume-dispatch checks fail
//   node dev/verify_continue_resume.mjs                 # and then, clean
//
//   node dev/verify_continue_resume.mjs
//
// Section I (the sync release, 2026-10-03) lifts `recoverInterrupted`, the other place a turn's prompt is found by
// its mid, and pins that a prompt already under the turn id (`mid: umid, iturn: umid`, as `dispatch` writes it) stays one
// copy with its stamp unmoved, while an unmarked one is tagged in place with a stamped edit. I4 takes the function's
// early return away, so it also holds the tagging's own nesting (red on feat/sync-msglaw 28917b51: a second copy).
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
const STAMP = (() => { const w = {}; new Function('window', fs.readFileSync(path.join(HERE, '..', 'www', 'js', 'stamp.js'), 'utf8'))(w); return w.DaimondStamp; })();
const CT_ORIG    = grabFn('function continueTurn(');   // the pristine lift, for the sentinels
const TM_SRC     = grabFn('function turnMessagesOf(');   // the finder continueTurn asks for its turn's messages

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
// The empty-partial case still dispatches the ORIGINAL prompt. Matched on the argument
// and not on the whole call: that dispatch carries a third argument now (`contOpts`,
// which records a hand-off that fell back to running here), so a pattern closed with
// `)` stopped matching the line it was written about and reported the one thing this
// file exists to protect as missing.
check(/runTurn\(chat, text[,)]/.test(CT_ORIG),
	'and keeps runTurn(chat, text, ...) for the empty-partial case');

/// Build the real `continueTurn` with its free identifiers supplied as stubs. Everything else it
/// uses is a parameter or a local.
function makeContinueTurn(stubs) {
	// `window` AND the global it reaches through it. The shipped line is the house
	// idiom -- `if (window.DaimondJournal) DaimondJournal.clearTurn(...)` -- so the
	// bare name has to be supplied too, or it is a ReferenceError the function's own
	// try/catch swallows and this file proves nothing.
	//
	// `turnHold`, `toast` and `DaimondModels` are `a450d2ce`'s (release 3): a person's
	// pause now holds Continue exactly as it holds a fresh turn, asked with
	// `var held = turnHold(chat);` before anything else moves, unconditionally --
	// so a lift missing the stand-in threw ReferenceError on every case, held or not.
	//
	// `holdSend` and `confirmHold` are R53-U8b's: a held Continue reads the mailbox once
	// (`confirmHold`), under the chat's in-flight hold (`holdSend`), before it is refused.
	// `touchMsg` is r53's: the badge coming off is a stamped edit of the message. The real
	// one, over the real stamp rule. `clearBadge` is r53 msg2's: the badge is taken off as
	// a clear (`interrupted: 0`) the message law lets stand over the runner's copy.
	const names = ['loadMsgTombs', 'msgTombstone', 'touchChat', 'persistChats', 'renderHistory',
		'runTurn', 'window', 'DaimondJournal', 'turnHold', 'toast', 'DaimondModels',
		'holdSend', 'confirmHold', 'DaimondStamp', 'msgFpSeen'];
	const f = new Function(
		...names,
		NUDGE_STMT + '\n' + TM_SRC + '\n' + grabFn('function touchMsg(') + '\n' + grabFn('function clearBadge(') + '\n' + CT_SRC + '\nreturn continueTurn;');
	return f(...names.map((n) => (n === 'DaimondStamp' ? STAMP : n === 'msgFpSeen' ? new WeakMap() : stubs[n])));
}

/// A spy set with sensible defaults; a test overrides `loadMsgTombs` where it needs to.
function spies(over) {
	const calls = { runTurn: [], msgTombstone: [], clearTurn: [], toast: [], confirm: [] };
	const s = {
		loadMsgTombs:  () => ({}),
		msgTombstone:  (mids) => { calls.msgTombstone.push(mids); },
		touchChat:     () => {},
		persistChats:  () => {},
		renderHistory: () => {},
		runTurn:       (chat, text) => { calls.runTurn.push({ chat, text }); },
		// Not held by default: an ordinary interruption, which is what sections A-F
		// are. A case testing the held path overrides this.
		turnHold:      () => '',
		toast:         (msg) => { calls.toast.push(msg); },
		DaimondModels: { pauseError: (node) => ({ message: 'Paused at ' + node }) },
		// The mailbox read a held Continue makes first; it lifts nothing unless a case says so.
		holdSend:      () => () => {},
		confirmHold:   (chat) => { calls.confirm.push(chat); return Promise.resolve(); },
		// The page's own globals, as the function reaches for them. Only the journal is
		// here: `DaimondPeer` absent is an ordinary interruption, which is what these
		// cases are.
		window:         { DaimondJournal: true },
		DaimondJournal: { clearTurn: (id) => { calls.clearTurn.push(id); } },
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
	check(!!asst && asst.interrupted === 0 && !('why' in asst) && asst.at > 0,
		'and its badge is cleared (a stamped clear, `interrupted: 0`) — it is now an ordinary answer');
	check(chat.app === null,
		'chat.app is nulled so ensureApp rebuilds the session ENDING with the partial');
	check(chat.messages.filter((m) => m.role === 'user').length === 1,
		'the original prompt stays in the thread exactly once');
	// AND THE DEAD TURN LEAVES THE WRITE-AHEAD LOG. `runTurn`'s offline branch leaves it
	// open there so a reload can recover it -- but it is being taken over here, and
	// recovery cannot tell: its "already recovered" guard looks for a message carrying
	// this turn id, and at boot a chat's transcript has not been read yet. Left open, the
	// next reload appended a SECOND badged partial offering to buy the answer again.
	check(calls.clearTurn.length === 1 && calls.clearTurn[0] === 'T1',
		'and the turn is cleared from the journal, so no reload recovers it again',
		JSON.stringify(calls.clearTurn));
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
{
	// G (a450d2ce, release 3). A person's pause holds this chat's turn: Continue is
	// refused exactly as a fresh turn would be, before the partial is touched, and
	// the refusal is said in the door's own pause sentence.
	const node = 'root/diamonds/d1/self';
	const { stubs, calls } = spies({ turnHold: () => node });
	const ct = makeContinueTurn(stubs);
	const chat = freshChat('The capital of France is');
	ct(chat, 'T1', 'What is the capital of France?');
	await new Promise((r) => setTimeout(r, 0));
	check(calls.confirm.length === 1,
		'G: the hold is confirmed against the mailbox, once, before it is refused (R53-U8b)',
		'reads ' + calls.confirm.length);
	check(calls.runTurn.length === 0,
		'G: a chat a pause holds is not continued');
	check(calls.toast.length === 1 && calls.toast[0] === 'Paused at ' + node,
		'G: and the refusal is said in the door\'s own pause sentence',
		JSON.stringify(calls.toast));
}
{
	// H (R53-U8b, QU8 Q4). The hold this device read was stale: play was pressed elsewhere and
	// the confirming read brings it in. Continue goes ahead, and nothing is said about a pause.
	const node = 'root';
	let lifted = false;
	const { stubs, calls } = spies({
		turnHold:    () => (lifted ? '' : node),
		confirmHold: () => { lifted = true; return Promise.resolve(); },
	});
	const ct = makeContinueTurn(stubs);
	ct(freshChat('The capital of France is'), 'T1', 'What is the capital of France?');
	await new Promise((r) => setTimeout(r, 0));
	check(calls.runTurn.length === 1,
		'H: a stale hold the read lifts: the chat is continued', 'runTurn ' + calls.runTurn.length);
	check(calls.toast.length === 0,
		'H: and no pause is said', JSON.stringify(calls.toast));
}

// ── I: the recovery tags the prompt once and never pushes a second copy ──
// The turn Continue resumes was put back by `recoverInterrupted` (the journal, at boot). Its prompt is found
// by its mid, which `dispatch` writes as the turn id with `iturn` the same value (`mid: umid, iturn: umid`).
// A prompt already carrying the turn id as `iturn` must be left as it stands: one copy, its stamp unmoved.
// Only a prompt WITHOUT the mark is tagged (one copy, a stamped edit). The first fixture here, `iturn: 'T1'`
// beside `mid: 'u1'`, never held the two equal, so the case the merge of the sync line had to get right was
// not reached. Two layers keep it: the `already recovered` early return, and the tagging's own nesting.
// Section I4 takes the early return away to prove the second.
console.log('\nrecoverInterrupted tags the prompt once and never pushes a second copy');
{
	const RI_ORIG = grabFn('async function recoverInterrupted(');
	const GUARD   = /^.*\/\/ already recovered\s*$/m;
	check(/_recovering = false;\s*\}$/.test(RI_ORIG) && RI_ORIG.split('// already recovered').length === 2 && GUARD.test(RI_ORIG),
		'I0: the lifted recoverInterrupted is whole and holds its early return exactly once');
	const TOUCH = grabFn('function touchMsg(');
	const run = async (src, chat, turn) => {
		const cleared = [];
		const stubs = {
			window:              { DaimondJournal: true },
			DaimondJournal:      { recover: async () => ({ turns: [turn], agents: [] }), clearTurn: (id) => { cleared.push(id); }, clearAgent: () => {} },
			chats:               [chat],
			loadMsgTombs:        () => ({}),
			selfDeviceId:        () => 'dev1',
			leaseClockNow:       () => 0,
			outcomeOfStoredText: () => 'done',
			newMid:              () => 'm-new',
			nowTs:               () => 1,
			recoverUserRecord:   (c, it) => { c.messages.push({ role: 'user', mid: it, iturn: it }); },
			stampMessages:       () => {},
			touchChat:           () => {},
			current:             null,
			persistChats:        () => {},
			renderSessionList:   () => {},
			renderHistory:       () => {},
			Workers:             { runs: [] },
			ChatStore:           { settled: () => Promise.resolve() },
		};
		const names = Object.keys(stubs);
		const f = new Function(...names, 'DaimondStamp', 'msgFpSeen',
			'var _recovering = false;\n' + TOUCH + '\n' + src + '\nreturn recoverInterrupted;');
		await f(...names.map((n) => stubs[n]), STAMP, new WeakMap())();
		return cleared;
	};
	const at0  = STAMP.next(0);
	const turn = { chatId: 'c1', turnId: 'u1', userText: 'Q', text: 'partial', tools: [], meta: {} };
	const users = (c) => c.messages.filter((m) => m.role === 'user' && m.mid === 'u1');
	{	// I1: the prompt as dispatch writes it.
		const c = { id: 'c1', messages: [{ role: 'user', mid: 'u1', iturn: 'u1', at: at0, content: 'Q' }] };
		const cleared = await run(RI_ORIG, c, turn);
		check(users(c).length === 1 && c.messages.length === 1,
			'I1: a prompt whose mid and iturn are both the turn id stays ONE copy', 'messages ' + c.messages.length);
		check(users(c)[0].at === at0, 'and its stamp is unmoved (iturn did not change)', 'at ' + users(c)[0].at + ' was ' + at0);
	}
	{	// I2: the prompt as persist-first or the runner's graft leaves it, no mark.
		const c = { id: 'c1', messages: [{ role: 'user', mid: 'u1', at: at0, content: 'Q' }] };
		await run(RI_ORIG, c, turn);
		check(users(c).length === 1 && users(c)[0].iturn === 'u1',
			'I2: a prompt with no mark is tagged in place, still ONE copy');
		check(users(c)[0].at !== at0 && STAMP.beats(users(c)[0].at, at0),
			'and the tag is a stamped edit (the stamp moved, because iturn changed)');
		check(c.messages.filter((m) => m.role === 'assistant' && m.interrupted && m.iturn === 'u1').length === 1,
			'and the turn\'s interrupted answer is put back once');
	}
	{	// I3: no prompt at all.
		const c = { id: 'c1', messages: [] };
		await run(RI_ORIG, c, turn);
		check(users(c).length === 1 && users(c)[0].iturn === 'u1',
			'I3: no prompt in the chat: it is added once, under the turn id');
	}
	{	// I4: the early return taken away; the tagging alone must not double the prompt.
		const NOGUARD = RI_ORIG.replace(GUARD, '');
		const c = { id: 'c1', messages: [{ role: 'user', mid: 'u1', iturn: 'u1', at: at0, content: 'Q' }] };
		await run(NOGUARD, c, turn);
		check(users(c).length === 1,
			'I4: with the early return removed, a prompt already under the turn id is still ONE copy', 'copies ' + users(c).length);
		check(users(c).length >= 1 && users(c)[0].at === at0,
			'and its stamp is still unmoved');
	}
}

// ── The count is pinned ──────────────────────────────────────
const EXPECTED = 35;
const ranBefore = ran;
check(ranBefore === EXPECTED,
	`exactly ${EXPECTED} checks ran — a displaced case trips this`,
	`ran ${ranBefore}`);

console.log(bad ? `\n${bad} check(s) FAILED` : '\nall checks passed');
process.exit(bad ? 1 : 0);
