// verify_vocabulary.mjs — the guide's Social page says true things, in words the
// app itself uses, and lands where a deep link points it.
//
// The page exists so that a user reporting a fault and a person reading the
// report use the same word for the same thing. That only works if the words are
// the APP'S words, so the checks below are mostly checks against the app rather
// than against the page's own internal consistency. A glossary that agrees with
// itself and disagrees with the interface is worse than none: it teaches a
// vocabulary that will not be understood.
//
// Ten properties:
//
//   0. THE PAGE DOES NOT SCROLL SIDEWAYS ON A PHONE. A guide page a phone
//      reader has to drag left and right is a guide page they fight. Measured
//      as the document's own overflow at 360px, which is what the reader's
//      thumb feels, and not as any one element's width.
//
//   1. EVERY TERM IS THE APP'S OWN WORD. Each glossary entry names a piece of
//      evidence — a string in `www/i18n/en.js`, or a sentence already in another
//      guide page — and that evidence has to be findable. This is the check that
//      would catch a coined word, which is the one failure that makes the page
//      actively harmful.
//
//   2. NO CROP IS BLANK. A crop is taken by selector from the running app, and a
//      selector that matches an element which is on the page but invisible
//      produces a rectangle of one flat colour. That happened during this page's
//      own making: `.attach-btn` is `visibility: hidden` until its row is
//      hovered, and the first paperclip crop was a black square. Measured by
//      counting distinct colours, not by file size.
//
//   3. THE DIAGRAM IS LEGIBLE IN BOTH A LIGHT AND A DARK PALETTE. It is drawn in
//      the palette's variables so it can follow the reader, and the whole point
//      of that is lost if the labels vanish on one of them. The label colour is
//      sampled against the surface it is drawn on, in both, and held to the
//      contrast the app's own audit uses.
//
//   4. A DEEP LINK LANDS ON ITS SECTION, ON A DESKTOP AND ON A PHONE. The
//      Improve panel is to carry a button that opens this page at a named
//      anchor, so the anchors are an interface and not an implementation
//      detail. Each is navigated to, and the section has to end up BELOW the
//      sticky header rather than under it. The header GROWS after the first
//      landing, at every width, because search.js builds its box and appends
//      it: measured against the code before this page, every anchor landed
//      about 32px under the header and stayed there. Both widths, because the
//      header wraps to four rows on a phone and the failure is larger.
//
//   5. THE ANCHORS SURVIVE THE INDEX BUILD. `dev/guide-index.mjs` renumbers
//      every h2 and h3 to a positional id, so an id written on a heading is
//      erased the next time the index is built. The page puts them on section
//      wrappers instead; this asserts that they are still there afterwards.
//
//   6. THE PAGE OBSERVES THE HOUSE PUNCTUATION. No em dash, no en dash, no
//      double hyphen in its prose.
//
//   7. THE DIAGRAM'S WORDS ARE STILL WORDS ON A PHONE. Scaled to a 360px
//      column the whole schematic put its labels at five pixels. Measured as
//      RENDERED INK — the height of a label's own box at that width — and not
//      as a font-size in the stylesheet, which says nothing once an SVG has
//      been scaled to fit.
//
//   8. THE LANGUAGE SWITCHER OFFERS ONLY PAGES THAT EXIST. `data-guide-locales`
//      is what frame.js reads to decide whether a change of language means
//      going anywhere, so a locale named there and not on disk is a 404 the
//      reader is walked into. It is checked both ways: nothing promised that is
//      missing, and nothing on disk that is not offered.
//
//   9. AND NO TRANSLATION SCROLLS SIDEWAYS EITHER. Property 0 measures the
//      English page, and the English page is the shortest. The same quoted
//      sentence runs 211 pixels past the edge in French, and every translated
//      copy spills on BOTH quotations where English spills on one, so a fix
//      proved against English alone is a fix proved against the easy case.
//
// EACH CHECK IS PROVED AGAINST A BROKEN PAGE FIRST. `--break <name>` damages a
// copy of a file and serves it to the real browser through `page.route`, or
// damages the input a static check reads, and the run is expected to FAIL. A
// break that does not apply cleanly aborts rather than passing quietly.
//
//   node dev/verify_vocabulary.mjs --break coined     # 1 fails
//   node dev/verify_vocabulary.mjs --break blankcrop  # 2 fails
//   node dev/verify_vocabulary.mjs --break invisible  # 3 fails
//   node dev/verify_vocabulary.mjs --break nomargin   # 4 fails
//   node dev/verify_vocabulary.mjs --break heading    # 5 fails
//   node dev/verify_vocabulary.mjs --break dash       # 6 fails
//   node dev/verify_vocabulary.mjs --break tinylabels # 7 fails
//   node dev/verify_vocabulary.mjs --break nolanding  # 4 fails, at 360px only
//   node dev/verify_vocabulary.mjs --break sideways   # 0 fails
//   node dev/verify_vocabulary.mjs --break promise    # 8 fails, on the half
//   node dev/verify_vocabulary.mjs --break unlisted   # 8 fails, on the other
//   node dev/verify_vocabulary.mjs --break sideloc    # 9 fails, and 0 does not
//   node dev/verify_vocabulary.mjs                    # and then, clean
//
//   eval "$(bash dev/world.sh 6 --up)"
//   node dev/verify_vocabulary.mjs
//
// Needs dev/serve.mjs only: the guide is flat files and loads none of the app.
// Writes its screenshots to dev/shots/vocab-page-*.png.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Chromium's ozone platform is chosen by autodetection and prefers Wayland whenever
// `WAYLAND_DISPLAY` is set -- which it is in every rc session on argonaut -- so a headed
// run under `xvfb-run` still went to the compositor and opened a window on the owner's
// desktop. Importing this strips the two variables from `process.env`, which is all a
// launcher that spreads `process.env` needs. See dev/display.mjs.
import './display.mjs';
const HERE  = path.dirname(fileURLToPath(import.meta.url));
const WWW   = path.join(HERE, '..', 'www');
const GUIDE = path.join(WWW, 'guide');
const PAGE  = path.join(GUIDE, 'social.html');
const SHOTS = path.join(HERE, 'shots');
const APP   = process.env.DAIMOND_APP || `http://localhost:${process.env.DAIMOND_PORT || 8777}`;
const PW    = process.env.DAIMOND_PW
	|| path.join(os.homedir(), '.red-pw/node_modules/playwright-core/index.mjs');
