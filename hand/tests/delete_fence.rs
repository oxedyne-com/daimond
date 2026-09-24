//! What a fenced command can delete, measured through the shipping launcher.
//!
//! Written first, as step 1 of `daimond_hand_delete_fence_design_20260923.md`, after a
//! daimon's command emptied a Diamond on 2026-09-22.  Every case runs a real program
//! through the real `daimond-hand` binary with `--daimond-hand-launch`, under a real
//! Landlock fence, against a fixture tree built fresh for that case.
//!
//! Two kinds of case, and the difference is the point:
//!
//! * **Destructive.**  A command that would remove a mark, or empty it.  The root half
//!   (a mark cannot be removed or renamed away) is closed by Landlock root immunity.
//!   The contents half (a mark cannot be emptied beyond the per-turn budget) is closed
//!   by the deletion meter.
//! * **Ordinary.**  What a developer does inside a mark every day.  Each must keep
//!   working, or the fence is a fence nobody can use.
//!
//! Baseline at `48aa5913`, before either fix: every destructive case removed what it
//! aimed at, except a top-level root, which already survived because its parent carries
//! no rule.  Every ordinary case passed.
//!
//! Each command carries a `Meter` naming the turn, which starts after the fixture is
//! planted, so the planted files are the ones that existed before the turn.  A held
//! command is answered as the test says -- stop, unless it says go on -- which is what an
//! unattended page does after `HOLD_MS`, only sooner.

use daimond_hand::exec::{
    Launcher,
    Runner,
    LAUNCH_ARG,
};
use daimond_hand::meter;
use daimond_hand::wire::{
    Capture,
    FenceSpec,
    Meter,
    Req,
    Resp,
    Stream,
};

use oxedyne_fe2o3_core::prelude::*;

use std::path::{
    Path,
    PathBuf,
};

// Files planted in a mark: more than the budget, so a meter that stops at the budget
// leaves some behind and one that does not leaves none.
const PLANTED: usize = 120;

// ┌───────────────────────────────────────────────────────────────┐
// │ Harness                                                        │
// └───────────────────────────────────────────────────────────────┘

/// What one run came back with.
struct Ran {
    exit:    i32,
    out:     String,
    err:     String,
    notes:   String,	// the hand's own sentences about the run
    held:    u32,		// how many times the meter asked
    counted: u32,		// what the meter counted, from `Metered`
    stopped: bool,
}

impl Ran {
    fn said(&self) -> String {
        fmt!("exit {}; held {}; counted {}; stopped {}; stdout {:?}; stderr {:?}; notes {:?}",
            self.exit, self.held, self.counted, self.stopped, self.out, self.err, self.notes)
    }
}

/// Where the trash goes for these tests, which is not the user's.
fn trash() -> PathBuf {
    static SET: std::sync::Once = std::sync::Once::new();
    let dir = home_cache().join("trash");
    SET.call_once(|| {
        let _ = std::fs::create_dir_all(&dir);
        // Set once, before any run reads it; the tests set nothing else in the environment.
        std::env::set_var(meter::TRASH_DIR_VAR, &dir);
    });
    dir
}

/// The start of a turn, just after its fixture was planted.
///
/// Distinct for every test, because the trash is keyed by the turn: two tests running in
/// the same millisecond would otherwise restore each other's files.
fn turn() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static LAST: AtomicU64 = AtomicU64::new(0);
    let _ = trash();
    std::thread::sleep(std::time::Duration::from_millis(5));
    let now = meter::Watch::now_ms();
    let got = LAST.fetch_max(now, Ordering::SeqCst);
    if got >= now {
        // Taken: a millisecond later instead, after waiting for it to pass.
        let next = LAST.fetch_add(1, Ordering::SeqCst) + 1;
        std::thread::sleep(std::time::Duration::from_millis(next.saturating_sub(now) + 1));
        return next;
    }
    now
}

/// Where every fixture goes: the home cache, never `/tmp`, and outside every toolchain
/// folder the hand knows -- `~/.cache/cargo-targets` and `~/.cache/daimond` among them --
/// since the meter does not count removals in a toolchain's cache.
fn home_cache() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    Path::new(&home).join(".cache/daimond-hand-delete-fence")
}

