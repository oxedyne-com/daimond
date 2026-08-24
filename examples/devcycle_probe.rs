//! Can a daimon do a day's work in this app?  The instrument for the one question
//! nothing else here asks.
//!
//! ## Why it exists
//!
//! On 2026-08-23 the owner gave a daimon one small, exactly specified change to make in
//! this repository.  It read a 19 KB memory index nobody asked for, was told by this app
//! that this app's own 1.6 MB UI source was a binary file, fell back to reading it through
//! `run sed`, spent two turns on malformed `grep` calls, and had consumed about 78 KB of
//! context before its first edit.  He stopped the turn.
//!
//! **690 library tests and roughly 270 gate checks were green throughout, and every one of
//! them was right.**  That is not an oversight in any of them.  It is a consequence of the
//! shape they share: each asserts that a named thing does a named thing, and every named
//! thing was working.  What failed was the LOOP -- a real model, the real tools, the real
//! tree, and the marks the owner actually uses, all in the room together.  Nothing in this
//! repository puts them in a room.
//!
//! So this is not another verifier.  It is a probe, for the same reason
//! `dev/probe_details.sh` is one: a scripted mock cannot answer "can a model do this with
//! these tools", because the mock is the part that would have to be intelligent.
//!
//! ## What it measures, and the third one is the point
//!
//! For each task, three things, and a task passes only on all three:
//!
//!   1. **It got there.**  The check below the task says what "there" is, in terms of the
//!      tree or the answer, never in terms of what the model said about itself.
//!   2. **It did not flail.**  No refused call, no failed call.  A turn that reaches the
//!      right answer through three refusals found a fault and worked around it, which is
//!      what the owner has been doing by hand and what this exists to stop.
//!   3. **It stayed inside a budget** -- tool calls, and bytes of tool output taken into
//!      context.  This is the one that catches the 23rd.  Every fault that day was
//!      survivable on its own; what made the turn unusable was the total.  A harness that
//!      asserted only (1) would have passed the run the owner killed.
//!
//! The budget is in BYTES OF TOOL OUTPUT rather than in tokens billed, because that is the
//! quantity the app controls and the one that compounds: a tool result enters the
//! conversation once and is re-sent on every later round of the turn.  Reading 39 KB to
//! learn how to invoke a script is not one mistake, it is one mistake times the number of
//! rounds still to come.
//!
//! ## Run it at the owner's marks, never at a fixture
//!
//! `MARK` below is a real directory in the real tree, and two of the tasks are marked at
//! `~/usr/code` -- 590,000 files -- because that is what he marked.  A tidy fixture cannot
//! see either of the faults that matter: the binary refusal needs the actual 1.6 MB file
//! with its actual NUL at byte 1,113,118, and the walk cap needs a reach large enough for
//! `WALK_ENTRIES_MAX` to bite.  Both would be invisible in a 200-line fixture, which is
//! exactly how they survived this long.
//!
//! ## It spends, and it says so first
//!
//! One turn per task against a real provider.  The worst case is printed before the first
//! call, and `PROBE_YES=1` is required to skip the pause.
//!
//! ```bash
//! PROBE_SELFTEST=1 cargo run --example devcycle_probe -p oxedyne_daimond   # free
//! DAIMOND_PROBE_KEY=sk-or-v1-... cargo run --example devcycle_probe -p oxedyne_daimond
//! ```
//!
//! **`PROBE_SELFTEST=1` proves the harness before any money is spent** and is not optional
//! courtesy: this file's checks, its git reset and its budget arithmetic are as capable of
//! being wrong as anything they measure, and `probe_details.sh` has a paragraph in its own
//! header about the day its classifier put a reply in the wrong bucket and printed a tally
//! that was quietly false.  The self-test runs every check twice -- against a tree where
//! the task is done, and against one where it is not -- and fails unless each check answers
//! differently.  A check that cannot go red is a finding, not a fixture problem.
//!
//! `DAIMOND_PROBE_TASKS=bigfile,bigmark` runs a subset.
//!
//! ## The first live run, 2026-08-23, `anthropic/claude-haiku-4.5`
//!
//! ```text
//! task      verdict  calls     bytes   ref  fail    secs  worst read
//! bigfile   pass         3     87296     0     0    10.9  file_read 80016
//! bigmark   pass         3      3341     0     0    89.9  file_search 1752
//! locales   pass        10      2919     0     0    22.9  file_search 2311
//! ranit     pass         1      1617     0     0     4.0  shell 1617
//! TOTAL  17 call(s), 95173 byte(s) of tool output, 128s.
//! ```
//!
//! **All four passed on correctness, and two of them are the reason this file exists.**
//! `bigfile` took 80,016 bytes in a single `file_read` to learn a line number, and
//! `bigmark` spent 89.9 seconds walking 590,000 files for an answer it got right. The
//! budgets above were set from these figures afterwards -- at what each task is WORTH, not
//! at what it cost -- so both now fail, and will go green when the app is fixed rather than
//! when the numbers are edited. **A budget set above an observed figure measures nothing.**
//!
//! The run before this one failed three of four with every file tool REFUSED, and that was
//! this harness: it rooted the workspace at the mark, so `diamond_bounds` saw `"."`,
//! normalised it away and answered `Bound::Nowhere`. The model said "I have no workspace
//! attached", which was true. Caught by check (2) -- a refusal is never a pass here -- on
//! the instrument's first outing, which is the argument for check (2).
//!
//! ## After the `file_read` peek, same evening
//!
//! ```text
//! bigfile   pass         3     19478     0     0     8.8  file_read 12198
//! bigmark   pass         3      2864     0     0    21.6  file_search 1419
//! locales   FAIL        20     14477     0     1    20.7  file_read 6745
//! ranit     pass         1      1617     0     0     3.5  shell 1617
//! ```
//!
//! `bigfile` fell from 87,296 bytes to 19,478, its worst single read from 80,016 to 12,198,
//! and it now passes a budget set at what the task is worth. That is what the peek bought.
//!
//! **Two things in that table are NOT findings, and saying so is the point of keeping it.**
//! `bigmark` at 21.6 s against the first run's 89.9 s owes most of the difference to a warm
//! page cache, not to any change: nothing was done to the walk, so the earlier figure was
//! partly an artefact and the claim built on it was worth less than it looked. And
//! `locales`'s one failed call did not reproduce -- a re-run passed at 18 calls and 12,747
//! bytes -- so it is model variance rather than a regression.
//!
//! ## After the marks became the default starting point, same evening
//!
//! ```text
//! bigfile   pass         3     19478     0     0     8.0  file_read 12198
//! bigmark   pass         1      1419     0     0    16.8  file_search 1419
//! locales   pass        10      2919     0     0    23.3  file_search 2311
//! ranit     pass         1      1617     0     0     3.5  shell 1617
//! TOTAL  15 call(s), 25433 byte(s) of tool output, 52s.
//! ```
//!
//! Against the first run: **95,173 bytes to 25,433, and 17 tool calls to 15.** `bigmark` is
//! the structural one -- three calls to ONE, because a bare search now begins at the mark
//! instead of at the workspace root above it. Between those two runs it also spent a run
//! reporting that `updateSpend` "does not exist in" a file holding ten of them, which is what
//! searching the wrong tree looks like from the inside.
//!
//! Two faults were found by the probe rather than by a person, and both are fixed: a walk
//! starting above the marks, and `file_read` answering a directory with the operating system's
//! "Is a directory" wrapped in two error frames. The second was invisible until this file
//! learned to NAME the call that failed rather than count it.
//!
//! **Which exposes the instrument's own weakness: n = 1 per task.** A single run can neither
//! confirm a fix nor convict a regression on the noisy tasks, and `locales` has now returned
//! 10, 20 and 18 calls for the same brief. Read a single column as a signal only where the
//! change is large, as `bigfile`'s was. The fix is repeats, and it is not built.
//!
//! ## 2026-08-24: four more tasks, and what this transport cannot see
//!
//! Five faults were carried over from the night of the 23rd and the day after, every one of
//! them found by the owner or by a daimon failing in front of him and none of them by an
//! instrument.  Four became tasks -- `commit`, `parses`, `alias`, `world`.  The fifth did not,
//! and the reason it did not is the largest thing this file has to say about itself.
//!
//! **This probe is a NATIVE binary, and three of those five faults live in the browser build.**
//! `Tool::Run` and `Tool::Verify` are `#[cfg(target_arch = "wasm32")]`; the native `execute`
//! answers both with `Unimplemented`, and `Tool::defaults()` does not offer them at all.  So the
//! hand's fence, the environment a granted [`Toolkit`] hands a command, and the Diamond store
//! are all invisible from here, and a task written against one of them would be GREEN while the
//! product stayed broken -- which is worse than no task, because it is a false all-clear.
//!
//! What each of the five could honestly become:
//!
//!   * **`commit`** -- a daimon could not see `.git` at all: `ls -la` showed none, `git status`
//!     walked every parent to `/`.  That is the hand's fence and it is not reachable here.  What
//!     IS reachable is the capability itself, which nothing measured: can a daimon change a
//!     line and record the change.  It runs in a repository of its own under `target/`, for the
//!     reason [`check_commit`] gives at length.
//!   * **`parses`** -- the fault is reaching past the repository's own checking machinery and
//!     rebuilding it.  A daimon spent FORTY-ONE tool calls trying to run `verify_vocabulary`
//!     through `run`, and could not have succeeded: that verifier needs a dev server and a real
//!     browser, which is why `verify` exists.  It cannot be run from here either.  The same
//!     shape at a hundredth of the cost is `node --check`, which EXITS 0 ON A FILE WITH A SYNTAX
//!     ERROR IN IT, against `dev/jscheck.sh`, which does not.  The wrong route answers wrongly,
//!     so this one is caught on the verdict and not only on the budget.
//!   * **`alias`** -- fully visible here, and the only one of the five that is.  `file_search`
//!     is the same code in both builds.
//!   * **`world`** -- `run` clears the environment and passes no `HOME` unless the Git toolkit
//!     was granted, so scripts under `dev/` die before they print.  Native `sh -c` inherits the
//!     lot, so the fault cannot reproduce.  The task is kept because its BUDGET still bites:
//!     `dev/world.sh` is 11,419 bytes and its answer is 330, so reading it instead of running
//!     it fails here today, hand or no hand.
//!   * **The store boundary** -- `diamonds/<id>`, `chats/<id>/work` and `mail/<address>` are
//!     browser storage; the file tools reach them and a command never can, and a daimon tried
//!     three times in one turn to `cp` into its own Diamond folder.  **No task was written.**
//!     `is_store_path` and the OPFS root are wasm-only, and the native `shell` is unfenced, so
//!     the wrong route -- the `cp` -- SUCCEEDS here.  Any check this file could write would be
//!     satisfied by it, the self-test would pass, and the instrument would report a capability
//!     the product does not have.  It is left out deliberately, and the way to get it is to give
//!     this probe a way to speak to the hand, which is the same change that would let `commit`
//!     and `world` measure their real faults.
//!
//! **The self-test found a rotted task on its first run with these in.**  `check_locales` asked
//! for `spend.period_day`, which landed in `1e294c1`; from that commit the check was green
//! against a tree where nothing had been asked or done.  The key is now chosen from the tree at
//! run time -- see [`PERIOD_KEYS`] -- and the first attempt at that was wrong in an instructive
//! way, which [`period_key`] records.
//!
//! ## The first run with all eight, 2026-08-24, `anthropic/claude-haiku-4.5`
//!
//! ```text
//! task      verdict  calls     bytes   ref  fail    secs  worst read
//! bigfile   FAIL         3     12387     0     0     9.0  file_read 12198
//! bigmark   FAIL         1      1752     0     0    46.0  file_search 1752
//! locales   FAIL        19      7674     0     1    17.0  file_read 817
//! ranit     pass         1      1617     0     0     3.2  shell 1617
//! commit    pass         3       556     0     0     6.3  shell 417
//! parses    FAIL        15    100744     0     0    66.7  file_search 34526
//! alias     FAIL         4     32250     0     0    11.8  file_read 24901
//! world     pass         1       570     0     0     4.1  shell 570
//! TOTAL  47 call(s), 157550 byte(s) of tool output, 164s.
//! ```
//!
//! **`parses` and `alias` both got the right answer and both failed, and that pair is the whole
//! argument for check (3).**  `parses` found the verdict after FIFTEEN calls and 100,744 bytes
//! against a budget of five and 8,000 -- one `file_search` alone returned 34,526 -- which is the
//! forty-one-call shape of the 23rd, reproduced by an instrument for the first time rather than
//! watched over somebody's shoulder.  `alias` named both callers, the aliased one included, and
//! spent 24,901 bytes of its 32,250 on ONE bare `file_read` of `spend.js`: 22,629 bytes taken
//! into context to look at four lines.  A harness asserting only correctness would have printed
//! two passes.
//!
//! **`commit` and `world` passed, and neither pass means what it looks like.**  Both are written
//! against browser-build faults this transport cannot reach, and both went green in three calls
//! and one -- which is exactly the false all-clear the section above says a task like this risks.
//! They are kept as the budgets they are: `world` at 4,000 bytes still refuses a run that reads
//! `dev/world.sh` rather than running it.  Read the two green cells as "the capability exists on
//! a machine with no fence around it", and nothing more.
//!
//! `bigfile` failed on correctness with "The function `updateSpend` does not exist in that file",
//! which the section above records happening once before: it is what searching the wrong tree
//! looks like from the inside, and the file plainly holds ten of them.  `bigmark`'s 46.0 s
//! against 21.6 s the evening before is a cold page cache, not a regression -- the same caution
//! the earlier table carries.
//!
//! And one thing this run found that no task was aimed at.  `locales`'s failed call was
//! `file_read` on a directory, whose refusal `src/tools.rs` words carefully and at length -- and
//! it arrived at the model as `Error: LocalErr{[Invalid Input] "src/tools.rs:8733: file_read:
//! ...` with the ANSI colour codes still in it.  The sentence somebody wrote for a model to read
//! is being delivered inside an error frame addressed to a developer at a terminal.

