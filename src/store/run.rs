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
#[path = "../../tests/unit/store/run/tests.rs"]
mod tests;
