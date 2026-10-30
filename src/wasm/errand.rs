//! The errand codec's tab surface (P2.2): the envelopes, the `end` body, the chat log's row and
//! [`TurnView`], in the wasm, so the tab and the runner share one codec.  The account key stays
//! where identity.js holds it, as in [`seal`](super::seal): the wasm answers the bytes to sign or
//! seal, and the page hands back the one WebCrypto result.
//!
//! | Step | Wasm | identity.js |
//! |------|------|-------------|
//! | sign an envelope | [`errand_digest`] then [`errand_make`] | `sign(digest)` |
//! | open an envelope | [`errand_open`] | `unwrapBytesAad` first |
//! | seal a row | [`row_seal`] then [`row_wire`] | `wrapBytesAad(plain, row_aad())` |
//! | open a row | [`row_sealed`] then [`row_open`] | `unwrapBytesAad` between |
//!
//! Everything crosses as JSON text.  A refusal of an envelope is an answer, `{"refused":code}`
//! (`sig:v1-refused` for a scheme-1 signature), never an exception; a malformed input rejects.

use crate::errand::{
    codec::{
        self,
        Envelope,
        Opened,
    },
    json::Js,
    row::{
        self,
        Body,
        Change,
        End,
        Header,
        Row,
        TurnView,
        Writer,
    },
};

use oxedyne_fe2o3_core::prelude::*;

use wasm_bindgen::prelude::*;

fn to_js_err(e: Error<ErrTag>) -> JsValue {
	js_sys::Error::new(&fmt!("{}", e)).into()
}

fn parse(txt: &str) -> Result<Js, JsValue> {
	Js::parse(txt).map_err(to_js_err)
}

fn key32(author: &[u8]) -> Result<[u8; 32], JsValue> {
	if author.len() != 32 {
		return Err(to_js_err(err!("An account key is 32 bytes, not {}.", author.len(); Invalid, Input)));
	}
	let mut k = [0u8; 32];
	k.copy_from_slice(author);
	Ok(k)
}

/// The 32 bytes the account key signs for `env_json` (`sigv:2`).
#[wasm_bindgen]
pub fn errand_digest(env_json: &str) -> Result<Vec<u8>, JsValue> {
	let base = codec::to_sign(&parse(env_json)?).map_err(to_js_err)?;
	Ok(codec::signed_bytes(&base))
}

/// The signed envelope's text, to seal under the account key with `seal_peer_aad`: `env_json`
/// with `sigv:2`, `author` (the account's public key) and `sig` (its signature of
/// [`errand_digest`]).
#[wasm_bindgen]
pub fn errand_make(env_json: &str, author: &[u8], sig: &[u8]) -> Result<String, JsValue> {
	let base = codec::to_sign(&parse(env_json)?).map_err(to_js_err)?;
	let signed = codec::signed_with(&base, &key32(author)?, sig).map_err(to_js_err)?;
	Ok(signed.stringify())
}

/// An envelope's unwrapped plaintext, opened and checked against the account's public key:
/// `{"t":..,"env":{..}}` or `{"refused":code}`.
#[wasm_bindgen]
pub fn errand_open(plain: &[u8], author: &[u8]) -> Result<String, JsValue> {
	let out = match codec::open_plain(plain, &key32(author)?) {
		Opened::Envelope(Envelope::Errand(e))	=> Js::Obj(vec![
			("t".into(),	Js::str(codec::T_ERRAND)),
			("env".into(),	e.to_js()),
		]),
		Opened::Envelope(Envelope::Report(r))	=> Js::Obj(vec![
			("t".into(),	Js::str(codec::T_REPORT)),
			("env".into(),	r.to_js()),
		]),
		Opened::Envelope(Envelope::Other(o))	=> Js::Obj(vec![
			("t".into(),	Js::str(o.get_str("t").unwrap_or(""))),
			("env".into(),	o),
		]),
		Opened::Refused(why)					=> Js::Obj(vec![
			("refused".into(), Js::str(why.code())),
		]),
	};
	Ok(out.stringify())
}

/// An `end` body, checked and written in its one form: `status` one of done, stopped,
/// interrupted or not_run.
#[wasm_bindgen]
pub fn end_make(end_json: &str) -> Result<String, JsValue> {
	Ok(End::of_js(&parse(end_json)?).map_err(to_js_err)?.to_js().stringify())
}

/// An opened `end` body, read as [`end_make`] writes it.
#[wasm_bindgen]
pub fn end_open(body_json: &str) -> Result<String, JsValue> {
	end_make(body_json)
}

