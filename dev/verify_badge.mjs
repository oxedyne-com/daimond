// The maker's badge: two claims, two hit areas, and the split between them.
//
// The badge is one artwork carrying two separate statements -- the Oxedyne
// flame, which links to Oxedyne, and the AI-disclosure chip, which for now only
// says what it is. It is drawn as an <img>, so the page cannot reach inside it
// to hang a link on a group; the hit areas are laid OVER it at a fixed 50%.
//
// That is a guess about someone else's artwork, and a guess that would fail
// silently: redraw the badge with the marks off-centre and the flame's hit area
// starts covering the chip, with nothing to say so. So the guess is checked.
// The SVG keeps Inkscape's labels (`oxedyne`, `made_with_mostly_ai_icon`), and
// this measures where those two groups actually are.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SVG  = path.join(HERE, '..', 'www', 'assets', 'made_by_oxedyne.svg');
const PW   = process.env.DAIMOND_PW
	|| path.join(os.homedir(), '.red-pw/node_modules/playwright-core/index.mjs');
const { chromium } = await import(pathToFileURL(PW).href);
const CHROME = process.env.DAIMOND_CHROME
	|| `${process.env.HOME}/.cache/ms-playwright/chromium-1229/chrome-linux64/chrome`;

let bad = 0;
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) bad++; };

/// Where the CSS puts the boundary. Read from the stylesheet rather than
/// restated, so the two cannot drift apart.
const css = fs.readFileSync(path.join(HERE, '..', 'www', 'css', 'app.css'), 'utf8');
const m = css.match(/\.made-by \.mb-hit \{[^}]*width:\s*([\d.]+)%/);
check(!!m, 'the stylesheet states the hit areas\' width');
const splitPct = m ? parseFloat(m[1]) : 50;

const svg = fs.readFileSync(SVG, 'utf8');
for (const label of ['oxedyne', 'made_with_mostly_ai_icon']) {
	check(svg.includes(`inkscape:label="${label}"`),
		`the artwork still labels its ${label} group (a re-export that drops it would leave this check blind)`);
}

const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage({ viewport: { width: 900, height: 400 } });
// Inlined here ONLY to measure it; the app draws it as an <img>.
await page.setContent(`<body style="margin:0">${svg}</body>`);
await page.waitForTimeout(200);

const box = await page.evaluate(() => {
	const root = document.querySelector('svg');
	// getBBox() reports a group's OWN user space and ignores the transforms
	// above it, so a nested group comes back in the wrong place entirely --
	// measured that way the chip appeared to sit left of the flame. The painted
	// rectangle is what the hit areas have to line up with.
	const rr = root.getBoundingClientRect();
	const of = (label) => {
		const g = [...document.querySelectorAll('g, rect, path')]
			.find(e => e.getAttribute('inkscape:label') === label);
		if (!g) return null;
		const b = g.getBoundingClientRect();
		return { leftPct: 100 * (b.left - rr.left) / rr.width,
			rightPct: 100 * (b.right - rr.left) / rr.width };
	};
	return { flame: of('oxedyne'), chip: of('made_with_mostly_ai_icon'), vbw: rr.width };
});
console.log(JSON.stringify(box, null, 1));

check(!!box.flame && !!box.chip, 'both marks were found in the artwork');
if (box.flame && box.chip) {
	// The flame is left of the chip, and the boundary falls in the gap between
	// them -- so each hit area covers its own mark and only its own mark.
	check(box.flame.rightPct < box.chip.leftPct,
		`the flame ends before the chip begins (${box.flame.rightPct.toFixed(1)}% then ${box.chip.leftPct.toFixed(1)}%)`);
	check(splitPct >= box.flame.rightPct && splitPct <= box.chip.leftPct,
		`the ${splitPct}% boundary falls in the gap between them (${box.flame.rightPct.toFixed(1)}%..${box.chip.leftPct.toFixed(1)}%)`);
	const mid = (box.flame.rightPct + box.chip.leftPct) / 2;
	console.log(`      the gap's centre is ${mid.toFixed(1)}%`);
}

console.log(bad ? `\n${bad} FAILED` : '\nALL PASS');
await browser.close();
process.exit(bad ? 1 : 0);
