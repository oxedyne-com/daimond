//! Running a named verifier from the tracked tree, and refusing to report a bare pass.
//!
//! Written on 2026-08-21.  A daimon cannot produce browser evidence: `listen()`
//! is refused by [`crate::seccomp`], a browser needs the display server's unix
//! socket and [`crate::seccomp::Unix::Refuse`] takes that away, so every
//! `dev/verify_*.mjs` that drives a real page dies under the fence a command
//! gets.  Half the proof of a release session is those scripts, so the machine
//! that could write the code could not check it.
//!
//! **The reframe this module was built on, and where it broke.**  A verifier is
//! the repository's own code: the model supplies a *name*, looked up in the
//! directory, and at most a *break*, looked up in the file's own declarations.
//! On that argument it ran outside the command fence until 2026-10-11.
//!
//! [`provenance`] asks whether the working file IS the commit -- membership is
//! not enough, since a tracked file with one comment appended still passes
//! `git ls-files --error-unmatch` -- and [`unfenced_refusal`] is the gate that
//! [`conduct`] passes before anything runs and [`once`] before every spawn.
//!
//! **Provenance says who wrote the bytes, never what they may reach.**  `.git`
//! is inside every mark and every fence leaves it writable, so a daimon commits
//! its own verifier through `run` and the bytes are then, truthfully, the
//! commit's.  On 2026-10-11 that read another Diamond's files
//! (`specs/daimond_verify_unfenced_diag_20261011.md`).  So a verifier and the
//! world it stands now run behind the command fence, scoped to the calling
//! Diamond's mark, with each further root a named need -- see "The fence a
//! verifier runs behind" below.  The provenance gate stays: it is what makes
//! the report's first line true, not what keeps the run contained -- and the
//! git it asks runs behind the same fence, since the repository's config is the
//! daimon's too and git runs what that config names.
//!
//! **The refusal is a capability difference and not a dead end.**  A verifier
//! the daimon has just written still runs through `run`, which is enough for
//! the nine in ten that only read the tree; what `verify` adds is the headless
//! browser's files and a world, and the refusal says so.
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
    TurnRules,
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

/// The name that tells `dev/display.mjs` nobody is at the keyboard for this run.
pub const UNATTENDED_VAR: &str = "DAIMOND_UNATTENDED";

/// The environment a verifier is spawned with: run's, plus the unattended mark.
///
/// Built from nothing, never from the hand's own (rc-b F2, 11 Oct 2026).  The hand
/// inherits the browser's whole environment, the seat and any token in it, and a
/// committed verifier on a networked turn could post that out.  `run` gives a command
/// the caller's pairs and the defaults [`crate::exec::add_defaults`] fills; `verify`
/// carries no pairs, so a verifier gets the defaults alone, then the named needs below.
/// No display arrives, so a headed verifier must start one of its own.
///
/// # Arguments
/// * `node` - The node the sequence runs, found on the hand's own `PATH`.
pub fn unattended_env(node: &Path) -> BTreeMap<String, String> {
    let mut pairs = Vec::new();
    crate::exec::add_defaults(&mut pairs);
    let mut out: BTreeMap<String, String> = pairs.into_iter().collect();
    // Named need: node's own directory first on PATH, so a verifier's `node` child (or
    // world.sh's) is the node the hand found, wherever the owner keeps it.
    if let Some(d) = node.parent().filter(|d| d.is_absolute()) {
        let d = fmt!("{}", d.display());
        let path = out.get("PATH").cloned().unwrap_or_default();
        if !path.split(':').any(|p| p == d) {
            out.insert(fmt!("PATH"), if path.is_empty() { d } else { fmt!("{}:{}", d, path) });
        }
    }
    // Named need: the mark `dev/display.mjs` reads to refuse the seat.
    out.insert(fmt!("{}", UNATTENDED_VAR), fmt!("1"));
    out
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
/// * `root` - The tree the verb would resolve in.
pub fn cap(root: &Path) -> String {
    match available(root) {
        true	=> fmt!("verify:dev"),
        false	=> fmt!("verify:none"),
    }
}

/// The capability saying this hand resolves the verify tree PER REQUEST.
///
/// **The granted root is not the repository, in the case the product is actually
/// for.**  A person grants `~/projects`, which holds a dozen of them, and marks
/// one into a Diamond; the grant is then the parent of a repository and holds no
/// `dev/` of its own, so [`cap`] over it says `verify:none` and the verb refuses
/// every call in a sentence about a folder the model cannot do anything about --
/// measured on 2026-09-15, where four tasks spent 30, 11, 20 and 3 rounds
/// repeating the same refused call.
///
/// So the page sends the folder the turn is working in with each request and the
/// hand answers for THAT tree.  This capability is how a page knows it may: a
/// hand that does not carry it is one that resolves in the granted root alone,
/// and the page keeps the older gate rather than sending a field that would be
/// ignored.  It is a fact about the HAND and never about a folder, which is why
/// it cannot go stale the way [`cap`] can -- a repository cloned into the grant
/// after the handshake is one [`cap`] answers `none` about for the life of the
/// process.
pub const BY_ROOT: &str = "verify:by-root";

/// The capability saying this hand runs every verifier behind [`verifier_fence`].
///
/// A hand older than 11 Oct 2026 ran a committed verifier with the person's whole
/// access, so a Diamond could commit one that read another Diamond's files.  The
/// page refuses `verify` on a hand that does not say this, and tells the person to
/// update it: that hand is the hole, and nothing the page sends can fence it.
pub const FENCED: &str = "verify:fenced";

/// The sentence for a folder that is not a repository, naming the folder.
///
/// **The remedy has to be one the reader can carry out.**  The refusal this
/// replaces told the model to "tell the user which folder they granted", which
/// is a thing a model cannot check and cannot fix, and a refusal whose remedy is
/// out of reach becomes a loop.  This one names the directory that was looked in,
/// so the reader can see whether it is the folder it meant.
///
/// # Arguments
/// * `root` - The tree that was looked in.
/// * `granted` - The hand's grant, said only where it is a different folder.
pub fn none_here(root: &Path, granted: &Path) -> String {
    let inside = match root == granted {
        true	=> fmt!(""),
        false	=> fmt!(" That folder is the one marked into this Diamond, inside the hand's \
            grant of '{}'.", granted.display()),
    };
    fmt!(
        "Refused: '{}' holds no 'dev/verify_*.mjs', so there is nothing in it to verify with.{} \
        This verb runs a REPOSITORY's own verifiers and is not a general test runner; use 'run' \
        for the project's own test command instead. Nothing was run.",
        root.join(DEV_DIR).display(), inside)
}

/// The tree one request resolves in, or the sentence refusing it.
///
/// **The verify tree is the folder the turn is working in, and it is decided per
/// REQUEST.**  It arrives absolute, as every path on this wire does, and it is
/// held to the same three questions a working directory is held to in
/// [`crate::exec::vet_cwd`]: it resolves, it is a directory, and it is inside the
/// grant.  Symbolic links are resolved before the comparison, because a link
/// inside the grant pointing out of it is otherwise a way past the whole
/// arrangement.
///
/// An empty `asked` is a page that named none, and gets the granted root -- which
/// is what every page before this one sent.
///
/// # Arguments
/// * `granted` - The folder this hand may work in, already canonical.
/// * `asked` - What the page sent, absolute or empty.
pub fn vet_root(granted: &Path, asked: &str) -> Result<PathBuf, String> {
    if asked.trim().is_empty() {
        return Ok(granted.to_path_buf());
    }
    let raw = Path::new(asked.trim());
    if !raw.is_absolute() {
        return Err(fmt!(
            "Refused: '{}' is not an absolute path, and the hand does not guess what a verify \
            root is relative to. Nothing was run.", trim_for_message(asked)));
    }
    let dir = match std::fs::canonicalize(raw) {
        Ok(p)  => p,
        Err(e) => return Err(fmt!(
            "Refused: '{}' cannot be resolved to a folder on this machine ({}), so there is no \
            tree to look a verifier up in. Nothing was run.", trim_for_message(asked), e)),
    };
    if !dir.is_dir() {
        return Err(fmt!(
            "Refused: '{}' is a file and not a folder, so it holds no 'dev/' to look a verifier \
            up in. Nothing was run.", dir.display()));
    }
    if !dir.starts_with(granted) {
        return Err(fmt!(
            "Refused: '{}' is outside '{}', the folder this hand was granted, so nothing there is \
            this hand's to run. Nothing was run.", dir.display(), granted.display()));
    }
    Ok(dir)
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
            "Refused: '{}' has no readable '{}' directory ({}), so there are no verifiers in it \
            to run.", root.display(), dir.display(), e)),
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
        "Refused: there is no '{}' in '{}', so '{}' names no verifier there. {} Nothing was run.",
        wanted, root.join(DEV_DIR).display(), trim_for_message(name), tail)
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
/// **The answer is advisory, not a boundary.**  The daimon can write this tree's
/// `.git` from a fenced `run`, so it can forge a commit, an index or a config that
/// makes git say "committed" about bytes it chose.  What keeps a Diamond's files its
/// own is the fence every verifier runs behind; this check only stops a report from
/// claiming an edited verifier is the commit's.  And because the config is the
/// daimon's, git runs whatever it names -- an fsmonitor, a filter, a textconv -- so
/// git itself is started behind the verifier fence with no network, through the one
/// spawn path ([`crate::exec::fenced_command`]), never from the hand directly.  Until
/// 2026-10-11 it was a bare `Command`, and a repository-local config entry copied
/// another Diamond's file into this one while `ls-files` read the index.
///
/// Every argument vector is fixed but for one directory entry's own name, and
/// there is no shell, so `--` before it is belt to the braces.
///
/// # Arguments
/// * `root` - The granted root, which is where git is asked.
/// * `file` - The verifier's file name, from the directory entry.
/// * `rules` - The turn's read-only and deny rules, as the verifier itself gets them.
pub async fn provenance(
    launcher:   &crate::exec::Launcher,
    root:       &Path,
    file:       &str,
    rules:      Option<&TurnRules>,
)
    -> Provenance
{
    let git = match on_path("git") {
        Some(p) => p,
        None    => return Provenance::Unknown(fmt!(
            "there is no git on this hand's PATH, so nothing here can say whose code this is")),
    };
    let rel = fmt!("{}/{}", DEV_DIR, file);
    // A private home and temporary directory, so git finds no user config it cannot read
    // behind the fence and anything a hook writes outside the mark has somewhere to go.
    let mut tmp = match crate::exec::Scratch::make(&fmt!("prov-{}", file)) {
        Ok(t)  => t,
        Err(e) => return Provenance::Unknown(fmt!(
            "git could not be given a private directory to run in ({})", e.msgs().join(" "))),
    };
    let fence = verifier_fence(root, tmp.dir(), false, rules);
    let env   = prov_env(tmp.dir());
    let ask   = Git { launcher, git: &git, root, fence: &fence, env: &env };
    let answer = provenance_asked(&ask, root, &rel).await;
    let _ = tmp.remove();
    answer
}

