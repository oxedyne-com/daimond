//! Running a named verifier from the tracked tree, and refusing to report a bare pass.
//!
//! Written on 2026-08-21.  A daimon cannot produce browser evidence: `listen()`
//! is refused by [`crate::seccomp`], a browser needs the display server's unix
//! socket and [`crate::seccomp::Unix::Refuse`] takes that away, so every
//! `dev/verify_*.mjs` that drives a real page dies under the fence a command
//! gets.  Half the proof of a release session is those scripts, so the machine
//! that could write the code could not check it.
//!
//! **The reframe this module is built on is about provenance, not sandboxing.**
//! The fence exists to contain a command a MODEL wrote.  A verifier is the
//! repository's own code, and the model supplies no part of it: it supplies a
//! *name* that is looked up in the directory, and at most a *break* that is
//! looked up in the file's own declarations.  So the verb is in the same trust
//! class as `cargo test`, and it runs the script outside the command fence
//! deliberately -- which is stated in the report, stated in the tool's
//! description, and recorded in the journal as `fence:none` so that nobody has
//! to take this paragraph's word for it.
//!
//! # And the reframe has to be enforced, not reported
//!
//! Until 2026-08-25 it was not.  `REVIEW.md` §1.21: the trustworthiness of a
//! verifier was measured -- `git ls-files --error-unmatch` -- and its only use
//! was a phrase in the report's first line.  A daimon writes `dev/verify_x.mjs`
//! with `file_write`, which every turn may do because the granted root is
//! writable, and the verb runs it with no fence on it at all.  Proved with a
//! script whose whole body wrote a file outside the granted root, which appeared.
//!
//! **The question is content, not membership.**  Appending one comment to a
//! tracked verifier leaves `git ls-files --error-unmatch` exiting 0 while
//! `git diff --quiet HEAD` on the same file exits 1, so enforcing what was
//! already measured would have narrowed the hole without closing it.
//! [`provenance`] therefore asks whether the working file IS the commit, and
//! [`unfenced_refusal`] is the gate; [`conduct`] passes it before anything runs
//! and [`once`] before every spawn.
//!
//! **The refusal is a capability difference and not a dead end**, which matters
//! because improving a verifier is exactly the self-development this app is for.
//! A verifier the daimon has just written still runs -- through `run`, inside
//! the same fence every command gets, which 253 of this tree's 282 verifiers
//! need nothing more than.  What it cannot do fenced is drive a browser or open
//! a port, and the refusal says so, so a fenced failure is not misread as the
//! script being broken.
//!
//! **What this does not close, and cannot from here.**  `.git` is inside the
//! granted root and every fence leaves it writable -- `src/tools.rs` says so in
//! its own words where it explains why a push injects `core.hooksPath` -- so a
//! daimon can commit its own verifier and then be told, truthfully, that the
//! bytes are the commit's.  That is one `run` call away and no check on this
//! side reaches it.  What changes is that the act is now a commit in the
//! repository's history rather than a `file_write` nobody sees, and that the
//! report's first line stops being false.  Closing it needs either `.git` out
//! of the fence or the owner's consent bound to the bytes; both are the owner's
//! to rule on, and the reasoning is in `REVIEW.md` §1.21.
//!
//! # The one thing this module exists to make impossible
//!
//! Running a verifier clean and reporting "27 checks passed" is exactly the
//! evidence that has been lying.  On 2026-08-20 three separate instruments
//! passed while aimed at nothing: a `--break` whose output was byte-identical to
//! a clean run, a leg count blind to a 1,856-request runaway, and a check
//! asserting a destination a re-route also reaches.  All three were caught
//! because a person demanded a break and the agents chose to report honestly.
//!
//! Honesty must not be load-bearing.  So the verb runs the clean pass AND each
//! declared break, and [`Verdict`] is an enum whose every arm carries the count
//! of breaks that reddened nothing.  There is no accessor for the passed count
//! on its own: a caller who wants it must match, and both arms hand back the
//! bad news in the same breath.

use crate::journal::{
    Event,
    Journal,
};
use crate::wire::{
    Capture,
    FenceSpec,
    Req,
    Resp,
    Sig,
    Stream,
    World,
    CHUNK_MAX,
};

use oxedyne_fe2o3_core::prelude::*;

use std::{
    collections::BTreeMap,
    path::{
        Path,
        PathBuf,
    },
    process::Stdio,
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
    io::AsyncReadExt,
    process::Command,
    sync::mpsc::Sender,
};

// ┌───────────────────────────────────────────────────────────────┐
// │ Where a verifier lives, and what it may be called              │
// └───────────────────────────────────────────────────────────────┘

/// The one directory under the granted root a verifier may be read from.
pub const DEV_DIR: &str = "dev";

/// The one file-name shape a verifier may have.
pub const PREFIX: &str = "verify_";

/// The one extension a verifier may have.
pub const SUFFIX: &str = ".mjs";

/// The longest a verifier's short name, or a break's, may be.
pub const NAME_MAX: usize = 64;

/// How much of one run's output is kept in memory.
///
/// Only the check lines and the clean run's text survive past the comparison,
/// so this bounds a working buffer rather than the report.
pub const OUT_MAX: usize = 8 * 1024 * 1024;

/// The default whole-sequence budget, when the caller names none.
pub const BUDGET_DEFAULT_MS: u64 = 20 * 60 * 1_000;

/// The largest whole-sequence budget a caller may ask for.
pub const BUDGET_MAX_MS: u64 = 4 * 60 * 60 * 1_000;

/// The least a single run is given before the budget is called spent.
///
/// A break handed four seconds is a break that will time out and be reported as
/// unrun, which is worse than saying plainly that the budget ran out.
pub const RUN_FLOOR_MS: u64 = 15 * 1_000;

/// Where a verifier leaves pictures, relative to the granted root.
pub const SHOTS_DIR: &str = "dev/shots";

/// The most shot paths one report will name.
pub const SHOTS_MAX: usize = 40;

/// The largest report this module will send, in bytes.
///
/// Under [`CHUNK_MAX`] so the whole report is one chunk and a reader never has
/// to reassemble it.
pub const REPORT_MAX: usize = CHUNK_MAX - 4_096;

/// How many of a dead run's own last lines the report carries.
///
/// Twenty is a Node stack trace and the line that threw.  It is spent only on a run that measured
/// nothing at all, so no report that carries evidence pays for it.
pub const DEAD_TAIL_LINES: usize = 20;

/// The last `n` lines of `text`, verbatim, without a trailing blank run.
///
/// # Arguments
/// * `text` - What the script printed, stdout and stderr together.
/// * `n` - How many lines from the end.
fn last_lines(text: &str, n: usize) -> String {
    let kept: Vec<&str> = text.lines()
        .rev()
        .skip_while(|l| l.trim().is_empty())
        .take(n)
        .collect();
    kept.iter().rev().map(|l| *l).collect::<Vec<&str>>().join("\n")
}

/// The marker every report ends with, which the app checks for.
///
/// A second line of defence at the far end: `Tool::Verify` refuses to hand a
/// model a result with no trailer, because a result with no trailer is a result
/// whose three numbers were never computed.
pub const TRAILER: &str = "[verify:";

/// The exit status of a sequence that proved itself.
pub const EXIT_PROVED: i32 = 0;

/// The exit status of a sequence whose clean run had failures.
pub const EXIT_FAILED: i32 = 1;

/// The exit status of a clean run nothing has proved.
pub const EXIT_UNPROVEN: i32 = 2;

// ┌───────────────────────────────────────────────────────────────┐
// │ Nobody is at the keyboard for a verifier this verb runs        │
// └───────────────────────────────────────────────────────────────┘
//
// A verifier is spawned with the hand's own environment, and the hand's own
// environment is whatever started it.  Started by the browser as a native
// messaging host, that is the browser's -- `DISPLAY=:0` and `WAYLAND_DISPLAY`
// among it, because the browser is on the owner's screen.  Half the verifiers in
// `dev/` drive a HEADED browser, and `dev/display.mjs` allowed `:0` on the stated
// grounds that watching a headed run on one's own seat is a thing people do.
//
// It is.  Nobody is watching this one.  A model asked for it, and the window
// would land in front of whoever happens to be at the machine, mid-sentence,
// exactly as it did on 2026-08-24 -- the incident that file's header is written
// about.  That fault was a check reading the display STRING and not the
// environment; this is the same shape one layer up, a check reading the
// environment and not knowing who asked.
//
// The hand knows who asked, and it is the only party that does.  So a verifier is
// handed no display at all and is told that none is coming: it must start one of
// its own, which `dev/verify_reflux.mjs` does and every other headed verifier is
// free to.  Refusing loudly is the point.  A headed verifier reached this way
// used to paint on the seat and now says it cannot, which is a capability this
// verb never honestly had.

/// The display names a verifier is never handed, whatever the hand was started with.
pub const SEAT_VARS: &[&str] = &["DISPLAY", "WAYLAND_DISPLAY", "XDG_SESSION_TYPE"];

/// The name that tells `dev/display.mjs` nobody is at the keyboard for this run.
pub const UNATTENDED_VAR: &str = "DAIMOND_UNATTENDED";

/// The environment a verifier is spawned with, from the hand's own.
///
/// Separate and pure so a test can put an environment to it without spawning
/// anything -- the mistake `dev/verify_harness.mjs` exists because of was a rule
/// that had no test because testing it meant opening a window.
///
/// # Arguments
/// * `env` - The hand's own environment, name to value.
pub fn unattended_env(env: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    let mut out = env.clone();
    for v in SEAT_VARS {
        out.remove(*v);
    }
    out.insert(fmt!("{}", UNATTENDED_VAR), fmt!("1"));
    out
}

/// The hand's own environment, as a map.
fn own_env() -> BTreeMap<String, String> {
    std::env::vars().collect()
}

/// Is this a name a verifier may be looked up by?
///
/// Deliberately narrower than a file name.  Lower case, digits and underscore
/// are the whole alphabet every verifier in the tree is spelled with, and they
/// leave nothing for a path, a flag or a shell to be made of: no dot, so `..`
/// cannot be written; no slash; no dash, so nothing can begin with one and be
/// read as an option.
///
/// # Arguments
/// * `name` - The short name, as the model wrote it.
pub fn name_ok(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= NAME_MAX
        && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

/// Why a file is not the commit's.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Change {
    Untracked,	// git has never heard of the path
    Edited,		// git has, and the working copy is not what the commit holds
    Linked,		// the path is a symlink, so its bytes are wherever it points
}

impl Change {
    /// The clause the refusal and the report both put after the file's name.
    pub fn phrase(&self) -> &'static str {
        match self {
            Self::Untracked	=> "git has never heard of it",
            Self::Edited	=> "it is tracked, and the working copy is not what the commit \
                holds -- staging a change is not committing it",
            Self::Linked	=> "it is a symbolic link, so its bytes are wherever it points \
                and the commit says nothing about them",
        }
    }
}

/// Whose bytes these are, as the repository can answer it.
///
/// **The question is content and not membership**, and the difference is the
/// whole of `REVIEW.md` §1.21.  `git ls-files --error-unmatch` answers about the
/// INDEX: append one comment to a tracked verifier and it still exits 0, while
/// `git diff --quiet HEAD` on the same file exits 1.  The claim the unfenced run
/// rests on is *these bytes came with the checkout*, and only the second question
/// answers it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Provenance {
    /// The working file is byte for byte what the commit holds.
    Committed,
    /// It is not, and this is how.
    Changed(Change),
    /// Nothing could be asked, and this is why.
    ///
    /// Refused rather than assumed either way.  Four verifiers were once
    /// promoted into `dev/` and left untracked, and `dev/gate.sh` builds its
    /// tree with `git worktree add` -- a clean checkout of a commit -- so the
    /// suite ran none of them while reporting a pass.
    Unknown(String),
}

impl Provenance {
    /// May a file of this provenance run outside the command fence?
    pub fn committed(&self) -> bool {
        matches!(self, Self::Committed)
    }

    /// The phrase the report carries.
    pub fn phrase(&self) -> String {
        match self {
            Self::Committed	=> fmt!("byte for byte the commit's"),
            Self::Changed(c)	=> fmt!("NOT THE COMMIT'S -- {}", c.phrase()),
            Self::Unknown(w)	=> fmt!("provenance unknown ({})", w),
        }
    }
}

/// One verifier, as the tree actually holds it.
#[derive(Clone, Debug)]
pub struct Script {
    /// The short name it was looked up by.
    pub name:    String,
    /// The file name, taken from the directory entry and never from the caller.
    pub file:    String,
    /// The absolute path, built from the directory and that entry.
    pub path:    PathBuf,
    /// Every break the file declares, in the order it declares them.
    pub breaks:  Vec<String>,
    /// Whose bytes these are, as the repository can answer it.
    pub prov:    Provenance,
}

/// Every break name a verifier's own source declares.
///
/// The declaration is a comment, because that is how this tree has always
/// spelled it -- `dev/breakcheck.mjs` already reads the same text for the same
/// purpose:
///
/// ```text
/// //   node dev/verify_about.mjs --break nobutton    # 1: no About button in the bar
/// ```
///
/// So the set is derived from the file rather than kept beside it, and a break
/// that has been deleted stops being offered the moment it goes.  A `--break`
/// followed by anything but a lower-case letter -- `<name>`, `${BREAK}`, a
/// closing quote -- is the file talking about the flag rather than declaring a
/// value, and is passed over.
///
/// # Arguments
/// * `src` - The verifier's source.
pub fn declared_breaks(src: &str) -> Vec<String> {
    let flag = "--break";
    let b    = src.as_bytes();
    let mut out: Vec<String> = Vec::new();
    let mut i = 0usize;
    while let Some(hit) = src[i..].find(flag) {
        let mut j = i + hit + flag.len();
        i = j;
        // The separator, which is the whole of what tells a declaration from a mention.
        match b.get(j) {
            Some(b' ') | Some(b'\t') | Some(b'=')	=> j += 1,
            _						=> continue,
        }
        while let Some(b' ') | Some(b'\t') = b.get(j) {
            j += 1;
        }
        let start = j;
        while let Some(c) = b.get(j) {
            if c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'_' {
                j += 1;
            } else {
                break;
            }
        }
        if j == start {
            continue;
        }
        let word = &src[start..j];
        // A leading digit or underscore is not a break name in this tree, and taking one
        // would offer the model a flag it cannot use.
        match word.chars().next() {
            Some(c) if c.is_ascii_lowercase()	=> (),
            _					=> continue,
        }
        if word.len() <= NAME_MAX && !out.iter().any(|w| w == word) {
            out.push(fmt!("{}", word));
        }
    }
    out
}

/// Every verifier the tree holds, by short name.
///
/// # Arguments
/// * `root` - The granted root.
pub fn catalogue(root: &Path) -> Outcome<Vec<String>> {
    let dir = root.join(DEV_DIR);
    let rd  = res!(std::fs::read_dir(&dir).map_err(|e| err!(e,
        "The verifiers live in '{}', which could not be read.", dir.display();
        IO, Missing)));
    let mut out = Vec::new();
    for entry in rd {
        let entry = match entry {
            Ok(e)  => e,
            Err(_) => continue,
        };
        let name = entry.file_name();
        let name = match name.to_str() {
            Some(s) => s,
            None    => continue,
        };
        if name.starts_with(PREFIX) && name.ends_with(SUFFIX) {
            let short = &name[PREFIX.len()..name.len() - SUFFIX.len()];
            if name_ok(short) {
                out.push(fmt!("{}", short));
            }
        }
    }
    out.sort();
    Ok(out)
}

/// Whether this machine has any verifier to run at all.
///
/// What the `verify:` capability in the handshake is computed from, so the page
/// can tell a model "not on this computer" rather than letting it discover the
/// same thing one refusal at a time.
///
/// # Arguments
/// * `root` - The granted root.
pub fn available(root: &Path) -> bool {
    match catalogue(root) {
        Ok(v)  => !v.is_empty(),
        Err(_) => false,
    }
}

/// The capability entry the handshake carries.
///
/// # Arguments
/// * `root` - The granted root.
pub fn cap(root: &Path) -> String {
    match available(root) {
        true	=> fmt!("verify:dev"),
        false	=> fmt!("verify:none"),
    }
}

/// The verifier a name refers to, or the sentence saying why there is none.
///
/// **Every string that leaves here came from the file system or from the file.**
/// `file` is the directory entry's own name, `path` is that entry joined onto
/// the directory, and `breaks` is parsed out of the source.  The caller's `name`
/// is used to *match* and is never used to *build*, which is the whole of the
/// argument that nothing the model wrote can reach a process.
///
/// # Arguments
/// * `root` - The granted root.
/// * `name` - The short name, as the model wrote it.
pub fn resolve(root: &Path, name: &str) -> Result<Script, String> {
    if !name_ok(name) {
        return Err(fmt!(
            "Refused: '{}' is not a verifier name. A name is lower-case letters, digits and \
            underscores -- 'graph' for dev/verify_graph.mjs. This verb takes a NAME and not a \
            path or a command line: there is nothing here that would run a path you wrote.",
            trim_for_message(name)));
    }
    let dir    = root.join(DEV_DIR);
    let wanted = fmt!("{}{}{}", PREFIX, name, SUFFIX);
    let rd = match std::fs::read_dir(&dir) {
        Ok(r)  => r,
        Err(e) => return Err(fmt!(
            "Refused: this computer's granted folder has no readable '{}' directory ({}), so \
            there are no verifiers on it to run.", dir.display(), e)),
    };
    let mut found: Option<std::ffi::OsString> = None;
    for entry in rd {
        let entry = match entry {
            Ok(e)  => e,
            Err(_) => continue,
        };
        if entry.file_name() == std::ffi::OsStr::new(&wanted) {
            found = Some(entry.file_name());
            break;
        }
    }
    let file = match found {
        Some(f) => f,
        None    => return Err(no_such(root, name, &wanted)),
    };
    let path = dir.join(&file);
    match std::fs::metadata(&path) {
        Ok(m) if m.is_file() => (),
        Ok(_)  => return Err(fmt!(
            "Refused: '{}' is not a file, so there is nothing to run.", path.display())),
        Err(e) => return Err(fmt!(
            "Refused: '{}' could not be read ({}), so there is nothing to run.",
            path.display(), e)),
    }
    let src = match std::fs::read_to_string(&path) {
        Ok(s)  => s,
        Err(e) => return Err(fmt!(
            "Refused: '{}' could not be read as text ({}), so its breaks cannot be listed and \
            it will not be run blind.", path.display(), e)),
    };
    let file_str = match file.to_str() {
        Some(s) => fmt!("{}", s),
        None    => return Err(fmt!(
            "Refused: the name of '{}' is not UTF-8, so it cannot be reported honestly.",
            path.display())),
    };
    Ok(Script {
        name:    fmt!("{}", name),
        breaks:  declared_breaks(&src),
        prov:    provenance(root, &file_str),
        file:    file_str,
        path,
    })
}

