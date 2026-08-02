// shot_badge.mjs — the maker's badge in the top bar, at its doubled height.
//
// The badge is drawn at twice the height it began at, which makes it taller than
// the wordmark beside it and taller than everything else in the bar. Two things
// have to be looked at rather than asserted: whether the bar still reads as one
// row of related marks, and whether anything above it clips the badge's plate --
// this app's recurring defect is ink drawn outside a border box and sliced by an
// ancestor's overflow, so the measurement is taken as well as the picture.
import { open } from './harness.mjs';
import path from 'node:path';
import fs from 'node:fs';

const OUT = path.join(process.cwd(), 'dev', 'shots');
fs.mkdirSync(OUT, { recursive: true });

const s = await open({ name: 'badge', connect: false });
const p = s.page;
await p.waitForTimeout(1500);

// The bar at four widths: the desktop default, a narrow desktop, and the two
// steps either side of the 760px cut where the badge is dropped on purpose. 780
// is the width that matters -- the badge is still drawn there, in the crowded
// row whose overflow is a guillotine, so the row is measured as well as shot.
for (const w of [1400, 900, 780, 700]) {
	await p.setViewportSize({ width: w, height: 800 });
	await p.waitForTimeout(400);
	const bar = await p.$('.topbar');
	if (bar) {
		await bar.screenshot({ path: path.join(OUT, `badge_bar_${w}.png`) });
	}
	const fit = await p.evaluate(() => {
		const bar = document.querySelector('.topbar');
		const act = document.querySelector('.top-actions');
		const mb  = document.querySelector('.made-by');
		const vis = mb && getComputedStyle(mb).display !== 'none';
		const r = bar.getBoundingClientRect();
		return {
			badgeDrawn: !!vis,
			// Does the row still fit, or is `overflow: hidden` cutting it?
			rowOverflow: +(act.scrollWidth - act.clientWidth).toFixed(1),
			barOverflow: +(bar.scrollWidth - bar.clientWidth).toFixed(1),
			// The last control in the row, and whether it is still on screen.
			lastRight: +(act.lastElementChild.getBoundingClientRect().right - r.right).toFixed(1),
		};
	});
	console.log(`${String(w).padStart(5)}px  ${JSON.stringify(fit)}`);
}

await p.setViewportSize({ width: 1400, height: 800 });
await p.waitForTimeout(400);

// An 8x crop of the badge itself, for the eye: the plate's border is 1px and a
// clipped edge at 1x is a rumour.
const badge = await p.$('.made-by');
if (badge) {
	const b = await badge.boundingBox();
	await p.screenshot({
		path: path.join(OUT, 'badge_8x.png'),
		clip: { x: b.x - 8, y: Math.max(0, b.y - 8), width: b.width + 16, height: b.height + 16 },
		scale: 'device',
	});
}

// Whether anything above it cuts the badge off, measured the way the sweep does:
// the painted rectangle against every ancestor that could clip it.
const m = await p.evaluate(() => {
	const img = document.querySelector('.made-by img');
	const wm  = document.querySelector('.brand-wordmark:not([style*="none"])');
	const r   = img.getBoundingClientRect();
	const out = { badge: { w: r.width, h: r.height }, clippers: [] };
	const word = [...document.querySelectorAll('.brand-wordmark')]
		.find(e => getComputedStyle(e).display !== 'none');
	out.wordmark = word ? word.getBoundingClientRect().height : null;
	out.topbar = document.querySelector('.topbar').getBoundingClientRect().height;
	for (let el = img.parentElement; el && el !== document.documentElement; el = el.parentElement) {
		const cs = getComputedStyle(el);
		if (cs.overflow === 'visible' && cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
		const a = el.getBoundingClientRect();
		out.clippers.push({
			sel: el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).split(' ')[0] : ''),
			overflow: cs.overflow + '/' + cs.overflowX + '/' + cs.overflowY,
			headroom: +(r.top - a.top).toFixed(2),
			footroom: +(a.bottom - r.bottom).toFixed(2),
			leftroom: +(r.left - a.left).toFixed(2),
			rightroom: +(a.right - r.right).toFixed(2),
		});
	}
	// Does the bar itself still contain it?
	const bar = document.querySelector('.topbar').getBoundingClientRect();
	out.inBar = { headroom: +(r.top - bar.top).toFixed(2), footroom: +(bar.bottom - r.bottom).toFixed(2) };
	return out;
});
console.log(JSON.stringify(m, null, 1));

await s.close();
