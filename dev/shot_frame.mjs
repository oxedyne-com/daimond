// shot_frame.mjs — the frame, for the eye rather than the assertion: the top
// bar, the phone's footer strip at each end of its scroll, the sync row in the
// rail, and the chat header's one labelled chip.
//
// `dev/verify_frame.mjs` asserts that nothing in the bar moves. This says what
// the thing that does not move looks like, which is the half a number cannot
// carry — a scrolling strip with no sign that it scrolls reads as a truncated
// list, and only a picture says whether the fade at its end reads as one.
import { open } from './harness.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
const sleep = ms => new Promise(r => setTimeout(r, ms));

mkdirSync('shots', { recursive: true });
const s = await open({ signIn: true, connect: true, name: 'frameshots' });
const { page } = s;
await page.route('**/*.{woff,woff2,ttf,otf}', r => r.abort());
await page.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important}' });
await page.evaluate(() => { try { window.DaimondAdmin.closeModal(); } catch (e) {} const m = document.getElementById('settings-modal'); if (m) m.style.display = 'none'; });
await sleep(400);

// Playwright's screenshot waits on document.fonts.ready, which never settles
// with the webfonts aborted; CDP's captureScreenshot does not.
const cdp = await s.browser.newCDPSession(page);
const shot = async (name, sel, scale = 2) => {
	try {
		const clip = sel ? await page.evaluate((q) => {
			const e = document.querySelector(q); if (!e) return null;
			const r = e.getBoundingClientRect();
			return { x: Math.max(0, Math.round(r.x) - 4), y: Math.max(0, Math.round(r.y) - 4),
				width: Math.round(r.width) + 8, height: Math.round(r.height) + 8 };
		}, sel) : null;
		if (sel && !clip) { console.log('SKIP ' + name + ' — no ' + sel); return; }
		const { data } = await cdp.send('Page.captureScreenshot', clip ? { format: 'png', clip: { ...clip, scale } } : { format: 'png' });
		writeFileSync('shots/' + name + '.png', Buffer.from(data, 'base64'));
		console.log('shot shots/' + name + '.png');
	} catch (e) { console.log('SKIP ' + name + ' — ' + e.message.split('\n')[0]); }
};

// ── The desktop bar, at rest and with a round in flight ────────────
await page.setViewportSize({ width: 1440, height: 900 });
await sleep(600);
await shot('frame-topbar', '.topbar');
await page.evaluate(() => {
	window.DaimondGateway.state = () => ({ authed: true });
	window.DaimondGateway.clientApi = () => 1;
	window.DaimondGateway.gwFetch = () => new Promise(r => setTimeout(
		() => r({ status: 200, json: async () => ({ present: false }) }), 6000));
});
page.evaluate(() => window.DaimondSync.pull()).catch(() => {});
await sleep(700);
await shot('frame-topbar-syncing', '.topbar');
await shot('frame-rail-syncing', '#admin-status', 3);
// A count on a chip, which used to widen the chip it was on.
await page.evaluate(() => window.dispatchEvent(new CustomEvent('daimond:mail-arrived', { detail: { count: 3 } })));
await sleep(400);
await shot('frame-topbar-badge', '.topbar');
await shot('frame-chathead', '.panel.ai .chead', 3);

// ── The phone: the footer strip ────────────────────────────────────
await page.setViewportSize({ width: 390, height: 844 });
await sleep(800);
await shot('frame-phone-screen');
const scrollTo = async (px) => {
	await page.evaluate((x) => { const r = document.getElementById('panel-tags'); if (r) { r.scrollLeft = x; r.dispatchEvent(new Event('scroll')); } }, px);
	await sleep(250);
};
await scrollTo(0);
await shot('frame-phone-strip-start', '#mnav', 3);
await scrollTo(300);
await shot('frame-phone-strip-middle', '#mnav', 3);
await scrollTo(9999);
await shot('frame-phone-strip-end', '#mnav', 3);
await shot('frame-phone-topbar', '.topbar', 3);
await page.evaluate(() => { const b = document.getElementById('drawer-btn'); if (b) b.click(); });
await sleep(500);
await shot('frame-phone-rail', '#admin-status', 3);

await s.close();
console.log('done');
