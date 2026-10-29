// FIRE C2-NOTE (UNBLOCK-11, rig c2behind on r572z): `peerReconstruct` counted the lack right after the graft, and
// `runTurn` laid that note on the turn unchanged, while the model's history is read from the store after the awaits
// between (the diamond wait, `scopeChatTo`, runErrand). A pull landing the missing rows in between left a stale
// "had not yet received N earlier messages" on a turn that held every row. The note and the rows now come from one
// reading: `runnerTurnOpts` counts the lack when the turn lays its history. Red on aec3dd78, green after.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWindow, declLine } from '../../dev/syncprobe.mjs';
import { loadPage } from './test/page.mjs';
import { loadPeer } from './c2ready_common.mjs';
const DP = loadPeer();
const msgs = [];
for (let i = 0; i < 30; i++) msgs.push({ role: i % 2 ? 'assistant' : 'user', content: 'row ' + i, mid: 'm' + i, ts: 100 + i });
msgs.push({ role: 'user', content: 'what came before?', mid: 'T', ts: 200 });
const asker = { id: 'c1', _loaded: true, messages: msgs };
const GAP = ['m2', 'm3', 'm4', 'm5', 'm6'];	// below the seed: only a pull brings them
async function run(landBeforeTurn) {
	const errand = DP.buildDispatch(asker, { turnId: 'T', chatId: 'c1', prompt: 'what came before?', by: 'phone', now: 300 }).errand(0);
	const held = msgs.slice(0, 30).filter((m) => !GAP.includes(m.mid)).map((m) => Object.assign({}, m));
	const chats = [{ id: 'c1', _loaded: true, messages: held }];
	const win = makeWindow({}); win.setTimeout = setTimeout; win.Date = Date;
	win.DaimondPeer = DP;
	win.DaimondSync = { version: () => 0, pull: async () => {} };
	const names = ['peerReady', 'peerReconstruct', 'lackedNote', 'THROUGH_WAIT_MS', 'throughDeadline', 'graftSeed',
		'RECONSTRUCT_STALL_MS', 'RECONSTRUCT_ABS_CAP_MS', 'RECONSTRUCT_PULL_MIN_MS', 'RECONSTRUCT_PULL_MAX_MS', 'syncHeld'];
	if (declLine('runnerTurnOpts') > 0) names.push('runnerTurnOpts');
	const R = loadPage({ window: win, want: names, stub: {
		diag() {}, chats, loadChatMessages: async () => {}, onChatsChangedElsewhere: async () => {}, persistChats() {}, touchChat() {},
		honourGone() {}, DaimondMarksHere: { chatSettle() {} }, ensureApp: () => ({}), scopeChatTo: async () => {}, diamonds: [], loadDiamonds: async () => {} } });
	await R.peerReady(errand, [], 200);
	const ctx = await R.peerReconstruct(errand, []);
	// The note as reconstruct read it, before any pull lands.
	const atReconstruct = R.runnerTurnOpts ? (R.runnerTurnOpts(ctx, { pre: '' }).pre || '') : (ctx.lacked || '');
	if (landBeforeTurn) {	// a pull lands the missing rows between reconstruct and runTurn
		const c = ctx.chat;
		for (const mid of GAP) c.messages.push(Object.assign({}, msgs.find((m) => m.mid === mid)));
		c.messages.sort((a, b) => a.ts - b.ts);
	}
	// What runTurn hands the model: its `pre`, and the rows it reads from the store.
	const opts = R.runnerTurnOpts ? R.runnerTurnOpts(ctx, { pre: '' })
		: (ctx.lacked ? Object.assign({}, { pre: '' }, { pre: ctx.lacked + '' }) : { pre: '' });	// base behaviour (aec3dd78)
	return { atReconstruct, pre: opts.pre || '', rows: ctx.chat.messages.map((m) => m.mid) };
}
test('the copy lacks 5 at reconstruct; a pull lands them before runTurn: no note, every row', async () => {
	const { atReconstruct, pre, rows } = await run(true);
	assert.match(atReconstruct, /had not yet received 5 earlier messages/);
	for (const m of msgs) assert.ok(rows.includes(m.mid), 'row ' + m.mid + ' in the turn');
	assert.equal(pre, '', 'a stale note on a turn holding every row: ' + pre);
});
test('still lacking at runTurn: the note with the true count', async () => {
	const { pre, rows } = await run(false);
	assert.match(pre, /had not yet received 5 earlier messages/);
	for (const mid of GAP) assert.ok(!rows.includes(mid));
});
