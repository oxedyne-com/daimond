// shot_moderow.mjs — the Workspace mode row, with the root controls it grew.
//
// Three states worth seeing, because each used to be wrong in a different way:
//
//   machine     — the agent working in a real folder. The row now carries "Change folder…", which
//                 is the ONE control that opens a picker; the chip itself states the root's scope.
//   scope       — that statement, as the active chip says it, with "Forget this folder" beside it.
//   remembered  — back on the browser sandbox, with the last folder still named on the Machine
//                 chip. This state did not exist: switching to the sandbox deleted the handle, so
//                 the chip read a bare "Machine" and going back cost a native dialog.
//
// A picked folder is stood in for by an OPFS subdirectory, which is the same handle type and
// answers queryPermission with 'granted' -- the trick verify_fsa rests on, since Playwright cannot
// answer a directory picker.
import { open } from './harness.mjs';
import path from 'node:path';
import fs from 'node:fs';

const OUT = path.join(process.cwd(), 'dev', 'shots');
fs.mkdirSync(OUT, { recursive: true });
const FOLDER = 'Projects';

const s = await open({ name: 'moderow', connect: false });
const p = s.page;
await p.waitForTimeout(1500);

await p.evaluate(() => { try { DaimondPanels.show('work'); } catch (e) {} });
await p.waitForTimeout(700);

// Seed the stored handle where FsaDB looks, then drive the app's own reconnect: that is
// activateFolder, so `rootHandle` is set exactly as it is in ordinary use.
await p.evaluate(async (folder) => {
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
	db.close();
}, FOLDER);

await p.reload({ waitUntil: 'domcontentloaded' });
const { signInAs } = await import('./harness.mjs');
await signInAs(s, 'moderow');
await p.waitForTimeout(2500);
await p.evaluate(() => { try { DaimondPanels.show('work'); } catch (e) {} });
await p.waitForTimeout(900);

const clip = async () => p.evaluate(() => {
	const row = document.querySelector('.files-mode');
	if (!row) return null;
	const r = row.getBoundingClientRect();
	return { x: Math.max(0, r.x - 8), y: Math.max(0, r.y - 8), width: r.width + 16, height: r.height + 16 };
});
const shoot = async (label) => {
	const file = path.join(OUT, `moderow-${label}.png`);
	let err = '';
	await p.screenshot({ path: file, clip: (await clip()) || undefined, timeout: 8000 })
		.catch((e) => { err = String(e && e.message ? e.message : e).split('\n')[0]; });
	console.log('  →', file, err ? 'FAILED: ' + err : '');
};
const clickChip = (pat) => p.evaluate((pat) => {
	const c = [...document.querySelectorAll('.files-mode-chip')]
		.find(x => new RegExp(pat, 'i').test(x.textContent));
	if (c) c.click();
	return !!c;
}, pat);

const row = () => p.evaluate(() => {
	const r = document.querySelector('.files-mode');
	if (!r) return null;
	return {
		chips: [...r.querySelectorAll('.files-mode-chip')].map(c => c.textContent.trim()),
		btns:  [...r.querySelectorAll('.files-mode-btn')].map(b => b.textContent.trim()),
		msg:   (r.querySelector('.files-mode-msg') || {}).textContent || '',
	};
});

console.log('machine:', JSON.stringify(await row()));
await shoot('machine');

await clickChip('Machine|' + FOLDER);
await p.waitForTimeout(500);
console.log('scope:  ', JSON.stringify(await row()));
await shoot('scope');

await clickChip('Browser');
await p.waitForTimeout(900);
console.log('remembered:', JSON.stringify(await row()));
await shoot('remembered');

await s.close();
