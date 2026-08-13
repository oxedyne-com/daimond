//! The document panel's edge — a thin binding to the JS driver `window.DaimondDoc`.
//!
//! WHY THIS MODULE EXISTS, WHICH IS NOT THE SAME AS WHAT IT DOES.  Asked to compile a Typst
//! source and display the PDF, a daimon answered:
//!
//! > I do see a pre-existing thinking.pdf (1.08 MB) ... but I cannot display a PDF inline here
//! > — the file tools return raw bytes for it rather than a rendered view.
//!
//! Every clause of that is true about its TOOLBOX and false about Daimond.  `www/js/viewer.js`
//! has handed `application/pdf` to the browser's own document viewer since the `doc` tier was
//! written, with the security argument for doing so measured and recorded beside it.  What was
//! missing was a way for the model to SAY SO: it held eleven tools that return bytes and none
//! that put a file in front of a person, so it reasoned from the toolbox to a limitation of the
//! app, reported that limitation to the user, and spent the turn apologising for it.
//!
//! A working surface the model cannot reach is a surface the model will deny.
//!
//! **The driver is handed a PATH and never bytes.**  A view given content is a snapshot: when the
//! file is written again -- a recompile, a rebuild -- there is nowhere for the new bytes to land,
//! and the only way to refresh it is to build a second view.  A view that names a workspace file
//! reads that file whenever it is drawn, so showing the same path again is the whole of how a
//! rebuilt document reaches the reader.
//!
//! The driver resolves with `viewer.js`'s own verdict about what it drew.  Composing that
//! sentence from a table here instead would put a second opinion about which formats have a
//! viewer into a second language, and the two would disagree the first time a format moved tier.

use crate::llm::{
    extract_json_bool,
    extract_json_number,
    extract_json_string,
};
use crate::tools::Shown;
use crate::wasm::js_str;

use oxedyne_fe2o3_core::prelude::*;

use wasm_bindgen::prelude::wasm_bindgen;
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;


#[wasm_bindgen]
extern "C" {

    /// The driver object `www/js/viewer.js` installs at `window.DaimondDoc`.
    #[wasm_bindgen(js_name = DaimondDoc)]
    type Panel;

    /// Put a workspace file in the document panel, at `page` for a paged format.
    ///
    /// `page` is a `JsValue` so it can be `undefined`, which is the driver's word for "the top"
    /// and is not the same as page 1 asked for deliberately.
    #[wasm_bindgen(method)]
    fn show(this: &Panel, path: &str, page: JsValue) -> js_sys::Promise;
}


/// Reach the driver object on `window`, or refuse in the model's language.
fn panel() -> Outcome<Panel> {
    let win = res!(web_sys::window()
        .ok_or_else(|| err!("Showing a file needs a browser window."; System, Missing)));
    let obj = res!(js_sys::Reflect::get(&win, &JsValue::from_str("DaimondDoc"))
        .map_err(|e| err!("Reading window.DaimondDoc failed: {}.", js_str(&e); System, Missing)));
    if obj.is_undefined() || obj.is_null() {
        return Err(err!(
            "Daimond's document panel is not loaded in this page, so there is nothing to show a \
            file in. Tell the user, and describe what you would have shown them instead.";
            System, Missing));
    }
    Ok(obj.unchecked_into::<Panel>())
}

/// The `message` of a rejected JS `Error`, verbatim.  A refusal from the driver is written for
/// the model to read and act on, so nothing here rewords it.
fn refusal(e: &JsValue) -> String {
    match js_sys::Reflect::get(e, &JsValue::from_str("message")) {
        Ok(m)  => m.as_string().unwrap_or_else(|| js_str(e)),
        Err(_) => js_str(e),
    }
}

/// Show `path` in the document panel, and report what the user is now looking at.
///
/// # Arguments
/// * `path` - The workspace-relative path, already scoped and already checked by the guard.
/// * `page` - Which page to open a paged document at, or `None` for the top.
pub async fn show(path: &str, page: Option<u32>) -> Outcome<Shown> {
    let p = res!(panel());
    let at = match page {
        Some(n) => JsValue::from_f64(n as f64),
        None    => JsValue::UNDEFINED,
    };
    let v = match JsFuture::from(p.show(path, at)).await {
        Ok(v)  => v,
        Err(e) => return Err(err!("{}", refusal(&e); IO, Invalid)),
    };
    let json = match v.as_string() {
        Some(s) => s,
        None    => match js_sys::JSON::stringify(&v) {
            Ok(s)  => String::from(s),
            Err(_) => return Err(err!(
                "The document panel answered with something that cannot be read, so what it drew \
                is unknown. Do not tell the user what they are looking at."; Invalid, Data)),
        },
    };
    // A verdict with no tier in it is not a verdict.  Reporting it as a successful show would have
    // the model describe a screen nothing has said anything about.
    let tier = match extract_json_string(&json, "tier") {
        Some(t) if !t.trim().is_empty() => t,
        _ => return Err(err!(
            "The document panel did not say what it drew, so what the user is looking at is \
            unknown."; Invalid, Data)),
    };
    Ok(Shown {
        tier,
        media:    extract_json_string(&json, "media").unwrap_or_default(),
        label:    extract_json_string(&json, "label").unwrap_or_default(),
        size:     extract_json_number(&json, "size").unwrap_or(0),
        // The panel's answer and not the argument above: a show with no page named leaves a
        // document where it was last aimed, so these two differ on every re-show.
        page:     match extract_json_number(&json, "page") {
            Some(n) if n > 0 => Some(n as u32),
            _                => None,
        },
        disagree: extract_json_bool(&json, "disagree").unwrap_or(false),
        named:    extract_json_string(&json, "named").unwrap_or_default(),
        found:    extract_json_string(&json, "found").unwrap_or_default(),
    })
}
