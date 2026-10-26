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
mod tests {
    use crate::{
        engine::host::{
            Host,
            clock::HostClock,
            exec::HostExec,
            fs::HostFs,
            local::LocalHost,
            net::HostNet,
            test::TestHost,
            ui::HostUi,
            web::HostWeb,
        },
        tools::{
            EgressWord,
            Permit,
            Verdict,
        },
    };

    use oxedyne_fe2o3_core::prelude::*;

    /// The error's text, which must name the port and the method.
    fn said<T>(r: Outcome<T>) -> String {
        match r {
            Ok(_)  => panic!("a refusing host answered"),
            Err(e) => fmt!("{}", e),
        }
    }

    async fn refusals<H: Host>(h: &H) -> Vec<(String, String)> {
        vec![
            (said(h.exec().status().await),           fmt!("exec.status")),
            (said(h.exec().run("{}").await),          fmt!("exec.run")),
            (said(h.exec().signal("1", "INT").await), fmt!("exec.signal")),
            (said(h.net().fetch("https://x").await),  fmt!("net.fetch")),
            (said(h.net().fetch_raw("https://x").await), fmt!("net.fetch_raw")),
            (said(h.net().image_ocr("{}", "{}").await), fmt!("net.image_ocr")),
            (said(h.web().open("https://x", "", "").await),   fmt!("web.open")),
            (said(h.web().click(1).await),            fmt!("web.click")),
            (said(h.ui().put("{}").await),            fmt!("ui.put")),
            (said(h.ui().capture("{}").await),        fmt!("ui.capture")),
            (said(h.ui().read_raw("{}").await),       fmt!("ui.read_raw")),
            (said(h.ui().spawn("{}").await),          fmt!("ui.spawn")),
        ]
    }

    #[tokio::test]
    async fn refusal_names_port() {
        let mut all = refusals(&LocalHost::default()).await;
        all.extend(refusals(&TestHost::default()).await);
        for (line, want) in all {
            assert!(line.contains(&fmt!("{} is not available on this build", want)), "{}", line);
        }
        assert!(said(LocalHost::default().fs().read_file(crate::tools::FileRoot::Workspace, "a")
            .await).contains("fs.read_file is not available on this build"));
    }

    async fn fails_closed<H: Host>(h: &H, who: &str) {
        let (n, e, w, u) = (h.net(), h.exec(), h.web(), h.ui());
        assert_ne!(n.egress_reach("t", "web_fetch", "https://x", true).await,
            EgressWord::Once(Verdict::Allow), "{} egress_reach", who);
        assert!(matches!(n.egress_reach("t", "web_fetch", "https://x", true).await,
            EgressWord::Once(Verdict::Deny)), "{}: refuse this call, record nothing", who);
        for (v, name) in [
            (n.egress_allowed_detail("t", "web_type", "https://x", "d").await, "detail"),
            (n.egress_allowed_act("t", "web_click", "https://x", "d", true).await, "act"),
            (n.egress_allowed_net("t", "curl x", "").await, "net"),
            (n.egress_allowed_publish("t", "hello").await, "publish"),
        ] {
            assert_eq!(v, Some(Verdict::Deny), "{} egress_allowed_{}", who, name);
        }
        for (p, name) in [
            (n.egress_allowed_kit("t", "cargo b", "{}").await, "kit"),
            (n.egress_allowed_run("t", "run", "ls", "").await, "run"),
            (n.egress_allowed_place("t", "x/a", "{}").await, "place"),
        ] {
            assert!(matches!(p, Some(Permit::No(_))), "{} egress_allowed_{}: {:?}", who, name, p);
        }
        assert!(!e.present(), "{} hand present", who);
        assert_eq!(w.current_url().await, "", "{} current_url", who);
        assert!(!u.ask_to_go_on("k", "a", 3, 2, "delete", "").await, "{} ask_to_go_on", who);
        assert_eq!(h.clock().await_restored(0).await, 0, "{} await_restored", who);
    }

    #[tokio::test]
    async fn net_fails_closed() {
        fails_closed(&LocalHost::default(), "LocalHost").await;
        fails_closed(&TestHost::default(), "TestHost").await;
        let lh = LocalHost::default();
        assert!(!lh.fs().folder_open(), "LocalHost has no folder");
        assert_eq!(lh.fs().storage_of(crate::tools::FileRoot::Workspace, "a"),
            crate::tools::Storage::Nowhere);
        assert_eq!(lh.fs().cloud_size_of("a"), None);
    }

    #[test]
    fn clock_is_fixed() {
        let h = TestHost::default();
        assert_eq!(h.clock().now_ms(), 1_700_000_000_000.0);
        assert_eq!(h.clock().random_u32(), 4);
        assert_eq!(h.clock().utc_string(), "Tue, 14 Nov 2023 22:13:20 GMT");
    }
}
