// probe_droots.mjs — where does a Diamond's directory live when a folder is open?
//
// Throwaway probe, run BEFORE the fix, to see the split for real rather than
// from reading. It stands a folder in with an OPFS subdirectory, exactly as
// dev/verify_fsa.mjs does.
import { open, signInAs } from './harness.mjs';

const s = await open({ name: 'droots-probe', connect: false });
const p = s.page;
await p.waitForTimeout(1500);

const out = await p.evaluate(async () => {
	const mod  = await import('../pkg/oxedyne_daimond.js');
	const root = await navigator.storage.getDirectory();
	const dir  = await root.getDirectoryHandle('probefolder', { create: true });
	const app  = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);

	const id = await app.create_diamond('Probe');
	await app.write_crystal(id, 'the crystal');

	const listBrowser = await app.run_tool('file_list', JSON.stringify({ path: 'diamonds/' + id }));
	const readBrowser = await app.run_tool('file_read', JSON.stringify({ path: 'diamonds/' + id + '/crystal.md' }));

	mod.set_workspace_dir(dir);
	const listMachine = await app.run_tool('file_list', JSON.stringify({ path: 'diamonds/' + id }));
	const readMachine = await app.run_tool('file_read', JSON.stringify({ path: 'diamonds/' + id + '/crystal.md' }));
	const wroteMachine = await app.run_tool('file_write',
		JSON.stringify({ path: 'diamonds/' + id + '/worker.md', content: 'a worker wrote this' }));

	// Where did the worker's file land?
	const at = async (d, ...parts) => {
		let cur = d;
		try {
			for (let i = 0; i < parts.length - 1; i++) cur = await cur.getDirectoryHandle(parts[i]);
			await cur.getFileHandle(parts[parts.length - 1]);
			return true;
		} catch (e) { return false; }
	};
	const inFolder = await at(dir,  'diamonds', id, 'worker.md');
	const inOpfs   = await at(root, 'diamonds', id, 'worker.md');

	// And can the store see it?
	const exported = await app.export_diamond(id);

	mod.use_opfs_workspace();
	return {
		id, listBrowser, readBrowser, listMachine, readMachine, wroteMachine,
		inFolder, inOpfs, inExport: exported.includes('worker.md'),
	};
});

console.log(JSON.stringify(out, null, 2));
await s.close();
