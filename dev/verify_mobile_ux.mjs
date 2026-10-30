// gateway: none
// verify_mobile_ux.mjs — walk the real mobile UX pathways, not just geometry.
//
// This exists because a headless "it renders" pass shipped bugs a human hit in
// seconds: iOS-zoom on 14px inputs, a modal titled "Settings" for Credits with no
// corner close, a dead "?" button, emoji toolbar icons. Each check below is one
// pathway a thumb would take.
//
// iOS auto-zoom itself is a Safari behaviour Chromium cannot reproduce, so we test
// its CAUSE instead: no focusable control may be under 16px on a phone.
import { open, signInAs, connectMock, workMenu, workMenuItems } from './harness.mjs';
import { guardRan } from './verdict.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (!pass && detail ? ' — ' + detail : ''));
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Sign-in deferred so we can inspect the account-creation screen first.
const s = await open({ signIn: false, connect: false, name: 'muxtester' });
const { page } = s;
await page.setViewportSize({ width: 390, height: 844 });
await page.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important}' });
await sleep(400);

// Every input's computed font-size, for the currently-focusable ones.
const smallInputs = async () => page.evaluate(() => {
	const bad = [];
	document.querySelectorAll('input, textarea, select').forEach(el => {
		if (el.offsetParent === null && el.type !== 'hidden') return;   // not visible
		const fs = parseFloat(getComputedStyle(el).fontSize);
		if (fs < 16) bad.push((el.id || el.className || el.tagName) + '=' + fs + 'px');
	});
	return bad;
});

// ── 1. Account creation screen: no sub-16px field (would zoom on focus) ──
check('create-account: identity fields ≥16px', (await smallInputs()).length === 0, JSON.stringify(await smallInputs()));

// Now create the account and connect the mock model.
await signInAs(s, 'muxtester');
await connectMock(s);
await page.evaluate(() => { try { window.DaimondAdmin.closeModal(); } catch (e) {} });
await sleep(300);

// ── 2. Whole app: no sub-16px focusable field anywhere reachable ──
check('app: all visible fields ≥16px', (await smallInputs()).length === 0, JSON.stringify(await smallInputs()));

