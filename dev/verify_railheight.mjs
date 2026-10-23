// gateway: none
// verify_railheight.mjs — the phone drawer's two lists, each a window of at least
// five whole tiles, with the drawer itself scrolling to reach what is below them.
//
// UNBLOCK-30 (owner, 2026-10-20): "the phone view rail ui has got ridiculous again,
// i can only see one or two diamond tiles or chat tiles at once, we need dual
// scrolling to provide scrollable windows of say min height 5 tiles or something".
// Measured at 390x845 on r578c with fourteen tagged Diamonds, eighteen chats, the
// credit cylinders and a runway line at the foot:
//
//   #pptw-global-row   47px   the pause row
//   Diamonds head      60px
//   .diamond-find      93px   search field (RAIL-SEARCH, 26d2e1760, 16 Oct) + tag filter
//   #diamond-list     156px   1 of 16 tiles whole, a tagged tile is 86px
//   Chats head         60px
//   #session-list     152px   2 of 18 tiles whole
//   #admin            230px   identity, calm line, runway, tallies and cylinders
//
// The lists were `flex: 1 1 0` sharing whatever `#rail-top` kept, and `#rail-top`
// was `overflow: hidden; min-height: 0`, so every row added above, between or below
// them came out of the two lists and nothing ever made the drawer scroll instead.
//
// The arm: each list shows at least five whole tiles, and scrolling the drawer
// reaches its foot with the money pools and Today whole on screen. Since the EV rail
// (D-20261020-14) the foot is three pools, each a battery, a dial and a range, and the
// same floor holds on the desktop rail (1440x900 and 1280x720), which scrolls for what
// does not fit, as the drawer does. Diamonds are
// counted in a mobile-emulated Chromium, because Playwright's WebKit has no OPFS
// to hold one (see verify_railmobile.mjs); the Chats list is counted in both.
//
//   bash dev/world.sh 93 --up
//   DAIMOND_APP=http://localhost:8870 node dev/verify_railheight.mjs [after.png]

import { open, signInAs } from './harness.mjs';
import { guardRan } from './verdict.mjs';

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 '
	+ '(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const SHOT = process.argv[2] || '';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

