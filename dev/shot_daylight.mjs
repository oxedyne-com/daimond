// shot_daylight.mjs -- the four redesign screens (computer chat, computer
// diamond, phone chat, phone drawer) in the real app, filled with the round-3
// sample content, in each look asked for. Adapted from the redesign's own
// capture (ui_redesign_20260928/round3/_build/uix_today_max.mjs), so a shot
// here can be laid beside that round's renders.
//
//   eval "$(bash dev/world.sh N --env)"
//   UIX_OUT=<dir> UIX_PROFILE=<dir> DAIMOND_MOCK_SCRIPT=<json> \
//   UIX_LOOKS=daylight:porcelain,daylight:obsidian node dev/shot_daylight.mjs desk
//   ... node dev/shot_daylight.mjs phone        (after desk, same profile)
//
// The mock provider answers from DAIMOND_MOCK_SCRIPT, which this writes, so
// export it before the world is brought up.
import { open, chat, newChat } from './harness.mjs';
import fs from 'node:fs';

const OUT  = process.env.UIX_OUT;
const PROF = process.env.UIX_PROFILE;
const MODE = process.argv[2] || 'desk';
const LOOKS = (process.env.UIX_LOOKS || 'daylight:porcelain,daylight:obsidian').split(',').map((x) => x.split(':'));
const VIEW = process.env.UIX_VIEW || 'max';
fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log('[uix]', ...a);

const DIAMONDS = ['Kitchen renovation', 'Thesis, chapter 4', 'Tax return 2026', 'Life log'];

const CRYSTAL = {
	title:   'Kitchen renovation',
	summary: 'New kitchen for the Leederville house. Budget $38,000, start in May.',
	sections: [
		{ heading: 'Scope', body: 'Joinery, benchtop, splashback, two new power points. Keep the floor.' },
		{ heading: 'People', body: 'Harlow Joinery (Sam), electrician (Priya, licence EC 11842).' },
	],
	facts: [
		{ k: 'Budget', v: '$38,000 incl. GST' },
		{ k: 'Start', v: 'week of 4 May' },
		{ k: 'Quotes', v: 'Harlow $14,200 · Oakline $12,950 · Brandt $15,800' },
	],
};
const REQ = `# Requirements

## Joinery
- [x] Three quotes
- [ ] Accept Harlow
- [ ] Confirm benchtop colour

## Electrical
- [ ] Book Priya for rough-in
- [ ] Two GPOs by the window
`;
const DEC = `# Decisions

- 12026-09-21: Stone benchtop, not laminate. Resale.
- 12026-09-28: Harlow Joinery. Benchtop included, five weeks.
`;
const STATE = `# State

Waiting on Harlow to confirm a May start.
`;

const FILES = {
	'quotes/harlow.md':  '# Harlow Joinery\n\n$14,200 incl. benchtop. Lead time 5 weeks.\n',
	'quotes/oakline.md': '# Oakline\n\n$12,950. Benchtop +$2,100. Lead time 8 weeks.\n',
	'quotes/brandt.md':  '# Brandt & Co\n\n$15,800 incl. benchtop. Lead time 4 weeks.\n',
	'drafts/harlow-accept.md': 'Hi Sam,\n\nWe would like to go ahead with your quote of 3 September.\n',
	'budget.csv': 'item,cost\njoinery,14200\nelectrical,3100\nsplashback,2400\n',
	'floorplan.typ': '#set page(width: 20cm)\n= Kitchen\n',
	'notes.md': '# Notes\n\nMeasure the window reveal again.\n',
};

const MAIN_Q1 = 'Compare the three joinery quotes and tell me which to take.';
const MAIN_A1 = `**Take Harlow Joinery.**

| Quote | Price | Lead time | Benchtop |
|---|---|---|---|
| Harlow | $14,200 | 5 weeks | included |
| Oakline | $12,950 | 8 weeks | +$2,100 |
| Brandt & Co | $15,800 | 4 weeks | included |

Oakline looks cheapest until the benchtop is added. Then it is $850 dearer and three weeks slower.`;
const MAIN_Q2 = 'Draft a reply to Harlow accepting, and ask for a May start.';
const MAIN_A2 = `Done. The draft is in \`drafts/harlow-accept.md\`.

- Accepts the quote of 3 September
- Asks to start the week of 4 May
- Confirms the benchtop is included

Read it over before you send it.`;

const OTHERS = [
	['Outline section 4.2 on sampling bias.', 'Here is a three-part outline: the problem, the two corrections you used, and what they cost in power.'],
	['Why is the total in budget.csv off by $400?', 'Row 3 counts the splashback twice. Remove one and the total is $19,700.'],
	['Flights to Hobart on 14 November, morning.', 'Two direct options: 7:05 and 9:40. The 7:05 is $40 cheaper.'],
];