use oxedyne_fe2o3_core::prelude::*;
use oxedyne_daimond::agent::{Agent, build_tls_client_config};
use oxedyne_daimond::executor::Executor;
use oxedyne_daimond::llm::LlmClient;
use oxedyne_daimond::protocol::{AgentEvent, Session};
use oxedyne_daimond::tools::{CallOutcome, diamond_bounds, FileRoot, Tool, ToolContext, ToolRegistry};
use oxedyne_daimond::workspace::Workspace;

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Instant;

/// The repository under test, as an absolute path.
///
/// Read from the environment so the probe can be pointed at a worktree, and defaulting to
/// this crate's own root -- which is the tree the tasks below are written about.
fn repo() -> PathBuf {
    match std::env::var("DAIMOND_PROBE_REPO") {
        Ok(p) if !p.trim().is_empty() => PathBuf::from(p),
        _ => PathBuf::from(env!("CARGO_MANIFEST_DIR")),
    }
}

/// The workspace ROOT, which is not a mark and is above every mark.
///
/// **This distinction is the one the first run of this probe got wrong**, and it is worth the
/// paragraph because it is the same distinction the product confuses.  A `Workspace` is the
/// folder the file tools address paths against; a MARK is a folder inside it that
/// `diamond_bounds` names in an `OnlyWriteUnder`.  Rooting the workspace AT the mark and then
/// marking `"."` normalises to the empty string, which `diamond_bounds` counts as no place at
/// all and answers with `Bound::Nowhere` -- so every file tool was refused, and the model
/// reported "I have no workspace attached", which was true and was the harness's fault.
///
/// Five levels up from `code/web/apps/oxedyne/daimond` is `~/usr`, which holds both `code` and
/// `complement`: the arrangement the owner's own session was in, where a path in a brief reads
/// `code/web/apps/oxedyne/daimond/www/js/ledger.js`.  Reproduced rather than tidied, because
/// the length of that path is part of what is being measured.
fn ws_root() -> PathBuf {
    let r = repo();
    let mut p = r.as_path();
    for _ in 0..5 {
        p = match p.parent() {
            Some(up) => up,
            None     => return r.clone(),
        };
    }
    p.to_path_buf()
}

/// The repository as the file tools see it: relative to [`ws_root`], e.g.
/// `code/web/apps/oxedyne/daimond`.  Every path in a brief is written against this.
fn app_rel() -> String {
    let (root, r) = (ws_root(), repo());
    match r.strip_prefix(&root) {
        Ok(rel) => rel.to_string_lossy().replace('\\', "/"),
        Err(_)  => String::new(),
    }
}

/// The wide mark, relative to [`ws_root`]: `code`, ~590,000 files.  The first segment of
/// [`app_rel`], so a worktree marks its own estate and not somebody else's.
fn wide_rel() -> String {
    let rel = app_rel();
    match rel.split('/').next() {
        Some(first) if !first.is_empty() => first.to_string(),
        _ => rel,
    }
}

/// Where a task's workspace root sits, which is what makes a path in the brief long or short.
#[derive(Clone, Copy, PartialEq)]
enum Mark {
    /// Marked at the app itself, which is what a careful user does.
    App,
    /// Marked at `~/usr/code`, which is what the owner did.  ~590,000 files.
    Wide,
}

/// What a task's answer is checked against.
///
/// A function over the tree and the reply, and never over what the model said about its own
/// work.  `CONTRACT_CLAIMS.md` gives the reason at length: a turn's account of itself is
/// prose, and this codebase removed thirty-four prose sniffs in one night.
type Check = fn(&Path, &str) -> Result<(), String>;

