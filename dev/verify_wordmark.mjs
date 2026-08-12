// verify_wordmark.mjs -- the brand lockup, everywhere it is drawn, at every
// width the app is drawn at.
//
// The wordmark was redrawn wider (223.7x84.273 -> 373.76x84.273: 2.65:1 became
// 4.44:1) and every placement is height-constrained with `width: auto`, so every
// one of them got 67% wider on the spot. This walks the five surfaces that draw
// it -- the top bar, the unlock card, the About dialog, the guide header and the
// landing header/footer -- and asks four questions of each:
//
//   1. THE ARTWORK IS NOT DISTORTED. The rendered width divided by the rendered
//      height must equal the ratio in the painted file's OWN viewBox, read off
//      disk, to within a pixel. This is the check that catches a
//      `preserveAspectRatio: none` or a fixed `width` "fix" -- including one a
//      later session adds in good faith.
//   2. NOTHING IS GUILLOTINED. The row that holds the lockup does not scroll
//      (`.topbar` is `overflow: hidden`, so a row that does not fit loses the
//      last control off the right edge in silence).
//   3. NOTHING OVERLAPS. The lockup's box does not intersect any other box in
//      its row.
//   4. THE PAGE DOES NOT SCROLL SIDEWAYS.
//
// Which file is painted is read from the computed `content`, not from `src`: on
// a phone the top bar swaps the lockup for the mark alone with `content: url()`,
// and `naturalWidth` keeps reporting the file in the `src` attribute after that.
// So the expected ratio comes from whichever file the engine is actually
// painting, parsed from that file's viewBox.
//
//   node dev/verify_wordmark.mjs              # the walk
//   node dev/verify_wordmark.mjs --selftest   # prove all four checks go red
//
// Needs a world: `bash dev/world.sh N --up` then `eval "$(bash dev/world.sh N --env)"`.
delete process.env.DISPLAY;	// A forwarded DISPLAY means no compositor frames and every wait hangs.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = '1';
const PW = process.env.DAIMOND_PW || path.join(os.homedir(), '.red-pw/node_modules/playwright-core/index.mjs');
const { chromium, webkit } = await import(pathToFileURL(PW).href);
const CHROME = process.env.DAIMOND_CHROME || path.join(os.homedir(), '.cache/ms-playwright/chromium-1229/chrome-linux64/chrome');

const HERE    = path.dirname(fileURLToPath(import.meta.url));
const ROOT    = path.dirname(HERE);
const APP     = process.env.DAIMOND_APP || `http://localhost:${process.env.DAIMOND_PORT || 8777}`;
const LANDING = pathToFileURL(path.join(ROOT, 'landing')).href;
const SCRATCH = process.env.DAIMOND_SCRATCH || path.join(os.homedir(), '.cache/daimond');
const SHOTS   = path.join(HERE, 'shots', 'wordmark');
const PASS    = 'testpass1234';
const SELFTEST = process.argv.includes('--selftest');

fs.mkdirSync(SHOTS, { recursive: true });

// ── The artwork's own proportions, off disk ──────────────────────
// Keyed by file name, because that is all the browser tells us about what it
// painted. Both asset directories ship the same three files; a mismatch between
// the two copies is itself a finding, so they are compared rather than merged.
const ASSETS = ['daimond_word.svg', 'daimond_word_dark.svg', 'daimond_mark.svg'];
const RATIO = {};
for (const dir of ['www/assets', 'landing/assets']) {
	for (const f of ASSETS) {
		const p = path.join(ROOT, dir, f);
		if (!fs.existsSync(p)) continue;
		const m = fs.readFileSync(p, 'utf8').match(/viewBox="([\d.\s-]+)"/);
		if (!m) throw new Error(`${dir}/${f}: no viewBox`);
		const [, , w, h] = m[1].trim().split(/\s+/).map(Number);
		const r = w / h;
		if (RATIO[f] !== undefined && Math.abs(RATIO[f] - r) > 1e-6) {
			throw new Error(`${f}: www and landing copies disagree (${RATIO[f]} vs ${r})`);
		}
		RATIO[f] = r;
	}
}
console.log('artwork ratios (from each file\'s viewBox):');
for (const [f, r] of Object.entries(RATIO)) console.log(`  ${f.padEnd(24)} ${r.toFixed(4)}:1`);

