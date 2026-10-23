//! WasmHost's store port.

use crate::{
    agent::compact::FoldNotes,
    diamond_link::Unlink,
    diamond_versions::{Act, Cause, Change, Found, OpenDelete, Route, Seen, Short, TurnFound},
    engine::host::{
        Host,
        store::{
            Drained, HostStore, SlotHold, TurnStore, journal_all, journal_clear, journal_write, slot_add,
            slot_drain_turn, slot_drain_windows, slot_record, slot_uncovered,
        },
        types::store::CrystalHalf,
    },
    marks::{Live, Reach},
    rating::Author,
    tools::{Bound, CrystalPassed, FileRoot, ToolContext},
    wasm::{diamond, entry, marks, store_opfs::OpfsBackend},
};

use oxedyne_fe2o3_core::prelude::*;

/// WasmHost's store port: each method is one call to its namesake in `wasm::diamond`
/// (`trail` to `wasm::entry`, `live_bounds` to `wasm::marks`).
#[derive(Clone, Debug, Default)]
pub struct WasmStore;

impl HostStore for WasmStore {
    type Window = diamond::Around;
    type Hold   = SlotHold<diamond::VersionHold>;
    type Steer  = diamond::Steering;
    type Marked = diamond::Marked;

    async fn read_crystal_data(&self, id: &str) -> Outcome<String> {
        diamond::read_crystal_data(id).await
    }
    async fn read_crystal_data_strict(&self, id: &str) -> Outcome<String> {
        diamond::read_crystal_data_strict(id).await
    }
    async fn read_crystal_page(&self, id: &str) -> Outcome<String> {
        diamond::read_crystal_page(id).await
    }
    async fn read_crystal_page_strict(&self, id: &str) -> Outcome<String> {
        diamond::read_crystal_page_strict(id).await
    }
    fn crystal_half(&self, id: &str, path: &str) -> Option<CrystalHalf> {
        diamond::crystal_half(id, path)
    }
    async fn crystal_undo_target(&self, id: &str, half: CrystalHalf, at: Option<u64>)
        -> Outcome<Option<(u64, String)>>
    {
        diamond::crystal_undo_target(id, half, at).await
    }
    async fn hot_refusals(&self, id: &str) -> u32 {
        diamond::hot_refusals(id).await
    }
    async fn set_hot_refusals(&self, id: &str, n: u32) -> Outcome<()> {
        diamond::set_hot_refusals(id, n).await
    }
    async fn crystal_hot_last_good(&self, id: &str, old: &str) -> String {
        diamond::crystal_hot_last_good(id, old).await
    }
    async fn last_passed(&self, id: &str) -> Option<CrystalPassed> {
        diamond::last_passed(id).await
    }
    async fn mark_passed(&self, id: &str, version: u64, page: &str, data: &str, debug: u32)
        -> Outcome<CrystalPassed>
    {
        diamond::mark_passed(id, version, page, data, debug).await
    }

    async fn standing_retired(&self, root: FileRoot, path: &str, text: String)
        -> Outcome<diamond::Landed>
    {
        diamond::standing_retired(root, path, text).await
    }
    async fn standing_settle(&self, root: FileRoot, path: &str, landed: &diamond::Landed,
        phase: diamond::SettlePhase) -> Outcome<()>
    {
        diamond::standing_settle(root, path, &landed.part(phase), phase).await
    }
    async fn absorb_fold_notes(&self, id: &str, notes: &FoldNotes) -> Option<FoldNotes> {
        diamond::absorb_fold_notes(id, notes).await
    }

    async fn add_link(
        &self,
        owner: &str,
        from:  &str,
        to:    &str,
        rel:   &str,
        note:  &str,
        by:    &str,
    )
        -> Outcome<String>
    {
        diamond::add_link(owner, from, to, rel, note, by).await
    }
    async fn all_links(&self) -> Outcome<String> {
        diamond::all_links().await
    }
    async fn links_json(&self, node_ref: &str) -> Outcome<String> {
        diamond::links_json(node_ref).await
    }
    async fn remove_link_by_model(&self, owner: &str, link_id: &str) -> Outcome<Unlink> {
        diamond::remove_link_by_model(owner, link_id).await
    }
    async fn diamond_exists(&self, id: &str) -> bool {
        diamond::diamond_exists(id).await
    }

    // The activity record and the no-progress K (PORT-PL-B)
    async fn activity_read_all(&self, id: &str) -> Vec<(String, String)> {
        diamond::activity_read_all(id).await
    }
    async fn activity_append(&self, id: &str, turn: crate::activity::Turn, now: i64)
        -> Outcome<()>
    {
        diamond::activity_append(id, turn, now).await
    }
    async fn no_progress_rounds(&self, id: &str) -> usize {
        diamond::no_progress_rounds(id).await
    }

