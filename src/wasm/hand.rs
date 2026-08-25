//! The machine hand's edge — thin bindings to the JS relay `window.DaimondHand`.
//!
//! A web page cannot create a process.  There is no flag and no future API, so
//! the capability lives in a program outside the page: a native messaging host
//! that Chrome launches and connects to the Daimond Hands extension, and to
//! nothing else.  The browser is the doorman.  A loopback daemon was rejected
//! because its port is reachable by any page the user visits and its whole
//! defence would be one pasted secret.
//!
//! This file is the narrow part of that road.  `window.DaimondHand` hides
//! which transport is attached -- the extension on this machine, or the same
//! hand binary over a WebSocket on a machine you own -- so the tool above does
//! not change when the second one appears.
//!
//! A rejection carries a plain-English `Error` the model is meant to read and
//! act on, so its `message` is passed through **verbatim**, exactly as the Web
//! panel edge does.  Mangling it would destroy the only instruction the model
//! gets about what to do next.

use crate::wasm::js_str;

use oxedyne_fe2o3_core::prelude::*;

use wasm_bindgen::prelude::wasm_bindgen;
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;


#[wasm_bindgen]
extern "C" {

    /// The relay object the page installs at `window.DaimondHand`.
    #[wasm_bindgen(js_name = DaimondHand)]
    type Relay;

    /// Whether a hand is paired, which machine it is, and what it can enforce.
    #[wasm_bindgen(method)]
    fn status(this: &Relay) -> js_sys::Promise;

    /// Run one command, resolving when it has finished.
    ///
    /// The relay streams the output to the panel as it arrives; what comes
    /// back here is the whole run, because a tool result is one blob and the
    /// model reads it once.  The live stream is for the person watching.
    #[wasm_bindgen(method)]
    fn run(this: &Relay, spec_json: &str) -> js_sys::Promise;

    /// What the hand is still running, standing process groups included.
    #[wasm_bindgen(method)]
    fn runs(this: &Relay) -> js_sys::Promise;

    /// The output a page reload left this page holding for one run.
    #[wasm_bindgen(method)]
    fn held(this: &Relay, id: &str) -> js_sys::Promise;

    /// Signal one run by the identifier it was given, resolving when the
    /// message has been handed over.
    #[wasm_bindgen(method)]
    fn signal(this: &Relay, id: &str, sig: &str) -> js_sys::Promise;
}


/// Reach the relay object on `window`, or refuse in the model's language.
///
/// The refusal is the most-read sentence in this file: a user who has not
/// installed the hand meets it on their first command, so it says what is
/// missing and what to do, not merely that something failed.
fn relay() -> Outcome<Relay> {
    let win = res!(web_sys::window()
        .ok_or_else(|| err!("The machine hand needs a browser window."; System, Missing)));
    let obj = res!(js_sys::Reflect::get(&win, &JsValue::from_str("DaimondHand"))
        .map_err(|e| err!("Reading window.DaimondHand failed: {}.", js_str(&e); System, Missing)));
    if obj.is_undefined() || obj.is_null() {
        return Err(err!(
            "There is no machine hand in this page, so there is nothing to run \
            commands on. Daimond runs in the browser and a browser cannot start \
            a program; the hand is a small companion that can. Tell the user it \
            is not installed, and carry on with the file tools, which do not \
            need it.";
            System, Missing));
    }
    Ok(obj.unchecked_into::<Relay>())
}

/// The `message` of a rejected JS `Error`, verbatim, falling back to the
/// value's own rendering when it is not an `Error`.
fn refusal(e: &JsValue) -> String {
    match js_sys::Reflect::get(e, &JsValue::from_str("message")) {
        Ok(m)  => m.as_string().unwrap_or_else(|| js_str(e)),
        Err(_) => js_str(e),
    }
}

