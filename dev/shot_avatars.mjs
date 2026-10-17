// shot_avatars.mjs — rail tile icons and the icon picker (AVATARS, D-20261015-13).
// Desk 1920x961 and phone 393x793, beside av-K-desk / av-K-picker-desk / -phone.
import { open, shot, chat, newChat, BROWSER } from './harness.mjs';
// A phone is Chromium's isMobile hint or, under WebKit, the iPhone's own UA (harness refuses isMobile there).
const PHONE = BROWSER === 'webkit'
	? { touch: true, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' }
	: { isMobile: true, touch: true };

for (const [tag, viewport, extra] of [['desk', { width: 1920, height: 961 }, {}],
	['phone', { width: 393, height: 793 }, PHONE]]) {
	const s = await open({ name: 'avatars-shot-' + tag, signIn: true, connect: true, viewport, ...extra });
	const { page } = s;
	await page.waitForTimeout(800);
	if (tag === 'phone') { await page.evaluate(() => window.DaimondShell && DaimondShell.openDrawer()); await page.waitForTimeout(500); }
	const shut = page.locator('#admin-close');
	await page.evaluate(() => { const b = document.getElementById('admin-close'); if (b && b.offsetParent) b.click(); }); await page.waitForTimeout(200);
	for (const name of ['Fred Hoogland', 'Ontheism', 'Lifelog', 'Brand voice']) {
		await page.evaluate(() => document.getElementById('new-diamond-btn').click());
		await page.waitForSelector('.dlg-input', { timeout: 10000 });
		await page.fill('.dlg-input', name);
		await page.click('.dlg-ok', { force: true });
		await page.waitForTimeout(600);
	}
	// Tags as av-K has them, through the crystal's own tag editor, so the rail shows the
	// LIVE default (name + tags): Fred + person -> user, Ontheism + philosophy -> yin-yang.
	for (const [name, tags] of [['Fred Hoogland', ['person']], ['Ontheism', ['philosophy', 'religion']]]) {
		const idx = await page.$$eval('.diamond-box', (els, n) => els.findIndex(e => e.textContent.includes(n)), name);
		if (idx < 0) { console.log('no diamond', name); continue; }
		await page.$$eval('.diamond-box', (els, i) => els[i].click(), idx);
		await page.waitForTimeout(500);
		for (const b of await page.$$('.crystal-act')) {
			if ((await b.textContent()).includes('Tags')) { await b.click({ force: true }); break; }
		}
		await page.waitForSelector('.tag-editor', { timeout: 5000 });
		for (const t of tags) { await page.fill('.tag-input', t); await page.keyboard.press('Enter'); await page.waitForTimeout(400); }
		await page.click('.crystal-act', { force: true });
		await page.waitForTimeout(400);
	}
	if (tag === 'phone') { await page.evaluate(() => window.DaimondShell && DaimondShell.openDrawer()); await page.waitForTimeout(500); }
	if (tag === 'desk') {
		for (const q of ['Is it possible to build a small solar powered aircraft?', 'Summarise the launch checklist']) {
			// Two chats, as av-K draws them: a fresh one for each opening line.
			await newChat(s).catch(() => {});
			await chat(s, q).catch(e => console.log('chat', e.message.slice(0, 80)));
		}
	}
	await page.waitForTimeout(500);
	const n = await page.$$eval('.av-btn', a => a.length);
	const icons = await page.$$eval('.diamond-box', els => els.map(e => [e.querySelector('.diamond-name, .dbox-name')?.textContent || e.textContent.trim().slice(0, 20), e.querySelector('.av-btn')?.dataset.icon || e.querySelector('.av-btn svg')?.getAttribute('data-icon') || '']));
	console.log(tag, 'icons', JSON.stringify(icons));
	const errs = (s.errs || []).filter(e => !/401|Failed to load resource|favicon/i.test(String(e)));
	if (errs.length) console.log(tag, 'page errors', errs.slice(0, 3).join(' | ').slice(0, 300));
	await shot(s, 'av-' + tag);
	const b = await page.$('.av-btn');
	let cells = 0;
	if (b) {
		await b.evaluate(x => x.click());
		await page.waitForTimeout(700);
		cells = await page.$$eval('.av-pick .av-cell', a => a.length);
		await shot(s, 'av-picker-' + tag);
	}
	console.log(tag, 'buttons', n, 'cells', cells);
	await s.close?.();
}
process.exit(0);
