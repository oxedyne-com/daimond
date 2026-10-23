//! LIMITS and HIST-SAFE on the runner (d1_plan §9.2 D1x2, d1rest_plan D1x2a): what a restore and
//! a door may and may not do to the person's folder, over a fake `UserLink` on a test folder.
//!
//! Every case runs once over the memory store and once over an Ozone store of its own, from its
//! `_mem` and `_ozone` wrappers at the foot of this file, and once more with one rule switched off
//! ([`diamond::switch_off`], or the server's `rule_off`), to show its red:
//!
//! 1. A restore's open and close write no byte in the folder, only the store.  Red: `own_only`,
//!    the close putting back the person's files through a user root.
//! 2. A door's entry with no `DoorEnv` is refused, and leaves the store as it was.  Red:
//!    `door_guard`.
//! 3. A path a window credited is never recorded `Gone` where it could not be read.  Red:
//!    `unread_gone`.
//! 4. A stalled `UserLink` is `Unseen` at the door's deadline, the Diamond's own files beside it
//!    are served, and the store answers on afterwards.  Red: `deadline`, which hangs.
//! 5. A ticketed restore of a version whose body the store holds, end to end over a door's link:
//!    the person's file and the restore's record are byte-equal to the version.  Red: the
//!    server's `held_stage`, a `Held` body answered with nothing staged; and its `restore_hold`,
//!    the door child's uploads not passed the open restore's version hold, so they wait it out.

use crate::{
    diamond_versions::{Act, Body, Cause, Change, Found},
    engine::host::store::HostStore,
    rating::Author,
    store::{
        diamond::{self, Plan},
        door::{DirLink, DoorEnv, Link},
        install,
        mem::MemBackend,
        native::NativeBackend,
        own,
        remote::RemoteStore,
        run::RunEnv,
        server::{StoreServer, Tag, TestRestore},
    },
};

use oxedyne_fe2o3_core::prelude::*;

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    time::Duration,
};

/// The short deadline a stalled door is given here in place of the 20 s one.
const TEST_DEADLINE: Duration = Duration::from_millis(50);

/// How long a case waits before it calls the store hung.
const HUNG: Duration = Duration::from_secs(10);

#[derive(Clone, Copy, Debug)]
enum Over {
    Mem,
    Ozone,
}

/// A fresh, empty backend of kind `o`: the memory store, or a new Ozone store of the case's own.
fn backend(o: Over) -> NativeBackend {
    match o {
        Over::Mem   => NativeBackend::Mem(MemBackend::default()),
        Over::Ozone => NativeBackend::Ozone(crate::store::ozone::tests::fresh_store("limits")),
    }
}

fn s(v: &str) -> String { v.to_string() }

fn env(page: &str, id: &str) -> RunEnv {
    RunEnv {
        run:        s(page),
        diamonds:   [s(id)].into_iter().collect(),
        folder_id:  None,
        known:      Default::default(),
        page:       s(page),
    }
}

fn ok<V>(what: &str, got: Outcome<V>) -> V {
    match got {
        Ok(v)  => v,
        Err(e) => panic!("{}: {}", what, e),
    }
}

fn rt() -> tokio::runtime::Runtime {
    match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(rt)  => rt,
        Err(e)  => panic!("a runtime: {}", e),
    }
}

/// A folder of the person's, with its `notes`, from [`store::test_dir`](crate::store::test_dir).
fn person(name: &str) -> PathBuf {
    let dir = crate::store::test_dir(name);
    if let Err(e) = std::fs::create_dir_all(dir.join("notes")) {
        panic!("the test folder {:?}: {}", dir, e);
    }
    dir
}

fn put(dir: &Path, rel: &str, body: &[u8]) {
    if let Err(e) = std::fs::write(dir.join(rel), body) {
        panic!("writing {}: {}", rel, e);
    }
}

