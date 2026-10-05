// layers.test.mjs -- the layer stack, proved against a model of the browser's session history.
//
//	node --test www/js/layers.test.mjs
//
// The claim is about the platform's Back: from a drawer, sheet, menu, dialog,
// Admin drawer or palette it must close THAT layer and nothing else, and no
// sequence of openings and closings may leave history longer than the layers
// that are up. The browser is modelled, not mocked: a list of entries and an
// index, `pushState` truncating what lies ahead, and `go` a traversal that is
// QUEUED and lands later relative to wherever the index is then, as the
// platform does it. A test that called `go` synchronously would hide the race
// the stack's counting rule exists to survive.
//
// Zero dependencies; layers.js is a plain IIFE that assigns to `window`, so it
// is evaluated against one stand-in global per browser, the pattern
// dockdrag.test.mjs established.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC  = path.join(HERE, 'layers.js');

// A stand-in for the parts of the document the router reads: which element holds focus, and whether an element is
// on screen. `el(name, { shown, own })` makes one; `focus()` moves `activeElement` to it, as a real element does.
// `own` stands for an ancestor that carries `data-own-escape`, which `closest` answers for.
function dom() {
	const d = { body: null, activeElement: null, documentElement: { name: 'html' } };
	d.el = (name, o = {}) => {
		const e = { name, shown: o.shown !== false, isConnected: o.connected !== false, own: !!o.own, focus() { d.activeElement = e; },
			getClientRects() { return e.shown && e.isConnected ? [ {} ] : []; },
			closest(sel) { return sel === '[data-own-escape]' && e.own ? e : null; } };
		return e;
	};
	d.body = d.el('body');
	d.activeElement = d.body;
	return d;
}

// A session history. `entries` and `idx` outlive a reload, which is the point of `load`.
// `how` is when a traversal picks its target: 'land' (relative to the index when it lands) or 'call' (the entry it
// pointed at when `go` was called, which is what Chromium did in the 2026-10-05 world run: the target was fixed
// before a `pushState` in the next turn, and the traversal then landed on it).
//
// DOCUMENTS. Each entry belongs to the document that made it. A reload gives the entry the page stands on a NEW
// document and leaves the entries below on the old one, which is gone; a traversal onto an entry whose document is
// not the live one is a FULL PAGE LOAD (`b.loads`), as it is in Chromium and WebKit: the page boots again over the
// entry it landed on, the old page's listeners go, and no `popstate` reaches the new one. A model without documents
// cannot see a second boot, which is how a reload that walked back (the r533 fault, B-1) passed.
//
// FRAMES. `b.frame(k)` is k navigations made inside a frame: entries of the same history that share the page's own,
// so a traversal between them is no `popstate` for the page, and `history.length` counts them. `b.cap` is the
// platform's limit on entries, past which the oldest are dropped and the length stops growing.
function browser(how = 'land') {
	const b = { entries: [ { top: { state: null }, doc: 1 } ], idx: 0, queue: [], listeners: [], calls: [], left: false, doc: 1, docs: 1, loads: 0, cap: Infinity, L: null };
	b.history = {
		get state() { return b.entries[b.idx].top.state; },
		get length() { return b.entries.length; },
		pushState(s) {
			b.calls.push('push'); b.entries.length = b.idx + 1; b.entries.push({ top: { state: s }, doc: b.doc }); b.idx++;
			// The platform keeps only so many entries and drops the oldest, so the length stops growing.
			while (b.entries.length > b.cap) { b.entries.shift(); b.idx--; }
		},
		replaceState(s) { b.calls.push('replace'); b.entries[b.idx].top.state = s; },
		go(d) { b.calls.push('go' + d); b.queue.push(how === 'call' ? { entry: b.entries[b.idx + d], d } : d); },
	};
	// A navigation made INSIDE A FRAME. The frame's entries are entries of the same session history, and they share
	// the page's own entry (`top`): a traversal between them is no `popstate` for the page. A frame's navigation
	// clears what lay ahead, as any navigation does.
	b.frame = function (k = 1) {
		for (let i = 0; i < k; i++) {
			b.calls.push('frame'); b.entries.length = b.idx + 1;
			b.entries.push({ top: b.entries[b.idx].top, doc: b.doc, frame: true }); b.idx++;
			while (b.entries.length > b.cap) { b.entries.shift(); b.idx--; }
		}
	};
	// Evaluate layers.js as a page: new listeners, and `b.L` the stack it made.
	b.boot = function () {
		b.listeners = [];
		b.keys = [];
		b.dom = dom();
		const win = {
			history: b.history,
			document: b.dom,
			addEventListener(t, fn, cap) {
				if (t === 'popstate') b.listeners.push(fn);
				else if (t === 'keydown') b.keys.push({ fn, cap });
			},
		};
		new Function('window', fs.readFileSync(SRC, 'utf8'))(win);
		b.L = win.DaimondLayers;
		return b.L;
	};
	// A key press, as the window's capture listeners hear it. `target` is an element from `b.dom.el`.
	b.key = async function (key = 'Escape', o = {}) {
		const e = { key, isComposing: !!o.isComposing, target: o.target || b.dom.body, defaultPrevented: false, stopped: false,
			preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } };
		for (const k of b.keys) k.fn(e);
		await tick(); await b.land();
		return e;
	};
	// Land every queued traversal, each relative to the index at that moment.
	b.land = async function () {
		while (b.queue.length) {
			const q = b.queue.shift();
			const to = typeof q === 'object' ? (q.entry ? b.entries.indexOf(q.entry) : -1) : b.idx + q;
			if (typeof q === 'object' && !q.entry && b.idx + q.d < 0) { b.left = true; continue; }
			if (to < 0 && typeof q !== 'object') { b.left = true; continue; }
			if (to < 0) continue;
			if (to >= b.entries.length) continue;
			const from = b.entries[b.idx];
			b.idx = to;
			if (b.entries[to].doc !== b.doc) {
				// Another document's entry: the page is fetched again and boots over it.
				b.loads++; b.doc = ++b.docs; b.entries[to].doc = b.doc; b.boot();
			} else {
				// The page hears of a traversal only when it lands on another entry of ITS OWN: a frame's entries share the page's.
				if (b.entries[to].top !== from.top) for (const fn of b.listeners) fn({ state: b.entries[b.idx].top.state });
			}
			await Promise.resolve();
		}
	};
	// The person presses Back (or Forward, with +1).
	b.press = async function (d = -1) { b.queue.push(d); await b.land(); };
	// A fresh page over the same session history: a reload. The entry it stands on takes the new document.
	b.load = function () {
		b.doc = ++b.docs; b.entries[b.idx].doc = b.doc;
		return b.boot();
	};
	return b;
}
const tick = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

