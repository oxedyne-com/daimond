// mailview.test.mjs -- the page reads a message with the one reader there is, every picture it
// embeds is a data: URL, and nothing remote is named until "Load pictures".
//
//	node --test www/js/mailview.test.mjs
//
// C1a (D-20261026-01): the panel had its own MIME walker (`parseMime`, `readableText`, `stripHtml`)
// beside `fe2o3_mail::message::MessageView`, the one the agent reads through, and the two
// disagreed: an RFC 2231 file name came out as "attachment", a list footer after an HTML body
// vanished, `boundary = "SP"` read as no boundary at all. The page now asks `wasm.mail_view`, so
// these cases must render exactly what that reader says. Its embedded pictures (`cid:`) become
// `data:` URLs: a `blob:` URL belongs to the page's origin and the sandboxed frame has none, so no
// engine loaded one there (review_c1a_csp, 26 Oct). The real-browser check is
// dev/verify_mailframe.mjs.
import { readPage } from '../../dev/pagesrc.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWindow, loadScript, sliceDaimond } from '../../dev/syncprobe.mjs';
import { wasm } from '../../dev/wasmpkg.mjs';

const W = await wasm();
const NOW  = 1_700_000_000_000;
const ADDR = 'hoogland@gmail.com';
const enc  = new TextEncoder();

// ── The fe2o3 MIME corpus (fe2o3_mail/tests/mime_corpus/mod.rs), the shapes these need ──

const mp = (ct, b, parts) => 'Content-Type: ' + ct + '; boundary="' + b + '"\r\n\r\n'
	+ 'This is a multi-part message in MIME format.\r\n\r\n'
	+ parts.map((p) => '--' + b + '\r\n' + p + '\r\n').join('') + '--' + b + '--\r\n';
const leaf = (ct, extra, body) => 'Content-Type: ' + ct + '\r\n' + extra + '\r\n' + body;
const msg  = (hdr, rest) => 'From: Bob <bob@x.org>\r\nTo: a@b\r\nSubject: =?ISO-8859-1?Q?Caf=E9?= test\r\n' + hdr + rest;
const plain  = leaf('text/plain; charset=utf-8', '', 'the plain body');
const html   = leaf('text/html; charset=utf-8', '', '<p>the html body</p>');
const footer = leaf('text/plain; charset=us-ascii', 'Content-Disposition: inline\r\n',
	'_______________\r\nlist mailing list\r\nhttps://lists.x/listinfo');
const PNG = 'iVBORw0KGgo=';
const logo = leaf('image/png; name="logo.png"',
	'Content-Transfer-Encoding: base64\r\nContent-ID: <Logo@X>\r\nContent-Disposition: inline; filename="logo.png"\r\n', PNG);
const logoHtml = leaf('text/html; charset=utf-8', '', '<p>hi</p><img src="cid:logo%40x"><img src=\'cid:Logo@X\'>');

const CORPUS = {
	'21 rfc2231':                 msg('', mp('multipart/mixed', 'S', [plain, leaf('application/pdf',
		"Content-Disposition: attachment;\r\n filename*=UTF-8''r%C3%A9sum%C3%A9.pdf\r\n", 'x')])),
	'19c mailman footer after html': msg('', mp('multipart/mixed', 'MM', [html, footer])),
	'28 boundary = spaced':       msg('Content-Type: Multipart/Mixed; boundary = "SP"\r\n\r\n',
		'--SP\r\nContent-Type: text/plain\r\n\r\nspaced body\r\n--SP--\r\n'),
	'24 txt attachment + html':   msg('', mp('multipart/mixed', 'T', [html, leaf('text/plain; name="log.txt"',
		'Content-Disposition: attachment; filename="log.txt"\r\n', 'LOG CONTENT')])),
};
const CID = msg('Message-ID: <cid@x>\r\n', mp('multipart/related', 'REL', [logoHtml, logo]));
const CID2 = msg('Message-ID: <cid2@x>\r\n', mp('multipart/related', 'REL2', [logoHtml, logo]));

// ── A page, a file store, and the object-URL ledger ─────────────────

function elem() {
	const p = new Proxy(function () { return p; }, {
		get: (t, k) => {
			if (k === Symbol.toPrimitive) return () => '';
			if (k === 'then') return undefined;
			if (k === 'firstElementChild') return undefined;
			if (k === 'length') return 0;
			return p;
		},
		set: () => true,
		apply: () => p,
	});
	return p;
}

