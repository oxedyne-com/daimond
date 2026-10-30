// R568-FU F3 (17 Oct 2026), rewritten for P2.3b3/P2.3c1: a re-take of this device's own live lease
// after a reload ends the turn Interrupted. The journal's rounds were folded into the chat (with a
// chat made from the seed when the reload beat the seed graft); since the chat log (P2.3) the rounds
// the run wrote are in the log already, so the run ENDS through the one writer of `interrupted`
// (turnwrite `endInterrupted`), its journal run is cleared, and no chat is made or folded here.
//
// daimond.js cannot be loaded whole in Node, so `endInterruptedRun` is cut out by name and run
// against a stub world.
import { readPage } from '../../dev/pagesrc.mjs';
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

/// The fold, as a function of (er, c, ctx). Where it is still written inline as the runner's
/// `interrupted` dep (the base), that property is cut and wrapped instead.
function world(turns) {
	const W = { chats: [], cleared: [], ends: [] };
	const DaimondJournal = {
		recover: async () => ({ turns }),
		clearTurn: (tid) => W.cleared.push(tid),
	};
	const fn = cut('endInterruptedRun');
	assert.ok(fn, 'endInterruptedRun is not in the page');
	const run = new Function('window', 'DaimondJournal', 'endInterrupted', 'diag', 'chats', 'er', 'always',
		fn + '\nreturn endInterruptedRun(er, always);');
	W.end = (er, always) => run({ DaimondJournal }, DaimondJournal,
		async (chat, turn) => { W.ends.push(chat + ':' + turn); return true; }, () => {}, W.chats, er, always);
	return W;
}

const TURN = { turnId: 't-f3', chatId: 'c-f3', meta: { ho: 1, run: 'r1' }, tools: ['round one', 'round two'] };

test('a re-take of its own run ends the turn interrupted through the one writer and clears its journal run', async () => {
	const W = world([TURN]);
	const er = { turnId: 't-f3', chatId: 'c-f3', seed: { name: 'Plans', msgs: [{ role: 'user', content: 'go', mid: 'm1' }] } };
	assert.equal(await W.end(er), true, 'the run in the journal was not found');
	assert.deepEqual(W.ends, ['c-f3:t-f3'], 'not one interrupted end');
	assert.deepEqual(W.cleared, ['t-f3'], 'the journal run was not cleared');
	assert.equal(W.chats.length, 0, 'the log holds the rounds: no chat is made here');
});

test('the chat comes from the journal when the errand names none', async () => {
	const W = world([TURN]);
	assert.equal(await W.end({ turnId: 't-f3' }), true);
	assert.deepEqual(W.ends, ['c-f3:t-f3']);
});

test('with no journal run for the turn nothing is ended, unless it must be', async () => {
	const W = world([]);
	assert.equal(await W.end({ turnId: 't-f3', chatId: 'c-f3', seed: { msgs: [] } }), false);
	assert.deepEqual(W.ends, []);
	// A retake with no journal (peer.js) ends the turn all the same.
	assert.equal(await W.end({ turnId: 't-f3', chatId: 'c-f3' }, true), false);
	assert.deepEqual(W.ends, ['c-f3:t-f3']);
	assert.deepEqual(W.cleared, []);
});

test('a turn that is not a hand-off run (no meta.ho) is not this path\'s', async () => {
	const W = world([{ turnId: 't-f3', chatId: 'c-f3', meta: {} }]);
	assert.equal(await W.end({ turnId: 't-f3', chatId: 'c-f3' }), false);
	assert.deepEqual(W.ends, []);
});