// ── 3. The rail is the Stack's home page, and it is opaque ──
// The drawer went with the Stack (A2): the rail is a page of its own, reached by Back or DaimondShell.home().
// Its intent stands: nothing behind it shows through.
await page.evaluate(() => window.DaimondShell.home());
await sleep(400);
const railBg = () => page.evaluate(() => {
	const r = document.getElementById('panel-rail');
	if (!r || !r.getClientRects().length) return 'rail not shown';
	for (let n = r; n && n !== document.body; n = n.parentElement) {
		const bg = getComputedStyle(n).backgroundColor;
		if (bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return bg;
	}
	return 'transparent';
});
check('home: the rail is on an opaque page', !/transparent|not shown/.test(await railBg()), await railBg());

// ── 4. Credits: a page of the stack, rightly titled, fits, with a way back ──
// Reached as a person reaches it on a phone: home > the name (#user-row) > Models and spending > Credits.
// Settings is only ever pushed pages (Stack A3): never the modal (A4h). Real presses: a DOM click
// sends no pointerdown (gate 50).
await page.click('#user-row');
await sleep(400);
await page.click('.sg-door[data-sgroup="models"]:visible');
await sleep(400);
const viewPage = (id) => page.evaluate((v) => {
	const pg = document.querySelector('#phone-stack > .phone-page[data-page="settings-view"]');
	const t = pg && pg.querySelector('.admin-title');
	const view = document.getElementById(v);
	const r = pg ? pg.getBoundingClientRect() : null, back = document.getElementById('stack-back');
	const br = back && back.getClientRects().length ? back.getBoundingClientRect() : null;
	return { top: window.DaimondStack.top(), depth: window.DaimondStack.depth(),
		modal: getComputedStyle(document.getElementById('settings-modal')).display,
		shown: !!pg && !!view && pg.contains(view) && view.getClientRects().length > 0,
		title: t && t.getClientRects().length ? t.textContent.trim() : 'none',
		fits: !!r && r.left >= -1 && r.right <= window.innerWidth + 1,
		back: !!br && br.width >= 44 && br.height >= 44 && br.top >= 0 };
}, id);
const group = await page.evaluate(() => window.DaimondStack.depth());
await page.click('.sg-group-page #astat-account:visible');
await sleep(400);
const cr = await viewPage('admin-credits');
check('credits: a page pushed over the Models group, the modal down', cr.top === 'settings-view' && cr.depth === group + 1 && cr.shown && cr.modal === 'none', JSON.stringify(cr));
check('credits: titled "Credits", not "Settings"', /credit/i.test(cr.title), cr.title);
check('credits: the page fits the screen width', cr.fits);
check('credits: a 44px way back on screen', cr.back);
await page.click('#stack-back');
await sleep(400);
check('credits: Back is the Models group again', await page.evaluate(() => window.DaimondStack.top()) === 'settings-group');

// ── 5. Models: a page, rightly titled ──
await page.click('.sg-group-page #astat-model:visible');
await sleep(400);
const md = await viewPage('admin-models');
check('models: a page pushed over the Models group, the modal down', md.top === 'settings-view' && md.shown && md.modal === 'none', JSON.stringify(md));
check('models: titled "Models"', /model/i.test(md.title), md.title);
// Down the stack to home: the view, the group, Settings.
for (let i = 0; i < 3 && await page.evaluate(() => window.DaimondStack.top()) !== 'home'; i++) { await page.click('#stack-back'); await sleep(400); }

// ── 6. The guide "?" actually opens the guide ──
// The guide is a row of Help's menu, so it is reached through Help, as a person reaches it. On a phone Help is
// on the turn page's bar (home's head holds Search and New Chat where it stands), so a chat is opened first.
await page.click('#new-session-btn');
await sleep(500);
check('guide: New Chat pushes the turn page', await page.evaluate(() => window.DaimondStack.top()) === 'turn');
await page.click('#help-btn');
await page.click('#guide-btn');
await sleep(600);
check('guide: "?" raises the web sheet', await page.evaluate(() =>
	window.DaimondSheet.isOpen() && window.DaimondSheet.guest() === 'web'));
await page.evaluate(() => { try { window.DaimondSheet.close(); } catch (e) {} });
await sleep(300);

// ── 7. The update chip: hidden when current, shown once ready (TOP-05) ──
// A disabled-looking chip drawn at every boot, titled "up to date", was a
// button that did nothing most of the time -- see dev/verify_updates.mjs
// scenario A, which pins the same contract with the reload harness this file
// does not have. `build.json` here is the real one this tab booted from, so
// booting with nothing pending is exactly the "current" state.
check('update-chip: hidden while current', await page.evaluate(() => {
	const c = document.getElementById('update-chip');
	return c && c.hidden && c.dataset.state === 'current';
}), await page.evaluate(() => {
	const c = document.getElementById('update-chip'); return c && (c.hidden + '/' + c.dataset.state);
}));
// Fake a newer build the way verify_updates.mjs does, without a reload this
// flow's signed-in state would not survive.
await page.route('**/build.json', route => route.fulfill({
	status: 200, contentType: 'application/json', body: JSON.stringify({ build: 'MUXNEWER', note: 'mux' }),
}));
await page.evaluate(() => window.DaimondUpdater && window.DaimondUpdater.check());
await page.waitForFunction(() =>
	document.getElementById('update-chip') && document.getElementById('update-chip').dataset.state === 'ready',
	null, { timeout: 5000 }).catch(() => {});
check('update-chip: shown once an update is ready', await page.evaluate(() => {
	const c = document.getElementById('update-chip');
	return c && !c.hidden && c.dataset.state === 'ready';
}), await page.evaluate(() => {
	const c = document.getElementById('update-chip'); return c && (c.hidden + '/' + c.dataset.state);
}));
await page.unroute('**/build.json').catch(() => {});

// ── 7b. PH-01: the phone's bar holds at most four standing controls (on the Stack: Back, logo, "more", full screen) ──
check('help menu: holds Guide and About (TOP-03)', await page.evaluate(() => {
	const h = document.getElementById('help-menu');
	return !!h && !!h.querySelector('#guide-btn') && !!h.querySelector('#about-btn');
}));
check('phone: Settings and Link device are folded into the "more" control, not standing icons', await page.evaluate(() => {
	const help = document.getElementById('help-menu');
	const settings = document.getElementById('settings-menu-btn');
	const link = document.getElementById('pair-link-btn');
	return !!help && settings && settings.parentNode === help
		&& (!link || link.parentNode === help);
}));
check('phone top bar: Back, logo, "more" and full screen — nothing else standing', await page.evaluate(() => {
	const header = document.querySelector('header.topbar');
	if (!header) return false;
	const items = Array.from(header.querySelectorAll('button, .brand-group'))
		.filter(el => el.closest('#help-menu') === null
			&& el.id !== 'update-chip' && el.id !== 'panel-more'
			&& getComputedStyle(el).display !== 'none');
	return items.length <= 4;
}), await page.evaluate(() => {
	const header = document.querySelector('header.topbar');
	const items = Array.from(header.querySelectorAll('button, .brand-group'))
		.filter(el => el.closest('#help-menu') === null
			&& el.id !== 'update-chip' && el.id !== 'panel-more'
			&& getComputedStyle(el).display !== 'none');
	return items.map(el => el.id || el.className).join(', ');
}));

// ── 8. Workspace head: real icons, and a name field ≥16px ──
// The footer is the chip row since 2026-08-28; a destination is its chip.
await page.click('#mnav .ptag[data-panel="work"]');
await sleep(400);
// Since Workspace round 2 P4 the head holds only the ⋯ and the ×: New file, New folder,
// Upload and Refresh are items of + New and the head ⋯. (No `up` either: the `..` row at
// the top of the listing replaced it, at the owner's request, dev/HATES.md 2026-08-24.)
check('files: head icons are SVG, not emoji', await page.evaluate(() => {
	const btns = [...document.querySelectorAll('#panel-work .railhead button')];
	return btns.length > 0 && btns.every((b) => b.querySelector('svg') && !b.textContent.trim());
}));
const newItems = await workMenuItems(page, 'new');
check('files: + New holds a file and a folder', newItems.includes('file') && newItems.includes('dir'), newItems.join(','));
// A field under 16px makes iOS zoom the page on focus.
await workMenu(page, 'new', 'file');
await sleep(500);
const nameFs = await page.evaluate(() => {
	const inp = document.querySelector('#panel-work .files-name-input');
	return inp ? parseFloat(getComputedStyle(inp).fontSize) : null;
});
check('files: the new file\'s name field is ≥16px', nameFs !== null && nameFs >= 16, String(nameFs));
await page.keyboard.press('Escape');

// ── 8b. Settings is a page of the stack, with Appearance moved in (Stack A3, b5) ──
// The identity row's action opens it; the top bar's Appearance door is gone on a phone.
await page.evaluate(() => window.DaimondAdmin.home());
await sleep(600);
const sp = await page.evaluate(() => {
	const pg = document.querySelector('.phone-page[data-page="settings"]');
	const r = pg && pg.getBoundingClientRect();
	const menu = document.getElementById('settings-menu');
	const back = document.getElementById('stack-back');	// the stack bar's Back; the drawer's cross is gone
	const br = back && back.getBoundingClientRect();
	const cross = document.getElementById('admin-close');
	const small = [...(pg ? pg.querySelectorAll('.ap-row button, .ap-swatch, select, .sg-door') : [])]
		.filter((b) => b.offsetParent !== null)
		.filter((b) => b.matches('.ap-swatch, .sg-door') ? b.getBoundingClientRect().height < 44 : parseFloat(getComputedStyle(b).fontSize) < 16)
		.map((b) => (b.textContent || b.className).trim().slice(0, 20));
	const btn = document.getElementById('settings-menu-btn');
	return {
		page: !!pg && !pg.hidden && r.width === innerWidth,
		moved: !!menu && !!pg && pg.contains(menu) && document.querySelectorAll('#settings-menu').length === 1,
		back: !!br && br.width >= 44 && br.height >= 44 && br.top >= 0,
		cross: !cross || cross.getClientRects().length === 0,
		small,
		topbar: !btn || btn.getClientRects().length === 0,
	};
});
check('settings: a full-width page of the stack', sp.page);
check('settings: Appearance is the moved menu, one instance', sp.moved);
check('settings: a 44px way back on screen', sp.back);
check('settings: no in-page back beside the bar\'s', sp.cross);
check('settings: controls ≥16px, rows and swatches ≥44px', sp.small.length === 0, sp.small.join(', '));
check('settings: no Appearance button in the top bar', sp.topbar);
// A group is a page over Settings: the bar's Back pops it to Settings, the next pops
// Settings and runs its close path (the stack's watch, not the drawer's cross).
await page.click('.sg-page [data-sgroup="you"]:visible');
await sleep(500);
const inGroup = await page.evaluate(() => window.DaimondStack.top());
await page.click('#stack-back');
await sleep(500);
check('settings: a group page, and Back from it lands on Settings', inGroup === 'settings-group'
	&& await page.evaluate(() => window.DaimondStack.top()) === 'settings', inGroup);
await page.click('#stack-back');
await sleep(500);
const gone = await page.evaluate(() => {
	const pg = document.querySelector('.phone-page[data-page="settings"]');
	const a = document.getElementById('admin');
	return { page: !pg || pg.hidden || pg.getClientRects().length === 0, closed: !a || !a.classList.contains('admin-open') };
});
check('settings: back takes the page away', gone.page);
check('settings: popping the page runs the Settings close path', gone.closed);

// ── 9. Nothing threw across all of it ──
const real = s.errs.filter(e => !/Failed to load resource|status of 4\d\d/.test(e));
check('no console errors across the walk', real.length === 0, real.slice(0, 3).join(' | '));

guardRan(ok.length + bad.length);
console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) console.log('FAILED: ' + bad.join(', '));
await s.close();
process.exit(bad.length ? 1 : 0);