/// The sentence for a name that names nothing, with the near misses in it.
fn no_such(root: &Path, name: &str, wanted: &str) -> String {
    let near = match catalogue(root) {
        Ok(all) => {
            let mut n: Vec<String> = all.into_iter()
                .filter(|c| c.contains(name) || name.contains(c.as_str()))
                .take(8)
                .collect();
            n.sort();
            n
        },
        Err(_) => Vec::new(),
    };
    let tail = match near.is_empty() {
        true	=> fmt!("Ask for a file listing of 'dev' to see what there is."),
        false	=> fmt!("Names close to it: {}.", near.join(", ")),
    };
    fmt!(
        "Refused: there is no 'dev/{}' in the folder this hand was granted, so '{}' names no \
        verifier. {} Nothing was run.", wanted, trim_for_message(name), tail)
}

/// A caller's string, cut short and stripped of control characters, for a message.
///
/// A refusal quotes what the model asked for so it can see its own mistake, and
/// a refusal is written to the journal -- so a hundred kilobytes of newlines
/// must not become a hundred kilobytes of journal.
fn trim_for_message(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        if out.chars().count() >= 40 {
            out.push('…');
            break;
        }
        match c.is_control() {
            true	=> out.push('·'),
            false	=> out.push(c),
        }
    }
    out
}

/// Whose bytes `dev/<file>` holds, asked of git rather than assumed.
///
/// Three questions and the order matters.  Is there a repository here at all --
/// because a granted folder that is not one can vouch for nothing, and the
/// permissive reading of that was half of `REVIEW.md` §1.21's reproduction.  Is
/// the path a symlink -- because a committed link's target is an ordinary file
/// inside the granted root that any command may rewrite, which is §1.1's shape
/// wearing §1.21's clothes.  And last, does the working file differ from the
/// commit: `git diff --quiet HEAD` compares the WORKING TREE with `HEAD`, so it
/// catches a staged change and an unstaged one alike, and it applies the
/// repository's own end-of-line and filter settings, which a hash of the bytes
/// taken here would not.
///
/// Every argument vector is fixed but for one directory entry's own name, and
/// there is no shell, so `--` before it is belt to the braces.
///
/// # Arguments
/// * `root` - The granted root, which is where git is asked.
/// * `file` - The verifier's file name, from the directory entry.
pub fn provenance(root: &Path, file: &str) -> Provenance {
    let git = match on_path("git") {
        Some(p) => p,
        None    => return Provenance::Unknown(fmt!(
            "there is no git on this hand's PATH, so nothing here can say whose code this is")),
    };
    let rel = fmt!("{}/{}", DEV_DIR, file);
    let ask = |args: &[&str]| -> std::io::Result<std::process::ExitStatus> {
        std::process::Command::new(&git)
            .arg("-C").arg(root)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
    };
    match ask(&["rev-parse", "--git-dir"]) {
        Ok(s) if s.success()	=> (),
        Ok(_)			=> return Provenance::Unknown(fmt!(
            "the folder this hand was granted is not a git repository, so there is no commit \
            to compare this file with")),
        Err(e)			=> return Provenance::Unknown(fmt!("git could not be run: {}", e)),
    }
    // Asked without following the link, which is the whole point: `metadata` above
    // followed it and answered about the target.
    match std::fs::symlink_metadata(root.join(&rel)) {
        Ok(m) if m.file_type().is_symlink()	=> return Provenance::Changed(Change::Linked),
        Ok(_)					=> (),
        Err(e)					=> return Provenance::Unknown(fmt!(
            "'{}' could not be looked at ({})", rel, e)),
    }
    match ask(&["ls-files", "--error-unmatch", "--", &rel]) {
        Ok(s) if s.success()	=> (),
        Ok(_)			=> return Provenance::Changed(Change::Untracked),
        Err(e)			=> return Provenance::Unknown(fmt!("git could not be run: {}", e)),
    }
    // `git diff` says 0 for no difference and 1 for a difference; anything else is git
    // failing to answer, and an unborn HEAD in a repository with no commits is exactly
    // that.  A failure to answer is never read as agreement.
    match ask(&["diff", "--quiet", "HEAD", "--", &rel]) {
        Ok(s) if s.success()		=> Provenance::Committed,
        Ok(s) if s.code() == Some(1)	=> Provenance::Changed(Change::Edited),
        Ok(s)				=> Provenance::Unknown(fmt!(
            "git could not compare '{}' with the commit (it exited {}); a repository with no \
            commit in it yet is the usual reason", rel, match s.code() {
                Some(c) => fmt!("{}", c),
                None    => fmt!("on a signal"),
            })),
        Err(e)				=> Provenance::Unknown(fmt!("git could not be run: {}", e)),
    }
}

/// The sentence a verifier that is not the commit's is refused with, or `None`.
///
/// **This is the gate `REVIEW.md` §1.21 was open for**, and it is asked fresh
/// rather than read off the [`Script`] resolved earlier: a verifier sequence
/// runs for minutes, a background command started by an earlier turn can rewrite
/// a file while it does, and a check taken once at the start would be answering
/// about bytes that are no longer there.  [`conduct`] asks before anything runs
/// and [`once`] asks again before each spawn, so the window between the answer
/// and the `execve` is as small as this side can make it.
///
/// **The sentence is written to be acted on in one call.**  A refusal a model
/// cannot converge on costs the run anyway -- so it hands over the command that
/// runs the same file INSIDE the fence, which is where a command a model wrote
/// belongs and is enough for the nine verifiers in ten here that only read the
/// tree; it says what that cannot do, so a fenced failure is not misread as the
/// verifier being broken; and it names the two things that reach the unfenced
/// run, one of which is a person.
///
/// # Arguments
/// * `root` - The granted root.
/// * `file` - The verifier's file name, from the directory entry.
pub fn unfenced_refusal(root: &Path, file: &str) -> Option<String> {
    let prov = provenance(root, file);
    let why = match &prov {
        Provenance::Committed	=> return None,
        Provenance::Changed(c)	=> fmt!("{}", c.phrase()),
        Provenance::Unknown(w)	=> fmt!("{}", w),
    };
    Some(fmt!(
        "Refused: dev/{} is not this repository's committed code -- {}. Nothing was run. A \
        verifier is the one thing this hand runs OUTSIDE the command fence, and the whole of \
        the reason is that its bytes came with the checkout instead of from a model; this \
        hand cannot tell your edit from anybody else's, so it will not run one unfenced. \
        RUN IT YOURSELF INSTEAD: 'run' with [\"node\",\"dev/{}\"] runs this same file inside \
        the fence every command gets, which is all a verifier that reads the tree needs. It \
        is not enough for one that drives a browser or opens a port -- the fence refuses \
        both, so a failure there is the fence and not your script. To get the unfenced run, \
        commit the file and ask again, or ask the person to run it themselves.",
        file, why, file))
}

/// The first entry on `PATH` that is a runnable file with this name.
///
/// The hand's own `PATH`, which is the browser's, since Chrome hands a native
/// messaging host its own environment.  A name and never a path: this is asked
/// only about `node` and `git`, both of which are written down here.
///
/// # Arguments
/// * `prog` - The program's bare name.
pub fn on_path(prog: &str) -> Option<PathBuf> {
    let path = match std::env::var("PATH") {
        Ok(p)  => p,
        Err(_) => return None,
    };
    for dir in path.split(':') {
        if dir.is_empty() {
            continue;
        }
        let cand = Path::new(dir).join(prog);
        if runnable(&cand) {
            return Some(cand);
        }
    }
    None
}

/// Is this a file the kernel would execute?
#[cfg(unix)]
fn runnable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    match std::fs::metadata(p) {
        Ok(m)  => m.is_file() && (m.permissions().mode() & 0o111) != 0,
        Err(_) => false,
    }
}

/// Is this a file the kernel would execute?
#[cfg(not(unix))]
fn runnable(p: &Path) -> bool {
    match std::fs::metadata(p) {
        Ok(m)  => m.is_file(),
        Err(_) => false,
    }
}

/// Every file under `dev/shots` this sequence wrote, workspace-relative.
///
/// Named rather than returned.  A daimon reads a picture by asking `file_read`
/// for it with `"as":"image"`, or by dispatching a worker who can see -- so what
/// the report owes it is the PATH, and handing back the bytes would spend a
/// context window on an image the model may not be able to look at anyway.
///
/// Compared by modification time against the moment the sequence started, so an
/// old screenshot from last week's run is not claimed as this run's evidence.
///
/// # Arguments
/// * `root` - The granted root.
/// * `since` - When the sequence began.
pub fn shots_since(root: &Path, since: std::time::SystemTime) -> Vec<String> {
    let mut out  = Vec::new();
    let base     = root.join(SHOTS_DIR);
    let mut todo = vec![base.clone()];
    while let Some(dir) = todo.pop() {
        if out.len() >= SHOTS_MAX {
            break;
        }
        let rd = match std::fs::read_dir(&dir) {
            Ok(r)  => r,
            Err(_) => continue,
        };
        for entry in rd {
            let entry = match entry {
                Ok(e)  => e,
                Err(_) => continue,
            };
            let path = entry.path();
            let meta = match entry.metadata() {
                Ok(m)  => m,
                Err(_) => continue,
            };
            if meta.is_dir() {
                todo.push(path);
                continue;
            }
            let fresh = match meta.modified() {
                Ok(t)  => t >= since,
                Err(_) => false,
            };
            if !fresh {
                continue;
            }
            if let Ok(rel) = path.strip_prefix(root) {
                out.push(fmt!("{}", rel.display()));
            }
        }
    }
    out.sort();
    out.truncate(SHOTS_MAX);
    out
}

// ┌───────────────────────────────────────────────────────────────┐
// │ Reading what a verifier said                                   │
// └───────────────────────────────────────────────────────────────┘

/// Every check a run reported, by name, and whether it passed every time it
/// appeared.
///
/// A `BTreeMap` because two runs are compared and the comparison must not depend
/// on the order the lines arrived in; a name that appears twice folds to the
/// worse of the two, since a check that failed once is not a check that passed.
pub type Checks = BTreeMap<String, bool>;

/// The checks a run's output reports.
///
/// The convention is one line per check, and it is the same in all 265 files of
/// `dev/`, because they all copy the same four-line helper:
///
/// ```text
/// console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
/// ```
///
/// The detail is cut off before the name is kept.  It carries counts, paths and
/// timings that differ between two runs of the same passing check, and comparing
/// it would make every break look as though it had bitten.
///
/// # Arguments
/// * `text` - Everything the run printed, on both streams.
pub fn parse_checks(text: &str) -> Checks {
    let mut out: Checks = BTreeMap::new();
    for line in text.lines() {
        let t = line.trim_start();
        let (pass, rest) = if let Some(r) = t.strip_prefix("ok ") {
            (true, r)
        } else if let Some(r) = t.strip_prefix("FAIL ") {
            (false, r)
        } else if let Some(r) = t.strip_prefix("PASS ") {
            (true, r)
        } else {
            continue;
        };
        let head = match rest.find(" — ") {
            Some(i) => &rest[..i],
            None    => rest,
        };
        let name = head.trim();
        if name.is_empty() {
            continue;
        }
        let e = out.entry(fmt!("{}", name)).or_insert(true);
        *e = *e && pass;
    }
    out
}

/// The text of a run with the parts that legitimately differ taken out.
///
/// Used for one detail only -- saying that a break's output was *identical* to
/// the clean run's, which is the most damning thing that can be said about an
/// instrument.  A verifier usually announces its own break in a banner, so a raw
/// comparison would never find two runs identical and the worst case would never
/// be reported.  Lines mentioning the flag are therefore dropped, along with
/// blank lines and trailing space.
///
/// # Arguments
/// * `text` - Everything the run printed.
pub fn normalise(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for line in text.lines() {
        if line.contains("--break") || line.contains("BREAK") || line.contains("break '") {
            continue;
        }
        let t = line.trim_end();
        if t.is_empty() {
            continue;
        }
        out.push_str(t);
        out.push('\n');
    }
    out
}

/// What one run of a verifier did.
#[derive(Clone, Debug)]
pub struct Pass {
    /// `clean`, or the break's name.
    pub label:  String,
    /// The exit status, or -1 where there was none.
    pub exit:   i32,
    /// Whether the budget killed it.
    pub timed:  bool,
    /// The checks it reported.
    pub checks: Checks,
    /// Its output with the varying parts removed, for the identity comparison.
    pub norm:   String,
    /// Up to a few failing lines, verbatim, for the report.
    pub fails:  Vec<String>,
    /// The end of what it printed, verbatim, kept only for a run that measured NOTHING.
    ///
    /// A verifier that threw before its first check reports `0 passed, 0 failed`, and until
    /// 2026-09-13 the reason it threw reached the page nowhere: `parse_checks` found no checks,
    /// `fails` takes only lines beginning `FAIL `, and a stack trace is neither.  A daimon spent
    /// fifty steps on a browser verifier whose whole trouble was that nothing was listening on
    /// the port it navigates to.  Empty on every run that measured something, so the report is
    /// the length it always was.
    pub tail:   String,
    /// How long it took, in milliseconds.
    pub ms:     u64,
}

impl Pass {
    /// How many checks passed.
    pub fn passed(&self) -> usize {
        self.checks.values().filter(|v| **v).count()
    }

    /// How many checks failed.
    pub fn failed(&self) -> usize {
        self.checks.values().filter(|v| !**v).count()
    }
}

/// What a break did to the checks that passed clean.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Bite {
    /// At least one check that passed clean failed under it.
    Red {
        /// Which ones, up to a handful.
        names: Vec<String>,
    },
    /// No check that passed clean failed under it.  A lying instrument.
    None {
        /// Whether its output was the clean run's, banner aside.
        same:     bool,
        /// Checks that passed clean and did not appear at all.
        vanished: usize,
    },
    /// It never ran, and this is why.
    Unrun {
        /// The reason, in a phrase.
        why: String,
    },
}

/// What a break did, compared with the clean run.
///
/// **Deliberately the weaker claim.**  A break declares in a comment which check
/// it aims at, and a comment is not something to hold a verdict on -- so what is
/// asserted is that *some* check which passed clean now fails.  A break that
/// reddens a different check than it meant to is still an instrument that has
/// been seen to move; a break that reddens nothing is not.
///
/// # Arguments
/// * `clean` - The clean run.
/// * `brk` - The run under the break.
pub fn bite(clean: &Pass, brk: &Pass) -> Bite {
    let mut newly:    Vec<String> = Vec::new();
    let mut vanished: usize       = 0;
    for (name, ok) in clean.checks.iter() {
        if !*ok {
            continue;   // it was already failing; it can say nothing about this break
        }
        match brk.checks.get(name) {
            Some(true)	=> (),
            Some(false)	=> newly.push(fmt!("{}", name)),
            None	=> vanished += 1,
        }
    }
    if !newly.is_empty() {
        newly.truncate(6);
        return Bite::Red { names: newly };
    }
    Bite::None {
        same: clean.norm == brk.norm,
        vanished,
    }
}

// ┌───────────────────────────────────────────────────────────────┐
// │ The verdict, which cannot be given without its bad half        │
// └───────────────────────────────────────────────────────────────┘

/// What a whole sequence proved.
///
/// **An enum with no field accessors on purpose.**  The count of checks that
/// passed is reachable only by matching, and every arm that carries it also
/// carries what is wrong with it -- so there is no expression in this program
/// that yields "27 passed" without yielding, in the same breath, the number of
/// breaks that proved nothing or the fact that none was run.  That is the whole
/// design of this type, and a struct with three public fields would not have it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Verdict {
    /// The clean run and at least one break were run.
    Proven {
        /// Checks that passed clean.
        passed: usize,
        /// Checks that failed clean.
        failed: usize,
        /// Breaks that reddened a check which passed clean.
        red:    Vec<String>,
        /// Breaks that reddened nothing.  **The lying-instrument count.**
        dead:   Vec<String>,
        /// Breaks the budget or the machine never let run.
        unrun:  Vec<String>,
    },
    /// Only the clean run was made, so nothing here is known to be able to fail.
    Unproven {
        /// Checks that passed clean.
        passed:   usize,
        /// Checks that failed clean.
        failed:   usize,
        /// The breaks the file declares and this run did not use.
        declared: Vec<String>,
    },
}

impl Verdict {
    /// The one-line trailer, which is the sentence a model repeats.
    ///
    /// Both arms are here so that neither can be written without the other being
    /// looked at, and the `Unproven` arm names itself in the words the model
    /// should carry back: *proves nothing*.
    pub fn trailer(&self) -> String {
        match self {
            Self::Proven { passed, failed, red, dead, unrun } => {
                let mut s = fmt!(
                    "{} {} checks passed, {} failed, {} breaks confirmed red, {} breaks proved \
                    nothing", TRAILER, passed, failed, red.len(), dead.len());
                if !unrun.is_empty() {
                    s.push_str(&fmt!(", {} breaks never ran", unrun.len()));
                }
                s.push(']');
                s
            },
            Self::Unproven { passed, failed, declared } => fmt!(
                "{} {} checks passed, {} failed -- NOT PROVEN: no break was run, so no check \
                here has been shown to be able to fail. This is not evidence that anything \
                works. {} declared breaks were skipped; run again without 'clean_only' to prove \
                the instrument.]",
                TRAILER, passed, failed, declared.len()),
        }
    }

    /// The exit status this verdict deserves.
    pub fn exit(&self) -> i32 {
        match self {
            Self::Proven { failed, dead, unrun, .. } => {
                if *failed > 0 {
                    EXIT_FAILED
                } else if !dead.is_empty() || !unrun.is_empty() {
                    EXIT_UNPROVEN
                } else {
                    EXIT_PROVED
                }
            },
            Self::Unproven { failed, .. } => match *failed > 0 {
                true	=> EXIT_FAILED,
                false	=> EXIT_UNPROVEN,
            },
        }
    }

    /// The paragraph under the trailer that says what to do about it.
    pub fn advice(&self) -> String {
        match self {
            Self::Proven { failed, dead, unrun, .. } => {
                let mut s = String::new();
                if *failed > 0 {
                    s.push_str(
                        "Checks failed in the CLEAN run: that is the code, not the instrument. \
                        Read the failing lines above before running anything again.\n");
                }
                if !dead.is_empty() {
                    s.push_str(&fmt!(
                        "A break that proved nothing means the check it aims at cannot be made \
                        to fail, so that check is measuring nothing and its pass is worth \
                        nothing. Treat these as unmeasured and say so: {}.\n",
                        dead.join(", ")));
                }
                if !unrun.is_empty() {
                    s.push_str(&fmt!(
                        "These breaks never ran, so this sequence is an incomplete proof: {}.\n",
                        unrun.join(", ")));
                }
                if s.is_empty() {
                    s.push_str(
                        "Every declared break reddened a check that passed clean, so these \
                        checks have each been seen to fail. That is what makes the pass above \
                        evidence rather than an assertion.\n");
                }
                s
            },
            Self::Unproven { declared, .. } => {
                let mut s = fmt!(
                    "THIS RUN PROVES NOTHING. A check that has never been observed failing is \
                    not a check, and no check here was observed failing. Do not report the \
                    passing count as evidence.\n");
                if !declared.is_empty() {
                    s.push_str(&fmt!(
                        "The breaks this verifier declares, and which were not run: {}.\n",
                        declared.join(", ")));
                }
                s
            },
        }
    }
}

