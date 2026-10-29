//! The store port: the Diamond store and the run journals.

use crate::{
    agent::compact::FoldNotes,
    diamond_link::Unlink,
    diamond_versions::{
        Act, Body, Cause, Change, Found, OpenDelete, Route, Seen, Short, TurnFound,
        VERSION_FILE_MAX,
    },
    engine::host::{Host, fs::HostFs, types::store::{CrystalHalf, Landed, SettlePhase}},
    marks::{Live, Reach},
    rating::Author,
    tools::{Bound, CrystalPassed, FileRoot, ToolContext},
};

use oxedyne_fe2o3_core::prelude::*;

use std::{
    cell::RefCell,
    collections::{BTreeMap, BTreeSet},
    sync::atomic::{AtomicU64, Ordering},
};

pub use crate::engine::host::types::store::{Drained, JournalKey, JournalRun, LIST_PAGE};

/// The store port a [`Host`](super::Host) carries: one method per free function of
/// `crate::wasm::diamond` a tool reaches, of the same name, arguments and kind, plus
/// `entry::trail` and `marks::live_bounds`, and the turn-end group the session's turn end drives
/// (`hold_versions` to `end_turn_counts`).
///
/// **The store writes only its own area.**  Its mutators take no `&Licence`, because they never
/// write a user's path: they write the store's own records under `FileRoot::Opfs`, as
/// `wasm::diamond` does through its plain `opfs::write_file`.  A path argument names the file a
/// record is ABOUT, never one the store writes.  `standing_retired` is the one method that names a
/// root: `file_write` and `file_edit` pass the turn's own, and a path that is not a standing file
/// writes nothing.  For a standing file TestHost panics on any root but `FileRoot::Opfs`.
///
/// A host without a store (LocalHost, TestHost) answers every gate with the value that refuses
/// or holds (u2_plan §9.2), and every `Outcome` with
/// `"store.<method> is not available on this build"`.
#[allow(async_fn_in_trait)]
pub trait HostStore {
    /// The window [`open_window`](Self::open_window) opens around one call.
    type Window;
    /// The versions hold a turn end records under, released on drop.
    type Hold;
    /// A steer counted as running on a Diamond until this is dropped.
    type Steer;
    /// A path marked dirty before a page door's act, taken at the turn end.
    type Marked;

    // Crystal
    async fn read_crystal_data(&self, id: &str) -> Outcome<String>;
    async fn read_crystal_data_strict(&self, id: &str) -> Outcome<String>;
    async fn read_crystal_page(&self, id: &str) -> Outcome<String>;
    async fn read_crystal_page_strict(&self, id: &str) -> Outcome<String>;
    fn crystal_half(&self, id: &str, path: &str) -> Option<CrystalHalf>;
    async fn crystal_undo_target(&self, id: &str, half: CrystalHalf, at: Option<u64>)
        -> Outcome<Option<(u64, String)>>;
    async fn hot_refusals(&self, id: &str) -> u32;
    async fn set_hot_refusals(&self, id: &str, n: u32) -> Outcome<()>;
    /// The newest crystal that parses, to measure a write's hot part against when `old` will
    /// not; empty where `old` parses or none does.
    async fn crystal_hot_last_good(&self, id: &str, old: &str) -> String;
    async fn last_passed(&self, id: &str) -> Option<CrystalPassed>;
    async fn mark_passed(&self, id: &str, version: u64, page: &str, data: &str, debug: u32)
        -> Outcome<CrystalPassed>;

    // Standing files and folds
    /// Only reads: the write as it will land, with its side files held back (UNBLOCK-18 F6).
    async fn standing_retired(&self, root: FileRoot, path: &str, text: String)
        -> Outcome<Landed>;
    /// Write one phase of an accepted landing's side files: `Archive` (only `.daimond/`
    /// archives, called under the target's lock, before it is written), or `Record` (noted →
    /// DECISIONS.md, touched rows; called after the target has landed).  `landed` is the whole
    /// landing: only `phase`'s part of it is written, and nothing in the phase settles nothing
    /// and sends nothing.
    async fn standing_settle(&self, root: FileRoot, path: &str, landed: &Landed,
        phase: SettlePhase) -> Outcome<()>;
    async fn absorb_fold_notes(&self, id: &str, notes: &FoldNotes) -> Option<FoldNotes>;
    /// File `entries` (`compact::log_entries`) into the words log of the keeper's notes file,
    /// made if absent, then read it back: see `compact::log_answer` for what is answered.
    async fn his_words(&self, keeper: &str, entries: String) -> Outcome<String>;
    /// The keeper's words log whole, for `recall`; empty for none.
    async fn his_words_read(&self, keeper: &str) -> Outcome<String>;

