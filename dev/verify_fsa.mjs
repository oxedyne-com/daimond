// verify_fsa.mjs — real-folder mode: the root swap, and the state that must not follow it.
//
// FSA lets the owner point Daimond at a real directory, so the agents edit actual files instead
// of the OPFS sandbox. It has never been driven, because showDirectoryPicker() opens a native
// dialog: Chrome routes it through Page.setInterceptFileChooserDialog, which Playwright enables
// and cannot answer for a *directory*, so the call aborts. That blocks the picker -- it does not
// block the feature.
//
// The insight this test rests on: what the picker returns is a FileSystemDirectoryHandle, and OPFS
// hands out the very same type. An OPFS subdirectory handle is a directory handle, answers
// queryPermission with 'granted', and structured-clones into IndexedDB -- so it can stand in for a
// picked folder everywhere the code touches one. What is NOT covered is the one thing only a real
// folder can show: that the bytes land on the user's actual disk. Everything up to that boundary
// is covered here.
//
// The claim that matters most is the last one. Real-folder mode points the *file tools* at the
// user's directory, and Daimond's own state -- the Foci, their logs, the .daimond store -- pins
// OPFS on purpose (FileRoot::Opfs, src/wasm/opfs.rs). If that pin ever slipped, opening a folder
// would strew the app's internals through the user's repository. That is the test that earns its
// keep.
import { open, signInAs, shot } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const FOLDER = 'realfolder';        // an OPFS subdirectory standing in for a picked folder

const s = await open({ name: 'fsa', connect: false });
const p = s.page;
await p.waitForTimeout(1500);

// ── 0. Where the switch lives ───────────────────────────────────────────
//
// Opening a folder is not a file operation. It used to be an icon in the Workspace header,
// between New file, New folder and Upload — the only control there that acts on the workspace
// rather than on a file, which read as "make a folder" and left the mode chip looking like a
// label with no switch. It belongs beside the chip that says which files the agent is touching.

const where = await p.evaluate(() => {
	const row    = document.querySelector('.files-mode');
	const header = document.querySelector('.files-actions');
	const btns   = [...(row ? row.querySelectorAll('.files-mode-btn') : [])].map(b => b.textContent);
	return {
		inRow:    btns.some(t => /Open a folder/i.test(t)),
		inHeader: !!(header && header.querySelector('[data-act="open-folder"]')),
		chip:     (row && row.querySelector('.files-mode-chip') || {}).textContent || '',
		buttons:  btns,
	};
});
check('the switch to a real folder sits beside the sandbox chip',
	where.inRow === true, `${where.chip} · ${where.buttons.join(' | ')}`);
check('and no longer hides among the file buttons in the header',
	where.inHeader === false);

// ── A. The root swap, at the wasm edge ──────────────────────────────────

const swap = await p.evaluate(async ({ folder }) => {
	const mod  = await import('../pkg/oxedyne_daimond.js');
	const root = await navigator.storage.getDirectory();
	const dir  = await root.getDirectoryHandle(folder, { create: true });

	const before = mod.workspace_mode();
	mod.set_workspace_dir(dir);
	const after = mod.workspace_mode();

	// Write through the agent's own file tool, which is the thing real-folder mode redirects.
	const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
	const wrote = await app.run_tool('file_write',
		JSON.stringify({ path: 'notes.md', content: 'written into the real folder' }));
	const listed = await app.run_tool('file_list', JSON.stringify({ path: '.' }));
	const read   = await app.run_tool('file_read', JSON.stringify({ path: 'notes.md' }));

	// Where did the bytes actually land? Ask OPFS directly, not the tool that wrote them.
	const at = async (d, name) => {
		try { await d.getFileHandle(name); return true; } catch (e) { return false; }
	};
	const inFolder = await at(dir, 'notes.md');
	const atRoot   = await at(root, 'notes.md');

	return { before, after, wrote, listed, read, inFolder, atRoot };
}, { folder: FOLDER });

check('the workspace starts in the OPFS sandbox', swap.before === 'opfs', swap.before);
check('opening a folder swaps the root', swap.after === 'folder', swap.after);
check('a file tool writes into the folder, not the sandbox',
	swap.inFolder === true && swap.atRoot === false,
	`in folder: ${swap.inFolder}, at OPFS root: ${swap.atRoot}`);
check('and reads it back through the folder', /written into the real folder/.test(swap.read || ''));
check('and lists it there', /notes\.md/.test(swap.listed || ''));

// ── B. The invariant: Daimond's own state must not follow the root ──────
//
// A Focus keeps its brief, its log and its deltas under FileRoot::Opfs. With a folder open, that
// state must still be in the sandbox — if it followed the swap, opening a repository would write
// Daimond's internals into it.

const pinned = await p.evaluate(async ({ folder }) => {
	const mod  = await import('../pkg/oxedyne_daimond.js');
	const root = await navigator.storage.getDirectory();
	const dir  = await root.getDirectoryHandle(folder, { create: true });

	const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
	const id  = await app.create_focus('A Focus made while a folder is open');

	const has = async (d, name) => {
		try { await d.getDirectoryHandle(name); return true; } catch (e) { return false; }
	};
	return {
		id,
		fociInSandbox: await has(root, 'foci'),
		fociInFolder:  await has(dir,  'foci'),
		mode:          mod.workspace_mode(),
		listed:        JSON.parse(await app.list_foci() || '[]').length,
	};
}, { folder: FOLDER });