// ┌───────────────────────────────────────────────────────────────┐
// │ Which breaks to run                                            │
// └───────────────────────────────────────────────────────────────┘

/// The breaks a sequence will attempt, or the sentence saying why it cannot.
///
/// # Arguments
/// * `script` - The resolved verifier.
/// * `want` - What the caller asked for.
pub fn chosen(script: &Script, want: &crate::wire::Breaks) -> Result<Vec<String>, String> {
    match want {
        crate::wire::Breaks::None => Ok(Vec::new()),
        crate::wire::Breaks::All  => Ok(script.breaks.clone()),
        crate::wire::Breaks::One(asked) => {
            if !name_ok(asked) {
                return Err(fmt!(
                    "Refused: '{}' is not a break name. A break is lower-case letters, digits \
                    and underscores, and it must be one this verifier declares.",
                    trim_for_message(asked)));
            }
            // Matched against the file's own declarations, and the string that goes on to
            // the command line is the DECLARED copy, never the caller's.
            match script.breaks.iter().find(|b| b.as_str() == asked.as_str()) {
                Some(b) => Ok(vec![b.clone()]),
                None    => Err(match script.breaks.is_empty() {
                    true	=> fmt!(
                        "Refused: dev/{} declares no breaks at all, so '{}' is not one of \
                        them and there is no way to prove any of its checks. Run it without a \
                        break and treat the result as unproven, or give the verifier a break \
                        mode first.", script.file, trim_for_message(asked)),
                    false	=> fmt!(
                        "Refused: dev/{} does not declare a break called '{}'. The ones it \
                        declares are: {}. A break has to be one the verifier itself knows how \
                        to apply; naming any other string would run the file unchanged and \
                        report a pass that means nothing.",
                        script.file, trim_for_message(asked), script.breaks.join(", ")),
                }),
            }
        },
    }
}

// ┌───────────────────────────────────────────────────────────────┐
// │ The record                                                     │
// └───────────────────────────────────────────────────────────────┘

/// The journal, and whether it is still being written.
///
/// A handle rather than the whole dispatcher, so the sequence can be run from a
/// task of its own without carrying `main.rs`'s furniture into this module.
#[derive(Clone)]
pub struct Ledger {
    jr:    Arc<Mutex<Journal>>,
    sound: Arc<AtomicBool>,
}

impl Ledger {
    /// # Arguments
    /// * `jr` - The record.
    /// * `sound` - Whether it is still being written.
    pub fn new(jr: Arc<Mutex<Journal>>, sound: Arc<AtomicBool>) -> Self {
        Self { jr, sound }
    }

    /// Writes one event, and remembers a failure exactly as the dispatcher does.
    pub fn record(&self, ev: &Event) -> Outcome<()> {
        let done = {
            let mut g = lock_mutex!(self.jr);
            g.append(ev)
        };
        match done {
            Ok(_)  => Ok(()),
            Err(e) => {
                self.sound.store(false, Ordering::SeqCst);
                Err(e)
            },
        }
    }

    /// Is the record still sound?
    pub fn sound(&self) -> bool {
        self.sound.load(Ordering::SeqCst)
    }
}

// ┌───────────────────────────────────────────────────────────────┐
// │ The world a page verifier needs, and who stands it             │
// └───────────────────────────────────────────────────────────────┘
//
// A verifier that drives the page finds its world in the ENVIRONMENT and nowhere
// else: `dev/harness.mjs` reads `DAIMOND_APP`, `DAIMOND_MOCK`, `DAIMOND_MOCK_LOG`
// and `DAIMOND_SCRATCH`, and falls back to world 0 -- `localhost:8777` -- when it
// is handed none.  The hand's environment is Chrome's and carries no `DAIMOND_*`
// at all, so every page verifier a daimon ran through this verb before 2026-09-14
// aimed at whatever happened to be on 8777, which is another lane's world or
// nothing.  Turn 54 spent itself discovering that.
//
// **A daimon cannot stand one itself, and the reason is not an oversight.**  `run`
// is fenced: `listen()` is refused by the seccomp filter, so a server cannot bind;
// `~/.cache` is outside every fence, so the world's pid files could not be written
// where `dev/world.sh` keeps them; and `serve` is a python static server with no
// `/api` proxy and no mock.  There is no sequence of calls from inside the fence
// that reaches a world.
//
// So this verb stands one.  It is already the one thing that runs outside the
// command fence, on the argument that a verifier is the repository's own committed
// code -- and the same argument covers the three files a world is made of, which
// is why [`world_up`] asks about all three and not just the verifier.
//
// **The world number is the hand's, never the model's.**  `dev/world.sh`'s port
// register is the one place a port is claimed, and it exists because a dozen
// callers each chose one after reasoning about the ranges they knew of; on
// 2026-08-17 a lane died `EADDRINUSE` the moment another came up.  The page asks
// for a world or asks for none; which world comes out of the band the register
// reserves, by probing the three ports and taking a lock.  A standing world is
// never adopted: adoption is for two people sharing one, and it is what undid the
// gate of 2026-08-17.

/// The band of world numbers `dev/world.sh`'s register reserves for a daimon.
pub const DAIMON_WORLDS: std::ops::RangeInclusive<u8> = 40..=49;

/// The numbers inside that band nothing may take.
///
/// World 44's mock would be `:9143`, which is `dev/verify_triage.mjs`'s own fixed
/// row.  Both sides refuse honestly if they meet, so what the hole costs is
/// nothing and what it saves is a sequence spent discovering the clash.
pub const DAIMON_WORLDS_HELD_BACK: &[u8] = &[44];

/// Where a stood world keeps its state, under the granted root.
///
/// Inside the tree rather than `~/.cache`, so that the daimon being driven can
/// read `serve.out`, `mock.out` and the pid files with `file_read`: `~/.cache` is
/// outside every fence, and a refusal a daimon cannot read is a refusal it cannot
/// act on.
pub const WORLD_SCRATCH: &str = ".scratch/worlds";

/// How long `dev/world.sh N --up` is given.
pub const WORLD_UP_MS: u64 = 60_000;

/// How long `dev/world.sh N --down` is given.
pub const WORLD_DOWN_MS: u64 = 30_000;

/// The memory ceiling a world, and each run beside it, is held under.
pub const WORLD_MEM: &str = "4G";

/// The slice they share, so one sequence has one ceiling rather than two.
pub const VERIFY_SLICE: &str = "daimond-verify.slice";

/// The three files a world is made of, every one of them run unfenced.
pub const WORLD_PARTS: &[&str] = &["world.sh", "serve.mjs", "mockllm.mjs"];

/// The script that stands a world.
pub const WORLD_SH: &str = "world.sh";

/// The variable `dev/world.sh` reads for where a world's scratch goes.
pub const WORLD_ROOT_VAR: &str = "DAIMOND_WORLD_ROOT";

/// The name that turns the memory ceiling off.
pub const CAP_VAR: &str = "DAIMOND_VERIFY_CAP";

/// The variables `dev/world.sh` HONOURS when a caller has already set them.
///
/// Cleared before `--up`, so the register decides.  The hand's environment is
/// Chrome's and usually carries none of them, but a hand started from a shell
/// inside somebody's world carries all three, and the world it then stood would
/// be that shell's rather than its own.
pub const WORLD_HONOURS: &[&str] = &["DAIMOND_GW_PORT", "DAIMOND_IMAP_PORT", "SMTPD_PORT"];

/// What a sequence's processes are held under.
///
/// A world plus a headless Chromium is 1.5-3 GB, and the hand is Chrome's own
/// child on the owner's desktop rather than a process in the fleet's slice -- so
/// a runaway here takes the machine the owner is sitting at.  Never
/// `claude-rc.slice`: that is the fleet's budget and this is not the fleet.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Cap {
    /// A transient systemd scope with a memory ceiling on it.
    Systemd,
    /// Nothing.  **Said in the report, never silent.**
    None,
}

impl Cap {
    /// What this machine can actually do, asked once per sequence.
    pub fn detect() -> Self {
        if let Ok(v) = std::env::var(CAP_VAR) {
            if v == "none" {
                return Self::None;
            }
        }
        // The session bus is what `--user` needs, and `XDG_RUNTIME_DIR` is how a
        // process finds it. Chrome's environment carries both; a hand started by
        // something else may not.
        match (on_path("systemd-run"), std::env::var("XDG_RUNTIME_DIR")) {
            (Some(_), Ok(d)) if !d.is_empty()	=> Self::Systemd,
            _					=> Self::None,
        }
    }

    /// The phrase the `[world:` line carries.
    pub fn phrase(&self) -> String {
        match self {
            Self::Systemd	=> fmt!("MemoryMax {}", WORLD_MEM),
            Self::None		=> fmt!("uncapped"),
        }
    }

    /// The argument vector with the ceiling in front of it, where there is one.
    ///
    /// `--scope` runs the command as `systemd-run`'s own child rather than
    /// handing it to the manager, so a `setpgid(0, 0)` on `systemd-run` still
    /// yields ONE group holding the world -- or the browser -- and the group kill
    /// still reaches it.
    ///
    /// # Arguments
    /// * `argv` - What to run, program first.
    pub fn wrap(&self, argv: &[String]) -> Vec<String> {
        match self {
            Self::None	=> argv.to_vec(),
            Self::Systemd	=> {
                let mut v = vec![
                    fmt!("systemd-run"),
                    fmt!("--user"),
                    fmt!("--scope"),
                    fmt!("--quiet"),
                    fmt!("-p"),
                    fmt!("MemoryMax={}", WORLD_MEM),
                    fmt!("--slice={}", VERIFY_SLICE),
                    fmt!("--"),
                ];
                v.extend(argv.iter().cloned());
                v
            },
        }
    }
}

/// The program a spawn argument vector names.
fn prog_of(word: &str) -> PathBuf {
    match word.contains('/') {
        true	=> PathBuf::from(word),
        false	=> on_path(word).unwrap_or_else(|| PathBuf::from(word)),
    }
}

/// Every world number the verb may take.
pub fn daimon_worlds() -> Vec<u8> {
    DAIMON_WORLDS.clone().filter(|n| !DAIMON_WORLDS_HELD_BACK.contains(n)).collect()
}

/// A world's three ports: app, mock, gateway.
///
/// Used for the free-probe only.  What `dev/world.sh --up` prints is the truth
/// for everything after it, because the script is where a port is decided.
pub fn world_ports(n: u8) -> (u16, u16, u16) {
    let n = n as u16;
    (8777 + n, 9099 + n, 9700 + n)
}

/// The first world in the band whose three ports are free and which nobody holds.
///
/// Generic over the probe rather than taking a closure object, so the unit test
/// can script "free" without binding anything.
///
/// # Arguments
/// * `free` - Whether a port can be bound.
/// * `taken` - Worlds another daimon on this tree already holds a lock on.
pub fn pick_world<F: Fn(u16) -> bool>(free: F, taken: &[u8]) -> Option<u8> {
    for n in daimon_worlds() {
        if taken.contains(&n) {
            continue;
        }
        let (a, m, g) = world_ports(n);
        if free(a) && free(m) && free(g) {
            return Some(n);
        }
    }
    None
}

/// Can this port be bound right now?
fn port_free(p: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", p)).is_ok()
}

/// Does this verifier drive the page, and so need a world?
///
/// The question is asked of the file rather than of a list, so a verifier written
/// tomorrow is answered without anything being added here.  Importing
/// `dev/harness.mjs` is what makes a verifier a page verifier: 406 of this tree's
/// verifiers do it, and the ones that stand servers of their own --
/// `verify_worldports`, `verify_verifyverb`, the gateway group -- do not.
///
/// # Arguments
/// * `src` - The verifier's source.
pub fn needs_world(src: &str) -> bool {
    for line in src.lines() {
        let t = line.trim_start();
        // A commented import is a file TALKING about the harness, which half the
        // headers in dev/ do.
        if t.starts_with("//") || t.starts_with('*') || t.starts_with("/*") {
            continue;
        }
        if t.contains("from './harness.mjs'") || t.contains("from \"./harness.mjs\"") {
            return true;
        }
    }
    false
}

/// The variables an `--up` printed, from its standard output.
///
/// `export K=V` lines and nothing else: the script writes its own chatter to
/// standard error, and a caller's usual form is `eval "$(… --up)"`, so this reads
/// exactly what a shell would.
///
/// # Arguments
/// * `out` - Everything `--up` printed on standard output.
pub fn parse_env_block(out: &str) -> Vec<(String, String)> {
    let mut v = Vec::new();
    for line in out.lines() {
        let rest = match line.trim().strip_prefix("export ") {
            Some(r) => r,
            None    => continue,
        };
        let eq = match rest.find('=') {
            Some(i) => i,
            None    => continue,
        };
        let (k, val) = (&rest[..eq], &rest[eq + 1..]);
        if k.is_empty() || !k.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_') {
            continue;
        }
        v.push((fmt!("{}", k), fmt!("{}", val)));
    }
    v
}

/// Does this verifier's own header say it needs a gateway that is already up?
///
/// The same rule `dev/run_all.sh`'s `needs_live_gateway` applies, in the same
/// words, because the two are answering one question: a gateway wants the gateway
/// binary, a store and keys, and this verb builds none of them.  Saying so in the
/// report costs a line; not saying it costs a sequence and leaves the daimon
/// reading a 502 as the product.
///
/// A MENTION IS NOT A REQUIREMENT.  Nine headers in this tree say "it does NOT
/// need the gateway on :9002", and the words that make them opposite are what
/// excludes them.
///
/// # Arguments
/// * `src` - The verifier's source.
pub fn wants_live_gateway(src: &str) -> bool {
    // `procLog(` is the helper a verifier that SPAWNS a gateway imports, so a file
    // holding it brings its own and needs nothing standing.
    if src.contains("procLog(") {
        return false;
    }
    let mut header = String::new();
    for line in src.lines() {
        let t = line.trim_start();
        if t.is_empty() {
            continue;
        }
        match t.strip_prefix("//") {
            Some(r) => {
                header.push(' ');
                header.push_str(r.trim_start());
            },
            // The header ends at the first line of code.
            None => break,
        }
    }
    for sentence in header.split(". ") {
        let t = sentence.to_lowercase();
        if !t.contains("gateway") {
            continue;
        }
        if !(t.contains(":9002") || t.contains("daimond_gw_port") || t.contains("dev_insecure")) {
            continue;
        }
        if t.contains("no gateway") || t.contains("not need") || t.contains("free :9002")
            || t.contains("starts its own") || t.contains("start its own") || t.contains("spawns")
        {
            continue;
        }
        return true;
    }
    false
}

/// The one line the report carries about a world that was stood.
///
/// # Arguments
/// * `n` - The world number.
/// * `scratch` - Where its state is, as the daimon would spell the path.
/// * `cap` - What it ran under.
/// * `down` - What the teardown did.
pub fn world_line(n: u8, scratch: &str, cap: Cap, down: &Result<(), String>) -> String {
    let (a, m, g) = world_ports(n);
    let tail = match down {
        Ok(())	=> fmt!("stood for this sequence and torn down (dev/world.sh {} --down exit 0)", n),
        Err(w)	=> fmt!("TEARDOWN FAILED: {}", w),
    };
    fmt!("[world: {} — app :{}, mock :{}, gateway :{} down (/api refuses), scratch {}/w{}, {} — {}]",
        n, a, m, g, scratch, n, cap.phrase(), tail)
}

/// The one line the report carries when no world was stood.
///
/// Two sentences and not one, because the two cases mean opposite things: a
/// verifier that needs none is a run with nothing missing, and a harness importer
/// that was refused one is a run whose every network failure is explained by this
/// line.
///
/// # Arguments
/// * `file` - The verifier's file name.
/// * `asked` - Whether the caller asked for none, rather than the file implying it.
pub fn no_world_line(file: &str, asked: bool) -> String {
    match asked {
        false	=> fmt!(
            "[world: none — dev/{} does not import dev/harness.mjs, so none was stood]", file),
        true	=> fmt!(
            "[world: none (world:false) — dev/{} imports dev/harness.mjs and was given the hand's \
            own environment, which names no world; a connection refused above is that, not the \
            app]", file),
    }
}

/// Which hand ran this, and whether the machine has a newer one installed.
///
/// WRITTEN BECAUSE A REPORT NAMED EVERY OTHER PARTY TO ITS OWN NUMBERS.  It says
/// which world the checks were aimed at, which verifier ran, and which commit the
/// verifier came from -- and said nothing at all about the program that ran them.
/// On 2026-09-14 a `verify` died in 767 ms with no `[world:` line because the page,
/// reloaded inside the extension's grace, was still holding a hand four days old
/// that had never heard of the world code; the report it produced was the older
/// hand's and there was no way to read that off it.
///
/// The crate version is not a build id -- it has been 0.1.0 throughout -- so the
/// hash of the running image is what separates two hands.
pub fn hand_line() -> String {
    let img  = crate::image();
    let sha  = match img.sha.is_empty() {
        true  => fmt!("unreadable"),
        false => fmt!("{}", img.sha),
    };
    let newer = match crate::image_changed() {
        false => fmt!(""),
        true  => fmt!(" -- A NEWER HAND IS INSTALLED at this path and is not the one that ran \
            these checks; reload the page with nothing running to take it"),
    };
    fmt!("[hand: {}/{} at {}{}]", crate::version(), sha, img.path.display(), newer)
}

/// The note a verifier that wants a live gateway gets beside its world line.
pub fn gateway_note(file: &str) -> String {
    fmt!(
        "[dev/{}'s own header asks for a gateway that is ALREADY UP, and a world stood here has \
        none: a gateway wants the gateway binary, a store and keys, which this verb does not \
        build. Read a 502 or a 401 from /api below as that, and not as the product.]", file)
}

/// A world that is up, and what is needed to take it down again.
pub struct WorldUp {
    /// The world number.
    pub n:       u8,
    /// The group `--up` ran in, which the servers it started are in too.
    pub pgid:    u32,
    /// The environment block it printed.
    pub env:     Vec<(String, String)>,
    /// Where the worlds' state lives, absolute.
    pub scratch: PathBuf,
    /// Where it lives as a daimon would spell it, workspace-relative.
    pub rel:     String,
    /// What `runs` lists the group as.
    pub run_id:  String,
}

/// Stands a world down, whatever happens to the task that stood it.
///
/// **The path that survives a cancelled or panicking sequence.**  `conduct` is
/// spawned as a task and is never aborted today, but a panic inside it -- or a
/// `JoinHandle::abort` added later -- would otherwise leave a dev server and a
/// mock holding two ports with nothing on the machine able to name them.  The
/// ordinary path calls [`world_down`] and then [`WorldGuard::disarm`], so this
/// runs only where nothing else did.
pub struct WorldGuard {
    root:    PathBuf,
    scratch: PathBuf,
    n:       u8,
    pgid:    u32,
    armed:   bool,
}

impl WorldGuard {
    /// # Arguments
    /// * `root` - The granted root.
    /// * `up` - The world that is up.
    pub fn arm(root: &Path, up: &WorldUp) -> Self {
        Self {
            root:    root.to_path_buf(),
            scratch: up.scratch.clone(),
            n:       up.n,
            pgid:    up.pgid,
            armed:   true,
        }
    }