const SCRIPT = {};
SCRIPT[MAIN_Q1] = MAIN_A1;
SCRIPT[MAIN_Q2] = MAIN_A2;
for (const [q, a] of OTHERS) SCRIPT[q] = a;
if (MODE === 'desk' && process.env.DAIMOND_MOCK_SCRIPT) fs.writeFileSync(process.env.DAIMOND_MOCK_SCRIPT, JSON.stringify(SCRIPT));

// Two-times pixels without a second browser: override the metrics just before each shot.
async function metrics(page, w, h, mobile) {
	await page.setViewportSize({ width: w, height: h });
	return { detach: async () => {} };
}

// Sample values in place of the mock's own labels, and a synced account.
async function dress(page) {
	await page.evaluate(() => {
		const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
		const amounts = ['$0.42', '$3.18', '$11.06'];
		let n;
		while ((n = walk.nextNode())) {
			const v = n.nodeValue.trim();
			if (v === 'fast') n.nodeValue = n.nodeValue.replace('fast', 'deepseek-v3.2');
			else if (v === 'alex') n.nodeValue = n.nodeValue.replace('alex', 'Alex');
		}
		document.querySelectorAll('.spend-amt').forEach((e, i) => { e.textContent = amounts[i] || e.textContent; });
		const costs = ['$0.0213', '$0.0041', '$0.0027', '$0.0068', '$0.0012'];
		document.querySelectorAll('.tile-cost').forEach((e, i) => { e.textContent = costs[i % costs.length]; });
		const sum = document.getElementById('astat-summary');
		if (sum) {
			const dot = sum.querySelector('.astat-dot'); if (dot) dot.className = 'astat-dot ok';
			const val = sum.querySelector('.astat-val'); if (val) val.textContent = 'Synced · 3 devices';
		}
	});
}

async function maxView(page) {
	await page.evaluate((v) => { try { window.DaimondView.set(v); } catch (e) {} }, VIEW);
	await page.waitForTimeout(600);
	log('view', await page.evaluate(() => document.documentElement.getAttribute('data-view') + '/' + document.documentElement.getAttribute('data-skin')));
}

async function freeApp(page) {
	await page.evaluate(async () => {
		if (window.__free) return;
		const m = await import('/pkg/oxedyne_daimond.js');
		window.__free = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	});
}
async function write(page, path, content) {
	await page.evaluate(async (a) => {
		await window.__free.run_tool('file_write', JSON.stringify({ path: a.path, content: a.content }));
	}, { path, content });
}

async function panels(page, hide, show) {
	await page.evaluate(({ hide, show }) => {
		const P = window.DaimondPanels;
		for (const id of hide) { try { P.hide(id); } catch (e) {} }
		for (const id of show) { try { P.show(id); } catch (e) {} }
		try { P.reflow(); } catch (e) {}
	}, { hide, show });
	await page.waitForTimeout(700);
}

/// Wear one look: the skin, then the palette, the way the menu does.
async function wear(page, skin, theme) {
	await page.evaluate(({ skin, theme }) => {
		if (skin === 'daylight') window.DaimondLook.set('daylight');
		else { window.DaimondLook.set('classic'); window.DaimondSkin.set(skin); }
		window.DaimondTheme.set(theme);
	}, { skin, theme });
	await page.waitForTimeout(900);
}

/// Report what spills sideways: the body's own scroll and any visible element
/// past the right edge, the two things a 390px layout gets wrong.
async function overflow(page) {
	return page.evaluate(() => {
		const vw = window.innerWidth, out = [];
		for (const el of document.querySelectorAll('body *')) {
			const r = el.getBoundingClientRect();
			if (!r.width || !r.height) continue;
			const cs = getComputedStyle(el);
			if (cs.visibility === 'hidden' || cs.display === 'none') continue;
			if (r.right > vw + 1 && r.left < vw) out.push((el.id ? '#' + el.id : el.tagName.toLowerCase()) + '.' + String(el.className || '').split(' ')[0] + ' ' + Math.round(r.right - vw));
		}
		return { hScroll: document.documentElement.scrollWidth - document.documentElement.clientWidth, spill: out.slice(0, 12) };
	});
}

