//! TestHost's exec port: LocalHost's refusals.

use crate::engine::host::{
    exec::HostExec,
    local::exec::LocalExec,
};

use oxedyne_fe2o3_core::prelude::*;

/// TestHost's exec port.
#[derive(Clone, Debug, Default)]
pub struct TestExec;

impl HostExec for TestExec {
    fn present(&self) -> bool { LocalExec.present() }
    async fn status(&self) -> Outcome<String> { LocalExec.status().await }
    async fn held(&self, id: &str) -> Outcome<String> { LocalExec.held(id).await }
    async fn file(&self, spec_json: &str) -> Outcome<String> { LocalExec.file(spec_json).await }
    async fn run(&self, spec_json: &str) -> Outcome<String> { LocalExec.run(spec_json).await }
    async fn runs(&self) -> Outcome<String> { LocalExec.runs().await }
    async fn signal(&self, id: &str, sig: &str) -> Outcome<()> { LocalExec.signal(id, sig).await }
}
