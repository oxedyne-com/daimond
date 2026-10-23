//! LocalHost's net port.  Nobody can be asked here, so every egress question is refused; the
//! native half's own yes-saying stubs are never copied into a port (plan §9.2).

use crate::{
    engine::host::{
        local::fs::unavailable,
        net::HostNet,
        types::net::RawPage,
    },
    tools::{
        EgressWord,
        Permit,
        PermitNo,
        SearchAnswer,
        Verdict,
    },
};

use oxedyne_fe2o3_core::prelude::*;

/// LocalHost's net port.
#[derive(Clone, Debug, Default)]
pub struct LocalNet;

// Each egress answer is the explicit refusal rather than `None`, so it refuses whatever a caller
// makes of an unanswered question.  `Once`, not `Standing`: nothing is recorded against the
// conversation, and `PermitNo::Absent` is the page's "could not be asked on this device".
impl HostNet for LocalNet {
    async fn fetch(&self, _url: &str) -> Outcome<String> { unavailable("net", "fetch") }
    async fn fetch_raw(&self, _url: &str) -> Outcome<RawPage> { unavailable("net", "fetch_raw") }
    async fn search(&self, _query: &str, _kind: &str, _limit: Option<u32>) -> Outcome<SearchAnswer> {
        unavailable("net", "search")
    }
    async fn egress_reach(&self, _turn: &str, _tool: &str, _url: &str, _granted: bool) -> EgressWord {
        EgressWord::Once(Verdict::Deny)
    }
    async fn egress_allowed_detail(&self, _turn: &str, _tool: &str, _url: &str, _detail: &str)
        -> Option<Verdict>
    {
        Some(Verdict::Deny)
    }
    async fn egress_allowed_act(&self, _turn: &str, _tool: &str, _url: &str, _detail: &str,
        _alone: bool)
        -> Option<Verdict>
    {
        Some(Verdict::Deny)
    }
    async fn egress_allowed_kit(&self, _turn: &str, _cmd: &str, _detail: &str) -> Option<Permit> {
        Some(Permit::No(PermitNo::Absent))
    }
    async fn egress_allowed_net(&self, _turn: &str, _cmd: &str, _cwd: &str) -> Option<Verdict> {
        Some(Verdict::Deny)
    }
    async fn egress_allowed_place(&self, _turn: &str, _path: &str, _detail: &str) -> Option<Permit> {
        Some(Permit::No(PermitNo::Absent))
    }
    async fn egress_allowed_publish(&self, _turn: &str, _shown: &str) -> Option<Verdict> {
        Some(Verdict::Deny)
    }
    async fn egress_allowed_run(&self, _turn: &str, _tool: &str, _cmd: &str, _cwd: &str)
        -> Option<Permit>
    {
        Some(Permit::No(PermitNo::Absent))
    }
    async fn openrouter_chat(&self, _body: &str) -> Outcome<String> {
        unavailable("net", "openrouter_chat")
    }
    async fn image_ocr(&self, _mistral_body: &str, _vision_body: &str) -> Outcome<(String, String)> {
        unavailable("net", "image_ocr")
    }
}
