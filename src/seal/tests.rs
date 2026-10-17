//! The seal against the JavaScript that wrote these records before it moved here.
//!
//! `testdata/js_vectors.json` was captured from the a2bd55bf identity.js/post.js/peer.js under
//! Node's WebCrypto (`dev/seal_compat.mjs capture`).  Every record must open here, a record not
//! sealed to a key must be refused by it, and the convergent chunk nonce must come out byte for
//! byte.  The test then seals one record of each kind and writes `testdata/rust_vectors.json`,
//! which `dev/seal_compat.mjs check` opens in the OLD JavaScript; and it opens
//! `testdata/wasm_vectors.json` (sealed in the tab over the wasm) when that check has written it.

use crate::seal::{hex, peer, post, unhex, wrap, KEY_LEN};

use oxedyne_fe2o3_core::prelude::*;
use oxedyne_fe2o3_crypto::agree::AgreementScheme;
use oxedyne_fe2o3_jdat::prelude::*;
use oxedyne_fe2o3_jdat::string::dec::DecoderConfig;
use oxedyne_fe2o3_text::base64;

use std::path::PathBuf;

fn testdata(name: &str) -> PathBuf {
	PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src").join("seal").join("testdata").join(name)
}

fn load(name: &str) -> Outcome<Option<DaticleMap>> {
	let p = testdata(name);
	if !p.exists() {
		return Ok(None);
	}
	let s = res!(std::fs::read_to_string(&p));
	Ok(Some(res!(parse(&s, name))))
}

fn parse(s: &str, name: &str) -> Outcome<DaticleMap> {
	let cfg = DecoderConfig::<(), ()>::json(None);
	match res!(Dat::decode_string_with_config(s, &cfg)) {
		Dat::Map(m)	=> Ok(m),
		_			=> Err(err!("{} is not a JSON object.", name; Invalid, Input)),
	}
}

fn get_str<'a>(m: &'a DaticleMap, k: &str) -> Option<&'a str> {
	match m.get(&dat!(k)) {
		Some(Dat::Str(s))	=> Some(s.as_str()),
		_					=> None,
	}
}

fn need_str<'a>(m: &'a DaticleMap, k: &str) -> Outcome<&'a str> {
	match get_str(m, k) {
		Some(s)	=> Ok(s),
		None	=> Err(err!("The record has no string {:?}.", k; Invalid, Input, Missing)),
	}
}

fn get_map<'a>(m: &'a DaticleMap, k: &str) -> Outcome<&'a DaticleMap> {
	match m.get(&dat!(k)) {
		Some(Dat::Map(v))	=> Ok(v),
		_					=> Err(err!("No object {:?}.", k; Invalid, Input, Missing)),
	}
}

fn get_list<'a>(m: &'a DaticleMap, k: &str) -> Outcome<&'a Vec<Dat>> {
	match m.get(&dat!(k)) {
		Some(Dat::List(v))	=> Ok(v),
		_					=> Err(err!("No list {:?}.", k; Invalid, Input, Missing)),
	}
}

/// The account and the other keys every vector file is sealed under (js_vectors.json's).
struct Keys {
	key:		Vec<u8>,
	seal_sk:	Vec<u8>,
	seal_pub:	Vec<u8>,
	others:		Vec<(Vec<u8>, Vec<u8>)>,
}

fn keys(doc: &DaticleMap) -> Outcome<Keys> {
	let id = res!(get_map(doc, "identity"));
	let mut others = Vec::new();
	for k in res!(get_list(doc, "keys")) {
		if let Dat::Map(k) = k {
			others.push((res!(unhex(res!(need_str(k, "sk")))), res!(unhex(res!(need_str(k, "pub"))))));
		}
	}
	Ok(Keys {
		key:		res!(unhex(res!(need_str(id, "key")))),
		seal_sk:	res!(unhex(res!(need_str(id, "seal_sk")))),
		seal_pub:	res!(unhex(res!(need_str(id, "seal_pub")))),
		others,
	})
}

