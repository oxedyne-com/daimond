//! The native messaging host's entry point, and the loop that serves a browser.
//!
//! Chrome launches this binary, speaks length-prefixed JSON over stdin and
//! stdout, and kills it when the extension lets go.  **Standard output is the
//! wire**, so nothing here may print to it once a browser is on the other end:
//! a stray `println!` is a corrupted frame and a connection Chrome drops
//! without explanation.  Diagnostics go to standard error.  `--report` is the
//! mode for a person at a terminal rather than a browser at a pipe, and it is
//! the only one that prints.
//!
//! # The shape of the loop
//!
//! Three parts, deliberately not one:
//!
//! * **The reader** is an operating system thread of its own, blocking on
//!   stdin.  It turns bytes into [`Inbound`] and never touches the writer.
//! * **The dispatcher** is this task.  It answers the handshake, writes the
//!   record, gates a command on the fence and hands the run to [`Runner`].  It
//!   never waits on output.
//! * **The writer** is a task holding stdout.  It journals a response and then
//!   frames it.
//!
//! That division is the answer to `REVIEW.md` §3.7.  A loop that awaited
//! [`Runner::spawn`] would stop reading while a noisy command filled the
//! response channel, and the `Signal` that would have stopped the noise would
//! never arrive.  Here the reader cannot be blocked by the writer, and the
//! dispatcher's own line to the writer is separate from the bulk one, so a
//! stalled page delays output and nothing else.
//!
//! The reader also answers §3.3.  An inbound frame that declares more than the
//! ceiling has its body **consumed** before the refusal is reported, so the
//! next request is read from a frame boundary rather than from the middle of
//! somebody else's payload.  Beyond [`RESYNC_MAX`] the connection is ended
//! instead, because a length that large is not a message that went wrong.

use daimond_hand::{
    codec::{
        chunk_fit,
        resp_fits,
        Fault,
        Frame,
        INBOUND_MAX,
        LEN_PREFIX,
    },
    exec::{
        launch_main,
        Door,
        Launcher,
        Runner,
        Signalled,
        LAUNCH_ARG,
    },
    fence::{
        Fence,
        Plan,
        Unfenced,
    },
    journal::{
        self,
        Cfg as JournalCfg,
        Event,
        Journal,
    },
    seccomp::{
        Seccomp,
        Spec as SysSpec,
    },
    verify,
    wire::{
        proto_ok,
        proto_refusal,
        Req,
        Resp,
    },
};

use oxedyne_fe2o3_core::prelude::*;
use oxedyne_fe2o3_core::rand::Rand;

use std::{
    fs,
    io::Read,
    path::{
        Path,
        PathBuf,
    },
    sync::{
        atomic::{
            AtomicBool,
            Ordering,
        },
        Arc,
        Mutex,
    },
    time::Duration,
};

use tokio::{
    io::{
        AsyncWrite,
        AsyncWriteExt,
    },
    sync::mpsc::{
        channel,
        error::TrySendError,
        Receiver,
        Sender,
    },
};

// ┌───────────────────────────────────────────────────────────────┐
// │ Limits and constants                                           │
// └───────────────────────────────────────────────────────────────┘

/// The framing this binary speaks.
///
/// Fixed rather than configurable: a native messaging host is launched by a
/// browser onto a pipe, and the WebSocket arm of [`Frame`] belongs to the Cloud
/// tier, which supplies its own transport and its own loop.
const FRAMING: Frame = Frame::NativeMessaging;

/// The largest inbound frame whose body will be read and thrown away to regain
/// frame synchronisation.
///
/// `ext/hand.js` forwards anything under 60 MB, so a message that is merely too
/// big is a case that will happen and one the page should be told the ceiling
/// for.  A prefix beyond this is not a message that went wrong -- it is a
/// sender asking the hand to read four gigabytes -- and the connection is ended
/// instead.
const RESYNC_MAX: usize = 64 * 1024 * 1024;

/// Bytes discarded in one read while resynchronising.
const SKIP_CHUNK: usize = 64 * 1024;

/// How many requests may be waiting on the dispatcher.
///
/// Bounded, so a page that floods the pipe cannot make the hand allocate
/// without limit; the reader thread simply blocks, which is backpressure
/// arriving where it belongs.
const REQ_QUEUE: usize = 64;

/// How many responses from running commands may be waiting on the writer.
const BULK_QUEUE: usize = 256;

/// How many of the hand's own responses may be waiting on the writer.
///
/// Separate from the bulk queue so that a refusal or a handshake never queues
/// behind a megabyte of somebody's build output.
const CTL_QUEUE: usize = 256;

/// How long the writer is given to drain after the conversation has ended.
const DRAIN_MS: u64 = 3_000;

/// Bytes held back from a chunk for the marker that says what was dropped.
const MARKER_RESERVE: usize = 128;

/// The name of the file, beside the journal, that names the granted root.
///
/// In `lib.rs` because [`journal`] needs it too, to tell its own directory from
/// somebody else's.
use daimond_hand::ROOT_FILE;
use daimond_hand::TERMINAL_ROOT_FILE;

/// The variable that names the granted root, which takes precedence over the file.
const ROOT_VAR: &str = "DAIMOND_HAND_ROOT";

/// The terminal ceiling's variable, for the same reason [`ROOT_VAR`] exists.
const TERMINAL_ROOT_VAR: &str = "DAIMOND_HAND_TERMINAL_ROOT";

/// Daimond's own directory inside a workspace.
///
/// The app's `DAIMOND_DIR`, spelled here because the two halves have no shared
/// code and the name is part of the layout rather than of either program.  A
/// fence always denies it (`fence_spec` puts it in `deny`), which is what makes
/// it the right place for the identity file below: a fenced command cannot read
/// what it would need to forge one.
const APP_DIR: &str = ".daimond";

/// The file inside it that says which folder this is.
const WS_ID_FILE: &str = "workspace.id";

/// The prefix the workspace identity travels under, inside `caps`.
const WS_CAP: &str = "ws:";

/// What the identity says when the hand could not establish one.
///
/// A token is 32 hexadecimal characters and can never be this word, so the page
/// tells the two apart without a second field.
const WS_UNPROVEN: &str = "unproven";

// ┌───────────────────────────────────────────────────────────────┐
// │ What the loop is set up with                                   │
// └───────────────────────────────────────────────────────────────┘

/// Everything the loop needs that a test may want to vary.
#[derive(Clone, Debug)]
struct Serve {
    /// Where the record is written.
    journal:  JournalCfg,
    /// What this machine can enforce.
    fence:    Fence,
    /// The absolute folder this hand may work in.
    root:     PathBuf,
    /// The folders this machine will let a TERMINAL be fenced to, widest last.
    ///
    /// Always at least the granted root. See [`terminal_ceilings`]: the page chooses
    /// between them and cannot name a third, which is the Toolkit rule applied to the
    /// root itself.
    term_ceilings: Vec<PathBuf>,
    /// Whether `terminal-root.txt` pinned that list, which is a decision the user already made.
    term_pinned: bool,
    /// What is re-executed to apply the fence before a command exists.
    ///
    /// [`Launcher::SelfExe`] everywhere but in a test, where `/proc/self/exe`
    /// is libtest and libtest's `main` does not dispatch [`LAUNCH_ARG`].
    launcher: Launcher,
}

/// How the conversation finished.
///
/// An enum rather than a bare `Ok(())`, because the closing line of the journal
/// should say which of these happened and a test should be able to assert on it.
#[derive(Clone, Debug, Eq, PartialEq)]
enum Ending {
    /// The page said `bye`.
    Goodbye,
    /// The stream ended, which is how a browser usually says goodbye.
    Closed,
    /// The hand ended it, and this is why.
    Stopped(String),
}

impl Ending {

    /// The phrase the journal's closing line carries.
    fn why(&self) -> String {
        match self {
            Self::Goodbye		=> fmt!("the page said goodbye"),
            Self::Closed		=> fmt!("the page closed the pipe"),
            Self::Stopped(s)	=> s.clone(),
        }
    }
}

/// One thing the reader thread hands the dispatcher.
///
/// A frame that did not become a message is [`Inbound::Bad`] rather than an
/// error, because the framing is still intact and the next request is still
/// worth serving; only [`Inbound::Gone`] ends the conversation.
#[derive(Clone, Debug)]
enum Inbound {
    /// A message the page sent.
    Msg(Req),
    /// A frame that did not become a message, and the sentence saying why.
    Bad {
        /// Which named fault the codec raised, where it named one.
        fault:  Option<Fault>,
        /// What was wrong, in a sentence the page can act on.
        detail: String,
    },
    /// The stream ended, and this is how.
    Gone {
        /// Whether it ended between frames, which is how a browser says goodbye.
        clean:  bool,
        /// Why, in a phrase.
        reason: String,
    },
}

// ┌───────────────────────────────────────────────────────────────┐
// │ Modes for a person at a terminal                               │
// └───────────────────────────────────────────────────────────────┘

/// What a person gets when they run the binary themselves.
///
/// The installer tells them to, and it is the honest answer to "is this thing
/// actually protecting me": the capabilities are what the fence can enforce on
/// THIS kernel, and the holes are what it cannot.  A tool that printed only the
/// first list would be worse than one that printed nothing, because it would be
/// believed.
fn report() -> Outcome<()> {
    let os = res!(daimond_hand::checked_os());
    println!("{} {} on {}", daimond_hand::HOST_NAME, daimond_hand::version(), os);
    println!("protocol {}", daimond_hand::PROTO);
    println!();

    // Which folder, and whether the browser could tell it is that folder. Both
    // are configuration a person can get wrong, and neither is visible anywhere
    // else, so a report that omitted them would be answering the easy half.
    println!("Which folder it may work in:");
    match journal::default_dir().and_then(|d| granted_root(&d)) {
        Ok(root) => {
            println!("  {}", root.display());
            match workspace_id(&root) {
                Identity::Known(t) => println!(
                    "  identity {}, from {}", t,
                    root.join(APP_DIR).join(WS_ID_FILE).display()),
                Identity::Unproven(why) => println!(
                    "  - no identity, so the browser cannot check that this is \
                    the folder you opened: {}", why),
            }
        },
        Err(e) => println!("  - none: {}", e.msgs().join(" ")),
    }
    println!();

    // WHAT RUNS OUTSIDE THE FENCE, said to a person before the fence is described --
    // because a list of what the compartment enforces, printed above a verb that steps
    // around it, would be a report that told the truth twice and the whole truth never.
    println!("Verifiers it will run, OUTSIDE the fence:");
    match journal::default_dir().and_then(|d| granted_root(&d)) {
        Ok(root) => match verify::catalogue(&root) {
            Ok(v) if v.is_empty() => println!(
                "  - none: there is no dev/verify_*.mjs in that folder, so the \
                verify verb refuses on this machine."),
            Ok(v) => {
                println!("  {} in {}", v.len(), root.join(verify::DEV_DIR).display());
                println!(
                    "  Each is run by NAME, looked up in that directory, with an argument \
                    vector this program builds; a page cannot name a path, a program or an \
                    argument. They run unfenced deliberately -- a fenced command cannot \
                    reach the display server, so a verifier that drives a browser cannot \
                    run at all -- and each run is journalled with fence:none.");
            },
            Err(e) => println!("  - none: {}", e.msgs().join(" ")),
        },
        Err(_) => println!("  - none, since no folder is granted."),
    }
    println!();

    println!("What this machine can enforce:");
    for c in enforcing() {
        println!("  {}", c);
    }
    println!();
    println!("What it cannot:");
    for h in remaining() {
        println!("  - {}", h);
    }
    Ok(())
}

/// Everything in force on a command, from both layers, in one list.
///
/// The compartment is two mechanisms and the user is owed one answer.  Landlock
/// says what a command may open; [`daimond_hand::seccomp`] says what it may
/// *call*, which is where `chmod` on a denied file and the session bus live.  A
/// caps list from one of them describes half a compartment.
fn enforcing() -> Vec<String> {
    let mut out = Fence::detect().caps();
    out.extend(Seccomp::detect().caps());
    out
}

/// Everything still reachable, from both layers, in one list.
///
/// **This is the sentence the consent window is drawn from**, so it has to be
/// the composed truth rather than either half.  `Fence::holes` is told what the
/// filter closes, so the two entries seccomp answers -- the metadata calls and
/// the session bus -- do not appear twice and do not appear at all once they are
/// shut; and what the filter itself cannot do is added from its own two lists,
/// which are about the mechanism and about the spec that was chosen.
fn remaining() -> Vec<String> {
    let sys  = Seccomp::detect();
    let spec = SysSpec::for_command();
    let have = matches!(sys, Seccomp::Linux { .. });
    let mut out = Fence::detect().holes(if have { Some(&spec) } else { None });
    out.extend(sys.holes());
    if let Ok(f) = sys.plan(&spec) {
        out.extend(f.holes());
    }
    out
}

/// Whether an argument means "a browser launched this".
///
/// Chrome passes the calling extension's origin as the first argument and
/// nothing else; on Windows it adds a parent window handle.  Firefox passes the
/// manifest path and the extension id.  None of them is a flag, so an argument
/// that looks like one of these is not an error -- it is the browser
/// introducing itself.
///
/// # Arguments
/// * `arg` - The first argument.
fn is_browser_arg(arg: &str) -> bool {
    arg.starts_with("chrome-extension://")
        || arg.starts_with("moz-extension://")
        || arg.starts_with("--parent-window=")
}

// ┌───────────────────────────────────────────────────────────────┐
// │ The granted root                                               │
// └───────────────────────────────────────────────────────────────┘

/// The absolute folder this hand may work in.
///
/// The page cannot know it.  The File System Access API hands the page a
/// *handle* and never a path, so the only end of the conversation that can name
/// the folder in the machine's own terms is this one, and `src/tools.rs`
/// refuses to run anything without it.
///
/// [`ROOT_VAR`] first, then a single line in [`ROOT_FILE`] beside the journal.
/// There is deliberately no third answer: a hand that guessed a root would be
/// guessing what a command may touch.
///
/// # Arguments
/// * `dir` - The journal directory, which is where the file lives.
///
/// # Returns
/// The canonical directory, or an error naming both places it looked.
fn granted_root(dir: &Path) -> Outcome<PathBuf> {
    let raw = match std::env::var(ROOT_VAR) {
        Ok(v) if !v.trim().is_empty() => v.trim().to_string(),
        _ => match root_from_file(dir) {
            Some(s) => s,
            None => return Err(err!(
                "This hand has not been told which folder it may work in, so it \
                will not serve a page. Set {} to an absolute path, or write that \
                path as the first line of '{}'. Nothing was guessed, because a \
                guessed root is a guess about what a command may touch.",
                ROOT_VAR, dir.join(ROOT_FILE).display();
                Missing, Configuration, Path)),
        },
    };
    if raw.is_empty() {
        return Err(err!(
            "The granted root is the empty string, which names every path there \
            is rather than none. Set {} to an absolute path.", ROOT_VAR;
            Invalid, Configuration, Path));
    }
    let p = PathBuf::from(&raw);
    if !p.is_absolute() {
        return Err(err!(
            "The granted root '{}' is not an absolute path. The hand joins the \
            page's workspace-relative names onto it, and a relative root would \
            resolve against whatever directory the browser happened to be \
            started in.", raw;
            Invalid, Configuration, Path));
    }
    let real = res!(fs::canonicalize(&p).map_err(|e| err!(e,
        "The granted root '{}' cannot be resolved, so the hand cannot say what \
        a command would be allowed to touch. It must exist before it can be \
        granted.", raw;
        Invalid, Configuration, Path)));
    if !real.is_dir() {
        return Err(err!(
            "The granted root '{}' is not a directory.", real.display();
            Invalid, Configuration, Path));
    }
    Ok(real)
}

// ┌───────────────────────────────────────────────────────────────┐
// │ Whether the granted root is the page's workspace               │
// └───────────────────────────────────────────────────────────────┘

/// What the hand can say about *which* folder it was granted.
///
/// # The problem this exists for
///
/// `REVIEW.md` §1.14.  The two ends name the same folder in two ways that
/// cannot be compared: the page holds a File System Access *handle*, which has
/// no path and cannot be turned into one, and the hand holds a path it was
/// configured with.  `Tool::run` then joins the page's workspace-relative names
/// -- `src/main.rs`, `Cargo.toml` -- onto the hand's root and fences the result.
///
/// Nothing checked that these were the same folder, and every failure is silent
/// and plausible.  A `root.txt` left behind from a different project, a page
/// whose workspace lives only in OPFS and has no folder at all, a user who
/// granted the browser one directory and the hand another: in each of them the
/// model reads one tree, the command runs in a second, and the output is
/// perfectly reasonable answers to a question nobody asked.  Fencing works
/// exactly as designed the whole time, because the fence was told to protect the
/// wrong folder.
///
/// # What is done about it
///
/// The hand puts a random token in `<root>/.daimond/workspace.id` and publishes
/// it in `caps`.  The page can read that file through the handle it already has,
/// and one comparison then settles the question: the same token means the two
/// names denote one directory, and anything else means they do not.  The token
/// is written once and kept, so it is an identity for the folder rather than for
/// the run, and a page that remembers it notices the folder changing underneath
/// it as well.
///
/// It sits inside `.daimond` deliberately.  A fence denies that directory, so a
/// command cannot read the token, and a command that has been talked into
/// helping cannot answer a challenge about a folder it is not in.
///
/// The hand cannot make the comparison itself -- it has one of the two names --
/// so this is evidence rather than enforcement, and the refusal belongs where
/// both names meet.
#[derive(Clone, Debug, Eq, PartialEq)]
enum Identity {
    /// A token the page can compare against the folder it holds.
    Known(String),
    /// No token could be established, and this is why.
    Unproven(String),
}

impl Identity {

    /// The `caps` entry this becomes.
    fn cap(&self) -> String {
        match self {
            Self::Known(t)		=> fmt!("{}{}", WS_CAP, t),
            Self::Unproven(_)	=> fmt!("{}{}", WS_CAP, WS_UNPROVEN),
        }
    }
}

/// How many hexadecimal characters an identity token has.
const WS_ID_LEN: usize = 32;

/// The token naming the granted folder, written where the page can read it.
///
/// An existing token is kept: the file is the folder's name to the page, and a
/// hand that minted a new one on every launch would tell the page its workspace
/// had been replaced every time the browser restarted.
///
/// # Arguments
/// * `root` - The granted folder.
fn workspace_id(root: &Path) -> Identity {
    let dir  = root.join(APP_DIR);
    let path = dir.join(WS_ID_FILE);
    if let Ok(txt) = fs::read_to_string(&path) {
        if let Some(tok) = id_from_file(&txt) {
            return Identity::Known(tok);
        }
    }
    if let Err(e) = fs::create_dir_all(&dir) {
        return Identity::Unproven(fmt!(
            "'{}' could not be created ({})", dir.display(), e));
    }
    let tok = mint_id();
    let txt = fmt!(
        "# Daimond wrote this so that the browser and the machine hand can tell \
        whether\n# they are talking about the same folder. It is not a secret \
        and not a key.\n# Deleting it costs nothing: the next hand to start \
        writes a new one, and the\n# page will ask you to confirm the folder \
        again.\n{}\n", tok);
    if let Err(e) = fs::write(&path, txt) {
        return Identity::Unproven(fmt!(
            "'{}' could not be written ({})", path.display(), e));
    }
    tighten(&path);
    Identity::Known(tok)
}

/// The token a written identity file carries, where it carries a valid one.
///
/// The first line that is neither blank nor a `#` comment, exactly as
/// [`root_from_file`] reads its own, so a person opening either file finds the
/// same convention.
///
/// # Arguments
/// * `txt` - The file's contents.
fn id_from_file(txt: &str) -> Option<String> {
    for line in txt.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        // A token that is not the shape a token has is not a token. Rewriting is
        // the right answer: whatever is in there, it did not come from here.
        if t.len() == WS_ID_LEN
            && t.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        {
            return Some(t.to_string());
        }
        return None;
    }
    None
}

