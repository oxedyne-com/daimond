//! The browser end of the blind mail tunnel: a TLS client that runs in the page, so the
//! gateway relays ciphertext and holds no keys.
//!
//! Sans-io.  This module never owns a socket.  JavaScript holds the WebSocket to
//! `GET /api/mail/tunnel` and pumps bytes through [`mail_tunnel_feed`] and
//! [`mail_tunnel_take`]; the plaintext side is [`mail_tunnel_write`] and
//! [`mail_tunnel_read`].  The mail password therefore never leaves the browser, and the
//! gateway sees only which host, when, how many bytes and for how long.
//!
//! Four facts here were found by running the spike at `~/usr/code/rust/spike-wasmtls`
//! on 2026-08-17 and none of them is derivable from the rustls documentation:
//!
//! - `std::time::SystemTime::now()` panics on `wasm32-unknown-unknown`, so rustls's
//!   default time provider cannot be used.  The connection is built through
//!   `ClientConfig::builder_with_details` and expiry is checked against `Date.now()`.
//!   That makes the browser's clock the expiry oracle, which the mail feature owes its
//!   users as a disclosure: a machine with its clock set far enough back will accept a
//!   certificate that has expired.
//! - `rustls-pki-types` needs its `web` feature or nothing compiles.  It deliberately
//!   removes `UnixTime::now()` on this target, while rustls calls it unconditionally
//!   under `std` from `ticketer.rs`, `client/handy.rs` and `time_provider.rs` -- call
//!   sites a caller never touches, so supplying a `TimeProvider` does not save you.
//! - ring has no `SecureRandom` for this target unless its `wasm32_unknown_unknown_js`
//!   feature is on, and rustls's `ring` feature does not turn it on.  ring has to be
//!   named as a direct dependency to reach it.
//! - rustls's default feature set reaches `aws-lc-sys`, which is C and does not
//!   cross-compile, so `default-features = false` is load bearing rather than tidy.
//!
//! # Certificate verification cannot be switched off here
//!
//! Verification is the whole security boundary: a client that can be talked into
//! accepting any chain hands the gateway the interception it has been promised it cannot
//! do.  So [`Verify::Off`], the accept-anything verifier and the extra-trust-root hook
//! exist only under the `insecure_testing` feature, which is **off by default**.  In a
//! production build [`mail_tunnel_open`] takes a host, a port and a security mode and
//! cannot express any other choice; the types that could weaken it are not in the
//! shipped wasm at all.  A runtime switch that disables certificate verification,
//! compiled into a shipping bundle, is one mistaken call site away from being the whole
//! vulnerability, so it is not compiled into one.  [`mail_tunnel_flavour`] names the
//! build, so a page cannot silently drive a module that checks less than it believes.

use crate::wasm::to_js_err;

use oxedyne_fe2o3_core::prelude::*;

use std::cell::RefCell;
use std::io::Cursor;
use std::io::ErrorKind;
use std::io::Read;
use std::io::Write as _;
use std::sync::Arc;
use std::time::Duration;

use rustls::pki_types::CertificateDer;
use rustls::pki_types::ServerName;
use rustls::pki_types::UnixTime;
use rustls::time_provider::TimeProvider;
use rustls::ClientConfig;
use rustls::ClientConnection;
use rustls::RootCertStore;
use wasm_bindgen::prelude::*;

#[cfg(feature = "insecure_testing")]
use rustls::client::danger::HandshakeSignatureValid;
#[cfg(feature = "insecure_testing")]
use rustls::client::danger::ServerCertVerified;
#[cfg(feature = "insecure_testing")]
use rustls::client::danger::ServerCertVerifier;
#[cfg(feature = "insecure_testing")]
use rustls::crypto::verify_tls12_signature;
#[cfg(feature = "insecure_testing")]
use rustls::crypto::verify_tls13_signature;
#[cfg(feature = "insecure_testing")]
use rustls::crypto::CryptoProvider;
#[cfg(feature = "insecure_testing")]
use rustls::DigitallySignedStruct;
#[cfg(feature = "insecure_testing")]
use rustls::SignatureScheme;

