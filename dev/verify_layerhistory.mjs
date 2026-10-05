// gateway: none
// verify_layerhistory.mjs -- the layer stack against the real session history (r533 QA, B-1 and B-2).
//
// www/js/layers.test.mjs proves the stack against a MODEL of the history. A model has no
// documents and no frames, so it could not see the two faults this file exists for:
//
//   B-1  A RELOAD ON A LAYER'S ENTRY LOADED THE PAGE TWICE. The entries below the one the
//        reload kept belong to a document that is gone, so the walk back the stack made
//        at boot (`go(-depth)`) was a second full load, and whatever the person had typed
//        into the first boot, a passphrase at unlock, was lost. Now the entry stands as
//        the start (`replaceState`, depth nought) and nothing is traversed.
//
//   B-2  BROWSING INSIDE THE WEB SHEET'S FRAME LEFT BACK DEAD. A frame's navigations are
//        entries in the SAME session history. The sheet's close took one entry off with
//        `go(-1)`, which then landed on a frame entry: no `popstate` reached the page, the
//        stack read the frame entry's state (the sheet's depth) for two seconds, walked
//        back again, and a layer opened meanwhile got no entry, so Back did nothing. Our own
//        guide now follows its links with `location.replace` (case G). A FOREIGN site cannot
//        be told to (cases F, H, D), and replacing the frame element when the sheet closes
//        does not take its entries out of the joint history (Chromium and WebKit,
//        2026-10-05). The stack counts them instead: `layers.js` records `history.length` as
//        each layer's entry is pushed and a close goes back to the last entry of the layers
//        still up, pushing one entry first when a frame's Back has left entries ahead.
//
//   X    A MOUSE PRESS ON THE SHEET'S x DID NOTHING in the phone layout (Chromium): the x sits
//        in the grab bar, whose pointerdown took pointer capture, so the click went to the bar.
//
//   K    ESCAPE AND BACK DISAGREED ABOUT WHICH SURFACE WAS INNERMOST (r533 QA B-3, r535 U4). Each
//        module answered Escape in its own listener, so a menu over a sheet, a dialog over the
//        Admin drawer or the Chats menu over the drawer could take the wrong one down, and the
//        keyboard went to an opener inside a closed surface. One capture keydown on the window
//        in `layers.js` now closes the top layer through its own closer, after any claim (the
//        graph's link mode). K1-K6 press Escape over a stack and ask that only the top closed, that
//        the history depth fell by one with it, and that the keyboard is on something drawn;
//        K7 that Escape and Back leave the same stack; K8 that an opener alone gets the keyboard back;
//        K9 that a claim (the link mode) gives way to a dialog or the palette opened over it.
//
// After every step the history depth equals `DaimondLayers.depth()` equals the number of
// layers on the screen. Chromium by default; `DAIMOND_BROWSER=webkit` for WebKit.
//
//   node dev/verify_layerhistory.mjs
import http from 'node:http';
import { open, errors } from './harness.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const bad = [];
let nOk = 0;
const check = (name, pass, detail) => {
	if (pass) nOk++; else bad.push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail !== undefined && detail !== '' ? ' -- ' + String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 500) : ''));
};

