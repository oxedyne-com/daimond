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
// user's directory, and Daimond's own state -- the Diamonds, their logs, the .daimond store -- pins
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

// The switch is now the Machine CHIP itself: a chip states where things are, and
// clicking the one that is not current is what moves the agent there. So what has
// to be true is that the row carries an actionable Machine chip -- not that it
// carries a button reading "Open a folder…", which is what it was before the
// chips took over.
const where = await p.evaluate(() => {
	const row    = document.querySelector('.files-mode');
	const header = document.querySelector('.files-actions');
	const btns   = [...(row ? row.querySelectorAll('.files-mode-btn') : [])].map(b => b.textContent);
	const chips  = [...(row ? row.querySelectorAll('.files-mode-chip') : [])];
	const machine = chips.find(c => /Machine|💻/.test(c.textContent));
	return {
		inRow:    !!(machine && machine.classList.contains('act')),
		inHeader: !!(header && header.querySelector('[data-act="open-folder"]')),
		chips:    chips.map(c => c.textContent.trim()).join(' | '),
		buttons:  btns,
	};
});
check('the switch to a real folder sits in the mode row, as the Machine chip',
	where.inRow === true, `${where.chips} · ${where.buttons.join(' | ')}`);
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
// A Diamond keeps its crystal, its log and its deltas under FileRoot::Opfs. With a folder open, that
// state must still be in the sandbox — if it followed the swap, opening a repository would write
// Daimond's internals into it.

const pinned = await p.evaluate(async ({ folder }) => {
	const mod  = await import('../pkg/oxedyne_daimond.js');
	const root = await navigator.storage.getDirectory();
	const dir  = await root.getDirectoryHandle(folder, { create: true });

	const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
	const id  = await app.create_diamond('A Diamond made while a folder is open');

	const has = async (d, name) => {
		try { await d.getDirectoryHandle(name); return true; } catch (e) { return false; }
	};
	return {
		id,
		diamondsInSandbox: await has(root, 'diamonds'),
		diamondsInFolder:  await has(dir,  'diamonds'),
		mode:          mod.workspace_mode(),
		listed:        JSON.parse(await app.list_diamonds() || '[]').length,
	};
}, { folder: FOLDER });

check('a Diamond made with a folder open still lives in the sandbox',
	pinned.diamondsInSandbox === true, 'diamonds/ in OPFS: ' + pinned.diamondsInSandbox);
check("Daimond's own state never lands in the user's folder",
	pinned.diamondsInFolder === false, 'diamonds/ in the folder: ' + pinned.diamondsInFolder);
check('and the Diamond is readable while the folder is open', pinned.listed >= 1,
	pinned.listed + ' diamonds');

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

/// The mode row carries THREE chips -- Browser, Machine and Cloud -- and the one
/// that answers "where is the agent working" is whichever carries `active`.
/// Reading the first chip in the row would always read "🗄 Browser" and say
/// nothing about the folder.
const chips = () => p.evaluate(() => {
	const cs = [...document.querySelectorAll('.files-mode-chip')];
	const on = cs.find(c => c.classList.contains('active'));
	return {
		active: on ? on.textContent.trim() : '(none)',
		all:    cs.map(c => c.textContent.trim()).join(' | '),
	};
});

const reconnected = await p.evaluate(async () => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	return { mode: mod.workspace_mode() };
});
reconnected.chips = await chips();
check('the folder is reconnected on the next visit, with no prompt',
	reconnected.mode === 'folder', reconnected.mode);
check('and the panel says which folder the agent is touching',
	reconnected.chips.active.includes(FOLDER), reconnected.chips.all);

// ── D2. Opening a file in the folder shows it as what it is ─────────────
//
// Reported as "clicking a PDF in the Machine workspace displays it as raw text".
// It was not the folder's doing -- the Doc panel routed on whether the leading
// bytes decode as characters, which the front of a PDF with no binary comment
// does, and it did that whichever root was open. But the folder is where a
// person's real PDFs are, so it is where the bug was met, and this is the check
// that says the root is not what decides. `dev/verify_fileview.mjs` owns the
// routing itself and owns proving the page actually renders; this one owns
// "and the same is true through a real folder".
//
// ASCII from end to end, and no binary comment: that is the failing class.
const ASCII_PDF = '%PDF-1.4\n'
	+ '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n'
	+ '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n'
	+ '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 99 99]>>endobj\n'
	+ 'trailer<</Root 1 0 R>>\n%%EOF\n';

