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
	};
});
const visCount = (x) => (x.drawer ? 1 : 0) + (x.sheet ? 1 : 0) + (x.pops.length ? 1 : 0) + (x.palette ? 1 : 0) + x.modals + (x.admin ? 1 : 0);
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

// `// gateway: none`: the world has no gateway, so the app's own /api reads answer 502 and are not what is checked.
const errs = errors(s).filter((e) => !/\/api\//.test(e));
check('E no page errors', errs.length === 0, JSON.stringify(errs).slice(0, 300));
console.log('\n' + nOk + ' ok, ' + bad.length + ' failed' + (bad.length ? ': ' + bad.join(' | ') : ''));
await s.close().catch(() => {});
site.close();
process.exit(bad.length ? 1 : 0);
