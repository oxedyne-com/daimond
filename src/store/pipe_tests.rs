//! R1b: the port over a pipe answers as the port does directly.  D1r1's differential, its 20 MB
//! body, and the pipe's own faults, each through [`PipeLink`] over a Unix socket pair to
//! [`serve_unix`] in front of a [`StoreServer`]; and [`NativeHost`] driving one store call.

use super::*;
use crate::{
    engine::host::{
        clock::HostClock,
        native::NativeHost,
    },
    store::{
        call::{is_store_down, StoreCall},
        pipe::{serve_unix, PipeLink, PIPE_MAX},
    },
};

use std::{
    io::{Read, Write},
    os::unix::net::UnixStream,
    time::{Duration, Instant},
};

/// A socket pair, or the test's panic.
fn pair() -> (UnixStream, UnixStream) {
    match UnixStream::pair() {
        Ok(p)   => p,
        Err(e)  => panic!("a socket pair: {}", e),
    }
}

/// A store server over `mem`, its run `a` served over one end of a socket pair on a thread of its
/// own, and a [`PipeLink`] over the other.
fn piped(mem: MemBackend) -> (StoreServer, PipeLink, std::thread::JoinHandle<Outcome<()>>) {
    let (srv, link) = served(mem);
    let (ours, theirs) = pair();
    let h = std::thread::spawn(move || rt().block_on(serve_unix(link, theirs)));
    let pipe = match PipeLink::over_unix(ours) {
        Ok(p)   => p,
        Err(e)  => panic!("the pipe: {}", e),
    };
    (srv, pipe, h)
}

/// The pipe's far end, once the link is let go: it ends cleanly.
fn ended(h: std::thread::JoinHandle<Outcome<()>>) {
    match h.join() {
        Ok(Ok(()))  => (),
        Ok(Err(e))  => panic!("the served pipe failed: {}", e),
        Err(_)      => panic!("the served pipe panicked"),
    }
}

/// The script's lines and the store's files after it, directly and through the pipe.
fn both_piped() -> ((Vec<String>, Vec<String>), (Vec<String>, Vec<String>)) {
    let mem = seeded();
    let (log, ids) = direct(mem.clone(), |ctx| async move { script(&Direct, &ctx, None).await });
    let here = (log.iter().map(|l| masked(l, &ids)).collect(), files_of(&mem, &ids));

    let mem = seeded();
    let (srv, pipe, h) = piped(mem.clone());
    let store = RemoteStore::new(pipe);
    let ctx = turn_ctx();
    let (log, ids) = rt().block_on(script(&store, &ctx, None));
    drop(store);
    ended(h);
    srv.stop();
    let there = (log.iter().map(|l| masked(l, &ids)).collect(), files_of(&mem, &ids));
    (here, there)
}

/// Every port method answers through the pipe as it does directly, refusals included, and leaves
/// the same bytes (R1b).  Red: the module absent.
#[test]
fn the_port_through_a_pipe_answers_as_the_port_directly() {
    let (here, there) = both_piped();
    let lines = differ(&here.0, &there.0);
    let files = differ(&here.1, &there.1);
    assert!(lines.is_empty(), "the answers differ:\n{}", lines.join("\n"));
    assert!(files.is_empty(), "the stores differ:\n{}", files.join("\n"));
    assert!(here.0.len() >= 82, "the script logged {} lines", here.0.len());
    let errs = |l: &[String]| l.iter().filter(|x| x.starts_with("refuse ") && x.contains("Err⟨")).count();
    let refused = errs(&there.0);
    assert!(refused > 0 && refused == errs(&here.0), "{} refusal case(s) answered Err through the \
        pipe, {} directly", refused, errs(&here.0));
    eprintln!("pipe differential: {} lines equal, {} refusal case(s) answered Err on both",
        there.0.len(), refused);
}

/// A [`PipeLink`] that tallies each frame it sends, by call name and encoded size.
#[derive(Clone)]
struct Tally {
    link: PipeLink,
    sent: Arc<StdMutex<Vec<(String, usize)>>>,
}

impl Tally {
    fn note(&self, call: &StoreCall) {
        let n = encode_call(call).map(|b| b.len()).unwrap_or(0);
        if let Ok(mut s) = self.sent.lock() {
            s.push((call.name().to_string(), n));
        }
    }
}

impl StoreLink for Tally {
    async fn call(&self, call: &StoreCall) -> Outcome<StoreReply> {
        self.note(call);
        self.link.call(call).await
    }
    fn call_blocking(&self, call: &StoreCall) -> Outcome<StoreReply> {
        self.note(call);
        self.link.call_blocking(call)
    }
    fn notify(&self, call: &StoreCall) {
        self.note(call);
        self.link.notify(call)
    }
}

/// A 20 MB `before` captured over the pipe, then read back as the file this turn found.
#[test]
fn a_20mb_copy_round_trips_byte_equal_through_the_pipe() {
    let before = bytes_of(20 * 1024 * 1024, 5);
    let after = b"the edit".to_vec();
    let (srv, pipe, h) = piped(seeded());
    let link = Tally { link: pipe, sent: Arc::new(StdMutex::new(Vec::new())) };
    let store = RemoteStore::new(link.clone());
    store.capture(D, "/m/big.bin", change("/m/big.bin", &before, &after));
    let got = rt().block_on(store.this_turn_found(D, "/m/big.bin", &after));
    let sent = match link.sent.lock() {
        Ok(s)   => s.clone(),
        Err(_)  => Vec::new(),
    };
    drop(store);
    drop(link);
    ended(h);
    srv.stop();
    let most = sent.iter().map(|f| f.1).max().unwrap_or(0);
    let puts = sent.iter().filter(|f| f.0 == "body_put").count();
    let gets = sent.iter().filter(|f| f.0 == "body_get").count();
    assert!(matches!(&got, TurnFound::Was(b) if *b == before), "the 20 MB copy came back different");
    assert!(most <= FRAME_MAX, "a frame of {} over FRAME_MAX", most);
    assert!(puts >= 10 && gets >= 10, "sent in {} body_put and {} body_get frames", puts, gets);
    eprintln!("pipe 20 MB: byte-equal, {} body_put + {} body_get frames, largest {} <= {}",
        puts, gets, most, FRAME_MAX);
}

