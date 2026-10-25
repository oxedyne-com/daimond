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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(process.env.SRC_JS || join(HERE, 'daimond.js'), 'utf8');
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
/* INT-3 (rc-b delta B, qa_ownkey_d_b §5 "qafix4"): the owed arm's next turn as a QUEUED send, drained as u2
   settles under ccp3's queue hold (`drainAfterHeld` -> `dispatchInFlight` -> `peerHeldTurnOf`), not a pressed Send. */
const Q = { held: true, ui: 'dispatched', arms: 0, drained: [], fed: null, reading: {} };
const qs = {
	_lapseReading: Q.reading, _localRecovering: {}, diamondBusy: () => false, drainSteerQueue() { throw new Error('no diamond here'); },
	armHeldWake: () => { Q.arms++; },
	// The real `peerHeldTurnOf`, over the lease: u2's lease is held by the runner until its report settles.
	isLostRow: () => false, _peerStopping: {}, _lostRunOf: {}, lostRetryMid: (t) => t + '-retry',
	peerLeaseHeld: (tid) => Q.held && tid === 'u2', PEER_HELD: { claimed: 1, running: 1, blocked: 1, 'awaiting-consent': 1 },
	peerUiStateFor: () => Q.ui, lapsedByClock: () => null, lapseConfirmed: () => true, confirmLapse() {},
	drainQueue: (c) => { const t = c._queue.shift(); Q.drained.push(t); Q.fed = nextHere(c); },
};
const qn = ['drainAfterHeld', 'dispatchInFlight', 'recoveringHere', 'peerHeldTurnOf'];
const qmiss = qn.filter((n) => !lift(SRC, n));
check('QUEUED: every lifted function is in daimond.js', qmiss.length === 0, qmiss);
const G = new Function(...Object.keys(qs), qn.map((n) => lift(SRC, n)).join('\n') + '\nreturn { ' + qn.join(', ') + ' };')(...Object.values(qs));
console.log('QUEUED ARM: oversize Done -> stayed -> queued next turn drained under the hold');
for (const order of ['answer-then-report', 'report-then-answer']) {
	const chat = base(); W.held = chat; W.diags = [];
	Q.held = true; Q.ui = 'dispatched'; Q.arms = 0; Q.drained = []; Q.fed = null;
	const ph = { role: 'assistant', mid: 'a2', iturn: 'u2', ts: T0 + 3, content: '', why: 'dispatched' };
	chat.messages.push(ph);
	chat._queue = ['q3'];
	G.drainAfterHeld(chat);
	check(order + ': while u2 is held the queue stays and the hold arms its wake', Q.drained.length === 0 && Q.arms === 1 && chat._queue.length === 1, Q);
	Q.reading.c1 = 1; G.drainAfterHeld(chat); delete Q.reading.c1;
	check(order + ': a lapse read at the door asks again later, arming nothing', Q.drained.length === 0 && Q.arms === 1, Q);
	const land = () => { chat.messages.splice(chat.messages.indexOf(ph), 1); chat.messages.push(framed('u2', 'a2', T0 + 3, LONG)); };
	let out;
	if (order === 'answer-then-report') {
		land(); G.drainAfterHeld(chat);
		check(order + ': the answer alone, its lease still held, drains nothing', Q.drained.length === 0, Q);
		out = F.settleRunnerSession(report); Q.held = false;
	} else {
		out = F.settleRunnerSession(report); Q.held = false; G.drainAfterHeld(chat);
		check(order + ': the report alone, the placeholder still dispatched, drains nothing', Q.drained.length === 0, Q);
		land();
	}
	check(order + ': the report reads stayed and the live engine is dropped', out === 'stayed' && chat.app === null, { out });
	Q.ui = '';
	G.drainAfterHeld(chat);
	check(order + ': once settled the queued send drains exactly once', JSON.stringify(Q.drained) === '["q3"]' && chat._queue.length === 0, Q.drained);
	check(order + ': the drained turn is fed the whole session, once each, byte-equal', JSON.stringify(Q.fed) === WANT, Q.fed);
	const after = prose(chat.session.msgs);
	check(order + ': the session it stores holds every turn once',
		JSON.stringify(after) === JSON.stringify(['q1', 'a1-words', 'q2', 'LONG(' + LONG.length + ',eq)', 'q3', 'a3-words']), after);
	G.drainAfterHeld(chat);
	check(order + ': a second drain call sends nothing more', Q.drained.length === 1, Q.drained);
}
console.log(checks + ' checks, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
