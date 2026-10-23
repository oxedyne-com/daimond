//! One conformance suite for every [`StoreBackend`] (d1_plan §9.2 D1cm).
//!
//! **OPFS is the reference.**  Each case states what `wasm::opfs` does on the store's own area,
//! and a backend passes only where it does the same: a write makes the folders above it, a move
//! never lands on an existing entry, a non-recursive delete of a folder with anything in it fails,
//! a capped read says the whole file's size, a conditional write or delete that finds something
//! else says what it found and changes nothing, two conditional writers racing for one key are
//! never both told they won, and the named locks refuse, time out and report as Web Locks do: a
//! released lock is free once the release returns, and a dropped one by the next task.
//!
//! The suite runs in the tab through `__store_conformance` (`dev/verify_storebackend.mjs`) and
//! natively in this module's tests, where a backend with a planted bug must fail the case named
//! for that bug.
//!
//! Every case works under its own folder below `root`, which it clears first and after, so the
//! suite can run on a live store under a scratch prefix.

use crate::{
    diamond_versions::{hash_of, Seen},
    store::{LockHow, Locked, StoreBackend},
};

use oxedyne_fe2o3_core::prelude::*;

use std::{
    cell::Cell,
    future::{poll_fn, Future},
    pin::pin,
    task::Poll,
};

/// One case's name, and why it failed (`None` where it passed).
#[derive(Clone, Debug)]
pub struct Case {
    pub name:   &'static str,
    pub failed: Option<String>,
}

/// Every case's name, in the order [`run`] answers them.
pub const CASES: &[&str] = &[
    "read_missing_fails",
    "write_read_round_trip",
    "write_makes_parents",
    "write_over_folder_fails",
    "exists_file_folder_absent",
    "list_dir_entries",
    "stamp_file_only",
    "capped_read_total",
    "delete_file_only_files",
    "delete_entry_recursion",
    "move_file",
    "move_folder",
    "move_refuses_existing",
    "move_missing_fails",
    "cas_write_absent",
    "cas_write_match",
    "cas_write_unread_refused",
    "cas_write_onto_folder",
    "cas_refused_makes_parents",
    "cas_write_under_file_fails",
    "cas_delete",
    "cas_race_one_wins",
    "lock_if_available",
    "lock_dropped_free_next_task",
    "lock_timeout_expires",
    "lock_wait_until_released",
];

fn want(cond: bool, what: &str) -> Outcome<()> {
    if cond { Ok(()) } else { Err(err!("{}", what; Test)) }
}

fn same<T: std::fmt::Debug + PartialEq>(got: T, expect: T, what: &str) -> Outcome<()> {
    if got == expect {
        Ok(())
    } else {
        Err(err!("{}: got {:?}, expected {:?}", what, got, expect; Test))
    }
}

/// Lets every other future in the same task run once before this one goes on.  In the tab this is
/// a microtask, not a task: what the browser does in the next task has not happened yet.
async fn yield_now() {
    let mut once = false;
    poll_fn(|cx| {
        if once {
            Poll::Ready(())
        } else {
            once = true;
            cx.waker().wake_by_ref();
            Poll::Pending
        }
    }).await
}

/// Lets the environment run one task before this one goes on (`setTimeout 0` in the tab).
async fn next_task() {
    crate::llm::sleep_ms(0).await
}

/// Run `a` and `b` together until both are done.  No runtime is needed.
async fn join<A: Future, B: Future>(a: A, b: B) -> (A::Output, B::Output) {
    let mut a = pin!(a);
    let mut b = pin!(b);
    let mut ra = None;
    let mut rb = None;
    poll_fn(|cx| {
        if ra.is_none() {
            if let Poll::Ready(v) = a.as_mut().poll(cx) { ra = Some(v); }
        }
        if rb.is_none() {
            if let Poll::Ready(v) = b.as_mut().poll(cx) { rb = Some(v); }
        }
        match (ra.take(), rb.take()) {
            (Some(x), Some(y)) => Poll::Ready((x, y)),
            (x, y)             => { ra = x; rb = y; Poll::Pending },
        }
    }).await
}

/// Clear the case's folder, run it, clear the folder again, and say how it went.
async fn case<B: StoreBackend, F: Future<Output = Outcome<()>>>(
    b:      &B,
    name:   &'static str,
    dir:    &str,
    body:   F,
)
    -> Case
{
    let _ = b.delete_entry(dir, true).await;
    let got = body.await;
    let _ = b.delete_entry(dir, true).await;
    Case { name, failed: got.err().map(|e| fmt!("{}", e)) }
}

/// Run every case on `b` below `root`.
pub async fn run<B: StoreBackend>(b: &B, root: &str) -> Vec<Case> {
    let d = |n: &str| fmt!("{}/{}", root.trim_end_matches('/'), n);
    let mut out = Vec::new();
    macro_rules! go { ($name:literal, $f:ident) => {{
        let dir = d($name);
        out.push(case(b, $name, &dir, $f(b, &dir)).await);
    }}}
    go!("read_missing_fails", read_missing_fails);
    go!("write_read_round_trip", write_read_round_trip);
    go!("write_makes_parents", write_makes_parents);
    go!("write_over_folder_fails", write_over_folder_fails);
    go!("exists_file_folder_absent", exists_file_folder_absent);
    go!("list_dir_entries", list_dir_entries);
    go!("stamp_file_only", stamp_file_only);
    go!("capped_read_total", capped_read_total);
    go!("delete_file_only_files", delete_file_only_files);
    go!("delete_entry_recursion", delete_entry_recursion);
    go!("move_file", move_file);
    go!("move_folder", move_folder);
    go!("move_refuses_existing", move_refuses_existing);
    go!("move_missing_fails", move_missing_fails);
    go!("cas_write_absent", cas_write_absent);
    go!("cas_write_match", cas_write_match);
    go!("cas_write_unread_refused", cas_write_unread_refused);
    go!("cas_write_onto_folder", cas_write_onto_folder);
    go!("cas_refused_makes_parents", cas_refused_makes_parents);
    go!("cas_write_under_file_fails", cas_write_under_file_fails);
    go!("cas_delete", cas_delete);
    go!("cas_race_one_wins", cas_race_one_wins);
    go!("lock_if_available", lock_if_available);
    go!("lock_dropped_free_next_task", lock_dropped_free_next_task);
    go!("lock_timeout_expires", lock_timeout_expires);
    go!("lock_wait_until_released", lock_wait_until_released);
    out
}

