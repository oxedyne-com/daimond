//! The run a native store call is made for (d1_plan §9.2 D1s2a, spec §16).
//!
//! In the tab the store's environment is its page: the folder open, the folders the device knows
//! and the page's own name.  Natively one store answers many runs, so each call carries its run's
//! environment as a [`RunEnv`] in a `tokio::task_local!`, set around the call with
//! [`RunEnv::scope`].  **Never a thread-local "current run"**: two calls interleaved at their
//! awaits on one thread would each read the other's.
//!
//! Which pages are still live is the store thread's own table ([`mark_live`], [`mark_dead`]): a
//! note a live run left is that run's, and only a dead run's is adopted by another's turn end.

use std::{
    cell::RefCell,
    collections::BTreeSet,
    future::Future,
};

/// What one run's store calls see of their environment.  Set by the relay, never taken from a
/// call's payload.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct RunEnv {
    /// The run's id.
    pub run:        String,
    /// The Diamonds this run may touch (carried here; the store server refuses a call outside).
    pub diamonds:   BTreeSet<String>,
    /// The id of the folder open for the run, if one is.
    pub folder_id:  Option<String>,
    /// The folders the run's device knows.
    pub known:      BTreeSet<String>,
    /// The page name the run's notes are stamped with.
    pub page:       String,
}

tokio::task_local! {
    static RUN: RunEnv;
}

thread_local! {
    // The pages live on this store thread, besides the calling run's own.
    static LIVE: RefCell<BTreeSet<String>> = RefCell::new(BTreeSet::new());
}

impl RunEnv {
    /// Run `fut` with this as its run's environment, across every await inside it.
    pub async fn scope<F: Future>(self, fut: F) -> F::Output {
        RUN.scope(self, fut).await
    }

    /// Run `f` with this as its run's environment.
    pub fn sync_scope<R>(self, f: impl FnOnce() -> R) -> R {
        RUN.sync_scope(self, f)
    }
}

/// `f` of the calling run's environment, or `None` outside any [`RunEnv::scope`].
pub fn current<R>(f: impl FnOnce(&RunEnv) -> R) -> Option<R> {
    RUN.try_with(f).ok()
}

/// Mark `page` live on this store thread: its notes are its own until it is marked dead.
pub fn mark_live(page: &str) {
    LIVE.with(|l| l.borrow_mut().insert(page.to_string()));
}

/// Mark `page` dead on this store thread: its notes are adopted by the next turn end.
pub fn mark_dead(page: &str) {
    LIVE.with(|l| l.borrow_mut().remove(page));
}

