// verify_droots.mjs — a Diamond is the same Diamond in either workspace mode.
//
// The Workspace panel switches the agent's root between the browser sandbox
// (OPFS, private, syncs) and a real folder on the machine (does not sync). That
// switch is meant to move the WORK. It was moving Daimond's own state with it:
// a Diamond lives at `diamonds/<id>`, the store pinned that to the sandbox, and
// every other reader of the same path — the Workspace panel, a dispatched
// worker, the "view this delta" button — resolved it against whichever root was
// active. So with a folder open the Diamond's own directory could not be listed
// or read at all, and a worker's files went into the user's repository, outside
// the sync parcel, where nothing would ever see them again.
//
// The rule now is one line: `diamonds/` is app state and does not follow the
// root (`is_store_path`, src/tools.rs; `resolve_root`, src/wasm/opfs.rs). The
// user's work still does, which is half of what is checked here — a fix that
// pinned everything to the sandbox would break real-folder mode outright and
// several checks below would still pass.
//
// What is pinned:
//   * a Diamond's directory lists and reads the same in both modes;
//   * a write into it lands in the store and travels in the export;
//   * the user's own files still follow the folder, and are out of view in the
//     sandbox — the switch still does its job;
//   * `diamonds-old/` and `src/diamonds/` are the user's, not the store;
//   * Diamonds made in either mode survive a reload and appear in the parcel;
//   * Diamond files an earlier build left in a folder are adopted into the
//     store on activation, both copies are kept where they differ, a folder
//     that is not a Diamond is left alone, nothing is deleted, and running it
//     again adopts nothing.
//
// A real folder needs `showDirectoryPicker()`, a native dialog no harness can
// answer, so an OPFS subdirectory stands in for one — the same stand-in
// dev/verify_fsa.mjs uses, and for the same reason: what the picker returns is
// a FileSystemDirectoryHandle, and OPFS hands out that very type.
//
// Run with dev/serve.mjs (DAIMOND_PORT, default 8777) up. No gateway, no hand, no mock
// model.
//
//	node dev/verify_droots.mjs
//
// Every check here has been proved against BROKEN code: see
// dev/breakproof_droots.sh, which reverts the fix four different ways and
// records which checks go red for each.
import { open, signInAs } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const FOLDER = 'standin-folder';        // an OPFS subdirectory standing in for a picked folder

const s = await open({ name: 'droots', connect: false });
const p = s.page;
await p.waitForTimeout(1500);

// Helpers installed in the page, so every step below drives the real engine.
// Re-installed after the reload, which takes the page's globals with it.
const install = () => p.evaluate(async (folder) => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	window.__d = {
		mod,
		app:    new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true),
		root:   await navigator.storage.getDirectory(),
		folder: null,
	};
	__d.folder = await __d.root.getDirectoryHandle(folder, { create: true });
	// Read a file straight out of a directory handle, bypassing every tool: the
	// question "where did the bytes land" must not be answered by the thing under test.
	window.__at = async (which, path) => {
		let cur = which === 'folder' ? __d.folder : __d.root;
		const parts = path.split('/');
		try {
			for (let i = 0; i < parts.length - 1; i++) cur = await cur.getDirectoryHandle(parts[i]);
			const fh = await cur.getFileHandle(parts[parts.length - 1]);
			return await (await fh.getFile()).text();
		} catch (e) { return null; }
	};
	window.__put = async (which, path, body) => {
		let cur = which === 'folder' ? __d.folder : __d.root;
		const parts = path.split('/');
		for (let i = 0; i < parts.length - 1; i++) {
			cur = await cur.getDirectoryHandle(parts[i], { create: true });
		}
		const fh = await cur.getFileHandle(parts[parts.length - 1], { create: true });
		const w = await fh.createWritable();
		await w.write(body);
		await w.close();
	};
	window.__tool = (name, args) => __d.app.run_tool(name, JSON.stringify(args));
	window.__err  = (v) => typeof v !== 'string' || /^\s*Error\b/i.test(v);
}, FOLDER);

await install();

