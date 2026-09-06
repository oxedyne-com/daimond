// Verify the transcript-storage rework STAGE 0 (seq 212): the append-only chunk
// shadow, additive and behaviour-inert.
//
// Stage 0 adds two IndexedDB stores beside `chats` -- `msgchunks` (a transcript as
// append-only batches keyed `chatId#seq`) and `chatsum` (one small versioned summary
// per chat) -- and writes them as a SHADOW on boot. `chats` stays the sole source of
// truth; nothing here is on any behaviour path yet. This probe proves the shadow is
// correct and the schema bump is non-destructive, without which the later stages have
// no safe ground to stand on.
//
// Six proofs, all on the real page, all headless:
//   1  UPGRADE. A database created at the OLD version (1, chats only) is opened by the
//      app at version 2: the version rises, both new stores appear, and EVERY existing
//      chat row survives byte-identical (the schema bump touched nothing).
//   2  RECONSTRUCTION IS BYTE-EXACT. Each shadowed transcript rebuilds from its chunks
//      to exactly the legacy transcript -- mid, content, role and order -- and a
//      tombstoned message is correctly dropped (blocker B2, via `mergeMessages`).
//   3  SUMMARY. The summary row carries v, the rail scalars, the counts, the session
//      marker, and the dispatched-placeholder iturns (blocker B3); a long transcript
//      spans several chunks.
//   4  DEDUP + SORT. Given a mid that appears twice across chunks (one elided, one
//      full) and out of ts order, reconstruction keeps the FULLER copy and sorts by
//      (ts, mid) -- the same rule every merge in the app uses.
//   5  IDEMPOTENT. A second boot re-runs the shadow pass and neither duplicates nor
//      corrupts a chunk: the row counts are unchanged and reconstruction still exact.
//   6  INERT. The legacy `chats` rows are untouched across both boots, and the rail
//      shows the ordinary chats -- they still load from the legacy rows.
import { open, shot, scratch, errors, signInAs } from './harness.mjs';
import fs from 'node:fs';

const PROFILE = scratch('pw', 'msgchunks-shadow');
fs.rmSync(PROFILE, { recursive: true, force: true });

const big = (tag, n) => (tag + ' ').repeat(n);   // a long, self-identifying body

// A chat row in the legacy one-row shape.
function chat(id, name, messages, extra) {
	return Object.assign({
		id, name, model: 'mock/fast', provider: 'mock', status: 'active',
		promptTokens: 3, completionTokens: 4, cachedTokens: 0, costUsd: 0.01,
		prevPrompt: 1, prevCompletion: 2, prevCached: 0, prevCost: 0, lastPrompt: 1,
		diamondId: '', workerModel: '', workerProvider: '',
		holds: [{ path: 'notes/', kind: 'folder' }], foldedInto: null, session: null,
		updatedAt: 1_700_000_000_000 + id.length, messages,
	}, extra || {});
}

// ── the seeded corpus ─────────────────────────────────────────────────────────
// Canonical order (strictly increasing ts, unique mids), so reconstruction's sort is
// the identity and equality is a fair byte-exact test.
const chatA = chat('cA', 'Alpha chat', [
	{ role: 'user',      mid: 'a0', ts: 1, content: 'First question, kept whole.' },
	{ role: 'assistant', mid: 'a1', ts: 2, content: 'First answer with a long tail. ' + big('body', 400) },
	{ role: 'user',      mid: 'a2', ts: 3, content: 'Second question.' },
	{ role: 'assistant', mid: 'a3', ts: 4, content: 'Second answer, verbatim.' },
]);
const chatB = chat('cB', 'Bravo chat', [
	{ role: 'user',      mid: 'b0', ts: 1, content: 'A question before a retracted turn.' },
	{ role: 'assistant', mid: 'tomb1', ts: 2, content: 'A continued interrupted turn, later tombstoned.' },
	{ role: 'user',      mid: 'b2', ts: 3, content: 'The question that stayed.' },
	{ role: 'assistant', mid: 'b3', ts: 4, content: 'The answer that stayed.' },
]);
const chatC = chat('cC', 'Charlie chat', [
	{ role: 'user',      mid: 'c0', ts: 1, content: 'A question.' },
	{ role: 'think_log', mid: 'c1', ts: 2, content: 'HEADT ' + big('mid', 20) + ' TAILT', elided: 4321 },
	{ role: 'assistant', mid: 'c2', ts: 3, content: 'An answer.' },
]);
// Long enough to span several chunks (CHUNK_MSGS = 128).
const longMsgs = [];
for (let i = 0; i < 300; i++) {
	longMsgs.push({ role: i % 2 ? 'assistant' : 'user', mid: 'd' + ('000' + i).slice(-3), ts: i + 1,
		content: (i % 2 ? 'Answer ' : 'Question ') + i });
}
const chatD = chat('cD', 'Delta chat', longMsgs);
// Ordinary chat carrying a model session and a dispatched placeholder.
const chatE = chat('cE', 'Echo chat', [
	{ role: 'user',       mid: 'e0', ts: 1, content: 'Run this on my other device.' },
	{ role: 'assistant',  mid: 'e1', ts: 2, why: 'dispatched', iturn: 'T9', content: '' },
	{ role: 'assistant',  mid: 'e2', ts: 3, iturn: 'T9', content: 'The dispatched answer that merged.' },
], { session: { msgs: [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }, { role: 'tool', content: 'z' }] } });
// A daimon's conversation, off the rail, to prove diamondId rides in the summary.
const chatF = chat('cF', 'Foxtrot daimon', [
	{ role: 'user',      mid: 'f0', ts: 1, content: 'A daimon turn.' },
	{ role: 'assistant', mid: 'f1', ts: 2, content: 'A daimon reply.' },
], { diamondId: 'dia1' });

