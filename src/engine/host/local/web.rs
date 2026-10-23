//! LocalHost's web port.

use crate::engine::host::{
    local::fs::unavailable,
    web::HostWeb,
};

use oxedyne_fe2o3_core::prelude::*;

/// LocalHost's web port.
#[derive(Clone, Debug, Default)]
pub struct LocalWeb;

impl HostWeb for LocalWeb {
    async fn open(&self, _url: &str, _owner: &str, _turn: &str) -> Outcome<String> {
        unavailable("web", "open")
    }
    async fn close(&self) -> Outcome<String> { unavailable("web", "close") }
    async fn read(&self) -> Outcome<String> { unavailable("web", "read") }
    async fn snapshot(&self) -> Outcome<String> { unavailable("web", "snapshot") }
    async fn click(&self, _node_ref: u32) -> Outcome<String> { unavailable("web", "click") }
    async fn type_into(&self, _node_ref: u32, _text: &str, _submit: bool) -> Outcome<String> {
        unavailable("web", "type_into")
    }
    async fn scroll(&self, _dir: &str, _amount: Option<u32>) -> Outcome<String> {
        unavailable("web", "scroll")
    }
    async fn current_url(&self) -> String { String::new() }
}