const CHROME = process.env.DAIMOND_CHROME
	|| `${process.env.HOME}/.cache/ms-playwright/chromium-1229/chrome-linux64/chrome`;
const SCRATCH = process.env.DAIMOND_SCRATCH || path.join(os.homedir(), '.cache/daimond');

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const die = (why) => { console.error('ABORT: ' + why); process.exit(2); };

// ── What the page claims, and where the app says it ──────────────────
//
// One row per glossary entry: the anchor it sits at, the word, and a string that
// has to appear in the app's own English catalogue or in another guide page. The
// evidence is deliberately a WHOLE PHRASE and not the bare word, so that a term
// cannot be justified by a coincidence in a comment.
const TERMS = [
	['term-chip',      'chip',        'i18n', "so the chip would refuse every turn"],
	['term-tile',      'tile',        'i18n', "'tile.settings': 'Settings for this tile'"],
	['term-head',      'head',        'guide', 'on the Diamonds head'],
	['term-closer',    'closer',      'guide', "rail's own closer"],
	['term-cog',       'cog',         'guide', "tile's own cog"],
	['term-light',     'light',       'guide', 'Its light is the root of every other'],
	['term-divider',   'divider',     'guide', 'divider you can drag'],
	['term-row',       'row',         'guide', 'row in the admin panel'],
	['term-spend-row', 'spend row',   'i18n', "The three cells of the rail's spend row"],
	['term-composer',  'composer',    'guide', 'the composer stays put'],
	['term-face',      'face',        'i18n', "'Which face of this Diamond'"],
	['term-tag',       'tag',         'i18n', "'tag.pool_toggle':    'Filter by tag ({n})'"],
	['term-dialog',    'dialog',      'i18n', "'dlg.are_you_sure': 'Are you sure?'"],
	['term-gallery',   'gallery',     'guide', 'opens the <strong>gallery</strong>'],
	['term-goto',      'Go to box',   'i18n', "'pal.close':           'Close the Go to box'"],
	['term-sheet',     'sheet',       'i18n', "'sheet.close':         'Close the sheet'"],
	['term-drawer',    'drawer',      'guide', 'the rail becomes a drawer'],
	['term-paperclip', 'paperclip',   'guide', 'header carries the paperclip'],
];