    // Links
    async fn add_link(
        &self,
        owner: &str,
        from:  &str,
        to:    &str,
        rel:   &str,
        note:  &str,
        by:    &str,
    )
        -> Outcome<String>;
    async fn all_links(&self) -> Outcome<String>;
    async fn links_json(&self, node_ref: &str) -> Outcome<String>;
    async fn remove_link_by_model(&self, owner: &str, link_id: &str) -> Outcome<Unlink>;
    async fn diamond_exists(&self, id: &str) -> bool;

    // The activity record and the no-progress K (C2 MEMORY, UNBLOCK-27 R4; PORT-PL-B)
    async fn activity_read_all(&self, id: &str) -> Vec<(String, String)>;
    async fn activity_append(&self, id: &str, turn: crate::activity::Turn, now: i64)
        -> Outcome<()>;
    async fn no_progress_rounds(&self, id: &str) -> usize;

    // A turn's captures and copies
    /// An `Err` is a capture the store did not keep: the act stands, and its answer says so (D1int).
    fn capture(&self, id: &str, raw: &str, change: Change) -> Outcome<()>;
    fn captured_room(&self, id: &str, path: &str, found: &Found, copy: Option<u64>,
        destroying: bool, room: u64) -> Result<bool, Short>;
    async fn keep_room(&self, id: &str) -> u64;
    fn release(&self, id: &str, path: &str);
    fn held_under(&self, id: &str, from: &str) -> Vec<(String, String, String)>;
    async fn this_turn_found(&self, id: &str, path: &str, now: &[u8]) -> TurnFound;
    async fn turns_found(&self, id: &str, path: &str, now: &[u8]) -> Option<Vec<u8>>;
    async fn measured_against(&self, id: &str, path: &str, now: &[u8]) -> Vec<u8>;
    fn seals_spent(&self, id: &str, path: &str, now: &[u8]) -> bool;
    async fn seal_run(&self, id: &str, path: &str, now: &[u8]) -> Outcome<()>;
    async fn pend(&self, id: &str, path: &str, before: &[u8], deleting: bool, mark: bool)
        -> Outcome<bool>;
    async fn unpend(&self, id: &str, path: &str);
    fn ran_opaque(&self, id: &str);
    async fn note_output(&self, id: &str, tool: &str, path: &str, bytes: &[u8]);
    async fn output_is_own(&self, id: &str, tool: &str, path: &str, bytes: &[u8]) -> bool;
    /// The files the Diamond's file tools last wrote, each with the sha256 of what they left
    /// ([`crate::diamond_versions::made_by_diamond`]): what an exec request's `made` names.
    /// An `Err` is the store's refusal, which the caller says (LOUD-FAIL); it then sends none.
    async fn made_files(&self, id: &str) -> Outcome<Vec<(String, String)>>;
    /// Keep what one command `by` ran made, as the hand's write meter reported it, for the turn's
    /// record ([`crate::diamond_versions::ran_rows`], MADE-2).  Best effort: a file not kept is
    /// the user's to the next command, which is the safe side; an `Err` is the store's refusal,
    /// which the turn end says in the asker's transcript (LOUD-FAIL).
    async fn ran_made(&self, id: &str, by: Option<Author>, files: Vec<(String, String, bool)>,
        capped: bool) -> Outcome<()>;
    fn theirs(&self, id: &str, path: &str) -> bool;
    fn folder_of(&self, path: &str) -> Option<String>;
    fn versionable(&self, id: &str, path: &str) -> bool;

    // The change gate (UNBLOCK-26)
    /// Is the file at `path`, as `now` holds it, the user's rather than this Diamond's own
    /// ([`crate::store::diamond::authored_by_user`])?  A host without a store answers yes: when
    /// unsure, the file is his.  `below` judges a turn kept as that version, by the manifests
    /// before it; `None` is a live act's question.
    async fn authored_by_user(&self, id: &str, path: &str, now: &[u8], below: Option<u64>) -> bool;
    /// Did the person decline, this turn, a change at `path` or around it
    /// ([`crate::diamond_versions::ChangeRefusals::refused`])?
    fn change_refused(&self, id: &str, path: &str) -> bool;
    /// Record that the person declined a change at `path`, for the rest of the turn.
    fn refuse_change(&self, id: &str, path: &str);

