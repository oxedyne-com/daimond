// verify_typstwatch.mjs — the watched live document: it follows the file, it keeps
// the reader's place, it never blanks, and it refuses rather than bricking.
//
// The author's ask was `typst watch` plus a document viewer, inside Daimond: he
// edits a `.typ` — or a daimon does — and the pages he is looking at become the new
// ones, in place. What that turns into is a loop, and a loop has failure modes a
// button does not:
//
//   1. IT MUST FOLLOW BOTH ACTORS. His editor and a daimon's `file_write` both
//      count as "the source changed". Asserted by the WORDS ON THE PAGE, read back
//      out of the rendered document, not by a counter that could tick for any
//      reason.
//
//   2. IT MUST NOT MOVE HIM. A rebuild puts the new pages up at the page and the
//      offset he was reading, not at the top and not at "the same fraction of a
//      longer book".
//
//   3. IT MUST NEVER BLANK. Not for one frame. This is the check the whole design
//      rests on, so it is measured on EVERY ANIMATION FRAME across a rebuild
//      rather than sampled before and after — a swap that empties the host for two
//      frames is invisible to a check that looks at either end, and is exactly what
//      a reader notices. The frame count is asserted too: a sampler that saw three
//      frames did not watch a rebuild and proves nothing.
//
//   4. A BROKEN SOURCE MUST COST HIM NOTHING BUT THE ERROR. The last good pages
//      stay, with typst's own words — file and line — under them. That is the whole
//      reason `typst watch` is usable, and it is asserted against the compiler's
//      real diagnostic, not against a string this file made up.
//
//   5. IT MUST REFUSE RATHER THAN BRICK. Measured in dev/TYPST_WATCH.md: one
//      document too big for the wasm heap traps the compiler, and EVERY LATER
//      COMPILE then fails with `recursive use of an object detected`, for the life
//      of the page. A one-shot button hides that; a loop finds it. So the loop
//      budgets the heap and stops before the wall, and that is checked at the
//      limit rather than assumed from the code.
//
// AND THE CLAIM THE WHOLE RENDERING RESTS ON, CHECKED AGAINST AN OUTSIDE TOOL.
// The live view is NOT a PDF — writing the PDF costs about eight times what laying
// the pages out does, and Chrome's PDF viewer will not say where the reader is. The
// user's condition was "as long as it looks precisely the same". So one page is
// compiled both ways from one source, the PDF is rasterised by POPPLER — which has
// nothing to do with typst, and is the only thing here that is not our own code
// agreeing with itself — the live view is photographed at the same size, and the
// ink is compared. Anti-aliasing differs. Nothing structural may.
//
// EACH CHECK IS PROVED AGAINST BROKEN CODE FIRST. `--break <name>` serves a
// deliberately damaged copy of a real source file to the real page, and the run is
// expected to FAIL. A break whose anchor does not appear exactly once aborts rather
// than passing quietly.
//
//   node dev/verify_typstwatch.mjs --break nonudge      # 1 fails: nothing follows the file
//   node dev/verify_typstwatch.mjs --break resetscroll  # 2 fails: back to the top
//   node dev/verify_typstwatch.mjs --break blank        # 3 fails: a frame with no ink
//   node dev/verify_typstwatch.mjs --break dropgood     # 4 fails: the good pages go
//   node dev/verify_typstwatch.mjs --break stickyerror  # 5 fails: the error never clears
//   node dev/verify_typstwatch.mjs --break nodebounce   # 6 fails: a burst is a burst
//   node dev/verify_typstwatch.mjs --break nostop       # 7 fails: it compiles after closing
//   node dev/verify_typstwatch.mjs --break noguard      # 8 fails: it walks into the wall
//   node dev/verify_typstwatch.mjs --break skewpages    # 9 fails: the pages are not the PDF
//   node dev/verify_typstwatch.mjs --break tallsvg     # 10 fails: a page deep in the book
//                                                     #    is a pale wash
//   node dev/verify_typstwatch.mjs --break versionskew # 11 fails: the two wasms disagree
//   node dev/verify_typstwatch.mjs                      # and then, clean
//
//   eval "$(bash dev/world.sh 13 --up)"
//   node dev/verify_typstwatch.mjs
//
// Needs dev/serve.mjs and `pdftoppm` (poppler-utils). No gateway, no model: every
// compile here is the real vendored typst, and the only network is localhost.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { open, shot, scratch, errors } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

const PROFILE = scratch('pw', 'typstwatch' + (BREAK ? '-' + BREAK : ''));
fs.rmSync(PROFILE, { recursive: true, force: true });
const WORK = scratch('typstwatch' + (BREAK ? '-' + BREAK : ''), 'ink');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