/// Is `page` the calling run's own, or one marked live on this store thread?
pub fn page_is_live(page: &str, this: &str) -> bool {
    page == this || LIVE.with(|l| l.borrow().contains(page))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        engine::host::test::TestHost,
        executor::Executor,
        store::{
            diamond,
            install,
            mem::MemBackend,
            native::NativeBackend,
            own,
            StoreBackend,
        },
        tools::{FileRoot, ToolContext, new_read_cache},
        workspace::Workspace,
    };

    use oxedyne_fe2o3_core::prelude::*;

    // A turn's context over a scratch workspace: the store reads nothing through it here.
    fn turn_ctx() -> ToolContext<TestHost> {
        let dir = match oxedyne_fe2o3_test::scratch::scratch_dir("store_run_env") {
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

    fn env(page: &str, folder: Option<&str>) -> RunEnv {
        RunEnv {
            run:        page.to_string(),
            diamonds:   ["d".to_string()].into_iter().collect(),
            folder_id:  folder.map(str::to_string),
            known:      folder.into_iter().map(str::to_string).collect(),
            page:       page.to_string(),
        }
    }

    // The worker's act in flight: its room reserved and its note left, in its own scope.
    async fn worker_pends(path: &str) {
        env("worker", None).scope(async {
            let found = crate::diamond_versions::Found::Unread;
            match diamond::captured_room("d", path, &found, Some(3), false, u64::MAX) {
                Ok(true) => (),
                other    => panic!("the worker's room: {:?}", other),
            }
            match diamond::pend("d", path, b"old", false, false).await {
                Ok(true) => (),
                other    => panic!("the worker's note: {:?}", other),
            }
        }).await;
    }

    // The conductor's turn end: the paths it records and the notes it settles.
    async fn conductor_drains() -> (Vec<String>, Vec<String>) { drains("conductor").await }

    // The turn end of the run `page`: the paths it records and the notes it settles.
    async fn drains(page: &str) -> (Vec<String>, Vec<String>) {
        env(page, None).scope(async {
            let hold = match diamond::hold_versions("d").await {
                Ok(h)  => h,
                Err(e) => panic!("the version hold: {}", e),
            };
            let (captured, notes, _) = diamond::drain_turn(&hold, "d", &turn_ctx()).await;
            (captured.into_iter().map(|(p, _)| p).collect(), notes)
        }).await
    }

    /// A live worker's note is its own: the conductor's turn end leaves it (D1x (4)).  Marked
    /// dead, the worker's note is adopted by the next turn end, as a dead page's is in the tab.
    #[tokio::test]
    async fn live_run_note_is_not_adopted_until_dead() {
        let _ = install(NativeBackend::Mem(MemBackend::default()));
        let path = "/m/a.txt";
        mark_live("worker");
        worker_pends(path).await;
        let (captured, notes) = conductor_drains().await;
        assert!(captured.is_empty(), "a live run's note was adopted: {:?}", captured);
        assert!(notes.is_empty(), "a live run's note was settled: {:?}", notes);
        mark_dead("worker");
        let (captured, notes) = conductor_drains().await;
        assert_eq!(captured, vec![path.to_string()], "the dead run's note was not adopted");
        assert_eq!(notes.len(), 1, "the dead run's note was not settled: {:?}", notes);
        assert!(notes[0].starts_with("worker-"), "settled another note: {:?}", notes);
        let _ = install(NativeBackend::Closed);
    }

    fn change(path: &str) -> crate::diamond_versions::Change {
        crate::diamond_versions::Change {
            path:    path.to_string(),
            after:   crate::diamond_versions::Body::Held(b"new".to_vec()),
            before:  Some(crate::diamond_versions::Prior::Held(b"old".to_vec())),
            found:   crate::diamond_versions::Found::Unread,
            carried: None,
            mark:    false,
            refused: None,
            wiped:   false,
            folder:  None,
            by:      None,
            door:    false,
        }
    }

    /// A live worker's note on a path the conductor also captured stays the worker's: the
    /// conductor's turn end records its own capture and settles nothing of the worker's, and a
    /// capture the worker made is not the conductor's (d1_plan §9.11, D1s2a check riders).
    #[tokio::test]
    async fn live_worker_sharing_a_path_keeps_its_note_and_capture() {
        let _ = install(NativeBackend::Mem(MemBackend::default()));
        let path = "/m/shared.txt";
        mark_live("worker");
        worker_pends(path).await;
        env("worker", None).sync_scope(|| diamond::capture("d", "w.txt", change("/m/w.txt")));
        env("conductor", None).sync_scope(|| {
            let found = crate::diamond_versions::Found::Unread;
            match diamond::captured_room("d", path, &found, Some(3), false, u64::MAX) {
                Ok(true) => (),
                other    => panic!("the conductor's room: {:?}", other),
            }
            diamond::capture("d", path, change(path));
        });
        let (captured, notes) = conductor_drains().await;
        assert_eq!(captured, vec![path.to_string()], "the conductor's turn is its own capture");
        assert!(notes.is_empty(), "the conductor settled a live worker's note: {:?}", notes);
        mark_dead("worker");
        let _ = install(NativeBackend::Closed);
    }

    // The restore `t`'s act on `path` from the run `page`: its keep, and its hold let go.
    async fn restore_keeps(page: &str, t: u64, path: &str, now: &[u8]) {
        env(page, None).scope(async {
            match diamond::restore_keep(t, path, Some(now), false).await {
                Ok(())  => (),
                Err(e)  => panic!("the restore's keep: {}", e),
            }
            diamond::test_restore_unhold(t);
        }).await
    }

    /// A restore that ends another run's capture settles THAT run's note (d1v1 check D1): the
    /// worker's turn end then records nothing of the path, which the restore's end of the run
    /// already made a version.
    #[tokio::test]
    async fn a_restore_ending_another_runs_capture_settles_that_runs_note() {
        let mem = MemBackend::default();
        let _ = install(NativeBackend::Mem(mem.clone()));
        let _ = mem.write_file("diamonds/d/.daimond/meta.json",
            br#"{"name":"d","crystal_version":0,"updated":0,"touched":0}"#).await;
        let path = "/m/r.txt";
        mark_live("worker");
        mark_live("door");
        worker_pends(path).await;
        env("worker", None).sync_scope(|| diamond::capture("d", path, change(path)));
        let t = env("door", None).scope(diamond::test_restore_open("d")).await;
        restore_keeps("door", t, path, b"new").await;
        let (captured, notes) = drains("worker").await;
        diamond::test_restore_end(t);
        mark_dead("worker");
        mark_dead("door");
        let _ = install(NativeBackend::Closed);
        assert!(captured.is_empty(), "the restore's run was adopted again: {:?}", captured);
        assert!(notes.is_empty(), "a note was left for the worker to settle: {:?}", notes);
    }

    /// A door run dropped while its restore is open leaves its note to the restore's close (d1v1
    /// check D2): the restore's lock is named after the parent's page, so the dead door page's
    /// lock never reads held, and natively the restore's openness alone holds the note back.
    #[tokio::test]
    async fn a_dropped_door_runs_restore_note_waits_for_the_close() {
        let _ = install(NativeBackend::Mem(MemBackend::default()));
        let path = "r2.txt";
        mark_live("door");
        let t = env("parent", None).scope(diamond::test_restore_open("d")).await;
        restore_keeps("door", t, path, b"old").await;
        mark_dead("door");
        let (captured, notes) = conductor_drains().await;
        let wants = env("conductor", None).scope(diamond::turn_wants("d")).await;
        diamond::test_restore_end(t);
        let _ = install(NativeBackend::Closed);
        assert!(captured.is_empty(), "an open restore's note was adopted: {:?}", captured);
        assert!(notes.is_empty(), "an open restore's note was settled: {:?}", notes);
        assert!(wants.notes.is_empty(), "an open restore's note was wanted: {:?}", wants.notes);
    }

    /// A run that ran a command keeps its flag for its own turn end (d1v1 check H3): another run's
    /// turn end does not take it, so the run still reads its captures as a command's may have
    /// changed them.
    #[tokio::test]
    async fn a_runs_command_flag_is_its_own() {
        let _ = install(NativeBackend::Mem(MemBackend::default()));
        let path = "o.txt";
        mark_live("worker");
        env("worker", None).sync_scope(|| {
            diamond::capture("d", path, change(path));
            diamond::ran_opaque("d");
        });
        let _ = conductor_drains().await;
        let wants = env("worker", None).scope(diamond::turn_wants("d")).await;
        let (captured, _) = drains("worker").await;
        mark_dead("worker");
        let _ = install(NativeBackend::Closed);
        assert!(wants.own.is_empty(), "the worker's command flag was taken: {:?}", wants.own);
        assert_eq!(captured, vec![path.to_string()], "the worker's own capture");
    }

    /// The 64-change cap counts every run on the Diamond, as the tab counts a daimon and its
    /// workers together, though each run's turn end takes only its own.
    #[test]
    fn the_cap_counts_every_run() {
        let found = crate::diamond_versions::Found::Unread;
        env("w64", None).sync_scope(|| {
            for n in 0..crate::diamond_versions::TURN_FILES_MAX - 1 {
                match diamond::captured_room("d64", &fmt!("/m/{}", n), &found, Some(1), false,
                    u64::MAX)
                {
                    Ok(true) => (),
                    other    => panic!("the worker's room {}: {:?}", n, other),
                }
            }
        });
        env("c64", None).sync_scope(|| {
            assert_eq!(diamond::captured_room("d64", "/m/last", &found, Some(1), false, u64::MAX),
                Ok(true), "the last of the cap");
            assert_eq!(diamond::captured_room("d64", "/m/over", &found, Some(1), false, u64::MAX),
                Err(crate::diamond_versions::Short::Count), "past the cap, over every run");
        });
        diamond::forget_page("w64");
        diamond::forget_page("c64");
    }

    /// No note is stamped for no run: a `pend` outside any [`RunEnv`] is refused.
    #[tokio::test]
    async fn pend_outside_a_run_is_refused() {
        let _ = install(NativeBackend::Mem(MemBackend::default()));
        let got = diamond::pend("d", "/m/none.txt", b"old", false, false).await;
        let _ = install(NativeBackend::Closed);
        assert!(got.is_err(), "a note with no run: {:?}", got);
    }

    /// Two calls interleaved on one thread, each in its own scope, each see their own folder
    /// across an await.
    #[tokio::test]
    async fn interleaved_scopes_see_their_own_folder() {
        let (tx_a, rx_a) = tokio::sync::oneshot::channel::<()>();
        let (tx_b, rx_b) = tokio::sync::oneshot::channel::<()>();
        let a = env("a", Some("fa")).scope(async move {
            let before = own::folder_id();
            let _ = tx_b.send(());
            let _ = rx_a.await;
            (before, own::folder_id(), own::folder_known("fa"), own::this_page())
        });
        let b = env("b", Some("fb")).scope(async move {
            let _ = rx_b.await;
            let before = own::folder_id();
            let _ = tx_a.send(());
            tokio::task::yield_now().await;
            (before, own::folder_id(), own::folder_known("fa"), own::this_page())
        });
        let (ra, rb) = tokio::join!(a, b);
        let fa = Some("fa".to_string());
        let fb = Some("fb".to_string());
        assert_eq!(ra, (fa.clone(), fa, true, "a".to_string()), "run a's view");
        assert_eq!(rb, (fb.clone(), fb, false, "b".to_string()), "run b's view");
        assert_eq!(own::folder_id(), None, "outside any scope");
        assert!(!own::folder_open(), "outside any scope");
    }
}
