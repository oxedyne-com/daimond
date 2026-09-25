/* durable.js — a roomy per-account key-value store on IndexedDB.
 *
 * localStorage is a ~5 MiB box per origin, shared by the mailbox, the ledger, the
 * trash and every other module. The cloud index (`daimond-cloud-index`) lived in
 * it, and when the box fills the ONE write a commit depends on cannot land: a large
 * Diamond is then held or rides inline, no chunk is declared, and cross-device sync
 * pauses with nothing to free the box (S-SYNC #2). IndexedDB's origin quota is
 * measured in hundreds of megabytes and is not shared with those tenants, so the
 * index moves here and stops competing for the small box.
 *
 * Namespaced per account exactly as journal.js is: the primary account uses the
 * bare DB name, every other its own `-d~<id>` suffix (accounts.js `opfsNs`), so no
 * account can read another's store.
 *
 * When IndexedDB is absent or refuses to open — private mode, an old WebKit — this
 * falls back to localStorage with the semantics the callers had before, so a device
 * with no IndexedDB is no worse off than it was. `durable()` says which path is
 * live, and a caller that needs the old synchronous quota semantics (cloud.js) reads
 * it and keeps its own localStorage path when the answer is no.
 */
(function () {
	'use strict';

	var DB_BASE = 'daimond-kv';
	var STORE   = 'kv';
	var VERSION = 1;

	var db      = null;
	var dbOpen  = null;		// the name db is open on, to notice an account switch
	var idbOk   = false;	// IndexedDB present and open: the durable path is live
	var readyP  = null;

	function idb() {
		try { return window.indexedDB || null; } catch (e) { return null; }
	}

	// Per account, via the same namespace the rest of storage uses (journal.js:41).
	function dbName() {
		var ns = '';
		try { ns = (window.DaimondAccounts && DaimondAccounts.opfsNs()) || ''; } catch (e) { ns = ''; }
		return ns ? DB_BASE + '-' + ns : DB_BASE;
	}

	function open(name) {
		return new Promise(function (resolve, reject) {
			var req = idb().open(name, VERSION);
			req.onupgradeneeded = function () {
				var d = req.result;
				if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE);
			};
			req.onsuccess = function () { resolve(req.result); };
			req.onerror   = function () { reject(req.error); };
		});
	}

	/// Open the store, once. Idempotent: every caller awaits the one open, and a
	/// device with no IndexedDB settles into the localStorage fallback here.
	function ready() {
		if (readyP) return readyP;
		readyP = (async function () {
			var want = dbName();
			if (db && dbOpen === want) return;
			var ix = idb();
			if (!ix) { idbOk = false; return; }
			try {
				db = await open(want);
				dbOpen = want;
				idbOk = true;
				// A tab that dies mid-transaction leaves the connection unusable; drop
				// the handle so a later call reopens (journal.js's reasoning).
				db.onclose = function () { db = null; dbOpen = null; idbOk = false; readyP = null; };
				db.onversionchange = function () { try { db.close(); } catch (e) { /* already */ } db = null; dbOpen = null; idbOk = false; readyP = null; };
			} catch (e) { db = null; dbOpen = null; idbOk = false; }
		})();
		return readyP;
	}

	/// Is the durable (IndexedDB) path live? False before `ready()`, and in the
	/// localStorage fallback — private mode, or an IndexedDB that would not open.
	function durable() { return idbOk && !!db; }

	async function get(key) {
		await ready();	// reopen a dropped connection before falling back to the box
		if (!durable()) return readJson(key);
		return new Promise(function (resolve) {
			try {
				var rq = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
				rq.onsuccess = function () { resolve(rq.result === undefined ? null : rq.result); };
				rq.onerror   = function () { resolve(null); };
			} catch (e) { resolve(null); }
		});
	}

	/// Write `val` under `key`, resolving TRUE only once the transaction has
	/// committed. Never throws — a full disk or a dead connection resolves false, so
	/// a caller can hold its durability flag exactly as a quota failure did.
	async function set(key, val) {
		await ready();	// reopen a dropped connection so a write lands in IndexedDB, not the box
		if (!durable()) return writeJson(key, val);
		return new Promise(function (resolve) {
			var done = false, ok = false;
			function settle(v) { if (!done) { done = true; resolve(v); } }
			try {
				var tx = db.transaction(STORE, 'readwrite');
				tx.oncomplete = function () { settle(ok); };
				tx.onerror    = function () { settle(false); };
				tx.onabort    = function () { settle(false); };
				var rq = tx.objectStore(STORE).put(val, key);
				rq.onsuccess = function () { ok = true; };
				rq.onerror   = function () { ok = false; };
			} catch (e) { settle(false); }
		});
	}

	/// Read `key`, hand it to `fn` and store what `fn` answers, in ONE readwrite
	/// transaction, resolving `{ ok, value }` with `ok` true only once it has committed.
	///
	/// A map written whole from each tab's own copy is a map in which the last tab to
	/// write erases what its siblings wrote since it last read: that was SIM-24, a file
	/// written in one tab and gone after the leader tab's next index write. IndexedDB
	/// runs readwrite transactions on one store one at a time, so a change joined into
	/// the stored map here cannot be lost to a sibling's (dev/SYNC_CONTRACT.md §6: "a
	/// local write is a merge too"). `fn` must be synchronous. In the localStorage
	/// fallback the read and the write are one synchronous step, which is the same thing.
	async function update(key, fn) {
		await ready();
		if (!durable()) {
			var v = fn(readJson(key));
			return { ok: writeJson(key, v), value: v };
		}
		return new Promise(function (resolve) {
			var done = false, ok = false, next = null;
			function settle(v) { if (!done) { done = true; resolve({ ok: v, value: v ? next : null }); } }
			try {
				var tx = db.transaction(STORE, 'readwrite');
				var st = tx.objectStore(STORE);
				tx.oncomplete = function () { settle(ok); };
				tx.onerror    = function () { settle(false); };
				tx.onabort    = function () { settle(false); };
				var rq = st.get(key);
				rq.onsuccess = function () {
					try { next = fn(rq.result === undefined ? null : rq.result); }
					catch (e) { try { tx.abort(); } catch (e2) { /* already over */ } return; }
					var wq = st.put(next, key);
					wq.onsuccess = function () { ok = true; };
					wq.onerror   = function () { ok = false; };
				};
				rq.onerror = function () { try { tx.abort(); } catch (e) { /* already over */ } };
			} catch (e) { settle(false); }
		});
	}

	async function del(key) {
		await ready();
		if (!durable()) { try { localStorage.removeItem(key); } catch (e) { /* best effort */ } return true; }
		return new Promise(function (resolve) {
			try {
				var tx = db.transaction(STORE, 'readwrite');
				tx.oncomplete = function () { resolve(true); };
				tx.onerror    = function () { resolve(false); };
				tx.onabort    = function () { resolve(false); };
				tx.objectStore(STORE).delete(key);
			} catch (e) { resolve(false); }
		});
	}

	/// Move a localStorage value into the durable store, and remove the localStorage
	/// key ONLY after the write has committed — which is what frees the box that
	/// jammed. Loss-free: the localStorage copy stays the sole copy until IndexedDB
	/// holds it, so a write that throws loses nothing. A no-op in the fallback, where
	/// localStorage IS the store.
	async function migrate(key) {
		await ready();
		if (!durable()) return false;
		var raw = null;
		try { raw = localStorage.getItem(key); } catch (e) { raw = null; }
		if (raw == null) return false;
		// Already migrated on an earlier boot, and the box still holds a stale copy:
		// the durable store is authoritative, so drop the box's copy without a write.
		var existing = await get(key);
		if (existing != null && typeof existing === 'object') {
			try { localStorage.removeItem(key); } catch (e) { /* best effort */ }
			return true;
		}
		var val;
		try { val = JSON.parse(raw); } catch (e) { return false; }
		var ok = await set(key, val);
		if (ok) { try { localStorage.removeItem(key); } catch (e) { /* best effort */ } }
		return ok;
	}

	// ── localStorage fallback ──────────────────────────────────
	// Used only when IndexedDB will not open. Same shape as cloud.js's own pair, so
	// a fallback tenant keeps the semantics it had before this store existed.
	function readJson(key) {
		try { return JSON.parse(localStorage.getItem(key) || 'null'); }
		catch (e) { return null; }
	}
	function writeJson(key, val) {
		try { localStorage.setItem(key, JSON.stringify(val)); return true; }
		catch (e) { return false; }
	}

	window.DaimondDurable = {
		ready:   ready,
		durable: durable,
		get:     get,
		set:     set,
		update:  update,
		del:     del,
		migrate: migrate,
	};
})();
