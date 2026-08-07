// dev/shot_pptw.mjs — look at the three-part PPTW, at every state, in the
// places it is actually drawn.
//
// Not a verifier: an EYE. `verify_pausewidget` proves the arithmetic; this
// proves the thing is legible — that three controls fit a 220px rail tile, that
// a disabled verb reads as unavailable rather than as missing, and that the
// light is distinguishable from the buttons beside it at the size it ships at.
//
//   node dev/shot_pptw.mjs
//
// Needs a world: `bash dev/world.sh 0 --up`. No gateway, no model.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { open, newChat } from './harness.mjs';

const OUT = path.join(os.homedir(), '.cache/daimond/pptw-shots');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const s = await open({ name: 'pptw' });
const p = s.page;

await newChat(s);
// Two Diamonds, so a branch can be made genuinely mixed.
async function newDiamond(name) {
	await p.click('#new-diamond-btn', { force: true });
	await p.waitForSelector('.dlg-input', { timeout: 10000 });
	await p.fill('.dlg-input', name);
	await p.click('.dlg-ok', { force: true });
	await p.waitForTimeout(700);
}
await newDiamond('Alpha');
await newDiamond('Beta');
{
	const drawer = p.locator('#admin-close');
	if (await drawer.isVisible().catch(() => false)) { await drawer.click({ force: true }); await p.waitForTimeout(300); }
}

/// Crop tight on one element, at 8x, so the ink can be judged rather than
/// guessed at.
async function crop(sel, label, pad = 6) {
	const el = await p.$(sel);
	if (!el) { console.log(`(absent) ${label} — ${sel}`); return; }
	const b = await el.boundingBox();
	if (!b) { console.log(`(no box) ${label}`); return; }
	await p.screenshot({
		path: path.join(OUT, `${label}.png`),
		clip: { x: b.x - pad, y: b.y - pad, width: b.width + pad * 2, height: b.height + pad * 2 },
		scale: 'css',
	});
	console.log(`${label}  ${Math.round(b.width)}x${Math.round(b.height)} at ${Math.round(b.x)},${Math.round(b.y)}`);
}

/// What the page says about one control, read from the DOM rather than from a
/// picture: which verb is live, what each is called, and what the light says.
async function readControl(sel) {
	return p.evaluate((q) => {
		const g = document.querySelector(q);
		if (!g) return null;
		const lamp = g.querySelector('.pptw-lamp');
		return {
			node:  g.dataset.pauseNode,
			state: g.dataset.state,
			lamp:  lamp && lamp.getAttribute('aria-label'),
			lampFocusable: lamp ? lamp.tabIndex >= 0 : null,
			acts: [...g.querySelectorAll('.pptw-act')].map((b) => ({
				act: b.dataset.act, disabled: b.disabled, label: b.getAttribute('aria-label'),
			})),
		};
	}, sel);
}

const GLOBAL = '#pptw-global .pptw';
const TILE   = '.diamond-box .pptw';

for (const [what, setup] of [
	['running',   () => p.evaluate(() => DaimondPause.set('root', true))],
	['paused',    () => p.evaluate(() => DaimondPause.set('root', false))],
	['mixed',     () => p.evaluate(() => {
		DaimondPause.set('root', true);
		const b = document.querySelector('.diamond-box .pptw');
		if (b) DaimondPause.set(b.dataset.pauseNode, false);
	})],
]) {
	await setup();
	await p.waitForTimeout(250);
	await crop(GLOBAL, `global-${what}`);
	await crop(TILE, `tile-${what}`);
	await crop('.diamond-box', `diamondtile-${what}`, 2);
	console.log(what, 'global:', JSON.stringify(await readControl(GLOBAL)));
	console.log(what, 'tile:  ', JSON.stringify(await readControl(TILE)));
}

// The rail whole, and the rail at a phone width, which is where 60px of control
// beside a name either fits or does not.
await p.evaluate(() => DaimondPause.set('root', true));
await p.waitForTimeout(200);
await crop('.rail', 'rail-1500', 0);
await p.setViewportSize({ width: 380, height: 780 });
await p.waitForTimeout(500);
// The rail is the left drawer behind the hamburger on a phone; the tiles are
// only visible once it is open, and that is where 60px of control beside a name
// either fits or does not.
await p.click('#drawer-btn', { force: true }).catch(() => {});
await p.waitForTimeout(600);
await p.screenshot({ path: path.join(OUT, 'phone-380.png') });
await crop('.diamond-box', 'phone-tile', 2);
// The warm skin, which is the palette the tile dialog was clipped in.
await p.evaluate(() => document.documentElement.dataset.skin = 'warm');
await p.waitForTimeout(300);
await crop('.diamond-box', 'phone-tile-warm', 2);
await p.evaluate(() => document.documentElement.dataset.skin = 'sharp');
console.log('phone shots written');

// The tile dialog's Running section, and the trigger rows below it.
await p.setViewportSize({ width: 1500, height: 950 });
await p.waitForTimeout(400);
await p.click('.diamond-box .tile-cog', { force: true }).catch(() => {});
await p.waitForTimeout(700);
await crop('.tile-dlg-pause', 'dlg-running', 4);
// Add a triggered action so a trigger row has a control on it.
await p.click('.trig-add button', { force: true }).catch(() => {});
await p.waitForTimeout(700);
await crop('.trig-list', 'trig-list', 4);
await crop('.dlg-card', 'tile-dialog', 2);
const dlgOpen = await p.evaluate(() => !!document.querySelector('.dlg-card'));
const modalOver = await p.evaluate(() =>
	[...document.querySelectorAll('.dlg-card')].filter((c) => c.offsetParent !== null).length);
console.log('after + : dialogs on screen =', modalOver, '(1 means the editor did NOT open over it)');
await p.keyboard.press('Escape');
await p.waitForTimeout(400);

// Does anything overflow its row?
const over = await p.evaluate(() => {
	const out = [];
	for (const g of document.querySelectorAll('.pptw')) {
		const par = g.parentElement;
		if (!par) continue;
		const a = g.getBoundingClientRect(), b = par.getBoundingClientRect();
		if (a.right > b.right + 0.5 || a.left < b.left - 0.5) {
			out.push({ node: g.dataset.pauseNode, parent: par.className, over: Math.round(a.right - b.right) });
		}
	}
	return out;
});
console.log('overflow:', JSON.stringify(over));
console.log('page errors:', s.errs.length, s.errs.slice(0, 5));
console.log('shots in', OUT);
await s.close();