/// The fixture tree for one case.
fn fixture(case: &str) -> Outcome<PathBuf> {
    let dir = home_cache().join("cases").join(case);
    if dir.exists() {
        res!(std::fs::remove_dir_all(&dir));
    }
    res!(std::fs::create_dir_all(&dir));
    Ok(res!(dir.canonicalize()))
}

/// A mark with [`PLANTED`] files spread over three subdirectories.
fn plant(mark: &Path) -> Outcome<()> {
    for i in 0..PLANTED {
        let sub = mark.join(match i % 3 {
            0 => "src",
            1 => "docs",
            _ => "sub/deep",
        });
        res!(std::fs::create_dir_all(&sub));
        res!(std::fs::write(sub.join(fmt!("f{:03}.txt", i)), fmt!("file {}\n", i)));
    }
    Ok(())
}

/// How many regular files are left beneath `dir`, not following links.
fn files_under(dir: &Path) -> usize {
    let mut n = 0;
    let rd = match std::fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(_) => return 0,
    };
    for e in rd.flatten() {
        let ft = match e.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        if ft.is_dir() {
            n += files_under(&e.path());
        } else if ft.is_file() {
            n += 1;
        }
    }
    n
}

fn runner() -> Runner {
    Runner::with_launcher(Launcher::Explicit {
        prog: PathBuf::from(env!("CARGO_BIN_EXE_daimond-hand")),
        args: vec![fmt!("{}", LAUNCH_ARG)],
        env:  Vec::new(),
    })
}

fn s(p: &Path) -> String {
    fmt!("{}", p.display())
}

/// Runs `argv` in `cwd` behind a fence granting `rw` (and `ro`), within the turn that
/// began at `since`, and waits for it.  A held command is stopped.
async fn run(
    id:    &str,
    argv:  &[&str],
    cwd:   &Path,
    rw:    &[&Path],
    ro:    &[&Path],
    env:   &[(&str, &str)],
    since: u64,
)
    -> Outcome<Ran>
{
    run_answering(id, argv, cwd, rw, ro, env, since, false).await
}

#[allow(clippy::too_many_arguments)]
async fn run_answering(
    id:    &str,
    argv:  &[&str],
    cwd:   &Path,
    rw:    &[&Path],
    ro:    &[&Path],
    env:   &[(&str, &str)],
    since: u64,
    allow: bool,
)
    -> Outcome<Ran>
{
    let req = Req::Exec {
        id:         fmt!("{}", id),
        argv:       argv.iter().map(|a| fmt!("{}", a)).collect(),
        cwd:        s(cwd),
        env:        env.iter().map(|(k, v)| (fmt!("{}", k), fmt!("{}", v))).collect(),
        stdin:      None,
        timeout_ms: 60_000,
        capture:    Capture::Both,
        fence:      FenceSpec {
            rw:   rw.iter().map(|p| s(p)).collect(),
            ro:   ro.iter().map(|p| s(p)).collect(),
            deny: Vec::new(),
            net:  false,
        },
        toolkits:   Vec::new(),
        meter:      Some(Meter { budget: meter::BUDGET, since_ms: since }),
    };
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Resp>(1024);
    let runner = runner();
    res!(runner.spawn(req, tx).await);
    let mut ran = Ran {
        exit: -1, out: String::new(), err: String::new(), notes: String::new(),
        held: 0, counted: 0, stopped: false,
    };
    let deadline = std::time::Duration::from_secs(90);
    loop {
        let next = match tokio::time::timeout(deadline, rx.recv()).await {
            Ok(n)  => n,
            Err(_) => return Err(err!("'{}' said nothing for 90 s.", id; Test, Timeout)),
        };
        match next {
            Some(Resp::Chunk { stream: Stream::Out, data, .. }) => ran.out.push_str(&data),
            Some(Resp::Chunk { stream: Stream::Err, data, .. }) => ran.err.push_str(&data),
            Some(Resp::Ended { exit, .. }) => { ran.exit = exit; return Ok(ran); },
            Some(Resp::Held { .. }) => {
                ran.held += 1;
                res!(runner.release(id, allow));
            },
            Some(Resp::Metered { counted, stopped, .. }) => {
                ran.counted = counted;
                ran.stopped = stopped;
            },
            Some(Resp::Error { message, .. }) => { ran.notes.push_str(&message); ran.notes.push('\n'); },
            Some(Resp::Refused { reason, .. }) => return Err(err!(
                "'{}' was refused before it ran: {}", id, reason; Test, Unexpected)),
            Some(_) => (),
            None => return Err(err!("'{}' ended with no Ended.", id; Test, Missing)),
        }
    }
}