/// Every file under `dir` with its bytes, and every directory: what a write would change.
fn folder_bytes(dir: &Path) -> BTreeMap<String, Option<Vec<u8>>> {
    let mut out = BTreeMap::new();
    let mut todo = vec![dir.to_path_buf()];
    while let Some(at) = todo.pop() {
        let entries = match std::fs::read_dir(&at) {
            Ok(e)  => e,
            Err(e) => panic!("listing {:?}: {}", at, e),
        };
        for entry in entries.flatten() {
            let p = entry.path();
            let rel = p.strip_prefix(dir).map(|r| r.to_string_lossy().into_owned())
                .unwrap_or_default();
            if p.is_dir() {
                out.insert(rel, None);
                todo.push(p);
            } else {
                out.insert(rel, std::fs::read(&p).ok());
            }
        }
    }
    out
}

fn door_on(id: &str, dir: &Path) -> DoorEnv {
    DoorEnv::new(id, Link::Dir(DirLink::new(dir.to_path_buf())))
}

fn change(path: &str, after: Body) -> Change {
    Change {
        path:    s(path),
        after,
        before:  None,
        found:   Found::Unread,
        carried: None,
        mark:    false,
        refused: None,
        wiped:   false,
        folder:  diamond::folder_of(path),
        by:      None,
        door:    false,
    }
}

/// A body long enough to be a body of its own, distinct by `n`.
fn body_of(n: u8) -> Vec<u8> {
    let mut b = fmt!("version {} of the person's note. ", n).into_bytes();
    b.resize(96, b'0' + n);
    b
}

/// A fresh Diamond `id` with one version holding `rows`: the version's number.
async fn recorded(id: &str, rows: Vec<Change>) -> u64 {
    let got = ok("create", diamond::create_at("t", id).await);
    assert_eq!(got, id, "created at its id");
    match ok("record", diamond::versions_record(id, Cause::Turn, "", "", rows).await) {
        Some((v, _)) => v,
        None         => panic!("the fixture recorded nothing"),
    }
}

// ── (1) A restore's open and close write no byte in the folder ───────────────────────────────

/// A whole-version restore opened and closed through a door: the person's folder is byte for byte
/// as it stood, and the Diamond's own file is put back in the store.  His file is the door's to
/// act on, never the close's.
async fn a_restore_writes_no_byte_in_the_folder(o: Over) -> Outcome<()> {
    let _ = install(backend(o));
    let id = "l1";
    let note = "notes/a.md";
    let mine = fmt!("{}/own.md", diamond::diamond_dir(id));
    let dir = person(&fmt!("l1-{:?}", o));
    put(&dir, note, b"his first");
    let got = env("p", id).scope(door_on(id, &dir).scope(async {
        ok("own", own::write_file(&mine, b"own first").await);
        let at = recorded(id, vec![
            change(note, Body::Held(b"his first".to_vec())),
            change(&mine, Body::Held(b"own first".to_vec())),
        ]).await;
        put(&dir, note, b"his second, saved since");
        ok("own", own::write_file(&mine, b"own second").await);
        let before = folder_bytes(&dir);
        let opened = res!(diamond::versions_restore_open(id, Plan::At(at, None, None)).await);
        let at_open = folder_bytes(&dir);
        let closed = diamond::versions_restore_close(id, opened.ticket).await;
        if closed.is_err() {
            let _ = diamond::versions_restore_end(id, opened.ticket).await;
        }
        let closed = res!(closed);
        let at_close = folder_bytes(&dir);
        let own_now = res!(own::read_file(&mine).await);
        Ok((before, at_open, at_close, own_now, closed.restored))
    })).await;
    let _ = install(NativeBackend::Closed);
    let _ = std::fs::remove_dir_all(&dir);
    let (before, at_open, at_close, own_now, restored) = res!(got);
    assert_eq!(before.get(note), Some(&Some(b"his second, saved since".to_vec())), "the fixture");
    assert_eq!(at_open, before, "the open wrote in the folder");
    assert_eq!(at_close, before, "the close wrote in the folder");
    assert_eq!(own_now, b"own first".to_vec(), "the store's own file was not put back");
    assert!(!restored.iter().any(|p| p == note), "the close restored his file: {:?}", restored);
    Ok(())
}

