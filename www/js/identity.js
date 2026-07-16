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
	var K_FP   = 'daimond-id-fp';		// public-key fingerprint, for display.
	var K_NAME = 'daimond-id-name';		// the user's chosen display name.

	// ── In-memory state (present only while unlocked) ──────────
	// Both are dropped by lock(); neither is ever persisted.
	var _wrapKey = null;	// AES-GCM CryptoKey deriving from the passphrase.
	var _signKey = null;	// Device private signing key (non-extractable).

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

	/// Lower-case hex of raw bytes.
	function hex(buf) {
		var bytes = (buf instanceof Uint8Array) ? buf : new Uint8Array(buf);
		var out = '';
		for (var i = 0; i < bytes.length; i++) {
			out += ('0' + bytes[i].toString(16)).slice(-2);
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

	/// Compute the display fingerprint of a raw public key: SHA-256,
	/// first 8 bytes, hex, grouped in fours for readability.
	async function fingerprintOf(pubBytes) {
		var digest = await crypto.subtle.digest('SHA-256', pubBytes);
		var short  = hex(new Uint8Array(digest).slice(0, 8));	// 16 hex chars.
		return short.replace(/(.{4})(?=.)/g, '$1 ').trim();		// "a1b2 c3d4 e5f6 0718".
	}

	// ── Lifecycle ──────────────────────────────────────────────

	/// True when an identity has already been created on this device.
	function exists() {
		return !!(localStorage.getItem(K_PRIV) && localStorage.getItem(K_PUB));
	}

	/// True while the identity is unlocked and key material is in memory.
	function isUnlocked() {
		return !!_wrapKey && !!_signKey;
	}

	/// The stored public-key fingerprint for display, or null. Works
	/// whether or not the identity is unlocked, since it is public.
	function fingerprint() {
		return localStorage.getItem(K_FP) || null;
	}

	/// Guard used by the unlocked-only operations. Throws a clear,
	/// secret-free error when called while locked.
	function requireUnlocked() {
		if (!isUnlocked()) {
			throw new Error('Daimond identity is locked.');
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
			throw new Error('WebCrypto is unavailable in this browser.');
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
		var fp = await fingerprintOf(pubBytes);

		// Persist. No secret and no derived key is ever written.
		localStorage.setItem(K_SALT, b64enc(salt));
		localStorage.setItem(K_PUB,  b64enc(pubBytes));
		localStorage.setItem(K_PRIV, wrapped);
		localStorage.setItem(K_ALG,  alg);
		localStorage.setItem(K_FP,   fp);
		localStorage.setItem(K_NAME, String(name || '').trim());

		// Leave unlocked: keep the wrapping key and the signing key.
		_wrapKey = wrapKey;
		_signKey = gen.pair.privateKey;

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

		// A new passphrase gets a new salt, so the old derived key is useless
		// even against a copy of the old ciphertext.
		var salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
		var newKey = await deriveWrapKey(newPass, salt);
		var wrapped = await seal(newKey, pkcs8);

		var signKey;
		try {
			signKey = await crypto.subtle.importKey('pkcs8', pkcs8, importAlg(alg), false, ['sign']);
		} catch (e) {
			return { ok: false };
		}

		localStorage.setItem(K_SALT, b64enc(salt));
		localStorage.setItem(K_PRIV, wrapped);
		_wrapKey = newKey;
		_signKey = signKey;
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
		var signKey;
		try {
			signKey = await crypto.subtle.importKey(
				'pkcs8',
				pkcs8,
				importAlg(alg),
				false,
				['sign'],
			);
		} catch (e) {
			return { ok: false };
		}

		_wrapKey = wrapKey;
		_signKey = signKey;
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
		_wrapKey = null;
		_signKey = null;
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
		localStorage.setItem(K_FP,   b.fp || '');
		localStorage.setItem(K_NAME, b.name || '');
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
		fingerprint:  fingerprint,
		displayName:  displayName,
		rename:       rename,
		changePassphrase: changePassphrase,
		verify:       verify,
		sign:         sign,
		publicKeyRaw: publicKeyRaw,
		publicKeyB64url: publicKeyB64url,
		wrap:         wrap,
		unwrap:       unwrap,
		reset:        reset,
		exportBundle: exportBundle,
		importBundle: importBundle,
	};
})();
