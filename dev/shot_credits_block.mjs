// shot_credits_block.mjs — the provider credit block, in every theme and both skins.
//
// The block (`.models-credit` and its line, form and input) is rendered by models.js inside each
// expanded provider and had no CSS rules at all: an unstyled div, an unstyled full-width text
// input at browser defaults, sitting inside a panel built entirely from tokens. It is a thing to
// LOOK at rather than assert on, so this exists to be looked at.
//
// Every combination is shot because the block is styled from tokens alone -- no overrides -- and
// the claim that makes is that it follows the theme and the skin for free. A picture per
// combination is the only way to see whether that held.
import { open } from './harness.mjs';
import path from 'node:path';
import fs from 'node:fs';

const OUT = path.join(process.cwd(), 'dev', 'shots');
fs.mkdirSync(OUT, { recursive: true });

const s = await open({ name: 'creditshot' });
const p = s.page;
await p.waitForTimeout(1200);

// Open the Models panel from the rail row that counts them, and expand the one provider there is.
await p.evaluate(() => { document.getElementById('astat-model').click(); });
await p.waitForTimeout(800);
await p.evaluate(() => {
	const h = document.querySelector('.models-prov-head');
	if (h) h.click();
});
await p.waitForTimeout(600);

// A manual base, so the block is in its wordiest state: the sentence that names the base, the
// estimated spend since and the date it was stated, plus the field and the update button.
await p.evaluate(() => {
	const inp = document.querySelector('.models-credit-input');
	if (!inp) return;
	inp.value = '20';
	const btn = inp.parentElement.querySelector('button');
	if (btn) btn.click();
});
await p.waitForTimeout(700);

const present = await p.evaluate(() => {
	const w = document.querySelector('.models-credit');
	if (!w) return null;
	const cs = getComputedStyle(w);
	const inp = document.querySelector('.models-credit-input');
	return {
		line:   (w.querySelector('.models-credit-line') || {}).textContent || '',
		border: cs.borderTopWidth + ' ' + cs.borderTopColor,
		bg:     cs.backgroundColor,
		inputW: inp ? Math.round(inp.getBoundingClientRect().width) : 0,
		inputFs: inp ? getComputedStyle(inp).fontSize : '',
	};
});
console.log('credit block:', JSON.stringify(present));

for (const skin of ['sharp', 'warm']) {
	await p.evaluate((sk) => { if (window.DaimondSkin) DaimondSkin.set(sk); }, skin);
	for (const theme of ['dark', 'light', 'lollypop']) {
		await p.evaluate((th) => window.DaimondTheme.set(th), theme);
		await p.waitForTimeout(350);
		const box = await p.evaluate(() => {
			const w = document.querySelector('.models-credit');
			if (!w) return null;
			const r = w.getBoundingClientRect();
			return { x: Math.max(0, r.x - 12), y: Math.max(0, r.y - 12), width: r.width + 24, height: r.height + 24 };
		});
		const file = path.join(OUT, `credits-block-${skin}-${theme}.png`);
		let err = '';
		await p.screenshot({ path: file, clip: box || undefined, timeout: 8000 })
			.catch((e) => { err = String(e && e.message ? e.message : e).split('\n')[0]; });
		console.log('  →', file, err ? 'FAILED: ' + err : '');
	}
}

await s.close();
