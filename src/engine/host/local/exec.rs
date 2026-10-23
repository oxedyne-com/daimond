//! LocalHost's exec port.  The native half runs commands through `Executor::Local`.

use crate::engine::host::{
    exec::HostExec,
    local::fs::unavailable,
};

use oxedyne_fe2o3_core::prelude::*;

/// LocalHost's exec port.
#[derive(Clone, Debug, Default)]
pub struct LocalExec;

impl HostExec for LocalExec {
    fn present(&self) -> bool { false }
    async fn status(&self) -> Outcome<String> { unavailable("exec", "status") }
    async fn held(&self, _id: &str) -> Outcome<String> { unavailable("exec", "held") }
    async fn file(&self, _spec_json: &str) -> Outcome<String> { unavailable("exec", "file") }
    async fn run(&self, _spec_json: &str) -> Outcome<String> { unavailable("exec", "run") }
    async fn runs(&self) -> Outcome<String> { unavailable("exec", "runs") }
    async fn signal(&self, _id: &str, _sig: &str) -> Outcome<()> { unavailable("exec", "signal") }
}
