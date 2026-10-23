//! LocalHost's clock port: the machine's own clock.  Nothing here gates an act.

use crate::engine::host::clock::HostClock;

use std::time::{
    SystemTime,
    UNIX_EPOCH,
};

/// LocalHost's clock port.
#[derive(Clone, Debug, Default)]
pub struct LocalClock;

impl LocalClock {
    fn since_epoch() -> std::time::Duration {
        match SystemTime::now().duration_since(UNIX_EPOCH) {
            Ok(d)  => d,
            Err(_) => std::time::Duration::ZERO,
        }
    }
}

impl HostClock for LocalClock {
    fn now_ms(&self) -> f64 { Self::since_epoch().as_millis() as f64 }
    // The native half spells no dates through the port, so there is nothing to spell.
    fn utc_string(&self) -> String { String::new() }
    fn random_u32(&self) -> u32 { Self::since_epoch().subsec_nanos() }
    async fn await_restored(&self, _waited: u64) -> u64 { 0 }
    async fn sleep_ms(&self, ms: u64) { crate::llm::sleep_ms(ms).await }
}