/// A new identity token.
fn mint_id() -> String {
    fmt!("{:016x}{:016x}", Rand::rand_u64(), Rand::rand_u64())
}

/// Makes the identity file the user's own, where the platform has such a notion.
///
/// Best effort: a file that could not be tightened is still a usable identity,
/// and the token is not a secret.
///
/// # Arguments
/// * `path` - The file.
fn tighten(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perm = match fs::metadata(path) {
            Ok(md) => md.permissions(),
            Err(_) => return,
        };
        perm.set_mode(0o600);
        let _ = fs::set_permissions(path, perm);
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

/// The root named by the file beside the journal, where there is one.
///
/// The first line that is neither blank nor a `#` comment, so the file can
/// explain itself to whoever opens it next.
///
/// # Arguments
/// * `dir` - The journal directory.
fn root_from_file(dir: &Path) -> Option<String> {
    named_in_file(dir, ROOT_FILE)
}

/// The terminal ceiling, where the installer wrote one.
///
/// Resolved the same way and to the same rules as [`granted_root`], and it is a
/// CEILING: what a terminal may never reach past, not where one opens. A ceiling that
/// is not an absolute directory is treated as absent rather than refused -- the hand
/// still has a granted root to work from, and refusing to start over a file the user
/// may not know exists would take the machine away over an optional setting.
///
/// # Arguments
/// * `dir` - The journal directory, which is where the file lives.
fn terminal_ceilings(dir: &Path, root: &Path) -> Vec<PathBuf> {
    // Pinned: an installer that named a ceiling has made the decision, and the browser is offered
    // that and nothing else.
    if let Some(p) = terminal_ceiling(dir) {
        return vec![p];
    }
    // Otherwise the two folders this machine can honestly offer: what it was granted, and the
    // account it runs as. Both come from the machine, which is the property that matters -- the
    // page CHOOSES between them and cannot invent a third.
    let mut out = vec![root.to_path_buf()];
    if let Ok(h) = std::env::var("HOME") {
        let p = PathBuf::from(&h);
        if p.is_absolute() {
            if let Ok(c) = fs::canonicalize(&p) {
                if c.is_dir() && c != root {
                    out.push(c);
                }
            }
        }
    }
    out
}

/// The ceiling the installer pinned, where it pinned one.
fn terminal_ceiling(dir: &Path) -> Option<PathBuf> {
    let raw = match std::env::var(TERMINAL_ROOT_VAR) {
        Ok(v) if !v.trim().is_empty() => v.trim().to_string(),
        _ => match named_in_file(dir, TERMINAL_ROOT_FILE) {
            Some(s) => s,
            None    => return None,
        },
    };
    let p = PathBuf::from(&raw);
    if !p.is_absolute() {
        eprintln!("daimond-hand: the terminal ceiling '{}' is not an absolute path, so it was \
            ignored and a terminal gets the granted root.", raw);
        return None;
    }
    match fs::canonicalize(&p) {
        Ok(c) if c.is_dir() => Some(c),
        _ => {
            eprintln!("daimond-hand: the terminal ceiling '{}' is not a directory on this \
                machine, so it was ignored and a terminal gets the granted root.", raw);
            None
        },
    }
}

/// The first line of `name` beside the journal that is neither blank nor a comment.
fn named_in_file(dir: &Path, name: &str) -> Option<String> {
    let txt = match fs::read_to_string(dir.join(name)) {
        Ok(t)  => t,
        Err(_) => return None,
    };
    for line in txt.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        return Some(t.to_string());
    }
    None
}

// ┌───────────────────────────────────────────────────────────────┐
// │ Reading                                                        │
// └───────────────────────────────────────────────────────────────┘

/// How much of a buffer arrived.
///
/// `Read::read_exact` cannot tell a clean end from a short one, and the
/// difference decides whether the page has gone or something is wrong.
enum Filled {
    /// The whole buffer.
    All,
    /// The stream ended after this many bytes.
    Ended(usize),
    /// The stream could not be read, and this is what it said.
    Failed(String),
}

/// Fills a buffer, distinguishing a clean end from a short one.
///
/// # Arguments
/// * `r`   - The stream.
/// * `buf` - The buffer to fill.
fn fill<R: Read>(r: &mut R, buf: &mut [u8]) -> Filled {
    let mut n = 0;
    while n < buf.len() {
        match r.read(&mut buf[n..]) {
            Ok(0)  => return Filled::Ended(n),
            Ok(k)  => n += k,
            Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Filled::Failed(fmt!("{}", e)),
        }
    }
    Filled::All
}

/// Discards a declared body so that the next read starts at a frame boundary.
///
/// This is the whole of the answer to `REVIEW.md` §3.3.  Refusing an oversized
/// frame without consuming it leaves its payload in the pipe, where the next
/// four bytes of somebody's JSON are read as a length prefix and every request
/// after it is nonsense.
///
/// # Arguments
/// * `r` - The stream.
/// * `n` - How many bytes the prefix declared.
///
/// # Returns
/// Nothing where the body was consumed, or a phrase where the stream ended part
/// way through it.
fn skip<R: Read>(r: &mut R, n: usize) -> Option<String> {
    let mut left = n;
    let mut pail = vec![0u8; SKIP_CHUNK.min(n.max(1))];
    while left > 0 {
        let want = left.min(pail.len());
        match fill(r, &mut pail[..want]) {
            Filled::All			=> left -= want,
            Filled::Ended(got)	=> return Some(fmt!(
                "the stream ended {} bytes into a {}-byte frame that was being \
                discarded", n - left + got, n)),
            Filled::Failed(e)	=> return Some(fmt!(
                "the stream could not be read while discarding an oversized \
                frame: {}", e)),
        }
    }
    None
}

/// Reads frames until the stream ends, handing each to the dispatcher.
///
/// Runs on a thread of its own so that nothing the writer does can stop it.
/// The four-byte prefix is read here rather than through [`Frame::read_payload`]
/// for one reason: resynchronising after an oversized frame needs the declared
/// length, and the codec refuses such a frame before it can be asked for it.
/// Everything after that read -- the ceiling, the UTF-8, the JSON, the shape --
/// is the codec's, and the whole frame is handed back to
/// [`Frame::read_req`] rather than taken apart here.
///
/// # Arguments
/// * `r`  - The stream, which this thread owns.
/// * `tx` - Where each message goes.
fn read_frames<R: Read>(mut r: R, tx: Sender<Inbound>) {
    loop {
        let mut pre = [0u8; LEN_PREFIX];
        match fill(&mut r, &mut pre) {
            Filled::All => (),
            Filled::Ended(0) => {
                let _ = tx.blocking_send(Inbound::Gone {
                    clean:  true,
                    reason: fmt!("the page closed the pipe"),
                });
                return;
            },
            Filled::Ended(got) => {
                let _ = tx.blocking_send(Inbound::Gone {
                    clean:  false,
                    reason: fmt!(
                        "the stream ended {} bytes into a {}-byte length prefix",
                        got, LEN_PREFIX),
                });
                return;
            },
            Filled::Failed(e) => {
                let _ = tx.blocking_send(Inbound::Gone {
                    clean:  false,
                    reason: fmt!("the stream could not be read: {}", e),
                });
                return;
            },
        }

        let n = u32::from_ne_bytes(pre) as usize;
        if n > INBOUND_MAX {
            if n > RESYNC_MAX {
                let _ = tx.blocking_send(Inbound::Gone {
                    clean:  false,
                    reason: fmt!(
                        "a frame declared {} bytes, and the hand will not read \
                        past {} to find the next one", n, RESYNC_MAX),
                });
                return;
            }
            // Consume it, then say so: the next frame must start where the next
            // frame starts.
            if let Some(why) = skip(&mut r, n) {
                let _ = tx.blocking_send(Inbound::Gone { clean: false, reason: why });
                return;
            }
            let sent = tx.blocking_send(Inbound::Bad {
                fault:  Some(Fault::LengthTooBig),
                detail: fmt!(
                    "A message of {} bytes arrived and this hand reads at most \
                    {}. It was discarded whole and the connection carries on \
                    from the next message; send the same thing in smaller \
                    pieces.", n, INBOUND_MAX),
            });
            if sent.is_err() {
                return;
            }
            continue;
        }

        let mut body = vec![0u8; n];
        match fill(&mut r, &mut body) {
            Filled::All => (),
            Filled::Ended(got) => {
                let _ = tx.blocking_send(Inbound::Gone {
                    clean:  false,
                    reason: fmt!(
                        "the stream ended {} bytes into a {}-byte message", got, n),
                });
                return;
            },
            Filled::Failed(e) => {
                let _ = tx.blocking_send(Inbound::Gone {
                    clean:  false,
                    reason: fmt!("the stream could not be read: {}", e),
                });
                return;
            },
        }

        // One whole frame, handed back to the codec rather than taken apart here.
        let mut whole = Vec::with_capacity(LEN_PREFIX + n);
        whole.extend_from_slice(&pre);
        whole.extend_from_slice(&body);
        let mut cur: &[u8] = &whole;
        let msg = match FRAMING.read_req(&mut cur) {
            Ok(Some(req)) => Inbound::Msg(req),
            Ok(None) => Inbound::Bad {
                fault:  None,
                detail: fmt!("A frame of {} bytes carried no message at all.", n),
            },
            Err(e) => Inbound::Bad {
                fault:  Fault::of(&e),
                detail: e.msgs().join("; "),
            },
        };
        if tx.blocking_send(msg).is_err() {
            return;
        }
    }
}

// ┌───────────────────────────────────────────────────────────────┐
// │ Writing                                                        │
// └───────────────────────────────────────────────────────────────┘

/// The run a response concerns, where it concerns one.
///
/// # Arguments
/// * `resp` - The response.
fn id_of(resp: &Resp) -> Option<String> {
    match resp {
        Resp::Started { id, .. }	=> Some(id.clone()),
        Resp::Chunk   { id, .. }	=> Some(id.clone()),
        Resp::Ended   { id, .. }	=> Some(id.clone()),
        Resp::Refused { id, .. }	=> Some(id.clone()),
        Resp::Error   { id, .. }	=> id.clone(),
        Resp::Opened  { id, .. }	=> Some(id.clone()),
        Resp::Output  { id, .. }	=> Some(id.clone()),
        Resp::Closed  { id, .. }	=> Some(id.clone()),
        Resp::Filed   { id, .. }	=> Some(id.clone()),
        // A listing is about every run at once, so it is about no single one.
        Resp::Runs    { .. }		=> None,
        // A folder listing is about no run at all.
        Resp::Dirs    { .. }		=> None,
        Resp::Granted { .. }		=> None,
        // Sent before the greeting, when there is no run to name and no conversation
        // to name one in.
        Resp::Fault   { .. }		=> None,
        Resp::Hello   { .. }		=> None,
    }
}

/// The largest character boundary of `text` at or below `n`.
///
/// # Arguments
/// * `text` - The text.
/// * `n` - The byte offset wanted.
fn snap(text: &str, n: usize) -> usize {
    let mut m = n.min(text.len());
    while m > 0 && !text.is_char_boundary(m) {
        m -= 1;
    }
    m
}

/// The marker that stands in for what would not fit.
///
/// Plain ASCII with nothing JSON escapes, so its cost on the wire is its length
/// and the arithmetic above it does not have to guess.
///
/// # Arguments
/// * `dropped` - How many bytes were left out.
fn marker(dropped: usize) -> String {
    fmt!(" [{} bytes were dropped here: one frame cannot carry them]", dropped)
}

/// The largest prefix of `text` for which the response built from it fits.
///
/// Bisection over the encoder rather than arithmetic over it: JSON escaping
/// inflates by up to six times for a control byte, so a subtraction from
/// [`daimond_hand::wire::FRAME_MAX`] would be a guess that is wrong exactly
/// when it matters.
///
/// # Arguments
/// * `text` - The text to cut.
/// * `build` - How to make the response from a candidate prefix.
fn largest_fit<F>(text: &str, build: F) -> Outcome<usize>
where
    F: Fn(&str) -> Resp,
{
    if res!(resp_fits(FRAMING, &build(text))) {
        return Ok(text.len());
    }
    if !res!(resp_fits(FRAMING, &build(""))) {
        // The envelope alone is too large, so no cut helps.
        return Ok(usize::MAX);
    }
    let mut lo = 0usize;
    let mut hi = text.len();
    while hi - lo > 1 {
        let m = snap(text, lo + (hi - lo) / 2);
        if m <= lo {
            break;
        }
        if res!(resp_fits(FRAMING, &build(&text[..m]))) {
            lo = m;
        } else {
            hi = m;
        }
    }
    Ok(lo)
}

/// The same response with its one long field cut down to fit a frame.
///
/// `REVIEW.md` §3.1: an oversized chunk was dropped and the run's output
/// vanished.  Silence is the one answer that is not honest, so what fits is
/// sent, the marker says how much did not, and the caller sends a
/// [`Resp::Error`] as well so that the loss is a fact on the wire and in the
/// journal rather than an inference from a short transcript.
///
/// # Arguments
/// * `resp` - The response that would not fit.
///
/// # Returns
/// The smaller response and the sentence naming what was cut, or nothing where
/// the envelope alone is too large for a frame and no cut would help.
fn cut(resp: &Resp) -> Outcome<Option<(Resp, String)>> {
    match resp {
        Resp::Chunk { id, stream, seq, data } => {
            // The measured fit, from the codec's own helper.
            let room = match chunk_fit(FRAMING, id, *stream, *seq, data) {
                Ok(r)  => r,
                Err(_) => return Ok(None),
            };
            let keep = snap(data, room.saturating_sub(MARKER_RESERVE));
            let lost = data.len() - keep;
            let mut txt = data[..keep].to_string();
            txt.push_str(&marker(lost));
            let mut out = Resp::Chunk {
                id:     id.clone(),
                stream: *stream,
                seq:    *seq,
                data:   txt,
            };
            if !res!(resp_fits(FRAMING, &out)) {
                // The reserve was not enough, which means the envelope is very
                // large; the marker alone is still worth sending.
                out = Resp::Chunk {
                    id:     id.clone(),
                    stream: *stream,
                    seq:    *seq,
                    data:   marker(data.len()),
                };
                if !res!(resp_fits(FRAMING, &out)) {
                    return Ok(None);
                }
            }
            Ok(Some((out, fmt!(
                "{} bytes of output from run '{}' did not fit in one message and \
                were dropped. The transcript is short by that much.",
                data.len() - keep, id))))
        },
        Resp::Refused { id, reason } => {
            let keep = res!(largest_fit(reason, |t| Resp::Refused {
                id:     id.clone(),
                reason: t.to_string(),
            }));
            if keep == usize::MAX {
                return Ok(None);
            }
            let keep = snap(reason, keep.saturating_sub(MARKER_RESERVE));
            Ok(Some((
                Resp::Refused {
                    id:     id.clone(),
                    reason: fmt!("{}{}", &reason[..keep], marker(reason.len() - keep)),
                },
                fmt!("A refusal for run '{}' was too long for one message and was cut.", id),
            )))
        },
        Resp::Error { id, message } => {
            let keep = res!(largest_fit(message, |t| Resp::Error {
                id:      id.clone(),
                message: t.to_string(),
            }));
            if keep == usize::MAX {
                return Ok(None);
            }
            let keep = snap(message, keep.saturating_sub(MARKER_RESERVE));
            Ok(Some((
                Resp::Error {
                    id:      id.clone(),
                    message: fmt!("{}{}", &message[..keep], marker(message.len() - keep)),
                },
                fmt!("A message was too long for one frame and was cut."),
            )))
        },
        // Terminal output is cut like a chunk, but only ever on a whole base64 quantum:
        // base64 decodes four characters to three bytes, so a cut anywhere else hands the
        // page a fragment it cannot decode -- and unlike a truncated line of text, a
        // half-decoded escape sequence does not merely look wrong, it steers the terminal.
        Resp::Output { id, seq, data } => {
            // `output_frames` is what a PRODUCER should use; this is the last-resort trim for
            // a response already built, so it measures the same way the Error arm does.
            let room = res!(largest_fit(data, |t| Resp::Output {
                id:   id.clone(),
                seq:  *seq,
                data: t.to_string(),
            }));
            if room == usize::MAX {
                return Ok(None);
            }
            let keep = (room / 4) * 4;
            if keep == 0 {
                return Ok(None);
            }
            let lost = data.len() - keep;
            Ok(Some((
                Resp::Output { id: id.clone(), seq: *seq, data: data[..keep].to_string() },
                fmt!("{} characters of terminal output for '{}' would not fit and were \
                    dropped.", lost, id),
            )))
        },
        // The rest are bounded by their own fields and cannot be cut without
        // changing what they say.
        // A listing is bounded at the source: `wire::RUNS_MAX` entries of
        // `wire::RUN_WHAT_MAX` bytes cannot approach a frame, and what did not
        // fit is COUNTED in `more` rather than cut here. Trimming it would drop
        // a run silently, which is the one thing a listing must never do.
        Resp::Runs { .. } => Ok(None),
        // A folder listing has nothing that can be cut in half and still mean anything: half a
        // list of directory names reads as a folder with fewer folders in it. The bound keeps
        // it small -- one directory's immediate children, names only.
        Resp::Dirs { .. } => Ok(None),
        // One path and one sentence; there is nothing in it to cut.
        Resp::Granted { .. } => Ok(None),
        // A file's text, cut like a refusal's sentence: what fits is sent and the marker says
        // how much did not. The launcher caps it at `wire::FILE_TEXT_MAX` already, so reaching
        // here means an enormous path or a very long refusal, not an ordinary read.
        Resp::Filed { id, ok, text } => {
            let keep = res!(largest_fit(text, |t| Resp::Filed {
                id:   id.clone(),
                ok:   *ok,
                text: t.to_string(),
            }));
            if keep == usize::MAX {
                return Ok(None);
            }
            let keep = snap(text, keep.saturating_sub(MARKER_RESERVE));
            Ok(Some((
                Resp::Filed {
                    id:   id.clone(),
                    ok:   *ok,
                    text: fmt!("{}{}", &text[..keep], marker(text.len() - keep)),
                },
                fmt!("The answer to file request '{}' was too long for one message and was \
                    cut.", id),
            )))
        },
        Resp::Hello { .. } | Resp::Started { .. } | Resp::Ended { .. }
        | Resp::Opened { .. } | Resp::Closed { .. } => Ok(None),
        // Composed by this binary from its own refusal, so it is a sentence and not a
        // transcript. Nothing here is long enough to need cutting, and a cut one would be
        // the reason a hand will not start, truncated.
        Resp::Fault { .. } => Ok(None),
    }
}

/// The bytes one response occupies, cut down where it would not fit.
///
/// # Arguments
/// * `resp` - The response.
///
/// # Returns
/// The frame, and the sentence naming what was cut where anything was.
fn encode(resp: &Resp) -> Outcome<(Vec<u8>, Option<String>)> {
    let mut buf = Vec::new();
    match FRAMING.write_resp(&mut buf, resp) {
        Ok(()) => return Ok((buf, None)),
        Err(e) => match Fault::of(&e) {
            // Nothing was written: the codec refuses before it writes, so there
            // is no half a frame in the pipe to worry about.
            Some(Fault::FrameTooBig) => (),
            _ => return Err(e),
        },
    }
    match res!(cut(resp)) {
        Some((smaller, note)) => {
            buf.clear();
            res!(FRAMING.write_resp(&mut buf, &smaller));
            Ok((buf, Some(note)))
        },
        None => Err(Fault::FrameTooBig.raise(&fmt!(
            "A {} response does not fit in one frame even with its text \
            removed, so nothing about it could be sent.", kind_of(resp)))),
    }
}