/// `URL.createObjectURL` counted: the panel must make none, since the frame cannot load one.
function ledger() {
	let n = 0;
	const U = function (...a) { return new URL(...a); };
	U.createObjectURL = () => 'blob:https://daimond.test/' + (++n);
	U.revokeObjectURL = () => {};
	return { U, made: () => n };
}

function page(files) {
	const ls = makeWindow().localStorage;
	ls.setItem('daimond-mail', JSON.stringify({ sel: ADDR, accounts: [{
		address: ADDR, host: 'imap.gmail.com', port: 993, smtpHost: 'smtp.gmail.com', smtpPort: 465,
		user: ADDR, pass: 'w', refresh: { INBOX: 900 }, folder: 'INBOX', touched: NOW - 1000,
	}] }));
	const urls = ledger();
	const w = makeWindow({ now: NOW, ls, extra: { URL: urls.U, Blob } });
	w.document.createElement  = () => elem();
	const panel = { querySelector: () => null };
	w.document.getElementById = (id) => (id === 'panel-mail' ? panel : elem());
	w.DaimondI18n = new Proxy({ t: (k) => k, tn: (k) => k }, { get: (o, k) => o[k] || (() => undefined) });
	w.DaimondIdentity = { isUnlocked: () => true, wrap: async (s) => s, unwrap: async (s) => s };
	w.DaimondGateway  = { state: () => ({ authed: false }), noteBalance() {},
		gwFetch: async () => ({ status: 200, ok: true, json: async () => ({ ok: true }) }) };
	loadScript(w, 'quiet.js');
	loadScript(w, 'mail.js');
	const M = w.DaimondMail;
	const shown = [];
	M.init({
		readText:  async (p) => new TextDecoder().decode(files.get(p)),
		readBytes: async (p) => files.get(p),
		writeBytes: async () => {},
		runTool:   async () => ({ outcome: 'done', text: '' }),
		openFile() {}, refreshFiles() {}, showDoc() {},
		showMessage: (v) => { shown.push(v); },
		wasm: W,
	});
	return { M, w, urls, shown };
}

const filesOf = (o) => new Map(Object.entries(o).map(([k, v]) => [k, typeof v === 'string' ? enc.encode(v) : v]));
const open = async (p, file) => { await p.M.open({ file }); return p.shown[p.shown.length - 1]; };

// ── 1. The page shows what MessageView says ─────────────────────────

for (const [name, raw] of Object.entries(CORPUS)) {
	test('corpus ' + name + ': the panel renders exactly what wasm.mail_view reads', async () => {
		const file = 'mail/' + ADDR + '/INBOX/cur/' + name.split(' ')[0] + ':2,S';
		const p = page(filesOf({ [file]: raw }));
		const v = await open(p, file);
		const mv = W.mail_view(enc.encode(raw), false);
		assert.ok(v, 'a message was shown');
		assert.equal(v.subject, mv.subject, 'subject');
		assert.equal(v.from.addr, 'bob@x.org');
		assert.equal(v.from.name, 'Bob');
		assert.equal(v.text, mv.text, 'text');
		assert.equal(v.html, mv.html, 'html');
		const atts = mv.parts.filter((x) => !x.inline);
		assert.deepEqual(v.attachments.map((a) => [a.name, a.type, a.size]),
			atts.map((a) => [a.name, a.type, a.bytes.length]), 'attachments');
		for (let i = 0; i < atts.length; i++) assert.deepEqual([...v.attachments[i].bytes], [...atts[i].bytes]);
	});
}

test('the cases the JS walker got wrong, by name', async () => {
	const at = async (k) => {
		const p = page(filesOf({ f: CORPUS[k] }));
		return open(p, 'f');
	};
	assert.deepEqual((await at('21 rfc2231')).attachments.map((a) => a.name), ['résumé.pdf']);
	assert.match((await at('19c mailman footer after html')).html, /list mailing list/, 'the footer is kept');
	assert.match((await at('28 boundary = spaced')).text, /^spaced body/, 'a spaced boundary still splits');
});

// ── 2. Embedded pictures are data: URLs; remote ones wait for the reader ──

const PNG_BYTES = [...Buffer.from(PNG, 'base64')];
const dataOf = (u) => [...Buffer.from(u.replace(/^data:image\/png;base64,/, ''), 'base64')];