async fn read_missing_fails<B: StoreBackend>(b: &B, d: &str) -> Outcome<()> {
    res!(b.write_file(&fmt!("{}/here", d), b"x").await);
    res!(want(b.read_file(&fmt!("{}/absent", d)).await.is_err(), "a missing file read"));
    res!(want(b.read_file(&fmt!("{}/no/such/file", d)).await.is_err(),
        "a file under a missing folder read"));
    want(b.read_file_capped(&fmt!("{}/absent", d), 8).await.is_err(), "a missing file read capped")
}

async fn write_read_round_trip<B: StoreBackend>(b: &B, d: &str) -> Outcome<()> {
    let k = fmt!("{}/f.bin", d);
    let bytes: Vec<u8> = (0..=255u8).collect();
    res!(b.write_file(&k, &bytes).await);
    res!(same(res!(b.read_file(&k).await), bytes, "the bytes read back"));
    res!(b.write_file(&k, b"short").await);
    res!(same(res!(b.read_file(&k).await), b"short".to_vec(), "an overwrite read back"));
    res!(b.write_file(&k, b"").await);
    same(res!(b.read_file(&k).await), Vec::new(), "an empty write read back")
}

async fn write_makes_parents<B: StoreBackend>(b: &B, d: &str) -> Outcome<()> {
    res!(b.write_file(&fmt!("{}/a/b/c/f", d), b"deep").await);
    for k in ["a", "a/b", "a/b/c", "a/b/c/f"] {
        res!(want(res!(b.exists(&fmt!("{}/{}", d, k)).await), &fmt!("'{}' after the write", k)));
    }
    let top = res!(b.list_dir(d).await);
    res!(same(top, vec![("a".to_string(), true, 0)], "the case folder's listing"));
    same(res!(b.read_file(&fmt!("{}/a/b/c/f", d)).await), b"deep".to_vec(), "the deep file")
}

async fn write_over_folder_fails<B: StoreBackend>(b: &B, d: &str) -> Outcome<()> {
    res!(b.write_file(&fmt!("{}/dir/f", d), b"x").await);
    res!(want(b.write_file(&fmt!("{}/dir", d), b"y").await.is_err(), "a write over a folder"));
    res!(want(b.write_file(&fmt!("{}/dir/f/g", d), b"z").await.is_err(), "a write under a file"));
    same(res!(b.read_file(&fmt!("{}/dir/f", d)).await), b"x".to_vec(), "the file left standing")
}

async fn exists_file_folder_absent<B: StoreBackend>(b: &B, d: &str) -> Outcome<()> {
    res!(b.write_file(&fmt!("{}/dir/f", d), b"x").await);
    res!(want(res!(b.exists(&fmt!("{}/dir/f", d)).await), "a file exists"));
    res!(want(res!(b.exists(&fmt!("{}/dir", d)).await), "a folder exists"));
    res!(want(!res!(b.exists(&fmt!("{}/dir/g", d)).await), "a missing file does not"));
    want(!res!(b.exists(&fmt!("{}/none/g", d)).await), "a file under a missing folder does not")
}

async fn list_dir_entries<B: StoreBackend>(b: &B, d: &str) -> Outcome<()> {
    res!(b.write_file(&fmt!("{}/one", d), b"1").await);
    res!(b.write_file(&fmt!("{}/three", d), b"333").await);
    res!(b.write_file(&fmt!("{}/sub/deeper/x", d), b"x").await);
    let mut got = res!(b.list_dir_stamped(d).await);
    got.sort_by(|x, y| x.0.cmp(&y.0));
    res!(same(got.len(), 3, "entries listed (no grandchildren)"));
    let (one, sub, three) = (&got[0], &got[1], &got[2]);
    res!(same((one.0.as_str(), one.1, one.2), ("one", false, 1), "the file 'one'"));
    res!(want(matches!(one.3, Some(t) if t > 0.0), "a file's stamp is a time"));
    res!(same((three.0.as_str(), three.1, three.2), ("three", false, 3), "the file 'three'"));
    res!(same((sub.0.as_str(), sub.1, sub.2, sub.3), ("sub", true, 0, None), "the folder 'sub'"));
    let mut plain = res!(b.list_dir(d).await);
    plain.sort();
    res!(same(plain, got.iter().map(|e| (e.0.clone(), e.1, e.2)).collect::<Vec<_>>(),
        "list_dir against list_dir_stamped"));
    res!(want(b.list_dir(&fmt!("{}/absent", d)).await.is_err(), "a missing folder listed"));
    want(b.list_dir(&fmt!("{}/one", d)).await.is_err(), "a file listed as a folder")
}