/// The wire's word for which response this is, for a diagnostic.
///
/// # Arguments
/// * `resp` - The response.
fn kind_of(resp: &Resp) -> &'static str {
    match resp {
        Resp::Hello   { .. }	=> "hello",
        Resp::Started { .. }	=> "started",
        Resp::Chunk   { .. }	=> "chunk",
        Resp::Ended   { .. }	=> "ended",
        Resp::Refused { .. }	=> "refused",
        Resp::Error   { .. }	=> "error",
        Resp::Opened  { .. }	=> "opened",
        Resp::Output  { .. }	=> "output",
        Resp::Closed  { .. }	=> "closed",
        Resp::Runs    { .. }	=> "runs",
        Resp::Dirs    { .. }	=> "dirs",
        Resp::Granted { .. }	=> "granted",
        Resp::Filed   { .. }	=> "filed",
        Resp::Fault   { .. }	=> "fault",
    }
}

/// Writes responses until both lines close.
///
/// The hand's own line is preferred over the bulk one, so a refusal is not
/// queued behind a build's output; within one run every response comes down the
/// bulk line and so keeps its order.
///
/// Each response is written to the journal **before** it is written to the
/// wire, so the record cannot be missing something the page was told.
///
/// # Arguments
/// * `w`     - Where the frames go.
/// * `ctl`   - The hand's own responses.
/// * `bulk`  - Everything the runs say.
/// * `jr`    - The record.
/// * `sound` - Cleared where the record could not be written.
/// * `alive` - Cleared where the page stopped listening.
async fn write_loop<W>(
    mut w:  W,
    mut ctl:  Receiver<Resp>,
    mut bulk: Receiver<Resp>,
    jr:       Arc<Mutex<Journal>>,
    sound:    Arc<AtomicBool>,
    alive:    Arc<AtomicBool>,
)
    -> Outcome<()>
where
    W: AsyncWrite + Unpin + Send + 'static,
{
    let mut ctl_open  = true;
    let mut bulk_open = true;
    while ctl_open || bulk_open {
        let got = tokio::select! {
            biased;
            r = ctl.recv(), if ctl_open => match r {
                Some(r) => Some(r),
                None    => { ctl_open = false; None },
            },
            r = bulk.recv(), if bulk_open => match r {
                Some(r) => Some(r),
                None    => { bulk_open = false; None },
            },
        };
        let resp = match got {
            Some(r) => r,
            None    => continue,
        };
        if !res!(deliver(&mut w, &resp, &jr, &sound).await) {
            alive.store(false, Ordering::SeqCst);
            break;
        }
    }
    let _ = w.flush().await;
    Ok(())
}

/// Journals one response and writes it, with whatever note the cut produced.
///
/// # Arguments
/// * `w`     - Where the frame goes.
/// * `resp`  - The response.
/// * `jr`    - The record.
/// * `sound` - Cleared where the record could not be written.
///
/// # Returns
/// Whether the page is still listening.
async fn deliver<W>(
    w:     &mut W,
    resp:  &Resp,
    jr:    &Arc<Mutex<Journal>>,
    sound: &Arc<AtomicBool>,
)
    -> Outcome<bool>
where
    W: AsyncWrite + Unpin,
{
    // The record first. A `Started` nobody wrote down is a command that ran
    // without a record, which is the one thing the journal exists to prevent.
    if let Some(ev) = Event::from_resp(resp) {
        let done = {
            let mut g = lock_mutex!(jr);
            g.append(&ev)
        };
        if let Err(e) = done {
            sound.store(false, Ordering::SeqCst);
            eprintln!(
                "daimond-hand: the journal could not be written, so no further \
                command will be run: {}", e);
        }
    }
    let (bytes, note) = match encode(resp) {
        Ok(v) => v,
        Err(e) => {
            // Nothing was written, so the stream is still in step; the loss is
            // reported rather than hidden.
            eprintln!("daimond-hand: a response could not be sent: {}", e);
            return Ok(true);
        },
    };
    match w.write_all(&bytes).await {
        Ok(())  => (),
        Err(e)  => {
            eprintln!("daimond-hand: the page stopped listening: {}", e);
            return Ok(false);
        },
    }
    match w.flush().await {
        Ok(())  => (),
        Err(e)  => {
            eprintln!("daimond-hand: the page stopped listening: {}", e);
            return Ok(false);
        },
    }
    match note {
        // The loss is now a message of its own, so the page and the journal
        // both hold it as a fact rather than as a short transcript.
        Some(n) => {
            let told = Resp::Error { id: id_of(resp), message: n };
            let inner = {
                if let Some(ev) = Event::from_resp(&told) {
                    let mut g = lock_mutex!(jr);
                    let _ = g.append(&ev);
                }
                encode(&told)
            };
            match inner {
                Ok((b, _)) => match w.write_all(&b).await {
                    Ok(()) => {
                        let _ = w.flush().await;
                        Ok(true)
                    },
                    Err(_) => Ok(false),
                },
                Err(e) => {
                    eprintln!("daimond-hand: a truncation could not be reported: {}", e);
                    Ok(true)
                },
            }
        },
        None => Ok(true),
    }
}

// ┌───────────────────────────────────────────────────────────────┐
// │ The dispatcher                                                 │
// └───────────────────────────────────────────────────────────────┘

/// Everything the dispatcher answers a message with.
///
/// Held together in one place so that the handlers take one argument rather
/// than nine, and so that the two lines to the writer cannot be confused with
/// each other.
struct Desk {
    /// What this machine can enforce with Landlock.
    fence:  Fence,
    /// What it can refuse at the system-call layer.
    ///
    /// Asked once, because [`Seccomp::detect`] answers by installing a throwaway
    /// filter on a thread of its own and that is not a thing to do per command.
    sys:    Seccomp,
    /// The folder this hand may work in.
    root:   PathBuf,
    /// The folders a terminal may be fenced to, widest last. Never empty.
    term_ceilings: Vec<PathBuf>,
    /// Whether the installer PINNED that list to one folder, rather than offering a choice.
    term_pinned: bool,
    /// What the page can check that folder's identity against.
    ws:     Identity,
    /// The operating system, in the wire's own vocabulary.
    os:     &'static str,
    /// Live runs.
    runner: Runner,
    /// Live terminal sessions.
    ptys:   daimond_hand::pty::PtySessions,
    files:  daimond_hand::exec::Files,	// the file door, which has nothing live to hold
    /// The record.
    jr:     Arc<Mutex<Journal>>,
    /// Whether the record is still being written.
    sound:  Arc<AtomicBool>,
    /// Whether the page is still listening.
    alive:  Arc<AtomicBool>,
    /// The hand's own line to the writer.
    ctl:    Sender<Resp>,
    /// The line every run's output takes.
    bulk:   Sender<Resp>,
}

impl Desk {

    /// Writes one event, and remembers a failure.
    ///
    /// # Arguments
    /// * `ev` - What happened.
    fn record(&self, ev: &Event) -> Outcome<()> {
        let done = {
            let mut g = lock_mutex!(self.jr);
            g.append(ev)
        };
        match done {
            Ok(_) => Ok(()),
            Err(e) => {
                self.sound.store(false, Ordering::SeqCst);
                Err(e)
            },
        }
    }

    /// Sends one of the hand's own responses.
    ///
    /// Never awaits.  The dispatcher must be able to answer a `Signal` while a
    /// command floods the pipe, and a queue that has taken 256 unread
    /// acknowledgements is a page that is not reading rather than a page that
    /// is behind.
    ///
    /// # Arguments
    /// * `resp` - The response.
    ///
    /// # Returns
    /// Whether the conversation can carry on.
    fn say(&self, resp: Resp) -> bool {
        match self.ctl.try_send(resp) {
            Ok(()) => true,
            Err(TrySendError::Full(_)) => {
                eprintln!(
                    "daimond-hand: {} of the hand's own messages are unread, so \
                    the page is not listening; the connection was ended.",
                    CTL_QUEUE);
                self.alive.store(false, Ordering::SeqCst);
                false
            },
            Err(TrySendError::Closed(_)) => {
                self.alive.store(false, Ordering::SeqCst);
                false
            },
        }
    }

    /// Answers the opening exchange.
    ///
    /// The `caps` list is the real one, from [`Fence::caps`], so the page can
    /// say which guarantee this machine offers rather than repeating a claim.
    ///
    /// **The granted root travels in `caps` as a `root:` entry.**  The page
    /// cannot know the folder -- the File System Access API gives it a handle
    /// and never a path -- and `wire::Resp::Hello` has no field for it, so this
    /// is where it goes until the wire grows one.
    ///
    /// **The folder's identity travels beside it as a `ws:` entry**, and the two
    /// answer different questions: `root:` says *where* the hand will work, and
    /// `ws:` is what lets the page find out whether that is the folder it is
    /// looking at.  See [`Identity`] for why a path alone settles nothing.
    ///
    /// # Arguments
    /// * `req` - The [`Req::Hello`].
    ///
    /// # Returns
    /// An ending where the conversation cannot continue.
    fn hello(&self, req: &Req) -> Outcome<Option<Ending>> {
        let proto = match req {
            Req::Hello { proto, .. } => *proto,
            _ => return Ok(None),
        };
        // Written down before it is answered.
        if let Some(ev) = Event::from_req(req, &[]) {
            if let Err(e) = self.record(&ev) {
                eprintln!("daimond-hand: the handshake could not be journalled: {}", e);
            }
        }
        if !proto_ok(proto) {
            self.say(Resp::Refused {
                id:     fmt!("hello"),
                reason: proto_refusal(proto),
            });
            return Ok(Some(Ending::Stopped(fmt!(
                "the page speaks protocol {} and this hand speaks {}",
                proto, daimond_hand::PROTO))));
        }
        // Both layers, because the window's wording is chosen from this list and a
        // compartment made of two mechanisms cannot be described by one of them.
        let mut caps = self.fence.caps();
        // A TERMINAL IS PLANNED AGAINST ITS OWN CARVE DECISION, so one `carve:` cap standing for
        // both doors would be a capability that is true of a command and false of a terminal --
        // and a cap the page cannot rely on is worse than one it does not have. See
        // `exec::detected_terminal_fence`.
        for c in daimond_hand::exec::detected_terminal_fence().caps() {
            if let Some(rest) = c.strip_prefix("carve:") {
                caps.push(fmt!("terminal-carve:{}", rest));
            }
        }
        caps.extend(self.sys.caps());
        caps.push(fmt!("root:{}", self.root.display()));
        // The CEILING, not where a terminal opens. Said only where it differs from the
        // granted root, so a page reading no `terminal-root:` gets the behaviour every
        // build before this one had rather than a second name for the same folder.
        // OFFERS and a PIN are different statements and the page acts on them differently. An
        // offer is a folder this machine is willing to fence a terminal to, and the user chooses
        // among them; a pin is a choice the user already made at a shell, and the page follows it
        // rather than offering anything. Only the machine writes either.
        // That a folder BROWSER is available, and where it will start. A page that cannot see
        // this cap falls back to the two-item choice, which is what every build before this one
        // had.
        caps.push(fmt!("browse:dirs"));
        for c in &self.term_ceilings {
            if c != &self.root {
                caps.push(fmt!("terminal-ceiling:{}", c.display()));
            }
        }
        if self.term_pinned {
            if let Some(c) = self.term_ceilings.last() {
                caps.push(fmt!("terminal-root:{}", c.display()));
            }
        }
        caps.push(self.ws.cap());
        // Whether this folder holds verifiers at all. A page that knows the answer can say
        // "not on this computer" once, instead of letting a model find it out one refusal at
        // a time -- which is what `fence:` beside it is for.
        caps.push(verify::cap(&self.root));
        // That this hand can be ASKED what it is still running, and told to stop
        // one of them. A page that cannot see the capability cannot know whether
        // silence means "nothing is running" or "this hand is older than the
        // question", and those are opposite answers.
        caps.push(fmt!("runs:list-and-stop"));
        // Where the user's home is, so the page can place a toolkit.
        //
        // A compiler does not live in the workspace: cargo is under ~/.cargo, node under
        // ~/.nvm. The page cannot know that path -- the File System Access API hands it a
        // handle and never a path -- and guessing `/home/<something>` would be inventing a
        // fence root, which is the one thing it must never do. So the hand says, and a hand
        // that cannot say leaves the toolkit ungranted rather than approximate.
        //
        // It rides in `caps` beside `root:` because `wire.rs` has no field for it and the
        // wire is fixed. Both belong in `Resp::Hello` properly one day.
        //
        // Read through `exec::home_dir`, which is also what a command's defaulted
        // `HOME` comes from. Two answers to "where is home" -- one told to the
        // page and a different one given to the command -- would be a bug nobody
        // would think to look for.
        match daimond_hand::exec::home_dir() {
            Some(h) => caps.push(fmt!("home:{}", h)),
            None    => {},
        }
        // WHICH COMPUTER THIS IS. Rides beside `root:` and `home:` for the same reason and
        // with the same apology about the wire.
        //
        // On 2026-08-20 a daimon was asked to build and deploy, found no `cargo` and no
        // `.git`, and reported that the Rust toolchain was not installed and the repository
        // did not exist. Both were true where it was standing and false where the user was:
        // the browser was open on the author's SECOND machine, whose `~/usr` is a Syncthing
        // copy, and `.stignore` there holds `target` and `.*` -- so the repository and every
        // build artefact are absent by design and always will be.
        //
        // Nothing the daimon could reach could have told it that. The briefing named the
        // operating system and the fence and never the HOST, so "this machine" meant a
        // machine it could not name, and the user -- reading it beside a terminal on the
        // other box -- read it as a claim about the one in front of him. He spent a round
        // telling it that cargo was at a path where, on that computer, it genuinely was not.
        //
        // A name costs nine bytes and turns "the toolchain is not installed" into "the
        // toolchain is not installed on gilgamesh", which is a sentence somebody can act on.
        match hostname() {
            Some(h) => caps.push(fmt!("host:{}", h)),
            None    => {},
        }
        // WHICH SHELL THE USER USES, so a terminal opens on the one they know.
        //
        // The page cannot read an environment; it defaulted to `/bin/sh`, which is the one
        // program POSIX promises is there and on this machine is `dash` -- no prompt worth
        // the name, no history, no completion, and none of the user's own aliases. Rides in
        // `caps` beside `home:` and `host:`, with the same apology about the wire.
        //
        // From `SHELL`, which is what the login session set and therefore what every other
        // terminal on this machine opens. Absent or relative, nothing is said and the page
        // keeps its own default -- a guessed shell is a terminal that opens on a refusal.
        match std::env::var("SHELL") {
            Ok(sh) if sh.starts_with('/') && !sh.contains('\0') => caps.push(fmt!("shell:{}", sh)),
            _ => {},
        }
        // WHETHER DAIMOND'S OWN SSH IS SET UP HERE, which is the whole of the Remote
        // toolchain's permission.
        //
        // It used to be a grant the user gave a Diamond, one Diamond at a time, and the owner's
        // objection to that is the entry `dev/BLOCKERS.md` calls B12: a terminal is not tied to
        // a Diamond, so neither is what a terminal may reach. The posture is the USER'S and it
        // is per COMPUTER -- `install.sh --remote` on this machine, or nothing.
        //
        // Saying it here rather than storing it in the app means there is no fourth place a
        // permission lives: the answer is read from the key and the wrapper themselves, so it
        // cannot drift from them, cannot be left on after the key is deleted, and cannot be
        // turned on by anything but the user running the installer. See
        // `exec::remote_ready`, and `Machine::remote` at the other end.
        if daimond_hand::exec::remote_ready() {
            caps.push(fmt!("remote:ready"));
        }
        if !self.say(Resp::Hello {
            proto:   daimond_hand::PROTO,
            host:    fmt!("{}", daimond_hand::HOST_NAME),
            version: fmt!("{}", daimond_hand::version()),
            os:      fmt!("{}", self.os),
            caps,
        }) {
            return Ok(Some(Ending::Stopped(fmt!("the page stopped listening"))));
        }
        Ok(None)
    }

    /// Refuses a command, in a whole sentence.
    ///
    /// The refusal is journalled by the writer on its way out, so a refusal the
    /// page saw is a refusal the record holds.
    ///
    /// # Arguments
    /// * `id` - The run.
    /// * `reason` - The whole sentence.
    fn refuse(&self, id: &str, reason: String) {
        self.say(Resp::Refused { id: fmt!("{}", id), reason });
    }

    /// Which mechanisms this machine brings to a command.
    ///
    /// Residual, and worth naming: this is what the machine can enforce and
    /// what the plan asked for, not proof that the kernel bound *this* child.
    /// That proof arrives with the launcher of `README.md` gate 4, and this
    /// list should be replaced by what it reports.
    ///
    /// # Arguments
    /// * `plan` - The plan the fence made.
    fn mechs(&self, plan: &Plan) -> Vec<String> {
        let mut v = self.fence.caps();
        v.extend(self.sys.caps());
        v.push(match plan.net {
            true	=> fmt!("net:open"),
            false	=> fmt!("net:none"),
        });
        v
    }

