// pointercapture.test.mjs -- a press on a control inside a captured bar still clicks that control (r533 QA, the sheet's x).
//
//	node --test www/js/pointercapture.test.mjs
//
// `setPointerCapture` on a bar retargets the pointerup, and so the click, to the bar. A button INSIDE the
// bar then never gets its click from a mouse (a touch tap is not retargeted, and `.click()` from a script
// does not go through a pointer at all, which is why every verifier closed the sheet without seeing it).
// The sheet's grab bar holds the x, and `bindGrab` took the capture on any press in it, so a mouse press on
// the x did nothing in the phone layout (Chromium). A press on a control must not start the drag.
//
// The other capture sites hold no control: the resize handles are empty bars, the dock heading refuses a
// press on a button before it claims one, and the graph's drags match anchors and nodes only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..');
const read = (...p) => fs.readFileSync(path.join(WWW, ...p), 'utf8');

test('the sheet\'s grab bar leaves a press on its close button alone', () => {
	const m = read('js', 'mobile.js');
	const at = m.indexOf("grabEl.addEventListener('pointerdown'");
	assert.ok(at > 0, 'the grab bar\'s pointerdown handler is gone');
	const body = m.slice(at, m.indexOf('});', at));
	const guard = body.indexOf("closest('.msheet-close')");
	const capture = body.indexOf('setPointerCapture');
	assert.ok(guard > 0, 'the handler does not look for the close button');
	assert.ok(guard < capture, 'the close button is looked for after the capture is taken');
	assert.match(body.slice(guard, capture), /return;/, 'a press on the close button must return before the capture');
});

test('the close button is inside the grab bar, so the guard above is needed', () => {
	const h = read('index.html');
	const bar = h.slice(h.indexOf('id="msheet-grab"'), h.indexOf('id="msheet-tabs"'));
	assert.match(bar, /id="msheet-close"/);
});

test('every pointer-capture site is known, and none but the grab bar holds a control', () => {
	const sites = {};
	for (const f of fs.readdirSync(path.join(WWW, 'js')).filter((n) => n.endsWith('.js'))) {
		const n = (read('js', f).match(/\.setPointerCapture\(/g) || []).length;
		if (n) sites[f] = n;
	}
	// A new site is a new place a control could be swallowed: say, in the test, why it cannot.
	assert.deepEqual(sites, { 'daimond.js': 5, 'gesture.js': 1, 'mobile.js': 1 });
	const d = read('index.html');
	for (const id of [ 'handle-rail', 'handle-dock', 'handle-split', 'handle-rail-split' ]) {
		assert.match(d, new RegExp('<div class="[a-z]+" id="' + id + '"[^>]*></div>'), id + ' is not an empty bar');
	}
});
