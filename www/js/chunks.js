/* ============================================================
   Daimond — content-addressed chunk transport (chunks.js)
   ------------------------------------------------------------
   The large half of a user's work. Cross-device sync ships a
   small encrypted manifest through /api/sync; a file too large to
   sit inside that parcel is offloaded here instead, split into
   content-addressed chunks the gateway holds but cannot read.

   A file is read from disk in slices and each slice is sealed on its
   own with the account's AES-GCM key, then addressed by the SHA-256
   of its ciphertext — the one hash WebCrypto and the Rust gateway
   both compute, so the gateway can verify an upload without ever
   opening it. To recover the file, each piece is fetched, decrypted
   and written straight out.

   NOTHING HOLDS A WHOLE FILE, on either path. That is what allows a
   file far larger than the tab could carry, and what allows a file
   that is not text at all: there is no string step anywhere here.
   Peak memory is one chunk plus one upload batch.

   STABLE ADDRESSES. A seal draws a fresh IV each call, so encrypting
   the same bytes twice yields different ciphertext and a different
   address. Without help, changing one byte of a large file would
   re-upload all of it. So a map from plaintext chunk hash to stored
   address lets an unchanged chunk keep its address; only what really
   changed is sealed again. The map is a cache, checked against the
   gateway before use, so a stale entry costs one upload and never a
   missing file.

   TIERS. A commit tags each file free or paid. This matters at one
   moment and it is the worst one: at the end of grace the gateway
   evicts the paid tier and keeps the free one, so tagging everything
   paid would lose a lapsed account its whole store rather than its
   overflow. The plan comes from cloud.js, most recently used first,
   drawn against the allowance the gateway reports.
   ============================================================ */
