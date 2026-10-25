//! The store's calls and replies as they cross between processes (spec §16.1, §16.3).
//!
//! A run's child reaches the store through `HostStore`, and on the runner the store is another
//! process.  Every method becomes one [`StoreCall`], its arguments owned, and every answer one
//! [`StoreReply`] of the same name.  Both travel as jdat `Dat` in its binary form, one frame each,
//! never over [`FRAME_MAX`].
//!
//! - **What does not cross.**  No `ToolContext`: the turn end is two-phase, so `drain_turn` takes
//!   the `stands` its child read after [`StoreCall::TurnWants`] and
//!   [`StoreCall::TurnStanding`].  The port's own handles (`Window`, `Hold`, `Steer`, `Marked`)
//!   cross as a [`Handle`] the store keeps in its per-run hold table, and a dropped one is
//!   [`StoreCall::LetGo`].
//! - **Errors keep their words and tags.**  An `Outcome` travels through fe2o3's error wire, so a
//!   refusal reaches the model in the words and with the tags it was raised with.  The typed
//!   refusals of the store process ([`StoreDown`], [`StoreBusy`], [`Unbound`], [`Unreadable`])
//!   are errors with a mark, and stay recognisable after the trip.
//! - **Decoding refuses** a frame over the limit, trailing bytes, an unknown call or field and a
//!   missing field.  A newer peer that adds a field is refused by an older one (lead ruling).

use crate::{
    agent::compact::FoldNotes,
    diamond_link::{LinksPage, PageLink},
    diamond_versions::{Act, Cause, Found, OpenDelete, Route, Seen, Short, Stamp},
    engine::host::{
        store::JOURNAL_ROUND_MAX,
        types::store::{CrystalHalf, Drained, FileAct, SettlePhase},
    },
    marks::{Live, Reach},
    rating::Author,
    tools::{Bound, CrystalPassed, FileRoot},
};

use oxedyne_fe2o3_core::prelude::*;
use oxedyne_fe2o3_jdat::{
    prelude::*,
    bdat::DecodeLimits,
};

#[path = "call_wire.rs"]
mod wire;
#[path = "call_nobytes.rs"]
mod nobytes;

pub use crate::{
    diamond_versions::BodyRef,
    engine::host::types::store::{JournalKey, JournalRun, LIST_PAGE},
};
pub use wire::*;
pub use nobytes::{crosses, NoBytes};


// ┌───────────────────────────────────────────────────────────────┐
// │ Frames                                                         │
// └───────────────────────────────────────────────────────────────┘

// Every ceiling is derived (spec §16.3a 5): a chunk frame is `BODY_CHUNK` and a little; every
// other frame is under `FRAME_META_MAX`, or a page, which the `_PAGE` assertions below hold to
// `FRAME_MAX`.
pub const BODY_CHUNK:           usize = 1 << 20;                    // a body_put or body_get chunk
pub const FRAME_META_MAX:       usize = 1 << 20;                    // a frame with no chunk or page
pub const FRAME_MAX:            usize = BODY_CHUNK + FRAME_META_MAX;  // 2 MiB
pub const PATH_WIRE_MAX:        usize = 4096;                       // every path, refused over
pub const TEXT_WIRE_MAX:        usize = 16 * 1024;                  // a note, a detail, a `refused`
pub const ERR_WORDS_MAX:        usize = 16 * 1024;                  // one error frame's words, cut
pub const ERR_FRAMES_MAX:       usize = 32;                         // an error chain, deeper dropped
pub const WORD_WIRE_MAX:        usize = 256;                        // a hash, an id, a name

// Pages.  Each is the most entries whose worst encoding, with the frame's own fields, fits the
// frame: `held_under` gives three paths an entry and a `Link` a note and four paths, so their
// pages are smaller than `LIST_PAGE`.
pub const HELD_PAGE:            usize = 64;                         // `held_under` entries
pub const LINK_PAGE:            usize = 16;                         // `links_page` links
pub const JOURNAL_PAGE:         usize = 256;                        // `journal_list` run ids

// The worst encoding of one entry of each page, which `call_tests` measures at its ceilings.
pub const ENTRY_SLACK:          usize = 512;                        // jdat's tags and lengths
pub const PATH_ENTRY_MAX:       usize = PATH_WIRE_MAX + ENTRY_SLACK;
pub const WANT_ENTRY_MAX:       usize = PATH_WIRE_MAX + 3 * WORD_WIRE_MAX + ENTRY_SLACK;
pub const HELD_ENTRY_MAX:       usize = 3 * PATH_WIRE_MAX + ENTRY_SLACK;
pub const LINK_ENTRY_MAX:       usize = TEXT_WIRE_MAX + 4 * PATH_WIRE_MAX + 4 * WORD_WIRE_MAX
                                        + ENTRY_SLACK;
pub const CHANGE_ENTRY_MAX:     usize = TEXT_WIRE_MAX + 2 * PATH_WIRE_MAX + 12 * WORD_WIRE_MAX
                                        + ENTRY_SLACK;

const _: () = assert!(LIST_PAGE * WANT_ENTRY_MAX + FRAME_META_MAX / 16 <= FRAME_MAX);
const _: () = assert!(JOURNAL_PAGE * (WORD_WIRE_MAX + ENTRY_SLACK) + FRAME_META_MAX / 16
    <= FRAME_META_MAX);
const _: () = assert!(LIST_PAGE * PATH_ENTRY_MAX + FRAME_META_MAX / 16 <= FRAME_MAX);
const _: () = assert!(HELD_PAGE * HELD_ENTRY_MAX + FRAME_META_MAX / 16 <= FRAME_MAX);
const _: () = assert!(LINK_PAGE * LINK_ENTRY_MAX + FRAME_META_MAX / 16 <= FRAME_MAX);
const _: () = assert!(CHANGE_ENTRY_MAX + FRAME_META_MAX / 16 <= FRAME_MAX);
// A frame's own fields beside its page: the id, a hold, a cursor path, a note in words.
const _: () = assert!(4 * PATH_WIRE_MAX + TEXT_WIRE_MAX + ENTRY_SLACK <= FRAME_META_MAX / 16);
// Every error a frame carries, at its ceiling, is under a frame with no page.
const _: () = assert!(ERR_FRAMES_MAX * (ERR_WORDS_MAX + ENTRY_SLACK) <= FRAME_META_MAX);

/// How deep a frame may nest.  A `WireChange` inside `capture` is six levels down, and an error
/// chain three per frame, so this holds the deepest chain kept, `ERR_FRAMES_MAX`, with the stack
/// never at risk.
const DEPTH_MAX: usize = 128;

/// The ceiling each call and each reply declares (spec §16.3a 5).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Ceiling {
    Meta,   // no chunk and no page: `FRAME_META_MAX`
    Page,   // one page of a list: `FRAME_MAX`
    Chunk,  // one body chunk: `FRAME_MAX`
    Read,   // a read of stored data, answered `TooBig` in its `Outcome` over `FRAME_MAX`
}

impl Ceiling {
    pub fn max(self) -> usize {
        match self {
            Self::Meta                              => FRAME_META_MAX,
            Self::Page | Self::Chunk | Self::Read   => FRAME_MAX,
        }
    }
}

