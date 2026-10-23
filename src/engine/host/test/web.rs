//! TestHost's web port: LocalHost's refusals.

use crate::engine::host::{
    local::web::LocalWeb,
    web::HostWeb,
};

use oxedyne_fe2o3_core::prelude::*;

/// TestHost's web port.
#[derive(Clone, Debug, Default)]
pub struct TestWeb;

impl HostWeb for TestWeb {
    async fn open(&self, url: &str, owner: &str, turn: &str) -> Outcome<String> {
        LocalWeb.open(url, owner, turn).await
    }
    async fn close(&self) -> Outcome<String> { LocalWeb.close().await }
    async fn read(&self) -> Outcome<String> { LocalWeb.read().await }
    async fn snapshot(&self) -> Outcome<String> { LocalWeb.snapshot().await }
    async fn click(&self, node_ref: u32) -> Outcome<String> { LocalWeb.click(node_ref).await }
    async fn type_into(&self, node_ref: u32, text: &str, submit: bool) -> Outcome<String> {
        LocalWeb.type_into(node_ref, text, submit).await
    }
    async fn scroll(&self, dir: &str, amount: Option<u32>) -> Outcome<String> {
        LocalWeb.scroll(dir, amount).await
    }
    async fn current_url(&self) -> String { LocalWeb.current_url().await }
}
