// Verify the transcript-storage rework STAGE 2 (seq 214): the chunks become the
// SOURCE OF TRUTH, the save path APPENDS the new tail rather than rewriting the row,
// and a tombstone's dead weight is physically dropped by compaction.
//
// The gate the whole rework turns on is here: reconstruct(chatId) from the chunks
// must equal what a reload of the legacy row would produce, byte for byte -- so
// flipping the reader from the legacy row to the chunks changes nothing a user sees,
// only what the store pays. The legacy row is kept as a FALLBACK SHADOW.
//
// Six proofs, all on the real page, all headless:
//   1  CHUNKS == LEGACY, BYTE-EXACT. After a series of live turns and seeded chats,
//      reconstruct(id) equals the legacy row's transcript for every chat.
//   2  BYTE-EXACT RELOAD after a live turn, and boot holds ZERO transcripts (the
//      RAM win Stage 1 bought is preserved -- the reader flip did not undo it).
//   3  NO CROSS-CHAT CLOBBER under append. A save driven by ONE chat never shortens
//      or empties another -- the never-shorten invariant, now on the append path.
//   4  TOMBSTONE + COMPACTION. A deleted message stays gone across a reload, is
//      physically removed from the chunks by compaction, and no OTHER message is lost.
//   5  CROSS-TAB. A peer's append (a chunk written by "another tab") is visible here
//      after the cross-tab nonce, reconstructed into the transcript.
//   6  SYNC ROUNDTRIP. The @c/ content-chunk offload still works; a parcel collected
//      and applied back loses no message.
import { open, shot, scratch, errors, signInAs, chat, newChat } from './harness.mjs';
import fs from 'node:fs';

const PROFILE = scratch('pw', 'stage2');
fs.rmSync(PROFILE, { recursive: true, force: true });

const MSG_TOMBS_KEY = 'daimond-msgs-deleted';

// A corpus of seeded chats: distinct content, one spanning several chunks.
function corpus() {
	const rows = [];
	for (let g = 0; g < 8; g++) {
		const n = (g === 2) ? 300 : (4 + g);           // g2 is multi-chunk (> CHUNK_MSGS=128)
		const messages = [];
		for (let i = 0; i < n; i++) {
			messages.push({ role: i % 2 ? 'assistant' : 'user', mid: 'g' + g + '-m' + ('000' + i).slice(-3),
				ts: (g + 1) * 100000 + i, content: 'chat g' + g + ' msg ' + i + (g === 4 ? ' MARK-FOUR' : '') });
		}
		rows.push({
			id: 'g' + g, name: 'Seed ' + g, model: 'mock/fast', provider: 'mock', status: 'active',
			promptTokens: g, completionTokens: g, cachedTokens: 0, costUsd: 0,
			prevPrompt: 0, prevCompletion: 0, prevCached: 0, prevCost: 0, lastPrompt: 0,
			diamondId: '', workerModel: '', workerProvider: '', holds: [], foldedInto: null, session: null,
			updatedAt: 1_700_000_000_000 + g, messages,
		});
	}
	return rows;
}
const SEEDS = corpus();
// A chat whose messages carry stable mids we can tombstone by hand -- for the
// bare-msgTomb resurrection proof (#3). Boot-shadowed like the rest, so chunks == legacy.
SEEDS.push({
	id: 'lone', name: 'Lone Chat', model: 'mock/fast', provider: 'mock', status: 'active',
	promptTokens: 0, completionTokens: 0, cachedTokens: 0, costUsd: 0, prevPrompt: 0, prevCompletion: 0,
	prevCached: 0, prevCost: 0, lastPrompt: 0, diamondId: '', workerModel: '', workerProvider: '',
	holds: [], foldedInto: null, session: null, updatedAt: 1_700_000_100_000,
	messages: Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user',
		mid: 'lone-m' + ('000' + i).slice(-3), ts: 800000 + i, content: 'lone message ' + i })),
});

const seedRows = (page, rows) => page.evaluate((rows) => new Promise((res, rej) => {
	const req = indexedDB.open('daimond-chats');   // the app opens at v2; a plain open lands there
	req.onsuccess = () => {
		const db = req.result, t = db.transaction('chats', 'readwrite');
		rows.forEach((r) => t.objectStore('chats').put(r));
		t.oncomplete = () => { db.close(); res(); };
		t.onerror = () => rej(t.error);
	};
	req.onerror = () => rej(req.error);
}), rows);

