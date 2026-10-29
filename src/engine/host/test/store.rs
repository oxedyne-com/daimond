//! TestHost's store port.

use crate::{
    agent::compact::FoldNotes,
    diamond_link::Unlink,
    diamond_versions::{Act, Cause, Change, Found, OpenDelete, Route, Seen, Short, TurnFound},
    engine::host::{
        Host,
        store::{Drained, HostStore},
        types::store::{CrystalHalf, Landed, SettlePhase},
    },
    marks::{Live, Reach},
    rating::Author,
    tools::{Bound, CrystalPassed, FileRoot, ToolContext},
};

use oxedyne_fe2o3_core::prelude::*;

use std::{
    cell::{Cell, RefCell},
    collections::BTreeSet,
    rc::Rc,
};

/// TestHost's store port: no store, so it fails closed exactly as LocalHost's does (u2_plan
/// §9.2), and it holds the store to its own area: a write naming a user's root panics.  It counts
/// the keeper turn ends it is told of, shared on clone.
#[derive(Clone, Debug, Default)]
pub struct TestStore {
    keeper_ends: Rc<Cell<u32>>,
    gate:        Rc<RefCell<Gate>>,
    settled:     Rc<RefCell<Vec<(String, SettlePhase)>>>,  // each settle asked, in order
    held:        Rc<RefCell<Held>>,                         // a Diamond this store holds (KT-3)
    notes:       Rc<RefCell<Notes>>,                        // keepers' notes files (CCP2-FOLDFIX2)
}

/// The notes files a test lets this store keep, by keeper: none kept, the words log refuses as
/// before.
#[derive(Debug, Default)]
struct Notes {
    keeps:  bool,
    files:  std::collections::BTreeMap<String, String>,
}

/// The one Diamond a test may have this store hold: its crystal and its own K (KT-3).  None held,
/// the crystal read refuses and K is zero, as before.
#[derive(Debug, Default)]
struct Held {
    crystal: Option<String>,
    k:       usize,
}

/// What a test sets the change gate's store side to (UNBLOCK-26).  By default the store keeps
/// nothing, so every claim refuses; `keeps` lets a write pass the bound unkept, as a path the store
/// does not version does, so the gate behind it can be reached.
#[derive(Debug, Default)]
struct Gate {
    keeps:    bool,                                         // versionable answers false
    copies:   bool,                                         // the copy is taken and kept
    mine:     BTreeSet<String>,                             // paths the Diamond made: not his
    refusals: crate::diamond_versions::ChangeRefusals,
    landing:  Option<Landed>,                               // a standing file's landing (HL3)
    settles:  bool,                                         // a settle with parts is accepted
    unrecorded: bool,                                       // the `Record` phase fails
    archive_fails: bool,                                    // the `Archive` phase fails
    restoring: Option<String>,                              // a restore's Diamond, held and let go
    restores: Vec<String>,                                  // `asked` and `let go`, in order
}

impl TestStore {
    /// Hold `crystal` as every Diamond's crystal and `k` as its own K (KT-3).
    pub fn hold_diamond(&self, crystal: &str, k: usize) {
        let mut h = self.held.borrow_mut();
        h.crystal = Some(crystal.to_string());
        h.k = k;
    }

    /// How many keeper turn ends the engine has driven on this store.
    pub fn keeper_ends(&self) -> u32 { self.keeper_ends.get() }

    /// Every `standing_settle` asked of it, `(path, phase)`, in order (held-lock settle HL2).
    pub fn settled(&self) -> Vec<(String, SettlePhase)> { self.settled.borrow().clone() }

    /// Answer `standing_retired` of a standing file with `landed`, its `kept` the text written,
    /// and accept a settle that writes something (held-lock settle HL3).
    pub fn land_as(&self, landed: Landed) {
        let mut g = self.gate.borrow_mut();
        g.landing = Some(landed);
        g.settles = true;
    }

    /// Fail every `Record` settle, as a DECISIONS.md that will not write fails it.
    pub fn fail_record(&self) { self.gate.borrow_mut().unrecorded = true; }

    /// Fail every `Archive` settle, as an archive that will not write fails it.
    pub fn fail_archive(&self) { self.gate.borrow_mut().archive_fails = true; }

    /// Hold a restore of the Diamond `id`: its route answers `Go` and its hold is taken.
    pub fn restore_in(&self, id: &str) { self.gate.borrow_mut().restoring = Some(id.to_string()); }

    /// What a restore was told, in order: `asked` for a re-ask, `let go` for a hold given back.
    pub fn restores(&self) -> Vec<String> { self.gate.borrow().restores.clone() }

    /// Let a write pass the bound without a kept copy (see [`Gate`]).
    pub fn pass_the_bound(&self) { self.gate.borrow_mut().keeps = true; }