const pdfInFolder = await p.evaluate(async ({ folder, text }) => {
	// Written through the FOLDER HANDLE, not through a file tool: the file is
	// one the user already had, not one Daimond put there.
	const root = await navigator.storage.getDirectory();
	const dir  = await root.getDirectoryHandle(folder, { create: true });
	const fh   = await dir.getFileHandle('paper.pdf', { create: true });
	const w    = await fh.createWritable();
	await w.write(new TextEncoder().encode(text));
	await w.close();
	// The tree was drawn before that write, so it is relisted through the
	// panel's own Refresh.
	const r = document.querySelector('.files-actions [data-act="refresh"]');
	if (r) r.click();
	await new Promise((res) => setTimeout(res, 1200));
	const row = document.querySelector('.files-tree .files-row[data-path="paper.pdf"]');
	if (!row) return { listed: false };
	row.click();
	await new Promise((res) => setTimeout(res, 1800));
	// The PREVIEW panel for the rendering, the DOC panel for the editor: a file
	// that is not characters is drawn in one and must not reach the other.
	const fv  = document.querySelector('#pv-view .fileview');
	const pre = document.querySelector('#doc-view .files-view-body');
	return {
		listed: true,
		viewer: fv ? fv.getAttribute('data-viewer') : null,
		embed:  !!document.querySelector('#pv-view .fileview embed'),
		pre:    pre ? pre.textContent.slice(0, 60) : null,
	};
}, { folder: FOLDER, text: ASCII_PDF });

check('a PDF in the open folder is listed where the user can click it',
	pdfInFolder.listed === true, JSON.stringify(pdfInFolder));
check('and clicking it shows the PDF, not its bytes as characters',
	pdfInFolder.viewer === 'doc' && pdfInFolder.embed === true && pdfInFolder.pre === null,
	JSON.stringify(pdfInFolder));

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
	return { res: (res || '').slice(0, 30), mode: mod.workspace_mode() };
});
ordinary.chips = await chips();
check('an ordinary tool error does not tear the folder down',
	ordinary.mode === 'folder' && ordinary.chips.active.includes(FOLDER),
	`mode: ${ordinary.mode}, chips: ${ordinary.chips.all}`);

// And the positive: the edge raises `daimond:folder-lost`, and the app must drop to the sandbox
// and say so rather than carry on against a folder it no longer has.
const lost = await p.evaluate(async () => {
	window.dispatchEvent(new CustomEvent('daimond:folder-lost'));
	await new Promise(r => setTimeout(r, 600));
	const mod  = await import('../pkg/oxedyne_daimond.js');
	const msg  = document.querySelector('.files-mode-msg');
	// The way back is the Machine chip itself, relabelled "💻 Reconnect <name>"
	// by renderMode(lost) -- an offer that needs the user's gesture, never a
	// prompt on load. It is not a separate button.
	const back = [...document.querySelectorAll('.files-mode-chip')]
		.some(c => /Reconnect/i.test(c.textContent));
	return {
		mode:    mod.workspace_mode(),
		msg:     msg ? msg.textContent.trim() : '(none)',
		reconnect: back,
	};
});
lost.chips = await chips();
check('a withdrawn grant drops the agent back to the sandbox',
	lost.mode === 'opfs', lost.mode);
// The row still NAMES the folder, in the reconnect offer -- what it must not do
// is go on claiming the agent is working there, so it is the ACTIVE chip that
// has to have moved back to the browser sandbox.
check('and the panel stops claiming a folder it cannot reach',
	!lost.chips.active.includes(FOLDER), lost.chips.all);
check('and the user is told, and offered a way back',
	/Lost access/i.test(lost.msg) && lost.reconnect === true,
	`${lost.msg} · reconnect offered: ${lost.reconnect}`);

// ── C2. Going to the sandbox and coming back ────────────────────────────
//
// The round trip a user actually makes: point the agent at a folder, send it back to the browser
// sandbox for something that has to sync, then put it back on the folder. It cost a folder picker
// EVERY time, because the Machine chip called `showDirectoryPicker` unconditionally and switching
// to Browser had already deleted the stored handle -- so there was nothing left to go back to.
// Two bugs producing one symptom, and the symptom is a native dialog no test could answer.
//
// The picker is stubbed with a counter that aborts. That is honest to what a picker does when the
// user dismisses it, and it turns "was a dialog shown" -- otherwise unobservable -- into a number.
// Nothing below asserts that a picker WORKS; what is asserted is when one is asked for.

