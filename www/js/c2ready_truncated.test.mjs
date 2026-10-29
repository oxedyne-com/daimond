// QA r572y C2b F1: a runner whose copy is the errand's seed tail only (or has a gap the seed cannot fill)
// held `through` and ran at once with no lacked note. Readiness is judged on the asker's WHOLE history: such a
// copy keeps pulling to the one deadline, then runs with a note saying how many messages it lacks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWindow } from '../../dev/syncprobe.mjs';
import { loadPage } from './test/page.mjs';
import { loadPeer } from './c2ready_common.mjs';
const DP = loadPeer();
const BOUND = 400;
const msgs = [];
for (let i = 0; i < 30; i++) msgs.push({ role: i % 2 ? 'assistant' : 'user', content: (i === 2 ? 'MY NAME IS ZED. ' : '') + 'row ' + i, mid: 'm' + i, ts: 100 + i });
msgs.push({ role: 'user', content: 'what is my name?', mid: 'T', ts: 200 });
const asker = { id: 'c1', _loaded: true, messages: msgs };
function errandNow() { return DP.buildDispatch(asker, { turnId: 'T', chatId: 'c1', prompt: 'what is my name?', by: 'phone', now: 300 }).errand(0); }
async function run(runnerMsgs) {
	const errand = errandNow();
	const chats = runnerMsgs ? [{ id: 'c1', _loaded: true, messages: runnerMsgs.map(m => Object.assign({}, m)) }] : [];
	const win = makeWindow({}); win.setTimeout = setTimeout; win.Date = Date;
	win.DaimondPeer = DP;
	win.DaimondSync = { version: () => 0, pull: async () => {} };	// the parcel never brings the rest in this window
	const R = loadPage({ window: win, want: ['peerReady', 'peerReconstruct', 'lackedNote', 'THROUGH_WAIT_MS', 'throughDeadline', 'graftSeed',
		'RECONSTRUCT_STALL_MS', 'RECONSTRUCT_ABS_CAP_MS', 'RECONSTRUCT_PULL_MIN_MS', 'RECONSTRUCT_PULL_MAX_MS', 'syncHeld', 'runnerTurnOpts'], stub: {
		diag() {}, chats, loadChatMessages: async () => {}, onChatsChangedElsewhere: async () => {}, persistChats() {}, touchChat() {},
		honourGone() {}, DaimondMarksHere: { chatSettle() {} }, ensureApp: () => ({}), scopeChatTo: async () => {}, diamonds: [], loadDiamonds: async () => {} } });
	const t0 = Date.now();
	const rd = await R.peerReady(errand, [], BOUND);
	const waited = Date.now() - t0;
	const ctx = await R.peerReconstruct(errand, []);
	const out = { lacked: R.runnerTurnOpts(ctx, { pre: '' }).pre || '' };	// the note as runTurn reads it (C2-NOTE)
	return { errand, rd, waited, out };
}
test('the seed carries through but not the whole thread', () => {
	const e = errandNow();
	assert.equal(e.through.mid, 'm29');
	assert.ok(e.seed.msgs.some(m => m.mid === 'm29'));
	assert.ok(!e.seed.msgs.some(m => m.mid === 'm2'));
	assert.equal(e.thread.n, 30);
});
test('A: a runner that never saw the chat waits the bound and says how many messages it lacks', async () => {
	const { rd, waited, out } = await run(null);
	assert.ok(waited >= BOUND - 20, 'waited ' + waited + ' ms');
	assert.match(rd.lacked, /7 earlier messages/);
	assert.match(out.lacked, /7 earlier messages/);
});
test('B: a runner stale at m0..m3 with a gap the seed cannot fill does too', async () => {
	const { rd, waited, out } = await run(msgs.slice(0, 4));
	assert.ok(waited >= BOUND - 20, 'waited ' + waited + ' ms');
	assert.match(rd.lacked, /3 earlier messages/);
	assert.match(out.lacked, /3 earlier messages/);
});
test('a runner holding the whole thread runs at once with no note', async () => {
	const { rd, waited, out } = await run(msgs.slice(0, 30));
	assert.ok(waited < 200, 'waited ' + waited + ' ms');
	assert.equal(rd.lacked, '');
	assert.equal(out.lacked, '');
});
test('a diverged copy (every row plus one the asker never saw) runs at once with no note', async () => {
	const extra = msgs.slice(0, 30).concat([{ role: 'user', content: 'only here', mid: 'x1', ts: 150 }]);
	const { rd, waited, out } = await run(extra);
	assert.ok(waited < 200, 'waited ' + waited + ' ms');
	assert.equal(rd.lacked, '');
	assert.equal(out.lacked, '');
});
