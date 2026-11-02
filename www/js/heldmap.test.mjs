/* ============================================================
   Test -- a pass over a folder's files reads the held map once, not once per file
   (UNBLOCK-86 U86-SYNC7, 2 Nov 2026).
   ------------------------------------------------------------
   Drives the REAL www/js/cloud.js `localState` over a stand-in localStorage that counts
   the bytes it hands back.

   THE BUG. `heldOf` and `noteHeld` read the held map (`daimond-cloud-held-folder`, one
   note per file of the open folder) with `JSON.parse(localStorage.getItem(..))` on EVERY
   call. Every pull walks the folder's indexed files (`materialiseShared`, `settleAdopted`,
   the collect's census), one `localState` each, so a pass over N files parsed the N-note
   map N times: O(N^2) bytes allocated per pull, scaling with the folder rather than the
   parcel. On gilgamesh (folder-mounted, a ~0.5 MB chunk index) a pull of a 1.58 MB parcel
   took the renderer from 0.44 to 1.79 GB and 6-17 s of main thread.

   THE FIX. The held map is parsed once and kept; a note is written through; another
   tab's write (the `storage` event for that key) drops the copy.

   Asserted: over a pass of N lookups the bytes read from storage stay under twice the
   map's size, at N = 500 and 2000 (red on 88f8a687d: N x the map); the notes still
   answer `same` without a hash; a note written is read back; another tab's write is seen.
   The pins, use times and away paths (touch, isPinned, awayPaths) likewise; a storage event
   under another account's prefix (`d~<id>~<key>`) drops the copy (red on b538d69b5).
   Run:   node www/js/heldmap.test.mjs [--measure]
   ============================================================ */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadStore } from './storefixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MEASURE = process.argv.includes('--measure');
const HELD = 'daimond-cloud-held-folder';
let failures = 0;
function check(name, cond, detail) {
	const line = name + (detail !== undefined && detail !== '' ? ' -- ' + detail : '');
	if (cond) console.log('  ok   ' + line);
	else { console.log('  FAIL ' + line); failures++; }
}

/// A localStorage over a Map that counts what `getItem` hands back.
function counting() {
	const m = new Map();
	const ls = {
		read: 0,
		getItem: (k) => { const v = m.has(k) ? m.get(k) : null; if (v) ls.read += v.length; return v; },
		setItem: (k, v) => { m.set(k, String(v)); },
		removeItem: (k) => { m.delete(k); },
	};
	return ls;
}

function tab(ls) {
	const listeners = {};
	const win = {
		addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); },
		dispatchEvent: () => true,
	};
	loadStore(win, ls);
	const body = readFileSync(join(HERE, 'cloud.js'), 'utf8');
	const fn = new Function('window', 'localStorage', 'navigator', 'setTimeout', 'clearTimeout', 'console', 'CustomEvent',
		'with (window) {\n' + body + '\n}');
	fn(win, ls, { storage: { getDirectory: async () => ({}) } }, setTimeout, clearTimeout,
		{ log: () => {}, debug: () => {}, warn: () => {}, error: () => {} }, class { constructor(t) { this.type = t; } });
	return { C: win.DaimondCloud, fire: (t, e) => (listeners[t] || []).forEach((f) => f(e)) };
}

const hex = (i, n) => (i.toString(16).padStart(8, '0')).repeat(8).slice(0, n);
const pathOf = (i) => 'usr/workspace/daimond/notes/sub' + (i % 37) + '/file-' + i + '.md';
const T = 1793540000000;

/// A folder of `n` files, each with a held note that matches it, as a settled device has.
function seed(ls, n) {
	const all = {};
	for (let i = 0; i < n; i++) all[pathOf(i)] = { k: hex(i, 64), s: 1000 + i, t: T + i, v: hex(i, 12), a: [] };
	ls.setItem(HELD, JSON.stringify(all));
	return ls.getItem(HELD).length;
}

/// One pass over the folder, as `materialiseShared` makes on every pull.
async function pass(C, n) {
	let same = 0, peak = 0;
	for (let i = 0; i < n; i++) {
		const f = { size: 1000 + i, lastModified: T + i };
		const st = await C.localState(pathOf(i), f, { key: hex(i, 64) }, { folder: true });
		if (st.state === 'same') same++;
		if (MEASURE && (i & 15) === 0) peak = Math.max(peak, process.memoryUsage().heapUsed);
	}
	return { same, peak };
}

console.log('\nA pass over the folder reads the held map once\n');
for (const n of [500, 2000]) {
	const ls = counting();
	const size = seed(ls, n);
	const { C } = tab(ls);
	ls.read = 0;
	if (global.gc) global.gc();
	const base = process.memoryUsage().heapUsed;
	const t0 = performance.now();
	const r = await pass(C, n);
	const ms = Math.round(performance.now() - t0);
	check('N=' + n + ': every file answers `same` from its note, no hash', r.same === n, r.same + ' of ' + n);
	check('N=' + n + ': storage read under 2x the map over the pass', ls.read < 2 * size,
		(ls.read / size).toFixed(1) + 'x the ' + Math.round(size / 1024) + ' kB map');
	if (MEASURE) console.log('  measure N=' + n + ': map ' + Math.round(size / 1024) + ' kB, read ' + (ls.read / 1048576).toFixed(1)
		+ ' MB (UTF-16 ' + (2 * ls.read / 1048576).toFixed(1) + ' MB), ' + ms + ' ms, heap peak +'
		+ ((r.peak - base) / 1048576).toFixed(1) + ' MB');
}

