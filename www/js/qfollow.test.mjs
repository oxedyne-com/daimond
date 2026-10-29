/* ============================================================
   Test: a follow-up goes where the switch says (UNBLOCK-1 QFOLLOW, FIRE under
   D-20261013-02).

   Rig, r572y (syncgate smoke 2/2b): the phone sent `t` ~1 s after a local
   answer, with the switch on argonaut. The send found the chat still
   generating, said `t` into the running turn or queued it, and the queue ran
   it with `runTurn`, here. No election was logged; the switch named argonaut.

   Lifts the REAL send, queue and seat blocks out of daimond.js and runs them in
   a scope of fakes, so a name the code reaches for and the fakes lack fails
   loudly rather than passing for nothing.

     Q1  a queued follow-up goes to the election first, and is not run here
     Q2  one the election keeps here runs here, as the person's
     Q3  two queued, both handed off in the order typed
     Q4  the election's wait took the person away: it goes back to the queue
     Q5  typed into a running turn with the switch on a runner: queued, not said into it
     Q6  with the switch on Here: said into the running turn, as before
     Q7  a daimon's queued steer goes to the election first
     Q8  every Retry is routed: retryTurn ends in retryRouted, an edit's too
     Q9  Continue on a partial goes to the election first, as the app's nudge;
         one the election keeps here runs here, saying so if the runner was gone
     Q10 Continue on a stopped turn's line goes to the election first

   Run:  node --test www/js/qfollow.test.mjs
   ============================================================ */
import { readPage } from '../../dev/pagesrc.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fakeIDB, tabJournal, journalQueueOver } from './journalfixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC  = readPage(join(HERE, 'daimond.js'), 'utf8');

function lift(name, optional) {
	let a = SRC.indexOf('\n\tfunction ' + name + '(');
	if (a < 0) a = SRC.indexOf('\n\tasync function ' + name + '(');
	if (a < 0) {
		if (optional) return '';
		throw new Error('daimond.js holds no ' + name);
	}
	const b = SRC.indexOf('\n\t}\n', a);
	return SRC.slice(a, b + 3);
}

// The lifted functions run `with` a scope that holds ONLY the fakes given, plus the
// real globals; any other free name is a ReferenceError.
function rig(names, env) {
	const have = names.map((n) => [n.replace('?', ''), lift(n.replace('?', ''), n.endsWith('?'))]).filter((x) => x[1]);
	const body = have.map((x) => x[1]).join('\n')
		+ '\nreturn {' + have.map((x) => x[0] + ': ' + x[0]).join(', ') + '};';
	const scope = new Proxy(env, {
		has: (t, k) => typeof k === 'string' && k in t,
		get: (t, k) => t[k],
		set: (t, k, v) => { t[k] = v; return true; },
	});
	return new Function('scope', 'with (scope) {\n' + body + '\n}')(scope);
}

const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle() { for (let i = 0; i < 6; i++) await tick(); }

// The fakes the queue and the send reach for. `log` records every effect in order.
function world(over) {
	const log = [];
	const chat = { id: 'c1', messages: [], _queue: [], provider: 'p', model: 'm' };
	const env = {
		log, chat,
		current: chat, currentDiamond: null, chats: [chat], _unloading: false, locked: false, cfg: {},
		elect: true,					// what maybeAutoDispatch answers
		sw: null,						// what the seat switch reads
		maybeAutoDispatch: async (c, text) => { log.push(['elect', text]); await tick(); return typeof env.elect === 'function' ? env.elect(c, text) : env.elect; },
		runTurn: async (c, text, opts) => { log.push(['runTurn', text, !!(opts && opts.person)]); if (opts && opts.onStart) opts.onStart(); return true; },
		runSteer: async (f, text) => { log.push(['runSteer', text]); return true; },
		doSteer: (text) => { log.push(['doSteer', text]); },
		retryTurn: () => { log.push(['retryTurn']); return true; },
		holdSend: (c) => { c._sending = true; let freed; c._sent = new Promise((r) => { freed = r; }); return () => { c._sending = false; freed(); }; },
		interjectMessage: (c, text) => { log.push(['interject', text]); return true; },
		enqueueMessage: (c, text, words, drawn) => { log.push(['enqueue', text]); (c._queue = c._queue || []).push({ text: text, drawn: drawn }); },
		giveUpSent: () => {},
		journalQueue: journalQueueOver(SRC, tabJournal(fakeIDB(), new Set())),	// the real journal (QA ccp3 A R2)
		renderQueue: () => {},
		updateQueueBadges: () => {},
		returnQueue: (c) => { log.push(['returnQueue']); },
		askHolds: () => false,
		diag: () => {},
		recoveringHere: () => false, dispatchInFlight: () => null,
		diamondBusy: () => false,
		turnHold: () => null,
		confirmHold: async () => {},
		loadChatMessages: async () => {},
		conciseText: (c, text) => text,
		startChat: () => {},
		newChat: () => {},
		openSettings: () => {},
		cfgReady: () => true,
		t: (k) => k,
		seatOpts: () => ({ selfId: 'PHONE' }),
		chatRunningOn: () => '',
		annotatePresence: (p) => p,
		turnPresence: (p) => p,
		presenceWithLeaseBusy: (p) => p,
		DaimondPresence: { snapshot: () => ({}) },
		DaimondModels: { resolve: () => ({}) },
		Promise, setTimeout, Object, Array, String, JSON, Date, Math,
	};
	env.DaimondPeer = { seatSwitch: () => env.sw };
	env.window = env;
	return Object.assign(env, over || {});
}