/// Walk the page top to bottom, so every `loading="lazy"` crop has pixels
/// before a full-page screenshot is taken of it.
async function unlazy(pg) {
	await pg.evaluate(async () => {
		const step = window.innerHeight * 0.8;
		for (let y = 0; y < document.body.scrollHeight; y += step) {
			window.scrollTo(0, y);
			await new Promise((r) => setTimeout(r, 120));
		}
		window.scrollTo(0, 0);
		await new Promise((r) => setTimeout(r, 250));
	});
}

/// The sections a deep link may name. These are a published interface: the
/// Improve panel's own button opens the guide at one of them.
const ANCHORS = ['writing-a-note', 'regions', 'glossary', 'two-words', 'social-panel'];

// ── The breaks ───────────────────────────────────────────────────────
//
// Each returns the bytes to serve in place of a real file, or mutates the input
// a static check reads. Nothing on disk is touched.
let pageBytes = fs.readFileSync(PAGE, 'utf8');
let en        = fs.readFileSync(path.join(WWW, 'i18n', 'en.js'), 'utf8');
let guideText = fs.readdirSync(GUIDE).filter((f) => f.endsWith('.html') && f !== 'social.html')
	.map((f) => fs.readFileSync(path.join(GUIDE, f), 'utf8')).join('\n');
let blankCrop = null;      // a crop name to replace with a flat rectangle

/// The locale folders that actually hold a Social page. A folder is a locale,
/// not `legal/` or `img/`, on the same shape guide-index.mjs uses.
const onDiskLocales = fs.readdirSync(GUIDE, { withFileTypes: true })
	.filter((e) => e.isDirectory() && /^[a-z]{2}(-[A-Za-z]+)?$/.test(e.name))
	.map((e) => e.name)
	.filter((l) => fs.existsSync(path.join(GUIDE, l, 'social.html')))
	.sort();

/// Each translated page's bytes, by locale, so a break can damage them in
/// flight the way it damages the English page.
const localeBytes = {};
for (const l of onDiskLocales) localeBytes[l] = fs.readFileSync(path.join(GUIDE, l, 'social.html'), 'utf8');

