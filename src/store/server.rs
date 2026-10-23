//! The store server: one OS thread that owns the Diamond store, and the runs that reach it over a
//! channel (d1v1 §3, spec §16.1, §16.5).
//!
//! [`StoreServer::start`] installs a backend on a thread of its own and serves every run's
//! [`StoreCall`]s there, on a current-thread executor, so the store's thread-locals (its ledgers,
//! slots and windows) are one store for every run, as the tab's are one store for a daimon and its
//! workers.  A run is [`bind`](StoreServer::bind)ed first, under its [`RunEnv`] and a [`Tag`], and
//! gets a [`LoopLink`], which carries each call as its wire frame, so the frame bound holds in
//! process as it does between processes.
//!
//! - **A sync call** ([`StoreCall::sync`]) is answered inline in the receive loop by a plain
//!   function, inside the run's `RunEnv`: it cannot await, so it is answered ahead of every wait
//!   call, and a wait call parked on a lock never holds one up.  Sync calls (the ping among them)
//!   come on a queue of their own, which the loop empties before it takes the next wait call.
//! - **A panic** in any call is caught, and poisons the store: that call and every later one is
//!   answered [`StoreDown`], until the parent restarts it.
//! - **A wait call unanswered at [`BUSY_SECS`]** is answered [`StoreBusy`]; it runs on, and every
//!   other call is served as before.
//! - **A wait call** is spawned on the thread, inside the run's `RunEnv`, and its task kept in the
//!   run's table, so [`drop_run`](StoreServer::drop_run) can end it.
//! - **The port's own values** (a versions hold, a window, a steer, a dirty mark) stay on the
//!   thread, in the run's hold table, and cross as a [`Handle`].  A handle is answered only for
//!   the run that holds it.
//! - **Bodies** cross by reference, and the upload channel is D1v3's: until then the only body the
//!   store can resolve is the empty one, and each call that needs another answers as a host
//!   without a store does (u2_plan §9.2).

use crate::{
    diamond_versions::{Act, BodyRef, OpenDelete, Prior, Seen, TurnSaid},
    tools::FileRoot,
    engine::host::{
        store::{SlotHold, JOURNAL_ROOT, journal_clear, journal_load, journal_open, journal_rounds,
            journal_runs, journal_write_at, slot_changes,
            slot_drain_by, slot_end, slot_put, slot_take, slot_uncovered, slot_add},
        types::store::{self as types, FileAct, LIST_PAGE},
    },
    store::{
        call::{
            Fault, Handle, Recorded, StoreBusy, StoreCall, StoreDown, StoreReply, StoreUnknown, Unbound,
            Unlinked,
            HexHash, JournalChunk, JournalKey, Put, WantsPage, WireBody, WireStanding, WireText, WireTurnFound,
            BODY_CHUNK, HELD_PAGE, JOURNAL_PAGE,
            decode_call, decode_reply, encode_call, encode_reply,
        },
        diamond::{self, Around, Marked, Steering, VersionHold},
        install,
        native::NativeBackend,
        own,
        run::{self, RunEnv},
        standing::{self, Staged},
    },
};

use oxedyne_fe2o3_core::prelude::*;

use std::{
    cell::RefCell,
    collections::{BTreeMap, BTreeSet},
    future::Future,
    panic::{AssertUnwindSafe, catch_unwind},
    pin::Pin,
    rc::Rc,
    task::{Context, Poll},
    time::Duration,
};

/// A wait call unanswered this long is answered [`StoreBusy`], for its caller alone (spec §16.5).
pub const BUSY_SECS: u64 = 120;


// ┌───────────────────────────────────────────────────────────────┐
// │ The server and its links                                       │
// └───────────────────────────────────────────────────────────────┘

/// What a bound run may ask (spec §16.1).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Tag {
    /// A run's child: every call, on the Diamonds its `RunEnv` grants.
    Run,
    /// A door errand: the restore and body calls alone, on the Diamonds it is granted.
    Door,
    /// The parent itself: every call, on any Diamond.
    Parent,
}

enum Msg {
    Bind    { tag: Tag, env: RunEnv, done: flume::Sender<Outcome<()>> },
    Call    { run: String, frame: Vec<u8>, reply: flume::Sender<Vec<u8>> },
    DropRun { run: String, done: flume::Sender<()> },
    #[cfg(test)]
    Probe   { id: String, reply: flume::Sender<Probe> },
    /// Holds the store's thread until `open` is sent, once `entered` says it is held.
    #[cfg(test)]
    Gate    { entered: flume::Sender<()>, open: flume::Receiver<()> },
    /// The next call named `call` panics where it is served.
    #[cfg(test)]
    Fuse    { call: String, done: flume::Sender<()> },
    /// The next wait call named `call` sleeps `secs` on the store's clock before it is served.
    #[cfg(test)]
    Stall   { call: String, secs: u64, done: flume::Sender<()> },
    /// From now on `drop_run` leaves the run's hold table and ledger standing (D1x1a's red).
    #[cfg(test)]
    HoldOff { done: flume::Sender<()> },
    /// From now on the named rule is not applied (D1x1b's reds): `scope`, a Diamond the run was
    /// not granted; `wanted`, a staged path the snapshot does not name; `seen`, a staged `Seen`
    /// the snapshot does not name for its path; `sync_first`, the loop's bias to sync calls
    /// (D1x2b's red).
    #[cfg(test)]
    RuleOff { rule: &'static str, done: flume::Sender<()> },
    /// Opens or closes a restore on the store's own thread, inside a door on a folder: the
    /// parent's errand handler's part of a ticketed restore (D1x2a), whose acts come over a link.
    #[cfg(test)]
    Restore { step: TestRestore, done: flume::Sender<Outcome<(u64, Option<u64>, Vec<String>)>> },
    Stop,
}

/// The parent's half of a ticketed restore, run by [`StoreServer::restore`] for a test.
#[cfg(test)]
pub enum TestRestore {
    /// Open `plan` on `id` inside a door on `dir`: answers the ticket.
    Open    { id: String, plan: diamond::Plan, dir: std::path::PathBuf },
    /// Close `ticket` on `id` inside a door on `dir`: answers the version it put back, the version
    /// it recorded and the paths it restored.
    Close   { id: String, ticket: u64, dir: std::path::PathBuf },
}

/// What the store thread holds now, for the tests (d1v1 §4 4, 5).
#[cfg(test)]
#[derive(Clone, Debug)]
pub struct Probe {
    pub thread: std::thread::ThreadId,
    pub runs:   usize,  // bound runs
    pub held:   usize,  // entries over every run's hold table
    pub slots:  usize,  // turn slots open
    pub deletes: usize, // open-folder deletes counted, over every run's table
    pub windows: Vec<u64>,  // where each of the probed Diamond's windows ends; open at u64::MAX
    pub uploads: usize, // uploads staged and not yet named, over every run's table
    pub staged:  usize, // bytes those uploads hold
    pub capacity: usize, // bytes those uploads have allocated (D1mem-a C)
    pub out:     usize, // bodies named out, over every run's table
    pub claims:  usize, // claims in the probed Diamond's claims file
    pub ledger:  usize, // bytes the probed Diamond's turn ledgers hold in memory
    pub waits_at_sync: u64, // wait calls taken in when the last sync call was answered
}

/// The store's thread, and the channel every run reaches it through.
pub struct StoreServer {
    tx:     flume::Sender<Msg>,     // wait calls and the server's own messages
    sync:   flume::Sender<Msg>,     // sync calls, taken first
    thread: Option<std::thread::JoinHandle<()>>,
}

fn down(why: &str) -> Error<ErrTag> {
    StoreDown { why: why.to_string() }.to_error()
}

impl StoreServer {

    /// Starts the store's thread over `backend`, which is installed there and nowhere else.
    pub fn start(backend: NativeBackend) -> Outcome<Self> { Self::launch(backend, false) }

    /// [`start`](Self::start) with the thread's clock paused, so it runs ahead whenever the
    /// thread has nothing else to do: a 120 s wait passes at once.
    #[cfg(test)]
    pub fn start_paused(backend: NativeBackend) -> Outcome<Self> { Self::launch(backend, true) }

    fn launch(backend: NativeBackend, paused: bool) -> Outcome<Self> {
        let (tx, rx) = flume::unbounded::<Msg>();
        let (sync, sync_rx) = flume::unbounded::<Msg>();
        let (ready_tx, ready_rx) = flume::bounded::<Outcome<()>>(1);
        let spawned = std::thread::Builder::new()
            .name(String::from("daimond-store"))
            .spawn(move || {
                let mut b = tokio::runtime::Builder::new_current_thread();
                b.enable_all();
                #[cfg(test)]
                b.start_paused(paused);
                #[cfg(not(test))]
                let _ = paused;
                let rt = match b.build() {
                    Ok(rt)  => rt,
                    Err(e)  => {
                        let _ = ready_tx.send(Err(err!(e,
                            "The store thread's executor could not be built."; Init, Thread)));
                        return;
                    }
                };
                let _ = install(backend);
                let _ = ready_tx.send(Ok(()));
                let local = tokio::task::LocalSet::new();
                local.block_on(&rt, serve(sync_rx, rx));
                let _ = install(NativeBackend::Closed);
            });
        let thread = match spawned {
            Ok(t)   => t,
            Err(e)  => return Err(err!(e, "The store thread could not be started."; Init, Thread)),
        };
        match ready_rx.recv() {
            Ok(Ok(()))  => (),
            Ok(Err(e))  => return Err(e),
            Err(_)      => return Err(down("the store thread ended as it started")),
        }
        Ok(Self { tx, sync, thread: Some(thread) })
    }

    /// Binds the run `env.run` under `tag`.  The server makes its table and marks its page live
    /// before any of its calls is served: the channel keeps their order.  A run already bound, or
    /// a page a bound run holds, is refused, and the run bound first keeps its table (d1v1 check
    /// H1): two runs on one page would each forget the other's ledger and liveness.
    pub fn bind(&self, tag: Tag, env: RunEnv) -> Outcome<LoopLink> {
        if env.run.is_empty() || env.page.is_empty() {
            return Err(err!("A run is bound with a run name and a page, and '{}' on '{}' lacks one.",
                env.run, env.page; Invalid, Input));
        }
        let run = env.run.clone();
        let (done, wait) = flume::bounded(1);
        if self.tx.send(Msg::Bind { tag, env, done }).is_err() {
            return Err(down("the store thread has stopped"));
        }
        match wait.recv() {
            Ok(Ok(()))  => Ok(LoopLink { tx: self.tx.clone(), sync: self.sync.clone(), run }),
            Ok(Err(e))  => Err(e),
            Err(_)      => Err(down("the store thread stopped while it bound a run")),
        }
    }

    /// Ends the run `run`: its tasks, its hold table, its ledger and its liveness, in that order.  Answers once all of it is done.
    pub fn drop_run(&self, run: &str) -> Outcome<()> {
        let (done, wait) = flume::bounded(1);
        if self.tx.send(Msg::DropRun { run: run.to_string(), done }).is_err() {
            return Err(down("the store thread has stopped"));
        }
        match wait.recv() {
            Ok(())  => Ok(()),
            Err(_)  => Err(down("the store thread stopped while it dropped a run")),
        }
    }

    #[cfg(test)]
    pub fn probe(&self, id: &str) -> Outcome<Probe> {
        let (reply, wait) = flume::bounded(1);
        if self.tx.send(Msg::Probe { id: id.to_string(), reply }).is_err() {
            return Err(down("the store thread has stopped"));
        }
        match wait.recv() {
            Ok(p)   => Ok(p),
            Err(_)  => Err(down("the store thread did not answer its probe")),
        }
    }

    /// Holds the store's thread, until the sender returned is sent to or dropped.
    #[cfg(test)]
    pub fn gate(&self) -> Outcome<flume::Sender<()>> {
        let (entered, wait) = flume::bounded(1);
        let (opener, open) = flume::bounded(1);
        if self.tx.send(Msg::Gate { entered, open }).is_err() {
            return Err(down("the store thread has stopped"));
        }
        match wait.recv() {
            Ok(())  => Ok(opener),
            Err(_)  => Err(down("the store thread did not take its gate")),
        }
    }

    /// The next call named `call` panics where it is served.  Answers once the thread has it:
    /// a sync call sent after would otherwise be taken first.
    #[cfg(test)]
    pub fn fuse(&self, call: &str) -> Outcome<()> {
        let (done, wait) = flume::bounded(1);
        self.told(Msg::Fuse { call: call.to_string(), done }, wait)
    }

    #[cfg(test)]
    fn told(&self, msg: Msg, wait: flume::Receiver<()>) -> Outcome<()> {
        if self.tx.send(msg).is_err() {
            return Err(down("the store thread has stopped"));
        }
        match wait.recv() {
            Ok(())  => Ok(()),
            Err(_)  => Err(down("the store thread did not take its message")),
        }
    }

    /// The next wait call named `call` sleeps `secs` on the store's clock before it is served.
    #[cfg(test)]
    pub fn stall(&self, call: &str, secs: u64) -> Outcome<()> {
        let (done, wait) = flume::bounded(1);
        self.told(Msg::Stall { call: call.to_string(), secs, done }, wait)
    }

    /// Switches the hold table off: from now on [`drop_run`](Self::drop_run) ends a run's tasks
    /// and nothing else, so its reservations, windows, ledger and liveness outlive it (the red
    /// control of `tests_serial`'s case 3).
    #[cfg(test)]
    pub fn hold_table_off(&self) -> Outcome<()> {
        let (done, wait) = flume::bounded(1);
        self.told(Msg::HoldOff { done }, wait)
    }

    /// Switches `rule` off from now on (see [`Msg::RuleOff`]), for a red control.
    #[cfg(test)]
    pub fn rule_off(&self, rule: &'static str) -> Outcome<()> {
        let (done, wait) = flume::bounded(1);
        self.told(Msg::RuleOff { rule, done }, wait)
    }

    /// Runs `step` of a restore on the store's thread (see [`Msg::Restore`]).
    #[cfg(test)]
    pub fn restore(&self, step: TestRestore) -> Outcome<(u64, Option<u64>, Vec<String>)> {
        let (done, wait) = flume::bounded(1);
        if self.tx.send(Msg::Restore { step, done }).is_err() {
            return Err(down("the store thread has stopped"));
        }
        match wait.recv() {
            Ok(got) => got,
            Err(_)  => Err(down("the store thread did not take its message")),
        }
    }

    /// Stops the thread, dropping every run's table there, and waits for it.
    pub fn stop(mut self) { self.halt() }

