// verify_pausetabs.mjs -- a pause pressed in one tab holds every other open tab of the
// same account on the same device, at the wire.
//
// D2 of the delta re-check of Deploy 1 (2026-09-24). pause.js read `daimond-pause` and
// `daimond-pause-here` once per page, and nothing listened for another tab's write. So
// "Pause all" in tab A left tab B playing: a mail arrival in B fired a released triggered
// action, and B's web doors stayed open. Only a reload of B caught up. The rule now:
// another tab's write re-reads both records, settles and announces; and every change
// re-reads before it writes, so a stale tab never writes back a set it did not load
// (`www/js/pausetabs.test.mjs` drives that half without a browser).
//
//   A. Tab A releases a daimon-written action by a person's play; tab B, opened after,
//      sees it live.
//   B. Tab A presses Pause all. A second later tab B holds the action, the web and every
//      leaf a person could hold, and its own rail's light says so -- with no reload.
//   C. In tab B a mail arrival starts no turn, and the web's doors -- a search and a page
//      fetch, refused on `root/web` before anything leaves the page -- are shut.
//
// Not asserted: a turn a person types. On a key of their own it is refused nowhere (the
// pause is enforced where money is committed: the gateway's mint, the dispatch gate and the
// gateway's spend routes), in the tab that paused as in any other, so a world with no
// gateway cannot tell a stale tab from a current one by it. The mint reads `isPaused`, which
// is what B asks below.
//   D. The other direction: the Web panel's play in tab B lets the web go in tab A.
//
//   eval "$(bash dev/world.sh N --up)"
//   node dev/verify_pausetabs.mjs                    # the fix: every check passes
//   PAUSETABS_BASE=b32be427 node dev/verify_pausetabs.mjs
//                                                    # every www/js file that differs from
//                                                    # that revision served as it was: B-D fail
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, newChat, mockLog, scratch, connectMock, signInAs, APP } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TREE = path.join(HERE, '..');
const BASE = process.env.PAUSETABS_BASE || '';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail != null ? ' — ' + detail : ''));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RUN = Date.now().toString(36);
const BOX = 'tabs@example.test';
const NAME = 'pausetabs';
const said = (from, nonce) => mockLog().slice(from).some((e) => JSON.stringify(e).includes(nonce));

/// Every www/js file that differs from the base, served as it stood there, to every tab.
async function routeBase(page) {
	if (!BASE) return;
	const files = execFileSync('git', ['-C', TREE, 'diff', '--name-only', BASE, '--', 'www/js'])
		.toString().split('\n').filter((f) => /\.js$/.test(f));
	for (const f of files) {
		const body = execFileSync('git', ['-C', TREE, 'show', BASE + ':' + f], { maxBuffer: 1 << 26 }).toString();
		await page.context().route('**/' + f.replace(/^www\//, '') + '*', (r) => r.fulfill({ status: 200,
			contentType: 'application/javascript', body }));
	}
	console.log('  ..   serving ' + files.join(', ') + ' as at ' + BASE);
}

const s = await open({ name: NAME, defaults: false, route: routeBase, profile: scratch('pw', 'pausetabs-' + process.pid) });
const p = s.page;
// The harness's form-driven connect waits fixed times and can miss under load.
for (let i = 0; i < 4 && !(s.cfg && s.cfg.baseUrl); i++) {
	await p.keyboard.press('Escape').catch(() => {});
	await sleep(1500);
	await connectMock(s);
}

/// Where one action stands in one tab, as that tab would judge it.
const where = (pg, id, aid) => pg.evaluate(({ id, aid }) => {
	const T = window.DaimondTriggers;
	const t = (window.DaimondTriggersOf(id) || []).find((x) => x.id === aid);
	if (!t) return { found: false };
	const lamp = (sel) => { const g = document.querySelector(sel); return g ? g.dataset.state : '(none)'; };
	return {
		found: true,
		allowed: T.allowed(id, t),
		web: DaimondPause.isPaused('root/web'),
		byHand: DaimondPause.heldByHand('root'),
		rail: lamp('#pptw-global .pptw'),
		tile: lamp(`#diamond-list .diamond-box[data-id="${id}"] .pptw`),
	};
}, { id, aid });