    /// Starts a command, or says why not.
    ///
    /// The order is the whole point, and it is: the record must be writable,
    /// the journal must be out of the command's reach, the fence must be in
    /// force, the command must be written down, and only then does anything
    /// run.
    ///
    /// # Arguments
    /// * `req` - The [`Req::Exec`].
    async fn exec(&self, req: Req) -> Outcome<()> {
        // A terminal is gated exactly as a command is -- the journal, the fence guard, release
        // gate 1 -- because it IS a command, differing only in how the conversation is shaped.
        // Written once so the two cannot drift: a second copy of this would eventually be the
        // copy that forgot to check something.
        let (id, mut spec, kits, argv, cwd, door) = match &req {
            Req::Exec { id, fence, toolkits, argv, cwd, .. } =>
                (id.clone(), fence.clone(), toolkits.clone(), argv.clone(), cwd.clone(),
                    Door::Command),
            Req::Open { id, fence, toolkits, argv, cwd, .. } =>
                (id.clone(), fence.clone(), toolkits.clone(), argv.clone(), cwd.clone(),
                    Door::Terminal),
            // A file op has no `argv`, and that is the whole of what it is for. An empty one is
            // handed to the gates below on purpose rather than a synthetic line: `git_hooks_
            // refusal` and `vet_roots` both read it, and a made-up command line is a thing
            // written to be read as real.
            Req::File { id, fence, toolkits, cwd, .. } =>
                (id.clone(), fence.clone(), toolkits.clone(), Vec::new(), cwd.clone(),
                    Door::File),
            _ => return Ok(()),
        };

        // A command whose record cannot be written is a command that does not run.
        if !self.sound.load(Ordering::SeqCst) {
            self.refuse(&id, fmt!(
                "Refused: the hand's journal cannot be written, and a command \
                that cannot be written down is not run. Every run is recorded \
                so that it can be checked afterwards, and a run with no record \
                would break that promise silently. Look at the hand's standard \
                error for what the file system said."));
            return Ok(());
        }

        // A fence naming somewhere this hand was never granted is not this hand's
        // fence. `REVIEW.md` §1.5: the spec is computed in the page, the page is
        // not the app, and the hand was honouring whatever arrived -- `rw:["/etc"]`
        // with `cwd:"/etc"` ran and returned a listing of /etc/ssh. Checked before
        // the journal test, because "you may not fence a command around /etc" is a
        // better sentence than "your fence reaches my journal", and before anything
        // is written down, because a refused command is still recorded as refused.
        // A TERMINAL IS VETTED AGAINST ITS CEILING, where the installer named one. The
        // ceiling lives on the machine and is written by `install.sh`, so this is still
        // the hand checking an arriving fence against a grant the page could not have
        // chosen -- which is the whole property `vet_roots` exists to keep. A command
        // and a file operation are vetted against the granted root exactly as before.
        // The WIDEST folder this machine offered. The page composes the fence and may make it
        // narrower -- that is what the user's choice in the UI does -- but it cannot reach past
        // what the machine put on the list.
        let widest = self.term_ceilings.last().map(|p| p.as_path());
        let against = daimond_hand::exec::vet_against(&self.root, widest, door);
        if let Some(s) = daimond_hand::exec::vet_roots(against, &spec, &kits, door) {
            self.refuse(&id, s);
            return Ok(());
        }

        // A toolchain folder this machine does not have is dropped rather than
        // refused. The app expands one ticked toolkit into several paths, and a
        // machine that keeps git's configuration in `~/.gitconfig` alone has no
        // `~/.config/git` -- so before this line, ticking Git refused EVERY
        // command the Diamond ran, naming a path the user had never heard of.
        // Only a toolkit's own paths are eligible: a workspace root that cannot
        // be resolved still refuses, because that one is a fence that would
        // silently not cover what the user marked.
        // Not said to the page: a path that is not there grants nothing, and a
        // note on every command naming a folder the user never asked for is
        // noise. The list comes back so that a caller who wants it has it.
        let _dropped = daimond_hand::exec::drop_absent_kit_roots(&mut spec, &kits);

        // The directory git runs `pre-commit` from, which on this machine holds the
        // credential scanner. Read here rather than in the page, because the page cannot
        // see `core.hooksPath` and the model must not be the one who chooses it. Read-only,
        // which carries execute, which is what a hook needs. Nothing is added where the user
        // granted no Git toolchain: without it the fenced git cannot read the configuration
        // that names the directory either, so the grant would buy nothing -- and the
        // refusal below is what covers that case instead.
        let _hooks = daimond_hand::exec::grant_git_hooks(&mut spec, &kits, &[]);

        // The user's own shell configuration, lent to a TERMINAL and to nothing else.
        // Read here rather than in the page for the reason the hooks directory is: the page
        // cannot see which of the three files this machine has, and `fence::canonical`
        // refuses a root it cannot resolve -- so a page naming `~/.inputrc` on a machine
        // without one would refuse the whole terminal. `grant_user_dotfiles` adds nothing at
        // the other two doors, which are the two a daimon reaches.
        let _dots = daimond_hand::exec::grant_user_dotfiles(&mut spec, door);

        // A fence that reaches the journal is a fence over the record of what
        // the fence was used for.  And denied outright as well, in case a root
        // is widened later or reached through a link.
        let guarded = {
            let g = lock_mutex!(self.jr);
            if let Err(e) = g.check_fence(&spec) {
                self.refuse(&id, e.msgs().join(" "));
                return Ok(());
            }
            g.fence_guard(&spec)
        };

        // Release gate 1: the fence is in force, or the command is refused.
        // Never run it and mention it afterwards.
        let plan = match self.fence.plan(&guarded, &Unfenced::Refuse) {
            Ok(p)  => p,
            Err(e) => {
                self.refuse(&id, e.msgs().join(" "));
                return Ok(());
            },
        };
        if !plan.is_fenced() {
            self.refuse(&id, self.fence.refusal("This command"));
            return Ok(());
        }

        // Release gate 1's companion: a commit runs the user's hooks or it does not run.
        // Asked of the PLAN and not of the spec, because the plan is what the kernel will
        // enforce -- and asked after it, because a command refused for its fence should say
        // so about the fence. See `exec::git_hooks_refusal` for what each sentence means and
        // for the one spelling this cannot see.
        if let Some(s) = daimond_hand::exec::git_hooks_refusal(&plan, &argv, &cwd, &[]) {
            self.refuse(&id, s);
            return Ok(());
        }

        // Written down before it runs, so the record cannot be missing a
        // command that started.
        let req = with_fence(req, guarded);
        let mechs = self.mechs(&plan);
        match Event::from_req(&req, &mechs) {
            Some(ev) => {
                if let Err(e) = self.record(&ev) {
                    eprintln!("daimond-hand: a command was not journalled: {}", e);
                    self.refuse(&id, fmt!(
                        "Refused: this command could not be written to the \
                        hand's journal, so it was not run. A command with no \
                        record cannot be checked afterwards, and running it \
                        anyway would make the journal a record of only the \
                        commands that happened to be recordable."));
                    return Ok(());
                }
            },
            None => (),
        }

        // Handed to a task of its own. The dispatcher must not wait on the
        // response channel: `REVIEW.md` §3.7 is exactly the loop that does.
        let runner = self.runner.clone();
        let ptys   = self.ptys.clone();
        let bulk   = self.bulk.clone();
        let ctl    = self.ctl.clone();
        let files  = self.files.clone();
        tokio::spawn(async move {
            let out = match door {
                Door::Terminal	=> ptys.open(req, bulk).await.map(|_| ()),
                Door::Command	=> runner.spawn(req, bulk).await.map(|_| ()),
                Door::File	=> files.apply(req, bulk).await,
            };
            if let Err(e) = out {
                let _ = ctl.send(Resp::Error {
                    id:      Some(id),
                    message: fmt!("{}", e),
                }).await;
            }
        });
        Ok(())
    }

    /// Runs a named verifier, clean and under each break it declares.
    ///
    /// The gates are the same three a command meets, in the same order and for
    /// the same reasons -- the record must be writable, the request must be
    /// written down, and only then does anything run -- and then two of its own:
    ///
    /// * **The name has to resolve to a file that is really there.**
    ///   [`verify::resolve`] reads the directory and matches; what goes on to
    ///   the command line is the directory entry, not the caller's string.
    /// * **The break has to be one the verifier declares**, parsed out of that
    ///   file's own source by [`verify::declared_breaks`].
    ///
    /// The fence is NOT one of them, and that is the deliberate difference from
    /// [`Desk::exec`].  A fenced command cannot reach the display server's
    /// socket or listen on a port, so a verifier that drives a browser cannot
    /// run under one at all -- and the whole reason this verb exists is that
    /// browser evidence was the half of a release a daimon could not produce.
    /// What is fenced here is the INPUT: a name looked up in a directory and a
    /// break looked up in a file, with no route from a model's text to a
    /// program, an argument or a path.
    ///
    /// # Arguments
    /// * `req` - The [`Req::Verify`].
    async fn verify(&self, req: Req) -> Outcome<()> {
        let (id, name, want, budget_ms) = match &req {
            Req::Verify { id, name, breaks, timeout_ms } =>
                (id.clone(), name.clone(), breaks.clone(), *timeout_ms),
            _ => return Ok(()),
        };

        // A run whose record cannot be written is a run that does not happen. The same
        // sentence as `exec`'s, because it is the same promise.
        if !self.sound.load(Ordering::SeqCst) {
            self.refuse(&id, fmt!(
                "Refused: the hand's journal cannot be written, and a run that cannot be \
                written down is not made. Look at the hand's standard error for what the file \
                system said."));
            return Ok(());
        }

        let script = match verify::resolve(&self.root, &name) {
            Ok(s)  => s,
            Err(s) => { self.refuse(&id, s); return Ok(()); },
        };
        let breaks = match verify::chosen(&script, &want) {
            Ok(b)  => b,
            Err(s) => { self.refuse(&id, s); return Ok(()); },
        };
        let node = match verify::on_path("node") {
            Some(n) => n,
            None    => {
                self.refuse(&id, fmt!(
                    "Refused: there is no 'node' on this hand's PATH, and every verifier in \
                    dev/ is a Node script. Nothing was run. Tell the user; the file tools and \
                    'run' do not need it."));
                return Ok(());
            },
        };

        // A budget of nothing is a budget the caller forgot rather than one they meant.
        let budget = match budget_ms {
            0	=> verify::BUDGET_DEFAULT_MS,
            n	=> n.min(verify::BUDGET_MAX_MS),
        };

        let job = verify::Job {
            id:     id.clone(),
            root:   self.root.clone(),
            script,
            breaks,
            node,
            budget: Duration::from_millis(budget),
            ledger: verify::Ledger::new(Arc::clone(&self.jr), Arc::clone(&self.sound)),
        };

        // A task of its own, as a command is: the dispatcher must stay able to answer while a
        // sequence of browser verifiers runs for twenty minutes.
        let bulk = self.bulk.clone();
        let ctl  = self.ctl.clone();
        tokio::spawn(async move {
            if let Err(e) = verify::conduct(job, bulk).await {
                let _ = ctl.send(Resp::Error {
                    id:      Some(id),
                    message: fmt!("{}", e),
                }).await;
            }
        });
        Ok(())
    }

    /// Passes a signal to a run.
    ///
    /// The record is written first, as everywhere else, but a failure to write
    /// it does **not** stop the signal.  Refusing to start a command that
    /// cannot be recorded is a safe failure; refusing to stop one is not, and
    /// would leave a process running that somebody asked to have killed.
    ///
    /// # Arguments
    /// * `req` - The [`Req::Signal`].
    async fn signal(&self, req: &Req) -> Outcome<()> {
        let (id, sig) = match req {
            Req::Signal { id, sig } => (id.clone(), *sig),
            _ => return Ok(()),
        };
        if let Some(ev) = Event::from_req(req, &[]) {
            if let Err(e) = self.record(&ev) {
                eprintln!("daimond-hand: a signal was not journalled: {}", e);
            }
        }
        // Handed to a task of its own, like an exec and for the same reason:
        // `REVIEW.md` §3.7 is the loop that stopped reading while it waited.
        // Signalling a LIVE run is instant -- one send down a channel the
        // supervisor owns -- but signalling the group a finished run left
        // standing starts a `kill` and then waits to see whether the group
        // emptied, and the dispatcher must not be the thing waiting.
        let runner = self.runner.clone();
        let ctl    = self.ctl.clone();
        tokio::spawn(async move {
            let told = match runner.signal(&id, sig).await {
                Ok(Signalled::Sent) | Ok(Signalled::Finished) => return,
                // The half that was missing. A signal that did not take used to
                // be indistinguishable from one that had nothing left to reach,
                // so a page was told its command had stopped when it had not.
                Ok(Signalled::Failed(why)) => why,
                Err(e) => fmt!("{}", e),
            };
            let _ = ctl.send(Resp::Error { id: Some(id), message: told }).await;
        });
        Ok(())
    }

    /// Answers what this hand is still running.
    ///
    /// Not journalled: a question is not an act, and every run it can name was
    /// written down when it started.  See `Event::from_req`.
    /// Write the folder this hand may work in, as the installer writes it.
    ///
    /// **This does not make the grant; it records the one the user made.** They walked the
    /// machine's own folders through [`Self::dirs`], which is bounded, and chose one. What is
    /// replaced is a step that otherwise happens at a shell before a person knows what the app
    /// does with a folder -- and, on discovering they chose wrongly, by editing `root.txt` by
    /// hand.
    ///
    /// **Three refusals, and each is a fence rule rather than a preference.** `/` is the
    /// machine and not a workspace. A path that is not a directory cannot bound anything. And
    /// a folder CONTAINING this hand's journal would let a fenced command rewrite the record of
    /// itself, which is the rule [`journal::check_fence_at`] applies on every command -- caught
    /// here, where the sentence can name the fix, rather than on every later run.
    ///
    /// **It takes effect when the hand next starts**, and the answer says so. A running hand
    /// reads its root once; re-reading it here would move the fence under commands already
    /// running.
    async fn grant(&self, path: &str) -> Outcome<()> {
        let say = |m: String| async move { let _ = self.ctl.send(Resp::Error { id: None, message: m }).await; };
        let asked = PathBuf::from(path);
        if !asked.is_absolute() {
            say(fmt!("'{}' is not an absolute path, and a fence written against a relative one \
                fences whatever the hand happens to be standing in.", path)).await;
            return Ok(());
        }
        let here = match std::fs::canonicalize(&asked) {
            Ok(p) if p.is_dir() => p,
            _ => {
                say(fmt!("'{}' is not a folder on this computer, so there is nothing for it to \
                    bound.", path)).await;
                return Ok(());
            },
        };
        if here == Path::new("/") {
            say(fmt!("'/' is the machine, not a workspace. Everything any command could reach \
                would be everything there is.")).await;
            return Ok(());
        }
        let jdir = {
            let g = lock_mutex!(self.jr);
            g.dir().to_path_buf()
        };
        if journal::check_fence_at(&jdir, &daimond_hand::wire::FenceSpec {
            rw: vec![fmt!("{}", here.display())], ro: Vec::new(), deny: Vec::new(), net: false,
        }).is_err() {
            say(fmt!(
                "'{}' contains this hand's own record, at '{}', so a command fenced to it could \
                rewrite the record of what it did. Move the record outside the folder first: set \
                DAIMOND_HAND_JOURNAL_DIR to somewhere the folder does not contain.",
                here.display(), jdir.display())).await;
            return Ok(());
        }
        let file = jdir.join(daimond_hand::ROOT_FILE);
        let txt  = fmt!("# The one folder Daimond's machine hand may work in.\n{}\n", here.display());
        if let Err(e) = std::fs::write(&file, txt) {
            say(fmt!("'{}' could not be written ({}), so the folder was not changed.",
                file.display(), e)).await;
            return Ok(());
        }
        let _ = std::fs::set_permissions(&file, std::os::unix::fs::PermissionsExt::from_mode(0o600));
        // Written down: it changes what every LATER command may touch, and a record without it
        // leaves a reader unable to say which fence an earlier line was written under.
        if let Some(ev) = Event::from_req(&Req::Grant { path: fmt!("{}", here.display()) }, &[]) {
            if let Err(e) = self.record(&ev) {
                eprintln!("daimond-hand: the grant was not journalled: {}", e);
            }
        }
        let _ = self.ctl.send(Resp::Granted {
            path: fmt!("{}", here.display()),
            note: fmt!("The folder is written down. This hand is still working in '{}' until it \
                is restarted, which happens when the page is reloaded.", self.root.display()),
        }).await;
        Ok(())
    }

    /// The directories inside `path`, so a person can choose a folder and get its real path.
    ///
    /// **Bounded by what this hand would fence a terminal to**, which is the granted root and
    /// the account it runs as. Anywhere else is refused, so this is a folder chooser and not a
    /// way to enumerate the machine. Names of DIRECTORIES only: no files, no contents, no
    /// sizes, and dotted directories last rather than hidden, because a person looking for
    /// `.config` should be able to find it.
    ///
    /// An empty `path` asks where to start, and the answer is the same bound.
    async fn dirs(&self, path: &str) -> Outcome<()> {
        let roots: Vec<PathBuf> = self.term_ceilings.clone();
        if path.trim().is_empty() {
            let said = Resp::Dirs {
                path:  fmt!(""),
                up:    fmt!(""),
                dirs:  Vec::new(),
                roots: roots.iter().map(|p| fmt!("{}", p.display())).collect(),
            };
            let _ = self.ctl.send(said).await;
            return Ok(());
        }
        let asked = PathBuf::from(path);
        let here = match std::fs::canonicalize(&asked) {
            Ok(p) if p.is_dir() => p,
            _ => {
                let _ = self.ctl.send(Resp::Error {
                    id:      None,
                    message: fmt!("'{}' is not a folder on this computer.", path),
                }).await;
                return Ok(());
            },
        };
        // The bound, checked on the CANONICAL path: a symlink out of the grant is the whole
        // reason this is not a string comparison on what arrived.
        if !roots.iter().any(|r| here.starts_with(r)) {
            let _ = self.ctl.send(Resp::Error {
                id:      None,
                message: fmt!(
                    "'{}' is outside the folders this computer will offer a terminal, so it is \
                    not browsable from here. Those are: {}.",
                    here.display(),
                    roots.iter().map(|p| fmt!("'{}'", p.display()))
                        .collect::<Vec<_>>().join(", ")),
            }).await;
            return Ok(());
        }
        let mut dirs: Vec<String> = Vec::new();
        if let Ok(rd) = std::fs::read_dir(&here) {
            for e in rd.flatten() {
                // `file_type` rather than `metadata`: a symlink to a directory is followed by
                // the latter, and a listing that walked into one would leave the bound by
                // showing a name that is somewhere else entirely.
                match e.file_type() {
                    Ok(t) if t.is_dir() => {},
                    _ => continue,
                }
                if let Some(n) = e.file_name().to_str() {
                    dirs.push(fmt!("{}", n));
                }
            }
        }
        dirs.sort_by(|a, b| {
            let da = a.starts_with('.');
            let db = b.starts_with('.');
            da.cmp(&db).then_with(|| a.to_lowercase().cmp(&b.to_lowercase()))
        });
        // Up, but never past the bound: the parent of a root is not this hand's to show.
        let up = here.parent()
            .filter(|p| roots.iter().any(|r| p.starts_with(r)))
            .map(|p| fmt!("{}", p.display()))
            .unwrap_or_default();
        let said = Resp::Dirs {
            path: fmt!("{}", here.display()),
            up,
            dirs,
            roots: roots.iter().map(|p| fmt!("{}", p.display())).collect(),
        };
        let _ = self.ctl.send(said).await;
        Ok(())
    }

    async fn runs(&self) -> Outcome<()> {
        // Also off the loop. The listing walks `/proc` once per standing group,
        // which is quick and is still not the dispatcher's work to do.
        let runner = self.runner.clone();
        let ctl    = self.ctl.clone();
        tokio::spawn(async move {
            let said = match runner.runs().await {
                Ok((runs, more)) => Resp::Runs { runs, more },
                Err(e) => Resp::Error {
                    id:      None,
                    message: fmt!(
                        "The hand could not say what it is still running. {}", e.msgs().join(" ")),
                },
            };
            let _ = ctl.send(said).await;
        });
        Ok(())
    }

    /// Takes messages until the conversation ends.
    ///
    /// # Arguments
    /// * `rx` - Where the reader puts what it read.
    async fn run(&self, rx: &mut Receiver<Inbound>) -> Outcome<Ending> {
        loop {
            if !self.alive.load(Ordering::SeqCst) {
                return Ok(Ending::Stopped(fmt!("the page stopped listening")));
            }
            let inb = match rx.recv().await {
                Some(i) => i,
                None    => return Ok(Ending::Closed),
            };
            match inb {
                Inbound::Msg(req) => match req {
                    Req::Hello { .. } => {
                        if let Some(end) = res!(self.hello(&req)) {
                            return Ok(end);
                        }
                    },
                    Req::Exec { .. } => res!(self.exec(req).await),
                    Req::Open { .. } => res!(self.exec(req).await),
                    // The same gates, the same order, the same function. A file op is a write
                    // to this machine and is journalled, fence-guarded and gate-1 refused
                    // exactly as a command is; only what happens at the far end differs.
                    Req::File { .. } => res!(self.exec(req).await),
                    // Keystrokes and resizes are answered synchronously and are never
                    // journalled -- see `Event::from_req`, which refuses to write down the
                    // message a password is typed into.
                    Req::Input { ref id, ref data } => {
                        if let Err(e) = self.ptys.input(id, data) {
                            eprintln!("daimond-hand: input was not delivered: {}", e);
                        }
                    },
                    Req::Resize { ref id, size } => {
                        if let Err(e) = self.ptys.resize(id, size) {
                            eprintln!("daimond-hand: resize was not delivered: {}", e);
                        }
                    },
                    Req::Verify { .. } => res!(self.verify(req).await),
                    Req::Signal { .. } => res!(self.signal(&req).await),
                    Req::Runs => res!(self.runs().await),
                    Req::Dirs { path } => res!(self.dirs(&path).await),
                    Req::Grant { path } => res!(self.grant(&path).await),
                    Req::Bye => {
                        // Written down before anything is stopped.
                        if let Some(ev) = Event::from_req(&req, &[]) {
                            if let Err(e) = self.record(&ev) {
                                eprintln!(
                                    "daimond-hand: the goodbye was not journalled: {}", e);
                            }
                        }
                        return Ok(Ending::Goodbye);
                    },
                },
                Inbound::Bad { fault, detail } => {
                    // The framing is still in step, so the next request is
                    // still worth serving; the page is told what was wrong.
                    let what = match fault {
                        Some(f)	=> fmt!("{}: {}", f.name(), detail),
                        None	=> detail,
                    };
                    if !self.say(Resp::Error { id: None, message: what }) {
                        return Ok(Ending::Stopped(fmt!("the page stopped listening")));
                    }
                },
                Inbound::Gone { clean, reason } => {
                    return Ok(match clean {
                        true	=> Ending::Closed,
                        false	=> Ending::Stopped(reason),
                    });
                },
            }
        }
    }
}