const allRows = (page) => page.evaluate(() => new Promise((res) => {
	const req = indexedDB.open('daimond-chats');
	req.onsuccess = () => {
		const db = req.result; let t;
		try { t = db.transaction('chats', 'readonly'); } catch (e) { res([]); return; }
		const g = t.objectStore('chats').getAll();
		g.onsuccess = () => res(g.result || []); g.onerror = () => res([]);
	};
	req.onerror = () => res([]);
}));

const chatKeys = (page) => page.evaluate(() => new Promise((res) => {
	const req = indexedDB.open('daimond-chats');
	req.onsuccess = () => {
		const db = req.result; let t;
		try { t = db.transaction('chats', 'readonly'); } catch (e) { res([]); return; }
		const g = t.objectStore('chats').getAllKeys();
		g.onsuccess = () => res(g.result || []); g.onerror = () => res([]);
	};
	req.onerror = () => res([]);
}));

// Raw chunk rows for a chat, straight from the store (physical, dead copies and all).
const rawChunks = (page, id) => page.evaluate((id) => new Promise((res) => {
	const req = indexedDB.open('daimond-chats');
	req.onsuccess = () => {
		const db = req.result; let t;
		try { t = db.transaction('msgchunks', 'readonly'); } catch (e) { res([]); return; }
		const range = IDBKeyRange.bound(id + '#', id + '#￿');
		const rows = []; const cur = t.objectStore('msgchunks').openCursor(range);
		cur.onsuccess = () => { const c = cur.result; if (c) { rows.push(c.value); c.continue(); } else res(rows); };
		cur.onerror = () => res([]);
	};
	req.onerror = () => res([]);
}), id);

const reconstruct = (page, id) => page.evaluate((id) => window.DaimondCore.chatStore().reconstruct(id), id);
const loadMsgs    = (page, id) => page.evaluate((id) => window.DaimondCore.chatStore().loadMessages(id), id);
const residency   = (page) => page.evaluate(() => window.DaimondCore.chatResidency());
const mirror      = (page) => page.evaluate(() => window.DaimondCore.chatStore().stored());
const settled     = (page) => page.evaluate(() => window.DaimondCore.chatStore().settled && window.DaimondCore.chatStore().settled());
const shadowSettled = (page) => page.evaluate(() => window.DaimondCore.chatStore().shadowSettled());

const openTile = (page, name) => page.evaluate((nm) => {
	const boxes = [...document.querySelectorAll('#session-list .session-box')];
	const hit = boxes.find((b) => (b.textContent || '').includes(nm));
	if (hit) { (hit.querySelector('.tile-label, .tile-when, button') || hit).click(); return true; }
	return false;
}, name);

// mid + role + content + ts: the byte-exact transcript identity, immune to key order.
const project = (msgs) => (msgs || []).map((m) => ({ mid: m.mid, role: m.role, content: m.content, ts: m.ts || 0 }));
const same    = (a, b) => JSON.stringify(project(a)) === JSON.stringify(project(b));

const fail = [], ok = [];
const check = (cond, msg) => (cond ? ok : fail).push(msg);

const s = await open({ name: 'stage2', profile: PROFILE, connect: true, defaults: true });
const { page } = s;

// Seed the legacy rows, reload so boot reads them as the lazy summary mirror and
// shadows their chunks, and wait for the shadow pass to settle.
await seedRows(page, SEEDS);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('#id-primary', { timeout: 15000 }).catch(() => {});
await signInAs(s, 'stage2');
await page.waitForTimeout(900);
await shadowSettled(page);

// A live turn in a fresh chat (the harness-connected model), so the append path runs
// for real. Two of them, distinct.
await newChat(s);
await chat(s, 'STAGE2-ALPHA please echo this back');
await settled(page);
await newChat(s);
await chat(s, 'STAGE2-BETA please echo this back');
await settled(page);
await page.waitForTimeout(300);