async fn stamp_file_only<B: StoreBackend>(b: &B, d: &str) -> Outcome<()> {
    res!(b.write_file(&fmt!("{}/dir/f", d), b"12345").await);
    match res!(b.stamp(&fmt!("{}/dir/f", d)).await) {
        Some((t, size)) => {
            res!(want(t > 0.0, "a file's stamp is a time"));
            res!(same(size, 5.0, "a file's stamped size"));
        },
        None => return Err(err!("a file has no stamp"; Test)),
    }
    res!(same(res!(b.stamp(&fmt!("{}/dir/g", d)).await), None, "a missing file's stamp"));
    res!(same(res!(b.stamp(&fmt!("{}/dir", d)).await), None, "a folder's stamp"));
    same(res!(b.stamp(&fmt!("{}/none/g", d)).await), None, "the stamp under a missing folder")
}

async fn capped_read_total<B: StoreBackend>(b: &B, d: &str) -> Outcome<()> {
    let k = fmt!("{}/f", d);
    res!(b.write_file(&k, b"0123456789").await);
    res!(same(res!(b.read_file_capped(&k, 4).await), (b"0123".to_vec(), 10.0),
        "a capped read of a larger file"));
    res!(same(res!(b.read_file_capped(&k, 10).await), (b"0123456789".to_vec(), 10.0),
        "a read capped at its size"));
    same(res!(b.read_file_capped(&k, 100).await), (b"0123456789".to_vec(), 10.0),
        "a read capped above its size")
}

async fn delete_file_only_files<B: StoreBackend>(b: &B, d: &str) -> Outcome<()> {
    res!(b.write_file(&fmt!("{}/dir/f", d), b"x").await);
    res!(want(b.delete_file(&fmt!("{}/dir", d)).await.is_err(), "delete_file of a folder"));
    res!(want(res!(b.exists(&fmt!("{}/dir/f", d)).await), "the folder's file after a refused delete"));
    res!(b.delete_file(&fmt!("{}/dir/f", d)).await);
    res!(want(!res!(b.exists(&fmt!("{}/dir/f", d)).await), "a deleted file"));
    want(b.delete_file(&fmt!("{}/dir/f", d)).await.is_err(), "delete_file of a missing file")
}

async fn delete_entry_recursion<B: StoreBackend>(b: &B, d: &str) -> Outcome<()> {
    res!(b.write_file(&fmt!("{}/full/sub/f", d), b"x").await);
    res!(want(b.delete_entry(&fmt!("{}/full", d), false).await.is_err(),
        "a non-recursive delete of a folder with something in it"));
    res!(same(res!(b.read_file(&fmt!("{}/full/sub/f", d)).await), b"x".to_vec(),
        "the contents after the refused delete"));
    res!(b.delete_file(&fmt!("{}/full/sub/f", d)).await);
    res!(b.delete_entry(&fmt!("{}/full/sub", d), false).await);
    res!(want(!res!(b.exists(&fmt!("{}/full/sub", d)).await), "an empty folder deleted"));
    res!(b.write_file(&fmt!("{}/tree/a/b", d), b"b").await);
    res!(b.write_file(&fmt!("{}/tree/c", d), b"c").await);
    res!(b.delete_entry(&fmt!("{}/tree", d), true).await);
    res!(want(!res!(b.exists(&fmt!("{}/tree", d)).await), "a tree deleted recursively"));
    res!(want(!res!(b.exists(&fmt!("{}/tree/a/b", d)).await), "a file in the deleted tree"));
    res!(b.write_file(&fmt!("{}/one", d), b"1").await);
    res!(b.delete_entry(&fmt!("{}/one", d), false).await);
    res!(want(!res!(b.exists(&fmt!("{}/one", d)).await), "a file deleted as an entry"));
    want(b.delete_entry(&fmt!("{}/one", d), true).await.is_err(), "a delete of nothing")
}

async fn move_file<B: StoreBackend>(b: &B, d: &str) -> Outcome<()> {
    res!(b.write_file(&fmt!("{}/from", d), b"moved").await);
    res!(b.move_entry(&fmt!("{}/from", d), &fmt!("{}/new/place/to", d)).await);
    res!(want(!res!(b.exists(&fmt!("{}/from", d)).await), "the source after a move"));
    same(res!(b.read_file(&fmt!("{}/new/place/to", d)).await), b"moved".to_vec(), "the moved file")
}

async fn move_folder<B: StoreBackend>(b: &B, d: &str) -> Outcome<()> {
    res!(b.write_file(&fmt!("{}/src/a", d), b"a").await);
    res!(b.write_file(&fmt!("{}/src/sub/b", d), b"b").await);
    res!(b.move_entry(&fmt!("{}/src", d), &fmt!("{}/dst", d)).await);
    res!(want(!res!(b.exists(&fmt!("{}/src", d)).await), "the source folder after a move"));
    res!(same(res!(b.read_file(&fmt!("{}/dst/a", d)).await), b"a".to_vec(), "dst/a"));
    same(res!(b.read_file(&fmt!("{}/dst/sub/b", d)).await), b"b".to_vec(), "dst/sub/b")
}