/// The same request with a hardened fence in place of the one that arrived.
///
/// **Both kinds of request, and that is the whole of the care here.**  This used to rewrite a
/// `Req::Exec` and let a `Req::Open` fall through the `other => other` arm unchanged, so a
/// terminal ran under the fence that ARRIVED while a command ran under the one the journal guard
/// had hardened -- the journal's own directory denied to one and not to the other.  Two paragraphs
/// above, [`Desk::exec`] says a terminal is gated exactly as a command is, "written once so the
/// two cannot drift"; the drift was inside the function that sentence is about.
///
/// The variants that fall through genuinely have no fence: a signal, a keystroke, a resize, a
/// goodbye.
///
/// # Arguments
/// * `req` - The request.
/// * `spec` - The fence to carry instead.
fn with_fence(req: Req, spec: daimond_hand::wire::FenceSpec) -> Req {
    match req {
        Req::Exec { id, argv, cwd, env, stdin, timeout_ms, capture, toolkits, .. } => Req::Exec {
            id,
            argv,
            cwd,
            env,
            stdin,
            timeout_ms,
            capture,
            fence: spec,
            toolkits,
        },
        Req::Open { id, argv, cwd, env, size, toolkits, .. } => Req::Open {
            id,
            argv,
            cwd,
            env,
            size,
            fence: spec,
            toolkits,
        },
        // The third door, and it is here for the reason the paragraph above records: this
        // function once knew about `Exec` alone, and a `Req::Open` fell through `other => other`
        // carrying the fence that ARRIVED rather than the one the journal guard hardened. A file
        // op writes to disc; leaving it out would be the same defect in the same place.
        Req::File { id, op, cwd, toolkits, .. } => Req::File {
            id,
            op,
            cwd,
            fence: spec,
            toolkits,
        },
        other => other,
    }
}

// ┌───────────────────────────────────────────────────────────────┐
// │ Serving                                                        │
// └───────────────────────────────────────────────────────────────┘

/// Serves one conversation, from the first frame to the last.
///
/// Generic over both streams so that a test can drive the whole loop over
/// memory rather than over a browser, and so that the Cloud tier can hand it a
/// socket without this file learning what a socket is.
///
/// # Arguments
/// * `input` - Where frames come from.  Owned by a thread of its own.
/// * `output` - Where frames go.
/// * `cfg` - The journal, the fence and the granted root.
///
/// # Returns
/// How the conversation finished, or an error where it could not be started at
/// all -- which, for the journal, is the point: no record, no service.
async fn serve<R, W>(input: R, output: W, cfg: Serve) -> Outcome<Ending>
where
    R: Read + Send + 'static,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let os = res!(daimond_hand::checked_os());

    // A kernel with no fence refuses every command one at a time, journalled
    // and answered -- which is right, and is also a page that fails command
    // after command for a reason nothing has stated. Said once, here.
    if let Fence::None { why } = &cfg.fence {
        eprintln!(
            "daimond-hand: this kernel offers no fence, so every command will be \
            refused rather than run unconfined: {}", why);
    }

    // No journal, no service. This is the gate `README.md` states and
    // `REVIEW.md` §2.8 found nowhere in code.
    let jr = res!(Journal::open(cfg.journal.clone()));
    let dir = jr.dir().to_path_buf();

    // A grant that contains the record would be refused on every command; say
    // so once, now, where a person can read it.
    if journal::check_fence_at(&dir, &daimond_hand::wire::FenceSpec {
        rw:   vec![fmt!("{}", cfg.root.display())],
        ro:   Vec::new(),
        deny: Vec::new(),
        net:  true,
    }).is_err() {
        eprintln!(
            "daimond-hand: the granted folder '{}' contains the journal at \
            '{}', so every command will be refused. Set \
            DAIMOND_HAND_JOURNAL_DIR to a directory outside the grant.",
            cfg.root.display(), dir.display());
    }

    let jr    = Arc::new(Mutex::new(jr));
    let sound = Arc::new(AtomicBool::new(true));
    let alive = Arc::new(AtomicBool::new(true));

    let (req_tx, mut req_rx) = channel::<Inbound>(REQ_QUEUE);
    let (ctl_tx,     ctl_rx) = channel::<Resp>(CTL_QUEUE);
    let (bulk_tx,   bulk_rx) = channel::<Resp>(BULK_QUEUE);

    // A thread, not a task: it blocks on a pipe, and a task that blocks is a
    // worker that is not working.
    let reader = res!(std::thread::Builder::new()
        .name(fmt!("hand-reader"))
        .spawn(move || read_frames(input, req_tx))
        .map_err(|e| err!(e, "The hand could not start its reader thread."; IO, Init)));

    let writer = tokio::spawn(write_loop(
        output,
        ctl_rx,
        bulk_rx,
        Arc::clone(&jr),
        Arc::clone(&sound),
        Arc::clone(&alive),
    ));

    // Established once, before a page is served: the root cannot change while
    // the process lives, so neither can the answer.
    let ws = workspace_id(&cfg.root);
    if let Identity::Unproven(why) = &ws {
        eprintln!(
            "daimond-hand: the granted folder '{}' could not be given an \
            identity, so the page cannot check that it is the folder you opened \
            in the browser: {}. Commands may be refused until it can.",
            cfg.root.display(), why);
    }

    let desk = Desk {
        fence:  cfg.fence.clone(),
        sys:    Seccomp::detect(),
        root:   cfg.root.clone(),
        term_ceilings: cfg.term_ceilings.clone(),
        term_pinned: cfg.term_pinned,
        ws,
        os,
        runner: Runner::with_launcher(cfg.launcher.clone()),
        ptys:   daimond_hand::pty::PtySessions::with_launcher(cfg.launcher.clone()),
        files:  daimond_hand::exec::Files::with_launcher(cfg.launcher.clone()),
        jr:     Arc::clone(&jr),
        sound:  Arc::clone(&sound),
        alive:  Arc::clone(&alive),
        ctl:    ctl_tx.clone(),
        bulk:   bulk_tx.clone(),
    };

    // A failure in the loop itself -- a poisoned lock, an event with no
    // canonical form -- ends the conversation rather than escaping it, so that
    // the shutdown below still runs and nothing is left behind.
    let ending = match desk.run(&mut req_rx).await {
        Ok(e)  => e,
        Err(e) => Ending::Stopped(fmt!("the loop stopped: {}", e.msgs().join("; "))),
    };

    // Nothing outlives the conversation -- and a terminal is a thing that outlives it, which is
    // why there are two lines here and not one. A run is stopped; a SESSION was left to be cleaned
    // up as a side effect of the master file descriptor closing when this process exited, which
    // reaches a shell that dies on SIGHUP and misses one that ignores it or has re-parented. It
    // also meant the hand waited for the program inside the terminal before it could exit at all:
    // measured at five minutes for a `sleep 300` the page had already walked away from.
    //
    // `PtySessions::close_all` sweeps every process group in each session, not merely the leader's
    // -- a terminal is what makes job control work, so `sleep 60 &` is in a group of its own (see
    // `pty::sweep`).
    if let Err(e) = desk.runner.stop_all().await {
        eprintln!("daimond-hand: not every run could be stopped: {}", e);
    }
    match desk.ptys.close_all() {
        Ok(0)  => (),
        Ok(n)  => eprintln!("daimond-hand: closed {} terminal session(s) on the way out.", n),
        Err(e) => eprintln!("daimond-hand: not every terminal could be closed: {}", e),
    }
    if ending != Ending::Goodbye {
        let ev = Event::Closed { reason: ending.why() };
        if let Err(e) = desk.record(&ev) {
            eprintln!("daimond-hand: the closing line was not journalled: {}", e);
        }
    }

    // Let the writer finish what is already queued, then stop waiting for it:
    // a page that has gone away will never drain, and the hand must still exit.
    drop(desk);
    drop(ctl_tx);
    drop(bulk_tx);
    match tokio::time::timeout(Duration::from_millis(DRAIN_MS), writer).await {
        Ok(Ok(Ok(())))	=> (),
        Ok(Ok(Err(e)))	=> eprintln!("daimond-hand: the writer stopped: {}", e),
        Ok(Err(e))		=> eprintln!("daimond-hand: the writer failed: {}", e),
        Err(_)			=> eprintln!(
            "daimond-hand: the page did not read the last of the output within \
            {} ms, so the hand stopped waiting for it.", DRAIN_MS),
    }
    // The reader is blocked on a pipe nobody will write to again; the request
    // channel is closed, so it ends the moment the pipe does.
    drop(req_rx);
    drop(reader);

    Ok(ending)
}

// ┌───────────────────────────────────────────────────────────────┐
// │ Saying why, when the journal cannot                            │
// └───────────────────────────────────────────────────────────────┘
//
// The hand says everything in the journal, and the failure this section exists
// for is the failure to open the journal.  A hand that reported it only there
// would be mute exactly when it had most to say -- which is what happened: a
// snap Chromium started the hand, the hand could not open a journal behind a
// hidden directory, and it exited with Chrome reporting nothing but "Native
// host has exited".  Diagnosis took an hour.
//
// Standard error is the one channel that survives, because Chrome copies a
// native messaging host's standard error into its own log.  So every refusal on
// the startup path goes through [`refuse`], in words, before the process ends.

/// Written and removed to find out whether the journal directory can be written.
const PROBE_FILE: &str = ".daimond-hand-write-probe";

/// Whether the hand can get at the directory the record lives in.
enum Reach {
    /// It can be read and written, or it is merely absent and can be made.
    Ok,
    /// It, or the nearest ancestor that exists, would not open.
    Closed {
        /// The path that would not open.
        at:  PathBuf,
        /// What the operating system said.
        why: String,
    },
    /// It is there and cannot be written.
    Frozen {
        /// The directory.
        at:  PathBuf,
        /// What the operating system said.
        why: String,
    },
}

/// Asks whether the journal directory can be reached, without opening a journal.
///
/// Walks up until something exists, because an absent directory is not a fault
/// -- the journal makes its own -- and a directory whose *parent* cannot be
/// opened is.
///
/// # Arguments
/// * `dir` - Where the record is to live.
fn reach(dir: &Path) -> Reach {
    let mut at = Some(dir);
    while let Some(cur) = at {
        match fs::read_dir(cur) {
            Ok(_)                                                 => return writable(cur),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound	=> at = cur.parent(),
            Err(e) => return Reach::Closed {
                at:  cur.to_path_buf(),
                why: fmt!("{}", e),
            },
        }
    }
    Reach::Ok
}

/// Whether a directory can be written, found out by writing in it and tidying up.
///
/// Only ever called after something has already failed, so the probe file costs
/// nothing on the path that works.
///
/// # Arguments
/// * `dir` - The directory.
fn writable(dir: &Path) -> Reach {
    let p = dir.join(PROBE_FILE);
    match fs::OpenOptions::new().create(true).write(true).truncate(true).open(&p) {
        Ok(_) => {
            let _ = fs::remove_file(&p);
            Reach::Ok
        },
        Err(e) => Reach::Frozen {
            at:  dir.to_path_buf(),
            why: fmt!("{}", e),
        },
    }
}

/// The first hidden component of a path inside `$HOME`, where there is one.
///
/// This is the whole difference between a path a confined browser's child can
/// open and one it cannot: snap's `home` interface and flatpak's `--filesystem`
/// grant the non-hidden files in a home directory and nothing else.
///
/// # Arguments
/// * `p` - The path.
fn hidden_in_home(p: &Path) -> Option<String> {
    let home = match std::env::var("HOME") {
        Ok(h) if !h.is_empty()	=> PathBuf::from(h),
        _						=> return None,
    };
    hidden_under(p, &home)
}

/// The first hidden component of `p` below `home`, where there is one.
///
/// Separate from [`hidden_in_home`] so a test can ask the question without
/// setting `HOME` out from under every other test in the binary.
///
/// # Arguments
/// * `p`    - The path.
/// * `home` - The home directory it may be under.
/// This computer's name, or `None` where it will not say.
///
/// `/etc/hostname` first because it is a file the fence can be given and `gethostname` is a
/// syscall the seccomp filter would have to allow; `HOSTNAME` after it, which a shell exports
/// and a bare service does not. An empty or absurd answer is treated as no answer -- a briefing
/// that names the machine wrongly is worse than one that does not name it.
fn hostname() -> Option<String> {
    let from_file = std::fs::read_to_string("/etc/hostname").ok()
        .map(|s| s.trim().to_string());
    let h = match from_file {
        Some(s) if !s.is_empty() => s,
        _ => std::env::var("HOSTNAME").unwrap_or_default().trim().to_string(),
    };
    if h.is_empty() || h.len() > 64 || h.contains(char::is_whitespace) {
        return None;
    }
    Some(h)
}

fn hidden_under(p: &Path, home: &Path) -> Option<String> {
    let rest = match p.strip_prefix(home) {
        Ok(r)  => r,
        Err(_) => return None,
    };
    for c in rest.components() {
        let s = c.as_os_str().to_string_lossy();
        if s.len() > 1 && s.starts_with('.') {
            return Some(s.to_string());
        }
    }
    None
}

/// Says on standard error why the hand will not serve, before the process ends.
///
/// Each line stands alone, because it will be read out of context in a browser
/// log by somebody already confused: what was attempted, what stopped it, what
/// to do.
///
/// # Arguments
/// * `e` - The refusal.
fn refuse(e: &Error<ErrTag>) {
    // The cause before the symptom.  Where the journal directory will not open,
    // every other refusal is downstream of it -- and "write your folder into
    // root.txt" is actively misleading advice about a file in a directory
    // nothing can read.
    if let Some(n) = journal_note() {
        eprintln!("daimond-hand: {}", n);
    }
    eprintln!("daimond-hand: {}", e.plain());
    eprintln!(
        "daimond-hand: 'hand/install/install.sh --check' lists what has to be \
        true, and the fix for each thing that is not.");
}

/// The sentence about the record's own directory, where there is one to say.
///
/// # Returns
/// What is wrong with the journal directory and what to do about it, or `None`
/// where it can be reached and the refusal is about something else.
fn journal_note() -> Option<String> {
    let dir = match journal::default_dir() {
        Ok(d)  => d,
        Err(_) => return None,	// The refusal itself is that there is no such path.
    };
    let (at, why, verb) = match reach(&dir) {
        Reach::Ok					=> return None,
        Reach::Closed { at, why }	=> (at, why, "could not be opened"),
        Reach::Frozen { at, why }	=> (at, why, "cannot be written"),
    };
    Some(match hidden_in_home(&at) {
        // The hour. A confined browser hands the hand its confinement, and the
        // record is behind a hidden directory, so the hand cannot write the one
        // thing it would have used to explain itself.
        Some(h) => fmt!(
            "the journal at '{}' {}: {}. '{}' is hidden, and a snap or flatpak \
            browser lets the programs it starts see only the files in $HOME \
            that are not -- so the hand exits before it can say so. Fix: a \
            Chromium-family browser installed from a .deb. \
            DAIMOND_HAND_JOURNAL_DIR will not help, because the browser gives \
            this program its own environment rather than yours.",
            at.display(), verb, why, h),
        None => fmt!(
            "the journal at '{}' {}: {}. Nothing is served without a record of \
            it.", at.display(), verb, why),
    })
}

/// Reads where the journal goes, which folder is granted, and what can be enforced.
fn configure() -> Outcome<Serve> {
    let dir  = res!(journal::default_dir());
    let root = res!(granted_root(&dir));
    // Optional, and read AFTER the granted root: a hand with no ceiling is every hand
    // built before 2026-08-26, and it serves exactly as it did.
    let term_pinned   = terminal_ceiling(&dir).is_some();
    let term_ceilings = terminal_ceilings(&dir, &root);
    Ok(Serve {
        journal:  JournalCfg::at(dir),
        fence:    Fence::detect(),
        root,
        term_ceilings,
        term_pinned,
        launcher: Launcher::SelfExe,
    })
}

/// Serves a browser on stdin and stdout.
fn host() -> Outcome<()> {
    let cfg = res!(configure());
    let rt  = res!(tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|e| err!(e, "The hand could not start its runtime."; IO, Init)));
    let end = res!(rt.block_on(serve(std::io::stdin(), tokio::io::stdout(), cfg)));
    eprintln!("daimond-hand: {}.", end.why());
    Ok(())
}

/// Whichever of the four things this binary is being asked to be.
///
/// The launcher arm comes first and never returns; everything else is either a
/// person at a terminal or a browser at a pipe.
///
/// Nothing is returned to the runtime.  `fn main() -> Outcome<()>` ends a
/// refusal with `Error: UpstreamErr{"src/main.rs:1764"}` and two more frames of
/// the same, which is a stack trace where a sentence was wanted; [`refuse`]
/// writes the sentence instead.
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    // Whether a browser is on the other end of standard output, which decides where a
    // refusal can be READ.  A person at a terminal reads standard error; a browser
    // discards it, so for a browser the refusal has to go down the pipe as a frame.
    let piped = match args.first().map(|s| s.as_str()) {
        Some(a) if a == LAUNCH_ARG                                    => false,
        Some("--report") | Some("-r") | Some("--version") | Some("-V") => false,
        Some(a)                                                       => is_browser_arg(a),
        None                                                          => true,
    };
    let done = match args.first().map(|s| s.as_str()) {
        // The launcher, and the first thing this binary looks at.
        //
        // `exec.rs` re-executes the hand to apply a fence and then become the
        // command: Landlock restricts the thread that calls it, so the fence
        // has to be applied in a process that has started no runtime and opened
        // nothing.  This arm must therefore stay first, and it never returns.
        Some(a) if a == LAUNCH_ARG => launch_main(),
        Some("--report") | Some("-r") => report(),
        Some("--version") | Some("-V") => {
            println!("{} {}", daimond_hand::HOST_NAME, daimond_hand::version());
            Ok(())
        },
        // A browser passes the calling extension's origin and nothing else, so
        // an argument of that shape means the pipe is already there.
        Some(a) if is_browser_arg(a) => host(),
        Some(other) => Err(err!(
            "Unknown argument '{}'. This is a native messaging host: a browser \
            launches it and speaks to it over a pipe. Run it with --report to \
            see what the fence can enforce on this machine.", other;
            Invalid, Input)),
        // No arguments means a pipe as well, which is how a test drives it.
        None => host(),
    };
    if let Err(e) = done {
        // Down the pipe FIRST, because that is the end with a reader who can act on it.
        // A native messaging host's standard error is discarded by the browser, so every
        // refusal here -- no granted root, a journal that will not open, a second hand
        // already holding the record -- reached the page as the browser's own "Native host
        // has exited" and nothing else. The page then guessed, in a paragraph, at which of
        // two causes it was; the hand knew all along.
        if piped {
            say_fault(&fault_line(&e));
        }
        refuse(&e);
        std::process::exit(1);
    }
}

/// The one sentence a browser is told when the hand will not start.
///
/// [`refuse`] writes three lines, which is right for a person at a terminal and is the
/// right ORDER too -- the cause before the symptom, because a journal directory that
/// cannot be reached makes every other refusal downstream of it.  A frame carries one
/// sentence, so the same ordering picks which one it is.
///
/// # Arguments
/// * `e` - What stopped the hand.
fn fault_line(e: &Error<ErrTag>) -> String {
    match journal_note() {
        Some(n) => n,
        None    => e.plain(),
    }
}

/// The framed bytes of one [`Resp::Fault`], or nothing where it will not encode.
///
/// Separate from [`say_fault`] so the frame can be read back in a test: the whole
/// point of it is that a browser can read it, and a test that only proved the
/// function ran would prove nothing about that.
///
/// # Arguments
/// * `reason` - The sentence, as [`fault_line`] composed it.
fn fault_frame(reason: &str) -> Option<Vec<u8>> {
    let mut buf = Vec::new();
    match FRAMING.write_resp(&mut buf, &Resp::Fault { reason: fmt!("{}", reason) }) {
        Ok(())  => Some(buf),
        Err(_)  => None,
    }
}

