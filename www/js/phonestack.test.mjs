/* ============================================================
   Test — the phone's page stack contract (Stack A0, D-20261029-01).
   ------------------------------------------------------------
   `DaimondStack` (www/js/page/phone_stack.js) is the navigation stack the phone
   shell is built on: `push(name, opts)`, `pop()`, `top()`, `on(name, mount)`.
   A0 lands the contract only, with no history and no caller, so this drives the
   REAL module against a minimal document stub (Node has no DOM):

     (a) push/pop/top keep stack order, and the root page is never popped;
     (b) a page's `mount` runs once, on its first push, however often it is shown;
     (c) only the top page is shown, every other page is hidden;
     (d) pushing a page already on the stack returns to it, never a second copy;
     (e) pushing a page no one registered is refused, naming it;
     (f) nothing is drawn until the first push (no visible change at any width).
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// The one history mover (js/history.js), a classic script: put on a stub window as the page does.
const HISTORY = fs.readFileSync(new URL('./history.js', import.meta.url), 'utf8');
function mover(win) { new Function('window', HISTORY)(win); return win; }

// The least of a DOM the module touches: elements with children, `hidden`,
// `dataset`, `className`, and the shell's `#app` to hold the host.
function makeDocument() {
	const byId = new Map();
	const el = (tag) => ({
		tagName: tag.toUpperCase(), id: '', className: '', hidden: false, dataset: {}, children: [],
		appendChild(c) { this.children.push(c); if (c.id) byId.set(c.id, c); return c; },
		setAttribute(k, v) { if (k === 'id') { this.id = v; byId.set(v, this); } },
	});
	const body = el('body');
	const app = body.appendChild(Object.assign(el('div'), { id: 'app' }));
	byId.set('app', app);
	return {
		body,
		app,
		createElement: el,
		getElementById: (id) => byId.get(id) || null,
	};
}

globalThis.document = makeDocument();
const { DaimondStack, newStack } = await import('./page/phone_stack.js');

function fresh() {
	globalThis.document = makeDocument();
	return newStack();
}

test('the module exports the one page stack and its factory', () => {
	for (const k of ['push', 'pop', 'top', 'on']) assert.equal(typeof DaimondStack[k], 'function', k);
	assert.equal(typeof newStack, 'function');
});

test('(a) push, pop and top keep stack order; the root stays', () => {
	const s = fresh();
	for (const n of ['home', 'diamond', 'turn']) s.on(n, () => {});
	assert.equal(s.top(), null);
	s.push('home');
	s.push('diamond', { id: 'd1' });
	s.push('turn');
	assert.equal(s.top(), 'turn');
	assert.equal(s.pop(), 'turn');
	assert.equal(s.top(), 'diamond');
	assert.equal(s.pop(), 'diamond');
	assert.equal(s.top(), 'home');
	assert.equal(s.pop(), null, 'the root page is not popped');
	assert.equal(s.top(), 'home');
});

test('(b) mount runs once per page, on its first push, with its opts', () => {
	const s = fresh();
	const seen = [];
	s.on('home', () => {});
	s.on('diamond', (el, opts) => { seen.push(opts && opts.id); el.dataset.mounted = 'y'; });
	s.push('home');
	assert.deepEqual(seen, [], 'not mounted before it is pushed');
	s.push('diamond', { id: 'd1' });
	s.pop();
	s.push('diamond', { id: 'd2' });
	s.pop();
	s.push('diamond', { id: 'd3' });
	assert.deepEqual(seen, ['d1'], 'mounted exactly once');
});

test('(c) only the top page is shown', () => {
	const s = fresh();
	const els = {};
	for (const n of ['home', 'settings']) s.on(n, (el) => { els[n] = el; });
	s.push('home');
	s.push('settings');
	assert.equal(els.home.hidden, true);
	assert.equal(els.settings.hidden, false);
	assert.equal(els.settings.dataset.page, 'settings');
	s.pop();
	assert.equal(els.home.hidden, false);
	assert.equal(els.settings.hidden, true);
});

test('(d) pushing a page already on the stack returns to it', () => {
	const s = fresh();
	let mounts = 0;
	s.on('home', () => { mounts++; });
	s.on('diamond', () => {});
	s.on('turn', () => {});
	s.push('home');
	s.push('diamond');
	s.push('turn');
	s.push('home');
	assert.equal(s.top(), 'home');
	assert.equal(s.pop(), null, 'diamond and turn were let go');
	assert.equal(mounts, 1);
	s.push('home');
	assert.equal(s.top(), 'home');
	assert.equal(s.pop(), null, 'no second copy of the top page');
});

test('(e) an unregistered page is refused by name', () => {
	const s = fresh();
	assert.throws(() => s.push('nowhere'), /nowhere/);
	assert.throws(() => s.on('x', 'not a function'), /x/);
	assert.equal(s.top(), null);
});

test('(f) nothing is drawn until the first push, and then inside #app, never on the body', () => {
	const s = fresh();
	s.on('home', () => {});
	assert.equal(document.app.children.length, 0);
	s.push('home');
	assert.equal(document.app.children.length, 1);
	assert.equal(document.app.children[0].id, 'phone-stack');
	assert.equal(document.body.children.length, 1, 'only #app on the body (MENUGATE)');
});

// ── Stack A2: history, reload, the edge swipe ─────────────────────────────────
// A window stub with a real session history: entries, an index, `pushState`,
// `replaceState`, `go`/`back` that fire `popstate` with the entry's state (at
// once, where a browser queues it; the module must not care which), and the two
// standalone signals mobile.js reads (`display-mode`, `navigator.standalone`).

function makeWindow({ standalone = false, state = null } = {}) {
	const on = {};
	const entries = [{ state }];
	let i = 0;
	const fire = (t, e) => { for (const f of on[t] || []) f(e); };
	const doc = globalThis.document;
	doc.on = {};
	doc.addEventListener = (t, f) => { (doc.on[t] ||= []).push(f); };
	return mover({
		document: doc,
		navigator: {},
		matchMedia: (q) => ({ matches: standalone && /display-mode: standalone/.test(q) }),
		addEventListener(t, f) { (on[t] ||= []).push(f); },
		history: {
			get state() { return entries[i].state; },
			get length() { return entries.length; },
			pushState(s) { entries.length = i + 1; entries.push({ state: structuredClone(s) }); i++; },
			replaceState(s) { entries[i] = { state: structuredClone(s) }; },
			go(n) {
				const j = Math.max(0, Math.min(entries.length - 1, i + n));
				if (j === i) return;
				i = j;
				fire('popstate', { state: entries[i].state });
			},
			back() { this.go(-1); },
		},
		get index() { return i; },
	});
}

function touch(doc, type, x, y) {
	for (const f of doc.on[type] || []) f({ touches: [{ clientX: x, clientY: y }] });
}

function freshIn(opts) {
	globalThis.document = makeDocument();
	const win = makeWindow(opts);
	const s = newStack(win);
	for (const n of ['home', 'diamond', 'settings']) s.on(n, () => {});
	return { s, win };
}

test('(g) a push is a history entry, and popstate goes back a page', () => {
	const { s, win } = freshIn();
	s.start('home');
	const n0 = win.history.length;
	s.push('diamond', { id: 'd1' });
	assert.equal(win.history.length, n0 + 1, 'push adds an entry');
	assert.deepEqual(win.history.state.stack, ['home', 'diamond']);
	s.push('settings');
	assert.equal(win.history.length, n0 + 2);
	win.history.back();
	assert.equal(s.top(), 'diamond', 'popstate restores the page before');
	win.history.back();
	assert.equal(s.top(), 'home');
});

test('(h) pop goes back through history, so the browser and the stack agree', () => {
	const { s, win } = freshIn();
	s.start('home');
	s.push('diamond');
	const at = win.index;
	assert.equal(s.pop(), 'diamond');
	assert.equal(win.index, at - 1, 'pop is history.back');
	assert.equal(s.top(), 'home');
	// Returning to a page lower down is a jump back, not a new entry.
	s.push('diamond');
	s.push('settings');
	const n = win.history.length;
	s.push('home');
	assert.equal(s.top(), 'home');
	assert.equal(win.history.length, n, 'no entry added');
	assert.deepEqual(win.history.state.stack, ['home']);
});

test('(i) a reload restores the top page from the history entry', () => {
	const { s } = freshIn({ state: { stack: ['home', 'settings'], opts: { settings: { from: 'x' } } } });
	let got = null;
	s.on('settings', (el, opts) => { got = opts; });
	s.start('home');
	assert.equal(s.top(), 'settings');
	assert.deepEqual(got, { from: 'x' }, 'mounted with the opts it was pushed with');
	assert.equal(s.pop(), 'settings');
	assert.equal(s.top(), 'home');
});

test('(j) the left-edge swipe goes back in an installed PWA', () => {
	const { s, win } = freshIn({ standalone: true });
	s.start('home');
	s.push('diamond');
	assert.equal(s.bindEdgeBack(), true, 'bound when standalone');
	touch(win.document, 'touchstart', 300, 400);
	touch(win.document, 'touchmove', 380, 400);
	assert.equal(s.top(), 'diamond', 'a drag from mid-screen is not a back swipe');
	touch(win.document, 'touchend', 0, 0);
	touch(win.document, 'touchstart', 10, 400);
	touch(win.document, 'touchmove', 80, 404);
	assert.equal(s.top(), 'home', 'an edge swipe pops');
	touch(win.document, 'touchend', 0, 0);
	touch(win.document, 'touchstart', 10, 400);
	touch(win.document, 'touchmove', 80, 404);
	assert.equal(s.top(), 'home', 'nothing behind the root to go back to');
});

test('(k) in a browser tab the edge swipe is not bound, the browser has its own', () => {
	const { s, win } = freshIn({ standalone: false });
	s.start('home');
	s.push('diamond');
	assert.equal(s.bindEdgeBack(), false);
	assert.equal((win.document.on.touchstart || []).length, 0, 'no touch listener');
	// navigator.standalone is iOS's own signal for a home-screen app.
	const t = freshIn({ standalone: false });
	t.win.navigator.standalone = true;
	t.s.start('home');
	assert.equal(t.s.bindEdgeBack(), true);
});

test('(l) a watcher hears every change of top page, for the stack bar', () => {
	const { s, win } = freshIn();
	const heard = [];
	s.watch((top, depth) => heard.push(top + depth));
	s.start('home');
	s.push('diamond');
	win.history.back();
	assert.deepEqual(heard, ['home1', 'diamond2', 'home1']);
});

test('(m) the first push begins the stack as start does, restoring a reload (page/phone_home.js pushes home)', () => {
	const { s, win } = freshIn({ state: { stack: ['home', 'diamond'] } });
	assert.equal(s.started(), false);
	const el = s.push('home');
	assert.equal(el.dataset.page, 'home', 'the floor page is returned, to be filled');
	assert.equal(s.started(), true);
	assert.equal(s.top(), 'diamond', 'the reload lands where it left');
	assert.deepEqual(win.history.state.stack, ['home', 'diamond']);
	assert.equal(s.pop(), 'diamond');
	assert.equal(s.top(), 'home');
});

// ── One history, one mover (A4f, A4i) ───────────────────────────────────────────
// A browser runs a `go` later, from the position it was issued at. The layers and the
// stack both move history, and once did it each for itself: a page pushed while a
// layer's traversal was in flight was undone by its landing (verify_mobile_ux, A4e's
// run on 458ff4458), and a phone widened with a menu up stepped back twice in one task
// and walked off the app (phone_shell HX). Both go through js/history.js now.
function queued(state = null) {
	globalThis.document = makeDocument();
	const on = {}, entries = [{ state }], queue = [];
	let i = 0;
	const fire = (e) => { for (const f of on.popstate || []) f(e); };
	const win = mover({
		document: globalThis.document, navigator: {}, matchMedia: () => ({ matches: false }),
		addEventListener(t, f) { (on[t] ||= []).push(f); },
		history: {
			get state() { return entries[i].state; },
			get length() { return entries.length; },
			pushState(s) { entries.length = i + 1; entries.push({ state: structuredClone(s) }); i++; },
			replaceState(s) { entries[i] = { state: structuredClone(s) }; },
			// Queued, as a browser does: the target is fixed when it is issued; off the front is off the app.
			go(n) { queue.push(i + n); },
			back() { this.go(-1); },
		},
	});
	const t = { win, off: false, get i() { return i; }, entries };
	t.land = async () => {
		for (let k = 0; k < 20; k++) {
			while (queue.length) {
				const j = queue.shift();
				if (j < 0) { t.off = true; continue; }
				if (j >= entries.length || j === i) continue;
				i = j; fire({ state: entries[i].state });
			}
			await Promise.resolve();
		}
	};
	return t;
}

test('(n) a layer\'s traversal in flight is not a Back: a page pushed under it stands', async () => {
	const t = queued(), H = t.win.DaimondHistory;
	const s = newStack(t.win);
	for (const n of ['home', 'turn', 'settings']) s.on(n, () => {});
	s.start('home');
	s.push('turn');
	// A menu's entry, then its close: the layers' traversal back is issued and in flight.
	H.push({ dlayers: 1 });
	H.go(-1);
	s.push('settings');
	await t.land();
	assert.equal(s.top(), 'settings', 'the push stands');
	assert.deepEqual(t.win.history.state.stack, ['home', 'turn', 'settings'], 'history agrees');
	assert.deepEqual(s.pages(), ['home', 'turn', 'settings']);
});

test('(o) a menu\'s close and the stack put away in one task end on the floor, never off the app (HX)', async () => {
	const t = queued(), H = t.win.DaimondHistory;
	const s = newStack(t.win);
	for (const n of ['home', 'turn']) s.on(n, () => {});
	s.start('home');
	s.push('turn');
	H.push({ dlayers: 1 });			// the "more" menu over the turn page
	// Widened: the menu closes (its entry taken off) and the stack is put away, in one task.
	H.go(-1);
	s.park();
	await t.land();
	assert.equal(t.off, false, 'history stays in the app');
	assert.equal(t.i, 0, 'on the floor entry');
	assert.deepEqual(t.win.history.state.stack, ['home']);
	assert.equal(H.above(), 0);
});

test('(p) every push and replace carries the state the other owner keeps', async () => {
	const t = queued(), H = t.win.DaimondHistory;
	const s = newStack(t.win);
	for (const n of ['home', 'turn']) s.on(n, () => {});
	s.start('home');
	H.push({ dlayers: 1 });
	s.push('turn');
	assert.equal(t.win.history.state.dlayers, 1, 'the page\'s entry keeps the layer depth');
	H.push({ dlayers: 2 });
	assert.deepEqual(t.win.history.state.stack, ['home', 'turn'], 'the layer\'s entry keeps the page');
});

test('(q) a step back is cut at the floor, and a reload above it rewrites the entry instead', async () => {
	const t = queued({ stack: ['home', 'turn'] }), H = t.win.DaimondHistory;
	assert.equal(H.go(-3), 0, 'nothing below the floor');
	const s = newStack(t.win);
	for (const n of ['home', 'turn']) s.on(n, () => {});
	s.start('home');
	assert.equal(s.top(), 'turn', 'the reload lands on its page');
	assert.equal(s.pop(), 'turn');
	await t.land();
	assert.equal(t.off, false, 'Back from the restored page does not leave the app');
	assert.deepEqual(t.win.history.state.stack, ['home'], 'the floor entry is rewritten to the stack');
	H.push({ x: 1 }); H.push({ x: 2 });
	assert.equal(H.go(-5), -2, 'cut to the two pushes above the floor');
});