// ── (2) A door's entry with no DoorEnv is refused ────────────────────────────────────────────

/// With no door in scope a restore does not open, a restore opened inside a door does not close
/// outside it (and stays open, to end inside it), and a mark is not made: the store's files are
/// as they were.
async fn a_door_entry_with_no_door_is_refused(o: Over) -> Outcome<()> {
    let _ = install(backend(o));
    let id = "l2";
    let mine = fmt!("{}/own.md", diamond::diamond_dir(id));
    let dir = person(&fmt!("l2-{:?}", o));
    let got = env("p", id).scope(async {
        let at = door_on(id, &dir).scope(async {
            ok("own", own::write_file(&mine, b"own first").await);
            let at = recorded(id, vec![change(&mine, Body::Held(b"own first".to_vec()))]).await;
            ok("own", own::write_file(&mine, b"own second").await);
            at
        }).await;
        let store_before = res!(own::list_dir(&diamond::diamond_dir(id)).await);
        let opened = diamond::versions_restore_open(id, Plan::At(at, None, None)).await;
        let open_refused = match opened {
            Err(e) => crate::store::door::is_no_door(&e),
            Ok(o)  => {
                let _ = diamond::versions_restore_end(id, o.ticket).await;
                false
            }
        };
        let t = res!(door_on(id, &dir).scope(
            diamond::versions_restore_open(id, Plan::At(at, None, None))).await).ticket;
        let close_refused = match diamond::versions_restore_close(id, t).await {
            Err(e) => crate::store::door::is_no_door(&e),
            Ok(_)  => false,
        };
        let still_open = diamond::restore_store(t).is_some();
        let _ = door_on(id, &dir).scope(diamond::versions_restore_end(id, t)).await;
        diamond::mark_dirty_before(id, "notes/a.md").await;
        let marked = diamond::drain_dirty(id).len();
        let store_after = res!(own::list_dir(&diamond::diamond_dir(id)).await);
        let own_now = res!(own::read_file(&mine).await);
        Ok((open_refused, close_refused, still_open, marked, store_before == store_after, own_now))
    }).await;
    let _ = install(NativeBackend::Closed);
    let _ = std::fs::remove_dir_all(&dir);
    let (open_refused, close_refused, still_open, marked, same, own_now) = res!(got);
    assert!(open_refused, "a restore opened with no door");
    assert!(close_refused, "a restore closed with no door");
    assert!(still_open, "the refused close took the restore off the book");
    assert_eq!(marked, 0, "a mark made with no door");
    assert!(same, "the store's files changed with no door");
    assert_eq!(own_now, b"own second".to_vec(), "the Diamond's own file was put back with no door");
    Ok(())
}

// ── (3) A credited window path is never recorded Gone unread ─────────────────────────────────

fn by(run: &str) -> Author {
    Author { role: s("worker"), run: s(run), ..Default::default() }
}

