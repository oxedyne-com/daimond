//! D1x1a: one store serialises its clients (d1_plan §3 D1x, d1rest_plan §2 D1x1a).  A conductor
//! and four workers, **each on its own OS thread with its own runtime** (its own thread-locals,
//! the faithful model of a process), each with its own [`RemoteStore`] over a [`LoopLink`] and its
//! own run, all on the one Diamond of one [`StoreServer`].
//!
//! Every case is a function of a backend maker and a [`Harness`], answering `Err` with what went
//! wrong rather than panicking, so a red control runs the same case and shows its red in one log
//! line.  The `_mem` wrappers run each case on Mem, and the `_ozone` wrappers on Ozone (D1j).
//!
//! Red controls: [`Harness::PerClient`] (each client its own server over its own store, the
//! per-process ledgers the server replaces) fails (1) and (3); [`Harness::HoldOff`] (the server's
//! hold table switched off at `drop_run`) fails (3).
//!
//! D1x1b's riders (5)-(8), each red by its own switch: (5) two clients race `write_file_if`, one
//! wins (red: Mem's compare switched off); (6) a call on a Diamond the run was not granted is
//! refused (red: the server's `scope` rule off); (7) a staged path the run's snapshot does not
//! name is refused (red: `wanted` off); (8) a stale `Seen` is not honoured (red: `seen` off).  The
//! §16.3a envelope's turn end through [`RemoteStore`] is `remote_turn_tests`' (9), beside the
//! direct side it is compared with.

use crate::{
    diamond_versions::{self as versions, Body, Cause, Change, Found, Seen, Short},
    engine::host::{store::HostStore, test::TestHost},
    executor::Executor,
    store::{
        mem::MemBackend,
        native::NativeBackend,
        remote::RemoteStore,
        run::RunEnv,
        call::{StoreCall as C, StoreReply as R, WireStanding},
        server::{LoopLink, StoreServer, Tag},
        StoreBackend,
    },
    tools::{FileRoot, ToolContext, new_read_cache},
    workspace::Workspace,
};

use oxedyne_fe2o3_core::prelude::*;

use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, Barrier},
    thread::JoinHandle,
};

// ┌───────────────────────────────────────────────────────────────┐
// │ The harness                                                    │
// └───────────────────────────────────────────────────────────────┘

/// A fresh store backend holding the Diamond `d` ([`seed`]).
pub(crate) type Maker = fn() -> NativeBackend;

/// How the clients reach their store.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Harness {
    /// One server, every client bound to it: the design.
    Shared,
    /// A server per client, each over its own store (red control: per-process ledgers).
    PerClient,
    /// One server with its hold table switched off at `drop_run` (red control).
    HoldOff,
}

const D: &str = "d";
const CONDUCTOR: &str = "c";
const RUNS: [&str; 5] = [CONDUCTOR, "w1", "w2", "w3", "w4"];

fn s(v: &str) -> String { v.to_string() }

fn rt() -> tokio::runtime::Runtime {
    match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(rt)  => rt,
        Err(e)  => panic!("a runtime: {}", e),
    }
}

/// The Diamond `d` written into `b`: its metadata, its crystal and its page.
pub(crate) fn seed<B: StoreBackend>(b: &B) { seed_as(b, D) }

