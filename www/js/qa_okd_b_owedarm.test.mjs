/* ============================================================
   Test -- a retracted turn leaves the model's stored session too (UNBLOCK-1 1e).
   ------------------------------------------------------------
   THE FAULT. `chat.session` is the model's own conversation, stored at a turn's end, and a cache of the transcript.
   The sender's removals that ride an errand (`gone`) took the rows out of the runner's transcript and set
   `chat.app = null`, and `seedEngine` then laid the stored session back in, the retracted pair still in it: the model
   was fed q1, a1, q1', a1', q2. `retryTurn` (and `continueTurn`'s empty-partial path) did the same to a finished turn.

   THE FIX. `sessionCut` runs before the rows leave: where the session accounts for one of them (at or before its
   marker) it is emptied to the cleared form, so the next engine is laid from the transcript that remains. A row only
   in its tail, which it never held, leaves it alone. The `gone` branch is `honourGone`, lifted out of the reconstruct.

   WHAT IS CHECKED. The REAL `honourGone`, `retryTurn`, `sessionCut`, `tailAfter` and `seedEngine`, lifted from
   daimond.js over stubs, and an engine stand-in that keeps what it is seeded with.

   Run:  node www/js/sessioncut.test.mjs
   ============================================================ */
import { readPage } from '../../dev/pagesrc.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readPage(process.env.SRC_JS || join(HERE, 'daimond.js'), 'utf8');
let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) console.log('  ok   ' + name);
	else { failures++; console.log('  FAIL ' + name + (detail === undefined ? '' : '  (' + JSON.stringify(detail) + ')')); }
}

/// The source of `function name(...) {...}`, brace-balanced, or null.
function lift(src, name) {
	let start = src.indexOf('\n\tasync function ' + name + '(');
	if (start < 0) start = src.indexOf('\n\tfunction ' + name + '(');
	if (start < 0) return null;
	const brace = src.indexOf('{', start);
	let depth = 0, i = brace;
	for (; i < src.length; i++) {
		if (src[i] === '{') depth++;
		else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
	}
	return src.slice(start + 1, i);
}

class Engine {
	constructor() { this.msgs = []; }
	restore(hist) { this.msgs = hist.map((m) => (m.role === 'user' ? { role: m.role, content: m.content, mid: m.mid } : { role: m.role, content: m.content })); }
	restore_session(msgs) { this.msgs = msgs.map((x) => Object.assign({}, x)); return this.msgs.length; }
	append_message(role, content, pre, mid) { this.msgs.push(role === 'user' && mid ? { role, content, mid } : { role, content }); }
}


// Engine with export_session, as the wasm does.
Engine.prototype.export_session = function () { return this.msgs.map((x) => Object.assign({}, x)); };
const T0 = 1790000000000;
const ask = (t, ts, text) => ({ role: 'user', mid: t, iturn: t, ts, content: text });
let LONG = ''; for (let i = 0; i < 10000; i++) LONG += String(i).padStart(4, '0') + 'é€😀 ';	// ~100 kB, the PIPE_MAX case
const framed = (t, mid, ts, text) => ({ role: 'assistant', mid, iturn: t, ts, content: text, run: 'R1', ranOn: 'argo', framed: 1 });
const W = { held: null, diags: [] };
const st = {
	window: { DaimondPeer: { settlingReport: (r) => !!r && r.t === 'report' && r.status !== 'parked' } },
	diag: (t, d) => W.diags.push(t + ' ' + d), chatHoldingTurn: () => W.held,
	msgTombstone() {}, touchChat() {}, persistChats() {}, renderHistory() {},
	dedupeSession: (m) => m, loadMsgTombs: () => ({}), ChatStore: { compact() {} }, newMid: () => 'n1',
	peerUiStateFor: () => '', selfDeviceId: () => 'D1', leaseClockNow: () => T0,
};
const names = ['settleRunnerSession', 'staleEngine', 'captureSession', 'sessionHeld', 'keepChatTaint', 'markChatTainted', 'chatTaintOf',
	'tailAfter', 'sessionDoubt', 'sessionMarker', 'engineHolds', 'seedEngine'];