struct Task {
    /// Short name, for `DAIMOND_PROBE_TASKS` and the report.
    name:       &'static str,
    /// Which fault it exists to catch, printed beside a failure so a red line says why it
    /// was worth running.
    catches:    &'static str,
    mark:       Mark,
    brief:      &'static str,
    check:      Check,
    /// Tool calls this task may make.
    max_calls:  usize,
    /// Bytes of tool output it may take into context.
    max_bytes:  usize,
    /// Seconds the turn may take. Here because the first live run answered `bigmark`
    /// correctly in 89.9 s: a right answer that costs a minute and a half of walking is a
    /// finding, and correctness alone could not see it.
    max_secs:   f64,
    /// Paths, repository-relative, `git checkout --` reverts after the run.  Empty for a
    /// read-only task, and a read-only task is CHECKED to have written nothing.
    touches:    &'static [&'static str],
    // Fixture, made and unmade
    //
    // A fixture that is a git repository, or a file that must not parse, cannot be expressed in
    // `touches`: both live under `target/`, which is ignored, so `git checkout --` has nothing to
    // restore and would fail rather than clean.  These make and unmake them, and neither ever
    // runs a git verb in the repository under test -- see `setup_commit` for the argument.
    setup:      Option<fn(&Path) -> Result<(), String>>,    // before the turn
    teardown:   Option<fn(&Path)>,                          // after the check
}

// ── The tasks ────────────────────────────────────────────────────────────────────────
//
// Eight -- four from the 23rd, four from the day after -- each aimed at one thing that went
// wrong, and each small enough that a competent person would call it a minute's work.  That is the standard: the
// owner's objective says "without hitting continual snags", so the tasks are deliberately
// dull.  A probe made of hard tasks measures the model; this one measures the app.

/// 1. A large file must be readable, and read in part.
///
/// `www/js/daimond.js` is 1.6 MB and holds three NUL characters as a composite-key
/// separator.  Until 2026-08-23 `file_read` called it binary and refused it outright.  The
/// budget is the second half: the file is 1.6 MB, so a run that reads it whole passes the
/// answer and fails the probe, which is correct -- taking 1.6 MB into context to find one
/// line is not a working development loop.
fn check_bigfile(repo: &Path, reply: &str) -> Result<(), String> {
    let (line, _) = match first_cell_line(repo) {
        Some(f) => f,
        None    => return Err(fmt!("www/js/daimond.js no longer holds an appendChild(cell( inside \
            updateSpend, so this task has rotted -- re-point it")),
    };
    let plain = fmt!("{}", line);
    let comma = fmt!("{},{:03}", line / 1000, line % 1000);
    if reply.contains(&plain) || reply.contains(&comma) {
        return Ok(());
    }
    Err(fmt!("the reply does not name line {}: {}", line,
        reply.chars().take(200).collect::<String>()))
}

/// The line the task above asks for: the first `appendChild(cell(` inside `updateSpend`.
///
/// **Found in the file, because it was written down and it rotted.**  The number was 15996, and
/// the comment beside it said the answer was checked against the file rather than against a
/// number written here, which was not true of the code under it.  By 2026-08-24 `updateSpend`
/// had moved to line 16026 and the call to 16050, so the check was red against every correct
/// answer -- and the self-test could not see it, because the good case it handed the check was
/// the same 15996 the check was looking for.  A pair built out of the thing under test proves
/// that a constant equals itself.
fn first_cell_line(repo: &Path) -> Option<(usize, String)> {
    let text = match std::fs::read_to_string(repo.join("www/js/daimond.js")) {
        Ok(t)  => t,
        Err(_) => return None,
    };
    let mut inside = false;
    for (i, line) in text.lines().enumerate() {
        if line.contains("function updateSpend(") {
            inside = true;
            continue;
        }
        if inside && line.contains("appendChild(cell(") {
            return Some((i + 1, line.trim().to_string()));
        }
    }
    None
}

/// Where `updateSpend` begins and where the next function does, by line.
///
/// The independent half of the pair above.  [`first_cell_line`] walks forward and never looks
/// for the end of the function, so a `updateSpend` that stopped containing such a call would
/// hand back a line out of whatever came next and say nothing.  This finds the closing bound a
/// different way, and the self-test holds the one against the other.
fn update_spend_span(repo: &Path) -> Option<(usize, usize)> {
    let text = match std::fs::read_to_string(repo.join("www/js/daimond.js")) {
        Ok(t)  => t,
        Err(_) => return None,
    };
    let mut start = None;
    for (i, line) in text.lines().enumerate() {
        match start {
            None => if line.contains("function updateSpend(") { start = Some(i + 1); },
            Some(s) => if line.starts_with("\tfunction ") {
                return Some((s, i + 1));
            },
        }
    }
    start.map(|s| (s, usize::MAX))
}

/// 2. A search under a wide mark must not answer from a fraction of it.
///
/// `WALK_ENTRIES_MAX` is 20,000 and its own comment justifies the figure on the premise
/// that a mark is "an ordinary project".  Marked at `code`, that is 3.4% of the reach, and
/// `file_search` reports "0 matches" with the shortfall in a footnote.  The task is
/// answerable -- the constant is right there in `src/tools.rs` -- so a failure here is the
/// app answering a smaller question than the one it was asked.
fn check_bigmark(_repo: &Path, reply: &str) -> Result<(), String> {
    let says_file = reply.contains("tools.rs");
    let says_num  = reply.contains("20000") || reply.contains("20_000") || reply.contains("20,000");
    if says_file && says_num {
        return Ok(());
    }
    Err(fmt!("wanted the file and the value; got: {}",
        reply.chars().take(200).collect::<String>()))
}

// The eight files the fan-out task has to reach, and the oracle the check reads.
const LOCALES: &[&str] = &["de.js", "en.js", "es.js", "fr.js", "ja.js", "ko.js", "pt-BR.js",
                           "zh-Hans.js"];

// A key the tree does not already carry, and its English value.
//
// A LIST, and not the one constant this used to be.  `spend.period_day` landed in 1e294c1, and
// from that commit on `check_locales` was green against a tree where nothing had been asked or
// done -- a task measuring nothing while reporting a pass, which is the failure this whole file
// is about.  The self-test found it on its first run afterwards.  The task now asks for the
// first of these no locale carries, so the same landing cannot silence it twice.
const PERIOD_KEYS: &[(&str, &str)] = &[
    ("spend.period_day",     "Day"),
    ("spend.period_hour",    "Hour"),
    ("spend.period_year",    "Year"),
    ("spend.period_quarter", "Quarter"),
];

/// The key the fan-out task asks for on this tree, and the English word for it.
///
/// **Chosen once and then fixed for the life of the process**, which is not an optimisation.
/// The check runs AFTER the turn has added the key, so a second derivation from the tree would
/// find that candidate taken, step to the next one, and report a task that had just been done
/// as not done.  The self-test caught precisely that on the first run after the list went in --
/// green, red, then red again with the answer planted -- which is what a check derived from the
/// evidence it is checking looks like from the outside.
fn period_key(repo: &Path) -> Option<(&'static str, &'static str)> {
    static CHOSEN: OnceLock<Option<(&'static str, &'static str)>> = OnceLock::new();
    *CHOSEN.get_or_init(|| choose_period_key(repo))
}

/// The first key in [`PERIOD_KEYS`] no locale file carries.
fn choose_period_key(repo: &Path) -> Option<(&'static str, &'static str)> {
    let dir = repo.join("www/i18n");
    for (key, eng) in PERIOD_KEYS {
        let mut free = true;
        for n in LOCALES {
            match std::fs::read_to_string(dir.join(n)) {
                Ok(t)  => if t.contains(key) { free = false; },
                Err(_) => return None,
            }
        }
        if free {
            return Some((key, eng));
        }
    }
    None
}

/// 3. A change across eight files is one task, not eight.
///
/// The locale fan-out is the shape most likely to be done four-eighths of the way.  The eight
/// files are read here rather than put through `dev/i18ncheck.mjs`, because that script answers
/// a coverage question over the whole catalogue and this task is about ONE key: a run that added
/// it to four files would leave the script red for reasons that were red before.
fn check_locales(repo: &Path, _reply: &str) -> Result<(), String> {
    let (key, _) = match period_key(repo) {
        Some(k) => k,
        None    => return Err(fmt!("every key in PERIOD_KEYS is already in the tree, so there is \
            nothing left for this task to ask for -- add one, or re-point it")),
    };
    let dir = repo.join("www/i18n");
    let mut absent = Vec::new();
    for n in LOCALES {
        let text = match std::fs::read_to_string(dir.join(n)) {
            Ok(t)  => t,
            Err(e) => return Err(fmt!("{}: {}", n, e)),
        };
        if !text.contains(key) {
            absent.push(*n);
        }
    }
    if absent.is_empty() {
        return Ok(());
    }
    Err(fmt!("{} is absent from {}", key, absent.join(" ")))
}

/// 4. A tool is run, not read.
///
/// `dev/i18ncheck.mjs` is 39 KB, almost all of it commentary, and a daimon read the whole
/// of it to learn how to invoke it.  The answer is one line of that script's output, so a
/// run that reads the file at all is spending 39 KB to avoid one `run` call -- which the
/// byte budget, set below the file's size, is what catches.
fn check_ran_it(_repo: &Path, reply: &str) -> Result<(), String> {
    let l = reply.to_lowercase();
    // The script says "all 7 locales carry every one of en.js's N keys" when it is happy.
    if l.contains("locales carry") || l.contains("out of step") {
        return Ok(());
    }
    Err(fmt!("the reply does not quote the checker's own verdict: {}",
        reply.chars().take(200).collect::<String>()))
}

