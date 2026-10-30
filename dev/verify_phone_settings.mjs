// gateway: none
// verify_phone_settings.mjs -- phone Settings and the one history, driven by REAL taps (QA ccp29, stack/A4d).
// rc-a's QA found every phone Settings control dead to a real tap, and Back, Forward, a reload and a width change
// each able to leave Settings blank or spend a Back on nothing. The builders' checks had used `element.click()`,
// which sends no `mousedown`, so the outside-close that ate every tap never ran under them. Here every press is
// `page.touchscreen.tap` at 390x844 (or `page.mouse.click` at a desktop width) at the element's centre: a tap the
// browser turns into touch, pointer, mouse and click events as a finger's would be.
//   F1  a door, Theme, then Lock's row: a tap acts and Settings stays; on the desktop a press inside the drawer
//       keeps it and one outside closes it (ccp28's behaviour)
//   F2  Back from a group (the browser's, then the bar's) lands on Settings drawn; desktop Back closes the drawer
//   F3  Forward onto Settings, and onto a group, draws it
//   F4  a pop and a push in one task end on the push, history agreeing, and Back goes home
//   F5  Settings open on a phone, the window widened: the desktop drawer is full
//   F6  a reload on a group lands on the group, drawn, and Back on Settings
//   F7  after a phone session, the desktop's Back is not spent on the phone's pages; narrowing again restores them
//   PC  the home page's "Pause all" row has no closer on a phone
//   eval "$(bash dev/world.sh N --env)"
//   RC_SLOT=<slot> DAIMOND_BROWSER=webkit node dev/verify_phone_settings.mjs [--only F1,F2]
// Exit 0 when every section passes, 1 otherwise.

import { connectMock, open, signInAs } from './harness.mjs';

const UA    = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const PHONE = { width: 390, height: 844 };
const DESK  = { width: 1280, height: 800 };
const SETTLE = 900;	// ms for a push, a popstate or a redraw to land
const only  = (() => { const i = process.argv.indexOf('--only'); const v = i > 0 ? process.argv[i + 1] : process.env.PHONE_SETTINGS_ONLY; return v ? v.split(',') : null; })();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let bad = 0;
function check(sec, ok, what, got) {
	if (!ok) bad++;
	console.log((ok ? 'PASS ' : 'FAIL ') + sec + '  ' + what + (ok ? '' : '  got ' + JSON.stringify(got) + '  last tap ' + JSON.stringify(last)));
}

// Where the element is, or null: the first match drawn, whose text matches `re` when one is given.
async function spot(P, sel, re) {
	return P.evaluate(([q, r]) => {
		const e = [...document.querySelectorAll(q)].find((x) => x.getClientRects().length
			&& (!r || new RegExp(r).test(x.textContent)));
		if (!e) return null;
		e.scrollIntoView({ block: 'center' });
		const b = e.getBoundingClientRect(), x = b.left + b.width / 2, y = b.top + b.height / 2;
		const at = document.elementFromPoint(x, y);
		// What a finger there would land on, for a failure's message.
		const on = at ? (at.id ? '#' + at.id : at.tagName + '.' + String(at.className).split(' ')[0]) : null;
		return { x, y, on, under: !!(at && (at === e || e.contains(at))) };
	}, [sel, re || null]);
}
let last = null;	// the last spot tapped or pressed, for a failure's message
async function tap(P, sel, re) {
	const p = last = await spot(P, sel, re);
	if (p) { await P.touchscreen.tap(p.x, p.y); await sleep(SETTLE); }
	return !!p;
}
async function press(P, sel, re) {
	const p = last = await spot(P, sel, re);
	if (p) { await P.mouse.click(p.x, p.y); await sleep(SETTLE); }
	return !!p;
}