/// The three questions, in order; see [`provenance`].
async fn provenance_asked(ask: &Git<'_>, root: &Path, rel: &str) -> Provenance {
    match ask.status(&["rev-parse", "--git-dir"]).await {
        Ok(Some(0))	=> (),
        Ok(_)		=> return Provenance::Unknown(fmt!(
            "the folder this hand was granted is not a git repository, so there is no commit \
            to compare this file with")),
        Err(e)		=> return Provenance::Unknown(fmt!("git could not be run: {}", e)),
    }
    // Asked without following the link, which is the whole point: `metadata` above
    // followed it and answered about the target.
    match std::fs::symlink_metadata(root.join(rel)) {
        Ok(m) if m.file_type().is_symlink()	=> return Provenance::Changed(Change::Linked),
        Ok(_)					=> (),
        Err(e)					=> return Provenance::Unknown(fmt!(
            "'{}' could not be looked at ({})", rel, e)),
    }
    match ask.status(&["ls-files", "--error-unmatch", "--", rel]).await {
        Ok(Some(0))	=> (),
        Ok(_)		=> return Provenance::Changed(Change::Untracked),
        Err(e)		=> return Provenance::Unknown(fmt!("git could not be run: {}", e)),
    }
    // `git diff` says 0 for no difference and 1 for a difference; anything else is git
    // failing to answer, and an unborn HEAD in a repository with no commits is exactly
    // that.  A failure to answer is never read as agreement.
    match ask.status(&["diff", "--quiet", "HEAD", "--", rel]).await {
        Ok(Some(0))	=> Provenance::Committed,
        Ok(Some(1))	=> Provenance::Changed(Change::Edited),
        Ok(c)		=> Provenance::Unknown(fmt!(
            "git could not compare '{}' with the commit (it exited {}); a repository with no \
            commit in it yet is the usual reason", rel, match c {
                Some(c) => fmt!("{}", c),
                None    => fmt!("on a signal"),
            })),
        Err(e)		=> Provenance::Unknown(fmt!("git could not be run: {}", e)),
    }
}

/// How long one git question may take before it is killed: a configured fsmonitor that
/// never answers must not hold the verb for its whole budget.
const PROV_TIMEOUT: Duration = Duration::from_secs(30);

/// Git's environment for a provenance question: the hand's `PATH` for the filters a
/// repository names, and every home and temporary name pointed at the private scratch.
fn prov_env(scratch: &Path) -> Vec<(String, String)> {
    let mut env = Vec::new();
    if let Ok(p) = std::env::var("PATH") {
        env.push((fmt!("PATH"), p));
    }
    let s = fmt!("{}", scratch.display());
    env.push((fmt!("HOME"), s.clone()));
    env.push((fmt!("XDG_CONFIG_HOME"), s.clone()));
    for k in crate::exec::TMP_VARS {
        env.push((fmt!("{}", k), s.clone()));
    }
    env
}

/// One repository's git, started fenced for each question.
struct Git<'a> {
    launcher:   &'a crate::exec::Launcher,
    git:        &'a Path,
    root:       &'a Path,
    fence:      &'a FenceSpec,
    env:        &'a [(String, String)],
}

impl<'a> Git<'a> {