    fn halt(&mut self) {
        let _ = self.tx.send(Msg::Stop);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl Drop for StoreServer {
    fn drop(&mut self) { self.halt() }
}

/// The bytes of call frames sent through a [`LoopLink`] and not yet taken in by the store's
/// loop, and the most there have been since [`queued_peak_reset`]: the relay's share of memory
/// in D1x2b's measure, process-wide, so read only by a test that runs alone.
#[cfg(test)]
static QUEUED: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
#[cfg(test)]
static QUEUED_PEAK: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

#[cfg(test)]
pub(crate) fn queued_peak_reset() {
    QUEUED_PEAK.store(QUEUED.load(std::sync::atomic::Ordering::Relaxed),
        std::sync::atomic::Ordering::Relaxed);
}

#[cfg(test)]
pub(crate) fn queued_peak() -> usize { QUEUED_PEAK.load(std::sync::atomic::Ordering::Relaxed) }

/// One bound run's way to the store.  Never called from the store's own thread, which would wait
/// on itself.
#[derive(Clone)]
pub struct LoopLink {
    tx:   flume::Sender<Msg>,
    sync: flume::Sender<Msg>,
    run:  String,
}

impl LoopLink {

    pub fn run(&self) -> &str { &self.run }

    pub(crate) fn send(&self, call: &StoreCall) -> Outcome<flume::Receiver<Vec<u8>>> {
        let frame = res!(encode_call(call));
        let (reply, wait) = flume::bounded(1);
        let queue = if call.sync() { &self.sync } else { &self.tx };
        #[cfg(test)]
        {
            use std::sync::atomic::Ordering::Relaxed;
            let now = QUEUED.fetch_add(frame.len(), Relaxed) + frame.len();
            QUEUED_PEAK.fetch_max(now, Relaxed);
        }
        if queue.send(Msg::Call { run: self.run.clone(), frame, reply }).is_err() {
            return Err(down("the store thread has stopped"));
        }
        Ok(wait)
    }

    /// `call`'s reply, or its [`Fault`] as a [`StoreReply::Fault`].  Err where the store is down.
    pub async fn call(&self, call: &StoreCall) -> Outcome<StoreReply> {
        let wait = res!(self.send(call));
        match wait.recv_async().await {
            Ok(bytes)   => decode_reply(&bytes),
            Err(_)      => Err(down(&fmt!("store.{} had no answer: the call was dropped",
                call.name()))),
        }
    }

    /// [`call`](Self::call), blocking the calling thread.
    pub fn call_blocking(&self, call: &StoreCall) -> Outcome<StoreReply> {
        let wait = res!(self.send(call));
        match wait.recv() {
            Ok(bytes)   => decode_reply(&bytes),
            Err(_)      => Err(down(&fmt!("store.{} had no answer: the call was dropped",
                call.name()))),
        }
    }
}


// ┌───────────────────────────────────────────────────────────────┐
// │ The store thread's tables                                      │
// └───────────────────────────────────────────────────────────────┘

/// Name `out` to the run of `t` as the body `hash` of `id`: at most `OUT_MAX`, the oldest naming
/// dropped (see [`State::name_out`]).
fn out_insert(t: &mut Table, id: &str, hash: &str, out: Out) {
    t.named = t.named.saturating_add(1);
    let at = t.named;
    t.out.entry((id.to_string(), hash.to_string()))
        .and_modify(|e| e.1 = at)
        .or_insert_with(|| (out, at));
    if t.out.len() > OUT_MAX {
        let oldest = t.out.iter().min_by_key(|(_, e)| e.1).map(|(k, _)| k.clone());
        if let Some(k) = oldest {
            t.out.remove(&k);
        }
    }
}

/// One of the port's own values, kept for the run that asked for it.
enum Held {
    Hold(Rc<SlotHold<VersionHold>>),
    Window(Around),
    #[allow(dead_code)]     // held for its drop, which ends the steer
    Steer(Steering),
    #[allow(dead_code)]     // taken by the dirty group's record (R7a)
    Marked(Marked),
}

/// A bound run's state on the store thread.
struct Table {
    tag:      Tag,
    env:      RunEnv,
    held:     BTreeMap<u64, Held>,
    tasks:    Vec<tokio::task::JoinHandle<()>>,
    deletes:  BTreeSet<(String, String)>,             // `(id, file)` counted by open_delete_room
    staged:   BTreeMap<String, Staged>,               // each Diamond's turn-end snapshot
    recorded: BTreeMap<(String, u64), Vec<String>>,   // the names each version recorded
    uploads:  BTreeMap<(String, String), Upload>,     // `(id, hash)`: bodies not yet named
    out:      BTreeMap<(String, String), (Out, u64)>,   // named to the run, and when
    named:    u64,                                    // the last naming, for `out`'s order
    journal:  Option<Rounding>,                       // the journal round under way
}

/// A journal record under way (U4e): `(run, key)`, its whole length, the bytes come so far.
struct Rounding {
    run:   String,
    key:   JournalKey,
    len:   u64,
    bytes: Vec<u8>,
}

impl Table {
    fn new(tag: Tag, env: RunEnv) -> Self {
        Self {
            tag,
            env,
            held:     BTreeMap::new(),
            tasks:    Vec::new(),
            deletes:  BTreeSet::new(),
            staged:   BTreeMap::new(),
            recorded: BTreeMap::new(),
            uploads:  BTreeMap::new(),
            out:      BTreeMap::new(),
            named:    0,
            journal:  None,
        }
    }
}

/// A body named out to a run: in hand, or in the Diamond's body store by its length, read once at
/// the first fetch and kept in hand to the last chunk (D1mem fix B).
enum Out {
    Bytes(Rc<Vec<u8>>),
    Stored(u64),
}

#[derive(Default)]
struct State {
    runs: BTreeMap<String, Table>,
    next: u64,  // the last handle given, over every run
    poisoned: Option<String>,   // why a caught panic poisoned the store
    down:     Rc<tokio::sync::Notify>,  // told every wait call in flight at the poison
    #[cfg(test)]
    fuse: Option<String>,   // the call that panics next
    #[cfg(test)]
    stall: Option<(String, u64)>,   // the wait call that sleeps next, and for how long
    #[cfg(test)]
    waits: u64,             // wait calls taken in
    #[cfg(test)]
    waits_at_sync: u64,     // `waits` when the last sync call was answered
    #[cfg(test)]
    hold_off: bool,         // `drop_run` leaves the table standing (D1x1a's red)
    #[cfg(test)]
    rules_off: Vec<&'static str>,   // the rules not applied (D1x1b's reds)
}

impl State {
    /// The end of `run`'s turn counts in `id`'s store: its open-folder deletes, with the person's
    /// answers, and its seals.  **Each run's tally is its own** (D1v2c, reversing D1v1c's tally
    /// shared by the store): no other run's count, stop or "go on" is touched, so his stop to a
    /// worker stands until the worker's own turn ends, and a "go on" never carries into another
    /// run's next turn.  Served in `run`'s scope, which [`diamond::end_turn_counts`] keys by.
    fn counts_end(&mut self, run: &str, id: &str) {
        if let Some(t) = self.runs.get_mut(run) {
            t.deletes.retain(|(of, _)| of != id);
        }
        diamond::end_turn_counts(id);
    }

    /// The end of `run`'s staged table for `id` (D1v2c): a turn's table never outlives its turn,
    /// so the next turn's fresh reading is never refused as sent already.
    fn unstage(&mut self, run: &str, id: &str) {
        if let Some(t) = self.runs.get_mut(run) {
            t.staged.remove(id);
        }
    }

    fn give(&mut self, run: &str, held: Held) -> Handle {
        self.next += 1;
        let h = self.next;
        if let Some(t) = self.runs.get_mut(run) {
            t.held.insert(h, held);
        }
        Handle(h)
    }

    fn hold(&self, run: &str, h: Handle) -> Outcome<Rc<SlotHold<VersionHold>>> {
        match self.runs.get(run).and_then(|t| t.held.get(&h.0)) {
            Some(Held::Hold(hold))  => Ok(hold.clone()),
            Some(_)                 => Err(err!(
                "store: handle {} is not a versions hold.", h.0; Invalid, Input)),
            None                    => Err(err!(
                "store: handle {} is no longer held.", h.0; Missing, Data)),
        }
    }

    /// `bytes` as the body a reply names to `run` for `id`, for `body_get` to serve: unless the
    /// call named them itself, since its sender holds them.  At most `OUT_MAX` per run, the
    /// oldest naming dropped (d1v3 check D4): a reply's bodies are fetched straight after it, by
    /// the same port call, so an old one is not waited on.
    fn name_out(&mut self, run: &str, id: &str, bs: &Bodies, bytes: Vec<u8>) -> BodyRef {
        self.name_out_prior(run, id, bs, Prior::Held(bytes))
    }

    /// [`State::name_out`] of a ledger's copy: a stored one is named by hash and read from the
    /// store when it is fetched, so naming it holds no bytes (D1mem fix B).
    fn name_out_prior(&mut self, run: &str, id: &str, bs: &Bodies, p: Prior) -> BodyRef {
        let r = p.by_ref();
        if !bs.sent(&r) {
            if let Some(t) = self.runs.get_mut(run) {
                let out = match p {
                    Prior::Held(b)      => Out::Bytes(Rc::new(b)),
                    Prior::Stored(r)    => Out::Stored(r.len),
                };
                out_insert(t, id, &r.hash, out);
            }
        }
        r
    }