/// How the peer's certificate chain is to be judged.  Only the first variant survives a
/// production build.
pub enum Verify {
	Roots,				// the bundled Mozilla store, and nothing else
	#[cfg(feature = "insecure_testing")]
	RootsAndTestCa(Vec<u8>),	// the store plus one extra CA, for the local fixtures
	#[cfg(feature = "insecure_testing")]
	Off,				// deliberately disabled, so a refusal can be shown to go red
}

#[cfg(feature = "insecure_testing")]
impl Verify {
	fn parse(s: &str, test_ca: Option<&[u8]>) -> Outcome<Self> {
		match s {
			"roots"		=> Ok(Self::Roots),
			"roots+testca"	=> {
				let der = res!(test_ca.ok_or_else(|| err!(
					"Verification mode roots+testca was asked for with no test CA \
					supplied."; Missing, Input)));
				Ok(Self::RootsAndTestCa(der.to_vec()))
			},
			"off"		=> Ok(Self::Off),
			other		=> Err(err!(
				"Verification mode {:?} is not one of roots, roots+testca, off.",
				other; Invalid, Input)),
		}
	}
}

/// Whether the wire is still in the clear, as it is between a STARTTLS command and the
/// handshake that answers it.
enum Phase {
	Clear,	// bytes pass through untouched; only reachable via `security = "starttls"`
	Tls,	// rustls owns the wire
}

/// The browser's wall clock, standing in for the `std` clock this target lacks.
#[derive(Debug)]
struct BrowserClock;

impl TimeProvider for BrowserClock {
	fn current_time(&self) -> Option<UnixTime> {
		let ms = js_sys::Date::now();
		if !ms.is_finite() || ms < 0.0 {
			return None;
		}
		Some(UnixTime::since_unix_epoch(Duration::from_millis(ms as u64)))
	}
}

/// A verifier that accepts every chain, present only so a test run can watch the
/// refusals turn into acceptances -- four refusals that were never seen to go the other
/// way are equally consistent with a client that cannot connect at all.
#[cfg(feature = "insecure_testing")]
#[derive(Debug)]
struct AcceptAny {
	provider: Arc<CryptoProvider>,
}

#[cfg(feature = "insecure_testing")]
impl ServerCertVerifier for AcceptAny {
	fn verify_server_cert(
		&self,
		_end_entity:	&CertificateDer<'_>,
		_intermediates:	&[CertificateDer<'_>],
		_server_name:	&ServerName<'_>,
		_ocsp:		&[u8],
		_now:		UnixTime,
	)
		-> Result<ServerCertVerified, rustls::Error>
	{
		Ok(ServerCertVerified::assertion())
	}

	fn verify_tls12_signature(
		&self,
		message:	&[u8],
		cert:		&CertificateDer<'_>,
		dss:		&DigitallySignedStruct,
	)
		-> Result<HandshakeSignatureValid, rustls::Error>
	{
		verify_tls12_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
	}

	fn verify_tls13_signature(
		&self,
		message:	&[u8],
		cert:		&CertificateDer<'_>,
		dss:		&DigitallySignedStruct,
	)
		-> Result<HandshakeSignatureValid, rustls::Error>
	{
		verify_tls13_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
	}

	fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
		self.provider.signature_verification_algorithms.supported_schemes()
	}
}

struct Tunnel {
	host:	String,
	port:	u16,
	conn:	ClientConnection,
	phase:	Phase,
	wire:	Vec<u8>,	// bytes waiting to go out to the socket
	plain:	Vec<u8>,	// bytes already readable by the caller
	eof:	bool,		// the peer closed cleanly
	fault:	Option<String>,	// the first protocol failure, kept verbatim
}

thread_local! {
	static TUNNELS: RefCell<Vec<Option<Tunnel>>> = RefCell::new(Vec::new());
}

fn root_store(extra_ca: Option<&[u8]>) -> Outcome<RootCertStore> {
	let mut store = RootCertStore::empty();
	store.roots = webpki_roots::TLS_SERVER_ROOTS.to_vec();

	if let Some(der) = extra_ca {
		let cert = CertificateDer::from(der.to_vec());
		res!(store.add(cert).map_err(|e| err!(
			"The supplied test CA ({} bytes) was rejected by the root store: {:?}",
			der.len(), e; Invalid, Input)));
	}

	Ok(store)
}

