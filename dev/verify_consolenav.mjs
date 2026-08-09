// verify_consolenav.mjs -- the operator console's section rail.
//
// The console was one column of nine cards and the reader scrolled past eight
// of them to reach the ninth. It is now a vertical tab set. This proves the
// properties that makes true, rather than that some buttons exist:
//
//   * exactly one section is shown at any moment, and it is the chosen one;
//   * the rail's aria-selected agrees with what is displayed, always -- the
//     screen reader and the eye must not be told different things;
//   * the fragment names the section, so an operator can send someone to one,
//     and a reload lands back on it;
//   * arrow keys walk the rail, because it is marked up as a tablist and a
//     tablist that does not is a lie;
//   * an account with no grant has no Operators tab, AND a link to #operators
//     falls back rather than selecting a tab that is not there.
//
// The gateway is not needed: every /api/admin view is answered from a stub, so
// this tests the page and nothing else. Run against any world's dev server.
//
//   node dev/verify_consolenav.mjs                 # all checks
//   node dev/verify_consolenav.mjs --break one     # showView stops hiding others
//   node dev/verify_consolenav.mjs --break aria    # aria-selected left behind
//   node dev/verify_consolenav.mjs --break hash    # the fragment is not written
//   node dev/verify_consolenav.mjs --break grant   # the Operators tab always drawn
//   node dev/verify_consolenav.mjs --break head    # the sticky offset goes back to
//                                                    a hard-coded 53px
//
// Each --break is a defect the checks below are supposed to catch. If a break
// runs green, the check for it is worthless and should be rewritten.

import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const APP = process.env.DAIMOND_APP || `http://localhost:${process.env.DAIMOND_PORT || 8777}`;
const PW  = process.env.DAIMOND_PW
	|| path.join(os.homedir(), '.red-pw/node_modules/playwright-core/index.mjs');
const CHROME = process.env.DAIMOND_CHROME
	|| `${process.env.HOME}/.cache/ms-playwright/chromium-1229/chrome-linux64/chrome`;

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i >= 0 ? (process.argv[i + 1] || 'one') : null;
})();

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' -- ' + detail : ''));
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// The seven sections, in rail order. Named here rather than read off the page,
// so a section silently dropped from the markup fails a check instead of
// shrinking the test with it.
const VIEWS = ['overview', 'money', 'accounts', 'capacity', 'settings', 'releases', 'operators'];

// ── The stub gateway ────────────────────────────────────────
// Enough of each view for the page to render without throwing. The rail does
// not depend on any of it; what matters is that a failing card cannot be
// mistaken for a failing rail.
function stubFor(role) {
	const grant = (role === 'owner');
	return {
		whoami:      { ok: true, account_id: 'acct_test', client_fp: '0000 0000 0000 0000',
		               role, can_grant: grant },
		summary:     { ok: true, health: { store_ok: true, api: 1 }, accounts: 0,
		               revenue: [], credits_minor: 0, spend_minor: 0 },
		revenue:     { ok: true, days: [] },
		consumption: { ok: true, days: [], services: [] },
		geo:         { ok: true, rows: [] },
		accounts:    { ok: true, rows: [], page: 0, pages: 1, total: 0 },
		ledger:      { ok: true, rows: [], page: 0, pages: 1, total: 0 },
		releases:    { ok: true, declared: [], planned: null, builds: [] },
		operators:   { ok: true, rows: [] },
		capacity:    { ok: true, storage: null, egress: null },
		settings:    { ok: true, groups: [] },
		secrets:     { ok: true, items: [] },
	};
}

async function openConsole(browser, role, hash) {
	const page = await browser.newPage();
	const stub = stubFor(role);
	await page.route('**/api/admin*', async route => {
		const view = new URL(route.request().url()).searchParams.get('view');
		const body = stub[view] || { ok: true };
		await route.fulfill({ status: 200, contentType: 'application/json',
			body: JSON.stringify(body) });
	});
	if (BREAK) await page.addInitScript(mode => { window.__navBreak = mode; }, BREAK);
	await page.goto(APP + '/console/' + (hash || ''), { waitUntil: 'domcontentloaded' });
	await page.waitForSelector('#admin-app:not([hidden])', { timeout: 15000 });
	await sleep(400);
	return page;
}