    /// Keep a copy of what a turn's act destroys, so a delete (which waits on its copy) reaches
    /// the gate: the path is versioned, the room is there, the run seals and the copy is pended.
    pub fn keep_copies(&self) {
        let mut g = self.gate.borrow_mut();
        g.keeps = false;
        g.copies = true;
    }

    /// Keep every keeper's notes file in memory, so a fold can file his words.
    pub fn keep_notes(&self) { self.notes.borrow_mut().keeps = true; }

    /// The notes file kept for `keeper`, empty for none.
    pub fn notes_of(&self, keeper: &str) -> String {
        self.notes.borrow().files.get(keeper).cloned().unwrap_or_default()
    }

    /// Say the Diamond made the file at `path`, so a change to it is not asked about.
    pub fn made_here(&self, path: &str) { self.gate.borrow_mut().mine.insert(path.to_string()); }
}

fn refused<T>(method: &str) -> Outcome<T> {
    crate::engine::host::local::fs::unavailable("store", method)
}

impl HostStore for TestStore {
    type Window = ();
    type Hold   = ();
    type Steer  = ();
    type Marked = ();

    async fn read_crystal_data(&self, _: &str) -> Outcome<String> {
        match &self.held.borrow().crystal {
            Some(c) => Ok(c.clone()),
            None    => refused("read_crystal_data"),
        }
    }
    async fn read_crystal_data_strict(&self, _: &str) -> Outcome<String> {
        refused("read_crystal_data_strict")
    }
    async fn read_crystal_page(&self, _: &str) -> Outcome<String> {
        refused("read_crystal_page")
    }
    async fn read_crystal_page_strict(&self, _: &str) -> Outcome<String> {
        refused("read_crystal_page_strict")
    }
    fn crystal_half(&self, _: &str, _: &str) -> Option<CrystalHalf> { None }
    async fn crystal_undo_target(&self, _: &str, _: CrystalHalf, _: Option<u64>)
        -> Outcome<Option<(u64, String)>>
    {
        refused("crystal_undo_target")
    }
    // Zero is the count at which the crystal door refuses outright; any more and it demotes the
    // hot part and lets the write land (`tools::diamond_cap_door`).
    async fn hot_refusals(&self, _: &str) -> u32 { 0 }
    async fn set_hot_refusals(&self, _: &str, _: u32) -> Outcome<()> {
        refused("set_hot_refusals")
    }
    // No crystal history to walk: the write is measured against nothing, as where none parses.
    async fn crystal_hot_last_good(&self, _: &str, _: &str) -> String { String::new() }
    async fn last_passed(&self, _: &str) -> Option<CrystalPassed> { None }
    async fn mark_passed(&self, _: &str, _: u64, _: &str, _: &str, _: u32)
        -> Outcome<CrystalPassed>
    {
        refused("mark_passed")
    }

    // A path that is not one of a Diamond's three standing files gives the store nothing to
    // write, so its text comes back as it was, as the tab's store answers it: every hosted
    // `file_write` and `file_edit` asks, on whatever root the turn writes (U2d).
    async fn standing_retired(&self, root: FileRoot, path: &str, text: String)
        -> Outcome<crate::engine::host::types::store::Landed>
    {
        if crate::tools::standing_leaf(path).is_none() {
            return Ok(crate::engine::host::types::store::Landed::kept(text));
        }
        assert!(root == FileRoot::Opfs, "the store writes only its own area, not {:?}", root);
        match self.gate.borrow().landing.clone() {
            Some(l) => Ok(Landed { kept: text, ..l }),
            None    => refused("standing_retired"),
        }
    }
    // Nothing to settle settles; anything else is a write this store cannot make.
    async fn standing_settle(&self, _: FileRoot, path: &str,
        landed: &crate::engine::host::types::store::Landed, phase: SettlePhase) -> Outcome<()>
    {
        self.settled.borrow_mut().push((path.to_string(), phase));
        if landed.part(phase).settles_nothing() {
            return Ok(());
        }
        let g = self.gate.borrow();
        match phase {
            SettlePhase::Archive if g.archive_fails  => refused("standing_settle Archive"),
            SettlePhase::Record if g.unrecorded      => refused("standing_settle Record"),
            _ if g.settles                           => Ok(()),
            _                                        => refused("standing_settle"),
        }
    }
    // None: nothing was written, so the fold notice stays as it was.
    async fn absorb_fold_notes(&self, _: &str, _: &FoldNotes) -> Option<FoldNotes> { None }
    async fn his_words(&self, keeper: &str, entries: String) -> Outcome<String> {
        use crate::agent::compact;
        let mut n = self.notes.borrow_mut();
        if !n.keeps {
            return refused("his_words");
        }
        let old = n.files.get(keeper).cloned().unwrap_or_default();
        let new = compact::log_merge(&old, &entries);
        n.files.insert(keeper.to_string(), new.clone());
        compact::log_answer(&new, &entries, keeper)
    }
    async fn his_words_read(&self, keeper: &str) -> Outcome<String> {
        let n = self.notes.borrow();
        match n.keeps {
            true  => Ok(crate::agent::compact::log_text(
                &n.files.get(keeper).cloned().unwrap_or_default())),
            false => refused("his_words_read"),
        }
    }