fn build_config(mode: &Verify) -> Outcome<ClientConfig> {
	let provider = Arc::new(rustls::crypto::ring::default_provider());
	// `builder_with_details` lands in `WantsVersions`, not `WantsVerifier`: naming a
	// provider means naming the protocol versions too, since the provider's suites
	// might not cover them.
	let builder = res!(ClientConfig::builder_with_details(provider.clone(), Arc::new(BrowserClock))
		.with_safe_default_protocol_versions()
		.map_err(|e| err!("The ring provider does not support the default protocol \
			versions: {:?}", e; Configuration)));

	let cfg = match mode {
		Verify::Roots => {
			let store = res!(root_store(None));
			builder.with_root_certificates(store).with_no_client_auth()
		},
		#[cfg(feature = "insecure_testing")]
		Verify::RootsAndTestCa(der) => {
			let store = res!(root_store(Some(der)));
			builder.with_root_certificates(store).with_no_client_auth()
		},
		#[cfg(feature = "insecure_testing")]
		Verify::Off => builder
			.dangerous()
			.with_custom_certificate_verifier(Arc::new(AcceptAny { provider }))
			.with_no_client_auth(),
	};

	Ok(cfg)
}

fn open(host: &str, port: u16, security: &str, mode: Verify) -> Outcome<u32> {
	// The gateway is the authority on which host and port may be reached -- it holds
	// the account's bound mailboxes and closes 4403 on anything else.  This end checks
	// only what it can know by itself, so the two cannot drift apart.
	let phase = match security {
		"tls"		=> Phase::Tls,
		"starttls"	=> Phase::Clear,
		other		=> return Err(err!(
			"Security mode {:?} for {}:{} is not one of tls, starttls.",
			other, host, port; Invalid, Input)),
	};

	let cfg = res!(build_config(&mode));

	// The name the certificate is checked against is the host the caller asked for,
	// never anything the peer says about itself.
	let name = res!(ServerName::try_from(host.to_string()).map_err(|e| err!(
		"Mail host {:?} is not a valid DNS name or IP address: {:?}",
		host, e; Invalid, Input)));

	let conn = res!(ClientConnection::new(Arc::new(cfg), name).map_err(|e| err!(
		"rustls refused to start a connection for {}:{}: {:?}",
		host, port, e; Init)));

	let tunnel = Tunnel {
		host:	host.to_string(),
		port,
		conn,
		phase,
		wire:	Vec::new(),
		plain:	Vec::new(),
		eof:	false,
		fault:	None,
	};

	TUNNELS.with(|reg| {
		let mut reg = reg.borrow_mut();
		reg.push(Some(tunnel));
		Ok(reg.len() as u32)	// handles are one-based, so zero is never a live handle
	})
}

/// Runs `f` against a live tunnel, or fails naming the handle.
fn with_tunnel<T, F>(h: u32, f: F) -> Outcome<T>
where
	F: FnOnce(&mut Tunnel) -> Outcome<T>,
{
	TUNNELS.with(|reg| {
		let mut reg = reg.borrow_mut();
		if h == 0 || h as usize > reg.len() {
			return Err(err!("Mail tunnel handle {} was never issued.", h; Invalid, Input));
		}
		match reg[(h - 1) as usize].as_mut() {
			Some(t)	=> f(t),
			None	=> Err(err!("Mail tunnel handle {} has been closed.", h; Invalid, Input)),
		}
	})
}

/// Drains everything rustls wants to put on the wire into the out-queue.
fn drain_out(t: &mut Tunnel) -> Outcome<()> {
	while t.conn.wants_write() {
		let n = res!(t.conn.write_tls(&mut t.wire).map_err(|e| err!(
			"Writing TLS records out to {} failed after {} queued bytes: {}",
			t.host, t.wire.len(), e; IO)));
		if n == 0 {
			break;
		}
	}
	Ok(())
}