/// Click a rail item, having first established that it could really be clicked.
///
/// Every click in this tree is a force-click, because Playwright's "stable"
/// actionability check never settles here -- this browser produces no animation
/// frames, so the check waits for a second frame that never comes and hangs on
/// a button that is perfectly fine (see the same note throughout harness.mjs).
///
/// A force-click skips exactly the checks that would have caught a tab which is
/// invisible or sitting under the sticky header, so those are asserted here
/// instead of being thrown away with them: real size, and the topmost element
/// at its own centre being the button itself.
async function clickTab(page, v) {
	const sel = `#admin-nav .admin-nav-item[data-view="${v}"]`;
	const reach = await page.evaluate(s => {
		const b = document.querySelector(s);
		if (!b) return { ok: false, why: 'no such tab' };
		// Below 860px the rail is a strip that scrolls sideways, so a later tab
		// starts off-screen and a reader swipes to it. Do that first, then ask
		// whether it can be reached -- the question is whether the tab is
		// obstructed, not whether it happened to be in view.
		b.scrollIntoView({ block: 'nearest', inline: 'nearest' });
		const r = b.getBoundingClientRect();
		if (r.width < 8 || r.height < 8) return { ok: false, why: `box ${r.width}x${r.height}` };
		const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
		if (top !== b && !b.contains(top)) {
			return { ok: false, why: 'covered by ' + (top ? top.tagName + '.' + top.className : 'nothing') };
		}
		return { ok: true };
	}, sel);
	check(`the ${v} tab is reachable by a real pointer`, reach.ok, reach.why);
	await page.click(sel, { force: true });
	await sleep(120);
}

/// What the page is actually showing, read from the DOM rather than from what
/// the rail claims: the whole point is to catch the two disagreeing.
async function state(page) {
	return page.evaluate(views => {
		const shown = views.filter(v => {
			const p = document.getElementById('view-' + v);
			return p && !p.hidden;
		});
		const selected = Array.from(document.querySelectorAll('#admin-nav .admin-nav-item'))
			.filter(b => b.getAttribute('aria-selected') === 'true')
			.map(b => b.dataset.view);
		const tabs = Array.from(document.querySelectorAll('#admin-nav .admin-nav-item'))
			.filter(b => !b.hidden).map(b => b.dataset.view);
		return { shown, selected, tabs, hash: location.hash };
	}, VIEWS);
}

const pwUrl = pathToFileURL(PW).href;
const { chromium } = await import(pwUrl);
// Launched as dev/harness.mjs launches. No mode on this host produces animation
// frames -- measured, on a blank page, in both headless modes -- which is why
// every click here is forced and clickability is asserted separately.
const browser = await chromium.launch({ executablePath: CHROME, headless: false,
	args: ['--no-sandbox', '--disable-dev-shm-usage', '--headless=new'] });