// ── 1  CHUNKS == LEGACY, BYTE-EXACT (the gate) ─────────────────────────────────
const keys = await chatKeys(page);
let exact = 0; const drift = [];
for (const id of keys) {
	const legacy = await allRows(page);
	const row = legacy.find((r) => r.id === id);
	const rec = await reconstruct(page, id);
	if (row && same(rec, row.messages)) exact++;
	else drift.push(id + '(' + (rec || []).length + '/' + (row ? (row.messages || []).length : 'gone') + ')');
}
check(drift.length === 0, `gate: reconstruct == legacy row byte-exact for all ${keys.length} chats (drift ${drift.join(',') || 'none'})`);
// The multi-chunk seeded chat specifically.
const g2rec = await reconstruct(page, 'g2');
check((g2rec || []).length === 300, `gate: g2 (300 msgs, multi-chunk) reconstructs whole (${(g2rec || []).length})`);
// The live-turn chats carry their marker in the reconstruction.
const turned = [];
for (const id of keys) {
	const rec = await reconstruct(page, id);
	if ((rec || []).some((m) => String(m.content || '').includes('STAGE2-ALPHA') || String(m.content || '').includes('STAGE2-BETA'))) turned.push(id);
}
check(turned.length === 2, `gate: both live turns landed in the chunks (${turned.length} chat(s))`);

// ── 2  BYTE-EXACT RELOAD + boot holds zero transcripts ─────────────────────────
const preReload = {};
for (const id of keys) preReload[id] = await reconstruct(page, id);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('#id-primary', { timeout: 15000 }).catch(() => {});
await signInAs(s, 'stage2');
await page.waitForTimeout(900);
await shadowSettled(page);
// Boot loaded summaries only: the mirror carries no transcript.
const mir = await mirror(page);
const withMsgs = mir.filter((m) => Array.isArray(m.messages) && m.messages.length);
check(withMsgs.length === 0, `reload: boot mirror holds NO transcript (offenders ${withMsgs.length})`);
const res0 = await residency(page);
check(res0.filter((r) => r.loaded).length <= 1, `reload: at most the re-opened chat is resident (${res0.filter((r) => r.loaded).length})`);
// And every transcript reconstructs byte-identically to before the reload.
let survived = 0; const lost = [];
for (const id of keys) {
	const rec = await reconstruct(page, id);
	if (same(rec, preReload[id])) survived++;
	else lost.push(id + '(' + (rec || []).length + '/' + (preReload[id] || []).length + ')');
}
check(lost.length === 0, `reload: every transcript byte-exact across a reload (lost ${lost.join(',') || 'none'})`);

// ── 3  NO CROSS-CHAT CLOBBER under append ──────────────────────────────────────
// Open a seeded chat and rename it: persistChats saves the WHOLE list with every
// other chat non-resident (empty in memory). A wrong guard empties or shortens them.
const beforeClobber = {};
for (const id of keys) beforeClobber[id] = await reconstruct(page, id);
await openTile(page, 'Seed 4');            // the MARK-FOUR chat
await page.waitForTimeout(400);
await page.evaluate(() => {
	const boxes = [...document.querySelectorAll('#session-list .session-box')];
	const hit = boxes.find((b) => (b.textContent || '').includes('Seed 4'));
	const cog = hit && hit.querySelector('.tile-cog');
	if (cog) cog.click();
});
await page.waitForSelector('.tile-dlg-name-input', { timeout: 5000 }).catch(() => {});
await page.evaluate(() => {
	const inp = document.querySelector('.tile-dlg-name-input');
	if (inp) { inp.value = 'Seed 4 RENAMED'; inp.dispatchEvent(new Event('change', { bubbles: true })); }
});
await page.keyboard.press('Escape').catch(() => {});
await page.waitForTimeout(600);
await settled(page);
let intact = 0; const clob = [];
for (const id of keys) {
	const rec = await reconstruct(page, id);
	if (same(rec, beforeClobber[id])) intact++;
	else clob.push(id + '(' + (rec || []).length + '/' + (beforeClobber[id] || []).length + ')');
}
check(clob.length === 0, `clobber: a one-chat rename shortened NO other transcript (broken ${clob.join(',') || 'none'})`);
const g4row = (await allRows(page)).find((r) => r.id === 'g4');
check(g4row && g4row.name === 'Seed 4 RENAMED', `clobber: the renamed chat kept its rename (${g4row && g4row.name})`);

