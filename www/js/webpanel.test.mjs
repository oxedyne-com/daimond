// webpanel.test.mjs -- a page the daimon opens shows in the Web panel, not a browser tab
// (UNBLOCK-21, D-20261015-24).
//
//	node --test www/js/webpanel.test.mjs
//
// The owner: "When web search did 'work' I got asked permissions for each website, and they
// were showing in a new tab of the browser, when I want to see them in the Web panel of the
// app." With Daimond Hands installed, `open` sent every page to the extension, which asks
// Chrome for that one site (a grant window per new host) and opens it as a real tab. Showing a
// page needs neither: the panel's own frame shows it where the site allows framing. The
// extension is now taken up only when the daimon goes on to ACT on the page.
//
//   P1  with Hands attached, a framable page is shown in the panel's frame and the extension
//       is never asked to open it;
//   P2  a page that refuses framing says so in one line, offers no new tab, and the extension
//       is still not asked;
//   P3  acting on a shown page (snapshot) is what takes the extension up, and only then;
//   P4  the extension does not bring its tab forward when it reuses one.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Every panel made, so the live mirror an extension page starts is stopped at the end.
const live = [];
test.after(async () => { for (const W of live) { try { await W.close(); } catch (e) { /* gone */ } } });

function el(id) {
	const e = {
		id, style: {}, className: '', innerHTML: '', textContent: '', children: [], handlers: {}, attrs: {}, src: '',
		addEventListener(t, f) { (e.handlers[t] = e.handlers[t] || []).push(f); },
		appendChild(c) { e.children.push(c); return c; },
		setAttribute(k, v) { e.attrs[k] = v; }, removeAttribute(k) { delete e.attrs[k]; if (k === 'src') e.src = ''; },
		getAttribute(k) { return k === 'src' ? e.src : (e.attrs[k] ?? null); },
		classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
		querySelector() { return null; }, querySelectorAll() { return []; },
	};
	return e;
}

// A fresh panel over the real web.js, with Daimond Hands attached (a stand-in that records
// every command) and a gateway whose `head` answers `framable`.
function panel(framable) {
	const els = {};
	const made = [];
	const document = {
		getElementById: (id) => els[id] || (els[id] = el(id)),
		createElement: () => { const x = el('x'); made.push(x); return x; },
		addEventListener() {},
		body: el('body'), documentElement: { dataset: { daimondHands: 'hands-id' } },
	};
	const sent = [];
	const opened = [];
	globalThis.DaimondI18n   = { t: (k, v) => k + (v && v.host ? ':' + v.host : ''), onChange() {} };
	globalThis.DaimondPanels = { hide() {}, show() {}, reflow() {} };
	globalThis.chrome = { runtime: {
		lastError: null,
		sendMessage(id, msg, cb) {
			sent.push(msg.cmd);
			const reply = msg.cmd === 'open' ? { ok: true, tabId: 7, url: msg.url, title: 'T', mode: 'agent' }
				: msg.cmd === 'snapshot' ? { ok: true, url: 'https://example.com/', title: 'T', nodes: [{ ref: 1 }] }
				: { ok: true, mode: 'agent', url: 'https://example.com/' };
			setImmediate(() => cb(reply));
		},
	} };
	globalThis.fetch = async (p) => ({ ok: true, status: 200,
		json: async () => (p === '/api/web/head' ? { framable } : {}) });
	const win = { document, addEventListener() {}, location: { href: 'http://x/', host: 'x' }, navigator: {},
		chrome: globalThis.chrome, open: (u) => { opened.push(u); }, DaimondI18n: globalThis.DaimondI18n };
	globalThis.window = win;
	globalThis.document = document;
	new Function('window', 'document', fs.readFileSync(path.join(HERE, 'web.js'), 'utf8'))(win, document);
	win.DaimondWeb.init({});
	live.push(win.DaimondWeb);
	return { W: win.DaimondWeb, els, sent, opened, made };
}
const settle = () => new Promise((r) => setTimeout(r, 20));
// Every button the note holds, at any depth.
function buttons(node, out = []) {
	for (const c of node.children || []) { if (c.handlers && c.handlers.click) out.push(c); buttons(c, out); }
	return out;
}

test('P1 a framable page opens in the panel, and Hands is not asked to open a tab', async () => {
	const { W, els, sent } = panel(true);
	await settle();                                  // the ping that adopts Hands
	assert.equal(W.hasHands(), true);
	const r = await W.open('https://example.com/');
	assert.equal(W.status().driver, 'frame');
	assert.equal(els['web-frame'].src, 'https://example.com/');
	assert.equal(r.framed, true);
	assert.deepEqual(sent.filter((c) => c === 'open'), [], 'the extension was asked to open a tab');
});

test('P2 a page that refuses framing says so in one line and offers no new tab', async () => {
	const { W, els, sent, opened } = panel(false);
	await settle();
	const r = await W.open('https://refuses.example/');
	assert.equal(r.framed, false);
	assert.deepEqual(sent.filter((c) => c === 'open'), [], 'the extension was asked to open a tab');
	const lines = els['web-note'].children.filter((c) => !c.handlers.click && c.innerHTML);
	assert.equal(lines.length, 1, 'more than one line of explanation');
	assert.match(lines[0].innerHTML, /web\.blocked_line:refuses\.example/);
	for (const b of buttons(els['web-note'])) { try { b.handlers.click[0](); } catch (e) { /* async */ } }
	await settle();
	assert.deepEqual(opened, [], 'a control in the note opened a browser tab');
});

test('P3 acting on a shown page is what takes Hands up', async () => {
	const { W, sent } = panel(true);
	await settle();
	await W.open('https://example.com/');
	assert.deepEqual(sent.filter((c) => c === 'open'), [], 'showing the page already opened a tab');
	const s = await W.snapshot();
	assert.deepEqual(sent.filter((c) => c === 'open' || c === 'snapshot'), ['open', 'snapshot']);
	assert.equal(W.status().driver, 'ext');
	assert.equal(s.nodes.length, 1);
	await W.close();
});

test('P4 Hands does not bring a reused tab forward', () => {
	const src = fs.readFileSync(path.join(HERE, '..', '..', 'ext', 'background.js'), 'utf8');
	const open = src.slice(src.indexOf('async open('), src.indexOf('async close('));
	assert.match(open, /chrome\.tabs\.update\(s\.tabId, \{ url \}\)/);
	assert.doesNotMatch(open, /active:\s*true/);
});
