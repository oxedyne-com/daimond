// shot_qc_sheets.mjs — the phone's sheets, every destination, both detents.
//
// The bottom bar puts four destinations one tap away and each of them raises a
// sheet with the panel inside it. The sheet keeps the title; the guest keeps its
// controls — which means the grabber row holds a title of unknown length beside
// a control row of unknown width, and that is a row that can wrap. When it does
// it leaves a void beside the title and drops the close button to a line of its
// own, which is what a reader notices before anything else on the screen.
//
// So this opens each sheet, at each detent, and MEASURES the grabber: how many
// lines it is on, and whether the guest's own head has wrapped underneath it.
//
//   node dev/shot_qc_sheets.mjs --out ~/.cache/daimond/qc-sheets
import fs from 'node:fs';
import path from 'node:path';
import { open, errors, scratch } from './harness.mjs';

const argv = process.argv.slice(2);
const value = (n, d) => { const i = argv.indexOf(n); return (i >= 0 && argv[i + 1]) ? argv[i + 1] : d; };
const OUT = value('--out', scratch('qc-sheets'));
fs.mkdirSync(OUT, { recursive: true });

const CELLS = [
	{ tag: 'sharp-dark-380',  skin: 'sharp', theme: 'dark',  w: 380, h: 780 },
	{ tag: 'warm-light-380',  skin: 'warm',  theme: 'light', w: 380, h: 780 },
	{ tag: 'sharp-dark-320',  skin: 'sharp', theme: 'dark',  w: 320, h: 568 },
];

const s = await open({ name: 'qcsheets', connect: true });
const { page } = s;
const pause = (ms) => page.waitForTimeout(ms);
const rows = [];

/// The grabber row, measured. A single-line row has all three children on one
/// baseline band; a wrapped one does not, and the void it leaves is the height
/// of the line that moved.
const GRAB = function () {
	const sheet = document.getElementById('msheet');
	if (!sheet || !sheet.classList.contains('open')) return null;
	const grab = sheet.querySelector('.msheet-grab');
	const title = sheet.querySelector('.msheet-title');
	const close = sheet.querySelector('.msheet-close');
	if (!grab) return null;
	const r = (el) => { const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width * 10) / 10, h: Math.round(b.height * 10) / 10 }; };
	const gr = grab.getBoundingClientRect();
	// The guest panel's own header row, which sits directly under the grabber
	// and carries the controls the sheet did not take.
	const guest = sheet.querySelector('.panel');
	const head = guest && guest.querySelector('.railhead, .chead');
	let headWrap = null;
	if (head && head.getClientRects().length) {
		const kids = [...head.children].filter((k) => k.getClientRects().length);
		const rs = kids.map((k) => k.getBoundingClientRect());
		if (rs.length > 1) {
			const spread = Math.max(...rs.map((x) => x.top)) - Math.min(...rs.map((x) => x.top));
			const tallest = Math.max(...rs.map((x) => x.height));
			headWrap = {
				cls: head.className, wrapped: spread > tallest * 0.8,
				spreadY: Math.round(spread * 10) / 10, tallest: Math.round(tallest * 10) / 10,
				height: Math.round(head.getBoundingClientRect().height * 10) / 10,
				n: kids.length,
			};
		}
	}
	return {
		title: (title && title.textContent) || '',
		grabHeight: Math.round(gr.height * 10) / 10,
		titleRect: title ? r(title) : null,
		closeRect: close ? r(close) : null,
		// Wrapped when the title and the closer no longer share a line band.
		wrapped: !!(title && close
			&& Math.abs(title.getBoundingClientRect().top - close.getBoundingClientRect().top)
				> Math.max(title.getBoundingClientRect().height, close.getBoundingClientRect().height) * 0.8),
		// The closer must not sit over the bottom bar, and the sheet must not
		// sit over it either.
		barTop: (() => { const b = document.getElementById('mnav'); return b ? Math.round(b.getBoundingClientRect().top) : null; })(),
		sheetBottom: Math.round(sheet.getBoundingClientRect().bottom),
		sheetHeight: Math.round(sheet.getBoundingClientRect().height),
	};
};

