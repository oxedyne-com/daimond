//! The store's own tests, over the backend this thread has installed (d1_plan §3 D1t, part 1).
//!
//! Every test reaches the store through its facade, so the backend it runs over is the one
//! [`fresh`] installs: the memory store or the Ozone store, each case once over each (D1j).
//! Part 1 covers the crystal's write, read and version chain, `versions_record` with
//! `versions_body`, and the
//! `captured_room` cap with `release`.  Part 2 (D1t2) covers the windows a call is walked in, the
//! notes `pend` leaves and `unpend` takes back, the link writers, and a restore's `restore_route`
//! on a fixture plan; and, over the lying double, the keyframe's read-back refusal.

use crate::{
    diamond_delta::KEYFRAME_EVERY,
    diamond_link::Unlink,
    diamond_versions::{self as versions, Act, Body, Cause, Change, Found, Short, TURN_FILES_MAX},
    rating::Author,
    store::{
        diamond::{self, Plan},
        door::{DirLink, DoorEnv, Link},
        install,
        mem::MemBackend,
        native::NativeBackend,
        own,
        run::RunEnv,
    },
};

use oxedyne_fe2o3_core::prelude::*;

use std::path::PathBuf;

/// The backend [`fresh`] puts in place on this thread.  Every case runs once over each, from its
/// `_mem` and `_ozone` wrappers at the foot of this file (D1j).
#[derive(Clone, Copy, Debug)]
enum Over {
    Mem,
    Ozone,
}

thread_local! {
    static OVER: std::cell::Cell<Over> = const { std::cell::Cell::new(Over::Mem) };
}

/// Run this thread's cases over `o`.
fn over(o: Over) {
    OVER.with(|c| c.set(o));
}

/// A fresh, empty backend of the kind [`over`] chose: the memory store, or a new Ozone store of
/// the test's own.
fn backend() -> NativeBackend {
    match OVER.with(|c| c.get()) {
        Over::Mem   => NativeBackend::Mem(MemBackend::default()),
        Over::Ozone => NativeBackend::Ozone(crate::store::ozone::tests::fresh_store("t")),
    }
}

/// Put a fresh, empty backend in place for this thread's store.
fn fresh() {
    let _ = install(backend());
}

/// Take the backend away again, so nothing of this test outlives it on the thread.
fn closed() {
    let _ = install(NativeBackend::Closed);
}

fn env(page: &str, id: &str) -> RunEnv {
    RunEnv {
        run:        page.to_string(),
        diamonds:   [id.to_string()].into_iter().collect(),
        folder_id:  None,
        known:      Default::default(),
        page:       page.to_string(),
    }
}

fn ok<V>(what: &str, got: Outcome<V>) -> V {
    match got {
        Ok(v)  => v,
        Err(e) => panic!("{}: {}", what, e),
    }
}

/// A fresh Diamond `id`, at version 0 with an empty crystal.
async fn diamond_at(id: &str) {
    let got = ok("create", diamond::create_at("t", id).await);
    assert_eq!(got, id, "created at its id");
}

/// A crystal large enough that a one-word edit of it is smaller as a patch than as a copy.
fn crystal(word: &str) -> String {
    let mut body = String::new();
    for n in 0..120 {
        body.push_str(&fmt!("line {} of the memory, unchanged between versions. ", n));
    }
    fmt!("{{\"name\":\"t\",\"word\":\"{}\",\"body\":\"{}\"}}", word, body)
}

fn snap(id: &str, version: u64, ext: &str) -> String {
    fmt!("diamonds/{}/versions/{:04}{}", id, version, ext)
}

async fn present(key: &str) -> bool {
    ok(key, own::exists(key).await)
}

/// The version `meta.json` says the Diamond is at.
async fn at_version(id: &str) -> u64 {
    let raw = ok("meta", own::read_file(&fmt!("diamonds/{}/.daimond/meta.json", id)).await);
    let text = String::from_utf8_lossy(&raw).into_owned();
    let tag = "\"crystal_version\":";
    let from = match text.find(tag) {
        Some(i) => i + tag.len(),
        None    => panic!("meta.json has no crystal_version: {}", text),
    };
    let digits: String = text[from..].trim_start().chars().take_while(|c| c.is_ascii_digit())
        .collect();
    match digits.parse() {
        Ok(v)  => v,
        Err(_) => panic!("meta.json's crystal_version is not a number: {}", text),
    }
}

// ── (a) The crystal's write, read and version chain ──────────────────────────────────────────

/// A first write over the empty version 0 is a keyframe, and a one-word edit after it is a
/// patch: one snapshot per version, never both, each reading back as what was written.
async fn a_crystal_edit_is_recorded_as_a_delta_over_its_keyframe() {
    fresh();
    let id = "a1";
    env("p", id).scope(async {
        diamond_at(id).await;
        let one = crystal("first");
        let two = crystal("second");
        ok("write 1", diamond::write_crystal_data(id, &one).await);
        ok("write 2", diamond::write_crystal_data(id, &two).await);
        assert_eq!(at_version(id).await, 2, "two writes, two versions");
        assert!(present(&snap(id, 1, ".json")).await, "version 1 is a keyframe");
        assert!(!present(&snap(id, 1, ".jpatch")).await, "version 1 holds one snapshot");
        assert!(present(&snap(id, 2, ".jpatch")).await, "version 2 is a delta");
        assert!(!present(&snap(id, 2, ".json")).await, "version 2 holds one snapshot");
        assert_eq!(ok("read 1", diamond::read_version(id, 1).await), one, "version 1");
        assert_eq!(ok("read 2", diamond::read_version(id, 2).await), two, "version 2");
        assert_eq!(ok("read 0", diamond::read_version(id, 0).await), "", "version 0");
        assert_eq!(ok("head", diamond::read_crystal_data(id).await), two, "the head");
    }).await;
    closed();
}

/// The chain never runs longer than [`KEYFRAME_EVERY`]: a keyframe falls due again, and every
/// version along the way rebuilds as it was written.
async fn a_keyframe_falls_due_and_every_version_rebuilds() {
    fresh();
    let id = "a2";
    env("p", id).scope(async {
        diamond_at(id).await;
        let last = KEYFRAME_EVERY as u64 + 3;
        let mut written = Vec::new();
        for n in 1..=last {
            let text = crystal(&fmt!("w{}", n));
            ok("write", diamond::write_crystal_data(id, &text).await);
            written.push(text);
        }
        let mut keyframes = Vec::new();
        let mut run = 0usize;
        for n in 1..=last {
            let kf = present(&snap(id, n, ".json")).await;
            let patch = present(&snap(id, n, ".jpatch")).await;
            assert!(kf != patch, "version {} holds exactly one snapshot ({} {})", n, kf, patch);
            if kf {
                keyframes.push(n);
                run = 0;
            } else {
                run += 1;
                assert!(run < KEYFRAME_EVERY, "version {}: {} patches in a row", n, run);
            }
            assert_eq!(ok("read", diamond::read_version(id, n).await), written[n as usize - 1],
                "version {} rebuilds", n);
        }
        assert!(keyframes.len() >= 2, "a second keyframe fell due: {:?}", keyframes);
    }).await;
    closed();
}

/// A delta that does not apply is refused on the read, never answered with its keyframe's text
/// or an empty crystal.
async fn a_broken_delta_is_refused_on_read() {
    fresh();
    let id = "a3";
    env("p", id).scope(async {
        diamond_at(id).await;
        ok("write 1", diamond::write_crystal_data(id, &crystal("first")).await);
        ok("write 2", diamond::write_crystal_data(id, &crystal("second")).await);
        let at = snap(id, 2, ".jpatch");
        assert!(present(&at).await, "version 2 is a delta");
        ok("corrupt", own::write_file(&at, b"not a patch").await);
        let got = diamond::read_version(id, 2).await;
        assert!(got.is_err(), "a broken delta read as {:?}", got.map(|s| s.len()));
    }).await;
    closed();
}