    fn capture(&self, id: &str, raw: &str, change: Change) -> Outcome<()> {
        diamond::capture(id, raw, change);
        Ok(())
    }
    fn captured_room(&self, id: &str, path: &str, found: &Found, copy: Option<u64>,
        destroying: bool, room: u64) -> Result<bool, Short>
    {
        diamond::captured_room(id, path, found, copy, destroying, room)
    }
    async fn keep_room(&self, id: &str) -> u64 {
        diamond::keep_room(id).await
    }
    fn release(&self, id: &str, path: &str) {
        diamond::release(id, path)
    }
    fn held_under(&self, id: &str, from: &str) -> Vec<(String, String, String)> {
        diamond::held_under(id, from)
    }
    async fn this_turn_found(&self, id: &str, path: &str, now: &[u8]) -> TurnFound {
        diamond::this_turn_found(id, path, now).await
    }
    async fn turns_found(&self, id: &str, path: &str, now: &[u8]) -> Option<Vec<u8>> {
        diamond::turns_found(id, path, now).await
    }
    async fn measured_against(&self, id: &str, path: &str, now: &[u8]) -> Vec<u8> {
        diamond::measured_against(id, path, now).await
    }
    fn seals_spent(&self, id: &str, path: &str, now: &[u8]) -> bool {
        diamond::seals_spent(id, path, now)
    }
    async fn seal_run(&self, id: &str, path: &str, now: &[u8]) -> Outcome<()> {
        diamond::seal_run(id, path, now).await
    }
    async fn pend(&self, id: &str, path: &str, before: &[u8], deleting: bool, mark: bool)
        -> Outcome<bool>
    {
        diamond::pend(id, path, before, deleting, mark).await
    }
    async fn unpend(&self, id: &str, path: &str) {
        diamond::unpend(id, path).await
    }
    fn ran_opaque(&self, id: &str) {
        diamond::ran_opaque(id)
    }
    async fn note_output(&self, id: &str, tool: &str, path: &str, bytes: &[u8]) {
        diamond::note_output(id, tool, path, bytes).await
    }
    async fn output_is_own(&self, id: &str, tool: &str, path: &str, bytes: &[u8]) -> bool {
        diamond::output_is_own(id, tool, path, bytes).await
    }
    async fn made_files(&self, id: &str) -> Outcome<Vec<(String, String)>> {
        Ok(diamond::made_files(id).await)
    }
    async fn ran_made(&self, id: &str, by: Option<Author>, files: Vec<(String, String, bool)>,
        capped: bool) -> Outcome<()>
    {
        diamond::ran_made(id, by, files, capped);
        Ok(())
    }
    fn theirs(&self, id: &str, path: &str) -> bool {
        diamond::theirs(id, path)
    }
    fn folder_of(&self, path: &str) -> Option<String> {
        diamond::folder_of(path)
    }
    fn versionable(&self, id: &str, path: &str) -> bool {
        diamond::versionable(id, path)
    }
    async fn authored_by_user(&self, id: &str, path: &str, now: &[u8]) -> bool {
        diamond::authored_by_user(id, path, now).await
    }
    fn change_refused(&self, id: &str, path: &str) -> bool {
        diamond::change_refused(id, path)
    }
    fn refuse_change(&self, id: &str, path: &str) {
        diamond::refuse_change(id, path)
    }

    fn open_delete_room(&self, id: &str, file: &str) -> OpenDelete {
        diamond::open_delete_room(id, file)
    }
    fn open_delete_answer(&self, id: &str, ticket: u64, allow: bool) {
        diamond::open_delete_answer(id, ticket, allow)
    }
    fn open_delete_release(&self, id: &str, file: &str) {
        diamond::open_delete_release(id, file)
    }

    async fn open_window(&self, id: &str, by: Option<Author>) -> diamond::Around {
        diamond::open_window(id, by).await
    }
    async fn close_window(&self, around: diamond::Around) {
        diamond::close_window(around).await
    }

    async fn versions_record(
        &self,
        id:      &str,
        cause:   Cause,
        turn:    &str,
        note:    &str,
        change:  Change,
    )
        -> Outcome<Option<(u64, Vec<String>)>>
    {
        diamond::versions_record(id, cause, turn, note, vec![change]).await
    }
    async fn versions_body(&self, id: &str, hash: &str) -> Outcome<Option<Vec<u8>>> {
        diamond::versions_body(id, hash).await
    }
    async fn versions_undo_target(&self, id: &str, path: &str, at: Option<u64>)
        -> Outcome<Option<(u64, String, bool, Option<String>)>>
    {
        diamond::versions_undo_target(id, path, at).await
    }

