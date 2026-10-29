//! TestHost's net port: LocalHost's refusals, closed values included.

use crate::{
    engine::host::{
        local::net::LocalNet,
        net::HostNet,
        types::net::RawPage,
    },
    tools::{
        EgressWord,
        Permit,
        SearchAnswer,
        Verdict,
    },
};

use oxedyne_fe2o3_core::prelude::*;

/// TestHost's net port.  The image route answers as a test sets it (UNBLOCK-9), refusing as
/// LocalHost's does by default; every other method is LocalHost's.
#[derive(Clone, Debug, Default)]
pub struct TestNet {
    images: std::rc::Rc<std::cell::RefCell<Images>>,
}

/// The image route's model and reply, and each body posted to it.
#[derive(Debug, Default)]
struct Images {
    model:  Option<crate::image_edit::ImageModel>,
    reply:  Option<String>,
    posted: Vec<String>,
}

impl TestNet {
    /// Answer `image_model` with `model` and every `/images` post with `reply`.
    pub fn serve_images(&self, model: crate::image_edit::ImageModel, reply: &str) {
        let mut i = self.images.borrow_mut();
        i.model = Some(model);
        i.reply = Some(reply.to_string());
    }

    /// Each body posted to `/images`, in order.
    pub fn images_posted(&self) -> Vec<String> { self.images.borrow().posted.clone() }
}

impl HostNet for TestNet {
    async fn fetch(&self, url: &str) -> Outcome<String> {
        LocalNet.fetch(url).await
    }
    async fn fetch_raw(&self, url: &str) -> Outcome<RawPage> {
        LocalNet.fetch_raw(url).await
    }
    async fn search(&self, query: &str, kind: &str, limit: Option<u32>) -> Outcome<SearchAnswer> {
        LocalNet.search(query, kind, limit).await
    }
    async fn egress_reach(&self, turn: &str, tool: &str, url: &str, granted: bool) -> EgressWord {
        LocalNet.egress_reach(turn, tool, url, granted).await
    }
    async fn egress_allowed_detail(&self, turn: &str, tool: &str, url: &str, detail: &str) -> Option<Verdict> {
        LocalNet.egress_allowed_detail(turn, tool, url, detail).await
    }
    async fn egress_allowed_act(&self, turn: &str, tool: &str, url: &str, detail: &str, alone: bool) -> Option<Verdict> {
        LocalNet.egress_allowed_act(turn, tool, url, detail, alone).await
    }
    async fn egress_allowed_kit(&self, turn: &str, cmd: &str, detail: &str) -> Option<Permit> {
        LocalNet.egress_allowed_kit(turn, cmd, detail).await
    }
    async fn egress_allowed_net(&self, turn: &str, cmd: &str, cwd: &str) -> Option<Verdict> {
        LocalNet.egress_allowed_net(turn, cmd, cwd).await
    }
    async fn egress_allowed_place(&self, turn: &str, path: &str, detail: &str) -> Option<Permit> {
        LocalNet.egress_allowed_place(turn, path, detail).await
    }
    async fn egress_allowed_publish(&self, turn: &str, shown: &str) -> Option<Verdict> {
        LocalNet.egress_allowed_publish(turn, shown).await
    }
    async fn egress_allowed_run(&self, turn: &str, tool: &str, cmd: &str, cwd: &str) -> Option<Permit> {
        LocalNet.egress_allowed_run(turn, tool, cmd, cwd).await
    }
    async fn openrouter_chat(&self, body: &str) -> Outcome<String> {
        LocalNet.openrouter_chat(body).await
    }
    async fn image_ocr(&self, mistral_body: &str, vision_body: &str) -> Outcome<(String, String)> {
        LocalNet.image_ocr(mistral_body, vision_body).await
    }
    async fn image_model(&self) -> Outcome<crate::image_edit::ImageModel> {
        let model = self.images.borrow().model.clone();
        match model {
            Some(m) => Ok(m),
            None    => LocalNet.image_model().await,
        }
    }
    async fn openrouter_images(&self, body: &str) -> Outcome<String> {
        let reply = {
            let mut i = self.images.borrow_mut();
            i.posted.push(body.to_string());
            i.reply.clone()
        };
        match reply {
            Some(r) => Ok(r),
            None    => LocalNet.openrouter_images(body).await,
        }
    }
}

#[cfg(test)]
#[path = "../../../../tests/unit/engine/host/test/net/tests.rs"]
mod tests;