let pass = 0, fail = 0, ENG = 'chromium';
const fails = [];
const check = (ok, what, detail) => {
	if (ok) { pass++; return true; }
	fail++; fails.push(`${what} -- ${detail}`);
	console.log(`  FAIL  ${what}\n        ${detail}`);
	return false;
};

// ── The measurement, in the page ─────────────────────────────────
// Returns one record per VISIBLE mark matching `markSel`, plus the row it sits
// in and every other box in that row. Nothing is asserted here: the caller
// decides, so the same measurement serves the walk and the self-test.
const MEASURE = (arg) => {
	const { markSel, rowSel } = arg;
	const de = document.documentElement;
	const vis = (el) => {
		const s = getComputedStyle(el);
		if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0) return false;
		const r = el.getBoundingClientRect();
		return r.width > 0 && r.height > 0;
	};
	const box = (el) => { const r = el.getBoundingClientRect(); return {
		x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2),
		right: +r.right.toFixed(2), bottom: +r.bottom.toFixed(2) }; };
	const tag = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '')
		+ (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).join('.') : '');

	const row = document.querySelector(rowSel);
	const marks = [...document.querySelectorAll(markSel)].filter(vis);
	const out = marks.map((el) => {
		// What is actually painted: `content` wins over `src`, and after a
		// `content: url()` swap `currentSrc` still names the src file.
		const c = getComputedStyle(el).content;
		const m = c && c.match(/url\(["']?([^"')]+)["']?\)/);
		const file = (m ? m[1] : (el.currentSrc || el.src || '')).split('/').pop().split('?')[0];
		// The chain from the mark up to the row's direct child, so a sibling
		// check compares the mark against boxes that are not its own ancestors.
		let branch = el;
		while (branch && branch.parentElement !== row && branch.parentElement) branch = branch.parentElement;
		return { sel: tag(el), file, box: box(el), branch: branch ? tag(branch) : null,
			pa: el.getAttribute('preserveAspectRatio') || null };
	});

	// Every other box in the row, for the overlap test. Only direct children:
	// a descendant of the mark's own branch is not a neighbour.
	let others = [], rowBox = null, rowClip = 0, rowPad = null, culprit = null;
	if (row) {
		rowBox = box(row);
		rowClip = row.scrollWidth - row.clientWidth;
		const cs = getComputedStyle(row);
		rowPad = { l: parseFloat(cs.paddingLeft) || 0, r: parseFloat(cs.paddingRight) || 0 };
		others = [...row.children].filter(vis).map((k) => ({ sel: tag(k), box: box(k) }));
		// When the row does overrun, name the box that reaches furthest right, so
		// the reader is told WHAT is cut off rather than only that something is.
		if (rowClip > 0) {
			const edge = rowBox.right - rowPad.r;
			for (const el of row.querySelectorAll('*')) {
				if (!vis(el)) continue;
				const b = box(el);
				if (b.right > edge + 0.5 && (!culprit || b.right > culprit.box.right)) culprit = { sel: tag(el), box: b };
			}
		}
	}
	return { marks: out, others, rowBox, rowClip, rowPad, culprit, rowFound: !!row,
		hScroll: de.scrollWidth - de.clientWidth, vw: window.innerWidth };
};

