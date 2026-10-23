//! D1r1c: the port over a link answers as the port does directly (d1_plan §3 D1r), and the
//! riders of §9.11 each hold.  The direct side is [`Direct`], WasmHost's port body run natively
//! on its own thread with its own Mem store; the remote side is [`RemoteStore`] over a
//! [`LoopLink`] to a [`StoreServer`] over a second Mem store.  Every rider's test runs once with
//! its rule switched off ([`switch_off`]) and shows its red in one log line.

use super::*;
use crate::{
    agent::compact::FoldNotes,
    diamond_link::Unlink,
    diamond_versions::{Act, Body, Cause, Change, Found, OpenDelete, Route, Seen, Short, TurnFound},
    engine::host::{
        Host,
        store::{
            Drained, HostStore, SlotHold, TurnStore, journal_all, journal_clear, journal_write,
            slot_add, slot_drain_turn, slot_drain_windows, slot_record, slot_uncovered,
        },
        test::TestHost,
        types::store::CrystalHalf,
    },
    executor::Executor,
    marks::{Live, Reach},
    rating::Author,
    store::{
        call::{encode_call, FRAME_MAX},
        diamond,
        install,
        mem::MemBackend,
        native::NativeBackend,
        run::RunEnv,
        server::{not_served, StoreServer, Tag},
        StoreBackend,
    },
    tools::{Bound, CrystalPassed, FileRoot, ToolContext, new_read_cache},
    workspace::Workspace,
};

use std::sync::{Arc, Mutex as StdMutex};

// ┌───────────────────────────────────────────────────────────────┐
// │ The direct port: WasmHost's, run natively                      │
// └───────────────────────────────────────────────────────────────┘

/// WasmHost's store port body, natively: each method is its namesake in `store::diamond`
/// (`trail` to `store::own`; the marks are the tab's, so `live_bounds` and `reach` refuse).
#[derive(Clone, Debug, Default)]
struct Direct;

impl HostStore for Direct {
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
    async fn made_files(&self, id: &str) -> Vec<(String, String)> {
        diamond::made_files(id).await
    }
    async fn ran_made(&self, id: &str, by: Option<Author>, files: Vec<(String, String, bool)>,
        capped: bool)
    {
        diamond::ran_made(id, by, files, capped)
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
    fn is_steering(&self, id: &str) -> bool {
        diamond::is_steering(id)
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
        { let _ = live; Err(not_served("live_bounds", "the marks are the tab's")) }
    }
    async fn reach(&self, target: &Live) -> Outcome<Reach> {
        { let _ = target; Err(not_served("reach", "the marks are the tab's")) }
    }
    fn trail(&self, what: &str, detail: &str) {
        crate::store::own::trail(what, detail)
    }
    // The tab's journal body over the installed backend, as the store server's arms are (U4e).
    async fn journal_put(&self, run: &str, round: u64, record: &[u8]) -> Outcome<()> {
        journal_write(&crate::store::backend(), run, round, record).await
    }
    async fn journal_read(&self, run: &str) -> Outcome<Vec<(u64, Vec<u8>)>> {
        journal_all(&crate::store::backend(), run).await
    }
    async fn journal_drop(&self, run: &str) -> Outcome<()> {
        journal_clear(&crate::store::backend(), run).await
    }
}

impl TurnStore for Direct {
    type Held = diamond::VersionHold;

