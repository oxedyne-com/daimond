/* ============================================================
   Test — a manifest write lost to quota does not strand content
   (S-SYNC #2, the frozen-index committer).
   ------------------------------------------------------------
   Drives the REAL www/js/cloud.js, the REAL DaimondCore.parcelRefs
   (lifted out of daimond.js by source), and the REAL
   www/js/chunks.js `commit`, over one localStorage that runs out of
   room mid-collect.

   THE BUG. `cloud.js writeJson` returns false on quota and every
   caller ignored it. A chat over the inline threshold offloads its
   transcript to chunks, and the collector records the manifest with
   `contentSet` -- but if that index write is lost to quota, the
   parcel still carries a `messagesRef` naming the uploaded chunks,
   while `state.chunked` (the index the ONE commit declares live) does
   not. The gateway sweeps every chunk the committed index does not
   name, so the far device gets an EMPTY chat, re-swept every round.

   THE FIX, in three real pieces this file exercises:
     1. cloud.js remembers a lost index write: `contentSet` returns
        false and `indexDurable()` goes false until a write lands
        (`--break ignorequota` reverts `setIndex` to the old
        always-true and reddens this).
     2. DaimondCore.parcelRefs(state) = the index UNION every
        `messagesRef`/`dataRef`/`msgRef` the parcel names, so the
        committed live set can never omit an address the parcel points
        at (`--break noindexrefs` reverts it to the index alone).
     3. chunks.js `commit` declares every address in the map it is
        given, so committing `parcelRefs` names the stranded chunk
        live where committing the bare index would have swept it.

   THE ROOT FIX (S-SYNC #2, part 2). The strand above is DETECTED and
   belted, but a device whose ~5 MiB localStorage box is full still
   cannot write ANY index, so a large Diamond is held for ever and
   nothing frees the box. The index therefore LEFT the box: it lives in
   IndexedDB (durable.js), whose origin quota is hundreds of megabytes
   and is not shared with the mailbox or the ledger. Section 4 drives
   the REAL durable.js + cloud.js over a fake IndexedDB and a full box
   and proves the four new facts:
     - migrate() moves the index into IndexedDB and frees the box,
       removing the localStorage key ONLY after the write commits.
     - with the box full, contentSet still lands and the content rides
       by reference; indexDurable() is true after settle() (this is
       IMPOSSIBLE without the fix — `--break nodurable`).
     - a durable write clears the storage alarm (`--break noalarmclear`).
     - a lost durable write raises the alarm and holds indexDurable()
       false, and migrate() loses nothing if the write throws
       (`--break migrateearly`).

   A MID-SESSION IndexedDB DROP (Safari eviction) must not empty the index:
   durable.js reopens on the next op and cloud.js serves its sticky in-memory
   cache, so a dropped connection never rebuilds the index from the emptied box
   and sweeps cloud-only files. Section 5 forces an `onclose` and proves it
   (`--break nostickyread` reads the box back; `--break noreopen` resurrects it).

   Run:   node www/js/quotamanifest.test.mjs
          node www/js/quotamanifest.test.mjs --break ignorequota
          node www/js/quotamanifest.test.mjs --break noindexrefs
          node www/js/quotamanifest.test.mjs --break nodurable
          node www/js/quotamanifest.test.mjs --break migrateearly
          node www/js/quotamanifest.test.mjs --break noalarmclear
          node www/js/quotamanifest.test.mjs --break noreopen
          node www/js/quotamanifest.test.mjs --break nostickyread
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadStore } from './storefixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(name, cond, detail) {
	const line = name + (detail !== undefined && detail !== '' ? ' — ' + detail : '');
	if (cond) { console.log('  ok   ' + line); }
	else { console.log('  FAIL ' + line); failures++; }
}

const KNOWN = ['ignorequota', 'noindexrefs', 'nodurable', 'migrateearly', 'noalarmclear', 'noreopen', 'nostickyread'];
const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return (i >= 0 && process.argv[i + 1]) ? process.argv[i + 1] : '';
})();
if (BREAK && !KNOWN.includes(BREAK)) {
	console.error('unknown break ' + JSON.stringify(BREAK) + '; known: ' + KNOWN.join(', '));
	process.exit(2);
}

// ── A localStorage with a quota that can be turned on and off ──────
// `full` makes every write throw, as a browser does at the quota. It models the
// growing case that matters here: the index is ONE key that gets larger as a
// manifest is added, so the over-write no longer fits and is refused whole -- which
// is exactly why a lost index write strands the manifest it could not record. The
// toggle makes the moment of pressure deterministic; a read always works.
function makeStorage() {
	const store = new Map();
	let full = false;
	return {
		api: {
			getItem:    (k) => (store.has(k) ? store.get(k) : null),
			setItem:    (k, v) => {
				if (full) {
					const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e;
				}
				store.set(k, String(v));
			},
			removeItem: (k) => store.delete(k),
		},
		setFull: (v) => { full = v; },
		store,
	};
}

/// One simulated tab holding cloud.js, the peer.test.mjs / peerkey.test.mjs pattern.
function makeCloudTab(storageApi) {
	let body = readFileSync(join(HERE, 'cloud.js'), 'utf8');
	if (BREAK === 'ignorequota') {
		// The bug: `setIndex` never remembers a write it could not land, so
		// `contentSet` always answers true and `indexDurable()` never goes false.
		const needle = 'var ok = window.DaimondStore.put(IX_KEY, ix || {});\n\t\tif (ok) indexDirty = null;'
			+ '\n\t\telse indexDirty = indexDirty || { at: Date.now() };\n\t\treturn ok;';
		if (!body.includes(needle)) throw new Error('break target not found: setIndex tracking');
		body = body.replace(needle,
			'window.DaimondStore.put(IX_KEY, ix || {});\n\t\treturn true; // BROKEN: quota forgotten');
	}
	const win = { addEventListener: () => {}, dispatchEvent: () => true };
	const fn = new Function(
		'window', 'localStorage', 'navigator', 'setTimeout', 'clearTimeout', 'console',
		'with (window) {\n' + body + '\n}');
	loadStore(win, storageApi);
	fn(win, storageApi, { storage: {} }, setTimeout, clearTimeout,
		{ log: () => {}, debug: () => {}, warn: () => {}, error: () => {} });
	return win.DaimondCloud;
}

/// The REAL `parcelRefs` from daimond.js, lifted out by source so the test drives
/// the shipped function rather than a copy of it. `--break noindexrefs` swaps in
/// the frozen-index behaviour -- the committed set is the index alone.
function loadParcelRefs() {
	if (BREAK === 'noindexrefs') {
		return function parcelRefs(state) {
			// BROKEN: the index alone, so a ref the index never recorded is omitted.
			const out = {};
			if (state && state.chunked) Object.keys(state.chunked).forEach((k) => { out[k] = state.chunked[k]; });
			return out;
		};
	}
	const src = readFileSync(join(HERE, 'daimond.js'), 'utf8');
	const start = src.indexOf('\tfunction parcelRefs(state) {');
	if (start < 0) throw new Error('parcelRefs not found in daimond.js');
	// The function body ends at the first line that is exactly a tab + `}`.
	const end = src.indexOf('\n\t}\n', start);
	if (end < 0) throw new Error('parcelRefs end not found');
	const text = src.slice(start, end + 3);
	// eslint-disable-next-line no-new-func
	return new Function(text + '\nreturn parcelRefs;')();
}

/// A tab holding the REAL chunks.js `commit`, with the gateway mocked so the test
/// can read back exactly which addresses the commit declared live.
function makeChunksTab() {
	const body = readFileSync(join(HERE, 'chunks.js'), 'utf8');
	let lastCommit = null;
	const gateway = {
		clientApi: () => 1,
		gwFetch: async (_path, opts) => {
			const b = JSON.parse(opts.body);
			if (b.op === 'commit') lastCommit = b;
			return { status: 200, json: async () => ({ ok: true, swept: 0, free_allowance: 0 }) };
		},
	};
	// chunks.js touches `document` on boot (the status chip) and `DaimondI18n`; a
	// document whose lookups all answer null makes `chip()` return null and the
	// boot draw a no-op, which is all this test needs.
	const doc = { getElementById: () => null, querySelector: () => null,
		createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {},
			addEventListener: () => {}, querySelector: () => null }),
		head: { appendChild: () => {} }, body: { appendChild: () => {} } };
	const win = { addEventListener: () => {}, dispatchEvent: () => true,
		DaimondGateway: gateway, document: doc };
	const fn = new Function(
		'window', 'document', 'DaimondGateway', 'localStorage', 'setTimeout', 'clearTimeout', 'console', 'crypto',
		'with (window) {\n' + body + '\n}');
	const ls = makeStorage().api;
	fn(win, doc, gateway, ls, setTimeout, clearTimeout,
		{ log: () => {}, debug: () => {}, warn: () => {}, error: () => {} }, { subtle: {} });
	return { commit: win.DaimondChunks.commit, lastCommit: () => lastCommit };
}

// ── A minimal, async IndexedDB ────────────────────────────────────
// Enough of the shape durable.js uses: open (with onupgradeneeded on a fresh db),
// one object store backed by a Map, and get/put/delete over a real transaction that
// fires oncomplete/onabort a tick later, so the async commit is modelled honestly.
// `setFailWrites` makes every put abort, as a full disk does — the case that proves
// migrate() loses nothing and the durability gate still bites.
function makeIndexedDB() {
	const dbs = new Map();		// name -> Map(store -> Map(key -> val))
	let failWrites = false;
	let lastDb = null;		// the most recently opened connection, so a test can drop it (Safari eviction)
	const soon = (fn) => setTimeout(fn, 0);
	function makeDb(name) {
		if (!dbs.has(name)) dbs.set(name, new Map());
		const stores = dbs.get(name);
		return {
			objectStoreNames: { contains: (s) => stores.has(s) },
			createObjectStore: (s) => { stores.set(s, new Map()); return {}; },
			close: () => {},
			transaction: (sname) => {
				const data = stores.get(sname);
				const tx = { oncomplete: null, onerror: null, onabort: null, objectStore: null };
				// A transaction completes once its LAST request has, as IndexedDB's does: a
				// request issued from another's onsuccess (durable.js `update` reads, then
				// writes) belongs to the same transaction.
				let open = 0, over = false;
				const request = (work) => {
					const rq = { onsuccess: null, onerror: null, result: undefined };
					open++;
					soon(() => {
						if (over) return;
						open--;
						if (work(rq) === false) {
							over = true;
							if (rq.onerror) rq.onerror();
							if (tx.onabort) tx.onabort();
							return;
						}
						if (rq.onsuccess) rq.onsuccess();
						soon(() => { if (!over && open === 0) { over = true; if (tx.oncomplete) tx.oncomplete(); } });
					});
					return rq;
				};
				const os = {
					get: (k) => request((rq) => { rq.result = data.has(k) ? data.get(k) : undefined; }),
					put: (v, k) => request(() => { if (failWrites) return false; data.set(k, v); }),
					delete: (k) => request(() => { data.delete(k); }),
				};
				tx.objectStore = () => os;
				return tx;
			},
		};
	}
	return {
		api: {
			open: (name) => {
				const req = { onupgradeneeded: null, onsuccess: null, onerror: null, result: null };
				soon(() => {
					const fresh = !dbs.has(name) || dbs.get(name).size === 0;
					req.result = makeDb(name);
					lastDb = req.result;	// remember the live connection so a test can drop it
					if (fresh && req.onupgradeneeded) req.onupgradeneeded();
					if (req.onsuccess) req.onsuccess();
				});
				return req;
			},
		},
		setFailWrites: (v) => { failWrites = v; },
		dropConnection: () => { if (lastDb && lastDb.onclose) lastDb.onclose(); },
	};
}

const QUIET = { log: () => {}, debug: () => {}, warn: () => {}, error: () => {} };

/// Apply the cloud.js break arms that only bite in the durable path.
function patchCloud(body) {
	if (BREAK === 'nodurable') {
		// Force the localStorage path: the index cannot leave the box, so with the
		// box full nothing lands — exactly the world before this fix.
		const needle = 'var live = !!(DaimondDurable.durable && DaimondDurable.durable());';
		if (!body.includes(needle)) throw new Error('break target not found: durable mode');
		body = body.replace(needle, 'var live = false; // BROKEN: durable path disabled');
	}
	if (BREAK === 'nostickyread') {
		// Revert the sticky read: index() re-checks the momentary connection, so after a
		// drop it reads the emptied box and rebuilds the index from nothing.
		const needle = 'function index() { return _durableMode ? _ix : readJson(IX_KEY, {}); }';
		if (!body.includes(needle)) throw new Error('break target not found: sticky index');
		body = body.replace(needle,
			'function index() { return (_durableMode && window.DaimondDurable && DaimondDurable.durable && DaimondDurable.durable()) ? _ix : readJson(IX_KEY, {}); } // BROKEN: momentary read');
	}
	if (BREAK === 'noalarmclear') {
		const needle = 'if (landed) { indexDirty = null; alarmClear(); }';
		if (!body.includes(needle)) throw new Error('break target not found: alarmClear');
		body = body.replace(needle, 'if (landed) { indexDirty = null; /* BROKEN: alarm not cleared */ }');
	}
	return body;
}

