// gateway: none
// verify_cfullpaint.mjs — full screen on a Lifelog crystal must keep the tab painting (UNBLOCK-81).
//
// The fault: on the Lifelog crystal, crystal Full screen (`[data-cfull]`) stopped the tab
// painting. CDP `Page.captureScreenshot` never returned, at a desktop size and under phone
// emulation, and a screencast froze on the frame before the toggle. Leaving full screen
// brought painting back. The default crystal never showed it: the page has to be one that
// reports its own height, as Lifelog does, so this seeds Lifelog exactly as
// `verify_lifelog.mjs` lays it down.
//
// What is held: WHILE in full screen, a CDP screenshot returns within 2 s, twice in a row
// (a stall that lets one frame out is still a stall), at 3440x1321 and at a 390x844 phone.
//
//   node dev/verify_cfullpaint.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, signInAs, connectMock, scratch } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, '..', 'www', 'capps', 'lifelog');
const TEMPLATE = fs.readFileSync(path.join(DIR, 'crystal.html'), 'utf8');
// The arm (UNBLOCK-81, part 1): a page whose reported height depends on its own frame's
// height. A daimon-written page that sets `min-height: 100vh` on its body does exactly this
// through the template's own `measure()`: body.scrollHeight is then the frame's height, the
// page reports it plus 4, the host raises the frame's floor by 4, the frame resizes, and the
// page reports again. `CFP_PAGE=template` keeps the stock page; `CFP_PAGE=<file>` seeds a copy.
const SYNTH = TEMPLATE.replace('</head>', '<style>html, body { min-height: 100vh; }</style></head>');
const PAGE = process.env.CFP_PAGE === 'template' ? TEMPLATE
	: process.env.CFP_PAGE ? fs.readFileSync(process.env.CFP_PAGE, 'utf8') : SYNTH;
// The arm (CFP-RATE): a page whose report swings with its frame by a DIFFERENT amount than the
// frame moved, so the echo rule cannot catch it: frame-200 after the frame grew, frame+50
// otherwise. It has no size it settles at, at any panel height. It posts its own reports (the
// template's script is closed in its own function, so its measure() cannot be swapped); the
// template's own report is about content and falls inside the frame, so it does not interfere.
const SWING = TEMPLATE.replace(/<\/body>(?![\s\S]*<\/body>)/, '<script>(function () { var last = 0;'
	+ ' function rep() { var h = innerHeight; var px = (last && h > last) ? h - 200 : h + 50; last = h;'
	+ " parent.postMessage({ dc: 1, v: 1, cmd: 'height', px: px }, '*'); }"
	+ " addEventListener('resize', rep); setTimeout(rep, 300); setTimeout(rep, 2000); })();</script></body>");
const MANIFEST = JSON.parse(fs.readFileSync(path.join(DIR, 'capp.json'), 'utf8'));
const CARRIED = MANIFEST.files.filter(f => f !== 'crystal.html')
	.map(rel => [rel, fs.readFileSync(path.join(DIR, rel), 'utf8')]);
const LIMIT_MS = 2000;	// the brief's bound on a screenshot taken in full screen
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

let failures = 0;
const check = (cond, msg, detail) => {
	console.log((cond ? '  ok   ' : '  FAIL ') + msg + (detail != null ? ' — ' + detail : ''));
	if (!cond) failures++;
};

/// One CDP screenshot, timed, given up at the limit. Returns the ms it took, or -1.
const timedShot = async (page, file) => {
	const cdp = await page.context().newCDPSession(page);
	const t0 = Date.now();
	const r = await Promise.race([
		cdp.send('Page.captureScreenshot', { format: 'png' }).then(x => x),
		new Promise(res => setTimeout(() => res(null), LIMIT_MS)),
	]).catch(() => null);
	const ms = Date.now() - t0;
	cdp.detach().catch(() => {});
	if (!r || !r.data) return -1;
	if (file) fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
	return ms;
};

