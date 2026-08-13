// Verify, from the pixels the browser actually paints, the parts of the palette
// that the declared hex cannot settle.
//
// dev/verify_theme.mjs measures colours out of variables.css by the WCAG
// formula, which is the right way to hold eleven palettes to a floor: it is
// exhaustive, it needs no browser, and it cannot be fooled by a screenshot
// taken on one machine. But three things are not decidable from the file:
//
//   The focus indicator. Every text field in the app does `outline: none;
//   border-color: var(--accent)`, so the indicator is not a new mark, it is the
//   RESTING BORDER recoloured. Whether that reads as focus is a question about
//   the pixels in one strip of screen changing enough, which is what WCAG 2.2
//   SC 2.4.11 asks, and it is measured here by photographing that strip twice.
//
//   A disabled control. `opacity: .5` is not a colour; it is a compositing
//   instruction, and what it yields depends on what is behind it. Reading the
//   declared fill tells you nothing about whether the button still looks like a
//   button, or whether "off" is visible at all. Disabled controls are exempt
//   from the contrast floors, which is exactly why nothing else checks them.
//
//   The tag chips. Their colours are in no palette: the hue is hashed from the
//   tag's name in daimond.js and app.css builds `hsl(var(--tag-h) S% L%)` from
//   it. verify_theme models that arithmetic; here the browser does it, and the
//   two are compared. A model that agrees with the engine it is modelling is
//   worth something; one that has never been checked against it is not.
//
// Run: node dev/verify_contrast_ui.mjs   (needs dev/serve.mjs -- DAIMOND_PORT,
// default 8777)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

const out = [];
let bad = 0;
const say   = (ok, what) => { out.push(`${ok ? 'PASS' : 'FAIL'}  ${what}`); return ok; };
const check = (ok, what) => { if (!say(ok, what)) bad++; };
const note  = (what) => out.push(`      ${what}`);
// Shortfalls that dev/verify_theme.mjs already records against the declared
// hex. Repeating them as failures here would only make one defect fail twice;
// what matters is that the RENDERED number is no worse than the recorded one.
// Same gate as verify_theme's: short but no worse prints SHORT, short and worse
// (or short and unrecorded) is a hard FAIL, so a palette can improve but never
// quietly slip. `--emit-baseline` prints the table to paste back.
const shorts = [];
const EMIT   = process.argv.includes('--emit-baseline');
const DRIFT  = 0.05;	// looser than the static gate: these are sampled pixels
function soft(id, r, floor, what) {
	const line = `${what} = ${r.toFixed(2)} (floor ${floor})`;
	if (r >= floor) { say(true, line); return true; }
	const rec = KNOWN[id];
	if (rec === undefined) { check(false, `${line} -- a NEW shortfall, absent from the baseline`); shorts.push({ id, r, line }); return false; }
	if (r < rec - DRIFT)   { check(false, `${line} -- WORSE than the recorded ${rec.toFixed(2)}`); shorts.push({ id, r, line }); return false; }
	out.push(`SHORT ${line}`);
	shorts.push({ id, r, line });
	return false;
}
/// What each rendered shortfall stands at now. Every one of these is written up
/// in dev/contrast_report.md; the static twin of each is in verify_theme.mjs.
const KNOWN = {
	'amber/chip-no-text': 4.48,
	'dark/chip-no-text': 4.48,
	'dusk/chip-no-text': 2.96,
	'dusk/field-focus': 1.52,
	'dusk/outline-ring': 2.47,
	'forest/chip-no-text': 4.06,
	'forest/field-focus': 2.77,
	'light/chip-no-text': 3.14,
	'linen/chip-no-text': 2.88,
	'lollypop/chip-no-text': 2.90,
	'lollypop/field-focus': 2.85,
	'midnight/chip-no-text': 4.17,
	'mist/chip-no-text': 3.08,
	'plum/chip-no-text': 4.27,
	'sage/chip-no-text': 2.65,
};

