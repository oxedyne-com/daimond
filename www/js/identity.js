/* ============================================================
   Daimond — on-device passphrase identity (identity.js)
   ------------------------------------------------------------
   A local, browser-only identity primitive for Daimond, mirroring
   Oxegen's own model: an on-device signing keypair whose secret
   never leaves the device, unlocked by a passphrase. The same
   passphrase-derived key also encrypts the user's bring-your-own
   API key (BYOK) at rest, so daimond.js can persist the key wrapped
   instead of in plaintext.

   Everything here uses the browser-native WebCrypto API
   (`crypto.subtle`) only — no external dependencies, no CDN, no
   bundler. The single global `window.DaimondIdentity` is attached at
   the bottom, matching the IIFE-module convention of daimond.js.

   THREAT MODEL
   ------------
   This protects against casual local inspection and shared-device
   snooping: an onlooker who opens DevTools or reads localStorage
   finds only a random salt, a public key, a fingerprint, and two
   AES-GCM ciphertexts (the wrapped private key and the wrapped API
   key). The passphrase is never stored, and the derived wrapping
   key exists only in memory while unlocked and is non-extractable.

   It does NOT protect against a compromised browser, a malicious
   extension, a keylogger, or any attacker who observes the
   passphrase as it is typed or reads process memory while the
   identity is unlocked. Those adversaries defeat any in-browser
   scheme and are out of scope. PBKDF2 raises the cost of an
   offline brute-force against a weak passphrase, but a weak
   passphrase remains the weakest link.
   ============================================================ */
