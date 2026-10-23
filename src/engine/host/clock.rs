//! The clock port: the time, a random word, and the wait for a frozen page to come back.

/// The clock port a [`Host`](super::Host) carries.
#[allow(async_fn_in_trait)]
pub trait HostClock {
    /// Milliseconds since the epoch, as `Date.now()` gives them.
    fn now_ms(&self) -> f64;
    /// The time now, as `Date.prototype.toUTCString` spells it.
    fn utc_string(&self) -> String;
    fn random_u32(&self) -> u32;
    /// Today's `crate::wasm::await_restored`: milliseconds spent waiting for the page to be seen.
    async fn await_restored(&self, waited: u64) -> u64;
    /// Wait about `ms` milliseconds.  A caller reads [`HostClock::now_ms`] again after it, so a
    /// wait that wakes early only costs another look.
    async fn sleep_ms(&self, ms: u64);
}
