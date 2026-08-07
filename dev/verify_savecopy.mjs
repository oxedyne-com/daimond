// verify_savecopy.mjs — the two folder transfers must read and write the root
// the agent is actually on.
//
// "Save a copy" LISTED the workspace through `file_list` — which resolves the
// real-folder override — and then fetched the bytes from OPFS. "Copy in a
// folder" did the mirror: it read the chosen folder and wrote into OPFS. In the
// browser sandbox the two roots are the same directory and nothing shows; with
// a real folder open they are different directories, and then:
//
//   * the export lists the user's real files, finds nothing under those names in
//     OPFS, copies nothing, and finishes with a status line rather than an
//     error — a backup that is empty at the moment it is needed;
//   * the import writes into the sandbox, where the agent — working in the real
//     folder — cannot see any of it.
//
// The mode row hides both buttons while a folder is open, so the way to reach
// them in that state is a mode change WHILE the folder picker is up: the boot
// reconnect (`Files.tryReconnect`) activates a stored handle asynchronously, and
// a `daimond:folder-lost` event moves the mode the other way. That is modelled
// here exactly — the stubbed picker clicks the app's own Machine chip, which
// reconnects the folder through `reconnectFolder`/`activateFolder`, and only
// then resolves. Nothing about the transfer's own code path is faked.
//
// Needs dev/serve.mjs (DAIMOND_PORT, default 8777) and dev/mockllm.mjs
// (DAIMOND_MOCK_PORT, default 9099). No gateway.
import { open, errors } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const s = await open({ name: 'savecopy' });
const p = s.page;

/// Make an OPFS directory at `path` (slash-separated) and fill it.
///
/// The two DESTINATIONS are dot-prefixed, because OPFS is the only place this
/// test can make a directory handle and both transfers skip dotfiles: a
/// destination the sandbox export can see is a destination it copies into
/// itself, for ever.
const mkdir = (path, files) => p.evaluate(async ([path, files]) => {
	let dir = await navigator.storage.getDirectory();
	for (const seg of path.split('/')) dir = await dir.getDirectoryHandle(seg, { create: true });
	for (const [fn, body] of files) {
		const fh = await dir.getFileHandle(fn, { create: true });
		const w  = await fh.createWritable();
		await w.write(new TextEncoder().encode(body));
		await w.close();
	}
	return true;
}, [path, files]);

/// Everything an OPFS directory holds, as `path:content` pairs.
const listDir = (path) => p.evaluate(async (path) => {
	let dir = await navigator.storage.getDirectory();
	try { for (const seg of path.split('/')) dir = await dir.getDirectoryHandle(seg); }
	catch (e) { return ['(no such directory)']; }
	const out = [];
	const walk = async (d, pre) => {
		for await (const ent of d.entries()) {
			const at = pre ? pre + '/' + ent[0] : ent[0];
			if (ent[1].kind === 'directory') { await walk(ent[1], at); continue; }
			out.push(at + ':' + (await (await ent[1].getFile()).text()));
		}
	};
	await walk(dir, '');
	return out.sort();
}, path);

/// A file as the AGENT sees it — through the tool door, so it answers about
/// whichever root the agent is on.
const agentRead = (path) => p.evaluate(async (path) => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	return await mod.read_file(path).catch(() => null);
}, path);

const mode = () => p.evaluate(async () => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	return mod.workspace_mode();
});

/// Click a chip in the mode row by its icon: 0 is Browser, 1 is Machine.
const chip = (i) => p.evaluate((i) => {
	const chips = [...document.querySelectorAll('.files-mode-chip')];
	if (chips[i]) chips[i].click();
	return chips.length;
}, i);

/// Click one of the two transfer buttons by its label.
const transfer = (re) => p.evaluate((re) => {
	const btns = [...document.querySelectorAll('.files-mode-btn')];
	const b = btns.find(x => new RegExp(re, 'i').test(x.textContent || ''));
	if (b) b.click();
	return btns.map(x => x.textContent);
}, re);

/// The mode row's own status line, which is all the user is told.
const modeMsg = () => p.evaluate(() => {
	const m = document.querySelector('.files-mode-msg');
	return m ? m.textContent : '';
});

// ── The sandbox, a real folder, and a destination ────────────────────────

await p.evaluate(async () => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	await mod.write_file('sand.md', 'SANDBOX-PAYLOAD');
});
await mkdir('picked',            [['machine-note.md', 'MACHINE-PAYLOAD']]);
await mkdir('.savedest',         []);
await mkdir('.sanddest',         []);
// The two sources sit INSIDE a container, so the directory each transfer writes
// under (`handle.name`) is not the directory it read from. Without that, an
// import that wrote to the wrong root would write the same bytes back over its
// own source and leave nothing to see.
await mkdir('srcbox/mach-src',   [['from-machine.md', 'IMPORT-PAYLOAD']]);
await mkdir('srcbox/sand-src',   [['from-sand.md',    'SAND-IMPORT-PAYLOAD']]);

// Every directory the picker will ever return, granted the way a user grants a
// folder.
await p.evaluate(async () => {
	const root = await navigator.storage.getDirectory();
	const box  = await root.getDirectoryHandle('srcbox');
	window.__dirs = {};
	for (const [k, get] of [
		['picked',    () => root.getDirectoryHandle('picked')],
		['savedest',  () => root.getDirectoryHandle('.savedest')],
		['sanddest',  () => root.getDirectoryHandle('.sanddest')],
		['mach-src',  () => box.getDirectoryHandle('mach-src')],
		['sand-src',  () => box.getDirectoryHandle('sand-src')],
	]) {
		const d = await get();
		d.queryPermission   = async () => 'granted';
		d.requestPermission = async () => 'granted';
		window.__dirs[k] = d;
	}
	window.showDirectoryPicker = async () => window.__dirs.picked;
});