    fn table(&mut self, run: &str) -> Outcome<&mut Table> {
        match self.runs.get_mut(run) {
            Some(t) => Ok(t),
            None    => Err(err!("store: the run '{}' is no longer bound.", run; Missing, Data)),
        }
    }
}

type Shared = Rc<RefCell<State>>;

/// The loop is biased: every sync call queued is answered before the next wait call or message
/// is taken in, so a burst of wait calls never stands ahead of a ping.  With the rule
/// `sync_first` off (a red control, D1x2b) the loop takes either queue as it comes, and a sync
/// call waits its turn behind the wait calls' work as one of them would.
async fn serve(sync: flume::Receiver<Msg>, rx: flume::Receiver<Msg>) {
    let st: Shared = Rc::new(RefCell::new(State::default()));
    loop {
        let first = !rule_off(&st, "sync_first");
        let (next, queued) = if first {
            tokio::select! {
                biased;
                m = sync.recv_async()   => (m, false),
                m = rx.recv_async()     => (m, false),
            }
        } else {
            tokio::select! {
                m = sync.recv_async()   => (m, true),
                m = rx.recv_async()     => (m, false),
            }
        };
        let msg = match next {
            Ok(m)   => m,
            Err(_)  => break,
        };
        match msg {
            Msg::Bind { tag, env, done } => {
                let taken = st.borrow().runs.iter()
                    .find(|(r, t)| **r == env.run || t.env.page == env.page)
                    .map(|(r, t)| (r.clone(), t.env.page.clone()));
                let got = match taken {
                    Some((r, page)) => Err(err!(
                        "The run '{}' on '{}' is refused: the run '{}' on '{}' is bound already.",
                        env.run, env.page, r, page; Invalid, Input)),
                    None => {
                        run::mark_live(&env.page);
                        let run = env.run.clone();
                        st.borrow_mut().runs.insert(run, Table::new(tag, env));
                        Ok(())
                    }
                };
                let _ = done.send(got);
            }
            Msg::Call { run, frame, reply } => {
                #[cfg(test)]
                QUEUED.fetch_sub(frame.len(), std::sync::atomic::Ordering::Relaxed);
                if queued {
                    let st = st.clone();
                    let _ = tokio::task::spawn_local(async move { receive(&st, run, frame, reply) });
                } else {
                    receive(&st, run, frame, reply)
                }
            }
            Msg::DropRun { run, done } => {
                drop_run(&st, &run).await;
                let _ = done.send(());
            }
            #[cfg(test)]
            Msg::Probe { id, reply } => {
                let claims = diamond::test_claims(&id).await;
                let s = st.borrow();
                let _ = reply.send(Probe {
                    thread: std::thread::current().id(),
                    runs:   s.runs.len(),
                    held:   s.runs.values().map(|t| t.held.len()).sum(),
                    slots:  crate::engine::host::store::slot_count(),
                    deletes: s.runs.values().map(|t| t.deletes.len()).sum(),
                    windows: diamond::test_windows(&id).iter().map(|w| w.to).collect(),
                    uploads: s.runs.values().map(|t| t.uploads.len()).sum(),
                    staged:  s.runs.values().flat_map(|t| t.uploads.values())
                        .map(|u| u.bytes.len() + u.whole.as_ref().map_or(0, |b| b.len())).sum(),
                    capacity: s.runs.values().flat_map(|t| t.uploads.values())
                        .map(|u| u.bytes.capacity() + u.whole.as_ref().map_or(0, |b| b.capacity())).sum(),
                    out:     s.runs.values().map(|t| t.out.len()).sum(),
                    claims,
                    ledger:  diamond::test_ledger_bytes(&id),
                    waits_at_sync: s.waits_at_sync,
                });
            }
            #[cfg(test)]
            Msg::Gate { entered, open } => {
                let _ = entered.send(());
                let _ = open.recv();
            }
            #[cfg(test)]
            Msg::Fuse { call, done } => {
                st.borrow_mut().fuse = Some(call);
                let _ = done.send(());
            }
            #[cfg(test)]
            Msg::Stall { call, secs, done } => {
                st.borrow_mut().stall = Some((call, secs));
                let _ = done.send(());
            }
            #[cfg(test)]
            Msg::HoldOff { done } => {
                st.borrow_mut().hold_off = true;
                let _ = done.send(());
            }
            #[cfg(test)]
            Msg::RuleOff { rule, done } => {
                st.borrow_mut().rules_off.push(rule);
                // The store's own rules in diamond.rs are switched on this, the store's, thread.
                crate::store::diamond::switch_off(Some(rule));
                let _ = done.send(());
            }
            #[cfg(test)]
            Msg::Restore { step, done } => {
                use crate::store::door::{DirLink, DoorEnv, Link};
                let parent = |id: &str| RunEnv {
                    run:        String::from("parent"),
                    diamonds:   [id.to_string()].into_iter().collect(),
                    folder_id:  None,
                    known:      BTreeSet::new(),
                    page:       String::from("parent"),
                };
                let got = match step {
                    TestRestore::Open { id, plan, dir } => {
                        let door = DoorEnv::new(&id, Link::Dir(DirLink::new(dir)));
                        parent(&id).scope(door.scope(diamond::versions_restore_open(&id, plan)))
                            .await.map(|o| (o.ticket, None, Vec::new()))
                    }
                    TestRestore::Close { id, ticket, dir } => {
                        let door = DoorEnv::new(&id, Link::Dir(DirLink::new(dir)));
                        parent(&id).scope(door.scope(diamond::versions_restore_close(&id, ticket)))
                            .await.map(|c| (c.at, c.recorded, c.restored))
                    }
                };
                let _ = done.send(got);
            }
            Msg::Stop => break,
        }
    }
    // Every table goes here, on the thread whose slots and windows its values name.
    let runs = std::mem::take(&mut st.borrow_mut().runs);
    for (_, t) in runs {
        for task in t.tasks.iter() {
            task.abort();
        }
        drop(t);
    }
}

fn answer(reply: &flume::Sender<Vec<u8>>, r: &StoreReply) {
    // An answer that cannot be framed reaches the caller as a frame it refuses to read.
    let bytes = encode_reply(r).unwrap_or_default();
    let _ = reply.send(bytes);
}

fn unbound(call: &StoreCall, id: String) -> StoreReply {
    StoreReply::Fault(Fault::Unbound(Unbound { call: call.name().to_string(), id }))
}

fn receive(st: &Shared, run: String, frame: Vec<u8>, reply: flume::Sender<Vec<u8>>) {
    let call = match decode_call(&frame) {
        Ok(c)   => c,
        Err(_)  => {
            let _ = reply.send(Vec::new());
            return;
        }
    };
    let poisoned = st.borrow().poisoned.clone();
    if let Some(why) = poisoned {
        return answer(&reply, &StoreReply::Fault(Fault::Down(StoreDown { why })));
    }
    let (tag, env) = match st.borrow().runs.get(&run) {
        Some(t) => (t.tag, t.env.clone()),
        None    => return answer(&reply, &unbound(&call, fmt!("run {}", run))),
    };
    if let Some(refused) = refusal(st, &run, tag, &env, &call) {
        return answer(&reply, &refused);
    }
    let id = match named(&call) {
        Named::Id(id)       => Some(id.to_string()),
        Named::Ticket(t)    => env.clone().sync_scope(|| diamond::restore_store(t)),
        Named::Nothing      => None,
    };
    let bs = Bodies::staged(&st.borrow(), &run, id, call.uploads());
    if call.sync() {
        let name = call.name();
        let caught = catch_unwind(AssertUnwindSafe(|| env.clone().sync_scope(|| in_sync(|| {
            blow(st, call.name());
            serve_sync(&mut st.borrow_mut(), &run, &bs, call)
        }))));
        let r = match said(caught) {
            Ok(r)   => r,
            Err(p)  => return answer(&reply, &poison(st, name, &p)),
        };
        #[cfg(test)]
        {
            let mut s = st.borrow_mut();
            s.waits_at_sync = s.waits;
        }
        answer(&reply, &r);
        let back = refused_uploads(&bs, &r);
        // The release runs caught as the call did (d1v2 check D-C2): a panic in it poisons.
        let freed = match said(catch_unwind(AssertUnwindSafe(|| bs.free(st, &run)))) {
            Ok(f)   => f,
            Err(p)  => { poison(st, name, &p); return; }
        };
        if !freed.is_empty() || back.is_some() {
            let task = tokio::task::spawn_local(env.scope({
                let (st, run) = (st.clone(), run.clone());
                async move {
                    let work = async {
                        release(&st, &run, freed).await;
                        take_back(back).await;
                    };
                    if let Err(p) = Caught(Box::pin(work)).await {
                        poison(&st, name, &p);
                    }
                }
            }));
            if let Some(t) = st.borrow_mut().runs.get_mut(&run) {
                t.tasks.retain(|t| !t.is_finished());
                t.tasks.push(task);
            }
        }
    } else {
        let task = tokio::task::spawn_local(env.scope({
            let st = st.clone();
            let run = run.clone();
            let mut bs = bs;
            async move {
                let name = call.name();
                // Registered before the work starts, so a poison at any later point is seen
                // (d1v2 check D-C1): the call in flight is then dropped, and answered down.
                let down = st.borrow().down.clone();
                let mut gone = std::pin::pin!(down.notified());
                // Set by the Busy arm: a call answered for its caller commits nothing after
                // (HL5b's commit guard; review 2).
                let answered = Answered::default();
                let mut work = Caught(Box::pin({
                    let st = st.clone();
                    let run = run.clone();
                    let answered = answered.clone();
                    async move {
                        bs.from_store().await;
                        if is_down(&st).is_some() {
                            return (None, bs);
                        }
                        blow(&st, call.name());
                        stall(&st, call.name()).await;
                        if is_down(&st).is_some() {
                            return (None, bs);
                        }
                        let r = serve_wait_late(&st, &run, &bs, call, &answered).await;
                        (Some(r), bs)
                    }
                }));
                let timed = tokio::select! {
                    biased;
                    _ = &mut gone => None,
                    t = tokio::time::timeout(Duration::from_secs(BUSY_SECS), &mut work) => Some(t),
                };
                // The store alone answers Busy (QA1 F1), and only for a call that has not begun
                // to commit; one that has is waited for, and answered with what it did.  A
                // test's red: Busy answered whatever the call has begun (`busy_decides`).
                let busy = match timed {
                    Some(Err(_))    => answered.busy() || rule_off(&st, "busy_decides"),
                    _               => false,
                };
                let timed = match timed {
                    Some(Err(_)) if !busy   => tokio::select! {
                        biased;
                        _ = &mut gone => None,
                        w = &mut work => Some(Ok(w)),
                    },
                    other                   => other,
                };
                let done = match timed {
                    None            => {
                        drop(work);
                        return answer(&reply, &down_reply(&st));
                    }
                    Some(Ok(done))  => done,
                    Some(Err(_))    => {
                        answer(&reply, &StoreReply::Fault(Fault::Busy(StoreBusy {
                            call: name.to_string(), secs: BUSY_SECS })));
                        let late = tokio::select! {
                            biased;
                            _ = &mut gone => None,
                            w = &mut work => Some(w),
                        };
                        match late {
                            None                => drop(work),
                            Some(Ok((_, bs)))   => released(&st, &run, bs, name).await,
                            Some(Err(p))        => { poison(&st, name, &p); }
                        }
                        return;
                    }
                };
                match done {
                    Ok((r, bs)) => {
                        // Checked again before the answer: a poison while it was served stands.
                        let back = match &r {
                            Some(r) => refused_uploads(&bs, r),
                            None    => None,
                        };
                        match (r, is_down(&st)) {
                            // A test's backstop (QA1-C): done, and answered not known, as the
                            // relay answers a call the store commits after its backstop.
                            (Some(_), None) if rule_off(&st, "answer_known")
                                && name == "store_write_then" =>
                                answer(&reply, &StoreReply::Fault(Fault::Unknown(StoreUnknown {
                                    call: name.to_string(),
                                    why: "the test's backstop".to_string() }))),
                            (Some(r), None) => answer(&reply, &r),
                            _               => answer(&reply, &down_reply(&st)),
                        }
                        released(&st, &run, bs, name).await;
                        take_back(back).await;
                    }
                    Err(p)      => answer(&reply, &poison(&st, name, &p)),
                }
            }
        }));
        #[cfg(test)]
        {
            st.borrow_mut().waits += 1;
        }
        if let Some(t) = st.borrow_mut().runs.get_mut(&run) {
            t.tasks.retain(|t| !t.is_finished());
            t.tasks.push(task);
        }
    }
}

/// The words of a panic caught, or what was returned.
fn said<T>(r: std::thread::Result<T>) -> Result<T, String> {
    match r {
        Ok(v)   => Ok(v),
        Err(p)  => Err(match p.downcast_ref::<&str>() {
            Some(s) => s.to_string(),
            None    => match p.downcast_ref::<String>() {
                Some(s) => s.clone(),
                None    => String::from("a panic"),
            },
        }),
    }
}

/// Poisons the store for the panic caught in `store.{name}`, and gives the call's answer.  The
/// first panic's words stand.  Every wait call in flight is told, and drops its work to answer
/// down (d1v2 check D-C1, §16.1 Faults: "every later or queued call").
fn poison(st: &Shared, name: &str, said: &str) -> StoreReply {
    let why = fmt!("store.{} panicked: {}", name, said);
    let (why, down) = {
        let mut s = st.borrow_mut();
        (s.poisoned.get_or_insert(why).clone(), s.down.clone())
    };
    down.notify_waiters();
    StoreReply::Fault(Fault::Down(StoreDown { why }))
}

/// Why the store is poisoned, if it is.
fn is_down(st: &Shared) -> Option<String> { st.borrow().poisoned.clone() }

/// The answer of a call the poison overtook.
fn down_reply(st: &Shared) -> StoreReply {
    let why = is_down(st).unwrap_or_else(|| String::from("the store is down"));
    StoreReply::Fault(Fault::Down(StoreDown { why }))
}

/// The uploads a refused call named, by `id` and hash: what the run's turn put down for it at
/// their `Done` is taken back once their claims are given back (D1mem fix B), so a refusal
/// leaves no body behind.
fn refused_uploads(bs: &Bodies, r: &StoreReply) -> Option<(String, Vec<String>)> {
    match &bs.id {
        Some(id) if !bs.refs.is_empty() && crate::store::call::is_refusal(r) =>
            Some((id.clone(), bs.refs.iter().map(|r| r.hash.clone()).collect())),
        _ => None,
    }
}

async fn take_back(back: Option<(String, Vec<String>)>) {
    if let Some((id, hashes)) = back {
        diamond::take_back_refused(&id, &hashes).await;
    }
}

/// Gives back the bodies a wait call no longer needs, caught as the call was (d1v2 check D-C2):
/// a panic in the release poisons the store rather than vanish into a task nobody reads.
async fn released(st: &Shared, run: &str, bs: Bodies, name: &str) {
    let work = Caught(Box::pin(async { release(st, run, bs.free(st, run)).await }));
    if let Err(p) = work.await {
        poison(st, name, &p);
    }
}

/// A future whose panic, at any poll, is its output, in words.
struct Caught<F>(Pin<Box<F>>);

impl<F: Future> Future for Caught<F> {
    type Output = Result<F::Output, String>;
    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let f = &mut self.0;
        match said(catch_unwind(AssertUnwindSafe(|| f.as_mut().poll(cx)))) {
            Ok(Poll::Ready(v))  => Poll::Ready(Ok(v)),
            Ok(Poll::Pending)   => Poll::Pending,
            Err(p)              => Poll::Ready(Err(p)),
        }
    }
}

/// Panics where the test's fuse names `name`, once.
#[cfg(test)]
fn blow(st: &Shared, name: &str) {
    let lit = st.borrow().fuse.as_deref() == Some(name);
    if lit {
        st.borrow_mut().fuse = None;
        panic!("the test's fuse for store.{}", name);
    }
}
#[cfg(not(test))]
fn blow(_: &Shared, _: &str) {}

/// Sleeps where the test's stall names `name`, once.
#[cfg(test)]
async fn stall(st: &Shared, name: &str) {
    let secs = match st.borrow().stall.as_ref() {
        Some((call, secs)) if call == name => Some(*secs),
        _ => None,
    };
    if let Some(secs) = secs {
        st.borrow_mut().stall = None;
        tokio::time::sleep(std::time::Duration::from_secs(secs)).await;
    }
}
#[cfg(not(test))]
async fn stall(_: &Shared, _: &str) {}

/// The test's stall named `name`, taken once: its seconds, or 0.
#[cfg(test)]
fn stall_secs(st: &Shared, name: &str) -> u64 {
    let secs = match st.borrow().stall.as_ref() {
        Some((call, secs)) if call == name => *secs,
        _ => 0,
    };
    if secs > 0 {
        st.borrow_mut().stall = None;
    }
    secs
}
#[cfg(not(test))]
fn stall_secs(_: &Shared, _: &str) -> u64 { 0 }

#[cfg(test)]
use crate::store::native::in_sync;
#[cfg(not(test))]
fn in_sync<R>(f: impl FnOnce() -> R) -> R { f() }

/// Ends `run` (d1v1 §3): its tasks, then its table, which drops every value it held (a hold frees
/// its slot with its notes unsettled, a window is closed as lost), then its ledger and its
/// liveness.  Its turn counts go with it (D1v2c): each run's tally is its own, so no other run's
/// limit stands on them.
async fn drop_run(st: &Shared, run: &str) {
    let tasks = match st.borrow_mut().runs.get_mut(run) {
        Some(t) => std::mem::take(&mut t.tasks),
        None    => return,
    };
    for task in tasks.iter() {
        task.abort();
    }
    for task in tasks {
        let _ = task.await;
    }
    #[cfg(test)]
    if st.borrow().hold_off {
        return;
    }
    let table = st.borrow_mut().runs.remove(run);
    if let Some(table) = table {
        // ITS TURN COUNTS GO WITH ITS LEDGERS (D1v2c): `forget_page` ends its own tally, and
        // touches no other run's.
        let Table { env, held, uploads, .. } = table;
        drop(held);
        // ITS UNNAMED UPLOADS GO WITH IT (§16.3a 3): their bytes, and their claims.
        release(st, run, uploads.into_iter().filter_map(|((id, _), u)| u.claim.map(|c| (id, c))).collect())
            .await;
        let page = env.page.clone();
        diamond::forget_page(&page);
        run::mark_dead(&page);
    }
}


// ┌───────────────────────────────────────────────────────────────┐
// │ The binding                                                    │
// └───────────────────────────────────────────────────────────────┘

/// The calls a door errand may make (spec §16.4, as the lead amended it on 17 Oct): the six act
/// calls, the five store READS those acts make (`restore_store`, `versionable`, `theirs`,
/// `folder_of`, `versions_body`, each of which writes nothing on any path), and the body calls
/// their bytes cross by.  No other call, and no write.
fn door_admits(call: &StoreCall) -> bool {
    use StoreCall as C;
    matches!(call,
        C::RestoreRoute { .. } | C::RestoreLook { .. } | C::RestoreAsked { .. }
        | C::RestoreKeep { .. } | C::RestoreLetGo { .. } | C::RestoreLanded { .. }
        | C::RestoreStore { .. } | C::Versionable { .. } | C::Theirs { .. } | C::FolderOf { .. }
        | C::VersionsBody { .. }
        | C::BodyPut { .. } | C::BodyGet { .. } | C::Ping {})
}

/// The Diamond a call names: by its id or owner, or by the restore its ticket is of.
enum Named<'a> {
    Id(&'a str),
    Ticket(u64),
    Nothing,
}

fn named(call: &StoreCall) -> Named<'_> {
    use StoreCall as C;
    match call {
        C::RestoreStore { ticket } | C::RestoreRoute { ticket, .. }
        | C::RestoreLook { ticket, .. } | C::RestoreAsked { ticket, .. }
        | C::RestoreKeep { ticket, .. } | C::RestoreLetGo { ticket, .. }
        | C::RestoreLanded { ticket, .. } => Named::Ticket(*ticket),
        C::AddLink { owner, .. } | C::LinksPage { owner, .. }
        | C::RemoveLinkByModel { owner, .. } => Named::Id(owner),
        C::AllLinks {} | C::LinksJson { .. } | C::FolderOf { .. }
        | C::CloseWindow { .. } | C::RouteHere { .. } | C::LiveBounds { .. } | C::Reach { .. }
        | C::Trail { .. } | C::LetGo { .. } | C::Ping {}
        | C::JournalPut { .. } | C::JournalRead { .. } | C::JournalDrop { .. }
        | C::JournalList { .. } | C::JournalSweep { .. } => Named::Nothing,
        C::ReadCrystalData { id } | C::ReadCrystalDataStrict { id } | C::ReadCrystalPage { id }
        | C::ReadCrystalPageStrict { id } | C::CrystalHalf { id, .. }
        | C::CrystalUndoTarget { id, .. } | C::HotRefusals { id } | C::SetHotRefusals { id, .. }
        | C::CrystalHotLastGood { id, .. }
        | C::LastPassed { id } | C::MarkPassed { id, .. } | C::StandingSettle { id, .. } | C::StateRead { id, .. }
        | C::StoreFileRead { id, .. } | C::StoreFileList { id, .. } | C::StoreWriteThen { id, .. }
        | C::StoreFileAct { id, .. }
        | C::AbsorbFoldNotes { id, .. }
        | C::DiamondExists { id } | C::Capture { id, .. } | C::CapturedRoom { id, .. }
        | C::ActivityReadAll { id } | C::ActivityAppend { id, .. } | C::NoProgressRounds { id }
        | C::KeepRoom { id } | C::Release { id, .. } | C::HeldUnder { id, .. }
        | C::ThisTurnFound { id, .. } | C::TurnsFound { id, .. } | C::MeasuredAgainst { id, .. }
        | C::SealsSpent { id, .. } | C::SealRun { id, .. } | C::Pend { id, .. }
        | C::Unpend { id, .. } | C::RanOpaque { id } | C::NoteOutput { id, .. }
        | C::OutputIsOwn { id, .. } | C::MadeFiles { id } | C::RanMade { id, .. }
        | C::Theirs { id, .. }
        | C::Versionable { id, .. } | C::AuthoredByUser { id, .. } | C::ChangeRefused { id, .. }
        | C::RefuseChange { id, .. } | C::OpenDeleteRoom { id, .. } | C::OpenDeleteAnswer { id, .. }
        | C::OpenDeleteRelease { id, .. } | C::OpenWindow { id, .. }
        | C::VersionsRecord { id, .. } | C::RecordedNames { id, .. } | C::VersionsBody { id, .. }
        | C::VersionsUndoTarget { id, .. } | C::VersionsManifest { id, .. } | C::HoldVersions { id }
        | C::IsSteering { id }
        | C::Steering { id } | C::DrainDirty { id } | C::VersionsRecordDirty { id, .. }
        | C::TurnWants { id } | C::TurnWantsPage { id, .. } | C::TurnStanding { id, .. }
        | C::TurnStands { id, .. } | C::TurnWiped { id, .. } | C::DrainTurn { id, .. }
        | C::TurnUncovered { id, .. } | C::TurnAdd { id, .. } | C::DrainWindows { id, .. }
        | C::VersionsRecordHeld { id, .. } | C::RecordSteer { id, .. }
        | C::EndTurnCounts { id } | C::BodyPut { id, .. } | C::BodyGet { id, .. } => Named::Id(id),
    }
}

