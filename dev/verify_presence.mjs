// verify_presence.mjs — a presence beat travels off the content parcel, on a
// path that wakes nobody.
//
// The desktop-peer presence beat used to write a live wall-clock timestamp into
// the SYNC CONTENT PARCEL and re-upload the whole ~163K parcel every 45s, waking
// every other device forever and making the parcel a moving target that no fixed
// point could ever match (breaking dev/verify_reloadpush.mjs). The fix moves
// presence onto the gateway's OWN lightweight, non-waking route:
//
//   - a beat is `POST /api/sync?presence=1` with `{device_id, name}`, answered
//     with `{ok, now, presence:{ id:{name,last_seen}, ... }}`. It bumps no blob
//     version and wakes nobody.
//   - the ordinary pull (`GET /api/sync`) now also carries `presence` and `now`,
//     adopted for free.
//   - every last_seen is stamped in the SERVER clock; the client converts it into
//     its own frame (DaimondPresence.ingest), so freshness checks that read
//     Date.now() stay skew-immune and unchanged.
//
// This proves, with TWO real paired contexts (device a and device b):
//   (a) a beat produces NO content /api/sync POST and does NOT wake device b;
//   (b) device b, after device a beats, sees device a as an awake peer, named;
//   (c) presence is NOT in the content parcel — it is byte-stable across beats;
//   (d) a device that stops beating ages out of `awake` after the fresh window.
//
// Needs the dev stack: the app (DAIMOND_PORT), the mock, and a gateway on
// DAIMOND_GW_PORT that speaks the presence path. Presence rides the Pro-gated
// /api/sync door, so the account is granted Pro the one way the gateway trusts
// (dev/pro.mjs).

import { open, chat, signInAs, newChat } from './harness.mjs';
import { makePagePro } from './pro.mjs';
import { GW_URL } from './ports.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

/// Count POSTs to /api/sync on this page, split by whether they are the presence
/// path (`?presence=1`) or an ordinary content push. A beat must show up only as
/// the former; a content push waking the other device is the latter.
const counter = (page) => {
	const seen = [];
	page.on('request', (r) => {
		try {
			const u = new URL(r.url());
			if (u.pathname === '/api/sync' && r.method() === 'POST') {
				let n = 0;
				try { n = (r.postData() || '').length; } catch (e) { /* unreadable */ }
				seen.push({ presence: u.searchParams.get('presence') === '1', bytes: n });
			}
		} catch (e) { /* not a URL this counts */ }
	});
	return seen;
};

const content  = (seen) => seen.filter((x) => !x.presence);
const presence = (seen) => seen.filter((x) => x.presence);

const quiet  = (pg) => pg.evaluate(() => window.DaimondSync.state().quiet);
const parcel = (pg) => pg.evaluate(async () => JSON.stringify(await window.DaimondSync.parcel()));
const wakes  = (pg) => pg.evaluate(() => window.DaimondSync.wake().wakes);
const devId  = (pg) => pg.evaluate(() => window.DaimondIdentity.deviceId());
const devName = (pg) => pg.evaluate(() =>
	(window.DaimondIdentity.displayName && window.DaimondIdentity.displayName()) || '');

/// Wait until nothing is running and nothing is armed on this page.
const settle = async (pg, ms = 20000) => {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		if (await quiet(pg)) { await pg.waitForTimeout(1500); if (await quiet(pg)) return true; }
		await pg.waitForTimeout(400);
	}
	return false;
};

/// One presence beat from a page, with this device's own id and name — exactly
/// what daimond.js's presenceTick passes.
const beat = (pg) => pg.evaluate(() => {
	const id = window.DaimondIdentity.deviceId();
	const nm = (window.DaimondIdentity.displayName && window.DaimondIdentity.displayName()) || '';
	return window.DaimondSync.beatPresence(id, nm);
});

