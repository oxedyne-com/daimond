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
//! - [`ask`] — the question card's edge: bindings to `window.DaimondAsk`
//!   behind `ask`, which is how a model puts ONE decision to the user with
//!   options they answer by tapping rather than by typing.
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
pub mod ask;
pub mod cloud;
pub mod doc;
pub mod entry;
pub mod hand;
pub mod diamond;
pub mod mailtls;
pub mod office;
pub mod opfs;
pub mod pty;
pub mod social;
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

/// Is the page on screen, so a request sent now has somewhere to arrive?
///
/// `document.visibilityState`, and nothing cleverer.  A frozen tab reports `hidden`; there is no
/// API that says "you are about to be frozen", which is the whole difficulty.
///
/// Read through `Reflect` rather than through `web_sys::Document`, which would need two more
/// `web-sys` features turned on in `Cargo.toml` for one string.  The same route
/// [`web::driver`](crate::wasm::web) takes to `window.DaimondWeb`.
///
/// **Anything it cannot read counts as visible.**  A worker has no document at all, and waiting
/// there for a page that does not exist would hang the turn for the whole restore budget; an
/// unreadable property is the same case with a different cause.  So the fallback is to proceed,
/// which is what the code did before this existed.
pub(crate) fn page_is_visible() -> bool {
    let win = match web_sys::window() {
        Some(w) => w,
        None    => return true,
    };
    let doc = match js_sys::Reflect::get(&win, &JsValue::from_str("document")) {
        Ok(d) if !d.is_undefined() && !d.is_null() => d,
        _ => return true,
    };
    match js_sys::Reflect::get(&doc, &JsValue::from_str("visibilityState")) {
        Ok(v)  => v.as_string().map(|s| s == "visible").unwrap_or(true),
        Err(_) => true,
    }
}

/// The most the tool ladder will wait for a backgrounded page to come back.
///
/// Beyond this it gives up waiting and tries anyway.  A bound rather than a promise: the page may
/// never come back at all -- the user may have put the phone down -- and a turn that waits for
/// ever is a turn nobody can stop.
const RESTORE_WAIT_MS: u64 = 30_000;

/// How long after a restore to leave it before sending, in milliseconds.
///
/// **A cited number, not a guess.**  Apple Developer Forums 771127 (reported 2024-12, confirmed
/// by a second developer 2025-03, no Apple response as of 2026-08-28) documents a live WebKit
/// fault of exactly this shape: a `fetch` started immediately after `visibilitychange` fails
/// after 20-40 seconds with `TypeError: Load failed`, while the same fetch started after a short
/// delay succeeds.  Firing the instant the page is visible is therefore firing into the one
/// window that is known to be broken.
const SETTLE_AFTER_RESTORE_MS: u64 = 500;

/// Park until the page is back on screen and has settled, or until the wait is spent.
///
/// **THIS IS AS CLOSE TO SUSPENDING A TURN AS THE PLATFORM ALLOWS, and the limit is worth
/// stating plainly.**  A request already in flight cannot be parked: the `Promise` belongs to the
/// browser, the page's JavaScript is not running while the page is frozen, so nothing of ours can
/// observe the freeze while it is happening, and by the time anything of ours runs again the
/// request has already been rejected -- or the connection torn down with the process.  There is
/// no event that arrives in time and no handle to hold.
///
/// What CAN be parked is the moment BEFORE a request.  That turns "fire into a frozen page and
/// collect a corpse" into "wait for the page, then fire", which is what makes the retry ladder
/// above this worth having at all: without it, all eight attempts are spent into a frozen page
/// while the user is in another app, and the ladder is an expensive way to arrive at the same
/// failure.
///
/// # Arguments
/// * `waited` - Milliseconds this call has already slept, so the park is charged to the same
///   budget as the backoff and a turn cannot be extended indefinitely by being backgrounded.
pub(crate) async fn await_restored(waited: u64) -> u64 {
    if page_is_visible() {
        return 0;
    }
    let mut spent = 0u64;
    let budget = RESTORE_WAIT_MS.saturating_sub(waited.min(RESTORE_WAIT_MS));
    // Polled rather than driven by `visibilitychange`, because a listener registered while the
    // page is frozen is a listener that has to survive the freeze to be any use, and polling is
    // the one thing that cannot be missed: the loop simply does not run while the page is frozen,
    // and resumes on the tick after it wakes.
    while spent < budget {
        crate::llm::sleep_ms(250).await;
        spent += 250;
        if page_is_visible() {
            crate::llm::sleep_ms(SETTLE_AFTER_RESTORE_MS).await;
            return spent + SETTLE_AFTER_RESTORE_MS;
        }
    }
    spent
}
