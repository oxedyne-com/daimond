// gateway: none
// verify_tilemeta.mjs -- D-20261010-03 and D-20261010-04, the readings under a tile.
//
//   03 "spacing between the context % and the price tag icon is non-existent in
//      Diamond tiles." The tag drops the meter's "·" (its glyph is the separator),
//      and in Daylight the Diamond meter's flex gap is 0, so nothing at all stood
//      between "12%" and the glyph. The chat meter kept a flex gap of 8px on top of
//      the dot's own margins: one role, two spacings.
//   04 "Delete the number of tokens used in ordinary chat tiles, its not needed
//      since the user can see the % context."
//
// Two properties, at 1440 and at 390, on every meter the rail draws:
//
//   1. THE JOIN IS ONE LENGTH. Every reading after a meter's first stands the same
//      distance from the one before it, whether the separator is the "·" or the
//      tag's glyph, on a Diamond tile and on a chat tile alike, and that distance
//      is not nothing. The distance is measured to the separator's ink start: the
//      tag's svg, or the dot's `::before` box less nothing but its margin.
//   2. A CHAT TILE CARRIES NO TOKEN COUNT. No `.tile-tok` and no "tok" in the text.
//
// Both are gated on the tiles really holding a context bar AND a price tag, so a
// rail that drew neither cannot pass by having nothing to measure.
//
//   eval "$(bash dev/world.sh N --env)"; bash dev/world.sh N --up
//   node dev/verify_tilemeta.mjs [--shots <dir> --tag before|after]
import fs from 'node:fs';
import path from 'node:path';
import { open, scratch, connectMock, steerDiamond, chat, newChat } from './harness.mjs';

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const SHOTS = arg('--shots');
const TAG   = arg('--tag') || 'run';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

let failures = 0;
const check = (cond, msg, detail) => {
	console.log((cond ? '  ok   ' : '  FAIL ') + msg + (detail != null ? ' -- ' + detail : ''));
	if (!cond) failures++;
};

async function makeDiamond(page, name) {
	await page.evaluate(() => document.getElementById('new-diamond-btn').click());
	await page.waitForSelector('.dlg-card', { timeout: 8000 });
	await page.evaluate((nm) => {
		const card = [...document.querySelectorAll('.dlg-card')].find((c) => c.getClientRects().length);
		const inp = card.querySelector('input.dlg-input');
		inp.value = nm;
		inp.dispatchEvent(new Event('input', { bubbles: true }));
		card.querySelector('.dlg-ok').click();
	}, name);
	await page.waitForTimeout(1500);
}

// Every meter in the rail: its readings' joins, and whether it is a chat's.
const measure = (page) => page.evaluate(() => {
	const out = [];
	for (const m of document.querySelectorAll('#panel-rail :is(.diamond-meter, .tile-meter)')) {
		if (!m.getClientRects().length) continue;
		const kids = [...m.children].filter((k) => k.getClientRects().length);
		const joins = [];
		for (let i = 1; i < kids.length; i++) {
			const prev = kids[i - 1].getBoundingClientRect(), el = kids[i];
			let ink;
			if (el.classList.contains('tagb')) {
				ink = el.querySelector('svg').getBoundingClientRect().left;
			} else {
				const b = getComputedStyle(el, '::before');
				ink = el.getBoundingClientRect().left
					+ (b.content && b.content !== 'none' ? parseFloat(b.marginLeft) || 0 : 0);
			}
			joins.push({ to: el.className, gap: Math.round((ink - prev.right) * 10) / 10 });
		}
		const box = m.closest('.session-box');
		out.push({
			chat: !!(box && box.classList.contains('chat-box')),
			hasCtx: !!m.querySelector('.tile-ctx'), hasTag: !!m.querySelector('.tagb'),
			tok: !!m.querySelector('.tile-tok') || /\btok\b/.test(m.textContent || ''),
			text: (m.textContent || '').trim(), joins,
		});
	}
	return out;
});

async function judge(page, w) {
	const ms = await measure(page);
	const dia = ms.filter((m) => !m.chat), cht = ms.filter((m) => m.chat);
	check(dia.some((m) => m.hasCtx && m.hasTag) && cht.some((m) => m.hasCtx && m.hasTag),
		`${w}: a Diamond tile and a chat tile each hold a context % and a price tag`,
		JSON.stringify(ms.map((m) => m.text)));
	const all = ms.flatMap((m) => m.joins.map((j) => ({ ...j, chat: m.chat, text: m.text })));
	const gaps = [...new Set(all.map((j) => j.gap))];
	check(all.length > 0 && gaps.length === 1 && gaps[0] >= 4,
		`${w}: every meter reading stands one join (>= 4px) from the one before it`,
		all.map((j) => `${j.chat ? 'chat' : 'diamond'} ${j.to}:${j.gap}px`).join(', '));
	const tagJ = all.filter((j) => /tagb/.test(j.to));
	check(tagJ.length > 0 && tagJ.every((j) => j.gap >= 4),
		`${w}: the % and the price tag are apart`, tagJ.map((j) => j.gap + 'px').join(', '));
	check(cht.length > 0 && cht.every((m) => !m.tok),
		`${w}: no ordinary chat tile shows a token count`, cht.map((m) => m.text).join(' | '));
}

async function snap(page, name, sel) {
	if (!SHOTS) return;
	const el = await page.$(sel);
	if (!el) { console.log(`  note  no ${sel} to photograph`); return; }
	const p = path.join(SHOTS, `${name}_${TAG}.png`);
	await el.screenshot({ path: p });
	console.log('  shot ' + p);
}

const s = await open({ name: 'tilemeta', profile: scratch('pw', 'tilemeta-' + process.pid) });
const { page } = s;
try {
	await page.evaluate(() => { const b = document.getElementById('admin-close'); if (b) b.click(); });
	// A model the pricing table publishes a window for and dev/mockllm.mjs serves
	// (as dev/verify_tiledlg.mjs §7), so both tiles can draw a bar.
	await connectMock(s, { model: 'accounts/fireworks/models/glm-5p2' });
	await page.waitForTimeout(600);
	await makeDiamond(page, 'Gamma');
	await page.evaluate(() => {
		const box = [...document.querySelectorAll('#diamond-list .session-box')]
			.find((b) => (b.textContent || '').includes('Gamma'));
		if (box) box.click();
	});
	await page.waitForTimeout(700);
	await steerDiamond(s, '@usage 31000 900 3.40');
	await page.waitForTimeout(6000);
	await newChat(s);
	await chat(s, '@usage 52000 1200 0.42');
	await page.evaluate(() => window.DaimondView.set('max'));
	await page.waitForTimeout(800);

	await page.setViewportSize({ width: 1440, height: 900 });
	await page.waitForTimeout(800);
	await judge(page, '1440');
	await snap(page, 'diamond_tile_1440', '#diamond-list .diamond-box');
	await snap(page, 'chat_tile_1440', '#session-list .chat-box');

	await page.setViewportSize({ width: 390, height: 844 });
	await page.waitForTimeout(1000);
	await page.evaluate(() => { if (!document.body.classList.contains('drawer-open')) { const b = document.getElementById('drawer-btn'); if (b) b.click(); } });
	await page.waitForTimeout(900);
	await judge(page, '390');
	await snap(page, 'diamond_tile_390', '#diamond-list .diamond-box');
	await snap(page, 'chat_tile_390', '#session-list .chat-box');
} finally {
	await s.close();
}
console.log(failures ? `\nFAIL ${failures}` : '\nPASS');
process.exit(failures ? 1 : 0);
