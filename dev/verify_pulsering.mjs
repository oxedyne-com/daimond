// gateway: none
// verify_pulsering.mjs -- the icons' pulse ring is cut to its own icon (TABMEM-GLOW).
//
// THE DEFECT. TAB-MEM-5D drew the lens's and the sync icon's pulse on a `.pulse-ring` span whose
// clip and pieces were fixed for a 34x34 r8 icon. Under the daylight skin the head row makes every
// button 30px tall, so the lens is 34x30 and its glow sat 4px low (TRAIN-20's proof, live page
// 7da997347290).
//
// WHAT IS CHECKED, on a real boot at 1440x900, lens on and sync icon pulsing, light and dark: with
// the pieces held at full spread and the ring held opaque, the pixels the ring changes
//   1. reach exactly the icon's border box grown by the old shadow's spread, on all four sides,
//      to within half a pixel (read at 4 device pixels per CSS pixel);
//   2. never fall inside the icon (the old shadow drew only outside it);
//   3. leave no gap at the icon's rounded corners (a pixel out from each corner's curve is drawn).
//
//   node dev/verify_pulsering.mjs
import { open } from './harness.mjs';
import { guardRan } from './verdict.mjs';

const D   = 5;		// the old box-shadow's full spread, the look this ring stands in for
const DSF = 4;		// device pixels per CSS pixel, so half a pixel is two of them
const TOL = 0.5;	// px
const PAD = 10;		// px of margin shot round each icon

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' -- ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' -- ' + detail : ''));
};

const s = await open({ name: 'pulsering', connect: false, route: (pg) => pg.setViewportSize({ width: 1440, height: 900 }) });
const p = s.page;
const cdp = await p.context().newCDPSession(p);
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: DSF, mobile: false });
await p.waitForTimeout(2000);
await p.evaluate(() => {
	DEBUG_SHARE.setEnabled(true);
	document.getElementById('sync-ico').classList.add('on');
});
await p.waitForSelector('.ds-indicator .pulse-ring', { timeout: 5000 });
await p.waitForTimeout(500);

// Every ring animation held: the pieces at mid-cycle (full spread), the fade at its start (opaque).
const hold = (sel) => p.evaluate((sel) => {
	const n = document.querySelector(sel);
	for (const a of n.getAnimations({ subtree: true })) {
		if (!/^pulse-ring/.test(a.animationName)) continue;
		a.pause();
		a.currentTime = a.animationName === 'pulse-ring' ? 0 : 800;
	}
	const r = n.getBoundingClientRect();
	return { x: r.left, y: r.top, w: r.width, h: r.height, rad: parseFloat(getComputedStyle(n).borderTopLeftRadius) };
}, sel);
const ringShown = (sel, on) => p.evaluate(([sel, on]) => { document.querySelector(sel + ' .pulse-ring').style.visibility = on ? '' : 'hidden'; }, [sel, on]);

// The box of the device pixels that differ between two shots (> 8 of 255 on any channel), in CSS px.
const diffBox = (a, b) => p.evaluate(async ([a, b]) => {
	const load = (u) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = u; });
	const [A, B] = await Promise.all([load(a), load(b)]);
	const px = (i) => { const c = document.createElement('canvas'); c.width = i.width; c.height = i.height; const x = c.getContext('2d'); x.drawImage(i, 0, 0); return x.getImageData(0, 0, i.width, i.height).data; };
	const P = px(A), Q = px(B);
	let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
	const hit = [];
	for (let y = 0; y < A.height; y++) for (let x = 0; x < A.width; x++) {
		const j = 4 * (y * A.width + x);
		if (Math.max(Math.abs(P[j] - Q[j]), Math.abs(P[j + 1] - Q[j + 1]), Math.abs(P[j + 2] - Q[j + 2])) <= 8) continue;
		if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y;
		hit.push(x, y);
	}
	return { x0, y0, x1: x1 + 1, y1: y1 + 1, hit, w: A.width, h: A.height };
}, ['data:image/png;base64,' + a.toString('base64'), 'data:image/png;base64,' + b.toString('base64')]);