const SEEDS = [chatA, chatB, chatC, chatD, chatE, chatF];

// The app URL this world serves, and a same-origin page that does NOT boot the app
// (an unknown path 404s as text/plain on the app's own origin). The app opens the
// chat store at version 2 the moment it loads, so a genuine OLD-version database has
// to be laid down from a page where daimond.js is not running to hold a connection.
const APP = process.env.DAIMOND_APP || ('http://localhost:' + (process.env.DAIMOND_PORT || 8777));

// ── page-side helpers (version-agnostic opens, so they survive the bump) ────────

// Lay down a genuine version-1 database (chats only) holding `rows`, replacing
// whatever the app created. Run from the same-origin blank page, so no app
// connection blocks the delete. This is the OLD-version store the app then upgrades.
const seedV1 = (page, rows) => page.evaluate((rows) => new Promise((res, rej) => {
	const del = indexedDB.deleteDatabase('daimond-chats');
	const create = () => {
		const req = indexedDB.open('daimond-chats', 1);
		req.onupgradeneeded = () => {
			const d = req.result;
			if (!d.objectStoreNames.contains('chats')) d.createObjectStore('chats', { keyPath: 'id' });
		};
		req.onsuccess = () => {
			const db = req.result, t = db.transaction('chats', 'readwrite');
			rows.forEach((r) => t.objectStore('chats').put(r));
			t.oncomplete = () => { db.close(); res(); };   // close, so the v1 handle cannot block the upgrade
			t.onerror = () => rej(t.error);
		};
		req.onerror = () => rej(req.error);
	};
	del.onsuccess = create;
	del.onerror   = create;    // never existed: create anyway
	del.onblocked = () => { /* the delete still completes once the last handle drops */ };
}), rows);

const dbInfo = (page) => page.evaluate(() => new Promise((res) => {
	const req = indexedDB.open('daimond-chats');
	req.onsuccess = () => { const db = req.result; const info = { version: db.version, stores: [...db.objectStoreNames] }; db.close(); res(info); };
	req.onerror = () => res(null);
}));

const allChats = (page) => page.evaluate(() => new Promise((res) => {
	const req = indexedDB.open('daimond-chats');
	req.onsuccess = () => {
		const db = req.result; let t;
		try { t = db.transaction('chats', 'readonly'); } catch (e) { res([]); return; }
		const g = t.objectStore('chats').getAll();
		g.onsuccess = () => res(g.result || []); g.onerror = () => res([]);
	};
	req.onerror = () => res([]);
}));

const storeCount = (page, store) => page.evaluate((store) => new Promise((res) => {
	const req = indexedDB.open('daimond-chats');
	req.onsuccess = () => {
		const db = req.result; let t;
		try { t = db.transaction(store, 'readonly'); } catch (e) { res(-1); return; }
		const c = t.objectStore(store).count();
		c.onsuccess = () => res(c.result); c.onerror = () => res(-1);
	};
	req.onerror = () => res(-1);
}), store);