const applied = [];
switch (BREAK) {
	case '': break;
	case 'coined': {
		// A term with no evidence anywhere: the failure this page exists to avoid.
		TERMS.push(['term-widget', 'widget', 'i18n', "'widget.name': 'Widget'"]);
		applied.push('added a coined term with no evidence');
		break;
	}
	case 'blankcrop': {
		blankCrop = 'vocab-paperclip.png';
		applied.push('served a flat rectangle for ' + blankCrop);
		break;
	}
	case 'invisible': {
		// The diagram's labels drawn in the surface colour they sit on: legible
		// on neither palette, and exactly what a hard-coded colour would do on
		// one of the two.
		const before = pageBytes;
		pageBytes = pageBytes.replace('.wm-lab  { fill: var(--accent-text); font-weight: 700; }',
			'.wm-lab  { fill: var(--bg-primary); font-weight: 700; }');
		if (pageBytes === before) die('the invisible break did not apply');
		applied.push('drew the diagram labels in the background colour');
		break;
	}
	case 'nomargin': {
		// frame.js installs the rule that keeps a jump clear of the sticky
		// header. Without it a deep link lands with its section under the header.
		applied.push('removed the scroll-margin rule frame.js installs');
		break;
	}
	case 'heading': {
		// The ids moved onto the headings, where dev/guide-index.mjs erases them
		// on its next run. Simulated by taking them off the sections.
		const before = pageBytes;
		for (const a of ANCHORS) pageBytes = pageBytes.replace(`<section id="${a}">`, '<section>');
		if (pageBytes === before) die('the heading break did not apply');
		applied.push('moved the section anchors off the sections');
		break;
	}
	case 'nolanding': {
		applied.push('took the re-landing out of frame.js');
		break;
	}
	case 'tinylabels': {
		// The width floor removed, so the diagram is scaled to the phone column
		// and its labels go with it.
		const before = pageBytes;
		pageBytes = pageBytes.replace('.diagram.scrolls svg { min-width: 640px; }', '');
		if (pageBytes === before) die('the tinylabels break did not apply');
		applied.push('let the diagram scale down to the phone column');
		break;
	}
	case 'dash': {
		const before = pageBytes;
		pageBytes = pageBytes.replace('<h1>Social</h1>', '<h1>Social — the vocabulary</h1>');
		if (pageBytes === before) die('the dash break did not apply');
		applied.push('put an em dash in the heading');
		break;
	}
	case 'sideways': {
		// The rule that lets a quoted sentence wrap. Without it the pill in
		// guide.css keeps `white-space: nowrap`, the longest quotation runs off
		// the right edge, and the page goes sideways under the reader's thumb.
		const before = pageBytes;
		pageBytes = pageBytes.replace('.ui.quoted { white-space: normal; }', '');
		if (pageBytes === before) die('the sideways break did not apply');
		applied.push('took the wrapping rule off the quoted app sentences');
		break;
	}
	case 'promise': {
		// A locale offered that was never written: the language switcher walks
		// the reader into a 404, which is what an eight-locale declaration over
		// five pages did.
		const before = pageBytes;
		pageBytes = pageBytes.replace(/data-guide-locales="([^"]*)"/, (m, list) => {
			const gone = ['ja', 'ko', 'zh-Hans'].find((l) => !list.split(' ').includes(l));
			if (!gone) die('the promise break found every locale already declared');
			return `data-guide-locales="${list} ${gone}"`;
		});
		if (pageBytes === before) die('the promise break did not apply');
		applied.push('promised a translation that is not on disk');
		break;
	}
	case 'unlisted': {
		// The other half: a page that exists and is never offered, so a reader
		// in that language is left on English with no way across.
		if (!onDiskLocales.length) die('the unlisted break has no translation to hide');
		const hide = onDiskLocales[onDiskLocales.length - 1];
		const before = pageBytes;
		pageBytes = pageBytes.replace(/data-guide-locales="([^"]*)"/,
			(m, list) => `data-guide-locales="${list.split(' ').filter((l) => l !== hide).join(' ')}"`);
		if (pageBytes === before) die('the unlisted break did not apply');
		applied.push(`stopped offering ${hide}, which is on disk`);
		break;
	}
	case 'sideloc': {
		// The wrapping rule taken off the TRANSLATIONS and left on the English
		// page, so property 0 stays green and only property 9 goes red.
		let hit = 0;
		for (const l of onDiskLocales) {
			const before = localeBytes[l];
			localeBytes[l] = before.replace('.ui.quoted { white-space: normal; }', '');
			if (localeBytes[l] !== before) hit++;
		}
		if (!hit) die('the sideloc break reached no translated page');
		applied.push(`took the wrapping rule off ${hit} translated page(s)`);
		break;
	}
	default: die(`no break called "${BREAK}"`);
}
if (BREAK) console.log(`BREAK ${BREAK}: ${applied.join('; ')}\n`);