// ── The breaks ───────────────────────────────────────────────────────
// Each is a real edit to a real file, served in place of it.
const BREAKS = {
	// Neither actor reaches the loop: the poll finds nothing and a write says
	// nothing. The view then only ever changes when a person presses Compile,
	// which is the state this feature exists to leave behind.
	nonudge: [{
		file: 'js/typstwatch.js',
		find: 'function nudge(cause, detail) {\n\tif (S.mode !== \'live\') return;',
		with: 'function nudge(cause, detail) {\n\tif (S.mode !== \'live\' || true) return;',
	}],
	// The rebuild lands at the top of the document, throwing away the reader's
	// place. This is what a naive swap does, and it is why `where`/`goTo` exist.
	resetscroll: [{
		file: 'js/typstwatch.js',
		find: '\tif (was) goTo(was); else if (sc) sc.scrollTop = 0;',
		with: '\tif (sc) sc.scrollTop = 0;',
	}],
	// The host is emptied before the new pages are ready — one or two frames of
	// nothing, which is invisible to any check that looks only before and after.
	blank: [{
		file: 'js/typstwatch.js',
		find: '\tconst pages = host.querySelector(\'.tl-pages\');\n'
			+ '\t// The geometry has to be in place before a window can be asked for, since',
		with: '\tconst pages = host.querySelector(\'.tl-pages\');\n'
			+ '\tpages.shadowRoot.replaceChildren();\n'
			+ '\tawait new Promise(function (res) { requestAnimationFrame(function () { '
			+ 'requestAnimationFrame(res); }); });\n'
			+ '\t// The geometry has to be in place before a window can be asked for, since',
	}],
	// A failed build takes the document with it. The reader loses the page they were
	// reading every time a brace is mistyped.
	//
	// It throws away the KEPT BYTES as well as the marks, and that is not belt and
	// braces — it is what "the last good view is not kept" means. Emptying only the
	// DOM does not go red, because showing the error grows the error strip, the
	// scroller resizes, and the repaint that follows draws the pages again out of the
	// bytes. Worth knowing: the view heals itself from a stray blanking. It cannot
	// heal from having nothing to draw.
	dropgood: [{
		file: 'js/typstwatch.js',
		find: '\t\tS.failed++;\n\t\tconst why = (out && out.error) ? String(out.error) : tOr(\'typst.watch.nothing\',',
		with: '\t\tS.failed++;\n\t\tvec = null;\n'
			+ '\t\thost.querySelector(\'.tl-pages\').shadowRoot.replaceChildren();\n'
			+ '\t\tconst why = (out && out.error) ? String(out.error) : tOr(\'typst.watch.nothing\',',
	}],
	// The error outlives the fault: the source is right again and the screen still
	// says it is wrong, which teaches a reader to stop believing the message.
	stickyerror: [{
		file: 'js/typstwatch.js',
		find: '\t\t\tshowError(\'\');\n'
			+ '\t\t\t// A HELD LOOP IS NOT UNHELD BY A BUILD SUCCEEDING.',
		with: '\t\t\t// A HELD LOOP IS NOT UNHELD BY A BUILD SUCCEEDING.',
	}],
	// Every write is its own rebuild. A fast typist queues twenty compiles and the
	// preview runs minutes behind the text.
	nodebounce: [{
		file: 'js/typstwatch.js',
		find: '\tif (timer) clearTimeout(timer);\n\ttimer = setTimeout(function () { timer = null; build(false); }, S.debounce);',
		with: '\tbuild(false);',
	}],
	// Closing the document does not end the watch, so the compiler keeps working on
	// a file nobody is looking at.
	nostop: [{
		file: 'js/typstwatch.js',
		find: '\tif (S.seen && !shown) {\n\t\tstop();\n\t\treturn;\n\t}',
		with: '\tif (false) { stop(); return; }',
	}],
	// No budget at all: the loop starts a rebuild whatever the heap says, which is
	// how it eventually finds the wall and dies there.
	noguard: [{
		file: 'js/typstwatch.js',
		find: '\tif (heap + S.headroom <= S.budget) return \'\';',
		with: '\tif (true) return \'\';',
	}],
	// The pages are drawn at the wrong scale. Nothing reflows and every glyph is
	// still there, so a check counting elements passes — only the INK says so.
	skewpages: [{
		file: 'js/typstwatch.js',
		find: '\tel.setAttribute(\'viewBox\', \'0 \' + lo + \' \' + docW + \' \' + (hi - lo));',
		with: '\tel.setAttribute(\'viewBox\', \'0 \' + (lo - 14) + \' \' + docW + \' \' + (hi - lo));',
	}],
	// The SVG is made as tall as the whole book again, with only the visible band
	// drawn in it — which is the obvious way to do this and the way that fails. Every
	// mark is still in the DOM and the page count is still right; the pixels are what
	// go wrong, and only past about thirty thousand of them down.
	tallsvg: [{
		file: 'js/typstwatch.js',
		find: '\tel.setAttribute(\'viewBox\', \'0 \' + lo + \' \' + docW + \' \' + (hi - lo));\n'
			+ '\tel.setAttribute(\'width\', String(docW * scale));\n'
			+ '\tel.setAttribute(\'height\', String((hi - lo) * scale));',
		with: '\tel.setAttribute(\'viewBox\', \'0 0 \' + docW + \' \' + docH);\n'
			+ '\tel.setAttribute(\'width\', String(docW * scale));\n'
			+ '\tel.setAttribute(\'height\', String(docH * scale));',
	}, {
		file: 'js/typstwatch.js',
		find: '\tnode.style.top = (lo * scale) + \'px\';',
		with: '\tnode.style.top = \'0px\';',
	}],
	// Not a page break at all: the version check is asked about the wrong pair of
	// files, which is the shape of somebody upgrading one wasm and not the other.
	versionskew: [],
};

