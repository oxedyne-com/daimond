//! Cloud storage edge — the part of the workspace that is not on this device.
//!
//! The user's model is that the workspace is one set of files and the device holds as much of it
//! as it can.  What the device cannot hold lives in cloud storage, and the agent must be able to
//! see that such a file exists, be told plainly when it asks for one, and fetch it deliberately.
//!
//! Three things on the JavaScript side make that possible, and this module is the only place that
//! knows about them:
//!
//! - `localStorage["daimond-cloud-paths"]` — a JSON object mapping path to byte size, listing
//!   every path that is in cloud storage and **not** on this device right now.
//! - `window.__daimondCloudFetch(path)` — brings one file down into OPFS.
//! - `window.__daimondCloudForget(path)` — drops one path from the index, so its bytes are
//!   eventually reclaimed.
//!
//! A fetch can be large and will cost the user money, so nothing here is ever called on the
//! agent's behalf: the index is *read* freely, and the bytes move only when `file_fetch` says so.

use crate::tools::normalise;
use crate::wasm::js_str;

use oxedyne_fe2o3_core::prelude::*;

use wasm_bindgen::JsCast;
use wasm_bindgen::JsValue;
use wasm_bindgen_futures::JsFuture;


/// The `localStorage` key holding the paths that are in cloud storage and not on this device.
pub const INDEX_KEY: &str = "daimond-cloud-paths";

/// The JS global that brings one file down from cloud storage into OPFS.
const FETCH_FN: &str = "__daimondCloudFetch";

/// The JS global that drops one path from the cloud index.
const FORGET_FN: &str = "__daimondCloudForget";

/// Every path in cloud storage that is not on this device, with its size in bytes.
///
/// The key may be absent, empty or malformed, and each of those means the same thing here:
/// nothing is in cloud storage.  A workspace the user can still see must never fail to list
/// merely because a cache entry was garbled, so this returns a list and never an error.
pub fn index() -> Vec<(String, u64)> {
    let raw = match raw_index() {
        Some(s) => s,
        None    => return Vec::new(),
    };
    if raw.trim().is_empty() {
        return Vec::new();
    }
    let parsed = match js_sys::JSON::parse(&raw) {
        Ok(v)  => v,
        Err(_) => return Vec::new(), // malformed: treat as empty, never fail the listing
    };
    let obj: js_sys::Object = match parsed.dyn_into() {
        Ok(o)  => o,
        Err(_) => return Vec::new(),
    };
    let mut out: Vec<(String, u64)> = Vec::new();
    let entries = js_sys::Object::entries(&obj);
    for i in 0..entries.length() {
        let pair = js_sys::Array::from(&entries.get(i));
        let path = match pair.get(0).as_string() {
            Some(p) => p,
            None    => continue,
        };
        if path.trim().is_empty() {
            continue;
        }
        // A size that is not a number is not a reason to hide the file; it is a reason to say
        // nothing about how big it is.
        let size = pair.get(1).as_f64().unwrap_or(0.0);
        let size = if size.is_finite() && size > 0.0 { size as u64 } else { 0 };
        out.push((path, size));
    }
    out
}

/// The raw index string from `localStorage`, or `None` when there is no storage to read.
fn raw_index() -> Option<String> {
    let win = match web_sys::window() {
        Some(w) => w,
        None    => return None,
    };
    match win.local_storage() {
        Ok(Some(store)) => store.get_item(INDEX_KEY).ok().flatten(),
        _               => None, // no storage, or a browser that refuses it (Private Browsing)
    }
}

/// The size in bytes of `path` when it is in cloud storage and not on this device, else `None`.
///
/// Both sides are normalised before comparison, so one path is not several ways past the lookup.
///
/// # Arguments
/// * `path` - The workspace-relative path a tool is asking about.
pub fn size_of(path: &str) -> Option<u64> {
    let want = normalise(path);
    if want.is_empty() {
        return None;
    }
    index().into_iter()
        .find(|(p, _)| normalise(p) == want)
        .map(|(_, size)| size)
}

