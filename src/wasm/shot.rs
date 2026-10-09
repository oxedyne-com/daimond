//! The self-capture edge — a thin binding to the JS driver `window.DaimondShot`.
//!
//! WHY THIS MODULE EXISTS, WHICH IS NOT WHAT IT DOES. A UI change is not done until the
//! changed page has been looked at (`DAIMOND.md`, "UI changes are seen, not just measured").
//! A daimon may have no vision, so it hands a picture to a worker that has -- and the only
//! way it had to make one was `dev/shot.mjs`, which launches a headless browser. The daimon's
//! shell and its workers are FENCED, and a process that launches Chrome aborts, so the one step
//! the whole vision gate turns on could never run inside the fence.
//!
//! The daimon runs IN a browser, so it need not start one: `www/js/selfshot.js` draws the app's
//! own live DOM to a PNG in the page, through the SVG-`<foreignObject>` route html-to-image uses
//! -- pure browser API, no dependency added. This module is the wasm end of that driver, the same
//! shape as [`crate::wasm::ask`] (`window.DaimondAsk`) and [`crate::wasm::doc`] (`window.DaimondDoc`).
//!
//! THE BYTES COME BACK BASE64, exactly as [`crate::wasm::mail`] carries a message's raw bytes: a
//! canvas's PNG is not UTF-8, so it travels base64 in a JSON envelope and is decoded here. The
//! caller ([`crate::tools::Tool::Capture`]) writes them to the workspace, and the daimon then
//! `file_read`s that path with `"as":"image"` and hands it to a vision worker -- the existing
//! image-handoff path, unchanged.

use crate::llm::{
    extract_json_bool,
    extract_json_number,
    extract_json_string,
};
use crate::wasm::js_str;
use crate::wasm::refusal;

use oxedyne_fe2o3_core::prelude::*;
use oxedyne_fe2o3_text::base64;

use wasm_bindgen::prelude::wasm_bindgen;
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;


#[wasm_bindgen]
extern "C" {

    /// The driver object `www/js/selfshot.js` installs at `window.DaimondShot`.
    #[wasm_bindgen(js_name = DaimondShot)]
    type Shooter;

    /// Photograph the current view, answering a JSON envelope with the PNG base64 in it.
    #[wasm_bindgen(method)]
    fn capture(this: &Shooter, req: &str) -> js_sys::Promise;

    /// The driver the app installs at `window.DaimondVision`: it holds the keys and the ledger,
    /// so the one request to a Diamond's images model is made there.
    #[wasm_bindgen(js_name = DaimondVision)]
    type Looker;

    /// Put one picture to the Diamond's images model; answer a JSON envelope.
    #[wasm_bindgen(method)]
    fn look(this: &Looker, req: &str) -> js_sys::Promise;
}


/// Reach the driver object on `window`, or refuse in the model's language.
fn shooter() -> Outcome<Shooter> {
    let win = res!(web_sys::window()
        .ok_or_else(|| err!("Photographing the view needs a browser window."; System, Missing)));
    let obj = res!(js_sys::Reflect::get(&win, &JsValue::from_str("DaimondShot"))
        .map_err(|e| err!("Reading window.DaimondShot failed: {}.", js_str(&e); System, Missing)));
    if obj.is_undefined() || obj.is_null() {
        return Err(err!(
            "This page cannot photograph itself: the self-capture driver is not loaded, which a \
            native build and an old bundle both lack. Describe the change instead, or dispatch a \
            worker that can render the page another way."; System, Missing));
    }
    Ok(obj.unchecked_into::<Shooter>())
}

/// One photograph of the current view: the PNG bytes and the pixel size drawn.
pub struct Shot {
    pub png:   Vec<u8>,
    pub w:     u32,
    pub h:     u32,
    // The text table of a Diamond page's measurement (`in:"crystal"`), else empty; `png` is
    // then empty too when the page measured but could not be drawn, and the table says why.
    pub table: String,
    // The load proof's verdict (`pass` or `FAIL: ...`) when the request asked for one, else empty,
    // and the debug nodes the page showed.
    pub proof: String,
    pub debug: u32,
    // The page's console and the channel's messages, capped and scrubbed by the driver (K3).
    pub trace: String,
}