if (BREAK && !BREAKS[BREAK]) {
	console.error(`unknown break '${BREAK}'; one of: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}

/// The damaged source, or a hard stop. Nothing is served that was not verified to
/// differ from the file on disk.
function damaged(spec) {
	const src = fs.readFileSync(path.join(WWW, spec.file), 'utf8');
	const n = src.split(spec.find).length - 1;
	if (n !== 1) {
		console.error(`break '${BREAK}': the anchor appears ${n} times in ${spec.file}, `
			+ 'so nothing was broken and the run below would prove nothing.');
		process.exit(2);
	}
	return src.replace(spec.find, spec.with);
}

async function routes(page) {
	if (!BREAK) return;
	for (const spec of (BREAKS[BREAK] || [])) {
		const body = damaged(spec);
		await page.route('**/' + spec.file, r => r.fulfill({
			status: 200, contentType: 'application/javascript', body,
		}));
	}
}

// ── The two wasm modules are the same typst ──────────────────────────
//
// The renderer was vendored so the live view could draw the compiler's own layout.
// If the two are ever built from different typst source, the preview stops being a
// preview and starts being a plausible drawing of a different book — the same class
// of silent wrongness as a substituted font. Version NUMBERS would not settle it, so
// this reads the typst git checkout out of each wasm's own bytes.

/// Every distinct match of `re` in a file read as latin1.
function scan(file, re) {
	const text = fs.readFileSync(file).toString('latin1');
	const out = new Set();
	const g = new RegExp(re.source, 'g');
	let m;
	while ((m = g.exec(text)) !== null) out.add(m[0]);
	return [...out];
}

const V = path.join(WWW, 'vendor', 'typst');
const CHECKOUT = /checkouts\/typst-[0-9a-f]+\/[0-9a-f]{7}/;
{
	const compiler = path.join(V, 'typst_ts_web_compiler_bg.wasm');
	// Under `versionskew` the check is asked about the app's OWN wasm, which is not
	// typst at all — the shape of somebody upgrading one half of the pair.
	const rend = BREAK === 'versionskew'
		? path.join(WWW, 'pkg', 'oxedyne_daimond_bg.wasm')
		: path.join(V, 'typst_ts_renderer_bg.wasm');
	const a = scan(compiler, CHECKOUT);
	const b = scan(rend, CHECKOUT);
	check('the renderer is built from the compiler\'s own typst checkout',
		a.length === 1 && b.length === 1 && a[0] === b[0],
		`compiler ${JSON.stringify(a)} vs renderer ${JSON.stringify(b)}`);
	const ver = scan(compiler, /Typst \d+\.\d+\.\d+/);
	const assets = scan(compiler, /typst-assets-\d+\.\d+\.\d+/);
	check('and that checkout is the 0.14.2 the design note recorded',
		ver.includes('Typst 0.14.2') && assets.includes('typst-assets-0.14.2'),
		`${ver.join(', ')} / ${assets.join(', ')}`);
}

// The outside tool. Without it the ink comparison cannot be made at all, and a
// check that quietly skips is worse than one that fails.
let POPPLER = true;
try { execFileSync('pdftoppm', ['-v'], { stdio: 'pipe' }); }
catch (e) { POPPLER = false; }

// ── The fixture ──────────────────────────────────────────────────────
//
// A small book: a main file and two chapters, so an edit can be made to a chapter
// the reader is NOT looking at, and so the document is several pages long and a
// scroll position means something.

const MAIN = `#import "one.typ": one
#import "two.typ": two
#set page(width: 120mm, height: 160mm, margin: 12mm)
#set text(size: 10pt)
#set par(justify: true)
= The book
#one
#pagebreak()
#two
`;
const ONE = (w) => `#let one = [
== Chapter one
${w} lorem ipsum dolor sit amet, consectetur adipiscing elit.

#lorem(90)
]
`;
const TWO = (w) => `#let two = [
== Chapter two
${w} consectetur adipiscing elit, sed do eiusmod tempor.

#lorem(120)
]
`;

const s = await open({ name: 'typstwatch', profile: PROFILE, route: routes });
const { page } = s;
await page.waitForTimeout(1200);

/// Write one of the fixture's files through the app's own byte door, which is the
/// same door a daimon's `file_write` goes through.
const put = (p, text) => page.evaluate(async ({ p, text }) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	await m.write_file(p, text);
}, { p, text });

const st = () => page.evaluate(() => window.DaimondTypstWatch.state());
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/// The words actually on the page, read out of the rendered document.
///
/// typst.ts lays a transparent text layer over the glyph outlines so a reader can
/// select what they see, and that layer IS what is on screen. Asserting on it is
/// asserting on the document; asserting on a build counter is asserting that
/// something happened.
const words = () => page.evaluate(() => {
	const h = document.querySelector('#typst-live .tl-pages');
	if (!h || !h.shadowRoot) return '';
	return [...h.shadowRoot.querySelectorAll('.tsel')].map(e => e.textContent).join(' ');
});

/// How many marks — glyph outlines and shapes — are on screen right now.
const marks = () => page.evaluate(() => {
	const h = document.querySelector('#typst-live .tl-pages');
	return (h && h.shadowRoot) ? h.shadowRoot.querySelectorAll('use, path').length : -1;
});

try {
	await put('proj/main.typ', MAIN);
	await put('proj/one.typ', ONE('Alpha'));
	await put('proj/two.typ', TWO('Zulu'));

	// Wide enough for the ink comparison to mean something, and for the document to
	// be read the way it would be.
	await page.setViewportSize({ width: 1900, height: 1000 });

	// ── Opened and compiled the way a person does it ─────────────
	// Through the panel's own opener and the panel's own button. The watch is armed
	// by `src/wasm/typst.rs` inside that button's call; nothing here starts it.
	await page.evaluate(() => window.DaimondDoc.show('proj/main.typ'));
	await page.waitForTimeout(1200);
	const hasBtn = await page.$('[data-act="compile"]');
	check('the Doc panel offers Compile on a .typ file', !!hasBtn);
	await page.click('[data-act="compile"]', { force: true });
	// The cold compile builds the 27 MB compiler and the 1 MB renderer.
	for (let i = 0; i < 60 && !(await st()).drawn; i++) await sleep(500);

	const s0 = await st();
	check('COMPILING STARTS THE WATCH — no toggle was touched',
		s0.mode === 'live' && s0.path === 'proj/main.typ' && s0.drawn === 1,
		JSON.stringify({ mode: s0.mode, path: s0.path, drawn: s0.drawn }));
	check('and the pages on screen are the pages of this document',
		/Chapter one/.test(await words()) && s0.pages >= 2,
		`${s0.pages} page(s)`);
	check('and the watch is following every file the compile read',
		s0.files >= 3, `${s0.files} file(s)`);

	// ── 1. It follows the file, without anybody acting ───────────
	// A daimon's write. The panel is not touched, no button is pressed, and the
	// assertion is on the WORDS, so a counter that ticked for another reason
	// cannot pass it.
	const before1 = (await st()).drawn;
	await put('proj/one.typ', ONE('Bravo'));
	for (let i = 0; i < 24 && (await st()).drawn === before1; i++) await sleep(250);
	const after1 = await words();
	check('AN EDIT TO A CHAPTER REFRESHES THE VIEW WITH NOBODY ACTING',
		/Bravo/.test(after1) && !/Alpha/.test(after1),
		(await st()).drawn === before1 ? 'nothing rebuilt' : after1.slice(0, 90));

	// ── 2. The reader's place survives the swap ──────────────────
	// Scrolled well into the book, then a LATER chapter is edited so the document
	// changes under the reader without the page they are on moving. A fraction of
	// the scroll height would pass this by accident when nothing resizes, so the
	// assertion is the page and the offset within it.
	await page.evaluate(() => {
		const sc = document.querySelector('#typst-live .tl-scroll');
		sc.scrollTop = Math.round(sc.scrollHeight * 0.55);
	});
	await sleep(300);
	const place = await st();
	const before2 = place.drawn;
	await put('proj/two.typ', TWO('Yankee'));
	for (let i = 0; i < 24 && (await st()).drawn === before2; i++) await sleep(250);
	const kept = await st();
	check('THE READER\'S PLACE SURVIVES THE SWAP',
		kept.drawn > before2
			&& kept.at && place.at
			&& kept.at.page === place.at.page
			&& Math.abs(kept.at.into - place.at.into) < 2,
		`was page ${place.at && place.at.page} +${place.at && place.at.into.toFixed(1)}pt, `
		+ `now page ${kept.at && kept.at.page} +${kept.at && kept.at.into.toFixed(1)}pt`);
	check('and it did not simply refuse to move, either — the page really changed',
		/Yankee/.test(await words()), (await words()).slice(0, 90));

	// ── 3. Nothing blanks, on any frame ──────────────────────────
	// Sampled every animation frame across a whole rebuild. The frame COUNT is
	// asserted as well: a sampler that saw four frames did not watch a rebuild.
	const steady = await marks();
	await page.evaluate(() => {
		window.__frames = [];
		const tick = () => {
			const h = document.querySelector('#typst-live .tl-pages');
			window.__frames.push((h && h.shadowRoot)
				? h.shadowRoot.querySelectorAll('use, path').length : -1);
			window.__raf = requestAnimationFrame(tick);
		};
		tick();
	});
	const before3 = (await st()).drawn;
	await put('proj/one.typ', ONE('Charlie'));
	for (let i = 0; i < 24 && (await st()).drawn === before3; i++) await sleep(250);
	await sleep(400);
	const frames = await page.evaluate(() => {
		cancelAnimationFrame(window.__raf);
		return window.__frames;
	});
	const low = frames.length ? Math.min(...frames) : -1;
	check('the frame sampler actually watched a rebuild',
		frames.length > 20 && (await st()).drawn > before3,
		`${frames.length} frame(s)`);
	check('NOTHING BLANKS — every frame across the rebuild carried the document',
		low > 0 && low >= steady * 0.9,
		`lowest frame held ${low} marks, steady state ${steady}`);
	// (The pixels themselves are counted below, where the page is cropped and
	// compared against poppler's rendering of the same page. A photograph of the
	// WHOLE scroller would be four-fifths panel background, and a "40% ink" reading
	// off that would pass for a drawn page while measuring the dark behind it.)

	// ── 4. A broken source costs the error and nothing else ──────
	const good = await marks();
	const goodWords = await words();
	const before4 = (await st()).builds;
	await put('proj/one.typ', '#let one = [ unbalanced\n');
	for (let i = 0; i < 24 && (await st()).builds === before4; i++) await sleep(250);
	await sleep(600);
	const broken = await st();
	check('A BROKEN SOURCE LEAVES THE LAST GOOD VIEW UP',
		(await marks()) === good && (await words()) === goodWords,
		`${await marks()} marks, was ${good}`);
	check('and it shows the compiler\'s own words, with the file and the line',
		/one\.typ:\d+/.test(broken.error) && /unclosed delimiter/i.test(broken.error),
		JSON.stringify(broken.error).slice(0, 200));
	check('and the error is not a Rust dump wearing a message',
		!/LocalErr\{|\x1b\[/.test(broken.error), JSON.stringify(broken.error).slice(0, 120));
	const bar = await page.$eval('#typst-live .tl-says', e => e.textContent);
	check('and the bar says the pages are the last ones that built',
		/last build/i.test(bar), bar);

	// ── 5. A good build clears it, without a word ────────────────
	const before5 = (await st()).drawn;
	await put('proj/one.typ', ONE('Delta'));
	for (let i = 0; i < 24 && (await st()).drawn === before5; i++) await sleep(250);
	await sleep(400);
	const fixed = await st();
	const errShown = await page.$eval('#typst-live .tl-err',
		e => ({ text: e.textContent, shown: e.style.display !== 'none' }));
	check('A GOOD BUILD AFTER A BAD ONE CLEARS THE ERROR, SILENTLY',
		fixed.error === '' && !errShown.shown && /Delta/.test(await words())
			&& fixed.mode === 'live',
		JSON.stringify({ error: fixed.error.slice(0, 80), shown: errShown.shown, mode: fixed.mode }));

	// ── 6. A burst of writes is one rebuild ──────────────────────
	// Six writes inside the debounce window. One rebuild, not six: the count is of
	// builds STARTED, so a loop that ran them back to back cannot pass by finishing
	// quickly.
	const before6 = (await st()).builds;
	for (let i = 0; i < 6; i++) { await put('proj/two.typ', TWO('Burst' + i)); await sleep(60); }
	await sleep(3000);
	const burst = await st();
	check('THE DEBOUNCE COALESCES A BURST OF WRITES INTO ONE REBUILD',
		burst.builds - before6 === 1,
		`${burst.builds - before6} rebuild(s) for six writes, debounce ${burst.debounce} ms`);
	check('and the one it ran was of the LAST write, not the first',
		/Burst5/.test(await words()), (await words()).slice(0, 90));

	// ── 9. The pages are the PDF's pages ─────────────────────────
	// Done here, while the view is live and known good, and before the heap and
	// closing checks put the loop into states it cannot draw from.
	if (!POPPLER) {
		check('the vector pages are the same ink as the PDF', false,
			'pdftoppm is not installed, so the only outside oracle here could not be asked');
	} else {
		const r = await inkCompare(page, 'proj/main.typ');
		check('the page photographed is a page of text on paper, not a dark box',
			r.paper > 0.6 && r.ink > 0.005 && r.ink < 0.2,
			`${(r.paper * 100).toFixed(1)}% paper, ${(r.ink * 100).toFixed(2)}% ink`);
		check('THE LIVE PAGE HAS EXACTLY THE LINES THE PDF PAGE HAS',
			r.lines.pdf >= 8 && r.lines.live === r.lines.pdf,
			`PDF ${r.lines.pdf} line(s), live ${r.lines.live}`);
		check('AND THEY SIT WHERE THE PDF PUTS THEM — nothing reflowed, nothing moved',
			r.raw < 3 && r.rows.worst < 1.5 && Math.abs(r.rows.a - 1) < 0.01,
			`worst line ${r.raw.toFixed(2)}px from the PDF's; after one scale and offset `
			+ `${r.rows.worst.toFixed(2)}px (rms ${r.rows.rms.toFixed(2)}px), scale `
			+ `${r.rows.a.toFixed(5)}`);
		check('and the text is set to the same measure, to the pixel',
			Math.abs(r.measure.live[0] - r.measure.pdf[0]) <= 2
				&& Math.abs(r.measure.live[1] - r.measure.pdf[1]) <= 2,
			`PDF ${r.measure.pdf.join('..')}, live ${r.measure.live.join('..')} of ${r.w}px`);
		// Reported rather than asserted, and the difference is the point: poppler
		// hints a glyph and Chrome fills its outline, so the same stroke carries
		// different weight. That is the rasteriser, not the book, and a check that
		// demanded equality here would be asserting that two rasterisers agree.
		console.log(`         (ink weight live/PDF ${r.ratio.toFixed(3)} and `
			+ `${(r.diff * 100).toFixed(1)}% of pixels differ by more than 8/255 — anti-aliasing `
			+ `along every glyph edge, which is why the LINES are what is asserted. The `
			+ `difference image is ${r.png})`);
	}

	// ── 8. The heap guard refuses rather than bricking ───────────
	// Driven at the limit, by moving the limit: the ceiling is a real setting, and
	// the compiler's heap is monotonic, so a budget below where it already stands is
	// exactly the state a long session reaches. Nothing here allocates gigabytes to
	// find out — the measurement that did is in dev/TYPST_WATCH.md, and it left that
	// page's compiler dead.
	const heapNow = (await st()).heap;
	await page.evaluate((mb) => window.DaimondTypstWatch.budgetMB(mb), Math.max(1, heapNow / 2));
	const before8 = (await st()).builds;
	await put('proj/one.typ', ONE('Echo'));
	await sleep(3000);
	const held = await st();
	const rebuildBtn = await page.$eval('#typst-live .tl-rebuild',
		e => ({ shown: e.style.display !== 'none', label: e.textContent }));
	check('THE HEAP GUARD REFUSES TO START A REBUILD THAT MIGHT NOT FIT',
		held.builds === before8 && held.mode === 'held',
		`${held.builds - before8} rebuild(s) started, mode ${held.mode}`);
	check('and it says why, in MB, rather than merely stopping',
		/memory|MB/i.test(held.reason) && /Rebuild|reload/i.test(held.reason),
		held.reason.slice(0, 160));
	check('and it falls back to a Rebuild button the user presses knowingly',
		rebuildBtn.shown, JSON.stringify(rebuildBtn));
	check('and the pages are still on screen while it is held',
		(await marks()) > 0, `${await marks()} marks`);
	// Pressing it is the user's own choice, and it works.
	// Clicked through the DOM rather than through the locator: under `--break
	// noguard` the button is never offered, and a run that dies on a missing button
	// says nothing about the twenty checks after it. A break must reach the summary.
	const drawn8 = (await st()).drawn;
	await page.evaluate(() => {
		const b = document.querySelector('#typst-live .tl-rebuild');
		if (b) b.click();
	});
	for (let i = 0; i < 24 && (await st()).drawn === drawn8; i++) await sleep(250);
	const forced = await st();
	check('and pressing Rebuild does rebuild — the guard stopped the LOOP, not the user',
		forced.builds > before8 && /Echo/.test(await words()),
		`${forced.builds - before8} rebuild(s), ${forced.drawn - drawn8} drawn`);
	await page.evaluate(() => window.DaimondTypstWatch.budgetMB(2500));

	// ── 7. Closing the view ends the watch ───────────────────────
	// Last, because it takes the loop down. Proved by the absence of a compile after
	// a real edit — and the same edit is shown to have caused one a moment earlier,
	// so the silence is the closing and not the fixture.
	await sleep(1500);
	const before7 = (await st()).builds;
	await put('proj/two.typ', TWO('Foxtrot'));
	for (let i = 0; i < 24 && (await st()).builds === before7; i++) await sleep(250);
	check('the same edit rebuilds while the view is open (so the silence below is the closing)',
		(await st()).builds > before7, `${(await st()).builds - before7} rebuild(s)`);

	await shot(s, 'typstwatch' + (BREAK ? '-' + BREAK : ''));

	// The PREVIEW panel, which is where the live pages live. It used to be the Doc
	// panel, because the source and its pages shared one — and the watch stopping
	// when the source was closed was the very compromise the split removed. Closing
	// the document now leaves the pages up, on purpose; closing the PAGES is what
	// says nobody is reading them.
	await page.click('#panel-preview [data-close="preview"]', { force: true });
	await sleep(2000);
	const closed = await st();
	const before9 = closed.builds;
	await put('proj/one.typ', ONE('Golf'));
	await sleep(4000);
	const after9 = await st();
	check('CLOSING THE VIEW ENDS THE WATCH — nothing compiles after it',
		after9.builds === before9 && after9.mode === 'idle' && after9.path === '',
		`${after9.builds - before9} rebuild(s) after closing, mode ${after9.mode}`);
	check('and the live view is gone from the panel, leaving it as it was',
		!(await page.$('#typst-live')),
		'the live view is still in the panel');
	// The preview panel's own two renderings get their inline `display` back,
	// exactly as they had it. A live view that stood in for them and then left them
	// hidden would close into an empty panel.
	const back = await page.evaluate(() => ({
		view:  document.getElementById('pv-view').style.display,
		embed: document.getElementById('doc-embed').style.display,
	}));
	check('and the PDF the Compile button wrote is showing again, exactly as it was',
		back.embed === '' && back.view === 'none', JSON.stringify(back));

	// ── 10. A long book is drawn all the way down ────────────────
	//
	// The check that would have caught the defect this design was rewritten around,
	// and nothing else here would have. Drawn the obvious way — one SVG as tall as
	// the book, only the visible band filled in — a 251-page document rasterises at a
	// REDUCED RESOLUTION far from its origin: page 1 came out 5.6% dark and page 40
	// came out 0.00%, the words still there in outline, the page a pale wash. Every
	// mark was in the DOM, every element existed, the page count was right, and the
	// document was unreadable.
	//
	// So it is asserted in PIXELS, on a page deep enough to be past where Chrome
	// stops drawing properly, against page one of the same document.
	await put('deep/main.typ',
		'#set page(width: 120mm, height: 160mm, margin: 12mm)\n'
		+ '#set text(size: 10pt)\n#set par(justify: true)\n#lorem(13000)\n');
	await page.evaluate(() => window.DaimondDoc.show('deep/main.typ'));
	await sleep(1200);
	await page.click('[data-act="compile"]', { force: true });
	// Waited on THIS document being the one on screen, not on a counter: `stop()`
	// leaves the tally of the watch that just ended, so `drawn > 0` was true before
	// the button was even pressed and the wait fell straight through.
	for (let i = 0; i < 120; i++) {
		const w = await st();
		if (w.path === 'deep/main.typ' && w.drawn && w.pages > 2) break;
		await sleep(500);
	}
	const deep = await st();
	// A missing view is a FAILED CHECK, not an exception: a break that stops the loop
	// working at all must still reach the summary, or the run says nothing about the
	// checks it did get through.
	const shotPage = async (n, name) => {
		const g = await page.evaluate((k) => {
			if (!document.querySelector('#typst-live .tl-pages')) return null;
			window.DaimondTypstWatch.goToPage(k);
			const b = window.DaimondTypstWatch.pageBox(k);
			const sc = document.querySelector('#typst-live .tl-scroll');
			const h = document.querySelector('#typst-live .tl-pages');
			const hr = h.getBoundingClientRect(), sr = sc.getBoundingClientRect();
			return { top: hr.top + b.top, left: hr.left, w: hr.width, h: b.height,
				sy: sr.y, sh: sr.height };
		}, n);
		if (!g) return { ratio: 0, missing: true };
		await sleep(700);		// Chrome rasterises a jump of thirty thousand pixels
		const y = Math.max(g.top, g.sy);
		const p = path.join(WORK, name);
		await page.screenshot({ path: p, clip: {
			x: g.left, y, width: Math.floor(g.w),
			height: Math.floor(Math.min(g.h, g.sy + g.sh - y)),
		} });
		return inkOf(p);
	};
	check('a long document is many pages, and deep enough to be worth asking about',
		deep.pages > 40, `${deep.pages} page(s)`);
	const first = await shotPage(1, 'deep-1.png');
	const far   = await shotPage(Math.min(45, deep.pages), 'deep-45.png');
	check('A PAGE DEEP IN A LONG BOOK IS DRAWN AS DARKLY AS THE FIRST ONE',
		!first.missing && !far.missing && first.ratio > 0.005
			&& far.ratio > first.ratio * 0.75,
		first.missing || far.missing ? 'there was no live view to photograph'
			: `page 1 ${(first.ratio * 100).toFixed(2)}% ink, page `
				+ `${Math.min(45, deep.pages)} ${(far.ratio * 100).toFixed(2)}% ink`);

	const errs = errors(s).filter(e =>
		!/Failed to load resource/.test(e) && !/502/.test(e) && !/Bad Gateway/.test(e));
	check('nothing was refused by way of an unhandled error', errs.length === 0,
		errs.slice(0, 3).join(' | '));
} finally {
	await s.close();
}