// A layer that records its closer being called, and reports itself closed as the app's closers do.
function layer(L, id, log) {
	L.open(id, () => { log.push(id); L.done(id); });
	return id;
}

test('opening a layer pushes exactly one history entry', async () => {
	const b = browser(), L = b.load();
	layer(L, 'drawer', []);
	await tick();
	assert.equal(b.idx, 1);
	assert.equal(b.entries.length, 2);
	assert.equal(L.depth(), 1);
});

test('opening the same layer twice is one layer and one entry', async () => {
	const b = browser(), L = b.load();
	layer(L, 'drawer', []); layer(L, 'drawer', []);
	await tick();
	assert.equal(L.depth(), 1);
	assert.equal(b.idx, 1);
});

test('Back closes the top layer only, then the next, then leaves the page', async () => {
	const b = browser(), L = b.load(), log = [];
	layer(L, 'sheet', log); layer(L, 'pop', log); layer(L, 'dialog#1', log);
	await tick();
	assert.equal(b.idx, 3);
	await b.press(); assert.deepEqual(log, ['dialog#1']); assert.equal(L.depth(), 2);
	await b.press(); assert.deepEqual(log, ['dialog#1', 'pop']);
	await b.press(); assert.deepEqual(log, ['dialog#1', 'pop', 'sheet']);
	assert.equal(L.depth(), 0);
	assert.equal(b.idx, 0, 'back at the entry the page began on');
	assert.equal(b.left, false, 'the page has not been left yet');
	await b.press();
	assert.equal(b.left, true, 'with no layer up, Back is the platform\'s again');
});

test('closing a layer by its own control pops its entry', async () => {
	const b = browser(), L = b.load();
	layer(L, 'drawer', []);
	await tick();
	L.done('drawer');
	await tick(); await b.land();
	assert.equal(b.idx, 0);
	assert.equal(L.depth(), 0);
	assert.equal(b.left, false);
});

test('a thousand opens and closes leave no dead entries behind', async () => {
	const b = browser(), L = b.load();
	for (let i = 0; i < 1000; i++) {
		layer(L, 'dialog#' + i, []);
		await tick();
		L.done('dialog#' + i);
		await tick(); await b.land();
	}
	assert.equal(b.idx, 0);
	assert.ok(b.entries.length <= 2, 'history holds ' + b.entries.length + ' entries after 1000 cycles');
});

test('closing a lower layer first keeps the upper one, and history still agrees', async () => {
	const b = browser(), L = b.load(), log = [];
	layer(L, 'drawer', log); layer(L, 'dialog#1', log);
	await tick();
	L.done('drawer');
	await tick(); await b.land();
	assert.equal(L.depth(), 1);
	assert.equal(b.idx, 1, 'one layer up, one entry deep');
	await b.press();
	assert.deepEqual(log, ['dialog#1']);
	assert.equal(b.idx, 0);
	assert.equal(b.left, false);
});

