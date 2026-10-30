// gateway: none
// verify_railmobile.mjs — the rail as the phone's HOME PAGE (Stack A1, 30 Oct 2026;
// until then the drawer's sections), and the desktop rail proving it paid nothing for it.
//
// Owner's report, 2026-09-14, from the iPhone home-screen PWA: "the height of the
// diamond and chat sections in the rail in mobile view is impractically small, see
// for yourself." Measured at 390x844 with ten Diamonds and twenty-five chats, on
// the build he was running:
//
//   #rail-top      483px      of the drawer's 828
//   #diamond-list  150px      content 549px   —  2 of 10 Diamonds whole
//   #session-list  146px      content 2538px  —  1 of 25 chats whole
//   #admin         345px      the eleven status rows, `flex: none`
//
// Nothing in the drawer was wrong by itself. `.panel.rail .diamond-list/.session-list`
// (www/css/mobile.css) give the two lists an even share of whatever `#rail-top` is
// left, and `#rail-top` is what `#admin` leaves — and `#admin` is `flex: none` over a
// stack of status rows that responsive.css lifts to ~40px each for a thumb. So the
// status strip took 345px of 828 from the two lists it sits under, and the desktop's
// lever on that — `#handle-rail-split` — is hidden on a phone with `applyRailSplit`
// early-returning, so no user action could give either list a pixel more.
//
// The fix is a fold per section (mobile.js `bindFolds`): Diamonds and Chats open, the
// status rows away, each open list bounded and scrolling inside itself, and the state
// kept per DEVICE. Folding one list gives its room to the other, which is the lever the
// phone had lost.
//
// 2026-10-08 (D-20261008-14): the STATUS fold alone now reaches a desktop (shut by default,
// see dev/verify_rail_status.mjs). Diamonds and Chats still pay nothing there, and the desktop
// section below says so; it presses the status toggle before it reads the rows.
//
// FOUR CONTEXTS, and the third of them needs a word. Playwright's WebKit build exposes
// no `navigator.storage` at all, so `create_diamond` fails there ("this browser exposes
// no getDirectory") and a Diamond cannot exist in it — the engine an iPhone runs is the
// one this harness cannot hold a Diamond in. The Diamonds-list ROW COUNTS are therefore
// measured in a mobile-emulated Chromium of the same width, and everything that does not
// need a Diamond is measured on WebKit, which is what the owner's phone runs.
//
//   bash dev/world.sh 34 --up
//   DAIMOND_APP=http://localhost:8811 node dev/verify_railmobile.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, signInAs, errors, statusRow } from './harness.mjs';
import { guardRan } from './verdict.mjs';

