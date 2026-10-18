// QA r572y C2b F3: the asker's last row is a cut turn's landed partial answer. `through` named it while the seed
// and the thread fingerprint both left it out, so the runner waited the bound and told the model a false "missing".
// One rule says which rows are conversation, and a landed interrupted partial is one of them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWindow, sliceDaimond } from '../../dev/syncprobe.mjs';
import { loadPeer } from './c2ready_common.mjs';
const DP = loadPeer();
const asker = { id: 'c1', _loaded: true, messages: [
	{ role: 'user', content: 'q', mid: 'm1', ts: 10 },
	{ role: 'assistant', content: 'a', mid: 'm2', ts: 20 },
	{ role: 'user', content: 'q2', mid: 'm3', ts: 30 },
	{ role: 'assistant', content: 'partial before the cut', mid: 'm4', iturn: 'm3', interrupted: true, ts: 40 },
	{ role: 'user', content: 'go on', mid: 'T', ts: 50 } ] };
const errand = DP.buildDispatch(asker, { turnId: 'T', chatId: 'c1', prompt: 'go on', by: 'phone', now: 60 }).errand(0);
test('through, the seed and the fingerprint agree the partial is conversation', () => {
	assert.equal(errand.through.mid, 'm4');
	assert.deepEqual(errand.seed.msgs.map(m => m.mid), ['m1', 'm2', 'm3', 'm4', 'T']);
	assert.equal(errand.thread.n, 4);
});
test('a runner holding m1..m3 is ready at once on the seed, with no false lacked note', async () => {
	const live = { id: 'c1', _loaded: true, messages: asker.messages.slice(0, 3).map(m => Object.assign({}, m)) };
	const win = makeWindow({}); win.setTimeout = setTimeout; win.Date = Date; win.DaimondPeer = DP;
	win.DaimondSync = { version: () => 0, pull: async () => {} };
	const R = sliceDaimond(win, ['peerReady', 'lackedNote', 'syncHeld', 'THROUGH_WAIT_MS', 'throughDeadline'], {
		diag() {}, chats: [live], loadChatMessages: async () => {}, onChatsChangedElsewhere: async () => {} }).fns;
	const t0 = Date.now();
	const v = await R.peerReady(errand, [], 3000);
	const dt = Date.now() - t0;
	assert.ok(dt < 500, 'waited ' + dt + ' ms');
	assert.equal(v.lacked, '');
});
test('a dispatched placeholder is not conversation, even carrying words', () => {
	const c = { messages: asker.messages.slice(0, 3).concat([
		{ role: 'assistant', content: 'progress', mid: 'p1', iturn: 'm3', interrupted: true, why: 'dispatched', ts: 40 },
		{ role: 'user', content: 'go on', mid: 'T', ts: 50 }]) };
	assert.equal(DP.threadSig(c, 'T').n, 3);
	assert.equal(DP.throughOf(c, 'T').mid, 'm3');
	assert.deepEqual(DP.seedFrom(c, 'T').msgs.map(m => m.mid), ['m1', 'm2', 'm3', 'T']);
});
