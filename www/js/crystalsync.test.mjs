/* ============================================================
   Test -- a crystal changed on another device reaches the screen without
   taking what is being typed (D-20261006-07, QA B 2026-10-09 F-B1..F-B5).

   F-B1/F-B3. One stamp per Diamond (`touched`.`updated`.`crystal_version`). When
   it moves and the page on screen is the same page, the page is told so through
   `_rev` and re-reads its own files; nothing is remounted, so nothing typed is
   lost. When the page itself changed, it is remounted only once it is idle.
   F-B2. The Edit form and the memory panel save through one door, which merges
   per key against what the store holds now and names a both-sides change.
   F-B4. A render whose reads were overtaken by another view is dropped.
   F-B5. The memory panel is not replaced while it is open or holds typing.
   `node www/js/crystalsync.test.mjs`
   ============================================================ */

import { makeWindow, loadScript, sliceDaimond } from '../../dev/syncprobe.mjs';

let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 0));

// ── A small DOM, enough for the crystal body ─────────────────────
function el(tag) {
	const e = {
		tag, children: [], listeners: {}, attrs: {}, className: '', textContent: '', hidden: false,
		parentNode: null, open: false, value: '', defaultValue: '',
		appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); this.children.push(c); c.parentNode = this; return c; },
		insertBefore(c, ref) { const i = this.children.indexOf(ref); if (i < 0) return this.appendChild(c); this.children.splice(i, 0, c); c.parentNode = this; return c; },
		removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; },
		replaceChild(n, o) { const i = this.children.indexOf(o); if (i >= 0) { this.children[i] = n; n.parentNode = this; o.parentNode = null; } return o; },
		remove() { if (this.parentNode) this.parentNode.removeChild(this); },
		addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); },
		removeEventListener(t, f) { this.listeners[t] = (this.listeners[t] || []).filter((x) => x !== f); },
		fire(t) { for (const f of (this.listeners[t] || []).slice()) f({ target: this }); },
		setAttribute(k, v) { this.attrs[k] = v; },
		classList: { add() {}, remove() {}, contains() { return false; } },
		querySelector(sel) { return find(this, sel); },
		querySelectorAll(sel) { const out = []; walk(this, (n) => { if (matches(n, sel)) out.push(n); }); return out; },
		focus() {},
	};
	Object.defineProperty(e, 'innerHTML', { get() { return ''; }, set() { for (const c of e.children) c.parentNode = null; e.children = []; } });
	return e;
}
function matches(n, sel) {
	if (sel.charAt(0) === '.') return (' ' + (n.className || '') + ' ').indexOf(' ' + sel.slice(1) + ' ') >= 0;
	return n.tag === sel;
}
function walk(n, f) { for (const c of n.children) { f(c); walk(c, f); } }
function find(n, sel) { let hit = null; walk(n, (c) => { if (!hit && matches(c, sel)) hit = c; }); return hit; }
const doc = { createElement: el, querySelectorAll: () => [], getElementById: () => null, activeElement: null, documentElement: el('html') };
const win = makeWindow({ extra: { document: doc } });
loadScript(win, 'crystal.js');
const real = win.DaimondCrystal;