/// The handles a call names, each of which must be in the caller's own table.
fn handles(call: &StoreCall) -> Vec<Handle> {
    use StoreCall as C;
    match call {
        C::DrainTurn { hold, .. } | C::TurnUncovered { hold, .. } | C::TurnAdd { hold, .. }
        | C::DrainWindows { hold, .. } | C::VersionsRecordHeld { hold, .. }
        | C::RecordSteer { hold, .. } => vec![*hold],
        C::CloseWindow { window } => vec![*window],
        C::LetGo { handle } => vec![*handle],
        C::VersionsRecordDirty { dirty, .. } => dirty.clone(),
        _ => Vec::new(),
    }
}

/// The run whose journal a call names.
fn journal_of(call: &StoreCall) -> Option<&str> {
    use StoreCall as C;
    match call {
        C::JournalPut { run, .. } | C::JournalRead { run, .. } | C::JournalDrop { run } =>
            Some(run),
        _ => None,
    }
}

/// The binding's refusal of `call`, if it is refused: a door tag's call it does not admit, a
/// Diamond the run was not granted, or a handle that is not its own.
fn refusal(st: &Shared, run: &str, tag: Tag, env: &RunEnv, call: &StoreCall) -> Option<StoreReply> {
    if tag == Tag::Door && !door_admits(call) {
        return Some(unbound(call, fmt!("door {}", run)));
    }
    if tag != Tag::Parent {
        let id = match named(call) {
            Named::Id(id)       => Some(id.to_string()),
            Named::Ticket(t)    => match env.clone().sync_scope(|| diamond::restore_store(t)) {
                Some(id)    => Some(id),
                None        => return Some(unbound(call, fmt!("ticket {}", t))),
            },
            Named::Nothing      => None,
        };
        if let Some(id) = id {
            if !env.diamonds.contains(&id) && !rule_off(st, "scope") {
                return Some(unbound(call, id));
            }
        }
    }
    // Which runs have a journal, and the sweep of them, are the parent's alone (R1i).
    if matches!(call, StoreCall::JournalList { .. } | StoreCall::JournalSweep { .. })
        && tag != Tag::Parent && !rule_off(st, "journal_parent")
    {
        return Some(unbound(call, String::from("journals")));
    }
    // A run names its own journal alone, as its `RunEnv` says (U4e); the parent, any run's.
    if let Some(of) = journal_of(call) {
        if tag != Tag::Parent && of != env.run && !rule_off(st, "journal_scope") {
            return Some(unbound(call, fmt!("journal {}", of)));
        }
    }
    let s = st.borrow();
    let own = s.runs.get(run);
    for h in handles(call) {
        if !own.is_some_and(|t| t.held.contains_key(&h.0)) {
            return Some(unbound(call, fmt!("handle {}", h.0)));
        }
    }
    None
}


// ┌───────────────────────────────────────────────────────────────┐
// │ Bodies (D1v3, spec §16.3a 3, d1_plan §9.11 O2/O3)              │
// └───────────────────────────────────────────────────────────────┘

/// The unnamed uploads a run may hold in one open act; a `capture` names at most three.
pub const STAGE_MAX: usize = 4;

/// The bytes one run may stage, and every run together, counted by the lengths the uploads
/// declare.  Memory bounds, not History policy (`BODY_KEEP_MAX` stays the owner's): the client
/// picks its act ids, so `STAGE_MAX` alone bounds nothing over a run.  Kept at D1x2b's measure
/// (`server_measure.rs`, Ozone, 18 Oct 2026), derived below.
// The envelope's largest act stages 19.6 MiB (the 20 MB edit copy and its 512 KiB after), so a
// run's 64 MiB holds three such acts: the envelope with room, and no more than a turn needs.
pub const STAGE_BYTES_MAX: usize = 64 << 20;
// Six runs at the envelope staged 117.4 MiB at once; D1MEM-b's measure (96e3e2ba, 18 Oct 2026)
// put the store's peak RSS at 469.5 MiB (base 116.5, high-water rise 353.0; D1x2b's was a 616 MiB
// rise).  Staging the whole 256 MiB adds at most 2 × (256 − 117.4) MiB (an upload, and its copy
// as it is named), 747.2 MiB in all: inside the store's 832 MiB scope (spec §16.1 "Memory").
pub const STORE_STAGE_MAX: usize = 256 << 20;

/// The envelope's largest act (§9.10): the 20 MB edit copy and a 512 KiB `after`.
const ENVELOPE_ACT: usize = 20 * 1000 * 1000 + crate::diamond_versions::VERSION_FILE_MAX;
/// The runs measured at once, the pool's cap, and the store's peak RSS they made (D1MEM-b's
/// `measure_six_runs_at_the_envelope`: base 116.5 MiB + high-water rise 353.0 MiB, rounded up).
const MEASURED_RUNS: usize = 6;
const MEASURED_PEAK: usize = 470 << 20;
/// The store's scope (spec §16.1 "Memory", `MemoryMax=832M`).  THE RULE: the larger of one and a
/// half times the measured peak and 1.1 times the staged worst case, rounded up to 64 MiB, so a
/// store killed on breach has a tenth's room over the worst it can stage: max(1.5 × 469.5,
/// 1.1 × 747.2) = max(704.3, 821.9) MiB → 832 MiB.
const STORE_MEMORY: usize = 832 << 20;
/// The store staged to its bound: the measured peak, and an upload and its copy as it is named
/// for every byte past what the measured runs staged.
const STAGED_WORST: usize = MEASURED_PEAK + 2 * (STORE_STAGE_MAX - MEASURED_RUNS * ENVELOPE_ACT);

const _: () = assert!(STAGE_BYTES_MAX >= 3 * ENVELOPE_ACT, "a run stages three envelope acts");
const _: () = assert!(STORE_STAGE_MAX <= MEASURED_RUNS * STAGE_BYTES_MAX,
    "the store's bound binds before every run is at its own");
const _: () = assert!(STORE_STAGE_MAX >= MEASURED_RUNS * ENVELOPE_ACT,
    "six runs stage the envelope's largest act at once");
const _: () = assert!(STAGED_WORST <= STORE_MEMORY,
    "the store staged to its bound stays inside its scope");
const _: () = assert!(STAGED_WORST + STAGED_WORST / 10 <= STORE_MEMORY,
    "the store's scope holds a tenth's room over its staged worst case");
const _: () = assert!(MEASURED_PEAK + MEASURED_PEAK / 2 <= STORE_MEMORY,
    "the store's scope holds one and a half times its measured peak");

/// The bodies named out to one run and not yet fetched to their end.
pub const OUT_MAX: usize = 16;

/// One body a run is uploading, or has uploaded and not yet named.
struct Upload {
    len:   u64,
    bytes: Vec<u8>,                     // as far as it has come
    whole: Option<Rc<Vec<u8>>>,         // the bytes, checked against the hash at `Done`, or
                                        // read from the body store and checked at `Held`
    owed:  u32,                         // namings owed: one per put answered `Done` or `Held`
    act:   u64,                         // the open act that began it, whose room it takes
    shared: bool,                       // another act was answered `Held` from it
    claim: Option<diamond::BodyClaim>,  // given back when it is named, refused or dropped
}

impl Upload {
    fn is_whole(&self) -> bool { self.whole.is_some() }
}

/// The unnamed uploads the open act `act` began (§9.11 O3: the act is the wire's).
fn unnamed(t: &Table, act: u64) -> usize {
    t.uploads.values().filter(|u| u.act == act).count()
}

/// Takes out the uploads the act `act` began and did not finish, but `keep`'s.  An act uploads
/// one body at a time and then names them, so its next upload or its naming call ends a torn one
/// (d1v3 check D3).  Their claims, to be given back.
fn drop_torn(t: &mut Table, act: u64, keep: Option<&(String, String)>)
    -> Vec<(String, diamond::BodyClaim)>
{
    let torn: Vec<(String, String)> = t.uploads.iter()
        .filter(|(k, u)| u.act == act && !u.is_whole() && Some(*k) != keep)
        .map(|(k, _)| k.clone())
        .collect();
    torn.into_iter()
        .filter_map(|k| t.uploads.remove(&k).and_then(|u| u.claim).map(|c| (k.0, c)))
        .collect()
}

/// Room for `run` to stage `more` bytes: refused past its own ceiling or the store's.
fn stage_room(s: &State, run: &str, more: u64) -> Option<Error<ErrTag>> {
    // A journal round under way takes its room as an upload does (U4e).
    let of = |t: &Table| t.uploads.values().fold(0u64, |n, u| n.saturating_add(u.len))
        .saturating_add(t.journal.as_ref().map_or(0, |r| r.len));
    let mine = s.runs.get(run).map_or(0, of);
    let all = s.runs.values().fold(0u64, |n, t| n.saturating_add(of(t)));
    if mine.saturating_add(more) > STAGE_BYTES_MAX as u64 {
        Some(stage_busy("this run", mine, more, STAGE_BYTES_MAX))
    } else if all.saturating_add(more) > STORE_STAGE_MAX as u64 {
        Some(stage_busy("the store", all, more, STORE_STAGE_MAX))
    } else {
        None
    }
}

/// Room for a new upload of `len` bytes in the act `act` of `run`.
fn room(s: &State, run: &str, act: u64, len: u64) -> Option<Error<ErrTag>> {
    match s.runs.get(run) {
        None => Some(err!("store: the run '{}' is no longer bound.", run; Missing, Data)),
        Some(t) if unnamed(t, act) >= STAGE_MAX => Some(stage_full(act)),
        Some(_) => stage_room(s, run, len),
    }
}

/// The bodies one call names, found before it is served: the run's own uploads for the call's
/// Diamond first, then (a wait call alone, since it may await) that Diamond's body store.
struct Bodies {
    id:    Option<String>,
    refs:  Vec<BodyRef>,
    found: BTreeMap<String, Rc<Vec<u8>>>,   // by hash
}

impl Bodies {

    fn staged(st: &State, run: &str, id: Option<String>, refs: Vec<BodyRef>) -> Self {
        let mut found = BTreeMap::new();
        if let (Some(t), Some(id)) = (st.runs.get(run), id.as_ref()) {
            for r in refs.iter() {
                let up = t.uploads.get(&(id.clone(), r.hash.clone()));
                if let Some(b) = up.and_then(|u| u.whole.clone()) {
                    found.insert(r.hash.clone(), b);
                }
            }
        }
        Self { id, refs, found }
    }

    /// What the run did not upload, from the body store of the call's own Diamond.
    async fn from_store(&mut self) {
        let id = match &self.id {
            Some(id)    => id.clone(),
            None        => return,
        };
        for r in self.refs.iter() {
            if r.len == 0 || self.found.contains_key(&r.hash) {
                continue;
            }
            if let Ok(Some(b)) = diamond::versions_body(&id, &r.hash).await {
                if r.names(&b) {
                    self.found.insert(r.hash.clone(), Rc::new(b));
                }
            }
        }
    }

    fn get(&self, r: &BodyRef) -> Outcome<Vec<u8>> {
        if r.len == 0 {
            return Ok(Vec::new());
        }
        match self.found.get(&r.hash) {
            Some(b) => Ok(b.as_ref().clone()),
            None    => Err(err!(
                "store: no upload of this run and no stored body names {} ({} bytes).",
                r.hash, r.len; Missing, Data)),
        }
    }

    /// Is the body `r` in the store (D1mem fix B): a whole upload of the run, put down at its
    /// `Done` or found there at its `Held`, or one of no bytes?
    fn has(&self, r: &BodyRef) -> bool {
        r.len == 0 || self.found.get(&r.hash).is_some_and(|b| b.len() as u64 == r.len)
    }

    /// Does the call name these bytes itself?  Its sender holds them, so they are not named out.
    fn sent(&self, r: &BodyRef) -> bool { self.refs.iter().any(|x| x == r) }

    /// The call has ended: of the uploads it named, and only those (O3), each owes one naming
    /// fewer, and one owing none is freed, for its claim to be given back; so is the torn upload
    /// of the act that began them.  An upload two acts
    /// put is so kept for the second act's call (d1v3 check D2): each naming call is preceded by
    /// its own offset-0 `body_put` of each body it names.
    fn free(&self, st: &Shared, run: &str) -> Vec<(String, diamond::BodyClaim)> {
        let mut out = Vec::new();
        let id = match &self.id {
            Some(id)    => id,
            None        => return out,
        };
        if let Some(t) = st.borrow_mut().runs.get_mut(run) {
            let mut seen = BTreeSet::new();
            let mut acts = BTreeSet::new();     // the acts whose naming call this is
            for r in self.refs.iter() {
                let key = (id.clone(), r.hash.clone());
                if !seen.insert(key.clone()) {
                    continue;       // named twice by one call: one naming
                }
                if let Some(u) = t.uploads.get(&key) {
                    if !u.shared {
                        acts.insert(u.act);
                    }
                }
                let gone = match t.uploads.get_mut(&key) {
                    Some(u) if u.owed > 1   => { u.owed -= 1; false }
                    Some(_)                 => true,
                    None                    => false,
                };
                if gone {
                    if let Some(Upload { claim: Some(c), .. }) = t.uploads.remove(&key) {
                        out.push((id.clone(), c));
                    }
                }
            }
            // An act's naming call ends its torn upload (d1v3 check D3).  A shared upload does
            // not say which act's call this is, so it ends none.
            for act in acts {
                out.extend(drop_torn(t, act, None));
            }
        }
        out
    }
}

/// The version hold of `id` the run `run` owns, where it holds one.
fn run_hold(st: &Shared, run: &str, id: &str) -> Option<Rc<SlotHold<VersionHold>>> {
    st.borrow().runs.get(run)?.held.values().find_map(|h| match h {
        Held::Hold(h) if h.id() == id   => Some(h.clone()),
        _                               => None,
    })
}