// ── 4  TOMBSTONE + COMPACTION ──────────────────────────────────────────────────
// Delete one message of a multi-message chat (g1) by tombstone, then compact.
const g1before = await reconstruct(page, 'g1');
const victim = g1before[Math.floor(g1before.length / 2)].mid;     // a middle message
const physBefore = (await rawChunks(page, 'g1')).reduce((n, r) => n + (r.msgs || []).length, 0);
await page.evaluate(([k, mid]) => {
	const cur = JSON.parse(localStorage.getItem(k) || '{}');
	cur[mid] = Date.now();
	localStorage.setItem(k, JSON.stringify(cur));
}, [MSG_TOMBS_KEY, victim]);
// Reconstruct hides it at once (tombstone honoured on read)...
const g1hidden = await reconstruct(page, 'g1');
check(!(g1hidden || []).some((m) => m.mid === victim), 'tombstone: the deleted message is hidden on read at once');
check((g1hidden || []).length === g1before.length - 1, `tombstone: exactly one message dropped (${g1before.length}->${(g1hidden || []).length})`);
// ...and compaction PHYSICALLY removes it from the chunks.
await page.evaluate((id) => window.DaimondCore.chatStore().compact(id), 'g1');
await page.waitForTimeout(300);
const physAfter = (await rawChunks(page, 'g1')).reduce((n, r) => n + (r.msgs || []).length, 0);
const physHasVictim = (await rawChunks(page, 'g1')).some((r) => (r.msgs || []).some((m) => m.mid === victim));
check(!physHasVictim, `compaction: the tombstoned mid is physically gone from the chunks (phys ${physBefore}->${physAfter})`);
check(physAfter === g1before.length - 1, `compaction: chunks hold exactly the live count, no dead weight (${physAfter})`);
// Reload: it stays gone, and every OTHER g1 message survives.
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('#id-primary', { timeout: 15000 }).catch(() => {});
await signInAs(s, 'stage2');
await page.waitForTimeout(800);
await shadowSettled(page);
const g1after = await reconstruct(page, 'g1');
check(!(g1after || []).some((m) => m.mid === victim), 'compaction: the message stays gone across a reload');
const g1survivors = g1before.filter((m) => m.mid !== victim).every((m) => (g1after || []).some((x) => x.mid === m.mid && x.content === m.content));
check(g1survivors && (g1after || []).length === g1before.length - 1, `compaction: no OTHER message was lost (${(g1after || []).length}/${g1before.length - 1})`);

// ── 5  CROSS-TAB: a peer's chunk append is seen after the nonce ────────────────
const g0before = await reconstruct(page, 'g0');
const peerTurn = [
	{ role: 'user',      mid: 'peer-u', ts: 9_000_001, content: 'PEER cross-tab question' },
	{ role: 'assistant', mid: 'peer-a', ts: 9_000_002, content: 'PEER cross-tab answer' },
];
await page.evaluate((extra) => new Promise((res, rej) => {
	const req = indexedDB.open('daimond-chats');
	req.onsuccess = () => {
		const db = req.result, t = db.transaction(['chats', 'msgchunks'], 'readwrite');
		const g = t.objectStore('chats').get('g0');
		g.onsuccess = () => { const rec = g.result; if (rec) { rec.messages = (rec.messages || []).concat(extra); rec.updatedAt = Date.now(); t.objectStore('chats').put(rec); } };
		t.objectStore('msgchunks').put({ k: 'g0#999999999999-peer', chatId: 'g0', seq: 999999999999, msgs: extra });
		t.oncomplete = () => res(); t.onerror = () => rej(t.error);
	};
	req.onerror = () => rej(req.error);
}), peerTurn);
await page.evaluate(() => {
	const k = 'daimond-chats-rev', v = String(Date.now()) + '.' + Math.random();
	try { localStorage.setItem(k, v); } catch (e) {}
	window.dispatchEvent(new StorageEvent('storage', { key: k, newValue: v }));
});
await page.waitForTimeout(700);
const g0after = await reconstruct(page, 'g0');
check((g0after || []).some((m) => m.mid === 'peer-a') && (g0after || []).length === g0before.length + 2,
	`cross-tab: the peer's append is reconstructed here (${g0before.length}->${(g0after || []).length})`);
