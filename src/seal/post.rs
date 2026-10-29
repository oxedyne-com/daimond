//! `DPS1`: a message sealed to a list of X25519 public keys, as post.js has always written it.
//!
//! ```text
//! "DPS1"(4) ‖ epk(32) ‖ n(1, 1..255) ‖ slot × n ‖ biv(12) ‖ AES-256-GCM(ck, body) ‖ tag(16)
//! slot = iv(12) ‖ AES-256-GCM(slot key, ck) ‖ tag(16)            (60 bytes)
//! ```
//!
//! One ephemeral X25519 pair per message.  Each slot key is HKDF-SHA256 of the agreement with
//! that recipient, salted with `epk ‖ recipient`, so a slot lifted into another envelope derives
//! a different key; slots are bound to `"DPS1" ‖ epk`.  The body key `ck` is 32 random bytes and
//! the body is bound to the WHOLE head (tag to the last slot), so no slot can be swapped in from
//! another envelope without the body ceasing to open.  Nothing says which slot is whose: the
//! reader tries its one key against every slot.

use crate::seal::{os_random, Refusal, IV_LEN, KEY_LEN, TAG_LEN};

use oxedyne_fe2o3_core::prelude::*;
use oxedyne_fe2o3_crypto::{
	agree::AgreementScheme,
	enc::EncryptionScheme,
	mac::hkdf_sha256,
};

use zeroize::Zeroizing;

/// The record's tag.
pub const MAGIC: [u8; 4] = *b"DPS1";
/// The HKDF info each slot key is derived under.
pub const INFO: &[u8] = b"daimond.post.seal.v1";
/// One slot: its nonce, the sealed 32-byte body key and its tag.
pub const SLOT_LEN: usize = IV_LEN + KEY_LEN + TAG_LEN;
/// The most recipients one count byte allows.
pub const SLOTS_MAX: usize = 255;
/// Tag, ephemeral key and count.
pub const HEAD_FIXED: usize = 4 + KEY_LEN + 1;
/// The smallest record: one slot and an empty body.
pub const MIN_LEN: usize = HEAD_FIXED + SLOT_LEN + IV_LEN + TAG_LEN;

/// What an open answers: the plaintext and the body key that opened it (report.js hands an
/// operator both, so a report is verifiable without a second seal implementation).
pub struct Opened {
	pub plain:	Vec<u8>,
	pub ck:		Zeroizing<[u8; KEY_LEN]>,
}

/// The slot key for one recipient, from the raw agreement.
fn slot_key(shared: &[u8], epk: &[u8], theirs: &[u8]) -> Outcome<Zeroizing<[u8; KEY_LEN]>> {
	let mut salt = [0u8; 2 * KEY_LEN];
	salt[..KEY_LEN].copy_from_slice(epk);
	salt[KEY_LEN..].copy_from_slice(theirs);
	let mut k = Zeroizing::new([0u8; KEY_LEN]);
	res!(hkdf_sha256(shared, &salt, INFO, &mut k[..]));
	Ok(k)
}

/// The slot AAD, `"DPS1" ‖ epk`.
fn slot_aad(epk: &[u8]) -> [u8; 4 + KEY_LEN] {
	let mut aad = [0u8; 4 + KEY_LEN];
	aad[..4].copy_from_slice(&MAGIC);
	aad[4..].copy_from_slice(epk);
	aad
}

/// Seal `plain` to `recipients`.  The sender puts their own key in the list to keep a Sent copy;
/// nothing here adds one, because a caller that did not ask for a slot must not get one.
pub fn seal(recipients: &[[u8; KEY_LEN]], plain: &[u8]) -> Outcome<Vec<u8>> {
	if recipients.is_empty() {
		return Err(Refusal::NoRecipient.err("A sealed message needs at least one recipient key."));
	}
	if recipients.len() > SLOTS_MAX {
		return Err(Refusal::TooMany.err(&fmt!(
			"A message can be sealed to at most {} people at once.", SLOTS_MAX)));
	}
	let mut esk = Zeroizing::new([0u8; KEY_LEN]);
	os_random(&mut esk[..]);
	let epk = res!(AgreementScheme::x25519_public_of(&esk[..]));
	let mut ck = Zeroizing::new([0u8; KEY_LEN]);
	os_random(&mut ck[..]);
	let aad = slot_aad(&epk);

	let n = recipients.len();
	let mut out = Vec::with_capacity(HEAD_FIXED + n * SLOT_LEN + IV_LEN + plain.len() + TAG_LEN);
	out.extend_from_slice(&MAGIC);
	out.extend_from_slice(&epk);
	out.push(n as u8);
	for theirs in recipients {
		// WebCrypto refuses an all zero agreement, and so does this: a small-order key is not
		// a recipient anybody holds the secret of.
		let shared = Zeroizing::new(match AgreementScheme::x25519_agree(&esk[..], theirs) {
			Ok(s)	=> s,
			Err(e)	=> return Err(err!(e,
				"seal:bad_key: One of the recipients has no usable key, so nothing was sent.";
				Invalid, Input, Key)),
		});
		let k = res!(slot_key(&shared[..], &epk, theirs));
		let iv = EncryptionScheme::aes_256_gcm_nonce();
		let ct = res!(EncryptionScheme::aes_256_gcm_seal(&k[..], &iv, &aad, &ck[..]));
		out.extend_from_slice(&iv);
		out.extend_from_slice(&ct);
	}
	let head_end = out.len();
	let biv = EncryptionScheme::aes_256_gcm_nonce();
	let bct = res!(EncryptionScheme::aes_256_gcm_seal(&ck[..], &biv, &out[..head_end], plain));
	out.extend_from_slice(&biv);
	out.extend_from_slice(&bct);
	Ok(out)
}

