// playwright-core lives outside the repo and is resolved by path, exactly as
// dev/harness.mjs resolves it.
import os from 'node:os';
import path from 'node:path';
const { chromium } = await import(process.env.PW_CORE
	|| path.join(os.homedir(), '.red-pw/node_modules/playwright-core/index.mjs'));
const b = await chromium.launch({ executablePath: process.env.PW_CHROME
	|| `${process.env.HOME}/.cache/ms-playwright/chromium-1229/chrome-linux64/chrome` });
const p = await b.newPage();
const svg = await import('node:fs').then(m => m.readFileSync(
	'/home/jason/usr/code/web/apps/oxedyne/daimond/www/assets/made_by_oxedyne.svg', 'utf8'));
await p.setContent(`<body style="margin:0">${svg}</body>`);
const out = await p.evaluate(() => {
	// RENDERED pixels, not user units: getBBox() ignores every ancestor transform,
	// and this artwork is built from transformed groups, so its numbers land far
	// outside the viewBox and mean nothing. getBoundingClientRect() is what the
	// eye sees.
	const svg = document.querySelector('svg');
	svg.setAttribute('height', '100');
	svg.removeAttribute('width');
	const plate = svg.getBoundingClientRect();
	const mid = plate.x + plate.width / 2;
	const union = (pred) => {
		let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, n = 0;
		for (const el of svg.querySelectorAll('path,rect,circle,polygon,ellipse,line')) {
			const r = el.getBoundingClientRect();
			if (r.width < 0.2 && r.height < 0.2) continue;
			if (!pred(r)) continue;
			n++;
			x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y);
			x1 = Math.max(x1, r.right); y1 = Math.max(y1, r.bottom);
		}
		return { n, w: +(x1 - x0).toFixed(1), h: +(y1 - y0).toFixed(1) };
	};
	return {
		plate: { w: +plate.width.toFixed(1), h: +plate.height.toFixed(1) },
		ai: union(r => r.x + r.width / 2 > mid),
		ox: union(r => r.x + r.width / 2 <= mid),
	};
});
console.log(JSON.stringify(out, null, 1));
await b.close();