const a = await open({ name: 'preslead', signIn: true, connect: true, defaults: false });
let b = null;
try {
	await a.page.waitForFunction(
		() => !!window.DaimondSync && !!window.DaimondPresence && window.DaimondGateway
			&& DaimondGateway.state().authed,
		null, { timeout: 15000 }).catch(() => {});
	const pro = await makePagePro(a.page, new URL('../gateway', import.meta.url).pathname, GW_URL);
	check('the account holds Pro, so the presence path is not refused before it is measured',
		pro.pro === true, JSON.stringify(pro));

	await newChat(a);
	await chat(a, 'one turn, so there is a parcel to compare against at all');
	await settle(a.page);
	await a.page.waitForTimeout(2000);

	// ── Pair device b to the SAME account ──────────────────────────────
	// A second real context of one account, exactly as dev/verify_reloadpush.mjs
	// check 6 pairs one: a mints a code, b redeems it, reloads onto the account,
	// signs in and waits for a session. Its per-device id is minted locally and
	// is DISTINCT from a's, which is what makes "the other device" meaningful.
	b = await open({ name: 'presmate', signIn: false, connect: false });
	await b.page.waitForFunction(() => !!window.DaimondPairing, null, { timeout: 15000 }).catch(() => {});
	const code = await a.page.evaluate(() => DaimondPairing.create());
	await b.page.evaluate((c) => DaimondPairing.redeem(c), code.code);
	await b.page.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(b, 'preslead');
	await b.page.waitForFunction(
		() => !!window.DaimondSync && !!window.DaimondPresence && window.DaimondGateway
			&& DaimondGateway.state().authed,
		null, { timeout: 20000 }).catch(() => {});
	await b.page.waitForTimeout(4000);
	await settle(b.page);

	const idA = await devId(a.page);
	const idB = await devId(b.page);
	const nameA = await devName(a.page);
	check('the two paired devices hold DISTINCT per-device ids',
		!!idA && !!idB && idA !== idB, JSON.stringify({ idA, idB }));

	// ── (a) A beat sends no content push and wakes nobody ──────────────
	// The heart of the fix. Watch device a's POSTs while it beats, and device b's
	// wake tally across those beats. A beat must be a presence POST and only that:
	// zero content /api/sync POSTs, and device b's wakes unmoved.
	await settle(a.page);
	await b.page.waitForTimeout(2000);
	const seenA = counter(a.page);
	const wokeBefore = await wakes(b.page);
	for (let i = 0; i < 3; i++) { await beat(a.page); await a.page.waitForTimeout(600); }
	await b.page.waitForTimeout(4000);		// long enough for a wake to have arrived if one was coming
	const wokeAfter = await wakes(b.page);
	check('a presence beat sends NO content sync push (only the presence path)',
		content(seenA).length === 0,
		content(seenA).length + ' content push(es), ' + presence(seenA).length + ' presence beat(s)');
	check('the beats really used the presence path (so the zero above means something)',
		presence(seenA).length >= 1, presence(seenA).length + ' presence POST(s) seen');
	check('a presence beat does NOT wake the account\'s other device',
		wokeAfter === wokeBefore, 'wakes ' + wokeBefore + ' -> ' + wokeAfter);

	// ── (b) Device b sees device a as an awake peer, named ─────────────
	// After a has beaten, b reads the account's presence map (a plain GET, no
	// beat) and must find device a among its awake peers, with the name a beat
	// under. `awake` excludes self, so a — not b — is what should appear.
	await beat(a.page);
	await a.page.waitForTimeout(400);
	await b.page.evaluate(() => window.DaimondSync.refreshPresence());
	const awakeSeenByB = await b.page.evaluate((self) => {
		const list = window.DaimondPresence.awake(self, Date.now()) || [];
		return list.map((x) => ({ deviceId: x.deviceId, name: x.name }));
	}, idB);
	check('device b sees device a as an awake peer after a beats',
		awakeSeenByB.some((x) => x.deviceId === idA), JSON.stringify(awakeSeenByB));
	check('and the awake peer is named as device a beat',
		awakeSeenByB.some((x) => x.deviceId === idA && x.name === nameA),
		JSON.stringify({ want: { deviceId: idA, name: nameA }, got: awakeSeenByB }));
	check('device b does not list ITSELF among its awake peers',
		!awakeSeenByB.some((x) => x.deviceId === idB), JSON.stringify(awakeSeenByB));

	// ── (c) Presence is NOT in the content parcel ──────────────────────
	// The parcel is what a push sends and a pull merges. If presence still rode
	// it, its moving last_seen would move the parcel on every beat; off it, two
	// beats a second apart leave the parcel byte-identical.
	await settle(a.page);
	const parcelBefore = await parcel(a.page);
	await beat(a.page);
	await a.page.waitForTimeout(1000);
	await beat(a.page);
	const parcelAfter = await parcel(a.page);
	check('the content parcel is byte-stable across two beats 1s apart (presence is off it)',
		parcelBefore === parcelAfter,
		parcelBefore === parcelAfter ? '' : 'it moved, so presence is still riding the parcel');
	check('and the parcel carries no presence section at all',
		parcelAfter.indexOf('"presence"') === -1,
		parcelAfter.indexOf('"presence"') === -1 ? '' : 'a "presence" key is in the parcel');

	// ── (d) A device that stops beating ages out of awake ──────────────
	// Simulated honestly on the real freshness logic: ingest an authoritative map
	// (server clock === now, so no skew) holding one device whose last_seen is
	// well past the fresh window and one within it. `awake` must drop the stale
	// one and keep the fresh one — which is exactly what a peer that stopped
	// beating looks like once its last beat ages out.
	const aged = await b.page.evaluate(() => {
		const now = Date.now();
		const FRESH = window.DaimondPresence.FRESH_MS;
		window.DaimondPresence.ingest({
			'stale-dev': { name: 'went-to-sleep', last_seen: now - (FRESH + 60000) },
			'fresh-dev': { name: 'still-awake',   last_seen: now - 1000 },
		}, now);
		const list = (window.DaimondPresence.awake('viewer', now) || []).map((x) => x.deviceId);
		return { hasStale: list.includes('stale-dev'), hasFresh: list.includes('fresh-dev') };
	});
	check('a device whose last beat aged past the fresh window is NOT awake', !aged.hasStale,
		JSON.stringify(aged));
	check('a device still within the fresh window IS awake (the window discriminates)',
		aged.hasFresh, JSON.stringify(aged));
} catch (e) {
	check('the run finished', false, String((e && e.stack) || e));
} finally {
	if (b) await b.close();
	await a.close();
}

console.log('\n' + ok.length + ' ok, ' + bad.length + ' failed');
if (bad.length) { for (const l of bad) console.log('  FAILED: ' + l); }
process.exit(bad.length ? 1 : 0);
