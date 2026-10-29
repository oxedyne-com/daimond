/* ============================================================
   Test -- a runner's turn settles into a chat that is not idle (QA ccp1 A: H1, M1, M2).
   ------------------------------------------------------------
   KT-5 brought the runner's session home (`settleRunnerSession`), and rc's QA found three ways
   the runner's answer still left the model's conversation:

     H1  a report that stores nothing (`stayed`, `moved`, a done report with no session) kept the
         chat's live engine, and the next Here turn's reconcile never laid the runner's answer, a
         `framed` row no parcel replaces (`sessionPlan` skipped it);
     M1  a report landing while a Here turn ran in the same chat was stored and dropped the running
         engine; that turn's capture then overwrote it, and marked the runner's framed answer as
         heard; and a second send ran Here beside a hand-off still out;
     M2  a report heard again after its turn was retracted put the retracted turn back.

   WHAT IS CHECKED. The REAL functions, lifted from daimond.js over stubs: `settleRunnerSession`,
   `staleEngine`, `captureSession`, `sessionMarker`, `engineHolds`, `sessionPlan`, `reconcileEngine`,
   `tailAfter`, `sessionDoubt`, `sessionCut`, `daimonPrior`, `dispatchInFlight`, `drainQueue`.
   Failing-first from qa_ccp1_a_probes (stayed_live_engine, generating_overwrite, reheard_after_cut).

   Run:  node www/js/kt5settle.test.mjs   (KT5SETTLE_SRC=<daimond.js> to run it over another copy)
   ============================================================ */
import { readPage } from '../../dev/pagesrc.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readPage(process.env.KT5SETTLE_SRC || join(HERE, 'daimond.js'), 'utf8');
let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) console.log('  ok   ' + name);
	else { failures++; console.log('  FAIL ' + name + (detail === undefined ? '' : '  (' + JSON.stringify(detail) + ')')); }
}

/// The source of `function name(...) {...}`, brace-balanced, or a stub that throws when it is absent.
function lift(src, name) {
	let start = src.indexOf('\n\tasync function ' + name + '(');
	if (start < 0) start = src.indexOf('\n\tfunction ' + name + '(');
	if (start < 0) return 'function ' + name + '() { throw new Error("' + name + ' is not in daimond.js"); }';
	const brace = src.indexOf('{', start);
	let depth = 0, i = brace;
	for (; i < src.length; i++) {
		if (src[i] === '{') depth++;
		else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
	}
	return src.slice(start + 1, i);
}

const T0 = 1790000000000;
const st = { held: null, diags: [], tombs: {}, states: {}, peerHeld: null, sent: [], current: null };
const stubs = {
	window: { DaimondPeer: { settlingReport: (r) => !!r && r.t === 'report' && r.status !== 'parked' } },
	diag: (t, d) => st.diags.push(t + ' ' + d),
	chatHoldingTurn: () => st.held,
	touchChat() {}, persistChats() {},
	markChatTainted: () => false,
	seedEngine: () => ({}),
	loadMsgTombs: () => st.tombs,
	peerHeldTurnOf: () => st.peerHeld,
	peerUiStateFor: (m) => st.states[String(m.iturn)] || 'failed',
	returnQueue() {}, askHolds: () => false, renderQueue() {}, updateQueueBadges() {},
	sendQueued: (c, q) => { st.sent.push(q.text); return Promise.resolve('here'); },
	// The one hold test reads the lease door before a lapse seen by the clock alone ends a hand-off (QA ccp3r A MED-B).
	peerReports: {}, _localEnding: {}, _localRecovering: {}, _lapseReading: {}, _lapseRead: {}, armHeldWake() {},
	drainAfterHeld: (c) => api.drainQueue(c, false),
};
const names = ['settleRunnerSession', 'staleEngine', 'captureSession', 'sessionHeld', 'keepChatTaint', 'sessionMarker', 'engineHolds',
	'reconcileEngine', 'sessionPlan', 'tailAfter', 'sessionDoubt', 'sessionCut', 'daimonPrior', 'dedupeSession',
	'foldGap', 'foldCover', 'foldHeld', 'dispatchInFlight', 'lapsedByClock', 'lapseConfirmed', 'lapseMark', 'confirmLapse', 'leaseDoorRead', 'drainQueue'];