const tool  = (name, args) => p.evaluate(([n, a]) => __tool(n, a), [name, args]);
const at    = (which, path) => p.evaluate(([w, x]) => __at(w, x), [which, path]);
const put   = (which, path, body) => p.evaluate(([w, x, b]) => __put(w, x, b), [which, path, body]);
const toFolder  = () => p.evaluate(() => __d.mod.set_workspace_dir(__d.folder));
const toBrowser = () => p.evaluate(() => __d.mod.use_opfs_workspace());

// ── A Diamond made in the sandbox ───────────────────────────────────────

const A = await p.evaluate(async () => {
	const id = await __d.app.create_diamond('Made in the browser');
	await __d.app.write_crystal(id, 'crystal of A');
	await __tool('file_write', { path: 'diamonds/' + id + '/note.md', content: 'note of A' });
	return id;
});
check('a Diamond can be made in the browser sandbox', !!A, A);

const readsIn = async (id, what) => ({
	list:    await tool('file_list', { path: 'diamonds/' + id }),
	crystal: await tool('file_read', { path: 'diamonds/' + id + '/crystal.md' }),
	note:    await tool('file_read', { path: 'diamonds/' + id + '/note.md' }),
	what,
});

const browserA = await readsIn(A, 'browser');
check('its directory lists in the browser sandbox',
	/crystal\.md/.test(browserA.list) && /note\.md/.test(browserA.list), browserA.list);
check('and its crystal reads there', /crystal of A/.test(browserA.crystal), browserA.crystal);

// ── The switch to the machine folder ────────────────────────────────────

await toFolder();
const machineA = await readsIn(A, 'machine');
check('the SAME directory still lists once a folder is open',
	/crystal\.md/.test(machineA.list) && /note\.md/.test(machineA.list), machineA.list);
check('and the crystal reads back byte for byte',
	/crystal of A/.test(machineA.crystal), machineA.crystal);
check('and so does a file written into it before the switch',
	/note of A/.test(machineA.note), machineA.note);

// A write made WHILE the folder is open belongs to the Diamond, not to the repo.
await tool('file_write', { path: 'diamonds/' + A + '/worker.md', content: 'a worker wrote this' });
check('a write into the Diamond lands in the store, not the folder',
	(await at('opfs', 'diamonds/' + A + '/worker.md')) === 'a worker wrote this'
		&& (await at('folder', 'diamonds/' + A + '/worker.md')) === null,
	'store: ' + JSON.stringify(await at('opfs', 'diamonds/' + A + '/worker.md'))
		+ ' folder: ' + JSON.stringify(await at('folder', 'diamonds/' + A + '/worker.md')));

const exportA = await p.evaluate((id) => __d.app.export_diamond(id), A);
check('and it travels with the Diamond, so it reaches the other device',
	exportA.includes('worker.md') && exportA.includes('a worker wrote this'),
	exportA.slice(0, 160));

// ── The user's work still follows the folder ────────────────────────────
//
// Without this the fix could be "pin everything to the sandbox", which passes
// every check above and destroys the feature.

await tool('file_write', { path: 'src/main.rs', content: 'fn main() {}' });
check("the user's own file goes into the folder, as real-folder mode promises",
	(await at('folder', 'src/main.rs')) === 'fn main() {}'
		&& (await at('opfs', 'src/main.rs')) === null,
	'folder: ' + JSON.stringify(await at('folder', 'src/main.rs')));

// Paths that merely look like the store are the user's.
await tool('file_write', { path: 'diamonds-old/keep.md',  content: 'theirs' });
await tool('file_write', { path: 'src/diamonds/keep.md',  content: 'also theirs' });
check('a path that only resembles the store is still the user\'s work',
	(await at('folder', 'diamonds-old/keep.md')) === 'theirs'
		&& (await at('folder', 'src/diamonds/keep.md')) === 'also theirs'
		&& (await at('opfs', 'diamonds-old/keep.md')) === null
		&& (await at('opfs', 'src/diamonds/keep.md')) === null,
	'diamonds-old in folder: ' + JSON.stringify(await at('folder', 'diamonds-old/keep.md'))
		+ ', in store: ' + JSON.stringify(await at('opfs', 'diamonds-old/keep.md')));