/// The hold an open restore of `id` has of its version store ([`diamond::restore_hold_of`]).
/// D1x2a's red: `restore_hold` off, none is passed on.
fn restore_hold(st: &Shared, id: &str) -> Option<Rc<VersionHold>> {
    if rule_off(st, "restore_hold") {
        return None;
    }
    diamond::restore_hold_of(id)
}

/// Give back the claim `c` on a body of `id`: through the run's own version hold of `id` where it
/// holds one (D1r1d: the hold is not re-entrant, so asking again would wait out
/// [`diamond::VERSION_WAIT_MS`] on itself), else under a hold of its own.
/// An open restore's hold of `id` is passed on in the same way ([`diamond::restore_hold_of`]).
async fn give_back(st: &Shared, run: &str, id: &str, c: diamond::BodyClaim) {
    if let Some(h) = run_hold(st, run, id) {
        return c.done_under(id, h.held()).await;
    }
    match restore_hold(st, id) {
        Some(h) => c.done_under(id, &h).await,
        None    => c.done(id).await,
    }
}

async fn release(st: &Shared, run: &str, claims: Vec<(String, diamond::BodyClaim)>) {
    for (id, c) in claims {
        give_back(st, run, &id, c).await;
    }
}

fn body(bs: &Bodies, r: &BodyRef) -> Outcome<Vec<u8>> {
    crate::store::call::fetch(r, &mut |r| bs.get(r))
}

fn opt_body(bs: &Bodies, r: &Option<BodyRef>) -> Outcome<Option<Vec<u8>>> {
    match r {
        Some(r) => Ok(Some(res!(body(bs, r)))),
        None    => Ok(None),
    }
}

fn stage_full(act: u64) -> Error<ErrTag> {
    err!("store.body_put: {} unnamed uploads of the act {} are staged already, the most one act \
        holds.", STAGE_MAX, act; Invalid, Input)
}

fn stage_busy(whose: &str, staged: u64, more: u64, max: usize) -> Error<ErrTag> {
    err!("store.body_put is refused, the store is busy: {} has {} bytes staged, and {} more would \
        pass its ceiling of {}.  Nothing was kept; put it again once an upload is named.",
        whose, staged, more, max; Invalid, Input)
}

/// One chunk of an upload, staged in the run's table under a claim (§16.3a 3).  `Held` at
/// offset 0 where the run staged the body already or `id`'s body store holds it (O2: that
/// Diamond's alone); `Done` once the bytes are whole and are the bytes `hash` names; refused,
/// and nothing kept, where they are not.
async fn body_put(st: &Shared, run: &str, id: String, act: u64, hash: HexHash, len: u64,
    offset: u64, chunk: Vec<u8>) -> Outcome<Put>
{
    let key = (id.clone(), hash.as_str().to_string());
    if offset == 0 {
        enum Begin { Answer(Outcome<Put>), Again, Fresh }
        let (begin, torn) = {
            let mut s = st.borrow_mut();
            let t = res!(s.table(run));
            // The act's new upload ends its torn one (d1v3 check D3).
            let torn = drop_torn(t, act, Some(&key));
            let begin = match t.uploads.get(&key).map(|u| (u.is_whole(), u.len)) {
                Some((true, l)) if l == len => {
                    if let Some(u) = t.uploads.get_mut(&key) {
                        u.owed = u.owed.saturating_add(1);
                        u.shared |= u.act != act;
                    }
                    Begin::Answer(Ok(Put::Held))
                }
                Some((true, l)) => Begin::Answer(Err(err!(
                    "store.body_put: the body {} is {} bytes, not {}.", key.1, l, len;
                    Invalid, Input))),
                Some((false, l)) => match stage_room(&s, run, len.saturating_sub(l)) {
                    Some(e) => Begin::Answer(Err(e)),
                    None    => {            // begun again
                        if let Some(u) = s.runs.get_mut(run).and_then(|t| t.uploads.get_mut(&key)) {
                            u.len = len;
                            u.bytes = Vec::with_capacity(len as usize);
                        }
                        Begin::Again
                    }
                },
                None => match room(&s, run, act, len) {
                    Some(e) => Begin::Answer(Err(e)),
                    None    => Begin::Fresh,
                },
            };
            (begin, torn)
        };
        release(st, run, torn).await;
        match begin {
            Begin::Answer(r)    => return r,
            Begin::Again        => (),
            Begin::Fresh        => {
                // Claimed before it is looked for, as `Writing::put` does: a body found is held.
                // Under the run's own hold of `id` (an upload in its turn end), the claim goes
                // through that hold: asking for it again would wait on itself (D1r1d).  So does
                // the hold of an open restore of `id`, which a door child's upload with its act
                // would otherwise wait out and fail on (D1x2a: its landed change was lost).
                let claim = match (run_hold(st, run, &id), restore_hold(st, &id)) {
                    (Some(h), _)    => res!(diamond::BodyClaim::under_hold(&id, &key.1, h.held()).await),
                    (None, Some(h)) => res!(diamond::BodyClaim::under_hold(&id, &key.1, &h).await),
                    (None, None)    => res!(diamond::BodyClaim::take(&id, &key.1).await),
                };
                // A body the store holds is read and staged as if uploaded, under that claim, so
                // every call naming it, a sync one too, resolves it from the run's own uploads
                // (d1v3 check D1).  Unreadable, or not the bytes `hash` and `len` name: the
                // client uploads it, which also heals a bad stored body.
                let whole = match diamond::versions_body(&id, &key.1).await {
                    Ok(Some(b)) if (BodyRef { hash: key.1.clone(), len }).names(&b) =>
                        Some(Rc::new(b)),
                    _ => None,
                };
                let held = whole.is_some();
                // D1x2a's red: answered `Held` with nothing staged, as before D1v3b.
                let whole = if rule_off(st, "held_stage") { None } else { whole };
                let mut claim = Some(claim);
                let refused = {
                    let mut s = st.borrow_mut();
                    let under_way = s.runs.get(run).is_some_and(|t| t.uploads.contains_key(&key));
                    if under_way {
                        Some(err!("store.body_put: an upload of {} is under way already.", key.1;
                            Invalid, Input))
                    } else if let Some(e) = room(&s, run, act, len) {
                        Some(e)
                    } else {
                        if let Some(t) = s.runs.get_mut(run) {
                            // `room` bounded `len` by the stage caps: one allocation, never doubled.
                            t.uploads.insert(key.clone(), Upload { len,
                                bytes: if held { Vec::new() } else { Vec::with_capacity(len as usize) },
                                whole,
                                owed: if held { 1 } else { 0 }, act, shared: false,
                                claim: claim.take() });
                        }
                        None
                    }
                };
                if let Some(e) = refused {
                    if let Some(c) = claim {
                        give_back(st, run, &id, c).await;
                    }
                    return Err(e);
                }
                if held {
                    return Ok(Put::Held);
                }
            }
        }
    }
    let (put, refused, whole) = {
        let mut s = st.borrow_mut();
        let t = res!(s.table(run));
        let u = match t.uploads.get_mut(&key) {
            Some(u) if !u.is_whole() => u,
            _ => return Err(err!("store.body_put: no upload of {} is under way at {}.",
                key.1, offset; Invalid, Input)),
        };
        if u.len != len || u.bytes.len() as u64 != offset {
            return Err(err!("store.body_put: a chunk of {} at {} of {} bytes is out of order; \
                {} of {} bytes have come.", key.1, offset, len, u.bytes.len(), u.len;
                Invalid, Input));
        }
        if offset.saturating_add(chunk.len() as u64) > len {
            return Err(err!("store.body_put: a chunk of {} bytes at {} runs past the {} bytes of {}.",
                chunk.len(), offset, len, key.1; Invalid, Input));
        }
        if offset == 0 && u.bytes.capacity() < len as usize {
            u.bytes.reserve_exact(len as usize);    // bounded by `stage_room` (D1mem fix C)
        }
        u.bytes.extend_from_slice(&chunk);
        if (u.bytes.len() as u64) < len {
            (Ok(Put::More), None, None)
        } else if HexHash::of(&u.bytes) == hash {
            let whole = Rc::new(std::mem::take(&mut u.bytes));
            u.whole = Some(whole.clone());
            u.owed = u.owed.saturating_add(1);
            // Its claim, to put the body down under with no borrow held across the write.
            (Ok(Put::Done), None, u.claim.take().map(|c| (c, whole)))
        } else {
            let gone = t.uploads.remove(&key).and_then(|u| u.claim);
            (Err(err!("store.body_put: the {} bytes uploaded as {} are not it; nothing was kept.",
                len, key.1; Mismatch, Data)), gone, None)
        }
    };
    if let Some(c) = refused {
        c.done(&id).await;
    }
    // THE WHOLE UPLOAD IS PUT DOWN IN THE BODY STORE (D1mem fix B), under the claim it holds until
    // it is named: a second name for it is then answered `Held`, and a turn's ledger names it by
    // hash.  Where it cannot be, the upload is refused and its claim given back.
    if let Some((c, whole)) = whole {
        let wrote = c.put(&id, &key.1, &whole).await;
        drop(whole);
        let back = {
            let mut s = st.borrow_mut();
            match (&wrote, s.runs.get_mut(run)) {
                (Ok(()), Some(t)) => match t.uploads.get_mut(&key) {
                    Some(u) if u.claim.is_none() => { u.claim = Some(c); None }
                    _                            => Some(c),
                },
                (Err(_), Some(t)) => { t.uploads.remove(&key); Some(c) }
                (_, None)         => Some(c),
            }
        };
        if let Some(c) = back {
            give_back(st, run, &id, c).await;
        }
        if let Err(e) = wrote {
            return Err(err!(e, "store.body_put: the {} bytes of {} could not be put down; \
                nothing was kept.", len, key.1; IO, File, Write));
        }
    }
    put
}

/// At most `max` bytes from `offset` of a body a reply named to this run for `id` (O2: keyed
/// `(id, hash)`).  Any other hash is refused, so a run cannot read a body by guessing its hash.
/// A fetch to the last chunk frees it, however often it was named.
async fn body_get(st: &Shared, run: &str, id: String, hash: HexHash, offset: u64, max: u64)
    -> Outcome<Vec<u8>>
{
    let key = (id, hash.as_str().to_string());
    // What is named out: in hand, or a stored body (D1mem fix B) to read once.
    let named = {
        let mut s = st.borrow_mut();
        let t = res!(s.table(run));
        // A `wipe` entry's `before` is named by the run's snapshot, and served from the turn's
        // own capture for the child's wipe test (D1r2), named out at its first fetch so the
        // chunks after it copy nothing (fix E).
        let wanted = t.staged.get(&key.0)
            .is_some_and(|st| st.wants().wipe.iter().any(|(_, _, r)| r.hash == key.1));
        match t.out.get(&key) {
            Some((Out::Bytes(b), _))    => Ok(b.clone()),
            Some((Out::Stored(n), _))   => Err(Some(*n)),
            None if wanted => match diamond::turn_before(&key.0, &key.1) {
                Some(Prior::Held(b))    => {
                    let b = Rc::new(b);
                    out_insert(t, &key.0, &key.1, Out::Bytes(b.clone()));
                    Ok(b)
                }
                Some(Prior::Stored(r))  => Err(Some(r.len)),
                None    => return Err(err!(
                    "store.body_get: the turn of '{}' keeps no before {}.", key.0, key.1;
                    Missing, Data)),
            },
            None => return Err(err!(
                "store.body_get: no reply to this run named the body {} of '{}'.", key.1, key.0;
                Missing, Data)),
        }
    };
    let b = match named {
        Ok(b)   => b,
        Err(n)  => {
            let r = BodyRef { hash: key.1.clone(), len: n.unwrap_or(0) };
            let b = match diamond::versions_body(&key.0, &key.1).await {
                Ok(Some(b)) if r.names(&b) => Rc::new(b),
                _ => return Err(err!(
                    "store.body_get: the body {} of '{}' named to this run will not read from \
                    the store.", key.1, key.0; Missing, Data)),
            };
            if let Some(t) = st.borrow_mut().runs.get_mut(run) {
                out_insert(t, &key.0, &key.1, Out::Bytes(b.clone()));
            }
            b
        }
    };
    let mut s = st.borrow_mut();
    let t = res!(s.table(run));
    let len = b.len() as u64;
    if offset > len {
        return Err(err!("store.body_get: {} is past the {} bytes of {}.", offset, len, key.1;
            Invalid, Input));
    }
    let end = len.min(offset.saturating_add(max));
    if end == len {
        t.out.remove(&key);
    }
    Ok(b[offset as usize..end as usize].to_vec())
}

/// One chunk of a journal round, staged in the caller's table and written to the store at its
/// last (U4e).  Every chunk is in order; an offset of 0 begins the round again, and a round begun
/// ends the one under way.  Room is the stage's, as a body upload's.
async fn journal_put(st: &Shared, run: &str, of: String, key: JournalKey, len: u64, offset: u64,
    chunk: Vec<u8>) -> Outcome<Put>
{
    let whole = {
        let mut s = st.borrow_mut();
        if offset == 0 {
            res!(s.table(run)).journal = None;
            if let Some(e) = stage_room(&s, run, len) {
                return Err(e);
            }
            res!(s.table(run)).journal = Some(Rounding {
                run: of.clone(), key, len, bytes: Vec::with_capacity(len as usize) });
        }
        let t = res!(s.table(run));
        let r = match t.journal.as_mut() {
            Some(r) if r.run == of && r.key == key && r.len == len
                && r.bytes.len() as u64 == offset => r,
            _ => return Err(err!("store.journal_put: a chunk of {:?} of '{}' at {} of {} \
                bytes is out of order.", key, of, offset, len; Invalid, Input)),
        };
        if offset.saturating_add(chunk.len() as u64) > len {
            return Err(err!("store.journal_put: a chunk of {} bytes at {} runs past the {} \
                bytes of {:?}.", chunk.len(), offset, len, key; Invalid, Input));
        }
        r.bytes.extend_from_slice(&chunk);
        if (r.bytes.len() as u64) < len {
            return Ok(Put::More);
        }
        match t.journal.take() {
            Some(r) => r.bytes,
            None    => Vec::new(),
        }
    };
    res!(journal_write_at(&crate::store::backend(), &of, key, &whole).await);
    Ok(Put::Done)
}

/// At most `BODY_CHUNK` bytes from `offset` of the first round of `of` at or after `Round(n)`, or
/// of its open record for `Open` (R1i).
async fn journal_read(of: &str, from: JournalKey, offset: u64) -> Outcome<Option<JournalChunk>> {
    let b = crate::store::backend();
    let (key, bytes) = match from {
        JournalKey::Round(n) => {
            match res!(journal_rounds(&b, of).await).into_iter().find(|r| *r >= n) {
                Some(r) => (JournalKey::Round(r), res!(journal_load(&b, of, r).await)),
                None    => return Ok(None),
            }
        },
        JournalKey::Open => match res!(journal_open(&b, of).await) {
            Some(bytes) => (JournalKey::Open, bytes),
            None        => return Ok(None),
        },
    };
    let len = bytes.len() as u64;
    if offset > len {
        return Err(err!("store.journal_read: {} is past the {} bytes of {:?} of '{}'.",
            offset, len, key, of; Invalid, Input));
    }
    let end = len.min(offset.saturating_add(BODY_CHUNK as u64));
    Ok(Some(JournalChunk { key, len, chunk: bytes[offset as usize..end as usize].to_vec() }))
}