console.log('\nThe kept map stays true\n');
{
	const ls = counting();
	seed(ls, 3);
	const { C, fire } = tab(ls);
	const p = pathOf(0);
	check('[ctl] a matching note answers same', (await C.localState(p, { size: 1000, lastModified: T }, { key: hex(0, 64) }, { folder: true })).state === 'same');
	// A file whose bytes moved: the note no longer matches its size; the hash decides (no
	// DaimondChunks here, so `unknown`), and nothing stale is answered from the kept copy.
	check('a moved file is not answered from the kept note', (await C.localState(p, { size: 5, lastModified: T + 9 }, { key: hex(0, 64) }, { folder: true })).state === 'unknown');
	// Another tab writes a note for path 1 that names other bytes: this tab must see it.
	const all = JSON.parse(ls.getItem(HELD));
	all[pathOf(1)] = { k: hex(77, 64), s: 4242, t: T + 77, v: hex(77, 12), a: [] };
	ls.setItem(HELD, JSON.stringify(all));
	fire('storage', { key: HELD });
	check('another tab\'s note is read after its storage event',
		(await C.localState(pathOf(1), { size: 4242, lastModified: T + 77 }, { key: hex(77, 64) }, { folder: true })).state === 'same');
	// A note this tab writes lands in storage (write-through), so a reload reads it.
	const q = 'usr/workspace/daimond/new.md';
	await C.localState(q, { size: 7, lastModified: T + 5 }, { key: hex(5, 64) }, { folder: true, live: hex(5, 64) });
	const after = JSON.parse(ls.getItem(HELD) || '{}');
	check('[ctl] a note written here is in storage at once', !!after[q] && after[q].k === hex(5, 64));
}

console.log('\nThe pins, use times and away paths are read once per walk too\n');
for (const [name, key, look] of [
	['touch per fetched file',  'daimond-cloud-atime', (C, p) => C.touch(p)],
	['isPinned per adopted one', 'daimond-cloud-pins',  (C, p) => C.isPinned(p)],
	['awayPaths per look',       'daimond-cloud-paths', (C, p) => C.awayPaths()[p]],
]) {
	const n = 1000, ls = counting(), all = {};
	for (let i = 0; i < n; i++) all[pathOf(i)] = key === 'daimond-cloud-atime' ? T + i : 1;
	ls.setItem(key, JSON.stringify(all));
	const size = ls.getItem(key).length;
	const { C } = tab(ls);
	ls.read = 0;
	for (let i = 0; i < n; i++) look(C, pathOf(i));
	check(name + ': storage read under 2x the map over N=' + n, ls.read < 2 * size,
		(ls.read / size).toFixed(1) + 'x the ' + Math.round(size / 1024) + ' kB map');
}
{
	// A use written here is in storage at once, and the kept map answers the next look.
	const ls = counting();
	const { C } = tab(ls);
	C.touch('a.md');
	C.pin('b.md', true);
	check('[ctl] touch and pin write through', !!JSON.parse(ls.getItem('daimond-cloud-atime'))['a.md']
		&& JSON.parse(ls.getItem('daimond-cloud-pins'))['b.md'] === 1 && C.isPinned('b.md'));
	C.pin('b.md', false);
	check('[ctl] an unpin is seen at once', !C.isPinned('b.md'));
}
{
	// ANOTHER TAB ON A SECOND ACCOUNT: accounts.js stores `d~<id>~<key>`, and the storage event
	// names that key. The page's own reads go through its shim to the same entry, so the
	// stand-in holds it under the bare key; the event's prefixed name must still drop the copy.
	const ls = counting();
	seed(ls, 3);
	const { C, fire } = tab(ls);
	check('[ctl] note 1 is the seeded one', (await C.localState(pathOf(1), { size: 1001, lastModified: T + 1 }, { key: hex(1, 64) }, { folder: true })).state === 'same');
	const all = JSON.parse(ls.getItem(HELD));
	all[pathOf(1)] = { k: hex(66, 64), s: 6666, t: T + 66, v: hex(66, 12), a: [] };
	ls.setItem(HELD, JSON.stringify(all));
	ls.setItem('daimond-cloud-pins', JSON.stringify({ 'p.md': 1 }));
	check('[ctl] pins read before the other tab', C.isPinned('p.md'));
	ls.setItem('daimond-cloud-pins', JSON.stringify({}));
	fire('storage', { key: 'd~acct2~' + HELD });
	fire('storage', { key: 'd~acct2~daimond-cloud-pins' });
	check('a second account\'s tab: its held note is seen after its storage event',
		(await C.localState(pathOf(1), { size: 6666, lastModified: T + 66 }, { key: hex(66, 64) }, { folder: true })).state === 'same');
	check('a second account\'s tab: its unpin is seen after its storage event', !C.isPinned('p.md'));
}

console.log('\n' + (failures ? failures + ' FAILED' : 'ALL PASS'));
process.exit(failures ? 1 : 0);
