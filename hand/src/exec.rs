//! Running a command: `argv` only, explicit environment, streamed, killable.
//!
//! The app's existing `Executor` hands a string to `sh -c`, waits, and returns
//! one whole `CommandOutput`.  Three things are wrong with that here, and this
//! module is the answer to all three.
//!
//! * **The shell is the injection surface.**  A string given to `sh` has to be
//!   defended against `;`, `$(…)`, backticks, `|`, `eval`, `base64 -d | sh`,
//!   `find -exec` and `tar --to-command`, and that defence does not exist -- a
//!   fence made of string matching is not a fence.  Passing the argument vector
//!   *removes* the surface rather than guarding it.  There is no `sh -c`
//!   anywhere in this file, tests included, and that absence is the design.
//! * **Waiting is not watching.**  An agent driving `cargo test` needs to see
//!   progress, so both streams are read concurrently and emitted as
//!   [`wire::Resp::Chunk`] as they arrive, bounded by [`CHUNK_MAX`], with a
//!   monotonic per-stream sequence so a dropped frame is detectable.
//! * **A run must be reachable while it runs.**  Every live command is in a
//!   registry keyed by the caller's identifier, so [`Runner::signal`] can reach
//!   one, and a hard wall-clock timeout can end one that will not stop.
//!
//! Two smaller decisions worth naming.  The environment is *cleared* and then
//! rebuilt from the pairs the caller gave, because the hand inherits whatever
//! launched the browser and that includes credentials nobody meant to lend a
//! command.  And the child is put in its own process group, so killing it kills
//! the compilers and test binaries it spawned rather than orphaning them.
//!
//! # Nothing runs until the fence is on it
//!
//! Landlock restricts *the calling thread* and is inherited across `execve`.
//! There is no call that hands a ruleset to somebody else's child, and the one
//! hook Rust offers for running code between `fork` and `exec` --
//! `CommandExt::pre_exec` -- is `unsafe`, which this project does not write.
//!
//! So the hand does not spawn the command.  It spawns **itself**, as a launcher:
//! a second copy of this binary that reads a plan, applies it to itself while it
//! is still a small single-purpose process that has opened nothing, and then
//! calls [`std::os::unix::process::CommandExt::exec`] -- which is safe -- to
//! *become* the command.  The fence carries across the `exec`, which
//! `fence::tests::the_fence_is_inherited_by_a_real_program` proves against a
//! real kernel.
//!
//! Everything the launcher needs travels down its **standard input**, and that
//! is a decision rather than an accident.  See [`LAUNCH_ARG`] for why not argv,
//! why not the environment, and why not a spare descriptor.
//!
//! # Every command is given somewhere to write
//!
//! A real build writes temporary files, and it writes them where `TMPDIR` says
//! -- which, unset, is `/tmp`.  `/tmp` is shared with every other process the
//! user runs, so it is outside every fence this hand builds, and a fenced
//! `cargo test` therefore died forty seconds into a compile with `couldn't
//! create a temp dir: Permission denied (os error 13) at path
//! "/tmp/rustcOHkDBV"`.  That is the worst shape a failure can take here: late,
//! obscure, and about a path nobody asked for.
//!
//! So [`Scratch`] makes one private directory per run, adds it to that run's
//! fence as a writable root, and points `TMPDIR`, `TMP` and `TEMP` at it.  It is
//! unconditional and it is not configurable by the caller, because a caller that
//! could name `TMPDIR` would be choosing where a command writes -- and the
//! environment is not the caller's to set for exactly that reason.  It lives
//! under the hand's own data directory rather than in the Diamond's workspace,
//! since a build's temporary files are not the user's work, and it is removed
//! when the run ends however the run ended.

use crate::{
    fence::{
        Fence,
        Grant,
        Level,
        Listing,
        Plan,
        Reach,
        SysBase,
        Unfenced,
    },
    seccomp::{
        Seccomp,
        Spec as SysSpec,
    },
    wire::{
        Capture,
        FenceSpec,
        FileOp,
        Req,
        Resp,
        Run,
        RunState,
        Sig,
        Stream,
        CHUNK_MAX,
        RUNS_MAX,
        RUN_WHAT_MAX,
        FILE_TEXT_MAX,
        SEARCH_ANSWER_MAX,
        SEARCH_CONTEXT_LINES,
    },
};

use oxedyne_fe2o3_core::prelude::*;
use oxedyne_fe2o3_core::rand::Rand;
// The SAME matchers the page compiles, from the same source text. Two engines that agree
// today is not a property worth resting a search on: the hand's pass decides which files are
// worth carrying and the page's decides what the reader sees, so a hand that matched less
// than the page would hide files the page would have reported and nothing would say so.
use oxedyne_fe2o3_text::glob::Glob;
use oxedyne_fe2o3_text::regex::Regex;

use std::{
    collections::HashMap,
    path::{
        Path,
        PathBuf,
    },
    process::Stdio,
    sync::{
        atomic::{
            AtomicBool,
            AtomicU64,
            Ordering,
        },
        Arc,
        Mutex,
        OnceLock,
    },
    time::Duration,
};

use tokio::{
    io::{
        AsyncRead,
        AsyncReadExt,
        AsyncWriteExt,
    },
    process::{
        Child,
        Command,
    },
    sync::mpsc::{
        Sender,
        UnboundedReceiver,
        UnboundedSender,
    },
    task::JoinHandle,
    time::timeout,
};

// ┌───────────────────────────────────────────────────────────────┐
// │ Limits                                                         │
// └───────────────────────────────────────────────────────────────┘

/// The wall-clock limit applied when the caller asks for none.
///
/// Zero is read as "no preference", not as "no limit": a command with no
/// ceiling is a command that can hold a slot for ever.
pub const DEFAULT_TIMEOUT_MS: u64 = 120_000;

/// The longest wall-clock limit the hand will honour, whatever was asked for.
pub const TIMEOUT_MAX_MS: u64 = 24 * 60 * 60 * 1_000;

/// How long the readers are given to drain after the child has exited.
///
/// A grandchild that survived the group kill can hold the write end of a pipe
/// open indefinitely; after this the readers are abandoned so that
/// [`wire::Resp::Ended`] is not held up behind them.
pub const DRAIN_GRACE_MS: u64 = 2_000;

/// How long a group-signal helper is given before it is given up on.
const SIGNAL_GRACE_MS: u64 = 2_000;

/// How long a signalled process group is given to empty before it is looked at.
///
/// A signal is delivered before it is acted on: between the `kill` returning and
/// the target running its exit path there is a scheduler tick, and a probe taken
/// inside it sees a process that is already dying.  Short for the same reason --
/// a tick is all there is between a `KILL` and an empty group, and a longer wait
/// would only make a `TERM` that is being obeyed slowly look more like one that
/// is being ignored, which is a judgement this code deliberately does not make.
///
/// A member already reaped needs no wait at all: [`counts_as_member`] does not
/// count a zombie, so the group reads as empty the moment the last of it has
/// exited rather than the moment the kernel gets round to collecting it.
const STOP_SETTLE_MS: u64 = 250;

/// Bytes taken from a pipe in one read.
///
/// Below [`CHUNK_MAX`] by the most a held-back partial character can add, so an
/// ordinary text read never has to be split.
const READ_MAX: usize = CHUNK_MAX - 4;

/// The most output one run will forward, across both streams together.
///
/// [`CHUNK_MAX`] bounds a single frame and nothing bounded the total, which is
/// not the same guarantee at all: `yes` under a three-second timeout delivered
/// 3,406,442,688 bytes in 52,067 frames.  Memory was never at risk -- the pipe
/// is drained as it fills -- but the journal, the extension's message pipe and
/// the page's own buffers all absorbed every byte of it.
///
/// Twenty megabytes is roughly two hundred times the largest `cargo test` output
/// seen in practice, and small enough that the whole of it can sit in a page.
pub const OUTPUT_TOTAL_MAX: u64 = 20 * 1024 * 1024;

/// The argument that tells a copy of this binary it is a launcher.
///
/// # Why the plan does not travel here, and does not travel in the environment
///
/// A command must not be able to read its own fence.  Knowing exactly which
/// paths are granted, which are carved and which are denied is a map of where to
/// probe, and it names paths -- a Diamond's directory, an attachment, the
/// journal -- that the command was never told about.
///
/// `argv` and the environment both fail that test while the launcher lives, and
/// the window is not the point: `/proc/<pid>/cmdline` and `/proc/<pid>/environ`
/// are readable by every process of the same user, `ps` shows the one and `ps e`
/// the other, and any of it may be captured by an unrelated monitor.  After the
/// `exec` both are replaced by the command's own -- so the leak would be a race
/// rather than a certainty, which is worse, not better: it would pass every test
/// and fail in the field.
///
/// The obvious alternative is a spare descriptor, say fd 3.  It cannot be done
/// here: handing a child a descriptor above 2 needs either `pre_exec` or an
/// `fcntl` to clear `FD_CLOEXEC`, and both are `unsafe`.
///
/// So the plan travels on **standard input**, length-prefixed, and the
/// command's own standard input follows immediately behind it in the same pipe.
/// The launcher reads exactly the plan's bytes and not one more, leaving the
/// remainder for the command it becomes.  Nothing is ever visible in `argv`, in
/// the environment, or on disc.
pub const LAUNCH_ARG: &str = "--daimond-hand-launch";

/// The launcher could not read a plan on its standard input.
pub const EXIT_NO_PLAN: i32 = 125;

/// The launcher read a plan and could not apply it, so it did not exec.
///
/// The one exit code that must never be confused with a command's own: it means
/// the fence was not in force, and therefore that the command did not run.
pub const EXIT_FENCE_FAILED: i32 = 126;

/// The fence was applied and the command could not then be started.
pub const EXIT_EXEC_FAILED: i32 = 127;

/// The `PATH` used to resolve a bare program name when the caller named none.
///
/// Deliberately short and absolute.  The caller may supply its own `PATH`, and
/// whatever it supplies is used only to *find* a candidate: the candidate is
/// then resolved and checked against the fence like any other path, so a `PATH`
/// pointing somewhere unfenced finds a program the command is not allowed to
/// run and is refused by name.
const PATH_FALLBACK: &str = "/usr/local/bin:/usr/bin:/bin";

// ┌───────────────────────────────────────────────────────────────┐
// │ Outcomes the caller distinguishes                              │
// └───────────────────────────────────────────────────────────────┘

/// What became of a request to start a command.
///
/// An enum rather than an error, because a refusal is not a failure: the hand
/// declined, said why in a whole sentence, and the model can recover from that.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Launch {
    /// The command is running under this process id, which is also its group.
    Started(u32),
    /// The hand declined; the sentence has already gone out as
    /// [`wire::Resp::Refused`].
    Refused,
}

/// What became of a request to signal a command.
///
/// Three arms and not two, because the missing one was the defect.  A signal
/// that was attempted and did not take used to answer `Finished`, which reads as
/// "it had already stopped" -- so a page told its command was gone had no way to
/// learn that it was not.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Signalled {
    Sent,			// handed to the supervisor, or sent to a standing group
    Finished,		// no such run; it had already gone. Not an error
    Failed(String),	// the signal was attempted and did not take; the sentence says what happened
}

/// The result of vetting a working directory against a fence.
pub(crate) enum Vetted {
    /// The resolved, absolute, in-fence directory.
    Ok(PathBuf),
    /// The whole sentence explaining what was refused and why.
    Refused(String),
}

/// The result of vetting the program a caller asked to run.
pub(crate) enum Vetted0 {
    /// The resolved, absolute, in-fence program.
    Ok(PathBuf),
    /// The whole sentence explaining what was refused and why.
    Refused(String),
}

/// Which program is re-executed to become the launcher.
///
/// An enum with two arms rather than a path with a default, because the two arms
/// are not interchangeable and the difference should be readable at the call
/// site.  [`Launcher::SelfExe`] is the only one the hand uses.
///
/// The test arm exists because the launcher cannot be exercised any other way
/// from inside a test binary: `/proc/self/exe` there is the *test* binary, whose
/// `main` is libtest's and which will not dispatch [`LAUNCH_ARG`].  Pointing it
/// back at the test binary with libtest's own arguments makes a chosen test
/// function the launcher entry, so the real [`launch_main`] runs, applies a real
/// fence and really `exec`s -- which is the only way to prove the join between
/// this module and `fence`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Launcher {
    /// This binary, through `/proc/self/exe`, run with [`LAUNCH_ARG`].
    ///
    /// Never `argv[0]`: that is whatever the caller of `execve` chose to put
    /// there, and on a Linux system it is trivially a lie.  `/proc/self/exe` is
    /// the kernel's own answer to "which file is this process running".
    ///
    /// The path is handed to `execve` *as itself* rather than resolved first,
    /// which matters twice over.  A binary that has been replaced or unlinked
    /// since the hand started still runs the code the hand is running, so an
    /// upgrade mid-session cannot silently change what the launcher does; and
    /// there is no window between resolving a name and executing it in which
    /// something else could take that name.
    SelfExe,
    /// A named program, for tests that cannot re-enter this binary's `main`.
    Explicit {
        /// The program to run.
        prog: PathBuf,
        /// Its arguments, in place of [`LAUNCH_ARG`].
        args: Vec<String>,
        /// The launcher's own environment, which the `exec` then replaces.
        env:  Vec<(String, String)>,
    },
}

impl Launcher {

    /// The program to spawn, resolved.
    pub fn prog(&self) -> Outcome<PathBuf> {
        match self {
            // Read once to find out whether it is there at all, so that a
            // machine with no /proc says so in a sentence rather than through
            // a failed spawn; the path handed back is the literal one.
            Self::SelfExe => match std::fs::read_link("/proc/self/exe") {
                Ok(_) => Ok(PathBuf::from("/proc/self/exe")),
                Err(e) => Err(err!(e,
                    "The hand cannot find its own binary through /proc/self/exe, \
                    so it cannot start the launcher that applies the fence. No \
                    command was run.";
                    IO, Path, Security)),
            },
            Self::Explicit { prog, .. } => Ok(prog.clone()),
        }
    }

    /// The arguments the launcher is started with.
    pub fn args(&self) -> Vec<String> {
        match self {
            Self::SelfExe				=> vec![fmt!("{}", LAUNCH_ARG)],
            Self::Explicit { args, .. }	=> args.clone(),
        }
    }

    /// The launcher's own environment, which `exec` replaces with the command's.
    pub fn env(&self) -> Vec<(String, String)> {
        match self {
            Self::SelfExe				=> Vec::new(),
            Self::Explicit { env, .. }	=> env.clone(),
        }
    }
}

// ┌───────────────────────────────────────────────────────────────┐
// │ The registry                                                   │
// └───────────────────────────────────────────────────────────────┘

/// One live run, as the registry holds it.
struct Live {
    pid:   u32,						// the child's process id, which is also its process group
    sigtx: UnboundedSender<Sig>,	// to the supervisor, which owns the child and does the killing
    what:  String,					// the command line, for the listing
    since: std::time::Instant,		// when it started
}

// ── A run that ended and left its process group standing ────────────────────
//
// A command may start something that outlives it.  `bash dev/world.sh 3 --up`
// starts a dev server and a mock provider in the background and returns; the
// direct child is reaped and the two servers go on holding their ports, in the
// process group the launcher made for the run.
//
// Until this existed the hand forgot them at that moment, and nothing else could
// reach them.  The fence scopes signals to the Landlock domain that sent them, so
// a LATER command's `kill` answers "Operation not permitted"; `/proc` is outside
// every fence, so the pid cannot be found either.  A daimon that brought up a
// world could not take it down, and a person had to clear the ports from outside
// the app.  That is a leak the app creates and then forbids fixing, which is
// worse than either half.
//
// So a run whose group is not empty is kept, and kept whole: the group, so it can
// be signalled; the command line, so a listing means something; and the SCRATCH
// DIRECTORY, because `TMPDIR` still points into it and the survivors are still
// writing there.  Removing it at the moment the direct child exited was pulling
// the ground out from under a process the hand knew about.
//
// Keyed by the run's identifier, which is what [`Runner::signal`] already takes.
// A pid would be a second way in and the wrong one -- a caller that could name a
// number could name any number, and the whole guarantee here is that only a group
// this hand's own launcher created can be named at all.

/// A run whose command has ended and whose process group has not emptied.
struct Left {
    pgid:    u32,				// the ended child's pid, which named the group
    what:    String,			// the command line, for the listing
    since:   std::time::Instant,	// when the command itself ended
    scratch: Option<Scratch>,	// held until the group goes: TMPDIR still points into it
}

/// Starts commands, streams what they say, and keeps them reachable.
///
/// Cheap to clone: every clone shares one registry of live runs.  Nothing here
/// blocks -- [`Runner::spawn`] returns as soon as the child exists, and the
/// waiting, reading and killing all happen in tasks.
#[derive(Clone)]
pub struct Runner {
    live:     Arc<Mutex<HashMap<String, Live>>>,	// runs whose command is still going
    left:     Arc<Mutex<HashMap<String, Left>>>,	// runs that ended and left a group standing
    launcher: Arc<Launcher>,						// what is re-executed to apply the fence
}

impl Default for Runner {
    fn default() -> Self {
        Self::new()
    }
}

impl Runner {

    /// Creates an empty runner that fences through this binary.
    pub fn new() -> Self {
        Self::with_launcher(Launcher::SelfExe)
    }

    /// Creates an empty runner with a stated launcher.
    ///
    /// # Arguments
    /// * `launcher` - What to re-execute in order to apply the fence.
    pub fn with_launcher(launcher: Launcher) -> Self {
        Self {
            live:     Arc::new(Mutex::new(HashMap::new())),
            left:     Arc::new(Mutex::new(HashMap::new())),
            launcher: Arc::new(launcher),
        }
    }

    /// Starts a command and returns as soon as it exists.
    ///
    /// [`wire::Resp::Started`] is sent before this returns; every
    /// [`wire::Resp::Chunk`] and the closing [`wire::Resp::Ended`] follow on
    /// `tx` from a task, in that order.  A refusal goes out as
    /// [`wire::Resp::Refused`] and comes back as [`Launch::Refused`]; an `Err`
    /// means the machine would not start the process at all, which is a
    /// different thing and the caller should say so differently.
    ///
    /// # Arguments
    /// * `req` - A [`wire::Req::Exec`]; any other variant is a caller bug.
    /// * `tx` - Where every response about this run is sent.
    ///
    /// # Returns
    /// [`Launch::Started`] with the child's process id, or [`Launch::Refused`].
    pub async fn spawn(&self, req: Req, tx: Sender<Resp>) -> Outcome<Launch> {
        let (id, argv, cwd, mut env, stdin, timeout_ms, capture, mut fence) = match req {
            // `toolkits` is spent before the request gets here: `Desk::exec` clamps the fence
            // against it, and what survives that is a fence of absolute paths the runner needs no
            // grant to interpret. Named rather than swept up by `..`, so a field added later has
            // to be looked at here too.
            Req::Exec { id, argv, cwd, env, stdin, timeout_ms, capture, fence, toolkits: _ } =>
                (id, argv, cwd, env, stdin, timeout_ms, capture, fence),
            other => return Err(err!(
                "Runner::spawn was given {:?}, which is not an Exec request.", other;
                Bug, Invalid, Input)),
        };

        // Nothing to run. // Checked before the fence, because it is cheaper and
        // the sentence is more useful.
        if argv.is_empty() {
            return self.refuse(&id, &tx, fmt!(
                "Refused: a command was asked for with no program to run. The first element of \
                argv is the program and the rest are its arguments -- there is no shell here to \
                take a string apart for you.")).await;
        }

        // A caller-chosen identifier that is already in use would leave one
        // registry slot for two children: the survivor becomes unkillable and
        // invisible to `Bye`, and the first to finish removes the other's entry,
        // after which `signal` answers `Finished` for a process that is still
        // running. There is no repair for that after the fact, so it is refused
        // before there is a second child. The answer is taken out of the lock
        // before it is used, so that no guard is held across the `await` that
        // sends the refusal.
        //
        // A LEFTOVER counts too, and for the same reason. A run that ended and
        // left its process group standing is still reachable by that identifier
        // and by no other means at all, so letting a second run take the name
        // would put the first beyond the only door there is.
        let already = {
            let g = lock_mutex!(self.live);
            g.contains_key(&id)
        };
        if already {
            return self.refuse(&id, &tx, fmt!(
                "Refused: '{}' is already the identifier of a command that is still running. \
                Identifiers are how a run is signalled and how its output is recognised, so two \
                runs cannot share one. Give this command a different id, or signal the one \
                already running.", id)).await;
        }
        let standing = {
            let g = lock_mutex!(self.left);
            g.contains_key(&id)
        };
        if standing {
            return self.refuse(&id, &tx, fmt!(
                "Refused: '{}' named a command that has finished and left processes of its own \
                still running -- a server it started, most likely. That identifier is the only \
                way anything can reach them, so it cannot be given to a second command. Ask what \
                is running, stop that one, or give this command a different id.", id)).await;
        }

        if let Some(s) = screen_env(&env) {
            return self.refuse(&id, &tx, s).await;
        }

        if let Some(s) = screen_scratch(&env) {
            return self.refuse(&id, &tx, s).await;
        }

        // A push that could destroy work at the far end, refused HERE as well as in the page --
        // because a repository holding credentials of its own needs nothing from Daimond to make
        // one, and that is the case the page cannot see. See the section comment on
        // [`screen_git_push`] for which of the page's rules this repeats and which it does not.
        // Before the scratch directory is made, so a refusal costs no filesystem work.
        if let Some(s) = screen_git_push(&argv) {
            return self.refuse(&id, &tx, s).await;
        }

        // Against the fence the caller sent, before the hand widens it. The
        // scratch is a root the caller did not ask for, and a spec that grants
        // nothing must still read as granting nothing.
        let dir = match vet_cwd(&cwd, &fence) {
            Vetted::Ok(p)       => p,
            Vetted::Refused(s)  => return self.refuse(&id, &tx, s).await,
        };

        // Somewhere to write. Made before the plan rather than after, because
        // the fence is applied by the launcher from a plan it cannot add to: a
        // directory granted after the plan was made is a directory the command
        // cannot open. A failure here is a refusal, not a warning -- a command
        // run without one fails forty seconds into a compile with a permission
        // error about a path nobody asked for.
        let scratch = match Scratch::make(&id) {
            Ok(s)  => s,
            Err(e) => return self.refuse(&id, &tx, fmt!(
                "Refused: this command could not be given a private directory to write temporary \
                files in, and the hand will not run one without. {} ", e.msgs().join(" "))).await,
        };
        fence.rw.push(fmt!("{}", scratch.dir().display()));
        // Appended after the caller's pairs, so that the hand's answer is the
        // last word even if one of these names ever reached this far.
        for k in TMP_VARS {
            env.push((fmt!("{}", k), fmt!("{}", scratch.dir().display())));
        }
        // And the two the hand fills in only where the request said nothing. The
        // opposite rule to the three above, and the section on [`add_defaults`]
        // says why each of the two is there and why the rest are not.
        add_defaults(&mut env);

        // The fence is decided here, in the hand, where a failure can still
        // become a sentence the page shows. The launcher only applies it: by the
        // time the plan is in the launcher's hands the only remaining move is to
        // die, so a spec that cannot be honoured must fail on this side of the
        // line. Release gate 1 is this call -- an unfenceable command is refused,
        // never run and mentioned.
        let plan = match detected_fence().plan(&fence, &Unfenced::Refuse) {
            Ok(p)  => p,
            Err(e) => return self.refuse(&id, &tx, fmt!(
                "Refused: {}", e.msgs().join(" "))).await,
        };

        // The other half of the compartment, and gate 1 applies to it identically.
        //
        // Landlock governs opening a file. It has no access right covering `chmod`,
        // `chown`, `utimensat` or `setxattr`, and it does not govern `connect()` to a
        // pathname unix socket below ABI 9 -- so on this kernel a fenced command could
        // world-write a file inside the denied subtree, and could reach the session bus
        // and start a process outside the fence entirely. Both were measured; neither is
        // something `fence.rs` can express.
        //
        // Asked here rather than only in the launcher because a machine that cannot
        // filter must produce a *sentence the page shows*, not an exit code and a line of
        // stderr. The launcher asks again and dies if the answer changed, because being
        // wrong there is unrecoverable.
        if let Err(e) = detected_seccomp().plan(&SysSpec::for_command()) {
            return self.refuse(&id, &tx, fmt!(
                "Refused: {}", e.msgs().join(" "))).await;
        }

        // `argv[0]` is the one caller value that decides which *code* runs, and
        // it was never checked. An absolute path outside the fence ran; so did
        // `../outside/evil`; and so did a bare name resolved through a `PATH`
        // the caller wrote, because `env_clear` then `execvp` resolves against
        // the child's environment. The program is therefore resolved here, once,
        // to an absolute path, checked against the fence, and handed to the
        // launcher already resolved so that nothing resolves it a second time.
        let prog = match vet_program(&argv[0], &dir, &env, &plan) {
            Vetted0::Ok(p)      => p,
            Vetted0::Refused(s) => return self.refuse(&id, &tx, s).await,
        };

        let mut cmd = Command::new(res!(self.launcher.prog()));
        cmd.args(self.launcher.args());
        cmd.current_dir(&dir);

        // The launcher's own environment, which is empty for the real launcher
        // and which `exec` replaces with the command's in any case. The
        // command's environment travels down the pipe, not through here.
        cmd.env_clear();
        for (k, v) in self.launcher.env() {
            cmd.env(k, v);
        }

        // Standard input is the launcher's channel: the plan first, then the
        // command's own input behind it. Where the caller sent no input the
        // write end is closed after the plan, so the command reads end-of-file
        // immediately -- which is what `Stdio::null()` used to provide, without
        // needing `/dev/null` to be inside the fence.
        cmd.stdin(Stdio::piped());
        match capture {
            Capture::Both => { cmd.stdout(Stdio::piped()); cmd.stderr(Stdio::piped()); },
            Capture::Out  => { cmd.stdout(Stdio::piped()); cmd.stderr(Stdio::null());  },
            Capture::Err  => { cmd.stdout(Stdio::null());  cmd.stderr(Stdio::piped()); },
            Capture::None => { cmd.stdout(Stdio::null());  cmd.stderr(Stdio::null());  },
        }

        cmd.kill_on_drop(true);

        // Its own process group, so the kill reaches the compilers and test
        // binaries the command spawned rather than orphaning them.  `setpgid`
        // is done by the child between fork and exec, and `0` means "become
        // your own leader", so the group id is the child's own process id.
        #[cfg(unix)]
        cmd.process_group(0);

        // The whole of what the launcher will do, encoded before there is a
        // launcher to send it to, so that an encoding failure is a refusal
        // rather than a process waiting on a pipe that will never fill.
        let payload = res!(encode_payload(&Payload {
            prog: prog.clone(),
            argv: argv.clone(),
            env:  env.clone(),
            plan: plan.clone(),
            tty:  false,
            act:  Act::Exec,
        }));

        let mut child = res!(cmd.spawn()
            .map_err(|e| err!(e,
                "The hand could not start the launcher that fences '{}' in '{}'.",
                prog.display(), dir.display();
                IO, Init)));

        let pid = match child.id() {
            Some(p) => p,
            None    => return Err(err!(
                "The child exited before the hand could learn its process id."; IO, Unexpected)),
        };

        // Written from a task: the plan can exceed a pipe buffer, and a caller
        // sending more input than a pipe holds would otherwise deadlock against
        // its own output.
        if let Some(mut w) = child.stdin.take() {
            tokio::spawn(async move {
                if w.write_all(&payload).await.is_err() {
                    return; // The launcher died; `Ended` will carry its code.
                }
                if let Some(text) = stdin {
                    let _ = w.write_all(text.as_bytes()).await;
                }
                let _ = w.shutdown().await; // Closes the pipe.
            });
        }

        let what = cut_to(&argv.join(" "), RUN_WHAT_MAX);
        let (sigtx, sigrx) = tokio::sync::mpsc::unbounded_channel::<Sig>();
        {
            let mut g = lock_mutex!(self.live);
            g.insert(id.clone(), Live {
                pid,
                sigtx: sigtx.clone(),
                what:  what.clone(),
                since: std::time::Instant::now(),
            });
        }

        if tx.send(Resp::Started { id: id.clone(), pid }).await.is_err() {
            // The registry entry was made before the announcement and must not
            // outlive it. Left behind, it is permanent: no signal reaches it,
            // because there is no supervisor to receive one, and `live_count`
            // over-reports for the life of the hand. The child dies with `cmd`,
            // which was built with `kill_on_drop`.
            {
                let mut g = lock_mutex!(self.live);
                g.remove(&id);
            }
            return Err(err!(
                "The page stopped listening before '{}' could be announced.", id;
                Channel, IO));
        }

        let job = Job {
            id:      id.clone(),
            pgid:    pid,
            what,
            dur:     Duration::from_millis(clamp_timeout(timeout_ms)),
            live:    Arc::clone(&self.live),
            left:    Arc::clone(&self.left),
            tx:      tx.clone(),
            scratch: Some(scratch),
        };
        tokio::spawn(async move {
            let jid = job.id.clone();
            let jtx = job.tx.clone();
            if let Err(e) = supervise(job, child, sigrx, sigtx).await {
                let _ = jtx.send(Resp::Error {
                    id:      Some(jid),
                    message: fmt!("{}", e),
                }).await;
            }
        });

        Ok(Launch::Started(pid))
    }

    /// Sends a signal to a run this hand started, live or standing.
    ///
    /// Two paths, and the second is the one that was missing.  A live run is
    /// signalled through its supervisor, which owns the child.  A run that has
    /// ENDED and left its process group standing has no supervisor, so the group
    /// is signalled directly -- and it can be, because the hand is not the fenced
    /// thing.  Nothing else on the machine can: Landlock scopes signals to the
    /// domain that sent them, so a later command's `kill` answers "Operation not
    /// permitted", which is what left two servers holding ports with no route to
    /// them.
    ///
    /// **Only by identifier, and only one this hand issued.**  There is no arm
    /// here that takes a pid, a name or a pattern.  The guard is not a check on
    /// the argument; it is that the argument cannot express anything else.
    ///
    /// Signalling a run that has already gone is not an error and answers
    /// [`Signalled::Finished`].  A signal that was attempted and did not take
    /// answers [`Signalled::Failed`] and never `Finished`.
    ///
    /// # Arguments
    /// * `id` - The identifier given at [`wire::Req::Exec`].
    /// * `sig` - Which signal.
    pub async fn signal(&self, id: &str, sig: Sig) -> Outcome<Signalled> {
        let line = {
            let g = lock_mutex!(self.live);
            g.get(id).map(|l| l.sigtx.clone())
        };
        if let Some(t) = line {
            if t.send(sig).is_ok() {
                return Ok(Signalled::Sent);
            }
            // The supervisor has gone, which means the run ended between the
            // lookup and the send. Fall through: it may be standing.
        }
        let pgid = {
            let g = lock_mutex!(self.left);
            g.get(id).map(|l| l.pgid)
        };
        let pgid = match pgid {
            Some(p) => p,
            None    => return Ok(Signalled::Finished),
        };
        let said = match timeout(
            Duration::from_millis(SIGNAL_GRACE_MS),
            signal_group(pgid, sig)).await
        {
            Ok(Signalling::Sent)			=> None,
            Ok(Signalling::Degraded(w))		=> Some(w),
            Ok(Signalling::Unavailable(w))	=> Some(w),
            Err(_)							=> Some(fmt!(
                "The kill helper did not finish within {} ms and was given up on.",
                SIGNAL_GRACE_MS)),
        };
        // Then ask the machine, rather than believe the bookkeeping. A group is
        // not emptied the instant the signal is delivered -- the leader has to be
        // reaped -- so the probe waits first, and the wait is short because the
        // only thing between a KILL and an empty group is a scheduler tick.
        tokio::time::sleep(Duration::from_millis(STOP_SETTLE_MS)).await;
        let still = group_standing(pgid).await;
        res!(self.reap().await);
        Ok(signalled(&id, pgid, said, still))
    }

    /// Forgets every standing group that has emptied, and clears its scratch.
    ///
    /// A listing that still holds a group nobody is in is a listing that lies,
    /// and it lies in the direction that matters: a reader would go on trying to
    /// stop something already gone rather than looking for what is not.  A group
    /// the machine will not answer about is KEPT, because "I cannot tell" is not
    /// "it is gone".
    pub async fn reap(&self) -> Outcome<usize> {
        let asking = {
            let g = lock_mutex!(self.left);
            g.iter().map(|(k, l)| (k.clone(), l.pgid)).collect::<Vec<_>>()
        };
        let mut gone = Vec::new();
        for (id, pgid) in asking {
            if group_standing(pgid).await == Some(false) {
                gone.push(id);
            }
        }
        let mut taken = Vec::new();
        {
            let mut g = lock_mutex!(self.left);
            for id in &gone {
                if let Some(mut l) = g.remove(id) {
                    if let Some(sc) = l.scratch.take() {
                        taken.push(sc);
                    }
                }
            }
        }
        // Removed outside the lock: a scrub of a tree the command built is not
        // work to do while every other run is waiting to look at the registry.
        for mut sc in taken {
            let _ = sc.remove();
        }
        Ok(gone.len())
    }

    /// What this hand is still running, standing groups included.
    ///
    /// Measured rather than remembered: [`Runner::reap`] runs first, so a group
    /// that has emptied since anyone last looked is gone from the answer rather
    /// than reported and then found missing.
    ///
    /// Standing runs come first, oldest first, because they are the ones nothing
    /// else can reach and therefore the ones a reader is looking for.
    pub async fn runs(&self) -> Outcome<(Vec<Run>, u32)> {
        res!(self.reap().await);
        let now = std::time::Instant::now();
        let mut out = Vec::new();
        {
            let g = lock_mutex!(self.left);
            for (id, l) in g.iter() {
                out.push(Run {
                    id:    id.clone(),
                    pid:   l.pgid,
                    what:  l.what.clone(),
                    state: RunState::Standing,
                    secs:  now.saturating_duration_since(l.since).as_secs().min(u32::MAX as u64)
                               as u32,
                });
            }
        }
        out.sort_by(|a, b| b.secs.cmp(&a.secs).then(a.id.cmp(&b.id)));
        let mut live = Vec::new();
        {
            let g = lock_mutex!(self.live);
            for (id, l) in g.iter() {
                live.push(Run {
                    id:    id.clone(),
                    pid:   l.pid,
                    what:  l.what.clone(),
                    state: RunState::Running,
                    secs:  now.saturating_duration_since(l.since).as_secs().min(u32::MAX as u64)
                               as u32,
                });
            }
        }
        live.sort_by(|a, b| b.secs.cmp(&a.secs).then(a.id.cmp(&b.id)));
        out.extend(live);
        let more = out.len().saturating_sub(RUNS_MAX) as u32;
        out.truncate(RUNS_MAX);
        Ok((out, more))
    }

    /// Stops everything this hand started, for [`wire::Req::Bye`].
    ///
    /// **Standing groups included, and that is a decision rather than tidiness.**
    /// A dev server a run left behind is reachable through this hand and through
    /// nothing else; if the hand exits without stopping it, it holds its port
    /// until somebody finds it from outside the app, which is the incident this
    /// whole arrangement is a repair for. A server outliving the page that asked
    /// for it is a thing nobody asked for either.
    ///
    /// # Returns
    /// How many runs were signalled, live and standing together.
    pub async fn stop_all(&self) -> Outcome<usize> {
        let lines = {
            let g = lock_mutex!(self.live);
            g.values().map(|l| l.sigtx.clone()).collect::<Vec<_>>()
        };
        let mut n = 0;
        for t in lines {
            if t.send(Sig::Kill).is_ok() {
                n += 1;
            }
        }
        let standing = {
            let g = lock_mutex!(self.left);
            g.values().map(|l| l.pgid).collect::<Vec<_>>()
        };
        for pgid in standing {
            // Awaited, unlike the line above: there is no supervisor here to do
            // the killing after this function returns, and the process this one
            // is in is about to exit.
            if let Ok(Signalling::Sent) = timeout(
                Duration::from_millis(SIGNAL_GRACE_MS),
                signal_group(pgid, Sig::Kill)).await
            {
                n += 1;
            }
        }
        res!(self.reap().await);
        Ok(n)
    }

    /// The process id of a live run, or `None` if it has ended.
    ///
    /// # Arguments
    /// * `id` - The identifier given at [`wire::Req::Exec`].
    pub fn pid_of(&self, id: &str) -> Outcome<Option<u32>> {
        let g = lock_mutex!(self.live);
        Ok(g.get(id).map(|l| l.pid))
    }

    /// How many runs are live.
    pub fn live_count(&self) -> Outcome<usize> {
        let g = lock_mutex!(self.live);
        Ok(g.len())
    }

    /// How many ended runs are still holding a process group.
    ///
    /// Remembered rather than measured, unlike [`Runner::runs`]: a caller that
    /// wants the honest picture asks for the listing, and this is the cheap
    /// question a test or a shutdown path asks.
    pub fn standing_count(&self) -> Outcome<usize> {
        let g = lock_mutex!(self.left);
        Ok(g.len())
    }

    /// Sends a refusal and reports it, so the caller does not repeat itself.
    ///
    /// # Arguments
    /// * `id` - The run the refusal concerns.
    /// * `tx` - Where the refusal is sent.
    /// * `reason` - The whole sentence.
    async fn refuse(&self, id: &str, tx: &Sender<Resp>, reason: String) -> Outcome<Launch> {
        if tx.send(Resp::Refused { id: fmt!("{}", id), reason }).await.is_err() {
            return Err(err!(
                "The page stopped listening before the refusal for '{}' could be sent.", id;
                Channel, IO));
        }
        Ok(Launch::Refused)
    }
}

// ┌───────────────────────────────────────────────────────────────┐
// │ The file door                                                  │
// └───────────────────────────────────────────────────────────────┘

/// How long one file operation is given.
///
/// A file op is not a build.  It opens a file, reads or writes it and exits, so a minute is
/// already generous -- and a launcher that has not answered in a minute is one that will not,
/// which is a better thing to say than to wait for.
const FILE_TIMEOUT_MS: u64 = 60_000;

/// Carries out one [`Req::File`], behind the fence a command would run behind.
///
/// **The whole of what this type adds over [`Runner`] is that nothing is exec'd.**  The
/// gates are the same gates in the same order -- the working directory is vetted against the
/// fence the caller sent, the plan is made here where a failure can still become a sentence,
/// release gate 1 refuses an unfenceable request rather than running it and mentioning it,
/// and the system-call filter is proved buildable before a child exists.  Then the same
/// launcher is started with the same plan, and it applies the same ruleset before it opens
/// anything.
///
/// It holds no registry.  A file op cannot be signalled, cannot leave a process group
/// standing and cannot outlive its own answer, so there is nothing for a caller to reach
/// afterwards and nothing to record for them to reach it by.
#[derive(Clone)]
pub struct Files {
    launcher: Arc<Launcher>,
}

impl Default for Files {
    fn default() -> Self {
        Self::new()
    }
}

impl Files {

    /// A door that fences through this binary.
    pub fn new() -> Self {
        Self::with_launcher(Launcher::SelfExe)
    }

    /// A door with a stated launcher, which is how a test reaches the real [`launch_main`].
    pub fn with_launcher(launcher: Launcher) -> Self {
        Self { launcher: Arc::new(launcher) }
    }

    /// Does the operation and answers, or says why it did not.
    ///
    /// # Arguments
    /// * `req` - The [`Req::File`].
    /// * `tx` - Where the answer goes.
    pub async fn apply(&self, req: Req, tx: Sender<Resp>) -> Outcome<()> {
        let (id, op, cwd, fence) = match req {
            // Named rather than swept up by `..`, so a field added later has to be looked at
            // here too. `toolkits` is spent before the request gets here, exactly as it is for
            // an `Exec`: `Desk::exec` clamps the fence against it.
            Req::File { id, op, cwd, fence, toolkits: _ } => (id, op, cwd, fence),
            other => return Err(err!(
                "Files::apply was given {:?}, which is not a File request.", other;
                Bug, Invalid, Input)),
        };

        let dir = match vet_cwd(&cwd, &fence) {
            Vetted::Ok(p)      => p,
            Vetted::Refused(s) => return self.refuse(&id, &tx, s).await,
        };

        // Release gate 1, word for word as `Runner::spawn` meets it: the fence is decided in
        // the hand, where a failure can still be a sentence the page shows, and an
        // unfenceable request is refused rather than run and mentioned afterwards.
        let plan = match detected_fence().plan(&fence, &Unfenced::Refuse) {
            Ok(p)  => p,
            Err(e) => return self.refuse(&id, &tx, fmt!(
                "Refused: {}", e.msgs().join(" "))).await,
        };

        // The other half of the compartment. Landlock does not govern `chmod`, `chown`,
        // `utimensat` or `setxattr`, so a fence without the filter is not a compartment on
        // this kernel -- and a file op is precisely a thing that would use them.
        if let Err(e) = detected_seccomp().plan(&SysSpec::for_command()) {
            return self.refuse(&id, &tx, fmt!("Refused: {}", e.msgs().join(" "))).await;
        }

        let payload = res!(encode_payload(&Payload {
            prog: PathBuf::new(),
            argv: Vec::new(),
            env:  Vec::new(),
            plan: plan.clone(),
            tty:  false,
            act:  Act::File(op.clone()),
        }));

        let mut cmd = Command::new(res!(self.launcher.prog()));
        cmd.args(self.launcher.args());
        cmd.current_dir(&dir);
        cmd.env_clear();
        for (k, v) in self.launcher.env() {
            cmd.env(k, v);
        }
        cmd.stdin(Stdio::piped());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
        cmd.kill_on_drop(true);
        #[cfg(unix)]
        cmd.process_group(0);

        let mut child = res!(cmd.spawn().map_err(|e| err!(e,
            "The hand could not start the launcher that fences a file operation in '{}'.",
            dir.display(); IO, Init)));

        // Written from a task for the reason `Runner::spawn` gives: a plan can exceed a pipe
        // buffer, and a writer that blocks against its own unread output deadlocks.
        if let Some(mut w) = child.stdin.take() {
            tokio::spawn(async move {
                let _ = w.write_all(&payload).await;
                let _ = w.shutdown().await;
            });
        }

        let waited = tokio::time::timeout(
            Duration::from_millis(FILE_TIMEOUT_MS),
            child.wait_with_output()).await;
        let out = match waited {
            Ok(Ok(o))  => o,
            Ok(Err(e)) => return self.refuse(&id, &tx, fmt!(
                "Refused: the fenced child that was to {} '{}' could not be waited on ({}). \
                Do not assume nothing changed.", op.word(), op.path(), e)).await,
            Err(_)     => return self.refuse(&id, &tx, fmt!(
                "Refused: the fenced child that was to {} '{}' did not answer within {} \
                seconds and was stopped. Do not assume nothing changed.",
                op.word(), op.path(), FILE_TIMEOUT_MS / 1000)).await,
        };

        // A non-zero exit is the launcher's own, and every one of its codes means the fence
        // was NOT in force and therefore that nothing was done. Its sentence is on standard
        // error and is written for a reader; it is passed through rather than summarised.
        if !out.status.success() {
            let why = String::from_utf8_lossy(&out.stderr).trim().to_string();
            return self.refuse(&id, &tx, fmt!(
                "Refused: the fence could not be put on the process that was to {} '{}', so \
                nothing was done. {}", op.word(), op.path(), why)).await;
        }

        let (ok, text) = match out.stdout.split_first() {
            Some((b, rest)) => (*b != 0, String::from_utf8_lossy(rest).to_string()),
            None            => return self.refuse(&id, &tx, fmt!(
                "Refused: the fenced child that was to {} '{}' exited without saying what it \
                did. Do not assume nothing changed.", op.word(), op.path())).await,
        };

        if tx.send(Resp::Filed { id: id.clone(), ok, text }).await.is_err() {
            return Err(err!(
                "The page stopped listening before the answer for '{}' could be sent.", id;
                Channel, IO));
        }
        Ok(())
    }

    /// Sends a refusal and says so.
    async fn refuse(&self, id: &str, tx: &Sender<Resp>, reason: String) -> Outcome<()> {
        if tx.send(Resp::Refused { id: fmt!("{}", id), reason }).await.is_err() {
            return Err(err!(
                "The page stopped listening before the refusal for '{}' could be sent.", id;
                Channel, IO));
        }
        Ok(())
    }
}

// ┌───────────────────────────────────────────────────────────────┐
// │ Supervision                                                    │
// └───────────────────────────────────────────────────────────────┘

/// Everything the supervisor needs that is not the child itself.
struct Job {
    id:      String,	// the caller's identifier
    pgid:    u32,		// the child's process group, which is its process id
    what:    String,	// the command line, kept for a listing if the group outlives the command
    dur:     Duration,	// the hard wall-clock limit
    live:    Arc<Mutex<HashMap<String, Live>>>,	// so the run can forget itself when it ends
    left:    Arc<Mutex<HashMap<String, Left>>>,	// and remember itself where its group has not
    tx:      Sender<Resp>,
    /// The command's private temporary directory.
    ///
    /// Held here so that it is removed by the one piece of code that sees every
    /// way a run can end, and taken out of the option there so that `Drop` --
    /// which covers the ways a run can end before this struct exists -- has
    /// nothing left to do.
    scratch: Option<Scratch>,
}

/// Watches one child to its end and sends the closing [`wire::Resp::Ended`].
///
/// # Arguments
/// * `job` - The run's identity, limit and outputs.
/// * `child` - The spawned child, whose pipes are taken here.
/// * `sigrx` - Signals arriving from [`Runner::signal`].
/// * `sigtx` - A live sender kept so the receiver never reports closure.
async fn supervise(
    mut job:   Job,
    mut child: Child,
    mut sigrx: UnboundedReceiver<Sig>,
    sigtx:     UnboundedSender<Sig>,
)
    -> Outcome<()>
{
    let _keepalive = sigtx; // Holding this keeps `sigrx.recv()` from ending.

    let out_n = Arc::new(AtomicU64::new(0));
    let err_n = Arc::new(AtomicU64::new(0));
    // One budget across both streams, and one marker for the pair: a command
    // that floods stderr must not be allowed a second helping on stdout, and the
    // page should be told once rather than twice.
    let budget = Budget {
        spent: Arc::new(AtomicU64::new(0)),
        noted: Arc::new(AtomicBool::new(false)),
    };
    let mut pumps: Vec<JoinHandle<()>> = Vec::new();

    if let Some(r) = child.stdout.take() {
        pumps.push(tokio::spawn(pump(
            r, job.id.clone(), Stream::Out, job.tx.clone(), Arc::clone(&out_n),
            budget.clone())));
    }
    if let Some(r) = child.stderr.take() {
        pumps.push(tokio::spawn(pump(
            r, job.id.clone(), Stream::Err, job.tx.clone(), Arc::clone(&err_n),
            budget.clone())));
    }

    let mut timed_out = false;
    let mut killed    = false;

    let deadline = tokio::time::sleep(job.dur);
    tokio::pin!(deadline);

    // What the group signal did, kept rather than discarded. Both call sites
    // used to throw it away with `let _ =`, so on a system whose `kill` rejects
    // the form used here -- BusyBox does, and Alpine is a realistic Cloud-tier
    // host -- only the direct child was signalled while the page was told
    // `Ended{killed:true}`. The grandchildren the group kill exists for survived
    // and nothing said so.
    let mut degraded: Option<String> = None;
    let status = loop {
        tokio::select! {
            r = child.wait() => break r,
            _ = &mut deadline, if !timed_out => {
                timed_out = true;
                note_signalling(
                    &mut degraded,
                    timeout(
                        Duration::from_millis(SIGNAL_GRACE_MS),
                        signal_group(job.pgid, Sig::Kill)).await);
                let _ = child.start_kill();
            },
            m = sigrx.recv() => {
                if let Some(s) = m {
                    killed = true;
                    note_signalling(
                        &mut degraded,
                        timeout(
                            Duration::from_millis(SIGNAL_GRACE_MS),
                            signal_group(job.pgid, s)).await);
                    // Where the group signal did not take, the direct child is
                    // killed whatever was asked for: a `Term` that reached
                    // nothing leaves a run the page believes it has stopped.
                    if s == Sig::Kill || degraded.is_some() {
                        let _ = child.start_kill();
                    }
                }
            },
        }
    };

    if let Some(why) = &degraded {
        let _ = job.tx.send(Resp::Error {
            id:      Some(job.id.clone()),
            message: fmt!(
                "The signal reached the command itself but not the process group \
                it leads, so anything it had started may still be running. {}",
                why),
        }).await;
    }

    // Let the readers finish, but not for ever: a surviving grandchild holding
    // the write end open must not keep the page waiting.
    for mut h in pumps {
        if timeout(Duration::from_millis(DRAIN_GRACE_MS), &mut h).await.is_err() {
            h.abort();
        }
    }

    // Forget the run before announcing its end, so a signal that arrives after
    // the announcement is answered `Finished` rather than sent nowhere.
    {
        let mut g = lock_mutex!(job.live);
        g.remove(&job.id);
    }

    // Did the command leave anything of its own behind? The direct child is
    // reaped; its process GROUP may not be empty, and `bash x.sh --up` starting
    // a server in the background is the ordinary way that happens. Asked before
    // the scratch is removed, because the answer decides whether removing it
    // would pull the ground out from under a process that is still writing
    // there.
    //
    // ASKED EVEN WHERE THE GROUP WAS SIGNALLED, and the first draft skipped that
    // case as empty by construction. It is not: `killed` is set by any of the
    // three signals, and a `Term` the group declined to obey leaves exactly the
    // thing this record exists for -- unrecorded, because the skip looked safe.
    // What makes asking here safe is that a zombie does not count as standing;
    // see `counts_as_member`.
    let standing = group_standing(job.pgid).await;

    // And take the scratch away before announcing it too, so that a page told a
    // run has ended can never look and still find it. This is the ordinary path;
    // every other way out of this function drops the guard instead, which does
    // the same thing without being able to say that it failed.
    //
    // The exception is a group still standing, where the scratch goes into the
    // leftover record instead and is removed when the group finally is.
    if standing == Some(true) {
        let s = job.scratch.take();
        {
            let mut g = lock_mutex!(job.left);
            g.insert(job.id.clone(), Left {
                pgid:    job.pgid,
                what:    job.what.clone(),
                since:   std::time::Instant::now(),
                scratch: s,
            });
        }
        // Said before `Ended`, because the page attaches a note to a run before
        // it settles it and this has to reach the model that started the thing.
        // Naming the identifier is the whole of the message: it is the only way
        // anything can reach that group, since the fence scopes signals to the
        // domain that sent them and a later command's `kill` answers "Operation
        // not permitted".
        let _ = job.tx.send(Resp::Error {
            id:      Some(job.id.clone()),
            message: fmt!(
                "'{}' has finished and the processes it started are still running, in process \
                group {}. Nothing you can RUN will stop them -- each command is fenced into a \
                domain of its own and cannot signal another one's -- so the hand keeps them \
                reachable by this identifier. Ask it what is running, and stop '{}' when you are \
                done with them. They are stopped for you when the page goes away.",
                job.id, job.pgid, job.id),
        }).await;
    } else if let Some(mut s) = job.scratch.take() {
        if let Err(e) = s.remove() {
            let _ = job.tx.send(Resp::Error {
                id:      Some(job.id.clone()),
                message: fmt!(
                    "The command's private temporary directory could not be \
                    removed, so what it wrote there is still on this machine. \
                    {}", e.msgs().join(" ")),
            }).await;
        }
    }

    let exit = match &status {
        Ok(st) => match st.code() {
            Some(c) => c,
            None    => -1, // Ended by a signal, which has no exit code.
        },
        Err(_) => -1,
    };

    let ended = Resp::Ended {
        id:        job.id.clone(),
        exit,
        timed_out,
        killed,
        out_bytes: out_n.load(Ordering::Relaxed),
        err_bytes: err_n.load(Ordering::Relaxed),
    };
    if job.tx.send(ended).await.is_err() {
        return Err(err!(
            "The page stopped listening before '{}' could be closed off.", job.id;
            Channel, IO));
    }

    if let Err(e) = status {
        return Err(err!(e, "Waiting on '{}' failed.", job.id; IO));
    }
    Ok(())
}

/// How much output one run has been allowed to forward, shared by both streams.
#[derive(Clone)]
struct Budget {
    /// Bytes forwarded so far, across both streams.
    spent: Arc<AtomicU64>,
    /// Whether the truncation marker has already gone out.
    noted: Arc<AtomicBool>,
}

impl Budget {

    /// Whether `len` more bytes may be forwarded, taking them if so.
    ///
    /// # Arguments
    /// * `len` - The size of the chunk about to be sent.
    fn take(&self, len: usize) -> bool {
        let before = self.spent.fetch_add(len as u64, Ordering::Relaxed);
        before < OUTPUT_TOTAL_MAX
    }

    /// The marker, once, or `None` if it has already been sent.
    fn marker(&self) -> Option<String> {
        if self.noted.swap(true, Ordering::Relaxed) {
            return None;
        }
        Some(fmt!(
            "\n[The hand stopped forwarding this command's output after {} \
            bytes. The command is still running and the rest of what it says is \
            being read and discarded, so it will not block. The byte counts in \
            the closing message are the true totals.]\n",
            OUTPUT_TOTAL_MAX))
    }
}

/// Reads one stream to its end, emitting bounded, sequenced chunks.
///
/// Invalid UTF-8 is replaced rather than rejected, but a *partial* character at
/// the end of a read is held back and joined to the next one, so a chunk
/// boundary landing mid-character does not corrupt the text.
///
/// Past [`OUTPUT_TOTAL_MAX`] the stream is still *read* -- stopping would block
/// the command on a full pipe, which is a different failure and a worse one --
/// but nothing more is forwarded, and one marker says so.
///
/// # Arguments
/// * `r` - The pipe to read.
/// * `id` - The caller's identifier.
/// * `stream` - Which stream this is.
/// * `tx` - Where chunks are sent.
/// * `n` - Running count of bytes read from this stream.
/// * `budget` - How much more this run may forward, shared with the other stream.
async fn pump<R>(
    mut r:  R,
    id:     String,
    stream: Stream,
    tx:     Sender<Resp>,
    n:      Arc<AtomicU64>,
    budget: Budget,
)
where
    R: AsyncRead + Unpin + Send + 'static,
{
    let mut buf   = vec![0u8; READ_MAX];
    let mut carry = Vec::<u8>::new(); // A partial character, at most three bytes.
    let mut seq   = 0u64;

    loop {
        let got = match r.read(&mut buf).await {
            Ok(0)  => break,
            Ok(k)  => k,
            Err(_) => break,
        };
        n.fetch_add(got as u64, Ordering::Relaxed);

        let mut data = Vec::with_capacity(carry.len() + got);
        data.extend_from_slice(&carry);
        data.extend_from_slice(&buf[..got]);
        carry.clear();

        // Hold back a trailing sequence that is incomplete rather than wrong.
        let cut = match std::str::from_utf8(&data) {
            Ok(_)  => data.len(),
            Err(e) => match e.error_len() {
                None    => e.valid_up_to(),
                Some(_) => data.len(),
            },
        };
        if cut < data.len() {
            carry.extend_from_slice(&data[cut..]);
            data.truncate(cut);
        }
        if data.is_empty() {
            continue;
        }

        let text = String::from_utf8_lossy(&data).to_string();
        if !forward(&tx, &id, stream, &mut seq, &text, &budget).await {
            return;
        }
    }

    if !carry.is_empty() {
        let text = String::from_utf8_lossy(&carry).to_string();
        let _ = forward(&tx, &id, stream, &mut seq, &text, &budget).await;
    }
}

/// Sends `text` if the run's output budget still allows it, marking the point at
/// which it stopped.
///
/// # Arguments
/// * `tx` - Where chunks are sent.
/// * `id` - The caller's identifier.
/// * `stream` - Which stream this is.
/// * `seq` - The stream's sequence counter.
/// * `text` - The run of output.
/// * `budget` - How much more this run may forward.
///
/// # Returns
/// False once the page has stopped listening.  A run over budget still returns
/// true, because the stream must go on being drained.
async fn forward(
    tx:     &Sender<Resp>,
    id:     &str,
    stream: Stream,
    seq:    &mut u64,
    text:   &str,
    budget: &Budget,
)
    -> bool
{
    if budget.take(text.len()) {
        return emit(tx, id, stream, seq, text).await;
    }
    match budget.marker() {
        Some(m) => emit(tx, id, stream, seq, &m).await,
        None    => true,
    }
}

/// Sends `text` as one or more chunks, none larger than [`CHUNK_MAX`].
///
/// # Arguments
/// * `tx` - Where chunks are sent.
/// * `id` - The caller's identifier.
/// * `stream` - Which stream this is.
/// * `seq` - The stream's sequence counter, advanced once per chunk.
/// * `text` - The run of output.
///
/// # Returns
/// False once the page has stopped listening.
async fn emit(
    tx:     &Sender<Resp>,
    id:     &str,
    stream: Stream,
    seq:    &mut u64,
    text:   &str,
)
    -> bool
{
    for part in split_chunks(text) {
        let msg = Resp::Chunk {
            id:     fmt!("{}", id),
            stream,
            seq:    *seq,
            data:   fmt!("{}", part),
        };
        if tx.send(msg).await.is_err() {
            return false;
        }
        *seq += 1;
    }
    true
}

/// Splits `s` into runs of at most [`CHUNK_MAX`] bytes, never inside a character.
///
/// Replacing invalid bytes can treble their length, so text that fitted a read
/// buffer need not fit a chunk; this is where that is made true again.
///
/// # Arguments
/// * `s` - The text to split.
fn split_chunks(s: &str) -> Vec<&str> {
    if s.len() <= CHUNK_MAX {
        return vec![s];
    }
    let mut parts = Vec::new();
    let mut start = 0usize;
    while start < s.len() {
        let mut end = std::cmp::min(start + CHUNK_MAX, s.len());
        while end > start && !s.is_char_boundary(end) {
            end -= 1;
        }
        parts.push(&s[start..end]);
        start = end;
    }
    parts
}

// ┌───────────────────────────────────────────────────────────────┐
// │ Signalling a process group                                     │
// └───────────────────────────────────────────────────────────────┘

/// What became of an attempt to signal a whole process group.
///
/// A three-armed answer rather than a boolean, because the two failures need
/// different sentences: a `kill` that would not take the arguments is a
/// portability problem the operator can act on, and no `kill` at all is a
/// missing system.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Signalling {
    /// A `kill` ran and reported success.
    Sent,
    /// A `kill` ran and refused, so only the direct child was reached.
    Degraded(String),
    /// No `kill` could be run at all.
    Unavailable(String),
}

/// The programs tried, in order, when a process group has to be signalled.
///
/// Two spellings, because the binary sits in different places on different
/// systems and neither is worth failing over.
const KILL_PROGS: &[&str] = &["/bin/kill", "/usr/bin/kill"];

/// How a particular `kill` wants a process group named.
///
/// The operand is `-1234`, a negative number, and a negative number is
/// indistinguishable from an option unless something says otherwise.  The two
/// arms are the two answers systems give to that, and there is no third:
/// procps-ng needs the POSIX `--` and BusyBox has never implemented it.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Operand {
    /// `-s TERM -- -1234`, which is what POSIX says and what procps-ng requires.
    Separated,
    /// `-s TERM -1234`, for a `kill` that treats `--` as a malformed pid.
    Bare,
}

/// Asks a `kill` which spelling it takes, by signalling nothing to this process.
///
/// Signal 0 is the null signal: it validates the arguments and delivers nothing.
/// Sent to the hand's own process it cannot fail for want of permission, so a
/// non-zero exit means the arguments -- which is exactly the question being
/// asked, and the only question this probe can answer wrongly.
///
/// # Why this is a probe and not a fallback
///
/// The obvious design is to send with `--` and retry without it, and it is worse
/// in a way that is easy to miss.  Measured here on BusyBox 1.37,
/// `kill -s KILL -- -<pgid>` prints `kill: invalid number '--'`, **exits 1, and
/// kills the group anyway**: the unreadable operand is counted as an error and
/// the loop carries on to the one after it.  A retry therefore sends a second
/// signal to a group the first has already emptied, and whether that reports
/// success turns on whether the group's leader has been reaped -- `kill` reaches
/// a zombie and fails with `ESRCH` once it is gone.  That makes the answer the
/// page is given depend on the caller's bookkeeping rather than on what happened
/// to the command, and `Degraded` is the sentence that tells a user their build
/// may still be running.
///
/// Asking first costs one extra process on the path that kills a run, sends the
/// signal exactly once, and leaves the exit status meaning what it says on both
/// systems.
///
/// # Arguments
/// * `prog` - The `kill` to ask.
///
/// # Returns
/// Which spelling to use, or `None` where the program could not be run at all.
#[cfg(unix)]
async fn operand_form(prog: &str) -> Option<Operand> {
    let mut c = Command::new(prog);
    c.arg("-s").arg("0").arg("--").arg(fmt!("{}", std::process::id()))
        .env_clear()
        .stdin(Stdio::null())
        .kill_on_drop(true);
    match c.output().await {
        Ok(out) if out.status.success()	=> Some(Operand::Separated),
        Ok(_)							=> Some(Operand::Bare),
        Err(_)							=> None,
    }
}

/// Sends `sig` to the whole of process group `pgid`.
///
/// The negative-pid form of `kill` is what reaches a *group*, and there is no
/// safe standard-library call for it: `std` can signal a direct child only, and
/// `libc::kill` would be an `unsafe` call in a crate that forbids them.  So the
/// signal goes through the system's own `kill`, invoked as argv like everything
/// else here.  Killing the group rather than the child is the point -- a
/// `cargo test` that spawned compilers must not leave them behind.
///
/// Every candidate is tried and the first *success* wins, not the first that
/// merely started: returning on the first program that spawned meant a working
/// `/usr/bin/kill` sitting behind a broken `/bin/kill` was never reached.
///
/// # Arguments
/// * `pgid` - The group, which is the process id of the child that leads it.
/// * `sig` - Which signal.
///
/// # Returns
/// What happened, in a form the caller has to look at.
pub(crate) async fn signal_group(pgid: u32, sig: Sig) -> Signalling {
    signal_group_with(KILL_PROGS, pgid, sig).await
}

/// [`signal_group`], with the candidate programs named.
///
/// Split out so a test can put a real BusyBox `kill` in front of this code path
/// rather than reason about what one would do (`REVIEW.md` §3.10).
///
/// # Arguments
/// * `progs` - The `kill` binaries to try, in order.
/// * `pgid` - The group, which is the process id of the child that leads it.
/// * `sig` - Which signal.
pub(crate) async fn signal_group_with(progs: &[&str], pgid: u32, sig: Sig) -> Signalling {
    let name = match sig {
        Sig::Term	=> "TERM",
        Sig::Kill	=> "KILL",
        Sig::Int	=> "INT",
    };
    signal_group_named(progs, pgid, name).await
}

/// [`signal_group_with`], with the signal named as `kill -s` spells it.
///
/// Split out for the null signal.  `0` is not a [`wire::Sig`] and must not
/// become one -- the wire's three are the signals a page may SEND -- but it is
/// how the hand asks whether a group still has anybody in it, which is the same
/// question in the same words to the same program.
///
/// # Arguments
/// * `progs` - The `kill` binaries to try, in order.
/// * `pgid` - The group, which is the process id of the child that led it.
/// * `name` - The signal, as `kill -s` spells it.
async fn signal_group_named(progs: &[&str], pgid: u32, name: &str) -> Signalling {
    #[cfg(unix)]
    {
        let mut said = Vec::<String>::new();
        for prog in progs {
            if !Path::new(prog).exists() {
                continue;
            }
            let form = match operand_form(prog).await {
                Some(f) => f,
                None    => {
                    said.push(fmt!("{} could not be run at all", prog));
                    continue;
                },
            };
            let mut c = Command::new(prog);
            c.arg("-s").arg(name);
            if form == Operand::Separated {
                c.arg("--");
            }
            c.arg(fmt!("-{}", pgid))
                .env_clear()
                .stdin(Stdio::null())
                .kill_on_drop(true);
            match c.output().await {
                Ok(out) if out.status.success() => return Signalling::Sent,
                Ok(out) => said.push(fmt!(
                    "{} exited {} ({})",
                    prog,
                    match out.status.code() {
                        Some(c) => fmt!("{}", c),
                        None    => fmt!("on a signal"),
                    },
                    String::from_utf8_lossy(&out.stderr).trim())),
                Err(e) => said.push(fmt!("{} could not be run ({})", prog, e)),
            }
        }
        if said.is_empty() {
            return Signalling::Unavailable(fmt!(
                "None of {} exists on this machine, so there is no way to signal \
                a process group from a program that writes no unsafe code.",
                progs.join(" or ")));
        }
        Signalling::Degraded(said.join("; "))
    }
    #[cfg(not(unix))]
    {
        let _ = (progs, pgid, name);
        Signalling::Unavailable(fmt!(
            "Signalling a process group is a POSIX idea and this is not a POSIX \
            platform."))
    }
}

/// Whether one `/proc/<pid>/stat` line describes a process still holding the
/// group `pgid` open.
///
/// Two things are easy to get wrong here and both are why this is its own
/// function with its own test.
///
/// **Where the fields are.**  The second field is the executable's name in
/// brackets, and a file name may contain brackets, spaces and anything else a
/// file name may.  So the fields are counted from after the LAST `)`, which is
/// what `pty::session_groups` already does; the three after it are state, parent
/// and group.
///
/// **A zombie is not standing.**  It holds no port, writes no file and will do
/// nothing further; it is an exit status waiting to be collected.  Counting one
/// would make every killed run look as though it had left something behind for
/// as long as the kernel took to reap it -- a false alarm about the one subject
/// this has to be believed on -- and would hold the run's scratch directory open
/// for a process that no longer exists.
///
/// # Arguments
/// * `stat` - The contents of one `/proc/<pid>/stat`.
/// * `pgid` - The group being asked about.
fn counts_as_member(stat: &str, pgid: u32) -> bool {
    let tail = match stat.rsplit_once(')') {
        Some((_, t)) => t,
        None         => return false,
    };
    let mut f = tail.split_whitespace();
    let state = match f.next() {
        Some(s) => s,
        None    => return false,
    };
    if state == "Z" {
        return false;
    }
    // Past the parent, to the group.
    match f.nth(1).and_then(|v| v.parse::<u32>().ok()) {
        Some(g) => g == pgid,
        None    => false,
    }
}

/// Whether any process is still in the group `pgid`.
///
/// `/proc` first, because the hand is not the fenced thing and may read it, and
/// because it answers without starting a process.  Where there is no `/proc`,
/// the null signal: `kill -s 0` validates its arguments, delivers nothing, and
/// succeeds only where there is somebody to deliver to.
///
/// `None` is neither yes nor no, and a caller must not read it as either.  It
/// means the machine would not answer, which is why the listing goes on showing
/// a run it cannot ask about rather than quietly forgetting one.
///
/// # Arguments
/// * `pgid` - The group, which is the process id of the child that led it.
async fn group_standing(pgid: u32) -> Option<bool> {
    if let Ok(dir) = std::fs::read_dir("/proc") {
        for entry in dir.flatten() {
            let name = entry.file_name();
            if !name.to_string_lossy().chars().all(|c| c.is_ascii_digit()) {
                continue;
            }
            let stat = match std::fs::read_to_string(entry.path().join("stat")) {
                Ok(s)  => s,
                Err(_) => continue, // It ended while we were looking at it.
            };
            if counts_as_member(&stat, pgid) {
                return Some(true);
            }
        }
        return Some(false);
    }
    match signal_group_named(KILL_PROGS, pgid, "0").await {
        Signalling::Sent			=> Some(true),
        Signalling::Degraded(_)		=> Some(false),
        Signalling::Unavailable(_)	=> None,
    }
}

/// What to tell the caller about a signal, given what `kill` said and what the
/// machine then showed.
///
/// Separate from [`Runner::signal`] so that the one judgement it makes can be
/// put under a test, because getting it wrong is the defect this whole
/// arrangement exists to repair: a signal that did not take, reported as a stop.
/// The rule has no arm that can do that.
///
/// * The group is gone -- **finished**, whatever `kill` printed.  BusyBox exits 1
///   on the POSIX spelling and empties the group anyway (`REVIEW.md` §3.10), so
///   the exit status is the weaker witness and the probe is the stronger one.
/// * The group is still standing and `kill` refused -- **failed**, and the
///   sentence names the group so a person can find it from outside.
/// * The group is still standing and `kill` was accepted -- **sent**, which says
///   the signal went and does not say the command stopped.  A `TERM` is a
///   request, and something part-way through shutting down is not a failure.
/// * The machine would not say -- **sent**, with the same reading.  "I cannot
///   tell" is not "it failed", and the run stays in the listing so the question
///   can be asked again.
///
/// # Arguments
/// * `id` - The run, for the sentence.
/// * `pgid` - Its process group, for the sentence.
/// * `said` - What went wrong with the `kill`, or `None` if nothing did.
/// * `still` - Whether the group was still standing afterwards, where the
///   machine would answer.
fn signalled(id: &str, pgid: u32, said: Option<String>, still: Option<bool>) -> Signalled {
    if still == Some(false) {
        return Signalled::Finished;
    }
    match said {
        None    => Signalled::Sent,
        Some(w) => Signalled::Failed(fmt!(
            "'{}' was signalled and the signal did not take, so anything it started is still \
            running as process group {}. Nothing inside a fence can reach it -- that is what \
            the refusal below is -- so it has to be stopped from outside the app. {}",
            id, pgid, w)),
    }
}

/// Keeps the first thing that went wrong with a group signal, if anything did.
///
/// # Arguments
/// * `slot` - Where the explanation is kept.
/// * `got` - What the attempt returned, or `Err` if it ran out of time.
fn note_signalling(
    slot: &mut Option<String>,
    got:  Result<Signalling, tokio::time::error::Elapsed>,
) {
    if slot.is_some() {
        return;
    }
    *slot = match got {
        Ok(Signalling::Sent)			=> None,
        Ok(Signalling::Degraded(why))	=> Some(why),
        Ok(Signalling::Unavailable(why))=> Some(why),
        Err(_)							=> Some(fmt!(
            "The kill helper did not finish within {} ms and was given up on.",
            SIGNAL_GRACE_MS)),
    };
}

// ┌───────────────────────────────────────────────────────────────┐
// │ Private scratch space                                          │
// └───────────────────────────────────────────────────────────────┘

/// Where the per-run scratch directories are kept, for an operator who needs
/// them on a different volume.
///
/// Named after [`crate::journal::default_dir`]'s own variable and read the same
/// way, because the two answer the same question about the same machine.  A
/// build's intermediate objects can be large, and the platform data directory is
/// not always where an operator wants them.
pub const SCRATCH_DIR_VAR: &str = "DAIMOND_HAND_SCRATCH_DIR";

/// The environment names that tell a program where to write temporary files.
///
/// Three rather than one.  `TMPDIR` is the POSIX spelling and is what Rust,
/// `cargo`, `cc`, `ld` and coreutils read; `TMP` and `TEMP` are Windows'
/// spellings, and enough cross-platform toolchains consult them on Unix too that
/// setting only the first leaves a portable build writing somewhere else.  All
/// three are set to the same directory, so there is no case in which a program
/// finds one of them and gets a different answer.
pub(crate) const TMP_VARS: &[&str] = &["TMPDIR", "TMP", "TEMP"];

// ── What a command is given that nobody asked for ────────────────────────────
//
// The command's environment is the caller's pairs and nothing else, cleared by
// the launcher and rebuilt from the plan.  That is right, and it was too narrow
// by two names.
//
// **`env_clear` is not the thing to change.**  There are two clears in this file
// and they answer different questions.  `Runner::spawn`'s clears the LAUNCHER's
// environment -- and the launcher's environment is replaced wholesale by
// `execve`, so nothing added there ever reaches the command.  `launch_inner`'s
// clears the command's, and rebuilds it from the pairs that travelled down the
// pipe.  A default therefore has to be added to the PAIRS, here, which is also
// the only place it can be journalled and screened like any other pair.
//
// **The two that are added, and why each of them and not more.**
//
// * `HOME`.  A shell script under `set -u` dies on its first line without one --
//   `HOME: unbound variable` -- and nearly every script in this repository's
//   `dev/` reads it.  The value is the hand's own, which is the same path the
//   page is already told in `caps` as `home:`; a hand that advertises where home
//   is and then hides it from the command is telling two stories.  It POINTS and
//   it does not GRANT: what a command can open is the fence's decision, so a tool
//   that follows `HOME` somewhere ungranted meets a refusal rather than a file.
//   That is `tools.rs`'s own argument for setting it for a git grant, and it is
//   the same argument.
// * `PATH`.  [`PATH_FALLBACK`] is already the hand's answer to "where do programs
//   live" -- `vet_program` resolves a bare `argv[0]` through it when the caller
//   names none.  Handing that program an environment in which it cannot find
//   `node`, `grep` or `curl` is the same answer given twice and differently.  It
//   grants nothing either: the fence decides what may be executed, and everything
//   on this list is in the read-only system base already.
//
// **The ones deliberately refused, because an environment is an input.**
// Everything passed is something a command can be steered by, so the list is
// short and each absence is a decision:
//
// * `USER` and `LOGNAME`.  Nothing needs them.  The kernel already knows who the
//   process is; `id`, `whoami` and git's own author fallback go through
//   `getpwuid` and never read these.  Nothing in this repository's `dev/` reads
//   them either.  A name a program is TOLD is a name the kernel would contradict.
// * `LANG`, `LC_ALL` and the rest of the locale family.  A locale changes what a
//   program PRINTS -- collation, the decimal separator, the language of an error
//   -- and the reader here is a model.  An absent locale is the C locale, which
//   is the deterministic one; the user's desktop setting was chosen for their
//   screen and not for this.  A caller that needs one can send it.
// * `SHELL`.  There is no shell here by design, and a variable naming one is an
//   invitation to find it.
// * `TERM`.  A command run down a pipe has no terminal, and one that believes it
//   has writes escape sequences into captured output.  A pty session is the
//   exception and sets it itself; see `pty::TERM`.
// * `TMPDIR`, `TMP` and `TEMP`.  Set already, unconditionally, and refused from
//   the caller by [`screen_scratch`] -- the one case where the hand's answer is
//   the last word rather than a default.  A caller that could name them would be
//   choosing where a command writes.
//
// The rule for the two that are added is the opposite of the scratch's: the
// caller's pair WINS.  A default is a floor under a caller that said nothing, not
// a correction of one that spoke -- and the app does speak, setting `HOME` for a
// git grant and `PATH` for every toolkit.

/// The names the hand fills in where the request named none.
pub(crate) const ENV_DEFAULTED: &[&str] = &["HOME", "PATH"];

/// Where the hand's own home directory is, where it has one.
///
/// Absolute or nothing: a relative `HOME` is not a home directory, and passing
/// one on would put a command's configuration wherever it happened to be
/// standing.
pub fn home_dir() -> Option<String> {
    match std::env::var("HOME") {
        Ok(h) if h.starts_with('/')	=> Some(h),
        _							=> None,
    }
}

/// What the hand would set a defaulted name to, where it has an answer.
///
/// # Arguments
/// * `name` - One of [`ENV_DEFAULTED`].
pub(crate) fn default_env(name: &str) -> Option<String> {
    match name {
        "HOME"	=> home_dir(),
        "PATH"	=> Some(fmt!("{}", PATH_FALLBACK)),
        // A name in the list with no answer here would be a name silently never
        // set, so the two are kept together and this arm cannot be reached.
        _		=> None,
    }
}

/// Adds the defaults the request left unsaid.
///
/// # Arguments
/// * `env` - The caller's pairs, appended to in place.
pub(crate) fn add_defaults(env: &mut Vec<(String, String)>) {
    for name in ENV_DEFAULTED {
        if env.iter().any(|(k, _)| k == name) {
            continue;
        }
        if let Some(v) = default_env(name) {
            env.push((fmt!("{}", name), v));
        }
    }
}

/// How much of a run's identifier reaches the directory name.
///
/// The identifier is caller-chosen and unbounded; the name only has to make a
/// directory recognisable to a person reading a listing, and the unguessable
/// half is what makes it unique.
const SCRATCH_SLUG_MAX: usize = 48;

/// How deep the removal will descend when a command has left a directory it did
/// not leave writable.
///
/// A limit rather than a promise of completeness: an unbounded recursion over a
/// tree the fenced command built is a stack the fenced command chose the depth
/// of.
const SCRUB_DEPTH_MAX: u32 = 64;

/// One command's private directory for temporary files, and its removal.
///
/// The removal is the whole of why this is a type rather than two function
/// calls.  A scratch that outlives its command is a disk leak on every run and a
/// data leak on the interesting ones -- half a compile's worth of somebody's
/// source, sitting in a directory nobody will ever look in -- so it is tied to a
/// value whose `Drop` removes it.  [`Runner::spawn`] holds it until the child
/// exists and the supervisor holds it after that, which means a refusal, a
/// failure to spawn, an ordinary exit, a timeout and a kill all end the same
/// way, without any of them having to remember to.
pub struct Scratch {
    /// The directory, absolute and canonical.
    dir:  PathBuf,
    /// Whether it has already been removed, so a second attempt is silent.
    gone: bool,
}

impl Scratch {

    /// Makes a directory this run alone can name, or says why it could not.
    ///
    /// Two runs never collide and one cannot guess another's: the name carries
    /// the run's identifier so a person can read a listing, and 128 bits from
    /// the operating system's own source so nobody can predict one.  Guessing is
    /// not idle worry -- the directory holding them all carries no rule in any
    /// fence, so a name is the only thing a command would need.
    ///
    /// # Arguments
    /// * `id` - The caller's identifier for the run.
    pub fn make(id: &str) -> Outcome<Self> {
        let base = res!(scratch_base());

        // Before anything is created, and not after: a scratch base that
        // contained the journal would hand every command a writable root over
        // the record of what it was refused, which `Journal::check_fence`
        // refuses and which is not a thing to create first and discover second.
        if let Ok(journal) = crate::journal::default_dir() {
            res!(clear_of_journal(&base, &journal));
        }

        res!(std::fs::create_dir_all(&base).map_err(|e| err!(e,
            "The scratch directory '{}' could not be made.", base.display();
            IO, File, Path)));
        // Resolved once the directory exists, so that the path put into the
        // fence and the path put into TMPDIR are the same path the kernel will
        // see. `fence::canonical` resolves its roots; an unresolved TMPDIR would
        // name the same place by a spelling the plan never mentioned.
        let base = res!(base.canonicalize().map_err(|e| err!(e,
            "The scratch directory '{}' could not be resolved.", base.display();
            IO, File, Path)));

        let dir = base.join(scratch_name(id));
        let mut mk = std::fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            // Created at 0700 rather than created and then tightened: the gap
            // between the two is a window at whatever the umask happens to be.
            mk.mode(0o700);
        }
        res!(mk.create(&dir).map_err(|e| err!(e,
            "The private temporary directory '{}' could not be made.", dir.display();
            IO, File, Path)));

        Ok(Self { dir, gone: false })
    }

    /// The directory, which is what `TMPDIR` will name.
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Removes it, and says so if it could not.
    ///
    /// Idempotent, because it is called once by the supervisor -- before the
    /// page is told the run ended, so that "ended" and "gone" cannot be observed
    /// in the wrong order -- and again by `Drop` on every other path.
    pub fn remove(&mut self) -> Outcome<()> {
        if self.gone {
            return Ok(());
        }
        self.gone = true;
        if wipe(&self.dir).is_ok() {
            return Ok(());
        }
        // A command can leave behind a directory it did not leave itself able to
        // enter -- an installer that chmods its output, a test fixture with a
        // read-only tree in it -- and the hand is not fenced, so it can put that
        // right. Only then is a failure worth reporting.
        scrub(&self.dir, 0);
        res!(wipe(&self.dir).map_err(|e| err!(e,
            "The private temporary directory '{}' could not be removed, so \
            whatever the command left in it is still on the disc.",
            self.dir.display();
            IO, File, Path)));
        Ok(())
    }
}

/// Removes a tree, counting one that is already absent as removed.
///
/// # Arguments
/// * `dir` - What to remove.
fn wipe(dir: &Path) -> std::io::Result<()> {
    match std::fs::remove_dir_all(dir) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound	=> Ok(()),
        other												=> other,
    }
}

impl Drop for Scratch {

    /// The backstop for every path that is not the supervisor's.
    fn drop(&mut self) {
        if let Err(e) = self.remove() {
            eprintln!("daimond-hand: {}", e);
        }
    }
}

/// Where the per-run directories are made.
///
/// The platform rules are [`crate::journal::default_dir`]'s, with `scratch` in
/// place of `journal`, so the hand keeps everything it owns in one place and a
/// person looking for either finds both.  It is deliberately *not* derived from
/// the journal's directory: an operator who moves the journal to a log volume
/// has said where a record goes, not where a compiler's intermediate objects go.
fn scratch_base() -> Outcome<PathBuf> {
    if let Ok(v) = std::env::var(SCRATCH_DIR_VAR) {
        if !v.is_empty() {
            return Ok(PathBuf::from(v));
        }
    }
    let tail = Path::new("daimond").join("hand").join("scratch");
    match crate::os() {
        "macos" => match std::env::var("HOME") {
            Ok(h) if !h.is_empty() => Ok(Path::new(&h)
                .join("Library")
                .join("Application Support")
                .join(&tail)),
            _ => Err(err!(
                "HOME is not set, so the hand cannot say where a command's \
                temporary files belong. Set {}.", SCRATCH_DIR_VAR;
                Missing, Configuration, Path)),
        },
        "windows" => match std::env::var("APPDATA") {
            Ok(a) if !a.is_empty() => Ok(Path::new(&a).join(&tail)),
            _ => Err(err!(
                "APPDATA is not set, so the hand cannot say where a command's \
                temporary files belong. Set {}.", SCRATCH_DIR_VAR;
                Missing, Configuration, Path)),
        },
        _ => {
            if let Ok(x) = std::env::var("XDG_DATA_HOME") {
                if !x.is_empty() {
                    return Ok(Path::new(&x).join(&tail));
                }
            }
            match std::env::var("HOME") {
                Ok(h) if !h.is_empty() => Ok(Path::new(&h)
                    .join(".local")
                    .join("share")
                    .join(&tail)),
                _ => Err(err!(
                    "Neither XDG_DATA_HOME nor HOME is set, so the hand cannot \
                    say where a command's temporary files belong. Set {}.",
                    SCRATCH_DIR_VAR;
                    Missing, Configuration, Path)),
            }
        },
    }
}

/// Refuses a scratch base that a fence over it would carry the journal with.
///
/// The scratch is the one root the *hand* adds to a fence, so it is the one root
/// nobody else can be relied on to check.  `main` checks the granted folder
/// against the journal at startup and [`crate::journal::Journal::check_fence`]
/// checks the caller's spec on every command; neither sees this one, because it
/// is added after both.
///
/// # Arguments
/// * `base` - Where the per-run directories would be made.
/// * `journal` - Where the record lives.
fn clear_of_journal(base: &Path, journal: &Path) -> Outcome<()> {
    let spec = FenceSpec {
        rw:   vec![fmt!("{}", base.display())],
        ro:   Vec::new(),
        deny: Vec::new(),
        net:  false,
    };
    match crate::journal::check_fence_at(journal, &spec) {
        Ok(()) => Ok(()),
        Err(e) => Err(err!(e,
            "The hand gives every command a writable directory under '{}', and \
            the journal at '{}' would be inside it. A command that can reach its \
            own record can delete the entry that says it was refused, so no \
            command was run. Set {} to a directory that does not contain the \
            journal.", base.display(), journal.display(), SCRATCH_DIR_VAR;
            Invalid, Configuration, Path, Security)),
    }
}

/// The name of one run's directory: readable, then unguessable.
///
/// # Arguments
/// * `id` - The caller's identifier for the run.
fn scratch_name(id: &str) -> String {
    let mut slug = String::new();
    for c in id.chars() {
        if slug.len() >= SCRATCH_SLUG_MAX {
            break;
        }
        // A deliberately short alphabet, and no full stop in it: a name made of
        // these cannot be `.` or `..`, cannot be hidden, and cannot carry a
        // separator into a path.
        match c {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_'	=> slug.push(c),
            _												=> slug.push('_'),
        }
    }
    if slug.is_empty() {
        slug.push_str("run");
    }
    fmt!("{}-{:016x}{:016x}", slug, Rand::rand_u64(), Rand::rand_u64())
}

/// Makes a tree the hand can remove, where the command left one it could not.
///
/// Best effort by design: it is called only after an ordinary removal has
/// already failed, and anything it cannot mend is reported by the second
/// attempt rather than here.  Symbolic links are stepped over rather than
/// followed -- a link in the scratch can point anywhere, and this runs unfenced.
///
/// # Arguments
/// * `p` - What to make removable.
/// * `depth` - How far down this already is.
#[cfg(unix)]
fn scrub(p: &Path, depth: u32) {
    use std::os::unix::fs::PermissionsExt;

    if depth > SCRUB_DEPTH_MAX {
        return;
    }
    let md = match std::fs::symlink_metadata(p) {
        Ok(md) => md,
        Err(_) => return,
    };
    if md.file_type().is_symlink() || !md.is_dir() {
        return;
    }
    let mut perm = md.permissions();
    perm.set_mode(0o700);
    let _ = std::fs::set_permissions(p, perm);
    let rd = match std::fs::read_dir(p) {
        Ok(rd) => rd,
        Err(_) => return,
    };
    for ent in rd.flatten() {
        scrub(&ent.path(), depth + 1);
    }
}

/// Makes a tree the hand can remove, where the platform has the notion.
///
/// # Arguments
/// * `p` - What to make removable.
/// * `depth` - How far down this already is.
#[cfg(not(unix))]
fn scrub(p: &Path, depth: u32) {
    let _ = (p, depth);
}

// ┌───────────────────────────────────────────────────────────────┐
// │ Vetting                                                        │
// └───────────────────────────────────────────────────────────────┘

/// What this machine can fence with, asked once.
///
/// [`Fence::detect`] spawns a thread and asks the kernel, which is cheap but not
/// free, and the answer cannot change while the process lives.  Asking once also
/// means every run in a session is planned against the same answer, so a
/// capability reported to the page in the opening `hello` is the one every later
/// command was actually held to.
pub(crate) fn detected_fence() -> &'static Fence {
    static FENCE: OnceLock<Fence> = OnceLock::new();
    FENCE.get_or_init(Fence::detect)
}

/// The same machine, planned for a TERMINAL, where a carved directory may be listed.
///
/// [`Listing::Sealed`] is right for a command and wrong for a terminal, and the difference is
/// who is at the other end.  A carved directory cannot be listed at all under `Sealed` -- that is
/// the documented cost of it -- and a terminal's working directory is now the granted root, which
/// always holds `.daimond`.  So `ls` in the folder the terminal opens in failed, with nothing on
/// screen to say why: measured on 2026-08-26, `ls` answering "cannot open directory '.'" in a
/// terminal whose fence granted that very directory read and write.
///
/// [`Listing::Names`] costs exactly what the enum says it costs: entry NAMES inside the denied
/// subtree become visible, never contents, because reading a file still needs `READ_FILE`.  The
/// person typing owns those names -- it is their machine and their workspace -- and no daimon can
/// reach this surface: no tool opens a terminal or types into one, which is the same reason
/// `terminal_toolkit_bounds` may lend it an ssh key and `toolkit_bounds` may not.
///
/// A command keeps [`detected_fence`] and its seal.  The choice is the hand's, never the page's:
/// a caller that could name its own listing could name the laxer one.
pub fn detected_terminal_fence() -> &'static Fence {
    static FENCE: OnceLock<Fence> = OnceLock::new();
    FENCE.get_or_init(|| Fence::detect_with(Listing::Names, SysBase::Minimal))
}

/// What this machine can refuse at the system-call layer, asked once.
///
/// Cached for the same reason [`detected_fence`] is, and with one extra reason:
/// [`Seccomp::detect`] answers by *installing* a throwaway filter on a thread of
/// its own, which is the only honest probe and not one to repeat per command.
pub(crate) fn detected_seccomp() -> &'static Seccomp {
    static SYS: OnceLock<Seccomp> = OnceLock::new();
    SYS.get_or_init(Seccomp::detect)
}

/// Whether `p` is `prefix` or lies beneath it.
///
/// Compared component by component, so `/workshop` is not inside `/work`.
///
/// An empty or relative prefix is *nobody's* ancestor, and saying so here is not
/// pedantry: `Path::new("/etc/ssh").starts_with("")` is true, so a fence whose
/// root was the empty string granted the whole filesystem while passing every
/// guard that only counted roots.  A spec of that shape reached the hand from
/// the app, which read the granted root out of a status message and checked only
/// that the key was present.
///
/// # Arguments
/// * `p` - The candidate path, already absolute.
/// * `prefix` - The root it might sit under.
fn under(p: &Path, prefix: &Path) -> bool {
    if prefix.as_os_str().is_empty() || !prefix.is_absolute() {
        return false;
    }
    p.starts_with(prefix)
}

/// Environment variables the caller may not set, whatever else it may set.
///
/// `README.md` gives this as the reason the environment is not the model's: a
/// caller that can name a variable can name `LD_PRELOAD`, and a library loaded
/// into every fenced command is a way to make that command do something else.
/// The fence does not stop it -- the injected object is read through the same
/// grants the program itself is read through -- so it has to be refused here.
///
/// Refused rather than dropped: a command that silently did not get the
/// environment it asked for fails somewhere further along, for a reason nobody
/// can see, and the caller is entitled to be told which name it may not use.
///
/// This is a floor and not a ceiling.  Every interpreter has its own version --
/// `PYTHONPATH`, `RUBYOPT`, `NODE_OPTIONS` -- and the general answer to those is
/// that the fence bounds what any of them can reach.  The four families here are
/// different in kind: they act on the *dynamic loader*, before any program's own
/// code runs, so they apply to a program that has no interpreter at all.
const ENV_REFUSED: &[&str] = &[
    "GCONV_PATH",       // Loads a conversion module of the caller's choosing.
    "BASH_ENV",         // Sourced by a non-interactive bash before anything else.
    "ENV",              // The POSIX shell's spelling of the same idea.
    "SHELLOPTS",        // Turns on shell behaviour a caller was not given.
];

/// Refuses an environment carrying a name that decides what code loads.
///
/// # Arguments
/// * `env` - The pairs the caller asked for.
///
/// # Returns
/// The refusal sentence, or `None` if every pair is ordinary.
pub(crate) fn screen_env(env: &[(String, String)]) -> Option<String> {
    for (k, _) in env {
        if k.is_empty() || k.contains('=') || k.contains('\0') {
            return Some(fmt!(
                "Refused: {:?} is not a usable environment variable name. A name cannot be empty \
                and cannot contain '=' or a null byte, because nothing downstream could tell \
                where it ended.", k));
        }
        // The dynamic loader's whole family, not `LD_PRELOAD` alone: `LD_AUDIT`
        // loads a library the same way, and `LD_LIBRARY_PATH` chooses which
        // copy of a library a program gets.
        if k.starts_with("LD_") || ENV_REFUSED.contains(&k.as_str()) {
            return Some(fmt!(
                "Refused: this command asked to run with {} set. That variable decides what code \
                is loaded into the program before the program's own code runs, so it is a way to \
                make any command do something else -- and the fence cannot tell the difference, \
                because the injected code is read through the same grants the program is. Set \
                what the command needs some other way.", k));
        }
    }
    None
}

/// Refuses an environment that tries to say where a command's temporary files go.
///
/// Refused rather than dropped, for the reason [`screen_env`] gives: a caller
/// whose setting silently did not take effect has no way to find that out.  And
/// refused rather than honoured because `TMPDIR` decides *where a command
/// writes*, which is the one thing the fence exists to decide -- a caller able
/// to set it could point a compiler's output at any granted path and call it
/// temporary.
///
/// Compared without regard to case, because a name differing only in case would
/// be a second answer to the same question on the platforms where `TMP` and
/// `TEMP` come from.
///
/// # Arguments
/// * `env` - The pairs the caller asked for.
///
/// # Returns
/// The refusal sentence, or `None` if the caller left the question alone.
pub(crate) fn screen_scratch(env: &[(String, String)]) -> Option<String> {
    for (k, _) in env {
        if TMP_VARS.iter().any(|n| k.eq_ignore_ascii_case(n)) {
            return Some(fmt!(
                "Refused: this command asked to run with {} set. The hand makes every command a \
                private directory of its own for temporary files and points TMPDIR, TMP and TEMP \
                at it, so there is nothing to configure -- and a command that could name that \
                directory would be choosing where it writes, which is the fence's decision and \
                not the caller's. Ask again without it.", k));
        }
    }
    None
}

// ── A push this repository could authenticate on its own ─────────────────────
//
// The app guards `git push` inside the page (`src/tools.rs`, `git_guard`), and for a push carrying
// DAIMOND's credential that guard is the whole decision: an `argv` that does not pass it gets no
// environment, so the push cannot authenticate however it is spelled.  What it cannot cover is a
// repository that already holds working credentials of its OWN -- an HTTPS remote with a token in
// `.git/config`, or a `.git-credentials` file inside the granted root.  There a `--force` succeeds
// with nothing from Daimond in it at all, and the page has no way to know.  The hand is where that
// refusal can still be made, so it is made again here.
//
// # How much of the page's list is duplicated, and why not the rest
//
// Two copies of a list drift, and drift is its own hazard, so the line is drawn by REASON rather
// than by copying.  The page's rules have two different reasons behind them and only one of them
// survives the journey:
//
// * **Work that cannot be got back.**  `--force`, `--force-with-lease`, `--force-if-includes`,
//   `--delete`, `--mirror`, `--prune`, a `+` or `:` refspec, and `f` or `d` in a short cluster.
//   `--no-verify`, because a pre-push hook is a check the user installed.  `--receive-pack` and
//   `--exec`, because they name a program to run at the far end.  None of these depends on whose
//   credential authenticates the push, so every one is duplicated here.
// * **Daimond's credential is scoped to one host.**  "Only `origin`", "not a URL", `--repo`.  Those
//   exist because a push aimed anywhere else could not authenticate with the app's token anyway,
//   and saying so turns a confusing failure into a sentence.  NONE of them is duplicated.  The
//   premise here is a repository with its own credentials, so `git push upstream main` is an
//   ordinary push and refusing it would be a rule with no harm behind it -- while a fenced command
//   that wanted to send the workspace somewhere would reach for `curl` and not for git.  Refusing
//   destruction on EVERY remote is broader where it matters and narrower where it does not.
//
// `-c`, `--config-env` and `--exec-path` before the subcommand are duplicated, for a reason of
// their own rather than the page's: `remote.<name>.push` is a refspec, so
// `-c remote.origin.push=+main:main` is `--force` spelled in configuration, and `--exec-path`
// chooses which `git-*` programs run.
//
// # What this does not close, and is not pretended to
//
// * **The same refspec written into the repository's own `.git/config`.**  That file is inside the
//   fence and the model may write it, so `git push origin` on its own can be a forced push and
//   neither guard sees anything in `argv`.  Closing it means reading the repository's
//   configuration, and that job has real corners -- `.git` can be a file, the repository can be
//   above `cwd`, `-C` and `--git-dir` move it -- so a half-built version would be counted as done
//   and would be worse than none.  Written down rather than attempted.
// * **Another spelling of the program.**  `argv[0]` is matched by basename, so `/usr/bin/git` is
//   caught and `sh -c 'git push -f'` is not.  The page can shrug that off because no credential is
//   attached to a command whose `argv[0]` is not `git`; here the harm needs no credential of ours,
//   so the shrug does not transfer.  It is the same shape as `REVIEW.md` §3.13 and it is not
//   closed.
// * **A pty session.**  `Pty::open` runs an interactive shell; `argv[0]` is that shell, and what is
//   typed into it never passes through here.

/// Git's own options, before the subcommand, that take their value as a separate argument.
///
/// Needed for one thing: finding where the subcommand is.  `git -C /somewhere push` has `push`
/// third and `git --no-pager push` has it second, and a parser that could not tell them apart would
/// read `/somewhere` as the subcommand and stop guarding.
const GIT_OPT_VALUE: &[&str] = &[
    "-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env",
    "--super-prefix", "--attr-source",
];

/// Long options to `git push` that are refused, and what each of them does.
///
/// Matched on the name with any `=value` removed, so `--force-with-lease=main` is caught and
/// `--no-force-with-lease` -- which turns forcing OFF -- is not.
const PUSH_LONG_REFUSED: &[(&str, &str)] = &[
    ("--force",             "overwrites whatever is on the remote"),
    ("--force-with-lease",  "overwrites the remote when it looks unchanged, which is still an \
                             overwrite"),
    ("--force-if-includes", "is part of the force-with-lease family"),
    ("--delete",            "removes a branch or tag from the remote"),
    ("--mirror",            "makes the remote match this repository exactly, deleting every ref \
                             that is not here"),
    ("--prune",             "deletes remote branches that are not here"),
    ("--no-verify",         "skips the hooks that run before a push"),
    ("--receive-pack",      "names the program that runs at the far end"),
    ("--exec",              "names the program that runs at the far end"),
];

/// The refusal a push that could lose work gets.
///
/// One shape for all of them, because they are one decision.  It names the hand, so that a reader
/// looking at two guards can tell which one spoke; and it says the rule is a rule, so that the
/// model reworks the request rather than the spelling.
///
/// # Arguments
/// * `spelling` - The option as it was written, so the model can see which one was meant.
/// * `does` - What that option does, in a clause.
fn push_refusal(spelling: &str, does: &str) -> String {
    fmt!(
        "Refused: '{}' {}. A push from inside Daimond only ever fast-forwards, because a \
        fast-forward push cannot destroy a commit that exists nowhere else and every other kind \
        can. The machine hand refuses this as well as the page does, because a repository holding \
        credentials of its own could make that push without anything from Daimond in it. It is a \
        rule and not a fault in the command, so do not try another spelling of it: '-f', \
        '--force-with-lease', a '+' in front of the refspec and '--delete' are all refused \
        together. If the history really has to be rewritten, say so and let the user push it \
        themselves.", spelling, does)
}

/// Whether one of git's own options, before the subcommand, is refused on a push.
///
/// # Arguments
/// * `a` - One argument, exactly as it was written.
fn git_opt_refused(a: &str) -> Option<&'static str> {
    // `-c k=v` and `-ck=v` are both git; `-C` is a different option and case matters.
    if a.starts_with("-c") && !a.starts_with("--") {
        return Some("-c");
    }
    match a.split('=').next().unwrap_or(a) {
        "--config-env" => Some("--config-env"),
        "--exec-path"  => Some("--exec-path"),
        _              => None,
    }
}

/// Refuses a `git push` that could destroy work at the far end.
///
/// Pure, so the whole decision is testable without a repository, a remote or a credential.  See the
/// section comment above for which of the app's rules are duplicated here, which are not, and what
/// is left open.
///
/// # Arguments
/// * `argv` - The command, exactly as the caller sent it.
///
/// # Returns
/// The refusal sentence, or `None` where this is not a push or is one that only fast-forwards.
pub(crate) fn screen_git_push(argv: &[String]) -> Option<String> {
    let first = match argv.first() {
        Some(a) => a.as_str(),
        None    => return None,
    };
    // Basename, so `/usr/bin/git` is caught. Split on '/' rather than through `Path`, so that this
    // reads argument text the same way the page's guard does.
    if first.rsplit('/').next().unwrap_or(first) != "git" {
        return None;
    }
    // Git's own options, then the subcommand. `pre` is kept because some of those options are
    // refused on a push, and finding the subcommand at all needs the same walk.
    let mut i = 1;
    let mut pre: Vec<&str> = Vec::new();
    let mut sub: Option<&str> = None;
    while i < argv.len() {
        let a = argv[i].as_str();
        if !a.starts_with('-') {
            sub = Some(a);
            i += 1;
            break;
        }
        pre.push(a);
        i += if GIT_OPT_VALUE.contains(&a) { 2 } else { 1 };
    }
    // `git`, `git --version`: nothing to guard.
    let sub = match sub {
        Some(s) => s,
        None    => return None,
    };
    if sub != "push" {
        return None;
    }
    for a in &pre {
        if let Some(name) = git_opt_refused(a) {
            return Some(fmt!(
                "Refused: '{}' before 'push' adds configuration to this one command, and \
                'remote.<name>.push' is a refspec -- so a forced push can be written there \
                instead of on the command line, and '--exec-path' chooses which git programs run \
                at all. The machine hand refuses it for the same reason the page does. Run the \
                push without it.", name));
        }
    }
    let rest: Vec<&str> = argv.get(i..).unwrap_or(&[]).iter().map(|s| s.as_str()).collect();
    // The push's own arguments. Positionals are collected rather than checked in place, because
    // which one is the remote depends on how many options ate a value first.
    let mut positional: Vec<&str> = Vec::new();
    let mut j = 0;
    let mut ended = false;
    while j < rest.len() {
        let a = rest[j];
        if ended {
            positional.push(a);
            j += 1;
            continue;
        }
        if a == "--" {
            ended = true;
            j += 1;
            continue;
        }
        if a.starts_with("--") {
            let name = a.split('=').next().unwrap_or(a);
            if let Some((sp, does)) = PUSH_LONG_REFUSED.iter().find(|(n, _)| *n == name) {
                return Some(push_refusal(sp, does));
            }
            // The one permitted long option that takes a separate value; the rest either take none
            // or are refused above.
            j += if name == "--push-option" && !a.contains('=') { 2 } else { 1 };
            continue;
        }
        if a.starts_with('-') && a.len() > 1 {
            // Short options are CLUSTERS: `-uf`, `-fq` and `-qfu` all carry the `f`.
            let flags = &a[1..];
            if flags.contains('f') {
                return Some(push_cluster_refusal(a, 'f', "forces the push"));
            }
            if flags.contains('d') {
                return Some(push_cluster_refusal(a, 'd', "deletes the ref on the remote"));
            }
            // `-o` is `--push-option`, and its value follows unless it is stuck to the cluster.
            j += if flags.ends_with('o') { 2 } else { 1 };
            continue;
        }
        positional.push(a);
        j += 1;
    }
    // The first positional is the remote, which this deliberately does not judge; every one after
    // it is a refspec, and two ordinary-looking spellings destroy work.
    for spec in positional.iter().skip(1) {
        if spec.starts_with('+') {
            return Some(push_refusal(spec,
                "is a forced refspec -- the leading '+' means the same as --force"));
        }
        if spec.starts_with(':') {
            return Some(push_refusal(spec,
                "is a delete refspec -- an empty source side means the same as --delete"));
        }
    }
    None
}

/// The refusal a short-option cluster gets, naming the letter rather than the cluster.
///
/// `-uf` is refused for its `f`, and a model told only that `-uf` was refused would reasonably try
/// `-u -f`.
///
/// # Arguments
/// * `cluster` - The argument as written.
/// * `letter` - The letter that decided it.
/// * `does` - What that letter does, in a clause.
fn push_cluster_refusal(cluster: &str, letter: char, does: &str) -> String {
    push_refusal(
        &fmt!("-{}", letter),
        &fmt!("{} -- it is in '{}', and a short option carries every letter written after the \
            dash", does, cluster))
}

/// A string cut to at most `max` bytes on a character boundary, marked where it
/// was cut.
///
/// The mark is not decoration: a command line a reader takes for whole is one
/// they will try to run again, and the argument that went missing is usually the
/// one that mattered.
///
/// # Arguments
/// * `s` - The text.
/// * `max` - The most bytes the result may take, including the mark.
fn cut_to(s: &str, max: usize) -> String {
    if s.len() <= max {
        return fmt!("{}", s);
    }
    const MARK: &str = " …";
    let room = max.saturating_sub(MARK.len());
    let mut end = room;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    fmt!("{}{}", &s[..end], MARK)
}

/// Resolves `prefix` where it exists, so both sides of a containment test agree.
///
/// # Arguments
/// * `prefix` - A fence root as the caller spelled it.
fn resolve(prefix: &str) -> PathBuf {
    match std::fs::canonicalize(prefix) {
        Ok(p)  => p,
        Err(_) => PathBuf::from(prefix), // Not there yet; compare as written.
    }
}

/// The home-relative paths a granted toolchain is allowed to name.
///
/// # Why this table exists here as well as in the app
///
/// `REVIEW.md` §1.5.  The fence is computed inside the page and the page is not
/// trusted, so the hand has to decide for itself whether an arriving fence is
/// one its grant could have produced.  "Everything under the granted root" is
/// the obvious rule and it is wrong: a toolchain does not live in the workspace.
/// `cargo` is under `~/.cargo`, `node` under `~/.nvm`, and a rule that refused
/// them would refuse every real build -- and a security check that breaks
/// `cargo` is a security check somebody switches off.
///
/// So the question the clamp asks is not "is this path under that path" but "is
/// this a root the grant could imply".  The set is closed and knowable: the
/// workspace, the hand's own scratch, and these -- the same tails
/// `Toolkit::grants` names in `src/tools.rs`, at the level of the directory each
/// toolchain owns rather than each individual grant, so that the app adding a
/// path *within* a toolchain does not need a change here.
///
/// The two copies can drift, and the drift fails safe and loud: a path this list
/// does not know is refused with a sentence naming it and naming this constant,
/// so the failure is one line to fix rather than a hole to find.  The reverse
/// drift -- the app dropping a toolkit -- costs nothing, because a ceiling that
/// is never reached grants nothing.
/// # Why it names a toolkit and a level, and not merely a folder
///
/// It used to be a flat list of folders, allowed to every fence at either level
/// whether or not any toolkit had been granted.  That was two mistakes in one
/// line, and the second is the dangerous one:
///
/// * **Unconditional.**  A fence naming `~/.cargo/registry` was accepted from a
///   turn that had been granted no toolchain at all.
/// * **Level-blind.**  `~/.local/bin` is a READ grant in the app's own table --
///   it holds the console scripts `pip install --user` writes -- and the clamp
///   accepted it as writable.  `~/.local/bin` is first on `PATH`, so a file
///   called `ls` or `git` written there is unfenced execution as the user on the
///   next shell command.  Measured against the release binary with no toolkit in
///   play: `rw:[<workspace>, ~/.local/bin]` was accepted, the shim was written,
///   and `chmod 755` succeeded because making a file executable is not
///   "loosening" and the metadata filter permits it.
///
/// So each entry names the toolkit that implies it and whether the fence may
/// name it WRITABLE, and both are checked.  A `ro` root may sit under any tail of
/// a granted toolkit; an `rw` root only under one marked writable.
/// Which of the three doors a gated request came in by.
///
/// Lives here rather than beside the dispatcher because the clamp reads it: one toolkit,
/// [`TOOLKIT_ROOTS`]'s `remote` rows, is granted to a terminal the user opened and to nothing
/// a daimon can reach.  An enum rather than a boolean so that a fourth door cannot be added
/// without the compiler asking what it means here.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Door {
    Command,
    Terminal,
    File,
}

impl Door {
    /// Is this the surface a person opened and is typing into?
    pub fn is_terminal(&self) -> bool {
        matches!(self, Self::Terminal)
    }
}

const TOOLKIT_ROOTS: &[KitRoot] = &[
    // rust
    KitRoot { kit: "rust",   tail: ".cargo/bin",           write: false, term: false },
    KitRoot { kit: "rust",   tail: ".rustup",              write: false, term: false },
    KitRoot { kit: "rust",   tail: ".cargo/registry",      write: true, term: false  },
    KitRoot { kit: "rust",   tail: ".cargo/git",           write: true, term: false  },
    KitRoot { kit: "rust",   tail: ".cargo/.package-cache", write: true, term: false  },
    // The target directory this repository's own convention puts a build in, one
    // named subdirectory per agent slot. Without the row the clamp refuses the
    // whole command, so the grant the app now sends makes a fenced build WORSE
    // than none at all. `~/.cache` is never granted: only this tail is, and only
    // to a request that named the Rust toolkit.
    KitRoot { kit: "rust",   tail: ".cache/cargo-targets", write: true, term: false  },
    // node
    KitRoot { kit: "node",   tail: ".nvm",                 write: false, term: false },
    KitRoot { kit: "node",   tail: ".npm",                 write: true, term: false  },
    // Where a world's dev server and mock provider keep their pid files, their
    // output and their scratch root. Same reasoning as the row above, and the
    // same narrowness: the tail and not `~/.cache`.
    KitRoot { kit: "node",   tail: ".cache/daimond",       write: true, term: false  },
    // python
    KitRoot { kit: "python", tail: ".pyenv",               write: false, term: false },
    KitRoot { kit: "python", tail: ".local/bin",           write: false, term: false },
    KitRoot { kit: "python", tail: ".local/lib",           write: false, term: false },
    KitRoot { kit: "python", tail: ".cache/pip",           write: true, term: false  },
    // go
    KitRoot { kit: "go",     tail: "sdk",                  write: false, term: false },
    KitRoot { kit: "go",     tail: "go/bin",               write: false, term: false },
    KitRoot { kit: "go",     tail: "go/pkg/mod",           write: true, term: false  },
    KitRoot { kit: "go",     tail: ".cache/go-build",      write: true, term: false  },
    // git -- the CONFIGURATION and not the program, which is in `/usr/bin` and therefore already in
    // this hand's own read-only base. Without these two rows the app's Git toolkit cannot be
    // granted at all: `vet_roots` refuses the fence, loudly and safely, and a fenced git then runs
    // with no `core.hooksPath` -- which on this machine is the whole of `~/.gitconfig`, and is the
    // pre-commit hook that reads every staged line looking for a credential. An unreadable hooks
    // directory is indistinguishable from an empty one, so refusing `--no-verify` while the hook
    // cannot run would be a guard protecting nothing.
    KitRoot { kit: "git",    tail: ".gitconfig",           write: false, term: false },
    KitRoot { kit: "git",    tail: ".config/git",          write: false, term: false },
    // remote -- THE ONE TOOLKIT A COMMAND CANNOT HAVE, whatever the page says it was granted.
    //
    // An `ssh` that reaches another machine reaches it UNFENCED: the shell at the far end is
    // sshd's child, under nothing this binary applies. So a fenced command able to run it
    // would not be fenced at all, and `term: true` is what makes that a property of the HAND
    // rather than of the page -- the app drops the grant for a command (`toolkit_bounds` in
    // `src/tools.rs`), and this refuses it even if a page were made to send it anyway.
    //
    // Read-only, all three, with one exception: the host list ssh writes when it learns a
    // host. None of them is the user's own `~/.ssh`, which is denied by name in the app's
    // table and is never lent to anything.
    KitRoot { kit: "remote", tail: ".config/oxedyne/daimond-hand/bin",
        write: false, term: true },
    KitRoot { kit: "remote", tail: ".config/oxedyne/daimond-hand/ssh",
        write: false, term: true },
    KitRoot { kit: "remote", tail: ".config/oxedyne/daimond-hand/known_hosts",
        write: true,  term: true },
];

/// Has the user set Daimond's own ssh up on this computer?
///
/// The Remote toolchain's posture, and it is READ rather than stored.  `install.sh --remote`
/// makes the key and writes the wrapper; a machine where nobody ran it has neither.  So there
/// is no setting anywhere that could disagree with what it describes, and nothing new to
/// forget, migrate or leave switched on -- the answer IS the two files ssh cannot work
/// without.  A machine that never had ssh set up therefore never gains it by itself, which is
/// the whole of why the posture is not a default.
///
/// Both files, not either.  A wrapper with no key behind it is an `ssh` on `PATH` that
/// connects to nothing; a key with no wrapper is a key nothing would ever pass to OpenSSH,
/// which takes its home directory from the passwd entry and not from `HOME`.  Announcing
/// "ready" for half of it would put a grant in a terminal's fence for a toolchain that cannot
/// work.
///
/// Said to the page in `hello`'s `caps` as `remote:ready`, beside `home:`, `host:` and
/// `shell:`, and for the same reason as all three: the page cannot read this machine.
pub fn remote_ready() -> bool {
    match home_dir() {
        Some(h) => remote_ready_at(Path::new(&h)),
        None    => false,
    }
}

/// As [`remote_ready`], against a named home directory.
///
/// Split out so the answer can be tested without touching the environment: `HOME` is process
/// state and a test that set it would decide what every other test on the same process saw.
///
/// # Arguments
/// * `home` - The home directory to look under.
fn remote_ready_at(home: &Path) -> bool {
    let base = home.join(".config/oxedyne/daimond-hand");
    base.join("bin/ssh").is_file() && base.join("ssh/id_daimond").is_file()
}

/// One folder a named toolchain may reach, and at what level.
///
/// Mirrors one row of `Toolkit::grants` in the app's `src/tools.rs`.  The
/// `Level::Deny` rows there have no entry here on purpose: a deny only ever takes
/// access away, and this is a ceiling on what may be granted.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct KitRoot {
    /// The toolkit that implies it, as the app's `Toolkit::name` spells it.
    pub kit:   &'static str,
    /// The folder, relative to the home directory.
    pub tail:  &'static str,
    /// Whether a fence may name it as WRITABLE, and not merely readable.
    pub write: bool,
    /// Whether only a terminal the user opened may name it.
    pub term:  bool,
}

/// Whether an arriving fence names only roots this hand's grant could imply.
///
/// This is the answer to `REVIEW.md` §1.5, and the finding is worth restating
/// because the shape of it is easy to lose: the fence travels **through the
/// page**, and a page is not the app.  The hand was honouring whatever roots
/// arrived.  Measured against the release binary before this existed, an exec
/// carrying `fence:{rw:["/etc"]}` with `cwd:"/etc"` ran `/bin/ls /etc/ssh` and
/// returned the listing -- with the fence fully in force, doing exactly what it
/// was told.  `rw:["/"]` *was* refused, but only because the journal happens to
/// sit somewhere under `/` and `Journal::check_fence` refuses a fence that
/// reaches the record.  That is a coincidence, not a boundary, and it stops
/// holding the moment somebody moves the journal.
///
/// Three sources of a legitimate root, and there is no fourth:
///
/// * **The granted root**, which is the workspace the user handed over.
/// * **The hand's own scratch**, which the hand appends to every fence itself --
///   allowed here so that a fence echoed back to the hand is not refused for
///   carrying something the hand put in it.
/// * **A toolchain the request SAYS was granted**, from [`TOOLKIT_ROOTS`], at the
///   level that table gives it.
///
/// That third source is conditional and level-aware, and both halves were once
/// missing -- see [`TOOLKIT_ROOTS`] for what that cost.  A request naming no
/// toolkit reaches no toolchain folder at all, which is the ordinary case: a
/// toolkit is a grant, the user makes it per Diamond, and most turns have none.
///
/// `deny` is not clamped and must not be: a deny only ever takes access away, so
/// a caller naming one outside the grant has narrowed its own fence and harmed
/// nobody.
///
/// # Arguments
/// * `root` - The folder this hand was granted.
/// * `fence` - The fence as it arrived, before the hand adds anything.
/// * `kits` - The toolkit names the request carried.  Never read from `argv`: a
///   fence that widened itself to fit the requested binary would be a fence the
///   model chooses.
/// * `door` - Which surface the request came in by.  A [`TOOLKIT_ROOTS`] row marked `term`
///   is reachable from a terminal the user opened and from nothing else, however the request
///   spells its grant.
///
/// # Returns
/// The refusal, or `None` where every root is one the grant could imply.
pub fn vet_roots(root: &Path, fence: &FenceSpec, kits: &[String], door: Door) -> Option<String> {
    // Allowed at either level: the workspace, and the hand's own scratch, which the hand appends
    // to every fence itself and must therefore accept back.
    let mut any: Vec<PathBuf> = vec![root.to_path_buf()];
    if let Ok(s) = scratch_base() {
        any.push(resolve(&fmt!("{}", s.display())));
    }
    // The toolchain folders, split by level, and only for the toolkits this request named. A name
    // this build does not know contributes nothing rather than being refused: the app may record a
    // toolkit a later build expresses, and the safe reading of "I do not know what that grants" is
    // "it grants nothing".
    let mut ro_only: Vec<PathBuf> = Vec::new();
    let mut writable: Vec<PathBuf> = Vec::new();
    // Folders a granted toolkit names that THIS door may not have. Kept rather than
    // discarded so the refusal can say which of the two mistakes it is: "nobody granted
    // that" is false here and would send the reader to the wrong fix.
    let mut term_only: Vec<PathBuf> = Vec::new();
    if let Ok(h) = std::env::var("HOME") {
        if !h.is_empty() && Path::new(&h).is_absolute() {
            for k in TOOLKIT_ROOTS {
                if !kits.iter().any(|n| n == k.kit) {
                    continue;
                }
                // The trust boundary, enforced at the hand and not merely at the page: a
                // grant marked for the terminal is not available to a command or to a file
                // operation, which are the two doors a daimon reaches.
                let p = Path::new(&h).join(k.tail);
                if k.term && !door.is_terminal() {
                    term_only.push(p);
                    continue;
                }
                if k.write { writable.push(p); } else { ro_only.push(p); }
            }
        }
    }
    for (which, roots) in [("rw", &fence.rw), ("ro", &fence.ro)] {
        let writing = which == "rw";
        for r in roots.iter() {
            let p = resolve(r);
            if any.iter().any(|a| under(&p, a)) {
                continue;
            }
            if writable.iter().any(|a| under(&p, a)) {
                continue;
            }
            // A readable grant may sit under a folder the toolkit writes as well as one it only
            // reads; a writable grant may not sit under one it only reads.
            if !writing && ro_only.iter().any(|a| under(&p, a)) {
                continue;
            }
            // Said apart, because the two are different mistakes and the fix for each is
            // different: one is a fence naming somewhere nobody granted, the other is a fence
            // asking to WRITE a toolchain folder that is lent for reading.
            if writing && ro_only.iter().any(|a| under(&p, a)) {
                return Some(fmt!(
                    "Refused: this command's fence asks to WRITE '{}', which is part of a granted \
                    toolchain and is lent for reading. The compiler, the interpreter and what a \
                    package manager installed for the user are not a command's to edit -- a file \
                    written there runs the next time anything on this machine calls that name. \
                    The caches a build genuinely has to write are granted separately and by name.",
                    r));
            }
            // Named by a toolkit the request really did carry, and refused all the same for
            // the door it came in by. The whole of the Remote grant's reason is in the
            // sentence, because the reader's next move depends on believing it.
            if term_only.iter().any(|a| under(&p, a)) {
                return Some(fmt!(
                    "Refused: this command's fence names '{}', which is part of the Remote \
                    toolchain -- an ssh key of Daimond's own and the host list that goes with \
                    it. That grant is lent to a terminal the user opened by hand and to \
                    nothing else, because an ssh reaches a shell on another machine that no \
                    fence on this one binds. A command does not get it, whatever this Diamond \
                    was granted.", r));
            }
            return Some(fmt!(
                "Refused: this command's fence grants '{}' access to '{}', which is not inside \
                the folder this hand was granted ('{}'), is not this hand's own temporary \
                directory, and is not a folder one of the toolkits this request named ({}) \
                reaches. The fence is computed in the page and the page is not the app, so the \
                hand checks that an arriving fence is one its grant could have produced -- and \
                refuses rather than fencing a command around somewhere nobody granted. If this is \
                a toolchain the hand should know about, it belongs in TOOLKIT_ROOTS in exec.rs.",
                which, r, root.display(),
                if kits.is_empty() { fmt!("none") } else { kits.join(", ") }));
        }
    }
    None
}

/// The user's own files a terminal they opened is lent, read-only, by name.
///
/// **Three, and no more.**  A shell started under the fence could not read a single one of
/// them, so the terminal opened on `bash: /home/…/.bashrc: Permission denied` and then on a
/// prompt belonging to nobody -- no aliases, no functions, no history search, none of the key
/// bindings that are in every other terminal on the machine.  A person opening a terminal
/// expects their own terminal.
///
/// * `.bashrc` -- what an interactive shell reads: the prompt, the aliases, the functions.
/// * `.profile` -- what a login shell reads, and on many machines the file that reaches
///   `.bashrc` at all.
/// * `.inputrc` -- readline's, so the keys do what the user's fingers expect.
///
/// **Read-only, named one at a time, and never the home directory.**  That is the difference
/// between lending three files and granting `$HOME`, which holds `.ssh`, `.aws`, `.netrc` and
/// every browser profile.  A file `.bashrc` sources that is not in this list is refused and
/// says so on the screen, which is honest and is a line the user can act on.
pub const USER_DOTFILES: &[&str] = &[".bashrc", ".profile", ".inputrc"];

/// Lends those files to a terminal, and to nothing else.
///
/// # Which end decides, and why it is this one
///
/// The page composes the fence and this does not change that: what the page cannot do is
/// know which of the three files EXIST.  `fence::canonical` refuses a root it cannot resolve
/// -- correctly, since a marked folder that has gone is a fence that would not cover what the
/// user marked -- so a page naming `~/.inputrc` on a machine without one would take the whole
/// terminal down with it.  The same argument [`grant_git_hooks`] is here for.
///
/// A denial already in the fence is left alone.  A deny is a decision somebody made, and
/// widening one from here would be the fence quietly disagreeing with it.
///
/// # Arguments
/// * `fence` - The fence as it arrived; the files that are there are added read-only.
/// * `door` - Which surface the request came in by.  Nothing is added for a command or a file
///   operation, which are the two doors a daimon reaches: the user's own shell configuration
///   runs code, and a `.bashrc` read by a program the model chose is a program that ran the
///   user's aliases with the model's arguments.
///
/// # Returns
/// What was lent, so a caller that wants to say so can.
pub fn grant_user_dotfiles(fence: &mut FenceSpec, door: Door) -> Vec<String> {
    if !door.is_terminal() {
        return Vec::new();
    }
    let home = match home_dir() {
        Some(h) => PathBuf::from(h),
        None    => return Vec::new(),
    };
    let mut lent = Vec::new();
    for tail in USER_DOTFILES {
        let p = home.join(tail);
        if !p.is_file() {
            continue;
        }
        if fence.deny.iter().any(|d| under(&p, &resolve(d))) {
            continue;
        }
        if fence.rw.iter().chain(fence.ro.iter()).any(|r| under(&p, &resolve(r))) {
            continue;
        }
        let named = fmt!("{}", p.display());
        fence.ro.push(named.clone());
        lent.push(named);
    }
    lent
}

/// Drops the toolchain folders this machine does not have.
///
/// A toolkit grant is a list of paths the APP expands from one name the user
/// ticked, and the machine may simply not have all of them: `~/.config/git` and
/// `~/.nvm` and `~/.pyenv` are absent here, and each of them is an ordinary
/// arrangement rather than a fault.  [`fence::canonical`] refuses an `rw` or `ro`
/// root it cannot resolve, and rightly -- so before this existed, ticking the Git
/// toolkit refused EVERY command the Diamond ran, with a sentence about a path
/// the user had never named.
///
/// Skipping is the safe direction: a path that is not there grants nothing, so
/// dropping it tightens the fence.  It is also the rule `fence::resolve` already
/// applies to the read-only system base, and for the same reason -- these are
/// paths nobody asked for by name.
///
/// **A WORKSPACE root is not touched, and that is the whole of the care here.**
/// A marked folder that cannot be resolved is a fence that would silently not
/// cover what the user marked, which is the opposite case and must keep
/// refusing.  So only a root under a [`TOOLKIT_ROOTS`] tail of a toolkit this
/// request NAMED is eligible, and it is dropped only when the filesystem says it
/// is not there.
///
/// # Arguments
/// * `fence` - The fence as it arrived; the absent toolchain roots are removed.
/// * `kits` - The toolkit names the request carried.
///
/// # Returns
/// What was dropped, so a caller that wants to say so can.
pub fn drop_absent_kit_roots(fence: &mut FenceSpec, kits: &[String]) -> Vec<String> {
    let home = match home_dir() {
        Some(h) => PathBuf::from(h),
        None    => return Vec::new(),
    };
    let tails = TOOLKIT_ROOTS.iter()
        .filter(|k| kits.iter().any(|n| n == k.kit))
        .map(|k| home.join(k.tail))
        .collect::<Vec<_>>();
    if tails.is_empty() {
        return Vec::new();
    }
    let mut gone = Vec::new();
    for roots in [&mut fence.rw, &mut fence.ro] {
        roots.retain(|r| {
            let p = resolve(r);
            // Under a toolkit tail AND not there. Either half alone keeps it: a
            // workspace root that is missing still refuses, and a toolchain
            // folder that exists is granted as before.
            if tails.iter().any(|t| under(&p, t)) && !p.exists() {
                gone.push(fmt!("{}", r));
                return false;
            }
            true
        });
    }
    gone
}

// ┌───────────────────────────────────────────────────────────────┐
// │ The credential scanner a fence switches off in silence         │
// └───────────────────────────────────────────────────────────────┘
//
// `core.hooksPath` names the directory git runs `pre-commit` from, and on the machine this
// was written on it names a credential scanner -- added after a live key reached a public
// repository and was used by somebody else nine days later.
//
// A fenced git loses that hook in either of two ways, and only one of them is loud.
//
//   * **The hooks directory is unreachable but git knows where it is.**  Git tries to run
//     the hook, `execve` answers EACCES, and the commit fails with `cannot exec ...
//     Permission denied`.  Loud, and already fail-closed.
//   * **Git cannot read the configuration that names it.**  Nothing grants `~/.gitconfig`
//     unless the user ticked the Git toolkit, and git needs no toolkit to commit -- so the
//     ordinary case is a git that never learns `core.hooksPath` exists, looks in
//     `.git/hooks`, finds nothing, and commits.  Exit 0, no message, no scanner.  Measured
//     2026-08-24: a fenced commit put AWS's published example key into a repository one
//     after the same hook had refused the same bytes outside the fence.
//
// The second is the one this section closes, and the shape of the answer is the shape of
// the fault: what is missing is the CONFIGURATION, so what is checked is whether git will
// be able to read it.  The hand can always read it -- the hand is not fenced -- so it reads
// the user's own global configuration itself and then asks the plan whether the fenced git
// could have.
//
// Two halves, closing different failures.  [`grant_git_hooks`] puts the hooks directory
// into the fence read-only, which carries execute, so a Diamond that granted the Git
// toolchain runs the hook -- the normal case working.  [`git_hooks_refusal`] refuses a
// commit that would run without it, naming what is missing -- an unreachable hook made
// loud instead of invisible.  A refusal costs one call; the silence costs a credential.
//
// # Only the user's own GLOBAL value is read, and that is the security of it
//
// A repository's `.git/config` is inside the fence and a command can write it, so a
// `core.hooksPath` read from there would let a turn choose which directory the fence lends
// it: `~/.ssh` is an exfiltration path, and an empty folder in the workspace is the scanner
// disabled without a word.  So the grant follows the user's own configuration and nothing
// else, and a repository that overrides it is refused by name rather than obeyed.

/// The git verbs that run a hook the user could be relying on.
///
/// `push` is absent on purpose: a Daimond push runs with `core.hooksPath` pointed at a
/// denied directory deliberately, so that a `pre-push` script in a repository a model can
/// write does not run with a credential in its environment.  That decision is argued where
/// it is made, in `src/tools.rs` beside `PushCred::git_env`.
const HOOKED_VERBS: &[&str] = &[
    "commit",
    "merge",
    "rebase",
    "am",
    "cherry-pick",
    "revert",
];

/// Where the user's own global configuration says hooks live, and which file said so.
///
/// Asked of git rather than parsed out of `~/.gitconfig`, because `include.path` and
/// `includeIf` mean the file is not the answer -- and a parser that missed one of those
/// would report "no hooks configured" for a machine that has them, which is the silence
/// this whole section exists to end.
///
/// Read with the HAND's environment and not the command's.  The command's environment
/// arrives from the page, and a `HOME` chosen there would decide which configuration counts
/// as the user's own.
///
/// # Arguments
/// * `env` - Overrides laid over the hand's own environment.  Empty in the hand; a test
///   passes `GIT_CONFIG_GLOBAL` so that it never touches the real configuration.
///
/// # Returns
/// The hooks directory and the configuration file naming it, both resolved, or `None`
/// where the user configured none or named somewhere that is not there -- in which case
/// there is no hook to lose, fenced or not.
fn user_hooks_dir(env: &[(String, String)]) -> Option<(PathBuf, PathBuf)> {
    let out = git_config_read(env, None, &["--global", "--show-origin"])?;
    let (origin, value) = out.split_once('\t')?;
    let file = PathBuf::from(origin.strip_prefix("file:")?).canonicalize().ok()?;
    let dir  = hooks_dir_of(value, None, env)?;
    Some((dir, file))
}

/// What `core.hooksPath` reads as, or `None` where it is unset and where git failed.
///
/// # Arguments
/// * `env` - Overrides laid over the hand's own environment.
/// * `cwd` - Where to ask from, which decides whether a repository's own configuration is
///   in the answer.  `None` asks from wherever the hand is.
/// * `flags` - Extra arguments to `git config`, before `--get`.
fn git_config_read(
    env:   &[(String, String)],
    cwd:   Option<&Path>,
    flags: &[&str],
)
    -> Option<String>
{
    let mut cmd = std::process::Command::new("git");
    cmd.arg("config").args(flags).args(["--get", "core.hooksPath"]);
    if let Some(d) = cwd {
        cmd.current_dir(d);
    }
    for (k, v) in env {
        cmd.env(k, v);
    }
    // A prompt here would hang the hand rather than fail. `config --get` should never ask,
    // and this makes sure of it.
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim_end_matches('\n').to_string();
    if s.trim().is_empty() { None } else { Some(s) }
}

/// The directory a `core.hooksPath` value names on this machine, if it is one.
///
/// A value naming somewhere that is not there is not a fence problem: git would run no hook
/// with or without a fence, so there is nothing here to lose and nothing to refuse.
///
/// # Arguments
/// * `value` - What git said.
/// * `cwd` - What a relative value is relative to, which is git's own rule: the directory
///   the hooks are run from, meaning the top of the working tree.
/// * `env` - Where `HOME` comes from, for a value written with a leading `~`.
fn hooks_dir_of(value: &str, cwd: Option<&Path>, env: &[(String, String)]) -> Option<PathBuf> {
    let v = value.trim();
    if v.is_empty() {
        return None;
    }
    let home = env.iter().find(|(k, _)| k == "HOME").map(|(_, v)| v.clone())
        .or_else(home_dir);
    let raw = if v == "~" {
        PathBuf::from(home?)
    } else if let Some(rest) = v.strip_prefix("~/") {
        PathBuf::from(home?).join(rest)
    } else {
        let p = PathBuf::from(v);
        if p.is_absolute() { p } else { cwd?.join(p) }
    };
    let real = raw.canonicalize().ok()?;
    if real.is_dir() { Some(real) } else { None }
}

/// Puts the user's own hooks directory into the fence, read-only.
///
/// Read-only and never writable, for the reason every other configuration grant is:
/// a hooks directory a command can write is a directory that decides what runs on the
/// user's next commit, in their own shell, outside all of this.  A read-only grant carries
/// execute, which is what a hook needs.
///
/// Called after [`vet_roots`], which checks that the roots the PAGE named are ones its
/// grant could have produced.  This root is not one of those: it is read here, on the
/// machine, from configuration the model cannot reach and the page cannot see.
///
/// # Arguments
/// * `fence` - The fence as it arrived; the directory is added to its read-only roots.
/// * `kits` - The toolkit names the request carried.  Nothing happens without `git`,
///   because without it the fenced git cannot read `~/.gitconfig` either, and a hooks
///   directory git will never be told about is a widening that buys nothing.
/// * `env` - Overrides for reading the user's configuration; empty in the hand.
///
/// # Returns
/// The directory added, so a caller that wants to say so can.
pub fn grant_git_hooks(
    fence:  &mut FenceSpec,
    kits:   &[String],
    env:    &[(String, String)],
)
    -> Option<PathBuf>
{
    if !kits.iter().any(|k| k == "git") {
        return None;
    }
    let (dir, _) = user_hooks_dir(env)?;
    // A denial is a decision somebody made, and widening one from here would be the fence
    // quietly disagreeing with it. `.config/oxedyne` is denied to every toolkit on purpose.
    if fence.deny.iter().any(|d| under(&dir, &resolve(d))) {
        return None;
    }
    if fence.rw.iter().chain(fence.ro.iter()).any(|r| under(&dir, &resolve(r))) {
        return None;
    }
    fence.ro.push(fmt!("{}", dir.display()));
    Some(dir)
}

/// Refuses a git command whose hooks would not run, naming what is missing.
///
/// The fail-closed half, and the one that catches the silent case: git needs no toolkit to
/// commit, so the ordinary fenced commit is one that cannot read `~/.gitconfig`, never
/// learns `core.hooksPath` exists, and commits with no scanner and no message.
///
/// Three ways that happens, and each gets its own sentence, because the fix for each is
/// different:
///
///   * the configuration naming the hooks is outside the fence -- grant the Git toolchain;
///   * the hooks directory is outside the fence -- attach it read-only;
///   * the repository's own `.git/config`, which is inside the fence and which a command can
///     write, points `core.hooksPath` somewhere else.
///
/// # What this does not reach
///
/// Only a command whose `argv[0]` is git is checked, so `sh -c 'git commit'` is not.  With
/// the Git toolchain granted that spelling is covered anyway, because [`grant_git_hooks`]
/// puts the directory in the fence and git reads its own configuration; without it, a
/// shell-wrapped commit still runs unscanned.  Written down rather than papered over: the
/// honest boundary of this guard is the command it can see.
///
/// And it fails OPEN where the hand cannot run `git config` at all -- no git on the hand's
/// own `PATH`, or a `git config` that exits non-zero -- because it then cannot tell a
/// machine with no `core.hooksPath` from a machine it could not ask.  Refusing both would
/// refuse every commit on every ordinary machine, which is a guard nobody would keep.  The
/// case is narrow: a hand that cannot find git is a hand whose fenced git will not run
/// either.
///
/// # Arguments
/// * `plan` - The fence as it will be enforced, which is the only honest thing to ask
///   "could git have read this" of.
/// * `argv` - The command.
/// * `cwd` - Where it will run, which decides which repository's configuration is in play.
/// * `env` - Overrides for reading the user's configuration; empty in the hand.
pub fn git_hooks_refusal(
    plan:   &Plan,
    argv:   &[String],
    cwd:    &str,
    env:    &[(String, String)],
)
    -> Option<String>
{
    let prog = argv.first()?;
    if Path::new(prog).file_name().map(|n| n != "git").unwrap_or(true) {
        return None;
    }
    // The verb is the first argument that is not an option. `git -C x commit` takes an
    // argument after `-C`, so a lone `-C` swallows the next word rather than the verb.
    let mut verb: Option<&str> = None;
    let mut skip = false;
    for a in argv.iter().skip(1) {
        if skip { skip = false; continue; }
        if a == "-C" || a == "-c" || a == "--git-dir" || a == "--work-tree" {
            skip = true;
            continue;
        }
        if a.starts_with('-') { continue; }
        verb = Some(a.as_str());
        break;
    }
    if !HOOKED_VERBS.contains(&verb?) {
        return None;
    }
    // Nothing configured is nothing to lose: git's own default is `.git/hooks`, inside the
    // repository, inside the folder the fence was built around.
    let (want, from) = user_hooks_dir(env)?;
    if !plan.permits(&from, Level::Ro) {
        return Some(fmt!(
            "Refused: this would commit without the hooks the user configured. Their git \
            configuration at {} points core.hooksPath at {}, and this command's fence does \
            not reach that configuration -- so git would never learn the directory exists, \
            would look in .git/hooks, would find nothing, and would commit. That is how a \
            credential-scanning pre-commit hook stops running without saying so, which is \
            why this is refused rather than run. Grant this Diamond the Git toolchain, \
            which lends git the user's own configuration, and ask again.",
            from.display(), want.display()));
    }
    if !plan.permits(&want, Level::Ro) {
        return Some(fmt!(
            "Refused: git would run its hooks from {}, and this command's fence does not \
            reach it. Attach that directory to the Diamond read-only -- a read-only grant \
            carries execute, which is what a hook needs -- or take core.hooksPath out of \
            the git configuration if the hooks are not wanted.", want.display()));
    }
    let here = Path::new(cwd);
    let effective = git_config_read(env, Some(here), &[])
        .and_then(|v| hooks_dir_of(&v, Some(here), env));
    if effective.as_deref() != Some(want.as_path()) {
        return Some(fmt!(
            "Refused: this repository's own configuration points core.hooksPath at {}, and \
            the user's points it at {}. A repository's .git/config is inside the fence and \
            a command can write it, so a hooks directory named there is one this turn chose \
            -- and choosing an empty one is how the credential-scanning pre-commit hook \
            stops running without saying so. Take core.hooksPath out of .git/config.",
            effective.map(|p| fmt!("{}", p.display())).unwrap_or_else(|| fmt!("nothing")),
            want.display()));
    }
    None
}

/// Checks a working directory against a fence, in the app's own refusing voice.
///
/// Symbolic links are resolved before the comparison, because a link inside the
/// fence pointing out of it is otherwise a way past the whole arrangement.
///
/// # Arguments
/// * `cwd` - The absolute working directory the caller asked for.
/// * `fence` - What the command may touch.
pub(crate) fn vet_cwd(cwd: &str, fence: &FenceSpec) -> Vetted {
    let raw = Path::new(cwd);
    if !raw.is_absolute() {
        return Vetted::Refused(fmt!(
            "Refused: '{}' is not an absolute path, and the hand does not guess what it is \
            relative to. Give the working directory in full.", cwd));
    }
    if fence.rw.is_empty() && fence.ro.is_empty() {
        return Vetted::Refused(fmt!(
            "Refused: this command arrived with an empty fence, which grants nothing at all. Name \
            the roots it may work under before asking for it to run."));
    }
    // Counting roots is not the same as having any. A root of "" is a root the
    // guard above counts and that every containment test then answers `true`
    // for, so `FenceSpec{rw:[""]}` ran a command in /etc/ssh and reported
    // success. The roots are therefore checked for meaning, not for presence.
    for (which, roots) in [("rw", &fence.rw), ("ro", &fence.ro), ("deny", &fence.deny)] {
        for r in roots.iter() {
            if r.is_empty() {
                return Vetted::Refused(fmt!(
                    "Refused: this command's fence lists an empty path among its '{}' roots. An \
                    empty root is not a root: every path on the machine sits under it, so a fence \
                    holding one grants everything. Name the directory in full.", which));
            }
            if !Path::new(r).is_absolute() {
                return Vetted::Refused(fmt!(
                    "Refused: this command's fence lists '{}' among its '{}' roots, which is not \
                    an absolute path. The hand does not guess what a fence root is relative to; \
                    whatever resolved the workspace should send the result.", r, which));
            }
        }
    }

    let dir = match std::fs::canonicalize(raw) {
        Ok(p)  => p,
        Err(_) => return Vetted::Refused(fmt!(
            "Refused: '{}' cannot be resolved to a directory on this machine. A command's working \
            directory has to exist before it can run in it.", cwd)),
    };
    // A FILE RESOLVES PERFECTLY WELL, and every check below it passes: it is absolute, it exists,
    // and it sits inside the fence. The failure then surfaces at the spawn as `Os { code: 20,
    // kind: NotADirectory }` wrapped in two error layers, which names no path the caller chose and
    // tells the user nothing they can act on. On 2026-08-26 a terminal opened for a Diamond whose
    // one attachment was `writing_spec.md` produced exactly that.
    //
    // Refused rather than climbed: the parent of a file is a directory the caller did not ask for,
    // and a working directory quietly widened by one level is not a thing a fence should do on its
    // own. The sentence names the folder, so the fix is a copy and paste away.
    if !dir.is_dir() {
        let parent = dir.parent()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|| fmt!("the folder it is in"));
        return Vetted::Refused(fmt!(
            "Refused: '{}' is a file, not a folder, and nothing can be run inside a file. Ask for \
            '{}' instead.", cwd, parent));
    }

    for d in &fence.deny {
        if under(&dir, &resolve(d)) {
            return Vetted::Refused(fmt!(
                "Refused: '{}' is inside '{}', which this command is denied outright. That subtree \
                is fenced off whatever else the fence allows.", cwd, d));
        }
    }

    let inside = fence.rw.iter().chain(fence.ro.iter())
        .any(|r| under(&dir, &resolve(r)));
    if !inside {
        let roots = fence.rw.iter().chain(fence.ro.iter())
            .map(|r| fmt!("'{}'", r))
            .collect::<Vec<_>>()
            .join(", ");
        return Vetted::Refused(fmt!(
            "Refused: '{}' is outside this command's fence, which reaches {} and nowhere else. \
            Run it somewhere inside the fence, or say what you would need and let the user widen \
            it.", cwd, roots));
    }

    Vetted::Ok(dir)
}

/// Resolves the program a caller named and checks it against the fence.
///
/// Three ways in were open and all three are closed here.  An absolute path
/// outside the fence ran, because nothing compared it to anything.
/// `../outside/evil` ran, because a relative program name was handed to `execvp`
/// and resolved against the working directory afterwards.  And a bare name
/// resolved through a `PATH` the *caller* supplied, because the environment
/// `execvp` searches is the child's, which is exactly what the caller writes --
/// and with no `PATH` at all, glibc falls back to `confstr(_CS_PATH)` and finds
/// `/bin:/usr/bin` anyway.
///
/// So the answer is always an absolute, canonical path, checked against the plan
/// before anything is spawned and handed to the launcher already resolved.  The
/// caller's `PATH` still *finds* candidates -- refusing it outright would break
/// every ordinary call -- but finding is not permission, and what it finds is
/// checked like anything else.
///
/// # Arguments
/// * `argv0` - The program as the caller spelled it.
/// * `cwd` - The vetted working directory, for a relative spelling.
/// * `env` - The caller's environment, consulted for `PATH` only.
/// * `plan` - The fence this command will run behind.
pub(crate) fn vet_program(argv0: &str, cwd: &Path, env: &[(String, String)], plan: &Plan) -> Vetted0 {
    if argv0.is_empty() {
        return Vetted0::Refused(fmt!(
            "Refused: the program to run is an empty string. The first element of argv names the \
            program; there is no shell here to turn an empty word into something else."));
    }

    let mut tried = Vec::<PathBuf>::new();
    if argv0.contains('/') {
        let p = Path::new(argv0);
        tried.push(if p.is_absolute() { p.to_path_buf() } else { cwd.join(p) });
    } else {
        let path = match env.iter().find(|(k, _)| k == "PATH") {
            Some((_, v))	=> v.as_str(),
            None			=> PATH_FALLBACK,
        };
        for dir in path.split(':') {
            // A relative or empty `PATH` element means "the working directory"
            // to a shell. It is skipped rather than honoured: a program found
            // that way is chosen by whatever last wrote to the directory the
            // command happens to be sitting in.
            if dir.is_empty() || !Path::new(dir).is_absolute() {
                continue;
            }
            tried.push(Path::new(dir).join(argv0));
        }
    }

    let mut found: Option<PathBuf> = None;
    for cand in &tried {
        let real = match std::fs::canonicalize(cand) {
            Ok(r)  => r,
            Err(_) => continue,
        };
        if !is_runnable(&real) {
            continue;
        }
        found = Some(real);
        break;
    }
    let real = match found {
        Some(r) => r,
        None => return Vetted0::Refused(fmt!(
            "Refused: '{}' is not a program this machine can run. Nothing of that name resolved \
            to an executable file{}.", argv0,
            if argv0.contains('/') {
                fmt!("")
            } else {
                fmt!(" on the PATH this command was given")
            })),
    };

    // Execute is part of the read set in Landlock's vocabulary: a program the
    // fence will not let the command read is a program it will not let it run.
    if !plan.permits(&real, Level::Ro) {
        return Vetted0::Refused(fmt!(
            "Refused: '{}' is the program at {}, which is outside this command's fence. A command \
            cannot run something the fence would not let it read, so it was refused here rather \
            than left to fail with a permission error nobody could interpret.", argv0,
            real.display()));
    }
    Vetted0::Ok(real)
}

/// Whether `p` is a regular file with an execute bit set.
///
/// # Arguments
/// * `p` - An already-canonical path.
fn is_runnable(p: &Path) -> bool {
    let md = match std::fs::metadata(p) {
        Ok(md) => md,
        Err(_) => return false,
    };
    if !md.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        md.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// Brings a caller's wall-clock limit inside what the hand will honour.
///
/// # Arguments
/// * `ms` - The limit asked for; zero means no preference.
fn clamp_timeout(ms: u64) -> u64 {
    if ms == 0 {
        DEFAULT_TIMEOUT_MS
    } else {
        std::cmp::min(ms, TIMEOUT_MAX_MS)
    }
}

// ┌───────────────────────────────────────────────────────────────┐
// │ The launcher                                                   │
// └───────────────────────────────────────────────────────────────┘

/// What the launcher does once the fence is in force.
///
/// **The fence is applied before this is looked at, and that is the point.**  A file op run
/// any other way would be a second compartment to keep in step with the first; run here it
/// is the same Landlock ruleset and the same seccomp filter as a command's, built from the
/// same [`Plan`], in a child of the same launcher.  A path the fence does not reach fails
/// with the kernel's own refusal.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Act {
    /// Become the command.
    Exec,
    /// Carry out one file operation and answer on standard output.
    File(FileOp),
}

/// Everything the launcher is told, and everything it is allowed to decide.
///
/// It decides nothing.  The program is already resolved, the fence is already
/// planned, and the environment is already screened; the launcher's whole job is
/// to put the fence on itself and become the command.  That is deliberate:
/// every judgement is made where a failure can still be turned into a sentence
/// the page shows, and none is made in a process whose only remaining move is to
/// die.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Payload {
    /// The program, absolute and canonical, already checked against the fence.
    pub prog: PathBuf,
    /// The argument vector as the caller wrote it.
    pub argv: Vec<String>,
    /// The command's environment, in full.
    pub env:  Vec<(String, String)>,
    /// The fence to apply before the command exists.
    pub plan: Plan,
    /// What to do once the fence is on.
    ///
    /// Two arms and not a flag, because they are not two shapes of one thing: [`Act::Exec`]
    /// ends in `execve` and never returns, and [`Act::File`] ends in a write to standard
    /// output and an exit.  What they share is everything above them -- the same plan, the
    /// same ruleset, the same filter, applied in the same order -- and that sharing is the
    /// whole guarantee the file door rests on.
    pub act:  Act,
    /// Whether this command is to have a controlling terminal.
    ///
    /// A terminal is adopted BEFORE the fence, because Landlock's ABI 5 governs `ioctl` on a
    /// device opened after the ruleset is in force -- and `TIOCSCTTY` is exactly that ioctl.
    /// Ordered the other way, a session would fence itself out of its own terminal.
    pub tty:  bool,
}

/// Becomes the command, behind its fence, and never returns.
///
/// `main` dispatches here on [`LAUNCH_ARG`], as its first act and before any
/// runtime is started.  The signature says `!` on purpose: there is no way to
/// call this and carry on, so there is no way for a later edit to reach the
/// spawn path with the fence half-applied.  **Failing open is the one outcome
/// that must be impossible here**, and the type system is a better guarantee of
/// that than a comment.
///
/// The order matters and is not negotiable: read the plan, apply the plan, then
/// `exec`.  Anything that goes wrong before the `exec` exits non-zero without
/// exec'ing; nothing runs behind half a fence.
pub fn launch_main() -> ! {
    #[cfg(unix)]
    {
        let (code, why) = launch_inner();
        // Standard error is the command's own, so this reaches the page as the
        // run's stderr -- unless the caller asked for `Capture::None` or
        // `Capture::Out`, in which case the exit code is the whole of the
        // answer. That is why the codes are distinct and documented.
        eprintln!("daimond-hand launcher: {}", why);
        std::process::exit(code)
    }
    #[cfg(not(unix))]
    {
        eprintln!(
            "daimond-hand launcher: this platform has no exec, so a fence \
            cannot be applied to a command by becoming it. Nothing was run.");
        std::process::exit(EXIT_FENCE_FAILED)
    }
}

/// The launcher's body, which returns only when something has gone wrong.
///
/// # Returns
/// The exit code to use and the sentence explaining it.
#[cfg(unix)]
fn launch_inner() -> (i32, String) {
    use std::os::unix::process::CommandExt;

    let mut payload = match read_payload() {
        Ok(p)  => p,
        Err(e) => return (EXIT_NO_PLAN, fmt!(
            "no usable plan arrived on standard input, so there is no fence to \
            apply and nothing was run. {}", e.msgs().join(" "))),
    };

    // A launcher always wants every thread. It has none of its own, but a
    // runtime started before the dispatch might, and a fence binding only the
    // calling thread would leave a sibling able to fork and exec outside it.
    payload.plan.reach = Reach::Process;

    // The last gate, and the cheapest. The hand screened this already; the
    // launcher is the one place where being wrong is unrecoverable.
    if let Some(s) = screen_env(&payload.env) {
        return (EXIT_FENCE_FAILED, s);
    }

    // The terminal is adopted BEFORE the fence, and the order is not a preference.
    // Landlock's ABI 5 governs `ioctl` on a device file opened after the ruleset is in
    // force, and `TIOCSCTTY` is exactly that ioctl -- so a session that fenced first would
    // fence itself out of its own terminal, and fail in a way that reads like a pty bug.
    let mut tty_in: Option<std::process::Stdio> = None;
    if payload.tty {
        match crate::pty::adopt_terminal() {
            Ok(s)  => tty_in = Some(s),
            Err(e) => return (EXIT_FENCE_FAILED, fmt!(
                "the terminal could not be adopted, so the command was not run. {}",
                e.msgs().join(" "))),
        }
    }

    let applied = match payload.plan.apply() {
        Ok(a)  => a,
        Err(e) => return (EXIT_FENCE_FAILED, fmt!(
            "the fence could not be applied, so the command was not run. {}",
            e.msgs().join(" "))),
    };
    if !applied.fenced && applied.waiver.is_none() {
        return (EXIT_FENCE_FAILED, fmt!(
            "the fence reported that it was not applied and no waiver was \
            recorded. The command was not run."));
    }

    // The system-call filter, and its place in the order is the whole of this comment.
    //
    // Three things have to happen before the `exec` and they cannot be reordered:
    //
    // 1. **The terminal, first.** Landlock's ABI 5 governs `ioctl` on a device file
    //    opened after the ruleset is in force, and `TIOCSCTTY` is exactly that ioctl.
    // 2. **The fence, second.** Applying it *opens every granted path* -- `PathFd` per
    //    rule -- so Landlock still has real work to do after its own rules take hold. A
    //    filter installed underneath that work would, if its deny-list ever named
    //    something the `landlock` crate needed, break the fence rather than the command:
    //    the wrong failure, in the wrong layer, for a reason nobody could read.
    // 3. **The filter, last.** It needs nothing after itself except `execve`, which it
    //    permits. Being last also means it is the layer nearest the command, so the last
    //    thing to happen before the command exists is the narrowest.
    //
    // Both restrictions are irreversible and both survive `execve`, so the order is not
    // about undoing anything -- it is about what each still needs to do after it is
    // installed. Both also require `no_new_privs`; `Plan::apply` sets it and hard-errors,
    // and `Filter::apply` sets it again rather than assuming, since it is idempotent.
    let spec = SysSpec::for_command();
    let filter = match Seccomp::detect().plan(&spec) {
        Ok(f)  => f,
        Err(e) => return (EXIT_FENCE_FAILED, fmt!(
            "the system-call filter could not be built, so the command was not run. \
            Without it the fence is not a compartment on this kernel. {}",
            e.msgs().join(" "))),
    };
    if let Err(e) = filter.apply() {
        return (EXIT_FENCE_FAILED, fmt!(
            "the system-call filter could not be installed, so the command was not \
            run. {}", e.msgs().join(" ")));
    }

    // The file door, and it is HERE and not one line earlier for the one reason this
    // whole arrangement exists: everything above has already happened to this process --
    // the ruleset is on, the filter is on, `no_new_privs` is set -- so the `open` below is
    // governed by exactly the rules the command on the other branch would have met. There
    // is no second check and there is deliberately nowhere to put one.
    if let Act::File(op) = &payload.act {
        let (ok, text) = do_file(op);
        // A byte and then the bytes. No JSON, nothing escaped, nothing to parse wrongly:
        // the parent reads this and the text may be anything a file holds, including the
        // quotes and backslashes an encoding would have had to survive. That is the same
        // sentence the request is built on, one layer down.
        let mut out: Vec<u8> = Vec::with_capacity(text.len() + 1);
        out.push(u8::from(ok));
        out.extend_from_slice(text.as_bytes());
        use std::io::Write;
        let mut sink = std::io::stdout();
        if sink.write_all(&out).is_err() || sink.flush().is_err() {
            return (EXIT_EXEC_FAILED, fmt!(
                "the fence was applied, the file operation was carried out and its answer \
                could not be written back. Do not assume nothing changed."));
        }
        std::process::exit(0)
    }

    let mut cmd = std::process::Command::new(&payload.prog);
    // Exec the RESOLVED binary, but under the name the caller asked for.
    //
    // A multi-call binary decides what it is from `argv[0]`: `~/.cargo/bin/cargo` is a
    // symlink to `rustup`, and busybox is a dozen tools in one file. Exec'ing the resolved
    // path with the resolved name told rustup it had been invoked AS rustup, so
    // `cargo test --offline` came back "unexpected argument '--offline'" from a usage
    // message for a different program. A shell preserves the requested name; so does this.
    //
    // `arg0` is safe -- it is `CommandExt`, not `pre_exec` -- so the rule against `unsafe`
    // costs nothing here.
    if let Some(asked) = payload.argv.first() {
        cmd.arg0(asked);
    }
    cmd.args(payload.argv.iter().skip(1));
    // An allow-list, not an inheritance. The launcher's own environment holds
    // nothing worth keeping; the command's arrived down the pipe.
    cmd.env_clear();
    for (k, v) in &payload.env {
        cmd.env(k, v);
    }
    // Standard input is left as it is: the plan was read from it and the
    // command's own input, if any, is the remainder of the same pipe. Where the
    // caller sent none the write end is already closed, so the first read
    // answers end-of-file.
    //
    // A terminal session is the exception: its input is the terminal, not the pipe the
    // plan arrived down, so the adopted tty replaces stdin here.
    if let Some(s) = tty_in {
        cmd.stdin(s);
    }

    // `exec` returns only on failure.
    let e = cmd.exec();
    (EXIT_EXEC_FAILED, fmt!(
        "the fence was applied and then {} could not be started ({}). Nothing \
        ran behind the fence.", payload.prog.display(), e))
}

// ── The file operations themselves, run behind the fence ────────────
//
// Everything in this section executes in the launcher, AFTER `Plan::apply` and after the
// seccomp filter, and it is written on the assumption that the kernel is the guard. There
// is no path check here beyond "is it absolute", on purpose: a check written here would be
// a second opinion about what the fence allows, it would drift from the first, and the day
// it disagreed the laxer of the two would be the one that ran. What this code does with a
// path the fence does not reach is exactly what any other program does -- it gets EACCES
// from `open` -- and the only value added is that the sentence says so in words.

/// What the launcher answers a [`FileOp`] with: whether it was done, and what to say.
///
/// # Arguments
/// * `op` - The operation, whose paths must all be absolute.
#[cfg(unix)]
fn do_file(op: &FileOp) -> (bool, String) {
    // EVERY path, not the first. A walk names several and an empty list names none, and both
    // were reachable before `paths()` existed.
    let named = op.paths();
    if named.is_empty() {
        return (false, fmt!("A {} was asked for with no path to work on.", op.word()));
    }
    for p in named {
        if !Path::new(p).is_absolute() {
            return (false, fmt!(
                "'{}' is not an absolute path, and the hand does not guess what a path is \
                relative to.", p));
        }
    }
    match op {
        FileOp::Read { path, offset, limit } => read_op(path, *offset, *limit),
        FileOp::Write { path, content }      => write_op(path, content),
        FileOp::Edit { path, old, new }      => edit_op(path, old, new),
        FileOp::Move { path, to }            => move_op(path, to),
        FileOp::List { path }                => list_op(path),
        FileOp::MkDir { path }               => mkdir_op(path),
        FileOp::Search { paths, query, ci, glob, base, skip, budget, cap } =>
            search_op(paths, query, *ci, glob, base, skip, *budget as usize, *cap as u64),
        FileOp::Glob { paths, pattern, base, skip, budget } =>
            glob_op(paths, pattern, base, skip, *budget as usize),
    }
}

/// What one filesystem error means, in the words the model has to act on.
///
/// **A refusal and an absence are different answers and only one of them is true.**  A path
/// the fence does not reach comes back from the kernel as `PermissionDenied`, which read
/// bare says nothing about the fence at all -- and a model that reads it as "the file is
/// protected" goes looking for `chmod` instead of asking the user to mark the folder in.
///
/// # Arguments
/// * `what` - The verb, for the opening clause.
/// * `path` - The path as the caller wrote it.
/// * `e` - What the operating system said.
#[cfg(unix)]
fn fs_said(what: &str, path: &str, e: &std::io::Error) -> String {
    match e.kind() {
        std::io::ErrorKind::PermissionDenied => fmt!(
            "The kernel refused to let this turn {} '{}'. That is the fence, not the file's \
            own permissions: a file tool reaches exactly the folders a command reaches, and \
            this path is outside them. Ask the user to mark the folder in.", what, path),
        std::io::ErrorKind::NotFound => fmt!(
            "There is no '{}' on this machine.", path),
        // A DIRECTORY, SAID AS A DIRECTORY. The browser-storage arm of `file_read` has named
        // `file_list` here since 2026-08-24, when a daimon spent three calls working out what
        // the browser's `TypeMismatchError` meant; the machine arm answered `Is a directory
        // (os error 21)` on its first measured run, 2026-08-25, and cost a call to the same
        // question. The two doors say the same sentence or they are two doors.
        std::io::ErrorKind::IsADirectory => fmt!(
            "'{}' is a directory, not a file. file_list answers what is in it, and \
            file_search looks inside everything under it.", path),
        _ => fmt!("Could not {} '{}': {}.", what, path, e),
    }
}

/// The text of a file, or the sentence saying why not.
///
/// The answer is three tab-separated numbers, a newline, and then the lines asked for: the
/// lines the WHOLE file holds, the whole file's length in bytes, and how many lines follow
/// here.  A private convention between two halves of one binary, and it exists because the
/// caller pages a read and cannot say "lines 40-60 of 812" without being told the 812 by
/// whoever held the whole file.
///
/// **The third number is `dev/BLOCKERS.md` B18.**  The answer used to carry the line count
/// alone and then be cut to [`FILE_TEXT_MAX`] as one string, so a caller that asked for a
/// 1.2 MB file was handed 512 KiB of it and counted the cut: `src/tools.rs` read as 9,304
/// lines of 21,276, with the offset to continue from twelve thousand lines short of the end.
/// Cutting on a line boundary and SAYING how many lines went is what makes the caller's
/// arithmetic about the rest come out right.
///
/// # Arguments
/// * `offset` - The 1-based line to start at; 0 is read as 1.
/// * `limit` - How many lines to take; 0 means every line from `offset`.
#[cfg(unix)]
fn read_op(path: &str, offset: u32, limit: u32) -> (bool, String) {
    let bytes = match std::fs::read(path) {
        Ok(b)  => b,
        Err(e) => return (false, fs_said("read", path, &e)),
    };
    let text = String::from_utf8_lossy(&bytes).to_string();
    let lines: Vec<&str> = text.split('\n').collect();
    // A file ending in a newline splits to a final empty piece that is not a line, and an
    // empty file splits to one such piece and holds no lines at all.
    let total = match lines.last() {
        Some(&"") if lines.len() > 1 => lines.len() - 1,
        Some(&"")                    => 0,
        _                            => lines.len(),
    };
    let from = (offset.max(1) as usize) - 1;
    let take = match limit {
        0 => total.saturating_sub(from),
        n => n as usize,
    };
    let mut sent = String::new();
    let mut kept = 0usize;
    for line in lines.iter().skip(from).take(take) {
        // The newline that ends it, counted before it is spent, so the frame's ceiling is a
        // ceiling on what is actually built.
        if sent.len() + line.len() + 1 > FILE_TEXT_MAX {
            break;
        }
        sent.push_str(line);
        // EVERY line ends with one, the last of them included. Joining with newlines instead
        // makes "a\n" mean either one line or two -- and a window whose last line is blank is
        // then one line shorter than it says it is, which the caller checks and refuses.
        sent.push('\n');
        kept += 1;
    }
    // ONE LINE LONGER THAN THE WHOLE FRAME, which the loop above would answer with nothing at
    // all.  A cut line is worth more than an empty answer, so it goes with the marker that
    // says it is cut -- and it is the only place the hand puts words of its own among a
    // file's characters.
    if kept == 0 && from < total {
        let line = lines[from];
        let mut end = FILE_TEXT_MAX.min(line.len());
        while end > 0 && !line.is_char_boundary(end) {
            end -= 1;
        }
        sent.push_str(&line[..end]);
        sent.push_str(&fmt!(
            " …[{} further bytes on this line were not returned]\n", line.len() - end));
        kept = 1;
    }
    let mut out = fmt!("{}\t{}\t{}\n", total, bytes.len(), kept);
    out.push_str(&sent);
    (true, out)
}

/// The whole of `path` replaced by `content`, with any parent it needs made first.
#[cfg(unix)]
fn write_op(path: &str, content: &str) -> (bool, String) {
    if let Some(dir) = Path::new(path).parent() {
        if let Err(e) = std::fs::create_dir_all(dir) {
            return (false, fs_said("write", path, &e));
        }
    }
    match std::fs::write(path, content.as_bytes()) {
        Ok(())  => (true, String::new()),
        Err(e)  => (false, fs_said("write", path, &e)),
    }
}

/// `old` replaced by `new` in `path`, exactly once.
///
/// The count is the answer on both failures, because "which of my six edits landed" is the
/// question a caller cannot ask afterwards and the one that cost 71 calls.
#[cfg(unix)]
fn edit_op(path: &str, old: &str, new: &str) -> (bool, String) {
    let bytes = match std::fs::read(path) {
        Ok(b)  => b,
        Err(e) => return (false, fs_said("edit", path, &e)),
    };
    let data = match String::from_utf8(bytes) {
        Ok(t)  => t,
        Err(_) => return (false, fmt!(
            "'{}' is not UTF-8 text, so replacing a string in it would rewrite the bytes it \
            is not made of. Nothing was changed.", path)),
    };
    let count = data.matches(old).count();
    if count == 0 {
        return (false, fmt!("old_string was not found in '{}'. Nothing was changed.{}",
            path, near_miss(&data, old)));
    }
    if count > 1 {
        return (false, fmt!(
            "old_string appears {} times in '{}'; make it unique. Nothing was changed.",
            count, path));
    }
    let updated = data.replacen(old, new, 1);
    match std::fs::write(path, updated.as_bytes()) {
        Ok(())  => (true, String::new()),
        Err(e)  => (false, fs_said("edit", path, &e)),
    }
}

/// Where a failed `old_string` nearly matched, as the lines to copy instead.
///
/// **"Not found" says what is not there and nothing about what is, and a caller that
/// mistyped one character has no way to converge.** Measured on the second live run of this
/// door, 2026-08-25: a daimon building an `old_string` out of a `sed -n` slice wrote a
/// straight `"` where `de.js` has a typographic one, met "was not found" four times,
/// concluded the tool did not work, and went back to `sed -i` -- where it spent the next
/// forty-eight calls on French quoting, which is the very failure `dev/BLOCKERS.md` B2 is
/// measured on. The refusal was honest and it was a dead end.
///
/// So the LONGEST PREFIX of `old_string` that is in the file is found, and the answer is
/// where it is and what the file actually holds from that line -- which is the text to copy,
/// exactly, with nothing to guess at. A prefix and not the first line, because the character
/// that was got wrong is as often in the first line as anywhere; the German quote that
/// started this was.
///
/// Binary search is sound here and worth saying why: a prefix of length k is present only if
/// every shorter prefix is, since each is a prefix of it, so presence is monotone in k.
///
/// # Arguments
/// * `data` - The file's whole text.
/// * `old` - The string that was not found.
#[cfg(unix)]
fn near_miss(data: &str, old: &str) -> String {
    // Below this a "near miss" is a coincidence: any file holds a tab and a quote somewhere,
    // and pointing at one would be worse than saying nothing.
    const LEAST: usize = 12;

    let bytes = old.as_bytes();
    let (mut lo, mut hi) = (0usize, bytes.len());
    while lo < hi {
        let mid = (lo + hi + 1) / 2;
        let mut k = mid;
        while k > 0 && !old.is_char_boundary(k) {
            k -= 1;
        }
        if k <= lo {
            break;
        }
        if data.contains(&old[..k]) { lo = k; } else { hi = k - 1; }
    }
    if lo < LEAST {
        return fmt!(
            " No part of it is in the file, so this is not a near miss: read the file and \
            copy the text from what the read returns.");
    }
    let at = match data.find(&old[..lo]) {
        Some(i) => i,
        None    => return String::new(),	// unreachable while `lo` came from `contains`
    };
    let line = data[..at].matches('\n').count() + 1;
    let want = old.split('\n').count().max(1) + 1;
    let shown: Vec<String> = data.split('\n').skip(line - 1).take(want)
        .enumerate()
        .map(|(i, t)| fmt!("{}\t{}", line + i, t))
        .collect();
    fmt!(
        " Its first {} characters ARE there, at line {}, and it stops matching after them. \
        The file holds this from that line, which is the text to copy exactly:\n{}",
        lo, line, shown.join("\n"))
}

/// `path` renamed to `to`, which must not already be something.
#[cfg(unix)]
fn move_op(path: &str, to: &str) -> (bool, String) {
    if !Path::new(to).is_absolute() {
        return (false, fmt!(
            "'{}' is not an absolute path, and the hand does not guess what a path is \
            relative to.", to));
    }
    if Path::new(to).symlink_metadata().is_ok() {
        return (false, fmt!("'{}' already exists; nothing was moved.", to));
    }
    if let Some(dir) = Path::new(to).parent() {
        if let Err(e) = std::fs::create_dir_all(dir) {
            return (false, fs_said("move", to, &e));
        }
    }
    match std::fs::rename(path, to) {
        Ok(())  => (true, String::new()),
        Err(e)  => (false, fs_said("move", path, &e)),
    }
}

/// What is in the directory `path`, one entry a line, a directory marked with a slash.
///
/// A listing too big for one frame stops on a whole name and says how many of the directory's
/// entries it is showing.  It used to be cut as one string with the note *"ask for the rest by
/// line range"*, which is `read`'s advice: `list` takes no range, and a caller acting on that
/// sentence has nowhere to go.
#[cfg(unix)]
fn list_op(path: &str) -> (bool, String) {
    let rd = match std::fs::read_dir(path) {
        Ok(r)  => r,
        Err(e) => return (false, fs_said("list", path, &e)),
    };
    let mut names: Vec<String> = Vec::new();
    for ent in rd {
        let ent = match ent {
            Ok(e)  => e,
            Err(e) => return (false, fs_said("list", path, &e)),
        };
        let name = ent.file_name().to_string_lossy().to_string();
        let dir = matches!(ent.file_type(), Ok(t) if t.is_dir());
        names.push(match dir {
            true  => fmt!("{}/", name),
            false => name,
        });
    }
    names.sort();
    let total = names.len();
    let mut out = String::new();
    let mut shown = 0usize;
    for name in &names {
        if out.len() + name.len() + 1 > FILE_TEXT_MAX {
            break;
        }
        if shown > 0 {
            out.push('\n');
        }
        out.push_str(name);
        shown += 1;
    }
    if shown < total {
        out.push_str(&fmt!(
            "\n[file_list] {} of {} entries; the rest would not fit in one message. A listing \
            takes no range to page it with, so name what is wanted instead: file_glob with a \
            pattern under this directory answers the same question for a fraction of it.",
            shown, total));
    }
    (true, out)
}

/// `path` made, with any parent it needs.
#[cfg(unix)]
fn mkdir_op(path: &str) -> (bool, String) {
    match std::fs::create_dir_all(path) {
        Ok(())  => (true, String::new()),
        Err(e)  => (false, fs_said("create", path, &e)),
    }
}

// ── The two walks ───────────────────────────────────────────────────
//
// Both run in the launcher, behind the same ruleset as everything else in this section, and
// both are bounded by an ENTRY budget rather than by a depth or a file count. A search that
// matches nothing looks at every entry there is, and on a large enough folder it never comes
// back; the page has had that budget since `WalkBudget` and it is the page that sets it here,
// so the two ends cannot come to disagree about what a walk costs.
//
// **What comes back is deliberately not an answer.** The regex here is a FILTER -- it decides
// which files are worth carrying -- and the page then runs its own scan over the ones it is
// handed. Both compile the same `fe2o3_text` pattern from the same source, so the filter
// cannot be narrower than the answer; and everything a reader actually sees, the context
// lines and the paging and the notes, is composed in exactly one place.

/// A directory entry, in the order a walk must see it.
///
/// Sorted by name, so a walk is a repeatable pre-order and the page's `offset` can page it
/// honestly. Unsorted, two calls with the same arguments report different pages of the same
/// tree and a reader paging through one of them silently skips files.
#[cfg(unix)]
fn sorted_entries(dir: &Path) -> Option<Vec<(String, PathBuf, bool)>> {
    // `None`, NOT an empty listing. A directory the walk cannot open is not a directory with
    // nothing in it, and `Err(_) => Vec::new()` is exactly the shape `dev/BLOCKERS.md` B1 is
    // about: the walk answers about a place it never looked and nothing says so. Behind a
    // fence it is the commonest case there is -- it is what the kernel's refusal looks like
    // from in here -- so it is counted and named rather than swallowed.
    let rd = match std::fs::read_dir(dir) {
        Ok(r)  => r,
        Err(_) => return None,
    };
    let mut out: Vec<(String, PathBuf, bool)> = Vec::new();
    for ent in rd.flatten() {
        let name = ent.file_name().to_string_lossy().to_string();
        let is_dir = matches!(ent.file_type(), Ok(t) if t.is_dir());
        out.push((name, ent.path(), is_dir));
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Some(out)
}

/// What a walk did as well as what it found, so the page can say what was NOT looked at.
///
/// Every field is a count the page already has a sentence for; they travel as one line rather
/// than as a shape, because the only reader is the other half of this build.
#[cfg(unix)]
#[derive(Default)]
struct Walked {
    spent:   usize,		// entries charged
    stop:    String,	// the directory the budget ran out in, empty if it did not
    queued:  usize,		// directories still waiting when it did
    skipped: usize,		// directories passed over by name
    filtered:usize,		// files the glob excluded
    too_big: usize,		// files past the size cap
    binary:  usize,		// files whose bytes are not text
    files:   usize,		// files actually read and matched against
    left:    usize,		// files that matched and did not fit in the answer
    denied:  usize,		// directories the walk could not open at all
}

impl Walked {
    /// The header line every walk answers with, before whatever it found.
    fn line(&self) -> String {
        fmt!("{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}",
            self.spent, self.stop, self.queued, self.skipped, self.filtered,
            self.too_big, self.binary, self.files, self.left, self.denied)
    }
}

/// Charge one entry, answering whether the walk may look at it.
///
/// The first refusal records where the walk had got to and later ones are free, exactly as the
/// page's own budget behaves -- a caller may keep asking without the record moving.
#[cfg(unix)]
fn afford(w: &mut Walked, budget: usize, here: &str) -> bool {
    if w.spent >= budget {
        if w.stop.is_empty() {
            w.stop = here.to_string();
        }
        return false;
    }
    w.spent += 1;
    true
}

/// Every file under `paths` the pattern matches in, with the lines it matched on.
///
/// The answer is the header line, then for each file a line of `<path>\t<byte length>` and
/// exactly that many bytes of its matching lines.  Length-prefixed and not delimited, because
/// a line of a file holds every character a delimiter could have been.
///
/// **The lines rather than the file: `dev/BLOCKERS.md` B17.**  See [`matching_lines`].
///
/// # Arguments
/// * `query` - The regex source, already quoted by the caller where a literal was asked for.
/// * `skip` - Directory names to pass over, decided by the page from its own rule.
/// * `budget` - Entries the walk may look at.
/// * `cap` - The largest file worth opening, in bytes.
#[cfg(unix)]
fn search_op(
    paths:  &[String],
    query:  &str,
    ci:     bool,
    glob:   &str,
    base:   &str,
    skip:   &[String],
    budget: usize,
    cap:    u64,
)
    -> (bool, String)
{
    let re = match Regex::with_case(query, ci) {
        Ok(r)  => r,
        Err(e) => return (false, fmt!(
            "The search pattern could not be read by the hand: {}. Nothing was searched.",
            e.msgs().join(" "))),
    };
    let filter = match glob.is_empty() {
        true  => None,
        false => match Glob::new(glob) {
            Ok(g)  => Some(g),
            Err(e) => return (false, fmt!(
                "The search's glob could not be read by the hand: {}. Nothing was searched.",
                e.msgs().join(" "))),
        },
    };
    let mut w = Walked::default();
    let mut out = String::new();
    // Reversed so the first path is popped first: a walk over several marks should reach the
    // one the caller named first before it spends its budget on the others.
    let mut stack: Vec<PathBuf> = paths.iter().rev().map(PathBuf::from).collect();
    'walk: while let Some(dir) = stack.pop() {
        let here = fmt!("{}", dir.display());
        let entries = match sorted_entries(&dir) {
            Some(e) => e,
            None    => { w.denied += 1; continue; },
        };
        // Pushed in reverse so they pop in name order, which is what makes the whole walk a
        // repeatable pre-order.
        for (name, p, is_dir) in entries.iter().rev() {
            if !*is_dir {
                continue;
            }
            // Charged before the skip test, and so charged for every entry the walk lays eyes
            // on: what costs is reading the entry, not deciding to descend into it.
            if !afford(&mut w, budget, &here) {
                break;
            }
            if skip.iter().any(|d| d == name) {
                w.skipped += 1;
                continue;
            }
            stack.push(p.clone());
        }
        for (_, p, is_dir) in &entries {
            if *is_dir {
                continue;
            }
            if !afford(&mut w, budget, &here) {
                break 'walk;
            }
            let disp = fmt!("{}", p.display());
            if let Some(g) = &filter {
                // Matched against the path AS THE CALLER SPELLS IT. See `GLOB_BASE_DOC`: a
                // glob written `www/i18n/en.js` matched against `/home/.../repo/www/i18n/en.js`
                // excludes every file there is, and says so in a note nobody acts on.
                if !g.matches(under_base(&disp, base)) {
                    w.filtered += 1;
                    continue;
                }
            }
            match std::fs::metadata(p) {
                Ok(m) if m.len() > cap => { w.too_big += 1; continue; },
                Ok(_)                  => (),
                Err(_)                 => continue,
            }
            let bytes = match std::fs::read(p) {
                Ok(b)  => b,
                Err(_) => continue,
            };
            // Lossy-decoding a binary file lets its bytes match and be quoted back as though
            // they were source. The page makes the same test and would drop it anyway; making
            // it here is what stops the bytes crossing at all.
            if looks_binary(&bytes) {
                w.binary += 1;
                continue;
            }
            w.files += 1;
            let text = String::from_utf8_lossy(&bytes).to_string();
            let block = match matching_lines(&text, &re) {
                Some(b) => b,
                None    => continue,
            };
            if out.len() + block.len() > SEARCH_ANSWER_MAX {
                w.left += 1;
                continue;
            }
            out.push_str(&fmt!("{}\t{}\n", disp, block.len()));
            out.push_str(&block);
        }
    }
    w.queued = stack.len();
    (true, fmt!("{}\n{}", w.line(), out))
}

/// The lines of `text` a search has to carry back, each with the number it has in the file.
///
/// **A search answers about LINES, and the hand used to send whole FILES.**  The page's answer
/// is `path:line:text` with context around it, so what it needs is the lines that matched and
/// their neighbours; sending the file made the answer's size a function of how big the file was
/// rather than of how much of it matched, and a file over [`SEARCH_ANSWER_MAX`] could not be
/// searched at any narrowing -- `dev/BLOCKERS.md` B17, measured on this repository's own
/// `src/tools.rs` at 1,211,990 bytes against a 384 KiB ceiling, and answered *"No matches"*
/// eight times in one turn for a name that is in it.
///
/// [`SEARCH_CONTEXT_LINES`] neighbours go with each match because the page's `before` and
/// `after` reach that far and no further, so every line the page could be asked to print is
/// here.  A line the matcher could not decide goes back too: the page counts those and names
/// them, and dropping one here would have it counted as a line that did not match.
///
/// Each line is written as its 1-based number, a tab, and the line; `None` means the pattern
/// matched nothing in this file at all.
///
/// # Arguments
/// * `re` - The pattern, compiled from the same source the page compiled it from.
#[cfg(unix)]
fn matching_lines(text: &str, re: &Regex) -> Option<String> {
    let lines: Vec<&str> = text.lines().collect();
    let mut want = vec![false; lines.len()];
    let mut any = false;
    for (i, l) in lines.iter().enumerate() {
        let hit = match re.is_match(l) {
            Ok(b)  => b,
            // Undecided is not "no". It travels, and the page is what says so in words.
            Err(_) => true,
        };
        if !hit {
            continue;
        }
        any = true;
        let lo = i.saturating_sub(SEARCH_CONTEXT_LINES);
        let hi = (i + SEARCH_CONTEXT_LINES).min(lines.len().saturating_sub(1));
        for w in want.iter_mut().take(hi + 1).skip(lo) {
            *w = true;
        }
    }
    if !any {
        return None;
    }
    let mut out = String::new();
    for (i, l) in lines.iter().enumerate() {
        if want[i] {
            out.push_str(&fmt!("{}\t{}\n", i + 1, l));
        }
    }
    Some(out)
}

/// Every path under `paths` matching `pattern`, and when it was last written.
///
/// The answer is the header line, then one line per hit: the path, a tab, and the modification
/// time in nanoseconds since the epoch -- or `-` where the platform will not say, which the
/// page reports as an absence rather than as 1970.
#[cfg(unix)]
fn glob_op(paths: &[String], pattern: &str, base: &str, skip: &[String], budget: usize)
    -> (bool, String)
{
    let g = match Glob::new(pattern) {
        Ok(g)  => g,
        Err(e) => return (false, fmt!(
            "The glob could not be read by the hand: {}. Nothing was walked.",
            e.msgs().join(" "))),
    };
    let mut w = Walked::default();
    let mut out = String::new();
    let mut stack: Vec<PathBuf> = paths.iter().rev().map(PathBuf::from).collect();
    'walk: while let Some(dir) = stack.pop() {
        let here = fmt!("{}", dir.display());
        let entries = match sorted_entries(&dir) {
            Some(e) => e,
            None    => { w.denied += 1; continue; },
        };
        for (name, p, is_dir) in entries {
            if !afford(&mut w, budget, &here) {
                break 'walk;
            }
            if is_dir {
                if skip.iter().any(|d| *d == name) {
                    w.skipped += 1;
                    continue;
                }
                stack.push(p);
                continue;
            }
            let disp = fmt!("{}", p.display());
            if !g.matches(under_base(&disp, base)) {
                continue;
            }
            w.files += 1;
            let when = std::fs::metadata(&p).ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_nanos() as u64);
            let stamp = match when {
                Some(n) => fmt!("{}", n),
                None    => fmt!("-"),
            };
            if out.len() + disp.len() + 24 > SEARCH_ANSWER_MAX {
                w.left += 1;
                continue;
            }
            out.push_str(&fmt!("{}\t{}\n", disp, stamp));
        }
    }
    w.queued = stack.len();
    (true, fmt!("{}\n{}", w.line(), out))
}

/// A path with the caller's own prefix taken off, which is the spelling its glob is written in.
///
/// Returns the path WHOLE where it is not under the prefix, because a file silently excluded is
/// the failure this exists to end: matching too much is a file the caller then sees and can
/// ignore, and matching too little is a file nobody knows was there.
///
/// # Arguments
/// * `abs` - The path as this walk found it.
/// * `base` - The absolute prefix the caller strips, or empty for none.
#[cfg(unix)]
fn under_base<'a>(abs: &'a str, base: &str) -> &'a str {
    if base.is_empty() {
        return abs;
    }
    let cut = base.trim_end_matches('/');
    match abs.strip_prefix(cut).and_then(|r| r.strip_prefix('/')) {
        Some(r) => r,
        None    => abs,
    }
}

/// Does this look like a file of bytes rather than a file of text?
///
/// A NUL in the first few kilobytes, which is what every tool that has to make this decision
/// without a type uses.  The page makes the same test with the same rule; making it here as
/// well is not a second opinion but a way of not carrying the bytes at all.
#[cfg(unix)]
fn looks_binary(data: &[u8]) -> bool {
    data.iter().take(8000).any(|b| *b == 0)
}

/// Reads one length-prefixed payload from standard input, and not one byte more.
///
/// Unbuffered, and that is the whole difficulty.  `std::io::stdin()` is a
/// `BufReader`, and a buffered four-byte read pulls eight kilobytes out of the
/// pipe -- which here would swallow the beginning of the command's own standard
/// input, since that is what follows the plan in the same pipe.  Duplicating the
/// descriptor into a `File` gives a handle whose every `read` is exactly the
/// syscall that was asked for.  The duplicate is closed on return; descriptor
/// zero itself is untouched and passes to the command.
#[cfg(unix)]
fn read_payload() -> Outcome<Payload> {
    use std::io::Read;
    use std::os::fd::AsFd;

    let dup = res!(std::io::stdin().as_fd().try_clone_to_owned()
        .map_err(|e| err!(e,
            "The launcher could not take an unbuffered handle on its own \
            standard input."; IO)));
    let mut src = std::fs::File::from(dup);

    let mut len = [0u8; 4];
    res!(src.read_exact(&mut len).map_err(|e| err!(e,
        "The launcher could not read the plan's length prefix."; IO, Input)));
    let n = u32::from_le_bytes(len) as usize;
    if n > PAYLOAD_MAX {
        return Err(err!(
            "The launcher was offered a plan of {} bytes, and {} is the most it \
            will read. Nothing was run.", n, PAYLOAD_MAX;
            Excessive, Input));
    }
    let mut body = vec![0u8; n];
    res!(src.read_exact(&mut body).map_err(|e| err!(e,
        "The launcher read a plan {} bytes long and then could not read the \
        plan.", n; IO, Input)));
    decode_payload(&body)
}

/// The most the launcher will read as a plan.
///
/// A carved workspace produces one rule per child, so a large plan is ordinary;
/// a plan of megabytes is a mistake or a lie, and reading it would be a way to
/// make the launcher allocate on somebody else's say-so.
const PAYLOAD_MAX: usize = 4 * 1024 * 1024;

/// Writes a payload as the launcher expects to read it.
///
/// A private encoding rather than the wire's JSON, and for once that is not
/// laziness: both ends of this pipe are the same binary from the same build, the
/// content is a `Plan` rather than anything the protocol describes, and every
/// field is length-prefixed, so there is nothing to escape and no place for a
/// value to be mistaken for a delimiter.
///
/// # Arguments
/// * `p` - What the launcher is to be told.
pub(crate) fn encode_payload(p: &Payload) -> Outcome<Vec<u8>> {
    let mut e = Enc { out: Vec::new() };
    res!(e.path(&p.prog));
    res!(e.len(p.argv.len()));
    for a in &p.argv {
        res!(e.text(a));
    }
    res!(e.len(p.env.len()));
    for (k, v) in &p.env {
        res!(e.text(k));
        res!(e.text(v));
    }

    res!(e.len(p.plan.abi.level() as usize));
    e.byte(match p.plan.listing {
        Listing::Sealed	=> 0,
        Listing::Names	=> 1,
    });
    e.byte(match p.plan.base {
        SysBase::Bare		=> 0,
        SysBase::Minimal	=> 1,
    });
    e.byte(match p.plan.reach {
        Reach::Thread	=> 0,
        Reach::Process	=> 1,
    });
    e.byte(u8::from(p.plan.net));
    e.byte(u8::from(p.tty));
    match &p.plan.waiver {
        None => e.byte(0),
        Some(w) => {
            e.byte(1);
            res!(e.text(w));
        },
    }
    res!(e.len(p.plan.grants.len()));
    for g in &p.plan.grants {
        res!(e.path(&g.path));
        e.byte(match g.level {
            Level::Deny	=> 0,
            Level::Ro	=> 1,
            Level::Rw	=> 2,
        });
    }
    res!(e.len(p.plan.sealed.len()));
    for s in &p.plan.sealed {
        res!(e.path(s));
    }
    res!(e.len(p.plan.dropped.len()));
    for d in &p.plan.dropped {
        res!(e.path(d));
    }
    // The act, last, so that a reader of this function meets the fence before the thing the
    // fence is for. Its own tag byte and then only the fields that arm has: an `Exec` costs
    // one byte, which is what it should cost.
    match &p.act {
        Act::Exec => e.byte(0),
        Act::File(op) => {
            e.byte(1);
            e.byte(match op {
                FileOp::Read   { .. }	=> 0,
                FileOp::Write  { .. }	=> 1,
                FileOp::Edit   { .. }	=> 2,
                FileOp::Move   { .. }	=> 3,
                FileOp::List   { .. }	=> 4,
                FileOp::MkDir  { .. }	=> 5,
                FileOp::Search { .. }	=> 6,
                FileOp::Glob   { .. }	=> 7,
            });
            // The walks carry a LIST of starts, so the single path every other op has is
            // written as a one-element list and read back as one. Written this way rather than
            // as two shapes, because a plan whose first field means two things is a plan a
            // later edit reads wrongly.
            let named = op.paths();
            res!(e.len(named.len()));
            for p in &named {
                res!(e.text(p));
            }
            match op {
                FileOp::Read { offset, limit, .. } => {
                    res!(e.len(*offset as usize));
                    res!(e.len(*limit as usize));
                },
                FileOp::Write { content, .. } => res!(e.text(content)),
                FileOp::Edit { old, new, .. } => {
                    res!(e.text(old));
                    res!(e.text(new));
                },
                // `to` already travelled in the path list above.
                FileOp::Move { .. } => (),
                FileOp::List { .. } | FileOp::MkDir { .. } => (),
                FileOp::Search { query, ci, glob, base, skip, budget, cap, .. } => {
                    res!(e.text(query));
                    e.byte(u8::from(*ci));
                    res!(e.text(glob));
                    res!(e.text(base));
                    res!(e.len(skip.len()));
                    for d in skip {
                        res!(e.text(d));
                    }
                    res!(e.len(*budget as usize));
                    res!(e.len(*cap as usize));
                },
                FileOp::Glob { pattern, base, skip, budget, .. } => {
                    res!(e.text(pattern));
                    res!(e.text(base));
                    res!(e.len(skip.len()));
                    for d in skip {
                        res!(e.text(d));
                    }
                    res!(e.len(*budget as usize));
                },
            }
        },
    }

    let body = e.out;
    if body.len() > PAYLOAD_MAX {
        return Err(err!(
            "This command's fence needs {} bytes to describe and the launcher \
            will read {}. The fence is too finely divided to apply; a spec with \
            fewer carved directories would fit.", body.len(), PAYLOAD_MAX;
            Excessive, Size));
    }
    let mut out = Vec::with_capacity(body.len() + 4);
    out.extend_from_slice(&(body.len() as u32).to_le_bytes());
    out.extend_from_slice(&body);
    Ok(out)
}

/// Reads back what [`encode_payload`] wrote.
///
/// # Arguments
/// * `b` - The body, without its length prefix.
fn decode_payload(b: &[u8]) -> Outcome<Payload> {
    let mut d = Dec { b, at: 0 };
    let prog = res!(d.path());
    let mut argv = Vec::new();
    for _ in 0..res!(d.len()) {
        argv.push(res!(d.text()));
    }
    let mut env = Vec::new();
    for _ in 0..res!(d.len()) {
        let k = res!(d.text());
        let v = res!(d.text());
        env.push((k, v));
    }

    let abi = crate::fence::Abi::of_level(res!(d.len()) as u32);
    let listing = match res!(d.byte()) {
        0 => Listing::Sealed,
        1 => Listing::Names,
        n => return Err(err!("The plan names listing mode {}, which does not exist.", n;
            Invalid, Input)),
    };
    let base = match res!(d.byte()) {
        0 => SysBase::Bare,
        1 => SysBase::Minimal,
        n => return Err(err!("The plan names system base {}, which does not exist.", n;
            Invalid, Input)),
    };
    let reach = match res!(d.byte()) {
        0 => Reach::Thread,
        1 => Reach::Process,
        n => return Err(err!("The plan names reach {}, which does not exist.", n;
            Invalid, Input)),
    };
    let net = res!(d.byte()) != 0;
    let tty = res!(d.byte()) != 0;
    let waiver = match res!(d.byte()) {
        0 => None,
        1 => Some(res!(d.text())),
        n => return Err(err!("The plan's waiver flag is {}, which is neither 0 nor 1.", n;
            Invalid, Input)),
    };
    let mut grants = Vec::new();
    for _ in 0..res!(d.len()) {
        let path = res!(d.path());
        let level = match res!(d.byte()) {
            0 => Level::Deny,
            1 => Level::Ro,
            2 => Level::Rw,
            n => return Err(err!("The plan grants level {}, which does not exist.", n;
                Invalid, Input)),
        };
        grants.push(Grant { path, level });
    }
    let mut sealed = Vec::new();
    for _ in 0..res!(d.len()) {
        sealed.push(res!(d.path()));
    }
    let mut dropped = Vec::new();
    for _ in 0..res!(d.len()) {
        dropped.push(res!(d.path()));
    }
    let act = match res!(d.byte()) {
        0 => Act::Exec,
        1 => {
            let kind = res!(d.byte());
            let mut named: Vec<String> = Vec::new();
            for _ in 0..res!(d.len()) {
                named.push(res!(d.text()));
            }
            // One path where the op has one, and a refusal rather than a guess where the plan
            // carried none: a `read` of nowhere is a plan this build did not write.
            let one = |v: &Vec<String>| -> Outcome<String> {
                match v.first() {
                    Some(p) => Ok(p.clone()),
                    None    => Err(err!(
                        "The plan names a file operation with no path at all."; Invalid, Input)),
                }
            };
            let names = |d: &mut Dec| -> Outcome<Vec<String>> {
                let mut out = Vec::new();
                for _ in 0..res!(d.len()) {
                    out.push(res!(d.text()));
                }
                Ok(out)
            };
            Act::File(match kind {
                0 => FileOp::Read {
                    path:   res!(one(&named)),
                    offset: res!(d.len()) as u32,
                    limit:  res!(d.len()) as u32,
                },
                1 => FileOp::Write { path: res!(one(&named)), content: res!(d.text()) },
                2 => FileOp::Edit {
                    path: res!(one(&named)),
                    old:  res!(d.text()),
                    new:  res!(d.text()),
                },
                3 => FileOp::Move {
                    path: res!(one(&named)),
                    to:   match named.get(1) {
                        Some(t) => t.clone(),
                        None    => return Err(err!(
                            "The plan names a move with nowhere to move to."; Invalid, Input)),
                    },
                },
                4 => FileOp::List { path: res!(one(&named)) },
                5 => FileOp::MkDir { path: res!(one(&named)) },
                6 => FileOp::Search {
                    paths:  named,
                    query:  res!(d.text()),
                    ci:     res!(d.byte()) != 0,
                    glob:   res!(d.text()),
                    base:   res!(d.text()),
                    skip:   res!(names(&mut d)),
                    budget: res!(d.len()) as u32,
                    cap:    res!(d.len()) as u32,
                },
                7 => FileOp::Glob {
                    paths:   named,
                    pattern: res!(d.text()),
                    base:    res!(d.text()),
                    skip:    res!(names(&mut d)),
                    budget:  res!(d.len()) as u32,
                },
                n => return Err(err!("The plan names file operation {}, which does not exist.", n;
                    Invalid, Input)),
            })
        },
        n => return Err(err!("The plan names act {}, which does not exist.", n;
            Invalid, Input)),
    };
    res!(d.done());

    Ok(Payload {
        prog,
        argv,
        env,
        plan: Plan { abi, listing, base, reach, grants, sealed, dropped, net, waiver },
        tty,
        act,
    })
}

/// Builds the launcher's payload, one length-prefixed field at a time.
struct Enc {
    /// What has been written so far.
    out: Vec<u8>,
}

impl Enc {

    /// Writes one byte.
    ///
    /// # Arguments
    /// * `v` - The byte.
    fn byte(&mut self, v: u8) {
        self.out.push(v);
    }

    /// Writes a count or a length.
    ///
    /// # Arguments
    /// * `v` - The number, which must fit in 32 bits.
    fn len(&mut self, v: usize) -> Outcome<()> {
        if v > u32::MAX as usize {
            return Err(err!(
                "A fence plan cannot carry {} of anything.", v; Excessive, Size));
        }
        self.out.extend_from_slice(&(v as u32).to_le_bytes());
        Ok(())
    }

    /// Writes a length-prefixed run of bytes.
    ///
    /// # Arguments
    /// * `b` - The bytes.
    fn bytes(&mut self, b: &[u8]) -> Outcome<()> {
        res!(self.len(b.len()));
        self.out.extend_from_slice(b);
        Ok(())
    }

    /// Writes a length-prefixed string.
    ///
    /// # Arguments
    /// * `s` - The text.
    fn text(&mut self, s: &str) -> Outcome<()> {
        self.bytes(s.as_bytes())
    }

    /// Writes a length-prefixed path, byte for byte.
    ///
    /// # Arguments
    /// * `p` - The path.
    fn path(&mut self, p: &Path) -> Outcome<()> {
        self.bytes(&path_bytes(p))
    }
}

/// Reads the launcher's payload back, refusing anything that does not fit.
struct Dec<'a> {
    /// The body being read.
    b:  &'a [u8],
    /// How far in.
    at: usize,
}

impl<'a> Dec<'a> {

    /// Takes `n` bytes, or says how far short the payload fell.
    ///
    /// # Arguments
    /// * `n` - How many bytes are wanted.
    fn take(&mut self, n: usize) -> Outcome<&'a [u8]> {
        let end = match self.at.checked_add(n) {
            Some(e) => e,
            None => return Err(err!(
                "A field in the plan claims a length that cannot be counted.";
                Invalid, Input)),
        };
        if end > self.b.len() {
            return Err(err!(
                "The plan ended after {} bytes with {} still to read.",
                self.b.len(), end - self.b.len();
                Invalid, Input, Size));
        }
        let out = &self.b[self.at..end];
        self.at = end;
        Ok(out)
    }

    /// Takes one byte.
    fn byte(&mut self) -> Outcome<u8> {
        let b = res!(self.take(1));
        Ok(b[0])
    }

    /// Takes a count or a length.
    fn len(&mut self) -> Outcome<usize> {
        let b = res!(self.take(4));
        let mut v = [0u8; 4];
        v.copy_from_slice(b);
        Ok(u32::from_le_bytes(v) as usize)
    }

    /// Takes a length-prefixed run of bytes.
    fn bytes(&mut self) -> Outcome<Vec<u8>> {
        let n = res!(self.len());
        Ok(res!(self.take(n)).to_vec())
    }

    /// Takes a length-prefixed string.
    fn text(&mut self) -> Outcome<String> {
        let b = res!(self.bytes());
        match String::from_utf8(b) {
            Ok(s)  => Ok(s),
            Err(e) => Err(err!(e,
                "A string in the plan is not valid UTF-8."; Invalid, Input, String)),
        }
    }

    /// Takes a length-prefixed path.
    fn path(&mut self) -> Outcome<PathBuf> {
        let b = res!(self.bytes());
        Ok(bytes_path(b))
    }

    /// Refuses a payload with anything left over.
    ///
    /// Trailing bytes mean the two ends disagree about the shape of a plan, and
    /// a launcher that applied the part it understood would be applying a fence
    /// nobody wrote.
    fn done(&self) -> Outcome<()> {
        if self.at != self.b.len() {
            return Err(err!(
                "The plan carried {} bytes beyond its last field, so the launcher \
                and the hand disagree about what a plan is.", self.b.len() - self.at;
                Invalid, Input, Mismatch));
        }
        Ok(())
    }
}

/// A path as the bytes the operating system holds it as.
///
/// # Arguments
/// * `p` - The path.
fn path_bytes(p: &Path) -> Vec<u8> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        p.as_os_str().as_bytes().to_vec()
    }
    #[cfg(not(unix))]
    {
        p.to_string_lossy().as_bytes().to_vec()
    }
}

/// The path those bytes name.
///
/// # Arguments
/// * `b` - The bytes.
fn bytes_path(b: Vec<u8>) -> PathBuf {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStringExt;
        PathBuf::from(std::ffi::OsString::from_vec(b))
    }
    #[cfg(not(unix))]
    {
        PathBuf::from(String::from_utf8_lossy(&b).to_string())
    }
}

// ┌───────────────────────────────────────────────────────────────┐
// │ Tests                                                          │
// └───────────────────────────────────────────────────────────────┘

#[cfg(test)]
mod tests {
    use super::*;

    use tokio::sync::mpsc::Receiver;

    // ── Becoming the launcher ───────────────────────────────────────
    //
    // Every command in these tests really is fenced, by the real `launch_main`,
    // in a real second process. That is possible only because the test binary
    // can be made to re-enter itself: `/proc/self/exe` here is libtest, whose
    // `main` will not dispatch `LAUNCH_ARG`, so the launcher is invoked as
    // "run exactly the test named below" and that test calls `launch_main`.
    //
    // The one artefact is that libtest announces itself on standard output
    // before reaching the test, so sixteen known bytes precede every command's
    // own output. They are removed by name rather than tolerated, and a test
    // asserting an exact byte count adds them explicitly, so that a change in
    // the harness fails a test instead of quietly moving a number.

    /// The environment name that turns a copy of the test binary into a launcher.
    const LAUNCH_CHILD: &str = "DAIMOND_HAND_TEST_LAUNCHER";

    /// What libtest writes to standard output before it reaches a test.
    ///
    /// Two lines rather than one: under `--nocapture` the name is printed
    /// *before* the test runs, so that a test's own output appears after it.
    /// Fixed text, because the test named is fixed.
    const HARNESS_NOISE: &str =
        "\nrunning 1 test\ntest exec::tests::launcher_child_entry ... ";

    /// The launcher entry point, reached only in a re-executed test binary.
    ///
    /// Ordinary runs of the suite see the variable unset and return at once, so
    /// this costs nothing except when it is the point.
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
            "The launcher tests need to know their own binary."; Test, IO)));
        Ok(Launcher::Explicit {
            prog: exe,
            args: vec![
                fmt!("exec::tests::launcher_child_entry"),
                fmt!("--exact"),
                fmt!("--nocapture"),
                fmt!("--test-threads=1"),
            ],
            env:  vec![(fmt!("{}", LAUNCH_CHILD), fmt!("1"))],
        })
    }

    /// A runner whose launcher is this test binary.
    fn runner() -> Outcome<Runner> {
        Ok(Runner::with_launcher(res!(test_launcher())))
    }

    /// A directory that certainly exists and that the tests never write to.
    fn root() -> String {
        fmt!("{}", env!("CARGO_MANIFEST_DIR"))
    }

    /// A fence that permits the crate's own directory and nothing else.
    fn fence_here() -> FenceSpec {
        FenceSpec { rw: vec![root()], ro: Vec::new(), deny: Vec::new(), net: false }
    }

    /// A workspace with something in it, and something outside it.
    ///
    /// Under the home cache and never `/tmp`: that is a tmpfs here, and filling
    /// it has taken this machine down before.
    ///
    /// # Arguments
    /// * `name` - A name unique to the calling test.
    fn fixture(name: &str) -> Outcome<PathBuf> {
        let home = match std::env::var("HOME") {
            Ok(h) => h,
            Err(e) => return Err(err!(e,
                "The exec tests need HOME to know where to put fixtures."; Test, Configuration)),
        };
        let base = PathBuf::from(home).join(".cache/daimond-hand-exec-tests").join(name);
        let _ = std::fs::remove_dir_all(&base);
        res!(std::fs::create_dir_all(base.join("ws")));
        res!(std::fs::create_dir_all(base.join("outside")));
        res!(std::fs::write(base.join("ws/inside.txt"), "inside"));
        res!(std::fs::write(base.join("outside/other.txt"), "other"));
        Ok(res!(base.canonicalize()))
    }

    /// How long a file this process has just written is given to stop being busy.
    ///
    /// Generous by more than two orders of magnitude: every wait measured here
    /// cleared inside three attempts and fifteen milliseconds. A file still busy
    /// after this is not the race below.
    const FRESH_WAIT: std::time::Duration = std::time::Duration::from_secs(5);

    /// A program this process has just written, run once the kernel will let it.
    ///
    /// `std::fs::copy` opens the destination for writing, and for as long as that
    /// descriptor is open any OTHER thread of this process that starts a command
    /// forks a child whose file descriptor table is a copy of ours -- so the child
    /// carries a duplicate of it until its own `execve` closes it. For those few
    /// milliseconds the file has a writer, and Linux answers `execve` on a file
    /// with a writer with `ETXTBSY`. Nothing has leaked: the child is a launcher
    /// this suite meant to start, the descriptor is not one it knows it holds, and
    /// it goes the moment the child execs.
    ///
    /// Measured on this tree, which runs its tests in parallel and starts a real
    /// second process for nearly every one of them. At 32 threads the failure
    /// appeared in 3 runs of 20; a scan of this process's own children at the
    /// instant of the error caught the holder twice, by pid and by descriptor
    /// number; and with this wait in place it appeared in 7 runs of 40 and cleared
    /// every time inside three attempts and fifteen milliseconds. Run serially it
    /// never appeared in 20 runs, and run on its own never in 300 -- which is the
    /// same statement from the other side, since neither has anything else
    /// forking.
    ///
    /// So this waits, briefly, and only for that one error. Every other failure is
    /// returned at once, and a file still busy at the end of [`FRESH_WAIT`] is a
    /// descriptor somebody really did leak rather than this race, and says so.
    ///
    /// # Arguments
    /// * `prog` - The program, which this process wrote a moment ago.
    /// * `args` - Its arguments.
    fn run_fresh(prog: &Path, args: &[&str]) -> Outcome<std::process::Output> {
        let began = std::time::Instant::now();
        let mut tries = 0u32;
        loop {
            tries += 1;
            match std::process::Command::new(prog).args(args).output() {
                Ok(out) => return Ok(out),
                Err(e)  => {
                    if e.kind() != std::io::ErrorKind::ExecutableFileBusy {
                        return Err(err!(e,
                            "{} would not run.", prog.display(); Test, IO));
                    }
                    if began.elapsed() >= FRESH_WAIT {
                        return Err(err!(e,
                            "{} was still busy after {} attempts over {:?}. A file this \
                            process wrote and then closed goes un-busy as soon as the \
                            children that forked while it was open have exec'd, which \
                            takes milliseconds; {:?} means a descriptor on it is genuinely \
                            held open somewhere, and that leak is the thing to fix rather \
                            than this wait.",
                            prog.display(), tries, began.elapsed(), FRESH_WAIT; Test, IO));
                    }
                    std::thread::sleep(std::time::Duration::from_millis(2));
                },
            }
        }
    }

    /// A request with the fields the tests vary and sensible rest.
    fn exec(id: &str, argv: &[&str]) -> Req {
        Req::Exec {
            id:         fmt!("{}", id),
            argv:       argv.iter().map(|a| fmt!("{}", a)).collect(),
            cwd:        root(),
            env:        Vec::new(),
            stdin:      None,
            timeout_ms: 10_000,
            capture:    Capture::Both,
            fence:      fence_here(),
            toolkits: Vec::new(),
        }
    }

    /// The process group of `pid`, read straight out of `/proc` by the test.
    ///
    /// Deliberately not [`group_standing`]: a test that measured the machine with
    /// the code under test would agree with it whatever either of them did.
    fn proc_pgrp(pid: u32) -> Option<u32> {
        let stat = match std::fs::read_to_string(fmt!("/proc/{}/stat", pid)) {
            Ok(s)  => s,
            Err(_) => return None,
        };
        let tail = match stat.rsplit_once(')') {
            Some((_, t)) => t,
            None         => return None,
        };
        tail.split_whitespace().nth(2).and_then(|f| f.parse::<u32>().ok())
    }

    /// A request that runs in a named directory, with that directory as the
    /// whole of its fence.
    fn exec_at(id: &str, argv: &[&str], dir: &Path) -> Req {
        Req::Exec {
            id:         fmt!("{}", id),
            argv:       argv.iter().map(|a| fmt!("{}", a)).collect(),
            cwd:        fmt!("{}", dir.display()),
            env:        Vec::new(),
            stdin:      None,
            timeout_ms: 30_000,
            capture:    Capture::Both,
            fence:      FenceSpec {
                rw:   vec![fmt!("{}", dir.display())],
                ro:   Vec::new(),
                deny: Vec::new(),
                net:  false,
            },
            toolkits:   Vec::new(),
        }
    }

    /// Collects responses until the run closes.
    async fn collect(rx: &mut Receiver<Resp>) -> Vec<Resp> {
        let mut v = Vec::new();
        while let Some(r) = rx.recv().await {
            let done = matches!(r, Resp::Ended { .. } | Resp::Refused { .. });
            v.push(r);
            if done {
                break;
            }
        }
        v
    }

    /// Everything one stream said, in order, less the harness's own announcement.
    fn text_of(rs: &[Resp], want: Stream) -> String {
        let mut s = String::new();
        for r in rs {
            if let Resp::Chunk { stream, data, .. } = r {
                if *stream == want {
                    s.push_str(data);
                }
            }
        }
        match s.strip_prefix(HARNESS_NOISE) {
            Some(rest)	=> fmt!("{}", rest),
            None		=> s,
        }
    }

    /// The sequence numbers seen on one stream, in arrival order.
    fn seqs_of(rs: &[Resp], want: Stream) -> Vec<u64> {
        let mut v = Vec::new();
        for r in rs {
            if let Resp::Chunk { stream, seq, .. } = r {
                if *stream == want {
                    v.push(*seq);
                }
            }
        }
        v
    }

    /// The closing message.
    fn ended(rs: &[Resp]) -> Option<(i32, bool, bool, u64)> {
        for r in rs {
            if let Resp::Ended { exit, timed_out, killed, out_bytes, .. } = r {
                return Some((*exit, *timed_out, *killed, *out_bytes));
            }
        }
        None
    }

    /// Runs one request to completion and hands back everything it said.
    async fn run(req: Req) -> Outcome<Vec<Resp>> {
        let runner = res!(runner());
        let (tx, mut rx) = tokio::sync::mpsc::channel::<Resp>(4096);
        res!(runner.spawn(req, tx).await);
        Ok(collect(&mut rx).await)
    }

    /// The refusal sentence, or an error naming what came instead.
    ///
    /// # Arguments
    /// * `rs` - Everything the run said.
    fn refusal(rs: &[Resp]) -> Outcome<String> {
        match rs.first() {
            Some(Resp::Refused { reason, .. }) => {
                assert!(reason.starts_with("Refused: "),
                    "a refusal did not read as one: {}", reason);
                Ok(fmt!("{}", reason))
            },
            other => Err(err!(
                "Expected a refusal, got {:?}.", other; Test, Mismatch)),
        }
    }

    #[tokio::test]
    async fn test_echo_returns_its_output_and_exit_zero() -> Outcome<()> {
        let rs = res!(run(exec("e1", &["/bin/echo", "hello"])).await);
        assert_eq!(text_of(&rs, Stream::Out), "hello\n");
        let (exit, timed_out, killed, out_bytes) = match ended(&rs) {
            Some(e) => e,
            None    => return Err(err!("No Ended was sent."; Test, Missing)),
        };
        assert_eq!(exit, 0);
        assert!(!timed_out);
        assert!(!killed);
        // The command wrote six bytes; the harness that became its launcher
        // wrote the rest. Counted explicitly rather than loosened to `>=`, so
        // that a harness change fails here instead of hiding a lost byte.
        assert_eq!(out_bytes, (HARNESS_NOISE.len() + 6) as u64);
        Ok(())
    }

    #[tokio::test]
    async fn test_non_zero_exit_is_reported() -> Outcome<()> {
        let rs = res!(run(exec("e2", &["/bin/false"])).await);
        let (exit, timed_out, ..) = match ended(&rs) {
            Some(e) => e,
            None    => return Err(err!("No Ended was sent."; Test, Missing)),
        };
        assert_ne!(exit, 0);
        assert!(!timed_out);
        Ok(())
    }

    #[tokio::test]
    async fn test_timeout_kills_and_reports_it() -> Outcome<()> {
        let req = match exec("e3", &["/bin/sleep", "30"]) {
            Req::Exec { id, argv, cwd, env, stdin, capture, fence, .. } =>
                Req::Exec { id, argv, cwd, env, stdin, timeout_ms: 300, capture, fence, toolkits: Vec::new() },
            other => other,
        };
        let rs = res!(run(req).await);
        let (_, timed_out, ..) = match ended(&rs) {
            Some(e) => e,
            None    => return Err(err!("No Ended was sent."; Test, Missing)),
        };
        assert!(timed_out);
        Ok(())
    }

    #[tokio::test]
    async fn test_stdin_is_delivered() -> Outcome<()> {
        let req = match exec("e4", &["/bin/cat"]) {
            Req::Exec { id, argv, cwd, env, timeout_ms, capture, fence, .. } =>
                Req::Exec {
                    id, argv, cwd, env,
                    stdin: Some(fmt!("through the pipe\n")),
                    timeout_ms, capture, fence,
                    toolkits: Vec::new(),
                },
            other => other,
        };
        let rs = res!(run(req).await);
        assert_eq!(text_of(&rs, Stream::Out), "through the pipe\n");
        Ok(())
    }

    #[tokio::test]
    async fn test_large_output_arrives_as_several_sequenced_chunks() -> Outcome<()> {
        // Comfortably more than CHUNK_MAX, sent in and read back out.
        let big = "a".repeat(CHUNK_MAX * 3);
        let req = match exec("e5", &["/bin/cat"]) {
            Req::Exec { id, argv, cwd, env, timeout_ms, capture, fence, .. } =>
                Req::Exec {
                    id, argv, cwd, env,
                    stdin: Some(big.clone()),
                    timeout_ms, capture, fence,
                    toolkits: Vec::new(),
                },
            other => other,
        };
        let rs = res!(run(req).await);

        assert_eq!(text_of(&rs, Stream::Out), big);

        let seqs = seqs_of(&rs, Stream::Out);
        assert!(seqs.len() > 1, "expected several chunks, got {}", seqs.len());
        for (i, s) in seqs.iter().enumerate() {
            assert_eq!(*s, i as u64, "sequence is not monotonic from zero");
        }
        for r in &rs {
            if let Resp::Chunk { data, .. } = r {
                assert!(data.len() <= CHUNK_MAX, "a chunk exceeded CHUNK_MAX");
            }
        }
        Ok(())
    }

    /// The command sees the pairs it was given, the three the hand adds, and
    /// nothing else at all.
    ///
    /// `PATH` is named on purpose.  It is certainly in the hand's own
    /// environment, an inherited environment is how a credential the user never
    /// meant to lend reaches a command, and it is now DEFAULTED as well -- so the
    /// test is that the command holds [`PATH_FALLBACK`] and not the hand's, which
    /// is the difference between a default and an inheritance.
    #[tokio::test]
    async fn test_environment_really_is_cleared() -> Outcome<()> {
        let req = match exec("e6", &["/usr/bin/env"]) {
            Req::Exec { id, argv, cwd, stdin, timeout_ms, capture, fence, .. } =>
                Req::Exec {
                    id, argv, cwd, stdin, timeout_ms, capture, fence,
                    env: vec![
                        (fmt!("ONLY"),  fmt!("this")),
                        (fmt!("AND"),   fmt!("that")),
                    ],
                    toolkits: Vec::new(),
                },
            other => other,
        };
        let rs = res!(run(req).await);

        let mut lines = text_of(&rs, Stream::Out)
            .lines()
            .map(|l| fmt!("{}", l))
            .filter(|l| !l.is_empty())
            .collect::<Vec<_>>();
        lines.sort();
        // A default and an inheritance look alike from here, and the way to tell
        // them apart is the value. The hand's own PATH is whatever launched the
        // browser and is nothing like the fixed list.
        if let Ok(mine) = std::env::var("PATH") {
            assert!(!lines.iter().any(|l| *l == fmt!("PATH={}", mine)) || mine == PATH_FALLBACK,
                "the hand's own PATH reached the command");
        }
        for l in &lines {
            if let Some(rest) = l.strip_prefix("PATH=") {
                assert_eq!(rest, PATH_FALLBACK, "the command's PATH is not the fixed list");
            }
        }

        // The three the hand adds are the same directory, and that directory is
        // under the scratch base rather than /tmp.
        let base = res!(scratch_base());
        let mut tmp = Vec::<String>::new();
        for name in TMP_VARS {
            let want = fmt!("{}=", name);
            match lines.iter().find(|l| l.starts_with(&want)) {
                Some(l) => tmp.push(fmt!("{}", &l[want.len()..])),
                None    => return Err(err!(
                    "{} was not set for the command.", name; Test, Missing)),
            }
        }
        assert_eq!(tmp[0], tmp[1], "TMPDIR and TMP name different directories");
        assert_eq!(tmp[1], tmp[2], "TMP and TEMP name different directories");
        assert!(Path::new(&tmp[0]).starts_with(&base),
            "{} is not under the scratch base {}", tmp[0], base.display());

        let mut want = vec![fmt!("AND=that"), fmt!("ONLY=this")];
        for name in TMP_VARS {
            want.push(fmt!("{}={}", name, tmp[0]));
        }
        for name in ENV_DEFAULTED {
            if let Some(v) = default_env(name) {
                want.push(fmt!("{}={}", name, v));
            }
        }
        want.sort();
        assert_eq!(lines, want);
        Ok(())
    }

    /// The central design decision, stated as a test.
    ///
    /// Each of these strings is a shell instruction, and every one of them
    /// arrives at the program as literal text.  There is no quoting to get
    /// right and no metacharacter to escape, because no shell is involved --
    /// which is why `argv` is not a preference here but the whole defence.
    #[tokio::test]
    async fn test_shell_metacharacters_are_passed_through_literally() -> Outcome<()> {
        let hostile = [
            "a;b",
            "$(whoami)",
            "`whoami`",
            "x|y",
            "&& rm -rf /",
            "$HOME",
            "*",
            ">out.txt",
        ];
        let mut argv = vec!["/bin/echo"];
        argv.extend_from_slice(&hostile);

        let rs = res!(run(exec("e7", &argv)).await);
        let got = text_of(&rs, Stream::Out);

        assert_eq!(got, fmt!("{}\n", hostile.join(" ")));
        // Named individually, because each is a different way in.
        assert!(got.contains("a;b"),          "a semicolon was interpreted");
        assert!(got.contains("$(whoami)"),    "a substitution was interpreted");
        assert!(got.contains("`whoami`"),     "a backquote was interpreted");
        assert!(got.contains("x|y"),          "a pipe was interpreted");
        assert!(got.contains("&& rm -rf /"),  "a conjunction was interpreted");
        assert!(got.contains("$HOME"),        "a variable was expanded");
        assert!(got.contains(" * "),          "a glob was expanded");
        assert!(got.contains(">out.txt"),     "a redirection was interpreted");
        Ok(())
    }

    #[tokio::test]
    async fn test_cwd_outside_the_fence_is_refused() -> Outcome<()> {
        let req = match exec("e8", &["/bin/echo", "hi"]) {
            Req::Exec { id, argv, env, stdin, timeout_ms, capture, fence, .. } =>
                Req::Exec {
                    id, argv, env, stdin, timeout_ms, capture, fence,
                    cwd: fmt!("/"),
                    toolkits: Vec::new(),
                },
            other => other,
        };
        let rs = res!(run(req).await);
        match rs.first() {
            Some(Resp::Refused { reason, .. }) => {
                assert!(reason.starts_with("Refused: "));
                assert!(reason.contains("outside this command's fence"));
            },
            other => return Err(err!(
                "Expected a refusal, got {:?}.", other; Test, Mismatch)),
        }
        Ok(())
    }

    /// A working directory that names a FILE is refused, and the refusal names the folder.
    ///
    /// A file passes every other test in `vet_cwd` -- absolute, resolvable, inside the fence --
    /// so before this the failure surfaced at the spawn as `Os { code: 20, kind: NotADirectory }`
    /// wrapped in two error layers, naming a path the caller never wrote. The assertion is on the
    /// SENTENCE and on the parent it offers, because "it refused" was already true of the broken
    /// version by accident, two layers further down and in words nobody could act on.
    #[tokio::test]
    async fn a_cwd_that_names_a_file_is_refused_and_the_folder_is_named() -> Outcome<()> {
        let file = fmt!("{}/Cargo.toml", root());
        let req = match exec("e10", &["/bin/echo", "hi"]) {
            Req::Exec { id, argv, env, stdin, timeout_ms, capture, fence, .. } =>
                Req::Exec {
                    id, argv, env, stdin, timeout_ms, capture, fence,
                    cwd: file.clone(),
                    toolkits: Vec::new(),
                },
            other => other,
        };
        let rs = res!(run(req).await);
        match rs.first() {
            Some(Resp::Refused { reason, .. }) => {
                assert!(reason.contains("is a file, not a folder"),
                    "the refusal did not say what was wrong: {}", reason);
                assert!(reason.contains(&root()),
                    "the refusal did not name the folder to use instead: {}", reason);
                assert!(!reason.contains("NotADirectory"),
                    "a system error reached the user: {}", reason);
            },
            other => return Err(err!(
                "Expected a refusal, got {:?}.", other; Test, Mismatch)),
        }
        Ok(())
    }

    #[tokio::test]
    async fn test_relative_cwd_is_refused() -> Outcome<()> {
        let req = match exec("e9", &["/bin/echo", "hi"]) {
            Req::Exec { id, argv, env, stdin, timeout_ms, capture, fence, .. } =>
                Req::Exec {
                    id, argv, env, stdin, timeout_ms, capture, fence,
                    cwd: fmt!("relative/place"),
                    toolkits: Vec::new(),
                },
            other => other,
        };
        let rs = res!(run(req).await);
        assert!(matches!(rs.first(), Some(Resp::Refused { .. })));
        Ok(())
    }

    #[tokio::test]
    async fn test_empty_argv_is_refused() -> Outcome<()> {
        let rs = res!(run(exec("e10", &[])).await);
        assert!(matches!(rs.first(), Some(Resp::Refused { .. })));
        Ok(())
    }

    #[tokio::test]
    async fn test_capture_none_yields_no_chunks() -> Outcome<()> {
        let req = match exec("e11", &["/bin/echo", "quiet"]) {
            Req::Exec { id, argv, cwd, env, stdin, timeout_ms, fence, .. } =>
                Req::Exec {
                    id, argv, cwd, env, stdin, timeout_ms, fence,
                    capture: Capture::None,
                    toolkits: Vec::new(),
                },
            other => other,
        };
        let rs = res!(run(req).await);
        assert!(seqs_of(&rs, Stream::Out).is_empty());
        let (exit, ..) = match ended(&rs) {
            Some(e) => e,
            None    => return Err(err!("No Ended was sent."; Test, Missing)),
        };
        assert_eq!(exit, 0);
        Ok(())
    }

    #[tokio::test]
    async fn test_signal_reaches_a_running_command() -> Outcome<()> {
        let runner = res!(runner());
        let (tx, mut rx) = tokio::sync::mpsc::channel::<Resp>(256);
        res!(runner.spawn(exec("s1", &["/bin/sleep", "30"]), tx).await);

        // Wait for it to be announced, then stop it.
        match rx.recv().await {
            Some(Resp::Started { .. }) => {},
            other => return Err(err!("Expected Started, got {:?}.", other; Test, Mismatch)),
        }
        assert_eq!(res!(runner.signal("s1", Sig::Term).await), Signalled::Sent);

        let rs = collect(&mut rx).await;
        let (_, timed_out, killed, _) = match ended(&rs) {
            Some(e) => e,
            None    => return Err(err!("No Ended was sent."; Test, Missing)),
        };
        assert!(killed);
        assert!(!timed_out);
        assert_eq!(res!(runner.live_count()), 0);
        Ok(())
    }

    #[tokio::test]
    async fn test_signalling_a_finished_run_is_not_an_error() -> Outcome<()> {
        let runner = res!(runner());
        let (tx, mut rx) = tokio::sync::mpsc::channel::<Resp>(256);
        res!(runner.spawn(exec("s2", &["/bin/echo", "done"]), tx).await);
        let _ = collect(&mut rx).await;

        assert_eq!(res!(runner.signal("s2", Sig::Kill).await), Signalled::Finished);
        assert_eq!(res!(runner.signal("never-existed", Sig::Term).await), Signalled::Finished);
        Ok(())
    }

    /// A grandchild must not outlive the kill that took its parent.
    ///
    /// `xargs` forks the program it was given and waits on it, and -- unlike
    /// `timeout`, which arranges its child's death itself -- it takes no steps
    /// to bring that child down with it.  So killing the `xargs` process alone
    /// demonstrably leaves the `sleep` running, and only signalling the *group*
    /// takes both.  That is the whole difference between this and killing the
    /// child, and it is what a fenced `cargo test` full of compilers needs.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn test_group_kill_reaps_grandchildren() -> Outcome<()> {
        let runner = res!(runner());
        let (tx, mut rx) = tokio::sync::mpsc::channel::<Resp>(256);
        let req = match exec("g1", &["/usr/bin/xargs", "/bin/sleep"]) {
            Req::Exec { id, argv, cwd, env, timeout_ms, capture, fence, .. } =>
                Req::Exec {
                    id, argv, cwd, env, timeout_ms, capture, fence,
                    stdin: Some(fmt!("47\n")), // The sleep's argument, via the pipe.
                    toolkits: Vec::new(),
                },
            other => other,
        };
        res!(runner.spawn(req, tx).await);

        let pid = match rx.recv().await {
            Some(Resp::Started { pid, .. }) => pid,
            other => return Err(err!("Expected Started, got {:?}.", other; Test, Mismatch)),
        };
        // Give the grandchild time to exist.
        tokio::time::sleep(Duration::from_millis(600)).await;
        assert!(group_members(pid) >= 2, "the grandchild never appeared");

        assert_eq!(res!(runner.signal("g1", Sig::Kill).await), Signalled::Sent);
        let _ = collect(&mut rx).await;
        tokio::time::sleep(Duration::from_millis(600)).await;

        let left = group_members(pid);
        if left != 0 {
            // Do not leave the survivor behind for the next run to trip over.
            let _ = signal_group(pid, Sig::Kill).await;
        }
        assert_eq!(left, 0, "something survived the group kill");
        Ok(())
    }

    // ── BusyBox, in front of the code path ──────────────────────────

    /// Where a BusyBox multi-call binary is looked for.
    ///
    /// The last of the three is the one Debian and Ubuntu ship in the initramfs
    /// tools, which is present on a great many machines that have never
    /// installed BusyBox on purpose.
    #[cfg(target_os = "linux")]
    const BUSYBOX_PATHS: &[&str] = &[
        "/usr/bin/busybox",
        "/bin/busybox",
        "/usr/lib/initramfs-tools/bin/busybox",
    ];

    /// A BusyBox binary on this machine, where there is one.
    #[cfg(target_os = "linux")]
    fn busybox() -> Option<&'static str> {
        BUSYBOX_PATHS.iter().copied().find(|p| Path::new(p).exists())
    }

    /// A directory holding one applet link, so `argv[0]` is `kill`.
    ///
    /// BusyBox dispatches on the name it was invoked as, so a link called `kill`
    /// **is** BusyBox's `kill` and not procps'.  Nothing is simulated here.
    ///
    /// # Arguments
    /// * `bb` - The BusyBox binary.
    /// * `name` - A name unique to the calling test.
    #[cfg(target_os = "linux")]
    fn busybox_kill(bb: &str, name: &str) -> Outcome<PathBuf> {
        let dir = res!(fixture(name)).join("bin");
        res!(std::fs::create_dir_all(&dir));
        let shim = dir.join("kill");
        let _ = std::fs::remove_file(&shim);
        res!(std::os::unix::fs::symlink(bb, &shim), IO, File);
        Ok(shim)
    }

    /// A real BusyBox `kill` reaches the whole group, and reports that it did.
    ///
    /// `REVIEW.md` §3.10, proved rather than reasoned about.  A BusyBox binary is
    /// linked as `kill`, put in front of [`signal_group_with`], and pointed at a
    /// real process group with a real grandchild in it.
    ///
    /// Three things are asserted, and the first two are the finding itself:
    ///
    /// 1. This `kill` genuinely rejects `--`, so the fixture is the thing the
    ///    review named and not a stand-in.
    /// 2. Asking it which form it takes answers `Bare`, while the system's own
    ///    `kill` answers `Separated` -- the two systems disagree, which is why
    ///    one hard-coded spelling cannot serve both.
    /// 3. The group dies, and the answer is `Sent`.  Under the previous code the
    ///    third would have been `Degraded`, and `supervise` would have told the
    ///    page that anything the command started may still be running.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn a_busybox_kill_reaches_the_group_and_says_so() -> Outcome<()> {
        let bb = match busybox() {
            Some(p) => p,
            // No BusyBox here. Say nothing rather than claim a proof.
            None    => return Ok(()),
        };
        let shim = res!(busybox_kill(bb, "busybox-kill"));
        let shim = fmt!("{}", shim.display());

        // 1. It is the `kill` the review named: `--` is refused, and the same
        //    command without it is accepted.
        let sep = res!(Command::new(&shim)
            .arg("-s").arg("0").arg("--").arg(fmt!("{}", std::process::id()))
            .env_clear().stdin(Stdio::null()).output().await
            .map_err(|e| err!(e, "The BusyBox kill could not be run."; Test, IO)));
        assert!(!sep.status.success(),
            "this BusyBox accepts '--', so the finding it stands for is gone");
        assert!(String::from_utf8_lossy(&sep.stderr).contains("--"),
            "expected BusyBox to name the operand it could not read, got {:?}",
            String::from_utf8_lossy(&sep.stderr));
        let bare = res!(Command::new(&shim)
            .arg("-s").arg("0").arg(fmt!("{}", std::process::id()))
            .env_clear().stdin(Stdio::null()).output().await
            .map_err(|e| err!(e, "The BusyBox kill could not be run."; Test, IO)));
        assert!(bare.status.success(), "BusyBox refused the form it is meant to take");

        // 2. Which is what the probe reports, and the two systems differ.
        assert_eq!(Some(Operand::Bare), operand_form(&shim).await);
        for prog in KILL_PROGS {
            if Path::new(prog).exists() {
                assert_eq!(Some(Operand::Separated), operand_form(prog).await,
                    "{} was expected to take the POSIX form", prog);
            }
        }

        // 3. A real group, with a grandchild, signalled through BusyBox alone.
        let mut child = res!(Command::new("/bin/sh")
            .arg("-c").arg("/bin/sleep 30 & /bin/sleep 30")
            .env_clear()
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0)
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| err!(e, "The fixture group could not be started."; Test, IO)));
        let pgid = match child.id() {
            Some(p) => p,
            None    => return Err(err!("The fixture group had no pid."; Test, Missing)),
        };
        tokio::time::sleep(Duration::from_millis(600)).await;
        assert!(group_members(pgid) >= 2, "the fixture group never had a grandchild");

        let said = signal_group_with(&[&shim], pgid, Sig::Kill).await;
        // The leader is reaped first: a zombie is still listed under its group,
        // and counting one would say the kill had failed when it had not.
        let _ = child.wait().await;
        tokio::time::sleep(Duration::from_millis(600)).await;
        let left = group_members(pgid);
        if left != 0 {
            let _ = signal_group(pgid, Sig::Kill).await;
        }
        assert_eq!(Signalling::Sent, said,
            "BusyBox killed the group and the hand called it degraded");
        assert_eq!(0, left, "something survived a BusyBox group kill");
        Ok(())
    }

    /// How many live processes are in the group led by `pgid`.
    ///
    /// # Arguments
    /// * `pgid` - The group, which is the leader's process id.
    #[cfg(target_os = "linux")]
    fn group_members(pgid: u32) -> usize {
        let dir = match std::fs::read_dir("/proc") {
            Ok(d)  => d,
            Err(_) => return 0,
        };
        let mut n = 0;
        for ent in dir.flatten() {
            let name = ent.file_name();
            let name = name.to_string_lossy().to_string();
            if name.parse::<u32>().is_err() {
                continue;
            }
            let stat = match std::fs::read_to_string(fmt!("/proc/{}/stat", name)) {
                Ok(s)  => s,
                Err(_) => continue, // It ended between the listing and the read.
            };
            // The command name is parenthesised and may itself contain spaces,
            // so the fields are counted from the last closing bracket: state,
            // parent, then group.
            let tail = match stat.rfind(')') {
                Some(i) => &stat[i + 1..],
                None    => continue,
            };
            let f = tail.split_whitespace().collect::<Vec<_>>();
            if f.len() < 3 {
                continue;
            }
            if let Ok(g) = f[2].parse::<u32>() {
                if g == pgid {
                    n += 1;
                }
            }
        }
        n
    }

    // ── The launcher, end to end ────────────────────────────────────

    /// The filter is *installed*, not merely written.
    ///
    /// `REVIEW.md` §1.2 and §1.3.  `seccomp.rs` was complete, tested and called
    /// from nowhere: the module's own unit tests passed the whole time the
    /// launcher ran unfiltered, so a unit test on the filter is exactly the
    /// evidence that failed here.  This runs the escape instead, through the real
    /// spawn path and the real launcher.
    ///
    /// The `chmod` half rather than the session-bus half, because it needs
    /// nothing of the machine: no bus, no `systemd-run`, no session at all.  Both
    /// were run against the release binary over a pipe and both are recorded in
    /// `REVIEW.md`; this is the one that can be a test.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn the_filter_is_installed_and_not_merely_written() -> Outcome<()> {
        if !matches!(detected_seccomp(), Seccomp::Linux { .. }) {
            return Ok(()); // No filter here; the hand refuses every command instead.
        }
        let base = res!(fixture("filter-installed"));
        let ws   = base.join("ws");
        let mark = ws.join("private.txt");
        res!(std::fs::write(&mark, "the private thing"));
        res!(set_mode(&mark, 0o600));

        // Broken first: unfenced and unfiltered, this is what the review measured.
        let bare = res!(std::process::Command::new("/bin/chmod")
            .arg("777").arg(&mark).output());
        assert!(bare.status.success(), "the control chmod failed");
        assert_eq!(0o777, res!(mode_of(&mark)), "the control run changed nothing");
        res!(set_mode(&mark, 0o600));

        let rs = res!(run(Req::Exec {
            id:         fmt!("chmod"),
            argv:       vec![fmt!("/bin/chmod"), fmt!("777"), fmt!("{}", mark.display())],
            cwd:        fmt!("{}", ws.display()),
            env:        Vec::new(),
            stdin:      None,
            timeout_ms: 10_000,
            capture:    Capture::Both,
            fence:      FenceSpec {
                rw:   vec![fmt!("{}", ws.display())],
                ro:   Vec::new(),
                deny: Vec::new(),
                net:  false,
            },
            toolkits: Vec::new(),
        }).await);
        let (exit, ..) = match ended(&rs) {
            Some(e) => e,
            None    => return Err(err!("No Ended was sent: {:?}", rs; Test, Missing)),
        };
        // The file is INSIDE the fence and writable, so Landlock permits every
        // part of this. Only the filter refuses it.
        assert_ne!(0, exit, "chmod 777 succeeded behind the filter");
        assert_eq!(0o600, res!(mode_of(&mark)),
            "the mode was changed, so no filter was installed: {}",
            text_of(&rs, Stream::Err));
        assert!(text_of(&rs, Stream::Err).contains("not permitted"),
            "the refusal is not one a build log can explain: {:?}",
            text_of(&rs, Stream::Err));

        // And the trade is still the documented one: a mode that loosens nothing
        // is permitted, because cargo sets 644 on every file it unpacks.
        let rs = res!(run(Req::Exec {
            id:         fmt!("chmod-644"),
            argv:       vec![fmt!("/bin/chmod"), fmt!("644"), fmt!("{}", mark.display())],
            cwd:        fmt!("{}", ws.display()),
            env:        Vec::new(),
            stdin:      None,
            timeout_ms: 10_000,
            capture:    Capture::Both,
            fence:      FenceSpec {
                rw:   vec![fmt!("{}", ws.display())],
                ro:   Vec::new(),
                deny: Vec::new(),
                net:  false,
            },
            toolkits: Vec::new(),
        }).await);
        let (exit, ..) = match ended(&rs) {
            Some(e) => e,
            None    => return Err(err!("No Ended was sent: {:?}", rs; Test, Missing)),
        };
        assert_eq!(0, exit, "chmod 644 was refused, which breaks cargo: {}",
            text_of(&rs, Stream::Err));
        assert_eq!(0o644, res!(mode_of(&mark)));
        Ok(())
    }

    /// A file's permission bits, for the filter test.
    ///
    /// # Arguments
    /// * `p` - The file.
    #[cfg(unix)]
    fn mode_of(p: &Path) -> Outcome<u32> {
        use std::os::unix::fs::PermissionsExt;
        Ok(res!(std::fs::metadata(p), IO, File).permissions().mode() & 0o7777)
    }

    /// The whole point, in one test: a real command, really fenced.
    ///
    /// Both halves are here because either alone proves nothing. The same
    /// `cat`, on the same file, unfenced, must succeed -- otherwise the fenced
    /// refusal might be a missing file, a permission bit or a launcher that
    /// refuses everything. And a file *inside* the fence must still be read,
    /// otherwise the fence is simply a wall.
    #[tokio::test]
    async fn the_launcher_fences_a_real_command() -> Outcome<()> {
        let base = res!(fixture("launcher"));
        let ws = base.join("ws");
        let outside = base.join("outside/other.txt");
        let inside = ws.join("inside.txt");

        // Broken first: unfenced, this reads the file outside the workspace.
        let bare = res!(std::process::Command::new("/bin/cat").arg(&outside).output());
        assert!(bare.status.success(),
            "the control run could not read {} even unfenced", outside.display());
        assert_eq!("other", String::from_utf8_lossy(&bare.stdout));

        let fence = FenceSpec {
            rw:   vec![fmt!("{}", ws.display())],
            ro:   Vec::new(),
            deny: Vec::new(),
            net:  false,
        };
        let at = |id: &str, target: &Path| -> Req {
            Req::Exec {
                id:         fmt!("{}", id),
                argv:       vec![fmt!("/bin/cat"), fmt!("{}", target.display())],
                cwd:        fmt!("{}", ws.display()),
                env:        Vec::new(),
                stdin:      None,
                timeout_ms: 10_000,
                capture:    Capture::Both,
                fence:      fence.clone(),
                toolkits: Vec::new(),
            }
        };

        // Inside the fence: it works, so the fence is a fence and not a wall.
        let rs = res!(run(at("in", &inside)).await);
        let (exit, ..) = match ended(&rs) {
            Some(e) => e,
            None    => return Err(err!("No Ended was sent: {:?}", rs; Test, Missing)),
        };
        assert_eq!(exit, 0, "a granted file was refused: {}", text_of(&rs, Stream::Err));
        assert_eq!(text_of(&rs, Stream::Out), "inside");

        // Outside it: the same program, the same launcher, refused by the
        // kernel. This is the sentence the product's claim rests on.
        let rs = res!(run(at("out", &outside)).await);
        let (exit, ..) = match ended(&rs) {
            Some(e) => e,
            None    => return Err(err!("No Ended was sent: {:?}", rs; Test, Missing)),
        };
        assert_ne!(exit, 0,
            "a fenced command read a file outside its roots: {:?}",
            text_of(&rs, Stream::Out));
        assert_eq!(text_of(&rs, Stream::Out), "",
            "the contents came back anyway");
        Ok(())
    }

    /// The command cannot write outside its fence either, and can inside it.
    #[tokio::test]
    async fn the_launcher_fences_writing_too() -> Outcome<()> {
        let base = res!(fixture("launcher-write"));
        let ws = base.join("ws");
        let fence = FenceSpec {
            rw:   vec![fmt!("{}", ws.display())],
            ro:   Vec::new(),
            deny: Vec::new(),
            net:  false,
        };
        // `tee` writes the file it is named after and copies to stdout, which
        // makes it a writer with no shell redirection anywhere near it.
        let write_to = |id: &str, target: &Path| -> Req {
            Req::Exec {
                id:         fmt!("{}", id),
                argv:       vec![fmt!("/usr/bin/tee"), fmt!("{}", target.display())],
                cwd:        fmt!("{}", ws.display()),
                env:        Vec::new(),
                stdin:      Some(fmt!("written")),
                timeout_ms: 10_000,
                capture:    Capture::Both,
                fence:      fence.clone(),
                toolkits: Vec::new(),
            }
        };

        let outside = base.join("outside/planted.txt");
        let inside = ws.join("made.txt");

        let rs = res!(run(write_to("w-in", &inside)).await);
        assert_eq!(text_of(&rs, Stream::Out), "written");
        assert_eq!("written", res!(std::fs::read_to_string(&inside)));

        let rs = res!(run(write_to("w-out", &outside)).await);
        let (exit, ..) = match ended(&rs) {
            Some(e) => e,
            None    => return Err(err!("No Ended was sent: {:?}", rs; Test, Missing)),
        };
        assert_ne!(exit, 0, "a fenced command wrote outside its roots");
        assert!(!outside.exists(), "the file was created outside the fence");
        Ok(())
    }

    /// The prerequisites named on one line of a cargo dep-info file.
    ///
    /// Make's escaping, which is what the format is: a backslash makes the
    /// character after it ordinary, so a path containing a space survives being
    /// split on whitespace.
    ///
    /// # Arguments
    /// * `list` - Everything after the colon on a dep-info line.
    fn dep_sources(list: &str) -> Vec<PathBuf> {
        let mut out = Vec::new();
        let mut cur = String::new();
        let mut esc = false;
        for c in list.chars() {
            if esc {
                cur.push(c);
                esc = false;
            } else if c == '\\' {
                esc = true;
            } else if c.is_whitespace() {
                if !cur.is_empty() {
                    out.push(PathBuf::from(std::mem::take(&mut cur)));
                }
            } else {
                cur.push(c);
            }
        }
        if !cur.is_empty() {
            out.push(PathBuf::from(cur));
        }
        out
    }

    /// The shipping binary, refused unless it was built from the source that is
    /// in the tree now.
    ///
    /// `cargo test` never builds `daimond-hand`: not `--lib`, and not the whole
    /// suite either, since this crate has no integration test that would make
    /// cargo produce the binary for one. Only a separate `cargo build` refreshes
    /// it, so a test that execs whatever is lying in `target/debug` is measuring
    /// a binary of unknown vintage. That cuts both ways, and the second way is
    /// the dangerous one: a stale binary can fail against source that is fine,
    /// and it can equally pass against source whose fence has since been broken.
    /// `dev/verify_scope.mjs` deletes an inherited `CARGO_TARGET_DIR` for the
    /// same reason -- one there once made a security test pass against a binary
    /// from before the fix.
    ///
    /// The oracle is cargo's own dep-info file, `daimond-hand.d`, written beside
    /// the binary: it names every source that went into it, this crate's and
    /// every fe2o3 crate's, so a change anywhere below the launcher counts.
    /// Where the binary is missing, where that record is missing or does not
    /// describe it, or where any source it names is newer than the binary, this
    /// refuses and says what to run. It does not skip: a fence test that cannot
    /// say which code it measured must not report success.
    fn shipping_hand() -> Outcome<PathBuf> {
        /// What a caller has to run to make this test meaningful again.
        const REBUILD: &str = "cargo build --manifest-path hand/Cargo.toml";

        let exe = res!(std::env::current_exe().map_err(|e| err!(e,
            "The launcher tests need to know their own binary."; Test, IO)));
        let dir = match exe.parent().and_then(|p| p.parent()) {
            Some(d) => d.to_path_buf(),
            None    => return Err(err!(
                "The test binary is not where cargo puts one."; Test, Path)),
        };
        let hand	= dir.join("daimond-hand");
        let record	= dir.join("daimond-hand.d");

        let built = match std::fs::metadata(&hand).and_then(|md| md.modified()) {
            Ok(t)  => t,
            Err(e) => return Err(err!(e,
                "The shipping launcher cannot be tested, because {} is not there to \
                test: `cargo test` does not build that binary, neither with `--lib` \
                nor as the whole suite, so run `{}` and test again.",
                hand.display(), REBUILD; Test, Missing)),
        };
        let listed = match std::fs::read_to_string(&record) {
            Ok(s)  => s,
            Err(e) => return Err(err!(e,
                "The shipping launcher cannot be tested, because {} has no dep-info \
                file at {}, so there is no record of what went into it and its \
                vintage cannot be established: run `{}` and test again.",
                hand.display(), record.display(), REBUILD; Test, Missing)),
        };

        // Cargo writes one line per artefact, `<artefact>: <source> <source> ...`.
        let mut described = false;
        let mut newest: Option<(PathBuf, std::time::SystemTime)> = None;
        for line in listed.lines() {
            let (target, sources) = match line.split_once(':') {
                Some(pair) => pair,
                None       => continue,
            };
            if Path::new(target.trim()) != hand {
                continue;
            }
            described = true;
            for src in dep_sources(sources) {
                let at = match std::fs::metadata(&src).and_then(|md| md.modified()) {
                    Ok(t)  => t,
                    Err(e) => return Err(err!(e,
                        "The shipping launcher cannot be tested, because {} was built \
                        from {}, which can no longer be read, so what is inside the \
                        binary cannot be established: run `{}` and test again.",
                        hand.display(), src.display(), REBUILD; Test, Missing)),
                };
                if newest.as_ref().map_or(true, |(_, t)| at > *t) {
                    newest = Some((src, at));
                }
            }
        }
        if !described {
            return Err(err!(
                "The shipping launcher cannot be tested, because {} says nothing about \
                {}, so the binary is not the one this build produced: run `{}` and test \
                again.",
                record.display(), hand.display(), REBUILD; Test, Mismatch));
        }
        if let Some((src, at)) = newest {
            if at > built {
                let by = match at.duration_since(built) {
                    Ok(d)  => d.as_secs(),
                    Err(_) => 0,
                };
                return Err(err!(
                    "The shipping launcher test would have measured a stale binary, which \
                    proves nothing about the fence in either direction: {} was last changed \
                    {} second(s) after {} was linked, so that binary is not this source -- \
                    run `{}` and test again.",
                    src.display(), by, hand.display(), REBUILD; Test, Mismatch));
            }
        }
        Ok(hand)
    }

    /// The same thing again, through the binary that actually ships.
    ///
    /// [`Launcher::SelfExe`] cannot be exercised from a test binary, because
    /// `/proc/self/exe` there is libtest. This is as close as a test can stand
    /// to it: the real `daimond-hand`, the real [`LAUNCH_ARG`], the real
    /// dispatch in `main`. If that arm is ever moved after something that starts
    /// a runtime, or removed, this test fails and the other one does not.
    ///
    /// The binary is reached through [`shipping_hand`], which refuses rather
    /// than skips where it is absent or older than the source it was built from.
    #[tokio::test]
    async fn the_shipping_launcher_fences_a_real_command() -> Outcome<()> {
        let hand = res!(shipping_hand());

        let base = res!(fixture("launcher-shipping"));
        let ws = base.join("ws");
        let outside = base.join("outside/other.txt");
        let runner = Runner::with_launcher(Launcher::Explicit {
            prog: hand,
            args: vec![fmt!("{}", LAUNCH_ARG)],
            env:  Vec::new(),
        });
        let at = |id: &str, target: &Path| -> Req {
            Req::Exec {
                id:         fmt!("{}", id),
                argv:       vec![fmt!("/bin/cat"), fmt!("{}", target.display())],
                cwd:        fmt!("{}", ws.display()),
                env:        Vec::new(),
                stdin:      None,
                timeout_ms: 10_000,
                capture:    Capture::Both,
                fence:      FenceSpec {
                    rw:   vec![fmt!("{}", ws.display())],
                    ro:   Vec::new(),
                    deny: Vec::new(),
                    net:  false,
                },
                toolkits: Vec::new(),
            }
        };

        // No harness in the way this time, so the output is exact.
        let (tx, mut rx) = tokio::sync::mpsc::channel::<Resp>(256);
        res!(runner.spawn(at("ship-in", &ws.join("inside.txt")), tx).await);
        let rs = collect(&mut rx).await;
        let mut said = String::new();
        for r in &rs {
            if let Resp::Chunk { stream: Stream::Out, data, .. } = r {
                said.push_str(data);
            }
        }
        assert_eq!(said, "inside", "the shipping launcher garbled a granted read");

        let (tx, mut rx) = tokio::sync::mpsc::channel::<Resp>(256);
        res!(runner.spawn(at("ship-out", &outside), tx).await);
        let rs = collect(&mut rx).await;
        let (exit, ..) = match ended(&rs) {
            Some(e) => e,
            None    => return Err(err!("No Ended was sent: {:?}", rs; Test, Missing)),
        };
        assert_ne!(exit, 0,
            "the shipping launcher ran a command that read outside its fence");
        assert_ne!(exit, EXIT_FENCE_FAILED,
            "the fence could not be applied at all, so this proved nothing: {}",
            text_of(&rs, Stream::Err));
        Ok(())
    }

    // ── The credential scanner a fence used to switch off in silence ────────

    /// **A fenced commit that would run without the user's `pre-commit` hook is refused,
    /// and one that can reach it is scanned.**
    ///
    /// Against a real git behind a real Landlock fence through the shipping binary, because
    /// every layer between the configuration and the hook is one that could drop it.
    ///
    /// # What is silent here and what is not, measured rather than assumed
    ///
    /// Two of the three ways a fenced commit loses the user's hooks are LOUD on git 2.53,
    /// and this test does not claim otherwise.  A fence that cannot reach `~/.gitconfig`
    /// gives `fatal: unknown error occurred while reading the configuration files`; a fence
    /// that reaches the configuration but not the hooks directory gives `fatal: cannot exec
    /// '.../pre-commit': Permission denied`, because Landlock does not restrict `access`, so
    /// git finds the hook and dies on `execve`.  Neither commits anything.  They are refused
    /// here all the same -- ahead of the command, with a sentence naming the grant that
    /// would fix it -- because those two messages describe a broken repository rather than a
    /// missing permission, and because "loud" is a property of one git and one kernel: git's
    /// own `find_hook` returns NULL on an `EACCES` from `access` and merely warns.
    ///
    /// The third is genuinely silent, reproduces here, and is the one this test RUNS: a
    /// repository whose own `.git/config` sets `core.hooksPath` at a directory of its own.
    /// `.git/config` is inside the fence and a command may write it, so a turn can point the
    /// hooks at an empty folder it just made -- and the commit then succeeds, exit 0, no
    /// message, the example key in the repository, scanner never run.  That command
    /// is then handed to [`git_hooks_refusal`], which is what now stops it running at all.
    ///
    /// The last part is the same fence with the Git toolchain granted and no override: the
    /// hooks directory goes into the fence, the hook runs, the commit fails with the hook's
    /// own words, and nothing is committed.  The absence of the commit is the property; an
    /// exit code is not, since a hook that refuses after the commit exists is not a scanner.
    ///
    /// The value the fixture stages is AWS's own published example access key, which is a
    /// credential to nothing.  It is that one because it is what the machine's real scanner
    /// looks for, and a fixture the scanner would ignore would prove nothing.
    #[tokio::test]
    async fn a_fenced_commit_without_the_users_hooks_is_refused() -> Outcome<()> {
        let hand = res!(shipping_hand());
        let base = res!(fixture("git-hooks"));
        let hooks  = base.join("hooks");
        let home   = base.join("home");
        let silent = base.join("ws/silent");
        let hooked = base.join("ws/hooked");
        for d in [&hooks, &home, &silent, &hooked] {
            res!(std::fs::create_dir_all(d));
        }

        // allowlist secret
        let key = "AKIAIOSFODNN7EXAMPLE";
        // The scanner, in miniature: it refuses a commit that stages the example key.
        let hook = hooks.join("pre-commit");
        res!(std::fs::write(&hook, fmt!(
            "#!/bin/sh\n\
             if grep -rq {} .; then\n\
             \techo 'pre-commit: a credential is staged' >&2\n\
             \texit 1\n\
             fi\n\
             exit 0\n", key)));
        res!(std::fs::set_permissions(&hook,
            <std::fs::Permissions as std::os::unix::fs::PermissionsExt>::from_mode(0o755)));

        // The user's own global configuration, which is where `core.hooksPath` lives on the
        // machine this was written on. Reached through `GIT_CONFIG_GLOBAL` so that nothing
        // here touches the real one.
        let cfg = home.join(".gitconfig");
        res!(std::fs::write(&cfg, fmt!(
            "[user]\n\tname = Fixture\n\temail = fixture@example.invalid\n\
             [core]\n\thooksPath = {}\n", hooks.display())));
        // What the hand reads the user's configuration WITH. In the hand this is empty and
        // the real configuration answers; here it names the fixture.
        let readenv: Vec<(String, String)> = vec![
            (fmt!("GIT_CONFIG_GLOBAL"), fmt!("{}", cfg.display())),
        ];
        // What a command runs with WITHOUT the Git toolchain, which is the ordinary case:
        // the app sets `HOME` for that toolkit and for no other, so a fenced git has no
        // home to find a global configuration in and never learns `core.hooksPath` exists.
        // It does not complain -- git skips a global configuration it cannot NAME in
        // silence, and fails loudly only over one it was told to read and could not.
        let barenv: Vec<(String, String)> = vec![
            (fmt!("PATH"), fmt!("/usr/bin:/bin")),
        ];
        // And with it: `HOME` set, which is the whole of how git finds the user's own
        // configuration.
        let cmdenv: Vec<(String, String)> = vec![
            (fmt!("HOME"),              fmt!("{}", home.display())),
            (fmt!("PATH"),              fmt!("/usr/bin:/bin")),
        ];

        // Setting a repository up is done OUTSIDE the fence and stops short of a commit, so
        // the only commits in this test are the fenced ones under test.
        let git = |at: &Path, args: &[&str]| -> Outcome<()> {
            let mut c = std::process::Command::new("git");
            c.args(args).current_dir(at);
            for (k, v) in &cmdenv { c.env(k, v); }
            let out = res!(c.output());
            if !out.status.success() {
                return Err(err!("git {:?} failed: {}", args,
                    String::from_utf8_lossy(&out.stderr); Test, IO));
            }
            Ok(())
        };
        let leak = fmt!("AWS_ACCESS_KEY_ID={}\n", key);
        for repo in [&silent, &hooked] {
            res!(git(repo, &["init", "-q", "-b", "main"]));
            // A real clone carries its own identity, which is why a fenced commit that can
            // read nothing global still had everything it needed to succeed.
            res!(git(repo, &["config", "user.name", "Fixture"]));
            res!(git(repo, &["config", "user.email", "fixture@example.invalid"]));
            res!(std::fs::write(repo.join("config.env"), &leak));
            res!(git(repo, &["add", "config.env"]));
        }

        let runner = Runner::with_launcher(Launcher::Explicit {
            prog: hand,
            args: vec![fmt!("{}", LAUNCH_ARG)],
            env:  Vec::new(),
        });
        let commit = |id: &str, at: &Path, fence: &FenceSpec, kits: &[String],
            env: &[(String, String)]| Req::Exec
        {
            id:         fmt!("{}", id),
            argv:       vec![fmt!("/usr/bin/git"), fmt!("commit"), fmt!("-m"), fmt!("add config")],
            cwd:        fmt!("{}", at.display()),
            env:        env.to_vec(),
            stdin:      None,
            timeout_ms: 30_000,
            capture:    Capture::Both,
            fence:      fence.clone(),
            toolkits:   kits.to_vec(),
        };
        let commits_in = |at: &Path| -> Outcome<String> {
            let out = res!(std::process::Command::new("git")
                .args(["log", "--oneline"]).current_dir(at).output());
            Ok(fmt!("{}", String::from_utf8_lossy(&out.stdout).trim()))
        };

        // ── The silence, run rather than described ──────────────────────
        //
        // Everything granted: the Git toolchain, so `~/.gitconfig` is readable, and the
        // hooks directory it names. The one thing wrong is inside the fence -- the
        // repository's own configuration, which a command may write.
        let kits = vec![fmt!("git")];
        let mut spec = FenceSpec {
            rw:   vec![fmt!("{}", base.join("ws").display())],
            ro:   vec![fmt!("{}", home.display())],
            deny: Vec::new(),
            net:  false,
        };
        let granted = grant_git_hooks(&mut spec, &kits, &readenv);
        assert_eq!(granted.as_deref(), Some(hooks.as_path()),
            "the user's own hooks directory was not added to the fence: {:?}", spec.ro);

        res!(std::fs::create_dir_all(silent.join("mine")));
        res!(git(&silent, &["config", "core.hooksPath",
            &fmt!("{}", silent.join("mine").display())]));
        let (tx, mut rx) = tokio::sync::mpsc::channel::<Resp>(256);
        res!(runner.spawn(commit("silent", &silent, &spec, &kits, &cmdenv), tx).await);
        let rs = collect(&mut rx).await;
        let (exit, ..) = match ended(&rs) {
            Some(e) => e,
            None    => return Err(err!("No Ended was sent: {:?}", rs; Test, Missing)),
        };
        assert_ne!(exit, EXIT_FENCE_FAILED,
            "the fence could not be applied, so this proved nothing: {}",
            text_of(&rs, Stream::Err));
        assert_eq!(exit, 0,
            "the fenced commit did not succeed, so the silence this test is about did not \
             happen here and the refusal below would be measuring nothing: {}",
            text_of(&rs, Stream::Err));
        assert!(!res!(commits_in(&silent)).is_empty(),
            "nothing was committed, so there is no silent commit to refuse");
        assert_eq!(text_of(&rs, Stream::Err), "",
            "git said something about the hook it did not run, so this was never silent");

        // And that is the command the hand now refuses, before it runs, naming the
        // directory the repository chose and the one the user configured.
        let plan = res!(detected_fence().plan(&spec, &Unfenced::Refuse));
        let said = match git_hooks_refusal(&plan,
            &[fmt!("/usr/bin/git"), fmt!("commit"), fmt!("-m"), fmt!("x")],
            &fmt!("{}", silent.display()), &readenv)
        {
            Some(s) => s,
            None    => return Err(err!(
                "the command that just committed the example key in silence was \
                allowed"; Test, Missing)),
        };
        assert!(said.starts_with("Refused: "), "the refusal did not read as one: {}", said);
        assert!(said.contains("mine"),
            "the refusal did not name the directory the repository chose: {}", said);
        assert!(said.contains(&fmt!("{}", hooks.display())),
            "the refusal did not name the directory the user configured: {}", said);

        // The two loud ones are refused as well, ahead of the command and with a better
        // sentence than git's own. A fence reaching neither the configuration nor the hooks
        // is the ordinary case: git needs no toolkit to commit, and the app sets `HOME` for
        // that toolkit alone.
        let bare = FenceSpec {
            rw:   vec![fmt!("{}", base.join("ws").display())],
            ro:   Vec::new(),
            deny: Vec::new(),
            net:  false,
        };
        let noconf = res!(detected_fence().plan(&bare, &Unfenced::Refuse));
        let said = match git_hooks_refusal(&noconf,
            &[fmt!("/usr/bin/git"), fmt!("commit")], &fmt!("{}", silent.display()), &readenv)
        {
            Some(s) => s,
            None    => return Err(err!(
                "a commit whose fence cannot reach the user's git configuration was \
                allowed"; Test, Missing)),
        };
        assert!(said.contains(&fmt!("{}", cfg.display())),
            "the refusal did not name the configuration git could not read: {}", said);
        assert!(said.contains("Git toolchain"),
            "the refusal did not say what would fix it: {}", said);
        // The configuration reachable and the hooks directory not.
        let halfway = FenceSpec {
            rw:   vec![fmt!("{}", base.join("ws").display())],
            ro:   vec![fmt!("{}", home.display())],
            deny: Vec::new(),
            net:  false,
        };
        let nohooks = res!(detected_fence().plan(&halfway, &Unfenced::Refuse));
        let said = match git_hooks_refusal(&nohooks,
            &[fmt!("/usr/bin/git"), fmt!("commit")], &fmt!("{}", hooked.display()), &readenv)
        {
            Some(s) => s,
            None    => return Err(err!(
                "a commit whose fence cannot reach the hooks directory was allowed";
                Test, Missing)),
        };
        assert!(said.contains(&fmt!("{}", hooks.display())),
            "the refusal did not name the hooks directory: {}", said);

        // And one of the loud ones is RUN, once, so the paragraph above is a measurement
        // rather than a claim: with nothing granted the same command dies inside git and
        // leaves the repository where it was.
        let (tx, mut rx) = tokio::sync::mpsc::channel::<Resp>(256);
        res!(runner.spawn(commit("loud", &hooked, &bare, &[], &barenv), tx).await);
        let rs = collect(&mut rx).await;
        let (exit, ..) = match ended(&rs) {
            Some(e) => e,
            None    => return Err(err!("No Ended was sent: {:?}", rs; Test, Missing)),
        };
        assert_ne!(exit, 0,
            "a commit whose fence reaches no git configuration succeeded: {}",
            text_of(&rs, Stream::Err));
        assert_eq!(res!(commits_in(&hooked)), "",
            "it committed anyway");

        // A command that runs no hook is left alone: this refuses a commit, not git.
        for harmless in [vec![fmt!("git"), fmt!("status")], vec![fmt!("git"), fmt!("log")],
            vec![fmt!("git"), fmt!("push")], vec![fmt!("cargo"), fmt!("test")]]
        {
            assert!(git_hooks_refusal(&noconf, &harmless,
                &fmt!("{}", silent.display()), &readenv).is_none(),
                "{:?} was refused for a hook it does not run", harmless);
        }
        // `git -C <dir> commit` is still a commit: the verb is not always argv[1].
        assert!(git_hooks_refusal(&noconf,
            &[fmt!("git"), fmt!("-C"), fmt!("elsewhere"), fmt!("commit")],
            &fmt!("{}", silent.display()), &readenv).is_some(),
            "a commit spelled with -C was not seen as one");

        // ── The same fence, and a repository that leaves the hooks alone ─
        assert!(git_hooks_refusal(&plan,
            &[fmt!("/usr/bin/git"), fmt!("commit")], &fmt!("{}", hooked.display()), &readenv)
            .is_none(),
            "a commit that can reach the user's hooks was refused anyway");

        let (tx, mut rx) = tokio::sync::mpsc::channel::<Resp>(256);
        res!(runner.spawn(commit("hooked", &hooked, &spec, &kits, &cmdenv), tx).await);
        let rs = collect(&mut rx).await;
        let (exit, ..) = match ended(&rs) {
            Some(e) => e,
            None    => return Err(err!("No Ended was sent: {:?}", rs; Test, Missing)),
        };
        let err = text_of(&rs, Stream::Err);
        assert_ne!(exit, EXIT_FENCE_FAILED,
            "the fence could not be applied, so this proved nothing: {}", err);
        assert!(err.contains("a credential is staged"),
            "the hook the user configured did not run: exit {}, stderr {:?}", exit, err);
        assert_eq!(res!(commits_in(&hooked)), "",
            "the credential was committed even though the hook ran");

        Ok(())
    }

    /// The plan reaches the launcher and is not visible to the command.
    ///
    /// The command's own view of itself is `/proc/self/cmdline` and
    /// `/proc/self/environ`; neither may carry the fence. `/proc` is outside
    /// every fence this hand builds, so the test grants it read-only on purpose
    /// -- proving the property in the one configuration where the command could
    /// possibly look.
    #[tokio::test]
    async fn the_command_cannot_read_its_own_fence() -> Outcome<()> {
        let base = res!(fixture("launcher-opaque"));
        let ws = base.join("ws");
        let req = Req::Exec {
            id:         fmt!("opaque"),
            argv:       vec![fmt!("/bin/cat"), fmt!("/proc/self/cmdline")],
            cwd:        fmt!("{}", ws.display()),
            env:        Vec::new(),
            stdin:      None,
            timeout_ms: 10_000,
            capture:    Capture::Both,
            fence:      FenceSpec {
                rw:   vec![fmt!("{}", ws.display())],
                ro:   vec![fmt!("/proc")],
                deny: Vec::new(),
                net:  false,
            },
            toolkits: Vec::new(),
        };
        let rs = res!(run(req).await);
        let said = text_of(&rs, Stream::Out);
        // The program really is `cat`, although not by the name it was asked
        // for: this machine's /bin/cat resolves into a multi-call binary, and
        // `argv[0]` is the resolved path because that is what actually ran.
        assert!(said.contains("cat\0/proc/self/cmdline"),
            "the command did not see itself: {:?}", said);
        assert!(!said.contains(LAUNCH_ARG),
            "the launcher's own argument survived into the command: {:?}", said);
        assert!(!said.contains(&fmt!("{}", ws.display())),
            "a fence path was readable in the command's own argv: {:?}", said);

        // And the same question of the environment, which is the other half of
        // what `/proc/self` will answer.
        let req = Req::Exec {
            id:         fmt!("opaque-env"),
            argv:       vec![fmt!("/bin/cat"), fmt!("/proc/self/environ")],
            cwd:        fmt!("{}", ws.display()),
            env:        vec![(fmt!("MARKER"), fmt!("kept"))],
            stdin:      None,
            timeout_ms: 10_000,
            capture:    Capture::Both,
            fence:      FenceSpec {
                rw:   vec![fmt!("{}", ws.display())],
                ro:   vec![fmt!("/proc")],
                deny: Vec::new(),
                net:  false,
            },
            toolkits: Vec::new(),
        };
        let rs = res!(run(req).await);
        let said = text_of(&rs, Stream::Out);
        // The one path of its own fence a command is told: where to write
        // temporary files. It has to be told, or it cannot use it -- and it
        // names a directory made for this run alone, not a Diamond's workspace.
        let scratch = match said.split('\0').find(|v| v.starts_with("TMPDIR=")) {
            Some(v) => fmt!("{}", &v["TMPDIR=".len()..]),
            None    => return Err(err!(
                "The command was not told where to write: {:?}", said; Test, Missing)),
        };
        let mut pairs = said.split('\0')
            .filter(|v| !v.is_empty())
            .map(|v| fmt!("{}", v))
            .collect::<Vec<_>>();
        pairs.sort();
        let mut want = vec![fmt!("MARKER=kept")];
        for name in TMP_VARS {
            want.push(fmt!("{}={}", name, scratch));
        }
        // The two the hand fills in where the request named neither. Neither
        // says anything about the fence: `HOME` is the user's own home and
        // `PATH` is the fixed system list, and the assertion below is what holds
        // that.
        for name in ENV_DEFAULTED {
            if let Some(v) = default_env(name) {
                want.push(fmt!("{}={}", name, v));
            }
        }
        want.sort();
        assert_eq!(pairs, want,
            "the command's environment is not exactly what it was given");
        assert!(!said.contains(&fmt!("{}", ws.display())),
            "a fence path was readable in the command's own environment: {:?}", said);
        Ok(())
    }

    // ── The file door, proved through the kernel ────────────────────────────
    //
    // Every test below drives the SHIPPING launcher, not a stub, because the claim being
    // made is about what the kernel does to a real child. A test that called `do_file`
    // directly would prove that the code opens files, which nobody doubted; what is in
    // question is whether a file tool reaching this machine is fenced exactly as a command
    // is, and only a fenced process can answer that.

    /// The answer one file op gives, or the refusal, driven through the real launcher.
    #[cfg(unix)]
    async fn filed(files: &Files, ws: &Path, op: FileOp) -> Outcome<(bool, String)> {
        let req = Req::File {
            id:    fmt!("f-{}", op.word()),
            op,
            cwd:   fmt!("{}", ws.display()),
            fence: FenceSpec {
                rw:   vec![fmt!("{}", ws.display())],
                ro:   Vec::new(),
                deny: Vec::new(),
                net:  false,
            },
            toolkits: Vec::new(),
        };
        let (tx, mut rx) = tokio::sync::mpsc::channel::<Resp>(16);
        res!(files.apply(req, tx).await);
        let rs = collect(&mut rx).await;
        for r in &rs {
            match r {
                Resp::Filed { ok, text, .. }	=> return Ok((*ok, text.clone())),
                Resp::Refused { reason, .. }	=> return Ok((false, reason.clone())),
                _				=> (),
            }
        }
        Err(err!("Nothing came back from a file request: {:?}", rs; Test, Missing))
    }

    /// A door onto the real launcher.
    #[cfg(unix)]
    fn file_door() -> Outcome<Files> {
        Ok(Files::with_launcher(Launcher::Explicit {
            prog: res!(shipping_hand()),
            args: vec![fmt!("{}", LAUNCH_ARG)],
            env:  Vec::new(),
        }))
    }

    /// A file inside the fence is read, changed and read back, with no command anywhere.
    ///
    /// This is the whole of what `dev/BLOCKERS.md` B2 says is missing, asserted at the layer
    /// that would have to provide it: one exact-string replacement, applied by the hand,
    /// with nothing quoted through a shell and nothing to escape.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_file_inside_the_fence_is_edited_without_a_command() -> Outcome<()> {
        let base = res!(fixture("file-door-edit"));
        let ws = base.join("ws");
        let files = res!(file_door());

        // The character that cost 71 calls, in the string being written, unescaped.
        let target = ws.join("fr.js");
        res!(std::fs::write(&target, "a\n'k': 'old',\nb\n"));

        let (ok, said) = res!(filed(&files, &ws, FileOp::Edit {
            path: fmt!("{}", target.display()),
            old:  fmt!("'k': 'old',"),
            new:  fmt!("'k': 'Enregistrer l\u{2019}\u{e9}crit dans {{place}}.',"),
        }).await);
        assert!(ok, "an edit inside the fence was refused: {}", said);
        let after = res!(std::fs::read_to_string(&target).map_err(|e| err!(e,
            "the edited file could not be read back"; Test, IO)));
        assert!(after.contains("Enregistrer l\u{2019}\u{e9}crit dans {place}."),
            "the edit did not land: {:?}", after);

        // And the read door answers about the same file, so the two halves agree.
        let (ok, text) = res!(filed(&files, &ws, FileOp::Read {
            path:   fmt!("{}", target.display()),
            offset: 2,
            limit:  1,
        }).await);
        assert!(ok, "a read inside the fence was refused: {}", text);
        let (head, body) = match text.split_once('\n') {
            Some((a, b)) => (a.to_string(), b.to_string()),
            None         => return Err(err!("A read answered without its numbers: {:?}",
                text; Test, Invalid)),
        };
        let cols: Vec<&str> = head.split('\t').collect();
        assert_eq!(cols.len(), 3,
            "a read must open with the file's lines, its bytes and the lines sent: {:?}", head);
        assert_eq!(cols[0], "3", "the read miscounted the file's lines");
        assert_eq!(cols[2], "1", "the read did not say how many lines it was sending");
        assert!(body.contains("Enregistrer"), "the read returned the wrong line: {:?}", body);
        Ok(())
    }

    // ── The two answers a big file gets ─────────────────────────────────────
    //
    // The fixture is this repository's own `src/tools.rs`, and it is the fixture because it is
    // what both blockers were measured on: 1.2 MB and 22,000-odd lines, larger than the read
    // frame twice over and three times the whole search answer. A file made up for the
    // occasion would be the same size only until someone changed the constant.

    /// The repository this crate sits in, which holds the file both tests below are about.
    #[cfg(unix)]
    fn repo_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
    }

    /// **A read of a file bigger than one frame says how big the FILE is.**
    ///
    /// `dev/BLOCKERS.md` B18, at the end that knows the answer: the hand held the whole file
    /// and the page did not, so a count taken after the cut was a count of the cut.
    /// `src/tools.rs` came back as *"lines 1-200 of 9304 (524403 bytes)"* -- 524,403 being
    /// [`FILE_TEXT_MAX`] and a note, not a file -- and the offset the answer named to continue
    /// from was twelve thousand lines short of the end.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_read_of_a_file_bigger_than_one_frame_says_how_big_the_file_is() -> Outcome<()> {
        let root = repo_root();
        let big = root.join("src/tools.rs");
        let text = res!(std::fs::read_to_string(&big).map_err(|e| err!(e,
            "this crate's own repository must hold src/tools.rs"; Test, IO)));
        assert!(text.len() > FILE_TEXT_MAX * 2,
            "the fixture must be bigger than one frame twice over: {} bytes", text.len());
        let lines = text.lines().count();
        let files = res!(file_door());

        let (ok, said) = res!(filed(&files, &root, FileOp::Read {
            path:   fmt!("{}", big.display()),
            offset: 1,
            limit:  2_000,
        }).await);
        assert!(ok, "a read of this repository's own source was refused: {}", said);
        let (head, body) = match said.split_once('\n') {
            Some(p) => p,
            None    => return Err(err!("A read answered without its numbers"; Test, Invalid)),
        };
        let cols: Vec<&str> = head.split('\t').collect();
        assert_eq!(cols.len(), 3, "a read must open with three numbers: {:?}", head);
        assert_eq!(cols[0], fmt!("{}", lines),
            "the read counted the answer's lines rather than the file's: {:?}", head);
        assert_eq!(cols[1], fmt!("{}", text.len()),
            "the read gave the answer's length as the file's: {:?}", head);
        assert_eq!(cols[2], "2000", "2,000 lines were asked for: {:?}", head);
        // Split INCLUSIVE, because every line the hand sends ends with its own newline: that is
        // what makes a window whose last line is blank countable at all.
        assert_eq!(body.split_inclusive('\n').count(), 2_000,
            "the answer does not hold the lines it says it holds");

        // AND THE END OF THE FILE IS REACHABLE, which is the half that cost the run. Every line
        // past the frame used not to exist to be asked for: the whole file was asked for, cut,
        // and paged over its own truncation.
        let want = 10;
        let (ok, said) = res!(filed(&files, &root, FileOp::Read {
            path:   fmt!("{}", big.display()),
            offset: (lines - want + 1) as u32,
            limit:  want as u32,
        }).await);
        assert!(ok, "a read of the file's last lines was refused: {}", said);
        let (head, body) = match said.split_once('\n') {
            Some(p) => p,
            None    => return Err(err!("A read answered without its numbers"; Test, Invalid)),
        };
        let cols: Vec<&str> = head.split('\t').collect();
        assert_eq!(cols[0], fmt!("{}", lines), "the file's length changed between two reads");
        assert_eq!(cols[2], fmt!("{}", want), "the last lines of the file did not come back");
        let last = match text.lines().last() {
            Some(l) => l,
            None    => return Err(err!("the fixture has no last line"; Test, Invalid)),
        };
        assert!(body.ends_with(&fmt!("{}\n", last)),
            "the last line of the file is not the last line of a read that asked for it");
        Ok(())
    }

    /// **A listing too big for one frame says how much of the directory it is showing.**
    ///
    /// The family the two blockers belong to: an answer that was cut has to say so in a number
    /// the caller can act on. A listing used to be cut as one string and end with `read`'s
    /// advice -- *"ask for the rest by line range"* -- which `list` does not take, so a caller
    /// following it had nowhere to go.
    ///
    /// `list_op` directly, and not through the launcher as the tests above are: what is in
    /// question here is a sentence, not a fence, and ten thousand files is a slow way to prove
    /// nothing about the kernel.
    #[cfg(unix)]
    #[test]
    fn a_listing_too_big_for_one_frame_says_how_much_of_it_is_shown() -> Outcome<()> {
        let base = res!(fixture("file-door-listing"));
        let dir = base.join("many");
        res!(std::fs::create_dir_all(&dir));
        // Enough names to outgrow one frame, each long enough that the count is not the cost.
        let each = 60;
        let want = (FILE_TEXT_MAX / each) + 200;
        for i in 0..want {
            res!(std::fs::write(dir.join(fmt!("{:0w$}", i, w = each)), b""));
        }
        let (ok, said) = list_op(&fmt!("{}", dir.display()));
        assert!(ok, "a listing was refused: {}", said);
        assert!(said.len() <= FILE_TEXT_MAX + 400,
            "the listing outgrew what one frame carries: {} bytes", said.len());
        assert!(said.contains(&fmt!("of {} entries", want)),
            "the listing does not say how many entries the directory holds: {:?}",
            said.chars().rev().take(300).collect::<String>());
        assert!(said.contains("file_glob"),
            "the listing says it was cut and names nothing that would answer instead");
        assert!(!said.contains("line range"),
            "the listing offers a range, which file_list does not take");
        Ok(())
    }

    /// **A line the matcher could not decide travels with the lines that matched.**
    ///
    /// The hand decides what to leave behind now, and "did not match" and "could not be
    /// decided" are different answers with the same shape. A line the matcher gave up on has to
    /// cross, or the page counts it as a line that did not match and a pattern that decides
    /// nothing answers "No matches" with nothing beside it. The page names such lines in its
    /// notes, and it can only name what it was sent.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_line_the_matcher_could_not_decide_travels_with_the_rest() -> Outcome<()> {
        let base = res!(fixture("file-door-undecided"));
        let ws = base.join("ws");
        let files = res!(file_door());
        res!(std::fs::create_dir_all(&ws));
        // A backtracker, so this stays true of a matcher whose limits change.
        let hay = fmt!("harmless\n{}c\n", "a".repeat(40));
        res!(std::fs::write(ws.join("hard.txt"), &hay));

        let (ok, said) = res!(filed(&files, &ws, FileOp::Search {
            paths:  vec![fmt!("{}", ws.display())],
            query:  fmt!("(a+)+b"),
            ci:     false,
            glob:   String::new(),
            base:   String::new(),
            skip:   Vec::new(),
            budget: 5_000,
            cap:    1_000_000,
        }).await);
        assert!(ok, "a search was refused: {}", said);
        assert!(said.contains("hard.txt"),
            "the file holding a line the matcher gave up on was passed over in silence: {:?}",
            said);
        assert!(said.contains(&"a".repeat(40)),
            "the line itself did not travel, so nothing can say its answer is unknown: {:?}",
            said);
        Ok(())
    }

    /// **A search finds a name in a file no frame could carry.**
    ///
    /// `dev/BLOCKERS.md` B17. The answer used to be the whole TEXT of every matching file, so
    /// its size was the size of the files rather than of what matched: `src/tools.rs` at
    /// 1,211,990 bytes against a 384 KiB ceiling was passed over with the answer still empty,
    /// and no `glob` or `path` a caller could write made one file smaller. Eight searches in one
    /// turn, every one "No matches", for a name that is in it.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_search_finds_a_name_in_a_file_too_big_to_carry_whole() -> Outcome<()> {
        let root = repo_root();
        let big = root.join("src/tools.rs");
        let text = res!(std::fs::read_to_string(&big).map_err(|e| err!(e,
            "this crate's own repository must hold src/tools.rs"; Test, IO)));
        assert!(text.len() > SEARCH_ANSWER_MAX,
            "the fixture must be bigger than one whole search answer: {} bytes", text.len());
        // A name that is in that file and in no other, so finding it is finding THAT file.
        let name = "test_the_search_agrees_with_grep_over_this_crates_own_source";
        assert!(text.contains(name), "the fixture no longer holds the name it is searched for");
        let files = res!(file_door());

        let (ok, said) = res!(filed(&files, &root, FileOp::Search {
            paths:  vec![fmt!("{}", root.join("src").display())],
            query:  fmt!("{}", name),
            ci:     false,
            glob:   String::new(),
            base:   String::new(),
            skip:   Vec::new(),
            budget: 20_000,
            cap:    2_000_000,
        }).await);
        assert!(ok, "a search of this repository's own source was refused: {}", said);
        assert!(said.contains("tools.rs"),
            "THE SEARCH PASSED OVER THE ONE FILE HOLDING THE NAME: {:?}",
            said.chars().take(400).collect::<String>());
        assert!(said.contains(name),
            "the search named the file and carried no line of it: {:?}",
            said.chars().take(400).collect::<String>());
        let cols: Vec<&str> = match said.split('\n').next() {
            Some(h) => h.split('\t').collect(),
            None    => return Err(err!("a search answered nothing at all"; Test, Missing)),
        };
        assert_eq!(cols[8], "0",
            "a file was left out of the answer for want of room, which over a search for one \
            name means the lines are not what is being sent: {:?}", cols);
        // The whole answer is a fraction of the one file it is about, which is what makes the
        // ceiling a ceiling on the ANSWER rather than on the size of a file.
        assert!(said.len() < text.len() / 4,
            "the answer is {} bytes about a {} byte file, so whole texts are still crossing",
            said.len(), text.len());
        Ok(())
    }

    /// A search walks the fence and stops at its edge, and it never carries a byte from outside.
    ///
    /// The pair is the point. A walk that refused everything would satisfy a refusal on its own,
    /// so the file INSIDE the fence must come back in the same call that proves the file outside
    /// it does not -- and the one outside holds a nonce, so a leak would be unmistakable rather
    /// than inferred from a count.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_search_reaches_the_fence_and_stops_at_its_edge() -> Outcome<()> {
        let base = res!(fixture("file-door-search"));
        let ws = base.join("ws");
        let files = res!(file_door());
        res!(std::fs::create_dir_all(ws.join("deep/er")));
        res!(std::fs::write(ws.join("deep/er/hit.rs"), "fn main() {}\nlet NEEDLE_ONE = 1;\n"));
        res!(std::fs::write(ws.join("deep/miss.rs"), "nothing of interest here\n"));
        res!(std::fs::write(base.join("outside/secret.txt"), "NEEDLE_ONE lives here too\n"));

        let (ok, text) = res!(filed(&files, &ws, FileOp::Search {
            paths:  vec![fmt!("{}", ws.display())],
            query:  fmt!("NEEDLE_ONE"),
            ci:     false,
            glob:   String::new(),
            base:   String::new(),
            skip:   Vec::new(),
            budget: 5_000,
            cap:    1_000_000,
        }).await);
        assert!(ok, "a search inside the fence was refused: {}", text);
        assert!(text.contains("deep/er/hit.rs"),
            "the search did not find the file it was pointed at: {:?}", text);
        assert!(text.contains("let NEEDLE_ONE = 1;"),
            "the search returned no text for the file it matched: {:?}", text);
        assert!(!text.contains("miss.rs"),
            "the search carried a file its pattern does not match: {:?}", text);
        // ── AND POINTED STRAIGHT AT THE OUTSIDE, WHICH IS THE REAL CLAIM ──────
        //
        // The assertions above prove only that the walk starts where it was told: they stay
        // green with the fence widened to the parent, which was measured before this block
        // was written and is the reason it exists. A walk is fenced only if a walk AIMED at
        // the far side comes back with nothing -- and the kernel's refusal, seen from inside
        // the launcher, is `read_dir` failing, which is counted rather than swallowed.
        let (ok, text) = res!(filed(&files, &ws, FileOp::Search {
            paths:  vec![fmt!("{}", base.join("outside").display())],
            query:  fmt!("NEEDLE_ONE"),
            ci:     false,
            glob:   String::new(),
            base:   String::new(),
            skip:   Vec::new(),
            budget: 5_000,
            cap:    1_000_000,
        }).await);
        assert!(ok, "a search aimed outside the fence errored instead of finding nothing: {}",
            text);
        assert!(!text.contains("lives here too"),
            "THE SEARCH READ OUTSIDE ITS FENCE: {:?}", text);
        assert!(!text.contains("secret.txt"),
            "the search named a path outside its fence: {:?}", text);
        let cols: Vec<&str> = match text.split('\n').next() {
            Some(h) => h.split('\t').collect(),
            None    => return Err(err!("a search answered nothing at all"; Test, Missing)),
        };
        assert_eq!(cols.len(), 10, "the header does not carry ten counts: {:?}", cols);
        assert_eq!(cols[9], "1",
            "the walk did not record that a directory could not be opened, so a fenced-off \
            tree reads as an empty one: {:?}", cols);
        Ok(())
    }

    /// A glob is matched against the path AS THE CALLER SPELLS IT, not against the machine's.
    ///
    /// The door's first live run, 2026-08-25: three searches in a row answered "No matches" with
    /// "804 file(s) the glob excluded" beside them. The glob was `www/i18n/en.js`, written in
    /// the workspace's paths; the walk matched it against `/home/.../repo/www/i18n/en.js` and
    /// excluded every file there is. The note was right and the filter was upside down.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_glob_is_matched_against_the_path_the_caller_wrote_it_for() -> Outcome<()> {
        let base = res!(fixture("file-door-base"));
        let ws = base.join("ws");
        let files = res!(file_door());
        res!(std::fs::create_dir_all(ws.join("www/i18n")));
        res!(std::fs::write(ws.join("www/i18n/en.js"), "'files.new_file_hint': 'x',\n"));
        res!(std::fs::write(ws.join("www/i18n/de.js"), "'files.new_file_hint': 'y',\n"));

        let (ok, text) = res!(filed(&files, &ws, FileOp::Search {
            paths:  vec![fmt!("{}", ws.display())],
            query:  fmt!("new_file_hint"),
            ci:     false,
            // The spelling a model writes, which names nothing on this machine.
            glob:   fmt!("www/i18n/en.js"),
            base:   fmt!("{}", ws.display()),
            skip:   Vec::new(),
            budget: 5_000,
            cap:    1_000_000,
        }).await);
        assert!(ok, "a globbed search was refused: {}", text);
        assert!(text.contains("www/i18n/en.js"),
            "the glob excluded the one file it names, which is the 2026-08-25 fault: {:?}", text);
        assert!(!text.contains("de.js"),
            "the glob let through a file it does not name: {:?}", text);
        // And the count of what the glob excluded is REAL, so the note beside a miss is worth
        // reading rather than always saying everything.
        let cols: Vec<&str> = match text.split('\n').next() {
            Some(h) => h.split('\t').collect(),
            None    => return Err(err!("a search answered nothing"; Test, Missing)),
        };
        assert_ne!(cols[4], "0",
            "nothing was recorded as excluded, so the note beside a miss would say the glob \
            did nothing: {:?}", cols);
        assert_eq!(cols[7], "1",
            "the glob let more than the one file it names be opened: {:?}", cols);
        Ok(())
    }

    /// A walk stops at its entry budget and says where it had got to.
    ///
    /// A search that ran out and answered "no matches" has established nothing, and the caller
    /// cannot tell that from a search that looked everywhere. So the budget's exhaustion is a
    /// FACT in the answer, not an inference from a count.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_walk_that_runs_out_of_budget_says_where_it_stopped() -> Outcome<()> {
        let base = res!(fixture("file-door-budget"));
        let ws = base.join("ws");
        let files = res!(file_door());
        for i in 0..40 {
            res!(std::fs::write(ws.join(fmt!("f{:02}.txt", i)), "nothing\n"));
        }
        res!(std::fs::write(ws.join("f99.txt"), "NEEDLE_TWO\n"));

        let (ok, text) = res!(filed(&files, &ws, FileOp::Search {
            paths:  vec![fmt!("{}", ws.display())],
            query:  fmt!("NEEDLE_TWO"),
            ci:     false,
            glob:   String::new(),
            base:   String::new(),
            skip:   Vec::new(),
            budget: 5,
            cap:    1_000_000,
        }).await);
        assert!(ok, "a bounded search was refused: {}", text);
        let head = match text.split('\n').next() {
            Some(h) => h.to_string(),
            None    => return Err(err!("a search answered nothing at all"; Test, Missing)),
        };
        let cols: Vec<&str> = head.split('\t').collect();
        assert_eq!(cols.len(), 10, "the header does not carry ten counts: {:?}", head);
        assert_eq!(cols[0], "5", "the walk spent more than its budget: {:?}", head);
        assert!(!cols[1].is_empty(),
            "the walk ran out and did not say where it had got to: {:?}", head);
        assert!(!text.contains("NEEDLE_TWO"),
            "the walk reached past its budget: {:?}", text);

        // The control, without which the assertion above is satisfied by a walk that never
        // works at all: the same search with room finds it.
        let (ok, text) = res!(filed(&files, &ws, FileOp::Search {
            paths:  vec![fmt!("{}", ws.display())],
            query:  fmt!("NEEDLE_TWO"),
            ci:     false,
            glob:   String::new(),
            base:   String::new(),
            skip:   Vec::new(),
            budget: 5_000,
            cap:    1_000_000,
        }).await);
        assert!(ok && text.contains("NEEDLE_TWO"),
            "with room, the same search must find it: {:?}", text);
        Ok(())
    }

    /// A glob answers paths and reads nothing, and passes over the names it was told to.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_glob_answers_paths_and_skips_the_names_it_was_given() -> Outcome<()> {
        let base = res!(fixture("file-door-glob"));
        let ws = base.join("ws");
        let files = res!(file_door());
        res!(std::fs::create_dir_all(ws.join("src")));
        res!(std::fs::create_dir_all(ws.join("target")));
        res!(std::fs::write(ws.join("src/lib.rs"), "SECRET_TEXT\n"));
        res!(std::fs::write(ws.join("target/built.rs"), "SECRET_TEXT\n"));

        let (ok, text) = res!(filed(&files, &ws, FileOp::Glob {
            paths:   vec![fmt!("{}", ws.display())],
            pattern: fmt!("**/*.rs"),
            base:    fmt!("{}", ws.display()),
            skip:    vec![fmt!("target")],
            budget:  5_000,
        }).await);
        assert!(ok, "a glob inside the fence was refused: {}", text);
        assert!(text.contains("src/lib.rs"), "the glob missed the file: {:?}", text);
        assert!(!text.contains("target/built.rs"),
            "the glob walked a directory it was told to pass over: {:?}", text);
        // It reads nothing, so no file's CONTENT may appear in the answer.
        assert!(!text.contains("SECRET_TEXT"),
            "a glob returned a file's text, which it has no business opening: {:?}", text);
        Ok(())
    }

    /// An `old_string` that nearly matched is answered with the text to copy.
    ///
    /// The measurement is in `near_miss`'s own doc comment: four honest "was not found"
    /// refusals in a row, over one typographic quote, and the daimon abandoned the file tools
    /// for `sed` and spent forty-eight further calls there. A refusal that cannot be
    /// converged on is a refusal that costs the run.
    #[cfg(unix)]
    #[tokio::test]
    async fn an_old_string_that_nearly_matched_is_told_where_and_what_to_copy() -> Outcome<()> {
        let base = res!(fixture("file-door-nearmiss"));
        let ws = base.join("ws");
        let files = res!(file_door());
        let target = ws.join("de.js");
        // The real line, with the typographic quotes `de.js` really carries.
        res!(std::fs::write(&target,
            "a\nb\n\t'files.no_match': 'Nichts passt zu \u{201e}{filter}\u{201c}.',\n\t'files.new_file_hint': 'x',\n"));

        // What the daimon actually sent: a straight quote where the file has \u{201c}.
        let (ok, said) = res!(filed(&files, &ws, FileOp::Edit {
            path: fmt!("{}", target.display()),
            old:  fmt!("\t'files.no_match': 'Nichts passt zu \u{201e}{{filter}}\".',\n\t'files.new_file_hint': 'x',"),
            new:  fmt!("replaced"),
        }).await);
        assert!(!ok, "an old_string that is not in the file was applied");
        assert!(said.contains("line 3"),
            "the refusal does not say WHERE it nearly matched, so nothing can be converged \
            on: {:?}", said);
        assert!(said.contains('\u{201c}'),
            "the refusal does not hand back the file's own text, which is the only thing that \
            tells the caller which character it got wrong: {:?}", said);

        // And a string that is nowhere near says so, rather than pointing at a line at random.
        let (ok, said) = res!(filed(&files, &ws, FileOp::Edit {
            path: fmt!("{}", target.display()),
            old:  fmt!("nothing like this is in the file"),
            new:  fmt!("x"),
        }).await);
        assert!(!ok);
        assert!(said.contains("not a near miss"),
            "a string that is nowhere near is dressed up as one: {:?}", said);
        Ok(())
    }

    /// A directory read as a file is answered as a directory, not as an errno.
    ///
    /// Measured on the first live run of the door, 2026-08-25: a daimon's opening call was
    /// `file_read` of `repo/www/i18n`, and the machine arm answered `Is a directory (os error
    /// 21)` where the browser-storage arm has named `file_list` since the day before. One
    /// wasted call, and the same wasted call the other door had already paid for.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_directory_read_as_a_file_is_told_to_use_file_list() -> Outcome<()> {
        let base = res!(fixture("file-door-isdir"));
        let ws = base.join("ws");
        let files = res!(file_door());
        let (ok, said) = res!(filed(&files, &ws, FileOp::Read {
            path:   fmt!("{}", ws.display()),
            offset: 1,
            limit:  0,
        }).await);
        assert!(!ok, "a directory was read as a file: {:?}", said);
        assert!(said.contains("file_list"),
            "the refusal does not name the tool that answers this, so it costs a call: {:?}",
            said);
        assert!(!said.contains("os error"),
            "the refusal hands back an errno, which is the browser arm's old fault at the \
            other door: {:?}", said);
        Ok(())
    }

    /// A file the fence does not reach is refused BY THE KERNEL, not by a check.
    ///
    /// The assertion is deliberately about the sentence as well as the verdict: a refusal a
    /// model reads as "the file is protected" sends it to `chmod`, and the one thing this
    /// door must never do is look like a permission bit.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_file_outside_the_fence_cannot_be_read_or_written() -> Outcome<()> {
        let base = res!(fixture("file-door-outside"));
        let ws = base.join("ws");
        let outside = base.join("outside/other.txt");
        let files = res!(file_door());

        let (ok, said) = res!(filed(&files, &ws, FileOp::Read {
            path:   fmt!("{}", outside.display()),
            offset: 1,
            limit:  0,
        }).await);
        assert!(!ok, "a file tool read outside its fence: {:?}", said);
        assert!(said.contains("fence"),
            "the refusal did not name the fence, so it reads as a permission bit: {:?}", said);

        let (ok, said) = res!(filed(&files, &ws, FileOp::Write {
            path:    fmt!("{}", outside.display()),
            content: fmt!("clobbered"),
        }).await);
        assert!(!ok, "a file tool wrote outside its fence: {:?}", said);
        let still = res!(std::fs::read_to_string(&outside).map_err(|e| err!(e,
            "the file outside the fence could not be read back"; Test, IO)));
        assert_eq!(still, "other", "a file tool changed a file outside its fence");
        Ok(())
    }

    /// An `old_string` that is not unique is refused WITH ITS COUNT, and nothing changes.
    ///
    /// The count is the point. `dev/BLOCKERS.md` B2 names the absence of a partial-apply
    /// signal as one of three missing things, and a run of six edits with no way to tell
    /// which landed is what 71 calls were spent on.
    #[cfg(unix)]
    #[tokio::test]
    async fn an_edit_that_is_not_unique_says_how_many_it_found_and_changes_nothing()
        -> Outcome<()>
    {
        let base = res!(fixture("file-door-count"));
        let ws = base.join("ws");
        let files = res!(file_door());
        let target = ws.join("twice.txt");
        res!(std::fs::write(&target, "x\nx\n"));

        let (ok, said) = res!(filed(&files, &ws, FileOp::Edit {
            path: fmt!("{}", target.display()),
            old:  fmt!("x"),
            new:  fmt!("y"),
        }).await);
        assert!(!ok, "an ambiguous edit was applied");
        assert!(said.contains('2'), "the refusal did not say how many it found: {:?}", said);
        assert_eq!(res!(std::fs::read_to_string(&target).map_err(|e| err!(e, "read back";
            Test, IO))), "x\nx\n", "an ambiguous edit changed the file anyway");

        let (ok, said) = res!(filed(&files, &ws, FileOp::Edit {
            path: fmt!("{}", target.display()),
            old:  fmt!("zzz"),
            new:  fmt!("y"),
        }).await);
        assert!(!ok, "an edit whose old_string is absent was applied");
        assert!(said.contains("not found"), "the refusal did not say it was absent: {:?}", said);
        Ok(())
    }

    /// A payload survives the trip it is going to be sent on.
    #[test]
    fn a_payload_round_trips() -> Outcome<()> {
        let p = Payload {
            prog: PathBuf::from("/usr/bin/cargo"),
            argv: vec![fmt!("cargo"), fmt!("test"), fmt!("--"), fmt!("a b\tc")],
            env:  vec![(fmt!("HOME"), fmt!("/home/u")), (fmt!("EMPTY"), fmt!(""))],
            plan: Plan {
                abi:     crate::fence::Abi::V8,
                listing: Listing::Sealed,
                base:    SysBase::Minimal,
                reach:   Reach::Process,
                grants:  vec![
                    Grant { path: PathBuf::from("/usr"), level: Level::Ro },
                    Grant { path: PathBuf::from("/home/u/ws"), level: Level::Rw },
                ],
                sealed:  vec![PathBuf::from("/home/u/ws")],
                dropped: vec![PathBuf::from("/home/u/ws/escape")],
                net:     false,
                waiver:  None,
            },
            tty:  true,   // round-tripped as set, so the byte is proved to travel
            act:  Act::Exec,
        }; 
        let framed = res!(encode_payload(&p));
        let back = res!(decode_payload(&framed[4..]));
        assert_eq!(p, back);

        // A truncated payload is refused rather than half-applied.
        assert!(decode_payload(&framed[4..framed.len() - 3]).is_err(),
            "a truncated plan decoded");
        // And so is one with something extra on the end.
        let mut extra = framed[4..].to_vec();
        extra.push(0);
        assert!(decode_payload(&extra).is_err(), "a plan with trailing bytes decoded");
        Ok(())
    }

    // ── The confirmed defects ───────────────────────────────────────

    /// A fence root of `""` grants everything, and must not be accepted.
    ///
    /// `Path::new("/etc/ssh").starts_with("")` is true, so the empty string is
    /// every path's ancestor. The guard that was there counted roots and an
    /// empty root counts.
    #[tokio::test]
    async fn an_empty_fence_root_is_refused() -> Outcome<()> {
        // Broken first, at the level the bug lived: the containment test itself.
        assert!(Path::new("/etc/ssh").starts_with(""),
            "the premise of this test no longer holds");
        assert!(!under(Path::new("/etc/ssh"), Path::new("")),
            "an empty root is still every path's ancestor");

        let req = match exec("empty-root", &["/bin/cat", "/etc/hostname"]) {
            Req::Exec { id, argv, env, stdin, timeout_ms, capture, .. } =>
                Req::Exec {
                    id, argv, env, stdin, timeout_ms, capture,
                    cwd:   fmt!("/etc"),
                    fence: FenceSpec {
                        rw: vec![fmt!("")], ro: Vec::new(), deny: Vec::new(), net: false,
                    },
                    toolkits: Vec::new(),
                },
            other => other,
        };
        let rs = res!(run(req).await);
        let why = res!(refusal(&rs));
        assert!(why.contains("empty path"), "{}", why);
        Ok(())
    }

    /// An absolute program outside the fence is refused before it is spawned.
    #[tokio::test]
    async fn a_program_outside_the_fence_is_refused() -> Outcome<()> {
        let base = res!(fixture("prog-outside"));
        let ws = base.join("ws");
        // A real, runnable program that the fence does not reach. Kept under
        // its own name: this machine's coreutils is a multi-call binary that
        // decides what to be from `argv[0]`, so a copy called `evil` would
        // refuse to run for a reason that has nothing to do with the fence.
        res!(std::fs::create_dir_all(base.join("outside/bin")));
        let evil = base.join("outside/bin/echo");
        res!(std::fs::copy("/bin/echo", &evil));

        // Broken first: unfenced, it runs. Through `run_fresh`, because this
        // process wrote that file a moment ago and a sibling test's fork may
        // still be carrying a duplicate of the descriptor it was written
        // through; see the note there.
        let bare = res!(run_fresh(&evil, &["ran"]));
        assert!(bare.status.success(), "the control program does not run: {}",
            String::from_utf8_lossy(&bare.stderr));

        let fence = FenceSpec {
            rw: vec![fmt!("{}", ws.display())], ro: Vec::new(), deny: Vec::new(), net: false,
        };
        for spelling in [
            fmt!("{}", evil.display()),         // Absolute, outside.
            fmt!("../outside/bin/echo"),        // Relative, out through the cwd.
        ] {
            let req = Req::Exec {
                id:         fmt!("p-{}", spelling.len()),
                argv:       vec![spelling.clone(), fmt!("ran")],
                cwd:        fmt!("{}", ws.display()),
                env:        Vec::new(),
                stdin:      None,
                timeout_ms: 10_000,
                capture:    Capture::Both,
                fence:      fence.clone(),
                toolkits: Vec::new(),
            };
            let rs = res!(run(req).await);
            let why = res!(refusal(&rs));
            assert!(why.contains("outside this command's fence"),
                "{} was refused for the wrong reason: {}", spelling, why);
            assert!(text_of(&rs, Stream::Out).is_empty(),
                "{} produced output, so it ran", spelling);
        }
        Ok(())
    }

    /// A caller-supplied `PATH` finds a program; it does not authorise one.
    #[tokio::test]
    async fn a_caller_supplied_path_cannot_reach_outside_the_fence() -> Outcome<()> {
        let base = res!(fixture("prog-path"));
        let ws = base.join("ws");
        let dir = base.join("outside/bin");
        res!(std::fs::create_dir_all(&dir));
        res!(std::fs::copy("/bin/echo", dir.join("echo")));

        let req = Req::Exec {
            id:         fmt!("path"),
            argv:       vec![fmt!("echo"), fmt!("ran")],
            cwd:        fmt!("{}", ws.display()),
            env:        vec![(fmt!("PATH"), fmt!("{}", dir.display()))],
            stdin:      None,
            timeout_ms: 10_000,
            capture:    Capture::Both,
            fence:      FenceSpec {
                rw: vec![fmt!("{}", ws.display())], ro: Vec::new(), deny: Vec::new(), net: false,
            },
            toolkits: Vec::new(),
        };
        let rs = res!(run(req).await);
        let why = res!(refusal(&rs));
        assert!(why.contains("outside this command's fence"), "{}", why);
        Ok(())
    }

    /// `LD_PRELOAD` and its family are refused, by name.
    ///
    /// `README.md` gives this as the reason the environment is not the model's;
    /// until now the loop applied whatever it was given.
    #[tokio::test]
    async fn the_loader_environment_is_refused() -> Outcome<()> {
        for (k, v) in [
            ("LD_PRELOAD",      "/tmp/evil.so"),
            ("LD_AUDIT",        "/tmp/evil.so"),
            ("LD_LIBRARY_PATH", "/tmp"),
            ("GCONV_PATH",      "/tmp"),
            ("BASH_ENV",        "/tmp/evil.sh"),
        ] {
            let req = match exec("ld", &["/bin/echo", "hi"]) {
                Req::Exec { id, argv, cwd, stdin, timeout_ms, capture, fence, .. } =>
                    Req::Exec {
                        id, argv, cwd, stdin, timeout_ms, capture, fence,
                        env: vec![(fmt!("{}", k), fmt!("{}", v))],
                        toolkits: Vec::new(),
                    },
                other => other,
            };
            let rs = res!(run(req).await);
            let why = res!(refusal(&rs));
            assert!(why.contains(k), "{} was refused without being named: {}", k, why);
        }

        // An ordinary name is still accepted, so this is a screen and not a ban.
        let req = match exec("ld-ok", &["/usr/bin/env"]) {
            Req::Exec { id, argv, cwd, stdin, timeout_ms, capture, fence, .. } =>
                Req::Exec {
                    id, argv, cwd, stdin, timeout_ms, capture, fence,
                    env: vec![(fmt!("LDAP_CONF"), fmt!("x"))],
                    toolkits: Vec::new(),
                },
            other => other,
        };
        let rs = res!(run(req).await);
        assert!(text_of(&rs, Stream::Out).lines().any(|l| l == "LDAP_CONF=x"),
            "an ordinary name was dropped: {:?}", text_of(&rs, Stream::Out));
        Ok(())
    }

    /// Two runs cannot share one identifier.
    ///
    /// The first is left running on purpose: the collision only exists while
    /// both are live, and it is the live one that used to become unkillable.
    #[tokio::test]
    async fn a_duplicate_id_is_refused() -> Outcome<()> {
        let runner = res!(runner());
        let (tx, mut rx) = tokio::sync::mpsc::channel::<Resp>(256);

        res!(runner.spawn(exec("same", &["/bin/sleep", "30"]), tx.clone()).await);
        match rx.recv().await {
            Some(Resp::Started { .. }) => {},
            other => return Err(err!("Expected Started, got {:?}.", other; Test, Mismatch)),
        }

        let second = res!(runner.spawn(exec("same", &["/bin/sleep", "30"]), tx).await);
        assert_eq!(second, Launch::Refused);
        assert_eq!(res!(runner.live_count()), 1,
            "the registry took a second entry under one identifier");

        // And the first is still reachable, which is the property that was lost.
        assert_eq!(res!(runner.signal("same", Sig::Kill).await), Signalled::Sent);
        // Drained to the closing message rather than to the first thing that
        // ends a run: the refusal for the second exec is already in the queue.
        while let Some(r) = rx.recv().await {
            if matches!(r, Resp::Ended { .. }) {
                break;
            }
        }
        assert_eq!(res!(runner.live_count()), 0);
        Ok(())
    }

    /// A registry entry does not outlive the announcement it was made for.
    #[tokio::test]
    async fn a_failed_announcement_leaves_no_entry() -> Outcome<()> {
        let runner = res!(runner());
        for i in 0..5 {
            let (tx, rx) = tokio::sync::mpsc::channel::<Resp>(1);
            drop(rx); // The page has gone away.
            let out = runner.spawn(exec(&fmt!("gone-{}", i), &["/bin/sleep", "30"]), tx).await;
            assert!(out.is_err(), "an unannounceable run reported success");
        }
        assert_eq!(res!(runner.live_count()), 0,
            "unannounced runs left entries no signal can clear");
        Ok(())
    }

    /// A command that will not stop talking is cut off, and told about.
    ///
    /// `yes` delivered 3.4 GB in three seconds when nothing bounded the total.
    /// Memory was never the problem; the journal and the page's own buffers
    /// were.
    #[tokio::test]
    async fn output_is_capped_in_total() -> Outcome<()> {
        let req = match exec("flood", &["/usr/bin/yes"]) {
            Req::Exec { id, argv, cwd, env, stdin, capture, fence, .. } =>
                Req::Exec { id, argv, cwd, env, stdin, timeout_ms: 4_000, capture, fence, toolkits: Vec::new() },
            other => other,
        };
        let rs = res!(run(req).await);

        let sent: usize = rs.iter().map(|r| match r {
            Resp::Chunk { data, .. }	=> data.len(),
            _							=> 0,
        }).sum();
        let (_, timed_out, _, out_bytes) = match ended(&rs) {
            Some(e) => e,
            None    => return Err(err!("No Ended was sent."; Test, Missing)),
        };
        assert!(timed_out, "the flood stopped by itself, so nothing was capped");
        // Bounded, with one chunk's worth of overshoot allowed: the budget is
        // checked per chunk, not per byte.
        assert!(sent as u64 <= OUTPUT_TOTAL_MAX + (2 * CHUNK_MAX) as u64,
            "{} bytes were forwarded against a cap of {}", sent, OUTPUT_TOTAL_MAX);
        // The true total is still reported, so nothing is hidden.
        assert!(out_bytes > sent as u64,
            "the byte count did not outrun what was forwarded, so nothing was \
            truncated and this test proved nothing");
        assert!(rs.iter().any(|r| matches!(r,
            Resp::Chunk { data, .. } if data.contains("stopped forwarding"))),
            "output was truncated without saying so");
        Ok(())
    }

    // ── Somewhere to write ──────────────────────────────────────────

    /// Sets a directory's permissions, for a control that needs an unwritable one.
    ///
    /// # Arguments
    /// * `p` - The directory.
    /// * `mode` - The mode to set.
    #[cfg(unix)]
    fn set_mode(p: &Path, mode: u32) -> Outcome<()> {
        use std::os::unix::fs::PermissionsExt;
        let md = res!(std::fs::metadata(p));
        let mut perm = md.permissions();
        perm.set_mode(mode);
        res!(std::fs::set_permissions(p, perm));
        Ok(())
    }

    /// The scratch directories left behind by one run identifier.
    ///
    /// Matched on the identifier rather than by taking a difference of the
    /// listing, so that tests running beside each other cannot see one
    /// another's.
    ///
    /// # Arguments
    /// * `id` - The identifier the run was given.
    fn scratches(id: &str) -> Outcome<Vec<PathBuf>> {
        let base = res!(scratch_base());
        let rd = match std::fs::read_dir(&base) {
            Ok(rd) => rd,
            Err(_) => return Ok(Vec::new()), // Nothing has been made yet.
        };
        let want = fmt!("{}-", id);
        let mut out = Vec::new();
        for ent in rd.flatten() {
            if ent.file_name().to_string_lossy().starts_with(&want) {
                out.push(ent.path());
            }
        }
        Ok(out)
    }

    /// Clears whatever an earlier run of the same test left behind.
    ///
    /// A test that asserts nothing survives a run fails for ever once something
    /// has -- and something has, every time these checks are proved against
    /// deliberately broken code.  Clearing first keeps each assertion about the
    /// run it was written for.
    ///
    /// # Arguments
    /// * `id` - The identifier the run will be given.
    fn clear_scratches(id: &str) -> Outcome<()> {
        for p in res!(scratches(id)) {
            let _ = std::fs::remove_dir_all(&p);
        }
        Ok(())
    }

    /// A command really can write temporary files, and not into `/tmp`.
    ///
    /// `mktemp` is the whole test in one program: it creates a file where
    /// `TMPDIR` points and prints where it put it, so a run that ends zero with a
    /// path under the scratch base has demonstrated the writing, the pointing
    /// and the placing at once.
    ///
    /// The first half is the broken state, and it is the one the bug report
    /// described: with `/tmp` outside every fence and nothing in its place, a
    /// command asking for a temporary file there is refused by the kernel
    /// part-way through its work.  Without that half, the second could pass on a
    /// machine where `/tmp` happened to be writable and prove nothing.
    #[tokio::test]
    async fn a_command_can_write_to_its_own_tmpdir() -> Outcome<()> {
        res!(clear_scratches("tmp-works"));

        // Broken first: /tmp is outside the fence, which is why this exists.
        let rs = res!(run(exec("tmp-broken", &["/usr/bin/mktemp", "-p", "/tmp"])).await);
        let (exit, ..) = match ended(&rs) {
            Some(e) => e,
            None    => return Err(err!("No Ended was sent."; Test, Missing)),
        };
        assert_ne!(exit, 0,
            "a fenced command wrote into /tmp, so the fence is not what it says");

        // And now with nothing said about where: TMPDIR is the hand's answer.
        let rs = res!(run(exec("tmp-works", &["/usr/bin/mktemp"])).await);
        let (exit, ..) = match ended(&rs) {
            Some(e) => e,
            None    => return Err(err!("No Ended was sent."; Test, Missing)),
        };
        assert_eq!(exit, 0,
            "a command could not write a temporary file: {}", text_of(&rs, Stream::Err));

        let said = text_of(&rs, Stream::Out);
        let made = Path::new(said.trim());
        let base = res!(scratch_base());
        assert!(made.starts_with(&base),
            "the temporary file went to {} rather than under {}",
            made.display(), base.display());
        assert!(!made.starts_with("/tmp"), "the temporary file went to /tmp");
        // And it went with the run: the directory it was in is not there now.
        assert!(!made.exists(), "{} outlived the run", made.display());
        assert!(res!(scratches("tmp-works")).is_empty(),
            "a scratch directory outlived its run");
        Ok(())
    }

    /// The scratch goes away on every way a run can end.
    ///
    /// The two long runs are here because "gone afterwards" is a claim that
    /// passes trivially against code that never made one: each is watched while
    /// it is alive, so the directory is proved to exist before it is proved to
    /// be gone.
    #[tokio::test]
    async fn the_scratch_is_gone_however_the_run_ends() -> Outcome<()> {
        // Ended well, and ended badly.
        for (id, argv) in [
            ("scr-success", vec!["/bin/echo", "done"]),
            ("scr-failure", vec!["/bin/false"]),
        ] {
            res!(clear_scratches(id));
            let rs = res!(run(exec(id, &argv)).await);
            assert!(ended(&rs).is_some(), "{} never closed", id);
            assert!(res!(scratches(id)).is_empty(),
                "the scratch for {} outlived it", id);
        }

        // Timed out.
        res!(clear_scratches("scr-timeout"));
        let req = match exec("scr-timeout", &["/bin/sleep", "30"]) {
            Req::Exec { id, argv, cwd, env, stdin, capture, fence, .. } =>
                Req::Exec { id, argv, cwd, env, stdin, timeout_ms: 1_500, capture, fence, toolkits: Vec::new() },
            other => other,
        };
        let waiter = res!(runner());
        let (tx, mut rx) = tokio::sync::mpsc::channel::<Resp>(256);
        res!(waiter.spawn(req, tx).await);
        match rx.recv().await {
            Some(Resp::Started { .. }) => {},
            other => return Err(err!("Expected Started, got {:?}.", other; Test, Mismatch)),
        }
        assert_eq!(res!(scratches("scr-timeout")).len(), 1,
            "a running command had no scratch directory, so nothing was removed later");
        let rs = collect(&mut rx).await;
        let (_, timed_out, ..) = match ended(&rs) {
            Some(e) => e,
            None    => return Err(err!("No Ended was sent."; Test, Missing)),
        };
        assert!(timed_out, "the run did not time out, so this proved nothing");
        // Nothing was recorded as left standing. A group that has been killed is
        // empty, and a reaped member of it still answers in `/proc` for as long
        // as it takes to be collected -- so a probe that counted one would
        // announce a run as having left processes behind when it had not, and
        // would hold its scratch open for them. See `counts_as_member`.
        assert_eq!(res!(waiter.standing_count()), 0,
            "a timed-out run was recorded as having left its process group standing");
        assert!(res!(scratches("scr-timeout")).is_empty(),
            "the scratch survived a timeout");

        // Killed.
        res!(clear_scratches("scr-killed"));
        let killer = res!(runner());
        let (tx, mut rx) = tokio::sync::mpsc::channel::<Resp>(256);
        res!(killer.spawn(exec("scr-killed", &["/bin/sleep", "30"]), tx).await);
        match rx.recv().await {
            Some(Resp::Started { .. }) => {},
            other => return Err(err!("Expected Started, got {:?}.", other; Test, Mismatch)),
        }
        assert_eq!(res!(scratches("scr-killed")).len(), 1,
            "a running command had no scratch directory, so nothing was removed later");
        assert_eq!(res!(killer.signal("scr-killed", Sig::Kill).await), Signalled::Sent);
        let rs = collect(&mut rx).await;
        let (_, _, killed, _) = match ended(&rs) {
            Some(e) => e,
            None    => return Err(err!("No Ended was sent."; Test, Missing)),
        };
        assert!(killed, "the run was not killed, so this proved nothing");
        assert_eq!(res!(killer.standing_count()), 0,
            "a killed run was recorded as having left its process group standing");
        assert!(res!(scratches("scr-killed")).is_empty(),
            "the scratch survived a kill");
        Ok(())
    }

    /// Two commands running at once are given two different directories.
    #[tokio::test]
    async fn two_runs_get_different_scratches() -> Outcome<()> {
        let runner = res!(runner());
        let (tx, mut rx) = tokio::sync::mpsc::channel::<Resp>(1024);
        res!(runner.spawn(exec("pair-a", &["/usr/bin/mktemp"]), tx.clone()).await);
        res!(runner.spawn(exec("pair-b", &["/usr/bin/mktemp"]), tx).await);

        let mut made: HashMap<String, String> = HashMap::new();
        let mut done = 0;
        while let Some(r) = rx.recv().await {
            match r {
                Resp::Chunk { id, stream: Stream::Out, data, .. } =>
                    made.entry(id).or_default().push_str(&data),
                Resp::Ended { .. }		=> { done += 1; if done == 2 { break; } },
                Resp::Refused { reason, .. } => return Err(err!(
                    "A run was refused: {}", reason; Test, Mismatch)),
                _						=> (),
            }
        }

        let path = |id: &str| -> Outcome<PathBuf> {
            match made.get(id) {
                Some(s) => {
                    let t = match s.strip_prefix(HARNESS_NOISE) {
                        Some(rest)	=> rest.trim(),
                        None		=> s.trim(),
                    };
                    Ok(PathBuf::from(t))
                },
                None => Err(err!("{} said nothing.", id; Test, Missing)),
            }
        };
        let a = res!(path("pair-a"));
        let b = res!(path("pair-b"));
        let (pa, pb) = match (a.parent(), b.parent()) {
            (Some(x), Some(y))	=> (x.to_path_buf(), y.to_path_buf()),
            _					=> return Err(err!(
                "A temporary file was made at the root of the filesystem."; Test, Path)),
        };
        assert_ne!(pa, pb, "two concurrent runs shared one scratch directory");
        assert_eq!(pa.parent(), pb.parent(),
            "the two scratches are not siblings, so this compared the wrong thing");
        Ok(())
    }

    /// One run cannot read another's scratch, even knowing exactly where it is.
    ///
    /// The decoy stands in for a Diamond's run that is still going: it is made
    /// in the same base, by the same rules, and the fenced command is given its
    /// full path.  Nothing has to be guessed, so this tests the fence rather
    /// than the naming.
    #[tokio::test]
    async fn one_run_cannot_reach_another_scratch() -> Outcome<()> {
        let base = res!(scratch_base());
        res!(std::fs::create_dir_all(&base));
        let decoy = base.join(scratch_name("decoy"));
        res!(std::fs::create_dir(&decoy));
        res!(std::fs::write(decoy.join("secret"), "another run's work"));

        // Broken first: unfenced, the file reads perfectly well.
        let bare = res!(std::process::Command::new("/bin/cat")
            .arg(decoy.join("secret")).output());
        assert!(bare.status.success(), "the control run could not read the decoy");
        assert_eq!("another run's work", String::from_utf8_lossy(&bare.stdout));

        let rs = res!(run(exec("peeper",
            &["/bin/cat", &fmt!("{}", decoy.join("secret").display())])).await);
        let (exit, ..) = match ended(&rs) {
            Some(e) => e,
            None    => return Err(err!("No Ended was sent."; Test, Missing)),
        };
        let _ = std::fs::remove_dir_all(&decoy);

        assert_ne!(exit, 0, "a command read another run's temporary files");
        assert_eq!(text_of(&rs, Stream::Out), "",
            "another run's temporary files came back anyway");
        Ok(())
    }

    /// A caller cannot say where a command's temporary files go.
    #[tokio::test]
    async fn a_caller_supplied_tmpdir_is_refused() -> Outcome<()> {
        res!(clear_scratches("tmp-caller"));
        for name in ["TMPDIR", "TMP", "TEMP", "tmpdir"] {
            let req = match exec("tmp-caller", &["/usr/bin/env"]) {
                Req::Exec { id, argv, cwd, stdin, timeout_ms, capture, fence, .. } =>
                    Req::Exec {
                        id, argv, cwd, stdin, timeout_ms, capture, fence,
                        env: vec![(fmt!("{}", name), fmt!("{}", root()))],
                        toolkits: Vec::new(),
                    },
                other => other,
            };
            let rs = res!(run(req).await);
            let why = res!(refusal(&rs));
            assert!(why.contains(name),
                "{} was refused without being named: {}", name, why);
            assert!(res!(scratches("tmp-caller")).is_empty(),
                "a refused command left a scratch directory behind");
        }
        Ok(())
    }

    /// The scratch cannot be put where a fence over it would reach the journal.
    ///
    /// Proved on the broken placement first: a base holding the journal is
    /// exactly what nobody else checks, since `main` checks the granted folder
    /// and `Journal::check_fence` checks the caller's spec, and this root is
    /// added after both.
    #[test]
    fn the_scratch_is_never_where_the_journal_lives() -> Outcome<()> {
        let bad = Path::new("/home/u/.local/share/daimond/hand");
        let journal = bad.join("journal");
        match clear_of_journal(bad, &journal) {
            Ok(()) => return Err(err!(
                "A scratch base holding the journal was accepted."; Test, Security)),
            Err(e) => {
                let said = e.msgs().join(" ");
                assert!(said.contains("journal"), "the refusal does not name it: {}", said);
            },
        }
        // The base itself, being the journal's directory, is refused too.
        assert!(clear_of_journal(&journal, &journal).is_err(),
            "a scratch base that IS the journal was accepted");
        // And the arrangement the hand actually uses is clear of it.
        res!(clear_of_journal(&bad.join("scratch"), &journal));
        res!(clear_of_journal(
            &res!(scratch_base()),
            &res!(crate::journal::default_dir())));
        Ok(())
    }

    /// The proof this whole arrangement exists for: a real `cargo test`, fenced,
    /// with the toolchain read-only and nothing said about where to write.
    ///
    /// This is the case that was measured failing.  Driving the real host over a
    /// pipe, `cargo test` with the toolchain granted died with `error: couldn't
    /// create a temp dir: Permission denied (os error 13) at path
    /// "/tmp/rustcOHkDBV"` -- `rustc` writes its intermediate output to a
    /// temporary directory, `/tmp` is outside every fence the hand builds, and
    /// the compile got most of the way through before finding that out.
    ///
    /// Nothing in the request below mentions a temporary directory.  If this
    /// test passes, the hand supplied one; if it is ever made not to, this fails
    /// with the same message the bug report carried.
    ///
    /// Skipped loudly where there is no toolchain to grant, since a machine
    /// without one cannot answer the question either way.
    #[tokio::test]
    async fn a_real_cargo_test_completes_behind_the_fence() -> Outcome<()> {
        res!(clear_scratches("cargo-proof"));
        let home = match std::env::var("HOME") {
            Ok(h) if !h.is_empty() => PathBuf::from(h),
            _ => {
                println!("[a_real_cargo_test_completes_behind_the_fence] SKIPPED: no HOME.");
                return Ok(());
            },
        };
        let cargo_home  = home.join(".cargo");
        let rustup_home = home.join(".rustup");
        let cargo = cargo_home.join("bin/cargo");
        if !cargo.exists() || !rustup_home.exists() {
            println!(
                "[a_real_cargo_test_completes_behind_the_fence] SKIPPED: no \
                toolchain at {} to grant.", cargo.display());
            return Ok(());
        }

        // A crate with no dependencies, so nothing is fetched and the only
        // reason to write anywhere is the compiler's own working files.
        let base = res!(fixture("cargo-proof"));
        let ws   = base.join("ws");
        let proj = ws.join("proj");
        res!(std::fs::create_dir_all(proj.join("src")));
        res!(std::fs::create_dir_all(ws.join("home")));
        res!(std::fs::write(proj.join("Cargo.toml"), concat!(
            "[package]\n",
            "name = \"fenced\"\n",
            "version = \"0.0.0\"\n",
            "edition = \"2021\"\n",
            "\n",
            "[workspace]\n",
            "\n",
            "[lib]\n",
            "path = \"src/lib.rs\"\n")));
        res!(std::fs::write(proj.join("src/lib.rs"), concat!(
            "//! A crate that exists to be compiled inside a fence.\n",
            "\n",
            "/// Two and two.\n",
            "pub fn four() -> u32 { 2 + 2 }\n",
            "\n",
            "#[cfg(test)]\n",
            "mod tests {\n",
            "    #[test]\n",
            "    fn it_adds() { assert_eq!(super::four(), 4); }\n",
            "}\n")));

        // Broken first, and this is the exact failure that was reported. The
        // same project, the same toolchain, no fence at all -- only a TMPDIR
        // the compiler cannot write to, which is what a fence with no scratch
        // in it amounts to. Without this half, a build that never needed a
        // temporary file would make the fenced run below prove nothing.
        let notmp = base.join("outside/notmp");
        res!(std::fs::create_dir_all(&notmp));
        res!(set_mode(&notmp, 0o500));
        let bare = res!(std::process::Command::new(&cargo)
            .args(["test", "--offline"])
            .current_dir(&proj)
            .env("TMPDIR", &notmp)
            .env("CARGO_TARGET_DIR", proj.join("target-control"))
            .output());
        res!(set_mode(&notmp, 0o700)); // So the fixture can be cleared next time.
        let control = String::from_utf8_lossy(&bare.stderr).to_string();
        assert!(!bare.status.success(),
            "the control build succeeded with nowhere to write, so this machine \
            cannot demonstrate the failure the scratch exists to fix");
        assert!(control.contains("couldn't create a temp dir"),
            "the control build failed for some other reason:\n{}", control);
        let _ = std::fs::remove_dir_all(proj.join("target-control"));

        let req = Req::Exec {
            id:         fmt!("cargo-proof"),
            argv:       vec![fmt!("cargo"), fmt!("test"), fmt!("--offline")],
            cwd:        fmt!("{}", proj.display()),
            env:        vec![
                (fmt!("PATH"),        fmt!("{}/bin:/usr/bin:/bin", cargo_home.display())),
                (fmt!("HOME"),        fmt!("{}", ws.join("home").display())),
                (fmt!("CARGO_HOME"),  fmt!("{}", cargo_home.display())),
                (fmt!("RUSTUP_HOME"), fmt!("{}", rustup_home.display())),
                // Inside the workspace, because the target directory is output
                // rather than scratch and the caller is entitled to say where
                // output goes.
                (fmt!("CARGO_TARGET_DIR"), fmt!("{}", proj.join("target").display())),
                // Nothing about TMPDIR, TMP or TEMP. That is the test.
            ],
            stdin:      None,
            timeout_ms: 300_000,
            capture:    Capture::Both,
            fence:      FenceSpec {
                rw:   vec![fmt!("{}", ws.display())],
                ro:   vec![
                    fmt!("{}", cargo_home.display()),
                    fmt!("{}", rustup_home.display()),
                ],
                deny: Vec::new(),
                net:  false,
            },
            toolkits: Vec::new(),
        };

        let rs = res!(run(req).await);
        let (exit, timed_out, ..) = match ended(&rs) {
            Some(e) => e,
            None    => return Err(err!(
                "No Ended was sent: {:?}", rs; Test, Missing)),
        };
        let said = fmt!("{}{}", text_of(&rs, Stream::Out), text_of(&rs, Stream::Err));
        assert!(!timed_out, "the build did not finish in time:\n{}", said);
        assert!(!said.contains("couldn't create a temp dir"),
            "the command still had nowhere to write:\n{}", said);
        assert_eq!(exit, 0, "a fenced cargo test did not pass:\n{}", said);
        assert!(said.contains("test tests::it_adds ... ok"),
            "the test inside the fenced project did not run:\n{}", said);
        assert!(res!(scratches("cargo-proof")).is_empty(),
            "a build's temporary files outlived it");
        Ok(())
    }

    /// A script that reads `$HOME` runs, and the command is told only the two
    /// names the hand fills in.
    ///
    /// The measured failure is the whole reason this exists: a daimon ran
    /// `bash dev/world.sh 3 --up` and it died on its first line with
    /// `HOME: unbound variable`, because the environment was the caller's pairs
    /// and the caller sends none unless a toolkit was granted.  Nearly every
    /// script under `dev/` in the app reads `$HOME`, so nearly every one of them
    /// died the same way.
    ///
    /// Both directions are checked.  A `set -u` script that reads `$HOME` and
    /// `$PATH` has to run and print real values; and the environment has to hold
    /// no more than the caller's pairs, the three scratch names and these two,
    /// because a default nobody argued for is a variable a command can be
    /// steered by.
    #[tokio::test]
    async fn a_command_is_given_a_home_and_a_path() -> Outcome<()> {
        let base = res!(fixture("env-defaults"));
        let ws   = base.join("ws");
        let sh   = ws.join("reads-home.sh");
        res!(std::fs::write(&sh, concat!(
            "#!/bin/bash\n",
            "set -u\n",
            "echo \"HOME=$HOME\"\n",
            "echo \"PATH=$PATH\"\n",
            "env | sort\n")));

        let rs = res!(run(exec_at("env-defaults",
            &["/bin/bash", &fmt!("{}", sh.display())], &ws)).await);
        let said = text_of(&rs, Stream::Out);
        let (exit, ..) = match ended(&rs) {
            Some(e) => e,
            None    => return Err(err!("No Ended was sent: {:?}", rs; Test, Missing)),
        };
        assert_eq!(exit, 0,
            "a script that reads $HOME under `set -u` did not run: {}{}",
            said, text_of(&rs, Stream::Err));

        let home = match home_dir() {
            Some(h) => h,
            None    => return Err(err!(
                "These tests need HOME to say what the hand would pass on."; Test, Missing)),
        };
        assert!(said.contains(&fmt!("HOME={}", home)),
            "the command was given some other home: {}", said);
        assert!(said.contains(&fmt!("PATH={}", PATH_FALLBACK)),
            "the command was given some other path: {}", said);

        // And nothing else. Named individually, because each of these is a
        // separate decision recorded in the section above `ENV_DEFAULTED` and a
        // later edit that adds one should have to change this line.
        for refused in ["USER=", "LOGNAME=", "LANG=", "LC_ALL=", "SHELL=", "TERM="] {
            assert!(!said.lines().any(|l| l.starts_with(refused)),
                "the hand passed {} to a command: {}", refused, said);
        }

        // The caller's own pair wins, because a default is a floor and not a
        // correction. The app sets HOME itself for a git grant.
        let req = match exec_at("env-mine", &["/usr/bin/env"], &ws) {
            Req::Exec { id, argv, cwd, stdin, timeout_ms, capture, fence, .. } =>
                Req::Exec {
                    id, argv, cwd, stdin, timeout_ms, capture, fence,
                    env: vec![(fmt!("HOME"), fmt!("{}", ws.display()))],
                    toolkits: Vec::new(),
                },
            other => other,
        };
        let rs = res!(run(req).await);
        let said = text_of(&rs, Stream::Out);
        assert!(said.contains(&fmt!("HOME={}", ws.display())),
            "the hand overrode a HOME the caller set: {}", said);
        assert_eq!(said.lines().filter(|l| l.starts_with("HOME=")).count(), 1,
            "HOME was set twice, so which one a program reads is luck: {}", said);
        Ok(())
    }

    /// A toolchain folder this machine does not have is skipped; a workspace
    /// root that is missing still refuses.
    ///
    /// `~/.config/git` is absent on the machine this was written on, and
    /// `Toolkit::Git` grants it read access -- so ticking the Git toolkit
    /// refused EVERY command the Diamond ran, with a sentence about a path the
    /// user had never named.  Both halves are here because only the pair is the
    /// rule: skipping a grant nobody asked for by name tightens the fence, and
    /// skipping a root the USER marked would leave a fence that silently did not
    /// cover what they marked.
    #[test]
    fn an_absent_toolchain_folder_is_skipped_and_a_missing_workspace_is_not() -> Outcome<()> {
        let home = match home_dir() {
            Some(h) => PathBuf::from(h),
            None    => return Err(err!("This test needs HOME."; Test, Missing)),
        };
        let base = res!(fixture("kit-absent"));
        let ws   = base.join("ws");
        let kits = vec![fmt!("git"), fmt!("node"), fmt!("python"), fmt!("rust")];

        // A toolkit path this machine does not have, named exactly as the app
        // spells it. Chosen from the table rather than invented, so a machine
        // that HAS them all makes this test say so instead of passing hollowly.
        let absent = TOOLKIT_ROOTS.iter()
            .map(|k| home.join(k.tail))
            .find(|p| !p.exists());
        let absent = match absent {
            Some(p) => p,
            None    => {
                println!("[an_absent_toolchain_folder_is_skipped_and_a_missing_workspace_is_not] \
                    SKIPPED: every toolchain folder in TOOLKIT_ROOTS exists here.");
                return Ok(());
            },
        };

        let mut spec = FenceSpec {
            rw:   vec![fmt!("{}", ws.display())],
            ro:   vec![fmt!("{}", absent.display())],
            deny: Vec::new(),
            net:  false,
        };
        // The clamp accepts it -- it is a root the grant implies -- and the fence
        // would then refuse the command for a path that is simply not there.
        assert_eq!(None, vet_roots(&ws, &spec, &kits, Door::Command),
            "the clamp refused a toolchain root, so this test is measuring the wrong thing");
        assert!(detected_fence().plan(&spec, &Unfenced::Refuse).is_err(),
            "a fence naming {} resolved, so this machine cannot show the failure",
            absent.display());

        let gone = drop_absent_kit_roots(&mut spec, &kits);
        assert_eq!(gone, vec![fmt!("{}", absent.display())],
            "the absent toolchain root was not the thing dropped");
        assert!(detected_fence().plan(&spec, &Unfenced::Refuse).is_ok(),
            "the fence still will not resolve after the absent root was dropped");

        // The other half. A workspace root that is missing is a fence that would
        // not cover what the user marked, and it must keep refusing.
        let ghost = base.join("ws/never-made");
        let mut marked = FenceSpec {
            rw:   vec![fmt!("{}", ghost.display())],
            ro:   Vec::new(),
            deny: Vec::new(),
            net:  false,
        };
        let gone = drop_absent_kit_roots(&mut marked, &kits);
        assert!(gone.is_empty(), "a workspace root was dropped: {:?}", gone);
        assert_eq!(marked.rw, vec![fmt!("{}", ghost.display())]);
        assert!(detected_fence().plan(&marked, &Unfenced::Refuse).is_err(),
            "a marked folder that is not there was accepted");

        // And a toolchain folder that IS there is left alone.
        let present = TOOLKIT_ROOTS.iter()
            .map(|k| home.join(k.tail))
            .find(|p| p.exists());
        if let Some(p) = present {
            let mut have = FenceSpec {
                rw:   vec![fmt!("{}", ws.display())],
                ro:   vec![fmt!("{}", p.display())],
                deny: Vec::new(),
                net:  false,
            };
            let gone = drop_absent_kit_roots(&mut have, &kits);
            assert!(gone.is_empty(), "a toolchain folder that exists was dropped: {:?}", gone);
        }

        // A request naming no toolkit drops nothing at all, whatever is missing:
        // the eligibility comes from the toolkit and not from the path.
        let mut none = FenceSpec {
            rw:   Vec::new(),
            ro:   vec![fmt!("{}", absent.display())],
            deny: Vec::new(),
            net:  false,
        };
        assert!(drop_absent_kit_roots(&mut none, &[]).is_empty(),
            "a root was dropped for a toolkit the request never named");
        Ok(())
    }

    /// A run that leaves a server behind is listed, reachable and stoppable --
    /// and nothing else on the machine can reach it.
    ///
    /// The measured incident, in one test.  A daimon brought a dev server and a
    /// mock provider up through `run`, the command that started them exited, and
    /// then nothing could stop them: a later command's `kill` answered
    /// "Operation not permitted" because Landlock scopes signals to the domain
    /// that sent them, `/proc` is outside every fence so the pid could not be
    /// found, and the teardown script swallowed the failed kill, reported success
    /// and deleted its own pid files.  Two ports were held with no route to them.
    ///
    /// Four things are proved here and the third is the one that makes the other
    /// three worth having:
    ///
    /// * the background process really is alive and really is in the run's group,
    ///   measured from `/proc` by this test rather than by the code under test;
    /// * the hand lists it, as `standing`, under the identifier the run was given;
    /// * a SECOND fenced command cannot signal it -- which is the fault, still
    ///   present, and the reason the hand has to be the one that can;
    /// * the hand stops it, and afterwards the process is gone, the listing no
    ///   longer holds it, and the run's scratch directory has been cleared.
    #[tokio::test]
    async fn a_run_that_leaves_a_group_standing_is_listed_and_can_be_stopped() -> Outcome<()> {
        res!(clear_scratches("world-up"));
        let base = res!(fixture("standing"));
        let ws   = base.join("ws");
        let pidf = ws.join("child.pid");
        let sh   = ws.join("leaves-one.sh");
        // The shape `dev/world.sh --up` has: start something, write down where it
        // went, and return. Nothing here holds a port; the group is the point.
        res!(std::fs::write(&sh, fmt!(concat!(
            "#!/bin/bash\n",
            "set -u\n",
            "/bin/sleep 600 &\n",
            "echo $! > {}\n",
            "echo up\n"), pidf.display())));

        let runner = res!(runner());
        let (tx, mut rx) = tokio::sync::mpsc::channel::<Resp>(256);
        let started = res!(runner.spawn(
            exec_at("world-up", &["/bin/bash", &fmt!("{}", sh.display())], &ws), tx).await);
        let pgid = match started {
            Launch::Started(p) => p,
            Launch::Refused    => return Err(err!(
                "The run was refused: {:?}", collect(&mut rx).await; Test, Mismatch)),
        };
        let rs = collect(&mut rx).await;
        let (exit, ..) = match ended(&rs) {
            Some(e) => e,
            None    => return Err(err!("No Ended was sent: {:?}", rs; Test, Missing)),
        };
        assert_eq!(exit, 0, "the script did not run: {}", text_of(&rs, Stream::Err));

        // Measured from /proc by this test, so that the listing below is checked
        // against the machine and not against the same reading of it.
        let child: u32 = match std::fs::read_to_string(&pidf) {
            Ok(t)  => match t.trim().parse() {
                Ok(n)  => n,
                Err(e) => return Err(err!(e, "The script wrote {:?} as a pid.", t; Test, Invalid)),
            },
            Err(e) => return Err(err!(e,
                "The script did not write down what it started."; Test, Missing)),
        };
        assert_eq!(Some(pgid), proc_pgrp(child),
            "the background process is not in the run's process group, so this test is not \
            measuring what it says it is");

        // The hand said so on the way out, in a sentence naming the one way in.
        let note = rs.iter().find_map(|r| match r {
            Resp::Error { id: Some(i), message } if i == "world-up" => Some(message.clone()),
            _ => None,
        });
        let note = match note {
            Some(n) => n,
            None    => return Err(err!(
                "The run ended holding a process group and said nothing: {:?}", rs;
                Test, Missing)),
        };
        assert!(note.contains("world-up"), "the note does not name the run: {}", note);
        assert!(note.contains(&fmt!("{}", pgid)), "the note does not name the group: {}", note);

        // And it is in the listing, as standing, under that identifier.
        assert_eq!(res!(runner.live_count()), 0);
        assert_eq!(res!(runner.standing_count()), 1);
        let (runs, more) = res!(runner.runs().await);
        assert_eq!(more, 0);
        assert_eq!(runs.len(), 1, "{:?}", runs);
        assert_eq!(runs[0].id, "world-up");
        assert_eq!(runs[0].pid, pgid);
        assert_eq!(runs[0].state, RunState::Standing);
        assert!(runs[0].what.contains("leaves-one.sh"),
            "the listing does not say what was run: {:?}", runs[0]);

        // THE FAULT, still there and now shown rather than described: a second
        // command cannot signal the first one's leftovers. This is why the hand
        // has to be the one that can.
        let rs = res!(run(exec_at("try-kill",
            &["/bin/kill", "-s", "TERM", "--", &fmt!("-{}", pgid)], &ws)).await);
        let (exit, ..) = match ended(&rs) {
            Some(e) => e,
            None    => return Err(err!("No Ended was sent: {:?}", rs; Test, Missing)),
        };
        let said = fmt!("{}{}", text_of(&rs, Stream::Out), text_of(&rs, Stream::Err));
        assert_ne!(exit, 0,
            "a fenced command signalled another run's process group, so the leak this test is \
            about no longer needs the hand to fix it: {}", said);
        assert!(std::fs::metadata(fmt!("/proc/{}", child)).is_ok(),
            "the second command killed it after all");

        // The hand can, and afterwards the machine agrees.
        let scratch = res!(scratches("world-up"));
        assert_eq!(scratch.len(), 1, "the run's scratch was cleared while its group stood");
        assert_eq!(res!(runner.signal("world-up", Sig::Kill).await), Signalled::Finished,
            "the hand could not stop a group it started");
        assert!(std::fs::metadata(fmt!("/proc/{}", child)).is_err(),
            "the background process is still there after the hand stopped its group");
        assert_eq!(res!(runner.standing_count()), 0, "the stopped run is still in the registry");
        let (runs, _) = res!(runner.runs().await);
        assert!(runs.is_empty(), "the listing still holds a run that is gone: {:?}", runs);
        assert!(res!(scratches("world-up")).is_empty(),
            "the run's temporary directory outlived the group it was held for");

        // And asking again is not an error.
        assert_eq!(res!(runner.signal("world-up", Sig::Kill).await), Signalled::Finished);
        Ok(())
    }

    /// An identifier holding a standing group cannot be given to a second
    /// command.
    ///
    /// It is the only door there is: a group a run left behind is reachable by
    /// that name and by nothing else at all, so letting a second run take the
    /// name would shut the first beyond reach exactly as `REVIEW.md` §3.6
    /// described for two live runs.
    #[tokio::test]
    async fn an_identifier_holding_a_standing_group_is_not_reissued() -> Outcome<()> {
        let base = res!(fixture("standing-id"));
        let ws   = base.join("ws");
        let sh   = ws.join("leaves-one.sh");
        res!(std::fs::write(&sh, concat!(
            "#!/bin/bash\n",
            "set -u\n",
            "/bin/sleep 600 &\n")));

        let runner = res!(runner());
        let (tx, mut rx) = tokio::sync::mpsc::channel::<Resp>(256);
        res!(runner.spawn(
            exec_at("taken", &["/bin/bash", &fmt!("{}", sh.display())], &ws), tx).await);
        let _ = collect(&mut rx).await;
        assert_eq!(res!(runner.standing_count()), 1, "nothing was left standing to test with");

        let (tx, mut rx) = tokio::sync::mpsc::channel::<Resp>(256);
        res!(runner.spawn(exec_at("taken", &["/bin/echo", "hi"], &ws), tx).await);
        let rs = collect(&mut rx).await;
        let reason = res!(refusal(&rs));
        assert!(reason.contains("taken"), "{}", reason);
        assert!(reason.contains("still running"), "{}", reason);
        assert!(reason.contains("different id"),
            "the refusal leaves the caller no way forward: {}", reason);

        assert_eq!(res!(runner.signal("taken", Sig::Kill).await), Signalled::Finished);
        Ok(())
    }

    /// Nothing this hand started outlives the conversation, standing groups
    /// included.
    ///
    /// A server a run left behind is reachable through this hand and through
    /// nothing else, so a hand that exited without stopping it would leave it
    /// holding its port until somebody found it from outside the app -- which is
    /// the incident, arriving by a different door.
    #[tokio::test]
    async fn a_standing_group_does_not_outlive_the_hand() -> Outcome<()> {
        let base = res!(fixture("standing-bye"));
        let ws   = base.join("ws");
        let pidf = ws.join("child.pid");
        let sh   = ws.join("leaves-one.sh");
        res!(std::fs::write(&sh, fmt!(concat!(
            "#!/bin/bash\n",
            "set -u\n",
            "/bin/sleep 600 &\n",
            "echo $! > {}\n"), pidf.display())));

        let runner = res!(runner());
        let (tx, mut rx) = tokio::sync::mpsc::channel::<Resp>(256);
        res!(runner.spawn(
            exec_at("bye-world", &["/bin/bash", &fmt!("{}", sh.display())], &ws), tx).await);
        let _ = collect(&mut rx).await;
        let child: u32 = match std::fs::read_to_string(&pidf) {
            Ok(t)  => match t.trim().parse() {
                Ok(n)  => n,
                Err(_) => return Err(err!("The script wrote {:?} as a pid.", t; Test, Invalid)),
            },
            Err(e) => return Err(err!(e, "The script started nothing."; Test, Missing)),
        };
        assert!(std::fs::metadata(fmt!("/proc/{}", child)).is_ok());

        assert_eq!(res!(runner.stop_all().await), 1, "the goodbye did not reach a standing group");
        assert!(std::fs::metadata(fmt!("/proc/{}", child)).is_err(),
            "a process the hand started outlived the hand's own goodbye");
        assert_eq!(res!(runner.standing_count()), 0);
        Ok(())
    }

    /// A `/proc` line is read for the right field, and a zombie is not counted.
    ///
    /// The field offsets are the trap: the second field is the executable's name
    /// in brackets and a file name may hold brackets and spaces, so counting from
    /// the front reads the wrong number and reads it plausibly.  The zombie is
    /// the other one: an exit status waiting to be collected is not a process
    /// holding a port, and counting one would make every killed run look as
    /// though it had left something behind.
    #[test]
    fn a_zombie_is_not_a_process_group_still_standing() {
        // A real line, from a `sleep` in group 4242.
        let live = "4243 (sleep) S 4242 4242 4242 0 -1 1077936128 96 0 0 0 0 0";
        assert!(counts_as_member(live, 4242));
        assert!(!counts_as_member(live, 4241), "the wrong group was matched");

        // The same process, reaped and not yet collected.
        let dead = "4243 (sleep) Z 4242 4242 4242 0 -1 1077936128 96 0 0 0 0 0";
        assert!(!counts_as_member(dead, 4242),
            "a zombie was counted as a process still holding its group open");

        // A name that looks like the rest of the line. Counting from the front
        // reads 7 as the group here, which is a plausible number and wrong.
        let awkward = "4243 (a b) c 5 6) R 4242 4242 4242 0 -1 0 1 0 0 0 0 0";
        assert!(counts_as_member(awkward, 4242),
            "the fields were counted from the wrong side of the name");
        assert!(!counts_as_member(awkward, 7));

        // Nothing usable is not a member, in either direction.
        assert!(!counts_as_member("", 4242));
        assert!(!counts_as_member("4243 (sleep", 4242));
        assert!(!counts_as_member("4243 (sleep) S", 4242));
    }

    /// A signal that did not take is never reported as a stop.
    ///
    /// The classifier and not the plumbing, because this one judgement is the
    /// defect: `dev/world.sh --down` swallowed a failed kill, said "stopped" and
    /// deleted its pid files, and there was no arm anywhere in the hand that
    /// could have contradicted it.  Every combination is named, including the two
    /// that are easy to get backwards -- a `kill` that failed while the group
    /// died anyway is a stop, and a `kill` that succeeded while the group stands
    /// is not.
    #[test]
    fn a_signal_that_did_not_take_is_never_reported_as_a_stop() {
        let why = || Some(fmt!("/bin/kill exited 1 (kill: (-4242) - Operation not permitted)"));

        // The group is gone. The probe outranks the exit status, because BusyBox
        // exits 1 on the POSIX spelling and empties the group anyway.
        assert_eq!(signalled("r", 4242, None, Some(false)), Signalled::Finished);
        assert_eq!(signalled("r", 4242, why(), Some(false)), Signalled::Finished);

        // The group is standing and the signal was refused. THE ONE THAT MATTERS.
        match signalled("r", 4242, why(), Some(true)) {
            Signalled::Failed(s) => {
                assert!(s.contains("'r'"), "{}", s);
                assert!(s.contains("4242"), "the sentence does not name the group: {}", s);
                assert!(s.contains("still running"), "{}", s);
                assert!(s.contains("Operation not permitted"),
                    "the sentence drops what the machine said: {}", s);
            },
            other => panic!("a refused signal on a standing group answered {:?}", other),
        }

        // The group is standing and the signal was accepted: the signal went, and
        // that is all this says. A TERM is a request.
        assert_eq!(signalled("r", 4242, None, Some(true)), Signalled::Sent);

        // The machine would not answer. Not a failure, and not a stop either.
        assert_eq!(signalled("r", 4242, None, None), Signalled::Sent);
        match signalled("r", 4242, why(), None) {
            Signalled::Failed(_) => (),
            other => panic!("a refused signal nobody could check answered {:?}", other),
        }
    }

    /// A fenced command cannot create a symbolic link, and the kernel is what    /// A fenced command cannot create a symbolic link, and the kernel is what
    /// refuses it.
    ///
    /// The link is the leg a daimon supplies to a leak whose other leg is
    /// somewhere else entirely.  Ore absorbs the CONTENT of a link that leaves
    /// the working copy, under the link's own path, into a signed history with
    /// no forget; a global `post-commit` hook runs `ore mark` from outside the
    /// fence on the owner's key, so `ln -s ../outside/other.txt leak.txt` inside
    /// the workspace is the whole of the attack.  Nothing about it is Ore's:
    /// every archiver, uploader and packager that follows a link is the same
    /// shape, which is why the capability is withheld here rather than a target
    /// check being written in one of them.
    ///
    /// Checking the target instead was considered and is weaker twice over: it
    /// races a repoint between the check and the read, and it cannot see a
    /// `symlink(2)` a compiler makes rather than an `ln` a model runs.
    /// Withholding `LANDLOCK_ACCESS_FS_MAKE_SYM` has neither weakness, because
    /// there is no call to make.
    ///
    /// Both halves are here.  The control runs the same `ln` on the same paths
    /// with no fence, so a machine where `ln` is missing or the fixture is wrong
    /// says so instead of passing; the fenced run then has to fail, and the link
    /// has to be absent afterwards.
    #[tokio::test]
    async fn a_fenced_command_cannot_make_a_symlink() -> Outcome<()> {
        let base = res!(fixture("symlink-refused"));
        let ws   = base.join("ws");

        // Unfenced first. Without this, a fenced `ln` that failed because the
        // program is not there would read as the fence doing its job.
        let control = ws.join("control.txt");
        let out = res!(std::process::Command::new("/bin/ln")
            .args(["-s", "../outside/other.txt"])
            .arg(&control)
            .output());
        assert!(out.status.success(),
            "the control link was not made, so this machine cannot show the \
            difference: {}", String::from_utf8_lossy(&out.stderr));
        assert!(res!(std::fs::symlink_metadata(&control)).file_type().is_symlink(),
            "the control wrote something that is not a link");
        res!(std::fs::remove_file(&control));

        // And now the same call, inside a fence that grants the workspace for
        // writing. Everything about it is permitted except the one syscall.
        let leak = ws.join("leak.txt");
        let req = Req::Exec {
            id:         fmt!("symlink-refused"),
            argv:       vec![fmt!("/bin/ln"), fmt!("-s"), fmt!("../outside/other.txt"),
                             fmt!("{}", leak.display())],
            cwd:        fmt!("{}", ws.display()),
            env:        Vec::new(),
            stdin:      None,
            timeout_ms: 30_000,
            capture:    Capture::Both,
            fence:      FenceSpec {
                rw:   vec![fmt!("{}", ws.display())],
                ro:   Vec::new(),
                deny: Vec::new(),
                net:  false,
            },
            toolkits: Vec::new(),
        };
        let rs = res!(run(req).await);
        let said = fmt!("{}{}", text_of(&rs, Stream::Out), text_of(&rs, Stream::Err));
        let (exit, ..) = match ended(&rs) {
            Some(e) => e,
            None    => return Err(err!("No Ended was sent: {:?}", rs; Test, Missing)),
        };
        assert_ne!(exit, 0,
            "a fenced command created a symbolic link: MAKE_SYM is granted, so \
            `ln -s ../outside/other.txt` succeeded inside the fence. {}", said);
        assert!(!leak.exists() && std::fs::symlink_metadata(&leak).is_err(),
            "the link is on disk at {} although the command reported failure",
            leak.display());
        // Named, so that a refusal for some other reason -- a missing program, a
        // cwd outside the fence -- cannot pass for this one.
        assert!(said.contains("denied") || said.contains("not permitted"),
            "the command failed for some reason other than the fence:\n{}", said);

        // A file the fence DOES permit is still written, so what was withheld is
        // one capability and not the workspace.
        let rs = res!(run(exec_at(
            "symlink-ordinary",
            &["/usr/bin/touch", &fmt!("{}", ws.join("ordinary.txt").display())],
            &ws)).await);
        let (exit, ..) = match ended(&rs) {
            Some(e) => e,
            None    => return Err(err!("No Ended was sent: {:?}", rs; Test, Missing)),
        };
        assert_eq!(exit, 0, "withholding MAKE_SYM took ordinary writing with it: {}{}",
            text_of(&rs, Stream::Out), text_of(&rs, Stream::Err));
        Ok(())
    }

    /// A name is readable at the front and unguessable at the back.
    #[test]
    fn a_scratch_name_is_readable_and_unguessable() {
        let a = scratch_name("run-cargo");
        let b = scratch_name("run-cargo");
        assert!(a.starts_with("run-cargo-"), "the run is not recognisable: {}", a);
        assert_ne!(a, b, "two names for one identifier were the same");
        assert_eq!(a.len(), "run-cargo".len() + 1 + 32);

        // Nothing a caller writes reaches the filesystem as anything but a name.
        let hostile = scratch_name("../../etc/ssh");
        assert!(!hostile.contains('/'), "{}", hostile);
        assert!(!hostile.contains('.'), "{}", hostile);
        assert_eq!(Path::new(&hostile).components().count(), 1);

        // An unbounded identifier does not make an unbounded name.
        let long = scratch_name(&"x".repeat(4_000));
        assert_eq!(long.len(), SCRATCH_SLUG_MAX + 1 + 32);

        // And one made entirely of characters that cannot appear still names
        // something.
        let empty = scratch_name("");
        assert!(empty.starts_with("run-"), "{}", empty);
    }

    // ── Plain unit checks ───────────────────────────────────────────

    #[test]
    fn test_containment_is_by_component_not_by_prefix() {
        assert!(under(Path::new("/work/a/b"), Path::new("/work")));
        assert!(under(Path::new("/work"), Path::new("/work")));
        assert!(!under(Path::new("/workshop"), Path::new("/work")));
        assert!(!under(Path::new("/elsewhere"), Path::new("/work")));
        // The empty root, which every path starts with and which is therefore
        // no root at all.
        assert!(!under(Path::new("/etc/ssh"), Path::new("")));
        assert!(!under(Path::new("/work/a"), Path::new("relative")));
    }

    #[test]
    fn a_degraded_group_signal_is_not_discarded() {
        let mut slot = None;
        note_signalling(&mut slot, Ok(Signalling::Sent));
        assert!(slot.is_none());

        note_signalling(&mut slot, Ok(Signalling::Degraded(fmt!("busybox said no"))));
        match &slot {
            Some(s) => assert!(s.contains("busybox")),
            None    => panic!("a degraded group signal was thrown away"),
        }

        // The first explanation stands; a later success does not erase it.
        note_signalling(&mut slot, Ok(Signalling::Sent));
        assert!(slot.is_some());
    }

    /// The two cache folders a build in this repository actually writes are
    /// granted by name, and `~/.cache` itself never is.
    ///
    /// Both are here because the pair is the rule.  Without the rows the clamp
    /// refuses the whole command when the app sends the grant, so a fenced build
    /// is worse off than an unfenced one -- and the cheap repair, granting
    /// `~/.cache`, would hand a command the pip cache, the go build cache and
    /// whatever else lives there, none of which any toolkit lent it.
    #[test]
    fn the_named_cache_roots_are_granted_and_the_cache_itself_is_not() -> Outcome<()> {
        let base = res!(fixture("cache-roots"));
        let ws   = base.join("ws");
        let home = match home_dir() {
            Some(h) => PathBuf::from(h),
            None    => return Err(err!("This test needs HOME."; Test, Missing)),
        };
        let rw = |p: &Path| -> FenceSpec {
            FenceSpec {
                rw:   vec![fmt!("{}", ws.display()), fmt!("{}", p.display())],
                ro:   Vec::new(),
                deny: Vec::new(),
                net:  false,
            }
        };
        let kits = |names: &[&str]| -> Vec<String> {
            names.iter().map(|n| fmt!("{}", n)).collect()
        };

        let targets = home.join(".cache/cargo-targets");
        let worlds  = home.join(".cache/daimond");
        assert_eq!(None, vet_roots(&ws, &rw(&targets), &kits(&["rust"]), Door::Command),
            "the Rust toolkit cannot write the target directory this repository builds into");
        assert_eq!(None, vet_roots(&ws, &rw(&worlds), &kits(&["node"]), Door::Command),
            "the Node toolkit cannot write a world's own scratch root");

        // Each belongs to ONE toolkit, and a grant of the other does not reach it.
        assert!(vet_roots(&ws, &rw(&targets), &kits(&["node"]), Door::Command).is_some(),
            "a target directory was granted to a request that named only Node");
        assert!(vet_roots(&ws, &rw(&worlds), &kits(&["rust"]), Door::Command).is_some(),
            "a world's scratch root was granted to a request that named only Rust");

        // And the folder above them is never granted, however many toolkits are
        // in play. `~/.cache` holds the pip and go caches as well.
        assert!(vet_roots(&ws, &rw(&home.join(".cache")),
                &kits(&["rust", "node", "python", "go", "git"]), Door::Command).is_some(),
            "the whole of ~/.cache was granted");
        Ok(())
    }

    /// A fence may name only roots this hand's grant could imply.
    ///
    /// `REVIEW.md` §1.5.  Both halves matter equally and the second is the one
    /// that decides whether this ships: a clamp that refuses `/etc` and also
    /// refuses `~/.cargo` is a clamp that stops `cargo` working, and a security
    /// The Remote posture is the key and the wrapper, and neither half alone.
    ///
    /// This is where the whole of B12's answer sits for the Remote grant: the permission is not
    /// stored anywhere, it is READ off the two files `install.sh --remote` writes.  So there is
    /// no fourth place a permission lives, nothing to migrate, and no setting that could go on
    /// saying yes after the key is deleted.
    ///
    /// Both halves are required because neither half connects to anything.  A wrapper with no
    /// key behind it is an `ssh` on `PATH` that fails; a key with no wrapper is a key nothing
    /// would ever pass to OpenSSH, which takes its home from the passwd entry and not from
    /// `HOME`.  Announcing "ready" for either would put a toolchain in a terminal's fence that
    /// cannot work.
    #[test]
    fn the_remote_posture_is_the_key_and_the_wrapper() -> Outcome<()> {
        let home = res!(fixture("remote_posture"));
        let base = home.join(".config/oxedyne/daimond-hand");
        res!(std::fs::create_dir_all(base.join("bin")));
        res!(std::fs::create_dir_all(base.join("ssh")));

        // A machine where the installer never ran.
        assert!(!remote_ready_at(&home),
            "a home with no Daimond ssh in it was read as set up");

        // The wrapper alone: an `ssh` on PATH with nothing behind it.
        res!(std::fs::write(base.join("bin/ssh"), "#!/bin/sh\n"));
        assert!(!remote_ready_at(&home),
            "a wrapper with no key behind it was read as set up");

        // The key alone: nothing on PATH would ever hand it to OpenSSH.
        res!(std::fs::remove_file(base.join("bin/ssh")));
        res!(std::fs::write(base.join("ssh/id_daimond"), "k"));
        assert!(!remote_ready_at(&home),
            "a key with no wrapper in front of it was read as set up");

        // Both, which is what the installer leaves behind.
        res!(std::fs::write(base.join("bin/ssh"), "#!/bin/sh\n"));
        assert!(remote_ready_at(&home),
            "the installer ran and the hand still says the machine is not set up");

        // A directory is not a wrapper. `is_file` and not `exists`, because a fence naming a
        // folder where a program should be is a terminal that opens on a refusal.
        res!(std::fs::remove_file(base.join("bin/ssh")));
        res!(std::fs::create_dir_all(base.join("bin/ssh")));
        assert!(!remote_ready_at(&home),
            "a DIRECTORY called ssh was read as the wrapper");
        Ok(())
    }

    /// The user's own shell files reach a terminal and never a command.
    ///
    /// Lane U's third refusal was `bash: ~/.bashrc: Permission denied`, and the repair is
    /// three named files lent read-only.  The half that has to hold is the other one: a
    /// `.bashrc` runs code, so a command the model chose reading it would be the model
    /// running the user's own aliases with the model's arguments.  Both doors are asked here,
    /// because a grant that is correct at one and silent at the other is the whole point.
    #[test]
    fn the_users_shell_files_reach_a_terminal_and_no_command() -> Outcome<()> {
        let home = match home_dir() {
            Some(h) => PathBuf::from(h),
            None    => return Ok(()), // Nowhere to resolve them against.
        };
        let there: Vec<&str> = USER_DOTFILES.iter()
            .filter(|t| home.join(t).is_file())
            .copied()
            .collect();
        let bare = || FenceSpec { rw: Vec::new(), ro: Vec::new(), deny: Vec::new(), net: false };

        for shut in [Door::Command, Door::File] {
            let mut f = bare();
            let lent = grant_user_dotfiles(&mut f, shut);
            assert!(lent.is_empty(), "a {:?} was lent {:?}", shut, lent);
            assert!(f.ro.is_empty(), "a {:?}'s fence grew {:?}", shut, f.ro);
        }

        let mut f = bare();
        let lent = grant_user_dotfiles(&mut f, Door::Terminal);
        assert_eq!(there.len(), lent.len(),
            "the terminal was lent {:?} where {:?} are on this machine", lent, there);
        for t in there.iter() {
            let want = fmt!("{}", home.join(t).display());
            assert!(lent.contains(&want), "{} was not lent to the terminal", want);
            assert!(f.ro.contains(&want), "{} did not reach the fence", want);
        }
        // READ-ONLY, which is the difference between lending a file and lending the shell
        // that could rewrite it.
        assert!(f.rw.is_empty(), "the terminal was given WRITE on {:?}", f.rw);
        // And never the home directory itself, which is what "named one at a time" means.
        let h = fmt!("{}", home.display());
        assert!(!f.ro.contains(&h), "the whole home directory was lent");
        Ok(())
    }

    /// A denial already in the fence is not widened from here.
    #[test]
    fn a_denied_shell_file_stays_denied() -> Outcome<()> {
        let home = match home_dir() {
            Some(h) => PathBuf::from(h),
            None    => return Ok(()),
        };
        let mut f = FenceSpec {
            rw:   Vec::new(),
            ro:   Vec::new(),
            deny: vec![fmt!("{}", home.display())],
            net:  false,
        };
        let lent = grant_user_dotfiles(&mut f, Door::Terminal);
        assert!(lent.is_empty(),
            "a deny somebody put on the home directory was widened from here: {:?}", lent);
        Ok(())
    }

    /// check that breaks the build is a security check somebody turns off.
    #[test]
    fn a_fence_may_only_name_roots_the_grant_implies() -> Outcome<()> {
        let base = res!(fixture("vet-roots"));
        let ws   = base.join("ws");
        let home = match std::env::var("HOME") {
            Ok(h) => PathBuf::from(h),
            Err(_) => return Ok(()), // Nothing to resolve a toolchain against.
        };
        let spec = |rw: Vec<String>, ro: Vec<String>| -> FenceSpec {
            FenceSpec { rw, ro, deny: Vec::new(), net: false }
        };
        let one = |p: &Path| -> Vec<String> { vec![fmt!("{}", p.display())] };
        let kits = |names: &[&str]| -> Vec<String> {
            names.iter().map(|n| fmt!("{}", n)).collect()
        };
        let all = kits(&["rust", "node", "python", "go", "git", "remote"]);

        // The workspace itself, and anything under it, with no toolkit in play at all.
        assert_eq!(None, vet_roots(&ws, &spec(one(&ws), Vec::new()), &[], Door::Command));
        assert_eq!(None, vet_roots(&ws, &spec(one(&ws.join("sub")), Vec::new()), &[], Door::Command));

        // Every toolchain a granted toolkit can name, at the level that toolkit lends it --
        // and at the DOOR it lends it to. A row marked `term` is the Remote toolchain: an ssh
        // key, lent to a terminal the user opened, and refused to a command however the
        // request spells its grant, because the shell at the far end of an ssh is fenced by
        // nothing on this machine.
        for k in TOOLKIT_ROOTS {
            let p = home.join(k.tail);
            let named = kits(&[k.kit]);
            let door = match k.term { true => Door::Terminal, false => Door::Command };
            if k.term {
                for shut in [Door::Command, Door::File] {
                    let said = vet_roots(&ws, &spec(one(&ws), one(&p)), &named, shut);
                    match said {
                        Some(s) => assert!(s.contains("terminal the user opened by hand"),
                            "the refusal must say WHY the door decides it: {}", s),
                        None => return Err(err!(
                            "{} reached a {:?}, and an ssh key must not: a command that could \
                            run ssh is a command with a shell on another machine that nothing \
                            here fences.", k.tail, shut; Bug)),
                    }
                }
            }
            assert_eq!(None, vet_roots(&ws, &spec(one(&ws), one(&p)), &named, door),
                "the {} toolchain root was refused as readable", k.tail);
            // And a path inside one, which is how the app actually names them:
            // `~/.cargo/registry/cache`, not `~/.cargo`.
            assert_eq!(None, vet_roots(&ws, &spec(one(&ws), one(&p.join("inner"))), &named, door),
                "a path inside the {} toolchain was refused", k.tail);
            let writing = vet_roots(&ws, &spec(one(&p), Vec::new()), &named, door);
            if k.write {
                assert_eq!(None, writing,
                    "the {} cache must be writable or the build it exists for cannot run", k.tail);
            } else {
                // The 0c reproduction, in the form that mattered: `~/.local/bin` is first on
                // PATH, and a shim written there runs as the user on the next shell command.
                assert!(writing.is_some(),
                    "rw on {} was accepted, and it is lent for reading", k.tail);
                match writing {
                    Some(s) => assert!(s.contains("WRITE"),
                        "the refusal must say it is the LEVEL that is wrong: {}", s),
                    None => (),
                }
            }
        }

        // The conditionality, which is the other half of 0c: a toolchain folder is out of reach
        // for a request that named no toolkit, and for one that named a different toolkit.
        for k in TOOLKIT_ROOTS {
            let p = home.join(k.tail);
            let door = match k.term { true => Door::Terminal, false => Door::Command };
            assert!(vet_roots(&ws, &spec(one(&ws), one(&p)), &[], door).is_some(),
                "{} was reachable with no toolkit granted", k.tail);
            assert!(vet_roots(&ws, &spec(one(&p), Vec::new()), &[], door).is_some(),
                "{} was WRITABLE with no toolkit granted", k.tail);
            let others: Vec<String> = ["rust", "node", "python", "go", "git", "remote"].iter()
                .filter(|n| **n != k.kit).map(|n| fmt!("{}", n)).collect();
            assert!(vet_roots(&ws, &spec(one(&ws), one(&p)), &others, door).is_some(),
                "{} was reachable to a request that granted only {:?}", k.tail, others);
        }

        // A name this build does not know grants nothing rather than refusing everything.
        assert_eq!(None, vet_roots(&ws, &spec(one(&ws), Vec::new()), &kits(&["zig"]), Door::Command));
        assert!(vet_roots(&ws, &spec(one(&ws), one(&home.join(".cargo/bin"))), &kits(&["zig"]), Door::Command)
            .is_some(), "an unknown toolkit name granted a toolchain");

        // The hand's own scratch, which the hand appends to every fence itself.
        if let Ok(s) = scratch_base() {
            assert_eq!(None, vet_roots(&ws, &spec(one(&s.join("run-1")), Vec::new()), &[], Door::Command));
        }

        // And everything else, even with every toolkit granted. `/etc` is the measured one:
        // before this existed, `rw:["/etc"]` with `cwd:"/etc"` ran `ls /etc/ssh` and returned it.
        for bad in [
            PathBuf::from("/etc"),
            PathBuf::from("/"),
            PathBuf::from("/tmp"),
            PathBuf::from("/usr"),
            home.clone(),
            home.join(".ssh"),
            home.join(".config"),
            home.join(".cache"),          // the folder itself, although two tails under it are granted
            home.join(".cargo"),          // the folder itself: 2.2 GB, and the crates.io token
            base.join("outside"),
        ] {
            let said = vet_roots(&ws, &spec(one(&bad), Vec::new()), &all, Door::Command);
            assert!(said.is_some(), "rw:[{}] was accepted", bad.display());
            let said = vet_roots(&ws, &spec(one(&ws), one(&bad)), &all, Door::Command);
            assert!(said.is_some(), "ro:[{}] was accepted", bad.display());
            // The refusal names the path and where to fix it, or it is not a
            // refusal somebody can act on.
            match said {
                Some(s) => {
                    assert!(s.contains(&fmt!("{}", bad.display())), "{}", s);
                    assert!(s.contains("TOOLKIT_ROOTS"), "{}", s);
                },
                None => (),
            }
        }

        // A deny is never clamped: it only ever takes access away, so a caller
        // naming one outside the grant has narrowed its own fence.
        assert_eq!(None, vet_roots(&ws, &FenceSpec {
            rw:   one(&ws),
            ro:   Vec::new(),
            deny: vec![fmt!("/etc"), fmt!("{}", home.join(".ssh").display())],
            net:  false,
        }, &[], Door::Command));
        Ok(())
    }

    /// The whole fence the app composes for a granted toolkit survives the clamp.
    ///
    /// The table here mirrors `Toolkit::grants` in the app's `src/tools.rs`, and two copies can
    /// drift.  This is the test that notices: it names the paths the app actually sends for the
    /// Rust toolkit -- the ones `Kit::resolve` puts in `ro` and `rw` -- and asserts the clamp
    /// takes all of them.  A drift shows up here as a refusal of a real build rather than as a
    /// user turning the fence off.
    #[test]
    fn the_fence_the_app_composes_for_a_toolkit_passes_the_clamp() -> Outcome<()> {
        let base = res!(fixture("vet-kit"));
        let ws   = base.join("ws");
        let home = match std::env::var("HOME") {
            Ok(h) => PathBuf::from(h),
            Err(_) => return Ok(()),
        };
        let at = |t: &str| -> String { fmt!("{}", home.join(t).display()) };
        // Exactly what `Kit::resolve` composes for `rust`, plus the workspace.
        let spec = FenceSpec {
            rw: vec![
                fmt!("{}", ws.display()),
                at(".cargo/registry"),
                at(".cargo/git"),
                at(".cargo/.package-cache"),
            ],
            ro: vec![at(".cargo/bin"), at(".rustup")],
            // The app denies these; a deny is not clamped, and the hand must not hand back what
            // the app carefully withheld by treating the deny as a grant.
            deny: vec![at(".cargo/credentials.toml"), at(".cargo/credentials"), at(".netrc")],
            net: true,
        };
        assert_eq!(None, vet_roots(&ws, &spec, &[fmt!("rust")], Door::Command),
            "the fence the app composes for the Rust toolkit was refused by the hand's clamp");
        // And the same fence with the grant absent is refused outright.
        assert!(vet_roots(&ws, &spec, &[], Door::Command).is_some(),
            "the Rust toolchain was reachable to a request that granted no toolkit");

        // And the same for git, which is the toolkit whose absence from this table is quiet rather
        // than loud: a fenced git that cannot read `~/.gitconfig` runs with no `core.hooksPath`,
        // and an unreadable hooks directory looks exactly like an empty one. Nothing here is
        // writable -- a configuration a command could rewrite decides what runs on the user's next
        // commit -- and every credential the app denies is denied and not granted back.
        let spec = FenceSpec {
            rw:   vec![fmt!("{}", ws.display())],
            ro:   vec![at(".gitconfig"), at(".config/git")],
            deny: vec![at(".git-credentials"), at(".config/git/credentials"), at(".ssh"),
                       at(".netrc")],
            net:  true,
        };
        assert_eq!(None, vet_roots(&ws, &spec, &[fmt!("git")], Door::Command),
            "the fence the app composes for the Git toolkit was refused by the hand's clamp");
        assert!(vet_roots(&ws, &spec, &[], Door::Command).is_some(),
            "the user's git configuration was reachable with no toolkit granted");
        // Read-only in the table means read-only at the clamp.
        assert!(vet_roots(&ws, &FenceSpec {
            rw:   vec![fmt!("{}", ws.display()), at(".gitconfig")],
            ro:   Vec::new(),
            deny: Vec::new(),
            net:  false,
        }, &[fmt!("git")], Door::Command).is_some(), "the git configuration was accepted as writable");
        Ok(())
    }

    // ── A push that could destroy work at the far end ────────────────────
    //
    // Each of these is written as the thing going wrong: a forced push getting through because it
    // was spelled with a cluster, or a refspec, or a configuration option -- and an ordinary push
    // being refused, which is the failure that gets a guard switched off.

    #[test]
    fn a_forced_push_is_refused_however_it_is_spelled() {
        let argv = |v: &[&str]| -> Vec<String> { v.iter().map(|s| fmt!("{}", s)).collect() };
        for cmd in [
            vec!["git", "push", "--force"],
            vec!["git", "push", "--force-with-lease"],
            vec!["git", "push", "--force-with-lease=main"],
            vec!["git", "push", "--force-if-includes"],
            vec!["git", "push", "--delete", "origin", "main"],
            vec!["git", "push", "--mirror"],
            vec!["git", "push", "--prune", "origin"],
            vec!["git", "push", "--no-verify"],
            vec!["git", "push", "--receive-pack=/tmp/x"],
            vec!["git", "push", "--exec=/tmp/x"],
            vec!["git", "push", "-f"],
            vec!["git", "push", "-uf", "origin", "main"],   // the cluster
            vec!["git", "push", "-qfu", "origin", "main"],
            vec!["git", "push", "-d", "origin", "main"],
            vec!["git", "push", "origin", "+main:main"],    // the refspec spelling of --force
            vec!["git", "push", "origin", ":main"],         // and of --delete
            vec!["git", "push", "origin", "--", "+main"],   // still a refspec after `--`
            vec!["/usr/bin/git", "push", "--force"],        // an absolute program
            vec!["git", "-C", "/somewhere", "push", "--force"], // the subcommand is not second
            vec!["git", "--no-pager", "push", "-f"],
            // Configuration, which is where a forced refspec can be written instead.
            vec!["git", "-c", "remote.origin.push=+main:main", "push", "origin"],
            vec!["git", "-cremote.origin.push=+main:main", "push", "origin"],
            vec!["git", "--config-env=remote.origin.push=X", "push", "origin"],
            vec!["git", "--exec-path=/tmp", "push", "origin"],
        ] {
            match screen_git_push(&argv(&cmd)) {
                Some(s) => {
                    assert!(s.starts_with("Refused: "),
                        "{:?} was refused in words nobody can act on: {}", cmd, s);
                    assert!(s.contains("machine hand"),
                        "{:?} was refused without saying which guard spoke: {}", cmd, s);
                },
                None => panic!("{:?} was allowed through the hand", cmd),
            }
        }
    }

    #[test]
    fn an_ordinary_push_is_not_refused() {
        let argv = |v: &[&str]| -> Vec<String> { v.iter().map(|s| fmt!("{}", s)).collect() };
        for cmd in [
            vec!["git", "push"],
            vec!["git", "push", "origin", "main"],
            vec!["git", "push", "-u", "origin", "main"],
            vec!["git", "push", "--set-upstream", "origin", "main"],
            vec!["git", "push", "--dry-run"],
            vec!["git", "push", "-n"],                       // `-n` on a push is --dry-run
            vec!["git", "push", "--tags"],
            vec!["git", "push", "--no-force-with-lease"],     // turns forcing OFF
            vec!["git", "push", "-o", "ci.skip", "origin", "main"],
            // The remote is not this guard's business: the app refuses anything but `origin`
            // because ITS credential is scoped to one host, and that reason does not travel here.
            vec!["git", "push", "upstream", "main"],
            vec!["git", "push", "https://example.com/r.git", "main"],
            vec!["git", "push", "--repo=https://example.com/r.git"],
            // Not a push at all.
            vec!["git", "commit", "-m", "x"],
            vec!["git", "log", "--force"],
            vec!["git", "--version"],
            vec!["git"],
            vec!["cargo", "push", "--force"],
            vec!["gitk", "push", "--force"],
            // `-c` is only refused on a push, because it is the push that this guard is about.
            vec!["git", "-c", "user.name=x", "commit", "-m", "y"],
        ] {
            assert_eq!(None, screen_git_push(&argv(&cmd)),
                "{:?} is an ordinary command and was refused", cmd);
        }
        assert_eq!(None, screen_git_push(&[]));
    }

    /// The guard is CALLED, and not merely written.
    ///
    /// `REVIEW.md` §1.2 is why this test exists: `seccomp.rs` implemented its answer, had passing
    /// unit tests for both halves, and was called from nowhere -- so a passing unit test on the
    /// pure decision was precisely the evidence that failed. This drives the real `spawn`.
    #[tokio::test]
    async fn a_forced_push_is_refused_by_the_real_spawn_and_not_only_by_the_function() -> Outcome<()> {
        let rs = res!(run(exec("gp", &["/usr/bin/git", "push", "--force", "origin", "main"])).await);
        match rs.first() {
            Some(Resp::Refused { reason, .. }) => {
                assert!(reason.contains("fast-forward"),
                    "the refusal is not the push guard's: {}", reason);
                assert!(reason.contains("machine hand"), "{}", reason);
            },
            other => return Err(err!(
                "A forced push reached the launcher; the hand said {:?}.", other; Test, Mismatch)),
        }
        // And an ordinary git command is not refused by it. `--version` needs no repository, so
        // what this measures is the guard and not the state of the checkout.
        let rs = res!(run(exec("gv", &["/usr/bin/git", "--version"])).await);
        assert!(!matches!(rs.first(), Some(Resp::Refused { .. })),
            "an ordinary git command was refused: {:?}", rs.first());
        Ok(())
    }

    #[test]
    fn the_refusal_says_it_is_a_rule_rather_than_a_fault() {
        let argv: Vec<String> = ["git", "push", "-uf", "origin", "main"].iter()
            .map(|s| fmt!("{}", s)).collect();
        let s = match screen_git_push(&argv) {
            Some(s) => s,
            None    => panic!("a forced push was allowed"),
        };
        // The LETTER and not the cluster, or a model told `-uf` was refused tries `-u -f`.
        assert!(s.contains("'-f'"), "{}", s);
        assert!(s.contains("-uf"), "{}", s);
        assert!(s.contains("do not try another spelling"), "{}", s);
        assert!(s.contains("let the user push it themselves"),
            "the refusal leaves the model no way forward: {}", s);
    }

    #[test]
    fn test_timeout_is_clamped() {
        assert_eq!(clamp_timeout(0), DEFAULT_TIMEOUT_MS);
        assert_eq!(clamp_timeout(500), 500);
        assert_eq!(clamp_timeout(u64::MAX), TIMEOUT_MAX_MS);
    }

    #[test]
    fn test_chunks_split_on_character_boundaries() {
        let s = "é".repeat(CHUNK_MAX); // Two bytes each, so twice over the limit.
        let parts = split_chunks(&s);
        assert!(parts.len() > 1);
        for p in &parts {
            assert!(p.len() <= CHUNK_MAX);
        }
        assert_eq!(parts.concat(), s);
    }
}
