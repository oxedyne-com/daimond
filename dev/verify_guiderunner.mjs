// verify_guiderunner.mjs — the User Guide's runner page, rendered rather than read.
//
// The runner is the one feature whose failure modes are things a person has to
// walk over to a machine and fix, so the page that says so has to be reachable,
// legible and accurate. A guide page can be wrong in four ways that reading the
// markup will not catch, and this drives each of them against a real browser:
//
//   a. IT SERVES, in the app's own palette, dressed by frame.js standalone --
//      the guide is framed inside a sandboxed frame with no same-origin, so a
//      page that only works when the app dresses it is a page that does not work;
//   b. IT IS REACHABLE. The nav marks it current, and BOTH the guide index and
//      the sync page link to it from their body text -- a page reachable only
//      from the nav is a page nobody finds from the topic that sends them there;
//   c. NOTHING OVERFLOWS, at desktop and at phone width. The guide is read on a
//      phone more than anywhere else;
//   d. EVERY LOCAL LINK IT NAMES IS ON THE DISK, and the search index carries
//      its sections -- a stale index answers confidently about a page that has
//      changed underneath it.
//
// It also asserts the two blockers are actually written down, by name: a folder
// permission waiting for a click, and a runner left locked by a reload. Those
// are the two the code cannot fix and the owner has to know about, so a page
// that quietly dropped them would be worse than no page.
//
//   node dev/verify_guiderunner.mjs        # with dev/serve.mjs up
//
// Needs dev/serve.mjs (DAIMOND_PORT, default 8777). No gateway, no mock LLM.
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PW = path.join(os.homedir(), '.red-pw/node_modules/playwright-core/index.mjs');
const { chromium } = await import(pathToFileURL(PW).href);
const CHROME = `${process.env.HOME}/.cache/ms-playwright/chromium-1229/chrome-linux64/chrome`;
const APP = process.env.DAIMOND_APP || `http://localhost:${process.env.DAIMOND_PORT || 8777}`;
const SHOTS = new URL('shots/', import.meta.url).pathname;

const ok = [], bad = [];
const check = (pass, what, detail) => {
	(pass ? ok : bad).push(what);
	console.log((pass ? '  ok   ' : '  FAIL ') + what + (!pass && detail ? ' — ' + detail : ''));
};

const browser = await chromium.launch({ executablePath: CHROME });

for (const vp of [{ width: 1200, height: 900 }, { width: 390, height: 844 }]) {
	const w = vp.width + 'px';
	const page = await browser.newPage({ viewport: vp });
	const errs = [];
	page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
	page.on('pageerror', (e) => errs.push(String(e)));
	const resp = await page.goto(`${APP}/guide/runner.html`, { waitUntil: 'networkidle' });
	check(resp.status() === 200, `${w}: the page serves 200`, 'status ' + resp.status());
	check(errs.length === 0, `${w}: no console errors`, errs.join(' | '));

	const st = await page.evaluate(() => {
		const cs = getComputedStyle(document.body);
		const doc = document.documentElement;
		let overflow = 0;
		document.querySelectorAll('main *').forEach((el) => {
			if (el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).overflowX === 'visible') overflow++;
		});
		return {
			h1: (document.querySelector('h1') || {}).textContent,
			theme: doc.getAttribute('data-theme'), ink: doc.getAttribute('data-ink'),
			bg: cs.backgroundColor,
			navCurrent: (document.querySelector('[aria-current="page"]') || {}).textContent,
			h2s: [...document.querySelectorAll('main h2')].map((h) => h.id),
			links: [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')),
			hscroll: doc.scrollWidth > doc.clientWidth + 2,
			overflow,
			text: (document.querySelector('main') || {}).textContent || '',
		};
	});
	check(st.h1 === 'The runner', `${w}: the heading is the page`, st.h1);
	check(!!st.theme && !!st.ink, `${w}: frame.js dressed it standalone (${st.theme}/${st.ink})`);
	check(st.bg !== 'rgba(0, 0, 0, 0)', `${w}: it wears a real palette from the app's stylesheet`, st.bg);
	check(st.navCurrent === 'The runner', `${w}: the nav marks this page current`, st.navCurrent);
	check(st.h2s.length >= 6 && st.h2s[0] === 's1',
		`${w}: the sections carry positional ids`, st.h2s.join(','));
	check(!st.hscroll, `${w}: the page does not scroll sideways`);
	check(st.overflow === 0, `${w}: nothing overflows its box`, 'n=' + st.overflow);

	// The two things the code cannot fix, which is the whole reason for the page.
	check(/folder permission/i.test(st.text), `${w}: it names the folder-permission blocker`);
	check(/locked/i.test(st.text) && /reload/i.test(st.text),
		`${w}: it names the locked-after-reload blocker`);
	// And the three-step fallback, in order.
	const iRunner = st.text.indexOf('The runner'), iDesk = st.text.indexOf('Another awake desktop');
	const iLocal = st.text.indexOf('The device you are on');
	check(iRunner >= 0 && iDesk > iRunner && iLocal > iDesk,
		`${w}: the fallback order reads runner, other desktop, here`,
		`${iRunner}/${iDesk}/${iLocal}`);
	check(/Memory Saver/.test(st.text) && /minimised/.test(st.text),
		`${w}: it says Memory Saver must be off and the window not minimised`);
	check(/daimond-runner/.test(st.text) && /systemd/.test(st.text),
		`${w}: it names the service the launcher installs`);

	if (vp.width === 1200) {
		const local = [...new Set(st.links.filter((h) => h && !/^(https?:|mailto:|#)/.test(h)))];
		for (const h of local) {
			const r = await page.request.get(new URL(h, `${APP}/guide/`).href);
			check(r.status() === 200, `the link ${h} is a file on the disk`, 'status ' + r.status());
		}
		const ix = await page.evaluate(() => {
			const raw = window.GUIDE_INDEX;
			const list = Array.isArray(raw) ? raw
				: (raw && typeof raw === 'object' ? Object.values(raw).flat() : []);
			return list.filter((s) => s && /runner\.html/.test(JSON.stringify(s))).length;
		});
		check(ix >= 6, 'the search index carries the page\'s sections', 'sections=' + ix);
		try { await page.screenshot({ path: path.join(SHOTS, 'guide-runner.png'), fullPage: true }); }
		catch (e) { /* the shots directory is not a gate */ }
	}
	await page.close();
}

// b. Reachable from the topic that sends a reader here, not only from the nav.
{
	const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
	for (const [from, name] of [['sync.html', 'Cross-device sync'], ['index.html', 'Getting started']]) {
		await page.goto(`${APP}/guide/${from}`, { waitUntil: 'networkidle' });
		const n = await page.evaluate(() =>
			[...document.querySelectorAll('main a[href="runner.html"]')].length);
		check(n >= 1, `${name} links to the runner page from its body`, 'n=' + n);
	}
	await page.close();
}

await browser.close();
console.log('\n' + ok.length + ' ok, ' + bad.length + ' failed');
if (bad.length) { bad.forEach((b) => console.log('  failed: ' + b)); process.exit(1); }
console.log('all guide runner checks passed');
