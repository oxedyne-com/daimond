// verify_reloadpush.mjs — a reload with nothing to say sends nothing.
//
// The sync chip cycles twice after a hard refresh, a couple of seconds apart.
// The first is the boot pull; the second is the push `onAuthed` schedules
// behind it, and that one is the subject here. `push()` skips a parcel it has
// already sent, but the fixed point it compares against lived only in memory,
// so it began every page empty and the guard could not match — and the WHOLE
// parcel went up on every reload whether or not a byte had changed. Measured at
// 163 KB on an account holding one chat.
//
// What it cost was not credits: `sync_per_mib_minor` is "0" on the deployed
// route, so a push is not priced today. It cost the upload, the gateway's
// write, a version bump, and a wake sent to every other device of the account —
// each of which then pulled and merged a parcel identical to what it already
// held. This file measures the last of those with a second real device.
//
// The fixed point is a digest now, and it persists. So the danger this file
// exists to guard is the opposite one: a device that skips a push it OWED.
// Four of the checks below are about that and nothing else — a real change
// after a reload, a stored digest that is unreadable, one written by another
// format, and one belonging to another account.
//
// Needs the dev stack: the app (DAIMOND_PORT), the mock, and a gateway on
// DAIMOND_GW_PORT. Sync is Pro-gated, so the account is granted Pro the one way
// the gateway trusts (dev/pro.mjs).

import { open, chat, signInAs, newChat } from './harness.mjs';
import { makePagePro } from './pro.mjs';
import { GW_URL } from './ports.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

/// Count POSTs to the mailbox on this page, with the bytes each carried.
const counter = (page) => {
	const seen = [];
	page.on('request', (r) => {
		try {
			const u = new URL(r.url());
			if (u.pathname === '/api/sync' && r.method() === 'POST') {
				let n = 0;
				try { n = (r.postData() || '').length; } catch (e) { /* unreadable */ }
				seen.push(n);
			}
		} catch (e) { /* not a URL this counts */ }
	});
	return seen;
};

const state  = (pg) => pg.evaluate(() => window.DaimondSync.state());
const quiet  = (pg) => pg.evaluate(() => window.DaimondSync.state().quiet);
const parcel = (pg) => pg.evaluate(async () => JSON.stringify(await window.DaimondSync.parcel()));
/// The raw key this build persists its fixed point under, un-namespaced.
const sigRaw = (pg) => pg.evaluate(() => localStorage.getItem('daimond-sync-sig'));
/// Every storage key holding a fixed point, however namespaced. See accounts.js.
const sigKeys = (pg) => pg.evaluate(() => {
	const out = [];
	for (let i = 0; i < localStorage.length; i++) {
		const k = localStorage.key(i);
		if (k && k.indexOf('daimond-sync-sig') !== -1) out.push(k);
	}
	return out.sort();
});

/// Wait until nothing is running and nothing is armed.
const settle = async (pg, ms = 20000) => {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		if (await quiet(pg)) { await pg.waitForTimeout(1500); if (await quiet(pg)) return true; }
		await pg.waitForTimeout(400);
	}
	return false;
};

/// Reload, sign back in, and wait long enough for the boot pull AND the push it
/// schedules behind it to have happened or decided not to.
const reload = async (s, name) => {
	await s.page.reload({ waitUntil: 'domcontentloaded' });
	const pushes = counter(s.page);
	await signInAs(s, name);
	await s.page.waitForFunction(
		() => !!window.DaimondSync && window.DaimondGateway && DaimondGateway.state().authed,
		null, { timeout: 20000 }).catch(() => {});
	// Longer than PUSH_DEBOUNCE_MS by a wide margin, so a push that is coming has
	// come. A check that waited only for the debounce would pass on a slow box by
	// measuring a push that had not been made yet.
	await s.page.waitForTimeout(11000);
	return pushes;
};