// The in-memory view took it too (loadMessages sees the merged transcript).
const g0live = await loadMsgs(page, 'g0');
check((g0live.messages || []).some((m) => m.mid === 'peer-a'), 'cross-tab: loadMessages returns the peer message');

// ── 6  SYNC ROUNDTRIP: @c offload loses no message ─────────────────────────────
const roundtrip = await page.evaluate(async () => {
	const before = {};
	const keys = window.DaimondCore.chatStore().stored().map((c) => c.id);
	for (const id of keys) before[id] = (await window.DaimondCore.chatStore().reconstruct(id)).length;
	const parcel = await window.DaimondCore.collectSync();
	// Every chat travels whole -- inline messages, or an offloaded @c/ ref.
	const carried = (parcel.chats || []).every((c) => (Array.isArray(c.messages)) || !!c.messagesRef);
	const offloaded = (parcel.chats || []).filter((c) => c.messagesRef).length;
	await window.DaimondCore.applySync(parcel);
	const after = {};
	for (const id of keys) after[id] = (await window.DaimondCore.chatStore().reconstruct(id)).length;
	const lost = keys.filter((id) => after[id] < before[id]);
	return { carried, offloaded, lost, total: keys.length };
});
check(roundtrip.carried, 'sync: every chat travels whole in the parcel (inline or @c/ ref)');
check(roundtrip.lost.length === 0, `sync: a collect + apply roundtrip loses no message (lost in ${roundtrip.lost.join(',') || 'none'} of ${roundtrip.total})`);

// ── 7  STALE-CHUNK TRANSITION HEAL (the seq-213 -> seq-214 upgrade) ─────────────
// A chat that took turns under Stage 1 has a FULL legacy row and STALE chunks (Stage 1
// wrote the row + summary but never appended to the chunks). The reader must never
// serve less than the row holds, and must heal the chunks so it is paid once. This
// case fails on the pre-fix code (reconstruct returns only the stale chunks).
await page.evaluate(() => new Promise((res, rej) => {
	const req = indexedDB.open('daimond-chats');
	req.onsuccess = () => {
		const db = req.result, t = db.transaction(['chats', 'msgchunks', 'chatsum'], 'readwrite');
		const full = [
			{ role: 'user', mid: 'st0', ts: 1, content: 'one' },
			{ role: 'assistant', mid: 'st1', ts: 2, content: 'two' },
			{ role: 'user', mid: 'st2', ts: 3, content: 'THREE grew under Stage 1' },
			{ role: 'assistant', mid: 'st3', ts: 4, content: 'FOUR grew under Stage 1' },
		];
		t.objectStore('chats').put({ id: 'stale1', name: 'Stale Chat', model: 'mock/fast', provider: 'mock',
			status: 'active', promptTokens: 0, completionTokens: 0, cachedTokens: 0, costUsd: 0, prevPrompt: 0,
			prevCompletion: 0, prevCached: 0, prevCost: 0, lastPrompt: 0, diamondId: '', workerModel: '',
			workerProvider: '', holds: [], foldedInto: null, session: null, updatedAt: 5000, messages: full });
		t.objectStore('msgchunks').put({ k: 'stale1#0', chatId: 'stale1', seq: 0, msgs: full.slice(0, 2) });   // STALE: 2 of 4
		t.objectStore('chatsum').put({ id: 'stale1', v: 1, name: 'Stale Chat', model: 'mock/fast', provider: 'mock',
			diamondId: '', workerModel: '', workerProvider: '', status: 'active', promptTokens: 0, completionTokens: 0,
			cachedTokens: 0, costUsd: 0, prevPrompt: 0, prevCompletion: 0, prevCached: 0, prevCost: 0, lastPrompt: 0,
			holds: [], updatedAt: 5000, foldedInto: null, msgCount: 4, chunks: 1, hasSession: false, sessionMsgs: 0,
			iturns: [], fp: 'x:0' });
		t.oncomplete = () => res(); t.onerror = () => rej(t.error);
	};
	req.onerror = () => rej(req.error);
}));
const staleLoad = await loadMsgs(page, 'stale1');
check(['st0', 'st1', 'st2', 'st3'].every((m) => (staleLoad.messages || []).some((x) => x.mid === m)),
	`transition: reader recovers a Stage-1 chat's messages missing from stale chunks (${(staleLoad.messages || []).map((m) => m.mid).join(',')})`);
