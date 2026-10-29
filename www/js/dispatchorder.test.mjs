// R568-FU F4 (17 Oct 2026): a hand-off refused and fallen back here is this device's run from the
// moment `recoverOneLocally` takes it (`_localRecovering`), but the chat is not `_generating` until
// the claim and the lease land, up to 39 s in the rig's stall. A follow-up typed in that window
// started a local turn of its own; the refused turn then found the chat generating and gave up,
// to run later off the backstop. Turns ran out of the order they were sent. A send now queues
// behind a turn being taken back exactly as behind one generating, and the queue drains when the
// taken-back turn ends, however it ends.
//
// daimond.js cannot be loaded whole in Node, so the functions are cut out by name.
import { readPage } from '../../dev/pagesrc.mjs';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));
const src  = readPage(join(HERE, 'daimond.js'), 'utf8');

function cut(name) {
	let at = src.indexOf('\n\tasync function ' + name + '(');
	if (at < 0) at = src.indexOf('\n\tfunction ' + name + '(');
	if (at < 0) return null;
	const end = src.indexOf('\n\t}\n', at);
	return src.slice(at + 1, end + 3);
}

function world(claimed) {
	const W = { order: [], chat: { id: 'c-f4', _queue: [] } };
	let letClaim;
	const claim = new Promise((r) => { letClaim = r; });
	const deps = {
		_localRecovering: Object.create(null),
		chats: [W.chat],
		claimTurnHere: () => claim,
		redrawRunner: () => {},
		diag: () => {},
		errandForRecovery: (c, m) => ({ chatId: c.id, turnId: m.iturn }),
		DaimondPeer: {
			decideNow: () => false,
			// A turn that ran here drains ONE queued message as it ends (`runTurn` -> `drainQueue`).
			runErrand: async () => { W.order.push('refused turn'); deps.drainQueue(W.chat); return { ran: true, done: true }; },
			standDownUndecided: () => false,
		},
		runnerCtxBegin: () => {},
		runnerCtxEnd: () => {},
		peerRunErrandDeps: () => ({}),
		scheduleDispatchFallback: () => {},
		UNDECIDED_RECOLLECT_MS: 1,
		dropDispatchedPlaceholder: () => {},
		renderDispatchedBadges: () => {},
		selfDeviceId: () => 'dev-self',
		drainQueue: (c) => { if (c._queue.length) W.order.push(c._queue.shift().text); },
	};
	const names = ['recoverOneLocally', 'recoveringHere'];
	const body = names.map((n) => cut(n) || '').join('\n');
	W.fn = new Function(...Object.keys(deps), body + '\nreturn {'
		+ names.map((n) => n + ': typeof ' + n + " === 'function' ? " + n + ' : null').join(',') + '};')(...Object.values(deps));
	W.claim = () => letClaim(claimed ? { release: () => {} } : null);
	return W;
}

test('a follow-up typed while a refused turn is being taken back waits behind it', async () => {
	const W = world(true);
	const run = W.fn.recoverOneLocally(W.chat, { iturn: 't-refused' });
	assert.ok(W.fn.recoveringHere, 'nothing says a turn is being taken back to run in this chat');
	assert.equal(W.fn.recoveringHere(W.chat), true, 'the chat reads free while its turn is taken back');
	W.chat._queue.push({ text: 'follow-up' }, { text: 'and another' });	// what sendPressed does with a chat that is not free
	W.claim();
	await run;
	// The second waits on the first, whose own end sends it: two at once would run side by side.
	assert.deepEqual(W.order, ['refused turn', 'follow-up']);
	assert.deepEqual(W.chat._queue, [{ text: 'and another' }]);
	assert.equal(W.fn.recoveringHere(W.chat), false);
});

test('a take-back that stands down still sends what waited on it', async () => {
	const W = world(false);
	const run = W.fn.recoverOneLocally(W.chat, { iturn: 't-refused' });
	assert.ok(W.fn.recoveringHere && W.fn.recoveringHere(W.chat));
	W.chat._queue.push({ text: 'follow-up' });
	W.claim();
	await run;
	assert.deepEqual(W.order, ['follow-up'], 'the follow-up was stranded behind a turn that never ran here');
});

test('the send path queues behind a turn being taken back, before it decides to run', () => {
	const send = cut('sendPressed');
	assert.ok(send, 'sendPressed is not in daimond.js');
	// A chat's send, and a daimon's steer, which dispatches through the same door first.
	const waits = send.indexOf('recoveringHere(chat)');
	assert.ok(waits > 0, 'sendPressed never asks whether the chat\'s turn is being taken back');
	assert.ok(waits < send.lastIndexOf('maybeAutoDispatch('), 'it asks only after it has dispatched or run');
	// A steer's route while a turn may run is `sendToDiamondTurn` (UNBLOCK-27 R7c), which sendPressed calls.
	const route = cut('sendToDiamondTurn');
	assert.ok(route && send.indexOf('sendToDiamondTurn(') > 0, 'sendPressed does not route a steer through sendToDiamondTurn');
	const steer = route.indexOf('recoveringHere(target)');
	assert.ok(steer > 0, 'a steer never asks whether the daimon\'s turn is being taken back');
	assert.ok(steer < route.indexOf('maybeAutoDispatch('), 'a steer asks only after it has dispatched or run');
});