/// A path a window credited, drained where it cannot be read: with no door, through a door whose
/// read of it fails, and through a stalled door.  Each is `Unseen` and recorded as no deletion;
/// the control, a path the door reads as absent, is `Gone`.
async fn a_credited_window_path_is_never_recorded_gone(o: Over) -> Outcome<()> {
    let _ = install(backend(o));
    let id = "l3";
    let note = "notes/a.md";
    let none = "notes/none.md";
    let dir = person(&fmt!("l3-{:?}", o));
    let _ = std::fs::create_dir_all(dir.join(note));    // a read of it fails: EISDIR
    let got = env("p", id).scope(async {
        door_on(id, &dir).scope(recorded(id, vec![change("notes/b.md",
            Body::Held(b"b".to_vec()))])).await;
        let drain = |path: &'static str| async move {
            diamond::test_window(id, Some(by("w1")), path);
            diamond::drain_windows(id, &[]).await
        };
        let unread = vec![
            ("no door", drain(note).await),
            ("a failed read", door_on(id, &dir).scope(drain(note)).await),
            ("a stalled door", DoorEnv::new(id, Link::Stalled).with_deadline(TEST_DEADLINE)
                .scope(drain(note)).await),
        ];
        let absent = door_on(id, &dir).scope(drain(none)).await;
        let mut rows: Vec<Change> = Vec::new();
        for (_, ch) in unread.iter() {
            rows.extend(ch.iter().cloned());
        }
        let _ = door_on(id, &dir).scope(
            diamond::versions_record(id, Cause::Turn, "", "", rows)).await;
        let gone_rows: Vec<String> = diamond::versions_manifests(id).await.into_iter()
            .flat_map(|(v, m)| m.files.into_iter()
                .filter(|e| e.path == note && e.gone)
                .map(move |e| fmt!("version {}: {}", v, e.path)))
            .collect();
        let unread: Vec<(&str, Vec<(String, Body)>)> = unread.into_iter()
            .map(|(w, ch)| (w, ch.into_iter().map(|c| (c.path, c.after)).collect()))
            .collect();
        let absent: Vec<(String, Body)> = absent.into_iter().map(|c| (c.path, c.after)).collect();
        (unread, absent, gone_rows)
    }).await;
    let _ = install(NativeBackend::Closed);
    let _ = std::fs::remove_dir_all(&dir);
    let (unread, absent, gone_rows) = got;
    for (what, changes) in unread.iter() {
        assert_eq!(changes, &vec![(s(note), Body::Unseen)], "{}: the credited path", what);
    }
    assert!(gone_rows.is_empty(), "an unread path recorded as deleted: {:?}", gone_rows);
    assert_eq!(absent, vec![(s(none), Body::Gone)], "the control: absence is Gone");
    Ok(())
}

// ── (4) A stalled UserLink: Unseen, siblings served, no poison ───────────────────────────────

/// Through a stalled door a person's file is `Unseen` at the deadline, the Diamond's own file
/// read beside it is served, and the store answers on: a record of what was read lands, and a
/// door on the folder then reads his file.
async fn a_stalled_link_is_unseen_and_the_rest_is_served(o: Over) -> Outcome<()> {
    let _ = install(backend(o));
    let id = "l4";
    let note = "notes/a.md";
    let mine = fmt!("{}/own.md", diamond::diamond_dir(id));
    let dir = person(&fmt!("l4-{:?}", o));
    put(&dir, note, b"his");
    let got = tokio::time::timeout(HUNG, env("p", id).scope(async {
        door_on(id, &dir).scope(async {
            ok("own", own::write_file(&mine, b"own").await);
            recorded(id, vec![change(&mine, Body::Held(b"own".to_vec()))]).await;
        }).await;
        ok("own", own::write_file(&mine, b"own, edited").await);
        let stalled = DoorEnv::new(id, Link::Stalled).with_deadline(TEST_DEADLINE);
        let read = stalled.scope(diamond::versions_changes(id, &[s(note), mine.clone()])).await;
        let after: Vec<(String, Body)> = read.iter().map(|c| (c.path.clone(), c.after.clone()))
            .collect();
        let rec = door_on(id, &dir).scope(
            diamond::versions_record(id, Cause::Turn, "", "", read)).await;
        let later = door_on(id, &dir).scope(diamond::versions_changes(id, &[s(note)])).await;
        let later: Vec<(String, Body)> = later.into_iter().map(|c| (c.path, c.after)).collect();
        (after, rec.map(|r| r.is_some()), later)
    })).await;
    let _ = install(NativeBackend::Closed);
    let _ = std::fs::remove_dir_all(&dir);
    let (after, recorded, later) = match got {
        Ok(g)  => g,
        Err(_) => return Err(err!("a stalled link hung the store past {:?}", HUNG; IO, Thread)),
    };
    assert_eq!(after, vec![(s(note), Body::Unseen), (mine.clone(),
        Body::Held(b"own, edited".to_vec()))], "(his file unseen, the sibling served)");
    assert_eq!(res!(recorded), true, "the record after the stall");
    assert_eq!(later, vec![(s(note), Body::Held(b"his".to_vec()))], "a read after the stall");
    Ok(())
}

