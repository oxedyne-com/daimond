/* ============================================================
   Test — S-SYNC #6: a deletion tombstone survives a full localStorage,
   so a delete no longer resurrects from disk or from the peer.
   ------------------------------------------------------------
   THE BUG. Every tombstone writer -- `tombstone`, `msgTombstone`,
   `diamondTombstone`, `tombstoneIn`, `mergeTombMap` -- wrote the map to
   localStorage inside a try/catch that swallowed the error as "best
   effort". The origin holds ~5 MiB, `setItem` throws when it is full, and
   the throw was swallowed. So under quota a delete left the rail but NO tombstone
   persisted: on reload the row came back from disk, and across devices
   the peer's parcel re-added it as new -- the receiver applied the delete
   in memory but `ChatStore.write` deletes a row only on a STORED
   tombstone, so it rebuilt on the next list. Silent both ways.

   THE FIX, all in `www/js/daimond.js` (+ `www/js/trash.js`):
     1. Tombstones move to an IndexedDB `tombs` store (room localStorage
        has not). localStorage becomes a READ-CACHE and `tombMem` an
        in-session overlay, so `tombMapNow` -- what every synchronous
        reader and the collect that packs the parcel are built on -- sees
        a tomb even when the cache write was lost to quota.
     2. `ChatStore.putTombs` lands a map durably and RETURNS truth.
     3. `destroyChat`/`destroyDiamond` AWAIT it and REFUSE, loudly, on a
        lost write -- nothing half-happens.
     4. `applyChats`/`applyDiamonds` await it too, so a peer's deletion is
        durably recorded on the receiver, not merely applied in memory.
     5. `bootTombs` seeds `tombMem` from IDB and migrates the old maps in
        BEFORE the first `write`, so a deletion recorded yesterday is not
        forgotten today.

   `daimond.js` is an ES module that imports the compiled wasm surface, so
   it cannot be instantiated in a sandbox here (the same reason
   `collectheap.test.mjs`/`quotamanifest.test.mjs` give for the same
   file). So the REAL code is held to SOURCE GUARDS, and the durability
   LOGIC -- the three-layer store where the defect lived -- is exercised
   for real against a faithful port, over one localStorage that runs out
   of room. Each check is proven able to fail:

     node www/js/tombdurable.test.mjs                 # the fix, clean
     node www/js/tombdurable.test.mjs --break swallow # tombs localStorage-only again → resurrect
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const DAIMOND_SRC = join(HERE, 'daimond.js');
const TRASH_SRC   = join(HERE, 'trash.js');

let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) { console.log('  ok   ' + name); }
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i >= 0 ? (process.argv[i + 1] || '') : '';
})();
const KNOWN = ['swallow'];
if (BREAK && !KNOWN.includes(BREAK)) {
	console.error('unknown break ' + JSON.stringify(BREAK) + '; known: ' + KNOWN.join(', '));
	process.exit(2);
}

/// The body of a named declaration, declaration to the first line that closes it
/// at the declaration's own indentation. Enough to assert what a function does.
function funcBody(src, decl) {
	const at = src.indexOf(decl);
	if (at < 0) throw new Error('declaration not found: ' + decl);
	const lineStart = src.lastIndexOf('\n', at) + 1;
	const indent = src.slice(lineStart, at).match(/^\t*/)[0];
	const close = '\n' + indent + '}';
	const end = src.indexOf(close, at);
	if (end < 0) throw new Error('close not found for: ' + decl);
	return src.slice(at, end + close.length);
}

// ── The daimond.js source, optionally patched to REINTRODUCE the swallow so a
//    guard can be shown to catch it. ─────────────────────────────────────────
function daimondSrc() {
	let src = readFileSync(DAIMOND_SRC, 'utf8');
	if (BREAK === 'swallow') {
		// The overlay goes: `tombMapNow` reads localStorage alone, exactly as it
		// did before the tomb store existed -- so a tomb the cache lost to quota is
		// invisible to every reader, and the deletion resurrects.
		if (!src.includes('\t\tvar m = tombMem[key];\n')) throw new Error('break target not found: tombMapNow overlay');
		src = src.replace('\t\tvar m = tombMem[key];\n', '\t\tvar m = null;  // BROKEN: overlay removed\n');
	}
	return src;
}