/// frame.js with the late re-landing taken out, and only that: the reader is
/// put on their anchor once, before the search box has been built, exactly as
/// the file behaved before this page needed it to be right on a phone. Both
/// halves have to come out, and each is required to apply, because a break that
/// half-lands is a break that proves half a check.
function nolanding(src) {
	let out = src.replace("\t\tif (!landed || touched) return;", "\t\treturn;");
	if (out === src) die('the nolanding break did not reach settleLanding');
	const later = out;
	out = out.replace(/\n\t\t\twindow\.addEventListener\('load'[\s\S]*?\}, 1000\);/, '');
	if (out === later) die('the nolanding break did not reach the later measurements');
	return out;
}

// ── 1. Every term is the app's own word ──────────────────────────────
{
	const missing = [];
	for (const [id, word, where, evidence] of TERMS) {
		const hay = where === 'i18n' ? en : guideText;
		if (!hay.includes(evidence)) missing.push(`${word} (${where})`);
		if (!pageBytes.includes(`id="${id}"`)) missing.push(`${word}: no entry at #${id}`);
	}
	check('every glossary term is a word the app or the guide already uses',
		missing.length === 0, missing.join(', '));
}

// ── 6. House punctuation ─────────────────────────────────────────────
{
	// The article only. The SVG's path data uses hyphens freely, a hyphen inside
	// a word is not a dash, and the document title carries the guide's own
	// "Improving Daimond — Daimond guide" pattern, which every page has and which
	// is not this page's prose to change.
	const main = (pageBytes.match(/<main[^>]*>([\s\S]*?)<\/main>/i) || [, ''])[1];
	const prose = main.replace(/<svg[\s\S]*?<\/svg>/gi, ' ');
	const hits = [];
	for (const [re, what] of [[/—/g, 'em dash'], [/–/g, 'en dash'], [/\s--\s/g, 'double hyphen']]) {
		const m = prose.match(re);
		if (m) hits.push(`${m.length} ${what}`);
	}
	check('no dashes in the page\'s prose', hits.length === 0, hits.join(', '));
}

// ── 5. The anchors survive the index build ───────────────────────────
{
	// Read from disk, not from the possibly-broken copy: this is a fact about the
	// file the index generator writes, and `--break heading` proves it by taking
	// the ids off, which is what the generator's renumbering would do to ids
	// written on the headings instead.
	const onDisk = BREAK === 'heading' ? pageBytes : fs.readFileSync(PAGE, 'utf8');
	const gone = ANCHORS.filter((a) => !new RegExp(`<section[^>]*\\sid="${a}"`).test(onDisk));
	// And the headings themselves must carry the positional ids, which is what
	// says the index has been built over this page at all.
	const positional = (onDisk.match(/<h[23] id="s\d+"/g) || []).length;
	const pass = gone.length === 0 && positional > 0;
	check('the section anchors survive dev/guide-index.mjs', pass, pass ? ''
		: gone.length ? `missing: ${gone.join(', ')}`
		: 'the index has never been built over this page');
}

// ── 8. The switcher offers only pages that exist ─────────────────────
{
	// Read from `pageBytes`, so `--break promise` and `--break unlisted` are
	// seen; the disk side is read from the disk, because that is the fact the
	// declaration is being held against.
	const promised = ((pageBytes.match(/data-guide-locales="([^"]*)"/) || [, ''])[1])
		.split(' ').filter((l) => l && l !== 'en');
	const missing = promised.filter((l) => !fs.existsSync(path.join(GUIDE, l, 'social.html')));
	const unlisted = onDiskLocales.filter((l) => !promised.includes(l));
	const why = [];
	if (missing.length)  why.push(`offered with no page: ${missing.join(', ')}`);
	if (unlisted.length) why.push(`on disk and never offered: ${unlisted.join(', ')}`);
	check('the language switcher offers exactly the translations that exist',
		why.length === 0, why.join('; ') || `${promised.length} translation(s)`);
}

// ── The browser ──────────────────────────────────────────────────────
const { chromium } = await import(pathToFileURL(PW).href);
const profile = path.join(SCRATCH, 'pw', 'vocabulary' + (BREAK ? '-' + BREAK : ''));
fs.rmSync(profile, { recursive: true, force: true });
fs.mkdirSync(profile, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });

