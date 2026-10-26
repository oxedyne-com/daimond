//! TestHost, the native host the engine's tests run the hosted tool half on: an in-memory Fs, a
//! fixed Clock, a Store that fails closed, and refusals for the rest.

pub mod clock;
pub mod exec;
pub mod fs;
pub mod net;
pub mod store;
pub mod ui;
pub mod web;

use crate::engine::host::{
    Host,
    sync::SyncPort,
};
use self::{
    clock::TestClock,
    exec::TestExec,
    fs::TestFs,
    net::TestNet,
    store::TestStore,
    ui::TestUi,
    web::TestWeb,
};

/// TestHost's sync port.
#[derive(Clone, Debug, Default)]
pub struct TestSync;

impl SyncPort for TestSync {}

/// TestHost: one field per port.
#[derive(Clone, Debug, Default)]
pub struct TestHost {
    fs:    TestFs,
    exec:  TestExec,
    net:   TestNet,
    clock: TestClock,
    store: TestStore,
    ui:    TestUi,
    sync:  TestSync,
    web:   TestWeb,
}

impl Host for TestHost {
    const HOSTED: bool = true;
    type Fs    = TestFs;
    type Exec  = TestExec;
    type Net   = TestNet;
    type Clock = TestClock;
    type Store = TestStore;
    type Ui    = TestUi;
    type Sync  = TestSync;
    type Web   = TestWeb;
    fn fs(&self) -> &TestFs { &self.fs }
    fn exec(&self) -> &TestExec { &self.exec }
    fn net(&self) -> &TestNet { &self.net }
    fn clock(&self) -> &TestClock { &self.clock }
    fn store(&self) -> &TestStore { &self.store }
    fn ui(&self) -> &TestUi { &self.ui }
    fn sync(&self) -> &TestSync { &self.sync }
    fn web(&self) -> &TestWeb { &self.web }
}

/// THE HOSTED HALF RUNS ON A NON-WASM HOST (u2_plan.md §9, U2d): a tool, and a whole model turn,
/// reach the world through TestHost's ports and not through `std::fs`, and the fence stands in
/// front of the port.
#[cfg(test)]
mod tests {
    use super::TestHost;
    use crate::{
        agent::Agent,
        engine::host::Host,
        executor::Executor,
        llm::tests::{
            Reply,
            start_stub,
            stub_client,
        },
        protocol::Session,
        tools::{
            Bound,
            FileRoot,
            Tool,
            ToolContext,
            ToolRegistry,
            new_read_cache,
        },
        workspace::Workspace,
    };

    use oxedyne_fe2o3_core::prelude::*;

    /// A turn on a fresh TestHost over an empty scratch workspace, unbounded and the user's own.
    fn ctx(name: &str) -> ToolContext<TestHost> {
        let dir = match oxedyne_fe2o3_test::scratch::scratch_dir(name) {
            Ok(d)  => d,
            Err(e) => panic!("a scratch directory: {}", e),
        };
        let ws = match Workspace::new(dir) {
            Ok(w)  => w,
            Err(e) => panic!("a workspace: {}", e),
        };
        ToolContext {
            workspace:   ws,
            executor:    Executor::local_default(),
            cwd:         String::new(),
            path_prefix: String::new(),
            root:        FileRoot::Workspace,
            read_seen:   new_read_cache(),
            no_write:    Vec::new(),
            daimon_of:   String::new(),
            turn:        String::new(),
            keeper:      String::new(),
            unconfirmed: Vec::new(),
            live:        None,
            by_model:    false,
            restoring:   0,
            by:          None,
            host:        TestHost::default(),
        }
    }

    /// What `tool` said for `args`, refusal or answer; an `Err` is the text of the error.
    async fn said(tool: Tool, args: &str, c: &ToolContext<TestHost>) -> Result<String, String> {
        match Box::pin(tool.execute(args, c)).await {
            Ok(m)  => Ok(m.as_text().into_owned()),
            Err(e) => Err(fmt!("{}", e)),
        }
    }