/// Render a resolved JS value as the JSON string the tool result carries.
fn stringify(v: &JsValue) -> Outcome<String> {
    if v.is_undefined() || v.is_null() {
        return Ok("{}".to_string());
    }
    if let Some(s) = v.as_string() {
        return Ok(s); // the relay resolved with JSON already
    }
    match js_sys::JSON::stringify(v) {
        Ok(s)  => Ok(String::from(s)),
        Err(e) => Err(err!(
            "The machine hand returned a result that cannot be read: {}.", refusal(&e);
            Invalid, Data)),
    }
}

/// Await a relay promise, passing a refusal through untouched.
async fn settle(promise: js_sys::Promise) -> Outcome<String> {
    match JsFuture::from(promise).await {
        Ok(v)  => stringify(&v),
        Err(e) => Err(err!("{}", refusal(&e); IO, Invalid)),
    }
}

/// Whether a machine hand is present.
///
/// AUTHORED BY A DAIMON, `dev/reflux.mjs --task opfssay`, 2026-08-24, comment included.  It is
/// asked by [`crate::tools::two_places_note`] and by [`crate::tools::write_place`] to decide
/// whether there is a second filesystem worth naming; [`status`] answers more and costs a round
/// trip, on a path that has already failed.
///
/// **It was `relay().is_ok()` until 2026-08-24 and that was the wrong question.**  `hand.js`
/// installs `window.DaimondHand` on EVERY page, paired or not -- it is the shim that answers
/// "no hand is installed", so its presence is not evidence of one.  So the two-filesystems note
/// was appearing for a user with no hand at all, telling them about a granted folder on their
/// computer that did not exist.  `hasHand()` is the relay's own answer, `transport !== 'none'`,
/// and is what "present" always meant.
///
/// A relay that cannot answer is taken as no hand.  Silence loses a hint; the other direction
/// invents a second filesystem, which is the fault being fixed.
pub fn present() -> bool {
    let r = match relay() {
        Ok(r)  => r,
        Err(_) => return false,
    };
    let obj: &JsValue = r.as_ref();
    let f = match js_sys::Reflect::get(obj, &JsValue::from_str("hasHand")) {
        Ok(v)  => v,
        Err(_) => return false,
    };
    let f: js_sys::Function = match f.dyn_into() {
        Ok(f)  => f,
        Err(_) => return false,
    };
    matches!(f.call0(obj), Ok(v) if v.is_truthy())
}

/// Whether a hand is paired, which machine it is, and what it can enforce.
pub async fn status() -> Outcome<String> {
    let r = res!(relay());
    settle(r.status()).await
}