// A forwarded DISPLAY means no compositor frames, so requestAnimationFrame never
// fires and every wait hangs. See dev/harness.mjs.
const env = { ...process.env };
delete env.DISPLAY;

const browser = await chromium.launchPersistentContext(profile, {
	executablePath: CHROME,
	headless: false,
	args: ['--no-sandbox', '--disable-dev-shm-usage', '--headless=new'],
	env,
	viewport: { width: 1100, height: 900 },
});
const page = browser.pages()[0] || await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(String(e.message)));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

await page.route('**/guide/social.html*', (route) => {
	route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: pageBytes });
});
for (const l of onDiskLocales) {
	await page.route(`**/guide/${l}/social.html*`, (route) => {
		route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: localeBytes[l] });
	});
}
if (blankCrop) {
	// A one-colour PNG, which is what a crop of an invisible element looks like.
	const flat = Buffer.from(
		'iVBORw0KGgoAAAANSUhEUgAAAGQAAAAyCAYAAACqNX6+AAAAM0lEQVR4nO3BAQEAAACCIP+vbkhA'
		+ 'AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADgNxFAAAHrqBWzAAAAAElFTkSuQmCC', 'base64');
	await page.route(`**/guide/shots/${blankCrop}`, (route) => {
		route.fulfill({ status: 200, contentType: 'image/png', body: flat });
	});
}
if (BREAK === 'nomargin' || BREAK === 'nolanding') {
	await page.route('**/guide/frame.js', async (route) => {
		const src = fs.readFileSync(path.join(GUIDE, 'frame.js'), 'utf8');
		const hurt = BREAK === 'nomargin'
			? src.replace("rule.textContent = 'main [id] { scroll-margin-top: var(--guide-head-h, 7rem); }';",
				"rule.textContent = '';")
			: nolanding(src);
		if (hurt === src) die(`the ${BREAK} break did not apply`);
		route.fulfill({ status: 200, contentType: 'text/javascript', body: hurt });
	});
}

const URL = `${APP}/guide/social.html`;
await page.goto(URL, { waitUntil: 'load' });
await page.waitForTimeout(600);

// ── 2. No crop is blank ──────────────────────────────────────────────
{
	// Counted in the browser, from the image as it was actually decoded, so a
	// file that is fine on disk and 404s on the way in also fails.
	// Fetched again into images of our own rather than read off the page's. The
	// page's are `loading="lazy"`, so most of them have no pixels at all until
	// they are scrolled past, and `decode()` on one in that state took the whole
	// renderer down. A fresh Image also fails loudly on a src that 404s, which is
	// half of what this check is for.
	const flat = await page.evaluate(async () => {
		const out = [];
		const srcs = [...document.querySelectorAll('.term img')].map((i) => i.getAttribute('src'));
		for (const src of srcs) {
			const img = new Image();
			img.src = src;
			try { await img.decode(); } catch (e) { out.push({ src, why: 'did not load' }); continue; }
			const w = img.naturalWidth, h = img.naturalHeight;
			if (!w || !h) { out.push({ src, why: 'no pixels' }); continue; }
			const c = document.createElement('canvas');
			c.width = w; c.height = h;
			c.getContext('2d').drawImage(img, 0, 0);
			const d = c.getContext('2d').getImageData(0, 0, w, h).data;
			const seen = new Set();
			for (let i = 0; i < d.length; i += 4) {
				seen.add((d[i] >> 3) + ',' + (d[i + 1] >> 3) + ',' + (d[i + 2] >> 3));
				if (seen.size > 12) break;
			}
			if (seen.size <= 3) out.push({ src, why: `${seen.size} colours` });
		}
		return out;
	});
	check('no glossary crop is a flat rectangle', flat.length === 0,
		flat.map((f) => `${f.src}: ${f.why}`).join(', '));
}

