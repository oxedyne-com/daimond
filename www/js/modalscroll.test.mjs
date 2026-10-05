// modalscroll.test.mjs -- a view hosted anew in the Admin modal starts at its head.
//
//	node --test www/js/modalscroll.test.mjs
//
// The modal card is the scroller, and the head with the x is its first child. A browser gives a
// card that was scrolled, closed and shown again its old offset, so Settings reopened scrolled to
// the bottom with the x above the glass (the crawl's TRAPPED `admin: settings | (leave: Back)`,
// 390x845, 2026-10-05, reproduced in Chromium: scrollTop 889 of 1708 after close and reopen).
// The shipped toModal is cut out of daimond.js and run against stand-ins.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src  = fs.readFileSync(path.join(HERE, 'daimond.js'), 'utf8');
const cut  = (s, from, to) => {
	const a = s.indexOf(from), b = s.indexOf(to, a);
	assert.ok(a >= 0 && b > a, `cannot cut ${JSON.stringify(from)} .. ${JSON.stringify(to)}: the banners moved`);
	return s.slice(a, b);
};
const body = cut(src, '\t\tfunction toModal(', '\t\t/// Back out of the built form');

function host() {
	const card  = { scrollTop: 0 };
	const modal = { style: { display: 'none' }, querySelector: (q) => (q === '.modal-card' ? card : null) };
	const view  = { style: { display: 'none' } };
	const slot  = { kids: [], appendChild(c) { this.kids.push(c); } };
	const layers = [];
	const make = new Function('modal', 'slot', 'formView', 'curView', 'settingsView', 'modalHead', 'DaimondLayers', 'cancelForm', 'closeAdmin', 'headClose',
		body + '; return toModal;');
	const toModal = make(modal, slot, view, null, view, () => {}, { open: (k) => layers.push(k) }, () => {}, () => {}, null);
	return { card, modal, view, slot, layers, toModal };
}

test('a view hosted while the card is down starts at the top, whatever offset the card remembers', () => {
	const h = host();
	h.card.scrollTop = 889;   // what the browser hands back for a card that was scrolled, closed and shown again
	h.toModal('Models', false, 'drawer.models');
	assert.equal(h.modal.style.display, 'flex');
	assert.equal(h.card.scrollTop, 0);
});

test('hosting a view that is already up does not throw the reader back to the top', () => {
	const h = host();
	h.toModal('Models', false, 'drawer.models');
	h.card.scrollTop = 400;
	h.toModal('Models', false, 'drawer.models');
	assert.equal(h.card.scrollTop, 400);
});

test('the layer is still registered and the view still shown', () => {
	const h = host();
	h.toModal('Models', false, 'drawer.models');
	assert.deepEqual(h.layers, [ 'admin-view' ]);
	assert.equal(h.view.style.display, '');
	assert.equal(h.slot.kids.length, 1);
});
