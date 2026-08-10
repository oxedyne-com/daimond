// verify_fileview.mjs — a file is shown as what it IS, and never as characters
// it is not.
//
// Clicking a PDF or a PNG in the workspace filled the document panel with
// replacement characters. `read_file` ends in `from_utf8_lossy`, so every byte
// that is not valid UTF-8 arrived as U+FFFD and went straight into a `<pre>`.
// There WAS a binary guard in `openFile`, and it never fired for a workspace
// file: it asked `DaimondCloud.fileAt`, which resolves through the cloud
// offload cache and not the workspace at all, so the one door that checked
// covered the files least likely to need it.
//
// `file_probe` and `read_bytes` in the wasm answer "what is this" and "give me
// these bytes" separately, and `www/js/viewer.js` spends them. This file pins
// what that viewer must do, and every check here reads the RENDERED DOM rather
// than the viewer's own bookkeeping:
//
//   * a PNG written into the workspace is DECODED BY THE BROWSER, at the size
//     the fixture says, with no replacement character anywhere on screen;
//   * a PDF lands in a frame whose sandbox is EXACTLY `allow-scripts` -- a
//     `blob:` URL inherits our origin, so `allow-same-origin` would hand the
//     framed file `localStorage`, where the API key lives, and OPFS with it;
//   * SVG is in the image list and not the frame list, because script inside an
//     SVG executes in a frame and does not in an `<img>`;
//   * an unrecognised binary gets a hex dump that shows ITS OWN bytes and names
//     how many there are;
//   * a `.log` full of NULs is NOT shown as characters, which is the original
//     bug stated exactly: the name says text, the bytes say otherwise, and the
//     bytes win;
//   * a file whose name and bytes disagree SAYS SO, naming both;
//   * every object URL the viewer mints is dead after `close()`, proved by
//     fetching them rather than by counting our own bookkeeping.
//
// TO SEE THESE FAIL, break it like this -- this lane could not run a browser
// (a subagent launching one is what has OOMed this machine), so the lead should
// run each mutation once before trusting the green:
//
//   * `viewer.js`, `handlerFor`: drop the `if (TEXTY[h] && !info.text)` line and
//     the `.log` check goes red -- that line IS the fix.
//   * `viewer.js`, `frame`: add `allow-same-origin` to the sandbox and both
//     frame checks go red.
//   * `viewer.js`, `media`: build the `Blob` with no `type` and the PNG check
//     goes red, because a `Blob` typed `application/octet-stream` is a picture
//     that does not appear.
//   * `viewer.js`, `close`: skip the `revokeObjectURL` loop and the last check
//     goes red.
//   * `viewer.js`, `show`: drop the `info.disagree` branch and the disagreement
//     check goes red.
//
//   node dev/verify_fileview.mjs
//
// Needs dev/serve.mjs (DAIMOND_PORT, default 8777) and a wasm built since
// `file_probe` landed. No gateway, no mock LLM.
import fs from 'node:fs';
import { open, scratch } from './harness.mjs';

const PROFILE = scratch('pw', 'fileview');
fs.rmSync(PROFILE, { recursive: true, force: true });

