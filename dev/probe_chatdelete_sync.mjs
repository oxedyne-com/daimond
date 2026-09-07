// probe_chatdelete_sync.mjs — DIAGNOSTIC (not a fix, not a permanent verifier).
// Reproduce the LIVE bug: chat-level DELETIONS not applied on a second device.
// A (dispatcher) seeds chats, B pairs. A deletes-all (to trash) then empties trash
// (trashPurge = destroyChat = tombstone). B is FRESHLY RELOADED before the purge so
// its chats are NON-RESIDENT summaries — the exact state of the owner's iOS.
// Question: after B pulls the post-purge parcel, are the chats gone on B, or do they
// persist/resurrect? Also captures (a) vs (b): does A's parcel CONTAIN the tombs.

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
const devId = (pg) => pg.evaluate(() => window.DaimondIdentity.deviceId());

async function newChatRetry(a) {
	for (let i = 0; i < 3; i++) {
		try { const id = await newChat(a); if (id) return id; } catch (e) {}
		await a.page.waitForTimeout(500);
	}
	return await newChat(a);
}
async function untilChats(s, pred, ms = 30000, step = 500) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		let cs = []; try { cs = await storedChats(s); } catch (e) {}
		try { if (pred(cs)) return cs; } catch (e) {}
		await s.page.waitForTimeout(step);
	}
	try { return await storedChats(s); } catch (e) { return []; }
}
const loose = (cs) => (cs || []).filter((c) => c && c.id && !c.diamondId);

