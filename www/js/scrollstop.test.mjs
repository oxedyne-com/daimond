// scrollstop.test.mjs -- a scrolling region is a keyboard stop only while it scrolls.
//
//	node --test www/js/scrollstop.test.mjs
//
// `attachBody` gave every tile box `tabIndex = 0`, so a box with nothing to scroll (the
// Workspace list with two rows) was a tab stop that did nothing: the crawl reads it as INERT.
// The rule (axe `scrollable-region-focusable`) asks for the stop where there is something to
// reach, and only there. `scrollStop` in daimond.js sets it from the box's own size, and
// re-reads on resize and on content change. daimond.js imports the wasm surface and cannot be
// loaded here, so the function is cut out of the source and run against a stand-in box.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC  = fs.readFileSync(path.join(HERE, 'daimond.js'), 'utf8');

const cut = (name) => {
	const i = SRC.indexOf('\n\tfunction ' + name + '(');
	assert.ok(i >= 0, 'daimond.js has no function ' + name);
	const j = SRC.indexOf('\n\t}\n', i);
	return SRC.slice(i, j + 4);
};

// A box and the two observers, as the page has them.
function rig() {
	const ro = [], mo = [];
	class RO { constructor(f) { this.f = f; this.live = true; ro.push(this); } observe(e) { this.el = e; } disconnect() { this.live = false; } }
	class MO { constructor(f) { this.f = f; this.live = true; mo.push(this); } observe(e, o) { this.el = e; this.o = o; } disconnect() { this.live = false; } }
	const attrs = new Map();
	const el = {
		scrollHeight: 100, clientHeight: 100, scrollWidth: 200, clientWidth: 200, isConnected: true,
		get tabIndex() { return attrs.has('tabindex') ? Number(attrs.get('tabindex')) : -1; },
		set tabIndex(v) { attrs.set('tabindex', String(v)); },
		removeAttribute(n) { attrs.delete(n); },
		hasAttribute(n) { return attrs.has(n); },
	};
	const ctx = vm.createContext({ ResizeObserver: RO, MutationObserver: MO });
	vm.runInContext(cut('scrollStop') + '\nglobalThis.scrollStop = scrollStop;', ctx);
	return { el, ro, mo, attrs, run: () => ctx.scrollStop(el) };
}

test('a box that fits is not a keyboard stop', () => {
	const r = rig();
	r.run();
	assert.equal(r.el.hasAttribute('tabindex'), false);
	assert.equal(r.el.tabIndex, -1);
});

test('a box that scrolls down is a keyboard stop', () => {
	const r = rig();
	r.el.scrollHeight = 240;
	r.run();
	assert.equal(r.el.tabIndex, 0);
});

test('a box that scrolls across is a keyboard stop', () => {
	const r = rig();
	r.el.scrollWidth = 320;
	r.run();
	assert.equal(r.el.tabIndex, 0);
});

test('growing content makes it a stop, and shrinking the content or the window takes it away', () => {
	const r = rig();
	r.run();
	assert.equal(r.el.hasAttribute('tabindex'), false);
	assert.equal(r.mo.length, 1, 'content is watched');
	assert.equal(r.ro.length, 1, 'size is watched');
	r.el.scrollHeight = 300; r.mo[0].f();
	assert.equal(r.el.tabIndex, 0, 'content grew past the box');
	r.el.scrollHeight = 100; r.ro[0].f();
	assert.equal(r.el.hasAttribute('tabindex'), false, 'the box grew to hold it');
	r.el.clientWidth = 120; r.ro[0].f();
	assert.equal(r.el.tabIndex, 0, 'the window narrowed and it scrolls across');
});

test('content change is watched in its subtree, and attribute writes are not (no loop)', () => {
	const r = rig();
	r.run();
	assert.equal(r.mo[0].o.childList, true);
	assert.equal(r.mo[0].o.subtree, true);
	assert.ok(!r.mo[0].o.attributes, 'writing tabindex must not wake the observer that wrote it');
});

test('a box taken out of the page lets its observers go', () => {
	const r = rig();
	r.run();
	r.ro[0].f();
	r.el.isConnected = false;
	r.ro[0].f();
	assert.equal(r.ro[0].live, false);
	assert.equal(r.mo[0].live, false);
});

test('attachBody asks scrollStop and no longer sets the stop for every box', () => {
	const fn = cut('attachBody');
	assert.doesNotMatch(fn, /body\.tabIndex\s*=\s*0/, 'every box a tab stop is the fault');
	assert.match(fn, /scrollStop\(body\)/);
	assert.match(fn, /setAttribute\('role', 'group'\)/, 'the name and role stay');
	assert.match(fn, /setAttribute\('aria-label'/);
});