/// A granted root holding a nested mark: the unscoped fallback with a Diamond attached
/// inside it, which is the shape that let a whole mark go on 2026-09-22.
struct Nested {
    granted: PathBuf,	// the hand's granted root, rw
    mark:    PathBuf,	// a Diamond's folder inside it, rw in its own right
    since:   u64,		// the turn, begun after the planting
}

impl Nested {
    fn make(case: &str) -> Outcome<Self> {
        let base = res!(fixture(case));
        let granted = base.join("granted");
        let mark = granted.join("proj");
        res!(std::fs::create_dir_all(&mark));
        res!(plant(&mark));
        Ok(Self { granted, mark, since: turn() })
    }

    fn rw(&self) -> Vec<&Path> {
        vec![self.granted.as_path(), self.mark.as_path()]
    }
}

// ┌───────────────────────────────────────────────────────────────┐
// │ Destructive: the root half (Landlock root immunity)            │
// └───────────────────────────────────────────────────────────────┘

/// **`rm -rf` of a nested mark leaves the mark standing.**  Base: the mark was gone.
#[tokio::test]
async fn rm_rf_of_a_nested_mark_leaves_its_root() -> Outcome<()> {
    let n = res!(Nested::make("rm-rf-nested-root"));
    let r = res!(run("rm-rf-nested", &["/bin/rm", "-rf", &s(&n.mark)],
        &n.granted, &n.rw(), &[], &[], n.since).await);
    assert!(n.mark.is_dir(), "rm -rf removed the mark itself: {}", r.said());
    Ok(())
}

/// **`find <mark> -delete` leaves the mark standing.**  Base: the mark was gone.
#[tokio::test]
async fn find_delete_of_a_nested_mark_leaves_its_root() -> Outcome<()> {
    let n = res!(Nested::make("find-delete-nested-root"));
    let r = res!(run("find-nested", &["/usr/bin/find", &s(&n.mark), "-delete"],
        &n.granted, &n.rw(), &[], &[], n.since).await);
    assert!(n.mark.is_dir(), "find -delete removed the mark itself: {}", r.said());
    Ok(())
}

/// **`shutil.rmtree` of a nested mark leaves the mark standing.**  No argv names the
/// verb here, which is why nothing short of the kernel can see it.
#[tokio::test]
async fn rmtree_of_a_nested_mark_leaves_its_root() -> Outcome<()> {
    let n = res!(Nested::make("rmtree-nested-root"));
    let code = fmt!("import shutil; shutil.rmtree({:?})", s(&n.mark));
    let r = res!(run("rmtree-nested", &["/usr/bin/python3", "-c", &code],
        &n.granted, &n.rw(), &[], &[], n.since).await);
    assert!(n.mark.is_dir(), "rmtree removed the mark itself: {}", r.said());
    Ok(())
}

/// **`mv <mark> elsewhere` is refused, and the mark is still where it was.**
#[tokio::test]
async fn mv_of_a_nested_mark_is_refused() -> Outcome<()> {
    let n = res!(Nested::make("mv-nested"));
    let away = n.granted.join("away");
    let r = res!(run("mv-nested", &["/bin/mv", &s(&n.mark), &s(&away)],
        &n.granted, &n.rw(), &[], &[], n.since).await);
    assert_ne!(r.exit, 0, "mv of a mark succeeded: {}", r.said());
    assert!(n.mark.is_dir() && !away.exists(), "the mark moved: {}", r.said());
    assert_eq!(PLANTED, files_under(&n.mark), "the mark lost files: {}", r.said());
    Ok(())
}

/// **`rmdir` of an empty nested mark is refused.**  An empty mark is still a mark: the
/// Diamond's folder is what the page points at.
#[tokio::test]
async fn rmdir_of_an_empty_nested_mark_is_refused() -> Outcome<()> {
    let base = res!(fixture("rmdir-nested"));
    let granted = base.join("granted");
    let mark = granted.join("empty");
    res!(std::fs::create_dir_all(&mark));
    let since = turn();
    let r = res!(run("rmdir-nested", &["/usr/bin/rmdir", &s(&mark)],
        &granted, &[granted.as_path(), mark.as_path()], &[], &[], since).await);
    assert_ne!(r.exit, 0, "rmdir of a mark succeeded: {}", r.said());
    assert!(mark.is_dir(), "the mark was removed: {}", r.said());
    Ok(())
}

