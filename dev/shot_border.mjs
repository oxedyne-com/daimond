// shot_border.mjs — what --border-strong actually looks like.
//
// The numbers say every control now clears 3:1 against the surface it sits on, and
// that a focused field reads 4.19-6.75 against its own unfocused pixels. Neither
// says whether the app still looks like one system: a boundary lifted to a floor is
// a boundary that got darker on a light palette and lighter on a dark one, and
// eleven of those could easily read as eleven different apps.
//
// Four palettes, one from each corner of the tone/ink grid, and for each: the chat
// composer (the field a person looks at most), the settings dialog (the densest run
// of fields in the app), and a field with the focus on it, shot at 3x so the 1px
// boundary and the 2px ring are both legible.
import { open } from './harness.mjs';
import path from 'node:path';
import fs from 'node:fs';

const OUT = path.join(process.cwd(), 'dev', 'shots');
fs.mkdirSync(OUT, { recursive: true });

// light band / dark ink, mid band / light ink, dark band / light ink, and the
// candy one, which is the palette a boundary is easiest to lose in.
const PALETTES = ['light', 'dusk', 'dark', 'lollypop'];

const s = await open({ name: 'border', connect: false });
const p = s.page;
await p.setViewportSize({ width: 1400, height: 900 });
await p.waitForTimeout(1500);

for (const pal of PALETTES) {
	await p.evaluate((name) => window.DaimondTheme.set(name), pal);
	await p.waitForTimeout(400);

	// The settings dialog: the densest run of fields in the app, and the one place
	// where a text input, a select and an outlined button sit within 20px of each
	// other, so an inconsistency between them cannot hide.
	// The Admin drawer, which is where this app keeps the densest run of controls
	// that are not behind an account: rows, an outlined button, the model chip.
	await p.evaluate(() => {
		const u = document.querySelector('#user-row');
		if (u) u.click();
	});
	await p.waitForTimeout(600);
	await p.screenshot({ path: path.join(OUT, `border_${pal}_app.png`) });
	await p.keyboard.press('Escape');
	await p.waitForTimeout(400);

	// A field with the focus on it. `:focus-visible` only arms under a real Tab --
	// Chromium reports `outline: none` for a scripted focus() -- so the focus is
	// moved with the keyboard from wherever the page starts.
	await p.keyboard.press('Tab');
	await p.waitForTimeout(300);
	const focused = await p.evaluate(() => {
		const el = document.activeElement;
		if (!el || el === document.body) return null;
		const r = el.getBoundingClientRect();
		const cs = getComputedStyle(el);
		return {
			sel: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '')
				+ (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/)[0] : ''),
			outline: cs.outlineWidth + ' ' + cs.outlineStyle + ' ' + cs.outlineColor,
			border: cs.borderTopColor,
			box: { x: r.x, y: r.y, w: r.width, h: r.height },
		};
	});
	if (focused && focused.box.w) {
		console.log(`${pal.padEnd(9)} focus on ${focused.sel} — outline ${focused.outline}, border ${focused.border}`);
		await p.screenshot({
			path: path.join(OUT, `border_${pal}_focus.png`),
			clip: {
				x: Math.max(0, focused.box.x - 12), y: Math.max(0, focused.box.y - 12),
				width: focused.box.w + 24, height: focused.box.h + 24,
			},
			scale: 'device',
		});
	} else {
		console.log(`${pal.padEnd(9)} focus: nothing took it`);
	}
}

await s.close();
