// verify_interfacediagram.mjs — the interface page's region map says what the
// app does, and is still made of words on a phone.
//
// Two properties, and one of them was a live defect.
//
//   1. THE TOP BAR HAS NO SPEND METER. `#top-meter` is in www/index.html and
//      nothing ever writes it: `updateMeters()` in www/js/daimond.js sets
//      `topMeter.textContent = ''` and there is no other assignment in the
//      tree. The readout the guide was describing is the rail's `#spend-row`,
//      which `updateSpend()` fills with three cells and which `spend.js` wires
//      as the door to the Spending panel. So the guide must not put a meter in
//      the top bar, on `interface.html` or on `spending.html`, and the region
//      map must not draw one. Checked against the CODE, not against a list of
//      words: the assertion is "nothing writes #top-meter", so the day someone
//      revives the meter this check turns round and demands the guide say so.
//
//   2. THE DIAGRAM'S WORDS ARE STILL WORDS AT 360px. Scaled to a phone column
//      the whole schematic put its smallest labels near five pixels. Measured
//      as RENDERED INK -- the height of a label's own box on the page as the
//      reader has it -- and not as a font-size in the markup, which says
//      nothing once an SVG has been scaled to fit. The page must also not
//      scroll sideways: the figure scrolls inside its own box instead.
//
// EACH CHECK IS PROVED AGAINST A BROKEN PAGE FIRST. `--break <name>` damages a
// copy of a file and serves it to the real browser through `page.route`, or
// damages the input a static check reads, and the run is expected to FAIL.
//
//   node dev/verify_interfacediagram.mjs --break meterprose  # 1 fails
//   node dev/verify_interfacediagram.mjs --break meterdoor   # 1 fails
//   node dev/verify_interfacediagram.mjs --break metersvg    # 1 fails
//   node dev/verify_interfacediagram.mjs --break liveMeter   # 1 fails, the other way
//   node dev/verify_interfacediagram.mjs --break tinylabels  # 2 fails
//   node dev/verify_interfacediagram.mjs --break nofloor     # 2 fails
//   node dev/verify_interfacediagram.mjs                     # and then, clean
//
//   bash dev/world.sh 7 --up && eval "$(bash dev/world.sh 7 --env)"
//   node dev/verify_interfacediagram.mjs
//
// Needs dev/serve.mjs only: the guide is flat files and loads none of the app.
// Writes its screenshots to dev/shots/ifdiag-*.png.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE  = path.dirname(fileURLToPath(import.meta.url));
const WWW   = path.join(HERE, '..', 'www');
const GUIDE = path.join(WWW, 'guide');
const PAGE  = path.join(GUIDE, 'interface.html');
const SPEND = path.join(GUIDE, 'spending.html');
const SHOTS = path.join(HERE, 'shots');
/// A prove-run renders damaged pages, so its shots go to their own names. The
/// first draft wrote over the real ones, and the clean 360px shot on disk was
/// the one taken with the width floor deliberately removed.
const tag = (n) => `ifdiag-${n}${BREAK ? '-BREAK-' + BREAK : ''}.png`;
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

// ── The inputs, and the damage ───────────────────────────────────────
let pageBytes  = fs.readFileSync(PAGE, 'utf8');
let spendBytes = fs.readFileSync(SPEND, 'utf8');
let appJs      = fs.readFileSync(path.join(WWW, 'js', 'daimond.js'), 'utf8');
let spendJs    = fs.readFileSync(path.join(WWW, 'js', 'spend.js'), 'utf8');

const applied = [];
switch (BREAK) {
	case '': break;
	case 'meterprose': {
		// The sentence as it stood: a meter in the top bar, which is not there.
		const before = pageBytes;
		pageBytes = pageBytes.replace('Across the top sit the wordmark, a row of',
			'Across the top sit the wordmark, a spend meter, a row of');
		if (pageBytes === before) die('the meterprose break did not apply');
		applied.push('put the spend meter back in the top bar paragraph');
		break;
	}
	case 'meterdoor': {
		// The other half of the same false claim, on the other page: the door to
		// the Spending panel described as being in the top bar.
		const before = spendBytes;
		spendBytes = spendBytes.replace(/Open the Spending panel from the <strong>spend row<\/strong> at the foot of the rail/,
			'Open the Spending panel from the <strong>spend meter</strong> in the top bar');
		if (spendBytes === before) die('the meterdoor break did not apply');
		applied.push('sent the reader to a top-bar meter for the Spending panel');
		break;
	}
	case 'metersvg': {
		// The pill-and-fill the region map drew for it, back in the top bar.
		const before = pageBytes;
		pageBytes = pageBytes.replace('<rect class="rm-cell" x="430" y="25" width="40" height="16" rx="8"/>',
			'<rect class="rm-cell" x="322" y="24" width="86" height="18" rx="9"/>\n'
			+ '\t\t\t<rect class="rm-fill" x="326" y="28" width="34" height="10" rx="5" opacity=".55"/>\n'
			+ '\t\t\t<rect class="rm-cell" x="430" y="25" width="40" height="16" rx="8"/>');
		if (pageBytes === before) die('the metersvg break did not apply');
		applied.push('drew a meter in the region map again');
		break;
	}
	case 'liveMeter': {
		// The opposite failure: the app grows a meter and the guide stays silent.
		// The check must notice that too, or it is a check on one wording.
		const before = appJs;
		appJs = appJs.replace('topMeter.textContent = \'\';',
			'topMeter.textContent = fmtUsd(spentToday());');
		if (appJs === before) die('the liveMeter break did not apply');
		applied.push('made updateMeters() write the top meter');
		break;
	}
	case 'tinylabels':
	case 'nofloor': {
		// The width floor removed, so the schematic is scaled to the phone column
		// and its labels go with it. This is what the page did before this file.
		const before = pageBytes;
		pageBytes = pageBytes.replace(/\.diagram\.scrolls svg \{ min-width: \d+px; \}/, '');
		if (pageBytes === before) die('the width-floor break did not apply');
		applied.push('let the region map scale down to the phone column');
		break;
	}
	default: die(`no break called "${BREAK}"`);
}
if (BREAK) console.log(`BREAK ${BREAK}: ${applied.join('; ')}\n`);