// ── The ink ──────────────────────────────────────────────────────────

/// The ink in a PNG: `{ w, h, gray, total, ratio }`, greyscale, 0 = white.
function inkOf(png) {
	const raw = png.replace(/\.png$/, '.gray');
	const dims = execFileSync('identify', ['-format', '%wx%h', png]).toString();
	const [w, h] = dims.split('x').map(Number);
	execFileSync('convert', [png, '-colorspace', 'gray', '-depth', '8', raw]);
	const g = fs.readFileSync(raw);
	let total = 0;
	for (let i = 0; i < w * h; i++) total += 255 - g[i];
	return { w, h, gray: g, total, ratio: total / (255 * w * h) };
}

// ── What "the same page" is measured as, and why not pixels ──────────
//
// Comparing the two rasters pixel for pixel does not answer the question. Poppler
// and Chrome disagree about the WEIGHT of a glyph — poppler hints and Chrome fills
// an outline, so at 120 dpi Chrome lays down about a third more ink along the same
// strokes — and they round the page box differently, so one raster is a fraction of
// a percent taller than the other and by the foot of the page the lines are two
// pixels apart. Both of those are the rasterisers, and neither is the book.
//
// What IS the book is where the lines sit and how long they are. So the ink is
// reduced to LINE BANDS — the runs of rows that carry ink — and the two sets are
// fitted to each other with one scale and one offset. If nothing reflowed there are
// the same number of bands and they land on each other to within a pixel. If a
// paragraph re-broke, a line appears, disappears or moves relative to its
// neighbours, and no single scale and offset can put them back together.
//
// This is the metric that would catch a font substituted silently, which is the
// failure `typst.js` refuses to compile through. A page typeset in the wrong face
// has the same words and different line breaks, and only the geometry says so.