test('closing one layer and opening another in the same turn touches no history', async () => {
	const b = browser(), L = b.load();
	layer(L, 'pop', []);
	await tick();
	b.calls.length = 0;
	L.done('pop'); layer(L, 'pop#2', []);
	await tick(); await b.land();
	assert.deepEqual(b.calls, [], 'a menu swapped for another is no navigation');
	assert.equal(b.idx, 1);
});

test('two layers closed in one turn are one traversal, not two', async () => {
	const b = browser(), L = b.load();
	layer(L, 'admin', []); layer(L, 'dialog#1', []);
	await tick();
	b.calls.length = 0;
	L.done('dialog#1'); L.done('admin');
	await tick(); await b.land();
	assert.deepEqual(b.calls, ['go-2']);
	assert.equal(b.idx, 0);
	assert.equal(b.left, false);
});

test('a closer that closes more than its own layer takes the extra entry with it', async () => {
	const b = browser(), L = b.load();
	L.open('admin', () => L.done('admin'));
	L.open('admin-view', () => { L.done('admin-view'); L.done('admin'); });
	await tick();
	assert.equal(b.idx, 2);
	await b.press();
	assert.equal(L.depth(), 0);
	assert.equal(b.idx, 0);
	assert.equal(b.left, false);
});

test('Forward onto an entry no layer owns is undone', async () => {
	const b = browser(), L = b.load();
	layer(L, 'sheet', []);
	await tick();
	await b.press();
	assert.equal(b.idx, 0);
	await b.press(+1);
	assert.equal(L.depth(), 0);
	assert.equal(b.idx, 0);
});

test('a closer that throws does not wedge the stack', async () => {
	const b = browser(), L = b.load();
	L.open('bad', () => { throw new Error('gone'); });
	layer(L, 'good', []);
	await tick();
	await b.press();
	await b.press();
	assert.equal(L.depth(), 0);
	assert.equal(b.idx, 0);
});

test('a closer that opens a layer of its own leaves that layer up with an entry', async () => {
	const b = browser(), L = b.load();
	L.open('a', () => { L.done('a'); L.open('b', () => L.done('b')); });
	await tick();
	await b.press();
	assert.equal(L.depth(), 1);
	assert.equal(L.top(), 'b');
	assert.equal(b.idx, 1);
});

test('a reload on a layer\'s entry loads the page once, and lands on no stale layer', async () => {
	const b = browser(), L = b.load();
	layer(L, 'sheet', []); layer(L, 'dialog#1', []);
	await tick();
	assert.equal(b.idx, 2);
	b.calls.length = 0;
	const L2 = b.load();			// the page reloads: the entries below belong to a document that is gone
	await tick(); await b.land(); await tick(); await b.land();
	assert.equal(L2.depth(), 0);
	// A traversal from here would be a SECOND full load of the page, and whatever the person had typed into the
	// first boot (a passphrase at unlock) would be gone. So the page takes the entry it stands on as its start.
	assert.equal(b.loads, 0, 'the page was not loaded a second time');
	assert.deepEqual(b.calls, ['replace'], 'no traversal, no push: the entry stands as the start');
	assert.equal(b.idx, 2, 'still on the entry the reload kept');
	assert.equal(b.history.state && b.history.state.dlayers, 0, 'and it reads as depth nought');
});

test('a layer opened after a reload on a layer\'s entry works as on a fresh page', async () => {
	const b = browser(), L = b.load();
	layer(L, 'sheet', []);
	await tick();
	const L2 = b.load(), log = [];
	await tick(); await b.land();
	layer(L2, 'drawer', log);
	await tick();
	assert.equal(b.idx, 2, 'one entry above the start the reload made');
	assert.equal(b.history.state && b.history.state.dlayers, 1);
	await b.press();
	assert.deepEqual(log, ['drawer']);
	assert.equal(b.left, false);
	assert.equal(b.loads, 0, 'closing it by Back is no page load');
	assert.equal(b.idx, 1);
	assert.equal(L2.depth(), 0);
});

test('Back past a reloaded page boots the entries the old page left, each as the app at nought', async () => {
	const b = browser(), L = b.load();
	layer(L, 'sheet', []); layer(L, 'dialog#1', []);
	await tick();
	b.load(); await tick(); await b.land();
	await b.press();				// onto the old page's depth-1 entry: its document is gone, so the page loads
	await tick(); await b.land();
	assert.equal(b.loads, 1);
	assert.equal(b.L.depth(), 0, 'it boots with no layer up');
	assert.equal(b.history.state && b.history.state.dlayers, 0, 'and takes that entry as its start, so it does not walk');
	assert.equal(b.left, false);
	assert.deepEqual(b.calls.filter((c) => c.startsWith('go')), [], 'it issued no traversal of its own');
});