pub fn encode_call(call: &StoreCall) -> Outcome<Vec<u8>> {
    let call = call.trimmed();
    res!(call.bounded());
    let bytes = res!(res!(call.to_dat()).to_bytes(Vec::new()));
    res!(fits(bytes.len(), call.ceiling(), call.name()));
    Ok(bytes)
}

pub fn decode_call(bytes: &[u8]) -> Outcome<StoreCall> {
    let call = match StoreCall::from_dat(res!(unframe(bytes))) {
        Ok(call)    => call,
        Err(e)      => return Err(err!(e, "A store call frame could not be read."; Decode, Wire)),
    };
    res!(fits(bytes.len(), call.ceiling(), call.name()));
    res!(call.bounded());
    let cut = match call.trimmed() {
        std::borrow::Cow::Owned(c)      => Some(c),
        std::borrow::Cow::Borrowed(_)   => None,
    };
    Ok(cut.unwrap_or(call))
}

/// The reply's frame, its errors cut.  A `Read` reply over its ceiling becomes that read's own
/// `TooBig` refusal, which always frames.
/// Is `reply` a refusal: its method's `Err`, or a fault?
pub fn is_refusal(reply: &StoreReply) -> bool {
    if matches!(reply, StoreReply::Fault(_)) {
        return true;
    }
    let is_err = |d: &Dat| match d {
        Dat::Map(r) if r.len() == 1 => matches!(r.iter().next(),
            Some((Dat::Str(k), v)) if k == "Err" && wire::is_err_wire(v)),
        _ => false,
    };
    match reply.to_dat() {
        Ok(Dat::Map(m)) if m.len() == 1 => match m.iter().next() {
            Some((_, Dat::List(l))) if l.len() == 1 => is_err(&l[0]),
            Some((_, d))                            => is_err(d),
            None                                    => false,
        },
        _ => false,
    }
}

pub fn encode_reply(reply: &StoreReply) -> Outcome<Vec<u8>> {
    res!(reply.bounded());
    let mut dat = res!(reply.to_dat());
    cut_errors(&mut dat);
    let bytes = res!(dat.to_bytes(Vec::new()));
    match fits(bytes.len(), reply.ceiling(), reply.name()) {
        Ok(())  => Ok(bytes),
        Err(e)  => match reply.too_big(e) {
            Some(r) => encode_reply(&r),
            None    => Err(err!(
                "store.{} answers {} bytes, over its {:?} ceiling of {}.",
                reply.name(), bytes.len(), reply.ceiling(), reply.ceiling().max();
            TooBig, Wire)),
        },
    }
}

pub fn decode_reply(bytes: &[u8]) -> Outcome<StoreReply> {
    let mut dat = res!(unframe(bytes));
    cut_errors(&mut dat);
    let reply = match StoreReply::from_dat(dat) {
        Ok(reply)   => reply,
        Err(e)      => return Err(err!(e, "A store reply frame could not be read."; Decode, Wire)),
    };
    res!(fits(bytes.len(), reply.ceiling(), reply.name()));
    res!(reply.bounded());
    Ok(reply)
}

fn fits(n: usize, ceiling: Ceiling, name: &str) -> Outcome<()> {
    if n > ceiling.max() {
        return Err(err!(
            "A store.{} frame of {} bytes is over its {:?} ceiling of {}.", name, n, ceiling,
            ceiling.max();
        TooBig, Wire));
    }
    Ok(())
}

fn unframe(bytes: &[u8]) -> Outcome<Dat> {
    if bytes.len() > FRAME_MAX {
        return Err(err!(
            "A store frame of {} bytes is over the {} a frame may carry.", bytes.len(), FRAME_MAX;
        TooBig, Wire));
    }
    let (dat, n) = res!(Dat::from_bytes_limited(bytes, &DecodeLimits::new(DEPTH_MAX, FRAME_MAX)));
    if n != bytes.len() {
        return Err(err!(
            "A store frame of {} bytes holds {} bytes past its end.", bytes.len(), bytes.len() - n;
        Decode, Wire));
    }
    Ok(dat)
}


// ┌───────────────────────────────────────────────────────────────┐
// │ Calls and replies                                              │
// └───────────────────────────────────────────────────────────────┘

/// One of the port's own values, held by the store for the run that asked for it: a window, a
/// versions hold, a steer or a dirty mark.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, ToDat, FromDat)]
pub struct Handle(pub u64);

/// Declares each call once: its kind (`sync`, answered inline with no await, or `wait`), the
/// [`Ceiling`] of the call and of its reply, its variant, the `HostStore` method it is, its
/// arguments and the type of its answer.
macro_rules! store_calls {
    ($(
        $(#[$m:meta])*
        $kind:ident $cc:ident / $rc:ident $var:ident $name:literal {
            $($f:ident : $(@ $fb:ident)? $t:ty),* $(,)?
        } -> $(@ $rb:ident)? $ret:ty;
    )*) => {
        // Every argument and answer is `NoBytes` but the two marked `@bytes` (ruling 3).
        const _: fn() = || {
            $( $( store_calls!(@cross $($fb)? $t); )* store_calls!(@cross $($rb)? $ret); )*
            let _ = nobytes::crosses::<Fault>;
        };

        /// One `HostStore` call, its arguments owned.
        #[derive(Clone, Debug, PartialEq, ToDat, FromDat)]
        pub enum StoreCall {
            $( $(#[$m])* $var { $($f: $t),* }, )*
        }

        /// The answer to one [`StoreCall`], under the same name, or the store's [`Fault`].
        #[derive(Clone, Debug, ToDat, FromDat)]
        pub enum StoreReply {
            $( $var($ret), )*
            Fault(Fault),
        }

        impl StoreCall {
            /// Every call's method name, in declaration order.
            pub const NAMES: &'static [&'static str] = &[$($name),*];

            /// The `HostStore` method this is.
            pub fn name(&self) -> &'static str {
                match self { $( Self::$var { .. } => $name, )* }
            }

            /// Whether the method is a plain `fn`, which the store answers from memory with no
            /// await, ahead of every async call (spec §16.5).
            pub fn sync(&self) -> bool {
                match self { $( Self::$var { .. } => store_calls!(@sync $kind), )* }
            }

            pub fn ceiling(&self) -> Ceiling {
                match self { $( Self::$var { .. } => Ceiling::$cc, )* }
            }
        }

        impl StoreReply {
            /// The method this answers, or `"fault"`.
            pub fn name(&self) -> &'static str {
                match self {
                    $( Self::$var(_) => $name, )*
                    Self::Fault(_) => "fault",
                }
            }

            pub fn ceiling(&self) -> Ceiling {
                match self {
                    $( Self::$var(_) => Ceiling::$rc, )*
                    Self::Fault(_) => Ceiling::Meta,
                }
            }

            /// A `Read` reply's own refusal in place of an answer too big to frame.
            pub fn too_big(&self, e: Error<ErrTag>) -> Option<Self> {
                match self {
                    $( Self::$var(_) => store_calls!(@big $rc $var e), )*
                    Self::Fault(_) => None,
                }
            }
        }
    };
    (@cross bytes $t:ty) => {};
    (@cross $t:ty) => { let _ = nobytes::crosses::<$t>; };
    (@sync sync) => { true };
    (@sync wait) => { false };
    (@big Read $var:ident $e:ident) => { Some(Self::$var(Err($e))) };
    (@big $other:ident $var:ident $e:ident) => { None };
}