/// Writes one [`Resp::Fault`] to the pipe, best effort.
///
/// Best effort by construction: the hand is on its way out either way, and a failure
/// here has no reader left to tell.
///
/// # Arguments
/// * `reason` - The sentence, as [`fault_line`] composed it.
fn say_fault(reason: &str) {
    use std::io::Write;
    if let Some(buf) = fault_frame(reason) {
        let mut out = std::io::stdout();
        let _ = out.write_all(&buf);
        let _ = out.flush();
    }
}

// ┌───────────────────────────────────────────────────────────────┐
// │ Tests                                                          │
// └───────────────────────────────────────────────────────────────┘

#[cfg(test)]
mod tests {
    use super::*;

    use daimond_hand::wire::{
        Capture,
        FenceSpec,
        Sig,
        Stream,
    };

    use std::{
        collections::VecDeque,
        io::Cursor,
        sync::mpsc as std_mpsc,
    };

    use tokio::io::AsyncReadExt;

    // ── Becoming the launcher ───────────────────────────────────────
    //
    // A command is fenced by re-executing this binary, and in a test binary
    // `/proc/self/exe` is libtest, whose `main` does not dispatch `LAUNCH_ARG`.
    // So the launcher is invoked as "run exactly the test named below", and
    // that test calls `launch_main`. The same device `exec.rs` uses, for the
    // same reason: a test that skipped the launcher would not be testing the
    // path that ships.

    /// The environment name that turns a copy of the test binary into a launcher.
    const LAUNCH_CHILD: &str = "DAIMOND_HAND_MAIN_TEST_LAUNCHER";

    /// What libtest writes to standard output before it reaches a test.
    ///
    /// Removed by name rather than tolerated, so that a change in the harness
    /// fails a test instead of quietly moving a number.  Whether the second
    /// line reaches the pipe at all depends on when libtest flushes, which the
    /// `exec` does not wait for, so both are removed and neither is required.
    const HARNESS_NOISE: &str = "\nrunning 1 test\n";

    /// The line libtest writes as it enters the launcher entry point.
    const HARNESS_LINE: &str = "test tests::launcher_child_entry ... ";

    /// A hand that will not start says so down the pipe, where a browser can read it.
    ///
    /// The owner opened a Terminal on 2026-08-26 and was told the hand "disconnected without
    /// finishing", that it had either crashed or sent a message over the browser's 1 MB frame
    /// limit, and to "tell the user to check the hand's journal" -- to a reader who WAS the
    /// user, about a record that held nothing, because the hand had exited before opening it.
    /// It had a whole sentence for him and wrote it to a standard error the browser discards.
    ///
    /// So the sentence goes down the pipe as a frame first.  Read back through the codec here
    /// rather than merely counted, because "a browser can read it" is the entire claim.
    #[test]
    fn a_hand_that_will_not_start_says_why_on_the_pipe() -> Outcome<()> {
        let said = "Daimond is already open in another browser window on this computer.";
        let buf = match fault_frame(said) {
            Some(b) => b,
            None    => return Err(err!("a refusal of {} bytes did not fit a frame", said.len(); Bug)),
        };
        let mut cur = Cursor::new(buf);
        match res!(FRAMING.read_resp(&mut cur)) {
            Some(Resp::Fault { reason }) => assert_eq!(said, reason,
                "the sentence did not survive the frame"),
            other => return Err(err!(
                "the pipe carried {:?} where the hand's own refusal was wanted", other; Bug)),
        }
        Ok(())
    }

    /// Only a browser is sent one, because only a browser cannot read standard error.
    ///
    /// The launcher is the arm that matters: it re-executes this binary to become a fenced
    /// command, and its standard output is the COMMAND'S.  A frame written there would arrive
    /// in the middle of a program's output as unexplained bytes.
    #[test]
    fn the_pipe_is_told_and_a_person_at_a_terminal_is_not() {
        for (arg, piped) in [
            (Some(LAUNCH_ARG),                          false),
            (Some("--report"),                          false),
            (Some("-r"),                                false),
            (Some("--version"),                         false),
            (Some("-V"),                                false),
            (Some("chrome-extension://abc/"),           true),
            (Some("moz-extension://abc/"),              true),
            (Some("--parent-window=1"),                 true),
            (Some("nonsense"),                          false),
            (None,                                      true),
        ] {
            let got = match arg {
                Some(a) if a == LAUNCH_ARG => false,
                Some("--report") | Some("-r") | Some("--version") | Some("-V") => false,
                Some(a) => is_browser_arg(a),
                None    => true,
            };
            assert_eq!(piped, got, "argument {:?} was read as piped={}", arg, got);
        }
    }

    /// The hardened fence reaches a terminal, not only a command.
    ///
    /// `Desk::exec` says a terminal is gated exactly as a command is, "written once so the two
    /// cannot drift" -- and then [`with_fence`] carried the guarded spec into a `Req::Exec` and
    /// dropped it for a `Req::Open`, two paragraphs below the comment.  So the journal's own
    /// directory was denied to a command and not to a terminal, inside the one function whose
    /// comment asserts the two cannot differ.
    #[test]
    fn a_terminal_carries_the_hardened_fence_a_command_does() {
        let arrived = FenceSpec {
            rw:   vec![fmt!("/home/u/ws")],
            ro:   Vec::new(),
            deny: vec![fmt!("/home/u/ws/.daimond")],
            net:  false,
        };
        // What `Journal::fence_guard` produces: the same fence with the record put out of reach.
        let guarded = FenceSpec {
            deny: vec![fmt!("/home/u/ws/.daimond"), fmt!("/home/u/journal")],
            ..arrived.clone()
        };
        let open = Req::Open {
            id:       fmt!("t1"),
            argv:     vec![fmt!("bash")],
            cwd:      fmt!("/home/u/ws"),
            env:      Vec::new(),
            size:     daimond_hand::wire::PtySize { cols: 80, rows: 24 },
            fence:    arrived.clone(),
            toolkits: Vec::new(),
        };
        match with_fence(open, guarded.clone()) {
            Req::Open { fence, .. } => assert_eq!(guarded, fence,
                "a terminal was opened with the fence that ARRIVED, so the journal directory the \
                guard added is missing from it"),
            other => panic!("with_fence changed the request into {:?}", other),
        }
        // The control: the command path, which has always carried it.
        let exec = Req::Exec {
            id:         fmt!("r1"),
            argv:       vec![fmt!("/bin/true")],
            cwd:        fmt!("/home/u/ws"),
            env:        Vec::new(),
            stdin:      None,
            timeout_ms: 1000,
            capture:    Capture::Both,
            fence:      arrived,
            toolkits:   Vec::new(),
        };
        match with_fence(exec, guarded.clone()) {
            Req::Exec { fence, .. } => assert_eq!(guarded, fence),
            other => panic!("with_fence changed the request into {:?}", other),
        }
    }

    /// A terminal does not outlive the conversation.
    ///
    /// `PtySessions::close_all` says it ends every session "for `Req::Bye`", and nothing called
    /// it: `Req::Bye` journalled the goodbye and returned, and the shutdown block below the loop
    /// stopped every RUN under the comment "Nothing outlives the conversation" and never a
    /// terminal.
    ///
    /// The visible cost was not an orphan but a hang: the session task holds a response sender, so
    /// the hand could not finish its own shutdown until the program inside the terminal ended by
    /// itself. Measured at five minutes for a `sleep 300` the page had already walked away from.
    /// The orphan is the other half -- a shell is otherwise cleaned up only as a side effect of
    /// the master file descriptor closing, which reaches one that dies on `SIGHUP` and misses one
    /// that ignores it or has re-parented.
    ///
    /// Both halves are asserted, and the second on the KERNEL: the child's process id comes back
    /// in `Resp::Opened`, and afterwards that process must be gone. A registry count would go to
    /// zero the moment the map was emptied, whether or not anything died.
    #[tokio::test]
    async fn a_terminal_does_not_outlive_the_conversation() -> Outcome<()> {
        if !can_fence() {
            return Ok(()); // A machine that cannot fence refuses the open, so there is no session.
        }
        let (cfg, _jdir) = res!(setup("pty-bye", Fence::detect()));
        // `sleep` rather than a shell: it neither reads its input nor dies of a closed terminal,
        // so if it is gone afterwards something signalled it.
        let open = Req::Open {
            id:       fmt!("t1"),
            argv:     vec![fmt!("/bin/sleep"), fmt!("300")],
            cwd:      fmt!("{}", cfg.root.display()),
            env:      Vec::new(),
            size:     daimond_hand::wire::PtySize { cols: 80, rows: 24 },
            fence:    FenceSpec {
                rw:   vec![fmt!("{}", cfg.root.display())],
                ro:   Vec::new(),
                deny: Vec::new(),
                net:  true,
            },
            toolkits: Vec::new(),
        };

        // A live feed rather than the fixed `Cursor` the other tests use, and the difference is
        // load-bearing: a terminal is registered by a task `Desk::exec` spawns, so a `Bye` sent in
        // the same breath as the `Open` can be processed before the session exists -- and a test
        // written that way would prove only that `close_all` was called on an empty registry.
        let (src, tx) = feed();
        let (w, mut r) = tokio::io::duplex(1 << 20);
        let task = tokio::spawn(serve(src, w, cfg));

        res!(tx.send(res!(framed(&hello()))).map_err(|e| err!(e, "send hello"; Test, IO)));
        res!(tx.send(res!(framed(&open))).map_err(|e| err!(e, "send open"; Test, IO)));

        // Wait for the session to actually exist before saying goodbye, or this proves nothing.
        let mut seen = Vec::new();
        let mut pid = 0u32;
        for _ in 0..200 {
            let mut buf = [0u8; 4096];
            match tokio::time::timeout(Duration::from_millis(100), r.read(&mut buf)).await {
                Ok(Ok(0))  => break,
                Ok(Ok(n))  => seen.extend_from_slice(&buf[..n]),
                Ok(Err(_)) => break,
                Err(_)     => (), // Nothing yet; look at what has arrived so far.
            }
            if let Ok(rs) = responses(&seen) {
                if let Some(p) = rs.iter().find_map(|x| match x {
                    Resp::Opened { pid, .. } => Some(*pid),
                    _                        => None,
                }) {
                    pid = p;
                    break;
                }
                // Refused rather than opened: no session, and nothing to outlive anything.
                if rs.iter().any(|x| matches!(x, Resp::Refused { .. })) {
                    return Ok(());
                }
            }
        }
        if pid == 0 {
            return Ok(()); // No terminal was opened on this machine.
        }
        assert!(std::path::Path::new(&fmt!("/proc/{}", pid)).exists(),
            "the terminal's process {} was not running even before the goodbye", pid);

        res!(tx.send(res!(framed(&Req::Bye))).map_err(|e| err!(e, "send bye"; Test, IO)));
        drop(tx);

        // Bounded, and the bound is half the assertion: without `close_all` the goodbye does not
        // end the terminal, the session task goes on holding a response sender, and the hand's own
        // shutdown waits for the program inside it.
        let mut rest = Vec::new();
        let waited = tokio::time::timeout(
            Duration::from_secs(30), r.read_to_end(&mut rest)).await;
        assert!(waited.is_ok(),
            "the conversation did not end within 30 s of the page saying goodbye: the terminal \
            was never closed, so the hand waited for the program inside it");
        let end = res!(res!(task.await.map_err(|e| err!(e, "join"; IO))));
        assert_eq!(Ending::Goodbye, end);

        // The kernel is the oracle. A short wait, because signalling and reaping are not
        // instantaneous and the alternative is a flake in whichever direction the machine is slow.
        let mut alive = true;
        for _ in 0..100 {
            if !std::path::Path::new(&fmt!("/proc/{}", pid)).exists() {
                alive = false;
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(!alive,
            "the terminal's process {} was still running after the page said goodbye and the \
            hand's conversation ended", pid);
        Ok(())
    }

    /// The launcher entry point, reached only in a re-executed test binary.
    #[test]
    fn launcher_child_entry() {
        if std::env::var(LAUNCH_CHILD).is_err() {
            return;
        }
        launch_main()
    }

    /// A launcher that re-enters this test binary at [`launcher_child_entry`].
    fn test_launcher() -> Outcome<Launcher> {
        let exe = res!(std::env::current_exe().map_err(|e| err!(e,
            "The loop's tests need to know their own binary."; Test, IO)));
        Ok(Launcher::Explicit {
            prog: exe,
            args: vec![
                fmt!("tests::launcher_child_entry"),
                fmt!("--exact"),
                fmt!("--nocapture"),
                fmt!("--test-threads=1"),
            ],
            env:  vec![(fmt!("{}", LAUNCH_CHILD), fmt!("1"))],
        })
    }

    /// A directory to work in, under the build's own target tree.
    ///
    /// Never `/tmp`: it is a tmpfs here, and a test that fills it takes the
    /// machine's memory with it.
    ///
    /// # Arguments
    /// * `name` - A name unique to the test.
    fn scratch(name: &str) -> Outcome<PathBuf> {
        let base = match std::env::var("CARGO_TARGET_DIR") {
            Ok(v) if !v.is_empty() => PathBuf::from(v),
            _ => PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target"),
        };
        let dir = base.join("main-tests").join(name);
        if dir.exists() {
            res!(fs::remove_dir_all(&dir));
        }
        res!(fs::create_dir_all(&dir));
        Ok(dir)
    }

    /// A stream a test can feed and then close, so a reader can be left waiting.
    ///
    /// Blocking, because that is what a pipe is, and the reader under test is
    /// written for one.
    struct Feed {
        /// Where the next bytes come from.
        rx:  std_mpsc::Receiver<Vec<u8>>,
        /// What has arrived and not yet been read.
        buf: VecDeque<u8>,
    }

    impl Read for Feed {
        fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
            while self.buf.is_empty() {
                match self.rx.recv() {
                    Ok(v)  => self.buf.extend(v),
                    Err(_) => return Ok(0), // The far end closed.
                }
            }
            let n = out.len().min(self.buf.len());
            for (i, b) in self.buf.drain(..n).enumerate() {
                out[i] = b;
            }
            Ok(n)
        }
    }

    /// A feed and the handle that writes to it.
    fn feed() -> (Feed, std_mpsc::Sender<Vec<u8>>) {
        let (tx, rx) = std_mpsc::channel::<Vec<u8>>();
        (Feed { rx, buf: VecDeque::new() }, tx)
    }

    /// The bytes one request occupies on the wire.
    ///
    /// # Arguments
    /// * `req` - The request.
    fn framed(req: &Req) -> Outcome<Vec<u8>> {
        let mut b = Vec::new();
        res!(FRAMING.write_req(&mut b, req));
        Ok(b)
    }

    /// Every response a byte stream carries.
    ///
    /// # Arguments
    /// * `bytes` - What the hand wrote.
    fn responses(bytes: &[u8]) -> Outcome<Vec<Resp>> {
        let mut cur = Cursor::new(bytes.to_vec());
        let mut out = Vec::new();
        loop {
            match FRAMING.read_resp(&mut cur) {
                Ok(Some(r)) => out.push(r),
                Ok(None)    => break,
                Err(e)      => return Err(e),
            }
        }
        Ok(out)
    }

    /// The configuration a test serves with.
    ///
    /// # Arguments
    /// * `name` - A name unique to the test.
    /// * `fence` - What the machine is to be treated as able to enforce.
    fn setup(name: &str, fence: Fence) -> Outcome<(Serve, PathBuf)> {
        let dir  = res!(scratch(name));
        let jdir = dir.join("journal");
        let root = dir.join("work");
        res!(fs::create_dir_all(&root));
        Ok((
            Serve {
                journal:  JournalCfg::at(&jdir),
                fence,
                root:     res!(fs::canonicalize(&root)),
                term_ceilings: vec![res!(fs::canonicalize(&root))],
                term_pinned: false,
                launcher: res!(test_launcher()),
            },
            jdir,
        ))
    }

    /// The kinds of every journal entry, in order.
    ///
    /// # Arguments
    /// * `dir` - The journal directory.
    fn kinds(dir: &Path) -> Outcome<Vec<String>> {
        let mut out = Vec::new();
        for (_, path) in res!(journal::journal_files(dir)) {
            let txt = res!(fs::read_to_string(&path), IO, File);
            for line in txt.lines() {
                if line.trim().is_empty() {
                    continue;
                }
                out.push(res!(journal::parse_line(line)).kind);
            }
        }
        Ok(out)
    }

    /// A hello of the version this build speaks.
    fn hello() -> Req {
        Req::Hello { proto: daimond_hand::PROTO, client: fmt!("test") }
    }

    /// An exec inside the granted root.
    ///
    /// # Arguments
    /// * `id` - The run's identifier.
    /// * `argv` - The program and its arguments.
    /// * `root` - The granted folder, which is also the fence and the cwd.
    /// * `ms` - The wall-clock limit.
    fn exec(id: &str, argv: &[&str], root: &Path, ms: u64) -> Req {
        Req::Exec {
            id:         fmt!("{}", id),
            argv:       argv.iter().map(|a| fmt!("{}", a)).collect(),
            cwd:        fmt!("{}", root.display()),
            env:        Vec::new(),
            stdin:      None,
            timeout_ms: ms,
            capture:    Capture::Both,
            // Net left open, so that a kernel without Landlock's network rules
            // refuses for the reason under test rather than for that one.
            fence:      FenceSpec {
                rw:   vec![fmt!("{}", root.display())],
                ro:   Vec::new(),
                deny: Vec::new(),
                net:  true,
            },
            toolkits: Vec::new(),
        }
    }

    /// Whether this machine can fence a command at all.
    ///
    /// The tests that need a real process assert the full stream where it can,
    /// and a refusal where it cannot, because both are correct behaviour and
    /// which one is correct depends on the kernel underneath.
    fn can_fence() -> bool {
        !Fence::detect().caps().iter().any(|c| c == "fence:none")
    }

    /// A fence value for a machine that can enforce nothing.
    fn no_fence() -> Fence {
        Fence::None { why: fmt!("This is a test with no kernel behind it.") }
    }

    /// The handshake answers with the protocol, the build, the caps and the root.
    /// **A grant is refused where it would swallow the record of what it did.**
    ///
    /// The one rule that is not a preference: [`journal::check_fence_at`] refuses any fence
    /// reaching the journal, so a folder CONTAINING the journal would be refused on every
    /// command afterwards. Caught at the grant, where the sentence can name the fix, rather
    /// than as a mystery on the next run. `/` and a path that is not a directory are checked
    /// beside it because all three answer the same question: can this folder bound anything.
    #[tokio::test]
    async fn a_grant_that_would_swallow_the_record_is_refused() -> Outcome<()> {
        let (cfg, jdir) = res!(setup("grant", Fence::detect()));
        let swallows = res!(jdir.parent().ok_or_else(|| err!(
            "the journal has no parent"; Test, Missing))).to_path_buf();
        let mut input = res!(framed(&hello()));
        input.extend_from_slice(&res!(framed(&Req::Grant {
            path: fmt!("{}", swallows.display()) })));
        input.extend_from_slice(&res!(framed(&Req::Grant { path: fmt!("/") })));
        input.extend_from_slice(&res!(framed(&Req::Grant {
            path: fmt!("{}/not-a-folder-at-all", swallows.display()) })));
        input.extend_from_slice(&res!(framed(&Req::Bye)));

        let (w, mut r) = tokio::io::duplex(1 << 20);
        let task = tokio::spawn(serve(Cursor::new(input), w, cfg.clone()));
        let mut bytes = Vec::new();
        res!(r.read_to_end(&mut bytes).await.map_err(|e| err!(e, "read"; IO)));
        let _ = res!(res!(task.await.map_err(|e| err!(e, "join"; IO))));
        let rs = res!(responses(&bytes));

        assert!(!rs.iter().any(|x| matches!(x, Resp::Granted { .. })),
            "one of three refusable grants was written: {:?}", rs);
        let said: Vec<String> = rs.iter().filter_map(|x| match x {
            Resp::Error { message, .. } => Some(message.clone()),
            _ => None,
        }).collect();
        assert_eq!(3, said.len(), "expected three refusals, got {:?}", said);
        assert!(said.iter().any(|m| m.contains("record")),
            "the swallowed-record refusal does not name the record: {:?}", said);
        assert!(said.iter().any(|m| m.contains("the machine")),
            "'/' was not refused as the machine: {:?}", said);
        let after = std::fs::read_to_string(jdir.join(daimond_hand::ROOT_FILE)).unwrap_or_default();
        assert!(!after.contains(&fmt!("{}", swallows.display())),
            "a refused grant reached root.txt: {:?}", after);
        Ok(())
    }

    /// **A folder browser is BOUNDED, and the bound survives `..`.**
    ///
    /// This exists because the browser's own `showDirectoryPicker` cannot serve a fence: it
    /// answers with a handle carrying a name and no path. So the hand offers the chooser, and
    /// the moment it does it is a thing that lists directories on somebody's machine -- which
    /// is only safe while the bound is the bound. Checked on the CANONICAL path, so a walk up
    /// through `..` leaves by the same door it came in.
    #[tokio::test]
    async fn a_folder_walk_is_bounded_and_says_where_it_will_start() -> Outcome<()> {
        let (cfg, _jdir) = res!(setup("dirs", Fence::detect()));
        let outside = fmt!("{}/..", cfg.root.display());
        let mut input = res!(framed(&hello()));
        input.extend_from_slice(&res!(framed(&Req::Dirs { path: fmt!("") })));
        input.extend_from_slice(&res!(framed(&Req::Dirs { path: outside.clone() })));
        input.extend_from_slice(&res!(framed(&Req::Bye)));

        let (w, mut r) = tokio::io::duplex(1 << 20);
        let task = tokio::spawn(serve(Cursor::new(input), w, cfg.clone()));
        let mut bytes = Vec::new();
        res!(r.read_to_end(&mut bytes).await.map_err(|e| err!(e, "read"; IO)));
        let _ = res!(res!(task.await.map_err(|e| err!(e, "join"; IO))));
        let rs = res!(responses(&bytes));

        // An empty ask says where it will start, and that is the granted root and no more.
        let start = rs.iter().find_map(|r| match r {
            Resp::Dirs { path, roots, .. } if path.is_empty() => Some(roots.clone()),
            _ => None,
        });
        let roots = res!(start.ok_or_else(|| err!(
            "the hand did not say where a folder walk starts: {:?}", rs; Test, Missing)));
        assert!(roots.iter().any(|r| r == &fmt!("{}", cfg.root.display())),
            "the granted root is not among the places a walk may start: {:?}", roots);

        // And a walk out through `..` is refused, naming what it would allow.
        let refused = rs.iter().any(|r| matches!(r,
            Resp::Error { message, .. } if message.contains("outside the folders")));
        assert!(refused, "a walk up out of the grant was not refused: {:?}", rs);
        // Belt and braces: it must not have ANSWERED with the parent's listing.
        assert!(!rs.iter().any(|r| matches!(r, Resp::Dirs { path, .. }
            if !path.is_empty() && !path.starts_with(&fmt!("{}", cfg.root.display())))),
            "a listing outside the grant came back: {:?}", rs);
        Ok(())
    }

    #[tokio::test]
    async fn handshake_answers_with_caps_and_the_granted_root() -> Outcome<()> {
        let (cfg, jdir) = res!(setup("handshake", Fence::detect()));
        let mut input = res!(framed(&hello()));
        input.extend_from_slice(&res!(framed(&Req::Bye)));

        let (w, mut r) = tokio::io::duplex(1 << 20);
        let task = tokio::spawn(serve(Cursor::new(input), w, cfg.clone()));
        let mut bytes = Vec::new();
        res!(r.read_to_end(&mut bytes).await.map_err(|e| err!(e, "read"; IO)));
        let end = res!(res!(task.await.map_err(|e| err!(e, "join"; IO))));

        assert_eq!(Ending::Goodbye, end);
        let rs = res!(responses(&bytes));
        match rs.first() {
            Some(Resp::Hello { proto, host, version, os, caps }) => {
                assert_eq!(daimond_hand::PROTO, *proto);
                assert_eq!(daimond_hand::HOST_NAME, host);
                assert_eq!(daimond_hand::version(), version);
                assert_eq!(daimond_hand::os(), os);
                // The real list, not a hard-coded one.
                for c in Fence::detect().caps() {
                    assert!(caps.contains(&c), "{:?} is missing {}", caps, c);
                }
                let want = fmt!("root:{}", cfg.root.display());
                assert!(caps.contains(&want), "{:?} is missing {}", caps, want);
            },
            other => return Err(err!("Expected a hello, got {:?}.", other; Test, Invalid)),
        }
        // The handshake and the goodbye are both in the record.
        let ks = res!(kinds(&jdir));
        assert_eq!(vec![fmt!("opened"), fmt!("closed")], ks);
        Ok(())
    }

    /// What one `caps` entry carries, where the list has it.
    ///
    /// # Arguments
    /// * `caps` - The list from a hello.
    /// * `prefix` - The entry wanted.
    fn cap_value(caps: &[String], prefix: &str) -> Option<String> {
        caps.iter()
            .find(|c| c.starts_with(prefix))
            .map(|c| c[prefix.len()..].to_string())
    }

    /// The `caps` of one whole conversation that says hello and goodbye.
    ///
    /// # Arguments
    /// * `cfg` - What to serve with.
    async fn caps_of(cfg: Serve) -> Outcome<Vec<String>> {
        let mut input = res!(framed(&hello()));
        input.extend_from_slice(&res!(framed(&Req::Bye)));
        let (w, mut r) = tokio::io::duplex(1 << 20);
        let task = tokio::spawn(serve(Cursor::new(input), w, cfg));
        let mut bytes = Vec::new();
        res!(r.read_to_end(&mut bytes).await.map_err(|e| err!(e, "read"; IO)));
        res!(res!(task.await.map_err(|e| err!(e, "join"; IO))));
        for resp in res!(responses(&bytes)) {
            if let Resp::Hello { caps, .. } = resp {
                return Ok(caps);
            }
        }
        Err(err!("The hand never said hello."; Test, Missing))
    }

    /// The page is given something it can check the folder's identity against.
    ///
    /// `REVIEW.md` §1.14.  Five properties, and the last two are the ones that
    /// make the first three worth anything:
    ///
    /// 1. A token reaches the page, and it is the token in the file the page can
    ///    read through its own handle.
    /// 2. It survives a restart, so it names the folder rather than the run.
    /// 3. A different folder gets a different one, so the comparison can fail.
    /// 4. Rubbish in the file is replaced rather than published, so a token the
    ///    page is given always came from here.
    /// 5. Where no token can be established the hand says `unproven` rather than
    ///    inventing one or saying nothing, because a page cannot tell silence
    ///    from an older hand.
    #[tokio::test]
    async fn the_page_is_told_which_folder_this_is() -> Outcome<()> {
        let (cfg, _) = res!(setup("workspace-id", Fence::detect()));
        let idf = cfg.root.join(APP_DIR).join(WS_ID_FILE);

        // 1. The token on the wire is the token in the folder.
        let caps = res!(caps_of(cfg.clone()).await);
        let tok = match cap_value(&caps, WS_CAP) {
            Some(t) => t,
            None    => return Err(err!(
                "No {:?} entry in {:?}.", WS_CAP, caps; Test, Missing)),
        };
        assert_eq!(WS_ID_LEN, tok.len(), "the token is not a token: {:?}", tok);
        assert_ne!(WS_UNPROVEN, tok);
        let txt = res!(fs::read_to_string(&idf), IO, File);
        assert_eq!(Some(tok.clone()), id_from_file(&txt));
        // It explains itself to whoever opens it.
        assert!(txt.starts_with('#'), "the identity file says nothing: {:?}", txt);

        // 2. A second launch is the same folder.
        assert_eq!(Some(tok.clone()), cap_value(&res!(caps_of(cfg.clone()).await), WS_CAP));

        // 3. A different folder is a different folder.
        let (other, _) = res!(setup("workspace-id-other", Fence::detect()));
        let tok2 = cap_value(&res!(caps_of(other).await), WS_CAP);
        assert_ne!(Some(tok.clone()), tok2, "two folders share one identity");

        // 4. Something that is not a token is not published as one.
        res!(fs::write(&idf, "# planted\nnot-a-token\n"), IO, File);
        let tok3 = match cap_value(&res!(caps_of(cfg.clone()).await), WS_CAP) {
            Some(t) => t,
            None    => return Err(err!("No identity after a plant."; Test, Missing)),
        };
        assert_eq!(WS_ID_LEN, tok3.len(), "a planted line reached the page: {:?}", tok3);
        assert_ne!(tok, tok3, "the planted file was left in place");

        // 5. A folder that cannot hold one is said to be unproven.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            res!(fs::remove_dir_all(cfg.root.join(APP_DIR)), IO, File);
            res!(fs::set_permissions(&cfg.root, fs::Permissions::from_mode(0o500)), IO, File);
            let said = cap_value(&res!(caps_of(cfg.clone()).await), WS_CAP);
            res!(fs::set_permissions(&cfg.root, fs::Permissions::from_mode(0o700)), IO, File);
            assert_eq!(Some(fmt!("{}", WS_UNPROVEN)), said,
                "a folder with no identity was given one anyway");
        }
        Ok(())
    }

