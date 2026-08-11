// shot_badge.mjs — the maker's badge, which is now in the About dialog.
//
// It used to sit in the top bar at twice its original height, and this script
// photographed the bar and measured whether anything above it sliced the plate.
// The badge has moved: the bar holds an About button in that slot and both of
// the badge's claims are in the dialog it opens, where each is a link with room
// to be read.
//
// The same two questions still matter, in the new place. Does the foot of the
// dialog read as one quiet signature row rather than as another control? And is
// anything clipping the plate -- this app's recurring defect is ink drawn
// outside a border box and sliced by an ancestor's overflow, and the card the
// badge now sits in is `overflow-y: auto`, which is exactly such an ancestor.
// So the measurement is taken as well as the picture.
import { open } from './harness.mjs';
import path from 'node:path';
import fs from 'node:fs';

const OUT = path.join(process.cwd(), 'dev', 'shots');
fs.mkdirSync(OUT, { recursive: true });

const s = await open({ name: 'badge', connect: false });
const p = s.page;
await p.waitForTimeout(1500);

/// Open About, and wait for the artwork rather than for the card: the splash is
/// the tallest thing in it and the foot is not where it will finally be until
/// the picture has laid out.
async function openAbout() {
	for (let i = 0; i < 3; i++) { await p.keyboard.press('Escape'); await p.waitForTimeout(90); }
	await p.evaluate(() => { const b = document.getElementById('about-btn'); if (b) b.click(); });
	await p.waitForSelector('.about-card .made-by img', { timeout: 8000 });
	await p.waitForFunction(() => {
		const i = document.querySelector('.about-card .about-splash');
		return i && i.complete && i.naturalWidth > 0;
	}, null, { timeout: 8000 });
	await p.waitForTimeout(300);
}

// The card at four widths: two desktops, and the two either side of the phone
// breakpoint. The badge is drawn at every one of them now -- on a phone it used
// to be dropped from the bar entirely, which is the loss this move undid.
for (const w of [1400, 900, 780, 390]) {
	await p.setViewportSize({ width: w, height: 900 });
	await p.waitForTimeout(400);
	await openAbout();
	const card = await p.$('.about-card');
	if (card) await card.screenshot({ path: path.join(OUT, `badge_about_${w}.png`) });
	const fit = await p.evaluate(() => {
		const card = document.querySelector('.about-card');
		const row  = card.querySelector('.about-maker');
		const mb   = card.querySelector('.made-by');
		const r = mb.getBoundingClientRect(), rr = row.getBoundingClientRect();
		return {
			badgeDrawn: mb.getClientRects().length > 0,
			badge: { w: +r.width.toFixed(1), h: +r.height.toFixed(1) },
			// Is the signature row still a row, or has it wrapped?
			rowH: +rr.height.toFixed(1),
			// Does the card have to scroll to show it?
			cardScroll: card.scrollHeight - card.clientHeight,
			// The two hit areas, which are the point of the artwork being here.
			hits: [...card.querySelectorAll('.mb-hit')].map(a => {
				const b = a.getBoundingClientRect();
				return { name: a.getAttribute('aria-label'), w: Math.round(b.width), x: Math.round(b.x) };
			}),
		};
	});
	console.log(`${String(w).padStart(5)}px  ${JSON.stringify(fit)}`);
}

await p.setViewportSize({ width: 1400, height: 900 });
await p.waitForTimeout(400);
await openAbout();

// An 8x crop of the badge itself, for the eye: the plate's border is 1px and a
// clipped edge at 1x is a rumour.
const badge = await p.$('.about-card .made-by');
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
	const img = document.querySelector('.about-card .made-by img');
	const r   = img.getBoundingClientRect();
	const out = { badge: { w: r.width, h: r.height }, clippers: [] };
	const word = document.querySelector('.about-card .about-word:not([aria-hidden])');
	out.wordmark = word ? word.getBoundingClientRect().height : null;
	out.card = document.querySelector('.about-card').getBoundingClientRect().height;
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
	return out;
});
console.log(JSON.stringify(m, null, 1));

await s.close();