// ── A Diamond made while the folder is open ─────────────────────────────

const B = await p.evaluate(async () => {
	const id = await __d.app.create_diamond('Made on the machine');
	await __d.app.write_crystal(id, 'crystal of B');
	await __tool('file_write', { path: 'diamonds/' + id + '/note.md', content: 'note of B' });
	return id;
});
check('a Diamond can be made while a folder is open', !!B, B);
check('and none of it lands in the folder',
	(await at('folder', 'diamonds/' + B + '/crystal.md')) === null, 'folder holds nothing for B');

await toBrowser();
const browserB = await readsIn(B, 'browser');
check('switching back to the browser, it is still there',
	/crystal\.md/.test(browserB.list) && /note\.md/.test(browserB.list), browserB.list);
check('with its crystal and its files intact',
	/crystal of B/.test(browserB.crystal) && /note of B/.test(browserB.note),
	browserB.crystal + ' | ' + browserB.note);
check("and the folder's own files are out of view again",
	(await tool('file_read', { path: 'src/main.rs' })).startsWith('Error'),
	(await tool('file_read', { path: 'src/main.rs' })).slice(0, 40));

// ── Both are in the sync parcel ─────────────────────────────────────────

const inParcel = async () => p.evaluate(async () => {
	const parcel = await window.DaimondCore.collectSync();
	return (parcel.diamonds || []).map((d) => ({ id: d.id, data: d.data || '' }));
});
const parcelBrowser = await inParcel();
const carries = (rows, id, body) => {
	const row = rows.find((r) => r.id === id);
	return !!row && row.data.includes(body);
};
check('both Diamonds are in the parcel from the browser sandbox',
	carries(parcelBrowser, A, 'crystal of A') && carries(parcelBrowser, B, 'crystal of B'),
	parcelBrowser.map((r) => r.id).join(' '));

await toFolder();
const parcelMachine = await inParcel();
check('and both are still in the parcel with a folder open',
	carries(parcelMachine, A, 'crystal of A') && carries(parcelMachine, B, 'crystal of B'),
	parcelMachine.map((r) => r.id).join(' '));
check('including the file the worker wrote while the folder was open',
	carries(parcelMachine, A, 'a worker wrote this'));

// ── Across a reload ─────────────────────────────────────────────────────

await p.reload({ waitUntil: 'domcontentloaded' });
await signInAs(s, 'droots');
await p.waitForTimeout(2500);
await install();

const afterReload = await p.evaluate(async ({ a, b }) => {
	const listed = JSON.parse(await __d.app.list_diamonds());
	const browser = {
		a: await __tool('file_read', { path: 'diamonds/' + a + '/crystal.md' }),
		b: await __tool('file_read', { path: 'diamonds/' + b + '/crystal.md' }),
	};
	__d.mod.set_workspace_dir(__d.folder);
	const machine = {
		a: await __tool('file_read', { path: 'diamonds/' + a + '/crystal.md' }),
		b: await __tool('file_read', { path: 'diamonds/' + b + '/crystal.md' }),
	};
	__d.mod.use_opfs_workspace();
	return { ids: listed.map((d) => d.id), browser, machine };
}, { a: A, b: B });

check('after a reload the rail still holds both Diamonds',
	afterReload.ids.includes(A) && afterReload.ids.includes(B), afterReload.ids.join(' '));
check('and both crystals read in the browser sandbox',
	/crystal of A/.test(afterReload.browser.a) && /crystal of B/.test(afterReload.browser.b),
	afterReload.browser.a + ' | ' + afterReload.browser.b);
check('and both read again with the folder open',
	/crystal of A/.test(afterReload.machine.a) && /crystal of B/.test(afterReload.machine.b),
	afterReload.machine.a + ' | ' + afterReload.machine.b);

