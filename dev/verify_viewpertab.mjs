// verify_viewpertab.mjs -- another tab must never move this tab's view.
//
// Reported 2026-10-12 (rc-b 12:30): the owner's tab came back on a Diamond he
// had not opened, with an empty Doc panel open. The restore state -- the open
// Diamond or chat, its face, the open panels -- lived in localStorage, which
// every tab of the origin shares, so a background tab that navigated rewrote
// "where was I" for the tab he was reading, and his next reload obeyed it.
//
// The rule this holds:
//   1. A tab's view is its own: a reload of tab A comes back where A was,
//      whatever tab B did meanwhile.
//   2. B's own view survives B's reload just as well.
//   3. A NEW tab, which has no view of its own, seeds from the device's last
//      view -- and only a FOCUSED tab writes that. A background tab never does.
//
// THE PLACES are two Diamonds where the engine holds Diamonds (Chromium), and
// two chats where it cannot: Playwright's WebKit has no OPFS, so it has no
// Diamond store and the rail is empty. A chat is held to the same rule by the
// same record, so WebKit proves it on chats rather than not at all.
//
// B is made a background tab by its `document.hasFocus()` answering false,
// which is the one fact the app reads to tell the two apart. Every tab of one
// headless context otherwise claims focus at once.
//
//   node dev/verify_viewpertab.mjs                 # Chromium
//   DAIMOND_BROWSER=webkit node dev/verify_viewpertab.mjs
//
// Needs dev/serve.mjs (DAIMOND_PORT). No gateway, no model.

import { open, signInAs, errors, APP } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' -- ' + detail : ''));
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

/// Poll to a deadline; answers whether it came true and never throws.
async function until(fn, ms) {
	const stop = Date.now() + ms;
	while (Date.now() < stop) {
		try { if (await fn()) return true; } catch (e) { /* mid-navigation */ }
		await sleep(250);
	}
	return false;
}

let MODE = 'diamond';		// or 'chat', when the engine has no Diamond store
const LIST = () => MODE === 'diamond' ? '#diamond-list [data-id]' : '#session-list [data-id]';

/// Where the tab is: the current Diamond, or the chat whose rail row is current.
const where = (p) => p.evaluate((mode) => {
	const doc = !!(window.DaimondPanels && DaimondPanels.isOpen && DaimondPanels.isOpen('doc'));
	if (mode === 'chat') {
		const r = document.querySelector('#session-list [data-id][aria-current="true"]');
		return { diamond: r ? (r.dataset.id || '') : '', doc };
	}
	const d = window.DaimondDiamond && DaimondDiamond.current ? DaimondDiamond.current() : null;
	return { diamond: d ? (d.id || '') : '', doc };
}, MODE).catch(() => ({ diamond: '', doc: false }));

/// Land a page signed in and drawn, from a load or a reload.
///
/// `signInAs` itself waits out the boot until there is a gate to drive or an
/// identity already open: reading `locked` first answered too early under
/// WebKit, before the boot had put the lock up, and left tab B locked.
async function ready(s, p) {
	await until(() => p.evaluate(() => window.__DAIMOND_READY === true), 60000);
	// WebKit drives no gate on a page behind another one. Bringing a tab forward
	// does not make it the focused tab: B's `hasFocus` still answers false.
	await p.bringToFront();
	for (let i = 0; i < 2; i++) {
		try { await signInAs({ ...s, page: p }, 'viewtab'); break; }
		catch (e) { if (i) console.log('  (sign-in: ' + String(e.message).slice(0, 160) + ')'); }
	}
	await until(() => p.evaluate(() => !document.body.classList.contains('locked')), 20000);
	await until(() => p.evaluate((sel) => document.querySelectorAll(sel).length >= 2, LIST()), 30000);
}

async function settle(p, want, ms = 30000) {
	let last = await where(p);
	const stop = Date.now() + ms;
	while (Date.now() < stop) {
		if (want(last)) return last;
		await sleep(250);
		last = await where(p);
	}
	return last;
}

const clickDiamond = (p, nth) => p.evaluate(([sel, n]) => {
	const el = document.querySelectorAll(sel)[n];
	if (!el) return '';
	el.click();
	return el.dataset.id || '';
}, [LIST(), nth]);