/// The cloud-only entries that are direct children of `dir`, as `(name, is_dir, size)`.
///
/// A cloud-only path nested deeper implies its intermediate directory exists: if `archive/old.md`
/// is in cloud storage and `archive/` is nowhere on this device, `archive/` is still part of the
/// workspace and must appear in its parent's listing.  Such a directory reports no size, because
/// the only honest size for it is the one the listing does not have.
///
/// # Arguments
/// * `dir` - The workspace-relative directory being listed; empty or `.` is the root.
pub fn children_of(dir: &str) -> Vec<(String, bool, u64)> {
    let base = normalise(dir);
    let mut out: Vec<(String, bool, u64)> = Vec::new();
    for (path, size) in index() {
        let norm = normalise(&path);
        let rel = if base.is_empty() {
            norm.clone()
        } else {
            match norm.strip_prefix(&fmt!("{}/", base)) {
                Some(r) => r.to_string(),
                None    => continue,
            }
        };
        if rel.is_empty() {
            continue;
        }
        match rel.split_once('/') {
            // Nested deeper: only the intermediate directory belongs in this listing.
            Some((head, _)) => {
                if !out.iter().any(|(n, is_dir, _)| n == head && *is_dir) {
                    out.push((head.to_string(), true, 0));
                }
            }
            None => out.push((rel, false, size)),
        }
    }
    out
}

/// Bring `path` down from cloud storage onto this device, returning what the JS side reports.
///
/// The result string starts with `OK` on success and `Error` on failure, and is passed back to
/// the model as it stands.
///
/// # Arguments
/// * `path` - The workspace-relative path to download.
pub async fn fetch(path: &str) -> Outcome<String> {
    call(FETCH_FN, path).await
}

/// Drop `path` from the cloud index, so its bytes are eventually reclaimed.
///
/// Absent from this device means "not here"; absent from the index means "gone".  This is the
/// second of those, and only an explicit delete ever reaches it.  When the JS side has not loaded
/// there is no index to drop anything from, so this answers with an empty string rather than an
/// error: a delete that worked must not be reported as a failure.
///
/// # Arguments
/// * `path` - The workspace-relative path to forget.
pub async fn forget(path: &str) -> Outcome<String> {
    if global(FORGET_FN).is_err() {
        return Ok(String::new());
    }
    call(FORGET_FN, path).await
}

/// Reach a cloud global on `window`, or refuse in the model's language.
fn global(name: &str) -> Outcome<(web_sys::Window, js_sys::Function)> {
    let win = res!(web_sys::window()
        .ok_or_else(|| err!("Cloud storage needs a browser window."; System, Missing)));
    let val = res!(js_sys::Reflect::get(&win, &JsValue::from_str(name))
        .map_err(|e| err!("Reading window.{} failed: {}.", name, js_str(&e); System, Missing)));
    if !val.is_function() {
        return Err(err!(
            "Cloud storage is not loaded in this page, so there is nothing to fetch from. \
            Tell the user, and carry on with the files that are on this device.";
            System, Missing));
    }
    let f = res!(val.dyn_into::<js_sys::Function>()
        .map_err(|_| err!("window.{} is not callable.", name; System, Invalid)));
    Ok((win, f))
}

/// Call a one-argument cloud global and await the promise it returns.
async fn call(name: &str, arg: &str) -> Outcome<String> {
    let (win, f) = res!(global(name));
    let ret = res!(f.call1(win.as_ref(), &JsValue::from_str(arg))
        .map_err(|e| err!("{} failed: {}.", name, js_str(&e); IO, Network)));
    let promise: js_sys::Promise = res!(ret.dyn_into()
        .map_err(|_| err!("window.{} did not return a promise.", name; Invalid, Output)));
    let val = res!(JsFuture::from(promise).await
        .map_err(|e| err!("{} failed: {}.", name, js_str(&e); IO, Network)));
    Ok(val.as_string().unwrap_or_else(|| js_str(&val)))
}