/// Check the header and answer the ephemeral public key, which the holder of a sealing secret
/// agrees with (in the tab, identity.js does that with its non-extractable key).
pub fn epk(bytes: &[u8]) -> Outcome<[u8; KEY_LEN]> {
	let _ = res!(head_end(bytes));
	let mut epk = [0u8; KEY_LEN];
	epk.copy_from_slice(&bytes[4..4 + KEY_LEN]);
	Ok(epk)
}

/// Where the head ends (the body nonce starts), refusing a record too short or wrongly tagged.
fn head_end(bytes: &[u8]) -> Outcome<usize> {
	if bytes.len() < MIN_LEN {
		return Err(Refusal::Short.err("That message is too short to be one."));
	}
	if bytes[..4] != MAGIC {
		return Err(Refusal::NotSealed.err("That is not a sealed Daimond message."));
	}
	let n = bytes[HEAD_FIXED - 1] as usize;
	let end = HEAD_FIXED + n * SLOT_LEN;
	if n == 0 || bytes.len() < end + IV_LEN + TAG_LEN {
		return Err(Refusal::Short.err("That message is too short to be one."));
	}
	Ok(end)
}

/// Open with the agreement already made: `shared` = X25519(own secret, epk) and `own_pub` the
/// public half of that secret.  This is the tab's open; the secret never leaves identity.js.
pub fn open_shared(bytes: &[u8], shared: &[u8], own_pub: &[u8]) -> Outcome<Opened> {
	let end = res!(head_end(bytes));
	if shared.len() != KEY_LEN || own_pub.len() != KEY_LEN {
		return Err(err!("An X25519 agreement and a public key are {} bytes each, not {} and {}.",
			KEY_LEN, shared.len(), own_pub.len(); Invalid, Input, Key));
	}
	let epk = &bytes[4..4 + KEY_LEN];
	let aad = slot_aad(epk);
	let k = res!(slot_key(shared, epk, own_pub));
	let n = bytes[HEAD_FIXED - 1] as usize;
	let mut ck: Option<Zeroizing<[u8; KEY_LEN]>> = None;
	for i in 0..n {
		let at = HEAD_FIXED + i * SLOT_LEN;
		// A slot that does not open is somebody else's, not an error.
		if let Ok(got) = EncryptionScheme::aes_256_gcm_open(
			&k[..], &bytes[at..at + IV_LEN], &aad, &bytes[at + IV_LEN..at + SLOT_LEN])
		{
			let got = Zeroizing::new(got);
			if got.len() == KEY_LEN {
				let mut c = Zeroizing::new([0u8; KEY_LEN]);
				c.copy_from_slice(&got[..]);
				ck = Some(c);
				break;
			}
		}
	}
	let ck = match ck {
		Some(c)	=> c,
		None	=> return Err(Refusal::NotForYou.err(
			"This message was not sealed to any key this device holds.")),
	};
	let plain = res!(body(bytes, end, &ck[..]));
	Ok(Opened { plain, ck })
}

/// Open a `DPS1` record's body with its content key `ck`, the key a recipient hands over when it
/// reports a message (the operator console checks a report this way, through the wasm).  The head
/// is the body's associated data, so a slot lifted from another record does not open this one.
pub fn open_body(bytes: &[u8], ck: &[u8]) -> Outcome<Vec<u8>> {
	let end = res!(head_end(bytes));
	if ck.len() != KEY_LEN {
		return Err(Refusal::BadKey.err("A message's key is 32 bytes."));
	}
	body(bytes, end, ck)
}

/// The body under `ck`, the head (`bytes[..end]`) its associated data.  Both opens come here.
fn body(bytes: &[u8], end: usize, ck: &[u8]) -> Outcome<Vec<u8>> {
	match EncryptionScheme::aes_256_gcm_open(
		ck, &bytes[end..end + IV_LEN], &bytes[..end], &bytes[end + IV_LEN..])
	{
		Ok(p)	=> Ok(p),
		Err(e)	=> Err(err!(e,
			"seal:damaged: The message's body did not open: it was changed, or put together \
			from two."; Invalid, Input)),
	}
}

/// Open with the sealing secret itself (the native runner, which holds it).
pub fn open(bytes: &[u8], sk: &[u8]) -> Outcome<Opened> {
	let epk = res!(epk(bytes));
	let own_pub = res!(AgreementScheme::x25519_public_of(sk));
	let shared = Zeroizing::new(match AgreementScheme::x25519_agree(sk, &epk) {
		Ok(s)	=> s,
		Err(e)	=> return Err(err!(e,
			"seal:not_for_you: This message was not sealed to any key this device holds.";
			Invalid, Input)),
	});
	open_shared(bytes, &shared[..], &own_pub)
}

#[cfg(test)]
#[path = "../../tests/unit/seal/post/open_body_tests.rs"]
mod open_body_tests;
