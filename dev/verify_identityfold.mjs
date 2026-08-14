// Can a first-time visitor SEE the button they came here to press?
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
//
// The header used to say "L11 scratch ... Not part of the suite. `node
// dev/l11_fold.mjs`". It is `dev/verify_identityfold.mjs`, `run_all.sh` takes
// every `dev/verify_*.mjs` there is, and it has been in the suite since it was
// renamed. It counted its own reds and then exited 0, so the count reached
// nobody. It exits on the count now.
//
// PROVED AGAINST A CARD THAT CANNOT SHOW ITS OWN FOOT FIRST. `--break shortcard`
// caps the card's height, which puts the primary button under the fold at every
// size, and the run is expected to FAIL.
//
//   node dev/verify_identityfold.mjs --break shortcard   # expected to FAIL
//   node dev/verify_identityfold.mjs                     # and then, clean
import { open } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
	return pass;
};

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();
if (BREAK && BREAK !== 'shortcard') {
	console.error(`unknown break '${BREAK}'; known: shortcard`);
	process.exit(2);
}

/// The break is injected on EVERY load, because this file reloads the page
/// half way through to meet the returning visitor.
const breakInto = (page) => page.addInitScript(() => {
	const put = () => {
		const st = document.createElement('style');
		st.textContent = '#identity-modal .modal-card { max-height: 300px !important; overflow-y: auto !important; }';
		document.head.appendChild(st);
	};
	if (document.head) put(); else document.addEventListener('DOMContentLoaded', put);
});

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
	if (!m) return check(`${what}, ${skin} at ${w}x${h}: the card is on screen`, false, 'no card and no #id-primary');
	return check(
		`${what}, ${skin} at ${w}x${h}: "${m.btn.label}" is on screen unscrolled`,
		m.seen,
		`button ${m.btn.top}–${m.btn.bottom}, card edge ${m.card.bottom}, ${m.over}px under the fold`
		+ (m.seen ? '' : `, ${m.by} is drawn over it`));
};

const s = await open({ name: 'identityfold', signIn: false, defaults: false, route: BREAK ? breakInto : null });
const { page } = s;
if (BREAK) console.log(`\n*** RUNNING UNDER --break ${BREAK}: failures below are the point ***\n`);
await page.waitForSelector('#id-primary', { timeout: 15000 });
await page.waitForTimeout(600);

// ── A stranger, who is shown the front door and the tallest form ──
check('the stranger strip is on the screen being measured',
	await page.evaluate(() => !!document.getElementById('id-doors').getClientRects().length), '#id-doors');
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
const mode = await page.evaluate(() => document.getElementById('identity-modal').dataset.mode);
check('the return visit is an unlock screen', mode === 'unlock', `mode=${mode}`);
for (const skin of ['sharp', 'warm']) {
	await at(page, skin, 1500, 950, 'unlock');
	await at(page, skin, 375, 667, 'unlock');
}
// The unlock card is short enough not to scroll at all, which is what makes the
// sticky foot inert there rather than merely harmless.
const un = await look(page);
check('and it does not scroll, so the foot never leaves its place',
	!!un && un.over === 0, un ? `${un.over}px under the fold` : 'no card');

await s.close();
console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) { bad.forEach(x => console.log('  FAILED: ' + x)); process.exit(1); }