/// Moves whatever rustls can now decrypt into the plaintext queue.  `WouldBlock` is the
/// normal answer mid-handshake and is not an error.
fn drain_in(t: &mut Tunnel) -> Outcome<()> {
	let mut buf = [0u8; 4096];
	loop {
		match t.conn.reader().read(&mut buf) {
			Ok(0)	=> {
				t.eof = true;
				break;
			},
			Ok(n)	=> t.plain.extend_from_slice(&buf[..n]),
			Err(ref e) if e.kind() == ErrorKind::WouldBlock => break,
			Err(e)	=> return Err(err!(
				"Reading decrypted bytes from {} failed with {} bytes already held: {}",
				t.host, t.plain.len(), e; IO)),
		}
	}
	Ok(())
}

fn feed(t: &mut Tunnel, bytes: &[u8]) -> Outcome<()> {
	if let Phase::Clear = t.phase {
		// Before STARTTLS the wire is the conversation, so it goes straight through.
		t.plain.extend_from_slice(bytes);
		return Ok(());
	}

	let mut rd = Cursor::new(bytes);
	// `read_tls` takes one record's worth at a time, so a single WebSocket frame
	// carrying several records needs more than one call.
	while (rd.position() as usize) < bytes.len() {
		let n = res!(t.conn.read_tls(&mut rd).map_err(|e| err!(
			"Reading TLS records in from {} failed at offset {} of {}: {}",
			t.host, rd.position(), bytes.len(), e; IO)));
		if n == 0 {
			break;
		}
		match t.conn.process_new_packets() {
			Ok(_) => {},
			Err(e) => {
				// Record the failure and still drain, because rustls has queued
				// the alert that tells the peer why the connection is ending.
				if t.fault.is_none() {
					t.fault = Some(fmt!("{:?}", e));
				}
				res!(drain_out(t));
				return Ok(());
			},
		}
	}

	res!(drain_out(t));
	res!(drain_in(t));
	Ok(())
}

fn secure(t: &mut Tunnel) -> Outcome<()> {
	match t.phase {
		Phase::Clear	=> {},
		Phase::Tls	=> return Err(err!(
			"Mail tunnel to {}:{} is already carrying TLS; STARTTLS cannot be run twice.",
			t.host, t.port; Invalid, Input)),
	}

	// Anything the server sent before the handshake and the caller has not read is
	// either a pipelined response or an injection, and there is no way to tell them
	// apart.  Cleartext held across the handshake is the STARTTLS command injection
	// flaw (CVE-2011-0411): the client is meant to discard its pre-TLS buffer, and a
	// buffer that still has bytes in it means the caller would have read them as
	// though they had arrived under the certificate it is about to check.
	if !t.plain.is_empty() {
		return Err(err!(
			"STARTTLS to {}:{} was asked for with {} unread cleartext bytes still \
			buffered; they cannot be carried across the handshake.",
			t.host, t.port, t.plain.len(); Invalid, Input));
	}

	t.phase = Phase::Tls;
	res!(drain_out(t));	// releases the ClientHello, held back until now
	Ok(())
}

// ── The exported surface ────────────────────────────────────────────────
//
// Ciphertext in, ciphertext out.  The caller owns the socket and never sees a key.

/// Opens a tunnel to `host`:`port`, verified against the bundled Mozilla roots, with no
/// way to ask for anything weaker.  `security` is `tls` or `starttls`; a `starttls`
/// tunnel starts in the clear and is promoted by [`mail_tunnel_secure`].
#[cfg(not(feature = "insecure_testing"))]
#[wasm_bindgen]
pub fn mail_tunnel_open(host: &str, port: u16, security: &str) -> Result<u32, JsValue> {
	open(host, port, security, Verify::Roots).map_err(to_js_err)
}

/// The testing entry point, which can also weaken or disable verification.  Compiled
/// only under `insecure_testing`, so a shipped bundle has no such door.
#[cfg(feature = "insecure_testing")]
#[wasm_bindgen]
pub fn mail_tunnel_open(
	host:		&str,
	port:		u16,
	security:	&str,
	mode:		&str,
	test_ca:	Option<Box<[u8]>>,
)
	-> Result<u32, JsValue>
{
	let mode = ok!(Verify::parse(mode, test_ca.as_deref()).map_err(to_js_err));
	open(host, port, security, mode).map_err(to_js_err)
}

/// Ciphertext in from the socket.
#[wasm_bindgen]
pub fn mail_tunnel_feed(h: u32, bytes: &[u8]) -> Result<(), JsValue> {
	with_tunnel(h, |t| feed(t, bytes)).map_err(to_js_err)
}