// ── 1. The top bar has no spend meter ────────────────────────────────
//
// The oracle is the code. `#top-meter` exists in the markup, so its presence
// proves nothing; what decides the question is whether anything ever puts
// characters in it. `updateMeters()` clears it and no other statement in the
// tree assigns to it, so the element is furniture with no content. A guide that
// names it is describing a control the reader cannot find.
{
	// Every assignment to the element, however it is reached: the variable
	// daimond.js binds it to, and a fresh lookup anywhere else.
	const writes = [];
	const files = [];
	const walk = (dir) => {
		for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
			const p = path.join(dir, e.name);
			if (e.isDirectory()) walk(p);
			else if (/\.(js|mjs)$/.test(e.name)) files.push(p);
		}
	};
	walk(path.join(WWW, 'js'));
	// The named binding, from daimond.js's own `var topMeter = getElementById(...)`.
	const RE = /\b(topMeter|document\.getElementById\(\s*'top-meter'\s*\))\s*\.\s*(textContent|innerHTML|innerText|append\w*|replaceChildren)\s*(=[^=]|\()/g;
	for (const f of files) {
		const src = f.endsWith('daimond.js') ? appJs : (f.endsWith('spend.js') ? spendJs : fs.readFileSync(f, 'utf8'));
		let m;
		while ((m = RE.exec(src))) {
			// An assignment of the empty string is a clearing, not a readout.
			const tail = src.slice(m.index, m.index + 200);
			if (/=\s*''\s*;/.test(tail.slice(0, 40))) continue;
			writes.push(`${path.basename(f)}: ${tail.split('\n')[0].trim().slice(0, 60)}`);
		}
	}
	const live = writes.length > 0;

	// What the two pages say. The claim is "a spend readout in the top bar", in
	// any wording: a named thing, in the named place, within one sentence.
	const proseOf = (b) => (b.match(/<main[^>]*>([\s\S]*?)<\/main>/i) || [, ''])[1]
		.replace(/<svg[\s\S]*?<\/svg>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
	const CLAIM = /\bspend(ing)?\s+(meter|readout|total|figure)\b[^.]{0,60}\btop bar\b|\btop bar\b[^.]{0,60}\bspend(ing)?\s+(meter|readout|total|figure)\b/i;
	const said = [];
	if (CLAIM.test(proseOf(pageBytes)))  said.push('interface.html');
	if (CLAIM.test(proseOf(spendBytes))) said.push('spending.html');

	// And the region map must not draw one. The meter was a filled pill in the
	// top-bar strip: a `rm-fill` rectangle inside the bar's own band (y < 56),
	// which is otherwise only the brand diamond, drawn rotated.
	const svg = (pageBytes.match(/<svg class="regionmap"[\s\S]*?<\/svg>/) || [''])[0];
	const drawn = [...svg.matchAll(/<rect class="rm-fill"[^>]*y="(\d+(?:\.\d+)?)"[^>]*>/g)]
		.filter((m) => Number(m[1]) < 56 && !/rotate/.test(m[0]));

	// The two halves have to agree with the code, in whichever direction it points.
	const agrees = live ? (said.length === 2) : (said.length === 0 && drawn.length === 0);
	check('the guide and the code agree about a spend meter in the top bar', agrees,
		live ? `nothing writes #top-meter is FALSE (${writes[0]}), and the guide says it on: ${said.join(', ') || 'no page'}`
			: `nothing writes #top-meter, but ${said.join(' and ') || 'the diagram'} still ${said.length ? 'says so' : 'draws one'}`);

	// And the reader is sent to the door that exists. `spend.js` puts the click
	// handler on `#spend-row`, so that is where the guide has to point.
	const door = /getElementById\('spend-row'\)[\s\S]{0,600}?addEventListener\('click'/.test(spendJs);
	const points = /spend row[^.]{0,60}(rail|foot of the rail)|(rail|foot of the rail)[^.]{0,60}spend row/i
		.test(proseOf(spendBytes));
	check('spending.html points at the door spend.js actually wires', !door || points,
		door ? 'the handler is on #spend-row and the page does not say so' : 'no handler found');
}

// ── The browser ──────────────────────────────────────────────────────
const { chromium } = await import(pathToFileURL(PW).href);
const profile = path.join(SCRATCH, 'pw', 'ifdiag' + (BREAK ? '-' + BREAK : ''));
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

await page.route('**/guide/interface.html*', (route) => {
	route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: pageBytes });
});

