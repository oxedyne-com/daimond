// L11 scratch: can a first-time visitor SEE the button they came here to press?
// Not part of the suite. `node dev/l11_fold.mjs`
//
// The question is asked the way a person meets the screen: the card at the top
// of its own scroll, nothing scrolled into view first, and `elementFromPoint`
// over the middle of the button rather than its bounding box. A box is returned
// for an element nobody can see, which is how the identity card came to hold a
// "Create account" button 25px below its own bottom edge on 2026-08-14 with
// every check still green.
//
// It is NOT enough to sample near the button's top edge. A card that overflows
// by less than the button's height leaves the top of it showing, and a check
// that photographs a few pixels there passes on a button whose label is cut in
// half. `verify_contrast_ui` samples at `top + 4` and scrolls the button into
// view before it does -- it is asking "is this pixel really the button", which
// is a fair question about a photograph and a poor one about a fold. Hence this.
import { open } from './harness.mjs';

const out = [];
const ok = (good, what, detail) => { out.push(`${good ? 'PASS' : 'FAIL'}  ${what}${detail ? ' — ' + detail : ''}`); return good; };

/// Where the button is, and whether the button is what is painted over its
/// middle -- with the card put back to the top first, because a fold is about
/// what greets somebody, not about what they can reach.
const look = (page) => page.evaluate(() => {
	const card = document.querySelector('#identity-modal .modal-card');
	const btn  = document.getElementById('id-primary');
	if (!card || !btn) return null;
	card.scrollTop = 0;
	const cr = card.getBoundingClientRect();
	const br = btn.getBoundingClientRect();
	const hit = document.elementFromPoint(br.left + br.width / 2, br.top + br.height / 2);
	return {
		card:  { top: +cr.top.toFixed(1), bottom: +cr.bottom.toFixed(1) },
		btn:   { top: +br.top.toFixed(1), bottom: +br.bottom.toFixed(1), label: (btn.textContent || '').trim() },
		over:  card.scrollHeight - card.clientHeight,
		seen:  !!(hit && (hit === btn || btn.contains(hit))),
		by:    hit ? hit.tagName.toLowerCase() + (hit.id ? '#' + hit.id : '') : 'nothing',
	};
});

const at = async (page, skin, w, h, what) => {
	await page.evaluate((sk) => document.documentElement.setAttribute('data-skin', sk), skin);
	await page.setViewportSize({ width: w, height: h });
	await page.waitForTimeout(350);
	const m = await look(page);
	if (!m) return ok(false, `${what}, ${skin} at ${w}x${h}: the card is not on screen`);
	return ok(m.seen,
		`${what}, ${skin} at ${w}x${h}: "${m.btn.label}" is on screen unscrolled`,
		`button ${m.btn.top}–${m.btn.bottom}, card edge ${m.card.bottom}, ${m.over}px under the fold`
		+ (m.seen ? '' : `, ${m.by} is drawn over it`));
};

const s = await open({ name: 'l11-fold', signIn: false, defaults: false });
const { page } = s;
await page.waitForSelector('#id-primary', { timeout: 15000 });
await page.waitForTimeout(600);

// ── A stranger, who is shown the front door and the tallest form ──
ok(await page.evaluate(() => !!document.getElementById('id-doors').getClientRects().length),
	'the stranger strip is on the screen being measured');
for (const skin of ['sharp', 'warm']) {
	await at(page, skin, 1500, 950, 'create');		// the laptop of the report
	await at(page, skin, 1280, 800, 'create');		// a smaller one
	await at(page, skin, 375, 812, 'create');		// a phone
	await at(page, skin, 375, 667, 'create');		// the shortest phone still current
}

// ── And somebody coming back, who must be no worse off ────────────
await page.evaluate(() => document.documentElement.setAttribute('data-skin', 'warm'));
await page.setViewportSize({ width: 1500, height: 950 });
await page.fill('#id-name', 'Returning');
await page.evaluate(() => { const w = document.getElementById('id-wrote'); if (w && !w.checked) w.click(); });
await page.waitForTimeout(150);
await page.locator('#id-primary').click();
await page.waitForTimeout(4000);
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
await page.reload();
await page.waitForSelector('#id-primary', { timeout: 15000 });
await page.waitForTimeout(2000);
ok(await page.evaluate(() => document.getElementById('identity-modal').dataset.mode) === 'unlock',
	'the return visit is an unlock screen');
for (const skin of ['sharp', 'warm']) {
	await at(page, skin, 1500, 950, 'unlock');
	await at(page, skin, 375, 667, 'unlock');
}
// The unlock card is short enough not to scroll at all, which is what makes the
// sticky foot inert there rather than merely harmless.
const un = await look(page);
ok(un.over === 0, 'and it does not scroll, so the foot never leaves its place', `${un.over}px under the fold`);

console.log(out.join('\n'));
console.log(out.some(l => l.startsWith('FAIL')) ? 'SOME FAILED' : 'ALL PASSED');
await s.close();