    /// Runs `git -C <root> <args>` behind the fence and gives its exit code, `None` for a
    /// signal.  A launcher that could not fence it exits with its own codes (125 to 127),
    /// which every caller reads as git failing to answer, never as an answer.
    async fn status(&self, args: &[&str]) -> Result<Option<i32>, String> {
        let mut argv = vec![
            fmt!("{}", self.git.display()), fmt!("-C"), fmt!("{}", self.root.display())];
        argv.extend(args.iter().map(|a| fmt!("{}", a)));
        let crate::exec::Fenced { mut cmd, payload, .. } = match crate::exec::fenced_command(
            self.launcher, &[], self.fence, &argv, self.env, self.root, false)
        {
            Ok(f)  => f,
            Err(s) => return Err(s),
        };
        cmd.stdout(Stdio::null());
        cmd.stderr(Stdio::null());
        let mut child = match cmd.spawn() {
            Ok(c)  => c,
            Err(e) => return Err(fmt!("the launcher that fences it could not be started ({})", e)),
        };
        let pgid = child.id().unwrap_or(0);
        if let Some(mut w) = child.stdin.take() {
            use tokio::io::AsyncWriteExt;
            tokio::spawn(async move {
                if w.write_all(&payload).await.is_ok() {
                    let _ = w.shutdown().await;
                }
            });
        }
        match tokio::time::timeout(PROV_TIMEOUT, child.wait()).await {
            Ok(Ok(s))  => match s.code() {
                Some(c) if c >= crate::exec::EXIT_NO_PLAN && c <= crate::exec::EXIT_EXEC_FAILED =>
                    Err(fmt!("the launcher could not fence it (exit {})", c)),
                c => Ok(c),
            },
            Ok(Err(e)) => Err(fmt!("{}", e)),
            Err(_)     => {
                if pgid != 0 {
                    let _ = crate::exec::signal_group(pgid, Sig::Kill).await;
                }
                Err(fmt!("it did not answer within {} s", PROV_TIMEOUT.as_secs()))
            },
        }
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
/// runs the same file through `run`, which is enough for the nine verifiers in
/// ten here that only read the tree; it says what that cannot do -- `run`'s fence
/// lends no browser and stands no world -- so a failure there is not misread as
/// the verifier being broken; and it names the commit that makes `verify` take it.
///
/// # Arguments
/// * `prov` - What [`provenance`] answered, asked as late as the caller could.
/// * `file` - The verifier's file name, from the directory entry.
pub fn unfenced_refusal(prov: &Provenance, file: &str) -> Option<String> {
    let why = match prov {
        Provenance::Committed	=> return None,
        Provenance::Changed(c)	=> fmt!("{}", c.phrase()),
        Provenance::Unknown(w)	=> fmt!("{}", w),
    };
    Some(fmt!(
        "Refused: dev/{} is not this repository's committed code -- {}. Nothing was run. \
        'verify' reports only on bytes that are the commit's, because its report says so; \
        this hand cannot tell your edit from anybody else's. RUN IT YOURSELF INSTEAD: 'run' \
        with [\"node\",\"dev/{}\"] runs this same file inside your own command fence, \
        which lends it neither the headless browser nor a world, so a page verifier fails \
        there for that reason and not for its own. To have 'verify' report on it, commit \
        the file and ask again.",
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

    /// The fence with the journal denied in it, or why the fence reaches the journal.
    ///
    /// Exactly the two questions the dispatcher asks of a command's fence before it runs.
    pub fn guard(&self, fence: &FenceSpec) -> Result<FenceSpec, String> {
        let g = match self.jr.lock() {
            Ok(g)  => g,
            Err(_) => return Err(fmt!("the hand's journal lock is poisoned")),
        };
        if let Err(e) = g.check_fence(fence) {
            return Err(e.msgs().join(" "));
        }
        Ok(g.fence_guard(fence))
    }
}

// ┌───────────────────────────────────────────────────────────────┐
// │ The fence a verifier runs behind                               │
// └───────────────────────────────────────────────────────────────┘
//
// 2026-10-11, and the reason this section exists: until then a verifier ran with NO fence,
// on the strength of its bytes being the commit's.  `.git` is inside every mark and every
// fence leaves it writable, so a daimon committed `dev/verify_pwn.mjs` through its own `run`,
// called `verify`, and read another Diamond's nonce (specs/daimond_verify_unfenced_diag_
// 20261011.md).  Provenance says who wrote the bytes; it never said what they may reach.
//
// So a verifier, and the world it stands, now go through `exec::fenced_command` exactly as a
// command does -- the same Landlock plan, the same seccomp filter, the same launcher -- with
// the calling Diamond's mark as the one writable root.  Every root beyond the mark is a named
// need, listed below with why.  What is deliberately NOT lent:
//
// * The display socket.  AF_UNIX stays refused by seccomp, because on Landlock below ABI 9 a
//   granted socket file cannot be told apart from the session bus, and the bus starts
//   processes outside every fence.  A verifier drives a HEADLESS browser, which needs none.
// * Other toolchain caches (`~/.cache/daimond` and the like).  They hold other worlds'
//   scratch and are not this Diamond's.

/// Read-only roots under the home directory a verifier may need, beyond its own mark.
pub const VERIFY_NEEDS_RO: &[&str] = &[
    ".cache/ms-playwright",	// the headless browser dev/harness.mjs drives
    ".nvm",					// node, where it is installed per user rather than in /usr
    ".red-pw/node_modules",	// playwright-core, which dev/pw.mjs loads by path first
];

/// The fence a verifier and its world run behind: the mark, the run's scratch, and the
/// named needs that exist on this machine.
///
/// `net` is the page's answer to the question `run` asks on the same turn, by the same
/// function, so a verifier is never a wider way out than a command: a committed verifier
/// that cannot read another Diamond must not be able to post this one's files anywhere
/// either.  There is no loopback-only middle: Landlock scopes TCP by port and never by
/// host, so a world (which binds and is connected to on loopback) stands only on a turn
/// whose commands may reach the network too.
///
/// The turn's read-only and deny rules are carried as `run` carries them (rc-b F3, 11 Oct
/// 2026): the mark is writable only where `run` could write it, a read-only subtree inside
/// it stays read-only, and every deny holds.  With no rules -- a page older than the field
/// -- the mark is read-only, the narrower of the two answers.
///
/// # Arguments
/// * `net` - Whether the turn's `run` would be given the network.
/// * `rules` - The read-only and deny lists of `run`'s fence on the same turn.
pub fn verifier_fence(root: &Path, scratch: &Path, net: bool, rules: Option<&TurnRules>) -> FenceSpec {
    let mut ro = Vec::new();
    if let Some(h) = crate::exec::home_dir() {
        for tail in VERIFY_NEEDS_RO {
            let p = Path::new(&h).join(tail);
            if p.exists() {
                ro.push(fmt!("{}", p.display()));
            }
        }
    }
    // Compared resolved, so a symlinked spelling on either side cannot make a read-only
    // mark look like a different, writable one.
    let real = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let mroot = real(root);
    let mut rw = vec![fmt!("{}", scratch.display())];
    let mut deny = Vec::new();
    match rules {
        None => ro.push(fmt!("{}", root.display())),
        Some(r) => {
            let locked = r.ro.iter().any(|q| mroot.starts_with(real(Path::new(q))));
            if locked {
                ro.push(fmt!("{}", root.display()));
            } else {
                rw.insert(0, fmt!("{}", root.display()));
                // Nested read-only subtrees, which the hand carves out of the writable mark.
                for q in &r.ro {
                    if real(Path::new(q)).starts_with(&mroot) {
                        ro.push(fmt!("{}", q));
                    }
                }
            }
            deny.extend(r.deny.iter().cloned());
        },
    }
    FenceSpec { rw, ro, deny, net }
}

/// What a fenced verify spawn records as in force, as a command's record does.
fn fence_mechs() -> Vec<String> {
    let mut v = crate::exec::detected_fence().caps();
    v.extend(crate::exec::detected_seccomp().caps());
    v.push(fmt!("net:open"));
    v
}

/// Starts `argv` behind the verifier fence, under the job's memory ceiling, with standard
/// output and error piped and the launcher's plan already on its way down standard input.
///
/// # Arguments
/// * `scratch` - Writable beside the mark, and where `TMPDIR` points.
fn spawn_fenced(
    job:     &Job,
    argv:    &[String],
    env:     &BTreeMap<String, String>,
    scratch: &Path,
)
    -> Result<tokio::process::Child, String>
{
    let fence = match job.ledger.guard(&verifier_fence(&job.root, scratch, job.net, job.rules.as_ref())) {
        Ok(f)  => f,
        Err(s) => return Err(s),
    };
    // The hand's own environment, less what the launcher refuses outright -- the loader's
    // family, which a test binary or a packaged browser may carry -- and less the scratch
    // names, which are the hand's to answer.  Dropped rather than refused: nobody asked
    // for them, so no caller is left believing a setting took effect.
    let mut pairs: Vec<(String, String)> = env.iter()
        .filter(|(k, _)| !crate::exec::loads_code(k)
            && !crate::exec::TMP_VARS.iter().any(|t| t.eq_ignore_ascii_case(k)))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    // Last, so the hand's answer outranks anything the environment carried.
    for k in crate::exec::TMP_VARS {
        pairs.push((fmt!("{}", k), fmt!("{}", scratch.display())));
    }
    let crate::exec::Fenced { mut cmd, payload, .. } = match crate::exec::fenced_command(
        &job.launcher, &job.cap.wrap(&[]), &fence, argv, &pairs, &job.root, false)
    {
        Ok(f)  => f,
        Err(s) => return Err(s),
    };
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    let mut child = match cmd.spawn() {
        Ok(c)  => c,
        Err(e) => return Err(fmt!("the launcher that fences it could not be started ({})", e)),
    };
    // The plan, then end-of-file: a verifier reads no input.
    if let Some(mut w) = child.stdin.take() {
        tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            if w.write_all(&payload).await.is_ok() {
                let _ = w.shutdown().await;
            }
        });
    }
    Ok(child)
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
// So this verb stands one, behind the same verifier fence the verifier gets, with
// the world's own scratch as its writable second root.  The provenance gate covers
// the three files a world is made of, which is why [`world_up`] asks about all
// three and not just the verifier.
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

/// How long a world's group is given to end on TERM before it is sent KILL.
pub const WORLD_DOWN_MS: u64 = 10_000;

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
        Ok(())	=> fmt!("stood for this sequence and torn down (its group ended, :{} :{} :{} free)",
            a, m, g),
        Err(w)	=> fmt!("TEARDOWN FAILED: {}", w),
    };
    fmt!("[world: {} — app :{}, mock :{}, gateway :{} down (/api refuses), scratch {}/w{}, {} — {}]",
        n, a, m, g, scratch, n, cap.phrase(), tail)
}

/// The world line a REFUSAL carries, so a refusal is read the way a report is.
///
/// A refusal short-circuits [`report`], so until 2026-09-14 it named neither the
/// world nor the hand -- and a `verify` that answered with no `[world:` line at
/// all was, from the seat, indistinguishable from a hand too old to know the
/// word.  The two are opposite faults and they need opposite answers, so the
/// refusal says which it is.
pub fn refused_world_line() -> String {
    fmt!("[world: none — one was asked for and could not be stood; the sentence above says why]")
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
    scratch: PathBuf,
    n:       u8,
    pgid:    u32,
    armed:   bool,
}

impl WorldGuard {
    pub fn arm(up: &WorldUp) -> Self {
        Self {
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
        // The group kill only, and never the script: `dev/world.sh` is in the mark, a daimon
        // can commit it, and a `Drop` has no way to put it behind the fence. The world's
        // servers were started in the launcher's group, so the kill reaches them.
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
    pub launcher: crate::exec::Launcher, // what applies the fence; the runner's own, so one code path
    pub net:    bool,                       // what `run` gets on the same turn, never more
    pub rules:  Option<TurnRules>,          // run's ro/deny on the same turn; None = mark read-only
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

/// The environment `dev/world.sh` is given: a verifier's, plus the world's root.
///
/// The three variables `world.sh` HONOURS cannot arrive, since the environment is built
/// from nothing, so the register decides the world's ports.
///
/// # Arguments
/// * `node` - The sequence's node.
/// * `scratch` - The world's own scratch.
fn world_env(node: &Path, scratch: &Path) -> BTreeMap<String, String> {
    let mut env = unattended_env(node);
    // Named need: where `world.sh` stands the world.
    env.insert(fmt!("{}", WORLD_ROOT_VAR), fmt!("{}", scratch.display()));
    env
}

/// What a script said on the way out, from both ends of its standard error.
///
/// The first non-empty line and the last, joined where they differ.  A refusal is
/// at the top and a death is at the bottom, and a report that carries only one of
/// the two is a report that names the wrong half of the failures.
///
/// # Arguments
/// * `err` - Everything the child wrote to standard error.
fn said_by(err: &str) -> String {
    let lines: Vec<&str> = err.lines().map(|l| l.trim()).filter(|l| !l.is_empty()).collect();
    match (lines.first(), lines.last()) {
        (None, _) | (_, None)	=> fmt!("it said nothing"),
        (Some(a), Some(b))	=> match a == b {
            true	=> fmt!("{}", a),
            false	=> fmt!("{} … {}", a, b),
        },
    }
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
        let prov = provenance(&job.launcher, &job.root, part, job.rules.as_ref()).await;
        if !prov.committed() {
            return Err(fmt!(
                "dev/{} is {}. A world is made of these three files and every one of them runs \
                behind the same fence as the verifier -- so the same rule holds for them. Commit it \
                and ask again.", part, prov.phrase()));
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

    // Behind the verifier fence like the verifier itself: `dev/world.sh` is in the mark,
    // and a daimon can commit it as easily as a verifier.
    let argv = vec![
        fmt!("bash"),
        fmt!("{}/{}", DEV_DIR, WORLD_SH),
        fmt!("{}", n),
        fmt!("--up"),
    ];
    // Recorded before the process exists, with the REAL argument vector, the fence it
    // runs behind and the mechanisms in force.
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
        fence:      verifier_fence(&job.root, &scratch, job.net, job.rules.as_ref()),
        toolkits:   Vec::new(),
        meter:    None,
    }, &[fence_mechs(), vec![fmt!("verify:world"), fmt!("mem:{}", job.cap.phrase())]].concat());
    if let Some(ev) = ev {
        if let Err(e) = job.ledger.record(&ev) {
            let _ = std::fs::remove_file(&lock);
            return Err(fmt!("it could not be written to the journal ({})",
                e.msgs().join(" ")));
        }
    }

    // In its own group (the launcher's), so the dev server and the mock `--up` leaves
    // behind are reachable by one number afterwards -- which is what makes them stoppable
    // through `runs` and what `Bye` kills.  `TMPDIR` is the world's own scratch, which the
    // survivors go on writing in after the script returns.
    let child = match spawn_fenced(job, &argv, &world_env(&job.node, &scratch), &scratch) {
        Ok(c)  => c,
        Err(e) => {
            let _ = std::fs::remove_file(&lock);
            return Err(fmt!("dev/world.sh could not be started: {}", e));
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
        // THE SCRIPT'S OWN WORDS AND ITS OWN EXIT, not a sentence composed over them.
        // `--up` refuses at the top (a port held, an identity probe that answered wrong)
        // and it also dies at the bottom (a node that would not start), and only the first
        // of those is the FIRST line of its standard error -- so both ends are carried
        // when they differ.  Written because the same fault in the other direction cost
        // 2026-09-13's turn 54: a dying script's error reached the model nowhere and it
        // spent nineteen steps guessing at what had gone wrong.
        return Err(fmt!("world {} (app :{}, mock :{}): {} — dev/{} {} --up {}",
            n, world_ports(n).0, world_ports(n).1, said_by(&err), WORLD_SH, n,
            match out.status.code() {
                Some(c) => fmt!("exited {}", c),
                None    => fmt!("was killed by a signal"),
            }));
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
/// **The hand owns a world's lifetime, and `dev/world.sh --down` is never run.**  The
/// script is in the mark, so a daimon can commit it; and run behind the fence it starts
/// in a new Landlock domain, which may not signal the servers `--up` started in another
/// (signals are scoped to the domain), so it failed every time and the group kill below
/// did the work anyway.  The hand started the group, so the hand ends it: TERM, then KILL
/// if it outlives [`WORLD_DOWN_MS`].  "Torn down" is said only when no process is left in
/// the group and the three ports answer free; the bookkeeping is never believed instead.
///
/// # Arguments
/// * `job` - The sequence.
/// * `up` - The world.
/// * `clean` - Whether the sequence's verdict was clean, which decides whether the
///   world's `serve.out`, `mock.out` and browser profiles are kept for reading.
async fn world_down(job: &Job, up: &WorldUp, clean: bool) -> Result<(), String> {
    let (a, m, g) = world_ports(up.n);
    let mut killed = false;
    let _ = crate::exec::signal_group(up.pgid, Sig::Term).await;
    let mut left = world_left(up.pgid, [a, m, g]).await;
    let until = tokio::time::Instant::now() + Duration::from_millis(WORLD_DOWN_MS);
    while !left.is_empty() && tokio::time::Instant::now() < until {
        tokio::time::sleep(Duration::from_millis(100)).await;
        left = world_left(up.pgid, [a, m, g]).await;
    }
    if !left.is_empty() {
        killed = true;
        let _ = crate::exec::signal_group(up.pgid, Sig::Kill).await;
        let until = tokio::time::Instant::now() + Duration::from_millis(2_000);
        while !left.is_empty() && tokio::time::Instant::now() < until {
            tokio::time::sleep(Duration::from_millis(100)).await;
            left = world_left(up.pgid, [a, m, g]).await;
        }
    }
    let ended = Event::Ended {
        id:        fmt!("{}#world", job.id),
        exit:      match left.is_empty() { true => 0, false => 1 },
        timed_out: false,
        killed,
        out_bytes: 0,
        err_bytes: 0,
    };
    if let Err(e) = job.ledger.record(&ended) {
        eprintln!("daimond-hand: a world's teardown was not journalled: {}", e);
    }
    if !left.is_empty() {
        return Err(fmt!(
            "{} still held after the group was sent TERM and then KILL; it is listed by runs \
            as '{}' and can be stopped there", left.join(", "), up.run_id));
    }
    if let Some(r) = &job.runner {
        let _ = r.forget(&up.run_id);
    }
    let _ = std::fs::remove_file(up.scratch.join(fmt!("w{}.lock", up.n)));
    // A red sequence keeps its serve.out, mock.out and profiles, because those are what
    // the daimon reads next. A clean one leaves nothing: a browser profile is tens of
    // megabytes and this directory is inside the repository.
    if clean {
        let _ = std::fs::remove_dir_all(up.scratch.join(fmt!("w{}", up.n)));
    }
    Ok(())
}

/// What of a world is still standing: its group, if anybody is in it, and each held port.
///
/// Empty is the one answer that means torn down.  A group the machine would not answer
/// about counts as standing, because "could not tell" is not "gone".
///
/// # Arguments
/// * `pgid` - The group `--up` ran in.
/// * `ports` - The world's app, mock and gateway ports.
async fn world_left(pgid: u32, ports: [u16; 3]) -> Vec<String> {
    let mut left = Vec::new();
    match crate::exec::group_standing(pgid).await {
        Some(false)	=> {},
        Some(true)	=> left.push(fmt!("its group {}", pgid)),
        None		=> left.push(fmt!("its group {} (the machine would not say)", pgid)),
    }
    for p in ports {
        if !port_free(p) {
            left.push(fmt!(":{}", p));
        }
    }
    left
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
    let argv = argv_for(job, brk);
    // A private directory to write temporary files in, removed when the run ends: the
    // mark is the only other writable root, and a browser's profile does not belong there.
    let mut tmp = match crate::exec::Scratch::make(&fmt!("{}-{}", job.id, label)) {
        Ok(t)  => t,
        Err(e) => return Err(fmt!("it could not be given a private temporary directory ({})",
            e.msgs().join(" "))),
    };
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
        fence:      verifier_fence(&job.root, tmp.dir(), job.net, job.rules.as_ref()),
        toolkits:   Vec::new(),
        meter:    None,
    }, &[fence_mechs(), vec![fmt!("verify:tracked-script"), fmt!("mem:{}", job.cap.phrase())]]
        .concat());
    if let Some(ev) = ev {
        if let Err(e) = job.ledger.record(&ev) {
            return Err(fmt!("it could not be written to the journal ({})", e.msgs().join(" ")));
        }
    }

    // Asked again, as late as anything on this side can be. The sequence has been
    // running for minutes by the time a late break starts, and a command an earlier turn
    // left in the background can rewrite a file in that time.
    let prov = provenance(&job.launcher, &job.root, &job.script.file, job.rules.as_ref()).await;
    if let Some(no) = unfenced_refusal(&prov, &job.script.file) {
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
    // Run's environment with the mark put in, and the world's block over the top of it
    // (named need: the harness reads these names and nothing else, and the fault this verb
    // was written for is a verifier aimed at a world it was never given).
    let mut env = unattended_env(&job.node);
    for (k, v) in world.iter() {
        env.insert(k.clone(), v.clone());
    }
    // Behind the command fence, scoped to this Diamond's mark: see "The fence a verifier
    // runs behind". In its own group, so a budget spent takes the browser with it.
    let mut child = match spawn_fenced(job, &argv, &env, tmp.dir()) {
        Ok(c)  => c,
        Err(e) => {
            let _ = tmp.remove();
            return Err(fmt!("node could not be started: {}", e));
        },
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
    let _ = tmp.remove();
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
    let prov = provenance(&job.launcher, &job.root, &job.script.file, job.rules.as_ref()).await;
    if let Some(no) = unfenced_refusal(&prov, &job.script.file) {
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
                guard = Some(WorldGuard::arm(&u));
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
                        "Refused: no world could be stood for dev/{} — {}. Nothing was run.\n{}\n{}",
                        job.script.file, w, refused_world_line(), hand_line()),
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
    let text  = report(&job.script, &prov, &passes, &verdict, &shots, &world_note);
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
/// * `prov` - Whose bytes it was, as asked before the sequence ran.
/// * `passes` - The clean run first, then each break with what it did.
/// * `verdict` - What the sequence proved.
/// * `shots` - Pictures this sequence wrote, workspace-relative.
/// * `world` - The `[world: …]` line, which says which dev world this ran in or
///   why it ran in none.
pub fn report(
    script:  &Script,
    prov:    &Provenance,
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
        prov.phrase()));
    s.push_str(
        "Run behind the command fence, scoped to this Diamond's folder, and only while these \
        bytes are the commit's -- that was checked against the commit before each run, and a \
        verifier that differs from it is refused rather than reported.\n");
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
    const LAUNCH_CHILD: &str = "DAIMOND_HAND_TEST_VERIFY_LAUNCHER";

    /// The launcher entry point, reached only in a re-executed test binary.
    #[test]
    fn launcher_child_entry() {
        if std::env::var(LAUNCH_CHILD).is_err() {
            return;
        }
        crate::exec::launch_main()
    }

    /// A launcher that re-enters this test binary at [`launcher_child_entry`].
    fn test_launcher() -> Outcome<crate::exec::Launcher> {
        let exe = res!(std::env::current_exe().map_err(|e| err!(e,
            "The verify tests need to know their own binary."; Test, IO)));
        Ok(crate::exec::Launcher::Explicit {
            prog: exe,
            args: vec![
                fmt!("verify::tests::launcher_child_entry"),
                fmt!("--exact"),
                fmt!("--nocapture"),
                // Or libtest prints the test's name with no newline, and the child's first
                // line -- a world's first export, a verifier's first check -- is glued to it.
                fmt!("--quiet"),
                fmt!("--test-threads=1"),
            ],
            env:  vec![(fmt!("{}", LAUNCH_CHILD), fmt!("1"))],
        })
    }

    use super::*;

    // A turn whose `run` may write its mark: no read-only rule, no deny.
    static OPEN_RULES: TurnRules = TurnRules { ro: Vec::new(), deny: Vec::new() };

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
        // The hand as the browser starts it inherits the seat; the verifier's
        // environment is built from nothing, so none of it can arrive.
        let out = unattended_env(Path::new("/usr/bin/node"));
        for v in ["DISPLAY", "WAYLAND_DISPLAY", "XDG_SESSION_TYPE"] {
            assert!(!out.contains_key(v),
                "{} reached a verifier, so a headed one could paint on the seat", v);
        }
        assert_eq!(Some(&fmt!("1")), out.get(UNATTENDED_VAR),
            "the run was not marked unattended, so dev/display.mjs would allow :0");
    }

    #[test]
    fn a_verifier_gets_runs_names_and_the_mark_only() {
        // run's defaults (HOME, PATH) and the mark: nothing else.
        let out = unattended_env(Path::new("/usr/bin/node"));
        let names: Vec<&str> = out.keys().map(|k| k.as_str()).collect();
        for k in &names {
            assert!(["HOME", "PATH", UNATTENDED_VAR].contains(k), "{} was added: {:?}", k, out);
        }
        assert!(out.contains_key("PATH"), "no PATH: {:?}", out);
        // /usr/bin is already in the fixed list, so it is not added twice.
        assert_eq!(Some(&fmt!("{}", crate::exec::PATH_FALLBACK)), out.get("PATH"));
    }

    #[test]
    fn a_verifier_finds_the_node_the_hand_found() {
        let out = unattended_env(Path::new("/opt/nodes/v22/bin/node"));
        assert_eq!(Some(&fmt!("/opt/nodes/v22/bin:{}", crate::exec::PATH_FALLBACK)), out.get("PATH"));
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
            launcher: res!(test_launcher()),
            net:    true,
            rules:  Some(TurnRules::default()),
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
        };
        let verdict = Verdict::Unproven { passed: 0, failed: 0, declared: Vec::new() };
        let text = report(&script, &Provenance::Committed, &[(p, None)], &verdict, &[], "[world: none]");
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
        let text = report(&script, &Provenance::Committed, &[(clean, None), (brk, Some(what))], &v, &[], "[world: none]");
        let last = match text.lines().filter(|l| !l.is_empty()).last() {
            Some(l) => l,
            None    => return Err(err!("the report is empty"; Test)),
        };
        assert!(last.starts_with(TRAILER), "the last line is {:?}", last);
        assert!(text.contains("RED: b went red"), "{}", text);
        assert!(text.contains("behind the command fence"),
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
        let text = report(&script, &Provenance::Committed, &[(clean, None)], &v, &[], "[world: none]");
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

    // ── A grant that holds several repositories ─────────────────────
    //
    // The case the product is actually for, and the case the real-repository bank
    // ran into on 2026-09-15: the hand is granted the folder the projects live in,
    // and ONE of them is marked into the Diamond.  The grant's own root then holds
    // no `dev/` at all, so a verify tree fixed at the grant answers `none` about a
    // folder nobody asked about -- and answered it 64 times across four tasks.

    /// A parent holding two repositories and one folder that is neither.
    ///
    /// Named by its caller, because `tree` clears what it makes and these tests run
    /// beside each other.
    fn grant_of_two(name: &str) -> Outcome<PathBuf> {
        let base = res!(tree(name));
        for (repo, name) in [("alpha", "alef"), ("beta", "bet")] {
            let dir = base.join(repo);
            res!(fs::create_dir_all(dir.join(DEV_DIR))
                .map_err(|e| err!(e, "making {:?}", dir; Test, IO)));
            res!(put(&dir, name, "//\n"));
        }
        res!(fs::create_dir_all(base.join("notes"))
            .map_err(|e| err!(e, "making the non-repository"; Test, IO)));
        Ok(base)
    }

    #[test]
    fn a_request_names_which_of_the_grants_repositories_it_means() -> Outcome<()> {
        let grant = res!(grant_of_two("grant_two_which"));
        // `tree` makes a `dev/` of its own at the grant, which would make the parent
        // a repository and the whole distinction disappear.
        res!(fs::remove_dir_all(grant.join(DEV_DIR))
            .map_err(|e| err!(e, "clearing the grant's own dev"; Test, IO)));
        assert_eq!(fmt!("verify:none"), cap(&grant),
            "the parent of two repositories was read as one");

        let alpha = match vet_root(&grant, &fmt!("{}", grant.join("alpha").display())) {
            Ok(p)  => p,
            Err(e) => return Err(err!("a mark on 'alpha' was refused: {}", e; Test, Invalid)),
        };
        assert_eq!(fmt!("verify:dev"), cap(&alpha));
        assert_eq!(vec![fmt!("alef")], res!(catalogue(&alpha)));

        let beta = match vet_root(&grant, &fmt!("{}", grant.join("beta").display())) {
            Ok(p)  => p,
            Err(e) => return Err(err!("a mark on 'beta' was refused: {}", e; Test, Invalid)),
        };
        assert_eq!(vec![fmt!("bet")], res!(catalogue(&beta)),
            "the tree a request named answered with another tree's verifiers");
        // And the one that is not in the tree it named is REFUSED there, which is
        // the whole of what "answers for that root" means.
        match resolve(&beta, "alef") {
            Ok(_)  => return Err(err!(
                "'alef' resolved in 'beta', which does not hold it"; Test, Invalid)),
            Err(s) => assert!(s.contains("beta"), "the refusal names no tree: {}", s),
        }
        Ok(())
    }

    #[test]
    fn a_mark_that_is_not_a_repository_is_refused_with_the_folder_named() -> Outcome<()> {
        let grant = res!(grant_of_two("grant_two_notes"));
        let notes = match vet_root(&grant, &fmt!("{}", grant.join("notes").display())) {
            Ok(p)  => p,
            Err(e) => return Err(err!("a mark on 'notes' was refused early: {}", e; Test, Invalid)),
        };
        assert!(!available(&notes), "a folder with no dev/ was read as a repository");
        let why = none_here(&notes, &grant);
        assert!(why.starts_with("Refused:"), "{}", why);
        assert!(why.contains("notes/dev"), "the refusal does not name the folder: {}", why);
        assert!(why.contains(&fmt!("{}", grant.display())),
            "the refusal does not name the grant it sits in: {}", why);
        assert!(why.contains("Nothing was run"), "{}", why);
        Ok(())
    }

    #[test]
    fn a_verify_root_is_held_to_the_grant() -> Outcome<()> {
        let grant = res!(grant_of_two("grant_two_vetted"));
        // Named nothing: the granted root, which is what every page before this sent.
        match vet_root(&grant, "") {
            Ok(p)  => assert_eq!(grant, p),
            Err(e) => return Err(err!("an empty root was refused: {}", e; Test, Invalid)),
        }
        for (asked, want) in [
            ("alpha",                  "not an absolute path"),
            ("/no/such/folder/at/all", "cannot be resolved"),
        ] {
            match vet_root(&grant, asked) {
                Ok(p)  => return Err(err!(
                    "'{}' was taken as a verify root ({:?})", asked, p; Test, Invalid)),
                Err(s) => assert!(s.contains(want), "'{}' said {:?}", asked, s),
            }
        }
        // A file is not a tree, and the sentence says which it is.
        let file = grant.join("alpha").join(DEV_DIR).join("verify_alef.mjs");
        match vet_root(&grant, &fmt!("{}", file.display())) {
            Ok(_)  => return Err(err!("a file was taken as a verify root"; Test, Invalid)),
            Err(s) => assert!(s.contains("is a file"), "{}", s),
        }
        // OUTSIDE the grant, which is the one that matters: the page composes this
        // path and the page is not the thing the grant is being kept from, but a
        // root the grant does not reach is a tree this hand has no business in.
        let outside = match grant.parent() {
            Some(p) => p.to_path_buf(),
            None    => return Err(err!("the fixture has no parent"; Test, Missing)),
        };
        match vet_root(&grant, &fmt!("{}", outside.display())) {
            Ok(_)  => return Err(err!("a root outside the grant was taken"; Test, Invalid)),
            Err(s) => assert!(s.contains("outside"), "{}", s),
        }
        Ok(())
    }

    // ── Whose code is this? ─────────────────────────────────────────
    //
    // `REVIEW.md` §1.21, and 2026-10-11.  Provenance decides whether a verifier
    // runs at all; the fence decides what a run may reach, and the second does not
    // lean on the first -- a daimon can commit its own verifier.  The fixture
    // verifier's body writes a file OUTSIDE the granted root, so the marker's
    // existence is the measurement: no provenance, committed or not, may leave it.

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
        said:    String,			// the report, where one was sent
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
        attempt_net(root, name, marker, true).await
    }

    /// [`attempt`], with the turn's network named.
    async fn attempt_net(root: &Path, name: &str, marker: &Path, net: bool) -> Outcome<Attempt> {
        attempt_ruled(root, name, marker, net, Some(TurnRules::default())).await
    }

    /// [`attempt_net`], with the turn's read-only and deny rules named.
    async fn attempt_ruled(
        root:   &Path,
        name:   &str,
        marker: &Path,
        net:    bool,
        rules:  Option<TurnRules>,
    )
        -> Outcome<Attempt>
    {
        if marker.exists() {
            res!(fs::remove_file(marker).map_err(|e| err!(e, "clearing {:?}", marker; Test, IO)));
        }
        let node = res!(on_path("node").ok_or_else(|| err!(
            "Every verifier is a Node script and there is no node on PATH, so this test would \
            prove nothing about whether one ran.";
            Test, Missing)));
        let script = match resolve(root, name) {
            Ok(s)  => s,
            Err(w) => return Ok(Attempt {
                refused: Some(w), escaped: marker.exists(), said: String::new() }),
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
            launcher: res!(test_launcher()),
            net,
            rules,
        };
        let (tx, mut rx) = tokio::sync::mpsc::channel(64);
        // Boxed, so the whole sequence's future lives on the heap. Inlined, `conduct`
        // holds `once` holds `drain`'s buffers, and a debug build of that overflows a
        // test thread's stack before the first process starts.
        res!(Box::pin(conduct(job, tx)).await);
        let mut refused = None;
        let mut said    = String::new();
        while let Some(r) = rx.recv().await {
            match r {
                Resp::Refused { reason, .. } => refused = Some(reason),
                Resp::Chunk { data, .. }     => said.push_str(&data),
                _                            => {},
            }
        }
        Ok(Attempt { refused, escaped: marker.exists(), said })
    }

    #[tokio::test]
    async fn a_committed_verifier_reaches_nothing_outside_its_mark() -> Outcome<()> {
        // The hand-level form of the 2026-10-11 proof: a daimon commits a verifier
        // through its own `run`, so the bytes ARE the commit's, and asks `verify` for
        // it.  It must run -- refusing everything would pass the rest of this test and
        // make the verb useless -- and it must neither write nor read past the mark.
        let root   = res!(tree("prov_committed"));
        let marker = PathBuf::from(fmt!("{}", root.join("..").join("prov_committed.escaped").display()));
        let secret = PathBuf::from(fmt!("{}", root.join("..").join("prov_committed.secret").display()));
        let nonce  = "THEIRS-7f3a91c2";
        res!(fs::write(&secret, nonce).map_err(|e| err!(e, "writing {:?}", secret; Test, IO)));
        res!(git(&root, &["init", "-q"]));
        res!(put(&root, "probe", &fmt!(
            "import fs from 'node:fs';\n\
            try {{ fs.writeFileSync({:?}, 'escaped\\n'); console.log('  FAIL wrote outside'); }} \
            catch (e) {{ console.log(e.code === 'EACCES' ? '  ok   write refused' : '  FAIL write ' + e.code); }}\n\
            try {{ console.log('  FAIL read ' + fs.readFileSync({:?}, 'utf8')); }} \
            catch (e) {{ console.log(e.code === 'EACCES' ? '  ok   read refused' : '  FAIL read ' + e.code); }}\n",
            fmt!("{}", marker.display()), fmt!("{}", secret.display()))));
        res!(git(&root, &["add", "dev/verify_probe.mjs"]));
        res!(git(&root, &["-c", "user.name=T", "-c", "user.email=t@t",
            "commit", "-q", "--no-verify", "-m", "probe"]));
        let a = res!(attempt(&root, "probe", &marker).await);
        assert!(a.refused.is_none(), "the committed case must run: {:?}", a.refused);
        // Both checks pass only on the fence's own EACCES, so a count of two is the
        // measurement and not merely a sign that the file ran.
        assert!(a.said.contains("2 passed, 0 failed"),
            "the committed verifier reached past its mark, or did not run: {}", a.said);
        assert!(!a.escaped, "a committed verifier wrote outside its mark: {}", a.said);
        assert!(!a.said.contains(nonce),
            "a committed verifier read a file outside its mark: {}", a.said);
        Ok(())
    }

    /// No link, shared-memory or named-need door takes a verifier past its mark.
    ///
    /// rc-b's lead proof, 11 Oct 2026: a symlink or hard link made inside the mark must not
    /// read a file outside it, nor plant one outside it; `/dev/shm` is not lent at all; and the
    /// browser's packages under `~/.red-pw/node_modules` are lent read-only, which the control
    /// read shows, so the refused write is the fence's and not a missing folder.
    #[tokio::test]
    async fn a_verifier_reaches_past_its_mark_by_no_link_shm_or_named_need() -> Outcome<()> {
        let root   = res!(tree("prov_links"));
        let marker = PathBuf::from(fmt!("{}", root.join("..").join("prov_links.escaped").display()));
        let secret = PathBuf::from(fmt!("{}", root.join("..").join("prov_links.secret").display()));
        let nonce  = "THEIRS-5b0e72d4";
        res!(fs::write(&secret, nonce).map_err(|e| err!(e, "writing {:?}", secret; Test, IO)));
        let home = res!(std::env::var("HOME").map_err(|e| err!(e, "reading HOME"; Test, Configuration)));
        let pw   = PathBuf::from(&home).join(".red-pw/node_modules");
        let has_pw = pw.join("playwright-core").is_dir(); // only where the browser is installed
        let probe = r#"import fs from 'node:fs';
const no = (label, f) => { try { f(); console.log('  FAIL ' + label + ' was allowed'); return true; }
	catch (e) { console.log((['EACCES', 'EPERM', 'EXDEV', 'EROFS'].includes(e.code) ? '  ok   ' : '  FAIL ')
		+ label + ' ' + e.code); return false; } };
no('read through a planted symlink', () => console.log('  leaked ' + fs.readFileSync('dev/planted', 'utf8')));
no('symlink in, then read', () => { fs.symlinkSync('@SECRET@', 'dev/lnk');
	console.log('  leaked ' + fs.readFileSync('dev/lnk', 'utf8')); });
no('hard link in, then read', () => { fs.linkSync('@SECRET@', 'dev/hard');
	console.log('  leaked ' + fs.readFileSync('dev/hard', 'utf8')); });
no('hard link out', () => fs.linkSync('dev/verify_probe.mjs', '@MARKER@'));
no('symlink out', () => fs.symlinkSync('x', '@MARKER@'));
const shm = '/dev/shm/daimond-verify-probe-' + process.pid;
if (no('shm write', () => fs.writeFileSync(shm, 'x'))) fs.unlinkSync(shm);
no('shm list', () => fs.readdirSync('/dev/shm'));
if (@PW@) {
	const w = '@NEED@/daimond-verify-probe-' + process.pid;
	if (no('named need write', () => fs.writeFileSync(w, 'x'))) fs.unlinkSync(w);
	console.log(fs.readdirSync('@NEED@').includes('playwright-core') ? '  ok   named need read' : '  FAIL named need read');
}
"#
            .replace("@SECRET@", &fmt!("{}", secret.display()))
            .replace("@MARKER@", &fmt!("{}", marker.display()))
            .replace("@NEED@", &fmt!("{}", pw.display()))
            .replace("@PW@", if has_pw { "true" } else { "false" });
        res!(git(&root, &["init", "-q"]));
        res!(put(&root, "probe", &probe));
        // A symlink already in the mark, as a checkout or an earlier turn could leave one.
        let planted = root.join(DEV_DIR).join("planted");
        res!(std::os::unix::fs::symlink(&secret, &planted)
            .map_err(|e| err!(e, "planting {:?}", planted; Test, IO)));
        res!(git(&root, &["add", "dev/verify_probe.mjs"]));
        res!(git(&root, &["-c", "user.name=T", "-c", "user.email=t@t",
            "commit", "-q", "--no-verify", "-m", "probe"]));
        let a = res!(attempt(&root, "probe", &marker).await);
        assert!(a.refused.is_none(), "the committed case must run: {:?}", a.refused);
        let want = if has_pw { "9 passed, 0 failed" } else { "7 passed, 0 failed" };
        assert!(a.said.contains(want), "a verifier reached past its mark: {}", a.said);
        assert!(!a.escaped, "a verifier planted a file outside its mark: {}", a.said);
        assert!(!a.said.contains(nonce), "a verifier read a file outside its mark: {}", a.said);
        Ok(())
    }

    /// A verifier on a turn whose commands have no network reaches no port, loopback included.
    ///
    /// rc-b, 11 Oct 2026: with the read escape closed, an open network would have made a
    /// committed verifier the way to post the mark's files out instead.  `run` is given the
    /// network only when the turn's question says so; `verify` now takes the same answer, and
    /// Landlock scopes TCP by port, never by host, so "no" means every TCP connect is refused.
    /// The same verifier on a "yes" turn connects, so the refusal is the fence's and not a
    /// broken probe.
    #[tokio::test]
    async fn a_verifier_without_the_turns_network_connects_nowhere() -> Outcome<()> {
        let l = res!(std::net::TcpListener::bind("127.0.0.1:0")
            .map_err(|e| err!(e, "binding a loopback listener"; Test, IO)));
        let port = res!(l.local_addr().map_err(|e| err!(e, "reading its port"; Test, IO))).port();
        let root   = res!(tree("prov_netless"));
        let marker = PathBuf::from(fmt!("{}", root.join("..").join("prov_netless.escaped").display()));
        res!(git(&root, &["init", "-q"]));
        res!(put(&root, "probe", &fmt!(
            "import net from 'node:net';\n\
            const probe = (host, port, label) => new Promise(r => {{\n\
            \tconst s = net.connect({{ host, port }});\n\
            \ts.setTimeout(3000);\n\
            \ts.on('connect', () => {{ console.log('  FAIL CONNECTED ' + label); s.destroy(); r(); }});\n\
            \ts.on('error', e => {{ console.log((e.code === 'EACCES' ? '  ok   ' : '  FAIL ') + label + ' ' + e.code); r(); }});\n\
            \ts.on('timeout', () => {{ console.log('  FAIL ' + label + ' timed out'); s.destroy(); r(); }});\n\
            }});\n\
            await probe('127.0.0.1', {}, 'loopback refused');\n\
            await probe('192.0.2.1', 80, 'outside refused');\n", port)));
        res!(git(&root, &["add", "dev/verify_probe.mjs"]));
        res!(git(&root, &["-c", "user.name=T", "-c", "user.email=t@t",
            "commit", "-q", "--no-verify", "-m", "probe"]));
        let no = res!(attempt_net(&root, "probe", &marker, false).await);
        assert!(no.refused.is_none(), "the committed case must run: {:?}", no.refused);
        assert!(no.said.contains("2 passed, 0 failed") && !no.said.contains("CONNECTED"),
            "a verifier on a turn without the network reached a port: {}", no.said);
        let yes = res!(attempt_net(&root, "probe", &marker, true).await);
        assert!(yes.said.contains("CONNECTED loopback"),
            "the control could not connect on a turn WITH the network: {}", yes.said);
        drop(l);
        Ok(())
    }

    /// A verifier is handed run's environment, never the hand's own.
    ///
    /// rc-b F2, 11 Oct 2026: the hand inherits the browser's whole environment, so any
    /// token in it reached a committed verifier and, on a networked turn, could leave.
    /// The sentinel stands for that token; HOME, PATH and the unattended mark are the
    /// names a verifier is given and must still arrive.
    #[tokio::test]
    async fn a_verifier_sees_none_of_the_hands_environment() -> Outcome<()> {
        let sentinel = "DAIMOND_F2_SENTINEL_TOKEN";
        // Safe in edition 2021; the name is this test's alone.
        std::env::set_var(sentinel, "leaked-9c41");
        let root   = res!(tree("prov_envless"));
        let marker = PathBuf::from(fmt!("{}", root.join("..").join("prov_envless.escaped").display()));
        res!(git(&root, &["init", "-q"]));
        res!(put(&root, "probe", &fmt!(
            "const e = process.env;\n\
            console.log('  names ' + Object.keys(e).sort().join(','));\n\
            console.log(e[{:?}] === undefined ? '  ok   sentinel absent' : '  FAIL sentinel present');\n\
            for (const k of ['HOME', 'PATH', {:?}]) \
            console.log(e[k] ? '  ok   ' + k + ' present' : '  FAIL ' + k + ' missing');\n",
            sentinel, UNATTENDED_VAR)));
        res!(git(&root, &["add", "dev/verify_probe.mjs"]));
        res!(git(&root, &["-c", "user.name=T", "-c", "user.email=t@t",
            "commit", "-q", "--no-verify", "-m", "probe"]));
        let a = res!(attempt(&root, "probe", &marker).await);
        std::env::remove_var(sentinel);
        assert!(a.refused.is_none(), "the committed case must run: {:?}", a.refused);
        assert!(a.said.contains("4 passed, 0 failed"),
            "the verifier was handed the hand's environment, or lost a name it needs: {}", a.said);
        Ok(())
    }

    /// A verifier writes nowhere `run` could not: a read-only mark, a read-only subtree of a
    /// writable one, and a page too old to say are all read-only to it, and a deny holds.
    ///
    /// rc-b F3, 11 Oct 2026: `verifier_fence` made the first mark writable whatever the turn
    /// said, so a committed verifier on a read-only mark could change it.  The open turn is
    /// the control: the same probe writes there, so the refusals are the fence's.
    #[tokio::test]
    async fn a_verifier_keeps_the_turns_read_only_and_deny_rules() -> Outcome<()> {
        let root   = res!(tree("prov_rofirst"));
        let marker = PathBuf::from(fmt!("{}", root.join("..").join("prov_rofirst.escaped").display()));
        let sub    = root.join("kept");
        let hid    = root.join("hidden");
        let free   = root.join("free");
        for d in [&sub, &hid, &free] {
            res!(fs::create_dir_all(d).map_err(|e| err!(e, "making {:?}", d; Test, IO)));
        }
        res!(fs::write(hid.join("s.txt"), "HID-55e1").map_err(|e| err!(e, "writing"; Test, IO)));
        res!(git(&root, &["init", "-q"]));
        let probe = |p: &Path| fmt!(
            "try {{ fs.writeFileSync({:?}, 'x'); console.log('  FAIL WROTE {}'); }} \
            catch (e) {{ console.log('  FAIL REFUSED {} ' + e.code); }}\n",
            fmt!("{}", p.display()), p.display(), p.display());
        res!(put(&root, "probe", &fmt!(
            "import fs from 'node:fs';\n{}{}{}\
            try {{ console.log('  FAIL READ ' + fs.readFileSync({:?}, 'utf8')); }} \
            catch (e) {{ console.log('  FAIL UNREAD ' + e.code); }}\n\
            console.log('  ok   ran');\n",
            probe(&root.join("w.txt")), probe(&sub.join("w.txt")), probe(&free.join("w.txt")),
            fmt!("{}", hid.join("s.txt").display()))));
        res!(git(&root, &["add", "dev/verify_probe.mjs"]));
        res!(git(&root, &["-c", "user.name=T", "-c", "user.email=t@t",
            "commit", "-q", "--no-verify", "-m", "probe"]));
        // Every observation is printed as a FAIL line because the report carries only those;
        // the assertions below read them, not the counts.
        let at = |p: &Path| fmt!("{}", p.display());
        let wrote = |a: &Attempt, p: &Path| a.said.contains(&fmt!("WROTE {}", p.display()));
        let clean = |p: &Path| { let _ = fs::remove_file(p); };
        // Control: the open turn writes both places and reads the file.
        let open = res!(attempt(&root, "probe", &marker).await);
        assert!(wrote(&open, &root.join("w.txt")) && wrote(&open, &sub.join("w.txt"))
            && open.said.contains("READ HID-55e1"), "the control could not write or read: {}", open.said);
        clean(&root.join("w.txt")); clean(&sub.join("w.txt"));
        // A read-only first mark.
        let ro = TurnRules { ro: vec![at(&root)], deny: Vec::new() };
        let a = res!(attempt_ruled(&root, "probe", &marker, false, Some(ro)).await);
        assert!(a.refused.is_none(), "the read-only case must still run: {:?}", a.refused);
        assert!(!wrote(&a, &root.join("w.txt")) && !wrote(&a, &sub.join("w.txt")),
            "a verifier wrote into a read-only mark: {}", a.said);
        clean(&root.join("w.txt")); clean(&sub.join("w.txt"));
        // An older page, which sends no rules.
        let a = res!(attempt_ruled(&root, "probe", &marker, false, None).await);
        assert!(!wrote(&a, &root.join("w.txt")),
            "a verifier from a page without rules wrote into the mark: {}", a.said);
        clean(&root.join("w.txt"));
        // A writable mark with a read-only subtree and a denied one. The hand carves such a
        // mark one rule per child, as it does for `run`, so the root's own entries take no new
        // file and the write is measured in a sibling directory.
        let mixed = TurnRules { ro: vec![at(&sub)], deny: vec![at(&hid)] };
        let a = res!(attempt_ruled(&root, "probe", &marker, false, Some(mixed)).await);
        assert!(wrote(&a, &free.join("w.txt")), "the writable mark was not writable: {}", a.said);
        assert!(!wrote(&a, &sub.join("w.txt")), "a read-only subtree was written: {}", a.said);
        assert!(!a.said.contains("HID-55e1"), "a denied subtree was read: {}", a.said);
        clean(&free.join("w.txt")); clean(&sub.join("w.txt"));
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
        let prov = provenance(&res!(test_launcher()), &root, &script.file, Some(&OPEN_RULES)).await;
        println!("script  {:?}\nprov    {}\nbreaks  {:?}",
            script.path, prov.phrase(), script.breaks);
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
            launcher: res!(test_launcher()),
            net:    true,
            rules:  Some(TurnRules::default()),
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
        // Inside the mark: the fence would refuse it one level up.
        let marker = root.join("prov_seat.saw");
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
            "the refusal must say what makes 'verify' take the file: {}", no);
        assert!(no.contains("browser"),
            "the refusal must say what the fenced route cannot do, or a daimon will read the \
            fenced run's failure as the verifier being broken: {}", no);
        Ok(())
    }

    #[tokio::test]
    async fn a_verifier_that_is_a_symlink_is_not_the_commit_whatever_git_says() -> Outcome<()> {
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
        let prov = provenance(&res!(test_launcher()), &root, "verify_probe.mjs", Some(&OPEN_RULES)).await;
        assert_eq!(Provenance::Changed(Change::Linked), prov,
            "a committed symlink read as the commit's own bytes");
        let no = res!(unfenced_refusal(&prov, "verify_probe.mjs").ok_or_else(|| err!(
            "a committed symlink was allowed to run unfenced"; Test, Invalid)));
        assert!(no.contains("symbolic link"), "{}", no);
        Ok(())
    }

    #[tokio::test]
    async fn membership_is_not_content_and_this_is_where_the_two_part() -> Outcome<()> {
        let l = res!(test_launcher());
        let root = res!(tree("prov_parts"));
        res!(git(&root, &["init", "-q"]));
        res!(put(&root, "probe", "console.log('  ok   one');\n"));
        res!(git(&root, &["add", "dev/verify_probe.mjs"]));
        res!(git(&root, &["-c", "user.name=T", "-c", "user.email=t@t",
            "commit", "-q", "--no-verify", "-m", "probe"]));
        let prov = provenance(&l, &root, "verify_probe.mjs", Some(&OPEN_RULES)).await;
        assert_eq!(Provenance::Committed, prov);
        assert!(unfenced_refusal(&prov, "verify_probe.mjs").is_none());

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
        assert_eq!(Provenance::Changed(Change::Edited), provenance(&l, &root, "verify_probe.mjs", Some(&OPEN_RULES)).await,
            "the check followed the index rather than the bytes");
        Ok(())
    }

    /// **The repository's config is the daimon's, so whatever it names runs fenced.**
    ///
    /// The 2026-10-11 review's F1: a fenced `run` can write the mark's `.git/config`, and
    /// git runs the commands that config names while it reads the index.  Each of the
    /// three doors below copies a file from a sibling "Diamond B" to a marker outside the
    /// mark; asked from the hand unfenced, the copy lands.  Each also touches a file inside
    /// the mark, which the fence allows, so a green run is not one where git simply never
    /// consulted the config.
    #[tokio::test]
    async fn repository_config_runs_nothing_outside_the_fence() -> Outcome<()> {
        let root   = res!(tree("prov_config"));
        let b      = root.join("..").join("prov_config.b");
        let _      = fs::remove_dir_all(&b);
        res!(fs::create_dir_all(&b).map_err(|e| err!(e, "making {:?}", b; Test, IO)));
        let secret = b.join("secret");
        res!(fs::write(&secret, "B's own\n").map_err(|e| err!(e, "writing {:?}", secret; Test, IO)));
        let marker = root.join("..").join("prov_config.pwned");
        let _      = fs::remove_file(&marker);
        let fired  = root.join(".fired");
        res!(git(&root, &["init", "-q"]));
        res!(put(&root, "probe", "console.log('  ok   one');\n"));
        res!(git(&root, &["add", "dev/verify_probe.mjs"]));
        res!(git(&root, &["-c", "user.name=T", "-c", "user.email=t@t",
            "commit", "-q", "--no-verify", "-m", "probe"]));
        // Written the way a daimon's `run` would: plain repository config, plus an
        // attributes file to aim the filter and the diff driver at the verifier.
        let cmd = fmt!("touch {} ; cat {} > {}", fired.display(), secret.display(), marker.display());
        res!(git(&root, &["config", "core.fsmonitor", &cmd]));
        res!(git(&root, &["config", "filter.x.clean", &fmt!("{} ; cat", cmd)]));
        res!(git(&root, &["config", "diff.x.textconv", &fmt!("{} ; cat", cmd)]));
        res!(git(&root, &["config", "alias.ls-files", &fmt!("!{}", cmd)]));
        res!(fs::write(root.join(".gitattributes"), "dev/* filter=x diff=x\n")
            .map_err(|e| err!(e, "writing attributes"; Test, IO)));
        // A touch to the file's time, so git must look at the bytes rather than trust the
        // index's stat, which is the path a filter runs on.
        res!(put(&root, "probe", "console.log('  ok   one');\n"));
        let _ = provenance(&res!(test_launcher()), &root, "verify_probe.mjs", Some(&OPEN_RULES)).await;
        assert!(!marker.exists(),
            "provenance ran repository config outside the fence: {:?} holds Diamond B's file",
            marker);
        assert!(fired.exists(),
            "none of the configured commands ran at all, so this test proves nothing");
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
    /// verifier, and that the hand ends the world's group on every way out -- so
    /// `--up` leaves one stand-in server (a `sleep`) in the group and writes its
    /// pid down, and `--down` must never be asked for at all.
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
            \tsleep 300 </dev/null >/dev/null 2>&1 &\n\
            \techo $! > \"$DAIMOND_WORLD_ROOT/server.pid\"\n\
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
        standing: bool,				// its stand-in server outlived the sequence
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
            launcher: res!(test_launcher()),
            net:    true,
            rules:  Some(TurnRules::default()),
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
        // The stand-in server `--up` left, asked of the machine: gone, or a zombie
        // nobody has reaped yet, is ended; anything else is a world left standing.
        let server = fs::read_to_string(root.join(WORLD_SCRATCH).join("server.pid"))
            .unwrap_or_default();
        let server = server.trim();
        let standing = !server.is_empty()
            && match fs::read_to_string(fmt!("/proc/{}/stat", server)) {
                Ok(st) => st.rsplit_once(')').map(|(_, t)| !t.trim_start().starts_with('Z'))
                    .unwrap_or(true),
                Err(_) => false,
            };
        Ok(Ran { refused, out, actions, standing })
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
        assert_eq!(vec!["up"], verbs(&r.actions),
            "dev/world.sh was asked for more than --up: {:?}", r.actions);
        assert!(!r.standing, "the world was not taken down (its server outlived the sequence): {:?}", r.actions);
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
        assert_eq!(vec!["up"], verbs(&r.actions),
            "dev/world.sh was asked for more than --up: {:?}", r.actions);
        assert!(!r.standing, "a sequence refused after the world came up left it standing (its server outlived the sequence): {:?}", r.actions);
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
        assert_eq!(vec!["up"], verbs(&r.actions),
            "dev/world.sh was asked for more than --up: {:?}", r.actions);
        assert!(!r.standing, "a spent budget left the world standing (its server outlived the sequence): {:?}", r.actions);
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
    async fn a_dropped_guard_kills_the_group_and_never_runs_the_script()
        -> Outcome<()>
    {
        // The path that survives a panic or an aborted task. `dev/world.sh` is in the mark and
        // a `Drop` cannot fence it, so the guard frees the lock and kills the group, and the
        // script -- which a daimon can commit -- is never run from here.
        let root = res!(world_tree("world_guard",
            "console.log('  ok   it ran');\n", ""));
        let scratch = root.join(WORLD_SCRATCH);
        res!(fs::create_dir_all(&scratch).map_err(|e| err!(e, "making the scratch"; Test, IO)));
        let lock = scratch.join("w41.lock");
        res!(fs::write(&lock, "").map_err(|e| err!(e, "taking the lock"; Test, IO)));
        let up = WorldUp {
            n:       41,
            pgid:    0,	// no group: the fixture starts nothing, and 0 is never signalled
            env:     Vec::new(),
            scratch: scratch.clone(),
            rel:     fmt!("{}", WORLD_SCRATCH),
            run_id:  fmt!("w1-world"),
        };
        {
            let g = WorldGuard::arm(&up);
            assert!(g.armed());
        }
        assert_eq!("", fs::read_to_string(scratch.join("actions.txt")).unwrap_or_default(),
            "a dropped guard ran dev/world.sh outside the fence");
        assert!(!lock.exists(), "a dropped guard left the world's lock");
        res!(fs::write(&lock, "").map_err(|e| err!(e, "taking the lock again"; Test, IO)));
        {
            let mut g = WorldGuard::arm(&up);
            g.disarm();
            assert!(!g.armed());
        }
        assert!(lock.exists(), "a disarmed guard freed a lock the ordinary path owns");
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
    fn a_world_that_could_not_be_stood_hands_back_the_scripts_own_words() {
        // Both ends, because `--up` refuses at the top and dies at the bottom, and a
        // report carrying one of the two names the wrong half of the failures.
        assert_eq!("it said nothing", said_by("\n  \n"));
        assert_eq!("only line", said_by("only line\n"));
        assert_eq!("only line", said_by("\nonly line\n\nonly line\n"),
            "two identical ends were printed twice");
        let both = said_by("world 41: :8818 is held by something else\n  \nnode: not found\n");
        assert_eq!("world 41: :8818 is held by something else … node: not found", both);
    }

    #[test]
    fn a_refusal_names_the_world_and_the_hand_the_way_a_report_does() {
        // A refusal short-circuits `report`, so it carried neither -- and a verify that
        // answered with no `[world:` line at all was, from the seat, the same shape as a
        // hand too old to know the word. Opposite faults, opposite answers.
        let w = refused_world_line();
        assert!(w.starts_with("[world: none"), "{}", w);
        assert!(w.contains("could not be stood"), "{}", w);
        let h = hand_line();
        assert!(h.starts_with("[hand: "), "{}", h);
        assert!(h.ends_with(']'), "{}", h);
    }

    #[test]
    fn the_report_says_whose_bytes_it_ran() -> Outcome<()> {
        let script = Script {
            name:   fmt!("probe"),
            file:   fmt!("verify_probe.mjs"),
            path:   PathBuf::from("/w/dev/verify_probe.mjs"),
            breaks: Vec::new(),
        };
        let clean = pass_of("clean", "  ok   one\n");
        let txt = report(&script, &Provenance::Committed, &[(clean, None)],
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
        assert_eq!(Provenance::Committed,
            provenance(&res!(test_launcher()), &root, &script.file, Some(&OPEN_RULES)).await);
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
            launcher: res!(test_launcher()),
            net:    true,
            rules:  Some(TurnRules::default()),
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