// A foreign site: another origin (another port), three pages that link on to one another.
const site = http.createServer((req, res) => {
	const n = { '/a': '/b', '/b': '/c' }[req.url];
	res.setHeader('content-type', 'text/html');
	res.end('<!doctype html><title>foreign ' + req.url + '</title><body>' + req.url
		+ (n ? ' <a id="nx" href="' + n + '">next</a>' : '') + '</body>');
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const FOREIGN = 'http://127.0.0.1:' + site.address().port;

const s = await open({ signIn: true, connect: true, name: 'layerhist' + process.pid, touch: true });
const page = s.page;
let loads = 0;
page.on('load', () => { loads++; });
await page.setViewportSize({ width: 390, height: 844 });
await page.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important}' });
await wait(600);
const APP = page.url().split('#')[0].split('?')[0];

const snap = () => page.evaluate(() => {
	const Ly = window.DaimondLayers;
	const hid = (id) => { const e = document.getElementById(id); return !!e && !e.hidden; };
	return {
		url: location.href,
		st: history.state && history.state.dlayers || 0,
		depth: Ly ? Ly.depth() : -1,
		top: Ly ? Ly.top() : null,
		drawer: document.body.classList.contains('drawer-open'),
		sheet: document.body.classList.contains('sheet-open'),
		pops: ['settings-menu', 'panel-gallery', 'help-menu', 'chead-more-menu', 'hand-mode-pop'].filter(hid),
		palette: hid('palette'),
		modals: [...document.querySelectorAll('body > .modal')].filter((m) => m.getClientRects().length).length,
		admin: !!document.querySelector('.admin-open'),
		chats: !!document.querySelector('.railhead-menu'),
	};
});
const visCount = (x) => (x.drawer ? 1 : 0) + (x.sheet ? 1 : 0) + (x.pops.length ? 1 : 0) + (x.palette ? 1 : 0) + x.modals + (x.admin ? 1 : 0) + (x.chats ? 1 : 0);
async function agree(sec, what) {
	await wait(400);
	const x = await snap();
	check(sec + ' ' + what, x.url.startsWith(APP) && x.st === x.depth && visCount(x) === x.depth, JSON.stringify(x));
	return x;
}
const back = () => page.evaluate(() => history.back());

// The harness boots with the Admin drawer up (an entry of its own): close it, so the app is at nought.
await back();
await wait(800);
const s0 = await agree('0', 'at nought, nothing up');

// ── B-1. a reload with layers up is one load, and the entry becomes the start ───────────────────
await page.click('#drawer-btn');
await wait(200);
// Never awaited, and the reload destroys its context: that rejection is the expected end of it.
page.evaluate(() => DaimondCore.confirm('QA reload?', 'OK', { title: 'QA' })).catch(() => {});
await wait(400);
const before = await snap();
check('R1 drawer and dialog up before the reload', before.st === 2 && before.depth === 2, JSON.stringify(before));
loads = 0;
await page.reload();
await wait(4000);
const after = await snap();
check('R2 after the reload the page loaded ONCE, not again by a walk back', loads === 1, 'loads=' + loads);
check('R3 and stands at depth nought, nothing up', after.st === 0 && after.depth === 0 && visCount(after) === 0, JSON.stringify(after));
loads = 0;
await page.evaluate(() => history.forward()).catch(() => {});		// a Forward that loads a page destroys this context
await wait(2500);
check('R4 Forward after it loads nothing', loads === 0, 'loads=' + loads);
await page.click('#drawer-btn');
await agree('R5', 'a drawer opened after the reload has its entry');
await back();
await wait(600);
const r6 = await snap();
check('R6 one Back closes it', !r6.drawer && r6.depth === 0 && r6.st === 0, JSON.stringify(r6));

// ── X. a MOUSE press on the sheet's x closes it (the x sits in the grab bar, whose pointerdown takes pointer capture) ──
// Every other close here is a tap or a DOM `.click()`, and neither goes through a captured pointer: a mouse press did
// nothing in the phone layout until `bindGrab` left a press on the x alone.
{
	await page.evaluate(() => { window.DaimondPanels.hide('web'); window.DaimondPanels.show('web'); });
	await wait(700);
	const up = await snap();
	check('Xa the Web sheet is up with one entry', up.sheet && up.st === 1 && up.depth === 1, JSON.stringify(up));
	const box = await page.evaluate(() => { const r = document.getElementById('msheet-close').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
	await page.mouse.click(box.x, box.y);
	await wait(1200);
	const gone = await snap();
	check('Xb a mouse press on the x closes the sheet and leaves history at nought', !gone.sheet && gone.depth === 0 && gone.st === 0 && gone.url.startsWith(APP), JSON.stringify(gone));
	if (gone.sheet) await page.evaluate(() => document.getElementById('msheet-close').click());
	await wait(1000);
}

// ── B-2. browse in the Web sheet's frame, close the sheet by its x, then Back must still work ───
async function sheetCase(tag, browse) {
	try {
		await page.evaluate(() => { window.DaimondPanels.hide('web'); window.DaimondPanels.show('web'); });
		await wait(700);
		const up = await snap();
		check(tag + 'a the Web sheet is up with one entry', up.sheet && up.st === 1 && up.depth === 1, JSON.stringify(up));
		await browse();
		await wait(300);
		// A tap, as on the phone the sheet is for. A mouse press on the x reaches the grab bar's pointer capture and its
		// click lands on the bar, so the x does nothing for a mouse in the phone layout (an open item, not this check's).
		await page.tap('#msheet-close', { timeout: 5000 });
		await wait(2800);										// past the stack's stale-traversal window
		const closed = await snap();
		check(tag + 'b the sheet closed by its x leaves history and layers at nought', !closed.sheet && closed.st === 0 && closed.depth === 0 && closed.url.startsWith(APP), JSON.stringify(closed));
		await page.click('#drawer-btn');
		await wait(400);
		const dr = await snap();
		check(tag + 'c a drawer opened after it has an entry', dr.drawer && dr.st === 1 && dr.depth === 1, JSON.stringify(dr));
		await back();
		await wait(700);
		const gone = await snap();
		check(tag + 'd ONE Back closes the drawer', !gone.drawer && gone.st === 0 && gone.depth === 0 && gone.url.startsWith(APP), JSON.stringify(gone));
	} catch (e) {
		check(tag + 'x the case ran to its end', false, String((e && e.message) || e).split('\n')[0]);
	}
	// Whatever a failed case left up, the next one starts from the app at nought.
	const x = await snap().catch(() => null);
	if (!x || x.depth !== 0 || x.st !== 0 || x.sheet || x.drawer) { await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {}); await wait(4000); }
}

// Our own guide, in the frame: two links followed.
await sheetCase('G', async () => {
	const guide = () => page.frames().find((f) => /\/guide\//.test(f.url()));
	for (let i = 0; i < 2; i++) {
		const f = guide();
		if (!f) { check('G0 the guide is in the frame', false, page.frames().map((x) => x.url()).join(' ')); return; }
		const hrefs = await f.evaluate(() => [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')).filter((h) => h && h[0] !== '#' && !/^[a-z]+:/i.test(h)));
		const here = f.url();
		const next = hrefs.find((h) => new URL(h, here).href !== here);
		if (!next) { check('G0 the guide page has a link to follow', false, here); return; }
		await f.evaluate((h) => { const a = [...document.querySelectorAll('a[href]')].find((x) => x.getAttribute('href') === h); a.click(); }, next);
		await wait(900);
	}
});

// A foreign site, in the frame: two links followed.
await sheetCase('F', async () => {
	await page.evaluate((u) => { document.getElementById('web-frame').src = u; }, FOREIGN + '/a');
	await wait(900);
	for (let i = 0; i < 2; i++) {
		const f = page.frames().find((x) => x.url().startsWith(FOREIGN));
		if (!f) { check('F0 the foreign page is in the frame', false, page.frames().map((x) => x.url()).join(' ')); return; }
		await f.click('#nx');
		await wait(700);
	}
});

// A foreign site, and the frame's own Back before the sheet closes: entries lie AHEAD of the frame's position, and the
// close must not count them as behind it (it would walk back past the app's start).
await sheetCase('H', async () => {
	await page.evaluate((u) => { document.getElementById('web-frame').src = u; }, FOREIGN + '/a');
	await wait(900);
	for (let i = 0; i < 2; i++) {
		const f = page.frames().find((x) => x.url().startsWith(FOREIGN));
		if (!f) { check('H0 the foreign page is in the frame', false, page.frames().map((x) => x.url()).join(' ')); return; }
		await f.click('#nx');
		await wait(700);
	}
	await back();											// the frame's Back: /c -> /b, no popstate for the page
	await wait(700);
	const mid = await snap();
	check('H1 the frame\'s Back leaves the sheet up, one layer', mid.sheet && mid.depth === 1 && mid.st === 1 && page.frames().some((x) => x.url() === FOREIGN + '/b'), JSON.stringify(mid) + ' ' + page.frames().map((x) => x.url()).join(' '));
});

// A foreign site, and a dialog over the browsed sheet: the dialog's Back must leave the frame on the page it was on.
await sheetCase('D', async () => {
	await page.evaluate((u) => { document.getElementById('web-frame').src = u; }, FOREIGN + '/a');
	await wait(900);
	for (let i = 0; i < 2; i++) {
		const f = page.frames().find((x) => x.url().startsWith(FOREIGN));
		if (!f) { check('D0 the foreign page is in the frame', false, page.frames().map((x) => x.url()).join(' ')); return; }
		await f.click('#nx');
		await wait(700);
	}
	page.evaluate(() => DaimondCore.confirm('QA dialog?', 'OK', { title: 'QA' })).catch(() => {});
	await wait(500);
	const up = await snap();
	check('D1 a dialog is up over the browsed sheet', up.sheet && up.modals === 1 && up.depth === 2 && up.st === 2, JSON.stringify(up));
	await back();											// ONE Back closes the dialog
	await wait(900);
	const mid = await snap();
	check('D2 one Back closed the dialog and left the sheet up on the page it showed', mid.sheet && mid.modals === 0 && mid.depth === 1 && mid.st === 1 && page.frames().some((x) => x.url() === FOREIGN + '/c'), JSON.stringify(mid) + ' ' + page.frames().map((x) => x.url()).join(' '));
});

// ── K. Escape closes the innermost layer and no other; Back agrees ──────────────────────────────
// A person's press, as the cases below make it: the opener takes the keyboard (`focus()`), then is pressed (`.click()`),
// so the layer records it as what the keyboard goes back to. A DOM click alone does not focus, and a focus check would
// then be asking about nothing.
const pressFrom = (sel) => page.evaluate((q) => {
	const e = document.querySelector(q);
	if (!e) return false;
	try { e.focus(); } catch (x) { /* not focusable */ }
	e.click();
	return true;
}, sel);
const esc = async (ms) => { await page.keyboard.press('Escape'); await wait(ms || 900); return snap(); };
// What has the keyboard: drawn, not the page itself, and `want` (a selector) when the layer had an opener to go back to.
const held = (want) => page.evaluate((w) => {
	const a = document.activeElement;
	const shown = !!a && a !== document.body && a !== document.documentElement && a.getClientRects().length > 0;
	return { id: a ? (a.id || a.tagName.toLowerCase()) : null, shown, is: !w || (!!a && a.matches(w)) };
}, want || '');
const heldOk = (h) => h.shown && h.is;
// One layer fewer in the history and in the stack, the screen agreeing with both.
const dropped = (b, a) => a.depth === b.depth - 1 && a.st === b.st - 1 && a.st === a.depth && visCount(a) === a.depth && a.url.startsWith(APP);
// The panel gallery's chip is only drawn while some panel is spare.
const spare = async () => {
	await page.evaluate(() => {
		['doc', 'msg', 'compose'].forEach((p) => { try { DaimondPanels.markUsed(p); } catch (e) { /* not built yet */ } });
		try { DaimondPanels.reflow(); } catch (e) { /* nothing to reflow */ }
	});
	await wait(500);
};
// The gallery's chip is drawn only while a panel is spare. The phone's strip scrolls and holds every chip, so at 390 wide
// there is never one; a desktop width squeezes the row's tail into it. So the gallery steps run at a width that has the
// chip (as verify_escapable does, 900x820) and the phone width comes back after, whatever the step did.
const WIDE = { width: 900, height: 820 };
const PHONE = { width: 390, height: 844 };
async function atWidth(vp, fn) {
	await page.setViewportSize(vp);
	await wait(800);
	try { return await fn(); }
	finally { await page.setViewportSize(PHONE); await wait(800); }
}
async function kcase(tag, fn) {
	try { await fn(); }
	catch (e) { check(tag + 'x the case ran to its end', false, String((e && e.message) || e).split('\n')[0]); }
	// Whatever a failed case left up, the next one starts from the app at nought with nothing holding the keyboard.
	const x = await snap().catch(() => null);
	if (!x || x.depth !== 0 || x.st !== 0 || visCount(x) !== 0 || x.sheet || x.drawer) { await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {}); await wait(4000); }
	await page.evaluate(() => { const a = document.activeElement; if (a && a.blur) a.blur(); }).catch(() => {});
}

// K1. The Settings menu over the Web sheet: Escape closes the menu and leaves the sheet up.
await kcase('K1', async () => {
	await page.evaluate(() => { window.DaimondPanels.hide('web'); window.DaimondPanels.show('web'); });
	await wait(700);
	// A phone parks Settings in Help's popover, so it is reached as a person reaches it: Help, then the row.
	const h = await pressFrom('#help-btn');
	await wait(300);
	const r = await pressFrom('#settings-menu-btn');
	await wait(500);
	const b = await snap();
	const a = await esc();
	const f = await held();
	check('K1 Escape closes the Settings menu over the sheet and leaves the sheet up', h && r && b.sheet && b.pops.join() === 'settings-menu' && b.top === 'pop' && b.depth === 2
		&& dropped(b, a) && a.sheet && !a.pops.length && a.top === 'sheet' && heldOk(f), JSON.stringify({ h, r, b, a, f }));
});

// K2. The panel gallery over the Admin drawer: Escape closes the gallery and leaves the drawer up. At a width that has the
// gallery's chip, where the layer beneath is the Admin drawer (the phone's burger drawer has no chip to open it from).
await kcase('K2', async () => {
	await atWidth(WIDE, async () => {
		await spare();
		const d = await pressFrom('#user-row');
		await wait(600);
		const g = await pressFrom('#panel-more');
		await wait(500);
		const b = await snap();
		const a = await esc();
		const f = await held('#panel-more');
		check('K2 Escape closes the panel gallery over the Admin drawer and leaves the drawer up', d && g && b.admin && b.pops.join() === 'panel-gallery' && b.top === 'pop' && b.depth === 2
			&& dropped(b, a) && a.admin && !a.pops.length && a.top === 'admin' && heldOk(f), JSON.stringify({ d, g, b, a, f }));
	});
});

// K3. A dialog over the Admin drawer: Escape closes the dialog and leaves the drawer up.
await kcase('K3', async () => {
	const u = await pressFrom('#user-row');
	await wait(600);
	page.evaluate(() => DaimondCore.confirm('QA dialog?', 'OK', { title: 'QA' })).catch(() => {});
	await wait(500);
	const b = await snap();
	const a = await esc();
	const f = await held();
	check('K3 Escape closes a dialog over the Admin drawer and leaves the drawer up', u && b.admin && b.modals === 1 && /^dialog#/.test(b.top || '') && b.depth === 2
		&& dropped(b, a) && a.admin && a.modals === 0 && a.top === 'admin' && heldOk(f), JSON.stringify({ u, b, a, f }));
});

// K4. The palette: Escape closes it and gives the keyboard back to the control it was opened from.
await kcase('K4', async () => {
	await page.evaluate(() => document.getElementById('drawer-btn').focus());
	await page.keyboard.press('Control+k');
	await wait(500);
	const b = await snap();
	const a = await esc();
	const f = await held('#drawer-btn');
	check('K4 Escape closes the palette and returns the keyboard to what opened it', b.palette && b.top === 'palette' && b.depth === 1
		&& dropped(b, a) && !a.palette && a.top === null && heldOk(f), JSON.stringify({ b, a, f }));
});

// K5. The Chats menu over the drawer: Escape closes the menu and leaves the drawer up.
await kcase('K5', async () => {
	const d = await pressFrom('#drawer-btn');
	await wait(300);
	const m = await pressFrom('#chats-menu-btn');
	await wait(500);
	const b = await snap();
	const a = await esc();
	const f = await held('#chats-menu-btn');
	check('K5 Escape closes the Chats menu over the drawer and leaves the drawer up', d && m && b.drawer && b.chats && b.top === 'chatsmenu' && b.depth === 2
		&& dropped(b, a) && a.drawer && !a.chats && a.top === 'drawer' && heldOk(f), JSON.stringify({ d, m, b, a, f }));
});

// K6. The graph's link mode, inside the sheet, is a claim: the first Escape leaves the mode and not the sheet, the second leaves the sheet.
await kcase('K6', async () => {
	await page.evaluate(() => document.getElementById('drawer-btn').focus());
	await page.evaluate(() => window.DaimondPanels.show('graph'));
	await wait(900);
	await page.evaluate(() => window.DaimondGraph.linkMode(true));
	await wait(300);
	const linking = () => page.evaluate(() => { const g = document.getElementById('graph-body'); return !!g && g.classList.contains('linking'); });
	const l0 = await linking();
	const b = await snap();
	const a = await esc(700);
	const l1 = await linking();
	const z = await esc();
	const f = await held();
	check('K6 Escape leaves the graph\'s link mode first and the sheet second', l0 && b.sheet && b.depth === 1 && b.st === 1
		&& !l1 && a.sheet && a.depth === 1 && a.st === 1 && a.top === 'sheet'
		&& dropped(a, z) && !z.sheet && z.top === null && heldOk(f), JSON.stringify({ l0, b, l1, a, z, f }));
});

// K7. Escape and Back leave the same stack, one layer at a time: the drawer with a dialog over it, and with the Chats menu over it.
await kcase('K7', async () => {
	const core = (x) => JSON.stringify({ st: x.st, depth: x.depth, top: x.top === null ? null : x.top.replace(/#\d+$/, '#'), drawer: x.drawer, sheet: x.sheet,
		pops: x.pops, palette: x.palette, modals: x.modals, admin: x.admin, chats: x.chats });
	const build = async (kind) => {
		await pressFrom('#drawer-btn');
		await wait(300);
		if (kind === 'dialog') { page.evaluate(() => DaimondCore.confirm('QA agree?', 'OK', { title: 'QA' })).catch(() => {}); await wait(500); }
		else { await pressFrom('#chats-menu-btn'); await wait(500); }
		return snap();
	};
	const rows = [];
	for (const kind of ['dialog', 'menu']) {
		const b = await build(kind);
		const e1 = await esc();
		const e2 = await esc();
		const c = await build(kind);
		await back();
		await wait(900);
		const k1 = await snap();
		await back();
		await wait(900);
		const k2 = await snap();
		rows.push({ kind, built: b.depth === 2 && c.depth === 2 && core(b) === core(c), inner: core(e1) === core(k1) && e1.depth === 1 && e1.drawer,
			rest: core(e2) === core(k2) && e2.depth === 0 && e2.st === 0 && !e2.drawer, urls: e1.url.startsWith(APP) && k1.url.startsWith(APP) && e2.url.startsWith(APP) && k2.url.startsWith(APP),
			e1: core(e1), k1: core(k1), e2: core(e2), k2: core(k2) });
		const x = await snap();
		if (x.depth !== 0) { await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {}); await wait(4000); }
	}
	check('K7 Escape and Back agree on which layer is innermost, then on the next', rows.every((r) => r.built && r.inner && r.rest && r.urls), JSON.stringify(rows));
});

// K8. An opener alone gets the keyboard back from Escape: the drawer's burger and Help (phone width), the panel gallery's chip (a width that has one).
await kcase('K8', async () => {
	const rows = [];
	async function one(sel) {
		await page.evaluate(() => { const a = document.activeElement; if (a && a.blur) a.blur(); });
		const up = await pressFrom(sel);
		await wait(500);
		const b = await snap();
		const a = await esc();
		const f = await held(sel);
		rows.push({ sel, up, in: b.depth, out: a.depth, st: a.st, id: f.id, shown: f.shown, is: f.is });
	}
	await one('#drawer-btn');
	await one('#help-btn');
	await atWidth(WIDE, async () => { await spare(); await one('#panel-more'); });
	check('K8 each opener, alone, has the keyboard back after Escape', rows.length === 3 && rows.every((r) => r.up && r.in === 1 && r.out === 0 && r.st === 0 && r.shown && r.is), JSON.stringify(rows));
});

// K9. A claim holds Escape only while nothing has opened over it (r535 QA, MED-1). The graph's link mode, inside the
// sheet, with a dialog or the palette opened over it: the first Escape closes what is over the mode, the second ends
// the mode and leaves the sheet, the third leaves the sheet. Before the fix the first Escape ended the mode and left
// the dialog (or the palette) up.
const linkOn = () => page.evaluate(() => { const g = document.getElementById('graph-body'); return !!g && g.classList.contains('linking'); });
async function k9(tag, what, raise, isUp, topWant) {
	await page.evaluate(() => document.getElementById('drawer-btn').focus());
	await page.evaluate(() => window.DaimondPanels.show('graph'));
	await wait(900);
	await page.evaluate(() => window.DaimondGraph.linkMode(true));
	await wait(300);
	await raise();
	await wait(600);
	const l0 = await linkOn();
	const b = await snap();
	const a = await esc(700);
	const l1 = await linkOn();
	const z = await esc(700);
	const l2 = await linkOn();
	const y = await esc();
	check(tag + ' one Escape closes the ' + what + ' over the graph\'s link mode and leaves the mode, then the mode goes, then the sheet',
		l0 && b.sheet && b.depth === 2 && topWant.test(b.top || '') && isUp(b)
		&& dropped(b, a) && a.sheet && !isUp(a) && a.top === 'sheet' && l1
		&& z.sheet && z.depth === 1 && z.st === 1 && !l2
		&& dropped(z, y) && !y.sheet && y.top === null, JSON.stringify({ l0, b, a, l1, z, l2, y }));
}
await kcase('K9', async () => {
	await k9('K9a', 'dialog', () => { page.evaluate(() => DaimondCore.confirm('QA over graph?', 'OK', { title: 'QA' })).catch(() => {}); return Promise.resolve(); },
		(x) => x.modals === 1, /^dialog#/);
});
await kcase('K9b', async () => {
	await k9('K9b', 'palette', () => page.keyboard.press('Control+k'), (x) => x.palette, /^palette$/);
});

// `// gateway: none`: the world has no gateway, so the app's own /api reads answer 502 and are not what is checked.
const errs = errors(s).filter((e) => !/\/api\//.test(e));
check('E no page errors', errs.length === 0, JSON.stringify(errs).slice(0, 300));
console.log('\n' + nOk + ' ok, ' + bad.length + ' failed' + (bad.length ? ': ' + bad.join(' | ') : ''));
await s.close().catch(() => {});
site.close();
process.exit(bad.length ? 1 : 0);
