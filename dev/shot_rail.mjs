// shot_rail.mjs — the two rail pictures the daimond.app landing page uses.
//
// It builds a workspace of six named and tagged Diamonds, shoots the rail, then
// narrows it to one tag and shoots it again. Four files come out, a dark and a
// light of each, because a raster cannot follow the reader's colour scheme the
// way the landing page's own CSS does.
//
//   eval "$(bash dev/world.sh 5 --env)"
//   node dev/shot_rail.mjs                 # writes into landing/assets/
//
// This exists because the previous set was shot on 17 July and went stale in
// three ways at once, none of which any build would report: the panel was
// renamed Foci to Diamonds, the search box above the list was removed on
// purpose, and the rail gained the global "Everything" pause row above it. The
// pictures sat on a public page beside three paragraphs about Diamonds, saying
// FOCI. Re-run this whenever the rail changes shape.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT  = path.join(HERE, '..', 'landing', 'assets');

/// The workspace the pictures show. The names are ordinary work, not a demo:
/// a client, a document, a piece of study, a person and two of the reader's
/// own. The `me` tag is the one the filter shot narrows to, so it has to fall
/// on more than one Diamond and fewer than all of them.
const DIAMONDS = [
	{ name: 'My Daimond prefs',      tags: ['daimond', 'me'] },
	{ name: 'Webster & Fernhill',    tags: ['client', 'business'] },
	{ name: 'Approval Application',  tags: ['document', 'project', 'government'] },
	{ name: 'Charles Houston essay', tags: ['university', 'document'] },
	{ name: 'Mum',                   tags: ['person', 'family'] },
	{ name: 'My health',             tags: ['health', 'me'] },
];

const s = await open({ name: 'rail-shot', signIn: true });
const p = s.page;
const pause = (ms) => p.waitForTimeout(ms);

await p.evaluate(() => DaimondPanels.show('rail'));
await pause(600);

/// Create one Diamond through the real New Diamond button and its dialog. The
/// dialog is in-DOM rather than native, so there is no `page.on('dialog')` to
/// wire up.
async function makeDiamond(name) {
	await p.click('#new-diamond-btn');
	await p.waitForSelector('.dlg-card .dlg-input', { state: 'visible', timeout: 8000 });
	await p.fill('.dlg-card .dlg-input', name);
	await p.click('.dlg-card .dlg-ok');
	await pause(1100);
}

/// Select a Diamond by its visible name and put the given tags on it, through
/// the Tags action and its editor, which is how a user does it.
async function tagDiamond(name, tags) {
	await p.evaluate((n) => {
		const box = [...document.querySelectorAll('.diamond-box')]
			.find((b) => (b.textContent || '').includes(n));
		if (box) box.click();
	}, name);
	await pause(700);
	await p.evaluate(() => {
		const b = [...document.querySelectorAll('.crystal-act')]
			.find((x) => /tags/i.test(x.textContent || ''));
		if (b) b.click();
	});
	await p.waitForSelector('.tag-editor .tag-input', { state: 'visible', timeout: 8000 });
	for (const t of tags) {
		await p.fill('.tag-editor .tag-input', t);
		await p.evaluate(() => {
			const add = document.querySelector('.tag-add .crystal-act');
			if (add) add.click();
		});
		await pause(400);
	}
	await pause(300);
}

// The rail lists newest first, so they are created back to front to come out
// in the order DIAMONDS declares.
for (const d of [...DIAMONDS].reverse()) await makeDiamond(d.name);
for (const d of DIAMONDS) await tagDiamond(d.name, d.tags);

// One Diamond always carries `.active`, so there is no such thing as a rail
// with nothing current. Tagging walks the list and leaves the last one it
// touched active at the FOOT, half out of frame; put the current one back at
// the top, where a highlight reads as "the one you are in" rather than as a
// crop.
await p.evaluate(() => DaimondPanels.show('rail'));
await p.$$eval('.diamond-box', (els) => els[0] && els[0].click());
await pause(700);