/// Open one record every way this side can, and count the opens and refusals checked.
fn open_record(k: &Keys, r: &DaticleMap) -> Outcome<(usize, usize)> {
	let kind = res!(need_str(r, "kind"));
	let name = res!(need_str(r, "name"));
	let plain = res!(base64::decode(res!(need_str(r, "plain"))));
	let sealed = res!(base64::decode(res!(need_str(r, "sealed"))));
	let (mut opened, mut refused) = (0, 0);
	match kind {
		"dps1" => {
			let mut to = Vec::new();
			for t in res!(get_list(r, "to")) {
				if let Dat::Str(s) = t { to.push(s.to_lowercase()); }
			}
			let mut sks = vec![k.seal_sk.clone()];
			for (sk, _) in &k.others { sks.push(sk.clone()); }
			for sk in &sks {
				let pk = hex(&res!(AgreementScheme::x25519_public_of(sk)));
				match post::open(&sealed, sk) {
					Ok(o) if to.contains(&pk) => {
						if o.plain != plain {
							return Err(err!("{}: opened to the wrong plaintext.", name; Invalid));
						}
						opened += 1;
					}
					Ok(_) => return Err(err!("{}: opened for a key it was not sealed to.", name; Invalid)),
					Err(e) if !to.contains(&pk) => {
						if !fmt!("{}", e).contains("seal:not_for_you:") {
							return Err(err!("{}: refused for the wrong reason: {}", name, e; Invalid));
						}
						refused += 1;
					}
					Err(e) => return Err(err!(e, "{}: did not open for a recipient.", name; Invalid)),
				}
			}
			// A flipped byte in the body stops it opening for its own recipient.
			let mut bad = sealed.clone();
			let last = bad.len() - 1;
			bad[last] ^= 1;
			for sk in &sks {
				let pk = hex(&res!(AgreementScheme::x25519_public_of(sk)));
				if to.contains(&pk) {
					if post::open(&bad, sk).is_ok() {
						return Err(err!("{}: opened with a flipped body byte.", name; Invalid));
					}
					refused += 1;
					break;
				}
			}
		}
		"wrap" | "chunk" => {
			let aad = get_str(r, "aad").map(|a| a.as_bytes());
			if res!(wrap::open(&k.key, &sealed, aad)) != plain {
				return Err(err!("{}: opened to the wrong plaintext.", name; Invalid));
			}
			opened += 1;
			if let Some(b) = get_str(r, "b64form") {
				if res!(wrap::open(&k.key, &res!(base64::decode(b)), aad)) != plain {
					return Err(err!("{}: its base64 form opened to the wrong plaintext.", name; Invalid));
				}
				opened += 1;
			}
			if kind == "chunk" {
				let ck = res!(wrap::chunk_key(&k.key));
				if res!(wrap::seal_chunk(&k.key, &ck[..], &plain)) != sealed {
					return Err(err!("{}: the convergent seal is not byte for byte the JS one.", name; Invalid));
				}
				opened += 1;
			}
			let wrong = [7u8; KEY_LEN];
			if wrap::open(&wrong, &sealed, aad).is_ok() {
				return Err(err!("{}: opened under a wrong key.", name; Invalid));
			}
			refused += 1;
		}
		"dpy2" | "dpy1" => {
			let want = if kind == "dpy2" { peer::Scheme::Dpy2 } else { peer::Scheme::Dpy1 };
			if peer::scheme_of(&sealed) != Some(want) {
				return Err(err!("{}: routed to the wrong scheme.", name; Invalid));
			}
			if res!(peer::open(&k.key, &sealed, Some(&k.seal_sk))) != plain {
				return Err(err!("{}: opened to the wrong plaintext.", name; Invalid));
			}
			opened += 1;
			// The AAD is bound: a DPY2 body retagged DPY1 (or the reverse) does not open.
			let mut swapped = sealed.clone();
			swapped[3] = if kind == "dpy2" { b'1' } else { b'2' };
			if peer::open(&k.key, &swapped, None).is_ok() {
				return Err(err!("{}: opened under the other scheme's tag.", name; Invalid));
			}
			refused += 1;
		}
		other => return Err(err!("Unknown record kind {:?}.", other; Invalid, Input)),
	}
	Ok((opened, refused))
}

fn open_file(name: &str, k: &Keys) -> Outcome<Option<(usize, usize, usize)>> {
	match res!(load(name)) {
		Some(d)	=> Ok(Some(res!(open_doc(&d, k)))),
		None	=> Ok(None),
	}
}

fn open_doc(doc: &DaticleMap, k: &Keys) -> Outcome<(usize, usize, usize)> {
	let (mut n, mut o, mut f) = (0, 0, 0);
	for r in res!(get_list(doc, "records")) {
		if let Dat::Map(r) = r {
			let (a, b) = res!(open_record(k, r));
			n += 1; o += a; f += b;
		}
	}
	Ok((n, o, f))
}