/// A signed-in phone session holding a realistic account: tagged Diamonds, a day's
/// chats, and the money foot an account with credits draws.
async function world(browser, desk = null) {
	const s = await open(desk
		? { name: 'railhd' + browser.slice(0, 2) + (Date.now() % 100000), browser, connect: false, viewport: desk }
		: { name: 'railh' + browser.slice(0, 2) + (Date.now() % 100000), browser, touch: true, connect: false, ua: UA });
	const p = s.page;
	if (!desk) await p.setViewportSize({ width: 390, height: 845 });
	await p.waitForFunction(() => !!window.DaimondCore, null, { timeout: 30000 });
	await p.evaluate(async () => {
		const m = await import('/pkg/oxedyne_daimond.js');
		const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
		const tags = ['work', 'writing', 'person', 'health', 'money', 'home'];
		for (let i = 0; i < 14; i++) { try { await app.create_diamond('Diamond project ' + (i + 1)); } catch (e) { /* no OPFS */ } }
		try {
			const ls = JSON.parse(await app.list_diamonds());
			for (let i = 0; i < ls.length; i++) await app.set_tags(ls[i].id, JSON.stringify([tags[i % 6], tags[(i + 2) % 6]]));
		} catch (e) { /* no OPFS */ }
		await new Promise((res) => {
			const now = Date.now(), rows = [];
			for (let i = 0; i < 18; i++) rows.push({ id: 'railh' + i, name: 'Seeded chat ' + (i + 1),
				createdAt: now - i * 36e5, updatedAt: now - i * 36e5, messages: [], msgCount: 2, model: 'mock/fast' });
			const r = indexedDB.open('daimond-chats');
			r.onsuccess = () => {
				let t;
				try { t = r.result.transaction('chats', 'readwrite'); } catch (e) { res(); return; }
				rows.forEach((x) => t.objectStore('chats').put(x));
				t.oncomplete = () => { try { localStorage.setItem('daimond-chats-count', String(rows.length)); } catch (e) {} res(); };
				t.onerror = () => res();
			};
			r.onerror = () => res();
		});
	});
	await p.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(s, s.name);
	// The seeded lists drawn before they are measured: a fixed 2 s once measured an
	// empty Diamonds list on a loaded machine (0 of 0 at 1440x900). WebKit has no OPFS,
	// so it waits for the Chats alone; a list that never fills still FAILs below.
	await p.waitForFunction((d) => document.querySelectorAll('#session-list .session-box').length >= 5
		&& (!d || document.querySelectorAll('#diamond-list .diamond-box').length >= 5), browser === 'chromium', { timeout: 20000 }).catch(() => {});
	await p.waitForTimeout(500);
	// The money foot of an account with three pools (D-20261020-14 EV): Daimond credits,
	// an OpenRouter key limit and an Anthropic credit, each a battery, a dial and a range,
	// drawn by the rail's own `poolsBlock`. This world has no gateway to report a
	// balance, so the gateway state and the providers are stood in for.
	const pools = await p.evaluate(async () => {
		const gs = DaimondGateway.state.bind(DaimondGateway);
		DaimondGateway.state = () => Object.assign({}, gs(), { authed: true, credits: 1250, currency: 'USD' });
		DaimondModels.providers = () => [
			{ id: 'openrouter', name: 'OpenRouter', hasKey: true, paid: false, credit: { mode: 'auto', usd: 37.18, binds: 'limit' } },
			{ id: 'anthropic', name: 'Anthropic', hasKey: true, paid: false, credit: { mode: 'manual', usd: 8.4 } },
		];
		DaimondLedger.record({ ts: Date.now(), model: 'mock/fast', promptTokens: 100, completionTokens: 100, costUsd: 0.5, provider: 'openrouter' });
		DaimondI18n.setCurrency('USD');
		await new Promise((r) => setTimeout(r, 400));
		return document.querySelectorAll('#spend-row .evp').length;
	});
	s.pools = pools;
	if (!desk) await p.evaluate(() => window.DaimondShell && DaimondShell.openDrawer());
	await p.waitForTimeout(600);
	return s;
}

/// Whole tiles in each list, read from the top of the list; heights of what is around them.
const survey = (p) => p.evaluate(() => {
	const H = (e) => (e ? Math.round(e.getBoundingClientRect().height) : 0);
	const whole = (sel, row) => {
		const l = document.querySelector(sel);
		if (!l) return { n: 0, of: 0, h: 0, scrolls: false };
		l.scrollTop = 0;
		const b = l.getBoundingClientRect();
		const all = [...l.querySelectorAll(row)].filter((x) => x.getBoundingClientRect().height > 0);
		const n = all.filter((x) => { const q = x.getBoundingClientRect(); return q.top >= b.top - 1 && q.bottom <= b.bottom + 1; }).length;
		return { n, of: all.length, h: H(l), tile: H(all[0]), scrolls: l.scrollHeight > l.clientHeight + 1 };
	};
	return { d: whole('#diamond-list', '.diamond-box'), c: whole('#session-list', '.session-box'),
		admin: H(document.getElementById('admin')) };
});

/// Scroll the drawer to its end: is the money foot whole on screen?
const foot = (p) => p.evaluate(() => {
	const r = document.querySelector('#panel-rail .rail-scroll') || document.getElementById('panel-rail');
	const f = document.getElementById('spend-row');
	if (!r || !f) return { ok: false, why: 'no rail or spend row' };
	r.scrollTop = r.scrollHeight;
	const rb = r.getBoundingClientRect(), fb = f.getBoundingClientRect();
	const res = { ok: fb.height > 0 && fb.top >= rb.top - 1 && fb.bottom <= rb.bottom + 1,
		why: `spend row ${Math.round(fb.top)}–${Math.round(fb.bottom)}, drawer ${Math.round(rb.top)}–${Math.round(rb.bottom)}, scroll ${r.clientHeight}/${r.scrollHeight}` };
	return res;
});