const HERE  = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(HERE, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 '
	+ '(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

/// A signed-in session with eight Diamonds and twenty-five chats in it.
///
/// The Diamonds go through the engine's own `create_diamond`, so they are Diamonds
/// rather than rows somebody drew; the chats go straight into the `daimond-chats`
/// store, which is where `ChatStore.boot` reads them from, because twenty-five real
/// turns would take minutes and this file measures geometry, not conversation.
async function world({ name, browser, width, height }) {
	const s = await open({ name, browser, touch: true, connect: false, ua: IPHONE_UA });
	await s.page.setViewportSize({ width, height });
	await s.page.waitForFunction(() => !!window.DaimondCore, null, { timeout: 30000 });
	const diamonds = await s.page.evaluate(async () => {
		const m = await import('/pkg/oxedyne_daimond.js');
		const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
		const names = ['Webster & Fernhill', 'Approval Application', 'Charles Houston essay',
			'Mum', 'My health', 'Tax 2026', 'House move', 'Reading list'];
		for (const n of names) { try { await app.create_diamond(n); } catch (e) { /* no OPFS here */ } }
		try { return JSON.parse(await app.list_diamonds()).length; } catch (e) { return 0; }
	});
	await s.page.evaluate(() => new Promise((res) => {
		const now = Date.now(), rows = [];
		for (let i = 0; i < 25; i++) rows.push({
			id: 'railseed' + String(i).padStart(3, '0'),
			name: 'Seeded chat number ' + (i + 1),
			createdAt: now - i * 3600e3, updatedAt: now - i * 3600e3,
			messages: [], msgCount: 2, model: 'mock/fast',
		});
		const req = indexedDB.open('daimond-chats');
		req.onsuccess = () => {
			const db = req.result;
			let t;
			try { t = db.transaction('chats', 'readwrite'); } catch (e) { res(); return; }
			rows.forEach((r) => t.objectStore('chats').put(r));
			t.oncomplete = () => {
				// The store refuses to vouch for a read it cannot square with this
				// count, and an unvouched boot raises the save alarm over the rail.
				try { localStorage.setItem('daimond-chats-count', String(rows.length)); } catch (e) {}
				res();
			};
			t.onerror = () => res();
		};
		req.onerror = () => res();
	}));
	await s.page.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(s, s.name);
	await s.page.waitForTimeout(1600);
	return { s, diamonds };
}

/// Bring the home page to the top and let it settle: A2's `DaimondShell.home()` once
/// the stack has a history, and before that the page opens on it.
async function home(p) {
	await p.evaluate(() => {
		if (window.DaimondShell && DaimondShell.home) DaimondShell.home();
		else if (window.DaimondStack && DaimondStack.top() !== 'home') DaimondStack.push('home');
	});
	await p.waitForTimeout(400);
}

/// The home page's own parts: where the rail sits, the stack's top, the head, the
/// group heads, the tray acts drawn and the pools.
const homeSurvey = (p) => p.evaluate(() => {
	const rail = document.getElementById('panel-rail');
	const page = document.querySelector('#phone-stack > [data-page="home"]');
	const shown = (e) => {
		if (!e) return false;
		const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
		return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
	};
	const rect = (e) => { const r = e.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom) }; };
	const acts = [...document.querySelectorAll('#home-head .home-act')].map((b) => Math.round(Math.min(b.offsetWidth, b.offsetHeight)));
	const tray = [...document.querySelectorAll('#diamond-list .session-box :is(.tile-cog, .tile-x), #session-list .session-box :is(.tile-cog, .tile-x)')];
	return {
		inHome:    !!(page && rail && page.contains(rail)),
		pageShown: shown(page) || shown(rail),
		top:       window.DaimondStack ? DaimondStack.top() : null,
		head:      { drawn: shown(document.getElementById('home-head')) },
		lockup:    shown(document.querySelector('#home-head .home-lockup')),
		acts,
		heads:     [...document.querySelectorAll('#panel-rail .railhead > span:first-child')].filter(shown).map((e) => e.textContent.trim()),
		newActs:   [...document.querySelectorAll('#panel-rail .railhead > .railbtn')].filter(shown).length,
		foldsDrawn: [...document.querySelectorAll('#panel-rail .railhead > .rail-fold')].some(shown),
		trayAll:   tray.length,
		trayShown: tray.filter(shown).filter((b) => { const r = b.getBoundingClientRect(); return r.left < innerWidth; }).length,
		openRows:  document.querySelectorAll('#panel-rail .session-box[data-swipe="open"]').length,
		findShown: shown(document.querySelector('#panel-rail .diamond-find')),
		pools:     [...document.querySelectorAll('#admin .evp')].filter(shown).map(rect),
	};
});