/// The runs of rows (or columns) carrying ink, as `[start, end]` pairs.
///
/// Three things make this stable, and each was arrived at by watching it wobble.
/// The threshold is a fraction of the BUSIEST row rather than an absolute, so it
/// does not depend on how dark either rasteriser draws. The profile is SMOOTHED
/// over five samples first, so an ascender or a superscript poking above a line does
/// not become a band of its own in one raster and not the other. And bands closer
/// together than `GAP` are MERGED, because two halves of one line of type are one
/// line of type.
///
/// The recipe was checked for stability rather than tuned to pass: on the fixture,
/// thresholds from 6% to 20% all report the same thirteen lines in both rasters,
/// agreeing to within one pixel. A metric that only works at one threshold is a
/// coincidence.
function bands(profile) {
	const SM = 2, THR = 0.15, GAP = 3;
	const p = new Float64Array(profile.length);
	for (let i = 0; i < profile.length; i++) {
		let sum = 0, n = 0;
		for (let j = -SM; j <= SM; j++) {
			const q = i + j;
			if (q >= 0 && q < profile.length) { sum += profile[q]; n++; }
		}
		p[i] = sum / n;
	}
	let max = 0;
	for (const v of p) if (v > max) max = v;
	const thr = max * THR;
	const raw = [];
	let start = -1;
	for (let i = 0; i < p.length; i++) {
		if (p[i] > thr) { if (start < 0) start = i; }
		else if (start >= 0) { raw.push([start, i - 1]); start = -1; }
	}
	if (start >= 0) raw.push([start, p.length - 1]);
	const out = [];
	for (const b of raw) {
		if (out.length && b[0] - out[out.length - 1][1] <= GAP) out[out.length - 1][1] = b[1];
		else out.push([b[0], b[1]]);
	}
	return out;
}

