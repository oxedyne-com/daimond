//! The storage edge of [`crate::marks`]: this device's record, the trash and the open workspace,
//! read at each act and never taken from a caller (HIST-SAFE U2, 2026-10-12).

use crate::marks::{self, DiamondId, Hold, Live, Reach, Record};
use crate::engine::worker::brief;
use crate::tools::Bound;
use crate::wasm::{diamond, opfs};

use oxedyne_fe2o3_core::prelude::*;

use wasm_bindgen::{JsCast, JsValue};


/// Why a write or a delete is refused when this device's record cannot be read: one sentence,
/// shared with the engine's dispatch check.
pub use crate::marks::UNREAD;

/// Is the identity unlocked?  The record is read only then, as markshere.js reads it: an unlock
/// reads the wrapped key from this same storage area, which proves the area has loaded.
fn unlocked() -> bool {
    let win = match web_sys::window() {
        Some(w) => w,
        None    => return false,
    };
    let id = match js_sys::Reflect::get(&win, &JsValue::from_str("DaimondIdentity")) {
        Ok(v) if v.is_object() => v,
        _                      => return false,
    };
    let f = match js_sys::Reflect::get(&id, &JsValue::from_str("isUnlocked")) {
        Ok(v) => v,
        Err(_) => return false,
    };
    match f.dyn_into::<js_sys::Function>() {
        Ok(f) => matches!(f.call0(&id), Ok(v) if v.as_bool() == Some(true)),
        Err(_) => false,
    }
}

/// One key from local storage, through the page's own `Storage.prototype`, so the account's
/// prefix (accounts.js) applies as it does to the page's reads.  `None` is a key that is not
/// there; an error is a store that could not be read.
fn stored(key: &str) -> Outcome<Option<String>> {
    let win = res!(web_sys::window().ok_or_else(|| err!("No window to read '{}' from.", key; Missing)));
    match win.local_storage() {
        Ok(Some(store)) => match store.get_item(key) {
            Ok(v)  => Ok(v),
            Err(_) => Err(err!("Local storage refused the read of '{}'.", key; IO, Read)),
        },
        _ => Err(err!("No local storage to read '{}' from.", key; Missing)),
    }
}

/// This device's record of the marks pressed here, or [`UNREAD`] where it cannot be read: the
/// account locked, the store unreadable, the record missing (markshere.js writes an empty one at
/// unlock, so a missing one is a store that has lost it) or not a record.
pub fn record() -> Outcome<Record> {
    if !unlocked() {
        return Err(err!("{}", UNREAD; Invalid, Input));
    }
    match stored(marks::KEY) {
        Ok(Some(raw)) => match marks::read_record(&raw) {
            Some(rec) => Ok(rec),
            None      => Err(err!("{}", UNREAD; Invalid, Input)),
        },
        _ => Err(err!("{}", UNREAD; Invalid, Input)),
    }
}

/// The ids in the trash now.  An empty trash has no key; a store that cannot be read is
/// [`UNREAD`], since a Diamond in the trash must not be read as live.
pub fn trashed() -> Outcome<Vec<String>> {
    match stored(marks::TRASH_KEY) {
        Ok(Some(raw)) => match marks::trashed_ids(&raw) {
            Some(ids) => Ok(ids),
            None      => Err(err!("{}", UNREAD; Invalid, Input)),	// damaged: never "empty" (QA A F2)
        },
        Ok(None)      => Ok(Vec::new()),
        Err(_)        => Err(err!("{}", UNREAD; Invalid, Input)),
    }
}

/// The workspace open in THIS engine, as the record keys it: the folder the file tools are on,
/// and its id on this device, never what a page says is open.
pub fn root_here() -> String {
    match (opfs::folder_name(), opfs::folder_id()) {
        (Some(name), Some(fid)) => marks::root_key(true, &name, &fid),
        _                       => marks::root_key(false, "", ""),
    }
}

