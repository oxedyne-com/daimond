// web.test.mjs -- the Web sheet's Reload, proved without a browser.
//
//	node --test www/js/web.test.mjs
//
// The dead-controls crawl pressed `#web-reload` on the sheet as it opens, where the
// panel is resting on the guide, and the click threw "That is not a web address"
// out of an async handler: nothing on screen, an uncaught rejection in the log.
// The guide's address is `guide/`, which `open` rightly refuses. Two things were
// wrong and both are asserted: Reload on the guide is the guide again, and a
// reload that cannot open its address says why in the sheet's own note.
//
// web.js is a plain IIFE over bare globals, so it is evaluated against a stand-in
// document that records what the sheet is told, the pattern dockdrag.test.mjs set.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function el(id) {
	const e = {
		id, style: {}, className: '', innerHTML: '', textContent: '', children: [], handlers: {}, attrs: {}, src: '',
		addEventListener(t, f) { (e.handlers[t] = e.handlers[t] || []).push(f); },
		appendChild(c) { e.children.push(c); return c; },
		setAttribute(k, v) { e.attrs[k] = v; }, removeAttribute(k) { delete e.attrs[k]; },
		getAttribute(k) { return k === 'src' ? e.src : (e.attrs[k] ?? null); },
		classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
		querySelector() { return null; }, querySelectorAll() { return []; },
	};
	return e;
}

// A fresh sheet over the real web.js. `readFile` is the workspace the sheet reads local pages from.
function sheet(readFile) {
	const els = {};
	const document = {
		getElementById: (id) => els[id] || (els[id] = el(id)),
		createElement: () => el('x'), addEventListener() {},
		body: el('body'), documentElement: { dataset: {} },
	};
	globalThis.DaimondI18n   = { t: (k) => k, onChange() {}, mark() {}, bind() {} };
	globalThis.DaimondPanels = { hide() {}, show() {} };
	const win = { document, addEventListener() {}, location: { href: 'http://x/' }, navigator: {} };
	globalThis.window = win;
	globalThis.document = document;
	new Function('window', 'document', fs.readFileSync(path.join(HERE, 'web.js'), 'utf8'))(win, document);
	win.DaimondWeb.init({ readFile });
	return { W: win.DaimondWeb, els };
}
const noteText = (els) => els['web-note'].children.map((c) => c.innerHTML).join('|');

test('Reload on the resting guide opens the guide and says nothing is wrong', async () => {
	const { W, els } = sheet();
	assert.equal(W.status().driver, 'guide');
	await W.reload();
	assert.equal(W.status().driver, 'guide');
	assert.equal(els['web-frame'].src, 'guide/index.html');
	assert.equal(noteText(els), '');
});

test('the click on #web-reload leaves no uncaught rejection behind', async () => {
	const { els } = sheet();
	const fns = els['web-reload'].handlers.click;
	assert.equal(fns.length, 1);
	const seen = [];
	const on = (e) => seen.push(String(e && e.message || e));
	process.on('unhandledRejection', on);
	try {
		fns[0]();
		await new Promise((r) => setTimeout(r, 20));
	} finally { process.off('unhandledRejection', on); }
	assert.deepEqual(seen, []);
});

test('a reload that cannot open its address says why in the sheet\'s note', async () => {
	let there = true;
	const { W, els } = sheet(async (p) => { if (!there) throw new Error('gone'); return '<p>hi</p>'; });
	await W.open('page.html');
	assert.equal(W.status().driver, 'local');
	there = false;
	await assert.doesNotReject(W.reload());
	assert.match(noteText(els), /No such page in the workspace: page\.html/);
	assert.equal(els['web-note'].className, 'web-note on');
});

test('open still refuses an empty address in the sheet\'s usual words, which the agent\'s tools report', async () => {
	const { W } = sheet();
	await assert.rejects(W.open(''), /That is not a web address\. Give a full http\(s\) URL\./);
});

test('the message is escaped before it is put in the note', async () => {
	let there = true;
	const { W, els } = sheet(async () => { if (!there) throw new Error('x'); return '<p>hi</p>'; });
	await W.open('<b>.html');
	there = false;
	await W.reload();
	assert.doesNotMatch(noteText(els), /<b>/);
	assert.match(noteText(els), /&lt;b&gt;\.html/);
});
