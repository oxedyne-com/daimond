// verify_crystalfull.mjs — the crystal face's full-screen toggle (piece b).
//
// The lane that wrote the toggle died mid-verification, so for a while nothing
// drove it. What its own comments promise, and what is held to here:
//
//   * the control appears on the CRYSTAL face and nowhere else;
//   * pressing it sets `data-cfull`, which takes the top bar, the rail and the
//     dock away;
//   * Escape leaves it, and the control is still on screen to leave it with;
//   * leaving the crystal face puts the mode down;
//   * it does not survive a reload.
//
//   node dev/verify_crystalfull.mjs
//
// It writes no path down: `harness.mjs` is imported relative to this file, and the one
// screenshot goes to the harness scratch root — never into `www/`, whose bytes ship.
import { open, scratch } from './harness.mjs';

let failures = 0;
const check = (cond, msg, detail) => {
	console.log((cond ? '  ok   ' : '  FAIL ') + msg + (detail != null ? ' — ' + detail : ''));
	if (!cond) failures++;
};

const state = (p) => p.evaluate(() => {
	const drawn = (sel) => { const e = document.querySelector(sel);
		return !!(e && e.getClientRects().length); };
	const b = document.getElementById('crystal-full-btn');
	return {
		attr:   document.documentElement.getAttribute('data-cfull'),
		btn:    b ? { drawn: !!b.getClientRects().length, pressed: b.getAttribute('aria-pressed'),
			label: b.getAttribute('aria-label'), word: (document.getElementById('crystal-full-txt') || {}).textContent } : null,
		topbar: drawn('.topbar'),
		rail:   drawn('#panel-rail'),
		dock:   drawn('.dock'),
		bar:    drawn('.panel.ai .crystal-bar'),
		frame:  drawn('#crystal-frame-wrap'),
		body:   drawn('#crystal-body'),
	};
});

const s = await open({ name: 'cfull', connect: false });
const p = s.page;
await p.waitForTimeout(1500);

try {
	// A seeded default Diamond; the face it opens on is the crystal.
	await p.evaluate(() => {
		const box = document.querySelector('.diamond-box');
		if (box) box.click();
	});
	await p.waitForTimeout(1800);

	const rest = await state(p);
	console.log('  rest ' + JSON.stringify(rest));
	check(!!rest.btn && rest.btn.drawn, 'the control is on the crystal face');
	check(rest.btn && rest.btn.pressed === 'false', 'and says it is not pressed');
	check(rest.btn && !rest.btn.word, 'with no word beside the glyph while the mode is off',
		JSON.stringify(rest.btn && rest.btn.word));
	check(rest.attr === null, 'and nothing is covering the app');

	await p.click('#crystal-full-btn');
	await p.waitForTimeout(500);
	const on = await state(p);
	console.log('  on   ' + JSON.stringify(on));
	check(on.attr === '1', 'pressing it sets data-cfull');
	check(!on.topbar && !on.rail && !on.dock, 'the top bar, the rail and the dock go',
		JSON.stringify({ topbar: on.topbar, rail: on.rail, dock: on.dock }));
	check(on.btn && on.btn.drawn, 'AND THE WAY OUT IS STILL ON SCREEN');
	check(on.btn && on.btn.pressed === 'true' && /exit/i.test(on.btn.label || ''),
		'saying what pressing it will do', JSON.stringify(on.btn));
	check(!!(on.btn && on.btn.word), 'with the word beside the glyph', JSON.stringify(on.btn && on.btn.word));
	check(on.body, 'and the crystal is still drawn (reflow did not tear it down)');
	await p.screenshot({ path: scratch('cfull-on.png') });

	// Escape, from the app's own focus.
	await p.keyboard.press('Escape');
	await p.waitForTimeout(400);
	const esc = await state(p);
	check(esc.attr === null && esc.topbar && esc.rail, 'Escape leaves it', JSON.stringify(esc.attr));

	// Leaving the crystal face puts the mode down rather than leaving a covered
	// app with no subject.
	await p.click('#crystal-full-btn');
	await p.waitForTimeout(400);
	check((await state(p)).attr === '1', 'back in');
	await p.evaluate(() => { const b = document.getElementById('dview-chat'); if (b) b.click(); });
	await p.waitForTimeout(800);
	const face = await state(p);
	check(face.attr === null, 'switching to the chat face puts the mode down');
	check(!(face.btn && face.btn.drawn), 'and the control goes with the face it belongs to');

	// It does not survive a reload.
	await p.evaluate(() => { const b = document.getElementById('dview-crystal'); if (b) b.click(); });
	await p.waitForTimeout(700);
	await p.click('#crystal-full-btn');
	await p.waitForTimeout(400);
	check((await state(p)).attr === '1', 'in again, before the reload');
	await p.reload({ waitUntil: 'domcontentloaded' });
	await p.waitForTimeout(1500);
	check((await state(p)).attr === null, 'a reload does not come back inside the mode');
} catch (e) {
	console.log('  FAIL threw — ' + (e && e.message));
	failures++;
} finally {
	const errs = s.errs.filter(e => !/favicon|manifest|502|Bad Gateway|gateway/i.test(e));
	if (errs.length) console.log('  console errors: ' + errs.slice(0, 6).join(' | '));
	await s.close();
}
console.log(failures ? failures + ' failure(s)' : 'all checks passed');
process.exit(failures ? 1 : 0);
