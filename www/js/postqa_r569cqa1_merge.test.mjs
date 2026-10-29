/* ============================================================
   postqa_r569cqa1_merge.test.mjs -- r569c post-deploy QA (lane r569cqa1)

   Drives the REAL daimond.js `settleAdopted` -> `materialiseShared` pair (lifted out of
   daimond.js) over the REAL cloud.js, for a shared folder: the path u3a_rel_qr2 F1 named
   and no other node test reaches.

   (m1) a save made to b.md while a.bin downloads (after the merge judged b.md) is kept.
   (m2) a file created at a path the merge judged absent, while an earlier file downloads, is kept.
   (m3) control: nothing moves, both files are written with the cloud's bytes.
   (m4) a same-size save (only the modification time moves) is kept.
   (m5) the `was` branch (manifest unchanged, disk behind it): a save while an earlier
        file downloads is kept.

   The stand-in directory gives every write a fresh lastModified, as a real disk does.
   Run:   node www/js/postqa_r569cqa1_merge.test.mjs
   ============================================================ */
import { readPage } from '../../dev/pagesrc.mjs';
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

let clock = 1000;
/// A flat stand-in directory; `put` is a save by someone else (fresh mtime).
function dir(init) {
	const files = new Map(), at = new Map();
	const put = (k, b) => { files.set(k, b); at.set(k, ++clock); };
	for (const [k, v] of init) put(k, v);
	const d = {
		kind: 'directory', files, put,
		async getDirectoryHandle() { throw absent(); },
		async getFileHandle(name, o) {
			if (!files.has(name)) { if (!(o && o.create)) throw absent(); put(name, new Uint8Array(0)); }
			return {
				kind: 'file', name,
				async getFile() {
					const b = files.get(name);
					if (!b) throw absent();
					return { name, size: b.length, lastModified: at.get(name), text: async () => dec(b),
						arrayBuffer: async () => b.slice().buffer, slice: (a, z) => new Blob([b.slice(a, z)]) };
				},
				async createWritable() {
					let swap = [], done = false;
					return {
						async write(x) { if (done) throw new Error('closed'); swap.push(typeof x === 'string' ? enc(x) : new Uint8Array(x)); },
						async close() { if (done) throw new Error('closed'); done = true;
							const n = swap.reduce((t, p) => t + p.length, 0), all = new Uint8Array(n);
							let o = 0; for (const p of swap) { all.set(p, o); o += p.length; }
							put(name, all); },
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

const CHUNK = { a1: enc('aaaa one, '), a2: enc('aaaa two!!'), b1: enc('cloud b one '), b2: enc('cloud b two!') };
const M_A = { v: 2, size: 20, bytes: 20, key: 'ka', hash: 'hA1', ver: 'va1', anc: ['ka0'], sn: [], chunks: [{ addr: 'a1', size: 10 }, { addr: 'a2', size: 10 }] };
const M_B = { v: 2, size: 24, bytes: 24, key: 'kb', hash: 'hB1', ver: 'vb1', anc: ['kb0'], sn: [], chunks: [{ addr: 'b1', size: 12 }, { addr: 'b2', size: 12 }] };
const OLD_B = 'old stale b';
const MINE = 'my own words, not to be lost';
/// Run before the LAST piece of a.bin's download.
let duringA = null;

function lift(src, first, endMark) {
	const start = src.indexOf(first);
	if (start < 0) throw new Error('not found in daimond.js: ' + first);
	const end = src.indexOf(endMark, start);
	if (end < 0) throw new Error('end not found for: ' + first);
	return src.slice(start, end + endMark.length);
}
const DSRC = readPage(join(HERE, 'daimond.js'), 'utf8');
const LIFTED = lift(DSRC, '\tasync function settleAdopted(plan, was, fromDevice, judged) {', '\n\t}\n')
	+ lift(DSRC, '\tasync function inlineVerOf(f) {', '\n\t}\n')
	+ lift(DSRC, '\tasync function materialiseShared(plan, was, fromDevice, stand, judged) {', '\n\t}\n')
	+ lift(DSRC, '\tfunction syncFileAt(plan, path) {', '\n\t}\n');

/// One page: real cloud.js, real lifted merge pair, a shared folder `folder`.
/// `staleBytes` are the bytes `localState` places as the stale base (the merge's judgement).
function page(folder, ix, staleBytes, opfs = dir([])) {
	const store = new Map([['daimond-cloud-index', JSON.stringify(ix)]]);
	const ls = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
	const win = { addEventListener: () => {}, dispatchEvent: () => true };
	loadStore(win, ls);
	const body = readPage(join(HERE, 'cloud.js'), 'utf8');
	new Function('window', 'localStorage', 'navigator', 'setTimeout', 'clearTimeout', 'console', 'CustomEvent',
		'with (window) {\n' + body + '\n}')(win, ls, { storage: { getDirectory: async () => opfs } }, setTimeout, clearTimeout,
		{ log: () => {}, debug: () => {}, warn: () => {}, error: () => {} }, class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } });
	win.DaimondChunks = {
		chunkSizeFor: () => 10,
		async materialiseStream(m, write) {
			for (const c of m.chunks) {
				if (c.addr === 'a2' && duringA) await duringA();
				const b = CHUNK[c.addr]; if (!b) return false; await write(b);
			}
			return true;
		},
	};
	// The judgement: the bytes `staleBytes[p]` are this device's copy at the older version.
	const C = win.DaimondCloud;
	if (staleBytes) C.localState = async (p, f) => {
		const t = await f.text();
		if (staleBytes[p] !== undefined && t === staleBytes[p]) return { state: 'stale', live: 'L' + p, base: 'L' + p, baseVer: 'v0', baseAnc: [], baseSn: [] };
		return { state: 'edit', live: 'E' + p, base: 'L' + p, baseVer: 'v0', baseAnc: [], baseSn: [] };
	};
	if (staleBytes) C.mayDrop = () => true;
	const warns = [];
	const scope = {
		window: win, DaimondCloud: C, DaimondChunks: win.DaimondChunks,
		console: { warn: (s) => warns.push(s), log: () => {} },
		SYNC_FILE_MAX: 128 * 1024, SYNC_FOLDER_SHARE_MAX: 200 * 1024 * 1024,
		withinShare: () => true, heldLoc: () => 'folder:test', sharedFolderHandle: () => folder,
		conflictName: (p, d, at) => p + '.conflict-' + at, conflictCopyHeld: () => false,
		fileHash: (s) => 'fh' + s.length, fmtSyncBytes: (n) => n + ' B',
	};
	const names = Object.keys(scope);
	const merge = new Function(...names, LIFTED + '\nreturn { settleAdopted, materialiseShared };')(...names.map((n) => scope[n]));
	return { C, merge, warns, win };
}
/// The pull's sequence (daimond.js mergeCloudIndex): settle, refresh, materialise.
async function runMerge(pg, was) {
	const plan = { folder: true, roots: [], perRoot: {} };
	const judged = {};
	const stand = await pg.merge.settleAdopted(plan, was, 'phone', judged);
	await pg.C.refreshPaths();
	const made = await pg.merge.materialiseShared(plan, was, 'phone', stand, judged);
	return { judged, stand, made };
}
const IX = { 'a.bin': M_A, 'b.md': M_B };
const WAS = { 'a.bin': Object.assign({}, M_A, { hash: 'hA0' }), 'b.md': Object.assign({}, M_B, { hash: 'hB0' }) };
const text = (folder, p) => (folder.files.has(p) ? dec(folder.files.get(p)) : null);

console.log('\n(m) settleAdopted -> materialiseShared: nothing it did not judge is written over\n');
{
	const folder = dir([['a.bin', enc('old a')], ['b.md', enc(OLD_B)]]);
	const pg = page(folder, IX, { 'a.bin': 'old a', 'b.md': OLD_B });
	duringA = () => { folder.put('b.md', enc(MINE)); };
	const r = await runMerge(pg, WAS);
	duringA = null;
	check('(m1) a save to b.md while a.bin downloads is kept', text(folder, 'b.md') === MINE, JSON.stringify(text(folder, 'b.md')) + ' / ' + pg.warns.join(' | '));
	check('(m1) and a.bin still lands', text(folder, 'a.bin') === 'aaaa one, aaaa two!!', JSON.stringify(text(folder, 'a.bin')));
}
{
	const folder = dir([['a.bin', enc('old a')]]);
	const pg = page(folder, IX, { 'a.bin': 'old a' });
	duringA = () => { folder.put('b.md', enc(MINE)); };
	const r = await runMerge(pg, WAS);
	duringA = null;
	check('(m2) b.md judged absent, created while a.bin downloads, is kept', text(folder, 'b.md') === MINE, JSON.stringify(text(folder, 'b.md')) + ' / judged ' + JSON.stringify(r.judged['b.md']));
}
{
	const folder = dir([['a.bin', enc('old a')], ['b.md', enc(OLD_B)]]);
	const pg = page(folder, IX, { 'a.bin': 'old a', 'b.md': OLD_B });
	const r = await runMerge(pg, WAS);
	check('(m3) control: an unmoved judged copy is written with the cloud bytes', text(folder, 'b.md') === 'cloud b one cloud b two!' && text(folder, 'a.bin') === 'aaaa one, aaaa two!!',
		JSON.stringify([text(folder, 'a.bin'), text(folder, 'b.md')]) + ' / ' + pg.warns.join(' | '));
}
{
	const folder = dir([['a.bin', enc('old a')], ['b.md', enc(OLD_B)]]);
	const pg = page(folder, IX, { 'a.bin': 'old a', 'b.md': OLD_B });
	const SAME = 'my  stale b';	// same length as OLD_B
	duringA = () => { folder.put('b.md', enc(SAME)); };
	await runMerge(pg, WAS);
	duringA = null;
	check('(m4) a same-size save (mtime moved) is kept', text(folder, 'b.md') === SAME, JSON.stringify(text(folder, 'b.md')));
}
{
	// was[p].hash === m.hash: settleAdopted skips the path; materialiseShared judges it itself.
	const folder = dir([['a.bin', enc('old a')], ['b.md', enc(OLD_B)]]);
	const pg = page(folder, IX, { 'a.bin': 'old a', 'b.md': OLD_B });
	duringA = () => { folder.put('b.md', enc(MINE)); };
	await runMerge(pg, { 'a.bin': WAS['a.bin'], 'b.md': M_B });
	duringA = null;
	check('(m5) was-branch: a save while an earlier file downloads is kept', text(folder, 'b.md') === MINE, JSON.stringify(text(folder, 'b.md')));
}

console.log('\n(f2) settleStale and evict on an escaped name (r569bqa1 #2, wider effect)\n');
const MAIL = 'm1.42.daimond:2,S';
for (const which of ['settleStale', 'evict']) {
	const opfs = dir([]);
	const pg = page(null, { [MAIL]: M_A }, null, opfs);
	const r1 = await pg.C.fetch(MAIL, false);
	const stored = [...opfs.files.keys()].join();
	let r;
	if (which === 'settleStale') {
		const M_NEW = Object.assign({}, M_B, { key: 'kn', ver: 'vnew', anc: ['va1'] });
		pg.win.DaimondChunks.presence = async () => ({ ok: true, missing: [] });
		pg.win.DaimondStore.put('daimond-cloud-index', { [MAIL]: M_NEW });
		r = await pg.C.settleStale(MAIL);
	} else {
		const fh = await opfs.getFileHandle(stored);
		const key = await pg.C.fileKey(await fh.getFile(), 10);
		pg.win.DaimondStore.put('daimond-cloud-index', { [MAIL]: Object.assign({}, M_A, { key }) });
		r = await pg.C.evict(MAIL);
	}
	check('(f2) ' + which + ': the copy stored as ' + stored + ' is removed, said OK', /^OK: (dropped|freed)/.test(r) && opfs.files.size === 0,
		r1 + ' / ' + r + ' / left ' + [...opfs.files.keys()].join());
}

console.log('\n' + (failures ? failures + ' FAILED' : 'ALL PASS'));
process.exit(failures ? 1 : 0);
