// verify_storage.mjs — what the workspace costs, and the one figure the browser will not give.
//
// The sandbox row used to say "Workspace · evictable  2.0 MB", which is a number with nothing to
// compare it to and a word with no explanation. The browser DOES know the rest — `estimate()`
// gives usage and quota, `persisted()` says whether the storage may be thrown away, and
// `persist()` fixes it — so the row now says how much of what it is allowed, and offers the fix.
//
// A real folder is the opposite: the browser tells us NOTHING. A FileSystemDirectoryHandle has no
// size, no quota, and there is no web API for free disk space. So that row cannot show a
// percentage, and rather than invent one it offers to go and COUNT — which on a large tree reads
// every file, and therefore has to be abandonable. That is the part worth testing: not that the
// walk works, but that it stops when it is told to.
import { open, signInAs, shot } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const s = await open({ name: 'storage', connect: false });
const p = s.page;
await p.waitForTimeout(1800);

// ── The sandbox row ─────────────────────────────────────────────────────

const sandbox = await p.evaluate(async () => {
	const r = document.getElementById('astat-store');
	const e = await navigator.storage.estimate();
	return {
		text:  r ? r.textContent.trim() : '(none)',
		title: r ? r.title : '',
		quota: e.quota,
		persisted: await navigator.storage.persisted(),
	};
});
check('the sandbox row names OPFS, connecting it to the chip in the panel',
	/OPFS/.test(sandbox.text), sandbox.text);
check('and says how much of what it is allowed',
	/%/.test(sandbox.text) && /of/.test(sandbox.title),
	sandbox.text + ' · ' + sandbox.title.slice(0, 48));
check('evictable is explained, not just asserted',
	/evict/i.test(sandbox.title), sandbox.persisted ? '(already persistent)' : 'offers the fix');

// ── The CREDIT cell is gone from Session / Week / Month ─────────────────

const spend = await p.evaluate(() => {
	const el = document.getElementById('spend-row');
	return {
		cells: [...(el ? el.querySelectorAll('.spend-label') : [])].map(e => e.textContent),
		creditCell: !!(el && el.querySelector('.credit-cell')),
	};
});
check('Session / Week / Month no longer carries a fourth "Credits" cell',
	spend.creditCell === false, spend.cells.join(' · ') || '(row hidden — no spend yet)');

// ── The native row, and the walk that can be stopped ────────────────────
//
// The folder is stood in for by an OPFS subdirectory, which is the same handle type the picker
// returns (see verify_fsa.mjs). Enough files are put in it that the walk cannot finish instantly,
// so there is something to interrupt.

const FILES = 400;
await p.evaluate(async ({ n }) => {
	const mod  = await import('../pkg/oxedyne_daimond.js');
	const root = await navigator.storage.getDirectory();
	const dir  = await root.getDirectoryHandle('bigfolder', { create: true });
	for (let i = 0; i < n; i++) {
		const fh = await dir.getFileHandle('f' + i + '.txt', { create: true });
		const w  = await fh.createWritable();
		await w.write('x'.repeat(1024));          // 1 KiB each, so the total is knowable
		await w.close();
	}
	mod.set_workspace_dir(dir);
	// The Files module owns the handle the status row reads, so it has to be told, the same way
	// activateFolder tells it when a folder is really picked.
	window.__testFolder = dir;
}, { n: FILES });

// Drive the real path: seed the handle where tryReconnect looks, and reload.
await p.evaluate(async () => {
	const root = await navigator.storage.getDirectory();
	const dir  = await root.getDirectoryHandle('bigfolder', { create: true });
	const db = await new Promise((res, rej) => {
		const q = indexedDB.open('daimond-fsa', 1);
		q.onupgradeneeded = () => q.result.createObjectStore('handles');
		q.onsuccess = () => res(q.result);
		q.onerror   = () => rej(q.error);
	});
	await new Promise((res, rej) => {
		const t = db.transaction('handles', 'readwrite');
		t.objectStore('handles').put(dir, 'workspace');
		t.oncomplete = res; t.onerror = () => rej(t.error);
	});
});
await p.reload({ waitUntil: 'domcontentloaded' });
await signInAs(s, 'storage');
await p.waitForTimeout(2500);

const nat = await p.evaluate(() => {
	const r = document.getElementById('astat-store-native');
	return { shown: r && r.style.display !== 'none', text: r ? r.textContent.trim() : '', title: r ? r.title : '' };
});
check('a real folder gets a row of its own', nat.shown === true, nat.text);
check('and it offers to count, warning that it may take a while',
	/count/i.test(nat.title) && /stop/i.test(nat.title), nat.title.slice(0, 72));

// Start the walk and STOP it almost immediately. The walk yields to the event loop, which is
// precisely what makes the stop reachable — a loop that never yielded could not hear it.
const stopped = await p.evaluate(async () => {
	const r = document.getElementById('astat-store-native');
	r.click();                                   // start counting
	await new Promise(res => setTimeout(res, 30));
	const mid = r.textContent.trim();
	r.click();                                   // …and stop it
	await new Promise(res => setTimeout(res, 600));
	return { mid, after: r.textContent.trim(), title: r.title };
});
check('while counting it reports what it has counted so far',
	/files/.test(stopped.mid), stopped.mid);
check('and it stops when told to, keeping what it counted',
	/\(part\)/.test(stopped.after) && /stopped it/i.test(stopped.title),
	stopped.after + ' · ' + stopped.title.slice(0, 56));

// And a walk left alone finishes, with the right total.
const full = await p.evaluate(async () => {
	const r = document.getElementById('astat-store-native');
	r.click();
	for (let i = 0; i < 100; i++) {
		await new Promise(res => setTimeout(res, 100));
		if (!/files/.test(r.textContent) && !/Counting/i.test(r.title)) break;
	}
	return { text: r.textContent.trim(), title: r.title };
});
check('a walk left alone finishes and reports the real total',
	/400 files/.test(full.title) && !/\(part\)/.test(full.text),
	full.text + ' · ' + full.title.slice(0, 40));

await shot(s, 'storage');
const errs = s.errs.filter(e => !/favicon|404|401|net::ERR/.test(e));
console.log('\nconsole errors:', errs.slice(0, 4));
await s.close();

console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) console.log('FAILED:\n  ' + bad.join('\n  '));
process.exit(bad.length ? 1 : 0);
