//! D1r2: the child's half of the turn end (spec §16.3 2, §16.3a; d1_plan D1r2).  One turn is
//! ended directly, reading the person's files as the tab does ([`FsReads`] over the TestHost
//! `Fs`), and over the link, where [`RemoteStore::stage_turn`] reads them through the run's own
//! context and stages them before `drain_turn`.  The rows each side's store is left with are
//! compared, masked.  Each test shows its red with its rule switched off, in one log line.

use super::*;
use crate::{
    diamond_versions::{self as versions, Stamp},
    engine::host::fs::HostFs,
    store::{
        standing::StandingSource,
        tests_serial::{self as serial, Maker},
    },
};

use std::{cell::RefCell, rc::Rc};

// ┌───────────────────────────────────────────────────────────────┐
// │ The tab's reads, natively                                      │
// └───────────────────────────────────────────────────────────────┘

thread_local! {
    /// The direct side's host, for [`Direct`]'s windows, which are given no context.
    pub(super) static HOST: RefCell<Option<TestHost>> = const { RefCell::new(None) };
}

/// The person's files read as the tab reads them: through the host's `Fs`, every path the tab's
/// own.  **Only a path that is not there is `Gone`**; one that would not read cannot be told.
pub(super) struct FsReads<'a, H: Host>(pub &'a H);

impl<'a, H: Host> FsReads<'a, H> {
    async fn read(&self, path: &str) -> Option<Body> {
        let fs = self.0.fs();
        let ceiling = versions::VERSION_FILE_MAX as u32;
        match fs.read_file_capped(FileRoot::Workspace, path, ceiling).await {
            Ok((b, total)) if total as usize <= versions::VERSION_FILE_MAX => Some(Body::Held(b)),
            Ok((_, total)) => Some(Body::TooLarge(total as u64)),
            Err(_) => match fs.exists(FileRoot::Workspace, path).await {
                Ok(false)   => Some(Body::Gone),
                _           => None,
            },
        }
    }
}

impl<'a, H: Host> StandingSource for FsReads<'a, H> {
    async fn standing(&self, path: &str, _after: &Body) -> Option<Body> {
        if path.starts_with('/') { None } else { self.read(path).await }
    }
    async fn workspace_capped(&self, path: &str) -> Body {
        self.read(path).await.unwrap_or(Body::Unseen)
    }
    async fn changes(&self, id: &str, paths: &[String]) -> Vec<Change> {
        let mut out = Vec::new();
        for path in paths.iter() {
            if diamond::versionable(id, path) {
                out.push(diamond::change_of(id, path, self.workspace_capped(path).await));
            }
        }
        out
    }
    async fn wiped(&self, _path: &str, _after: &Body) -> Option<bool> { None }
    async fn stamp(&self, path: &str) -> Option<Stamp> {
        let (dir, leaf) = match path.rfind('/') {
            Some(i) => (&path[..i], &path[i + 1..]),
            None    => ("", path),
        };
        let listed = match self.0.fs().list_dir_stamped(FileRoot::Workspace, dir).await {
            Ok(l)   => l,
            Err(_)  => return None,
        };
        let (size, when) = match listed.into_iter().find(|(n, d, _, _)| n == leaf && !d) {
            Some((_, _, size, when)) => (size, when),
            None                     => return None,
        };
        if let Some(ms) = when.filter(|ms| ms.is_finite() && *ms > 0.0) {
            return Some(Stamp::Seen(size, Some(ms as u64)));
        }
        Some(match self.read(path).await {
            Some(Body::Held(b)) => Stamp::Hashed(versions::hash_of(&b)),
            _                   => Stamp::Seen(size, None),
        })
    }
}

// ┌───────────────────────────────────────────────────────────────┐
// │ One turn, both ways                                            │
// └───────────────────────────────────────────────────────────────┘

/// A turn: the person's files as they stand at its end, and what its acts captured.
#[derive(Clone, Default)]
struct Turn {
    disk:   Vec<(String, Vec<u8>)>,
    caps:   Vec<Change>,
}

/// A capture of `path`: what stood, `None` for a new file, and what the act left.
fn cap(path: &str, before: Option<&[u8]>, after: Body) -> Change {
    Change { before: (before.map(|b| b.to_vec())).map(crate::diamond_versions::Prior::Held), after, ..change(path, b"", b"") }
}

