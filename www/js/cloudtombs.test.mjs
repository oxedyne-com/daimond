/* ============================================================
   Test -- the chunk index across tabs, and its deletions (cloud.js).
   ------------------------------------------------------------
   Drives the REAL www/js/cloud.js in simulated tabs of one device,
   over one shared in-memory store standing in for IndexedDB
   (durable.js's `update` is one transaction) and one
   BroadcastChannel.

   SIM-24. Each tab wrote the index WHOLE from its own copy, so the
   tab that wrote last erased a sibling's manifest; a tab that died
   before announcing its write lost it for good. Asserted: a write
   carries only its own paths, joined into the stored index; a tab
   reads a sibling's write from the announcement or, for a tab that
   died first, from `refresh`.

   fix/r52-del. A large file deleted on one device never deleted on
   another: absence from an index is not news. Asserted: the person's
   delete (`remove`) records a stamped tombstone; a parcel's copy of
   the deleted content is not adopted, a CHANGED copy is (an edit
   beats a delete); a manifest here of the deleted content is listed
   for deletion; a later upload brings the path back (add-wins); the
   join keeps the later stamp and is a fixed point.

   Run:   node www/js/cloudtombs.test.mjs
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
const tick = () => new Promise((r) => setTimeout(r, 5));
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

// The stamp rule, as stamp.js and the core give it (`next`, `beats`, `ms`, `canon`).
const Stamp = {
	ms: (v) => { const n = Number(v); return (isFinite(n) && n > 0) ? Math.floor(n) : 0; },
	canon: (v) => JSON.stringify(v, (k, x) => (!x || typeof x !== 'object' || Array.isArray(x)) ? x
		: Object.keys(x).sort().reduce((o, key) => { o[key] = x[key]; return o; }, {})),
	next: (prev) => Math.max(Date.now(), Stamp.ms(prev) + 1),
	beats: (at, v, heldAt, held) => { const a = Stamp.ms(at), b = Stamp.ms(heldAt); return a !== b ? a > b : Stamp.canon(v) > Stamp.canon(held); },
};

/// One device: a store its tabs share, and a channel between them.
function device() {
	const kv = new Map(), subs = new Set();
	const Durable = {
		ready: async () => {}, durable: () => true, migrate: async () => true,
		get: async (k) => clone(kv.has(k) ? kv.get(k) : null),
		set: async (k, v) => { kv.set(k, clone(v)); return true; },
		update: async (k, fn) => { const v = fn(clone(kv.has(k) ? kv.get(k) : null)); kv.set(k, clone(v)); return { ok: true, value: v }; },
	};
	class Channel {
		constructor() { this.onmessage = null; this.open = true; subs.add(this); }
		postMessage(data) {
			if (this.mute) return;
			for (const c of subs) if (c !== this && c.open) setTimeout(() => c.onmessage && c.onmessage({ data: clone(data) }), 0);
		}
		close() { this.open = false; subs.delete(this); }
	}
	return { kv, Durable, Channel };
}

/// One tab of `dev` holding cloud.js.
function tab(dev) {
	const box = new Map();
	const ls = { getItem: (k) => (box.has(k) ? box.get(k) : null), setItem: (k, v) => box.set(k, String(v)), removeItem: (k) => box.delete(k) };
	const win = { addEventListener: () => {}, dispatchEvent: () => true, DaimondDurable: dev.Durable, DaimondStamp: Stamp };
	loadStore(win, ls);
	let chan = null;
	class Ch extends dev.Channel { constructor(n) { super(n); chan = this; } }
	win.BroadcastChannel = Ch;				// the window's own, as a browser's is
	const body = readFileSync(join(HERE, 'cloud.js'), 'utf8');
	const fn = new Function('window', 'localStorage', 'navigator', 'setTimeout', 'clearTimeout', 'console', 'CustomEvent', 'BroadcastChannel',
		'with (window) {\n' + body + '\n}');
	fn(win, ls, { storage: {} }, setTimeout, clearTimeout, { log: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
		class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } }, Ch);
	return { C: win.DaimondCloud, win, die: () => { if (chan) { chan.mute = true; chan.close(); } } };
}
const mani = (tag) => ({ v: 2, size: 10, key: 'k-' + tag, chunks: [{ addr: 'a-' + tag, size: 10 }] });
const FILE = { file: { size: 10, lastModified: 1 } };

// ── SIM-24: one device, three tabs ─────────────────────────────
console.log('\nSIM-24: a tab\'s index write survives its siblings\n');
{
	const dev = device();
	const t1 = tab(dev), t2 = tab(dev), t3 = tab(dev);
	await t1.C.ready(); await t2.C.ready(); await t3.C.ready();
	t2.die();									// it will not live to announce
	await t2.C.put('a/two.bin', mani('two'), 'h-two', FILE);
	await t2.C.settle();
	await t1.C.put('a/one.bin', mani('one'), 'h-one', FILE);
	await t1.C.settle();
	const stored = dev.kv.get('daimond-cloud-index') || {};
	check('the store holds both tabs\' manifests: a write carries only its own path', !!stored['a/one.bin'] && !!stored['a/two.bin'],
		JSON.stringify(Object.keys(stored)));
	check('the writing tab\'s own commit brings the dead tab\'s write into its copy', !!t1.C.index()['a/two.bin'],
		JSON.stringify(Object.keys(t1.C.index())));
	const t4 = tab(dev);
	t4.C.index();								// a tab loaded before the writes, which wrote nothing
	check('[ctl] a tab that wrote nothing and heard nothing does not name it yet', !t4.C.index()['a/two.bin']);
	await t4.C.refresh();
	check('after `refresh`, it does, so its next parcel carries it', !!t4.C.index()['a/two.bin'], JSON.stringify(Object.keys(t4.C.index())));
	await t3.C.put('a/three.bin', mani('three'), 'h-three', FILE);
	await t3.C.settle();
	await tick();
	check('a live sibling\'s write reaches this tab by its announcement', !!t1.C.index()['a/three.bin'], JSON.stringify(Object.keys(t1.C.index())));
	check('the index is durable once written', t1.C.indexDurable() && t3.C.indexDurable());
}

// ── Deletions of index paths ────────────────────────────────────
console.log('\nfix/r52-del: a large file\'s deletion travels\n');
{
	const devA = device(), devB = device();
	const A = tab(devA), B = tab(devB);
	await A.C.ready(); await B.C.ready();
	for (const t of [A, B]) {
		await t.C.put('big/gone.bin', mani('gone'), 'h-gone', FILE);
		await t.C.put('big/kept.bin', mani('kept'), 'h-kept', FILE);
		await t.C.put('big/edit.bin', mani('edit'), 'h-edit', FILE);
	}
	// A deletes two; B edits one of them before hearing.
	A.C.remove('big/gone.bin');
	A.C.remove('big/edit.bin');
	await A.C.settle();
	const ta = A.C.tombs();
	check('the person\'s delete records a stamped tombstone at the content it held',
		ta['big/gone.bin'] && ta['big/gone.bin'].d === 1 && ta['big/gone.bin'].h === 'h-gone' && ta['big/gone.bin'].s > 0, JSON.stringify(ta));
	check('and the index no longer names it', !A.C.index()['big/gone.bin']);
	await B.C.put('big/edit.bin', mani('edit2'), 'h-edit2', FILE);

	// B pulls A's parcel.
	const bIx = () => Object.keys(B.C.index()).sort();
	B.C.merge(A.C.index(), {}, 'devB', 'devA', A.C.tombs());
	check('B keeps its manifest of the deleted content until its bytes are dealt with, and lists it',
		bIx().includes('big/gone.bin') && B.C.honourList().includes('big/gone.bin'), JSON.stringify(bIx()));
	check('B\'s file edited since the deletion is not listed (an edit beats a delete)', !B.C.honourList().includes('big/edit.bin'));
	B.C.forget('big/gone.bin');				// what honourChunkTombs does for a path not held
	await B.C.settle();

	// A pulls B's parcel: B's edit comes back to A, the deleted content does not.
	A.C.merge(B.C.index(), {}, 'devA', 'devB', B.C.tombs());
	const aIx = Object.keys(A.C.index()).sort();
	check('A does not adopt a copy of the content it deleted', !aIx.includes('big/gone.bin'), JSON.stringify(aIx));
	check('A adopts B\'s CHANGED copy of a path it deleted', aIx.includes('big/edit.bin') && A.C.index()['big/edit.bin'].hash === 'h-edit2', JSON.stringify(aIx));
	check('a path deleted nowhere stands', aIx.includes('big/kept.bin'));

	// A third device that pulls only B's parcel still hears of the deletion: B relays it.
	const devC = device(), Cx = tab(devC);
	await Cx.C.ready();
	await Cx.C.put('big/gone.bin', mani('gone'), 'h-gone', FILE);
	Cx.C.merge(B.C.index(), {}, 'devC', 'devB', B.C.tombs());
	check('a device that never pulled the deleter\'s parcel hears of it from the relaying one',
		Cx.C.honourList().includes('big/gone.bin'), JSON.stringify(Cx.C.tombs()));

	// Written again: the path comes back.
	const deadAt = A.C.tombs()['big/gone.bin'].s;
	await A.C.put('big/gone.bin', mani('gone-again'), 'h-gone', FILE);
	const back = A.C.tombs()['big/gone.bin'];
	check('an upload after the deletion writes the path back, stamped past it (add-wins)', back.d === 0 && back.s > deadAt, JSON.stringify(back));
	B.C.merge(A.C.index(), {}, 'devB', 'devA', A.C.tombs());
	check('and the other device adopts it again', !!B.C.index()['big/gone.bin'] && B.C.tombs()['big/gone.bin'].d === 0);

	// The join: later stamp wins, an older one moves nothing, and it is a fixed point.
	const before = JSON.stringify(B.C.tombs());
	const older = {}; older['big/gone.bin'] = { d: 1, h: 'h-gone', s: deadAt };
	check('an older tombstone moves nothing', B.C.joinTombs(older) === 0 && JSON.stringify(B.C.tombs()) === before);
	check('joining what is held changes nothing (a fixed point)', B.C.joinTombs(B.C.tombs()) === 0 && JSON.stringify(B.C.tombs()) === before);
	check('the parcel\'s tombstones are in path order', JSON.stringify(Object.keys(B.C.tombs())) === JSON.stringify(Object.keys(B.C.tombs()).sort()));
	check('a maintenance drop (`forget`) records no tombstone', (() => { A.C.forget('big/kept.bin'); return !A.C.tombs()['big/kept.bin']; })());
}

console.log('\n' + (failures ? failures + ' FAILED' : 'ALL PASS'));
process.exit(failures ? 1 : 0);
