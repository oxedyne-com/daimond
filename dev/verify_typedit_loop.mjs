// verify_typedit_loop.mjs — editing a `.typ` beside its live pages, on a desktop.
//
// The loop itself is `dev/verify_typstwatch.mjs`'s: a save rebuilds, the reader keeps
// his place, nothing blanks. This file is about the four ways that loop failed the
// author on a real book — measured on a read-only copy of `TheOrder/Onthearche`,
// which is 48 pages, twenty-odd `.typ` files, cetz, Felipa and Libertinus.
//
//   D1. A TWO-SEAT STAGE EVICTS THE PAGES AND THE WATCH STOPS, SILENTLY. The stage
//       seats `floor((room + 10) / 390)` panels, so at 1500 px with the rail and the
//       dock open there are two: opening the chapter takes the Preview's seat, the
//       poll reads "the panel is gone" as "the reader closed the document", and the
//       state goes `live` → `idle` within a second. The author then edits, saves, and
//       nothing rebuilds, with nothing anywhere saying why. An eviction must PAUSE —
//       keeping the path, the file list and the stamps — and coming back must resume
//       with one rebuild if anything moved. A person CLOSING the panel still stops it,
//       which is the distinction `userHide` carries and the poll cannot see.
//
//   D2. THE COMPILER'S WORDS NEVER REACH THE PERSON WHO BROKE THE FILE. They land at
//       the foot of the PAGES; the author is in the SOURCE, where the panel said
//       "Saved." over a file that no longer compiles. The file and the line — the only
//       part of a diagnostic anybody acts on — must reach the panel holding that file,
//       and pressing them must put the caret on the line.
//
//   D3. COMPILE ON A CHAPTER IS REFUSED, because a chapter is not a document: its
//       cross-references are resolved by the book around it, so it answers with three
//       `label <…> does not exist`. The author's own script has known the rule for
//       years — a document is a file holding `#show: doc.with(`, `select_typst_file`
//       in `~/usr/books/ontheism/dev:39-48` — so the MAIN is compiled and the
//       chapter's own page is brought into view.
//
//   D4. THE IN-APP PDF OVERWROTE THE PUBLISHED ONE. `~/usr/books/ontheism/dev` writes
//       `onthearche.pdf` through Ghostscript (CMYK, for print) and a pikepdf metadata
//       scrub — 408 KB. The button wrote 1.7 MB of RGB, unscrubbed, typst-0.14.2 bytes
//       to that same name. It must write `<main>-preview.pdf`, and the pipeline must be
//       reachable from the panel: a Publish that composes the script's own command
//       under a memory cap, because a full book parks at ~2.9 GB resident for as long
//       as `typst watch` runs (`reference_typst_compile_memory`, measured 2026-08-07).
//
// WHAT IS NOT PROVED HERE, and it is the whole of what Publish does on a real machine.
// Nothing in this world runs typst, Ghostscript or pikepdf: `hand/install/mock_host.py`
// invents output on a schedule and executes nothing, and this world has no hand paired
// at all. So Publish is asserted as far as it is this app's: the command it composes,
// the cap in it, the folder it would run in, and that a refusal is shown as a refusal
// rather than reported as a publication. Whether the script then produces a scrubbed
// CMYK PDF is the script's own business and `dev/verify_handrun.mjs`'s pipeline.
//
// THE BOOK IS THE FIXTURE WHERE THERE IS ONE. `DAIMOND_BOOK`, or
// `~/usr/books/ontheism/TheOrder/Onthearche`, seeded read-only into the world's OPFS
// and reached through `set_workspace_dir(await navigator.storage.getDirectory())` —
// the same override `dev/verify_folderloss.mjs` uses, since a `showDirectoryPicker`
// grant cannot be answered under automation. Where that book is not on the machine a
// synthetic one of the same SHAPE stands in — a template, a main that sets up its own
// page, two chapters included by it — so the checks mean the same thing on a machine
// that has never seen the author's work.
//
// EACH CHECK IS PROVED AGAINST BROKEN CODE FIRST. `--break <name>` serves a damaged
// copy of a real source file to the real page, and the run is then expected to FAIL.
//
//   node dev/verify_typedit_loop.mjs --break pausestops  # D1: an eviction kills the watch
//   node dev/verify_typedit_loop.mjs --break noerrevent  # D2: the error stays at the pages
//   node dev/verify_typedit_loop.mjs --break chapteronly # D3: a chapter compiles itself
//   node dev/verify_typedit_loop.mjs --break finalname   # D4: the final PDF is overwritten
//   node dev/verify_typedit_loop.mjs --break nocap       # D4: the publish runs uncapped
//   node dev/verify_typedit_loop.mjs                     # and then, clean
//
//   bash dev/world.sh 36 --up ; eval "$(bash dev/world.sh 36 --env)"
//   node dev/verify_typedit_loop.mjs
//   bash dev/world.sh 36 --down
//
// Needs dev/serve.mjs and the vendored typst. No gateway and no model: every compile
// here is the real wasm compiler and the only network is localhost.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, scratch, errors } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

