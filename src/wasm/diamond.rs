//! The tab's half of the Diamond store (d1_plan D1s1).
//!
//! The store itself is [`crate::store::diamond`], built on both targets and re-exported here, so a
//! `crate::wasm::diamond::X` path names what it always named.  What stays here is what only a page
//! has: the browser's JSON parser reading a pack, and the `#[wasm_bindgen]` door the page calls to
//! bring a folder's Diamonds home.

pub use crate::store::diamond::*;

use crate::wasm::{js_prop, js_str};

use oxedyne_fe2o3_core::prelude::*;

use wasm_bindgen::prelude::wasm_bindgen;
use wasm_bindgen::{JsCast, JsValue};

/// Lay down a Diamond export over the Diamond it names; see [`import_diamond_pack`].
pub async fn import_diamond(json: &str, keep_conflict: bool)
    -> Outcome<crate::diamond_pagelog::ImportOutcome>
{
    // The browser's own parser, not a second one written here.  This JSON holds
    // whole files, and a hand-rolled scan would be a second unescaping
    // implementation to keep exactly in step with the first.
    let val = res!(js_sys::JSON::parse(json)
        .map_err(|e| err!("A Diamond export could not be parsed: {}.", js_str(&e); Invalid, Input)));
    import_diamond_pack(json, read_pack(&val), keep_conflict).await
}

/// Join another device's page logs into this Diamond's in place, where neither copy is fresher;
/// see [`union_logs_from_pack`].  `export_json` is that device's export, read by the browser's
/// own parser for the reason [`import_diamond`] gives.
pub async fn union_logs_from(id: &str, export_json: &str)
    -> Outcome<crate::diamond_pagelog::ImportOutcome>
{
    let val = res!(js_sys::JSON::parse(export_json)
        .map_err(|e| err!("A Diamond export could not be parsed: {}.", js_str(&e); Invalid, Input)));
    union_logs_from_pack(id, read_pack(&val)).await
}

/// Open a template as a NEW Diamond, answering its id; see [`import_template_pack`].
pub async fn import_template(json: &str) -> Outcome<String> {
    // The browser's own parser, for the reason `import_diamond` gives: this JSON holds whole files
    // and a hand-rolled scan would be a second unescaping implementation to keep in step.
    let val = res!(js_sys::JSON::parse(json)
        .map_err(|e| err!("A Diamond template could not be parsed: {}.", js_str(&e);
            Invalid, Input)));
    import_template_pack(read_pack(&val)).await
}

/// What a parsed pack holds.  Each part is read as the store would have read it, and a part that
/// will not read is carried to the store as it stands, which refuses it in its own order.
fn read_pack(val: &JsValue) -> Pack {
    Pack {
        id:    js_prop(val, "id"),
        name:  js_prop(val, crate::protocol::PACK_NAME),
        files: pack_files(val),
    }
}

/// The files a pack carries, text and base64 alike, each path checked against the Diamond it is
/// landing in.
///
/// One reader for both doors, so an import and a template import cannot come to disagree about
/// what a pack holds.  A `files` entry that is not a string is skipped rather than refused, which
/// is the tolerance [`crate::protocol::pack_diamond`] promises: a pack may carry things this build
/// does not understand and must still lay down the files it does.
fn pack_files(val: &JsValue) -> Outcome<Vec<(String, Vec<u8>)>> {
    let files_val = res!(js_sys::Reflect::get(val, &JsValue::from_str("files"))
        .map_err(|e| err!("A Diamond export has no files: {}.", js_str(&e); Invalid, Input)));
    let files: js_sys::Object = res!(files_val.dyn_into()
        .map_err(|_| err!("A Diamond export's files were not an object."; Invalid, Input)));

    let mut writes: Vec<(String, Vec<u8>)> = Vec::new();
    for pair in js_sys::Object::entries(&files).iter() {
        let pair: js_sys::Array = match pair.dyn_into() {
            Ok(a)  => a,
            Err(_) => continue,
        };
        let rel = match pair.get(0).as_string() {
            Some(p) => p,
            None    => continue,
        };
        let body = match pair.get(1).as_string() {
            Some(c) => c,
            None    => continue,        // not a string; `files` carries only text
        };
        if !is_safe_rel(&rel) {
            return Err(err!("A Diamond export names '{}', which is not a path inside it.", rel;
                Invalid, Input, Path));
        }
        // Another device's notes are not this one's to adopt, whoever packed them.
        if device_local(&rel) {
            continue;
        }
        writes.push((rel, body.into_bytes()));
    }
    // The pictures, the fonts, the compiled PDFs -- everything that is not text. A pack from a build
    // that predates them simply has no `binary`, and lands as it always did.
    if let Ok(blobs) = js_sys::Reflect::get(val, &JsValue::from_str(crate::protocol::PACK_BINARY)) {
        if let Ok(blobs) = blobs.dyn_into::<js_sys::Object>() {
            for pair in js_sys::Object::entries(&blobs).iter() {
                let pair: js_sys::Array = match pair.dyn_into() {
                    Ok(a)  => a,
                    Err(_) => continue,
                };
                let rel = match pair.get(0).as_string() {
                    Some(p) => p,
                    None    => continue,
                };
                let body = match pair.get(1).as_string() {
                    Some(c) => c,
                    None    => continue,
                };
                if !is_safe_rel(&rel) {
                    return Err(err!(
                        "A Diamond export names '{}', which is not a path inside it.", rel;
                        Invalid, Input, Path));
                }
                if device_local(&rel) {
                    continue;
                }
                // A file whose base64 is damaged is REFUSED rather than written as whatever decoded.
                // Half a picture written over a good one is the corruption this whole change exists
                // to remove, and it would arrive looking like a successful sync.
                let bytes = res!(crate::protocol::unpack_binary(&rel, &body));
                writes.push((rel, bytes));
            }
        }
    }
    Ok(writes)
}

/// Bring home every Diamond the open folder is holding, as the page calls it.
///
/// Called from `activateFolder` in `daimond.js`, which runs on every folder activation including
/// the silent reconnect at boot -- so a user of yesterday's build gets their stranded Diamonds back
/// on their next page load with no action at all.  See [`adopt_from_folder`] for what it does and
/// what it refuses to do.
#[wasm_bindgen]
pub async fn adopt_folder_diamonds() -> Result<String, JsValue> {
    adopt_from_folder().await.map_err(crate::wasm::to_js_err)
}