test('a traversal that never lands does not swallow the next Back', async () => {
	let t = 0;
	const b = browser(), L = b.load();
	L.clock = () => t;
	layer(L, 'a', []);
	await tick();
	// Take the entry away so the stack's own `go` has nowhere to land.
	b.history.go = (d) => { b.calls.push('lost' + d); };
	L.done('a');
	await tick();
	t += 10000;
	layer(L, 'b', []);
	await tick();
	const log = [];
	L.open('c', () => { log.push('c'); L.done('c'); });
	await tick();
	b.queue.push(-1);
	await b.land();
	assert.deepEqual(log, ['c'], 'the person\'s Back closed the top layer');
});

// FRAMES. A frame's navigations are entries in the same session history (r533 QA, B-2, foreign half). The Web sheet's
// frame holds a site nobody here wrote, which pushes an entry for every link followed, and those entries lie AFTER the
// sheet's own. The close used to take one entry off and land on one of the frame's: no `popstate` reached the page, and
// Back was dead. The stack counts the entries a layer's run holds, from `history.length`.
for (const how of [ 'land', 'call' ]) {
	test(`a sheet closed after a frame browsed above its entry lands on the page's start, and Back still works (${how})`, async () => {
		const b = browser(how), L = b.load(), log = [];
		layer(L, 'sheet', log);
		await tick();
		b.frame(3);									// three links followed in the frame
		assert.equal(b.idx, 4);
		L.done('sheet');							// the sheet's own x
		await tick(); await b.land(); await tick(); await b.land();
		assert.equal(b.idx, 0, 'back on the entry the page began on, past the frame\'s entries');
		assert.equal(b.left, false, 'and no further');
		assert.equal(L.depth(), 0);
		assert.equal(b.history.state, null, 'the page read the landing: its entry is the start\'s');
		// A drawer opened after it has an entry of its own, and ONE Back closes it.
		layer(L, 'drawer', log);
		await tick();
		assert.equal(b.idx, 1);
		await b.press();
		assert.deepEqual(log, [ 'drawer' ], 'one Back closed the drawer');
		assert.equal(b.idx, 0);
		assert.equal(b.left, false);
	});

	test(`a sheet closed after the frame went Back inside itself still lands on the start (${how})`, async () => {
		const b = browser(how), L = b.load();
		layer(L, 'sheet', []);
		await tick();
		b.frame(3);
		await b.press(); await b.press();			// the frame's own Back, twice: entries lie ahead now
		assert.equal(b.idx, 2);
		assert.equal(b.entries.length, 5);
		L.done('sheet');
		await tick(); await b.land(); await tick(); await b.land();
		assert.equal(b.idx, 0, 'the entries ahead of the frame\'s position were not counted as behind it');
		assert.equal(b.left, false);
		assert.equal(L.depth(), 0);
		layer(L, 'drawer', []);
		await tick();
		assert.equal(b.idx, 1);
		assert.equal(b.history.state.dlayers, 1);
	});

	test(`two layers closed in one turn over a browsed sheet are one traversal to the start (${how})`, async () => {
		const b = browser(how), L = b.load();
		layer(L, 'sheet', []);
		await tick();
		b.frame(2);
		layer(L, 'dialog', []);
		await tick();
		assert.equal(L.depth(), 2);
		L.done('dialog'); L.done('sheet');
		await tick(); await b.land(); await tick(); await b.land();
		assert.equal(b.idx, 0);
		assert.equal(b.left, false);
		assert.equal(L.depth(), 0);
	});
}

test('a dialog closed over a browsed sheet leaves the frame where it was, on the page it last showed', async () => {
	const b = browser(), L = b.load(), log = [];
	layer(L, 'sheet', log);
	await tick();
	b.frame(2);
	layer(L, 'dialog', log);
	await tick();
	assert.equal(b.idx, 4);
	L.done('dialog');
	await tick(); await b.land(); await tick(); await b.land();
	assert.equal(b.idx, 3, 'the frame\'s last entry, not the sheet\'s first');
	assert.equal(L.depth(), 1);
	assert.equal(b.history.state.dlayers, 1);
	// And the sheet is closed from there.
	L.done('sheet');
	await tick(); await b.land(); await tick(); await b.land();
	assert.equal(b.idx, 0);
	assert.equal(b.left, false);
});