/// **A top-level root was already immune, and still is.**  Its parent carries no rule.
#[tokio::test]
async fn a_top_level_mark_cannot_be_removed_or_moved() -> Outcome<()> {
    let base = res!(fixture("top-level"));
    let mark = base.join("mark");
    res!(std::fs::create_dir_all(&mark));
    let since = turn();
    let r = res!(run("rmdir-top", &["/usr/bin/rmdir", &s(&mark)],
        &mark, &[mark.as_path()], &[], &[], since).await);
    assert!(mark.is_dir(), "rmdir removed a top-level root: {}", r.said());
    let r = res!(run("mv-top", &["/bin/mv", &s(&mark), &s(&mark.join("x"))],
        &mark, &[mark.as_path()], &[], &[], since).await);
    assert!(mark.is_dir(), "mv moved a top-level root: {}", r.said());
    Ok(())
}

// ┌───────────────────────────────────────────────────────────────┐
// │ Destructive: the contents half (the deletion meter)            │
// └───────────────────────────────────────────────────────────────┘

// Known open at ae317187, closed by the deletion meter (design 4.2).  Landlock cannot deny
// removal inside a mark without breaking git and every atomic save, so on its own the root
// survives and everything in it goes.  Each case asserts what the meter promises: the
// command is held at the budget, at least PLANTED - 64 pre-existing files survive, and the
// ones that went are in the trash.

const BUDGET: usize = 64;

/// The meter's promise, checked against the tree and the run.
fn held_at_budget(mark: &Path, r: &Ran) {
    let left = files_under(mark);
    assert!(left >= PLANTED - BUDGET, "{} of {} left: {}", left, PLANTED, r.said());
    assert_eq!(1, r.held, "the command was not held once: {}", r.said());
    assert!(r.stopped, "the meter did not stop it: {}", r.said());
    assert_eq!(BUDGET as u32, r.counted, "{}", r.said());
    assert_eq!(PLANTED, left + r.counted as usize, "a file went uncounted: {}", r.said());
}

#[tokio::test]
async fn meter_rm_rf_of_a_top_level_mark_stops_at_the_budget() -> Outcome<()> {
    let base = res!(fixture("meter-rm-rf-top"));
    let mark = base.join("mark");
    res!(std::fs::create_dir_all(&mark));
    res!(plant(&mark));
    let since = turn();
    let r = res!(run("meter-rm-top", &["/bin/rm", "-rf", &s(&mark)],
        &mark, &[mark.as_path()], &[], &[], since).await);
    held_at_budget(&mark, &r);
    Ok(())
}

#[tokio::test]
async fn meter_rm_rf_of_a_nested_mark_stops_at_the_budget() -> Outcome<()> {
    let n = res!(Nested::make("meter-rm-rf-nested"));
    let r = res!(run("meter-rm-nested", &["/bin/rm", "-rf", &s(&n.mark)],
        &n.granted, &n.rw(), &[], &[], n.since).await);
    held_at_budget(&n.mark, &r);
    Ok(())
}

#[tokio::test]
async fn meter_rm_rf_of_a_subdirectory_stops_at_the_budget() -> Outcome<()> {
    let n = res!(Nested::make("meter-rm-rf-sub"));
    let r = res!(run("meter-rm-sub", &["/bin/rm", "-rf", &s(&n.mark.join("sub")),
        &s(&n.mark.join("src")), &s(&n.mark.join("docs"))],
        &n.mark, &n.rw(), &[], &[], n.since).await);
    held_at_budget(&n.mark, &r);
    Ok(())
}

#[tokio::test]
async fn meter_find_delete_stops_at_the_budget() -> Outcome<()> {
    let n = res!(Nested::make("meter-find"));
    let r = res!(run("meter-find", &["/usr/bin/find", &s(&n.mark), "-delete"],
        &n.granted, &n.rw(), &[], &[], n.since).await);
    held_at_budget(&n.mark, &r);
    Ok(())
}