let bad = 0;
const check = (pass, name, detail) => {
	if (!pass) bad++;
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

/// A string as bytes, for the fixtures that are text-shaped headers.
const ascii = (s) => Array.from(s, (c) => c.charCodeAt(0) & 0xff);

// ── The fixtures, as bytes, written by the test ──────────────────
//
// A real 2×3 PNG rather than a signature and filler: the check asserts that the
// BROWSER decoded it and got 2×3 back, which is an answer no amount of our own
// code can fake. Signature, IHDR (2×3, 8-bit, truecolour), one IDAT, IEND.
const PNG = [
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
	0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x03,
	0x08, 0x02, 0x00, 0x00, 0x00, 0x36, 0x88, 0x49, 0xd6, 0x00, 0x00, 0x00,
	0x10, 0x49, 0x44, 0x41, 0x54, 0x78, 0xda, 0x63, 0xf8, 0xcf, 0x00, 0x04,
	0xff, 0x19, 0x50, 0x28, 0x00, 0x3e, 0xd6, 0x05, 0xfb, 0xb6, 0xd6, 0xf9,
	0xda, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60,
	0x82,
];
const PNG_W = 2, PNG_H = 3;

// Structurally a PDF -- catalogue, page tree, one page -- with no cross
// reference table, which every reader rebuilds. Nothing here asserts that it
// RENDERS; what is asserted is the frame it renders in.
const PDF = ascii(
	'%PDF-1.4\n'
	+ '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n'
	+ '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n'
	+ '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 99 99]>>endobj\n'
	+ 'trailer<</Root 1 0 R>>\n%%EOF\n');

// Sixteen readable bytes, then a NUL, then filler. The readable run is exactly
// one dump line, so the ASCII column proves the dump is showing THESE bytes and
// not any bytes; the NUL is what makes it binary to the probe.
const BIN_HEAD = 'DAIMOND BYTES!!!';
const BIN = ascii(BIN_HEAD).concat([0x00]);
while (BIN.length < 300) BIN.push((BIN.length * 37) & 0xff);

// Named as text, and not text. This is the original defect stated as a fixture.
const LOGBYTES = ascii('hello').concat([0x00], ascii('world'));

const MD   = ascii('# Heading\n\nsome *text*\n');
const JSON_ = ascii('{"a":[1,2],"b":"x"}');
// The quoted field holds the delimiter, so the table proves it parsed rather
// than split.
const CSV  = ascii('name,qty\n"a,b",2\n');

const s = await open({ name: 'fileview', profile: PROFILE, connect: false, defaults: false });
const { page } = s;

/// Write bytes into the workspace through the same door the app uses.
///
/// `write_bytes` on the wasm app, not a hand-rolled OPFS walk: it applies the
/// path jail, the real-folder override and the per-account namespace, and the
/// last of those is why a walk of the origin root would write somewhere the
/// viewer does not read.
const put = (path, bytes) => page.evaluate(async ({ path, bytes }) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	await app.write_bytes(path, new Uint8Array(bytes));
}, { path, bytes });

/// Probe and render one file into a host element of the test's own, and answer
/// with everything the checks read.
///
/// The host is the test's, not the Doc panel's, so this file pins the VIEWER
/// and stays green whatever the panel around it looks like on the day.
const view = (path) => page.evaluate(async (path) => {
	let host = document.getElementById('fv-host');
	if (!host) {
		host = document.createElement('div');
		host.id = 'fv-host';
		host.style.cssText = 'position:fixed;left:0;bottom:0;width:420px;height:320px;'
			+ 'display:flex;flex-direction:column;z-index:99999';
		document.body.appendChild(host);
	}
	const info = await window.DaimondViewer.probe(path, {});
	window.__fvWatch = 1;
	try {
		await window.DaimondViewer.show(host, path, info, {
			t: (k, v) => (window.DaimondI18n ? DaimondI18n.t(k, v) : k),
			onError: (e) => { window.__fvLastError = String(e && e.message ? e.message : e); },
		});
	} finally { window.__fvWatch = 0; }
	return info;
}, path);