pub(crate) fn not_served(name: &str, why: &str) -> Error<ErrTag> {
    err!("store.{} is not served natively yet: {}.", name, why; Missing, Configuration)
}

fn wire_wants(w: &standing::Wants) -> types::Wants {
    types::Wants {
        own:     w.own.clone(),
        // The store names no `Seen` for a note's or a window's path: the child reads it afresh.
        notes:   w.notes.iter().map(|p| (p.clone(), Seen::Unread)).collect(),
        windows: w.windows.iter().map(|p| (p.clone(), Seen::Unread)).collect(),
        large:   w.large.clone(),
        wipe:    w.wipe.clone(),
    }
}

/// Page `n` of `w`: at most `LIST_PAGE` entries over its five lists, in their order.
fn wants_page(w: &types::Wants, n: u32) -> WantsPage {
    let total = crate::store::call::wants_len(w);
    let from = (n as usize).saturating_mul(LIST_PAGE);
    let mut skip = from;
    let mut room = LIST_PAGE;
    fn take<T: Clone>(v: &[T], skip: &mut usize, room: &mut usize) -> Vec<T> {
        let s = (*skip).min(v.len());
        *skip -= s;
        let got: Vec<T> = v[s..].iter().take(*room).cloned().collect();
        *room -= got.len();
        got
    }
    let wants = types::Wants {
        own:     take(&w.own, &mut skip, &mut room),
        notes:   take(&w.notes, &mut skip, &mut room),
        windows: take(&w.windows, &mut skip, &mut room),
        large:   take(&w.large, &mut skip, &mut room),
        wipe:    take(&w.wipe, &mut skip, &mut room),
    };
    WantsPage { wants, total: total as u32, more: from.saturating_add(LIST_PAGE) < total }
}

fn keep_names(st: &Shared, run: &str, id: &str, got: Option<(u64, Vec<String>)>)
    -> Option<Recorded>
{
    got.map(|(version, names)| {
        let rec = Recorded::of(version, &names);
        if let Some(t) = st.borrow_mut().runs.get_mut(run) {
            // Only the latest version per id is kept: the table does not grow with the turns.
            t.recorded.retain(|(of, _), _| of != id);
            t.recorded.insert((id.to_string(), version), names);
        }
        rec
    })
}


// ┌───────────────────────────────────────────────────────────────┐
// │ Serving                                                        │
// └───────────────────────────────────────────────────────────────┘

/// A sync call, answered from memory with no await (spec §16.5).
fn serve_sync(st: &mut State, run: &str, bs: &Bodies, call: StoreCall) -> StoreReply {
    use StoreCall as C;
    use StoreReply as R;
    match call {
        C::CrystalHalf { id, path } => R::CrystalHalf(diamond::crystal_half(&id, &path)),
        C::Capture { id, raw, change } => R::Capture(match change.stored(&|r| bs.has(r)) {
            Ok(ch)  => Ok(diamond::capture(&id, &raw, ch)),
            Err(e)  => Err(e),
        }),
        C::CapturedRoom { id, path, found, copy, destroying, room } => R::CapturedRoom(
            diamond::captured_room(&id, &path, &found, copy, destroying, room)),
        C::Release { id, path } => R::Release(diamond::release(&id, &path)),
        C::HeldUnder { id, from, after } => {
            let mut all = diamond::held_under(&id, &from);
            all.sort_by(|a, b| a.0.cmp(&b.0));
            R::HeldUnder(all.into_iter()
                .filter(|e| after.as_ref().is_none_or(|a| e.0.as_str() > a.as_str()))
                .take(HELD_PAGE)
                .collect())
        }
        C::ThisTurnFound { id, path, now } => R::ThisTurnFound(match body(bs, &now) {
            Ok(b)   => {
                let said = diamond::this_turn_said(&id, &path, &b);
                let wire = WireTurnFound::said(&said);
                if let TurnSaid::Carried(c) | TurnSaid::Was(c) = said {
                    st.name_out_prior(run, &id, bs, c);
                }
                wire
            }
            Err(_)  => WireTurnFound::Was(now),
        }),
        C::SealsSpent { id, path, now } => R::SealsSpent(match body(bs, &now) {
            Ok(b)   => diamond::seals_spent(&id, &path, &b),
            Err(_)  => true,
        }),
        C::RanOpaque { id } => R::RanOpaque(diamond::ran_opaque(&id)),
        C::Theirs { id, path } => R::Theirs(diamond::theirs(&id, &path)),
        C::FolderOf { path } => R::FolderOf(diamond::folder_of(&path)),
        C::Versionable { id, path } => R::Versionable(diamond::versionable(&id, &path)),
        C::ChangeRefused { id, path } => R::ChangeRefused(diamond::change_refused(&id, &path)),
        C::RefuseChange { id, path } => R::RefuseChange(diamond::refuse_change(&id, &path)),
        C::OpenDeleteRoom { id, file } => {
            let got = diamond::open_delete_room(&id, &file);
            if matches!(got, OpenDelete::Go(true)) {
                if let Some(t) = st.runs.get_mut(run) {
                    t.deletes.insert((id, file));
                }
            }
            R::OpenDeleteRoom(got)
        }
        C::OpenDeleteAnswer { id, ticket, allow } =>
            R::OpenDeleteAnswer(diamond::open_delete_answer(&id, ticket, allow)),
        C::OpenDeleteRelease { id, file } => {
            diamond::open_delete_release(&id, &file);
            if let Some(t) = st.runs.get_mut(run) {
                t.deletes.remove(&(id, file));
            }
            R::OpenDeleteRelease(())
        }
        C::RouteHere { row, row_folder, landed, overwrites } => R::RouteHere(
            diamond::route_here(&row, row_folder.as_deref(), &landed, overwrites)),
        C::RestoreStore { ticket } => R::RestoreStore(diamond::restore_store(ticket)),
        // No restore open under the ticket (D1r1d): the client uploads nothing, as there is no
        // Diamond to put it in, and the answer is the direct store's, which reads no body.
        C::RestoreRoute { ticket, spelled, landed, .. } if diamond::restore_store(ticket).is_none() =>
            R::RestoreRoute(diamond::restore_route(ticket, &spelled, &landed, None, None)),
        C::RestoreRoute { ticket, spelled, landed, now, puts } =>
            R::RestoreRoute(match (opt_body(bs, &now), opt_body(bs, &puts)) {
                (Ok(now), Ok(puts)) => diamond::restore_route(ticket, &spelled, &landed,
                    now.as_deref(), puts.as_deref()),
                _                   => Act::Unanswered,
            }),
        C::RestoreLook { ticket, spelled, now } =>
            R::RestoreLook(diamond::restore_look(ticket, &spelled, now)),
        C::RestoreAsked { ticket, spelled, now } =>
            R::RestoreAsked(diamond::restore_asked(ticket, &spelled, now)),
        C::RestoreLanded { ticket, .. } if diamond::restore_store(ticket).is_none() =>
            R::RestoreLanded(Ok(())),
        C::RestoreLanded { ticket, change } =>
            R::RestoreLanded(match change.resolve(&mut |r| bs.get(r)) {
                Ok(ch)  => Ok(diamond::restore_landed(ticket, ch)),
                Err(e)  => Err(e),
            }),
        C::IsSteering { id } => R::IsSteering(diamond::is_steering(&id)),
        C::Steering { id } => R::Steering(st.give(run, Held::Steer(diamond::steering(&id)))),
        C::DrainDirty { id } => R::DrainDirty(diamond::drain_dirty(&id).into_iter()
            .map(|m| st.give(run, Held::Marked(m)))
            .collect()),
        C::EndTurnCounts { id } => {
            // This run's counts only, and its staged table with them (D1v2c).
            st.counts_end(run, &id);
            st.unstage(run, &id);
            R::EndTurnCounts(())
        }
        C::Trail { what, detail } => R::Trail(own::trail(&what, &detail)),
        C::LetGo { handle } => {
            let gone = st.runs.get_mut(run).and_then(|t| t.held.remove(&handle.0));
            // A hold let go ends its turn's staged table (D1v2c).
            if let Some(Held::Hold(h)) = gone.as_ref() {
                let id = h.id().to_string();
                st.unstage(run, &id);
            }
            drop(gone);
            R::LetGo(())
        }
        C::Ping {} => R::Ping(()),
        other => R::Fault(Fault::Down(StoreDown {
            why: fmt!("store.{} is a wait call, served as sync", other.name()),
        })),
    }
}

/// A wait call, served on its own task inside the run's `RunEnv`.
/// **The one decision between a wait call's Busy and its commit** (QA1 F1): the store alone
/// answers Busy, and only where the call has not begun to commit.  The Busy arm asks
/// [`busy`](Self::busy) when its timer fires; a call with a commit point asks
/// [`commit`](Self::commit) under its held lock, just before its first change.  Whichever asks
/// first decides, on the store's one thread: a call answered Busy changes nothing after, and a
/// call that has begun to commit is answered with what it did, however late.
#[derive(Clone, Debug, Default)]
pub(crate) struct Answered(Rc<std::cell::Cell<Decided>>);

/// Where a wait call's [`Answered`] stands.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) enum Decided {
    #[default]
    Open,
    Busy,
    Committing,
}

impl Answered {
    /// The Busy arm's question: answer the caller Busy now?  Yes, and nothing commits after,
    /// unless the call has already begun to commit.
    pub(crate) fn busy(&self) -> bool {
        match self.0.get() {
            Decided::Committing => false,
            _                   => {
                self.0.set(Decided::Busy);
                true
            },
        }
    }
    /// A commit point's question: may this call change what stands now?  Yes, and the caller
    /// will be answered with what it did, unless it has been answered Busy.
    pub(crate) fn commit(&self) -> bool {
        match self.0.get() {
            Decided::Busy   => false,
            _               => {
                self.0.set(Decided::Committing);
                true
            },
        }
    }
    /// Has the caller been answered Busy?
    pub(crate) fn is_set(&self) -> bool { self.0.get() == Decided::Busy }
    /// The Busy arm firing, for a test.
    #[cfg(test)]
    pub(crate) fn set(&self) { let _ = self.busy(); }
}

/// [`serve_wait_late`] for a call nobody will answer Busy (a test's door).
#[cfg(test)]
async fn serve_wait(st: &Shared, run: &str, bs: &Bodies, call: StoreCall) -> StoreReply {
    serve_wait_late(st, run, bs, call, &Answered::default()).await
}