const api = new Function(...Object.keys(stubs), 'var current = null, _unloading = false, chats = [];\n'
	+ 'function setScene(c) { current = c; chats = c ? [c] : []; }\n'
	+ names.map((n) => lift(SRC, n)).join('\n') + '\nreturn { setScene, ' + names.join(', ') + ' };')(...Object.values(stubs));
const call = (fn, ...a) => { try { return fn(...a); } catch (e) { return 'threw ' + e.message; } };

/// The runner's session after turn t2: turn 1, then t2 with its tool call and answer.
const RUN = [{ role: 'user', content: 'q1', mid: 'u1' }, { role: 'assistant', content: 'a1-words' },
	{ role: 'user', content: 'read it', mid: 't2' },
	{ role: 'assistant', content: '', tool_calls: [{ id: 'call_9', name: 'file_read', arguments: '{}' }] },
	{ role: 'tool', content: 'ran', tool_call_id: 'call_9' }, { role: 'assistant', content: 'it says 7' }];
const SESS1 = () => ({ v: 1, upto: 'a1', uptoTs: T0 + 1, marks: { u1: 0 },
	msgs: [{ role: 'user', content: 'q1', mid: 'u1' }, { role: 'assistant', content: 'a1-words' }] });
const FINAL = () => ({ role: 'assistant', mid: 'e-t2-final', iturn: 't2', ts: T0 + 3, content: 'it says 7', framed: 1, run: 'e-t2' });
/// Turn u1 ran here on `app`; t2 ran on a Kimberlite runner, whose final frame was adopted (`framed`).
function chat(over) {
	const app = { busy: false, laid: [], append_message(role, content) { this.laid.push(role + ':' + content); } };
	return Object.assign({ id: 'c1', _loaded: true, app, _held: { app, mids: { u1: 1, a1: 1 }, ran: true },
		messages: [
			{ role: 'user', mid: 'u1', iturn: 'u1', ts: T0, content: 'q1' },
			{ role: 'assistant', mid: 'a1', iturn: 'u1', ts: T0 + 1, content: 'a1-words' },
			{ role: 'user', mid: 't2', iturn: 't2', ts: T0 + 2, content: 'read it' }, FINAL()],
		session: SESS1() }, over || {});
}
const report = (over) => Object.assign({ t: 'report', status: 'done', turnId: 't2', chatId: 'c1',
	session: { v: 1, msgs: RUN, turnStart: 2, base: 'a1', upto: 'e-t2-final', uptoTs: T0 + 3 } }, over || {});
function settle(c, r) { st.held = c; st.diags = []; return call(api.settleRunnerSession, r); }

// ── H1: a report that stores nothing leaves no stale engine ──
for (const [what, r, want] of [
	['stayed', report({ session: undefined, sessionStayed: 1 }), 'stayed'],
	['moved', report({ session: Object.assign({}, report().session, { base: 'a0' }) }), 'moved'],
	['a done report with no session', report({ session: undefined }), ''],
]) {
	const c = chat();
	const before = JSON.stringify(c.session);
	const out = settle(c, r);
	check('H1 ' + what + ': nothing stored', out === want && JSON.stringify(c.session) === before, { out });
	check('H1 ' + what + ': the chat\'s engine is dropped', c.app === null && c._held === null, { app: !!c.app });
	check('H1 ' + what + ': the diagnostics say the transcript lays it', st.diags.some((d) => /transcript/.test(d)), st.diags);
}
// Probe P1: under a running turn the engine stays, marked; the next build drops it.
{
	const c = chat({ _generating: true });
	const app = c.app;
	const out = settle(c, report({ session: undefined, sessionStayed: 1 }));
	check('H1 stayed under a running turn keeps the engine it runs on, marked stale',
		out === 'busy' && c.app === app && c._engineStale === true, { out, stale: c._engineStale });
	c._generating = false;
	call(api.staleEngine, c);
	check('H1 the mark drops the engine once the turn is over', c.app === null && c._held === null && !c._engineStale);
}
// H1 secondary: a live engine's reconcile lays a settled turn's framed answer (no parcel will replace it).
{
	const c = chat();
	c.messages.push({ role: 'user', mid: 't3', iturn: 't3', ts: T0 + 4, content: 'and now?' });
	call(api.reconcileEngine, c, 't3');
	check('H1 reconcile lays the runner\'s framed answer on a live engine', c.app.laid.includes('assistant:it says 7'), c.app.laid);
	const d = chat();
	d.messages.splice(3, 0, { role: 'assistant', mid: 'ph-t2', iturn: 't2', why: 'dispatched', content: '', ts: T0 + 2 });
	call(api.reconcileEngine, d, '');
	check('H1 but not while its hand-off still stands (its placeholder): a whole copy may replace it',
		!d.app.laid.includes('assistant:it says 7'), d.app.laid);
}
// Probe P3 (control): a Diamond's record is not touched, and its next turn is laid with the answer.
{
	const kept = {};
	const d = chat({ id: 'dc1', diamondId: 'd1', app: kept, _held: null });
	const out = settle(d, report({ session: undefined, sessionStayed: 1 }));
	d.messages.push({ role: 'user', mid: 't3', iturn: 't3', ts: T0 + 4, content: 'and now?' });
	const laid = call(api.daimonPrior, d, 't3');
	check('P3 a Diamond keeps what it holds as app on stayed', out === 'stayed' && d.app === kept, { out });
	check('P3 its next turn is laid with the runner\'s answer',
		Array.isArray(laid) && laid.some((m) => m.role === 'assistant' && m.content === 'it says 7'), laid);
}