test('a cid: picture becomes a data: URL of its bytes, and no object URL is made', async () => {
	const p = page(filesOf({ c: CID }));
	const v = await open(p, 'c');
	assert.equal(v.attachments.length, 0, 'an embedded picture is shown, not listed');
	assert.doesNotMatch(v.html, /cid:/i, 'no cid: reference is left');
	const refs = v.html.match(/src="(data:[^"]+)"/g).map((x) => x.slice(5, -1));
	assert.equal(refs.length, 2, 'both references to the logo point at it');
	assert.equal(refs[0], refs[1], 'one part, one URL, however its cid is spelled');
	assert.match(refs[0], /^data:image\/png;base64,/);
	assert.deepEqual(dataOf(refs[0]), PNG_BYTES, 'the part\'s own bytes');
	assert.equal(p.urls.made(), 0, 'no blob: URL');
	assert.equal(v.close, undefined, 'nothing to let go');
});

/// A related message whose HTML is `html` and whose one embedded part is `ct` with Content-ID a@x.
const related = (html, ct) => msg('Message-ID: <r@x>\r\n', mp('multipart/related', 'R', [
	leaf('text/html; charset=utf-8', '', html),
	leaf(ct, 'Content-Transfer-Encoding: base64\r\nContent-ID: <a@x>\r\nContent-Disposition: inline\r\n', PNG)]));