/// What is on screen, read by meaning: the words on the controls, the words in
/// the warnings, and what the browser made of the bytes.
const seen = () => page.evaluate(() => {
	const root = document.querySelector('#fv-host .fileview');
	if (!root) return null;
	const txt = (sel) => { const n = root.querySelector(sel); return n ? n.textContent : null; };
	const img = root.querySelector('img');
	const fr  = root.querySelector('iframe');
	// The tree row whose KEY is the one asked about, found by its label rather
	// than by its position.
	const jrow = (key) => {
		const rows = Array.from(root.querySelectorAll('.fv-jrow'));
		const hit  = rows.find((r) => {
			const k = r.querySelector('.fv-jkey');
			return k && k.textContent === key;
		});
		if (!hit) return null;
		const v = hit.querySelector('.fv-jval');
		return v ? v.textContent : null;
	};
	const cells = Array.from(root.querySelectorAll('.fv-table td')).map((c) => c.textContent);
	const heads = Array.from(root.querySelectorAll('.fv-table th')).map((c) => c.textContent);
	return {
		handler:   root.getAttribute('data-viewer'),
		all:       root.textContent || '',
		meta:      txt('.fv-meta') || '',
		disagree:  txt('.fv-disagree'),
		hex:       txt('.fv-hex'),
		hexAt:     txt('.fv-hexat'),
		plain:     txt('.fv-plain'),
		mdHtml:    (() => { const n = root.querySelector('.fv-md'); return n ? n.innerHTML : null; })(),
		mdH1:      (() => { const n = root.querySelector('.fv-md h1'); return n ? n.textContent : null; })(),
		jsonB:     jrow('b'),
		heads:     heads,
		cells:     cells,
		img:       img ? { w: img.naturalWidth, h: img.naturalHeight, blob: img.src.slice(0, 5) } : null,
		frame:     fr ? { sandbox: fr.getAttribute('sandbox'), blob: fr.src.slice(0, 5) } : null,
		lostBytes: /�/.test(root.textContent || ''),
	};
});

/// An `<img>` decodes after its `src` is set, so wait for the browser to have
/// finished with it either way — a decode that failed is `complete` too, and
/// the viewer will have swapped the element for a warning.
const settled = () => page.waitForFunction(() => {
	const root = document.querySelector('#fv-host .fileview');
	if (!root) return false;
	const i = root.querySelector('img');
	return !i || i.complete;
}, null, { timeout: 10000 }).catch(() => {});

