//! The seal's tab surface: the [`seal`](crate::seal) records, framed and opened in the wasm, with
//! the page's long-lived keys left where identity.js holds them.
//!
//! - [`seal_post`] seals a `DPS1` message whole: it needs only the recipients' PUBLIC keys, and
//!   the ephemeral secret and body key live for the one call.
//! - [`seal_post_epk`] checks a `DPS1` header and answers the ephemeral key, which identity.js
//!   agrees with under its non-extractable sealing key; [`seal_post_open`] takes those 32 bytes
//!   and opens the record.
//! - [`seal_scheme`], [`seal_peer_frame`] and [`seal_peer_aad`] are the peer envelope's codec; the
//!   one AES-GCM under the account key stays identity.js's `wrapBytesAad`.
//!
//! A refusal a person sees rejects with a JS `Error` whose `refusal` is the code (`seal:<code>:`
//! in its message), which the page's bridge (`window.DaimondSeal`, daimond.js) carries to post.js
//! as a typed, final refusal and the translated sentence; any other error is a passing failure.

use crate::seal::{peer, post, Refusal, KEY_LEN};

use oxedyne_fe2o3_core::prelude::*;

use wasm_bindgen::prelude::*;

/// An error as a JS `Error`, TYPED: a seal refusal carries `refusal` = its code (`short`,
/// `not_sealed`, `not_for_you`, `damaged`, `bad_key`, ...), which is how the page tells a record
/// that will never open from a failure that may pass, without reading the sentence.  Anything
/// else (a caller's bad input, an engine fault) carries none, and the page treats it as passing.
fn to_js_err(e: Error<ErrTag>) -> JsValue {
	let msg = fmt!("{}", e);
	let out = js_sys::Error::new(&msg);
	if let Some(code) = Refusal::of_message(&msg) {
		let _ = js_sys::Reflect::set(&out, &JsValue::from_str("refusal"), &JsValue::from_str(code));
	}
	out.into()
}

/// Seal `plain` to the recipients' X25519 public keys, given end to end (32 bytes each).
#[wasm_bindgen]
pub fn seal_post(recipients: &[u8], plain: &[u8]) -> Result<Vec<u8>, JsValue> {
	if recipients.len() % KEY_LEN != 0 {
		return Err(to_js_err(err!(
			"seal:bad_key: One of the recipients has no usable key, so nothing was sent.";
			Invalid, Input, Key)));
	}
	let mut keys = Vec::with_capacity(recipients.len() / KEY_LEN);
	for k in recipients.chunks(KEY_LEN) {
		let mut a = [0u8; KEY_LEN];
		a.copy_from_slice(k);
		keys.push(a);
	}
	post::seal(&keys, plain).map_err(to_js_err)
}

/// The ephemeral public key of a `DPS1` record, its header checked.
#[wasm_bindgen]
pub fn seal_post_epk(bytes: &[u8]) -> Result<Vec<u8>, JsValue> {
	post::epk(bytes).map(|k| k.to_vec()).map_err(to_js_err)
}

/// Open a `DPS1` record with the agreement made: `shared` = X25519(own secret, epk), `own_pub`
/// that secret's public half.  Answers `ck(32) ‖ plain`, the body key first so the split needs
/// no length.
#[wasm_bindgen]
pub fn seal_post_open(bytes: &[u8], shared: &[u8], own_pub: &[u8]) -> Result<Vec<u8>, JsValue> {
	let o = match post::open_shared(bytes, shared, own_pub) {
		Ok(o)	=> o,
		Err(e)	=> return Err(to_js_err(e)),
	};
	let mut out = Vec::with_capacity(KEY_LEN + o.plain.len());
	out.extend_from_slice(&o.ck[..]);
	out.extend_from_slice(&o.plain);
	Ok(out)
}

/// The scheme a peer body's tag names: `"DPY2"`, `"DPY1"`, `"DPS1"`, or `""` for none.
#[wasm_bindgen]
pub fn seal_scheme(bytes: &[u8]) -> String {
	match peer::scheme_of(bytes) {
		Some(s)	=> s.name().to_string(),
		None	=> String::new(),
	}
}

/// `DPY2 ‖ body`, for a body identity.js sealed under the account key with [`seal_peer_aad`].
#[wasm_bindgen]
pub fn seal_peer_frame(body: &[u8]) -> Vec<u8> {
	peer::frame(body)
}

/// The purpose a `DPY2` body is bound to.
#[wasm_bindgen]
pub fn seal_peer_aad() -> String {
	String::from_utf8_lossy(peer::AAD).into_owned()
}
