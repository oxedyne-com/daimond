//! TestHost's clock port: a fake clock, so a test's output never depends on when it ran.  It
//! stands still unless a test moves it ([`TestClock::advance`]); clones share one time.

use crate::engine::host::clock::HostClock;

use std::{
    cell::Cell,
    future::poll_fn,
    rc::Rc,
    task::Poll,
};

/// Where every TestClock starts.
pub const TEST_EPOCH_MS: f64 = 1_700_000_000_000.0;

/// TestHost's clock port.
#[derive(Clone, Debug)]
pub struct TestClock {
    now: Rc<Cell<f64>>,
}

impl Default for TestClock {
    fn default() -> Self {
        Self { now: Rc::new(Cell::new(TEST_EPOCH_MS)) }
    }
}

impl TestClock {
    /// Move the clock on by `ms`.
    pub fn advance(&self, ms: u64) {
        self.now.set(self.now.get() + ms as f64);
    }
}

impl HostClock for TestClock {
    fn now_ms(&self) -> f64 { self.now.get() }
    fn utc_string(&self) -> String { String::from("Tue, 14 Nov 2023 22:13:20 GMT") }
    fn random_u32(&self) -> u32 { 4 }
    async fn await_restored(&self, _waited: u64) -> u64 { 0 }
    /// Time moves only when a test moves it, so a wait is one yield: the waiter looks again.
    async fn sleep_ms(&self, _ms: u64) {
        let mut yielded = false;
        poll_fn(|cx| {
            if yielded {
                Poll::Ready(())
            } else {
                yielded = true;
                cx.waker().wake_by_ref();
                Poll::Pending
            }
        }).await
    }
}