/// A turn typed into a Diamond's own chat, in one tab: here, the daimon's `file_write`.
async function daimonWrites(pg, id, content, marker) {
	await pg.evaluate((id) => {
		const b = document.querySelector(`#diamond-list .diamond-box[data-id="${id}"]`);
		if (b) b.click();
	}, id);
	await sleep(1200);
	await pg.evaluate(() => { const b = document.getElementById('dview-chat'); if (b) b.click(); });
	await sleep(500);
	await pg.waitForSelector('#chat-input', { timeout: 15000 });
	await pg.fill('#chat-input', '@tool file_write ' + JSON.stringify({ path: 'diamonds/' + id + '/triggers.json', content }));
	await pg.click('#chat-send', { force: true });
	for (let i = 0; i < 60; i++) {
		await sleep(1000);
		const disk = await pg.evaluate(async (id) => {
			const M = await import('/pkg/oxedyne_daimond.js');
			try { return await M.store_read('diamonds/' + id + '/triggers.json'); } catch (e) { return ''; }
		}, id);
		const busy = await pg.evaluate((id) => { try { return !!DaimondCore.diamondBusy(id); } catch (e) { return false; } }, id);
		if (disk.includes(marker) && !busy) break;
	}
	await pg.evaluate(() => DaimondCore.loadDiamonds());
	await sleep(1500);
}

