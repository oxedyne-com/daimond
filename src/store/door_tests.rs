//! The door seam and the entry guard (d1_plan §9.2 D1s2c).

use super::*;
use crate::{
    store::{
        call::is_unreadable,
        diamond::{self, Plan},
        install,
        mem::MemBackend,
        native::NativeBackend,
        own,
        run::RunEnv,
        StoreBackend,
    },
    tools::FileRoot,
};

use std::time::Duration;

/// The short deadline the waiting tests use in place of [`USER_LINK_DEADLINE`].
const TEST_DEADLINE: Duration = Duration::from_millis(50);

/// How long a test waits before it calls a read hung.
const HUNG: Duration = Duration::from_secs(5);

fn s(v: &str) -> String { v.to_string() }

fn env() -> RunEnv {
    RunEnv {
        run:        s("conductor"),
        diamonds:   [s("d")].into_iter().collect(),
        folder_id:  None,
        known:      Default::default(),
        page:       s("conductor"),
    }
}

/// A folder of the person's, from [`store::test_dir`](crate::store::test_dir), with its `notes`.
fn folder(name: &str) -> PathBuf {
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

fn door_on(dir: &Path) -> DoorEnv { DoorEnv::new("d", Link::Dir(DirLink::new(dir.to_path_buf()))) }

fn marks() -> Vec<(String, Option<Vec<u8>>)> {
    diamond::drain_dirty("d").into_iter()
        .map(|m| (m.path().to_string(), m.was().map(|w| w.to_vec())))
        .collect()
}

/// Natively each of the seven entries refuses with no `DoorEnv` in scope, and with a door on
/// another Diamond; the walk and the dirty set, which answer no error, do nothing and lose
/// nothing.  Inside a door on the Diamond the same calls go on (the controls).
#[tokio::test]
async fn each_entry_refuses_with_no_door() {
    let mem = MemBackend::default();
    let _ = install(NativeBackend::Mem(mem.clone()));
    let _ = mem.write_file("diamonds/d/x.md", b"x").await;
    let dir = folder("guard");
    let (refused, walked, marked, put_back, other, controls) = env().scope(async {
        let mut refused: Vec<String> = Vec::new();
        let mut note = |call: &str, r: Outcome<()>| match r {
            Err(e) if is_no_door(&e) => (),
            other                    => refused.push(fmt!("{}: {:?}", call, other)),
        };
        note("versions_restore_open",
            diamond::versions_restore_open("d", Plan::At(1, None, None)).await.map(|_| ()));
        note("versions_restore_hold", diamond::versions_restore_hold("d", 1).await);
        note("versions_restore_close_keeping",
            diamond::versions_restore_close_keeping("d", 1, true).await.map(|_| ()));
        note("versions_restore_close",
            diamond::versions_restore_close("d", 1).await.map(|_| ()));
        note("versions_restore_end", diamond::versions_restore_end("d", 1).await);
        let walked = diamond::versions_walk("d").await;
        diamond::mark_dirty_before("d", "diamonds/d/x.md").await;
        let marked = marks();
        // A mark made inside the door, handed to `dirty_changes` outside it.
        door_on(&dir).scope(diamond::mark_dirty_before("d", "diamonds/d/x.md")).await;
        let drained = diamond::drain_dirty("d");
        let changes = diamond::dirty_changes("d", drained).await;
        let put_back = (changes.len(), marks());
        // A door on another Diamond admits nothing on this one.
        let other = DoorEnv::new("e", Link::Dir(DirLink::new(dir.clone())))
            .scope(diamond::versions_restore_hold("d", 1)).await;
        // The controls: inside a door on `d`, the walk sees the file and the mark is made and read.
        let controls = door_on(&dir).scope(async {
            let walked = diamond::versions_walk("d").await.len();
            diamond::mark_dirty_before("d", "diamonds/d/x.md").await;
            let drained = diamond::drain_dirty("d");
            let changes = diamond::dirty_changes("d", drained).await.len();
            let held = diamond::versions_restore_hold("d", 1).await;
            (walked, changes, held.err().is_some_and(|e| !is_no_door(&e)))
        }).await;
        (refused, walked, marked, put_back, other, controls)
    }).await;
    let _ = install(NativeBackend::Closed);
    let _ = std::fs::remove_dir_all(&dir);
    let mut refused = refused;
    if !walked.is_empty() {
        refused.push(fmt!("versions_walk: walked {:?}", walked.len()));
    }
    if !marked.is_empty() {
        refused.push(fmt!("mark_dirty_before: marked {:?}", marked));
    }
    if put_back != (0, vec![(s("diamonds/d/x.md"), Some(b"x".to_vec()))]) {
        refused.push(fmt!("dirty_changes: (read, put back) {:?}", put_back));
    }
    assert!(refused.is_empty(), "let through with no door:\n{}", refused.join("\n"));
    assert!(other.err().is_some_and(|e| is_no_door(&e)), "a door on another Diamond admitted");
    assert_eq!(controls, (1, 1, true), "inside the door: (walked, read, hold past the guard)");
}

/// A read over a stalled link is `Unreadable` at the door's deadline: a capped read, an exists
/// and a list, each through the store's own seam.  Without the deadline each hangs.
#[tokio::test]
async fn stalled_link_is_unreadable_at_the_deadline() {
    let _ = install(NativeBackend::Mem(MemBackend::default()));
    let door = DoorEnv::new("d", Link::Stalled).with_deadline(TEST_DEADLINE);
    let answers = tokio::time::timeout(HUNG, door.scope(async {
        let read = own::user_read_file_capped(FileRoot::Workspace, "notes/a.md", 64).await;
        let whole = own::user_read_file(FileRoot::Workspace, "notes/a.md").await;
        let there = own::user_exists(FileRoot::Workspace, "notes/a.md").await;
        let listed = own::user_list_dir(FileRoot::Workspace, "notes").await;
        [read.err(), whole.err(), there.err(), listed.err()]
    })).await;
    let _ = install(NativeBackend::Closed);
    let answers = match answers {
        Ok(a)  => a,
        Err(_) => panic!("a stalled link hung the store's read past {:?}", HUNG),
    };
    for (what, e) in ["capped read", "read", "exists", "list"].iter().zip(answers.iter()) {
        assert!(e.as_ref().is_some_and(is_unreadable), "{}: {:?}", what, e);
    }
}

/// The default deadline is 20 s: a stalled read is answered `Unreadable` at 20 s, not before.
#[tokio::test(start_paused = true)]
async fn the_default_deadline_is_twenty_seconds() {
    let door = DoorEnv::new("d", Link::Stalled);
    assert_eq!(door.deadline(), Duration::from_secs(20));
    assert_eq!(USER_LINK_DEADLINE, Duration::from_secs(20));
    let start = tokio::time::Instant::now();
    let read = door.read_capped("notes/a.md", 64).await;
    let took = start.elapsed();
    assert!(read.err().is_some_and(|e| is_unreadable(&e)), "not Unreadable");
    assert!(took >= Duration::from_secs(20) && took < Duration::from_secs(21), "took {:?}", took);
}

/// Through a door over a folder, the seam reads the person's file; absence is absence, never
/// `Unreadable`; a failed read and an escape are `Unreadable`, never absence; and a store path
/// still goes to the backend.
#[tokio::test]
async fn a_door_reads_the_folder_and_only_reads_it() {
    let mem = MemBackend::default();
    let _ = install(NativeBackend::Mem(mem.clone()));
    let _ = mem.write_file("diamonds/d/x.md", b"store").await;
    let dir = folder("reads");
    put(&dir, "notes/a.md", b"hello");
    let _ = std::fs::create_dir_all(dir.join("notes/d.md"));     // a read of it fails: EISDIR
    let got = door_on(&dir).scope(async {
        let ws = FileRoot::Workspace;
        (
            own::user_read_file_capped(ws, "notes/a.md", 3).await.ok(),
            own::user_read_file(ws, "notes/a.md").await.ok(),
            own::user_read_file_capped(ws, "notes/z.md", 3).await.err()
                .map(|e| is_unreadable(&e)),
            own::user_read_file_capped(ws, "notes/d.md", 3).await.err()
                .map(|e| is_unreadable(&e)),
            own::user_read_file_capped(FileRoot::Machine, "../x", 3).await.err()
                .map(|e| is_unreadable(&e)),
            (own::user_exists(ws, "notes/a.md").await.ok(),
                own::user_exists(ws, "notes/z.md").await.ok()),
            own::user_list_dir(ws, "notes").await.ok()
                .map(|l| l.into_iter().map(|(n, d, _)| (n, d)).collect::<Vec<_>>()),
            own::user_write_file(ws, "notes/a.md", b"w").await.is_err(),
            own::user_read_file(ws, "diamonds/d/x.md").await.ok(),
        )
    }).await;
    let _ = install(NativeBackend::Closed);
    let after = std::fs::read(dir.join("notes/a.md")).ok();
    let _ = std::fs::remove_dir_all(&dir);
    assert_eq!(got.0, Some((b"hel".to_vec(), 5.0)), "capped read");
    assert_eq!(got.1, Some(b"hello".to_vec()), "read");
    assert_eq!(got.2, Some(false), "absence is not Unreadable");
    assert_eq!(got.3, Some(true), "a failed read is Unreadable");
    assert_eq!(got.4, Some(true), "an escape is Unreadable");
    assert_eq!(got.5, (Some(true), Some(false)), "exists");
    assert_eq!(got.6, Some(vec![(s("a.md"), false), (s("d.md"), true)]), "list");
    assert!(got.7, "a write through the door let through");
    assert_eq!(after, Some(b"hello".to_vec()), "the folder was written");
    assert_eq!(got.8, Some(b"store".to_vec()), "a store path left the backend");
}

/// A link inside the folder that points out of it is not followed: a link to a file outside and
/// one to a directory outside are each `Unreadable` for the capped read, exists and list, and so
/// is a path reached through the outward directory link (D1s2c check, door.rs symlink defect).
/// A link that stays inside the folder still reads.
#[cfg(unix)]
#[tokio::test]
async fn a_link_out_of_the_folder_is_unreadable() {
    let mem = MemBackend::default();
    let _ = install(NativeBackend::Mem(mem.clone()));
    let dir = folder("links");
    let out = folder("links-outside");
    put(&out, "secret.md", b"outside");
    put(&dir, "notes/a.md", b"inside");
    let link = |to: &Path, at: &str| if let Err(e) = std::os::unix::fs::symlink(to, dir.join(at)) {
        panic!("linking {}: {}", at, e);
    };
    link(&out.join("secret.md"), "notes/file-out.md");
    link(&out, "notes/dir-out");
    link(&dir.join("notes/a.md"), "notes/file-in.md");
    let got = door_on(&dir).scope(async {
        let ws = FileRoot::Workspace;
        let un = |r: Outcome<()>| r.err().map(|e| is_unreadable(&e));
        (
            un(own::user_read_file_capped(ws, "notes/file-out.md", 3).await.map(|_| ())),
            un(own::user_exists(ws, "notes/file-out.md").await.map(|_| ())),
            un(own::user_list_dir(ws, "notes/file-out.md").await.map(|_| ())),
            un(own::user_read_file_capped(ws, "notes/dir-out", 3).await.map(|_| ())),
            un(own::user_exists(ws, "notes/dir-out").await.map(|_| ())),
            un(own::user_list_dir(ws, "notes/dir-out").await.map(|_| ())),
            un(own::user_read_file_capped(ws, "notes/dir-out/secret.md", 3).await.map(|_| ())),
            un(own::user_exists(ws, "notes/dir-out/none.md").await.map(|_| ())),
            own::user_read_file_capped(ws, "notes/file-in.md", 3).await.ok(),
            own::user_exists(ws, "notes/none.md").await.ok(),
        )
    }).await;
    let _ = install(NativeBackend::Closed);
    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&out);
    assert_eq!(got.0, Some(true), "capped read through a file link out");
    assert_eq!(got.1, Some(true), "exists through a file link out");
    assert_eq!(got.2, Some(true), "list of a file link out");
    assert_eq!(got.3, Some(true), "capped read of a directory link out");
    assert_eq!(got.4, Some(true), "exists through a directory link out");
    assert_eq!(got.5, Some(true), "list through a directory link out");
    assert_eq!(got.6, Some(true), "capped read under a directory link out");
    assert_eq!(got.7, Some(true), "absence under a directory link out");
    assert_eq!(got.8, Some((b"ins".to_vec(), 6.0)), "a link inside the folder reads");
    assert_eq!(got.9, Some(false), "absence stays absence");
}