    /// Only a line shaped like a token is read as one.
    #[test]
    fn an_identity_file_is_read_strictly() {
        let good = mint_id();
        assert_eq!(WS_ID_LEN, good.len());
        assert_eq!(Some(good.clone()), id_from_file(&fmt!("# why\n\n{}\n", good)));
        assert_ne!(mint_id(), good, "two tokens were the same");

        for bad in [
            "",                                     // Nothing at all.
            "# only a comment\n",                   // Nothing but a comment.
            "\n\n",                                 // Nothing but blank lines.
            "0123456789abcdef",                     // Too short.
            "0123456789abcdef0123456789abcdef0",    // Too long.
            "0123456789ABCDEF0123456789abcdef",     // Not the spelling written.
            "0123456789abcdef0123456789abcdeg",     // Not hexadecimal.
            "../../etc/passwd",                     // Not a token at all.
        ] {
            assert_eq!(None, id_from_file(bad), "{:?} was read as a token", bad);
        }
    }

    /// A page speaking another protocol is refused, and the conversation ends.
    #[tokio::test]
    async fn a_protocol_mismatch_is_refused() -> Outcome<()> {
        let (cfg, jdir) = res!(setup("mismatch", Fence::detect()));
        let input = res!(framed(&Req::Hello { proto: 999, client: fmt!("test") }));

        let (w, mut r) = tokio::io::duplex(1 << 16);
        let task = tokio::spawn(serve(Cursor::new(input), w, cfg));
        let mut bytes = Vec::new();
        res!(r.read_to_end(&mut bytes).await.map_err(|e| err!(e, "read"; IO)));
        let end = res!(res!(task.await.map_err(|e| err!(e, "join"; IO))));

        match end {
            Ending::Stopped(_) => (),
            other => return Err(err!("Expected a stop, got {:?}.", other; Test, Invalid)),
        }
        let rs = res!(responses(&bytes));
        match rs.first() {
            Some(Resp::Refused { reason, .. }) => {
                assert!(reason.contains("999"), "{}", reason);
                assert!(reason.contains(&fmt!("{}", daimond_hand::PROTO)), "{}", reason);
            },
            other => return Err(err!("Expected a refusal, got {:?}.", other; Test, Invalid)),
        }
        // The refusal was written down before it was sent.
        assert!(res!(kinds(&jdir)).contains(&fmt!("refused")));
        Ok(())
    }

    // ── Saying why, when the journal cannot ─────────────────────────
    //
    // The hour of 2026-08-02: a snap Chromium started the hand, the hand could
    // not open a journal behind `~/.local`, and it exited with Chrome reporting
    // "Native host has exited" and the hand reporting nothing -- because the
    // thing it could not do was the thing it would have used to say so.

    /// The hidden component that a confined browser cannot reach is named.
    #[test]
    fn a_hidden_directory_under_home_is_named() {
        let home = Path::new("/home/u");
        assert_eq!(
            hidden_under(Path::new("/home/u/.local/share/daimond/hand/journal"), home),
            Some(fmt!(".local")),
            "the component a snap cannot open is the one to name");
        // A journal somewhere the browser CAN reach says nothing about snap,
        // because saying it would send the next hour the wrong way.
        assert_eq!(hidden_under(Path::new("/home/u/daimond/journal"), home), None);
        // Outside the home directory the confinement does not apply.
        assert_eq!(hidden_under(Path::new("/srv/daimond/journal"), home), None);
        // The home directory's own name may start with a dot without that
        // meaning anything about what is inside it.
        assert_eq!(hidden_under(Path::new("/home/.u/work"), Path::new("/home/.u")), None);
    }

    /// A journal directory that will not open is reported, and named.
    #[cfg(unix)]
    #[test]
    fn an_unopenable_journal_directory_is_reported() -> Outcome<()> {
        use std::os::unix::fs::PermissionsExt;
        let dir  = res!(scratch("reach-closed"));
        let jdir = dir.join("journal");
        res!(fs::create_dir(&jdir));
        res!(fs::set_permissions(&jdir, fs::Permissions::from_mode(0o000)), IO, File);
        let got = reach(&jdir);
        // Restored before any assertion, so a failure does not leave a
        // directory the next `cargo clean` cannot remove.
        res!(fs::set_permissions(&jdir, fs::Permissions::from_mode(0o700)), IO, File);
        match got {
            Reach::Closed { at, .. } => assert_eq!(at, jdir),
            _ => return Err(err!(
                "A journal directory at mode 000 must be reported as closed, \
                which is the snap failure in a form a test can make."; Test, Bug)),
        }
        Ok(())
    }

    /// A journal directory that will not take a file is reported, and named.
    #[cfg(unix)]
    #[test]
    fn an_unwritable_journal_directory_is_reported() -> Outcome<()> {
        use std::os::unix::fs::PermissionsExt;
        let dir  = res!(scratch("reach-frozen"));
        let jdir = dir.join("journal");
        res!(fs::create_dir(&jdir));
        res!(fs::set_permissions(&jdir, fs::Permissions::from_mode(0o500)), IO, File);
        let got = reach(&jdir);
        res!(fs::set_permissions(&jdir, fs::Permissions::from_mode(0o700)), IO, File);
        match got {
            Reach::Frozen { at, .. } => assert_eq!(at, jdir),
            _ => return Err(err!(
                "A readable directory that takes no file must be reported as \
                frozen: the hand cannot write the record and will exit."; Test, Bug)),
        }
        Ok(())
    }

    /// A directory that is merely absent is not a fault, and the probe leaves nothing.
    #[test]
    fn an_absent_journal_directory_is_not_a_fault() -> Outcome<()> {
        let dir = res!(scratch("reach-ok"));
        // Absent, with a reachable ancestor: the journal makes its own.
        match reach(&dir.join("not").join("there").join("yet")) {
            Reach::Ok => {},
            _ => return Err(err!(
                "An absent journal directory under a writable ancestor must not \
                be reported as unreachable, or every first run says so."; Test, Bug)),
        }
        match reach(&dir) {
            Reach::Ok => {},
            _ => return Err(err!("A writable directory must be reachable."; Test, Bug)),
        }
        let left: Vec<_> = res!(fs::read_dir(&dir), IO, File)
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert!(left.is_empty(),
            "the write probe must tidy up after itself, found {:?}", left);
        Ok(())
    }

    /// A machine with no fence refuses every command, and never runs one.
    #[tokio::test]
    async fn an_unfenceable_machine_refuses_rather_than_running() -> Outcome<()> {
        let (cfg, jdir) = res!(setup("unfenced", no_fence()));
        let mut input = res!(framed(&hello()));
        input.extend_from_slice(&res!(framed(&exec("r1", &["/bin/echo", "hi"], &cfg.root, 5_000))));
        input.extend_from_slice(&res!(framed(&Req::Bye)));

        let (w, mut r) = tokio::io::duplex(1 << 20);
        let task = tokio::spawn(serve(Cursor::new(input), w, cfg));
        let mut bytes = Vec::new();
        res!(r.read_to_end(&mut bytes).await.map_err(|e| err!(e, "read"; IO)));
        res!(res!(task.await.map_err(|e| err!(e, "join"; IO))));

        let rs = res!(responses(&bytes));
        let refused = rs.iter().any(|r| match r {
            Resp::Refused { id, reason } => id == "r1" && reason.contains("not run"),
            _ => false,
        });
        assert!(refused, "{:?}", rs);
        // Nothing started, which is the difference between refusing and
        // mentioning it afterwards.
        assert!(!rs.iter().any(|r| matches!(r, Resp::Started { .. })), "{:?}", rs);
        let ks = res!(kinds(&jdir));
        assert!(ks.contains(&fmt!("refused")), "{:?}", ks);
        assert!(!ks.contains(&fmt!("exec")), "{:?}", ks);
        assert!(!ks.contains(&fmt!("started")), "{:?}", ks);
        Ok(())
    }

    /// A command streams its output and ends, and the record leads the run.
    #[tokio::test]
    async fn an_exec_streams_and_ends() -> Outcome<()> {
        let (cfg, jdir) = res!(setup("exec", Fence::detect()));
        let mut input = res!(framed(&hello()));
        input.extend_from_slice(&res!(framed(&exec("r1", &["/bin/echo", "hello"], &cfg.root, 10_000))));
        input.extend_from_slice(&res!(framed(&Req::Bye)));

        let (w, mut r) = tokio::io::duplex(1 << 20);
        let task = tokio::spawn(serve(Cursor::new(input), w, cfg));
        let mut bytes = Vec::new();
        res!(r.read_to_end(&mut bytes).await.map_err(|e| err!(e, "read"; IO)));
        res!(res!(task.await.map_err(|e| err!(e, "join"; IO))));

        let rs = res!(responses(&bytes));
        if !can_fence() {
            assert!(rs.iter().any(|r| matches!(r, Resp::Refused { .. })), "{:?}", rs);
            return Ok(());
        }
        assert!(rs.iter().any(|r| matches!(r, Resp::Started { .. })), "{:?}", rs);
        let said = rs.iter().fold(String::new(), |mut acc, r| {
            if let Resp::Chunk { data, .. } = r {
                acc.push_str(data);
            }
            acc
        });
        // The launcher here is the test binary, which announces itself before
        // it reaches the entry point; removed by name, so a change in the
        // harness fails this rather than moving quietly.
        assert_eq!("hello\n", said.replace(HARNESS_NOISE, "").replace(HARNESS_LINE, ""));
        match rs.iter().find(|r| matches!(r, Resp::Ended { .. })) {
            Some(Resp::Ended { exit, .. }) => assert_eq!(0, *exit),
            other => return Err(err!("Expected an ending, got {:?}.", other; Test, Missing)),
        }
        // The order in the record is the order the rule states: written down,
        // then started, then ended.
        let ks = res!(kinds(&jdir));
        let at = |k: &str| ks.iter().position(|x| x == k);
        match (at("exec"), at("started"), at("ended")) {
            (Some(a), Some(b), Some(c)) => assert!(a < b && b < c, "{:?}", ks),
            _ => return Err(err!("The record is missing a line: {:?}.", ks; Test, Missing)),
        }
        Ok(())
    }