let a, b;
try {
	a = await open({ name: 'deltester' });
	await a.page.waitForFunction(() => !!window.DaimondSync && window.DaimondGateway
		&& DaimondGateway.state().authed, null, { timeout: 20000 }).catch(() => {});
	await makePagePro(a.page, new URL('../gateway', import.meta.url).pathname, GW_URL);
	await connectMock(a);
	// Seed three ordinary chats, each with a turn.
	const ids = [];
	for (let i = 0; i < 3; i++) {
		const id = await newChatRetry(a);
		ids.push(id);
		await chat(a, 'seed chat ' + (i + 1));
	}
	await settle(a.page);
	await a.page.evaluate(() => window.DaimondSync.push());
	await settle(a.page);
	const aChats = loose(await storedChats(a));
	check('A has 3 ordinary chats seeded', aChats.length === 3, 'A loose chats: ' + aChats.length);

	// ── B pairs to the same account ──
	b = await open({ name: 'delmate', signIn: false, connect: false });
	const bErrs = [];
	b.page.on('console', (m) => { if (m.type() === 'error') bErrs.push(m.text()); });
	await b.page.waitForFunction(() => !!window.DaimondPairing, null, { timeout: 15000 }).catch(() => {});
	const code = await a.page.evaluate(() => DaimondPairing.create());
	await b.page.evaluate((c) => DaimondPairing.redeem(c), code.code);
	await b.page.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(b, 'deltester');
	await b.page.waitForFunction(() => !!window.DaimondSync && window.DaimondGateway
		&& DaimondGateway.state().authed, null, { timeout: 20000 }).catch(() => {});
	await makePagePro(b.page, new URL('../gateway', import.meta.url).pathname, GW_URL);
	await connectMock(b);
	await settle(b.page);
	await b.page.evaluate(() => window.DaimondSync.pull());
	const bGot = await untilChats(b, (cs) => loose(cs).length === 3, 30000);
	check('B received all 3 chats before any delete', loose(bGot).length === 3, 'B loose chats: ' + loose(bGot).length);

	const idA = await devId(a.page), idB = await devId(b.page);
	check('A and B are distinct paired devices of one account', idA && idB && idA !== idB, JSON.stringify({ idA, idB }));

	// ── B FRESHLY RELOADED → chats non-resident (summaries only), exactly like iOS. ──
	await b.page.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(b, 'deltester');
	await b.page.waitForFunction(() => !!window.DaimondSync && window.DaimondGateway
		&& DaimondGateway.state().authed, null, { timeout: 20000 }).catch(() => {});
	await connectMock(b);
	await settle(b.page);
	const bResidencyPre = await b.page.evaluate(() => {
		try { return window.DaimondCore.chatResidency(); } catch (e) { return []; }
	});
	check('B still holds 3 chats after reload (pre-delete)',
		bResidencyPre.filter((c) => c.msgCount >= 0).length >= 3,
		'B residency: ' + JSON.stringify(bResidencyPre.map((c) => ({ loaded: c.loaded, n: c.msgCount }))));

	// ═══ PHASE 1: A deletes all to TRASH (removeChat = DaimondTrash.put), then syncs ═══
	bErrs.length = 0;
	const looseIds = loose(await storedChats(a)).map((c) => c.id);
	await a.page.evaluate((list) => {
		list.forEach((id) => { try { window.DaimondTrash.put(id, 'chat'); } catch (e) {} });
		// removeChat also persists+pushes; nudge the engine like persistChats would.
		try { window.DaimondSync.push(); } catch (e) {}
	}, looseIds);
	await settle(a.page);
	const parcelTrash = await a.page.evaluate(() => window.DaimondSync.parcel());
	check('PHASE1 A parcel: trash snapshot lists the trashed chats',
		parcelTrash && parcelTrash.trash && parcelTrash.trash.items
			&& looseIds.every((id) => parcelTrash.trash.items[id]),
		'trash items: ' + JSON.stringify(Object.keys((parcelTrash.trash || {}).items || {})).slice(0, 200));
	check('PHASE1 A parcel: chats section STILL carries the chats (trashed, not yet tombed)',
		parcelTrash && Array.isArray(parcelTrash.chats)
			&& looseIds.every((id) => parcelTrash.chats.some((c) => c.id === id)),
		'parcel chat ids: ' + JSON.stringify((parcelTrash.chats || []).map((c) => c.id)).slice(0, 200));

	await b.page.evaluate(() => window.DaimondSync.pull());
	await b.page.waitForTimeout(1500);
	const bTrashList1 = await b.page.evaluate(async () => {
		try { return (await window.DaimondCore.trashList()).length; } catch (e) { return -1; }
	});
	const bStoreAfterTrash = loose(await storedChats(b));
	check('PHASE1 B adopted the trash (chats now in B trash panel)', bTrashList1 >= 3, 'B trash items: ' + bTrashList1);

	// ═══ PHASE 2: A empties trash (trashPurge = destroyChat = tombstone), then syncs ═══
	bErrs.length = 0;
	await a.page.evaluate(async (list) => {
		for (const id of list) { try { await window.DaimondCore.trashPurge(id); } catch (e) {} }
	}, looseIds);
	await settle(a.page);
	const flushRes = await a.page.evaluate(() => window.DaimondSync.flush());
	await settle(a.page);
	const parcelPurge = await a.page.evaluate(() => window.DaimondSync.parcel());
	const parcelTombs = Object.keys((parcelPurge && parcelPurge.tombs) || {});
	check('PHASE2 A parcel: tombs CONTAIN every deleted chat id (the deletion travels)',
		looseIds.every((id) => parcelTombs.indexOf(id) !== -1),
		'parcel tombs: ' + JSON.stringify(parcelTombs).slice(0, 200));
	check('PHASE2 A parcel: chats section NO LONGER carries the deleted chats',
		Array.isArray(parcelPurge.chats) && !looseIds.some((id) => parcelPurge.chats.some((c) => c.id === id)),
		'parcel chat ids: ' + JSON.stringify((parcelPurge.chats || []).map((c) => c.id)).slice(0, 200));
	const aGone = loose(await storedChats(a));
	check('PHASE2 A store: the chats are gone locally (control — delete works on A)',
		aGone.length === 0, 'A loose chats remaining: ' + aGone.length);

	// B pulls the post-purge parcel (real gateway round-trip).
	await b.page.evaluate(() => window.DaimondSync.pull());
	const bFinal = await untilChats(b, (cs) => loose(cs).length === 0, 30000);
	const bFinalLoose = loose(bFinal);
	const bResidencyPost = await b.page.evaluate(() => {
		try { return window.DaimondCore.chatResidency(); } catch (e) { return []; }
	});
	const bTombs = await b.page.evaluate(() => { try { return Object.keys(window.DaimondCore.tombs('daimond-chats-deleted') || {}); } catch (e) { return []; } });
	const bTrashList2 = await b.page.evaluate(async () => {
		try { return (await window.DaimondCore.trashList()).length; } catch (e) { return -1; }
	});
	const chatSectionFailed = bErrs.filter((e) => /section "chats"|chat store has not been read|not merging against it/i.test(e));

	console.log('\n── RESULT ──');
	check('THE BUG REPRO: B store no longer contains the deleted chats',
		bFinalLoose.length === 0, 'B loose chats STILL PRESENT: ' + bFinalLoose.length
			+ ' ids=' + JSON.stringify(bFinalLoose.map((c) => c.id)).slice(0, 160));
	check('B tombstone map received the deleted ids',
		looseIds.every((id) => bTombs.indexOf(id) !== -1), 'B tombs: ' + JSON.stringify(bTombs).slice(0, 200));
	check('B residency shows the chats dropped from the rail',
		loose(bResidencyPost).length === 0, 'B residency post: ' + JSON.stringify(bResidencyPost).slice(0, 200));
	check('B trash panel is empty (matches owner: trash emptied)', bTrashList2 === 0, 'B trash items: ' + bTrashList2);
	check('B chats section did NOT fail to apply', chatSectionFailed.length === 0,
		'chats-section errors: ' + JSON.stringify(chatSectionFailed).slice(0, 300));
	console.log('flush result:', JSON.stringify(flushRes));
} catch (e) {
	console.log('PROBE THREW:', e && (e.stack || e.message || e));
	bad.push('probe threw: ' + (e && e.message));
} finally {
	try { await a.close(); } catch (e) {}
	try { await b.close(); } catch (e) {}
	console.log('\n=== SUMMARY ' + ok.length + ' ok, ' + bad.length + ' FAIL ===');
	if (bad.length) { bad.forEach((x) => console.log('  FAIL ' + x)); process.exitCode = 1; }
}