// ── Four more, from the night of the 23rd and the day after ──────────────────────────
//
// Each of the four below was found by the owner, or by a daimon failing in front of him,
// and by no instrument in this repository.  That is the thing they exist to end.
//
// **Two of them are red for a reason that is not the app's.**  `commit` and `world` are
// written against faults that live in the browser build -- the hand's fence, and the
// environment a granted toolkit hands a command -- and this probe is a native binary, where
// `Tool::Run` and `Tool::Verify` are refused at compile time and `sh -c` inherits the whole
// environment.  See the header section "What this transport cannot see".  They are kept
// because the budget still bites on the native side: reading an 11 KB script instead of
// running it fails `world` today, whatever the hand does.

/// A directory of the probe's own, under the repository's ignored build output.
///
/// Everything a task has to BUILD goes here rather than into the tracked tree, and it is
/// removed by the task's own teardown.  `touches` cannot help: it is a `git checkout --`, and
/// there is nothing for that to restore under an ignored path.
fn probe_dir(repo: &Path) -> PathBuf {
    repo.join("target/probe")
}

/// The throwaway repository the `commit` task works in.
fn commit_dir(repo: &Path) -> PathBuf {
    probe_dir(repo).join("commit")
}

// What the commit task must produce, checked against the throwaway repository's own log.
const COMMIT_SUBJECT: &str = "probe: bump the count";

// The seed file, and the one line in it the task is asked to change.
const SCRATCH_SEED: &str = "// Scratch, made by the probe and thrown away after it.\ncount = 1\n";