/// A parent that cannot be rebuilt does not refuse the write: the next version is a full copy,
/// which mends the chain.
async fn a_broken_parent_is_mended_by_a_keyframe() {
    fresh();
    let id = "a4";
    env("p", id).scope(async {
        diamond_at(id).await;
        ok("write 1", diamond::write_crystal_data(id, &crystal("first")).await);
        ok("write 2", diamond::write_crystal_data(id, &crystal("second")).await);
        ok("corrupt", own::write_file(&snap(id, 2, ".jpatch"), b"not a patch").await);
        let three = crystal("third");
        ok("write 3", diamond::write_crystal_data(id, &three).await);
        assert!(present(&snap(id, 3, ".json")).await, "version 3 is a keyframe");
        assert!(!present(&snap(id, 3, ".jpatch")).await, "and not a patch on a broken parent");
        assert_eq!(ok("read 3", diamond::read_version(id, 3).await), three, "version 3");
    }).await;
    closed();
}

/// The page is snapshotted only where it changed, and read at any later version as the last
/// one written at or before it.
async fn the_page_is_snapshotted_only_where_it_changed() {
    fresh();
    let id = "a5";
    env("p", id).scope(async {
        diamond_at(id).await;
        ok("data 1", diamond::write_crystal_data(id, &crystal("first")).await);
        let page = "<html><body>the page</body></html>";
        ok("page 2", diamond::write_crystal_page(id, page).await);
        ok("data 3", diamond::write_crystal_data(id, &crystal("third")).await);
        assert!(!present(&snap(id, 1, ".html")).await, "no page at version 1");
        assert!(present(&snap(id, 2, ".html")).await, "the page at version 2");
        assert!(!present(&snap(id, 3, ".html")).await, "an unchanged page is not snapshotted");
        assert!(!present(&snap(id, 3, ".hpatch")).await, "nor patched");
        assert_eq!(ok("page 1", diamond::read_version_page(id, 1).await), "", "none at 1");
        assert_eq!(ok("page 3", diamond::read_version_page(id, 3).await), page, "as at 3");
        assert_eq!(ok("data 2", diamond::read_version(id, 2).await), crystal("first"),
            "the page edit carries the data through");
        assert_eq!(ok("head", diamond::read_crystal_page(id).await), page, "the head page");
    }).await;
    closed();
}

/// Both halves written as one action are one version, one log line.
async fn both_halves_are_one_version() {
    fresh();
    let id = "a6";
    env("p", id).scope(async {
        diamond_at(id).await;
        let data = crystal("both");
        let page = "<html>both</html>";
        ok("both", diamond::write_crystal_both(id, &data, page).await);
        assert_eq!(at_version(id).await, 1, "one version for both halves");
        assert_eq!(ok("data", diamond::read_version(id, 1).await), data, "the data at 1");
        assert_eq!(ok("page", diamond::read_version_page(id, 1).await), page, "the page at 1");
    }).await;
    closed();
}

/// With no crystal.json the head is read off the newest version; with nothing anywhere the
/// strict reader refuses and the lenient one opens empty.
async fn a_missing_crystal_falls_back_and_nothing_is_refused_strictly() {
    fresh();
    let id = "a7";
    env("p", id).scope(async {
        diamond_at(id).await;
        let one = crystal("first");
        ok("write", diamond::write_crystal_data(id, &one).await);
        ok("delete", own::delete_file(&fmt!("diamonds/{}/crystal.json", id)).await);
        assert_eq!(ok("fallback", diamond::read_crystal_data(id).await), one,
            "the newest version stands in for the missing file");
        let none = "a7none";
        assert!(diamond::read_crystal_data_strict(none).await.is_err(),
            "nothing anywhere is refused strictly");
        assert_eq!(ok("lenient", diamond::read_crystal_data(none).await), "",
            "and opens empty on the panel");
    }).await;
    closed();
}

/// An empty crystal.json beside a version holding a crystal is refused, never read as empty;
/// a crystal.json that is not UTF-8 is refused, never decoded lossily.
async fn an_empty_or_undecodable_head_is_refused() {
    fresh();
    let id = "a8";
    env("p", id).scope(async {
        diamond_at(id).await;
        ok("write", diamond::write_crystal_data(id, &crystal("first")).await);
        let head = fmt!("diamonds/{}/crystal.json", id);
        ok("empty", own::write_file(&head, b"").await);
        assert!(diamond::read_crystal_data(id).await.is_err(), "an empty head over a version");
        ok("bad", own::write_file(&head, &[b'{', 0xff, 0xfe, b'}']).await);
        assert!(diamond::read_crystal_data(id).await.is_err(), "a head that is not UTF-8");
    }).await;
    closed();
}

// ── (b) versions_record and versions_body ────────────────────────────────────────────────────

