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

   THE SWEEP FLOOR. A commit declares the live set and the gateway
   deletes everything it does not name, which is the most destructive
   thing the gateway does on this file's say-so — and it used to obey
   without question. It no longer will: a sweep that would take more
   than half the account's chunks deletes NOTHING and comes back
   `sweep_held_back`/`sweep_held`/`sweep_token`. See `commit` for what
   this client does with that, and why it does not simply say yes.

   AND WHAT IT LEAVES STANDING IS NOW SOMETHING A PERSON CAN ANSWER. The
   chip in the top bar is a button: it asks, and then re-sends the parked
   commit with its token. The parked commit is written to localStorage,
   because only the gateway can mint that token and a reload used to throw
   it away — leaving chunks nobody refers to in a store nobody sweeps, on
   an account that is billed for them.
   ============================================================ */
(function () {
	'use strict';

	var PATH        = '/api/chunk';
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
	//
	// THROUGH `DaimondGateway.gwFetch`, WHICH IS THE ONE COPY OF THE 401 RULE.
	// This file called `fetch` directly and did nothing whatever about a lapsed
	// session — the sixth copy of a wrapper that five siblings each answered a
	// 401 in, and the worst of the six to have left out. The gateway's session
	// lives an hour and nothing renewed it, so an hour into a sitting every op
	// here was refused: `missing()` reports EVERY address as missing, so the next
	// sync re-encrypts and re-uploads the whole corpus; `putChunks()` throws
	// `chunk put failed: 401`; and the commit that lets the gateway sweep never
	// lands, so the account's garbage is never collected. None of it was said
	// anywhere.
	//
	// SAFE TO REPEAT. `handle_impl` (gateway/src/handlers/chunk.rs) takes the
	// session in its FIRST statement — before the method check, before the body
	// is parsed, before `op` is even read — so a 401 is proof that nothing
	// happened: nothing stored, nothing swept, no index recorded. The second
	// attempt cannot duplicate a side effect the first never had, and the body is
	// a string, so the options object is reused as given.
	//
	// LATE-BOUND, NEVER CAPTURED. `DaimondGateway` is looked up on the global at
	// every call rather than held in a local at load. index.html loads gateway.js
	// at 790 and this file at 791, so the order holds today; a property lookup
	// means it goes on holding whatever that order becomes, and it is what lets
	// the renewal be replaced without every caller keeping a reference to the old
	// one. `clientApi()` is read the same way: this file used to carry its own
	// copy of the number, and two constants that have to match are two constants
	// that will eventually not.
	async function call(body) {
		var r = await DaimondGateway.gwFetch(PATH, {
			method:      'POST',
			credentials: 'same-origin',
			headers:     {
				'content-type':  'application/json',
				'x-daimond-api': String(DaimondGateway.clientApi()),
			},
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
	///
	/// THE GATEWAY'S OWN SENTENCE IS KEPT. This threw `chunk put failed: 507` and
	/// dropped `res.json.error` on the floor, which is the difference between a
	/// person being told "This account has reached its cloud storage limit. Delete
	/// something, or ask for more room." and being shown a number they cannot look
	/// up. The gateway composes four such sentences on this one route — two 507s
	/// (the account's ceiling and the store's), a 503 and a 413 — and each of them
	/// names the remedy, which a status code by definition cannot. Same shape as
	/// every other refusal in this app: `(j && j.error) || ('HTTP ' + status)`,
	/// see gateway.js, tools.js, mail.js and web.js.
	///
	/// AND IT IS SAID, not merely thrown. `collectChunked` in daimond.js catches
	/// every offload failure and discards it ("retry next sync, index unharmed"),
	/// so an exception carrying a perfect sentence still reaches nobody. This file
	/// already owns a chip and an event for standing facts; a refused upload is
	/// one, and the most consequential kind, because the user's work has stopped
	/// travelling. `standRefused` is what puts it in front of them.
	async function putChunks(chunks) {
		for (var i = 0; i < chunks.length; i += HAVE_BATCH) {
			var slice = chunks.slice(i, i + HAVE_BATCH);
			var res = await call({ op: 'put', chunks: slice });
			if (res.status !== 200 || !res.json || !res.json.ok) {
				var msg = (res.json && (res.json.error || res.json.message))
					|| ('HTTP ' + res.status);
				standRefused(msg, res.status);
				var e = new Error(msg);
				e.status = res.status;		// for a caller that wants to branch on it.
				throw e;
			}
		}
		// A batch that landed is proof the refusal has lifted: the ceiling was
		// raised, or something was deleted, or the store stopped being busy.
		// Nothing else clears it, because nothing else knows.
		clearRefused();
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

	// ── Surviving a passphrase change ──────────────────────────
	//
	// THIS FILE SEALS AT REST, NOT IN FLIGHT, so it takes part. `offloadFile`
	// wraps each chunk with `DaimondIdentity.wrapBytes` and the ciphertext then
	// LIVES ON THE GATEWAY, addressed by its own hash, for as long as the file is
	// in the cloud store. A passphrase change re-derives the key, and every chunk
	// already up there is sealed under the old one for ever.
	//
	// What this participant can do, and what it cannot, stated plainly because the
	// gap is the interesting part:
	//
	//   - IT CANNOT RE-WRAP THEM. That would mean downloading, decrypting and
	//     re-uploading the whole corpus, which can be gigabytes, over a dialog the
	//     user is waiting on — and it could not finish the job anyway, since a
	//     file this device does not hold locally cannot be re-sealed from here at
	//     all.
	//   - IT MUST NOT LET THE OLD CIPHERTEXT BE REUSED. The map from plaintext
	//     chunk hash to stored address is what makes an unchanged chunk keep its
	//     address, and the gateway still holds every one of them — so without this,
	//     a re-offload would cheerfully point the new manifest at chunks nothing
	//     can open, and the file would stay unreadable no matter how many times it
	//     was synced. The map goes.
	//   - AND THE FILES MUST ACTUALLY BE OFFLOADED AGAIN, or dropping the map
	//     changes nothing: `collectChunked` in daimond.js skips a file whose
	//     manifest matches its size and mtime, which is every file that has not
	//     been edited. So the drop is recorded, and that one skip is suspended for
	//     the next sync round only. The price of a passphrase change is one
	//     re-upload of the large files this device holds. It is paid once.
	//
	// What remains lost is honest to say: a large file that no device still holds
	// locally cannot be recovered after a passphrase change, because the only copy
	// is sealed under a key nobody has any more.

	/// Set for as long as a re-offload is owed. In localStorage, not a variable,
	/// because the change and the sync that answers it are usually separated by a
	/// reload.
	var STALE_KEY = 'daimond-chunk-stale';

	/// Is a re-offload owed after a passphrase change?
	function staleSinceRekey() {
		try { return localStorage.getItem(STALE_KEY) === '1'; } catch (e) { return false; }
	}

	/// The re-offload has been made. Called by the round that made it, never by
	/// the round that owed it.
	function clearStale() {
		try { localStorage.removeItem(STALE_KEY); } catch (e) { /* private mode */ }
	}

	/// Forget every address sealed under the passphrase that has just gone.
	///
	/// Nothing is read out beforehand: the map holds no secret, only hashes, and
	/// the plaintext is the file on disk.
	function forgetMapAfterRekey() {
		try { localStorage.removeItem(MAP_KEY); } catch (e) { /* private mode: nothing was cached */ }
		try { localStorage.setItem(STALE_KEY, '1'); } catch (e) { /* quota: one skipped re-offload */ }
		log('passphrase changed: chunk map dropped, large files will be offloaded again');
		return { failed: [] };
	}

	if (window.DaimondRekey) {
		DaimondRekey.register({
			name:   'chunks',
			reseal: forgetMapAfterRekey,
		});
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

	// ── A sweep the gateway would not carry out ────────────────
	//
	// `sweep_chunks` had no floor: it deleted whatever a commit did not name, on
	// one request, and a client bug did exactly that to a real account. It now
	// refuses any sweep that would take more than half the chunks an account
	// holds. Nothing is deleted, the commit still succeeds and the index is still
	// recorded — the reply simply carries `sweep_held_back`, `sweep_held` and a
	// `sweep_token`, and repeating the IDENTICAL commit with that token carries
	// the deletion out. The token is a digest of the account and the sorted
	// doomed addresses, so if either set moves by one chunk in between it no
	// longer matches and the sweep is held back again.
	//
	// SHOULD THIS CLIENT SIMPLY SAY YES? Not unconditionally, and not for the
	// reason it is tempting to give. A second request does NOT make this client
	// think again: `manifests` is `DaimondCloud.index()`, a merged structure read
	// out of localStorage, so re-deriving it a moment later yields the same
	// answer it yielded the first time. The only genuinely independent opinion in
	// the interlock is the gateway's own re-read of what it holds, and that
	// catches one thing — another device having uploaded in between. So an
	// unconditional yes really would reduce the floor to a formality.
	//
	// Nor can it be a permanent no. A wholesale rewrite of one large file
	// re-chunks all of it, so a legitimate sweep over half the account is
	// ORDINARY rather than exceptional; and the storage ceilings are computed
	// from the committed index rather than from the chunks actually held, so
	// held-back chunks are charged to no cap at all. Never confirming means
	// garbage that grows without bound and is billed to nobody.
	//
	// WHAT IS CHECKED, AND WHAT IT PROTECTS. Nothing this client can compute
	// distinguishes a large deletion that is right from a narrow index that is
	// wrong — the shape is identical, which is exactly why the floor lives on the
	// server. So the conditions below do not try to; each rules out one way the
	// question could be being asked by something that is not in a position to ask
	// it, and everything else is reported rather than decided:
	//
	//   1. The device may still declare a live set AT THE MOMENT OF CONFIRMING.
	//      `syncMayCommitChunks()` is false whenever the workspace is not
	//      syncable, and such a device holds only its own view of the index. sync
	//      checks it before the first commit; this checks it again immediately
	//      before a destructive second request, which is the window where it can
	//      change.
	//   2. The index names something. An index naming NOTHING is the sharpest
	//      form of a client that knows nothing declaring the account empty, and
	//      it is what a workspace that failed to enumerate produces. This client
	//      never confirms one, whatever else is true.
	//   3. The gateway's arithmetic and this client's agree: every chunk the
	//      account holds is either one this commit named live or one it named
	//      doomed (`sweep_held - sweep_held_back === entries.length`). Where the
	//      two parties cannot agree on the size of the corpus, this client does
	//      not insist on the largest deletion the gateway will accept.
	//
	// Once per commit, never a loop, and a sweep that is not collected is left
	// standing on the chip rather than swallowed.
	var heldSweep = null;		// {body, n, m, token, why, at} while a deletion stands uncollected.
	var confirmed = 0;			// Large sweeps this page has carried out, for the verifier.
	var refusal   = null;		// {msg, status, at} while the gateway is turning uploads away.
	var persisted = false;		// Did the standing deletion actually reach localStorage?

	/// What the app says, in the reader's language, falling back to English while
	/// a key has no entry anywhere.
	///
	/// The twin of `tOr` in daimond.js and of `t` in legal.js: `DaimondI18n.t`
	/// answers with the KEY when the table has no entry, which would put
	/// `chunks.sweep_confirm_ok` on a button. The keys added with the control
	/// below are new and the locale tables are another lane's file, so each
	/// carries the English it means and the tables can catch up without this file
	/// ever showing a bare key.
	function t(k, fallback, v) {
		var i18n = window.DaimondI18n;
		if (i18n && i18n.has && i18n.has(k)) return i18n.t(k, v);
		return fallback == null ? k : fallback;
	}

	// ── A standing deletion outlives the page that found it ────
	//
	// `heldSweep` used to be a module variable and nothing else, which made the
	// whole feature a thing you had to be looking at to use: reload, and the body
	// and the token were gone. That matters more than losing a notice, because
	// THIS CLIENT CANNOT MINT A TOKEN. Only the gateway does, only in answer to a
	// commit, and only over the doomed set as it stood at that moment. So a
	// dropped token is not re-derivable here at all; it comes back when the next
	// commit round is held back in the same way, and on a device where sync is
	// not running — no Pro, a safe start, an unmerged workspace — that round never
	// comes. Meanwhile the chunks nobody refers to sit in the account's store, and
	// the storage ceilings are computed from the committed index rather than from
	// what is held, so they are charged to no cap and swept by nothing.
	//
	// WHAT IS WRITTEN. The commit body — content addresses, ciphertext sizes and a
	// one-letter tier — plus the token and the two counts. Hashes and numbers: the
	// same class of thing the chunk map beside it already keeps, and nothing that
	// says what any file is or contains.
	//
	// WHAT IT DOES NOT PROMISE. A restored token is only as good as the account it
	// was minted against. If another device has uploaded or committed since, the
	// gateway's digest no longer matches and the sweep is simply held back again
	// with a fresh token, which `standHeld` records. That is the interlock working,
	// not a failure, and it is why a stale entry is safe to keep rather than
	// something that has to be expired on a timer.
	var HELD_KEY = 'daimond-chunk-held';
	/// Roughly two thousand addresses. Above this the entry stays in memory only:
	/// localStorage is five megabytes for the whole origin and shared with the
	/// chunk map, the chats' spill and everything else, and evicting somebody's
	/// work to remember a deletion would be the wrong trade. `state().persisted`
	/// says which of the two happened rather than leaving it to be guessed.
	var HELD_MAX_BYTES = 256 * 1024;

	/// Whose deletion this is: the identity fingerprint, which is a prefix of the
	/// public key's digest and therefore not a secret.
	///
	/// STORED BECAUSE THE KEY OUTLIVES THE ACCOUNT. `forgetIdentity` in daimond.js
	/// sweeps a NAMED list of `daimond-*` keys for the primary account, and the
	/// primary's keys are un-namespaced — so anything not on that list is
	/// inherited whole by the next identity made in this browser. A held sweep is
	/// a commit body for an account that no longer exists: it would paint a chip
	/// for a stranger and, if pressed, send a token the gateway can only refuse.
	/// Binding the record to the fingerprint answers that here rather than by
	/// adding a line to a list in another lane's file — and it answers the same
	/// question for a restored backup and for switching accounts.
	function whoseFp() {
		try { return (window.DaimondIdentity && DaimondIdentity.fingerprint()) || ''; }
		catch (e) { return ''; }
	}

	function writeHeld() {
		persisted = false;
		if (!heldSweep) { try { localStorage.removeItem(HELD_KEY); } catch (e) { /* private mode */ } return; }
		var s;
		try { s = JSON.stringify({
			body:  heldSweep.body,
			n:     heldSweep.n,
			m:     heldSweep.m,
			token: heldSweep.token,
			why:   heldSweep.why,
			at:    heldSweep.at,
			fp:    whoseFp(),
		}); } catch (e) { return; }
		if (s.length > HELD_MAX_BYTES) {
			log('standing deletion too large to persist (', s.length, 'bytes ) — held in memory only');
			try { localStorage.removeItem(HELD_KEY); } catch (e) { /* private mode */ }
			return;
		}
		try { localStorage.setItem(HELD_KEY, s); persisted = true; }
		catch (e) { /* quota or private mode: it stands for this sitting only */ }
	}

	/// The standing deletion this device last recorded, or null.
	///
	/// Shape-checked rather than trusted: a half-written or hand-edited entry
	/// would otherwise become a commit body, and the one thing this file must
	/// never do is send a deletion it cannot account for.
	function readHeld() {
		var raw;
		try { raw = localStorage.getItem(HELD_KEY); } catch (e) { return null; }
		if (!raw) return null;
		var h;
		try { h = JSON.parse(raw); } catch (e) { return null; }
		if (!h || typeof h !== 'object') return null;
		if (!h.body || h.body.op !== 'commit' || !Array.isArray(h.body.chunks)) return null;
		if (typeof h.token !== 'string' || !h.token) return null;
		// Somebody else's deletion, or nobody's. Dropped rather than shown: see
		// `whoseFp`.
		var fp = whoseFp();
		if (!fp || h.fp !== fp) {
			try { localStorage.removeItem(HELD_KEY); } catch (e) { /* private mode */ }
			return null;
		}
		return {
			body:  h.body,
			n:     h.n | 0,
			m:     h.m | 0,
			token: h.token,
			why:   typeof h.why === 'string' ? h.why : '',
			at:    typeof h.at === 'number' ? h.at : 0,
		};
	}

	/// The chip that says something is standing, drawn beside sync's.
	///
	/// It is sync's chip in everything but ownership: same row, same shape, same
	/// `stalled` colour, standing rather than fading, reason on hover, and never
	/// a dialog over the app unasked. It is a separate element only because
	/// `setStatus` is private to sync.js and a held-back sweep outlives the round
	/// that found it — sync paints "Synced" the instant `commit` returns, so
	/// anything this file wrote into that chip would live for no time at all.
	///
	/// A BUTTON, AND THAT IS THE FIX. It was a `role="status"` div: a permanent
	/// amber pill saying a deletion was standing, with nothing anywhere in the app
	/// that could carry the deletion out. `confirmHeldSweep` — the only code that
	/// re-sends the body with its token — had no production caller at all, so the
	/// notice was the whole feature. The chip is where the fact already lives and
	/// the top bar is where this app already puts standing facts a person can act
	/// on (`#update-chip` is a button in the same row), so the control goes here.
	///
	/// The Credits drawer was the other candidate — it is where the app answers
	/// "what account have I got and what does it cost me", and cloud storage is
	/// part of that answer. It is not used, for a plain reason: `drawCredits`
	/// belongs to daimond.js, its one published extension point
	/// (`DaimondCredits.render`) is already taken by passcode.js, and a second
	/// surface for a fact that is already on screen is a second thing to keep in
	/// step. One control, where the notice is.
	///
	/// `aria-live` rather than `role="status"`: the live region has to move to the
	/// button, because a button containing a status region announces the region
	/// and leaves the control unnamed.
	var _chip = null;
	function chip() {
		if (_chip) return _chip;
		var actions = document.getElementById('top-actions') || document.querySelector('.top-actions');
		if (!actions) return null;
		if (!document.getElementById('chunk-status-styles')) {
			var st = document.createElement('style');
			st.id = 'chunk-status-styles';
			st.textContent =
				'#chunk-chip{display:none;align-items:center;gap:5px;font-size:var(--fs-xs);padding:3px 9px;' +
				'border-radius:999px;border:1px solid var(--border,#333);background:var(--bg-tertiary);' +
				// A deletion that did not happen is not an error and not a success:
				// something is standing that the operator can act on, which is what
				// --warn is for everywhere else in the app.
				'color:var(--warn);white-space:nowrap;cursor:pointer;font:inherit;font-size:var(--fs-xs)}' +
				'#chunk-chip:hover,#chunk-chip:focus-visible{border-color:var(--warn)}' +
				'#chunk-chip .cdot{width:6px;height:6px;border-radius:50%;background:currentColor}';
			document.head.appendChild(st);
		}
		var c = document.createElement('button');
		c.id = 'chunk-chip';
		c.type = 'button';			// never submit an enclosing form.
		c.setAttribute('aria-live', 'polite');
		c.innerHTML = '<span class="cdot" aria-hidden="true"></span><span class="ctext"></span>';
		c.addEventListener('click', function () { onChipClick(); });
		var sib = document.getElementById('sync-chip');
		if (sib && sib.parentNode === actions) actions.insertBefore(c, sib);
		else actions.appendChild(c);
		_chip = c;
		return c;
	}

	/// The reason sentence for the deletion that is standing.
	function heldReason() {
		return t('chunks.sweep_held_reason', 'Cloud storage holds pieces that no file '
			+ 'on this account still refers to. They have NOT been deleted, because no '
			+ 'single request may remove more than half of what is stored.',
			{ n: heldSweep ? heldSweep.n : 0, m: heldSweep ? heldSweep.m : 0 });
	}

	/// Show or hide the standing notice, and tell anything else that is watching.
	///
	/// A refused upload outranks a held-back deletion, because the two are not
	/// equally urgent: one means the user's work has stopped travelling, the other
	/// means some space has not been reclaimed yet. They compose rather than
	/// compete — "delete something, or ask for more room" and a deletion waiting to
	/// be authorised are the same conversation — so when both stand the chip says
	/// the refusal and the dialog behind it carries both.
	///
	/// The event mirrors gateway.js's `daimond:credits`: one place owns the fact
	/// and announces it, rather than every panel that wants it polling for it.
	function draw() {
		var c = chip();
		if (c) {
			if (!heldSweep && !refusal) c.style.display = 'none';
			else {
				var text  = refusal
					? t('chunks.upload_refused', 'Uploads paused')
					: t('chunks.sweep_held', 'Cleanup paused');
				var title = refusal ? refusal.msg : heldReason();
				c.querySelector('.ctext').textContent = text;
				c.title = title;
				c.setAttribute('aria-label', text + '. ' + title);
				c.style.display = 'inline-flex';
			}
		}
		try {
			window.dispatchEvent(new CustomEvent('daimond:chunks', { detail: state() }));
		} catch (e) { /* no window to tell */ }
	}

	/// The chip was pressed. Say what is standing, and offer the one act that
	/// answers it.
	///
	/// ASKED, ALWAYS. `confirmHeldSweep` deletes on a person's word rather than on
	/// the engine's, so the word has to be given here rather than assumed from a
	/// tap on a pill in a top bar. With no dialog to ask through — a stripped build,
	/// or this script running without the module — nothing is deleted: a
	/// destructive act with no way to put the question is not carried out. It is
	/// not escalated to `window.confirm` either, which is an OS box with the origin
	/// in its title and is exactly what `DaimondCore.confirm` exists to replace.
	async function onChipClick() {
		var core = window.DaimondCore;
		if (!core || !core.confirm) { log('no dialog available; the chip cannot ask'); return; }
		if (!heldSweep) {
			// A refusal on its own is a notice, not a question: there is nothing
			// here for the user to authorise. `cancelLabel: null` drops the second
			// button, which is how daimond.js's dialog draws one.
			if (!refusal) return;
			try {
				await core.confirm(refusal.msg, t('common.close', 'Close'), {
					title:       t('chunks.upload_refused_title', 'Cloud storage refused an upload'),
					danger:      false,
					cancelLabel: null,
				});
			} catch (e) { /* the dialog went with a redraw */ }
			return;
		}
		var message = (refusal ? refusal.msg + '\n\n' : '') + heldReason() + '\n\n'
			+ t('chunks.sweep_confirm_ask',
				'Delete them now? Nothing you can still see is touched, and the space is freed.');
		var yes = false;
		try {
			yes = await core.confirm(message,
				t('chunks.sweep_confirm_ok', 'Delete them'),
				{ title: t('chunks.sweep_confirm_title', 'Free the unreferenced pieces?') });
		} catch (e) { yes = false; }		// no answer is not a yes.
		if (!yes) return;
		await confirmHeldSweep();
	}

	/// Note a deletion the gateway would not carry out and this client would not
	/// insist on. `why` is the short reason, for the verifier and the log.
	///
	/// The commit body is kept beside it, because the only way to carry the
	/// deletion out later is to send that body again unchanged: the token names
	/// the doomed set, which the gateway derives from the live set in the body,
	/// so a rebuilt one would name a different deletion.
	function standHeld(body, n, m, token, why) {
		heldSweep = { body: body, n: n, m: m, token: token, why: why, at: Date.now() };
		writeHeld();
		log('sweep held back:', n, 'of', m, 'chunks not deleted —', why);
		draw();
	}

	/// Nothing is standing any more: the commit that just ran collected whatever
	/// the last one could not.
	function noteCollected() {
		if (!heldSweep) return;
		heldSweep = null;
		writeHeld();
		draw();
	}

	/// The gateway turned an upload away, in its own words.
	///
	/// NOT PERSISTED, and the asymmetry with `heldSweep` is the point rather than
	/// an oversight. A refusal is re-derived by the very next upload attempt: the
	/// ceiling is still there, the store is still full, and the sentence comes back
	/// unchanged. A sweep token is not re-derivable by this client at all. Keeping
	/// a refusal across a reload would therefore only risk showing a ceiling that
	/// has since been raised.
	function standRefused(msg, status) {
		refusal = { msg: String(msg || ''), status: status | 0, at: Date.now() };
		log('upload refused:', status, msg);
		draw();
	}

	/// Uploads are working again.
	function clearRefused() {
		if (!refusal) return;
		refusal = null;
		draw();
	}

	/// The gateway names the free allowance it grants, so the next tiering can be
	/// honest about which files fit inside it.
	function noteAllowance(j) {
		if (window.DaimondCloud && j && typeof j.free_allowance === 'number') {
			DaimondCloud.setAllowance(j.free_allowance);
		}
	}

	/// Why this client will not confirm a held-back sweep, or '' when it will.
	/// The three conditions are argued at the head of this section.
	function refusalToConfirm(entries, n, m) {
		var may = window.DaimondCore && DaimondCore.syncMayCommitChunks
			&& DaimondCore.syncMayCommitChunks();
		if (!may)						return 'not_merged';
		if (!entries.length)			return 'names_nothing';
		if (m - n !== entries.length)	return 'unaccounted';
		return '';
	}

	/// Answer a held-back sweep: confirm it if this client may, and otherwise
	/// leave it standing and say so. Returns the reply to hand back to sync.
	async function answerHeldBack(body, j) {
		var n = j.sweep_held_back | 0, m = j.sweep_held | 0;
		var why = refusalToConfirm(body.chunks, n, m);
		if (why) { standHeld(body, n, m, j.sweep_token, why); return j; }

		// The IDENTICAL commit, quoting what the gateway said it was about to
		// delete. Identical to the byte: the token is over the doomed set, which
		// the gateway derives from the live set in this body, so a body that
		// differed anywhere in `chunks` would name a different deletion and be
		// held back again.
		body.sweep_token = j.sweep_token;
		var res;
		try { res = await call(body); }
		finally { delete body.sweep_token; }
		if (res.status !== 200 || !res.json || !res.json.ok) {
			standHeld(body, n, m, j.sweep_token, 'refused');
			return j;
		}
		noteAllowance(res.json);
		if (res.json.sweep_token) {
			// Held back a second time: the account's chunks moved between the two
			// requests, so the token no longer names this deletion. One attempt
			// only — a loop here would be a client insisting until it got its way,
			// which is the behaviour the floor exists to stop.
			standHeld(body, res.json.sweep_held_back | 0, res.json.sweep_held | 0,
				res.json.sweep_token, 'moved');
			return res.json;
		}
		confirmed++;
		noteCollected();
		log('confirmed a large sweep:', res.json.swept, 'of', m, 'chunks removed');
		return res.json;
	}

	/// Declare the live, tiered chunk set to the gateway and let it sweep
	/// everything unreferenced. `manifests` is the map of `{path: manifest}` in
	/// the state just pushed; every chunk it names is committed as paid overflow.
	///
	/// `blobVersion` is the sync blob version this set was derived from. The
	/// gateway refuses to sweep for a device naming a version older than the one
	/// it holds, because such a device cannot know about a file another device
	/// added — and a sweep on its word would delete that file's chunks.
	///
	/// A sweep over the gateway's floor comes back undone, with a token: see
	/// `answerHeldBack` for when this client confirms one and when it does not.
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
		noteAllowance(res.json);
		if (res.json.sweep_token) return await answerHeldBack(body, res.json);
		noteCollected();
		log('committed', entries.length, 'live chunks; swept', res.json.swept);
		return res.json;
	}

	/// Carry out a deletion this client declined to confirm on its own.
	///
	/// The escape hatch for the one case the conditions above deliberately never
	/// clear by themselves — an index that names nothing, on an account that
	/// really has been emptied — and the only thing in this file that deletes on
	/// a person's word rather than the engine's. It re-sends the commit exactly
	/// as it stood, so a set that has moved since is refused by the token.
	///
	/// Reached from the chip, through `onChipClick`, which asks first.
	async function confirmHeldSweep() {
		if (!heldSweep || !heldSweep.body) return null;
		var body = heldSweep.body;
		body.sweep_token = heldSweep.token;
		var res;
		try { res = await call(body); }
		finally { delete body.sweep_token; }
		if (res.status !== 200 || !res.json || !res.json.ok) {
			// The person asked for this, so they are told why it did not happen —
			// in the gateway's own words, which name the remedy. A stale
			// `blob_version` answers 409 with "pull, merge and commit again", and
			// returning a bare null left them pressing a chip that did nothing.
			standRefused((res.json && (res.json.error || res.json.message))
				|| ('HTTP ' + res.status), res.status);
			return null;
		}
		clearRefused();
		noteAllowance(res.json);
		if (res.json.sweep_token) {
			standHeld(body, res.json.sweep_held_back | 0, res.json.sweep_held | 0,
				res.json.sweep_token, 'moved');
			return res.json;
		}
		confirmed++;
		noteCollected();
		return res.json;
	}

	/// What this file would say if asked — the same facts the chip shows, in
	/// words, for anything that needs them other than as a coloured pill.
	function state() {
		return {
			/// A deletion the gateway would not carry out and this client did not
			/// insist on. Standing until a commit collects it.
			heldBack:  heldSweep ? heldSweep.n : 0,
			held:      heldSweep ? heldSweep.m : 0,
			/// '' | 'not_merged' | 'names_nothing' | 'unaccounted' | 'refused' | 'moved'
			why:       heldSweep ? heldSweep.why : '',
			since:     heldSweep ? heldSweep.at : 0,
			standing:  !!heldSweep,
			/// Did the standing deletion reach localStorage, so a reload keeps it?
			/// False when nothing is standing, and false when the body was too
			/// large to store — which is a real difference and not a detail.
			persisted: persisted && !!heldSweep,
			/// The gateway's own sentence for the upload it last turned away, or
			/// ''. Its words, not a status code: it is the half that names the
			/// remedy.
			refused:       refusal ? refusal.msg : '',
			refusedStatus: refusal ? refusal.status : 0,
			/// Large sweeps this page has confirmed, for the verifier.
			confirmed: confirmed,
		};
	}

	// ── Boot ───────────────────────────────────────────────────
	//
	// Pick up a deletion an earlier sitting left standing, and paint it. Read ONCE,
	// here: a re-read on every repaint would overwrite a sweep that is standing in
	// memory because it was too large to store, which is the one case where the two
	// disagree.
	//
	// `draw` is then registered with `DaimondI18n.onChange`, which fires when the
	// locale table lands as well as on a language change — so the first paint may
	// carry the English fallbacks and the second carries the reader's own words.
	(function restore() {
		heldSweep = readHeld();
		if (heldSweep) {
			persisted = true;
			log('a deletion was left standing:', heldSweep.n, 'of', heldSweep.m, '—', heldSweep.why);
		}
		draw();
		if (window.DaimondI18n && DaimondI18n.onChange) DaimondI18n.onChange(draw);
	})();

	// ── Public surface ─────────────────────────────────────────
	window.DaimondChunks = {
		offloadFile:       offloadFile,			// (path, File) -> manifest v2
		materialiseStream: materialiseStream,	// (manifest, write) -> bool
		materialiseV1:     materialiseV1,		// (manifest) -> text|null, old files only
		chunkSizeFor:      chunkSizeFor,
		commit:            commit,				// ({path: manifest}, version) -> {swept,...}|null
		/// A deletion this client declined to confirm, carried out on a person's
		/// word. Reached from the chip in the top bar, which asks first; exported
		/// as well so a verifier can drive the act without driving a dialog.
		confirmHeldSweep:  confirmHeldSweep,
		state:             state,
		/// Is a re-offload owed because the passphrase changed? Read by
		/// `collectChunked` in daimond.js, which suspends its unchanged-file skip
		/// for exactly one round when it is set, and clears it when that round is
		/// done. See "Surviving a passphrase change" above.
		staleSinceRekey:   staleSinceRekey,
		clearStale:        clearStale,
		// exposed for tests/tools:
		_b64urlEncode: b64urlEncode,
		_b64urlDecode: b64urlDecode,
		_sha256Hex:    sha256Hex,
	};
})();