/// Sign in, make a Diamond called Lifelog, lay the capp into it and mount the crystal.
const seed = async (s, body) => {
	const page = s.page;
	await page.goto(process.env.DAIMOND_APP || 'http://localhost:8777', { waitUntil: 'domcontentloaded' });
	await signInAs(s, 'cfullpaint');
	await connectMock(s);
	await page.waitForTimeout(1500);
	// Setup, not the thing under test: the button may sit in the phone's closed drawer, so it is
	// pressed as its own handler, not by a forced pointer action (noforce.test.mjs).
	await page.evaluate(() => document.getElementById('new-diamond-btn').click());
	await page.waitForSelector('.dlg-input', { timeout: 10000 });
	await page.fill('.dlg-input', 'Lifelog');
	await page.evaluate(() => document.querySelector('.dlg-ok').click());
	await page.waitForTimeout(1800);
	await page.$$eval('.diamond-box', els => els[0] && els[0].click());
	await page.waitForTimeout(1200);
	const id = await page.evaluate(async (a) => {
		const m = await import('/pkg/oxedyne_daimond.js');
		const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
		const d = JSON.parse(await app.list_diamonds()).find(x => x.name === 'Lifelog');
		if (!d) return '';
		const w = (p, c) => app.run_tool('file_write', JSON.stringify({ path: p, content: c }));
		await w('diamonds/' + d.id + '/crystal.json', JSON.stringify({ title: 'Lifelog',
			summary: 'What I eat, what I lift, and what the scales say.' }));
		await w('diamonds/' + d.id + '/crystal.html', a.page);
		for (const [rel, text] of a.carried) await w('diamonds/' + d.id + '/' + rel, text);
		return d.id;
	}, { page: body || PAGE, carried: process.env.CFP_SEED ? [] : CARRIED });
	check(!!id, 'a Lifelog Diamond to live in', id);
	return id;
};

