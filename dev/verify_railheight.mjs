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
// reaches its foot with the tallies and cylinders whole on screen. Diamonds are
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
async function world(browser) {
	const s = await open({ name: 'railh' + browser.slice(0, 2) + (Date.now() % 100000), browser, touch: true, connect: false, ua: UA });
	const p = s.page;
	await p.setViewportSize({ width: 390, height: 845 });
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
	await p.waitForTimeout(2000);
	// The credit cylinders and a runway line, as `balanceCell` draws them for an
	// account with credits: this world has no gateway to report a balance.
	await p.evaluate(() => {
		const el = document.getElementById('spend-row'), G = window.DaimondAgentGrid;
		if (!el || !G) return;
		const rw = document.createElement('div'); rw.className = 'spend-runway';
		rw.textContent = 'Daimond credits run out in about 5 h.';
		el.insertBefore(rw, el.firstChild);
		const c = document.createElement('div'); c.className = 'spend-cell spend-balance';
		c.innerHTML = '<span class="spend-label">Balance</span><span class="spend-cyls">'
			+ G.cylinderSvg(0.6, false, 'a') + G.cylinderSvg(0.2, true, 'b') + '</span>';
		el.appendChild(c);
	});
	await p.evaluate(() => window.DaimondShell && DaimondShell.openDrawer());
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
	const r = document.getElementById('panel-rail'), f = document.getElementById('spend-row');
	if (!r || !f) return { ok: false, why: 'no rail or spend row' };
	r.scrollTop = r.scrollHeight;
	const rb = r.getBoundingClientRect(), fb = f.getBoundingClientRect();
	const res = { ok: fb.height > 0 && fb.top >= rb.top - 1 && fb.bottom <= rb.bottom + 1,
		why: `spend row ${Math.round(fb.top)}–${Math.round(fb.bottom)}, drawer ${Math.round(rb.top)}–${Math.round(rb.bottom)}, scroll ${r.clientHeight}/${r.scrollHeight}` };
	return res;
});

const sessions = [];
try {
	{
		const s = await world('chromium');
		sessions.push(s);
		const p = s.page;
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
		check('scrolling the drawer reaches its foot, tallies and cylinders whole', f.ok, f.why);
		if (SHOT) await p.screenshot({ path: SHOT.replace(/\.png$/, '') + '_foot.png' });
	}
	{
		const s = await world('webkit');
		sessions.push(s);
		const m = await survey(s.page);
		check('WebKit 390x845: the Chats list shows at least five whole tiles',
			m.c.n >= 5 && m.c.of >= 5, `${m.c.n} of ${m.c.of} whole in ${m.c.h}px, a tile ${m.c.tile}px`);
		const f = await foot(s.page);
		check('WebKit: scrolling the drawer reaches its foot', f.ok, f.why);
		console.log('  NOT COVERED  WebKit Diamonds count: Playwright WebKit has no OPFS to hold a Diamond');
	}
} finally {
	for (const s of sessions) { try { await s.close(); } catch (e) { /* already gone */ } }
}

guardRan(ok.length + bad.length);
console.log(`\n${ok.length} ok, ${bad.length} failed`);
if (bad.length) { bad.forEach((b) => console.log('  FAILED: ' + b)); process.exit(1); }