for (const theme of ['light', 'dark']) {
	await p.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
	await p.waitForTimeout(200);
	// Both held before either is shot: the two sit 4px apart, so each one's ring reaches into the other's shot.
	const icons = [['lens', '#ds-indicator'], ['sync', '#sync-ico']];
	const geo = {};
	for (const [, sel] of icons) geo[sel] = await hold(sel);
	for (const [name, sel] of icons) {
		const tag = `${theme} ${name}`;
		const g = geo[sel];
		const clip = { x: Math.floor(g.x) - PAD, y: Math.floor(g.y) - PAD, width: Math.ceil(g.w) + 2 * PAD + 1, height: Math.ceil(g.h) + 2 * PAD + 1 };
		const ox = g.x - clip.x, oy = g.y - clip.y;		// the icon's corner in the shot, CSS px
		await ringShown(sel, true);
		const on = await p.screenshot({ clip, animations: 'allow' });
		await ringShown(sel, false);
		const off = await p.screenshot({ clip, animations: 'allow' });
		await ringShown(sel, true);
		const d = await diffBox(on, off);
		const f = clip.width / d.w;		// CSS px per device pixel of the shot
		const box = { l: d.x0 * f - ox, t: d.y0 * f - oy, r: d.x1 * f - ox - g.w, b: d.y1 * f - oy - g.h };
		const side = { left: -box.l - D, top: -box.t - D, right: box.r - D, bottom: box.b - D };
		console.log(`  ${tag}: icon ${g.w}x${g.h} r${g.rad}, ring reach beyond the icon l${(-box.l).toFixed(2)} t${(-box.t).toFixed(2)} r${box.r.toFixed(2)} b${box.b.toFixed(2)}`);
		check(`${tag}: the ring reaches the icon's box plus ${D}px on every side, within ${TOL}px`,
			d.x1 > 0 && Object.values(side).every((e) => Math.abs(e) <= TOL),
			Object.entries(side).map(([k, e]) => k + (e >= 0 ? '+' : '') + e.toFixed(2)).join(' '));
		// Inside the icon, short of its rounded corners and a pixel of antialiased edge.
		let inside = 0;
		for (let j = 0; j < d.hit.length; j += 2) {
			const x = (d.hit[j] + .5) * f - ox, y = (d.hit[j + 1] + .5) * f - oy, m = 1;
			const cx = Math.min(Math.max(x, g.rad), g.w - g.rad), cy = Math.min(Math.max(y, g.rad), g.h - g.rad);
			if (Math.hypot(x - cx, y - cy) <= g.rad - m && x > m && y > m && x < g.w - m && y < g.h - m) inside++;
		}
		check(`${tag}: the ring draws nothing inside the icon`, inside === 0, `${inside} device px`);
		const drawn = new Set();
		for (let j = 0; j < d.hit.length; j += 2) drawn.add(d.hit[j] + ',' + d.hit[j + 1]);
		const k = (g.rad + 1) / Math.SQRT2;		// a pixel out from the corner's curve, on its diagonal
		const gaps = [[g.rad - k, g.rad - k], [g.w - g.rad + k, g.rad - k], [g.rad - k, g.h - g.rad + k], [g.w - g.rad + k, g.h - g.rad + k]]
			.filter(([x, y]) => !drawn.has(Math.floor((x + ox) / f) + ',' + Math.floor((y + oy) / f)));
		check(`${tag}: no gap at the icon's rounded corners`, gaps.length === 0, `${gaps.length} of 4 corners undrawn`);
	}
}

await s.close();
guardRan(ok.length + bad.length);
console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) console.log('FAILED:\n  ' + bad.join('\n  '));
process.exit(bad.length ? 1 : 0);
