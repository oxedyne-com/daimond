//! NativeHost's clock port: the process clock, `fe2o3_core::time::clock`, which a test rig drives
//! from a file (U2's driven source) and is otherwise the machine's.  Nothing here gates an act.

use crate::engine::host::clock::HostClock;

use oxedyne_fe2o3_core::time::clock;

/// NativeHost's clock port.
#[derive(Clone, Debug, Default)]
pub struct NativeClock;

impl HostClock for NativeClock {
    fn now_ms(&self) -> f64 {
        match clock().now_millis() {
            Ok(ms)  => ms as f64,
            Err(_)  => 0.0,
        }
    }
    // The native half spells no dates through the port, so there is nothing to spell.
    fn utc_string(&self) -> String { String::new() }
    fn random_u32(&self) -> u32 {
        match clock().now_nanos() {
            Ok(ns)  => (ns % 1_000_000_000) as u32,
            Err(_)  => 0,
        }
    }
    async fn await_restored(&self, _waited: u64) -> u64 { 0 }
    // The lease bound's wait (U4b `Renewal::lapsed`), as LocalHost's.
    async fn sleep_ms(&self, ms: u64) { crate::llm::sleep_ms(ms).await }
}
