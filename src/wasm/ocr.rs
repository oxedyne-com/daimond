//! `window.DaimondOcr` edge -- the authenticated POSTs that turn a PDF or an image into text.
//!
//! A thin binding, like `doc.rs`: the JS driver in `www/js/ocr.js` owns the provider keys and
//! the two endpoints (OpenRouter's `file-parser` chat for PDFs, Mistral's `/v1/ocr` for images,
//! with a vision model as the image fallback), and this side hands it a request body and reads
//! back the raw response.  The DECISIONS that matter -- which engine, is the text empty, what did
//! it cost -- are made and tested in Rust (`src/tools.rs`); the driver only carries the request.
//!
//! Why the key never crosses this edge: the driver resolves it from `DaimondModels`, which keeps
//! a minted credits key in memory alone and seals a typed one at rest.  A body in and a body out
//! is all that passes, so nothing here has to hold a bearer credential.

use crate::llm::extract_json_string;
use crate::wasm::js_str;

use oxedyne_fe2o3_core::prelude::*;

use wasm_bindgen::prelude::wasm_bindgen;
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;


#[wasm_bindgen]
extern "C" {

    /// The driver object `www/js/ocr.js` installs at `window.DaimondOcr`.
    #[wasm_bindgen(js_name = DaimondOcr)]
    type Driver;

    /// POST one `file-parser` chat body to OpenRouter; resolve the raw response text.
    #[wasm_bindgen(method)]
    fn chat(this: &Driver, body: &str) -> js_sys::Promise;

    /// Transcribe an image: try Mistral OCR, fall back to a vision model.  Resolves a JSON
    /// string `{"route":"mistral"|"vision","body":<raw response>}`.
    #[wasm_bindgen(method)]
    fn image(this: &Driver, mistral_body: &str, vision_body: &str) -> js_sys::Promise;
}


/// Reach the driver on `window`, or refuse in the model's language.
fn driver() -> Outcome<Driver> {
    let win = res!(web_sys::window()
        .ok_or_else(|| err!("Reading text off a file needs a browser window."; System, Missing)));
    let obj = res!(js_sys::Reflect::get(&win, &JsValue::from_str("DaimondOcr"))
        .map_err(|e| err!("Reading window.DaimondOcr failed: {}.", js_str(&e); System, Missing)));
    if obj.is_undefined() || obj.is_null() {
        return Err(err!(
            "Daimond's OCR bridge is not loaded in this page, so a PDF's or a picture's text \
            cannot be read here. Tell the user, and describe the file instead."; System, Missing));
    }
    Ok(obj.unchecked_into::<Driver>())
}

/// The `message` of a rejected JS `Error`, verbatim: the driver writes its refusals for the
/// model to read and act on, so nothing here rewords one.
fn refusal(e: &JsValue) -> String {
    match js_sys::Reflect::get(e, &JsValue::from_str("message")) {
        Ok(m)  => m.as_string().unwrap_or_else(|| js_str(e)),
        Err(_) => js_str(e),
    }
}

/// POST a `file-parser` chat body to OpenRouter and return the raw response body.
pub async fn openrouter_chat(body: &str) -> Outcome<String> {
    let d = res!(driver());
    match JsFuture::from(d.chat(body)).await {
        Ok(v)  => Ok(v.as_string().unwrap_or_default()),
        Err(e) => Err(err!("{}", refusal(&e); IO, Invalid)),
    }
}

/// Transcribe an image, returning `(route, raw_response_body)` where `route` is `"mistral"` or
/// `"vision"` so the caller parses the body in the right shape.
pub async fn image_ocr(mistral_body: &str, vision_body: &str) -> Outcome<(String, String)> {
    let d = res!(driver());
    let v = match JsFuture::from(d.image(mistral_body, vision_body)).await {
        Ok(v)  => v.as_string().unwrap_or_default(),
        Err(e) => return Err(err!("{}", refusal(&e); IO, Invalid)),
    };
    let route = extract_json_string(&v, "route").unwrap_or_default();
    let body  = extract_json_string(&v, "body").unwrap_or_default();
    Ok((route, body))
}
