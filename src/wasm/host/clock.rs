//! WasmHost's clock port: the page's `Date` and `Math.random`, and today's `await_restored`.

use crate::engine::host::clock::HostClock;

/// WasmHost's clock port.
#[derive(Clone, Debug, Default)]
pub struct WasmClock;

impl HostClock for WasmClock {
    fn now_ms(&self) -> f64 { js_sys::Date::now() }
    fn utc_string(&self) -> String { String::from(js_sys::Date::new_0().to_utc_string()) }
    fn random_u32(&self) -> u32 { (js_sys::Math::random() * 4_294_967_296.0) as u32 }
    async fn await_restored(&self, waited: u64) -> u64 { crate::wasm::await_restored(waited).await }
    async fn sleep_ms(&self, ms: u64) { crate::llm::sleep_ms(ms).await }
}