    // Deletes from the open folder
    fn open_delete_room(&self, id: &str, file: &str) -> OpenDelete;
    fn open_delete_answer(&self, id: &str, ticket: u64, allow: bool);
    fn open_delete_release(&self, id: &str, file: &str);

    // Windows around a call
    async fn open_window(&self, id: &str, by: Option<Author>) -> Self::Window;
    async fn close_window(&self, around: Self::Window);

    // Versions
    /// One change a call, by type: a record of several is several calls.  So the bodies one call
    /// uploads (a note's and a change's three) stay within the store's `STAGE_MAX` (D1r1e).
    async fn versions_record(
        &self,
        id:      &str,
        cause:   Cause,
        turn:    &str,
        note:    &str,
        change:  Change,
    )
        -> Outcome<Option<(u64, Vec<String>)>>;
    async fn versions_body(&self, id: &str, hash: &str) -> Outcome<Option<Vec<u8>>>;
    async fn versions_undo_target(&self, id: &str, path: &str, at: Option<u64>)
        -> Outcome<Option<(u64, String, bool, Option<String>)>>;

    // Restores
    fn route_here(&self, row: &str, row_folder: Option<&str>, landed: &str, overwrites: bool)
        -> Route;
    fn restore_store(&self, ticket: u64) -> Option<String>;
    fn restore_route(
        &self,
        ticket:  u64,
        spelled: &str,
        landed:  &str,
        now:     Option<&[u8]>,
        puts:    Option<&[u8]>,
    )
        -> Act;
    fn restore_look(&self, ticket: u64, spelled: &str, now: Seen) -> Option<bool>;
    fn restore_asked(&self, ticket: u64, spelled: &str, now: Seen);
    async fn restore_keep(&self, ticket: u64, path: &str, now: Option<&[u8]>, deleting: bool)
        -> Outcome<()>;
    async fn restore_let_go(&self, ticket: u64, path: &str);
    /// An `Err` is a landing the store did not keep for the restore's record, as `capture`'s.
    fn restore_landed(&self, ticket: u64, change: Change) -> Outcome<()>;

    // The turn end (spec §16.3a 1).  The turn's changes stay store-side, in a slot under the
    // `Hold`, from `drain_turn` until `versions_record_held` records and settles them: only counts
    // and paths cross.  Dropping the hold frees the slot with its notes unsettled.
    async fn hold_versions(&self, id: &str) -> Outcome<Self::Hold>;
    /// An `Err` is the store refusing the ask: the turn end says it and records nothing
    /// (LOUD-FAIL), never taking it for "a steer runs".
    fn is_steering(&self, id: &str) -> Outcome<bool>;
    fn steering(&self, id: &str) -> Self::Steer;
    fn drain_dirty(&self, id: &str) -> Vec<Self::Marked>;
    async fn dirty_changes(&self, id: &str, dirty: Vec<Self::Marked>) -> Vec<Change>;
    /// Takes the turn's captures, notes and left raws into the hold's slot.
    async fn drain_turn<H: Host>(&self, hold: &Self::Hold, id: &str, ctx: &ToolContext<H>)
        -> Outcome<Drained>;
    /// The ledger paths (see [`ledger_paths`]) no slot capture or left raw covers, in `wrote`'s
    /// order.  A pure read of at most [`LIST_PAGE`] paths.
    async fn turn_uncovered(&self, hold: &Self::Hold, id: &str, wrote: &[String])
        -> Outcome<Vec<String>>;
    /// One ledger-named change, `by` already set, appended to the slot.
    async fn turn_add(&self, hold: &Self::Hold, id: &str, change: Change) -> Outcome<()>;
    /// Credits the open windows against the slot's captures and appends what moved.
    async fn drain_windows(&self, hold: &Self::Hold, id: &str) -> Outcome<u32>;
    /// Records the slot as `added ++ captured ++ windowed`, then settles its notes on `Ok`.
    async fn versions_record_held(
        &self,
        hold:    &Self::Hold,
        id:      &str,
        at:      Option<u64>,
        cause:   Cause,
        turn:    &str,
        note:    &str,
    )
        -> Outcome<Option<(u64, Vec<String>)>>;
    async fn record_steer(&self, hold: &Self::Hold, id: &str, json: &str, instruction: &str)
        -> Outcome<u64>;
    fn end_turn_counts(&self, id: &str);
    /// Told once at each keeper's turn end the engine drives (`engine::turn::end_keeper_turn`),
    /// before anything is asked; a host that keeps no count ignores it.
    fn keeper_turn_ended(&self, _id: &str) {}