await p.evaluate(() => window.DaimondPanels && DaimondPanels.open && DaimondPanels.open('work'));
await p.waitForTimeout(700);

// ── Into the real folder, then back to the sandbox ───────────────────────
// The trip back is what leaves `rootHandle` set, so the Machine chip becomes a
// RECONNECT — no picker of its own, exactly like the boot path.

await chip(1);
await p.waitForTimeout(1200);
check('the app is in real-folder mode', (await mode()) === 'folder', await mode());
check('and the agent reads the folder\'s file, not the sandbox\'s',
	(await agentRead('machine-note.md')) === 'MACHINE-PAYLOAD' && (await agentRead('sand.md')) === null);

await chip(0);
await p.waitForTimeout(900);
check('back in the sandbox, both transfers are offered',
	(await transfer('nothing-matches')).length === 2, (await transfer('nothing-matches')).join(' | '));

// ── Save a copy, with the folder reconnecting under it ───────────────────

// The picker takes a moment, and the app reconnects the folder in that moment —
// which is what the boot reconnect does. The transfer is already running.
await p.evaluate(() => {
	window.__reconnectThenPick = (which) => async () => {
		const chips = [...document.querySelectorAll('.files-mode-chip')];
		if (chips[1]) chips[1].click();
		const mod = await import('../pkg/oxedyne_daimond.js');
		for (let i = 0; i < 60 && mod.workspace_mode() !== 'folder'; i++) {
			await new Promise(r => setTimeout(r, 50));
		}
		return window.__dirs[which];
	};
	window.showDirectoryPicker = window.__reconnectThenPick('savedest');
});
await transfer('save a copy');
await p.waitForTimeout(2500);

check('the reconnect really did land mid-transfer', (await mode()) === 'folder', await mode());
const saved = await listDir('.savedest');
check('a save-a-copy writes the files of the root the agent is actually on',
	saved.includes('machine-note.md:MACHINE-PAYLOAD'), saved.join(' ') || '(nothing written)');
check('and ONLY those files — not the sandbox it is no longer on',
	saved.length === 1 && !saved.some(x => x.indexOf('sand.md:') === 0), saved.join(' '));
check('and what it says it saved is what it saved',
	/\b1 file/.test(await modeMsg()) || /Saved 1\b/.test(await modeMsg()), await modeMsg());

// ── Copy a folder in, with the same reconnect under it ───────────────────

await chip(0);
await p.waitForTimeout(900);
await p.evaluate(() => { window.showDirectoryPicker = window.__reconnectThenPick('mach-src'); });
await transfer('import a folder|copy in a folder');
await p.waitForSelector('.dlg-ok', { timeout: 15000 });
await p.click('.dlg-ok');
await p.waitForTimeout(2500);

check('the reconnect landed mid-import too', (await mode()) === 'folder', await mode());
check('an imported folder lands where the agent can read it',
	(await agentRead('mach-src/from-machine.md')) === 'IMPORT-PAYLOAD',
	String(await agentRead('mach-src/from-machine.md')));
const inPicked = await listDir('picked');
check('which is inside the open folder',
	inPicked.includes('mach-src/from-machine.md:IMPORT-PAYLOAD'), inPicked.join(' '));
const strayed = await p.evaluate(async () => {
	const root = await navigator.storage.getDirectory();
	// The sandbox is not the workspace here. A copy at the sandbox root is the
	// import having written to the root the agent is NOT on.
	return await root.getDirectoryHandle('mach-src').then(() => 'STRAYED').catch(() => 'clean');
});
check('and nothing was written into the sandbox instead', strayed === 'clean', strayed);

// ── The sandbox case, which was never broken and must stay that way ──────

await chip(0);
await p.waitForTimeout(900);
await p.evaluate(() => { window.showDirectoryPicker = async () => window.__dirs.sanddest; });
await transfer('save a copy');
await p.waitForTimeout(3000);
const sandSaved = await listDir('.sanddest');
check('in the sandbox, a save-a-copy still copies the sandbox out',
	sandSaved.includes('sand.md:SANDBOX-PAYLOAD'), sandSaved.slice(0, 4).join(' '));

await p.evaluate(() => { window.showDirectoryPicker = async () => window.__dirs['sand-src']; });
await transfer('import a folder|copy in a folder');
await p.waitForSelector('.dlg-ok', { timeout: 15000 });
await p.click('.dlg-ok');
await p.waitForTimeout(2500);
check('and an import still lands in the sandbox the agent is on',
	(await agentRead('sand-src/from-sand.md')) === 'SAND-IMPORT-PAYLOAD',
	String(await agentRead('sand-src/from-sand.md')));
check('the app is back in the sandbox for that', (await mode()) === 'opfs', await mode());

// A gateway is not part of this; its calls answer 401 when one is up and 502
// when it is not, and neither is the app.
const errs = errors(s).filter(e =>
	!/Failed to load resource.*\b(401|402|404|426|502|503)\b/.test(e)
	&& !/favicon|net::ERR|api\/sync/.test(e));
check('nothing threw', errs.length === 0, errs.slice(0, 2).join(' | '));

await s.close();
console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) { bad.forEach(b => console.log('  FAILED: ' + b)); process.exit(1); }
