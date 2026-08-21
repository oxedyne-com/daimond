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
//! The fence exists to contain a command a MODEL wrote.  A verifier is tracked
//! repository code, and the model supplies no part of it: it supplies a *name*
//! that is looked up in the directory, and at most a *break* that is looked up
//! in the file's own declarations.  So the verb is in the same trust class as
//! `cargo test`, and it runs the script outside the command fence deliberately
//! -- which is stated in the report, stated in the tool's description, and
//! recorded in the journal as `fence:none` so that nobody has to take this
//! paragraph's word for it.
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
    Stream,
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

/// Whether the tree agrees that a file is under version control.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Tracked {
    /// `git ls-files` names it.
    Yes,
    /// `git ls-files` does not name it.
    No,
    /// Nothing could be asked, and this is why.
    ///
    /// Reported rather than assumed either way.  Four verifiers were once
    /// promoted into `dev/` and left untracked, and `dev/gate.sh` builds its
    /// tree with `git worktree add` -- a clean checkout of a commit -- so the
    /// suite ran none of them while reporting a pass.
    Unknown(String),
}

impl Tracked {
    /// The phrase the report carries.
    pub fn phrase(&self) -> String {
        match self {
            Self::Yes		=> fmt!("tracked"),
            Self::No		=> fmt!("NOT TRACKED -- a clean checkout of this commit would not have it"),
            Self::Unknown(w)	=> fmt!("trackedness unknown ({})", w),
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
    /// Whether git knows about it.
    pub tracked: Tracked,
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
        tracked: tracked_by_git(root, &file_str),
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

/// Whether git names this file, asked of git rather than assumed.
///
/// `git ls-files --error-unmatch` answers with an exit status and nothing else,
/// which is all that is wanted.  The argument vector is fixed and its one
/// variable element is a directory entry's own name; there is no shell, so
/// `--` before it is belt to the braces rather than the whole defence.
///
/// # Arguments
/// * `root` - The granted root, which is where git is asked.
/// * `file` - The verifier's file name, from the directory entry.
fn tracked_by_git(root: &Path, file: &str) -> Tracked {
    let git = match on_path("git") {
        Some(p) => p,
        None    => return Tracked::Unknown(fmt!("git is not on this hand's PATH")),
    };
    let out = std::process::Command::new(git)
        .arg("-C").arg(root)
        .arg("ls-files").arg("--error-unmatch").arg("--")
        .arg(fmt!("{}/{}", DEV_DIR, file))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    match out {
        Ok(s) if s.success()	=> Tracked::Yes,
        Ok(_)			=> Tracked::No,
        Err(e)			=> Tracked::Unknown(fmt!("git could not be run: {}", e)),
    }
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
/// * `announce` - Where to send [`Resp::Started`], for the first run only.
async fn once(
    job:      &Job,
    brk:      Option<&str>,
    left:     Duration,
    announce: Option<&Sender<Resp>>,
)
    -> Result<Pass, String>
{
    let label = match brk {
        Some(b) => fmt!("{}", b),
        None    => fmt!("clean"),
    };
    let argv = argv_for(job, brk);
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
        fmt!("net:open"),
    ]);
    if let Some(ev) = ev {
        if let Err(e) = job.ledger.record(&ev) {
            return Err(fmt!("it could not be written to the journal ({})", e.msgs().join(" ")));
        }
    }

    let started = std::time::Instant::now();
    let mut cmd = Command::new(&job.node);
    for a in argv.iter().skip(1) {
        cmd.arg(a);
    }
    cmd.current_dir(&job.root);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.kill_on_drop(true);
    let mut child = match cmd.spawn() {
        Ok(c)  => c,
        Err(e) => return Err(fmt!("node could not be started ({})", e)),
    };
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
            // The budget is up. The child is asked to go; anything it started of its own
            // (a browser, a server) is not this module's to find, and the report says so.
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
    Ok(Pass {
        label,
        exit,
        timed,
        norm: normalise(&text),
        checks,
        fails,
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
    let mut left  = job.budget;
    let mut seq_err = 0u64;
    let began     = std::time::SystemTime::now();

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
    let note = say_err(fmt!("  ..   clean run of dev/{}\n", job.script.file), &mut seq_err);
    let _ = tx.send(note).await;
    let clean = match once(&job, None, left, Some(&tx)).await {
        Ok(p)  => p,
        Err(w) => {
            let _ = tx.send(Resp::Refused {
                id:     fmt!("{}", job.id),
                reason: fmt!(
                    "Refused: the clean run of dev/{} did not happen -- {}. Nothing was \
                    measured, so there is no result to report.", job.script.file, w),
            }).await;
            return Ok(());
        },
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
        let note = say_err(fmt!("  ..   --break {}\n", b), &mut seq_err);
        let _ = tx.send(note).await;
        match once(&job, Some(b.as_str()), left, None).await {
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
    let shots = shots_since(&job.root, began);
    let text  = report(&job.script, &passes, &verdict, &shots);
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

/// The whole report, which is the only thing the model reads.
///
/// # Arguments
/// * `script` - The verifier.
/// * `passes` - The clean run first, then each break with what it did.
/// * `verdict` - What the sequence proved.
/// * `shots` - Pictures this sequence wrote, workspace-relative.
pub fn report(
    script:  &Script,
    passes:  &[(Pass, Option<Bite>)],
    verdict: &Verdict,
    shots:   &[String],
)
    -> String
{
    let mut s = String::new();
    s.push_str(&fmt!("dev/{} — {} run{}, {}\n",
        script.file,
        passes.len(),
        match passes.len() { 1 => "", _ => "s" },
        script.tracked.phrase()));
    s.push_str(
        "Run OUTSIDE the command fence, because a verifier is tracked repository code and not \
        a command anybody's model wrote. It reaches this machine as any script you run yourself \
        would.\n\n");
    for (p, what) in passes.iter() {
        match what {
            None => {
                s.push_str(&fmt!("CLEAN            {} passed, {} failed, exit {}, {} ms\n",
                    p.passed(), p.failed(), p.exit, p.ms));
                for f in p.fails.iter() {
                    s.push_str(&fmt!("     {}\n", f));
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
        Pass {
            label:  fmt!("{}", label),
            exit:   0,
            timed:  false,
            checks: parse_checks(out),
            norm:   normalise(out),
            fails:  Vec::new(),
            ms:     1,
        }
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
        let text = report(&script, &[(clean, None), (brk, Some(what))], &v, &[]);
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
        let text = report(&script, &[(clean, None)], &v, &[]);
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
}
