// UNBLOCK-24 r3 (r570s postgates, both crawls): the Workspace panel's one menu -- the head ⋯, + New or a
// row ⋯ -- hangs on the body, not in the panel, so it outlived the panel. Left open by one press, it was
// still up after a switch to the chat and back and covered "Its own folder" under it.
//
// The menu closes on an outside press, on the next menu's open, on Escape (its closer is the layer's), and
// now also when the panel is drawn again, when it leaves the screen, and when the rows its ⋯ hung from are
// drawn afresh. The functions live inside the Workspace panel's closure in a 70,000-line IIFE, so they are
// cut out of the source by name and run against a small stand-in DOM.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));
const src  = readFileSync(join(HERE, 'daimond.js'), 'utf8');

/// The function `name` defined at `tabs` indentation, from its head to its closing brace.
function cut(name, tabs = '\t\t', from = 0) {
	const at = src.indexOf('\n' + tabs + 'function ' + name + '(', from);
	assert.ok(at >= 0, name + ' is not in daimond.js');
	const end = src.indexOf('\n' + tabs + '}\n', at + 1);
	return src.slice(at + 1, end + tabs.length + 2);
}

// ── A stand-in DOM: enough for openPop to build, place and remove its menu ──────────────
function el(tag) {
	const e = {
		tag, children: [], parent: null, attrs: {}, dataset: {}, style: {}, listeners: {},
		className: '', textContent: '', title: '', disabled: false, offsetWidth: 120, offsetHeight: 80,
		classList: { add() {} },
		setAttribute(k, v) { e.attrs[k] = String(v); },
		getAttribute(k) { return e.attrs[k]; },
		addEventListener(t, f) { (e.listeners[t] = e.listeners[t] || []).push(f); },
		appendChild(c) { c.parent = e; e.children.push(c); return c; },
		remove() { if (e.parent) e.parent.children.splice(e.parent.children.indexOf(e), 1); e.parent = null; },
		contains(x) { for (; x; x = x.parent) if (x === e) return true; return false; },
		getBoundingClientRect: () => ({ left: 200, right: 300, top: 40, bottom: 60, width: 100, height: 20 }),
	};
	return e;
}

function panel() {
	const body = el('body');
	const doc = {
		body, docListeners: [],
		createElement: el,
		addEventListener(t, f, c) { doc.docListeners.push([t, f, c]); },
		removeEventListener(t, f) { doc.docListeners = doc.docListeners.filter((l) => !(l[0] === t && l[1] === f)); },
	};
	const layers = { up: [], open(id, close) { layers.up.push({ id, close }); }, done(id) { layers.up = layers.up.filter((l) => l.id !== id); } };
	const shown = [];
	const deps = {
		document: doc, window: { innerWidth: 390, innerHeight: 845 }, DaimondLayers: layers,
		bindSystem() {}, list() { shown.push('list'); }, sysList() {}, curFile: null, curDir: '', sysDir: '',
	};
	const names = [ 'popOpen', 'closePop', 'onPopOutside', 'openPop', 'onOpen' ];
	const body_ = 'var pop = null;\n' + names.map((n) => cut(n)).join('\n') +
		'\nreturn { ' + names.map((n) => n + ': ' + n).join(', ') + ', pop: function () { return pop; } };';
	const P = new Function(...Object.keys(deps), body_)(...Object.values(deps));
	const menus = () => body.children.filter((c) => c.className === 'railhead-menu');
	const open = (key) => { const a = el('button'); P.openPop(key, a, key, (item) => { item('x', 'X', () => {}); }); return a; };
	return { P, doc, layers, menus, open, body };
}

const tick = () => new Promise((f) => setTimeout(f, 5));

test('the head ⋯ left open is put away when the panel is shown again (the r570s crawls)', () => {
	const { P, layers, menus, open } = panel();
	const a = open('head');
	assert.equal(menus().length, 1);
	P.onOpen();
	assert.equal(menus().length, 0, 'the menu outlived the panel and covers the rows under it');
	assert.equal(layers.up.length, 0, 'its layer is still up, so Back and Escape answer a menu nobody sees');
	assert.equal(a.attrs['aria-expanded'], 'false');
});

test('only one panel menu is open: the next one shuts the last', () => {
	const { menus, open, layers } = panel();
	open('head');
	open('row:notes.md');
	assert.equal(menus().length, 1);
	assert.equal(menus()[0].dataset.menu, 'row');
	assert.equal(layers.up.length, 1);
});

test('an outside press shuts it, and a press inside it does not', async () => {
	const { P, doc, menus, open, body } = panel();
	open('head');
	await tick();
	const outside = doc.docListeners.find((l) => l[0] === 'click');
	assert.ok(outside && outside[2] === true, 'the outside close listens in the capture phase');
	outside[1]({ target: menus()[0].children[0] });
	assert.equal(menus().length, 1);
	outside[1]({ target: body.appendChild(el('div')) });
	assert.equal(menus().length, 0);
	assert.equal(P.pop(), null);
	assert.equal(doc.docListeners.filter((l) => l[0] === 'click').length, 0, 'the outside listener is taken off with it');
});

test('Escape and Back shut it: its layer closer is the menu\'s own close', () => {
	const { layers, menus, open } = panel();
	open('new');
	assert.equal(layers.up[0].id, 'filesmenu');
	layers.up[0].close();
	assert.equal(menus().length, 0);
	assert.equal(layers.up.length, 0);
});

test('the panel leaving the screen, or another asked for, takes its menu: Files.onLeave, from show, mshow and hide', () => {
	assert.match(src, /\n\t\t\tonLeave:\s+closePop,\n/, 'Files offers no onLeave');
	const ms = cut('mshow', '\t');
	const leave = ms.indexOf("if (name !== 'work' && Files) Files.onLeave();");
	assert.ok(leave >= 0, 'mshow does not put the Workspace menu away for another panel');
	assert.ok(leave < ms.indexOf('return;'), 'the close must come ahead of every early return (the rail, a guest sheet)');
	const sh = cut('show', '\t\t', src.indexOf('function seatInDock('));
	const ask = sh.indexOf('if (!quiet && Files) Files.onLeave();');
	assert.ok(ask >= 0 && ask < sh.indexOf('if (open[id] && seated(id))'), 'a panel a person asks for, on a desktop, leaves the Workspace menu over its rows');
	const hd = cut('hide', '\t\t', src.indexOf('function openHooks('));
	assert.match(hd, /if \(id === 'work' && Files\) Files\.onLeave\(\);/, 'hiding the Workspace panel leaves its menu up');
});

test('the rows drawn afresh take a row ⋯ that hung from one of them', () => {
	const rt = cut('renderTree');
	const guard = rt.indexOf("if (pop && pop.key.indexOf('row:') === 0) closePop();");
	assert.ok(guard >= 0 && guard < rt.indexOf("treeEl.innerHTML = '';"), 'renderTree empties the tree under an open row ⋯');
});