let pB = null;
try {
	await p.waitForFunction(() => !!(window.DaimondCore && window.DaimondTriggers && window.DaimondPause), null, { timeout: 30000 });
	await sleep(2500);
	await p.click('#new-diamond-btn', { force: true });
	await p.waitForSelector('.dlg-input', { timeout: 20000 });
	await p.fill('.dlg-input', 'Two tabs');
	await p.waitForSelector('.dlg-ok:not([disabled])', { timeout: 10000 });
	await sleep(300);
	await p.click('.dlg-ok:not([disabled])');
	let id = '';
	for (let i = 0; i < 20 && !id; i++) {
		await sleep(1000);
		id = await p.evaluate(() => {
			const b = [...document.querySelectorAll('#diamond-list .diamond-box')]
				.find((x) => /Two tabs/.test(x.getAttribute('aria-label') || x.textContent || ''));
			return b ? b.dataset.id : '';
		});
	}
	check('setup: a Diamond made through the dialog a person uses', !!id, id);
	const NT = 'TABS-' + RUN;
	await daimonWrites(p, id, JSON.stringify({ v: 1, actions: [{ id: 'm-tabs', kind: 'mail', mailbox: BOX,
		folder: 'Tabs', instruction: '@text ' + NT, offScreen: true }] }), 'm-tabs');

	// ── A. released in tab A, seen in tab B ─────────────────────────────
	const play = `#diamond-list .diamond-box[data-id="${id}"] .pptw .pptw-play`;
	await p.evaluate((id) => { const b = document.querySelector(`#diamond-list .diamond-box[data-id="${id}"]`); if (b) b.scrollIntoView(); }, id);
	let pressed = true;
	try { await p.click(play, { timeout: 8000 }); } catch (e) { pressed = false; }
	await sleep(800);
	const a0 = await where(p, id, 'm-tabs');
	check('A. tab A: a person\'s play releases the daimon-written action', pressed && a0.allowed === true, JSON.stringify(a0));

	pB = await s.browser.newPage();
	await pB.goto(APP, { waitUntil: 'domcontentloaded' });
	try { await signInAs({ ...s, page: pB }, NAME); } catch (e) { console.log('  ..   tab B sign-in: ' + e.message); }
	await pB.waitForFunction(() => !!(window.DaimondCore && window.DaimondTriggers && window.DaimondPause), null, { timeout: 30000 });
	await sleep(4000);
	await pB.evaluate(() => DaimondCore.loadDiamonds());
	await sleep(1500);
	const b0 = await where(pB, id, 'm-tabs');
	check('A. tab B, opened after it, sees it live', b0.found && b0.allowed === true, JSON.stringify(b0));

	// ── B. Pause all in tab A holds tab B ──────────────────────────────
	await p.bringToFront();
	await p.click('#pptw-global .pptw-act[data-act="pause"]', { timeout: 8000 });
	await sleep(1000);
	const a1 = await where(p, id, 'm-tabs');
	check('B. tab A: Pause all holds everything there', a1.allowed === false && a1.web === true && a1.byHand === true,
		JSON.stringify(a1));
	await pB.bringToFront();
	await sleep(1500);
	const b1 = await where(pB, id, 'm-tabs');
	check('B. tab B, a second later and with no reload: the action is held', b1.allowed === false, JSON.stringify(b1));
	check('B. and the web, and everything a person could hold', b1.web === true && b1.byHand === true, JSON.stringify(b1));
	check('B. and tab B\'s own rail and tile say so', b1.rail === 'pause' && b1.tile === 'pause', JSON.stringify(b1));

	// ── C. at the wire, in tab B ───────────────────────────────────────
	try { await newChat({ ...s, page: pB }); } catch (e) { /* already on one */ }
	await sleep(1500);
	let from = mockLog().length;
	await pB.evaluate(({ box }) => window.dispatchEvent(new CustomEvent('daimond:mail-arrived',
		{ detail: { mailbox: box, folder: 'Tabs', count: 1, uids: [Date.now() % 100000] } })), { box: BOX });
	let fired = false;
	for (let i = 0; i < 20 && !fired; i++) { await sleep(1000); fired = said(from, NT); }
	check('C. tab B: a mail arrival starts NO turn', !fired,
		fired ? 'the provider was sent ' + NT + ' from tab B' : 'nothing in 20 s');
	// The doors themselves: search.js's own search, and a page fetch through the wrapped
	// fetch. Refused, each says `PAUSED root/web`; let through, each reaches a world with no
	// gateway and says so.
	const doors = await pB.evaluate(async () => {
		const out = {};
		try { await DaimondSearch.search('pausetabs probe'); out.search = 'went'; }
		catch (e) { out.search = (e && e.paused ? 'PAUSED ' + e.pauseNode + ': ' : '') + String(e && e.message || e).slice(0, 80); }
		try {
			const r = await fetch('/api/web/fetch', { method: 'POST', headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ url: 'https://example.com/' }) });
			const j = await r.json().catch(() => ({}));
			out.fetch = r.status + (j.paused ? ' PAUSED ' + j.node : '') + ' ' + String(j.error || '').slice(0, 60);
		} catch (e) { out.fetch = 'threw ' + e.message; }
		return out;
	});
	check('C. tab B: a search is refused at the door, on the web leaf', /^PAUSED root\/web/.test(doors.search), doors.search);
	check('C. tab B: a page fetch is refused at the door (423)', /^423 PAUSED root\/web/.test(doors.fetch), doors.fetch);

	// ── D. the other direction ─────────────────────────────────────────
	const webPlay = await pB.evaluate(() => {
		const b = document.querySelector('.pptw[data-pause-node="root/web"] .pptw-act[data-act="play"]');
		if (b && !b.disabled) { b.click(); return 'the Web panel\'s play'; }
		DaimondPause.set('root/web', true);
		return 'set(root/web, true), the call its play makes (no Web control drawn)';
	});
	await sleep(1500);
	const a2 = await where(p, id, 'm-tabs');
	check('D. play on the web in tab B lets the web go in tab A, and nothing else',
		a2.web === false && a2.allowed === false, webPlay + ' | ' + JSON.stringify(a2));
} catch (err) {
	check('the run finished', false, String(err && err.stack || err));
} finally {
	await s.close();
}
console.log(`\n${ok.length} ok, ${bad.length} failed`);
process.exit(bad.length ? 1 : 0);