test('the platform\'s Back inside a browsed sheet walks the frame first, then closes the sheet', async () => {
	const b = browser(), L = b.load(), log = [];
	layer(L, 'sheet', log);
	await tick();
	b.frame(2);
	await b.press(); await b.press();
	assert.deepEqual(log, [], 'the frame\'s Back is not the sheet\'s');
	assert.equal(L.depth(), 1);
	await b.press();
	assert.deepEqual(log, [ 'sheet' ], 'the Back past the sheet\'s own entry closes it');
	assert.equal(b.idx, 0);
	assert.equal(L.depth(), 0);
	await tick(); await b.land();
	assert.equal(b.left, false);
});

test('a history at its cap still gives one entry per layer, with no frame in it', async () => {
	// The length stops growing at the cap, so it cannot tell how many entries a layer added: the stack counts one.
	const b = browser(); b.cap = 4;
	const L = b.load();
	for (let i = 0; i < 3; i++) b.history.pushState({ older: i }, '');		// the page already stands deep in its tab's history
	layer(L, 'a', []); layer(L, 'b', []); layer(L, 'c', []);
	await tick();
	assert.equal(L.depth(), 3);
	const at = b.idx;
	L.done('c'); L.done('b'); L.done('a');
	await tick(); await b.land(); await tick(); await b.land();
	assert.equal(b.idx, at - 3, 'three layers, three entries');
	assert.equal(L.depth(), 0);
	assert.equal(b.left, false);
});

// One traversal at a time. The platform runs `go` later than it is called, so a layer opened in the meantime used to
// push an entry from a position the traversal was about to change: the history then sat one entry too shallow for the
// layers up, and the next close walked off the front of the app, to a blank page.
for (const how of [ 'land', 'call' ]) {
	test(`a layer opened while the last close's traversal is still in flight keeps history and layers in step (${how})`, async () => {
		const b = browser(how), L = b.load();
		layer(L, 'pop', []);
		await tick();
		L.done('pop');			// pointerdown outside the menu
		await tick();			// ... the traversal is queued, not landed
		layer(L, 'drawer', []);	// ... and the click that follows opens the drawer
		await tick();
		await b.land(); await tick(); await b.land();
		assert.equal(L.depth(), 1);
		assert.equal(b.idx, 1, 'one layer up, one entry deep');
		assert.equal(b.history.state && b.history.state.dlayers, 1, 'the entry we stand on is the drawer\'s');
		L.done('drawer');		// the drawer\'s own control
		await tick(); await b.land(); await tick(); await b.land();
		assert.equal(b.left, false, 'closing the drawer must not walk off the front of the app');
		assert.equal(b.idx, 0);
		assert.equal(L.depth(), 0);
	});
}

test('uid never repeats', () => {
	const b = browser(), L = b.load();
	const seen = new Set();
	for (let i = 0; i < 100; i++) seen.add(L.uid('dialog'));
	assert.equal(seen.size, 100);
});

// ── Where a floating layer may stand ───────────────────────────────────────

test('fit: a menu that fits where it was asked to stand is left alone', () => {
	const L = browser().load();
	const f = L.fit({ top: 100, height: 300, view: 800, inset: 20, gap: 8 });
	assert.deepEqual(f, { top: 100, max: null });
});

test('fit: a menu taller than the room below moves up until it fits', () => {
	const L = browser().load();
	const f = L.fit({ top: 300, height: 608, view: 845, inset: 0, gap: 8 });
	assert.equal(f.top, 845 - 8 - 608);
	assert.equal(f.max, null);
});

test('fit: a menu taller than the screen is held to the screen and scrolls inside itself', () => {
	const L = browser().load();
	const f = L.fit({ top: 300, height: 1400, view: 845, inset: 59, gap: 8 });
	assert.equal(f.top, 59 + 8, 'under the status bar, not behind it');
	assert.equal(f.max, 845 - (59 + 8) - 8);
});

test('fit: whatever the menu, its box lies inside the glass', () => {
	const L = browser().load();
	for (const view of [ 400, 664, 845 ]) for (const inset of [ 0, 24, 59 ]) for (const height of [ 50, 300, 700, 1600 ]) for (const top of [ 0, 60, 300, 700, 900 ]) {
		const f = L.fit({ top, height, view, inset, gap: 8 });
		const h = f.max === null ? height : Math.min(height, f.max);
		assert.ok(f.top >= inset + 8 || height < 1, `top ${f.top} under the bar (view ${view}, inset ${inset})`);
		assert.ok(f.top + h <= view - 8 + 0.001, `bottom ${f.top + h} off the glass (view ${view}, h ${height}, top ${top})`);
	}
});

// ── Escape: one router, innermost first (r533 QA B-3) ──────────────────────
//
// Escape used to be answered by every module for itself, so one press could close the Settings menu AND the sheet
// under it, and an Admin drawer along with the dialog over it, at a cost of an extra `go(-2)`. The stack now owns the
// key: one capture-phase listener on the window closes the top layer through its own closer, and what the stack
// does for Back it does for Escape, so the two cannot disagree about which surface is innermost.

