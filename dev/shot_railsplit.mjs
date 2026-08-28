// shot_railsplit.mjs — the rail's divider, held. The Diamonds/Chats boundary
// where a hand put it, and the same rail with the Status strip 54px taller, at
// two window heights. Nothing between the two pictures but the strip.
//
// Run it against the code before 2026-08-28 and the pairs differ: the divider
// was a share of what the strip left over, so a taller strip re-cut it and
// carried the Chats head half as far again as the strip's own rows moved.
import { open } from './harness.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
const sleep = ms => new Promise(r => setTimeout(r, ms));
mkdirSync('shots', { recursive: true });
const s = await open({ signIn: true, connect: true, name: 'railsplit' });
const { page: p } = s;
await p.route('**/*.{woff,woff2,ttf,otf}', r => r.abort());
await p.evaluate(() => { try { window.DaimondAdmin.closeModal(); } catch (e) {} const m = document.getElementById('settings-modal'); if (m) m.style.display = 'none'; });
await p.evaluate(() => { try { DaimondAdmin.close(); } catch (e) {} });
await p.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important}' });
const cdp = await s.browser.newCDPSession(p);
const shot = async (name, sel, scale = 1.5) => {
	try {
		const clip = await p.evaluate((q) => {
			const e = document.querySelector(q); if (!e) return null;
			const r = e.getBoundingClientRect();
			return { x: Math.max(0, Math.round(r.x) - 4), y: Math.max(0, Math.round(r.y) - 4), width: Math.round(r.width) + 8, height: Math.round(r.height) + 8 };
		}, sel);
		if (!clip) return;
		const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale } });
		writeFileSync('shots/' + name + '.png', Buffer.from(data, 'base64'));
		console.log('shot shots/' + name + '.png');
	} catch (e) { console.log('SKIP ' + name + ' — ' + e.message.split('\n')[0]); }
};
// A few Diamonds and a chat, so both lists have something to draw.
for (const n of ['Onboarding', 'Weekly report', 'Invoice run']) {
	await p.click('#new-diamond-btn', { force: true });
	await p.waitForSelector('.dlg-input', { timeout: 10000 });
	await p.fill('.dlg-input', n);
	await p.click('.dlg-ok', { force: true });
	await sleep(700);
}
await p.click('#new-session-btn', { force: true });
await sleep(600);
const drag = async (dy) => {
	const b = await (await p.$('#handle-rail-split')).boundingBox();
	await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
	await p.mouse.down();
	await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2 + dy, { steps: 12 });
	await p.mouse.up();
	await sleep(400);
};
for (const vh of [900, 1100]) {
	await p.setViewportSize({ width: 1440, height: vh });
	await sleep(600);
	await p.evaluate(() => { try { DaimondAdmin.close(); } catch (e) {} });
	await drag(-70);
	await sleep(300);
	await shot('railsplit-' + vh + '-a-quiet', '.panel.rail');
	await p.evaluate(() => { document.getElementById('admin-status').style.paddingBottom = '54px'; });
	await sleep(500);
	await shot('railsplit-' + vh + '-b-taller-strip', '.panel.rail');
	await p.evaluate(() => { document.getElementById('admin-status').style.paddingBottom = ''; });
	await sleep(400);
}
await s.close();
console.log('done');