store_calls! {
    // Crystal
    wait Meta/Meta ReadCrystalData "read_crystal_data" { id: String } -> Outcome<BodyRef>;
    wait Meta/Meta ReadCrystalDataStrict "read_crystal_data_strict" { id: String }
        -> Outcome<BodyRef>;
    wait Meta/Meta ReadCrystalPage "read_crystal_page" { id: String } -> Outcome<BodyRef>;
    wait Meta/Meta ReadCrystalPageStrict "read_crystal_page_strict" { id: String }
        -> Outcome<BodyRef>;
    sync Meta/Meta CrystalHalf "crystal_half" { id: String, path: String } -> Option<CrystalHalf>;
    wait Meta/Meta CrystalUndoTarget "crystal_undo_target" {
        id: String, half: CrystalHalf, at: Option<u64>,
    } -> Outcome<Option<(u64, String)>>;
    wait Meta/Meta HotRefusals "hot_refusals" { id: String } -> u32;
    wait Meta/Meta SetHotRefusals "set_hot_refusals" { id: String, n: u32 } -> Outcome<()>;
    /// `old` crosses as a body, and only when it will not parse; the answer is the newest crystal
    /// that does, as a body (S1J, the S1 mend rule on the store wire).
    wait Meta/Meta CrystalHotLastGood "crystal_hot_last_good" { id: String, old: BodyRef }
        -> Outcome<BodyRef>;
    wait Meta/Meta LastPassed "last_passed" { id: String } -> Option<CrystalPassed>;
    /// The two marks alone: the child hashes the page (`None` for none of its own) and the data,
    /// so neither crosses (§9.11 D1k2 rider).
    wait Meta/Meta MarkPassed "mark_passed" {
        id: String, version: u64, page: Option<HexHash>, data: HexHash, debug: u32,
    } -> Outcome<CrystalPassed>;

    // Standing files and folds.  `standing_retired` runs in the child and writes nothing; only
    // an accepted landing's side files cross, once the door has accepted the write (§16.3a 4,
    // UNBLOCK-18 F6).
    /// The Diamond `id` is the standing path's own, checked against the grant (D1v3b rider).
    /// Each archive entry names the standing leaf whose archive it appends to; `noted` and
    /// `touched` are a `STATE.md` landing's new DECISIONS lines and touched rows, never a whole
    /// file (PORT-L QA B1): the store reads, appends and writes each.  It derives every path.
    /// One call is one `phase` (held-lock settle P2), and carries only that phase's parts: the
    /// archive for `Archive`, `noted` and `touched` for `Record`, with `at` the landing's time,
    /// which a touched removal is compared with.  The store refuses a part of the other phase.
    wait Meta/Meta StandingSettle "standing_settle" {
        id: String, root: FileRoot, path: String, phase: SettlePhase,
        archive: Vec<(String, BodyRef)>, noted: Vec<String>, touched: Vec<String>, at: u64,
    } -> Outcome<()>;
    /// What a `STATE.md` landing reads (PL-A2): what stands at `path` and the touched record of
    /// the Diamond `id`, each as a body, `None` for an absent file.  A file that stands but will
    /// not read is an Err, never `None` and never empty (I-HL4).  `path` must be `id`'s own
    /// `STATE.md` in the store's area; the child lands the write through `state_split`.
    wait Meta/Meta StateRead "state_read" { id: String, root: FileRoot, path: String }
        -> Outcome<(Option<BodyRef>, Option<BodyRef>)>;
    /// A file of the Diamond `id` as the store holds it, for a run's child (HL5a, lead ruling 3):
    /// at most `max` of its bytes, as a body, and its whole length; `None` where nothing stands
    /// there, and an `Err` where it stands but will not read, never `None`.  `path` must be at or
    /// under `id`'s folder in the store's area (`tools::store_owned`).
    wait Meta/Meta StoreFileRead "store_file_read" { id: String, path: String, max: u32 }
        -> Outcome<Option<(BodyRef, u64)>>;
    /// A folder of the Diamond `id` as the store holds it (HL5a): each entry's name, whether it
    /// is a folder, its length and its write time in milliseconds where known.  Answered
    /// `TooBig` over the frame, as every `Read` reply is.
    wait Meta/Read StoreFileList "store_file_list" { id: String, dir: String }
        -> Outcome<Vec<(String, bool, u64, Option<u64>)>>;
    /// A run's child's held write of the Diamond `id`'s file at `path` (HL5b, lead ruling 2;
    /// widened by HL5c to every path [`crate::tools::store_writable`] allows): one store op.
    /// Under the file's lock the store compares what stands with `expect` (`None` compares
    /// nothing), appends `archive` (the landing's ARCHIVE phase, each entry
    /// naming the standing leaf whose archive it joins), writes `body` and lets go.  `Ok(None)`
    /// written; `Ok(Some(found))` refused, with nothing archived and nothing written.  An
    /// archive is a standing leaf's alone; `.daimond/`, `.red/`, `meta.json` and `versions/` are
    /// refused before any write.  Answered `StoreBusy` past `BUSY_SECS`, it does not commit.
    wait Meta/Meta StoreWriteThen "store_write_then" {
        id: String, root: FileRoot, path: String, body: BodyRef, expect: Option<Seen>,
        archive: Vec<(String, BodyRef)>,
    } -> Outcome<Option<Seen>>;
    /// A run's child's folder, delete or move of the Diamond `id`'s path (HL5c): what the tab's
    /// fs port does in its own store, under the store's file locks, for every path
    /// [`crate::tools::store_writable`] allows (a move's both ends, in the one Diamond).
    wait Meta/Meta StoreFileAct "store_file_act" {
        id: String, root: FileRoot, path: String, act: FileAct,
    } -> Outcome<()>;
    // The fold's output is capped at `FOLD_MAX_TOKENS_STRUCTURED`, so it is a `Meta` reply.
    wait Meta/Meta AbsorbFoldNotes "absorb_fold_notes" { id: String, notes: FoldNotes }
        -> Option<FoldNotes>;
    // Filing answers a count and a row id, so its reply always frames; a read, the log whole.
    wait Meta/Meta HisWords "his_words" { keeper: String, entries: String } -> Outcome<String>;
    wait Meta/Read HisWordsRead "his_words_read" { keeper: String } -> Outcome<String>;

    // Links
    wait Meta/Meta AddLink "add_link" {
        owner: String, from: String, to: String, rel: String, note: String, by: String,
    } -> Outcome<String>;
    wait Meta/Read AllLinks "all_links" {} -> Outcome<String>;
    wait Meta/Read LinksJson "links_json" { node_ref: String } -> Outcome<String>;
    /// One page of `owner`'s sidecar from the row `at`, at most `LINK_PAGE` entries, under the
    /// `stamp` the walk's first page answered ([`links_page`](crate::diamond_link::links_page)).
    wait Meta/Read LinksPage "links_page" { owner: String, at: u64, stamp: Option<HexHash> }
        -> Outcome<LinksPage>;
    wait Meta/Meta RemoveLinkByModel "remove_link_by_model" {
        owner: String, link_id: String,
    } -> Outcome<Unlinked>;
    wait Meta/Meta DiamondExists "diamond_exists" { id: String } -> bool;

    // The activity record and the no-progress K (C2 MEMORY, UNBLOCK-27 R4; PORT-PL-B).  The
    // record is read whole, every device's file, so it rides a `Read` reply; a turn crosses as
    // its one encoded line (`activity::encode`), bounded by `Turn::new`'s clips.
    wait Meta/Read ActivityReadAll "activity_read_all" { id: String }
        -> Outcome<Vec<(String, String)>>;
    wait Meta/Meta ActivityAppend "activity_append" { id: String, line: String, now: u64 }
        -> Outcome<()>;
    wait Meta/Meta NoProgressRounds "no_progress_rounds" { id: String } -> usize;

    // A turn's captures and copies.  `capture` and `restore_landed` answer an `Outcome` on the
    // wire, which `RemoteStore` keeps until the port gives them one (D1int).
    sync Meta/Meta Capture "capture" { id: String, raw: String, change: WireChange }
        -> Outcome<()>;
    sync Meta/Meta CapturedRoom "captured_room" {
        id: String, path: String, found: Found, copy: Option<u64>, destroying: bool, room: u64,
    } -> Result<bool, Short>;
    wait Meta/Meta KeepRoom "keep_room" { id: String } -> u64;
    sync Meta/Meta Release "release" { id: String, path: String } -> ();
    /// At most `HELD_PAGE` captures under `from`, sorted by path, after the path `after`.
    sync Meta/Page HeldUnder "held_under" { id: String, from: String, after: Option<String> }
        -> Vec<(String, String, String)>;
    sync Meta/Meta ThisTurnFound "this_turn_found" { id: String, path: String, now: BodyRef }
        -> WireTurnFound;
    wait Meta/Meta TurnsFound "turns_found" { id: String, path: String, now: BodyRef }
        -> Option<BodyRef>;
    wait Meta/Meta MeasuredAgainst "measured_against" { id: String, path: String, now: BodyRef }
        -> BodyRef;
    sync Meta/Meta SealsSpent "seals_spent" { id: String, path: String, now: BodyRef } -> bool;
    wait Meta/Meta SealRun "seal_run" { id: String, path: String, now: BodyRef } -> Outcome<()>;
    wait Meta/Meta Pend "pend" {
        id: String, path: String, before: BodyRef, deleting: bool, mark: bool,
    } -> Outcome<bool>;
    wait Meta/Meta Unpend "unpend" { id: String, path: String } -> ();
    sync Meta/Meta RanOpaque "ran_opaque" { id: String } -> ();
    wait Meta/Meta NoteOutput "note_output" {
        id: String, tool: String, path: String, bytes: BodyRef,
    } -> ();
    wait Meta/Meta OutputIsOwn "output_is_own" {
        id: String, tool: String, path: String, bytes: BodyRef,
    } -> bool;
    /// The files the Diamond's file tools last wrote, with the sha256 of what they left, newest
    /// first and at most `MADE_SENT_MAX` (MADE-1): what an exec request's `made` names.
    wait Meta/Meta MadeFiles "made_files" { id: String } -> Vec<(String, String)>;
    /// What one command made, as the hand's write meter reported it, kept for the turn's record
    /// under the agent that ran it (MADE-2): at most `MADE_SENT_MAX` files.
    wait Meta/Meta RanMade "ran_made" {
        id: String, by: Option<Author>, files: Vec<(String, String, bool)>, capped: bool,
    } -> ();
    sync Meta/Meta Theirs "theirs" { id: String, path: String } -> bool;
    sync Meta/Meta FolderOf "folder_of" { path: String } -> Option<String>;
    sync Meta/Meta Versionable "versionable" { id: String, path: String } -> bool;
    /// Is the file at `path`, as `now` holds it, the user's rather than the Diamond's own
    /// (UNBLOCK-26 U1)?
    wait Meta/Meta AuthoredByUser "authored_by_user" { id: String, path: String, now: BodyRef }
        -> bool;
    /// Did the person decline a change at `path` this turn (UNBLOCK-26 U3)?
    sync Meta/Meta ChangeRefused "change_refused" { id: String, path: String } -> bool;
    sync Meta/Meta RefuseChange "refuse_change" { id: String, path: String } -> ();

    // Deletes from the open folder
    sync Meta/Meta OpenDeleteRoom "open_delete_room" { id: String, file: String } -> OpenDelete;
    sync Meta/Meta OpenDeleteAnswer "open_delete_answer" { id: String, ticket: u64, allow: bool }
        -> ();
    sync Meta/Meta OpenDeleteRelease "open_delete_release" { id: String, file: String } -> ();

    // Windows around a call
    wait Meta/Meta OpenWindow "open_window" { id: String, by: Option<Author> } -> Handle;
    wait Meta/Meta CloseWindow "close_window" { window: Handle } -> ();

    // Versions.  A record answers its first page of names; `recorded_names` reads the rest.
    wait Page/Page VersionsRecord "versions_record" {
        id: String, cause: Cause, turn: String, note: WireText, change: WireChange,
    } -> Outcome<Option<Recorded>>;
    /// The names `version` recorded, at most `LIST_PAGE` after the name `after`.
    wait Meta/Page RecordedNames "recorded_names" {
        id: String, version: u64, after: Option<String>,
    } -> Outcome<Vec<String>>;
    wait Meta/Meta VersionsBody "versions_body" { id: String, hash: HexHash }
        -> Outcome<Option<BodyRef>>;
    /// The manifest JSON `version` recorded for `id`, as stored; `None` where there is none
    /// (RUN-HIST K2: the runner's report carries the turn's rows from it).
    wait Meta/Meta VersionsManifest "versions_manifest" { id: String, version: u64 }
        -> Outcome<Option<String>>;
    wait Meta/Meta VersionsUndoTarget "versions_undo_target" {
        id: String, path: String, at: Option<u64>,
    } -> Outcome<Option<(u64, String, bool, Option<String>)>>;

    // Restores
    sync Meta/Meta RouteHere "route_here" {
        row: String, row_folder: Option<String>, landed: String, overwrites: bool,
    } -> Route;
    sync Meta/Meta RestoreStore "restore_store" { ticket: u64 } -> Option<String>;
    sync Meta/Meta RestoreRoute "restore_route" {
        ticket: u64, spelled: String, landed: String, now: Option<BodyRef>, puts: Option<BodyRef>,
    } -> Act;
    sync Meta/Meta RestoreLook "restore_look" { ticket: u64, spelled: String, now: Seen }
        -> Option<bool>;
    sync Meta/Meta RestoreAsked "restore_asked" { ticket: u64, spelled: String, now: Seen } -> ();
    wait Meta/Meta RestoreKeep "restore_keep" {
        ticket: u64, path: String, now: Option<BodyRef>, deleting: bool,
    } -> Outcome<()>;
    wait Meta/Meta RestoreLetGo "restore_let_go" { ticket: u64, path: String } -> ();
    sync Meta/Meta RestoreLanded "restore_landed" { ticket: u64, change: WireChange }
        -> Outcome<()>;

    // The turn end, through the hold's slot (spec §16.3a 1, 2)
    wait Meta/Meta HoldVersions "hold_versions" { id: String } -> Outcome<Handle>;
    sync Meta/Meta IsSteering "is_steering" { id: String } -> bool;
    sync Meta/Meta Steering "steering" { id: String } -> Handle;
    sync Meta/Meta DrainDirty "drain_dirty" { id: String } -> Vec<Handle>;
    /// The dirty group's record: `dirty_changes` and `versions_record` in one (R7a).
    wait Meta/Page VersionsRecordDirty "versions_record_dirty" {
        id: String, dirty: Vec<Handle>, cause: Cause, note: WireText,
    } -> Outcome<Option<Recorded>>;
    /// Snapshots what the run must read for the turn end, and answers its first page.
    wait Meta/Page TurnWants "turn_wants" { id: String } -> Outcome<WantsPage>;
    wait Meta/Page TurnWantsPage "turn_wants_page" { id: String, n: u32 } -> Outcome<WantsPage>;
    /// What the run found at one wanted path that did not stand as the store expected.  A
    /// capture names the `seen` its `Wants` entry named; a note's or a window's path names
    /// `Seen::Unread`, and a window's its `stamp` as the run found it (the window's credit).
    wait Meta/Meta TurnStanding "turn_standing" {
        id: String, path: String, seen: Seen, standing: WireStanding, stamp: Option<Stamp>,
    } -> Outcome<()>;
    /// The wanted paths that stand as expected, at most `LIST_PAGE` a call.
    wait Page/Meta TurnStands "turn_stands" { id: String, stands: Vec<(String, Seen)> }
        -> Outcome<()>;
    /// The record's wipe test, run by the child on a `wipe` entry that stands.
    wait Meta/Meta TurnWiped "turn_wiped" { id: String, path: String, seen: Seen, wiped: bool }
        -> Outcome<()>;
    wait Meta/Meta DrainTurn "drain_turn" { hold: Handle, id: String } -> Outcome<Drained>;
    wait Page/Page TurnUncovered "turn_uncovered" { hold: Handle, id: String, wrote: Vec<String> }
        -> Outcome<Vec<String>>;
    wait Meta/Meta TurnAdd "turn_add" { hold: Handle, id: String, change: WireChange }
        -> Outcome<()>;
    wait Meta/Meta DrainWindows "drain_windows" { hold: Handle, id: String } -> Outcome<u32>;
    wait Meta/Page VersionsRecordHeld "versions_record_held" {
        hold: Handle, id: String, at: Option<u64>, cause: Cause, turn: String, note: WireText,
    } -> Outcome<Option<Recorded>>;
    wait Meta/Meta RecordSteer "record_steer" {
        hold: Handle, id: String, json: WireText, instruction: WireText,
    } -> Outcome<u64>;
    sync Meta/Meta EndTurnCounts "end_turn_counts" { id: String } -> ();

    // Marks and the trail
    wait Meta/Read LiveBounds "live_bounds" { live: Live } -> Outcome<Vec<Bound>>;
    wait Meta/Read Reach "reach" { target: Live } -> Outcome<Reach>;
    sync Meta/Meta Trail "trail" { what: String, detail: String } -> ();

    // The body channel (§16.3a 3, §9.11 O2): the only bytes on the wire.
    /// One chunk of the body `hash`, `len` bytes whole, at `offset`, for the Diamond `id`, in the
    /// open act `act` (§9.11 O3): the client's port call that uploads and then names, minted by it.
    wait Chunk/Meta BodyPut "body_put" {
        id: String, act: u64, hash: HexHash, len: u64, offset: u64, chunk: @bytes Vec<u8>,
    } -> Outcome<Put>;
    /// At most `max` bytes of a body named to this run for `id`, from `offset`.
    wait Meta/Chunk BodyGet "body_get" { id: String, hash: HexHash, offset: u64, max: u64 }
        -> @bytes Outcome<Vec<u8>>;

    // The run journals (U4e, spec §4.4, X2): each round's record crosses in `BODY_CHUNK`
    // chunks, as a body does, under `JOURNAL_ROOT`.  A run names its own journal alone; the
    // parent, any run's (`refusal`).
    /// One chunk of record `key` of `run`, `len` bytes whole, at `offset`: `More` until the last,
    /// which writes the record and answers `Done`.  An offset of 0 begins the record again.  The
    /// key is a round, or the parent's open record (R1i).
    wait Chunk/Meta JournalPut "journal_put" {
        run: String, key: JournalKey, len: u64, offset: u64, chunk: @bytes Vec<u8>,
    } -> Outcome<Put>;
    /// At most `BODY_CHUNK` bytes from `offset` of the first round of `run` at or after
    /// `Round(n)`, or of its open record for `Open`; `None` where there is none.
    wait Meta/Chunk JournalRead "journal_read" { run: String, from: JournalKey, offset: u64 }
        -> @bytes Outcome<Option<JournalChunk>>;
    wait Meta/Meta JournalDrop "journal_drop" { run: String } -> Outcome<()>;
    // The parent's alone (R1i): refused to a run and to a door, whatever it names.
    /// At most `JOURNAL_PAGE` of the runs that have a journal, in order, after the run `after`,
    /// each with whether it holds the parent's open record: what a restarted parent finds open,
    /// without a scan of its own.
    wait Meta/Meta JournalList "journal_list" { after: Option<String> }
        -> Outcome<Vec<JournalRun>>;
    /// The TTL sweep of the journals (R1f3's `Ns::sweep_expired`): every run's journal whose
    /// newest round is at least `ttl_ms` old at `now_ms`, the caller's clock, is deleted.  The
    /// records deleted.
    wait Meta/Meta JournalSweep "journal_sweep" { ttl_ms: u64, now_ms: u64 } -> Outcome<u64>;

    // The wire's own
    /// A [`Handle`] the run dropped: a hold released, a steer ended, a window closed as lost.
    sync Meta/Meta LetGo "let_go" { handle: Handle } -> ();
    /// The parent's liveness ping, answered inline; a missed one is a wedge (spec §16.5).
    sync Meta/Meta Ping "ping" {} -> ();
}

