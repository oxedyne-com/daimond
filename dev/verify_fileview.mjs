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
// AND THEN IT CLICKS THE ROW. Every check above drove the viewer into a host of
// this file's own, and all of them were green while clicking a PDF in the
// Workspace tree filled the Doc panel with `%PDF-1.4` and the object table, in
// the editor, numbered. The viewer was never what decided: `openFile` in
// daimond.js is, and nothing drove it. It asked "do these bytes decode as
// characters", which the front of a PDF with no binary comment does. The last
// section therefore opens files the way a person does and reads `#pv-view`.
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
//   * `viewer.js`, `editable`: return `!!(info && info.chars)` -- which is what
//     `openFile` used to ask -- and the PDF with no binary comment goes red in
//     the Doc panel section while the one with a comment stays green. That pair
//     is the shipped bug, exactly. (Run: 2 checks FAILED, both of them that PDF.)
//   * `viewer.js`, `handlerFor` is NOT what the Doc panel routes on, so breaking
//     it moves nothing in that section. `editable` is the one to reach for.
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

/// A COMPLETE, VALID PDF: one page carrying a black square, and ASCII throughout.
///
/// It used to be a fragment with no cross-reference table and no page contents,
/// under a comment saying that nothing here asserts it RENDERS. That is the hole
/// this fixture closes. Every PDF check was green for months while the browser
/// drew a grey box with a broken-page glyph in it, because the panel framed the
/// file with a `sandbox` attribute and a sandboxed frame may not reach Chrome's
/// PDF viewer. A file that cannot render is no use for finding that out.
///
/// Built rather than pasted, because the cross-reference table carries byte
/// offsets into the file: written by hand they go stale on the first edit, and
/// Chrome silently rebuilds a broken table, so the check would pass for the
/// wrong reason exactly when the fixture was wrong.
///
/// `comment` is the binary comment line most producers write after the header,
/// and it is optional in the format. With it, the first 512 bytes are not valid
/// UTF-8 and the file reads as binary; without it they are characters, and that
/// difference is the whole of the Doc panel bug below. The offsets are computed
/// after it is inserted, so both files are valid rather than one of them being
/// the other with four bytes wedged into the middle.
function buildPdf(comment) {
	const stream = '0 0 0 rg\n20 20 160 160 re\nf\n';
	const objs = [
		'<< /Type /Catalog /Pages 2 0 R >>',
		'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
		'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>',
		'<< /Length ' + stream.length + ' >>\nstream\n' + stream + 'endstream',
	];
	let out = '%PDF-1.4\n' + (comment ? '%' + comment + '\n' : '');
	const at = [];
	objs.forEach((o, i) => {
		at.push(out.length);
		out += (i + 1) + ' 0 obj\n' + o + '\nendobj\n';
	});
	const startxref = out.length;
	out += 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n';
	at.forEach((n) => { out += String(n).padStart(10, '0') + ' 00000 n \n'; });
	out += 'trailer\n<< /Size ' + (objs.length + 1) + ' /Root 1 0 R >>\n'
		+ 'startxref\n' + startxref + '\n%%EOF\n';
	return out;
}
const PDF = ascii(buildPdf(''));

// An HTML page, which is the OTHER thing that used to share the framed tier and
// is now the only thing in it. The sandbox argument is about this file and was
// never about the PDF: a `blob:` URL inherits our origin, so a page an agent
// wrote after reading the web would run as the app. Splitting the two would
// have left that rule with nothing testing it.
const HTML = ascii('<!doctype html><html><body><p>a page</p></body></html>');

// The SAME PDF with the binary comment most producers write on its second line,
// which is four bytes that are not valid UTF-8.
//
// The pair is the point, and it is why the Doc panel checks below need two
// files. The comment is OPTIONAL in the format, and a PDF that omits it and
// carries no compressed stream in its first 512 bytes reads as characters --
// 19 of the 1044 PDFs on the author's disk do. The panel routed on that reading
// and put such a file in its EDITOR, `%PDF-1.4` and all, which is the bug this
// section exists for. A file with the comment took the other branch, so every
// PDF anyone happened to test with worked.
const PDF_BINCOMMENT = ascii(buildPdf('âãÏÓ'));

