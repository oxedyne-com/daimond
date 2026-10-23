//! The web port: acting on a page through the driver.

use oxedyne_fe2o3_core::prelude::*;

/// The web port a [`Host`](super::Host) carries: today's `web` acting functions, by the same
/// names.
#[allow(async_fn_in_trait)]
pub trait HostWeb {
    /// Open `url` for the turn tagged `turn`, asked by `owner` (the turn's keeper, as
    /// `file_show` names it), so the panel keeps the page for a conversation not on screen.
    async fn open(&self, url: &str, owner: &str, turn: &str) -> Outcome<String>;
    async fn close(&self) -> Outcome<String>;
    async fn read(&self) -> Outcome<String>;
    async fn snapshot(&self) -> Outcome<String>;
    async fn click(&self, node_ref: u32) -> Outcome<String>;
    async fn type_into(&self, node_ref: u32, text: &str, submit: bool) -> Outcome<String>;
    async fn scroll(&self, dir: &str, amount: Option<u32>) -> Outcome<String>;
    async fn current_url(&self) -> String;
}
