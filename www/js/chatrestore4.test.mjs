/* chatrestore4.test.mjs -- a chat's restore writes through the four-argument door.
   The G1 engine (D-20261031-11) refuses a fifth argument to `run_diamond_tool`: the
   holdings an older page passed for a chat's store. versions.js passed them, so every
   restore of a chat's file was refused and wrote nothing. Drives the real versions.js
   with an engine stub that refuses a fifth argument, as the engine does. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

function makeTab() {
	const runCalls = [];
	const engine = {
		versions_list: () => '[]',
		versions_restore_open: async () => JSON.stringify({
			ticket: 't-restore',
			machine: [{ path: 'chats/c1/work/x.md', gone: true, kept: true, left: false, hash: 'h1' }],
		}),
		versions_restore_hold: async () => '{}',
		versions_restore_answer: async () => '{}',
		versions_restore_close: async () => JSON.stringify(
			{ version: 1, recorded: 1, restored: [], missing: [], refused: [] }),
		run_diamond_tool(id, tool, argsJson, ticket, extra) {
			if (arguments.length > 4) return Promise.reject(new Error('run_diamond_tool takes four arguments'));
			runCalls.push({ id: String(id), tool: String(tool) });
			return Promise.resolve(JSON.stringify({ outcome: 'done' }));
		},
	};
	const win = {
		DaimondCore: { diamondApp: () => engine, confirm: () => Promise.resolve(true) },
		DaimondAttach: { chatHolds: () => '[]' },
		DaimondI18n: { t: (k) => 'T:' + k },
	};
	win.window = win;
	win.addEventListener = () => {};
	const src = readFileSync(join(HERE, 'versions.js'), 'utf8');
	new Function('window', 'with (window) {\n' + src + '\n}')(win);
	return { win, runCalls };
}

test('a chat store restore reaches run_diamond_tool with four arguments and is not refused', async () => {
	const tab = makeTab();
	let out = null, err = null;
	try { out = await tab.win.DaimondVersions.restore('chat:c1', 3, { ask: false }); } catch (e) { err = e; }
	assert.equal(err, null, 'the restore threw: ' + (err && err.message));
	assert.ok(tab.runCalls.length > 0, 'the door ran: ' + JSON.stringify(out));
	assert.ok(tab.runCalls.every((c) => c.id === 'chat:c1'));
});

test('absence: versions.js passes no holdings to the engine', () => {
	const src = readFileSync(join(HERE, 'versions.js'), 'utf8');
	assert.ok(!/chatHolds/.test(src), 'no DaimondAttach.chatHolds');
	assert.ok(!/run_diamond_tool\([^)]*,[^)]*,[^)]*,[^)]*,/.test(src), 'no five-argument call');
});
