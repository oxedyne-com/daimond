//! The held delete's edge -- a thin binding to the JS driver `window.DaimondDeletes`.
//!
//! Built 2026-09-23 for review items (b) and (c) of the delete unit: a turn's deletes from the
//! folder the user opened on this computer stop after a handful, and the PERSON is asked whether
//! it may go on.  Since the re-check that evening (R4) the same count holds a turn's writes there
//! that leave less than half of a file, and the question names which of the two the turn wants
//! next.  The question is put with the page's own confirm dialog directly, never through the
//! permission door (`egressAllowed`), because that door answers for an unattended turn under the
//! autonomous posture -- and whether a model may go on deleting a person's files is the one
//! question no posture answers for them.  The machine hand's held command is asked the same way,
//! for the same reason.

use crate::llm::json_escape;

use oxedyne_fe2o3_core::prelude::*;

use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;


/// The global the page installs to ask the person about a held delete.
const DELETES_GLOBAL: &str = "DaimondDeletes";

/// Ask the person whether a turn keeping into `keeper`'s store may go on deleting in the folder
/// they opened -- or wiping, writing over a file so that less than half of it is left -- having
/// done that to `count` files there already, and answer true only on their yes.
///
/// **Everything but a yes is a stop**: no page to ask, a page that cannot ask, a question nobody
/// answered before the dialog's own deadline, a thrown error.  A delete held for a person who
/// never saw the question must not go ahead.
///
/// # Arguments
/// * `keeper` - The Diamond's id, or `chat:<id>`, whose turn is asking.
/// * `path` - The file it wants to delete or wipe next, workspace-relative.
/// * `count` - How many it has deleted or wiped there this turn.
/// * `limit` - How many a turn may do that to there before the person is asked.
/// * `act` - What it wants to do to `path`: `delete` or `wipe`.
pub async fn ask_to_go_on(keeper: &str, path: &str, count: usize, limit: usize, act: &str) -> bool {
    let win = match web_sys::window() {
        Some(w) => w,
        None    => return false,
    };
    let driver = match js_sys::Reflect::get(&win, &JsValue::from_str(DELETES_GLOBAL)) {
        Ok(v) if v.is_object() => v,
        _                      => return false,
    };
    let held = match js_sys::Reflect::get(&driver, &JsValue::from_str("held")) {
        Ok(f) if f.is_function() => f.unchecked_into::<js_sys::Function>(),
        _                        => return false,
    };
    let payload = fmt!(
        "{{\"keeper\":\"{}\",\"path\":\"{}\",\"count\":{},\"limit\":{},\"act\":\"{}\"}}",
        json_escape(keeper), json_escape(path), count, limit, json_escape(act));
    let ret = match held.call1(&driver, &JsValue::from_str(&payload)) {
        Ok(v)  => v,
        Err(_) => return false,
    };
    let answer = match ret.dyn_into::<js_sys::Promise>() {
        Ok(p)  => match JsFuture::from(p).await {
            Ok(v)  => v,
            Err(_) => return false,
        },
        Err(v) => v,
    };
    answer.as_bool() == Some(true)
}