const QUEUE = ['drainQueue', 'sendQueued?'];
const SEND  = ['sendPressed', 'sayIntoHere?', 'seatSwitchFor?', 'seatNamesRunner?'];
const STEER = ['drainSteerQueue', 'steerQueued?'];

test('Q1: a queued follow-up goes to the election first, and is not run here', async () => {
	const w = world();
	w.chat._queue = [{ text: 't' }];
	rig(QUEUE, w).drainQueue(w.chat, false);
	await settle();
	assert.deepEqual(w.log, [['elect', 't']], JSON.stringify(w.log));
	assert.equal(w.chat._queue.length, 0);
	assert.equal(w.chat._sending, false, 'the composer is given back after the hand-off');
});

test('Q2: one the election keeps here runs here, as the person\'s', async () => {
	const w = world({ elect: false });
	w.chat._queue = [{ text: 't' }];
	rig(QUEUE, w).drainQueue(w.chat, false);
	await settle();
	assert.deepEqual(w.log, [['elect', 't'], ['runTurn', 't', true]], JSON.stringify(w.log));
	assert.equal(w.chat._sending, false);
});

test('Q3: two queued, both handed off in the order typed', async () => {
	const w = world();
	w.chat._queue = [{ text: 't1' }, { text: 't2' }];
	rig(QUEUE, w).drainQueue(w.chat, false);
	await settle();
	assert.deepEqual(w.log, [['elect', 't1'], ['elect', 't2']], JSON.stringify(w.log));
	assert.equal(w.chat._queue.length, 0);
});

test('Q4: the election\'s wait took the person away: it goes back to the queue, unrun', async () => {
	const other = { id: 'c2', messages: [] };
	const w = world();
	w.elect = () => { w.current = other; return false; };
	w.chat._queue = [{ text: 't' }];
	rig(QUEUE, w).drainQueue(w.chat, false);
	await settle();
	assert.deepEqual(w.log, [['elect', 't']], JSON.stringify(w.log));
	assert.deepEqual(w.chat._queue, [{ text: 't' }]);
});

test('Q5: typed into a running turn with the switch on a runner: queued, not said into it', async () => {
	const w = world({ sw: { choice: 'runner', runner: { deviceId: 'ARGONAUT' } } });
	w.chat._generating = true;
	w.chat._sending = true;			// the press's own hold, as sendUserMessage holds it
	w.chat.app = { interject() {} };
	await rig(SEND, w).sendPressed(w.chat, 't', { words: 't', release() {} });
	assert.deepEqual(w.log, [['enqueue', 't']], JSON.stringify(w.log));
});

test('Q6: with the switch on Here: said into the running turn, as before', async () => {
	const w = world({ sw: { choice: 'here', runner: { deviceId: 'ARGONAUT' } } });
	w.chat._generating = true;
	w.chat._sending = true;
	await rig(SEND, w).sendPressed(w.chat, 't', { words: 't', release() {} });
	assert.deepEqual(w.log, [['interject', 't']], JSON.stringify(w.log));
});