// ── One surface, at one width, in one palette ────────────────────
async function audit(page, { label, markSel, rowSel, minMarks = 1, shot = null, clipRow = false }) {
	const m = await page.evaluate(MEASURE, { markSel, rowSel });
	check(m.rowFound, `${label}: the row ${rowSel} exists`, 'selector matched nothing');
	check(m.marks.length >= minMarks, `${label}: ${markSel} is on screen`,
		`${m.marks.length} visible, expected at least ${minMarks}`);

	// 4. The page does not scroll sideways.
	check(m.hScroll <= 1, `${label}: the page has no horizontal overflow`,
		`document scrollWidth exceeds clientWidth by ${m.hScroll}px at vw ${m.vw}`);

	// 2. The row is not clipping its own contents. Asserted only where the row
	// really is a guillotine -- `.topbar` is `overflow: hidden`, so a row that
	// does not fit loses the control at its end and says nothing. Elsewhere an
	// overrun is reported as a NOTE naming the culprit: the unlock card has a
	// standing one at 320 (the passphrase input's intrinsic width) that has
	// nothing to do with the lockup, and a check that fails on it would be a
	// check nobody reads.
	if (clipRow) {
		check(m.rowClip <= 0, `${label}: nothing is guillotined out of ${rowSel}`,
			`row content overruns its box by ${m.rowClip}px`
			+ (m.culprit ? `; furthest right is ${m.culprit.sel} at ${m.culprit.box.right}` : ''));
	} else if (m.rowClip > 0) {
		console.log(`  note  ${label}: ${rowSel} overruns by ${m.rowClip}px`
			+ (m.culprit ? ` -- ${m.culprit.sel} reaches ${m.culprit.box.right}` : ''));
	}

	for (const mk of m.marks) {
		const expect = RATIO[mk.file];
		// 1. Undistorted. A pixel of tolerance on the WIDTH, not on the ratio:
		// a ratio tolerance is meaningless at 20px and forgiving at 160px.
		if (check(expect !== undefined, `${label}: ${mk.sel} paints a known asset`,
			`painted ${JSON.stringify(mk.file)}, which is not one of ${ASSETS.join(', ')}`)) {
			const want = mk.box.h * expect;
			check(Math.abs(mk.box.w - want) <= 1, `${label}: ${mk.sel} is undistorted`,
				`${mk.file} is ${expect.toFixed(4)}:1, so ${mk.box.h}px tall wants ${want.toFixed(2)}px wide; `
				+ `rendered ${mk.box.w}px (${(mk.box.w - want).toFixed(2)}px out, drawn ratio ${(mk.box.w / mk.box.h).toFixed(4)}:1)`);
			check(!mk.pa || mk.pa === 'xMidYMid meet', `${label}: ${mk.sel} keeps the default preserveAspectRatio`,
				`preserveAspectRatio="${mk.pa}"`);
		}
		// 3. Inside its row's content box, and clear of every neighbour.
		if (m.rowBox) {
			const left = m.rowBox.x + m.rowPad.l, right = m.rowBox.right - m.rowPad.r;
			check(mk.box.x >= left - 1 && mk.box.right <= right + 1,
				`${label}: ${mk.sel} sits inside ${rowSel}`,
				`mark spans ${mk.box.x}..${mk.box.right}, row content box is ${left.toFixed(2)}..${right.toFixed(2)}`);
		}
		for (const o of m.others) {
			if (o.sel === mk.branch) continue;	// the mark's own branch of the row
			const hit = mk.box.x < o.box.right - 0.5 && o.box.x < mk.box.right - 0.5
				&& mk.box.y < o.box.bottom - 0.5 && o.box.y < mk.box.bottom - 0.5;
			check(!hit, `${label}: ${mk.sel} does not overlap ${o.sel}`,
				`mark ${mk.box.x}..${mk.box.right} x ${mk.box.y}..${mk.box.bottom}, `
				+ `neighbour ${o.box.x}..${o.box.right} x ${o.box.y}..${o.box.bottom}`);
		}
	}
	// The crop is the ROW, not the page: a full-page shot of a 1500px desktop
	// hides a two-pixel collision in the brand. Named per engine, or the WebKit
	// pass silently overwrites the Chromium one and half the evidence is lost.
	if (shot) {
		await page.locator(shot).first().screenshot({ path: path.join(SHOTS, `${ENG}-${label.replace(/[^\w.-]+/g, '_')}.png`) })
			.catch((e) => console.log(`  (no shot for ${label}: ${e.message})`));
	}
	return m;
}

// ── Drive the app to a signed-in state ───────────────────────────
async function signIn(page, name) {
	await page.waitForSelector('#id-primary', { timeout: 20000 });
	const nb = await page.$('#id-name');
	if (nb && await nb.isVisible() && await nb.isEditable()) await nb.fill(name);
	await page.fill('#id-pass', PASS);
	const c2 = await page.$('#id-pass2'); if (c2 && await c2.isVisible()) await c2.fill(PASS);
	const wr = await page.$('#id-wrote'); if (wr && await wr.isVisible() && !(await wr.isChecked())) await wr.check({ force: true });
	await page.evaluate(() => document.getElementById('id-primary').click());
	await page.waitForSelector('#identity-modal', { state: 'hidden', timeout: 20000 });
	await page.waitForTimeout(500);
}

