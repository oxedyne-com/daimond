// QA r572z-A N1 (UNBLOCK-11): readiness compared how MANY of the asker's messages the runner held, not WHICH.
// The phone sends turn 1, then turn 2; the runner's own answer to turn 1 (a row the phone has not seen) made up
// for an older message it lacked below the seed, so turn 2 ran at once with no note. The errand now carries the
// asker's message ids and readiness checks each one is held.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPeer } from './c2ready_common.mjs';
const DP = loadPeer();
const old = [];
for (let i = 0; i < 30; i++) old.push({ role: i % 2 ? 'assistant' : 'user', content: (i === 2 ? 'MY NAME IS ZED. ' : '') + 'row ' + i, mid: 'm' + i, ts: 100 + i });
// The phone: turn 1 handed off (its placeholder is not conversation), then turn 2.
const phone = { id: 'c1', _loaded: true, messages: old.concat([
	{ role: 'user', content: 'turn one', mid: 'T1', ts: 200 },
	{ role: 'assistant', content: '', mid: 'p1', ts: 201, interrupted: true, why: 'dispatched', iturn: 'T1' },
	{ role: 'user', content: 'what is my name?', mid: 'T2', ts: 210 },
]) };
const e2 = DP.buildDispatch(phone, { turnId: 'T2', chatId: 'c1', prompt: 'what is my name?', by: 'phone', now: 300 }).errand(0);
// The runner: stale without m2 (below the 24-message seed), holding turn 1 and its own answer to it.
function runner(drop) {
	return { id: 'c1', _loaded: true, messages: old.filter(m => !drop.includes(m.mid)).concat([
		{ role: 'user', content: 'turn one', mid: 'T1', ts: 200 },
		{ role: 'assistant', content: 'answer one', mid: 'a1', ts: 205, iturn: 'T1' },
	]) };
}
test('the seed cannot carry m2', () => {
	assert.ok(!e2.seed.msgs.some(m => m.mid === 'm2'));
});
test('N1: a runner lacking an old message is behind, though its own answer makes up the count', () => {
	const rd = DP.threadReadiness(runner(['m2']), e2, 0, []);
	assert.equal(rd.state, 'behind');
	assert.equal(rd.ready, false);
	assert.equal(rd.lack, 1);
});
test('the note counts the ids actually missing', () => {
	const rd = DP.threadReadiness(runner(['m2', 'm4', 'm5']), e2, 0, []);
	assert.equal(rd.ready, false);
	assert.equal(rd.lack, 3);
});
test('a runner holding every message the asker saw, plus its own answer, runs', () => {
	const rd = DP.threadReadiness(runner([]), e2, 0, []);
	assert.equal(rd.ready, true);
	assert.equal(rd.lack, 0);
});
