//! The Mail panel's edge — a thin binding to the JS driver `window.DaimondMail`.
//!
//! WHAT THIS SIDE OWNS AND WHAT THE PANEL OWNS.  The mailbox is the panel's: which accounts
//! are configured, which folder is on screen, the Maildir layout on disk and the drafts a
//! person is about to send all live in `www/js/mail.js`, and asking it for them is asking the
//! one thing that knows.  What Rust adds is the READING of a message and the BUILDING of a
//! draft: [`crate::wasm::mail`] hands raw bytes to [`oxedyne_fe2o3_mail::message`] to parse,
//! and hands its built bytes back to the panel to file.  So the parser and the draft builder
//! are exercised in one tested place -- the fe2o3 crate -- rather than written a second time
//! here in a second language.
//!
//! THERE IS NO SEND ON THIS EDGE, AND THERE IS NONE ON THE PANEL A MODEL CAN REACH.  A draft
//! is written to `mail/<address>/drafts/<id>.eml`, which is exactly where the human panel
//! reads the drafts a person reviews and sends; the one path to the wire is `sendDraft`, and
//! it runs only when a person presses Send (see the header of `www/js/mail.js`).  Nothing
//! here, and nothing the model calls, reaches it.

use crate::llm::extract_json_string;
use crate::wasm::js_str;

use oxedyne_fe2o3_core::prelude::*;
use oxedyne_fe2o3_text::base64;

use wasm_bindgen::prelude::wasm_bindgen;
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;


#[wasm_bindgen]
extern "C" {

    /// The driver object `www/js/mail.js` installs at `window.DaimondMail`.
    #[wasm_bindgen(js_name = DaimondMail)]
    type Panel;

    /// List the mailboxes, their folders and a folder's recent messages, as model-ready text.
    #[wasm_bindgen(method, js_name = toolList)]
    fn tool_list(this: &Panel, req: &str) -> js_sys::Promise;

    /// Find messages in a folder whose sender or subject matches, as model-ready text.
    #[wasm_bindgen(method, js_name = toolSearch)]
    fn tool_search(this: &Panel, req: &str) -> js_sys::Promise;

    /// Hand back one message's raw bytes, base64 in a JSON envelope, for Rust to parse.
    #[wasm_bindgen(method, js_name = toolReadRaw)]
    fn tool_read_raw(this: &Panel, req: &str) -> js_sys::Promise;

    /// File an already-built draft into the drafts folder the user's Send button reads.
    #[wasm_bindgen(method, js_name = putDraftRaw)]
    fn put_draft_raw(this: &Panel, req: &str) -> js_sys::Promise;

    /// The address of a mailbox to draft from -- the named one, or the selected one -- or the
    /// empty string when no mailbox is configured.
    #[wasm_bindgen(method, js_name = toolSender)]
    fn tool_sender(this: &Panel, req: &str) -> js_sys::Promise;
}


/// What came back from asking the panel for one message's bytes.
///
/// A refusal is an ANSWER and not an error, exactly as it is for the Social panel: no such
/// mailbox, no such message, nothing synced -- each is something the model can act on and
/// must read in its own language, so it comes back as a sentence to relay rather than as an
/// `Err` the dispatcher would dress in a failure line.
#[derive(Clone, Debug)]
pub enum Read {
    Bytes(Vec<u8>),
    Refused(String),
}

/// Reach the driver object on `window`, or refuse in the model's language.
fn panel() -> Outcome<Panel> {
    let win = res!(web_sys::window()
        .ok_or_else(|| err!("Reaching the Mail panel needs a browser window."; System, Missing)));
    let obj = res!(js_sys::Reflect::get(&win, &JsValue::from_str("DaimondMail"))
        .map_err(|e| err!("Reading window.DaimondMail failed: {}.", js_str(&e); System, Missing)));
    if obj.is_undefined() || obj.is_null() {
        return Err(err!(
            "Daimond's Mail panel is not loaded in this page. Tell the user what you wanted to \
            read or draft there, and carry on without it."; System, Missing));
    }
    Ok(obj.unchecked_into::<Panel>())
}

/// The `message` of a rejected JS `Error`, verbatim.  A refusal from the driver is written
/// for the model to read, so nothing here rewords it.
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
            "The Mail panel answered with something that cannot be read, so what it did is \
            unknown. Do not tell the user it worked."; Invalid, Data)),
    }
}

/// List the mailboxes and a folder's recent messages.
///
/// # Arguments
/// * `req` - The raw `mail_list` arguments, passed straight to the panel.
pub async fn list(req: &str) -> Outcome<String> {
    let p = res!(panel());
    text(p.tool_list(req)).await
}

/// Find messages in a folder by sender or subject.
///
/// # Arguments
/// * `req` - The raw `mail_search` arguments, passed straight to the panel.
pub async fn search(req: &str) -> Outcome<String> {
    let p = res!(panel());
    text(p.tool_search(req)).await
}

/// Fetch one message's bytes for the caller to parse, or a refusal to relay.
///
/// # Arguments
/// * `req` - The raw `mail_read` arguments: which mailbox, folder and uid, or a path.
pub async fn read_raw(req: &str) -> Outcome<Read> {
    let p = res!(panel());
    let json = res!(text(p.tool_read_raw(req)).await);
    if let Some(no) = extract_json_string(&json, "error") {
        if !no.trim().is_empty() {
            return Ok(Read::Refused(no));
        }
    }
    match extract_json_string(&json, "raw_b64") {
        Some(b) if !b.trim().is_empty() => {
            let cleaned: String = b.chars().filter(|c| !c.is_whitespace()).collect();
            Ok(Read::Bytes(res!(base64::decode(&cleaned))))
        },
        _ => Err(err!(
            "The Mail panel returned no message bytes, so there is nothing to read. Do not \
            tell the user what it said."; Invalid, Data)),
    }
}

/// File a built draft into the mailbox's drafts folder, for a person to review and send.
///
/// # Arguments
/// * `req` - A JSON object of `address` (which mailbox) and `raw_b64` (the built bytes).
pub async fn put_draft(req: &str) -> Outcome<String> {
    let p = res!(panel());
    text(p.put_draft_raw(req)).await
}

/// The address a draft should be sent from when the model named none: the selected mailbox,
/// or empty when there is none.
///
/// # Arguments
/// * `req` - A JSON object; an `address` in it names a mailbox to confirm, else the panel's
///   selected one is returned.
pub async fn sender(req: &str) -> Outcome<String> {
    let p = res!(panel());
    text(p.tool_sender(req)).await
}
