/* ============================================================
   Test -- an older copy is never offered, or taken, as the newer
   version (cloud.js; lane REV, 2026-09-27).
   ------------------------------------------------------------
   QCMG decision 2: a merge adopted another device's newer manifest
   and left this device's older bytes on disk; the next collect
   uploaded them as an edit and the account settled on the older
   version. Asserted here on the REAL www/js/cloud.js:

   - a manifest names its version (`ver`) and what it was made from
     (`anc`), chained through `put`, and an older build's manifest is
     named by its content key's prefix (`verOf`);
   - the merge takes theirs when it was made from ours and keeps ours
     when ours was made from theirs, whatever the fork point says (a
     relayed or re-offered older copy is not news);
   - `localState` places the bytes held here: `same`, `stale` (the
     version this device last established, which the index moved
     past), `edit`, `unknown`; one storage's note is not another's;
   - `keepOurs` files theirs beside ours.

   Run:   node www/js/stalecopy.test.mjs
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { webcrypto } from 'node:crypto';
import { loadStore } from './storefixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(name, cond, detail) {
	const line = name + (detail !== undefined && detail !== '' ? ' -- ' + detail : '');
	if (cond) console.log('  ok   ' + line);
	else { console.log('  FAIL ' + line); failures++; }
}
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const J = (x) => JSON.stringify(x);
const Stamp = { ms: (v) => Math.max(0, Math.floor(Number(v) || 0)), canon: (v) => J(v), next: (p) => Math.max(Date.now(), (p | 0) + 1),
	beats: (a, v, b, h) => (a !== b ? a > b : J(v) > J(h)) };

function device() {
	const kv = new Map();
	const Durable = {
		ready: async () => {}, durable: () => true, migrate: async () => true,
		get: async (k) => clone(kv.has(k) ? kv.get(k) : null),
		set: async (k, v) => { kv.set(k, clone(v)); return true; },
		update: async (k, fn) => { const v = fn(clone(kv.has(k) ? kv.get(k) : null)); kv.set(k, clone(v)); return { ok: true, value: v }; },
	};
	const box = new Map();
	const ls = { getItem: (k) => (box.has(k) ? box.get(k) : null), setItem: (k, v) => box.set(k, String(v)), removeItem: (k) => box.delete(k) };
	const win = { addEventListener: () => {}, dispatchEvent: () => true, DaimondDurable: Durable, DaimondStamp: Stamp,
		DaimondChunks: { chunkSizeFor: () => 4 } };
	loadStore(win, ls);
	class Ch { constructor() { this.onmessage = null; } postMessage() {} close() {} }
	win.BroadcastChannel = Ch;
	const body = readFileSync(join(HERE, 'cloud.js'), 'utf8');
	const fn = new Function('window', 'localStorage', 'navigator', 'setTimeout', 'clearTimeout', 'console', 'CustomEvent', 'BroadcastChannel', 'crypto',
		'with (window) {\n' + body + '\n}');
	fn(win, ls, { storage: {} }, setTimeout, clearTimeout, { log: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
		class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } }, Ch, webcrypto);
	return { C: win.DaimondCloud, ls };
}
const file = (text, t) => new File([text], 'f', { lastModified: t });
const key = async (C, f) => C.fileKey(f, 4);
const mani = (k, tag) => ({ v: 2, size: 10, key: k, chunks: [{ addr: 'a-' + tag, size: 10 }] });
const F = 'big/f.txt';

console.log('\nversions: named, chained, and read by the merge\n');
{
	const A = device(), B = device();
	await A.C.ready(); await B.C.ready();
	const f1 = file('version one', 1), k1 = await key(A.C, f1);
	await A.C.put(F, mani(k1, 'a1'), k1, { file: f1, parent: null });
	const m1 = A.C.index()[F];
	check('a new file is a version with no ancestors', typeof m1.ver === 'string' && m1.ver.length === 12 && J(m1.anc) === '[]', J({ ver: m1.ver, anc: m1.anc }));
	// B takes V1 and holds it (a fetch notes the version held).
	B.C.merge(A.C.index(), {}, 'devB', 'devA', {});
	const fB1 = file('version one', 5);
	const sB1 = await B.C.localState(F, fB1, B.C.index()[F]);
	check('bytes that are the manifest\'s content are `same`, whatever their mtime', sB1.state === 'same', J(sB1));
	// B edits to V2 and uploads it as an edit of V1.
	const f2 = file('version two, newer', 9), k2 = await key(B.C, f2);
	const sB2 = await B.C.localState(F, f2, B.C.index()[F]);
	check('changed bytes are an `edit` of the version held', sB2.state === 'edit' && sB2.baseVer === m1.ver, J(sB2));
	await B.C.put(F, mani(k2, 'b2'), k2, { file: f2, parent: { ver: sB2.baseVer, anc: sB2.baseAnc } });
	const m2 = B.C.index()[F];
	check('the edit names V1 as what it was made from', m2.ver !== m1.ver && J(m2.anc) === J([m1.ver]) && B.C.descends(m2, m1.ver), J({ ver: m2.ver, anc: m2.anc }));
	check('[ctl] and V1 was not made from V2', !B.C.descends(m1, m2.ver));

	// A pulls: its fork point says A moved (base names nothing), and still V2 is taken, since it was made from ours.
	A.C.merge(B.C.index(), { [F]: 'some-other' }, 'devA', 'devB', {});
	check('theirs made from ours is taken even where the fork point reads both as moved', A.C.index()[F].hash === k2
		&& !Object.keys(A.C.index()).some((k) => k === F + '.synced' || k.indexOf(F.replace(/\.[^./]*$/, '') + '.conflict-') === 0));
	const sA = await A.C.localState(F, f1, A.C.index()[F]);
	check('A\'s bytes, still V1, are `stale` under V2, and V2 was made from them', sA.state === 'stale' && A.C.descends(A.C.index()[F], sA.baseVer), J(sA));

	// The fault's own shape: V1 offered back (an older page re-uploads it, no `ver`), B's fork point is its own push.
	const back = {}; back[F] = mani(k1, 'a1-again');
	B.C.merge(back, { [F]: k2 }, 'devB', 'devA', {});
	check('an older page\'s copy of a version ours was made from is not news: B keeps V2', B.C.index()[F].hash === k2, B.C.index()[F].hash.slice(0, 8));
	// A relayed copy of V1 from a device on this build (it carries V1's own ver).
	const relay = {}; relay[F] = Object.assign({}, m1, { chunks: [{ addr: 'a-relay', size: 10 }] });
	B.C.merge(relay, { [F]: k2 }, 'devB', 'devC', {});
	check('nor is a relayed copy of V1 from a device that never merged V2', B.C.index()[F].hash === k2);
	// An edit undone on A: content V1 again, made from V2 -- a new version, and newer.
	const sUndo = { ver: m2.ver, anc: m2.anc };
	const A2 = device(); await A2.C.ready();
	await A2.C.put(F, mani(k1, 'undo'), k1, { file: file('version one', 20), parent: sUndo });
	const mU = A2.C.index()[F];
	check('an edit undone to V1\'s bytes is a new version, made from V2', mU.ver !== m1.ver && A2.C.descends(mU, m2.ver), J({ ver: mU.ver, anc: mU.anc }));
	B.C.merge(A2.C.index(), { [F]: k2 }, 'devB', 'devA', {});
	check('and B takes it', B.C.index()[F].ver === mU.ver);
}

console.log('\nwhat the bytes are: one note per storage\n');
{
	const D = device(); await D.C.ready();
	const f1 = file('one', 1), k1 = await key(D.C, f1);
	await D.C.put(F, mani(k1, 'd1'), k1, { file: f1, timeless: true, folder: 'f:x', parent: null });
	const m = D.C.index()[F];
	const other = file('two', 2), k2 = await key(D.C, other);
	const newer = Object.assign(mani(k2, 'n'), { ver: 'abcdefabcdef', anc: [m.ver] });
	check('in the folder it was noted in, the old bytes are `stale` under a newer manifest',
		(await D.C.localState(F, file('one', 1), newer, { folder: 'f:x' })).state === 'stale');
	check('in another folder, with no note there, the same bytes are not claimed (`unknown`)',
		(await D.C.localState(F, file('one', 7), newer, { folder: 'f:y' })).state === 'unknown');
	check('in the sandbox, with no note, a merge\'s replaced manifest stands in (`base`)',
		(await D.C.localState(F, file('one', 7), newer, { base: m })).state === 'stale');
	check('[ctl] bytes that are neither are not stale (an edit of the version just noted)',
		(await D.C.localState(F, file('three', 7), newer, { base: m })).state === 'edit');
	await D.C.keepOurs(F, m, newer);
	const kept = D.C.index()[F];
	check('keepOurs files theirs beside ours, under a name of its own', kept.hash === k1 && D.C.index()[D.C.copyPath(F, newer)].key === k2
		&& !D.C.index()[F + '.synced']);
	check('and ours has seen theirs, not been made from it (`sn`)', (kept.sn || []).indexOf(D.C.verOf(newer)) >= 0
		&& (kept.sn || []).indexOf(D.C.verOf(m)) < 0, J({ sn: kept.sn }));
	check('and ours becomes a version that has seen both, so the device holding theirs takes it',
		D.C.descends(kept, D.C.verOf(newer)) && D.C.descends(kept, D.C.verOf(m)) && kept.ver !== m.ver, J({ ver: kept.ver, anc: kept.anc }));
	// CC2: a second conflict on the path never takes the first's place.
	const k3 = await key(D.C, file('four', 4));
	const newer2 = Object.assign(mani(k3, 'n2'), { ver: 'bcdefabcdefa', anc: [m.ver] });
	await D.C.keepOurs(F, null, newer2);
	check('a second conflict files its version under its own name, and the first stays named (CC2)',
		D.C.index()[D.C.copyPath(F, newer)].key === k2 && D.C.index()[D.C.copyPath(F, newer2)].key === k3);
	check('bytes a version only saw go only where the index names them elsewhere; bytes it was made from go',
		D.C.mayDrop(F, kept, D.C.verOf(newer), k2) === true
		&& D.C.mayDrop(F, { anc: ['aaaaaaaaaaaa'], sn: ['aaaaaaaaaaaa'] }, 'aaaaaaaaaaaa', 'named-nowhere') === false
		&& D.C.mayDrop(F, { anc: ['aaaaaaaaaaaa'] }, 'aaaaaaaaaaaa', 'named-nowhere') === true);
	check('an older build\'s manifest is named by its key\'s prefix, and is untrusted',
		D.C.verOf({ key: k2 }) === k2.slice(0, 12) && !D.C.trusted({ key: k2 }) && D.C.trusted(newer));
}

console.log('\n' + (failures ? failures + ' FAILED' : 'ALL PASS'));
process.exit(failures ? 1 : 0);