/// The purpose a row body is sealed to.
#[wasm_bindgen]
pub fn row_aad() -> String {
	String::from_utf8_lossy(row::ROW_AAD).into_owned()
}

/// A row body's plaintext, checked against the header's kind (every kind but `end` names its
/// `mid`), to seal under the space key with [`row_aad`].
#[wasm_bindgen]
pub fn row_seal(head_json: &str, body_json: &str) -> Result<Vec<u8>, JsValue> {
	let head = Header::of_js(&parse(head_json)?).map_err(to_js_err)?;
	let kind = head.kind().ok_or_else(|| to_js_err(err!("Unknown row kind '{}'.", head.kind; Invalid, Input)))?;
	let body = Body::of_js(kind, &parse(body_json)?).map_err(to_js_err)?;
	row::body_plain(&head, &body).map_err(to_js_err)
}

/// The wire row to append: the header with `len` set and the sealed body.
#[wasm_bindgen]
pub fn row_wire(head_json: &str, sealed: &[u8]) -> Result<String, JsValue> {
	let head = Header::of_js(&parse(head_json)?).map_err(to_js_err)?;
	Ok(row::wire(&head, sealed).stringify())
}

/// A wire row's sealed body, for identity.js to unwrap.
#[wasm_bindgen]
pub fn row_sealed(wire_json: &str) -> Result<Vec<u8>, JsValue> {
	row::unwire(&parse(wire_json)?).map(|(_, b)| b).map_err(to_js_err)
}

/// A wire row and its unwrapped body, opened: `{head, body}`.
#[wasm_bindgen]
pub fn row_open(wire_json: &str, plain: &[u8]) -> Result<String, JsValue> {
	let (head, _) = row::unwire(&parse(wire_json)?).map_err(to_js_err)?;
	Ok(row::open_row_plain(head, plain).map_err(to_js_err)?.to_js().stringify())
}

/// Fold one opened row (`{head, body}`) into a turn's view: `view_json` is the last answer's
/// `view`, or `{"turn":id}` for a new one.  Answers `{view, applied}`.
#[wasm_bindgen]
pub fn turnview_apply(view_json: &str, row_json: &str) -> Result<String, JsValue> {
	let mut view = TurnView::of_js(&parse(view_json)?).map_err(to_js_err)?;
	let r = Row::of_js(&parse(row_json)?).map_err(to_js_err)?;
	let applied = view.apply(&r);
	Ok(Js::Obj(vec![
		("view".into(),		view.to_js()),
		("applied".into(),	Js::str(applied.code())),
	]).stringify())
}

/// A turn's log changes since the writer last looked: `writer_json` is the last answer's
/// `writer` (`{}` for a new turn) and `msgs_json` the turn's messages as the chat holds them.
/// With `end_json` not empty, the turn's one `end` follows them.  Answers `{writer, changes}`.
#[wasm_bindgen]
pub fn log_diff(writer_json: &str, msgs_json: &str, end_json: &str) -> Result<String, JsValue> {
	let mut w = Writer::of_js(&parse(writer_json)?).map_err(to_js_err)?;
	let msgs: Vec<Body> = match parse(msgs_json)? {
		Js::Arr(v)	=> v.iter().map(row::row_body).collect(),
		_			=> return Err(to_js_err(err!("A turn's messages are a list."; Invalid, Input))),
	};
	let mut changes = w.diff(&msgs).map_err(to_js_err)?;
	if !end_json.is_empty() {
		changes.push(w.end(End::of_js(&parse(end_json)?).map_err(to_js_err)?).map_err(to_js_err)?);
	}
	Ok(Js::Obj(vec![
		("writer".into(),	w.to_js()),
		("changes".into(),	Js::Arr(changes.iter().map(Change::to_js).collect())),
	]).stringify())
}

/// The rows of one change, numbered from `n`, each body's plaintext within `plain_max` bytes:
/// `[{head, body}]`, each to seal with [`row_seal`].
#[wasm_bindgen]
pub fn log_rows(turn: &str, daimon: &str, n: f64, change_json: &str, plain_max: f64)
	-> Result<String, JsValue>
{
	let c = Change::of_js(&parse(change_json)?).map_err(to_js_err)?;
	let rows = row::change_rows(turn, daimon, n as i64, &c, plain_max as usize).map_err(to_js_err)?;
	Ok(Js::Arr(rows.iter().map(|(h, b)| Js::Obj(vec![
		("head".into(),	h.to_js()),
		("body".into(),	b.to_js()),
	])).collect()).stringify())
}
