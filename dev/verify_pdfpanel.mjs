// gateway: none
// A `.pdf` opens in the PDF viewer, its Download yields the file, and the Preview
// panel shows one thing at a time (PDF-PANEL, D-20261011-34).
//
// THE DRIVE THAT FOUND IT (ontheism-b, zoapedia-hachiko-typst, 12 Oct). With the
// live typeset pages following `hachiko.typ`, opening the real `hachiko.pdf` put
// the PDF viewer and the live pages into the Preview panel together: the header
// named `hachiko.pdf`, the live view's next stand-in hid the viewer, and what was
// left on screen was the live layout of the source -- so the true export could
// not be seen in-app, and the panel's Download button sat hidden with the viewer.
// austenite-b saw the other half of the same fault: a one-line PDF strip above a
// "Live preview" inside one tile.
//
// THE FIXTURE MAKES THE TWO RENDERINGS DISAGREE. `doc.typ` is the long source;
// `doc.pdf` beside it is compiled from a one-page variant. The viewer's own bytes
// are fetched and must be the PDF's, page count and all, which is the symptom the
// drive reported (5 pages on screen for a 2-page PDF).
//
// ENGINES. Playwright's WebKit has no OPFS (`navigator.storage.getDirectory` is
// absent), so a WebKit context cannot hold the workspace the panel reads from.
// There the panel half is NAMED on the count line as not run, never skipped in
// silence, and what WebKit can prove is proved: the one hand-over yields the
// file, which is the half of the fix that was about WebKit (a URL revoked on
// the line after the click).
//
// Run: eval "$(bash dev/world.sh N --env)"; node dev/verify_pdfpanel.mjs
//      DAIMOND_BROWSER=webkit node dev/verify_pdfpanel.mjs
import fs from 'node:fs';
import { open, shot, scratch, errors, BROWSER } from './harness.mjs';
import { guardRan } from './verdict.mjs';

const ok = [], bad = [], cant = [];
const cannot = (name, why) => { cant.push(name); console.log('  n/a  ' + name + ' — ' + why); };
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/// Pages in a PDF, counted off its page objects. typst writes an uncompressed
/// object table, so `/Type /Page` (not `/Pages`) is one per page.
const pagesOf = (buf) => (Buffer.from(buf).toString('latin1').match(/\/Type\s*\/Page(?![s\w])/g) || []).length;

const LONG = `#set page(width: 120mm, height: 160mm, margin: 12mm)
= The live source
#lorem(1200)
`;
const SHORT = `#set page(width: 120mm, height: 160mm, margin: 12mm)
= The exported copy
One page only.
`;

const PROFILE = scratch('pw', 'pdfpanel-' + BROWSER);
fs.rmSync(PROFILE, { recursive: true, force: true });
const OUT = scratch('pdfpanel-' + BROWSER, 'dl');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const s = await open({ name: 'pdfpanel', profile: PROFILE });
const { page } = s;
await page.waitForTimeout(1200);
await page.setViewportSize({ width: 1700, height: 950 });

const st = () => page.evaluate(() => window.DaimondTypstWatch.state());

/// Which of the Preview panel's three renderings are on screen, by rendered box.
const panes = () => page.evaluate(() => {
	const seen = (el) => {
		if (!el || !el.isConnected) return false;
		const r = el.getBoundingClientRect();
		return r.width > 4 && r.height > 4 && getComputedStyle(el).visibility !== 'hidden';
	};
	const live = document.getElementById('typst-live');
	const view = document.getElementById('pv-view');
	const emb  = document.getElementById('doc-embed');
	const vemb = view ? view.querySelector('embed.fv-doc') : null;
	return {
		live:  seen(live),
		view:  seen(view),
		embed: seen(emb),
		viewDoc: seen(vemb),
		name:  (document.getElementById('pv-name') || {}).textContent || '',
		src:   vemb ? vemb.getAttribute('src') || '' : '',
	};
});

