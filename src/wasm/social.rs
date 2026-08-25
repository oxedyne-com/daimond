//! The Social panel's edge — a thin binding to the JS driver `window.DaimondSocial`.
//!
//! WHY THIS MODULE EXISTS, WHICH IS NOT WHAT IT DOES.  On 2026-08-24 two real daimons, on two
//! accounts and two different models, were each asked to do one side of the Social panel's work.
//! Neither could reach it, and neither said so: one told its user to go and find "Daimond's
//! feedback/issue reporting interface (typically accessible from a menu in the app)", which is
//! the panel it had just failed to find, and the other spent eighteen calls and finished with
//! "The gateway isn't running."  The gateway was running.  The rule they broke is
//! [`crate::tools::Tool::FileShow`]'s, and it is stated there as a defect class rather than a
//! feature: a working surface the model cannot reach is a surface the model will deny.
//!
//! **THE PANEL COMPOSES THE PROSE ABOUT RECORDS AND THIS SIDE COMPOSES THE POLICY.**  Which
//! proposals exist, what state each is in, what its tally is and what a note's sealed build
//! identifier is are all the panel's answers, drawn on a screen the user is looking at; a second
//! renderer here would be a second opinion in a second language, disagreeing with that screen the
//! first time either changed.  It is the same argument [`crate::tools::Shown`] is written under.
//! What Rust keeps is every refusal and the consent question, because those are the sentences
//! that decide something.
//!
//! **CONSENT IS BOUND TO BYTES AND NOT TO ARGUMENTS**, which is why publishing is two calls and
//! not one.  [`compose`] asks the panel what would actually leave and hands back both the
//! characters the user is shown and an opaque token standing for them; [`commit`] sends what that
//! token holds.  Composing once and sending the arguments again afterwards would mean the user
//! approved a rendering and the app sent a rebuild of it, and the two part company at exactly the
//! field a person would want to have seen -- the build identifier that travels with a note, the
//! title of the proposal a vote lands on.

use crate::llm::extract_json_string;
use crate::wasm::js_str;

use oxedyne_fe2o3_core::prelude::*;

use wasm_bindgen::prelude::wasm_bindgen;
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;


#[wasm_bindgen]
extern "C" {

    /// The driver object `www/js/improve.js` installs at `window.DaimondSocial`.
    #[wasm_bindgen(js_name = DaimondSocial)]
    type Panel;

    /// Read one view of the panel, and answer with the text a model reads.
    #[wasm_bindgen(method)]
    fn read(this: &Panel, req: &str) -> js_sys::Promise;

    /// Work out exactly what one act would put on the wire, without sending any of it.
    #[wasm_bindgen(method)]
    fn compose(this: &Panel, req: &str) -> js_sys::Promise;

    /// Send what a `compose` composed, named by the token it minted for it.
    #[wasm_bindgen(method)]
    fn commit(this: &Panel, token: &str) -> js_sys::Promise;
}


/// What came back from asking the panel what one act would publish.
///
/// A refusal is an ANSWER and not an error.  Every reason a compose can fail -- no voice on the
/// forge, a proposal number that is not there, an act this build does not have -- is something
/// the model can act on and must be told in its own language, so it comes back as a sentence to
/// hand over rather than as an `Err` the dispatcher would dress in a failure line.
#[derive(Clone, Debug)]
pub enum Composed {
    // Ready to put to the user.  `token` is opaque on this side on purpose: Rust must not be
    // able to assemble one, or the binding between what was seen and what is sent is a
    // convention rather than a mechanism.
    Draft {
        shown: String,	// exactly what the user is shown
        token: String,	// the panel's handle on the payload those characters describe
    },
    Refused(String),	// nothing was composed, and this is what the model reads instead
}

/// Reach the driver object on `window`, or refuse in the model's language.
fn panel() -> Outcome<Panel> {
    let win = res!(web_sys::window()
        .ok_or_else(|| err!("Reaching the Social panel needs a browser window."; System, Missing)));
    let obj = res!(js_sys::Reflect::get(&win, &JsValue::from_str("DaimondSocial"))
        .map_err(|e| err!("Reading window.DaimondSocial failed: {}.", js_str(&e); System, Missing)));
    if obj.is_undefined() || obj.is_null() {
        return Err(err!(
            "Daimond's Social panel is not loaded in this page. Tell the user what you wanted to \
            read or publish there, and carry on without it."; System, Missing));
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

/// Settle a driver promise that answers with a string.
async fn text(p: js_sys::Promise) -> Outcome<String> {
    let v = match JsFuture::from(p).await {
        Ok(v)  => v,
        Err(e) => return Err(err!("{}", refusal(&e); IO, Invalid)),
    };
    match v.as_string() {
        Some(s) => Ok(s),
        None    => Err(err!(
            "The Social panel answered with something that cannot be read, so what it did is \
            unknown. Do not tell the user it worked."; Invalid, Data)),
    }
}

/// Read one view, and answer with what the panel says is on it.
///
/// # Arguments
/// * `req` - The request [`crate::tools::social_read_step`] composed.
pub async fn read(req: &str) -> Outcome<String> {
    let p = res!(panel());
    text(p.read(req)).await
}

/// Ask what one act would publish, without publishing any of it.
///
/// # Arguments
/// * `req` - The request [`crate::tools::social_send_step`] composed.
pub async fn compose(req: &str) -> Outcome<Composed> {
    let p = res!(panel());
    let json = res!(text(p.compose(req)).await);
    if let Some(no) = extract_json_string(&json, "refusal") {
        if !no.trim().is_empty() {
            return Ok(Composed::Refused(no));
        }
    }
    // Neither field may be empty and neither is optional.  A draft with nothing to show would
    // put an empty dialog in front of the user, who would then be approving a blank -- and a
    // draft with no token would be a yes with nothing to spend it on.
    let shown = match extract_json_string(&json, "shown") {
        Some(s) if !s.trim().is_empty() => s,
        _ => return Err(err!(
            "The Social panel did not say what it would publish, so there is nothing to put to \
            the user. Nothing was sent."; Invalid, Data)),
    };
    let token = match extract_json_string(&json, "token") {
        Some(t) if !t.trim().is_empty() => t,
        _ => return Err(err!(
            "The Social panel composed something and would not name it, so there is no way to \
            send exactly what the user would have approved. Nothing was sent."; Invalid, Data)),
    };
    Ok(Composed::Draft { shown, token })
}

/// Publish what a [`compose`] composed.
///
/// # Arguments
/// * `token` - The handle the panel minted for that draft, and no other.
pub async fn commit(token: &str) -> Outcome<String> {
    let p = res!(panel());
    text(p.commit(token)).await
}