const URL = `${APP}/guide/interface.html`;

/// Put the page into one of the app's palettes, the way guide/frame.js does.
const TONES = { light: ['light', 'dark'], dark: ['dark', 'light'] };
async function wear(theme) {
	await page.evaluate(({ t, m }) => {
		const r = document.documentElement;
		r.setAttribute('data-theme', t);
		r.setAttribute('data-tone', m[0]);
		r.setAttribute('data-ink', m[1]);
	}, { t: theme, m: TONES[theme] });
	await page.waitForTimeout(250);
}

/// The rendered height of the smallest label in the region map, in CSS pixels
/// on the page as the reader has it. `<text>` only: a rectangle has no words in
/// it, and a font-size in the markup says nothing once the SVG has been scaled.
const measure = () => page.evaluate(() => {
	const labs = [...document.querySelectorAll('.regionmap text')];
	if (!labs.length) return null;
	const rows = labs.map((l) => ({
		t: l.textContent.trim().slice(0, 24),
		h: l.getBoundingClientRect().height,
		px: Number(getComputedStyle(l).fontSize.replace('px', '')),
	})).sort((a, b) => a.h - b.h);
	return { min: rows[0], n: rows.length, all: rows.slice(0, 4) };
});

// ── Desktop, both palettes ───────────────────────────────────────────
for (const theme of ['light', 'dark']) {
	await page.setViewportSize({ width: 1100, height: 900 });
	await page.goto(URL, { waitUntil: 'load' });
	await page.waitForTimeout(400);
	await wear(theme);
	const m = await measure();
	console.log(`  1100px ${theme.padEnd(5)} smallest label ${m ? m.min.h.toFixed(1) + 'px (' + JSON.stringify(m.min.t) + ', font ' + m.min.px.toFixed(1) + 'px)' : 'none'}`);
	const fig = await page.$('.diagram');
	if (fig) await fig.screenshot({ path: path.join(SHOTS, tag(`1100-${theme}`)) });
}

// ── 360px, the narrowest width the guide supports ────────────────────
{
	// Eight pixels of rendered ink is the floor dev/verify_vocabulary.mjs holds
	// the other diagram to: below that the strokes of a lower-case letter merge
	// at this weight. Kept identical so the two figures cannot drift apart.
	const FLOOR_PX = 8;
	for (const theme of ['light', 'dark']) {
		await page.setViewportSize({ width: 360, height: 900 });
		await page.goto(URL, { waitUntil: 'load' });
		await page.waitForTimeout(400);
		await wear(theme);
		const m = await measure();
		console.log(`  360px  ${theme.padEnd(5)} smallest label ${m ? m.min.h.toFixed(1) + 'px (' + JSON.stringify(m.min.t) + ', font ' + m.min.px.toFixed(1) + 'px)' : 'none'}`);
		if (theme === 'light') {
			const wide = await page.evaluate(() =>
				document.documentElement.scrollWidth - document.documentElement.clientWidth);
			check('the page does not scroll sideways at 360px', wide <= 1, `${wide}px of overflow`);
			// The figure carries the scrolling instead, which is the whole trick:
			// a floor with no overflow box would simply widen the page.
			const inside = await page.evaluate(() => {
				const f = document.querySelector('.diagram');
				if (!f) return null;
				return { scroll: f.scrollWidth, client: f.clientWidth,
					overflow: getComputedStyle(f).overflowX };
			});
			check('the figure scrolls inside its own box',
				!!inside && inside.overflow === 'auto' && inside.scroll > inside.client + 1,
				inside ? `overflow-x: ${inside.overflow}, ${inside.scroll} in ${inside.client}` : 'no figure');
			check('the region map\'s labels are still legible at 360px',
				!!m && m.min.h >= FLOOR_PX,
				m ? `smallest label renders ${m.min.h.toFixed(1)}px tall (${JSON.stringify(m.min.t)})` : 'no labels found');
		}
		await page.evaluate(() => window.scrollTo(0, 0));
		await page.screenshot({ path: path.join(SHOTS, tag(`360-${theme}`)), fullPage: false });
	}
}

check('the page threw nothing', errs.length === 0, errs.slice(0, 3).join(' | '));

await browser.close();

console.log(`\n${ok.length} ok, ${bad.length} failed`);
if (BREAK) {
	if (bad.length) { console.log('the break was caught, as it should be'); process.exit(0); }
	console.log('THE BREAK WAS NOT CAUGHT: this check proves nothing');
	process.exit(1);
}
process.exit(bad.length ? 1 : 0);
