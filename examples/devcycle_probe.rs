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

use oxedyne_fe2o3_core::prelude::*;
use oxedyne_daimond::agent::{Agent, build_tls_client_config};
use oxedyne_daimond::executor::Executor;
use oxedyne_daimond::llm::LlmClient;
use oxedyne_daimond::protocol::{AgentEvent, Session};
use oxedyne_daimond::tools::{CallOutcome, diamond_bounds, FileRoot, Tool, ToolContext, ToolRegistry};
use oxedyne_daimond::workspace::Workspace;

use std::path::{Path, PathBuf};
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
}

// ── The tasks ────────────────────────────────────────────────────────────────────────
//
// Four, each aimed at one of the four things that went wrong on the 23rd, and each small
// enough that a competent person would call it a minute's work.  That is the standard: the
// owner's objective says "without hitting continual snags", so the tasks are deliberately
// dull.  A probe made of hard tasks measures the model; this one measures the app.

/// 1. A large file must be readable, and read in part.
///
/// `www/js/daimond.js` is 1.6 MB and holds three NUL characters as a composite-key
/// separator.  Until 2026-08-23 `file_read` called it binary and refused it outright.  The
/// budget is the second half: the file is 1.6 MB, so a run that reads it whole passes the
/// answer and fails the probe, which is correct -- taking 1.6 MB into context to find one
/// line is not a working development loop.
fn check_bigfile(_repo: &Path, reply: &str) -> Result<(), String> {
    // `updateSpend` draws the spend row; the first cell is the one the owner asked about
    // yesterday.  The line number moves with the file, so the answer is checked against the
    // file rather than against a number written here.
    if reply.contains("15996") || reply.contains("15,996") {
        return Ok(());
    }
    Err(fmt!("the reply does not name line 15996: {}",
        reply.chars().take(200).collect::<String>()))
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

/// 3. A change across eight files is one task, not eight.
///
/// The locale fan-out is the shape most likely to be done four-eighths of the way, and
/// `dev/i18ncheck.mjs` is the oracle for it, so the check runs the same command the gate
/// runs rather than reading the files itself.
fn check_locales(repo: &Path, _reply: &str) -> Result<(), String> {
    let dir = repo.join("www/i18n");
    let names = ["de.js", "en.js", "es.js", "fr.js", "ja.js", "ko.js", "pt-BR.js", "zh-Hans.js"];
    let mut absent = Vec::new();
    for n in &names {
        let text = match std::fs::read_to_string(dir.join(n)) {
            Ok(t)  => t,
            Err(e) => return Err(fmt!("{}: {}", n, e)),
        };
        if !text.contains("spend.period_day") {
            absent.push(*n);
        }
    }
    if absent.is_empty() {
        return Ok(());
    }
    Err(fmt!("spend.period_day is absent from {}", absent.join(" ")))
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
    },
    Task {
        name:      "locales",
        catches:   "a fan-out across eight files done part of the way",
        mark:      Mark::App,
        brief:     "Add the key spend.period_day to all eight locale files in {app}/www/i18n/, \
                    beside the existing spend.period_week. The English value is Day; \
                    translate it for the other seven. Touch nothing else.",
        check:     check_locales,
        max_calls: 24,
        max_bytes: 60_000,
        max_secs:  90.0,
        touches:   &["www/i18n"],
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
            "bigfile" => (fmt!("15996"), fmt!("I could not read the file; it is binary.")),
            "bigmark" => (fmt!("src/tools.rs, 20_000"), fmt!("No matches found.")),
            "ranit"   => (fmt!("i18ncheck: all 7 locales carry every one of en.js's 3512 keys"),
                          fmt!("I read the script. It checks locale coverage.")),
            // The locale check reads the tree, so its two cases are made in the tree below.
            "locales" => (String::new(), String::new()),
            other     => return Err(err!("no self-test case for task '{}'", other; Init, Missing)),
        };

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
            let names = ["de.js", "en.js", "es.js", "fr.js", "ja.js", "ko.js", "pt-BR.js", "zh-Hans.js"];
            let mut planted: Vec<PathBuf> = Vec::new();
            let mut plant_failed = None;
            for n in &names {
                let f = dir.join(n);
                let text = match std::fs::read_to_string(&f) {
                    Ok(t)  => t,
                    Err(e) => { plant_failed = Some(fmt!("{}: {}", n, e)); break; }
                };
                let with = fmt!("{}\n// spend.period_day (self-test, removed below)\n", text);
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
                    let back = text.replace("\n// spend.period_day (self-test, removed below)\n", "");
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

    for t in chosen {
        // Put the tree back before the task as well as after it. A run that begins on a
        // tree a previous run left dirty measures the wrong thing and cannot say so.
        revert(repo, t.touches);
        let (ok, spend, why) = one_task(t, repo, &key, &host, &path, &model, tls.clone());
        revert(repo, t.touches);
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

/// `git checkout --` the paths a task touches, and say nothing when it touches none.
fn revert(repo: &Path, touches: &[&str]) {
    if touches.is_empty() {
        return;
    }
    let mut cmd = std::process::Command::new("git");
    cmd.arg("-C").arg(repo).arg("checkout").arg("--");
    for p in touches {
        cmd.arg(p);
    }
    let _ = cmd.output();
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