    async fn drain<H: Host>(&self, held: &diamond::VersionHold, id: &str, ctx: &ToolContext<H>)
        -> (Vec<(String, Change)>, Vec<String>, Vec<String>)
    {
        diamond::drain_turn_by(held, id, &turn_end::FsReads(ctx.host())).await
    }
    async fn windows(&self, id: &str, held: &[(String, Change)]) -> Vec<Change> {
        match turn_end::HOST.with(|h| h.borrow().clone()) {
            Some(host)  => diamond::drain_windows_by(id, held, &turn_end::FsReads(&host)).await,
            None        => diamond::drain_windows(id, held).await,
        }
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

// ┌───────────────────────────────────────────────────────────────┐
// │ The two sides                                                  │
// └───────────────────────────────────────────────────────────────┘

const D: &str = "d";

fn rt() -> tokio::runtime::Runtime {
    match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(rt)  => rt,
        Err(e)  => panic!("a runtime: {}", e),
    }
}

fn env() -> RunEnv {
    RunEnv {
        run:        s("a"),
        diamonds:   [s(D), s(E)].into_iter().collect(),
        folder_id:  None,
        known:      Default::default(),
        page:       s("a"),
    }
}

/// A Mem store holding the Diamond `d`: its metadata, its crystal and its page.
fn seeded() -> MemBackend {
    let mem = MemBackend::default();
    let files: [(&str, &[u8]); 3] = [
        ("diamonds/d/.daimond/meta.json",
            br#"{"name":"d","crystal_version":0,"updated":0,"touched":0}"#),
        ("diamonds/d/crystal.json", br#"{"title":"d","sections":[]}"#),
        ("diamonds/d/crystal.html", b"<html><body>d</body></html>"),
    ];
    rt().block_on(async {
        for (k, b) in files {
            if let Err(e) = mem.write_file(k, b).await {
                panic!("seeding {}: {}", k, e);
            }
        }
    });
    mem
}

fn turn_ctx() -> ToolContext<TestHost> {
    let dir = match oxedyne_fe2o3_test::scratch::scratch_dir("store_remote_tests") {
        Ok(d)  => d,
        Err(e) => panic!("a scratch directory: {}", e),
    };
    let ws = match Workspace::new(dir) {
        Ok(w)  => w,
        Err(e) => panic!("a workspace: {}", e),
    };
    ToolContext {
        workspace:   ws,
        executor:    Executor::local_default(),
        cwd:         String::new(),
        path_prefix: String::new(),
        root:        FileRoot::Workspace,
        read_seen:   new_read_cache(),
        no_write:    Vec::new(),
        daimon_of:   String::new(),
        turn:        String::new(),
        keeper:      String::new(),
        unconfirmed: Vec::new(),
        live:        None,
        by_model:    false,
        restoring:   0,
        by:          None,
        host:        TestHost::default(),
    }
}

/// `f` run against the direct port, on its own thread over `mem`, in the run `a`'s scope.
fn direct<T, F, Fut>(mem: MemBackend, f: F) -> T
where
    T: Send + 'static,
    F: FnOnce(ToolContext<TestHost>) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = T>,
{
    direct_on(NativeBackend::Mem(mem), f)
}

/// `f` run against the direct port, on its own thread over `b`, in the run `a`'s scope.
fn direct_on<T, F, Fut>(b: NativeBackend, f: F) -> T
where
    T: Send + 'static,
    F: FnOnce(ToolContext<TestHost>) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = T>,
{
    let h = std::thread::spawn(move || {
        let _ = install(b);
        let ctx = turn_ctx();
        turn_end::HOST.with(|h| *h.borrow_mut() = Some(ctx.host.clone()));
        let out = rt().block_on(env().scope(f(ctx)));
        let _ = install(NativeBackend::Closed);
        out
    });
    match h.join() {
        Ok(v)   => v,
        Err(_)  => panic!("the direct side panicked"),
    }
}

/// A store server over `mem`, and the run `a` bound to it.
fn served(mem: MemBackend) -> (StoreServer, LoopLink) { served_on(NativeBackend::Mem(mem)) }

/// A store server over `b`, and the run `a` bound to it.
fn served_on(b: NativeBackend) -> (StoreServer, LoopLink) {
    let srv = match StoreServer::start(b) {
        Ok(s)   => s,
        Err(e)  => panic!("the store server: {}", e),
    };
    let link = match srv.bind(Tag::Run, env()) {
        Ok(l)   => l,
        Err(e)  => panic!("binding a: {}", e),
    };
    (srv, link)
}

/// A link that counts each frame it sends, by call name and encoded size.
#[derive(Clone)]
struct Counting {
    link: LoopLink,
    sent: Arc<StdMutex<Vec<(String, usize)>>>,
}

impl Counting {
    fn new(link: LoopLink) -> Self { Self { link, sent: Arc::new(StdMutex::new(Vec::new())) } }

    fn note(&self, call: &StoreCall) {
        let n = encode_call(call).map(|b| b.len()).unwrap_or(0);
        if let Ok(mut s) = self.sent.lock() {
            s.push((call.name().to_string(), n));
        }
    }

    /// The frames sent since the last take, LetGo aside.
    fn take(&self) -> Vec<(String, usize)> {
        match self.sent.lock() {
            Ok(mut s)   => std::mem::take(&mut *s).into_iter().filter(|f| f.0 != "let_go").collect(),
            Err(_)      => Vec::new(),
        }
    }
}

impl StoreLink for Counting {
    async fn call(&self, call: &StoreCall) -> Outcome<StoreReply> {
        self.note(call);
        self.link.call(call).await
    }
    fn call_blocking(&self, call: &StoreCall) -> Outcome<StoreReply> {
        self.note(call);
        self.link.call_blocking(call)
    }
    fn notify(&self, call: &StoreCall) {
        self.note(call);
        let _ = self.link.send(call);
    }
}

fn change(path: &str, before: &[u8], after: &[u8]) -> Change {
    Change {
        path:    s(path),
        after:   Body::Held(after.to_vec()),
        before:  Some(crate::diamond_versions::Prior::Held(before.to_vec())),
        found:   Found::Unread,
        carried: None,
        mark:    false,
        refused: None,
        wiped:   false,
        folder:  None,
        by:      None,
        door:    false,
    }
}

/// `s` with each id in `ids` named by its place, every all-hex `"id"` (a log entry's stamped id)
/// masked, and every run of 13 or more digits (a millisecond stamp) masked.
fn masked(text: &str, ids: &[String]) -> String {
    let mut t = text.to_string();
    for (n, id) in ids.iter().enumerate() {
        if !id.is_empty() {
            t = t.replace(id.as_str(), &fmt!("<link{}>", n));
        }
    }
    const KEY: &str = "\"id\":\"";
    let mut stamped = String::new();
    let mut rest = t.as_str();
    while let Some(at) = rest.find(KEY) {
        let (head, tail) = rest.split_at(at + KEY.len());
        stamped.push_str(head);
        let end = tail.find('"').unwrap_or(tail.len());
        if end > 0 && tail[..end].chars().all(|c| c.is_ascii_hexdigit()) {
            stamped.push_str("<stamp>");
        } else {
            stamped.push_str(&tail[..end]);
        }
        rest = &tail[end..];
    }
    stamped.push_str(rest);
    let t = stamped;
    let mut out = String::new();
    let mut run = String::new();
    let flush = |run: &mut String, out: &mut String| {
        if run.len() >= 13 { out.push_str("<ms>") } else { out.push_str(run) }
        run.clear();
    };
    for c in t.chars() {
        if c.is_ascii_digit() {
            run.push(c);
        } else {
            flush(&mut run, &mut out);
            out.push(c);
        }
    }
    flush(&mut run, &mut out);
    out
}

/// The store's files, masked, each as one line.
fn files_of(mem: &MemBackend, ids: &[String]) -> Vec<String> {
    mem.files().iter()
        .map(|(k, b)| masked(&fmt!("{} = {}", k, String::from_utf8_lossy(b)), ids))
        .collect()
}

/// Every file of `b` as [`files_of`] gives a memory store's: a memory store's own map, any other
/// store walked from its root through [`StoreBackend`], read after its server has stopped.
fn files_in(b: &NativeBackend, ids: &[String]) -> Vec<String> {
    let all = match b {
        NativeBackend::Mem(m)   => m.files(),
        other                   => rt().block_on(walked(other)),
    };
    all.iter()
        .map(|(k, b)| masked(&fmt!("{} = {}", k, String::from_utf8_lossy(b)), ids))
        .collect()
}

/// Every file of `b` by key, walked from the root.
async fn walked<B: StoreBackend>(b: &B) -> std::collections::BTreeMap<String, Vec<u8>> {
    let mut out = std::collections::BTreeMap::new();
    let mut dirs = vec![String::new()];
    while let Some(d) = dirs.pop() {
        let listed = match b.list_dir(&d).await {
            Ok(l)   => l,
            Err(e)  => panic!("listing '{}': {}", d, e),
        };
        for (name, is_dir, _) in listed {
            let k = if d.is_empty() { name } else { fmt!("{}/{}", d, name) };
            if is_dir {
                dirs.push(k);
            } else {
                match b.read_file(&k).await {
                    Ok(bytes)   => { out.insert(k, bytes); },
                    Err(e)      => panic!("reading '{}': {}", k, e),
                }
            }
        }
    }
    out
}

/// An answer as a line: a refusal by its words, each frame's `file:line: ` cut, and its tags,
/// between `⟨⟩` so [`bare`] can cut them (D1r1 check D-Q1a).
fn o<T: std::fmt::Debug>(r: &Outcome<T>) -> String {
    match r {
        Ok(v)   => fmt!("Ok({:?})", v),
        Err(e)  => {
            let words: Vec<String> = e.msgs().iter()
                .map(|m| unlocated(m).trim().to_string())
                .filter(|m| !m.is_empty())
                .collect();
            fmt!("Err⟨{:?} {:?}⟩", words, e.tags())
        },
    }
}

/// `m` without the `file:line: ` an error frame opens with.
fn unlocated(m: &str) -> &str {
    let located = |h: &str| match h.rsplit_once(':') {
        Some((file, line))  => !file.is_empty() && !line.is_empty()
            && line.chars().all(|c| c.is_ascii_digit()),
        None                => false,
    };
    match m.split_once(": ") {
        Some((head, tail)) if located(head) => tail,
        _ => if located(m) { "" } else { m },
    }
}

/// `line` with each refusal's words and tags cut, as the differential logged it before D1r1e.
fn bare(line: &str) -> String {
    let mut out = String::new();
    let mut rest = line;
    while let Some(at) = rest.find('⟨') {
        out.push_str(&rest[..at]);
        rest = match rest[at..].find('⟩') {
            Some(end)   => &rest[at + end + '⟩'.len_utf8()..],
            None        => "",
        };
    }
    out.push_str(rest);
    out
}

// ┌───────────────────────────────────────────────────────────────┐
// │ The script: every port method                                  │
// └───────────────────────────────────────────────────────────────┘

const DECISIONS: &str = "diamonds/d/DECISIONS.md";

/// A Diamond the run is granted and no store holds.
const E: &str = "f";

/// Decisions over their ceiling: a title, then dated lines enough to pass 16 KiB.
fn decisions_over() -> String {
    let mut t = s("# Decisions\n\n");
    let mut n = 0;
    while t.len() <= crate::tools::DECISIONS_CAP + 2048 {
        t.push_str(&fmt!("- 2026-10-{:02} decision {} with its reason, kept as one line.\n",
            1 + n % 28, n));
        n += 1;
    }
    t
}

/// Each port method in turn, its answer logged as a line, and the link ids it made.  `stub`
/// names a method whose answer is replaced by an unimplemented one's (the differential red).
async fn script<S: HostStore>(st: &S, ctx: &ToolContext<TestHost>, stub: Option<&str>)
    -> (Vec<String>, Vec<String>)
{
    let mut log: Vec<String> = Vec::new();
    let mut ids: Vec<String> = Vec::new();
    macro_rules! say { ($($a:tt)*) => { log.push(fmt!($($a)*)) } }

    // Crystal
    say!("diamond_exists d {:?} e {:?}", st.diamond_exists(D).await, st.diamond_exists("e").await);
    say!("read_crystal_data {}", o(&st.read_crystal_data(D).await));
    say!("read_crystal_data_strict {}", o(&st.read_crystal_data_strict(D).await));
    say!("read_crystal_page {}", o(&st.read_crystal_page(D).await));
    say!("read_crystal_page_strict {}", o(&st.read_crystal_page_strict(D).await));
    say!("crystal_half {:?}", st.crystal_half(D, "diamonds/d/crystal.json"));
    say!("crystal_undo_target {}", o(&st.crystal_undo_target(D, CrystalHalf::Data, None).await));
    say!("hot_refusals {}", st.hot_refusals(D).await);
    say!("set_hot_refusals {}", o(&st.set_hot_refusals(D, 2).await));
    say!("hot_refusals {}", st.hot_refusals(D).await);
    say!("last_passed {:?}", st.last_passed(D).await);
    say!("mark_passed {}", o(&st.mark_passed(D, 0, "<html>page</html>", "{\"data\":1}", 1).await));
    say!("last_passed {:?}", st.last_passed(D).await);

    // Standing files and folds
    say!("standing_retired plain {}",
        o(&st.standing_retired(FileRoot::Opfs, "diamonds/d/notes.md", s("hello")).await));
    say!("standing_retired under {}",
        o(&st.standing_retired(FileRoot::Opfs, DECISIONS, s("# Decisions\n\n- one\n")).await));
    let over = st.standing_retired(FileRoot::Opfs, DECISIONS, decisions_over()).await;
    say!("standing_retired over {}", o(&over));
    if let Ok(l) = &over {
        say!("standing_settle over {}", o(&settle_both(st, FileRoot::Opfs, DECISIONS, l).await));
    }
    let notes = FoldNotes { decisions: vec![s("- 2026-10-01 decision 0 with its reason")],
        task: s("t"), ..Default::default() };
    say!("absorb_fold_notes {:?}", st.absorb_fold_notes(D, &notes).await);

    // Links
    for n in 0..3 {
        let got = st.add_link(D, "diamond:d", &fmt!("url:https://x/{}", n), "cites", "", "daimon")
            .await;
        if let Ok(id) = &got {
            ids.push(id.clone());
        }
        say!("add_link {}", o(&got));
    }
    say!("all_links {}", o(&st.all_links().await));
    say!("links_json {}", o(&st.links_json("diamond:d").await));
    let id1 = ids.get(1).cloned().unwrap_or_default();
    say!("remove_link_by_model {}", o(&st.remove_link_by_model(D, &id1).await));
    say!("remove_link_by_model missing {}", o(&st.remove_link_by_model(D, "nope").await));

    // A turn's captures and copies
    let found = Found::Unread;
    say!("captured_room {:?}", st.captured_room(D, "/m/a.txt", &found, Some(1), false, u64::MAX));
    st.capture(D, "a.txt", change("/m/a.txt", b"old a", b"new a"));
    say!("keep_room {}", st.keep_room(D).await);
    let mut held = st.held_under(D, "/m");
    held.sort();
    say!("held_under {:?}", held);
    say!("this_turn_found {:?}", st.this_turn_found(D, "/m/a.txt", b"new a").await);
    say!("turns_found {:?}", st.turns_found(D, "/m/a.txt", b"new a").await);
    say!("measured_against {:?}", st.measured_against(D, "/m/a.txt", b"new a").await);
    say!("seals_spent {:?}", st.seals_spent(D, "/m/a.txt", b"new a"));
    say!("seal_run {}", o(&st.seal_run(D, "/m/a.txt", b"new a").await));
    say!("captured_room b {:?}", st.captured_room(D, "/m/b.txt", &found, Some(1), false, u64::MAX));
    say!("pend {}", o(&st.pend(D, "/m/b.txt", b"old b", false, false).await));
    st.unpend(D, "/m/b.txt").await;
    st.ran_opaque(D);
    st.note_output(D, "tool", "/m/c.txt", b"out").await;
    say!("output_is_own {} {}", st.output_is_own(D, "tool", "/m/c.txt", b"out").await,
        st.output_is_own(D, "tool", "/m/c.txt", b"other").await);
    say!("theirs {}", st.theirs(D, "/m/a.txt"));
    say!("folder_of {:?}", st.folder_of("/m/a.txt"));
    say!("versionable {}", st.versionable(D, "/m/a.txt"));
    st.release(D, "/m/z.txt");

    // Deletes from the open folder
    say!("open_delete_room {:?}", st.open_delete_room(D, "f.txt"));
    st.open_delete_answer(D, 1, true);
    st.open_delete_release(D, "f.txt");

    // Windows around a call
    let w = st.open_window(D, None).await;
    st.close_window(w).await;

    // Versions
    let rec = st.versions_record(D, Cause::Save, "t1", "saved",
        change("/m/v.txt", b"v old", b"v new")).await;
    say!("versions_record {}", o(&rec));
    let hash = crate::diamond_versions::hash_of(b"v new");
    let body = if stub == Some("versions_body") {
        Err(err!("unimplemented"; Missing, Data))
    } else {
        st.versions_body(D, &hash).await
    };
    say!("versions_body {}", o(&body));
    say!("versions_undo_target {}", o(&st.versions_undo_target(D, "/m/v.txt", None).await));

    // Restores, of a ticket no restore opened
    say!("route_here {:?}", st.route_here("x.txt", None, "x.txt", false));
    say!("restore_store {:?}", st.restore_store(99));
    say!("restore_route {:?}", st.restore_route(99, "x.txt", "x.txt", Some(b"n"), None));
    say!("restore_look {:?}", st.restore_look(99, "x.txt", Seen::of(None)));
    st.restore_asked(99, "x.txt", Seen::of(None));
    say!("restore_keep {}", o(&st.restore_keep(99, "x.txt", None, false).await));
    st.restore_let_go(99, "x.txt").await;
    st.restore_landed(99, change("/m/r.txt", b"r", b"r2"));

    // The turn end
    let hold = match st.hold_versions(D).await {
        Ok(h)   => h,
        Err(e)  => panic!("hold_versions: {}", e),
    };
    say!("is_steering {}", st.is_steering(D));
    drop(st.steering(D));
    let dirty = st.drain_dirty(D);
    say!("drain_dirty {}", dirty.len());
    say!("dirty_changes {:?}", st.dirty_changes(D, dirty).await);
    say!("drain_turn {}", o(&st.drain_turn(&hold, D, ctx).await));
    say!("turn_uncovered {}", o(&st.turn_uncovered(&hold, D, &[s("/m/a.txt"), s("/m/q.txt")]).await));
    say!("turn_add {}", o(&st.turn_add(&hold, D, change("/m/t.txt", b"t", b"t2")).await));
    say!("drain_windows {}", o(&st.drain_windows(&hold, D).await));
    say!("versions_record_held {}",
        o(&st.versions_record_held(&hold, D, None, Cause::Turn, "t2", "turn").await));
    say!("record_steer {}", o(&st.record_steer(&hold, D, "{\"go\":1}", "go on").await));

    // Refusals: one for each method that can refuse, of a Diamond the run is granted and no store
    // holds (`E`), a path or a version that is not there, and a hold of another Diamond (D1r1
    // check D-Q1a).  A Diamond the run is not granted is the binding's refusal, which the direct
    // port has no binding to match.
    say!("refuse read_crystal_data {}", o(&st.read_crystal_data(E).await));
    let got = st.read_crystal_data_strict(E).await;
    let got = if stub == Some("refusal_words") && got.is_err() {
        Err(err!("A refusal in other words."; Missing, Data))
    } else {
        got
    };
    say!("refuse read_crystal_data_strict {}", o(&got));
    say!("refuse read_crystal_page {}", o(&st.read_crystal_page(E).await));
    say!("refuse read_crystal_page_strict {}", o(&st.read_crystal_page_strict(E).await));
    say!("refuse crystal_undo_target {}",
        o(&st.crystal_undo_target(E, CrystalHalf::Data, Some(999)).await));
    say!("refuse set_hot_refusals {}", o(&st.set_hot_refusals(E, 1).await));
    say!("refuse mark_passed {}", o(&st.mark_passed(E, 9, "<html>e</html>", "{}", 1).await));
    say!("refuse standing_retired {}",
        o(&st.standing_retired(FileRoot::Opfs, "diamonds/e/notes.md", s("e")).await));
    say!("refuse add_link {}", o(&st.add_link(E, "bogus", "url:https://x/e", "", "", "daimon")
        .await));
    say!("refuse links_json {}", o(&st.links_json("diamond:e").await));
    say!("refuse remove_link_by_model {}", o(&st.remove_link_by_model(E, "nope").await));
    say!("refuse seal_run {}", o(&st.seal_run(E, "/m/a.txt", b"e").await));
    say!("refuse pend {}", o(&st.pend(E, "/m/e.txt", b"e", false, false).await));
    say!("refuse versions_record {}", o(&st.versions_record(E, Cause::Save, "t1", "e",
        change("/m/e.txt", b"e old", b"e new")).await));
    say!("refuse versions_body {}", o(&st.versions_body(E, &hash).await));
    say!("refuse versions_body unhex {}", o(&st.versions_body(D, "not hex").await));
    say!("refuse versions_undo_target {}",
        o(&st.versions_undo_target(D, "/m/none.txt", Some(999)).await));
    say!("refuse restore_keep {}", o(&st.restore_keep(98, "y.txt", Some(b"y"), true).await));
    say!("refuse drain_turn {}", o(&st.drain_turn(&hold, E, ctx).await));
    say!("refuse turn_uncovered {}", o(&st.turn_uncovered(&hold, E, &[s("/m/a.txt")]).await));
    say!("refuse turn_add {}", o(&st.turn_add(&hold, E, change("/m/e.txt", b"e", b"e2")).await));
    say!("refuse drain_windows {}", o(&st.drain_windows(&hold, E).await));
    say!("refuse versions_record_held {}",
        o(&st.versions_record_held(&hold, E, None, Cause::Turn, "t3", "turn").await));
    say!("refuse record_steer {}", o(&st.record_steer(&hold, E, "{}", "go").await));
    drop(hold);
    st.end_turn_counts(D);

    // Marks and the trail
    let live = Live::Chat(s("c"), Vec::new());
    say!("live_bounds {}", o(&st.live_bounds(&live).await));
    say!("reach {}", o(&st.reach(&live).await));
    st.trail("remote_tests", "done");
    (log, ids)
}

/// The script's lines and the store's files after it, directly and through the link.
fn both(stub: Option<&'static str>) -> ((Vec<String>, Vec<String>), (Vec<String>, Vec<String>)) {
    let mem = seeded();
    let (log, ids) = direct(mem.clone(), |ctx| async move { script(&Direct, &ctx, None).await });
    let here = (log.iter().map(|l| masked(l, &ids)).collect(), files_of(&mem, &ids));

    let mem = seeded();
    let (srv, link) = served(mem.clone());
    let store = RemoteStore::new(link);
    let ctx = turn_ctx();
    let (log, ids) = rt().block_on(script(&store, &ctx, stub));
    drop(store);
    srv.stop();
    let there = (log.iter().map(|l| masked(l, &ids)).collect(), files_of(&mem, &ids));
    (here, there)
}

/// The lines where `a` and `b` differ, by place.
fn differ(a: &[String], b: &[String]) -> Vec<String> {
    let n = a.len().max(b.len());
    (0..n).filter_map(|i| {
        let x = a.get(i).map(String::as_str).unwrap_or("<none>");
        let y = b.get(i).map(String::as_str).unwrap_or("<none>");
        if x == y { None } else { Some(fmt!("direct: {}\nremote: {}", x, y)) }
    }).collect()
}

/// Every port method answers through the link as it does directly, and leaves the same bytes
/// (d1_plan §3 D1r).  Red: a method answering as an unimplemented one.
#[test]
fn the_port_through_the_link_answers_as_the_port_directly() {
    let (here, there) = both(Some("versions_body"));
    let red = differ(&here.0, &there.0);
    assert!(!red.is_empty(), "a stubbed versions_body went unseen");
    eprintln!("RED differential: versions_body stubbed gives {} differing line(s)", red.len());

    let (here, there) = both(Some("refusal_words"));
    let cut = |l: &[String]| l.iter().map(|x| bare(x)).collect::<Vec<_>>();
    let red = differ(&cut(&here.0), &cut(&there.0));
    assert!(red.is_empty(), "the bare log saw the stub:\n{}", red.join("\n"));
    let seen = differ(&here.0, &there.0);
    assert!(!seen.is_empty(), "a refusal in other words went unseen");
    eprintln!("RED refusal words: logged bare, a refusal in other words differs in {} line(s); \
        by words and tags, in {}", red.len(), seen.len());

    let (here, there) = both(None);
    let lines = differ(&here.0, &there.0);
    let files = differ(&here.1, &there.1);
    assert!(lines.is_empty(), "the answers differ:\n{}", lines.join("\n"));
    assert!(files.is_empty(), "the stores differ:\n{}", files.join("\n"));
    assert!(here.0.len() >= 82, "the script logged {} lines", here.0.len());  // 58, and 24 refusals
    let refused = here.0.iter().filter(|l| l.starts_with("refuse ") && l.contains("Err⟨")).count();
    let open: Vec<&str> = here.0.iter().filter(|l| l.starts_with("refuse ") && !l.contains("Err⟨"))
        .map(|l| l.split(' ').nth(1).unwrap_or("")).collect();
    eprintln!("differential: {} lines, {} refusal case(s) answered Err; answered Ok on both: {:?}",
        here.0.len(), refused, open);
}

// ┌───────────────────────────────────────────────────────────────┐
// │ The riders (d1_plan §9.11, D1r1 +0.25)                         │
// └───────────────────────────────────────────────────────────────┘

/// A fresh server over a seeded store, its run `a`'s port counting frames, run in `f`.
fn counted<T>(f: impl FnOnce(&RemoteStore<Counting>, &Counting, &MemBackend) -> T) -> T {
    counted_on(seeded(), f)
}

/// [`counted`] over the store `mem`.
fn counted_on<T>(mem: MemBackend,
    f: impl FnOnce(&RemoteStore<Counting>, &Counting, &MemBackend) -> T) -> T
{
    let (srv, link) = served(mem.clone());
    let link = Counting::new(link);
    let store = RemoteStore::new(link.clone());
    let out = f(&store, &link, &mem);
    drop(store);
    srv.stop();
    out
}

/// Runs `f` with `rule` off on this thread, then on again.
fn with_off<T>(rule: &'static str, f: impl FnOnce() -> T) -> T {
    switch_off(Some(rule));
    let out = f();
    switch_off(None);
    out
}

/// The 300 names of a record of 300 files, by `recorded_names` past the first page.
fn names_of_300() -> usize {
    let ctx = turn_ctx();
    counted(|st, _, _| rt().block_on(async {
        let hold = match st.hold_versions(D).await {
            Ok(h)   => h,
            Err(e)  => panic!("hold_versions: {}", e),
        };
        if let Err(e) = st.drain_turn(&hold, D, &ctx).await {
            panic!("drain_turn: {}", e);
        }
        for n in 0..300 {
            let path = fmt!("/m/f{:03}.txt", n);
            if let Err(e) = st.turn_add(&hold, D, change(&path, b"", fmt!("{}", n).as_bytes())).await
            {
                panic!("turn_add {}: {}", n, e);
            }
        }
        match st.versions_record_held(&hold, D, None, Cause::Turn, "t", "300").await {
            Ok(Some((_, names)))    => names.len(),
            other                   => panic!("the record of 300 answered {:?}", other),
        }
    }))
}

#[test]
fn a_record_of_300_names_reads_all_300() {
    let red = with_off("names", names_of_300);
    assert!(red < 300, "the first page alone gave all 300");
    eprintln!("RED names: the first page alone gives {} of 300 names", red);
    assert_eq!(names_of_300(), 300, "the record's names");
}

/// The claims in `D`'s claims file after an upload under the run's own versions hold, before it
/// is named; then after the `turn_add` call names it (sent alone: `turn_add` would put again).
fn claims_under_hold() -> (usize, usize) {
    let mem = seeded();
    let (srv, link) = served(mem);
    let st = RemoteStore::new(link);
    let claims = |srv: &StoreServer| match srv.probe(D) {
        Ok(p)   => p.claims,
        Err(e)  => panic!("probe: {}", e),
    };
    let ctx = turn_ctx();
    let out = rt().block_on(async {
        let hold = match st.hold_versions(D).await {
            Ok(h)   => h,
            Err(e)  => panic!("hold_versions: {}", e),
        };
        if let Err(e) = st.drain_turn(&hold, D, &ctx).await {
            panic!("drain_turn: {}", e);
        }
        let ch = change("/m/u.txt", b"u", b"u2 under the hold");
        let have = bodies_of(&ch);
        let call = StoreCall::TurnAdd { hold: hold.handle().unwrap_or(Handle(0)), id: s(D),
            change: WireChange::refer(&ch) };
        let puts = match st.puts(D, &call, &have) {
            Ok(p)   => p,
            Err(e)  => panic!("puts: {}", e),
        };
        for put in puts.into_iter().flatten() {
            if let Err(e) = answer!(st.link.call(&put).await, BodyPut) {
                panic!("body_put under the hold: {}", e);
            }
        }
        let mid = claims(&srv);
        match answer!(st.link.call(&call).await, TurnAdd) {
            Ok(Ok(()))              => (),
            Ok(Err(e)) | Err(e)     => panic!("turn_add under the hold: {}", e),
        }
        let mut after = claims(&srv);
        for _ in 0..200 {
            if after == 0 { break; }
            std::thread::sleep(std::time::Duration::from_millis(5));
            after = claims(&srv);
        }
        drop(hold);
        (mid, after)
    });
    drop(st);
    srv.stop();
    out
}

#[test]
fn an_upload_under_the_runs_own_hold_is_claimed_in_the_claims_file() {
    use std::sync::atomic::Ordering;
    crate::store::diamond::UNFILED_UNDER_HOLD.store(true, Ordering::SeqCst);
    let (red, _) = claims_under_hold();
    crate::store::diamond::UNFILED_UNDER_HOLD.store(false, Ordering::SeqCst);
    assert_eq!(red, 0, "the registry-only claim still reached the claims file");
    eprintln!("RED claim_file: a claim in the registry alone leaves {} claims on file mid-upload",
        red);
    assert_eq!(claims_under_hold(), (2, 0), "both bodies on file until named, then given back");
}

/// Both phases of an accepted landing's settle, in the door's order (until HL3 moves them).
async fn settle_both<S: HostStore>(st: &S, root: FileRoot, path: &str, l: &Landed)
    -> Outcome<()>
{
    res!(st.standing_settle(root, path, l, SettlePhase::Archive).await);
    st.standing_settle(root, path, l, SettlePhase::Record).await
}

/// The frames `standing_retired` sends for a plain file, a standing file under its ceiling and
/// one over it, and the archive that last one left.
fn standing_frames() -> (Vec<(String, usize)>, Vec<(String, usize)>, Vec<String>, Vec<u8>) {
    let archive = crate::tools::standing_archive(crate::tools::DECISIONS_FILE, D);
    // The door's two steps, as a write the door accepts takes them.
    async fn landed<S: HostStore>(st: &S, path: &str, text: String) -> Outcome<()> {
        let l = res!(st.standing_retired(FileRoot::Opfs, path, text).await);
        settle_both(st, FileRoot::Opfs, path, &l).await
    }
    counted(|st, link, mem| rt().block_on(async {
        let _ = link.take();
        let _ = landed(st, "diamonds/d/notes.md", decisions_over()).await;
        let plain = link.take();
        let _ = landed(st, DECISIONS, s("# Decisions\n\n- one\n")).await;
        let under = link.take();
        if let Err(e) = landed(st, DECISIONS, decisions_over()).await {
            panic!("a landing over its ceiling: {}", e);
        }
        let over = link.take().into_iter().map(|f| f.0).filter(|n| n != "body_put").collect();
        let bytes = mem.files().get(&archive).cloned().unwrap_or_default();
        (plain, under, over, bytes)
    }))
}

#[test]
fn standing_retired_is_the_childs_and_only_the_settle_crosses() {
    let (plain, _, _, _) = with_off("standing", standing_frames);
    assert!(!plain.is_empty(), "the store saw nothing with the child's arithmetic off");
    eprintln!("RED standing: with the arithmetic in the store, a plain file_write sends {:?}", plain);

    let (plain, under, over, bytes) = standing_frames();
    assert!(plain.is_empty(), "a plain file's write sent {:?}", plain);
    assert!(under.is_empty(), "a write under the ceiling sent {:?}", under);
    assert_eq!(over, vec![s("standing_settle")], "a write over the ceiling sent {:?}", over);
    let archive = crate::tools::standing_archive(crate::tools::DECISIONS_FILE, D);
    let direct_bytes = direct(seeded(), move |_| async move {
        let st = &Direct;
        match st.standing_retired(FileRoot::Opfs, DECISIONS, decisions_over()).await {
            Ok(l)   => if let Err(e) = settle_both(st, FileRoot::Opfs, DECISIONS, &l).await {
                panic!("the direct standing_settle: {}", e);
            },
            Err(e)  => panic!("the direct standing_retired: {}", e),
        }
        match crate::store::own::read_file(&archive).await {
            Ok(b)   => b,
            Err(e)  => panic!("the direct archive: {}", e),
        }
    });
    assert!(!bytes.is_empty(), "no archive was written");
    assert_eq!(bytes, direct_bytes, "the archive differs from the direct one");
}

/// UNBLOCK-18 F6 on either port: a landing's side files -- archive, `DECISIONS.md`, the touched
/// record -- after a door REFUSED the write (no settle), then after one accepted it: its
/// `Archive` phase alone, then its `Record` phase alone (HL2).  Each answers the three files'
/// bytes, `None` for a file not there.
fn f6_landings(remote: bool) -> [[Option<Vec<u8>>; 3]; 3] {
    const STATE: &str = "diamonds/d/STATE.md";
    fn files() -> [String; 3] {
        [crate::tools::standing_archive(crate::tools::DECISIONS_FILE, D), s(DECISIONS),
            crate::store::diamond::touched_path(D)]
    }
    fn state_landing() -> Landed {
        Landed {
            kept:       s("# State\n\n## Where\n\nhere\n"),
            said:       s("\nA section moved."),
            archive:    vec![(s(crate::tools::DECISIONS_FILE), s("- 2026-10-19 a section retired\n"))],
            noted:      vec![s("- 2026-10-19 Where retired to the archive")],
            touched:    vec![s("1760832000000\tWhere")],
            from:       None,
            at:         1760832000000,
        }
    }
    async fn land<S: HostStore>(st: &S, settle: Option<SettlePhase>) {
        let over = match st.standing_retired(FileRoot::Opfs, DECISIONS, decisions_over()).await {
            Ok(l)   => l,
            Err(e)  => panic!("standing_retired over its ceiling: {}", e),
        };
        assert!(!over.archive.is_empty(), "nothing retired from a file over its ceiling");
        if let Some(phase) = settle {
            for (p, l) in [(DECISIONS, over), (STATE, state_landing())] {
                if let Err(e) = st.standing_settle(FileRoot::Opfs, p, &l, phase).await {
                    panic!("standing_settle {} {:?}: {}", p, phase, e);
                }
            }
        }
    }
    if remote {
        counted(|st, _, mem| rt().block_on(async {
            let read = || files().map(|p| mem.files().get(&p).cloned());
            land(st, None).await;
            let refused = read();
            land(st, Some(SettlePhase::Archive)).await;
            let archived = read();
            land(st, Some(SettlePhase::Record)).await;
            [refused, archived, read()]
        }))
    } else {
        direct(seeded(), |_| async move {
            async fn read() -> [Option<Vec<u8>>; 3] {
                let mut out: [Option<Vec<u8>>; 3] = [None, None, None];
                for (i, p) in files().iter().enumerate() {
                    out[i] = crate::store::own::read_file(p).await.ok();
                }
                out
            }
            land(&Direct, None).await;
            let refused = read().await;
            land(&Direct, Some(SettlePhase::Archive)).await;
            let archived = read().await;
            land(&Direct, Some(SettlePhase::Record)).await;
            [refused, archived, read().await]
        })
    }
}

#[test]
fn a_landing_writes_nothing_until_accepted_and_then_all_here_and_on_the_child() {
    // The red of a refused write that leaves an archive is now the door's (HL3 (a)-(c), in
    // `engine/host/test/fs.rs`): the settle is the held write's pre step, never the landing's.
    let none: [Option<Vec<u8>>; 3] = [None, None, None];
    let local = f6_landings(false);
    assert_eq!(local[0], none, "a refused write left a side file: {:?}", local[0]);
    // HL2 (c): `Archive` writes the archive alone; `Record` then DECISIONS.md and touched.
    assert!(local[1][0].is_some() && local[1][1].is_none() && local[1][2].is_none(),
        "the archive phase wrote other than the archive: {:?}", local[1]);
    assert!(local[2].iter().all(|f| f.as_ref().map_or(false, |b| !b.is_empty())),
        "an accepted write left a side file unwritten: {:?}", local[2]);
    assert_eq!(local[2][0], local[1][0], "the record phase wrote the archive");
    let child = f6_landings(true);
    assert_eq!(child[0], none, "on the child, a refused write left a side file: {:?}", child[0]);
    assert_eq!(child, local, "the child's landing differs from the local one");
}

#[test]
fn a_settle_writes_no_side_file_it_has_no_right_to() {
    let bad = Landed { noted: vec![s("- 2026-10-19 x")], ..Landed::default() };
    counted(|st, _, mem| rt().block_on(async {
        let got = settle_both(st, FileRoot::Opfs, DECISIONS, &bad).await;
        assert!(got.is_err(), "a DECISIONS write rode a DECISIONS landing: {:?}", got);
        let notes = Landed { archive: vec![(s("notes.md"), s("x\n"))], ..Landed::default() };
        let got = settle_both(st, FileRoot::Opfs, "diamonds/d/STATE.md", &notes).await;
        assert!(got.is_err(), "an archive was named for a file that has none: {:?}", got);
        let plain = settle_both(st, FileRoot::Opfs, "diamonds/d/notes.md",
            &Landed { archive: vec![(s(crate::tools::DECISIONS_FILE), s("x\n"))],
                ..Landed::default() }).await;
        assert!(plain.is_err(), "a plain file settled an archive: {:?}", plain);
        assert!(mem.files().get(DECISIONS).is_none(), "a refused settle wrote DECISIONS.md");
    }));
}

/// UNBLOCK-18 F6, the order of the writes, which the port tests above cannot drive through a
/// door: a file tool's landing writes its side files (archive first) only once the write is
/// accepted, just before the file itself (r573's test, on r1's HostStore).
#[test]
fn the_side_files_are_settled_archive_first_and_only_once_accepted() {
    let at = |src: &str, what: &str| match src.find(what) {
        Some(i) => i,
        None    => panic!("not found: {}", what),
    };
    let dia = include_str!("diamond.rs");
    let settle = &dia[at(dia, "pub async fn standing_settle(")..];
    assert!(at(settle, "archive_append(") < at(settle, "decisions_settle(")
        && at(settle, "decisions_settle(") < at(settle, "touched_settle("), "F6: archive first");
    let retired = &dia[at(dia, "pub(crate) async fn standing_retired(")..at(dia, "impl Landed {")];
    assert!(!retired.contains("write_file") && !retired.contains("archive_append(")
        && !retired.contains("standing_settle("), "F6: standing_retired only reads");
    // HL3: the doors hand the landing to the held write, which settles it under the lock.
    let tools = include_str!("../tools.rs");
    let write = &tools[at(tools, "async fn file_write_page<")..];
    let write = &write[..at(write, "\n    /// ")];
    assert!(at(write, "before_overwrite(") < at(write, "Some(&landed)")
        && !write.contains("standing_settle("), "F6: file_write settles only through the door");
    let edit = &tools[at(tools, "standing_retired(ctx.root, &path, updated)")..];
    let edit = &edit[..at(edit, "\n    /// ")];
    assert!(at(edit, "before_overwrite(") < at(edit, "Some(&landed)")
        && !edit.contains("standing_settle("), "F6: file_edit settles only through the door");
    let door = &tools[at(tools, "pub async fn landed_store_write<")..];
    assert!(at(door, "SettlePhase::Archive)).await") < at(door, "SettlePhase::Record)"),
        "F6: the archive under the lock, the record after it");
}

// ── PL-A2: the child lands STATE.md by section ──

const STATE_MD: &str = "diamonds/d/STATE.md";

/// [`seeded`] with a `STATE.md` of two sections, `Where` and `Plan`, and their touched record.
fn state_seeded() -> MemBackend {
    let mem = seeded();
    let files = [
        (s(STATE_MD), s("# State\n\n## Where\n\nhere\n\n## Plan\n\nthe plan\n")),
        (crate::store::diamond::touched_path(D), s("1\tWhere\n2\tPlan\n")),
    ];
    rt().block_on(async {
        for (k, b) in files.iter() {
            if let Err(e) = mem.write_file(k, b.as_bytes()).await {
                panic!("seeding {}: {}", k, e);
            }
        }
    });
    mem
}

/// A `STATE.md` write that drops `Plan`, on either port: the landing answered, then the side
/// files (the decisions archive, `DECISIONS.md`, the touched record) after the door refused the
/// write (no settle), then after it accepted it (settled).
fn state_landings(remote: bool) -> (Landed, [[Option<Vec<u8>>; 3]; 2]) {
    fn files() -> [String; 3] {
        [crate::tools::standing_archive(crate::tools::STATE_FILE, D), s(DECISIONS),
            crate::store::diamond::touched_path(D)]
    }
    async fn land<S: HostStore>(st: &S, settle: bool) -> Landed {
        let text = s("# State\n\n## Where\n\nhere\n");
        let l = match st.standing_retired(FileRoot::Opfs, STATE_MD, text).await {
            Ok(l)   => l,
            Err(e)  => panic!("standing_retired of STATE.md: {}", e),
        };
        if settle {
            if let Err(e) = settle_both(st, FileRoot::Opfs, STATE_MD, &l).await {
                panic!("standing_settle of STATE.md: {}", e);
            }
        }
        l
    }
    if remote {
        counted_on(state_seeded(), |st, _, mem| rt().block_on(async {
            let read = || files().map(|p| mem.files().get(&p).cloned());
            land(st, false).await;
            let refused = read();
            let l = land(st, true).await;
            (l, [refused, read()])
        }))
    } else {
        direct(state_seeded(), |_| async move {
            async fn read() -> [Option<Vec<u8>>; 3] {
                let mut out: [Option<Vec<u8>>; 3] = [None, None, None];
                for (i, p) in files().iter().enumerate() {
                    out[i] = crate::store::own::read_file(p).await.ok();
                }
                out
            }
            land(&Direct, false).await;
            let refused = read().await;
            let l = land(&Direct, true).await;
            (l, [refused, read().await])
        })
    }
}

/// A touched record's rows with each landing's own clock stamp (ten digits or more) as `<ms>`,
/// so two hosts' landings compare: the seeded stamps are short and stay.
fn unstamped(rows: &str) -> String {
    rows.split('\n').map(|row| match row.split_once('\t') {
        Some((ms, key)) if ms.len() >= 10 => fmt!("<ms>\t{}", key),
        _                                 => s(row),
    }).collect::<Vec<_>>().join("\n")
}

/// [`state_landings`] with its clock stamps taken out by [`unstamped`].
fn state_unstamped(remote: bool) -> (Landed, [[Option<Vec<u8>>; 3]; 2]) {
    let (mut l, mut files) = state_landings(remote);
    l.touched = l.touched.iter().map(|r| unstamped(r)).collect();
    assert!(l.at >= 1_000_000_000, "a STATE.md landing carries no time of its own: {}", l.at);
    l.at = 0;
    for phase in files.iter_mut() {
        phase[2] = phase[2].take().map(|b| unstamped(&String::from_utf8_lossy(&b)).into_bytes());
    }
    (l, files)
}

#[test]
fn a_childs_state_write_lands_by_section_as_the_local_host_does() {
    let (red, red_files) = with_off("state", || state_landings(true));
    assert!(red.archive.is_empty() && red_files[1][0].is_none(),
        "with the section landing off the child still retired a section: {:?}", red);
    eprintln!("RED state: with standing_split alone, the child keeps STATE.md whole: {:?}",
        red.archive);

    let (local, local_files) = state_unstamped(false);
    assert_eq!(local.archive.first().map(|(leaf, _)| leaf.as_str()),
        Some(crate::tools::STATE_FILE), "the local host retired nothing: {:?}", local);
    assert!(local.touched.iter().any(|r| r == "\tPlan"), "{:?}", local.touched);
    let (child, child_files) = state_unstamped(true);
    assert_eq!(child, local, "the child's landing differs from the local one");
    let seeded_touched = Some(b"1\tWhere\n2\tPlan\n".to_vec());
    assert_eq!(child_files[0], [None, None, seeded_touched],
        "a refused STATE.md write left a side file: {:?}", child_files[0]);
    assert!(child_files[1][0].as_ref().map_or(false, |b| !b.is_empty()),
        "an accepted write retired no section to the archive: {:?}", child_files[1]);
    assert_ne!(child_files[1][2], child_files[0][2], "the touched record was not written");
    assert_eq!(child_files, local_files, "the child's side files differ from the local ones");
}

/// `state_read` sent by hand: the Diamond `id`, `path`, under `root`.
fn state_read_of(st: &RemoteStore<Counting>, id: &str, root: FileRoot, path: &str)
    -> Outcome<StoreReply>
{
    st.send_blocking(id, StoreCall::StateRead { id: s(id), root, path: s(path) }, &[])
}

fn state_read_refused(r: &Outcome<StoreReply>) -> bool {
    !matches!(r, Ok(StoreReply::StateRead(Ok(_))))
}

#[test]
fn a_state_read_of_another_root_diamond_or_leaf_is_refused() {
    use std::sync::atomic::Ordering;
    let e_state = &fmt!("diamonds/{}/STATE.md", E);
    crate::store::server::STATE_ANY_PATH.store(true, Ordering::SeqCst);
    let red = counted_on(state_seeded(), |st, _, _| {
        (state_read_of(st, D, FileRoot::Opfs, e_state),
            state_read_of(st, D, FileRoot::Opfs, DECISIONS))
    });
    crate::store::server::STATE_ANY_PATH.store(false, Ordering::SeqCst);
    assert!(!state_read_refused(&red.0) && !state_read_refused(&red.1),
        "the checks off still refused: {:?}", red);
    eprintln!("RED state_read: with the checks off, d's call reads {}'s STATE.md and DECISIONS.md", E);

    counted_on(state_seeded(), |st, _, _| {
        let own = state_read_of(st, D, FileRoot::Opfs, STATE_MD);
        assert!(!state_read_refused(&own), "d's own STATE.md was refused: {:?}", own);
        // The child's own root names the same area (HL5c, the one own-area rule).
        let child = state_read_of(st, D, FileRoot::Workspace, STATE_MD);
        assert!(!state_read_refused(&child), "d's STATE.md under Workspace was refused: {:?}", child);
        for (id, root, path, what) in [
            (D, FileRoot::Machine, STATE_MD, "the machine's root"),
            (D, FileRoot::Opfs, e_state, "a path of another granted Diamond under d's id"),
            (D, FileRoot::Opfs, DECISIONS, "a leaf not STATE.md"),
            (D, FileRoot::Opfs, "diamonds/d/notes.md", "a plain file"),
            ("e", FileRoot::Opfs, "diamonds/e/STATE.md", "an ungranted Diamond"),
        ] {
            let got = state_read_of(st, id, root, path);
            assert!(state_read_refused(&got), "{} was served: {:?}", what, got);
        }
    });
}

/// `mark_passed` of a megabyte page: the bytes sent, and the marks answered.
fn marks_sent() -> (usize, Outcome<CrystalPassed>) {
    let page = "p".repeat(1 << 20);
    counted(|st, link, _| rt().block_on(async {
        let _ = link.take();
        let got = st.mark_passed(D, 0, &page, "{\"data\":1}", 0).await;
        let sent = link.take().iter().map(|f| f.1).sum();
        (sent, got)
    }))
}

#[test]
fn mark_passed_sends_only_the_two_marks() {
    let (red, _) = with_off("marks", marks_sent);
    assert!(red > 1 << 20, "the page did not cross with the hashing off");
    eprintln!("RED marks: with the page hashed in the store, mark_passed sends {} bytes", red);

    let (sent, got) = marks_sent();
    assert!(sent < 1024, "mark_passed sent {} bytes", sent);
    let got = match got {
        Ok(m)   => m,
        Err(e)  => panic!("mark_passed: {}", e),
    };
    let want = direct(seeded(), |_| async move {
        let st = &Direct;
        st.mark_passed(D, 0, &"p".repeat(1 << 20), "{\"data\":1}", 0).await
    });
    let want = match want {
        Ok(m)   => m,
        Err(e)  => panic!("the direct mark_passed: {}", e),
    };
    assert_eq!((got.version, &got.page, &got.data, got.debug),
        (want.version, &want.page, &want.data, want.debug), "the marks differ");
}

/// `standing_settle` sent by hand: `id` with a path of the Diamond `of`.
fn archive_of(st: &RemoteStore<Counting>, id: &str, of: &str) -> Outcome<StoreReply> {
    let retired = b"- 2026-10-01 a line\n";
    let call = StoreCall::StandingSettle {
        id:         s(id),
        root:       FileRoot::Opfs,
        path:       fmt!("diamonds/{}/DECISIONS.md", of),
        phase:      SettlePhase::Archive,
        archive:    vec![(s(crate::tools::DECISIONS_FILE),
            crate::diamond_versions::BodyRef::of(retired))],
        noted:      vec![],
        touched:    vec![],
        at:         0,
    };
    st.send_blocking(id, call, &[retired])
}

fn archive_refused(r: &Outcome<StoreReply>) -> bool {
    !matches!(r, Ok(StoreReply::StandingSettle(Ok(()))))
}

#[test]
fn standing_archive_carries_its_diamond_and_a_path_outside_it_is_refused() {
    use std::sync::atomic::Ordering;
    crate::store::server::ARCHIVE_ANY_ID.store(true, Ordering::SeqCst);
    let red = counted(|st, _, _| archive_of(st, D, "e"));
    crate::store::server::ARCHIVE_ANY_ID.store(false, Ordering::SeqCst);
    assert!(!archive_refused(&red), "the check off still refused: {:?}", red);
    eprintln!("RED archive_id: with the Diamond check off, d's call appends to e's archive: {:?}",
        red.as_ref().map(|r| r.name()));

    counted(|st, _, _| {
        let own = archive_of(st, D, D);
        assert!(!archive_refused(&own), "d's own archive was refused: {:?}", own);
        let foreign = archive_of(st, D, "e");
        assert!(archive_refused(&foreign), "a path of e under d's id was served: {:?}", foreign);
        let ungranted = archive_of(st, "e", "e");
        assert!(archive_refused(&ungranted), "e's archive was served to a run of d: {:?}",
            ungranted);
    });
}

/// Removes one of 20 model links: the `Unlink` answered, as the rels and targets of what is left.
fn unlinked(remote: bool) -> Vec<String> {
    async fn run<S: HostStore>(st: &S) -> Unlink {
        let mut ids = Vec::new();
        for n in 0..20 {
            match st.add_link(D, "diamond:d", &fmt!("url:https://x/{:02}", n), "cites", "", "daimon")
                .await
            {
                Ok(id)  => ids.push(id),
                Err(e)  => panic!("add_link {}: {}", n, e),
            }
        }
        match st.remove_link_by_model(D, &ids[7]).await {
            Ok(u)   => u,
            Err(e)  => panic!("remove_link_by_model: {}", e),
        }
    }
    let u = if remote {
        counted(|st, _, _| rt().block_on(run(st)))
    } else {
        direct(seeded(), |_| run(&Direct))
    };
    match u {
        Unlink::Removed(left) => left.iter().map(|l| fmt!("{} {:?}", l.rel, l.to)).collect(),
        other                 => panic!("the removal answered {:?}", other),
    }
}

#[test]
fn an_unlink_is_rebuilt_from_its_pages_of_links() {
    let red = with_off("unlink", || unlinked(true));
    assert!(red.is_empty(), "links came back with the rebuild off: {:?}", red);
    eprintln!("RED unlink: with no links_page rebuild, Removed carries {} of 19 links", red.len());

    let got = unlinked(true);
    assert_eq!(got.len(), 19, "the links left: {:?}", got);
    assert_eq!(got, unlinked(false), "the links left differ from the direct removal's");
}

/// `held_under` of 70 captures, through the link.
fn held_70() -> Vec<(String, String, String)> {
    counted(|st, _, _| {
        for n in 0..70 {
            let path = fmt!("/m/dir/f{:02}.txt", n);
            st.capture(D, &fmt!("dir/f{:02}.txt", n), change(&path, b"o", b"n"));
        }
        st.held_under(D, "/m/dir")
    })
}

#[test]
fn held_under_reads_past_its_first_page_by_key() {
    let red = with_off("held", held_70);
    assert_eq!(red.len(), crate::store::call::HELD_PAGE, "one page with the key read off");
    eprintln!("RED held: with one page only, held_under gives {} of 70", red.len());

    let got = held_70();
    assert_eq!(got.len(), 70, "held_under gave {}", got.len());
    let mut want = direct(seeded(), |_| async move {
        let st = &Direct;
        for n in 0..70 {
            let path = fmt!("/m/dir/f{:02}.txt", n);
            st.capture(D, &fmt!("dir/f{:02}.txt", n), change(&path, b"o", b"n"));
        }
        st.held_under(D, "/m/dir")
    });
    want.sort();
    assert_eq!(got, want, "held_under differs from the direct one");
}

/// A capture the store refuses (its path past the wire's bound), then the turn end: the
/// capture's answer and the turn end's.
fn drain_after_refused_capture() -> (Outcome<()>, Outcome<Drained>) {
    let long = fmt!("/m/{}", "x".repeat(crate::store::call::PATH_WIRE_MAX + 10));
    counted(|st, _, _| {
        let captured = st.capture(D, &long, change(&long, b"o", b"n"));
        let ctx = turn_ctx();
        let drained = rt().block_on(async {
            let hold = match st.hold_versions(D).await {
                Ok(h)   => h,
                Err(e)  => panic!("hold_versions: {}", e),
            };
            st.drain_turn(&hold, D, &ctx).await
        });
        (captured, drained)
    })
}

/// The port carries a capture's refusal since D1int, so it is the capture's answer, which the
/// act's answer tells; the D1r1 interim that kept it to refuse the turn end is retired, and the
/// turn end records the rest.
#[test]
fn a_refused_capture_is_its_answer_and_the_turn_end_stands() {
    let (red, _) = with_off("keep", drain_after_refused_capture);
    assert!(red.is_ok(), "the refusal answered with the rule off: {:?}", red.as_ref().err());
    eprintln!("RED keep: with the refusal dropped, capture answers {:?}", red);

    let (got, drained) = drain_after_refused_capture();
    assert!(got.is_err(), "a refused capture answered Ok");
    assert!(drained.is_ok(), "the turn end refused: {:?}", drained.err());
}

/// A link that answers every call named `fail` with the store down, as a store whose call
/// panicked does.
#[derive(Clone)]
struct Downing {
    link: LoopLink,
    fail: &'static str,
}

impl Downing {
    fn down() -> StoreReply {
        StoreReply::Fault(crate::store::call::Fault::Down(crate::store::call::StoreDown {
            why: s("injected"),
        }))
    }
}

impl StoreLink for Downing {
    async fn call(&self, call: &StoreCall) -> Outcome<StoreReply> {
        if call.name() == self.fail {
            return Ok(Self::down());
        }
        self.link.call(call).await
    }
    fn call_blocking(&self, call: &StoreCall) -> Outcome<StoreReply> {
        if call.name() == self.fail {
            return Ok(Self::down());
        }
        self.link.call_blocking(call)
    }
    fn notify(&self, call: &StoreCall) {
        if call.name() != self.fail {
            let _ = self.link.send(call);
        }
    }
}

/// `capture` over a link whose store is down at `capture`: its answer.
fn capture_store_down() -> Outcome<()> {
    let (srv, link) = served(seeded());
    let st = RemoteStore::new(Downing { link, fail: "capture" });
    let got = st.capture(D, "a.txt", change("/m/a.txt", b"old a", b"new a"));
    drop(st);
    srv.stop();
    got
}

/// An injected `StoreDown` at `capture` is the capture's answer, never dropped (D1int).
#[test]
fn a_store_down_at_capture_is_its_answer() {
    let red = with_off("keep", capture_store_down);
    assert!(red.is_ok(), "the refusal answered with the rule off: {:?}", red.as_ref().err());
    eprintln!("RED down: with the refusal dropped, capture answers {:?}", red);

    match capture_store_down() {
        Ok(())  => panic!("a capture the store was down for answered Ok"),
        Err(e)  => assert!(crate::store::call::is_store_down(&e), "not the store's down: {}", e),
    }
}

// ┌───────────────────────────────────────────────────────────────┐
// │ D1v2c's rules across the link (D1r1-V2C)                       │
// └───────────────────────────────────────────────────────────────┘
//
// These rules are the store server's, not the client's, so no `switch_off` turns them off: each
// test's red is the server before D1v2c (7a78862d's server, standing and diamond).

fn env_of(run: &str) -> RunEnv { RunEnv { run: s(run), page: s(run), ..env() } }

fn bound(srv: &StoreServer, run: &str) -> LoopLink {
    match srv.bind(Tag::Run, env_of(run)) {
        Ok(l)   => l,
        Err(e)  => panic!("binding {}: {}", run, e),
    }
}

/// A remote `hold_versions` stalled in flight while the run `b` poisons the store: its answer.
fn a_hold_in_flight_at_a_poison() -> Result<(), String> {
    let (srv, a) = served(seeded());
    let b = bound(&srv, "b");
    let st = RemoteStore::new(a);
    if let Err(e) = srv.stall("hold_versions", 2) {
        panic!("the stall: {}", e);
    }
    let got = rt().block_on(async {
        let poison = async {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            if let Err(e) = srv.fuse("is_steering") {
                panic!("the fuse: {}", e);
            }
            b.call(&StoreCall::IsSteering { id: s(D) }).await
        };
        let (held, fused) = tokio::join!(st.hold_versions(D), poison);
        assert!(matches!(fused, Ok(StoreReply::Fault(Fault::Down(_)))), "the poison: {}", o(&fused));
        match held {
            Ok(_)   => Ok(()),
            Err(e)  => Err(fmt!("{}", e)),
        }
    });
    drop(st);
    srv.stop();
    got
}

#[test]
fn a_remote_call_in_flight_at_a_poison_is_answered_down() {
    let got = a_hold_in_flight_at_a_poison();
    match &got {
        Ok(())  => eprintln!("RED poison: the hold in flight at the poison was granted"),
        Err(e)  => eprintln!("poison: the hold in flight answered {}", e),
    }
    assert!(got.is_err(), "a hold in flight at the poison was granted");
}

/// The run's capture of `c` through the remote port; then over its link a `turn_stands` page
/// naming `c` and an invented `x`, and `c` alone again.
fn stands_after_a_refused_page() -> (Outcome<()>, Outcome<()>) {
    counted(|st, link, _| {
        let path = "notes/c.md";
        let (before, after): (Vec<u8>, Vec<u8>) = ((0..40u8).collect(), (100..140u8).collect());
        st.capture(D, path, change(path, &before, &after));
        let wire = &link.link;
        match wire.call_blocking(&StoreCall::TurnWants { id: s(D) }) {
            Ok(StoreReply::TurnWants(Ok(_)))    => (),
            other                               => panic!("turn_wants answered {}", o(&other)),
        }
        let seen = Seen::of(Some(&after));
        let stands = |page: Vec<(String, Seen)>| {
            match wire.call_blocking(&StoreCall::TurnStands { id: s(D), stands: page }) {
                Ok(StoreReply::TurnStands(r))   => r,
                other                           => panic!("turn_stands answered {}", o(&other)),
            }
        };
        let refused = stands(vec![(s(path), seen.clone()), (s("notes/x.md"), seen.clone())]);
        let again = stands(vec![(s(path), seen)]);
        (refused, again)
    })
}

#[test]
fn a_refused_stands_page_is_taken_none_over_the_link() {
    let (refused, again) = stands_after_a_refused_page();
    assert!(refused.is_err(), "the page naming an invented path was taken");
    if let Err(e) = &again {
        eprintln!("RED stands: the refused page's valid entry was taken, c again refused: {}", e);
    }
    assert!(again.is_ok(), "the refused page was taken in part: {:?}", again.err());
}

fn kind(o: OpenDelete) -> String {
    match o {
        OpenDelete::Go(b)       => fmt!("go {}", b),
        OpenDelete::Ask(n, _)   => fmt!("ask at {}", n),
        OpenDelete::Stopped(n)  => fmt!("stopped at {}", n),
    }
}

/// The conductor `c` deletes to its limit; the worker `w` deletes until it is asked, says stop;
/// then `c`'s turn counts end, and `w` deletes again.  Every answer, in order.
fn a_stop_after_anothers_turn_end(
    room: impl Fn(&str, &str) -> OpenDelete,
    say:  impl Fn(u64),
    end_c: impl Fn(),
) -> Vec<String> {
    let limit = crate::diamond_versions::OPEN_DELETES_ASK_DEFAULT;
    let mut log = Vec::new();
    for n in 0..limit {
        log.push(fmt!("c {}", kind(room("c", &fmt!("c{}", n)))));
    }
    for n in 0..=limit {
        match room("w", &fmt!("f{}", n)) {
            OpenDelete::Ask(k, t)   => {
                log.push(fmt!("w asked at {}", k));
                say(t);
                break;
            }
            other                   => log.push(fmt!("w {}", kind(other))),
        }
    }
    log.push(fmt!("w {}", kind(room("w", "over"))));
    end_c();
    log.push(fmt!("after c's end, w {}", kind(room("w", "over"))));
    log
}

fn stop_after_anothers_end_direct() -> Vec<String> {
    direct(seeded(), |_| async move {
        let of = |run: &str| env_of(run);
        a_stop_after_anothers_turn_end(
            |run, f| of(run).sync_scope(|| Direct.open_delete_room(D, f)),
            |t| of("w").sync_scope(|| Direct.open_delete_answer(D, t, false)),
            || of("c").sync_scope(|| Direct.end_turn_counts(D)),
        )
    })
}

fn stop_after_anothers_end_remote() -> Vec<String> {
    let mem = seeded();
    let srv = match StoreServer::start(NativeBackend::Mem(mem)) {
        Ok(s)   => s,
        Err(e)  => panic!("the store server: {}", e),
    };
    let (w, c) = (RemoteStore::new(bound(&srv, "w")), RemoteStore::new(bound(&srv, "c")));
    let log = a_stop_after_anothers_turn_end(
        |run, f| if run == "w" { w.open_delete_room(D, f) } else { c.open_delete_room(D, f) },
        |t| w.open_delete_answer(D, t, false),
        || c.end_turn_counts(D),
    );
    drop((w, c));
    srv.stop();
    log
}

#[test]
fn one_runs_end_turn_counts_over_the_link_leaves_anothers_stop_standing() {
    let (direct, remote) = (stop_after_anothers_end_direct(), stop_after_anothers_end_remote());
    let last = remote.last().cloned().unwrap_or_default();
    if !last.starts_with("after c's end, w stopped") {
        eprintln!("RED counts: over the link, {}", last);
    }
    assert_eq!(remote, direct, "the remote's answers against the direct store's");
    assert!(last.starts_with("after c's end, w stopped"), "w's stop was lifted: {:?}", remote);
}

// ┌───────────────────────────────────────────────────────────────┐
// │ The body channel client (D1r3)                                 │
// └───────────────────────────────────────────────────────────────┘

/// `n` bytes that are not all one value, so a chunk out of place is seen.
fn bytes_of(n: usize, seed: u8) -> Vec<u8> {
    (0..n).map(|i| (i as u32).wrapping_mul(2654435761).rotate_left(seed as u32) as u8).collect()
}

/// A 20 MB `before` captured, then read back as the file this turn found: the copy fetched, the
/// largest frame sent, and the `body_get` frames.
fn copy_20mb() -> (bool, usize, usize) {
    let before = bytes_of(20 * 1024 * 1024, 3);
    let after = b"the edit".to_vec();
    counted(|st, link, _| {
        st.capture(D, "/m/big.bin", change("/m/big.bin", &before, &after));
        let got = rt().block_on(st.this_turn_found(D, "/m/big.bin", &after));
        let sent = link.take();
        let most = sent.iter().map(|f| f.1).max().unwrap_or(0);
        let gets = sent.iter().filter(|f| f.0 == "body_get").count();
        (matches!(got, TurnFound::Was(b) if b == before), most, gets)
    })
}

#[test]
fn a_20mb_copy_round_trips_byte_equal_in_frames_within_frame_max() {
    let (equal, _, _) = with_off("chunk", copy_20mb);
    assert!(!equal, "an unchunked 20 MB upload round-tripped");
    eprintln!("RED chunk: uploaded in one body_put, the 20 MB copy does not come back");

    let (equal, most, gets) = copy_20mb();
    assert!(equal, "the 20 MB copy came back different");
    assert!(most <= FRAME_MAX, "a frame of {} over FRAME_MAX", most);
    assert!(gets >= 20, "fetched in {} body_get frames", gets);
}

/// `measured_against` asked with a 30 MB `now` nothing holds: equal to the caller's bytes, and the
/// `body_get` frames sent.
fn measured_30mb() -> (bool, usize) {
    let now = bytes_of(30 * 1024 * 1024, 5);
    counted(|st, link, _| {
        let got = rt().block_on(st.measured_against(D, "/m/n.bin", &now));
        let gets = link.take().iter().filter(|f| f.0 == "body_get").count();
        (got == now, gets)
    })
}

#[test]
fn measured_against_maps_the_callers_own_now_with_no_body_get() {
    let (_, gets) = with_off("mine", measured_30mb);
    assert!(gets > 0, "the unmapped answer was not fetched");
    eprintln!("RED mine: unmapped, the caller's own 30 MB comes back in {} body_get frames", gets);

    let (equal, gets) = measured_30mb();
    assert!(equal, "the answer is not the caller's bytes");
    assert_eq!(gets, 0, "body_get frames sent");
}

/// The `body_put` frames a capture of an `after` over 512 KiB sends.
fn puts_of_large_after() -> usize {
    let after = bytes_of(crate::diamond_versions::VERSION_FILE_MAX + 1, 7);
    let c = Change { before: None, ..change("/m/out.pdf", b"", &after) };
    counted(|st, link, _| {
        st.capture(D, "/m/out.pdf", c);
        link.take().iter().filter(|f| f.0 == "body_put").count()
    })
}

#[test]
fn an_after_over_512_kib_is_never_uploaded() {
    let red = with_off("large", puts_of_large_after);
    assert!(red > 0, "the after was not uploaded with the rule off");
    eprintln!("RED large: the after over 512 KiB is uploaded in {} body_put frames", red);

    assert_eq!(puts_of_large_after(), 0, "body_put frames for an after over 512 KiB");
}

/// The frames sent by a capture, with bodies, and a `measured_against` of a path over
/// `PATH_WIRE_MAX`; and whether `measured_against` answered the caller's bytes.
fn frames_of_long_path() -> (Vec<(String, usize)>, bool) {
    let long = fmt!("/m/{}", "x".repeat(crate::store::call::PATH_WIRE_MAX + 10));
    counted(|st, link, _| {
        st.capture(D, &long, change(&long, b"old", b"new"));
        let got = rt().block_on(st.measured_against(D, &long, b"now"));
        (link.take(), got == b"now")
    })
}

#[test]
fn a_path_over_path_wire_max_is_refused_before_any_frame() {
    let (red, _) = with_off("bound", frames_of_long_path);
    assert!(!red.is_empty(), "no frame went with the rule off");
    eprintln!("RED bound: a path over PATH_WIRE_MAX sends {:?} before its refusal",
        red.iter().map(|f| f.0.as_str()).collect::<Vec<_>>());

    let (sent, answered) = frames_of_long_path();
    assert!(sent.is_empty(), "frames sent: {:?}", sent);
    assert!(answered, "measured_against did not answer the caller's bytes");
}

// ┌───────────────────────────────────────────────────────────────┐
// │ The D1r1 check's fixes (D1r1e)                                 │
// └───────────────────────────────────────────────────────────────┘

/// A link that fails every call named `fail`, as a link that drops one frame does.
#[derive(Clone)]
struct Failing {
    link: LoopLink,
    fail: &'static str,
}

impl Failing {
    fn dropped(&self) -> Error<ErrTag> {
        err!("The link dropped the call '{}'.", self.fail; IO, Write)
    }
}

impl StoreLink for Failing {
    async fn call(&self, call: &StoreCall) -> Outcome<StoreReply> {
        if call.name() == self.fail {
            return Err(self.dropped());
        }
        self.link.call(call).await
    }
    fn call_blocking(&self, call: &StoreCall) -> Outcome<StoreReply> {
        if call.name() == self.fail {
            return Err(self.dropped());
        }
        self.link.call_blocking(call)
    }
    fn notify(&self, call: &StoreCall) {
        if call.name() != self.fail {
            let _ = self.link.send(call);
        }
    }
}

/// A capture, then `f` over a link that fails `fail`, then the turn end.
fn drain_after(fail: &'static str, f: impl FnOnce(&RemoteStore<Failing>)) -> Outcome<Drained> {
    let mem = seeded();
    let (srv, link) = served(mem);
    let st = RemoteStore::new(Failing { link, fail });
    st.capture(D, "a.txt", change("/m/a.txt", b"old a", b"new a"));
    f(&st);
    let ctx = turn_ctx();
    let got = rt().block_on(async {
        let hold = match st.hold_versions(D).await {
            Ok(h)   => h,
            Err(e)  => panic!("hold_versions: {}", e),
        };
        st.drain_turn(&hold, D, &ctx).await
    });
    drop(st);
    srv.stop();
    got
}

/// A `ran_opaque` the link lost refuses the turn end, as a refused capture does: the turn never
/// trusts its captures past a command it did not see (D1r1 check D-Q1d).
#[test]
fn a_lost_opaque_run_mark_refuses_the_turn_end() {
    let lost = || drain_after("ran_opaque", |st| st.ran_opaque(D));
    let red = with_off("opaque", lost);
    assert!(red.is_ok(), "the turn end refused with nothing kept: {:?}", red.as_ref().err());
    eprintln!("RED opaque: with the lost mark dropped, drain_turn answers Ok");

    let got = lost();
    assert!(got.is_err(), "the turn end passed a lost opaque-run mark: {:?}", got);
}

/// A `restore_landed` whose `restore_store` the link lost answers the fault, which the act's
/// answer tells; read as "no restore open", it was dropped (D1r1 check D-Q1c).  Since D1int the
/// port carries it, so it is no longer kept to refuse the next turn end.
#[test]
fn a_restore_landed_whose_restore_cannot_be_asked_is_its_answer() {
    let lost = |fail: &'static str| {
        let landed = std::cell::RefCell::new(Ok(()));
        let drained = drain_after(fail,
            |st| *landed.borrow_mut() = st.restore_landed(99, change("/m/r.txt", b"r", b"r2")));
        (landed.into_inner(), drained)
    };
    let (red, _) = with_off("restore_fault", || lost("restore_store"));
    assert!(red.is_ok(), "the fault answered with the rule off: {:?}", red.as_ref().err());
    eprintln!("RED restore fault: read as no restore open, restore_landed answers Ok");

    let (got, drained) = lost("restore_store");
    assert!(got.is_err(), "a restore_landed it could not place answered Ok");
    assert!(drained.is_ok(), "the turn end refused: {:?}", drained.err());
    let (none, drained) = lost("nothing");
    assert!(none.is_ok(), "no restore open, yet restore_landed answered {:?}", none.err());
    assert!(drained.is_ok(), "no restore open, yet the turn end refused: {:?}", drained.err());
}

/// Three changes, each with a before and an after, recorded one call each (the port takes one
/// change, D1r1e ruling 4), directly and over the link: each answer as a line (D1r1 check D-Q1b).
/// Red, before the port took one change: one call of all three, refused over the link ("4
/// unnamed uploads of the act 1 are staged already") and recorded directly.
fn three_recorded() -> (Vec<String>, Vec<String>) {
    async fn record<S: HostStore>(st: &S) -> Vec<String> {
        let mut out = Vec::new();
        for c in [
            change("/m/x.txt", b"x old", b"x new"),
            change("/m/y.txt", b"y old", b"y new"),
            change("/m/z.txt", b"z old", b"z new"),
        ] {
            out.push(o(&st.versions_record(D, Cause::Save, "t1", "three", c).await));
        }
        out
    }
    let here = direct(seeded(), |_| async move { record(&Direct).await });
    let (srv, link) = served(seeded());
    let st = RemoteStore::new(link);
    let there = rt().block_on(record(&st));
    drop(st);
    srv.stop();
    (here, there)
}

#[test]
fn three_changes_record_over_the_link_as_directly() {
    let (here, there) = three_recorded();
    assert_eq!(here, there);
    assert!(here.iter().all(|l| l.starts_with("Ok(Some")), "{:?}", here);
}

// The turn end's child half (D1r2): the same turn directly, as the tab reads, and over the link.
#[path = "remote_turn_tests.rs"]
mod turn_end;

// R1b: the same port over a pipe between processes.
#[path = "pipe_tests.rs"]
mod pipe;

// ┌───────────────────────────────────────────────────────────────┐
// │ D1int-b rider (2): the engine's ledger-named change            │
// └───────────────────────────────────────────────────────────────┘

/// The paths the differential names: held, over the ceiling, absent, the Diamond's own, its
/// store's own record, and one outside the workspace.
const NAMED: [&str; 6] = ["notes/a.md", "notes/big.bin", "notes/none.md", "diamonds/d/x.md",
    "diamonds/d/.daimond/log.json", "../out.md"];

/// Each change as `(path, after, mark)`, the fields a ledger-named row is made of.
fn rows(chs: Vec<Change>) -> Vec<(String, String, bool)> {
    chs.into_iter().map(|c| (c.path, fmt!("{:?}", c.after), c.mark)).collect()
}

/// The store's `diamond::versions_changes` of [`NAMED`] read through a door on a folder holding
/// them, and the engine's maker of the same paths over a fs holding the same bytes, asked through
/// the direct port.  `old` makes the engine's side as its turn end did before D1int-b.
fn named_both(old: bool) -> (Vec<(String, String, bool)>, Vec<(String, String, bool)>) {
    let home = std::env::var("HOME").unwrap_or_default();
    let tmp = std::env::var("DAIMOND_TEST_TMP")
        .unwrap_or_else(|_| fmt!("{}/.cache/lane-daimond-runner/tmp-rnd1int", home));
    let dir = std::path::PathBuf::from(tmp).join(fmt!("named-{}-{}", old, std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let big = vec![b'b'; crate::diamond_versions::VERSION_FILE_MAX + 1];
    let files: [(&str, &[u8]); 4] = [("notes/a.md", b"a"), ("notes/big.bin", &big),
        ("diamonds/d/x.md", b"x"), ("diamonds/d/.daimond/log.json", b"{}")];
    let fs = crate::engine::host::test::fs::TestFs::default();
    let mem = MemBackend::default();
    rt().block_on(async {
        for (rel, body) in files.iter() {
            let at = dir.join(rel);
            if let Some(up) = at.parent() {
                let _ = std::fs::create_dir_all(up);
            }
            if let Err(e) = std::fs::write(&at, body) {
                panic!("writing {}: {}", rel, e);
            }
            if let Err(e) = fs.put(FileRoot::Workspace, rel, body) {
                panic!("putting {}: {}", rel, e);
            }
            if let Err(e) = mem.write_file(rel, body).await {
                panic!("seeding {}: {}", rel, e);
            }
        }
    });
    let paths: Vec<String> = NAMED.iter().map(|p| s(p)).collect();
    let root = dir.clone();
    let store = direct(mem, move |_ctx| async move {
        use crate::store::door::{DirLink, DoorEnv, Link};
        DoorEnv::new(D, Link::Dir(DirLink::new(root)))
            .scope(diamond::versions_changes(D, &paths)).await
    });
    let mut engine = Vec::new();
    rt().block_on(async {
        for path in NAMED.iter() {
            let made = if old {
                // The turn-end test's helper, the one maker the engine had.
                Some(Change::of(path, path.as_bytes().to_vec()))
            } else {
                crate::engine::host::store::named_change(&Direct, &fs, D, path, None).await
            };
            engine.extend(made);
        }
    });
    let _ = std::fs::remove_dir_all(&dir);
    (rows(store), rows(engine))
}

/// The engine's ledger-named change is the row the store's own `versions_changes` makes of the same
/// file: the versionable filter, `theirs`, `TooLarge` past the ceiling, and `Gone` (D1int-b).
#[test]
fn a_ledger_named_change_is_the_stores_own() {
    let (store, red) = named_both(true);
    assert_ne!(store, red, "the old maker already agreed");
    eprintln!("RED named: the store {:?}\n  the old engine maker {:?}", store, red);

    let (store, engine) = named_both(false);
    assert_eq!(store.len(), 4, "the store versions four of the six: {:?}", store);
    assert_eq!(engine, store);
}


// ┌───────────────────────────────────────────────────────────────┐
// │ The run journals (U4e)                                         │
// └───────────────────────────────────────────────────────────────┘

/// What one side's journal answers: three rounds put, one put again, read, then dropped twice and
/// read again.
type Journal = (Vec<(u64, Vec<u8>)>, bool, Vec<(u64, Vec<u8>)>);

async fn journal_of<S: HostStore>(st: &S, big: &[u8]) -> Outcome<Journal> {
    res!(st.journal_put("a", 2, b"round two").await);
    res!(st.journal_put("a", 1, big).await);
    res!(st.journal_put("a", 3, b"").await);
    res!(st.journal_put("a", 2, b"round two again").await);
    let read = res!(st.journal_read("a").await);
    let dropped = st.journal_drop("a").await.is_ok() && st.journal_drop("a").await.is_ok();
    Ok((read, dropped, res!(st.journal_read("a").await)))
}

/// The direct port and the port over a `LoopLink` keep one journal alike, a 3 MiB round in it,
/// and every frame the remote sends is within `FRAME_MAX`.  Red: unchunked, the 3 MiB round is
/// one frame over `FRAME_MAX` and is refused.
#[test]
fn a_journal_over_the_link_is_the_direct_one_in_frames_within_frame_max() {
    let big = bytes_of(3 << 20, 7);
    let b = big.clone();
    let direct = direct(seeded(), move |_| async move { journal_of(&Direct, &b).await });
    let direct = match direct {
        Ok(j)   => j,
        Err(e)  => panic!("the direct journal: {}", e),
    };
    assert_eq!(direct.0.iter().map(|(r, b)| (*r, b.len())).collect::<Vec<_>>(),
        vec![(1, 3 << 20), (2, 15), (3, 0)]);
    assert_eq!(direct.0[0].1, big);
    assert!(direct.1 && direct.2.is_empty());

    let remote = |big: Vec<u8>| counted(|st, link, _| {
        let got = rt().block_on(journal_of(st, &big));
        (got, link.take())
    });
    let (got, _) = with_off("chunk", || remote(big.clone()));
    match got {
        Err(e) => eprintln!("RED chunk: an unchunked 3 MiB round is refused: {}", e),
        Ok(_)  => panic!("an unchunked 3 MiB round crossed"),
    }

    let (got, sent) = remote(big);
    let got = match got {
        Ok(j)   => j,
        Err(e)  => panic!("the remote journal: {}", e),
    };
    assert_eq!(got, direct, "the journal over the link differs from the direct one");
    let most = sent.iter().map(|f| f.1).max().unwrap_or(0);
    assert!(most <= FRAME_MAX, "a frame of {} over FRAME_MAX", most);
    let puts = sent.iter().filter(|f| f.0 == "journal_put").count();
    let reads = sent.iter().filter(|f| f.0 == "journal_read").count();
    assert!(puts >= 6 && reads >= 6, "{} journal_put and {} journal_read frames", puts, reads);
}

/// The journal round's reply frames too: the largest `journal_read` answer is within `FRAME_MAX`.
#[test]
fn a_journal_read_reply_is_within_frame_max() -> Outcome<()> {
    let r = StoreReply::JournalRead(Ok(Some(crate::store::call::JournalChunk {
        key: crate::store::call::JournalKey::Round(u64::MAX), len: u64::MAX, chunk: vec![0xff; crate::store::call::BODY_CHUNK] })));
    let n = res!(crate::store::call::encode_reply(&r)).len();
    assert!(n <= FRAME_MAX, "{} bytes", n);
    Ok(())
}

/// A run reads, writes and drops its own journal alone (`RunEnv`); the parent, any run's.
/// Red: with the rule off, run `b` reads run `a`'s journal.
#[test]
fn another_runs_journal_is_refused() {
    let (srv, a) = served(seeded());
    let b = match srv.bind(Tag::Run, env_of("b")) {
        Ok(l)   => l,
        Err(e)  => panic!("binding b: {}", e),
    };
    let p = match srv.bind(Tag::Parent, env_of("parent")) {
        Ok(l)   => l,
        Err(e)  => panic!("binding the parent: {}", e),
    };
    let (sa, sb, sp) = (RemoteStore::new(a), RemoteStore::new(b), RemoteStore::new(p));
    rt().block_on(async {
        if let Err(e) = sa.journal_put("a", 1, b"a's round").await {
            panic!("a's own journal_put: {}", e);
        }
        if let Err(e) = srv.rule_off("journal_scope") {
            panic!("rule_off: {}", e);
        }
        match sb.journal_read("a").await {
            Ok(v)   => eprintln!("RED journal_scope: run b read run a's journal: {} rounds", v.len()),
            Err(e)  => panic!("with the rule off, b was refused: {}", e),
        }
    });
    drop((sa, sb, sp));
    srv.stop();

    let (srv, a) = served(seeded());
    let b = match srv.bind(Tag::Run, env_of("b")) {
        Ok(l)   => l,
        Err(e)  => panic!("binding b: {}", e),
    };
    let p = match srv.bind(Tag::Parent, env_of("parent")) {
        Ok(l)   => l,
        Err(e)  => panic!("binding the parent: {}", e),
    };
    let (sa, sb, sp) = (RemoteStore::new(a), RemoteStore::new(b), RemoteStore::new(p));
    rt().block_on(async {
        if let Err(e) = sa.journal_put("a", 1, b"a's round").await {
            panic!("a's own journal_put: {}", e);
        }
        let read = sb.journal_read("a").await;
        assert!(matches!(&read, Err(e) if fmt!("{}", e).contains("journal a")),
            "b read a's journal: {:?}", read.map(|v| v.len()));
        assert!(sb.journal_put("a", 2, b"b's").await.is_err(), "b wrote a's journal");
        assert!(sb.journal_drop("a").await.is_err(), "b dropped a's journal");
        match sa.journal_read("a").await {
            Ok(v)   => assert_eq!(v, vec![(1, b"a's round".to_vec())]),
            Err(e)  => panic!("a's own journal_read: {}", e),
        }
        match sp.journal_read("a").await {
            Ok(v)   => assert_eq!(v.len(), 1, "the parent reads a's journal"),
            Err(e)  => panic!("the parent's journal_read: {}", e),
        }
    });
    drop((sa, sb, sp));
    srv.stop();
}

/// Which runs have a journal, and the sweep of them, are the parent's alone (R1i): a run is
/// refused both, whatever it names; the parent lists each run with whether its open record is
/// there, an `Open` record no reader of the rounds takes for one.  Red: with the rule off, run
/// `b` lists the journals.
#[test]
fn journal_list_and_sweep_are_the_parents_alone() {
    use crate::store::call::JournalRun;
    let (srv, a) = served(seeded());
    let b = bound(&srv, "b");
    let sb = RemoteStore::new(b);
    rt().block_on(async {
        if let Err(e) = RemoteStore::new(a).journal_put("a", 1, b"a's round").await {
            panic!("a's own journal_put: {}", e);
        }
        if let Err(e) = srv.rule_off("journal_parent") {
            panic!("rule_off: {}", e);
        }
        match sb.journal_list().await {
            Ok(v)   => eprintln!("RED journal_parent: run b listed the journals: {:?}", v),
            Err(e)  => panic!("with the rule off, b was refused: {}", e),
        }
    });
    drop(sb);
    srv.stop();

    let (srv, a) = served(seeded());
    let b = bound(&srv, "b");
    let p = match srv.bind(Tag::Parent, env_of("parent")) {
        Ok(l)   => l,
        Err(e)  => panic!("binding the parent: {}", e),
    };
    let (sa, sb, sp) = (RemoteStore::new(a), RemoteStore::new(b), RemoteStore::new(p));
    rt().block_on(async {
        if let Err(e) = sa.journal_put("a", 1, b"a's round").await {
            panic!("a's own journal_put: {}", e);
        }
        let listed = sb.journal_list().await;
        assert!(matches!(&listed, Err(e) if fmt!("{}", e).contains("journals")),
            "b listed the journals: {:?}", listed);
        assert!(sb.journal_sweep(0, u64::MAX).await.is_err(), "b swept the journals");
        match sp.journal_list().await {
            Ok(v)   => assert_eq!(v, vec![JournalRun { run: s("a"), open: false }]),
            Err(e)  => panic!("the parent's journal_list: {}", e),
        }
        if let Err(e) = sp.journal_open_put("a", b"open\nspec\n").await {
            panic!("the parent's open record: {}", e);
        }
        match sp.journal_list().await {
            Ok(v)   => assert_eq!(v, vec![JournalRun { run: s("a"), open: true }]),
            Err(e)  => panic!("the parent's journal_list: {}", e),
        }
        match sp.journal_open("a").await {
            Ok(r)   => assert_eq!(r, Some(b"open\nspec\n".to_vec())),
            Err(e)  => panic!("the parent's journal_open: {}", e),
        }
        match sa.journal_read("a").await {
            Ok(v)   => assert_eq!(v, vec![(1, b"a's round".to_vec())], "the open record is no round"),
            Err(e)  => panic!("a's own journal_read: {}", e),
        }
        assert!(sb.journal_open("a").await.is_err(), "b read a's open record");
    });
    drop((sa, sb, sp));
    srv.stop();
}

/// The journal sweep (R1i over R1f3): a journal whose newest record is a TTL old at the caller's
/// clock goes, a younger one stays.  The clock is the test's: `now` is `A`'s stamp plus the TTL.
#[test]
fn a_journal_a_ttl_old_is_swept_and_a_younger_kept() {
    use crate::store::call::JournalRun;
    const TTL: u64 = 7 * 24 * 3600 * 1000;
    fn wall() -> u64 {
        match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
            Ok(d)   => d.as_millis() as u64,
            Err(_)  => 0,
        }
    }
    let (srv, _a) = served(seeded());
    let p = match srv.bind(Tag::Parent, env_of("parent")) {
        Ok(l)   => l,
        Err(e)  => panic!("binding the parent: {}", e),
    };
    let sp = RemoteStore::new(p);
    rt().block_on(async {
        if let Err(e) = sp.journal_put("old", 1, b"old's round").await {
            panic!("old's journal_put: {}", e);
        }
        if let Err(e) = sp.journal_open_put("old", b"open\nspec\n").await {
            panic!("old's open record: {}", e);
        }
        let stamped = wall();
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        if let Err(e) = sp.journal_put("young", 1, b"young's round").await {
            panic!("young's journal_put: {}", e);
        }
        let gone = match sp.journal_sweep(TTL, stamped + TTL).await {
            Ok(n)   => n,
            Err(e)  => panic!("the sweep: {}", e),
        };
        assert_eq!(gone, 2, "old's round and open record swept");
        match sp.journal_list().await {
            Ok(v)   => assert_eq!(v, vec![JournalRun { run: s("young"), open: false }]),
            Err(e)  => panic!("the parent's journal_list: {}", e),
        }
    });
    drop(sp);
    srv.stop();
}

// ---- QA PORT-L (A1, A3, B1, B2): the side files a settle may write, and how ----

/// QA-A1: an archive whose read fails (the file stands) is rewritten with only the new lines.
#[test]
fn qa_a_a_failed_archive_read_keeps_the_archive_history() {
    let archive = crate::tools::standing_archive(crate::tools::DECISIONS_FILE, D);
    let mem = seeded();
    let a2 = archive.clone();
    rt().block_on(async {
        if let Err(e) = mem.write_file(&a2, b"- 2025-01-01 OLD HISTORY line\n").await {
            panic!("seeding the archive: {}", e);
        }
    });
    mem.unreadable(&archive);
    let got = direct(mem.clone(), |_| async move {
        let st = &Direct;
        let l = match st.standing_retired(FileRoot::Opfs, DECISIONS, decisions_over()).await {
            Ok(l)  => l,
            Err(e) => panic!("standing_retired: {}", e),
        };
        settle_both(st, FileRoot::Opfs, DECISIONS, &l).await
    });
    let after = String::from_utf8_lossy(&mem.files().get(&archive).cloned().unwrap_or_default())
        .into_owned();
    eprintln!("QA-A1 settle answered {:?}; archive now {} bytes", got.as_ref().map(|_| ()), after.len());
    assert!(after.contains("OLD HISTORY"),
        "the archive's history was lost on a failed read: settle {:?}, archive starts {:?}",
        got.map(|_| ()), &after[..after.len().min(80)]);
}

/// QA-A2: a REQUIREMENTS.md landing may only append to its own archive, not DECISIONS'.
#[test]
fn qa_a_a_requirements_landing_names_only_its_own_archive() {
    let path = fmt!("diamonds/{}/{}", D, crate::tools::REQUIREMENTS_FILE);
    let darchive = crate::tools::standing_archive(crate::tools::DECISIONS_FILE, D);
    let mem = seeded();
    let got = direct(mem.clone(), move |_| async move {
        settle_both(&Direct, FileRoot::Opfs, &path, &Landed {
            archive: vec![(s(crate::tools::DECISIONS_FILE), s("- 2026-10-19 planted\n"))],
            ..Landed::default()
        }).await
    });
    let wrote = mem.files().get(&darchive).cloned();
    assert!(got.is_err() && wrote.is_none(),
        "a REQUIREMENTS.md landing appended to the decisions archive: {:?}, {:?}",
        got.map(|_| ()), wrote.map(|b| String::from_utf8_lossy(&b).into_owned()));
}
/// QA PORT-L B1: a child's settle replaces DECISIONS.md whole, unarchived, from a STATE.md path.
#[test]
fn qa_b1_a_childs_settle_does_not_replace_decisions_unarchived() {
    let his = b"# Decisions\n\n- 2026-10-01 one\n- 2026-10-02 two\n";
    counted(|st, _, mem| rt().block_on(async {
        if let Err(e) = mem.write_file(DECISIONS, his).await { panic!("seed: {}", e); }
        // The wire carries no DECISIONS body now: only lines, which are appended (PORT-L QA B1).
        let forged = Landed { noted: vec![s("- 2026-10-19 three")], ..Landed::default() };
        let got = settle_both(st, FileRoot::Opfs, "diamonds/d/STATE.md", &forged).await;
        let now = mem.files().get(DECISIONS).cloned().unwrap_or_default();
        let arch = mem.files().get(&crate::tools::standing_archive(
            crate::tools::DECISIONS_FILE, D)).cloned().unwrap_or_default();
        eprintln!("QA B1: settle answered {:?}; DECISIONS.md now {} bytes (was {}), archive {} bytes",
            got.is_ok(), now.len(), his.len(), arch.len());
        assert!(got.is_err() || now.starts_with(his),
            "a child's settle replaced DECISIONS.md ({} -> {} bytes) and archived none of it",
            his.len(), now.len());
    }));
}

/// QA PORT-L B2: a REQUIREMENTS.md landing appends to the DECISIONS archive.
#[test]
fn qa_b2_a_landing_appends_only_to_its_own_archive() {
    counted(|st, _, mem| rt().block_on(async {
        let forged = Landed {
            archive: vec![(s(crate::tools::DECISIONS_FILE), s("- 2026-10-19 never decided\n"))],
            ..Landed::default()
        };
        let got = settle_both(st, FileRoot::Opfs, "diamonds/d/REQUIREMENTS.md", &forged).await;
        let arch = mem.files().get(&crate::tools::standing_archive(
            crate::tools::DECISIONS_FILE, D)).cloned();
        eprintln!("QA B2: settle answered {:?}; decisions-archive now {:?}", got.is_ok(),
            arch.as_ref().map(|b| String::from_utf8_lossy(b).into_owned()));
        assert!(arch.is_none(), "a REQUIREMENTS.md landing wrote the DECISIONS archive");
    }));
}

// ---- QA PORT-LF round 2, half A (not for commit) ----

/// R2-1: an over-ceiling DECISIONS.md that a STATE.md landing appends to loses no line: every
/// line he had is in DECISIONS.md or the archive afterwards, and the new line is in DECISIONS.md.
#[test]
fn qa_r2a_noted_append_over_ceiling_loses_nothing() {
    let his = decisions_over();
    let archive = crate::tools::standing_archive(crate::tools::DECISIONS_FILE, D);
    let mem = seeded();
    let h2 = his.clone();
    rt().block_on(async {
        if let Err(e) = mem.write_file(DECISIONS, h2.as_bytes()).await { panic!("seed: {}", e); }
    });
    let got = direct(mem.clone(), |_| async move {
        settle_both(&Direct, FileRoot::Opfs, "diamonds/d/STATE.md",
            &Landed { noted: vec![s("- 2026-10-19 NEW line")], touched: vec![s("1\tWhere")],
                ..Landed::default() }).await
    });
    if let Err(e) = got { panic!("settle: {}", e); }
    let f = mem.files();
    let now = String::from_utf8_lossy(&f.get(DECISIONS).cloned().unwrap_or_default()).into_owned();
    let arch = String::from_utf8_lossy(&f.get(&archive).cloned().unwrap_or_default()).into_owned();
    assert!(now.len() <= crate::tools::DECISIONS_CAP, "DECISIONS.md left over its ceiling");
    assert!(now.contains("- 2026-10-19 NEW line"), "the noted line is not in DECISIONS.md");
    for l in his.lines().filter(|l| l.starts_with("- ")) {
        assert!(now.contains(l) || arch.contains(l), "lost: {}", l);
    }
    let t = String::from_utf8_lossy(&f.get(&crate::store::diamond::touched_path(D)).cloned()
        .unwrap_or_default()).into_owned();
    assert_eq!(t, "1\tWhere\n");
}

/// R2-2: DECISIONS.md stands but will not read: the settle refuses, and nothing is written.
#[test]
fn qa_r2a_unreadable_decisions_refuses_and_writes_nothing() {
    let his = b"# Decisions\n\n- 2026-10-01 one\n";
    let mem = seeded();
    rt().block_on(async {
        if let Err(e) = mem.write_file(DECISIONS, his).await { panic!("seed: {}", e); }
    });
    mem.unreadable(DECISIONS);
    let got = direct(mem.clone(), |_| async move {
        settle_both(&Direct, FileRoot::Opfs, "diamonds/d/STATE.md",
            &Landed { noted: vec![s("- 2026-10-19 x")], ..Landed::default() }).await
    });
    assert!(got.is_err(), "an unreadable DECISIONS.md was settled over");
    assert_eq!(mem.files().get(DECISIONS).cloned(), Some(his.to_vec()));
}

/// R2-3: a child's noted line with a newline is refused by the server before any write.
#[test]
fn qa_r2a_child_multiline_noted_refused() {
    counted(|st, _, mem| rt().block_on(async {
        let got = settle_both(st, FileRoot::Opfs, "diamonds/d/STATE.md",
            &Landed { noted: vec![s("- a\n# Decisions")], ..Landed::default() }).await;
        assert!(got.is_err(), "a multi-line noted row settled");
        assert!(mem.files().get(DECISIONS).is_none(), "DECISIONS.md written by a refused settle");
    }));
}

// ---- PLF-NF: absent only on NotFound ----

/// PLF-NF: DECISIONS.md stands, will not read, and every lookup of it fails other than
/// not-found.  The settle refuses and DECISIONS.md is left as it was: a failed lookup is never
/// taken for a new file.
#[test]
fn plfnf_a_failed_lookup_refuses_the_settle_and_keeps_the_file() {
    let his = b"# Decisions\n\n- 2026-10-01 one\n";
    let mem = seeded();
    rt().block_on(async {
        if let Err(e) = mem.write_file(DECISIONS, his).await { panic!("seed: {}", e); }
    });
    mem.unreadable(DECISIONS);
    mem.unprobeable(DECISIONS);
    let got = direct(mem.clone(), |_| async move {
        settle_both(&Direct, FileRoot::Opfs, "diamonds/d/STATE.md",
            &Landed { noted: vec![s("- 2026-10-19 x")], ..Landed::default() }).await
    });
    match got {
        Ok(_)  => panic!("a settle over a failed lookup of DECISIONS.md went through"),
        Err(e) => assert!(fmt!("{}", e).contains("DECISIONS.md"), "no path named: {}", e),
    }
    assert_eq!(mem.files().get(DECISIONS).cloned(), Some(his.to_vec()));
}

/// PLF-NF: DECISIONS.md reads, but the bound write's compare lookup fails other than
/// not-found.  The write is refused and the file is untouched.
#[test]
fn plfnf_a_failed_compare_lookup_refuses_the_write() {
    let his = b"# Decisions\n\n- 2026-10-01 one\n";
    let mem = seeded();
    rt().block_on(async {
        if let Err(e) = mem.write_file(DECISIONS, his).await { panic!("seed: {}", e); }
    });
    mem.unprobeable(DECISIONS);
    let got = direct(mem.clone(), |_| async move {
        settle_both(&Direct, FileRoot::Opfs, "diamonds/d/STATE.md",
            &Landed { noted: vec![s("- 2026-10-19 x")], ..Landed::default() }).await
    });
    assert!(got.is_err(), "a bound write over a failed compare lookup went through");
    assert_eq!(mem.files().get(DECISIONS).cloned(), Some(his.to_vec()));
}

// ┌───────────────────────────────────────────────────────────────┐
// │ The activity record and the no-progress K (PORT-PL-B)          │
// └───────────────────────────────────────────────────────────────┘

/// When the activity script runs, ms since the epoch: 2026-10-19.
const ACT_NOW: i64 = 1_792_368_000_000;

/// The Mem store of [`seeded`], its Diamond `d` with its own K of 20 (UNBLOCK-27 R4).
fn seeded_k() -> MemBackend {
    let mem = seeded();
    let meta: &[u8] = br#"{"name":"d","crystal_version":0,"updated":0,"touched":0,"no_progress_rounds":20}"#;
    rt().block_on(async {
        if let Err(e) = mem.write_file("diamonds/d/.daimond/meta.json", meta).await {
            panic!("seeding the meta: {}", e);
        }
    });
    mem
}

/// The three ports in turn, each answer a line: K, an empty record, two appends, the record.
async fn activity_script<S: HostStore>(st: &S) -> Vec<String> {
    let mut log: Vec<String> = Vec::new();
    log.push(fmt!("no_progress_rounds d {} f {}", st.no_progress_rounds(D).await,
        st.no_progress_rounds(E).await));
    log.push(fmt!("activity_read_all empty {:?}", st.activity_read_all(D).await));
    let one = crate::activity::Turn::new(ACT_NOW - 60_000, "phone", Some(3), "make a widget",
        &[s("widget.html")], "Made the widget.\nIt is on the page.");
    log.push(fmt!("activity_append one {}", o(&st.activity_append(D, one, ACT_NOW).await)));
    let two = crate::activity::Turn::new(ACT_NOW, "phone", None, "look at it", &[], "Looked.");
    log.push(fmt!("activity_append two {}", o(&st.activity_append(D, two, ACT_NOW).await)));
    log.push(fmt!("activity_read_all {:?}", st.activity_read_all(D).await));
    log
}

/// C2 MEMORY (812e7a821, fb2e6d20f) and UNBLOCK-27 R4 (b4243babf) on the HostStore: the record
/// and K answer through the link as directly, and leave the same bytes.
#[test]
fn the_activity_record_and_k_answer_through_the_link_as_directly() {
    let mem = seeded_k();
    let here = direct(mem.clone(), |_| async move { activity_script(&Direct).await });
    let here_files = files_of(&mem, &[]);

    let mem = seeded_k();
    let (srv, link) = served(mem.clone());
    let store = RemoteStore::new(link);
    let there = rt().block_on(activity_script(&store));
    drop(store);
    srv.stop();
    let there_files = files_of(&mem, &[]);

    let lines = differ(&here, &there);
    assert!(lines.is_empty(), "the answers differ:\n{}", lines.join("\n"));
    let files = differ(&here_files, &there_files);
    assert!(files.is_empty(), "the stores differ:\n{}", files.join("\n"));

    assert_eq!("no_progress_rounds d 20 f 0", here[0], "{:?}", here);
    assert_eq!("activity_read_all empty []", here[1], "{:?}", here);
    assert!(here[2].contains("Ok") && here[3].contains("Ok"), "{:?}", here);
    let all = &here[4];
    assert!(all.contains(".daimond/activity/phone.log"), "{}", all);
    assert!(all.contains("make a widget") && all.contains("look at it"), "{}", all);
    assert!(all.contains("Made the widget.") && !all.contains("It is on the page."), "{}", all);
}

/// C2b MEMORY's import join (812e7a821) on r1's `import_diamond_pack`: a pull keeps this
/// device's lines the export lacks, joins the file it has, and lays down another device's.
#[test]
fn a_pull_keeps_this_devices_activity_and_joins_the_exports() {
    let got = direct(seeded(), |_| async move {
        let mine = crate::activity::Turn::new(ACT_NOW, "phone", None, "since the push", &[], "Done.");
        if let Err(e) = diamond::activity_append(D, mine, ACT_NOW).await {
            panic!("the local line: {}", e);
        }
        let theirs = crate::activity::Turn::new(ACT_NOW - 1000, "phone", None, "before the push",
            &[], "Done.");
        let laptop = crate::activity::Turn::new(ACT_NOW - 500, "laptop", Some(4), "on the laptop",
            &[], "Done.");
        let line = |t| fmt!("{}\n", crate::activity::encode(&crate::activity::Entry::Turn(t)));
        let pack = diamond::Pack {
            id:    Some(s(D)),
            name:  Some(s("d")),
            files: Ok(vec![
                (s(".daimond/meta.json"),
                    br#"{"name":"d","crystal_version":0,"updated":0,"touched":0}"#.to_vec()),
                (s("crystal.json"), br#"{"title":"d","sections":[]}"#.to_vec()),
                (s(".daimond/activity/phone.log"), line(theirs).into_bytes()),
                (s(".daimond/activity/laptop.log"), line(laptop).into_bytes()),
            ]),
        };
        if let Err(e) = diamond::import_diamond_pack("{}", pack, false).await {
            panic!("the import: {}", e);
        }
        diamond::activity_read_all(D).await
    });
    let rels: Vec<&str> = got.iter().map(|(r, _)| r.as_str()).collect();
    assert_eq!(vec![".daimond/activity/laptop.log", ".daimond/activity/phone.log"], rels);
    assert!(got[0].1.contains("on the laptop"), "{:?}", got);
    assert!(got[1].1.contains("since the push"), "this device's line is kept: {:?}", got);
    assert!(got[1].1.contains("before the push"), "the export's line is joined: {:?}", got);
}

// ---- HL2: one settle per phase (held-lock settle P2) ----

/// A STATE.md landing with all three parts, of the Diamond `d`.
fn hl2_landing() -> Landed {
    Landed {
        kept:       s("# State\n\n## Where\n\nhere\n"),
        archive:    vec![(s(crate::tools::DECISIONS_FILE), s("- 2026-10-19 a section retired\n"))],
        noted:      vec![s("- 2026-10-19 Where retired")],
        touched:    vec![s("1760832000000\tWhere")],
        at:         1760832000000,
        ..Landed::default()
    }
}

/// The decisions archive, DECISIONS.md and the touched record of `d` in `mem`.
fn hl2_files(mem: &MemBackend) -> [Option<Vec<u8>>; 3] {
    [crate::tools::standing_archive(crate::tools::DECISIONS_FILE, D), s(DECISIONS),
        crate::store::diamond::touched_path(D)].map(|p| mem.files().get(&p).cloned())
}

/// HL2 (a): an `Archive` settle carrying noted lines is refused with nothing written, and the
/// port's `Archive` of a whole landing writes the archive and no DECISIONS.md.
#[test]
fn hl2_archive_with_noted_writes_no_decisions() {
    let mem = seeded();
    let got = direct(mem.clone(), |_| async move {
        crate::store::diamond::standing_settle(FileRoot::Opfs, STATE_MD, &hl2_landing(),
            SettlePhase::Archive).await
    });
    assert!(got.is_err(), "an Archive settle carrying noted lines went through");
    assert_eq!(hl2_files(&mem), [None, None, None], "a refused Archive settle wrote a file");
    for remote in [false, true] {
        let mem = seeded();
        let got = if remote {
            counted_on(mem.clone(), |st, _, _| rt().block_on(
                st.standing_settle(FileRoot::Opfs, STATE_MD, &hl2_landing(), SettlePhase::Archive)))
        } else {
            direct(mem.clone(), |_| async move {
                Direct.standing_settle(FileRoot::Opfs, STATE_MD, &hl2_landing(),
                    SettlePhase::Archive).await
            })
        };
        assert!(got.is_ok(), "remote {}: the Archive phase: {:?}", remote, got);
        let f = hl2_files(&mem);
        assert!(f[0].is_some() && f[1].is_none() && f[2].is_none(),
            "remote {}: the Archive phase wrote other than the archive: {:?}", remote, f);
    }
}

/// HL2 (b): a `Record` settle carrying an archive is refused with nothing written, on the store
/// and through the wire by hand, and the port's `Record` of a whole landing writes no archive.
#[test]
fn hl2_record_writes_no_archive() {
    let mem = seeded();
    let got = direct(mem.clone(), |_| async move {
        crate::store::diamond::standing_settle(FileRoot::Opfs, STATE_MD, &hl2_landing(),
            SettlePhase::Record).await
    });
    assert!(got.is_err(), "a Record settle carrying an archive went through");
    assert_eq!(hl2_files(&mem), [None, None, None], "a refused Record settle wrote a file");
    // A forged call: the server checks the parts it is sent.
    let mem = seeded();
    let got = counted_on(mem.clone(), |st, _, _| {
        let text = b"- 2026-10-19 forged\n";
        let call = StoreCall::StandingSettle {
            id: s(D), root: FileRoot::Opfs, path: s(STATE_MD), phase: SettlePhase::Record,
            archive: vec![(s(crate::tools::DECISIONS_FILE), BodyRef::of(text))],
            noted: vec![s("- 2026-10-19 x")], touched: vec![], at: 1,
        };
        st.send_blocking(D, call, &[text])
    });
    assert!(!matches!(got, Ok(StoreReply::StandingSettle(Ok(())))),
        "the server took an archive on a Record call: {:?}", got);
    assert_eq!(hl2_files(&mem), [None, None, None], "a forged Record call wrote a file");
    for remote in [false, true] {
        let mem = seeded();
        let got = if remote {
            counted_on(mem.clone(), |st, _, _| rt().block_on(
                st.standing_settle(FileRoot::Opfs, STATE_MD, &hl2_landing(), SettlePhase::Record)))
        } else {
            direct(mem.clone(), |_| async move {
                Direct.standing_settle(FileRoot::Opfs, STATE_MD, &hl2_landing(),
                    SettlePhase::Record).await
            })
        };
        assert!(got.is_ok(), "remote {}: the Record phase: {:?}", remote, got);
        let f = hl2_files(&mem);
        assert!(f[0].is_none() && f[1].is_some() && f[2].is_some(),
            "remote {}: the Record phase wrote other than DECISIONS.md and touched: {:?}",
            remote, f);
    }
}

/// HL2 (e): two `Record`s out of order keep the newer stamp, and a removal older than a row
/// does not take it out; a removal no older does.
#[test]
fn hl2_records_out_of_order_keep_the_newer_stamp() {
    let rows = |v: &[&str]| v.iter().map(|r| s(r)).collect::<Vec<String>>();
    let mut lines = rows(&["5\tWhere", "5\tPlan"]);
    crate::store::diamond::touched_merge(&mut lines, &rows(&["9\tWhere"]), 9);
    crate::store::diamond::touched_merge(&mut lines, &rows(&["7\tWhere"]), 7);
    assert_eq!(lines, rows(&["9\tWhere", "5\tPlan"]), "the later, older Record won");
    crate::store::diamond::touched_merge(&mut lines, &rows(&["\tWhere"]), 8);
    assert_eq!(lines, rows(&["9\tWhere", "5\tPlan"]), "an older removal took a newer row out");
    crate::store::diamond::touched_merge(&mut lines, &rows(&["\tPlan"]), 5);
    assert_eq!(lines, rows(&["9\tWhere"]), "a removal as new as the row left it");
    // Through both ports, as the store settles them.
    for remote in [false, true] {
        let mem = state_seeded();
        let land = |touched: &str, at: u64| Landed { touched: vec![s(touched)], at,
            ..Landed::default() };
        let newer = land("20\tWhere", 20);
        let older = land("10\tWhere", 10);
        let gone = land("\tWhere", 15);
        let got: Outcome<()> = if remote {
            counted_on(mem.clone(), move |st, _, _| rt().block_on(async move {
                for l in [newer, older, gone] {
                    res!(st.standing_settle(FileRoot::Opfs, STATE_MD, &l, SettlePhase::Record)
                        .await);
                }
                Ok(())
            }))
        } else {
            direct(mem.clone(), move |_| async move {
                for l in [newer, older, gone] {
                    res!(Direct.standing_settle(FileRoot::Opfs, STATE_MD, &l,
                        SettlePhase::Record).await);
                }
                Ok(())
            })
        };
        assert!(got.is_ok(), "remote {}: {:?}", remote, got);
        let touched = mem.files().get(&crate::store::diamond::touched_path(D)).cloned();
        assert_eq!(touched, Some(b"20\tWhere\n2\tPlan\n".to_vec()),
            "remote {}: the record kept other than the newer stamp", remote);
    }
}

/// HL2 (f), I-HL4: a STATE.md that stands but will not read is an Err, locally and through
/// StateRead, never a landing over empty; an absent one lands, `from` Absent on both.
#[test]
fn hl2_an_unreadable_state_is_an_error_not_an_empty_landing() {
    let text = || s("# State\n\n## Where\n\nnew\n");
    for unread in [STATE_MD.to_string(), crate::store::diamond::touched_path(D)] {
        let mem = state_seeded();
        mem.unreadable(&unread);
        let local = direct(mem.clone(), move |_| async move {
            Direct.standing_retired(FileRoot::Opfs, STATE_MD, text()).await
        });
        assert!(local.is_err(), "{}: unreadable, the local landing was {:?}", unread, local);
        let mem = state_seeded();
        mem.unreadable(&unread);
        let child = counted_on(mem.clone(), |st, _, _| rt().block_on(
            st.standing_retired(FileRoot::Opfs, STATE_MD, text())));
        assert!(child.is_err(), "{}: unreadable, the child's landing was {:?}", unread, child);
        let read = counted_on(mem, |st, _, _| state_read_of(st, D, FileRoot::Opfs, STATE_MD));
        assert!(state_read_refused(&read), "{}: StateRead answered {:?}", unread, read);
    }
    let local = direct(seeded(), move |_| async move {
        Direct.standing_retired(FileRoot::Opfs, STATE_MD, text()).await
    });
    let child = counted_on(seeded(), |st, _, _| rt().block_on(
        st.standing_retired(FileRoot::Opfs, STATE_MD, text())));
    let absent = Some(crate::diamond_versions::Seen::Absent);
    match (local, child) {
        (Ok(l), Ok(c))  => assert!(l.from == absent && c.from == absent,
            "an absent STATE.md read as {:?} / {:?}", l.from, c.from),
        (l, c)          => panic!("an absent STATE.md did not land: {:?} / {:?}", l, c),
    }
    let read = counted_on(seeded(), |st, _, _| state_read_of(st, D, FileRoot::Opfs, STATE_MD));
    assert!(matches!(read, Ok(StoreReply::StateRead(Ok((None, None))))),
        "an absent STATE.md was not said absent: {:?}", read);
}

/// HL2: a STATE.md landing is bound to what it read: `from` is the Seen of the bytes that stood,
/// the same on both hosts, and `at` its time.
#[test]
fn hl2_a_state_landing_carries_from_and_at() {
    let stood = b"# State\n\n## Where\n\nhere\n\n## Plan\n\nthe plan\n";
    let want = Some(crate::diamond_versions::Seen::of(Some(stood)));
    let (local, _) = state_landings(false);
    let (child, _) = state_landings(true);
    assert_eq!(local.from, want, "the local landing's from");
    assert_eq!(child.from, want, "the child's landing's from");
    assert!(local.at > 0 && child.at > 0, "no time: {} / {}", local.at, child.at);
}

// ---- HL6: the fold writes through the held, bound door (held-lock settle P2, review 3) ----

/// A decision a fold files.
const HL6_DECISION: &str = "- 2026-10-20 the fold's decision, with its reason";

/// A decision saved by hand between the fold's read and its write.
const HL6_SAVED: &str = "- 2026-10-21 a decision saved by hand while the fold ran";

/// What DECISIONS.md holds before the fold.
const HL6_STOOD: &str = "# Decisions\n\n- 2026-10-01 a decision that stood, with its reason\n";

/// The text at `path` in `mem`, empty where there is none.
fn hl6_text(mem: &MemBackend, path: &str) -> String {
    match mem.files().get(path) {
        Some(b) => String::from_utf8_lossy(b).into_owned(),
        None    => String::new(),
    }
}

/// `mem` with `files` written into it.
fn hl6_seeded(files: &[(&str, String)]) -> MemBackend {
    let mem = seeded();
    rt().block_on(async {
        for (k, b) in files.iter() {
            if let Err(e) = mem.write_file(k, b.as_bytes()).await {
                panic!("seed {}: {}", k, e);
            }
        }
    });
    mem
}

/// `notes` folded into `d` over `mem`, with each of `saves` made just before the fold's next
/// write of its path, between the fold's read and its write.
fn hl6_fold(mem: MemBackend, notes: FoldNotes, saves: Vec<(String, String)>)
    -> Option<FoldNotes>
{
    direct(mem, move |_| async move {
        crate::store::diamond::FOLD_SAVES.with(|s| *s.borrow_mut() = saves);
        let out = crate::store::diamond::absorb_fold_notes(D, &notes).await;
        crate::store::diamond::FOLD_SAVES.with(|s| s.borrow_mut().clear());
        out
    })
}

/// HL6 (a), I-HL1: a save to DECISIONS.md between the fold's read and its write survives, with
/// the fold's notes absorbed again on top of it.  Red with the plain write: the save is lost.
#[test]
fn hl6_a_a_decisions_save_during_the_fold_survives() {
    let mem = hl6_seeded(&[(DECISIONS, s(HL6_STOOD))]);
    let saved = fmt!("{}{}\n", HL6_STOOD, HL6_SAVED);
    let notes = FoldNotes { decisions: vec![s(HL6_DECISION)], ..Default::default() };
    let out = hl6_fold(mem.clone(), notes, vec![(s(DECISIONS), saved)]);
    assert!(out.is_some(), "the fold was not filed");
    let now = hl6_text(&mem, DECISIONS);
    assert!(now.contains(HL6_SAVED), "the save was written over: {}", now);
    assert!(now.contains("the fold's decision"), "the fold's note was not filed: {}", now);
    assert!(now.contains("a decision that stood"), "what stood was lost: {}", now);
}

/// HL6 (b): a fold refused on every one of its tries answers `None` and writes nothing: each
/// file holds what was saved, and nothing of the fold's.
#[test]
fn hl6_b_refused_on_every_try_the_fold_is_none_and_writes_nothing() {
    let mem = hl6_seeded(&[(DECISIONS, s(HL6_STOOD))]);
    let saves: Vec<(String, String)> = (0..crate::store::diamond::SETTLE_TRIES)
        .map(|n| (s(DECISIONS), fmt!("{}- 2026-10-21 hand save {}\n", HL6_STOOD, n)))
        .collect();
    let last = match saves.last() {
        Some((_, t))    => t.clone(),
        None            => panic!("no saves"),
    };
    let notes = FoldNotes { decisions: vec![s(HL6_DECISION)], ..Default::default() };
    let out = hl6_fold(mem.clone(), notes, saves);
    assert!(out.is_none(), "a fold refused on every try was filed: {:?}", out);
    assert_eq!(hl6_text(&mem, DECISIONS), last, "the fold wrote DECISIONS.md");
    for leaf in [crate::tools::REQUIREMENTS_FILE, crate::tools::STATE_FILE] {
        let path = fmt!("diamonds/{}/{}", D, leaf);
        assert!(!mem.files().contains_key(&path), "the fold wrote {}", path);
    }
}

/// HL6 (c), I-HL1: in the fold's source the archive is the held write's pre step, before the
/// write, and the record follows it; no plain write of a standing file is left.
#[test]
fn hl6_c_the_folds_archive_write_and_record_are_in_order() {
    const SRC: &str = include_str!("diamond.rs");
    let at = |src: &str, what: &str| match src.find(what) {
        Some(i) => i,
        None    => panic!("not found: {}", what),
    };
    let f = &SRC[at(SRC, "pub async fn absorb_fold_notes_guarded<")..];
    let f = &f[..at(f, "\n}\n")];
    assert!(!f.contains("own::write_file("), "the fold still plain-writes: {}", f);
    let archive = at(f, "SettlePhase::Archive");
    let write = at(f, "own::write_file_then(");
    let record = at(f, "SettlePhase::Record");
    assert!(archive < write && write < record, "archive {} < write {} < record {}", archive,
        write, record);
}

/// HL6 (d), I-HL1: as (a), for STATE.md, bound to the landing's `from`.
#[test]
fn hl6_d_a_state_save_during_the_fold_survives() {
    let ms = match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        Ok(d)   => d.as_millis(),
        Err(e)  => panic!("the clock: {}", e),
    };
    let mem = hl6_seeded(&[
        (STATE_MD, s("# State\n\n## Where\n\nhere\n")),
        (&crate::store::diamond::touched_path(D), fmt!("{}\tWhere\n", ms)),
    ]);
    let saved = s("# State\n\n## Where\n\nmoved by hand\n");
    let notes = FoldNotes { next: s("the fold's next step"), ..Default::default() };
    let out = hl6_fold(mem.clone(), notes, vec![(s(STATE_MD), saved)]);
    assert!(out.is_some(), "the fold was not filed");
    let now = hl6_text(&mem, STATE_MD);
    assert!(now.contains("moved by hand"), "the save was written over: {}", now);
    assert!(now.contains("the fold's next step"), "the fold's note was not filed: {}", now);
}

/// QA1 F5, one run: notes folded into `d` over `mem` with a commit guard that says the store
/// answered busy; `red` switches the guard off (`fold_guard`).  Answers DECISIONS.md after.
fn qa1_f5_run(red: bool) -> String {
    let mem = hl6_seeded(&[(DECISIONS, s(HL6_STOOD))]);
    let notes = FoldNotes { decisions: vec![s(HL6_DECISION)], ..Default::default() };
    let _ = direct(mem.clone(), move |_| async move {
        if red {
            crate::store::diamond::switch_off(Some("fold_guard"));
        }
        let out = crate::store::diamond::absorb_fold_notes_guarded(D, &notes, || false).await;
        crate::store::diamond::switch_off(None);
        out
    });
    hl6_text(&mem, DECISIONS)
}

/// QA1 F5: the fold decides its commit under each file's lock, so a fold whose call was answered
/// busy files nothing; the standing files stay as they stood.  Red: `fold_guard` off, the fold's
/// notes land after the caller was told busy.
#[test]
fn qa1_f5_a_fold_answered_busy_files_nothing() {
    assert_eq!(qa1_f5_run(false), HL6_STOOD, "a fold answered busy changed DECISIONS.md");
    let red = qa1_f5_run(true);
    assert!(red.contains("the fold's decision"),
        "red: with fold_guard off the busy fold still filed nothing: {}", red);
    eprintln!("RED QA1 F5: fold_guard off, the busy fold filed its notes");
}

// ---- QA2 (E-PORT QA A1 F2, F4; A2 LOW 1): a read error is never an empty file ----

/// REQUIREMENTS.md as it stands before a turn.
const QA2_REQS: &str = "diamonds/d/REQUIREMENTS.md";

/// The three standing files, each with words of the person's own.
fn qa2_standing() -> MemBackend {
    hl6_seeded(&[
        (QA2_REQS, s("# Requirements\n\n- [ ] the person's own task\n")),
        (DECISIONS, s(HL6_STOOD)),
        (STATE_MD, s("# State\n\n## Where\n\nthe person's own place\n")),
    ])
}

/// THE RELEASE ARM `standing_read_error` (F2, live on r578e): STATE.md stands but one read of it
/// fails at a turn's start.  The turn is refused, naming the file, and it and every other file in
/// the store are exactly as they were: no template over it, no version, no record.  Red before
/// QA2: the template was written over the file.
#[test]
fn standing_read_error() {
    let mem = qa2_standing();
    mem.unreadable(STATE_MD);
    let was = mem.files();
    let got = direct(mem.clone(), |_| async move {
        crate::store::diamond::ensure_standing(D).await.map(|_| ())
    });
    assert_eq!(mem.files(), was, "a turn's start wrote over a file that would not read");
    match got {
        Ok(())  => panic!("a turn started over a STATE.md that would not read"),
        Err(e)  => assert!(fmt!("{}", e).contains("STATE.md"), "no file named: {}", e),
    }
}

/// F2, the same door through `open[]`: REQUIREMENTS.md will not read and the crystal still has an
/// `open[]`.  Neither moves: the entries stay in the crystal for a turn that can file them, and
/// REQUIREMENTS.md keeps the person's words.  Red before QA2: the crystal lost `open[]` and
/// REQUIREMENTS.md was written over with the entries alone.
#[test]
fn standing_read_error_leaves_open_in_the_crystal() {
    let mem = qa2_standing();
    rt().block_on(async {
        if let Err(e) = mem.write_file("diamonds/d/crystal.json",
            br#"{"title":"d","sections":[],"open":["a thread still open"]}"#).await
        {
            panic!("seed: {}", e);
        }
    });
    mem.unreadable(QA2_REQS);
    let was = mem.files();
    let got = direct(mem.clone(), |_| async move {
        crate::store::diamond::ensure_standing(D).await.map(|_| ())
    });
    assert!(got.is_err(), "a turn started over a REQUIREMENTS.md that would not read");
    assert_eq!(mem.files(), was, "a turn's start wrote over REQUIREMENTS.md or the crystal");
}

/// F2, still seeded: an ABSENT file is given its template, as before.
#[test]
fn standing_absent_is_still_seeded() {
    let mem = seeded();
    let files = direct(mem.clone(), |_| async move {
        crate::store::diamond::ensure_standing(D).await
    });
    let files = match files {
        Ok(f)   => f,
        Err(e)  => panic!("an absent file was taken for unread: {}", e),
    };
    assert_eq!(files.state, crate::tools::standing_template(crate::tools::STATE_FILE));
    assert_eq!(hl6_text(&mem, STATE_MD), files.state, "STATE.md was not seeded");
}

/// F4: the fold's archive will not read, so the fold files nothing (a quiet `None`) and
/// DECISIONS.md keeps what stood.  Red before QA2: the archive was read as empty and the fold
/// filed on.
#[test]
fn qa2_f4_an_unreadable_archive_folds_nothing() {
    let archive = crate::tools::standing_archive(crate::tools::DECISIONS_FILE, D);
    let mem = hl6_seeded(&[
        (DECISIONS, s(HL6_STOOD)),
        (&archive, s("- 2025-01-01 an old decision, retired\n")),
    ]);
    mem.unreadable(&archive);
    let notes = FoldNotes { decisions: vec![s(HL6_DECISION)], ..Default::default() };
    let out = hl6_fold(mem.clone(), notes, Vec::new());
    assert!(out.is_none(), "a fold over an unreadable archive was filed: {:?}", out);
    assert_eq!(hl6_text(&mem, DECISIONS), HL6_STOOD, "the fold wrote DECISIONS.md");
}

/// A2 LOW 1: the crystal's head will not read, so its put-back has no target (an Err naming the
/// file), never one judged against an empty head.  Red before QA2: `Ok`.
#[test]
fn qa2_a2_an_unreadable_crystal_head_is_no_put_back() {
    let mem = seeded();
    mem.unreadable("diamonds/d/crystal.json");
    let got = direct(mem, |_| async move {
        crate::store::diamond::crystal_undo_target(D, CrystalHalf::Data, None).await
            .map(|_| ())
    });
    match got {
        Ok(())  => panic!("a put-back was judged against a head that would not read"),
        Err(e)  => assert!(fmt!("{}", e).contains("crystal.json"), "no path named: {}", e),
    }
}

/// QA2, a site the grep found: the viewer notes stand but will not read, so a new note is refused
/// and the notes are kept, never rewritten with the new one alone.  Red before QA2.
#[test]
fn qa2_grep_unreadable_viewer_notes_are_kept() {
    let path = s("diamonds/d/.daimond/crystal_viewer.jsonl");
    let mem = hl6_seeded(&[(&path, s("{\"reason\":\"timeout\",\"missed\":[],\"at\":1}\n"))]);
    mem.unreadable(&path);
    let was = mem.files();
    let got = direct(mem.clone(), |_| async move {
        crate::store::diamond::note_viewer(D, "partial", &[s("k")]).await
    });
    assert!(got.is_err(), "a note was written over notes that would not read");
    assert_eq!(mem.files(), was, "the viewer notes were written over");
}

/// F2, the migration still moves: a REQUIREMENTS.md that reads takes the crystal's `open[]`, bound
/// to its read, and the key leaves the crystal after.
#[test]
fn standing_open_is_still_filed() {
    let mem = qa2_standing();
    rt().block_on(async {
        if let Err(e) = mem.write_file("diamonds/d/crystal.json",
            br#"{"title":"d","sections":[],"open":["a thread still open"]}"#).await
        {
            panic!("seed: {}", e);
        }
    });
    let got = direct(mem.clone(), |_| async move {
        crate::store::diamond::ensure_standing(D).await.map(|_| ())
    });
    assert!(got.is_ok(), "ensure_standing: {:?}", got.err().map(|e| fmt!("{}", e)));
    let req = hl6_text(&mem, QA2_REQS);
    assert!(req.contains("a thread still open"), "open[] was not filed: {}", req);
    assert!(req.contains("the person's own task"), "what stood was lost: {}", req);
    assert!(!hl6_text(&mem, "diamonds/d/crystal.json").contains("\"open\""), "open[] stayed");
}
