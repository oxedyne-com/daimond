//! The seal: the records a post, a peer envelope and the account's own items travel in, written
//! and read by ONE code path that the browser (through the wasm) and the native runner share.
//!
//! The bytes are exactly those the page's JavaScript wrote before this module existed (S1 SEAL,
//! 16 Oct 2026); no format changes here, so a device on the old code and one on this read each
//! other's records.  `testdata/js_vectors.json` holds records captured from that JavaScript and the
//! tests open every one.
//!
//! - [`post`]: `DPS1`, a message sealed to a list of X25519 public keys.
//! - [`wrap`]: the account wrap, `iv ‖ AES-256-GCM`, and its convergent chunk form.
//! - [`peer`]: the peer envelope's framing, `DPY2` (and the legacy `DPY1`, opened only).
//!
//! Where a key is held matters more than where the arithmetic runs.  In the tab, the account wrap
//! key and the device's X25519 secret are non-extractable WebCrypto keys held by identity.js, and
//! they stay there: the tab hands this module the 32 bytes of an X25519 agreement, or asks
//! identity.js for the one AES-GCM operation under the account key, and never the key itself.
//! Natively the runner holds the raw keys and runs every path here end to end.
//!
//! Errors a page shows a person carry a short code at the front of their message,
//! `seal:<code>:`, which the page maps to its own translated sentence (see [`Refusal`]).

pub mod peer;
pub mod post;
pub mod wrap;

#[cfg(test)]
mod tests;

use oxedyne_fe2o3_core::prelude::*;
use oxedyne_fe2o3_core::rand::Rand;

/// AES-GCM nonce length, as every record here frames it.
pub const IV_LEN: usize = 12;
/// AES-GCM tag length.
pub const TAG_LEN: usize = 16;
/// An X25519 key, public or secret, and an AES-256 key.
pub const KEY_LEN: usize = 32;

/// The refusals a person sees, each with the code the page translates.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
	/// No recipient key was given.
	NoRecipient,
	/// More recipients than one byte counts.
	TooMany,
	/// A recipient key is not 32 bytes.
	BadKey,
	/// Shorter than the smallest record of its kind.
	Short,
	/// The tag at the front is not this record's.
	NotSealed,
	/// No slot opened with this device's key.
	NotForYou,
	/// The body did not open: a changed byte, or a record put together from two.
	Damaged,
}

impl Refusal {
	/// The code the page keys its sentence on.
	pub fn code(&self) -> &'static str {
		match self {
			Self::NoRecipient	=> "no_recipient",
			Self::TooMany		=> "too_many",
			Self::BadKey		=> "bad_key",
			Self::Short			=> "short",
			Self::NotSealed		=> "not_sealed",
			Self::NotForYou		=> "not_for_you",
			Self::Damaged		=> "damaged",
		}
	}

	/// The code a refusal's message starts with, read back out, or `None` for any other error.
	pub fn of_message(msg: &str) -> Option<&'static str> {
		let at = match msg.find("seal:") {
			Some(at)	=> at + 5,
			None		=> return None,
		};
		let rest = &msg[at..];
		for r in [Self::NoRecipient, Self::TooMany, Self::BadKey, Self::Short, Self::NotSealed,
			Self::NotForYou, Self::Damaged]
		{
			let c = r.code();
			if rest.starts_with(c) && rest[c.len()..].starts_with(':') {
				return Some(c);
			}
		}
		None
	}

	/// This refusal as an error, its code first.
	pub fn err(&self, why: &str) -> Error<ErrTag> {
		err!("seal:{}: {}", self.code(), why; Invalid, Input)
	}
}

/// Fill `out` from the operating system's generator (getrandom; in the browser,
/// `crypto.getRandomValues`), eight bytes at a time.
pub(crate) fn os_random(out: &mut [u8]) {
	for chunk in out.chunks_mut(8) {
		let r = Rand::rand_u64().to_le_bytes();
		let n = chunk.len();
		chunk.copy_from_slice(&r[..n]);
	}
}

/// Hex of `bytes`, lower case.
pub fn hex(bytes: &[u8]) -> String {
	const H: &[u8; 16] = b"0123456789abcdef";
	let mut s = String::with_capacity(bytes.len() * 2);
	for b in bytes {
		s.push(H[(b >> 4) as usize] as char);
		s.push(H[(b & 15) as usize] as char);
	}
	s
}

/// The bytes of a hex string, either case.
pub fn unhex(s: &str) -> Outcome<Vec<u8>> {
	let b = s.as_bytes();
	if b.len() % 2 != 0 {
		return Err(err!("Hex of odd length {}.", b.len(); Invalid, Input, Decode));
	}
	let nib = |c: u8| -> Outcome<u8> {
		match c {
			b'0'..=b'9'	=> Ok(c - b'0'),
			b'a'..=b'f'	=> Ok(c - b'a' + 10),
			b'A'..=b'F'	=> Ok(c - b'A' + 10),
			_			=> Err(err!("{:?} is not a hex digit.", c as char; Invalid, Input, Decode)),
		}
	};
	let mut out = Vec::with_capacity(b.len() / 2);
	for pair in b.chunks(2) {
		out.push((res!(nib(pair[0])) << 4) | res!(nib(pair[1])));
	}
	Ok(out)
}