#[tokio::test]
async fn meter_rmtree_stops_at_the_budget() -> Outcome<()> {
    let n = res!(Nested::make("meter-rmtree"));
    let code = fmt!("import shutil; shutil.rmtree({:?})", s(&n.mark));
    let r = res!(run("meter-rmtree", &["/usr/bin/python3", "-c", &code],
        &n.granted, &n.rw(), &[], &[], n.since).await);
    held_at_budget(&n.mark, &r);
    Ok(())
}

/// **What the meter stopped can be put back whole.**
#[tokio::test]
async fn a_stopped_removal_is_put_back_from_the_trash() -> Outcome<()> {
    let n = res!(Nested::make("meter-restore"));
    let r = res!(run("meter-restore", &["/bin/rm", "-rf", &s(&n.mark)],
        &n.granted, &n.rw(), &[], &[], n.since).await);
    held_at_budget(&n.mark, &r);
    let (put, left) = res!(meter::restore(&trash(), n.since));
    assert_eq!((BUDGET as u32, 0), (put, left));
    assert_eq!(PLANTED, files_under(&n.mark), "the mark did not come back whole");
    Ok(())
}

/// **A "go on" lets the command finish, and everything it took is still in the trash.**
#[tokio::test]
async fn a_released_removal_finishes_and_is_kept() -> Outcome<()> {
    let n = res!(Nested::make("meter-allow"));
    let r = res!(run_answering("meter-allow", &["/bin/rm", "-rf", &s(&n.mark)],
        &n.granted, &n.rw(), &[], &[], n.since, true).await);
    assert_eq!(1, r.held, "{}", r.said());
    assert!(!r.stopped, "{}", r.said());
    assert_eq!(PLANTED as u32, r.counted, "{}", r.said());
    assert_eq!(0, files_under(&n.mark));
    assert!(n.mark.is_dir(), "the root went: {}", r.said());
    assert!(r.notes.contains("root"), "no readable refusal for the root: {}", r.said());
    let (put, _) = res!(meter::restore(&trash(), n.since));
    assert_eq!(PLANTED as u32, put);
    assert_eq!(PLANTED, files_under(&n.mark));
    Ok(())
}

/// **Moving files into a cache and emptying the cache still counts them.**
#[tokio::test]
async fn laundering_through_a_cache_is_counted() -> Outcome<()> {
    let n = res!(Nested::make("meter-launder"));
    let target = n.mark.join("target");
    res!(std::fs::create_dir_all(&target));
    res!(std::fs::write(target.join("CACHEDIR.TAG"),
        "Signature: 8a477f597d28d172789f06886806bc55\n"));
    let r = res!(run("launder-mv", &["/bin/mv", &s(&n.mark.join("src")), &s(&target.join("x"))],
        &n.mark, &n.rw(), &[], &[], n.since).await);
    let moved = r.counted;
    let r = res!(run("launder-rm", &["/bin/rm", "-rf", &s(&target)],
        &n.mark, &n.rw(), &[], &[], n.since).await);
    assert_eq!((PLANTED / 3) as u32, moved + r.counted,
        "the files moved into target/ went uncounted: {}", r.said());
    Ok(())
}

// ┌───────────────────────────────────────────────────────────────┐
// │ Destructive: replacing rather than removing (audit F3)         │
// └───────────────────────────────────────────────────────────────┘

// A rename onto a file that was there before the turn destroys that file's bytes as surely
// as `rm` does.  Until the audit of 2026-09-23 the judge read only the source, which a
// replacing command has just made, so `mv -f <new> <old>` took `<old>` uncounted and unkept.

/// How many planted files still hold what [`plant`] wrote into them.
fn originals_under(dir: &Path) -> usize {
    let mut n = 0;
    let rd = match std::fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(_) => return 0,
    };
    for e in rd.flatten() {
        let p = e.path();
        match e.file_type() {
            Ok(ft) if ft.is_dir()  => n += originals_under(&p),
            Ok(ft) if ft.is_file() => {
                if std::fs::read_to_string(&p).map(|t| t.starts_with("file ")).unwrap_or(false) {
                    n += 1;
                }
            },
            _ => (),
        }
    }
    n
}