async fn move_refuses_existing<B: StoreBackend>(b: &B, d: &str) -> Outcome<()> {
    res!(b.write_file(&fmt!("{}/from", d), b"from").await);
    res!(b.write_file(&fmt!("{}/to", d), b"to").await);
    res!(want(b.move_entry(&fmt!("{}/from", d), &fmt!("{}/to", d)).await.is_err(),
        "a move onto an existing file"));
    res!(same(res!(b.read_file(&fmt!("{}/from", d)).await), b"from".to_vec(), "the source kept"));
    res!(same(res!(b.read_file(&fmt!("{}/to", d)).await), b"to".to_vec(), "the target kept"));
    res!(b.write_file(&fmt!("{}/dir/x", d), b"x").await);
    res!(want(b.move_entry(&fmt!("{}/from", d), &fmt!("{}/dir", d)).await.is_err(),
        "a move onto an existing folder"));
    same(res!(b.read_file(&fmt!("{}/dir/x", d)).await), b"x".to_vec(), "the target folder kept")
}

async fn move_missing_fails<B: StoreBackend>(b: &B, d: &str) -> Outcome<()> {
    res!(b.write_file(&fmt!("{}/here", d), b"x").await);
    res!(want(b.move_entry(&fmt!("{}/absent", d), &fmt!("{}/to", d)).await.is_err(),
        "a move of nothing"));
    want(!res!(b.exists(&fmt!("{}/to", d)).await), "a target made by a failed move")
}

async fn cas_write_absent<B: StoreBackend>(b: &B, d: &str) -> Outcome<()> {
    let k = fmt!("{}/f", d);
    res!(same(res!(b.write_file_if(&k, b"first", Some(&Seen::Absent)).await), None,
        "a write expecting nothing, onto nothing"));
    res!(same(res!(b.read_file(&k).await), b"first".to_vec(), "the first write"));
    res!(same(res!(b.write_file_if(&k, b"second", Some(&Seen::Absent)).await),
        Some(Seen::Bytes(hash_of(b"first"))), "a write expecting nothing, onto a file"));
    res!(same(res!(b.read_file(&k).await), b"first".to_vec(), "the file after a refused write"));
    res!(same(res!(b.write_file_if(&k, b"third", None).await), None, "a write expecting anything"));
    same(res!(b.read_file(&k).await), b"third".to_vec(), "the unconditional write")
}

async fn cas_write_match<B: StoreBackend>(b: &B, d: &str) -> Outcome<()> {
    let k = fmt!("{}/f", d);
    res!(b.write_file(&k, b"v1").await);
    let v1 = Seen::Bytes(hash_of(b"v1"));
    res!(same(res!(b.write_file_if(&k, b"v2", Some(&v1)).await), None, "a write on what it saw"));
    res!(same(res!(b.read_file(&k).await), b"v2".to_vec(), "the matched write"));
    res!(same(res!(b.write_file_if(&k, b"v3", Some(&v1)).await),
        Some(Seen::Bytes(hash_of(b"v2"))), "a write on a stale sight"));
    res!(same(res!(b.read_file(&k).await), b"v2".to_vec(), "the file after a stale write"));
    let none = fmt!("{}/none", d);
    res!(same(res!(b.write_file_if(&none, b"x", Some(&v1)).await), Some(Seen::Absent),
        "a write expecting bytes, onto nothing"));
    want(!res!(b.exists(&none).await), "a file made by a refused write")
}

async fn cas_write_unread_refused<B: StoreBackend>(b: &B, d: &str) -> Outcome<()> {
    let k = fmt!("{}/f", d);
    res!(b.write_file(&k, b"kept").await);
    res!(want(b.write_file_if(&k, b"x", Some(&Seen::Unread)).await.is_err(),
        "a write bound to unread bytes"));
    res!(want(b.delete_file_if(&k, &Seen::Unread).await.is_err(), "a delete bound to unread bytes"));
    same(res!(b.read_file(&k).await), b"kept".to_vec(), "the file after both refusals")
}

/// A conditional write onto a folder.  OPFS compares before it opens the file, and finds no file
/// there, so one expecting bytes is told nothing stands; one expecting nothing, or anything, then
/// fails to open a folder as a file.  The folder and what is in it stand throughout.
async fn cas_write_onto_folder<B: StoreBackend>(b: &B, d: &str) -> Outcome<()> {
    let dir = fmt!("{}/dir", d);
    res!(b.write_file(&fmt!("{}/f", dir), b"x").await);
    res!(same(res!(b.write_file_if(&dir, b"y", Some(&Seen::Bytes(hash_of(b"y")))).await),
        Some(Seen::Absent), "a write expecting bytes, onto a folder"));
    res!(want(b.write_file_if(&dir, b"y", Some(&Seen::Absent)).await.is_err(),
        "a write expecting nothing, onto a folder"));
    res!(want(b.write_file_if(&dir, b"y", None).await.is_err(),
        "a write expecting anything, onto a folder"));
    same(res!(b.read_file(&fmt!("{}/f", dir)).await), b"x".to_vec(), "the folder's file after all three")
}

/// A refused conditional write still leaves the folders above its file.  OPFS makes them on its
/// way down, before it compares, so they stand whatever the compare says (D1j, d1oz-chk defect A).
async fn cas_refused_makes_parents<B: StoreBackend>(b: &B, d: &str) -> Outcome<()> {
    let k = fmt!("{}/new/f", d);
    res!(same(res!(b.write_file_if(&k, b"x", Some(&Seen::Bytes(hash_of(b"y")))).await),
        Some(Seen::Absent), "a write expecting bytes, onto nothing in a new folder"));
    res!(want(!res!(b.exists(&k).await), "a file made by a refused write"));
    let listed = res!(b.list_dir(d).await);
    want(listed.iter().any(|(n, is_dir, _)| n == "new" && *is_dir),
        "the refused write's parent folder")
}

