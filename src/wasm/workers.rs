//! The worker pump's edge — a thin binding to the JS driver `window.DaimondWorkers`.
//!
//! WHY THIS MODULE EXISTS, WHICH IS NOT WHAT IT DOES.  Until it did, a worker's report could only
//! reach the daimon that sent it as a LATER TURN: the page collected each `spawn_agent` call,
//! started the workers once the turn had ended, and spent a fresh turn handing the reports back.
//! That hand-back turn re-sends the whole standing context for the sake of reading a few
//! kilobytes of report, and on the owner's own chat one such turn cost US$0.67 by itself.  With
//! this, the worker starts at the call and `gather` reads its report as a tool result inside the
//! same turn.
//!
//! **THE WAIT IS THE PAGE'S, AND HAS TO BE.**  `Workers` owns the runs, so it is the only thing
//! that can say when one has reached a terminal state; `await_reports` hands back a promise that
//! settles when they have, when the deadline passes, or when the user presses Stop.  Nothing here
//! holds a timer.
//!
//! A page too old to carry either method fails loudly rather than quietly: the caller falls back
//! to the sentence that was true before the bridge existed -- every worker starts when the turn
//! ends -- so a new engine in an old shell tells the model the truth about that shell.

use crate::wasm::js_str;
use crate::wasm::refusal;

use oxedyne_fe2o3_core::prelude::*;

use wasm_bindgen::prelude::wasm_bindgen;
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;


#[wasm_bindgen]
extern "C" {

    /// The driver object `www/js/daimond.js` installs at `window.DaimondWorkers`.
    #[wasm_bindgen(js_name = DaimondWorkers)]
    type Pump;

    /// Start one worker now, and answer whether it started and under which id.
    #[wasm_bindgen(method)]
    fn spawn(this: &Pump, payload: &str) -> js_sys::Promise;

    /// Wait for the named runs, and answer with their reports and what is still running.
    #[wasm_bindgen(method, js_name = awaitReports)]
    fn await_reports(this: &Pump, payload: &str) -> js_sys::Promise;
}


/// Reach the driver object on `window`, or refuse in the model's language.
///
/// `method` is named in the refusal because the two halves arrive together in a new page and
/// separately in an old one: a shell carrying `DaimondWorkers` without `awaitReports` is exactly
/// the backward-compatibility case, and a caller that could not tell which was missing would fall
/// back for the wrong reason.
fn pump(method: &str) -> Outcome<Pump> {
    let win = res!(web_sys::window()
        .ok_or_else(|| err!("Starting a worker needs a browser window."; System, Missing)));
    let obj = res!(js_sys::Reflect::get(&win, &JsValue::from_str("DaimondWorkers"))
        .map_err(|e| err!("Reading window.DaimondWorkers failed: {}.",
            js_str(&e); System, Missing)));
    if obj.is_undefined() || obj.is_null() {
        return Err(err!(
            "This page has no worker pump, so nothing can be started from inside a turn.";
            System, Missing));
    }
    let has = js_sys::Reflect::get(&obj, &JsValue::from_str(method))
        .map(|f| f.is_function())
        .unwrap_or(false);
    if !has {
        return Err(err!(
            "This page's worker pump has no '{}', so it is the older shell that starts workers \
            when the turn ends.", method; System, Missing));
    }
    Ok(obj.unchecked_into::<Pump>())
}

/// Whatever the driver resolved with, as a JSON string.
fn answered(v: JsValue) -> Outcome<String> {
    match v.as_string() {
        Some(s) => Ok(s),
        None    => match js_sys::JSON::stringify(&v) {
            Ok(s)  => Ok(String::from(s)),
            Err(_) => Err(err!(
                "The page answered with something that cannot be read, so whether the worker is \
                running is unknown."; Invalid, Data)),
        },
    }
}

/// Start one worker now.
///
/// # Arguments
/// * `payload` - `{"name":…,"task":…}` as the tool composed it.
pub async fn spawn(payload: &str) -> Outcome<String> {
    let p = res!(pump("spawn"));
    match JsFuture::from(p.spawn(payload)).await {
        Ok(v)  => answered(v),
        Err(e) => Err(err!("{}", refusal(&e); IO, Invalid)),
    }
}

/// Wait for the named runs and read their reports.
///
/// # Arguments
/// * `payload` - `{"ids":[…],"timeout_ms":…,"partial":…}` as the tool composed it.
pub async fn await_reports(payload: &str) -> Outcome<String> {
    let p = res!(pump("awaitReports"));
    match JsFuture::from(p.await_reports(payload)).await {
        Ok(v)  => answered(v),
        Err(e) => Err(err!("{}", refusal(&e); IO, Invalid)),
    }
}