// ── (5) A ticketed restore of a stored (Held) version, end to end ────────────────────────────

/// The parent opens a one-file restore of a version whose body the store holds, on the store's
/// thread inside a door; the door child, over its own link, routes the act, reads the version's
/// body, keeps what stands, writes the file and says what landed; the parent closes.  His file
/// and the restore's record are the version's bytes exactly.
fn a_ticketed_restore_of_a_held_version_lands(o: Over, red: Option<&'static str>) -> Outcome<()> {
    let id = "l5";
    let note = "notes/a.md";
    let (v1, v2) = (body_of(1), body_of(2));
    let dir = person(&fmt!("l5-{:?}-{}", o, red.unwrap_or("green")));
    put(&dir, note, &v1);
    let b = backend(o);
    let _ = install(b.clone());
    let at = rt().block_on(env("t", id).scope(door_on(id, &dir).scope(
        recorded(id, vec![change(note, Body::Held(v1.clone()))]))));
    let _ = install(NativeBackend::Closed);
    put(&dir, note, &v2);
    let srv = res!(StoreServer::start(b.clone()));
    if let Some(rule) = red {
        res!(srv.rule_off(rule));
    }
    let landed = (|| {
        let (ticket, _, _) = res!(srv.restore(TestRestore::Open { id: s(id),
            plan: Plan::At(at, Some(s(note)), None), dir: dir.clone() }));
        let link = res!(srv.bind(Tag::Door, env("door", id)));
        let child = RemoteStore::new(link);
        let acted = rt().block_on(async {
            let act = child.restore_route(ticket, note, note, Some(&v2), Some(&v1));
            if act != Act::Go {
                return Err(err!("the act was routed {:?}, not Go", act; Invalid, Input));
            }
            let body = match res!(child.versions_body(id, &crate::diamond_versions::hash_of(&v1))
                .await)
            {
                Some(b) => b,
                None    => return Err(err!("the version's body was not served"; Missing, Data)),
            };
            res!(child.restore_keep(ticket, note, Some(&v2), false).await);
            put(&dir, note, &body);
            child.restore_landed(ticket, Change { before: Some(crate::diamond_versions::Prior::Held(v2.clone())), door: true,
                ..change(note, Body::Held(body)) });
            Ok(())
        });
        drop(child);
        let closed = srv.restore(TestRestore::Close { id: s(id), ticket, dir: dir.clone() });
        res!(acted);
        closed
    })();
    srv.stop();
    let (_, recorded, restored) = res!(landed);
    let _ = install(b);
    let rows = rt().block_on(async {
        let mut rows = Vec::new();
        if let Some(v) = recorded {
            for (n, m) in diamond::versions_manifests(id).await.into_iter() {
                if n != v {
                    continue;
                }
                for e in m.files.into_iter().filter(|e| e.path == note) {
                    rows.push(diamond::versions_body(id, &e.hash).await);
                }
            }
        }
        rows
    });
    let _ = install(NativeBackend::Closed);
    let his = std::fs::read(dir.join(note)).ok();
    let _ = std::fs::remove_dir_all(&dir);
    if !restored.iter().any(|p| p == note) {
        return Err(err!("the close did not restore {}: {:?}", note, restored; Missing, Data));
    }
    if rows.len() != 1 {
        return Err(err!("the restore's record holds {} rows for {}", rows.len(), note;
            Missing, Data));
    }
    let row = match rows.into_iter().next() {
        Some(Ok(Some(b))) => b,
        other             => return Err(err!("the recorded body: {:?}", other.map(|r| r.map(|b|
            b.map(|b| b.len()))); Missing, Data)),
    };
    assert_eq!(row, v1, "the restore's record is not the version's bytes");
    assert_eq!(his, Some(v1), "his file is not the version's bytes");
    Ok(())
}

// ┌───────────────────────────────────────────────────────────────┐
// │ Every case over Mem and over Ozone, and each red               │
// └───────────────────────────────────────────────────────────────┘