test('the router listens on the window, in the capture phase', () => {
	const b = browser(); b.load();
	assert.equal(b.keys.length, 1);
	assert.equal(b.keys[0].cap, true, 'capture, so it runs before every capture listener on the document');
});

test('Escape closes only the top of two layers, and history goes back one entry', async () => {
	const b = browser(), L = b.load(), log = [];
	layer(L, 'sheet', log); layer(L, 'pop', log);
	await tick();
	assert.equal(b.idx, 2);
	const e = await b.key();
	assert.deepEqual(log, ['pop']);
	assert.equal(L.depth(), 1);
	assert.equal(L.top(), 'sheet');
	assert.equal(b.idx, 1, 'one layer up, one entry deep');
	assert.equal(b.left, false);
	assert.equal(e.defaultPrevented, true, 'the key is consumed, so nothing after it takes it a second time');
	assert.equal(e.stopped, false, 'but it is not stopped: record.js still hears the press');
});

test('Escape and Back agree: the same layer goes first whichever is pressed', async () => {
	for (const first of [ 'key', 'back' ]) {
		const b = browser(), L = b.load(), log = [];
		layer(L, 'drawer', log); layer(L, 'gallery', log);
		await tick();
		if (first === 'key') await b.key(); else await b.press();
		assert.deepEqual(log, ['gallery'], first);
		if (first === 'key') await b.press(); else await b.key();
		assert.deepEqual(log, ['gallery', 'drawer'], first);
		assert.equal(b.idx, 0, first);
		assert.equal(b.left, false, first);
	}
});

test('Escape closes a layer whose closer does not report itself done', async () => {
	const b = browser(), L = b.load();
	let closed = 0;
	L.open('menu', () => { closed++; });
	await tick();
	await b.key();
	assert.equal(closed, 1);
	assert.equal(L.depth(), 0, 'the router takes it off the stack itself');
	assert.equal(b.idx, 0);
});

test('a closer that throws still leaves the stack, and history settles', async () => {
	const b = browser(), L = b.load(), log = [];
	layer(L, 'sheet', log);
	L.open('bad', () => { throw new Error('closer failed'); });
	await tick();
	const e = await b.key();
	assert.equal(L.depth(), 1);
	assert.equal(L.top(), 'sheet');
	assert.equal(b.idx, 1);
	assert.equal(e.defaultPrevented, true);
	await b.key();
	assert.deepEqual(log, ['sheet']);
	assert.equal(b.idx, 0);
});

test('with no layer up, Escape is left alone', async () => {
	const b = browser(), L = b.load();
	const e = await b.key();
	assert.equal(e.defaultPrevented, false, 'a later listener (full screen) may still have it');
	assert.equal(L.depth(), 0);
	assert.deepEqual(b.calls, []);
});

test('keys other than Escape are none of its business', async () => {
	const b = browser(), L = b.load(), log = [];
	layer(L, 'sheet', log);
	await tick();
	for (const k of [ 'Enter', 'Tab', 'Esc', 'Backspace', 'a' ]) {
		const e = await b.key(k);
		assert.equal(e.defaultPrevented, false, k);
	}
	assert.deepEqual(log, []);
	assert.equal(L.depth(), 1);
});

test('an element that owns Escape as input is let through, and so is composition', async () => {
	const b = browser(), L = b.load(), log = [];
	layer(L, 'sheet', log);
	await tick();
	const term = b.dom.el('terminal-input', { own: true });
	const e1 = await b.key('Escape', { target: term });
	assert.equal(e1.defaultPrevented, false, 'the terminal sends the byte to its program');
	const e2 = await b.key('Escape', { isComposing: true });
	assert.equal(e2.defaultPrevented, false, 'Escape ends an input method\'s composition, it is not a close');
	assert.deepEqual(log, []);
	assert.equal(L.depth(), 1);
	assert.equal(b.idx, 1);
	// And the same layer closes for an ordinary target.
	await b.key('Escape', { target: b.dom.el('composer') });
	assert.deepEqual(log, ['sheet']);
});

test('a target with no selector engine does not break the router', async () => {
	const b = browser(), L = b.load(), log = [];
	layer(L, 'sheet', log);
	await tick();
	await b.key('Escape', { target: {} });
	assert.deepEqual(log, ['sheet']);
});