/// Click `btn` and take what the browser saves. The listener is armed first and its
/// rejection held, so a click that never lands is a failed check, not a crash.
async function download(click) {
	const dl = page.waitForEvent('download', { timeout: 10000 });
	dl.catch(() => {});
	try {
		await click();
		const d = await dl;
		const to = OUT + '/' + d.suggestedFilename();
		await d.saveAs(to);
		return { name: d.suggestedFilename(), bytes: fs.readFileSync(to) };
	} catch (e) { return { why: String(e && e.message || e).slice(0, 200) }; }
}

const opfs = await page.evaluate(() => !!(navigator.storage && navigator.storage.getDirectory));

try {
	if (!opfs) {
		cannot('the .pdf beside its .typ: viewer, one pane, live view idle, panel Download, Compile again',
			'Playwright\u2019s WebKit has no OPFS, so there is no workspace to open a file from');
		// The hand-over itself, on bytes the page holds.
		const bytes = await page.evaluate(() => Array.from(new TextEncoder().encode('%PDF-1.7\n% pdfpanel webkit\n%%EOF\n')));
		const want = Buffer.from(bytes);
		const pub = await page.evaluate(() => !!(window.DaimondViewer && typeof window.DaimondViewer.handOver === 'function'));
		check('the app has one hand-over for a download (DaimondViewer.handOver)', pub);
		const got = pub ? await download(() => page.evaluate((b) =>
			window.DaimondViewer.handOver(new Uint8Array(b), 'application/pdf', 'doc.pdf'), bytes)) : { why: 'no hand-over' };
		check('the hand-over yields the file on WebKit, byte for byte',
			!!got.bytes && got.name === 'doc.pdf' && Buffer.compare(got.bytes, want) === 0,
			got.bytes ? `${got.name}, ${got.bytes.length} bytes` : got.why);
		throw null;	// to the error and count lines
	}
	// ── The exported copy, compiled from a one-page source ───────────
	const made = await page.evaluate(async ({ SHORT, LONG }) => {
		const m = await import('/pkg/oxedyne_daimond.js');
		await m.write_file('proj/doc.typ', SHORT);
		const out = await m.typst_compile_project('proj/doc.typ');
		if (!out || !out.pdf) return { err: String(out && out.error) };
		// The same byte door the panel's Compile writes through (`writeWorkspaceBytes`).
		const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
		await app.write_bytes('proj/doc.pdf', out.pdf);
		await m.write_file('proj/doc.typ', LONG);
		return { bytes: Array.from(out.pdf) };
	}, { SHORT, LONG });
	const pdf = Buffer.from(made.bytes || []);
	const pdfPages = pagesOf(pdf);
	check('the fixture: a real one-page doc.pdf beside a longer doc.typ',
		pdfPages === 1, made.err || `${pdf.length} bytes, ${pdfPages} page(s)`);
	// The compile above went through the page's own door and so armed the watch on
	// the one-page source. Stopped, so the press below is the one that arms it.
	await page.evaluate(() => window.DaimondTypstWatch.stop());

	// ── The source open, Compiled, its live pages following it ──────
	await page.evaluate(() => window.DaimondDoc.show('proj/doc.typ'));
	await page.waitForTimeout(1200);
	await page.click('[data-act="compile"]', { force: true });
	// The pages are drawn one at a time; wait until the count has stopped moving.
	let s0 = await st(), still = 0;
	for (let i = 0; i < 90 && still < 4; i++) {
		await sleep(500);
		const q = await st();
		still = (q.drawn && q.pages === s0.pages) ? still + 1 : 0;
		s0 = q;
	}
	// Live and drawn, on the source. Not a page count: the live view's own count is
	// the renderer's, and the two renderings are told apart below by the bytes the
	// viewer holds, which are the PDF's or nothing.
	check('Compile arms the live view on the source',
		s0.mode === 'live' && s0.path === 'proj/doc.typ' && s0.drawn >= 1,
		JSON.stringify({ mode: s0.mode, path: s0.path, pages: s0.pages }));

	// ── Open the PDF itself ──────────────────────────────────────────
	await page.evaluate(() => window.DaimondDoc.show('proj/doc.pdf'));
	for (let i = 0; i < 20 && !(await panes()).viewDoc; i++) await sleep(250);
	// Settle past one poll of the watch: a stand-in that comes back on the next
	// rebuild is the drive's own symptom.
	await page.evaluate(async () => {
		const m = await import('/pkg/oxedyne_daimond.js');
		await m.write_file('proj/doc.typ', '#set page(width: 120mm, height: 160mm, margin: 12mm)\n= Edited\n#lorem(420)\n');
		window.dispatchEvent(new CustomEvent('daimond-file-written', { detail: { path: 'proj/doc.typ' } }));
	});
	await sleep(4000);
	const p1 = await panes();
	await shot(s, 'pdfpanel-opened-' + BROWSER);
	check('the .pdf opens in the PDF viewer, by file type',
		p1.viewDoc && /doc\.pdf$/.test(p1.name), JSON.stringify(p1));
	check('ONE TILE SHOWS ONE THING: the live pages are not on screen with the PDF',
		p1.view && !p1.live && !p1.embed, JSON.stringify({ live: p1.live, view: p1.view, embed: p1.embed }));
	const s1 = await st();
	check('and the live view let go of the panel rather than rebuilding behind it',
		s1.mode === 'idle', JSON.stringify({ mode: s1.mode, path: s1.path }));
	const shown = await page.evaluate(async (src) => {
		if (!src) return [];
		const r = await fetch(src.replace(/#.*$/, ''));
		return Array.from(new Uint8Array(await r.arrayBuffer()));
	}, p1.src);
	const shownBuf = Buffer.from(shown);
	check('the viewer holds the exported PDF itself, with the PDF\'s page count',
		shownBuf.length === pdf.length && pagesOf(shownBuf) === pdfPages,
		`${shownBuf.length} bytes, ${pagesOf(shownBuf)} page(s) vs ${pdf.length}, ${pdfPages}`);

	// ── Download yields the file ─────────────────────────────────────
	const btn = page.locator('#pv-view [data-act="download"]');
	check('the PDF panel\'s Download is on screen', await btn.isVisible());
	const got = await download(() => btn.click({ timeout: 5000 }));
	check('Download yields the file, byte for byte',
		!!got.bytes && got.name === 'doc.pdf' && Buffer.compare(got.bytes, pdf) === 0,
		got.bytes ? `${got.name}, ${got.bytes.length} bytes` : got.why);

	// ── Compiling again takes the panel back, and says so ────────────
	await page.evaluate(() => window.DaimondDoc.show('proj/doc.typ'));
	await page.waitForTimeout(1200);
	await page.click('[data-act="compile"]', { force: true });
	for (let i = 0; i < 90; i++) {
		const q = await st();
		if (q.mode === 'live' && q.drawn) break;
		await sleep(500);
	}
	await sleep(1500);
	const p2 = await panes();
	check('Compile again: the live pages take the panel and the PDF steps aside',
		p2.live && !p2.view && !p2.embed && /doc\.typ$/.test(p2.name), JSON.stringify(p2));

} catch (e) {
	if (e !== null) check('the run completed', false, String(e && e.stack || e).slice(0, 400));
}
try {
	// This world runs no gateway (`gateway: none`), so the app's own /api calls are
	// answered 502 by the dev server; that is the world, not the panel.
	const errs = errors(s).filter(e => !/status of 502 \(Bad Gateway\) https?:\/\/[^/]+\/api\//.test(e));
	check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
} finally {
	await s.close();
}

guardRan(ok.length + bad.length);
console.log(`\n${ok.length} ok, ${bad.length} failed` + (cant.length ? `, ${cant.length} not run` : '') + ` (${BROWSER})`);
process.exit(bad.length ? 1 : 0);
