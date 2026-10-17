//! The account wrap: `iv(12) ‖ AES-256-GCM(key, plain) ‖ tag(16)`, with no AAD or a UTF-8 purpose
//! as AAD, exactly as identity.js's `wrapBytes`/`wrapBytesAad` write it (the string form is the
//! padded standard base64 of the same bytes).  The key is PBKDF2 of the passphrase; in the tab it
//! is a non-extractable WebCrypto key and identity.js keeps doing the one AES-GCM with it.
//!
//! The convergent chunk form (`wrapChunk`) differs only in its nonce, which is derived from the
//! plaintext so equal chunks of one account land at one address: the first 12 bytes of
//! HMAC-SHA256 under the chunk key of `"daimond chunk-iv v1\0" ‖ SHA-256(plain)`, the chunk key
//! being HKDF-SHA256 of the wrap key's bits (salt 32 zero bytes).

use crate::seal::{IV_LEN, KEY_LEN, TAG_LEN};

use oxedyne_fe2o3_core::prelude::*;
use oxedyne_fe2o3_crypto::{
	enc::EncryptionScheme,
	mac::{hkdf_sha256, hmac_sha256_parts},
};
use oxedyne_fe2o3_hash::sha256;

use zeroize::Zeroizing;

/// HKDF info for the chunk key.
pub const CHUNK_KEY_INFO: &[u8] = b"daimond chunk-iv key v1";
/// HMAC prefix for a chunk nonce.
pub const CHUNK_IV_LABEL: &[u8] = b"daimond chunk-iv v1\0";

/// Seal under a fresh random nonce.
pub fn seal(key: &[u8], plain: &[u8], aad: Option<&[u8]>) -> Outcome<Vec<u8>> {
	seal_with_iv(key, &EncryptionScheme::aes_256_gcm_nonce(), plain, aad)
}

/// Seal under the nonce given, which must never repeat under one key for different plaintexts.
pub fn seal_with_iv(key: &[u8], iv: &[u8; IV_LEN], plain: &[u8], aad: Option<&[u8]>)
	-> Outcome<Vec<u8>>
{
	let ct = res!(EncryptionScheme::aes_256_gcm_seal(key, iv, aad.unwrap_or(&[]), plain));
	let mut out = Vec::with_capacity(IV_LEN + ct.len());
	out.extend_from_slice(iv);
	out.extend_from_slice(&ct);
	Ok(out)
}

/// Open what [`seal`] (or [`seal_chunk`]) wrote, under the same AAD.
pub fn open(key: &[u8], bytes: &[u8], aad: Option<&[u8]>) -> Outcome<Vec<u8>> {
	if bytes.len() < IV_LEN + TAG_LEN {
		return Err(err!("A wrapped item of {} bytes is shorter than its nonce and tag.",
			bytes.len(); Invalid, Input, Decrypt));
	}
	EncryptionScheme::aes_256_gcm_open(key, &bytes[..IV_LEN], aad.unwrap_or(&[]), &bytes[IV_LEN..])
}

/// The chunk HMAC key, from the wrap key's raw bits.
pub fn chunk_key(bits: &[u8]) -> Outcome<Zeroizing<[u8; KEY_LEN]>> {
	let mut k = Zeroizing::new([0u8; KEY_LEN]);
	res!(hkdf_sha256(bits, &[0u8; KEY_LEN], CHUNK_KEY_INFO, &mut k[..]));
	Ok(k)
}

/// A chunk's nonce, from the chunk key and its plaintext.
pub fn chunk_iv(chunk_key: &[u8], plain: &[u8]) -> [u8; IV_LEN] {
	let ph = sha256::digest(plain);
	let mac = hmac_sha256_parts(chunk_key, &[CHUNK_IV_LABEL, &ph]);
	let mut iv = [0u8; IV_LEN];
	iv.copy_from_slice(&mac[..IV_LEN]);
	iv
}

/// Seal one chunk convergently: the same plaintext gives the same bytes on every device of the
/// account.  [`open`] opens it.
pub fn seal_chunk(key: &[u8], chunk_key: &[u8], plain: &[u8]) -> Outcome<Vec<u8>> {
	seal_with_iv(key, &chunk_iv(chunk_key, plain), plain, None)
}