// ── merge3 ───────────────────────────────────────────────────────
if (typeof real.merge3 !== 'function') check('DaimondCrystal.merge3 exists', false);
else {
	const m1 = real.merge3({ a: 1, b: 1 }, { a: 2, b: 1 }, { a: 1, b: 3 });
	check('merge3 takes a key moved only here from mine and one moved only there from theirs',
		JSON.stringify(m1.merged) === '{"a":2,"b":3}' && m1.conflicts.length === 0, JSON.stringify(m1));
	const m2 = real.merge3({ a: 1 }, { a: 1, x: [1] }, { a: 1, y: { z: 1 } });
	check('merge3 keeps a key added on each side', real.canon(m2.merged) === real.canon({ a: 1, x: [1], y: { z: 1 } }), JSON.stringify(m2));
	const m3 = real.merge3({ a: 1, b: 2 }, { a: 1 }, { a: 1, b: 2 });
	check('merge3 honours a key deleted here', !('b' in m3.merged) && !m3.conflicts.length, JSON.stringify(m3));
	const m4 = real.merge3({ a: 1 }, { a: 2 }, { a: 3 });
	check('merge3 names a key moved on both sides to different values', m4.conflicts.length === 1 && m4.conflicts[0].key === 'a'
		&& m4.conflicts[0].mine === 2 && m4.conflicts[0].theirs === 3 && m4.merged.a === 2, JSON.stringify(m4));
	const m5 = real.merge3({ a: 1 }, { a: 2 }, { a: 3 }, 'theirs');
	check('merge3 resolves a conflict to the side preferred', m5.merged.a === 3 && m5.conflicts.length === 1, JSON.stringify(m5));
	const m6 = real.merge3({ s: { x: 1, y: 2 } }, { s: { y: 2, x: 1 } }, { s: { x: 1, y: 2 }, t: 1 });
	check('merge3 compares by canonical JSON, not key order', !m6.conflicts.length && m6.merged.t === 1, JSON.stringify(m6));
}

// ── The app's half ───────────────────────────────────────────────
const store = { data: '{"title":"First","n":1}', page: '<p>page</p>', writes: [], gate: null };
const diamond = { id: 'd1', name: 'Life log', touched: 1, updated: 1, crystal_version: 1 };
let busy = false;
const refreshed = [], mounted = [];
const C = Object.assign({}, real, {
	mount(body, opts) { mounted.push(opts); const w = el('div'); w.className = 'crystal-frame-wrap'; body.appendChild(w); },
	unmount() {}, refresh(data, rev) { refreshed.push({ data, rev }); return true; }, busy: () => busy,
});
win.DaimondCrystal = C;
const body = el('div');
const stubs = {
	t: (k) => k, tOr: (k, d) => d,
	currentDiamond: diamond,
	crystalBody: body,
	friendlyError: (e) => String((e && e.message) || e),
	diamondApp: () => ({
		read_crystal_data: async () => { if (store.gate) await store.gate; return store.data; },
		read_crystal_page: async () => store.page,
		write_crystal_data: async (id, text) => { store.writes.push(text); store.data = text; },
	}),
	cappUpdateInstance: async (id, page) => ({ page, kept: [], replaced: false }),
	cappOfferLegacy: () => Promise.resolve(false),
	crystalBar: () => { const b = el('div'); b.className = 'crystal-bar'; return b; },
	crystalMemoryPanel: (id, text) => { const b = el('details'); b.className = 'crystal-memory'; b.drawnFrom = text; return b; },
	renderCrystalControls() {}, renderArtefacts() {}, openCrystalLink() {}, readCrystalAsset() {},
	writeCrystalAsset() {}, resetCrystalPage() {}, cappKeptNote: () => el('div'),
	refreshDiamondAfterChange: async () => {},
	noticeDialog() {},
	setTimeout, clearTimeout,
};
let fns = null;
try {
	fns = sliceDaimond(win, ['renderCrystal', 'clearCrystalBody', 'crystalArrived', 'saveCrystalEdit'], stubs).fns;
} catch (e) { check('crystalArrived and saveCrystalEdit exist', false, e.message); }

