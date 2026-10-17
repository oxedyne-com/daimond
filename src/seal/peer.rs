//! The peer envelope's framing: a four-byte tag in front of the sealed body, so the open path
//! routes each scheme without a trial decrypt (peer.js `sealForSelf`/`openSealed`).
//!
//! | Tag    | Body                                                     | Written |
//! |--------|----------------------------------------------------------|---------|
//! | `DPY2` | the account wrap with AAD `daimond/peer/env/1`           | yes     |
//! | `DPY1` | the account wrap without AAD (the first-hour legacy)     | no      |
//! | `DPS1` | a [`post`](crate::seal::post) record, the X25519 legacy  | no      |
//!
//! The plaintext is the UTF-8 JSON of the signed envelope; signing stays with the page.

use crate::seal::{post, wrap, Refusal};

use oxedyne_fe2o3_core::prelude::*;

/// The current scheme's tag.
pub const DPY2: [u8; 4] = *b"DPY2";
/// The legacy symmetric scheme's tag.
pub const DPY1: [u8; 4] = *b"DPY1";
/// The purpose bound into a `DPY2` body.
pub const AAD: &[u8] = b"daimond/peer/env/1";

/// Which scheme sealed a body.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scheme {
	Dpy2,
	Dpy1,
	Dps1,
}

impl Scheme {
	/// The tag as the page names it.
	pub fn name(&self) -> &'static str {
		match self {
			Self::Dpy2	=> "DPY2",
			Self::Dpy1	=> "DPY1",
			Self::Dps1	=> "DPS1",
		}
	}
}

/// The scheme a body's tag names, or `None` for a body with no known tag.
pub fn scheme_of(bytes: &[u8]) -> Option<Scheme> {
	if bytes.len() < 4 {
		return None;
	}
	let t = &bytes[..4];
	if t == DPY2 {
		Some(Scheme::Dpy2)
	} else if t == DPY1 {
		Some(Scheme::Dpy1)
	} else if t == post::MAGIC {
		Some(Scheme::Dps1)
	} else {
		None
	}
}

/// `DPY2 ‖ body`, for a body the key holder sealed (in the tab, identity.js `wrapBytesAad` with
/// [`AAD`]).
pub fn frame(body: &[u8]) -> Vec<u8> {
	let mut out = Vec::with_capacity(4 + body.len());
	out.extend_from_slice(&DPY2);
	out.extend_from_slice(body);
	out
}

/// Seal an envelope's plaintext under the raw account key (native).
pub fn seal(key: &[u8], plain: &[u8]) -> Outcome<Vec<u8>> {
	Ok(frame(&res!(wrap::seal(key, plain, Some(AAD)))))
}

/// Open a body of any scheme (native): `key` is the raw account wrap key, `sk` the device's
/// X25519 sealing secret for a legacy `DPS1` body.
pub fn open(key: &[u8], bytes: &[u8], sk: Option<&[u8]>) -> Outcome<Vec<u8>> {
	match scheme_of(bytes) {
		Some(Scheme::Dpy2)	=> match wrap::open(key, &bytes[4..], Some(AAD)) {
			Ok(p)	=> Ok(p),
			Err(e)	=> Err(err!(e, "seal:not_for_you: peer: this errand was not sealed to this \
				account, so it is not for this device."; Invalid, Input)),
		},
		Some(Scheme::Dpy1)	=> match wrap::open(key, &bytes[4..], None) {
			Ok(p)	=> Ok(p),
			Err(e)	=> Err(err!(e, "seal:not_for_you: peer: this errand was not sealed to this \
				account, so it is not for this device."; Invalid, Input)),
		},
		Some(Scheme::Dps1)	=> match sk {
			Some(sk)	=> Ok(res!(post::open(bytes, sk)).plain),
			None		=> Err(Refusal::NotForYou.err(
				"A legacy DPS1 envelope needs this device's sealing secret to open.")),
		},
		None				=> Err(Refusal::NotSealed.err("That is not a sealed peer body.")),
	}
}
