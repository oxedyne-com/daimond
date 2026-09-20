// verify_chatdelete_sync.mjs — S-SYNC #6, the two-device delete-sync gate.
//
// Promoted from probe_chatdelete_sync.mjs. It proves a DELETION does not
// resurrect -- from disk on this device, or from the peer on the next pull --
// and, in the QUOTA ARM, that it survives a FULL localStorage, which is the bug:
// tombstone writers swallowed the quota throw, so under pressure a delete left
// the rail but no tombstone persisted, and the row came back.
//
// A (dispatcher) seeds chats; B pairs and is FRESHLY RELOADED before the deletes
// so its chats are NON-RESIDENT summaries -- the owner's iOS state.
//
//   Phase 1: A trashes all (removeChat), syncs; B adopts the trash.
//   Phase 2: A empties trash (trashPurge = destroyChat = tombstone), syncs;
//            B's chats must be GONE and stay gone across a reload.
//   Phase 3: QUOTA ARM. A's localStorage is filled to the quota, then A destroys
//            a chat; it must go on A, travel, and go on B; B survives a reload
//            without rebuilding it. Then A's pad is freed and a further clean
//            delete raises NO storage alarm.
//
// The Diamond-tombstone path uses the identical mechanism (putTombs / tombMapNow
// / mergeTombMap over DIAMOND_TOMBS_KEY); the node test and the source guards in
// www/js/tombdurable.test.mjs cover destroyDiamond and applyDiamonds, and a UI
// diamond-create is not needed here to exercise the durability seam.
//
// This is the arm-B gate: run it in an isolated worktree with a gateway. Against
// pre-fix code it reddens (the swallow resurrects); against the fix it greens.
// The pure durability logic + a fail-first --break live in www/js/tombdurable.test.mjs.

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

