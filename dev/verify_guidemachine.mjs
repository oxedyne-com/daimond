// verify_guidemachine.mjs — the Machine Operations page, rendered.
//
// Three questions a static read of the markup cannot answer, and one that a
// grep can but should not have to:
//
//   1. Does the page scroll sideways at a phone width? A guide page full of
//      shell commands is the one most likely to, because a <pre> has no soft
//      wrap and a long command line is wider than a phone.
//   2. Does every code block keep its own overflow to itself? The rule is that
//      a long line scrolls INSIDE its box; a box that hands the overflow to the
//      document has not done its job.
//   3. Does it wear a real palette in both a light and a dark one? The page is
//      served standalone here, so frame.js dresses it from the OS preference,
//      and both are exercised.
//
// It also asserts the page is reachable from every other guide page and that
// every link out of it resolves, because a page nobody can navigate to is a
// page nobody reads.
//
//   node dev/verify_guidemachine.mjs
//
// Needs dev/serve.mjs (DAIMOND_PORT, default 8777). No gateway, no model, no extension.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PW = path.join(os.homedir(), '.red-pw/node_modules/playwright-core/index.mjs');
const { chromium } = await import(pathToFileURL(PW).href);
const CHROME = `${process.env.HOME}/.cache/ms-playwright/chromium-1229/chrome-linux64/chrome`;
const OUT = path.join(os.homedir(), '.cache/daimond/guide-shots');
fs.mkdirSync(OUT, { recursive: true });

// The world's dev server -- see dev/world.sh.  Kept inline rather than imported,
// so this stays standalone and does not load the harness.
const BASE = (process.env.DAIMOND_APP || `http://localhost:${process.env.DAIMOND_PORT || 8777}`) + '/guide';
const PAGE = 'machine-operations.html';
/// Every other English page, each of which must link here.
const SIBLINGS = ['index.html', 'interface.html', 'models.html', 'chats-and-diamonds.html',
	'email-web-files.html', 'accounts.html', 'sync.html', 'spending.html'];
/// The widths that matter: a phone, a narrow window, and a desktop column.
const WIDTHS = [360, 480, 900, 1280];

let bad = 0;
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) bad++; };

const browser = await chromium.launch({ executablePath: CHROME });

// ── The page itself, at every width, in both palettes ────────────────
for (const scheme of ['light', 'dark']) {
	const ctx = await browser.newContext({ colorScheme: scheme });
	const page = await ctx.newPage();
	for (const width of WIDTHS) {
		await page.setViewportSize({ width, height: 900 });
		const r = await page.goto(`${BASE}/${PAGE}`, { waitUntil: 'networkidle' });
		check(!!r && r.ok(), `${scheme} ${width}px: HTTP ${r ? r.status() : '?'}`);

		const found = await page.evaluate(() => {
			const out = { problems: [], theme: null, bg: '', fg: '', pres: 0 };
			const root = document.documentElement;
			out.theme = root.getAttribute('data-theme');
			const cs = getComputedStyle(document.body);
			out.bg = cs.backgroundColor;
			out.fg = cs.color;
			// The document must not scroll sideways, whatever is inside it.
			if (root.scrollWidth > root.clientWidth + 1) {
				out.problems.push(`page scrolls horizontally (${root.scrollWidth} > ${root.clientWidth})`);
			}
			// A code block may scroll inside itself and must not be wider than
			// the column it sits in.
			for (const pre of document.querySelectorAll('pre')) {
				out.pres++;
				const r = pre.getBoundingClientRect();
				if (r.right > root.clientWidth + 1 || r.left < -1) {
					out.problems.push(`<pre> out of the column: ${r.left.toFixed(0)}..${r.right.toFixed(0)} vs 0..${root.clientWidth}`);
				}
				if (getComputedStyle(pre).overflowX !== 'auto' && getComputedStyle(pre).overflowX !== 'scroll') {
					out.problems.push(`<pre> does not keep its overflow: overflow-x is ${getComputedStyle(pre).overflowX}`);
				}
			}
			// Anything else whose text is clipped by its own box.
			for (const el of document.querySelectorAll('.ui, kbd, code, th, td, .card, .note, figcaption')) {
				if (el.closest('pre')) continue;
				if (el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).overflow !== 'visible') {
					out.problems.push(`clipped: <${el.tagName.toLowerCase()}> ${JSON.stringify(el.textContent.trim().slice(0, 40))}`);
				}
			}
			return out;
		});
		check(found.problems.length === 0,
			`${scheme} ${width}px: nothing overflows${found.problems.length ? ' — ' + found.problems.join('; ') : ''}`);
		if (width === WIDTHS[0]) {
			check(!!found.theme && found.bg !== 'rgba(0, 0, 0, 0)',
				`${scheme}: frame.js dressed it standalone (${found.theme}, bg ${found.bg})`);
			check(found.pres >= 5, `${scheme}: the shell blocks are present (${found.pres})`);
		}
		await page.screenshot({
			path: path.join(OUT, `machine-operations-${scheme}-${width}.png`),
			fullPage: width === 900,
		});
	}
	await ctx.close();
}

// ── Navigation, both ways ────────────────────────────────────────────
const ctx = await browser.newContext();
const page = await ctx.newPage();
for (const sib of SIBLINGS) {
	await page.goto(`${BASE}/${sib}`, { waitUntil: 'domcontentloaded' });
	const n = await page.evaluate((p) =>
		document.querySelectorAll(`a[href="${p}"]`).length, PAGE);
	check(n >= 2, `${sib} links to it from the header and the footer (${n})`);
}
await page.goto(`${BASE}/${PAGE}`, { waitUntil: 'domcontentloaded' });
const links = await page.evaluate(() =>
	[...document.querySelectorAll('main a[href], header a[href], footer a[href]')]
		.map(a => a.getAttribute('href'))
		.filter(h => h && !h.startsWith('#') && !h.startsWith('http')));
for (const href of [...new Set(links)]) {
	const r = await page.request.get(new URL(href, `${BASE}/${PAGE}`).href);
	check(r.ok(), `link resolves: ${href} (${r.status()})`);
}

await browser.close();
console.log(`\n${bad ? `${bad} FAILED` : 'all good'} — shots in ${OUT}`);
process.exit(bad ? 1 : 0);
