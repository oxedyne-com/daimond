//! WasmHost's web port: each method is one call to today's `web` acting function.

use crate::{
    engine::host::web::HostWeb,
    wasm::web,
};

use oxedyne_fe2o3_core::prelude::*;

/// WasmHost's web port.
#[derive(Clone, Debug, Default)]
pub struct WasmWeb;

impl HostWeb for WasmWeb {
    async fn open(&self, url: &str, owner: &str, turn: &str) -> Outcome<String> {
        web::open(url, owner, turn).await
    }
    async fn close(&self) -> Outcome<String> { web::close().await }
    async fn read(&self) -> Outcome<String> { web::read().await }
    async fn snapshot(&self) -> Outcome<String> { web::snapshot().await }
    async fn click(&self, node_ref: u32) -> Outcome<String> { web::click(node_ref).await }
    async fn type_into(&self, node_ref: u32, text: &str, submit: bool) -> Outcome<String> {
        web::type_into(node_ref, text, submit).await
    }
    async fn scroll(&self, dir: &str, amount: Option<u32>) -> Outcome<String> {
        web::scroll(dir, amount).await
    }
    async fn current_url(&self) -> String { web::current_url().await }
}