// ── M1: a report during a Here turn in the same chat ──
// Probe P4: t2 went to the runner; t3 was sent meanwhile and runs here.
function m1chat(finalFirst) {
	const app = { busy: false, export_session: () => [RUN[0], RUN[1], { role: 'user', content: 'read it', mid: 't2' },
		{ role: 'user', content: 'other q', mid: 't3' }, { role: 'assistant', content: 'a3-words' }] };
	const rows = [
		{ role: 'user', mid: 'u1', iturn: 'u1', ts: T0, content: 'q1' },
		{ role: 'assistant', mid: 'a1', iturn: 'u1', ts: T0 + 1, content: 'a1-words' },
		{ role: 'user', mid: 't2', iturn: 't2', ts: T0 + 2, content: 'read it' },
		{ role: 'user', mid: 't3', iturn: 't3', ts: T0 + 3, content: 'other q' }];
	if (finalFirst) rows.push(Object.assign(FINAL(), { ts: T0 + 4 }));
	return { id: 'c1', _loaded: true, _generating: true, app, _held: { app, mids: { u1: 1, a1: 1, t2: 1, t3: 1 }, ran: true },
		messages: rows, session: SESS1() };
}
for (const finalFirst of [true, false]) {
	const c = m1chat(finalFirst), app = c.app;
	const where = finalFirst ? ' (its answer lands above t3\'s)' : ' (its answer lands last)';
	const out = settle(c, report());
	check('M1 a report during a Here turn stores nothing and keeps the running engine' + where,
		out === 'busy' && c.app === app && c._engineStale === true && c.session.upto === 'a1', { out, upto: c.session.upto });
	check('M1 the diagnostics say a turn runs here' + where, st.diags.some((d) => /turn runs here/.test(d)), st.diags);
	// t3 ends: its answer, heard (`heldNote`), and its own capture from the engine it ran on.
	c.messages.push({ role: 'assistant', mid: 'a3', iturn: 't3', ts: T0 + 5, content: 'a3-words' });
	c._held.mids.a3 = 1;
	if (!finalFirst) c.messages.push(Object.assign(FINAL(), { ts: T0 + 6 }));
	c._generating = false;
	call(api.captureSession, c, app);
	const tail = call(api.tailAfter, c, c.session);
	check('M1 the capture claims no runner row its engine never took' + where, c.session.upto === 'a3'
		&& Array.isArray(tail) && tail.some((m) => m.mid === 'e-t2-final'), { upto: c.session.upto, held: c.session.held, tail });
	if (finalFirst) {
		check('M1 a framed answer above the marker is not held, so the next build lays from the transcript',
			c.session.held && c.session.held['e-t2-final'] !== 1 && c.session.held.t2 === 1
			&& call(api.sessionDoubt, c, c.session, tail, '') === 'lacks', { held: c.session.held });
	} else {
		check('M1 a framed answer after the marker is the plain tail', c.session.held && c.session.held['e-t2-final'] !== 1
			&& call(api.sessionDoubt, c, c.session, tail, '') === '', { held: c.session.held });
	}
}
{
	const c = chat();
	c.app.busy = true;		// a fold running, or a steer child
	check('M1 an engine that is busy stores nothing either', settle(c, report()) === 'busy' && c.session.upto === 'a1');
}
{
	// An ordinary local turn's capture is unchanged: every row held, the marker on its answer.
	const app = { export_session: () => SESS1().msgs };
	const c = { id: 'c2', app, _held: { app, mids: { u1: 1, a1: 1 }, ran: true }, messages: chat().messages.slice(0, 2) };
	call(api.captureSession, c, app);
	check('M1 a local turn\'s capture is marked on its own answer, every row held', c.session.upto === 'a1'
		&& JSON.stringify(c.session.held) === '{"u1":1,"a1":1}', c.session);
}
// The send side: a hand-off still out holds what was typed after it.
{
	const ph = { role: 'assistant', mid: 'ph-t2', iturn: 't2', why: 'dispatched', content: '', ts: T0 + 2 };
	const c = chat({ messages: chat().messages.slice(0, 3).concat([ph]), _queue: [{ text: 'next q', drawn: '' }] });
	st.peerHeld = null;
	for (const [state, out] of [['dispatched', ph], ['claimed', ph], ['failed', null], ['done', null]]) {
		st.states = { t2: state };
		if (state === 'claimed') st.peerHeld = ph;
		if (state === 'failed') {
			// Failed by this device's clock alone: still out until the lease's door is read (no door here: read at once).
			check('M1 a hand-off failed by the clock alone is still out until the door is read', call(api.dispatchInFlight, c) === ph);
			await new Promise((r) => setTimeout(r, 0));
		}
		check('M1 a hand-off ' + state + ' is ' + (out ? '' : 'not ') + 'still out', call(api.dispatchInFlight, c) === out);
		st.peerHeld = null;
	}
	st.states = { t2: 'dispatched' }; st.sent = [];
	api.setScene(c);
	call(api.drainQueue, c, false);
	check('M1 the queue waits behind a hand-off not yet taken', st.sent.length === 0 && c._queue.length === 1, st.sent);
	st.states = { t2: 'failed' };
	call(api.drainQueue, c, false);
	check('M1 and goes once it has settled', st.sent.length === 1 && st.sent[0] === 'next q', st.sent);
	api.setScene(null);
	const send = lift(SRC, 'sendPressed');
	const at = send.indexOf('if (dispatchInFlight(chat)) { enqueueMessage(chat, text, words, press.drawn); return; }');
	check('M1 a send queues behind a hand-off still out, before any election or turn here',
		at > 0 && at < send.indexOf('maybeAutoDispatch(chat,') && at < send.indexOf('runTurn(chat,'));
	check('M1 the queue held behind it is sent when it settles', /var held = dispatchInFlight\(chat\);\s*if \(held\) \{/.test(lift(SRC, 'drainAfterHeld')));
}

// ── M2: a report heard again after its turn was retracted ──
// Probe P2: stored, then retracted (tombstoned and cut, as `retryTurn` does), then heard again.
{
	st.tombs = {};
	const c = chat();
	const first = settle(c, report());
	const gone = c.messages.slice(2);
	gone.forEach((m) => { st.tombs[m.mid] = T0 + 9; });
	call(api.sessionCut, c, gone);
	c.messages = c.messages.slice(0, 2);
	const again = settle(c, report());
	const back = c.session.msgs.some((m) => m.mid === 't2');
	check('M2 a re-heard report after a retraction is refused', first === 'stored' && again === 'cut' && !back,
		{ first, again, back, upto: c.session.upto });
	// A retry that keeps the prompt but tombstones the run's answer.
	st.tombs = { 'e-t2-final': T0 + 9 };
	const d = chat();
	check('M2 a report whose answer was retracted is refused', settle(d, report()) === 'cut' && d.session.upto === 'a1');
	// The same report heard again while it stands is a no-op, and the next run of the turn stores.
	st.tombs = {};
	const e = chat();
	settle(e, report());
	check('M2 the same report heard again is its own stored session', settle(e, report()) === 'stored' && e.session.upto === 'e-t2-final');
	st.tombs = { 't2-old': T0 };
	check('M2 a tombstone of another turn refuses nothing', settle(chat(), report()) === 'stored');
	st.tombs = {};
}

console.log('\n' + (checks - failures) + '/' + checks + ' checks passed');
process.exit(failures ? 1 : 0);
