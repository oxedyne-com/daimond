// framehistory.test.mjs -- browsing inside the Web sheet's frame must not leave Back dead (r533 QA B-2).
//
//	node --test www/js/framehistory.test.mjs
//
// A frame's navigations are entries in the SAME session history as the page that holds
// it. The sheet's close takes one entry off with `go(-1)`, which then landed on an entry
// the frame had pushed: no `popstate` reached the page, the layer stack read the frame's
// state for two seconds and walked back again, and a layer opened meanwhile got no entry.
// Our own guide keeps its entries out of the app's history, and that is asserted here:
// framed, it follows its links with `location.replace`, and its search does the same on
// Enter. A FOREIGN site in the frame cannot be told to: the layer stack counts the entries
// it leaves instead (layers.test.mjs, "FRAMES"; dev/verify_layerhistory.mjs, cases F, H and D).
// Replacing the frame element does not remove its entries from the joint history, measured in
// Chromium and WebKit on 2026-10-05.
//
// guide/frame.js is a plain IIFE over bare globals, so it is evaluated against a stand-in
// window and document, the pattern web.test.mjs set.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..');
const read = (...p) => fs.readFileSync(path.join(WWW, ...p), 'utf8');

const HOME = 'http://app.test/guide/index.html';

// The guide's frame.js over a stand-in page. `framed` puts a distinct parent over it, as the sheet does.
function guide({ framed = true } = {}) {
	const docL = {}, winL = {}, replaced = [], posted = [];
	const root = {
		attrs: {}, style: { setProperty() {} },
		setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k] ?? null; },
		hasAttribute(k) { return k in this.attrs; },
	};
	const document = {
		documentElement: root, readyState: 'complete', head: { appendChild() {} },
		createElement: () => ({}), querySelector: () => null,
		addEventListener(t, f) { (docL[t] = docL[t] || []).push(f); },
	};
	const location = { href: HOME, pathname: '/guide/index.html', hash: '', replace: (u) => replaced.push(u) };
	const win = {
		document, location, matchMedia: () => ({ matches: false }),
		addEventListener(t, f) { (winL[t] = winL[t] || []).push(f); },
	};
	// An opaque origin: the parent will take a message and nothing else.
	win.parent = framed ? { postMessage: (m) => posted.push(m), get document() { throw new Error('opaque'); } } : win;
	new Function('window', 'document', 'location', 'setTimeout', 'MutationObserver', read('guide', 'frame.js'))(win, document, location, () => 0, undefined);
	// A click on `href`, with whatever the person did to it.
	const click = (href, o = {}) => {
		const a = {
			href, attrs: o.attrs || {},
			getAttribute(k) { return this.attrs[k] ?? null; }, hasAttribute(k) { return k in this.attrs; },
		};
		const e = {
			type: 'click', button: 0, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false,
			defaultPrevented: !!o.prevented, target: { closest: () => a }, ...(o.ev || {}),
			preventDefault() { this.defaultPrevented = true; },
		};
		const was = e.defaultPrevented;
		(docL.click || []).forEach((f) => f(e));
		return { took: e.defaultPrevented && !was };
	};
	return { click, replaced, posted, docL, winL };
}

test('framed: a plain click on a guide link replaces the entry instead of pushing one', () => {
	const g = guide();
	const r = g.click('http://app.test/guide/models.html');
	assert.equal(r.took, true, 'the default navigation (a push) is cancelled');
	assert.deepEqual(g.replaced, ['http://app.test/guide/models.html']);
});

test('framed: a fragment link goes through the same replace, since a fragment navigation also pushes', () => {
	const g = guide();
	assert.equal(g.click('http://app.test/guide/index.html#accounts').took, true);
	assert.deepEqual(g.replaced, ['http://app.test/guide/index.html#accounts']);
});

test('framed: what is not a plain in-site navigation is left to the browser', () => {
	const g = guide();
	const left = [
		['a modified click', 'http://app.test/guide/a.html', { ev: { ctrlKey: true } }],
		['a shift click', 'http://app.test/guide/a.html', { ev: { shiftKey: true } }],
		['a middle button', 'http://app.test/guide/a.html', { ev: { button: 1 } }],
		['a link that opens elsewhere', 'http://app.test/guide/a.html', { attrs: { target: '_blank' } }],
		['a download', 'http://app.test/guide/a.pdf', { attrs: { download: '' } }],
		['another origin', 'https://elsewhere.test/page', {}],
		['a mailto', 'mailto:help@app.test', {}],
		['a click something already handled', 'http://app.test/guide/a.html', { prevented: true }],
	];
	for (const [what, href, o] of left) assert.equal(g.click(href, o).took, false, what + ' was taken');
	assert.deepEqual(g.replaced, []);
	// A link whose target names its own frame is still ours to replace.
	assert.equal(g.click('http://app.test/guide/b.html', { attrs: { target: '_self' } }).took, true);
});

test('not framed: the page is opened on its own and keeps the browser\'s links and its Back', () => {
	const g = guide({ framed: false });
	assert.equal((g.docL.click || []).length, 0, 'no click listener is installed');
	assert.deepEqual(g.posted, []);
});

test('the guide\'s search follows its best hit with replace when framed, and with href only on its own', () => {
	const s = read('guide', 'search.js');
	assert.match(s, /location\.replace\(go\.href\)/, 'Enter must replace in a frame');
	// The one place it still assigns is the unframed arm.
	const assigns = s.match(/location\.href\s*=\s*go\.href/g) || [];
	assert.equal(assigns.length, 1);
	const at = s.indexOf(assigns[0]);
	assert.match(s.slice(Math.max(0, at - 160), at), /else|!\s*framed|framed\s*\?/, 'the assignment is the unframed arm');
});