test('only an image of a listed type, in an image position, is embedded', async () => {
	const at = async (html, ct) => (await open(page(filesOf({ f: related(html, ct) })), 'f')).html;
	for (const t of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
		assert.match(await at('<img src="cid:a@x">', t), new RegExp('src="data:' + t.replace('/', '\\/') + ';base64,'), t);
	}
	for (const t of ['image/svg+xml', 'text/html', 'application/octet-stream']) {
		assert.match(await at('<img src="cid:a@x">', t), /src="cid:a@x"/, t + ' is left as cid:');
	}
	assert.match(await at('<table background="cid:a@x"><td>x</td></table>', 'image/png'), /background="data:image\/png;base64,/);
	assert.match(await at('<div style="background:url(\'cid:a@x\')">x</div>', 'image/png'), /url\('data:image\/png;base64,/);
	const link = await at('<a href="cid:a@x">open</a><a href="https://e.test/?leak=cid:a@x">x</a><img src="cid:a@x">', 'image/png');
	assert.match(link, /href="cid:a@x"/, 'a link is not a picture');
	assert.match(link, /\?leak=cid:a@x"/, 'a cid: inside a URL is not rewritten');
});

test('a remote picture is not named until the reader asks, then it is', async () => {
	const pixel = msg('Message-ID: <t@x>\r\n', leaf('text/html; charset=utf-8', '',
		'<p>Sale</p><img src="https://track.test/p.gif"><img srcset="https://track.test/s.gif 1x">'));
	const p = page(filesOf({ t: pixel }));
	const v = await open(p, 't');
	assert.doesNotMatch(v.html, /track\.test/, 'pictures off: no remote URL at all');
	assert.equal(typeof v.withPictures, 'function');
	const on = v.withPictures();
	assert.match(on, /<img src="https:\/\/track\.test\/p\.gif">/);
	assert.match(on, /srcset="https:\/\/track\.test\/s\.gif 1x"/);
});

// ── 3. One builder: a draft built by the page reads back through the one reader ──

test('M.build(draft with an attachment) round-trips through wasm.mail_view', async () => {
	const p = page(new Map());
	const bytes = new Uint8Array([0, 1, 2, 250, 255]);
	const raw = await p.M.build({ from: ADDR, fromName: 'Jason Hoogland', to: 'Kraig <kraig@k.test>', cc: '',
		subject: 'Résumé attached', body: 'Hi Kraig,\nsee attached.', attachments: [{ name: 'résumé.bin', type: 'application/octet-stream', bytes }] });
	const mv = W.mail_view(enc.encode(raw), false);
	assert.equal(mv.subject, 'Résumé attached');
	assert.match(mv.to, /kraig@k\.test/);
	assert.equal(mv.text.trim(), 'Hi Kraig,\nsee attached.');
	assert.deepEqual(mv.parts.map((x) => [x.name, x.type, [...x.bytes]]),
		[['résumé.bin', 'application/octet-stream', [0, 1, 2, 250, 255]]]);
});

// ── 4. daimond.js: the frame, its policy, and the closes the panel owns ──

/// A DOM node with what `showMessage` touches, recording attributes and the frame's document.
function node(tag) {
	const n = {
		tag, children: [], attrs: {}, listeners: {}, className: '', textContent: '', srcdoc: '', disabled: false,
		classList: { add() {}, remove() {} },
		appendChild(c) { this.children.push(c); return c; },
		setAttribute(k, v) { this.attrs[k] = String(v); },
		addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); },
		querySelector() { return node('span'); },
		remove() {},
	};
	let inner = '';
	Object.defineProperty(n, 'innerHTML', { get: () => inner, set: (v) => { inner = v; if (v === '') n.children = []; } });
	return n;
}
const walk = (n, f) => { f(n); for (const c of n.children || []) walk(c, f); };

function panelPage() {
	const urls = ledger();
	const w = makeWindow({ now: NOW, extra: { URL: urls.U, Blob } });
	const ids = { 'msg-head': node('div'), 'msg-body': node('div'), 'msg-title': node('div') };
	w.document.getElementById = (id) => ids[id] || null;
	w.document.createElement  = (tag) => node(tag);
	const hides = [];
	const panels = { show() {}, reflow() {}, onUserHide: (fn) => hides.push(fn) };
	w.DaimondTime = { fmtLocal: () => '' };
	const { fns } = sliceDaimond(w, ['showMessage'], {
		t: (k) => k, esc: (s) => String(s), fmtBytes: (n) => n + ' B', DaimondPanels: panels,
	});
	const frame = () => { let f = null; walk(ids['msg-body'], (n) => { if (n.tag === 'iframe') f = n; }); return f; };
	return { w, urls, show: fns.showMessage, frame, hide: (id) => hides.forEach((f) => f(id)), hides };
}

/// A view as mail.js hands it over, with its pictures-on HTML.
function view(id) {
	return { subject: id, from: { name: '', addr: 'b@x' }, html: '<p>' + id + '</p><img>', text: '', attachments: [],
		withPictures: () => '<p>' + id + '</p><img src="https://pics.test/' + id + '.png">' };
}

test('the frame: sandbox unchanged with no allow-scripts, the policy as before C1a, pictures on demand', async () => {
	const p = panelPage();
	p.show(view('one'));
	const f = p.frame();
	assert.equal(f.attrs.sandbox, 'allow-popups allow-popups-to-escape-sandbox', 'the sandbox flags are unchanged');
	assert.doesNotMatch(f.attrs.sandbox, /allow-scripts|allow-same-origin/);
	const csp = (doc) => (doc.match(/Content-Security-Policy" content="([^"]+)"/) || [])[1];
	assert.equal(csp(f.srcdoc), "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:");
	assert.match(f.srcdoc, /<body><p>one<\/p><img><\/body>/);
	// The pictures button paints the frame again with the pictures-on HTML and remote pictures allowed.
	let btn = null;
	walk(p.w.document.getElementById('msg-body'), (n) => { if (n.tag === 'button') btn = n; });
	btn.listeners.click[0]();
	assert.equal(csp(f.srcdoc), "default-src 'none'; img-src https: data: cid:; style-src 'unsafe-inline'; font-src data:");
	assert.match(f.srcdoc, /<img src="https:\/\/pics\.test\/one\.png">/);
	assert.equal(p.urls.made(), 0);
	assert.equal(p.hides.length, 0, 'no close to listen for');
});

test('daimond.js hands mail.js the bytes door, whole and with the withdrawn-grant alarm', async () => {
	const { readFileSync } = await import('node:fs');
	const src = readPage(new URL('./daimond.js', import.meta.url), 'utf8');
	const fn = (src.match(/\nasync function readRawBytes\(path\) \{\n([\s\S]*?)\n\}\n/) || [])[1] || '';
	assert.match(fn, /Wasm\.read_bytes\(path, 0, 4294967295\)/, 'the whole file, not a prefix');
	assert.match(fn, /catch \(e\) \{ noteFolderLost\(e\); throw e; \}/, 'a withdrawn grant is raised, then rethrown');
	const init = (src.match(/DaimondMail\.init\(\{([\s\S]*?)\n\t\t\t\}\);/) || [])[1] || '';
	assert.match(init, /\n\t\t\t\treadBytes:\s+readRawBytes,/, 'DaimondMail.init is given it as readBytes');
});
