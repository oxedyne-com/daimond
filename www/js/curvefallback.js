/* ============================================================
   Daimond — pure-JS Ed25519 / X25519 fallback (curvefallback.js)
   ------------------------------------------------------------
   A last resort for a browser whose WebCrypto does not implement
   Ed25519 or X25519. Ed25519 arrived in Chrome 137, Firefox 129 and
   Safari 17, X25519 in Chrome 133, Firefox 130 and Safari 17, and a
   device stuck below those (an iPhone X on iOS 16, a Windows 7 PC,
   Firefox ESR 115) lacks them. On those engines the passphrase-
   derived AES-GCM unwrap of the private key still works, but the
   importKey/deriveBits call that loads the signing or sealing key
   THROWS, and the account cannot be opened at all. This module lets
   identity.js fall back to the vendored @noble/curves implementation
   so the same account still signs and still opens sealed messages.

   It MAKES keys too, since 2026-09-23: every Daimond account is
   Ed25519 on every browser (the owner's ruling, D-20260923-46), so an
   account created on such an engine gets its Ed25519 signing key
   here rather than a key of another curve. The pkcs8 built around it
   is the one WebCrypto emits, so a modern browser opens the account
   natively afterwards.

   INTEROPERABILITY. The fallback is bit-identical to WebCrypto:
   Ed25519 is deterministic (RFC 8032), so a signature made here
   verifies under WebCrypto and vice versa; an X25519 shared secret
   computed here equals the one WebCrypto derives from the same keys.
   Verified against Node's WebCrypto for both curves. Nothing about
   the on-disk format or the account's algorithm changes.

   SECURITY TRADEOFF — READ THIS. WebCrypto keeps a private key
   NON-EXTRACTABLE: the bytes never enter JS. This fallback cannot;
   it necessarily holds the raw 32-byte Ed25519 seed and the raw
   32-byte X25519 scalar in JS memory for as long as the identity is
   unlocked. That is a real reduction in protection against a script
   that can read this page's heap. It is accepted ONLY because the
   alternative on these engines is that the user cannot log in on
   this device AT ALL. The material is never logged and never
   transmitted; identity.js zeroes it on lock() where practical.
   Callers must keep it that way.

   Classic script, attached as `window.DaimondCurveFallback` to match
   identity.js. Depends on `window.DaimondNoble` from
   vendor/noble-curves.min.js, which must load first.
   ============================================================ */
