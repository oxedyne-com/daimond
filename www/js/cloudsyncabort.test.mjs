/* ============================================================
   Test -- a failed download never empties or deletes a file that was already there.
   ------------------------------------------------------------
   Drives the REAL www/js/cloud.js over a stand-in OPFS whose writables behave as the
   browser's do: `write` goes to a swap buffer, `close` COMMITS it over the file, `abort`
   discards it and leaves the file as it was.

   THE BUG (FIRE sync-abort, OPFS-LOCK check defect 1, 16 Oct 2026). `materialiseTo` and
   `fetchDown` called `close()` when a chunk was missing or a write threw, committing the
   partial bytes over the file, then removed the file. A sync merge into the open folder
   over a file the user already had, cut short by a network blip, emptied his file and
   deleted it.

   Asserted, for both doors, with a manifest whose 2nd chunk is missing: an EXISTING file
   keeps its exact bytes and still exists; a NEW path leaves no file behind; and a whole
   download still writes the file as before. The error text is the one the caller saw.

   Round 2 (17 Oct 2026). (d) `fetchDown` removed a STALE copy before downloading its
   newer version, so a missing part left no file at all; the download now writes over it.
   (e) A file the user saves at a new path while a failing download of it runs is his:
   only the empty placeholder that download created is removed.

   Run:   node www/js/cloudsyncabort.test.mjs
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadStore } from './storefixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(name, cond, detail) {
	const line = name + (detail !== undefined && detail !== '' ? ' -- ' + detail : '');
	if (cond) console.log('  ok   ' + line);
	else { console.log('  FAIL ' + line); failures++; }
}
const absent = () => Object.assign(new Error('absent'), { name: 'NotFoundError' });
const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);

/// A flat stand-in directory. `hide` names answer "absent" to their first `n` plain
/// lookups, which is a file another tab wrote between `fetchDown`'s look and its write.
// Every write advances the file's `lastModified`, as a real folder does (FLOW QA1-FID).
let tick = 1000;
function dir(files, hide = {}) {
	const mt = new Map(), put = files.set.bind(files);
	for (const k of files.keys()) mt.set(k, ++tick);
	files.set = (k, v) => { mt.set(k, ++tick); return put(k, v); };
	const d = {
		kind: 'directory', files,
		async getDirectoryHandle() { throw absent(); },
		async getFileHandle(name, o) {
			if (!(o && o.create) && hide[name] > 0) { hide[name]--; throw absent(); }
			if (!files.has(name)) { if (!(o && o.create)) throw absent(); files.set(name, new Uint8Array(0)); }
			return {
				kind: 'file', name,
				async getFile() {
					const b = files.get(name);
					if (!b) throw absent();
					return { name, size: b.length, lastModified: mt.get(name), text: async () => dec(b),
						arrayBuffer: async () => b.slice().buffer, slice: (a, z) => new Blob([b.slice(a, z)]) };
				},
				async createWritable() {
					let swap = [], done = false;
					return {
						async write(x) { if (done) throw new Error('closed'); swap.push(typeof x === 'string' ? enc(x) : new Uint8Array(x)); },
						async close() { if (done) throw new Error('closed'); done = true;
							const n = swap.reduce((t, p) => t + p.length, 0), all = new Uint8Array(n);
							let at = 0; for (const p of swap) { all.set(p, at); at += p.length; }
							files.set(name, all); },
						async abort() { done = true; swap = []; },
					};
				},
			};
		},
		async removeEntry(name) { if (!files.delete(name)) throw absent(); },
		async *entries() { for (const k of files.keys()) yield [k, await d.getFileHandle(k)]; },
		async *keys() { for (const k of files.keys()) yield k; },
		async *values() { for (const k of files.keys()) yield await d.getFileHandle(k); },
	};
	return d;
}

const CHUNK = { a1: enc('first half '), a2: enc('second half') };
const M_GAP  = { v: 2, size: 22, bytes: 22, key: 'kg', chunks: [{ addr: 'a1', size: 11 }, { addr: 'gone', size: 11 }] };
const M_BOOM = { v: 2, size: 22, bytes: 22, key: 'kb', chunks: [{ addr: 'a1', size: 11 }, { addr: 'boom', size: 11 }] };
const M_FULL = { v: 2, size: 22, bytes: 22, key: 'kf', chunks: [{ addr: 'a1', size: 11 }, { addr: 'a2', size: 11 }] };

const M_SAVE = { v: 2, size: 22, bytes: 22, key: 'ks', chunks: [{ addr: 'a1', size: 11 }, { addr: 'save', size: 11 }] };
const IX = { 'gap.txt': M_GAP, 'boom.txt': M_BOOM, 'full.txt': M_FULL, 'save.txt': M_SAVE };
/// Run when the stream reaches a `save` chunk, which then fails: the user saving the
/// file himself while a long download of it is still going.
let midway = null;

/// One tab holding cloud.js: the index names `gap.txt` (2nd chunk gone) and `full.txt`.
function tab(opfs, ix) { return tabWin(opfs, ix).DaimondCloud; }
function tabWin(opfs, ix = IX) {
	const store = new Map([['daimond-cloud-index', JSON.stringify(ix)]]);
	const ls = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
	const win = { addEventListener: () => {}, dispatchEvent: () => true };
	loadStore(win, ls);
	const body = readFileSync(join(HERE, 'cloud.js'), 'utf8');
	const fn = new Function('window', 'localStorage', 'navigator', 'setTimeout', 'clearTimeout', 'console', 'CustomEvent',
		'with (window) {\n' + body + '\n}');
	fn(win, ls, { storage: { getDirectory: async () => opfs } }, setTimeout, clearTimeout,
		{ log: () => {}, debug: () => {}, warn: () => {}, error: () => {} }, class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } });
	// The real stream's contract (js/chunks.js): pieces in order, false at the first one not held.
	win.DaimondChunks = {
		async materialiseStream(m, write) {
			for (const c of m.chunks) {
				if (c.addr === 'boom') throw new Error('network went');
				if (c.addr === 'save') { if (midway) await midway(); return false; }
				const b = CHUNK[c.addr]; if (!b) return false; await write(b); }
			return true;
		},
	};
	return win;
}
const MINE = 'my own words, not to be lost';
const said = async (p) => { try { return await p; } catch (e) { return 'THREW ' + (e && e.message); } };
const GAP_TO = /^Error: gap\.txt could not be written; cloud storage no longer holds all of its parts\.$/;
const GAP_DOWN = /^Error: gap\.txt could not be fetched; cloud storage no longer holds all of its parts\.$/;

console.log('\nmaterialiseTo: a merge into the open folder\n');
{
	const folder = dir(new Map([['gap.txt', enc(MINE)]]));
	const r = await said(tab(dir(new Map())).materialiseTo(folder, 'gap.txt'));
	check('(a) a missing chunk over an EXISTING file is the same error', GAP_TO.test(r), r);
	check('(a) and the file is still there', folder.files.has('gap.txt'));
	check('(a) with its exact bytes', folder.files.has('gap.txt') && dec(folder.files.get('gap.txt')) === MINE,
		folder.files.has('gap.txt') ? JSON.stringify(dec(folder.files.get('gap.txt'))) : 'deleted');
}
{
	const folder = dir(new Map());
	const r = await said(tab(dir(new Map())).materialiseTo(folder, 'gap.txt'));
	check('(b) a missing chunk on a NEW path is the same error', GAP_TO.test(r), r);
	check('(b) and leaves no file behind', !folder.files.has('gap.txt'), [...folder.files.keys()].join(','));
}
{
	const folder = dir(new Map([['full.txt', enc(MINE)]]));
	const r = await said(tab(dir(new Map())).materialiseTo(folder, 'full.txt'));
	check('(c) a whole download over a file writes it', /^OK: wrote full\.txt \(22 bytes\)/.test(r), r);
	check('(c) with the cloud bytes', dec(folder.files.get('full.txt') || new Uint8Array(0)) === 'first half second half');
	const n = dir(new Map());
	const r2 = await said(tab(dir(new Map())).materialiseTo(n, 'full.txt', 'full (copy).txt'));
	check('(c) and onto a new path', /^OK: wrote full \(copy\)\.txt/.test(r2) && dec(n.files.get('full (copy).txt') || new Uint8Array(0)) === 'first half second half', r2);
}

{
	const folder = dir(new Map([['boom.txt', enc(MINE)]]));
	const r = await said(tab(dir(new Map())).materialiseTo(folder, 'boom.txt'));
	check('(a) a fetch that THROWS mid-file over an existing file is an error', /^Error: boom\.txt could not be written/.test(r), r);
	check('(a) and leaves its exact bytes', dec(folder.files.get('boom.txt') || enc('deleted')) === MINE);
}

{
	// The user saves the file at that path while a long merge of it is failing.
	const folder = dir(new Map());
	midway = () => { folder.files.set('save.txt', enc(MINE)); };
	const r = await said(tab(dir(new Map())).materialiseTo(folder, 'save.txt'));
	midway = null;
	check('(e) a file saved at the path DURING a failing merge is an error', /^Error: save\.txt could not be written/.test(r), r);
	check('(e) and his saved file survives with its bytes', dec(folder.files.get('save.txt') || enc('deleted')) === MINE);
}

console.log('\nfetchDown: a file pulled onto this device\n');
{
	// The look says absent, then another tab's file is there by the time of the write: it
	// is not written over (OPFS-LOCK5, FIRE SYNC-ABORT3), so the missing chunk is never reached.
	const opfs = dir(new Map([['gap.txt', enc(MINE)]]), { 'gap.txt': 1 });
	const r = await said(tab(opfs).fetch('gap.txt', false));
	check('(a) a file appearing at the path is not fetched over', r === 'OK: gap.txt is already on this device.', r);
	check('(a) and the file is still there', opfs.files.has('gap.txt'));
	check('(a) with its exact bytes', opfs.files.has('gap.txt') && dec(opfs.files.get('gap.txt')) === MINE,
		opfs.files.has('gap.txt') ? JSON.stringify(dec(opfs.files.get('gap.txt'))) : 'deleted');
}
{
	const opfs = dir(new Map());
	const r = await said(tab(opfs).fetch('gap.txt', false));
	check('(b) a missing chunk on a NEW path is the same error', GAP_DOWN.test(r), r);
	check('(b) and leaves no file behind', !opfs.files.has('gap.txt'), [...opfs.files.keys()].join(','));
}
{
	const opfs = dir(new Map());
	const r = await said(tab(opfs).fetch('full.txt', false));
	check('(c) a whole download writes the file', /^OK: fetched full\.txt \(22 bytes\)/.test(r), r);
	check('(c) with the cloud bytes', dec(opfs.files.get('full.txt') || new Uint8Array(0)) === 'first half second half');
}

{
	const opfs = dir(new Map([['boom.txt', enc(MINE)]]), { 'boom.txt': 1 });
	const r = await said(tab(opfs).fetch('boom.txt', false));
	check('(a) a file appearing at the path is not fetched over, so nothing throws', r === 'OK: boom.txt is already on this device.', r);
	check('(a) and leaves its exact bytes', dec(opfs.files.get('boom.txt') || enc('deleted')) === MINE);
}

{
	// A STALE copy: fetched whole, then the index moves to a version made from it whose
	// second part is gone. Fetching again must leave the copy he has, not delete it first.
	const opfs = dir(new Map());
	const win = tabWin(opfs, { 'full.txt': M_FULL });
	const r1 = await said(win.DaimondCloud.fetch('full.txt', false));
	check('(d) the first fetch writes the file', /^OK: fetched full\.txt/.test(r1), r1);
	const M_NEW = { v: 2, size: 22, bytes: 22, key: 'kn', ver: 'vnew', anc: ['kf'], sn: [], chunks: [{ addr: 'a1', size: 11 }, { addr: 'gone', size: 11 }] };
	win.DaimondStore.put('daimond-cloud-index', { 'full.txt': M_NEW });
	const r = await said(win.DaimondCloud.fetch('full.txt', false));
	check('(d) a missing chunk over a STALE copy is an error', /^Error: full\.txt could not be fetched/.test(r), r);
	check('(d) and the stale copy is still there', opfs.files.has('full.txt'));
	check('(d) with its exact bytes', dec(opfs.files.get('full.txt') || enc('deleted')) === 'first half second half',
		opfs.files.has('full.txt') ? JSON.stringify(dec(opfs.files.get('full.txt'))) : 'deleted');
	const M_NEW2 = { v: 2, size: 22, bytes: 22, key: 'kn2', ver: 'vnew2', anc: ['kf', 'kn'], sn: [], chunks: [{ addr: 'a2', size: 11 }, { addr: 'a1', size: 11 }] };
	win.DaimondStore.put('daimond-cloud-index', { 'full.txt': M_NEW2 });
	const r2 = await said(win.DaimondCloud.fetch('full.txt', false));
	check('(d) a whole newer version replaces the stale copy', /^OK: fetched full\.txt \(22 bytes\)/.test(r2)
		&& dec(opfs.files.get('full.txt') || new Uint8Array(0)) === 'second halffirst half ', r2);
}
{
	const opfs = dir(new Map());
	midway = () => { opfs.files.set('save.txt', enc(MINE)); };
	const r = await said(tab(opfs).fetch('save.txt', false));
	midway = null;
	check('(e) a file saved at the path DURING a failing fetch is an error', /^Error: save\.txt could not be fetched/.test(r), r);
	check('(e) and his saved file survives with its bytes', dec(opfs.files.get('save.txt') || enc('deleted')) === MINE);
}

console.log('\n' + (failures ? failures + ' FAILED' : 'ALL PASS'));
process.exit(failures ? 1 : 0);