/// Photograph the view named by `req` and hand back the decoded PNG.
///
/// # Arguments
/// * `req` - The JSON request as [`crate::tools::Tool::Capture`] composed it: a `selector`, and
///   optional `max_w`, `background` and `scale`.
pub async fn capture(req: &str) -> Outcome<Shot> {
    let s = res!(shooter());
    let v = match JsFuture::from(s.capture(req)).await {
        Ok(v)  => v,
        Err(e) => return Err(err!("{}", refusal(&e); IO, Invalid)),
    };
    let json = match v.as_string() {
        Some(s) => s,
        None    => match js_sys::JSON::stringify(&v) {
            Ok(s)  => String::from(s),
            Err(_) => return Err(err!(
                "The page answered the capture with something that cannot be read, so there is no \
                picture to hand on."; Invalid, Data)),
        },
    };
    // A `false` or absent `ok` means the driver drew nothing.  Reporting a picture from it would
    // hand a vision worker an empty file, which is the failure this whole edge exists to end.
    if !extract_json_bool(&json, "ok").unwrap_or(false) {
        return Err(err!(
            "The page did not produce a picture of the view: {}",
            extract_json_string(&json, "error").unwrap_or_else(|| "no reason given".into());
            IO, Invalid));
    }
    let table = extract_json_string(&json, "table").unwrap_or_default();
    let proof = extract_json_string(&json, "proof").unwrap_or_default();
    let debug = extract_json_number(&json, "debug").unwrap_or(0) as u32;
    let trace = extract_json_string(&json, "trace").unwrap_or_default();
    let b64 = match extract_json_string(&json, "png_b64") {
        Some(b) if !b.trim().is_empty() => b,
        // A Diamond page measured without a picture: the table is the answer, and an empty
        // `png` says so.  Without a table the missing picture is still the fault it was.
        _ if !table.trim().is_empty() => return Ok(Shot { png: Vec::new(), w: 0, h: 0, table, proof, debug, trace }),
        _ => return Err(err!(
            "The page said it captured the view but carried no image bytes."; Invalid, Data)),
    };
    let png = res!(base64::decode(&b64));
    let w = extract_json_number(&json, "w").unwrap_or(0) as u32;
    let h = extract_json_number(&json, "h").unwrap_or(0) as u32;
    Ok(Shot { png, w, h, table, proof, debug, trace })
}

/// What the Diamond's images model made of one picture, and what that cost.
pub struct Look {
    pub text:   String,
    pub model:  String,
    pub tokens: u64,
    pub usd:    f64,    // nought when the provider reported no cost
}

/// The outcome of asking the images model to look.
pub enum Looked {
    Seen(Look),
    NoModel,            // none is set for this Diamond, or it is the model that cannot see
    Failed(String),
}

/// Ask the images model of Diamond `id` about a PNG, in the words of `prompt`.
///
/// The request is made by the page, which owns the keys and writes the spend to the ledger under
/// the Diamond, as a dispatched worker's is.  A model that is not set is an answer
/// ([`Looked::NoModel`]), and a request that failed is another; neither is an error, because the
/// caller's table is still good.
pub async fn look(id: &str, png: &[u8], prompt: &str) -> Outcome<Looked> {
    let win = res!(web_sys::window()
        .ok_or_else(|| err!("Looking at a picture needs a browser window."; System, Missing)));
    let obj = res!(js_sys::Reflect::get(&win, &JsValue::from_str("DaimondVision"))
        .map_err(|e| err!("Reading window.DaimondVision failed: {}.", js_str(&e); System, Missing)));
    if obj.is_undefined() || obj.is_null() {
        return Ok(Looked::Failed("this build has no images-model bridge".to_string()));
    }
    let l = obj.unchecked_into::<Looker>();
    let req = fmt!(r#"{{"id":"{}","prompt":"{}","png_b64":"{}"}}"#,
        crate::llm::json_escape(id), crate::llm::json_escape(prompt), base64::encode(png));
    let json = match JsFuture::from(l.look(&req)).await {
        Ok(v)  => v.as_string().unwrap_or_default(),
        Err(e) => return Ok(Looked::Failed(refusal(&e))),
    };
    if extract_json_bool(&json, "none").unwrap_or(false) {
        return Ok(Looked::NoModel);
    }
    if !extract_json_bool(&json, "ok").unwrap_or(false) {
        return Ok(Looked::Failed(
            extract_json_string(&json, "error").unwrap_or_else(|| "no reason given".to_string())));
    }
    Ok(Looked::Seen(Look {
        text:   extract_json_string(&json, "text").unwrap_or_default(),
        model:  extract_json_string(&json, "model").unwrap_or_default(),
        tokens: extract_json_number(&json, "tokens").unwrap_or(0),
        usd:    extract_json_number(&json, "micro_usd").unwrap_or(0) as f64 / 1_000_000.0,
    }))
}