/// A path through a link out whose folders are not made yet is refused as the tools refuse it
/// (U3a QC1 L2), by the one real-place rule ([`crate::tools::real_place`]): it was admitted by
/// its spelling, its parent not being there to judge.  One whose missing folders are inside still
/// reads as absent (D1int).
#[cfg(unix)]
#[tokio::test]
async fn a_path_under_a_link_out_whose_folder_is_not_made_is_refused() {
    let mem = MemBackend::default();
    let _ = install(NativeBackend::Mem(mem.clone()));
    let dir = folder("notmade");
    let out = folder("notmade-outside");
    if let Err(e) = std::os::unix::fs::symlink(&out, dir.join("notes/dir-out")) {
        panic!("linking: {}", e);
    }
    let got = door_on(&dir).scope(async {
        let ws = FileRoot::Workspace;
        let un = |r: Outcome<()>| r.err().map(|e| is_unreadable(&e));
        (
            un(own::user_exists(ws, "notes/dir-out/new/none.md").await.map(|_| ())),
            un(own::user_read_file_capped(ws, "notes/dir-out/new/deeper/x.md", 3).await
                .map(|_| ())),
            un(own::user_list_dir(ws, "notes/dir-out/new").await.map(|_| ())),
            own::user_exists(ws, "notes/new/deeper/none.md").await.ok(),
        )
    }).await;
    let _ = install(NativeBackend::Closed);
    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&out);
    eprintln!("NOTMADE got {:?}", got);
    assert_eq!(got.0, Some(true), "exists under a link out, its folder not made");
    assert_eq!(got.1, Some(true), "capped read under a link out, two folders not made");
    assert_eq!(got.2, Some(true), "list under a link out, its folder not made");
    assert_eq!(got.3, Some(false), "absence inside, its folders not made, stays absence");
}

