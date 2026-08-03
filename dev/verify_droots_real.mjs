// verify_droots_real.mjs — the adoption migration, over a REAL store rather than a fixture.
//
// dev/verify_droots.mjs proves the rules of the migration against data that
// verifier wrote: four files, two Diamonds, names chosen to make the assertions
// easy. That proves the logic and nothing about the corpus. A migration is a
// promise about bytes somebody already has — deep directories, hundreds of
// version snapshots, a log with a year in it, names with characters nobody on
// this side thought of — and the only honest way to test it is against a store
// this test did not write.
//
// So it needs a backup exported from a live install:
//
//	node dev/verify_droots_real.mjs --backup ~/Downloads/daimond-backup-YYYY-MM-DD.json
//
// The backup's `workspace` entries are the whole of that account's browser
// storage, byte for byte (`doExport` / `collectOpfsFiles` in www/js/daimond.js).
// Everything under `diamonds/` is laid into the STAND-IN FOLDER — putting the
// user's real store where yesterday's build would have stranded it — and the
// adoption edge is asked to bring it home. Then every byte is compared back.
//
// WITHOUT --backup THIS EXITS 2 AND PROVES NOTHING. That is deliberate and it
// is the whole point of the file: a skip that returned 0 would read as a pass
// on a suite summary, and "the migration is proven" would then be a claim
// resting on a test that never ran.
//
// Run with dev/serve.mjs up (:8777). No gateway, no hand, no mock model.
import fs from 'node:fs';
import { open, signInAs } from './harness.mjs';

const arg = (name) => {
	const i = process.argv.indexOf(name);
	return i > -1 ? process.argv[i + 1] : null;
};
const backupPath = arg('--backup');

if (!backupPath) {
	console.log('');
	console.log('  ────────────────────────────────────────────────────────────────');
	console.log('  SKIPPED — and this is NOT a pass.');
	console.log('');
	console.log('  Nothing about the Diamond migration has been proved by running');
	console.log('  this. It needs a backup exported from a real install:');
	console.log('');
	console.log('      Settings → Back up everything, then');
	console.log('      node dev/verify_droots_real.mjs --backup <file.json>');
	console.log('');
	console.log('  dev/verify_droots.mjs covers the rules against a fixture it wrote');
	console.log('  itself. That is a different claim, and a weaker one.');
	console.log('  ────────────────────────────────────────────────────────────────');
	console.log('');
	process.exit(2);
}

if (!fs.existsSync(backupPath)) {
	console.log('  no backup at ' + backupPath);
	process.exit(2);
}

const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
const all = Array.isArray(backup.workspace) ? backup.workspace : [];
const store = all.filter((f) => /^diamonds\//.test(String(f.path)));
const bytesOf = (f) => Buffer.from(String(f.b64 || ''), 'base64').length;
const total = store.reduce((n, f) => n + bytesOf(f), 0);
const ids = Array.from(new Set(store.map((f) => String(f.path).split('/')[1]))).filter(Boolean);

console.log('  backup:   ' + backupPath);
console.log('  exported: ' + (backup.exported || 'unstated'));
console.log('  store:    ' + store.length + ' files, ' + total + ' bytes, '
	+ ids.length + ' Diamonds (' + all.length + ' workspace files in all)');
console.log('');

if (!store.length) {
	console.log('  This backup carries no `diamonds/` files at all, so there is no');
	console.log('  store in it to migrate. That is a real answer about this backup,');
	console.log('  not a pass: find one taken after the Diamonds existed.');
	process.exit(2);
}

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const FOLDER = 'standin-folder';

const s = await open({ name: 'drootsreal', connect: false });
const p = s.page;
await p.waitForTimeout(1500);

const install = () => p.evaluate(async (folder) => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	window.__d = {
		mod,
		app:    new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true),
		root:   await navigator.storage.getDirectory(),
		folder: null,
	};
	__d.folder = await __d.root.getDirectoryHandle(folder, { create: true });
	const b64ToBytes = (b64) => {
		const bin = atob(b64), out = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
		return out;
	};
	const dirFor = async (which, parts) => {
		let cur = which === 'folder' ? __d.folder : __d.root;
		for (let i = 0; i < parts.length - 1; i++) {
			cur = await cur.getDirectoryHandle(parts[i], { create: true });
		}
		return cur;
	};
	// Written and read through the directory handle, never through the store:
	// "did every byte arrive" must not be answered by the thing under test.
	window.__put = async (which, path, b64) => {
		const parts = path.split('/');
		const dir = await dirFor(which, parts);
		const fh = await dir.getFileHandle(parts[parts.length - 1], { create: true });
		const w = await fh.createWritable();
		await w.write(b64ToBytes(b64));
		await w.close();
	};
	window.__digest = async (which, path) => {
		let cur = which === 'folder' ? __d.folder : __d.root;
		const parts = path.split('/');
		try {
			for (let i = 0; i < parts.length - 1; i++) cur = await cur.getDirectoryHandle(parts[i]);
			const fh = await cur.getFileHandle(parts[parts.length - 1]);
			const buf = await (await fh.getFile()).arrayBuffer();
			const h = await crypto.subtle.digest('SHA-256', buf);
			return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
		} catch (e) { return null; }
	};
}, FOLDER);

await install();

// ── The user's real store, where yesterday's build would have left it ────