/// Ciphertext out to the socket.  Empty when there is nothing to send.
#[wasm_bindgen]
pub fn mail_tunnel_take(h: u32) -> Result<Box<[u8]>, JsValue> {
	with_tunnel(h, |t| {
		if let Phase::Tls = t.phase {
			res!(drain_out(t));
		}
		Ok(std::mem::take(&mut t.wire).into_boxed_slice())
	}).map_err(to_js_err)
}

/// Plaintext the peer has sent, decrypted.
#[wasm_bindgen]
pub fn mail_tunnel_read(h: u32) -> Result<Box<[u8]>, JsValue> {
	with_tunnel(h, |t| Ok(std::mem::take(&mut t.plain).into_boxed_slice())).map_err(to_js_err)
}

/// Queues plaintext for the peer, encrypted on the way out.
#[wasm_bindgen]
pub fn mail_tunnel_write(h: u32, bytes: &[u8]) -> Result<(), JsValue> {
	with_tunnel(h, |t| {
		if let Phase::Clear = t.phase {
			// The STARTTLS command itself, which by definition goes in the clear.
			t.wire.extend_from_slice(bytes);
			return Ok(());
		}
		res!(t.conn.writer().write_all(bytes).map_err(|e| err!(
			"Queuing {} plaintext bytes for {} failed: {}", bytes.len(), t.host, e; IO)));
		drain_out(t)
	}).map_err(to_js_err)
}

/// Starts the handshake on a `starttls` tunnel, once the server has agreed.  Refuses
/// while unread cleartext is still buffered.
#[wasm_bindgen]
pub fn mail_tunnel_secure(h: u32) -> Result<(), JsValue> {
	with_tunnel(h, secure).map_err(to_js_err)
}

/// One of `clear`, `handshaking`, `open`, `closed`, `failed`.
///
/// `failed` comes first, because a refused certificate leaves rustls mid-handshake: a
/// caller watching only the state would otherwise wait on a `handshaking` that can never
/// finish.
#[wasm_bindgen]
pub fn mail_tunnel_state(h: u32) -> Result<String, JsValue> {
	with_tunnel(h, |t| Ok(if t.fault.is_some() {
		"failed"
	} else {
		match t.phase {
			Phase::Clear					=> "clear",
			Phase::Tls if t.conn.is_handshaking()		=> "handshaking",
			Phase::Tls if t.eof && t.plain.is_empty()	=> "closed",
			Phase::Tls					=> "open",
		}
	}.to_string())).map_err(to_js_err)
}

/// The first protocol failure, verbatim, or `None` while the connection is healthy.  A
/// refused certificate arrives here as rustls's own discriminant.
#[wasm_bindgen]
pub fn mail_tunnel_fault(h: u32) -> Result<Option<String>, JsValue> {
	with_tunnel(h, |t| Ok(t.fault.clone())).map_err(to_js_err)
}

/// The negotiated protocol version, once the handshake has finished.
#[wasm_bindgen]
pub fn mail_tunnel_version(h: u32) -> Result<Option<String>, JsValue> {
	with_tunnel(h, |t| Ok(t.conn.protocol_version().map(|v| fmt!("{:?}", v))))
		.map_err(to_js_err)
}

#[wasm_bindgen]
pub fn mail_tunnel_close(h: u32) -> Result<(), JsValue> {
	TUNNELS.with(|reg| {
		let mut reg = reg.borrow_mut();
		if h == 0 || h as usize > reg.len() {
			return Err(err!("Mail tunnel handle {} was never issued.", h; Invalid, Input));
		}
		reg[(h - 1) as usize] = None;
		Ok(())
	}).map_err(to_js_err)
}

/// Names the build, so a page cannot silently be driving a module that checks less than
/// the page believes it does.  A production bundle answers `mailtls/verify-always`.
#[wasm_bindgen]
pub fn mail_tunnel_flavour() -> String {
	let safety = if cfg!(feature = "insecure_testing") {
		"INSECURE-TESTING"
	} else {
		"verify-always"
	};
	fmt!("mailtls/{}", safety)
}
