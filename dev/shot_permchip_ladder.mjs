// shot_permchip_ladder.mjs — the same chip at several nudges, 8x, stacked.
//
// The numbers in shot_permchip.mjs say where each band is; they cannot say which
// band looks right, and that is a judgement that has to be made by looking. This
// renders the chip at a ladder of offsets, magnifies each nearest-neighbour, and
// stacks them with their values, for each of the three labels in turn.
//
//   node dev/shot_permchip_ladder.mjs      → dev/shots/permchip-ladder.png
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, chat } from './harness.mjs';

const HERE  = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(HERE, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const NUDGES = [-0.5, 0, 0.25, 0.5, 1];
const LABELS = ['Guarded', 'Bypass', 'Ask every time'];

const s = await open({ name: 'permladder' });
const p = s.page;
await chat(s, '@text hello');

const shots = [];
for (const label of LABELS) {
	for (const n of NUDGES) {
		await p.evaluate(({ label, n }) => {
			document.getElementById('hand-mode-chip-txt').textContent = label;
			document.querySelector('.mode-chip-dot').style.transform = `translateY(${n}px)`;
		}, { label, n });
		await p.waitForTimeout(80);
		shots.push({ label, n, png: (await p.locator('#hand-mode-chip').screenshot()).toString('base64') });
	}
}
// Put the chip back the way the stylesheet has it.
await p.evaluate(() => {
	document.querySelector('.mode-chip-dot').style.transform = '';
	document.getElementById('hand-mode-chip-txt').textContent = 'Guarded';
});

await p.evaluate(async (shots) => {
	const imgs = [];
	for (const s of shots) {
		const im = new Image();
		await new Promise((res) => { im.onload = res; im.src = 'data:image/png;base64,' + s.png; });
		imgs.push(im);
	}
	const S = 8, PAD = 10, LAB = 130;
	const w = LAB + Math.max(...imgs.map(i => i.width)) * S + PAD * 2;
	const h = imgs.reduce((a, i) => a + i.height * S + PAD, PAD);
	const c = document.createElement('canvas');
	c.id = '__ladder'; c.width = w; c.height = h;
	c.style.cssText = 'position:fixed;left:0;top:0;z-index:99999;';
	const g = c.getContext('2d');
	g.imageSmoothingEnabled = false;
	g.fillStyle = '#606060'; g.fillRect(0, 0, w, h);
	let y = PAD;
	imgs.forEach((im, i) => {
		g.drawImage(im, LAB, y, im.width * S, im.height * S);
		g.fillStyle = '#fff'; g.font = '16px monospace';
		g.fillText(`${shots[i].n >= 0 ? '+' : ''}${shots[i].n}px`, 8, y + 24);
		g.fillText(shots[i].label.slice(0, 9), 8, y + 44);
		// A hairline through the middle of each strip, so the eye has a datum.
		y += im.height * S + PAD;
	});
	document.body.appendChild(c);
}, shots);
await p.locator('#__ladder').screenshot({ path: path.join(SHOTS, 'permchip-ladder.png') });
await s.close();
console.log('wrote dev/shots/permchip-ladder.png');