impl StoreReply {
    /// Whether this answers `call`: its own reply, or a fault, which answers any call.
    pub fn answers(&self, call: &StoreCall) -> bool {
        match self {
            Self::Fault(_)  => true,
            _               => self.name() == call.name(),
        }
    }
}


// ┌───────────────────────────────────────────────────────────────┐
// │ Bounds                                                         │
// └───────────────────────────────────────────────────────────────┘

// Asked of a call or a reply on both sides: before it is sent, so a sender refuses what it cannot
// frame (§16.3a rule 3), and after it is read, so a peer's page over its constant is refused.

fn over(name: &str, field: &str, n: usize, max: usize) -> Error<ErrTag> {
    err!("store.{}'s {} is {}, over the {} the wire carries.", name, field, n, max;
        TooBig, Wire)
}

fn upto(name: &str, field: &str, n: usize, max: usize) -> Outcome<()> {
    if n > max { Err(over(name, field, n, max)) } else { Ok(()) }
}

fn paths<'a>(name: &str, field: &str, ps: impl IntoIterator<Item = &'a String>) -> Outcome<()> {
    for p in ps {
        res!(upto(name, field, p.len(), PATH_WIRE_MAX));
    }
    Ok(())
}

// A hash is held to its 64 characters by `HexHash`, so no bound here counts one.

