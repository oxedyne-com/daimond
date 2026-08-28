// dev/shot_triage_panel.mjs — the Notes view with a real plan on it, photographed
// at a desktop dock width and at an iPhone width.
//
// The plan is put up through `DaimondTriage.hold`, so this pays for no turn and
// draws exactly what a run would have drawn. The notes are the owner's own
// eighteen and the plan is the one a real model wrote from them.
//
//   eval "$(bash dev/world.sh N --env)"
//   node dev/shot_triage_panel.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, scratch } from './harness.mjs';

const HERE  = path.dirname(fileURLToPath(import.meta.url));
const NOTES = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'triage_notes_18.json'), 'utf8')).notes;
const PLAN  = fs.readFileSync(path.join(HERE, 'fixtures', 'triage_plan_18.json'), 'utf8');
const OUT   = process.env.TRG_SHOT_DIR || path.join(HERE, 'shots');
const TAG   = process.argv[2] || 'now';

const profile = scratch('pw', 'trgshot-' + process.pid);
const s = await open({ name: 'trgshot' + process.pid, profile });
const p = s.page;

await p.evaluate((notes) => {
	const key = Object.keys(localStorage).find((k) => k.indexOf('daimond-improve') !== -1)
		|| 'daimond-improve';
	localStorage.setItem(key, JSON.stringify({ v: 3, notes }));
	if (window.DaimondImprove) window.DaimondImprove.reset();
}, NOTES);
await p.evaluate(() => { window.DaimondPanels.show('social'); });
await p.waitForTimeout(400);
await p.evaluate(() => { if (window.DaimondImprove) window.DaimondImprove.onOpen(); });
await p.waitForTimeout(800);
const held = await p.evaluate((t) => !!window.DaimondTriage.hold(t), PLAN);
console.log('plan held:', held, '· notes:', await p.evaluate(() => window.DaimondImprove.notes().length));

fs.mkdirSync(OUT, { recursive: true });

/// Photograph the panel, not the window: the evidence is the ink.
///
/// In two crops, because the whole panel is five thousand pixels tall and a
/// picture scaled to fit one screen shows nothing about a border. The head crop
/// is the control row and the first drafts -- `trg-row`, `trg-plan`, `trg-head`,
/// `trg-kind`, `trg-draft` -- and the tail crop is the notes in no draft,
/// `trg-left`.
async function ink(label) {
	const el = await p.$('#improve-triage');
	if (!el) { console.log('no #improve-triage'); return; }
	const box = await el.boundingBox();
	if (!box) { console.log('no box'); return; }
	const crop = async (name, y, h) => {
		const f = path.join(OUT, `triage-${label}-${name}-${TAG}.png`);
		await p.screenshot({ path: f, timeout: 8000,
			clip: { x: box.x, y: Math.max(0, y), width: box.width, height: h } })
			.catch((e) => console.log('shot failed', e.message));
		console.log('   ', name, '→', f);
	};
	// The panel scrolls inside the dock, so the crops are taken by scrolling the
	// wanted part into view rather than by asking for a y far below the fold.
	await el.evaluate((e) => e.scrollIntoView({ block: 'start' }));
	await p.waitForTimeout(300);
	const top = await el.boundingBox();
	await crop('head', top.y, Math.min(760, p.viewportSize().height - Math.max(0, top.y)));
	// THE JOIN between two drafts, which is the whole question: where does one
	// end and the next begin.
	const second = (await p.$$('#improve-triage .trg-draft'))[1];
	if (second) {
		await second.evaluate((e) => e.scrollIntoView({ block: 'center' }));
		await p.waitForTimeout(300);
		const sb = await second.boundingBox();
		if (sb) await crop('join', Math.max(0, sb.y - 150), 320);
	}
	const left = await p.$('#improve-triage .trg-left');
	if (left) {
		await left.evaluate((e) => e.scrollIntoView({ block: 'center' }));
		await p.waitForTimeout(300);
		const lb = await left.boundingBox();
		if (lb) await crop('left', Math.max(0, lb.y - 40), Math.min(500, p.viewportSize().height - Math.max(0, lb.y - 40)));
	}
	console.log(label, 'panel box', JSON.stringify(box));
}

await p.setViewportSize({ width: 1854, height: 961 });
await p.waitForTimeout(500);
await ink('desktop');

// Below the breakpoint the panels are sheets, and whatever was last on top is
// on top -- a settings sheet was, the first time this ran, and the picture was
// of that. Anything over the panel is dismissed before the panel is asked for.
await p.setViewportSize({ width: 390, height: 844 });
await p.waitForTimeout(700);
for (let i = 0; i < 4; i++) { await p.keyboard.press('Escape'); await p.waitForTimeout(150); }
await p.evaluate(() => { window.DaimondPanels.show('social'); });
await p.waitForTimeout(700);
console.log('on top at 390:', await p.evaluate(() => {
	const vis = [...document.querySelectorAll('.sheet, .modal, .panel')]
		.filter((e) => e.getClientRects().length)
		.map((e) => e.id || e.className.split(' ')[0]);
	return vis.slice(-6).join(' | ');
}));
await ink('iphone');

await s.close();
try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* gone */ }