// ── Colour, the same arithmetic verify_theme uses ───────────────
function lum(c) {
	const f = c.map(v => {
		const s = v / 255;
		return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
	});
	return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2];
}
function ratio(a, b) {
	const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
	return (x + 0.05) / (y + 0.05);
}
/// sRGB out of whatever `getComputedStyle` handed back -- `rgb(r, g, b)` or
/// `rgba(r, g, b, a)`, which is every form Chromium resolves a colour to.
function parse(css) {
	const m = String(css).match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
	return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

// ── The floors ──────────────────────────────────────────────────
/// WCAG 2.2 SC 2.4.11, Focus Appearance: the focus indicator has to reach 3:1
/// against the same pixels in their unfocused state. Where the indicator IS the
/// resting border recoloured, that is the whole test.
const RING = 3.0;
/// SC 1.4.3 for the chips: a tag's name is text.
const WORD = 4.5;
/// A disabled control is EXEMPT from the contrast floors, so this is not one.
/// It is the weaker question the exemption leaves open -- can you tell it is
/// off? -- and 1.2:1 is about where a flat fill stops reading as the same
/// colour as its neighbour. Anything at 1.0 is the bug this catches: a disabled
/// rule that some later selector has already overridden.
const OFF = 1.2;
const NAMES = ['light', 'mist', 'linen', 'lollypop', 'sage', 'dusk', 'dark', 'amber', 'midnight', 'forest', 'plum'];

/// The pixels inside a clip rectangle, as the browser painted them.
///
/// The screenshot comes back as PNG bytes, and the page decodes them: Node has
/// no PNG decoder, and the browser that drew the pixels is the least arguable
/// thing to read them back with.
async function pixels(page, clip) {
	const buf = await page.screenshot({ clip });
	return page.evaluate(async (b64) => {
		const res = await fetch('data:image/png;base64,' + b64);
		const bm  = await createImageBitmap(await res.blob());
		const cv  = new OffscreenCanvas(bm.width, bm.height);
		const ctx = cv.getContext('2d');
		ctx.drawImage(bm, 0, 0);
		const d = ctx.getImageData(0, 0, bm.width, bm.height).data;
		const px = [];
		for (let i = 0; i < d.length; i += 4) px.push([d[i], d[i + 1], d[i + 2]]);
		return px;
	}, buf.toString('base64'));
}

const s = await open({ name: 'contrast-ui', signIn: false, connect: false });
const { page } = s;

/// Put the app in one palette, through the app's own service.
async function wear(theme) {
	await page.evaluate(t => window.DaimondTheme.set(t), theme);
	await page.waitForTimeout(120);
}

// ════════════════════════════════════════════════════════════════
// 1. The focus indicator, photographed
// ════════════════════════════════════════════════════════════════
// A real field on a real screen: the passphrase box on the identity gate, which
// carries `.id-fields input:focus { outline: none; border-color: var(--accent) }`
// -- the pattern every other field in the app repeats. The strip is four pixels
// either side of the field's left edge, so it holds the border, some of the
// panel outside it and some of the fill inside it. Photograph it blurred,
// photograph it focused, and the largest change between corresponding pixels is
// the indicator's contrast.
await page.waitForSelector('#id-pass', { timeout: 15000 });
for (const theme of NAMES) {
	await wear(theme);
	const box = await page.locator('#id-pass').boundingBox();
	if (!box) { check(false, `${theme}: the passphrase field is on screen`); continue; }
	const clip = { x: Math.round(box.x) - 4, y: Math.round(box.y + box.height / 2) - 3, width: 9, height: 6 };

	await page.evaluate(() => document.activeElement && document.activeElement.blur());
	await page.waitForTimeout(150);
	const before = await pixels(page, clip);

	await page.focus('#id-pass');
	await page.waitForTimeout(150);
	const after = await pixels(page, clip);

	let best = 0;
	for (let i = 0; i < Math.min(before.length, after.length); i++) {
		const r = ratio(before[i], after[i]);
		if (r > best) best = r;
	}
	soft(`${theme}/field-focus`, best, RING,
		`${theme}: a focused field's edge against its own unfocused pixels`);
}
await page.evaluate(() => document.activeElement && document.activeElement.blur());

// The other shape the ring takes: `outline: 2px solid var(--accent)`, drawn on
// the surface rather than replacing anything (app.css:258, workspace.css:166,
// files.css:39, models.css:134). A probe carrying the real `.admin-item` class,
// focused from the keyboard so `:focus-visible` genuinely matches, then
// photographed against the surface it sits on. Rendered, not declared: this is
// what catches a ring that a later rule has already painted over.
for (const theme of NAMES) {
	await wear(theme);
	await page.evaluate(() => {
		let host = document.getElementById('ring-host');
		if (!host) {
			// The ring is drawn 2px OUTSIDE the button, so what it lands on is the
			// button's surroundings, not the button. The probe therefore needs a
			// panel around it: on the bare page it would sit on the identity
			// modal's scrim, and the measurement would be of the scrim.
			host = document.createElement('div');
			host.id = 'ring-host';
			host.style.cssText = 'position:fixed;left:40px;top:200px;padding:14px;z-index:99999;background:var(--bg-secondary);';
			const p = document.createElement('button');
			p.id = 'ring-probe';
			p.className = 'admin-item';
			p.textContent = 'probe';
			p.style.width = '120px';
			host.appendChild(p);
			document.body.appendChild(host);
		}
		document.getElementById('ring-probe').blur();
	});
	await page.waitForTimeout(100);
	const box = await page.locator('#ring-probe').boundingBox();
	const clip = { x: Math.round(box.x) - 5, y: Math.round(box.y + box.height / 2) - 3, width: 8, height: 6 };
	const before = await pixels(page, clip);
	const visible = await page.evaluate(() => {
		const p = document.getElementById('ring-probe');
		p.focus();
		return p.matches(':focus-visible');
	});
	await page.waitForTimeout(120);
	const after = await pixels(page, clip);
	let best = 0;
	for (let i = 0; i < Math.min(before.length, after.length); i++) {
		const r = ratio(before[i], after[i]);
		if (r > best) best = r;
	}
	check(visible, `${theme}: the probe really takes :focus-visible (or the ring below means nothing)`);
	soft(`${theme}/outline-ring`, best, RING,
		`${theme}: the outline ring against the panel it is drawn on`);
}
await page.evaluate(() => { const h = document.getElementById('ring-host'); if (h) h.remove(); });

// ════════════════════════════════════════════════════════════════
// 2. A disabled control still says it is off
// ════════════════════════════════════════════════════════════════
// The gate's own primary button, which is genuinely disabled until the user
// says they have written the generated passphrase down (`#id-wrote`), so this
// is the app's real disabled state and not a class pinned on for the test.
// `#id-primary:disabled { opacity: .5 }` composites against whatever is behind
// it, so the answer is a photograph, not a declaration.
//
// A PHOTOGRAPH OF AN ELEMENT NOBODY CAN SEE IS NOT EVIDENCE. `.modal-card` scrolls
// (`overflow-y: auto`), and on 2026-08-14 the identity card gained a 160px strip of
// front-door links: content went to 1108px inside an 872px box and the primary
// button dropped to y=937 with the card's visible edge at 912. Its bounding box was
// still returned, the clip was still inside the viewport, and both photographs came
// back as the modal backdrop -- identical, so the ratio was exactly 1.00 in all
// eleven palettes and read as a contrast failure that no colour could have fixed.
// So the button is scrolled to before it is photographed, the way a user would
// reach it, and `paintedAt` asks the page whether the pixel about to be sampled
// really belongs to the button. That turns "off screen" into its own named red
// instead of a wrong answer about contrast.
/// Is the element under this viewport point the button itself?
const paintedAt = (page, x, y) => page.evaluate(([px, py]) => {
	const b = document.getElementById('id-primary');
	if (!b) return 'no #id-primary';
	const hit = document.elementFromPoint(px, py);
	if (!hit) return 'nothing is painted there -- the point is outside the viewport';
	if (hit === b || b.contains(hit)) return '';
	return `${hit.tagName.toLowerCase()}${hit.id ? '#' + hit.id : ''} is drawn over it`;
}, [x, y]);
{
	const wrote = await page.$('#id-wrote');
	if (!wrote || !(await wrote.isVisible())) {
		note('the create form is not showing, so the disabled button was not measured');
	} else {
		for (const theme of NAMES) {
			await wear(theme);
			await page.evaluate(() => {
				const w = document.getElementById('id-wrote');
				if (w.checked) { w.checked = false; w.dispatchEvent(new Event('change', { bubbles: true })); }
			});
			await page.locator('#id-primary').scrollIntoViewIfNeeded();
			await page.waitForTimeout(150);
			const off = await page.evaluate(() => (document.getElementById('id-primary') || {}).disabled);
			const box = await page.locator('#id-primary').boundingBox();
			const clip = { x: Math.round(box.x + box.width / 2) - 3, y: Math.round(box.y + 4), width: 6, height: 4 };
			const why = await paintedAt(page, clip.x + 3, clip.y + 1);
			const dis = await pixels(page, clip);

			await page.evaluate(() => {
				const w = document.getElementById('id-wrote');
				w.checked = true; w.dispatchEvent(new Event('change', { bubbles: true }));
			});
			await page.waitForTimeout(150);
			const ena = await pixels(page, clip);

			let best = 0;
			for (let i = 0; i < Math.min(dis.length, ena.length); i++) {
				const r = ratio(dis[i], ena[i]);
				if (r > best) best = r;
			}
			check(off, `${theme}: the create button is genuinely disabled before the passphrase is acknowledged`);
			check(why === '', `${theme}: and the button is really on screen to be photographed`
				+ (why ? ` -- ${why}` : ''));
			if (why === '') {
				soft(`${theme}/disabled`, best, OFF,
					`${theme}: a disabled button against its enabled self`);
			}
		}
	}
}

// ════════════════════════════════════════════════════════════════
// 3. The generated tag chips
// ════════════════════════════════════════════════════════════════
// One real `.tag-chip` per hue, in the real page, with the real stylesheet
// resolving `hsl(var(--tag-h) S% L%)`. The hues come from daimond.js, so a hue
// added there is measured here on the next run.
const js = fs.readFileSync(path.join(WWW, 'js', 'daimond.js'), 'utf8');
const TAG_HUES = (() => {
	const m = js.match(/var TAG_HUES\s*=\s*\[([^\]]*)\]/);
	return m ? m[1].split(',').map(v => parseInt(v.trim(), 10)).filter(v => !Number.isNaN(v)) : [];
})();
check(TAG_HUES.length > 0, `the tag hues are readable from daimond.js (found ${TAG_HUES.length})`);

