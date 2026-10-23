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

   And under the real www/js/filelock.js (OPFS-LOCK check2, D1 and D6): the empty file a
   failed write's open left on a NEW path is removed while the file's lock is still held,
   and `evict` removes only under the lock, and only the File it judged: a write that
   landed after the judgement is kept.

   And (OPFS-LOCK3): `materialiseTo`'s older whole-file (v1) branch keeps an existing file and
   leaves no new one when storage has lost it or the fetch throws; an `abort()` that throws
   still ends as the same error, the existing file untouched, a new path's empty file removed
   under the lock, and the lock given back; a failed fetch of a new path whose name has a
   reserved character removes the file by the name it is stored under.

   Round 2 (FIRE sync-abort r2, 17 Oct 2026). (d) `fetchDown` removed a STALE copy before downloading its
   newer version, so a missing part left no file at all; the download now writes over it.
   (e) A file the user saves at a new path while a failing download of it runs is his:
   only the empty placeholder that download created is removed.
   On the lock line both hold under the real filelock.js too, and a write that lands after
   `fetchDown` judged a copy stale and before its lock is granted is never written over.

   And (OPFS-LOCK5): a fetch of a path NOT on this device expects it absent. A file created
   there before the write's lock is granted (v2), or while the whole-file download runs (v1),
   is kept, and the fetch answers "already on this device".

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
/// `opt.abortThrows`: the writable's `abort` throws, having still discarded its swap, as a
/// browser's can once the stream has already errored.
function dir(files, hide = {}, onRemove = null, opt = {}) {
	const mt = new Map();
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
					return { name, size: b.length, lastModified: mt.get(name) || 1, text: async () => dec(b),
						arrayBuffer: async () => b.slice().buffer, slice: (a, z) => new Blob([b.slice(a, z)]) };
				},
				async createWritable() {
					let swap = [], done = false;
					return {
						async write(x) { if (done) throw new Error('closed'); swap.push(typeof x === 'string' ? enc(x) : new Uint8Array(x)); },
						async close() { if (done) throw new Error('closed'); done = true;
							const n = swap.reduce((t, p) => t + p.length, 0), all = new Uint8Array(n);
							let at = 0; for (const p of swap) { all.set(p, at); at += p.length; }
							files.set(name, all); mt.set(name, (mt.get(name) || 1) + 1); },
						async abort() { done = true; swap = []; if (opt.abortThrows) throw new Error('abort refused'); },
					};
				},
			};
		},
		async removeEntry(name) { if (onRemove) onRemove(name); if (!files.delete(name)) throw absent(); },
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
function tab(opfs, locks, more) { return tabWin(opfs, locks, Object.assign({}, IX, more || {})).DaimondCloud; }
function tabWin(opfs, locks, ix = IX) {
	const store = new Map([['daimond-cloud-index', JSON.stringify(ix)]]);
	const ls = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
	const win = { addEventListener: () => {}, dispatchEvent: () => true };
	loadStore(win, ls);
	const body = readFileSync(join(HERE, 'cloud.js'), 'utf8');
	const fn = new Function('window', 'localStorage', 'navigator', 'setTimeout', 'clearTimeout', 'console', 'CustomEvent',
		'with (window) {\n' + body + '\n}');
	const nav = { storage: { getDirectory: async () => opfs } };
	if (locks) {
		nav.locks = locks;
		new Function('window', 'navigator', readFileSync(join(HERE, 'filelock.js'), 'utf8'))(win, nav);
	}
	fn(win, ls, nav, setTimeout, clearTimeout,
		{ log: () => {}, debug: () => {}, warn: () => {}, error: () => {} }, class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } });
	// The real stream's contract (js/chunks.js): pieces in order, false at the first one not held.
	// The old whole-file door (js/chunks.js): the text, or null when cloud storage no longer
	// holds it; a manifest's `v1` stands in for what storage answers ('throw': the fetch throws).
	win.DaimondChunks = {
		async materialiseV1(m) {
			if (m.v1 === 'throw') throw new Error('network went');
			if (midway) { const h = midway; midway = null; await h(); }
			return m.v1 == null ? null : m.v1;
		},
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

/// A lock manager that grants each name exclusively, in order, as `navigator.locks` does;
/// `onAsk(name)` runs as each request is made, and it is granted once that settles.
function fakeLocks(onAsk) {
	const held = new Map();
	return {
		holding: (n) => held.has(n),
		request(name, opts, cb) {
			const asked = Promise.resolve(onAsk ? onAsk(name) : null);
			return new Promise((resolve, reject) => asked.then(() => {
				const start = () => Promise.resolve().then(() => cb({ name })).then((v) => {
					const q = held.get(name); q.shift();
					if (q.length) q[0](); else held.delete(name);
					resolve(v);
				}, reject);
				if (held.has(name)) held.get(name).push(start);
				else { held.set(name, [start]); start(); }
			}));
		},
	};
}
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

console.log('\nmaterialiseTo: an older whole-file (v1) manifest\n');
{
	const V1 = { 'v1gone.txt': { v: 1, size: 9, key: 'k1g', chunks: ['c'] }, 'v1boom.txt': { v: 1, size: 9, key: 'k1b', chunks: ['c'], v1: 'throw' },
		'v1ok.txt': { v: 1, size: 9, key: 'k1o', chunks: ['c'], v1: 'old words' } };
	for (const name of ['v1gone.txt', 'v1boom.txt']) {
		const folder = dir(new Map([[name, enc(MINE)]]));
		const r = await said(tab(dir(new Map()), null, V1).materialiseTo(folder, name));
		check('(v1) ' + name + ' over an EXISTING file is an error', new RegExp('^Error: ' + name.replace('.', '\\.') + ' could not be written').test(r), r);
		check('(v1) ' + name + ' leaves its exact bytes', dec(folder.files.get(name) || enc('deleted')) === MINE);
		const fresh = dir(new Map());
		const r2 = await said(tab(dir(new Map()), null, V1).materialiseTo(fresh, name));
		check('(v1) ' + name + ' on a NEW path is an error and leaves no file', /could not be written/.test(r2) && fresh.files.size === 0,
			r2 + ' / ' + [...fresh.files.keys()].join(','));
	}
	const folder = dir(new Map([['v1ok.txt', enc(MINE)]]));
	const r = await said(tab(dir(new Map()), null, V1).materialiseTo(folder, 'v1ok.txt'));
	check('(v1) a whole old file still writes', /^OK: wrote v1ok\.txt \(9 bytes\)/.test(r) && dec(folder.files.get('v1ok.txt')) === 'old words', r);
}

console.log('\nan abort() that throws\n');
{
	for (const name of ['gap.txt', 'boom.txt']) {
		const folder = dir(new Map([[name, enc(MINE)]]), {}, null, { abortThrows: true });
		const r = await said(tab(dir(new Map())).materialiseTo(folder, name));
		check('(abort) materialiseTo ' + name + ': an error, not a throw', /^Error: /.test(r), r);
		check('(abort) materialiseTo ' + name + ': the existing file keeps its exact bytes', dec(folder.files.get(name) || enc('deleted')) === MINE);
		// A file that appears at a path not on this device is not written over (OPFS-LOCK5),
		// so a failing download only reaches an existing file through a stale copy of it.
		const opfs = dir(new Map([[name, enc(MINE)]]), { [name]: 1 }, null, { abortThrows: true });
		const r2 = await said(tab(opfs).fetch(name, false));
		check('(abort) fetchDown ' + name + ': a file appearing at the path is not fetched over', r2 === 'OK: ' + name + ' is already on this device.', r2);
		check('(abort) fetchDown ' + name + ': the existing file keeps its exact bytes', dec(opfs.files.get(name) || enc('deleted')) === MINE);
		const stale = dir(new Map(), {}, null, { abortThrows: true });
		const win = tabWin(stale, null, { [name]: M_FULL });
		await said(win.DaimondCloud.fetch(name, false));
		win.DaimondStore.put('daimond-cloud-index', { [name]: Object.assign({}, IX[name], { key: 'kn', ver: 'vnew', anc: ['kf'], sn: [] }) });
		const r3 = await said(win.DaimondCloud.fetch(name, false));
		check('(abort) fetchDown ' + name + ' over a stale copy: an error, not a throw', /^Error: /.test(r3), r3);
		check('(abort) fetchDown ' + name + ' over a stale copy: it keeps its exact bytes',
			dec(stale.files.get(name) || enc('deleted')) === 'first half second half');
	}
	let locks, heldAt = null;
	const fresh = dir(new Map(), {}, () => { heldAt = locks.holding('daimond-file:folder:gap.txt'); }, { abortThrows: true });
	locks = fakeLocks();
	const r = await said(tab(dir(new Map()), locks).materialiseTo(fresh, 'gap.txt'));
	check('(abort) on a NEW path, under the lock: the same error', GAP_TO.test(r), r);
	check('(abort) the empty file still goes, while the lock is held', heldAt === true && fresh.files.size === 0,
		String(heldAt) + ' / ' + [...fresh.files.keys()].join(','));
	check('(abort) and the lock is given back', !locks.holding('daimond-file:folder:gap.txt'));
	const opfs = dir(new Map(), {}, null, { abortThrows: true });
	const locks2 = fakeLocks();
	const r2 = await said(tab(opfs, locks2).fetch('gap.txt', false));
	check('(abort) fetchDown on a NEW path, under the lock: the same error, no file, lock back',
		GAP_DOWN.test(r2) && opfs.files.size === 0 && !locks2.holding('daimond-file:sandbox:gap.txt'), r2);
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
	// A NEW path whose name has a reserved character: the open stores it as `q%3Aa.txt`, so
	// the cleanup must remove that name, not the raw one, or the empty file stays.
	const M_RES = { v: 2, size: 22, bytes: 22, key: 'kr', chunks: [{ addr: 'a1', size: 11 }, { addr: 'gone', size: 11 }] };
	const opfs = dir(new Map());
	const r = await said(tab(opfs, null, { 'q:a.txt': M_RES }).fetch('q:a.txt', false));
	check('(b) a missing chunk on a NEW reserved-character path is an error', /^Error: q:a\.txt could not be fetched/.test(r), r);
	check('(b) and leaves no file behind, under its stored name either', opfs.files.size === 0, [...opfs.files.keys()].join(','));
}

console.log('\nunder the file lock (filelock.js)\n');
{
	let locks, heldAt = null;
	const folder = dir(new Map(), {}, (n) => { heldAt = locks.holding('daimond-file:folder:gap.txt'); });
	locks = fakeLocks();
	const r = await said(tab(dir(new Map()), locks).materialiseTo(folder, 'gap.txt'));
	check('(D1) materialiseTo: the same error', GAP_TO.test(r), r);
	check('(D1) materialiseTo: the stub goes while the file lock is held', heldAt === true, String(heldAt));
	check('(D1) materialiseTo: and no file is left', !folder.files.has('gap.txt'));
	check('(D1) materialiseTo: the lock is given back', !locks.holding('daimond-file:folder:gap.txt'));
}
{
	let locks, heldAt = null;
	const opfs = dir(new Map(), {}, (n) => { heldAt = locks.holding('daimond-file:sandbox:gap.txt'); });
	locks = fakeLocks();
	const r = await said(tab(opfs, locks).fetch('gap.txt', false));
	check('(D1) fetchDown: the same error', GAP_DOWN.test(r), r);
	check('(D1) fetchDown: the stub goes while the file lock is held', heldAt === true, String(heldAt));
	check('(D1) fetchDown: and no file is left', !opfs.files.has('gap.txt'));
}
{
	// evict: a manifest naming the length and nothing more, so the judgement is the length.
	const M_HELD = { v: 2, bytes: MINE.length, chunks: [] };
	let locks, heldAt = null;
	const opfs = dir(new Map([['held.txt', enc(MINE)]]), {}, () => { heldAt = locks.holding('daimond-file:sandbox:held.txt'); });
	locks = fakeLocks();
	const r = await said(tab(opfs, locks, { 'held.txt': M_HELD }).evict('held.txt'));
	check('(D6) evict frees the file', /^OK: freed/.test(r) && !opfs.files.has('held.txt'), r);
	check('(D6) evict removes while the file lock is held', heldAt === true, String(heldAt));
}
{
	// A write lands after evict judged the file and before its lock is granted.
	const M_HELD = { v: 2, bytes: MINE.length, chunks: [] };
	const files = new Map([['held.txt', enc(MINE)]]);
	const opfs = dir(files);
	const locks = fakeLocks((n) => {
		if (n !== 'daimond-file:sandbox:held.txt') return;
		// A same-length rewrite: only the modification time tells it apart.
		return opfs.getFileHandle('held.txt').then((h) => h.createWritable()).then(async (w) => { await w.write(enc(MINE.toUpperCase())); await w.close(); });
	});
	const r = await said(tab(opfs, locks, { 'held.txt': M_HELD }).evict('held.txt'));
	await new Promise((z) => setTimeout(z, 0));
	check('(D6) a write after the judgement is kept', files.has('held.txt') && dec(files.get('held.txt')) === MINE.toUpperCase(),
		r + ' / ' + (files.has('held.txt') ? dec(files.get('held.txt')) : 'deleted'));
	check('(D6) and evict says it changed, so it did not free it (SA3 r2 D1)', /^Error: held\.txt has changed since it was checked/.test(r), r);
}

console.log('\nround 2: a stale copy, and a save during a failing download\n');
{
	// A STALE copy: fetched whole, then the index moves to a version made from it whose
	// second part is gone. Fetching again must leave the copy he has, not delete it first.
	const opfs = dir(new Map());
	const win = tabWin(opfs, null, { 'full.txt': M_FULL });
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


console.log('\nround 2 under the file lock (filelock.js)\n');
{
	// (e) under the lock: the placeholder check runs inside the lock, with the removal.
	for (const door of ['folder', 'sandbox']) {
		let locks, removed = 0;
		const target = dir(new Map(), {}, () => { removed++; });
		locks = fakeLocks();
		midway = () => { target.files.set('save.txt', enc(MINE)); };
		const r = door === 'folder'
			? await said(tab(dir(new Map()), locks).materialiseTo(target, 'save.txt'))
			: await said(tab(target, locks).fetch('save.txt', false));
		midway = null;
		check('(e/lock) ' + door + ': a save DURING a failing download is an error', /^Error: save\.txt could not be/.test(r), r);
		check('(e/lock) ' + door + ': his saved file survives with its bytes, nothing removed',
			removed === 0 && dec(target.files.get('save.txt') || enc('deleted')) === MINE, String(removed));
		check('(e/lock) ' + door + ': and the lock is given back', !locks.holding('daimond-file:' + door + ':save.txt'));
	}
	// (b) under the lock: with no save, the empty placeholder still goes, while the lock is held.
	for (const door of ['folder', 'sandbox']) {
		let locks, heldAt = null;
		const target = dir(new Map(), {}, () => { heldAt = locks.holding('daimond-file:' + door + ':save.txt'); });
		locks = fakeLocks();
		const r = door === 'folder'
			? await said(tab(dir(new Map()), locks).materialiseTo(target, 'save.txt'))
			: await said(tab(target, locks).fetch('save.txt', false));
		check('(b/lock) ' + door + ': the placeholder goes under the lock', /^Error: /.test(r) && heldAt === true && target.files.size === 0,
			r + ' / ' + String(heldAt) + ' / ' + [...target.files.keys()].join(','));
	}
}
{
	// (d) under the lock: a missing part over a STALE copy keeps it.
	const opfs = dir(new Map()), locks = fakeLocks();
	const win = tabWin(opfs, locks, { 'full.txt': M_FULL });
	await said(win.DaimondCloud.fetch('full.txt', false));
	win.DaimondStore.put('daimond-cloud-index', { 'full.txt': { v: 2, size: 22, bytes: 22, key: 'kn', ver: 'vnew', anc: ['kf'], sn: [],
		chunks: [{ addr: 'a1', size: 11 }, { addr: 'gone', size: 11 }] } });
	const r = await said(win.DaimondCloud.fetch('full.txt', false));
	check('(d/lock) a missing chunk over a STALE copy keeps its exact bytes', /^Error: full\.txt could not be fetched/.test(r)
		&& dec(opfs.files.get('full.txt') || enc('deleted')) === 'first half second half', r);
	check('(d/lock) and the lock is given back', !locks.holding('daimond-file:sandbox:full.txt'));
}
{
	// A write lands after fetchDown judged the copy stale and before its write's lock is
	// granted: his write stands, and the newer cloud version is not written over it.
	const opfs = dir(new Map());
	let arm = false;
	const locks = fakeLocks((n) => {
		if (!arm || n !== 'daimond-file:sandbox:full.txt') return;
		arm = false;
		return opfs.getFileHandle('full.txt').then((h) => h.createWritable()).then(async (w) => { await w.write(enc(MINE)); await w.close(); });
	});
	const win = tabWin(opfs, locks, { 'full.txt': M_FULL });
	await said(win.DaimondCloud.fetch('full.txt', false));
	win.DaimondStore.put('daimond-cloud-index', { 'full.txt': { v: 2, size: 22, bytes: 22, key: 'kn2', ver: 'vnew2', anc: ['kf'], sn: [],
		chunks: [{ addr: 'a2', size: 11 }, { addr: 'a1', size: 11 }] } });
	arm = true;
	const r = await said(win.DaimondCloud.fetch('full.txt', false));
	check('(d/judged) a write after the stale judgement is kept', dec(opfs.files.get('full.txt') || enc('deleted')) === MINE,
		r + ' / ' + (opfs.files.has('full.txt') ? dec(opfs.files.get('full.txt')) : 'deleted'));
	check('(d/judged) and the fetch does not claim to have fetched it', !/^OK: fetched/.test(r), r);
	check('(d/judged) and the lock is given back', !locks.holding('daimond-file:sandbox:full.txt'));
}
{
	// OPFS-LOCK5 (v2): a path not on this device, and a file is created there after
	// fetchDown found it absent and before its write's lock is granted. It is kept.
	const opfs = dir(new Map());
	const locks = fakeLocks((n) => {
		if (n !== 'daimond-file:sandbox:full.txt') return;
		return opfs.getFileHandle('full.txt', { create: true }).then((h) => h.createWritable()).then(async (w) => { await w.write(enc(MINE)); await w.close(); });
	});
	const r = await said(tab(opfs, locks).fetch('full.txt', false));
	check('(absent/v2) a file created before the write\'s lock is kept', dec(opfs.files.get('full.txt') || enc('deleted')) === MINE,
		r + ' / ' + (opfs.files.has('full.txt') ? dec(opfs.files.get('full.txt')) : 'deleted'));
	check('(absent/v2) and the fetch answers "already on this device"', r === 'OK: full.txt is already on this device.', r);
	check('(absent/v2) and the lock is given back', !locks.holding('daimond-file:sandbox:full.txt'));
}
for (const locked of [true, false]) {
	// OPFS-LOCK5 (v1): a file created at a path not on this device while its whole-file
	// download runs is kept, with the lock module and without it.
	const opfs = dir(new Map()), locks = locked ? fakeLocks() : null, how = locked ? 'lock' : 'no lock';
	const M_V1 = { v: 1, size: 9, bytes: 9, key: 'k1', v1: 'CLOUD V1!', chunks: [] };
	midway = async () => { const w = await (await opfs.getFileHandle('v1.txt', { create: true })).createWritable(); await w.write(enc(MINE)); await w.close(); };
	const r = await said(tab(opfs, locks, { 'v1.txt': M_V1 }).fetch('v1.txt', false));
	midway = null;
	check('(absent/v1) ' + how + ': a file created during the download is kept', dec(opfs.files.get('v1.txt') || enc('deleted')) === MINE,
		r + ' / ' + (opfs.files.has('v1.txt') ? dec(opfs.files.get('v1.txt')) : 'deleted'));
	check('(absent/v1) ' + how + ': and the fetch answers "already on this device"', r === 'OK: v1.txt is already on this device.', r);
	if (locks) check('(absent/v1) ' + how + ': and the lock is given back', !locks.holding('daimond-file:sandbox:v1.txt'));
	// With nothing created, the same fetch still writes the file.
	const clean = dir(new Map());
	const r2 = await said(tab(clean, locked ? fakeLocks() : null, { 'v1.txt': M_V1 }).fetch('v1.txt', false));
	check('(absent/v1) ' + how + ': with nothing there the file is fetched', /^OK: fetched v1\.txt/.test(r2)
		&& dec(clean.files.get('v1.txt') || enc('none')) === 'CLOUD V1!', r2);
}

console.log('\nqr2 (release QA): the folder merge never writes over a save it did not judge\n');
{
	// The merge (daimond.js settleAdopted / materialiseShared) judged the folder's copy of
	// full.txt stale and called materialiseTo. A Doc Save (or a daimon file_write, both under
	// 'daimond-file:folder:full.txt') holds the file as materialiseTo asks for it, and closes
	// the person's bytes. materialiseTo is then granted the lock and writes the cloud version
	// over them: bytes nobody judged, in his real folder, kept in no version row.
	const folder = dir(new Map([['full.txt', enc('old stale copy')]]));
	const locks = fakeLocks((n) => {
		if (n !== 'daimond-file:folder:full.txt') return;
		return folder.getFileHandle('full.txt').then((h) => h.createWritable()).then(async (w) => { await w.write(enc(MINE)); await w.close(); });
	});
	const r = await said(tab(dir(new Map()), locks).materialiseTo(folder, 'full.txt'));
	check('qr2 (folder/judged) a save that closed while the merge waited for the lock is kept',
		dec(folder.files.get('full.txt') || enc('deleted')) === MINE,
		r + ' / ' + (folder.files.has('full.txt') ? dec(folder.files.get('full.txt')) : 'deleted'));
	check('qr2 (folder/judged) and the lock is given back', !locks.holding('daimond-file:folder:full.txt'));
}
{
	// The same for a path the merge found absent from the folder (materialiseShared's f === null):
	// a file the person creates there before the lock is granted is written over.
	const folder = dir(new Map());
	const locks = fakeLocks((n) => {
		if (n !== 'daimond-file:folder:full.txt') return;
		return folder.getFileHandle('full.txt', { create: true }).then((h) => h.createWritable()).then(async (w) => { await w.write(enc(MINE)); await w.close(); });
	});
	const r = await said(tab(dir(new Map()), locks).materialiseTo(folder, 'full.txt'));
	check('qr2 (folder/absent) a file created at a path the merge found absent is kept',
		dec(folder.files.get('full.txt') || enc('deleted')) === MINE,
		r + ' / ' + (folder.files.has('full.txt') ? dec(folder.files.get('full.txt')) : 'deleted'));
}

console.log('\nSA3 on the lock line: the close re-check is held, and a small file is compared byte for byte\n');
{
	// A disk with a coarse clock (FAT, a network share): another program saves the same number
	// of bytes in the same tick while the merge's download of the file is open. Size and time
	// say nothing moved; only the bytes do. The re-check runs inside the writable's hold.
	const M_V1 = { v: 1, size: 9, bytes: 9, key: 'k1', v1: 'CLOUD V1!', chunks: [] };
	const theirs = 'THEIRS V1';
	const folder = dir(new Map([['v1.txt', enc('older v1!')]]));
	const locks = fakeLocks();
	let heldThen = null;
	midway = () => { heldThen = locks.holding('daimond-file:folder:v1.txt'); folder.files.set('v1.txt', enc(theirs)); };
	const r = await said(tab(dir(new Map()), locks, { 'v1.txt': M_V1 }).materialiseTo(folder, 'v1.txt'));
	check('sa3 (coarse/close) a same-size, same-tick save mid-download is kept', dec(folder.files.get('v1.txt')) === theirs && /^kept: /.test(r),
		r + ' / ' + dec(folder.files.get('v1.txt')));
	check('sa3 (coarse/close) the download held the file\'s lock across it', heldThen === true, String(heldThen));
	check('sa3 (coarse/close) and gave the lock back', !locks.holding('daimond-file:folder:v1.txt'));
}
{
	// The same tick between the merge's judgement and the lock: the judged File's bytes are not
	// the ones at the path when the write opens, so it is refused before a byte is written.
	const folder = dir(new Map([['full.txt', enc('older copy, 22 bytes!!')]]));
	const judged = await (await folder.getFileHandle('full.txt')).getFile();
	folder.files.set('full.txt', enc('their save, 22 bytes!!'));
	const locks = fakeLocks();
	const r = await said(tab(dir(new Map()), locks).materialiseTo(folder, 'full.txt', undefined, undefined, judged));
	check('sa3 (coarse/open) a same-size, same-tick save after the judgement is kept', dec(folder.files.get('full.txt')) === 'their save, 22 bytes!!' && /^kept: /.test(r),
		r + ' / ' + dec(folder.files.get('full.txt')));
}
{
	// And the judged bytes, still there, are written over: the compare refuses only a change.
	const folder = dir(new Map([['full.txt', enc('older copy, 22 bytes!!')]]));
	const judged = await (await folder.getFileHandle('full.txt')).getFile();
	const r = await said(tab(dir(new Map()), fakeLocks()).materialiseTo(folder, 'full.txt', undefined, undefined, judged));
	check('sa3 (coarse) an unchanged judged copy is written over', dec(folder.files.get('full.txt')) === 'first half second half', r);
}

console.log('\n' + (failures ? failures + ' FAILED' : 'ALL PASS'));
process.exit(failures ? 1 : 0);
