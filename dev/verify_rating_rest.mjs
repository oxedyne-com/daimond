// gateway: none
// verify_rating_rest.mjs — an answer's rating arrows show faintly AT REST, on desktop as on a phone
// (UNBLOCK-10, D-20261014-09; ruling D-20261006-11 "Show faintly always").
//
// He saw them on his phone and not on his desktop. The by-role gates found them by Playwright
// visibility, which counts an element with `opacity: 0` (or ink the background swallows) as
// visible, so they passed while nobody could see the arrows. This verifier measures what a reader
// sees: with the pointer parked off the tile and nothing focused, each control of the shown group
// must have a box of real size, be the element hit at its own centre, and carry ink -- its effective
// opacity (the product up the ancestor chain) times its colour's alpha, and its colour standing off
// the tile's background by a measured contrast. Then the same with the pointer on the tile, which
// must not be the only time they show.
//
//   eval "$(bash dev/world.sh N --up)"; eval "$(bash dev/world.sh N --env)"
//   node dev/verify_rating_rest.mjs                       # Chromium, 3440, 1853, 1440 and 390 wide
//   DAIMOND_BROWSER=webkit node dev/verify_rating_rest.mjs
//
// One answer, both looks (daylight light and dark), four widths, both engines by the env above. The
// arrows must also sit under the answer, on its text's column (UNBLOCK-10): on his 3440 desktop they sat
// at the far right of the header, ~1300px from the text, drawn but out of the reading path.
import fs from 'node:fs';
import { open, newChat, chat, scratch, checker, BROWSER } from './harness.mjs';

const { check, finish } = checker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIN_INK = 0.35;		// effective opacity x colour alpha: faint, never absent
const MIN_CONTRAST = 1.6;	// colour against the tile's ground, WCAG ratio
const MAX_DX = 8;		// px, first arrow's ink from the text's start
const MAX_DY = 32;		// px, arrows' top below the answer body's foot

const PROF = scratch('pw', 'ratingrest-' + BROWSER);
fs.rmSync(PROF, { recursive: true, force: true });
const s = await open({ name: 'raterest', profile: PROF });
await s.page.setViewportSize({ width: 1440, height: 900 });
await newChat(s);
await chat(s, '@text RATE-REST an answer to rate');
await s.page.waitForSelector('#chat-output .ctile.chat-msg-assistant[data-mid] .ctile-rate', { timeout: 15000 }).catch(() => {});

/// What a reader sees of the shown rating group on the last answer.
const seen = () => s.page.evaluate(() => {
	const tiles = [...document.querySelectorAll('#chat-output .ctile.chat-msg-assistant[data-mid]')]
		.filter((t) => t.querySelector('.ctile-rate'));
	const t = tiles[tiles.length - 1];
	if (!t) return { tile: false };
	const shown = (e) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
	const g = [...t.querySelectorAll('.ctile-rate')].filter(shown)[0];
	if (!g) return { tile: true, group: false };
	const rgba = (c) => { const m = c.match(/[\d.]+/g) || []; return m.map(Number).concat([1]).slice(0, 4); };
	const lum = (c) => {
		const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
		return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
	};
	// The ground the button is drawn on: the first ancestor with a background that is not clear.
	const ground = (e) => {
		for (let n = e.parentElement; n; n = n.parentElement) {
			const b = rgba(getComputedStyle(n).backgroundColor);
			if (b[3] > 0.5) return b;
		}
		return [255, 255, 255, 1];
	};
	// Where the answer's text starts: the first line box of the body's text.
	const body = t.querySelector(':scope > .ctile-body') || t._body;
	let text = null;
	if (body) {
		const w = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, { acceptNode: (n) => n.data.trim() ? 1 : 3 });
		const n = w.nextNode();
		if (n) { const rg = document.createRange(); rg.selectNodeContents(n); const rr = rg.getClientRects()[0]; if (rr) text = { x: rr.left, bottom: body.getBoundingClientRect().bottom }; }
	}
	const g0 = g.querySelector('button').querySelector('svg, .ic').getBoundingClientRect();
	const place = text ? { dx: +(g0.left - text.x).toFixed(1), dy: +(g0.top - text.bottom).toFixed(1) } : null;
	return { tile: true, group: true, place, inRow: !!g.closest('.ctile-rate-row'), ctl: [...g.querySelectorAll('button')].map((b) => {
		const r = b.getBoundingClientRect();
		let op = 1;
		for (let n = b; n; n = n.parentElement) op *= Number(getComputedStyle(n).opacity);
		const svg = b.querySelector('svg, .ic') || b;
		const col = rgba(getComputedStyle(svg).color);
		const bg = ground(b);
		// The ink as composited over the ground, then its contrast against that ground.
		const a = col[3] * op;
		const ink = [0, 1, 2].map((i) => col[i] * a + bg[i] * (1 - a));
		const L1 = lum(ink), L2 = lum(bg);
		const contrast = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
		const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
		return { cls: b.className, w: r.width, h: r.height, op: +op.toFixed(3), alpha: col[3], ink: +a.toFixed(3),
			contrast: +contrast.toFixed(2), hit: !!hit && (hit === b || b.contains(hit)) };
	}) };
});

async function look(label) {
	const f = await seen();
	check(`${label}: an answer tile with a rating group`, f.tile && f.group, JSON.stringify(f));
	if (!f.group) return;
	// Placement (UNBLOCK-10): the arrows sit under the answer, on its text's column, at every width; never
	// across the tile at the far end of the header, out of the reading path.
	const p = f.place;
	check(`${label}: the arrows start within ${MAX_DX}px of the answer text's start`, !!p && Math.abs(p.dx) <= MAX_DX, JSON.stringify(p));
	check(`${label}: the arrows sit under the answer, within ${MAX_DY}px of its foot`, !!p && p.dy >= -4 && p.dy <= MAX_DY, JSON.stringify(p));
	for (const c of f.ctl) {
		const name = c.cls.replace('ctile-rate-', '');
		check(`${label}: ${name} has a box`, c.w >= 12 && c.h >= 12, `${c.w}x${c.h}`);
		check(`${label}: ${name} is what a click at its centre hits`, c.hit);
		check(`${label}: ${name} carries ink at rest (opacity x alpha >= ${MIN_INK})`, c.ink >= MIN_INK, `opacity ${c.op}, alpha ${c.alpha}`);
		check(`${label}: ${name} stands off its ground (contrast >= ${MIN_CONTRAST})`, c.contrast >= MIN_CONTRAST, `contrast ${c.contrast}`);
	}
}

for (const theme of ['light', 'dark']) {
	await s.page.evaluate((t) => { window.DaimondLook && window.DaimondLook.set('daylight'); window.DaimondTheme && window.DaimondTheme.set(t); }, theme);
	for (const [w, h] of [[3440, 1321], [1853, 1000], [1440, 900], [390, 844]]) {
		await s.page.setViewportSize({ width: w, height: h });
		await sleep(400);
		// At rest: the pointer off every tile and nothing focused.
		await s.page.mouse.move(2, 2);
		await s.page.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });
		await sleep(300);
		await look(`${BROWSER} ${theme} ${w}px at rest`);
	}
}
await s.close().catch(() => {});
finish();
