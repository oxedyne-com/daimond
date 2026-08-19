// verify_fileshow.mjs — the daimon can put a file in front of the user, and it
// is told the truth about what they are now looking at.
//
// THE DEFECT, in the daimon's own words, asked to compile a Typst source and
// display the PDF:
//
//   I do see a pre-existing thinking.pdf (1.08 MB) in the CheapThinking/
//   directory from a previous compile, but I cannot display a PDF inline here
//   — the file tools return raw bytes for it rather than a rendered view.
//
// Every clause of that is true about its TOOLBOX and false about Daimond.
// `www/js/viewer.js` has handed `application/pdf` to the browser's own document
// viewer since the `doc` tier was written. What was missing was any way for the
// model to SAY SO, so it reasoned from the tools it held to a limitation of the
// app, told the user about it, and apologised. This file pins the repair:
//
//   1. A FILE THE MODEL NAMES ENDS UP ON THE SCREEN. `window.DaimondDoc.show`
//      is the door `file_show` in src/tools.rs calls from the wasm, and what it
//      must produce is not an element with a blob URL on it — that is what a
//      broken PDF looks like too — but INK ON PAPER, read off a screenshot.
//   2. AND THE MODEL IS TOLD WHAT IS ON IT, from the viewer's own table rather
//      than from a second opinion. The verdict must agree with the `data-viewer`
//      the panel actually drew, including for a `.md`, which goes to the EDITOR
//      and not to the viewer's markdown tier.
//   3. A FORMAT WITH NO VIEWER IS STILL SHOWN, and reported as the hex dump it
//      is. There is no "cannot show" answer, and the model must not be handed
//      one: a refusal shaped like "no viewer for this format" is an invitation
//      to make the same false generalisation one file later.
//   4. IT IS A LIVE HANDLE AND NOT A SNAPSHOT. Rewrite the file, show the same
//      path again, and what is on screen changes. This is what a recompiled
//      document needs in order to reach the reader at all.
//   5. AND IT CAN BE AIMED. A PDF opened at page 3 is not a PDF opened at page
//      1. Measured, because the whole question of whether a watched document can
//      keep a reader's place rests on it.
//   6. AND SHOWING IT AGAIN KEEPS THE PLACE. A re-show with no page named lands
//      where the file was last aimed rather than snapping to page 1 — which,
//      with (4), is what a rebuilt document needs. It is also the MOST that is
//      available: nothing can read where the reader had scrolled to, so what is
//      restored is where we put them and never where they went.
//   7. AND IT MAY NOT TAKE A SCREEN THAT BELONGS TO ANOTHER CONVERSATION. A
//      daimon whose Diamond is not the one in view had the panel open over
//      whatever the user was doing — reported live, from a daimon editing its
//      crystal while the user worked in a different Diamond. `Tool::FileShow`
//      already refused a dispatched WORKER for exactly this reason and in these
//      words: "the document panel belongs to the conversation the user is
//      actually in". The same question is now asked of every owner. The show is
//      held, not dropped, and opens when the user reaches that Diamond.
//
// WHAT THIS FILE DOES NOT PROVE, and nothing here should be read as proving:
// the Rust half. `Tool::FileShow`, its guard, its refusals and the English it
// composes are not in `www/pkg` until the wasm is rebuilt, so this drives the
// JavaScript contract — `window.DaimondDoc` — which is exactly where the Rust
// edge lands. The guard and the sentence are covered by the unit tests in
// src/tools.rs.
//
// EACH CHECK IS PROVED AGAINST BROKEN CODE FIRST. `--break <name>` serves a
// deliberately damaged copy of a source file to the real page through
// `page.route`, and the run is expected to FAIL. A break whose anchor does not
// appear exactly once aborts rather than passing quietly.
//
//   node dev/verify_fileshow.mjs --break seam     # 1 fails: nothing reaches the panel
//   node dev/verify_fileshow.mjs --break verdict  # 2 fails: a .md is reported as rendered
//   node dev/verify_fileshow.mjs --break floor    # 2 and 3 fail: everything claims to be a document
//   node dev/verify_fileshow.mjs --break stale    # 4 fails: the rewritten file is not redrawn
//   node dev/verify_fileshow.mjs --break aim      # 5 fails: page 3 opens at page 1
//   node dev/verify_fileshow.mjs --break place    # 6 fails: the rebuild loses the reader's place
//   node dev/verify_fileshow.mjs --break screen   # 7 fails: a background Diamond takes the panel
//   node dev/verify_fileshow.mjs                  # and then, clean
//
// A break may redden more than the check it is named for, and two here do:
// `stale` takes the aim checks with it, because a panel that never redraws never
// re-aims either. What matters is that each check goes red for the break that
// names it, and that no check is green when its own subject is broken.
//
//   eval "$(bash dev/world.sh 4 --up)"
//   node dev/verify_fileshow.mjs
//
// Needs dev/serve.mjs only. No gateway, no mock LLM, no wasm rebuild.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, scratch } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

