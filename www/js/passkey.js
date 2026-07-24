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
	var UID_BYTES   = 16;	// Random WebAuthn user handle length.
	var CHAL_BYTES  = 32;	// WebAuthn challenge length (unverified: no server).
	var IV_BYTES    = 12;	// AES-GCM nonce length (matches identity.js seal format).
	var AES_BITS    = 256;	// AES-GCM key length.
	var HKDF_INFO   = 'daimond-passkey-v1';	// HKDF context label, versioned.

	// The PRF salt is a FIXED label, not a per-identity random value.
	//
	// v1 drew a random salt and kept it beside the sealed blob, which meant the
	// salt had to be in hand BEFORE the authenticator could be asked for the PRF
	// output -- and a device that has only the synced passkey has neither. That
	// is the whole reason a passkey could not bring an account to a new device.
	//
	// A constant salt removes the ordering problem: one discoverable assertion
	// yields the credential AND its PRF output together, in a single biometric
	// gesture. It is safe because the salt is not a secret and does not have to
	// be unique per user. The PRF output is HMAC of the salt under a key that
	// lives inside the authenticator and differs per credential, so two people
	// with the same salt still get unrelated secrets. The salt's only job is to
	// separate Daimond's use of a credential from any other use, and one label
	// does that.
	var PRF_SALT_LABEL = 'daimond-prf-salt-v2';
	/// The label a handle is derived under, kept distinct from the PRF label so
	/// the two derivations can never collide.
	var HANDLE_LABEL   = 'daimond-passkey-handle-v1';

	// ── localStorage key ───────────────────────────────────────
	// A single record per account. accounts.js shims localStorage to prefix every
	// `daimond-*` key with the current account (the primary keeps the raw key), so
	// storing under this name lands a passkey in exactly the right account with no
	// call site aware of the namespacing. The record holds only public-safe values:
	// the credential id and a sealed blob that only the authenticator can open.
	// Its mere presence is the enrolled flag.
	//
	//   v1: { v:1, cred, salt, blob }  -- blob seals the passphrase alone.
	//   v2: { v:2, cred, blob }        -- blob seals the identity bundle AND the
	//                                     passphrase, under the constant salt, so
	//                                     the same blob can stand a device up from
	//                                     nothing. A v1 record still opens, and is
	//                                     upgraded in place the first time it does.
	var K_PASSKEY = 'daimond-passkey';

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

	/// SHA-256 of a label's bytes, optionally with more bytes appended. Both the
	/// PRF salt and the storage handle are derived this way, under different
	/// labels, so neither can be turned into the other.
	async function digest(label, extraBytes) {
		var lab = utf8(label);
		var buf;
		if (extraBytes && extraBytes.length) {
			buf = new Uint8Array(lab.length + extraBytes.length);
			buf.set(lab, 0);
			buf.set(extraBytes, lab.length);
		} else {
			buf = lab;
		}
		return new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
	}

	/// The fixed PRF salt. Computed once and cached: it never varies.
	var _prfSalt = null;
	async function prfSalt() {
		if (!_prfSalt) _prfSalt = await digest(PRF_SALT_LABEL, null);
		return _prfSalt;
	}

	/// The gateway storage handle for a credential: base64url of
	/// `SHA-256(HANDLE_LABEL || credential_id)`.
	///
	/// Hashed rather than sent raw so that a gateway record cannot hand a
	/// credential id back to anyone who reads the store. The gateway matches this
	/// exactly (see `gateway/src/handlers/passkey_blob.rs`).
	async function handleFor(credIdBytes) {
		return b64urlEnc(await digest(HANDLE_LABEL, credIdBytes));
	}

	/// HKDF-SHA-256 the raw PRF secret into a non-extractable AES-GCM key. The
	/// salt is the PRF salt (also fed to the authenticator) and the info label is
	/// versioned, so the derivation is pinned and reproducible.
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
			if (!r || !r.cred || !r.blob) return null;
			// A v1 record is only usable with the random salt stored beside it;
			// v2 needs no salt, because the salt is a fixed label. Requiring one
			// unconditionally would make every v2 enrolment read as absent.
			if (r.v === 1 && !r.salt) return null;
			return r;
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

		var salt = await prfSalt();
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
						// REQUIRED, not preferred: a credential that is not
						// discoverable cannot be found by a device that holds
						// nothing, which is exactly the case this exists to serve.
						residentKey:        'required',
						requireResidentKey: true,
						userVerification:   'required',	// Force the biometric/PIN gesture — the whole point.
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
		// Creation-time PRF is unreliable across authenticators, so a follow-up
		// get() is how the secret is actually obtained.
		var got = await assertPrf(credId, salt);
		if (!got || !got.prf) {
			return {
				ok: false,
				error: 'This authenticator does not support the PRF extension, so it cannot unlock Daimond.',
			};
		}

		var sealed = await sealIdentity(got.prf, salt, passphrase);
		if (!sealed) {
			return { ok: false, error: 'The passkey could not be sealed. Nothing was saved.' };
		}
		try {
			localStorage.setItem(K_PASSKEY, JSON.stringify({
				v:    2,
				cred: b64urlEnc(credId),
				blob: sealed,
			}));
		} catch (e) {
			return { ok: false, error: 'The passkey could not be saved on this device.' };
		}
		// And a copy on the gateway, so the SAME passkey opens the account on a
		// device that has never seen it. Best-effort: without it the passkey
		// still unlocks here, which is what v1 did and no worse.
		var handle = await handleFor(credId);
		var synced = await putBlob(handle, sealed);
		return { ok: true, synced: synced };
	}

	/// Seal the whole identity -- the exported bundle AND the passphrase -- under
	/// a key derived from a PRF output.
	///
	/// Both halves are needed, and this is why. The passphrase alone cannot stand
	/// a new device up: the device signing key is generated at random on the
	/// device that created the account and can never be re-derived, so it has to
	/// travel. The bundle alone cannot either: everything in it is encrypted
	/// under `PBKDF2(passphrase, salt)`, so without the passphrase it does not
	/// open. Together they are a complete account.
	async function sealIdentity(prfBytes, saltBytes, passphrase) {
		try {
			var bundle = window.DaimondIdentity && DaimondIdentity.exportBundle();
			if (!bundle) return null;
			var key = await keyFromPrf(prfBytes, saltBytes);
			return await seal(key, utf8(JSON.stringify({ bundle: bundle, pass: passphrase })));
		} catch (e) {
			return null;
		}
	}

	/// Open what sealIdentity sealed, returning `{ bundle, pass }` or null.
	/// A v1 blob held the bare passphrase, so that shape is accepted too.
	async function openIdentity(prfBytes, saltBytes, blob) {
		try {
			var key   = await keyFromPrf(prfBytes, saltBytes);
			var plain = fromUtf8(await open(key, blob));
			if (plain.charAt(0) !== '{') return { bundle: null, pass: plain };	// v1: the passphrase alone.
			var o = JSON.parse(plain);
			return { bundle: o.bundle || null, pass: o.pass || '' };
		} catch (e) {
			return null;
		}
	}

	/// Assert a credential with the PRF extension, returning
	/// `{ prf, credId }` or null when the authenticator produced no PRF output.
	///
	/// `credIdBytes` names a specific credential; passing null instead asks for a
	/// DISCOVERABLE assertion, where the authenticator offers whatever Daimond
	/// passkeys it holds and tells us which one was chosen. That second form is
	/// what lets a device with nothing stored find the account: it learns the
	/// credential and its PRF secret from the same gesture.
	async function assertPrf(credIdBytes, saltBytes) {
		var req = {
			rpId:      location.hostname,
			challenge: crypto.getRandomValues(new Uint8Array(CHAL_BYTES)),
			userVerification: 'required',	// Demand Face ID / Touch ID / device PIN every time.
			timeout:   60000,
			extensions: { prf: { eval: { first: saltBytes } } },
		};
		// Omit allowCredentials entirely for the discoverable case: an empty
		// array is not the same thing, and some authenticators refuse it.
		if (credIdBytes) req.allowCredentials = [{ type: 'public-key', id: credIdBytes }];
		var assertion;
		try {
			assertion = await navigator.credentials.get({ publicKey: req });
		} catch (e) {
			return null;
		}
		if (!assertion) return null;
		try {
			var ext = assertion.getClientExtensionResults();
			var out = ext && ext.prf && ext.prf.results && ext.prf.results.first;
			if (!out) return null;
			return { prf: new Uint8Array(out), credId: new Uint8Array(assertion.rawId) };
		} catch (e) {
			return null;
		}
	}

	// ── The gateway's copy of the sealed bundle ────────────────
	// The credential syncs through iCloud Keychain or Google Password Manager;
	// the sealed bundle did not, because it lived in one browser's localStorage.
	// Keeping a copy on the gateway is what closes that gap. What is stored is
	// ciphertext under a key only the authenticator can rebuild, indexed by a
	// hash of the credential id, so the gateway learns nothing from holding it.

	/// The API version header the gateway expects, from the one place it is kept.
	function apiHeaders(extra) {
		var h = extra || {};
		try { h['x-daimond-api'] = String(DaimondGateway.clientApi()); } catch (e) { /* pre-boot */ }
		return h;
	}

	/// Upload the sealed bundle. Best-effort: a gateway that is down or an
	/// account with no session must not fail an enrolment that already works on
	/// this device. Returns whether it landed.
	async function putBlob(handle, blob) {
		try {
			var r = await fetch('/api/passkey-blob', {
				method: 'POST',
				headers: apiHeaders({ 'content-type': 'application/json' }),
				credentials: 'same-origin',
				body: JSON.stringify({ handle: handle, blob: blob }),
			});
			return r.ok;
		} catch (e) {
			return false;
		}
	}

	/// Fetch a sealed bundle by handle. No session is needed or sent — a device
	/// adopting an account has neither.
	async function getBlob(handle) {
		try {
			var r = await fetch('/api/passkey-blob?h=' + encodeURIComponent(handle), {
				headers: apiHeaders({}),
			});
			if (!r.ok) return null;
			var j = await r.json();
			return (j && j.ok && j.blob) ? j.blob : null;
		} catch (e) {
			return null;
		}
	}

	/// Drop the gateway's copy, so removing a passkey really removes what it
	/// opens rather than leaving the account adoptable by a revoked authenticator.
	async function deleteBlob(handle) {
		try {
			var r = await fetch('/api/passkey-blob?h=' + encodeURIComponent(handle), {
				method: 'DELETE',
				headers: apiHeaders({}),
				credentials: 'same-origin',
			});
			return r.ok;
		} catch (e) {
			return false;
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
		// A v1 record carries its own random salt; v2 uses the fixed one.
		var salt   = (r.v === 1 && r.salt) ? b64dec(r.salt) : await prfSalt();

		var got = await assertPrf(credId, salt);
		if (!got || !got.prf) {
			return { ok: false, error: 'The passkey could not be read. Use your passphrase.' };
		}

		var opened = await openIdentity(got.prf, salt, r.blob);
		if (!opened) {
			return { ok: false, error: 'The passkey did not match this identity. Use your passphrase.' };
		}

		var res;
		try { res = await DaimondIdentity.unlock(opened.pass); } catch (e) { res = { ok: false }; }
		if (!res || !res.ok) {
			// The sealed passphrase no longer opens the identity — the passphrase
			// was changed since enrolment. The passkey is stale; say so plainly.
			return { ok: false, error: 'This passkey is out of date. Unlock with your passphrase, then re-add it.' };
		}
		// A v1 record opens once more and is then quietly brought up to v2, which
		// is what puts a copy on the gateway and makes this passkey work on the
		// user's other devices. It costs no extra gesture: the PRF secret from the
		// assertion just made re-seals it.
		if (r.v !== 2) {
			await upgradeToV2(got.prf, credId, opened.pass);
		}
		opened.pass = null;
		return res;
	}

	/// Re-seal a v1 record under the fixed salt and publish it, keeping the same
	/// credential. Silent and best-effort -- the unlock has already succeeded, so
	/// nothing the user is waiting on depends on it.
	async function upgradeToV2(prfBytes, credIdBytes, passphrase) {
		try {
			var salt   = await prfSalt();
			var sealed = await sealIdentity(prfBytes, salt, passphrase);
			if (!sealed) return false;
			localStorage.setItem(K_PASSKEY, JSON.stringify({
				v:    2,
				cred: b64urlEnc(credIdBytes),
				blob: sealed,
			}));
			await putBlob(await handleFor(credIdBytes), sealed);
			return true;
		} catch (e) {
			return false;
		}
	}

	// ── Adopt: become the account on a device that holds nothing ──

	/// Bring an account to THIS device using a passkey alone.
	///
	/// This is the case a passkey could not serve before. The device has no
	/// identity, no session and no local record; all it has is the user's
	/// authenticator, into which the passkey synced. One discoverable assertion
	/// names the credential and yields its PRF secret; the sealed bundle comes
	/// from the gateway, keyed by a hash of that credential; opening it gives the
	/// identity and the passphrase, which are then adopted and unlocked by the
	/// ordinary path.
	///
	/// The user does not type anything and does not need a pairing code from
	/// another device. Resolves `{ ok:true, ... }` like a normal unlock, or
	/// `{ ok:false, error }` naming what was missing.
	async function adoptWithPasskey() {
		var cap = false;
		try { cap = await available(); } catch (e) { cap = false; }
		if (!cap) return { ok: false, error: 'This browser or device cannot use a passkey.' };
		if (!window.DaimondIdentity) return { ok: false, error: 'Identity support is unavailable.' };

		var salt = await prfSalt();
		var got  = await assertPrf(null, salt);		// discoverable: no credential named.
		if (!got || !got.prf) {
			return { ok: false, error: 'No Daimond passkey was offered, or it carried no PRF secret.' };
		}

		var blob = await getBlob(await handleFor(got.credId));
		if (!blob) {
			return {
				ok: false,
				error: 'That passkey is not set up to carry an account. On the device that has '
					+ 'your account, open Settings and add the passkey again.',
			};
		}

		var opened = await openIdentity(got.prf, salt, blob);
		if (!opened || !opened.bundle) {
			return { ok: false, error: 'That passkey did not open the account.' };
		}
		if (!DaimondIdentity.importBundle(opened.bundle)) {
			return { ok: false, error: 'The stored account could not be read.' };
		}
		var res;
		try { res = await DaimondIdentity.unlock(opened.pass); } catch (e) { res = { ok: false }; }
		opened.pass = null;
		if (!res || !res.ok) {
			return { ok: false, error: 'The stored account did not open. Use your passphrase.' };
		}
		// Now that the identity is here, keep a local copy of the sealed blob so
		// the next unlock on this device needs no gateway at all.
		try {
			localStorage.setItem(K_PASSKEY, JSON.stringify({
				v: 2, cred: b64urlEnc(got.credId), blob: blob,
			}));
		} catch (e) { /* unlocked anyway; the gateway copy still serves. */ }
		return res;
	}

	/// Re-seal the enrolled passkey against a new passphrase.
	///
	/// Changing the passphrase re-wraps the private key under a fresh salt, so
	/// the sealed copy is stale the moment it happens and the passkey would open
	/// onto a key that no longer works. This costs one biometric gesture and is
	/// called straight after a successful change.
	async function reseal(passphrase) {
		var r = record();
		if (!r) return { ok: false, error: 'No passkey is enrolled on this device.' };
		var salt = await prfSalt();
		var got  = await assertPrf(b64urlDec(r.cred), salt);
		if (!got || !got.prf) return { ok: false, error: 'The passkey could not be read.' };
		var sealed = await sealIdentity(got.prf, salt, passphrase);
		if (!sealed) return { ok: false, error: 'The passkey could not be re-sealed.' };
		try {
			localStorage.setItem(K_PASSKEY, JSON.stringify({
				v: 2, cred: b64urlEnc(got.credId), blob: sealed,
			}));
		} catch (e) {
			return { ok: false, error: 'The passkey could not be saved on this device.' };
		}
		await putBlob(await handleFor(got.credId), sealed);
		return { ok: true };
	}

	// ── Remove ─────────────────────────────────────────────────

	/// Forget the enrolled passkey for this account: the local sealed blob AND the
	/// gateway's copy.
	///
	/// Dropping only the local copy would be a false revocation now that the
	/// gateway holds one — the account would stay adoptable by an authenticator
	/// the user believes they have removed. The credential itself stays in the
	/// authenticator, where it is inert without a blob to open, and the user can
	/// delete it there at their leisure.
	async function remove() {
		var r = record();
		try { localStorage.removeItem(K_PASSKEY); } catch (e) { /* nothing to remove */ }
		if (r && r.cred) {
			try { await deleteBlob(await handleFor(b64urlDec(r.cred))); } catch (e) { /* offline */ }
		}
		return true;
	}

	/// Whether a passkey on THIS device might be able to adopt an account.
	///
	/// It cannot be known for certain without asking the authenticator, which
	/// costs a biometric prompt, so this reports only that the platform can do it
	/// and that no identity is already here — enough to decide whether to offer.
	async function canAdopt() {
		try {
			if (window.DaimondIdentity && DaimondIdentity.exists()) return false;
			return await available();
		} catch (e) {
			return false;
		}
	}

	// ── Public surface ─────────────────────────────────────────
	window.DaimondPasskey = {
		available:          available,
		isEnrolled:         isEnrolled,
		enrol:              enrol,
		unlockWithPasskey:  unlockWithPasskey,
		adoptWithPasskey:   adoptWithPasskey,
		canAdopt:           canAdopt,
		reseal:             reseal,
		remove:             remove,
	};
})();