    // Marks and the trail
    async fn live_bounds(&self, live: &Live) -> Outcome<Vec<Bound>>;
    /// What `target` reaches on this device now, read afresh; `marks::UNREAD` where the record
    /// cannot be read (FAIL CLOSED).
    async fn reach(&self, target: &Live) -> Outcome<Reach>;
    fn trail(&self, what: &str, detail: &str);

    // The run journals (U4c, spec §4.4, X2): SETTLED ROUNDS ONLY, one record per round, keyed by
    // run and round under `JOURNAL_ROOT`, the store's own area.  The actor writes each round as it
    // settles and drops the run's journal when the run settles and when its report is
    // acknowledged.  A host without a store refuses all three.
    async fn journal_put(&self, run: &str, round: u64, record: &[u8]) -> Outcome<()>;
    /// Every record of `run`, by round, oldest first; none for a run with no journal.
    async fn journal_read(&self, run: &str) -> Outcome<Vec<(u64, Vec<u8>)>>;
    /// Drops every record of `run`; a run with no journal is already dropped.
    async fn journal_drop(&self, run: &str) -> Outcome<()>;
}

/// Where the store keeps the run journals: `<JOURNAL_ROOT>/<run>/<round>` (`APP_STATE_DIRS`).
pub const JOURNAL_ROOT: &str = "system/journal";

/// The directory of run `run`'s journal, or a refusal for a run id that would name another place.
pub fn journal_dir(run: &str) -> Outcome<String> {
    let fits = !run.is_empty() && run.len() <= 128 && run != "." && run != ".."
        && run.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.');
    if !fits {
        return Err(err!("A run id '{}' cannot name a journal.", run; Invalid, Input));
    }
    Ok(fmt!("{}/{}", JOURNAL_ROOT, run))
}

/// The key of round `round` of run `run`: zero-padded, so a listing sorts by round.
pub fn journal_key(run: &str, round: u64) -> Outcome<String> {
    journal_path(run, JournalKey::Round(round))
}

/// The name of the parent's open record in a run's journal (R1i): never a number, so no reader
/// of the rounds takes it for one.
pub const JOURNAL_OPEN: &str = "open";

/// Where record `key` of run `run` is kept.
pub fn journal_path(run: &str, key: JournalKey) -> Outcome<String> {
    let dir = res!(journal_dir(run));
    Ok(match key {
        JournalKey::Round(r)    => fmt!("{}/{:020}", dir, r),
        JournalKey::Open        => fmt!("{}/{}", dir, JOURNAL_OPEN),
    })
}

/// The most one round's record may be: what the store stages of one upload (U4e).
pub const JOURNAL_ROUND_MAX: usize = 64 << 20;

/// Writes round `round` of `run` over the store backend `b`: the tab's OPFS, the store server's
/// Ozone or memory store (U4e, one body for all three).
pub async fn journal_write<B: crate::store::StoreBackend>(b: &B, run: &str, round: u64,
    record: &[u8]) -> Outcome<()>
{
    journal_write_at(b, run, JournalKey::Round(round), record).await
}

/// Writes record `key` of `run` over `b`: a round, or the parent's open record (R1i).
pub async fn journal_write_at<B: crate::store::StoreBackend>(b: &B, run: &str, key: JournalKey,
    record: &[u8]) -> Outcome<()>
{
    if record.len() > JOURNAL_ROUND_MAX {
        return Err(err!("A journal record of {} bytes is over the {} one may be.",
            record.len(), JOURNAL_ROUND_MAX; TooBig, Input));
    }
    let path = res!(journal_path(run, key));
    b.write_file(&path, record).await
}

/// The parent's open record of `run` over `b`, if there is one (R1i).
pub async fn journal_open<B: crate::store::StoreBackend>(b: &B, run: &str)
    -> Outcome<Option<Vec<u8>>>
{
    let path = res!(journal_path(run, JournalKey::Open));
    if !res!(b.exists(&path).await) {
        return Ok(None);
    }
    Ok(Some(res!(b.read_file(&path).await)))
}

