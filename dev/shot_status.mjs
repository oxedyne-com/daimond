// shot_status.mjs — the rail's exception-only Status (D-20261015-15), calm (S1)
// and with exceptions (S1x: Bypass, a key near empty, an update), desk + phone.
import { open, shot, chat, BROWSER } from './harness.mjs';
// A phone is Chromium's isMobile hint or, under WebKit, the iPhone's own UA (harness refuses isMobile there).
const PHONE = BROWSER === 'webkit'
	? { touch: true, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' }
	: { isMobile: true, touch: true };

for (const [tag, viewport, extra] of [['desk', { width: 1920, height: 961 }, {}],
	['phone', { width: 393, height: 793 }, PHONE]]) {
	const s = await open({ name: 'status-shot-' + tag, signIn: true, connect: true, viewport, ...extra });
	const { page } = s;
	await page.waitForTimeout(800);
	// As S1x is drawn: Settings (which opens itself on a fresh account) shut, one chat in the pane.
	await page.evaluate(() => { const b = document.getElementById('admin-close'); if (b && b.offsetParent) b.click(); }); await page.waitForTimeout(200);
	if (tag === 'desk') await chat(s, 'Summarise the launch checklist').catch(e => console.log('chat', e.message.slice(0, 80)));
	if (tag === 'phone') { await page.evaluate(() => window.DaimondShell && DaimondShell.openDrawer()); await page.waitForTimeout(500); }
	if (tag === 'phone') await page.evaluate(() => { const b = document.querySelector('[data-fold="status"]'); if (b) b.click(); });
	await page.waitForTimeout(300);
	const calm = await page.evaluate(() => ({ needs: document.querySelectorAll('#astat-needs .astat-need').length,
		line: (document.getElementById('astat-summary') || {}).textContent }));
	await shot(s, 'st-calm-' + tag);
	// S1x: raise the three exceptions through their real sources.
	// Bypass explains itself the first time: accept that dialog as a person would.
	await page.evaluate(() => { DaimondHandMode.set('bypass'); });
	await page.waitForTimeout(500);
	await page.evaluate(() => { const ok = [...document.querySelectorAll('.dlg-ok')].find(b => b.offsetParent); if (ok) ok.click(); });
	await page.waitForTimeout(500);
	await page.evaluate(() => {
		DaimondNeeds.compute = ((orig) => (f) => orig(Object.assign({}, f, { updateReady: true,
			pots: [{ key: 'own', provider: 'OpenRouter', what: 'OpenRouter key', minutes: 20 * 60 }] })))(DaimondNeeds.compute);
		DaimondNeeds.refresh();
	});
	await page.waitForTimeout(400);
	const ex = await page.$$eval('#astat-needs .astat-need', a => a.map(r => r.textContent));
	await shot(s, 'st-x-' + tag);
	await page.evaluate(() => document.querySelector('#astat-needs [data-act="guard"]').click());
	await page.waitForTimeout(400);
	const after = await page.$$eval('#astat-needs .astat-need', a => a.map(r => r.dataset.need));
	const hand = await page.evaluate(() => DaimondHandMode.get());
	// Settings holds the moved rows
	await page.evaluate(() => document.getElementById('astat-summary').click());
	await page.waitForTimeout(500);
	const inSettings = await page.evaluate(() => !!document.querySelector('#admin-body #astat-model'));
	await shot(s, 'st-settings-' + tag);
	console.log(tag, JSON.stringify({ calm, ex, after, hand, inSettings }));
}
process.exit(0);
