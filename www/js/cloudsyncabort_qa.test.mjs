/* ============================================================
   Post-deploy QA r569b (lane r569bqa1, surface A SYNC-ABORT) -- failing-first arms.
   Same stand-in OPFS and the REAL www/js/cloud.js as cloudsyncabort.test.mjs.

   (f) fetchDown of a name the codec escapes (a Maildir `...daimond:2,S`): a missing chunk
       on a NEW path must leave nothing behind. removeLocal removes the RAW name, the
       placeholder stands under the ESCAPED one, so an empty file is left standing in for
       the message and the next fetch answers "already on this device".
   (g) settleStale on a PINNED stale copy whose newer manifest has a missing chunk: the copy
       is removed BEFORE the download, the download fails, the device has no file.
   (h) a save made while a SUCCESSFUL merge/fetch over an existing file is streaming is
       overwritten by close() (pre-existing TOCTOU, not introduced by c9bd097f).
       FIRE SYNC-ABORT3: the write re-checks its target immediately before close and aborts.
   (h2) the same for the merge's judgement (release QA qr2, u3a_rel_qr2.md F1, without the
       lock): a save between the judgement and the open, a file created at a path judged
       absent, or one created mid-download at a new path, is never written over.
   (d2) a fetch that throws mid-file over a STALE copy is an error and keeps the copy.
   (g2) settleStale with a presence answer: a whole newer version replaces a pinned copy or
       drops an unpinned one; a missing part or a failed query keeps the older copy.

   Run:   node www/js/cloudsyncabort_qa.test.mjs
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
/// EVERY WRITE ADVANCES THE FILE'S `lastModified` (FLOW QA1-FID, post-QA r569cqa1 T1), a
/// test's own `files.set` included, as a real folder does: with one fixed stamp the re-checks
/// below were proven on size alone, and a same-size save was invisible to them.
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
/// Run before the LAST piece of a download that then SUCCEEDS.
let during = null;

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
				if (c.addr === 'a2' && during) await during();
				const b = CHUNK[c.addr]; if (!b) return false; await write(b); }
			return true;
		},
	};
	return win;
}
const MINE = 'my own words, not to be lost';
const SAME = 'First half Second half';		// the size of 'first half second half', other words
const said = async (p) => { try { return await p; } catch (e) { return 'THREW ' + (e && e.message); } };
const GAP_TO = /^Error: gap\.txt could not be written; cloud storage no longer holds all of its parts\.$/;
const GAP_DOWN = /^Error: gap\.txt could not be fetched; cloud storage no longer holds all of its parts\.$/;


const MAIL = 'm1.42.daimond:2,S';
const M_MAIL = { v: 2, size: 22, bytes: 22, key: 'km', chunks: [{ addr: 'a1', size: 11 }, { addr: 'gone', size: 11 }] };

console.log('\n(f) fetchDown, an escaped name, a missing chunk on a NEW path\n');
{
	const opfs = dir(new Map());
	const win = tabWin(opfs, { [MAIL]: M_MAIL });
	const r = await said(win.DaimondCloud.fetch(MAIL, false));
	check('(f) the fetch is an error', /^Error: .* could not be fetched/.test(r), r);
	check('(f) and leaves no file behind', opfs.files.size === 0, [...opfs.files.entries()].map(([k, v]) => k + '=' + v.length + 'B').join(','));
	const r2 = await said(win.DaimondCloud.fetch(MAIL, false));
	check('(f) a second fetch is still an error, not an empty file "already on this device"', /^Error:/.test(r2), r2);
}

console.log('\n(g) settleStale on a PINNED stale copy, newer version missing a chunk\n');
for (const pinned of [true, false]) {
	const opfs = dir(new Map());
	const win = tabWin(opfs, { 'full.txt': M_FULL });
	const r1 = await said(win.DaimondCloud.fetch('full.txt', false));
	if (pinned) win.DaimondCloud.pin('full.txt', true);
	const M_NEW = { v: 2, size: 22, bytes: 22, key: 'kn', ver: 'vnew', anc: ['kf'], sn: [], chunks: [{ addr: 'a1', size: 11 }, { addr: 'gone', size: 11 }] };
	win.DaimondStore.put('daimond-cloud-index', { 'full.txt': M_NEW });
	const r = await said(win.DaimondCloud.settleStale('full.txt'));
	const after = await said(win.DaimondCloud.fetch('full.txt', false));
	const tag = pinned ? '(g) pinned' : '(g) unpinned';
	check(tag + ': first fetch ok', /^OK: fetched/.test(r1), r1);
	check(tag + ': after the settle (' + r + ') the device still holds a readable copy',
		opfs.files.has('full.txt') || /^OK/.test(after),
		'file ' + (opfs.files.has('full.txt') ? 'present' : 'GONE') + '; fetch now: ' + after);
}

console.log('\n(g2) settleStale when the gateway is asked: a whole newer version settles, a gap keeps\n');
CHUNK.b1 = enc('newer one, '); CHUNK.b2 = enc('newer two!!');
for (const [pinned, held] of [[true, true], [false, true], [false, false], [false, 'throws']]) {
	const opfs = dir(new Map());
	const win = tabWin(opfs, { 'full.txt': M_FULL });
	await said(win.DaimondCloud.fetch('full.txt', false));
	if (pinned) win.DaimondCloud.pin('full.txt', true);
	const asked = [];
	win.DaimondChunks.presence = async (addrs) => {
		asked.push(...addrs);
		if (held === 'throws') throw new Error('gateway down');
		return { ok: true, missing: held ? [] : ['b2'] };
	};
	const M_NEW = { v: 2, size: 22, bytes: 22, key: 'kn', ver: 'vnew', anc: ['kf'], sn: [], chunks: [{ addr: 'b1', size: 11 }, { addr: 'b2', size: 11 }] };
	win.DaimondStore.put('daimond-cloud-index', { 'full.txt': M_NEW });
	const r = await said(win.DaimondCloud.settleStale('full.txt'));
	const bytes = opfs.files.has('full.txt') ? new TextDecoder().decode(opfs.files.get('full.txt')) : null;
	const tag = '(g2) ' + (pinned ? 'pinned' : 'unpinned') + ', parts ' + (held === true ? 'all held' : held === false ? 'one missing' : 'query throws');
	if (pinned) {
		check(tag + ': the copy is the newer version, said OK', /^OK: replaced/.test(r) && bytes === 'newer one, newer two!!', r + ' -> ' + JSON.stringify(bytes));
	} else if (held === true) {
		check(tag + ': asked about every part, dropped, said OK', asked.join() === 'b1,b2' && /^OK: dropped/.test(r) && bytes === null, r + ' asked ' + asked.join());
	} else {
		check(tag + ': the older copy stays, not said OK', !/^OK/.test(r) && bytes === 'first half second half', r + ' -> ' + JSON.stringify(bytes));
	}
}

// Give the index entry the real content key of the copy here, so `evict` verifies it.
async function keyed(win, opfs) {
	win.DaimondChunks.chunkSizeFor = () => 11;
	const fh = await opfs.getFileHandle('full.txt');
	const key = await win.DaimondCloud.fileKey(await fh.getFile(), 11);
	win.DaimondStore.put('daimond-cloud-index', { 'full.txt': Object.assign({}, M_FULL, { key }) });
}
console.log('\n(x1) a removal re-checks the copy it judged, immediately before it removes\n');
{
	// Check X1 (r2): his save lands while the presence query is out.
	const opfs = dir(new Map());
	const win = tabWin(opfs, { 'full.txt': M_FULL });
	await said(win.DaimondCloud.fetch('full.txt', false));
	win.DaimondChunks.presence = async () => { opfs.files.set('full.txt', enc(MINE)); return { ok: true, missing: [] }; };
	const M_NEW = { v: 2, size: 22, bytes: 22, key: 'kn', ver: 'vnew', anc: ['kf'], sn: [], chunks: [{ addr: 'b1', size: 11 }, { addr: 'b2', size: 11 }] };
	win.DaimondStore.put('daimond-cloud-index', { 'full.txt': M_NEW });
	const r = await said(win.DaimondCloud.settleStale('full.txt'));
	const now = opfs.files.has('full.txt') ? dec(opfs.files.get('full.txt')) : null;
	check('(x1) settleStale unpinned: a save made during the presence wait survives, said "kept"', now === MINE && /^kept: /.test(r), r + ' -> ' + JSON.stringify(now));
}
{
	// evict: his save lands while the copy is verified (here as the chunk size is asked).
	const opfs = dir(new Map());
	const win = tabWin(opfs, { 'full.txt': M_FULL });
	await said(win.DaimondCloud.fetch('full.txt', false));
	await keyed(win, opfs);
	win.DaimondChunks.chunkSizeFor = () => { opfs.files.set('full.txt', enc(MINE)); return 11; };
	const r = await said(win.DaimondCloud.evict('full.txt'));
	const now = opfs.files.has('full.txt') ? dec(opfs.files.get('full.txt')) : null;
	check('(x1) evict: a save made after the verification survives, not said OK', now === MINE && !/^OK/.test(r), r + ' -> ' + JSON.stringify(now));
}
{
	// Unmoved: evict still frees.
	const opfs = dir(new Map());
	const win = tabWin(opfs, { 'full.txt': M_FULL });
	await said(win.DaimondCloud.fetch('full.txt', false));
	await keyed(win, opfs);
	const r = await said(win.DaimondCloud.evict('full.txt'));
	check('(x1) evict: an unchanged copy is freed', /^OK: freed/.test(r) && !opfs.files.has('full.txt'), r);
}

{
	// The same, with a save of the very size of the copy it replaces: only the mtime moved.
	const opfs = dir(new Map());
	const win = tabWin(opfs, { 'full.txt': M_FULL });
	await said(win.DaimondCloud.fetch('full.txt', false));
	win.DaimondChunks.presence = async () => { opfs.files.set('full.txt', enc(SAME)); return { ok: true, missing: [] }; };
	const M_NEW = { v: 2, size: 22, bytes: 22, key: 'kn', ver: 'vnew', anc: ['kf'], sn: [], chunks: [{ addr: 'b1', size: 11 }, { addr: 'b2', size: 11 }] };
	win.DaimondStore.put('daimond-cloud-index', { 'full.txt': M_NEW });
	const r = await said(win.DaimondCloud.settleStale('full.txt'));
	const now = opfs.files.has('full.txt') ? dec(opfs.files.get('full.txt')) : null;
	check('(x1) settleStale unpinned: a SAME-SIZE save during the presence wait survives, said "kept"', now === SAME && /^kept: /.test(r), r + ' -> ' + JSON.stringify(now));
}
{
	const opfs = dir(new Map());
	const win = tabWin(opfs, { 'full.txt': M_FULL });
	await said(win.DaimondCloud.fetch('full.txt', false));
	await keyed(win, opfs);
	win.DaimondChunks.chunkSizeFor = () => { opfs.files.set('full.txt', enc(SAME)); return 11; };
	const r = await said(win.DaimondCloud.evict('full.txt'));
	const now = opfs.files.has('full.txt') ? dec(opfs.files.get('full.txt')) : null;
	check('(x1) evict: a SAME-SIZE save after the verification survives, not said OK', now === SAME && !/^OK/.test(r), r + ' -> ' + JSON.stringify(now));
}

console.log('\n(d3) a stamp that faults at the open of a NEW path\n');
// The first getFile after the placeholder is made throws, so the write has no stamp of it.
function faulty(d) {
	const get = d.getFileHandle.bind(d);
	let left = 1;
	d.getFileHandle = async (name, o) => {
		const h = await get(name, o);
		if (!(o && o.create) || left <= 0) return h;
		left--;
		let once = true;
		return Object.assign({}, h, { getFile: async () => { if (once) { once = false; throw new Error('fault'); } return h.getFile(); } });
	};
	return d;
}
{
	const opfs = faulty(dir(new Map()));
	const r = await said(tab(opfs).fetch('full.txt', false));
	check('(d3) fetchDown: not "already on this device" over its own empty placeholder', !/already on this device/.test(r), r);
	check('(d3) fetchDown: and no empty file is left', !opfs.files.has('full.txt') || opfs.files.get('full.txt').length > 0,
		[...opfs.files.entries()].map(([k, v]) => k + '=' + v.length + 'B').join(','));
}
{
	const folder = faulty(dir(new Map()));
	const r = await said(tab(dir(new Map())).materialiseTo(folder, 'full.txt'));
	check('(d3) materialiseTo: not "kept" over its own empty placeholder', !/^kept/.test(r), r);
	check('(d3) materialiseTo: and no empty file is left', !folder.files.has('full.txt') || folder.files.get('full.txt').length > 0,
		[...folder.files.entries()].map(([k, v]) => k + '=' + v.length + 'B').join(','));
}
{
	// The same through fetchDown's older whole-file door (writeText), on the lock line (U3a SA3).
	const opfs = faulty(dir(new Map()));
	const M_V1 = { v: 1, size: 9, bytes: 9, key: 'k1', v1: 'CLOUD V1!', chunks: [] };
	const win = tabWin(opfs, { 'v1.txt': M_V1 });
	win.DaimondChunks.materialiseV1 = async (m) => m.v1;
	const r = await said(win.DaimondCloud.fetch('v1.txt', false));
	check('(d3) fetchDown v1: not "already on this device" over its own empty placeholder', !/already on this device/.test(r), r);
	check('(d3) fetchDown v1: and no empty file is left', !opfs.files.has('v1.txt') || opfs.files.get('v1.txt').length > 0,
		[...opfs.files.entries()].map(([k, v]) => k + '=' + v.length + 'B').join(','));
}

console.log('\n(h) a save during a SUCCESSFUL download over an existing file\n');
{
	const folder = dir(new Map([['full.txt', enc('older copy')]]));
	during = () => { folder.files.set('full.txt', enc(MINE)); };
	const r = await said(tab(dir(new Map())).materialiseTo(folder, 'full.txt'));
	during = null;
	const now = dec(folder.files.get('full.txt') || enc('deleted'));
	check('(h) materialiseTo: his save made mid-download survives (or the merge stands down)', now === MINE, r + ' -> ' + JSON.stringify(now));
}
{
	const opfs = dir(new Map());
	const win = tabWin(opfs, { 'full.txt': M_FULL });
	await said(win.DaimondCloud.fetch('full.txt', false));
	const M_NEW2 = { v: 2, size: 22, bytes: 22, key: 'kn2', ver: 'vnew2', anc: ['kf'], sn: [], chunks: [{ addr: 'a1', size: 11 }, { addr: 'a2', size: 11 }] };
	win.DaimondStore.put('daimond-cloud-index', { 'full.txt': M_NEW2 });
	during = () => { opfs.files.set('full.txt', enc(MINE)); };
	const r = await said(win.DaimondCloud.fetch('full.txt', false));
	during = null;
	const now = dec(opfs.files.get('full.txt') || enc('deleted'));
	check('(h) fetchDown over a stale copy: his save made mid-download survives', now === MINE, r + ' -> ' + JSON.stringify(now));
}

console.log('\n(h2) the merge writes over nothing it did not judge\n');
{
	// The merge judged the folder's copy stale; he saves before materialiseTo opens it.
	const folder = dir(new Map([['full.txt', enc('old stale copy')]]));
	const w = tab(dir(new Map()));
	const judged = await w.fileUnderRoot(folder, 'full.txt');
	folder.files.set('full.txt', enc(MINE));
	const r = await said(w.materialiseTo(folder, 'full.txt', 'full.txt', true, judged));
	check('(h2) a save between the judgement and the open is kept, said "kept"', /^kept: /.test(r) && dec(folder.files.get('full.txt') || enc('deleted')) === MINE, r);
}
{
	// The same, with a save of the very size of the copy judged: only the mtime moved.
	const folder = dir(new Map([['full.txt', enc('old stale copy')]]));
	const w = tab(dir(new Map()));
	const judged = await w.fileUnderRoot(folder, 'full.txt');
	folder.files.set('full.txt', enc('his own words!'));
	const r = await said(w.materialiseTo(folder, 'full.txt', 'full.txt', true, judged));
	check('(h2) a SAME-SIZE save between the judgement and the open is kept, said "kept"', /^kept: /.test(r) && dec(folder.files.get('full.txt') || enc('deleted')) === 'his own words!', r);
}
{
	// The merge found the path absent; he creates the file before materialiseTo opens it.
	const folder = dir(new Map());
	const w = tab(dir(new Map()));
	folder.files.set('full.txt', enc(MINE));
	const r = await said(w.materialiseTo(folder, 'full.txt', 'full.txt', true, w.JUDGED_ABSENT));
	check('(h2) a file created at a path judged absent is kept', /^kept: /.test(r) && dec(folder.files.get('full.txt') || enc('deleted')) === MINE, r);
}
{
	// Absent at the open; he saves there while the download streams (the placeholder moves).
	const folder = dir(new Map());
	during = () => { folder.files.set('full.txt', enc(MINE)); };
	const r = await said(tab(dir(new Map())).materialiseTo(folder, 'full.txt'));
	during = null;
	check('(h2) materialiseTo: a file saved mid-download at a new path is kept', dec(folder.files.get('full.txt') || enc('deleted')) === MINE, r);
}
{
	const opfs = dir(new Map());
	during = () => { opfs.files.set('full.txt', enc(MINE)); };
	const r = await said(tab(opfs).fetch('full.txt', false));
	during = null;
	check('(h2) fetchDown: a file saved mid-download at a new path is kept', dec(opfs.files.get('full.txt') || enc('deleted')) === MINE, r);
}
{
	// Unchanged throughout: the judged copy is written over as before.
	const folder = dir(new Map([['full.txt', enc('old stale copy')]]));
	const w = tab(dir(new Map()));
	const r = await said(w.materialiseTo(folder, 'full.txt', 'full.txt', true, await w.fileUnderRoot(folder, 'full.txt')));
	check('(h2) an unchanged judged copy is written over', /^OK: wrote full\.txt/.test(r) && dec(folder.files.get('full.txt')) === 'first half second half', r);
}

console.log('\n(d2) a fetch that throws mid-file over a stale copy\n');
{
	const opfs = dir(new Map());
	const win = tabWin(opfs, { 'full.txt': M_FULL });
	await said(win.DaimondCloud.fetch('full.txt', false));
	const M_NEWB = { v: 2, size: 22, bytes: 22, key: 'kb2', ver: 'vb2', anc: ['kf'], sn: [], chunks: [{ addr: 'a1', size: 11 }, { addr: 'boom', size: 11 }] };
	win.DaimondStore.put('daimond-cloud-index', { 'full.txt': M_NEWB });
	const r = await said(win.DaimondCloud.fetch('full.txt', false));
	check('(d2) is an error', /^Error: full\.txt could not be fetched/.test(r), r);
	check('(d2) and keeps the copy', dec(opfs.files.get('full.txt') || enc('deleted')) === 'first half second half');
}

console.log('\n(rmw) fetchDown compares against the File settleStale judged, not one it re-read\n');
{
	// U3a RMW (check B D3): settleStale judges a pinned copy stale and hands fetchDown that File.
	// A save of the same size, in the same tick, lands before fetchDown looks again; the write's
	// byte compare must be against what settleStale judged, so the save is kept.
	const opfs = dir(new Map());
	const win = tabWin(opfs, { 'full.txt': M_FULL });
	await said(win.DaimondCloud.fetch('full.txt', false));
	win.DaimondCloud.pin('full.txt', true);
	const M_NEW = { v: 2, size: 22, bytes: 22, key: 'kn', ver: 'vnew', anc: ['kf'], sn: [], chunks: [{ addr: 'a2', size: 11 }, { addr: 'a1', size: 11 }] };
	win.DaimondStore.put('daimond-cloud-index', { 'full.txt': M_NEW });
	const THEIRS = 'their save, 22 bytes!!';
	// The third look at the path is fetchDown's own `fileAt`, after settleStale judged the file.
	const g = opfs.getFileHandle; let n = 0;
	opfs.getFileHandle = function (name, o) { if (name === 'full.txt' && ++n === 3) opfs.files.set('full.txt', enc(THEIRS)); return g.call(this, name, o); };
	const r = await said(win.DaimondCloud.settleStale('full.txt'));
	opfs.getFileHandle = g;
	check('(rmw) a same-size, same-tick save after settleStale judged the copy is kept',
		dec(opfs.files.get('full.txt') || enc('deleted')) === THEIRS && !/^OK: replaced/.test(r),
		r + ' / ' + (opfs.files.has('full.txt') ? dec(opfs.files.get('full.txt')) : 'deleted'));
}

console.log('\n' + (failures ? failures + ' FAILED' : 'ALL PASS'));
process.exit(failures ? 1 : 0);