fn text(name: &str, field: &str, t: &WireText) -> Outcome<()> {
    match t {
        WireText::Words(w)  => upto(name, field, w.len(), TEXT_WIRE_MAX),
        WireText::Body(_)   => Ok(()),
    }
}

/// Each field of a link page's entry within its constant, as `held_under`'s paths are.
fn page_link(name: &str, e: &PageLink) -> Outcome<()> {
    match e {
        PageLink::Link(l) => {
            res!(paths(name, "end", [&l.from.rest, &l.to.rest]));
            for w in [&l.id, &l.rel, &l.by, &l.from.kind, &l.to.kind] {
                res!(upto(name, "word", w.len(), WORD_WIRE_MAX));
            }
            upto(name, "note", l.note.len(), TEXT_WIRE_MAX)
        },
        PageLink::Refused { id, why } => {
            res!(upto(name, "refused id", id.len(), WORD_WIRE_MAX));
            upto(name, "refused why", why.len(), TEXT_WIRE_MAX)
        },
    }
}

fn change(name: &str, c: &WireChange) -> Outcome<()> {
    res!(paths(name, "change.path", c.folder.iter().chain(Some(&c.path))));
    res!(upto(name, "change.refused", c.refused.as_ref().map_or(0, |r| r.len()), TEXT_WIRE_MAX));
    if let Some(a) = &c.by {
        for w in [&a.role, &a.m, &a.pv, &a.sp, &a.run, &a.via] {
            res!(upto(name, "change.by", w.len(), WORD_WIRE_MAX));
        }
    }
    Ok(())
}

