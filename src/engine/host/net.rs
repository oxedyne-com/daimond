//! The net port: fetch and search through the gateway, the egress questions, and OCR.
//!
//! A host that cannot ask the user answers every egress question with its refusing value, never
//! a yes.

use crate::{
    engine::host::types::net::RawPage,
    tools::{
        EgressWord,
        Permit,
        SearchAnswer,
        Verdict,
    },
};

use oxedyne_fe2o3_core::prelude::*;

/// The net port a [`Host`](super::Host) carries: today's `web` fetch and egress functions and
/// `ocr`, by the same names.
#[allow(async_fn_in_trait)]
pub trait HostNet {
    async fn fetch(&self, url: &str) -> Outcome<String>;
    async fn fetch_raw(&self, url: &str) -> Outcome<RawPage>;
    async fn search(&self, query: &str, kind: &str, limit: Option<u32>) -> Outcome<SearchAnswer>;
    async fn egress_reach(&self, turn: &str, tool: &str, url: &str, granted: bool) -> EgressWord;
    async fn egress_allowed_detail(&self, turn: &str, tool: &str, url: &str, detail: &str)
        -> Option<Verdict>;
    async fn egress_allowed_act(&self, turn: &str, tool: &str, url: &str, detail: &str, alone: bool)
        -> Option<Verdict>;
    async fn egress_allowed_kit(&self, turn: &str, cmd: &str, detail: &str) -> Option<Permit>;
    async fn egress_allowed_net(&self, turn: &str, cmd: &str, cwd: &str) -> Option<Verdict>;
    async fn egress_allowed_place(&self, turn: &str, path: &str, detail: &str) -> Option<Permit>;
    async fn egress_allowed_publish(&self, turn: &str, shown: &str) -> Option<Verdict>;
    async fn egress_allowed_run(&self, turn: &str, tool: &str, cmd: &str, cwd: &str) -> Option<Permit>;
    async fn openrouter_chat(&self, body: &str) -> Outcome<String>;
    async fn image_ocr(&self, mistral_body: &str, vision_body: &str) -> Outcome<(String, String)>;
    /// The account's "Image editing" model and its catalogue price, or the refusal saying why
    /// there is none (no key, no credits, no model that takes a picture in).
    async fn image_model(&self) -> Outcome<crate::image_edit::ImageModel>;
    /// POST an Image API body to OpenRouter's `/images` on the account's own route, never the
    /// gateway; the raw reply, with any `url` result already fetched into `b64_json`.
    async fn openrouter_images(&self, body: &str) -> Outcome<String>;
}
