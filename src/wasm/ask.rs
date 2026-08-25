//! The question card's edge — a thin binding to the JS driver `window.DaimondAsk`.
//!
//! WHY THIS MODULE EXISTS, WHICH IS NOT WHAT IT DOES.  Of the seven things the owner types at a
//! session every day, six could be typed at Daimond and one could not: a model had no way to put
//! a decision to him with options he could tap.  It could write a question in prose and stop,
//! which is a question answered by TYPING — and a decision answered by typing is a decision put
//! off.  [`crate::tools::Tool::FileShow`]'s rule again, arriving at the most-used interaction in
//! a working session rather than at a file: a thing a person does every day that the model has no
//! way to reach is a thing the model will eventually deny is possible.
//!
//! **THE DRIVER IS HANDED A QUESTION AND HANDS BACK NOTHING BUT WHETHER IT DREW ONE.**  It does
//! not wait for the answer and there is no promise on this side holding a turn open.  That is the
//! whole difference between this and `parkConsent`, which parks a worker's consent question on the
//! Pending panel and holds the `resolve` of a promise in memory: a promise does not survive a
//! reload, so those tiles are marked expired when the page comes back and the tick is disabled.
//! A question here is drawn from the tool call's own arguments, exactly as `renderSaid` draws a
//! stored fold, so a reload redraws it with working buttons — because answering is only sending a
//! message, and a message needs nothing left over from the turn that asked.
//!
//! What comes back is therefore one fact: was a card drawn.  A page with no driver in it must
//! fail loudly rather than let the model report a question nobody can see.

use crate::llm::extract_json_bool;
use crate::wasm::js_str;

use oxedyne_fe2o3_core::prelude::*;

use wasm_bindgen::prelude::wasm_bindgen;
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;


#[wasm_bindgen]
extern "C" {

    /// The driver object `www/js/daimond.js` installs at `window.DaimondAsk`.
    #[wasm_bindgen(js_name = DaimondAsk)]
    type Asker;

    /// Draw one question in the conversation, and answer whether it was drawn.
    #[wasm_bindgen(method)]
    fn put(this: &Asker, payload: &str) -> js_sys::Promise;
}


/// Reach the driver object on `window`, or refuse in the model's language.
fn asker() -> Outcome<Asker> {
    let win = res!(web_sys::window()
        .ok_or_else(|| err!("Putting a question needs a browser window."; System, Missing)));
    let obj = res!(js_sys::Reflect::get(&win, &JsValue::from_str("DaimondAsk"))
        .map_err(|e| err!("Reading window.DaimondAsk failed: {}.", js_str(&e); System, Missing)));
    if obj.is_undefined() || obj.is_null() {
        return Err(err!(
            "This page cannot draw a question card, so nobody would see one. Ask in prose \
            instead, giving the options, your recommendation and the reason for it.";
            System, Missing));
    }
    Ok(obj.unchecked_into::<Asker>())
}

/// The `message` of a rejected JS `Error`, verbatim.  A refusal from the driver is written for
/// the model to read and act on, so nothing here rewords it.
fn refusal(e: &JsValue) -> String {
    match js_sys::Reflect::get(e, &JsValue::from_str("message")) {
        Ok(m)  => m.as_string().unwrap_or_else(|| js_str(e)),
        Err(_) => js_str(e),
    }
}

/// Put one question on the screen, and say nothing about the answer.
///
/// # Arguments
/// * `payload` - The checked question as `ask_step` composed it, as JSON.
pub async fn put(payload: &str) -> Outcome<()> {
    let a = res!(asker());
    let v = match JsFuture::from(a.put(payload)).await {
        Ok(v)  => v,
        Err(e) => return Err(err!("{}", refusal(&e); IO, Invalid)),
    };
    let json = match v.as_string() {
        Some(s) => s,
        None    => match js_sys::JSON::stringify(&v) {
            Ok(s)  => String::from(s),
            Err(_) => return Err(err!(
                "The page answered with something that cannot be read, so whether the user can \
                see the question is unknown. Do not tell them you have asked."; Invalid, Data)),
        },
    };
    // Absent means NOT drawn, which is the opposite of `doc::show`'s reading of a missing field
    // and deliberately so: a show that predates its own `shown` field really did show something,
    // while a page that says nothing here has said nothing about a card the model is about to
    // claim is on screen.
    if !extract_json_bool(&json, "drawn").unwrap_or(false) {
        return Err(err!(
            "The page did not draw the question, so there is nothing on screen to tap. Ask in \
            prose instead, giving the options, your recommendation and the reason for it.";
            IO, Invalid));
    }
    Ok(())
}