    /// A signal reaches a run, and the run says it was killed.
    #[tokio::test]
    async fn a_signal_reaches_a_run() -> Outcome<()> {
        if !can_fence() {
            return Ok(());
        }
        let (cfg, jdir) = res!(setup("signal", Fence::detect()));
        let (input, tap) = feed();
        let (w, mut r) = tokio::io::duplex(1 << 20);
        let task = tokio::spawn(serve(input, w, cfg.clone()));

        res!(tap.send(res!(framed(&hello()))).map_err(|e| err!(e, "send"; IO)));
        res!(tap.send(res!(framed(&exec("r1", &["/bin/sleep", "30"], &cfg.root, 60_000))))
            .map_err(|e| err!(e, "send"; IO)));

        // Wait for the run to be announced before signalling it.
        let mut bytes = Vec::new();
        let mut buf = [0u8; 4096];
        while !responses(&bytes).map(|v| v.iter().any(|r| matches!(r, Resp::Started { .. })))
            .unwrap_or(false)
        {
            let n = res!(r.read(&mut buf).await.map_err(|e| err!(e, "read"; IO)));
            if n == 0 {
                break;
            }
            bytes.extend_from_slice(&buf[..n]);
        }
        res!(tap.send(res!(framed(&Req::Signal { id: fmt!("r1"), sig: Sig::Kill })))
            .map_err(|e| err!(e, "send"; IO)));
        res!(tap.send(res!(framed(&Req::Bye))).map_err(|e| err!(e, "send"; IO)));
        drop(tap);

        loop {
            let n = res!(r.read(&mut buf).await.map_err(|e| err!(e, "read"; IO)));
            if n == 0 {
                break;
            }
            bytes.extend_from_slice(&buf[..n]);
        }
        res!(res!(task.await.map_err(|e| err!(e, "join"; IO))));

        let rs = res!(responses(&bytes));
        match rs.iter().find(|r| matches!(r, Resp::Ended { .. })) {
            Some(Resp::Ended { killed, .. }) => assert!(*killed, "{:?}", rs),
            other => return Err(err!("Expected an ending, got {:?}.", other; Test, Missing)),
        }
        assert!(res!(kinds(&jdir)).contains(&fmt!("signalled")));
        Ok(())
    }

    /// An oversized frame is discarded whole, and the next request is served.
    ///
    /// `REVIEW.md` §3.3: without this the body stays in the pipe and every
    /// later request is read from the middle of it.
    #[tokio::test]
    async fn an_oversized_frame_does_not_poison_the_stream() -> Outcome<()> {
        let (cfg, _) = res!(setup("oversize", Fence::detect()));
        let n = (INBOUND_MAX + 4_096) as u32;
        let mut input = n.to_ne_bytes().to_vec();
        input.extend(std::iter::repeat(b'x').take(n as usize));
        // The valid request that must still be served.
        input.extend_from_slice(&res!(framed(&hello())));
        input.extend_from_slice(&res!(framed(&Req::Bye)));

        let (w, mut r) = tokio::io::duplex(1 << 21);
        let task = tokio::spawn(serve(Cursor::new(input), w, cfg));
        let mut bytes = Vec::new();
        res!(r.read_to_end(&mut bytes).await.map_err(|e| err!(e, "read"; IO)));
        let end = res!(res!(task.await.map_err(|e| err!(e, "join"; IO))));

        assert_eq!(Ending::Goodbye, end);
        let rs = res!(responses(&bytes));
        match rs.first() {
            Some(Resp::Error { id, message }) => {
                assert!(id.is_none());
                // The page is told the real ceiling, which §3.3 says it never was.
                assert!(message.contains(&fmt!("{}", INBOUND_MAX)), "{}", message);
            },
            other => return Err(err!("Expected an error, got {:?}.", other; Test, Invalid)),
        }
        match rs.get(1) {
            Some(Resp::Hello { .. }) => (),
            other => return Err(err!(
                "The request after the oversized frame was not served: {:?}.",
                other; Test, Invalid)),
        }
        Ok(())
    }

    /// A frame beyond any plausible message ends the connection cleanly.
    #[tokio::test]
    async fn an_absurd_length_ends_the_connection() -> Outcome<()> {
        let (cfg, _) = res!(setup("absurd", Fence::detect()));
        let mut input = u32::MAX.to_ne_bytes().to_vec();
        input.extend_from_slice(b"{}");

        let (w, mut r) = tokio::io::duplex(1 << 16);
        let task = tokio::spawn(serve(Cursor::new(input), w, cfg));
        let mut bytes = Vec::new();
        res!(r.read_to_end(&mut bytes).await.map_err(|e| err!(e, "read"; IO)));
        let end = res!(res!(task.await.map_err(|e| err!(e, "join"; IO))));

        match end {
            Ending::Stopped(why) => assert!(why.contains("declared"), "{}", why),
            other => return Err(err!("Expected a stop, got {:?}.", other; Test, Invalid)),
        }
        Ok(())
    }

    /// Garbage in a well-formed frame is answered, and the stream survives it.
    #[tokio::test]
    async fn garbage_is_answered_and_the_stream_survives() -> Outcome<()> {
        let (cfg, jdir) = res!(setup("garbage", Fence::detect()));
        let junk: &[u8] = b"not json at all";
        let mut input = (junk.len() as u32).to_ne_bytes().to_vec();
        input.extend_from_slice(junk);
        // A frame of legal JSON that is not a message, and one with a tag from
        // a build that does not exist.
        for body in ["[1, 2]", "{\"t\": \"detonate\"}"] {
            input.extend_from_slice(&(body.len() as u32).to_ne_bytes());
            input.extend_from_slice(body.as_bytes());
        }
        input.extend_from_slice(&res!(framed(&hello())));
        input.extend_from_slice(&res!(framed(&Req::Bye)));

        let (w, mut r) = tokio::io::duplex(1 << 18);
        let task = tokio::spawn(serve(Cursor::new(input), w, cfg));
        let mut bytes = Vec::new();
        res!(r.read_to_end(&mut bytes).await.map_err(|e| err!(e, "read"; IO)));
        let end = res!(res!(task.await.map_err(|e| err!(e, "join"; IO))));

        assert_eq!(Ending::Goodbye, end);
        let rs = res!(responses(&bytes));
        let errs = rs.iter().filter(|r| matches!(r, Resp::Error { .. })).count();
        assert_eq!(3, errs, "{:?}", rs);
        // Each names the fault, so a reader is not left matching on prose.
        match rs.first() {
            Some(Resp::Error { message, .. }) => assert!(message.starts_with("codec."), "{}", message),
            other => return Err(err!("Expected an error, got {:?}.", other; Test, Invalid)),
        }
        assert!(rs.iter().any(|r| matches!(r, Resp::Hello { .. })), "{:?}", rs);
        // Every failure is in the record.
        let ks = res!(kinds(&jdir));
        assert_eq!(3, ks.iter().filter(|k| *k == "failed").count(), "{:?}", ks);
        Ok(())
    }

    /// A stream that ends mid-run stops the run and closes the record.
    #[tokio::test]
    async fn stdin_closing_mid_run_ends_cleanly() -> Outcome<()> {
        if !can_fence() {
            return Ok(());
        }
        let (cfg, jdir) = res!(setup("closed", Fence::detect()));
        let (input, tap) = feed();
        let (w, mut r) = tokio::io::duplex(1 << 20);
        let task = tokio::spawn(serve(input, w, cfg.clone()));

        res!(tap.send(res!(framed(&hello()))).map_err(|e| err!(e, "send"; IO)));
        res!(tap.send(res!(framed(&exec("r1", &["/bin/sleep", "30"], &cfg.root, 60_000))))
            .map_err(|e| err!(e, "send"; IO)));

        let mut bytes = Vec::new();
        let mut buf = [0u8; 4096];
        while !responses(&bytes).map(|v| v.iter().any(|r| matches!(r, Resp::Started { .. })))
            .unwrap_or(false)
        {
            let n = res!(r.read(&mut buf).await.map_err(|e| err!(e, "read"; IO)));
            if n == 0 {
                break;
            }
            bytes.extend_from_slice(&buf[..n]);
        }
        // The page goes away without saying goodbye.
        drop(tap);
        loop {
            let n = res!(r.read(&mut buf).await.map_err(|e| err!(e, "read"; IO)));
            if n == 0 {
                break;
            }
            bytes.extend_from_slice(&buf[..n]);
        }
        let end = res!(res!(task.await.map_err(|e| err!(e, "join"; IO))));

        assert_eq!(Ending::Closed, end);
        let ks = res!(kinds(&jdir));
        assert!(ks.contains(&fmt!("closed")), "{:?}", ks);
        // The run was stopped rather than orphaned.
        let rs = res!(responses(&bytes));
        match rs.iter().find(|r| matches!(r, Resp::Ended { .. })) {
            Some(Resp::Ended { killed, .. }) => assert!(*killed, "{:?}", rs),
            // The ending may not have reached the wire before it closed; the
            // record is the thing that must be complete.
            _ => assert!(ks.contains(&fmt!("ended")) || ks.contains(&fmt!("closed")), "{:?}", ks),
        }
        Ok(())
    }

    /// A page that stops reading does not stop the hand from reading.
    ///
    /// `REVIEW.md` §3.7 exactly: a noisy run fills the one response channel, a
    /// second command is asked for, and the `Signal` that would stop the noise
    /// arrives behind it. A loop that awaited [`Runner::spawn`] would still be
    /// inside the second command -- its `Started` cannot be sent -- and would
    /// never take the signal at all. The proof is the journal, which the
    /// dispatcher writes as it goes: the `signalled` line appears while the
    /// writer is still stalled on a consumer that has read nothing.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn output_does_not_block_the_next_request() -> Outcome<()> {
        if !can_fence() {
            return Ok(());
        }
        let (cfg, jdir) = res!(setup("headofline", Fence::detect()));
        let (input, tap) = feed();
        // A tiny window, so the writer stalls almost at once.
        let (w, mut r) = tokio::io::duplex(256);
        let task = tokio::spawn(serve(input, w, cfg.clone()));

        res!(tap.send(res!(framed(&hello()))).map_err(|e| err!(e, "send"; IO)));
        res!(tap.send(res!(framed(&exec("flood", &["/bin/yes"], &cfg.root, 20_000))))
            .map_err(|e| err!(e, "send"; IO)));
        // Let the flood fill every queue there is.
        tokio::time::sleep(Duration::from_millis(400)).await;
        // A second command, whose announcement cannot be sent while the queue
        // is full, and then the signal that must be taken anyway.
        res!(tap.send(res!(framed(&exec("second", &["/bin/echo", "hi"], &cfg.root, 10_000))))
            .map_err(|e| err!(e, "send"; IO)));
        res!(tap.send(res!(framed(&Req::Signal { id: fmt!("flood"), sig: Sig::Kill })))
            .map_err(|e| err!(e, "send"; IO)));

        // Nothing has been read from the pipe, and the signal must still have
        // been taken. Give it a moment to be written down, but not long.
        let mut seen = false;
        for _ in 0..40 {
            tokio::time::sleep(Duration::from_millis(50)).await;
            if res!(kinds(&jdir)).contains(&fmt!("signalled")) {
                seen = true;
                break;
            }
        }
        assert!(seen, "the signal never reached the loop while output was flowing");

        // Now drain, so the run can finish and the hand can exit.
        res!(tap.send(res!(framed(&Req::Bye))).map_err(|e| err!(e, "send"; IO)));
        drop(tap);
        let mut buf = [0u8; 65_536];
        loop {
            let n = res!(r.read(&mut buf).await.map_err(|e| err!(e, "read"; IO)));
            if n == 0 {
                break;
            }
        }
        res!(res!(task.await.map_err(|e| err!(e, "join"; IO))));
        Ok(())
    }

    /// A command that cannot be written down is not run.
    ///
    /// The failure is made to happen rather than argued for: the journal is
    /// given a size limit of one byte, so the next entry has to open a new
    /// file, and the directory is taken away from it after the handshake. The
    /// append then genuinely fails, and the only correct answer is a refusal.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_command_that_cannot_be_journalled_is_not_run() -> Outcome<()> {
        use std::os::unix::fs::PermissionsExt;

        if !can_fence() {
            return Ok(());
        }
        let (mut cfg, jdir) = res!(setup("nowrite", Fence::detect()));
        // One byte, so the entry after the handshake must roll into a new file.
        cfg.journal.max_bytes = 1;

        let (input, tap) = feed();
        let (w, mut r) = tokio::io::duplex(1 << 20);
        let task = tokio::spawn(serve(input, w, cfg.clone()));

        res!(tap.send(res!(framed(&hello()))).map_err(|e| err!(e, "send"; IO)));
        let mut bytes = Vec::new();
        let mut buf = [0u8; 4096];
        while !responses(&bytes).map(|v| !v.is_empty()).unwrap_or(false) {
            let n = res!(r.read(&mut buf).await.map_err(|e| err!(e, "read"; IO)));
            if n == 0 {
                break;
            }
            bytes.extend_from_slice(&buf[..n]);
        }
        // The journal is open; now nothing more can be created beside it.
        res!(fs::set_permissions(&jdir, fs::Permissions::from_mode(0o500)), IO, File);

        res!(tap.send(res!(framed(&exec("r1", &["/bin/echo", "hi"], &cfg.root, 10_000))))
            .map_err(|e| err!(e, "send"; IO)));
        res!(tap.send(res!(framed(&Req::Bye))).map_err(|e| err!(e, "send"; IO)));
        drop(tap);
        loop {
            let n = res!(r.read(&mut buf).await.map_err(|e| err!(e, "read"; IO)));
            if n == 0 {
                break;
            }
            bytes.extend_from_slice(&buf[..n]);
        }
        res!(res!(task.await.map_err(|e| err!(e, "join"; IO))));
        // Left as it was found, so the next run can clear it away.
        res!(fs::set_permissions(&jdir, fs::Permissions::from_mode(0o700)), IO, File);

        let rs = res!(responses(&bytes));
        assert!(!rs.iter().any(|r| matches!(r, Resp::Started { .. })), "{:?}", rs);
        let refused = rs.iter().any(|r| match r {
            Resp::Refused { id, reason } => id == "r1" && reason.contains("journal"),
            _ => false,
        });
        assert!(refused, "{:?}", rs);
        Ok(())
    }

    /// With no journal there is no service, whatever else is in order.
    #[tokio::test]
    async fn no_journal_means_no_service() -> Outcome<()> {
        let dir  = res!(scratch("nojournal"));
        let root = dir.join("work");
        res!(fs::create_dir_all(&root));
        // A file where the journal directory should be, so it cannot be made.
        let jdir = dir.join("journal");
        res!(fs::write(&jdir, b"in the way"), IO, File);

        let cfg = Serve {
            journal:  JournalCfg::at(&jdir),
            fence:    Fence::detect(),
            root:     res!(fs::canonicalize(&root)),
            term_ceilings: vec![res!(fs::canonicalize(&root))],
            term_pinned: false,
            launcher: res!(test_launcher()),
        };
        let (w, _r) = tokio::io::duplex(1 << 16);
        let input = res!(framed(&hello()));
        match serve(Cursor::new(input), w, cfg).await {
            Ok(e)  => Err(err!("Expected a refusal to start, got {:?}.", e; Test, Invalid)),
            Err(_) => Ok(()),
        }
    }

    /// An oversized response is cut down and the loss is reported, never dropped.
    ///
    /// `REVIEW.md` §3.1: the shipping path could emit a frame Chrome refuses,
    /// and the run's output vanished with it.
    #[test]
    fn an_oversized_chunk_is_cut_and_the_loss_is_reported() -> Outcome<()> {
        let big = Resp::Chunk {
            id:     fmt!("r1"),
            stream: Stream::Out,
            seq:    7,
            // Control bytes cost six each in JSON, so this is far over the cap
            // as a frame while being well under it as bytes.
            data:   "\u{1}".repeat(400_000),
        };
        let (bytes, note) = res!(encode(&big));
        assert!(bytes.len() <= daimond_hand::wire::FRAME_MAX);
        match note {
            Some(n) => assert!(n.contains("dropped"), "{}", n),
            None    => return Err(err!("The cut was not reported."; Test, Missing)),
        }
        // What did arrive is a chunk, in sequence, saying what it lost.
        let mut cur = Cursor::new(bytes);
        match res!(FRAMING.read_resp(&mut cur)) {
            Some(Resp::Chunk { id, seq, data, .. }) => {
                assert_eq!("r1", id);
                assert_eq!(7, seq);
                assert!(data.ends_with("cannot carry them]"), "{}", &data[data.len() - 60..]);
            },
            other => return Err(err!("Expected a chunk, got {:?}.", other; Test, Invalid)),
        }
        Ok(())
    }

    /// A refusal too long for a frame is cut rather than lost.
    #[test]
    fn an_oversized_refusal_is_cut() -> Outcome<()> {
        let long = Resp::Refused {
            id:     fmt!("r1"),
            reason: "\u{1}".repeat(300_000),
        };
        let (bytes, note) = res!(encode(&long));
        assert!(bytes.len() <= daimond_hand::wire::FRAME_MAX);
        assert!(note.is_some());
        let mut cur = Cursor::new(bytes);
        match res!(FRAMING.read_resp(&mut cur)) {
            Some(Resp::Refused { id, reason }) => {
                assert_eq!("r1", id);
                assert!(reason.ends_with("cannot carry them]"), "{}", reason);
            },
            other => return Err(err!("Expected a refusal, got {:?}.", other; Test, Invalid)),
        }
        Ok(())
    }

    /// An ordinary response is not touched by the cut.
    #[test]
    fn an_ordinary_response_is_framed_unchanged() -> Outcome<()> {
        let r = Resp::Started { id: fmt!("r1"), pid: 42 };
        let (bytes, note) = res!(encode(&r));
        assert!(note.is_none());
        let mut cur = Cursor::new(bytes);
        assert_eq!(Some(r), res!(FRAMING.read_resp(&mut cur)));
        Ok(())
    }

    /// The granted root is read from the variable, and refused when it is not a folder.
    #[test]
    fn the_granted_root_is_configured_or_refused() -> Outcome<()> {
        let dir = res!(scratch("root"));
        // Nothing set anywhere: a refusal that names both places.
        std::env::remove_var(ROOT_VAR);
        match granted_root(&dir) {
            Ok(p)  => return Err(err!("Expected a refusal, got {:?}.", p; Test, Invalid)),
            Err(e) => {
                let m = e.msgs().join(" ");
                assert!(m.contains(ROOT_VAR), "{}", m);
                assert!(m.contains(ROOT_FILE), "{}", m);
            },
        }
        // The file beside the journal, comments and all.
        let work = dir.join("work");
        res!(fs::create_dir_all(&work));
        res!(fs::write(dir.join(ROOT_FILE),
            fmt!("# the folder this hand may work in\n\n{}\n", work.display())), IO, File);
        assert_eq!(res!(fs::canonicalize(&work)), res!(granted_root(&dir)));

        // A relative root is refused rather than resolved against nothing.
        res!(fs::write(dir.join(ROOT_FILE), b"work"), IO, File);
        assert!(granted_root(&dir).is_err());
        // So is one that does not exist.
        res!(fs::write(dir.join(ROOT_FILE), b"/nowhere/at/all/really"), IO, File);
        assert!(granted_root(&dir).is_err());
        // And a file is not a folder.
        let f = dir.join("a-file");
        res!(fs::write(&f, b"x"), IO, File);
        res!(fs::write(dir.join(ROOT_FILE), fmt!("{}", f.display())), IO, File);
        assert!(granted_root(&dir).is_err());
        Ok(())
    }

    /// The browser's own argument is not mistaken for a flag.
    #[test]
    fn a_browser_argument_is_recognised() -> Outcome<()> {
        assert!(is_browser_arg("chrome-extension://abcdefghijklmnop/"));
        assert!(is_browser_arg("moz-extension://abcdef/"));
        assert!(is_browser_arg("--parent-window=12345"));
        assert!(!is_browser_arg("--report"));
        assert!(!is_browser_arg("/etc/passwd"));
        Ok(())
    }
}
