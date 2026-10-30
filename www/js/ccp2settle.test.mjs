/* ============================================================
   Test -- the hand-off queue made safe (QA ccp2 A: HIGH-1, MEDIUM-1, MEDIUM-2).
   ------------------------------------------------------------
   ccp1's qafix queued a chat's send behind a hand-off still out (`dispatchInFlight`), and rc's QA
   found what that brought in, and one seam it left:

     HIGH-1  an Edit & resend of a turn still out was queued as a new message, and its `_editing`
             stayed behind, so his next ordinary Send retracted that turn (prompt and answer);
     MED-1   a queued send could wait with nothing ever sending it: after a "not run" end, a runner
             gone silent, a hand-off nobody took by its deadline; and a new Send overtook it. A
             queued send keeps the runner drawn at its press (rulings, last line);
     MED-2   a runner's answer still STREAMED when a Here turn captured its session was neither held
             nor named, and once framed the next build never laid it.

   WHAT IS CHECKED. The REAL functions, lifted from daimond.js over recording stubs. Failing-first
   from qa_ccp2_a_probes (edit_queued_lingers, notrun_strands_queue, streamed_then_framed).

   Run:  node www/js/ccp2settle.test.mjs   (CCP2SETTLE_SRC=<daimond.js> to run it over another copy)
   ============================================================ */
