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
 * with no IndexedDB is no worse off than it was. Only a device whose store never opened:
 * once a connection has opened on this device, in any page, `migrate` may have emptied the
 * box, and the next boot's `migrate` drops a box copy unread, so an open that fails is a
 * read or write that did not land, never one the box answers. A marker in the box records
 * the first connection; a device that predates the marker is known by the store itself
 * (below). `durable()` says which path is
 * live, and a caller that needs the old synchronous quota semantics (cloud.js) reads
 * it and keeps its own localStorage path when the answer is no.
 */
(function () {
	'use strict';

	var DB_BASE = 'daimond-kv';
	var STORE   = 'kv';
	// v2: values in bounded pieces (below). An older build asks for v1, gets VersionError
	// and falls back to the box rather than misread the pieces; an open older tab is
	// sent `versionchange` by the upgrade and closes.
	var VERSION = 2;

	var db      = null;
	var dbOpen  = null;		// the name db is open on, to notice an account switch
	var idbOk   = false;	// IndexedDB present and open: the durable path is live
	var opened  = false;	// a connection has opened on this device: the box is no longer the store
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

	function marker(name) { return name + '-took'; }
	function took(name) {
		try { return localStorage.getItem(marker(name)) === '1'; } catch (e) { return false; }
	}
	// A box too full to take it is retried by `migrate` once it has freed the box.
	function mark(name) {
		try { localStorage.setItem(marker(name), '1'); } catch (e) { /* the store's own evidence stands */ }
	}

	/// Has a connection opened on this device before, as far as the refusal `e` and the
	/// browser's list of stores can tell? An older build kept no marker. With no list to ask,
	/// any refusal is taken as a store that opened (an older tab holding the upgrade, a newer
	/// version, a store that does not answer or errors: a marker cleared with the box alone,
	/// Firefox before 126), since a box written over a store that has taken over is lost at
	/// the next boot; unless the error refuses IndexedDB outright, as private mode does.
	async function heldBefore(name, e) {
		var ix = idb();
		if (ix && typeof ix.databases === 'function') {
			try {
				var list = await window.DaimondStoreWait.bounded(Promise.resolve(ix.databases()), 'listing the stores');
				return (list || []).some(function (d) { return d && d.name === name; });
			} catch (x) { /* no answer: as if there were no list */ }
		}
		return !!e && e.name !== 'InvalidStateError' && e.name !== 'SecurityError';
	}

	// A tab frozen at the older version never answers `versionchange`, so the upgrade waits
	// on it: the open refuses, and this tab stays on the box until a reload.
	function open(name) {
		return window.DaimondStoreWait.open(name, VERSION, function (d, ev) {
			if (!d.has(STORE)) { d.create(STORE); return; }
			if (ev.oldVersion < 2) toPieces(d.store(STORE));
		}, 'opening the cloud index');
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
				opened = true;
				mark(want);
				// A tab that dies mid-transaction leaves the connection unusable; drop
				// the handle so a later call reopens (journal.js's reasoning).
				db.ended(function () { db = null; dbOpen = null; idbOk = false; readyP = null; });
			} catch (e) {
				db = null; dbOpen = null; idbOk = false;
				opened = took(want) || await heldBefore(want, e);
				if (opened) { mark(want); readyP = null; }	// the next call tries the store again
			}
		})();
		return readyP;
	}

	/// Is the durable (IndexedDB) path live? False before `ready()`, and in the
	/// localStorage fallback — private mode, or an IndexedDB that would not open.
	function durable() { return idbOk && !!db; }

	/// Has the store taken over from the box on this device, answering or not? Settled by `ready()`.
	function tookOver() { return opened; }

	// ── Bounded pieces (PAGESTORE C) ────────────────────────────
	//
	// Chrome sends a value whose wire form is over its wrap threshold down a blob path,
	// and on Chrome 153 that commit never called back (Q1108-045). So no row here goes
	// over the policy's piece size. A value is stored as its JSON: `{ d: 1, j }` at its
	// key when it fits, else a head `{ d: 1, n }` there and `{ f }` fragments at
	// [key, i]. A map (`update`) is a head `{ d: 1, map: 1 }` and one such value per
	// entry at [key, entry] (its fragments at [key, entry, i]), so a write touches only
	// the entries it changes and a read joins them by key range. Array keys sort after
	// every string and compare element by element, so no key or entry can collide.
	var IDB_WRAP_BYTES = 65536;	// fixed: Chrome's kIDBWrapThreshold (indexeddb.mojom)

	function pieceMax() { return Math.min(window.DaimondPolicy.storePieceBytes(), IDB_WRAP_BYTES - 64); }
	function path(key) { return Array.isArray(key) ? key : [key]; }
	// fixed: [] sorts above every number and string, so this bounds every key below `key`.
	function under(key) { var p = path(key); return window.IDBKeyRange.bound(p, p.concat([[]]), true, true); }

	/// The rows that hold `val` under `key`.
	function rowsOf(key, val) {
		var json = JSON.stringify(val === undefined ? null : val);
		// fixed: V8 writes a two-byte string at two bytes a character; 64 covers the tags.
		var step = Math.max(1, Math.floor((pieceMax() - 64) / 2));
		if (json.length <= step) return [[key, { d: 1, j: json }]];
		var out = [[key, { d: 1, n: Math.ceil(json.length / step) }]];
		for (var i = 0; i * step < json.length; i++) out.push([path(key).concat([i]), { f: json.slice(i * step, (i + 1) * step) }]);
		return out;
	}

	/// The value a head and its fragments (in key order) stand for; undefined when
	/// there is none or a fragment is missing.
	function valueOf(head, frags) {
		if (!head || head.d !== 1) return undefined;
		try {
			if (typeof head.j === 'string') return JSON.parse(head.j);
			if (!frags || frags.length !== head.n) return undefined;
			return JSON.parse(frags.map(function (r) { return r.f; }).join(''));
		} catch (e) { return undefined; }
	}

	/// Every row under `range`, as `[key, value]` in key order.
	function scan(st, range) {
		var out = [];
		return st.walk(range, function (v, k) { out.push([k, v]); }).then(function () { return out; });
	}

	/// The map held as entry rows under `key`.
	function joinMap(rows) {
		var heads = {}, frags = {}, map = {};
		rows.forEach(function (r) {
			var e = r[0][1];
			if (r[0].length === 2) heads[e] = r[1];
			else (frags[e] = frags[e] || []).push(r[1]);
		});
		Object.keys(heads).forEach(function (e) {
			var v = valueOf(heads[e], frags[e]);
			if (v !== undefined) map[e] = v;
		});
		return map;
	}

	/// Read `key` within `st`'s transaction: `{ val, head }`.
	function readIn(st, key) {
		return st.get(key).then(function (head) {
			if (!(head && head.d === 1 && (head.map || head.n))) return { val: valueOf(head), head: head };
			return scan(st, under(key)).then(function (rows) {
				return { val: head.map ? joinMap(rows) : valueOf(head, rows.map(function (r) { return r[1]; })), head: head };
			});
		});
	}

	/// Put `val` under `key` within `st`'s transaction, its old fragments and entries gone.
	function putIn(st, key, val) {
		st['delete'](under(key));
		rowsOf(key, val).forEach(function (r) { st.put(r[1], r[0]); });
	}

	/// Put a map as its head and entry rows.
	function putMap(st, key, map) {
		st['delete'](under(key));
		st.put({ d: 1, map: 1 }, key);
		Object.keys(map).forEach(function (e) { putIn(st, [key, e], map[e]); });
	}

	// fixed: an array leading the key sorts above every string key and the rows under it.
	function movedKey(key) { return [[], key]; }

	function dropIn(st, key) {
		st['delete'](key);
		st['delete'](under(key));
	}

	/// The v1 store held each value whole. Rewrite every row in pieces inside the upgrade's
	/// own transaction, which no other connection can see into: an object is laid out as a
	/// map, which `get` reads back the same, and anything else as a value.
	function toPieces(st) {
		scan(st, null).then(function (rows) {
			rows.forEach(function (r) {
				var v = r[1];
				if (v && typeof v === 'object' && !Array.isArray(v)) putMap(st, r[0], v);
				else putIn(st, r[0], v);
			});
		});
	}

	/// Run `work(st)` in one transaction; resolves what it answers once the transaction
	/// commits, and rejects, with none of it landed, when it does not.
	function inTx(mode, work) {
		try {
			var w = db.watch(STORE, mode, 'using the cloud index');
			return w.run(function (store) { return work(store(STORE)); });
		} catch (e) { return Promise.reject(e); }
	}

	/// The value under `key`, or null when a committed read finds none. Rejects when the
	/// read did not land (an error, an abort, a store silent past the wait): a caller that
	/// took that for an absent key would take a busy store for an empty one.
	async function get(key) {
		await ready();	// reopen a dropped connection
		if (!durable()) {
			if (opened) throw new Error('the cloud index store would not reopen');
			return readJson(key);
		}
		var v = await inTx('readonly', function (st) {
			return readIn(st, key).then(function (r) { return r.val; });
		});
		return v === undefined ? null : v;
	}

	/// Write `val` under `key`, resolving TRUE only once the transaction has
	/// committed. Never throws — a full disk or a dead connection resolves false, so
	/// a caller can hold its durability flag exactly as a quota failure did.
	async function set(key, val) {
		await ready();	// reopen a dropped connection
		if (!durable()) return opened ? false : writeJson(key, val);
		return inTx('readwrite', function (st) { putIn(st, key, val); return true; }).catch(function () { return false; });
	}

	/// Apply `ops` (entry -> `{ v }` to hold a value, `{ del: 1 }` to drop it) to the
	/// map kept under `key`, in ONE readwrite transaction, resolving `{ ok, value }` with
	/// the whole stored map and `ok` true only once it has committed.
	///
	/// A map written whole from each tab's own copy is a map in which the last tab to
	/// write erases what its siblings wrote since it last read: that was SIM-24, a file
	/// written in one tab and gone after the leader tab's next index write. IndexedDB
	/// runs readwrite transactions on one store one at a time, so a change applied here
	/// per entry cannot be lost to a sibling's (dev/SYNC_CONTRACT.md §6: "a local write
	/// is a merge too"). In the localStorage fallback the read and the write are one
	/// synchronous step, which is the same thing.
	async function update(key, ops) {
		// Anything but an op map (a function, an array, null) is refused, so the write stays owed.
		if (!ops || typeof ops !== 'object' || Array.isArray(ops)) return { ok: false, value: null };
		// No ops writes nothing: an empty map laid at an absent key reads as one that holds everything.
		var some = Object.keys(ops).length > 0;
		await ready();
		if (!durable()) {
			if (opened) return { ok: false, value: null };
			var v = applyOps(readJson(key), ops);
			return { ok: some ? writeJson(key, v) : true, value: v };
		}
		return inTx(some ? 'readwrite' : 'readonly', function (st) {
			return readIn(st, key).then(function (r) {
				if (!some) return { ok: true, value: (r.val && typeof r.val === 'object') ? r.val : {} };
				// Held as one value until now (`set`, or `migrate` from the box): lay it out as a map.
				if (!(r.head && r.head.d === 1 && r.head.map)) putMap(st, key, (r.val && typeof r.val === 'object') ? r.val : {});
				Object.keys(ops).forEach(function (e) {
					if (ops[e].del) dropIn(st, [key, e]); else putIn(st, [key, e], ops[e].v);
				});
				return scan(st, under(key)).then(function (rows) { return { ok: true, value: joinMap(rows) }; });
			});
		}).catch(function () { return { ok: false, value: null }; });
	}

	async function del(key) {
		await ready();
		if (!durable()) {
			if (opened) return false;
			try { localStorage.removeItem(key); } catch (e) { /* best effort */ }
			return true;
		}
		return inTx('readwrite', function (st) { dropIn(st, key); return true; }).catch(function () { return false; });
	}

	/// Move a localStorage value into the durable store, and remove the localStorage
	/// key ONLY after the write has committed — which is what frees the box that
	/// jammed. Loss-free: the localStorage copy stays the sole copy until IndexedDB
	/// holds it, so a write that throws loses nothing. Resolves true once the box holds no
	/// copy; false in the fallback, where localStorage IS the store, and while the move has
	/// not landed, when the store holds only part of the value.
	///
	/// The move is recorded in the transaction that writes the value, and only that record
	/// lets a later boot drop a box copy unread (a stale one, written by an older tab). A
	/// store holding the key without it, an older build's move or a write landed over a move
	/// that did not, keeps what it holds, and the box's entries it lacks are laid under it:
	/// an entry kept a round too long costs a few bytes, one lost costs the file.
	async function migrate(key) {
		await ready();
		if (!durable()) return false;
		var raw = null;
		try { raw = localStorage.getItem(key); } catch (e) { raw = null; }
		if (raw == null) return true;
		var box;
		try { box = JSON.parse(raw); } catch (e) { return false; }
		var isMap = function (v) { return !!v && typeof v === 'object' && !Array.isArray(v); };
		var ok = await inTx('readwrite', function (st) {
			return st.get(movedKey(key)).then(function (done) {
				if (done) return true;
				return readIn(st, key).then(function (r) {
					// A box value that is not a map is dropped rather than written over a stored map.
					if (isMap(r.val)) { if (isMap(box)) putMap(st, key, Object.assign({}, box, r.val)); }
					else if (isMap(box)) putMap(st, key, box);
					else putIn(st, key, box);
					st.put(1, movedKey(key));
					return true;
				});
			});
		}).catch(function () { return false; });
		if (ok) { try { localStorage.removeItem(key); } catch (e) { /* best effort */ } mark(dbName()); }
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
	function applyOps(map, ops) {
		map = (map && typeof map === 'object') ? map : {};
		Object.keys(ops || {}).forEach(function (e) { if (ops[e].del) delete map[e]; else map[e] = ops[e].v; });
		return map;
	}

	window.DaimondDurable = {
		ready:   ready,
		durable: durable,
		tookOver: tookOver,
		get:     get,
		set:     set,
		update:  update,
		del:     del,
		migrate: migrate,
	};
})();
