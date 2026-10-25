// shot_sourceswitch.mjs -- the composer's credit-source switch (OWNKEY SW-1, D-20261024-19), closed
// and open, in both palettes, with 0, 1 and 6 providers (one with a very long name), and inside a
// Diamond's chat. The credits balance is stood in for, since a mock world has no gateway to load it.
//
//   eval "$(bash dev/world.sh N --env)"
//   DAIMOND_BROWSER=chromium|webkit node dev/shot_sourceswitch.mjs <outdir> <w> <h> <0|1|6> [phone]
import { open, scratch, connectMock, chat, newChat, MOCK, BROWSER } from './harness.mjs';
import fs from 'node:fs';
import path from 'node:path';

const OUT   = process.argv[2] || 'dev/shots';
const W     = +(process.argv[3] || 1280);
const H     = +(process.argv[4] || 720);
const N     = +(process.argv[5] || 0);
const PHONE = process.argv[6] === 'phone';
const LONG  = 'Northwind Analytics Research Cluster (Sydney, private, GPU pool 3)';
const MORE  = [['p2', 'OpenRouter'], ['p3', LONG], ['p4', 'Groq'], ['p5', 'Together AI'], ['p6', 'Fireworks']];
const THEMES = ['porcelain', 'obsidian'];
fs.mkdirSync(OUT, { recursive: true });

const s = await open({ name: 'swshot', touch: PHONE, connect: false, profile: scratch('pw', 'swshot-' + BROWSER + '-' + process.pid) });
const { page } = s;
const log = (...a) => console.log(...a);
const measure = () => page.evaluate(() => {
	const r = (e) => { if (!e || !e.getClientRects().length) return null;
		const b = e.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; };
	const q = (sel) => r(document.querySelector(sel));
	const cs = (sel) => { const e = document.querySelector(sel); if (!e) return null; const c = getComputedStyle(e);
		return [c.fontSize, c.fontFamily.split(',')[0], c.fontWeight, c.color, c.backgroundColor, c.borderTopWidth + ' ' + c.borderTopStyle + ' ' + c.borderTopColor, c.paddingTop + '/' + c.paddingLeft]; };
	const vw = window.innerWidth, spill = [];
	for (const el of document.querySelectorAll('#composer-row *, .source-menu, .source-menu *')) {
		const b = el.getBoundingClientRect();
		if (b.width && b.right > vw + 1) spill.push((el.id || el.className) + ' ' + Math.round(b.right - vw));
	}
	return { row: q('#composer-row'), box: q('#chat-input'), source: q('#source-btn'), seat: q('#seat-switch .dview-btn'),
		effort: q('#effort-step .dview-btn'), menu: q('.source-menu'),
		css: { source: cs('#source-btn'), seat: cs('#seat-switch .dview-btn'), effort: cs('#effort-step .dview-btn') },
		rowOver: (() => { const e = document.getElementById('composer-row'); return e ? e.scrollWidth - e.clientWidth : null; })(),
		kids: [...(document.getElementById('composer-row') || { children: [] }).children].filter((e) => e.getClientRects().length)
			.map((e) => (e.id || e.className) + ':' + r(e) + ':' + getComputedStyle(e).flex + ':' + getComputedStyle(e).minWidth),
		hScroll: document.documentElement.scrollWidth - document.documentElement.clientWidth, spill };
});
const wear = async (theme) => {
	await page.evaluate((theme) => { window.DaimondLook.set('daylight'); window.DaimondTheme.set(theme); }, theme);
	await page.waitForTimeout(700);
};
const closeMenu = () => page.evaluate(() => { if (document.querySelector('.source-menu')) document.getElementById('source-btn').click(); });
const openMenu = async () => {
	await page.click('#source-btn');
	await page.waitForSelector('.source-menu', { timeout: 5000 });
	await page.waitForTimeout(300);
};
const snap = async (theme, n, state) => {
	// No toast over the row: it is the pick's, not the switch's.
	await page.evaluate(() => document.querySelectorAll('.daimond-toast').forEach((e) => e.remove()));
	const f = path.join(OUT, `${W}x${H}_${theme}_${n}_${state}.png`);
	await page.screenshot({ path: f });
	log(f, JSON.stringify(await measure()));
};

try {
	await page.setViewportSize({ width: W, height: H });
	if (N >= 1) {
		await connectMock(s, { model: 'mock/thinker' });
		await page.evaluate(async () => {
			const j = JSON.parse(localStorage.getItem('daimond-models-v2') || '{}');
			await window.DaimondModels.fetchModels((j.def || {}).provider);
		});
	}
	if (N >= 6) {
		await page.evaluate(async ({ more, url }) => {
			const M = window.DaimondModels;
			for (const [id, name] of more) { M.addProvider(id, { url, name }); await M.setKey(id, 'mock-key'); await M.fetchModels(id); }
		}, { more: MORE, url: MOCK });
	}
	// The balance a gateway would load: a figure with the tag glyph, as the rail shows it.
	await page.evaluate(() => {
		const M = window.DaimondModels, was = M.sources;
		const bal = window.DaimondI18n.poolMark(42.5, 'aud');
		M.sources = function () {
			const rows = was.call(M).filter((x) => !x.credits);
			return [{ id: M.CREDITS, name: 'Daimond credits', credits: true, balance: bal }].concat(rows);
		};
	});
	await newChat(s);
	if (N >= 1) await chat(s, 'What is the boiling point of water at 2,000 m?');
	// With nothing to run on, a phone's new chat opens Models; the switch is under it.
	for (let i = 0; i < 3 && await page.locator('#settings-modal').isVisible().catch(() => false); i++) {
		await page.keyboard.press('Escape');
		await page.waitForTimeout(400);
	}
	await page.waitForTimeout(600);
	// Six providers: the chat moved, through the menu, onto the long name, so the closed switch carries it.
	if (N >= 6) {
		await openMenu();
		await page.evaluate((long) => { [...document.querySelectorAll('.source-menu .railhead-menu-item')].find((b) => b.textContent.includes(long)).click(); }, LONG);
		await page.waitForTimeout(900);
		const f = path.join(OUT, `${W}x${H}_${N}prov_toast.png`);
		await page.screenshot({ path: f });
		log(f);
	}
	for (const theme of THEMES) {
		await wear(theme);
		await closeMenu();
		await snap(theme, N + 'prov', 'closed');
		await openMenu();
		await snap(theme, N + 'prov', 'open');
		await closeMenu();
	}
	// A Diamond's chat: the menu's head says "This Diamond". The desktop's New Diamond is enough.
	if (N >= 1 && !PHONE) {
		await page.click('#new-diamond-btn');
		await page.waitForSelector('.dlg-input', { timeout: 10000 });
		await page.fill('.dlg-input', 'Kitchen renovation');
		await page.click('.dlg-ok');
		await page.waitForTimeout(2500);
		for (const theme of THEMES) {
			await wear(theme);
			await closeMenu();
			await snap(theme, N + 'prov', 'diamond_closed');
			await openMenu();
			await snap(theme, N + 'prov', 'diamond_open');
			await closeMenu();
		}
	}
} finally {
	await s.close();
}