/// A wait call served, `answered` set once its caller has been answered Busy.
async fn serve_wait_late(st: &Shared, run: &str, bs: &Bodies, call: StoreCall,
    answered: &Answered) -> StoreReply
{
    use StoreCall as C;
    use StoreReply as R;
    let text = |id: &str, r: Outcome<String>|
        r.map(|s| st.borrow_mut().name_out(run, id, bs, s.into_bytes()));
    match call {
        C::ReadCrystalData { id } =>
            R::ReadCrystalData(text(&id, diamond::read_crystal_data(&id).await)),
        C::ReadCrystalDataStrict { id } =>
            R::ReadCrystalDataStrict(text(&id, diamond::read_crystal_data_strict(&id).await)),
        C::ReadCrystalPage { id } =>
            R::ReadCrystalPage(text(&id, diamond::read_crystal_page(&id).await)),
        C::ReadCrystalPageStrict { id } =>
            R::ReadCrystalPageStrict(text(&id, diamond::read_crystal_page_strict(&id).await)),
        C::CrystalUndoTarget { id, half, at } =>
            R::CrystalUndoTarget(diamond::crystal_undo_target(&id, half, at).await),
        C::HotRefusals { id } => R::HotRefusals(diamond::hot_refusals(&id).await),
        // The activity record and the no-progress K (PORT-PL-B).
        C::ActivityReadAll { id } => R::ActivityReadAll(Ok(diamond::activity_read_all(&id).await)),
        C::ActivityAppend { id, line, now } => R::ActivityAppend(
            match crate::activity::decode(&line) {
                Some(crate::activity::Entry::Turn(t)) =>
                    diamond::activity_append(&id, t, now.min(i64::MAX as u64) as i64).await,
                _ => Err(err!("An activity line to append ({} bytes) is not one turn.",
                    line.len(); Invalid, Input, Wire)),
            }),
        C::NoProgressRounds { id } => R::NoProgressRounds(diamond::no_progress_rounds(&id).await),
        C::SetHotRefusals { id, n } => R::SetHotRefusals(diamond::set_hot_refusals(&id, n).await),
        C::CrystalHotLastGood { id, old } => R::CrystalHotLastGood(
            match crate::store::call::fetch(&old, &mut |r| bs.get(r)).map(String::from_utf8) {
                Ok(Ok(old)) => text(&id, Ok(diamond::crystal_hot_last_good(&id, &old).await)),
                Ok(Err(e))  => Err(err!(e, "store.crystal_hot_last_good: the crystal of '{}' is \
                    not UTF-8.", id; Decode, Wire)),
                Err(e)      => Err(e),
            }),
        C::LastPassed { id } => R::LastPassed(diamond::last_passed(&id).await),
        C::MarkPassed { id, version, page, data, debug } => R::MarkPassed(
            diamond::mark_passed_marks(&id, version,
                page.map(|p| p.as_str().to_string()).unwrap_or_default(),
                data.as_str().to_string(), debug).await),
        C::StandingSettle { id, root, path, phase, archive, noted, touched, at } =>
            R::StandingSettle(standing_settle(bs, &id, root, &path, phase, &archive, noted,
                touched, at, rule_off(st, "workspace_own")).await),
        C::StoreFileRead { id, path, max } => R::StoreFileRead(
            match store_file_read(&id, &path, max).await {
                Ok(Some((b, total)))    => {
                    let b = st.borrow_mut().name_out(run, &id, bs, b);
                    Ok(Some((b, total)))
                },
                Ok(None)                => Ok(None),
                Err(e)                  => Err(e),
            }),
        C::StoreFileList { id, dir } => R::StoreFileList(store_file_list(&id, &dir).await),
        C::StoreWriteThen { id, root, path, body, expect, archive } => R::StoreWriteThen(
            store_write_then(bs, &id, root, &path, &body, expect.as_ref(), &archive, answered,
                Lax { writable_only: rule_off(st, "writable_only"),
                    commit_guard: rule_off(st, "commit_guard"),
                    commit_stall: stall_secs(st, "store_write_then.commit") }).await),
        C::StoreFileAct { id, root, path, act } => R::StoreFileAct(
            store_file_act(&id, root, &path, &act, answered, Lax {
                writable_only: rule_off(st, "writable_only"),
                commit_guard: rule_off(st, "commit_guard"),
                commit_stall: 0 }).await),
        C::StateRead { id, root, path } => R::StateRead(
            match state_read(&id, root, &path).await {
                Ok((old, touched))  => {
                    let old = old.map(|b| st.borrow_mut().name_out(run, &id, bs, b));
                    let touched = touched.map(|b| st.borrow_mut().name_out(run, &id, bs, b));
                    Ok((old, touched))
                },
                Err(e)              => Err(e),
            }),
        C::AbsorbFoldNotes { id, notes } =>
            R::AbsorbFoldNotes(diamond::absorb_fold_notes_guarded(&id, &notes,
                || answered.commit()).await),
        C::AddLink { owner, from, to, rel, note, by } =>
            R::AddLink(diamond::add_link(&owner, &from, &to, &rel, &note, &by).await),
        // A run reads the links of the Diamonds it was granted alone; the parent, every one.
        C::AllLinks {} => {
            let only = granted(st, run);
            R::AllLinks(diamond::all_links_among(only.as_ref()).await)
        }
        C::LinksJson { node_ref } => {
            let only = granted(st, run);
            R::LinksJson(diamond::links_json_among(&node_ref, only.as_ref()).await)
        }
        // `owner` is checked against the grant in `refusal`, as for every named Diamond.
        C::LinksPage { owner, at, stamp } =>
            R::LinksPage(diamond::links_page(&owner, at, stamp.as_ref()).await),
        C::RemoveLinkByModel { owner, link_id } => R::RemoveLinkByModel(
            diamond::remove_link_by_model(&owner, &link_id).await.map(|u| Unlinked::of(&u))),
        C::DiamondExists { id } => R::DiamondExists(diamond::diamond_exists(&id).await),
        C::KeepRoom { id } => R::KeepRoom(diamond::keep_room(&id).await),
        // A body that will not read is the user's (UNBLOCK-26: unsure is his).
        C::AuthoredByUser { id, path, now } => R::AuthoredByUser(match body(bs, &now) {
            Ok(b)   => diamond::authored_by_user(&id, &path, &b).await,
            Err(_)  => true,
        }),
        C::TurnsFound { id, path, now } => R::TurnsFound(match body(bs, &now) {
            Ok(b)   => diamond::turns_found(&id, &path, &b).await
                .map(|v| st.borrow_mut().name_out(run, &id, bs, v)),
            Err(_)  => Some(now),
        }),
        C::MeasuredAgainst { id, path, now } => R::MeasuredAgainst(match body(bs, &now) {
            Ok(b)   => {
                let v = diamond::measured_against(&id, &path, &b).await;
                st.borrow_mut().name_out(run, &id, bs, v)
            }
            Err(_)  => now,
        }),
        C::SealRun { id, path, now } => R::SealRun(match body(bs, &now) {
            Ok(b)   => diamond::seal_run(&id, &path, &b).await,
            Err(e)  => Err(e),
        }),
        C::Pend { id, path, before, deleting, mark } => R::Pend(match body(bs, &before) {
            Ok(b)   => diamond::pend(&id, &path, &b, deleting, mark).await,
            Err(e)  => Err(e),
        }),
        C::Unpend { id, path } => R::Unpend(diamond::unpend(&id, &path).await),
        C::NoteOutput { id, tool, path, bytes } => R::NoteOutput(
            diamond::note_output_by_hash(&id, &tool, &path, &bytes.hash).await),
        C::OutputIsOwn { id, tool, path, bytes } => R::OutputIsOwn(
            diamond::output_is_own_by_hash(&id, &tool, &path, &bytes.hash).await),
        C::MadeFiles { id } => R::MadeFiles(diamond::made_files(&id).await),
        C::RanMade { id, by, files, capped } => R::RanMade(diamond::ran_made(&id, by, files, capped)),
        C::OpenWindow { id, by } => {
            let around = diamond::open_window(&id, by).await;
            R::OpenWindow(st.borrow_mut().give(run, Held::Window(around)))
        }
        C::CloseWindow { window } => {
            let held = st.borrow_mut().runs.get_mut(run).and_then(|t| t.held.remove(&window.0));
            match held {
                Some(Held::Window(around)) => diamond::close_window(around).await,
                Some(other) => {
                    if let Some(t) = st.borrow_mut().runs.get_mut(run) {
                        t.held.insert(window.0, other);
                    }
                }
                None => (),
            }
            R::CloseWindow(())
        }
        C::VersionsRecord { id, cause, turn, note, change } => {
            let note = match note.resolve(&mut |r| bs.get(r)) {
                Ok(n)   => n,
                Err(e)  => return R::VersionsRecord(Err(e)),
            };
            let change = match change.resolve(&mut |r| bs.get(r)) {
                Ok(c)   => c,
                Err(e)  => return R::VersionsRecord(Err(e)),
            };
            R::VersionsRecord(diamond::versions_record(&id, cause, &turn, &note, vec![change]).await
                .map(|got| keep_names(st, run, &id, got)))
        }
        C::RecordedNames { id, version, after } => {
            let s = st.borrow();
            let names = s.runs.get(run).and_then(|t| t.recorded.get(&(id.clone(), version)));
            R::RecordedNames(match names {
                None        => Err(err!("store: version {} of '{}' was not recorded by this run.",
                    version, id; Missing, Data)),
                Some(names) => {
                    let from = match &after {
                        None    => Some(0),
                        Some(a) => names.iter().position(|n| n == a).map(|i| i + 1),
                    };
                    match from {
                        Some(from)  => Ok(names.iter().skip(from).take(LIST_PAGE).cloned()
                            .collect()),
                        None        => Err(err!("store: '{}' is not a name version {} recorded.",
                            after.unwrap_or_default(), version; Missing, Data)),
                    }
                }
            })
        }
        C::VersionsBody { id, hash } => R::VersionsBody(diamond::versions_body(&id, &hash).await
            .map(|b| b.map(|b| st.borrow_mut().name_out(run, &id, bs, b)))),
        C::VersionsUndoTarget { id, path, at } =>
            R::VersionsUndoTarget(diamond::versions_undo_target(&id, &path, at).await),
        C::VersionsManifest { id, version } =>
            R::VersionsManifest(diamond::versions_manifest(&id, version).await),
        C::RestoreKeep { ticket, path, deleting, .. } if diamond::restore_store(ticket).is_none() =>
            R::RestoreKeep(diamond::restore_keep(ticket, &path, None, deleting).await),
        C::RestoreKeep { ticket, path, now, deleting } => R::RestoreKeep(match opt_body(bs, &now) {
            Ok(now) => diamond::restore_keep(ticket, &path, now.as_deref(), deleting).await,
            Err(e)  => Err(e),
        }),
        C::RestoreLetGo { ticket, path } =>
            R::RestoreLetGo(diamond::restore_let_go(ticket, &path).await),
        C::HoldVersions { id } => R::HoldVersions(match diamond::hold_versions(&id).await {
            Ok(h)   => Ok(st.borrow_mut().give(run, Held::Hold(Rc::new(SlotHold::new(h, &id))))),
            Err(e)  => Err(e),
        }),
        C::VersionsRecordDirty { .. } => R::VersionsRecordDirty(Err(not_served(
            "versions_record_dirty", "the dirty group's record is R7a's"))),
        C::TurnWants { id } => {
            let wants = diamond::turn_wants(&id).await;
            let page = wants_page(&wire_wants(&wants), 0);
            #[allow(unused_mut)]
            let mut staged = Staged::new(wants);
            #[cfg(test)]
            staged.rules_off(&st.borrow().rules_off);
            if let Some(t) = st.borrow_mut().runs.get_mut(run) {
                // A new snapshot replaces the table (§16.3 3, D1v2c): nothing sent against an
                // earlier one is honoured for this one's reading.
                t.staged.insert(id, staged);
            }
            R::TurnWants(Ok(page))
        }
        C::TurnWantsPage { id, n } => {
            let s = st.borrow();
            R::TurnWantsPage(match s.runs.get(run).and_then(|t| t.staged.get(&id)) {
                Some(staged)    => Ok(wants_page(&wire_wants(staged.wants()), n)),
                None            => Err(unstaged(&id)),
            })
        }
        C::TurnStanding { id, path, seen, standing, stamp } => {
            let standing = match standing.resolve(&mut |r| bs.get(r)) {
                Ok(types::Standing::Now(b)) => standing::Standing::Now(b),
                Ok(types::Standing::Unknown) => standing::Standing::Unknown,
                Err(e) => return R::TurnStanding(Err(e)),
            };
            R::TurnStanding(with_staged(st, run, &id,
                |staged| staged.stage_wire(&path, seen, standing, stamp), &path))
        }
        C::TurnStands { id, stands } => R::TurnStands(with_staged(st, run, &id,
            |staged| staged.stand_page(stands), "a page of stands")),
        C::TurnWiped { id, path, seen, wiped } => R::TurnWiped(
            with_staged(st, run, &id, |staged| staged.wipe(&path, seen, wiped), &path)),
        C::DrainTurn { hold, id } => {
            let (held, staged) = {
                let s = st.borrow();
                let staged = s.runs.get(run).and_then(|t| t.staged.get(&id)).cloned()
                    .unwrap_or_default();
                (s.hold(run, hold), staged)
            };
            R::DrainTurn(match held {
                Ok(h)   => slot_drain_by(&h, &id, diamond::drain_turn_by(h.held(), &id, &staged))
                    .await,
                Err(e)  => Err(e),
            })
        }
        C::TurnUncovered { hold, id, wrote } => R::TurnUncovered(
            match st.borrow().hold(run, hold) {
                Ok(h)   => slot_uncovered(&h, &id, &wrote),
                Err(e)  => Err(e),
            }),
        C::TurnAdd { hold, id, change } => R::TurnAdd(
            match (st.borrow().hold(run, hold), change.resolve(&mut |r| bs.get(r))) {
                (Ok(h), Ok(ch)) => slot_add(&h, &id, ch),
                (Err(e), _) | (_, Err(e)) => Err(e),
            }),
        C::DrainWindows { hold, id } => {
            let (held, staged) = {
                let mut s = st.borrow_mut();
                let staged = s.runs.get_mut(run).and_then(|t| t.staged.remove(&id))
                    .unwrap_or_default();
                (s.hold(run, hold), staged)
            };
            let h = match held {
                Ok(h)   => h,
                Err(e)  => return R::DrainWindows(Err(e)),
            };
            let mut busy = match slot_take(&h, &id) {
                Ok(b)   => b,
                Err(e)  => return R::DrainWindows(Err(e)),
            };
            let moved = diamond::drain_windows_by(&id, busy.captured(), &staged).await;
            let n = moved.len() as u32;
            busy.window(moved);
            slot_put(&h, &id, busy);
            R::DrainWindows(Ok(n))
        }
        C::VersionsRecordHeld { hold, id, at, cause, turn, note } => {
            let got = async {
                let h = match st.borrow().hold(run, hold) {
                    Ok(h)   => h,
                    Err(e)  => return Err(e),
                };
                let note = match note.resolve(&mut |r| bs.get(r)) {
                    Ok(n)   => n,
                    Err(e)  => return Err(e),
                };
                let busy = match slot_take(&h, &id) {
                    Ok(b)   => b,
                    Err(e)  => return Err(e),
                };
                let (changes, notes) = slot_changes(busy);
                let got = diamond::versions_record_held(h.held(), &id, at, cause, &turn, &note,
                    changes).await;
                if got.is_ok() {
                    diamond::settle(&id, &notes).await;
                    // The turn is recorded, so its counts end: this run's only (D1v2c).
                    st.borrow_mut().counts_end(run, &id);
                }
                slot_end(&h, &id);
                got
            }.await;
            // The turn's staged table ends with its record, written or refused (D1v2c).
            st.borrow_mut().unstage(run, &id);
            R::VersionsRecordHeld(got.map(|got| keep_names(st, run, &id, got)))
        }
        C::RecordSteer { hold, id, json, instruction } => {
            let h = match st.borrow().hold(run, hold) {
                Ok(h)   => h,
                Err(e)  => return R::RecordSteer(Err(e)),
            };
            let (json, instruction) = match (json.resolve(&mut |r| bs.get(r)),
                instruction.resolve(&mut |r| bs.get(r)))
            {
                (Ok(j), Ok(i))  => (j, i),
                (Err(e), _) | (_, Err(e)) => return R::RecordSteer(Err(e)),
            };
            R::RecordSteer(diamond::record_steer(h.held(), &id, &json, &instruction).await)
        }
        C::LiveBounds { .. } => R::LiveBounds(Err(not_served("live_bounds",
            "the marks are the tab's"))),
        C::Reach { .. } => R::Reach(Err(not_served("reach", "the marks are the tab's"))),
        C::BodyPut { id, act, hash, len, offset, chunk } =>
            R::BodyPut(body_put(st, run, id, act, hash, len, offset, chunk).await),
        C::BodyGet { id, hash, offset, max } =>
            R::BodyGet(body_get(st, run, id, hash, offset, max).await),
        C::JournalPut { run: of, key, len, offset, chunk } =>
            R::JournalPut(journal_put(st, run, of, key, len, offset, chunk).await),
        C::JournalRead { run: of, from, offset } =>
            R::JournalRead(journal_read(&of, from, offset).await),
        C::JournalDrop { run: of } =>
            R::JournalDrop(journal_clear(&crate::store::backend(), &of).await),
        C::JournalList { after } =>
            R::JournalList(journal_runs(&crate::store::backend(), after.as_deref(), JOURNAL_PAGE)
                .await),
        C::JournalSweep { ttl_ms, now_ms } =>
            R::JournalSweep(crate::store::backend().sweep_expired(JOURNAL_ROOT, ttl_ms, now_ms)
                .map(|n| n as u64)),
        // A SYNC CALL IS NEVER SERVED HERE (d1v1 check H2): served off the inline path, outside
        // `in_sync`, the tripwire that proves it never awaits would not see it.
        sync => R::Fault(Fault::Down(StoreDown {
            why: fmt!("store.{} is a sync call, served as wait", sync.name()),
        })),
    }
}

/// The archive append of a standing file's write, its retired lines uploaded first.  Only the
/// store's own area is written, only to the archive of a standing file of the Diamond `id`.
/// A test's switch that turns the archive's Diamond check off, to show its red (D1r1c).
#[cfg(test)]
pub(crate) static ARCHIVE_ANY_ID: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

#[cfg(test)]
fn archive_any_id() -> bool { ARCHIVE_ANY_ID.load(std::sync::atomic::Ordering::SeqCst) }

#[cfg(not(test))]
fn archive_any_id() -> bool { false }

async fn standing_settle(
    bs:         &Bodies,
    id:         &str,
    root:       FileRoot,
    path:       &str,
    phase:      diamond::SettlePhase,
    archive:    &[(String, BodyRef)],
    noted:      Vec<String>,
    touched:    Vec<String>,
    at:         u64,
    opfs_only:  bool,
)
    -> Outcome<()>
{
    // The one own-area rule (HL5c): the child's `ctx.root` is `Workspace`, which names the
    // store's own area under `diamonds/` as `Opfs` does.  A test's switch lets any id through.
    if let Err(e) = own_area_of("standing_settle", id, root, path, opfs_only) {
        if !archive_any_id() || root == FileRoot::Machine {
            return Err(e);
        }
    }
    let text = |r: &BodyRef, what: &str| -> Outcome<String> {
        match String::from_utf8(res!(crate::store::call::fetch(r, &mut |r| bs.get(r)))) {
            Ok(t)   => Ok(t),
            Err(e)  => Err(err!(e, "The {} of '{}' is not UTF-8.", what, path; Decode, Wire)),
        }
    };
    let mut landed = diamond::Landed { noted, touched, at, ..diamond::Landed::default() };
    for (leaf, r) in archive.iter() {
        landed.archive.push((leaf.clone(), res!(text(r, "retired text"))));
    }
    // The parts it is sent are checked, never trusted: a part of the other phase is refused
    // before anything is written (the security boundary, held-lock settle P2).
    diamond::standing_settle(root, path, &landed, phase).await
}

