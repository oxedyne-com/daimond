//! WasmHost's net port: each method is one call to today's `web` or `ocr` function.

use crate::{
    engine::host::{
        net::HostNet,
        types::net::RawPage,
    },
    tools::{
        EgressWord,
        Permit,
        SearchAnswer,
        Verdict,
    },
    wasm::{
        ocr,
        web,
    },
};

use oxedyne_fe2o3_core::prelude::*;

/// WasmHost's net port.
#[derive(Clone, Debug, Default)]
pub struct WasmNet;

impl HostNet for WasmNet {
    async fn fetch(&self, url: &str) -> Outcome<String> { web::fetch(url).await }
    async fn fetch_raw(&self, url: &str) -> Outcome<RawPage> { web::fetch_raw(url).await }
    async fn search(&self, query: &str, kind: &str, limit: Option<u32>) -> Outcome<SearchAnswer> {
        web::search(query, kind, limit).await
    }
    async fn egress_reach(&self, turn: &str, tool: &str, url: &str, granted: bool) -> EgressWord {
        web::egress_reach(turn, tool, url, granted).await
    }
    async fn egress_allowed_detail(&self, turn: &str, tool: &str, url: &str, detail: &str)
        -> Option<Verdict>
    {
        web::egress_allowed_detail(turn, tool, url, detail).await
    }
    async fn egress_allowed_act(&self, turn: &str, tool: &str, url: &str, detail: &str, alone: bool)
        -> Option<Verdict>
    {
        web::egress_allowed_act(turn, tool, url, detail, alone).await
    }
    async fn egress_allowed_kit(&self, turn: &str, cmd: &str, detail: &str) -> Option<Permit> {
        web::egress_allowed_kit(turn, cmd, detail).await
    }
    async fn egress_allowed_net(&self, turn: &str, cmd: &str, cwd: &str) -> Option<Verdict> {
        web::egress_allowed_net(turn, cmd, cwd).await
    }
    async fn egress_allowed_place(&self, turn: &str, path: &str, detail: &str) -> Option<Permit> {
        web::egress_allowed_place(turn, path, detail).await
    }
    async fn egress_allowed_publish(&self, turn: &str, shown: &str) -> Option<Verdict> {
        web::egress_allowed_publish(turn, shown).await
    }
    async fn egress_allowed_run(&self, turn: &str, tool: &str, cmd: &str, cwd: &str)
        -> Option<Permit>
    {
        web::egress_allowed_run(turn, tool, cmd, cwd).await
    }
    async fn openrouter_chat(&self, body: &str) -> Outcome<String> {
        ocr::openrouter_chat(body).await
    }
    async fn image_ocr(&self, mistral_body: &str, vision_body: &str) -> Outcome<(String, String)> {
        ocr::image_ocr(mistral_body, vision_body).await
    }
}
