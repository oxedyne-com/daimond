// shot_tiledlg.mjs — photograph the rebuilt Diamond settings dialog.
//
// notes3 asked for four things in this one dialog: the DETAIL control gone,
// "WHEN THIS DIAMOND ACTS" renamed and reduced to a bare `+` until an action
// exists, the bottom "Done" replaced by a closer cross, and the chips that were
// really labels made to stop wearing pills. It also gained two colour pickers.
//
// Geometry checks can say the boxes do not overlap; they cannot say the row of
// controls looks deliberate. This is for the half a person has to read.
//
//   node dev/shot_tiledlg.mjs
//
// Needs dev/serve.mjs (DAIMOND_PORT). No gateway, no mock LLM.
import fs from 'node:fs';
import { open, scratch } from './harness.mjs';

const OUT = scratch('shots', 'tiledlg');
fs.mkdirSync(OUT, { recursive: true });

const s = await open({ name: 'tiledlg', connect: false });
const { page } = s;
try {
	await page.waitForTimeout(1800);

	// The seeded Diamonds are the ones a reader will actually meet, so the shot is
	// of a real tile rather than a fixture named "Test".
	const opened = await page.evaluate(() => {
		const box = document.querySelector('.diamond-box');
		if (!box) return 'no Diamond on the rail';
		const cog = box.querySelector('.tile-cog');
		if (!cog) return 'no cog on the tile';
		cog.click();
		return '';
	});
	if (opened) throw new Error(opened);
	await page.waitForSelector('.tile-dlg-card', { timeout: 8000 });
	await page.waitForTimeout(600);

	const card = await page.$('.tile-dlg-card');
	await card.screenshot({ path: `${OUT}/dialog.png` });

	// What the dialog is made of, so the image has something to be read against.
	const shape = await page.evaluate(() => {
		const card = document.querySelector('.tile-dlg-card');
		const txt = (el) => (el && (el.textContent || '').trim()) || null;
		return {
			title:        txt(card.querySelector('.tile-dlg-title h2')),
			closer:       !!card.querySelector('.tile-dlg-x'),
			closerInFoot: !!card.querySelector('.tile-dlg-foot .tile-dlg-x'),
			levelControl: card.querySelectorAll('[data-level]').length,
			headings:     [...card.querySelectorAll('.tile-dlg-head')].map((e) => txt(e)),
			labels:       [...card.querySelectorAll('.tile-dlg-label')].map((e) => txt(e)),
			chipsLeft:    card.querySelectorAll('.tile-model-chip').length,
			swatches:     [...card.querySelectorAll('.tile-dlg-swatch')].map((e) => e.id || e.name || 'swatch'),
			footButtons:  [...card.querySelectorAll('.tile-dlg-foot button')].map((e) => txt(e)),
		};
	});
	console.log(JSON.stringify(shape, null, 1));
	console.log('\nshot: ' + OUT + '/dialog.png');
} finally {
	await s.close();
}