// ── Bringing home what an earlier build left in a folder ────────────────
//
// The state a user of yesterday's build is actually in: Diamond files sitting
// in their project, invisible to the app and outside the parcel.

const C = 'c0ffee5eaded';       // a whole Diamond, in the folder and nowhere else
await p.evaluate(async ({ a, c }) => {
	// (1) A worker's file for a Diamond the store already holds.
	await __put('folder', 'diamonds/' + a + '/stranded.md', 'left in the folder');
	// (2) A file that CLASHES with one the store holds, with different bytes.
	await __put('folder', 'diamonds/' + a + '/note.md', 'the folder version of the note');
	// (3) A whole Diamond that only exists in the folder.
	await __put('folder', 'diamonds/' + c + '/crystal.md', 'crystal of C');
	await __put('folder', 'diamonds/' + c + '/.daimond/meta.json',
		JSON.stringify({ name: 'Found in the folder', crystal_version: 0, updated: 1, touched: 1 }));
	// (4) A directory of the user's that happens to live under diamonds/.
	await __put('folder', 'diamonds/notes/todo.md', 'not a Diamond at all');
}, { a: A, c: C });

// Adoption runs where the app runs it: on folder activation.
const report = await p.evaluate(async () => {
	__d.mod.set_workspace_dir(__d.folder);
	return JSON.parse(await __d.mod.adopt_folder_diamonds());
});

check('adoption reports the Diamonds it brought home',
	report.adopted.length === 2
		&& report.adopted.some((d) => d.id === A)
		&& report.adopted.some((d) => d.id === C),
	JSON.stringify(report.adopted));
check('a stranded worker file is now in the store',
	(await at('opfs', 'diamonds/' + A + '/stranded.md')) === 'left in the folder',
	JSON.stringify(await at('opfs', 'diamonds/' + A + '/stranded.md')));
check('a clash keeps what the store already had',
	(await at('opfs', 'diamonds/' + A + '/note.md')) === 'note of A',
	JSON.stringify(await at('opfs', 'diamonds/' + A + '/note.md')));
check('and keeps the folder\'s copy beside it rather than dropping it',
	(await at('opfs', 'diamonds/' + A + '/note.from-machine.md')) === 'the folder version of the note',
	JSON.stringify(await at('opfs', 'diamonds/' + A + '/note.from-machine.md')));
check('and says so, naming the file it kept',
	(report.adopted.find((d) => d.id === A) || {}).kept
		&& report.adopted.find((d) => d.id === A).kept
			.includes('diamonds/' + A + '/note.from-machine.md'),
	JSON.stringify((report.adopted.find((d) => d.id === A) || {}).kept));

const adoptedC = await p.evaluate(async (c) => {
	const listed = JSON.parse(await __d.app.list_diamonds());
	const row = listed.find((d) => d.id === c) || null;
	return { row, crystal: await __d.app.read_crystal(c).catch(() => null) };
}, C);
check('a whole Diamond found only in the folder joins the rail',
	!!adoptedC.row && adoptedC.row.name === 'Found in the folder', JSON.stringify(adoptedC.row));
check('with its crystal', adoptedC.crystal === 'crystal of C', JSON.stringify(adoptedC.crystal));

check('a folder of the user\'s under diamonds/ is left alone',
	report.left.includes('diamonds/notes')
		&& (await at('opfs', 'diamonds/notes/todo.md')) === null,
	JSON.stringify(report.left));
check('and nothing at all was deleted from the folder',
	(await at('folder', 'diamonds/' + A + '/stranded.md')) === 'left in the folder'
		&& (await at('folder', 'diamonds/' + C + '/crystal.md')) === 'crystal of C'
		&& (await at('folder', 'diamonds/notes/todo.md')) === 'not a Diamond at all');

const second = await p.evaluate(() => __d.mod.adopt_folder_diamonds().then(JSON.parse));
check('running adoption again brings nothing home, and makes no second copy',
	second.adopted.length === 0
		&& (await at('opfs', 'diamonds/' + A + '/note.from-machine.from-machine.md')) === null,
	JSON.stringify(second.adopted));

