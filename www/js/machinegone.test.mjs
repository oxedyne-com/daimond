// The browser Machine folder is gone (R1, D-20261031-11, unit G5). A device without Kimberlite
// works on browser storage and the cloud, on the diamond's own synced files. Nothing offers a
// folder to work in, and a handle a device saved before is cleared with one plain line.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(HERE, rel), 'utf8');
const cut  = (s, from, to) => {
	const a = s.indexOf(from), b = s.indexOf(to, a);
	assert.ok(a >= 0 && b > a, `cannot cut ${JSON.stringify(from)} .. ${JSON.stringify(to)}`);
	return s.slice(a, b + to.length);
};
const FT = read('page/files_tree.js');
const FV = read('page/files_view.js');
const WA = read('page/wasm.js');
const EN = read('../i18n/en.js');

test('the head menu offers no Machine root, and no picker opens a folder to work in', () => {
	const menu = cut(FT, 'function openHeadMenu', '\n}\n');
	assert.doesNotMatch(menu, /'machine'|open_machine|use_browser|forget_root/);
	// The only pickers left copy files in or out (Transfers); none becomes the workspace.
	const pickers = FT.split('showDirectoryPicker(').length - 1;
	const inImport = cut(FT, 'async function importFolder', '\n}\n').split('showDirectoryPicker(').length - 1;
	const inExport = cut(FT, 'async function exportFolder', '\n}\n').split('showDirectoryPicker(').length - 1;
	assert.equal(pickers, inImport + inExport, 'a folder picker outside the transfers');
	assert.doesNotMatch(FT, /'daimond-workspace'|requestPermission\(|set_workspace_dir|use_opfs_workspace/);
	assert.doesNotMatch(WA, /set_workspace_dir|use_opfs_workspace|noteFolderLost/); // keeps: noteFolderLost asserts its removal (G5)
	assert.doesNotMatch(FV, /tryReconnect|remembersFolder|folderHandle/); // keeps: folderHandle asserts its removal (G5)
	assert.doesNotMatch(read('page/boot.js'), /tryReconnect/);
	assert.doesNotMatch(read('page/turns.js'), /block_fsa/);
	assert.doesNotMatch(EN, /'turn\.block_fsa|'files\.machine_|'work\.open_machine/);
});

// A fake IndexedDB that holds the old FsaDB's two databases as the page left them.
function fakeIdb(dbs) {
	const deleted = [];
	const req = (fn) => { const r = {}; setTimeout(() => { try { r.result = fn(); if (r.onsuccess) r.onsuccess(); } catch (e) { r.error = e; if (r.onerror) r.onerror(); } }, 0); return r; };
	return {
		deleted,
		databases: async () => Object.keys(dbs).map((name) => ({ name, version: 1 })),
		open: (name) => req(() => {
			const db = dbs[name];
			return {
				objectStoreNames: { contains: (s) => !!(db && db[s]) },
				transaction: (s) => ({ objectStore: () => ({
					count: () => req(() => Object.keys((db && db[s]) || {}).length),
				}) }),
				close() {},
			};
		}),
		deleteDatabase: (name) => req(() => { deleted.push(name); delete dbs[name]; }),
	};
}

async function retire(dbs) {
	const fn = cut(FT, 'export async function retireMachineFolder', '\n}\n').replace('export ', '');
	const said = [];
	const noted = [];
	const idb = fakeIdb(dbs);
	const ctx = { indexedDB: idb, window: {}, said, t: (k) => k, showModeMsg: (m) => said.push(m),
		noteFolderBehind: () => noted.push(1), setTimeout, Promise, Object };
	ctx.window.indexedDB = idb;
	vm.createContext(ctx);
	const left = cut(FT, 'async function machineDbsLeft', '\n}\n');
	vm.runInContext(cut(FT, 'var MACHINE_DBS', ';') + '\n' + left + '\n' + fn + '\nthis.run = retireMachineFolder;', ctx);
	const told = await ctx.run();
	return { told, said, noted: noted.length, deleted: idb.deleted, left: Object.keys(dbs) };
}

test('a saved Machine folder handle is cleared, and the device is told once where its work is now', async () => {
	const r = await retire({ 'daimond-fsa': { handles: { workspace: {} } }, 'daimond-folders': { folders: { ab: {} } } });
	assert.equal(r.told, true);
	assert.deepEqual(r.deleted.sort(), ['daimond-folders', 'daimond-fsa']);
	assert.deepEqual(r.left, []);
	assert.deepEqual(r.said, ['files.folder_retired']);
	// The handle goes, but the sync seed still reads a folder behind this device.
	assert.ok(r.noted > 0);
	assert.match(EN, /'files\.folder_retired':\s*'.*Kimberlite.*synced files/);
});

test('an empty leftover record goes silently, and a device that never had one hears nothing', async () => {
	const empty = await retire({ 'daimond-fsa': { handles: {} }, 'other-db': {} });
	assert.deepEqual(empty.said, []);
	assert.equal(empty.noted, 0);
	assert.deepEqual(empty.deleted, ['daimond-fsa']);
	assert.deepEqual(empty.left, ['other-db']);
	const none = await retire({ 'other-db': {} });
	assert.equal(none.told, false);
	assert.deepEqual(none.said, []);
	assert.deepEqual(none.deleted, []);
});

test('boot clears a saved Machine folder rather than reconnecting it', () => {
	assert.match(read('page/boot.js'), /Files\.retireMachineFolder\(\)/);
	assert.match(FV, /retireMachineFolder:\s*retireMachineFolder/);
});
