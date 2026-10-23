//! No bytes cross the wire but in the body channel, by construction (spec §16.3a 3, D1k3
//! ruling 3).
//!
//! Every argument and answer of a store call is [`NoBytes`], save the chunk positions
//! (`body_put`'s `chunk`, `body_get`'s answer, and a journal round's `journal_put` chunk and
//! `journal_read` answer, U4e), which `store_calls!` marks `@bytes`.  `u8` is
//! not `NoBytes`, so a byte field, at any depth of an `Option`, a `Result`, a tuple or a
//! `Vec`, fails to compile:
//!
//! ```compile_fail,E0277
//! use oxedyne_daimond::store::call::NoBytes;
//! fn crosses<T: NoBytes + ?Sized>() {}
//! crosses::<Option<Result<Vec<u8>, String>>>();
//! ```
//!
//! The same shape with no byte in it compiles, which is what the test above is the negative
//! of:
//!
//! ```
//! use oxedyne_daimond::store::call::NoBytes;
//! fn crosses<T: NoBytes + ?Sized>() {}
//! crosses::<Option<Result<Vec<String>, String>>>();
//! ```
//!
//! A struct or enum is `NoBytes` through [`no_bytes!`], which names every field and arm in a
//! pattern with no `..`, so a field added later fails to compile until it is named there, and a
//! byte-typed one fails on [`crosses`].

use crate::{
    agent::compact::FoldNotes,
    diamond_link::{Link, LinksPage, Node, PageLink},
    diamond_versions::{Act, BodyRef, Cause, Found, OpenDelete, Route, Seen, Short, Stamp, Unplaced},
    engine::host::types::store::{CrystalHalf, Drained, FileAct, JournalKey, JournalRun, SettlePhase, Wants},
    marks::{DiamondId, Hold, Live, Reach},
    rating::Author,
    store::call::{Fault, Handle, StoreBusy, StoreDown, StoreUnknown, Unbound, Unreadable},
    tools::{Bound, CrystalPassed, FileRoot, Toolkit},
};

use super::wire::{
    HexHash, Put, Recorded, Unlinked, WantsPage, WireBody, WireCarried, WireChange, WireStanding,
    WireText, WireTurnFound,
};

use oxedyne_fe2o3_core::prelude::*;


/// A type with no bytes in it, at any depth, so it may cross the wire outside the body channel.
pub trait NoBytes {}

/// Compiles only for a [`NoBytes`] value.
pub fn crosses<T: NoBytes + ?Sized>(_: &T) {}

macro_rules! bare {
    ($($t:ty),* $(,)?) => { $( impl NoBytes for $t {} )* };
}

bare!(String, str, bool, u16, u32, u64, usize, (), Error<ErrTag>);

impl<T: NoBytes> NoBytes for Option<T> {}
impl<T: NoBytes> NoBytes for Vec<T> {}
impl<T: NoBytes + ?Sized> NoBytes for Box<T> {}
impl<T: NoBytes, E: NoBytes> NoBytes for Result<T, E> {}
impl<A: NoBytes, B: NoBytes> NoBytes for (A, B) {}
impl<A: NoBytes, B: NoBytes, C: NoBytes> NoBytes for (A, B, C) {}
impl<A: NoBytes, B: NoBytes, C: NoBytes, D: NoBytes> NoBytes for (A, B, C, D) {}

/// `NoBytes` for a struct or an enum, with every field and arm named, so a new one does not
/// compile until it is named here and crosses.
macro_rules! no_bytes {
    ($(struct $t:ident { $($f:ident),* $(,)? })*) => {$(
        impl NoBytes for $t {}
        const _: fn(&$t) = |v| { let $t { $($f),* } = v; $( crosses($f); )* };
    )*};
}

macro_rules! no_bytes_tuple {
    ($(struct $t:ident ( $($f:ident),* );)*) => {$(
        impl NoBytes for $t {}
        const _: fn(&$t) = |v| { let $t ( $($f),* ) = v; $( crosses($f); )* };
    )*};
}

macro_rules! no_bytes_enum {
    ($(enum $t:ident {
        $( $v:ident $( ( $($tf:ident),* ) )? $( { $($sf:ident),* } )? ),* $(,)?
    })*) => {$(
        impl NoBytes for $t {}
        const _: fn(&$t) = |v| match v {
            $( $t::$v $( ( $($tf),* ) )? $( { $($sf),* } )? => {
                $($( crosses($tf); )*)?
                $($( crosses($sf); )*)?
            } )*
        };
    )*};
}

// Each one field is a private `String`.
impl NoBytes for HexHash {}
impl NoBytes for DiamondId {}

no_bytes_tuple! {
    struct Handle(n);
}

no_bytes! {
    // The wire's own
    struct BodyRef { hash, len }
    struct WireChange {
        path, after, before, found, carried, mark, refused, wiped, folder, by, door,
    }
    struct Recorded { version, count, first }
    struct WantsPage { wants, total, more }
    // The port's and the store's
    struct Wants { own, notes, windows, large, wipe }
    struct Author { role, m, pv, sp, run, via }
    struct FoldNotes { task, next, open, decisions, found, edited, read }
    struct CrystalPassed { version, at, page, data, debug }
    struct Drained { captured }
    struct Reach { attached, read_only, unconfirmed, nested }
    struct Hold { r, path, ws, read }
    struct Link { id, ts, from, to, rel, note, by, share }
    struct Node { kind, rest }
    struct LinksPage { stamp, links, next }
    struct StoreDown { why }
    struct StoreBusy { call, secs }
    struct StoreUnknown { call, why }
    struct Unbound { call, id }
    struct Unreadable { path, why }
    struct JournalRun { run, open }
}

no_bytes_enum! {
    enum WireBody { Held(a), TooLarge(a), Unseen, Gone, Large(a) }
    enum WireCarried { Made, Kept(a), Unread }
    enum WireStanding { Now(a), Unknown }
    enum WireText { Words(a), Body(a) }
    enum WireTurnFound { Made, Carried(a), Was(a) }
    enum Unlinked { Missing, Users, Removed { count } }
    enum Put { More, Done, Held }
    enum PageLink { Link(a), Refused { id, why } }
    enum Seen { Absent, Bytes(a), Unread }
    enum Stamp { Seen(a, b), Hashed(a) }
    enum Found { Nothing, Hash(a), Unread }
    enum Cause { Turn, User, Save, Fold, Restore, Share }
    enum CrystalHalf { Data, Page }
    enum SettlePhase { Archive, Record }
    enum FileAct { Mkdir, Delete, Move(a) }
    enum JournalKey { Round(a), Open }
    enum FileRoot { Workspace, Opfs, Machine }
    enum Short { Count, Bytes(a), Kept(a, b), Store(a) }
    enum OpenDelete { Go(a), Ask(a, b), Stopped(a) }
    enum Unplaced { Unrecorded, Unknown }
    enum Route { Go, Left, Ask(a) }
    enum Act { Go, Same, Changed, Left, Ask(a), Unasked, Unanswered }
    enum Live { Diamond(a, b), Chat(a, b) }
    enum Bound {
        NoWrite(a), NoRead(a), MayRead(a), OnlyUnder(a), OnlyWriteUnder(a), Toolkit(a), Nowhere,
    }
    enum Toolkit { Rust, Node, Python, Go, Git, Remote }
    enum Fault { Down(a), Busy(a), Unbound(a), Unknown(a) }
}