/// `mark_dirty_before` through a door: a file it reads is marked with its bytes, a file not there
/// as absent, and one it cannot read (a failed read, a stalled link) is never marked absent.
#[tokio::test]
async fn mark_dirty_before_never_marks_an_unread_file_absent() {
    let _ = install(NativeBackend::Mem(MemBackend::default()));
    let dir = folder("mark");
    put(&dir, "notes/b.md", b"b");
    let _ = std::fs::create_dir_all(dir.join("notes/a.md"));     // a read of it fails: EISDIR
    let marked = env().scope(async {
        door_on(&dir).scope(async {
            diamond::mark_dirty_before("d", "notes/a.md").await;
            diamond::mark_dirty_before("d", "notes/b.md").await;
            diamond::mark_dirty_before("d", "notes/c.md").await;
        }).await;
        DoorEnv::new("d", Link::Stalled).with_deadline(TEST_DEADLINE)
            .scope(diamond::mark_dirty_before("d", "notes/e.md")).await;
        let mut m = marks();
        m.sort();
        m
    }).await;
    let _ = install(NativeBackend::Closed);
    let _ = std::fs::remove_dir_all(&dir);
    assert_eq!(marked, vec![(s("notes/b.md"), Some(b"b".to_vec())), (s("notes/c.md"), None)],
        "an unread file marked, or marked absent");
}
