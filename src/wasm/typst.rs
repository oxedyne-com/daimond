//! The Typst compiler edge — thin bindings to the JS driver `window.DaimondTypst`.
//!
//! The compiler itself is a 30 MB wasm module vendored under `www/vendor/typst`
//! and driven from `www/js/typst.js`.  It is reached the same way the Web panel
//! is: one object on `window`, one method, and a `Promise` awaited here.
//!
//! The division of labour matters.  This side does BYTES ONLY: the source text
//! goes out, PDF bytes come back, and every file touch -- reading the `.typ`,
//! writing the `.pdf` -- happens in Rust through [`crate::wasm::opfs`], so the
//! path jail, the per-account namespace and the real-folder override all apply.
//! The driver never learns a path.
//!
//! A driver that cannot load the compiler resolves with `{ error }` rather than
//! rejecting, so the wording the page already owns (`typst.load_failed`,
//! `typst.no_pdf`, `typst.compile_error`) reaches the model verbatim as the
//! reason the compile failed.

use crate::wasm::js_str;

use oxedyne_fe2o3_core::prelude::*;

use wasm_bindgen::prelude::wasm_bindgen;
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;


#[wasm_bindgen]
extern "C" {

    /// The driver object `www/js/typst.js` installs at `window.DaimondTypst`.
    #[wasm_bindgen(js_name = DaimondTypst)]
    type Driver;

    /// Compile a Typst source string, resolving `{ pdf }` or `{ error }`.
    #[wasm_bindgen(method)]
    fn compile(this: &Driver, source: &str) -> js_sys::Promise;
}


/// Reach the driver object on `window`, or refuse in the model's language.
fn driver() -> Outcome<Driver> {
    let win = res!(web_sys::window()
        .ok_or_else(|| err!("The Typst tool needs a browser window."; System, Missing)));
    let obj = res!(js_sys::Reflect::get(&win, &JsValue::from_str("DaimondTypst"))
        .map_err(|e| err!("Reading window.DaimondTypst failed: {}.", js_str(&e); System, Missing)));
    if obj.is_undefined() || obj.is_null() {
        return Err(err!(
            "The Typst compiler is not loaded in this page, so nothing can be typeset. \
            Tell the user, and carry on without it.";
            System, Missing));
    }
    Ok(obj.unchecked_into::<Driver>())
}

/// The `message` of a rejected JS `Error`, verbatim, falling back to the
/// value's own rendering when it is not an `Error`.
fn refusal(e: &JsValue) -> String {
    match js_sys::Reflect::get(e, &JsValue::from_str("message")) {
        Ok(m)  => m.as_string().unwrap_or_else(|| js_str(e)),
        Err(_) => js_str(e),
    }
}

/// Read the resolved `{ pdf }` / `{ error }` object into PDF bytes.
///
/// An `error` is passed through untouched: the page composed it from the
/// compiler's own diagnostics, which name the failing line, and rewording it
/// would destroy the only thing the model can act on.
///
/// # Arguments
/// * `v` - What the driver's promise resolved with.
fn bytes_of(v: &JsValue) -> Outcome<Vec<u8>> {
    if v.is_undefined() || v.is_null() {
        return Err(err!(
            "The Typst compiler returned nothing at all."; Invalid, Data));
    }
    if let Ok(msg) = js_sys::Reflect::get(v, &JsValue::from_str("error")) {
        if let Some(text) = msg.as_string() {
            if !text.trim().is_empty() {
                return Err(err!("{}", text; Invalid, Data));
            }
        }
    }
    let pdf = res!(js_sys::Reflect::get(v, &JsValue::from_str("pdf"))
        .map_err(|e| err!(
            "Reading the compiled PDF failed: {}.", refusal(&e); Invalid, Data)));
    if pdf.is_undefined() || pdf.is_null() {
        return Err(err!(
            "The Typst compiler reported neither a PDF nor an error."; Invalid, Data));
    }
    let arr = res!(pdf.dyn_into::<js_sys::Uint8Array>()
        .map_err(|_| err!(
            "The Typst compiler returned a PDF that is not a byte array."; Invalid, Data)));
    let out = arr.to_vec();
    if out.len() < 5 {
        return Err(err!(
            "The Typst compiler returned {} bytes, which is not a PDF.", out.len();
            Invalid, Data));
    }
    Ok(out)
}

/// Compile `source` to PDF bytes in the browser.
///
/// # Arguments
/// * `source` - The whole Typst document, self-contained: the compiler has a
///   dummy access model, so it can read no file and reach no package.
pub async fn compile(source: &str) -> Outcome<Vec<u8>> {
    let d = res!(driver());
    match JsFuture::from(d.compile(source)).await {
        Ok(v)  => bytes_of(&v),
        Err(e) => Err(err!("{}", refusal(&e); Invalid, Data)),
    }
}