for (const f of store) {
	await p.evaluate(([path, b64]) => __put('folder', path, b64), [f.path, f.b64]);
}
const digests = {};
for (const f of store) {
	digests[f.path] = await p.evaluate(([w, path]) => __digest(w, path), ['folder', f.path]);
}
check('every file of the real store was laid into the folder',
	Object.values(digests).every((d) => !!d),
	Object.values(digests).filter((d) => !d).length + ' unreadable');

// ── Adoption, through the same edge the page calls ───────────────────────

const t0 = Date.now();
const report = await p.evaluate(async () => {
	__d.mod.set_workspace_dir(__d.folder);
	return JSON.parse(await __d.mod.adopt_folder_diamonds());
});
const took = Date.now() - t0;
console.log('  adoption took ' + took + ' ms; ' + report.adopted.length + ' Diamonds, '
	+ (report.skipped || []).length + ' files skipped, '
	+ (report.left || []).length + ' entries left alone');

check('adoption brought home every Diamond the store held',
	ids.every((id) => report.adopted.some((d) => d.id === id)),
	'missing: ' + ids.filter((id) => !report.adopted.some((d) => d.id === id)).join(' '));

// ── Every byte, compared where it landed ─────────────────────────────────

const wrong = [];
for (const f of store) {
	const here = await p.evaluate(([w, path]) => __digest(w, path), ['opfs', f.path]);
	if (here !== digests[f.path]) wrong.push(f.path);
}
check('and every byte of it arrived, file for file',
	wrong.length === 0, wrong.length + ' differ: ' + wrong.slice(0, 4).join(', '));

const gone = [];
for (const f of store) {
	const there = await p.evaluate(([w, path]) => __digest(w, path), ['folder', f.path]);
	if (there !== digests[f.path]) gone.push(f.path);
}
check('and nothing was taken out of the folder or changed there',
	gone.length === 0, gone.length + ' differ: ' + gone.slice(0, 4).join(', '));

// ── The Diamonds are Diamonds again ──────────────────────────────────────

const rail = await p.evaluate(async () => JSON.parse(await __d.app.list_diamonds()));
check('every Diamond in the backup is on the rail',
	ids.every((id) => rail.some((r) => r.id === id)),
	rail.length + ' listed, ' + ids.length + ' expected');

const crystals = await p.evaluate(async (want) => {
	const out = {};
	for (const id of want) {
		out[id] = await __d.app.read_crystal(id).then((t) => t.length).catch(() => null);
	}
	return out;
}, ids);
const unopenable = Object.keys(crystals).filter((id) => crystals[id] === null);
check('and every one of them OPENS', unopenable.length === 0, unopenable.join(' '));

const expectCrystal = {};
for (const f of store) {
	const parts = String(f.path).split('/');
	if (parts.length === 3 && parts[2] === 'crystal.md') {
		expectCrystal[parts[1]] = Buffer.from(String(f.b64 || ''), 'base64').toString('utf8').length;
	}
}
const shortened = Object.keys(expectCrystal).filter((id) => crystals[id] !== expectCrystal[id]);
check('at the length the user left it',
	shortened.length === 0,
	shortened.map((id) => id + ': ' + crystals[id] + ' vs ' + expectCrystal[id]).slice(0, 4).join(', '));

// ── And it settles ───────────────────────────────────────────────────────

const again = await p.evaluate(() => __d.mod.adopt_folder_diamonds().then(JSON.parse));
check('running it a second time brings nothing home',
	again.adopted.length === 0, JSON.stringify(again.adopted).slice(0, 120));

// Spelled the way the engine spells it (`beside_path`, src/wasm/diamond.rs):
// before the extension, and appended where there is none — `.daimond/log` has
// no extension, and a regex that assumed one silently compared the file with
// itself and called the result a second copy.
const besidePath = (path) => {
	const i = path.lastIndexOf('/');
	const dir = i < 0 ? '' : path.slice(0, i + 1);
	const leaf = path.slice(i + 1);
	const d = leaf.lastIndexOf('.');
	return d > 0 ? dir + leaf.slice(0, d) + '.from-machine' + leaf.slice(d)
		: dir + leaf + '.from-machine';
};
const doubled = [];
for (const f of store) {
	const beside = besidePath(String(f.path));
	const d = await p.evaluate(([w, path]) => __digest(w, path), ['opfs', beside]);
	if (d) doubled.push(beside);
}
check('and made no second copy of anything, the store having been empty',
	doubled.length === 0, doubled.slice(0, 4).join(', '));

// ── Across a reload, which is where a store that is not really there shows ──

await p.reload({ waitUntil: 'domcontentloaded' });
await signInAs(s, 'drootsreal');
await p.waitForTimeout(2500);
await install();
const afterReload = await p.evaluate(async () =>
	JSON.parse(await __d.app.list_diamonds()).map((r) => r.id));
check('and the whole store is still there after a reload',
	ids.every((id) => afterReload.includes(id)),
	afterReload.length + ' listed');

const noise = s.errs.filter((e) =>
	!/favicon|ERR_ABORTED|net::ERR|Failed to load resource/i.test(e));
check('the page threw nothing along the way', noise.length === 0, noise.slice(0, 3).join(' | '));

await s.close();
console.log('\n' + ok.length + ' ok, ' + bad.length + ' failed'
	+ '  (over ' + store.length + ' real files, ' + total + ' bytes)');
process.exit(bad.length ? 1 : 0);