// The adopted Diamond has to sync like any other, which is the point of moving it.
await toBrowser();
const parcelAfter = await inParcel();
check('the adopted Diamond is in the sync parcel',
	carries(parcelAfter, C, 'crystal of C') && carries(parcelAfter, A, 'left in the folder'),
	parcelAfter.map((r) => r.id).join(' '));

// With no folder open there is nothing to adopt, and saying so is not an error.
const none = await p.evaluate(() => __d.mod.adopt_folder_diamonds().then(JSON.parse));
check('with no folder open, adoption looks at nothing and says so',
	none.folder === false && none.adopted.length === 0, JSON.stringify(none));

// ── And through the app's own hands, not the engine's ───────────────────
//
// Everything above called the adoption edge directly. What a user of yesterday's
// build actually does is open the app with a folder already granted, so the run
// that matters is the silent reconnect at boot — `Files.tryReconnect` →
// `activateFolder` → adoption — and the user has to be TOLD, because files moved.

const D = 'dead1eaf0000';
await p.evaluate(async ({ folder, d }) => {
	// A whole Diamond, in the folder and nowhere else.
	await __put('folder', 'diamonds/' + d + '/crystal.md', 'crystal of D');
	await __put('folder', 'diamonds/' + d + '/.daimond/meta.json',
		JSON.stringify({ name: 'Stranded in the project', crystal_version: 0, updated: 2, touched: 2 }));
	// Where the panel looks for a folder it may reconnect without a picker.
	const db = await new Promise((res, rej) => {
		const q = indexedDB.open('daimond-fsa', 1);
		q.onupgradeneeded = () => q.result.createObjectStore('handles');
		q.onsuccess = () => res(q.result);
		q.onerror   = () => rej(q.error);
	});
	await new Promise((res, rej) => {
		const tx = db.transaction('handles', 'readwrite');
		tx.objectStore('handles').put(__d.folder, 'workspace');
		tx.oncomplete = res;
		tx.onerror = () => rej(tx.error);
	});
	void folder;
}, { folder: FOLDER, d: D });

await p.reload({ waitUntil: 'domcontentloaded' });
await signInAs(s, 'droots');
await p.waitForTimeout(4000);
await install();

const booted = await p.evaluate(async (d) => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
	const card = document.querySelector('.modal.dlg .dlg-card');
	return {
		mode:    mod.workspace_mode(),
		ids:     JSON.parse(await app.list_diamonds()).map((x) => x.id),
		crystal: await app.read_crystal(d).catch(() => null),
		title:   card ? (card.querySelector('h2') || {}).textContent : null,
		body:    card ? (card.querySelector('.dlg-msg, .dlg-pre') || {}).textContent : null,
	};
}, D);

check('the app reconnected the folder on its own at boot', booted.mode === 'folder', booted.mode);
check('and brought the stranded Diamond into the store on the way',
	booted.ids.includes(D) && booted.crystal === 'crystal of D',
	booted.ids.join(' ') + ' | ' + JSON.stringify(booted.crystal));
check('and told the user, naming the Diamond it moved',
	!!booted.title && /brought back/i.test(booted.title)
		&& !!booted.body && booted.body.includes('Stranded in the project'),
	JSON.stringify(booted.title) + ' | ' + JSON.stringify(booted.body));
check('and said the copies in their folder were left where they are',
	!!booted.body && /left exactly where they are/i.test(booted.body)
		&& (await at('folder', 'diamonds/' + D + '/crystal.md')) === 'crystal of D',
	JSON.stringify(booted.body));

// A resource the browser could not load is the dev stack, not the page: no
// gateway runs here, so its probes answer 401 or 502 and neither is a throw.
const noise = s.errs.filter((e) =>
	!/favicon|ERR_ABORTED|net::ERR|Failed to load resource/i.test(e));
check('the page threw nothing along the way', noise.length === 0, noise.slice(0, 3).join(' | '));

await s.close();
console.log('\n' + ok.length + ' ok, ' + bad.length + ' failed');
process.exit(bad.length ? 1 : 0);