// ── 3. The diagram is legible on a light palette and a dark one ──────
{
	// The contrast the app's own theme audit holds ink to against a surface.
	const FLOOR = 3.0;
	const lum = (rgb) => {
		const f = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
		return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2];
	};
	const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
	const parse = (s) => (s.match(/[\d.]+/g) || []).slice(0, 3).map(Number);

	const results = [];
	for (const theme of ['light', 'dark']) {
		await page.evaluate((t) => {
			// The same three attributes guide/frame.js sets when the app tells it
			// which palette to wear.
			const map = { light: ['light', 'dark'], dark: ['dark', 'light'] };
			document.documentElement.setAttribute('data-theme', t);
			document.documentElement.setAttribute('data-tone', map[t][0]);
			document.documentElement.setAttribute('data-ink', map[t][1]);
		}, theme);
		await page.waitForTimeout(300);
		const pair = await page.evaluate(() => {
			const lab = document.querySelector('.widgetmap .wm-lab');
			const pan = document.querySelector('.widgetmap .wm-pan');
			const win = document.querySelector('.widgetmap .wm-win');
			if (!lab || !pan || !win) return null;
			return {
				ink:  getComputedStyle(lab).fill,
				pan:  getComputedStyle(pan).fill,
				win:  getComputedStyle(win).fill,
			};
		});
		if (!pair) { results.push(`${theme}: the diagram is not on the page`); continue; }
		const r1 = ratio(parse(pair.ink), parse(pair.pan));
		const r2 = ratio(parse(pair.ink), parse(pair.win));
		const worst = Math.min(r1, r2);
		if (worst < FLOOR) results.push(`${theme}: labels at ${worst.toFixed(2)}:1`);
		await unlazy(page);
		await page.screenshot({ path: path.join(SHOTS, `vocab-page-${theme}.png`), fullPage: true });
	}
	check('the zone diagram\'s labels are legible on a light palette and a dark one',
		results.length === 0, results.join(', '));
}

// ── 4. A deep link lands on its section, at both widths ──────────────
{
	const under = [];
	for (const [w, h] of [[1100, 900], [360, 800]]) {
		await page.setViewportSize({ width: w, height: h });
		for (const a of ANCHORS) {
			// A fresh load per anchor, which is what the Improve panel's button
			// will do: it sets the frame's src, it does not click a link on a page
			// already scrolled somewhere.
			//
			// Through `about:blank`, because `goto` from `#a` to `#b` on one URL
			// is a SAME-DOCUMENT navigation: the page is never reloaded, frame.js
			// never runs again, and four of the five anchors were being checked
			// against a document that had settled minutes earlier.
			await page.goto('about:blank');
			await page.goto(`${URL}#${a}`, { waitUntil: 'load' });
			await page.waitForTimeout(1500);
			const r = await page.evaluate((id) => {
				const el = document.getElementById(id);
				if (!el) return null;
				const head = document.querySelector('.site-head');
				const hb = head ? head.getBoundingClientRect().bottom : 0;
				// The heading inside the section is what the reader has to see.
				const hh = el.querySelector('h2') || el;
				const box = hh.getBoundingClientRect();
				return { top: box.top, headBottom: hb, y: window.scrollY };
			}, a);
			if (!r) { under.push(`${w}px: #${a} is not on the page`); continue; }
			if (r.top < r.headBottom) under.push(`${w}px: #${a} landed ${Math.round(r.headBottom - r.top)}px under the header`);
			// And it has to have moved at all: an anchor that never scrolls is one
			// the browser did not find.
			if (a !== ANCHORS[0] && r.y <= 0) under.push(`${w}px: #${a} did not scroll`);
		}
	}
	check('every published anchor lands below the sticky header, at 1100px and at 360px',
		under.length === 0, under.join(', '));
}