async fn put(ctx: &ToolContext<TestHost>, path: &str, bytes: &[u8]) {
    let lic = match ctx.licence(path) {
        Ok(l)   => l,
        Err(e)  => panic!("a licence for {}: {}", path, e),
    };
    if let Err(e) = ctx.host().fs().write_licensed(FileRoot::Workspace, &lic, bytes).await {
        panic!("seeding {}: {}", path, e);
    }
}

/// `t` ended on `st`: its files laid, its captures made, then hold, drain, windows and record.
/// Each answer as a line.
async fn ended<S: HostStore>(st: &S, ctx: &ToolContext<TestHost>, t: &Turn) -> String {
    for (p, b) in t.disk.iter() {
        put(ctx, p, b).await;
    }
    for c in t.caps.iter() {
        st.capture(D, &c.path, c.clone());
    }
    let hold = match st.hold_versions(D).await {
        Ok(h)   => h,
        Err(e)  => panic!("hold_versions: {}", e),
    };
    let drained = st.drain_turn(&hold, D, ctx).await;
    let windows = st.drain_windows(&hold, D).await;
    let rec = st.versions_record_held(&hold, D, None, Cause::Turn, "t1", "the turn").await;
    // The full answers, so a refusal shows its words and not a bare `Err`.
    for (what, line) in [("drain", o(&drained)), ("windows", o(&windows)), ("record", o(&rec))] {
        if line.starts_with("Err") {
            eprintln!("ended: {} answered {}", what, line);
        }
    }
    fmt!("{} {} {}", bare(&o(&drained)), bare(&o(&windows)), bare(&o(&rec)))
}

/// `t` ended directly: its answers, then the store's rows.
fn here(t: &Turn) -> (String, Vec<String>) { here_on(serial::mem, t) }

/// `t` ended directly over a seeded store from `maker`: its answers, then the store's rows.
fn here_on(maker: Maker, t: &Turn) -> (String, Vec<String>) {
    let b = maker();
    let t = t.clone();
    let said = direct_on(b.clone(), move |ctx| async move { ended(&Direct, &ctx, &t).await });
    (said, files_in(&b, &[]))
}

/// `t` ended over a link made from the server's own by `wrap`.
fn there_by<L: StoreLink>(t: &Turn, wrap: impl FnOnce(LoopLink) -> L) -> (String, Vec<String>) {
    let mem = seeded();
    let (srv, link) = served(mem.clone());
    let st = RemoteStore::new(wrap(link));
    let ctx = turn_ctx();
    let said = rt().block_on(ended(&st, &ctx, t));
    drop(st);
    srv.stop();
    // The server's ledger of the run's uploads, emptied once claimed: the tab keeps none.
    let rows = files_of(&mem, &[]).into_iter().filter(|l| l != CLAIMS_EMPTIED).collect();
    (said, rows)
}

const CLAIMS_EMPTIED: &str = "diamonds/d/versions/claims.json = []";

fn there(t: &Turn) -> (String, Vec<String>) { there_by(t, |l| l) }

/// The lines of `a` and `b` that differ, for a failure's message.
fn apart(a: &[String], b: &[String]) -> Vec<String> {
    let mut out: Vec<String> = a.iter().filter(|l| !b.contains(l)).map(|l| fmt!("- {}", l)).collect();
    out.extend(b.iter().filter(|l| !a.contains(l)).map(|l| fmt!("+ {}", l)));
    out
}

fn same(here: &(String, Vec<String>), there: &(String, Vec<String>)) -> bool {
    here.0 == there.0 && here.1 == there.1
}

// ┌───────────────────────────────────────────────────────────────┐
// │ (1) The same turn, the same rows                               │
// └───────────────────────────────────────────────────────────────┘

/// A turn that wrote three files: one stands as it left it, one was changed after the act by
/// something else, and one the act made was deleted after.
fn three_ways() -> Turn {
    Turn {
        disk: vec![
            (s("docs/stands.txt"), b"stands after".to_vec()),
            (s("docs/moved.txt"), b"changed outside the turn".to_vec()),
        ],
        caps: vec![
            cap("docs/stands.txt", Some(b"stands before"), Body::Held(b"stands after".to_vec())),
            cap("docs/moved.txt", Some(b"moved before"), Body::Held(b"moved after".to_vec())),
            cap("docs/gone.txt", None, Body::Held(b"made, then deleted".to_vec())),
        ],
    }
}