await p.evaluate(() => {
	window.__pick = 0;
	window.showDirectoryPicker = function (opts) {
		window.__pick++;
		window.__pickOpts = opts || null;
		var e = new Error('The user aborted a request.');
		e.name = 'AbortError';                  // what Chrome throws on a dismissed picker
		return Promise.reject(e);
	};
});

const mode  = () => p.evaluate(async () => (await import('../pkg/oxedyne_daimond.js')).workspace_mode());
const picks = () => p.evaluate(() => window.__pick);
const zero  = () => p.evaluate(() => { window.__pick = 0; });
const msg   = () => p.evaluate(() => {
	const m = document.querySelector('.files-mode-msg');
	return m ? m.textContent.trim() : '(none)';
});
/// Click a chip in the mode row by its visible text. The Machine chip is named for the folder
/// when there is one, so it is matched on either.
const clickChip = (pat) => p.evaluate((pat) => {
	const c = [...document.querySelectorAll('.files-mode-chip')]
		.find(x => new RegExp(pat, 'i').test(x.textContent));
	if (!c) return false;
	c.click();
	return true;
}, pat);
const clickBtn = (pat) => p.evaluate((pat) => {
	const b = [...document.querySelectorAll('.files-mode-btn')]
		.find(x => new RegExp(pat, 'i').test(x.textContent));
	if (!b) return false;
	b.click();
	return true;
}, pat);
/// Does IndexedDB still hold a real directory handle for the workspace? Read from the account's
/// own database name, exactly as FsaDB composes it.
const storedHandle = () => p.evaluate(async () => {
	const name = 'daimond-fsa'
		+ (window.DaimondAccounts && DaimondAccounts.opfsNs() ? '-' + DaimondAccounts.opfsNs() : '');
	const db = await new Promise((res, rej) => {
		const q = indexedDB.open(name, 1);
		q.onupgradeneeded = () => q.result.createObjectStore('handles');
		q.onsuccess = () => res(q.result);
		q.onerror   = () => rej(q.error);
	});
	const v = await new Promise((res) => {
		const t = db.transaction('handles', 'readonly');
		const r = t.objectStore('handles').get('workspace');
		r.onsuccess = () => res(r.result);
		r.onerror   = () => res(undefined);
	});
	db.close();
	return { held: !!v, isDir: !!(v && typeof v.getDirectoryHandle === 'function'), name: v ? v.name : '' };
});

// Back onto the folder, through the reconnect offer section E left standing. That is the user's
// own way back and it needs no picker, so the counter must still be zero afterwards.
await clickChip('Reconnect');
await p.waitForTimeout(900);
check('C2 setup: the reconnect offer puts the agent back on the folder',
	(await mode()) === 'folder', await mode());

// The ACTIVE Machine chip states the root's SCOPE. A user is being asked to point an agent at a
// directory on their disk; the one thing they need told is how far it reaches. The chip used to
// re-open the picker instead, which is the least useful thing it could do while already there.
await zero();
await clickChip('Machine|' + FOLDER);
await p.waitForTimeout(600);
const info = { msg: await msg(), picks: await picks() };
check('the active Machine chip states what the agent can reach, and asks for no picker',
	/works only inside/i.test(info.msg) && info.msg.includes(FOLDER) && info.picks === 0,
	`"${info.msg}" · pickers: ${info.picks}`);

// Changing the root is its own control. It is the ONE thing that should raise a picker.
await zero();
const hasChange = await clickBtn('Change folder');
await p.waitForTimeout(600);
check('a separate "Change folder…" control is what raises the picker',
	hasChange === true && (await picks()) === 1,
	`control present: ${hasChange}, pickers: ${await picks()}`);
// And it starts where the user already is, rather than in a default they have never used.
const opts = await p.evaluate(() => window.__pickOpts);
check('and it opens where the current root is',
	!!opts && opts.mode === 'readwrite' && !!opts.startIn && opts.startIn !== 'documents',
	JSON.stringify(opts));

// The round trip. Browser, then back -- and no picker anywhere in it.
await zero();
await clickChip('Browser');
await p.waitForTimeout(900);
const wentBrowser = await mode();
const kept = await storedHandle();
check('switching to the browser sandbox takes the agent there',
	wentBrowser === 'opfs', wentBrowser);