/// The drawer's scroller: an inner `.rail-scroll` once the drawer's frame stopped
/// being its scroller (FIRE ublk30b), the rail itself before that.
const SCROLLER = `document.querySelector('#panel-rail .rail-scroll') || document.getElementById('panel-rail')`;

/// Open Settings from `from` -- 'top' or 'foot' of an open drawer, or 'closed' for
/// a drawer that is put away -- and press its Back where a finger would.
///
/// ublk30 shipped a drawer that scrolls, and the Admin panel is `position: fixed`
/// inside it: the drawer's `transform` made it the panel's containing block, so the
/// panel opened at the top of the SCROLLED content. Tapping the identity row at the
/// drawer's foot put Back at y = -430 (both crawls, TRAPPED admin: home). A panel
/// opened with the drawer closed rode the closed drawer off the left edge. Back
/// must be whole on the screen, the topmost thing at its centre (a covered Back is
/// as trapped as a lost one), and a tap there must close the panel.
const adminBack = async (p, from) => {
	await p.evaluate(() => { const a = document.getElementById('admin');
		if (a && a.classList.contains('admin-open') && window.DaimondAdmin) DaimondAdmin.close(); });
	await p.waitForTimeout(300);
	if (from === 'closed') {
		await p.evaluate(() => window.DaimondShell && DaimondShell.closeDrawer());
		await p.waitForTimeout(500);
		await p.evaluate(() => DaimondAdmin.home());
	} else {
		await p.evaluate(() => window.DaimondShell && DaimondShell.openDrawer());
		await p.waitForTimeout(500);
		await p.evaluate(`(() => { const r = ${SCROLLER}; r.scrollTop = ${from === 'foot' ? 'r.scrollHeight' : '0'}; })()`);
		await p.waitForTimeout(300);
		await p.tap('#user-row');
	}
	await p.waitForTimeout(700);
	const m = await p.evaluate(`(() => {
		const r = ${SCROLLER}, c = document.getElementById('admin-close');
		const b = c.getBoundingClientRect(), x = b.left + b.width / 2, y = b.top + b.height / 2;
		const at = document.elementFromPoint(x, y);
		const whole = b.width > 0 && b.left >= 0 && b.top >= 0 && b.right <= innerWidth && b.bottom <= innerHeight;
		return { x, y, whole, top: !!at && (at === c || c.contains(at)),
			at: at ? (at.id || String(at.className) || at.tagName) : 'nothing (off the screen)',
			scroll: Math.round(r.scrollTop) + ' of ' + (r.scrollHeight - r.clientHeight),
			open: document.getElementById('admin').classList.contains('admin-open') };
	})()`);
	let closed = false;
	if (m.whole && m.top) {
		await p.touchscreen.tap(m.x, m.y);
		await p.waitForTimeout(500);
		closed = await p.evaluate(() => !document.getElementById('admin').classList.contains('admin-open'));
	}
	return { ok: m.open && m.whole && m.top && closed,
		why: `open ${m.open}, drawer scrolled ${m.scroll}, Back centre ${Math.round(m.x)},${Math.round(m.y)}, `
			+ `whole ${m.whole}, topmost ${m.top} (${m.at}), a tap closed it ${closed}` };
};
const ADMIN_FROM = [['top', 'an open drawer at its top'], ['foot', 'a drawer scrolled to its foot'], ['closed', 'a closed drawer']];