test('a claim is called before the top layer, and consumes the key', async () => {
	const b = browser(), L = b.load(), log = [], seen = [];
	layer(L, 'sheet', log);
	await tick();
	L.claim('drag', (e) => { seen.push(e.key); });
	const e = await b.key();
	assert.deepEqual(seen, ['Escape']);
	assert.deepEqual(log, [], 'the layer under a claim stays up');
	assert.equal(e.defaultPrevented, true);
	assert.equal(b.idx, 1, 'a claim has no history entry, and costs none');
	L.release('drag');
	await b.key();
	assert.deepEqual(log, ['sheet']);
});

test('a claim opens no history entry and releasing one touches none', async () => {
	const b = browser(), L = b.load();
	L.claim('skill', () => {});
	await tick();
	L.release('skill');
	await tick();
	assert.deepEqual(b.calls, []);
	assert.equal(L.depth(), 0);
});

test('the latest claim goes first; one that declines passes the key to the one before it, then to the layers', async () => {
	const b = browser(), L = b.load(), order = [], log = [];
	layer(L, 'sheet', log);
	await tick();
	L.claim('a', () => { order.push('a'); });
	L.claim('b', () => { order.push('b'); return false; });
	let e = await b.key();
	assert.deepEqual(order, ['b', 'a']);
	assert.equal(e.defaultPrevented, true);
	assert.deepEqual(log, []);
	L.release('a');
	order.length = 0;
	e = await b.key();
	assert.deepEqual(order, ['b']);
	assert.deepEqual(log, ['sheet'], 'every claim declined, so the layer takes it');
});

test('a claim that throws does not hold the layers hostage', async () => {
	const b = browser(), L = b.load(), log = [];
	layer(L, 'sheet', log);
	await tick();
	L.claim('broken', () => { throw new Error('claim failed'); });
	await b.key();
	assert.deepEqual(log, ['sheet']);
});

test('claiming again under the same name replaces the claim and does not stack two', async () => {
	const b = browser(), L = b.load(), order = [];
	L.claim('x', () => { order.push('old'); });
	L.claim('x', () => { order.push('new'); });
	await b.key();
	assert.deepEqual(order, ['new']);
	L.release('x');
	const e = await b.key();
	assert.equal(e.defaultPrevented, false, 'nothing left to take it');
});

test('a claim declines while a layer that opened over it is up, and holds again when that layer has gone', async () => {
	const b = browser(), L = b.load(), log = [], took = [];
	L.claim('mode', () => { took.push('mode'); }, () => true);
	layer(L, 'dialog#1', log);
	await tick();
	const e = await b.key();
	assert.deepEqual(took, [], 'the dialog opened over the mode, so the mode is not asked');
	assert.deepEqual(log, ['dialog#1'], 'the topmost layer takes the key');
	assert.equal(e.defaultPrevented, true);
	await b.key();
	assert.deepEqual(took, ['mode'], 'with nothing over it the claim has the key again');
	assert.deepEqual(log, ['dialog#1']);
});

test('a claim holds the key while nothing opened above it, whatever is under it', async () => {
	const b = browser(), L = b.load(), log = [], took = [];
	layer(L, 'sheet', log);
	await tick();
	// The mode begins inside the sheet, after it: nothing is above the claim.
	L.claim('mode', () => { took.push('mode'); }, () => true);
	await b.key();
	assert.deepEqual(took, ['mode']);
	assert.deepEqual(log, [], 'the sheet under the mode stays up');
});

test('a claim that was idle when a layer opened is not under it, and a claim made afterwards is above it', async () => {
	const b = browser(), L = b.load(), log = [], took = [];
	let live = false;
	L.claim('idle', () => { took.push('idle'); }, () => live);
	layer(L, 'sheet', log);
	await tick();
	live = true;
	await b.key();
	assert.deepEqual(took, ['idle'], 'nothing it was live under is up');
	took.length = 0;
	live = true;
	L.claim('idle', () => { took.push('again'); }, () => live);
	layer(L, 'dialog#1', log);
	L.claim('idle', () => { took.push('later'); }, () => live);
	await tick();
	await b.key();
	assert.deepEqual(took, ['later'], 'claiming again puts the claim above every layer up');
});

test('a claim with no liveness test answers for itself and is never put under a layer', async () => {
	const b = browser(), L = b.load(), log = [], took = [];
	L.claim('self', () => { took.push('self'); });
	layer(L, 'dialog#1', log);
	await tick();
	await b.key();
	assert.deepEqual(took, ['self']);
	assert.deepEqual(log, []);
});

test('a throwing liveness test is no claim on the key', async () => {
	const b = browser(), L = b.load(), log = [], took = [];
	L.claim('odd', () => { took.push('odd'); }, () => { throw new Error('gone'); });
	layer(L, 'dialog#1', log);
	await tick();
	await b.key();
	assert.deepEqual(took, ['odd'], 'a test that fails leaves the claim as it was');
});

