// probe_chatdelete_vouched.mjs — PERMANENT VERIFIER for the chat-deletion strand.
//
// THE BUG (proven here in its RED form before the fix, seq 223): a pull that READ
// the parcel but could not MERGE one of its sections still adopted the version, so
// the client recorded itself caught up to work it never took. The one reachable
// throw in `applyChats` is `!ChatStore.vouched()` -- a store that has not had its
// first read yet, which is the ordinary state of a cold iOS tab woken at a new
// version by a push. So the deletion pull threw in the chats section, the version
// was adopted anyway, the tombstones were never merged, and the chats lived on for
// ever while the chip read "Synced": no higher version ever arrived to trigger a
// wake pull, and the idle/focus pulls are throttled.
//
// THE FIX has three coordinated parts, and this drives all three:
//   (a) sync.js pullOnce does NOT adopt the version when any section failed;
//   (b) a failed apply schedules a re-pull of the SAME version, on a backoff;
//   (c) applyChats awaits the store's FIRST read before it refuses -- a not-yet-read
//       store waits and then merges, while a genuine read failure still refuses.
//
// It forces the chats section to fail with a toggleable flag (a not-yet-vouched
// store, exactly the iOS case), asserts the version is NOT adopted and a re-pull is
// armed, then LIFTS the flag and lets the AUTOMATIC re-pull recover on the SAME
// version -- no newer version minted, no explicit pull. That last part is the whole
// difference from the RED behaviour, where the same version never recovered.

import { open, chat, signInAs, newChat, connectMock, storedChats } from './harness.mjs';
import { makePagePro } from './pro.mjs';
import { GW_URL } from './ports.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const settle = (pg) => pg.waitForFunction(() => {
	try { return window.DaimondSync && window.DaimondSync.state().quiet; } catch (e) { return true; }
}, null, { timeout: 20000 }).catch(() => {});
async function newChatRetry(a) {
	for (let i = 0; i < 3; i++) { try { const id = await newChat(a); if (id) return id; } catch (e) {} await a.page.waitForTimeout(500); }
	return await newChat(a);
}
const loose = (cs) => (cs || []).filter((c) => c && c.id && !c.diamondId);
const ver = (pg) => pg.evaluate(() => { try { return window.DaimondSync.state().version; } catch (e) { return -1; } });
const looseNow = async (s) => loose(await storedChats(s));
// Poll for a predicate over B's loose chats, driven by whatever the app does on its
// own -- no pull is issued here, so a recovery this sees is the re-apply's doing.
async function until(s, pred, ms = 25000, step = 500) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		let cs = []; try { cs = await looseNow(s); } catch (e) {}
		try { if (pred(cs)) return cs; } catch (e) {}
		await s.page.waitForTimeout(step);
	}
	try { return await looseNow(s); } catch (e) { return []; }
}

