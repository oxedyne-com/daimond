// verify_trashpurge.mjs — PERMANENT VERIFIER for the empty-trash / purge strand
// (seq 224). A companion to verify/probe_chatdelete_*: delete-to-trash travels as a
// trash-snapshot record and works; EMPTYING the trash (destroyChat -> tombstone +
// DaimondTrash.forget) removes the chat from the chat store on a receiver but left
// the item in the receiver's SEPARATE trash store, cleared only lazily by the next
// trashList()/panel open. On a device woken only to sync in the background -- an iOS
// tab -- the panel never opened, so the purge showed everywhere except there.
//
// The fix reconciles the trash store against the merged tombstones on every receive
// (applySync 'trashclean'), so a receiver clears a purged item from BOTH stores with
// no panel open. This drives the whole thing on a COLD receiver (freshly reloaded,
// non-resident summaries -- the iOS state):
//   RED (pre-fix):  after the purge pull, DaimondTrash.ids() still lists the purged
//                   ids until a panel opens.
//   GREEN (fixed):  the trash store is empty straight after the pull, no panel.
//
// Data-safety, both directions:
//   - a NON-purged trashed chat must SURVIVE on the receiver (stays in the trash,
//     its chat record still present and restorable);
//   - a PURGED chat must not RESURRECT on a later pull.
//
// Engine-agnostic: it drives only the harness `open()` API and page.evaluate, so it
// runs under whatever engine the harness launches (Chromium today, WebKit once the
// harness offers it). The banner names the engine from DAIMOND_BROWSER / BROWSER.

import { open, chat, signInAs, newChat, connectMock, storedChats } from './harness.mjs';
import { makePagePro } from './pro.mjs';
import { GW_URL } from './ports.mjs';

const ENGINE = process.env.DAIMOND_BROWSER || process.env.BROWSER || 'chromium';
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
const looseNow = async (s) => loose(await storedChats(s));
// The two stores, read WITHOUT opening the panel (trashList would lazily clean).
const stores = (pg) => pg.evaluate(() => {
	const tombs    = (() => { try { return Object.keys(window.DaimondCore.tombs('daimond-chats-deleted') || {}); } catch (e) { return []; } })();
	const trashIds = (() => { try { return window.DaimondTrash.ids().map((r) => r.id); } catch (e) { return ['<err>']; } })();
	const stored   = (() => { try { return window.DaimondCore.chatStore().stored().map((c) => c && c.id).filter(Boolean); } catch (e) { return ['<err>']; } })();
	const version  = (() => { try { return window.DaimondSync.state().version; } catch (e) { return -1; } })();
	return { tombs, trashIds, stored, version };
});
async function until(pg, pred, ms = 25000, step = 500) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		let s; try { s = await stores(pg); } catch (e) {}
		try { if (s && pred(s)) return s; } catch (e) {}
		await pg.waitForTimeout(step);
	}
	return await stores(pg);
}