test('Escape over a dialog whose closer opens the next one is no navigation at all', async () => {
	const b = browser(), L = b.load();
	L.open('dialog#1', () => { L.done('dialog#1'); L.open('dialog#2', () => L.done('dialog#2')); });
	await tick();
	b.calls.length = 0;
	await b.key();
	assert.equal(L.top(), 'dialog#2');
	assert.deepEqual(b.calls, [], 'a dialog answered by the next is the same turn');
	assert.equal(b.idx, 1);
});

test('Escape in a world with a frame\'s entries still goes back to the last entry of the layers that remain', async () => {
	const b = browser(), L = b.load(), log = [];
	layer(L, 'drawer', log); layer(L, 'sheet', log);
	await tick();
	b.frame(2);
	await b.key();
	assert.deepEqual(log, ['sheet']);
	assert.equal(L.depth(), 1);
	await b.press();
	assert.deepEqual(log, ['sheet', 'drawer'], 'Back still reaches the drawer');
	assert.equal(b.left, false);
});

// FOCUS. A layer remembers what had the keyboard when it went up, and the router gives it back when the key closed
// the layer and the keyboard has nowhere else to be.

test('focus returns to the opener when it is stranded on the body', async () => {
	const b = browser(), L = b.load();
	const btn = b.dom.el('settings-button'), row = b.dom.el('row');
	btn.focus();
	L.open('pop', () => { row.shown = false; });
	row.focus();
	await tick();
	await b.key();
	assert.equal(b.dom.activeElement, btn);
});

test('focus returns to the opener when it was inside the surface that has just gone', async () => {
	const b = browser(), L = b.load();
	const btn = b.dom.el('opener'), inner = b.dom.el('inner');
	btn.focus();
	L.open('dialog#1', () => { inner.shown = false; L.done('dialog#1'); });
	inner.focus();
	await tick();
	await b.key();
	assert.equal(b.dom.activeElement, btn, 'not left on a control nobody can see');
});

test('focus is left alone when it is already somewhere on screen, or the closer put it there', async () => {
	const b = browser(), L = b.load();
	const btn = b.dom.el('opener'), other = b.dom.el('somewhere-else'), next = b.dom.el('next-dialog-button');
	btn.focus();
	L.open('a', () => {});
	other.focus();
	await tick();
	await b.key();
	assert.equal(b.dom.activeElement, other, 'focus on a visible control elsewhere is the person\'s');
	btn.focus();
	L.open('b', () => { next.focus(); });
	await tick();
	await b.key();
	assert.equal(b.dom.activeElement, next, 'a closer that places focus keeps the say');
});

test('focus is not sent to an opener that is gone or hidden', async () => {
	const b = browser(), L = b.load();
	const gone = b.dom.el('gone', { connected: false }), hid = b.dom.el('hidden', { shown: false });
	gone.focus();
	L.open('a', () => {});
	await tick();
	b.dom.body.focus();
	await b.key();
	assert.equal(b.dom.activeElement, b.dom.body, 'a disconnected opener');
	hid.focus();
	L.open('b', () => {});
	await tick();
	b.dom.body.focus();
	await b.key();
	assert.equal(b.dom.activeElement, b.dom.body, 'a hidden opener');
});

test('a layer opened with nothing focused has no opener to give back', async () => {
	const b = browser(), L = b.load();
	const stray = b.dom.el('stray');
	L.open('a', () => {});
	await tick();
	stray.shown = false;
	stray.focus();
	await b.key();
	assert.equal(b.dom.activeElement, stray, 'nowhere to send it');
});

test('a layer can be given its opener, and keeps the first one when opened again', async () => {
	const b = browser(), L = b.load();
	const burger = b.dom.el('burger'), first = b.dom.el('first'), second = b.dom.el('second');
	first.focus();
	L.open('drawer', () => {}, burger);
	second.focus();
	L.open('drawer', () => {});
	await tick();
	second.shown = false;
	await b.key();
	assert.equal(b.dom.activeElement, burger, 'the given opener, not the element focused at either opening');
	first.focus();
	L.open('menu', () => {});
	second.shown = true;
	second.focus();
	L.open('menu', () => {});
	first.shown = true;
	await tick();
	second.shown = false;
	await b.key();
	assert.equal(b.dom.activeElement, first, 'opening a layer already up keeps what it first remembered');
});

test('Back does not move the focus: only the key does', async () => {
	const b = browser(), L = b.load();
	const btn = b.dom.el('opener'), inner = b.dom.el('inner');
	btn.focus();
	L.open('dialog#1', () => { inner.shown = false; L.done('dialog#1'); });
	inner.focus();
	await tick();
	await b.press();
	assert.equal(b.dom.activeElement, inner, 'the stack does not reach into the page on a popstate');
});