/// The same hsl() arithmetic verify_theme.mjs uses, restated here only so the
/// browser has something to be compared AGAINST.
function hsl(h, sat, li) {
	h = ((h % 360) + 360) % 360; sat /= 100; li /= 100;
	const c = (1 - Math.abs(2 * li - 1)) * sat;
	const x = c * (1 - Math.abs((h / 60) % 2 - 1));
	const m = li - c / 2;
	let v;
	if (h <  60) v = [c, x, 0]; else if (h < 120) v = [x, c, 0];
	else if (h < 180) v = [0, c, x]; else if (h < 240) v = [0, x, c];
	else if (h < 300) v = [x, 0, c]; else v = [c, 0, x];
	return v.map(q => Math.round((q + m) * 255));
}

for (const theme of NAMES) {
	await wear(theme);
	const rows = await page.evaluate((hues) => {
		let host = document.getElementById('chip-probe');
		if (host) host.remove();
		host = document.createElement('div');
		host.id = 'chip-probe';
		host.style.cssText = 'position:fixed;left:0;top:0;z-index:99999;background:var(--bg-secondary);';
		document.body.appendChild(host);
		const seen = [];
		for (const h of hues) {
			const el = document.createElement('span');
			el.className = 'tag-chip';
			el.textContent = 'tag';
			el.style.setProperty('--tag-h', String(h));
			host.appendChild(el);
			const cs = getComputedStyle(el);
			// The refused chip and the selected chip are the same element wearing
			// another class, so they are read off the same probe.
			el.classList.add('tag-no');
			const csNo = getComputedStyle(el);
			const no = csNo.color;
			el.classList.remove('tag-no');
			el.classList.add('tag-inc');
			const csOn = getComputedStyle(el);
			const on = { bg: csOn.backgroundColor, fg: csOn.color };
			el.classList.remove('tag-inc');
			seen.push({ h, bg: cs.backgroundColor, fg: cs.color, bd: cs.borderTopColor, no, on });
		}
		const root = getComputedStyle(document.documentElement);
		const surf = {
			secondary: root.getPropertyValue('--bg-secondary').trim(),
			tertiary:  root.getPropertyValue('--bg-tertiary').trim(),
			hover:     root.getPropertyValue('--bg-hover').trim(),
		};
		host.remove();
		return { seen, surf };
	}, TAG_HUES);

	let worst = { r: Infinity }, worstOn = { r: Infinity }, worstNo = { r: Infinity };
	for (const row of rows.seen) {
		const fg = parse(row.fg), bg = parse(row.bg);
		if (!fg || !bg) { check(false, `${theme}: hue ${row.h} resolves to a colour`); continue; }
		const r = ratio(fg, bg);
		if (r < worst.r) worst = { r, h: row.h };
		// The selected chip, as the browser composites it -- the same neutral pair
		// for every hue, which is the claim the token was introduced to make.
		const onFg = parse(row.on.fg), onBg = parse(row.on.bg);
		if (onFg && onBg) {
			const ro = ratio(onFg, onBg);
			if (ro < worstOn.r) worstOn = { r: ro, h: row.h };
		}
		// A refused chip has no fill, so its label lands on the panel.
		const noFg = parse(row.no);
		if (noFg) {
			for (const k of ['secondary', 'tertiary', 'hover']) {
				const hex = rows.surf[k].replace('#', '');
				const sc = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16));
				const rn = ratio(noFg, sc);
				if (rn < worstNo.r) worstNo = { r: rn, h: row.h, surf: k };
			}
		}
	}
	// 4.5, because a chip carries the tag's NAME.
	soft(`${theme}/chip-text`, worst.r, WORD,
		`${theme}: a rendered tag chip's name, worst hue (${worst.h})`);
	check(worstOn.r >= WORD,
		`${theme}: a rendered SELECTED chip's lettering, worst hue (${worstOn.h}) = ${worstOn.r.toFixed(2)} (floor ${WORD})`);
	if (worstNo.r < Infinity) {
		soft(`${theme}/chip-no-text`, worstNo.r, WORD,
			`${theme}: a rendered REFUSED chip's name on ${worstNo.surf}, worst hue (${worstNo.h})`);
	}

	// The engine against the model. verify_theme.mjs computes these colours
	// itself, from the same S% and L% in app.css; if its arithmetic and
	// Chromium's disagree, every ratio it reports is off by that much and nobody
	// would know. Only the resting chip is compared -- one rule is enough to
	// catch a wrong formula.
	const ink = await page.evaluate(() => document.documentElement.getAttribute('data-ink'));
	const app = fs.readFileSync(path.join(WWW, 'css', 'app.css'), 'utf8');
	const sel = ink === 'dark' ? ':root[data-ink="dark"] .tag-chip' : '.tag-chip';
	const body = app.slice(app.indexOf(sel + ' {'), app.indexOf('}', app.indexOf(sel + ' {')));
	const m = body.match(/color:[^;]*?hsl\(var\(--tag-h[^)]*\)\s*(\d+)%\s*(\d+)%/);
	if (m) {
		let drift = 0, at = null;
		for (const row of rows.seen) {
			const model = hsl(row.h, Number(m[1]), Number(m[2]));
			const real  = parse(row.fg);
			const d = Math.max(...model.map((v, i) => Math.abs(v - real[i])));
			if (d > drift) { drift = d; at = row.h; }
		}
		check(drift <= 1,
			`${theme}: verify_theme's hsl() matches Chromium's, worst by ${drift}/255${at === null ? '' : ` (hue ${at})`}`);
	}
}