const sessions = [];
try {
	{
		const s = await world('chromium');
		sessions.push(s);
		const p = s.page;
		check('Chromium 390x845: the rail draws three pools', s.pools === 3, String(s.pools));
		const m = await survey(p);
		check('Chromium 390x845: the Diamonds list shows at least five whole tiles',
			m.d.n >= 5 && m.d.of >= 5, `${m.d.n} of ${m.d.of} whole in ${m.d.h}px, a tile ${m.d.tile}px`);
		check('and it is still a window that scrolls inside itself', m.d.scrolls);
		check('Chromium 390x845: the Chats list shows at least five whole tiles',
			m.c.n >= 5 && m.c.of >= 5, `${m.c.n} of ${m.c.of} whole in ${m.c.h}px, a tile ${m.c.tile}px`);
		check('and it is still a window that scrolls inside itself', m.c.scrolls);
		if (SHOT) await p.screenshot({ path: SHOT });
		// A search narrowing the list to one Diamond leaves its window where it was:
		// the five-tile floor is the tile's height, not the count of what matched.
		const before = m.d.h;
		await p.fill('#diamond-search', 'project 14');
		await p.waitForTimeout(400);
		const n = await survey(p);
		check('a search that leaves one Diamond does not shrink the window', n.d.of === 1 && Math.abs(n.d.h - before) <= 1,
			`${n.d.of} shown, ${before}px → ${n.d.h}px`);
		await p.fill('#diamond-search', '');
		await p.waitForTimeout(400);
		const f = await foot(p);
		check('scrolling the drawer reaches its foot, the three pools and Today whole', f.ok, f.why);
		if (SHOT) await p.screenshot({ path: SHOT.replace(/\.png$/, '') + '_foot.png' });
		for (const [from, says] of ADMIN_FROM) {
			const a = await adminBack(p, from);
			check(`Chromium: Settings opened from ${says} has Back whole on screen, on top, and a tap closes it`, a.ok, a.why);
		}
	}
	// THE DESKTOP RAIL (D-20261020-14 EV): three pools at the foot, and each list still
	// a window of five whole tiles; the rail scrolls for what does not fit.
	for (const [browser, vp] of [['chromium', { width: 1440, height: 900 }], ['chromium', { width: 1280, height: 720 }], ['webkit', { width: 1440, height: 900 }]]) {
		const s = await world(browser, vp);
		sessions.push(s);
		const p = s.page, at = `${browser} ${vp.width}x${vp.height}`;
		check(`${at}: the rail draws three pools`, s.pools === 3, String(s.pools));
		const m = await survey(p);
		if (browser === 'chromium') check(`${at}: the Diamonds list shows at least five whole tiles`,
			m.d.n >= 5 && m.d.of >= 5, `${m.d.n} of ${m.d.of} whole in ${m.d.h}px, a tile ${m.d.tile}px`);
		check(`${at}: the Chats list shows at least five whole tiles`,
			m.c.n >= 5 && m.c.of >= 5, `${m.c.n} of ${m.c.of} whole in ${m.c.h}px, a tile ${m.c.tile}px`);
		const f = await foot(p);
		check(`${at}: the rail reaches its foot, the three pools and Today whole`, f.ok, f.why);
		if (SHOT && browser === 'chromium' && vp.width === 1440) await p.screenshot({ path: SHOT.replace(/\.png$/, '') + '_desk.png' });
	}
	{
		const s = await world('webkit');
		sessions.push(s);
		check('WebKit 390x845: the rail draws three pools', s.pools === 3, String(s.pools));
		const m = await survey(s.page);
		check('WebKit 390x845: the Chats list shows at least five whole tiles',
			m.c.n >= 5 && m.c.of >= 5, `${m.c.n} of ${m.c.of} whole in ${m.c.h}px, a tile ${m.c.tile}px`);
		const f = await foot(s.page);
		check('WebKit: scrolling the drawer reaches its foot', f.ok, f.why);
		for (const [from, says] of ADMIN_FROM) {
			const a = await adminBack(s.page, from);
			check(`WebKit: Settings opened from ${says} has Back whole on screen, on top, and a tap closes it`, a.ok, a.why);
		}
		console.log('  NOT COVERED  WebKit Diamonds count: Playwright WebKit has no OPFS to hold a Diamond');
	}
} finally {
	for (const s of sessions) { try { await s.close(); } catch (e) { /* already gone */ } }
}

guardRan(ok.length + bad.length);
console.log(`\n${ok.length} ok, ${bad.length} failed`);
if (bad.length) { bad.forEach((b) => console.log('  FAILED: ' + b)); process.exit(1); }