// And the chunks were HEALED, so a pure reconstruct now returns them too.
const staleRec = await reconstruct(page, 'stale1');
check(['st0', 'st1', 'st2', 'st3'].every((m) => (staleRec || []).some((x) => x.mid === m)),
	`transition: the stale chunks were healed (reconstruct now has all four: ${(staleRec || []).map((m) => m.mid).join(',')})`);

// ── 8  SYNC INTO A NON-RESIDENT CHAT reaches the chunk reader ──────────────────
// An existing chat this tab has never opened receives new messages via applySync.
// They must land in the chunks (the reader), not only the legacy shadow.
const nonResBefore = (await residency(page)).find((r) => r.id === 'g6');
await page.evaluate(() => new Promise(async (res) => {
	const parcel = { v: 3, chats: [{ id: 'g6', name: 'Seed 6', model: 'mock/fast', updatedAt: 9_500_000,
		messages: [ { role: 'user', mid: 'g6-sync-a', ts: 9_500_001, content: 'SYNCED into non-resident A' },
			{ role: 'assistant', mid: 'g6-sync-b', ts: 9_500_002, content: 'SYNCED into non-resident B' } ], session: null }],
		tombs: {}, msgTombs: {}, diamonds: [], diamondTombs: {} };
	await window.DaimondCore.applySync(parcel);
	res();
}));
const g6rec = await reconstruct(page, 'g6');
check(nonResBefore && nonResBefore.loaded === false, `sync-nonres: g6 was non-resident before the sync (loaded=${nonResBefore && nonResBefore.loaded})`);
check((g6rec || []).some((m) => m.mid === 'g6-sync-a') && (g6rec || []).some((m) => m.mid === 'g6-sync-b'),
	`sync-nonres: the synced messages reached the CHUNK reader (${(g6rec || []).map((m) => m.mid).join(',')})`);

// ── 9  TOMBSTONE SWEEP: a bare msgTomb (chat NOT in the parcel) compacts BOTH stores ──
// The privacy case with teeth: a deletion that arrives as a msgTomb with no shortened
// chat beside it. Pre-fix, applyChats touched neither the chunks nor the legacy row, so
// both physical copies outlived the tombstone and RESURRECTED once it aged out.
const loneBefore = await reconstruct(page, 'lone');
await page.evaluate(() => window.DaimondCore.applySync({ v: 3, chats: [],
	msgTombs: { 'lone-m002': Date.now(), 'lone-m005': Date.now() }, tombs: {}, diamonds: [], diamondTombs: {} }));
await page.waitForTimeout(400);
await settled(page);
const loneRec = await reconstruct(page, 'lone');
check(!loneRec.some((m) => m.mid === 'lone-m002') && !loneRec.some((m) => m.mid === 'lone-m005'),
	'tomb-sweep: the reader drops the bare-tombed mids');
const loneChunkRows = await rawChunks(page, 'lone');
const physHasTombed = loneChunkRows.some((r) => (r.msgs || []).some((m) => m.mid === 'lone-m002' || m.mid === 'lone-m005'));
check(!physHasTombed, 'tomb-sweep: the mids are PHYSICALLY gone from the chunks');
const loneRow = (await allRows(page)).find((r) => r.id === 'lone');
const legacyHasTombed = loneRow && (loneRow.messages || []).some((m) => m.mid === 'lone-m002' || m.mid === 'lone-m005');
check(!legacyHasTombed, 'tomb-sweep: the mids are PHYSICALLY gone from the legacy fallback row');
// Age-out: remove the tombstones and reload. They must NOT come back.
await page.evaluate(() => { try { localStorage.setItem('daimond-msgs-deleted', '{}'); } catch (e) {} });
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('#id-primary', { timeout: 15000 }).catch(() => {});
await signInAs(s, 'stage2');
await page.waitForTimeout(800);
await shadowSettled(page);
const loneAfter = await reconstruct(page, 'lone');
check(!loneAfter.some((m) => m.mid === 'lone-m002') && !loneAfter.some((m) => m.mid === 'lone-m005'),
	'tomb-sweep: NO resurrection after the tombstone ages out + reload');
