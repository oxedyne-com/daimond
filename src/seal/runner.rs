//! The runner bundle (R2d1): the account's keys, sealed by the approving tab to ONE runner's
//! device key, so the gateway that carries it to the runner holds a record it cannot open
//! (native runner design §5, "Approve"; invariant: no content key on the gateway, ever).
//!
//! A runner's device key is Ed25519 (rulings §4, R2a), and the seal's recipient is an X25519
//! public key ([`post`]).  The two curves are one curve in two coordinates, so the runner needs no
//! second key: the tab maps the Edwards public key to its Montgomery form ([`recipient_of`]), and
//! the runner's keeper turns its 32-byte Ed25519 seed into the matching X25519 scalar
//! ([`secret_of`]: the first half of SHA-512 of the seed, RFC 8032 §5.1.5, which X25519 clamps
//! as it uses it).  The record is an ordinary `DPS1` with exactly one slot.
//!
//! The plaintext is the JSON the tab builds (passkey.js `approveRunner`): what the passkey's PRF
//! opened (the identity bundle and its passphrase), bound to the runner's device id, so a bundle
//! lifted from one runner's approval and handed to another is refused by the keeper (R2d2).

use crate::seal::{post, Refusal, KEY_LEN};

use oxedyne_fe2o3_core::prelude::*;

use curve25519_dalek::edwards::CompressedEdwardsY;
use sha2::{Digest, Sha512};
use zeroize::Zeroizing;

/// The `kind` a runner bundle's plaintext names.
pub const KIND: &str = "kimberlite-bundle";

/// The X25519 public key (Montgomery u) that an Ed25519 public key's point has.  Refuses a key
/// that is not a point, and one of small order, which would seal to a key everyone holds.
pub fn recipient_of(ed_pk: &[u8]) -> Outcome<[u8; KEY_LEN]> {
	if ed_pk.len() != KEY_LEN {
		return Err(Refusal::BadKey.err("The runner's device key is not 32 bytes."));
	}
	let mut b = [0u8; KEY_LEN];
	b.copy_from_slice(ed_pk);
	let point = match CompressedEdwardsY(b).decompress() {
		Some(p)	=> p,
		None	=> return Err(Refusal::BadKey.err("The runner's device key is not a curve point.")),
	};
	if point.is_small_order() {
		return Err(Refusal::BadKey.err("The runner's device key is of small order."));
	}
	Ok(point.to_montgomery().to_bytes())
}

/// The X25519 secret that matches [`recipient_of`] of the seed's public key: the first 32 bytes
/// of SHA-512(seed).  Native only in use (the keeper holds the seed); the copy is wiped on drop.
pub fn secret_of(ed_seed: &[u8]) -> Outcome<Zeroizing<[u8; KEY_LEN]>> {
	if ed_seed.len() != KEY_LEN {
		return Err(Refusal::BadKey.err("The runner's device secret is not 32 bytes."));
	}
	let h = Sha512::digest(ed_seed);
	let mut sk = Zeroizing::new([0u8; KEY_LEN]);
	sk.copy_from_slice(&h[..KEY_LEN]);
	Ok(sk)
}

/// Seal `plain` to the runner whose Ed25519 public key is `ed_pk`: a one-slot `DPS1`.
pub fn seal(ed_pk: &[u8], plain: &[u8]) -> Outcome<Vec<u8>> {
	let to = res!(recipient_of(ed_pk));
	post::seal(&[to], plain)
}

/// Open a runner bundle with the runner's Ed25519 seed (the keeper, R2d2).
pub fn open(bundle: &[u8], ed_seed: &[u8]) -> Outcome<Vec<u8>> {
	let sk = res!(secret_of(ed_seed));
	Ok(res!(post::open(bundle, &sk[..])).plain)
}

#[cfg(test)]
mod tests {
	use super::*;

	use oxedyne_fe2o3_crypto::sign::SignatureScheme;
	use oxedyne_fe2o3_iop_crypto::keys::KeyManager;

	/// The vector the node test (`www/js/runnerapprove.test.mjs`) seals with over the wasm and the
	/// gateway test reads: one fixed runner key, a plaintext carrying a known sentinel, and a
	/// bundle this code sealed.  `R2D_REGEN=1` rewrites it.
	const VECTOR: &str = include_str!("testdata/runner_bundle.json");
	const VECTOR_PATH: &str = "src/seal/testdata/runner_bundle.json";
	pub const SENTINEL: &str = "R2D-PLAINTEXT-SENTINEL-7f3a9c";

	fn field(v: &str, k: &str) -> String {
		let pat = fmt!("\"{}\":\"", k);
		match v.find(&pat) {
			Some(at)	=> {
				let rest = &v[at + pat.len()..];
				rest[..rest.find('"').unwrap_or(0)].to_string()
			}
			None		=> String::new(),
		}
	}