try {
	await page.waitForFunction(() => !!(window.DaimondPanels && DaimondPanels.panels), null, { timeout: 20000 });
	await pause(600);
	await page.evaluate(() => { const c = document.getElementById('admin-close'); if (c && c.getClientRects().length) c.click(); });

	for (const cell of CELLS) {
		console.log(`── ${cell.tag}`);
		await page.setViewportSize({ width: cell.w, height: cell.h });
		await page.evaluate((c) => {
			document.documentElement.setAttribute('data-skin', c.skin);
			document.documentElement.setAttribute('data-theme', c.theme);
			document.documentElement.setAttribute('data-tone', c.theme === 'light' ? 'light' : 'dark');
			document.documentElement.setAttribute('data-ink', c.theme === 'light' ? 'dark' : 'light');
		}, cell);
		await pause(400);

		// The four bottom-bar destinations SWITCH the floor; they do not raise a
		// sheet. A sheet is raised for a guest — every other panel — through
		// `DaimondSheet.open`, which is what a chip tap and the palette both
		// call. That is the surface with the title-beside-controls row.
		const tabs = await page.evaluate(() => {
			const dest = new Set(['ai', 'mail', 'work', 'agents']);
			return DaimondPanels.panels().map((p) => p.id).filter((id) => !dest.has(id))
				.map((id, i) => ({ i, id, label: id }));
		});
		if (!tabs.length) { console.log('  no guests to raise at this width'); continue; }

		// The bar itself, before any sheet is up: four destinations that must
		// divide the bar evenly and each carry a target a thumb can hit.
		const bar = await page.evaluate(() => {
			const b = document.getElementById('mnav');
			const bs = [...b.querySelectorAll('button')];
			const ws = bs.map((x) => Math.round(x.getBoundingClientRect().width * 10) / 10);
			const hs = bs.map((x) => Math.round(x.getBoundingClientRect().height * 10) / 10);
			return { widths: ws, heights: hs, spread: Math.round((Math.max(...ws) - Math.min(...ws)) * 10) / 10,
				barHeight: Math.round(b.getBoundingClientRect().height * 10) / 10 };
		});
		console.log(`  bar   ${bar.barHeight}px, buttons ${bar.widths.join('/')} wide (spread ${bar.spread}px), ${bar.heights.join('/')} tall`);
		rows.push({ cell: cell.tag, what: 'mnav', ...bar });
		await page.screenshot({ path: path.join(OUT, `${cell.tag}--mnav.png`),
			clip: { x: 0, y: cell.h - bar.barHeight - 4, width: cell.w, height: bar.barHeight + 4 } }).catch(() => {});

		for (const t of tabs) {
			await page.evaluate((id) => { try { DaimondSheet.open(id); } catch (e) {} }, t.id);
			await pause(600);
			for (const detent of ['half', 'full']) {
				await page.evaluate((d) => {
					const sh = document.getElementById('msheet');
					if (!sh || !sh.classList.contains('open')) return;
					// The controller sets the height; drive it the way the drag does.
					// The controller keeps `snapTo` private, so the detent height is
					// computed the way it computes it (mobile.js: BAR 58, TOPBAR 50,
					// PEEK 56) rather than guessed in viewport units.
					const maxH = Math.max(56, window.innerHeight - 50 - 58);
					sh.style.height = (d === 'full' ? maxH : Math.min(maxH, Math.round(window.innerHeight * 0.52))) + 'px';
				}, detent);
				await pause(350);
				const g = await page.evaluate(GRAB);
				if (!g) { if (detent === 'half') console.log(`  ${t.label}: no sheet`); continue; }
				const file = path.join(OUT, `${cell.tag}--sheet-${t.label.replace(/\W+/g, '')}-${detent}.png`);
				await page.screenshot({ path: file }).catch(() => {});
				const flags = [];
				if (g.wrapped) flags.push(`GRABBER WRAPPED (title y${g.titleRect.y} h${g.titleRect.h}, close y${g.closeRect.y} h${g.closeRect.h}, row ${g.grabHeight}px)`);
				if (g.headWrap && g.headWrap.wrapped) flags.push(`GUEST HEAD WRAPPED (${g.headWrap.cls}, ${g.headWrap.height}px)`);
				if (g.barTop !== null && g.sheetBottom > g.barTop + 1) flags.push(`sheet foot ${g.sheetBottom} is over the bar at ${g.barTop}`);
				console.log(`  ${flags.length ? 'LOOK' : ' ok '}  ${t.label} @${detent} "${g.title}" ${g.sheetHeight}px${flags.length ? ' — ' + flags.join('; ') : ''}`);
				rows.push({ cell: cell.tag, tab: t.label, detent, ...g, flags });
			}
			await page.evaluate(() => { const c = document.getElementById('msheet-close'); if (c) c.click(); });
			await pause(300);
		}
	}
	fs.writeFileSync(path.join(OUT, 'sheets.json'), JSON.stringify(rows, null, '\t'));
	console.log(`\n${OUT}`);
	const errs = errors(s).filter((e) => !/502|Bad Gateway/.test(e));
	if (errs.length) console.log(`${errs.length} console error(s): ` + errs.slice(0, 5).join(' | '));
} finally {
	await s.close();
}