const a = await open({ name: 'rpush', signIn: true, connect: true, defaults: false });
let b = null;
try {
	await a.page.waitForFunction(
		() => !!window.DaimondSync && !!window.DaimondCore && window.DaimondGateway
			&& DaimondGateway.state().authed,
		null, { timeout: 15000 }).catch(() => {});
	const pro = await makePagePro(a.page, new URL('../gateway', import.meta.url).pathname, GW_URL);
	check('the account holds Pro, so a push is not refused before it is measured',
		pro.pro === true, JSON.stringify(pro));

	await newChat(a);
	await chat(a, 'one turn, so there is something to sync at all');
	await settle(a.page);
	await a.page.waitForTimeout(3000);

	// ── The control ────────────────────────────────────────────────────
	// An idle tab nobody reloads already sends nothing. If this ever fails, the
	// in-memory half of the guard has broken and every check below is measuring
	// the wrong thing.
	const idle = counter(a.page);
	await a.page.waitForTimeout(15000);
	check('an idle tab that is not reloaded sends nothing', idle.length === 0,
		idle.length + ' push(es)');

	// ── (1) A reload with nothing changed ──────────────────────────────
	// The ledger is re-priced once per page life (js/ledger.js), which really
	// does move the parcel, so the FIRST reload after a metered turn has
	// something honest to send. The claim under test is about a reload with
	// nothing to say, so the parcel is compared rather than assumed: what must
	// send nothing is a reload across which the parcel did not move.
	await reload(a, 'rpush');
	await settle(a.page);
	const before = await parcel(a.page);
	const sigBefore = await sigRaw(a.page);
	check('a fixed point was written down, so the next page has one to read',
		!!sigBefore && /"v":\s*1/.test(sigBefore) && /"sig":\s*"[0-9a-f]{64}"/.test(sigBefore),
		String(sigBefore).slice(0, 90));

	const quietReload = await reload(a, 'rpush');
	const after = await parcel(a.page);
	check('the parcel really did not move across that reload', before === after,
		before === after ? '' : 'it moved, so this check cannot speak');
	check('a reload with nothing to say sends nothing',
		quietReload.length === 0,
		quietReload.length + ' push(es)'
			+ (quietReload.length ? ' of ' + quietReload.map(n => Math.round(n / 1024) + 'K').join(', ') : ''));
	const chipAfter = await a.page.evaluate(() => {
		const e = document.getElementById('sync-chip');
		return e ? { st: e.dataset.state || '', shown: e.style.display !== 'none' } : null;
	});
	check('and the chip is not left claiming a round that never happened',
		!!chipAfter && chipAfter.st !== 'syncing', JSON.stringify(chipAfter));

	// ── (2) A reload after a REAL change still sends ───────────────────
	// The whole hazard of persisting a fixed point. A device that skipped a push
	// it owed would leave the user's work here and nothing anywhere saying so,
	// which is worse than the upload this change removes.
	await chat(a, 'a second turn, made before the reload');
	await settle(a.page);
	const real = await reload(a, 'rpush');
	check('a reload after a real change still sends it', real.length >= 1,
		real.length + ' push(es)');

	// ── (3) An unreadable fixed point sends ────────────────────────────
	await settle(a.page);
	await a.page.evaluate(() => localStorage.setItem('daimond-sync-sig', 'not json at all'));
	const corrupt = await reload(a, 'rpush');
	check('a fixed point that cannot be read sends rather than skips',
		corrupt.length >= 1, corrupt.length + ' push(es)');

	// ── (4) A fixed point from another format sends ────────────────────
	await settle(a.page);
	// A DIGEST OF ITS OWN rather than one read back out of storage. What is there
	// at this moment depends on whether the build under test writes that key at
	// all -- the one this file was written against does not -- so reading it back
	// made the fixture throw on the very code it exists to measure, and the run
	// ended four checks early with a JSON parse error standing where a result
	// should have been. The value only has to be well formed and to name a
	// version this build does not know.
	await a.page.evaluate(() => {
		localStorage.setItem('daimond-sync-sig', JSON.stringify({
			v: 99, sig: '0'.repeat(64),
		}));
	});
	const older = await reload(a, 'rpush');
	check('a fixed point a different format wrote sends rather than skips',
		older.length >= 1, older.length + ' push(es)');

	// ── (5) It is namespaced with the parcel it describes ──────────────
	// accounts.js prefixes every `daimond-*` key for a non-primary account, so a
	// second account on one browser must not answer this one's question. Asserted
	// on the key rather than on the prefix rule, which is accounts.js's to keep.
	await settle(a.page);
	const keys = await sigKeys(a.page);
	const ns = await a.page.evaluate(() => ({
		prefix: window.DaimondAccounts ? DaimondAccounts.prefix() : '(no accounts.js)',
		count:  window.DaimondAccounts ? DaimondAccounts.count() : 0,
	}));
	check('the fixed point lands in the account namespace, beside the version it belongs to',
		keys.length === 1 && keys[0] === ns.prefix + 'daimond-sync-sig',
		JSON.stringify(keys) + ' with prefix ' + JSON.stringify(ns.prefix));

	// ── (6) The pull is untouched ──────────────────────────────────────
	// The fixed point gates the push and must go on gating only the push. A
	// device that consulted it before deciding whether to LOOK would sit on its
	// own stale copy while the other device's work waited in the mailbox — the
	// hypothesis disproved on 2026-08-27, which this change must not introduce.
	b = await open({ name: 'rpushmate', signIn: false, connect: false });
	await b.page.waitForFunction(() => !!window.DaimondPairing, null, { timeout: 15000 }).catch(() => {});
	const code = await a.page.evaluate(() => DaimondPairing.create());
	await b.page.evaluate((c) => DaimondPairing.redeem(c), code.code);
	await b.page.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(b, 'rpush');
	await b.page.waitForFunction(
		() => !!window.DaimondSync && window.DaimondGateway && DaimondGateway.state().authed,
		null, { timeout: 20000 }).catch(() => {});
	await b.page.waitForTimeout(6000);

	// The second device makes a change and sends it. This one reloads, with its
	// own fixed point sitting in storage, and must still come back with the work.
	await b.page.evaluate(async () => {
		const m = await import('/pkg/oxedyne_daimond.js');
		const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
		await app.create_diamond('Made-While-The-Other-Was-Away');
	});
	// PUSHED BY HAND, and that is not laziness. `create_diamond` through a fresh
	// `DaimondApp` does not go through the app's own funnels, so nothing on that
	// device schedules a push and the Diamond sits in its store. The first cut of
	// this check waited for a push that was never going to be made, timed out, and
	// then reported the missing Diamond as a fault in the fixed point -- which is
	// exactly the failure it was written to catch, arriving from the fixture
	// instead of from the product.
	const sent = await b.page.evaluate(async (ms) => {
		const mailbox = async () => {
			const r = await fetch('/api/sync', { credentials: 'same-origin', headers: { 'x-daimond-api': '1' } });
			const j = await r.json();
			if (!j.present) return null;
			try { return await window.DaimondIdentity.unwrap(j.blob); }
			catch (e) { return null; }
		};
		const mine = new Set();
		const t0 = Date.now();
		while (Date.now() - t0 < ms) {
			await window.DaimondSync.push();
			mine.add(JSON.stringify(await window.DaimondSync.parcel()));
			const held = await mailbox();
			if (held !== null && mine.has(held)) return true;
			await new Promise(r => setTimeout(r, 250));
		}
		return false;
	}, 25000);
	check('the other device really put its Diamond in the mailbox', sent === true);
	await reload(a, 'rpush');
	const names = await a.page.evaluate(async () => {
		const m = await import('/pkg/oxedyne_daimond.js');
		const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
		return JSON.parse(await app.list_diamonds()).map(d => d.name);
	});
	check('a reload still PULLS — the fixed point gates the push and nothing else',
		names.indexOf('Made-While-The-Other-Was-Away') !== -1, JSON.stringify(names));

	// ── (7) And the other device is not woken for nothing ──────────────
	// What the wasted push actually cost the account: every other device was
	// tapped and pulled a parcel identical to the one it already held.
	await settle(a.page);
	await b.page.waitForTimeout(3000);
	const wokeBefore = await b.page.evaluate(() => window.DaimondSync.wake().wakes);
	const lastQuiet = await reload(a, 'rpush');
	await b.page.waitForTimeout(4000);
	const wokeAfter = await b.page.evaluate(() => window.DaimondSync.wake().wakes);
	check('and a reload that sends nothing does not wake the account’s other device',
		lastQuiet.length === 0 && wokeAfter === wokeBefore,
		lastQuiet.length + ' push(es), wakes ' + wokeBefore + ' -> ' + wokeAfter);

	const st = await state(a.page);
	check('the engine is left in a good state, not stalled', st.stalled === false,
		JSON.stringify({ stalled: st.stalled, why: st.stalledWhy, failed: st.failedParts }));
} catch (e) {
	check('the run finished', false, String((e && e.stack) || e));
} finally {
	if (b) await b.close();
	await a.close();
}

console.log('\n' + ok.length + ' ok, ' + bad.length + ' failed');
if (bad.length) { for (const l of bad) console.log('  FAILED: ' + l); }
process.exit(bad.length ? 1 : 0);
