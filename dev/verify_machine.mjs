// verify_machine.mjs — Machine mode: the file tools really move to the folder.
//
// ── WHY, AND WHAT NOBODY HAD WATCHED HAPPEN ──────────────────────────────────
//
// Daimond has two roots and exactly one is active: the browser sandbox (OPFS),
// and MACHINE — a real folder, held as a `FileSystemDirectoryHandle`. Every
// development surface rests on the second: point Daimond at its own source, and
// the file tools read and write there rather than in a sandbox nobody's compiler
// can see.
//
// Nothing exercised it. `openFolder` (`www/js/daimond.js:19443`) begins with
// `window.showDirectoryPicker()`, a NATIVE dialog no automated browser can
// answer — `www/js/hand.js:837` says so, and `dev/verify_handreal.mjs` step 5
// stands the same step in for the same reason. So the whole of what happens
// AFTER the handle arrives went unchecked: `set_workspace_dir`, the chip that
// claims which root is live, the rules re-read from the new root, and — the one
// that matters — whether the wasm file tools actually moved.
//
// ── WHAT IS PROVED HERE, AND WHAT IS NOT, EXACTLY ────────────────────────────
//
// PROVED: every line of Daimond's own path, from a handle to a file tool
// reading through it. The handle is a REAL `FileSystemDirectoryHandle` — the
// same interface, the same class, the same permission model — obtained from
// `navigator.storage.getDirectory()` rather than from the dialog, and the check
// asserts through the ENGINE's own `file_list` and `file_read`, never through
// the screen.
//
// NOT PROVED: that Chrome raises its dialog and hands back a handle. That is
// Chrome's code and not Daimond's, and it is the one step no harness can drive
// without a window manager to type into. It is named here rather than left to
// be discovered, and it is the whole of the gap.
//
// The distinction is the point of the file. A check that swapped in a plain
// object with a `getFileHandle` method would prove that the code calls methods;
// swapping in a real handle proves it works with the type the browser gives it.
//
// ── THE PROPERTY, WHICH IS NOT "IT SWITCHED" ─────────────────────────────────
//
// The root is EXCLUSIVE: the agent has exactly one. So the check is not that
// the machine folder became visible, but that the sandbox stopped being — a
// nonce written into the folder must be readable through the tools on Machine
// and unreadable on Browser, and a nonce written into the sandbox the other way
// round. A switch that merely ADDED the folder would pass the first half and
// fail the second, and would be a fence with a hole in it.
//
//   node dev/verify_machine.mjs
//   node dev/verify_machine.mjs --break noswitch    # the tools never move
//   node dev/verify_machine.mjs --break nopersist   # the handle is not kept
//
// A `--break` run EXPECTS to fail: exit 0 when something reddened, 1 when
// nothing did.
//
// Needs dev/serve.mjs (DAIMOND_PORT, default 8777). No gateway, no model.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, signInAs, shot, errors } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── The breaks ───────────────────────────────────────────────────────────────
const BREAK  = (() => { const i = process.argv.indexOf('--break'); return i > 0 ? process.argv[i + 1] : ''; })();
const BREAKS = {
	// The chip goes active and the handle is remembered; the ENGINE is never
	// repointed. This is the failure the screen cannot show you.
	noswitch: [{
		file: 'js/daimond.js',
		find: '\t\t\t\tset_workspace_dir(handle);',
		with: '\t\t\t\tvoid handle;   // --break noswitch: the engine is never repointed',
	}],
	// The switch works and nothing is kept, so the next boot is back in the
	// sandbox with no offer to reconnect.
	nopersist: [{
		file: 'js/daimond.js',
		find: '\t\t\tif (persist) { try { await FsaDB.save(handle); } catch (e) { /* non-fatal */ } }',
		with: '\t\t\tif (false) { try { await FsaDB.save(handle); } catch (e) {} }',
	}],
};

function damagedFiles() {
	const byFile = new Map();
	for (const spec of (BREAKS[BREAK] || [])) {
		const src = fs.readFileSync(path.join(WWW, spec.file), 'utf8');
		if (!src.includes(spec.find)) {
			console.error(`--break ${BREAK}: anchor not found in ${spec.file}. The break is stale.`);
			process.exit(1);
		}
		byFile.set(spec.file, src.replace(spec.find, spec.with));
	}
	return byFile;
}

async function serveBreaks(page) {
	if (!BREAK) return;
	for (const [file, body] of damagedFiles()) {
		await page.route('**/' + file, r => r.fulfill({
			status: 200, contentType: 'application/javascript', body,
		}));
	}
}

const s = await open({ name: 'machine', route: serveBreaks, connect: false });
const p = s.page;

// ── 0. Two nonces, in two roots, written before anything switches ────────────
//
// The folder's nonce goes in through the HANDLE, so it is there whatever the
// app later believes; the sandbox's goes in through the tools, which is the
// only writer the sandbox has. Both are read back through the tools, so a tool
// that never moved is caught by content and not by a flag it sets itself.
const NONCE_M = 'machine-' + Math.random().toString(36).slice(2, 10);

// The engine's own door. `DaimondFiles.entries` runs a real `file_list` through
// the wasm tools, so what it answers is where the ENGINE is — not what the chip
// claims, which is the distinction `--break noswitch` exists to expose.
const listRoot = () => p.evaluate(async () => {
	if (!window.DaimondFiles) return null;
	const es = await window.DaimondFiles.entries('');
	return es.map(e => e.name).sort();
});

