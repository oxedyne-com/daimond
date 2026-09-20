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
   key). The passphrase is never stored.

   ONE THING IS STORED THAT WAS NOT, SINCE 2026-09-13: the derived
   wrapping key, as bytes, in the TAB's sessionStorage, so a tab
   that is reloaded onto a new build comes back unlocked instead of
   at the lock screen (see `K_STAY`). It lives as long as that tab
   and is cleared on lock, on sign-out, on forget-me and on the
   gateway removing this device; the key the app HOLDS is still
   non-extractable, and the passphrase is still nowhere. What moves
   is that a machine left unlocked stays unlocked across a reload
   rather than locking itself -- which is the per-device setting's
   whole subject, default on for a desktop and off for a phone.

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
	// A random id minted once per DEVICE. NEVER in the bundle and never set by
	// importBundle, so two devices paired to one account (which share every key
	// above) still hold different ids — the peer's holder/dispatchedBy key. See
	// deviceId() for why the account public key cannot serve this purpose.
	var K_DEVID = 'daimond-id-device';	// hex random 128-bit, per-device, un-synced.
	// A durable "an identity was once created in this account" marker. Written at
	// the first create() or importBundle() -- pairing, passkey adopt and backup
	// restore all arrive through importBundle(), so one write site covers every
	// arrival path -- and cleared only by reset(). It is the positive evidence
	// the boot gate reads to refuse a BARE create after a premature empty read: a
	// stored keypair that reads empty on a cold iOS tab still leaves this behind,
	// so a re-mint that would orphan the sealed keys is turned into a recover
	// prompt instead. See existsSettled() and daimond.js's orphan guard.
	var K_EVER  = 'daimond-id-ever';	// '1' once an identity has existed here.
	// A "this device was removed from the account" marker, set by retire() (called
	// from daimond.js's onThisDeviceRemoved) and cleared by create(), importBundle()
	// -- a re-pair is the intended way back -- and reset() -- forget-me is a
	// genuine fresh start. Read by the boot gate to show a "removed, link again"
	// screen rather than the lost-keys recover screen: the identity here was TAKEN
	// AWAY, not lost to a bad read, and the two must not look the same on screen.
	var K_REMOVED = 'daimond-id-removed';	// '1' once this device has been removed.
	// ── Surviving a passphrase change made on ANOTHER device ────
	//
	// A passphrase change re-derives the wrapping key under a fresh salt, so a second
	// device still on the old salt cannot read a byte the changer pushes -- and used
	// to fork the account for ever (sync.js's corruption recovery, each device pushing
	// its own over the other's). These two keys carry the change to linked devices as
	// an EPOCH CHAIN: the new key bits, sealed UNDER THE OLD KEY, so a device that
	// holds the old key adopts the new one without ever knowing the new passphrase.
	//
	// K_EPOCH is an integer, absent (read as 0) for every account that has never
	// changed its passphrase -- and such an account's parcel stays byte-identical to
	// today, so nothing on the gateway changes and no existing account is touched.
	// K_REKEY is the rekey RECORD: the account's values at rest after the change (the
	// exportBundle shape) plus a `chain` of links, each `{ from, to, wk }` where `wk`
	// is `sealAad(newBits, 'rekey:from>to:pub')` under the key at step `from`. It rides
	// inside the sync blob (see sync.js openEnvelope) so a lagging device adopts on its
	// next pull. The AAD binds each link to the account key and the step, so a link
	// cannot be replayed for a different account or a different rung of the chain.
	var K_EPOCH = 'daimond-id-epoch';	// integer; absent/0 for an account never rekeyed.
	var K_REKEY = 'daimond-id-rekey';	// the rekey record, JSON. See adoptRekey().
	var CHAIN_MAX = 8;			// the most chain links a record carries.

	// ── Staying unlocked across a reload (2026-09-13) ───────────
	//
	// A pushed update reloads the tab, and a reload used to mean the lock screen:
	// the wrapping key lives in memory, and memory does not survive a load. That
	// cost was acceptable while only a nominated runner was ever reloaded unlocked;
	// from today every idle desktop is (see updater.js), so every idle desktop
	// would come back asking for a passphrase nobody typed it for.
	//
	// So the DERIVED key material — never the passphrase, which this file has never
	// held — is kept in the TAB's sessionStorage. That storage is the only one the
	// right shape for the job: it survives a reload of this tab, it dies with the
	// tab, and no other tab can read it. It is NOT localStorage, which would leave
	// the key on disk for whoever opens the browser next.
	//
	// What is stored opens exactly what the passphrase opens, so the trade is plain
	// and it is the one the per-device setting names: a machine left on an unlocked
	// tab stays unlocked across a reload instead of locking itself. Default ON for a
	// desktop, OFF for a phone, and when it is off nothing is written at all.
	var K_STAY = 'daimond-stay-unlocked';	// '1' | '0': this device's answer, never synced.
	var S_KEY  = 'daimond-id-session';	// sessionStorage: { k, alg }, this TAB only.

	// ── In-memory state (present only while unlocked) ──────────
	// All three are dropped by lock(); none is ever persisted.
	var _wrapKey = null;	// AES-GCM CryptoKey deriving from the passphrase.
	var _signKey = null;	// Device private signing key (non-extractable).
	var _sealKey = null;	// Device private SEALING key (non-extractable). See ensureSealingKey.
	// The wrapping key from BEFORE the last epoch change on this device, held for the
	// length of the session and never persisted. It closes the lost-edit race: a device
	// that pushed a parcel at the old epoch just before the change lands is opened with
	// this rather than clobbered. Set by changePassphrase (the old key) and by
	// adoptRekey (the key it just replaced); nulled by lock(). See sync.js pullOnce.
	var _prevWrapKey = null;	// previous epoch's wrapping key, this session only.
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

	// ── The remembered session ─────────────────────────────────

	/// TRAINING WHEELS — the debug feed, as in updater.js and sync.js. One guarded
	/// line per call site; nothing here depends on the feed existing or answering.
	function share(kind, payload) {
		try {
			// Named through `window` throughout: this file is loaded as a classic
			// script by the page and as a plain function body by its tests, and a bare
			// global resolves in the first but not the second.
			if (window.DEBUG_SHARE && window.DEBUG_SHARE.event) window.DEBUG_SHARE.event(kind, payload);
		} catch (e) { /* the feed is a nicety */ }
	}

	/// This TAB's storage, or null where it cannot be reached — a private window, a
	/// host that has none. Every caller reads null as "nothing is remembered".
	function tabStore() {
		try { return window.sessionStorage || null; } catch (e) { return null; }
	}

	/// Is this a phone or a tablet? The shell's own measurement, which is taken from
	/// touch, pointer and UA mobility rather than from the window's width. A device
	/// that cannot say reads as a desktop, which is mobile.js's own doctrine.
	function mobileDevice() {
		try {
			return !!(window.DaimondShell && window.DaimondShell.isMobileDevice
				&& window.DaimondShell.isMobileDevice());
		} catch (e) { return false; }
	}

	/// Does this device keep its unlocked session across a reload? Default ON for a
	/// desktop, OFF for a phone: a phone is carried, is reloaded by the browser
	/// whenever it feels like reclaiming the tab, and is the device most likely to
	/// be handed to somebody.
	function stayUnlocked() {
		var v = null;
		try { v = localStorage.getItem(K_STAY); } catch (e) { v = null; }
		if (v === '1') return true;
		if (v === '0') return false;
		return !mobileDevice();
	}

	/// Set it. Turning it off drops what is already remembered, so the answer is
	/// true of this tab from the moment it is given and not only of the next one.
	function setStayUnlocked(on) {
		try { localStorage.setItem(K_STAY, on ? '1' : '0'); } catch (e) { /* private mode */ }
		if (!on) forgetSession();
		return stayUnlocked();
	}

	/// Keep the derived key material where a reload of THIS TAB will find it.
	/// Refuses silently when the setting is off — "off" means nothing is written,
	/// not written-and-ignored.
	function rememberSession(bits, alg) {
		if (!stayUnlocked()) return false;
		var s = tabStore();
		if (!s || !bits) return false;
		try {
			s.setItem(S_KEY, JSON.stringify({ k: b64enc(bits), alg: String(alg || '') }));
			return true;
		} catch (e) { return false; }
	}

	/// Drop it. Called by `lock`, which every deliberate end of a session goes
	/// through — the Lock button, signing out, forget-me, and the gateway telling
	/// this device it has been removed.
	function forgetSession() {
		var s = tabStore();
		if (!s) return;
		try { s.removeItem(S_KEY); } catch (e) { /* nothing to drop */ }
	}

	/// Is there key material in this tab for a reload to come back on? Published for
	/// the settings row, which says what the device will do, and for a test that has
	/// to prove nothing is kept.
	function sessionHeld() {
		var s = tabStore();
		if (!s) return false;
		try { return !!s.getItem(S_KEY); } catch (e) { return false; }
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

	/// The PBKDF2 output itself, as bytes. Derived by the two paths that may be
	/// asked to remember it for this tab — `unlock` and `create` — and by the
	/// passphrase change, which has to replace what they remembered. Everything
	/// else takes `deriveWrapKey` and never sees the bytes.
	async function deriveWrapBits(passphrase, saltBytes) {
		var base = await crypto.subtle.importKey(
			'raw',
			utf8(passphrase),
			{ name: 'PBKDF2' },
			false,
			['deriveBits'],
		);
		var bits = await crypto.subtle.deriveBits(
			{
				name:       'PBKDF2',
				salt:       saltBytes,
				iterations: PBKDF2_ITERATIONS,
				hash:       'SHA-256',
			},
			base,
			AES_BITS,
		);
		return new Uint8Array(bits);
	}

	/// The AES-GCM key those bytes are — non-extractable, as everywhere else here,
	/// so what is imported cannot be read back out of the key object.
	function wrapKeyFromBits(bits) {
		return crypto.subtle.importKey(
			'raw',
			bits,
			{ name: 'AES-GCM' },
			false,
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

	/// Seal raw bytes under a GIVEN key, binding a purpose string as the AES-GCM
	/// additional data. Like `wrapBytesAad` but takes the key explicitly rather than
	/// the in-memory `_wrapKey`, because the epoch chain seals the new key bits under
	/// the OLD key and opens them under keys derived along the chain -- neither of which
	/// is `_wrapKey` at the moment it is needed. Answers base64 of `IV(12) || ct(+tag)`,
	/// the record's string shape. `openAad` with the same key and purpose opens it.
	async function sealAad(key, plainBytes, purpose) {
		var iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
		var ct = new Uint8Array(await crypto.subtle.encrypt(
			{ name: 'AES-GCM', iv: iv, additionalData: utf8(String(purpose)) }, key, plainBytes));
		var out = new Uint8Array(iv.length + ct.length);
		out.set(iv, 0);
		out.set(ct, iv.length);
		return b64enc(out);
	}

	/// Open what `sealAad` sealed, under the SAME key and purpose. Throws (the GCM tag)
	/// on a wrong key, a tampered ciphertext, or a purpose that does not match.
	async function openAad(key, b64, purpose) {
		var buf = b64dec(b64);
		var pt = await crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv: buf.slice(0, IV_BYTES), additionalData: utf8(String(purpose)) },
			key, buf.slice(IV_BYTES));
		return new Uint8Array(pt);
	}

	/// The canonical bytes a rekey record is SIGNED over: every at-rest value an
	/// adopting device would otherwise take on trust -- the salt, the wrapped private
	/// key, the sealing material and the card -- in a fixed order, as an array so key
	/// ordering cannot vary between the mint and the check. The chain links are
	/// authenticated by their own AAD, and a signature cannot sign itself, so both are
	/// excluded. `changePassphrase` (mint) and `adoptRekey`/`adoptDiverged` (verify)
	/// build this identically; any byte that differs between the two fails the check.
	/// See D1: without it a mailbox writer can swap the salt for garbage and brick
	/// every device that adopts the record.
	function rekeyBody(rec) {
		return JSON.stringify([
			'daimond-rekey-v1',
			rec.v | 0,
			rec.epoch | 0,
			String(rec.pub   || ''),
			String(rec.salt  || ''),
			String(rec.priv  || ''),
			String(rec.alg   || ''),
			String(rec.sealp || ''),
			String(rec.sealk || ''),
			String(rec.seala || ''),
			String(rec.card  || ''),
		]);
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

	/// Has an identity ever been created in this account on this device?
	///
	/// A stored keypair reads empty on a cold iOS/WebKit tab (see existsSettled),
	/// but this marker was written durably at the first create() and cleared only
	/// by reset(). So it survives the premature empty read that makes `exists()`
	/// answer "no", which is exactly the evidence the boot gate needs before it
	/// decides to offer a bare "Create passphrase".
	function everExisted() {
		try { return !!localStorage.getItem(K_EVER); } catch (e) { return false; }
	}

	/// This device's epoch: how many passphrase changes it has adopted. 0 for an
	/// account that has never had one -- and such an account's blob is byte-identical
	/// to what it was before the epoch chain existed.
	function epochNow() {
		try { return (parseInt(localStorage.getItem(K_EPOCH), 10) || 0) | 0; }
		catch (e) { return 0; }
	}

	/// The rekey record as stored, or null. Read by sync.js's push() to carry it in
	/// the blob, and by changePassphrase to extend its chain. See the K_REKEY note.
	function rekeyRecord() {
		try {
			var raw = localStorage.getItem(K_REKEY);
			return raw ? JSON.parse(raw) : null;
		} catch (e) { return null; }
	}

	/// The account's current wrapping salt, base64, or null. Read by sync.js to tell
	/// a same-epoch DIVERGENCE (two devices rekeyed to one epoch under different
	/// salts) from genuine corruption: a pulled record whose salt differs from this
	/// one is the other branch, never a bad blob. A public value -- the salt gates
	/// nothing on its own. See sync.js pullOnce's `re === le` branch (D2).
	function saltB64() { try { return localStorage.getItem(K_SALT); } catch (e) { return null; } }

	/// Was this device removed from its account (and not yet re-paired)?
	///
	/// Set by retire(), cleared by create()/importBundle()/reset() -- see the
	/// K_REMOVED note above. The boot gate reads this BEFORE the orphan-evidence
	/// check: a removed device is not one that lost its keys, it is one whose
	/// keys were taken away on purpose, and it must not be shown the lost-keys
	/// recover screen's "Try again", which can never work for it.
	function removed() {
		try { return !!localStorage.getItem(K_REMOVED); } catch (e) { return false; }
	}

	/// The retry budget for `existsSettled`, spent UNCONDITIONALLY once `exists()`
	/// reads false at entry -- see the note on the loop below for why this is no
	/// longer gated on seeing `K_EVER` first. A cold-tab empty read settles within
	/// a tick or two, so a returning device pays only that; the full budget is
	/// spent only on a boot that would otherwise fall through to "create".
	var SETTLE_GAP        = 50;	// ms between re-reads.
	var SETTLE_TRIES_LONG = 48;	// re-reads after the first (<=2.4s worst case).

	function settleSleep(ms) {
		return new Promise(function (r) { setTimeout(r, ms); });
	}

	/// `exists()` that does not trust a single cold read.
	///
	/// THE BUG THIS EXISTS FOR: on a freshly opened iOS/WebKit tab the first
	/// `localStorage.getItem` calls can return EMPTY before the storage area has
	/// finished loading from disk -- the timing family behind the seq-222/223 iOS
	/// reports. `exists()` is presence-only, so a premature empty read makes it
	/// answer "no identity" for an identity sitting on disk. The boot gate then
	/// offers to CREATE one, which mints a fresh random salt and keypair and
	/// ORPHANS every provider key the real identity had sealed -- the SEV-1.
	///
	/// This re-reads a bounded number of times, yielding a tick between reads, and
	/// resolves true the moment the keypair appears. It NEVER returns a false
	/// positive: it can only ever answer true when `exists()` itself does, so it
	/// adds unlock outcomes where a create was wrongly about to be shown and can
	/// never wrongly deny a genuine first run -- after the budget it returns false
	/// and create proceeds as before.
	///
	/// THE BUDGET IS UNCONDITIONAL, not gated on seeing `K_EVER` first. It used to
	/// extend from a short base budget to this long one only once `everExisted()`
	/// read true inside the loop -- but a WHOLE-STORE cold read (proven by
	/// `verify_pairing.mjs`'s `coldShim(900, true)`) blocks the marker for exactly
	/// as long as it blocks the keypair, so the marker was never observed within
	/// the short budget and the extension never fired: the read fell through to a
	/// re-minting create before either had a chance to load, which is the SEV-1
	/// this function exists to close. Polling to the long budget unconditionally
	/// closes that gap; the trade is that a genuinely fresh browser -- one where
	/// the keypair never appears at all -- now pays the full ~2.4s before create
	/// is offered, which is the correct price for never reminting a real device.
	///
	/// A REAL device whose read outlasts even this budget still returns false
	/// here, and is not turned into a bare create by this function: `K_EVER` and
	/// the sealed-provider-key evidence have had the SAME window to load, so the
	/// boot gate's `orphanIdentityEvidence()` check (daimond.js) reads them
	/// correctly on this false and routes to the locked recover screen instead --
	/// existsSettled does not need to tell that case apart from a genuine first
	/// run itself.
	async function existsSettled() {
		if (exists()) return true;
		for (var i = 0; i < SETTLE_TRIES_LONG; i++) {
			await settleSleep(SETTLE_GAP);
			if (exists()) return true;
		}
		return false;
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

	/// Announce at a moment the app can HEAR. This file is loaded before the modules
	/// that listen for `daimond:unlock` — runner.js, post.js, daimond.js — so a
	/// restore that fired the instant it finished would fire at nobody: classic
	/// scripts run in order, and the restore's microtasks land between two of them.
	/// Only the boot restore needs this; a typed unlock happens long after load.
	function announceWhenReady(what) {
		var d = null;
		try { d = window.document || null; } catch (e) { d = null; }
		if (d && d.readyState === 'loading') {
			try {
				d.addEventListener('DOMContentLoaded', function () { announce(what); });
				return;
			} catch (e) { /* fall through and announce now */ }
		}
		announce(what);
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
		var bits = await deriveWrapBits(passphrase, salt);
		var wrapKey = await wrapKeyFromBits(bits);

		// Device keypair (Ed25519, else ECDSA P-256).
		var gen = await generatePair();
		var alg = gen.alg;

		// Export and wrap the private key; export the public identity.
		var pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', gen.pair.privateKey));
		var wrapped = await seal(wrapKey, pkcs8);
		var pubBytes = new Uint8Array(await crypto.subtle.exportKey('raw', gen.pair.publicKey));

		// Persist. No secret and no derived key is ever written. Written as a group,
		// and rolled back if the group cannot complete: a quota failure partway
		// through would leave a salt and public key with no wrapped private key
		// beside them — an identity that reads as PRESENT and then fails every unlock
		// as "wrong passphrase". So we clear the lot and throw a sentence the user can
		// act on, rather than let `create` return as though the identity were saved.
		try {
			localStorage.setItem(K_SALT, b64enc(salt));
			localStorage.setItem(K_PUB,  b64enc(pubBytes));
			localStorage.setItem(K_PRIV, wrapped);
			localStorage.setItem(K_ALG,  alg);
			localStorage.setItem(K_NAME, String(name || '').trim());
			// The durable "an identity has existed here" marker, in the same group so
			// a quota rollback takes it with the keys rather than leaving it standing.
			localStorage.setItem(K_EVER, '1');
		} catch (e) {
			[K_SALT, K_PUB, K_PRIV, K_ALG, K_NAME, K_EVER].forEach(function (k) {
				try { localStorage.removeItem(k); } catch (e2) { /* best effort */ }
			});
			throw new Error(tOr('identity.err_storage_full',
				'This device is out of storage, so the new identity could not be saved. '
				+ 'Free some space in this browser and try again.'));
		}
		// A fresh identity carries no sealing key and no card yet, and this may be
		// overwriting one that did. Left-over keys of a DIFFERENT identity are worse
		// than none: a card would name a sealing key nobody holds the other half of.
		localStorage.removeItem(K_SEALP);
		localStorage.removeItem(K_SEALK);
		localStorage.removeItem(K_SEALA);
		localStorage.removeItem(K_CARD);
		localStorage.removeItem(K_FP);
		// A fresh create is "start a new account", which is the explicit way out
		// of the removed screen too -- so the marker goes with the rest of the
		// left-over identity above.
		localStorage.removeItem(K_REMOVED);
		// A new account is at epoch 0. Any epoch or rekey record left from an identity
		// this create is replacing belongs to that other account, and carrying it would
		// wrap this one's parcels in an envelope naming a chain nobody can walk.
		localStorage.removeItem(K_EPOCH);
		localStorage.removeItem(K_REKEY);

		// Leave unlocked: keep the wrapping key and the signing key.
		_wrapKey = wrapKey;
		_signKey = gen.pair.privateKey;
		rememberSession(bits, alg);
		try { bits.fill(0); } catch (e) { /* best effort, as in lock() */ }
		announce('unlock');
		share('unlock', { via: 'typed' });

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
		var newBits = await deriveWrapBits(newPass, salt);
		var newKey = await wrapKeyFromBits(newBits);
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

		var newSaltB64 = b64enc(salt);

		// ── Mint the epoch record, so linked devices adopt this change ──
		//
		// The new key bits, sealed under the OLD key, into a chain link: a device
		// holding the old key opens the link, derives the new key, and adopts without
		// ever knowing the new passphrase. Built ENTIRELY from the values in hand
		// (D4) -- never read back from a store this function is mid-way through
		// writing, so a half-written store can never leak into the record -- and
		// SIGNED with the account key (D1) so a mailbox writer cannot forge a body an
		// adopting device would take on trust. The public sealing values are unchanged
		// by a rekey, so they are the currently stored ones (still the old, correct
		// values: nothing has been written yet). Done here, under the old key, for the
		// same reason the sealing key is read out here: after `newBits.fill(0)` below
		// there is no way to seal them, and `_wrapKey` is about to become the NEW key.
		var rec;
		try {
			var curEpoch = epochNow();
			var newEpoch = curEpoch + 1;
			var pubB64   = localStorage.getItem(K_PUB) || '';
			var purpose  = 'rekey:' + curEpoch + '>' + newEpoch + ':' + pubB64;
			var link     = { from: curEpoch, to: newEpoch, wk: await sealAad(oldKey, newBits, purpose) };
			var prevRec  = rekeyRecord();
			var chain    = (prevRec && Array.isArray(prevRec.chain)) ? prevRec.chain.slice() : [];
			chain.push(link);
			while (chain.length > CHAIN_MAX) chain.shift();
			rec = {
				v:     1,
				epoch: newEpoch,
				pub:   pubB64,
				salt:  newSaltB64,
				priv:  wrapped,
				alg:   alg,
				sealp: sealWrappedNew ? (localStorage.getItem(K_SEALP) || '') : '',
				sealk: sealWrappedNew || '',
				seala: sealWrappedNew ? (localStorage.getItem(K_SEALA) || 'X25519') : '',
				card:  sealWrappedNew ? (localStorage.getItem(K_CARD)  || '') : '',
				chain: chain,
			};
			rec.sig = await signWith(signKey, signSeed, alg, rekeyBody(rec));
		} catch (e) {
			// The record could not be built or signed. Nothing has been written yet,
			// so the identity is whole on the OLD passphrase -- fail the change rather
			// than swap the key and leave a device that forks on the next change (D4).
			return { ok: false };
		}

		// ── Write it all as one atomic group (D4) ────────────────────
		//
		// The record and the epoch FIRST, then the salt/priv swap: a throw partway
		// through must never leave a device on the NEW passphrase reading epoch 0,
		// which is exactly the fork this whole mechanism removes. Every touched key is
		// snapshotted, and any failure rolls the lot back to the old passphrase, so
		// the change is all-or-nothing rather than half on each.
		var prior = {};
		[K_SALT, K_PRIV, K_SEALP, K_SEALK, K_SEALA, K_CARD, K_EPOCH, K_REKEY].forEach(function (k) {
			prior[k] = localStorage.getItem(k);
		});
		try {
			localStorage.setItem(K_REKEY, JSON.stringify(rec));
			localStorage.setItem(K_EPOCH, String(rec.epoch));
			localStorage.setItem(K_SALT, newSaltB64);
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
		} catch (e) {
			// Roll every touched key back to its pre-change value: the identity is left
			// exactly as it was, whole on the OLD passphrase, and the caller sees the
			// failure rather than a device split across two passphrases.
			Object.keys(prior).forEach(function (k) {
				try {
					if (prior[k] === null) localStorage.removeItem(k);
					else                   localStorage.setItem(k, prior[k]);
				} catch (e2) { /* best effort */ }
			});
			return { ok: false };
		}

		// The old key opens a parcel a lagging device may have pushed at the old epoch
		// just before this change lands -- held for the session so pull can MERGE it
		// rather than clobber it. See sync.js pullOnce's `re < le` branch.
		_prevWrapKey = oldKey;

		// NO `announce` HERE. `isUnlocked()` answered true before this call and
		// answers true after it, so nothing has changed for a listener -- and a
		// re-read fired at this point would read stores still wrapped under the
		// OLD passphrase. Re-wrapping is `DaimondRekey`'s job, and it is a
		// registry precisely so that this function names nobody.
		_wrapKey  = newKey;
		_signKey  = signKey;
		_signSeed = signSeed;
		// The remembered material is the OLD key, which opens nothing now. Replaced
		// rather than dropped, so a reload of this tab still comes back unlocked.
		rememberSession(newBits, alg);
		try { newBits.fill(0); } catch (e) { /* best effort */ }
		await loadSealingKey(newKey);
		try { await ensureSealingKey(); } catch (e) { /* a rekey is not a failure for this */ }
		return { ok: true };
	}

	/// Adopt a passphrase change made on ANOTHER device, from its rekey record.
	///
	/// The counterpart to `changePassphrase`'s mint. This device is unlocked at some
	/// epoch `local`; the record is at a HIGHER epoch and carries the chain of links
	/// from one to the other. Walking the chain -- opening each link under the key of
	/// its step -- derives the new key WITHOUT the new passphrase, because each link was
	/// sealed under the key of the step before it. The account's keypair is unchanged by
	/// a passphrase change (only the wrapping is), so once the new key opens the record's
	/// wrapped private key the device simply takes the record's values at rest.
	///
	/// UNLOCKED ONLY, and it does NOT touch the DaimondRekey registry: like
	/// changePassphrase it swaps only what this file owns (the identity keys and the
	/// in-memory key material), and leaves the app's other sealed stores to the caller,
	/// which runs `readAll` before this and `resealAll` after -- see sync.js adoptEpoch.
	///
	/// Answers `{ ok:true, epoch }`, or `{ ok:false, reason }` where reason is
	/// 'foreign' (a different account), 'stale' (not ahead of us), 'unsigned' (the
	/// record body's signature does not check against the account key -- a tampered
	/// or forged body), 'gap' (a link is missing or will not open), 'bad' (the chain
	/// produced a key the private key will not open under), 'unsupported' (an engine
	/// that cannot load the key) or 'storage'. On EVERY failure the identity is left
	/// exactly on its old key -- nothing is written and `_wrapKey` is untouched -- so
	/// a device that cannot adopt loses nothing.
	async function adoptRekey(rec) {
		requireUnlocked();
		if (!rec || rec.v !== 1 || typeof rec.epoch !== 'number') return { ok: false, reason: 'malformed' };
		var pubB64 = localStorage.getItem(K_PUB);
		if (!pubB64 || rec.pub !== pubB64) return { ok: false, reason: 'foreign' };
		var local  = epochNow();
		var target = rec.epoch | 0;
		if (target <= local) return { ok: false, reason: 'stale' };
		// AUTHENTICATE THE BODY BEFORE THE WALK (D1). The at-rest values below -- the
		// salt, the wrapped private key, the sealing material -- are taken on trust by
		// the walk and the commit, so a mailbox writer who swapped the salt for garbage
		// would brick every device that adopted it ("wrong passphrase" for ever, sealed
		// mail dead). The changer signed the body with the account key on mint; a bad
		// signature refuses here, with nothing written.
		if (!(await recordSigOk(rec))) return { ok: false, reason: 'unsigned' };
		var res = await applyRekeyRecord(rec, local, _wrapKey, false);
		// STRANDING RECOVERY (Gap 3, D2). A device that LOST a same-epoch divergence
		// holds a DEAD branch key at `local`, so the chain's first rung (from `local`)
		// will not open under it -- a 'gap'. But when it changed to `local` it KEPT the
		// shared previous-epoch key, and the record's chain also carries the rung from
		// `local-1` that the winner minted over the branch both sides share. Retry the
		// walk from there under `_prevWrapKey`: it crosses onto the winning branch at
		// `local` and walks on to the record's epoch. Guarded so it fires only when there
		// is a previous key to cross with and a rung below to cross from; the walk's own
		// proof-against-the-private-key gate keeps a wrong key from ever committing, so a
		// retry that does not belong here fails harmlessly and the original result stands.
		if (!res.ok && res.reason === 'gap' && local > 0 && _prevWrapKey) {
			var alt = await applyRekeyRecord(rec, local - 1, _prevWrapKey, false);
			if (alt.ok) return alt;
		}
		return res;
	}

	/// Adopt the OTHER branch when two devices rekeyed to the SAME epoch under
	/// different salts before either pulled -- the divergence yield (D2). The
	/// yielding side is chosen deterministically in sync.js (the larger salt yields),
	/// and it walks the single link both chains share, from the epoch before this one
	/// under the key it kept from its own change, onto the incoming branch. Same-epoch
	/// only ('stale' otherwise), and it needs the previous key ('noprev' without it,
	/// so the device must be linked again). Leaves `_prevWrapKey` in place -- it is the
	/// shared previous-epoch key, not the dead branch just abandoned. Same reasons and
	/// same all-or-nothing failure guarantee as `adoptRekey`.
	async function adoptDiverged(rec) {
		requireUnlocked();
		if (!rec || rec.v !== 1 || typeof rec.epoch !== 'number') return { ok: false, reason: 'malformed' };
		var pubB64 = localStorage.getItem(K_PUB);
		if (!pubB64 || rec.pub !== pubB64) return { ok: false, reason: 'foreign' };
		var local  = epochNow();
		var target = rec.epoch | 0;
		if (target !== local) return { ok: false, reason: 'stale' };	// divergence is same-epoch only
		if (!_prevWrapKey)    return { ok: false, reason: 'noprev' };
		if (!(await recordSigOk(rec))) return { ok: false, reason: 'unsigned' };
		return applyRekeyRecord(rec, local - 1, _prevWrapKey, true);
	}

	/// Does a rekey record's signature check against the account key (D1)? The body
	/// is `rekeyBody` -- every at-rest value an adopting device would take on trust;
	/// the chain links are authenticated separately by their AAD, and the signature
	/// does not sign itself. False on any bad or missing signature rather than
	/// throwing, so the caller branches on one boolean.
	async function recordSigOk(rec) {
		try { return await verifySig(rec.pub, rec.sig || '', rekeyBody(rec)); }
		catch (ex) { return false; }
	}

	/// Does a PULLED rekey record verify against THIS account (Gap 1, the DoS)? Both
	/// halves, and both are load-bearing: `rec.pub` must equal the account's own trusted
	/// public key -- a forged record names the ATTACKER's pub, whose own signature would
	/// then check against it, so the anchor to the stored pub is what a forgery cannot
	/// satisfy -- AND the body must be signed by that key (`recordSigOk`). Read by
	/// sync.js immediately after `openEnvelope`, before the record is allowed to steer
	/// the pull: a record that does not verify is treated as ABSENT, so a forgery
	/// degrades to corruption recovery and can never set the sticky `rekeyBehind`. False
	/// rather than throwing, so the caller branches on one boolean.
	async function verifyRecord(rec) {
		if (!rec) return false;
		var pubB64 = localStorage.getItem(K_PUB);
		if (!pubB64 || rec.pub !== pubB64) return false;
		return await recordSigOk(rec);
	}

	/// Walk a validated rekey record from `startEpoch` (under `startKey`) to the
	/// record's own epoch, deriving the wrapping key at each rung, then commit the
	/// record's at-rest values and swap the in-memory key to it.
	///
	/// Shared by `adoptRekey` (a device BEHIND the chain, walking from its own epoch
	/// under its current key) and `adoptDiverged` (two devices at the SAME epoch on
	/// different salts, the yielding side walking from the shared previous epoch under
	/// the key it kept from its own change). The caller has already checked the
	/// account, the epoch relation and the signature; this does the cryptographic walk
	/// and the storage swap. `keepPrev` leaves `_prevWrapKey` untouched (the diverged
	/// yield keeps the shared previous key it holds); otherwise the key just replaced
	/// becomes the new `_prevWrapKey`. Reasons as `adoptRekey` documents; on every
	/// failure the identity is left exactly on its old key.
	async function applyRekeyRecord(rec, startEpoch, startKey, keepPrev) {
		var pubB64 = localStorage.getItem(K_PUB);
		var target = rec.epoch | 0;
		var chain  = Array.isArray(rec.chain) ? rec.chain : [];

		// Walk startEpoch -> target, deriving the key at each rung. `key` starts as the
		// key at `startEpoch`; `bits` holds the raw PBKDF2 output of the rung just
		// opened, zeroed as soon as the next supersedes it. `penultKey` trails one rung
		// behind `key`: at loop end it is the key at `target-1`, which becomes
		// `_prevWrapKey` (Gap 3b) so a MULTI-rung adopter can still cross a later
		// divergence at its new epoch -- the START key would be too many rungs back.
		var key       = startKey;
		var penultKey = startKey;
		var bits = null;
		var zero = function () { if (bits) { try { bits.fill(0); } catch (e) { /* best effort */ } } };
		for (var e = startEpoch; e < target; e++) {
			var link = null;
			for (var i = 0; i < chain.length; i++) {
				if (chain[i] && (chain[i].from | 0) === e && (chain[i].to | 0) === e + 1) { link = chain[i]; break; }
			}
			if (!link || !link.wk) { zero(); return { ok: false, reason: 'gap' }; }
			var purpose = 'rekey:' + e + '>' + (e + 1) + ':' + pubB64;
			var next;
			try { next = await openAad(key, link.wk, purpose); }
			catch (ex) { zero(); return { ok: false, reason: 'gap' }; }
			zero();
			bits = next;
			penultKey = key;		// key at epoch `e`; after the last rung, key at `target-1`
			try { key = await wrapKeyFromBits(bits); }
			catch (ex) { zero(); return { ok: false, reason: 'bad' }; }
		}
		if (!bits) { return { ok: false, reason: 'gap' }; }
		var newKey = key;			// the key at epoch `target`

		// PROVE it: the record's wrapped private key must open under the derived key.
		// A chain that produced the wrong key fails here rather than leaving the device
		// on a key that opens nothing.
		var alg = rec.alg || localStorage.getItem(K_ALG) || 'Ed25519';
		var pkcs8;
		try { pkcs8 = await open(newKey, rec.priv); }
		catch (ex) { zero(); return { ok: false, reason: 'bad' }; }
		var sk = await signKeyFrom(pkcs8, alg);
		if (!sk) { zero(); return { ok: false, reason: 'unsupported' }; }

		// Commit the record's at-rest values verbatim, as one group. Nothing in memory
		// has changed yet, so a storage failure here still leaves the old key in force.
		// Snapshot every touched key first and roll the lot back on any throw (Gap 4,
		// D4): a half-applied commit -- the new salt written, the epoch not, say -- would
		// leave the device unable to open its own private key, the very brick this walk
		// exists to avoid. Mirrors `changePassphrase`'s mint, which already rolls back.
		var prior = {};
		[K_SALT, K_PRIV, K_ALG, K_SEALP, K_SEALK, K_SEALA, K_CARD, K_EPOCH, K_REKEY, K_FP].forEach(function (k) {
			prior[k] = localStorage.getItem(k);
		});
		try {
			localStorage.setItem(K_SALT, rec.salt);
			localStorage.setItem(K_PRIV, rec.priv);
			localStorage.setItem(K_ALG,  alg);
			if (rec.sealp && rec.sealk) {
				localStorage.setItem(K_SEALP, rec.sealp);
				localStorage.setItem(K_SEALK, rec.sealk);
				localStorage.setItem(K_SEALA, rec.seala || 'X25519');
				if (rec.card) localStorage.setItem(K_CARD, rec.card);
				else          localStorage.removeItem(K_CARD);
			} else {
				localStorage.removeItem(K_SEALP);
				localStorage.removeItem(K_SEALK);
				localStorage.removeItem(K_SEALA);
				localStorage.removeItem(K_CARD);
			}
			localStorage.setItem(K_EPOCH, String(target));
			localStorage.setItem(K_REKEY, JSON.stringify(rec));
			localStorage.removeItem(K_FP);
		} catch (ex) {
			// Roll every touched key back to its pre-adopt value: the identity is left
			// exactly on its old key, whole, and the caller sees the failure rather than
			// a device stranded between two epochs. The in-memory key is untouched below,
			// so nothing has moved off the old key.
			Object.keys(prior).forEach(function (k) {
				try {
					if (prior[k] === null) localStorage.removeItem(k);
					else                   localStorage.setItem(k, prior[k]);
				} catch (e2) { /* best effort */ }
			});
			zero();
			return { ok: false, reason: 'storage' };
		}

		// Now, and only now -- after the store write has SUCCEEDED -- swap the in-memory
		// key. Its replaced value is kept for the session as the previous-epoch key (the
		// lost-edit race guard and the divergence-cross key), UNLESS the caller is a
		// same-epoch yield, which must keep the shared previous key it holds rather than
		// the dead divergent branch this one is leaving. The kept key is the one at
		// `target-1` (`penultKey`), not the walk's start key: for a multi-rung adopt the
		// start key is several epochs back, and a later divergence at `target` is crossed
		// from `target-1` (Gap 3b).
		if (!keepPrev) _prevWrapKey = penultKey;
		_wrapKey  = newKey;
		_signKey  = sk.key;
		_signSeed = sk.seed;
		rememberSession(bits, alg);
		zero();
		await loadSealingKey(newKey);
		try { await ensureSealingKey(); } catch (ex) { /* an adopt is not a failure for this */ }
		refreshFingerprint();
		// NO event fired here. The shell notification -- and any reseal failures that
		// must ride with it -- belongs to the caller (sync.js adoptEpoch), which fires
		// `daimond:rekey` AFTER the DaimondRekey registry has resealed every store, so
		// the notice can name what did not survive the change (D5).
		return { ok: true, epoch: target };
	}

	/// Is the previous epoch's wrapping key held for this session? Read by sync.js
	/// before it tries to open a parcel a lagging device pushed at the old epoch.
	function hasPrevKey() { return !!_prevWrapKey; }

	/// Open a wrapped string under the PREVIOUS epoch's key. The counterpart to
	/// `unwrap` for the lost-edit race: a parcel sealed at the epoch before this
	/// device's last change opens under the key kept from that change. Throws when no
	/// previous key is held, or when it does not open the blob.
	async function unwrapPrev(b64) {
		if (!_prevWrapKey) throw new Error('no previous key held this session');
		var pt = await open(_prevWrapKey, b64);
		return fromUtf8(pt);
	}

	/// Import a recovered pkcs8 private key for signing, answering `{ key, seed }`
	/// — the seed half set only on an engine whose WebCrypto cannot load the curve.
	/// Null when neither can, which is the honest 'unsupported' and never a wrong
	/// passphrase.
	///
	/// The AES-GCM open that precedes every call here ALREADY PROVED the passphrase,
	/// so a failure from this point is an engine that cannot load a key of this
	/// algorithm (old Android Chrome, older Firefox, for Ed25519) — hence the
	/// pure-JS fallback rather than turning the user away.
	async function signKeyFrom(pkcs8, alg) {
		try {
			return {
				key: await crypto.subtle.importKey('pkcs8', pkcs8, importAlg(alg), false, ['sign']),
				seed: null,
			};
		} catch (e) { /* not a passphrase problem: try the fallback */ }
		var fb = curveFallback();
		if (alg === 'Ed25519' && fb) {
			try { return { key: null, seed: fb.edSeedFromPkcs8(pkcs8) }; }
			catch (e2) { /* the fallback cannot read it either */ }
		}
		return null;
	}

	/// Restore THIS TAB's unlocked session after a reload, with no passphrase typed.
	///
	/// The one door past the lock screen that does not go through a passphrase or a
	/// passkey, and it opens only on what this tab itself stored at its last unlock
	/// (see the note above `K_STAY`). Three things can have changed underneath it —
	/// the setting turned off in another tab, the passphrase changed, the keys
	/// replaced — and each drops what is remembered rather than guessing.
	///
	/// Answers the same shape `unlock` does, with `via` so a caller can tell the two
	/// apart; `{ ok: false, reason: 'none' }` is the ordinary cold boot and not a
	/// failure.
	async function restore() {
		if (!available() || !exists()) return { ok: false, reason: 'none' };
		if (isUnlocked()) {
			return { ok: true, via: 'memory', fingerprint: fingerprint(), name: displayName() };
		}
		var store = tabStore();
		var raw = null;
		if (store) { try { raw = store.getItem(S_KEY); } catch (e) { raw = null; } }
		if (!raw) return { ok: false, reason: 'none' };
		// Asked again HERE rather than trusted from the time it was written: the
		// setting is per device, and another tab can have turned it off since.
		if (!stayUnlocked()) { forgetSession(); return { ok: false, reason: 'off' }; }

		var rec = null;
		try { rec = JSON.parse(raw); } catch (e) { rec = null; }
		var privRaw = localStorage.getItem(K_PRIV);
		var alg     = (rec && rec.alg) || localStorage.getItem(K_ALG) || 'Ed25519';
		if (!rec || !rec.k || !privRaw) { forgetSession(); return { ok: false, reason: 'none' }; }

		var wrapKey;
		try { wrapKey = await wrapKeyFromBits(b64dec(rec.k)); }
		catch (e) { forgetSession(); return { ok: false, reason: 'stale' }; }

		var pkcs8;
		try {
			pkcs8 = await open(wrapKey, privRaw);
		} catch (e) {
			// The remembered key no longer opens the stored one: the passphrase was
			// changed, or the identity replaced, somewhere this tab did not see.
			forgetSession();
			return { ok: false, reason: 'stale' };
		}

		var sk = await signKeyFrom(pkcs8, alg);
		if (!sk) return { ok: false, reason: 'unsupported' };

		_wrapKey  = wrapKey;
		_signKey  = sk.key;
		_signSeed = sk.seed;
		announceWhenReady('unlock');
		// The lens reads this to tell a restored unlock from a typed one, which is
		// the difference between a reload that cost the user nothing and one that
		// sent them back to the gate.
		share('unlock', { via: 'session' });

		await loadSealingKey(wrapKey);
		try { await ensureSealingKey(); } catch (e) { /* a restore is not a failure for this */ }
		refreshFingerprint();

		return { ok: true, via: 'session', fingerprint: fingerprint(), name: displayName() };
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

		var bits    = await deriveWrapBits(passphrase, b64dec(saltRaw));
		var wrapKey = await wrapKeyFromBits(bits);

		var pkcs8;
		try {
			pkcs8 = await open(wrapKey, privRaw);	// throws on wrong passphrase.
		} catch (e) {
			// GCM authentication failed: wrong passphrase (or tampered
			// store). Do not leak which, and do not throw.
			return { ok: false };
		}

		var sk = await signKeyFrom(pkcs8, alg);
		if (!sk) {
			return { ok: false, reason: 'unsupported' };
		}

		_wrapKey   = wrapKey;
		_signKey   = sk.key;
		_signSeed  = sk.seed;
		// What a reload of this tab comes back on, where the device says so. Written
		// from the bits rather than the key object, which is non-extractable for the
		// same reason it always was; the bytes are zeroed below either way.
		rememberSession(bits, alg);
		try { bits.fill(0); } catch (e) { /* best effort, as in lock() */ }
		announce('unlock');
		share('unlock', { via: 'typed' });

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
		// The previous epoch's key is a session-only race guard (see changePassphrase /
		// adoptRekey). It is a non-extractable CryptoKey holding nothing readable, so it
		// is dropped rather than zeroed, but it must not outlive the session.
		_prevWrapKey = null;
		// Overwrite the raw fallback material before dropping the reference. The
		// CryptoKeys above are non-extractable and hold nothing readable; these
		// two do, so they are zeroed. Best-effort — see curvefallback.js.
		var fb = curveFallback();
		if (fb) { fb.zero(_signSeed); fb.zero(_sealScalar); }
		_signSeed   = null;
		_sealScalar = null;
		// And what a reload would have come back on. THIS IS THE WHOLE OF "cleared on
		// Lock, on sign-out, on forget-me, and on a 410 removal": every one of those
		// ends here (daimond.js `lockApp`, `onThisDeviceRemoved`, and `reset` below),
		// so none of them needs to know the key exists.
		forgetSession();
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
		localStorage.removeItem(K_DEVID);
		// The durable marker goes with the keys: a deliberate forget is a genuine
		// fresh start, and leaving it would make the next create here read as a
		// re-mint and demand the replace acknowledgement for no reason.
		localStorage.removeItem(K_EVER);
		// Forget-me is a genuine fresh start too, not a removal, so it must not
		// leave the device reading as "removed" on its next boot.
		localStorage.removeItem(K_REMOVED);
		// The epoch and its chain belong to the account that is being forgotten; a
		// fresh identity starts again at epoch 0, byte-identical to a never-rekeyed one.
		localStorage.removeItem(K_EPOCH);
		localStorage.removeItem(K_REKEY);
	}

	/// Take this device out of its account because the ACCOUNT removed it, not
	/// because the user asked to forget it here.
	///
	/// The distinction is the whole of what daimond.js's boot gate has to show
	/// correctly: reset() alone leaves a device that reads exactly like one that
	/// lost its keys to a bad read, and is offered the recover screen's "Try
	/// again" -- which can never work, because there is nothing to retry. retire()
	/// is reset() plus the marker that lets the boot gate tell the two apart.
	function retire() {
		reset();
		try { localStorage.setItem(K_REMOVED, '1'); } catch (e) { /* best effort */ }
	}

	// ── Signing / public key (for future Oxegen binding) ───────

	/// Sign a string or byte array with a GIVEN signing key, returning a base64
	/// signature. The engine split `sign` uses, taken explicitly rather than off the
	/// in-memory `_signKey`/`_signSeed`, so `changePassphrase` can sign the epoch
	/// record with the key it has freshly derived for the new passphrase (D1) at a
	/// moment the globals may not yet hold. `signKey` is the WebCrypto private key, or
	/// null when `signSeed` (the pure-JS Ed25519 seed) is set instead.
	async function signWith(signKey, signSeed, alg, bytesOrString) {
		var data = (typeof bytesOrString === 'string')
			? utf8(bytesOrString)
			: bytesOrString;
		if (signSeed) {
			// Pure-JS Ed25519, deterministic and byte-for-byte the signature
			// WebCrypto would make from the same seed. Only reached on an engine
			// without WebCrypto Ed25519.
			var d = (data instanceof Uint8Array) ? data : new Uint8Array(data);
			return b64enc(curveFallback().edSign(signSeed, d));
		}
		var sig = await crypto.subtle.sign(signAlg(alg), signKey, data);
		return b64enc(sig);
	}

	/// Sign a string or byte array with the device private key,
	/// returning a base64 signature. Unlocked only.
	async function sign(bytesOrString) {
		requireUnlocked();
		var alg = localStorage.getItem(K_ALG) || 'Ed25519';
		return signWith(_signKey, _signSeed, alg, bytesOrString);
	}

	/// Verify a detached signature against a raw public key. The counterpart to
	/// `sign`, split the same way: WebCrypto where it does Ed25519, the pure-JS
	/// verifier where it does not. Public and lock-agnostic -- verification needs
	/// only the public key -- and it exists because `sign` had no counterpart in
	/// JS: message signatures are checked in the wasm bridge, so anything signing
	/// OFF that path (the peer's errand) had nowhere to verify but a second copy of
	/// this engine split, which the header forbids.
	///
	/// `pub` is raw key bytes; `sig` is base64 (as `sign` answers) or raw bytes;
	/// `data` is the signed bytes or a string. Answers false on any malformed
	/// input rather than throwing, so a caller branches on one boolean.
	async function verifySig(pub, sig, data) {
		var alg  = localStorage.getItem(K_ALG) || 'Ed25519';
		var pubB = (pub instanceof Uint8Array) ? pub : b64dec(pub);
		var sigB = (sig instanceof Uint8Array) ? sig : b64dec(sig);
		var msgB = (typeof data === 'string') ? utf8(data) : data;
		try {
			var importAlg = (alg === 'Ed25519')
				? { name: 'Ed25519' }
				: { name: 'ECDSA', namedCurve: 'P-256' };
			var key = await crypto.subtle.importKey('raw', pubB, importAlg, false, ['verify']);
			return await crypto.subtle.verify(signAlg(alg), key, sigB, msgB);
		} catch (e) {
			// The engine has no WebCrypto Ed25519. The pure-JS verifier, which is the
			// same one the interop test checks WebCrypto's own signatures against.
			var fb = curveFallback();
			if (alg === 'Ed25519' && fb) return fb.edVerify(pubB, sigB, msgB);
			return false;
		}
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

	/// This DEVICE's stable local id, minted once and kept in localStorage. The
	/// account public key cannot serve as a device id: pairing copies the whole
	/// keypair (exportBundle/importBundle), so every paired device shares it, and a
	/// peer keyed on it could not tell itself from its twin — it would self-exclude
	/// from presence and, worse, both twins would write the SAME lease `holder` and
	/// both run and bill the turn. This id is random, never travels in the bundle
	/// or the parcel, and so is unique per device. Lazily minted so an existing
	/// device keeps the id it already has.
	function deviceId() {
		var id = localStorage.getItem(K_DEVID);
		if (id) return id;
		var bytes = crypto.getRandomValues(new Uint8Array(16));
		var s = '';
		for (var i = 0; i < bytes.length; i++) s += ('0' + bytes[i].toString(16)).slice(-2);
		try { localStorage.setItem(K_DEVID, s); } catch (e) { /* private mode: the id lives for this page only */ }
		return s;
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

	/// As wrapBytes, but BINDS the ciphertext to a purpose string, passed as the
	/// AES-GCM additional data. The same string is required to open it, so a blob
	/// sealed for one purpose (a peer envelope, say) cannot be opened where another
	/// is expected even though every purpose shares this key -- domain separation
	/// without a second key derivation. `unwrapBytesAad` with the same string is the
	/// only thing that opens it.
	async function wrapBytesAad(plainBytes, purpose) {
		requireUnlocked();
		var iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
		var ct = new Uint8Array(await crypto.subtle.encrypt(
			{ name: 'AES-GCM', iv: iv, additionalData: utf8(String(purpose)) }, _wrapKey, plainBytes));
		var out = new Uint8Array(iv.length + ct.length);
		out.set(iv, 0);
		out.set(ct, iv.length);
		return out;
	}

	/// Decrypt what wrapBytesAad sealed under the SAME purpose string. Throws (the
	/// GCM tag) on a wrong key, a tampered ciphertext, OR a purpose that does not
	/// match -- which is how the domain separation is enforced.
	async function unwrapBytesAad(bytes, purpose) {
		requireUnlocked();
		var buf = (bytes instanceof Uint8Array) ? bytes : new Uint8Array(bytes);
		var pt = await crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv: buf.slice(0, IV_BYTES), additionalData: utf8(String(purpose)) },
			_wrapKey, buf.slice(IV_BYTES));
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
			// The account's epoch and its rekey record, so a device paired AFTER a
			// passphrase change arrives at the right epoch and carries the chain onward
			// -- rather than at epoch 0, where it would fork the instant the next change
			// landed. Both absent (0/null) for an account that has never changed its
			// passphrase, which keeps such a bundle exactly as it was before this field.
			epoch: epochNow(),
			rk:    rekeyRecord(),
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
		// Snapshotted before any write, so the catch below can tell whether this
		// device already carried the durable marker -- see the K_EVER note above
		// create(). A device that HAD an identity and just destroyed it mid-import
		// keeps its evidence; a fresh device that failed to import one leaves none
		// standing.
		var hadEver = everExisted();
		// Written as a group. A quota failure partway through would leave a
		// half-written identity — a salt and public key with no wrapped private key,
		// which reads as present and then fails every unlock as "wrong passphrase".
		// So on failure we clear every key this bundle touches and return false — the
		// contract's "wrote nothing" — rather than throw uncaught or adopt a corpse.
		try {
		localStorage.setItem(K_SALT, b.salt);
		localStorage.setItem(K_PUB,  b.pub);
		localStorage.setItem(K_PRIV, b.priv);
		localStorage.setItem(K_ALG,  b.alg || 'Ed25519');
		localStorage.setItem(K_NAME, b.name || '');
		// The durable "an identity has existed here" marker (see the K_EVER note
		// above create()). Pairing, passkey adopt and backup restore all arrive
		// through this one write site, so setting it here gives all three arrival
		// paths the same iOS remint protection create() already had.
		localStorage.setItem(K_EVER, '1');
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
		// The account's epoch and rekey record, when the bundle carries them. Taken
		// together or cleared together: an epoch with no record could not carry a change
		// onward, and a record with no epoch would have this device read as behind its
		// own chain. Both absent is an account that has never been rekeyed, which is
		// epoch 0 -- the same state a fresh device is in.
		if (b.epoch && b.rk) {
			localStorage.setItem(K_EPOCH, String(b.epoch | 0));
			localStorage.setItem(K_REKEY, JSON.stringify(b.rk));
		} else {
			localStorage.removeItem(K_EPOCH);
			localStorage.removeItem(K_REKEY);
		}
		} catch (e) {
			[K_SALT, K_PUB, K_PRIV, K_ALG, K_NAME, K_FP,
			 K_SEALP, K_SEALK, K_SEALA, K_CARD, K_HDL, K_EPOCH, K_REKEY].forEach(function (k) {
				try { localStorage.removeItem(k); } catch (e2) { /* best effort */ }
			});
			// Only drop the marker if this device did not already have one: a device
			// that HAD an identity and just destroyed it mid-import keeps its
			// evidence, so the boot gate offers recover rather than a bare create.
			if (!hadEver) {
				try { localStorage.removeItem(K_EVER); } catch (e4) { /* best effort */ }
			}
			try { lock(); } catch (e3) { /* best effort */ }
			return false;
		}
		lock();		// require an explicit unlock with the passphrase next.
		// A re-pair is the intended way back for a device that was removed: it is
		// getting a fresh copy of the account's keys, precisely the situation the
		// marker exists to end. Cleared only here, on confirmed success, so a
		// failed import leaves the device exactly as removed as it was.
		localStorage.removeItem(K_REMOVED);
		return true;
	}

	// ── The boot attempt ───────────────────────────────────────
	//
	// Tried here, at load, rather than waited for: the app's boot gate decides
	// between the lock screen and the workspace, and the earlier this has answered
	// the fewer ways there are for the two to disagree. It is cheap — no PBKDF2, one
	// AES-GCM open — and on the overwhelmingly common cold boot there is nothing
	// stored and it answers at once.
	//
	// `_restoring` is the promise, published so the gate can await the answer rather
	// than race it.
	var _restoring = null;
	function restoreAtBoot() {
		if (_restoring) return _restoring;
		_restoring = Promise.resolve()
			.then(restore)
			.catch(function () { return { ok: false, reason: 'none' }; });
		return _restoring;
	}
	try { restoreAtBoot(); } catch (e) { /* inert where there is no storage at all */ }

	// ── Public surface ─────────────────────────────────────────
	window.DaimondIdentity = {
		available:    available,
		exists:       exists,
		/// `exists()` hardened against the cold-tab premature-empty-read that lets a
		/// stored identity look absent and orphan its keys to a fresh create. Awaited
		/// by the boot gate before it decides between unlock and create.
		existsSettled: existsSettled,
		/// Durable evidence an identity was once created in this account here, read
		/// by the boot guard so a premature empty read cannot fall through to a bare
		/// create. Survives the read that fools `exists()`.
		everExisted:  everExisted,
		create:       create,
		unlock:       unlock,
		lock:         lock,
		isUnlocked:   isUnlocked,
		/// Come back unlocked from THIS TAB's last unlock, with no passphrase typed.
		/// Awaited by the boot gate before it shows the lock screen; see the note
		/// above `K_STAY` for what is kept and for how long.
		restore:      restore,
		/// The attempt already made at load, as a promise. Awaiting this is how a
		/// caller asks "is this boot a restored one?" without starting a second.
		restoring:    restoreAtBoot,
		/// Does this device keep its unlocked session across a reload? Per-device,
		/// default ON for a desktop and OFF for a phone.
		stayUnlocked:    stayUnlocked,
		setStayUnlocked: setStayUnlocked,
		/// Is there key material in this tab for a reload to come back on? Read by
		/// the updater before it reloads an unlocked desktop.
		sessionHeld:     sessionHeld,
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
		/// This device's epoch (passphrase changes adopted), and the rekey record it
		/// carries. Read by sync.js: `epoch()` decides whether a pushed blob is wrapped
		/// in a rekey envelope, and `rekeyRecord()` is what goes inside it. 0/null for
		/// an account that has never changed its passphrase.
		epoch:        epochNow,
		rekeyRecord:  rekeyRecord,
		/// The account's current wrapping salt, base64. Read by sync.js to tell a
		/// same-epoch divergence from corruption (D2). See the note above it.
		saltB64:      saltB64,
		/// Does a pulled rekey record verify against this account (Gap 1)? The anchor
		/// AND the signature. Read by sync.js right after openEnvelope, before the record
		/// is allowed to steer the pull -- a record that fails is treated as absent.
		verifyRecord: verifyRecord,
		/// Adopt a passphrase change made on another device, from its rekey record.
		/// Unlocked only; swaps this file's keys and nothing else, so the caller runs
		/// the DaimondRekey registry around it. See the note above it.
		adoptRekey:   adoptRekey,
		/// Adopt the OTHER branch of a same-epoch divergence (two devices rekeyed to
		/// one epoch on different salts). The deterministic yield -- see the note above
		/// it, and sync.js pullOnce's `re === le` branch (D2).
		adoptDiverged: adoptDiverged,
		/// The lost-edit race guard: whether the previous epoch's wrapping key is held
		/// this session, and an open under it. See sync.js pullOnce's `re < le` branch.
		hasPrevKey:   hasPrevKey,
		unwrapPrev:   unwrapPrev,
		verify:       verify,
		sign:         sign,
		/// Verify a detached signature against a raw public key. The JS counterpart
		/// to `sign`, for a signature made off the wasm message path.
		verifySig:    verifySig,
		publicKeyRaw: publicKeyRaw,
		publicKeyB64url: publicKeyB64url,
		/// This device's stable local id — distinct on every paired device, unlike
		/// the account key. The peer's holder/dispatchedBy/presence key.
		deviceId:     deviceId,
		wrap:         wrap,
		unwrap:       unwrap,
		// The byte-shaped seal, for the file pipeline.
		wrapBytes:    wrapBytes,
		unwrapBytes:  unwrapBytes,
		wrapBytesAad:   wrapBytesAad,
		unwrapBytesAad: unwrapBytesAad,
		reset:        reset,
		/// Take this device out of its account because the ACCOUNT removed it.
		/// reset() plus the marker the boot gate needs to show "removed, link
		/// again" rather than the lost-keys recover screen. See the note above it.
		retire:       retire,
		/// Was this device removed from its account (and not yet re-paired)?
		removed:      removed,
		exportBundle: exportBundle,
		importBundle: importBundle,
	};
})();