/// Where the trash keeps the first copy of `victim` taken during the turn `since`.
fn kept(since: u64, victim: &Path) -> PathBuf {
    let mut p = trash().join(fmt!("{}", since)).join("0");
    for c in victim.components() {
        if let std::path::Component::Normal(n) = c {
            p.push(n);
        }
    }
    p
}

/// **`mv -f <new> <old>` counts the old file, and keeps it in the trash first.**
#[tokio::test]
async fn a_rename_over_an_old_file_is_counted_and_kept() -> Outcome<()> {
    let n = res!(Nested::make("meter-rename-over"));
    let old = n.mark.join("src/f000.txt");
    let new = n.mark.join("src/new.tmp");
    let r = res!(run("meter-rename-over",
        &["/bin/sh", "-c", "printf junk > \"$1\" && /bin/mv -f \"$1\" \"$2\"", "sh", &s(&new), &s(&old)],
        &n.mark, &n.rw(), &[], &[], n.since).await);
    assert_eq!(0, r.exit, "the replacing mv failed: {}", r.said());
    assert_eq!("junk", res!(std::fs::read_to_string(&old)), "{}", r.said());
    assert_eq!(1, r.counted, "the replaced file went uncounted: {}", r.said());
    assert_eq!(0, r.held, "{}", r.said());
    assert_eq!("file 0\n", res!(std::fs::read_to_string(kept(n.since, &old))),
        "the replaced file's bytes are not in the trash: {}", r.said());
    Ok(())
}

/// **Replacing more old files than the budget is held at the budget, as removing them is.**
#[tokio::test]
async fn replacing_old_files_past_the_budget_is_held() -> Outcome<()> {
    let n = res!(Nested::make("meter-rename-over-budget"));
    // Every planted file rewritten the way an editor saves one: a new file, renamed over it.
    let code = fmt!(
        "import os\nfor root, _, names in os.walk({:?}):\n    for f in names:\n        \
        p = os.path.join(root, f)\n        open(p + '.new', 'w').write('junk')\n        \
        os.replace(p + '.new', p)\n", s(&n.mark));
    let r = res!(run("meter-replace", &["/usr/bin/python3", "-c", &code],
        &n.mark, &n.rw(), &[], &[], n.since).await);
    let left = originals_under(&n.mark);
    assert_eq!(1, r.held, "the command was not held once: {}", r.said());
    assert!(r.stopped, "{}", r.said());
    assert_eq!(BUDGET as u32, r.counted, "{}", r.said());
    assert_eq!(PLANTED, left + r.counted as usize, "a file was replaced uncounted: {}", r.said());
    Ok(())
}

// ┌───────────────────────────────────────────────────────────────┐
// │ Ordinary: what must keep working inside a nested mark          │
// └───────────────────────────────────────────────────────────────┘

/// **`rm -rf target` of a cargo cache inside a mark still works.**
#[tokio::test]
async fn rm_rf_of_a_cargo_target_still_works() -> Outcome<()> {
    let n = res!(Nested::make("ok-target"));
    let target = n.mark.join("target");
    res!(std::fs::create_dir_all(target.join("debug/deps")));
    res!(std::fs::write(target.join("CACHEDIR.TAG"),
        "Signature: 8a477f597d28d172789f06886806bc55\n"));
    for i in 0..200 {
        res!(std::fs::write(target.join("debug/deps").join(fmt!("o{}.rlib", i)), "x"));
    }
    let r = res!(run("ok-target", &["/bin/rm", "-rf", "target"],
        &n.mark, &n.rw(), &[], &[], n.since).await);
    assert_eq!(0, r.exit, "rm -rf target failed: {}", r.said());
    assert!(!target.exists(), "target survived: {}", r.said());
    assert_eq!(PLANTED, files_under(&n.mark));
    Ok(())
}

/// **A file made this turn can be removed.**
#[tokio::test]
async fn rm_of_a_file_made_this_turn_still_works() -> Outcome<()> {
    let n = res!(Nested::make("ok-temp"));
    let tmp = n.mark.join("scratch.tmp");
    let r = res!(run("ok-touch", &["/usr/bin/touch", &s(&tmp)],
        &n.mark, &n.rw(), &[], &[], n.since).await);
    assert_eq!(0, r.exit, "touch failed: {}", r.said());
    let r = res!(run("ok-rm", &["/bin/rm", &s(&tmp)], &n.mark, &n.rw(), &[], &[], n.since).await);
    assert_eq!(0, r.exit, "rm of a new file failed: {}", r.said());
    assert!(!tmp.exists());
    Ok(())
}

