// The translated guide pages, rendered: does any text spill out of the box it
// was drawn for? The French translator flagged the interface diagram -- its
// labels are longer in every language than in English, and arithmetic on a font
// size is not a rendering.
//
// It counted its own problems all along and then exited 0, so the count reached
// nobody: `run_all.sh` reads the exit code. It exits on the count now, and it
// also insists that every page it was asked for actually answered 200 -- a
// locale served as 404 used to be one line in a list nobody was gated on.
//
// PROVED AGAINST A PAGE THAT DOES OVERFLOW FIRST. `--break wide` puts a
// 3000px-wide block into each page as it loads, which is exactly what a long
// label does, and the run is expected to FAIL.
//
//   node dev/verify_guiderender.mjs --break wide   # expected to FAIL
//   node dev/verify_guiderender.mjs                # and then, clean
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

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();
if (BREAK && !['wide', 'missing'].includes(BREAK)) {
	console.error(`unknown break '${BREAK}'; known: wide, missing`);
	process.exit(2);
}

// `missing` asks for a locale that was never built, which is what a translation
// dropped from the build looks like from here.
const LOCS = ['de', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'zh-Hans'].concat(BREAK === 'missing' ? ['xx'] : []);
const PAGES = ['index.html', 'interface.html', 'models.html', 'chats-and-diamonds.html',
	'email-web-files.html', 'accounts.html', 'sync.html', 'spending.html'];
const WANT = LOCS.length * PAGES.length;

const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
if (BREAK === 'wide') {
	await page.addInitScript(() => {
		const put = () => {
			const st = document.createElement('style');
			st.textContent = 'body::after { content: ""; display: block; width: 3000px; height: 2px; background: red; }';
			document.head.appendChild(st);
		};
		if (document.head) put(); else document.addEventListener('DOMContentLoaded', put);
	});
}
let checked = 0;
const missing = [], problems = [];

for (const loc of LOCS) {
	for (const p of PAGES) {
		const url = `${APP}/guide/${loc}/${p}`;
		const r = await page.goto(url, { waitUntil: 'networkidle' });
		if (!r || !r.ok()) { missing.push(`${loc}/${p}: HTTP ${r ? r.status() : '?'}`); continue; }
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
		if (found.length) problems.push(`${loc}/${p}:\n    ` + found.join('\n    '));
	}
}

await page.goto(`${APP}/guide/ja/interface.html`, { waitUntil: 'networkidle' });
await page.screenshot({ path: `${SP}/guide-ja-interface.png`, fullPage: false });
await browser.close();

if (problems.length) console.log('\n' + problems.join('\n') + '\n');
check(`EVERY TRANSLATED PAGE IS SERVED — ${LOCS.length} locales × ${PAGES.length} pages`,
	missing.length === 0 && checked === WANT,
	`${checked}/${WANT} rendered${missing.length ? '; missing: ' + missing.join(', ') : ''}`);
check('AND NOTHING SPILLS OUT OF THE BOX IT WAS DRAWN FOR',
	problems.length === 0, `${problems.length} pages with overflow`);

console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) { bad.forEach(x => console.log('  FAILED: ' + x)); process.exit(1); }