    /// The world has been taken down by the ordinary path.
    pub fn disarm(&mut self) {
        self.armed = false;
    }

    /// Is it still going to fire?
    pub fn armed(&self) -> bool {
        self.armed
    }
}

impl Drop for WorldGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        // Blocking, because a `Drop` cannot await. The script's own teardown first,
        // since it kills by pid file and verifies the ports are free; the group kill
        // after it, for whatever the script could not reach.
        let sh = self.root.join(DEV_DIR).join(WORLD_SH);
        let _ = std::process::Command::new("bash")
            .arg(&sh)
            .arg(fmt!("{}", self.n))
            .arg("--down")
            .current_dir(&self.root)
            .env(WORLD_ROOT_VAR, &self.scratch)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        #[cfg(unix)]
        if self.pgid != 0 {
            if let Some(p) = rustix::process::Pid::from_raw(self.pgid as i32) {
                let _ = rustix::process::kill_process_group(p, rustix::process::Signal::KILL);
            }
        }
        let _ = std::fs::remove_file(self.scratch.join(fmt!("w{}.lock", self.n)));
    }
}

// ┌───────────────────────────────────────────────────────────────┐
// │ Running the sequence                                           │
// └───────────────────────────────────────────────────────────────┘

/// Everything one sequence needs.
pub struct Job {
    /// The caller's identifier, echoed on every response.
    pub id:     String,
    /// The granted root, which is where the verifier runs.
    pub root:   PathBuf,
    /// The verifier.
    pub script: Script,
    /// The breaks to attempt, already checked against the file's declarations.
    pub breaks: Vec<String>,
    /// Node, found on the hand's own `PATH`.
    pub node:   PathBuf,
    /// The whole sequence's wall-clock budget.
    pub budget: Duration,
    /// The record.
    pub ledger: Ledger,
    /// Whether a dev world is stood for this sequence.
    pub world:  World,
    /// The registry, so a stood world is listed by `runs` and killed by `Bye`.
    ///
    /// `None` in the unit tests, which drive this module's own public way in
    /// rather than the dispatcher's furniture.
    pub runner: Option<crate::exec::Runner>,
    /// What the world and each run are held under, decided once per sequence.
    pub cap:    Cap,
}

/// The argument vector one run takes.
///
/// Three elements at most, and every one of them is either a constant of this
/// program, a path built from a directory entry, or a break name parsed out of
/// the verifier's own source.  **There is no shell**: this vector is handed to
/// `execve` through [`Command`], so a semicolon or a `$(…)` in any element would
/// be an argument and not a command.  A model's string is not in it at all.
///
/// # Arguments
/// * `job` - The sequence.
/// * `brk` - The break, or `None` for the clean run.
pub fn argv_for(job: &Job, brk: Option<&str>) -> Vec<String> {
    let mut v = vec![
        fmt!("{}", job.node.display()),
        fmt!("{}", job.script.path.display()),
    ];
    if let Some(b) = brk {
        v.push(fmt!("--break"));
        v.push(fmt!("{}", b));
    }
    v
}

/// The environment `dev/world.sh` and every verifier run beside it is given.
///
/// The hand's own, with the seat taken out, the unattended mark put in, and the
/// three variables `world.sh` HONOURS removed -- so the register decides the
/// world's ports rather than whatever shell the hand was started from.
fn world_env(scratch: &Path) -> BTreeMap<String, String> {
    let mut env = unattended_env(&own_env());
    for k in WORLD_HONOURS {
        env.remove(*k);
    }
    env.insert(fmt!("{}", WORLD_ROOT_VAR), fmt!("{}", scratch.display()));
    env
}

/// Stands a world for this sequence, or says in one sentence why it could not.
///
/// **Every file it runs is asked whose it is first.**  A world is `world.sh`,
/// `serve.mjs` and `mockllm.mjs`, all three of them run with no fence on them --
/// and a daimon may `file_write` any of them.  The rule that guards the verifier
/// guards what the verifier's world is made of, or the gate is a gate with a door
/// beside it.
///
/// # Arguments
/// * `job` - The sequence.
/// * `tx` - Where [`Resp::Started`] goes, so the page's grace is met before the
///   identity probes run.
async fn world_up(job: &Job, tx: &Sender<Resp>) -> Result<WorldUp, String> {
    for part in WORLD_PARTS {
        let prov = provenance(&job.root, part);
        if !prov.committed() {
            return Err(fmt!(
                "dev/{} is {}. A world is made of these three files and every one of them runs \
                OUTSIDE the command fence, exactly as the verifier does -- so the same rule holds \
                for them. Commit it and ask again.", part, prov.phrase()));
        }
    }

    let scratch = job.root.join(WORLD_SCRATCH);
    if let Err(e) = std::fs::create_dir_all(&scratch) {
        return Err(fmt!("'{}' could not be made ({})", scratch.display(), e));
    }

    // A lock file per world, taken with O_CREAT|O_EXCL, so two daimons sharing one
    // tree take two worlds. Across trees it is the identity check inside `--up` that
    // refuses, and the loop below then tries the next number.
    let mut taken: Vec<u8> = Vec::new();
    for n in daimon_worlds() {
        if scratch.join(fmt!("w{}.lock", n)).exists() {
            taken.push(n);
        }
    }
    let n = match pick_world(port_free, &taken) {
        Some(n) => n,
        None    => {
            let band = daimon_worlds();
            let (lo, hi) = (band.first().copied().unwrap_or(0), band.last().copied().unwrap_or(0));
            return Err(fmt!(
                "every daimon world {}..{} has a port held or a lock in {}. `dev/world.sh {} \
                --status` (and so on) says who holds each", lo, hi, WORLD_SCRATCH, lo));
        },
    };
    let lock = scratch.join(fmt!("w{}.lock", n));
    if let Err(e) = std::fs::OpenOptions::new().write(true).create_new(true).open(&lock) {
        return Err(fmt!("world {}'s lock '{}' could not be taken ({})", n, lock.display(), e));
    }

    let argv = job.cap.wrap(&vec![
        fmt!("bash"),
        fmt!("{}/{}", DEV_DIR, WORLD_SH),
        fmt!("{}", n),
        fmt!("--up"),
    ]);
    // Recorded before the process exists, with the REAL argument vector and the
    // mechanisms that were actually in force -- `fence:none`, because this is the
    // verb that runs the repository's own code outside the fence on purpose, and a
    // record that hid that would be worse than no record at all.
    if !job.ledger.sound() {
        let _ = std::fs::remove_file(&lock);
        return Err(fmt!("the hand's journal cannot be written"));
    }
    let ev = Event::from_req(&Req::Exec {
        id:         fmt!("{}#world", job.id),
        argv:       argv.clone(),
        cwd:        fmt!("{}", job.root.display()),
        env:        vec![(fmt!("{}", WORLD_ROOT_VAR), fmt!("{}", scratch.display()))],
        stdin:      None,
        timeout_ms: WORLD_UP_MS,
        capture:    Capture::Both,
        fence:      FenceSpec {
            rw:   vec![fmt!("{}", job.root.display())],
            ro:   Vec::new(),
            deny: Vec::new(),
            net:  true,
        },
        toolkits:   Vec::new(),
    }, &[
        fmt!("fence:none"),
        fmt!("verify:world"),
        fmt!("mem:{}", job.cap.phrase()),
        fmt!("net:open"),
    ]);
    if let Some(ev) = ev {
        if let Err(e) = job.ledger.record(&ev) {
            let _ = std::fs::remove_file(&lock);
            return Err(fmt!("it could not be written to the journal ({})",
                e.msgs().join(" ")));
        }
    }

    let mut cmd = Command::new(prog_of(&argv[0]));
    for a in argv.iter().skip(1) {
        cmd.arg(a);
    }
    cmd.current_dir(&job.root);
    cmd.env_clear();
    cmd.envs(world_env(&scratch));
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.kill_on_drop(true);
    // Its own group, so the dev server and the mock `--up` leaves behind are
    // reachable by one number afterwards -- which is what makes them stoppable
    // through `runs` and what `Bye` kills.
    #[cfg(unix)]
    cmd.process_group(0);
    let child = match cmd.spawn() {
        Ok(c)  => c,
        Err(e) => {
            let _ = std::fs::remove_file(&lock);
            return Err(fmt!("dev/world.sh could not be started ({})", e));
        },
    };
    let pgid = child.id().unwrap_or(0);
    // HERE, and not after the identity probes. The page arms a 30-second clock at
    // the request and stops it at `Started`; `--up` waits for two ports to bind and
    // then asks both servers who they are, which is most of that clock on a cold
    // machine.
    let _ = tx.send(Resp::Started {
        id:  fmt!("{}", job.id),
        pid: pgid,
    }).await;
    let out = match tokio::time::timeout(
        Duration::from_millis(WORLD_UP_MS), child.wait_with_output()).await
    {
        Ok(Ok(o))	=> o,
        Ok(Err(e))	=> {
            let _ = std::fs::remove_file(&lock);
            return Err(fmt!("dev/world.sh {} --up could not be waited on ({})", n, e));
        },
        Err(_)		=> {
            // The group, not the child: `--up` starts two servers in the background
            // and a timeout that killed only the script would leave both.
            let _ = crate::exec::signal_group(pgid, Sig::Kill).await;
            let _ = std::fs::remove_file(&lock);
            return Err(fmt!(
                "dev/world.sh {} --up did not finish within {} ms and its group was killed",
                n, WORLD_UP_MS));
        },
    };
    let err = String::from_utf8_lossy(&out.stderr).to_string();
    if !out.status.success() {
        let _ = crate::exec::signal_group(pgid, Sig::Kill).await;
        let _ = std::fs::remove_file(&lock);
        let first = err.lines()
            .map(|l| l.trim())
            .find(|l| !l.is_empty())
            .unwrap_or("it said nothing");
        return Err(fmt!("world {} (app :{}, mock :{}): {}",
            n, world_ports(n).0, world_ports(n).1, first));
    }
    let env = parse_env_block(&String::from_utf8_lossy(&out.stdout));
    if env.is_empty() {
        let _ = crate::exec::signal_group(pgid, Sig::Kill).await;
        let _ = std::fs::remove_file(&lock);
        return Err(fmt!(
            "world {} came up and printed no environment block, so there is nothing to hand the \
            verifier", n));
    }
    let up = WorldUp {
        n,
        pgid,
        env,
        rel:     fmt!("{}", WORLD_SCRATCH),
        scratch,
        run_id:  fmt!("{}-world", job.id),
    };
    // From this moment the world is a standing group the registry knows about: it
    // is what `runs` lists, what the page's Stop can reach, and what `Bye` kills
    // when the tab closes.
    if let Some(r) = &job.runner {
        let _ = r.adopt(up.run_id.clone(), pgid, fmt!(
            "dev/world.sh {} --up, the world dev/{} is running in", n, job.script.file));
    }
    Ok(up)
}

/// Takes the world down, and says what is still held if it could not.
///
/// # Arguments
/// * `job` - The sequence.
/// * `up` - The world.
/// * `clean` - Whether the sequence's verdict was clean, which decides whether the
///   world's `serve.out`, `mock.out` and browser profiles are kept for reading.
async fn world_down(job: &Job, up: &WorldUp, clean: bool) -> Result<(), String> {
    let argv = vec![
        fmt!("bash"),
        fmt!("{}/{}", DEV_DIR, WORLD_SH),
        fmt!("{}", up.n),
        fmt!("--down"),
    ];
    let mut cmd = Command::new(prog_of(&argv[0]));
    for a in argv.iter().skip(1) {
        cmd.arg(a);
    }
    cmd.current_dir(&job.root);
    cmd.env_clear();
    cmd.envs(world_env(&up.scratch));
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.kill_on_drop(true);
    #[cfg(unix)]
    cmd.process_group(0);
    let said = match cmd.spawn() {
        Ok(c) => match tokio::time::timeout(
            Duration::from_millis(WORLD_DOWN_MS), c.wait_with_output()).await
        {
            Ok(Ok(o))	=> match o.status.success() {
                true	=> None,
                false	=> Some(fmt!("dev/world.sh --down exited {}",
                    match o.status.code() {
                        Some(c) => fmt!("{}", c),
                        None    => fmt!("on a signal"),
                    })),
            },
            Ok(Err(e))	=> Some(fmt!("dev/world.sh --down could not be waited on ({})", e)),
            Err(_)		=> Some(fmt!("dev/world.sh --down did not finish within {} ms",
                WORLD_DOWN_MS)),
        },
        Err(e) => Some(fmt!("dev/world.sh --down could not be started ({})", e)),
    };
    let ended = Event::Ended {
        id:        fmt!("{}#world", job.id),
        exit:      match said { None => 0, Some(_) => 1 },
        timed_out: false,
        killed:    said.is_some(),
        out_bytes: 0,
        err_bytes: 0,
    };
    if let Err(e) = job.ledger.record(&ended) {
        eprintln!("daimond-hand: a world's teardown was not journalled: {}", e);
    }
    let why = match said {
        None	=> {
            if let Some(r) = &job.runner {
                let _ = r.forget(&up.run_id);
            }
            let _ = std::fs::remove_file(up.scratch.join(fmt!("w{}.lock", up.n)));
            // A red sequence keeps its serve.out, mock.out and profiles, because
            // those are what the daimon reads next. A clean one leaves nothing:
            // a browser profile is tens of megabytes and this directory is inside
            // the repository.
            if clean {
                let _ = std::fs::remove_dir_all(up.scratch.join(fmt!("w{}", up.n)));
            }
            return Ok(());
        },
        Some(w)	=> w,
    };
    // The script would not or could not. The group is what is left to try, and then
    // the ports are asked rather than the bookkeeping believed.
    let _ = crate::exec::signal_group(up.pgid, Sig::Kill).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let (a, m, g) = world_ports(up.n);
    let mut held = Vec::new();
    for p in [a, m, g] {
        if !port_free(p) {
            held.push(fmt!(":{}", p));
        }
    }
    if held.is_empty() {
        if let Some(r) = &job.runner {
            let _ = r.forget(&up.run_id);
        }
        let _ = std::fs::remove_file(up.scratch.join(fmt!("w{}.lock", up.n)));
        return Err(fmt!("{}, and the group was killed instead; the three ports are free", why));
    }
    Err(fmt!(
        "{}, {} still held after the group was killed; it is listed by runs as '{}' and can be \
        stopped there", why, held.join(" "), up.run_id))
}

/// Reads a stream to its end, keeping at most `cap` bytes.
///
/// The rest is drained rather than left, because a child whose pipe is full
/// stops running and a run that never ends is a budget spent on nothing.
async fn drain<R>(mut r: R, cap: usize) -> (Vec<u8>, u64)
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut kept  = Vec::new();
    let mut total = 0u64;
    let mut buf   = [0u8; 32 * 1024];
    loop {
        let n = match r.read(&mut buf).await {
            Ok(0)  => break,
            Ok(n)  => n,
            Err(_) => break,
        };
        total = total.saturating_add(n as u64);
        if kept.len() < cap {
            let room = cap - kept.len();
            let take = room.min(n);
            kept.extend_from_slice(&buf[..take]);
        }
    }
    (kept, total)
}

/// Runs the verifier once, clean or under one break.
///
/// # Arguments
/// * `job` - The sequence.
/// * `brk` - The break, or `None`.
/// * `left` - What is left of the budget.
/// * `announce` - Where to send [`Resp::Started`], for the first run only.  `None`
///   where a world was stood, because the world's own spawn already sent it.
/// * `world` - The environment block the world printed, laid over the hand's own.
async fn once(
    job:      &Job,
    brk:      Option<&str>,
    left:     Duration,
    announce: Option<&Sender<Resp>>,
    world:    &[(String, String)],
)
    -> Result<Pass, String>
{
    let label = match brk {
        Some(b) => fmt!("{}", b),
        None    => fmt!("clean"),
    };
    let argv = job.cap.wrap(&argv_for(job, brk));
    // The record is written before the process exists, exactly as a command's is, and with the
    // REAL argument vector -- so a reader of the journal sees the node invocation rather than a
    // verb they would have to trust this module's account of.
    if !job.ledger.sound() {
        return Err(fmt!("the hand's journal cannot be written"));
    }
    let ev = Event::from_req(&Req::Exec {
        id:         fmt!("{}#{}", job.id, label),
        argv:       argv.clone(),
        cwd:        fmt!("{}", job.root.display()),
        env:        Vec::new(),
        stdin:      None,
        timeout_ms: left.as_millis() as u64,
        capture:    Capture::Both,
        // What the process may touch, as intent. `mechs` below is what was actually in force,
        // and it says `fence:none` -- because this verb runs a TRACKED SCRIPT outside the
        // command fence on purpose, and a record that hid that would be worse than no record.
        fence:      FenceSpec {
            rw:   vec![fmt!("{}", job.root.display())],
            ro:   Vec::new(),
            deny: Vec::new(),
            net:  true,
        },
        toolkits:   Vec::new(),
    }, &[
        fmt!("fence:none"),
        fmt!("verify:tracked-script"),
        fmt!("mem:{}", job.cap.phrase()),
        fmt!("net:open"),
    ]);
    if let Some(ev) = ev {
        if let Err(e) = job.ledger.record(&ev) {
            return Err(fmt!("it could not be written to the journal ({})", e.msgs().join(" ")));
        }
    }

    // Asked again, as late as anything on this side can be. The sequence has been
    // running for minutes by the time a late break starts, and a command an earlier turn
    // left in the background can rewrite a file in that time.
    if let Some(no) = unfenced_refusal(&job.root, &job.script.file) {
        // The sentence opens with "Refused:" and every caller of `once` puts its own
        // word in front of what comes back from here, so the word is said once.
        let said = match no.strip_prefix("Refused: ") {
            Some(t) => t,
            None    => no.as_str(),
        };
        return Err(fmt!(
            "it stopped being the commit's while the sequence was running. {}", said));
    }

    let started = std::time::Instant::now();
    let mut cmd = Command::new(prog_of(&argv[0]));
    for a in argv.iter().skip(1) {
        cmd.arg(a);
    }
    cmd.current_dir(&job.root);
    // Cleared and rebuilt rather than trimmed, because `Command` has no way to
    // ask what it inherited: the map is the hand's own environment with the seat
    // taken out and the mark put in, which is the same thing said once.
    cmd.env_clear();
    cmd.envs(unattended_env(&own_env()));
    // And the world's block over the top of it. LAST, so that a `DAIMOND_PORT` the
    // hand happened to inherit cannot outrank the world this sequence stood: the
    // harness reads these four names and nothing else, and the fault this verb was
    // written for is a verifier aimed at a world it was never given.
    for (k, v) in world.iter() {
        cmd.env(k, v);
    }
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.kill_on_drop(true);
    // Its own group. `kill_on_drop` reaches the node process and nothing it
    // started, and a browser verifier's whole job is to start a browser -- so a
    // budget spent used to leave a Chromium behind, which the world made visible by
    // leaving it holding the world's page open.
    #[cfg(unix)]
    cmd.process_group(0);
    let mut child = match cmd.spawn() {
        Ok(c)  => c,
        Err(e) => return Err(fmt!("node could not be started ({})", e)),
    };
    let child_pid = child.id().unwrap_or(0);
    // The page starts a 30-second clock at the request and stops it at `Started`, so the
    // first child's real process id goes out the moment there is one.
    if let Some(tx) = announce {
        let _ = tx.send(Resp::Started {
            id:  fmt!("{}", job.id),
            pid: child.id().unwrap_or(0),
        }).await;
    }
    let out_pipe = child.stdout.take();
    let err_pipe = child.stderr.take();
    // BOTH STREAMS AT ONCE, and it has to be. A pipe holds 64 KB; a child that fills stderr
    // while this side is still waiting for stdout to reach its end stops running, and the
    // deadlock lasts until the budget kills it. Every verifier in dev/ writes to both.
    let reading = async {
        let o = async {
            match out_pipe {
                Some(p) => drain(p, OUT_MAX).await,
                None    => (Vec::new(), 0),
            }
        };
        let e = async {
            match err_pipe {
                Some(p) => drain(p, OUT_MAX).await,
                None    => (Vec::new(), 0),
            }
        };
        tokio::join!(o, e)
    };
    let waiting = async {
        let status = child.wait().await;
        status
    };
    let both = async { tokio::join!(waiting, reading) };
    let (status, (out, err), timed) = match tokio::time::timeout(left, both).await {
        Ok((s, pair))	=> (s, pair, false),
        Err(_)		=> {
            // The budget is up, and the GROUP goes rather than the child: the browser a
            // verifier started is in it, and `kill_on_drop` would have reached only node.
            let _ = crate::exec::signal_group(child_pid, Sig::Kill).await;
            (Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "budget spent")),
             ((Vec::new(), 0u64), (Vec::new(), 0u64)),
             true)
        },
    };
    let exit = match &status {
        Ok(s)  => s.code().unwrap_or(-1),
        Err(_) => -1,
    };
    let text = fmt!("{}{}",
        String::from_utf8_lossy(&out.0),
        String::from_utf8_lossy(&err.0));
    let checks = parse_checks(&text);
    let mut fails: Vec<String> = text.lines()
        .filter(|l| l.trim_start().starts_with("FAIL "))
        .map(|l| fmt!("{}", l.trim_end()))
        .collect();
    fails.truncate(12);
    let ms = started.elapsed().as_millis() as u64;
    // The ending is recorded as a command's is.
    let ended = Event::Ended {
        id:        fmt!("{}#{}", job.id, label),
        exit,
        timed_out: timed,
        killed:    false,
        out_bytes: out.1,
        err_bytes: err.1,
    };
    if let Err(e) = job.ledger.record(&ended) {
        eprintln!("daimond-hand: a verify run's ending was not journalled: {}", e);
    }
    if timed {
        return Err(fmt!("it ran past the budget and was killed"));
    }
    // Kept ONLY where nothing was measured, and bounded: this is the one case where the script's
    // own words are the whole of the evidence, and every other case has checks to report instead.
    let tail = match checks.is_empty() {
        true  => last_lines(&text, DEAD_TAIL_LINES),
        false => String::new(),
    };
    Ok(Pass {
        label,
        exit,
        timed,
        norm: normalise(&text),
        checks,
        fails,
        tail,
        ms,
    })
}