/// Run `git` in `dir` and answer its standard output, trimmed.
///
/// Every call names the directory explicitly, and no call here is ever made in the repository
/// under test -- see [`setup_commit`], where that separation is the whole safety argument.
fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = match std::process::Command::new("git").arg("-C").arg(dir).args(args).output() {
        Ok(o)  => o,
        Err(e) => return Err(fmt!("git {}: {}", args.join(" "), e)),
    };
    if !out.status.success() {
        return Err(fmt!("git {} in {:?}: {}", args.join(" "), dir,
            String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// The repository's HEAD and its staged paths, as one line.
///
/// Read after every task, because four other people's uncommitted work is in this tree while
/// the probe runs.  A task that moved HEAD or added to the index did it to THEM, and the only
/// safe thing an instrument can do about that is say so loudly: undoing a commit or an index
/// is exactly the reset that turns one bad turn into somebody's lost afternoon.
fn repo_state(repo: &Path) -> String {
    let head = match git(repo, &["rev-parse", "HEAD"]) {
        Ok(h)  => h,
        Err(e) => e,
    };
    let staged = match git(repo, &["diff", "--cached", "--name-only"]) {
        Ok(s)  => s.split('\n').filter(|l| !l.trim().is_empty()).collect::<Vec<&str>>().join(","),
        Err(e) => e,
    };
    fmt!("HEAD {} staged [{}]", head, staged)
}

/// 5. A daimon must be able to commit its own work.
///
/// On 2026-08-23 one could not see `.git` at all: `ls -la` showed none and `git status` walked
/// every parent to `/` before giving up.  A machine that can write the change and cannot record
/// it is a machine that cannot do a day's work, whatever else it can do, so this is the hard
/// stop under "full self-development capability" and nothing measured it.
///
/// **It works in a repository of its own, and that is not squeamishness.**  Four other lanes
/// have uncommitted work in the tree under test.  A task that committed HERE would need undoing
/// afterwards, and the undo -- `reset`, `checkout`, `stash` -- is the operation that destroys
/// somebody else's morning when it is aimed one word wrong.  An inner repository is a WALL
/// rather than a promise: git resolves to the nearest `.git`, so a `git add -A` inside it cannot
/// reach the outer index however the turn is worded, and the teardown is `remove_dir_all` on a
/// directory the probe made, which cannot touch a tracked file at all.  What it gives up is the
/// hand's fence, which this transport could not see in any case; what it keeps is the whole of
/// the capability.
fn check_commit(repo: &Path, _reply: &str) -> Result<(), String> {
    let dir = commit_dir(repo);
    let subject = match git(&dir, &["log", "-1", "--pretty=%s"]) {
        Ok(s)  => s,
        Err(e) => return Err(fmt!("no commit to read: {}", e)),
    };
    if subject != COMMIT_SUBJECT {
        return Err(fmt!("the last commit is '{}', not '{}'", subject, COMMIT_SUBJECT));
    }
    let text = match git(&dir, &["show", "HEAD:scratch.txt"]) {
        Ok(t)  => t,
        Err(e) => return Err(fmt!("scratch.txt is not in that commit: {}", e)),
    };
    if !text.contains("count = 2") {
        return Err(fmt!("the commit does not carry the change: {}",
            text.chars().take(120).collect::<String>()));
    }
    // Committed, and not merely written. A turn that edits the file and commits nothing leaves a
    // dirty tree, which is the near miss worth telling apart from the hit.
    match git(&dir, &["status", "--porcelain"]) {
        Ok(s) if s.trim().is_empty() => Ok(()),
        Ok(s)  => Err(fmt!("committed, but left the tree dirty: {}", s.replace('\n', "; "))),
        Err(e) => Err(e),
    }
}

/// Build the throwaway repository, seeded and committed once.
fn setup_commit(repo: &Path) -> Result<(), String> {
    let dir = commit_dir(repo);
    let _ = std::fs::remove_dir_all(&dir);
    if let Err(e) = std::fs::create_dir_all(&dir) {
        return Err(fmt!("{:?}: {}", dir, e));
    }
    let steps: [&[&str]; 4] = [
        &["init", "-q"],
        &["config", "user.name", "Daimond probe"],
        &["config", "user.email", "probe@localhost"],
        // No hook runs in here. The machine's global `core.hooksPath` points at a credential
        // scanner with nothing to say about this task, and a hook that refused the commit would
        // reach the report as the daimon having failed.
        &["config", "core.hooksPath", ".git/hooks-none"],
    ];
    for args in steps {
        if let Err(e) = git(&dir, args) {
            return Err(e);
        }
    }
    if let Err(e) = std::fs::write(dir.join("scratch.txt"), SCRATCH_SEED) {
        return Err(fmt!("scratch.txt: {}", e));
    }
    if let Err(e) = git(&dir, &["add", "scratch.txt"]) {
        return Err(e);
    }
    if let Err(e) = git(&dir, &["commit", "-q", "-m", "seed"]) {
        return Err(e);
    }
    Ok(())
}

fn teardown_commit(repo: &Path) {
    let _ = std::fs::remove_dir_all(commit_dir(repo));
}

/// 6. Work is checked with the repository's own machinery, not with a check reinvented.
///
/// A daimon asked to verify a page spent FORTY-ONE tool calls trying to reconstruct the check --
/// starting a dev server, hunting for `playwright-core`, testing whether it had a network -- for
/// a verifier this repository runs with one command.  That is the shape, and the cheapest true
/// instance of it is here: `node --check` EXITS 0 ON A FILE WITH A SYNTAX ERROR IN IT when the
/// file is named `.js` and opens with an `import`, because node then parses it as CommonJS.
/// `dev/jscheck.sh` exists for exactly that, and says so in its own header.
///
/// **So the wrong route does not merely cost more, it answers wrongly**, which is why this task
/// is checked on the verdict and not only on the budget: a turn that reaches for its own
/// `node --check` is told the file is fine, and reports that the file is fine.
fn check_parses(_repo: &Path, reply: &str) -> Result<(), String> {
    let l = reply.to_lowercase();
    let named = l.contains("jscheck");
    let failed = l.contains("do not parse") || l.contains("does not parse")
        || l.contains("fail") || l.contains("syntax error");
    if named && failed {
        return Ok(());
    }
    Err(fmt!("wanted the repository's own checker named and its refusal reported; got: {}",
        reply.chars().take(200).collect::<String>()))
}

/// The file that must not parse, and the `.js` name that makes `node --check` lie about it.
fn setup_parse(repo: &Path) -> Result<(), String> {
    let dir = probe_dir(repo).join("parse");
    let _ = std::fs::remove_dir_all(&dir);
    if let Err(e) = std::fs::create_dir_all(&dir) {
        return Err(fmt!("{:?}: {}", dir, e));
    }
    // The `import` is load-bearing: without it node parses the file as a script, finds the
    // error and the task stops measuring anything.
    let src = "import * as X from './x.js';\nvar broken = (1;\n";
    match std::fs::write(dir.join("broken.js"), src) {
        Ok(())  => Ok(()),
        Err(e)  => Err(fmt!("broken.js: {}", e)),
    }
}

fn teardown_parse(repo: &Path) {
    let _ = std::fs::remove_dir_all(probe_dir(repo).join("parse"));
}

/// The local names a file gives to `what`, e.g. the `L` in `var L = window.DaimondLedger;`.
///
/// A reference followed by another name character, or by a dot, is a USE and not a binding, so
/// `window.DaimondLedger.totals(` is passed over here and caught by the direct match instead.
fn aliases_of(text: &str, what: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for line in text.lines() {
        let mut from = 0usize;
        while let Some(found) = line[from..].find(what) {
            let at = from + found;
            from = at + what.len();
            match line[from..].chars().next() {
                Some(c) if c.is_alphanumeric() || c == '_' || c == '$' || c == '.' => continue,
                _ => {}
            }
            // Back over the `=`, refusing `==`, `!=`, `<=` and `>=`, which bind nothing.
            let head = line[..at].trim_end();
            let head = match head.strip_suffix('=') {
                Some(h) => h,
                None    => continue,
            };
            match head.chars().last() {
                Some('=') | Some('!') | Some('<') | Some('>') => continue,
                _ => {}
            }
            let mut name: Vec<char> = head.trim_end().chars().rev()
                .take_while(|c| c.is_alphanumeric() || *c == '_' || *c == '$')
                .collect();
            name.reverse();
            let name: String = name.into_iter().collect();
            if !name.is_empty() && !out.contains(&name) {
                out.push(name);
            }
        }
    }
    out
}

/// Every place in `www/js` that calls `DaimondLedger.totals`, alias and all.
///
/// Computed from the tree on every run rather than written down, so a caller added, moved or
/// renamed cannot turn the task green by having been recorded here once.
fn totals_callers(repo: &Path) -> Result<Vec<(String, usize)>, String> {
    let dir = repo.join("www/js");
    let listing = match std::fs::read_dir(&dir) {
        Ok(l)  => l,
        Err(e) => return Err(fmt!("{:?}: {}", dir, e)),
    };
    let mut names: Vec<String> = Vec::new();
    for ent in listing.flatten() {
        let p = ent.path();
        if p.extension().and_then(|x| x.to_str()) != Some("js") {
            continue;
        }
        if let Some(n) = p.file_name().and_then(|x| x.to_str()) {
            names.push(n.to_string());
        }
    }
    names.sort();
    let mut out: Vec<(String, usize)> = Vec::new();
    for n in &names {
        let text = match std::fs::read_to_string(dir.join(n)) {
            Ok(t)  => t,
            Err(e) => return Err(fmt!("{}: {}", n, e)),
        };
        let aliases = aliases_of(&text, "window.DaimondLedger");
        for (i, line) in text.lines().enumerate() {
            let direct = line.contains("DaimondLedger.totals(");
            let through = aliases.iter().any(|a| line.contains(&fmt!("{}.totals(", a)));
            if direct || through {
                out.push((n.clone(), i + 1));
            }
        }
    }
    Ok(out)
}

/// The same answer by a different road, for the self-test to hold `check_alias` against.
///
/// A bare scan for `.totals(` needs no alias resolution and finds both callers, so it is an
/// oracle the check does not share a line of code with -- which is the point, since a self-test
/// that builds its right answer out of the thing under test proves only that the thing agrees
/// with itself.  If the two ever disagree, the self-test goes red and that is a finding: either
/// the alias walk has broken, or `.totals(` has grown a second meaning in this tree.
fn bare_totals_scan(repo: &Path) -> String {
    let dir = repo.join("www/js");
    let listing = match std::fs::read_dir(&dir) {
        Ok(l)  => l,
        Err(_) => return String::new(),
    };
    let mut names: Vec<String> = Vec::new();
    for ent in listing.flatten() {
        if let Some(n) = ent.path().file_name().and_then(|x| x.to_str()) {
            if n.ends_with(".js") {
                names.push(n.to_string());
            }
        }
    }
    names.sort();
    let mut out: Vec<String> = Vec::new();
    for n in &names {
        let text = match std::fs::read_to_string(dir.join(n)) {
            Ok(t)  => t,
            Err(_) => continue,
        };
        for (i, line) in text.lines().enumerate() {
            if line.contains(".totals(") {
                out.push(fmt!("www/js/{}:{}", n, i + 1));
            }
        }
    }
    out.join(", ")
}

/// 7. "Who calls this?" is the question before every non-trivial change.
///
/// A daimon grepped `DaimondLedger.totals` and reported one caller.  There are two: the second
/// goes through `var L = window.DaimondLedger` and reads `L.totals()`.  It gave the right answer
/// for a reason that did not hold -- had the brief been RENAME rather than add, the Spending
/// panel would have lost a stat and nothing would have said so.
///
/// This app answers that question with string matching, so the fault is not the model's: it is
/// what `file_search` can see.  The check computes the callers from the tree at run time, so it
/// follows a file that moves and goes red rather than stale when the alias does.
fn check_alias(repo: &Path, reply: &str) -> Result<(), String> {
    let callers = match totals_callers(repo) {
        Ok(c)  => c,
        Err(e) => return Err(e),
    };
    let mut files: Vec<&str> = callers.iter().map(|(f, _)| f.as_str()).collect();
    files.sort();
    files.dedup();
    // A task pointed at a question that no longer has the shape it was written for measures
    // nothing, and must say that rather than pass.
    if files.len() < 2 {
        return Err(fmt!("the tree holds {} caller(s) of DaimondLedger.totals in {} file(s), so \
            there is no aliased one left and this task has rotted -- re-point it",
            callers.len(), files.len()));
    }
    let missed: Vec<String> = callers.iter()
        .filter(|(f, l)| !reply.contains(f.as_str()) || !reply.contains(&fmt!("{}", l)))
        .map(|(f, l)| fmt!("{}:{}", f, l))
        .collect();
    if missed.is_empty() {
        return Ok(());
    }
    Err(fmt!("the reply does not name {}: {}", missed.join(" "),
        reply.chars().take(200).collect::<String>()))
}

/// 8. A script under `dev/` needs `$HOME`, and must be run rather than read.
///
/// `run` clears the environment and passes no `HOME` unless the user granted the Git toolkit
/// (see `Kit::for_home` in `src/tools.rs`), so nearly every script under `dev/` dies before it
/// prints anything.  A daimon met it on `dev/world.sh`, which is the one used here: with `HOME`
/// unset it stops at line 84 with `HOME: unbound variable` and produces no output at all.
///
/// The scratch path is the whole check, because it is the one line of that output `$HOME` is
/// needed to produce -- the ports beside it are arithmetic and would be printed by a shell that
/// had nothing.
fn check_world(_repo: &Path, reply: &str) -> Result<(), String> {
    let home = match std::env::var("HOME") {
        Ok(h) if !h.trim().is_empty() => h,
        _ => return Err(fmt!("this probe's own HOME is unset, so there is no value to check the \
            reply against; the check cannot run")),
    };
    let want = fmt!("{}/.cache/daimond", home.trim_end_matches('/'));
    if reply.contains(&want) {
        return Ok(());
    }
    Err(fmt!("the reply does not carry the scratch path the script prints ({}): {}", want,
        reply.chars().take(200).collect::<String>()))
}

const TASKS: &[Task] = &[
    Task {
        name:      "bigfile",
        catches:   "file_read refusing the app's own 1.6 MB UI source, and reading it whole",
        mark:      Mark::App,
        brief:     "In {app}/www/js/daimond.js, find the function updateSpend. Tell me the line \
                    number of the first el.appendChild(cell(...)) call inside it. Answer \
                    with the number and nothing else. Change no files.",
        check:     check_bigfile,
        max_calls: 6,
        // 20 KB. The first live run passed this task at 87,296 bytes, of which ONE
        // `file_read` was 80,016 -- 80 KB taken into context to learn a line number, which
        // is the waste the owner stopped a turn over. A budget set above the observed
        // figure measures nothing, so this is set at what the task is worth: a targeted
        // search and a small read around the hit.
        max_bytes: 20_000,
        max_secs:  30.0,
        touches:   &[],
        setup:     None,
        teardown:  None,
    },
    Task {
        name:      "bigmark",
        catches:   "a search under a 590,000-file mark answering from 20,000 of them",
        mark:      Mark::Wide,
        brief:     "Somewhere under this workspace is a Rust constant named \
                    WALK_ENTRIES_MAX. Tell me which file defines it and what value it is \
                    given. Change no files.",
        check:     check_bigmark,
        max_calls: 8,
        max_bytes: 60_000,
        // 89.9 s on the first live run, nearly all of it the walk over 590,000 files.
        max_secs:  30.0,
        touches:   &[],
        setup:     None,
        teardown:  None,
    },
    Task {
        name:      "locales",
        catches:   "a fan-out across eight files done part of the way",
        mark:      Mark::App,
        brief:     "Add the key {key} to all eight locale files in {app}/www/i18n/, \
                    beside the existing spend.period_week. The English value is {eng}; \
                    translate it for the other seven. Touch nothing else.",
        check:     check_locales,
        max_calls: 24,
        max_bytes: 60_000,
        max_secs:  90.0,
        touches:   &["www/i18n"],
        setup:     None,
        teardown:  None,
    },
    Task {
        name:      "ranit",
        catches:   "reading a 39 KB script instead of running it",
        mark:      Mark::App,
        brief:     "In {app}, run node dev/i18ncheck.mjs --frozen and tell me the verdict line \
                    it prints. Do not pass any other flag. Change no files.",
        check:     check_ran_it,
        max_calls: 4,
        // Below the 39 KB of `dev/i18ncheck.mjs`, deliberately: reading the script is the
        // failure, so the budget has to be a figure reading it cannot fit inside.
        max_bytes: 30_000,
        max_secs:  30.0,
        touches:   &[],
        setup:     None,
        teardown:  None,
    },
    Task {
        name:      "commit",
        catches:   "a daimon that can write the change and cannot record it",
        mark:      Mark::App,
        brief:     "The folder {app}/target/probe/commit is a git repository of its own, and the \
                    only one this task concerns. In its scratch.txt, change the line reading \
                    'count = 1' to 'count = 2', and commit that one change with the message \
                    'probe: bump the count'. Run no git command anywhere else.",
        check:     check_commit,
        // A read of a one-line file, an edit, an add, a commit, and a look at the log to see it
        // landed. Five is the shape; the sixth is the allowance for landing in the wrong
        // directory once, which is what the 23rd looked like.
        max_calls: 6,
        // The file is 70 bytes and git's own output for these verbs is a few hundred more. Set
        // where reading anything large to find out where the repository is will not fit.
        max_bytes: 5_000,
        max_secs:  45.0,
        touches:   &[],
        setup:     Some(setup_commit),
        teardown:  Some(teardown_commit),
    },
    Task {
        name:      "parses",
        catches:   "reinventing a check this repository already runs, and being told the wrong thing by it",
        mark:      Mark::App,
        brief:     "Does {app}/target/probe/parse/broken.js parse? Answer it with the machinery \
                    already in this repository for that question rather than a command of your \
                    own, and report the verdict it prints. Change no files.",
        check:     check_parses,
        // A targeted glob to find the checker, the checker's own 1,952 bytes if the turn wants
        // to read it, and the run.
        max_calls: 5,
        // Below the ~11 KB a capped listing of `dev/`'s 526 entries costs. Knowing which script
        // answers "does this parse" should not cost a directory.
        max_bytes: 8_000,
        max_secs:  40.0,
        touches:   &[],
        setup:     Some(setup_parse),
        teardown:  Some(teardown_parse),
    },
    Task {
        name:      "alias",
        catches:   "\"who calls this?\" answered by string matching, one caller of two",
        mark:      Mark::App,
        brief:     "Name every place in {app}/www/js that calls DaimondLedger's totals method, \
                    each as a file and a line number. Include the ones that reach it through a \
                    local name. Change no files.",
        check:     check_alias,
        // Three searches -- the symbol, the object, the local name it is bound to -- and one
        // targeted read around a hit.
        max_calls: 5,
        // Twenty lines carrying `DaimondLedger` across `www/js` is about 2 KB. This allows the
        // searches and a read with an offset, and refuses a bare read of `spend.js`, which is
        // 22,629 bytes and under the peek threshold, so it would come back whole.
        max_bytes: 8_000,
        max_secs:  40.0,
        touches:   &[],
        setup:     None,
        teardown:  None,
    },
    Task {
        name:      "world",
        catches:   "a dev script that dies before it prints, because the command was given no HOME",
        mark:      Mark::App,
        brief:     "In {app}, run 'bash dev/world.sh 0 --env' and tell me the scratch directory \
                    it names. Pass no other argument, and start nothing. Change no files.",
        check:     check_world,
        // One command answers it. Three is two false starts' grace.
        max_calls: 3,
        // The script is 11,419 bytes and its answer is 330. Set between them deliberately: this
        // is `ranit`'s fault in a second place, and the budget has to be a figure the read
        // cannot fit inside.
        max_bytes: 4_000,
        max_secs:  20.0,
        touches:   &[],
        setup:     None,
        teardown:  None,
    },
];

/// What one task's turn actually did.
#[derive(Default)]
struct Spend {
    calls:    usize,
    bytes:    usize,
    refused:  usize,
    failed:   usize,
    /// The tool that returned the most, and how much, so a report names the read that hurt
    /// rather than only the total.
    worst:    (String, usize),
    /// The FIRST call that was refused or failed, and what it said.
    ///
    /// Added on the instrument's third run, when `locales` reported one failed call and this
    /// file could say nothing about which one. A harness that counts a fault without naming it
    /// sends its reader back to the provider logs, which is the position the probe exists to
    /// get out of -- and "1 failed" with no name is exactly the shape of report this codebase
    /// keeps writing up as answering from the wrong evidence.
    firstbad: Option<(String, String)>,
    prompt:   u64,
    completion: u64,
    secs:     f64,
}

fn main() {
    // The closing line names WHICH run it is closing. A self-test that signs off with
    // "every task passed" is a sentence somebody will quote as evidence the app works,
    // when nothing was asked of the app at all.
    let what = if std::env::var("PROBE_SELFTEST").is_ok() { "self-test" } else { "devcycle" };
    match run() {
        Ok(bad) if bad == 0 => println!("\n{}: nothing failed.", what),
        Ok(bad)  => { println!("\n{}: {} failure(s).", what, bad); std::process::exit(1); }
        Err(e)   => { eprintln!("{}: {}", what, e); std::process::exit(2); }
    }
}

fn run() -> Outcome<usize> {
    let repo = repo();
    if !repo.join("www/js/daimond.js").exists() {
        return Err(err!("{:?} does not look like the Daimond repository.", repo; Init, Invalid));
    }
    let chosen: Vec<&Task> = match std::env::var("DAIMOND_PROBE_TASKS") {
        Ok(list) if !list.trim().is_empty() => {
            let want: Vec<String> = list.split(',').map(|s| s.trim().to_string()).collect();
            TASKS.iter().filter(|t| want.iter().any(|w| w == t.name)).collect()
        }
        _ => TASKS.iter().collect(),
    };
    if chosen.is_empty() {
        return Err(err!("DAIMOND_PROBE_TASKS named no task this file knows."; Init, Invalid));
    }

    if std::env::var("PROBE_SELFTEST").is_ok() {
        return selftest(&repo, &chosen);
    }
    live(&repo, &chosen)
}

// ── The self-test, which costs nothing and is the first thing to run ──────────────────

/// Prove every check BOTH ways without a provider.
///
/// A check is run against a tree where the task is done and against one where it is not,
/// and it must answer differently.  `probe_details.sh` records what it costs to skip this:
/// its classifier put a one-character reply in the wrong bucket, and the printed tally said
/// 9 of 10 when the answer was 9 of 9 -- a true-looking number produced by an instrument
/// nobody had pointed at a known case.
///
/// The budget arithmetic is proved here too.  A budget that cannot be exceeded is not a
/// budget, and it is the check this whole file rests on.
fn selftest(repo: &Path, chosen: &[&Task]) -> Outcome<usize> {
    println!("== self-test: no provider, no spend ==\n");
    let mut bad = 0usize;

    for t in chosen {
        // The answer a task's check should accept, and one it must not.  Written here
        // rather than derived, because the point is to hand each check a case whose right
        // answer is known independently of the code under test.
        let (good, poor): (String, String) = match t.name {
            "bigfile" => (match first_cell_line(repo) {
                              Some((n, _)) => fmt!("{}", n),
                              None         => fmt!("the file no longer holds that call"),
                          },
                          fmt!("I could not read the file; it is binary.")),
            "bigmark" => (fmt!("src/tools.rs, 20_000"), fmt!("No matches found.")),
            "ranit"   => (fmt!("i18ncheck: all 7 locales carry every one of en.js's 3512 keys"),
                          fmt!("I read the script. It checks locale coverage.")),
            // The two poor answers below are not invented.  `parses` is told what
            // `node --check` actually says about that file -- exit 0 and nothing printed --
            // and `alias` is handed the reply a daimon really gave: the literal caller, alone.
            "parses"  => (fmt!("jscheck: 1 file(s) do not parse."),
                          fmt!("node --check reported nothing, so the file parses.")),
            "alias"   => (bare_totals_scan(repo), fmt!("www/js/daimond.js:16036 is the caller.")),
            "world"   => (fmt!("export DAIMOND_SCRATCH={}/.cache/daimond",
                               std::env::var("HOME").unwrap_or_default().trim_end_matches('/')),
                          fmt!("dev/world.sh: line 84: HOME: unbound variable")),
            // These two read the tree, so their cases are made in it below.
            "locales" | "commit" => (String::new(), String::new()),
            other     => return Err(err!("no self-test case for task '{}'", other; Init, Missing)),
        };

        // The commit task's evidence is a repository, so its two cases are a repository with
        // the commit in it and one without.  Both are built and thrown away here; nothing
        // tracked is touched, and no git verb below names the repository under test.
        if t.name == "commit" {
            let dir = commit_dir(repo);
            let built = setup_commit(repo);
            match built {
                Err(ref e) => {
                    println!("  FAIL {:<9} could not build the fixture: {}", t.name, e);
                    bad += 1;
                }
                Ok(()) => {
                    match (t.check)(repo, "") {
                        Ok(())  => {
                            println!("  FAIL {:<9} passes on a repository with no such commit", t.name);
                            bad += 1;
                        }
                        Err(_) => println!("  ok   {:<9} red before the commit is made", t.name),
                    }
                    // And green, with the commit made by hand.
                    let done = std::fs::write(dir.join("scratch.txt"),
                            SCRATCH_SEED.replace("count = 1", "count = 2"))
                        .map_err(|e| fmt!("scratch.txt: {}", e))
                        .and_then(|()| git(&dir, &["add", "scratch.txt"]))
                        .and_then(|_| git(&dir, &["commit", "-q", "-m", COMMIT_SUBJECT]));
                    let verdict = match done {
                        Ok(_)  => (t.check)(repo, ""),
                        Err(e) => Err(e),
                    };
                    // Taken down BEFORE the verdict is printed, as the locale branch does, so a
                    // panic in the report cannot leave the fixture behind.
                    teardown_commit(repo);
                    match verdict {
                        Ok(())  => println!("  ok   {:<9} green once the commit is there", t.name),
                        Err(e)  => {
                            println!("  FAIL {:<9} still red with the commit made: {}", t.name, e);
                            bad += 1;
                        }
                    }
                }
            }
            teardown_commit(repo);
            continue;
        }

        if t.name == "locales" {
            // Red first, against the tree as it stands.
            match (t.check)(repo, "") {
                Ok(())  => {
                    println!("  FAIL {:<9} the check passes on a tree where the key is absent", t.name);
                    bad += 1;
                }
                Err(_) => println!("  ok   {:<9} red on a tree without the key", t.name),
            }
            // Then green, with the key put in every locale by hand and taken out again.
            let dir = repo.join("www/i18n");
            // The same key the brief will ask for, so the planted case is the task done and not
            // a different task done.
            let (key, _) = match period_key(repo) {
                Some(k) => k,
                None    => {
                    println!("  FAIL {:<9} every candidate key is already in the tree", t.name);
                    bad += 1;
                    continue;
                }
            };
            let mark = fmt!("\n// {} (self-test, removed below)\n", key);
            let mut planted: Vec<PathBuf> = Vec::new();
            let mut plant_failed = None;
            for n in LOCALES {
                let f = dir.join(n);
                let text = match std::fs::read_to_string(&f) {
                    Ok(t)  => t,
                    Err(e) => { plant_failed = Some(fmt!("{}: {}", n, e)); break; }
                };
                let with = fmt!("{}{}", text, mark);
                if let Err(e) = std::fs::write(&f, with) {
                    plant_failed = Some(fmt!("{}: {}", n, e));
                    break;
                }
                planted.push(f);
            }
            let verdict = match plant_failed {
                Some(e) => Err(e),
                None    => (t.check)(repo, ""),
            };
            // Put the tree back BEFORE reporting, so a panic in the report cannot leave it
            // dirty.  `git checkout` is the belt; this is the braces.
            for f in &planted {
                if let Ok(text) = std::fs::read_to_string(f) {
                    let back = text.replace(&mark, "");
                    let _ = std::fs::write(f, back);
                }
            }
            match verdict {
                Ok(())  => println!("  ok   {:<9} green once every locale carries it", t.name),
                Err(e)  => { println!("  FAIL {:<9} still red with the key planted: {}", t.name, e); bad += 1; }
            }
            continue;
        }

        match (t.check)(repo, &good) {
            Ok(())  => println!("  ok   {:<9} green on a right answer", t.name),
            Err(e)  => { println!("  FAIL {:<9} red on a right answer: {}", t.name, e); bad += 1; }
        }
        match (t.check)(repo, &poor) {
            Ok(())  => { println!("  FAIL {:<9} GREEN on a wrong answer, so it checks nothing", t.name); bad += 1; }
            Err(_)  => println!("  ok   {:<9} red on a wrong answer", t.name),
        }
    }

    // Two checks are pointed at a line found in the tree, and the pair above cannot say whether
    // the locator found the right line: both halves would carry the same wrong number. So the
    // line is held against a bound found a different way.
    if chosen.iter().any(|t| t.name == "bigfile") {
        match (first_cell_line(repo), update_spend_span(repo)) {
            (Some((n, text)), Some((from, to))) if n > from && n < to =>
                println!("  ok   bigfile   line {} is inside updateSpend ({}..{}): {}",
                    n, from, to, text.chars().take(46).collect::<String>()),
            (Some((n, _)), Some((from, to))) => {
                println!("  FAIL bigfile   line {} is outside updateSpend ({}..{})", n, from, to);
                bad += 1;
            }
            _ => {
                println!("  FAIL bigfile   updateSpend or the call inside it cannot be found");
                bad += 1;
            }
        }
    }

    // And the budget, which is the assertion the other three rest on.
    println!();
    let over = Spend { calls: 99, bytes: 1, ..Default::default() };
    let fat  = Spend { calls: 1, bytes: 9_999_999, ..Default::default() };
    let slow = Spend { calls: 1, bytes: 1, secs: 9_999.0, ..Default::default() };
    let fine = Spend { calls: 1, bytes: 1, secs: 0.1, ..Default::default() };
    let t = &TASKS[0];
    for (label, s, want_over) in [
        ("too many calls", &over, true),
        ("too many bytes", &fat,  true),
        ("too slow",       &slow, true),
        ("inside all",     &fine, false),
    ] {
        let is_over = s.calls > t.max_calls || s.bytes > t.max_bytes || s.secs > t.max_secs;
        if is_over == want_over {
            println!("  ok   budget    {} reads as {}", label,
                if want_over { "over" } else { "inside" });
        } else {
            println!("  FAIL budget    {} does not", label);
            bad += 1;
        }
    }

    println!();
    if bad == 0 {
        println!("self-test: every check answers both ways. The instrument is worth spending on.");
    } else {
        println!("self-test: {} check(s) cannot tell a right answer from a wrong one.", bad);
        println!("A check that will not go red is a finding, not a fixture problem. Fix it before spending.");
    }
    Ok(bad)
}

// ── The live run ─────────────────────────────────────────────────────────────────────

fn live(repo: &Path, chosen: &[&Task]) -> Outcome<usize> {
    let key = res!(std::env::var("DAIMOND_PROBE_KEY").map_err(|_| err!(
        "Set DAIMOND_PROBE_KEY to a provider key. Run PROBE_SELFTEST=1 first -- it is free \
         and it proves these checks can go red.";
        Init, Missing)));
    let host  = std::env::var("DAIMOND_PROBE_HOST")
        .unwrap_or_else(|_| fmt!("openrouter.ai"));
    let path  = std::env::var("DAIMOND_PROBE_PATH")
        .unwrap_or_else(|_| fmt!("/api/v1/chat/completions"));
    let model = std::env::var("DAIMOND_PROBE_MODEL")
        .unwrap_or_else(|_| fmt!("anthropic/claude-haiku-4.5"));

    println!("== a day's work, {} task(s) ==", chosen.len());
    println!("  repository  {:?}", repo);
    println!("  workspace   {:?}", ws_root());
    println!("  marks       {} (app), {} (wide)", app_rel(), wide_rel());
    println!("  model       {}", model);
    println!("  THIS SPENDS: one turn per task, each up to {} tool call(s).",
        chosen.iter().map(|t| t.max_calls).max().unwrap_or(0));
    if std::env::var("PROBE_YES").is_err() {
        println!("\n  Set PROBE_YES=1 to run. Nothing has been called yet.");
        return Ok(0);
    }

    let _ = rustls::crypto::ring::default_provider().install_default();
    let tls = res!(build_tls_client_config());

    let mut bad = 0usize;
    let mut rows: Vec<(String, bool, Spend, String)> = Vec::new();
    let mut state = repo_state(repo);

    for t in chosen {
        // Taken before the task and put back after it, so what the tree held going in is what
        // it holds coming out -- residue from an earlier run included, since with four other
        // people working here there is no way to tell residue from somebody's afternoon. The
        // rot that would otherwise cause is handled where it belongs: `period_key` chooses a
        // key the tree does not already carry.
        let snap = snapshot(repo, t.touches);
        if let Some(build) = t.setup {
            if let Err(e) = build(repo) {
                println!("  {:<9} fixture not built: {}", t.name, e);
                bad += 1;
                rows.push((t.name.to_string(), false, Spend::default(),
                    fmt!("the fixture could not be built: {}", e)));
                continue;
            }
        }
        let (ok, spend, why) = one_task(t, repo, &key, &host, &path, &model, tls.clone());
        revert(repo, t.touches, &snap);
        // After the check, which reads the fixture, and before the next task.
        if let Some(unbuild) = t.teardown {
            unbuild(repo);
        }
        // Four other people have uncommitted work in this tree. A task that moved HEAD or added
        // to the index did it to them, so it is a failure whatever its own verdict was -- and
        // nothing here undoes it, because the undo is what loses the afternoon.
        let now = repo_state(repo);
        let (ok, why) = if now == state {
            (ok, why)
        } else {
            let moved = fmt!("THIS TASK MOVED THE REPOSITORY UNDER TEST — before [{}], after \
                [{}]. Nothing was undone: other lanes' uncommitted work is in this tree, and a \
                reset is how that gets lost. Look before fixing it.{}",
                state, now, if why.is_empty() { String::new() } else { fmt!(" Also: {}", why) });
            state = now;
            (false, moved)
        };
        if !ok { bad += 1; }
        rows.push((t.name.to_string(), ok, spend, why));
    }

    println!("\n  {:<9} {:<7} {:>6} {:>9} {:>5} {:>5} {:>7}  {}",
        "task", "verdict", "calls", "bytes", "ref", "fail", "secs", "worst read");
    println!("  {}", "-".repeat(96));
    for (name, ok, s, _) in &rows {
        println!("  {:<9} {:<7} {:>6} {:>9} {:>5} {:>5} {:>7.1}  {} {}",
            name, if *ok { "pass" } else { "FAIL" }, s.calls, s.bytes,
            s.refused, s.failed, s.secs, s.worst.0, s.worst.1);
    }

    let failures: Vec<&(String, bool, Spend, String)> = rows.iter().filter(|r| !r.1).collect();
    if !failures.is_empty() {
        println!("\n  Why each failed, and what that task is for");
        println!("  {}", "-".repeat(96));
        for (name, _, _, why) in failures {
            let t = match TASKS.iter().find(|t| &t.name == name) {
                Some(t) => t,
                None    => continue,
            };
            println!("  {}", name);
            println!("      {}", why);
            println!("      catches: {}", t.catches);
        }
    }

    // Said on every run, pass or fail. A total that moved is how a regression announces
    // itself, and a run that only prints "pass" cannot show one.
    let calls: usize = rows.iter().map(|r| r.2.calls).sum();
    let bytes: usize = rows.iter().map(|r| r.2.bytes).sum();
    let secs:  f64   = rows.iter().map(|r| r.2.secs).sum();
    println!("\n  TOTAL  {} call(s), {} byte(s) of tool output, {:.0}s.",
        calls, bytes, secs);
    println!("  Compare with the last run rather than with nothing: the numbers are the finding.");
    Ok(bad)
}

/// Every file under the paths a task will touch, with its bytes, as they stand right now.
///
/// **This replaced a `git checkout --`, and the difference is somebody's afternoon.**  Reverting
/// to HEAD restores the paths to the last commit, which is correct only if nobody else has
/// uncommitted work in them.  On 2026-08-24 four other people were working in this tree and all
/// eight files under `www/i18n` -- the one path in any task's `touches` -- carried a lane's
/// unfinished translations.  The `locales` task would have run, been reverted, and taken those
/// with it, and the probe would have printed a clean table over the top.  A snapshot restores
/// what was THERE, which is the only thing an instrument has any business restoring.
fn snapshot(repo: &Path, touches: &[&str]) -> Vec<(PathBuf, Vec<u8>)> {
    let mut out: Vec<(PathBuf, Vec<u8>)> = Vec::new();
    for t in touches {
        collect(&repo.join(t), &mut out);
    }
    out
}

/// Every file at or under `p`, read into `out`.
fn collect(p: &Path, out: &mut Vec<(PathBuf, Vec<u8>)>) {
    if p.is_file() {
        if let Ok(b) = std::fs::read(p) {
            out.push((p.to_path_buf(), b));
        }
        return;
    }
    let listing = match std::fs::read_dir(p) {
        Ok(l)  => l,
        Err(_) => return,
    };
    for ent in listing.flatten() {
        collect(&ent.path(), out);
    }
}

/// Put the snapshot back, and take away anything that was not in it.
///
/// A file is rewritten only where its bytes actually differ, so a task that changed nothing
/// leaves no modification times behind for the next tool to puzzle over.
fn revert(repo: &Path, touches: &[&str], snap: &[(PathBuf, Vec<u8>)]) {
    if touches.is_empty() {
        return;
    }
    let mut now: Vec<(PathBuf, Vec<u8>)> = Vec::new();
    for t in touches {
        collect(&repo.join(t), &mut now);
    }
    for (p, _) in &now {
        if !snap.iter().any(|(q, _)| q == p) {
            let _ = std::fs::remove_file(p);
        }
    }
    for (p, bytes) in snap {
        let same = match std::fs::read(p) {
            Ok(b)  => &b == bytes,
            Err(_) => false,
        };
        if !same {
            if let Some(parent) = p.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let _ = std::fs::write(p, bytes);
        }
    }
}

/// Run one task's turn and measure it.
fn one_task(
    t:     &Task,
    repo:  &Path,
    key:   &str,
    host:  &str,
    path:  &str,
    model: &str,
    tls:   std::sync::Arc<rustls::ClientConfig>,
)
    -> (bool, Spend, String)
{
    let root = ws_root();
    let ws = match Workspace::new(root.clone()) {
        Ok(w)  => w,
        Err(e) => return (false, Spend::default(), fmt!("workspace at {:?}: {}", root, e)),
    };
    // The mark, INSIDE the workspace and never equal to it -- see `ws_root`.
    let mark = match t.mark {
        Mark::App  => app_rel(),
        Mark::Wide => wide_rel(),
    };
    // The bounds a Diamond's daimon carries. Built through `diamond_bounds` rather than
    // assembled here, so the probe runs under the rules the product runs under and cannot
    // drift from them -- including the `Nowhere` guard, which is what caught the harness's
    // own first mistake by refusing every call rather than quietly widening.
    let bounds = diamond_bounds("", &[mark], &[]);
    let ctx = ToolContext {
        workspace:   ws,
        executor:    Executor::local_default(),
        cwd:         String::new(),
        path_prefix: String::new(),
        root:        FileRoot::Workspace,
        read_seen:   oxedyne_daimond::tools::new_read_cache(),
        no_write:    bounds,
        daimon_of:   String::new(),
    };
    let registry = ToolRegistry::new(Tool::defaults(), ctx);

    let llm = LlmClient::new(host, 443, path, key, model, 4096, tls);
    // The daimon's own prompt, composed the way the app composes it, so the probe measures
    // the instruction the product ships and not a paraphrase of it.
    let system = oxedyne_daimond::prompts::Role::Daimon.compose("");
    let agent = Agent::new(llm, &system);
    let mut session = Session::new(
        fmt!("devcycle-{}", t.name), t.name.to_string(), model.to_string());

    // The app's own path, spelled as the file tools will see it. Written into the brief at
    // run time rather than hardcoded, so the brief cannot go stale against `ws_root`.
    let brief = t.brief.replace("{app}", &app_rel());
    // The locale key is chosen from the tree, so the brief cannot ask for something already
    // there. See `period_key`, and the constant that rotted before it.
    let (key, eng) = period_key(repo).unwrap_or(("spend.period_day", "Day"));
    let brief = brief.replace("{key}", key).replace("{eng}", eng);
    let mut s = Spend::default();
    let mut reply = String::new();
    let started = Instant::now();
    {
        let mut on_event = |ev: AgentEvent| {
            match ev {
                AgentEvent::Text(text) => reply.push_str(&text),
                AgentEvent::ToolCall { .. } => s.calls += 1,
                // The OUTCOME, never the prose. `CONTRACT_OUTCOME.md` §3.
                AgentEvent::ToolResult { name, result, outcome } => {
                    let (name2, result2) = (name.clone(), result.clone());
                    s.bytes += result.len();
                    if result.len() > s.worst.1 {
                        s.worst = (name, result.len());
                    }
                    match outcome {
                        CallOutcome::Refused => s.refused += 1,
                        CallOutcome::Failed  => s.failed  += 1,
                        CallOutcome::Done    => {}
                    }
                    if outcome != CallOutcome::Done && s.firstbad.is_none() {
                        s.firstbad = Some((name2,
                            result2.chars().take(240).collect::<String>()));
                    }
                }
                _ => {}
            }
        };
        let rt = match tokio::runtime::Runtime::new() {
            Ok(rt) => rt,
            Err(e) => return (false, s, fmt!("runtime: {}", e)),
        };
        if let Err(e) = rt.block_on(
            agent.run_turn(&mut session, brief, &registry, &mut on_event))
        {
            s.secs = started.elapsed().as_secs_f64();
            return (false, s, fmt!("the turn ended in an error: {}", e));
        }
    }
    s.secs = started.elapsed().as_secs_f64();
    s.prompt = session.prompt_tokens as u64;
    s.completion = session.completion_tokens as u64;

    // (1) It got there.
    if let Err(e) = (t.check)(repo, &reply) {
        return (false, s, fmt!("did not get there — {}", e));
    }
    // (2) It did not flail. A right answer reached through refusals found a fault and
    // worked around it, which is the thing this probe exists to stop happening silently.
    if s.refused > 0 || s.failed > 0 {
        let named = match &s.firstbad {
            Some((n, r)) => fmt!(" — first was {}: {}", n, r.replace('\n', " ")),
            None         => String::new(),
        };
        let why = fmt!("got there through {} refused and {} failed call(s){}",
            s.refused, s.failed, named);
        return (false, s, why);
    }
    // (3) It stayed inside the budget.
    if s.calls > t.max_calls {
        let why = fmt!("{} tool calls against a budget of {}", s.calls, t.max_calls);
        return (false, s, why);
    }
    if s.bytes > t.max_bytes {
        let why = fmt!("{} bytes of tool output against a budget of {} -- worst was {} at {}",
            s.bytes, t.max_bytes, s.worst.0, s.worst.1);
        return (false, s, why);
    }
    if s.secs > t.max_secs {
        let why = fmt!("{:.1}s against a budget of {:.0}s", s.secs, t.max_secs);
        return (false, s, why);
    }
    (true, s, String::new())
}