check('and does NOT delete the folder it is coming back to',
	kept.held === true && kept.isDir === true, `stored: ${JSON.stringify(kept)}`);

await clickChip('Machine|' + FOLDER);
await p.waitForTimeout(1200);
const wentBack = await mode();
const backChips = await chips();
check('and the way back is one click on the chip, with no folder picker',
	wentBack === 'folder' && (await picks()) === 0,
	`mode: ${wentBack}, pickers: ${await picks()}`);
check('the chip names the folder the agent is back in',
	backChips.active.includes(FOLDER), backChips.all);

// The guard. Coming back is a ROOT SWAP, and a root swap while an agent is mid-turn leaves it
// reading and writing somewhere else entirely. `openFolder` and `switchToOpfs` have always
// refused; the reconnect path had no guard at all, and routing the chip through it is exactly
// what would have made that gap reachable by an ordinary click.
await clickChip('Browser');
await p.waitForTimeout(700);
await p.evaluate(() => { window.__busyWas = DaimondCore.busy; DaimondCore.busy = function () { return true; }; });
await zero();
await clickChip('Machine|' + FOLDER);
await p.waitForTimeout(700);
const blocked = { mode: await mode(), msg: await msg() };
// THE PROPERTY. Two halves, and the first is the one that matters: with an
// agent mid-turn the root DID NOT MOVE (`rootSwitchBlocked`, daimond.js, is
// what every entry to a swap goes through, including the chip's reconnect
// path). An agent resolves every path against one root, so a swap under it
// writes the user's work into a folder nobody told it about. The guard returns
// before the picker is ever raised, so nothing about the root is touched.
//
// The second half is that the person is told WHY it refused, which means the
// message has to blame the running agent -- name it, hold the change off on
// account of it, and say what is being held off. `/agent/` alone would pass for
// "an agent did something, carry on"; dropping the message clause entirely
// would pass for a silent refusal, which is what this used to be and is how it
// reads as a broken chip.
//
// This was `/agent is working/`, which the copy stopped saying in those words
// while saying the same thing: "Wait for the agent to finish before changing
// where it works."
const refusalBlamesTheAgent = (m) => ({
	// The agent is named as the reason...
	agent: /\bagent\b/i.test(m),
	// ...the change is held off rather than reported as done...
	held:  /\b(wait|not|never|cannot|can[’']t|won[’']t|refus\w*|block\w*|busy|until|while|before|first|try again)\b/i.test(m),
	// ...and what is held off is where the agent works.
	root:  /\b(where it works|where the agent works|workspace|folder|root|mov(e|ing)|chang(e|ing)|switch(ing)?)\b/i.test(m),
	// ...and it is not a success notice wearing a warning's clothes.
	notDone: !/\b(is now|now in|now at|switched to|moved to|changed to|has changed|done)\b/i.test(m),
});
const why = refusalBlamesTheAgent(blocked.msg);
check('a root swap is refused while an agent is working, and blames the agent for the refusal',
	blocked.mode === 'opfs' && why.agent && why.held && why.root && why.notDone,
	`mode: ${blocked.mode} · "${blocked.msg}"`
		+ (Object.values(why).every(Boolean) ? '' : ' · ' + Object.entries(why)
			.filter(([, v]) => !v).map(([k]) => 'no ' + k).join(', ')));
await p.evaluate(() => { DaimondCore.busy = window.__busyWas; });

// And the way out. Remembering the folder across a switch removes the only thing that used to
// make Daimond forget it, so there has to be a deliberate way to say so.
await clickChip('Machine|' + FOLDER);
await p.waitForTimeout(900);
await clickChip('Machine|' + FOLDER);          // the info context, where Forget lives
await p.waitForTimeout(400);
const hasForget = await clickBtn('Forget this folder');
await p.waitForTimeout(800);
const forgotten = await storedHandle();
check('and "Forget this folder" really does forget it',
	hasForget === true && forgotten.held === false,
	`control present: ${hasForget}, stored: ${JSON.stringify(forgotten)}`);

await shot(s, 'fsa');
const errs = s.errs.filter(e => !/favicon|404|401|net::ERR/.test(e));
console.log('\nconsole errors:', errs.slice(0, 4));
await s.close();

console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) console.log('FAILED:\n  ' + bad.join('\n  '));
process.exit(bad.length ? 1 : 0);