	fn refusal<T>(o: Outcome<T>) -> Option<&'static str> {
		match o {
			Ok(_)	=> None,
			Err(e)	=> Refusal::of_message(&fmt!("{}", e)),
		}
	}

	fn ed_pair(seed: &[u8]) -> Outcome<Vec<u8>> {
		let sk = res!(<[u8; 32]>::try_from(seed).map_err(|_| err!("seed of {} bytes", seed.len(); Invalid, Input)));
		Ok(ed25519_dalek_pub(&sk).to_vec())
	}

	fn ed25519_dalek_pub(seed: &[u8; 32]) -> [u8; 32] {
		// a = clamp(SHA-512(seed)[..32]); A = a·B.
		use curve25519_dalek::{constants::ED25519_BASEPOINT_TABLE, scalar::Scalar};
		let h = Sha512::digest(seed);
		let mut a = [0u8; 32];
		a.copy_from_slice(&h[..32]);
		a[0] &= 248;
		a[31] &= 127;
		a[31] |= 64;
		let s = Scalar::from_bytes_mod_order(a);
		(ED25519_BASEPOINT_TABLE * &s).compress().to_bytes()
	}

	/// The Montgomery form of a runner's public key is the X25519 public of its seed's scalar,
	/// for a fresh fe2o3 Ed25519 key: the tab's recipient and the keeper's secret agree.
	#[test]
	fn the_recipient_and_the_secret_agree() -> Outcome<()> {
		for _ in 0..8 {
			let dev = SignatureScheme::new_ed25519();
			let pk = res!(dev.get_public_key()).map(|k| k.to_vec()).unwrap_or_default();
			let sk = res!(dev.get_secret_key()).map(|k| k.to_vec()).unwrap_or_default();
			let x_pk = res!(recipient_of(&pk));
			let x_sk = res!(secret_of(&sk));
			let want = res!(oxedyne_fe2o3_crypto::agree::AgreementScheme::x25519_public_of(&x_sk[..]));
			assert_eq!(x_pk.to_vec(), want.to_vec(), "the recipient must be the secret's public");
			assert_eq!(res!(ed_pair(&sk)), pk);
		}
		Ok(())
	}

	/// A bundle opens with the runner's seed and with no other key, and carries no plaintext.
	#[test]
	fn a_bundle_opens_only_with_its_runner_key() -> Outcome<()> {
		let a = SignatureScheme::new_ed25519();
		let b = SignatureScheme::new_ed25519();
		let a_pk = res!(a.get_public_key()).map(|k| k.to_vec()).unwrap_or_default();
		let a_sk = res!(a.get_secret_key()).map(|k| k.to_vec()).unwrap_or_default();
		let b_sk = res!(b.get_secret_key()).map(|k| k.to_vec()).unwrap_or_default();
		let plain = fmt!("{{\"kind\":\"{}\",\"pass\":\"{}\"}}", KIND, SENTINEL);
		let sealed = res!(seal(&a_pk, plain.as_bytes()));
		assert!(!contains(&sealed, SENTINEL.as_bytes()), "the bundle carries its plaintext");
		assert_eq!(sealed[36], 1, "a runner bundle has exactly one slot");
		assert_eq!(res!(open(&sealed, &a_sk)), plain.as_bytes().to_vec());
		assert_eq!(refusal(open(&sealed, &b_sk)), Some("not_for_you"));
		Ok(())
	}

	/// A key that is not a point, or is of small order, is refused, never sealed to.
	#[test]
	fn a_bad_runner_key_is_refused() {
		assert_eq!(refusal(recipient_of(&[0u8; 31])), Some("bad_key"));
		// The identity point (y = 1) is of small order.
		let mut id = [0u8; 32];
		id[0] = 1;
		assert_eq!(refusal(recipient_of(&id)), Some("bad_key"));
		// y = 2 is not on the curve.
		let mut off = [0u8; 32];
		off[0] = 2;
		assert_eq!(refusal(recipient_of(&off)), Some("bad_key"));
	}

	fn contains(hay: &[u8], needle: &[u8]) -> bool {
		hay.windows(needle.len()).any(|w| w == needle)
	}

	/// The committed vector: its key, its Montgomery form and its bundle all hold, and the bundle
	/// opens to the plaintext with the sentinel.  Also opens what the wasm sealed (the node test
	/// writes `wasm_bundle` when run with `R2D_REGEN=1`).
	#[test]
	fn the_committed_vector_holds() -> Outcome<()> {
		let seed = res!(crate::seal::unhex(&field(VECTOR, "ed_seed")));
		let pk = res!(crate::seal::unhex(&field(VECTOR, "ed_pk")));
		if std::env::var("R2D_REGEN").is_ok() {
			let pk = res!(ed_pair(&seed));
			let x = res!(recipient_of(&pk));
			let plain = fmt!("{{\"v\":1,\"kind\":\"{}\",\"device\":\"rvector\",\"pass\":\"{}\"}}",
				KIND, SENTINEL);
			let sealed = res!(seal(&pk, plain.as_bytes()));
			let out = fmt!("{{\n  \"about\": \"R2d1 runner bundle vector: src/seal/runner.rs writes it (R2D_REGEN=1); \
				www/js/runnerapprove.test.mjs seals over the wasm with ed_pk and opens with ed_seed; the gateway \
				test reads bundle.\",\n  \"ed_seed\":\"{}\",\n  \"ed_pk\":\"{}\",\n  \"x_pk\":\"{}\",\n  \
				\"sentinel\":\"{}\",\n  \"plain\":\"{}\",\n  \"bundle\":\"{}\"\n}}\n",
				crate::seal::hex(&seed), crate::seal::hex(&pk), crate::seal::hex(&x), SENTINEL,
				plain.replace('"', "'"), crate::seal::hex(&sealed));
			res!(std::fs::write(VECTOR_PATH, out).map_err(|e| err!(e, "write vector"; IO, File, Write)));
			return Ok(());
		}
		assert_eq!(res!(ed_pair(&seed)), pk, "the vector's public key is its seed's");
		let x = res!(crate::seal::unhex(&field(VECTOR, "x_pk")));
		assert_eq!(res!(recipient_of(&pk)).to_vec(), x);
		let bundle = res!(crate::seal::unhex(&field(VECTOR, "bundle")));
		assert!(!contains(&bundle, SENTINEL.as_bytes()));
		let plain = res!(open(&bundle, &seed));
		let want = field(VECTOR, "plain").replace('\'', "\"");
		assert_eq!(String::from_utf8_lossy(&plain), want);
		Ok(())
	}
}
