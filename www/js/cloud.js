/* ============================================================
   Daimond — cloud residency (cloud.js)
   ------------------------------------------------------------
   Where the workspace lives, and how much of it this device holds.

   The workspace is ONE set of files with one set of paths. The
   browser's OPFS sandbox is a CACHE of it, bounded by whatever
   storage the browser grants — small on iOS, and evictable by
   Safari without asking. Cloud storage is what lets the workspace
   be larger than the device.

   So a file has a RESIDENCY, not a location:

     held      — on this device and in cloud storage.
     cloud     — in cloud storage, not on this device right now.
     pinned    — held, and never evicted to make room.

   A cloud-only file is still the user's file and still appears in
   the tree. It is safe; it is simply not here at the moment.

   THE INDEX IS SHARED STATE. `daimond-cloud-index` maps a path to
   the manifest that reconstructs it. It travels in the sync blob
   and is MERGED across devices — never rebuilt from one device's
   local view. That distinction is load-bearing: the gateway sweeps
   every chunk the committed index does not name, so a device that
   rebuilt the index from its own sandbox would delete the files it
   happened not to be holding. Absence from disk means "not here";
   only an explicit delete means "gone".
   ============================================================ */
(function () {
	'use strict';

	var IX_KEY    = 'daimond-cloud-index';		// path -> {size, hash, chunks:[{addr,size}]}
	var PIN_KEY   = 'daimond-cloud-pins';		// path -> 1, device-local
	var ATIME_KEY = 'daimond-cloud-atime';		// path -> ms, for least-recently-used reclaim
	var PATHS_KEY = 'daimond-cloud-paths';		// path -> size, DERIVED: in cloud, not on this device

	// Reclaim thresholds, as a fraction of the storage the browser grants us.
	// Reclaiming to a little under the trigger stops it running on every write.
	var PRESSURE_HIGH   = 0.85;
	var PRESSURE_TARGET = 0.70;

	// Reclaim runs after a push, and a push can be frequent. Without these two
	// the device could free a file, have the user open it again, fetch it back,
	// and free it once more -- each cycle costing a download the user pays for.
	// So: a floor on how often reclaim may run at all, and a cool-down during
	// which a file that was just used is not a candidate however cold it looks.
	var RECLAIM_MIN_GAP_MS = 5 * 60 * 1000;
	var RECENT_USE_MS      = 30 * 60 * 1000;
	var RECLAIM_AT_KEY     = 'daimond-cloud-reclaimed';

	// A ceiling on what the AGENT may pull down unprompted, over a rolling
	// window. A fetch spends the user's credits, and an agent in a loop can ask
	// for a great deal very quickly; the user clicking a file is a different
	// thing entirely and is not counted here.
	var AGENT_FETCH_WINDOW_MS = 10 * 60 * 1000;
	var AGENT_FETCH_BUDGET    = 128 * 1024 * 1024;
	var AGENT_FETCH_KEY       = 'daimond-cloud-agent-fetches';
	var ALLOWANCE_KEY         = 'daimond-cloud-allowance';	// free bytes, as the gateway last reported them.

	function log(/* ...args */) {
		try { if (window.console && console.debug) console.debug.apply(console, ['[cloud]'].concat([].slice.call(arguments))); }
		catch (e) { /* ignore */ }
	}

	// ── Stored state ───────────────────────────────────────────
	// localStorage is namespaced per account by accounts.js, so these keys need
	// no prefixing of their own.

	function readJson(key, fallback) {
		try { return JSON.parse(localStorage.getItem(key) || 'null') || fallback; }
		catch (e) { return fallback; }
	}
	function writeJson(key, val) {
		try { localStorage.setItem(key, JSON.stringify(val)); return true; }
		catch (e) { return false; }		// quota: recomputed next round rather than corrupted.
	}

	function index()      { return readJson(IX_KEY, {}); }
	function setIndex(ix) { return writeJson(IX_KEY, ix || {}); }
	function pins()       { return readJson(PIN_KEY, {}); }
	function atimes()     { return readJson(ATIME_KEY, {}); }

	/// The manifest for a path, or null if cloud storage does not hold it.
	function manifest(path) {
		var m = index()[path];
		return (m && Array.isArray(m.chunks)) ? m : null;
	}

	/// A cheap content fingerprint, deliberately identical to daimond.js's
	/// `fileHash` — the two modules must agree on whether a file changed, and
	/// each has to work if the other failed to load.
	///
	/// Good enough to decide a MERGE, where being wrong means an unnecessary
	/// sidecar. Not good enough to decide a DELETION, which is why eviction
	/// verifies with `sha256` below instead.
	function hash(s) {
		var h = 5381;
		for (var i = 0; i < s.length; i++) { h = ((h << 5) + h + s.charCodeAt(i)) | 0; }
		return (h >>> 0).toString(36) + ':' + s.length;
	}

	/// SHA-256 of a string, hex. Used where being wrong costs the user a file:
	/// dropping the only local copy on the strength of a 32-bit fingerprint is
	/// not a risk worth carrying when the real hash is one call away.
	async function sha256(s) {
		var d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
		var b = new Uint8Array(d), out = '';
		for (var i = 0; i < b.length; i++) {
			out += (b[i] >>> 4).toString(16);
			out += (b[i] & 15).toString(16);
		}
		return out;
	}

	// ── OPFS, honouring the account namespace ──────────────────
	// A non-primary account lives in an OPFS subdirectory, exactly as the wasm
	// file tools resolve it. Reading the raw root instead would look in the
	// primary's workspace.

	async function opfsRoot() {
		var root = await navigator.storage.getDirectory();
		var ns = '';
		try { ns = (window.DaimondAccounts && DaimondAccounts.opfsNs()) || ''; } catch (e) { ns = ''; }
		if (!ns) return root;
		return await root.getDirectoryHandle(ns, { create: true });
	}

	function parts(path) {
		return String(path).split('/').filter(function (x) { return x && x !== '.' && x !== '..'; });
	}

	/// The directory handle holding `path`, or null when a component is absent.
	async function dirFor(path, create) {
		var p = parts(path);
		if (!p.length) return null;
		var dir = await opfsRoot();
		for (var i = 0; i < p.length - 1; i++) {
			try { dir = await dir.getDirectoryHandle(p[i], { create: !!create }); }
			catch (e) { return null; }
		}
		return dir;
	}

	/// Whether this device currently holds the file.
	async function isHeld(path) {
		var p = parts(path);
		if (!p.length) return false;
		var dir = await dirFor(path, false);
		if (!dir) return false;
		try { await dir.getFileHandle(p[p.length - 1]); return true; }
		catch (e) { return false; }
	}

	async function readText(path) {
		var p = parts(path);
		var dir = await dirFor(path, false);
		if (!dir) throw new Error('No such directory: ' + path);
		var fh = await dir.getFileHandle(p[p.length - 1]);
		return await (await fh.getFile()).text();
	}

	async function writeText(path, content) {
		var p = parts(path);
		var dir = await dirFor(path, true);
		if (!dir) throw new Error('Cannot create directory for: ' + path);
		var fh = await dir.getFileHandle(p[p.length - 1], { create: true });
		var w = await fh.createWritable();
		await w.write(new TextEncoder().encode(content));
		await w.close();
	}

	/// The File at a path, or null. The handle is how a file is read in slices
	/// rather than whole.
	async function fileAt(path) {
		var p = parts(path);
		var dir = await dirFor(path, false);
		if (!dir) return null;
		try { return await (await dir.getFileHandle(p[p.length - 1])).getFile(); }
		catch (e) { return null; }
	}

	/// Open a writable stream at a path, so a large file lands on disk piece by
	/// piece instead of being assembled in memory first.
	async function openWrite(path) {
		var p = parts(path);
		var dir = await dirFor(path, true);
		if (!dir) throw new Error('Cannot create directory for: ' + path);
		var fh = await dir.getFileHandle(p[p.length - 1], { create: true });
		return await fh.createWritable();
	}

	/// Write a Blob or File straight to a path. Streams, and carries bytes rather
	/// than text, so a picture arrives as a picture.
	async function writeBlob(path, blob) {
		var w = await openWrite(path);
		await w.write(blob);
		await w.close();
	}

	/// Re-derive a file's identity by streaming it: the hash of its chunk
	/// hashes, exactly as the offload computed it. Never holds the file, so this
	/// is affordable at any size — which matters, because it is what stands
	/// between a user and the deletion of their only local copy.
	async function fileKey(file, chunkSize) {
		var CH = chunkSize || 256 * 1024;
		var n = Math.max(1, Math.ceil(file.size / CH));
		var hashes = '';
		for (var i = 0; i < n; i++) {
			var off = i * CH;
			var len = Math.min(CH, file.size - off);
			var slice = new Uint8Array(await file.slice(off, off + Math.max(0, len)).arrayBuffer());
			hashes += await sha256Bytes(slice);
		}
		return await sha256Bytes(new TextEncoder().encode(hashes));
	}

	/// SHA-256 of a byte array, hex.
	async function sha256Bytes(bytes) {
		var d = await crypto.subtle.digest('SHA-256', bytes);
		var b = new Uint8Array(d), out = '';
		for (var i = 0; i < b.length; i++) {
			out += (b[i] >>> 4).toString(16);
			out += (b[i] & 15).toString(16);
		}
		return out;
	}

	async function removeLocal(path) {
		var p = parts(path);
		var dir = await dirFor(path, false);
		if (!dir) return false;
		try { await dir.removeEntry(p[p.length - 1]); return true; }
		catch (e) { return false; }
	}

	// ── The derived path list the Rust file tools read ─────────
	// `file_read` and `file_list` in wasm consult `daimond-cloud-paths` to tell
	// the agent that a file exists in cloud storage rather than reporting it
	// missing. It holds only what is NOT held here, so it is recomputed
	// whenever residency changes.

	async function refreshPaths() {
		var ix = index(), out = {};
		var keys = Object.keys(ix);
		for (var i = 0; i < keys.length; i++) {
			var p = keys[i];
			if (!(await isHeld(p))) out[p] = (ix[p] && ix[p].size) | 0;
		}
		writeJson(PATHS_KEY, out);
		return out;
	}

	/// The paths in cloud storage that this device is not holding.
	function awayPaths() { return readJson(PATHS_KEY, {}); }

	// ── Merging the index across devices ───────────────────────

	/// Merge a pulled index into the stored one by the same 3-way compare the
	/// inline files use, against the per-path baseline hashes of the last agreed
	/// sync. Nothing is fetched here — a manifest is a reference, and adopting
	/// one costs no bytes.
	///
	/// A path changed on BOTH sides differently keeps the local manifest and
	/// records the remote one at `<path>.synced`, mirroring the sidecar rule for
	/// inline files. No download is needed to preserve it, because the sidecar
	/// is only a second reference to chunks the gateway already holds.
	function merge(remoteIx, baseline) {
		var local = index(), base = baseline || {}, out = {}, seen = {};
		remoteIx = (remoteIx && typeof remoteIx === 'object') ? remoteIx : {};

		Object.keys(local).forEach(function (p) { seen[p] = 1; });
		Object.keys(remoteIx).forEach(function (p) { seen[p] = 1; });

		Object.keys(seen).forEach(function (p) {
			var l = local[p], r = remoteIx[p];
			if (!r) { out[p] = l; return; }							// only here: keep, it will push.
			if (!l) { out[p] = r; return; }							// only there: adopt the reference.
			if (l.hash === r.hash) { out[p] = l; return; }			// same file.
			var b = base[p] || null;
			var localChanged  = (l.hash !== b);
			var remoteChanged = (r.hash !== b);
			if (remoteChanged && !localChanged) { out[p] = r; return; }
			if (localChanged && !remoteChanged) { out[p] = l; return; }
			out[p] = l;												// both diverged: keep ours,
			// and preserve theirs beside it -- but never chain sidecars onto
			// sidecars, or a path that keeps diverging grows a tail of
			// `.synced.synced.synced` that nobody will ever read.
			if (!/\.synced$/.test(p)) out[p + '.synced'] = r;
		});
		// Drop a sidecar whose original is gone: it was only ever meaningful as
		// "the other version of that file", and on its own it is landfill the
		// user is paying to store.
		Object.keys(out).forEach(function (p) {
			var m = /^(.*)\.synced$/.exec(p);
			if (m && !out[m[1]]) delete out[p];
		});
		setIndex(out);
		return out;
	}

	/// Record (or replace) the manifest for a path this device just offloaded.
	///
	/// `at` is when the upload happened and `bytes` is the file's true length on
	/// disk; together they let a later eviction satisfy itself that the local
	/// copy is the uploaded one without reading it back.
	///
	/// `bytes` is measured, not taken from the manifest: a manifest's `size` is
	/// the string's length in UTF-16 code units, which equals the byte length
	/// only for pure ASCII. Comparing that against a file's real size would
	/// declare every accented character an unsaved edit.
	async function put(path, mani, h) {
		var ix = index();
		var f = await fileAt(path);
		ix[path] = {
			v:      mani.v || 1,
			size:   mani.size,				// plaintext bytes on disk.
			bytes:  f ? f.size : mani.size,
			mtime:  f ? f.lastModified : 0,	// with size, the cheap "did it change" test.
			hash:   h,						// the merge fingerprint.
			key:    mani.key || null,		// what eviction verifies against.
			chunks: mani.chunks,
			at:     Date.now(),
		};
		setIndex(ix);
		return ix;
	}

	/// Drop a path from the index — the file is GONE, not merely absent. Its
	/// chunks are swept on the next commit. Only an explicit delete does this.
	function forget(path) {
		var ix = index();
		if (!Object.prototype.hasOwnProperty.call(ix, path)) return false;
		delete ix[path];
		setIndex(ix);
		var a = atimes(); delete a[path]; writeJson(ATIME_KEY, a);
		var p = pins();   delete p[path]; writeJson(PIN_KEY, p);
		refreshPaths();
		return true;
	}

	// ── Residency actions ──────────────────────────────────────

	/// Note that a path was just used, so reclaim evicts the coldest first.
	function touch(path) {
		var a = atimes();
		a[path] = Date.now();
		writeJson(ATIME_KEY, a);
	}

	/// Bring a cloud-only file down onto this device. Returns a message string
	/// beginning `OK` or `Error`, which is also what the agent's `file_fetch`
	/// tool reports.
	/// Decide which paths ride in the free allowance and which are paid overflow.
	///
	/// This matters at exactly one moment, and it is the worst one: at the end of
	/// grace the gateway evicts the paid tier and keeps the free one. The client
	/// used to tag everything paid, so a lapsed account would have lost its whole
	/// store rather than its overflow -- the opposite of what the policy promises.
	///
	/// Most recently used first, because the free tier is meant to be the working
	/// set: the files someone is actually using are the ones that should survive
	/// a lapse.
	function tierPlan(allowance) {
		var ix = index(), a = atimes(), plan = {};
		var paths = Object.keys(ix).sort(function (x, y) {
			return (a[y] || 0) - (a[x] || 0);		// most recently used first.
		});
		var free = 0, budget = allowance | 0;
		paths.forEach(function (p) {
			var size = (ix[p].bytes | 0) || (ix[p].size | 0);
			if (free + size <= budget) { plan[p] = 'f'; free += size; }
			else { plan[p] = 'p'; }
		});
		return plan;
	}

	/// The free allowance the gateway last reported, in bytes.
	function allowance() {
		var n = parseInt(localStorage.getItem(ALLOWANCE_KEY) || '0', 10);
		return isNaN(n) ? 0 : n;
	}
	function setAllowance(n) {
		try { localStorage.setItem(ALLOWANCE_KEY, String(n | 0)); } catch (e) { /* best effort */ }
	}

	/// What the agent has pulled down in the last window, pruned as it is read.
	function agentFetches() {
		var all = readJson(AGENT_FETCH_KEY, []), now = Date.now();
		return all.filter(function (r) { return r && (now - r.at) < AGENT_FETCH_WINDOW_MS; });
	}

	/// Bytes the agent may still pull down unprompted.
	function agentFetchAllowance() {
		var used = agentFetches().reduce(function (n, r) { return n + (r.n | 0); }, 0);
		return Math.max(0, AGENT_FETCH_BUDGET - used);
	}

	function noteAgentFetch(n) {
		var all = agentFetches();
		all.push({ at: Date.now(), n: n | 0 });
		writeJson(AGENT_FETCH_KEY, all);
	}

	async function fetchDown(path, viaAgent) {
		var m = manifest(path);
		if (!m) return 'Error: ' + path + ' is not in cloud storage.';
		if (await isHeld(path)) { touch(path); return 'OK: ' + path + ' is already on this device.'; }
		if (!window.DaimondChunks) return 'Error: the chunk transport is not loaded.';
		// An agent asking is not the same as a person asking. A person clicking a
		// file has seen its size and been warned if it is large; an agent can ask
		// for a hundred files in a loop, and every one of them is billed. So the
		// agent gets a budget, and past it must come back through the user.
		if (viaAgent) {
			var left = agentFetchAllowance();
			var want = (m.bytes | 0) || (m.size | 0);
			if (want > left) {
				return 'Error: fetching ' + path + ' (' + want + ' bytes) would go past what may be ' +
					'downloaded automatically; ' + left + ' bytes are left in this window. Ask the user ' +
					'to fetch it from the workspace panel, or wait.';
			}
		}
		var written = 0;
		if ((m.v | 0) >= 2) {
			// Straight to disk, one piece at a time: a file too large to hold is
			// exactly the file this exists for.
			var w;
			try { w = await openWrite(path); }
			catch (e) { return 'Error: could not write ' + path + ' to this device: ' + (e && e.message ? e.message : e); }
			var okAll = false;
			try {
				okAll = await DaimondChunks.materialiseStream(m, async function (bytes) {
					await w.write(bytes);
					written += bytes.length;
				});
				await w.close();
			} catch (e) {
				try { await w.close(); } catch (e2) { /* already gone */ }
				okAll = false;
			}
			if (!okAll) {
				// Never leave a truncated file standing in for a whole one.
				await removeLocal(path);
				return 'Error: ' + path + ' could not be fetched; cloud storage no longer holds all of its parts.';
			}
		} else {
			// An older whole-file manifest, from before the streaming pipeline.
			var content;
			try { content = await DaimondChunks.materialiseV1(m); }
			catch (e) { return 'Error: could not fetch ' + path + ': ' + (e && e.message ? e.message : e); }
			if (content == null) return 'Error: ' + path + ' could not be fetched; cloud storage no longer holds all of its parts.';
			try { await writeText(path, content); }
			catch (e) { return 'Error: could not write ' + path + ' to this device: ' + (e && e.message ? e.message : e); }
			written = content.length;
		}
		touch(path);
		if (viaAgent) noteAgentFetch(written);
		await refreshPaths();
		log('fetched', path, written);
		return 'OK: fetched ' + path + ' (' + written + ' bytes) onto this device.';
	}

	/// Drop this device's copy, keeping the file in cloud storage. Refused
	/// unless cloud storage holds THIS content — never evict what is not backed,
	/// and never evict a pinned file.
	/// The largest file we will read whole just to fingerprint it before freeing.
	/// Above this, size and modification time have to carry the decision, because
	/// pulling a 60 MB file into a string to check a hash — on the very device
	/// that is short of memory — would be perverse.
	var VERIFY_READ_MAX = 4 * 1024 * 1024;

	async function evict(path) {
		var m = manifest(path);
		if (!m) return 'Error: ' + path + ' is not in cloud storage, so it cannot be freed.';
		if (isPinned(path)) return 'Error: ' + path + ' is pinned to this device.';

		var file = await fileAt(path);
		if (!file) return 'OK: ' + path + ' was already not on this device.';

		// Cheap rejection first: a different length on disk means an edit that has
		// not been pushed yet.
		if (typeof m.bytes === 'number' && file.size !== m.bytes) {
			return 'Error: ' + path + ' has changed since it was last uploaded; it will be freed after the next sync.';
		}
		// Then prove it, by re-deriving the same identity the offload computed.
		// Streaming makes this affordable at any size, so there is no size above
		// which a deletion rests on a guess.
		if (m.key) {
			var live;
			try { live = await fileKey(file, window.DaimondChunks ? DaimondChunks.chunkSizeFor(file.size) : 0); }
			catch (e) { return 'Error: could not verify ' + path + ' before freeing it.'; }
			if (live !== m.key) {
				return 'Error: ' + path + ' has changed since it was last uploaded; it will be freed after the next sync.';
			}
		} else if (m.at && file.lastModified && file.lastModified > m.at) {
			// An older entry, stored before file keys were recorded.
			return 'Error: ' + path + ' has been edited since it was last uploaded; it will be freed after the next sync.';
		}

		if (!(await removeLocal(path))) return 'Error: could not free ' + path + '.';
		await refreshPaths();
		log('evicted', path, file.size);
		return 'OK: freed ' + file.size + ' bytes; ' + path + ' remains in cloud storage.';
	}

	function isPinned(path) { return !!pins()[path]; }

	/// Pin a file to this device, or release it. A pinned file is never
	/// reclaimed automatically, which is what makes automatic reclaim safe to
	/// leave switched on.
	function pin(path, on) {
		var p = pins();
		if (on) p[path] = 1; else delete p[path];
		writeJson(PIN_KEY, p);
		return !!p[path];
	}

	// ── Reclaiming space ───────────────────────────────────────

	/// What the browser has granted and how much of it is used.
	async function pressure() {
		var est = { usage: 0, quota: 0 };
		try {
			if (navigator.storage && navigator.storage.estimate) est = await navigator.storage.estimate();
		} catch (e) { /* unsupported: report no pressure rather than guess */ }
		var usage = est.usage || 0, quota = est.quota || 0;
		return { usage: usage, quota: quota, ratio: quota ? (usage / quota) : 0 };
	}

	/// Free the coldest unpinned, cloud-backed files until the sandbox is
	/// comfortably under its quota again. Does nothing when there is no
	/// pressure, and never touches a file cloud storage does not hold.
	async function reclaim(force) {
		var pr = await pressure();
		if (!pr.quota) return { freed: 0, evicted: [], ratio: pr.ratio };
		if (!force && pr.ratio < PRESSURE_HIGH) return { freed: 0, evicted: [], ratio: pr.ratio };
		// Reclaim rides on the push, and a push can come every few seconds. Left
		// ungoverned it would free a file the user is still working with, who
		// opens it again, pays to fetch it, and has it freed once more.
		var now = Date.now();
		if (!force) {
			var last = parseInt(localStorage.getItem(RECLAIM_AT_KEY) || '0', 10) || 0;
			if (now - last < RECLAIM_MIN_GAP_MS) return { freed: 0, evicted: [], ratio: pr.ratio };
		}
		try { localStorage.setItem(RECLAIM_AT_KEY, String(now)); } catch (e) { /* best effort */ }

		var ix = index(), a = atimes(), pinned = pins();
		var candidates = [];
		var keys = Object.keys(ix);
		for (var i = 0; i < keys.length; i++) {
			var p = keys[i];
			if (pinned[p]) continue;
			// Just used is not cold, however long ago it was used before that.
			if (a[p] && (now - a[p]) < RECENT_USE_MS) continue;
			if (!(await isHeld(p))) continue;
			candidates.push({ path: p, size: (ix[p].bytes | 0) || (ix[p].size | 0), at: a[p] || 0 });
		}
		candidates.sort(function (x, y) { return x.at - y.at; });	// coldest first.

		var target = pr.quota * PRESSURE_TARGET;
		var usage = pr.usage, freed = 0, evicted = [];
		for (var j = 0; j < candidates.length && usage > target; j++) {
			var r = await evict(candidates[j].path);
			if (r.indexOf('OK') !== 0) continue;
			usage -= candidates[j].size;
			freed += candidates[j].size;
			evicted.push(candidates[j].path);
		}
		if (evicted.length) log('reclaimed', freed, 'bytes from', evicted.length, 'files');
		return { freed: freed, evicted: evicted, ratio: pr.quota ? (usage / pr.quota) : 0 };
	}

	// ── Totals, for the workspace chips and the cloud view ─────

	/// What cloud storage holds for this account, and how much of it is here.
	async function summary() {
		var ix = index(), away = awayPaths();
		var total = 0, awayBytes = 0, files = 0, awayFiles = 0;
		Object.keys(ix).forEach(function (p) {
			var s = (ix[p] && ix[p].size) | 0;
			total += s; files++;
			if (Object.prototype.hasOwnProperty.call(away, p)) { awayBytes += s; awayFiles++; }
		});
		var pr = await pressure();
		return {
			bytes:     total,		// everything cloud storage holds for this account.
			files:     files,
			awayBytes: awayBytes,	// the part not on this device.
			awayFiles: awayFiles,
			usage:     pr.usage,	// what the browser sandbox is using.
			quota:     pr.quota,
			ratio:     pr.ratio,
		};
	}

	/// Whether cloud storage is usable at all: the transport is loaded and the
	/// identity that seals a chunk is unlocked.
	function available() {
		if (!window.DaimondChunks) return false;
		try { return !!(window.DaimondIdentity && DaimondIdentity.isUnlocked && DaimondIdentity.isUnlocked()); }
		catch (e) { return false; }
	}

	// ── The bridge the wasm file tools call ────────────────────
	// The agent's own tool calls are dispatched inside Rust, not through JS, so
	// these are globals rather than module exports: `file_fetch` and
	// `file_delete` reach them from there.

	// The agent's own fetches come through here, and are budgeted as such.
	window.__daimondCloudFetch  = function (path) { return fetchDown(String(path), true); };
	window.__daimondCloudForget = function (path) {
		return Promise.resolve(forget(String(path))
			? 'OK: ' + path + ' removed from cloud storage.'
			: 'OK: ' + path + ' was not in cloud storage.');
	};

	// ── Public surface ─────────────────────────────────────────
	window.DaimondCloud = {
		index:        index,
		manifest:     manifest,
		merge:        merge,
		put:          put,
		forget:       forget,
		fetch:        fetchDown,
		evict:        evict,
		pin:          pin,
		isPinned:     isPinned,
		isHeld:       isHeld,
		touch:        touch,
		awayPaths:    awayPaths,
		refreshPaths: refreshPaths,
		reclaim:      reclaim,
		pressure:     pressure,
		summary:      summary,
		available:    available,
		hash:         hash,
		sha256:       sha256,
		fileAt:       fileAt,
		fileKey:      fileKey,
		writeBlob:    writeBlob,
		// What the agent may still pull down unprompted, in bytes.
		agentAllowance: agentFetchAllowance,
		// The free/paid split, and the allowance it is drawn against.
		tierPlan:     tierPlan,
		allowance:    allowance,
		setAllowance: setAllowance,
		// OPFS access that honours the account namespace; the sync path uses
		// these for large files, which must not go through the truncating
		// `file_read` tool.
		readText:     readText,
		writeText:    writeText,
	};
})();
