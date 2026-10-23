//! The types the ports name, moved here from `src/wasm/` so both targets see them; `src/wasm/`
//! keeps a `pub use` of each, so its callers do not change.

pub mod clock;
pub mod exec;
pub mod fs;
pub mod net;
pub mod store;
pub mod ui;
pub mod web;
