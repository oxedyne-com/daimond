/* ============================================================
   Daimond — passkey (WebAuthn PRF) unlock (passkey.js)
   ------------------------------------------------------------
   A second way to unlock the on-device identity, built ON TOP of
   the passphrase in identity.js rather than in place of it. The
   passphrase remains the cryptographic root: the wrapping key is
   `PBKDF2(passphrase, salt)`, a non-extractable AES-GCM key, and
   cross-device sync relies on that being reproducible from the
   passphrase alone. So a passkey must recover the PASSPHRASE, not
   replace the key — anything else would fork the crypto root and
   break sync.

   The mechanism is the WebAuthn PRF extension (the same primitive
   Bitwarden uses). A passkey, when asserted with a per-identity
   salt, yields a stable pseudo-random secret that never leaves the
   authenticator. We HKDF that secret into an AES-GCM key and seal
   the passphrase under it. Unlocking with the passkey re-derives the
   same secret, opens the sealed passphrase, and feeds it straight to
   `DaimondIdentity.unlock()` — the identical code path a typed
   passphrase takes. The passphrase is the always-present fallback.

   Everything here uses browser-native WebAuthn (`navigator.creden-
   tials`) and WebCrypto (`crypto.subtle`) only — no dependencies, no
   CDN. The single global `window.DaimondPasskey` is attached at the
   bottom, matching the IIFE-module convention of identity.js.

   ZERO-KNOWLEDGE
   --------------
   There is no server in this flow. The passphrase, the PRF secret
   and every derived key exist only in memory during an operation.
   What is persisted (namespaced per account, see accounts.js) is a
   credential id, a random salt, and the passphrase sealed under a
   key that only the authenticator can reconstitute. An onlooker who
   reads localStorage learns nothing they could unlock with.

   THREAT MODEL
   ------------
   A passkey binds unlocking to possession of the authenticator plus
   whatever user verification it enforces (biometric or device PIN).
   It protects against a shoulder-surfed passphrase on a trusted
   device. It does NOT protect against a compromised browser, a
   malicious extension, or an attacker who already holds the pass-
   phrase — those defeat any in-browser scheme and are out of scope,
   exactly as for identity.js.
   ============================================================ */