// Capture the durable trail so the deletion lines can be asserted to name ids.
async function armTrail(pg) {
	await pg.evaluate(() => {
		window.__trail = [];
		if (window.DaimondTrail && DaimondTrail.note && !DaimondTrail.__wrapped) {
			const real = DaimondTrail.note.bind(DaimondTrail);
			DaimondTrail.note = function (w, d) {
				try { window.__trail.push(w + ' | ' + d); } catch (e) {}
				return real(w, d);
			};
			DaimondTrail.__wrapped = true;
		}
	});
}
const trailLines = (pg) => pg.evaluate(() => (window.__trail || []).slice());

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
	await armTrail(a.page);

	// Seed three ordinary chats.
	const ids = [];
	for (let i = 0; i < 3; i++) { ids.push(await newChatRetry(a)); await chat(a, 'seed chat ' + (i + 1)); }
	await settle(a.page);
	await a.page.evaluate(() => window.DaimondSync.push());
	await settle(a.page);
	check('A seeded 3 ordinary chats', loose(await storedChats(a)).length === 3);

	// ── B pairs to the same account ──
	b = await open({ name: 'delmate', signIn: false, connect: false });
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
	check('B received all 3 chats before any delete', loose(bGot).length === 3, 'B loose: ' + loose(bGot).length);

	const idA = await devId(a.page), idB = await devId(b.page);
	check('A and B are distinct paired devices of one account', idA && idB && idA !== idB);

	// B freshly reloaded → chats non-resident (summaries), exactly like iOS.
	await b.page.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(b, 'deltester');
	await b.page.waitForFunction(() => !!window.DaimondSync && window.DaimondGateway
		&& DaimondGateway.state().authed, null, { timeout: 20000 }).catch(() => {});
	await connectMock(b);
	await armTrail(b.page);
	await settle(b.page);

	// ═══ PHASE 1: A trashes all, syncs; B adopts the trash ═══
	const looseIds = loose(await storedChats(a)).map((c) => c.id);
	await a.page.evaluate((list) => {
		list.forEach((id) => { try { window.DaimondTrash.put(id, 'chat'); } catch (e) {} });
		try { window.DaimondSync.push(); } catch (e) {}
	}, looseIds);
	await settle(a.page);
	await b.page.evaluate(() => window.DaimondSync.pull());
	await b.page.waitForTimeout(1500);
	const bTrash1 = await b.page.evaluate(async () => { try { return (await window.DaimondCore.trashList()).length; } catch (e) { return -1; } });
	check('PHASE1 B adopted the trash', bTrash1 >= 3, 'B trash items: ' + bTrash1);

	// ═══ PHASE 2: A empties trash (destroyChat = tombstone), syncs ═══
	await a.page.evaluate(async (list) => { for (const id of list) { try { await window.DaimondCore.trashPurge(id); } catch (e) {} } }, looseIds);
	await settle(a.page);
	await a.page.evaluate(() => window.DaimondSync.flush());
	await settle(a.page);
	// `DaimondSync.parcel()` is `collectParcel()`, which is ASYNC (it awaits
	// `DaimondCore.collectSync()`); reading `.tombs` off the un-awaited Promise gave
	// `{}` every time, so this read empty whatever the tombs were. The tombs it
	// carries are `loadTombs()` = `tombMapNow(TOMBS_KEY)` = the localStorage cache
	// unioned with the session's `tombMem` overlay -- which a flush neither clears
	// nor ages (only TTL does) -- so awaiting the parcel reads them.
	const parcelTombs = await a.page.evaluate(async () => Object.keys(((await window.DaimondSync.parcel()) || {}).tombs || {}));
	check('PHASE2 A parcel carries every deleted chat id', looseIds.every((id) => parcelTombs.indexOf(id) !== -1),
		'parcel tombs: ' + JSON.stringify(parcelTombs).slice(0, 200));
	check('PHASE2 A store: chats gone locally (control)', loose(await storedChats(a)).length === 0);

	await b.page.evaluate(() => window.DaimondSync.pull());
	const bFinal = await untilChats(b, (cs) => loose(cs).length === 0, 30000);
	check('PHASE2 B store: the deleted chats are gone', loose(bFinal).length === 0,
		'B loose still present: ' + JSON.stringify(loose(bFinal).map((c) => c.id)).slice(0, 160));
	await b.page.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(b, 'deltester');
	await connectMock(b);
	await settle(b.page);
	check('PHASE2 B: still gone after a reload (durable tombstone, no rebuild)',
		loose(await untilChats(b, (cs) => true, 5000)).length === 0);
	const bTombs = await b.page.evaluate(() => { try { return Object.keys(window.DaimondCore.tombs('daimond-chats-deleted') || {}); } catch (e) { return []; } });
	check('PHASE2 B tombstone map received the deleted ids', looseIds.every((id) => bTombs.indexOf(id) !== -1),
		'B tombs: ' + JSON.stringify(bTombs).slice(0, 200));
	{
		// A's OWN DURABLE RECORD of the deletion names every id. The old assertion
		// looked in `DaimondTrail` for an "apply/removed" line, but the deletion is
		// NOT recorded there: `destroyChat` and the apply-side removal both name the id
		// through `diag`/`DaimondDiag` (`'chat destroy <id> for good'`, `'apply chat
		// removed <id> by tombstone'`), and the only `DaimondTrail` line on the chat
		// path (`'sync chats SHORTER'`) fires on a SHORTENED merge, never a full
		// tombstone removal -- and only on the receiver, whereas this reads device A,
		// the deleter, which runs no apply at all. So the durable record to assert is
		// the tomb overlay itself (`DaimondCore.tombs`), the subject of S-SYNC #6.
		const aTombs = await a.page.evaluate(() => { try { return Object.keys(window.DaimondCore.tombs('daimond-chats-deleted') || {}); } catch (e) { return []; } });
		check('A durably recorded every deleted chat id in its tomb overlay',
			looseIds.every((id) => aTombs.indexOf(id) !== -1),
			'A tombs: ' + JSON.stringify(aTombs).slice(0, 200));
	}

	// ═══ PHASE 3: QUOTA ARM — a delete under a FULL localStorage still travels ═══
	const q1 = await newChatRetry(a); await chat(a, 'quota chat'); await settle(a.page);
	await a.page.evaluate(() => window.DaimondSync.push()); await settle(a.page);
	await b.page.evaluate(() => window.DaimondSync.pull());
	await untilChats(b, (cs) => loose(cs).some((c) => c.id === q1), 20000);

	const filled = await a.page.evaluate(() => {
		const CHUNK = 64 * 1024, pad = 'x'.repeat(CHUNK); let n = 0, err = '';
		try { for (; n < 400; n++) localStorage.setItem('__fill_' + n, pad); } catch (e) { err = e.name || String(e); }
		// Free the tiniest slice so the sync engine's cursor writes limp on; NOT
		// enough for the tomb map, which must reach IndexedDB to survive.
		try { localStorage.removeItem('__fill_' + (n - 1)); } catch (e) {}
		try { localStorage.setItem('__probe', 'x'.repeat(CHUNK)); localStorage.removeItem('__probe'); } catch (e) { err = err || (e.name || String(e)); }
		return { chunks: n, err };
	});
	check('QUOTA A localStorage is full', filled.err === 'QuotaExceededError', 'after ' + filled.chunks + ' chunks: ' + filled.err);

	await a.page.evaluate(async (q) => {
		try { await window.DaimondCore.trashPurge(q); } catch (e) {}   // destroyChat under quota
		try { window.DaimondSync.push(); } catch (e) {}
	}, q1);
	await settle(a.page);
	await a.page.evaluate(() => { try { return window.DaimondSync.flush(); } catch (e) {} });
	await settle(a.page);
	check('QUOTA A: the chat is gone locally despite the full localStorage',
		!loose(await storedChats(a)).some((c) => c.id === q1));

	await b.page.evaluate(() => window.DaimondSync.pull());
	const bAfterQuota = await untilChats(b, (cs) => !loose(cs).some((c) => c.id === q1), 30000);
	check('QUOTA B: the quota-deleted chat is gone', !loose(bAfterQuota).some((c) => c.id === q1),
		'B still has ' + q1 + '? ' + loose(bAfterQuota).some((c) => c.id === q1));

	// Reload B: a tombstone that only lived in localStorage on A would never have
	// travelled, so B would rebuild here. It must not.
	await b.page.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(b, 'deltester');
	await connectMock(b);
	await settle(b.page);
	check('QUOTA B: still gone after a reload (the tomb travelled via IDB, not lost to quota)',
		!loose(await untilChats(b, (cs) => true, 5000)).some((c) => c.id === q1));

	// Free A's pad; a further clean delete must raise NO alarm.
	await a.page.evaluate(() => { for (let i = 0; i < 400; i++) { try { localStorage.removeItem('__fill_' + i); } catch (e) {} } });
	const q2 = await newChatRetry(a); await chat(a, 'post-quota chat'); await settle(a.page);
	await a.page.evaluate(async (id) => { try { await window.DaimondCore.trashPurge(id); } catch (e) {} }, q2);
	await settle(a.page);
	const alarmUp = await a.page.evaluate(() => !!document.querySelector('.storage-alarm'));
	check('QUOTA A: with room freed, a clean delete raises no storage alarm', alarmUp === false);

} catch (e) {
	console.log('VERIFY THREW:', e && (e.stack || e.message || e));
	bad.push('verify threw: ' + (e && e.message));
} finally {
	try { await a.close(); } catch (e) {}
	try { await b.close(); } catch (e) {}
	console.log('\n=== SUMMARY ' + ok.length + ' ok, ' + bad.length + ' FAIL ===');
	if (bad.length) { bad.forEach((x) => console.log('  FAIL ' + x)); process.exitCode = 1; }
}