/// The rounds `run`'s journal holds over `b`, in order; none for a run with no journal.
pub async fn journal_rounds<B: crate::store::StoreBackend>(b: &B, run: &str) -> Outcome<Vec<u64>> {
    let dir = res!(journal_dir(run));
    if !res!(b.exists(&dir).await) {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for (name, is_dir, _) in res!(b.list_dir(&dir).await) {
        if let (false, Ok(r)) = (is_dir, name.parse::<u64>()) {
            out.push(r);
        }
    }
    out.sort_unstable();
    Ok(out)
}

/// Round `round` of `run` over `b`.
pub async fn journal_load<B: crate::store::StoreBackend>(b: &B, run: &str, round: u64)
    -> Outcome<Vec<u8>>
{
    let key = res!(journal_key(run, round));
    b.read_file(&key).await
}

/// Every record of `run` over `b`, by round, oldest first.
pub async fn journal_all<B: crate::store::StoreBackend>(b: &B, run: &str)
    -> Outcome<Vec<(u64, Vec<u8>)>>
{
    let mut out = Vec::new();
    for round in res!(journal_rounds(b, run).await) {
        out.push((round, res!(journal_load(b, run, round).await)));
    }
    Ok(out)
}

/// At most `max` of the runs that have a journal over `b`, in order, after the run `after` (R1i),
/// each with whether it holds the parent's open record: the names under `JOURNAL_ROOT` and one
/// look for each one's open record, never a read of a round.
pub async fn journal_runs<B: crate::store::StoreBackend>(b: &B, after: Option<&str>, max: usize)
    -> Outcome<Vec<JournalRun>>
{
    if !res!(b.exists(JOURNAL_ROOT).await) {
        return Ok(Vec::new());
    }
    let mut names: Vec<String> = res!(b.list_dir(JOURNAL_ROOT).await).into_iter()
        .filter(|(name, is_dir, _)| *is_dir && after.is_none_or(|a| name.as_str() > a)
            && journal_dir(name).is_ok())
        .map(|(name, _, _)| name)
        .collect();
    names.sort_unstable();
    names.truncate(max);
    let mut out = Vec::with_capacity(names.len());
    for run in names {
        let open = res!(b.exists(&res!(journal_path(&run, JournalKey::Open))).await);
        out.push(JournalRun { run, open });
    }
    Ok(out)
}

/// Drops `run`'s journal over `b`; a run with none is already dropped.
pub async fn journal_clear<B: crate::store::StoreBackend>(b: &B, run: &str) -> Outcome<()> {
    let dir = res!(journal_dir(run));
    if !res!(b.exists(&dir).await) {
        return Ok(());
    }
    b.delete_entry(&dir, true).await
}

// ── The turn slot (spec §16.3a 1) ────────────────────────────────────────

/// The paths a turn's ledger lines name: a move is one line naming two paths, and both moved.
/// What the engine pages through [`HostStore::turn_uncovered`].
pub fn ledger_paths(wrote: &[String]) -> Vec<String> {
    let mut paths = Vec::new();
    for line in wrote.iter() {
        for half in line.split(" -> ") {
            let half = half.trim();
            if !half.is_empty() {
                paths.push(half.to_string());
            }
        }
    }
    paths
}

/// One ledger-named path as the change the store's own `diamond::versions_changes` makes of it
/// (`store/diamond.rs`, `versions_changes_in`), asked through the ports: `None` where the store
/// does not version the path ([`HostStore::versionable`]); else marked by [`HostStore::theirs`],
/// its body read capped at [`VERSION_FILE_MAX`], a larger file `TooLarge` at its size, and `by`
/// set.  **Not read is not the same as not there** (spec §16.2): `Gone` only where the fs says the
/// file is not there, `Unseen` where it cannot say either.
pub async fn named_change<S: HostStore, F: HostFs>(
    store:  &S,
    fs:     &F,
    id:     &str,
    path:   &str,
    by:     Option<Author>,
)
    -> Option<Change>
{
    if !store.versionable(id, path) {
        return None;
    }
    let mark = store.theirs(id, path);
    let ch = match fs.read_file_capped(FileRoot::Workspace, path, VERSION_FILE_MAX as u32).await {
        Ok((body, total)) if total as usize <= VERSION_FILE_MAX =>
            Change { mark, ..Change::of(path, body) },
        Ok((_, total)) => Change {
            after: Body::TooLarge(total as u64),
            mark,
            ..Change::gone(path)
        },
        Err(_) => match fs.exists(FileRoot::Workspace, path).await {
            Ok(false) => Change { mark, ..Change::gone(path) },
            _         => Change { after: Body::Unseen, mark, ..Change::gone(path) },
        },
    };
    Some(Change { by, ..ch })
}

/// The engine's ledger step of a turn end (`app.rs` 3955-3994): each path the turn's ledger
/// names ([`ledger_paths`]) that no capture covers, paged through [`HostStore::turn_uncovered`],
/// made by [`named_change`] and appended by [`HostStore::turn_add`].  Answers how many it added.
pub async fn turn_named<S: HostStore, F: HostFs>(
    store:  &S,
    fs:     &F,
    hold:   &S::Hold,
    id:     &str,
    wrote:  &[String],
    by:     &Option<Author>,
)
    -> Outcome<u32>
{
    let paths = ledger_paths(wrote);
    let mut added = 0;
    for page in paths.chunks(LIST_PAGE) {
        for path in res!(store.turn_uncovered(hold, id, page).await).iter() {
            if let Some(ch) = named_change(store, fs, id, path, by.clone()).await {
                res!(store.turn_add(hold, id, ch).await);
                added += 1;
            }
        }
    }
    Ok(added)
}

/// One turn end, kept store-side from `drain_turn` until `versions_record_held` consumes it.
///
/// **A call that awaits keeps the slot in the table, marked busy**, with its contents taken out
/// for the await.  Any call that finds it busy is refused, so no call can drain, add to or
/// record a turn end another call is still working on (d1_plan §9.11, D1p2 check rider 1).
#[derive(Debug, Default)]
struct TurnSlot {
    hold:     u64,                      // the serial of the hold that owns it
    busy:     bool,                     // a call awaits with its contents
    captured: Vec<(String, Change)>,    // (raw, change), as `drain_turn` took them
    notes:    Vec<String>,              // settled once recorded
    left:     Vec<String>,              // the raws a sealed or noted capture left
    added:    Vec<Change>,              // the ledger-named changes `turn_add` appended
    windowed: Vec<Change>,              // what `drain_windows` credited
}

impl TurnSlot {
    /// The order `app.rs` 3977-3982 records: the ledger's, the captures', the windows'.
    fn changes(self) -> (Vec<Change>, Vec<String>) {
        let mut changes = self.added;
        changes.extend(self.captured.into_iter().map(|(_, ch)| ch));
        changes.extend(self.windowed);
        (changes, self.notes)
    }
}

thread_local! {
    // One slot per Diamond, as there is one hold per Diamond at a time.
    static SLOTS: RefCell<BTreeMap<String, TurnSlot>> = RefCell::new(BTreeMap::new());
}

/// How many turn slots are open on this thread, for the store server's tests.
#[cfg(test)]
pub fn slot_count() -> usize { SLOTS.with(|s| s.borrow().len()) }

static HOLD_SERIAL: AtomicU64 = AtomicU64::new(1);

/// A store's own version hold, owning the turn slot of its Diamond in this thread.  Dropped, it
/// frees the slot with its notes unsettled: the next turn end adopts them.
#[derive(Debug)]
pub struct SlotHold<T> {
    held:   T,
    id:     String,
    serial: u64,
}

impl<T> SlotHold<T> {
    pub fn new(held: T, id: &str) -> Self {
        Self { held, id: id.to_string(), serial: HOLD_SERIAL.fetch_add(1, Ordering::Relaxed) }
    }
    pub fn held(&self) -> &T { &self.held }
    /// The Diamond whose version store this holds.
    pub fn id(&self) -> &str { &self.id }
}

impl<T> Drop for SlotHold<T> {
    fn drop(&mut self) {
        // A hold dropped as its thread ends may outlive the table: nothing is left to free, and
        // a drop must never panic there (D1p2 check rider 2).
        let serial = self.serial;
        let _ = SLOTS.try_with(|slots| {
            if let Ok(mut slots) = slots.try_borrow_mut() {
                if matches!(slots.get(&self.id), Some(slot) if slot.hold == serial) {
                    slots.remove(&self.id);
                }
            }
        });
    }
}

/// The store's own turn-end calls the slot composes: WasmHost's are `wasm::diamond`'s.
#[allow(async_fn_in_trait)]
pub trait TurnStore {
    type Held;
    async fn drain<H: Host>(&self, held: &Self::Held, id: &str, ctx: &ToolContext<H>)
        -> (Vec<(String, Change)>, Vec<String>, Vec<String>);
    async fn windows(&self, id: &str, held: &[(String, Change)]) -> Vec<Change>;
    async fn record(
        &self,
        held:    &Self::Held,
        id:      &str,
        at:      Option<u64>,
        cause:   Cause,
        turn:    &str,
        note:    &str,
        changes: Vec<Change>,
    )
        -> Outcome<Option<(u64, Vec<String>)>>;
    async fn settle(&self, id: &str, names: &[String]);
}

fn held_for<T>(hold: &SlotHold<T>, id: &str) -> Outcome<()> {
    if hold.id != id {
        return Err(err!("store: the hold is for Diamond '{}', not '{}'", hold.id, id;
            Invalid, Input));
    }
    Ok(())
}

fn not_drained(id: &str) -> Error<ErrTag> {
    err!("store: no turn of Diamond '{}' is drained under this hold", id; Missing, Data)
}

fn slot_busy(id: &str) -> Error<ErrTag> {
    err!("store: the turn end of Diamond '{}' is busy with another call under this hold", id;
        Conflict, Invalid)
}

/// Runs `f` on the slot `hold` owns, refused where there is none or it is busy.
fn with_slot<T, R>(hold: &SlotHold<T>, id: &str, f: impl FnOnce(&mut TurnSlot) -> Outcome<R>)
    -> Outcome<R>
{
    res!(held_for(hold, id));
    SLOTS.with(|slots| {
        let mut slots = slots.borrow_mut();
        match slots.get_mut(id) {
            Some(slot) if slot.hold == hold.serial && slot.busy => Err(slot_busy(id)),
            Some(slot) if slot.hold == hold.serial              => f(slot),
            _                                                   => Err(not_drained(id)),
        }
    })
}

/// Marks the slot `hold` owns busy and takes its contents out, for a call that awaits with them.
/// The busy slot stays in the table, so a call made meanwhile is refused.
fn take_busy<T>(hold: &SlotHold<T>, id: &str) -> Outcome<TurnSlot> {
    with_slot(hold, id, |slot| {
        let taken = std::mem::take(slot);
        slot.hold = taken.hold;
        slot.busy = true;
        Ok(taken)
    })
}

/// Puts back the contents [`take_busy`] took, clearing busy.  Where the hold was dropped during
/// the await, the slot is gone and the contents go with it, notes unsettled, as a dropped hold's.
fn put_back<T>(hold: &SlotHold<T>, id: &str, mut contents: TurnSlot) {
    SLOTS.with(|slots| {
        let mut slots = slots.borrow_mut();
        if let Some(slot) = slots.get_mut(id) {
            if slot.hold == hold.serial && slot.busy {
                contents.hold = hold.serial;
                contents.busy = false;
                *slot = contents;
            }
        }
    });
}

/// Ends the busy slot `hold` owns: the record consumed it.
fn end_busy<T>(hold: &SlotHold<T>, id: &str) {
    SLOTS.with(|slots| {
        let mut slots = slots.borrow_mut();
        if matches!(slots.get(id), Some(slot) if slot.hold == hold.serial && slot.busy) {
            slots.remove(id);
        }
    });
}

/// [`HostStore::drain_turn`] over a [`TurnStore`].  A second drain under one hold is refused, so
/// no capture is drained into a slot that then loses it; the slot is in the table, busy, from
/// before the drain awaits.
pub async fn slot_drain_turn<S: TurnStore, H: Host>(
    store: &S,
    hold:  &SlotHold<S::Held>,
    id:    &str,
    ctx:   &ToolContext<H>,
)
    -> Outcome<Drained>
{
    slot_drain_by(hold, id, store.drain(hold.held(), id, ctx)).await
}

/// [`slot_drain_turn`] for a caller with no [`TurnStore`] (the native store server, which has no
/// `ToolContext`): `fut` is the drain, yielding `(captured, notes, left)`, and is not started
/// unless the hold may drain.
pub async fn slot_drain_by<T, F>(hold: &SlotHold<T>, id: &str, fut: F) -> Outcome<Drained>
    where F: std::future::Future<Output = (Vec<(String, Change)>, Vec<String>, Vec<String>)>
{
    res!(held_for(hold, id));
    let owned = SLOTS.with(|slots| {
        let mut slots = slots.borrow_mut();
        if let Some(slot) = slots.get(id) {
            if slot.hold == hold.serial {
                return true;
            }
        }
        slots.insert(id.to_string(), TurnSlot { hold: hold.serial, busy: true,
            ..Default::default() });
        false
    });
    if owned {
        return Err(err!("store: the turn of Diamond '{}' is already drained under this hold", id;
            Invalid, Input));
    }
    let (captured, notes, left) = fut.await;
    let count = captured.len() as u32;
    put_back(hold, id, TurnSlot { captured, notes, left, ..Default::default() });
    Ok(Drained { captured: count })
}

/// A slot's contents, taken out busy by [`slot_take`] for a caller that awaits with them, and
/// given back with [`slot_put`] or consumed by [`slot_changes`] and [`slot_end`].
#[derive(Debug)]
pub struct Busy(TurnSlot);

impl Busy {
    /// The captures `drain_turn` took, which the open windows are credited against.
    pub fn captured(&self) -> &[(String, Change)] { &self.0.captured }

    /// Append what the open windows moved.
    pub fn window(&mut self, moved: Vec<Change>) { self.0.windowed.extend(moved) }
}

/// Mark the slot `hold` owns busy and take its contents out: refused where there is none, or
/// another call has it.
pub fn slot_take<T>(hold: &SlotHold<T>, id: &str) -> Outcome<Busy> {
    take_busy(hold, id).map(Busy)
}

/// Put `busy` back in the slot `hold` owns, or drop it with its notes unsettled where the slot
/// went meanwhile.
pub fn slot_put<T>(hold: &SlotHold<T>, id: &str, busy: Busy) { put_back(hold, id, busy.0) }

/// What `busy` records, in the order the record takes ([`slot_record`]), and the notes it
/// settles once recorded.
pub fn slot_changes(busy: Busy) -> (Vec<Change>, Vec<String>) { busy.0.changes() }

/// End the busy slot `hold` owns: the record consumed it.
pub fn slot_end<T>(hold: &SlotHold<T>, id: &str) { end_busy(hold, id) }

/// [`HostStore::turn_uncovered`] over the slot.
pub fn slot_uncovered<T>(hold: &SlotHold<T>, id: &str, wrote: &[String]) -> Outcome<Vec<String>> {
    res!(held_for(hold, id));
    if wrote.len() > LIST_PAGE {
        return Err(err!("store: {} paths in one page, over the {} a page holds", wrote.len(),
            LIST_PAGE; Invalid, Input, TooBig));
    }
    with_slot(hold, id, |slot| {
        let covered: BTreeSet<&str> = slot.captured.iter().map(|(raw, _)| raw.as_str())
            .chain(slot.left.iter().map(|raw| raw.as_str()))
            .collect();
        Ok(wrote.iter().filter(|path| !covered.contains(path.as_str())).cloned().collect())
    })
}

/// [`HostStore::turn_add`] over the slot.
pub fn slot_add<T>(hold: &SlotHold<T>, id: &str, change: Change) -> Outcome<()> {
    with_slot(hold, id, |slot| {
        slot.added.push(change);
        Ok(())
    })
}

/// [`HostStore::drain_windows`] over a [`TurnStore`]: refused where the hold owns no slot, or
/// another call has it.
pub async fn slot_drain_windows<S: TurnStore>(store: &S, hold: &SlotHold<S::Held>, id: &str)
    -> Outcome<u32>
{
    let mut slot = res!(take_busy(hold, id));
    let moved = store.windows(id, &slot.captured).await;
    let count = moved.len() as u32;
    slot.windowed.extend(moved);
    put_back(hold, id, slot);
    Ok(count)
}

/// [`HostStore::versions_record_held`] over a [`TurnStore`]: consumes the slot, and settles its
/// notes only once the record is written, still under the hold, so no other turn end adopts a
/// note about to be settled.  A note outliving a failed record is adopted by the next turn end.
pub async fn slot_record<S: TurnStore>(
    store: &S,
    hold:  &SlotHold<S::Held>,
    id:    &str,
    at:    Option<u64>,
    cause: Cause,
    turn:  &str,
    note:  &str,
)
    -> Outcome<Option<(u64, Vec<String>)>>
{
    let slot = res!(take_busy(hold, id));
    let (changes, notes) = slot.changes();
    let recorded = store.record(hold.held(), id, at, cause, turn, note, changes).await;
    if recorded.is_ok() {
        store.settle(id, &notes).await;
    }
    end_busy(hold, id);
    recorded
}

#[cfg(test)]
#[path = "../../../tests/unit/engine/host/store/turn_slot.rs"]
mod turn_slot;
