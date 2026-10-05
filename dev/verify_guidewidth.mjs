// gateway: none
// verify_guidewidth.mjs -- does any guide page scroll sideways on a phone?
//
// Found by the dead-controls crawl (D-20261003-07): `.ui { white-space: nowrap }` made a pill
// ("Haben Sie einen Passcode oder einen Kopplungscode?", 384 px) wider than the 358 px column,
// so the front pages of de, es, fr, ja and pt-BR were wider than the phone (de 453 px). On de, fr
// and ja the layout viewport moved with the overflow and a tap at a link's box landed elsewhere.
// verify_guiderender.mjs measures at 1100 px and so never saw it.
//
// Every page under www/guide is opened at 390 wide in a phone context (touch, mobile viewport,
// where an overflowing page widens the layout viewport rather than clipping), and the page's
// `scrollWidth` and `innerWidth` must both be no wider than the 390 px asked for.
//
//   node dev/verify_guidewidth.mjs                # the live tree
//   node dev/verify_guidewidth.mjs --width 360    # another phone
//   node dev/verify_guidewidth.mjs --break wide   # a 3000 px block in each page: expected to FAIL
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const PW = path.join(os.homedir(), '.red-pw/node_modules/playwright-core/index.mjs');
const { chromium } = await import(pathToFileURL(PW).href);
const CHROME = `${process.env.HOME}/.cache/ms-playwright/chromium-1229/chrome-linux64/chrome`;
// The world's dev server -- see dev/world.sh.  Kept inline rather than imported,
// so this stays standalone and does not load the harness.
const APP = process.env.DAIMOND_APP || `http://localhost:${process.env.DAIMOND_PORT || 8777}`;
const GUIDE = new URL('../www/guide', import.meta.url).pathname;

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? String(process.argv[i + 1] || '') : ''; };
const W = Number(arg('--width') || 390);
const BREAK = arg('--break');
if (BREAK && BREAK !== 'wide') { console.error(`unknown break '${BREAK}'; known: wide`); process.exit(2); }

// Every page the file system holds, so a page added later is measured without being listed here.
const pages = [];
const walk = (dir, rel) => {
	for (const f of fs.readdirSync(dir).sort()) {
		const p = path.join(dir, f);
		if (fs.statSync(p).isDirectory()) walk(p, rel + f + '/');
		else if (f.endsWith('.html')) pages.push('/guide/' + rel + f);
	}
};
walk(GUIDE, '');

const browser = await chromium.launch({ executablePath: CHROME });
const ctx = await browser.newContext({ viewport: { width: W, height: 845 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
const page = await ctx.newPage();
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

const wide = [], missing = [];
let checked = 0;
for (const u of pages) {
	const r = await page.goto(APP + u, { waitUntil: 'networkidle' });
	if (!r || !r.ok()) { missing.push(`${u}: HTTP ${r ? r.status() : '?'}`); continue; }
	checked++;
	const m = await page.evaluate((W) => {
		const de = document.documentElement;
		// The widest element, so the failure names what is to blame and not only the page.
		let worst = null;
		for (const e of document.body.querySelectorAll('*')) {
			const b = e.getBoundingClientRect();
			if (b.right > W + 0.5 && (!worst || b.right > worst.right)) {
				worst = { right: Math.round(b.right), tag: e.tagName.toLowerCase(), cls: e.className && e.className.baseVal === undefined ? String(e.className) : '', text: (e.textContent || '').trim().slice(0, 48) };
			}
		}
		return { scroll: Math.max(de.scrollWidth, document.body.scrollWidth), inner: innerWidth, worst };
	}, W);
	if (m.scroll > W || m.inner > W) {
		wide.push(`${u}: scrollWidth ${m.scroll}, innerWidth ${m.inner} (> ${W})` + (m.worst ? `; widest <${m.worst.tag}${m.worst.cls ? ' class="' + m.worst.cls + '"' : ''}> to ${m.worst.right}px ${JSON.stringify(m.worst.text)}` : ''));
	}
}
await browser.close();

let bad = 0;
const check = (what, pass, detail) => { console.log(`${pass ? '  ok   ' : '  FAIL '}${what}${detail ? ' -- ' + detail : ''}`); if (!pass) bad++; };
for (const w of wide) console.log('    ' + w);
check(`EVERY GUIDE PAGE IS SERVED -- ${pages.length} pages under www/guide`,
	missing.length === 0 && checked === pages.length,
	`${checked}/${pages.length} opened` + (missing.length ? '; missing: ' + missing.join(', ') : ''));
check(`AND NONE SCROLLS SIDEWAYS AT ${W} PX`, wide.length === 0, `${wide.length} of ${checked} pages wider than ${W}`);
console.log(`\n${2 - bad} passed, ${bad} failed`);
if (bad) process.exit(1);