/// A conditional write under a file, which a folder of that name cannot be made over, fails
/// whatever it expects, as OPFS's way down fails on the file; the file stands.
async fn cas_write_under_file_fails<B: StoreBackend>(b: &B, d: &str) -> Outcome<()> {
    let a = fmt!("{}/a", d);
    let k = fmt!("{}/b", a);
    res!(b.write_file(&a, b"x").await);
    res!(want(b.write_file_if(&k, b"y", Some(&Seen::Bytes(hash_of(b"y")))).await.is_err(),
        "a write expecting bytes, under a file"));
    res!(want(b.write_file_if(&k, b"y", Some(&Seen::Absent)).await.is_err(),
        "a write expecting nothing, under a file"));
    res!(want(b.write_file_if(&k, b"y", None).await.is_err(),
        "a write expecting anything, under a file"));
    same(res!(b.read_file(&a).await), b"x".to_vec(), "the file after all three")
}

async fn cas_delete<B: StoreBackend>(b: &B, d: &str) -> Outcome<()> {
    let k = fmt!("{}/f", d);
    res!(b.write_file(&k, b"v1").await);
    res!(same(res!(b.delete_file_if(&k, &Seen::Bytes(hash_of(b"v0"))).await),
        Some(Seen::Bytes(hash_of(b"v1"))), "a delete on a stale sight"));
    res!(want(res!(b.exists(&k).await), "the file after a stale delete"));
    res!(same(res!(b.delete_file_if(&k, &Seen::Absent).await),
        Some(Seen::Bytes(hash_of(b"v1"))), "a delete expecting nothing, of a file"));
    res!(same(res!(b.delete_file_if(&k, &Seen::Bytes(hash_of(b"v1"))).await), None,
        "a delete on what it saw"));
    res!(want(!res!(b.exists(&k).await), "the file after a matched delete"));
    res!(same(res!(b.delete_file_if(&k, &Seen::Absent).await), None,
        "a delete expecting nothing, of nothing"));
    res!(same(res!(b.delete_file_if(&k, &Seen::Bytes(hash_of(b"v1"))).await), Some(Seen::Absent),
        "a delete expecting bytes, of nothing"));
    same(res!(b.delete_file_if(&fmt!("{}/none/f", d), &Seen::Absent).await), None,
        "a delete expecting nothing, under a missing folder")
}

/// Two conditional writers on one key, started together: one wins, the other is told what the
/// winner left, and the file holds the winner's bytes.  The rule holds too when the rival is a
/// plain write: the conditional one either lands first and is overwritten, or finds the plain
/// bytes and is told so, and is never told it won over a plain write it overwrote.
async fn cas_race_one_wins<B: StoreBackend>(b: &B, d: &str) -> Outcome<()> {
    let k = fmt!("{}/f", d);
    for expect in [Seen::Absent, Seen::Bytes(hash_of(b"base"))] {
        let _ = b.delete_file(&k).await;
        if expect != Seen::Absent {
            res!(b.write_file(&k, b"base").await);
        }
        let (x, y) = join(b.write_file_if(&k, b"writer x", Some(&expect)),
            b.write_file_if(&k, b"writer y", Some(&expect))).await;
        let (x, y) = (res!(x), res!(y));
        let won: &[u8] = match (&x, &y) {
            (None, Some(_)) => b"writer x",
            (Some(_), None) => b"writer y",
            _               => return Err(err!("racing on {:?}: x answered {:?} and y {:?}; \
                exactly one should win", expect, x, y; Test)),
        };
        let lost = match (x, y) { (None, l) | (l, None) => l, _ => None };
        res!(same(lost, Some(Seen::Bytes(hash_of(won))), "what the loser was told"));
        res!(same(res!(b.read_file(&k).await), won.to_vec(), "the file after the race"));
    }
    res!(b.write_file(&k, b"base").await);
    let base = Seen::Bytes(hash_of(b"base"));
    let (cas, plain) = join(b.write_file_if(&k, b"cas", Some(&base)), b.write_file(&k, b"plain"))
        .await;
    let (cas, ()) = (res!(cas), res!(plain));
    let file = res!(b.read_file(&k).await);
    match (&cas, file.as_slice()) {
        (None, b"plain")                                                => Ok(()),
        (Some(Seen::Bytes(h)), b"plain") if *h == hash_of(b"plain")     => Ok(()),
        _                                                               => Err(err!("racing a plain write: the conditional write answered {:?} and the file \
            holds {:?}; the plain write was lost or the answer is wrong", cas,
            String::from_utf8_lossy(&file); Test)),
    }
}

async fn lock_if_available<B: StoreBackend>(b: &B, d: &str) -> Outcome<()> {
    let name = fmt!("{}/lock", d);
    res!(same(b.lock_held(&name).await, Some(false), "a lock nobody took, held"));
    let held = match b.lock(&name, LockHow::IfAvailable).await {
        Locked::Held(l) => l,
        other           => return Err(err!("a free lock asked for if available: {}",
            what_locked(&other); Test)),
    };
    res!(same(b.lock_held(&name).await, Some(true), "a taken lock, held"));
    match b.lock(&name, LockHow::IfAvailable).await {
        Locked::Busy    => {},
        other           => return Err(err!("a held lock asked for if available: {}",
            what_locked(&other); Test)),
    }
    b.release(held).await;
    res!(same(b.lock_held(&name).await, Some(false), "a released lock, held"));
    match b.lock(&name, LockHow::IfAvailable).await {
        Locked::Held(l) => { b.release(l).await; Ok(()) },
        other           => Err(err!("a released lock asked for again: {}", what_locked(&other); Test)),
    }
}

