//! The `#[wasm_bindgen]` API surface exposed to the browser.
//!
//! Three probes prove the browser vertical end-to-end, no server
//! involved:
//!
//! 1. [`core_probe`] — the wasm module instantiates and a `fe2o3_core`
//!    call path (getrandom-backed RNG, the wasm clock shim, the error
//!    machinery) executes without panicking.
//! 2. [`write_file`] / [`read_file`] — a byte-exact OPFS round trip
//!    through the [`opfs`](crate::wasm::opfs) edge.
//! 3. [`llm_probe`] — the real wasm [`LlmClient`](crate::llm::LlmClient)
//!    transport issues a cross-origin `fetch` to a provider and returns
//!    the HTTP status.
//!
//! Async functions surface to JS as `Promise`s (via
//! `wasm-bindgen-futures`); [`Outcome`] errors are mapped to a rejected
//! `Promise` through [`to_js_err`](crate::wasm::to_js_err).

use crate::llm::LlmClient;
use crate::tools::FileRoot;
use crate::wasm::{opfs, to_js_err};

use oxedyne_fe2o3_graphics::qr::{
    encode,
    QrEcc,
};

use oxedyne_fe2o3_core::prelude::*;
use oxedyne_fe2o3_core::rand::Rand;
use oxedyne_fe2o3_core::wasm::{console_log, now_ms};

use wasm_bindgen::prelude::*;
use web_sys::FileSystemDirectoryHandle;


/// Default per-turn token cap for the probe client.  The value is
/// irrelevant to a dummy-key probe (the request never reaches
/// generation), but the field must be set.
const PROBE_MAX_TOKENS: u32 = 16;


/// Run a `fe2o3_core` call path in the browser and return a one-line
/// summary — the F2 proof that the gated core *runs*, not merely
/// compiles.
///
/// Exercises getrandom (via [`Rand::rand_u64`]), the wasm clock shim
/// ([`now_ms`]), the console shim ([`console_log`]) and the error
/// machinery ([`err`]).  Never panics.
#[wasm_bindgen]
pub fn core_probe() -> Result<String, JsValue> {
    // getrandom-backed RNG — panics on wasm if the `js` backend is not
    // wired, so a returned value is itself proof.
    let r = Rand::rand_u64();

    // Wall-clock via the JS `Date.now()` shim.
    let t = now_ms();

    // The error machinery must format cleanly under wasm.
    let sample: Error<ErrTag> = err!("probe sample error"; Test);
    let err_len = fmt!("{}", sample).len();

    let summary = fmt!(
        "core ok: rand_u64={:#018x}, now_ms={:.0}, err_fmt_len={}",
        r, t, err_len,
    );
    console_log(&summary);
    Ok(summary)
}

/// Write `content` (UTF-8) to `path` in the active Workspace root,
/// creating parents as needed.  Resolves against the FSA real folder when
/// one is open, else the OPFS sandbox.  Rejects on a jail violation or a
/// filesystem failure.
#[wasm_bindgen]
pub async fn write_file(path: String, content: String) -> Result<(), JsValue> {
    opfs::write_file(FileRoot::Workspace, &path, content.as_bytes()).await.map_err(to_js_err)
}

/// Read `path` from the active Workspace root (FSA real folder when open,
/// else OPFS) and return its contents as a UTF-8 string.
#[wasm_bindgen]
pub async fn read_file(path: String) -> Result<String, JsValue> {
    match opfs::read_file(FileRoot::Workspace, &path).await {
        Ok(bytes) => Ok(String::from_utf8_lossy(&bytes).to_string()),
        Err(e)    => Err(to_js_err(e)),
    }
}

/// Point the file tools / Workspace at a real local folder (FSA mode).
///
/// `handle` is a `FileSystemDirectoryHandle` from `showDirectoryPicker()`
/// in JS, already permission-granted for read/write.  Once set, every
/// [`FileRoot::Workspace`] file tool (`file_read`/`write`/`list`/`edit`/
/// `delete`/`search`) resolves against the real folder.  Daimond's own
/// Facet/brief/`.daimond` storage is unaffected — it pins the OPFS sandbox.
#[wasm_bindgen]
pub fn set_workspace_dir(handle: FileSystemDirectoryHandle) {
    opfs::set_override(handle);
}

/// Clear any FSA override, returning the file tools / Workspace to the
/// OPFS sandbox root.
#[wasm_bindgen]
pub fn use_opfs_workspace() {
    opfs::clear_override();
}

/// The current Workspace file-tool root mode: `"folder"` when an FSA real
/// folder is open, else `"opfs"`.
#[wasm_bindgen]
pub fn workspace_mode() -> String {
    opfs::workspace_mode()
}