fn js_keys() -> Outcome<Keys> {
	match res!(load("js_vectors.json")) {
		Some(d)	=> keys(&d),
		None	=> Err(err!("testdata/js_vectors.json is missing."; Missing, File)),
	}
}

#[test]
fn seal_opens_every_js_vector() -> Outcome<()> {
	let k = res!(js_keys());
	match res!(open_file("js_vectors.json", &k)) {
		Some((n, o, f)) => {
			println!("seal: {} JS records, {} opens and {} refusals checked", n, o, f);
			assert_eq!(n, 13);
		}
		None => return Err(err!("no js_vectors.json"; Missing)),
	}
	Ok(())
}

#[test]
fn seal_opens_every_wasm_vector() -> Outcome<()> {
	let k = res!(js_keys());
	match res!(open_file("wasm_vectors.json", &k)) {
		Some((n, o, f))	=> println!("seal: {} wasm records, {} opens and {} refusals checked", n, o, f),
		None			=> println!("seal: no wasm_vectors.json yet (dev/seal_compat.mjs check writes it)"),
	}
	Ok(())
}

fn jstr(s: &str) -> String {
	fmt!("\"{}\"", s)
}

fn rec(kind: &str, name: &str, to: Option<&[&[u8]]>, aad: Option<&str>, plain: &[u8], sealed: &[u8],
	extra: &str) -> String
{
	let mut s = fmt!("  {{\"kind\": {}, \"name\": {}", jstr(kind), jstr(name));
	if let Some(to) = to {
		let list: Vec<String> = to.iter().map(|t| jstr(&hex(t))).collect();
		s.push_str(&fmt!(", \"to\": [{}]", list.join(", ")));
	}
	if kind == "wrap" || kind == "chunk" {
		s.push_str(&fmt!(", \"aad\": {}", match aad { Some(a) => jstr(a), None => "null".to_string() }));
	}
	s.push_str(&fmt!(", \"plain\": {}, \"sealed\": {}{}}}", jstr(&base64::encode(plain)),
		jstr(&base64::encode(sealed)), extra));
	s
}