/// How many tasks a dropped lock may take to read free.  One is the rule; the rest is slack for a
/// busy page, and the bound keeps a lock never given back a failure here rather than a hang.
const DROP_ROUNDS: u32 = 20;

/// A lock that is only dropped is given back too, though not at once: within a task.  Each round
/// yields a whole task, not a microtask, as the lock manager in the tab needs.
async fn lock_dropped_free_next_task<B: StoreBackend>(b: &B, d: &str) -> Outcome<()> {
    let name = fmt!("{}/lock", d);
    let held = match b.lock(&name, LockHow::IfAvailable).await {
        Locked::Held(l) => l,
        other           => return Err(err!("a free lock asked for if available: {}",
            what_locked(&other); Test)),
    };
    drop(held);
    let mut rounds = 0;
    loop {
        match b.lock_held(&name).await {
            Some(false) => break,
            Some(true) if rounds < DROP_ROUNDS => { rounds += 1; next_task().await; },
            got => return Err(err!("a dropped lock, held after {} tasks: got {:?}, expected \
                Some(false)", rounds, got; Test)),
        }
    }
    match b.lock(&name, LockHow::IfAvailable).await {
        Locked::Held(l) => { b.release(l).await; Ok(()) },
        other           => Err(err!("a dropped lock, read free, asked for again: {}",
            what_locked(&other); Test)),
    }
}

/// A held lock asked for with a 60 ms limit times out, and only after waiting at least 50 ms.
async fn lock_timeout_expires<B: StoreBackend>(b: &B, d: &str) -> Outcome<()> {
    let name = fmt!("{}/lock", d);
    let held = match b.lock(&name, LockHow::Wait).await {
        Locked::Held(l) => l,
        other           => return Err(err!("a free lock waited for: {}", what_locked(&other); Test)),
    };
    let start = crate::store::own::now_ms();
    match b.lock(&name, LockHow::Timeout(60)).await {
        Locked::TimedOut => {},
        other            => return Err(err!("a held lock asked for with a time limit: {}",
            what_locked(&other); Test)),
    }
    let waited = crate::store::own::now_ms() - start;
    res!(want(waited >= 50.0, &fmt!("a 60 ms time limit reported reached after {} ms", waited)));
    res!(same(b.lock_held(&name).await, Some(true), "the lock still held after the time-out"));
    drop(held);
    match b.lock(&name, LockHow::Timeout(60)).await {
        Locked::Held(_) => Ok(()),
        other           => Err(err!("a free lock asked for with a time limit: {}",
            what_locked(&other); Test)),
    }
}

/// A waiter on a held lock is granted it once it is given back, and not before.  The waiter's
/// wait is bounded, so a waiter never woken is a failure here rather than a hang.
async fn lock_wait_until_released<B: StoreBackend>(b: &B, d: &str) -> Outcome<()> {
    let name = fmt!("{}/lock", d);
    let held = match b.lock(&name, LockHow::Wait).await {
        Locked::Held(l) => l,
        other           => return Err(err!("a free lock waited for: {}", what_locked(&other); Test)),
    };
    let released = Cell::new(false);
    let waiter = async {
        match b.lock(&name, LockHow::Timeout(2000)).await {
            Locked::Held(_)     => want(released.get(), "the waiter was granted the lock before it \
                was given back"),
            Locked::TimedOut    => Err(err!("the waiter was never woken: the lock was given back, \
                but it timed out after 2 s"; Test)),
            other               => Err(err!("a waiter: {}", what_locked(&other); Test)),
        }
    };
    let holder = async {
        for _ in 0..8 {
            yield_now().await;
        }
        released.set(true);
        drop(held);
    };
    let (got, ()) = join(waiter, holder).await;
    got
}

fn what_locked<L>(l: &Locked<L>) -> String {
    match l {
        Locked::Held(_)     => "held".to_string(),
        Locked::NoManager   => "no lock manager".to_string(),
        Locked::TimedOut    => "timed out".to_string(),
        Locked::Busy        => "busy".to_string(),
        Locked::Refused(w)  => fmt!("refused: {}", w),
    }
}