const s = await open({ name: 'viewtab', connect: false });
const A = s.page;
// Diamonds or chats: see THE PLACES above. Decided once the app is drawn.
await until(() => A.evaluate(() => window.__DAIMOND_READY === true), 60000);
const store = await A.evaluate(() => !!(navigator.storage && navigator.storage.getDirectory)).catch(() => false);
if (!store) {
	MODE = 'chat';
	try { await signInAs(s, 'viewtab'); } catch (e) { /* ready() below tries again */ }
	await until(() => A.evaluate(() => !document.body.classList.contains('locked')), 20000);
	for (let i = 0; i < 2; i++) {
		const n = await A.evaluate(() => document.querySelectorAll('#session-list [data-id]').length);
		await A.evaluate(() => { const b = document.getElementById('new-session-btn'); if (b) b.click(); });
		await until(() => A.evaluate((m) => document.querySelectorAll('#session-list [data-id]').length > m, n), 15000);
	}
}
console.log(`  (places: ${MODE === 'diamond' ? 'two Diamonds' : 'two chats -- this engine has no OPFS, so no Diamond store'})`);
await ready(s, A);

// ── A: on Diamond X, Doc closed, and FOCUSED ─────────────────────────────────
await A.bringToFront();
const X = await clickDiamond(A, 0);
await A.evaluate(() => { if (window.DaimondPanels) DaimondPanels.hide('doc'); });
const aWas = await settle(A, w => w.diamond === X && !w.doc, 10000);
check('0 tab A is on Diamond X with the Doc panel closed',
	!!X && aWas.diamond === X && !aWas.doc, JSON.stringify({ X, aWas }));

// ── B: a BACKGROUND tab opens Diamond Y and the Doc panel ────────────────────
const B = await s.browser.newPage();
await B.addInitScript(() => { document.hasFocus = () => false; });
await B.goto(APP, { waitUntil: 'domcontentloaded' });
await ready(s, B);
const Y = await clickDiamond(B, 1);
await B.evaluate(() => { if (window.DaimondPanels) DaimondPanels.show('doc'); });
const bWas = await settle(B, w => w.diamond === Y && w.doc, 10000);
check('1 background tab B is on Diamond Y with the Doc panel open',
	!!Y && Y !== X && bWas.diamond === Y && bWas.doc, JSON.stringify({ Y, bWas }));
await sleep(500);

// ── 2. A reloads: it must come back to ITS view ──────────────────────────────
await A.bringToFront();
await A.reload({ waitUntil: 'domcontentloaded' });
await ready(s, A);
const aNow = await settle(A, w => w.diamond === X && !w.doc);
check('2a A RELOAD OF TAB A COMES BACK TO A\'S DIAMOND, NOT B\'S',
	!!X && aNow.diamond === X, `came back to ${aNow.diamond || '(none)'}; A was on ${X}, B is on ${Y}`);
check('2b and without the Doc panel B opened', !aNow.doc, `doc open: ${aNow.doc}`);

// ── 3. B reloads: its own view survives too ──────────────────────────────────
await B.reload({ waitUntil: 'domcontentloaded' });
await ready(s, B);
const bNow = await settle(B, w => w.diamond === Y && w.doc);
check('3 a reload of tab B comes back to B\'s Diamond and Doc panel',
	!!Y && bNow.diamond === Y && bNow.doc, JSON.stringify(bNow));

// ── 4. A NEW tab seeds from the FOCUSED tab's view, never the background's ───
const C = await s.browser.newPage();
await C.bringToFront();
await C.goto(APP, { waitUntil: 'domcontentloaded' });
await ready(s, C);
const cNow = await settle(C, w => w.diamond === X);
check('4a A NEW TAB OPENS WHERE THE FOCUSED TAB WAS (X), NOT THE BACKGROUND TAB (Y)',
	!!X && cNow.diamond === X, `new tab opened on ${cNow.diamond || '(none)'}`);
check('4b and without the background tab\'s Doc panel', !cNow.doc, `doc open: ${cNow.doc}`);

const errs = errors(s).filter(e => !/502|Account service/.test(e));
check('5 nothing raised in the console', errs.length === 0, errs.slice(0, 2).join(' | '));

await s.close();
console.log(`\n${ok.length} passed, ${bad.length} failed`);
process.exit(bad.length ? 1 : 0);