#[test]
fn a_turn_ended_over_the_link_records_the_rows_it_records_directly() {
    let t = three_ways();
    let direct = here(&t);
    let red = with_off("phase_c", || there(&t));
    assert!(!same(&direct, &red), "the rows matched with nothing staged");
    eprintln!("RED phase_c: with no turn_standing sent, {} row lines differ", apart(&direct.1, &red.1).len());

    let remote = there(&t);
    assert_eq!(direct.0, remote.0);
    assert!(same(&direct, &remote), "{:#?}", apart(&direct.1, &remote.1));
}

// ┌───────────────────────────────────────────────────────────────┐
// │ (2) A capture after the snapshot is the turn's as it left it   │
// └───────────────────────────────────────────────────────────────┘

/// A link that, on the first `turn_stands`, captures `docs/late.txt` through a second port of
/// the same run: an act that landed after `turn_wants`.
#[derive(Clone)]
struct Late {
    link:   LoopLink,
    done:   Rc<RefCell<bool>>,
}

const LATE: &str = "docs/late.txt";

fn late_capture() -> Change { cap(LATE, Some(b"late before"), Body::Held(b"late after".to_vec())) }

impl Late {
    fn arrive(&self, call: &StoreCall) {
        if matches!(call, StoreCall::TurnStands { .. }) && !self.done.replace(true) {
            let other = RemoteStore::new(self.link.clone());
            other.capture(D, LATE, late_capture());
        }
    }
}

impl StoreLink for Late {
    async fn call(&self, call: &StoreCall) -> Outcome<StoreReply> {
        self.arrive(call);
        self.link.call(call).await
    }
    fn call_blocking(&self, call: &StoreCall) -> Outcome<StoreReply> {
        self.arrive(call);
        self.link.call_blocking(call)
    }
    fn notify(&self, call: &StoreCall) {
        let _ = self.link.send(call);
    }
}

/// The late capture's file was changed after it, by something else.  A capture the snapshot did
/// not name is recorded as the turn left it (§16.3 5): directly, the same turn with the capture
/// made before the end and its file still as the act left it.
#[test]
fn a_capture_after_turn_wants_is_recorded_as_the_turn_left_it() {
    let base = Turn {
        disk: vec![(s("docs/stands.txt"), b"stands after".to_vec())],
        caps: vec![cap("docs/stands.txt", Some(b"stands before"), Body::Held(b"stands after".to_vec()))],
    };
    let mut late = base.clone();
    late.disk.push((s(LATE), b"changed after the late act".to_vec()));
    let mut left = base.clone();
    left.disk.push((s(LATE), b"late after".to_vec()));
    left.caps.push(late_capture());

    let direct = here(&left);
    let wrap = |link| Late { link, done: Rc::new(RefCell::new(false)) };
    let red = with_off("late", || there_by(&late, wrap));
    assert!(!same(&direct, &red), "the rows matched with a second snapshot");
    eprintln!("RED late: a second snapshot reads the late capture again, {} row lines differ",
        apart(&direct.1, &red.1).len());

    let remote = there_by(&late, wrap);
    assert_eq!(direct.0, remote.0);
    assert!(same(&direct, &remote), "{:#?}", apart(&direct.1, &remote.1));
}

// ┌───────────────────────────────────────────────────────────────┐
// │ (3) A 2,000-file move reads every page of the snapshot         │
// └───────────────────────────────────────────────────────────────┘

/// A folder of 2,000 files moved: each source gone, each destination made, the last destination
/// changed outside the turn after the move.
fn moved_2000() -> Turn {
    let mut t = Turn::default();
    for n in 0..2000 {
        let body = fmt!("file {}", n).into_bytes();
        let (from, to) = (fmt!("docs/a/f{:04}.txt", n), fmt!("docs/b/f{:04}.txt", n));
        let now = if n == 1999 { b"changed outside".to_vec() } else { body.clone() };
        t.disk.push((to.clone(), now));
        t.caps.push(cap(&from, Some(&body), Body::Gone));
        t.caps.push(cap(&to, None, Body::Held(body)));
    }
    t
}

#[test]
fn a_2000_file_move_over_the_link_records_the_rows_it_records_directly() {
    let t = moved_2000();
    let direct = here(&t);
    let red = with_off("one_page", || there(&t));
    assert!(!same(&direct, &red), "the rows matched with one page of the snapshot read");
    eprintln!("RED one_page: with only the first page of turn_wants read, {} row lines differ",
        apart(&direct.1, &red.1).len());

    let remote = there(&t);
    assert_eq!(direct.0, remote.0);
    assert!(same(&direct, &remote), "{:#?}", apart(&direct.1, &remote.1));
}