/// **A file can still be made and written directly beside a nested mark.**  The parent
/// of a mark loses removal and renaming, and nothing else.
#[tokio::test]
async fn a_file_can_be_made_beside_a_nested_mark() -> Outcome<()> {
    let n = res!(Nested::make("ok-beside"));
    let f = n.granted.join("notes.txt");
    let code = fmt!("open({:?}, 'w').write('hello')", s(&f));
    let r = res!(run("ok-beside", &["/usr/bin/python3", "-c", &code],
        &n.granted, &n.rw(), &[], &[], n.since).await);
    assert_eq!(0, r.exit, "a write beside the mark failed: {}", r.said());
    assert_eq!("hello", res!(std::fs::read_to_string(&f)));
    Ok(())
}

/// **Rename-over saves inside a mark still work:** `sed -i` and `os.replace`.
#[tokio::test]
async fn rename_over_saves_still_work() -> Outcome<()> {
    let n = res!(Nested::make("ok-save"));
    let f = n.mark.join("src/f000.txt");
    let r = res!(run("ok-sed", &["/usr/bin/sed", "-i", "s/file/edited/", &s(&f)],
        &n.mark, &n.rw(), &[], &[], n.since).await);
    assert_eq!(0, r.exit, "sed -i failed: {}", r.said());
    assert_eq!("edited 0\n", res!(std::fs::read_to_string(&f)));
    let code = fmt!(
        "import os; open({:?}, 'w').write('saved'); os.replace({:?}, {:?})",
        s(&n.mark.join("src/.f000.swp")), s(&n.mark.join("src/.f000.swp")), s(&f));
    let r = res!(run("ok-replace", &["/usr/bin/python3", "-c", &code],
        &n.mark, &n.rw(), &[], &[], n.since).await);
    assert_eq!(0, r.exit, "os.replace failed: {}", r.said());
    assert_eq!("saved", res!(std::fs::read_to_string(&f)));
    assert_eq!(PLANTED, files_under(&n.mark));
    Ok(())
}

/// **git inside a mark still works:** init, commit, branch, switch, rename a branch.
#[tokio::test]
async fn git_inside_a_mark_still_works() -> Outcome<()> {
    let n = res!(Nested::make("ok-git"));
    let home = n.granted.parent().map(|p| p.join("home")).unwrap_or_default();
    res!(std::fs::create_dir_all(&home));
    res!(std::fs::write(home.join(".gitconfig"), "[init]\n\tdefaultBranch = main\n"));
    let h = s(&home);
    let env = [
        ("HOME", h.as_str()),
        ("GIT_CONFIG_NOSYSTEM", "1"),
        ("GIT_AUTHOR_NAME", "Test"),
        ("GIT_AUTHOR_EMAIL", "test@example.invalid"),
        ("GIT_COMMITTER_NAME", "Test"),
        ("GIT_COMMITTER_EMAIL", "test@example.invalid"),
    ];
    let rw = n.rw();
    let ro = [home.as_path()];
    let steps: &[&[&str]] = &[
        &["/usr/bin/git", "init", "-q"],
        &["/usr/bin/git", "add", "-A"],
        &["/usr/bin/git", "commit", "-q", "-m", "one"],
        &["/usr/bin/git", "checkout", "-q", "-b", "feature"],
        &["/usr/bin/git", "rm", "-q", "-r", "docs"],
        &["/usr/bin/git", "commit", "-q", "-m", "drop docs"],
        &["/usr/bin/git", "checkout", "-q", "main"],
        &["/usr/bin/git", "branch", "-m", "feature", "renamed"],
        &["/usr/bin/git", "checkout", "-q", "renamed"],
        &["/usr/bin/git", "checkout", "-q", "main"],
    ];
    for (i, argv) in steps.iter().enumerate() {
        let r = res!(run(&fmt!("ok-git-{}", i), argv, &n.mark, &rw, &ro, &env, n.since).await);
        assert_eq!(0, r.exit, "{:?} failed: {}", argv, r.said());
    }
    assert_eq!(PLANTED, files_under(&n.mark) - files_under(&n.mark.join(".git")),
        "the work tree did not come back whole on main");
    Ok(())
}
