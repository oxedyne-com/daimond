// shot_stack.mjs — the divider between two panels stacked in a dock column.
//
// The affordance is CSS-drawn (a 2px rule inside a 16px strip that stands in for
// the column's gap), so the only way to know it is right is to look at it at ink
// level. Four states, each cropped to the handle and blown up 8x:
//
//   rest  — nothing. Two cards with a gap between them, as before.
//   hover — the accent rule, the same answer .phandle gives on the vertical edges.
//   drag  — held, so the rule stays lit while the boundary moves.
//   after — the tuned boundary, reloaded from the saved layout.
//
// Plus the whole dock mid-drag, the same after a reload, and the phone, which
// must draw no divider at all.
//
//   node dev/shot_stack.mjs
//
// Needs dev/serve.mjs on :8777. No gateway.

import { open, signInAs } from './harness.mjs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const OUT = path.join(process.cwd(), 'dev', 'shots');
fs.mkdirSync(OUT, { recursive: true });

const s = await open({ name: 'stackshot', connect: false });
const p = s.page;
await p.waitForTimeout(1500);
await p.setViewportSize({ width: 1500, height: 950 });

await p.evaluate(() => {
	DaimondPanels.setGrid('auto');
	DaimondPanels.panels().filter((x) => x.zone === 'dock').forEach((x) => DaimondPanels.hide(x.id));
	['work', 'mail'].forEach((id) => DaimondPanels.show(id));
});
await p.waitForTimeout(600);

/// Where the divider is, in page coordinates.
const box = () => p.evaluate(() => {
	const h = document.querySelector('#dock .hstack');
	if (!h) return null;
	const r = h.getBoundingClientRect();
	return { x: r.x, y: r.y, width: r.width, height: r.height };
});

/// The handle and a little of the cards either side, at eight times size.
const ink = async (name) => {
	const b = await box();
	if (!b) { console.log(`  ${name}: no divider on screen`); return; }
	const clip = { x: Math.round(b.x), y: Math.round(b.y - 12), width: Math.round(b.width), height: Math.round(b.height + 24) };
	const raw = path.join(OUT, `stack-${name}-raw.png`);
	await p.screenshot({ path: raw, clip, timeout: 8000 });
	execFileSync('magick', [raw, '-filter', 'point', '-resize', '800%', path.join(OUT, `stack-${name}-8x.png`)]);
	fs.unlinkSync(raw);
	console.log(`  stack-${name}-8x.png  ${clip.width}x${clip.height} at 8x`);
};

// Rest.
await ink('rest');

// Hover.
{
	const b = await box();
	await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
	await p.waitForTimeout(250);
	await ink('hover');
}

// Held mid-drag: the pointer events are dispatched (headless Chromium drops
// mouse moves after a mousedown on a dock handle), and NOT released, so the
// lit state is what the screenshot catches.
{
	await p.evaluate(() => {
		const h = document.querySelector('#dock .hstack');
		const r = h.getBoundingClientRect();
		const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
		Element.prototype.setPointerCapture = function () {};
		Element.prototype.releasePointerCapture = function () {};
		const fire = (type, cy) => h.dispatchEvent(new PointerEvent(type, {
			bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, clientX: x, clientY: cy,
		}));
		fire('pointerdown', y);
		for (let k = 1; k <= 10; k++) fire('pointermove', y + Math.round(140 * k / 10));
	});
	await p.waitForTimeout(200);
	await ink('drag');
	await p.screenshot({ path: path.join(OUT, 'stack-mid-drag.png'), timeout: 8000 });
	await p.evaluate(() => {
		const h = document.querySelector('#dock .hstack');
		const r = h.getBoundingClientRect();
		h.dispatchEvent(new PointerEvent('pointerup', {
			bubbles: true, cancelable: true, pointerId: 1, isPrimary: true,
			clientX: Math.round(r.left + r.width / 2), clientY: Math.round(r.top + r.height / 2),
		}));
	});
	await p.waitForTimeout(200);
}

// The same boundary, built again from the markup.
await p.reload({ waitUntil: 'domcontentloaded' });
await signInAs(s, 'stackshot');
await p.waitForTimeout(2500);
await p.screenshot({ path: path.join(OUT, 'stack-after-reload.png'), timeout: 8000 });
await ink('after');
console.log('  heights after reload: ' + await p.evaluate(() =>
	[...document.querySelectorAll('#dock-a > .panel')].filter((k) => k.getClientRects().length)
		.map((k) => k.dataset.panel + ' ' + Math.round(k.getBoundingClientRect().height)).join(', ')));

// The phone, where there is no boundary to hold.
await p.setViewportSize({ width: 390, height: 780 });
await p.evaluate(() => DaimondPanels.reflow());
await p.waitForTimeout(600);
// On the Email destination, which is one of the two panels stacked on the
// desktop: full width, full height, and nothing above it to drag.
await p.evaluate(() => {
	const x = document.getElementById('admin-close');
	if (x) x.click();
	DaimondPanels.show('mail');
});
await p.waitForTimeout(600);
await p.screenshot({ path: path.join(OUT, 'stack-phone.png'), timeout: 8000 });
console.log('  dividers drawn on the phone: ' + await p.evaluate(() =>
	[...document.querySelectorAll('.hstack')].filter((h) => h.getClientRects().length).length));

await s.close();
