// gateway: none
// shot_u4views.mjs -- the three Settings sections that left the Models view
// (D-20261018-09 U4): Limits, Search and Folders, in Obsidian and Porcelain, at
// 1440x900 and 390x844, for a person to look at. A world has no hand, so Folders is
// drawn with its two rows unhidden and a folder written in: a picture of the layout,
// not a test of when the rows show (verify_termpanel holds that). Prints what it shot.
//
//   node dev/shot_u4views.mjs        (inside a world: bash dev/world.sh N --up)
import { open, shot } from './harness.mjs';

const SIZES = [['desk', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]];
const LOOKS = ['obsidian', 'porcelain'];
let bad = 0;
for (const [size, viewport] of SIZES) {
	const s = await open({ name: 'u4views-' + size, signIn: true, connect: true, viewport });
	const p = s.page;
	await p.waitForTimeout(600);
	for (const look of LOOKS) {
		await p.evaluate((t) => { window.DaimondLook && window.DaimondLook.set('daylight'); window.DaimondTheme.set(t); }, look);
		await p.waitForTimeout(500);
		for (const v of ['limits', 'search', 'folders']) {
			const r = await p.evaluate(async (v) => {
				document.getElementById('user-row').click();
				await new Promise((r) => setTimeout(r, 500));
				window.DaimondAdmin[v]();
				await new Promise((r) => setTimeout(r, 500));
				if (v === 'folders') for (const k of ['grantroot', 'termroot']) {
					const sec = document.getElementById(k + '-section');
					if (sec) sec.style.display = '';
					const now = document.getElementById(k + '-now');
					if (now) now.textContent = '/home/someone/projects/a-rather-long-folder-name/work';
				}
				const view = document.getElementById('admin-' + v);
				const box = view && view.getBoundingClientRect();
				// Anything wider than the view is a control or label running off its edge.
				const over = view ? [...view.querySelectorAll('*')].filter((e) => {
					const b = e.getBoundingClientRect();
					return b.width && (b.right > box.right + 1 || b.left < box.left - 1);
				}).map((e) => e.id || e.className || e.tagName).slice(0, 5) : ['no view'];
				const x = document.getElementById('admin-close'), xr = x && x.getBoundingClientRect();
				return { close: xr ? [Math.round(xr.left), Math.round(xr.top), Math.round(xr.width), Math.round(xr.height), getComputedStyle(x).display] : null, shown: !!view && view.style.display !== 'none', controls: view ? view.querySelectorAll('select, input, button').length : 0, over };
			}, v);
			const f = await shot(s, `u4-${v}-${size}-${look}`);
			if (!r.shown || r.over.length) bad++;
			console.log(`${v} ${size} ${look}: close=${JSON.stringify(r.close)} shown=${r.shown} controls=${r.controls} overflow=${JSON.stringify(r.over)} ${f}`);
			await p.keyboard.press('Escape');
			await p.waitForTimeout(300);
		}
	}
	const errs = s.errs.filter((e) => !/502|Bad Gateway|\/api\b/.test(e));
	if (errs.length) { bad++; console.log('ERRORS', size, errs.slice(0, 3)); }
	await s.close();
}
console.log(bad ? `\n${bad} view(s) to look at` : '\nall drawn');
process.exit(bad ? 1 : 0);
