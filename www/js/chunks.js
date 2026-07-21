/* ============================================================
   Daimond — content-addressed chunk transport (chunks.js)
   ------------------------------------------------------------
   The large half of a user's work. Cross-device sync ships a
   small encrypted manifest through /api/sync; a file too large to
   sit inside that parcel is offloaded here instead, split into
   content-addressed chunks the gateway holds but cannot read.

   A file is encrypted ONCE with DaimondIdentity.wrap() — the same
   AES-GCM key the sync blob uses — and the resulting ciphertext is
   split into fixed-size pieces. Each piece is addressed by the
   SHA-256 of its bytes, which is the one hash WebCrypto and the Rust
   gateway both compute, so the gateway can verify an upload without
   ever opening it. To recover the file, every piece is fetched,
   concatenated, and unwrapped.

   STABLE ADDRESSES. wrap() draws a fresh IV each call, so encrypting
   the same file twice yields different ciphertext and different
   addresses. That would defeat deduplication and re-upload everything
   on every sync. So an offload is CACHED by a content fingerprint: an
   unchanged file returns its earlier addresses untouched, and only a
   changed file is re-encrypted and re-uploaded.

   TIERS. The inline sync blob is the free tier — small working files.
   Everything offloaded here is paid overflow, so every chunk is
   committed as paid. A future refinement may place a working subset in
   a free chunk allowance; the gateway already carries the distinction.
   ============================================================ */
(function () {
	'use strict';

	var PATH        = '/api/chunk';
	var CLIENT_API  = 1;
	var CHUNK_BYTES = 256 * 1024;					// Ciphertext piece size.
	var HAVE_BATCH  = 512;							// Upload at most this many pieces per request.
	var CACHE_KEY   = 'daimond-chunk-offload';		// Per-account (accounts.js prefixes it).

	function log(/* ...args */) {
		try { if (window.console && console.debug) console.debug.apply(console, ['[chunks]'].concat([].slice.call(arguments))); }
		catch (e) { /* ignore */ }
	}

	// ── Byte helpers ───────────────────────────────────────────

	/// Unpadded base64url of a byte array, matching the gateway's
	/// `util::b64url_encode` (URL_SAFE_NO_PAD).
	function b64urlEncode(bytes) {
		var bin = '';
		for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
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

	// ── Offload cache ──────────────────────────────────────────
	// path -> { hash, size, chunks:[{addr,size}] }. Keyed by a content
	// fingerprint so an unchanged file keeps its addresses and is never
	// re-encrypted; the fingerprint matches daimond.js's fileHash.
	function readCache() {
		try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}') || {}; }
		catch (e) { return {}; }
	}
	function writeCache(c) {
		try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)); } catch (e) { /* quota: recomputed next time */ }
	}

	// ── Offload / materialise ──────────────────────────────────

	/// Split ciphertext bytes into fixed-size pieces, each an {addr, bytes}.
	async function pieces(bytes) {
		var out = [];
		for (var off = 0; off < bytes.length; off += CHUNK_BYTES) {
			var part = bytes.subarray(off, Math.min(off + CHUNK_BYTES, bytes.length));
			out.push({ addr: await sha256Hex(part), bytes: part });
		}
		// A zero-length file still needs one (empty) piece so its manifest is
		// non-empty and materialise has something to fetch.
		if (out.length === 0) out.push({ addr: await sha256Hex(new Uint8Array(0)), bytes: new Uint8Array(0) });
		return out;
	}

	/// Offload one file: encrypt it whole, chunk the ciphertext, upload whatever
	/// the gateway lacks, and return its manifest `{size, chunks:[{addr,size}]}`.
	/// An unchanged file (by `hash`) is served from cache without re-encrypting.
	async function offload(path, content, hash) {
		var cache = readCache();
		var hit = cache[path];
		if (hit && hit.hash === hash && Array.isArray(hit.chunks)) {
			// Reuse the addresses; make sure the gateway still holds them (it may
			// have swept them if another device dropped the file meanwhile).
			var need = await missing(hit.chunks.map(function (c) { return c.addr; }));
			if (need.length === 0) return { size: hit.size, chunks: hit.chunks };
			// Some are missing: fall through and re-encrypt to refill them.
		}
		var W     = await DaimondIdentity.wrap(content);	// one AES-GCM seal for the whole file.
		var bytes = new TextEncoder().encode(W);			// the ciphertext-bearing base64 string.
		var ps    = await pieces(bytes);
		var need  = await missing(ps.map(function (p) { return p.addr; }));
		var needSet = {}; need.forEach(function (a) { needSet[a] = 1; });
		var upload  = [];
		ps.forEach(function (p) {
			if (needSet[p.addr]) upload.push({ addr: p.addr, blob: b64urlEncode(p.bytes) });
		});
		await putChunks(upload);
		var manifest = { size: content.length, chunks: ps.map(function (p) { return { addr: p.addr, size: p.bytes.length }; }) };
		cache[path] = { hash: hash, size: manifest.size, chunks: manifest.chunks };
		writeCache(cache);
		log('offloaded', path, manifest.chunks.length, 'chunks');
		return manifest;
	}

	/// Recover a file from its manifest: fetch every piece, concatenate, and
	/// unwrap. Returns the plaintext, or null if any piece is unavailable (so the
	/// caller can leave the file absent rather than write a corrupt one).
	async function materialise(manifest) {
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
	async function commit(manifests) {
		var seen = {}, entries = [];
		Object.keys(manifests || {}).forEach(function (path) {
			var m = manifests[path];
			if (!m || !Array.isArray(m.chunks)) return;
			m.chunks.forEach(function (c) {
				if (seen[c.addr]) return;			// dedup across files.
				seen[c.addr] = 1;
				entries.push({ addr: c.addr, size: c.size | 0, tier: 'p' });
			});
		});
		var res = await call({ op: 'commit', chunks: entries });
		if (res.status !== 200 || !res.json || !res.json.ok) { log('commit failed', res.status); return null; }
		log('committed', entries.length, 'live chunks; swept', res.json.swept);
		return res.json;
	}

	// ── Public surface ─────────────────────────────────────────
	window.DaimondChunks = {
		offload:     offload,		// (path, content, hash) -> {size, chunks}
		materialise: materialise,	// (manifest) -> content|null
		commit:      commit,		// ({path: manifest}) -> {swept,...}|null
		// exposed for tests/tools:
		_b64urlEncode: b64urlEncode,
		_b64urlDecode: b64urlDecode,
		_sha256Hex:    sha256Hex,
	};
})();