/// `case` over `o` on a thread of its own, with `rule` off there where one is given: `Ok` where
/// it passed, else what it said or that it panicked.
fn on_a_thread<F, Fut>(o: Over, rule: Option<&'static str>, case: F) -> Result<(), String>
where
    F: Fn(Over) -> Fut + Send + Sync,
    Fut: std::future::Future<Output = Outcome<()>>,
{
    std::thread::scope(|sc| {
        let ran = sc.spawn(|| {
            diamond::switch_off(rule);
            let got = rt().block_on(case(o));
            let _ = install(NativeBackend::Closed);
            got
        });
        match ran.join() {
            Ok(Ok(()))  => Ok(()),
            Ok(Err(e))  => Err(fmt!("{}", e)),
            Err(_)      => Err(s("the case's assertion failed")),
        }
    })
}

/// `case` once as it is, which must pass, and once with `rule` off, which must not.
fn green_and_red<F, Fut>(o: Over, rule: &'static str, case: F)
where
    F: Fn(Over) -> Fut + Send + Sync,
    Fut: std::future::Future<Output = Outcome<()>>,
{
    if let Err(e) = on_a_thread(o, None, &case) {
        panic!("green over {:?}: {}", o, e);
    }
    match on_a_thread(o, Some(rule), &case) {
        Ok(())  => panic!("with '{}' off over {:?} the case still passed", rule, o),
        Err(e)  => eprintln!("RED {} over {:?}: {}", rule, o, e),
    }
}

#[test]
fn a_restore_writes_no_byte_in_the_folder_mem() {
    green_and_red(Over::Mem, "own_only", a_restore_writes_no_byte_in_the_folder)
}

#[test]
fn a_restore_writes_no_byte_in_the_folder_ozone() {
    green_and_red(Over::Ozone, "own_only", a_restore_writes_no_byte_in_the_folder)
}

#[test]
fn a_door_entry_with_no_door_is_refused_mem() {
    green_and_red(Over::Mem, "door_guard", a_door_entry_with_no_door_is_refused)
}

#[test]
fn a_door_entry_with_no_door_is_refused_ozone() {
    green_and_red(Over::Ozone, "door_guard", a_door_entry_with_no_door_is_refused)
}

#[test]
fn a_credited_window_path_is_never_recorded_gone_mem() {
    green_and_red(Over::Mem, "unread_gone", a_credited_window_path_is_never_recorded_gone)
}

#[test]
fn a_credited_window_path_is_never_recorded_gone_ozone() {
    green_and_red(Over::Ozone, "unread_gone", a_credited_window_path_is_never_recorded_gone)
}

#[test]
fn a_stalled_link_is_unseen_and_the_rest_is_served_mem() {
    green_and_red(Over::Mem, "deadline", a_stalled_link_is_unseen_and_the_rest_is_served)
}

#[test]
fn a_stalled_link_is_unseen_and_the_rest_is_served_ozone() {
    green_and_red(Over::Ozone, "deadline", a_stalled_link_is_unseen_and_the_rest_is_served)
}

/// The ticketed restore green, then red with the server's Held staging off, and again with an
/// open restore's hold not passed on to the door child's uploads.
fn held_green_and_red(o: Over) {
    if let Err(e) = a_ticketed_restore_of_a_held_version_lands(o, None) {
        panic!("green over {:?}: {}", o, e);
    }
    for rule in ["held_stage", "restore_hold"] {
        let red = std::panic::catch_unwind(|| a_ticketed_restore_of_a_held_version_lands(o, Some(rule)));
        match red {
            Ok(Ok(()))  => panic!("with '{}' off over {:?} the restore still landed", rule, o),
            Ok(Err(e))  => eprintln!("RED {} over {:?}: {}", rule, o, e),
            Err(_)      => eprintln!("RED {} over {:?}: the case's assertion failed", rule, o),
        }
    }
}

#[test]
fn a_ticketed_restore_of_a_held_version_lands_mem() { held_green_and_red(Over::Mem) }

#[test]
fn a_ticketed_restore_of_a_held_version_lands_ozone() { held_green_and_red(Over::Ozone) }
