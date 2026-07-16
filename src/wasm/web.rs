//! The Web panel edge — thin bindings to the JS driver `window.DaimondWeb`.
//!
//! `DaimondWeb` is the one interface the agent's web tools call, and it
//! hides which driver is attached (none, an iframe, or the Daimond Hands
//! extension), so the tools do not change when the extension appears.
//! Every method returns a `Promise`; each binding below awaits it and
//! hands back the resolved JSON, stringified.
//!
//! A rejection carries a plain-English `Error` the model is meant to read
//! and act on ("No page is open. Call web_open first."), so its `message`
//! is passed through **verbatim**: no prefix, no rewording.  Mangling it
//! would destroy the only instruction the model gets about what to do
//! next.

use crate::wasm::js_str;

use oxedyne_fe2o3_core::prelude::*;

use wasm_bindgen::prelude::wasm_bindgen;
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;


#[wasm_bindgen]
extern "C" {

    /// The driver object the Web panel installs at `window.DaimondWeb`.
    #[wasm_bindgen(js_name = DaimondWeb)]
    type Driver;

    /// Which driver is attached, what is open, and who is driving.
    #[wasm_bindgen(method)]
    fn status(this: &Driver) -> js_sys::Promise;

    /// Dock the panel and navigate it to `url`.
    #[wasm_bindgen(method)]
    fn open(this: &Driver, url: &str) -> js_sys::Promise;

    /// Read `url` through the gateway, without a driver.
    #[wasm_bindgen(method)]
    fn fetch(this: &Driver, url: &str) -> js_sys::Promise;

    /// The accessibility tree of the open page.
    #[wasm_bindgen(method)]
    fn snapshot(this: &Driver) -> js_sys::Promise;

    /// The rendered text of the open page.
    #[wasm_bindgen(method)]
    fn read(this: &Driver) -> js_sys::Promise;

    /// Click the node named by `node_ref`.
    #[wasm_bindgen(method)]
    fn click(this: &Driver, node_ref: u32) -> js_sys::Promise;

    /// Type into the node named by `node_ref` (`type` is a Rust keyword).
    #[wasm_bindgen(method, js_name = "type")]
    fn type_into(this: &Driver, node_ref: u32, text: &str, submit: bool) -> js_sys::Promise;

    /// Scroll the open page; `amount` may be `undefined` for the default.
    #[wasm_bindgen(method)]
    fn scroll(this: &Driver, dir: &str, amount: JsValue) -> js_sys::Promise;

    /// Undock the panel and drop the page.
    #[wasm_bindgen(method)]
    fn close(this: &Driver) -> js_sys::Promise;
}


/// Reach the driver object on `window`, or refuse in the model's language.
fn driver() -> Outcome<Driver> {
    let win = res!(web_sys::window()
        .ok_or_else(|| err!("The web tools need a browser window."; System, Missing)));
    let obj = res!(js_sys::Reflect::get(&win, &JsValue::from_str("DaimondWeb"))
        .map_err(|e| err!("Reading window.DaimondWeb failed: {}.", js_str(&e); System, Missing)));
    if obj.is_undefined() || obj.is_null() {
        return Err(err!(
            "The Web panel is not loaded in this page, so there is nothing to drive. \
            Tell the user, and carry on without the web tools.";
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

/// Render a resolved JS value as the JSON string the tool result carries.
fn stringify(v: &JsValue) -> Outcome<String> {
    if v.is_undefined() || v.is_null() {
        return Ok("{}".to_string());
    }
    if let Some(s) = v.as_string() {
        return Ok(s); // the driver resolved with JSON already
    }
    match js_sys::JSON::stringify(v) {
        Ok(s)  => Ok(String::from(s)),
        Err(e) => Err(err!(
            "The Web panel returned a result that cannot be read: {}.", refusal(&e);
            Invalid, Data)),
    }
}

/// Await a driver promise, passing a refusal through untouched.
async fn settle(promise: js_sys::Promise) -> Outcome<String> {
    match JsFuture::from(promise).await {
        Ok(v)  => stringify(&v),
        Err(e) => Err(err!("{}", refusal(&e); Network, Invalid)),
    }
}

/// Which driver is attached, what is open, and who is driving.
pub async fn status() -> Outcome<String> {
    let d = res!(driver());
    settle(d.status()).await
}

/// Show `url` in the Web panel.
pub async fn open(url: &str) -> Outcome<String> {
    let d = res!(driver());
    settle(d.open(url)).await
}

/// Read `url` through the gateway, driver or no driver.
pub async fn fetch(url: &str) -> Outcome<String> {
    let d = res!(driver());
    settle(d.fetch(url)).await
}

/// The accessibility tree of the open page, whose refs the actions take.
pub async fn snapshot() -> Outcome<String> {
    let d = res!(driver());
    settle(d.snapshot()).await
}

/// The rendered text of the open page -- the way to READ its content.
pub async fn read() -> Outcome<String> {
    let d = res!(driver());
    settle(d.read()).await
}

/// Click the node named by `node_ref` from the latest snapshot.
pub async fn click(node_ref: u32) -> Outcome<String> {
    let d = res!(driver());
    settle(d.click(node_ref)).await
}

/// Type `text` into the node named by `node_ref`, optionally submitting.
pub async fn type_into(node_ref: u32, text: &str, submit: bool) -> Outcome<String> {
    let d = res!(driver());
    settle(d.type_into(node_ref, text, submit)).await
}

/// Scroll the open page, leaving `amount` to the driver when unset.
pub async fn scroll(dir: &str, amount: Option<u32>) -> Outcome<String> {
    let d = res!(driver());
    let amt = match amount {
        Some(n) => JsValue::from_f64(n as f64),
        None    => JsValue::UNDEFINED,
    };
    settle(d.scroll(dir, amt)).await
}

/// Close the Web panel and drop the page.
pub async fn close() -> Outcome<String> {
    let d = res!(driver());
    settle(d.close()).await
}