(function () {
	'use strict';

	var PATH        = '/api/chunk';
	var CLIENT_API  = 1;
	var HAVE_BATCH  = 64;							// Upload at most this many pieces per request.

	function log(/* ...args */) {
		try { if (window.console && console.debug) console.debug.apply(console, ['[chunks]'].concat([].slice.call(arguments))); }
		catch (e) { /* ignore */ }
	}

	// ── Byte helpers ───────────────────────────────────────────

	/// Unpadded base64url of a byte array, matching the gateway's
	/// `util::b64url_encode` (URL_SAFE_NO_PAD).
	function b64urlEncode(bytes) {
		// In blocks, not byte by byte: a chunk can be megabytes now, and appending
		// a character at a time to build the binary string is the slowest part of
		// an upload. The block size stays well under the argument limit of
		// `apply`, which is what a single call would otherwise hit.
		var bin = '', CH = 0x8000;
		for (var i = 0; i < bytes.length; i += CH) {
			bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
		}
		return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
	}

	/// Bytes from an unpadded base64url string.
	function b64urlDecode(s) {
		var t = s.replace(/-/g, '+').replace(/_/g, '/');
		while (t.length % 4) t += '=';
		var bin = atob(t), out = new Uint8Array(bin.length);
		for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
		return out;
	}

	/// Lowercase-hex SHA-256 of a byte array, the content address.
	async function sha256Hex(bytes) {
		var d = await crypto.subtle.digest('SHA-256', bytes);
		var b = new Uint8Array(d), s = '';
		for (var i = 0; i < b.length; i++) {
			s += (b[i] >>> 4).toString(16);
			s += (b[i] & 15).toString(16);
		}
		return s;
	}

	// ── Transport ──────────────────────────────────────────────
	// Like sync.js: a private wrapper returning {status, json}; a chunk op's
	// 4xx is an outcome to read, not an error to throw.
	async function call(body) {
		var r = await fetch(PATH, {
			method:      'POST',
			credentials: 'same-origin',
			headers:     { 'content-type': 'application/json', 'x-daimond-api': String(CLIENT_API) },
			body:        JSON.stringify(body),
		});
		var j = null;
		try { j = await r.json(); } catch (e) { j = null; }
		return { status: r.status, json: j };
	}

	/// Of the given addresses, those the gateway does not hold.
	async function missing(addrs) {
		if (!addrs.length) return [];
		var res = await call({ op: 'have', addrs: addrs });
		if (res.status !== 200 || !res.json || !Array.isArray(res.json.missing)) return addrs.slice();
		return res.json.missing;
	}

	/// Upload a batch of {addr, blob} pieces.
	async function putChunks(chunks) {
		for (var i = 0; i < chunks.length; i += HAVE_BATCH) {
			var slice = chunks.slice(i, i + HAVE_BATCH);
			var res = await call({ op: 'put', chunks: slice });
			if (res.status !== 200 || !res.json || !res.json.ok) {
				throw new Error('chunk put failed: ' + res.status);
			}
		}
	}

	/// Fetch one chunk's ciphertext bytes by address, or null if the gateway no
	/// longer holds it (evicted overflow, say).
	async function getChunk(addr) {
		var res = await call({ op: 'get', addr: addr });
		if (res.status !== 200 || !res.json || !res.json.present || !res.json.blob) return null;
		return b64urlDecode(res.json.blob);
	}

	// ── The chunk map ──────────────────────────────────────────
	// Plaintext chunk hash -> the content address its ciphertext was stored
	// under. Because a seal draws a fresh IV every time, encrypting the same
	// bytes twice yields different ciphertext and a different address; without
	// this map, changing one byte of a large file would re-upload all of it.
	// With it, only the chunks that actually changed are re-encrypted.
	//
	// It is a CACHE, never a source of truth: an address is used only after the
	// gateway confirms it still holds it, so a stale entry costs one re-upload
	// and never a missing file.
	// Entries are `plaintextHash -> [address, ciphertextSize]`. The size is kept
	// because a reused chunk is never re-encrypted, so its length would otherwise
	// be unknown — and the manifest's sizes are what the gateway bills against.
	var MAP_KEY  = 'daimond-chunk-map';
	var MAP_MAX  = 5000;		// entries; roughly 600 KB of localStorage, which is shared.

	function readMap() {
		try { return JSON.parse(localStorage.getItem(MAP_KEY) || '{}') || {}; }
		catch (e) { return {}; }
	}
	function writeMap(m) {
		var keys = Object.keys(m);
		if (keys.length > MAP_MAX) {
			// No access times here, so drop the oldest insertions -- object key
			// order. Losing an entry costs a re-upload, nothing worse.
			var trimmed = {};
			keys.slice(keys.length - MAP_MAX).forEach(function (k) { trimmed[k] = m[k]; });
			m = trimmed;
		}
		try { localStorage.setItem(MAP_KEY, JSON.stringify(m)); } catch (e) { /* quota: rebuilt next time */ }
	}

	// ── Offload ────────────────────────────────────────────────

	/// The chunk size for a file of `size` bytes.
	///
	/// Small chunks localise an edit; large ones keep the manifest short, and the
	/// manifest travels inside the sync blob, which has its own ceiling. A
	/// gigabyte at 256 KiB would be four thousand entries. The largest must stay
	/// under what the gateway accepts for one chunk.
	function chunkSizeFor(size) {
		if (size <= 64 * 1024 * 1024)  return 256 * 1024;
		if (size <= 512 * 1024 * 1024) return 1024 * 1024;
		return 4 * 1024 * 1024;
	}

	/// How many ciphertext bytes to gather before sending a batch. Bounds both
	/// the request and what is held in memory at once.
	var UPLOAD_BATCH_BYTES = 4 * 1024 * 1024;

	/// Offload one file from disk, a piece at a time, and return its manifest.
	///
	/// `file` is a File (from an OPFS handle), so the bytes are read in slices
	/// and NOTHING here ever holds the whole thing: peak memory is one chunk plus
	/// one upload batch. That is what lets a file be far larger than the tab
	/// could otherwise carry, and what lets it be binary — there is no text step
	/// anywhere in this path.
	///
	/// Two passes over the file. The first hashes each plaintext chunk, which
	/// both fingerprints the file and finds the chunks already in the store. The
	/// second encrypts and uploads only what is genuinely missing.
	async function offloadFile(path, file) {
		var size = file.size;
		var CH   = chunkSizeFor(size);
		var n    = Math.max(1, Math.ceil(size / CH));
		var map  = readMap();

		// Pass one: fingerprint every chunk.
		var phash = [], i, off, len;
		for (i = 0; i < n; i++) {
			off = i * CH;
			len = Math.min(CH, size - off);
			var slice = new Uint8Array(await file.slice(off, off + Math.max(0, len)).arrayBuffer());
			phash.push(await sha256Hex(slice));
		}
		// The file's identity is the hash of its chunk hashes -- computed without
		// ever holding the file, which a plain hash of the contents could not be.
		var key = await sha256Hex(new TextEncoder().encode(phash.join('')));

		// Which of the addresses we think we already have does the gateway still
		// hold? Anything it has swept must be re-encrypted and sent again.
		var known = [];
		phash.forEach(function (h) { if (map[h]) known.push(map[h][0]); });
		var gone = {};
		(await missing(known)).forEach(function (a) { gone[a] = 1; });

		// Pass two: encrypt and upload only what is missing.
		var chunks = [], batch = [], batchBytes = 0, reused = 0;
		for (i = 0; i < n; i++) {
			var have = map[phash[i]];
			if (have && !gone[have[0]]) {
				chunks.push({ addr: have[0], size: have[1] | 0 });
				reused++;
				continue;
			}
			off = i * CH;
			len = Math.min(CH, size - off);
			var plain = new Uint8Array(await file.slice(off, off + Math.max(0, len)).arrayBuffer());
			var ct    = await DaimondIdentity.wrapBytes(plain);
			var addr  = await sha256Hex(ct);
			map[phash[i]] = [addr, ct.length];
			chunks.push({ addr: addr, size: ct.length });
			batch.push({ addr: addr, blob: b64urlEncode(ct) });
			batchBytes += ct.length;
			if (batchBytes >= UPLOAD_BATCH_BYTES) { await putChunks(batch); batch = []; batchBytes = 0; }
		}
		if (batch.length) await putChunks(batch);
		writeMap(map);

		log('offloaded', path, n, 'chunks,', reused, 'reused');
		return {
			v:      2,
			size:   size,				// plaintext bytes, so a reader knows the file.
			key:    key,
			chunks: chunks,
		};
	}

	// ── Materialise ────────────────────────────────────────────

	/// Stream a file back from its manifest, handing each decrypted piece to
	/// `write` in order. Returns true on success; false if any piece is no longer
	/// held, so the caller can leave the file absent rather than write a
	/// truncated one.
	///
	/// Nothing accumulates: one chunk is in memory at a time, and the caller
	/// writes it straight to disk.
	async function materialiseStream(manifest, write) {
		if (!manifest || !Array.isArray(manifest.chunks)) return false;
		for (var i = 0; i < manifest.chunks.length; i++) {
			var bytes = await getChunk(manifest.chunks[i].addr);
			if (bytes === null) { log('materialise: missing chunk', manifest.chunks[i].addr); return false; }
			var plain;
			try { plain = await DaimondIdentity.unwrapBytes(bytes); }
			catch (e) { log('materialise: unwrap failed'); return false; }
			await write(plain);
		}
		return true;
	}

	/// Recover a file sealed by the ORIGINAL whole-file scheme: one seal over the
	/// entire text, base64, then split. Kept because accounts hold files stored
	/// that way; nothing writes this shape any more.
	async function materialiseV1(manifest) {
		if (!manifest || !Array.isArray(manifest.chunks)) return null;
		var total = 0, parts = [];
		for (var i = 0; i < manifest.chunks.length; i++) {
			var bytes = await getChunk(manifest.chunks[i].addr);
			if (bytes === null) { log('materialise: missing chunk', manifest.chunks[i].addr); return null; }
			parts.push(bytes); total += bytes.length;
		}
		var joined = new Uint8Array(total), at = 0;
		parts.forEach(function (p) { joined.set(p, at); at += p.length; });
		var W = new TextDecoder().decode(joined);
		try { return await DaimondIdentity.unwrap(W); }
		catch (e) { log('materialise: unwrap failed'); return null; }
	}

	/// Declare the live, tiered chunk set to the gateway and let it sweep
	/// everything unreferenced. `manifests` is the map of `{path: manifest}` in
	/// the state just pushed; every chunk it names is committed as paid overflow.
	///
	/// `blobVersion` is the sync blob version this set was derived from. The
	/// gateway refuses to sweep for a device naming a version older than the one
	/// it holds, because such a device cannot know about a file another device
	/// added — and a sweep on its word would delete that file's chunks.
	async function commit(manifests, blobVersion, tiers) {
		var seen = {}, entries = [];
		Object.keys(manifests || {}).forEach(function (path) {
			var m = manifests[path];
			if (!m || !Array.isArray(m.chunks)) return;
			// A file's chunks carry its tier. Tagging everything paid would mean a
			// lapsed account lost its whole store at the end of grace instead of
			// only its overflow, which is the opposite of the promise.
			var tier = (tiers && tiers[path] === 'f') ? 'f' : 'p';
			m.chunks.forEach(function (c) {
				if (seen[c.addr]) return;			// dedup across files.
				seen[c.addr] = 1;
				entries.push({ addr: c.addr, size: c.size | 0, tier: tier });
			});
		});
		var body = { op: 'commit', chunks: entries };
		if (typeof blobVersion === 'number') body.blob_version = blobVersion | 0;
		var res = await call(body);
		if (res.status !== 200 || !res.json || !res.json.ok) { log('commit failed', res.status); return null; }
		// The gateway names the free allowance it grants, so the next tiering can
		// be honest about which files fit inside it.
		if (window.DaimondCloud && typeof res.json.free_allowance === 'number') {
			DaimondCloud.setAllowance(res.json.free_allowance);
		}
		log('committed', entries.length, 'live chunks; swept', res.json.swept);
		return res.json;
	}

	// ── Public surface ─────────────────────────────────────────
	window.DaimondChunks = {
		offloadFile:       offloadFile,			// (path, File) -> manifest v2
		materialiseStream: materialiseStream,	// (manifest, write) -> bool
		materialiseV1:     materialiseV1,		// (manifest) -> text|null, old files only
		chunkSizeFor:      chunkSizeFor,
		commit:            commit,				// ({path: manifest}, version) -> {swept,...}|null
		// exposed for tests/tools:
		_b64urlEncode: b64urlEncode,
		_b64urlDecode: b64urlDecode,
		_sha256Hex:    sha256Hex,
	};
})();