let a, b;
try {
	a = await open({ name: 'vtester' });
	await a.page.waitForFunction(() => !!window.DaimondSync && window.DaimondGateway && DaimondGateway.state().authed, null, { timeout: 20000 }).catch(() => {});
	await makePagePro(a.page, new URL('../gateway', import.meta.url).pathname, GW_URL);
	await connectMock(a);
	const ids = [];
	for (let i = 0; i < 3; i++) { ids.push(await newChatRetry(a)); await chat(a, 'seed ' + (i + 1)); }
	await settle(a.page);
	await a.page.evaluate(() => window.DaimondSync.push());
	await settle(a.page);

	b = await open({ name: 'vmate', signIn: false, connect: false });
	const bMsgs = [];
	b.page.on('console', (m) => { const ty = m.type(); if (ty === 'error' || ty === 'warning') bMsgs.push(m.text()); });
	await b.page.waitForFunction(() => !!window.DaimondPairing, null, { timeout: 15000 }).catch(() => {});
	const code = await a.page.evaluate(() => DaimondPairing.create());
	await b.page.evaluate((c) => DaimondPairing.redeem(c), code.code);
	await b.page.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(b, 'vtester');
	await b.page.waitForFunction(() => !!window.DaimondSync && window.DaimondGateway && DaimondGateway.state().authed, null, { timeout: 20000 }).catch(() => {});
	await makePagePro(b.page, new URL('../gateway', import.meta.url).pathname, GW_URL);
	await connectMock(b);
	await b.page.evaluate(() => window.DaimondSync.pull());
	await b.page.waitForTimeout(2000);
	await settle(b.page);
	const bPre = loose(await storedChats(b));
	check('B holds 3 chats before delete', bPre.length === 3, 'B: ' + bPre.length);

	// ── Force the chats section to fail from NOW ON, through a toggleable flag, so
	// the deletion pull is the first to hit the throw. `chatStore()` returns the SAME
	// object applyChats calls; overriding `.vouched` to read a flag makes applyChats
	// throw exactly as an unread (WebKit-frozen) store would -- and it is the PUBLIC
	// method, so the fix's `await ChatStore.booted()` (which resolves against the
	// real, already-run boot) still leaves this returning false and the section fails.
	await b.page.evaluate(() => {
		const cs = window.DaimondCore.chatStore();
		if (!cs.__realVouched) cs.__realVouched = cs.vouched;
		window.__forceUnvouched = true;
		cs.vouched = function () { return window.__forceUnvouched ? false : cs.__realVouched.call(cs); };
	});
	const verBefore = await ver(b.page);

	// A: delete-all to trash + empty trash (destroyChat=tombstone), then flush.
	const looseIds = bPre.map((c) => c.id);
	await a.page.evaluate(async (list) => {
		list.forEach((id) => { try { window.DaimondTrash.put(id, 'chat'); } catch (e) {} });
		for (const id of list) { try { await window.DaimondCore.trashPurge(id); } catch (e) {} }
	}, looseIds);
	await settle(a.page);
	const flushRes = await a.page.evaluate(() => window.DaimondSync.flush());
	await settle(a.page);
	check('A committed the deletion parcel', flushRes && flushRes.ok, JSON.stringify(flushRes));

	// ── PHASE A: the deletion pull fails its chats section (store not vouched). ──
	bMsgs.length = 0;
	await b.page.evaluate(() => window.DaimondSync.pull());
	await b.page.waitForTimeout(1500);
	const bAfterFail = loose(await storedChats(b));
	const bTombsFail = await b.page.evaluate(() => { try { return Object.keys(window.DaimondCore.tombs('daimond-chats-deleted') || {}); } catch (e) { return []; } });
	const verAfter = await ver(b.page);
	const chatFail = bMsgs.filter((e) => /section "chats"|not merging against it|chat store has not been read/i.test(e));
	const armed = await b.page.evaluate(() => { try { const s = window.DaimondSync.state(); return !s.quiet || /re-appl/i.test(s.busyWith || ''); } catch (e) { return false; } });

	console.log('\n── PHASE A: the chats section fails on the deletion pull ──');
	check('the chats section reported failure (the throw fired)', chatFail.length > 0,
		'chats-section messages: ' + JSON.stringify(chatFail).slice(0, 200));
	check('FIX (a): the post-delete version was NOT adopted over the failed section',
		verAfter === verBefore, 'version stayed ' + verBefore + ' (flush committed v=' + (flushRes && flushRes.version) + ')');
	check('the chats are still present (correct — the store could not be merged against)',
		bAfterFail.length === 3, 'B loose chats: ' + bAfterFail.length);
	check('the deletion is NOT recorded yet (nothing merged against an unread store)',
		!looseIds.some((id) => bTombsFail.indexOf(id) !== -1), 'B tombs: ' + JSON.stringify(bTombsFail).slice(0, 160));
	check('FIX (b): a re-pull of the same version is armed', armed, 'sync busyWith armed: ' + armed);

	// ── PHASE B: lift the flag and let the AUTOMATIC re-pull recover the SAME
	// version. No newer version is minted and no pull is issued from here -- the RED
	// behaviour was that the same version never recovered. ──
	await b.page.evaluate(() => { window.__forceUnvouched = false; });
	const bRecovered = await until(b, (cs) => cs.length === 0, 25000);
	const bTombsOk = await b.page.evaluate(() => { try { return Object.keys(window.DaimondCore.tombs('daimond-chats-deleted') || {}); } catch (e) { return []; } });
	const verFinal = await ver(b.page);

	console.log('\n── PHASE B: the automatic re-pull recovers on the SAME version ──');
	check('FIX (b)+(c): the deletion landed with no newer version and no manual pull',
		bRecovered.length === 0, 'B loose chats after auto re-apply: ' + bRecovered.length);
	check('the deletion is now recorded (tombs merged)',
		looseIds.every((id) => bTombsOk.indexOf(id) !== -1), 'B tombs: ' + JSON.stringify(bTombsOk).slice(0, 200));
	check('the version is now adopted (caught up only once the merge finished)',
		verFinal > verBefore, 'version ' + verBefore + ' -> ' + verFinal);

	// DATA-SAFETY: a chat that was NOT deleted must not vanish, and a genuinely
	// deleted one must not come back. A creates a fresh chat AFTER the deletion; B
	// must receive it and keep it (no wrongful delete), and the three tombed ids must
	// stay gone (no resurrection).
	const survivorId = await newChatRetry(a);
	await chat(a, 'i must survive');
	await settle(a.page);
	await a.page.evaluate(() => window.DaimondSync.flush());
	await settle(a.page);
	const bLive = await until(b, (cs) => cs.some((c) => c.id === survivorId), 25000);
	check('DATA-SAFETY: a non-tombed chat made after the delete reaches B and lives',
		bLive.some((c) => c.id === survivorId), 'B ids: ' + JSON.stringify(bLive.map((c) => c.id)).slice(0, 160));
	check('DATA-SAFETY: none of the deleted chats resurrected',
		!looseIds.some((id) => bLive.some((c) => c.id === id)), 'B ids: ' + JSON.stringify(bLive.map((c) => c.id)).slice(0, 160));
} catch (e) {
	console.log('PROBE THREW:', e && (e.stack || e.message || e));
	bad.push('probe threw: ' + (e && e.message));
} finally {
	try { await a.close(); } catch (e) {}
	try { await b.close(); } catch (e) {}
	console.log('\n=== SUMMARY ' + ok.length + ' ok, ' + bad.length + ' FAIL ===');
	if (bad.length) process.exitCode = 1;
}