/// The app publishes its palettes as a service; drive that rather than pinning
/// the attribute, so `data-ink` and the src swap happen the way they do live.
const setTheme = (page, t) => page.evaluate((x) => {
	if (window.DaimondTheme) window.DaimondTheme.set(x);
	else document.documentElement.setAttribute('data-theme', x);
}, t);
const setSkin = (page, s) => page.evaluate((x) => {
	if (window.DaimondSkin) window.DaimondSkin.set(x);
	else document.documentElement.setAttribute('data-skin', x);
}, s);

// Desktop and the phone the brief names, plus the widths where the row was found
// to break: 320 (SE 1st gen), 390 (iPhone 12-15), 435 and 470 (the band the
// mobile shell drew the desktop-height lockup at).
const WIDTHS = [1500, 768, 470, 435, 430, 390, 360, 320];
const PALETTES = [['dark', 'light lettering on a dark ground'], ['light', 'dark lettering on a light ground']];

const ENGINES = [{ name: 'chromium', type: chromium, opts: { executablePath: CHROME } }];
if (!SELFTEST) ENGINES.push({ name: 'webkit', type: webkit, opts: {} });

for (const eng of ENGINES) {
	ENG = eng.name;
	let ctx;
	try {
		ctx = await eng.type.launchPersistentContext(path.join(SCRATCH, `wordmark-${eng.name}-${process.pid}`), {
			...eng.opts, headless: true, viewport: { width: 1500, height: 950 },
		});
	} catch (e) { console.log(`\n(${eng.name} will not launch here: ${e.message.split('\n')[0]})`); continue; }
	const page = ctx.pages()[0] || await ctx.newPage();

	// ── The app ──────────────────────────────────────────────────
	console.log(`\n=== ${eng.name}: the app ===`);
	await page.goto(APP, { waitUntil: 'domcontentloaded' });

	// Signed out first: the unlock card is the first screen a returning user meets.
	for (const w of WIDTHS) {
		await page.setViewportSize({ width: w, height: 860 });
		await page.waitForTimeout(150);
		for (const [theme, say] of PALETTES) {
			await setTheme(page, theme);
			await page.waitForTimeout(120);
			await audit(page, { label: `unlock ${w} ${theme}`, markSel: '#identity-modal .login-logo',
				rowSel: '#identity-modal .modal-card', shot: '#identity-modal .modal-card' });
		}
	}

	await page.setViewportSize({ width: 1500, height: 950 });
	await setTheme(page, 'dark');
	await signIn(page, 'wm' + eng.name);

	for (const w of WIDTHS) {
		await page.setViewportSize({ width: w, height: 860 });
		await page.waitForTimeout(200);
		for (const [theme] of PALETTES) {
			for (const skin of ['sharp', 'warm']) {
				await setTheme(page, theme);
				await setSkin(page, skin);
				await page.waitForTimeout(140);
				const bar = await audit(page, { label: `topbar ${w} ${theme} ${skin}`, markSel: '.topbar .brand-wordmark',
					rowSel: '.topbar', shot: '.topbar', clipRow: true });
				// WHICH artwork the bar shows is a decision, not a detail: a phone
				// gets the mark alone, because the 4.44:1 lockup does not fit
				// beside the burger and five controls at any legible height.
				// Pinned here so putting the word back on a phone fails loudly
				// rather than amputating the appearance menu again.
				for (const mk of bar.marks) {
					const ok = w <= 430 ? mk.file === 'daimond_mark.svg' : /^daimond_word(_dark)?\.svg$/.test(mk.file);
					check(ok, `topbar ${w} ${theme} ${skin}: the bar shows ${w <= 430 ? 'the mark alone' : 'the full lockup'}`,
						`painted ${mk.file}`);
				}
			}
		}
		await setSkin(page, 'sharp');
		// The About dialog wears the same class for its light/dark swap, so a
		// rule written for the bar reaches it unless it is scoped.
		for (const [theme] of PALETTES) {
			await setTheme(page, theme);
			await page.evaluate(() => { const b = document.getElementById('about-btn'); if (b) b.click(); });
			await page.waitForTimeout(450);
			const ab = await audit(page, { label: `about ${w} ${theme}`, markSel: '.about-word',
				rowSel: '.about-card', shot: '.about-card' });
			// `.about-word` asks for 46px and has room for it at every width. It
			// was not getting it: the top bar's phone rules were written unscoped,
			// so About drew its signature at 20-24px on every phone -- against its
			// own rule and against the comment beside it. Assert the height the
			// dialog states, so the leak cannot come back unnoticed.
			for (const mk of ab.marks) {
				check(Math.abs(mk.box.h - 46) < 0.5, `about ${w} ${theme}: the dialog lockup is 46px tall`,
					`drawn at ${mk.box.h}px -- a top-bar rule is reaching into the dialog`);
				check(mk.file !== 'daimond_mark.svg', `about ${w} ${theme}: the dialog shows the full lockup`,
					`painted ${mk.file} -- the bar's phone swap has leaked in`);
			}
			await page.keyboard.press('Escape');
			await page.waitForTimeout(250);
		}
	}

	// ── The guide, and the landing site ──────────────────────────
	console.log(`\n=== ${eng.name}: guide and landing ===`);
	const pages = [
		{ label: 'guide-en', url: `${APP}/guide/index.html`,          mark: '.wordmark', row: '.site-head-inner' },
		{ label: 'guide-de', url: `${APP}/guide/de/interface.html`,   mark: '.wordmark', row: '.site-head-inner' },
		{ label: 'guide-ja', url: `${APP}/guide/ja/index.html`,       mark: '.wordmark', row: '.site-head-inner' },
		{ label: 'landing',  url: `${LANDING}/index.html`,            mark: '.brand-word', row: '.header-inner' },
		{ label: 'terms',    url: `${LANDING}/terms.html`,            mark: '.brand-word', row: '.header-inner' },
		{ label: 'privacy',  url: `${LANDING}/privacy.html`,          mark: '.brand-word', row: '.header-inner' },
	];
	for (const p of pages) {
		for (const w of [1500, 430, 390, 360, 320]) {
			await page.setViewportSize({ width: w, height: 900 });
			for (const [theme] of PALETTES) {
				// These are static pages with no theme service: the ink axis is
				// the attribute, exactly as their own stylesheets read it.
				await page.emulateMedia({ colorScheme: theme });
				await page.goto(p.url, { waitUntil: 'domcontentloaded' });
				await page.evaluate((t) => document.documentElement.setAttribute('data-ink', t === 'dark' ? 'light' : 'dark'), theme);
				await page.waitForTimeout(200);
				await audit(page, { label: `${p.label} ${w} ${theme}`, markSel: p.mark, row: p.row,
					rowSel: p.row, minMarks: 1, shot: p.row });
			}
		}
	}
	await page.emulateMedia({ colorScheme: null });

	// ── Self-test: every check, proved red ───────────────────────
	if (SELFTEST) {
		console.log('\n=== self-test: each check, against code broken on purpose ===');
		const before = fail;
		const expectRed = async (what, breakIt, restore, opts) => {
			const b0 = fail;
			await page.evaluate(breakIt);
			await page.waitForTimeout(200);
			await audit(page, opts);
			const went = fail - b0;
			await page.evaluate(restore);
			await page.waitForTimeout(200);
			console.log(`  ${went > 0 ? 'RED (good)' : 'STAYED GREEN -- THE CHECK IS INERT'}  ${what}  (+${went} failures)`);
			return went > 0;
		};
		await page.goto(APP, { waitUntil: 'domcontentloaded' });
		await page.setViewportSize({ width: 390, height: 860 });
		await page.waitForTimeout(300);
		await signIn(page, 'wmself');
		await page.setViewportSize({ width: 390, height: 860 });
		await page.waitForTimeout(400);

		const results = [];
		const STYLE = (css) => { const s = document.createElement('style'); s.id = 'wm-break'; s.textContent = css; document.head.appendChild(s); };
		const UNSTYLE = () => { const s = document.getElementById('wm-break'); if (s) s.remove(); };
		const barOpts = { label: 'SELFTEST topbar', markSel: '.topbar .brand-wordmark', rowSel: '.topbar', clipRow: true };

		// 1a. A fixed width -- the classic "just make it fit" fix.
		results.push(['undistorted vs a fixed width',
			await expectRed('a fixed width on the lockup',
				() => { const s = document.createElement('style'); s.id = 'wm-break';
					s.textContent = '.topbar .brand-wordmark { width: 60px !important; height: 24px !important; content: none !important; }';
					document.head.appendChild(s); },
				UNSTYLE, barOpts)]);
		// 1b. preserveAspectRatio="none" on the artwork itself.
		results.push(['undistorted vs preserveAspectRatio="none"',
			await expectRed('preserveAspectRatio="none" on the lockup',
				() => { for (const i of document.querySelectorAll('.topbar .brand-wordmark')) i.setAttribute('preserveAspectRatio', 'none'); },
				() => { for (const i of document.querySelectorAll('.topbar .brand-wordmark')) i.removeAttribute('preserveAspectRatio'); },
				barOpts)]);
		// 2. The lockup at its desktop height on a phone -- the break this
		//    session was sent to fix, reproduced exactly.
		results.push(['guillotine vs the desktop-height lockup on a phone',
			await expectRed('the full lockup at 36px in a 390px bar',
				() => { const s = document.createElement('style'); s.id = 'wm-break';
					s.textContent = '.topbar .brand-wordmark { content: none !important; height: 36px !important; }';
					document.head.appendChild(s); },
				UNSTYLE, barOpts)]);
		// 3. An overlap, with no clipping to give it away.
		results.push(['overlap vs a lockup dragged across its neighbours',
			await expectRed('the lockup translated over the controls',
				() => { const s = document.createElement('style'); s.id = 'wm-break';
					s.textContent = '.topbar .brand-group { position: relative; left: 120px; }';
					document.head.appendChild(s); },
				UNSTYLE, barOpts)]);
		// 5. The mark painted from a file nobody ships.
		results.push(['unknown asset',
			await expectRed('a lockup pointed at splash.svg',
				() => { const s = document.createElement('style'); s.id = 'wm-break';
					s.textContent = '.topbar .brand-wordmark { content: url("assets/splash.svg") !important; }';
					document.head.appendChild(s); },
				UNSTYLE, barOpts)]);

		// 4. Horizontal page overflow -- proved on the GUIDE, not on the app.
		// The app's mobile shell pins `html, body { overflow: hidden }`, so no
		// child can make the document scroll there and the check is structurally
		// inert on the app below 760px. It is live on the guide and the landing
		// site, which are ordinary scrolling documents, and that is where it has
		// to be proved.
		await page.setViewportSize({ width: 360, height: 900 });
		await page.goto(`${APP}/guide/index.html`, { waitUntil: 'domcontentloaded' });
		await page.waitForTimeout(250);
		results.push(['page overflow vs an oversized child (on the guide)',
			await expectRed('a 3000px element in the guide page',
				() => { const d = document.createElement('div'); d.id = 'wm-wide';
					d.style.cssText = 'width:3000px;height:4px;background:red'; document.body.appendChild(d); },
				() => { const d = document.getElementById('wm-wide'); if (d) d.remove(); },
				{ label: 'SELFTEST guide', markSel: '.wordmark', rowSel: '.site-head-inner' })]);

		// The self-test's own failures are the point, so they are not the run's.
		fail = before; fails.length = before;
		const inert = results.filter(([, red]) => !red);
		console.log(`\nself-test: ${results.length - inert.length}/${results.length} checks proved red`);
		if (inert.length) {
			for (const [what] of inert) console.log(`  INERT: ${what}`);
			process.exitCode = 1;
		}
	}

	await ctx.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fails.length) { console.log('\nfailures:'); for (const f of fails) console.log('  ' + f); }
console.log(`shots: ${SHOTS}`);
if (fail) process.exitCode = 1;
