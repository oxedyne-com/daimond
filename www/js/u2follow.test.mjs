/* ============================================================
   Test: a word typed into a busy Diamond with the switch on a runner goes
   to the election (U2FIX fix 1, rig r572w followup, DIAG_U2R572W §1).

   The phone sent `t` inside the tail of a finishing local daimon turn, with the
   switch on argonaut. `sendToDiamondTurn` said it into the running turn with no
   `seatNamesRunner` check; the turn had no seam left, and `t` reached no model.
   The chat's send already queued in that case (UNBLOCK-1 QFOLLOW); a Diamond's
   send now takes the same rule (`sayIntoHere`).

     F1  switch on a runner: queued, not said into the turn
     F2  ... and the queue, drained as the turn ends, goes to the election
     F3  switch on Here: said into the running turn, as before
     F4  the chat's send and the Diamond's ask the one rule

   Run:  node --test www/js/u2follow.test.mjs
   Red:  MM_SRC_REV=529df246 node --test www/js/u2follow.test.mjs
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { source, lift, liftFn } from './testlift.mjs';
import { fakeIDB, tabJournal, journalQueueOver } from './journalfixture.mjs';

const SRC = source('daimond.js');
const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle() { for (let i = 0; i < 6; i++) await tick(); }

function world(over) {
	const log = [];
	const rec = { id: 'd1chat', diamondId: 'D1', messages: [], _queue: [] };
	const env = {
		log, rec,
		current: rec, currentDiamond: { id: 'D1' }, chats: [rec], _unloading: false, locked: false,
		busy: true,
		sw: null,
		diamondBusy: () => env.busy,
		recoveringHere: () => false,
		peerHeldTurnOf: () => null,
		sayToRunner: async () => false,
		maybeAutoDispatch: async (c, text) => { log.push(['elect', text]); await tick(); return true; },
		interjectMessage: (c, text) => { log.push(['interject', text]); return true; },
		journalQueue: journalQueueOver(SRC, tabJournal(fakeIDB(), new Set())), giveUpSent: () => {}, syncSendMode: () => {}, renderQueue: () => {},
		updateQueueBadges: () => {}, returnQueue: () => { log.push(['returnQueue']); }, askHolds: () => false, dispatchInFlight: () => null,
		runSteer: async (f, text) => { log.push(['runSteer', text]); return true; },
		seatOpts: () => ({ selfId: 'PHONE' }),
		chatRunningOn: () => '',
		turnPresence: (p) => p,
		presenceWithLeaseBusy: (p) => p,
		DaimondPresence: { snapshot: () => ({}) },
		diag: () => {},
		Promise, setTimeout, Object, Array, String, JSON, Date,
	};
	env.DaimondPeer = { seatSwitch: () => env.sw };
	env.window = env;
	return Object.assign(env, over || {});
}

function rig(env) {
	const want = ['sendToDiamondTurn', 'seatSwitchFor', 'seatNamesRunner', 'enqueueMessage', 'drainSteerQueue', 'steerQueued'];
	const l = lift(SRC, want.concat(liftFn(SRC, 'sayIntoHere') ? ['sayIntoHere'] : []));
	assert.deepEqual(l.missing, []);
	const scope = new Proxy(env, { has: (t, k) => typeof k === 'string' && k in t, get: (t, k) => t[k], set: (t, k, v) => { t[k] = v; return true; } });
	return new Function('scope', 'with (scope) {\n' + l.body + '\nreturn { sendToDiamondTurn, drainSteerQueue };\n}')(scope);
}

const RUNNER = { choice: 'runner', runner: { deviceId: 'ARGONAUT' } };

test('F1: switch on a runner: a word typed into the busy daimon is queued, not said into its turn', async () => {
	const w = world({ sw: RUNNER });
	assert.equal(await rig(w).sendToDiamondTurn(w.rec, 't', 't'), true);
	assert.ok(!w.log.some((x) => x[0] === 'interject'), 'not said into the turn here: ' + JSON.stringify(w.log));
	assert.deepEqual(w.rec._queue, [{ text: 't', drawn: undefined }]);
});

test('F2: ... and as the turn ends the queue goes to the election, so the word reaches a model', async () => {
	const w = world({ sw: RUNNER });
	const r = rig(w);
	await r.sendToDiamondTurn(w.rec, 't', 't');
	w.busy = false;
	r.drainSteerQueue(w.rec, 'D1', false);
	await settle();
	assert.deepEqual(w.log, [['elect', 't']], JSON.stringify(w.log));
	assert.equal(w.rec._queue.length, 0);
});

test('F3: switch on Here: said into the running turn, as before', async () => {
	const w = world({ sw: { choice: 'here', runner: { deviceId: 'ARGONAUT' } } });
	assert.equal(await rig(w).sendToDiamondTurn(w.rec, 't', 't'), true);
	assert.deepEqual(w.log, [['interject', 't']], JSON.stringify(w.log));
	assert.deepEqual(w.rec._queue, []);
});

test('F4: the chat\'s send and the Diamond\'s ask the one rule', () => {
	const sp = liftFn(SRC, 'sendPressed'), sd = liftFn(SRC, 'sendToDiamondTurn');
	assert.match(sp, /sayIntoHere\(chat, text, words\)/);
	assert.match(sd, /sayIntoHere\(target, text, words\)/);
	assert.ok(sp.indexOf('interjectMessage(') < 0 && sd.indexOf('interjectMessage(') < 0, 'neither says into a turn but through sayIntoHere');
});
