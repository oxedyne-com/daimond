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
#[path = "../../tests/unit/seal/runner/tests.rs"]
mod tests;