/// The cases as JSON, `[{"name":…,"ok":…,"why":…}]`, for the verifier.
pub fn to_json(cases: &[Case]) -> String {
    let esc = |s: &str| {
        let mut o = String::with_capacity(s.len() + 2);
        for c in s.chars() {
            match c {
                '"'                 => o.push_str("\\\""),
                '\\'                => o.push_str("\\\\"),
                c if (c as u32) < 0x20 => o.push_str(&fmt!("\\u{:04x}", c as u32)),
                c                   => o.push(c),
            }
        }
        o
    };
    let rows: Vec<String> = cases.iter().map(|c| fmt!("{{\"name\":\"{}\",\"ok\":{},\"why\":\"{}\"}}",
        c.name, c.failed.is_none(), esc(c.failed.as_deref().unwrap_or("")))).collect();
    fmt!("[{}]", rows.join(","))
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;
    use crate::store::mem::{MemBackend, MemLock};

    const ROOT: &str = "__conformance/native";

    fn failed(cases: &[Case]) -> Vec<&'static str> {
        cases.iter().filter(|c| c.failed.is_some()).map(|c| c.name).collect()
    }

    #[tokio::test]
    async fn mem_conforms() {
        let cases = run(&MemBackend::default(), ROOT).await;
        let names: Vec<&str> = cases.iter().map(|c| c.name).collect();
        assert_eq!(names, CASES, "every case ran, in order");
        let bad: Vec<String> = cases.iter()
            .filter_map(|c| c.failed.as_ref().map(|w| fmt!("{}: {}", c.name, w)))
            .collect();
        assert!(bad.is_empty(), "the memory store fails:\n{}", bad.join("\n"));
    }

    #[tokio::test]
    async fn suite_leaves_nothing() {
        let b = MemBackend::default();
        let _ = run(&b, ROOT).await;
        assert_eq!(b.list_dir("__conformance/native").await.map(|l| l.len()).ok(), Some(0));
    }

    /// A bug planted in the memory store, each of which the suite must catch by name.
    #[derive(Clone, Copy, Debug)]
    enum Bug {
        NoParents,          // a write under a missing folder fails
        MoveClobbers,       // a move replaces what stands at the target
        DeleteIgnoresFlag,  // a non-recursive delete takes a full folder
        CapTotal,           // a capped read says the prefix's length is the whole
        CasNotAtomic,       // a conditional write compares, lets others run, then writes
        CasMismatchSilent,  // a conditional write that finds otherwise says nothing
        CasIgnoresPlain,    // conditional writes shut each other out, but not a plain write
        LockAlwaysFree,     // asking if available never finds the lock busy
        TimeoutNeverExpires,// a time limit is never reached: it is busy at once
        TimeoutAtOnce,      // a time limit is reported reached at once, with no wait
        WaitIgnoresHolder,  // a waiter is granted while another holds the lock
        NeverWakes,         // a waiter is never woken when the lock is given back
        ReleaseNeverAwaits, // a release returns at once, and the lock goes free a task later
        DropNeverFrees,     // a dropped lock is never given back
    }

    struct Planted { mem: MemBackend, bug: Bug }

    enum PlantedLock { Mem(MemLock), Fake, Leaked(std::mem::ManuallyDrop<MemLock>) }

    fn plant(l: Locked<MemLock>) -> Locked<PlantedLock> {
        match l {
            Locked::Held(l)     => Locked::Held(PlantedLock::Mem(l)),
            Locked::NoManager   => Locked::NoManager,
            Locked::TimedOut    => Locked::TimedOut,
            Locked::Busy        => Locked::Busy,
            Locked::Refused(w)  => Locked::Refused(w),
        }
    }

    impl StoreBackend for Planted {
        type Lock = PlantedLock;

        async fn read_file(&self, key: &str) -> Outcome<Vec<u8>> { self.mem.read_file(key).await }
        async fn read_file_capped(&self, key: &str, max: u32) -> Outcome<(Vec<u8>, f64)> {
            let (bytes, total) = res!(self.mem.read_file_capped(key, max).await);
            match self.bug {
                Bug::CapTotal   => { let n = bytes.len() as f64; Ok((bytes, n)) },
                _               => Ok((bytes, total)),
            }
        }
        async fn write_file(&self, key: &str, bytes: &[u8]) -> Outcome<()> {
            if let Bug::NoParents = self.bug {
                if let Some((parent, _)) = key.rsplit_once('/') {
                    if !res!(self.mem.exists(parent).await) {
                        return Err(err!("no folder '{}'", parent; Test));
                    }
                }
            }
            self.mem.write_file(key, bytes).await
        }
        async fn write_file_if(&self, key: &str, bytes: &[u8], expect: Option<&Seen>)
            -> Outcome<Option<Seen>>
        {
            match (self.bug, expect) {
                (Bug::CasNotAtomic, Some(want)) => {
                    let found = match self.mem.read_file(key).await {
                        Ok(b)  => Seen::of(Some(&b)),
                        Err(_) => Seen::Absent,
                    };
                    if &found != want {
                        return Ok(Some(found));
                    }
                    yield_now().await;
                    res!(self.mem.write_file(key, bytes).await);
                    Ok(None)
                },
                (Bug::CasIgnoresPlain, Some(want)) => {
                    // A mutex only the conditional writers take: one CAS waits for another, but a
                    // plain write lands between the compare and the write.
                    let _cas = match self.mem.lock("__planted_cas", LockHow::Wait).await {
                        Locked::Held(l) => l,
                        _               => return Err(err!("the planted CAS mutex"; Test)),
                    };
                    let found = match self.mem.read_file(key).await {
                        Ok(b)  => Seen::of(Some(&b)),
                        Err(_) => Seen::Absent,
                    };
                    if &found != want {
                        return Ok(Some(found));
                    }
                    yield_now().await;
                    res!(self.mem.write_file(key, bytes).await);
                    Ok(None)
                },
                (Bug::CasMismatchSilent, _) => {
                    let got = res!(self.mem.write_file_if(key, bytes, expect).await);
                    Ok(got.map(|_| Seen::Absent).filter(|_| false))
                },
                _ => self.mem.write_file_if(key, bytes, expect).await,
            }
        }
        async fn exists(&self, key: &str) -> Outcome<bool> { self.mem.exists(key).await }
        async fn list_dir(&self, dir: &str) -> Outcome<Vec<(String, bool, u64)>> {
            self.mem.list_dir(dir).await
        }
        async fn list_dir_stamped(&self, dir: &str)
            -> Outcome<Vec<(String, bool, u64, Option<f64>)>>
        {
            self.mem.list_dir_stamped(dir).await
        }
        async fn stamp(&self, key: &str) -> Outcome<Option<(f64, f64)>> { self.mem.stamp(key).await }
        async fn delete_file(&self, key: &str) -> Outcome<()> { self.mem.delete_file(key).await }
        async fn delete_file_if(&self, key: &str, expect: &Seen) -> Outcome<Option<Seen>> {
            self.mem.delete_file_if(key, expect).await
        }
        async fn delete_entry(&self, key: &str, recursive: bool) -> Outcome<()> {
            match self.bug {
                Bug::DeleteIgnoresFlag  => self.mem.delete_entry(key, true).await,
                _                       => self.mem.delete_entry(key, recursive).await,
            }
        }
        async fn move_entry(&self, from: &str, to: &str) -> Outcome<()> {
            if let Bug::MoveClobbers = self.bug {
                let _ = self.mem.delete_entry(to, true).await;
            }
            self.mem.move_entry(from, to).await
        }
        async fn lock(&self, name: &str, how: LockHow) -> Locked<PlantedLock> {
            match (self.bug, how) {
                (Bug::DropNeverFrees, _) => match self.mem.lock(name, how).await {
                    Locked::Held(l) => Locked::Held(PlantedLock::Leaked(std::mem::ManuallyDrop::new(l))),
                    other           => plant(other),
                },
                (Bug::LockAlwaysFree, LockHow::IfAvailable) => match self.mem.lock(name, how).await {
                    Locked::Busy    => Locked::Held(PlantedLock::Fake),
                    other           => plant(other),
                },
                (Bug::TimeoutNeverExpires, LockHow::Timeout(_)) =>
                    plant(self.mem.lock(name, LockHow::IfAvailable).await),
                (Bug::TimeoutAtOnce, LockHow::Timeout(_)) =>
                    match self.mem.lock(name, LockHow::IfAvailable).await {
                        Locked::Busy    => Locked::TimedOut,
                        other           => plant(other),
                    },
                (Bug::WaitIgnoresHolder, LockHow::Wait | LockHow::Timeout(_)) =>
                    match self.mem.lock(name, LockHow::IfAvailable).await {
                        Locked::Busy    => Locked::Held(PlantedLock::Fake),
                        other           => plant(other),
                    },
                (Bug::NeverWakes, LockHow::Wait | LockHow::Timeout(_)) =>
                    match self.mem.lock(name, LockHow::IfAvailable).await {
                        Locked::Busy    => match how {
                            LockHow::Timeout(ms) => {
                                tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
                                Locked::TimedOut
                            },
                            _ => std::future::pending().await,
                        },
                        other           => plant(other),
                    },
                _ => plant(self.mem.lock(name, how).await),
            }
        }
        async fn lock_held(&self, name: &str) -> Option<bool> { self.mem.lock_held(name).await }
        async fn release(&self, lock: PlantedLock) {
            match (self.bug, lock) {
                // As the tab's lock manager does when nothing waits on the request's promise.
                (Bug::ReleaseNeverAwaits, PlantedLock::Mem(l)) => {
                    tokio::spawn(async move {
                        tokio::task::yield_now().await;
                        drop(l);
                    });
                },
                (_, PlantedLock::Mem(l))    => self.mem.release(l).await,
                (_, PlantedLock::Leaked(l)) => self.mem.release(std::mem::ManuallyDrop::into_inner(l)).await,
                (_, PlantedLock::Fake)      => {},
            }
        }
    }

    /// Red first: each planted bug fails the case named for it.
    #[tokio::test]
    async fn planted_bugs_fail_named_cases() {
        let table: &[(Bug, &[&str])] = &[
            (Bug::NoParents,            &["write_makes_parents", "move_file"]),
            (Bug::MoveClobbers,         &["move_refuses_existing"]),
            (Bug::DeleteIgnoresFlag,    &["delete_entry_recursion"]),
            (Bug::CapTotal,             &["capped_read_total"]),
            (Bug::CasNotAtomic,         &["cas_race_one_wins"]),
            (Bug::CasMismatchSilent,    &["cas_write_absent", "cas_write_match"]),
            (Bug::CasIgnoresPlain,      &["cas_race_one_wins"]),
            (Bug::LockAlwaysFree,       &["lock_if_available"]),
            (Bug::TimeoutNeverExpires,  &["lock_timeout_expires"]),
            (Bug::TimeoutAtOnce,        &["lock_timeout_expires"]),
            (Bug::WaitIgnoresHolder,    &["lock_wait_until_released"]),
            (Bug::NeverWakes,           &["lock_wait_until_released"]),
            (Bug::ReleaseNeverAwaits,   &["lock_if_available"]),
            (Bug::DropNeverFrees,       &["lock_dropped_free_next_task"]),
        ];
        let mut missed: Vec<String> = Vec::new();
        for (bug, named) in table {
            // A suite that hangs on a bug has not caught it by name.
            let planted = Planted { mem: MemBackend::default(), bug: *bug };
            let cases = match tokio::time::timeout(std::time::Duration::from_secs(10),
                run(&planted, ROOT)).await
            {
                Ok(c)   => c,
                Err(_)  => {
                    missed.push(fmt!("{:?}: the suite hung rather than failing a case", bug));
                    continue;
                },
            };
            let bad = failed(&cases);
            for n in named.iter() {
                if !bad.contains(n) {
                    missed.push(fmt!("{:?} should fail '{}', but failed only {:?}", bug, n, bad));
                }
            }
        }
        assert!(missed.is_empty(), "planted bugs the suite missed:\n{}", missed.join("\n"));
    }

    #[test]
    fn json_escapes() {
        let j = to_json(&[
            Case { name: "a", failed: None },
            Case { name: "b", failed: Some("say \"no\"\n\\".to_string()) },
        ]);
        assert_eq!(j, r#"[{"name":"a","ok":true,"why":""},{"name":"b","ok":false,"why":"say \"no\"\u000a\\"}]"#);
    }
}
