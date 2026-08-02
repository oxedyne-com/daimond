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