    async fn add_link(&self, _: &str, _: &str, _: &str, _: &str, _: &str, _: &str)
        -> Outcome<String>
    {
        refused("add_link")
    }
    async fn all_links(&self) -> Outcome<String> { refused("all_links") }
    async fn links_json(&self, _: &str) -> Outcome<String> { refused("links_json") }
    async fn remove_link_by_model(&self, _: &str, _: &str) -> Outcome<Unlink> {
        refused("remove_link_by_model")
    }
    async fn diamond_exists(&self, _: &str) -> bool { false }

    // No Diamond store: no record to read, none to write, and the app's K stands (PORT-PL-B).
    async fn activity_read_all(&self, _: &str) -> Vec<(String, String)> { Vec::new() }
    async fn activity_append(&self, _: &str, _: crate::activity::Turn, _: i64) -> Outcome<()> {
        refused("activity_append")
    }
    async fn no_progress_rounds(&self, _: &str) -> usize { self.held.borrow().k }

    fn capture(&self, _: &str, _: &str, _: Change) -> Outcome<()> { Ok(()) }
    fn captured_room(&self, _: &str, _: &str, _: &Found, _: Option<u64>, _: bool, _: u64)
        -> Result<bool, Short>
    {
        if self.gate.borrow().copies { Ok(false) } else { Err(Short::Count) }
    }
    async fn keep_room(&self, _: &str) -> u64 { 0 }
    fn release(&self, _: &str, _: &str) {}
    fn held_under(&self, _: &str, _: &str) -> Vec<(String, String, String)> { Vec::new() }
    // As found, never the turn's own: a write over it is measured against all of it.
    async fn this_turn_found(&self, _: &str, _: &str, now: &[u8]) -> TurnFound {
        TurnFound::Was(now.to_vec())
    }
    async fn turns_found(&self, _: &str, _: &str, now: &[u8]) -> Option<Vec<u8>> {
        Some(now.to_vec())
    }
    async fn measured_against(&self, _: &str, _: &str, now: &[u8]) -> Vec<u8> { now.to_vec() }
    fn seals_spent(&self, _: &str, _: &str, _: &[u8]) -> bool { !self.gate.borrow().copies }
    async fn seal_run(&self, _: &str, _: &str, _: &[u8]) -> Outcome<()> {
        if self.gate.borrow().copies { Ok(()) } else { refused("seal_run") }
    }
    async fn pend(&self, _: &str, _: &str, _: &[u8], _: bool, _: bool) -> Outcome<bool> {
        if self.gate.borrow().copies { return Ok(false); }
        refused("pend")
    }
    async fn unpend(&self, _: &str, _: &str) {}
    fn ran_opaque(&self, _: &str) {}
    async fn note_output(&self, _: &str, _: &str, _: &str, _: &[u8]) {}
    async fn output_is_own(&self, _: &str, _: &str, _: &str, _: &[u8]) -> bool { false }
    async fn made_files(&self, _: &str) -> Outcome<Vec<(String, String)>> { Ok(Vec::new()) }
    async fn ran_made(&self, _: &str, _: Option<Author>, _: Vec<(String, String, bool)>, _: bool)
        -> Outcome<()> { Ok(()) }
    fn theirs(&self, _: &str, _: &str) -> bool { true }
    fn folder_of(&self, _: &str) -> Option<String> { None }
    // true refuses: claim and move_ends then hold, and the hold refuses (u2_plan §9.2).
    fn versionable(&self, _: &str, _: &str) -> bool { !self.gate.borrow().keeps }
    // His unless a test said the Diamond made it; refusals kept as the store keeps them.
    async fn authored_by_user(&self, _: &str, path: &str, _: &[u8], _: Option<u64>) -> bool {
        !self.gate.borrow().mine.contains(path)
    }
    fn change_refused(&self, _: &str, path: &str) -> bool {
        self.gate.borrow().refusals.refused(path)
    }
    fn refuse_change(&self, _: &str, path: &str) {
        self.gate.borrow_mut().refusals.refuse(path);
    }