/// Seal one record of each kind natively, open every one here, and write them for the old JS.
#[test]
fn seal_writes_rust_vectors() -> Outcome<()> {
	let k = res!(js_keys());
	let js = match res!(load("js_vectors.json")) { Some(d) => d, None => return Err(err!("no js_vectors"; Missing)) };
	let mut dpy_plain = Vec::new();
	for r in res!(get_list(&js, "records")) {
		if let Dat::Map(r) = r {
			if get_str(r, "kind") == Some("dpy2") {
				dpy_plain = res!(base64::decode(res!(need_str(r, "plain"))));
			}
		}
	}
	if dpy_plain.is_empty() {
		return Err(err!("js_vectors.json has no dpy2 record."; Missing));
	}
	let arr = |v: &[u8]| -> Outcome<[u8; KEY_LEN]> { Ok(res!(<[u8; KEY_LEN]>::try_from(v))) };
	let own = res!(arr(&k.seal_pub));
	let o0 = res!(arr(&k.others[0].1));
	let o1 = res!(arr(&k.others[1].1));
	let mut bin = vec![0u8; 3000];
	crate::seal::os_random(&mut bin);
	let mut big = vec![0u8; 70000];
	crate::seal::os_random(&mut big);
	let short = b"hello, sealed by rust".to_vec();
	let uni = "ünïcödé ✓ 🜂 rust".as_bytes().to_vec();
	let ck = res!(wrap::chunk_key(&k.key));
	let mut recs = Vec::new();
	recs.push(rec("dps1", "rs-dps1-own-short", Some(&[&own]), None, &short, &res!(post::seal(&[own], &short)), ""));
	recs.push(rec("dps1", "rs-dps1-three-binary", Some(&[&o0, &own, &o1]), None, &bin,
		&res!(post::seal(&[o0, own, o1], &bin)), ""));
	recs.push(rec("dps1", "rs-dps1-other-empty", Some(&[&o0]), None, &[], &res!(post::seal(&[o0], &[])), ""));
	recs.push(rec("dps1", "rs-dps1-two-unicode", Some(&[&o1, &own]), None, &uni, &res!(post::seal(&[o1, own], &uni)), ""));
	recs.push(rec("dps1", "rs-dps1-own-large", Some(&[&own]), None, &big, &res!(post::seal(&[own], &big)), ""));
	recs.push(rec("wrap", "rs-wrap-bytes", None, None, &bin[..1000], &res!(wrap::seal(&k.key, &bin[..1000], None)), ""));
	let p2 = br#"{"parcel":true,"n":2}"#;
	recs.push(rec("wrap", "rs-wrap-bytes-aad", None, Some("daimond/parcel/1"), p2,
		&res!(wrap::seal(&k.key, p2, Some(b"daimond/parcel/1"))), ""));
	let p3 = b"sk-byok-key-rust-9876543210";
	let s3 = res!(wrap::seal(&k.key, p3, None));
	recs.push(rec("wrap", "rs-wrap-string-b64", None, None, p3, &s3, &fmt!(", \"b64form\": {}", jstr(&base64::encode(&s3)))));
	recs.push(rec("chunk", "rs-wrap-chunk", None, None, &big[..5000], &res!(wrap::seal_chunk(&k.key, &ck[..], &big[..5000])), ""));
	recs.push(rec("chunk", "rs-wrap-chunk-empty", None, None, &[], &res!(wrap::seal_chunk(&k.key, &ck[..], &[])), ""));
	recs.push(rec("dpy2", "rs-dpy2-errand", None, None, &dpy_plain, &res!(peer::seal(&k.key, &dpy_plain)), ""));
	let mut legacy = peer::DPY1.to_vec();
	legacy.extend_from_slice(&res!(wrap::seal(&k.key, &dpy_plain, None)));
	recs.push(rec("dpy1", "rs-dpy1-errand", None, None, &dpy_plain, &legacy, ""));
	recs.push(rec("dps1", "rs-dps1-errand", Some(&[&own]), None, &dpy_plain, &res!(post::seal(&[own], &dpy_plain)), ""));
	let doc = fmt!("{{\"about\": \"Sealed by the native Rust seal (cargo test --lib seal); \
		dev/seal_compat.mjs check opens them in the old JavaScript.\",\n \"records\": [\n{}\n ]\n}}\n",
		recs.join(",\n"));
	// The committed file is the fixture the old JS opens; it is rewritten only when absent or
	// asked for (SEAL_WRITE_VECTORS=1), so an ordinary run leaves the tree clean. Every run seals
	// fresh records and reopens them here, and reopens the committed ones.
	let path = testdata("rust_vectors.json");
	if !path.exists() || std::env::var("SEAL_WRITE_VECTORS").map(|v| v == "1").unwrap_or(false) {
		res!(std::fs::write(&path, &doc));
		println!("seal: wrote {}", path.display());
	}
	let (n, o, f) = res!(open_doc(&res!(parse(&doc, "fresh rust records")), &k));
	println!("seal: sealed and reopened {} fresh rust records, {} opens and {} refusals checked", n, o, f);
	assert_eq!(n, 13);
	match res!(open_file("rust_vectors.json", &k)) {
		Some((n, o, f)) => {
			println!("seal: reopened {} committed rust records, {} opens and {} refusals", n, o, f);
			assert_eq!(n, 13);
		}
		None => return Err(err!("rust_vectors.json was not written"; Missing)),
	}
	Ok(())
}

#[test]
fn seal_refusals_carry_their_codes() -> Outcome<()> {
	use crate::seal::Refusal;
	let code = |r: Outcome<post::Opened>| -> Option<&'static str> {
		match r { Ok(_) => None, Err(e) => Refusal::of_message(&fmt!("{}", e)) }
	};
	assert_eq!(code(post::open(&[0u8; 10], &[1u8; 32])), Some("short"));
	assert_eq!(code(post::open(&[0u8; 200], &[1u8; 32])), Some("not_sealed"));
	match post::seal(&[], b"x") {
		Ok(_)	=> return Err(err!("sealed to nobody"; Invalid)),
		Err(e)	=> assert_eq!(Refusal::of_message(&fmt!("{}", e)), Some("no_recipient")),
	}
	let many = vec![[9u8; KEY_LEN]; 256];
	match post::seal(&many, b"x") {
		Ok(_)	=> return Err(err!("sealed to 256"; Invalid)),
		Err(e)	=> assert_eq!(Refusal::of_message(&fmt!("{}", e)), Some("too_many")),
	}
	match post::seal(&[[0u8; KEY_LEN]], b"x") {
		Ok(_)	=> return Err(err!("sealed to a small-order key"; Invalid)),
		Err(e)	=> assert_eq!(Refusal::of_message(&fmt!("{}", e)), Some("bad_key")),
	}
	Ok(())
}