const mount = async (page) => {
	if (process.env.CFP_KEEP) await page.evaluate(() => { window.__keepPanels = 1; });
	await page.evaluate(() => {
		if (window.DaimondPanels && !window.__keepPanels) { DaimondPanels.hide('guide'); DaimondPanels.hide('work'); }
		if (window.DaimondPanels) DaimondPanels.show('ai');
	});
	await page.waitForTimeout(400);
	await page.$$eval('.diamond-box', els => els[0] && els[0].click());
	await page.waitForFunction(() => !!document.querySelector('#crystal-frame-wrap iframe, .crystal-frame'),
		null, { timeout: 15000 }).catch(() => {});
	await page.waitForTimeout(2500);
	if (process.env.CFP_LIFE) {
		const f = page.frames().find(fr => fr.url().indexOf('blob:') === 0);
		if (f) await f.evaluate(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Life'); if (b) b.click(); });
		await page.waitForTimeout(1500);
	}
};

/// Reach the control the way a person does: on the phone the crystal face sits behind the
/// bottom bar's AI tab, so each step is taken only while the control is still not drawn.
const enterFull = async (page) => {
	const drawn = () => page.evaluate(() => { const e = document.getElementById('crystal-full-btn');
		return !!(e && e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden'); });
	if (!(await drawn())) {
		await page.evaluate(() => { const b = document.getElementById('dview-crystal'); if (b) b.click(); });
		await page.waitForTimeout(1000);
	}
	if (!(await drawn())) {
		await page.evaluate(() => { const b = [...document.querySelectorAll('button, a, [role=tab]')]
			.find((e) => /^\s*AI\s*$/.test(e.textContent || '') && e.getClientRects().length); if (b) b.click(); });
		await page.waitForTimeout(1000);
		await page.evaluate(() => { const b = document.getElementById('dview-crystal'); if (b) b.click(); });
		await page.waitForTimeout(1500);
	}
	// On a phone the control lives in the Chat options menu, not the head; the press is the
	// same function either way, so a phone with no drawn control presses it as the menu does.
	if (await drawn()) await page.click('#crystal-full-btn', { timeout: 5000 });
	else await page.evaluate(() => document.getElementById('crystal-full-btn').click());
	await page.waitForTimeout(800);
	return page.evaluate(() => document.documentElement.getAttribute('data-cfull'));
};

/// The metrics the PreSeed shot used on his own tab: CDP's device override, at a real scale factor.
const emulate = async (page, m) => {
	const cdp = await page.context().newCDPSession(page);
	await cdp.send('Emulation.setDeviceMetricsOverride', m);
	if (m.mobile) await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
	await page.waitForTimeout(1200);
	return cdp;
};

const probe = async (page, tag) => {
	const up = await page.evaluate(() => !!document.querySelector('#crystal-frame-wrap iframe, .crystal-frame'));
	check(up, 'the Lifelog page is mounted (' + tag + ')');
	// The host's side of the loop: how often the page's height report moved the frame.
	await page.evaluate(() => {
		const f = document.querySelector('#crystal-frame-wrap iframe, .crystal-frame');
		window.__mh = 0;
		if (f) new MutationObserver(() => { window.__mh++; }).observe(f, { attributes: true, attributeFilter: ['style'] });
	});
	const before = await page.evaluate(() => new Promise(res => { const n0 = window.__mh; setTimeout(() => res(window.__mh - n0), 2000); }));
	check(before <= 4, 'OUT OF FULL SCREEN the page cannot drive the frame size: frame style writes in 2 s (' + tag + ')', before);
	const pre = await timedShot(page, null);
	check(pre >= 0, 'a screenshot returns before full screen (' + tag + ')', pre + ' ms');
	const attr = await enterFull(page);
	check(attr === '1', 'full screen is on (' + tag + ')', 'data-cfull=' + attr);
	if (process.env.CFP_GPU) console.log('  gpu: ' + await page.evaluate(() => { const c = document.createElement('canvas').getContext('webgl'); const d = c && c.getExtension('WEBGL_debug_renderer_info'); return d ? c.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'none'; }));
	const churn = await page.evaluate(() => new Promise(res => {
		let n = 0, raf = 0; const seen = {};
		const mo = new MutationObserver(ms => ms.forEach(m => { n++; const k = (m.target.id || m.target.className || m.target.tagName) + ':' + m.attributeName; seen[k] = (seen[k] || 0) + 1; }));
		mo.observe(document.documentElement, { subtree: true, attributes: true, childList: true });
		const tick = () => { raf++; if (raf < 1e6) requestAnimationFrame(tick); }; requestAnimationFrame(tick);
		setTimeout(() => { mo.disconnect(); res({ n, raf, top: Object.entries(seen).sort((x, y) => y[1] - x[1]).slice(0, 6) }); }, 1500);
	}));
	console.log('  churn in full screen over 1.5 s: ' + JSON.stringify(churn));
	const a = await timedShot(page, scratch('cfullpaint-' + tag + '.png'));
	const b = await timedShot(page, null);
	check(a >= 0 && b >= 0, 'IN FULL SCREEN a screenshot returns within ' + LIMIT_MS + ' ms, twice (' + tag + ')',
		'first ' + a + ' ms, second ' + b + ' ms' + (a >= 0 ? ', ' + scratch('cfullpaint-' + tag + '.png') : ''));
	const writes = await page.evaluate(() => new Promise(res => { const n0 = window.__mh; setTimeout(() => res(window.__mh - n0), 2000); }));
	check(writes <= 4, 'IN FULL SCREEN the page cannot drive the frame size: frame style writes in 2 s (' + tag + ')', writes);
	if (process.env.CFP_CHAIN) await page.evaluate(() => { window.__chain = 1; });
	const frame = await page.evaluate(() => {
		const f = document.querySelector('#crystal-frame-wrap iframe, .crystal-frame');
		if (!f) return null;
		const r = f.getBoundingClientRect();
		const chain = [];
		for (let e = f; e && e !== document.body; e = e.parentElement) {
			const c = getComputedStyle(e);
			chain.push((e.id || e.className || e.tagName).toString().slice(0, 24) + ' h' + Math.round(e.getBoundingClientRect().height) + ' ' + c.display + ' ' + c.flex + ' ' + c.height);
		}
		const rules = [];
		const cb = document.getElementById('crystal-body') || document.querySelector('.crystal-body');
		const walk = (list, ctx) => { for (const ru of list) {
			if (ru.cssRules && !ru.selectorText) { if (!ru.media || matchMedia(ru.media.mediaText).matches) walk(ru.cssRules, ctx); continue; }
			try { if (ru.selectorText && cb && cb.matches(ru.selectorText) && (ru.style.flex || ru.style.flexGrow || ru.style.flexBasis)) rules.push(ru.selectorText + ' {flex:' + ru.style.flex + '}'); } catch (e) {}
		} };
		if (window.__chain) for (const sh of document.styleSheets) { try { walk(sh.cssRules); } catch (e) {} }
		if (cb && window.__chain) rules.push('inline:' + cb.getAttribute('style'));
		return { rules, h: Math.round(r.height), bottom: Math.round(r.bottom), vh: innerHeight, min: f.style.minHeight, chain };
	});
	if (frame && process.env.CFP_CHAIN) console.log('  chain: ' + frame.chain.join(' < ') + '\n  rules: ' + frame.rules.join(' | '));
	// Full screen gives the page the panel: the frame runs to within the panel's foot gutter of the viewport's bottom.
	check(!!frame && frame.bottom >= frame.vh - 60, 'IN FULL SCREEN the frame fills the panel to the foot (' + tag + ')',
		frame && ('bottom ' + frame.bottom + ' of ' + frame.vh));
	if (frame) delete frame.chain;
	check(!!frame && frame.h > 0, 'and the page is still there, drawn (' + tag + ')', JSON.stringify(frame));
	await page.keyboard.press('Escape');
	await page.waitForTimeout(500);
};

// Desktop, at the owner's own window size.
const s = await open({ name: 'cfullpaint', signIn: false, connect: false, headed: !!process.env.CFP_HEADED,
	...(process.env.CFP_GPU ? { executable: '/usr/bin/google-chrome-stable', extraArgs: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=vulkan', '--enable-features=Vulkan'] } : {}) });
try {
	await s.page.setViewportSize({ width: 3440, height: 1321 });
	await seed(s);
	await mount(s.page);
	await emulate(s.page, { width: 3440, height: 1321, deviceScaleFactor: Number(process.env.CFP_DSF || 2), mobile: false });
	await probe(s.page, '3440x1321');
} catch (e) {
	console.log('  FAIL threw at the desktop — ' + (e && e.message));
	failures++;
} finally {
	await s.close?.().catch(() => {});
}

// Phone: 390x844, touch, an iPhone's own word about itself.
const ph = await open({ name: 'cfullpaint-phone', signIn: false, connect: false, touch: true, isMobile: true, ua: IPHONE });
try {
	await ph.page.setViewportSize({ width: 390, height: 844 });
	await seed(ph);
	await mount(ph.page);
	await emulate(ph.page, { width: 393, height: 852, deviceScaleFactor: Number(process.env.CFP_DSF_PHONE || 3), mobile: true });
	await probe(ph.page, '393x852');
} catch (e) {
	console.log('  FAIL threw at the phone — ' + (e && e.message));
	failures++;
} finally {
	await ph.close?.().catch(() => {});
}

// The swinging page, at the desktop (CFP-RATE): outside full screen and in it, it cannot drive the frame.
const sw = await open({ name: 'cfullpaint-swing', signIn: false, connect: false });
try {
	await sw.page.setViewportSize({ width: 3440, height: 1321 });
	await seed(sw, SWING);
	await mount(sw.page);
	await emulate(sw.page, { width: 3440, height: 1321, deviceScaleFactor: Number(process.env.CFP_DSF || 2), mobile: false });
	await probe(sw.page, 'swing');
} catch (e) {
	console.log('  FAIL threw at the swinging page — ' + (e && e.message));
	failures++;
} finally {
	await sw.close?.().catch(() => {});
}

console.log(failures ? failures + ' failure(s)' : 'all checks passed');
process.exit(failures ? 1 : 0);