/// The body a `WireText` names, if it is one.
fn text_ref(t: &WireText) -> Option<&BodyRef> {
    match t {
        WireText::Body(r)   => Some(r),
        WireText::Words(_)  => None,
    }
}

impl StoreCall {

    /// Every body this call names that its sender uploads first (§16.3a 3's sender table).  The bytes
    /// of `note_output` and `output_is_own` are used by hash alone, so they are not among them.
    pub fn uploads(&self) -> Vec<BodyRef> {
        use StoreCall as C;
        let mut v: Vec<&BodyRef> = Vec::new();
        match self {
            C::Capture { change, .. } | C::RestoreLanded { change, .. }
            | C::TurnAdd { change, .. } => v.extend(change.uploads()),
            C::ThisTurnFound { now, .. } | C::TurnsFound { now, .. }
            | C::MeasuredAgainst { now, .. } | C::SealsSpent { now, .. }
            | C::SealRun { now, .. } | C::AuthoredByUser { now, .. } => v.push(now),
            C::Pend { before, .. } => v.push(before),
            C::StandingSettle { archive, .. } => v.extend(archive.iter().map(|(_, r)| r)),
            C::StoreWriteThen { body, archive, .. } => {
                v.push(body);
                v.extend(archive.iter().map(|(_, r)| r));
            }
            C::CrystalHotLastGood { old, .. } => v.push(old),
            C::VersionsRecord { note, change, .. } => {
                v.extend(text_ref(note));
                v.extend(change.uploads());
            }
            C::RestoreRoute { now, puts, .. } => {
                v.extend(now.iter());
                v.extend(puts.iter());
            }
            C::RestoreKeep { now, .. } => v.extend(now.iter()),
            C::VersionsRecordDirty { note, .. } | C::VersionsRecordHeld { note, .. } =>
                v.extend(text_ref(note)),
            C::TurnStanding { standing: WireStanding::Now(WireBody::Held(r)), .. } => v.push(r),
            C::RecordSteer { json, instruction, .. } => {
                v.extend(text_ref(json));
                v.extend(text_ref(instruction));
            }
            _ => (),
        }
        v.into_iter().cloned().collect()
    }

    /// Is every page, chunk, path and text of this call within its constant?
    pub fn bounded(&self) -> Outcome<()> {
        use StoreCall as C;
        let n = self.name();
        match self {
            C::CrystalHalf { path, .. }
            | C::Release { path, .. }
            | C::ThisTurnFound { path, .. }
            | C::TurnsFound { path, .. }
            | C::MeasuredAgainst { path, .. }
            | C::SealsSpent { path, .. }
            | C::SealRun { path, .. }
            | C::Pend { path, .. }
            | C::Unpend { path, .. }
            | C::NoteOutput { path, .. }
            | C::OutputIsOwn { path, .. }
            | C::Theirs { path, .. }
            | C::FolderOf { path, .. }
            | C::Versionable { path, .. }
            | C::AuthoredByUser { path, .. }
            | C::ChangeRefused { path, .. }
            | C::RefuseChange { path, .. }
            | C::VersionsUndoTarget { path, .. }
            | C::RestoreKeep { path, .. }
            | C::RestoreLetGo { path, .. }
            | C::TurnStanding { path, .. }
            | C::TurnWiped { path, .. }
            | C::LinksJson { node_ref: path }
            | C::OpenDeleteRoom { file: path, .. }
            | C::OpenDeleteRelease { file: path, .. }
            | C::RestoreLook { spelled: path, .. }
            | C::RestoreAsked { spelled: path, .. }
            | C::StateRead { path, .. }
            | C::StoreFileRead { path, .. }
            | C::StoreFileList { dir: path, .. } => paths(n, "path", [path]),
            C::StandingSettle { path, archive, noted, touched, .. } => {
                for (leaf, _) in archive.iter() {
                    res!(upto(n, "leaf", leaf.len(), WORD_WIRE_MAX));
                }
                let lines: usize = noted.iter().chain(touched.iter()).map(|l| l.len()).sum();
                res!(upto(n, "noted", lines, FRAME_META_MAX / 2));
                paths(n, "path", [path])
            },
            C::StoreWriteThen { path, archive, .. } => {
                for (leaf, _) in archive.iter() {
                    res!(upto(n, "leaf", leaf.len(), WORD_WIRE_MAX));
                }
                paths(n, "path", [path])
            },
            C::StoreFileAct { path, act, .. } => match act {
                FileAct::Move(to)   => paths(n, "path", [path, to]),
                _                   => paths(n, "path", [path]),
            },
            C::RouteHere { row, row_folder, landed, .. } =>
                paths(n, "path", row_folder.iter().chain([row, landed])),
            C::RestoreRoute { spelled, landed, .. } => paths(n, "path", [spelled, landed]),
            C::HeldUnder { from, after, .. } => paths(n, "path", after.iter().chain([from])),
            C::RecordedNames { after, .. } => paths(n, "after", after.iter()),
            C::LinksPage { owner, .. } => upto(n, "owner", owner.len(), WORD_WIRE_MAX),
            C::AddLink { owner, from, to, rel, note, by } => {
                res!(paths(n, "end", [from, to]));
                for w in [owner, rel, by] {
                    res!(upto(n, "word", w.len(), WORD_WIRE_MAX));
                }
                // His note is refused, not cut: the link would keep words he did not write.
                upto(n, "note", note.len(), TEXT_WIRE_MAX)
            },
            C::Capture { raw, change: c, .. } => {
                res!(paths(n, "raw", [raw]));
                change(n, c)
            },
            C::RestoreLanded { change: c, .. } | C::TurnAdd { change: c, .. } => change(n, c),
            C::VersionsRecord { turn, note, change: c, .. } => {
                res!(upto(n, "turn", turn.len(), WORD_WIRE_MAX));
                res!(text(n, "note", note));
                change(n, c)
            },
            C::VersionsRecordHeld { turn, note, .. } => {
                res!(upto(n, "turn", turn.len(), WORD_WIRE_MAX));
                text(n, "note", note)
            },
            C::VersionsRecordDirty { note, .. } => text(n, "note", note),
            C::RecordSteer { json, instruction, .. } => {
                res!(text(n, "json", json));
                text(n, "instruction", instruction)
            },
            C::TurnStands { stands, .. } => {
                res!(upto(n, "stands", stands.len(), LIST_PAGE));
                paths(n, "path", stands.iter().map(|(p, _)| p))
            },
            C::TurnUncovered { wrote, .. } => {
                res!(upto(n, "wrote", wrote.len(), LIST_PAGE));
                paths(n, "path", wrote)
            },
            C::RanMade { files, .. } => {
                res!(upto(n, "files", files.len(), crate::diamond_versions::MADE_SENT_MAX));
                paths(n, "path", files.iter().map(|(p, _, _)| p))
            },
            C::BodyPut { len, offset, chunk, .. } => {
                res!(upto(n, "chunk", chunk.len(), BODY_CHUNK));
                match offset.checked_add(chunk.len() as u64) {
                    Some(end) if end <= *len => Ok(()),
                    _ => Err(err!(
                        "store.body_put's chunk of {} bytes at {} runs past the body's {}.",
                        chunk.len(), offset, len;
                    Invalid, Input, Wire)),
                }
            },
            C::BodyGet { max, .. } =>
                upto(n, "max", usize::try_from(*max).unwrap_or(usize::MAX), BODY_CHUNK),
            C::JournalPut { run, len, offset, chunk, .. } => {
                res!(upto(n, "run", run.len(), WORD_WIRE_MAX));
                res!(upto(n, "chunk", chunk.len(), BODY_CHUNK));
                res!(upto(n, "len", usize::try_from(*len).unwrap_or(usize::MAX),
                    JOURNAL_ROUND_MAX));
                match offset.checked_add(chunk.len() as u64) {
                    Some(end) if end <= *len => Ok(()),
                    _ => Err(err!(
                        "store.journal_put's chunk of {} bytes at {} runs past the round's {}.",
                        chunk.len(), offset, len;
                    Invalid, Input, Wire)),
                }
            },
            C::JournalRead { run, .. } | C::JournalDrop { run } =>
                upto(n, "run", run.len(), WORD_WIRE_MAX),
            C::JournalList { after: Some(a) } => upto(n, "after", a.len(), WORD_WIRE_MAX),
            _ => Ok(()),
        }
    }