/// A test's switch that turns `state_read`'s Diamond and leaf checks off, to show their red.
#[cfg(test)]
pub(crate) static STATE_ANY_PATH: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

#[cfg(test)]
fn state_any_path() -> bool { STATE_ANY_PATH.load(std::sync::atomic::Ordering::SeqCst) }

#[cfg(not(test))]
fn state_any_path() -> bool { false }

/// The one `store_owned` rule of the store's own area (HL5a; every own-area check since HL5c):
/// `path` is at or under the Diamond `id`'s folder ([`store_owned`]) under [`FileRoot::Opfs`] or
/// [`FileRoot::Workspace`], which name the same area there.  The grant
/// of `id` to the run is the call's own check ([`named`]).
///
/// [`store_owned`]: crate::tools::store_owned
fn own_area(what: &str, id: &str, root: FileRoot, path: &str) -> Outcome<()> {
    own_area_of(what, id, root, path, false)
}

/// [`own_area`], with the test's red that takes `Opfs` alone for the store's own area
/// (`opfs_only`, `srv.rule_off("workspace_own")`): the HL5b refusal of the child's `Workspace`.
fn own_area_of(what: &str, id: &str, root: FileRoot, path: &str, opfs_only: bool)
    -> Outcome<()>
{
    // `Workspace` and `Opfs` both name the store's own area at `diamonds/<id>/` (HL5a ruling,
    // [`store_owned`]); the machine's root never does.
    if root == FileRoot::Machine || (opfs_only && root != FileRoot::Opfs) {
        return Err(err!("store.{} reads the store's own area, and {:?} is not it.", what, root;
            Invalid, Input));
    }
    match crate::tools::store_owned(root, path) {
        Some(owner) if owner == id => Ok(()),
        _ => Err(err!("store.{}: '{}' is not a file of the Diamond '{}'.", what, path, id;
            Invalid, Input)),
    }
}

/// What a `STATE.md` landing reads (PL-A2), checked as [`standing_settle`] checks: the store's
/// own area, a path of the Diamond `id` ([`own_area`]), and its `STATE.md` alone.  Answers what
/// stands there and the touched record, `None` for an absent file, as `state_landed` reads them:
/// through [`diamond::read_bound`], so a file that stands but will not read is an Err (I-HL4).
async fn state_read(id: &str, root: FileRoot, path: &str)
    -> Outcome<(Option<Vec<u8>>, Option<Vec<u8>>)>
{
    if !state_any_path() {
        res!(own_area("state_read", id, root, path));
        if crate::tools::standing_leaf(path) != Some(crate::tools::STATE_FILE) {
            return Err(err!("store.state_read: '{}' is not the {} of the Diamond '{}'.", path,
                crate::tools::STATE_FILE, id; Invalid, Input));
        }
    }
    let read = |p: String| async move {
        match diamond::read_bound(root, &p).await {
            Ok((_, crate::diamond_versions::Seen::Absent))  => Ok(None),
            Ok((text, _))                                   => Ok(Some(text.into_bytes())),
            Err(e)                                          => Err(e),
        }
    };
    let old = res!(read(path.to_string()).await);
    let touched = res!(read(diamond::touched_path(id)).await);
    Ok((old, touched))
}

/// A file of the Diamond `id` as the store holds it, for a run's child (HL5a): at most `max` of
/// its bytes and its whole length, or `None` where nothing stands there.  **A file that stands
/// but will not read is an `Err`, never `None`** (I-HL4).
async fn store_file_read(id: &str, path: &str, max: u32) -> Outcome<Option<(Vec<u8>, u64)>> {
    let root = FileRoot::Opfs;
    res!(own_area("store_file_read", id, root, path));
    match own::user_read_file_capped(root, path, max).await {
        Ok((b, total))  => Ok(Some((b, total as u64))),
        Err(e)          => match own::user_exists(root, path).await {
            Ok(false)   => Ok(None),
            Ok(true)    => Err(err!(e, "store.store_file_read: '{}' stands but would not read.",
                path; IO, File, Read)),
            Err(e2)     => Err(err!(e2, "store.store_file_read: '{}' would not read and could not \
                be found absent ({}).", path, e; IO, File, Read)),
        },
    }
}

/// A run's child's held write of the Diamond `id`'s standing file at `path` (HL5b): one store op,
/// the order of held-lock settle F1.  Refused before any write unless `path` is one of `id`'s
/// three standing leaves in the store's own area: never `.daimond/`, `meta.json`, `versions/` or
/// the crystal.  Then, holding the file's lock: compare with `expect` (`Ok(Some(found))` refused,
/// nothing archived), the ARCHIVE phase of `archive`, and the write, through the unlocked inner
/// write, since the lock is not re-entrant.  No wire round trip is made while it is held.
///
/// **The commit guard** (review 2): once the Busy arm has answered the caller (`answered`), the
/// write is refused under the lock; an archive already appended is at worst a duplicate (F5).
async fn store_write_then(
    bs:         &Bodies,
    id:         &str,
    root:       FileRoot,
    path:       &str,
    body:       &BodyRef,
    expect:     Option<&Seen>,
    archive:    &[(String, BodyRef)],
    answered:   &Answered,
    lax:        Lax,
)
    -> Outcome<Option<Seen>>
{
    res!(own_area("store_write_then", id, root, path));
    // A test's red: the boundary off, any path in the Diamond's area is written.
    if !crate::tools::store_writable(path) && !lax.writable_only {
        return Err(err!("store.store_write_then: '{}' is the store's own record of the Diamond \
            '{}', which a run does not write, so nothing was written.", path, id; Invalid, Input));
    }
    if let Some(Seen::Unread) = expect {
        return Err(err!("store.store_write_then: a write of '{}' was bound to bytes that could \
            not be read, so there is nothing to compare.", path; Invalid, Input));
    }
    let text = |r: &BodyRef, what: &str| -> Outcome<String> {
        match String::from_utf8(res!(crate::store::call::fetch(r, &mut |r| bs.get(r)))) {
            Ok(t)   => Ok(t),
            Err(e)  => Err(err!(e, "The {} of '{}' is not UTF-8.", what, path; Decode, Wire)),
        }
    };
    let bytes = res!(crate::store::call::fetch(body, &mut |r| bs.get(r)));
    let mut landed = diamond::Landed::default();
    for (leaf, r) in archive.iter() {
        landed.archive.push((leaf.clone(), res!(text(r, "retired text"))));
    }
    // Checked whole before the lock, as the door checks a landing (P3 step 1).
    res!(diamond::settle_check(path, &landed));
    let backend = crate::store::native::installed();
    // A test's red: the lock not taken, a store write between the compare and the bytes lands.
    let _held = match crate::store::diamond::off("held_lock") {
        true    => None,
        false   => res!(backend.hold_file(path).await),
    };
    if answered.is_set() && !lax.commit_guard {
        return Err(late_refusal(path));
    }
    let now = match own::read_file(path).await {
        Ok(b)   => Some(b),
        Err(e)  => match own::exists(path).await {
            Ok(false)   => None,
            Ok(true)    => return Err(err!(e, "store.store_write_then: '{}' stands but would not \
                read, so nothing was written.", path; IO, File, Read)),
            Err(e2)     => return Err(err!(e2, "store.store_write_then: '{}' would not read and \
                could not be found absent ({}), so nothing was written.", path, e; IO, File, Read)),
        },
    };
    if let Some(want) = expect {
        let found = Seen::of(now.as_deref());
        if &found != want {
            return Ok(Some(found));
        }
    }
    res!(diamond::standing_settle(root, path, &landed, diamond::SettlePhase::Archive).await);
    // The commit point (QA1 F1): from here the caller is answered with what this did, never
    // Busy.  A test's red: the guard off, a call answered busy still commits.
    if !lax.commit_guard && !answered.commit() {
        return Err(late_refusal(path));
    }
    commit_stall(lax).await;
    res!(backend.write_file_unlocked(path, &bytes).await);
    Ok(None)
}

/// A test's reds for [`store_write_then`] and [`store_file_act`], each a rule not applied
/// (`srv.rule_off`): the [`store_writable`] boundary, and the commit guard.  Both false outside a
/// test.
///
/// [`store_writable`]: crate::tools::store_writable
#[derive(Clone, Copy, Debug, Default)]
struct Lax {
    writable_only:  bool,
    commit_guard:   bool,
    commit_stall:   u64,    // a test's seconds asleep at the commit point; 0 outside a test
}

/// Sleeps at a commit point for the test's `commit_stall` seconds on the store's clock, so its
/// Busy timer fires while the call commits (QA1 F1).
async fn commit_stall(lax: Lax) {
    if lax.commit_stall > 0 {
        tokio::time::sleep(Duration::from_secs(lax.commit_stall)).await;
    }
}

/// A run's child's folder, delete or move of the Diamond `id`'s `path` (HL5c), as the tab's fs
/// port does each in its own store (`wasm::opfs`): refused unless every path it touches is
/// [`own_area`] and [`store_writable`].  A delete removes one ordinary file under its lock, never
/// a folder.  A file's move lands its copy only where nothing stands, then removes the source
/// only where it is still what was copied, each under its own lock; a folder's moves whole under
/// both names' locks.  A folder is made by marking where its files will be; the store's folders
/// stand by what is in them, so one with nothing in it yet is not listed.  Answered busy, nothing
/// is changed after.
///
/// [`store_writable`]: crate::tools::store_writable
async fn store_file_act(
    id:         &str,
    root:       FileRoot,
    path:       &str,
    act:        &FileAct,
    answered:   &Answered,
    lax:        Lax,
)
    -> Outcome<()>
{
    let mut ends = vec![path];
    if let FileAct::Move(to) = act {
        ends.push(to.as_str());
    }
    for p in ends.iter() {
        res!(own_area("store_file_act", id, root, p));
        if !crate::tools::store_writable(p) && !lax.writable_only {
            return Err(err!("store.store_file_act: '{}' is the store's own record of the Diamond \
                '{}', which a run does not change, so nothing was changed.", p, id;
                Invalid, Input));
        }
    }
    // The commit point under each lock, just before each change (QA1 F1): a call answered Busy
    // while it waited on a lock changes nothing.  A test's red: the guard off.
    let commit = |p: &str| {
        let go = lax.commit_guard || answered.commit();
        let p = p.to_string();
        async move {
            match go {
                true    => Ok(()),
                false   => Err(late_refusal(&p)),
            }
        }
    };
    match act {
        FileAct::Mkdir      => match own::read_file(path).await {
            // A file standing there is not a folder; anything else is made by the writes into it.
            Ok(_)   => Err(err!("store.store_file_act: '{}' is a file, so no folder was made \
                there.", path; Invalid, Input)),
            Err(_)  => Ok(()),
        },
        FileAct::Delete     => {
            let bytes = match own::read_file(path).await {
                Ok(b)   => b,
                Err(e)  => return Err(err!(e, "store.store_file_act: '{}' is not a file that \
                    stands, so it was not removed.", path; Invalid, Input, Path)),
            };
            // Compared again under the file's lock: a write since the read keeps the file.
            match res!(own::delete_file_then(path, &Seen::of(Some(&bytes)), || commit(path)).await) {
                None    => Ok(()),
                Some(_) => Err(moved_under(path)),
            }
        },
        FileAct::Move(to)   => {
            if res!(own::exists(to).await) {
                return Err(err!("'{}' already exists.", to; Invalid, Input));
            }
            let bytes = match own::read_file(path).await {
                Ok(b)   => Some(b),
                Err(e)  => match res!(own::exists(path).await) {
                    true    => None,    // a folder, or a file that will not read
                    false   => return Err(err!(e, "store.store_file_act: nothing at '{}' to \
                        move.", path; Invalid, Input, Path)),
                },
            };
            let bytes = match bytes {
                Some(b) => b,
                None    => return own::move_entry_then(path, to, || commit(path)).await,
            };
            // Once its copy has begun to land, the move is answered with what it did.
            if res!(own::write_file_then(to, &bytes, Some(&Seen::Absent), || commit(path)).await)
                .is_some()
            {
                return Err(err!("'{}' already exists.", to; Invalid, Input));
            }
            let was = Seen::of(Some(&bytes));
            if res!(own::delete_file_if(path, &was).await).is_none() {
                return Ok(());
            }
            // Changed under the move: the source stays, written, and the copy of what it was goes.
            let _ = own::delete_file_if(to, &was).await;
            Err(moved_under(path))
        },
    }
}

/// A delete or move refused because the file changed under it: it stays, as now written.
fn moved_under(path: &str) -> Error<ErrTag> {
    err!("'{}' changed while it was being moved or removed, so it was left where it was, as now \
        written.  Read it again before trying again.", path; Invalid, Input, Mismatch)
}

/// The commit guard's refusal: the caller was answered Busy before the write.
fn late_refusal(path: &str) -> Error<ErrTag> {
    err!("The store answered busy before '{}' was changed, so it was not changed.", path;
        Lock, Timeout)
}

/// A folder of the Diamond `id` as the store holds it, for a run's child (HL5a): each entry's
/// name, whether it is a folder, its length and its write time in milliseconds where known.
async fn store_file_list(id: &str, dir: &str) -> Outcome<Vec<(String, bool, u64, Option<u64>)>> {
    res!(own_area("store_file_list", id, FileRoot::Opfs, dir));
    let listed = res!(own::list_dir_stamped(dir).await);
    Ok(listed.into_iter()
        .map(|(name, is_dir, len, when)| (name, is_dir, len,
            when.filter(|ms| ms.is_finite() && *ms >= 0.0).map(|ms| ms as u64)))
        .collect())
}

/// The Diamonds `run` may read the links of: those it was granted, or `None` for the parent's
/// every one.  A run no longer bound is granted none.
fn granted(st: &Shared, run: &str) -> Option<BTreeSet<String>> {
    match st.borrow().runs.get(run) {
        Some(t) if t.tag == Tag::Parent => None,
        Some(t)                         => Some(t.env.diamonds.clone()),
        None                            => Some(BTreeSet::new()),
    }
}

#[cfg(test)]
fn rule_off(st: &Shared, rule: &str) -> bool { st.borrow().rules_off.contains(&rule) }

#[cfg(not(test))]
#[inline(always)]
fn rule_off(_: &Shared, _: &str) -> bool { false }

fn unstaged(id: &str) -> Error<ErrTag> {
    err!("store: no turn of '{}' was snapshot by turn_wants for this run.", id; Missing, Data)
}

fn with_staged(st: &Shared, run: &str, id: &str, f: impl FnOnce(&mut Staged) -> bool, what: &str)
    -> Outcome<()>
{
    let mut s = st.borrow_mut();
    let staged = match res!(s.table(run)).staged.get_mut(id) {
        Some(staged)    => staged,
        None            => return Err(unstaged(id)),
    };
    if f(staged) {
        Ok(())
    } else {
        Err(err!("store: '{}' was not asked for by this turn's snapshot of '{}', or was sent \
            already.", what, id; Invalid, Input))
    }
}

#[cfg(test)]
#[path = "server_tests.rs"]
mod tests;