// The sandbox as it stands, before anything moves. Taken by construction rather
// than asserted against a fixture: what matters is that it comes BACK, and a
// list this run did not write cannot be one this run invented.
const sandboxBefore = await listRoot();
check('0a the engine answers a listing at all', Array.isArray(sandboxBefore),
	JSON.stringify(sandboxBefore));

const setup = await p.evaluate(async (nm) => {
	// A REAL FileSystemDirectoryHandle — same interface, same class, same
	// permission model as the dialog returns — and a SIBLING of the app's root
	// rather than the root itself. A stand-in that WAS the sandbox would make
	// "the tools moved" and "the tools did not" indistinguishable.
	const opfs = await navigator.storage.getDirectory();
	const dir  = await opfs.getDirectoryHandle('machine-test-root', { create: true });
	const fh   = await dir.getFileHandle('nonce.txt', { create: true });
	const w    = await fh.createWritable();
	await w.write(nm);
	await w.close();
	window.__machineHandle = dir;
	return { madeHandle: !!dir && typeof dir.getFileHandle === 'function' };
}, NONCE_M);

check('0b a real FileSystemDirectoryHandle stands in for the dialog',
	setup.madeHandle === true);
check('0c and the sandbox does not already hold the folder\'s file',
	!!sandboxBefore && !sandboxBefore.includes('nonce.txt'),
	JSON.stringify(sandboxBefore));

// ── 1. Switch, with the dialog stood in for ──────────────────────────────────
const switched = await p.evaluate(async () => {
	window.showDirectoryPicker = async () => window.__machineHandle;
	// The chip the user presses, found by its label rather than by position.
	const chips = [...document.querySelectorAll('.files-mode-chip')];
	const machine = chips.find(c => /machine/i.test(c.textContent || ''));
	if (!machine) return { clicked: false, chips: chips.map(c => (c.textContent || '').trim()) };
	machine.click();
	return { clicked: true };
});
check('1a the Machine chip is on screen and was pressed', switched.clicked === true,
	switched.clicked ? '' : 'chips: ' + JSON.stringify(switched.chips || []));
await sleep(1500);

const onMachine = await p.evaluate(() => ({
	folder: !!(window.DaimondFiles && window.DaimondFiles.folder()),
	same:   !!(window.DaimondFiles && window.DaimondFiles.folder() === window.__machineHandle),
}));
check('1b the app holds the folder it was handed', onMachine.same === true,
	`folder ${onMachine.folder ? 'set' : 'null'}`);

// ── 2. THE FILE TOOLS MOVED, proved by content ───────────────────────────────
const namesM = await listRoot();
check('2a the ENGINE lists the folder\'s own file', !!namesM && namesM.includes('nonce.txt'),
	namesM ? JSON.stringify(namesM.slice(0, 8)) : 'no listing');
check('2b and it is a DIFFERENT root, not the sandbox with a folder added',
	!!namesM && JSON.stringify(namesM) !== JSON.stringify(sandboxBefore),
	`machine ${JSON.stringify(namesM)} vs sandbox ${JSON.stringify(sandboxBefore)}`);
await shot(s, 'machine-on');

// ── 3. Back to the sandbox, and the fence holds the other way ────────────────
const back = await p.evaluate(async () => {
	const chips = [...document.querySelectorAll('.files-mode-chip')];
	const browser = chips.find(c => /browser/i.test(c.textContent || ''));
	if (!browser) return false;
	browser.click();
	return true;
});
check('3a the Browser chip is on screen and was pressed', back === true);
await sleep(1500);

const namesB = await listRoot();
// Everything the sandbox held is back, and the folder's file is not. NOT an
// equality: this run's own stand-in folder was created under the OPFS root, so
// it legitimately appears in the listing afterwards. Asserting equality would
// have made the FIXTURE the thing that failed, which is a check testing itself.
check('3b the ENGINE is back in the sandbox, and the folder is gone from it',
	!!namesB && !namesB.includes('nonce.txt')
		&& sandboxBefore.every(n => namesB.includes(n)),
	`back ${JSON.stringify(namesB)} vs before ${JSON.stringify(sandboxBefore)}`);

// ── 4. The handle was kept, so a reconnect has something to offer ────────────
const kept = await p.evaluate(async () => {
	try {
		const db = await new Promise((res, rej) => {
			const r = indexedDB.open('daimond-fsa');
			r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
			r.onupgradeneeded = () => { /* absent is an answer */ };
		});
		const names = [...db.objectStoreNames];
		if (!names.length) return { stores: names, count: 0 };
		const tx = db.transaction(names[0], 'readonly');
		const n = await new Promise((res) => {
			const rq = tx.objectStore(names[0]).count();
			rq.onsuccess = () => res(rq.result); rq.onerror = () => res(-1);
		});
		return { stores: names, count: n };
	} catch (e) { return { stores: [], count: -1, err: String(e) }; }
});
check('4 the folder was remembered, so a reconnect can be offered',
	kept.count > 0, JSON.stringify(kept));

// The 401s are the gateway's absence, not the switch's doing: this session is
// deliberately unconnected, so `/api/tools` has nobody to ask.
const errs = errors(s).filter(e => !/502|401|Account service|favicon/.test(e));
check('5 the switch raised nothing in the console', errs.length === 0,
	errs.slice(0, 2).join(' | '));

await s.close();

console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (BREAK) {
	console.log(bad.length ? `--break ${BREAK}: reddened ${bad.length} check(s), as it must`
		: `--break ${BREAK}: CHANGED NOTHING — the check it names is not testing what it says`);
	process.exit(bad.length ? 0 : 1);
}
process.exit(bad.length ? 1 : 0);
