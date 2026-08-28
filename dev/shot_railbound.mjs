// shot_railbound.mjs — the Admin drawer, bounded. The rail with the drawer open
// at three window heights, for the eye: the drawer's own head is on screen and
// the rail's head is above it, at every one.
import { open } from './harness.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
const sleep = ms => new Promise(r => setTimeout(r, ms));
mkdirSync('shots', { recursive: true });
const s = await open({ signIn: true, connect: true, name: 'railbound' });
const { page: p } = s;
await p.route('**/*.{woff,woff2,ttf,otf}', r => r.abort());
await p.evaluate(() => { try { window.DaimondAdmin.closeModal(); } catch (e) {} const m = document.getElementById('settings-modal'); if (m) m.style.display = 'none'; });
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
for (const vh of [700, 900, 1100]) {
	await p.setViewportSize({ width: 1440, height: vh });
	await sleep(500);
	await p.evaluate(() => { const b = document.getElementById('settings-btn'); if (b && !document.getElementById('admin').classList.contains('admin-open')) b.click(); });
	await sleep(500);
	await shot('railbound-' + vh, '.panel.rail');
	await p.evaluate(() => { try { DaimondAdmin.close(); } catch (e) {} });
	await sleep(250);
}
await p.setViewportSize({ width: 1440, height: 900 });
await sleep(500);
await shot('railbound-strip', '#admin-status', 3);
await s.close();
console.log('done');