// What a phone shows: the stack, the entry history is on, and whether Settings or its group page is drawn.
const state = (P) => P.evaluate(() => {
	const S = window.DaimondStack, shown = (q) => {
		const e = document.querySelector(q);
		return !!(e && e.getClientRects().length && e.getBoundingClientRect().height > 0);
	};
	const gp = document.querySelector('#phone-stack > [data-page="settings-group"]:not([hidden]) .sg-group');
	const body = document.getElementById('admin-body');
	return {
		pages: !S ? null : S.pages ? S.pages() : (history.state && history.state.stack && history.state.stack.length === S.depth()
			? history.state.stack.slice() : ['?' + S.depth(), S.top()]),
		hist:  history.state && history.state.stack ? history.state.stack : null,
		doors: shown('#phone-stack > [data-page="settings"]:not([hidden]) .sg-doors'),
		group: gp ? (gp.innerText || '').trim().length : 0,
		open:  !!document.querySelector('#admin.admin-open'),
		seat:  body && body.parentElement ? (body.parentElement.id || body.parentElement.className) : null,
		drawerText: (() => { const a = document.getElementById('admin'); return a && a.getClientRects().length ? (a.innerText || '').trim().length : 0; })(),
		appStack: document.getElementById('app') ? document.getElementById('app').dataset.stack : 'left the app',
	};
});
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function heed(P) {
	P.on('pageerror', (e) => console.log('PAGEERROR ' + String(e).slice(0, 300)));
	P.on('console', (m) => { if (m.type() === 'error' && !/\/api|502|Failed to load resource/.test(m.text())) console.log('CONSOLE ' + m.text().slice(0, 200)); });
}
// A clean start at the width under test. `open()` connected the model through the Settings form at its
// own 1500 px, which leaves that form (or the first-run Models modal) standing over the page and its
// entries in history. A reload boots afresh at this width with the model stored, so no first-run modal;
// anything still up is closed with a real press on its own cross, as a person would.
async function fresh(P, how) {
	await P.reload({ waitUntil: 'domcontentloaded' });
	await P.waitForFunction(() => window.__DAIMOND_READY === true, null, { timeout: 15000 }).catch(() => {});
	await sleep(1500);
	for (let i = 0; i < 3; i++) {
		const up = await P.evaluate(() => {
			const m = document.getElementById('settings-modal');
			return { modal: !!(m && getComputedStyle(m).display !== 'none'), admin: !!document.querySelector('#admin.admin-open') };
		});
		if (up.modal) await how(P, '#settings-close');
		else if (up.admin) await how(P, '#admin-close');
		else break;
	}
}
// Signed in with stay-unlocked ON, set before the account is made (as verify_a11y_keyboard does): a phone's
// default is OFF, so the reloads below would otherwise come back to the lock screen over everything.
async function session(o) {
	const S = await open({ ...o, signIn: false, connect: false });
	await S.page.evaluate(() => localStorage.setItem('daimond-stay-unlocked', '1'));
	await signInAs(S, o.name);
	await connectMock(S);
	live.push(S);
	return S;
}
// Every session a section opened, closed after it even when it threw: the profile is `<name>-<pid>`
// (harness.mjs open), so a browser left running holds the next section's profile (Chromium's ProcessSingleton).
const live = [];
async function phone() {
	const S = await session({ name: 'phone-settings', touch: true, ua: UA });
	heed(S.page);
	await S.page.setViewportSize(PHONE);
	await fresh(S.page, tap);
	// Every section starts on the home page, reached as a person reaches it: the bar's Back. A boot that put
	// the turn page up (9f8426308 did, F6) would otherwise hide the identity row and fail for the wrong reason.
	for (let i = 0; i < 3 && await S.page.evaluate(() => window.DaimondStack && window.DaimondStack.top() !== 'home'); i++)
		if (!(await tap(S.page, '#stack-back'))) break;
	return S;
}
async function desk() {
	const S = await session({ name: 'phone-settings-desk' });
	heed(S.page);
	await S.page.setViewportSize(DESK);
	await fresh(S.page, press);
	return S;
}
// Settings, by a tap on the identity row (on the home page).
async function settings(P) { return tap(P, '#user-row'); }

