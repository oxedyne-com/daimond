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

// ── One set for every workspace path (fix/r53-faultb3) ──────────
console.log('\nfix/r53-faultb3: inline files\' deletions in the same set, relayed, returned, and the floor\n');
{
	const devT = device(), devQ = device(), devP = device();
	const T = tab(devT), Q = tab(devQ), P = tab(devP);
	await T.C.ready(); await Q.C.ready(); await P.C.ready();
	// T deletes an inline file (the inline fingerprint, `<base36>:<len>`) and one more.
	const w = T.C.mark([{ path: 'r/x.md', d: 1, h: '1a2b3c:12' }, { path: 'r/z.md', d: 1, h: '9zz:3' }]);
	await T.C.settle();
	check('`mark` writes a batch, each stamped past the one before it',
		w['r/x.md'] > 0 && w['r/z.md'] > w['r/x.md'], JSON.stringify(w));
	check('`recordOf` reads it back', JSON.stringify(T.C.recordOf('r/x.md')) === JSON.stringify({ d: 1, h: '1a2b3c:12', s: w['r/x.md'] }));
	check('the record is durable in the store', !!(devT.kv.get('daimond-cloud-tombs') || {})['r/x.md']);
	check('a content key cannot be marked', Object.keys(T.C.mark([{ path: '@c/chat1', d: 1, h: 'k' }])).length === 0 && !T.C.recordOf('@c/chat1'));
	// QFB2-3: Q hears it from T and relays it; P hears it from Q alone.
	Q.C.joinTombs(T.C.tombs());
	P.C.joinTombs(Q.C.tombs());
	check('a device that reads only the relaying device\'s parcel holds the inline deletion',
		P.C.deadAt('r/x.md') === '1a2b3c:12', JSON.stringify(P.C.tombs()));
	check('and lists it once for the honour step, as a fresh deletion', P.C.honourList().includes('r/x.md'));
	// An inline fingerprint is never taken for a manifest's content key.
	await P.C.put('r/big.bin', mani('big'), 'h-big', FILE);
	P.C.joinTombs({ 'r/big.bin': { d: 1, h: 'h-big-inline:10', s: Date.now() + 5 } });
	P.C.merge({ 'r/big.bin': { ...mani('big'), hash: 'h-big' } }, {}, 'devP', 'devQ', {});
	check('a manifest is not taken for the bytes an inline-form record names', !!P.C.index()['r/big.bin']);
	// QFB2-1: a return, stamped past the deletion, overrules it everywhere.
	const dead = P.C.recordOf('r/x.md').s;
	const r = P.C.mark([{ path: 'r/x.md', d: 0 }]);
	check('a return is stamped past the deletion it overrules', r['r/x.md'] > dead && P.C.recordOf('r/x.md').d === 0 && P.C.recordOf('r/x.md').h === '');
	Q.C.joinTombs(P.C.tombs());
	T.C.joinTombs(Q.C.tombs());
	check('the return reaches the deleter through the relay', T.C.recordOf('r/x.md').d === 0);
	check('a stale copy of the deletion, relayed late, moves nothing', T.C.joinTombs({ 'r/x.md': { d: 1, h: '1a2b3c:12', s: dead } }) === 0
		&& T.C.recordOf('r/x.md').d === 0);
}
{
	// The floor: past the bound the oldest go, and a record at or under the highest stamp
	// trimmed is no news for a path this device holds nothing for.
	const dev = device(), A = tab(dev);
	await A.C.ready();
	const list = [];
	for (let i = 0; i < 2010; i++) list.push({ path: 'cap/c' + String(i).padStart(5, '0') + '.md', d: 1, h: 'h' + i + ':1' });
	const st = A.C.mark(list);
	await A.C.settle();
	const held = Object.keys(A.C.tombs());
	check('the set is bounded at 2000, newest kept', held.length === 2000 && !held.includes('cap/c00000.md') && held.includes('cap/c02009.md'), held.length);
	const trimmedTop = st['cap/c00009.md'];
	check('a trimmed deletion relayed back at its old stamp is no news', A.C.joinTombs({ 'cap/c00005.md': { d: 1, h: 'h5:1', s: st['cap/c00005.md'] } }) === 0
		&& !A.C.recordOf('cap/c00005.md'));
	check('[ctl] nor is a return at such a stamp', A.C.joinTombs({ 'cap/c00001.md': { d: 0, h: '', s: trimmedTop } }) === 0);
	check('a record past the floor is news', A.C.joinTombs({ 'cap/new.md': { d: 1, h: 'hn:1', s: st['cap/c02009.md'] + 10 } }) === 1);
	check('[ctl] a later record for a path held is joined as ever', A.C.joinTombs({ 'cap/c02009.md': { d: 0, h: '', s: st['cap/c02009.md'] + 11 } }) === 1);
}

console.log('\n' + (failures ? failures + ' FAILED' : 'ALL PASS'));
process.exit(failures ? 1 : 0);