try {
	await page.waitForTimeout(1200);

	// ── The viewer is on the page at all ─────────────────────────
	// A FAIL and not a skip: a surface nothing loads is not a surface that works,
	// and every check below would otherwise report the same absence eight times.
	const loaded = await page.evaluate(() => typeof window.DaimondViewer === 'object'
		&& typeof window.DaimondViewer.probe === 'function');
	check(loaded, 'the page loads the viewer',
		loaded ? '' : 'www/index.html needs <script src="js/viewer.js"> and '
			+ '<link rel="stylesheet" href="css/viewer.css">');
	if (!loaded) throw new Error('DaimondViewer is not on the page');

	const hasProbe = await page.evaluate(async () => {
		const m = await import('/pkg/oxedyne_daimond.js');
		return typeof m.file_probe === 'function' && typeof m.read_bytes === 'function';
	});
	check(hasProbe, 'the wasm exports file_probe and read_bytes',
		hasProbe ? '' : 'rebuild it: dev/build-wasm.sh');
	if (!hasProbe) throw new Error('the wasm predates file_probe');

	// Count only what the viewer mints, and only while it is drawing: the app
	// mints object URLs of its own and one of those staying live is not a leak
	// in this file's subject.
	await page.evaluate(() => {
		window.__fvUrls = [];
		const real = URL.createObjectURL.bind(URL);
		URL.createObjectURL = function (blob) {
			const u = real(blob);
			if (window.__fvWatch) window.__fvUrls.push(u);
			return u;
		};
	});

	// ── A picture is a picture ───────────────────────────────────
	await put('view/pic.png', PNG);
	await view('view/pic.png');
	await settled();
	const pic = await seen();
	check(!!pic && pic.handler === 'image', 'a PNG is drawn by the picture tier',
		pic ? pic.handler : 'nothing rendered');
	check(!!(pic && pic.img && pic.img.w === PNG_W && pic.img.h === PNG_H),
		'and the browser decoded it, at the size the fixture wrote',
		pic && pic.img ? `${pic.img.w}x${pic.img.h}` : 'no <img> survived');
	check(!!(pic && pic.img && pic.img.blob === 'blob:'),
		'from a blob URL rather than a path the frame could follow',
		pic && pic.img ? pic.img.blob : '');
	// Gated on the picture being there: an empty panel has no replacement
	// characters either, and that is the vacuous pass this whole file is about.
	check(!!(pic && pic.img && pic.img.w > 0) && pic.lostBytes === false,
		'and not one replacement character reached the screen',
		pic && pic.lostBytes ? 'U+FFFD is on screen' : '');
	check(!!(pic && pic.meta.indexOf(String(PNG.length)) !== -1),
		'the header names how many bytes it is', pic ? pic.meta : '');

	// ── A PDF is framed, and the frame is a cell ─────────────────
	await put('view/doc.pdf', PDF);
	await view('view/doc.pdf');
	const doc = await seen();
	check(!!doc && doc.handler === 'frame', 'a PDF is drawn in a frame',
		doc ? doc.handler : 'nothing rendered');
	// The whole attribute, not a search for the bad tokens: a check that asks
	// "does it contain allow-same-origin" passes on a sandbox that has gained
	// allow-popups instead.
	check(!!(doc && doc.frame && doc.frame.sandbox === 'allow-scripts'),
		'and the frame is sandboxed to allow-scripts and nothing else',
		doc && doc.frame ? JSON.stringify(doc.frame.sandbox) : 'no frame');

	// SVG must never reach that frame: script inside an SVG runs in a frame and
	// does not in an `<img>`. Read off the table, which is published so this can
	// be asked without rendering anything.
	const table = await page.evaluate(() => window.DaimondViewer.KIND_HANDLERS);
	check(table.Svg === 'image', 'an SVG goes through <img> and never a frame',
		'KIND_HANDLERS.Svg = ' + table.Svg);
	check(table['*'] === 'hex', 'and every format with no viewer of its own falls to the bytes',
		"KIND_HANDLERS['*'] = " + table['*']);

	// ── The honest floor ─────────────────────────────────────────
	await put('view/thing.bin', BIN);
	const binInfo = await view('view/thing.bin');
	const bin = await seen();
	check(binInfo.media === 'Unknown', 'a format nothing recognises is reported as unknown',
		binInfo.media);
	check(!!bin && bin.handler === 'hex', 'and it is shown as its bytes',
		bin ? bin.handler : 'nothing rendered');
	check(!!(bin && bin.hex && bin.hex.indexOf(BIN_HEAD) !== -1),
		'the dump shows THIS file’s bytes, in the ASCII column',
		bin && bin.hex ? JSON.stringify(bin.hex.slice(0, 80)) : 'no dump');
	// The exact count, formatted the way the page formats it, so the assertion
	// tracks the app's own grouping rather than a hard-coded string.
	const binTotal = await page.evaluate((n) => Number(n).toLocaleString(), BIN.length);
	check(!!(bin && bin.hexAt && bin.hexAt.indexOf(binTotal) !== -1),
		'and the readout names how big the file is',
		bin ? String(bin.hexAt) : '');
	// The two paging controls are found by the words on them, in whatever
	// language the app is speaking, and never by their position in the bar.
	const paging = await page.evaluate(() => {
		const t = (k, e) => {
			const s = window.DaimondI18n ? DaimondI18n.t(k) : k;
			return (s == null || s === k) ? e : s;
		};
		const want = [t('fileview.hex_prev', 'Earlier bytes'), t('fileview.hex_next', 'Later bytes')];
		const say  = Array.from(document.querySelectorAll('#fv-host .fv-hexbar .fv-btn'))
			.map((b) => b.textContent);
		return want.every((w) => say.indexOf(w) !== -1);
	});
	check(paging, 'the dump can be walked forwards and back, by controls that say so');

	// ── The original bug, stated as a fixture ────────────────────
	await put('view/notes.log', LOGBYTES);
	const logInfo = await view('view/notes.log');
	const log = await seen();
	check(logInfo.text === false,
		'a .log holding a NUL is not characters, whatever its name says',
		'probe said text=' + logInfo.text);
	check(!!log && log.handler === 'hex',
		'so it is shown as bytes and not as a screen of replacement characters',
		log ? log.handler : 'nothing rendered');
	check(!!(log && log.lostBytes === false && log.hex),
		'and nothing on screen is a replacement character');

	// ── When the name and the bytes disagree ─────────────────────
	await put('view/export.png', PDF);
	const liarInfo = await view('view/export.png');
	const liar = await seen();
	check(liarInfo.disagree === true, 'a .png holding PDF bytes is reported as a disagreement');
	check(!!liar && liar.handler === 'frame', 'the bytes win: it is shown as the PDF it is',
		liar ? liar.handler : 'nothing rendered');
	check(!!(liar && liar.disagree && /png/i.test(liar.disagree) && /pdf/i.test(liar.disagree)),
		'and one line names both the name’s claim and the bytes’ evidence',
		liar && liar.disagree ? liar.disagree : 'no line');
	check(!!(liar && liar.frame && liar.frame.sandbox === 'allow-scripts'),
		'that frame is sandboxed exactly as the honest one is',
		liar && liar.frame ? JSON.stringify(liar.frame.sandbox) : 'no frame');

	// ── The structured text tiers ────────────────────────────────
	await put('view/notes.md', MD);
	await view('view/notes.md');
	const mdSeen = await seen();
	check(!!mdSeen && mdSeen.handler === 'markdown', 'Markdown goes through the app’s renderer',
		mdSeen ? mdSeen.handler : 'nothing rendered');
	check(mdSeen && mdSeen.mdH1 === 'Heading', 'and a heading arrives as a heading',
		mdSeen ? String(mdSeen.mdH1) : '');
	// The renderer drops these whole, and this file must not have loosened it.
	check(!!(mdSeen && mdSeen.mdHtml !== null && !/<script|<iframe/i.test(mdSeen.mdHtml)),
		'with the sanitiser still dropping script and frame markup');

	await put('view/data.json', JSON_);
	await view('view/data.json');
	const js = await seen();
	check(!!js && js.handler === 'json', 'JSON becomes a tree', js ? js.handler : 'nothing rendered');
	check(js && js.jsonB === 'x', 'whose named key carries its own value',
		js ? String(js.jsonB) : '');

	await put('view/grid.csv', CSV);
	await view('view/grid.csv');
	const csv = await seen();
	check(!!csv && csv.handler === 'table', 'CSV becomes a table',
		csv ? csv.handler : 'nothing rendered');
	check(!!(csv && csv.heads.indexOf('name') !== -1 && csv.heads.indexOf('qty') !== -1),
		'headed by the words in its first row', csv ? JSON.stringify(csv.heads) : '');
	check(!!(csv && csv.cells.indexOf('a,b') !== -1),
		'and a quoted field holding the delimiter stays one cell',
		csv ? JSON.stringify(csv.cells) : '');

	// ── Nothing is left holding a file ───────────────────────────
	//
	// Proved by asking the browser, not by counting our own revocations: a
	// revoked blob URL cannot be fetched, and a live one can.
	const leaks = await page.evaluate(async () => {
		window.DaimondViewer.close();
		const urls = window.__fvUrls || [];
		const live = [];
		for (const u of urls) {
			try { await fetch(u); live.push(u); } catch (e) { /* revoked, as it should be */ }
		}
		return { minted: urls.length, live: live.length };
	});
	// Gated on something having been minted: zero URLs are trivially all dead,
	// and that is the vacuous pass.
	check(leaks.minted > 0, 'the viewer minted object URLs to show those files',
		'minted ' + leaks.minted);
	check(leaks.minted > 0 && leaks.live === 0,
		'and close() leaves not one of them alive',
		leaks.live + ' of ' + leaks.minted + ' still fetchable');
} finally {
	await s.close();
}

console.log(bad ? `\n${bad} check(s) FAILED` : '\nall checks passed');
process.exit(bad ? 1 : 0);