const putChunks = (page, rows) => page.evaluate((rows) => new Promise((res, rej) => {
	const req = indexedDB.open('daimond-chats');
	req.onsuccess = () => {
		const db = req.result; let t;
		try { t = db.transaction('msgchunks', 'readwrite'); } catch (e) { rej(e); return; }
		rows.forEach((r) => t.objectStore('msgchunks').put(r));
		t.oncomplete = () => res(); t.onerror = () => rej(t.error);
	};
	req.onerror = () => rej(req.error);
}), rows);

const setTomb = (page, mid) => page.evaluate((mid) => {
	const k = 'daimond-msgs-deleted';
	const cur = JSON.parse(localStorage.getItem(k) || '{}');
	cur[mid] = Date.now();
	localStorage.setItem(k, JSON.stringify(cur));
}, mid);

const cs = (page, fn, arg) => page.evaluate(([fn, arg]) => window.DaimondCore.chatStore()[fn](arg), [fn, arg]);
const reconstruct = (page, id) => cs(page, 'reconstruct', id);
const summary     = (page, id) => cs(page, 'summary', id);
const chunks      = (page, id) => cs(page, 'chunks', id);
const shadowSettled = (page) => page.evaluate(() => window.DaimondCore.chatStore().shadowSettled());

// mid + role + content + order, immune to object key ordering. This IS the byte-exact
// transcript identity the gate asks for.
const project = (msgs) => (msgs || []).map((m) => ({ mid: m.mid, role: m.role, content: m.content,
	ts: m.ts || 0, elided: m.elided || 0, why: m.why || '', iturn: m.iturn || '' }));
const same = (a, b) => JSON.stringify(project(a)) === JSON.stringify(project(b));

const fail = [];
const ok = [];
const check = (cond, msg) => (cond ? ok : fail).push(msg);

const s = await open({ name: 'msgchunks-shadow', profile: PROFILE, connect: true, defaults: true, signIn: false });
const { page } = s;

