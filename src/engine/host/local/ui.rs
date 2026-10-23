//! LocalHost's ui port.

use crate::{
    engine::host::{
        Host,
        local::fs::unavailable,
        types::ui::{
            Composed,
            Looked,
            Reach,
            Read,
            Shot,
        },
        ui::HostUi,
    },
    tools::{
        FileRoot,
        Shown,
    },
};

use oxedyne_fe2o3_core::prelude::*;

/// LocalHost's ui port.
#[derive(Clone, Debug, Default)]
pub struct LocalUi;

impl HostUi for LocalUi {
    async fn put(&self, _payload: &str) -> Outcome<()> { unavailable("ui", "put") }
    // Nobody is there to say go on, so the act stops.
    // No page to ask on: unanswered, so nothing is written.
    async fn ask_change(&self, _keeper: &str, _path: &str, _before: &[u8],
        _change: crate::held_change::Change<'_>, _turn: &str)
        -> crate::held_change::Answer
    {
        crate::held_change::Answer::Unanswered
    }
    async fn ask_to_go_on(&self, _keeper: &str, _path: &str, _count: usize, _limit: usize,
        _act: &str, _turn: &str)
        -> bool
    {
        false
    }
    async fn show(&self, _path: &str, _page: Option<u32>, _owner: &str, _turn: &str)
        -> Outcome<Shown>
    {
        unavailable("ui", "show")
    }
    async fn capture(&self, _req: &str) -> Outcome<Shot> { unavailable("ui", "capture") }
    async fn look(&self, _id: &str, _png: &[u8], _prompt: &str) -> Outcome<Looked> {
        unavailable("ui", "look")
    }
    async fn read(&self, _req: &str) -> Outcome<String> { unavailable("ui", "read") }
    async fn compose(&self, _req: &str) -> Outcome<Composed> { unavailable("ui", "compose") }
    async fn commit(&self, _token: &str) -> Outcome<String> { unavailable("ui", "commit") }
    async fn list(&self, _req: &str) -> Outcome<String> { unavailable("ui", "list") }
    async fn search(&self, _req: &str) -> Outcome<String> { unavailable("ui", "search") }
    async fn read_raw(&self, _req: &str) -> Outcome<Read> { unavailable("ui", "read_raw") }
    async fn put_draft(&self, _req: &str) -> Outcome<String> { unavailable("ui", "put_draft") }
    async fn sender(&self, _req: &str) -> Outcome<String> { unavailable("ui", "sender") }
    async fn compile_project<H: Host>(&self, _reach: &Reach<'_, H>, _root: FileRoot,
        _main_rel: &str)
        -> Outcome<Vec<u8>>
    {
        unavailable("ui", "compile_project")
    }
    async fn spawn(&self, _payload: &str) -> Outcome<String> { unavailable("ui", "spawn") }
    async fn await_reports(&self, _payload: &str) -> Outcome<String> {
        unavailable("ui", "await_reports")
    }
    async fn pending(&self, _raise: bool, _diamond: &str, _payload: &str) -> Outcome<String> {
        unavailable("ui", "pending")
    }
    async fn transcript_search(&self, _diamond: &str, _args: &str) -> Outcome<String> {
        Err(err!("this host keeps no transcript."; Unimplemented))
    }
}
