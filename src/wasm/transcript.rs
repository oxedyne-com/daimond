//! The daimon chat's transcript edge for `recall` -- a thin binding to
//! `window.DaimondTranscript` (UNBLOCK-11).
//!
//! A daimon's model session is a per-device cache that a fold shortens and another device never
//! saw, but the chat's transcript prose and its fold record are the same on every device. The
//! page searches them (`www/js/daimond.js`) and answers a JSON array of
//! `{mid, ts, role, excerpt}`; `recall` reports each as a `transcript:` line. The Diamond is the
//! turn's own, never the model's word.
//!
//! A page with no driver fails loudly, so `recall` says the transcript was not searched rather
//! than answering "nothing" about it.

use crate::wasm::js_str;
use crate::wasm::refusal;

use oxedyne_fe2o3_core::prelude::*;

use wasm_bindgen::prelude::wasm_bindgen;
use wasm_bindgen::{JsCast, JsValue};


#[wasm_bindgen]
extern "C" {

    /// The driver object the page installs at `window.DaimondTranscript`.
    #[wasm_bindgen(js_name = DaimondTranscript)]
    type Driver;

    /// Search `diamond`'s daimon chat with `recall`'s own arguments; answers (or resolves to)
    /// a JSON array of `{mid, ts, role, excerpt}`.
    #[wasm_bindgen(catch, method)]
    fn search(this: &Driver, diamond: &str, args: &str) -> Result<JsValue, JsValue>;
}


/// Reach the driver object on `window`, or say why not.
fn driver() -> Outcome<Driver> {
    let win = res!(web_sys::window()
        .ok_or_else(|| err!("the transcript search needs a browser window"; System, Missing)));
    let obj = res!(js_sys::Reflect::get(&win, &JsValue::from_str("DaimondTranscript"))
        .map_err(|e| err!("reading window.DaimondTranscript failed: {}", js_str(&e); System, Missing)));
    if obj.is_undefined() || obj.is_null() {
        return Err(err!("this page has no transcript search"; System, Missing));
    }
    Ok(obj.unchecked_into::<Driver>())
}

/// Search the daimon chat of `diamond` with `recall`'s arguments, and return the page's answer
/// as JSON text.
///
/// # Arguments
/// * `diamond` - The turn's own Diamond id.
/// * `args` - The `recall` call's arguments, as the model wrote them.
pub async fn search(diamond: &str, args: &str) -> Outcome<String> {
    let d = res!(driver());
    let v = match crate::wasm::settle_call(d.search(diamond, args)).await {
        Ok(v)  => v,
        Err(e) => return Err(err!("{}", refusal(&e); IO, Invalid)),
    };
    match v.as_string() {
        Some(s) => Ok(s),
        None    => match js_sys::JSON::stringify(&v) {
            Ok(s)  => Ok(String::from(s)),
            Err(_) => Err(err!("the transcript search answered with something that cannot be \
                read"; Invalid, Data)),
        },
    }
}
