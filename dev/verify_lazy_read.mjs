// Verify the transcript-storage rework STAGE 1 (seq 213): the lazy read path.
//
// Boot no longer loads every chat's whole transcript into RAM. `readAll` loads chatsum
// SUMMARIES into the mirror; a chat's messages load on open (and for any consumer that
// needs the whole transcript) from its authoritative legacy row. The one hazard is the
// read/write coupling: once the mirror holds only summaries, a synchronous save must
// never write an EMPTY transcript over a non-resident chat. `ChatStore.write` closes it
// by unioning every save against the row already on disk, so a save of one chat can
// never empty another.
//
// Six proofs, all on the real page, all headless:
//   1  BOOT LOADS NO TRANSCRIPTS. After boot the mirror holds summaries (no messages),
//      and every chat is non-resident -- the boot-RAM win, measured.
//   2  THE RAIL RENDERS from the summaries: every seeded chat has a tile, named right.
//   3  OPENING A CHAT lazy-loads its transcript and renders it byte-exact; the others
//      stay non-resident.
//   4  NO CROSS-CHAT CLOBBER (the crux). A save triggered by ONE chat (a rename) leaves
//      EVERY OTHER chat's stored transcript byte-exact across a reload.
//   5  SYNC COLLECT carries whole transcripts, not the empty summaries.
//   6  A LIVE TURN appends and survives a reload, with the rest of the store intact.
import { open, shot, scratch, errors, signInAs, chat, newChat } from './harness.mjs';
import fs from 'node:fs';

const PROFILE = scratch('pw', 'lazy-read');
fs.rmSync(PROFILE, { recursive: true, force: true });

const APP = process.env.DAIMOND_APP || ('http://localhost:' + (process.env.DAIMOND_PORT || 8777));

// A corpus: 12 chats, distinct content, one long enough to span several chunks.
function corpus() {
	var rows = [];
	for (var g = 0; g < 12; g++) {
		var n = (g === 3) ? 200 : (5 + g);           // g3 is multi-chunk (> CHUNK_MSGS)
		var messages = [];
		for (var i = 0; i < n; i++) {
			messages.push({ role: i % 2 ? 'assistant' : 'user', mid: 'g' + g + '-m' + ('000' + i).slice(-3),
				ts: (g + 1) * 1000 + i, content: 'chat g' + g + ' msg ' + i + (g === 5 ? ' UNIQUE-FIVE' : '') });
		}
		rows.push({
			id: 'g' + g, name: 'Chat ' + g, model: 'mock/fast', provider: 'mock', status: 'active',
			promptTokens: g, completionTokens: g, cachedTokens: 0, costUsd: 0,
			prevPrompt: 0, prevCompletion: 0, prevCached: 0, prevCost: 0, lastPrompt: 0,
			diamondId: '', workerModel: '', workerProvider: '', holds: [], foldedInto: null, session: null,
			updatedAt: 1_700_000_000_000 + g, messages,
		});
	}
	return rows;
}
const SEEDS = corpus();