check(loneAfter.length === loneBefore.length - 2,
	`tomb-sweep: exactly the two deleted messages gone, the rest intact (${loneAfter.length}/${loneBefore.length - 2})`);

// ── 10  PRE-seq-211 FULL LOG: first open serves the ELIDED chunk copy, row re-slimmed ──
// A chat migrated with a full (un-elided) log in the legacy row and the seq-211 elided
// copy in its chunks. The chunks are authoritative, so the reader serves the ELIDED
// copy (pre-fix it served the un-elided one -- fuller-wins over the chunk copy), and the
// fallback row is re-slimmed so the un-elided bulk stops riding storage.
const bigBody = 'HEAD ' + ('log '.repeat(4000)) + ' TAIL';
await page.evaluate(([full, elided]) => new Promise((res, rej) => {
	const req = indexedDB.open('daimond-chats');
	req.onsuccess = () => {
		const db = req.result, t = db.transaction(['chats', 'msgchunks', 'chatsum'], 'readwrite');
		const rowMsgs = [
			{ role: 'user', mid: 'ps0', ts: 1, content: 'ask' },
			{ role: 'think_log', mid: 'ps1', ts: 2, content: full },                 // FULL in the row
			{ role: 'assistant', mid: 'ps2', ts: 3, content: 'answer' },
		];
		const chunkMsgs = [
			{ role: 'user', mid: 'ps0', ts: 1, content: 'ask' },
			{ role: 'think_log', mid: 'ps1', ts: 2, content: elided, elided: 9999 }, // ELIDED in the chunks
			{ role: 'assistant', mid: 'ps2', ts: 3, content: 'answer' },
		];
		t.objectStore('chats').put({ id: 'preslim', name: 'Preslim', model: 'mock/fast', provider: 'mock',
			status: 'active', promptTokens: 0, completionTokens: 0, cachedTokens: 0, costUsd: 0, prevPrompt: 0,
			prevCompletion: 0, prevCached: 0, prevCost: 0, lastPrompt: 0, diamondId: '', workerModel: '',
			workerProvider: '', holds: [], foldedInto: null, session: null, updatedAt: 5000, messages: rowMsgs });
		t.objectStore('msgchunks').put({ k: 'preslim#0', chatId: 'preslim', seq: 0, msgs: chunkMsgs });
		t.objectStore('chatsum').put({ id: 'preslim', v: 2, name: 'Preslim', model: 'mock/fast', provider: 'mock',
			diamondId: '', workerModel: '', workerProvider: '', status: 'active', promptTokens: 0, completionTokens: 0,
			cachedTokens: 0, costUsd: 0, prevPrompt: 0, prevCompletion: 0, prevCached: 0, prevCost: 0, lastPrompt: 0,
			holds: [], updatedAt: 5000, foldedInto: null, msgCount: 3, chunks: 1, hasSession: false, sessionMsgs: 0,
			iturns: [], fp: 'x:0' });
		t.oncomplete = () => res(); t.onerror = () => rej(t.error);
	};
	req.onerror = () => rej(req.error);
}), [bigBody, 'HEAD [elided] TAIL']);
const psLoad = await loadMsgs(page, 'preslim');
const psLog = (psLoad.messages || []).find((m) => m.mid === 'ps1');
check(psLog && psLog.elided && psLog.content.length < 100,
	`preslim: first open serves the ELIDED chunk copy (len=${psLog && psLog.content.length}, elided=${psLog && psLog.elided})`);
const psRow = (await allRows(page)).find((r) => r.id === 'preslim');
const psRowLog = psRow && (psRow.messages || []).find((m) => m.mid === 'ps1');
check(psRowLog && psRowLog.content.length < 100,
	`preslim: the legacy fallback row was re-slimmed (row log len=${psRowLog && psRowLog.content.length})`);

await shot(s, 'stage2');
console.log('\n--- PASS ---'); ok.forEach((m) => console.log('  ok  ', m));
console.log('--- FAIL ---'); fail.forEach((m) => console.log('  FAIL', m));
console.log('\nconsole errors:', errors(s).slice(0, 8));
await s.close();
process.exit(fail.length ? 1 : 0);
