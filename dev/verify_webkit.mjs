// verify_webkit.mjs — the mobile UX walk, on the real Safari (WebKit) engine.
//
// iPhones run WebKit, not Chromium; "Chrome for iOS" is Safari underneath. This
// drives the same pathways as verify_mobile_ux.mjs but on Playwright's WebKit
// build with an iPhone viewport, so Safari-only rendering/JS quirks that Chromium
// tolerates get caught. It is DESKTOP WebKit on Linux, not iOS, so it may not
// reproduce iOS-only behaviour (auto-zoom, address-bar vh) — the zoom PROBE below
// reports whether this build does; treat that line as a diagnostic, not a gate.
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { signInAs, connectMock, APP } from './harness.mjs';

// This host (Ubuntu 25.10) is newer than Playwright's WebKit build targets, so
// its dependency preflight refuses to launch; the real runtime libs are supplied
// out-of-band (see dev/setup-webkit-libs.sh). Skip the preflight.
process.env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = '1';

const PW = process.env.DAIMOND_PW || path.join(os.homedir(), '.red-pw/node_modules/playwright-core/index.mjs');
const { webkit, devices } = await import(pathToFileURL(PW).href);

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (!pass && detail ? ' — ' + detail : ''));
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// The iPhone descriptor, minus `isMobile` (Chromium-only; WebKit rejects it).
const iph = devices['iPhone 13'];
const ctx = await webkit.launchPersistentContext(`/tmp/daimond-wk-${process.pid}`, {
	viewport:          iph.viewport,
	deviceScaleFactor: iph.deviceScaleFactor,
	userAgent:         iph.userAgent,
	hasTouch:          iph.hasTouch,
});
const page = ctx.pages()[0] || await ctx.newPage();
const errs = [];
page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
page.on('pageerror', e => errs.push('pageerror: ' + e.message));

const s = { browser: ctx, page, errs, logs: [], name: 'wktester', close: () => ctx.close() };
await page.goto(APP, { waitUntil: 'domcontentloaded' });
await sleep(400);

// Playwright's WebKitGTK/WPE build ships WITHOUT `navigator.storage` (OPFS), so
// the wasm's getDirectory() call throws here. Real iOS Safari 15.2+ HAS OPFS, so
// this is a test-engine gap, not a device bug — filter it. (The wasm could still
// feature-detect OPFS defensively; tracked separately.)
const realErrs = () => errs.filter(e =>
	!/Failed to load resource|status of 4\d\d/.test(e) &&
	!/getDirectory|navigator\.storage/.test(e));

// ── Engine sanity ──────────────────────────────────────────
check('engine: is WebKit', await page.evaluate(() => /WebKit/.test(navigator.userAgent) && !/Chrome\//.test(navigator.userAgent)), await page.evaluate(() => navigator.userAgent));

// ── The zoom PROBE (diagnostic) ────────────────────────────
// Does this WebKit reproduce iOS auto-zoom on a sub-16px focus? Shrink the
// passphrase box, focus it, and read the visual-viewport scale.
const zoom = await page.evaluate(async () => {
	const el = document.getElementById('id-pass') || document.querySelector('input');
	if (!el) return { probed: false };
	el.style.fontSize = '11px';
	const before = window.visualViewport ? window.visualViewport.scale : 1;
	el.focus();
	await new Promise(r => setTimeout(r, 300));
	const after = window.visualViewport ? window.visualViewport.scale : 1;
	el.blur(); el.style.fontSize = '';
	return { probed: true, before, after, zoomed: after > before + 0.01 };
});
console.log('  probe zoom-on-small-input:', JSON.stringify(zoom));

// ── The UX pathways, on Safari's engine ────────────────────
await signInAs(s, 'wktester');
await connectMock(s);
await page.evaluate(() => { try { window.DaimondAdmin.closeModal(); } catch (e) {} });
await sleep(300);

const smallInputs = async () => page.evaluate(() => {
	const out = [];
	document.querySelectorAll('input, textarea, select').forEach(el => {
		if (el.offsetParent === null) return;
		const fs = parseFloat(getComputedStyle(el).fontSize);
		if (fs < 16) out.push((el.id || el.className) + '=' + fs);
	});
	return out;
});
check('safari: all visible fields ≥16px', (await smallInputs()).length === 0, JSON.stringify(await smallInputs()));

check('safari: shell present', await page.evaluate(() => !!window.DaimondSheet && !!window.DaimondShell));

// Drawer
await page.evaluate(() => document.getElementById('drawer-btn').click());
await sleep(300);
check('safari: drawer opaque', await page.evaluate(() => {
	const bg = getComputedStyle(document.getElementById('panel-rail')).backgroundColor;
	return bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent';
}));

// Credits modal
await page.evaluate(() => document.getElementById('astat-account').click());
await sleep(400);
check('safari: credits titled "Credits"', await page.evaluate(() => {
	const t = document.querySelector('#admin-credits .admin-title');
	return t && /credit/i.test(t.textContent) && t.offsetParent !== null;
}));
check('safari: credits card fits viewport', await page.evaluate(() => {
	const r = document.querySelector('#settings-modal .modal-card').getBoundingClientRect();
	return r.top >= -1 && r.bottom <= window.innerHeight + 1;
}), await page.evaluate(() => { const r = document.querySelector('#settings-modal .modal-card').getBoundingClientRect(); return `bottom=${Math.round(r.bottom)} vh=${window.innerHeight}`; }));
check('safari: credits has top-right ×', await page.evaluate(() => {
	const x = document.getElementById('credits-done');
	return x && x.offsetParent !== null;
}));
await page.evaluate(() => document.getElementById('credits-done').click());
await sleep(300);

// A thing rises as a sheet, at a real height (Safari's flexbox/height engine)
await page.evaluate(() => { window.DaimondPanels.hide('web'); window.DaimondPanels.show('web'); });
await sleep(400);
check('safari: sheet raised to a real height', await page.evaluate(() =>
	document.getElementById('msheet').getBoundingClientRect().height > 120));
check('safari: ask pill on screen', await page.evaluate(() => {
	const r = document.getElementById('msheet-ask').getBoundingClientRect();
	return r.height > 0 && r.bottom <= window.innerHeight + 1;
}));

check('safari: no console errors', realErrs().length === 0, realErrs().slice(0, 3).join(' | '));

console.log(`\n${ok.length} passed, ${bad.length} failed  (engine: WebKit)`);
if (bad.length) console.log('FAILED: ' + bad.join(', '));
await ctx.close();
process.exit(bad.length ? 1 : 0);