// ┌───────────────────────────────────────────────────────────────┐
// │ (4) A large marked document emptied in the turn is wiped       │
// └───────────────────────────────────────────────────────────────┘

/// A Word document of `md`.
fn docx_of(md: &str) -> Vec<u8> {
    use oxedyne_fe2o3_file::office::docx;
    let doc = match oxedyne_fe2o3_text::doc::markdown::parse(md) {
        Ok(d)   => d,
        Err(e)  => panic!("markdown: {:?}", e),
    };
    match docx::write(&doc) {
        Ok((b, _))  => b,
        Err(e)      => panic!("docx::write: {}", e),
    }
}

/// About `n` bytes of pseudo-random words, in paragraphs, the same every run: text that does
/// not compress far, so its document stays over the per-file ceiling.
fn words(n: usize) -> String {
    let mut x: u64 = 0x9e37_79b9_7f4a_7c15;
    let mut out = String::with_capacity(n + 64);
    let mut in_line = 0;
    while out.len() < n {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        let len = 3 + (x % 8) as usize;
        for i in 0..len {
            out.push((b'a' + ((x >> (8 + 5 * i)) % 26) as u8) as char);
        }
        in_line += 1;
        if in_line == 60 {
            out.push_str("\n\n");
            in_line = 0;
        } else {
            out.push(' ');
        }
    }
    out
}

#[test]
fn a_large_marked_docx_emptied_in_the_turn_records_wiped_as_directly() {
    let path = "docs/report.docx";
    let before = docx_of("# Report\n\nThe quarter's figures, as the board saw them, line by line.\n");
    let after = docx_of(&words(1_200_000));
    assert!(after.len() > versions::VERSION_FILE_MAX, "the after is {} bytes", after.len());
    let mut c = cap(path, Some(&before), Body::Held(after.clone()));
    c.mark = true;
    let t = Turn { disk: vec![(s(path), after)], caps: vec![c] };

    let direct = here(&t);
    let wiped = |rows: &[String]| rows.iter().any(|l| l.contains("\"wiped\":true"));
    assert!(wiped(&direct.1), "directly, the emptied document is not wiped: {:#?}", direct.1);
    let red = with_off("turn_wiped", || there(&t));
    assert!(!wiped(&red.1), "wiped with no turn_wiped sent");
    eprintln!("RED turn_wiped: with no turn_wiped sent, the row says wiped: false");

    let remote = there(&t);
    assert_eq!(direct.0, remote.0);
    assert!(same(&direct, &remote), "{:#?}", apart(&direct.1, &remote.1));
}

// ┌───────────────────────────────────────────────────────────────┐
// │ (5) The §16.3a envelope, end to end (D1x1b)                    │
// └───────────────────────────────────────────────────────────────┘

/// A link that frames each call and each reply itself and keeps the largest: a call its encoder
/// refuses, over its ceiling, counts as `usize::MAX`.
#[derive(Clone)]
struct Framed {
    link:   LoopLink,
    most:   Arc<StdMutex<usize>>,
}

impl Framed {
    fn new(link: LoopLink) -> Self { Self { link, most: Arc::new(StdMutex::new(0)) } }

    fn saw(&self, n: usize) {
        if let Ok(mut m) = self.most.lock() {
            *m = (*m).max(n);
        }
    }

    fn most(&self) -> usize {
        match self.most.lock() {
            Ok(m)   => *m,
            Err(_)  => usize::MAX,
        }
    }

    fn sent(&self, call: &StoreCall) -> Outcome<flume::Receiver<Vec<u8>>> {
        match encode_call(call) {
            Ok(f)   => self.saw(f.len()),
            Err(_)  => self.saw(usize::MAX),
        }
        self.link.send(call)
    }

    fn answer(&self, call: &StoreCall, got: Result<Vec<u8>, flume::RecvError>)
        -> Outcome<StoreReply>
    {
        match got {
            Ok(bytes)   => {
                self.saw(bytes.len());
                crate::store::call::decode_reply(&bytes)
            },
            Err(_)      => Err(err!("store.{} had no answer.", call.name(); Missing, Data)),
        }
    }
}

impl StoreLink for Framed {
    async fn call(&self, call: &StoreCall) -> Outcome<StoreReply> {
        let wait = res!(self.sent(call));
        let got = wait.recv_async().await;
        self.answer(call, got)
    }
    fn call_blocking(&self, call: &StoreCall) -> Outcome<StoreReply> {
        let wait = res!(self.sent(call));
        self.answer(call, wait.recv())
    }
    fn notify(&self, call: &StoreCall) {
        let _ = self.sent(call);
    }
}

