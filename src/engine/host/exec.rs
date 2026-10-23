//! The exec port: the machine Hand relay, as today.  After R10 the tab's host refuses here.

use oxedyne_fe2o3_core::prelude::*;

/// The exec port a [`Host`](super::Host) carries: today's `hand` functions, by the same names.
#[allow(async_fn_in_trait)]
pub trait HostExec {
    fn present(&self) -> bool;
    async fn status(&self) -> Outcome<String>;
    async fn held(&self, id: &str) -> Outcome<String>;
    async fn file(&self, spec_json: &str) -> Outcome<String>;
    async fn run(&self, spec_json: &str) -> Outcome<String>;
    async fn runs(&self) -> Outcome<String>;
    async fn signal(&self, id: &str, sig: &str) -> Outcome<()>;
}