if (fns) {
	const arrive = async (patch) => {
		Object.assign(store, patch || {});
		diamond.touched++;
		await fns.crystalArrived('d1');
		await tick(5);
	};
	await fns.renderCrystal();
	check('the first render mounts the page', mounted.length === 1, 'mounts=' + mounted.length);

	// (1) A data-only change: the page is told, not remounted.
	await arrive();
	check('F-B1: a change to the capp files only refreshes the mounted page', refreshed.length === 1 && mounted.length === 1,
		'refresh=' + refreshed.length + ' mounts=' + mounted.length);
	check('F-B1: and hands it the new stamp as its revision', refreshed.length === 1 && /^2\./.test(String(refreshed[0].rev)),
		JSON.stringify(refreshed[0] || null));

	// (2) crystal.json changed, same page: refreshed with the new data, the bar swapped, no remount.
	const oldBar = body.querySelector('.crystal-bar');
	await arrive({ data: '{"title":"Second","n":1}' });
	check('F-B1: a changed crystal.json is handed to the same page', refreshed.length === 2 && refreshed[1].data.title === 'Second'
		&& mounted.length === 1, 'refresh=' + refreshed.length + ' mounts=' + mounted.length);
	check('F-B1: and the bar above it is drawn again', body.querySelector('.crystal-bar') !== oldBar);
	check('F-B5: a closed, clean memory panel is drawn from the new text',
		(body.querySelector('.crystal-memory') || {}).drawnFrom === store.data);

	// (3) An open memory panel is not replaced, and is replaced on close only when clean.
	const mem = body.querySelector('.crystal-memory');
	mem.open = true;
	await arrive({ data: '{"title":"Third","n":1}' });
	check('F-B5: an open memory panel is not replaced', body.querySelector('.crystal-memory') === mem);
	const ta = el('textarea'); ta.className = 'crystal-memory-ta'; ta.value = 'typed'; ta.defaultValue = 'drawn';
	mem.appendChild(ta);
	mem.open = false; mem.fire('toggle');
	await tick(5);
	check('F-B5: nor, holding typing, when it is collapsed', body.querySelector('.crystal-memory') === mem && ta.value === 'typed');
	mem.removeChild(ta);

	// (4) The page changed: remounted only once the page is idle.
	busy = true;
	const before = mounted.length;
	await arrive({ page: '<p>page two</p>' });
	await tick(1300);
	check('F-B3: a changed page is not remounted while the page is busy', mounted.length === before, 'mounts=' + mounted.length);
	busy = false;
	await tick(1300);
	check('F-B3: and is remounted once it is idle', mounted.length === before + 1, 'mounts=' + mounted.length);

	// (5) The one save door.
	store.writes = [];
	store.data = '{"a":1,"b":2}';
	let r = await fns.saveCrystalEdit('d1', { a: 1, b: 1 }, { a: 2, b: 1 });
	check('F-B2: a save keeps a key another device moved meanwhile', store.writes.length === 1
		&& JSON.stringify(JSON.parse(store.writes[0])) === '{"a":2,"b":2}', JSON.stringify(store.writes));
	store.writes = [];
	store.data = '{"a":3}';
	r = await fns.saveCrystalEdit('d1', { a: 1 }, { a: 2 });
	check('F-B2: a key moved on both sides writes nothing and is named', store.writes.length === 0
		&& r && r.conflicts && r.conflicts.length === 1 && r.conflicts[0].key === 'a', JSON.stringify(r));
	r = await fns.saveCrystalEdit('d1', { a: 1 }, { a: 2 }, 'mine');
	check('F-B2: Keep mine writes mine', store.writes.length === 1 && JSON.parse(store.writes[0]).a === 2, JSON.stringify(store.writes));
	store.writes = [];
	store.data = '{"a":1}';
	await fns.saveCrystalEdit('d1', { a: 1 }, { a: 5 });
	check('F-B2: an unchanged store takes the edit as it is', store.writes.length === 1 && JSON.parse(store.writes[0]).a === 5);

	// (6) A render overtaken by another view is dropped.
	const m0 = mounted.length;
	let open; store.gate = new Promise((res) => { open = res; });
	const pend = fns.renderCrystal();
	await tick(1);
	fns.clearCrystalBody();
	const form = el('div'); form.className = 'crystal-form'; body.appendChild(form);
	open(); store.gate = null;
	await pend;
	check('F-B4: a render whose reads were overtaken paints nothing', mounted.length === m0 && body.children[0] === form,
		'mounts=' + (mounted.length - m0) + ' first=' + (body.children[0] && body.children[0].className));
}

if (failures) { console.log(failures + ' failed'); process.exit(1); }
console.log('crystalsync: all passed');