fn change(path: &str, before: Option<&[u8]>, after: Body) -> Change {
    Change {
        path:    path.to_string(),
        after,
        before:  (before.map(<[u8]>::to_vec)).map(crate::diamond_versions::Prior::Held),
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

fn held(b: &[u8]) -> Body { Body::Held(b.to_vec()) }

/// A record writes a manifest naming each file's bytes and what stood before, and both bodies
/// read back by their hashes.
async fn a_record_keeps_both_bodies_and_names_them() {
    fresh();
    let id = "b1";
    env("p", id).scope(async {
        diamond_at(id).await;
        let got = ok("record", diamond::versions_record(id, Cause::Turn, "t1", "note",
            vec![change("a.txt", Some(b"old a"), held(b"new a")),
                 change("b.txt", None, held(b"new b"))]).await);
        let (v, named) = match got {
            Some(r) => r,
            None    => panic!("the record wrote no version"),
        };
        assert_eq!(named, vec!["a.txt".to_string(), "b.txt".to_string()], "the files named");
        assert_eq!(at_version(id).await, v, "the record minted the head version");
        let manifests = diamond::versions_manifests(id).await;
        let m = match manifests.iter().find(|(n, _)| *n == v) {
            Some((_, m)) => m,
            None         => panic!("no manifest at {}: {:?}", v,
                manifests.iter().map(|(n, _)| *n).collect::<Vec<_>>()),
        };
        assert_eq!(m.turn, "t1", "the turn");
        assert_eq!(m.note, "note", "the note");
        let a = match m.files.iter().find(|e| e.path == "a.txt") {
            Some(e) => e,
            None    => panic!("a.txt has no row"),
        };
        assert_eq!(a.hash, versions::hash_of(b"new a"), "a's hash");
        assert_eq!(a.was, Some(versions::hash_of(b"old a")), "what stood at a");
        assert_eq!(a.bytes, 5, "a's length");
        for (hash, bytes) in [(a.hash.clone(), b"new a".to_vec()),
                              (versions::hash_of(b"old a"), b"old a".to_vec()),
                              (versions::hash_of(b"new b"), b"new b".to_vec())]
        {
            assert_eq!(ok("body", diamond::versions_body(id, &hash).await), Some(bytes),
                "the body {}", hash);
        }
    }).await;
    closed();
}

/// A second record of a file names what the first recorded as what stood before, though the
/// caller captured nothing.
async fn a_second_record_finds_what_stood_in_the_first() {
    fresh();
    let id = "b2";
    env("p", id).scope(async {
        diamond_at(id).await;
        let first = ok("record 1", diamond::versions_record(id, Cause::Turn, "", "",
            vec![change("a.txt", None, held(b"one"))]).await);
        let second = ok("record 2", diamond::versions_record(id, Cause::Turn, "", "",
            vec![change("a.txt", None, held(b"two"))]).await);
        let (v1, v2) = match (first, second) {
            (Some((a, _)), Some((b, _))) => (a, b),
            other                        => panic!("two records: {:?}", other),
        };
        assert!(v2 > v1, "the second record is a later version ({} {})", v1, v2);
        let manifests = diamond::versions_manifests(id).await;
        let row = manifests.iter().find(|(n, _)| *n == v2)
            .and_then(|(_, m)| m.files.iter().find(|e| e.path == "a.txt"));
        let row = match row {
            Some(r) => r,
            None    => panic!("no row for a.txt at {}", v2),
        };
        assert_eq!(row.was, Some(versions::hash_of(b"one")), "what the first recorded");
    }).await;
    closed();
}

/// Nothing to record writes nothing: no changes, a deletion of what was never held, and bytes
/// that did not move each answer `None` and mint no version.
async fn a_record_of_nothing_writes_nothing() {
    fresh();
    let id = "b3";
    env("p", id).scope(async {
        diamond_at(id).await;
        let none = ok("empty", diamond::versions_record(id, Cause::Turn, "", "", Vec::new())
            .await);
        assert!(none.is_none(), "no changes recorded {:?}", none);
        let gone = ok("gone", diamond::versions_record(id, Cause::Turn, "", "",
            vec![change("never.txt", None, Body::Gone)]).await);
        assert!(gone.is_none(), "a deletion of nothing recorded {:?}", gone);
        let same = ok("same", diamond::versions_record(id, Cause::Turn, "", "",
            vec![change("s.txt", Some(b"same"), held(b"same"))]).await);
        assert!(same.is_none(), "unmoved bytes recorded {:?}", same);
        assert_eq!(at_version(id).await, 0, "no version minted");
        assert!(diamond::versions_manifests(id).await.is_empty(), "no manifest written");
    }).await;
    closed();
}

/// One row per file: the same path twice in one record is one entry.
async fn a_record_keeps_one_row_per_file() {
    fresh();
    let id = "b4";
    env("p", id).scope(async {
        diamond_at(id).await;
        let got = ok("record", diamond::versions_record(id, Cause::Turn, "", "",
            vec![change("d.txt", None, held(b"x")), change("d.txt", None, held(b"y"))]).await);
        match got {
            Some((_, named)) => assert_eq!(named, vec!["d.txt".to_string()], "one row"),
            None             => panic!("the record wrote no version"),
        }
    }).await;
    closed();
}

/// A body is asked for only by a hash: anything else is refused, and a hash this device has no
/// body for is `None`, not an error.
async fn a_body_is_read_only_by_its_hash() {
    fresh();
    let id = "b5";
    env("p", id).scope(async {
        diamond_at(id).await;
        let absent = versions::hash_of(b"never stored");
        assert!(versions::is_hash(&absent), "a hash is a hash");
        assert_eq!(ok("absent", diamond::versions_body(id, &absent).await), None,
            "not on this device");
        for bad in ["../crystal.json", "", "zz", "b/abc"] {
            assert!(diamond::versions_body(id, bad).await.is_err(), "'{}' was not refused", bad);
        }
    }).await;
    closed();
}

// ── (c) captured_room's cap and release ──────────────────────────────────────────────────────

fn room(page: &str, id: &str, path: &str) -> Result<bool, Short> {
    env(page, id).sync_scope(|| diamond::captured_room(id, path, &Found::Unread, Some(1), false,
        u64::MAX))
}

fn fill(page: &str, id: &str, n: usize) {
    for k in 0..n {
        assert_eq!(room(page, id, &fmt!("/m/{}", k)), Ok(true), "room {} of {}", k, n);
    }
}

/// The cap is 64 changes a turn, held in one run: the 64th is room and the 65th is not.
fn the_cap_is_sixty_four_in_one_run() {
    assert_eq!(TURN_FILES_MAX, 64, "the cap");
    fill("c1", "c1d", TURN_FILES_MAX);
    assert_eq!(room("c1", "c1d", "/m/over"), Err(Short::Count), "the 65th");
    diamond::forget_page("c1");
}

/// A path already reserved is not reserved twice and does not count twice.
fn a_path_reserved_twice_counts_once() {
    fill("c2", "c2d", TURN_FILES_MAX - 1);
    assert_eq!(room("c2", "c2d", "/m/0"), Ok(false), "already reserved");
    assert_eq!(room("c2", "c2d", "/m/last"), Ok(true), "the 64th is still room");
    diamond::forget_page("c2");
}

/// `release` gives a reservation back: at the cap, one released makes room for one more.
fn release_frees_one_place_under_the_cap() {
    fill("c3", "c3d", TURN_FILES_MAX);
    env("c3", "c3d").sync_scope(|| diamond::release("c3d", "/m/5"));
    assert_eq!(room("c3", "c3d", "/m/new"), Ok(true), "the released place");
    assert_eq!(room("c3", "c3d", "/m/again"), Err(Short::Count), "and only one");
    diamond::forget_page("c3");
}

/// A run releases only its own: another run's `release` of the path leaves the reservation.
fn release_is_the_runs_own() {
    fill("c4a", "c4d", TURN_FILES_MAX);
    env("c4b", "c4d").sync_scope(|| diamond::release("c4d", "/m/5"));
    assert_eq!(room("c4b", "c4d", "/m/new"), Err(Short::Count), "another run freed nothing");
    assert_eq!(room("c4a", "c4d", "/m/5"), Ok(false), "still the first run's");
    diamond::forget_page("c4a");
    diamond::forget_page("c4b");
}

/// A capture keeps its place under the cap: its reservation becomes a held change, which still
/// counts, and capturing it again does not count it twice.
fn a_captured_change_still_counts() {
    let id = "c5d";
    fill("c5", id, TURN_FILES_MAX);
    env("c5", id).sync_scope(|| {
        for k in 0..TURN_FILES_MAX {
            let path = fmt!("/m/{}", k);
            diamond::capture(id, &path, change(&path, Some(b"old"), held(b"new")));
        }
        let path = "/m/0";
        diamond::capture(id, path, change(path, Some(b"old"), held(b"newer")));
    });
    assert_eq!(room("c5", id, "/m/over"), Err(Short::Count), "captures count against the cap");
    assert_eq!(room("c5", id, "/m/3"), Ok(false), "a held path is not reserved again");
    diamond::forget_page("c5");
}

/// The cap is the store's and not the run's, so two runs' captures and reservations count
/// together; each store's cap is its own.
fn the_cap_is_the_stores_across_runs_and_not_across_stores() {
    let id = "c6d";
    fill("c6a", id, TURN_FILES_MAX / 2);
    env("c6b", id).sync_scope(|| {
        for k in 0..TURN_FILES_MAX / 2 {
            let path = fmt!("/n/{}", k);
            assert_eq!(diamond::captured_room(id, &path, &Found::Unread, Some(1), false,
                u64::MAX), Ok(true), "the second run's room {}", k);
            diamond::capture(id, &path, change(&path, Some(b"old"), held(b"new")));
        }
    });
    assert_eq!(room("c6a", id, "/m/over"), Err(Short::Count), "over both runs");
    assert_eq!(room("c6a", "c6other", "/m/over"), Ok(true), "another store has its own cap");
    diamond::forget_page("c6a");
    diamond::forget_page("c6b");
}

// ── (d) Windows around a call ────────────────────────────────────────────────────────────────

fn by(run: &str) -> Author {
    Author { role: "worker".to_string(), run: run.to_string(), ..Default::default() }
}

fn under(id: &str, rel: &str) -> String {
    fmt!("{}/{}", diamond::diamond_dir(id), rel)
}

async fn put_own(key: &str, bytes: &[u8]) {
    ok(key, own::write_file(key, bytes).await);
}

/// A window walks the store before its call and after: what the call wrote or made is what it
/// moved, a file it left alone is not, and the turn end credits each to the call's author.
async fn a_window_sees_what_its_call_moved() {
    fresh();
    let id = "d1";
    let (edited, made, still) = (under(id, "notes.txt"), under(id, "made.txt"), under(id, "still.txt"));
    env("p", id).scope(async {
        diamond_at(id).await;
        put_own(&edited, b"one").await;
        put_own(&still, b"left alone").await;
        let w = diamond::open_window(id, Some(by("w1"))).await;
        put_own(&edited, b"two, longer").await;
        put_own(&made, b"new").await;
        diamond::close_window(w).await;
        let windows = diamond::test_windows(id);
        assert_eq!(windows.len(), 1, "one window: {:?}", windows);
        let moved: Vec<String> = match &windows[0].shifted {
            Some(list) => list.iter().map(|(p, _)| p.clone()).collect(),
            None       => panic!("the window is not closed: {:?}", windows[0]),
        };
        assert!(moved.contains(&edited), "the edit: {:?}", moved);
        assert!(moved.contains(&made), "the new file: {:?}", moved);
        assert!(!moved.contains(&still), "a file the call left: {:?}", moved);
        let changes = diamond::drain_windows(id, &[]).await;
        let mut credited: Vec<(String, Option<String>)> = changes.into_iter()
            .map(|c| (c.path, c.by.map(|a| a.run))).collect();
        credited.sort();
        assert_eq!(credited, vec![(made.clone(), Some("w1".to_string())),
            (edited.clone(), Some("w1".to_string()))], "each credited to the call's author");
    }).await;
    closed();
}

/// A window whose call changed nothing closes having moved nothing, and is closed: the turn end
/// does not read it as a call still in flight.
async fn a_window_over_nothing_closes_having_moved_nothing() {
    fresh();
    let id = "d2";
    env("p", id).scope(async {
        diamond_at(id).await;
        put_own(&under(id, "a.txt"), b"a").await;
        let w = diamond::open_window(id, None).await;
        assert_eq!(diamond::test_windows(id).first().map(|w| w.to), Some(u64::MAX),
            "open while its call runs");
        diamond::close_window(w).await;
        let windows = diamond::test_windows(id);
        assert_eq!(windows.len(), 1, "one window: {:?}", windows);
        assert!(windows[0].to != u64::MAX, "closed: {:?}", windows[0]);
        assert_eq!(windows[0].shifted, Some(Vec::new()), "moved nothing");
        assert!(diamond::drain_windows(id, &[]).await.is_empty(), "nothing to record");
    }).await;
    closed();
}

/// **MADE-2: what a command made is the Diamond's in this turn and, through the turn's record, in
/// the next**, with the meter's hash; one no agent ran is nobody's.
async fn made2_a_command_made_file_is_kept_by_the_record() {
    fresh();
    let id = "m2";
    env("p", id).scope(async {
        diamond_at(id).await;
        let (a, b) = ("a".repeat(64), "b".repeat(64));
        diamond::ran_made(id, Some(by("w1")), vec![(fmt!("/m/out/a.o"), a.clone(), true)], false);
        diamond::ran_made(id, None, vec![(fmt!("/m/out/b.o"), b.clone(), true)], false);
        let want = vec![(fmt!("/m/out/a.o"), a.clone())];
        assert_eq!(diamond::made_files(id).await, want, "this turn");
        let changes = diamond::drain_windows(id, &[]).await;
        assert_eq!(changes.len(), 1, "one row, the agent's: {:?}", changes);
        ok("record", diamond::versions_record(id, Cause::Turn, "", "", changes).await);
        assert_eq!(diamond::made_files(id).await, want, "the next turn, from the record");
        assert!(diamond::drain_windows(id, &[]).await.is_empty(), "drained with the turn");
    }).await;
    closed();
}

/// A runner turn record (`turnRec`, RUN-HIST §3.1) of two files on argonaut, `out.mp3` created and
/// `old.txt` changed.  Its rows come first and an author names a `run` of its own, so a reader
/// that took the record's keys off its rows would read the wrong run.
fn turn_rec(run: &str, keeper: &str) -> String {
    let (a, b) = ("a".repeat(64), "b".repeat(64));
    fmt!("{{\"v\":1,\"files\":[\
        {{\"path\":\"/home/jason/x/out.mp3\",\"hash\":\"{}\",\"created\":true,\
          \"by\":{{\"agent\":\"w1\",\"via\":\"command\",\"run\":\"not-the-run\"}}}},\
        {{\"path\":\"/home/jason/x/old.txt\",\"hash\":\"{}\",\"created\":false,\
          \"by\":{{\"role\":\"worker\",\"run\":\"w2\"}}}}],\
        \"keeper\":\"{}\",\"turnId\":\"t1\",\"run\":\"{}\",\"on\":\"dev-argo\",\
        \"onName\":\"argonaut\",\"since\":1000,\"until\":2000,\"ts\":1500,\"more\":0}}",
        a, b, keeper, run)
}

fn s(v: &str) -> String {
    v.to_string()
}

/// The versions of `id` a runner's turn was carried into.
async fn carried(id: &str) -> Vec<(u64, versions::Manifest)> {
    diamond::versions_manifests(id).await.into_iter().filter(|(_, m)| m.away.is_some()).collect()
}

/// **RUN-HIST S-a: a runner's turn is recorded on the asker, once**, as one `turn` version of the
/// command rows with its `away`; a second report of the same run writes nothing; and nothing that
/// decides about this device's files reads its rows.  The undo's answer records its own `restore`
/// version, whose `away` is the undo's reference.
async fn runhist_a_runner_turn_is_recorded_once_with_its_away() {
    fresh();
    let id = "rh1";
    env("p", id).scope(async {
        diamond_at(id).await;
        let rec = turn_rec("e-1", id);
        let got = ok("carried", diamond::versions_record_carried(id, &rec).await);
        let (v, files) = match got {
            Some(g) => g,
            None    => panic!("the carried turn recorded nothing"),
        };
        assert_eq!(files, vec![s("/home/jason/x/out.mp3"), s("/home/jason/x/old.txt")]);
        let held = carried(id).await;
        assert_eq!(held.len(), 1, "one carried version: {:?}", held);
        let (n, m) = &held[0];
        assert_eq!(*n, v);
        assert_eq!(m.cause, Cause::Turn);
        assert_eq!(m.turn, "t1");
        assert_eq!(m.ts, 1500);
        let away = match &m.away {
            Some(a) => a.clone(),
            None    => panic!("no away"),
        };
        assert_eq!(away, versions::Away { on: s("dev-argo"), on_name: s("argonaut"), run: s("e-1"),
            since: 1000, until: 2000, more: 0, ..Default::default() });
        assert_eq!(m.files.len(), 2);
        for e in m.files.iter() {
            assert_eq!(e.skipped.as_deref(), Some(versions::MADE_BY_COMMAND), "{:?}", e);
            assert!(e.was.is_none() && e.mark, "{:?}", e);
            assert_eq!(e.by.as_ref().map(|a| a.via.as_str()), Some(versions::VIA_COMMAND), "{:?}", e);
        }
        assert!(m.files[0].made && !m.files[1].made, "created vs changed: {:?}", m.files);
        assert_eq!(m.files[0].by.as_ref().map(|a| a.role.as_str()), Some("w1"), "the agent named");
        // Again, as a reposted report: nothing.
        assert_eq!(ok("again", diamond::versions_record_carried(id, &rec).await), None);
        assert_eq!(carried(id).await.len(), 1, "still one");
        // The History's list carries `away`.
        let list = ok("list", diamond::versions_list(id).await);
        assert!(list.contains("\"away\":{\"on\":\"dev-argo\",\"onName\":\"argonaut\",\"run\":\"e-1\""),
            "{}", list);
        // Nothing about this device's files reads a carried row.
        assert!(diamond::made_files(id).await.is_empty(), "made_files: a runner's file is not ours here");
        let all = diamond::versions_manifests(id).await;
        assert!(versions::state_at(&all, v, |_| None, |_| true).is_empty(), "state_at reads no carried row");
        assert!(versions::path_at(&all, "/home/jason/x/old.txt", v, None).is_none());
        // The undo's answer.
        let undone = "{\"t\":\"undone\",\"v\":1,\"uid\":\"9\",\"to\":\"me\",\"run\":\"e-1\",\
            \"status\":\"done\",\"restored\":[\"/home/jason/x/old.txt\"],\
            \"skipped\":[{\"path\":\"/home/jason/x/kept\",\"why\":\"changed since\"}],\
            \"removed\":[\"/home/jason/x/out.mp3\"],\
            \"undo\":{\"on\":\"dev-argo\",\"run\":\"u-9\",\"since\":3000,\"until\":4000}}";
        let busy = undone.replace("\"done\"", "\"busy\"");
        assert_eq!(ok("busy", diamond::versions_record_undone(id, &busy).await), None, "busy changed nothing");
        assert!(ok("undone", diamond::versions_record_undone(id, undone).await).is_some());
        assert_eq!(ok("undone again", diamond::versions_record_undone(id, undone).await), None);
        let held = carried(id).await;
        assert_eq!(held.len(), 2, "{:?}", held);
        let m = &held[1].1;
        assert_eq!(m.cause, Cause::Restore);
        assert_eq!(m.turn, "t1", "the turn it undid");
        assert_eq!(m.away, Some(versions::Away { on: s("dev-argo"), on_name: s("argonaut"),
            run: s("u-9"), since: 3000, until: 4000, more: 0, ..Default::default() }));
        let rows: Vec<(String, bool)> = m.files.iter().map(|e| (e.path.clone(), e.gone)).collect();
        assert_eq!(rows, vec![(s("/home/jason/x/old.txt"), false), (s("/home/jason/x/out.mp3"), true)]);
    }).await;
    closed();
}

/// **RUN-HIST lead point (c): for a chat with no Diamond, the carried turn lands in the store the
/// asker's own turn end keeps the chat in**, `chat:<id>` as `keeper_of_dir` reads it off the chat's
/// scratch (`DaimondApp`'s chat scope, `end_keeper_turn`) -- so the History, which lists that
/// store, shows it beside the chat's own turns.  A bare chat id the record names as `chat:<id>`
/// goes there too, and never to `diamonds/<id>`.
async fn runhist_a_chats_carried_turn_lands_where_its_own_turns_do() {
    fresh();
    let chat = "c7";
    let key = crate::tools::keeper_of_dir(&crate::tools::chat_scratch(chat));
    assert_eq!(key, "chat:c7");
    env("p", &key).scope(async {
        // The chat's own turn end, as `end_keeper_turn` records it: under `ctx.keeper()`.
        let own = versions::ran_rows(&[(s("/m/own.o"), "c".repeat(64), true, Some(by("w0")))]);
        assert!(ok("own turn", diamond::versions_record(&key, Cause::Turn, "", "", own).await).is_some());
        // The page passes the keeper it keeps the chat under, or the bare chat id.
        assert!(ok("by key", diamond::versions_record_carried(&key, &turn_rec("e-2", &key)).await).is_some());
        assert!(ok("bare", diamond::versions_record_carried(chat, &turn_rec("e-3", &key)).await).is_some());
        let list = ok("list", diamond::versions_list(&key).await);
        for want in ["/m/own.o", "\"run\":\"e-2\"", "\"run\":\"e-3\""] {
            assert!(list.contains(want), "{} not in the chat's History: {}", want, list);
        }
        assert!(diamond::versions_manifests(chat).await.is_empty(), "nothing under diamonds/{}", chat);
    }).await;
    closed();
}

/// A runner turn record whose only act was networked commands (U8h): no `files`, three `net`
/// rows of the pinned shape, two bad ones the reader drops, and `netMore`.
fn net_rec(run: &str, keeper: &str) -> String {
    net_rec_with(run, keeper, "\"net\":[\
        {\"host\":\"PyPI.org\",\"port\":443,\"up\":1234,\"down\":1258291,\"v\":\"registry\"},\
        {\"host\":\"pypi-mirror.example\",\"port\":443,\"up\":10,\"down\":20,\"v\":\"outside\"},\
        {\"host\":\"127.0.0.1\",\"port\":9222,\"up\":0,\"down\":0,\"v\":\"refused\",\"why\":\"a local address\"},\
        {\"host\":\"x.example\",\"port\":443,\"up\":1,\"down\":1,\"v\":\"maybe\"},\
        {\"port\":80,\"up\":1,\"down\":1,\"v\":\"registry\"}],\"netMore\":2,")
}

/// [`net_rec`] with `net` in place of its network keys: empty for none.
fn net_rec_with(run: &str, keeper: &str, net: &str) -> String {
    fmt!("{{\"v\":1,\"files\":[],{}\"keeper\":\"{}\",\"turnId\":\"t9\",\"run\":\"{}\",\
        \"on\":\"dev-argo\",\"onName\":\"argonaut\",\"since\":0,\"until\":0,\"ts\":1600,\"more\":0}}",
        net, keeper, run)
}

/// **U8h-b (a): a runner turn with network rows and no file is recorded**, as one `turn` version
/// with no entries whose `away.net` holds the three good rows (host lower-cased), bad rows
/// dropped, `netMore` kept; it survives the store and the History's list; a repost writes nothing;
/// more than [`versions::NET_ROWS_MAX`] rows keep that many and count the rest.  An old record,
/// with no `net`, records as it did: no rows and no `net` key.
async fn histnet_a_a_net_only_turn_is_recorded() {
    fresh();
    let id = "hn1";
    env("p", id).scope(async {
        diamond_at(id).await;
        let got = ok("carried", diamond::versions_record_carried(id, &net_rec("e-5", id)).await);
        let (v, files) = match got {
            Some(g) => g,
            None    => panic!("a net-only turn recorded nothing"),
        };
        assert!(files.is_empty(), "{:?}", files);
        let held = carried(id).await;
        assert_eq!(held.len(), 1, "{:?}", held);
        let (n, m) = &held[0];
        assert_eq!(*n, v);
        assert_eq!((m.cause, m.turn.as_str(), m.ts), (Cause::Turn, "t9", 1600));
        assert!(m.files.is_empty(), "{:?}", m.files);
        let away = match &m.away {
            Some(a) => a.clone(),
            None    => panic!("no away"),
        };
        let row = |host: &str, port: u16, up: u64, down: u64, kind: versions::NetKind, why: &str|
            versions::NetRow { host: s(host), port, up, down, kind, why: s(why) };
        assert_eq!(away.net, vec![
            row("pypi.org", 443, 1234, 1258291, versions::NetKind::Registry, ""),
            row("pypi-mirror.example", 443, 10, 20, versions::NetKind::Outside, ""),
            row("127.0.0.1", 9222, 0, 0, versions::NetKind::Refused, "a local address"),
        ]);
        assert_eq!(away.net_more, 2);
        assert_eq!((away.run.as_str(), away.on_name.as_str()), ("e-5", "argonaut"));
        let back = match versions::Manifest::from_json(&m.to_json()) {
            Ok(b)  => b,
            Err(e) => panic!("{}", e),
        };
        assert_eq!(&back, m, "round-trips");
        let list = ok("list", diamond::versions_list(id).await);
        assert!(list.contains("\"net\":[{\"host\":\"pypi.org\",\"port\":443,\"up\":1234,\"down\":1258291,\"v\":\"registry\"}"),
            "{}", list);
        assert!(list.contains("\"why\":\"a local address\"") && list.contains("\"netMore\":2"), "{}", list);
        assert_eq!(ok("again", diamond::versions_record_carried(id, &net_rec("e-5", id)).await), None);
        assert_eq!(carried(id).await.len(), 1, "still one");
        // Past the bound: 34 good rows keep 32 and count 2 more beside the record's own 1.
        let many: Vec<String> = (0..34).map(|i| fmt!(
            "{{\"host\":\"h{}.example\",\"port\":443,\"up\":1,\"down\":2,\"v\":\"registry\"}}", i)).collect();
        let rec = net_rec_with("e-6", id, &fmt!("\"net\":[{}],\"netMore\":1,", many.join(",")));
        assert!(ok("many", diamond::versions_record_carried(id, &rec).await).is_some());
        let held = carried(id).await;
        let a = match held.last().and_then(|(_, m)| m.away.clone()) {
            Some(a) => a,
            None    => panic!("no away"),
        };
        assert_eq!((a.net.len(), a.net_more), (versions::NET_ROWS_MAX, 3), "{:?}", a);
        // An old record: no `net`, so no rows, and its manifest says nothing of them.
        ok("old", diamond::versions_record_carried(id, &turn_rec("e-7", id)).await);
        let held = carried(id).await;
        let (_, m) = match held.last() {
            Some(h) => h,
            None    => panic!("nothing held"),
        };
        let a = match &m.away {
            Some(a) => a.clone(),
            None    => panic!("no away"),
        };
        assert!(a.net.is_empty() && a.net_more == 0, "{:?}", a);
        assert!(!m.to_json().contains("\"net"), "{}", m.to_json());
        // A record with neither rows nor network still records nothing.
        let bare = net_rec_with("e-8", id, "");
        assert_eq!(ok("bare", diamond::versions_record_carried(id, &bare).await), None, "{}", bare);
    }).await;
    closed();
}

// ── (e) pend and unpend ──────────────────────────────────────────────────────────────────────

/// Every note in `id`'s pending directory, as text.
async fn notes(id: &str) -> Vec<String> {
    let dir = fmt!("{}/versions/pending", diamond::diamond_dir(id));
    let mut out = Vec::new();
    for (name, is_dir, _) in own::list_dir(&dir).await.unwrap_or_default() {
        if is_dir {
            continue;
        }
        let raw = ok("note", own::read_file(&fmt!("{}/{}", dir, name)).await);
        out.push(String::from_utf8_lossy(&raw).into_owned());
    }
    out
}

fn names(note: &str, hash: &str) -> bool {
    note.contains(&fmt!("\"was\":\"{}\"", hash))
}

/// `pend` keeps the bytes a path held before the act, under a note stamped with the run, before
/// the act; the first note of a path stands; and `unpend` takes the note back.
async fn a_note_keeps_the_first_copy_and_unpend_takes_it_back() {
    fresh();
    let id = "e1";
    let path = "/m/a.txt";
    env("p", id).scope(async {
        diamond_at(id).await;
        assert_eq!(ok("pend", diamond::pend(id, path, b"old", false, false).await), true,
            "this call wrote the note");
        let old = versions::hash_of(b"old");
        let got = notes(id).await;
        assert_eq!(got.len(), 1, "one note: {:?}", got);
        assert!(names(&got[0], &old), "the note names the copy: {}", got[0]);
        assert!(got[0].contains("\"page\":\"p\""), "stamped with its run: {}", got[0]);
        assert_eq!(ok("body", diamond::versions_body(id, &old).await), Some(b"old".to_vec()),
            "the copy is in the store");
        assert_eq!(ok("again", diamond::pend(id, path, b"later", false, false).await), false,
            "a second edit's note is not written");
        let got = notes(id).await;
        assert!(got.len() == 1 && names(&got[0], &old), "the first copy stands: {:?}", got);
        diamond::unpend(id, path).await;
        assert!(notes(id).await.is_empty(), "the note was taken back");
    }).await;
    closed();
}

/// A destruction's copy replaces an edit's note, answering `false` (the note was the turn's
/// already); a destruction's note is never replaced.
async fn a_destructions_copy_replaces_an_edits_note() {
    fresh();
    let id = "e2";
    let path = "/m/b.txt";
    env("p", id).scope(async {
        diamond_at(id).await;
        assert_eq!(ok("edit", diamond::pend(id, path, b"edit", false, false).await), true);
        assert_eq!(ok("wipe", diamond::pend(id, path, b"wiped", true, false).await), false,
            "replaced, not new");
        let got = notes(id).await;
        assert!(got.len() == 1 && names(&got[0], &versions::hash_of(b"wiped")),
            "the destruction's copy: {:?}", got);
        assert_eq!(ok("delete", diamond::pend(id, path, b"third", true, false).await), false);
        let got = notes(id).await;
        assert!(got.len() == 1 && names(&got[0], &versions::hash_of(b"wiped")),
            "a destruction's note stands: {:?}", got);
    }).await;
    closed();
}

// ── (f) Links added and removed ──────────────────────────────────────────────────────────────

fn links_at(id: &str) -> String {
    fmt!("{}/.daimond/links.jsonl", diamond::diamond_dir(id))
}

async fn link_ids(id: &str) -> Vec<String> {
    ok("links", diamond::read_links(id).await).into_iter().map(|l| l.id).collect()
}

/// A link is added with an id and removed by it; removed twice is nothing to remove; a blank id
/// names no link and is refused.
async fn a_link_is_added_and_removed_by_its_id() {
    fresh();
    let id = "f1";
    env("p", id).scope(async {
        diamond_at(id).await;
        let one = ok("add", diamond::add_link(id, "diamond:f1", "diamond:f1b", "cites", "",
            "agent:x").await);
        let two = ok("add", diamond::add_link(id, "diamond:f1", "diamond:f1c", "cites", "",
            "agent:x").await);
        assert!(!one.is_empty() && one != two, "two ids: {} {}", one, two);
        assert_eq!(link_ids(id).await, vec![one.clone(), two.clone()], "both are held");
        assert!(diamond::add_link(id, "diamond:f1", "diamond:f1", "", "", "").await.is_err(),
            "a link to itself");
        for blank in ["", "  "] {
            assert!(diamond::remove_link(id, blank).await.is_err(), "blank '{}'", blank);
        }
        assert_eq!(ok("remove", diamond::remove_link(id, &one).await), true, "removed");
        assert_eq!(link_ids(id).await, vec![two.clone()], "only the other is left");
        assert_eq!(ok("again", diamond::remove_link(id, &one).await), false, "nothing left to go");
    }).await;
    closed();
}

/// A model's removal takes its own link, never the user's, and a blank or unknown id is missing.
async fn a_model_removes_only_a_link_that_is_not_the_users() {
    fresh();
    let id = "f2";
    env("p", id).scope(async {
        diamond_at(id).await;
        let users = ok("add", diamond::add_link(id, "diamond:f2", "diamond:u", "", "", "user")
            .await);
        let model = ok("add", diamond::add_link(id, "diamond:f2", "diamond:m", "", "", "agent:x")
            .await);
        for asked in ["", "  ", "nope"] {
            assert!(matches!(ok("missing", diamond::remove_link_by_model(id, asked).await),
                Unlink::Missing), "'{}' is missing", asked);
        }
        assert!(matches!(ok("users", diamond::remove_link_by_model(id, &users).await),
            Unlink::Users), "the user's");
        assert!(matches!(ok("model", diamond::remove_link_by_model(id, &model).await),
            Unlink::Removed(_)), "the model's");
        assert_eq!(link_ids(id).await, vec![users], "the user's stands, the model's went");
    }).await;
    closed();
}

const BARE_AB: &str = "{\"from\":\"diamond:a\",\"to\":\"diamond:b\",\"rel\":\"informs\"}";
const BARE_BC: &str = "{\"from\":\"diamond:b\",\"to\":\"diamond:c\",\"rel\":\"informs\"}";
const NAMED:   &str = "{\"id\":\"k1\",\"from\":\"diamond:a\",\"to\":\"diamond:c\",\"rel\":\"cites\"}";

/// A hand-written row has no id, so it goes by what it says and only where exactly one row says
/// it; a blank id removes none of them; every other byte of the sidecar is kept.
async fn a_hand_written_link_goes_by_its_content_only_when_one_row_says_it() {
    fresh();
    let id = "f3";
    env("p", id).scope(async {
        diamond_at(id).await;
        let text = fmt!("{}\n{}\n{}\n", BARE_AB, BARE_BC, NAMED);
        put_own(&links_at(id), text.as_bytes()).await;
        assert!(diamond::remove_link(id, "").await.is_err(), "a blank id");
        let read = |raw: Vec<u8>| String::from_utf8_lossy(&raw).into_owned();
        assert_eq!(read(ok("sidecar", own::read_file(&links_at(id)).await)), text,
            "a blank id removed nothing");
        assert!(diamond::remove_bare_link(id, "diamond:a", "diamond:b", "cites").await.is_err(),
            "no row says it");
        ok("bare", diamond::remove_bare_link(id, "diamond:a", "diamond:b", "informs").await);
        assert_eq!(read(ok("sidecar", own::read_file(&links_at(id)).await)),
            fmt!("{}\n{}\n", BARE_BC, NAMED), "that row went and every other byte stayed");
        let twins = fmt!("{}\n{}\n", BARE_AB, BARE_AB);
        put_own(&links_at(id), twins.as_bytes()).await;
        assert!(diamond::remove_bare_link(id, "diamond:a", "diamond:b", "informs").await.is_err(),
            "two rows say it");
        assert_eq!(read(ok("sidecar", own::read_file(&links_at(id)).await)), twins,
            "neither twin went");
    }).await;
    closed();
}

// ── (g) restore_route on a fixture plan ──────────────────────────────────────────────────────

/// A folder of the person's under the lane's test directory (never `/tmp`), emptied first.
fn person(name: &str) -> PathBuf {
    let root = match std::env::var("DAIMOND_TEST_TMP") {
        Ok(d) if !d.is_empty() => PathBuf::from(d),
        _                      => PathBuf::from(std::env::var("HOME").unwrap_or_default())
            .join(".cache/lane-daimond-runner/tmp-rnd1t2"),
    };
    let dir = root.join(fmt!("{}-{}", name, std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    if let Err(e) = std::fs::create_dir_all(dir.join("notes")) {
        panic!("the test folder {:?}: {}", dir, e);
    }
    dir
}

/// A one-file restore of a person's file hands it out bound to what stood there at the open: an
/// act over those bytes goes, one over bytes that already match is done, one over bytes changed
/// since is asked again (and waits for his yes), and a file never handed out is nobody's to act on.
async fn a_restore_routes_each_act_by_what_the_person_decided_on() {
    fresh();
    let id = "g1";
    let path = "notes/a.md";
    let dir = person("g1");
    let door = DoorEnv::new(id, Link::Dir(DirLink::new(dir.clone())));
    let acts = env("p", id).scope(door.scope(async {
        diamond_at(id).await;
        if let Err(e) = std::fs::write(dir.join(path), b"v1") {
            panic!("writing {}: {}", path, e);
        }
        let mut row = change(path, None, held(b"v1"));
        row.folder = diamond::folder_of(path);
        let at = match ok("record", diamond::versions_record(id, Cause::Turn, "", "", vec![row])
            .await)
        {
            Some((v, _)) => v,
            None         => panic!("the fixture recorded nothing"),
        };
        if let Err(e) = std::fs::write(dir.join(path), b"v2") {
            panic!("writing {}: {}", path, e);
        }
        let opened = ok("open", diamond::versions_restore_open(id,
            Plan::At(at, Some(path.to_string()), None)).await);
        let t = opened.ticket;
        let acts = vec![
            diamond::restore_route(t, "notes/other.md", "notes/other.md", Some(b"x"), Some(b"v1")),
            diamond::restore_route(t, path, path, Some(b"v1"), Some(b"v1")),
            diamond::restore_route(t, path, path, Some(b"v2"), Some(b"v1")),
            diamond::restore_route(t, path, path, Some(b"v3"), Some(b"v1")),
            diamond::restore_route(t, path, path, Some(b"v2"), Some(b"v1")),
            match diamond::restore_answer(t, &[path.to_string()], true) {
                Ok(())  => diamond::restore_route(t, path, path, Some(b"v3"), Some(b"v1")),
                Err(e)  => panic!("the answer: {}", e),
            },
        ];
        ok("end", diamond::versions_restore_end(id, t).await);
        acts
    })).await;
    closed();
    let _ = std::fs::remove_dir_all(&dir);
    assert_eq!(acts, vec![Act::Unasked, Act::Same, Act::Go, Act::Changed, Act::Unanswered, Act::Go],
        "(never handed out, already so, as seen, changed since, changed and not yet answered, \
        after his yes)");
}

// ── (h) The keyframe's read-back refusal ─────────────────────────────────────────────────────

/// Is `got` the refusal of a keyframe that does not read back as written?
fn read_back_refused(got: &Outcome<()>) -> bool {
    matches!(got, Err(e) if e.to_string().contains("reads back as"))
}

/// A first crystal write is a keyframe, and the version stands only once its snapshot reads back
/// as written: over a store that alters what it has just been given, the write is refused and no
/// version is minted.  The same write over a store that keeps its bytes stands, so the refusal is
/// the lie's and is reached only through it.
async fn a_keyframe_that_does_not_read_back_is_refused() {
    let mut refused = Vec::new();
    for (lying, id) in [(false, "h1"), (true, "h2")] {
        // The lie is the memory store's seam; the honest half runs over the case's backend.
        let _ = install(if lying { NativeBackend::Lying(MemBackend::default()) }
            else { backend() });
        let (got, at) = env("p", id).scope(async {
            diamond_at(id).await;
            let got = diamond::write_crystal_data(id, &crystal("first")).await;
            (got, at_version(id).await)
        }).await;
        closed();
        refused.push((read_back_refused(&got), at, got.err().map(|e| e.to_string())));
    }
    assert_eq!(refused[0].0, false, "a store that keeps its bytes: {:?}", refused[0]);
    assert_eq!(refused[0].1, 1, "and the version stands");
    assert_eq!(refused[1].0, true, "a store that lies: {:?}", refused[1]);
    assert_eq!(refused[1].1, 0, "and no version is minted");
}

// ┌───────────────────────────────────────────────────────────────┐
// │ Every case over Mem and over Ozone                             │
// └───────────────────────────────────────────────────────────────┘

#[tokio::test]
async fn a_crystal_edit_is_recorded_as_a_delta_over_its_keyframe_mem() {
    over(Over::Mem);
    a_crystal_edit_is_recorded_as_a_delta_over_its_keyframe().await
}

#[tokio::test]
async fn a_crystal_edit_is_recorded_as_a_delta_over_its_keyframe_ozone() {
    over(Over::Ozone);
    a_crystal_edit_is_recorded_as_a_delta_over_its_keyframe().await
}

#[tokio::test]
async fn a_keyframe_falls_due_and_every_version_rebuilds_mem() {
    over(Over::Mem);
    a_keyframe_falls_due_and_every_version_rebuilds().await
}

#[tokio::test]
async fn a_keyframe_falls_due_and_every_version_rebuilds_ozone() {
    over(Over::Ozone);
    a_keyframe_falls_due_and_every_version_rebuilds().await
}

#[tokio::test]
async fn a_broken_delta_is_refused_on_read_mem() {
    over(Over::Mem);
    a_broken_delta_is_refused_on_read().await
}

#[tokio::test]
async fn a_broken_delta_is_refused_on_read_ozone() {
    over(Over::Ozone);
    a_broken_delta_is_refused_on_read().await
}

#[tokio::test]
async fn a_broken_parent_is_mended_by_a_keyframe_mem() {
    over(Over::Mem);
    a_broken_parent_is_mended_by_a_keyframe().await
}

#[tokio::test]
async fn a_broken_parent_is_mended_by_a_keyframe_ozone() {
    over(Over::Ozone);
    a_broken_parent_is_mended_by_a_keyframe().await
}

#[tokio::test]
async fn the_page_is_snapshotted_only_where_it_changed_mem() {
    over(Over::Mem);
    the_page_is_snapshotted_only_where_it_changed().await
}

#[tokio::test]
async fn the_page_is_snapshotted_only_where_it_changed_ozone() {
    over(Over::Ozone);
    the_page_is_snapshotted_only_where_it_changed().await
}

#[tokio::test]
async fn both_halves_are_one_version_mem() {
    over(Over::Mem);
    both_halves_are_one_version().await
}

#[tokio::test]
async fn both_halves_are_one_version_ozone() {
    over(Over::Ozone);
    both_halves_are_one_version().await
}

#[tokio::test]
async fn a_missing_crystal_falls_back_and_nothing_is_refused_strictly_mem() {
    over(Over::Mem);
    a_missing_crystal_falls_back_and_nothing_is_refused_strictly().await
}

#[tokio::test]
async fn a_missing_crystal_falls_back_and_nothing_is_refused_strictly_ozone() {
    over(Over::Ozone);
    a_missing_crystal_falls_back_and_nothing_is_refused_strictly().await
}

#[tokio::test]
async fn an_empty_or_undecodable_head_is_refused_mem() {
    over(Over::Mem);
    an_empty_or_undecodable_head_is_refused().await
}

#[tokio::test]
async fn an_empty_or_undecodable_head_is_refused_ozone() {
    over(Over::Ozone);
    an_empty_or_undecodable_head_is_refused().await
}

#[tokio::test]
async fn a_record_keeps_both_bodies_and_names_them_mem() {
    over(Over::Mem);
    a_record_keeps_both_bodies_and_names_them().await
}

#[tokio::test]
async fn a_record_keeps_both_bodies_and_names_them_ozone() {
    over(Over::Ozone);
    a_record_keeps_both_bodies_and_names_them().await
}

#[tokio::test]
async fn a_second_record_finds_what_stood_in_the_first_mem() {
    over(Over::Mem);
    a_second_record_finds_what_stood_in_the_first().await
}

#[tokio::test]
async fn a_second_record_finds_what_stood_in_the_first_ozone() {
    over(Over::Ozone);
    a_second_record_finds_what_stood_in_the_first().await
}

#[tokio::test]
async fn a_record_of_nothing_writes_nothing_mem() {
    over(Over::Mem);
    a_record_of_nothing_writes_nothing().await
}

#[tokio::test]
async fn a_record_of_nothing_writes_nothing_ozone() {
    over(Over::Ozone);
    a_record_of_nothing_writes_nothing().await
}

#[tokio::test]
async fn a_record_keeps_one_row_per_file_mem() {
    over(Over::Mem);
    a_record_keeps_one_row_per_file().await
}

#[tokio::test]
async fn a_record_keeps_one_row_per_file_ozone() {
    over(Over::Ozone);
    a_record_keeps_one_row_per_file().await
}

#[tokio::test]
async fn a_body_is_read_only_by_its_hash_mem() {
    over(Over::Mem);
    a_body_is_read_only_by_its_hash().await
}

#[tokio::test]
async fn a_body_is_read_only_by_its_hash_ozone() {
    over(Over::Ozone);
    a_body_is_read_only_by_its_hash().await
}

#[test]
fn the_cap_is_sixty_four_in_one_run_mem() {
    over(Over::Mem);
    the_cap_is_sixty_four_in_one_run()
}

#[test]
fn the_cap_is_sixty_four_in_one_run_ozone() {
    over(Over::Ozone);
    the_cap_is_sixty_four_in_one_run()
}

#[test]
fn a_path_reserved_twice_counts_once_mem() {
    over(Over::Mem);
    a_path_reserved_twice_counts_once()
}

#[test]
fn a_path_reserved_twice_counts_once_ozone() {
    over(Over::Ozone);
    a_path_reserved_twice_counts_once()
}

#[test]
fn release_frees_one_place_under_the_cap_mem() {
    over(Over::Mem);
    release_frees_one_place_under_the_cap()
}

#[test]
fn release_frees_one_place_under_the_cap_ozone() {
    over(Over::Ozone);
    release_frees_one_place_under_the_cap()
}

#[test]
fn release_is_the_runs_own_mem() {
    over(Over::Mem);
    release_is_the_runs_own()
}

#[test]
fn release_is_the_runs_own_ozone() {
    over(Over::Ozone);
    release_is_the_runs_own()
}

#[test]
fn a_captured_change_still_counts_mem() {
    over(Over::Mem);
    a_captured_change_still_counts()
}

#[test]
fn a_captured_change_still_counts_ozone() {
    over(Over::Ozone);
    a_captured_change_still_counts()
}

#[test]
fn the_cap_is_the_stores_across_runs_and_not_across_stores_mem() {
    over(Over::Mem);
    the_cap_is_the_stores_across_runs_and_not_across_stores()
}

#[test]
fn the_cap_is_the_stores_across_runs_and_not_across_stores_ozone() {
    over(Over::Ozone);
    the_cap_is_the_stores_across_runs_and_not_across_stores()
}

#[tokio::test]
async fn made2_a_command_made_file_is_kept_by_the_record_mem() {
    over(Over::Mem);
    made2_a_command_made_file_is_kept_by_the_record().await
}

#[tokio::test]
async fn made2_a_command_made_file_is_kept_by_the_record_ozone() {
    over(Over::Ozone);
    made2_a_command_made_file_is_kept_by_the_record().await
}

#[tokio::test]
async fn a_window_sees_what_its_call_moved_mem() {
    over(Over::Mem);
    a_window_sees_what_its_call_moved().await
}

#[tokio::test]
async fn a_window_sees_what_its_call_moved_ozone() {
    over(Over::Ozone);
    a_window_sees_what_its_call_moved().await
}

#[tokio::test]
async fn a_window_over_nothing_closes_having_moved_nothing_mem() {
    over(Over::Mem);
    a_window_over_nothing_closes_having_moved_nothing().await
}

#[tokio::test]
async fn a_window_over_nothing_closes_having_moved_nothing_ozone() {
    over(Over::Ozone);
    a_window_over_nothing_closes_having_moved_nothing().await
}

#[tokio::test]
async fn a_note_keeps_the_first_copy_and_unpend_takes_it_back_mem() {
    over(Over::Mem);
    a_note_keeps_the_first_copy_and_unpend_takes_it_back().await
}

#[tokio::test]
async fn a_note_keeps_the_first_copy_and_unpend_takes_it_back_ozone() {
    over(Over::Ozone);
    a_note_keeps_the_first_copy_and_unpend_takes_it_back().await
}

#[tokio::test]
async fn a_destructions_copy_replaces_an_edits_note_mem() {
    over(Over::Mem);
    a_destructions_copy_replaces_an_edits_note().await
}

#[tokio::test]
async fn a_destructions_copy_replaces_an_edits_note_ozone() {
    over(Over::Ozone);
    a_destructions_copy_replaces_an_edits_note().await
}

#[tokio::test]
async fn a_link_is_added_and_removed_by_its_id_mem() {
    over(Over::Mem);
    a_link_is_added_and_removed_by_its_id().await
}

#[tokio::test]
async fn a_link_is_added_and_removed_by_its_id_ozone() {
    over(Over::Ozone);
    a_link_is_added_and_removed_by_its_id().await
}

#[tokio::test]
async fn a_model_removes_only_a_link_that_is_not_the_users_mem() {
    over(Over::Mem);
    a_model_removes_only_a_link_that_is_not_the_users().await
}

#[tokio::test]
async fn a_model_removes_only_a_link_that_is_not_the_users_ozone() {
    over(Over::Ozone);
    a_model_removes_only_a_link_that_is_not_the_users().await
}

#[tokio::test]
async fn a_hand_written_link_goes_by_its_content_only_when_one_row_says_it_mem() {
    over(Over::Mem);
    a_hand_written_link_goes_by_its_content_only_when_one_row_says_it().await
}

#[tokio::test]
async fn a_hand_written_link_goes_by_its_content_only_when_one_row_says_it_ozone() {
    over(Over::Ozone);
    a_hand_written_link_goes_by_its_content_only_when_one_row_says_it().await
}

#[tokio::test]
async fn a_restore_routes_each_act_by_what_the_person_decided_on_mem() {
    over(Over::Mem);
    a_restore_routes_each_act_by_what_the_person_decided_on().await
}

#[tokio::test]
async fn a_restore_routes_each_act_by_what_the_person_decided_on_ozone() {
    over(Over::Ozone);
    a_restore_routes_each_act_by_what_the_person_decided_on().await
}

#[tokio::test]
async fn a_keyframe_that_does_not_read_back_is_refused_mem() {
    over(Over::Mem);
    a_keyframe_that_does_not_read_back_is_refused().await
}

#[tokio::test]
async fn a_keyframe_that_does_not_read_back_is_refused_ozone() {
    over(Over::Ozone);
    a_keyframe_that_does_not_read_back_is_refused().await
}

/// PORT-PL-A: a `STATE.md` write lands by section through `state_split`, never refused: what
/// ages out goes to STATE.md's archive (the decisions archive) with a dated DECISIONS line, and
/// the touched rows are the record's own `<ms>\t<key>`, with a key the file dropped taken out.
#[test]
fn state_split_lands_by_section() {
    use crate::store::diamond::state_split;
    let body = "x".repeat(1_500);
    let mut big = String::from("# State\n\n");
    for k in ["A", "B", "C", "D"] {
        big.push_str(&fmt!("## {}\n\n{}\n\n", k, body));
    }
    assert!(big.len() > crate::tools::STATE_CAP, "fixture: over the ceiling");
    let touched = "1\tA\n2\tB\n3\tC\n4\tD\n5\tGone\n";
    let l = state_split("", big, touched, 100, "2026-10-19");
    assert!(l.kept.len() <= crate::tools::STATE_CAP, "{}", l.kept.len());
    assert_eq!(l.archive.first().map(|(leaf, _)| leaf.as_str()), Some(crate::tools::STATE_FILE));
    assert!(!l.noted.is_empty(), "a retirement notes a dated DECISIONS line");
    assert!(l.noted.iter().all(|n| n.contains("2026-10-19")), "{:?}", l.noted);
    assert!(l.touched.iter().any(|r| r == "\tGone"), "the dropped key is taken out: {:?}", l.touched);
    assert!(l.touched.iter().all(|r| r.contains('\t') && !r.contains('\n')), "{:?}", l.touched);
    assert!(!crate::tools::standing_refused(crate::tools::STATE_FILE, 99_999, 0));
    assert!(!crate::tools::standing_archive(crate::tools::STATE_FILE, "d").is_empty());
}

#[tokio::test]
async fn runhist_a_runner_turn_is_recorded_once_with_its_away_mem() {
    over(Over::Mem);
    runhist_a_runner_turn_is_recorded_once_with_its_away().await
}

#[tokio::test]
async fn runhist_a_runner_turn_is_recorded_once_with_its_away_ozone() {
    over(Over::Ozone);
    runhist_a_runner_turn_is_recorded_once_with_its_away().await
}

#[tokio::test]
async fn histnet_a_a_net_only_turn_is_recorded_mem() {
    over(Over::Mem);
    histnet_a_a_net_only_turn_is_recorded().await
}

#[tokio::test]
async fn histnet_a_a_net_only_turn_is_recorded_ozone() {
    over(Over::Ozone);
    histnet_a_a_net_only_turn_is_recorded().await
}

#[tokio::test]
async fn runhist_a_chats_carried_turn_lands_where_its_own_turns_do_mem() {
    over(Over::Mem);
    runhist_a_chats_carried_turn_lands_where_its_own_turns_do().await
}

#[tokio::test]
async fn runhist_a_chats_carried_turn_lands_where_its_own_turns_do_ozone() {
    over(Over::Ozone);
    runhist_a_chats_carried_turn_lands_where_its_own_turns_do().await
}