    /// The call as it crosses: a trail's detail cut to `TEXT_WIRE_MAX`, marked.
    fn trimmed(&self) -> std::borrow::Cow<'_, Self> {
        match self {
            Self::Trail { what, detail } if detail.len() > TEXT_WIRE_MAX =>
                std::borrow::Cow::Owned(Self::Trail {
                    what:   what.clone(),
                    detail: cut(detail, TEXT_WIRE_MAX, CUT_MARK),
                }),
            _ => std::borrow::Cow::Borrowed(self),
        }
    }
}

impl StoreReply {

    /// Is every page and chunk of this reply within its constant?
    pub fn bounded(&self) -> Outcome<()> {
        use StoreReply as R;
        let n = self.name();
        match self {
            R::MadeFiles(v) => {
                res!(upto(n, "page", v.len(), crate::diamond_versions::MADE_SENT_MAX));
                paths(n, "path", v.iter().map(|(p, _)| p))
            },
            R::HeldUnder(v) => {
                res!(upto(n, "page", v.len(), HELD_PAGE));
                paths(n, "path", v.iter().flat_map(|(a, b, c)| [a, b, c]))
            },
            R::LinksPage(Ok(p)) => {
                res!(upto(n, "page", p.links.len(), LINK_PAGE));
                for e in &p.links {
                    res!(page_link(n, e));
                }
                Ok(())
            },
            R::VersionsRecord(Ok(Some(r)))
            | R::VersionsRecordHeld(Ok(Some(r)))
            | R::VersionsRecordDirty(Ok(Some(r))) => {
                res!(upto(n, "first", r.first.len(), LIST_PAGE));
                paths(n, "name", &r.first)
            },
            R::RecordedNames(Ok(v)) | R::TurnUncovered(Ok(v)) => {
                res!(upto(n, "page", v.len(), LIST_PAGE));
                paths(n, "name", v)
            },
            R::TurnWants(Ok(p)) | R::TurnWantsPage(Ok(p)) => {
                res!(upto(n, "page", p.entries(), LIST_PAGE));
                let w = &p.wants;
                paths(n, "path", w.own.iter().map(|(p, _)| p)
                    .chain(w.notes.iter().map(|(p, _)| p))
                    .chain(w.windows.iter().map(|(p, _)| p))
                    .chain(w.large.iter().map(|(p, _)| p))
                    .chain(w.wipe.iter().map(|(p, _, _)| p)))
            },
            R::StoreFileList(Ok(v)) => paths(n, "name", v.iter().map(|(name, _, _, _)| name)),
            R::VersionsManifest(Ok(Some(m))) => upto(n, "manifest", m.len(), FRAME_META_MAX / 2),
            R::BodyGet(Ok(b)) => upto(n, "chunk", b.len(), BODY_CHUNK),
            R::JournalRead(Ok(Some(c))) => upto(n, "chunk", c.chunk.len(), BODY_CHUNK),
            R::JournalList(Ok(v)) => {
                res!(upto(n, "page", v.len(), JOURNAL_PAGE));
                for r in v {
                    res!(upto(n, "run", r.run.len(), WORD_WIRE_MAX));
                }
                Ok(())
            },
            _ => Ok(()),
        }
    }
}


// ┌───────────────────────────────────────────────────────────────┐
// │ Typed refusals                                                 │
// └───────────────────────────────────────────────────────────────┘

/// What the store answers in place of a call's own reply.
#[derive(Clone, Debug, Eq, PartialEq, ToDat, FromDat)]
pub enum Fault {
    Down(StoreDown),
    Busy(StoreBusy),
    Unbound(Unbound),
    Unknown(StoreUnknown),
}

impl Fault {
    /// The fault as the error a method that answers an `Outcome` returns.
    pub fn to_error(&self) -> Error<ErrTag> {
        match self {
            Self::Down(f)       => f.to_error(),
            Self::Busy(f)       => f.to_error(),
            Self::Unbound(f)    => f.to_error(),
            Self::Unknown(f)    => f.to_error(),
        }
    }
}

// Each typed refusal is an error whose words begin with its mark and which carries its tag, so it
// is known as itself under any frame a caller adds, and after the trip.
const DOWN_MARK:            &str = "The store is down";
const BUSY_MARK:            &str = "The store is busy";
const UNBOUND_MARK:         &str = "Not this run's Diamond";
const UNKNOWN_MARK:         &str = "Not known whether the store did it";
const UNREADABLE_MARK:      &str = "Unreadable";
const LINKS_CHANGED_MARK:   &str = "The links changed";

/// The store caught a panic, or missed its ping, and is poisoned: every call is refused until
/// the parent restarts it.
#[derive(Clone, Debug, Eq, PartialEq, ToDat, FromDat)]
pub struct StoreDown {
    pub why: String,
}

impl StoreDown {
    pub fn to_error(&self) -> Error<ErrTag> {
        err!("{}: {}. Every store call is refused until it restarts.", DOWN_MARK, self.why;
            Poisoned, Fatal)
    }
}

