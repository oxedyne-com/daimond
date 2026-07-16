// The grant flow, driven under the real extension (xvfb, headed). We cannot
// click Chrome's native permission bubble from a test — that is the known
// coverage gap — but we CAN confirm the grant WINDOW opens in front, names the
// site, and sets the expectation that Chrome will ask next. Run with:
//   xvfb-run -a -s "-screen 0 1400x900x24" node dev/verify_grant.mjs
import { open, errors } from './harness.mjs';
import path from 'node:path';

const EXT = path.resolve('ext');
const s = await open({ name: 'grant', headed: true, extension: EXT });

// Give the extension's announce content-script a moment to register.
await s.page.waitForTimeout(1500);
const hasExt = await s.page.evaluate(() =>
	!!(window.DaimondWeb) && new Promise(r => {
		// hasExt() is internal; probe by asking the panel to open and watching.
		r(true);
	}));

// Ask the panel to open a fresh site; with the extension present this triggers
// the grant window. Do not await (it blocks until the grant resolves).
s.page.evaluate(() => { try { window.DaimondWeb.open('https://example.com'); } catch (e) {} });

// Find the grant window among the context's pages.
let grant = null;
for (let i = 0; i < 30 && !grant; i++) {
	await s.page.waitForTimeout(300);
	for (const p of s.browser.pages()) {
		if (/grant\.html/.test(p.url())) { grant = p; break; }
	}
}

if (!grant) {
	console.log('GRANT WINDOW OPENED: false (no grant.html page appeared)');
	console.log('pages:', s.browser.pages().map(p => p.url()).join(', '));
} else {
	await grant.waitForLoadState('domcontentloaded');
	await grant.waitForTimeout(400);
	const info = await grant.evaluate(() => ({
		head:  (document.getElementById('head')||{}).textContent || '',
		host:  (document.getElementById('host')||{}).textContent || '',
		fine:  (document.getElementById('fine')||{}).textContent || '',
		allow: (document.getElementById('allow')||{}).textContent || '',
	}));
	console.log('grant window:', JSON.stringify(info, null, 2));
	console.log('\nGRANT WINDOW OPENED:', true);
	console.log('NAMES THE SITE:', /example\.com/.test(info.host));
	console.log('SETS CHROME EXPECTATION:', /Chrome/.test(info.fine) && /confirm in Chrome/i.test(info.allow));
}
console.log('app console errors:', errors(s));
await s.close();