let a, b;
try {
	console.log('trashpurge verifier — engine: ' + ENGINE);
	a = await open({ name: 'tptester' });
	await a.page.waitForFunction(() => !!window.DaimondSync && window.DaimondGateway && DaimondGateway.state().authed, null, { timeout: 20000 }).catch(() => {});
	await makePagePro(a.page, new URL('../gateway', import.meta.url).pathname, GW_URL);
	await connectMock(a);
	const ids = [];
	for (let i = 0; i < 3; i++) { ids.push(await newChatRetry(a)); await chat(a, 'seed ' + (i + 1)); }
	await settle(a.page);
	await a.page.evaluate(() => window.DaimondSync.push());
	await settle(a.page);

	b = await open({ name: 'tpmate', signIn: false, connect: false });
	await b.page.waitForFunction(() => !!window.DaimondPairing, null, { timeout: 15000 }).catch(() => {});
	const code = await a.page.evaluate(() => DaimondPairing.create());
	await b.page.evaluate((c) => DaimondPairing.redeem(c), code.code);
	await b.page.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(b, 'tptester');
	await b.page.waitForFunction(() => !!window.DaimondSync && window.DaimondGateway && DaimondGateway.state().authed, null, { timeout: 20000 }).catch(() => {});
	await makePagePro(b.page, new URL('../gateway', import.meta.url).pathname, GW_URL);
	await connectMock(b);
	await b.page.evaluate(() => window.DaimondSync.pull());
	await b.page.waitForTimeout(2000);
	await settle(b.page);
	const bPre = await looseNow(b);
	check('B holds 3 chats before delete', bPre.length === 3, 'B: ' + bPre.length);
	const looseIds = bPre.map((c) => c.id);
	// Purge two, keep one trashed (the data-safety survivor).
	const purge = [looseIds[0], looseIds[1]];
	const survivor = looseIds[2];

	// ── PHASE 1: A trashes ALL three; B pulls -> all three in B's trash. ──
	await a.page.evaluate((list) => {
		list.forEach((id) => { try { window.DaimondTrash.put(id, 'chat'); } catch (e) {} });
		try { window.DaimondSync.push(); } catch (e) {}
	}, looseIds);
	await settle(a.page);
	await b.page.evaluate(() => window.DaimondSync.pull());
	await b.page.waitForTimeout(1500);
	await settle(b.page);
	const b1 = await stores(b.page);
	check('B received all three into the trash store', looseIds.every((id) => b1.trashIds.indexOf(id) !== -1),
		'B trashIds: ' + JSON.stringify(b1.trashIds));

	// ── B FRESHLY RELOADED → cold, non-resident summaries: the iOS state. ──
	await b.page.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(b, 'tptester');
	await b.page.waitForFunction(() => !!window.DaimondSync && window.DaimondGateway && DaimondGateway.state().authed, null, { timeout: 20000 }).catch(() => {});
	await connectMock(b);
	await b.page.waitForTimeout(500);

	// ── PHASE 2: A permanently deletes TWO (purge), leaves the third trashed. ──
	await a.page.evaluate(async (list) => {
		for (const id of list) { try { await window.DaimondCore.trashPurge(id); } catch (e) {} }
	}, purge);
	await settle(a.page);
	const flushRes = await a.page.evaluate(() => window.DaimondSync.flush());
	await settle(a.page);
	check('A committed the purge parcel', flushRes && flushRes.ok, JSON.stringify(flushRes));

	// ── B pulls the purge parcel (cold), and we read the stores with NO panel open. ──
	await b.page.evaluate(() => window.DaimondSync.pull());
	const bAfter = await until(b.page, (s) => purge.every((id) => s.tombs.indexOf(id) !== -1)
		&& purge.every((id) => s.trashIds.indexOf(id) === -1), 25000);

	console.log('\n── RESULT: B after the purge pull (cold, iOS-like), no panel opened ──');
	check('FIX: the tombstones merged on B', purge.every((id) => bAfter.tombs.indexOf(id) !== -1),
		'B tombs: ' + JSON.stringify(bAfter.tombs));
	check('FIX: the purged ids left the TRASH STORE with no panel open',
		purge.every((id) => bAfter.trashIds.indexOf(id) === -1), 'B trashIds: ' + JSON.stringify(bAfter.trashIds));
	check('FIX: the purged ids left the chat store', purge.every((id) => bAfter.stored.indexOf(id) === -1),
		'B stored: ' + JSON.stringify(bAfter.stored));

	console.log('\n── DATA-SAFETY ──');
	check('a NON-purged trashed chat SURVIVES in B\'s trash store', bAfter.trashIds.indexOf(survivor) !== -1,
		'survivor=' + survivor + ' trashIds=' + JSON.stringify(bAfter.trashIds));
	check('the survivor\'s chat record is still present (restorable)', bAfter.stored.indexOf(survivor) !== -1,
		'B stored: ' + JSON.stringify(bAfter.stored));
	check('the survivor was NOT tombstoned', bAfter.tombs.indexOf(survivor) === -1,
		'B tombs: ' + JSON.stringify(bAfter.tombs));

	// ── PHASE 3: a purged chat must not resurrect on a later pull. ──
	await b.page.evaluate(() => window.DaimondSync.pull());
	await b.page.waitForTimeout(2000);
	await settle(b.page);
	const b3 = await stores(b.page);
	check('a purged chat does NOT resurrect on a later pull (trash store)',
		purge.every((id) => b3.trashIds.indexOf(id) === -1), 'B trashIds: ' + JSON.stringify(b3.trashIds));
	check('a purged chat does NOT resurrect on a later pull (chat store)',
		purge.every((id) => b3.stored.indexOf(id) === -1), 'B stored: ' + JSON.stringify(b3.stored));
	check('the survivor still survives after the later pull', b3.trashIds.indexOf(survivor) !== -1,
		'B trashIds: ' + JSON.stringify(b3.trashIds));
} catch (e) {
	console.log('VERIFIER THREW:', e && (e.stack || e.message || e));
	bad.push('verifier threw: ' + (e && e.message));
} finally {
	try { await a.close(); } catch (e) {}
	try { await b.close(); } catch (e) {}
	console.log('\n=== SUMMARY (' + ENGINE + ') ' + ok.length + ' ok, ' + bad.length + ' FAIL ===');
	if (bad.length) process.exitCode = 1;
}
