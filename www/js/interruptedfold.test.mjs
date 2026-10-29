// R568-FU F3 (17 Oct 2026): a re-take of this device's own live lease after a reload ends the turn
// Interrupted and folds the journal's rounds into the chat. When the reload came before the seed
// graft persisted the chat, the device's own chat list lacked it, the fold answered false, and the
// turn was settled Interrupted anyway: its rounds were never shown and never cleared from the
// journal. The chat is now made from the errand, as the seed graft makes it, so they show and go.
//
// daimond.js cannot be loaded whole in Node, so the fold and the graft are cut out by name and run
// against a stub world.
import { readPage } from '../../dev/pagesrc.mjs';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));
const src  = readPage(join(HERE, 'daimond.js'), 'utf8');
// The REAL stamp module: a seed-built chat takes the seed's one-way taint through it (H3).
const STAMPWIN = {};
new Function('window', readPage(join(HERE, 'stamp.js'), 'utf8'))(STAMPWIN);

function cut(name) {
	let at = src.indexOf('\n\tasync function ' + name + '(');
	if (at < 0) at = src.indexOf('\n\tfunction ' + name + '(');
	if (at < 0) return null;
	const end = src.indexOf('\n\t}\n', at);
	return src.slice(at + 1, end + 3);
}

/// The fold, as a function of (er, c, ctx). Where it is still written inline as the runner's
/// `interrupted` dep (the base), that property is cut and wrapped instead.
function theFold() {
	const named = cut('foldInterruptedRun');
	if (named) return { body: named, call: 'foldInterruptedRun(er, c, ctx)' };
	const at = src.indexOf('\t\t\tinterrupted: async function (er, c) {');
	assert.ok(at >= 0, 'the interrupted dep is not in daimond.js');
	const end = src.indexOf('\n\t\t\t},\n', at);
	const fn = src.slice(at, end + 5).replace(/^\t\t\tinterrupted: /, 'var inline = ').replace(/,\s*$/, ';');
	return { body: fn, call: 'inline(er, c)' };
}

function world(turns) {
	const W = { chats: [], cleared: [], folded: [], persisted: 0 };
	const deps = {
		chats: W.chats,
		window: {},
		DaimondJournal: {
			recover: async () => ({ turns }),
			clearTurn: (tid) => W.cleared.push(tid),
		},
		DaimondPeer: {
			seedGraft: (chat, er) => ((er.seed && er.seed.msgs) || []).filter((m) => !chat.messages.some((x) => x.mid === m.mid)),
		},
		DaimondMarksHere: { chatSettle: () => {} },
		ChatStore: { settled: async () => {} },
		loadChatMessages: async () => {},
		foldJournalTurn: (chat, t) => { W.folded.push(chat.id); for (const r of t.tools) chat.messages.push({ role: 'tool', content: r }); },
		dropOtherRunRows: () => {},
		stampMessages: () => {},
		touchChat: () => {},
		persistChats: () => { W.persisted++; },
		renderHistory: () => {},
		diag: () => {},
		current: null,
		DaimondStamp: STAMPWIN.DaimondStamp,
	};
	deps.window.DaimondJournal = deps.DaimondJournal;
	const f = theFold();
	const graft = (cut('graftSeed') || '') + '\n' + (cut('chatTaintOf') || '');
	const run = new Function(...Object.keys(deps), 'er', 'c', 'ctx',
		graft + '\n' + f.body + '\nreturn ' + f.call + ';');
	W.fold = (er) => run(...Object.values(deps), er, undefined, undefined);
	return W;
}

const TURN = { turnId: 't-f3', chatId: 'c-f3', meta: { ho: 1, run: 'r1' }, tools: ['round one', 'round two'] };

test('a re-take with the chat absent here folds the rounds into a chat made from the seed, and clears them', async () => {
	const W = world([TURN]);
	const er = { turnId: 't-f3', chatId: 'c-f3', seed: { name: 'Plans', msgs: [{ role: 'user', content: 'go', mid: 'm1' }] } };
	const cut = await W.fold(er);
	assert.equal(cut, true, 'the fold answered false: the rounds were left in the journal');
	const chat = W.chats.find((c) => c.id === 'c-f3');
	assert.ok(chat, 'no chat was made for the turn');
	assert.deepEqual(chat.messages.map((m) => m.content), ['go', 'round one', 'round two']);
	assert.equal(chat.name, 'Plans');
	assert.deepEqual(W.cleared, ['t-f3'], 'the journal run was not cleared');
	assert.ok(W.persisted > 0, 'the fold was never persisted');
});

test('an errand from a dispatcher that sends no seed still gets its rounds folded and cleared', async () => {
	const W = world([TURN]);
	const er = { turnId: 't-f3', chatId: 'c-f3' };
	assert.equal(await W.fold(er), true);
	const chat = W.chats.find((c) => c.id === 'c-f3');
	assert.ok(chat, 'no chat was made for the turn');
	assert.equal(chat.updatedAt, 0, 'a replica outranked the real record');
	assert.deepEqual(chat.messages.map((m) => m.content), ['round one', 'round two']);
	assert.deepEqual(W.cleared, ['t-f3']);
});

test('with no journal run for the turn nothing is made', async () => {
	const W = world([]);
	assert.equal(await W.fold({ turnId: 't-f3', chatId: 'c-f3', seed: { msgs: [] } }), false);
	assert.equal(W.chats.length, 0);
});
