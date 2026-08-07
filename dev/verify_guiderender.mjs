// The translated guide pages, rendered: does any text spill out of the box it
// was drawn for? The French translator flagged the interface diagram -- its
// labels are longer in every language than in English, and arithmetic on a font
// size is not a rendering.
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const PW = path.join(os.homedir(), '.red-pw/node_modules/playwright-core/index.mjs');
const { chromium } = await import(pathToFileURL(PW).href);
const CHROME = `${process.env.HOME}/.cache/ms-playwright/chromium-1229/chrome-linux64/chrome`;
const SP = new URL('shots/', import.meta.url).pathname;
// The world's dev server -- see dev/world.sh.  Kept inline rather than imported,
// so this stays standalone and does not load the harness.
const APP = process.env.DAIMOND_APP || `http://localhost:${process.env.DAIMOND_PORT || 8777}`;

const LOCS = ['de', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'zh-Hans'];
const PAGES = ['index.html', 'interface.html', 'models.html', 'chats-and-diamonds.html',
	'email-web-files.html', 'accounts.html', 'sync.html', 'spending.html'];

const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
let bad = 0, checked = 0;
const problems = [];

for (const loc of LOCS) {
	for (const p of PAGES) {
		const url = `${APP}/guide/${loc}/${p}`;
		const r = await page.goto(url, { waitUntil: 'networkidle' });
		if (!r || !r.ok()) { problems.push(`${loc}/${p}: HTTP ${r ? r.status() : '?'}`); bad++; continue; }
		checked++;
		const found = await page.evaluate(() => {
			const out = [];
			// The page itself must not scroll sideways.
			if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 1) {
				out.push(`page scrolls horizontally (${document.documentElement.scrollWidth} > ${document.documentElement.clientWidth})`);
			}
			// SVG text drawn outside its own diagram's viewBox.
			for (const svg of document.querySelectorAll('svg')) {
				const vb = svg.viewBox && svg.viewBox.baseVal;
				if (!vb || !vb.width) continue;
				for (const t of svg.querySelectorAll('text')) {
					let b; try { b = t.getBBox(); } catch (e) { continue; }
					if (b.x < vb.x - 0.5 || b.x + b.width > vb.x + vb.width + 0.5) {
						out.push(`svg text out of frame: ${JSON.stringify(t.textContent.trim().slice(0, 40))} (x ${b.x.toFixed(0)}..${(b.x + b.width).toFixed(0)} vs ${vb.x}..${vb.x + vb.width})`);
					}
				}
			}
			// Any element whose text overflows its own box horizontally.
            for (const el of document.querySelectorAll('.ui, kbd, th, td, .card, .note, figcaption')) {
                if (el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).overflow !== 'visible') {
                    out.push(`clipped: <${el.tagName.toLowerCase()} class="${el.className}"> ${JSON.stringify(el.textContent.trim().slice(0, 40))}`);
                }
            }
			return out;
		});
		if (found.length) { problems.push(`${loc}/${p}:\n    ` + found.join('\n    ')); bad += found.length; }
	}
}

console.log(`rendered ${checked} translated pages`);
if (problems.length) { console.log('\n' + problems.join('\n')); }
console.log(bad ? `\n${bad} PROBLEMS` : '\nNO OVERFLOW ANYWHERE');
await page.goto(`${APP}/guide/ja/interface.html`, { waitUntil: 'networkidle' });
await page.screenshot({ path: `${SP}/guide-ja-interface.png`, fullPage: false });
await browser.close();