const PROFILE = scratch('pw', 'fileshow' + (BREAK ? '-' + BREAK : ''));
fs.rmSync(PROFILE, { recursive: true, force: true });

let bad = 0;
const check = (pass, name, detail) => {
	if (!pass) bad++;
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

// ── The seam ─────────────────────────────────────────────────────────
//
// Only `daimond.js` can open a file in the Doc panel: the panel, its header and
// the routing between the editor and the viewer are all inside that module's
// closure. So it hands its opener to `viewer.js`, which owns everything else
// about what showing a file means, and that one line is the seam.
//
// It is checked rather than assumed. If it has not landed, the run says so as a
// FAILURE and then serves a patched copy for the rest of the file, so the design
// can be seen working without the green being borrowed from code that is not
// there. Once the line is in `daimond.js`, nothing is patched at all.

const SEAM_SPEC = { file: 'js/daimond.js', find: '\t})();\n\n\t// ── The Terminal panel' };
const SEAM = '\t})();\n\n'
	+ '\t// The daimon\'s door to the Doc panel. `file_show` in src/tools.rs reaches it\n'
	+ '\t// from the wasm through `window.DaimondDoc`, which `js/viewer.js` installs --\n'
	+ '\t// but only THIS module can open a file: the panel, its header and the routing\n'
	+ '\t// between the editor and the viewer all live in this closure. So the opener is\n'
	+ '\t// handed over, and viewer.js keeps the question of what showing a file MEANS.\n'
	+ '\t//\n'
	+ '\t// Registered here rather than on first use of the panel: a tool call can arrive\n'
	+ '\t// before the user has opened anything, and a door wired lazily is a door the\n'
	+ '\t// model finds shut and reports as absent.\n'
	+ '\tif (window.DaimondViewer && DaimondViewer.opener) DaimondViewer.opener(Files.open);\n\n'
	+ '\t// ── The Terminal panel';

const seamLanded = () => fs.readFileSync(path.join(WWW, 'js/daimond.js'), 'utf8')
	.indexOf('DaimondViewer.opener(Files.open)') !== -1;

// ── The breaks ───────────────────────────────────────────────────────
// Each is a real edit to a real file, served in place of it.
const BREAKS = {
	// The door is never opened. This is the state the defect was reported from:
	// the panel works, the viewer works, and nothing outside `daimond.js` can
	// reach either — so a model asked to display a file correctly concludes it
	// has no way to, which is the sentence this whole lane exists to delete.
	seam: 'no-seam',
	// The verdict stops asking the panel's routing question and answers with the
	// viewer's tier. A `.md` is then reported to the model as rendered Markdown
	// while the user is looking at an editor — a small lie the model will repeat.
	verdict: [{
		file: 'js/viewer.js',
		find: '\t\tvar tier = editable(info) ? \'editor\' : info.handler;',
		with: '\t\tvar tier = info.handler;',
	}],
	// A second opinion, which is what the whole shape of this was written to
	// avoid: the verdict asserts a document rather than reading the table.
	floor: [{
		file: 'js/viewer.js',
		find: '\t\tvar tier = editable(info) ? \'editor\' : info.handler;',
		with: '\t\tvar tier = \'doc\';',
	}],
	// The classic wrong optimisation: opening the file that is already open is
	// treated as nothing to do. Harmless until the file is REWRITTEN between the
	// two calls, which is precisely what a recompile does — and then the view is
	// a snapshot of the old bytes and the reader is never told.
	//
	// Note which check this reddens and which it does not. The verdict is probed
	// fresh either way, so the SIZE the model is told is right while the screen is
	// wrong: a check that only read the verdict would pass here. The ink is what
	// catches it.
	stale: [{
		file: 'js/daimond.js',
		find: '\t\tasync function openFile(path, opts) {',
		with: '\t\tasync function openFile(path, opts) {\n\t\t\tif (curFile === path) return;',
	}],
	// The aim is remembered and never spent, so every document opens at the top.
	aim: [{
		file: 'js/viewer.js',
		find: '\t\te.src = mint(blob) + aimFrag(path);',
		with: '\t\te.src = mint(blob);',
	}],
	// A show with no page forgets where this file was. Harmless on a first show
	// and ruinous on the second: it is what makes "the PDF was rebuilt" and "I
	// lost where I was on page 214" the same event.
	// The question is asked and the answer is thrown away, which is the state the
	// defect was reported from: every owner may take every screen. Note that this
	// is the ONLY break here that reddens a check about who is looking rather than
	// about what is drawn — the panel is perfectly correct throughout, and shows
	// the wrong person.
	screen: [{
		file: 'js/viewer.js',
		find: '\t\tif (!owner || !screenOwner) return true;',
		with: '\t\tif (!owner || !screenOwner || owner) return true;',
	}],
	place: [{
		file: 'js/viewer.js',
		find: '\t\tif (n > 0) { aim = { path: path, page: n }; return; }\n'
			+ '\t\tif (!aim || aim.path !== path) aim = null;',
		with: '\t\taim = (n > 0) ? { path: path, page: n } : null;',
	}],
};

if (BREAK && !BREAKS[BREAK]) {
	console.error(`unknown break '${BREAK}'; one of: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}

/// Apply one edit to `src`, or stop dead. Nothing is served that was not verified
/// to differ from the file on disk: a break whose anchor matched nothing would
/// leave the run green against working code and prove the opposite of its claim.
function apply(src, spec, why) {
	const n = src.split(spec.find).length - 1;
	if (n !== 1) {
		console.error(`${why}: the anchor appears ${n} times in ${spec.file}, `
			+ 'so nothing was changed and the run below would prove nothing.');
		process.exit(2);
	}
	return src.replace(spec.find, spec.with);
}

// ── The fixtures ─────────────────────────────────────────────────────

const ascii = (s) => Array.from(s, (c) => c.charCodeAt(0) & 0xff);

/// A COMPLETE, VALID PDF whose pages carry different amounts of ink.
///
/// The ink is the instrument. Every check below that says "the document is on
/// screen" or "it opened at page 3" reads a screenshot, because the DOM cannot
/// tell a rendered page from a grey box with a broken-page glyph in it — which
/// is exactly how a PDF that had never once appeared passed five green checks
/// for months in `verify_fileview.mjs`.
///
/// Built rather than pasted: the cross-reference table carries byte offsets into
/// the file, and a hand-written one goes stale on the first edit.
///
/// # Arguments
/// * `fracs` - One entry per page: how much of that page is a black bar.
function buildPdf(fracs) {
	const n = fracs.length;
	const objs = ['<< /Type /Catalog /Pages 2 0 R >>'];
	const kids = [];
	for (let i = 0; i < n; i++) kids.push(`${3 + i * 2} 0 R`);
	objs.push(`<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${n} >>`);
	for (let i = 0; i < n; i++) {
		const h = Math.max(1, Math.round(600 * fracs[i]));
		const stream = `0 0 0 rg\n0 0 400 ${h} re\nf\n`;
		objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 600] /Contents ${4 + i * 2} 0 R >>`);
		objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}endstream`);
	}
	let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
	const at = [];
	objs.forEach((o, i) => { at.push(out.length); out += (i + 1) + ' 0 obj\n' + o + '\nendobj\n'; });
	const startxref = out.length;
	out += 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n';
	at.forEach((x) => { out += String(x).padStart(10, '0') + ' 00000 n \n'; });
	out += 'trailer\n<< /Size ' + (objs.length + 1) + ' /Root 1 0 R >>\n'
		+ 'startxref\n' + startxref + '\n%%EOF\n';
	return ascii(out);
}

// Three pages, each with visibly more ink than the last, so a census of the
// screen says which page the viewer chose to open at.
const PDF3     = buildPdf([0.05, 0.50, 0.95]);
// The same document REBUILT: one page, and much darker than page 1 above. This
// is the recompile, and the check is that the reader sees the new one.
const PDF_REDO = buildPdf([0.92]);

const MD  = ascii('# Heading\n\nsome *text*\n');

// Sixteen readable bytes then a NUL: unrecognisable to the probe, so it lands on
// the honest floor, and the readable run proves the dump is showing THESE bytes.
const BIN_HEAD = 'DAIMOND BYTES!!!';
const BIN = ascii(BIN_HEAD).concat([0x00]);
while (BIN.length < 300) BIN.push((BIN.length * 37) & 0xff);

// ── Driving ──────────────────────────────────────────────────────────

/// Serve whatever this run needs to be different about the page.
///
/// One pass over the sources, because the seam and a break can land in the SAME
/// file: `--break stale` damages `daimond.js`, which is also where the seam goes,
/// and two `page.route` handlers for one URL would leave one of the two edits
/// silently unserved.
async function stub(page) {
	const edited = {};
	const edit = (spec, why) => {
		const src = edited[spec.file]
			|| fs.readFileSync(path.join(WWW, spec.file), 'utf8');
		edited[spec.file] = apply(src, spec, why);
	};
	// The seam, when it is not in the tree yet. `--break seam` withholds it EITHER
	// WAY: it skips the patch while the line is absent, and STRIPS the line once
	// it is there.
	//
	// The second half arrived with the seam itself. "Withhold" used to mean only
	// "do not add", which is the same as doing nothing the moment the line landed
	// in daimond.js -- and this break, the one that stages the very state the
	// defect was reported from, then passed. A break that cannot fail proves
	// nothing about the check it is named for.
	if (BREAK === 'seam') {
		if (seamLanded()) {
			edit({
				file: 'js/daimond.js',
				find: '\tif (window.DaimondViewer && DaimondViewer.opener) DaimondViewer.opener(Files.open);\n',
				with: '',
			}, 'break \'seam\'');
		}
	} else if (!seamLanded()) {
		edit({ ...SEAM_SPEC, with: SEAM }, 'the seam patch');
	}
	if (BREAK && BREAK !== 'seam') {
		for (const spec of BREAKS[BREAK]) edit(spec, `break '${BREAK}'`);
	}
	for (const file of Object.keys(edited)) {
		const body = edited[file];
		await page.route('**/' + file, (r) => r.fulfill({
			status: 200, contentType: 'application/javascript', body,
		}));
	}
}

const s = await open({ name: 'fileshow', profile: PROFILE, connect: false, defaults: false,
	route: stub });
const { page } = s;

/// Write bytes into the workspace through the same door the app uses.
const put = (p, bytes) => page.evaluate(async ({ p, bytes }) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	await app.write_bytes(p, new Uint8Array(bytes));
}, { p, bytes });

/// Call the door the daimon calls, and hand back what the model would be told.
///
/// Resolves `{ ok, verdict }` or `{ ok:false, error }`, because a rejection is an
/// answer too: it is what the model gets when there is no panel to show a file in.
const show = (p, pg, owner) => page.evaluate(async ({ p, pg, owner }) => {
	if (!window.DaimondDoc || typeof DaimondDoc.show !== 'function') {
		return { ok: false, error: 'window.DaimondDoc is not on the page' };
	}
	try {
		// Three arguments and not two: `owner` is what the wasm passes from
		// `ToolContext::daimon`, and a call that omits it is the user's own act.
		const json = await DaimondDoc.show(p, pg, owner);
		return { ok: true, verdict: JSON.parse(json) };
	} catch (e) {
		return { ok: false, error: String((e && e.message) || e) };
	}
}, { p, pg, owner });

/// What the PREVIEW PANEL holds — `#pv-view`, the panel a person reads, never a
/// host of this file's own. The claim being made is about the user's screen.
///
/// It was `#doc-view` until the Doc panel was split in two. A file that is not
/// characters is a RENDERING of a file, so it is drawn in the Preview panel and the
/// Doc panel is left holding whatever is being edited — which is the point of the
/// split, and is why `docPre` is read as well: it is the assertion that the
/// document beside this one was NOT replaced by it.
const inPanel = () => page.evaluate(() => {
	const fv  = document.querySelector('#pv-view .fileview');
	const pre = document.querySelector('#pv-view .files-view-body');
	const em  = document.querySelector('#pv-view .fileview embed');
	const hex = document.querySelector('#pv-view .fileview .fv-hex');
	const nm  = document.getElementById('pv-name');
	const dp  = document.querySelector('#doc-view .files-view-body');
	return {
		viewer: fv ? fv.getAttribute('data-viewer') : null,
		embed:  em ? { type: em.getAttribute('type'), frag: (em.src.split('#')[1] || '') } : null,
		hex:    hex ? hex.textContent : null,
		pre:    pre ? pre.textContent.slice(0, 120) : null,
		name:   nm ? nm.textContent : null,
		docPre: dp ? dp.textContent.slice(0, 120) : null,
	};
});

/// A census of light and dark inside `sel`, decoded from a screenshot by the page
/// itself. THE ONLY INSTRUMENT THAT CAN TELL A RENDERED PAGE FROM A BROKEN ONE:
/// both are an element with a `blob:` URL on it.
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
			res({ dark: dark / n, light: light / n });
		};
		img.onerror = () => res(null);
		img.src = 'data:image/png;base64,' + b64;
	}), png.toString('base64'));
};