/// Apply the durable.js break arm.
function patchDurable(body) {
	if (BREAK === 'noreopen') {
		// Revert the reopen: onclose drops the handle but leaves the resolved readyP, so
		// a later op never reopens and a write falls back to the (emptied) box.
		const needle = 'db.onclose = function () { db = null; dbOpen = null; idbOk = false; readyP = null; };';
		if (!body.includes(needle)) throw new Error('break target not found: onclose reopen');
		body = body.replace(needle, 'db.onclose = function () { db = null; dbOpen = null; idbOk = false; }; // BROKEN: no reopen');
	}
	if (BREAK === 'migrateearly') {
		// Free the box BEFORE the write commits: a write that then throws has lost the
		// only copy of the index.
		const needle = 'var ok = await set(key, val);\n\t\tif (ok) { try { localStorage.removeItem(key); } catch (e) { /* best effort */ } }\n\t\treturn ok;';
		if (!body.includes(needle)) throw new Error('break target not found: migrate order');
		body = body.replace(needle,
			'try { localStorage.removeItem(key); } catch (e) {} // BROKEN: box freed before the commit\n\t\tvar ok = await set(key, val);\n\t\treturn ok;');
	}
	return body;
}

/// One tab holding the REAL durable.js and cloud.js over the fake IndexedDB, so
/// cloud.js sees `window.DaimondDurable` and backs the index on it. `core` stands in
/// for daimond.js's storage alarm, so a test can watch it raised and cleared.
function makeDurableCloudTab(storage, idbApi, core) {
	const win = { addEventListener: () => {}, dispatchEvent: () => true,
		indexedDB: idbApi, DaimondCore: core };
	const nav = { storage: {} };
	const run = (src) => {
		const fn = new Function('window', 'localStorage', 'navigator', 'setTimeout', 'clearTimeout', 'console',
			'with (window) {\n' + src + '\n}');
		fn(win, storage.api, nav, setTimeout, clearTimeout, QUIET);
	};
	run(readFileSync(join(HERE, 'store.js'), 'utf8'));
	run(patchDurable(readFileSync(join(HERE, 'durable.js'), 'utf8')));
	run(patchCloud(readFileSync(join(HERE, 'cloud.js'), 'utf8')));
	return win.DaimondCloud;
}