const missing = names.filter((n) => !lift(SRC, n));
check('every lifted function is in daimond.js', missing.length === 0, missing);
const F = new Function(...Object.keys(st), names.map((n) => lift(SRC, n)).join('\n') + '\nreturn { ' + names.join(', ') + ' };')(...Object.values(st));
const prose = (msgs) => msgs.filter((m) => m.content && (m.role === 'user' || m.role === 'assistant')).map((m) => m.content.length > 40 ? 'LONG(' + m.content.length + (m.content === LONG ? ',eq' : ',NE') + ')' : m.content);
const WANT = JSON.stringify(['q1', 'a1-words', 'q2', 'LONG(' + LONG.length + ',eq)']);
/// Turn u1 ran here (session stored, upto a1, the engine live); u2 went to the runner.
function base() {
	const chat = { id: 'c1', messages: [ask('u1', T0, 'q1'), { role: 'assistant', mid: 'a1', iturn: 'u1', ts: T0 + 1, content: 'a1-words' }] };
	chat.app = new Engine();
	chat.app.msgs = [{ role: 'user', content: 'q1', mid: 'u1' }, { role: 'assistant', content: '', tool_calls: [{ id: 'call_1' }] },
		{ role: 'tool', content: 'ran', tool_call_id: 'call_1' }, { role: 'assistant', content: 'a1-words' }];
	F.captureSession(chat, chat.app);
	chat.messages.push(ask('u2', T0 + 2, 'q2'));
	return chat;
}
const report = { t: 'report', status: 'done', turnId: 'u2', chatId: 'c1', sessionStayed: 1, cost: {}, ts: T0 + 9 };
/// The next turn Here: the engine is (re)built if dropped and brought up as ensureApp does, then the turn runs and is captured.
function nextHere(chat) {
	chat.messages.push(ask('u3', T0 + 10, 'q3'));
	if (!chat.app) { chat.app = new Engine(); F.seedEngine(chat, 'u3', false); }
	const fed = prose(chat.app.msgs);
	chat.app.append_message('user', 'q3', undefined, 'u3');
	chat.app.msgs.push({ role: 'assistant', content: 'a3-words' });
	chat.messages.push({ role: 'assistant', mid: 'a3', iturn: 'u3', ts: T0 + 11, content: 'a3-words' });
	F.captureSession(chat, chat.app);
	return fed;
}
console.log('OWED ARM: oversize Done -> stayed -> next Here turn');
for (const order of ['answer-then-report', 'report-then-answer']) {
	const chat = base(); W.held = chat; W.diags = [];
	let out;
	if (order === 'answer-then-report') { chat.messages.push(framed('u2', 'a2', T0 + 3, LONG)); out = F.settleRunnerSession(report); }
	else { out = F.settleRunnerSession(report); chat.messages.push(framed('u2', 'a2', T0 + 3, LONG)); }
	check(order + ': the report reads stayed and the session is not overwritten', out === 'stayed' && chat.session.upto === 'a1', { out, upto: chat.session.upto });
	check(order + ': the live engine (pre-turn) is dropped', chat.app === null);
	const fed = nextHere(chat);
	check(order + ': the next Here turn is fed the whole session, once each, byte-equal', JSON.stringify(fed) === WANT, fed);
	const after = prose(chat.session.msgs);
	check(order + ': the session it stores holds every turn once, the long reply byte-equal',
		JSON.stringify(after) === JSON.stringify(['q1', 'a1-words', 'q2', 'LONG(' + LONG.length + ',eq)', 'q3', 'a3-words']), after);
	check(order + ': its tool-call ids from u1 are kept', chat.session.msgs.some((m) => m.tool_call_id === 'call_1'));
	// And a reload after: rebuilt from the stored session.
	chat.app = new Engine(); chat.messages.push(ask('u4', T0 + 20, 'q4'));
	F.seedEngine(chat, 'u4', false);
	const re = prose(chat.app.msgs);
	check(order + ': a reload then lays the same, nothing lost or doubled', JSON.stringify(re) === JSON.stringify(after), re);
}
{
	// The engine busy at the report (a fold or a Here turn holds it): marked stale, dropped at the next build.
	const chat = base(); W.held = chat; chat.messages.push(framed('u2', 'a2', T0 + 3, LONG));
	chat._generating = true;
	const out = F.settleRunnerSession(report);
	check('busy: not stored, engine marked stale', out === 'busy' && chat._engineStale === true && !!chat.app, { out });
}
{
	// The same stayed report heard twice (a re-collect): no double.
	const chat = base(); W.held = chat; chat.messages.push(framed('u2', 'a2', T0 + 3, LONG));
	F.settleRunnerSession(report); F.settleRunnerSession(JSON.parse(JSON.stringify(report)));
	const fed = nextHere(chat);
	check('reheard: the next Here turn is still fed each row once', JSON.stringify(fed) === WANT, fed);
}
console.log(checks + ' checks, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
