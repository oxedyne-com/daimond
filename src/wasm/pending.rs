//! The Pending panel's edge for a daimon -- a thin binding to `window.DaimondPendingTool`.
//!
//! D-20261016-17.  `pending_raise` and `pending_clear` are checked in `tools.rs`
//! (`pending_step`), where every bound is tested natively; this module only hands the checked
//! payload to the page and brings its answer back as JSON text.  The Diamond is passed here from
//! the turn's own context, never from the model's arguments, and the page namespaces the key by
//! it -- so one Diamond can neither clear nor overwrite another's alert.
//!
//! A page with no driver must fail loudly rather than let the model report an alert nobody can
//! see.

use crate::wasm::js_str;
use crate::wasm::refusal;

use oxedyne_fe2o3_core::prelude::*;

use wasm_bindgen::prelude::wasm_bindgen;
use wasm_bindgen::{JsCast, JsValue};


#[wasm_bindgen]
extern "C" {

    /// The driver object `www/js/alerts.js` installs at `window.DaimondPendingTool`.
    #[wasm_bindgen(js_name = DaimondPendingTool)]
    type Driver;

    /// Raise (or update in place) one alert of `diamond`'s; answers `{ok, was}`.
    #[wasm_bindgen(catch, method)]
    fn raise(this: &Driver, diamond: &str, payload: &str) -> Result<JsValue, JsValue>;

    /// Clear one alert of `diamond`'s; answers `{ok, cleared}`.
    #[wasm_bindgen(catch, method)]
    fn clear(this: &Driver, diamond: &str, payload: &str) -> Result<JsValue, JsValue>;
}


/// Reach the driver object on `window`, or refuse in the model's language.
fn driver() -> Outcome<Driver> {
    let win = res!(web_sys::window()
        .ok_or_else(|| err!("The Pending panel needs a browser window."; System, Missing)));
    let obj = res!(js_sys::Reflect::get(&win, &JsValue::from_str("DaimondPendingTool"))
        .map_err(|e| err!("Reading window.DaimondPendingTool failed: {}.", js_str(&e); System, Missing)));
    if obj.is_undefined() || obj.is_null() {
        return Err(err!(
            "This page has no Pending panel to put an alert on, so nobody would see one. Write \
            the alert into your log instead and say so."; System, Missing));
    }
    Ok(obj.unchecked_into::<Driver>())
}

/// Hand one checked call to the page, and return its answer as JSON text.
///
/// # Arguments
/// * `raise` - `true` for `pending_raise`, `false` for `pending_clear`.
/// * `diamond` - The turn's own Diamond id.
/// * `payload` - The checked arguments, as `pending_step` composed them.
pub async fn call(raise: bool, diamond: &str, payload: &str) -> Outcome<String> {
    let d = res!(driver());
    let r = if raise { d.raise(diamond, payload) } else { d.clear(diamond, payload) };
    let v = match crate::wasm::settle_call(r).await {
        Ok(v)  => v,
        Err(e) => return Err(err!("{}", refusal(&e); IO, Invalid)),
    };
    match v.as_string() {
        Some(s) => Ok(s),
        None    => match js_sys::JSON::stringify(&v) {
            Ok(s)  => Ok(String::from(s)),
            Err(_) => Err(err!(
                "The Pending panel answered with something that cannot be read, so whether the \
                alert is up is unknown. Do not tell the user it is."; Invalid, Data)),
        },
    }
}