// Two chunk addresses: one the index will name, one only the parcel will (the
// stranded transcript's).
const ADDR_INDEXED  = 'aa'.repeat(32);
const ADDR_STRANDED = 'bb'.repeat(32);

async function main() {
	// ── 1. cloud.js remembers a lost index write ──────────────────
	const s = makeStorage();
	const C = makeCloudTab(s.api);

	// Room to spare: an ordinary offload records its manifest and the index is durable.
	check('1a. a normal contentSet lands', C.contentSet('@c/ok', { v: 2, size: 4, key: 'k1',
		chunks: [{ addr: ADDR_INDEXED, size: 4 }], fp: 'f1' }) === true);
	check('1b. and the index is durable', C.indexDurable() === true);

	// Now the store is full: the chat offloaded (chunks uploaded) but the index write
	// cannot land.
	s.setFull(true);
	const landed = C.contentSet('@c/strand', { v: 2, size: 4, key: 'k2',
		chunks: [{ addr: ADDR_STRANDED, size: 4 }], fp: 'f2' });
	check('1c. contentSet reports the lost write', landed === false);
	check('1d. indexDurable() goes false', C.indexDurable() === false);
	// Since release 5 the refused index is held owed in the tab (store.js), so this
	// tab still names the manifest -- and the box does not, and the commit stays gated
	// on `indexDurable()` until the write lands (1d).
	check('1e. the un-written manifest is held owed here, not in the box',
		!!C.index()['@c/strand'] && !String(s.api.getItem('daimond-cloud-index') || '').includes('@c/strand'),
		'@c/strand ' + (C.index()['@c/strand'] ? 'held' : 'absent') + ', box ' + (String(s.api.getItem('daimond-cloud-index') || '').includes('@c/strand') ? 'has it' : 'has not'));

	// Space is freed: the collector retries, the write lands, durability returns.
	s.setFull(false);
	const relanded = C.contentSet('@c/strand', { v: 2, size: 4, key: 'k2',
		chunks: [{ addr: ADDR_STRANDED, size: 4 }], fp: 'f2' });
	check('1f. the write lands once there is room', relanded === true);
	check('1g. indexDurable() recovers', C.indexDurable() === true);

	// ── 2. parcelRefs unions the parcel's own references ──────────
	const parcelRefs = loadParcelRefs();

	// The quota moment, as the parcel sees it: `state.chunked` is the durable index,
	// which took `@c/ok` but LOST `@c/strand`; the parcel still carries the stranded
	// chat as a `messagesRef`. This is the frozen-index committer's exact state.
	const frozenIndex = { '@c/ok': { v: 2, size: 4, key: 'k1',
		chunks: [{ addr: ADDR_INDEXED, size: 4 }] } };
	const state = {
		chunked: frozenIndex,
		chats: [
			{ id: 'ok',     messagesRef: { v: 2, size: 4, key: 'k1', chunks: [{ addr: ADDR_INDEXED, size: 4 }] } },
			{ id: 'strand', messagesRef: { v: 2, size: 4, key: 'k2', chunks: [{ addr: ADDR_STRANDED, size: 4 }] } },
		],
		diamonds: [],
		post: null,
	};
	const live = parcelRefs(state);
	const liveAddrs = new Set();
	Object.keys(live).forEach((k) => (live[k].chunks || []).forEach((c) => liveAddrs.add(c.addr)));
	check('2a. parcelRefs keeps the index it was given', liveAddrs.has(ADDR_INDEXED));
	check('2b. parcelRefs adds the stranded ref the index lost', liveAddrs.has(ADDR_STRANDED),
		'the parcel names @c/strand; the committed set must too');

	// The fixed point: when the index IS durable (it names every ref), parcelRefs is
	// the index unchanged, so a quiet round commits byte-identically.
	const durableIndex = {
		'@c/ok':     { v: 2, size: 4, key: 'k1', chunks: [{ addr: ADDR_INDEXED, size: 4 }] },
		'@c/strand': { v: 2, size: 4, key: 'k2', chunks: [{ addr: ADDR_STRANDED, size: 4 }] },
	};
	const durableState = { chunked: durableIndex, chats: state.chats, diamonds: [], post: null };
	const durableLive = parcelRefs(durableState);
	check('2c. a durable round is the index unchanged (fixed point)',
		JSON.stringify(durableLive) === JSON.stringify(durableIndex));

	// ── 3. commit declares the union live, not the bare index ─────
	const chunks = makeChunksTab();

	await chunks.commit(live, 1, null);
	const committed = new Set((chunks.lastCommit().chunks || []).map((e) => e.addr));
	check('3a. the commit declares the stranded chunk live', committed.has(ADDR_STRANDED),
		'committing parcelRefs must name every address the parcel points at');
	check('3b. and the indexed chunk', committed.has(ADDR_INDEXED));

	// The contrast that shows the belt matters: committing the FROZEN INDEX alone
	// omits the stranded address, which is the deletion the fix prevents.
	await chunks.commit(frozenIndex, 1, null);
	const indexOnly = new Set((chunks.lastCommit().chunks || []).map((e) => e.addr));
	check('3c. committing the bare index would have OMITTED the stranded chunk',
		!indexOnly.has(ADDR_STRANDED),
		'this is the sweep the parcelRefs belt prevents');

	// ── 4. the index lives in IndexedDB, off the box (the root fix) ─
	const ADDR_OLD = 'cc'.repeat(32), ADDR_BIG = 'dd'.repeat(32);
	const OLD_IX = { '@c/old': { v: 2, size: 4, key: 'k0', chunks: [{ addr: ADDR_OLD, size: 4 }] } };

	// 4a–f: migrate frees the box, and a write lands with the box full.
	{
		const s4 = makeStorage();
		let raised = 0, cleared = 0;
		const core = { noteCloudIndexStuck: () => { raised++; }, clearStorageAlarm: () => { cleared++; } };
		s4.store.set('daimond-cloud-index', JSON.stringify(OLD_IX));	// a device upgrading from the LS era
		const D = makeDurableCloudTab(s4, makeIndexedDB().api, core);
		await D.ready();

		check('4a. migrate removes the LS index key — the box is freed',
			s4.store.get('daimond-cloud-index') === undefined);
		check('4b. and the migrated index is intact in the durable store',
			!!D.index()['@c/old']);

		s4.setFull(true);	// the box is now full: a localStorage index write would be refused
		const landed = D.contentSet('@d/big', { v: 2, size: 4, key: 'kb',
			chunks: [{ addr: ADDR_BIG, size: 4 }], touched: 1 });
		check('4c. contentSet lands with the box full — the Diamond rides by reference',
			landed === true, 'impossible without the fix: the box is jammed');
		await D.settle();
		check('4d. indexDurable() is true once the write settles', D.indexDurable() === true);
		check('4e. the durable write cleared the storage alarm', cleared > 0);
		check('4f. and the index never touched the full box', s4.store.get('daimond-cloud-index') === undefined);
	}

	// 4g: a migrate whose IDB write throws keeps the box copy — loss-free.
	{
		const s5 = makeStorage();
		const idb5 = makeIndexedDB();
		idb5.setFailWrites(true);	// every IDB put aborts, as a full disk does
		s5.store.set('daimond-cloud-index', JSON.stringify(OLD_IX));
		const D = makeDurableCloudTab(s5, idb5.api, { noteCloudIndexStuck: () => {}, clearStorageAlarm: () => {} });
		await D.ready();
		check('4g. migrate keeps the LS key when the IDB write fails — nothing is lost',
			s5.store.get('daimond-cloud-index') !== undefined);
		check('4h. and the index is still readable this session', !!D.index()['@c/old']);
	}

	// 4i–j: a lost durable write raises the alarm and holds the commit gate shut.
	{
		const s6 = makeStorage();
		const idb6 = makeIndexedDB();
		let raised = 0;
		const D = makeDurableCloudTab(s6, idb6.api, { noteCloudIndexStuck: () => { raised++; }, clearStorageAlarm: () => {} });
		await D.ready();
		idb6.setFailWrites(true);	// the disk fills after boot
		D.contentSet('@d/x', { v: 2, size: 4, key: 'kx', chunks: [{ addr: 'ee'.repeat(32), size: 4 }], touched: 1 });
		await D.settle();
		check('4i. a lost durable write raises the storage alarm', raised > 0);
		check('4j. and holds indexDurable() false, so no commit sweeps', D.indexDurable() === false);
	}

	// ── 5. a mid-session IndexedDB drop does not empty the index (finding #1) ─
	// Safari closes IndexedDB connections under memory pressure. durable.js dropped the
	// handle on `onclose` but never reopened (it kept a resolved `readyP`, and get/set
	// fell straight to the box), and cloud.js then read the index back from the box that
	// migrate() had emptied — an empty index whose commit sweeps every cloud-only file.
	// The fix: durable.js reopens on the next op, and cloud.js serves the sticky
	// in-memory cache, never the emptied box.
	{
		const s7 = makeStorage();
		const idb7 = makeIndexedDB();
		s7.store.set('daimond-cloud-index', JSON.stringify(OLD_IX));
		const D = makeDurableCloudTab(s7, idb7.api, { noteCloudIndexStuck: () => {}, clearStorageAlarm: () => {} });
		await D.ready();
		check('5a. after migration the index is served from IndexedDB', !!D.index()['@c/old']);
		check('5b. and the box was freed', s7.store.get('daimond-cloud-index') === undefined);

		idb7.dropConnection();	// Safari evicts the connection mid-session
		check('5c. index() still names the migrated content after the drop, not the emptied box',
			!!D.index()['@c/old'], 'the empty-index rebuild that swept cloud-only chunks (--break nostickyread)');

		const landed = D.contentSet('@d/after', { v: 2, size: 4, key: 'ka',
			chunks: [{ addr: 'ff'.repeat(32), size: 4 }], touched: 1 });
		check('5d. a write after the drop rides by reference', landed === true);
		await D.settle();
		check('5e. and lands durably once the connection reopens', D.indexDurable() === true);
		check('5f. without resurrecting the index in the box (--break noreopen)',
			s7.store.get('daimond-cloud-index') === undefined);
	}

	console.log('');
	if (BREAK) {
		console.log('(--break ' + BREAK + ': the failures above are the point — the bug is reproduced)');
		process.exit(failures > 0 ? 0 : 1);	// a break that reddens nothing is itself a failure
	}
	if (failures) { console.log(failures + ' FAILED'); process.exit(1); }
	console.log('all ok');
	// cloud.js opens its tabs' BroadcastChannel at `ready`, which in node would hold the process open.
	process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