// ── SOURCE GUARDS on the real code ───────────────────────────────────────────
function sourceGuards() {
	const d = daimondSrc();

	console.log('tombdurable: source -- the tomb store, seeded and migrated at boot');
	check('a `tombs` object store is created, keyed on (map, id)',
		d.includes("d.createObjectStore(TOMBS_STORE, { keyPath: ['map', 'id'] });"), 'no tombs store');
	check('the DB version was bumped for it', d.includes('var CHATS_DB_VERSION = 3;'), 'version not bumped');
	check('ChatStore.putTombs lands a map durably and returns truth',
		d.includes('putTombs: async function (mapKey, obj) {') && d.includes('return await writeTombRows(rows);'),
		'no durable putTombs');
	{
		const bt = funcBody(d, 'async function bootTombs() {');
		check('bootTombs seeds tombMem from IDB', bt.includes('tombMem[r.map]'), 'IDB not read into tombMem');
		check('bootTombs migrates the old localStorage maps in', bt.includes('writeTombRows(migrate)'), 'no migration');
	}
	check('boot awaits bootTombs before the first write', d.includes('await bootTombs();'), 'boot does not seed tombs');

	console.log('\ntombdurable: source -- every synchronous read is quota-proof (the overlay)');
	{
		const tm = funcBody(d, 'function tombMapNow(key) {');
		check('tombMapNow unions the localStorage cache with tombMem',
			tm.includes('readJson(key, {})') && tm.includes('var m = tombMem[key];'),
			'the overlay is gone -- a quota-lost tomb is invisible');
		check('loadTombs is built on tombMapNow', funcBody(d, 'function loadTombs() {').includes('tombMapNow(TOMBS_KEY)'));
		check('loadMsgTombs is built on tombMapNow', funcBody(d, 'function loadMsgTombs() {').includes('tombMapNow(MSG_TOMBS_KEY)'));
		check('loadDiamondTombs is built on tombMapNow', funcBody(d, 'function loadDiamondTombs() {').includes('tombMapNow(DIAMOND_TOMBS_KEY)'));
		check('the parcel is packed from the quota-proof readers, not raw readJson',
			d.includes('tombs:        loadTombs(),') && d.includes('msgTombs:     loadMsgTombs(),')
			&& d.includes('diamondTombs: loadDiamondTombs(),'), 'collect still reads raw localStorage');
	}

	console.log('\ntombdurable: source -- a lost tombstone is refused, loudly, not swallowed');
	{
		const dc = funcBody(d, 'async function destroyChat(id) {');
		check('destroyChat awaits putTombs and refuses on a lost write',
			dc.includes('if (!(await ChatStore.putTombs(TOMBS_KEY, obj))) {') && dc.includes('return false;'),
			'destroyChat still deletes on an unrecorded tombstone');
		check('destroyChat raises the storage alarm on the refusal', dc.includes("storageAlarm(tOr('store.delete_unrecorded'"),
			'the refusal is silent');
		const dd = funcBody(d, 'async function destroyDiamond(id) {');
		check('destroyDiamond awaits putTombs and refuses on a lost write',
			dd.includes('if (!(await ChatStore.putTombs(DIAMOND_TOMBS_KEY, _dobj))) {') && dd.includes('return false;'),
			'destroyDiamond still deletes on an unrecorded tombstone');
		// No writer swallows a quota throw with the old "best effort" comment any more.
		check('no tombstone writer swallows a setItem throw as "best effort"',
			!/setItem\((?:TOMBS_KEY|MSG_TOMBS_KEY|DIAMOND_TOMBS_KEY)[^;]*\); \} catch \(e\) \{ \/\* best effort/.test(d),
			'a swallowing localStorage tombstone write remains');
	}

	console.log('\ntombdurable: source -- the receiver records a peer deletion durably');
	check('applyChats awaits putTombs for the chat and message tombs',
		d.includes('await ChatStore.putTombs(TOMBS_KEY, tombs);')
		&& d.includes('await ChatStore.putTombs(MSG_TOMBS_KEY, mergedMsgTombs);'), 'receiver keeps chat tombs in memory only');
	check('applyDiamonds awaits putTombs for the Diamond tombs',
		d.includes('await ChatStore.putTombs(DIAMOND_TOMBS_KEY, tombs);'), 'receiver keeps Diamond tombs in memory only');

	console.log('\ntombdurable: source -- trash.js surfaces a lost write instead of swallowing it');
	{
		const ts = readFileSync(TRASH_SRC, 'utf8');
		const save = funcBody(ts, 'function save() {');
		// Since release 5 through DaimondStore, whose `put` answers whether it landed
		// and holds a refused record owed rather than dropping it.
		check('trash save() returns whether the write landed',
			save.includes('return window.DaimondStore.put(KEY,'), 'save() still swallows');
	}

	console.log('\ntombdurable: source -- file tombstones are durable in the tomb store too (A5)');
	{
		const nf = funcBody(d, 'function noteFileTombs(col, complete) {');
		check('noteFileTombs lands new file tombs in IndexedDB', nf.includes('ChatStore.putTombs(SYNC_FILE_TOMBS_KEY, fresh)'),
			'file tombs are localStorage only');
		check('noteFileTombs raises the alarm on a lost write', nf.includes("storageAlarm(tOr('store.delete_unrecorded'"),
			'a lost file tomb is silent');
		check('noteFileTombs no longer swallows the write as best effort',
			!/setItem\(SYNC_FILE_TOMBS_KEY[^;]*\); ?\n?\s*catch \(e\) \{ \/\* best effort/.test(nf), 'the swallow remains');
		check('the carried map reads the overlay', funcBody(d, 'function fileTombsHeld() {').includes('tombMem[SYNC_FILE_TOMBS_KEY]'),
			'fileTombs reads localStorage alone');
		check('bootTombs migrates the file tombs into the store',
			funcBody(d, 'async function bootTombs() {').includes('migrate.push({ map: SYNC_FILE_TOMBS_KEY'), 'no migration');
		check('every tomb map is carried in id order (SIM-7)',
			funcBody(d, 'function tombMapNow(key) {').includes('Object.keys(out).sort()'), 'insertion order');
	}
}

// ── BEHAVIOURAL: a faithful port of the three-layer tomb store ────────────────
//
// localStorage (a read-cache that can run out of room), tombMem (the in-session
// overlay), and an IndexedDB store that has room localStorage does not. The port
// mirrors `tombMapNow`, `putTombs`, `tombMark`, `bootTombs` and the destroy path
// in shape. `--break swallow` reverts it to the OLD localStorage-only writer with
// the overlay removed, exactly as the source patch does, so the resurrection is
// reproduced. It proves: a tomb made under quota is still seen and is durable,
// the row is not resurrected on reload, and a peer's deletion sticks on the
// receiver.

const TTL = 37 * 24 * 3600 * 1000;

function makeDevice(broken) {
	const ls = new Map();
	let full = false;
	const setItem = (k, v) => {
		if (full) { const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; }
		ls.set(k, String(v));
	};
	const readJson = (k, f) => { try { const r = ls.has(k) ? ls.get(k) : null; return r ? JSON.parse(r) : f; } catch (e) { return f; } };
	const idb = new Map();          // "map\u0000id" -> at  (the durable tombs store)
	const tombMem = {};

	// tombMapNow: localStorage cache ∪ tombMem (unless broken → cache alone).
	function tombMapNow(key) {
		const t = readJson(key, {}), now = Date.now(), out = {};
		Object.keys(t).forEach((id) => { const ts = t[id]; if (typeof ts === 'number' && now - ts < TTL) out[id] = ts; });
		if (!broken) { const m = tombMem[key]; if (m) Object.keys(m).forEach((id) => { const ts = m[id]; if (typeof ts === 'number' && now - ts < TTL && (!out[id] || ts > out[id])) out[id] = ts; }); }
		return out;
	}
	function cacheWrite(key) { try { setItem(key, JSON.stringify(tombMapNow(key))); } catch (e) { /* cache only */ } }
	async function putTombs(key, obj) {           // durable IDB write; returns truth
		try { Object.keys(obj).forEach((id) => { idb.set(key + '\u0000' + id, obj[id]); }); return true; }
		catch (e) { return false; }
	}
	function mark(key, ids, at) { const m = tombMem[key] || (tombMem[key] = {}); ids.forEach((id) => { if (id && (!m[id] || at > m[id])) m[id] = at; }); cacheWrite(key); }

	// The destroy path: durable-first, refuse-loud (or, broken, the old swallow).
	let alarms = 0;
	async function destroy(key, id) {
		const at = Date.now();
		if (broken) {
			// OLD: write the whole map to localStorage, swallowing a quota throw.
			const t = readJson(key, {}); t[id] = at;
			try { setItem(key, JSON.stringify(t)); } catch (e) { /* best effort — SWALLOWED */ }
			return true;
		}
		const obj = {}; obj[id] = at;
		if (!(await putTombs(key, obj))) { alarms++; return false; }
		mark(key, [id], at);
		return true;
	}
	// The receiver of a parcel's tomb map.
	async function receive(key, incoming) {
		if (broken) {
			const t = readJson(key, {});
			Object.keys(incoming).forEach((id) => { if (!t[id] || incoming[id] > t[id]) t[id] = incoming[id]; });
			try { setItem(key, JSON.stringify(t)); } catch (e) { /* SWALLOWED */ }
			return;
		}
		Object.keys(incoming).forEach((id) => { const m = tombMem[key] || (tombMem[key] = {}); if (!m[id] || incoming[id] > m[id]) m[id] = incoming[id]; });
		cacheWrite(key);
		await putTombs(key, tombMapNow(key));      // durable on the receiver
	}
	// bootTombs: rebuild tombMem from IDB (what a reload does).
	function reload() {
		for (const k in tombMem) delete tombMem[k];
		if (broken) return;                        // no IDB in the swallowing build
		idb.forEach((at, k) => { const i = k.indexOf('\u0000'); const map = k.slice(0, i), id = k.slice(i + 1); const m = tombMem[map] || (tombMem[map] = {}); if (!m[id] || at > m[id]) m[id] = at; });
	}
	// Does the rail still show the chat? It is gone only when a tomb names it --
	// exactly `storedChats`' `!tombs[c.id]` and `ChatStore.write`'s delete rule.
	const railHas = (key, id) => !tombMapNow(key)[id];
	// The durable record itself, which a reload is rebuilt from.
	const durable = (key, id) => idb.has(key + '\u0000' + id);

	return { setFull: (v) => { full = v; }, destroy, receive, reload, railHas, durable,
		tombMapNow, alarms: () => alarms };
}

const CHATS = 'daimond-chats-deleted';

async function behavioural() {
	console.log('\ntombdurable: behavioural -- a delete under a FULL localStorage survives');
	{
		const A = makeDevice(BREAK === 'swallow');
		A.setFull(true);                            // the origin is out of room
		const ok = await A.destroy(CHATS, 'chatX');
		if (BREAK !== 'swallow') {
			check('the tombstone is durable in IDB', A.durable(CHATS, 'chatX'), 'not recorded');
			check('and visible to the rail (overlay), so the row is dropped', A.railHas(CHATS, 'chatX') === false);
			A.reload();                              // bootTombs rebuilds from IDB
			check('after reload the chat is STILL gone (no resurrection from disk)',
				A.railHas(CHATS, 'chatX') === false, 'the row came back');
			check('destroy reported success', ok === true);
		} else {
			check('BROKEN: the tomb was NOT recorded durably', A.durable(CHATS, 'chatX') === false);
			check('BROKEN: the rail shows the chat again after reload (RESURRECTED)',
				(A.reload(), A.railHas(CHATS, 'chatX') === true), 'expected resurrection under the swallow');
		}
	}

	console.log('\ntombdurable: behavioural -- the deletion travels and sticks on the peer');
	{
		const A = makeDevice(BREAK === 'swallow');
		const B = makeDevice(BREAK === 'swallow');
		// B holds the chat (a live rail row). A deletes it under quota, then pushes.
		A.setFull(true);
		await A.destroy(CHATS, 'chatY');
		const parcel = A.tombMapNow(CHATS);         // what collect packs into the parcel
		if (BREAK !== 'swallow') {
			check('A parcel carries the tombstone despite the full localStorage', parcel['chatY'] !== undefined);
			await B.receive(CHATS, parcel);
			check('B recorded the peer deletion durably', B.durable(CHATS, 'chatY'), 'in memory only');
			B.reload();
			check('B still has the chat gone after reload (not rebuilt on next list)',
				B.railHas(CHATS, 'chatY') === false, 'B resurrected the chat');
		} else {
			check('BROKEN: A parcel is EMPTY, so the deletion never travels', parcel['chatY'] === undefined);
			await B.receive(CHATS, parcel);
			B.reload();
			check('BROKEN: B still shows the chat (resurrects from the peer)', B.railHas(CHATS, 'chatY') === true);
		}
	}

	console.log('\ntombdurable: behavioural -- with ROOM, a delete is refused by nothing and stays gone');
	{
		const A = makeDevice(BREAK === 'swallow');   // localStorage has room
		const ok = await A.destroy(CHATS, 'chatZ');
		check('destroy succeeds', ok === true);
		A.reload();
		check('the chat stays gone across a reload', A.railHas(CHATS, 'chatZ') === false);
		if (BREAK !== 'swallow') check('no storage alarm was raised with room to spare', A.alarms() === 0);
	}
}

async function main() {
	sourceGuards();
	await behavioural();
	console.log('');
	if (BREAK) {
		console.log('(--break ' + BREAK + ': the failures above are the point — the resurrection bug is reproduced)');
		// A break that reddens nothing is itself a failure.
		process.exit(failures > 0 ? 0 : 1);
	}
	if (failures) { console.log(failures + ' of ' + checks + ' checks FAILED'); process.exit(1); }
	console.log('all ' + checks + ' checks ok');
}

main().catch((e) => { console.error(e); process.exit(1); });