const seedRows = (page, rows) => page.evaluate((rows) => new Promise((res, rej) => {
	// The app opens the store at version 2 on load, so this version-agnostic open lands
	// on it and puts straight into `chats` -- no schema work here.
	const req = indexedDB.open('daimond-chats');
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

const residency  = (page) => page.evaluate(() => window.DaimondCore.chatResidency());
const mirror     = (page) => page.evaluate(() => window.DaimondCore.chatStore().stored());
const collect    = (page) => page.evaluate(() => window.DaimondCore.collectSync());

const openTile = (page, name) => page.evaluate((nm) => {
	const boxes = [...document.querySelectorAll('#session-list .session-box')];
	const hit = boxes.find((b) => (b.textContent || '').includes(nm));
	if (hit) { (hit.querySelector('.tile-label, .tile-when, button') || hit).click(); return true; }
	return false;
}, name);

const renameViaCog = async (page, matchName, newName) => {
	await page.evaluate((nm) => {
		const boxes = [...document.querySelectorAll('#session-list .session-box')];
		const hit = boxes.find((b) => (b.textContent || '').includes(nm));
		const cog = hit && hit.querySelector('.tile-cog');
		if (cog) cog.click();
	}, matchName);
	await page.waitForSelector('.tile-dlg-name-input', { timeout: 5000 });
	await page.evaluate((nn) => {
		const inp = document.querySelector('.tile-dlg-name-input');
		inp.value = nn;
		inp.dispatchEvent(new Event('change', { bubbles: true }));
	}, newName);
	await page.keyboard.press('Escape').catch(() => {});
};

const project = (msgs) => (msgs || []).map((m) => ({ mid: m.mid, role: m.role, content: m.content }));
const sameRow  = (a, b) => JSON.stringify(project(a)) === JSON.stringify(project(b));

const fail = [], ok = [];
const check = (cond, msg) => (cond ? ok : fail).push(msg);

const s = await open({ name: 'lazy-read', profile: PROFILE, connect: true, defaults: true });
const { page } = s;

// Seed straight into the (version-2) `chats` store, then reload so boot reads it as the
// lazy summary mirror. No schema work -- the store already exists at v2.
await seedRows(page, SEEDS);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('#id-primary', { timeout: 15000 }).catch(() => {});
await signInAs(s, 'lazy-read');
await page.waitForTimeout(900);
await page.evaluate(() => window.DaimondCore.chatStore().shadowSettled());

// ── 1  BOOT LOADS NO TRANSCRIPTS ───────────────────────────────────────────────
const mir = await mirror(page);
const mirHasMsgs = mir.filter((s0) => Array.isArray(s0.messages) && s0.messages.length);
check(mir.length === 12, `boot: mirror holds 12 summaries (got ${mir.length})`);
check(mirHasMsgs.length === 0, `boot: NO summary carries a transcript (offenders ${mirHasMsgs.length})`);
check(mir.every((s0) => typeof s0.msgCount === 'number'), 'boot: summaries carry msgCount');
const res0 = await residency(page);
const resident0 = res0.filter((r) => r.loaded);
// At most ONE chat is resident at boot -- the one the app re-opens (OPEN_CHAT_KEY). The
// win is that the other eleven's transcripts were NOT loaded. (The mirror carrying no
// transcripts, asserted above, is the direct measurement.)
check(resident0.length <= 1, `boot: at most the re-opened chat is resident (resident ${resident0.length}: ${resident0.map((r) => r.id).join(',')})`);
const g3sum = mir.find((s0) => s0.id === 'g3');
check(g3sum && g3sum.msgCount === 200, `boot: g3 summary msgCount is 200 (got ${g3sum && g3sum.msgCount})`);

// ── 2  THE RAIL RENDERS from summaries ──────────────────────────────────────────
const rail = await page.evaluate(() => {
	const boxes = [...document.querySelectorAll('#session-list .session-box')];
	return { count: boxes.length, text: boxes.map((b) => b.textContent).join(' | ') };
});
check(rail.count === 12, `rail: 12 tiles (got ${rail.count})`);
check(rail.text.includes('Chat 5') && rail.text.includes('Chat 11'), 'rail: tiles are named from the summaries');

// ── 3  OPENING A CHAT lazy-loads its transcript ─────────────────────────────────
const opened = await openTile(page, 'Chat 5');
check(opened, 'open: Chat 5 opened from the rail');
await page.waitForTimeout(500);
const res1 = await residency(page);
const r5 = res1.find((r) => r.id === 'g5');
check(r5 && r5.loaded, 'open: Chat 5 is now resident');
// Only the opened chats are resident -- opening one does not drag the rest into RAM.
// (At most the boot-reopened chat plus g5.)
const residN = res1.filter((r) => r.loaded).length;
check(residN <= 2, `open: opening one chat does not load the rest (resident ${residN}/12)`);
const dom5 = await page.evaluate(() => document.getElementById('chat-output').textContent);
check(dom5.includes('chat g5 msg 0 UNIQUE-FIVE') && dom5.includes('chat g5 msg 9 UNIQUE-FIVE'),
	'open: Chat 5 transcript rendered byte-exact (head and tail present)');

// ── 5  SYNC COLLECT carries whole transcripts ───────────────────────────────────
// (Before the clobber test, so the parcel is built from the pristine seed.)
const parcel = await collect(page);
const pc = {}; (parcel.chats || []).forEach((c) => { pc[c.id] = c; });
const pcarry = SEEDS.every((seed) => {
	const c = pc[seed.id];
	if (!c) return false;
	if (Array.isArray(c.messages)) return c.messages.length === seed.messages.length;
	return !!c.messagesRef;   // offloaded (no cloud here, so expect inline, but accept a ref)
});
check(pcarry, 'sync: collectSync carries every transcript whole (not the empty summary)');
const g3p = pc['g3'];
check(g3p && Array.isArray(g3p.messages) && g3p.messages.length === 200, 'sync: g3 (200 msgs) rides whole in the parcel');

// ── 4  NO CROSS-CHAT CLOBBER (the crux) ─────────────────────────────────────────
// Open Chat 3, then rename it: `persistChats` saves the WHOLE list, and every other
// chat is non-resident (empty in memory). If the guard is wrong, the save empties them.
await openTile(page, 'Chat 3');
await page.waitForTimeout(400);
await renameViaCog(page, 'Chat 3', 'Chat 3 RENAMED');
await page.waitForTimeout(800);
await page.evaluate(() => window.DaimondCore.chatStore().settled && window.DaimondCore.chatStore().settled());
await page.waitForTimeout(300);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('#id-primary', { timeout: 15000 }).catch(() => {});
await signInAs(s, 'lazy-read');
await page.waitForTimeout(800);

const rowsAfter = await allRows(page);
const byId = {}; rowsAfter.forEach((r) => { byId[r.id] = r; });
let intact = 0, broken = [];
SEEDS.forEach((seed) => {
	const row = byId[seed.id];
	if (row && sameRow(row.messages, seed.messages)) intact++;
	else broken.push(seed.id + '(' + (row ? (row.messages || []).length : 'gone') + '/' + seed.messages.length + ')');
});
check(intact === 12, `clobber: all 12 transcripts byte-exact after a one-chat save + reload (intact ${intact}; broken ${broken.join(',')})`);
check(byId['g3'] && byId['g3'].name === 'Chat 3 RENAMED', `clobber: the renamed chat kept its rename (${byId['g3'] && byId['g3'].name})`);

// ── 6  A LIVE TURN appends and survives reload ──────────────────────────────────
// A real turn through the mock, in a FRESH chat (which carries the harness's connected
// model; the seeded chats reference a mock provider this profile has no key for, so a
// turn cannot be sent into one). The turn's save writes the whole list -- with all 12
// seeded chats non-resident -- so this also re-proves the never-shorten guard under a
// genuine turn: the new chat persists, and every seeded chat stays byte-exact.
await newChat(s);
await chat(s, 'LIVE-TURN-MARKER please echo this back');
await page.evaluate(() => window.DaimondCore.chatStore().settled && window.DaimondCore.chatStore().settled());
await page.waitForTimeout(300);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('#id-primary', { timeout: 15000 }).catch(() => {});
await signInAs(s, 'lazy-read');
await page.waitForTimeout(800);
const rows2 = await allRows(page);
const grew = rows2.filter((r) => (r.messages || []).some((m) => String(m.content || '').includes('LIVE-TURN-MARKER')));
check(grew.length === 1 && grew[0].messages.length >= 2,
	`turn: the live turn landed in a chat and survived a reload (${grew.length} chat(s), ${grew.length ? grew[0].messages.length : 0} msgs)`);
// Every SEEDED chat is byte-exact after the turn's whole-list save -- none was clobbered.
const by2 = {}; rows2.forEach((r) => { by2[r.id] = r; });
let intact2 = 0;
SEEDS.forEach((seed) => { if (by2[seed.id] && sameRow(by2[seed.id].messages, seed.messages)) intact2++; });
check(intact2 === 12, `turn: all 12 seeded chats stay byte-exact after the turn's save (${intact2}/12)`);

await shot(s, 'lazy-read');
console.log('\n--- PASS ---'); ok.forEach((m) => console.log('  ok  ', m));
console.log('--- FAIL ---'); fail.forEach((m) => console.log('  FAIL', m));
console.log('\nconsole errors:', errors(s).slice(0, 8));
await s.close();
process.exit(fail.length ? 1 : 0);