/// What the Diamond `id` reaches on this device now: its sidecar rows, this device's record,
/// the open workspace and the trash, each read afresh.
pub async fn diamond_reach(id: &DiamondId) -> Outcome<Reach> {
    // THE RECORD FIRST: a locked account is UNREAD whatever else holds, a trashed Diamond
    // included (QA A F3).
    let rec = res!(record());
    let gone = res!(trashed());
    if gone.iter().any(|g| g == id.as_str()) {
        return Ok(Reach::default());
    }
    let links = res!(diamond::links_touching(&fmt!("diamond:{}", id)).await);
    Ok(marks::reach(&rec, id.as_str(), &links, &root_here(), |d: &str| gone.iter().any(|g| g == d)))
}

/// The bounds a turn's marks give it NOW, read afresh for every call a model makes
/// ([`crate::tools::ToolContext::bounds_now`]), so a mark withdrawn, or made read-only, while
/// the turn runs stops its writes at the next call rather than at the next turn (QA B F3,
/// 2026-10-12).  A record that cannot be read is [`UNREAD`]: FAIL CLOSED, in its own sentence.
pub async fn live_bounds(live: &Live) -> Outcome<Vec<Bound>> {
    match reach(live).await {
        Ok(r)  => Ok(brief::fence_of(live, &r).0),
        Err(_) => Err(err!("{}", UNREAD; Invalid, Input)),
    }
}

/// What `target` reaches on this device now: a Diamond's [`diamond_reach`], a chat's
/// [`chat_reach`].  Any failure to read is [`UNREAD`], in its own sentence.
pub async fn reach(target: &Live) -> Outcome<Reach> {
    let read = match target {
        Live::Diamond(id, _)    => diamond_reach(id).await,
        Live::Chat(chat, holds) => chat_reach(chat, holds).map(|(ws, wait)| Reach::of_chat(ws, wait)),
    };
    read.map_err(|_| err!("{}", UNREAD; Invalid, Input))
}

/// Drop this device's press of `owner`'s row `id`, in the act that removes the row (QA B F4).
/// A record that cannot be read here -- the account locked -- is left as it is, as the page
/// leaves it; one that holds no such press is not written.
pub fn forget_press(owner: &str, id: &str) -> Outcome<()> {
    if !unlocked() {
        return Ok(());
    }
    let raw = match stored(marks::KEY) {
        Ok(Some(raw)) => raw,
        _             => return Ok(()),
    };
    let text = match marks::drop_entry(&raw, owner, id) {
        Some(t) => t,
        None    => return Ok(()),
    };
    let win = res!(web_sys::window().ok_or_else(|| err!("No window to write '{}' in.", marks::KEY; Missing)));
    let store = match win.local_storage() {
        Ok(Some(s)) => s,
        _           => return Err(err!("No local storage to write '{}' in.", marks::KEY; Missing)),
    };
    match store.set_item(marks::KEY, &text) {
        Ok(()) => Ok(()),
        Err(_) => Err(err!("Local storage refused the write of '{}' dropping the press of row '{}' \
            of Diamond '{}'.", marks::KEY, id, owner; IO, Write)),
    }
}

/// A chat's workspace as the record grants it here: `(workspace, unconfirmed)`.  The holdings
/// are the chat's synced half, from the page; each is in force only where this device's record
/// has the press, in the workspace open now, and none for a chat in the trash.
pub fn chat_reach(chat: &str, holds: &[Hold]) -> Outcome<(Vec<String>, Vec<String>)> {
    // The record first, as in `diamond_reach` (QA A F3).
    let (rec, root) = (res!(record()), root_here());
    let gone = res!(trashed());
    let (mut ws, mut wait) = (Vec::new(), Vec::new());
    if gone.iter().any(|g| g == chat) {
        return Ok((ws, wait));
    }
    // A door onto a Diamond in the trash is shut.
    let shut = |p: &str| p.strip_prefix("diamonds/")
        .map(|r| gone.iter().any(|g| g == r.split('/').next().unwrap_or(""))).unwrap_or(false);
    for h in holds.iter().filter(|h| !shut(&h.path)) {
        if matches!(marks::chat_force(&rec, chat, h, &root), Some((true, _))) && !ws.contains(&h.path) {
            ws.push(h.path.clone());
        }
        if h.ws && marks::chat_waiting(&rec, chat, h, &root) && !wait.contains(&h.path) {
            wait.push(h.path.clone());
        }
    }
    Ok((ws, wait))
}