    fn route_here(&self, row: &str, row_folder: Option<&str>, landed: &str, overwrites: bool)
        -> Route
    {
        diamond::route_here(row, row_folder, landed, overwrites)
    }
    fn restore_store(&self, ticket: u64) -> Option<String> {
        diamond::restore_store(ticket)
    }
    fn restore_route(
        &self,
        ticket:  u64,
        spelled: &str,
        landed:  &str,
        now:     Option<&[u8]>,
        puts:    Option<&[u8]>,
    )
        -> Act
    {
        diamond::restore_route(ticket, spelled, landed, now, puts)
    }
    fn restore_look(&self, ticket: u64, spelled: &str, now: Seen) -> Option<bool> {
        diamond::restore_look(ticket, spelled, now)
    }
    fn restore_asked(&self, ticket: u64, spelled: &str, now: Seen) {
        diamond::restore_asked(ticket, spelled, now)
    }
    async fn restore_keep(&self, ticket: u64, path: &str, now: Option<&[u8]>, deleting: bool)
        -> Outcome<()>
    {
        diamond::restore_keep(ticket, path, now, deleting).await
    }
    async fn restore_let_go(&self, ticket: u64, path: &str) {
        diamond::restore_let_go(ticket, path).await
    }
    fn restore_landed(&self, ticket: u64, change: Change) -> Outcome<()> {
        diamond::restore_landed(ticket, change);
        Ok(())
    }

    async fn hold_versions(&self, id: &str) -> Outcome<Self::Hold> {
        Ok(SlotHold::new(res!(diamond::hold_versions(id).await), id))
    }
    fn is_steering(&self, id: &str) -> Outcome<bool> {
        Ok(diamond::is_steering(id))
    }
    fn steering(&self, id: &str) -> diamond::Steering {
        diamond::steering(id)
    }
    fn drain_dirty(&self, id: &str) -> Vec<diamond::Marked> {
        diamond::drain_dirty(id)
    }
    async fn dirty_changes(&self, id: &str, dirty: Vec<diamond::Marked>) -> Vec<Change> {
        diamond::dirty_changes(id, dirty).await
    }
    async fn drain_turn<H: Host>(&self, hold: &Self::Hold, id: &str, ctx: &ToolContext<H>)
        -> Outcome<Drained>
    {
        slot_drain_turn(self, hold, id, ctx).await
    }
    async fn turn_uncovered(&self, hold: &Self::Hold, id: &str, wrote: &[String])
        -> Outcome<Vec<String>>
    {
        slot_uncovered(hold, id, wrote)
    }
    async fn turn_add(&self, hold: &Self::Hold, id: &str, change: Change) -> Outcome<()> {
        slot_add(hold, id, change)
    }
    async fn drain_windows(&self, hold: &Self::Hold, id: &str) -> Outcome<u32> {
        slot_drain_windows(self, hold, id).await
    }
    async fn versions_record_held(
        &self,
        hold:  &Self::Hold,
        id:    &str,
        at:    Option<u64>,
        cause: Cause,
        turn:  &str,
        note:  &str,
    )
        -> Outcome<Option<(u64, Vec<String>)>>
    {
        slot_record(self, hold, id, at, cause, turn, note).await
    }
    async fn record_steer(&self, hold: &Self::Hold, id: &str, json: &str,
        instruction: &str) -> Outcome<u64>
    {
        diamond::record_steer(hold.held(), id, json, instruction).await
    }
    fn end_turn_counts(&self, id: &str) {
        diamond::end_turn_counts(id)
    }

    async fn live_bounds(&self, live: &Live) -> Outcome<Vec<Bound>> {
        marks::live_bounds(live).await
    }
    async fn reach(&self, target: &Live) -> Outcome<Reach> {
        marks::reach(target).await
    }
    fn trail(&self, what: &str, detail: &str) {
        entry::trail(what, detail)
    }

    // The tab's run journal: OPFS, the store's own area (`JOURNAL_ROOT`).
    async fn journal_put(&self, run: &str, round: u64, record: &[u8]) -> Outcome<()> {
        journal_write(&OpfsBackend, run, round, record).await
    }
    async fn journal_read(&self, run: &str) -> Outcome<Vec<(u64, Vec<u8>)>> {
        journal_all(&OpfsBackend, run).await
    }
    async fn journal_drop(&self, run: &str) -> Outcome<()> {
        journal_clear(&OpfsBackend, run).await
    }
}

// The store's own turn-end calls, which the slot composes (spec §16.3a 1).
impl TurnStore for WasmStore {
    type Held = diamond::VersionHold;

    async fn drain<H: Host>(&self, held: &diamond::VersionHold, id: &str, ctx: &ToolContext<H>)
        -> (Vec<(String, Change)>, Vec<String>, Vec<String>)
    {
        diamond::drain_turn(held, id, ctx).await
    }
    async fn windows(&self, id: &str, held: &[(String, Change)]) -> Vec<Change> {
        diamond::drain_windows(id, held).await
    }
    async fn record(
        &self,
        held:    &diamond::VersionHold,
        id:      &str,
        at:      Option<u64>,
        cause:   Cause,
        turn:    &str,
        note:    &str,
        changes: Vec<Change>,
    )
        -> Outcome<Option<(u64, Vec<String>)>>
    {
        diamond::versions_record_held(held, id, at, cause, turn, note, changes).await
    }
    async fn settle(&self, id: &str, names: &[String]) {
        diamond::settle(id, names).await
    }
}