/// A call older than the caller's limit, answered for that caller alone (spec §16.5).  Whether it
/// took effect is not known.
#[derive(Clone, Debug, Eq, PartialEq, ToDat, FromDat)]
pub struct StoreBusy {
    pub call:   String,
    pub secs:   u64,
}

impl StoreBusy {
    pub fn to_error(&self) -> Error<ErrTag> {
        err!("{}: store.{} had no answer in {} s, and whether it took effect is not known: \
            read what it would change again before relying on it.",
            BUSY_MARK, self.call, self.secs;
            Timeout, Interrupted)
    }
}

/// **A call the store took and never answered** (QA1-C): the relay's backstop passed with no
/// answer, the store went down while it was owed, or its trip to the store broke after it was
/// sent.  The store may yet have done it, or have done it already, so it is never a failed
/// write: a child keeps what it holds for the act ([`unknown_seen`]), and what stands is read
/// again.  [`StoreBusy`] from the store itself is its own answer, and [`StoreDown`] is a call the
/// store never took.
#[derive(Clone, Debug, Eq, PartialEq, ToDat, FromDat)]
pub struct StoreUnknown {
    pub call:   String,
    pub why:    String,
}

impl StoreUnknown {
    pub fn to_error(&self) -> Error<ErrTag> {
        err!("{}: store.{} was taken by the store and not answered ({}). It may have taken \
            effect, so whether it did is not known: read what it would change again before \
            relying on it.", UNKNOWN_MARK, self.call, self.why;
            Interrupted, Unknown)
    }
}

thread_local! {
    /// How many [`StoreUnknown`] answers this thread has had: a child's runs share one thread, so
    /// a hold taken before an act knows whether an answer since was one (QA1-C).
    static UNKNOWN_SEEN: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

/// How many [`StoreUnknown`] answers this thread has had, for a hold to take before its act.
pub fn unknown_seen() -> u64 { UNKNOWN_SEEN.with(|c| c.get()) }

/// One more [`StoreUnknown`] answer on this thread, counted where a reply becomes an error.
pub fn note_unknown() { UNKNOWN_SEEN.with(|c| c.set(c.get().saturating_add(1))); }

/// The binding refusal: a call on a Diamond the caller's `RunEnv` does not grant, or a call a
/// door tag does not admit (spec §16.1).
#[derive(Clone, Debug, Eq, PartialEq, ToDat, FromDat)]
pub struct Unbound {
    pub call:   String,
    pub id:     String,
}

impl Unbound {
    pub fn to_error(&self) -> Error<ErrTag> {
        err!("{}: store.{} names the Diamond '{}', which this run was not granted.",
            UNBOUND_MARK, self.call, self.id;
            Unauthorised, Security)
    }
}

/// A path that could not be read for any reason but its absence: a refusal, a deadline, an I/O
/// error.  It is never read as gone (spec §16.2).
#[derive(Clone, Debug, Eq, PartialEq, ToDat, FromDat)]
pub struct Unreadable {
    pub path:   String,
    pub why:    String,
}

impl Unreadable {
    pub fn to_error(&self) -> Error<ErrTag> {
        err!("{}: '{}' could not be read ({}), so what stands there is not known.",
            UNREADABLE_MARK, self.path, self.why;
            IO, Read)
    }
}

/// A `links_page` asked under a stamp the sidecar no longer has: the walk starts again from row
/// 0 (D1k3 ruling 1).
pub fn links_changed() -> Error<ErrTag> {
    err!("{}: the sidecar was written since this walk began; start again from its first row.",
        LINKS_CHANGED_MARK;
        Invalid, Input)
}

pub fn is_links_changed(e: &Error<ErrTag>) -> bool {
    marked(e, LINKS_CHANGED_MARK, &ErrTag::Invalid)
}

pub fn is_store_down(e: &Error<ErrTag>) -> bool { marked(e, DOWN_MARK, &ErrTag::Poisoned) }
pub fn is_store_busy(e: &Error<ErrTag>) -> bool { marked(e, BUSY_MARK, &ErrTag::Timeout) }
pub fn is_store_unknown(e: &Error<ErrTag>) -> bool { marked(e, UNKNOWN_MARK, &ErrTag::Unknown) }
pub fn is_unbound(e: &Error<ErrTag>) -> bool { marked(e, UNBOUND_MARK, &ErrTag::Unauthorised) }
pub fn is_unreadable(e: &Error<ErrTag>) -> bool { marked(e, UNREADABLE_MARK, &ErrTag::Read) }

/// Does a frame of `e` open with `"<mark>: "` and carry `tag`?  Both on the same frame (D1k check
/// 2 fix #3), where a frame's tags include those the error wire put on the wordless frames it
/// splits beneath a frame of several tags.
fn marked(e: &Error<ErrTag>, mark: &str, tag: &ErrTag) -> bool {
    let opening = fmt!("{}: ", mark);
    let mut layer = Some(e);
    while let Some(l) = layer {
        let (m, next) = match l {
            Error::Local(m) | Error::Other(m)   => (m, None),
            Error::Upstream(_, m)               => (m, beneath(l)),
            Error::Collection(es)               => return es.iter().any(|e| marked(e, mark, tag)),
        };
        if words_of(&m.msg).starts_with(&opening) {
            let mut has = m.tags.contains(tag);
            let mut below = next;
            while let Some(Error::Local(b) | Error::Other(b) | Error::Upstream(_, b)) = below {
                if !words_of(&b.msg).trim().is_empty() {
                    break;
                }
                has |= b.tags.contains(tag);
                below = below.and_then(beneath);
            }
            if has {
                return true;
            }
        }
        layer = next;
    }
    false
}

/// The first error of ours beneath `e`'s own frame, as `Error::msgs` walks to it.
fn beneath(e: &Error<ErrTag>) -> Option<&Error<ErrTag>> {
    let c = match e {
        Error::Upstream(c, _) => c,
        _ => return None,
    };
    if let Some(ours) = c.downcast_ref::<Error<ErrTag>>() {
        return Some(ours);
    }
    let mut cause = c.source();
    while let Some(c) = cause {
        if let Some(ours) = c.downcast_ref::<Error<ErrTag>>() {
            return Some(ours);
        }
        cause = c.source();
    }
    None
}

/// A frame's words without the `file:line: ` that `err!` opens it with.
fn words_of(msg: &str) -> &str {
    let located = |s: &str| match s.rsplit_once(':') {
        Some((file, line)) =>
            !file.is_empty() && !line.is_empty() && line.chars().all(|c| c.is_ascii_digit()),
        None => false,
    };
    match msg.split_once(": ") {
        Some((head, tail)) if located(head) => tail,
        _ => if located(msg) { "" } else { msg },
    }
}

#[cfg(test)]
#[path = "call_tests.rs"]
mod tests;
/// A method's `Err` and a fault are refusals; an `Ok` is not (D1mem fix B: a refused call's
/// uploads are taken back).
#[cfg(test)]
#[test]
fn a_refusal_is_told_from_an_answer() {
    assert!(is_refusal(&StoreReply::TurnAdd(Err(err!("no"; Invalid, Input)))), "an Err");
    assert!(!is_refusal(&StoreReply::TurnAdd(Ok(()))), "an Ok");
}