    /// Whether the scratch workspace holds `rel` on the real disk.
    fn on_disk(c: &ToolContext<TestHost>, rel: &str) -> bool {
        c.workspace.root().join(rel).exists()
    }

    /// (1) A write and a read through the tools land in TestHost's Fs and come back from it.
    #[tokio::test]
    async fn file_write_then_read_through_the_port() {
        let c = ctx("daimond_u2d_write_read");
        let wrote = said(Tool::FileWrite, r#"{"path":"a.txt","content":"hello"}"#, &c).await;
        assert!(wrote.is_ok(), "file_write: {:?}", wrote);
        assert_eq!(c.host().fs().peek(FileRoot::Workspace, "a.txt").as_deref(), Some(&b"hello"[..]),
            "the bytes are not in TestHost's Fs: {:?}", wrote);
        assert_eq!(c.host().fs().writes(), 1, "{:?}", c.host().fs().log());
        assert!(!on_disk(&c, "a.txt"), "the write reached std::fs");
        let read = said(Tool::FileRead, r#"{"path":"a.txt"}"#, &c).await;
        match read {
            Ok(t)  => assert!(t.contains("hello"), "file_read: {}", t),
            Err(e) => panic!("file_read: {}", e),
        }
    }

    /// One streamed round calling `file_write`, OpenAI-shaped, as the stub serves it.
    fn writes_a_txt() -> Reply {
        let args = r#"{\"path\":\"a.txt\",\"content\":\"x\"}"#;
        Reply::Sse {
            chunks: vec![
                fmt!("data: {{\"choices\":[{{\"delta\":{{\"tool_calls\":[{{\"index\":0,\
                    \"id\":\"c0\",\"type\":\"function\",\"function\":{{\"name\":\"file_write\",\
                    \"arguments\":\"{}\"}}}}]}}}}]}}\n\n", args),
                "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n"
                    .to_string(),
                "data: [DONE]\n\n".to_string(),
            ],
            reset_after: None,
        }
    }

    /// A streamed answer that ends the turn.
    fn answers() -> Reply {
        Reply::Sse {
            chunks: vec![
                "data: {\"choices\":[{\"delta\":{\"content\":\"Done\"}}]}\n\n".to_string(),
                "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":11,\"completion_tokens\":2}}\n\n"
                    .to_string(),
                "data: [DONE]\n\n".to_string(),
            ],
            reset_after: None,
        }
    }

    /// (2) A scripted model turn on `ToolRegistry<TestHost>` writes through TestHost's Fs, and
    /// the `std::fs` workspace under it is left untouched.
    #[tokio::test]
    async fn a_model_turn_writes_through_the_host() {
        let c = ctx("daimond_u2d_turn");
        let host = c.host().clone();
        let registry = ToolRegistry::new_on(vec![Tool::FileWrite], c);
        let (port, _seen) = start_stub(vec![writes_a_txt(), answers()]).await;
        let mut llm = stub_client(port);
        llm.retry.max_attempts = 1;
        let a = Agent::new(llm, "You are Daimond.");
        let mut session = Session::new(fmt!("s1"), fmt!("testhost"), fmt!("model"));
        let ran = Box::pin(a.run_turn(&mut session, fmt!("write it"), &registry, &mut |_| {})).await;
        assert!(ran.is_ok(), "{:?}", ran.err());
        assert_eq!(host.fs().peek(FileRoot::Workspace, "a.txt").as_deref(), Some(&b"x"[..]),
            "TestHost's Fs does not hold a.txt: {:?}", host.fs().log());
        assert!(!on_disk(&registry.ctx, "a.txt"), "the turn wrote through std::fs");
    }

    /// (3) `run` on TestHost asks the exec port, and the port's refusal is its answer: nothing
    /// is run, and nothing falls through to the native `shell`.
    #[tokio::test]
    async fn run_is_refused_by_the_exec_port() {
        let c = ctx("daimond_u2d_run");
        match said(Tool::Run, r#"{"argv":["echo","hi"]}"#, &c).await {
            Err(e) => assert!(e.contains("exec.status is not available on this build"), "run: {}", e),
            Ok(t)  => panic!("run answered rather than meeting the exec refusal: {}", t),
        }
        assert_eq!(c.host().fs().writes(), 0);
    }

    /// (4) A write outside the fence is refused before it reaches the port; the same write
    /// inside it then lands, so the port was there to be reached.
    #[tokio::test]
    async fn a_fenced_write_never_reaches_the_port() {
        let mut c = ctx("daimond_u2d_fence");
        c.no_write = vec![Bound::NoWrite(fmt!("locked"))];
        let got = said(Tool::FileWrite, r#"{"path":"locked/a.txt","content":"x"}"#, &c).await;
        assert_eq!(c.host().fs().writes(), 0, "a fenced write reached the port: {:?}",
            c.host().fs().log());
        match got {
            Ok(t)  => assert!(matches!(crate::tools::call_outcome(&t), crate::tools::CallOutcome::Refused),
                "not refused: {}", t),
            Err(e) => panic!("the fence errored rather than refusing: {}", e),
        }
        let got = said(Tool::FileWrite, r#"{"path":"open/a.txt","content":"x"}"#, &c).await;
        assert!(got.is_ok(), "{:?}", got);
        assert_eq!(c.host().fs().writes(), 1, "the open write missed the port: {:?} {:?}",
            got, c.host().fs().log());
        assert!(!on_disk(&c, "locked/a.txt") && !on_disk(&c, "open/a.txt"));
    }

    // ── UNBLOCK-26 U3: a daimon's change to his file asks first, on the native host ──────────

    /// A model's turn keeping into `dk`, with `Bio/letter.md` of his on disk and the bound passed.
    fn his_letter(name: &str) -> ToolContext<TestHost> {
        let mut c = ctx(name);
        c.keeper = fmt!("dk");
        c.by_model = true;
        c.host().store().pass_the_bound();
        if let Err(e) = c.host().fs().put(FileRoot::Workspace, "Bio/letter.md", b"Dear Ann") {
            panic!("seeding his letter: {}", e);
        }
        c
    }

    const EDIT: &str = r#"{"path":"Bio/letter.md","old_string":"Ann","new_string":"Bob"}"#;

    /// Unanswered (the default): the change is kept aside and nothing is written.
    #[tokio::test]
    async fn an_edit_of_his_file_unanswered_writes_nothing() {
        let c = his_letter("daimond_ublk26_unanswered");
        let seeded = c.host().fs().writes();
        let got = said(Tool::FileEdit, EDIT, &c).await;
        assert_eq!(c.host().ui().changes_asked().len(), 1, "not asked: {:?}", got);
        assert_eq!(c.host().fs().writes(), seeded, "written unasked: {:?}", c.host().fs().log());
        assert_eq!(c.host().fs().peek(FileRoot::Workspace, "Bio/letter.md").as_deref(),
            Some(&b"Dear Ann"[..]));
        // A no is final for the turn: the retry is refused without asking again.
        let again = said(Tool::FileEdit, EDIT, &c).await;
        assert_eq!(c.host().ui().changes_asked().len(), 1, "asked twice: {:?}", again);
        assert_eq!(c.host().fs().writes(), seeded);
    }

    /// Allow: exactly the change he was shown lands, over the bytes he was shown.
    #[tokio::test]
    async fn an_edit_of_his_file_allowed_writes_the_shown_change() {
        let c = his_letter("daimond_ublk26_allowed");
        c.host().ui().answer_changes(crate::held_change::Answer::Apply);
        let got = said(Tool::FileEdit, EDIT, &c).await;
        assert!(got.is_ok(), "{:?}", got);
        assert_eq!(c.host().ui().changes_asked(),
            vec![(fmt!("Bio/letter.md"), b"Dear Ann".to_vec())]);
        assert_eq!(c.host().fs().peek(FileRoot::Workspace, "Bio/letter.md").as_deref(),
            Some(&b"Dear Bob"[..]));
    }

    /// Bytes changed while he was asked: his Apply was to the file as shown, so nothing lands.
    #[tokio::test]
    async fn an_edit_of_his_file_changed_after_the_ask_is_refused() {
        let c = his_letter("daimond_ublk26_meddled");
        c.host().ui().answer_changes(crate::held_change::Answer::Apply);
        c.host().ui().meddle_while_asked(c.host().fs(), "Bio/letter.md", b"Dear Ann, again");
        let got = said(Tool::FileEdit, EDIT, &c).await;
        assert_eq!(c.host().fs().peek(FileRoot::Workspace, "Bio/letter.md").as_deref(),
            Some(&b"Dear Ann, again"[..]), "written over the later bytes: {:?}", got);
        let text = match got { Ok(t) => t, Err(e) => e };
        assert!(text.contains("changed while the user was being asked"), "{}", text);
    }

    /// The Diamond's own file is not asked about.
    #[tokio::test]
    async fn an_edit_of_the_diamonds_own_file_is_not_asked() {
        let c = his_letter("daimond_ublk26_own");
        c.host().store().made_here("Bio/letter.md");
        let got = said(Tool::FileEdit, EDIT, &c).await;
        assert!(got.is_ok(), "{:?}", got);
        assert!(c.host().ui().changes_asked().is_empty());
        assert_eq!(c.host().fs().peek(FileRoot::Workspace, "Bio/letter.md").as_deref(),
            Some(&b"Dear Bob"[..]));
    }
    const DELETE: &str = r#"{"path":"Bio/letter.md"}"#;
    const MOVE: &str = r#"{"path":"Bio/letter.md","to":"Bio/old/letter.md"}"#;

    /// A delete of his file, unanswered: asked once, and the file stays.
    #[tokio::test]
    async fn a_delete_of_his_file_unanswered_keeps_it() {
        let c = his_letter("daimond_ublk26_del_unanswered");
        c.host().store().keep_copies();
        let got = said(Tool::FileDelete, DELETE, &c).await;
        assert_eq!(c.host().ui().changes_asked().len(), 1, "not asked: {:?}", got);
        assert_eq!(c.host().fs().peek(FileRoot::Workspace, "Bio/letter.md").as_deref(),
            Some(&b"Dear Ann"[..]), "deleted unasked: {:?}", got);
    }

    /// A delete of his file, applied: the file he was shown goes.
    #[tokio::test]
    async fn a_delete_of_his_file_allowed_goes() {
        let c = his_letter("daimond_ublk26_del_allowed");
        c.host().store().keep_copies();
        c.host().ui().answer_changes(crate::held_change::Answer::Apply);
        let got = said(Tool::FileDelete, DELETE, &c).await;
        assert!(got.is_ok(), "{:?}", got);
        assert_eq!(c.host().ui().changes_asked(),
            vec![(fmt!("Bio/letter.md"), b"Dear Ann".to_vec())]);
        assert!(c.host().fs().peek(FileRoot::Workspace, "Bio/letter.md").is_none(), "{:?}", got);
    }

    /// A delete of his file changed while he was asked: refused, and the later bytes stay.
    #[tokio::test]
    async fn a_delete_of_his_file_changed_after_the_ask_is_refused() {
        let c = his_letter("daimond_ublk26_del_meddled");
        c.host().store().keep_copies();
        c.host().ui().answer_changes(crate::held_change::Answer::Apply);
        c.host().ui().meddle_while_asked(c.host().fs(), "Bio/letter.md", b"Dear Ann, again");
        let got = said(Tool::FileDelete, DELETE, &c).await;
        assert_eq!(c.host().fs().peek(FileRoot::Workspace, "Bio/letter.md").as_deref(),
            Some(&b"Dear Ann, again"[..]), "deleted over the later bytes: {:?}", got);
        let text = match got { Ok(t) => t, Err(e) => e };
        assert!(text.contains("changed while the user was being asked"), "{}", text);
    }

    /// A move of his file, unanswered: asked once, and nothing moves.
    #[tokio::test]
    async fn a_move_of_his_file_unanswered_moves_nothing() {
        let c = his_letter("daimond_ublk26_mv_unanswered");
        let got = said(Tool::FileMove, MOVE, &c).await;
        assert_eq!(c.host().ui().changes_asked().len(), 1, "not asked: {:?}", got);
        assert_eq!(c.host().fs().peek(FileRoot::Workspace, "Bio/letter.md").as_deref(),
            Some(&b"Dear Ann"[..]), "moved unasked: {:?}", got);
        assert!(c.host().fs().peek(FileRoot::Workspace, "Bio/old/letter.md").is_none());
    }

    /// A move of his file, applied: it lands where asked.
    #[tokio::test]
    async fn a_move_of_his_file_allowed_moves_it() {
        let c = his_letter("daimond_ublk26_mv_allowed");
        c.host().ui().answer_changes(crate::held_change::Answer::Apply);
        let got = said(Tool::FileMove, MOVE, &c).await;
        assert!(got.is_ok(), "{:?}", got);
        assert_eq!(c.host().fs().peek(FileRoot::Workspace, "Bio/old/letter.md").as_deref(),
            Some(&b"Dear Ann"[..]), "{:?}", got);
    }

    /// A move of a folder holding his file is asked about too, and unanswered moves nothing.
    #[tokio::test]
    async fn a_move_of_a_folder_with_his_file_is_asked() {
        let c = his_letter("daimond_ublk26_mvdir");
        let got = said(Tool::FileMove, r#"{"path":"Bio","to":"Bio2"}"#, &c).await;
        assert_eq!(c.host().ui().changes_asked().len(), 1, "not asked: {:?}", got);
        assert_eq!(c.host().fs().peek(FileRoot::Workspace, "Bio/letter.md").as_deref(),
            Some(&b"Dear Ann"[..]), "moved unasked: {:?}", got);
    }

    /// A move of his file changed while he was asked: refused, nothing moves.
    #[tokio::test]
    async fn a_move_of_his_file_changed_after_the_ask_is_refused() {
        let c = his_letter("daimond_ublk26_mv_meddled");
        c.host().ui().answer_changes(crate::held_change::Answer::Apply);
        c.host().ui().meddle_while_asked(c.host().fs(), "Bio/letter.md", b"Dear Ann, again");
        let got = said(Tool::FileMove, MOVE, &c).await;
        assert_eq!(c.host().fs().peek(FileRoot::Workspace, "Bio/letter.md").as_deref(),
            Some(&b"Dear Ann, again"[..]), "moved over the later bytes: {:?}", got);
        let text = match got { Ok(t) => t, Err(e) => e };
        assert!(text.contains("changed while the user was being asked"), "{}", text);
    }

    // ── UNBLOCK-9 U1: image_edit makes a new picture through the host's image route ──────────

    const HIS_JPEG: &[u8] = &[0xFF, 0xD8, 0xFF, 0xE0, b'h', b'i', b's'];
    /// A whole 1x1 grey JPEG: the image route's reply must decode to land (R3 QA-a F1).
    const MADE_JPEG: &[u8] = &[
        0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
        0x00, 0x01, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x10, 0x0b, 0x0c, 0x0e, 0x0c, 0x0a, 0x10,
        0x0e, 0x0d, 0x0e, 0x12, 0x11, 0x10, 0x13, 0x18, 0x28, 0x1a, 0x18, 0x16, 0x16, 0x18, 0x31, 0x23,
        0x25, 0x1d, 0x28, 0x3a, 0x33, 0x3d, 0x3c, 0x39, 0x33, 0x38, 0x37, 0x40, 0x48, 0x5c, 0x4e, 0x40,
        0x44, 0x57, 0x45, 0x37, 0x38, 0x50, 0x6d, 0x51, 0x57, 0x5f, 0x62, 0x67, 0x68, 0x67, 0x3e, 0x4d,
        0x71, 0x79, 0x70, 0x64, 0x78, 0x5c, 0x65, 0x67, 0x63, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01,
        0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xc4, 0x00, 0x14, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xc4, 0x00, 0x14,
        0x10, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x3f, 0xff, 0xd9];

    /// A model's turn with his `a.jpg` on disk and the image route answering with `MADE_JPEG`.
    fn his_photo(name: &str) -> ToolContext<TestHost> {
        let c = his_letter(name);
        if let Err(e) = c.host().fs().put(FileRoot::Workspace, "a.jpg", HIS_JPEG) {
            panic!("seeding his photo: {}", e);
        }
        let reply = fmt!(r#"{{"created":0,"data":[{{"b64_json":"{}","media_type":"image/jpeg"}}],"usage":{{"cost":0.009}}}}"#,
            oxedyne_fe2o3_text::base64::encode(MADE_JPEG));
        c.host().net().serve_images(crate::image_edit::ImageModel {
            id: fmt!("maker/klein"), price: fmt!("$0.008 an image") }, &reply);
        c
    }

    /// "colourise a.jpg": one post carrying his picture, and a new `a.colour.jpg` holding the
    /// reply's bytes beside his untouched original, with nothing asked.
    #[tokio::test]
    async fn image_edit_makes_a_new_sibling_file() {
        let c = his_photo("daimond_ublk9_new");
        let args = r#"{"path":"a.jpg","instruction":"colourise, period-accurate"}"#;
        let got = said(Tool::ImageEdit, args, &c).await;
        let posted = c.host().net().images_posted();
        assert_eq!(posted.len(), 1, "posts: {:?} ({:?})", posted, got);
        assert!(posted[0].contains(r#""model":"maker/klein""#), "{}", posted[0]);
        assert!(posted[0].contains(&oxedyne_fe2o3_text::base64::encode(HIS_JPEG)), "{}", posted[0]);
        assert_eq!(c.host().fs().peek(FileRoot::Workspace, "a.colour.jpg").as_deref(),
            Some(MADE_JPEG), "not landed: {:?}", got);
        assert_eq!(c.host().fs().peek(FileRoot::Workspace, "a.jpg").as_deref(), Some(HIS_JPEG));
        assert!(c.host().ui().changes_asked().is_empty());
        let text = match got { Ok(t) => t, Err(e) => panic!("{}", e) };
        assert!(text.contains("a.colour.jpg") && text.contains("maker/klein")
            && text.contains("$0.009"), "{}", text);
        assert_eq!(Tool::ImageEdit.path_claims(args, None),
            vec![(fmt!("a.colour.jpg"), crate::tools::PathClaim::Left)]);
    }

    /// Named over his own `a.jpg`: asked once, and unanswered his bytes stand.
    #[tokio::test]
    async fn image_edit_over_his_photo_asks_first() {
        let c = his_photo("daimond_ublk9_over");
        let got = said(Tool::ImageEdit,
            r#"{"path":"a.jpg","instruction":"colourise","out":"a.jpg"}"#, &c).await;
        assert_eq!(c.host().ui().changes_asked().len(), 1, "not asked: {:?}", got);
        assert_eq!(c.host().fs().peek(FileRoot::Workspace, "a.jpg").as_deref(), Some(HIS_JPEG),
            "replaced unasked: {:?}", got);
    }

    /// A provider's refusal is said, cut short, and nothing is written.
    #[tokio::test]
    async fn image_edit_refused_writes_nothing() {
        let c = his_photo("daimond_ublk9_refused");
        let long = "A".repeat(5000);
        c.host().net().serve_images(crate::image_edit::ImageModel {
            id: fmt!("maker/klein"), price: String::new() },
            &fmt!(r#"{{"error":{{"message":"too small: {}","code":422}}}}"#, long));
        let text = match said(Tool::ImageEdit, r#"{"path":"a.jpg","instruction":"colourise"}"#, &c).await {
            Ok(t) | Err(t) => t,
        };
        assert!(text.contains("refused") && text.len() < 600, "{}", text);
        assert!(c.host().fs().peek(FileRoot::Workspace, "a.colour.jpg").is_none());
    }
}