/// Encode `text` as a QR Code and return its module grid, row-major, one byte
/// per module: `1` is a dark module, `0` a light one.
///
/// The side length is the square root of the returned length, so the caller
/// needs nothing else to draw the symbol. An empty array means the text would
/// not fit the largest QR version, which the caller reads as "fall back to the
/// typed code". Medium error correction is used: robust enough for a phone
/// camera reading the code off a screen, without inflating the version unduly.
#[wasm_bindgen]
pub fn qr_matrix(text: String) -> Vec<u8> {
    match encode(&text, QrEcc::Medium) {
        Ok(qr) => {
            let n = qr.size();
            let mut out = Vec::with_capacity(n * n);
            for y in 0..n {
                for x in 0..n {
                    out.push(if qr.get(x, y) { 1u8 } else { 0u8 });
                }
            }
            out
        }
        Err(_) => Vec::new(),
    }
}

/// Point every OPFS operation at the current account's subdirectory.
///
/// Empty means the primary account (the origin root, unchanged); any other value isolates this
/// account's workspace and Daimond's own state from every other account at this browser. Set once
/// at boot from `DaimondAccounts.opfsNs()`, before any file tool runs.
#[wasm_bindgen]
pub fn set_account_ns(ns: String) {
    opfs::set_account_ns(ns);
}

/// Probe the LLM transport: issue a real cross-origin `fetch` to
/// `base_url` with `api_key` and `model`, returning the HTTP status.
///
/// A `401` with a dummy key is success — it proves `fetch` + CORS + the
/// wasm transport path work end-to-end without a valid key.
#[wasm_bindgen]
pub async fn llm_probe(
    base_url: String,
    api_key:  String,
    model:    String,
) -> Result<u32, JsValue> {
    match run_llm_probe(&base_url, &api_key, &model).await {
        Ok(status) => Ok(status as u32),
        Err(e)     => Err(to_js_err(e)),
    }
}

/// Inner probe returning an [`Outcome`], so the transport path uses the
/// error macros throughout; the `#[wasm_bindgen]` wrapper maps the result
/// to the JS boundary.
async fn run_llm_probe(base_url: &str, api_key: &str, model: &str) -> Outcome<u16> {
    let (secure, host, port, path) = res!(parse_url(base_url));
    let client = LlmClient::new_with_scheme(
        &host, port, &path, api_key, model, PROBE_MAX_TOKENS, secure);
    let status = res!(client.probe_status().await);
    Ok(status)
}

/// Split a `scheme://host[:port]/path` URL into `(secure, host, port, path)`.
///
/// Both schemes are accepted, on the same terms as
/// [`crate::wasm::app`]'s `parse_base_url`: `https` for the real providers,
/// `http` for a local mock.  A probe that refused `http` would reject a base
/// URL the chat path goes on to accept.  The port defaults to the scheme's
/// own default when absent.
fn parse_url(url: &str) -> Outcome<(bool, String, u16, String)> {
    let (secure, default_port, rest) = if let Some(r) = url.strip_prefix("https://") {
        (true, 443u16, r)
    } else if let Some(r) = url.strip_prefix("http://") {
        (false, 80u16, r)
    } else {
        return Err(err!(
            "llm_probe: URL '{}' must start with http:// or https://.", url;
            Invalid, Input));
    };
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None    => (rest, "/"),
    };
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) => {
            let port = res!(p.parse::<u16>()
                .map_err(|e| err!(e, "llm_probe: bad port in '{}'.", url; Invalid, Input)));
            (h.to_string(), port)
        }
        None => (authority.to_string(), default_port),
    };
    if host.is_empty() {
        return Err(err!("llm_probe: empty host in '{}'.", url; Invalid, Input));
    }
    Ok((secure, host, port, path.to_string()))
}

/// The system prompt a dispatched worker agent runs under.
///
/// The browser builds each worker as a plain [`DaimondApp`] with the workspace
/// file tools, so it needs the prompt text; exporting it here keeps the one
/// definition in [`crate::wasm::facet`] rather than duplicating the wording
/// in JavaScript, where it would drift.
#[wasm_bindgen]
pub fn worker_prompt() -> String {
    crate::wasm::facet::WORKER_PROMPT.to_string()
}

/// The tools this build gives a chat, as JSON: `[{"tool":…,"blurb":…}]`.
///
/// The Tools panel tells a user what Daimond can do, and the only honest source for that is
/// the registry the agent is actually handed -- a list written out again in JavaScript would
/// drift, and the first a user would know of it is a tool that does not work or one they never
/// knew they had.
#[wasm_bindgen]
pub fn builtin_tools() -> String {
    let items = crate::tools::Tool::browser()
        .iter()
        .map(|t| fmt!(
            r#"{{"tool":"{}","blurb":"{}"}}"#,
            t.name(),
            crate::llm::json_escape(t.summary()),
        ))
        .collect::<Vec<String>>();
    fmt!("[{}]", items.join(","))
}