/// `n` bytes of the envelope's body `seed`, no two seeds alike.
fn body_of(n: usize, seed: u32) -> Vec<u8> {
    let k = seed.wrapping_mul(0x9e37_79b9).wrapping_add(1);
    (0..n).map(|i| ((i as u32).wrapping_mul(2654435761).wrapping_add(k) >> 13) as u8).collect()
}

/// The envelope (§9.10 D1v2, §16.3a): 64 captures, each a 512 KiB `after` over a 512 KiB
/// `before`, three of the `after`s over 512 KiB and the last `before` a 20 MB edit copy, every
/// file standing as its act left it.  With the 20 MB copy.
fn envelope() -> (Turn, Vec<u8>) {
    let k = versions::VERSION_FILE_MAX;
    let mut t = Turn::default();
    let mut copy = Vec::new();
    for i in 0..64u32 {
        let path = fmt!("docs/f{:02}.md", i);
        let before = if i == 63 { body_of(20 * 1000 * 1000, i) } else { body_of(k, i) };
        let after = if i < 3 { body_of(k + 4096, 200 + i) } else { body_of(k, 100 + i) };
        t.disk.push((path.clone(), after.clone()));
        t.caps.push(cap(&path, Some(&before), Body::Held(after)));
        if i == 63 {
            copy = before;
        }
    }
    (t, copy)
}

/// A row line over 4 KiB, cut to its head and its hash, so a difference reads.
fn short(rows: Vec<String>) -> Vec<String> {
    rows.into_iter()
        .map(|l| if l.len() > 4096 {
            let head: String = l.chars().take(200).collect();
            fmt!("{}… <{} bytes {}>", head, l.len(), versions::hash_of(l.as_bytes()))
        } else { l })
        .collect()
}

/// The envelope ended over the link through [`Framed`], over a seeded store from `maker`: its
/// answers and rows, the largest frame either way, and whether the 20 MB copy's row reads back
/// byte-equal.
fn envelope_there(maker: Maker, t: &Turn, copy: &[u8]) -> ((String, Vec<String>), usize, bool) {
    let b = maker();
    let (srv, link) = served_on(b.clone());
    let framed = Framed::new(link);
    let st = RemoteStore::new(framed.clone());
    let ctx = turn_ctx();
    let rt = rt();
    let said = rt.block_on(ended(&st, &ctx, t));
    let back = rt.block_on(st.versions_body(D, &versions::hash_of(copy)));
    drop(st);
    srv.stop();
    let rows = files_in(&b, &[]).into_iter().filter(|l| l != CLAIMS_EMPTIED).collect();
    ((said, short(rows)), framed.most(), matches!(back, Ok(Some(b)) if b == copy))
}

/// The envelope's turn end over the link against the direct one, both over stores from `maker`.
fn the_envelope_turn_end(maker: Maker) {
    let (t, copy) = envelope();
    let (rows, most, _) = with_off("chunk", || envelope_there(maker, &t, &copy));
    assert!(most > FRAME_MAX, "with the uploads unchunked every frame fitted: {}", most);
    eprintln!("RED chunk: with the uploads unchunked, a frame over FRAME_MAX was asked ({}), \
        {} row lines", if most == usize::MAX { s("refused") } else { fmt!("{}", most) }, rows.1.len());

    let direct = here_on(maker, &t);
    let direct = (direct.0, short(direct.1));
    let (remote, most, back) = envelope_there(maker, &t, &copy);
    eprintln!("ENVELOPE largest frame {} of FRAME_MAX {}, {} row lines", most, FRAME_MAX,
        remote.1.len());
    assert!(most <= FRAME_MAX, "a frame of {} over FRAME_MAX", most);
    assert_eq!(direct.0, remote.0);
    assert!(same(&direct, &remote), "{:#?}", apart(&direct.1, &remote.1));
    assert!(remote.0.starts_with("Ok(Drained { captured: 64 })") && remote.0.contains("\"docs/f63.md\"]"),
        "not every capture a row: {}", remote.0);
    assert!(back, "the 20 MB copy's row did not read back byte-equal");
}

#[test]
fn the_envelope_turn_end_over_the_link_records_the_rows_it_records_directly() {
    the_envelope_turn_end(serial::mem);
}

#[test]
fn the_envelope_turn_end_over_the_link_records_the_rows_it_records_directly_ozone() {
    the_envelope_turn_end(serial::ozone);
}