if (MODE === 'desk') {
	const s = await open({ name: 'alex', profile: PROF });
	const { page } = s;
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.waitForTimeout(800);
	await maxView(page);
	await freeApp(page);
	for (const name of DIAMONDS) {
		await page.click('#new-diamond-btn', { force: true });
		await page.waitForSelector('.dlg-input', { timeout: 10000 });
		await page.fill('.dlg-input', name);
		await page.click('.dlg-ok', { force: true });
		await page.waitForTimeout(1500);
	}
	const kid = await page.evaluate(async () => {
		const d = JSON.parse(await window.__free.list_diamonds()).find(x => x.name === 'Kitchen renovation');
		return d ? d.id : '';
	});
	await write(page, `diamonds/${kid}/crystal.json`, JSON.stringify(CRYSTAL));
	await write(page, `diamonds/${kid}/REQUIREMENTS.md`, REQ);
	await write(page, `diamonds/${kid}/DECISIONS.md`, DEC);
	await write(page, `diamonds/${kid}/STATE.md`, STATE);
	for (const [p, c] of Object.entries(FILES)) await write(page, p, c);
	for (const [q] of OTHERS) { await newChat(s); await chat(s, q); }
	await newChat(s);
	await chat(s, MAIN_Q1);
	await chat(s, MAIN_Q2);
	log('seeded');
	for (const [skin, theme] of LOOKS) {
		const tag = skin + '_' + theme;
		await wear(page, skin, theme);
		// The chat mid-conversation, rail and Workspace.
		await page.evaluate(() => { const t = document.querySelector('#session-list .chat-box .tile-label'); if (t) t.click(); });
		await page.waitForTimeout(1200);
		await panels(page, ['web', 'tools', 'spend'], ['rail', 'ai', 'work']);
		await page.evaluate(() => { const o = document.getElementById('chat-output'); if (o) o.scrollTop = o.scrollHeight; });
		await dress(page);
		await page.waitForTimeout(700);
		await page.screenshot({ path: `${OUT}/desk_chat_${tag}.png` });
		// A transcript tile under the pointer: its extent shows as a fill.
		const tiles = page.locator('#chat-output .ctile.chat-msg-assistant');
		if (await tiles.count()) {
			await tiles.last().hover({ force: true }).catch(() => {});
			await page.waitForTimeout(400);
			await page.screenshot({ path: `${OUT}/desk_hover_${tag}.png`, clip: { x: 340, y: 60, width: 780, height: 840 } });
			await page.mouse.move(5, 5);
		}
		// The appearance menu, where the look is chosen.
		await page.evaluate(() => { const b = document.getElementById('settings-menu-btn'); if (b) b.click(); });
		await page.waitForTimeout(600);
		await page.screenshot({ path: `${OUT}/desk_menu_${tag}.png` });
		await page.evaluate(() => { const b = document.getElementById('settings-menu-btn'); if (b) b.click(); });
		await page.waitForTimeout(300);
		// A diamond's page, Crystal face.
		await page.evaluate((name) => {
			const t = [...document.querySelectorAll('.diamond-box')].find(e => e.getAttribute('aria-label') === name);
			if (t) t.click();
		}, 'Kitchen renovation');
		await page.waitForTimeout(1500);
		await page.evaluate(() => { const b = document.getElementById('dview-crystal'); if (b) b.click(); });
		await page.waitForTimeout(2200);
		await panels(page, ['web', 'tools', 'spend'], ['work']);
		await dress(page);
		await page.waitForTimeout(700);
		await page.screenshot({ path: `${OUT}/desk_diamond_${tag}.png` });
		log('shot desk', tag);
	}
	await s.close();
} else {
	const s = await open({ name: 'alex', profile: PROF, isMobile: true, touch: true, connect: false });
	const { page } = s;
	await page.setViewportSize({ width: 390, height: 844 });
	await page.waitForTimeout(1500);
	await maxView(page);
	for (const [skin, theme] of LOOKS) {
		const tag = skin + '_' + theme;
		await wear(page, skin, theme);
		for (let i = 0; i < 3; i++) {
			const c = page.locator('#admin-close');
			if (await c.isVisible().catch(() => false)) { await c.click({ force: true }); await page.waitForTimeout(400); }
		}
		await page.evaluate(() => { try { window.DaimondPanels && window.DaimondPanels.show('ai'); } catch (e) {} });
		await page.waitForTimeout(400);
		await page.evaluate(() => { const t = document.querySelector('#session-list .chat-box .tile-label'); if (t) t.click(); });
		await page.waitForTimeout(1300);
		await page.evaluate(() => { const o = document.getElementById('chat-output'); if (o) o.scrollTop = o.scrollHeight; });
		await dress(page);
		await page.waitForTimeout(600);
		await page.screenshot({ path: `${OUT}/phone_chat_${tag}.png` });
		log('overflow chat', tag, JSON.stringify(await overflow(page)));
		await page.evaluate(() => document.getElementById('drawer-btn').click());
		await page.waitForTimeout(1100);
		await dress(page);
		await page.screenshot({ path: `${OUT}/phone_drawer_${tag}.png` });
		log('overflow drawer', tag, JSON.stringify(await overflow(page)));
		await page.keyboard.press('Escape').catch(() => {});
		await page.evaluate(() => { const sc = document.querySelector('.drawer-scrim, .scrim'); if (sc) sc.click(); });
		await page.waitForTimeout(600);
	}
	await s.close();
}
log('done', MODE);
