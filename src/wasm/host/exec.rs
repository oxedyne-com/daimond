//! WasmHost's exec port: each method is one call to today's `hand` relay.

use crate::{
    engine::host::exec::HostExec,
    wasm::hand,
};

use oxedyne_fe2o3_core::prelude::*;

/// WasmHost's exec port.
#[derive(Clone, Debug, Default)]
pub struct WasmExec;

impl HostExec for WasmExec {
    fn present(&self) -> bool { hand::present() }
    async fn status(&self) -> Outcome<String> { hand::status().await }
    async fn held(&self, id: &str) -> Outcome<String> { hand::held(id).await }
    async fn file(&self, spec_json: &str) -> Outcome<String> { hand::file(spec_json).await }
    async fn run(&self, spec_json: &str) -> Outcome<String> { hand::run(spec_json).await }
    async fn runs(&self) -> Outcome<String> { hand::runs().await }
    async fn signal(&self, id: &str, sig: &str) -> Outcome<()> { hand::signal(id, sig).await }
}
