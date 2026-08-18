//! Browser (wasm32) runtime surface for Daimond.
//!
//! This module tree is the bridge between JavaScript and Daimond's
//! target-agnostic core.  It is compiled only for `wasm32` and never
//! links into the native build.
//!
//! - [`entry`] — the `#[wasm_bindgen]` API exposed to JS: a core-init
//!   probe, an OPFS read/write pair, and an LLM transport probe.
//! - [`app`] — the [`DaimondApp`](app::DaimondApp) agent surface: runs a real
//!   [`Agent`](crate::agent::Agent) turn and streams
//!   [`AgentEvent`](crate::protocol::AgentEvent)s to a JS callback, and
//!   hosts the Diamond / crystal / fold surface.
//! - [`diamond`] — the Diamond / crystal / fold substrate: the OPFS layout and
//!   store operations behind the durable crystal and the advisory fold.
//! - [`cloud`] — the cloud storage edge: the workspace files that are not
//!   on this device, and the deliberate fetch that brings one down.
//! - [`opfs`] — an async filesystem edge over the Origin Private File
//!   System (OPFS), reached through `navigator.storage.getDirectory()`.
//! - [`pty`] — the terminal edge: bindings to `window.DaimondPty`, which
//!   carries a real terminal session rather than one whole command, and
//!   [`pty_request`](pty::pty_request), which composes the `open` request a
//!   session travels on — fence included, by the same path `Tool::Run` takes.
//! - [`hand`] — the machine hand's edge: bindings to the `window.DaimondHand`
//!   relay behind `run`, which reaches a process outside the page.
//! - [`web`] — the Web panel edge: bindings to the `window.DaimondWeb`
//!   driver behind the agent's web tools.
//! - [`doc`] — the document panel's edge: bindings to `window.DaimondDoc`
//!   behind `file_show`, which is how a model puts a file in front of the
//!   user rather than reading its bytes.
//! - [`office`] — the Office document edge: a `.docx` read into the prose the
//!   Doc panel draws and `file_read` returns, and Markdown written back out as
//!   one.  The model never emits document XML; the conversion is code.
//! - [`typst`] — the Typst compiler edge: bindings to the `window.DaimondTypst`
//!   driver behind `typst_compile`, which exchanges bytes only.
//! - [`mailtls`] — the browser end of the blind mail tunnel: a TLS client that runs
//!   in the page, so the gateway relays ciphertext and holds no keys.  Sans-io —
//!   JavaScript owns the socket and pumps bytes through it.
//!
//! The synchronous single-writer OPFS path (`createSyncAccessHandle` in
//! a dedicated Worker, needed for the append-only `.daimond` log) is
//! deferred; the main-thread async path here is sufficient for the
//! first browser vertical.

pub mod app;
pub mod cloud;
pub mod doc;
pub mod entry;
pub mod hand;
pub mod diamond;
pub mod mailtls;
pub mod office;
pub mod opfs;
pub mod pty;
pub mod typst;
pub mod web;

use oxedyne_fe2o3_core::prelude::*;

use wasm_bindgen::JsValue;

/// Render a JS error value as a human-readable string.
pub(crate) fn js_str(v: &JsValue) -> String {
    v.as_string().unwrap_or_else(|| fmt!("{:?}", v))
}

/// Read a string property from a JS object, or `None` when it is absent
/// or not a string.  Used to lift plain `{ role, content }` objects
/// across the boundary without a JSON round trip.
pub(crate) fn js_prop(obj: &JsValue, key: &str) -> Option<String> {
    match js_sys::Reflect::get(obj, &JsValue::from_str(key)) {
        Ok(v)  => v.as_string(),
        Err(_) => None,
    }
}

/// Map a Daimond [`Error`] into a `JsValue` suitable for rejecting a
/// `Promise`, stringifying the full error (message plus tags) so the
/// browser console and the harness DOM see the real cause.
pub(crate) fn to_js_err(e: Error<ErrTag>) -> JsValue {
    JsValue::from_str(&fmt!("{}", e))
}