/// Everything this file asserts on, read in one pass so the numbers all describe
/// the same layout.
const survey = (p) => p.evaluate(() => {
	const el  = (sel) => document.querySelector(sel);
	// An ABSENT element reads as a zero-height one rather than as a null, so a
	// build without the control this file is about goes red naming the number it
	// measured instead of throwing on the first `.drawn`.
	const box = (sel) => {
		let e = null;
		try { e = el(sel); } catch (x) { e = null; }        // `:has()` on an old engine
		if (!e) return { h: 0, top: 0, bottom: 0, client: 0, scroll: 0, drawn: false, absent: true };
		const r = e.getBoundingClientRect();
		return { h: Math.round(r.height), top: Math.round(r.top), bottom: Math.round(r.bottom),
			client: e.clientHeight, scroll: e.scrollHeight, drawn: r.height > 0 };
	};
	// A row is VISIBLE when the whole of it is inside its list's box. A row cut by
	// the foot of the list is a row the user has to scroll for, and counting it is
	// how "one chat on screen" got reported as a list of twenty-five.
	const whole = (listSel, rowSel) => {
		const l = el(listSel);
		if (!l) return 0;
		const lr = l.getBoundingClientRect();
		return [...l.querySelectorAll(rowSel)].filter((r) => {
			const b = r.getBoundingClientRect();
			return b.height > 0 && b.top >= lr.top - 1 && b.bottom <= lr.bottom + 1;
		}).length;
	};
	const rowH = (sel) => { const e = el(sel); return e ? Math.round(e.getBoundingClientRect().height) : 0; };
	const folds = {};
	[...document.querySelectorAll('#panel-rail .rail-fold')].forEach((b) => {
		folds[b.getAttribute('data-fold')] = {
			expanded: b.getAttribute('aria-expanded') === 'true',
			drawn:    getComputedStyle(b).display !== 'none',
			box:      Math.round(b.getBoundingClientRect().height),
		};
	});
	const heading = document.querySelector('#panel-rail .railhead > span[role="heading"]');
	const hs = heading ? getComputedStyle(heading) : null;
	const foldLast = [...document.querySelectorAll('#panel-rail .railhead')]
		.every((h) => h.querySelector('.rail-fold') === h.lastElementChild);
	return {
		vw: innerWidth, vh: innerHeight,
		rail: box('#panel-rail'), scroller: box('#rail-scroll'), railTop: box('#rail-top'),
		diamondList: box('#diamond-list'), sessionList: box('#session-list'),
		admin: box('#admin'), status: box('#admin-status'),
		idRow: box('#panel-rail .astat-id'), userRow: box('#user-row'),
		modelRow: box('#astat-model'), split: box('#handle-rail-split'),
		needs: box('#astat-needs'), calm: box('#astat-summary'), spend: box('#spend-row'),
		headD: box('.railhead:has(.rail-fold[data-fold="diamonds"])'),
		headC: box('.railhead:has(.rail-fold[data-fold="chats"])'),
		diamonds: document.querySelectorAll('#diamond-list .diamond-box').length,
		chats:    document.querySelectorAll('#session-list .session-box').length,
		diamondsWhole: whole('#diamond-list', '.diamond-box'),
		chatsWhole:    whole('#session-list', '.session-box'),
		diamondRowH: rowH('#diamond-list .diamond-box'),
		chatRowH:    rowH('#session-list .session-box'),
		folds,
		headingFlex:  hs ? hs.flexGrow : '',
		headingFirst: !!(heading && heading.matches('.railhead > span:first-child')),
		foldLast:     foldLast,
		state: (window.DaimondShell && DaimondShell.foldState) ? DaimondShell.foldState() : null,
	};
});

/// Tap something, and answer whether there was anything to tap. A build without
/// the control under test must fail the check that needed it, not the run.
async function tap(p, sel) {
	try {
		const loc = p.locator(sel).first();
		if (!(await loc.count())) return false;
		await loc.click({ force: true, timeout: 4000 });
		await p.waitForTimeout(250);
		return true;
	} catch (e) { return false; }
}

// THE EIGHT DIAGNOSTIC ROWS LIVE BEHIND A DISCLOSURE. Since the presentation lane the
// rail carries ONE status line and `#astat-detail` holds the rest, closed on a first
// run -- so `#astat-model` measures 0px until somebody presses the summary, and two
// checks below that measure the rows were reading a deliberately shut drawer as a
// missing row. Opened here, because what those checks are about is where the rows sit
// once they ARE shown, not whether the app shows them unasked.
//
// AND THE SECTION ITSELF IS SHUT BY DEFAULT AT EVERY WIDTH (D-20261008-14): the phone's
// fold was lifted to the desktop, so the identity row's status toggle is pressed first,
// as a user would, and only then the summary.
async function openStatusDetail(p) {
	const folded = await p.evaluate(() => {
		const b = document.querySelector('#panel-rail .rail-fold[data-fold="status"]');
		return !!b && b.getAttribute('aria-expanded') !== 'true';
	});
	if (folded) await tap(p, '#panel-rail .rail-fold[data-fold="status"]');
	const shut = await p.evaluate(() => {
		const d = document.getElementById('astat-detail');
		return !d || d.hidden;
	});
	if (shut) await tap(p, '#astat-summary');
	// D-20261015-15: the calm line opens Settings, where the rows now live. What
	// counts here is a diagnostic row drawn IN THE RAIL, so Settings is shut again.
	const inRail = await p.evaluate(() => {
		const d = document.getElementById('astat-detail');
		return !!d && !d.hidden && !d.classList.contains('astat-in-settings');
	});
	await p.evaluate(() => { if (window.DaimondAdmin && DaimondAdmin.close) DaimondAdmin.close(); });
	await p.waitForTimeout(250);
	return inRail;
}