import { readPage } from '../../dev/pagesrc.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fakeIDB, tabJournal, journalQueueOver } from './journalfixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readPage(process.env.CCP2SETTLE_SRC || join(HERE, 'daimond.js'), 'utf8');
/// The not-run cause map (NOTRUN-WHY), lifted as the page holds it.
const NOTRUN_SRC = (/\n\tvar NOTRUN_KEYS = \{[\s\S]*?\n\t\};/.exec(SRC) || [''])[0];
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
/// Lift `names` over `stubs` (each a free name in the lifted code), with `pre` run first.
function build(names, stubs, pre) {
	// OWNKEY's `endTurnNotRun` reads `_abiRefused` and calls `dropRefusedTiles` (QA ownkey-d B, L1).
	// NOTRUN-WHY's `placeholderNotRun` reads the hand-back's cause and the runner's words.
	stubs = Object.assign({ _abiRefused: {}, dropRefusedTiles() {}, _handBackCause: {}, peerReports: {},
		deviceNameFor: () => '' }, stubs);
	return new Function(...Object.keys(stubs), NOTRUN_SRC + (pre || '') + '\n' + names.map((n) => lift(SRC, n)).join('\n')
		+ '\nreturn { ' + names.join(', ') + ' };')(...Object.values(stubs));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = 1790000000000;
// The real journal (QA ccp3 A R2): a stubbed `journalQueue` hid a queue that never reached disk.
const IDB = fakeIDB(), JOURNAL = tabJournal(IDB, new Set());
const journalQueue = journalQueueOver(SRC, JOURNAL);
const onDisk = () => (IDB.dbs['daimond-journal'] ? IDB.dbs['daimond-journal'].rows : []).filter((r) => r.type === 'chat_queue');

// ── HIGH-1: an edit of a turn still out is decided before any queue, and never lingers ──
{
	const T = 't2';
	const mk = () => ({ id: 'c1', _loaded: true, status: 'active', provider: 'p', model: 'm', messages: [
		{ role: 'user', mid: T, iturn: T, content: 'read it' },
		{ role: 'assistant', mid: 'ph', iturn: T, why: 'dispatched', interrupted: true, content: '' }] });
	const st = { retried: [], dispatched: [], toasts: [], state: 'dispatched' };
	const box = { value: '' };
	const chat = mk();
	const stubs = {
		window: { DaimondModels: { resolve: () => true } }, DaimondModels: { resolve: () => true },
		chatInput: box, loadChatMessages: async () => {}, turnHold: () => false, confirmHold: async () => {},
		conciseText: (c, x) => x, holdSend: () => () => {}, sayIntoHere: () => false, recoveringHere: () => false,
		peerHeldTurnOf: () => null, peerUiStateFor: () => st.state, askHolds: () => false,
		journalQueue, syncSendMode() {}, renderQueue() {}, diag() {}, updateQueueBadges() {},
		toast: (s) => st.toasts.push(s), t: (k) => k, cfgReady: () => true, openSettings() {},
		giveUpSent: (c, w) => { if (String(box.value).trim() === String(w).trim()) box.value = ''; c._editing = null; },
		retryTurn: (c, iturn, text) => { st.retried.push([iturn, text]); return true; },
		maybeAutoDispatch: async (c, text) => { st.dispatched.push(text); return true; },
		drainAfterHeld() {}, drainQueue() {}, sendToDiamondTurn: async () => false, diamondBusy: () => false,
		peerReports: {}, _localEnding: {}, _localRecovering: {}, _lapseReading: {}, _lapseRead: {}, armHeldWake() {},
	};
	stubs.current = chat;		// the chat on screen
	const api = build(['sendPressed', 'dispatchInFlight', 'lapsedByClock', 'lapseConfirmed', 'lapseMark', 'confirmLapse', 'leaseDoorRead', 'enqueueMessage', 'editResend', 'lastTurnOf'], stubs);
	const press = (w) => ({ words: w, release() {}, drawn: 'argonaut' });
	// Probe edit_queued_lingers: the edit's Send while t2 is out.
	chat._editing = T; box.value = 'read it, but only the first page';
	await api.sendPressed(chat, box.value, press(box.value));
	await sleep(0);
	check('HIGH-1 the edit of a turn still out is not queued', !(chat._queue || []).length, chat._queue);
	check('HIGH-1 nor retracts it', st.retried.length === 0, st.retried);
	check('HIGH-1 the rewritten words stay in the box', box.value === 'read it, but only the first page', box.value);
	check('HIGH-1 one plain line says why', st.toasts.length === 1, st.toasts);
	check('HIGH-1 and the edit no longer stands', !chat._editing, chat._editing);
	// Later, t2 answered: an unrelated Send dispatches as a new turn, and t2 is untouched.
	chat.messages.splice(1, 1, { role: 'assistant', mid: 'a2', iturn: T, content: 'page one says 7', framed: 1 });
	st.state = 'done';
	box.value = 'thanks, now the weather';
	await api.sendPressed(chat, box.value, press(box.value));
	check('HIGH-1 his next Send never retracts t2', !st.retried.some((r) => r[0] === T), st.retried);
	check('HIGH-1 it goes as a new turn', st.dispatched.indexOf('thanks, now the weather') >= 0, st.dispatched);
	// The edit is not even set while a hand-off is out: `editResend` turns it away.
	const c2 = mk(); st.state = 'dispatched'; box.value = '';
	api.editResend(c2, T, 'read it');
	check('HIGH-1 Edit & resend is refused while its turn is out', !c2._editing && box.value === '', { e: c2._editing, box: box.value });
	// A box emptied by code clears the edit with it.
	check('HIGH-1 clearComposer forgets the edit with the draft', /_editing\s*=\s*null/.test(lift(SRC, 'clearComposer')));
	check('HIGH-1 giveUpSent forgets the edit with the words', /_editing\s*=\s*null/.test(lift(SRC, 'giveUpSent')));
	check('HIGH-1 Retry and Edit are withheld on the queue\'s own test', /dispatchInFlight\(/.test(lift(SRC, 'mountTurnActions')));
}

// ── MED-1: a queued send always goes, in order, under the runner pressed ──
// Probe notrun_strands_queue: the hand-off ends "not run" across a slow lease settle.
{
	const names = ['endHandOffNotRun', 'endTurnNotRun', 'placeholderNotRun', 'notRunCause', 'dropDispatchedPlaceholder', 'drainAfterHeld', 'recoveringHere', 'dispatchInFlight', 'armHeldWake', 'lapsedByClock', 'confirmLapse', 'leaseDoorRead', 'lapseConfirmed', 'lapseMark'];
	const st = { drained: 0 };
	const T = 'tid-2';
	const chat = { id: 'c1', _queue: [{ text: 'typed while t2 was out', drawn: '' }], messages: [
		{ role: 'user', mid: T, iturn: T, content: 'read it' },
		{ role: 'assistant', mid: 'ph-1', iturn: T, why: 'dispatched', interrupted: true, content: '', itext: 'read it' }] };
	const DP = { syncCas: () => ({}), settleLease: () => new Promise((r) => setTimeout(r, 20)), standDownUndecided: () => false };
	const DL = { take: async () => ({ won: true }) };
	const deps = {
		window: { DaimondLease: DL, DaimondPeer: DP }, DaimondPeer: DP, DaimondLease: DL,
		diag() {}, _localRecovering: {}, _localEnding: {}, _handoffStart: {}, _dispatchedIx: {}, _finalMids: {}, _finalRun: {},
		_heldWake: {}, claimTurnHere: async () => ({ release() {} }), peerSyncShim: () => ({}), leaseClockNow: () => Date.now(),
		scheduleDispatchFallback() {}, UNDECIDED_RECOLLECT_MS: 1, redrawRunner() {},
		logEnd: async () => true, notRunEnd: (why) => ({ status: 'not_run', not_run: { why: why } }),
		answerUnhanded: (c, tid) => c.messages.push({ role: 'assistant', mid: 'nr-1', iturn: tid, content: 'Not run.', why: 'not-run' }),
		dispatchedChat: () => chat, handoffTargetLabel: () => 'argonaut', deviceLabelFor: () => '', selfDeviceId: () => 'me',
		msgTombstone() {}, ownsChat: () => false, renderHistory() {}, touchChat() {}, persistChats() {}, ChatStore: { compact() {} },
		clearDispatchFallback() {}, updateExpedite() {}, autoLogHandoffLatency() {},
		diamondBusy: () => false, drainSteerQueue() {}, drainQueue: () => { st.drained++; },
		peerHeldTurnOf: () => null, peerUiStateFor: () => 'ending',
		peerReports: {}, _lapseReading: {}, _lapseRead: {},
	};
	const api = build(names, deps);
	await api.endHandOffNotRun(chat, chat.messages[1], 'withdrawn');
	await sleep(100);
	check('MED-1 a queued send goes once the hand-off ends "not run"', st.drained > 0, { drained: st.drained });
}
// A runner that claimed and then never reports: the lease lapses by time alone, and the queue goes.
// And a hand-off nobody takes: its deadline passes by time alone, and the queue goes.
for (const [what, kind] of [['a runner silent past its lease', 'lease'], ['a hand-off nobody took by its deadline', 'deadline']]) {
	const st = { drained: 0, until: Date.now() + 60 };
	const ph = { role: 'assistant', mid: 'ph', iturn: 't2', why: 'dispatched', content: '', ts: Date.now() };
	const chat = { id: 'c' + kind, _queue: [{ text: 'next', drawn: '' }], messages: [{ role: 'user', mid: 't2', iturn: 't2', content: 'q' }, ph] };
	const live = () => Date.now() < st.until;
	const deps = {
		window: { DaimondPeer: { handoffDeadline: () => (kind === 'deadline' ? st.until : 0) },
			DaimondLease: { record: () => (kind === 'lease' ? { mode: 'running', holder: 'argo', expiry: st.until } : null), adopt: () => true },
			// The lease door, read before a lapse seen by the clock alone lets the queue go (QA ccp3 A R3): it confirms.
			DaimondSync: { leaseGet: async () => ({ leases: {}, unread: false }) } },
		_localRecovering: {}, _localEnding: {}, peerReports: {}, _lapseReading: {}, _lapseRead: {}, _heldWake: {}, leaseClockNow: () => Date.now(), diag() {},
		peerHeldTurnOf: () => (kind === 'lease' && live() ? { iturn: 't2' } : null),
		peerUiStateFor: () => (kind === 'deadline' ? (live() ? 'dispatched' : 'no-peer-awake') : (live() ? 'running' : 'failed')),
		diamondBusy: () => false, drainSteerQueue() {}, drainQueue: () => { st.drained++; },
	};
	const api = build(['drainAfterHeld', 'recoveringHere', 'dispatchInFlight', 'armHeldWake', 'lapsedByClock', 'confirmLapse', 'leaseDoorRead', 'lapseConfirmed', 'lapseMark'], deps);
	api.drainAfterHeld(chat);
	check('MED-1 ' + what + ': held while the runner may still take it', st.drained === 0);
	await sleep(1200);
	check('MED-1 ' + what + ': the queue goes with no report, no event', st.drained === 1, { drained: st.drained });
}
// A new Send queues behind a queue already waiting; it never runs first.
{
	const st = { dispatched: [], drains: 0 };
	const box = { value: 'second' };
	const chat = { id: 'c1', _loaded: true, status: 'active', provider: 'p', model: 'm', messages: [], _queue: [{ text: 'first', drawn: '' }] };
	const stubs = {
		window: { DaimondModels: { resolve: () => true } }, DaimondModels: { resolve: () => true },
		chatInput: box, loadChatMessages: async () => {}, turnHold: () => false, conciseText: (c, x) => x,
		holdSend: () => () => {}, sayIntoHere: () => false, recoveringHere: () => false, askHolds: () => false,
		peerHeldTurnOf: () => null, peerUiStateFor: () => 'done', journalQueue, syncSendMode() {}, renderQueue() {},
		diag() {}, toast() {}, t: (k) => k, giveUpSent: () => { box.value = ''; },
		retryTurn: () => false, maybeAutoDispatch: async (c, text) => { st.dispatched.push(text); return true; },
		drainAfterHeld: () => { st.drains++; },
		peerReports: {}, _localEnding: {}, _localRecovering: {}, _lapseReading: {}, _lapseRead: {}, armHeldWake() {},
	};
	const api = build(['sendPressed', 'dispatchInFlight', 'lapsedByClock', 'lapseConfirmed', 'lapseMark', 'confirmLapse', 'leaseDoorRead', 'enqueueMessage', 'lastTurnOf'], stubs, 'var current = null;');
	await api.sendPressed(chat, 'second', { words: 'second', release() {}, drawn: 'argonaut' });
	check('MED-1 a new Send waits behind the queue', st.dispatched.length === 0
		&& JSON.stringify((chat._queue || []).map((q) => q.text)) === '["first","second"]', { d: st.dispatched, q: chat._queue });
	check('MED-1 and the queue is asked to go', st.drains === 1, st.drains);
	check('MED-1 the queued send keeps the runner drawn at its press', chat._queue[1] && chat._queue[1].drawn === 'argonaut', chat._queue);
	await sleep(60);
	check('MED-1 the queue behind it is on disk, though nothing runs here (QA ccp3 A R2)',
		onDisk().some((r) => r.chatId === 'c1' && JSON.stringify(r.items) === '["first","second"]'), onDisk());
}
// At drain the queued item goes to the election with its press's drawing (l.18: runner gone = not run, never Here).
{
	const st = { drawn: [] };
	const chat = { id: 'c1', _queue: [] };
	const api = build(['sendQueued'], {
		holdSend: () => () => {}, updateQueueBadges() {}, renderQueue() {}, recoveringHere: () => false,
		maybeAutoDispatch: async (c, text, words, mid, app, drawn) => { st.drawn.push([text, drawn]); return true; },
		runTurn: async () => {},
	});
	await api.sendQueued(chat, { text: 'q', drawn: 'argonaut' });
	await api.sendQueued(chat, { text: 'r' });
	check('MED-1 a pressed queued send is elected under its pressed runner', JSON.stringify(st.drawn[0]) === '["q","argonaut"]', st.drawn);
	check('MED-1 a send with no press follows the switch at drain', st.drawn[1] && st.drawn[1][1] === undefined, st.drawn);
}

// ── MED-2: a row the engine never held is laid by the next build, streamed or not ──
{
	const names = ['settleRunnerSession', 'staleEngine', 'captureSession', 'sessionHeld', 'keepChatTaint', 'sessionMarker', 'engineHolds', 'tailAfter', 'sessionDoubt'];
	const st = { held: null, diags: [] };
	const deps = { loadMsgTombs: () => ({}), window: { DaimondPeer: { settlingReport: (r) => !!r && r.t === 'report' } },
		diag: (t, d) => st.diags.push(t + ' ' + d), chatHoldingTurn: () => st.held, touchChat() {}, persistChats() {}, markChatTainted: () => false };
	const api = build(names, deps);
	const t3app = { busy: false, export_session: () => [{ role: 'user', content: 'q1', mid: 'u1' }, { role: 'assistant', content: 'a1-words' },
		{ role: 'user', content: 'read it', mid: 't2' }, { role: 'user', content: 'other q', mid: 't3' }, { role: 'assistant', content: 'a3-words' }] };
	const base = () => ({ v: 1, upto: 'a1', uptoTs: T0 + 1, marks: { u1: 0 }, msgs: [{ role: 'user', content: 'q1', mid: 'u1' }, { role: 'assistant', content: 'a1-words' }] });
	const rows = (withStream) => [
		{ role: 'user', mid: 'u1', iturn: 'u1', ts: T0, content: 'q1' },
		{ role: 'assistant', mid: 'a1', iturn: 'u1', ts: T0 + 1, content: 'a1-words' },
		{ role: 'user', mid: 't2', iturn: 't2', ts: T0 + 2, content: 'read it' },
		{ role: 'user', mid: 't3', iturn: 't3', ts: T0 + 3, content: 'other q' }]
		.concat(withStream ? [{ role: 'assistant', mid: 'e-t2-final', iturn: 't2', ts: T0 + 4, content: 'it says', provisional: true }] : [])
		.concat([{ role: 'assistant', mid: 'a3', iturn: 't3', ts: T0 + 5, content: 'a3-words' }]);
	const reaches = (c) => {
		const tail = api.tailAfter(c, c.session);
		const doubt = api.sessionDoubt(c, c.session, tail, '');
		return { ok: !!doubt || tail.some((m) => m.mid === 'e-t2-final'), tail: tail.map((m) => m.mid), doubt };
	};
	// Probe streamed_then_framed: the answer streamed (provisional) at t3's capture, framed after.
	{
		const c = { id: 'c1', app: t3app, messages: rows(true), session: base() };
		c._held = { app: t3app, mids: { u1: 1, a1: 1, t2: 1, t3: 1, a3: 1 }, ran: true };
		st.held = c;
		api.captureSession(c, t3app);
		api.settleRunnerSession({ t: 'report', status: 'done', turnId: 't2', chatId: 'c1',
			session: { v: 1, msgs: [], base: 'a1', upto: 'e-t2-final', uptoTs: T0 + 4 } });
		c.messages[4] = Object.assign({}, c.messages[4], { content: 'it says 7', framed: 1 }); delete c.messages[4].provisional;
		const r = reaches(c);
		check('MED-2 an answer streamed at the capture reaches the model once framed', r.ok, r);
	}
	// The other device: the answer was not in this transcript at all at the capture, and synced in above the marker after.
	{
		const c = { id: 'c1', app: t3app, messages: rows(false), session: base() };
		c._held = { app: t3app, mids: { u1: 1, a1: 1, t2: 1, t3: 1, a3: 1 }, ran: true };
		st.held = c;
		api.captureSession(c, t3app);
		c.app = null; c._held = null;
		c.messages.splice(4, 0, { role: 'assistant', mid: 'e-t2-final', iturn: 't2', ts: T0 + 4, content: 'it says 7', framed: 1 });
		const r = reaches(c);
		check('MED-2 an answer that synced in above the marker after the capture reaches the model', r.ok, r);
	}
	// Nothing missing: an ordinary capture lays nothing again and doubts nothing.
	{
		const c = { id: 'c1', app: t3app, messages: rows(false), session: base() };
		c._held = { app: t3app, mids: { u1: 1, a1: 1, t2: 1, t3: 1, a3: 1 }, ran: true };
		api.captureSession(c, t3app);
		const tail = api.tailAfter(c, c.session);
		check('MED-2 a session that holds every row has an empty tail and no doubt',
			tail.length === 0 && api.sessionDoubt(c, c.session, tail, '') === '', { tail: tail.map((m) => m.mid) });
	}
}

console.log('\n' + (checks - failures) + '/' + checks + ' checks passed');
process.exit(failures ? 1 : 0);