const pct = (x) => (x == null ? '?' : (x * 100).toFixed(1) + '%');

try {
	await page.waitForTimeout(1200);

	check(seamLanded(), 'the seam is in js/daimond.js: the panel hands its opener to the viewer',
		seamLanded() ? '' : 'NOT YET — the rest of this run drives a patched copy served '
			+ 'through page.route, so the green below belongs to the design and not to the tree');

	await put('show/report.pdf', PDF3);
	await put('show/notes.md',   MD);
	await put('show/thing.bin',  BIN);

	// ── 1. A file the model names ends up on the screen ──────────
	const one = await show('show/report.pdf');
	check(one.ok, 'the daimon has a door to the document panel at all',
		one.ok ? '' : one.error);
	const panel1 = one.ok ? await inPanel() : null;
	check(!!(panel1 && panel1.viewer === 'doc' && panel1.embed
			&& panel1.embed.type === 'application/pdf'),
		'and naming a PDF puts it in the panel, typed for the browser’s own viewer',
		panel1 ? JSON.stringify(panel1.embed) : 'the panel holds nothing');
	check(!!(panel1 && panel1.name === 'show/report.pdf'),
		'with the panel naming the file the model asked for',
		panel1 ? String(panel1.name) : '');

	// AND IT IS DRAWN. Everything above is true of a grey box with a
	// broken-page glyph in it. The gap is enormous: a sandboxed frame over the
	// same file scores 0.0% dark and 0.0% light, and a rendered page scores tens
	// of percent of each, so 2% is nowhere near either state.
	await page.waitForTimeout(2500);
	const ink1 = await inkCensus('#pv-view .fv-doc');
	check(!!ink1 && ink1.dark > 0.02 && ink1.light > 0.02,
		'and the document is DRAWN — ink on paper, read off the screen',
		ink1 ? `dark ${pct(ink1.dark)}, light ${pct(ink1.light)}` : 'nothing to measure');

	// ── 2. The model is told what is on the screen ───────────────
	const v1 = one.ok ? one.verdict : {};
	check(v1.tier === 'doc' && v1.media === 'Pdf',
		'the model is told which tier drew it and what the format is',
		JSON.stringify({ tier: v1.tier, media: v1.media }));
	check(v1.size === PDF3.length,
		'and how big the file is, from the file rather than from a guess',
		`said ${v1.size}, wrote ${PDF3.length}`);
	check(!!v1.label && v1.label !== v1.media,
		'in words rather than in an identifier, so the sentence reads',
		JSON.stringify(v1.label));

	// The verdict answers the PANEL'S routing question, not the viewer's. A `.md`
	// keeps the editor — this is where DAIMOND.md and the role prompts are
	// changed — and a model told "rendered Markdown" would describe a screen the
	// user is not looking at.
	const md = await show('show/notes.md');
	const panelMd = await inPanel();
	check(md.ok && md.verdict.tier === 'editor',
		'a Markdown file is reported as being in the editor',
		md.ok ? String(md.verdict.tier) : md.error);
	// `docPre`, the DOC panel's body: an editable file goes there, beside whatever
	// rendering the Preview panel is holding rather than over it.
	check(!!(panelMd.docPre && /Heading/.test(panelMd.docPre)),
		'and that is what the panel is really showing',
		JSON.stringify(panelMd.docPre));

	// ── 3. A format with no viewer is shown, and said ────────────
	const bin = await show('show/thing.bin');
	const panelBin = await inPanel();
	check(bin.ok && bin.verdict.tier === 'hex',
		'a format nothing recognises is reported as the hex dump it is',
		bin.ok ? String(bin.verdict.tier) : bin.error);
	check(!!(panelBin.hex && panelBin.hex.indexOf(BIN_HEAD) !== -1),
		'and it IS shown — the dump on screen carries this file’s own bytes',
		panelBin.hex ? JSON.stringify(panelBin.hex.slice(0, 60)) : 'no dump');

	// ── 4. A live handle, not a snapshot ─────────────────────────
	//
	// The whole of what makes a recompiled document reach the reader. The tool
	// names a PATH; the panel reads the file; so writing the file again and
	// showing the same path again puts the new bytes on screen. A view handed
	// CONTENT could not do this at all.
	await show('show/report.pdf');
	await page.waitForTimeout(2500);
	const before = await inkCensus('#pv-view .fv-doc');
	await put('show/report.pdf', PDF_REDO);
	const redo = await show('show/report.pdf');
	await page.waitForTimeout(2500);
	const after = await inkCensus('#pv-view .fv-doc');
	check(redo.ok && redo.verdict.size === PDF_REDO.length,
		'showing the same path after a rewrite reports the NEW file’s size',
		redo.ok ? `said ${redo.verdict.size}, wrote ${PDF_REDO.length}` : redo.error);
	check(!!(before && after && Math.abs(after.dark - before.dark) > 0.05),
		'and the reader is looking at the rewritten document, not the old one',
		before && after ? `dark ${pct(before.dark)} → ${pct(after.dark)}` : 'nothing to measure');

	// ── 5. And it can be aimed ───────────────────────────────────
	//
	// Measured because everything a watched document could do about the reader's
	// place rests on it. `#page=N` on a `blob:` URL DOES reach the browser's PDF
	// viewer; nothing reads the position back out, so a document can be reopened
	// where it was last AIMED and never where the reader had scrolled to.
	await put('show/report.pdf', PDF3);
	await show('show/report.pdf', 1);
	await page.waitForTimeout(2500);
	const at1 = await inkCensus('#pv-view .fv-doc');
	const aimed = await show('show/report.pdf', 3);
	await page.waitForTimeout(2500);
	const at3 = await inkCensus('#pv-view .fv-doc');
	const panelAimed = await inPanel();
	check(!!(panelAimed.embed && panelAimed.embed.frag === 'page=3'),
		'a page asked for reaches the element as a fragment',
		panelAimed.embed ? JSON.stringify(panelAimed.embed.frag) : 'no embed');
	check(!!(at1 && at3 && at3.dark - at1.dark > 0.1),
		'and page 3 is on screen rather than page 1 — the ink says so',
		at1 && at3 ? `dark ${pct(at1.dark)} at page 1, ${pct(at3.dark)} at page 3` : 'nothing to measure');
	check(aimed.ok && aimed.verdict.page === 3,
		'with the model told which page it is actually looking at',
		aimed.ok ? String(aimed.verdict.page) : aimed.error);

	// ── 6. And showing it AGAIN keeps the place ──────────────────
	//
	// The two halves of a watched document: it must come back with the new bytes
	// (4) and it must come back where the reader was (this). Nothing can read
	// where they had SCROLLED to — the browser's PDF viewer answers no query and
	// says nothing when it moves — so the most that is available is that a
	// re-show with no page named lands where the file was last aimed, rather than
	// snapping to page 1. That is what is checked here, and the page reported to
	// the model is the one the panel used and not the argument it was given.
	await put('show/report.pdf', PDF3);		// the rebuild: same path, same three pages
	const again = await show('show/report.pdf');
	await page.waitForTimeout(2500);
	const stillAt3 = await inkCensus('#pv-view .fv-doc');
	check(again.ok && again.verdict.page === 3,
		'showing it again with no page named reports the page it was left at',
		again.ok ? String(again.verdict.page) : again.error);
	check(!!(stillAt3 && at1 && stillAt3.dark - at1.dark > 0.1),
		'and the reader is still on page 3 rather than back at page 1',
		stillAt3 && at1 ? `dark ${pct(stillAt3.dark)} against ${pct(at1.dark)} at page 1`
			: 'nothing to measure');

	// ── 7. And it may not take a screen that belongs elsewhere ───
	//
	// The owner is stubbed rather than driven through the rail: what is under test
	// is the RULE — does a show name the conversation asking, and is it compared
	// with the one in view — and building two Diamonds to answer it would put the
	// rail's own defects between this check and the thing it measures. The stub
	// goes in through the same door `daimond.js` uses, so the seam being exercised
	// is the shipped one and not a copy.
	//
	// Note what is asserted about the REFUSED show, because the weak version of
	// this check is "it returned something": the panel must still hold the file
	// from the show BEFORE it, which is the actual complaint — a user mid-document
	// having it swapped underneath them.
	await put('show/other.pdf', PDF3);
	await page.evaluate(() => DaimondViewer.screenOwner(() => 'd-onscreen'));

	const mine = await show('show/report.pdf', 1, 'd-onscreen');
	await page.waitForTimeout(1500);
	check(mine.ok && mine.verdict.shown === true,
		'the Diamond the user is looking at may put a file on their screen',
		mine.ok ? JSON.stringify(mine.verdict.shown) : mine.error);
	const held = await inPanel();

	const theirs = await show('show/other.pdf', 1, 'd-elsewhere');
	await page.waitForTimeout(1500);
	check(theirs.ok && theirs.verdict.shown === false,
		'and a Diamond the user is NOT looking at is told its show did not land',
		theirs.ok ? JSON.stringify(theirs.verdict.shown) : theirs.error);
	const kept = await inPanel();
	check(kept.name === held.name && held.name === 'show/report.pdf',
		'while the panel goes on holding the document the user was actually reading',
		`was ${JSON.stringify(held.name)}, now ${JSON.stringify(kept.name)}`);

	// HELD, NOT DROPPED. The refusal is "not yet", so the file has to be waiting
	// when the user reaches that Diamond — and waiting exactly once, or every
	// later visit reopens a panel about a turn everyone has forgotten.
	const waiting = await page.evaluate(() => [
		DaimondViewer.takeDeferred('d-elsewhere'),
		DaimondViewer.takeDeferred('d-elsewhere'),
	]);
	check(waiting[0] === 'show/other.pdf',
		'and the file it wanted shown is held for when the user opens that Diamond',
		JSON.stringify(waiting[0]));
	check(waiting[0] !== '' && waiting[1] === '',
		'once, so a later visit does not reopen a panel about a forgotten turn',
		JSON.stringify(waiting));
} finally {
	await s.close();
}

console.log(bad ? `\n${bad} check(s) FAILED` : '\nall checks passed');
process.exit(bad ? 1 : 0);
