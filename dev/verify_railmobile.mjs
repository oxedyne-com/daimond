// verify_railmobile.mjs — the rail drawer's SECTIONS on a phone, and the desktop
// rail proving it paid nothing for them.
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
import { open, signInAs, errors } from './harness.mjs';

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

/// Open the drawer and let it settle. The transition is on `transform`, which
/// moves nothing this file measures, but a layout mid-slide is a layout read
/// twice for no reason.
async function drawer(p) {
	await p.evaluate(() => window.DaimondShell && DaimondShell.openDrawer());
	await p.waitForTimeout(400);
}

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
		rail: box('#panel-rail'), railTop: box('#rail-top'),
		diamondList: box('#diamond-list'), sessionList: box('#session-list'),
		admin: box('#admin'), status: box('#admin-status'),
		idRow: box('#panel-rail .astat-id'), cog: box('#settings-btn'),
		modelRow: box('#astat-model'), split: box('#handle-rail-split'),
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

const consoleClean = (s, where) => {
	// The gateway is deliberately down in a world that asked for none, so its 502s
	// are this world answering honestly rather than the app throwing.
	const e = errors(s).filter((x) => !/favicon|net::ERR|Failed to load resource/.test(x));
	check('no console error in the ' + where + ' context', e.length === 0, e.slice(0, 2).join(' | '));
};

