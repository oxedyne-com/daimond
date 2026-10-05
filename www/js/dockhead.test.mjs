// dockhead.test.mjs -- a docked panel's heading is a place for the keyboard only where there is a keyboard move.
//
//	node --test www/js/dockhead.test.mjs
//
// The dead-controls crawl (D-20261003-07, finding 5) pressed the headings of Agents,
// Email and Workspace and nothing happened. Each was made tabbable and titled "drag
// to move" by `markHeads`, which is true of a desktop dock and false of a phone,
// where there is no drag, a tap on the word does nothing, and the only way to
// reorder is the chip strip. A heading that nothing answers must not be offered as
// something to press: on a phone it is neither tabbable nor titled. The chip
// strip's keyboard mode still reaches it, by `focus()`, which a heading that is
// not tabbable accepts.
//
// dockdrag.js is a plain IIFE that assigns to `window`; it is evaluated against one
// stand-in global and a document of three headings.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function heading(id) {
	const attrs = new Map();
	const span = {
		title: '', dataset: {}, listeners: [],
		getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
		setAttribute: (k, v) => { attrs.set(k, String(v)); },
		removeAttribute: (k) => { attrs.delete(k); },
		addEventListener: (ev) => { span.listeners.push(ev); },
	};
	const panel = { dataset: { panel: id, label: id } };
	const head = { querySelector: () => span, closest: () => panel };
	return { span, head, attrs };
}

function world(phone) {
	const hs = [ 'agents', 'mail', 'work' ].map(heading);
	const win = { DaimondShell: { isPhone: () => phone.on }, DaimondI18n: { t: (k) => 'words:' + k } };
	globalThis.window = win;
	globalThis.DaimondI18n = win.DaimondI18n;		// dockdrag.js names it bare
	globalThis.document = {
		getElementById: () => ({ title: '', removeAttribute() {} }),
		querySelectorAll: () => hs.map((h) => h.head),
	};
	new Function('window', fs.readFileSync(path.join(HERE, 'dockdrag.js'), 'utf8'))(win);
	return { D: win.DaimondDockDrag, hs };
}

test('on a phone no docked heading is tabbable or offers a drag, yet each can still be focused', () => {
	const phone = { on: true };
	const { D, hs } = world(phone);
	D.markHeads();
	for (const h of hs) {
		assert.equal(h.attrs.get('tabindex'), '-1', 'not in the tab order');
		assert.equal(h.span.title, '', 'no "drag to move" where nothing drags');
		assert.ok(h.span.listeners.includes('keydown'), 'the chip strip\'s keyboard mode still lands on it');
	}
});

test('on a desktop each heading is tabbable and says it can be dragged', () => {
	const phone = { on: false };
	const { D, hs } = world(phone);
	D.markHeads();
	for (const h of hs) {
		assert.equal(h.attrs.get('tabindex'), '0');
		assert.equal(h.span.title, 'words:dock.drag');
	}
});

test('the window changing shape re-marks the same headings both ways, with one set of listeners', () => {
	const phone = { on: false };
	const { D, hs } = world(phone);
	D.markHeads();
	phone.on = true;  D.markHeads();
	assert.equal(hs[0].attrs.get('tabindex'), '-1');
	assert.equal(hs[0].span.title, '');
	phone.on = false; D.markHeads();
	assert.equal(hs[0].attrs.get('tabindex'), '0');
	assert.equal(hs[0].span.title, 'words:dock.drag');
	for (const h of hs) assert.equal(h.span.listeners.filter((e) => e === 'keydown').length, 1);
});