const consoleClean = (s, where) => {
	// The gateway is deliberately down in a world that asked for none, so its 502s
	// are this world answering honestly rather than the app throwing.
	const e = errors(s).filter((x) => !/favicon|net::ERR|Failed to load resource/.test(x));
	check('no console error in the ' + where + ' context', e.length === 0, e.slice(0, 2).join(' | '));
};

const sessions = [];
try {

// ── The engine the owner runs, at the width he runs it ───────────────────────
// Stack A1 (30 Oct 2026): the drawer is gone from the phone. The rail IS the home page,
// the stack's root: full screen, the Diamonds and Chats lists each a window of its own,
// the status line and the pools pinned at its foot, no fold, and each row's cog and
// Delete in a tray that a swipe or a hold opens.
{
	const { s } = await world({ name: 'railwk390', browser: 'webkit', width: 390, height: 844 });
	sessions.push(s);
	const p = s.page;
	const ua = await p.evaluate(() => navigator.userAgent);
	check('the phone context is WebKit, the engine an iPhone runs',
		/WebKit/.test(ua) && !/Chrome\//.test(ua), ua.slice(0, 48));
	await home(p);
	let m = await survey(p);
	const h = await homeSurvey(p);
	check('the rail is the home page, the root of the stack, with nothing under it to open',
		h.inHome && h.top === 'home' && h.pageShown, JSON.stringify({ inHome: h.inHome, top: h.top, shown: h.pageShown }));
	check('and it is the full 390x844 screen', m.vw === 390 && m.rail.top === 0 && m.rail.h === 844, `${m.rail.top} ${m.rail.h}px`);
	check('its head draws the lockup, search and compose at 44 px a touch',
		h.head.drawn && h.lockup && h.acts.length === 2 && h.acts.every((a) => a >= 44), JSON.stringify(h.acts));
	check('no section fold is drawn on the home page; a page has room',
		!h.foldsDrawn, JSON.stringify(m.folds));
	check('the group heads read Diamonds and Chats, with their New acts',
		h.heads.length >= 2 && h.newActs >= 2, JSON.stringify(h.heads) + ' ' + h.newActs);
	check('every row is at least 44 px tall',
		m.diamondRowH === 0 || m.diamondRowH >= 44 && m.chatRowH >= 44, `diamond ${m.diamondRowH}, chat ${m.chatRowH}`);
	check('no row shows a cog or a Delete until it is swiped or held',
		h.trayShown === 0, `${h.trayShown} of ${h.trayAll} tray acts visible`);
	check('the Chats list is a window of at least five whole rows and scrolls inside itself',
		m.chatsWhole >= 5 && m.sessionList.scroll > m.sessionList.client,
		`${m.chatsWhole} whole of ${m.chats}, list ${m.sessionList.client}/${m.sessionList.scroll}`);
	check('the identity row is pinned on screen at the foot, the only door to Settings',
		m.userRow.drawn && m.userRow.h >= 34 && m.userRow.bottom <= m.vh, `${m.userRow.top}-${m.userRow.bottom} of ${m.vh}`);
	check('and the pools, when there are any, sit on screen under it',
		h.pools.every((b) => b.bottom <= m.vh && b.top >= m.userRow.top), `${h.pools.length} pools`);
	check('the search box waits behind the magnifier', !h.findShown, 'find drawn before the tap');
	await tap(p, '#home-search-btn');
	check('and the magnifier opens it', (await homeSurvey(p)).findShown);
	await tap(p, '#home-search-btn');
	await p.screenshot({ path: path.join(SHOTS, 'railmobile-wk390-home.png') });

	// ── The tray, by a finger's swipe in the real engine ─────────────────
	const row = p.locator('#session-list .session-box').nth(1);
	const box = await row.boundingBox();
	if (box) {
		const y = box.y + box.height / 2;
		await p.mouse.move(box.x + box.width - 40, y);
		await p.mouse.down();
		for (let i = 1; i <= 8; i++) { await p.mouse.move(box.x + box.width - 40 - i * 15, y); await p.waitForTimeout(16); }
		await p.mouse.up();
		await p.waitForTimeout(400);
	}
	const sw = await homeSurvey(p);
	check('a swipe left opens that row\'s tray, its cog and Delete, and only its own',
		sw.openRows === 1 && sw.trayShown === 2, `${sw.openRows} open, ${sw.trayShown} acts`);
	check('and the swipe opened no chat', sw.top === 'home', sw.top);
	await p.screenshot({ path: path.join(SHOTS, 'railmobile-wk390-tray.png') });
	await tap(p, '#session-list .session-box:nth-child(2) .tile-label');
	const shut = await homeSurvey(p);
	check('a tap on the open row shuts the tray rather than opening the chat',
		shut.openRows === 0 && shut.top === 'home', `${shut.openRows} open, top ${shut.top}`);
	await tap(p, '#session-list .session-box .tile-label');
	check('a tap on a shut row opens its chat, a page pushed over home',
		(await homeSurvey(p)).top === 'turn');
	await home(p);

	// ── The hardware the page has to hold itself off ─────────────────────
	await p.addStyleTag({ content: ':root { --safe-t: 44px; --safe-b: 34px; --safe-l: 12px; }' });
	await p.waitForTimeout(250);
	const ins = await p.evaluate(() => {
		const hd = document.getElementById('home-head').getBoundingClientRect();
		const r = document.getElementById('rail-scroll');
		r.scrollTop = r.scrollHeight;
		const last = document.getElementById('admin').getBoundingClientRect();
		const out = { headPad: getComputedStyle(document.getElementById('home-head')).paddingTop,
			headTop: Math.round(hd.top), foot: Math.round(last.bottom), vh: innerHeight };
		r.scrollTop = 0;
		return out;
	});
	check('the head clears the notch', ins.headPad === '44px', ins.headPad);
	check('and nothing runs under the home indicator', ins.foot <= ins.vh - 34, `foot ${ins.foot}, screen ${ins.vh}`);

	// ── The keyboard, which `100dvh` does not shrink for ─────────────────
	await p.evaluate(() => document.documentElement.style.setProperty('--vvh', '500px'));
	await p.waitForTimeout(250);
	const kb = await survey(p);
	check('a raised keyboard shortens the page, which scrolls rather than cutting a list',
		kb.rail.h === 500 && kb.scroller.scroll > kb.scroller.client,
		`page ${kb.rail.h}px scroll ${kb.scroller.client}/${kb.scroller.scroll}`);
	await p.evaluate(() => document.documentElement.style.removeProperty('--vvh'));

	consoleClean(s, 'WebKit 390x844');
}

// ── The smallest phone still sold ────────────────────────────────────────────
{
	const { s } = await world({ name: 'railwk375', browser: 'webkit', width: 375, height: 667 });
	sessions.push(s);
	const p = s.page;
	await home(p);
	const m = await survey(p);
	check('at 375x667 the home page fills the screen and the Chats list shows three whole rows',
		m.rail.h === 667 && m.chatsWhole >= 3, `${m.rail.h}px, ${m.chatsWhole} whole of ${m.chats}`);
	check('and the identity row is still on screen', m.userRow.drawn && m.userRow.bottom <= m.vh, `${m.userRow.bottom} of ${m.vh}`);
	await p.screenshot({ path: path.join(SHOTS, 'railmobile-wk375-home.png') });
	consoleClean(s, 'WebKit 375x667');
}

// ── The Diamonds rows, which WebKit cannot hold ──────────────────────────────
{
	const { s, diamonds } = await world({ name: 'railcr390', browser: 'chromium', width: 390, height: 844 });
	sessions.push(s);
	const p = s.page;
	check('the Chromium phone context really holds the Diamonds (WebKit has no OPFS here)',
		diamonds >= 8, diamonds + ' in the store');
	await home(p);
	const m = await survey(p);
	check('the Diamonds list shows five whole rows, as the mock does',
		m.diamondsWhole >= 5, `${m.diamondsWhole} whole of ${m.diamonds}, list ${m.diamondList.client}px`);
	check('each a row of at least 44 px', m.diamondRowH >= 44, m.diamondRowH + 'px');
	check('and no Diamond row shows its cog or Delete',
		(await homeSurvey(p)).trayShown === 0);
	await p.screenshot({ path: path.join(SHOTS, 'railmobile-cr390-home.png') });
	consoleClean(s, 'Chromium 390x844');
}
// ── The desktop, which must not have paid for any of it ──────────────────────
{
	const s = await open({ name: 'raildesk', browser: 'chromium', connect: false });
	sessions.push(s);
	const p = s.page;
	await p.setViewportSize({ width: 1280, height: 800 });
	await p.waitForTimeout(1200);
	await p.evaluate(() => DaimondPanels.show('rail'));
	await p.waitForTimeout(500);
	const m0 = await survey(p);
	check('a desktop\'s status section is its identity row, exceptions, calm line and tally alone',
		m0.idRow.drawn && !m0.modelRow.drawn && m0.admin.h <= m0.idRow.h + m0.needs.h + m0.calm.h + m0.spend.h + 20,
		`identity ${m0.idRow.h}px, needs ${m0.needs.h}px, calm ${m0.calm.h}px, tally ${m0.spend.h}px, #admin ${m0.admin.h}px`);
	const hd = await homeSurvey(p);
	check('the desktop rail stays in #main, with no home head and its own cog and Delete',
		!hd.inHome && !hd.head.drawn && hd.trayAll > 0 && hd.openRows === 0, JSON.stringify({ inHome: hd.inHome, head: hd.head.drawn }));
	const deskDetailOpen = await openStatusDetail(p);
	const m = await survey(p);
	// No fold is drawn on a desktop: the status chevron went with its rows (lead, 16 Oct).
	check('no section fold is drawn on a desktop',
		Object.keys(m.folds).length === 3
			&& m.folds.status.drawn === false && m.folds.diamonds.drawn === false && m.folds.chats.drawn === false,
		JSON.stringify(Object.keys(m.folds).map((k) => k + ':' + m.folds[k].drawn)));
	check('the desktop keeps its own lever, the split handle between the two lists',
		m.split && m.split.drawn, m.split ? m.split.h + 'px' : 'absent');
	const inSettings = await statusRow(p, '#astat-model');
	await p.evaluate(() => { if (window.DaimondAdmin && DaimondAdmin.close) DaimondAdmin.close(); });
	await p.waitForTimeout(300);
	check('and every status row, in Settings > This device', !deskDetailOpen && inSettings,
		`rail detail ${deskDetailOpen}, #astat-model in Settings ${inSettings}`);
	// THE TRAP THE FOLD CONTROL WOULD HAVE SPRUNG. `.railhead > span:first-child` is
	// what makes the heading a heading — in app.css, skin-warm.css and improve.css —
	// so a control placed BEFORE it restyles every railhead in the app, desktop
	// included. It goes last in the row for this reason, and this is the check that
	// says so out loud.
	check('the heading is still the railhead\'s first child, and the fold its last',
		m.headingFirst && m.foldLast && m.headingFlex === '1',
		`first-child ${m.headingFirst}, fold last ${m.foldLast}, flex-grow ${m.headingFlex}`);
	// The attributes are written at every width; only the status section's rules sit
	// outside the phone breakpoint. Proven rather than asserted: the phone's Diamonds
	// and Chats state is forced onto a desktop rail and nothing moves.
	const moved = await p.evaluate(() => {
		const r = document.getElementById('panel-rail');
		const h = () => ['#diamond-list', '#session-list', '#admin-status', '#admin']
			.map((sel) => Math.round(document.querySelector(sel).getBoundingClientRect().height)).join(',');
		const was = h();
		['diamonds', 'chats'].forEach((k) => r.setAttribute('data-fold-' + k, 'off'));
		const now = h();
		['diamonds', 'chats'].forEach((k) => r.setAttribute('data-fold-' + k, 'on'));
		return { was, now };
	});
	check('and a phone\'s Diamonds and Chats fold state forced onto the desktop rail moves nothing',
		moved.was === moved.now, `${moved.was} → ${moved.now}`);
	await p.screenshot({ path: path.join(SHOTS, 'railmobile-desktop-1280.png') });
	consoleClean(s, 'Chromium desktop');
}

} finally {
	for (const s of sessions) { try { await s.close(); } catch (e) { /* already gone */ } }
}

guardRan(ok.length + bad.length);
console.log(`\n${ok.length} ok, ${bad.length} failed`);
if (bad.length) { bad.forEach((b) => console.log('  FAILED: ' + b)); process.exit(1); }