check('a Focus made with a folder open still lives in the sandbox',
	pinned.fociInSandbox === true, 'foci/ in OPFS: ' + pinned.fociInSandbox);
check("Daimond's own state never lands in the user's folder",
	pinned.fociInFolder === false, 'foci/ in the folder: ' + pinned.fociInFolder);
check('and the Focus is readable while the folder is open', pinned.listed >= 1,
	pinned.listed + ' foci');

// ── C. Switching back ───────────────────────────────────────────────────

const back = await p.evaluate(async () => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	mod.use_opfs_workspace();
	const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
	// The folder's file is no longer in view: the tools are back on the sandbox root.
	const read = await app.run_tool('file_read', JSON.stringify({ path: 'notes.md' }));
	return { mode: mod.workspace_mode(), read };
});
check('switching back returns the tools to the sandbox', back.mode === 'opfs', back.mode);
check("and the folder's files are out of view",
	/^\s*Error\b/i.test(back.read || ''), (back.read || '').slice(0, 40));

// ── D. Reconnect on boot, through the app's own path ────────────────────
//
// tryReconnect() runs at boot: it loads the stored handle, checks queryPermission, and reactivates
// the folder. Seeding the handle where it looks drives that whole path -- FsaDB, activateFolder,
// the mode indicator -- without a picker.

await p.evaluate(async ({ folder }) => {
	const root = await navigator.storage.getDirectory();
	const dir  = await root.getDirectoryHandle(folder, { create: true });
	const db = await new Promise((res, rej) => {
		const q = indexedDB.open('daimond-fsa', 1);
		q.onupgradeneeded = () => q.result.createObjectStore('handles');
		q.onsuccess = () => res(q.result);
		q.onerror   = () => rej(q.error);
	});
	await new Promise((res, rej) => {
		const t = db.transaction('handles', 'readwrite');
		t.objectStore('handles').put(dir, 'workspace');
		t.oncomplete = res;
		t.onerror = () => rej(t.error);
	});
}, { folder: FOLDER });

await p.reload({ waitUntil: 'domcontentloaded' });
await signInAs(s, 'fsa');
await p.waitForTimeout(2500);

const reconnected = await p.evaluate(async () => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	const chip = document.querySelector('.files-mode-chip');
	return { mode: mod.workspace_mode(), chip: chip ? chip.textContent.trim() : '(none)' };
});
check('the folder is reconnected on the next visit, with no prompt',
	reconnected.mode === 'folder', reconnected.mode);
check('and the panel says which folder the agent is touching',
	reconnected.chip.includes(FOLDER), reconnected.chip);

// ── E. A grant that is taken away ───────────────────────────────────────
//
// The browser can withdraw a folder at any time, and every tool call that touches it then fails
// while the app goes on naming a folder the agent cannot reach. Two things have to be true: an
// ORDINARY failure must not tear the folder down, and a withdrawn grant must.

// The negative case first, and it is the one that would do real damage if wrong: reading a file
// that is not there fails, as it should, and the folder must survive it.
const ordinary = await p.evaluate(async () => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
	const res = await app.run_tool('file_read', JSON.stringify({ path: 'no-such-file.md' }));
	await new Promise(r => setTimeout(r, 300));
	const chip = document.querySelector('.files-mode-chip');
	return { res: (res || '').slice(0, 30), mode: mod.workspace_mode(),
	         chip: chip ? chip.textContent.trim() : '(none)' };
});
check('an ordinary tool error does not tear the folder down',
	ordinary.mode === 'folder' && ordinary.chip.includes(FOLDER),
	`mode: ${ordinary.mode}, chip: ${ordinary.chip}`);

// And the positive: the edge raises `daimond:folder-lost`, and the app must drop to the sandbox
// and say so rather than carry on against a folder it no longer has.
const lost = await p.evaluate(async () => {
	window.dispatchEvent(new CustomEvent('daimond:folder-lost'));
	await new Promise(r => setTimeout(r, 600));
	const mod  = await import('../pkg/oxedyne_daimond.js');
	const chip = document.querySelector('.files-mode-chip');
	const msg  = document.querySelector('.files-mode-msg');
	const rc   = document.querySelector('.files-mode-btn.accent');
	return {
		mode:    mod.workspace_mode(),
		chip:    chip ? chip.textContent.trim() : '(none)',
		msg:     msg ? msg.textContent.trim() : '(none)',
		reconnect: !!rc,
	};
});
check('a withdrawn grant drops the agent back to the sandbox',
	lost.mode === 'opfs', lost.mode);
check('and the panel stops claiming a folder it cannot reach',
	!lost.chip.includes(FOLDER), lost.chip);
check('and the user is told, and offered a way back',
	/Lost access/i.test(lost.msg) && lost.reconnect === true,
	`${lost.msg} · reconnect offered: ${lost.reconnect}`);

await shot(s, 'fsa');
const errs = s.errs.filter(e => !/favicon|404|401|net::ERR/.test(e));
console.log('\nconsole errors:', errs.slice(0, 4));
await s.close();

console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) console.log('FAILED:\n  ' + bad.join('\n  '));
process.exit(bad.length ? 1 : 0);
