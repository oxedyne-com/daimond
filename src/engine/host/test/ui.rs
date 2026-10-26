//! TestHost's ui port: LocalHost's refusals, closed values included.

use crate::{
    engine::host::{
        Host,
        local::ui::LocalUi,
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

/// TestHost's ui port.  The change ask (UNBLOCK-26) answers as a test sets it, unanswered by
/// default; every other ask is LocalHost's.
#[derive(Clone, Debug, Default)]
pub struct TestUi {
    change: std::rc::Rc<std::cell::RefCell<ChangeAsk>>,
    mail:   std::rc::Rc<std::cell::RefCell<Option<(String, Vec<u8>)>>>, // (listing, one message)
}

/// How the change ask answers, what it was shown, and what lands while it waits.
#[derive(Debug, Default)]
struct ChangeAsk {
    answer: Option<crate::held_change::Answer>,
    asked:  Vec<(String, Vec<u8>)>,                     // (path, the bytes shown as before)
    meddle: Option<(crate::engine::host::test::fs::TestFs, String, Vec<u8>)>,
}

impl TestUi {

    /// Answer every change ask with `answer`.
    pub fn answer_changes(&self, answer: crate::held_change::Answer) {
        self.change.borrow_mut().answer = Some(answer);
    }

    /// While the person is asked, someone else writes `bytes` at `path` on `fs`'s disk.
    pub fn meddle_while_asked(&self, fs: &crate::engine::host::test::fs::TestFs, path: &str,
        bytes: &[u8])
    {
        self.change.borrow_mut().meddle = Some((fs.clone(), path.to_string(), bytes.to_vec()));
    }

    /// Serve a mailbox: `listing` answers `list` and `search`, and `raw` every `read_raw`.
    pub fn serve_mail(&self, listing: &str, raw: &[u8]) {
        *self.mail.borrow_mut() = Some((listing.to_string(), raw.to_vec()));
    }

    /// Each change ask put, in order: the path and the bytes shown as what stands there.
    pub fn changes_asked(&self) -> Vec<(String, Vec<u8>)> { self.change.borrow().asked.clone() }
}

impl HostUi for TestUi {
    async fn put(&self, payload: &str) -> Outcome<()> {
        LocalUi.put(payload).await
    }
    async fn ask_change(&self, _keeper: &str, path: &str, before: &[u8],
        _change: crate::held_change::Change<'_>, _turn: &str)
        -> crate::held_change::Answer
    {
        let mut c = self.change.borrow_mut();
        c.asked.push((path.to_string(), before.to_vec()));
        if let Some((fs, at, bytes)) = c.meddle.take() {
            if let Err(e) = fs.put(FileRoot::Workspace, &at, &bytes) {
                panic!("TestUi: the meddling write of '{}': {}", at, e);
            }
        }
        c.answer.clone().unwrap_or(crate::held_change::Answer::Unanswered)
    }
    async fn ask_to_go_on(&self, keeper: &str, path: &str, count: usize, limit: usize, act: &str,
        turn: &str) -> bool {
        LocalUi.ask_to_go_on(keeper, path, count, limit, act, turn).await
    }
    async fn show(&self, path: &str, page: Option<u32>, owner: &str, turn: &str) -> Outcome<Shown> {
        LocalUi.show(path, page, owner, turn).await
    }
    async fn capture(&self, req: &str) -> Outcome<Shot> {
        LocalUi.capture(req).await
    }
    async fn look(&self, id: &str, png: &[u8], prompt: &str) -> Outcome<Looked> {
        LocalUi.look(id, png, prompt).await
    }
    async fn read(&self, req: &str) -> Outcome<String> {
        LocalUi.read(req).await
    }
    async fn compose(&self, req: &str) -> Outcome<Composed> {
        LocalUi.compose(req).await
    }
    async fn commit(&self, token: &str) -> Outcome<String> {
        LocalUi.commit(token).await
    }
    async fn list(&self, req: &str) -> Outcome<String> {
        match self.mail.borrow().as_ref() {
            Some((listing, _)) => Ok(listing.clone()),
            None               => LocalUi.list(req).await,
        }
    }
    async fn search(&self, req: &str) -> Outcome<String> {
        match self.mail.borrow().as_ref() {
            Some((listing, _)) => Ok(listing.clone()),
            None               => LocalUi.search(req).await,
        }
    }
    async fn read_raw(&self, req: &str) -> Outcome<Read> {
        match self.mail.borrow().as_ref() {
            Some((_, raw)) => Ok(Read::Bytes(raw.clone())),
            None           => LocalUi.read_raw(req).await,
        }
    }
    async fn put_draft(&self, req: &str) -> Outcome<String> {
        LocalUi.put_draft(req).await
    }
    async fn sender(&self, req: &str) -> Outcome<String> {
        LocalUi.sender(req).await
    }
    async fn compile_project<H: Host>(&self, reach: &Reach<'_, H>, root: FileRoot, main_rel: &str) -> Outcome<Vec<u8>> {
        LocalUi.compile_project(reach, root, main_rel).await
    }
    async fn spawn(&self, payload: &str) -> Outcome<String> {
        LocalUi.spawn(payload).await
    }
    async fn await_reports(&self, payload: &str) -> Outcome<String> {
        LocalUi.await_reports(payload).await
    }
    async fn pending(&self, raise: bool, diamond: &str, payload: &str) -> Outcome<String> {
        LocalUi.pending(raise, diamond, payload).await
    }
    async fn transcript_search(&self, diamond: &str, args: &str) -> Outcome<String> {
        LocalUi.transcript_search(diamond, args).await
    }
}