/// Fit `ys ≈ a·xs + c` and report the fit and how far off it is.
///
/// `a` near 1 and a residual under a pixel is two rasterisations of one layout. A
/// residual of several pixels is a layout that moved.
function fit(xs, ys) {
	const n = xs.length;
	if (!n || n !== ys.length) return { a: 0, c: 0, rms: Infinity, worst: Infinity };
	let mx = 0, my = 0;
	for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
	mx /= n; my /= n;
	let sxx = 0, sxy = 0;
	for (let i = 0; i < n; i++) { sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); }
	const a = sxx ? sxy / sxx : 1;
	const c = my - a * mx;
	let sum = 0, worst = 0;
	for (let i = 0; i < n; i++) {
		const d = Math.abs(ys[i] - (a * xs[i] + c));
		sum += d * d;
		if (d > worst) worst = d;
	}
	return { a, c, rms: Math.sqrt(sum / n), worst };
}

/// Compile `main` to a PDF, photograph the live view, and compare the ink.
///
/// The PDF is rasterised by POPPLER and the pages by CHROME, from one compile of one
/// source. Neither raster is ours, and poppler has no typst in it, so an agreement
/// here is not this project agreeing with itself.
///
/// Alignment is measured rather than assumed: two rasterisers round a page box
/// differently, and a whole-pixel offset is not a layout difference. The best shift
/// is reported and bounded — a page that really had reflowed would not come back
/// into correlation at ANY shift.
async function inkCompare(page, main) {
	// THE PDF OF THE SOURCE AS IT STANDS NOW, and this is the trap the first version
	// of this check fell into: the PDF the Compile button wrote was of the source as
	// it was when the button was pressed, and by this point the loop has rebuilt from
	// four edits. The two pages differed in one word, the correlation collapsed, and
	// the check reported a rendering fault that was entirely its own.
	//
	// Through `typst_compile_project` — the page's own Compile door, the same one the
	// button uses — so the PDF and the live view come from one gatherer and one
	// compiler and differ only in what they were asked to produce.
	const bytes = await page.evaluate(async (p) => {
		const m = await import('/pkg/oxedyne_daimond.js');
		const out = await m.typst_compile_project(p);
		return out.pdf ? Array.from(out.pdf) : [];
	}, main);
	const pdf = path.join(WORK, 'a.pdf');
	fs.writeFileSync(pdf, Buffer.from(bytes));

	// The live view's first page — PHOTOGRAPHED WHERE IT IS ON SCREEN, clipped to the
	// page's own rectangle in the viewport.
	//
	// Not an element screenshot of the page host: that host is two pages tall and
	// taller than the viewport, and what came back had eight rows of the panel's dark
	// chrome across the top and the scroller's background down both edges. It read as
	// a third more ink than the PDF and as a page whose text block was fourteen pixels
	// wider, neither of which had anything to do with the document. A viewport clip is
	// literally what the reader sees.
	const live = path.join(WORK, 'live1.png');
	const box = await page.evaluate(() => {
		const st = window.DaimondTypstWatch.state();
		const h = document.querySelector('#typst-live .tl-pages');
		document.querySelector('#typst-live .tl-scroll').scrollTop = 0;
		const svg = h.shadowRoot.querySelector('svg');
		const r = svg.getBoundingClientRect();
		// The first page's height in rendered pixels, from the page geometry rather
		// than from dividing the stack — pages need not all be the same height.
		const pageH = st.pages > 1 ? (r.height / st.pages) : r.height;
		return { x: r.left, y: r.top, w: r.width, h: pageH };
	});
	await page.screenshot({
		path: live,
		clip: { x: box.x, y: box.y, width: Math.floor(box.w), height: Math.floor(box.h) },
	});

	execFileSync('pdftoppm', ['-r', '150', '-gray', '-png', '-f', '1', '-l', '1',
		'-scale-to-x', String(Math.floor(box.w)), '-scale-to-y', '-1', pdf,
		path.join(WORK, 'pdf')]);
	const pdfPng = path.join(WORK,
		fs.readdirSync(WORK).find(f => /^pdf-?0*1\.png$/.test(f)));

	const A = inkOf(pdfPng), B = inkOf(live);
	// Two pixels off every edge of both. A clipped screenshot lands on a fractional
	// device pixel and blends the edge with whatever is behind the page; two pixels of
	// a 576-pixel page is nothing, and it is the difference between measuring a
	// document and measuring the panel it sits in.
	const IN = 2;
	const w = Math.min(A.w, B.w) - 2 * IN, h = Math.min(A.h, B.h) - 2 * IN;
	const rowA = new Float64Array(h), rowB = new Float64Array(h);
	const colA = new Float64Array(w), colB = new Float64Array(w);
	let diff = 0, inkA = 0, inkB = 0;
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const a = 255 - A.gray[(y + IN) * A.w + (x + IN)];
			const b = 255 - B.gray[(y + IN) * B.w + (x + IN)];
			inkA += a; inkB += b;
			rowA[y] += a; rowB[y] += b;
			colA[x] += a; colB[x] += b;
			if (Math.abs(a - b) > 8) diff++;
		}
	}
	// The two rasterisers disagree about how heavily a glyph is drawn — poppler hints,
	// Chrome fills an outline — so the profiles are levelled by TOTAL INK before the
	// lines are picked out of them. Otherwise the heavier of the two never dips below
	// a threshold between two lines and two lines read as one, which is a rasteriser
	// difference reported as a reflow.
	if (inkB) {
		const k = inkA / inkB;
		for (let i = 0; i < h; i++) rowB[i] *= k;
		for (let i = 0; i < w; i++) colB[i] *= k;
	}
	// The lines of the page, and the columns the text is set between.
	const lineA = bands(rowA), lineB = bands(rowB);
	const midA = lineA.map(([a, b]) => (a + b) / 2), midB = lineB.map(([a, b]) => (a + b) / 2);
	const rows = (midA.length === midB.length) ? fit(midA, midB)
		: { a: 0, c: 0, rms: Infinity, worst: Infinity };
	// And the same lines WITHOUT a fit. The fit says "nothing reflowed relative to
	// everything else", which a page drawn at the wrong scale or in the wrong place
	// would satisfy perfectly; this says the lines are where the PDF puts them, full
	// stop, and the only slack is the pixel the two rasterisers round differently.
	let raw = Infinity;
	if (midA.length === midB.length && midA.length) {
		raw = 0;
		for (let i = 0; i < midA.length; i++) raw = Math.max(raw, Math.abs(midB[i] - midA[i]));
	}
	const colBandA = bands(colA), colBandB = bands(colB);
	// The measure — where the text block starts and ends across the page. A
	// re-justified paragraph moves it; a rasteriser does not.
	const edgeA = colBandA.length ? [colBandA[0][0], colBandA[colBandA.length - 1][1]] : [0, 0];
	const edgeB = colBandB.length ? [colBandB[0][0], colBandB[colBandB.length - 1][1]] : [0, 0];
	// How much of the photograph is paper and how much is ink, so "the page is
	// drawn" cannot be satisfied by a dark rectangle where the page should be.
	let paper = 0, dark = 0;
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const v = B.gray[(y + IN) * B.w + (x + IN)];
			if (v > 240) paper++; else if (v < 128) dark++;
		}
	}
	const png = path.join(WORK, 'difference.png');
	try {
		execFileSync('convert', [pdfPng, live, '-compose', 'difference', '-composite',
			'-negate', png]);
	} catch (e) { /* the difference image is evidence, not a check */ }
	return {
		ratio: inkA ? inkB / inkA : 0,
		lines: { pdf: midA.length, live: midB.length },
		rows, raw,
		measure: { pdf: edgeA, live: edgeB },
		diff: diff / (w * h), paper: paper / (w * h), ink: dark / (w * h), w, h, png,
	};
}

console.log(`\nchecks: ${ok.length} ok, ${bad.length} failed`);
if (BREAK) {
	console.log(`\nbreak '${BREAK}': ${bad.length} check(s) failed`
		+ (bad.length ? ' — ' + bad.join('; ') : ' — NOTHING FAILED, so the checks above prove nothing'));
	process.exit(bad.length ? 0 : 1);		// a break MUST fail something
}
console.log(bad.length === 0 ? '\nall checks passed' : `\n${bad.length} check(s) FAILED`);
process.exit(bad.length === 0 ? 0 : 1);