const PROFILE = scratch('pw', 'typedit' + (BREAK ? '-' + BREAK : ''));
fs.rmSync(PROFILE, { recursive: true, force: true });

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

// ── The breaks ───────────────────────────────────────────────────────
const BREAKS = {
	// The eviction kills the watch again, which is the defect in its own shape: the
	// state goes idle, the notice is never said, and a save after the pages come back
	// rebuilds nothing.
	pausestops: [{
		file: 'js/typstwatch.js',
		find: "\tif (S.seen && !shown) { pause(); return; }",
		with: "\tif (S.seen && !shown) { stop(); return; }",
	}],
	// The compiler's words stay at the foot of the pages. "Saved." over a broken file,
	// which is what the author met.
	noerrevent: [{
		file: 'js/typstwatch.js',
		find: "\tannounce('daimond-build-error', Object.assign({ text: S.error }, errorAt(S.error)));",
		with: "\t/* the pages keep it to themselves */",
	}],
	// Compile builds whatever file is open, so a chapter compiles alone and typst
	// refuses it for the labels the book would have supplied.
	chapteronly: [{
		file: 'js/daimond.js',
		find: "\t\t\tif (await isMain(p)) return p;",
		with: "\t\t\treturn p;",
	}],
	// The preview is written to the pipeline's own name again: 1.7 MB of unscrubbed
	// RGB over a 408 KB CMYK final, with nothing to say it happened.
	finalname: [{
		file: 'js/daimond.js',
		find: "\t\t\treturn String(mainPath || '').replace(/\\.typ$/i, '') + '-preview.pdf';",
		with: "\t\t\treturn String(mainPath || '').replace(/\\.typ$/i, '') + '.pdf';",
	}],
	// The cap goes, so a full book's `typst watch` parks at ~2.9 GB inside whatever
	// budget the session has.
	nocap: [{
		file: 'js/daimond.js',
		find: "\t\t\t\t\t'-p', 'MemoryMax=' + PUBLISH_CAP,\n",
		with: "",
	}],
};
if (BREAK && !BREAKS[BREAK]) {
	console.error(`unknown break '${BREAK}'; one of: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}

/// `src` with `spec` applied, or a hard stop: nothing is served that was not damaged.
function damaged(src, spec) {
	const n = src.split(spec.find).length - 1;
	if (n !== 1) {
		console.error(`break '${BREAK}': the anchor appears ${n} times in ${spec.file}, `
			+ 'so nothing was broken and the run below would prove nothing.');
		process.exit(2);
	}
	return src.replace(spec.find, spec.with);
}

/// Serve every break's damage, ONE BODY PER FILE: Playwright keeps the last route
/// registered for a URL, so two edits to one file registered twice serve only the second.
async function routes(page) {
	if (!BREAK) return;
	const byFile = new Map();
	for (const spec of (BREAKS[BREAK] || [])) {
		const src = byFile.has(spec.file) ? byFile.get(spec.file)
			: fs.readFileSync(path.join(WWW, spec.file), 'utf8');
		byFile.set(spec.file, damaged(src, spec));
	}
	for (const [file, body] of byFile) {
		await page.route('**/' + file, r => r.fulfill({
			status: 200, contentType: 'application/javascript', body,
		}));
	}
}

// ── The book ─────────────────────────────────────────────────────────
//
// A LIST OF `[workspace path, bytes]`, however it was arrived at, so the seeding
// below does not care which fixture it got.

const DIR  = process.env.DAIMOND_BOOK
	|| path.join(process.env.HOME || '', 'usr/books/ontheism/TheOrder/Onthearche');
const ROOT = 'ontheism/TheOrder/Onthearche';
const REAL = fs.existsSync(path.join(DIR, 'onthearche.typ'));

/// The Libertinus faces the book actually sets, flat in `assets/fonts` where the
/// gatherer walks — `FONT_DIRS` in src/wasm/typst.rs looks for `assets/fonts` outward
/// from the main, and a face left in a subdirectory is a face it does not find.
const FACES = /^LibertinusSerif-(Regular|Bold|Italic|BoldItalic|Semibold)\.otf$/;

/// Every file the fixture puts in the workspace.
function fixture() {
	const out = [];
	if (!REAL) {
		// The same SHAPE: a template that defines `doc`, a main that shows itself with
		// it, and two chapters it includes. Wide margins and a page break per chapter,
		// so the document is several pages and a heading has somewhere to be.
		out.push([ROOT + '/template.typ',
			'#let doc(title: [Untitled], body) = {\n'
			+ '  set page(width: 120mm, height: 160mm, margin: 12mm)\n'
			+ '  set text(size: 10pt)\n'
			+ '  align(center, text(size: 20pt, title))\n'
			+ '  pagebreak()\n'
			+ '  body\n'
			+ '}\n']);
		out.push([ROOT + '/onthearche.typ',
			'#import "template.typ": *\n\n'
			+ '#show: doc.with(\n  title: [The Onthearche],\n)\n\n'
			+ '#include "chap_questions.typ"\n'
			+ '#pagebreak()\n'
			+ '#include "chap_practice.typ"\n']);
		out.push([ROOT + '/chap_questions.typ',
			'#import "template.typ": *\n\n= Questions\n\n#lorem(400)\n']);
		out.push([ROOT + '/chap_practice.typ',
			'#import "template.typ": *\n\n= Practice <practice>\n\n'
			+ 'Three interruptions per day, each lasting less than a minute.\n\n'
			+ '== Three Touchpoints\n\n#lorem(300)\n']);
		return out.map(([p, t]) => [p, Buffer.from(t, 'utf8')]);
	}
	for (const n of fs.readdirSync(DIR)) {
		if (n.endsWith('.typ')) out.push([ROOT + '/' + n, fs.readFileSync(path.join(DIR, n))]);
	}
	for (const d of ['svg', 'jpg']) {
		const at = path.join(DIR, 'assets', d);
		if (!fs.existsSync(at)) continue;
		for (const n of fs.readdirSync(at)) {
			out.push([ROOT + '/assets/' + d + '/' + n, fs.readFileSync(path.join(at, n))]);
		}
	}
	const felipa = path.join(DIR, 'assets/fonts/Felipa-Regular.ttf');
	if (fs.existsSync(felipa)) out.push([ROOT + '/assets/fonts/Felipa-Regular.ttf', fs.readFileSync(felipa)]);
	const lib = path.join(DIR, 'assets/fonts/libertinus');
	if (fs.existsSync(lib)) {
		for (const n of fs.readdirSync(lib)) {
			if (FACES.test(n)) out.push([ROOT + '/assets/fonts/' + n, fs.readFileSync(path.join(lib, n))]);
		}
	}
	return out;
}

const MAIN    = ROOT + '/onthearche.typ';
const CHAPTER = ROOT + '/chap_practice.typ';
const FINAL   = ROOT + '/onthearche.pdf';
const PREVIEW = ROOT + '/onthearche-preview.pdf';
/// What the published PDF holds before anything in the app is pressed. Not a PDF:
/// the point is that nothing writes over these bytes, and a sentinel says so exactly.
const SENTINEL = '%PDF-1.4 the pipeline wrote this, and nothing here may take its place\n';

const s = await open({ name: 'typedit' + (BREAK ? '-' + BREAK : ''), profile: PROFILE, route: routes });
const { page } = s;
await page.waitForTimeout(1200);

const st    = () => page.evaluate(() => window.DaimondTypstWatch.state());
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/// The standing word from the loop, on the Doc panel's own note line.
const note = () => page.evaluate(() => {
	const e = document.querySelector('#doc-view .files-view-note');
	return (e && e.style.display !== 'none') ? e.textContent : '';
});

/// The panel's transient line: "Saved.", "Compiled → …", a refusal.
const msg = () => page.evaluate(() => {
	const e = document.querySelector('#doc-view .files-view-msg');
	return (e && e.style.display !== 'none') ? e.textContent : '';
});

/// Whether the Preview panel is on screen at all — the same question `visible` in
/// js/typstwatch.js asks, so the check and the loop cannot disagree about it.
const pagesUp = () => page.evaluate(() => {
	const e = document.getElementById('panel-preview');
	return !!(e && (e.offsetWidth || e.offsetHeight || e.getClientRects().length));
});

/// The words actually on the drawn pages, out of the text layer typst.ts lays over
/// the glyphs. Asserting on these is asserting on the document; asserting on a build
/// counter is asserting that something happened.
const words = () => page.evaluate(() => {
	const h = document.querySelector('#typst-live .tl-pages');
	if (!h || !h.shadowRoot) return '';
	return [...h.shadowRoot.querySelectorAll('.tsel')].map(e => e.textContent).join(' ');
});

/// Edit the open file and press Save, the way a person does: through the panel's own
/// buttons, so the conflict check, the write door and the watch's `touched` are the
/// ones a save really goes through.
async function edit(from, to) {
	// The editor may already be open — going to a line opens it — and pressing Edit
	// again would be pressing Save, on text nothing has changed yet.
	if (!(await page.$('#doc-view .files-edit'))) {
		await page.click('#doc-view [data-act="edit"]', { force: true });
		await page.waitForTimeout(150);
	}
	const did = await page.evaluate(([a, b]) => {
		const ta = document.querySelector('#doc-view .files-edit');
		if (!ta || ta.value.indexOf(a) < 0) return false;
		ta.value = ta.value.split(a).join(b);
		return true;
	}, [from, to]);
	if (!did) throw new Error('the fixture no longer holds ' + JSON.stringify(from));
	await page.click('#doc-view [data-act="edit"]', { force: true });
}

/// Wait for the next build to reach the screen, and say how long it took.
async function drawnAfter(was, ms) {
	const t0 = Date.now();
	for (let i = 0; i < Math.ceil(ms / 200); i++) {
		const now = await st();
		if (now.drawn > was) return Date.now() - t0;
		await sleep(200);
	}
	return -1;
}

try {
	// ── The workspace, and the book in it ────────────────────────
	const mode = await page.evaluate(async () => {
		const m = await import('/pkg/oxedyne_daimond.js');
		m.set_workspace_dir(await navigator.storage.getDirectory());
		return m.workspace_mode();
	});
	check('the workspace is a mounted folder, by the override a picker cannot be driven to set',
		mode === 'folder', mode);

	await page.evaluate(() => {
		window.__put = async function (rel, b64) {
			let dir = await navigator.storage.getDirectory();
			const parts = rel.split('/');
			const leaf = parts.pop();
			for (const p of parts) dir = await dir.getDirectoryHandle(p, { create: true });
			const w = await (await dir.getFileHandle(leaf, { create: true })).createWritable();
			const bin = atob(b64);
			const u8 = new Uint8Array(bin.length);
			for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
			await w.write(u8);
			await w.close();
		};
		window.__get = async function (rel) {
			try {
				let dir = await navigator.storage.getDirectory();
				const parts = rel.split('/');
				const leaf = parts.pop();
				for (const p of parts) dir = await dir.getDirectoryHandle(p);
				const f = await (await dir.getFileHandle(leaf)).getFile();
				return { size: f.size, head: (await f.text()).slice(0, 80) };
			} catch (e) { return null; }
		};
	});
	const seed = fixture();
	for (const [rel, buf] of seed) {
		await page.evaluate(([rel, b64]) => window.__put(rel, b64), [rel, buf.toString('base64')]);
	}
	// The PUBLISHED pdf, as the pipeline left it.
	await page.evaluate(([rel, b64]) => window.__put(rel, b64),
		[FINAL, Buffer.from(SENTINEL, 'utf8').toString('base64')]);
	console.log(`  ..     ${REAL ? 'the author’s book' : 'a synthetic book of the same shape'}`
		+ `: ${seed.length} file(s) seeded`);

	// ── The loop, armed the way a person arms it ─────────────────
	await page.setViewportSize({ width: 1900, height: 1000 });
	await page.evaluate((p) => window.DaimondDoc.show(p), MAIN);
	await page.waitForTimeout(1200);
	check('the Doc panel offers Compile and Publish on a .typ',
		!!(await page.$('#doc-view [data-act="compile"]')) && !!(await page.$('#doc-view [data-act="publish"]')));
	await page.click('#doc-view [data-act="compile"]', { force: true });
	for (let i = 0; i < 90 && !(await st()).drawn; i++) await sleep(500);
	const s0 = await st();
	check('compiling the main arms the watch and draws the pages',
		s0.mode === 'live' && s0.path === MAIN && s0.drawn === 1 && s0.pages > 1,
		JSON.stringify({ mode: s0.mode, pages: s0.pages, files: s0.files }));

	// ── D4, first half: WHICH FILE THE BUTTON WROTE ──────────────
	const wrote = await msg();
	const prev  = await page.evaluate((p) => window.__get(p), PREVIEW);
	const final = await page.evaluate((p) => window.__get(p), FINAL);
	check('D4 the preview is written as -preview.pdf',
		!!prev && prev.size > 1000 && /-preview\.pdf/.test(wrote),
		JSON.stringify({ preview: prev && prev.size, said: wrote.slice(0, 70) }));
	check('D4 AND THE PUBLISHED PDF IS UNTOUCHED — byte for byte what the pipeline left',
		!!final && final.size === SENTINEL.length && final.head.indexOf('the pipeline wrote this') > 0,
		JSON.stringify(final));

	// ── The loop on a chapter ────────────────────────────────────
	await page.evaluate((p) => window.DaimondDoc.show(p), CHAPTER);
	await page.waitForTimeout(600);
	const d1 = (await st()).drawn;
	await edit('Three interruptions per day', 'Zebra interruptions per day');
	const took = await drawnAfter(d1, 20000);
	check('a chapter saved in the Doc panel rebuilds the pages',
		took > 0 && took < 15000, took > 0 ? took + ' ms' : 'never');
	// AND THE NEW WORD IS ON THE PAGE, which is the assertion a build counter cannot
	// make. Only the band in view is ever drawn, so the chapter's page is asked for
	// first — which is D3's jump, used here as the tool it is.
	const at = await page.evaluate((p) => window.DaimondFiles.chapterPage(p), CHAPTER);
	check('D3 the chapter’s own page is found in the book and brought into view',
		at > 1, 'page ' + at);
	check('and the words that were saved are the words on that page',
		/Zebra/.test(await words()));

	// ── D2: the compiler's words reach the source ────────────────
	const f0 = (await st()).failed;
	await edit('== Three Touchpoints', '== Three Touchpoints\n\n#undefinedfn[oops');
	for (let i = 0; i < 60 && (await st()).failed === f0; i++) await sleep(300);
	await sleep(700);
	const said = await note();
	const jump = await page.evaluate(() => {
		const b = document.querySelector('#doc-view .files-jump');
		return b ? b.textContent : '';
	});
	check('D2 the broken build reaches the panel holding the broken file',
		/chap_practice\.typ:\d+/.test(said) && /unclosed|expected|unknown/i.test(said),
		JSON.stringify(said.slice(0, 90)));
	check('and the file and the line are a control, not a sentence',
		/chap_practice\.typ:\d+$/.test(jump), JSON.stringify(jump));
	check('and the pages kept the last build that worked',
		(await st()).drawn === d1 + 1 && /Zebra/.test(await words()));
	await page.evaluate(() => {
		const b = document.querySelector('#doc-view .files-jump');
		if (b) b.click();		// absent under `noerrevent`; the check below is the report
	});
	await page.waitForTimeout(400);
	const caret = await page.evaluate(() => {
		const ta = document.querySelector('#doc-view .files-edit');
		if (!ta) return null;
		return {
			line: ta.value.slice(0, ta.selectionStart).split('\n').length,
			sel:  ta.value.slice(ta.selectionStart, ta.selectionEnd),
		};
	});
	const wantLine = parseInt((jump.match(/:(\d+)$/) || [0, 0])[1], 10);
	check('and pressing it puts the caret on that line of the textarea',
		!!caret && caret.line === wantLine && /undefinedfn/.test(caret.sel),
		JSON.stringify(caret));
	// Put the chapter back together, so the pause checks below are about the pause.
	// Through Cancel first where the jump never opened the editor: a repair typed into
	// a read view is a repair that never happened, and every later check would then be
	// reporting a broken book rather than a broken event.
	await edit('\n\n#undefinedfn[oops', '');
	await drawnAfter(d1 + 1, 20000);

	// ── D1: the pages are evicted, and come back ─────────────────
	// THE AUTHOR'S OWN SEQUENCE, and it is the only one a two-seat stage allows: the
	// pages are up, he opens the source, and the source takes the seat. `show` evicts
	// the OLDEST guest, so the Preview is asked for first and the Doc second — which
	// is the order a person does it in, not an order arranged for the check.
	await page.setViewportSize({ width: 1100, height: 950 });
	await page.waitForTimeout(500);
	await page.evaluate(() => window.DaimondPanels.show('preview'));
	await page.waitForTimeout(400);
	await page.evaluate(() => window.DaimondPanels.show('doc'));
	for (let i = 0; i < 20 && await pagesUp(); i++) await sleep(300);
	check('a two-seat stage really does take the pages off screen', !(await pagesUp()));
	await sleep(1600);
	const sp = await st();
	check('D1 the watch PAUSES rather than stopping — the path and the file list are kept',
		sp.mode === 'paused' && sp.path === MAIN && sp.files > 1,
		JSON.stringify({ mode: sp.mode, was: sp.was, files: sp.files }));
	check('and the panel with the source in it says so, in one line',
		/off screen/i.test(await note()), JSON.stringify((await note()).slice(0, 60)));
	// A save while the pages are hidden is not compiled — that is what pausing MEANS —
	// and it is the change the resume below has to notice.
	const b1 = (await st()).builds;
	await edit('Zebra interruptions', 'Ocelot interruptions');
	await sleep(2500);
	check('and nothing is compiled for a document nobody can see',
		(await st()).builds === b1, JSON.stringify({ was: b1, now: (await st()).builds }));

	await page.setViewportSize({ width: 1900, height: 1000 });
	await page.waitForTimeout(400);
	await page.evaluate(() => window.DaimondPanels.show('preview'));
	for (let i = 0; i < 20 && !(await pagesUp()); i++) await sleep(300);
	const drew = await drawnAfter(sp.drawn, 25000);
	const sr = await st();
	check('D1 the pages coming back resume the watch',
		sr.mode === 'live' && sr.path === MAIN, JSON.stringify({ mode: sr.mode }));
	check('and the save made while they were hidden is built exactly once, on return',
		drew > 0 && sr.builds === b1 + 1, JSON.stringify({ ms: drew, builds: sr.builds, was: b1 }));
	await page.evaluate((p) => window.DaimondFiles.chapterPage(p), CHAPTER);
	check('and the words on the page are the saved ones', /Ocelot/.test(await words()));

	// ── D3: Compile, pressed on a chapter ────────────────────────
	const picked = await page.evaluate((p) => window.DaimondFiles.mainFor(p), CHAPTER);
	check('D3 the main of the project is the file that sets up its own page',
		picked === MAIN, picked);
	const d3 = await st();
	await page.click('#doc-view [data-act="compile"]', { force: true });
	for (let i = 0; i < 60; i++) {
		if (/Compiled|failed|error/i.test(await msg())) break;
		await sleep(400);
	}
	const saidC = await msg();
	check('and pressing Compile on the chapter compiles the book, not the chapter',
		/Compiled/.test(saidC) && saidC.indexOf('onthearche-preview.pdf') > 0
		&& !/label|does not exist/i.test(saidC), JSON.stringify(saidC.slice(0, 120)));
	check('and the panel says which document that was',
		saidC.indexOf(MAIN) > 0, JSON.stringify(saidC.slice(-60)));
	check('and the watch is still following the book',
		(await st()).path === MAIN && (await st()).mode !== 'idle');
	void d3;

	// ── D4: Publish composes the author's own pipeline ───────────
	const cmd = await page.evaluate((p) => window.DaimondFiles.publishCommand(p), MAIN);
	const line = cmd.argv.join(' ');
	check('D4 Publish runs the project’s own dev script, in the project’s own folder',
		line.indexOf('bash ./dev onthearche.typ') > 0 && cmd.cwd === ROOT,
		JSON.stringify({ line, cwd: cmd.cwd }));
	check('and it runs UNDER A MEMORY CAP — a book parks at ~2.9 GB for as long as it watches',
		line.indexOf('systemd-run --user --scope --quiet -p MemoryMax=3G') === 0, JSON.stringify(line));
	check('and it never names the preview: the pipeline writes the final itself',
		line.indexOf('-preview') < 0 && line.indexOf('.pdf') < 0, JSON.stringify(line));
	await page.click('#doc-view [data-act="publish"]', { force: true });
	for (let i = 0; i < 40; i++) {
		const m = await msg();
		if (/Publish failed|Published/.test(m)) break;
		await sleep(300);
	}
	// NO HAND IS PAIRED IN THIS WORLD, and since the placement landed that is answered
	// BEFORE anything is composed: a publish is a `run`, only a device with the machine
	// hand may do one, and the panel now names where it would have to go instead of
	// handing the reader a tool refusal to interpret. So nothing at all is sent from
	// here -- which is a stronger form of "nothing composed elsewhere" than the press
	// sending the right thing, and the shape of the command the button WOULD send is
	// asserted above, straight from `publishCommand`.
	const sent = await page.evaluate(() => window.DaimondFiles.lastPublish());
	check('and with no machine hand nothing is composed or sent at all',
		sent === null || sent === undefined,
		JSON.stringify(sent && sent.argv.join(' ')));
	// AND THE BUTTON ITSELF SAYS SO, which is why the press above sent nothing: the
	// placement labels and DISABLES a publish this device cannot do, so the answer
	// arrives before the reader commits to anything rather than as a refusal afterwards.
	// A panel that reported a publication here would be telling the author his book was
	// printed by a tool that never ran.
	const pb = await page.evaluate(() => {
		const b = document.querySelector('#doc-view [data-act="publish"]');
		return b ? { text: b.textContent || '', title: b.getAttribute('title') || '',
			disabled: !!b.disabled, off: b.classList.contains('files-btn-off') } : null;
	});
	const after = await msg();
	check('and the button says where a publish would have to go, and refuses to pretend',
		!!pb && (pb.disabled || pb.off)
		&& /awake|machine hand|Publish on/i.test(pb.text + ' ' + pb.title)
		&& !/Published →/.test(after),
		JSON.stringify({ btn: pb, msg: after.slice(0, 120) }));
	const stillFinal = await page.evaluate((p) => window.__get(p), FINAL);
	check('and after all of it the published PDF is still the pipeline’s own bytes',
		!!stillFinal && stillFinal.size === SENTINEL.length, JSON.stringify(stillFinal));

	// Nothing above may be passing over a page that is throwing. The world asked for
	// no gateway, so its `/api` is meant to refuse — those are the world's answer to a
	// question this file never asks, and counting them would make every run red.
	const errs = errors(s).filter((e) => !/\/api\/\w+.*50\d|50\d.*\/api\//.test(e));
	check('and the page raised nothing while all of that happened',
		errs.length === 0, errs.slice(0, 2).join(' | '));
} finally {
	await s.close();
}

console.log(`\n${ok.length} ok, ${bad.length} failed`);
if (bad.length) console.log('failed: ' + bad.join('; '));
process.exit(bad.length ? 1 : 0);