// A file with no extension at all, whose bytes are plainly characters: what
// `Makefile` and `LICENSE` are, and they must stay in the editor.
//
// The name says nothing, so the answer rests entirely on `Media::sniff` falling
// back to `Media::Text` for a run of characters it recognises nothing else in.
// The fix to the PDF routing leans on that fallback, so this fixture is what
// holds it up: if fe2o3 ever stops making it, this check is what goes red.
const NOEXT = ascii('all: build\n\tcargo build\n');

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
	const em  = root.querySelector('embed');
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
		// `sandbox` is read as an ATTRIBUTE, so its absence is null rather than
		// the empty string an absent property would give -- and absent is the
		// claim being made about it here.
		embed:     em ? {
			type:    em.getAttribute('type'),
			sandbox: em.getAttribute('sandbox'),
			blob:    em.src.slice(0, 5),
		} : null,
		lostBytes: /�/.test(root.textContent || ''),
	};
});

/// WHAT IS ACTUALLY ON SCREEN INSIDE `sel`, as a census of light and dark.
///
/// EVERY OTHER CHECK IN THIS FILE READS THE DOM, AND THE DOM CANNOT TELL A
/// RENDERED DOCUMENT FROM A BROKEN ONE. Both are an element with a `blob:` URL
/// on it. That is exactly how a PDF that had never once appeared passed five
/// green checks for months: the panel drew a flat grey box with a broken-page
/// glyph in the middle of it and named the format helpfully above.
///
/// The two numbers separate those states with room to spare. A page that
/// rendered has PAPER (near-white) and INK (near-black) on it, and the viewer
/// puts its own dark furniture around them. The broken box is one flat grey:
/// nothing is near-white, nothing is near-black.
///
/// Playwright hands back a PNG and node here has no image library, so the page
/// decodes its own screenshot -- a `data:` URL of our own bytes, onto a canvas.
///
/// # Arguments
/// * `sel` - A CSS selector for the element to look at.
const inkCensus = async (sel) => {
	const box = await page.locator(sel).boundingBox().catch(() => null);
	if (!box) return null;
	const png = await page.screenshot({ clip: box, timeout: 15000 }).catch(() => null);
	if (!png) return null;
	return page.evaluate((b64) => new Promise((res) => {
		const img = new Image();
		img.onload = () => {
			const c = document.createElement('canvas');
			c.width = img.naturalWidth; c.height = img.naturalHeight;
			const g = c.getContext('2d');
			g.drawImage(img, 0, 0);
			const d = g.getImageData(0, 0, c.width, c.height).data;
			let dark = 0, light = 0, n = 0;
			for (let i = 0; i < d.length; i += 4) {
				const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
				if (l < 40) dark++; else if (l > 230) light++;
				n++;
			}
			res({ dark: dark / n, light: light / n, px: n });
		};
		img.onerror = () => res(null);
		img.src = 'data:image/png;base64,' + b64;
	}), png.toString('base64'));
};

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

	// ── A PDF goes to the browser's own viewer ───────────────────
	//
	// And NOT into the sandboxed frame, which is where it went for months: a
	// sandbox attribute of any value stops Chrome instantiating the PDF viewer,
	// so the panel drew a grey box with a broken-page glyph and named the format
	// helpfully above it.
	await put('view/doc.pdf', PDF);
	await view('view/doc.pdf');
	const doc = await seen();
	check(!!doc && doc.handler === 'doc', 'a PDF goes to the browser’s document viewer',
		doc ? doc.handler : 'nothing rendered');
	check(!!(doc && doc.embed && doc.embed.type === 'application/pdf'
			&& doc.embed.blob === 'blob:'),
		'on an element that names the type, so nothing has to sniff it',
		doc && doc.embed ? JSON.stringify(doc.embed) : 'no embed');
	// What keeps a file from running as the app here is the BLOB'S TYPE and not a
	// sandbox -- see the note on `doc` in viewer.js, where it is measured. A
	// sandbox on this element would take the viewer away again, so its ABSENCE is
	// what has to be pinned.
	check(!!(doc && doc.embed && doc.embed.sandbox === null),
		'and carries no sandbox, which would take that viewer away',
		doc && doc.embed ? String(doc.embed.sandbox) : 'no embed');

	// ── An HTML page IS framed, and the frame is a cell ──────────
	//
	// This is the tier the PDF left, and the sandbox rule was always about this
	// file: a `blob:` URL inherits our origin, so a page an agent wrote after
	// reading the web would otherwise run as the app, read `localStorage` where
	// the API key is, and reach OPFS.
	await put('view/page.html', HTML);
	await view('view/page.html');
	const web = await seen();
	check(!!web && web.handler === 'frame', 'an HTML file is drawn in a frame',
		web ? web.handler : 'nothing rendered');
	// The whole attribute, not a search for the bad tokens: a check that asks
	// "does it contain allow-same-origin" passes on a sandbox that has gained
	// allow-popups instead.
	check(!!(web && web.frame && web.frame.sandbox === 'allow-scripts'),
		'and the frame is sandboxed to allow-scripts and nothing else',
		web && web.frame ? JSON.stringify(web.frame.sandbox) : 'no frame');

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
	//
	// THE CATALOGUE IS THE AUTHORITY, and it was not always. `fileview.hex_prev`
	// and `fileview.hex_next` were absent from `i18n/en.js` until 2026-08-11, so
	// this held 'Earlier bytes' and 'Later bytes' itself and compared the buttons
	// against its own copy. A check carrying its own wording goes on passing after
	// the catalogue's wording changes -- it stops asking about the app and starts
	// asking about itself. A key the catalogue has not got is now a FAILURE here,
	// which is what it should have been: the panel would be showing a raw key.
	const paging = await page.evaluate(() => {
		const cat = (k) => {
			const s = window.DaimondI18n ? window.DaimondI18n.t(k) : null;
			return (s == null || s === k) ? null : s;
		};
		const want = ['fileview.hex_prev', 'fileview.hex_next'].map((k) => ({ key: k, said: cat(k) }));
		const say  = Array.from(document.querySelectorAll('#fv-host .fv-hexbar .fv-btn'))
			.map((b) => b.textContent);
		return { want, say, ok: want.every((w) => w.said !== null && say.indexOf(w.said) !== -1) };
	});
	check(paging.ok, 'the dump can be walked forwards and back, by controls the catalogue names',
		paging.ok ? '' : JSON.stringify(paging));

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
	check(!!liar && liar.handler === 'doc', 'the bytes win: it is shown as the PDF it is',
		liar ? liar.handler : 'nothing rendered');
	check(!!(liar && liar.disagree && /png/i.test(liar.disagree) && /pdf/i.test(liar.disagree)),
		'and one line names both the name’s claim and the bytes’ evidence',
		liar && liar.disagree ? liar.disagree : 'no line');
	// The name is not what decides which element it lands in, and this is the
	// case that proves it: the type on the element comes from the BYTES, so a
	// `.pdf` full of HTML would go to the sandboxed frame instead.
	check(!!(liar && liar.embed && liar.embed.type === 'application/pdf'),
		'and the element is typed from the bytes, not from the name',
		liar && liar.embed ? JSON.stringify(liar.embed.type) : 'no embed');

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

	// ── THE DOC PANEL, WHICH IS THE DOOR THE USER ACTUALLY OPENS ─
	//
	// Everything above drives `DaimondViewer` into a host of the test's own, and
	// every one of those checks was green while clicking a PDF in the Workspace
	// tree showed `%PDF-1.4` in a <pre>. The viewer was never the thing that
	// decided; `openFile` in daimond.js decides, and nothing drove it. So this
	// section clicks the row.
	//
	// The four fixtures are the whole of the routing question, and each one is
	// there because getting it wrong is a bug somebody has already shipped:
	//
	//   * a PDF WITHOUT the binary comment -- characters, and not for editing;
	//   * a PDF WITH it -- the case that always worked, so a fix that only moves
	//     the boundary is caught rather than congratulated;
	//   * a Markdown file -- which must keep the EDITOR, because `DAIMOND.md` and
	//     `prompts/*.md` are edited here and routing on the viewer's handler once
	//     took that away;
	//   * a file with no extension -- no format to go on, so the bytes alone
	//     decide and the answer is the editor.
	await put('panel-plain.pdf', PDF);
	await put('panel-comment.pdf', PDF_BINCOMMENT);
	await put('panel-notes.md', MD);
	await put('panel-recipe', NOEXT);

	await page.evaluate(() => { try { DaimondPanels.show('work'); } catch (e) { /* mobile shell */ } });
	await page.waitForTimeout(600);
	// The tree was drawn before those writes, so it is relisted through the
	// panel's own Refresh rather than by calling in.
	await page.evaluate(() => {
		const r = document.querySelector('.files-actions [data-act="refresh"]');
		if (r) r.click();
	});
	await page.waitForTimeout(800);

	/// Click a row in the Workspace tree and say what the PREVIEW panel then holds.
	///
	/// `#pv-view` and not the test's own host: the claim is about the panel. It was
	/// `#doc-view` until the Doc panel was split in two — a file that is not
	/// characters is a RENDERING, and renderings go to the Preview panel so that
	/// whatever is being edited can stay on screen beside them. `pre` still reads the
	/// DOC panel, because "not one character of it reaches the editor" is a claim
	/// about the editor.
	const inPanel = async (name) => {
		const clicked = await page.evaluate((n) => {
			const r = document.querySelector('.files-tree .files-row[data-path="' + n + '"]');
			if (!r) return false;
			r.click();
			return true;
		}, name);
		await page.waitForTimeout(1200);
		const got = await page.evaluate(() => {
			const fv  = document.querySelector('#pv-view .fileview');
			const pre = document.querySelector('#doc-view .files-view-body');
			return {
				viewer: fv ? fv.getAttribute('data-viewer') : null,
				frame:  !!document.querySelector('#pv-view .fileview iframe'),
				embed:  !!document.querySelector('#pv-view .fileview embed'),
				pre:    pre ? pre.textContent.slice(0, 80) : null,
			};
		});
		got.clicked = clicked;
		return got;
	};

	const plain = await inPanel('panel-plain.pdf');
	check(plain.clicked && plain.viewer === 'doc' && plain.embed === true,
		'clicking a PDF with no binary comment sends it to the document viewer',
		JSON.stringify(plain));
	check(plain.pre === null,
		'and not one character of it reaches the editor',
		plain.pre === null ? 'no <pre>' : JSON.stringify(plain.pre));

	// AND THE PAGE IS ON THE SCREEN. Everything above this line was true while
	// the panel showed a grey box with a broken-page glyph in it.
	// The threshold is 2%, and it is set from a measurement of both states over
	// the same file: the sandboxed frame this replaces scores 0.00% dark and
	// 0.00% light -- not "nearly none", none, because a flat grey box has no
	// near-black and no near-white pixel in it at all -- and this fixture,
	// rendered, scores about 46% and 25%. Anywhere in that gap would do.
	await page.waitForTimeout(2500);		// the viewer loads and paints
	const ink = await inkCensus('#pv-view .fv-doc');
	check(!!ink && ink.dark > 0.02 && ink.light > 0.02,
		'and the page is drawn: there is ink on paper where the PDF is',
		ink ? `dark ${(ink.dark * 100).toFixed(1)}%, light ${(ink.light * 100).toFixed(1)}%`
			: 'nothing to measure');

	// AND IT FILLS THE PANEL. Everything inside the viewer is written to stretch,
	// but the box the panel draws it into had no rule of its own, so the chain
	// collapsed to the content's height -- an <embed>'s default 150px. A document
	// in a letterbox with empty panel beneath it is not "showing the PDF", and no
	// check that reads the DOM would ever have noticed.
	const fills = await page.evaluate(() => {
		const e = document.querySelector('#pv-view .fv-doc');
		const p = document.getElementById('pv-view');
		if (!e || !p) return null;
		return { doc: e.getBoundingClientRect().height, panel: p.getBoundingClientRect().height };
	});
	check(!!fills && fills.panel > 200 && fills.doc / fills.panel > 0.6,
		'and it fills the panel rather than sitting in a letterbox',
		fills ? `${Math.round(fills.doc)}px of ${Math.round(fills.panel)}px` : 'nothing to measure');

	const withComment = await inPanel('panel-comment.pdf');
	check(withComment.clicked && withComment.viewer === 'doc' && withComment.embed === true,
		'and the ordinary kind of PDF still does too',
		JSON.stringify(withComment));

	const md = await inPanel('panel-notes.md');
	check(md.clicked && md.pre !== null && /Heading/.test(md.pre || ''),
		'Markdown keeps the editor, which is where DAIMOND.md is changed',
		JSON.stringify(md));

	const noext = await inPanel('panel-recipe');
	check(noext.clicked && noext.pre !== null && /cargo build/.test(noext.pre || ''),
		'and so does a file with no extension to recognise',
		JSON.stringify(noext));
} finally {
	await s.close();
}

console.log(bad ? `\n${bad} check(s) FAILED` : '\nall checks passed');
process.exit(bad ? 1 : 0);