    fn open_delete_room(&self, _: &str, _: &str) -> OpenDelete { OpenDelete::Stopped(0) }
    fn open_delete_answer(&self, _: &str, _: u64, _: bool) {}
    fn open_delete_release(&self, _: &str, _: &str) {}

    async fn open_window(&self, _: &str, _: Option<Author>) {}
    async fn close_window(&self, _: ()) {}

    async fn versions_record(&self, _: &str, _: Cause, _: &str, _: &str, _: Change)
        -> Outcome<Option<(u64, Vec<String>)>>
    {
        refused("versions_record")
    }
    async fn versions_body(&self, _: &str, _: &str) -> Outcome<Option<Vec<u8>>> {
        refused("versions_body")
    }
    async fn versions_undo_target(&self, _: &str, _: &str, _: Option<u64>)
        -> Outcome<Option<(u64, String, bool, Option<String>)>>
    {
        refused("versions_undo_target")
    }

    fn route_here(&self, _: &str, _: Option<&str>, _: &str, _: bool) -> Route { Route::Left }
    fn restore_store(&self, _: u64) -> Option<String> { self.gate.borrow().restoring.clone() }
    fn restore_route(&self, _: u64, _: &str, _: &str, _: Option<&[u8]>, _: Option<&[u8]>)
        -> Act
    {
        match self.gate.borrow().restoring {
            Some(_) => Act::Go,
            None    => Act::Unanswered,
        }
    }
    fn restore_look(&self, _: u64, _: &str, _: Seen) -> Option<bool> { None }
    fn restore_asked(&self, _: u64, _: &str, _: Seen) {
        self.gate.borrow_mut().restores.push("asked".to_string());
    }
    async fn restore_keep(&self, _: u64, _: &str, _: Option<&[u8]>, _: bool) -> Outcome<()> {
        match self.gate.borrow().restoring {
            Some(_) => Ok(()),
            None    => refused("restore_keep"),
        }
    }
    async fn restore_let_go(&self, _: u64, _: &str) {
        self.gate.borrow_mut().restores.push("let go".to_string());
    }
    fn restore_landed(&self, _: u64, _: Change) -> Outcome<()> { Ok(()) }

    // Never held: nothing is drained, recorded or settled, and a steer always seems to run.
    async fn hold_versions(&self, _: &str) -> Outcome<()> { refused("hold_versions") }
    fn is_steering(&self, _: &str) -> Outcome<bool> { Ok(true) }
    fn steering(&self, _: &str) {}
    fn drain_dirty(&self, _: &str) -> Vec<()> { Vec::new() }
    async fn dirty_changes(&self, _: &str, _: Vec<()>) -> Vec<Change> { Vec::new() }
    async fn drain_turn<H: Host>(&self, _: &(), _: &str, _: &ToolContext<H>)
        -> Outcome<Drained>
    {
        refused("drain_turn")
    }
    async fn turn_uncovered(&self, _: &(), _: &str, _: &[String]) -> Outcome<Vec<String>> {
        refused("turn_uncovered")
    }
    async fn turn_add(&self, _: &(), _: &str, _: Change) -> Outcome<()> { refused("turn_add") }
    async fn drain_windows(&self, _: &(), _: &str) -> Outcome<u32> {
        refused("drain_windows")
    }
    async fn versions_record_held(&self, _: &(), _: &str, _: Option<u64>, _: Cause, _: &str,
        _: &str) -> Outcome<Option<(u64, Vec<String>)>>
    {
        refused("versions_record_held")
    }
    async fn record_steer(&self, _: &(), _: &str, _: &str, _: &str) -> Outcome<u64> {
        refused("record_steer")
    }
    fn end_turn_counts(&self, _: &str) {}
    fn keeper_turn_ended(&self, _: &str) { self.keeper_ends.set(self.keeper_ends.get() + 1); }

    async fn live_bounds(&self, _: &Live) -> Outcome<Vec<Bound>> { refused("live_bounds") }
    async fn reach(&self, _: &Live) -> Outcome<Reach> {
        Err(err!("{}", crate::marks::UNREAD; Invalid, Input))
    }
    fn trail(&self, _: &str, _: &str) {}

    async fn journal_put(&self, _: &str, _: u64, _: &[u8]) -> Outcome<()> {
        refused("journal_put")
    }
    async fn journal_read(&self, _: &str) -> Outcome<Vec<(u64, Vec<u8>)>> {
        refused("journal_read")
    }
    async fn journal_drop(&self, _: &str) -> Outcome<()> { refused("journal_drop") }
}

// Every store answer that gates an action, on both native hosts, is the one that refuses
// (u2_plan §9.2): never "go", never "room", never "the turn's own".
#[cfg(test)]
#[path = "../../../../tests/unit/engine/host/test/store/closed.rs"]
pub(crate) mod closed;