const SECTIONS = {
	async F1() {
		let S = await phone(), P = S.page;
		await settings(P);
		let s = await state(P);
		check('F1', eq(s.pages, ['home', 'settings']) && s.doors, 'a tap on the identity row shows Settings', s);
		await tap(P, '.sg-door', 'Models');
		s = await state(P);
		check('F1', eq(s.pages, ['home', 'settings', 'settings-group']) && s.group > 20, 'a tap on a door opens its group page, drawn', s);
		await P.goBack(); await sleep(SETTLE);
		const before = await P.evaluate(() => document.documentElement.dataset.theme || document.body.dataset.theme || '');
		const hit = await tap(P, '#phone-stack [data-page="settings"] button, #phone-stack [data-page="settings"] [role="radio"]', '^\\s*(Light|Dark)\\s*$');
		s = await state(P);
		check('F1', hit && eq(s.pages, ['home', 'settings']) && s.doors && s.open, 'a tap on a Theme choice leaves Settings standing', { hit, before, s });
		await S.close();
		// The desktop: a press inside the drawer keeps it; one outside closes it.
		S = await desk(); P = S.page;
		await press(P, '#user-row');
		s = await state(P);
		check('F1', s.open && s.drawerText > 20, 'desktop: the identity row opens the drawer', s);
		await press(P, '#admin-body .sg-door, #admin-body .admin-item');
		s = await state(P);
		check('F1', s.open, 'desktop: a press inside the drawer keeps it open', s);
		await P.mouse.click(DESK.width / 2, DESK.height / 2); await sleep(SETTLE);
		s = await state(P);
		check('F1', !s.open, 'desktop: a press outside the drawer closes it', s);
		await S.close();
	},
	async F2() {
		let S = await phone(), P = S.page;
		await settings(P);
		await tap(P, '.sg-door', 'Models');
		await P.goBack(); await sleep(SETTLE);
		let s = await state(P);
		check('F2', eq(s.pages, ['home', 'settings']) && s.doors && s.open, 'browser Back from a group lands on Settings, drawn', s);
		await tap(P, '.sg-door', 'Privacy');
		await tap(P, '#stack-back');
		s = await state(P);
		check('F2', eq(s.pages, ['home', 'settings']) && eq(s.hist, ['home', 'settings']) && s.doors, "the bar's Back from a group lands on Settings, drawn", s);
		await P.goBack(); await sleep(SETTLE);
		s = await state(P);
		check('F2', eq(s.pages, ['home']) && !s.open, 'Back from Settings goes home and closes it', s);
		await S.close();
		S = await desk(); P = S.page;
		const n0 = await P.evaluate(() => history.length);
		await press(P, '#user-row');
		await P.goBack(); await sleep(SETTLE);
		s = await state(P);
		const n1 = await P.evaluate(() => history.length);
		check('F2', !s.open && n1 === n0 + 1, 'desktop: Back closes the drawer, one entry as before', { s, n0, n1 });
		await S.close();
	},
	async F3() {
		const S = await phone(), P = S.page;
		await settings(P);
		await tap(P, '.sg-door', 'Tools');
		await P.goBack(); await sleep(SETTLE);
		await P.goBack(); await sleep(SETTLE);
		await P.goForward(); await sleep(SETTLE);
		let s = await state(P);
		check('F3', eq(s.pages, ['home', 'settings']) && s.doors && s.open, 'Forward onto Settings draws it', s);
		await P.goForward(); await sleep(SETTLE);
		s = await state(P);
		check('F3', eq(s.pages, ['home', 'settings', 'settings-group']) && s.group > 20, 'Forward onto a group draws it', s);
		await S.close();
	},
	async F4() {
		const S = await phone(), P = S.page;
		await tap(P, '#home-compose-btn');
		let s = await state(P);
		check('F4', eq(s.pages, ['home', 'turn']), 'New Chat pushes the turn page', s);
		await tap(P, '#stack-back');
		// A pop and a push in one task: the push must not be lost to the pop's traversal.
		await settings(P);
		await P.evaluate(() => { DaimondStack.pop(); DaimondStack.push('turn'); });
		await sleep(SETTLE * 2);
		s = await state(P);
		check('F4', eq(s.pages, ['home', 'turn']) && eq(s.hist, ['home', 'turn']), 'a pop and a push in one task end on the push, history agreeing', s);
		await P.goBack(); await sleep(SETTLE);
		s = await state(P);
		check('F4', eq(s.pages, ['home']) && eq(s.hist, ['home']), 'Back from there goes home', s);
		await S.close();
	},
	async F5() {
		const S = await phone(), P = S.page;
		await settings(P);
		await P.setViewportSize(DESK); await sleep(1500);
		let s = await state(P);
		check('F5', s.seat === 'admin' || s.seat === 'admin-drawer' || /admin/.test(String(s.seat)) && !/phone-page/.test(String(s.seat)), 'widened, the drawer body goes back to #admin', s);
		if (s.open) await P.keyboard.press('Escape'), await sleep(SETTLE);
		await press(P, '#user-row');
		s = await state(P);
		check('F5', s.open && s.drawerText > 40, 'the desktop drawer then opens full', s);
		await S.close();
	},
	async F6() {
		const S = await phone(), P = S.page;
		await settings(P);
		await tap(P, '.sg-door', 'Models');
		await P.reload(); await sleep(4000);
		let s = await state(P);
		check('F6', eq(s.pages, ['home', 'settings', 'settings-group']) && s.group > 20, 'a reload on a group lands on it, drawn', s);
		await P.goBack(); await sleep(SETTLE);
		s = await state(P);
		check('F6', eq(s.pages, ['home', 'settings']) && s.doors, 'and Back is Settings, drawn', s);
		await S.close();
	},
	async F7() {
		const S = await phone(), P = S.page;
		await tap(P, '#home-compose-btn');
		await P.setViewportSize(DESK); await sleep(1500);
		let s = await state(P);
		check('F7', eq(s.hist, ['home']), 'widened, history stands on the floor entry', s);
		await P.setViewportSize(PHONE); await sleep(1500);
		s = await state(P);
		check('F7', eq(s.pages, ['home', 'turn']) && eq(s.hist, ['home', 'turn']), 'narrowed again, the turn page is back on top', s);
		await S.close();
	},
	async PC() {
		const S = await phone(), P = S.page;
		const p = await spot(P, '#pptw-global-row .panel-close');
		check('PC', !p, 'the "Pause all" row shows no closer on the home page', p);
		await S.close();
	},
};

for (const [k, f] of Object.entries(SECTIONS)) {
	if (only && !only.includes(k)) continue;
	try { await f(); } catch (e) { bad++; console.log('FAIL ' + k + '  threw ' + String(e && e.message || e).split('\n')[0]); }
	while (live.length) await live.pop().browser.close().catch(() => {});
}
console.log(bad ? 'verify_phone_settings: ' + bad + ' FAILED' : 'verify_phone_settings: all passed');
process.exit(bad ? 1 : 0);
