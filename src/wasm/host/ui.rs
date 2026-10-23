//! WasmHost's ui port: each method is one call to today's panel, ask or worker function.

use crate::{
    engine::host::{
        Host,
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
    wasm::{
        ask,
        deletes,
        doc,
        mail,
        shot,
        social,
        typst,
        workers,
    },
};

use oxedyne_fe2o3_core::prelude::*;

/// WasmHost's ui port.
#[derive(Clone, Debug, Default)]
pub struct WasmUi;

impl HostUi for WasmUi {
    async fn put(&self, payload: &str) -> Outcome<()> { ask::put(payload).await }
    async fn ask_change(&self, keeper: &str, path: &str, before: &[u8],
        change: crate::held_change::Change<'_>, turn: &str)
        -> crate::held_change::Answer
    {
        deletes::ask_change(keeper, path, before, change, turn).await
    }
    async fn ask_to_go_on(&self, keeper: &str, path: &str, count: usize, limit: usize, act: &str,
        turn: &str)
        -> bool
    {
        deletes::ask_to_go_on(keeper, path, count, limit, act, turn).await
    }
    async fn show(&self, path: &str, page: Option<u32>, owner: &str, turn: &str)
        -> Outcome<Shown>
    {
        doc::show(path, page, owner, turn).await
    }
    async fn capture(&self, req: &str) -> Outcome<Shot> { shot::capture(req).await }
    async fn look(&self, id: &str, png: &[u8], prompt: &str) -> Outcome<Looked> {
        shot::look(id, png, prompt).await
    }
    async fn read(&self, req: &str) -> Outcome<String> { social::read(req).await }
    async fn compose(&self, req: &str) -> Outcome<Composed> { social::compose(req).await }
    async fn commit(&self, token: &str) -> Outcome<String> { social::commit(token).await }
    async fn list(&self, req: &str) -> Outcome<String> { mail::list(req).await }
    async fn search(&self, req: &str) -> Outcome<String> { mail::search(req).await }
    async fn read_raw(&self, req: &str) -> Outcome<Read> { mail::read_raw(req).await }
    async fn put_draft(&self, req: &str) -> Outcome<String> { mail::put_draft(req).await }
    async fn sender(&self, req: &str) -> Outcome<String> { mail::sender(req).await }
    async fn compile_project<H: Host>(&self, reach: &Reach<'_, H>, root: FileRoot, main_rel: &str)
        -> Outcome<Vec<u8>>
    {
        typst::compile_project(reach, root, main_rel).await
    }
    async fn spawn(&self, payload: &str) -> Outcome<String> { workers::spawn(payload).await }
    async fn await_reports(&self, payload: &str) -> Outcome<String> {
        workers::await_reports(payload).await
    }
    async fn pending(&self, raise: bool, diamond: &str, payload: &str) -> Outcome<String> {
        crate::wasm::pending::call(raise, diamond, payload).await
    }
    async fn transcript_search(&self, diamond: &str, args: &str) -> Outcome<String> {
        crate::wasm::transcript::search(diamond, args).await
    }
}
