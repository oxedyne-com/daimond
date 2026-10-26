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
use crate::wasm::refusal;

use oxedyne_fe2o3_core::prelude::*;

use wasm_bindgen::prelude::wasm_bindgen;
use wasm_bindgen::{JsCast, JsValue};


#[wasm_bindgen]
extern "C" {

    /// The driver object `www/js/ocr.js` installs at `window.DaimondOcr`.
    #[wasm_bindgen(js_name = DaimondOcr)]
    type Driver;

    /// POST one `file-parser` chat body to OpenRouter; resolve the raw response text.
    #[wasm_bindgen(catch, method)]
    fn chat(this: &Driver, body: &str) -> Result<JsValue, JsValue>;

    /// Transcribe an image: try Mistral OCR, fall back to a vision model.  Resolves a JSON
    /// string `{"route":"mistral"|"vision","body":<raw response>}`.
    #[wasm_bindgen(catch, method)]
    fn image(this: &Driver, mistral_body: &str, vision_body: &str) -> Result<JsValue, JsValue>;

    /// The "Image editing" model: resolves a JSON string `{"id":…,"price":…}` (UNBLOCK-9).
    #[wasm_bindgen(catch, method, js_name = imageModel)]
    fn image_model(this: &Driver) -> Result<JsValue, JsValue>;

    /// POST one Image API body to OpenRouter's `/images`; resolve the raw response text.
    #[wasm_bindgen(catch, method)]
    fn images(this: &Driver, body: &str) -> Result<JsValue, JsValue>;
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

/// POST a `file-parser` chat body to OpenRouter and return the raw response body.
pub async fn openrouter_chat(body: &str) -> Outcome<String> {
    let d = res!(driver());
    match crate::wasm::settle_call(d.chat(body)).await {
        Ok(v)  => Ok(v.as_string().unwrap_or_default()),
        Err(e) => Err(err!("{}", refusal(&e); IO, Invalid)),
    }
}

/// Transcribe an image, returning `(route, raw_response_body)` where `route` is `"mistral"` or
/// `"vision"` so the caller parses the body in the right shape.
pub async fn image_ocr(mistral_body: &str, vision_body: &str) -> Outcome<(String, String)> {
    let d = res!(driver());
    let v = match crate::wasm::settle_call(d.image(mistral_body, vision_body)).await {
        Ok(v)  => v.as_string().unwrap_or_default(),
        Err(e) => return Err(err!("{}", refusal(&e); IO, Invalid)),
    };
    let route = extract_json_string(&v, "route").unwrap_or_default();
    let body  = extract_json_string(&v, "body").unwrap_or_default();
    Ok((route, body))
}

/// The account's "Image editing" model and its catalogue price, as `models.js` computes it.
pub async fn image_model() -> Outcome<crate::image_edit::ImageModel> {
    let d = res!(driver());
    let v = match crate::wasm::settle_call(d.image_model()).await {
        Ok(v)  => v.as_string().unwrap_or_default(),
        Err(e) => return Err(err!("{}", refusal(&e); IO, Invalid)),
    };
    Ok(crate::image_edit::ImageModel {
        id:    extract_json_string(&v, "id").unwrap_or_default(),
        price: extract_json_string(&v, "price").unwrap_or_default(),
    })
}

/// POST an Image API body to OpenRouter and return the raw response body.
pub async fn openrouter_images(body: &str) -> Outcome<String> {
    let d = res!(driver());
    match crate::wasm::settle_call(d.images(body)).await {
        Ok(v)  => Ok(v.as_string().unwrap_or_default()),
        Err(e) => Err(err!("{}", refusal(&e); IO, Invalid)),
    }
}