(function () {
	'use strict';

	// pkcs8 (RFC 8410) for these curves is a fixed 48-byte structure: a
	// 16-byte header, then the 32-byte key. The header's twelfth byte is the
	// algorithm OID's final octet — 0x70 for Ed25519, 0x6e for X25519 — and it
	// is the one byte worth checking, so a key of the wrong curve is refused
	// rather than silently misread.
	var PKCS8_LEN   = 48;
	var HEADER_LEN  = 16;
	var OID_INDEX   = 11;
	var OID_ED25519 = 0x70;
	var OID_X25519  = 0x6e;

	// The exact 16-byte pkcs8 headers WebCrypto emits for these curves, used to
	// build a pkcs8 around a freshly generated key so a later modern browser can
	// import it unchanged. They differ only in the OID's final octet.
	var ED25519_PKCS8_HEADER = [
		0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06,
		0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
	];
	var X25519_PKCS8_HEADER = [
		0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06,
		0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20,
	];

	function noble() {
		return (typeof window !== 'undefined' && window.DaimondNoble) || null;
	}

	/// Is the vendored pure-JS implementation loaded and usable?
	function available() {
		var n = noble();
		return !!(n && n.ed25519 && n.x25519
			&& typeof n.ed25519.sign === 'function'
			&& typeof n.x25519.getSharedSecret === 'function');
	}

	/// Extract the 32-byte key from a pkcs8 of the expected curve, or throw.
	function keyFromPkcs8(pkcs8, oidByte) {
		var b = (pkcs8 instanceof Uint8Array) ? pkcs8 : new Uint8Array(pkcs8);
		if (b.length !== PKCS8_LEN || b[OID_INDEX] !== oidByte) {
			throw new Error('curvefallback: unexpected pkcs8 shape');
		}
		return b.slice(HEADER_LEN);		// a copy, not a view onto the caller's buffer.
	}

	/// The 32-byte Ed25519 seed from an Ed25519 pkcs8.
	function edSeedFromPkcs8(pkcs8) {
		return keyFromPkcs8(pkcs8, OID_ED25519);
	}

	/// The 32-byte X25519 scalar from an X25519 pkcs8.
	function xScalarFromPkcs8(pkcs8) {
		return keyFromPkcs8(pkcs8, OID_X25519);
	}

	/// Wrap a 32-byte key in the pkcs8 WebCrypto would emit under `header`.
	function pkcs8FromKey(key, header, what) {
		var k = (key instanceof Uint8Array) ? key : new Uint8Array(key);
		if (k.length !== 32) throw new Error('curvefallback: ' + what + ' must be 32 bytes');
		var out = new Uint8Array(PKCS8_LEN);
		out.set(header, 0);
		out.set(k, HEADER_LEN);
		return out;
	}

	/// Wrap a 32-byte Ed25519 seed in the pkcs8 WebCrypto would emit, so a
	/// signing key made here is stored exactly as a modern engine stores one.
	function edPkcs8FromSeed(seed) {
		return pkcs8FromKey(seed, ED25519_PKCS8_HEADER, 'Ed25519 seed');
	}

	/// Wrap a 32-byte X25519 scalar back into the pkcs8 WebCrypto would emit,
	/// so a stored sealing key made here stays importable by a modern engine.
	function xPkcs8FromScalar(scalar) {
		return pkcs8FromKey(scalar, X25519_PKCS8_HEADER, 'X25519 scalar');
	}

	/// The raw 32-byte Ed25519 public key for a seed.
	function edPublicKey(seed) {
		return noble().ed25519.getPublicKey(seed);
	}

	/// An Ed25519 signature (64 bytes) over the given bytes. Deterministic,
	/// so identical to the one WebCrypto would produce for the same key.
	function edSign(seed, data) {
		return noble().ed25519.sign(data, seed);
	}

	/// Verify an Ed25519 signature. Used by the interop test.
	function edVerify(pub, sig, data) {
		try { return noble().ed25519.verify(sig, data, pub); }
		catch (e) { return false; }
	}

	/// The raw 32-byte X25519 public key for a scalar.
	function xPublicKey(scalar) {
		return noble().x25519.getPublicKey(scalar);
	}

	/// The raw 32-byte X25519 shared secret — the same bytes WebCrypto's
	/// deriveBits returns. The INPUT to a key derivation, never a key itself.
	function xSharedSecret(scalar, theirPub) {
		return noble().x25519.getSharedSecret(scalar, theirPub);
	}

	/// A fresh 32-byte Ed25519 seed for generating a signing key on an engine
	/// without WebCrypto Ed25519. An Ed25519 private key IS 32 uniformly random
	/// bytes (RFC 8032 5.1.5), and it is what pkcs8 carries, so this is the
	/// whole of key generation; the public key follows from it.
	function randomEdSeed() {
		return crypto.getRandomValues(new Uint8Array(32));
	}

	/// A fresh 32-byte X25519 scalar for generating a sealing key on an engine
	/// without WebCrypto X25519. noble clamps at use; WebCrypto clamps on
	/// import, so the two agree on the derived secret.
	function randomXScalar() {
		return crypto.getRandomValues(new Uint8Array(32));
	}

	/// Best-effort overwrite of a byte buffer. Not a guarantee — the JS engine
	/// may have copied it — but it shortens the window where the material sits
	/// readable, which is the whole reason this file documents its tradeoff.
	function zero(bytes) {
		if (bytes && typeof bytes.fill === 'function') {
			try { bytes.fill(0); } catch (e) { /* frozen or detached */ }
		}
	}

	window.DaimondCurveFallback = {
		available:         available,
		edSeedFromPkcs8:   edSeedFromPkcs8,
		xScalarFromPkcs8:  xScalarFromPkcs8,
		edPkcs8FromSeed:   edPkcs8FromSeed,
		xPkcs8FromScalar:  xPkcs8FromScalar,
		edPublicKey:       edPublicKey,
		edSign:            edSign,
		edVerify:          edVerify,
		xPublicKey:        xPublicKey,
		xSharedSecret:     xSharedSecret,
		randomEdSeed:      randomEdSeed,
		randomXScalar:     randomXScalar,
		zero:              zero,
	};
})();
