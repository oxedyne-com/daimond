// UNBLOCK-15 (D-20261015-18): "Change folder" showed "Wait for the agent..." in red, for any turn
// anywhere. It now holds back only for the running turns that work in the open folder (a fence with a
// path here), names them, offers Stop and change, and is never red.
//
// rootSwitchBlocked and turnsInFolder live inside the Workspace panel's closure, so each is cut out
// of the source by its name and run alone against stand-ins for what it calls.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));
const src  = readFileSync(join(HERE, 'daimond.js'), 'utf8');

function cut(name) {
	let at = src.indexOf('\t\tasync function ' + name + '(');
	if (at < 0) at = src.indexOf('\t\tfunction ' + name + '(');
	assert.ok(at >= 0, name + ' is not in daimond.js');
	const end = src.indexOf('\n\t\t}\n', at);
	return src.slice(at, end + 4);
}

// One world: chats (some generating), Diamonds, workers, and which fences hold a path here.
function world({ chats = [], runs = [], fences = {}, answer = true }) {
	const said = [], asked = [], stopped = [];
	const deps = {
		chats,
		diamonds:   [{ id: 'd1', name: 'Kitchen renovation' }, { id: 'd2', name: 'Garden' }],
		Workers:    { runs, stop: (r) => { stopped.push('worker:' + r.id); r.status = 'stopped'; } },
		Files:      { bounds: async (id) => ({ attached: fences[id] || [] }) },
		chatBounds: async (id) => ({ attached: fences[id] || [] }),
		abortTurn:  (c) => { stopped.push('chat:' + c.id); c._generating = false; },
		chatDisplayName: (c) => c.name,
		confirmDialog: async (msg, ok) => { asked.push([msg, ok]); return answer; },
		showModeMsg: (text, isErr) => { said.push([text, !!isErr]); },
		t:          (k, a) => k + (a ? JSON.stringify(a) : ''),
	};
	const body = cut('turnsInFolder') + '\n' + cut('rootSwitchBlocked') + '\nreturn rootSwitchBlocked;';
	const fn = new Function(...Object.keys(deps), body)(...Object.values(deps));
	return { run: fn, said, asked, stopped };
}

test('a turn whose fence holds nothing here does not hold the change back', async () => {
	const w = world({ chats: [{ id: 'c1', name: 'Recipes', _generating: true }] });
	assert.equal(await w.run(), false);
	assert.deepEqual(w.asked, []);
	assert.deepEqual(w.said, []);
});

test('a turn working here is named, and Stop and change stops it and goes on', async () => {
	const w = world({
		chats: [{ id: 'c1', name: 'Recipes', _generating: true }, { id: 'c2', name: 'Kitchen', diamondId: 'd1', _generating: true },
			{ id: 'c3', name: 'Idle', _generating: false }],
		runs: [{ id: 'w1', status: 'running', diamondId: 'd1' }, { id: 'w2', status: 'running', diamondId: 'd2' }],
		fences: { d1: ['papers'] },
	});
	assert.equal(await w.run(), false);
	assert.equal(w.asked.length, 1);
	assert.match(w.asked[0][0], /Kitchen renovation/);
	assert.doesNotMatch(w.asked[0][0], /Recipes|Garden/);
	assert.equal(w.asked[0][1], 'files.stop_and_change');
	assert.deepEqual(w.stopped.sort(), ['chat:c2', 'worker:w1']);
	assert.ok(w.said.every(([, red]) => !red), JSON.stringify(w.said));
});

test('declining leaves the turn running and the folder as it was, and nothing is red', async () => {
	const w = world({ chats: [{ id: 'c1', name: 'Recipes', _generating: true }], fences: { c1: ['notes.md'] }, answer: false });
	assert.equal(await w.run(), true);
	assert.match(w.asked[0][0], /Recipes/);
	assert.deepEqual(w.stopped, []);
	assert.ok(w.said.every(([, red]) => !red), JSON.stringify(w.said));
});

test('no hard-coded English is left on the way', () => {
	assert.doesNotMatch(cut('rootSwitchBlocked'), /Wait for the agent/);
});