(function () {
	'use strict';

	/// What the app says.
	function t(k, v) { return window.DaimondI18n ? DaimondI18n.t(k, v) : k; }

	/// A string from the table, or the English written here where the table has no
	/// entry for it yet. The same device voice.js and search.js use, so a sentence
	/// added before its translation reads as a sentence and not as a key.
	function tOr(key, fallback, vars) {
		var s = t(key, vars);
		return (s !== key) ? s : fallback;
	}

	// ── Parameters ─────────────────────────────────────────────
	// PBKDF2 work factor. High by design so an offline guess against
	// the stored ciphertexts is expensive. Exposed as a constant so
	// it can be tuned in one place; changing it invalidates existing
	// identities (they must be recreated), which is acceptable as
	// nothing is deployed publicly yet.
	var PBKDF2_ITERATIONS = 600000;	// PBKDF2-SHA-256 rounds.
	var SALT_BYTES        = 16;		// Per-install random salt length.
	var IV_BYTES          = 12;		// AES-GCM nonce length.
	var AES_BITS          = 256;		// AES-GCM key length.

	// ── localStorage keys ──────────────────────────────────────
	// All identity state is namespaced under `daimond-id-`. None of these
	// ever holds the passphrase or the derived key.
	var K_SALT = 'daimond-id-salt';		// base64 PBKDF2 salt.
	var K_PUB  = 'daimond-id-pub';		// base64 raw public key (device identity).
	var K_PRIV = 'daimond-id-priv';		// base64 wrapped (encrypted) pkcs8 private key.
	var K_ALG  = 'daimond-id-alg';		// 'Ed25519' | 'ECDSA-P256'.
	var K_FP   = 'daimond-id-fp';		// CACHED fingerprint rendering. See fingerprint().
	var K_NAME = 'daimond-id-name';		// the user's chosen display name.
	var K_HDL  = 'daimond-id-handle';	// the ACCOUNT's public handle: {h, t}. See below.
	// The sealing subkey: a SECOND keypair, for receiving sealed messages. Separate
	// from the signing pair on purpose — see the note above `ensureSealingKey`.
	var K_SEALP = 'daimond-id-sealpub';	// base64 raw public sealing key (32 bytes).
	var K_SEALK = 'daimond-id-seal';	// base64 wrapped (encrypted) pkcs8 sealing key.
	var K_SEALA = 'daimond-id-sealalg';	// 'X25519'. The only one a card can carry.
	var K_CARD  = 'daimond-id-card';	// base64 of this identity's signed card. See mintCard().

	// ── In-memory state (present only while unlocked) ──────────
	// All three are dropped by lock(); none is ever persisted.
	var _wrapKey = null;	// AES-GCM CryptoKey deriving from the passphrase.
	var _signKey = null;	// Device private signing key (non-extractable).
	var _sealKey = null;	// Device private SEALING key (non-extractable). See ensureSealingKey.
	// Pure-JS fallback material, set ONLY on an engine whose WebCrypto lacks the
	// curve, and null otherwise. Unlike the CryptoKeys above these hold the RAW
	// private key in JS memory — see curvefallback.js for why that is accepted
	// and how it is contained. Never logged, never transmitted, zeroed on lock().
	var _signSeed   = null;	// 32-byte Ed25519 seed, when WebCrypto cannot load it.
	var _sealScalar = null;	// 32-byte X25519 scalar, when WebCrypto cannot load it.

	// ── Encoding helpers ───────────────────────────────────────

	/// Encode a UTF-8 string to a Uint8Array.
	function utf8(str) {
		return new TextEncoder().encode(String(str));
	}

	/// Decode a Uint8Array (or ArrayBuffer) of UTF-8 to a string.
	function fromUtf8(buf) {
		return new TextDecoder().decode(buf);
	}

	/// Base64-encode raw bytes (accepts an ArrayBuffer or a view).
	function b64enc(buf) {
		var bytes = (buf instanceof Uint8Array) ? buf : new Uint8Array(buf);
		var bin = '';
		for (var i = 0; i < bytes.length; i++) {
			bin += String.fromCharCode(bytes[i]);
		}
		return btoa(bin);
	}

	/// Decode a base64 string to a Uint8Array.
	function b64dec(str) {
		var bin = atob(String(str));
		var out = new Uint8Array(bin.length);
		for (var i = 0; i < bin.length; i++) {
			out[i] = bin.charCodeAt(i);
		}
		return out;
	}

	// ── Capability probe ───────────────────────────────────────

	/// True when the browser exposes the WebCrypto surface this
	/// module needs. Callers should gate the identity UI on this.
	function available() {
		return typeof crypto !== 'undefined'
			&& !!crypto.subtle
			&& typeof crypto.subtle.deriveKey === 'function'
			&& typeof crypto.getRandomValues === 'function';
	}

	/// The pure-JS curve fallback, or null when it is not loaded or not usable.
	/// Consulted ONLY after a WebCrypto importKey/deriveBits has thrown for want
	/// of Ed25519 or X25519 support; WebCrypto stays the default everywhere else.
	function curveFallback() {
		var f = (typeof window !== 'undefined' && window.DaimondCurveFallback) || null;
		return (f && f.available()) ? f : null;
	}

	/// Does this engine implement Ed25519 signing in WebCrypto? Probed by
	/// generating a key, since that is the call that actually fails on the
	/// engines this concerns and nothing else answers it.
	async function signingAvailable() {
		try {
			await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
			return true;
		} catch (e) {
			return false;
		}
	}

	// ── Cryptographic primitives ───────────────────────────────

	/// Derive the AES-GCM 256 wrapping key from a passphrase and salt
	/// via PBKDF2-SHA-256. The result is non-extractable and usable
	/// only for encrypt/decrypt, so it can never be read back out.
	async function deriveWrapKey(passphrase, saltBytes) {
		var base = await crypto.subtle.importKey(
			'raw',
			utf8(passphrase),
			{ name: 'PBKDF2' },
			false,
			['deriveKey'],
		);
		return await crypto.subtle.deriveKey(
			{
				name:       'PBKDF2',
				salt:       saltBytes,
				iterations: PBKDF2_ITERATIONS,
				hash:       'SHA-256',
			},
			base,
			{ name: 'AES-GCM', length: AES_BITS },
			false,				// non-extractable.
			['encrypt', 'decrypt'],
		);
	}

	/// Encrypt raw bytes under an AES-GCM key with a fresh random IV.
	/// The output is base64 of `IV(12) || ciphertext(+tag)` — the IV
	/// is prefixed so a matching unwrap needs only the key. Ciphertext
	/// encoding format for all wrapped blobs in this module.
	async function seal(key, plainBytes) {
		var iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
		var ct = await crypto.subtle.encrypt(
			{ name: 'AES-GCM', iv: iv },
			key,
			plainBytes,
		);
		var ctBytes = new Uint8Array(ct);
		var out = new Uint8Array(iv.length + ctBytes.length);
		out.set(iv, 0);
		out.set(ctBytes, iv.length);
		return b64enc(out);
	}

	/// Decrypt a base64 `IV(12) || ciphertext` blob produced by seal().
	/// Rejects (throws) on a wrong key or tampered ciphertext — the
	/// GCM authentication failure. Callers that treat that as "wrong
	/// passphrase" must catch it rather than let it propagate.
	async function open(key, b64) {
		var buf = b64dec(b64);
		var iv  = buf.slice(0, IV_BYTES);
		var ct  = buf.slice(IV_BYTES);
		var pt  = await crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv: iv },
			key,
			ct,
		);
		return new Uint8Array(pt);
	}

	/// Generate the device signing keypair. Ed25519 is preferred;
	/// browsers that do not implement it throw, and we fall back to
	/// ECDSA over P-256. Returns `{ pair, alg }` where `alg` is the
	/// tag stored in localStorage and consulted on every sign/import.
	async function generatePair() {
		try {
			var pair = await crypto.subtle.generateKey(
				{ name: 'Ed25519' },
				true,					// extractable so we can wrap the private key.
				['sign', 'verify'],
			);
			return { pair: pair, alg: 'Ed25519' };
		} catch (e) {
			// Ed25519 unsupported on this engine — fall back to P-256.
			var p = await crypto.subtle.generateKey(
				{ name: 'ECDSA', namedCurve: 'P-256' },
				true,
				['sign', 'verify'],
			);
			return { pair: p, alg: 'ECDSA-P256' };
		}
	}

	/// The WebCrypto algorithm descriptor for importing a private key
	/// of the stored algorithm from its pkcs8 encoding.
	function importAlg(alg) {
		return alg === 'Ed25519'
			? { name: 'Ed25519' }
			: { name: 'ECDSA', namedCurve: 'P-256' };
	}

	/// The signing-algorithm descriptor for the stored algorithm.
	/// Ed25519 signs raw; ECDSA needs an explicit hash.
	function signAlg(alg) {
		return alg === 'Ed25519'
			? { name: 'Ed25519' }
			: { name: 'ECDSA', hash: 'SHA-256' };
	}

	// ── The sealing subkey ─────────────────────────────────────
	//
	// A SECOND keypair, X25519, for receiving sealed messages. It is not the
	// signing key and it must not be, for a reason that is about lifetimes rather
	// than tidiness: a signature is checked once and thrown away, so a signing
	// scheme may be replaced whenever a better one arrives, while anything sealed
	// to an encryption key must stay openable for as long as the message matters.
	// One key doing both jobs cannot be retired for the first without abandoning
	// the second.
	//
	// X25519 AND NOTHING ELSE. The signing pair falls back to ECDSA P-256 on an
	// engine without Ed25519, and this one deliberately does not fall back at all.
	// An identity card fixes the sealing key at EXACTLY 32 bytes; a raw P-256
	// public key is 65. A fallback key would therefore be a key that works until
	// the moment somebody tries to put it in a card, which is worse than not
	// having one: this way `sealingKeyRaw()` answers null and the reason can be
	// said out loud.
	//
	// It is generated LAZILY, by `ensureSealingKey`, and not only at creation.
	// Every identity that already exists on a device was made before this key did,
	// so a routine that only ran at `create()` would leave every existing user
	// without one for ever.

	/// True when this engine implements X25519 in WebCrypto.
	///
	/// Probed by generating a key rather than by reading a version, since the
	/// question is whether the call works and nothing else answers that.
	async function sealingAvailable() {
		try {
			await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
			return true;
		} catch (e) {
			return false;
		}
	}

	/// The raw public sealing key (32 bytes), or null when there is none.
	/// Public, so this works whether locked or not.
	function sealingKeyRaw() {
		var raw = localStorage.getItem(K_SEALP);
		return raw ? b64dec(raw) : null;
	}

	/// Generate and store a sealing keypair if this identity has none.
	///
	/// Unlocked only, because the private half is wrapped under the SAME
	/// passphrase-derived key that wraps the signing key and the API key. Not a
	/// second scheme: a second way of encrypting a secret at rest is how one of
	/// the two stops being reviewed.
	///
	/// Answers `{ ok, made }` — whether there is a sealing key now, and whether
	/// this call is what made it. `{ ok:false }` on an engine without X25519, and
	/// on a failure to store, both of which leave the identity exactly as it was.
	async function ensureSealingKey() {
		requireUnlocked();
		if (localStorage.getItem(K_SEALK) && localStorage.getItem(K_SEALP)) {
			return { ok: true, made: false };
		}
		var pair;
		try {
			pair = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
		} catch (e) {
			// No WebCrypto X25519 here. Make the key with the pure-JS fallback so
			// an identity created (or catching up) on such an engine can still
			// RECEIVE sealed messages. The stored pkcs8 is the same shape a modern
			// browser emits, so this same identity opened elsewhere imports it
			// unchanged. Raw scalar in memory — see the security note.
			var fbGen = curveFallback();
			if (!fbGen) return { ok: false, made: false };
			try {
				var scalar  = fbGen.randomXScalar();
				var jsPkcs8 = fbGen.xPkcs8FromScalar(scalar);
				var jsPub   = new Uint8Array(fbGen.xPublicKey(scalar));
				var jsWrap  = await seal(_wrapKey, jsPkcs8);
				localStorage.setItem(K_SEALP, b64enc(jsPub));
				localStorage.setItem(K_SEALK, jsWrap);
				localStorage.setItem(K_SEALA, 'X25519');
				_sealKey    = null;
				_sealScalar = scalar;
				fbGen.zero(jsPkcs8);
			} catch (e2) {
				return { ok: false, made: false };
			}
			return { ok: true, made: true };
		}
		try {
			var pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
			var pub   = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
			var wrapped = await seal(_wrapKey, pkcs8);
			localStorage.setItem(K_SEALP, b64enc(pub));
			localStorage.setItem(K_SEALK, wrapped);
			localStorage.setItem(K_SEALA, 'X25519');
			// Re-imported non-extractable, so what stays in memory cannot be read
			// back out even by this file. The extractable one above existed only
			// long enough to be wrapped.
			_sealKey = await crypto.subtle.importKey(
				'pkcs8', pkcs8, { name: 'X25519' }, false, ['deriveBits']);
		} catch (e) {
			return { ok: false, made: false };
		}
		return { ok: true, made: true };
	}

	/// Load the sealing key into memory from what is stored, under the wrapping
	/// key already derived. Silent when there is none: an identity without a
	/// sealing key is not broken, it is one that has not made one yet.
	async function loadSealingKey(wrapKey) {
		_sealKey    = null;
		_sealScalar = null;
		var wrapped = localStorage.getItem(K_SEALK);
		if (!wrapped) return;
		var pkcs8;
		try {
			pkcs8 = await open(wrapKey, wrapped);
		} catch (e) {
			return;		// wrong key or tampered store — nothing to load.
		}
		try {
			_sealKey = await crypto.subtle.importKey(
				'pkcs8', pkcs8, { name: 'X25519' }, false, ['deriveBits']);
		} catch (e) {
			// The blob decrypted, so this is an engine without WebCrypto X25519,
			// not a bad key. Fall back to the pure-JS scalar so sealed messages
			// still open here. See the security note in curvefallback.js.
			var fb = curveFallback();
			if (fb) {
				try { _sealScalar = fb.xScalarFromPkcs8(pkcs8); }
				catch (e2) { _sealScalar = null; }
			}
		}
	}

	/// The shared secret with another party's sealing key, as raw bytes.
	///
	/// ECDH over X25519, which answers 32 bytes. It is the INPUT to a key
	/// derivation and never a key itself: raw ECDH output is not uniformly
	/// distributed and using it directly as an AES key is the classic way to
	/// spend a good primitive badly. Unlocked only.
	async function sharedSecret(theirPubBytes) {
		requireUnlocked();
		if (!_sealKey && !_sealScalar) {
			throw new Error(tOr('identity.err_no_sealing_key',
				'This device has no sealing key, so it cannot open a sealed message. '
				+ 'Unlock the identity once and one will be made.'));
		}
		if (_sealScalar) {
			// Pure-JS path: bit-identical to the deriveBits below for the same
			// keys. Only reached on an engine without WebCrypto X25519.
			var their = (theirPubBytes instanceof Uint8Array)
				? theirPubBytes : new Uint8Array(theirPubBytes);
			return new Uint8Array(curveFallback().xSharedSecret(_sealScalar, their));
		}
		var theirs = await crypto.subtle.importKey(
			'raw', theirPubBytes, { name: 'X25519' }, false, []);
		var bits = await crypto.subtle.deriveBits(
			{ name: 'X25519', public: theirs }, _sealKey, 256);
		return new Uint8Array(bits);
	}

	// ── The fingerprint, and the one place it is computed ──────
	//
	// A fingerprint is a SHORT RENDERING OF A KEY FOR A PERSON'S EYE, AND IT
	// DECIDES NOTHING. Equality is always the full public key, everywhere,
	// without exception: eighty bits is well within reach of somebody who wants
	// two keys to look alike in a list, so anything that COMPARED fingerprints
	// to decide whether two keys are the same would be a defect.
	//
	// It is computed in ONE place, `card::fingerprint` in the format's own crate,
	// reached from here through the wasm bridge. This file used to render its
	// own — the first eight bytes of SHA-256, in hex — and the format's crate
	// rendered another, and the gateway rendered a third. Three renderings of one
	// key is three chances for a user to be shown something that reads as their
	// correspondent's key having CHANGED when nothing changed but which function
	// drew it. So there is one, and this is not it: this asks for it.
	//
	// THE BRIDGE. `identity.js` is a classic script and cannot `import` the wasm
	// module; `daimond.js` is the ES module that can, and surfaces what classic
	// scripts need on globals (`window.DaimondQR` is the same arrangement). The
	// contract is one function:
	//
	//     window.DaimondCrypto.fingerprint(Uint8Array) -> String
	//
	// A rendering is NOT computed when the bridge is absent. Falling back to a
	// second implementation written here is exactly the thing this comment is
	// about, and showing nothing is honest where showing a different rendering is
	// not.

	/// The wasm bridge, or null before it is up.
	function bridge() {
		return (typeof window !== 'undefined' && window.DaimondCrypto) || null;
	}

	/// The fingerprint of a raw public key, or null when the bridge is not up.
	function fingerprintOf(pubBytes) {
		var b = bridge();
		if (!b || typeof b.fingerprint !== 'function' || !pubBytes) return null;
		try { return b.fingerprint(pubBytes) || null; }
		catch (e) { return null; }
	}

	/// Recompute the cached rendering from the stored public key, and return it.
	///
	/// `K_FP` is a CACHE, not a fact: the fact is the public key, and the rendering
	/// is a function of it. Cached because `fingerprint()` below is called
	/// synchronously all over the app and the bridge is not up at the first paint;
	/// recomputed here at every unlock so a stale rendering — one written by an
	/// older build under a rendering that has since been retired — is replaced the
	/// first time this build runs.
	function refreshFingerprint() {
		var raw = localStorage.getItem(K_PUB);
		if (!raw) return null;
		var fp = fingerprintOf(b64dec(raw));
		if (!fp) return localStorage.getItem(K_FP) || null;
		if (fp !== localStorage.getItem(K_FP)) localStorage.setItem(K_FP, fp);
		return fp;
	}

	// ── Lifecycle ──────────────────────────────────────────────

	/// True when an identity has already been created on this device.
	function exists() {
		return !!(localStorage.getItem(K_PRIV) && localStorage.getItem(K_PUB));
	}

	/// True while the identity is unlocked and key material is in memory.
	function isUnlocked() {
		return !!_wrapKey && (!!_signKey || !!_signSeed);
	}

	/// Announce that `isUnlocked()` has changed answer.
	///
	/// EVERY MODULE THAT KEEPS AN ENCRYPTED STORE READS IT LAZILY, and the lazy
	/// read is written against a boot in which the identity is already unlocked.
	/// It is not: the page loads, the modules attach at `DOMContentLoaded`, and
	/// the passphrase is typed afterwards -- so a store read on attach is read
	/// while locked, gets nothing, and is never asked again for the whole
	/// session. post.js sat unread that way for every session in which the
	/// Messages panel was not opened by hand: its record was left off the sync
	/// parcel, an arriving one was dropped, and the badge whose only job is to
	/// say "open the panel" could not count until the panel had been opened.
	///
	/// So the boundary says so, in both directions, and a store that wants to be
	/// live listens rather than guessing. `daimond:handle` above is the same
	/// pattern; nothing here knows who is listening.
	function announce(what) {
		try { window.dispatchEvent(new Event('daimond:' + what)); }
		catch (e) { /* no window */ }
	}

	/// The public-key fingerprint for display, or null. Works whether or not the
	/// identity is unlocked, since it is public.
	///
	/// Synchronous, and so served from the cache `refreshFingerprint` writes. A
	/// build that has never had the bridge up shows nothing rather than a
	/// rendering nobody else draws.
	function fingerprint() {
		return localStorage.getItem(K_FP) || null;
	}

	/// Guard used by the unlocked-only operations. Throws a clear,
	/// secret-free error when called while locked.
	function requireUnlocked() {
		if (!isUnlocked()) {
			throw new Error(t('identity.err_locked'));
		}
	}

	/// Create a fresh identity from a passphrase. Generates the salt
	/// and signing keypair, wraps the private key under the derived
	/// AES-GCM key, and persists salt, public key, wrapped private
	/// key, algorithm tag and fingerprint. Leaves the identity
	/// UNLOCKED (wrapping key and signing key in memory) and returns
	/// `{ fingerprint }`. Any pre-existing identity is overwritten, so
	/// callers should confirm with the user or call reset() first.
	async function create(name, passphrase) {
		if (!available()) {
			throw new Error(t('identity.err_no_webcrypto'));
		}

		// Fresh per-install salt.
		var salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
		var wrapKey = await deriveWrapKey(passphrase, salt);

		// Device keypair (Ed25519, else ECDSA P-256).
		var gen = await generatePair();
		var alg = gen.alg;

		// Export and wrap the private key; export the public identity.
		var pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', gen.pair.privateKey));
		var wrapped = await seal(wrapKey, pkcs8);
		var pubBytes = new Uint8Array(await crypto.subtle.exportKey('raw', gen.pair.publicKey));

		// Persist. No secret and no derived key is ever written.
		localStorage.setItem(K_SALT, b64enc(salt));
		localStorage.setItem(K_PUB,  b64enc(pubBytes));
		localStorage.setItem(K_PRIV, wrapped);
		localStorage.setItem(K_ALG,  alg);
		localStorage.setItem(K_NAME, String(name || '').trim());
		// A fresh identity carries no sealing key and no card yet, and this may be
		// overwriting one that did. Left-over keys of a DIFFERENT identity are worse
		// than none: a card would name a sealing key nobody holds the other half of.
		localStorage.removeItem(K_SEALP);
		localStorage.removeItem(K_SEALK);
		localStorage.removeItem(K_SEALA);
		localStorage.removeItem(K_CARD);
		localStorage.removeItem(K_FP);

		// Leave unlocked: keep the wrapping key and the signing key.
		_wrapKey = wrapKey;
		_signKey = gen.pair.privateKey;
		announce('unlock');

		// The sealing key is made here so a new identity can be messaged from the
		// moment it exists. A failure is not fatal to creating an identity — an
		// engine without X25519 still signs, still syncs, still holds an API key —
		// so it is not raised; `ensureSealingKey` will try again at every unlock.
		await ensureSealingKey();

		var fp = refreshFingerprint();
		return { fingerprint: fp, name: displayName() };
	}

	/// The user's chosen display name. Local to this device: it labels the
	/// device keypair, it is not a server account, and there is no password
	/// stack behind it — the passphrase is what actually unlocks anything.
	function displayName() {
		return localStorage.getItem(K_NAME) || '';
	}

	/// Rename, while unlocked. The name is a label, so this touches no key
	/// material.
	function rename(name) {
		requireUnlocked();
		localStorage.setItem(K_NAME, String(name || '').trim());
		return displayName();
	}

	// ── The account's public handle ────────────────────────────
	//
	// NOT `displayName()` above, and the difference is the whole of why this
	// exists. That name labels THIS DEVICE'S KEYPAIR: it lives only here, it
	// does not travel, and nobody else ever sees it. This one belongs to the
	// ACCOUNT, rides the sync parcel so every device of the account agrees, and
	// is what another person sees -- the name a Diamond is shared with, and the
	// name a rating is attributed to. Two different things that both read as "a
	// name", which is exactly why the wrong one is easy to reach for.
	//
	// THE GATEWAY OWNS IT. The handle is minted there at registration and every
	// stamp on it is the gateway's clock, not this browser's. Nothing in this
	// file invents either half, and that is not a detail: the record travels in
	// the sync parcel, `push()` skips the wire only while two collects give the
	// same bytes, and a field this device restamped on the way past would make
	// every parcel differ from the last one sent. Two devices then push at each
	// other for ever -- which has happened here once, over a pairing name.
	//
	// So both halves are copied verbatim from the server, and the merge below
	// takes the larger record rather than writing one of its own.

	/// The account's handle as stored, or `null` when there is none yet.
	///
	/// `{h, t}`: the name, and the server's stamp for when it was minted or
	/// renamed. Null is the honest answer for an account that has never reached
	/// the gateway -- Daimond runs on a BYOK key with no account at all, and
	/// such an account has no public name because there is no namespace to have
	/// one in.
	function handleRecord() {
		try {
			var raw = localStorage.getItem(K_HDL);
			if (!raw) return null;
			var rec = JSON.parse(raw);
			return saneHandle(rec);
		} catch (e) { return null; }
	}

	/// What is a handle record, and nothing else. A hand-edited or half-written
	/// store must not be able to put an object, or a name of any shape at all,
	/// in front of other people.
	function saneHandle(rec) {
		if (!rec || typeof rec !== 'object') return null;
		var h = (typeof rec.h === 'string') ? rec.h.trim().toLowerCase() : '';
		var t = Number(rec.t);
		if (!h || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(h) || h.indexOf('--') !== -1) return null;
		if (h.length < 3 || h.length > 24) return null;
		return { h: h, t: (isFinite(t) && t > 0) ? Math.floor(t) : 0 };
	}

	/// The handle as a string, or `''`.
	function handle() {
		var rec = handleRecord();
		return rec ? rec.h : '';
	}

	/// The handle as it travels in the sync parcel.
	///
	/// A FIXED SHAPE, always: three keys in one order, whether or not there is a
	/// handle to carry. A section that appears and disappears is a parcel that
	/// differs from the last one for a reason that has nothing to do with the
	/// user's work.
	function handleSnapshot() {
		var rec = handleRecord();
		return { v: 1, h: rec ? rec.h : '', t: rec ? rec.t : 0 };
	}

	/// Whether an incoming record beats the one held, under a total order both
	/// devices compute the same way.
	///
	/// The later stamp wins. On an equal stamp -- two devices that heard about
	/// the same rename -- the lexicographically smaller name wins, which is
	/// arbitrary but SYMMETRIC: both devices reach the same answer whichever
	/// parcel arrives first, so the pair converges instead of taking turns.
	function handleBeats(incoming, mine) {
		if (!incoming) return false;
		if (!mine) return true;
		if (incoming.t !== mine.t) return incoming.t > mine.t;
		return incoming.h < mine.h;
	}

	/// Take a handle record the gateway has just handed this device in answer to
	/// its OWN request. Returns true when this device moved.
	///
	/// Authoritative, where `adoptHandle` below is a merge, and the difference
	/// matters exactly once: when this device is holding a record whose stamp is
	/// somehow ahead of the gateway's. A merge would then refuse the answer to
	/// the very question this device asked -- the rename would be reported as
	/// having worked, because it did, while the device went on showing the old
	/// name. Still written VERBATIM, and still only when the record actually
	/// differs, so this cannot restamp either.
	function setHandle(rec) {
		var incoming = saneHandle(rec);
		var mine     = handleRecord();
		if (!incoming) return false;
		if (mine && mine.h === incoming.h && mine.t === incoming.t) return false;
		try { localStorage.setItem(K_HDL, JSON.stringify({ h: incoming.h, t: incoming.t })); }
		catch (e) { return false; }			// private mode: nothing was stored, nothing moved
		try { window.dispatchEvent(new Event('daimond:handle')); } catch (e) { /* no window */ }
		return true;
	}

	/// Take a handle record from the sync parcel. Returns true when this device
	/// moved.
	///
	/// WRITTEN VERBATIM, stamp included. Nothing here reads a clock. Adopting a
	/// record this device already agrees with writes nothing at all, so the next
	/// parcel is byte-identical to the one that arrived -- which is what makes
	/// the field a fixed point and keeps the two devices quiet.
	function adoptHandle(rec) {
		var incoming = saneHandle(rec);
		var mine     = handleRecord();
		if (!handleBeats(incoming, mine)) return false;
		try { localStorage.setItem(K_HDL, JSON.stringify({ h: incoming.h, t: incoming.t })); }
		catch (e) { return false; }			// private mode: nothing was stored, nothing moved
		try { window.dispatchEvent(new Event('daimond:handle')); } catch (e) { /* no window */ }
		return true;
	}

	/// Change the passphrase. Verifies the current one by unwrapping the
	/// private key with it, then re-derives under a FRESH salt and re-wraps.
	///
	/// Anything else sealed under the old passphrase (the stored API key) must
	/// be re-sealed by the caller, which is why the new wrapping key is left
	/// in memory: call `wrap()` again for each secret before this returns to
	/// the user. Returns `{ ok:false }` on a wrong current passphrase, never
	/// throwing and never revealing which half was wrong.
	async function changePassphrase(currentPass, newPass) {
		if (!available() || !exists()) return { ok: false };
		var saltRaw = localStorage.getItem(K_SALT);
		var privRaw = localStorage.getItem(K_PRIV);
		var alg     = localStorage.getItem(K_ALG) || 'Ed25519';
		if (!saltRaw || !privRaw) return { ok: false };

		// Verify the current passphrase by actually opening the private key.
		var oldKey = await deriveWrapKey(currentPass, b64dec(saltRaw));
		var pkcs8;
		try {
			pkcs8 = await open(oldKey, privRaw);
		} catch (e) {
			return { ok: false };
		}

		// THE SEALING KEY COMES ACROSS TOO, and it is read out HERE, under the old
		// key, because after the three lines below there is no old key to read it
		// with. A passphrase change that carried the signing key and left this one
		// behind would not fail, would not warn, and would orphan every message
		// ever sealed to this identity — permanently, since a sealing key is the
		// one key that cannot simply be replaced (see `ensureSealingKey`).
		//
		// It is done here rather than through `DaimondRekey` for the same reason
		// the signing key is: the registry runs AROUND this function, and this key
		// is wrapped by this file with the key this function is in the middle of
		// swapping. A participant outside could not read it at the one moment it
		// is readable.
		//
		// A key that is present but will not open is already orphaned, and was
		// before this call. It is dropped rather than carried, so `unlock` mints a
		// fresh one instead of the app holding a sealing key nobody can use.
		var sealWrapped = localStorage.getItem(K_SEALK);
		var sealPkcs8 = null;
		if (sealWrapped) {
			try { sealPkcs8 = await open(oldKey, sealWrapped); }
			catch (e) { sealPkcs8 = null; }
		}

		// A new passphrase gets a new salt, so the old derived key is useless
		// even against a copy of the old ciphertext.
		var salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
		var newKey = await deriveWrapKey(newPass, salt);
		var wrapped = await seal(newKey, pkcs8);

		// The passphrase is already proven (the open above), so an import failure
		// here is an engine without the curve, not a bad key — fall back for an
		// Ed25519 account rather than refusing the change.
		var signKey  = null;
		var signSeed = null;
		try {
			signKey = await crypto.subtle.importKey('pkcs8', pkcs8, importAlg(alg), false, ['sign']);
		} catch (e) {
			var fbSign = curveFallback();
			if (alg === 'Ed25519' && fbSign) {
				try { signSeed = fbSign.edSeedFromPkcs8(pkcs8); }
				catch (e2) { signSeed = null; }
			}
			if (!signSeed) return { ok: false };
		}

		// Re-sealed BEFORE anything is written, so a failure here leaves the whole
		// identity on the old passphrase rather than half on each.
		var sealWrappedNew = null;
		if (sealPkcs8) {
			try { sealWrappedNew = await seal(newKey, sealPkcs8); }
			catch (e) { return { ok: false }; }
		}

		localStorage.setItem(K_SALT, b64enc(salt));
		localStorage.setItem(K_PRIV, wrapped);
		if (sealWrappedNew) {
			localStorage.setItem(K_SEALK, sealWrappedNew);
		} else {
			// Either there was none, or it was already unreadable. Drop the public
			// half and the card with it: a card naming a sealing key whose private
			// half is gone tells a correspondent to seal something nobody can open.
			localStorage.removeItem(K_SEALP);
			localStorage.removeItem(K_SEALK);
			localStorage.removeItem(K_SEALA);
			localStorage.removeItem(K_CARD);
		}

		// NO `announce` HERE. `isUnlocked()` answered true before this call and
		// answers true after it, so nothing has changed for a listener -- and a
		// re-read fired at this point would read stores still wrapped under the
		// OLD passphrase. Re-wrapping is `DaimondRekey`'s job, and it is a
		// registry precisely so that this function names nobody.
		_wrapKey  = newKey;
		_signKey  = signKey;
		_signSeed = signSeed;
		await loadSealingKey(newKey);
		try { await ensureSealingKey(); } catch (e) { /* a rekey is not a failure for this */ }
		return { ok: true };
	}

	/// Unlock an existing identity with a passphrase. Derives the
	/// wrapping key and verifies the passphrase by decrypting the
	/// wrapped private key — a wrong passphrase fails the AES-GCM
	/// authentication, which is caught and reported as `{ ok:false }`
	/// rather than thrown. On success returns `{ ok:true, fingerprint }`
	/// and loads the wrapping and signing keys into memory.
	async function unlock(passphrase) {
		if (!available() || !exists()) {
			return { ok: false };
		}
		var saltRaw = localStorage.getItem(K_SALT);
		var privRaw = localStorage.getItem(K_PRIV);
		var alg     = localStorage.getItem(K_ALG) || 'Ed25519';
		if (!saltRaw || !privRaw) {
			return { ok: false };
		}

		var wrapKey = await deriveWrapKey(passphrase, b64dec(saltRaw));

		var pkcs8;
		try {
			pkcs8 = await open(wrapKey, privRaw);	// throws on wrong passphrase.
		} catch (e) {
			// GCM authentication failed: wrong passphrase (or tampered
			// store). Do not leak which, and do not throw.
			return { ok: false };
		}

		// Import the recovered private key for signing (non-extractable).
		//
		// The AES-GCM open above ALREADY PROVED the passphrase, so a failure from
		// here on is NOT a wrong passphrase — it is an engine that cannot load a
		// key of this algorithm (old Android Chrome, older Firefox, for Ed25519).
		// So try WebCrypto, and on an Ed25519 account fall back to the pure-JS
		// signer rather than turning the user away; only when neither can load the
		// key do we surface the honest 'unsupported' reason, never 'wrong pass'.
		var signKey  = null;
		var signSeed = null;
		try {
			signKey = await crypto.subtle.importKey(
				'pkcs8',
				pkcs8,
				importAlg(alg),
				false,
				['sign'],
			);
		} catch (e) {
			var fb = curveFallback();
			if (alg === 'Ed25519' && fb) {
				try { signSeed = fb.edSeedFromPkcs8(pkcs8); }
				catch (e2) { signSeed = null; }
			}
			if (!signSeed) {
				return { ok: false, reason: 'unsupported' };
			}
		}

		_wrapKey   = wrapKey;
		_signKey   = signKey;
		_signSeed  = signSeed;
		announce('unlock');

		// Both of these run at every unlock, and both are why an identity made by
		// an earlier build catches up without the user doing anything: the one
		// makes a sealing key for an identity that has none, and the other
		// replaces a fingerprint rendering that an earlier build wrote under a
		// rendering this one no longer draws.
		await loadSealingKey(wrapKey);
		try { await ensureSealingKey(); } catch (e) { /* an unlock is not a failure for this */ }
		refreshFingerprint();

		return { ok: true, fingerprint: fingerprint(), name: displayName() };
	}

	/// Check a passphrase without changing or unlocking anything.
	///
	/// Lets the change-passphrase flow reject a wrong current passphrase at the
	/// step where it is typed, rather than marching the user through choosing
	/// and confirming a new one before telling them.
	async function verify(passphrase) {
		if (!available() || !exists()) return false;
		var saltRaw = localStorage.getItem(K_SALT);
		var privRaw = localStorage.getItem(K_PRIV);
		if (!saltRaw || !privRaw) return false;
		var k = await deriveWrapKey(passphrase, b64dec(saltRaw));
		try { await open(k, privRaw); return true; }		// GCM auth fails on a wrong passphrase.
		catch (e) { return false; }
	}

	/// Drop all in-memory key material. After this the identity is
	/// locked and wrap/unwrap/sign no longer work until unlock().
	function lock() {
		var was = isUnlocked();
		_wrapKey = null;
		_signKey = null;
		_sealKey = null;
		// Overwrite the raw fallback material before dropping the reference. The
		// CryptoKeys above are non-extractable and hold nothing readable; these
		// two do, so they are zeroed. Best-effort — see curvefallback.js.
		var fb = curveFallback();
		if (fb) { fb.zero(_signSeed); fb.zero(_sealScalar); }
		_signSeed   = null;
		_sealScalar = null;
		if (was) announce('lock');		// so a decrypted store can drop what it holds.
	}

	/// Forget-me: wipe every identity localStorage key and lock. The
	/// device identity and any BYOK key wrapped under it are then
	/// unrecoverable, as intended.
	function reset() {
		lock();
		localStorage.removeItem(K_SALT);
		localStorage.removeItem(K_PUB);
		localStorage.removeItem(K_PRIV);
		localStorage.removeItem(K_ALG);
		localStorage.removeItem(K_FP);
		localStorage.removeItem(K_NAME);
		localStorage.removeItem(K_HDL);
		localStorage.removeItem(K_SEALP);
		localStorage.removeItem(K_SEALK);
		localStorage.removeItem(K_SEALA);
		localStorage.removeItem(K_CARD);
	}

	// ── Signing / public key (for future Oxegen binding) ───────

	/// Sign a string or byte array with the device private key,
	/// returning a base64 signature. Unlocked only.
	async function sign(bytesOrString) {
		requireUnlocked();
		var data = (typeof bytesOrString === 'string')
			? utf8(bytesOrString)
			: bytesOrString;
		var alg = localStorage.getItem(K_ALG) || 'Ed25519';
		if (_signSeed) {
			// Pure-JS Ed25519, deterministic and byte-for-byte the signature
			// WebCrypto would make from the same seed. Only reached on an engine
			// without WebCrypto Ed25519.
			var d = (data instanceof Uint8Array) ? data : new Uint8Array(data);
			return b64enc(curveFallback().edSign(_signSeed, d));
		}
		var sig = await crypto.subtle.sign(signAlg(alg), _signKey, data);
		return b64enc(sig);
	}

	/// The raw public key bytes (the device identity), or null if no
	/// identity exists. Public, so this works whether locked or not.
	async function publicKeyRaw() {
		var raw = localStorage.getItem(K_PUB);
		return raw ? b64dec(raw) : null;
	}

	/// The device public key as base64url — the form the gateway binds an
	/// account to. (Signatures go over the wire as standard base64; the two
	/// encodings differ, and mixing them up fails verification silently.)
	function publicKeyB64url() {
		var raw = localStorage.getItem(K_PUB);
		if (!raw) return null;
		return raw.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
	}

	// ── BYOK key wrapping ──────────────────────────────────────

	/// Encrypt a plaintext string (the BYOK API key) under the
	/// passphrase-derived key, returning base64 ciphertext in the
	/// `IV || ciphertext` format. Unlocked only. daimond.js stores this
	/// in place of the plaintext key.
	async function wrap(str) {
		requireUnlocked();
		return await seal(_wrapKey, utf8(str));
	}

	/// Decrypt a base64 ciphertext produced by wrap(), returning the
	/// original plaintext string. Unlocked only. Rejects (throws) if
	/// the ciphertext does not authenticate under the current key.
	async function unwrap(b64) {
		requireUnlocked();
		var pt = await open(_wrapKey, b64);
		return fromUtf8(pt);
	}

	/// Encrypt raw bytes, returning raw bytes `IV(12) || ciphertext(+tag)`.
	///
	/// The string-shaped `wrap`/`unwrap` above go through UTF-8 and base64, which
	/// is right for a small secret and wrong for a large file: base64 inflates by
	/// a third, and a file that is not text does not survive the round trip at
	/// all. This is the seal a byte pipeline uses, one piece at a time, so
	/// nothing ever holds a whole file.
	async function wrapBytes(plainBytes) {
		requireUnlocked();
		var iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
		var ct = new Uint8Array(await crypto.subtle.encrypt(
			{ name: 'AES-GCM', iv: iv }, _wrapKey, plainBytes));
		var out = new Uint8Array(iv.length + ct.length);
		out.set(iv, 0);
		out.set(ct, iv.length);
		return out;
	}

	/// Decrypt what wrapBytes produced. Throws on a wrong key or tampered
	/// ciphertext, as the GCM tag requires.
	async function unwrapBytes(bytes) {
		requireUnlocked();
		var buf = (bytes instanceof Uint8Array) ? bytes : new Uint8Array(bytes);
		var pt = await crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv: buf.slice(0, IV_BYTES) }, _wrapKey, buf.slice(IV_BYTES));
		return new Uint8Array(pt);
	}

	// ── The identity card ──────────────────────────────────────
	//
	// What a QR code carries and what a paste carries. A bare public key is not
	// enough: it says nothing about which key seals and which signs, carries no
	// label, and gives a reader no way to tell a first key from one that replaced
	// another. A card says all three, signed by the key it names.
	//
	// SELF-SIGNED MEANS EXACTLY WHAT IT SAYS. A card verifies under the key it
	// carries, so it proves the holder of that key composed it, and it proves
	// nothing whatever about WHO that holder is. A card fetched from a server is
	// Unverified however well it verifies — an intermediary that substituted its
	// own key would produce one that verifies perfectly. Only an out-of-band act
	// raises it: a QR read in person, or a safety number compared aloud. That act
	// is the user's, never the software's.
	//
	// The label is advisory display text. Equality is always the full 32-byte key.

	/// This identity's signed card, base64, or null when there is none.
	function card() {
		return localStorage.getItem(K_CARD) || null;
	}

	/// Compose and sign this identity's card, storing it. Unlocked only.
	///
	/// Answers `{ ok:false, why }` rather than throwing on the two conditions that
	/// are about this device rather than about the caller: no sealing key, and a
	/// signing key that is not Ed25519. The second is not a limitation to route
	/// around — an SBJ envelope names the signature scheme it was signed under,
	/// and there is exactly one in v0. A P-256 signature written into a field that
	/// says Ed25519 is a card every reader rejects, which is worse than no card.
	async function mintCard() {
		requireUnlocked();
		var b = bridge();
		if (!b || typeof b.cardEncode !== 'function') return { ok: false, why: 'bridge' };
		var enc = sealingKeyRaw();
		if (!enc) return { ok: false, why: 'no_sealing_key' };
		var alg = localStorage.getItem(K_ALG) || 'Ed25519';
		if (alg !== 'Ed25519') return { ok: false, why: 'not_ed25519' };
		var pub = localStorage.getItem(K_PUB);
		if (!pub) return { ok: false, why: 'no_identity' };

		try {
			// The payload, canonically encoded by the format's own crate. Its hash
			// is the card's address, so this must not be encoded anywhere else.
			var payload = b.cardEncode(displayName(), enc, new Uint8Array(0));
			var author  = b64dec(pub);
			var when    = Date.now();
			// The seam: wasm says what to sign, this signs it, wasm takes the
			// signature back. The signing key is a non-extractable CryptoKey and
			// never crosses into wasm in either direction.
			var input = b.signingInput(payload, 'daimond/card/0', author, when);
			// `sign` answers STANDARD base64, not base64url. The envelope wants the
			// raw 64 bytes, so it is decoded rather than passed on as text — the two
			// encodings differ and mixing them up fails verification silently.
			var sig = b64dec(await sign(input));
			var artefact = b.assemble(payload, 'daimond/card/0', author, when, sig);
			localStorage.setItem(K_CARD, b64enc(artefact));
		} catch (e) {
			return { ok: false, why: 'encode' };
		}
		return { ok: true };
	}

	// ── Moving an identity to another device ───────────────────

	/// Export the identity as a portable bundle, for carrying it to a second
	/// device (a phone) so that device becomes the SAME account and can read
	/// the same encrypted sync blobs.
	///
	/// The bundle is exactly the values already at rest in localStorage: the
	/// salt, the public key, the WRAPPED (still-encrypted) private key, the
	/// algorithm tag, the fingerprint and the display name. It carries no
	/// passphrase and no derived key, so moving it does not lower the bar an
	/// attacker faces -- the passphrase still gates everything, exactly as on
	/// the first device. Returns null when there is no identity to export.
	///
	/// The salt matters: the passphrase-derived wrapping key is
	/// `PBKDF2(passphrase, salt)`, so a second device can only reproduce it,
	/// and thus decrypt sync blobs, if it shares this salt. That is why the
	/// salt travels with the identity rather than being regenerated.
	function exportBundle() {
		if (!exists()) return null;
		return {
			v:    1,
			salt: localStorage.getItem(K_SALT),
			pub:  localStorage.getItem(K_PUB),
			priv: localStorage.getItem(K_PRIV),
			alg:  localStorage.getItem(K_ALG) || 'Ed25519',
			fp:   localStorage.getItem(K_FP)  || '',
			name: localStorage.getItem(K_NAME) || '',
			// The sealing keypair travels with the signing pair, and it has to:
			// the second device is becoming the SAME account, and an account whose
			// two devices held different sealing keys would be one that could be
			// messaged at only one of them. The private half travels still WRAPPED,
			// under the salt above, so this adds no plaintext to the bundle and
			// lowers no bar — the passphrase gates it exactly as on the first
			// device.
			sealp: localStorage.getItem(K_SEALP) || '',
			sealk: localStorage.getItem(K_SEALK) || '',
			seala: localStorage.getItem(K_SEALA) || '',
			// The signed card travels rather than being minted again on arrival,
			// so one account has ONE card at ONE address. A second device that
			// composed its own would produce a second card for the same keys with
			// a different time in it, and a correspondent shown both would have no
			// way to know they were the same person.
			card: localStorage.getItem(K_CARD) || '',
			// The account's public handle travels too, so the second device
			// shows the account's name from the moment it is adopted rather than
			// waiting for its first gateway round -- which on a phone paired in a
			// tunnel could be a long wait. Copied whole, stamp and all; the
			// receiving device gets a fact, not a fresh one.
			hdl:  handleRecord(),
		};
	}

	/// Adopt an identity bundle produced by exportBundle() on another device.
	///
	/// Writes the bundle to this device's localStorage and leaves the identity
	/// LOCKED: the receiving user must unlock with the passphrase, which both
	/// proves they hold it and derives the wrapping key from the shared salt.
	/// Returns false on a malformed or wrong-version bundle, writing nothing.
	/// Overwrites any identity already on this device, so callers confirm first.
	function importBundle(b) {
		if (!b || b.v !== 1 || !b.salt || !b.pub || !b.priv) return false;
		localStorage.setItem(K_SALT, b.salt);
		localStorage.setItem(K_PUB,  b.pub);
		localStorage.setItem(K_PRIV, b.priv);
		localStorage.setItem(K_ALG,  b.alg || 'Ed25519');
		localStorage.setItem(K_NAME, b.name || '');
		// The fingerprint is a RENDERING of `pub`, so it is recomputed here rather
		// than copied: a bundle written by an older build carries a rendering this
		// one does not draw, and copying it would put a fingerprint on the new
		// device that no other device agrees with. Recomputed at the first unlock
		// if the bridge is not up yet, which is where `b.fp` would have been wrong
		// anyway.
		localStorage.removeItem(K_FP);
		refreshFingerprint();
		// The sealing keypair and the card. Written TOGETHER or not at all: a
		// public sealing key without its wrapped private half tells correspondents
		// to seal messages this device can never open, and a card names the sealing
		// key, so the three are one fact.
		if (b.sealp && b.sealk) {
			localStorage.setItem(K_SEALP, b.sealp);
			localStorage.setItem(K_SEALK, b.sealk);
			localStorage.setItem(K_SEALA, b.seala || 'X25519');
			if (b.card) localStorage.setItem(K_CARD, b.card);
			else        localStorage.removeItem(K_CARD);
		} else {
			// A bundle from a device that had none. `unlock` makes one, and the two
			// devices then differ — which is why the export carries them and this is
			// the fallback rather than the path.
			localStorage.removeItem(K_SEALP);
			localStorage.removeItem(K_SEALK);
			localStorage.removeItem(K_SEALA);
			localStorage.removeItem(K_CARD);
		}
		// REPLACED, not merged. This device is becoming a different account, so
		// the handle it held belongs to somebody else now; the merge rule would
		// keep whichever record had the later stamp and leave this device
		// showing a name that is not its account's.
		var hdl = saneHandle(b.hdl);
		if (hdl) localStorage.setItem(K_HDL, JSON.stringify({ h: hdl.h, t: hdl.t }));
		else     localStorage.removeItem(K_HDL);
		lock();		// require an explicit unlock with the passphrase next.
		return true;
	}

	// ── Public surface ─────────────────────────────────────────
	window.DaimondIdentity = {
		available:    available,
		exists:       exists,
		create:       create,
		unlock:       unlock,
		lock:         lock,
		isUnlocked:   isUnlocked,
		/// The rendering of this device's public key that a person reads. It
		/// decides nothing; equality is always the full key. See the note above
		/// `fingerprintOf` for why there is exactly one implementation of it.
		fingerprint:  fingerprint,
		/// Redraw it from the stored key, for a caller that has just brought the
		/// wasm bridge up. Idempotent, and cheap.
		refreshFingerprint: refreshFingerprint,
		/// The sealing subkey: a SECOND keypair, for receiving sealed messages.
		/// See the note above `ensureSealingKey` for why it is not the signing one.
		sealingAvailable: sealingAvailable,
		/// Does this engine implement Ed25519 signing in WebCrypto? False on the
		/// engines the pure-JS fallback exists for.
		signingAvailable: signingAvailable,
		sealingKeyRaw:    sealingKeyRaw,
		ensureSealingKey: ensureSealingKey,
		/// ECDH with a correspondent's sealing key. The INPUT to a key derivation,
		/// never a key itself.
		sharedSecret:     sharedSecret,
		/// This identity's self-signed card: what a QR code carries. Self-signed
		/// proves the holder composed it and NOTHING about who the holder is.
		card:         card,
		mintCard:     mintCard,
		/// This DEVICE's label for its own keypair. Local, private, and not the
		/// account's public name -- see `handle` below.
		displayName:  displayName,
		rename:       rename,
		/// The ACCOUNT's public handle: what other people see. Minted and
		/// stamped by the gateway; this file only ever copies it.
		handle:         handle,
		handleRecord:   handleRecord,
		/// The handle as it rides the sync parcel, and the merge that takes one
		/// off it. See the note above `handleRecord` for why neither stamps.
		handleSnapshot: handleSnapshot,
		adoptHandle:    adoptHandle,
		/// The answer to this device's own request to the gateway, which is the
		/// authority on what the account is called. See the note above it.
		setHandle:      setHandle,
		changePassphrase: changePassphrase,
		verify:       verify,
		sign:         sign,
		publicKeyRaw: publicKeyRaw,
		publicKeyB64url: publicKeyB64url,
		wrap:         wrap,
		unwrap:       unwrap,
		// The byte-shaped seal, for the file pipeline.
		wrapBytes:    wrapBytes,
		unwrapBytes:  unwrapBytes,
		reset:        reset,
		exportBundle: exportBundle,
		importBundle: importBundle,
	};
})();