/// The Diamond `id` written into `b`, as [`seed`] writes `d`.
pub(crate) fn seed_as<B: StoreBackend>(b: &B, id: &str) {
    let files = [
        (fmt!("diamonds/{}/.daimond/meta.json", id),
            fmt!(r#"{{"name":"{}","crystal_version":0,"updated":0,"touched":0}}"#, id)),
        (fmt!("diamonds/{}/crystal.json", id), fmt!(r#"{{"title":"{}","sections":[]}}"#, id)),
        (fmt!("diamonds/{}/crystal.html", id), fmt!("<html><body>{}</body></html>", id)),
    ];
    rt().block_on(async {
        for (k, text) in files.iter() {
            if let Err(e) = b.write_file(k, text.as_bytes()).await {
                panic!("seeding {}: {}", k, e);
            }
        }
    });
}

/// A seeded Mem store.
pub(crate) fn mem() -> NativeBackend {
    let m = MemBackend::default();
    seed(&m);
    NativeBackend::Mem(m)
}

/// A seeded Mem store whose `write_file_if` compares nothing (the red of (5)).
pub(crate) fn mem_cas_off() -> NativeBackend {
    let m = MemBackend::default();
    seed(&m);
    m.cas_off();
    NativeBackend::Mem(m)
}

/// A seeded Ozone store of the case's own (D1j).
pub(crate) fn ozone() -> NativeBackend {
    let o = crate::store::ozone::tests::fresh_store("serial");
    seed(&o);
    NativeBackend::Ozone(o)
}

fn env(run: &str) -> RunEnv { env_on(run, D) }

/// The run `run`, granted the Diamond `id` alone.
fn env_on(run: &str, id: &str) -> RunEnv {
    RunEnv {
        run:        s(run),
        diamonds:   [s(id)].into_iter().collect(),
        folder_id:  None,
        known:      BTreeSet::new(),
        page:       s(run),
    }
}

/// The servers of one case, which serves each run, and each run's link, bound once.
struct World {
    servers: Vec<StoreServer>,
    of:      BTreeMap<String, usize>,
    links:   BTreeMap<String, LoopLink>,
}

impl World {
    fn new(maker: Maker, h: Harness) -> Self {
        let n = if h == Harness::PerClient { RUNS.len() } else { 1 };
        let mut servers = Vec::new();
        for _ in 0..n {
            let srv = match StoreServer::start(maker()) {
                Ok(srv) => srv,
                Err(e)  => panic!("the store server: {}", e),
            };
            if h == Harness::HoldOff {
                if let Err(e) = srv.hold_table_off() {
                    panic!("the hold table switch: {}", e);
                }
            }
            servers.push(srv);
        }
        let of = RUNS.iter().enumerate()
            .map(|(i, r)| (s(r), if h == Harness::PerClient { i } else { 0 }))
            .collect();
        let mut world = Self { servers, of, links: BTreeMap::new() };
        for run in RUNS {
            let link = match world.srv(run).bind(Tag::Run, env(run)) {
                Ok(l)   => l,
                Err(e)  => panic!("binding {}: {}", run, e),
            };
            world.links.insert(s(run), link);
        }
        world
    }

    fn srv(&self, run: &str) -> &StoreServer {
        match self.of.get(run).and_then(|i| self.servers.get(*i)) {
            Some(srv)   => srv,
            None        => panic!("no server for the run {}", run),
        }
    }

    fn link(&self, run: &str) -> LoopLink {
        match self.links.get(run) {
            Some(l) => l.clone(),
            None    => panic!("no link for the run {}", run),
        }
    }

    fn drop_run(&self, run: &str) {
        if let Err(e) = self.srv(run).drop_run(run) {
            panic!("dropping {}: {}", run, e);
        }
    }

    /// Where each of `d`'s windows on `run`'s server ends; open at `u64::MAX`.
    fn windows(&self, run: &str) -> Vec<u64> {
        match self.srv(run).probe(D) {
            Ok(p)   => p.windows,
            Err(e)  => panic!("the probe: {}", e),
        }
    }
}

/// `f` run on a thread of its own, with a runtime of its own, over its own port to the store.
fn client<T, F>(link: LoopLink, f: F) -> JoinHandle<T>
where
    T: Send + 'static,
    F: FnOnce(&RemoteStore<LoopLink>, &tokio::runtime::Runtime) -> T + Send + 'static,
{
    std::thread::spawn(move || {
        let st = RemoteStore::new(link);
        let rt = rt();
        f(&st, &rt)
    })
}

fn joined<T>(h: JoinHandle<T>, who: &str) -> T {
    match h.join() {
        Ok(v)   => v,
        Err(_)  => panic!("the client {} panicked", who),
    }
}

/// A step's signal between threads.
fn wait_for(rx: &flume::Receiver<()>, what: &str) {
    if rx.recv().is_err() {
        panic!("{} never came", what);
    }
}

fn turn_ctx() -> ToolContext<TestHost> {
    let dir = match oxedyne_fe2o3_test::scratch::scratch_dir("store_tests_serial") {
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

fn room(st: &RemoteStore<LoopLink>, path: &str) -> Result<bool, Short> {
    st.captured_room(D, path, &Found::Unread, Some(1), false, u64::MAX)
}

/// A note the client leaves on `path`, its room reserved first: whether both were granted.
fn noted(st: &RemoteStore<LoopLink>, rt: &tokio::runtime::Runtime, path: &str) -> Result<(), String> {
    if room(st, path) != Ok(true) {
        return Err(fmt!("the room for the note on {} was refused", path));
    }
    match rt.block_on(st.pend(D, path, b"what stood before", false, false)) {
        Ok(true)    => Ok(()),
        other       => Err(fmt!("the note on {} answered {:?}", path, other)),
    }
}

/// One turn end of the client: hold, drain, record, let go.  The captures it drained, its own and
/// the notes it adopted.
fn turn_end(st: &RemoteStore<LoopLink>, rt: &tokio::runtime::Runtime) -> Result<u32, String> {
    let ctx = turn_ctx();
    rt.block_on(async {
        let hold = match st.hold_versions(D).await {
            Ok(h)   => h,
            Err(e)  => return Err(fmt!("hold_versions: {}", e)),
        };
        let n = match st.drain_turn(&hold, D, &ctx).await {
            Ok(d)   => d.captured,
            Err(e)  => return Err(fmt!("drain_turn: {}", e)),
        };
        if let Err(e) = st.versions_record_held(&hold, D, None, Cause::Turn, "t", "serial").await {
            return Err(fmt!("versions_record_held: {}", e));
        }
        drop(hold);
        Ok(n)
    })
}

fn green(case: &str, r: Result<(), String>) {
    if let Err(e) = r {
        panic!("{}: {}", case, e);
    }
}

// ┌───────────────────────────────────────────────────────────────┐
// │ The cases                                                      │
// └───────────────────────────────────────────────────────────────┘

/// (1) Five clients race `captured_room` with 60 rooms already taken: exactly the cap,
/// [`versions::TURN_FILES_MAX`] (64), is granted in total.
pub(crate) fn race_captured_room_at_60(maker: Maker, h: Harness) -> Result<(), String> {
    let world = World::new(maker, h);
    let gate = Arc::new(Barrier::new(RUNS.len()));
    let mut hs = Vec::new();
    for run in RUNS {
        let gate = gate.clone();
        hs.push((run, client(world.link(run), move |st, _| {
            let mut before = 0;
            if run == CONDUCTOR {
                for n in 0..60 {
                    if room(st, &fmt!("/m/pre{}", n)) == Ok(true) {
                        before += 1;
                    }
                }
            }
            gate.wait();
            let won = (0..8).filter(|n| room(st, &fmt!("/m/{}/{}", run, n)) == Ok(true)).count();
            (before, won)
        })));
    }
    let mut before = 0;
    let mut total = 0;
    for (run, h) in hs {
        let (b, won) = joined(h, run);
        before += b;
        total += b + won;
    }
    if before != 60 {
        return Err(fmt!("{} rooms taken before the race, not 60", before));
    }
    if total != versions::TURN_FILES_MAX {
        return Err(fmt!("{} rooms granted in total, not {}", total, versions::TURN_FILES_MAX));
    }
    Ok(())
}

/// (2) Twenty concurrent `versions_record`s, four from each client: distinct, gap-free version
/// numbers, and every recorded body reads back from the conductor.
pub(crate) fn concurrent_versions_record(maker: Maker, h: Harness) -> Result<(), String> {
    let world = World::new(maker, h);
    let gate = Arc::new(Barrier::new(RUNS.len()));
    let mut hs = Vec::new();
    for run in RUNS {
        let gate = gate.clone();
        hs.push((run, client(world.link(run), move |st, rt| {
            gate.wait();
            let mut got = Vec::new();
            for k in 0..4 {
                let path = fmt!("/m/v/{}{}.txt", run, k);
                let after = fmt!("{} wrote {} at {}", run, k, path).into_bytes();
                let r = rt.block_on(st.versions_record(D, Cause::Turn, "t", "serial",
                    change(&path, b"", &after)));
                got.push(match r {
                    Ok(Some((v, _)))    => Ok((v, after)),
                    other               => Err(fmt!("{}'s record {} answered {:?}", run, k, other)),
                });
            }
            got
        })));
    }
    let mut versions_got = Vec::new();
    let mut bodies = Vec::new();
    for (run, h) in hs {
        for r in joined(h, run) {
            match r {
                Ok((v, after))  => { versions_got.push(v); bodies.push(after); }
                Err(e)          => return Err(e),
            }
        }
    }
    versions_got.sort();
    let first = versions_got.first().copied().unwrap_or(0);
    let want: Vec<u64> = (first..first + 20).collect();
    if versions_got != want {
        return Err(fmt!("the version numbers are not 20 distinct and gap-free: {:?}", versions_got));
    }
    let reader = client(world.link(CONDUCTOR), move |st, rt| {
        let mut missing = Vec::new();
        for after in bodies {
            match rt.block_on(st.versions_body(D, &versions::hash_of(&after))) {
                Ok(Some(b)) if b == after   => (),
                other                       => missing.push(fmt!("{:?}", other.map(|o|
                    o.map(|b| String::from_utf8_lossy(&b).to_string())))),
            }
        }
        missing
    });
    let missing = joined(reader, CONDUCTOR);
    if !missing.is_empty() {
        return Err(fmt!("{} bodies did not read back: {:?}", missing.len(), missing));
    }
    Ok(())
}

/// (3) A worker dropped mid-act, holding the rest of the cap, a note and an open window: before
/// the drop the conductor is refused a room and does not adopt the note; after it the room is
/// free, the window is closed as lost, and the conductor's turn end adopts the note.
pub(crate) fn drop_run_mid_act(maker: Maker, h: Harness) -> Result<(), String> {
    const W: &str = "w1";
    let world = World::new(maker, h);
    let (w_ready, w_readied) = flume::bounded(1);
    let (w_go, w_gone) = flume::bounded::<()>(1);
    let worker = client(world.link(W), move |st, rt| {
        let mut out = noted(st, rt, "/m/note.txt");
        for n in 1..versions::TURN_FILES_MAX {
            if out.is_ok() && room(st, &fmt!("/m/r{}", n)) != Ok(true) {
                out = Err(fmt!("{}'s room {} was refused", W, n));
            }
        }
        let window = rt.block_on(st.open_window(D, None));
        let _ = w_ready.send(());
        wait_for(&w_gone, "the end of the act");
        drop(window);
        out
    });
    wait_for(&w_readied, "the worker's act");

    let (c_go, c_went) = flume::bounded::<()>(1);
    let (c_done, c_did) = flume::bounded::<()>(1);
    let conductor = client(world.link(CONDUCTOR), move |st, rt| {
        let room_before = room(st, "/m/c.txt");
        let turn_before = turn_end(st, rt);
        let _ = c_done.send(());
        wait_for(&c_went, "the worker's drop");
        let room_after = room(st, "/m/c.txt");
        st.release(D, "/m/c.txt");
        let turn_after = turn_end(st, rt);
        (room_before, turn_before, room_after, turn_after)
    });
    wait_for(&c_did, "the conductor's first turn end");
    let windows_before = world.windows(W);
    world.drop_run(W);
    let windows_after = world.windows(W);
    let _ = c_go.send(());
    let (room_before, turn_before, room_after, turn_after) = joined(conductor, CONDUCTOR);
    let _ = w_go.send(());
    if let Err(e) = joined(worker, W) {
        return Err(e);
    }

    let mut wrong = Vec::new();
    if room_before != Err(Short::Count) {
        wrong.push(fmt!("before the drop the conductor's room answered {:?}", room_before));
    }
    if turn_before != Ok(0) {
        wrong.push(fmt!("before the drop the conductor's turn end drained {:?}", turn_before));
    }
    if windows_before != vec![u64::MAX] {
        wrong.push(fmt!("before the drop the windows were {:?}", windows_before));
    }
    if room_after != Ok(true) {
        wrong.push(fmt!("after the drop the conductor's room answered {:?}: the reservation stands",
            room_after));
    }
    if windows_after.len() != 1 || windows_after.first() == Some(&u64::MAX) {
        wrong.push(fmt!("after the drop the windows were {:?}: not closed as lost", windows_after));
    }
    if turn_after != Ok(1) {
        wrong.push(fmt!("after the drop the conductor's turn end drained {:?}, not the note",
            turn_after));
    }
    if wrong.is_empty() { Ok(()) } else { Err(wrong.join("; ")) }
}

/// (4) A live worker's note, its act over and its room let go, is not adopted by the conductor's
/// turn end: the worker's own turn end finds it still there.  With `shared`, the conductor's
/// turn also captures the note's path (4b, the D1s2a check rider).
fn live_note_kept(maker: Maker, h: Harness, w: &'static str, shared: bool) -> Result<(), String> {
    let world = World::new(maker, h);
    let path = if shared { "/m/shared.txt" } else { "/m/live.txt" };
    let (w_ready, w_readied) = flume::bounded(1);
    let (w_go, w_gone) = flume::bounded::<()>(1);
    let worker = client(world.link(w), move |st, rt| {
        let noted = noted(st, rt, path);
        st.release(D, path);
        let _ = w_ready.send(());
        wait_for(&w_gone, "the conductor's turn end");
        (noted, turn_end(st, rt))
    });
    wait_for(&w_readied, "the worker's note");
    let conductor = client(world.link(CONDUCTOR), move |st, rt| {
        if shared {
            st.capture(D, path, change(path, b"what stood before", b"the conductor's"));
        }
        turn_end(st, rt)
    });
    let turn_c = joined(conductor, CONDUCTOR);
    let _ = w_go.send(());
    let (noted, turn_w) = joined(worker, w);
    if let Err(e) = noted {
        return Err(e);
    }

    let mine = if shared { 1 } else { 0 };
    let mut wrong = Vec::new();
    if turn_c != Ok(mine) {
        wrong.push(fmt!("the conductor's turn end drained {:?}, not {} (its own alone)", turn_c,
            mine));
    }
    if turn_w != Ok(1) {
        wrong.push(fmt!("the worker's own turn end drained {:?}: its note was not kept", turn_w));
    }
    if wrong.is_empty() { Ok(()) } else { Err(wrong.join("; ")) }
}

/// (4) as [`live_note_kept`], on a path the conductor does not touch.
pub(crate) fn live_note_not_adopted(maker: Maker, h: Harness) -> Result<(), String> {
    live_note_kept(maker, h, "w2", false)
}

/// (4b) as [`live_note_kept`], on the path the conductor's turn captures.
pub(crate) fn live_note_on_a_shared_path_kept(maker: Maker, h: Harness) -> Result<(), String> {
    live_note_kept(maker, h, "w3", true)
}

/// (5) Two clients, each on its own thread with its own runtime, race `write_file_if` on the one
/// store, each expecting the file absent, for each of [`RACE_ROUNDS`] files: exactly one wins
/// each, and the file holds the winner's bytes.
pub(crate) fn write_file_if_race_one_wins(maker: Maker) -> Result<(), String> {
    let b = maker();
    let gate = Arc::new(Barrier::new(2));
    let mut hs = Vec::new();
    for who in ["x", "y"] {
        let (b, gate) = (b.clone(), gate.clone());
        hs.push((who, std::thread::spawn(move || {
            let rt = rt();
            let mut won = Vec::new();
            for n in 0..RACE_ROUNDS {
                let k = fmt!("diamonds/d/race/{}.txt", n);
                let bytes = fmt!("{} wrote {}", who, n).into_bytes();
                gate.wait();
                won.push(match rt.block_on(b.write_file_if(&k, &bytes, Some(&Seen::Absent))) {
                    Ok(None)    => Ok(true),
                    Ok(Some(_)) => Ok(false),
                    Err(e)      => Err(fmt!("{}'s write of {}: {}", who, k, e)),
                });
            }
            won
        })));
    }
    let mut wins: Vec<Vec<&str>> = vec![Vec::new(); RACE_ROUNDS];
    for (who, h) in hs {
        for (n, r) in joined(h, who).into_iter().enumerate() {
            match r {
                Ok(true)    => if let Some(w) = wins.get_mut(n) { w.push(who) },
                Ok(false)   => (),
                Err(e)      => return Err(e),
            }
        }
    }
    let rt = rt();
    let mut wrong = Vec::new();
    for (n, w) in wins.iter().enumerate() {
        let k = fmt!("diamonds/d/race/{}.txt", n);
        match w.as_slice() {
            [who] => match rt.block_on(b.read_file(&k)) {
                Ok(got) if got == fmt!("{} wrote {}", who, n).into_bytes() => (),
                other => wrong.push(fmt!("{} holds {:?}, not {}'s bytes", k,
                    other.map(|g| String::from_utf8_lossy(&g).to_string()), who)),
            },
            _ => wrong.push(fmt!("{} was won by {:?}", k, w)),
        }
    }
    if wrong.is_empty() { Ok(()) } else { Err(fmt!("{} of {} rounds: {}", wrong.len(), RACE_ROUNDS,
        wrong.first().cloned().unwrap_or_default())) }
}

const RACE_ROUNDS: usize = 32;

/// A store server over `b`, with each rule in `off` switched off.
fn server_of(b: NativeBackend, off: &[&'static str]) -> StoreServer {
    let srv = match StoreServer::start(b) {
        Ok(srv) => srv,
        Err(e)  => panic!("the store server: {}", e),
    };
    for rule in off {
        if let Err(e) = srv.rule_off(rule) {
            panic!("switching {} off: {}", rule, e);
        }
    }
    srv
}

fn bound(srv: &StoreServer, env: RunEnv) -> LoopLink {
    let run = env.run.clone();
    match srv.bind(Tag::Run, env) {
        Ok(l)   => l,
        Err(e)  => panic!("binding {}: {}", run, e),
    }
}

/// (6) The conductor, granted `d` alone, records into `e`, which the store holds and a second
/// run is granted: refused, and the second run finds no body of the record in `e`.
pub(crate) fn cross_diamond_call_refused(maker: Maker, off: &[&'static str]) -> Result<(), String> {
    const E: &str = "e";
    let b = maker();
    seed_as(&b, E);
    let srv = server_of(b, off);
    let after = b"the conductor's, into e".to_vec();
    let body = after.clone();
    let c = client(bound(&srv, env(CONDUCTOR)), move |st, rt| {
        let rec = rt.block_on(st.versions_record(E, Cause::Turn, "t", "serial",
            change("/m/e.txt", b"", &body)));
        let room = room_on(st, E, "/m/e.txt");
        (rec.is_err(), fmt!("{:?}", rec.map(|r| r.map(|(v, _)| v))), room)
    });
    let (refused, said, room) = joined(c, CONDUCTOR);
    let x = client(bound(&srv, env_on("x", E)), move |st, rt| {
        rt.block_on(st.versions_body(E, &versions::hash_of(&after)))
    });
    let found = joined(x, "x");
    srv.stop();
    let mut wrong = Vec::new();
    if !refused {
        wrong.push(fmt!("the record into e answered {}", said));
    }
    if room == Ok(true) {
        wrong.push(s("a room in e was granted"));
    }
    if !matches!(found, Ok(None)) {
        wrong.push(fmt!("e's run found the body: {:?}", found.map(|o| o.map(|b| b.len()))));
    }
    if wrong.is_empty() { Ok(()) } else { Err(wrong.join("; ")) }
}

fn room_on(st: &RemoteStore<LoopLink>, id: &str, path: &str) -> Result<bool, Short> {
    st.captured_room(id, path, &Found::Unread, Some(1), false, u64::MAX)
}

/// A staging call's answer: `Ok` where the store took it.
fn staged(link: &LoopLink, call: C) -> Result<(), String> {
    match link.call_blocking(&call) {
        Ok(R::TurnStanding(o)) | Ok(R::TurnStands(o)) => o.map_err(|e| e.to_string()),
        other => Err(fmt!("store.{} answered {:?}", call.name(), other.map(|r| r.name()))),
    }
}

fn snapshot(link: &LoopLink) -> Result<Vec<(String, Seen)>, String> {
    match link.call_blocking(&C::TurnWants { id: s(D) }) {
        Ok(R::TurnWants(Ok(p))) => Ok(p.wants.own),
        other => Err(fmt!("turn_wants answered {:?}", other.map(|r| r.name()))),
    }
}

fn standing(path: &str, seen: Seen) -> C {
    C::TurnStanding { id: s(D), path: s(path), seen, standing: WireStanding::Unknown, stamp: None }
}

const CAPTURED: &str = "notes/c.md";
const BEFORE: &[u8] = b"what stood before the act";
const AFTER: &[u8] = b"what the act left";

/// The conductor's capture of [`CAPTURED`], made through its own port, and its snapshot.
fn captured_and_snapshot(st: &RemoteStore<LoopLink>, link: &LoopLink) -> Result<(), String> {
    st.capture(D, CAPTURED, change(CAPTURED, BEFORE, AFTER));
    let own = match snapshot(link) {
        Ok(own) => own,
        Err(e)  => return Err(e),
    };
    if own != vec![(s(CAPTURED), Seen::of(Some(AFTER)))] {
        return Err(fmt!("the conductor's snapshot named {:?}", own));
    }
    Ok(())
}

/// (7) A path the run's own snapshot does not name is refused at `turn_standing`: one no act
/// touched, by the conductor, and the conductor's captured path, by a worker on its own thread
/// whose snapshot is its own.
pub(crate) fn invented_staged_path_refused(maker: Maker, off: &[&'static str]) -> Result<(), String> {
    let srv = server_of(maker(), off);
    let (cl, wl) = (bound(&srv, env(CONDUCTOR)), bound(&srv, env("w1")));
    let kept = cl.clone();
    let c = client(cl.clone(), move |st, _| captured_and_snapshot(st, &cl));
    let ready = joined(c, CONDUCTOR);
    let w = client(wl.clone(), move |_, _| {
        let own = snapshot(&wl);
        (own, staged(&wl, standing(CAPTURED, Seen::of(Some(AFTER)))))
    });
    let (w_own, w_took) = joined(w, "w1");
    let invented = staged(&kept, standing("notes/x.md", Seen::Unread));
    srv.stop();
    if let Err(e) = ready {
        return Err(e);
    }
    let mut wrong = Vec::new();
    if w_own != Ok(Vec::new()) {
        wrong.push(fmt!("the worker's snapshot named {:?}", w_own));
    }
    if w_took.is_ok() {
        wrong.push(s("the worker staged the conductor's path"));
    }
    if invented.is_ok() {
        wrong.push(s("the conductor staged a path no act touched"));
    }
    if wrong.is_empty() { Ok(()) } else { Err(wrong.join("; ")) }
}

/// (8) A `Seen` of the captured path that is not the one its snapshot names, the bytes that stood
/// before the act, is not honoured: refused through `turn_stands` and through `turn_standing`,
/// and the snapshot's own `Seen` then taken.
pub(crate) fn stale_seen_not_honoured(maker: Maker, off: &[&'static str]) -> Result<(), String> {
    let srv = server_of(maker(), off);
    let cl = bound(&srv, env(CONDUCTOR));
    let c = client(cl.clone(), move |st, _| -> Result<Vec<String>, String> {
        if let Err(e) = captured_and_snapshot(st, &cl) {
            return Err(e);
        }
        let stale = Seen::of(Some(BEFORE));
        let mut wrong = Vec::new();
        if staged(&cl, C::TurnStands { id: s(D), stands: vec![(s(CAPTURED), stale.clone())] })
            .is_ok()
        {
            wrong.push(s("turn_stands took the stale seen"));
        }
        if staged(&cl, standing(CAPTURED, stale)).is_ok() {
            wrong.push(s("turn_standing took the stale seen"));
        }
        if let Err(e) = staged(&cl, C::TurnStands { id: s(D),
            stands: vec![(s(CAPTURED), Seen::of(Some(AFTER)))] })
        {
            wrong.push(fmt!("the snapshot's own seen was refused: {}", e));
        }
        Ok(wrong)
    });
    let wrong = joined(c, CONDUCTOR);
    srv.stop();
    let wrong = match wrong {
        Ok(w)   => w,
        Err(e)  => return Err(e),
    };
    if wrong.is_empty() { Ok(()) } else { Err(wrong.join("; ")) }
}

// ┌───────────────────────────────────────────────────────────────┐
// │ On Mem                                                         │
// └───────────────────────────────────────────────────────────────┘

#[test]
fn race_captured_room_at_60_mem() {
    green("(1)", race_captured_room_at_60(mem, Harness::Shared));
}

#[test]
fn concurrent_versions_record_mem() {
    green("(2)", concurrent_versions_record(mem, Harness::Shared));
}

#[test]
fn drop_run_mid_act_mem() {
    green("(3)", drop_run_mid_act(mem, Harness::Shared));
}

#[test]
fn live_note_not_adopted_mem() {
    green("(4)", live_note_not_adopted(mem, Harness::Shared));
}

#[test]
fn live_note_on_a_shared_path_kept_mem() {
    green("(4b)", live_note_on_a_shared_path_kept(mem, Harness::Shared));
}

#[test]
fn write_file_if_race_one_wins_mem() {
    green("(5)", write_file_if_race_one_wins(mem));
}

#[test]
fn cross_diamond_call_refused_mem() {
    green("(6)", cross_diamond_call_refused(mem, &[]));
}

#[test]
fn invented_staged_path_refused_mem() {
    green("(7)", invented_staged_path_refused(mem, &[]));
}

#[test]
fn stale_seen_not_honoured_mem() {
    green("(8)", stale_seen_not_honoured(mem, &[]));
}

/// A case's answer under a red control, logged in one line.
fn logged(control: &str, case: &str, r: Result<(), String>) -> bool {
    match &r {
        Ok(())  => eprintln!("GREEN {} {}", control, case),
        Err(e)  => eprintln!("RED {} {}: {}", control, case, e),
    }
    r.is_err()
}

#[test]
fn per_client_stores_fail_1_and_3_mem() {
    let c = "per-client";
    let red1 = logged(c, "(1)", race_captured_room_at_60(mem, Harness::PerClient));
    let _ = logged(c, "(2)", concurrent_versions_record(mem, Harness::PerClient));
    let red3 = logged(c, "(3)", drop_run_mid_act(mem, Harness::PerClient));
    let _ = logged(c, "(4)", live_note_not_adopted(mem, Harness::PerClient));
    let _ = logged(c, "(4b)", live_note_on_a_shared_path_kept(mem, Harness::PerClient));
    assert!(red1, "(1) passed with a store per client");
    assert!(red3, "(3) passed with a store per client");
}

#[test]
fn hold_table_off_fails_3_mem() {
    assert!(logged("hold-off", "(3)", drop_run_mid_act(mem, Harness::HoldOff)),
        "(3) passed with the hold table off");
}

#[test]
fn cas_off_fails_5_mem() {
    assert!(logged("cas-off", "(5)", write_file_if_race_one_wins(mem_cas_off)),
        "(5) passed with Mem's compare off");
}

#[test]
fn scope_off_fails_6_mem() {
    assert!(logged("scope-off", "(6)", cross_diamond_call_refused(mem, &["scope"])),
        "(6) passed with the scope rule off");
}

#[test]
fn wanted_off_fails_7_mem() {
    assert!(logged("wanted-off", "(7)", invented_staged_path_refused(mem, &["wanted"])),
        "(7) passed with the wanted rule off");
}

#[test]
fn seen_off_fails_8_mem() {
    assert!(logged("seen-off", "(8)", stale_seen_not_honoured(mem, &["seen"])),
        "(8) passed with the seen rule off");
}

// ┌───────────────────────────────────────────────────────────────┐
// │ On Ozone                                                       │
// └───────────────────────────────────────────────────────────────┘

#[test]
fn race_captured_room_at_60_ozone() {
    green("(1)", race_captured_room_at_60(ozone, Harness::Shared));
}

#[test]
fn concurrent_versions_record_ozone() {
    green("(2)", concurrent_versions_record(ozone, Harness::Shared));
}

#[test]
fn drop_run_mid_act_ozone() {
    green("(3)", drop_run_mid_act(ozone, Harness::Shared));
}

#[test]
fn live_note_not_adopted_ozone() {
    green("(4)", live_note_not_adopted(ozone, Harness::Shared));
}

#[test]
fn live_note_on_a_shared_path_kept_ozone() {
    green("(4b)", live_note_on_a_shared_path_kept(ozone, Harness::Shared));
}

#[test]
fn write_file_if_race_one_wins_ozone() {
    green("(5)", write_file_if_race_one_wins(ozone));
}

#[test]
fn cross_diamond_call_refused_ozone() {
    green("(6)", cross_diamond_call_refused(ozone, &[]));
}

#[test]
fn invented_staged_path_refused_ozone() {
    green("(7)", invented_staged_path_refused(ozone, &[]));
}

#[test]
fn stale_seen_not_honoured_ozone() {
    green("(8)", stale_seen_not_honoured(ozone, &[]));
}

// The red controls whose switch is the server's, not the backend's, over Ozone too.  (5)'s red
// switches Mem's own compare off, so it has no Ozone twin.

#[test]
fn per_client_stores_fail_1_and_3_ozone() {
    let c = "per-client ozone";
    assert!(logged(c, "(1)", race_captured_room_at_60(ozone, Harness::PerClient)),
        "(1) passed with a store per client");
    assert!(logged(c, "(3)", drop_run_mid_act(ozone, Harness::PerClient)),
        "(3) passed with a store per client");
}

#[test]
fn hold_table_off_fails_3_ozone() {
    assert!(logged("hold-off ozone", "(3)", drop_run_mid_act(ozone, Harness::HoldOff)),
        "(3) passed with the hold table off");
}

#[test]
fn scope_off_fails_6_ozone() {
    assert!(logged("scope-off ozone", "(6)", cross_diamond_call_refused(ozone, &["scope"])),
        "(6) passed with the scope rule off");
}

#[test]
fn wanted_off_fails_7_ozone() {
    assert!(logged("wanted-off ozone", "(7)", invented_staged_path_refused(ozone, &["wanted"])),
        "(7) passed with the wanted rule off");
}

#[test]
fn seen_off_fails_8_ozone() {
    assert!(logged("seen-off ozone", "(8)", stale_seen_not_honoured(ozone, &["seen"])),
        "(8) passed with the seen rule off");
}