/// A peer that reads one whole message (id frame and call frame), then does `then` with its
/// socket.  Answers when the message was read.
fn peer(mut sock: UnixStream, then: impl FnOnce(&mut UnixStream) + Send + 'static)
    -> (std::thread::JoinHandle<()>, flume::Receiver<()>)
{
    let (read_tx, read_rx) = flume::bounded(1);
    let h = std::thread::spawn(move || {
        for _ in 0..2 {
            let mut pre = [0u8; 4];
            if sock.read_exact(&mut pre).is_err() {
                return;
            }
            let mut body = vec![0u8; u32::from_be_bytes(pre) as usize];
            if sock.read_exact(&mut body).is_err() {
                return;
            }
        }
        let _ = read_tx.send(());
        then(&mut sock);
    });
    (h, read_rx)
}

/// A call made on its own thread, answered within `secs` or the test fails.
fn called_within(pipe: &PipeLink, secs: u64) -> Outcome<StoreReply> {
    let pipe = pipe.clone();
    let (tx, rx) = flume::bounded(1);
    std::thread::spawn(move || {
        let _ = tx.send(pipe.call_blocking(&StoreCall::Ping {}));
    });
    match rx.recv_timeout(Duration::from_secs(secs)) {
        Ok(r)   => r,
        Err(_)  => panic!("the call was not answered within {} s", secs),
    }
}

/// A reply whose header declares more than `FRAME_MAX` is refused at its header, with the store's
/// typed transport error naming the fault, and no body byte is waited for: the peer never sends
/// one and keeps its end open.
#[test]
fn a_reply_header_over_frame_max_is_refused_before_its_body() {
    let (ours, theirs) = pair();
    let (hold_tx, hold_rx) = flume::bounded::<()>(1);
    let (h, _) = peer(theirs, move |s| {
        let _ = s.write_all(&8u32.to_be_bytes());
        let _ = s.write_all(&1u64.to_be_bytes());
        let _ = s.write_all(&((PIPE_MAX as u32) + 1).to_be_bytes());
        let _ = s.flush();
        let _ = hold_rx.recv();     // the socket stays open, so a wait for the body would hang
    });
    let pipe = match PipeLink::over_unix(ours) {
        Ok(p)   => p,
        Err(e)  => panic!("the pipe: {}", e),
    };
    let at = Instant::now();
    let r = called_within(&pipe, 10);
    let took = at.elapsed();
    let e = match r {
        Err(e)  => e,
        Ok(r)   => panic!("an over-max reply was answered: {:?}", r),
    };
    let words = fmt!("{}", e);
    assert!(is_store_down(&e), "not the store's transport error: {}", words);
    assert!(words.contains("pipe.too-big"), "the fault is not named: {}", words);
    // A later call is refused at once, with the same cause.
    let later = called_within(&pipe, 10);
    assert!(matches!(&later, Err(e) if is_store_down(e)), "a later call: {:?}", later.is_ok());
    let _ = hold_tx.send(());
    let _ = h.join();
    eprintln!("pipe header over FRAME_MAX: refused in {:?} with the body never sent, as StoreDown \
        naming pipe.too-big", took);
}

/// The peer ends its pipe while a call is owed: that call is answered with the store's typed
/// transport error, a later call on the same link likewise, and another link is untouched.
#[test]
fn a_peer_eof_mid_call_fails_the_call_owed_and_no_other_link() {
    let mem = seeded();
    let (srv, other, oh) = piped(mem);
    let (ours, theirs) = pair();
    let (h, _) = peer(theirs, |s| {
        let _ = s.shutdown(std::net::Shutdown::Both);
    });
    let pipe = match PipeLink::over_unix(ours) {
        Ok(p)   => p,
        Err(e)  => panic!("the pipe: {}", e),
    };
    let r = called_within(&pipe, 10);
    let e = match r {
        Err(e)  => e,
        Ok(r)   => panic!("a call owed at EOF was answered: {:?}", r),
    };
    let words = fmt!("{}", e);
    assert!(is_store_down(&e), "not the store's transport error: {}", words);
    assert!(words.contains("closed"), "the end is not named: {}", words);
    let later = called_within(&pipe, 10);
    assert!(matches!(&later, Err(e) if is_store_down(e)), "a later call was not refused");
    let fine = called_within(&other, 10);
    assert!(fine.is_ok(), "another link was touched: {:?}", fine.err().map(|e| fmt!("{}", e)));
    let _ = h.join();
    drop(other);
    ended(oh);
    srv.stop();

    // EOF inside a reply's frame: the fault named is the truncation.
    let (ours, theirs) = pair();
    let (h, _) = peer(theirs, |s| {
        let _ = s.write_all(&8u32.to_be_bytes());
        let _ = s.write_all(&1u64.to_be_bytes());
        let _ = s.write_all(&100u32.to_be_bytes());
        let _ = s.write_all(&[0u8; 10]);
        let _ = s.shutdown(std::net::Shutdown::Both);
    });
    let pipe = match PipeLink::over_unix(ours) {
        Ok(p)   => p,
        Err(e)  => panic!("the pipe: {}", e),
    };
    let r = called_within(&pipe, 10);
    let truncated = matches!(&r, Err(e) if is_store_down(e) && fmt!("{}", e).contains("pipe.truncated"));
    assert!(truncated, "EOF mid-frame: {:?}", r.err().map(|e| fmt!("{}", e)));
    let _ = h.join();
    eprintln!("pipe EOF mid-call: the call owed and a later one answered StoreDown (closed; \
        mid-frame pipe.truncated), another link answered");
}

/// NativeHost builds natively, and drives a store call through its pipe to the store: the
/// seeded crystal reads back as the store holds it.  The default host has no pipe and refuses.
#[test]
fn native_host_drives_a_store_call_through_its_pipe() {
    let (srv, pipe, h) = piped(seeded());
    let host = NativeHost::new(pipe);
    let got = rt().block_on(host.store().read_crystal_data(D));
    let now = host.clock().now_ms();
    drop(host);
    ended(h);
    srv.stop();
    let got = match got {
        Ok(g)   => g,
        Err(e)  => panic!("read_crystal_data through NativeHost: {}", e),
    };
    assert!(got.contains("\"title\":\"d\""), "read back {}", got);
    assert!(now > 0.0, "the process clock read {}", now);

    let none: NativeHost = NativeHost::default();
    let r = rt().block_on(none.store().read_crystal_data(D));
    assert!(matches!(&r, Err(e) if is_store_down(e)), "a host with no pipe answered");
    eprintln!("NativeHost: read_crystal_data over its pipe = the seeded crystal; no pipe → StoreDown");
}

// ┌───────────────────────────────────────────────────────────────┐
// │ HL5a: the child reads a Diamond's standing files from the store │
// └───────────────────────────────────────────────────────────────┘

const STORE_STATE:   &[u8] = b"# State\nThe store's own STATE, as the parent keeps it.\n";
const DISK_STATE:    &[u8] = b"# State\nA stray copy a shell wrote on the child's disk.\n";
const STORE_ARCHIVE: &[u8] = b"# Decisions archive\nRetired: the quokka-seven ruling stood until June.\n";

/// The Mem store `seeded`, with `d`'s STATE.md and its decisions archive beside the crystal.
fn standing() -> MemBackend {
    let mem = seeded();
    rt().block_on(async {
        for (k, b) in [
            ("diamonds/d/STATE.md", STORE_STATE),
            ("diamonds/d/.daimond/decisions-archive.md", STORE_ARCHIVE),
        ] {
            if let Err(e) = mem.write_file(k, b).await {
                panic!("seeding {}: {}", k, e);
            }
        }
    });
    mem
}

/// `f` run with the `store_owned` rule off on this thread ([`crate::store::diamond::switch_off`]).
fn owned_off<T>(f: impl FnOnce() -> T) -> T {
    crate::store::diamond::switch_off(Some("store_owned"));
    let out = f();
    crate::store::diamond::switch_off(None);
    out
}

/// A child's turn context: its files on a scratch workspace, its store over `pipe`, working in `d`.
fn child_ctx(pipe: PipeLink, name: &str) -> ToolContext<NativeHost> {
    let dir = match oxedyne_fe2o3_test::scratch::scratch_dir(name) {
        Ok(d)  => d,
        Err(e) => panic!("a scratch directory: {}", e),
    };
    let ws = match Workspace::new(dir) {
        Ok(w)  => w,
        Err(e) => panic!("a workspace: {}", e),
    };
    ToolContext {
        workspace:   ws.clone(),
        executor:    Executor::local_default(),
        cwd:         String::new(),
        path_prefix: String::new(),
        root:        FileRoot::Workspace,
        read_seen:   new_read_cache(),
        no_write:    Vec::new(),
        daimon_of:   s(D),
        turn:        String::new(),
        keeper:      String::new(),
        unconfirmed: Vec::new(),
        live:        None,
        by_model:    false,
        restoring:   0,
        by:          None,
        host:        NativeHost::rooted(pipe, ws),
    }
}

/// `rel` written on the child's own disk, under its workspace.
fn plant(ctx: &ToolContext<NativeHost>, rel: &str, bytes: &[u8]) {
    let p = ctx.workspace.root().join(rel);
    if let Some(up) = p.parent() {
        if let Err(e) = std::fs::create_dir_all(up) {
            panic!("making {:?}: {}", up, e);
        }
    }
    if let Err(e) = std::fs::write(&p, bytes) {
        panic!("planting {:?}: {}", p, e);
    }
}

/// `tool` run with `args` on the child, its text or its error's.
fn child_said(tool: crate::tools::Tool, args: &str, ctx: &ToolContext<NativeHost>) -> String {
    match rt().block_on(Box::pin(tool.execute(args, ctx))) {
        Ok(m)   => m.as_text().into_owned(),
        Err(e)  => fmt!("ERR {}", e),
    }
}

/// HL5a (a): the child's `file_read` of `diamonds/d/STATE.md` and of the decisions archive
/// answers the store's bytes, never a disk copy.  Red: `store_owned` off, the disk answers.
#[test]
fn hl5a_a_the_childs_file_read_of_a_standing_file_answers_the_stores_bytes() {
    let (srv, pipe, h) = piped(standing());
    let ctx = child_ctx(pipe, "hl5a_a");
    plant(&ctx, "diamonds/d/STATE.md", DISK_STATE);
    let read = |p: &str| child_said(crate::tools::Tool::FileRead, &fmt!("{{\"path\":\"{}\"}}", p), &ctx);
    let state   = read("diamonds/d/STATE.md");
    let archive = read("diamonds/d/.daimond/decisions-archive.md");
    let red     = owned_off(|| read("diamonds/d/STATE.md"));
    drop(ctx);
    ended(h);
    srv.stop();
    assert!(state.contains("The store's own STATE"), "STATE.md read: {}", state);
    assert!(!state.contains("stray copy"), "STATE.md read the disk: {}", state);
    assert!(archive.contains("quokka-seven"), "the archive read: {}", archive);
    assert!(red.contains("stray copy"), "red: with store_owned off the disk did not answer: {}", red);
}

/// HL5a (b): `recall` on the child finds a line kept only in the store's decisions archive.
/// Red: `store_owned` off, the disk has no archive and recall finds nothing.
#[test]
fn hl5a_b_recall_on_the_child_finds_a_retired_line() {
    let (srv, pipe, h) = piped(standing());
    let ctx = child_ctx(pipe, "hl5a_b");
    let q = r#"{"query":"quokka-seven","fixed":true}"#;
    let got = child_said(crate::tools::Tool::Recall, q, &ctx);
    let red = owned_off(|| child_said(crate::tools::Tool::Recall, q, &ctx));
    drop(ctx);
    ended(h);
    srv.stop();
    assert!(got.contains("decisions-archive.md") && got.contains("quokka-seven"), "recall: {}", got);
    assert!(!red.contains("quokka-seven"), "red: with store_owned off recall still found it: {}", red);
}

/// HL5a (c): a store file that stands and will not read is an `Err` at every door -- the fs
/// read, `exists`, and `store_file_read` -- never "absent".
#[test]
fn hl5a_c_an_unreadable_store_file_is_an_err_never_absent() {
    let mem = standing();
    mem.unreadable("diamonds/d/STATE.md");
    let (srv, pipe, h) = piped(mem);
    use crate::engine::host::{fs::HostFs, Host};
    let ctx = child_ctx(pipe, "hl5a_c");
    let red = owned_off(|| rt().block_on(
        ctx.host().fs().exists(FileRoot::Workspace, "diamonds/d/STATE.md")));
    let (read, there, direct) = rt().block_on(async {
        let fs = ctx.host().fs();
        (
            fs.read_file(FileRoot::Workspace, "diamonds/d/STATE.md").await,
            fs.exists(FileRoot::Workspace, "diamonds/d/STATE.md").await,
            ctx.host().store().store_file_read(D, "diamonds/d/STATE.md", 0).await,
        )
    });
    drop(ctx);
    ended(h);
    srv.stop();
    assert!(read.is_err(), "fs.read_file of an unreadable store file answered {:?}", read.ok());
    assert!(!matches!(there, Ok(false)), "fs.exists of an unreadable store file said absent");
    assert!(direct.is_err(), "store_file_read of an unreadable file answered {:?}", direct.ok());
    assert!(matches!(red, Ok(false)), "red: with store_owned off the disk did not say absent");
}

/// HL5a (e): a disk file at a store-owned path, as a shell write leaves one, is named by
/// `strays` and worded by `strays_said` as a refusal; a clean disk says nothing.
#[test]
fn hl5a_e_a_disk_copy_at_a_store_owned_path_is_named_and_refused() {
    use crate::engine::host::{native::fs::strays_said, Host};
    let (srv, pipe, h) = piped(standing());
    let ctx = child_ctx(pipe, "hl5a_e");
    let (clean, _) = ctx.host().fs().strays();
    plant(&ctx, "diamonds/d/STATE.md", DISK_STATE);
    let (named, more) = ctx.host().fs().strays();
    drop(ctx);
    ended(h);
    srv.stop();
    assert!(clean.is_empty(), "a clean disk named {:?}", clean);
    assert_eq!(named, vec![s("diamonds/d/STATE.md")], "strays named {:?} (+{})", named, more);
    let said = strays_said(&named, more);
    assert!(said.contains("Refused") && said.contains("diamonds/d/STATE.md"), "said: {}", said);
    assert!(strays_said(&[], 0).is_empty(), "nothing named, yet words");
}

const STATE_PATH: &str = "diamonds/d/STATE.md";

/// A licence on the child for `path`, or the test's panic.
fn child_lic(ctx: &ToolContext<NativeHost>, path: &str) -> crate::tools::Licence {
    match ctx.licence(path) {
        Ok(l)   => l,
        Err(e)  => panic!("a licence for '{}': {}", path, e),
    }
}

/// A STATE.md landing with all four of its files to settle: the bytes, a retired section for the
/// decisions archive, a line for `DECISIONS.md` and a touched stamp.
fn state_landing() -> Landed {
    Landed {
        kept:       s("# State\n\n## Where\n\nhere, as the child wrote it\n"),
        said:       s("\nA section moved."),
        archive:    vec![(s(crate::tools::DECISIONS_FILE), s("- 2026-10-23 a section retired\n"))],
        noted:      vec![s("- 2026-10-23 Where retired to the archive")],
        touched:    vec![s("1761177600000\tWhere")],
        from:       None,
        at:         1761177600000,
    }
}

/// The four files a STATE.md landing settles, in one order.
fn four_files() -> [String; 4] {
    [s(STATE_PATH), crate::tools::standing_archive(crate::tools::DECISIONS_FILE, D),
        s(DECISIONS), crate::store::diamond::touched_path(D)]
}

/// The child's held write of STATE.md as HL3's door makes it: bound to `expect`, its ARCHIVE
/// phase the `pre` step, then (where it landed) its RECORD phase as the second op.
fn child_lands(ctx: &ToolContext<NativeHost>, expect: &Seen) -> Outcome<Option<Seen>> {
    use crate::engine::host::fs::HostFs;
    let l = state_landing();
    let lic = child_lic(ctx, STATE_PATH);
    rt().block_on(async {
        let st = ctx.host().store();
        let got = res!(ctx.host().fs().write_licensed_then(FileRoot::Workspace, &lic,
            l.kept.as_bytes(), Some(expect),
            || st.standing_settle(ctx.root, STATE_PATH, &l, SettlePhase::Archive)).await);
        if got.is_none() {
            res!(st.standing_settle(ctx.root, STATE_PATH, &l, SettlePhase::Record).await);
        }
        Ok(got)
    })
}

/// HL5b (a), the child's QA-A2: a store write to STATE.md between the child's guard read and its
/// held write is refused with what stands, and the store keeps no archive of the refused landing.
/// Red: `gather` off, `pre` runs as its own settle before the compare and leaves an archive.
fn hl5b_a_run(red: bool) -> (Outcome<Option<Seen>>, Option<Vec<u8>>) {
    let mem = standing();
    let (srv, pipe, h) = piped(mem.clone());
    let ctx = child_ctx(pipe, if red { "hl5b_a_red" } else { "hl5b_a" });
    let read = Seen::of(Some(STORE_STATE));
    // The person's save, after the child's guard read.
    if let Err(e) = rt().block_on(mem.write_file(STATE_PATH, b"# State\nThe person's save.\n")) {
        panic!("the person's save: {}", e);
    }
    if red {
        crate::store::diamond::switch_off(Some("gather"));
    }
    let got = child_lands(&ctx, &read);
    crate::store::diamond::switch_off(None);
    drop(ctx);
    ended(h);
    srv.stop();
    let archive = mem.files().get(&crate::tools::standing_archive(crate::tools::DECISIONS_FILE, D))
        .cloned();
    (got, archive)
}

#[test]
fn hl5b_a_a_store_write_between_the_childs_read_and_write_is_refused_with_no_archive() {
    let (got, archive) = hl5b_a_run(false);
    match got {
        Ok(Some(found)) => assert_eq!(found, Seen::of(Some(b"# State\nThe person's save.\n"))),
        other           => panic!("the child's landing over a save: {:?}", other),
    }
    assert_eq!(archive.as_deref(), Some(STORE_ARCHIVE), "a refused landing left an archive");
    let (red, archive) = hl5b_a_run(true);
    assert!(matches!(red, Ok(Some(_))), "red: {:?}", red);
    assert_ne!(archive.as_deref(), Some(STORE_ARCHIVE), "red: un-gathered, still no archive");
    eprintln!("RED HL5b (a): gather off, the refused landing's archive was written");
}

/// HL5b (b): an accepted child landing leaves the store's four files equal to a local landing's.
/// Red: `store_owned` off, the write is the disk's and refused its `pre` step, so the store's
/// files are not the local landing's.
fn hl5b_b_child(red: bool) -> [Option<Vec<u8>>; 4] {
    let mem = standing();
    let (srv, pipe, h) = piped(mem.clone());
    let ctx = child_ctx(pipe, if red { "hl5b_b_red" } else { "hl5b_b" });
    let read = Seen::of(Some(STORE_STATE));
    let got = match red {
        true    => owned_off(|| child_lands(&ctx, &read)),
        false   => child_lands(&ctx, &read),
    };
    if !red {
        assert!(matches!(got, Ok(None)), "the child's landing: {:?}", got);
    }
    drop(ctx);
    ended(h);
    srv.stop();
    let files = mem.files();
    four_files().map(|p| files.get(&p).cloned())
}

#[test]
fn hl5b_b_an_accepted_child_landing_leaves_the_stores_four_files_as_a_local_one() {
    let local = direct(standing(), |_| async move {
        let l = state_landing();
        if let Err(e) = Direct.standing_settle(FileRoot::Opfs, STATE_PATH, &l, SettlePhase::Archive)
            .await
        {
            panic!("the local ARCHIVE: {}", e);
        }
        if let Err(e) = crate::store::own::write_file(STATE_PATH, l.kept.as_bytes()).await {
            panic!("the local write: {}", e);
        }
        if let Err(e) = Direct.standing_settle(FileRoot::Opfs, STATE_PATH, &l, SettlePhase::Record)
            .await
        {
            panic!("the local RECORD: {}", e);
        }
        let mut out: [Option<Vec<u8>>; 4] = [None, None, None, None];
        for (i, p) in four_files().iter().enumerate() {
            out[i] = crate::store::own::read_file(p).await.ok();
        }
        out
    });
    assert!(local.iter().all(|f| f.is_some()), "the local landing left a file absent: {:?}", local);
    let child = hl5b_b_child(false);
    for (i, p) in four_files().iter().enumerate() {
        assert_eq!(child[i], local[i], "{} differs between the child's landing and the local", p);
    }
    let red = hl5b_b_child(true);
    assert_ne!(red, local, "red: with store_owned off the store still matched the local landing");
    eprintln!("RED HL5b (b): store_owned off, the store's files are not the local landing's");
}

/// HL5b (e), re-aimed by HL5c: a held write of a Diamond's keeper record -- the `.daimond/` side
/// files, `meta.json`, `versions/` -- is refused by the store with nothing written, while its
/// crystal, now store-writable, is accepted.  Red: `writable_only` off on the store, `.daimond/x`
/// is written.
#[test]
fn hl5b_e_a_store_write_then_of_a_side_file_is_refused_with_nothing_written() {
    let mem = standing();
    let before = mem.files();
    let (srv, pipe, h) = piped(mem.clone());
    let ctx = child_ctx(pipe, "hl5b_e");
    let st = ctx.host().store();
    let paths = ["diamonds/d/.daimond/x", "diamonds/d/.daimond/meta.json", "diamonds/d/meta.json",
        "diamonds/d/versions/1.md"];
    let got: Vec<_> = paths.iter().map(|p| rt().block_on(
        st.store_write_then(D, p, b"not the store's to take", None, &[]))).collect();
    let after = mem.files();
    let crystal = rt().block_on(st.store_write_then(D, "diamonds/d/crystal.html", b"<p>c</p>",
        None, &[]));
    if let Err(e) = srv.rule_off("writable_only") {
        panic!("the red's switch: {}", e);
    }
    let red = rt().block_on(st.store_write_then(D, "diamonds/d/.daimond/x", b"red", None, &[]));
    drop(ctx);
    ended(h);
    srv.stop();
    for (p, g) in paths.iter().zip(got.iter()) {
        assert!(g.is_err(), "store_write_then of {} answered {:?}", p, g.as_ref().ok());
    }
    for p in paths.iter() {
        assert_eq!(after.get(*p), before.get(*p), "a refused write of {} changed the store", p);
    }
    assert!(matches!(crystal, Ok(None)), "the crystal's held write: {:?}", crystal);
    assert_eq!(mem.files().get("diamonds/d/crystal.html").map(|b| b.as_slice()),
        Some(&b"<p>c</p>"[..]), "the crystal did not reach the store");
    assert!(matches!(red, Ok(None)), "red: {:?}", red);
    assert_eq!(mem.files().get("diamonds/d/.daimond/x").map(|b| b.as_slice()), Some(&b"red"[..]),
        "red: with writable_only off .daimond/x was still not written");
    eprintln!("RED HL5b (e): writable_only off, the store wrote .daimond/x");
}

/// HL5b (f), re-aimed by HL5c: nothing store-owned lands on the child's disk: a standing file's
/// plain and bound writes, the crystal's, a work file's, a folder and a delete all go to the
/// store; a move out of the Diamond is refused.  Red: `store_owned` off, the write lands on the
/// disk.
#[test]
fn hl5b_f_nothing_store_owned_lands_on_the_childs_disk() {
    use crate::engine::host::fs::HostFs;
    let mem = standing();
    let (srv, pipe, h) = piped(mem.clone());
    let ctx = child_ctx(pipe, "hl5b_f");
    let fs = ctx.host().fs();
    let lic = |p: &str| child_lic(&ctx, p);
    let (plain, bound, crystal, work, folder, gone, moved) = rt().block_on(async {
        (
            fs.write_licensed(FileRoot::Workspace, &lic(STATE_PATH), b"# State\nplain\n").await,
            fs.write_licensed_if(FileRoot::Workspace, &lic(STATE_PATH), b"# State\nbound\n",
                &Seen::of(Some(b"# State\nplain\n"))).await,
            fs.write_licensed(FileRoot::Workspace, &lic("diamonds/d/crystal.json"), b"{}").await,
            fs.write_licensed(FileRoot::Workspace, &lic("diamonds/d/notes.md"), b"n").await,
            fs.create_dir_licensed(FileRoot::Workspace, &lic("diamonds/d/sub")).await,
            fs.delete_licensed(FileRoot::Workspace, &lic("diamonds/d/notes.md")).await,
            fs.move_licensed(FileRoot::Workspace, &lic(STATE_PATH), &lic("elsewhere.md")).await,
        )
    });
    let (clean, _) = fs.strays();
    let disk = ctx.workspace.root().join("diamonds");
    let none_on_disk = !disk.exists();
    let red = owned_off(|| rt().block_on(
        fs.write_licensed(FileRoot::Workspace, &lic(STATE_PATH), b"# State\nred\n")));
    let (named, _) = fs.strays();
    drop(ctx);
    ended(h);
    srv.stop();
    assert!(plain.is_ok(), "the plain write of STATE.md: {:?}", plain);
    assert!(matches!(bound, Ok(None)), "the bound write of STATE.md: {:?}", bound);
    assert_eq!(mem.files().get(STATE_PATH).map(|b| b.as_slice()), Some(&b"# State\nbound\n"[..]),
        "STATE.md did not reach the store");
    for (what, r) in [("crystal", &crystal), ("work file", &work), ("folder", &folder),
        ("delete", &gone)]
    {
        assert!(r.is_ok(), "the child's {} at a Diamond's path: {:?}", what, r);
    }
    assert_eq!(mem.files().get("diamonds/d/crystal.json").map(|b| b.as_slice()), Some(&b"{}"[..]),
        "the crystal did not reach the store");
    assert!(mem.files().get("diamonds/d/notes.md").is_none(), "the work file was not deleted");
    assert!(moved.is_err(), "the child's move out of its Diamond was not refused");
    assert!(clean.is_empty() && none_on_disk, "something store-owned landed on disk: {:?}", clean);
    assert!(red.is_ok(), "red: {:?}", red);
    assert_eq!(named, vec![s(STATE_PATH)], "red: with store_owned off STATE.md was not on the disk");
    eprintln!("RED HL5b (f): store_owned off, STATE.md landed on the child's disk");
}

// ┌───────────────────────────────────────────────────────────────┐
// │ HL5c: the child writes its own Diamond through the store        │
// └───────────────────────────────────────────────────────────────┘

/// The version rows the store holds for `d`.
fn version_rows(mem: &MemBackend) -> Vec<String> {
    mem.files().keys().filter(|k| k.starts_with("diamonds/d/versions/")).cloned().collect()
}

/// Whether the child's disk holds nothing under `diamonds/`.
fn disk_clean(ctx: &ToolContext<NativeHost>) -> bool {
    !ctx.workspace.root().join("diamonds").exists()
}

/// A child's turn context keeping `d`'s versions, as a daimon's own turn does.
fn keeper_ctx(pipe: PipeLink, name: &str) -> ToolContext<NativeHost> {
    let mut ctx = child_ctx(pipe, name);
    ctx.keeper = s(D);
    ctx
}

const NEW_CRYSTAL: &str = r#"{"title":"d, as the child wrote it","sections":[]}"#;

/// HL5c (g): the child's `file_write` of its crystal lands in the store, a version row follows at
/// the turn end, and nothing lands on the child's disk.  Red: `store_writable` off (HL5b's
/// standing-only rule), the write is refused and the store keeps the old crystal.
fn hl5c_g_run(red: bool) -> (String, Option<Vec<u8>>, Vec<String>, Vec<String>, bool) {
    let mem = standing();
    let rows_before = version_rows(&mem);
    let (srv, pipe, h) = piped(mem.clone());
    let ctx = keeper_ctx(pipe, if red { "hl5c_g_red" } else { "hl5c_g" });
    if red {
        crate::store::diamond::switch_off(Some("store_writable"));
    }
    let _ = child_said(crate::tools::Tool::FileRead, r#"{"path":"diamonds/d/crystal.json"}"#, &ctx);
    let args = fmt!("{{\"path\":\"diamonds/d/crystal.json\",\"content\":{:?}}}", NEW_CRYSTAL);
    let said = child_said(crate::tools::Tool::FileWrite, &args, &ctx);
    let _ = rt().block_on(crate::engine::turn::end_keeper_turn(&ctx, true));
    crate::store::diamond::switch_off(None);
    let clean = disk_clean(&ctx);
    drop(ctx);
    ended(h);
    srv.stop();
    let crystal = mem.files().get("diamonds/d/crystal.json").cloned();
    (said, crystal, rows_before, version_rows(&mem), clean)
}

#[test]
fn hl5c_g_the_childs_crystal_write_lands_in_the_store_with_a_version_row() {
    let (said, crystal, before, after, clean) = hl5c_g_run(false);
    assert!(!said.starts_with("ERR"), "the child's crystal write: {}", said);
    assert_eq!(crystal.as_deref(), Some(NEW_CRYSTAL.as_bytes()), "the crystal did not reach the \
        store: {}", said);
    assert!(after.len() > before.len(), "no version row: before {:?} after {:?}", before, after);
    assert!(clean, "something landed on the child's disk");
    let (red, crystal, _, _, clean) = hl5c_g_run(true);
    assert_ne!(crystal.as_deref(), Some(NEW_CRYSTAL.as_bytes()), "red: still written: {}", red);
    assert!(clean, "red: something landed on the child's disk");
    eprintln!("RED HL5c (g): store_writable off, the crystal write was refused: {}", red);
}

/// HL5c (h): the child's work file under its Diamond -- written, a folder made, moved into it and
/// deleted -- each lands in the store with nothing on the child's disk, the folder's reply says
/// plainly that it appears once a file is in it, and the turn end records version rows.  Red:
/// `store_writable` off, the work file's write is refused and the store never holds it.
fn hl5c_h_run(red: bool) -> (Vec<String>, Vec<Option<Vec<u8>>>, usize, bool) {
    use crate::tools::Tool;
    let mem = standing();
    let rows_before = version_rows(&mem).len();
    let (srv, pipe, h) = piped(mem.clone());
    let ctx = keeper_ctx(pipe, if red { "hl5c_h_red" } else { "hl5c_h" });
    if red {
        crate::store::diamond::switch_off(Some("store_writable"));
    }
    let mut said = Vec::new();
    let mut seen = Vec::new();
    said.push(child_said(Tool::FileWrite,
        r#"{"path":"diamonds/d/notes.md","content":"the child's notes\n"}"#, &ctx));
    seen.push(mem.files().get("diamonds/d/notes.md").cloned());
    said.push(child_said(Tool::DirCreate, r#"{"path":"diamonds/d/sub"}"#, &ctx));
    said.push(child_said(Tool::FileMove,
        r#"{"path":"diamonds/d/notes.md","to":"diamonds/d/sub/notes.md"}"#, &ctx));
    seen.push(mem.files().get("diamonds/d/notes.md").cloned());
    seen.push(mem.files().get("diamonds/d/sub/notes.md").cloned());
    said.push(child_said(Tool::FileDelete, r#"{"path":"diamonds/d/sub/notes.md"}"#, &ctx));
    seen.push(mem.files().get("diamonds/d/sub/notes.md").cloned());
    let _ = rt().block_on(crate::engine::turn::end_keeper_turn(&ctx, true));
    crate::store::diamond::switch_off(None);
    let clean = disk_clean(&ctx);
    drop(ctx);
    ended(h);
    srv.stop();
    let rows = version_rows(&mem).len() - rows_before;
    (said, seen, rows, clean)
}

#[test]
fn hl5c_h_the_childs_work_file_write_folder_move_and_delete_land_in_the_store() {
    let (said, seen, rows, clean) = hl5c_h_run(false);
    for s in said.iter() {
        assert!(!s.starts_with("ERR"), "a child's act was refused: {:?}", said);
    }
    assert!(said[1].contains("appears once a file"), "the empty folder's reply: {}", said[1]);
    let notes = Some(b"the child's notes\n".to_vec());
    assert_eq!(seen, vec![notes.clone(), None, notes, None], "the store's work file: {:?}", said);
    assert!(rows > 0, "no version row for the work file: {:?}", said);
    assert!(clean, "something landed on the child's disk");
    let (red, seen, _, clean) = hl5c_h_run(true);
    assert!(red[0].starts_with("ERR") || seen[0].is_none(), "red: written: {:?}", red);
    assert_eq!(seen[0], None, "red: the work file reached the store");
    assert!(clean, "red: something landed on the child's disk");
    eprintln!("RED HL5c (h): store_writable off, the work file write was refused: {}", red[0]);
}

/// A STATE.md well over its cap: six sections of a thousand bytes each, the first the oldest.
fn long_state() -> String {
    let mut out = s("# State\n");
    for i in 0..6 {
        out.push_str(&fmt!("\n## Section {}\n\n{}\n", i, "x".repeat(1000)));
    }
    out
}

/// HL5c (j), one run: the child's `file_write` of a STATE.md over its cap (its ARCHIVE and RECORD
/// settles) and HL3's door landing ([`child_lands`]), both with the child's own root,
/// `Workspace`; the tool's reply, the door's answer, and the store's decisions archive after.
fn hl5c_j_run(red: bool) -> (String, Outcome<Option<Seen>>, bool) {
    let mem = standing();
    let (srv, pipe, h) = piped(mem.clone());
    let ctx = child_ctx(pipe, if red { "hl5c_j_red" } else { "hl5c_j" });
    if red {
        if let Err(e) = srv.rule_off("workspace_own") {
            panic!("the red's switch: {}", e);
        }
    }
    let _ = child_said(crate::tools::Tool::FileRead, r#"{"path":"diamonds/d/STATE.md"}"#, &ctx);
    let args = fmt!("{{\"path\":\"{}\",\"content\":{:?}}}", STATE_PATH, long_state());
    let said = child_said(crate::tools::Tool::FileWrite, &args, &ctx);
    // The RECORD's two files: the decisions line and the touched stamps.
    let recorded = mem.files().contains_key(DECISIONS)
        && mem.files().contains_key(&crate::store::diamond::touched_path(D));
    let now = match mem.files().get(STATE_PATH) {
        Some(b) => Seen::of(Some(b.as_slice())),
        None    => panic!("STATE.md is gone from the store"),
    };
    let door = child_lands(&ctx, &now);
    drop(ctx);
    ended(h);
    srv.stop();
    (said, door, recorded)
}

/// HL5c (j): the child's file tool settle and HL3's RECORD succeed with the child's own root,
/// `Workspace`.  Red: `workspace_own` off on the store (`Opfs` alone is its own area, HL5b), both
/// are refused.
#[test]
fn hl5c_j_the_childs_settles_with_root_workspace_succeed() {
    let (said, door, recorded) = hl5c_j_run(false);
    assert!(!said.starts_with("ERR"), "the tool's write: {}", said);
    assert!(recorded, "the tool's RECORD did not land: {}", said);
    assert!(matches!(door, Ok(None)), "the door's landing over Workspace: {:?}", door);
    let (red, door, recorded) = hl5c_j_run(true);
    assert!(!recorded, "red: the tool's RECORD still landed: {}", red);
    assert!(red.contains("note could not be added"), "red: the reply hid the failed RECORD: {}", red);
    assert!(door.is_err(), "red: the door still landed: {:?}", door);
    eprintln!("RED HL5c (j): workspace_own off, the RECORD settles were refused");
}

// ┌───────────────────────────────────────────────────────────────┐
// │ QA1-C: an answer not known keeps the copy                       │
// └───────────────────────────────────────────────────────────────┘

const QA1C_PATH:  &str = "diamonds/d/notes.md";
const QA1C_PRIOR: &[u8] = b"the prior notes, which a version row must keep\n";

/// QA1-C, one run: `d`'s notes stand as QA1C_PRIOR; the child's `file_write` over them is done by
/// the store and answered not known (the relay's backstop, then the store's late commit:
/// `answer_known` off); `again`, a second write follows on the same path; then the turn ends.
/// Answers what the child was told, and whether any version row names the prior bytes.
fn qa1c_run(red: bool, again: bool) -> (String, bool) {
    let mem = standing();
    rt().block_on(async {
        if let Err(e) = mem.write_file(QA1C_PATH, QA1C_PRIOR).await {
            panic!("seeding the notes: {}", e);
        }
    });
    let (srv, pipe, h) = piped(mem.clone());
    let ctx = keeper_ctx(pipe, &fmt!("qa1c_{}_{}", red, again));
    if red {
        crate::store::diamond::switch_off(Some("unknown_keeps"));
    }
    let _ = child_said(crate::tools::Tool::FileRead, r#"{"path":"diamonds/d/notes.md"}"#, &ctx);
    if let Err(e) = srv.rule_off("answer_known") {
        panic!("the test's backstop: {}", e);
    }
    let said = child_said(crate::tools::Tool::FileWrite,
        r#"{"path":"diamonds/d/notes.md","content":"the late write\n"}"#, &ctx);
    if again {
        let _ = child_said(crate::tools::Tool::FileRead, r#"{"path":"diamonds/d/notes.md"}"#, &ctx);
        let _ = child_said(crate::tools::Tool::FileEdit,
            r#"{"path":"diamonds/d/notes.md","old_string":"late","new_string":"later"}"#, &ctx);
    }
    let _ = rt().block_on(crate::engine::turn::end_keeper_turn(&ctx, true));
    crate::store::diamond::switch_off(None);
    drop(ctx);
    ended(h);
    srv.stop();
    let hash = crate::diamond_versions::hash_of(QA1C_PRIOR);
    let named = mem.files().iter().any(|(k, b)| k.starts_with("diamonds/d/versions/")
        && !k.contains("pending") && String::from_utf8_lossy(b).contains(&hash));
    (said, named)
}

/// QA1-C: a write the store committed after the child was answered "not known" leaves the bytes
/// it wrote over in a version row, whether the turn then ends or writes the path again.  Red:
/// `unknown_keeps` off, the hold gives its note back as for a failed write, and the prior bytes
/// are in no row.
#[test]
fn qa1c_a_late_commit_answered_not_known_keeps_a_row_for_the_prior_bytes() {
    for again in [false, true] {
        let (said, named) = qa1c_run(false, again);
        assert!(said.contains("Not known whether the store did it"), "the child was told: {}",
            said);
        assert!(named, "again {}: no version row names the prior bytes: {}", again, said);
        let (red, named) = qa1c_run(true, again);
        assert!(!named, "red, again {}: the prior bytes are in a row: {}", again, red);
    }
    eprintln!("RED QA1-C: unknown_keeps off, a late commit left the prior bytes in no row");
}

/// QA1-D, one run: the child writes `d`'s notes four turns running, X, Y, Z, then V.  Before the
/// fourth, a note of this page on the path stands again, as one kept for an answer not known
/// (QA1-C) does, naming the bytes W: X itself where `held`, so a row already holds them; bytes
/// held nowhere otherwise.  The fourth turn's capture begins at Z, so its end adopts the note,
/// as a run W to Z that no row is (a run the newest row already is would be dropped anyway).
/// `red` turns `unnamed_once` off.  Answers how many rows keep W as what stood before them.
fn qa1d_run(red: bool, held: bool) -> usize {
    const NOWHERE: &[u8] = b"bytes no row holds, which the kept copy names\n";
    let mem = standing();
    rt().block_on(async {
        if let Err(e) = mem.write_file(QA1C_PATH, b"the first notes\n").await {
            panic!("seeding the notes: {}", e);
        }
    });
    let (srv, pipe, h) = piped(mem.clone());
    let ctx = keeper_ctx(pipe, &fmt!("qa1d_{}_{}", red, held));
    let mut note: Option<(String, String)> = None;
    for body in [QA1C_PRIOR, &b"the second notes\n"[..], &b"the third notes\n"[..]] {
        let _ = child_said(crate::tools::Tool::FileRead, r#"{"path":"diamonds/d/notes.md"}"#, &ctx);
        let said = child_said(crate::tools::Tool::FileWrite, &fmt!(
            r#"{{"path":"diamonds/d/notes.md","content":{:?}}}"#, String::from_utf8_lossy(body)),
            &ctx);
        if note.is_none() {
            note = mem.files().iter().find(|(k, _)| k.starts_with("diamonds/d/")
                && k.contains("pending") && !k.contains("/b/"))
                .map(|(k, b)| (k.clone(), String::from_utf8_lossy(b).into_owned()));
        }
        let _ = rt().block_on(crate::engine::turn::end_keeper_turn(&ctx, true));
        assert_eq!(mem.files().get(QA1C_PATH).map(|b| b.as_slice()), Some(body),
            "the write did not land: {}", said);
    }
    let (at, text) = match note {
        Some(n) => n,
        None    => panic!("the first write left no note"),
    };
    let w: &[u8] = if held { QA1C_PRIOR } else { NOWHERE };
    let hash = crate::diamond_versions::hash_of(w);
    let text = text.replace(&crate::diamond_versions::hash_of(b"the first notes\n"), &hash);
    rt().block_on(async {
        if !held {
            let b = fmt!("diamonds/d/versions/{}", crate::diamond_versions::body_name(&hash));
            if let Err(e) = mem.write_file(&b, w).await {
                panic!("the kept copy's body: {}", e);
            }
        }
        if let Err(e) = mem.write_file(&at, text.as_bytes()).await {
            panic!("the kept note: {}", e);
        }
    });
    // The turn end runs on the store's thread, where the server switches the rule off.
    if red {
        if let Err(e) = srv.rule_off("unnamed_once") {
            panic!("the test's red: {}", e);
        }
    }
    let _ = child_said(crate::tools::Tool::FileRead, r#"{"path":"diamonds/d/notes.md"}"#, &ctx);
    let _ = child_said(crate::tools::Tool::FileWrite,
        r#"{"path":"diamonds/d/notes.md","content":"the fourth notes\n"}"#, &ctx);
    let _ = rt().block_on(crate::engine::turn::end_keeper_turn(&ctx, true));
    crate::store::diamond::switch_off(None);
    drop(ctx);
    ended(h);
    srv.stop();
    let was = fmt!("\"was\":\"{}\"", hash);
    mem.files().iter().filter(|(k, _)| k.starts_with("diamonds/d/versions/")
        && crate::diamond_versions::manifest_version(k.rsplit('/').next().unwrap_or("")).is_some())
        .map(|(_, b)| String::from_utf8_lossy(b).matches(was.as_str()).count()).sum()
}

/// QA1-D (lead ruling): the turn end adopts a kept note's copy as a version row only where no
/// version of the path already holds its bytes: bytes held nowhere add exactly one row; bytes an
/// earlier row holds add none.  Red: `unnamed_once` off, the held bytes get a duplicate row.
#[test]
fn qa1d_a_a_kept_copy_is_a_row_once_never_twice() {
    assert_eq!(qa1d_run(false, false), 1, "bytes held nowhere did not get exactly one row");
    assert_eq!(qa1d_run(false, true), 1, "bytes a row already held got another");
    assert_eq!(qa1d_run(true, true), 2, "red: with unnamed_once off no duplicate row was made");
    eprintln!("RED QA1-D: unnamed_once off, the held bytes got a duplicate row");
}

// ┌───────────────────────────────────────────────────────────────┐
// │ LOUD-FAIL: a store refusal is said, never swallowed            │
// └───────────────────────────────────────────────────────────────┘

/// A child's turn context keeping into `x`, a Diamond its run was NOT granted, so the store's
/// scope refuses every call naming it -- the shape of DIAG-AUTHOR2's live fault.
fn outside_ctx(pipe: PipeLink, name: &str) -> ToolContext<NativeHost> {
    let mut ctx = child_ctx(pipe, name);
    ctx.keeper = s("x");
    ctx
}

/// LOUD-FAIL B1 (rc-a ruling): the store refusing the claim on a write's before-image REFUSES
/// the write, fail-closed, and the model is told the store's reason with the keeper and op --
/// never a turn cap it did not reach.  Break: remote `loud` off (the old `Short::Count`).
fn loud_b1_run(red: bool) -> (String, Option<Vec<u8>>) {
    use crate::tools::Tool;
    let (srv, pipe, h) = piped(standing());
    let ctx = outside_ctx(pipe, if red { "loud_b1_red" } else { "loud_b1" });
    plant(&ctx, "notes/a.md", b"before\n");
    if red {
        crate::store::remote::switch_off(Some("loud"));
    }
    let _ = child_said(Tool::FileRead, r#"{"path":"notes/a.md"}"#, &ctx);
    let said = child_said(Tool::FileWrite, r#"{"path":"notes/a.md","content":"after\n"}"#, &ctx);
    crate::store::remote::switch_off(None);
    let disk = std::fs::read(ctx.workspace.root().join("notes/a.md")).ok();
    drop(ctx);
    ended(h);
    srv.stop();
    (said, disk)
}

#[test]
fn loud_b1_a_refused_before_image_refuses_the_write_and_says_the_stores_reason() {
    let (said, disk) = loud_b1_run(false);
    eprintln!("LOUD B1: {}", said);
    assert!(said.contains("Refused") && said.contains("captured_room") && said.contains("'x'"),
        "the refusal names the store's op and the keeper: {}", said);
    assert_eq!(disk.as_deref(), Some(&b"before\n"[..]), "the write landed: {}", said);
    let (red, disk) = loud_b1_run(true);
    assert!(!red.contains("captured_room"), "break: loud off still named the store: {}", red);
    assert_eq!(disk.as_deref(), Some(&b"before\n"[..]), "break: the write landed: {}", red);
    eprintln!("BREAK LOUD B1: loud off, refused for a reason that is not the store's: {}", red);
}

/// LOUD-FAIL B2 (rc-a ruling): after the act, a refused `ran_made` / `made_files` is the store's
/// reason at the port (never `()` or an empty list), and a refused turn record is ONE visible
/// sentence from the turn end naming the keeper, each op and the reason, for the asker's
/// transcript ([`crate::engine::turn::end_keeper_turn_said`]).  Break: remote `loud` off, the
/// port swallows again and nothing the run's command noted is said.
fn loud_b2_run(red: bool) -> (Outcome<()>, Outcome<Vec<(String, String)>>, Option<String>) {
    let (srv, pipe, h) = piped(standing());
    let ctx = outside_ctx(pipe, if red { "loud_b2_red" } else { "loud_b2" });
    if red {
        crate::store::remote::switch_off(Some("loud"));
    }
    let store = ctx.host().store();
    let ran = rt().block_on(store.ran_made("x", None,
        vec![(s("notes/built.o"), s("00"), true)], false));
    let made = rt().block_on(store.made_files("x"));
    // What `run` notes on a refusal (tools.rs), as its exec door would.
    if let Err(e) = &ran {
        crate::tools::note_unkept(&ctx.read_seen,
            fmt!("The store refused ran_made for keeper 'x' ({}).", e.plain()));
    }
    let (kept, said) = rt().block_on(crate::engine::turn::end_keeper_turn_said(&ctx, true));
    crate::store::remote::switch_off(None);
    assert!(kept.is_none(), "an unbound keeper recorded a version");
    drop(ctx);
    ended(h);
    srv.stop();
    (ran, made, said)
}

#[test]
fn loud_b2_a_refused_record_after_the_act_is_said_with_keeper_op_and_reason() {
    let (ran, made, said) = loud_b2_run(false);
    eprintln!("LOUD B2: ran={:?} made={:?} said={:?}", ran.is_err(), made.is_err(), said);
    assert!(ran.is_err(), "ran_made's refusal was swallowed");
    assert!(made.is_err(), "made_files' refusal was an empty list");
    let said = said.unwrap_or_default();
    // The turn end stops at the refused `is_steering`, and says it too (F2-REL3).
    assert!(said.contains("ran_made") && said.contains("is_steering") && said.contains("'x'")
        && said.contains("not granted"),
        "the turn end names the op refused, the keeper and the store's reason: {}", said);
    let (ran, made, said) = loud_b2_run(true);
    assert!(ran.is_ok() && made.is_ok(), "break: loud off still refused at the port");
    assert!(!said.unwrap_or_default().contains("ran_made"), "break: ran_made still said");
    eprintln!("BREAK LOUD B2: loud off, ran_made/made_files swallowed and unsaid");
}

/// LOUD-FAIL, `is_steering` (F2-REL3): a store that refuses the turn end's `is_steering` is said
/// in the asker's transcript with the keeper, the op and the store's reason, never taken for "a
/// steer runs", which stopped the turn end before `hold_versions` and recorded nothing silently.
/// Break: remote `loud` off, the refusal is "steering" again and nothing is said.
fn loud_steering_run(red: bool) -> Option<String> {
    let (srv, pipe, h) = piped(standing());
    let ctx = outside_ctx(pipe, if red { "loud_steer_red" } else { "loud_steer" });
    if red {
        crate::store::remote::switch_off(Some("loud"));
    }
    let (kept, said) = rt().block_on(crate::engine::turn::end_keeper_turn_said(&ctx, true));
    crate::store::remote::switch_off(None);
    assert!(kept.is_none(), "an unbound keeper recorded a version");
    drop(ctx);
    ended(h);
    srv.stop();
    said
}

#[test]
fn loud_is_steering_refused_at_the_turn_end_is_said_with_keeper_op_and_reason() {
    let said = loud_steering_run(false).unwrap_or_default();
    eprintln!("LOUD STEER: {}", said);
    assert!(said.contains("is_steering") && said.contains("'x'") && said.contains("not granted"),
        "the turn end names is_steering, the keeper and the store's reason: {:?}", said);
    let red = loud_steering_run(true);
    assert!(red.is_none(), "break: loud off still said the refusal: {:?}", red);
    eprintln!("BREAK LOUD STEER: loud off, is_steering refused is 'steering' again, unsaid");
}