// ── 4b. A header that grows afterwards is landed on again ────────────
{
	// The header GROWS after a reader has landed: `search.js` builds the search
	// box and appends it, and on a phone that is a whole extra row. Before this
	// page, that left a phone reader's heading 32px under the header for about a
	// second, until something later put it right; a jump under the reader's eye
	// is a fault whether or not the page ends up correct.
	//
	// Asserted as a CALL and not as a position. Where the page ends up after the
	// header changes size depends on the browser's own scroll anchoring, which
	// fires or does not depending on what else the page has been doing, and a
	// check resting on that passes and fails at random. What frame.js owes the
	// reader is that it lands them again; that is what is counted.
	await page.setViewportSize({ width: 360, height: 800 });
	await page.goto('about:blank');
	await page.goto(`${URL}#glossary`, { waitUntil: 'load' });
	await page.waitForTimeout(1200);
	const relands = await page.evaluate(async () => {
		let n = 0;
		const orig = Element.prototype.scrollIntoView;
		Element.prototype.scrollIntoView = function () { n++; return orig.apply(this, arguments); };
		const grow = document.createElement('div');
		grow.style.height = '48px';
		document.querySelector('.site-head').appendChild(grow);
		await new Promise((r) => setTimeout(r, 400));
		Element.prototype.scrollIntoView = orig;
		return n;
	});
	check('a header that grows after the landing puts the reader back on their anchor',
		relands > 0, `${relands} landings after the header changed size`);
}

// ── The narrowest screen the guide supports ──────────────────────────
{
	await page.setViewportSize({ width: 360, height: 900 });
	await page.goto(URL, { waitUntil: 'load' });   // no hash: the whole page, from the top
	await page.waitForTimeout(600);
	const wide = await page.evaluate(() =>
		document.documentElement.scrollWidth - document.documentElement.clientWidth);
	await unlazy(page);
	await page.screenshot({ path: path.join(SHOTS, 'vocab-page-narrow.png'), fullPage: true });
	check('the page does not scroll sideways at 360px', wide <= 1, `${wide}px of overflow`);

	// ── 7. The diagram's words are still words ───────────────────
	// The smallest label's rendered height, in CSS pixels on the page as the
	// reader has it. Eight is the floor: below that the strokes of a lower-case
	// letter merge at this weight, which is what the phone render was doing.
	const FLOOR_PX = 8;
	const ink = await page.evaluate(() => {
		const labs = [...document.querySelectorAll('.widgetmap .wm-lab')];
		if (!labs.length) return null;
		const hs = labs.map((l) => l.getBoundingClientRect().height);
		return { min: Math.min(...hs), n: labs.length };
	});
	check('the diagram\'s labels are still legible at 360px',
		!!ink && ink.min >= FLOOR_PX,
		ink ? `smallest label renders ${ink.min.toFixed(1)}px tall` : 'no labels found');
}

// ── 9. And no translation scrolls sideways either ────────────────────
{
	// Still at 360px from the block above. Each translated copy is loaded in
	// turn and measured the same way, because the sentence that spilled is a
	// QUOTATION OF THE APP and every language quotes a different one: the French
	// `post.audience` is 110 characters where the English is 66.
	const wide = [];
	for (const l of onDiskLocales) {
		await page.goto('about:blank');
		await page.goto(`${APP}/guide/${l}/social.html`, { waitUntil: 'load' });
		await page.waitForTimeout(400);
		const over = await page.evaluate(() =>
			document.documentElement.scrollWidth - document.documentElement.clientWidth);
		if (over > 1) wide.push(`${l}: ${over}px`);
	}
	check('no translation of the page scrolls sideways at 360px either',
		wide.length === 0, wide.join(', ') || `${onDiskLocales.length} translation(s) measured`);
}

check('the page threw nothing', errs.length === 0, errs.slice(0, 3).join(' | '));

await browser.close();

console.log(`\n${ok.length} ok, ${bad.length} failed`);
if (BREAK) {
	if (bad.length) { console.log(`the break was caught, as it should be`); process.exit(0); }
	console.log('THE BREAK WAS NOT CAUGHT: this check proves nothing');
	process.exit(1);
}
process.exit(bad.length ? 1 : 0);