// Six Diamonds do not fit the list at the harness's default 950px window, and
// dragging the split alone cannot fix that: the rail is as tall as the window,
// so the space has to come from the window first. Taller window, then the drag.
await p.setViewportSize({ width: 1500, height: 1200 });
await pause(500);

// Give the Diamonds list the room for all six by dragging the rail's own split
// handle, which is what a user with six of them would do.
const split = await p.$('#handle-rail-split');
if (split) {
	const b = await split.boundingBox();
	await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
	await p.mouse.down();
	await p.mouse.move(b.x + b.width / 2, b.y + 430, { steps: 14 });
	await p.mouse.up();
	await pause(600);
}
await p.evaluate(() => { document.getElementById('diamond-list').scrollTop = 0; });
await pause(300);

/// Capture the rail at both themes. The app stores the choice in localStorage
/// and stamps `data-theme` on the root, so both are set: the attribute for what
/// is drawn now, the key so nothing on the page rereads the old value.
async function shotRail(file, count) {
	for (const theme of ['dark', 'light']) {
		await p.evaluate((t) => {
			localStorage.setItem('daimond-theme', t);
			document.documentElement.setAttribute('data-theme', t);
		}, theme);
		await pause(600);
		// The panel runs from the pause row at the top to the account Status
		// strip at the foot, and the strip is developer furniture: a build hash,
		// a tools count, whether the account service answered. None of that
		// belongs on a public page, so the clip stops at the end of the Diamonds
		// list. Measured per shot, because the filtered list is shorter.
		const clip = await p.evaluate((n) => {
			document.getElementById('diamond-list').scrollTop = 0;
			const r = document.getElementById('panel-rail').getBoundingClientRect();
			const l = document.getElementById('diamond-list').getBoundingClientRect();
			const boxes = [...document.querySelectorAll('.diamond-box')]
				.filter((b) => b.getClientRects().length);
			// Stop after the n-th Diamond. Below them sit the two the app ships
			// with, Daimond Optimiser and Daimond Help, which are real and stay in
			// the product; they are simply not what these pictures are of, and a
			// frame ending part-way through one reads as a broken crop.
			const cut = boxes[Math.min(n, boxes.length) - 1];
			const last = cut ? cut.getBoundingClientRect().bottom : l.bottom;
			return {
				x: Math.round(r.x),
				y: Math.round(r.y),
				width: Math.round(r.width),
				height: Math.round(Math.min(last + 10, l.bottom) - r.y),
			};
		}, count);
		await p.screenshot({ path: path.join(OUT, `${file}-${theme}.png`), clip });
	}
}

await shotRail('rail', DIAMONDS.length);

// Narrow to `me`, which leaves the reader's own two. The chip strip above the
// list is hidden until a tag is active, so the filtered shot is the only one
// that shows it.
await p.evaluate(() => {
	const chip = [...document.querySelectorAll('.diamond-box .tag-chip')]
		.find((c) => (c.textContent || '').trim() === 'me');
	if (chip) chip.click();
});
await pause(900);

const shown = await p.evaluate(() => ({
	filter: (document.getElementById('diamond-filter') || {}).innerText || '',
	names: [...document.querySelectorAll('.diamond-box')]
		.filter((b) => b.getClientRects().length)
		.map((b) => (b.querySelector('.diamond-name') || b).innerText.split('\n')[0]),
}));
console.log('FILTERED:', JSON.stringify(shown));

await shotRail('filter', shown.names.length);

const sizes = await p.evaluate(() => {
	const b = document.getElementById('panel-rail').getBoundingClientRect();
	return { w: Math.round(b.width), h: Math.round(b.height) };
});
console.log('RAIL BOX:', JSON.stringify(sizes));
console.log('WROTE:', ['rail-dark', 'rail-light', 'filter-dark', 'filter-light']
	.map((n) => `${n}.png`).join(' '));

await s.close();
