/* ============================================================
   filelock.js -- one Web Lock per file, around every write of it.
   ------------------------------------------------------------
   THE BUG (OPFS-LOCK, 2026-10-17). A writable's bytes sit in a private
   swap file until `close`, so a restore's compare-and-swap
   (`opfs::write_file_if`, src/wasm/opfs.rs) could only see a rival that
   had already CLOSED. A sync merge, an upload, a Doc Save or a backup
   unpack that closed between the restore's re-check and its own close
   was overwritten and kept in no version row; two restores could both
   "win". Measured: 194-200 of 200 races both won, in Chrome and Firefox.

   The fix is a lock named for the file, `daimond-file:<root>:<path>`,
   held by every writer from before it opens the file until after it
   closes it. The wasm takes the same name (`file_lock_name`,
   src/fsname.rs); the two spellings are the same rule, and
   filelock.test.mjs holds them to it.

   LOCK ORDER. This lock is a LEAF: nothing holding it asks for any other
   lock. A restore holds `daimond-version-<id>` and then this one, never
   the reverse, so the two cannot deadlock.

   A BOUNDED WAIT. A writer waits at most `WAIT_MS` (60 s, the wasm's
   `FILE_WAIT_MS`) for the file, then is refused in the wasm's words: a
   page write behind a slow streamed download used to hang without end.

   NO `..`. The page's writers drop a `..` component where the wasm takes
   it back, so `x/../a` is written at `x/a` here and at `a` there: one
   lock name could not be both. A path with `..` is refused at the lock,
   before anything is opened. No page caller passes one.

   With no lock manager (an old browser), writes run unheld, as before.
   ============================================================ */
(function () {
	'use strict';

	var PREFIX = 'daimond-file:';

	/// How long a writer waits for its file before it is refused, in ms: the wasm's
	/// `FILE_WAIT_MS` (src/wasm/diamond.rs).
	var WAIT_MS = 60000;

	/// A workspace path as the lock names it: `.` and empty parts dropped, `..` taken back
	/// (never past the root), and lower case, because an opened folder on a disk that ignores
	/// case holds `A.txt` and `a.txt` as one file. Two names for one file would be no lock;
	/// one name for two files is only a short wait. The same rule as the wasm's
	/// `fsname::file_lock_name`; a page WRITER never gets this far with a `..` (`refuseUp`).
	function normal(path) {
		var out = [];
		String(path).split('/').forEach(function (c) {
			if (!c || c === '.') return;
			if (c === '..') { out.pop(); return; }
			out.push(c);
		});
		return out.join('/').toLowerCase();
	}

	/// The lock's name. `root` is 'folder' for the real folder the user has open, and
	/// anything else for this account's browser storage.
	function name(root, path) {
		return PREFIX + (root === 'folder' ? 'folder' : 'sandbox') + ':' + normal(path);
	}

	/// Refuse a path with a `..` in it. The page's walks DROP `..` (cloud.js `parts`, daimond.js
	/// `pathParts`), so the file they reach is not the one `normal` names, and the lock would
	/// exclude nobody.
	function refuseUp(path) {
		if (String(path).split('/').indexOf('..') >= 0) {
			throw new Error("'" + path + "' has a '..' in it, so nothing was written.");
		}
	}

	function manager() {
		var n = (typeof navigator !== 'undefined' && navigator) || null;
		var l = n && n.locks;
		return (l && typeof l.request === 'function') ? l : null;
	}

	/// The options of a lock request: exclusive, and given up after `WAIT_MS` where the browser
	/// can make a timed signal.
	function asking() {
		var o = { mode: 'exclusive' };
		if (typeof AbortSignal !== 'undefined' && AbortSignal && typeof AbortSignal.timeout === 'function') {
			o.signal = AbortSignal.timeout(WAIT_MS);
		}
		return o;
	}

	/// A refused request in the wasm's words (`hold_file`) where the wait ran out, else as it came.
	function refused(path, e) {
		var n = e && e.name;
		if (n === 'TimeoutError' || n === 'AbortError') {
			return new Error("'" + path + "' has been held by another write for over " + (WAIT_MS / 1000)
				+ ' seconds, so nothing was written. Try again in a moment.');
		}
		return e;
	}

	/// Run `fn` holding the file's lock, and answer what it answers.
	async function hold(root, path, fn) {
		refuseUp(path);
		var m = manager();
		if (!m) return await fn();
		var ran = false;
		try {
			return await m.request(name(root, path), asking(), function () { ran = true; return fn(); });
		} catch (e) {
			throw ran ? e : refused(path, e);
		}
	}

	/// Open a writable with `open` while holding the file's lock, and keep the lock until the
	/// writable is closed, aborted or discarded. For a writer that streams: the lock spans every
	/// `write`.
	///
	/// The answer has `write`, `close`, `abort` and `discard`. A failed open, a failed close, an
	/// abort and a discard all give the lock back; a writer that never ends keeps it until the page
	/// goes, which is why every caller ends in its error path too.
	///
	/// `discard(remove)` is a failed write's end: it aborts, which leaves a file that was there as
	/// it was, then runs `remove` (where given) STILL HOLDING THE LOCK, for the empty file the open
	/// itself left where nothing stood. Removed after the lock was given back, a rival's write that
	/// landed in between went with it. Only a caller that knows it created the file passes `remove`.
	async function writable(root, path, open) {
		refuseUp(path);
		var m = manager();
		var release = null, given = false;
		if (m) {
			await new Promise(function (granted, nope) {
				m.request(name(root, path), asking(), function () {
					return new Promise(function (r) { release = r; granted(); });
				}).catch(function (e) { nope(refused(path, e)); });
			});
		}
		function giveBack() { if (!given) { given = true; if (release) release(); } }
		var w;
		try { w = await open(); }
		catch (e) { giveBack(); throw e; }
		return {
			write: function (x) { return w.write(x); },
			close: async function () { try { return await w.close(); } finally { giveBack(); } },
			abort: async function (why) { try { return await w.abort(why); } finally { giveBack(); } },
			discard: async function (remove) {
				if (given) { if (remove) return await hold(root, path, remove); return; }
				try {
					try { if (typeof w.abort === 'function') await w.abort(); } catch (e) { /* already gone */ }
					if (remove) return await remove();
				} finally { giveBack(); }
			},
		};
	}

	/// Whether `dest` is the folder `open` or inside it: a writer that walks its own handles
	/// there (daimond.js "Save a copy") would write the open folder's files under no lock. A
	/// question the browser cannot answer counts as inside, so the copy is refused, not risked.
	async function inside(open, dest) {
		if (!open || !dest) return false;
		try {
			if (await open.isSameEntry(dest)) return true;
			return (await open.resolve(dest)) !== null;
		} catch (e) { return true; }
	}

	window.DaimondFileLock = { name: name, hold: hold, writable: writable, inside: inside, WAIT_MS: WAIT_MS };
})();