/// Runs the clean pass and every chosen break, and answers with all three
/// numbers.
///
/// **There is no path out of this function that yields the passing count
/// alone.**  It returns a [`Verdict`], whose arms each carry the bad half, and
/// the report below is composed from that one value.
///
/// # Arguments
/// * `job` - The sequence.
/// * `tx` - Where progress and the report are sent.
pub async fn conduct(job: Job, tx: Sender<Resp>) -> Outcome<()> {
    // BEFORE THE JOURNAL AND BEFORE THE FIRST PROCESS. `REVIEW.md` §1.21: everything
    // below this line runs a script with no fence on it at all, and the only thing that
    // makes that defensible is that the script is the commit's. Asked here rather than
    // in `main.rs` because this function is the crate's public way in, and a gate in the
    // dispatcher is a gate the reproduction walked straight past.
    if let Some(no) = unfenced_refusal(&job.root, &job.script.file) {
        let _ = tx.send(Resp::Refused { id: fmt!("{}", job.id), reason: no }).await;
        return Ok(());
    }

    // Does this verifier drive the page? The file is asked rather than a list, so a
    // verifier written tomorrow is answered without a row being added anywhere.
    let src     = std::fs::read_to_string(&job.script.path).unwrap_or_default();
    let imports = needs_world(&src);
    let stand   = match job.world {
        World::Stand	=> true,
        World::None	=> false,
        World::Infer	=> imports,
    };

    let mut guard: Option<WorldGuard> = None;
    let mut up:    Option<WorldUp>    = None;
    if stand {
        match world_up(&job, &tx).await {
            Ok(u) => {
                // Armed before anything can panic between here and the teardown.
                guard = Some(WorldGuard::arm(&job.root, &u));
                up    = Some(u);
            },
            // NOTHING RAN, so there is nothing to measure and nothing to report. A
            // sequence that went ahead without a world would aim every check at
            // :8777, which is another lane's world or nothing at all -- and would
            // come back with a passing count taken from somebody else's app.
            Err(w) => {
                let _ = tx.send(Resp::Refused {
                    id:     fmt!("{}", job.id),
                    reason: fmt!(
                        "Refused: no world could be stood for dev/{} — {}. Nothing was run.",
                        job.script.file, w),
                }).await;
                return Ok(());
            },
        }
    }

    let env: Vec<(String, String)> = match &up {
        Some(u) => u.env.clone(),
        None    => Vec::new(),
    };
    let began       = std::time::SystemTime::now();
    let mut seq_err = 0u64;
    // BOXED, so the whole sequence's state lives on the heap. `conduct` holds
    // `measure` holds `once` holds `drain`'s two 32 KB buffers, and a debug build of
    // that chain overflows a tokio worker's stack -- which is not a hang and not a
    // crash the page can see: the worker aborts, the hand dies mid-sequence, and the
    // page waits for an ending that is never coming. The unit tests box `conduct`
    // already and so could not have found it; `dev/verify_verifyverb.mjs` drives the
    // real binary and did, with fourteen checks red at once.
    let measured    = Box::pin(measure(&job, &tx, &env, up.is_some(), &mut seq_err)).await;

    // THE WORLD GOES DOWN BEFORE THE REPORT IS COMPOSED, so the report can carry what
    // the teardown did. Every way out of `measure` -- a clean run that never happened,
    // a budget spent, a verifier edited mid-sequence -- comes back through this line.
    let clean = matches!(&measured, Ok((_, v)) if v.exit() == EXIT_PROVED);
    let world_note = match &up {
        Some(u) => {
            let down = world_down(&job, u, clean).await;
            if let Some(g) = guard.as_mut() {
                g.disarm();
            }
            let mut line = world_line(u.n, &u.rel, job.cap, &down);
            if wants_live_gateway(&src) {
                line.push('\n');
                line.push_str(&gateway_note(&job.script.file));
            }
            line
        },
        None => no_world_line(&job.script.file, imports),
    };
    drop(guard);

    let (passes, verdict) = match measured {
        Ok(pair) => pair,
        Err(w)   => {
            let _ = tx.send(Resp::Refused {
                id:     fmt!("{}", job.id),
                reason: fmt!(
                    "Refused: the clean run of dev/{} did not happen -- {}. Nothing was \
                    measured, so there is no result to report.\n{}",
                    job.script.file, w, world_note),
            }).await;
            return Ok(());
        },
    };

    let shots = shots_since(&job.root, began);
    let text  = report(&job.script, &passes, &verdict, &shots, &world_note);
    let bytes = text.len() as u64;
    let _ = tx.send(Resp::Chunk {
        id:     fmt!("{}", job.id),
        stream: Stream::Out,
        seq:    0,
        data:   text,
    }).await;
    let _ = tx.send(Resp::Ended {
        id:        fmt!("{}", job.id),
        exit:      verdict.exit(),
        timed_out: false,
        killed:    false,
        out_bytes: bytes,
        err_bytes: seq_err,
    }).await;
    Ok(())
}

/// The clean run and every chosen break, between the world coming up and going down.
///
/// **Split out of [`conduct`] so that there is ONE way back.** A world that is up has
/// to come down whatever happens next -- a clean run that never started, a budget
/// spent, a verifier rewritten mid-sequence -- and the shape that guarantees it is a
/// single call site rather than a teardown repeated before every `return`.
///
/// # Arguments
/// * `job` - The sequence.
/// * `tx` - Where progress notes go.
/// * `env` - The world's environment block, empty where none was stood.
/// * `stood` - Whether a world was stood, which decides who sent [`Resp::Started`].
/// * `seq_err` - How many progress notes have been sent, carried out for the ending.
async fn measure(
    job:     &Job,
    tx:      &Sender<Resp>,
    env:     &[(String, String)],
    stood:   bool,
    seq_err: &mut u64,
)
    -> Result<(Vec<(Pass, Option<Bite>)>, Verdict), String>
{
    let mut left = job.budget;

    let say_err = |line: String, seq: &mut u64| {
        let n = *seq;
        *seq = seq.saturating_add(1);
        Resp::Chunk {
            id:     fmt!("{}", job.id),
            stream: Stream::Err,
            seq:    n,
            data:   line,
        }
    };

    // The clean run first, always. Its checks are the baseline every break is compared with,
    // so a sequence that could not make it has nothing to compare anything against.
    let note = say_err(fmt!("  ..   clean run of dev/{}\n", job.script.file), seq_err);
    let _ = tx.send(note).await;
    // `Started` is sent once. Where a world was stood, the world's own spawn sent it --
    // which is the whole point of sending it there, since `--up` waits for two ports to
    // bind and then asks both servers who they are, and the page's grace is 30 seconds.
    let announce = match stood {
        true	=> None,
        false	=> Some(tx),
    };
    let clean = match Box::pin(once(job, None, left, announce, env)).await {
        Ok(p)  => p,
        Err(w) => return Err(w),
    };
    left = left.saturating_sub(Duration::from_millis(clean.ms));

    let mut passes: Vec<(Pass, Option<Bite>)> = vec![(clean.clone(), None)];
    let mut red:   Vec<String> = Vec::new();
    let mut dead:  Vec<String> = Vec::new();
    let mut unrun: Vec<String> = Vec::new();

    for b in job.breaks.iter() {
        if left < Duration::from_millis(RUN_FLOOR_MS) {
            unrun.push(fmt!("{}", b));
            continue;
        }
        let note = say_err(fmt!("  ..   --break {}\n", b), seq_err);
        let _ = tx.send(note).await;
        match Box::pin(once(job, Some(b.as_str()), left, None, env)).await {
            Ok(p) => {
                left = left.saturating_sub(Duration::from_millis(p.ms));
                let what = bite(&clean, &p);
                match &what {
                    Bite::Red { .. }	=> red.push(fmt!("{}", b)),
                    Bite::None { .. }	=> dead.push(fmt!("{}", b)),
                    Bite::Unrun { .. }	=> unrun.push(fmt!("{}", b)),
                }
                passes.push((p, Some(what)));
            },
            Err(w) => {
                unrun.push(fmt!("{}", b));
                passes.push((Pass {
                    label:  fmt!("{}", b),
                    exit:   -1,
                    timed:  false,
                    checks: Checks::new(),
                    norm:   String::new(),
                    fails:  Vec::new(),
                    tail:   String::new(),
                    ms:     0,
                }, Some(Bite::Unrun { why: w })));
            },
        }
    }

    // The one place a verdict is made, and it is made from what actually ran.
    let verdict = match job.breaks.is_empty() {
        true	=> Verdict::Unproven {
            passed:   clean.passed(),
            failed:   clean.failed(),
            declared: job.script.breaks.clone(),
        },
        false	=> Verdict::Proven {
            passed: clean.passed(),
            failed: clean.failed(),
            red,
            dead,
            unrun,
        },
    };
    Ok((passes, verdict))
}

