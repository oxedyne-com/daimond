// jumpvis.test.mjs -- a contextual control is hidden while it cannot act (U6, r535).
//
//	node --test www/js/jumpvis.test.mjs
//
// The two walk-back buttons under the chat took a press with nothing to scroll and changed
// nothing. A standing control is gated and says why (answer.js `control`); a contextual one is
// hidden, since D-13 asks for less on screen. The "can it act" rows are pure (`shown`), so
// every state of the thread is tested without a page; `show` and `note` are the two verbs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
function load() {
	const win = { DaimondI18n: { onChange() {} } };
	new Function('window', fs.readFileSync(path.join(HERE, 'answer.js'), 'utf8'))(win);
	return win.DaimondAnswer;
}
const S = (o) => Object.assign({ users: 3, top: 0, height: 2000, view: 600 }, o);

test('Jump back: needs a question and a thread longer than its window', () => {
	const { shown } = load();
	assert.equal(shown.jump_back(S({})), true);
	assert.equal(shown.jump_back(S({ users: 0 })), false, 'no question to walk to');
	assert.equal(shown.jump_back(S({ height: 600 })), false, 'nothing to scroll');
	assert.equal(shown.jump_back(S({ height: 601 })), false, 'a pixel of overflow is rounding, not a scroll');
	assert.equal(shown.jump_back(S({ height: 640 })), true);
	assert.equal(shown.jump_back(S({ users: 0, height: 0, view: 0 })), false, 'the empty home thread');
	assert.equal(shown.jump_back(S({ top: 1400 })), true, 'and still there at the live end: it walks to the last question');
});

test('Jump to the end: needs somewhere below the reader, the same 48px the thread calls "at the end"', () => {
	const { shown } = load();
	assert.equal(shown.jump_end(S({ top: 0 })), true);
	assert.equal(shown.jump_end(S({ top: 1400 })), false, 'at the end exactly');
	assert.equal(shown.jump_end(S({ top: 1353 })), false, '47px from the end is at the end');
	assert.equal(shown.jump_end(S({ top: 1352 })), true, '48px from the end is not');
	assert.equal(shown.jump_end(S({ height: 600, top: 0 })), false, 'nothing to scroll');
	assert.equal(shown.jump_end(S({ users: 0, height: 0, view: 0 })), false, 'the empty home thread');
});

test('show: hides and unhides through the hidden attribute only, and tolerates an absent element', () => {
	const { show } = load();
	const e = { hidden: true };
	assert.equal(show(e, true), true); assert.equal(e.hidden, false);
	assert.equal(show(e, false), false); assert.equal(e.hidden, true);
	assert.equal(show(null, true), false);
});

function host() {
	const h = { children: [], ownerDocument: null };
	const mk = () => { const n = { className: '', textContent: '', attrs: {}, parentNode: null, setAttribute(k, v) { n.attrs[k] = v; } }; return n; };
	h.ownerDocument = { createElement: mk };
	Object.defineProperty(h, 'firstChild', { get: () => h.children[0] || null });
	h.insertBefore = (n) => { n.parentNode = h; h.children.unshift(n); };
	h.removeChild = (n) => { h.children = h.children.filter((c) => c !== n); n.parentNode = null; };
	h.querySelector = () => h.children.find((c) => /\bpanel-say\b/.test(c.className)) || null;
	return h;
}

test('note: a visible line at the head of the host, one at a time, that takes its own leave', (t) => {
	t.mock.timers.enable({ apis: [ 'setTimeout' ] });
	const { note } = load();
	const h = host();
	const a = note(h, 'Refreshed.', false, 3000);
	assert.equal(a.textContent, 'Refreshed.'); assert.equal(a.className, 'panel-say'); assert.equal(a.attrs.role, 'status');
	assert.equal(h.children.length, 1);
	const b = note(h, 'Could not.', true);
	assert.deepEqual(h.children, [ b ], 'a second note replaces the first');
	assert.equal(b.className, 'panel-say err');
	t.mock.timers.tick(2999); assert.equal(h.children.length, 1);
	t.mock.timers.tick(1); assert.equal(h.children.length, 0, 'gone after three seconds');
	assert.equal(note(null, 'x'), null);
});
