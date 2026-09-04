// Diamond-side click-through: header logo consistency (item 9), crystal-v gone
// (10), switcher+when on the left (11), fold button present on the daimond chat
// and folding into its own Diamond (13), Fold-selected absent (13), Fresh daimon
// gone from settings (15).
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { open, connectMock, signInAs, scratch, errors } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(HERE, 'shots');
const MODEL = 'deepseek/deepseek-v4-pro';

const s = await open({ name: 'refine-diamond', profile: scratch('pw', 'refine-diamond-' + process.pid) });
const { page: p } = s;
const say = (k, v) => console.log(k, '=>', JSON.stringify(v));
const shot = async (l) => { fs.mkdirSync(SHOTS, { recursive: true }); await p.locator('#panel-ai').screenshot({ path: path.join(SHOTS, l + '.png'), timeout: 8000 }).catch(() => {}); };

await connectMock(s, { model: MODEL });

// create a Diamond
await p.evaluate(() => document.getElementById('new-diamond-btn').click());
await p.waitForSelector('.dlg-card', { timeout: 8000 });
await p.evaluate(() => {
	const card = [...document.querySelectorAll('.dlg-card')].filter((c) => c.getClientRects().length).pop();
	const inp = card.querySelector('input.dlg-input');
	inp.value = 'Dee'; inp.dispatchEvent(new Event('input', { bubbles: true }));
	card.querySelector('.dlg-ok').click();
});
await p.waitForTimeout(1400);

const header = () => p.evaluate(() => {
	const mark = document.getElementById('chead-mark');
	const when = document.getElementById('chead-when');
	const meter = document.getElementById('ai-meter');
	const sw = document.getElementById('diamond-view');
	const left = document.querySelector('.panel.ai .chead .chead-left');
	return {
		logoVisible: mark ? getComputedStyle(mark).display !== 'none' : null,
		when: when ? when.textContent : null,
		meterHasCrystalV: /crystal v/.test(meter ? meter.textContent : ''),
		switcherVisible: sw ? getComputedStyle(sw).display !== 'none' : null,
		switcherInLeft: !!(left && sw && left.contains(sw)),
		whenInLeft: !!(left && when && left.contains(when)),
	};
});

say('crystalFace_header', await header());
await shot('refine-diamond-crystal');

// switch to the chat face
await p.click('#dview-chat');
await p.waitForTimeout(800);
say('chatFace_header (logo must stay)', await header());

// say something so the daimon chat has content
await p.fill('#chat-input', 'remember that I like short answers');
await p.click('#chat-send');
await p.waitForTimeout(4000);

say('chatFace_foldBtn', await p.evaluate(() => {
	const fold = document.getElementById('chat-fold-btn');
	return { visible: fold ? getComputedStyle(fold).display !== 'none' : null };
}));

// select mode: Fold selected must be ABSENT on a daimond chat
await p.evaluate(() => { const b = document.getElementById('collapse-btn'); if (b) b.click(); });
await p.waitForTimeout(300);
say('daimond_selectHeader', await p.evaluate(() => {
	const sf = document.getElementById('sel-fold');
	return { selFoldVisible: sf ? getComputedStyle(sf).display !== 'none' : null };
}));
await p.evaluate(() => { const b = document.getElementById('collapse-btn'); if (b) b.click(); });
await p.waitForTimeout(200);
await shot('refine-diamond-chat');

// Fold button behaviour: clicking it folds into THIS diamond -> foldChatInto ->
// switches to the crystal (centreMode focus) and proposes. Prove it is wired to
// the diamond, not the old target-picker menu.
const foldWired = await p.evaluate(() => {
	const fold = document.getElementById('chat-fold-btn');
	if (!fold || getComputedStyle(fold).display === 'none') return { clickable: false };
	fold.click();
	return { clickable: true };
});
await p.waitForTimeout(2500);
say('foldClick', foldWired);
say('afterFold', await p.evaluate(() => ({
	// foldChatInto calls selectDiamond -> crystal face; no target-picker menu opened.
	crystalShown: document.getElementById('crystal-view') ? getComputedStyle(document.getElementById('crystal-view')).display !== 'none' : null,
	foldMenuOpen: !!document.querySelector('.fold-menu'),
	crystalPending: !!document.querySelector('.fold-diff, .crystal-status'),
})));

// Fresh daimon gone from settings. Open the Diamond's settings (gear) and look.
const settingsOpened = await p.evaluate(() => {
	// the diamond settings gear
	const gear = document.querySelector('.diamond-box .tile-cog, #diamond-settings-btn, .dsettings-btn, [data-i18n-aria-label="tile.settings"]');
	if (gear) { gear.click(); return true; }
	return false;
});
await p.waitForTimeout(600);
say('freshDaimon_gone', await p.evaluate(() => {
	const txt = document.body.innerText || '';
	return { settingsHasFreshDaimon: /Fresh daimon/.test(txt) };
}));

console.log('ERRORS', JSON.stringify(errors(s).filter((e) => !/502|\/api\//.test(e)).slice(0, 8)));
await s.close();
console.log('DONE-DIAMOND');