const sessions = [];
try {

// ── The engine the owner runs, at the width he runs it ───────────────────────
{
	const { s } = await world({ name: 'railwk390', browser: 'webkit', width: 390, height: 844 });
	sessions.push(s);
	const p = s.page;
	const ua = await p.evaluate(() => navigator.userAgent);
	check('the phone context is WebKit, the engine an iPhone runs',
		/WebKit/.test(ua) && !/Chrome\//.test(ua), ua.slice(0, 48));
	await drawer(p);
	let m = await survey(p);
	check('and the drawer is the full 390x844 screen', m.vw === 390 && m.rail.h === 844);

	check('the drawer opens with Diamonds and Chats open and the status rows away',
		!!m.state && m.state.diamonds === true && m.state.chats === true && m.state.status === false,
		JSON.stringify(m.state));
	check('a folded status section draws its header row and nothing below it',
		m.idRow.drawn && !m.modelRow.drawn && m.admin.h < 90,
		`identity ${m.idRow.h}px, #astat-model ${m.modelRow.h}px, #admin ${m.admin.h}px`);
	check('and the Settings cog survives that fold, which is a phone\'s only route to Settings',
		m.cog.drawn && m.cog.h >= 34, m.cog.h + 'px');
	check('each list is bounded and scrolls inside itself rather than the drawer',
		m.sessionList.scroll > m.sessionList.client && m.rail.scroll === m.rail.client,
		`chats ${m.sessionList.client}/${m.sessionList.scroll}, drawer ${m.rail.client}/${m.rail.scroll}`);
	check('the two lists now hold at least 65% of the drawer (they held 35%)',
		(m.diamondList.h + m.sessionList.h) / m.rail.h >= 0.65,
		`${m.diamondList.h} + ${m.sessionList.h} of ${m.rail.h} = `
			+ Math.round(100 * (m.diamondList.h + m.sessionList.h) / m.rail.h) + '%');
	check('with both sections open the Chats list has room for three tiles (it had 1.5)',
		m.sessionList.client >= 3 * m.chatRowH,
		`${m.sessionList.client}px at ${m.chatRowH}px a tile`);
	await p.screenshot({ path: path.join(SHOTS, 'railmobile-wk390-defaults.png') });

	// ── Tapping a HEADING folds its section ──────────────────────────────
	const tappedHead = await tap(p, '.railhead:has(.rail-fold[data-fold="diamonds"]) > span[role="heading"]');
	m = await survey(p);
	check('tapping the Diamonds heading folds the section',
		tappedHead && m.folds.diamonds && m.folds.diamonds.expanded === false
			&& !m.diamondList.drawn && m.headD.drawn,
		`list ${m.diamondList.h}px, header ${m.headD.h}px`);
	check('and the Chats section then has room for six tiles, and shows six of twenty-five',
		m.sessionList.client >= 6 * m.chatRowH && m.chatsWhole >= 6,
		`${m.sessionList.client}px at ${m.chatRowH}px a tile, ${m.chatsWhole} whole of ${m.chats}`);
	await p.screenshot({ path: path.join(SHOTS, 'railmobile-wk390-diamonds-folded.png') });

	await p.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(s, s.name);
	await p.waitForTimeout(1200);
	await drawer(p);
	m = await survey(p);
	check('the fold is remembered across a reload, on this device',
		!!m.state && m.state.diamonds === false && !m.diamondList.drawn, JSON.stringify(m.state));

	const tappedChev = await tap(p, '.rail-fold[data-fold="diamonds"]');
	m = await survey(p);
	check('tapping the chevron opens it again',
		tappedChev && m.state && m.state.diamonds === true && m.diamondList.drawn
			&& m.folds.diamonds && m.folds.diamonds.expanded === true);

	// ── The other way round, and the status strip unfolded ───────────────
	await p.evaluate(() => { if (DaimondShell.setFold) DaimondShell.setFold('chats', false); });
	await p.waitForTimeout(250);
	m = await survey(p);
	check('folding Chats instead gives the Diamonds section 70% of the rail\'s top half',
		!m.sessionList.drawn && m.diamondList.h / m.railTop.h >= 0.70,
		`${m.diamondList.h} of ${m.railTop.h} = ` + Math.round(100 * m.diamondList.h / m.railTop.h) + '%');
	await p.evaluate(() => { if (DaimondShell.setFold) { DaimondShell.setFold('chats', true); DaimondShell.setFold('status', true); } });
	await p.waitForTimeout(250);
	m = await survey(p);
	check('unfolding the status rows brings them back and bounds them inside the strip',
		m.modelRow.drawn && m.status.h <= Math.round(0.45 * m.rail.h) + 2,
		`#astat-model ${m.modelRow.h}px, strip ${m.status.h}px of ${m.rail.h}`);
	await p.evaluate(() => { if (DaimondShell.setFold) DaimondShell.setFold('status', false); });
	await p.waitForTimeout(250);

	// ── The hardware the drawer has to hold itself off ───────────────────
	m = await survey(p);
	const before = { top: m.rail.top, bottom: m.rail.bottom, chats: m.sessionList.h };
	await p.addStyleTag({ content: ':root { --safe-t: 44px; --safe-b: 34px; --safe-l: 12px; }' });
	await p.waitForTimeout(250);
	const insets = await p.evaluate(() => {
		const r = document.getElementById('panel-rail');
		const cs = getComputedStyle(r);
		const list = document.getElementById('session-list').getBoundingClientRect();
		return { padT: cs.paddingTop, padB: cs.paddingBottom, padL: cs.paddingLeft,
			listBottom: Math.round(list.bottom), vh: innerHeight };
	});
	check('the drawer holds its content off the notch and the home indicator',
		insets.padT === '52px' && insets.padB === '42px' && insets.padL === '20px',
		`${insets.padT} / ${insets.padB} / ${insets.padL}`);
	check('and nothing runs under the indicator when it does',
		insets.listBottom <= insets.vh - 34,
		`chats foot ${insets.listBottom}, screen ${insets.vh}`);

	// ── The keyboard, which `100dvh` does not shrink for ─────────────────
	await p.evaluate(() => document.documentElement.style.setProperty('--vvh', '500px'));
	await p.waitForTimeout(250);
	const kb = await survey(p);
	check('a raised keyboard shortens the drawer, and the lists with it',
		kb.rail.h === 500 && kb.sessionList.h < before.chats,
		`drawer ${kb.rail.h}px, chats ${kb.sessionList.h}px (was ${before.chats}px)`);
	await p.evaluate(() => document.documentElement.style.removeProperty('--vvh'));

	consoleClean(s, 'WebKit 390x844');
}

// ── The smallest phone still sold ────────────────────────────────────────────
{
	const { s } = await world({ name: 'railwk375', browser: 'webkit', width: 375, height: 667 });
	sessions.push(s);
	const p = s.page;
	await drawer(p);
	let m = await survey(p);
	check('at 375x667 the defaults hold too',
		!!m.state && m.state.diamonds === true && m.state.chats === true && m.state.status === false,
		JSON.stringify(m.state));
	check('and each list has more than twice the height it had (100px and 96px)',
		m.diamondList.h >= 200 && m.sessionList.h >= 190,
		`${m.diamondList.h} and ${m.sessionList.h}`);
	await p.screenshot({ path: path.join(SHOTS, 'railmobile-wk375-defaults.png') });
	await tap(p, '.rail-fold[data-fold="diamonds"]');
	m = await survey(p);
	check('folding Diamonds shows four whole chat tiles on that screen, where none fitted before',
		m.chatsWhole >= 4, `${m.chatsWhole} whole of ${m.chats}, list ${m.sessionList.client}px`);
	await p.screenshot({ path: path.join(SHOTS, 'railmobile-wk375-diamonds-folded.png') });
	consoleClean(s, 'WebKit 375x667');
}

// ── The Diamonds row counts, which WebKit cannot hold ────────────────────────
{
	const { s, diamonds } = await world({ name: 'railcr390', browser: 'chromium', width: 390, height: 844 });
	sessions.push(s);
	const p = s.page;
	check('the Chromium phone context really holds the Diamonds (WebKit has no OPFS here)',
		diamonds >= 8, diamonds + ' in the store');
	await drawer(p);
	let m = await survey(p);
	check('the Diamonds section shows five whole rows with both sections open (it showed two)',
		m.diamondsWhole >= 5, `${m.diamondsWhole} whole of ${m.diamonds}, list ${m.diamondList.client}px`);
	check('and the Chats section two whole tiles beside it (it showed one)',
		m.chatsWhole >= 2, `${m.chatsWhole} whole of ${m.chats}`);
	await p.screenshot({ path: path.join(SHOTS, 'railmobile-cr390-defaults.png') });
	await tap(p, '.rail-fold[data-fold="chats"]');
	m = await survey(p);
	check('folding Chats puts every Diamond on screen at once',
		m.diamondsWhole === m.diamonds && m.diamonds >= 8,
		`${m.diamondsWhole} of ${m.diamonds}`);
	check('and the folded Chats list is drawn at all — header only, nothing to scroll',
		!m.sessionList.drawn && m.headC.drawn, `list ${m.sessionList.h}px, header ${m.headC.h}px`);
	await p.screenshot({ path: path.join(SHOTS, 'railmobile-cr390-chats-folded.png') });
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
	const m = await survey(p);
	check('no fold control is drawn on a desktop',
		Object.keys(m.folds).length === 3
			&& Object.keys(m.folds).every((k) => m.folds[k].drawn === false),
		JSON.stringify(Object.keys(m.folds).map((k) => k + ':' + m.folds[k].drawn)));
	check('the desktop keeps its own lever, the split handle between the two lists',
		m.split && m.split.drawn, m.split ? m.split.h + 'px' : 'absent');
	check('and every status row, unfolded', m.modelRow.drawn && m.admin.h > 120,
		`#astat-model ${m.modelRow.h}px, #admin ${m.admin.h}px`);
	// THE TRAP THE FOLD CONTROL WOULD HAVE SPRUNG. `.railhead > span:first-child` is
	// what makes the heading a heading — in app.css, skin-warm.css and improve.css —
	// so a control placed BEFORE it restyles every railhead in the app, desktop
	// included. It goes last in the row for this reason, and this is the check that
	// says so out loud.
	check('the heading is still the railhead\'s first child, and the fold its last',
		m.headingFirst && m.foldLast && m.headingFlex === '1',
		`first-child ${m.headingFirst}, fold last ${m.foldLast}, flex-grow ${m.headingFlex}`);
	// The attributes are written at every width; only rules inside the phone
	// breakpoint read them. Proven rather than asserted: the phone's own state is
	// forced onto a desktop rail and nothing moves.
	const moved = await p.evaluate(() => {
		const r = document.getElementById('panel-rail');
		const h = () => ['#diamond-list', '#session-list', '#admin-status', '#admin']
			.map((sel) => Math.round(document.querySelector(sel).getBoundingClientRect().height)).join(',');
		const was = h();
		['diamonds', 'chats', 'status'].forEach((k) => r.setAttribute('data-fold-' + k, 'off'));
		const now = h();
		['diamonds', 'chats', 'status'].forEach((k) => r.setAttribute('data-fold-' + k, 'on'));
		return { was, now };
	});
	check('and a phone\'s fold state forced onto the desktop rail moves nothing',
		moved.was === moved.now, `${moved.was} → ${moved.now}`);
	await p.screenshot({ path: path.join(SHOTS, 'railmobile-desktop-1280.png') });
	consoleClean(s, 'Chromium desktop');
}

} finally {
	for (const s of sessions) { try { await s.close(); } catch (e) { /* already gone */ } }
}

console.log(`\n${ok.length} ok, ${bad.length} failed`);
if (bad.length) { bad.forEach((b) => console.log('  FAILED: ' + b)); process.exit(1); }