/// Run one command and return the whole result as JSON.
///
/// A rejection from the relay is **not** returned as an error, and that is
/// deliberate.  Every one of them is a whole sentence written for the model to
/// act on -- the hand is not installed, the user declined, it stopped
/// part-way -- and an `Err` reaches the daimon wrapped in an fe2o3 chain,
/// carrying ANSI colour and a `src/*.rs:line` frame around the one sentence
/// that matters.  A hand that will not run a command has refused it, so it is
/// handed on as a refusal and rendered as one.
///
/// # Arguments
/// * `spec_json` - The `exec` request, already rendered as the wire's JSON.
pub async fn run(spec_json: &str) -> Outcome<String> {
    let r = res!(relay());
    match JsFuture::from(r.run(spec_json)).await {
        Ok(v)  => stringify(&v),
        Err(e) => Ok(fmt!(r#"{{"refused":"{}"}}"#, crate::llm::json_escape(&refusal(&e)))),
    }
}

/// Carry out one file operation and return the answer as JSON.
///
/// **Reached reflectively, not through a `#[wasm_bindgen(method)]` declaration, and the
/// reason is a hang.**  A declared method that is not on the object throws when it is called,
/// and a throw out of a declared-infallible import does not become an `Err` -- the promise is
/// never made, nothing resolves, and the tool call waits for ever.  A relay older than this
/// build is exactly that case, and so is every test stub written before the verb existed:
/// `dev/verify_chatfence.mjs`'s stub answers `hasHand`, `status` and `run`, and its first
/// `file_write` to a marked folder hung the whole verifier.
///
/// So the function is looked up, and its absence is a SENTENCE.  Never a fall back to browser
/// storage: a write that lands in the other filesystem while the daimon believes it changed
/// the machine is the failure `write_place` exists to refuse, and doing it here silently would
/// be that failure with a new door on it.
///
/// A rejection is handed on as a refusal for exactly the reason [`run`] gives: every one of
/// them is a whole sentence written for the model to act on, and an `Err` would wrap it in an
/// fe2o3 chain carrying colour and a `src/*.rs:line` frame around the one sentence that
/// matters.
///
/// # Arguments
/// * `spec_json` - The `file` request, already rendered as the wire's JSON.
pub async fn file(spec_json: &str) -> Outcome<String> {
    let r = res!(relay());
    let obj: &JsValue = r.as_ref();
    let f = match js_sys::Reflect::get(obj, &JsValue::from_str("file")) {
        Ok(v)  => v,
        Err(_) => return Ok(no_file_door()),
    };
    let f: js_sys::Function = match f.dyn_into() {
        Ok(f)  => f,
        Err(_) => return Ok(no_file_door()),
    };
    let p = match f.call1(obj, &JsValue::from_str(spec_json)) {
        Ok(p)  => p,
        Err(e) => return Ok(fmt!(r#"{{"refused":"{}"}}"#,
            crate::llm::json_escape(&refusal(&e)))),
    };
    let p: js_sys::Promise = match p.dyn_into() {
        Ok(p)  => p,
        Err(_) => return Ok(no_file_door()),
    };
    match JsFuture::from(p).await {
        Ok(v)  => stringify(&v),
        Err(e) => Ok(fmt!(r#"{{"refused":"{}"}}"#, crate::llm::json_escape(&refusal(&e)))),
    }
}

/// What to say when the relay attached to this page cannot carry a file operation.
///
/// It names the two things the reader can do about it, because "the hand is old" is not an
/// instruction: update it, or reach the file with `run`, which every hand has always had.
fn no_file_door() -> String {
    fmt!(r#"{{"refused":"{}"}}"#, crate::llm::json_escape(
        "The machine hand attached to this page cannot change files directly -- it is older \
        than this version of Daimond. Nothing was read or changed. Tell the user to update \
        the hand, and meanwhile reach the file with run, which every hand can do."))
}

/// What this hand is still running, as the relay's JSON.
///
/// Two things a caller must not read into it.  The listing is a MEASUREMENT
/// taken a moment ago, so a run in it may have ended since; and a run absent
/// from it is one the hand can no longer reach, which is not the same claim as
/// one that has stopped.
pub async fn runs() -> Outcome<String> {
    let r = res!(relay());
    settle(r.runs()).await
}

/// The output held for one run across a page reload, as the relay's JSON.
///
/// **Handed over once.**  The relay lets go of what it answers with, because the whole of it has
/// gone to the reader and a second copy of a build's output in a tab is one nobody will look at
/// again.  So a caller that discards this answer has discarded the output.
///
/// # Arguments
/// * `id` - The run's identifier, as the listing carries it.
pub async fn held(id: &str) -> Outcome<String> {
    let r = res!(relay());
    settle(r.held(id)).await
}

/// Signal one run this hand started, by the identifier the run was given.
///
/// **Resolving promises nothing about the process.**  There is deliberately no
/// "stopped" answer on the wire: a signal that could not be delivered comes back
/// as an error, and a signal that could is confirmed by asking [`runs`] again.
/// Reporting success on a kill that failed is the defect that arrangement exists
/// to close, so nothing here may be read as one.
///
/// # Arguments
/// * `id` - The identifier the run was given, never a pid and never a pattern.
/// * `sig` - `term`, `kill` or `int`.
pub async fn signal(id: &str, sig: &str) -> Outcome<()> {
    let r = res!(relay());
    res!(settle(r.signal(id, sig)).await);
    Ok(())
}