try {
	// ── An owner sees every section, one at a time ──────────
	const page = await openConsole(browser, 'owner');

	{
		const s = await state(page);
		check('the rail carries all seven sections',
			VIEWS.every(v => s.tabs.includes(v)),
			'saw ' + s.tabs.join(','));
		check('a fresh load shows Overview and nothing else',
			s.shown.length === 1 && s.shown[0] === 'overview',
			'showing ' + JSON.stringify(s.shown));
	}

	// Every section in turn: chosen, alone, agreed with, and named in the URL.
	for (const v of VIEWS) {
		await clickTab(page, v);
		const s = await state(page);
		check(`choosing ${v} shows ${v} and no other section`,
			s.shown.length === 1 && s.shown[0] === v,
			'showing ' + JSON.stringify(s.shown));
		check(`choosing ${v} marks exactly that tab selected`,
			s.selected.length === 1 && s.selected[0] === v,
			'selected ' + JSON.stringify(s.selected));
		check(`choosing ${v} names it in the fragment`,
			s.hash === '#' + v, 'hash was ' + JSON.stringify(s.hash));
	}

	// ── The fragment survives a reload ──────────────────────
	{
		await clickTab(page, 'settings');
		await page.reload({ waitUntil: 'domcontentloaded' });
		await page.waitForSelector('#admin-app:not([hidden])', { timeout: 15000 });
		await sleep(400);
		const s = await state(page);
		check('a reload lands back on the section that was open',
			s.shown.length === 1 && s.shown[0] === 'settings',
			'showing ' + JSON.stringify(s.shown));
	}

	// ── Arrow keys walk the rail ────────────────────────────
	{
		await clickTab(page, 'overview');
		await page.keyboard.press('ArrowDown');
		await sleep(120);
		let s = await state(page);
		check('ArrowDown moves to the next section',
			s.shown.length === 1 && s.shown[0] === 'money',
			'showing ' + JSON.stringify(s.shown));
		await page.keyboard.press('End');
		await sleep(120);
		s = await state(page);
		check('End moves to the last section',
			s.shown.length === 1 && s.shown[0] === 'operators',
			'showing ' + JSON.stringify(s.shown));
		// Wrapping, because a rail that stops at the end makes the reader
		// change direction to reach the thing one step the other way.
		await page.keyboard.press('ArrowDown');
		await sleep(120);
		s = await state(page);
		check('ArrowDown from the last section wraps to the first',
			s.shown.length === 1 && s.shown[0] === 'overview',
			'showing ' + JSON.stringify(s.shown));
	}

	// ── Only one tab is reachable by Tab ────────────────────
	{
		const tabbable = await page.evaluate(() =>
			Array.from(document.querySelectorAll('#admin-nav .admin-nav-item'))
				.filter(b => !b.hidden && b.tabIndex === 0).length);
		check('the rail costs one Tab stop, not seven', tabbable === 1,
			tabbable + ' items were tabbable');
	}
	await page.close();

	// ── An account with no grant ────────────────────────────
	{
		const p2 = await openConsole(browser, 'operator');
		const s = await state(p2);
		check('an operator gets no Operators tab',
			!s.tabs.includes('operators'), 'tabs ' + s.tabs.join(','));
		check('an operator still gets the other six',
			VIEWS.filter(v => v !== 'operators').every(v => s.tabs.includes(v)),
			'tabs ' + s.tabs.join(','));
		await p2.close();

		// The link somebody sent them. It must not select a tab that is not
		// there, and it must not leave the page showing nothing at all.
		const p3 = await openConsole(browser, 'operator', '#operators');
		const s3 = await state(p3);
		check('#operators without the grant falls back to a real section',
			s3.shown.length === 1 && s3.shown[0] === 'overview',
			'showing ' + JSON.stringify(s3.shown));
		check('#operators without the grant selects no phantom tab',
			s3.selected.length === 1 && s3.selected[0] === 'overview',
			'selected ' + JSON.stringify(s3.selected));
		await p3.close();
	}

	// ── Narrow ──────────────────────────────────────────────
	// The rail lies down into a horizontal strip below 860px, and the header
	// wraps to two lines below 620px. Both change where the sticky rail has to
	// start, which is why that offset is measured rather than written down.
	// A phone width is the case where getting it wrong hides the rail entirely.
	{
		const p5 = await browser.newPage({ viewport: { width: 430, height: 600 } });
		const stub = stubFor('owner');
		await p5.route('**/api/admin*', async route => {
			const view = new URL(route.request().url()).searchParams.get('view');
			await route.fulfill({ status: 200, contentType: 'application/json',
				body: JSON.stringify(stub[view] || { ok: true }) });
		});
		if (BREAK) await p5.addInitScript(mode => { window.__navBreak = mode; }, BREAK);
		await p5.goto(APP + '/console/', { waitUntil: 'domcontentloaded' });
		await p5.waitForSelector('#admin-app:not([hidden])', { timeout: 15000 });
		await sleep(500);

		// Releases is the tallest section, so there is something to scroll --
		// and scrolling is the whole test. A sticky `top` does nothing at rest:
		// at scroll 0 the rail sits in normal flow directly under the header and
		// looks correct whatever the offset says. Only once the page moves does
		// a wrong offset park the rail underneath the header.
		await clickTab(p5, 'releases');
		await p5.evaluate(() => window.scrollTo(0, 400));
		await sleep(250);

		const geom = await p5.evaluate(() => {
			const head = document.getElementById('admin-head').getBoundingClientRect();
			const nav  = document.getElementById('admin-nav').getBoundingClientRect();
			return { headBottom: head.bottom, navTop: nav.top, scrolled: window.scrollY,
				docWidth: document.documentElement.scrollWidth,
				winWidth: window.innerWidth };
		});
		check('at 430px the page actually scrolled, so the next check means something',
			geom.scrolled > 100, 'scrollY ' + geom.scrolled);
		check('at 430px a scrolled rail is not tucked under the header',
			geom.navTop >= geom.headBottom - 1,
			`nav top ${Math.round(geom.navTop)} vs header bottom ${Math.round(geom.headBottom)}`);
		check('at 430px nothing pushes the page sideways',
			geom.docWidth <= geom.winWidth + 1,
			`document ${geom.docWidth} wide in a ${geom.winWidth} window`);

		// The rail still works there, which is the point of measuring at all.
		await clickTab(p5, 'settings');
		const s = await state(p5);
		check('at 430px choosing a section still shows exactly it',
			s.shown.length === 1 && s.shown[0] === 'settings',
			'showing ' + JSON.stringify(s.shown));
		await p5.close();
	}

	// ── A fragment that names nothing ───────────────────────
	{
		const p4 = await openConsole(browser, 'owner', '#nonsense');
		const s = await state(p4);
		check('an unknown fragment falls back to Overview',
			s.shown.length === 1 && s.shown[0] === 'overview',
			'showing ' + JSON.stringify(s.shown));
		await p4.close();
	}
} finally {
	await browser.close();
}

console.log('');
console.log(`passed ${ok.length}, failed ${bad.length}` + (BREAK ? `   [--break ${BREAK}]` : ''));
if (bad.length) { console.log('failures:'); bad.forEach(b => console.log('  - ' + b)); }
process.exit(bad.length ? 1 : 0);
