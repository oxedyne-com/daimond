// The translated guide page: does it wear the app's palette (which it now gets
// from the app's own stylesheet rather than a copy), and does a change of
// language actually move the reader to the translated page?
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const PW = path.join(os.homedir(), '.red-pw/node_modules/playwright-core/index.mjs');
const { chromium } = await import(pathToFileURL(PW).href);
const CHROME = `${process.env.HOME}/.cache/ms-playwright/chromium-1229/chrome-linux64/chrome`;
const SP = new URL('shots/', import.meta.url).pathname;

const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage({ viewport: { width: 900, height: 800 } });
let bad = 0;
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) bad++; };

// Standalone, no framer: frame.js must still dress it from the OS preference.
await page.goto('http://localhost:8777/guide/de/index.html', { waitUntil: 'networkidle' });
const st = await page.evaluate(() => {
	const r = document.documentElement;
	const cs = getComputedStyle(document.body);
	return {
		lang: r.lang, loc: r.getAttribute('data-guide-locale'),
		locales: r.getAttribute('data-guide-locales'),
		theme: r.getAttribute('data-theme'), ink: r.getAttribute('data-ink'),
		bg: cs.backgroundColor, fg: cs.color,
		h1: (document.querySelector('h1') || {}).textContent,
	};
});
console.log(JSON.stringify(st, null, 1));
check(st.lang === 'de' && st.loc === 'de', 'the page declares itself German');
check(!!st.theme && !!st.ink, `frame.js dressed it standalone (${st.theme}/${st.ink})`);
check(st.bg !== 'rgba(0, 0, 0, 0)' && st.fg !== 'rgb(0, 0, 0)',
	`it wears a real palette from the app's stylesheet (bg=${st.bg} fg=${st.fg})`);
check(/[äöüßA-Za-z]/.test(st.h1 || '') && !/Getting started/.test(st.h1 || ''),
	`the heading is translated: ${JSON.stringify(st.h1)}`);

// A palette pushed in over the channel the app uses.
await page.evaluate(() => window.postMessage({ daimondGuide: 'style', theme: 'linen', scale: 1.2 }, '*'));
await page.waitForTimeout(200);
const dressed = await page.evaluate(() => {
	const r = document.documentElement;
	return { theme: r.getAttribute('data-theme'), tone: r.getAttribute('data-tone'),
		ink: r.getAttribute('data-ink'), scale: r.style.getPropertyValue('--fs-scale') };
});
check(dressed.theme === 'linen' && dressed.tone === 'light' && dressed.ink === 'dark' && dressed.scale === '1.2',
	`a palette arriving over the channel is worn whole: ${JSON.stringify(dressed)}`);

// A palette the guide has never heard of must be ignored, not half-applied.
await page.evaluate(() => window.postMessage({ daimondGuide: 'style', theme: 'not-a-palette' }, '*'));
await page.waitForTimeout(150);
const kept = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
check(kept === 'linen', `an unknown palette leaves the current one alone (${kept})`);

// The language change: English page, told the app is now German.
await page.goto('http://localhost:8777/guide/index.html', { waitUntil: 'networkidle' });
await page.evaluate(() => window.postMessage({ daimondGuide: 'style', locale: 'de' }, '*'));
await page.waitForTimeout(600);
check(/\/guide\/de\/index\.html$/.test(page.url()), `a German app moves the reader to the German page (${page.url()})`);

// And back.
await page.evaluate(() => window.postMessage({ daimondGuide: 'style', locale: 'en' }, '*'));
await page.waitForTimeout(600);
check(/\/guide\/index\.html$/.test(page.url()), `and back to English (${page.url()})`);

// A language with no page for this reader must NOT move them anywhere.
await page.evaluate(() => window.postMessage({ daimondGuide: 'style', locale: 'ko' }, '*'));
await page.waitForTimeout(500);
check(/\/guide\/index\.html$/.test(page.url()), `an untranslated language leaves them on English (${page.url()})`);

// Every link on the German page must resolve.
await page.goto('http://localhost:8777/guide/de/index.html', { waitUntil: 'networkidle' });
const links = await page.$$eval('a[href]', as => as.map(a => a.href).filter(h => h.startsWith('http')));
const dead = [];
for (const href of [...new Set(links)]) {
	const r = await page.request.get(href);
	if (!r.ok()) dead.push(`${href} -> ${r.status()}`);
}
check(dead.length === 0, `every link on the translated page resolves${dead.length ? `: ${dead.join(', ')}` : ` (${new Set(links).size} checked)`}`);

await page.screenshot({ path: `${SP}/guide-de-i18n.png`, fullPage: false });
console.log(bad ? `\n${bad} FAILED` : '\nALL PASS');
await browser.close();
process.exit(bad ? 1 : 0);