/// The whole report, which is the only thing the model reads.
///
/// # Arguments
/// * `script` - The verifier.
/// * `passes` - The clean run first, then each break with what it did.
/// * `verdict` - What the sequence proved.
/// * `shots` - Pictures this sequence wrote, workspace-relative.
/// * `world` - The `[world: …]` line, which says which dev world this ran in or
///   why it ran in none.
pub fn report(
    script:  &Script,
    passes:  &[(Pass, Option<Bite>)],
    verdict: &Verdict,
    shots:   &[String],
    world:   &str,
)
    -> String
{
    let mut s = String::new();
    s.push_str(&fmt!("dev/{} — {} run{}, {}\n",
        script.file,
        passes.len(),
        match passes.len() { 1 => "", _ => "s" },
        script.prov.phrase()));
    s.push_str(
        "Run OUTSIDE the command fence, because these bytes are the commit's rather than a \
        command anybody's model wrote -- that was checked against the commit before each run, \
        and a verifier that differs from it is refused rather than reported. It reaches this \
        machine as any script you run yourself would.\n");
    // Early, and above the runs, so that the trimming at the end of this function
    // cannot take it: a report whose numbers came from a world the reader does not
    // know about is a report about somebody else's app.
    s.push_str(world);
    s.push('\n');
    // Beside the world, and above the runs for the same reason: a reader who cannot say
    // WHICH hand produced these numbers cannot tell a defect in the app from a defect
    // fixed in a hand this machine installed and this process never took.
    s.push_str(&hand_line());
    s.push_str("\n\n");
    for (p, what) in passes.iter() {
        match what {
            None => {
                s.push_str(&fmt!("CLEAN            {} passed, {} failed, exit {}, {} ms\n",
                    p.passed(), p.failed(), p.exit, p.ms));
                for f in p.fails.iter() {
                    s.push_str(&fmt!("     {}\n", f));
                }
                // A clean run that measured nothing did not pass and did not fail: it DIED, and
                // its own last words are the only thing that says why.  Carried verbatim, because
                // every summary of a stack trace is a summary of something this side did not
                // understand.
                if !p.tail.is_empty() {
                    s.push_str("     -- it printed no check at all; its last lines, verbatim:\n");
                    for l in p.tail.lines() {
                        s.push_str(&fmt!("     | {}\n", l));
                    }
                }
            },
            Some(Bite::Red { names }) => {
                s.push_str(&fmt!(
                    "BREAK {:<10} {} passed, {} failed, exit {}, {} ms   RED: {} went red\n",
                    p.label, p.passed(), p.failed(), p.exit, p.ms, names.join("; ")));
            },
            Some(Bite::None { same, vanished }) => {
                let how = match (*same, *vanished) {
                    (true, _)	=> fmt!("its output was the clean run's, its own banner aside"),
                    (_, 0)	=> fmt!("the output moved, and no check that passed clean failed"),
                    (_, n)	=> fmt!(
                        "no check went red; {} checks that passed clean did not appear at all, \
                        so it may have aborted rather than measured", n),
                };
                s.push_str(&fmt!(
                    "BREAK {:<10} {} passed, {} failed, exit {}, {} ms   PROVED NOTHING: {}\n",
                    p.label, p.passed(), p.failed(), p.exit, p.ms, how));
            },
            Some(Bite::Unrun { why }) => {
                s.push_str(&fmt!(
                    "BREAK {:<10} NEVER RAN: {}\n", p.label, why));
            },
        }
    }
    if !shots.is_empty() {
        s.push_str(&fmt!("\n{} pictures were written; read one with file_read and \"as\":\"image\", \
            or hand the path to a worker who can see:\n", shots.len()));
        for p in shots.iter() {
            s.push_str(&fmt!("     {}\n", p));
        }
    }
    s.push('\n');
    s.push_str(&verdict.advice());
    s.push('\n');
    s.push_str(&verdict.trailer());
    s.push('\n');
    if s.len() > REPORT_MAX {
        // The trailer is the one line that must survive, since it carries all three numbers
        // and the far end refuses a result without it.
        let tail = fmt!("\n[the report was cut here]\n{}\n", verdict.trailer());
        let room = REPORT_MAX.saturating_sub(tail.len());
        let mut cut = room;
        while cut > 0 && !s.is_char_boundary(cut) {
            cut -= 1;
        }
        s.truncate(cut);
        s.push_str(&tail);
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::wire::Breaks;

    use std::fs;

    /// Where the fixtures go.
    ///
    /// Under the home cache and never `/tmp`: that is a tmpfs here, its pages are
    /// charged to whoever wrote them, and filling it has taken this machine down
    /// before.
    ///
    /// # Arguments
    /// * `name` - Unique to the calling test, so tests do not share state.
    fn tree(name: &str) -> Outcome<PathBuf> {
        let home = match std::env::var("HOME") {
            Ok(h)  => h,
            Err(e) => return Err(err!(
                "The verify tests need HOME to know where to put fixtures: {}", e;
                Test, Configuration)),
        };
        let root = PathBuf::from(home).join(".cache/daimond-hand-verify-tests").join(name);
        if root.exists() {
            res!(fs::remove_dir_all(&root).map_err(|e| err!(e, "clearing {:?}", root; Test, IO)));
        }
        res!(fs::create_dir_all(root.join(DEV_DIR))
            .map_err(|e| err!(e, "making {:?}", root; Test, IO)));
        Ok(root)
    }

    /// Lays a verifier down in a fixture tree.
    fn put(root: &Path, name: &str, src: &str) -> Outcome<()> {
        let p = root.join(DEV_DIR).join(fmt!("{}{}{}", PREFIX, name, SUFFIX));
        res!(fs::write(&p, src).map_err(|e| err!(e, "writing {:?}", p; Test, IO)));
        Ok(())
    }

    // ── The alphabet ────────────────────────────────────────────────

    #[test]
    fn a_name_is_a_name_and_never_a_path() {
        assert!(name_ok("graph"));
        assert!(name_ok("a11y_aria"));
        assert!(name_ok("relay_e2e"));
        // Everything a path, a flag or a shell would be made of.
        for bad in [
            "",
            "dev/verify_graph.mjs",
            "../etc/passwd",
            "graph.mjs",
            "-rf",
            "graph;rm",
            "graph ",
            "Graph",
            "graph$(id)",
            "graph\nrm",
        ] {
            assert!(!name_ok(bad), "{:?} was accepted as a verifier name", bad);
        }
        assert!(!name_ok(&"a".repeat(NAME_MAX + 1)), "a name past the cap was accepted");
    }

    // ── Nobody is at the keyboard ───────────────────────────────────

    #[test]
    fn a_verifier_is_handed_no_display_however_the_hand_got_one() {
        // The hand as the browser starts it: a native messaging host inherits the
        // browser's environment, and the browser is on the owner's screen.
        let mine: BTreeMap<String, String> = [
            ("DISPLAY", ":0"),
            ("WAYLAND_DISPLAY", "wayland-0"),
            ("XDG_SESSION_TYPE", "wayland"),
            ("HOME", "/home/jason"),
            ("PATH", "/usr/bin"),
        ].iter().map(|(k, v)| (fmt!("{}", k), fmt!("{}", v))).collect();
        let out = unattended_env(&mine);
        for v in SEAT_VARS {
            assert!(!out.contains_key(*v),
                "{} reached a verifier, so a headed one could paint on the seat", v);
        }
        assert_eq!(Some(&fmt!("1")), out.get(UNATTENDED_VAR),
            "the run was not marked unattended, so dev/display.mjs would allow :0");
        // Everything else is untouched: a verifier with no HOME dies on the first
        // line of any script in dev/, which is B13's neighbour in the same file.
        assert_eq!(Some(&fmt!("/home/jason")), out.get("HOME"));
        assert_eq!(Some(&fmt!("/usr/bin")), out.get("PATH"));
    }

    #[test]
    fn a_hand_with_no_display_still_says_nobody_is_looking() {
        // The mark is not conditional on there having been something to strip. An
        // absent DISPLAY and an unattended run are different sentences in
        // `dev/display.mjs`, and only the second one names the seat.
        let mine: BTreeMap<String, String> =
            [(fmt!("HOME"), fmt!("/home/jason"))].into_iter().collect();
        let out = unattended_env(&mine);
        assert_eq!(Some(&fmt!("1")), out.get(UNATTENDED_VAR));
        assert_eq!(2, out.len(), "something else was added: {:?}", out);
    }

    #[test]
    fn a_verifier_cannot_ask_to_be_watched() {
        // The mark WINS over an inherited one. Nothing sets this name today, and a
        // day when something does is a day when the last word has to be the hand's.
        let mine: BTreeMap<String, String> = [
            (fmt!("{}", UNATTENDED_VAR), fmt!("")),
            (fmt!("DISPLAY"), fmt!(":0")),
        ].into_iter().collect();
        let out = unattended_env(&mine);
        assert_eq!(Some(&fmt!("1")), out.get(UNATTENDED_VAR),
            "an inherited empty mark survived, and an empty mark is read as absent");
        assert!(!out.contains_key("DISPLAY"));
    }

    // ── What a verifier declares ────────────────────────────────────

    #[test]
    fn the_breaks_come_out_of_the_files_own_source() {
        let src = "\
// EACH CHECK IS PROVED AGAINST BROKEN CODE FIRST. `--break <name>` serves a
//   node dev/verify_about.mjs --break nobutton    # 1: no About button
//   node dev/verify_about.mjs --break oldbadge    # 1: the badge is still there
//   node dev/verify_about.mjs --break=stretch     # 3: the splash is squashed
const BREAK = process.argv.indexOf('--break');
if (BREAK) console.log(`running with --break ${BREAK}`);
";
        assert_eq!(vec![fmt!("nobutton"), fmt!("oldbadge"), fmt!("stretch")], declared_breaks(src),
            "the placeholder, the quoted flag and the interpolation must not be taken as names");
    }

    #[test]
    fn a_file_that_declares_nothing_declares_nothing() {
        assert!(declared_breaks("console.log('  ok   nothing');").is_empty());
        // The flag mentioned but never given a value.
        assert!(declared_breaks("//   node dev/verify_x.mjs --break <name>\n").is_empty());
    }

    // ── Looking one up ──────────────────────────────────────────────

    #[test]
    fn a_name_that_is_not_there_is_refused_with_the_near_misses() -> Outcome<()> {
        let root = res!(tree("absent"));
        res!(put(&root, "graph", "// node dev/verify_graph.mjs --break nolinks\n"));
        res!(put(&root, "graphedit", "//\n"));
        let e = match resolve(&root, "graphs") {
            Err(e) => e,
            Ok(s)  => return Err(err!("'graphs' resolved to {:?}", s.file; Test)),
        };
        assert!(e.starts_with("Refused:"), "{}", e);
        assert!(e.contains("graph"), "the near misses are not named: {}", e);
        Ok(())
    }

    #[test]
    fn a_path_is_refused_before_the_directory_is_read() -> Outcome<()> {
        let root = res!(tree("path"));
        for bad in ["../../etc/passwd", "dev/verify_graph.mjs", "graph.mjs"] {
            let e = match resolve(&root, bad) {
                Err(e) => e,
                Ok(_)  => return Err(err!("{:?} resolved to something", bad; Test)),
            };
            assert!(e.contains("not a verifier name"), "{}", e);
        }
        Ok(())
    }

    #[test]
    fn what_reaches_the_command_line_came_from_the_directory() -> Outcome<()> {
        let root = res!(tree("argv"));
        res!(put(&root, "graph", "//   node dev/verify_graph.mjs --break nolinks\n"));
        let script = match resolve(&root, "graph") {
            Ok(s)  => s,
            Err(e) => return Err(err!("{}", e; Test)),
        };
        let job = Job {
            id:     fmt!("v1"),
            root:   root.clone(),
            script: script.clone(),
            breaks: vec![fmt!("nolinks")],
            node:   PathBuf::from("/usr/bin/node"),
            budget: Duration::from_millis(1000),
            ledger: Ledger::new(
                Arc::new(Mutex::new(res!(crate::journal::Journal::open(
                    crate::journal::Cfg::at(root.join("journal")))))),
                Arc::new(AtomicBool::new(true))),
            world:  World::None,
            runner: None,
            cap:    Cap::None,
        };
        let argv = argv_for(&job, Some("nolinks"));
        assert_eq!(4, argv.len(), "{:?}", argv);
        assert_eq!(fmt!("{}", root.join(DEV_DIR).join("verify_graph.mjs").display()), argv[1]);
        assert_eq!(fmt!("--break"), argv[2]);
        assert_eq!(fmt!("nolinks"), argv[3]);
        Ok(())
    }

    #[test]
    fn a_break_the_file_does_not_declare_is_refused_and_the_real_ones_are_listed()
        -> Outcome<()>
    {
        let root = res!(tree("undeclared"));
        res!(put(&root, "graph",
            "//   node dev/verify_graph.mjs --break nolinks\n\
             //   node dev/verify_graph.mjs --break stale\n"));
        let script = match resolve(&root, "graph") {
            Ok(s)  => s,
            Err(e) => return Err(err!("{}", e; Test)),
        };
        assert_eq!(vec![fmt!("nolinks"), fmt!("stale")], script.breaks);
        let e = match chosen(&script, &Breaks::One(fmt!("invented"))) {
            Err(e) => e,
            Ok(v)  => return Err(err!("an undeclared break was accepted: {:?}", v; Test)),
        };
        assert!(e.contains("nolinks") && e.contains("stale"),
            "the refusal does not list what it does declare: {}", e);
        // And the declared one is taken, as the file spells it.
        assert_eq!(Ok(vec![fmt!("stale")]), chosen(&script, &Breaks::One(fmt!("stale"))));
        assert_eq!(Ok(vec![fmt!("nolinks"), fmt!("stale")]), chosen(&script, &Breaks::All));
        assert_eq!(Ok(Vec::new()), chosen(&script, &Breaks::None));
        Ok(())
    }

    #[test]
    fn a_verifier_with_no_breaks_cannot_be_asked_for_one() -> Outcome<()> {
        let root = res!(tree("nobreaks"));
        res!(put(&root, "bare", "console.log('  ok   something');\n"));
        let script = match resolve(&root, "bare") {
            Ok(s)  => s,
            Err(e) => return Err(err!("{}", e; Test)),
        };
        let e = match chosen(&script, &Breaks::One(fmt!("anything"))) {
            Err(e) => e,
            Ok(_)  => return Err(err!("a break was accepted from a file with none"; Test)),
        };
        assert!(e.contains("declares no breaks"), "{}", e);
        Ok(())
    }

    // ── Reading a run ───────────────────────────────────────────────

    #[test]
    fn the_check_lines_are_read_and_the_detail_is_cut_off() {
        let out = "\
  ok   the badge counts — 3 of 3
  FAIL the links are drawn — 0 found
  ok   the badge counts — 4 of 4
";
        let c = parse_checks(out);
        assert_eq!(Some(&true), c.get("the badge counts"));
        assert_eq!(Some(&false), c.get("the links are drawn"));
        assert_eq!(2, c.len(), "{:?}", c);
    }

    #[test]
    fn one_failure_beats_a_pass_of_the_same_name() {
        let c = parse_checks("  ok   x\n  FAIL x\n  ok   x\n");
        assert_eq!(Some(&false), c.get("x"), "a name that failed once must not read as passing");
    }

    // ── What a break did ────────────────────────────────────────────

    fn pass_of(label: &str, out: &str) -> Pass {
        let checks = parse_checks(out);
        Pass {
            label:  fmt!("{}", label),
            exit:   0,
            timed:  false,
            tail:   match checks.is_empty() {
                true  => last_lines(out, DEAD_TAIL_LINES),
                false => String::new(),
            },
            checks,
            norm:   normalise(out),
            fails:  Vec::new(),
            ms:     1,
        }
    }

    /// **A verifier that DIED says so, in its own words.**
    ///
    /// The turn of 2026-09-13 (`dev/HATES.md`): a browser verifier threw at its first
    /// navigation because no dev world was up, the report said `0 passed, 0 failed`, and the
    /// reason reached the model nowhere -- so a daimon spent fifty steps looking for a defect in
    /// a repository that had none.  `parse_checks` finds no check and `fails` takes only lines
    /// beginning `FAIL `, so a stack trace was neither.
    #[test]
    fn a_clean_run_that_measured_nothing_carries_its_last_words() {
        let died = "  ..   starting\npage.goto: net::ERR_CONNECTION_REFUSED at http://localhost:8777/\n    at file:///home/u/ws/dev/verify_x.mjs:41:9\n";
        let p = pass_of("clean", died);
        assert_eq!(0, p.passed(), "the fixture reported a check, so this proves nothing");
        assert_eq!(0, p.failed(), "the fixture reported a check, so this proves nothing");
        assert!(p.tail.contains("ERR_CONNECTION_REFUSED"),
            "a run that measured nothing kept none of what it printed: {:?}", p.tail);

        let script = Script {
            name:   fmt!("x"),
            file:   fmt!("verify_x.mjs"),
            path:   PathBuf::from("/w/dev/verify_x.mjs"),
            breaks: Vec::new(),
            prov:   Provenance::Committed,
        };
        let verdict = Verdict::Unproven { passed: 0, failed: 0, declared: Vec::new() };
        let text = report(&script, &[(p, None)], &verdict, &[], "[world: none]");
        assert!(text.contains("ERR_CONNECTION_REFUSED"),
            "the death did not reach the report, which is the only thing the model reads: {}",
            text);
        assert!(text.contains("localhost:8777"),
            "the report does not name what the script could not reach: {}", text);

        // AND A RUN THAT MEASURED SOMETHING PAYS NOTHING FOR IT.  A tail on every report would
        // double the bulk of an ordinary one for no reader.
        let live = pass_of("clean", "  ok   a\n  ok   b\n");
        assert!(live.tail.is_empty(), "a run with checks kept a tail it does not need");
    }

    #[test]
    fn a_break_that_reddens_a_check_is_red() {
        let clean = pass_of("clean", "  ok   a\n  ok   b\n");
        let brk   = pass_of("nolinks", "  ok   a\n  FAIL b\n");
        assert_eq!(Bite::Red { names: vec![fmt!("b")] }, bite(&clean, &brk));
    }

    #[test]
    fn a_break_whose_output_is_the_clean_runs_proves_nothing_and_says_which() {
        let clean = pass_of("clean", "  ok   a\n  ok   b\n");
        let brk   = pass_of("dead", "*** RUNNING UNDER --break dead ***\n  ok   a\n  ok   b\n");
        assert_eq!(Bite::None { same: true, vanished: 0 }, bite(&clean, &brk),
            "the break's own banner must not hide that nothing else changed");
    }

    #[test]
    fn a_break_that_moves_the_output_and_reddens_nothing_still_proves_nothing() {
        let clean = pass_of("clean", "  ok   a\n  ok   b\nfound 3 links\n");
        let brk   = pass_of("dead", "  ok   a\n  ok   b\nfound 9 links\n");
        assert_eq!(Bite::None { same: false, vanished: 0 }, bite(&clean, &brk),
            "a changed number is not a reddened check");
    }

    #[test]
    fn a_check_already_failing_clean_says_nothing_about_a_break() {
        let clean = pass_of("clean", "  ok   a\n  FAIL b\n");
        let brk   = pass_of("dead", "  ok   a\n  FAIL b\n");
        assert_eq!(Bite::None { same: true, vanished: 0 }, bite(&clean, &brk),
            "a break must not be credited with a failure that was already there");
    }

    #[test]
    fn a_break_that_aborts_is_not_counted_red() {
        let clean = pass_of("clean", "  ok   a\n  ok   b\n  ok   c\n");
        let brk   = pass_of("crash", "  ok   a\n");
        assert_eq!(Bite::None { same: false, vanished: 2 }, bite(&clean, &brk),
            "a run that stopped early has not shown a check able to fail");
    }

    // ── The verdict, and the number that cannot be dropped ──────────

    #[test]
    fn every_proven_trailer_carries_all_three_numbers() {
        let v = Verdict::Proven {
            passed: 27,
            failed: 0,
            red:    vec![fmt!("nolinks"), fmt!("stale")],
            dead:   vec![fmt!("nosc")],
            unrun:  Vec::new(),
        };
        let t = v.trailer();
        assert!(t.starts_with(TRAILER), "{}", t);
        assert!(t.contains("27 checks passed"), "{}", t);
        assert!(t.contains("2 breaks confirmed red"), "{}", t);
        assert!(t.contains("1 breaks proved nothing"), "{}", t);
        assert_eq!(EXIT_UNPROVEN, v.exit(), "a dead break is not a clean bill of health");
        assert!(v.advice().contains("nosc"), "the dead break is not named: {}", v.advice());
    }

    #[test]
    fn a_clean_only_run_says_it_proves_nothing_in_the_words_a_model_repeats() {
        let v = Verdict::Unproven {
            passed:   27,
            failed:   0,
            declared: vec![fmt!("nolinks"), fmt!("stale")],
        };
        let t = v.trailer();
        assert!(t.contains("NOT PROVEN"), "{}", t);
        assert!(t.contains("not evidence") || t.contains("NOT PROVEN"), "{}", t);
        assert_eq!(EXIT_UNPROVEN, v.exit());
        assert!(v.advice().contains("PROVES NOTHING"), "{}", v.advice());
        assert!(v.advice().contains("nolinks"), "the skipped breaks are not named");
    }

    #[test]
    fn a_sequence_where_every_break_bit_is_the_only_clean_bill() {
        let v = Verdict::Proven {
            passed: 5,
            failed: 0,
            red:    vec![fmt!("a"), fmt!("b")],
            dead:   Vec::new(),
            unrun:  Vec::new(),
        };
        assert_eq!(EXIT_PROVED, v.exit());
        assert!(v.trailer().contains("0 breaks proved nothing"), "{}", v.trailer());
    }

    #[test]
    fn a_break_the_budget_never_reached_is_said_and_not_hidden() {
        let v = Verdict::Proven {
            passed: 5,
            failed: 0,
            red:    vec![fmt!("a")],
            dead:   Vec::new(),
            unrun:  vec![fmt!("b")],
        };
        assert!(v.trailer().contains("1 breaks never ran"), "{}", v.trailer());
        assert_eq!(EXIT_UNPROVEN, v.exit());
    }

    #[test]
    fn a_failing_clean_run_is_the_code_and_the_report_says_so() {
        let v = Verdict::Proven {
            passed: 20,
            failed: 3,
            red:    vec![fmt!("a")],
            dead:   Vec::new(),
            unrun:  Vec::new(),
        };
        assert_eq!(EXIT_FAILED, v.exit());
        assert!(v.advice().contains("CLEAN run"), "{}", v.advice());
    }

    // ── The report ──────────────────────────────────────────────────

    #[test]
    fn the_report_always_ends_with_the_trailer() -> Outcome<()> {
        let root = res!(tree("report"));
        res!(put(&root, "graph", "//   node dev/verify_graph.mjs --break nolinks\n"));
        let script = match resolve(&root, "graph") {
            Ok(s)  => s,
            Err(e) => return Err(err!("{}", e; Test)),
        };
        let clean = pass_of("clean", "  ok   a\n  ok   b\n");
        let brk   = pass_of("nolinks", "  ok   a\n  FAIL b\n");
        let what  = bite(&clean, &brk);
        let v = Verdict::Proven {
            passed: clean.passed(),
            failed: clean.failed(),
            red:    vec![fmt!("nolinks")],
            dead:   Vec::new(),
            unrun:  Vec::new(),
        };
        let text = report(&script, &[(clean, None), (brk, Some(what))], &v, &[], "[world: none]");
        let last = match text.lines().filter(|l| !l.is_empty()).last() {
            Some(l) => l,
            None    => return Err(err!("the report is empty"; Test)),
        };
        assert!(last.starts_with(TRAILER), "the last line is {:?}", last);
        assert!(text.contains("RED: b went red"), "{}", text);
        assert!(text.contains("OUTSIDE the command fence"),
            "the report does not say where it ran");
        Ok(())
    }

    #[test]
    fn a_report_too_long_to_send_keeps_its_trailer() -> Outcome<()> {
        let root = res!(tree("long"));
        res!(put(&root, "big", "//\n"));
        let script = match resolve(&root, "big") {
            Ok(s)  => s,
            Err(e) => return Err(err!("{}", e; Test)),
        };
        let mut clean = pass_of("clean", "  ok   a\n");
        clean.fails = (0..40_000).map(|i| fmt!("FAIL a very long check name number {}", i))
            .collect();
        let v = Verdict::Unproven { passed: 1, failed: 0, declared: Vec::new() };
        let text = report(&script, &[(clean, None)], &v, &[], "[world: none]");
        assert!(text.len() <= REPORT_MAX, "{} bytes", text.len());
        assert!(text.trim_end().ends_with(']'), "the trailer was cut off");
        assert!(text.contains(TRAILER), "the trailer is gone");
        assert!(text.contains("NOT PROVEN"), "the unproven label was cut off");
        Ok(())
    }

    #[test]
    fn the_capability_says_whether_this_folder_has_verifiers_at_all() -> Outcome<()> {
        let bare = res!(tree("cap_bare"));
        assert_eq!(fmt!("verify:none"), cap(&bare));
        res!(put(&bare, "one", "//\n"));
        assert_eq!(fmt!("verify:dev"), cap(&bare));
        Ok(())
    }

    // ── Whose code is this? ─────────────────────────────────────────
    //
    // `REVIEW.md` §1.21.  A verifier runs OUTSIDE the command fence, and the
    // whole of the argument for that is that its bytes came with the checkout.
    // These tests aim at the argument rather than at the code: the fixture
    // verifier's entire body writes a file OUTSIDE the granted root, so the
    // marker's existence is the measurement.  A provenance that may run gets
    // its marker; every other provenance must not.

    /// Runs one git command in a fixture tree.
    ///
    /// # Arguments
    /// * `root` - The fixture.
    /// * `args` - The argument vector after `git -C <root>`.
    fn git(root: &Path, args: &[&str]) -> Outcome<()> {
        let git = res!(on_path("git").ok_or_else(|| err!(
            "These tests ask git what the repository holds, and there is no git on PATH.";
            Test, Missing)));
        let out = res!(std::process::Command::new(git)
            .arg("-C").arg(root)
            .args(args)
            .output()
            .map_err(|e| err!(e, "running git {:?}", args; Test, IO)));
        if !out.status.success() {
            return Err(err!("git {:?} failed in {:?}: {}",
                args, root, String::from_utf8_lossy(&out.stderr); Test, IO));
        }
        Ok(())
    }

    /// A verifier whose whole body writes one file, at an absolute path.
    ///
    /// It prints a check line as well, so that a run which is allowed reports
    /// something a `Pass` can be built from and the fixture exercises the real
    /// path rather than an empty one.
    ///
    /// # Arguments
    /// * `marker` - Where it writes, which the tests place outside the root.
    fn escaper(marker: &Path) -> String {
        fmt!(
            "import fs from 'node:fs';\n\
            fs.writeFileSync({:?}, 'the verifier ran unfenced\\n');\n\
            console.log('  ok   it ran');\n",
            fmt!("{}", marker.display()))
    }

    /// What one attempt at a fixture verifier did.
    struct Attempt {
        refused: Option<String>,	// the sentence, where the hand declined
        escaped: bool,				// whether the marker outside the root appeared
    }

    /// Resolves and conducts a fixture verifier, and says what came of it.
    ///
    /// Deliberately the crate's own public API and not the dispatcher's: a gate
    /// that lives in `main.rs` is a gate this function would walk past, and the
    /// reproduction in `REVIEW.md` §1.21 walked past exactly that.
    ///
    /// # Arguments
    /// * `root` - The fixture.
    /// * `name` - The verifier's short name.
    /// * `marker` - The path the verifier writes, outside `root`.
    async fn attempt(root: &Path, name: &str, marker: &Path) -> Outcome<Attempt> {
        if marker.exists() {
            res!(fs::remove_file(marker).map_err(|e| err!(e, "clearing {:?}", marker; Test, IO)));
        }
        let node = res!(on_path("node").ok_or_else(|| err!(
            "Every verifier is a Node script and there is no node on PATH, so this test would \
            prove nothing about whether one ran.";
            Test, Missing)));
        let script = match resolve(root, name) {
            Ok(s)  => s,
            Err(w) => return Ok(Attempt { refused: Some(w), escaped: marker.exists() }),
        };
        let stem = match root.file_name().and_then(|n| n.to_str()) {
            Some(n) => fmt!("{}", n),
            None    => fmt!("{}", name),
        };
        let jdir = match root.parent() {
            Some(p) => p.join(fmt!("{}-journal", stem)),
            None    => root.join("journal"),
        };
        if jdir.exists() {
            res!(fs::remove_dir_all(&jdir).map_err(|e| err!(e, "clearing {:?}", jdir; Test, IO)));
        }
        let jr = res!(Journal::open(crate::journal::Cfg::at(&jdir)));
        let job = Job {
            id:     fmt!("probe"),
            root:   root.to_path_buf(),
            script,
            breaks: Vec::new(),
            node,
            budget: Duration::from_millis(60_000),
            ledger: Ledger::new(Arc::new(Mutex::new(jr)), Arc::new(AtomicBool::new(true))),
            world:  World::None,
            runner: None,
            cap:    Cap::None,
        };
        let (tx, mut rx) = tokio::sync::mpsc::channel(64);
        // Boxed, so the whole sequence's future lives on the heap. Inlined, `conduct`
        // holds `once` holds `drain`'s buffers, and a debug build of that overflows a
        // test thread's stack before the first process starts.
        res!(Box::pin(conduct(job, tx)).await);
        let mut refused = None;
        while let Some(r) = rx.recv().await {
            if let Resp::Refused { reason, .. } = r {
                refused = Some(reason);
            }
        }
        Ok(Attempt { refused, escaped: marker.exists() })
    }

    #[tokio::test]
    async fn a_verifier_the_checkout_brought_runs_outside_the_fence() -> Outcome<()> {
        let root   = res!(tree("prov_committed"));
        let marker = root.join("..").join("prov_committed.escaped");
        let marker = PathBuf::from(fmt!("{}", marker.display()));
        res!(git(&root, &["init", "-q"]));
        res!(put(&root, "probe", &escaper(&marker)));
        res!(git(&root, &["add", "dev/verify_probe.mjs"]));
        res!(git(&root, &["-c", "user.name=T", "-c", "user.email=t@t",
            "commit", "-q", "--no-verify", "-m", "probe"]));
        let a = res!(attempt(&root, "probe", &marker).await);
        assert!(a.refused.is_none(), "the committed case must run: {:?}", a.refused);
        // The half that keeps this pair honest. Without it a guard that refused
        // everything would leave the three tests below green while making the verb
        // useless, which is the failure `REVIEW.md` was written about.
        assert!(a.escaped,
            "a verifier that IS the commit runs outside the fence, and this one wrote nothing \
            outside the root -- so the three tests below prove nothing about a fence");
        Ok(())
    }

    /// The verb, over this very tree, driven by hand.
    ///
    /// `#[ignore]`d, so it is never part of a suite: it runs a real verifier from
    /// the repository this crate sits in, which starts browsers and takes minutes.
    /// It is here because the fixtures above cannot find what it finds.  Run over
    /// `verify_reflux` on 2026-08-25 it turned up two defects in a file that had
    /// passed standalone twelve times -- a break declared by a sentence that named
    /// ANOTHER file's break, and an X server killed hard enough to keep its lock --
    /// and neither is visible from a fixture, because a fixture has no header prose
    /// and starts no X server.
    ///
    ///	LIVE=reflux cargo test --manifest-path hand/Cargo.toml --lib \
    ///	  verify::tests::live_walk -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn live_walk_over_this_very_tree() -> Outcome<()> {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
        let name = std::env::var("LIVE").unwrap_or(fmt!("harness"));
        let script = match resolve(&root, &name) {
            Ok(s)  => s,
            Err(w) => { println!("REFUSED: {}", w); return Ok(()); },
        };
        println!("script  {:?}\nprov    {}\nbreaks  {:?}",
            script.path, script.prov.phrase(), script.breaks);
        let node = res!(on_path("node").ok_or_else(|| err!(
            "Every verifier is a Node script and there is no node on PATH."; Test, Missing)));
        let jdir = res!(tree("live_walk")).join("journal");
        let jr = res!(Journal::open(crate::journal::Cfg::at(&jdir)));
        let job = Job {
            id: fmt!("live"), root: root.clone(), breaks: script.breaks.clone(), script,
            node, budget: Duration::from_millis(1_800_000),
            ledger: Ledger::new(Arc::new(Mutex::new(jr)), Arc::new(AtomicBool::new(true))),
            // The live walk runs a REAL verifier from this very tree, so it gets the
            // real inference and a real world if the file needs one.
            world:  World::Infer,
            runner: None,
            cap:    Cap::detect(),
        };
        let (tx, mut rx) = tokio::sync::mpsc::channel(64);
        res!(Box::pin(conduct(job, tx)).await);
        while let Some(r) = rx.recv().await {
            match r {
                Resp::Chunk { data, .. }     => println!("{}", data),
                Resp::Refused { reason, .. } => println!("REFUSED: {}", reason),
                Resp::Ended { exit, .. }     => println!("exit {}", exit),
                _                            => {},
            }
        }
        Ok(())
    }

    #[tokio::test]
    async fn the_spawn_itself_hands_on_no_display() -> Outcome<()> {
        // The pure function above can be right and never called, which is this
        // repository's own recorded failure shape -- `dev/BLOCKERS.md` keeps a list
        // of things built and unreachable. So this one goes through `conduct`,
        // `once` and a real `execve`, and asks the child what it was actually given.
        let root   = res!(tree("prov_seat"));
        let marker = root.join("..").join("prov_seat.saw");
        let marker = PathBuf::from(fmt!("{}", marker.display()));
        res!(git(&root, &["init", "-q"]));
        res!(put(&root, "probe", &fmt!(
            "import fs from 'node:fs';\n\
            const e = process.env;\n\
            fs.writeFileSync({:?}, `DISPLAY=${{e.DISPLAY ?? '<unset>'}} \
            WAYLAND_DISPLAY=${{e.WAYLAND_DISPLAY ?? '<unset>'}} \
            DAIMOND_UNATTENDED=${{e.DAIMOND_UNATTENDED ?? '<unset>'}} \
            HOME=${{e.HOME ? 'set' : '<unset>'}}`);\n\
            console.log('  ok   it ran');\n",
            fmt!("{}", marker.display()))));
        res!(git(&root, &["add", "dev/verify_probe.mjs"]));
        res!(git(&root, &["-c", "user.name=T", "-c", "user.email=t@t",
            "commit", "-q", "--no-verify", "-m", "probe"]));
        let mine = std::env::var("DISPLAY").unwrap_or_default();
        let a = res!(attempt(&root, "probe", &marker).await);
        assert!(a.refused.is_none(), "the committed case must run: {:?}", a.refused);
        let saw = res!(fs::read_to_string(&marker)
            .map_err(|e| err!(e, "the probe wrote nothing at {:?}", marker; Test, IO)));
        assert!(saw.contains("DISPLAY=<unset>"),
            "a verifier was handed a display. This process holds DISPLAY={:?}, and what \
            reached the child was: {}", mine, saw);
        assert!(saw.contains("WAYLAND_DISPLAY=<unset>"),
            "a verifier was handed the compositor, which Chromium prefers over DISPLAY \
            and which is the owner's own screen: {}", saw);
        assert!(saw.contains("DAIMOND_UNATTENDED=1"),
            "the run was not marked unattended, so dev/display.mjs would allow :0: {}", saw);
        // The half that keeps the three above honest: an environment cleared and not
        // rebuilt would satisfy every one of them and break every verifier in dev/.
        assert!(saw.contains("HOME=set"),
            "the environment was cleared and not rebuilt, so every script under dev/ \
            dies on its first line: {}", saw);
        Ok(())
    }

    #[tokio::test]
    async fn a_verifier_git_has_never_heard_of_does_not_run() -> Outcome<()> {
        let root   = res!(tree("prov_untracked"));
        let marker = PathBuf::from(fmt!("{}", root.join("..").join("prov_untracked.escaped").display()));
        res!(git(&root, &["init", "-q"]));
        res!(put(&root, "probe", &escaper(&marker)));
        let a = res!(attempt(&root, "probe", &marker).await);
        assert!(!a.escaped, "an untracked verifier ran and wrote outside the granted root");
        let no = res!(a.refused.ok_or_else(|| err!(
            "nothing was refused, so the run happened"; Test, Invalid)));
        assert!(no.contains("dev/verify_probe.mjs"), "the refusal must name the file: {}", no);
        Ok(())
    }

    #[tokio::test]
    async fn a_tracked_verifier_the_model_has_edited_does_not_run() -> Outcome<()> {
        let root   = res!(tree("prov_edited"));
        let marker = PathBuf::from(fmt!("{}", root.join("..").join("prov_edited.escaped").display()));
        res!(git(&root, &["init", "-q"]));
        res!(put(&root, "probe", "console.log('  ok   it ran');\n"));
        res!(git(&root, &["add", "dev/verify_probe.mjs"]));
        res!(git(&root, &["-c", "user.name=T", "-c", "user.email=t@t",
            "commit", "-q", "--no-verify", "-m", "probe"]));
        // Now the model edits it. `git ls-files --error-unmatch` goes on saying yes.
        res!(put(&root, "probe", &escaper(&marker)));
        let a = res!(attempt(&root, "probe", &marker).await);
        assert!(!a.escaped, "an edited verifier ran and wrote outside the granted root");
        assert!(a.refused.is_some(), "nothing was refused, so the run happened");
        // And the whole of §1.21's second half: staging it is not committing it.
        res!(git(&root, &["add", "dev/verify_probe.mjs"]));
        let b = res!(attempt(&root, "probe", &marker).await);
        assert!(!b.escaped,
            "'git add' bought the model an unfenced run, so the check is about the index and \
            not about the bytes");
        assert!(b.refused.is_some(), "a staged edit was accepted");
        Ok(())
    }

    #[tokio::test]
    async fn a_folder_with_no_git_in_it_cannot_vouch_for_anything() -> Outcome<()> {
        let root   = res!(tree("prov_nogit"));
        let marker = PathBuf::from(fmt!("{}", root.join("..").join("prov_nogit.escaped").display()));
        res!(put(&root, "probe", &escaper(&marker)));
        let a = res!(attempt(&root, "probe", &marker).await);
        assert!(!a.escaped,
            "a granted folder with no repository in it ran a verifier outside the fence, and \
            nothing there could have said whose code it was");
        assert!(a.refused.is_some(), "nothing was refused, so the run happened");
        Ok(())
    }

    #[tokio::test]
    async fn the_refusal_hands_the_daimon_the_fenced_route() -> Outcome<()> {
        let root   = res!(tree("prov_sentence"));
        let marker = PathBuf::from(fmt!("{}", root.join("..").join("prov_sentence.escaped").display()));
        res!(git(&root, &["init", "-q"]));
        res!(put(&root, "probe", &escaper(&marker)));
        let a = res!(attempt(&root, "probe", &marker).await);
        let no = res!(a.refused.ok_or_else(|| err!("nothing was refused"; Test, Invalid)));
        // A refusal a model cannot converge on costs the run anyway. Each of these is a
        // thing the daimon must be able to DO next, and the sentence is asserted for
        // meaning rather than for length.
        // The argv form and not a command line, because that is what 'run' takes: a
        // refusal that hands a model a shell string teaches it the one spelling the
        // tool refuses.
        assert!(no.contains(r#"["node","dev/verify_probe.mjs"]"#),
            "the refusal must hand over the argv that runs it fenced: {}", no);
        assert!(no.contains("'run'"),
            "the refusal must name the tool that command goes to: {}", no);
        assert!(no.contains("commit"),
            "the refusal must say what makes the unfenced run available: {}", no);
        assert!(no.contains("browser"),
            "the refusal must say what the fenced route cannot do, or a daimon will read the \
            fenced run's failure as the verifier being broken: {}", no);
        Ok(())
    }

    #[test]
    fn a_verifier_that_is_a_symlink_is_not_the_commit_whatever_git_says() -> Outcome<()> {
        let root = res!(tree("prov_link"));
        res!(git(&root, &["init", "-q"]));
        // The target is an ordinary file inside the granted root, which every fenced
        // command may rewrite. Committing the LINK commits the name and not the bytes.
        let target = root.join("notes.mjs");
        res!(fs::write(&target, "console.log('  ok   it ran');\n")
            .map_err(|e| err!(e, "writing {:?}", target; Test, IO)));
        #[cfg(unix)]
        res!(std::os::unix::fs::symlink("../notes.mjs",
            root.join(DEV_DIR).join("verify_probe.mjs"))
            .map_err(|e| err!(e, "linking"; Test, IO)));
        res!(git(&root, &["add", "-A"]));
        res!(git(&root, &["-c", "user.name=T", "-c", "user.email=t@t",
            "commit", "-q", "--no-verify", "-m", "probe"]));
        assert_eq!(Provenance::Changed(Change::Linked),
            provenance(&root, "verify_probe.mjs"),
            "a committed symlink read as the commit's own bytes");
        let no = res!(unfenced_refusal(&root, "verify_probe.mjs").ok_or_else(|| err!(
            "a committed symlink was allowed to run unfenced"; Test, Invalid)));
        assert!(no.contains("symbolic link"), "{}", no);
        Ok(())
    }

    #[test]
    fn membership_is_not_content_and_this_is_where_the_two_part() -> Outcome<()> {
        let root = res!(tree("prov_parts"));
        res!(git(&root, &["init", "-q"]));
        res!(put(&root, "probe", "console.log('  ok   one');\n"));
        res!(git(&root, &["add", "dev/verify_probe.mjs"]));
        res!(git(&root, &["-c", "user.name=T", "-c", "user.email=t@t",
            "commit", "-q", "--no-verify", "-m", "probe"]));
        assert_eq!(Provenance::Committed, provenance(&root, "verify_probe.mjs"));
        assert!(unfenced_refusal(&root, "verify_probe.mjs").is_none());

        // One appended comment. This is the case `REVIEW.md` §1.21 turns on: the index
        // goes on saying yes, and the bytes are the model's.
        res!(put(&root, "probe", "console.log('  ok   one');\n// and now mine\n"));
        let git_path = res!(on_path("git").ok_or_else(|| err!("no git"; Test, Missing)));
        let listed = res!(std::process::Command::new(&git_path)
            .arg("-C").arg(&root)
            .args(["ls-files", "--error-unmatch", "--", "dev/verify_probe.mjs"])
            .stdout(Stdio::null()).stderr(Stdio::null())
            .status().map_err(|e| err!(e, "ls-files"; Test, IO)));
        assert!(listed.success(),
            "the premise of this test is that git goes on naming an edited file");
        assert_eq!(Provenance::Changed(Change::Edited), provenance(&root, "verify_probe.mjs"),
            "the check followed the index rather than the bytes");
        Ok(())
    }


    // ── The world a page verifier needs ─────────────────────────────
    //
    // A verifier finds its world in the ENVIRONMENT and nowhere else, so a verb
    // that hands one nothing aims every check at world 0 -- another lane's app,
    // or none.  These tests are about the two halves of that: the world is
    // chosen and handed over, and it comes DOWN on every way out of a sequence.
    // The scripted `dev/world.sh` below writes a line per action, so "it was
    // torn down" is a fact on disk rather than an absence of complaint.

    #[test]
    fn the_daimon_band_is_the_registers_and_44_is_not_in_it() {
        let band = daimon_worlds();
        assert_eq!(9, band.len(), "{:?}", band);
        assert_eq!(Some(&40), band.first());
        assert_eq!(Some(&49), band.last());
        // dev/world.sh's register: world 44's mock would be :9143, which is
        // dev/verify_triage.mjs's own fixed row. A hole in the band costs nothing
        // and saves a sequence spent discovering the clash.
        assert!(!band.contains(&44), "world 44 is offered and its mock is :9143");
        assert_eq!((8817, 9139, 9740), world_ports(40));
        assert_eq!((8826, 9148, 9749), world_ports(49));
    }

    #[test]
    fn a_world_is_picked_by_its_ports_and_by_what_is_locked() {
        // Everything free: the first of the band.
        assert_eq!(Some(40), pick_world(|_| true, &[]));
        // The first two locked by another daimon on this tree.
        assert_eq!(Some(42), pick_world(|_| true, &[40, 41]));
        // World 40's mock held by something else; 41 is whole.
        assert_eq!(Some(41), pick_world(|p| p != 9139, &[]));
        // The held-back one is never offered, however free it is.
        assert_eq!(Some(45), pick_world(|_| true, &[40, 41, 42, 43, 44]));
        // And nothing at all is `None` rather than a guess.
        assert_eq!(None, pick_world(|_| false, &[]));
    }

    #[test]
    fn a_verifier_that_imports_the_harness_is_the_one_that_needs_a_world() {
        assert!(needs_world("import { open } from './harness.mjs';\n"));
        assert!(needs_world("import {\n open,\n} from \"./harness.mjs\";\n"));
        // Half the headers in dev/ talk ABOUT the harness; none of them drives it.
        assert!(!needs_world("// it does not import { open } from './harness.mjs'\n"));
        assert!(!needs_world(
            "// verify_worldports.mjs — two worlds at once.\nimport net from 'node:net';\n"));
        assert!(!needs_world(""));
    }

    #[test]
    fn the_env_block_is_read_the_way_a_shell_would_read_it() {
        let out = "world 3: app :8780, mock :9102\nexport DAIMOND_PORT=8780\n\
            export DAIMOND_APP=http://localhost:8780\nexport DAIMOND_MOCK_LOG=/x/dev/mockllm-3.log\n\
            not an export\nexport lower=case\n";
        let got = parse_env_block(out);
        assert_eq!(3, got.len(), "{:?}", got);
        assert_eq!((fmt!("DAIMOND_PORT"), fmt!("8780")), got[0]);
        assert_eq!((fmt!("DAIMOND_MOCK_LOG"), fmt!("/x/dev/mockllm-3.log")), got[2]);
    }

    #[test]
    fn a_header_asking_for_a_gateway_already_up_is_told_apart_from_one_denying_it() {
        assert!(wants_live_gateway(
            "// verify_x.mjs — it needs the gateway on :9002 to be up already.\nconst a = 1;\n"));
        // The nine headers that say the opposite, and the one that brings its own.
        assert!(!wants_live_gateway(
            "// verify_y.mjs — it does NOT need the gateway on :9002.\nconst a = 1;\n"));
        assert!(!wants_live_gateway(
            "// verify_z.mjs — it needs the gateway on :9002.\nprocLog('gw');\n"));
        // A mention after the header has ended is code, not a requirement.
        assert!(!wants_live_gateway("const s = 'gateway :9002 DAIMOND_GW_PORT';\n"));
    }

    // ── A scripted world, so the teardown is a fact on disk ─────────

    /// A `dev/world.sh` that records what it was asked to do.
    ///
    /// It binds nothing: what is under test is the verb's half of the
    /// arrangement -- that a world is chosen, that its environment reaches the
    /// verifier, and that `--down` is reached on every way out -- and a fixture
    /// that started real servers would be measuring `dev/world.sh` instead.
    ///
    /// # Arguments
    /// * `extra` - A line run inside `--up`, for the case where the world's own
    ///   coming up is what edits the verifier.
    fn world_sh(extra: &str) -> String {
        fmt!(
            "#!/bin/bash\n\
            N=\"$1\"\n\
            A=\"$2\"\n\
            echo \"${{A#--}} $N\" >> \"$DAIMOND_WORLD_ROOT/actions.txt\"\n\
            if [ \"$A\" = \"--up\" ]; then\n\
            \t{}\n\
            \tmkdir -p \"$DAIMOND_WORLD_ROOT/w$N/world\"\n\
            \techo \"export DAIMOND_PORT=31337\"\n\
            \techo \"export DAIMOND_APP=http://localhost:31337\"\n\
            \techo \"world $N: app :31337, mock :31338\" >&2\n\
            fi\n\
            exit 0\n", extra)
    }

    /// A fixture tree holding a scripted world and one verifier.
    ///
    /// # Arguments
    /// * `name` - Unique to the calling test.
    /// * `verifier` - The verifier's source.
    /// * `extra` - What the scripted `--up` does besides printing its block.
    fn world_tree(name: &str, verifier: &str, extra: &str) -> Outcome<PathBuf> {
        let root = res!(tree(name));
        res!(git(&root, &["init", "-q"]));
        for (f, body) in [
            ("world.sh",    world_sh(extra)),
            ("serve.mjs",   fmt!("// a fixture\n")),
            ("mockllm.mjs", fmt!("// a fixture\n")),
            // A stub, because what makes a verifier a page verifier is that it
            // IMPORTS this -- and node will not run a file whose import resolves
            // to nothing, so a fixture without one measures the module loader.
            ("harness.mjs", fmt!("export const open = () => {{}};\n")),
        ] {
            let p = root.join(DEV_DIR).join(f);
            res!(fs::write(&p, body).map_err(|e| err!(e, "writing {:?}", p; Test, IO)));
        }
        res!(put(&root, "probe", verifier));
        res!(git(&root, &["add", "-A"]));
        res!(git(&root, &["-c", "user.name=T", "-c", "user.email=t@t",
            "commit", "-q", "--no-verify", "-m", "fixtures"]));
        Ok(root)
    }

    /// The actions a scripted world was asked for, verb by verb.
    ///
    /// The world NUMBER is chosen by the hand from whichever of the band's ports
    /// are free on the machine the test runs on, so it is not something to assert
    /// on; the order of the verbs is the whole claim.
    fn verbs(actions: &str) -> Vec<&str> {
        actions.lines().map(|l| l.split(' ').next().unwrap_or("")).collect()
    }

    /// What one scripted sequence did.
    struct Ran {
        refused: Option<String>,	// the sentence, where the hand declined
        out:     String,			// the report
        actions: String,			// what the scripted world.sh was asked to do
    }

    /// Conducts a sequence over a fixture tree and says what came of it.
    ///
    /// # Arguments
    /// * `root` - The fixture.
    /// * `world` - What the caller asked for.
    /// * `breaks` - The breaks to attempt.
    /// * `budget_ms` - The whole sequence's budget.
    async fn run_world(
        root:      &Path,
        world:     World,
        breaks:    Vec<String>,
        budget_ms: u64,
    )
        -> Outcome<Ran>
    {
        let node = res!(on_path("node").ok_or_else(|| err!(
            "Every verifier is a Node script and there is no node on PATH."; Test, Missing)));
        let script = res!(resolve(root, "probe").map_err(|w| err!("{}", w; Test, Invalid)));
        let jdir = PathBuf::from(fmt!("{}", root.join("..").join(fmt!("{}-journal",
            root.file_name().and_then(|n| n.to_str()).unwrap_or("w"))).display()));
        if jdir.exists() {
            res!(fs::remove_dir_all(&jdir).map_err(|e| err!(e, "clearing"; Test, IO)));
        }
        let jr = res!(Journal::open(crate::journal::Cfg::at(&jdir)));
        let job = Job {
            id:     fmt!("w1"),
            root:   root.to_path_buf(),
            script,
            breaks,
            node,
            budget: Duration::from_millis(budget_ms),
            ledger: Ledger::new(Arc::new(Mutex::new(jr)), Arc::new(AtomicBool::new(true))),
            world,
            runner: None,
            cap:    Cap::None,
        };
        let (tx, mut rx) = tokio::sync::mpsc::channel(64);
        res!(Box::pin(conduct(job, tx)).await);
        let mut refused = None;
        let mut out     = String::new();
        while let Some(r) = rx.recv().await {
            match r {
                Resp::Refused { reason, .. }			=> refused = Some(reason),
                Resp::Chunk { stream: Stream::Out, data, .. }	=> out.push_str(&data),
                _						=> {},
            }
        }
        let actions = fs::read_to_string(root.join(WORLD_SCRATCH).join("actions.txt"))
            .unwrap_or_default();
        Ok(Ran { refused, out, actions })
    }

    #[tokio::test]
    async fn a_page_verifier_is_handed_the_world_it_was_given() -> Outcome<()> {
        // Written to a file rather than printed: a report carries check NAMES and
        // counts, so a passing check's own words never reach it -- and what is
        // being measured here is what the CHILD PROCESS was given.
        let root = res!(world_tree("world_clean",
            "import fs from 'node:fs';\n\
            import { open } from './harness.mjs';\n\
            fs.writeFileSync('saw.txt', String(process.env.DAIMOND_PORT ?? 'unset'));\n\
            console.log('  ok   it ran');\n", ""));
        let r = res!(run_world(&root, World::Infer, Vec::new(), 60_000).await);
        assert!(r.refused.is_none(), "the sequence was refused: {:?}", r.refused);
        // THE HALF THE VERB EXISTS FOR. Before this, every page verifier a daimon
        // ran was handed the hand's own environment, which names no world at all.
        let saw = fs::read_to_string(root.join("saw.txt")).unwrap_or_default();
        assert_eq!("31337", saw,
            "the verifier was not handed the world's environment: {:?}\n{}", saw, r.out);
        assert!(r.out.contains("[world: 4"),
            "the report does not say which world this ran in: {}", r.out);
        assert!(r.out.contains("uncapped"),
            "the report does not say what the run was held under: {}", r.out);
        // Up, then down, and the order is the whole claim.
        assert_eq!(vec!["up", "down"], verbs(&r.actions),
            "the world was not taken down: {:?}", r.actions);
        Ok(())
    }

    #[tokio::test]
    async fn a_verifier_that_starts_its_own_servers_is_given_no_world() -> Outcome<()> {
        let root = res!(world_tree("world_none",
            "import fs from 'node:fs';\n\
            import net from 'node:net';\n\
            fs.writeFileSync('saw.txt', String(process.env.DAIMOND_PORT ?? 'unset'));\n\
            console.log('  ok   it ran');\n", ""));
        let r = res!(run_world(&root, World::Infer, Vec::new(), 60_000).await);
        assert!(r.refused.is_none(), "{:?}", r.refused);
        // Not asserted as "unset": the hand's own environment is handed on whole,
        // and a hand started from a shell inside somebody's world carries that
        // shell's port. What must not be there is the world this would have stood.
        let saw = fs::read_to_string(root.join("saw.txt")).unwrap_or_default();
        assert_ne!("31337", saw, "a verifier that needs no world was handed one");
        assert_eq!("", r.actions, "a world was stood for a verifier that imports no harness");
        assert!(r.out.contains("does not import dev/harness.mjs"),
            "the report does not say why no world was stood: {}", r.out);
        Ok(())
    }

    #[tokio::test]
    async fn world_false_on_a_harness_importer_is_said_in_the_report() -> Outcome<()> {
        let root = res!(world_tree("world_refused",
            "import { open } from './harness.mjs';\n\
            console.log('  ok   it ran');\n", ""));
        let r = res!(run_world(&root, World::None, Vec::new(), 60_000).await);
        assert!(r.refused.is_none(), "{:?}", r.refused);
        assert_eq!("", r.actions, "world:false stood a world anyway");
        // The line that stops a connection-refused below it being read as the app.
        assert!(r.out.contains("(world:false)") && r.out.contains("names no world"),
            "the report does not warn that a page verifier was given no world: {}", r.out);
        Ok(())
    }

    #[tokio::test]
    async fn the_world_goes_down_when_the_verifier_stops_being_the_commits() -> Outcome<()> {
        // The world's own coming up is what edits the verifier, which is the race
        // the re-ask before every spawn exists for, arriving on schedule. The clean
        // run is then refused -- and the world is up when it happens.
        let root = res!(world_tree("world_edited",
            "import { open } from './harness.mjs';\n\
            console.log('  ok   it ran');\n",
            "echo '// and now it is mine' >> dev/verify_probe.mjs"));
        let r = res!(run_world(&root, World::Infer, Vec::new(), 60_000).await);
        let no = res!(r.refused.ok_or_else(|| err!(
            "an edited verifier ran unfenced"; Test, Invalid)));
        assert!(no.contains("stopped being the commit's"), "{}", no);
        // THE POINT: refused mid-sequence is still a way out, and the world took it.
        assert_eq!(vec!["up", "down"], verbs(&r.actions),
            "a sequence refused after the world came up left it standing: {:?}", r.actions);
        assert!(no.contains("[world: 4"),
            "the refusal does not say what became of the world: {}", no);
        Ok(())
    }

    #[tokio::test]
    async fn the_world_goes_down_when_the_budget_is_spent() -> Outcome<()> {
        let root = res!(world_tree("world_budget",
            "import { open } from './harness.mjs';\n\
            await new Promise(r => setTimeout(r, 30000));\n", ""));
        let r = res!(run_world(&root, World::Infer, Vec::new(), 1).await);
        let no = res!(r.refused.ok_or_else(|| err!(
            "a budget of one millisecond produced a report"; Test, Invalid)));
        assert!(no.contains("past the budget"), "{}", no);
        assert_eq!(vec!["up", "down"], verbs(&r.actions),
            "a spent budget left the world standing: {:?}", r.actions);
        Ok(())
    }

    #[tokio::test]
    async fn a_world_made_of_code_the_model_wrote_is_refused_before_it_stands()
        -> Outcome<()>
    {
        let root = res!(world_tree("world_prov",
            "import { open } from './harness.mjs';\n\
            console.log('  ok   it ran');\n", ""));
        // A daimon may `file_write` any of the three files a world is made of, and
        // all three run unfenced. The rule that guards the verifier guards them.
        res!(fs::write(root.join(DEV_DIR).join("mockllm.mjs"), "// and now it is mine\n")
            .map_err(|e| err!(e, "editing the fixture mock"; Test, IO)));
        let r = res!(run_world(&root, World::Stand, Vec::new(), 60_000).await);
        let no = res!(r.refused.ok_or_else(|| err!(
            "a world was stood out of code the model wrote"; Test, Invalid)));
        assert!(no.contains("dev/mockllm.mjs"), "the refusal must name the file: {}", no);
        assert!(no.contains("Nothing was run"), "{}", no);
        assert_eq!("", r.actions, "world.sh ran despite the refusal");
        Ok(())
    }

    #[tokio::test]
    async fn a_dropped_guard_takes_the_world_down_and_a_disarmed_one_does_not()
        -> Outcome<()>
    {
        // The path that survives a panic or an aborted task, where nothing else ran.
        let root = res!(world_tree("world_guard",
            "console.log('  ok   it ran');\n", ""));
        let scratch = root.join(WORLD_SCRATCH);
        res!(fs::create_dir_all(&scratch).map_err(|e| err!(e, "making the scratch"; Test, IO)));
        let up = WorldUp {
            n:       41,
            pgid:    0,	// no group: the fixture starts nothing, and 0 is never signalled
            env:     Vec::new(),
            scratch: scratch.clone(),
            rel:     fmt!("{}", WORLD_SCRATCH),
            run_id:  fmt!("w1-world"),
        };
        {
            let g = WorldGuard::arm(&root, &up);
            assert!(g.armed());
        }
        assert_eq!("down 41\n", fs::read_to_string(scratch.join("actions.txt")).unwrap_or_default(),
            "a dropped guard did not take the world down");
        res!(fs::remove_file(scratch.join("actions.txt"))
            .map_err(|e| err!(e, "clearing"; Test, IO)));
        {
            let mut g = WorldGuard::arm(&root, &up);
            g.disarm();
            assert!(!g.armed());
        }
        assert_eq!("", fs::read_to_string(scratch.join("actions.txt")).unwrap_or_default(),
            "a disarmed guard took a world down that the ordinary path had already taken");
        Ok(())
    }

    #[test]
    fn the_teardowns_own_failure_reaches_the_report() {
        let ok = world_line(41, ".scratch/worlds", Cap::Systemd, &Ok(()));
        assert!(ok.contains("[world: 41 — app :8818, mock :9140, gateway :9741"), "{}", ok);
        assert!(ok.contains("MemoryMax 4G"), "{}", ok);
        assert!(ok.contains("torn down"), "{}", ok);
        let bad = world_line(41, ".scratch/worlds", Cap::None,
            &Err(fmt!(":8818 still held; it is listed by runs as 'v1-world'")));
        assert!(bad.contains("TEARDOWN FAILED"), "{}", bad);
        // The identifier is the only way anything reaches that group, so it has to
        // be in the sentence a model reads.
        assert!(bad.contains("v1-world"), "{}", bad);
        assert!(bad.contains("uncapped"), "a missing ceiling must never be silent: {}", bad);
    }

    #[test]
    fn the_report_says_whose_bytes_it_ran() -> Outcome<()> {
        let script = Script {
            name:   fmt!("probe"),
            file:   fmt!("verify_probe.mjs"),
            path:   PathBuf::from("/w/dev/verify_probe.mjs"),
            breaks: Vec::new(),
            prov:   Provenance::Committed,
        };
        let clean = pass_of("clean", "  ok   one\n");
        let txt = report(&script, &[(clean, None)],
            &Verdict::Unproven { passed: 1, failed: 0, declared: Vec::new() }, &[],
            "[world: none]");
        let first = res!(txt.lines().next().ok_or_else(|| err!("empty report"; Test, Invalid)));
        assert!(first.contains("byte for byte the commit's"),
            "the report's first line must say whose bytes ran: {}", first);
        Ok(())
    }

    #[tokio::test]
    async fn a_verifier_that_rewrites_itself_gets_no_second_run() -> Outcome<()> {
        let root = res!(tree("prov_swap"));
        // Committed, and what it does when it runs is append to its own source. So the
        // clean run is the commit's and the break run is not, which is the race the
        // re-ask before every spawn exists for: no test can hold a file still for the
        // minutes a real sequence takes, and a verifier that changes itself is the same
        // event arriving on schedule.
        let src = "//   node dev/verify_probe.mjs --break swap    # 1: the break\n\
            import fs from 'node:fs';\n\
            console.log('  ok   it ran');\n\
            fs.appendFileSync('dev/verify_probe.mjs', '// and now it is mine\\n');\n";
        res!(git(&root, &["init", "-q"]));
        res!(put(&root, "probe", src));
        res!(git(&root, &["add", "dev/verify_probe.mjs"]));
        res!(git(&root, &["-c", "user.name=T", "-c", "user.email=t@t",
            "commit", "-q", "--no-verify", "-m", "probe"]));
        let script = res!(resolve(&root, "probe").map_err(|w| err!("{}", w; Test, Invalid)));
        assert_eq!(vec![fmt!("swap")], script.breaks);
        assert_eq!(Provenance::Committed, script.prov);
        let node = res!(on_path("node").ok_or_else(|| err!("no node"; Test, Missing)));
        let jdir = root.join("..").join("prov_swap-journal");
        let jdir = PathBuf::from(fmt!("{}", jdir.display()));
        if jdir.exists() {
            res!(fs::remove_dir_all(&jdir).map_err(|e| err!(e, "clearing"; Test, IO)));
        }
        let jr = res!(Journal::open(crate::journal::Cfg::at(&jdir)));
        let job = Job {
            id:     fmt!("swap"),
            root:   root.clone(),
            script,
            breaks: vec![fmt!("swap")],
            node,
            budget: Duration::from_millis(60_000),
            ledger: Ledger::new(Arc::new(Mutex::new(jr)), Arc::new(AtomicBool::new(true))),
            world:  World::None,
            runner: None,
            cap:    Cap::None,
        };
        let (tx, mut rx) = tokio::sync::mpsc::channel(64);
        res!(Box::pin(conduct(job, tx)).await);
        let mut out = String::new();
        while let Some(r) = rx.recv().await {
            if let Resp::Chunk { stream: Stream::Out, data, .. } = r {
                out.push_str(&data);
            }
        }
        assert!(out.contains("BREAK swap"), "the break is not in the report: {}", out);
        assert!(out.contains("NEVER RAN"),
            "the break ran against a file the clean run had rewritten: {}", out);
        assert!(out.contains("stopped being the commit's"),
            "the report does not say why the break never ran: {}", out);
        Ok(())
    }
}