// Console errors are part of the result: a page that throws while being
// measured was not in the state the measurement assumed.
// 502s are the dev server saying there is no gateway behind it, which is how
// this environment is meant to be run; they are not the page failing.
const noise = [/favicon/i, /net::ERR_ABORTED/i, /502/, /Bad Gateway/i, /Failed to load resource/i];
const errs = s.errs.filter(e => !noise.some(r => r.test(e)));
check(errs.length === 0, `no console errors while measuring${errs.length ? `: ${errs.slice(0, 3).join(' | ')}` : ''}`);

await s.close();

console.log(out.join('\n'));
if (shorts.length) {
	console.log(`\n── short of the floor, and recorded (${shorts.length}) ──`);
	for (const w of shorts) console.log(`  ${w.line}`);
	console.log('  See dev/contrast_report.md for the suggested colours.');
}
if (EMIT) {
	console.log('\n── baseline to paste into KNOWN ──');
	for (const w of shorts.slice().sort((a, b) => a.id.localeCompare(b.id))) {
		console.log(`\t'${w.id}': ${(Math.floor(w.r * 100) / 100).toFixed(2)},`);
	}
}
console.log(bad ? `\n${bad} FAILED` : `\nALL PASS (${out.filter(l => l.startsWith('PASS')).length} checks, ${shorts.length} short)`);
process.exit(bad ? 1 : 0);
