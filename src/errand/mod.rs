//! The errand, the report, the undo and the chat log's row: one codec for the tab and the runner
//! (P2.2, 30 Oct 2026).  It moved here from Kimberlite's `errands::codec` so the tab reaches the
//! same code through the wasm ([`crate::wasm::errand`]) rather than keeping its own copy.
//!
//! - [`codec`]: the peer envelopes, signed by digest (`sigv:2`) and sealed under the account key.
//! - [`json`]: JSON as the tab writes it, key order and number text kept.
//! - [`row`]: the chat log's row, its clear header and sealed body, and [`row::TurnView`], the
//!   one end-of-turn decision.

pub mod codec;
pub mod json;
pub mod row;

#[cfg(test)]
mod tests;

/// The environment variable a debug-build test names rules in, comma-separated, to switch them
/// off and see its own check fail.
pub const RULE_OFF_VAR: &str = "KIMBERLITE_RULE_OFF"; // fixed: the test harness's switch name

/// Whether a test has switched rule `rule` off, to see its own test fail (a red): named in
/// [`RULE_OFF_VAR`].  Never in a release build.
pub fn rule_off(rule: &str) -> bool {
    if !cfg!(debug_assertions) {
        return false;
    }
    match std::env::var(RULE_OFF_VAR) {
        Ok(v)   => v.split(',').any(|r| r.trim() == rule),
        Err(_)  => false,
    }
}