(function () {
	'use strict';

	// ── Parameters ─────────────────────────────────────────────
	var SALT_BYTES  = 32;	// Per-identity PRF salt length.
	var UID_BYTES   = 16;	// Random WebAuthn user handle length.
	var CHAL_BYTES  = 32;	// WebAuthn challenge length (unverified: no server).
	var IV_BYTES    = 12;	// AES-GCM nonce length (matches identity.js seal format).
	var AES_BITS    = 256;	// AES-GCM key length.
	var HKDF_INFO   = 'daimond-passkey-v1';	// HKDF context label, versioned.

	// ── localStorage key ───────────────────────────────────────
	// A single record per account. accounts.js shims localStorage to prefix every
	// `daimond-*` key with the current account (the primary keeps the raw key), so
	// storing under this name lands a passkey in exactly the right account with no
	// call site aware of the namespacing. The record holds only public-safe values:
	// the credential id, the PRF salt, and the passphrase sealed under a key that
	// only the authenticator can rebuild. Its mere presence is the enrolled flag.
	var K_PASSKEY = 'daimond-passkey';	// JSON { v, cred, salt, blob }.

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

	/// Base64url-encode raw bytes — the form WebAuthn credential ids travel in.
	function b64urlEnc(buf) {
		return b64enc(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
	}

	/// Decode a base64url string to a Uint8Array.
	function b64urlDec(str) {
		var s = String(str).replace(/-/g, '+').replace(/_/g, '/');
		while (s.length % 4) s += '=';
		return b64dec(s);
	}

	// ── AES-GCM seal / open (identity.js `IV || ciphertext` format) ──

	/// Encrypt raw bytes under an AES-GCM key with a fresh random IV, returning
	/// base64 of `IV(12) || ciphertext(+tag)`. The IV is prefixed so a matching
	/// open() needs only the key. This is byte-for-byte the format identity.js
	/// uses for every wrapped blob, so a sealed passphrase reads like any other.
	async function seal(key, plainBytes) {
		var iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
		var ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, plainBytes);
		var ctBytes = new Uint8Array(ct);
		var out = new Uint8Array(iv.length + ctBytes.length);
		out.set(iv, 0);
		out.set(ctBytes, iv.length);
		return b64enc(out);
	}

	/// Decrypt a base64 `IV(12) || ciphertext` blob produced by seal(). Rejects
	/// (throws) on a wrong key or tampered ciphertext — the GCM authentication
	/// failure. Callers treat that as "this passkey did not open it".
	async function open(key, b64) {
		var buf = b64dec(b64);
		var iv  = buf.slice(0, IV_BYTES);
		var ct  = buf.slice(IV_BYTES);
		var pt  = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv }, key, ct);
		return new Uint8Array(pt);
	}

	/// HKDF-SHA-256 the raw PRF secret into a non-extractable AES-GCM key. The
	/// salt is the per-identity PRF salt (also fed to the authenticator) and the
	/// info label is versioned, so the derivation is pinned and reproducible.
	async function keyFromPrf(prfBytes, saltBytes) {
		var base = await crypto.subtle.importKey('raw', prfBytes, { name: 'HKDF' }, false, ['deriveKey']);
		return await crypto.subtle.deriveKey(
			{
				name: 'HKDF',
				hash: 'SHA-256',
				salt: saltBytes,
				info: utf8(HKDF_INFO),
			},
			base,
			{ name: 'AES-GCM', length: AES_BITS },
			false,				// non-extractable.
			['encrypt', 'decrypt'],
		);
	}

	// ── Capability probe ───────────────────────────────────────

	/// True when the browser exposes the WebAuthn + WebCrypto surface this module
	/// needs AND a user-verifying platform authenticator is present. Async because
	/// the platform-authenticator check is a promise. PRF cannot be probed without
	/// creating a credential, so callers gate the passkey UI on this plus an actual
	/// enrolment; a first enrol that yields no PRF output reports its own failure.
	async function available() {
		try {
			if (typeof window.PublicKeyCredential === 'undefined') return false;
			if (!navigator.credentials
				|| typeof navigator.credentials.create !== 'function'
				|| typeof navigator.credentials.get !== 'function') return false;
			if (!crypto || !crypto.subtle || typeof crypto.subtle.deriveKey !== 'function') return false;
			// Prefer the explicit capability query where the engine offers it: it
			// reports PRF support directly, which the platform-authenticator check
			// cannot. Absence of the query is not a "no" — fall through to it.
			if (typeof PublicKeyCredential.getClientCapabilities === 'function') {
				try {
					var caps = await PublicKeyCredential.getClientCapabilities();
					if (caps && caps['extension:prf'] === false) return false;
				} catch (e) { /* fall through to the platform check. */ }
			}
			if (typeof PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable !== 'function') {
				return false;
			}
			return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
		} catch (e) {
			return false;
		}
	}

	// ── Enrolment state ────────────────────────────────────────

	/// The stored passkey record for the current account, or null. Reads through
	/// the accounts.js shim, so it is this account's record and no other's.
	function record() {
		try {
			var raw = localStorage.getItem(K_PASSKEY);
			if (!raw) return null;
			var r = JSON.parse(raw);
			return (r && r.cred && r.salt && r.blob) ? r : null;
		} catch (e) {
			return null;
		}
	}

	/// True when a passkey is enrolled for the current account.
	function isEnrolled() {
		return !!record();
	}

	// ── Enrol ──────────────────────────────────────────────────

	/// Enrol a passkey that will unlock this identity, from an unlocked Settings.
	///
	/// The passphrase is required and verified against identity.js (which does not
	/// retain it), proving the caller can already unlock before a second door is
	/// cut. A resident credential is created with the PRF extension, then IMMEDI-
	/// ATELY asserted with a fresh per-identity salt: creation-time PRF is unreli-
	/// able across authenticators, so a follow-up get() is the robust way to obtain
	/// the secret. That secret is HKDF'd into an AES-GCM key, the passphrase is
	/// sealed under it, and the credential id, salt and sealed blob are persisted.
	/// The passphrase and the PRF secret are never stored and are dropped on
	/// return. Resolves `{ ok:true }`, or `{ ok:false, error }` with a safe message.
	async function enrol(passphrase) {
		if (!passphrase) return { ok: false, error: 'A passphrase is required to enrol a passkey.' };
		if (!window.DaimondIdentity || !DaimondIdentity.exists()) {
			return { ok: false, error: 'There is no identity to protect with a passkey.' };
		}
		// Prove the passphrase before cutting a second door. identity.js keeps no
		// copy, so the caller must supply it and we check it here.
		var good = false;
		try { good = await DaimondIdentity.verify(passphrase); } catch (e) { good = false; }
		if (!good) return { ok: false, error: 'That passphrase did not match.' };

		var cap = false;
		try { cap = await available(); } catch (e) { cap = false; }
		if (!cap) return { ok: false, error: 'This browser or device cannot create a passkey.' };

		var salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
		var uid  = crypto.getRandomValues(new Uint8Array(UID_BYTES));
		var name = (DaimondIdentity.displayName && DaimondIdentity.displayName()) || 'Daimond';

		// Create the credential with the PRF extension requested.
		var cred;
		try {
			cred = await navigator.credentials.create({
				publicKey: {
					rp:        { id: location.hostname, name: 'Daimond' },
					user:      { id: uid, name: name || 'Daimond', displayName: name || 'Daimond' },
					challenge: crypto.getRandomValues(new Uint8Array(CHAL_BYTES)),
					pubKeyCredParams: [
						{ type: 'public-key', alg: -7 },	// ES256.
						{ type: 'public-key', alg: -257 },	// RS256.
					],
					authenticatorSelection: {
						residentKey:      'preferred',
						userVerification: 'preferred',
					},
					timeout:    60000,
					extensions: { prf: {} },
				},
			});
		} catch (e) {
			return { ok: false, error: 'Passkey creation was cancelled or failed.' };
		}
		if (!cred) return { ok: false, error: 'No passkey was created.' };

		var credId = new Uint8Array(cred.rawId);

		// The robust PRF read: assert the just-made credential with the salt.
		var prf = await evalPrf(credId, salt);
		if (!prf) {
			return {
				ok: false,
				error: 'This authenticator does not support the PRF extension, so it cannot unlock Daimond.',
			};
		}

		// HKDF → key, seal the passphrase, persist. No secret is written.
		try {
			var key  = await keyFromPrf(prf, salt);
			var blob = await seal(key, utf8(passphrase));
			localStorage.setItem(K_PASSKEY, JSON.stringify({
				v:    1,
				cred: b64urlEnc(credId),
				salt: b64enc(salt),
				blob: blob,
			}));
		} catch (e) {
			return { ok: false, error: 'The passkey could not be sealed. Nothing was saved.' };
		}
		return { ok: true };
	}

	/// Assert a credential with the PRF extension and return the first PRF output
	/// as a Uint8Array, or null when the authenticator produced none. Shared by
	/// enrol (right after create) and unlock.
	async function evalPrf(credIdBytes, saltBytes) {
		var assertion;
		try {
			assertion = await navigator.credentials.get({
				publicKey: {
					rpId:      location.hostname,
					challenge: crypto.getRandomValues(new Uint8Array(CHAL_BYTES)),
					allowCredentials: [{ type: 'public-key', id: credIdBytes }],
					userVerification: 'preferred',
					timeout:   60000,
					extensions: { prf: { eval: { first: saltBytes } } },
				},
			});
		} catch (e) {
			return null;
		}
		if (!assertion) return null;
		try {
			var ext = assertion.getClientExtensionResults();
			var out = ext && ext.prf && ext.prf.results && ext.prf.results.first;
			return out ? new Uint8Array(out) : null;
		} catch (e) {
			return null;
		}
	}

	// ── Unlock ─────────────────────────────────────────────────

	/// Unlock the identity with the enrolled passkey. Asserts the stored creden-
	/// tial with the stored salt, HKDF's the PRF secret into the same key, opens
	/// the sealed passphrase, and hands it to `DaimondIdentity.unlock()` — the very
	/// path a typed passphrase takes, so the result shape is identical
	/// (`{ ok:true, fingerprint, name }`). Any failure resolves `{ ok:false, error }`
	/// and the caller falls back to the passphrase field. The recovered passphrase
	/// lives only for the duration of this call.
	async function unlockWithPasskey() {
		var r = record();
		if (!r) return { ok: false, error: 'No passkey is enrolled on this device.' };

		var credId = b64urlDec(r.cred);
		var salt   = b64dec(r.salt);

		var prf = await evalPrf(credId, salt);
		if (!prf) return { ok: false, error: 'The passkey could not be read. Use your passphrase.' };

		var pass;
		try {
			var key = await keyFromPrf(prf, salt);
			pass = fromUtf8(await open(key, r.blob));	// throws on a wrong/other passkey.
		} catch (e) {
			return { ok: false, error: 'The passkey did not match this identity. Use your passphrase.' };
		}

		var res;
		try { res = await DaimondIdentity.unlock(pass); } catch (e) { res = { ok: false }; }
		pass = null;
		if (!res || !res.ok) {
			// The sealed passphrase no longer opens the identity — the passphrase
			// was changed since enrolment. The passkey is stale; say so plainly.
			return { ok: false, error: 'This passkey is out of date. Unlock with your passphrase, then re-add it.' };
		}
		return res;
	}

	// ── Remove ─────────────────────────────────────────────────

	/// Forget the enrolled passkey for this account. Only the local sealed blob is
	/// dropped; the credential itself stays in the authenticator, where it is inert
	/// without the salt and blob and can be deleted by the user at their leisure.
	function remove() {
		try { localStorage.removeItem(K_PASSKEY); } catch (e) { /* nothing to remove */ }
		return true;
	}

	// ── Public surface ─────────────────────────────────────────
	window.DaimondPasskey = {
		available:          available,
		isEnrolled:         isEnrolled,
		enrol:              enrol,
		unlockWithPasskey:  unlockWithPasskey,
		remove:             remove,
	};
})();