// Lay the OLD-version store down from a same-origin page that is not the app, then
// load the app -- which opens at version 2 and upgrades the v1 database in place.
await page.goto(APP + '/__seed_blank__', { waitUntil: 'domcontentloaded' });
await seedV1(page, SEEDS);
await page.goto(APP + '/', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#id-primary', { timeout: 15000 }).catch(() => {});
await signInAs(s, 'msgchunks-shadow');
await page.waitForTimeout(700);
await shadowSettled(page);        // the shadow pass kicked at boot has settled

// ── 1  UPGRADE: version rose, stores added, rows intact ─────────────────────────
const info = await dbInfo(page);
check(info && info.version === 2, `upgrade: db version is 2 (got ${info && info.version})`);
check(info && info.stores.includes('chats') && info.stores.includes('msgchunks') && info.stores.includes('chatsum'),
	`upgrade: stores are ${info && info.stores.join(', ')}`);
const rowsAfter = await allChats(page);
const byId = {}; rowsAfter.forEach((r) => { byId[r.id] = r; });
let intact = SEEDS.length === rowsAfter.length && SEEDS.every((seed) =>
	byId[seed.id] && JSON.stringify(byId[seed.id]) === JSON.stringify(seed));
check(intact, `upgrade: all ${SEEDS.length} legacy chat rows survive byte-identical (found ${rowsAfter.length})`);

// ── 2  RECONSTRUCTION byte-exact, tombstone dropped ─────────────────────────────
await setTomb(page, 'tomb1');      // retract the interrupted turn in chatB
for (const seed of [chatA, chatC, chatD, chatE, chatF]) {
	const got = await reconstruct(page, seed.id);
	check(same(got, seed.messages), `reconstruct: ${seed.name} byte-exact (${(got || []).length}/${seed.messages.length} msgs)`);
}
const gotB = await reconstruct(page, 'cB');
const expB = chatB.messages.filter((m) => m.mid !== 'tomb1');
check(same(gotB, expB), `reconstruct: tombstoned message dropped, rest byte-exact (${(gotB || []).length}/${expB.length})`);
check(!(gotB || []).some((m) => m.mid === 'tomb1'), 'reconstruct: tomb1 is absent from the rebuilt transcript');

// ── 3  SUMMARY shape ────────────────────────────────────────────────────────────
const sumD = await summary(page, 'cD');
check(sumD && sumD.v === 1, `summary: versioned (v=${sumD && sumD.v})`);
check(sumD && sumD.msgCount === 300 && sumD.chunks === 3,
	`summary: counts (msgCount=${sumD && sumD.msgCount}, chunks=${sumD && sumD.chunks})`);
check(sumD && sumD.name === 'Delta chat' && sumD.updatedAt === chatD.updatedAt,
	'summary: name and updatedAt carried');
check(sumD && Array.isArray(sumD.holds) && sumD.holds.length === 1, 'summary: holds carried');
const sumE = await summary(page, 'cE');
check(sumE && sumE.hasSession === true && sumE.sessionMsgs === 3, `summary: session marker (has=${sumE && sumE.hasSession}, msgs=${sumE && sumE.sessionMsgs})`);
check(sumE && Array.isArray(sumE.iturns) && sumE.iturns.join(',') === 'T9', `summary: dispatched iturns (${sumE && sumE.iturns})`);
const sumF = await summary(page, 'cF');
check(sumF && sumF.diamondId === 'dia1', `summary: diamondId carried (${sumF && sumF.diamondId})`);
const chD = await chunks(page, 'cD');
check(Array.isArray(chD) && chD.length === 3 && chD[0].seq === 0 && chD[2].seq === 2,
	`summary: chunk rows in seq order (${(chD || []).map((c) => c.seq).join(',')})`);

// ── 4  DEDUP fuller-wins + sort ─────────────────────────────────────────────────
await putChunks(page, [
	{ k: 'craft1#0', chatId: 'craft1', seq: 0, msgs: [
		{ role: 'assistant', mid: 'd1', ts: 5, content: 'SHORT', elided: 5 },
		{ role: 'user',      mid: 'd0', ts: 1, content: 'first, lowest ts' },
	] },
	{ k: 'craft1#1', chatId: 'craft1', seq: 1, msgs: [
		{ role: 'assistant', mid: 'd1', ts: 5, content: 'FULL LONG CONTENT, the un-elided copy' },
		{ role: 'user',      mid: 'd2', ts: 9, content: 'last, highest ts' },
	] },
]);
const craft = await reconstruct(page, 'craft1');
check((craft || []).map((m) => m.mid).join(',') === 'd0,d1,d2', `dedup: sorted by (ts,mid) -> ${(craft || []).map((m) => m.mid).join(',')}`);
const d1 = (craft || []).find((m) => m.mid === 'd1');
check(d1 && d1.content === 'FULL LONG CONTENT, the un-elided copy' && !d1.elided,
	`dedup: fuller (un-elided) copy of d1 kept (${d1 && JSON.stringify(d1.content).slice(0, 30)})`);

// ── 5  IDEMPOTENT across a second boot ──────────────────────────────────────────
const n1chunks = await storeCount(page, 'msgchunks');
const n1sum    = await storeCount(page, 'chatsum');
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('#id-primary', { timeout: 15000 }).catch(() => {});
await signInAs(s, 'msgchunks-shadow');
await page.waitForTimeout(700);
await shadowSettled(page);
const n2chunks = await storeCount(page, 'msgchunks');
const n2sum    = await storeCount(page, 'chatsum');
check(n2chunks === n1chunks && n2sum === n1sum,
	`idempotent: row counts stable across boot (chunks ${n1chunks}->${n2chunks}, sum ${n1sum}->${n2sum})`);
const gotD2 = await reconstruct(page, 'cD');
check(same(gotD2, chatD.messages), 'idempotent: reconstruction still byte-exact after second boot');

// ── 6  INERT: legacy rows untouched, rail populated ─────────────────────────────
const rows2 = await allChats(page);
const by2 = {}; rows2.forEach((r) => { by2[r.id] = r; });
const stillIntact = SEEDS.every((seed) => by2[seed.id] && JSON.stringify(by2[seed.id]) === JSON.stringify(seed));
check(stillIntact, 'inert: legacy chat rows still byte-identical after two boots');
const railCount = await page.evaluate(() => document.querySelectorAll('#session-list .session-box').length);
check(railCount >= 4, `inert: rail shows the ordinary chats loaded from legacy (${railCount} tiles)`);

await shot(s, 'msgchunks-shadow');
console.log('\n--- PASS ---'); ok.forEach((m) => console.log('  ok  ', m));
console.log('--- FAIL ---'); fail.forEach((m) => console.log('  FAIL', m));
console.log('\nconsole errors:', errors(s).slice(0, 8));
await s.close();
process.exit(fail.length ? 1 : 0);
