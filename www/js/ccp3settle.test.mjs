/* ============================================================
   Test -- the hand-off queue kept, a runner's session honest, the wake on a fresh lease
   (QA ccp3 A: R2 HIGH, R1 MEDIUM, R3 MEDIUM).
   ------------------------------------------------------------
     R2  a send queued behind a hand-off lived only in tab memory: the box was cleared, the
         draft dropped, and `journalQueue` wrote only while a turn ran HERE, so a reload lost
         his words. The queue is now the chat's own durable record (journal.js `chatQueue`),
         written on every change and handed back to the composer at boot (`giveBackQueues`);
     R1  a runner's session sent home marked every row up to its marker as held, so a turn run
         elsewhere between its base and its marker (t3, a3) never reached the model;
     R3  the time wake drained the queue on this tab's CACHED lease expiry: a phone unlocked
         after a long argonaut turn sent the queued words beside t2. A lapse read off the clock
         is confirmed at the lease door first (`leaseDoorRead`).

   WHAT IS CHECKED. The REAL functions, lifted from daimond.js, and the REAL journal.js over an
   in-memory IndexedDB. Failing-first from coord/qa_ccp3_a_probes (queued_lost_on_reload,
   interleaved_runner_session, wake_on_stale_lease).

   Run:  node www/js/ccp3settle.test.mjs   (CCP3SETTLE_SRC=<daimond.js> to run it over another copy)
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fakeIDB, tabJournal } from './journalfixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(process.env.CCP3SETTLE_SRC || join(HERE, 'daimond.js'), 'utf8');
let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) console.log('  ok   ' + name);
	else { failures++; console.log('  FAIL ' + name + (detail === undefined ? '' : '  (' + JSON.stringify(detail) + ')')); }
}
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
function build(names, stubs, pre) {
	return new Function(...Object.keys(stubs), (pre || '') + '\n' + names.map((n) => lift(SRC, n)).join('\n')
		+ '\nreturn { ' + names.join(', ') + ' };')(...Object.values(stubs));
}
/// Run one section; a throw is a failed check, not the end of the run.
async function section(name, fn) { try { await fn(); } catch (e) { check(name + ' ran to its end', false, String((e && e.message) || e)); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = 1790000000000;

// ── R2: a send queued behind a hand-off survives a reload ──
await section('R2', async () => {
	const idb = fakeIDB(), locks = new Set();
	const J1 = tabJournal(idb, locks);
	const WORDS = 'and then summarise it for Fred';
	const drafts = { 'chat/c1': WORDS };
	const DD = { set: (k, v) => { drafts[k] = v; }, get: (k) => drafts[k], drop: (k) => { delete drafts[k]; } };
	const box = { value: WORDS, style: {}, dataset: { draftKey: 'chat/c1' } };
	// t2 is out on argonaut: nothing runs here, and the last Here turn's journal id is left from before.
	const chat = { id: 'c1', _jturn: 'old-turn', _generating: false, messages: [] };
	const st = { toasts: 0, elected: [] };
	const stubs = {
		window: { DaimondJournal: J1, DaimondDrafts: DD }, DaimondJournal: J1, DaimondDrafts: DD,
		diag() {}, syncSendMode() {}, renderQueue: () => api.journalQueue(chat), fitComposer() {}, updateQueueBadges() {},
		chatInput: box, chatDraftKey: (c) => (c ? 'chat/' + c.id : ''), toast: () => { st.toasts++; }, t: (k) => k,
		askHolds: () => false, dispatchInFlight: () => null, returnQueue() {}, recoveringHere: () => false,
		holdSend: () => () => {}, runTurn: async () => {}, _unloading: false, chats: [chat], _queueGiven: {},
		maybeAutoDispatch: async (c, text) => { st.elected.push(text); await sleep(30); return true; },
	};
	stubs.current = chat;
	const names = ['enqueueMessage', 'journalQueue', 'queuedText', 'giveUpSent', 'clearComposer', 'giveBackQueue', 'intoComposer', 'giveBackQueues', 'drainQueue', 'sendQueued'];
	const api = build(names, stubs);
	api.enqueueMessage(chat, WORDS, WORDS, 'argonaut');
	await sleep(40);
	check('R2 the box is given up for the queue', box.value === '' && !drafts['chat/c1'], { box: box.value, drafts });
	const rowsOf = () => idb.dbs['daimond-journal'] ? idb.dbs['daimond-journal'].rows : [];
	check('R2 the queued words are on disk though no turn runs here', rowsOf().some((r) => JSON.stringify(r).includes(WORDS)), rowsOf());
	// A second item, then the first withdrawn: the record follows every change, one entry per chat.
	chat._queue.push({ text: 'second' }); api.journalQueue(chat);
	chat._queue.shift(); api.journalQueue(chat);
	await sleep(60);
	const qrows = rowsOf().filter((r) => r.type === 'chat_queue');
	check('R2 the record follows every change and holds one entry', qrows.length === 1 && JSON.stringify(qrows[0].items) === '["second"]', qrows);
	chat._queue = [{ text: WORDS, drawn: 'argonaut' }]; api.journalQueue(chat);
	await sleep(60);
	// Another tab still alive: its queue is its own, and a boot of this one leaves it.
	const J2 = tabJournal(idb, locks);
	const rec2 = await J2.recover();
	check('R2 a live tab\'s queue is not taken by another tab', !(rec2.queues || []).length, rec2.queues);
	// The tab dies (its lock goes); the reload's tab finds the words and hands them back, unsent.
	for (const n of [...locks]) locks.delete(n);
	const J3 = tabJournal(idb, locks);
	const rec3 = await J3.recover();
	check('R2 a reload finds the queued words', (rec3.queues || []).some((q) => q.chatId === 'c1' && JSON.stringify(q.items).includes(WORDS)), rec3.queues);
	check('R2 the queue is not taken for an interrupted turn', !(rec3.turns || []).length, rec3.turns);
	const fresh = { id: 'c1', messages: [] };
	const box3 = { value: '', style: {}, dataset: { draftKey: 'chat/c1' } };
	const api3 = build(['giveBackQueue', 'intoComposer', 'giveBackQueues', 'queuedText'], Object.assign({}, stubs, {
		window: { DaimondJournal: J3, DaimondDrafts: DD }, DaimondJournal: J3, chatInput: box3, chats: [fresh], current: fresh }));
	api3.giveBackQueues(rec3.queues);
	await sleep(60);
	check('R2 the words go back into the composer, unsent', box3.value === WORDS && drafts['chat/c1'] === WORDS && st.elected.length === 0, { box: box3.value, drafts });
	check('R2 and the record is cleared once handed back', !rowsOf().some((r) => r.type === 'chat_queue'), rowsOf());
	// A drained item stays on disk until the turn it became has written its prompt row.
	chat._queue = [{ text: 'next one', drawn: '' }]; api.journalQueue(chat);
	await sleep(30);
	api.drainQueue(chat, false);
	await sleep(15);
	check('R2 a drained item stays durable while its election runs', rowsOf().some((r) => r.type === 'chat_queue' && JSON.stringify(r.items).includes('next one')), rowsOf());
	await sleep(80);
	check('R2 and goes once it was sent', !rowsOf().some((r) => r.type === 'chat_queue'), rowsOf());
	// A Here turn: what was said into it is still the turn's own record.
	chat._jturn = 'here-1'; chat._generating = true; chat._jsaid = ['said in']; chat._interject = []; chat._queue = [{ text: 'after it' }];
	api.journalQueue(chat);
	await sleep(40);
	const turnQ = rowsOf().filter((r) => r.type === 'queue' && r.stream === 'here-1');
	check('R2 words said into a Here turn stay on that turn', turnQ.length && JSON.stringify(turnQ[turnQ.length - 1].items) === '["said in"]', turnQ);
	check('R2 and its queue is the chat\'s', rowsOf().some((r) => r.type === 'chat_queue' && JSON.stringify(r.items) === '["after it"]'), rowsOf());
});

// ── R1: a runner's session holds only the turns it heard ──
await section('R1', async () => {
	const names = ['settleRunnerSession', 'staleEngine', 'captureSession', 'keepChatTaint', 'sessionMarker', 'engineHolds', 'tailAfter', 'sessionDoubt', 'sessionHeld'];
	const st = { held: null };
	const api = build(names, { loadMsgTombs: () => ({}), window: { DaimondPeer: { settlingReport: (r) => !!r && r.t === 'report' } },
		diag() {}, chatHoldingTurn: () => st.held, touchChat() {}, persistChats() {}, markChatTainted: () => false });
	const c = { id: 'c1', app: null, messages: [
			{ role: 'user', mid: 'u1', iturn: 'u1', ts: T0, content: 'q1' },
			{ role: 'assistant', mid: 'a1', iturn: 'u1', ts: T0 + 1, content: 'a1-words' },
			{ role: 'user', mid: 't2', iturn: 't2', ts: T0 + 2, content: 'read it' },
			{ role: 'user', mid: 't3', iturn: 't3', ts: T0 + 3, content: 'other q' },
			{ role: 'assistant', mid: 'a3', iturn: 't3', ts: T0 + 4, content: 'a3-words' },
			{ role: 'assistant', mid: 'e-t2-final', iturn: 't2', ts: T0 + 5, content: 'it says 7', framed: 1 }],
		session: { v: 1, upto: 'a1', uptoTs: T0 + 1, marks: { u1: 0 }, msgs: [{ role: 'user', content: 'q1', mid: 'u1' }, { role: 'assistant', content: 'a1-words' }] } };
	st.held = c;
	api.settleRunnerSession({ t: 'report', status: 'done', turnId: 't2', chatId: 'c1',
		session: { v: 1, base: 'a1', upto: 'e-t2-final', uptoTs: T0 + 5, msgs: [{ role: 'user', content: 'q1', mid: 'u1' }, { role: 'assistant', content: 'a1-words' },
			{ role: 'user', content: 'read it', mid: 't2' }, { role: 'assistant', content: 'it says 7' }] } });
	const tail = api.tailAfter(c, c.session);
	const doubt = api.sessionDoubt(c, c.session, tail, '');
	check('R1 a turn run elsewhere inside a runner\'s span reaches the model',
		!!doubt || (tail.some((m) => m.mid === 't3') && tail.some((m) => m.mid === 'a3')), { held: c.session.held, tail: tail.map((m) => m.mid), doubt });
	check('R1 the runner\'s own turn is held, not laid again', !tail.some((m) => m.mid === 't2' || m.mid === 'e-t2-final'), tail.map((m) => m.mid));
});

// ── R3: the queue waits for the lease as it stands at the door ──
for (const [what, door, drains] of [
	['the door holds a fresh renewal: the queue waits', { leases: { t2: 'live' }, unread: false }, 0],
	['the door cannot be read: the queue waits', { leases: {}, unread: true }, 0],
	['the door confirms the lapse: the queue goes', { leases: {}, unread: false }, 1]]) await section('R3 ' + what, async () => {
	const NOW = Date.now();
	const st = { drained: 0, doorReads: 0, armed: 0 };
	let rec = { holder: 'argonaut', mode: 'running', expiry: NOW - 120000 };	// the cache: last renewal seen before the lock
	const live = () => rec.expiry > Date.now();
	const Lease = {
		holder: () => (live() ? rec.holder : null), record: () => rec,
		adopt: (m) => { if (m.t2 === 'live') rec = { holder: 'argonaut', mode: 'running', expiry: NOW + 60000 }; return true; },
	};
	const Sync = { leaseGet: async () => { st.doorReads++; await sleep(5); return door; } };
	const chat = { id: 'c1', _queue: [{ text: 'and then summarise it', drawn: 'argonaut' }], messages: [
		{ role: 'user', mid: 't2', iturn: 't2', content: 'run the long job' },
		{ role: 'assistant', mid: 'ph-2', iturn: 't2', why: 'dispatched', content: '' }] };
	const api = build(['drainAfterHeld', 'dispatchInFlight', 'peerHeldTurnOf', 'peerLeaseHeld', 'lapsedByClock', 'confirmLapse', 'leaseDoorRead', 'lapseConfirmed', 'lapseMark'], {
		window: { DaimondLease: Lease, DaimondSync: Sync }, DaimondLease: Lease, DaimondSync: Sync,
		recoveringHere: () => false, diamondBusy: () => false, diag() {},
		drainQueue: () => { st.drained++; }, drainSteerQueue() {}, armHeldWake: () => { st.armed++; }, isLostRow: () => false,
		_peerStopping: {}, PEER_HELD: { claimed: 1, running: 1, blocked: 1, 'awaiting-consent': 1 },
		peerUiStateFor: () => (live() ? 'running' : 'failed'), peerReports: {}, _localRecovering: {}, _localEnding: {},
		selfDeviceId: () => 'phone', _lostRunOf: {}, lostRetryMid: (t) => t + '-rt', _lapseReading: {}, _lapseRead: {},
	});
	api.drainAfterHeld(chat);		// what the overdue wake runs on unlock
	check('R3 ' + what + ' (nothing goes on the cached expiry alone)', st.drained === 0 && st.doorReads === 1, st);
	await sleep(40);
	check('R3 ' + what, st.drained === drains && (drains || st.armed > 0), st);
});

console.log('\n' + (checks - failures) + '/' + checks + ' checks passed');
process.exit(failures ? 1 : 0);