test('Q7: a daimon\'s queued steer goes to the election first', async () => {
	const w = world();
	const rec = { id: 'd1chat', diamondId: 'D1', messages: [], _queue: [{ text: 's' }] };
	w.currentDiamond = { id: 'D1' };
	rig(STEER, w).drainSteerQueue(rec, 'D1', false);
	await settle();
	assert.deepEqual(w.log, [['elect', 's']], JSON.stringify(w.log));
	assert.equal(rec._queue.length, 0);
});

test('Q8: every Retry is routed, an edit\'s resend too', () => {
	const rt = lift('retryTurn');
	assert.match(rt, /return retryRouted\(chat, text, nmid, lost, ropts && ropts\.onStart, ropts \? ropts\.drawn : undefined, !!\(ropts && ropts\.here\)\);\s*\}$/);
	assert.ok(rt.indexOf('askAgain(') < 0, 'retryTurn asks again only through retryRouted');
	// One path for every Retry, a daimon's too (SUHT-R F2): `askAgain` runs the chat's turn or the daimon's steer.
	assert.match(lift('retryRouted'), /return askAgain\(chat, text, \{ person: true, mid: nmid, onStart: onStart \}\);/);
});

// Continue: the partial's turn and the stop line, with the fakes the two doors reach for.
const CONT = ['continueTurn', 'continueStopped', 'continueRouted?'];
function contWorld(over) {
	const w = world(over);
	w.CONTINUE_NUDGE = 'NUDGE';
	w.maybeAutoDispatch = async (c, text, words, mid, app) => {
		w.log.push(['elect', text, !!app]); await tick();
		return typeof w.elect === 'function' ? w.elect(c, text) : w.elect;
	};
	w.runTurn = async (c, text, opts) => {
		w.log.push(['runTurn', text, !!(opts && (opts.person || opts.elected))]);
		if (opts && opts.onStart) opts.onStart();
		return true;
	};
	w.turnMessagesOf = (c, iturn) => c.messages.filter((m) => m.iturn === iturn);
	w.loadMsgTombs = () => ({});
	w.handoffTargetLabel = () => '';
	w.deviceLabelFor = () => '';
	w.clearBadge = (m) => { m.interrupted = 0; return m; };
	w.touchChat = () => {};
	w.persistChats = () => {};
	w.renderHistory = () => {};
	w.chatIsActiveErrand = () => false;
	w.endContinuable = () => true;
	w.retireContinue = () => {};
	w.DaimondPeer.isAskAnswer = () => false;
	return w;
}
function partialChat(w) {
	w.chat.messages = [
		{ role: 'user', content: 'q', mid: 'T1', iturn: 'T1' },
		{ role: 'assistant', content: 'half an ans', mid: 'A1', iturn: 'T1', interrupted: 1 },
	];
}

test('Q9: Continue on a partial goes to the election first, as the app\'s nudge', async () => {
	const w = contWorld();
	partialChat(w);
	rig(CONT, w).continueTurn(w.chat, 'T1', 'q');
	await settle();
	assert.deepEqual(w.log, [['elect', 'NUDGE', true]], JSON.stringify(w.log));
	assert.equal(w.chat.messages[1].interrupted, 0, 'the partial is an ordinary answer, so it rides the thread');
	assert.equal(w.chat._sending, false, 'the composer is given back after the hand-off');
});

test('Q9: one the election keeps here runs here once, saying so if the runner was gone', async () => {
	const w = contWorld({ elect: false });
	partialChat(w);
	rig(CONT, w).continueTurn(w.chat, 'T1', 'q');
	await settle();
	assert.deepEqual(w.log, [['elect', 'NUDGE', true], ['runTurn', 'NUDGE', true]], JSON.stringify(w.log));
	assert.equal(w.chat._sending, false);
});

test('Q10: Continue on a stopped turn\'s line goes to the election first', async () => {
	const w = contWorld();
	w.chat.messages = [{ role: 'assistant', content: 'part' }, { role: 'end_log', content: '' }];
	rig(CONT, w).continueStopped(w.chat, null);
	await settle();
	assert.deepEqual(w.log, [['elect', 'NUDGE', true]], JSON.stringify(w.log));
	assert.equal(w.chat._sending, false);
});
