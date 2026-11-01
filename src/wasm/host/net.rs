//! WasmHost's net port: each method is one call to today's `web` or `ocr` function.

use crate::{
    engine::host::{
        net::HostNet,
        types::net::RawPage,
    },
    tools::{
        address_reach,
        mode,
        query_reach,
        EgressWord,
        Mode,
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
///
/// It answers the tainted reading gate by the rule Kimberlite's run port does (D1 by provenance;
/// UNBLOCK-88), from what the engine says this conversation was shown: it keeps nothing itself,
/// since one tab client serves several Diamonds.
#[derive(Clone, Debug, Default)]
pub struct WasmNet;

impl WasmNet {
    /// Whether the tainted reading gate is D1's, answered here with nobody asked: the default rung.
    /// On `Ask` he chose to be put every question, so the page still puts it.
    fn d1() -> bool {
        matches!(mode(), Mode::Guarded)
    }
}

impl HostNet for WasmNet {
    async fn fetch(&self, url: &str) -> Outcome<String> { web::fetch(url).await }
    async fn fetch_raw(&self, url: &str) -> Outcome<RawPage> { web::fetch_raw(url).await }
    async fn search(&self, query: &str, kind: &str, limit: Option<u32>) -> Outcome<SearchAnswer> {
        web::search(query, kind, limit).await
    }
    // D1 on the tab as on a runner (his pick 1 Nov 22:43, "Just run"): a tainted chat's later
    // fetches run with nobody asked, and only an address of the payload's shape no result or page
    // showed it is refused, in `heavy_refusal`'s words.  Before UNBLOCK-88 the page asked him.
    async fn egress_reach(&self, turn: &str, tool: &str, url: &str, granted: bool, shown: bool)
        -> EgressWord
    {
        match Self::d1() {
            true    => address_reach(url, shown),
            false   => web::egress_reach(turn, tool, url, granted).await,
        }
    }
    async fn egress_allowed_detail(&self, turn: &str, tool: &str, url: &str, detail: &str)
        -> Option<Verdict>
    {
        web::egress_allowed_detail(turn, tool, url, detail).await
    }
    // A search query by the same rule: an ordinary one runs, a heavy one is refused, nobody asked.
    // On `Ask` the page puts it, and its answer is about this one query.
    async fn egress_query(&self, turn: &str, tool: &str, query: &str) -> Option<EgressWord> {
        match Self::d1() {
            true    => Some(query_reach(query)),
            false   => web::egress_allowed_detail(turn, tool, crate::tools::SEARCH_ENDPOINT, query).await
                .map(EgressWord::Once),
        }
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
    async fn image_model(&self) -> Outcome<crate::image_edit::ImageModel> {
        ocr::image_model().await
    }
    async fn openrouter_images(&self, body: &str) -> Outcome<String> {
        ocr::openrouter_images(body).await
    }
}
