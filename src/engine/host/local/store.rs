//! LocalHost's store port.

use crate::{
    agent::compact::FoldNotes,
    diamond_link::Unlink,
    diamond_versions::{Act, Cause, Change, Found, OpenDelete, Route, Seen, Short, TurnFound},
    engine::host::{
        Host,
        store::{Drained, HostStore},
        types::store::CrystalHalf,
    },
    marks::{Live, Reach},
    rating::Author,
    tools::{Bound, CrystalPassed, FileRoot, ToolContext},
};

use oxedyne_fe2o3_core::prelude::*;

/// LocalHost's store port.  There is no store on this build, so every gate answers the value
/// that refuses or holds (u2_plan §9.2), and every `Outcome` refuses.
#[derive(Clone, Debug, Default)]
pub struct LocalStore;

fn refused<T>(method: &str) -> Outcome<T> {
    crate::engine::host::local::fs::unavailable("store", method)
}

impl HostStore for LocalStore {
    type Window = ();
    type Hold   = ();
    type Steer  = ();
    type Marked = ();

    async fn read_crystal_data(&self, _: &str) -> Outcome<String> {
        refused("read_crystal_data")
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

    async fn standing_retired(&self, _: FileRoot, _: &str, _: String)
        -> Outcome<crate::engine::host::types::store::Landed>
    {
        refused("standing_retired")
    }
    async fn standing_settle(&self, _: FileRoot, _: &str,
        _: &crate::engine::host::types::store::Landed,
        _: crate::engine::host::types::store::SettlePhase) -> Outcome<()>
    {
        refused("standing_settle")
    }
    // None: nothing was written, so the fold notice stays as it was.
    async fn absorb_fold_notes(&self, _: &str, _: &FoldNotes) -> Option<FoldNotes> { None }
    async fn his_words(&self, _: &str, _: String) -> Outcome<String> { refused("his_words") }
    async fn his_words_read(&self, _: &str) -> Outcome<String> { refused("his_words_read") }

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
    async fn no_progress_rounds(&self, _: &str) -> usize { 0 }

    fn capture(&self, _: &str, _: &str, _: Change) -> Outcome<()> { Ok(()) }
    fn captured_room(&self, _: &str, _: &str, _: &Found, _: Option<u64>, _: bool, _: u64)
        -> Result<bool, Short>
    {
        Err(Short::Count)
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
    fn seals_spent(&self, _: &str, _: &str, _: &[u8]) -> bool { true }
    async fn seal_run(&self, _: &str, _: &str, _: &[u8]) -> Outcome<()> { refused("seal_run") }
    async fn pend(&self, _: &str, _: &str, _: &[u8], _: bool, _: bool) -> Outcome<bool> {
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
    fn versionable(&self, _: &str, _: &str) -> bool { true }
    // His, and declined: the values that write nothing (u2_plan §9.2).
    async fn authored_by_user(&self, _: &str, _: &str, _: &[u8], _: Option<u64>) -> bool { true }
    fn change_refused(&self, _: &str, _: &str) -> bool { true }
    fn refuse_change(&self, _: &str, _: &str) {}

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
    fn restore_store(&self, _: u64) -> Option<String> { None }
    fn restore_route(&self, _: u64, _: &str, _: &str, _: Option<&[u8]>, _: Option<&[u8]>)
        -> Act
    {
        Act::Unanswered
    }
    fn restore_look(&self, _: u64, _: &str, _: Seen) -> Option<bool> { None }
    fn restore_asked(&self, _: u64, _: &str, _: Seen) {}
    async fn restore_keep(&self, _: u64, _: &str, _: Option<&[u8]>, _: bool) -> Outcome<()> {
        refused("restore_keep")
    }
    async fn restore_let_go(&self, _: u64, _: &str) {}
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
