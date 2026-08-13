// probe_sheetcancel.mjs — what the sheet does when the browser takes the gesture.
//
// A drag on the grabber is a pointer stream, and a pointer stream can end in
// `pointercancel` rather than `pointerup` — which is exactly what happens when the
// browser decides mid-drag that the gesture is its own (a pan, a back-swipe, a
// scroll it has claimed). `bindGrab` listens for `pointerup` only.
//
//   eval "$(bash dev/world.sh 13 --env)"
//   node dev/probe_sheetcancel.mjs
import { open, scratch } from './harness.mjs';

const s = await open({ name: 'sheetcancel', profile: scratch('pw', 'sheetcancel'), touch: true });
const { page } = s;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const state = (tag) => page.evaluate((tag) => {
	const sh = document.getElementById('msheet');
	return { tag, h: Math.round(sh.getBoundingClientRect().height),
		dragging: sh.classList.contains('dragging') };
}, tag);

try {
	await page.waitForTimeout(1200);
	await page.keyboard.press('Escape');
	await sleep(400);
	await page.setViewportSize({ width: 390, height: 844 });
	await sleep(600);
	await page.evaluate(() => window.DaimondSheet.open('web'));
	await sleep(900);
	console.log(JSON.stringify(await state('sheet up')));

	// A drag that the browser then claims for itself.
	await page.evaluate(() => {
		const g = document.getElementById('msheet-grab');
		const r = g.getBoundingClientRect();
		const y = r.top + r.height / 2;
		const ev = (type, cy) => g.dispatchEvent(new PointerEvent(type, {
			pointerId: 1, pointerType: 'touch', isPrimary: true,
			clientX: 195, clientY: cy, bubbles: true, cancelable: true }));
		ev('pointerdown', y);
		ev('pointermove', y + 140);
		ev('pointercancel', y + 140);
	});
	await sleep(400);
	console.log(JSON.stringify(await state('after the browser cancelled the drag')));

	// And what that costs: a keyboard show/hide no longer re-fits the sheet,
	// because the re-fit is skipped while `.dragging` is on.
	await page.setViewportSize({ width: 390, height: 600 });
	await sleep(700);
	console.log(JSON.stringify(await state('after the viewport shrank (keyboard up)')));
} finally {
	await s.close();
}
