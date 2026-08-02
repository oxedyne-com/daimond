//! A real terminal for a command: `argv` only, fenced, and bidirectional.
//!
//! [`crate::exec`] runs a command down a pipe, and that covers nearly everything
//! an agent does.  It does not cover `sudo`, `ssh`, `vim`, `git commit`, `psql` or
//! any REPL, because none of those work down a pipe: each one asks the kernel
//! whether it is talking to a terminal and behaves differently when it is not.
//! `sudo` refuses to read a password, `ssh` refuses a passphrase, `git` opens an
//! editor that has nothing to draw on, and a shell turns off its prompt, its job
//! control and its line editing.  So this module allocates a real terminal and
//! gives the command the far end of it.
//!
//! # A terminal is not a flag on a pipe
//!
//! Three things have to be true before a program believes it has a terminal, and
//! only the first is about file descriptors:
//!
//! * `isatty(0)` must answer yes -- which a pty slave on the descriptor gives.
//! * The process must have that terminal as its **controlling terminal**, or
//!   `Ctrl-C` reaches nobody, `/dev/tty` cannot be opened, and a shell cannot set
//!   a foreground process group.  This is the part that is easy to get subtly
//!   wrong, and it is why [`adopt_terminal`] exists.
//! * The kernel must know how big it is, and must be told again every time the
//!   window changes; see [`PtySessions::resize`].
//!
//! # Where the controlling terminal is established, and why there
//!
//! A controlling terminal is claimed by a **session leader**, which means
//! `setsid` followed by `TIOCSCTTY` on the terminal, in the process that is about
//! to become the command.  The usual way to do that in Rust is
//! `CommandExt::pre_exec`, which is `unsafe` and which this project does not
//! write.
//!
//! It does not need to.  [`crate::exec`] already re-executes the hand as a
//! launcher, for the same reason in a different guise: the fence has to be
//! applied by the process that becomes the command, so the hand spawns *itself*,
//! applies the fence to itself, and `exec`s.  A launcher is an ordinary process
//! running ordinary code -- not a hook between `fork` and `exec` -- so it can
//! call `setsid` and `TIOCSCTTY` safely, and the terminal, like the fence, is
//! inherited across the `exec`.  [`adopt_terminal`] is that code, called by the
//! launcher when the plan says the command is to have a terminal.
//!
//! Two consequences worth naming.  The launcher is **not** given its own process
//! group by [`std::process::Command::process_group`], as the pipe path does:
//! `setsid` fails with `EPERM` for a process that already leads a group, and it
//! would undo the very thing it is there to do.  It produces the same group in
//! the end -- a session leader leads a new group whose id is its own process id --
//! so the group kill works exactly as it does for a piped run.  And when a
//! session leader claims a terminal, the kernel makes that leader's group the
//! terminal's **foreground process group**, which is what makes `Ctrl-C` work:
//! the line discipline sends `SIGINT` to whichever group is in the foreground,
//! and a shell that starts a job moves the foreground group to the job.
//!
//! # Bytes, not text
//!
//! Everything in both directions is base64, as [`crate::wire`] says.  A terminal
//! carries arbitrary bytes -- a `cat` of a binary, half a UTF-8 character at the
//! edge of a read, a control sequence, `0x03` -- and a lossy text conversion
//! corrupts exactly the case a terminal exists for.  `REVIEW.md` records the pipe
//! path's own version of this: it holds a partial character back between reads.
//! Here there is nothing to hold back, because nothing is decoded.
//!
//! # Bounded
//!
//! `REVIEW.md` §3.7 and §3.8 are both about one channel carrying everything.  The
//! answers here are shaped by them:
//!
//! * Nothing in the public API awaits the response channel except
//!   [`PtySessions::open`], which the dispatcher already calls from a task of its
//!   own.  [`PtySessions::input`], [`PtySessions::resize`] and
//!   [`PtySessions::close`] never block, so a `Bye` arriving behind a flood is
//!   still answered.
//! * Output is never buffered beyond one read of [`READ_MAX`], because the reader
//!   waits for room on the channel rather than accumulating.  That waiting is not
//!   a stall but the correct behaviour of a terminal: a program writing faster
//!   than the terminal can draw is made to wait by the pty itself, exactly as it
//!   would be by a slow serial line.  The reader is a task of its own, so a
//!   session whose output nobody is taking cannot delay a kill, a resize or
//!   another session.
//! * A session that has forwarded [`SESSION_OUTPUT_MAX`] is ended rather than
//!   truncated.  Discarding a run of bytes is right for a pipe and wrong for a
//!   terminal, where every dropped byte desynchronises the screen from that point
//!   on; a quarter of a gigabyte through one terminal is a runaway, and saying so
//!   is more honest than drawing the rest of the session wrong.
//! * Input is bounded twice: [`INPUT_MAX`] per message and [`WORD_QUEUE`]
//!   messages outstanding, so a page that types faster than a program reads is
//!   told rather than allowed to grow the hand.
//!
//! # The dependency
//!
//! `rustix` provides safe wrappers for the five system calls a terminal needs
//! that `std` has none of: `posix_openpt`, `grantpt`/`unlockpt`/`ptsname`,
//! `setsid`, `TIOCSCTTY` and `TIOCSWINSZ`.  `nix` was the obvious candidate and
//! covers only the first three: it has no safe `TIOCSWINSZ` and no safe
//! `TIOCSCTTY`, so both would have to be reached through its `ioctl_*!` macros,
//! which generate `unsafe fn`.  There is no `unsafe` in this file, and the choice
//! of crate is the reason there does not have to be.

use crate::{
    exec::{
        detected_fence,
        encode_payload,
        screen_env,
        screen_scratch,
        signal_group,
        vet_cwd,
        vet_program,
        Launcher,
        Payload,
        Scratch,
        Signalling,
        Vetted,
        Vetted0,
        DRAIN_GRACE_MS,
        TMP_VARS,
    },
    fence::Unfenced,
    wire::{
        PtySize,
        Req,
        Resp,
        Sig,
    },
};

use oxedyne_fe2o3_core::prelude::*;
use oxedyne_fe2o3_text::base64;

use std::{
    collections::HashMap,
    fs::File,
    io::{
        Read,
        Write,
    },
    os::fd::{
        AsFd,
        OwnedFd,
    },
    process::Stdio,
    sync::{
        Arc,
        Mutex,
    },
    time::Duration,
};

use tokio::{
    io::{
        unix::AsyncFd,
        AsyncWriteExt,
    },
    process::{
        Child,
        Command,
    },
    sync::mpsc::{
        error::TrySendError,
        Receiver,
        Sender,
    },
    task::JoinHandle,
    time::timeout,
};

// ┌───────────────────────────────────────────────────────────────┐
// │ Limits                                                         │
// └───────────────────────────────────────────────────────────────┘

/// What the hand tells a command its terminal is.
///
/// The hand's to set and not the caller's, as [`crate::wire::Req::Open`] says: a
/// caller that could name `TERM` could promise capabilities the page cannot draw,
/// and a program that believes in them draws a screen nobody can read.  This
/// value is what the page's terminal emulator implements.
pub const TERM: &str = "xterm-256color";

/// Bytes taken from the terminal in one read.
///
/// Base64 costs four characters for every three bytes, so a read of this size
/// becomes a little over 87 KiB of payload -- inside [`crate::wire::CHUNK_MAX`]
/// with room for the envelope, and far inside [`crate::wire::FRAME_MAX`].
pub const READ_MAX: usize = 64 * 1024;

/// The most typed input carried in one [`crate::wire::Req::Input`].
///
/// A keystroke is one byte and the longest ordinary burst is a paste.  Sixty-four
/// kilobytes of paste is already unusual; more than that is a caller trying to
/// use the terminal as a pipe, which is what [`crate::wire::Req::Exec`] is for.
pub const INPUT_MAX: usize = 64 * 1024;

/// How many messages may be outstanding to one session before the page is told.
///
/// Bounded rather than unbounded, and small: with [`INPUT_MAX`] this caps what
/// one unread session can hold at four megabytes, and a page typing faster than
/// the program reads is told so rather than allowed to grow the hand.
pub const WORD_QUEUE: usize = 64;

/// How many terminals may be open at once.
///
/// Every session is a pty, two tasks and a process group; a page that could open
/// them without limit could exhaust the machine's pty devices, which are shared
/// with everything else the user is running.
pub const SESSIONS_MAX: usize = 8;

/// The most output one session will forward before it is ended.
///
/// See the module documentation for why this ends the session rather than
/// truncating it.
pub const SESSION_OUTPUT_MAX: u64 = 256 * 1024 * 1024;

/// The largest terminal the hand will set.
///
/// A window size is two `u16` fields, and a caller sending 65,535 columns is
/// making every program that allocates a line buffer allocate a large one.
pub const CELLS_MAX: u16 = 4_000;

/// How long a write to the terminal is given before it is given up on.
///
/// A program that has stopped reading its terminal fills the pty's input buffer,
/// after which a write waits for ever.  That must not wedge the session: the
/// keystrokes are dropped, the page is told, and the session goes on answering.
const TYPE_GRACE_MS: u64 = 5_000;

/// How long a group signal is given before it is given up on.
const KILL_GRACE_MS: u64 = 2_000;

// ┌───────────────────────────────────────────────────────────────┐
// │ Outcomes the caller distinguishes                              │
// └───────────────────────────────────────────────────────────────┘

/// What became of a request to open a terminal.
///
/// An enum rather than an error, for the reason [`crate::exec::Launch`] gives: a
/// refusal is not a failure, and a model can recover from a sentence.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Opening {
    /// The terminal is open and the command is attached to it, under this
    /// process id, which is also its process group.
    Opened(u32),
    /// The hand declined; the sentence has already gone out as
    /// [`crate::wire::Resp::Refused`].
    Refused,
}

/// What became of a message aimed at a live session.
///
/// Three arms rather than two, because "the page typed faster than the program
/// read" and "the session has ended" are different facts and the page acts on
/// them differently.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Reached {
    /// The session has it.
    Delivered,
    /// The session's queue is full; the message was not delivered.
    Busy,
    /// No such session is live.  Not an error.
    Finished,
}

/// What a session's supervisor is told to do.
enum Word {
    /// Bytes typed at the terminal.
    Type(Vec<u8>),
    /// The window changed size.
    Size(PtySize),
    /// End the session now.
    Stop,
    /// The reader gave up, and this is what to tell the page first.
    Spent(String),
}

// ┌───────────────────────────────────────────────────────────────┐
// │ One session                                                    │
// └───────────────────────────────────────────────────────────────┘

/// One live terminal, as the registry holds it.
///
/// A handle and not the terminal itself: the pty, the child and the two tasks are
/// owned by the supervisor, and everything reaches them down one line.  That is
/// what keeps [`PtySessions::input`] and [`PtySessions::close`] free of locks
/// held across an `await` and free of any wait at all.
#[derive(Clone, Debug)]
pub struct PtySession {
    /// The caller's identifier.
    id:    String,
    /// The child's process id, which is also its process group.
    pid:   u32,
    /// The line to the supervisor, which owns the terminal.
    words: Sender<Word>,
}

impl PtySession {

    /// The caller's identifier for this session.
    pub fn id(&self) -> &str {
        &self.id
    }

    /// The process id of the command attached to this terminal.
    pub fn pid(&self) -> u32 {
        self.pid
    }

    /// Types bytes at the terminal, exactly as they were given.
    ///
    /// # Arguments
    /// * `bytes` - The raw keystrokes.
    pub fn write(&self, bytes: Vec<u8>) -> Reached {
        self.tell(Word::Type(bytes))
    }

    /// Tells the kernel the window changed size, which tells the program.
    ///
    /// # Arguments
    /// * `size` - The new size, in character cells.
    pub fn resize(&self, size: PtySize) -> Reached {
        self.tell(Word::Size(size))
    }

    /// Ends the session and everything it started.
    pub fn close(&self) -> Reached {
        self.tell(Word::Stop)
    }

    /// Hands one word to the supervisor without ever waiting.
    ///
    /// # Arguments
    /// * `w` - What the supervisor is to do.
    fn tell(&self, w: Word) -> Reached {
        match self.words.try_send(w) {
            Ok(())                          => Reached::Delivered,
            Err(TrySendError::Full(_))      => Reached::Busy,
            Err(TrySendError::Closed(_))    => Reached::Finished,
        }
    }
}

// A `Word` holds bytes and nothing that can be printed usefully, but the handle
// derives `Debug` so that a registry of them can be.
impl std::fmt::Debug for Word {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Type(b)   => write!(f, "Type({} bytes)", b.len()),
            Self::Size(s)   => write!(f, "Size({}x{})", s.cols, s.rows),
            Self::Stop      => write!(f, "Stop"),
            Self::Spent(_)  => write!(f, "Spent"),
        }
    }
}

// ┌───────────────────────────────────────────────────────────────┐
// │ The registry                                                   │
// └───────────────────────────────────────────────────────────────┘

/// Opens terminals, keeps them reachable, and closes them.
///
/// Cheap to clone: every clone shares one registry of live sessions.  The sibling
/// of [`crate::exec::Runner`] and deliberately the same shape, down to the
/// launcher it re-executes and the identifier it keys on.
#[derive(Clone)]
pub struct PtySessions {
    /// Live sessions, keyed by the caller's identifier.
    live:     Arc<Mutex<HashMap<String, PtySession>>>,
    /// What is re-executed to apply the fence.  See [`crate::exec::Launcher`].
    launcher: Arc<Launcher>,
}

impl Default for PtySessions {
    fn default() -> Self {
        Self::new()
    }
}

impl PtySessions {

    /// Creates an empty registry that fences through this binary.
    pub fn new() -> Self {
        Self::with_launcher(Launcher::SelfExe)
    }

    /// Creates an empty registry with a stated launcher.
    ///
    /// # Arguments
    /// * `launcher` - What to re-execute in order to apply the fence.
    pub fn with_launcher(launcher: Launcher) -> Self {
        Self {
            live:     Arc::new(Mutex::new(HashMap::new())),
            launcher: Arc::new(launcher),
        }
    }

    /// Opens a terminal and starts a command attached to it.
    ///
    /// [`crate::wire::Resp::Opened`] is sent before this returns; every
    /// [`crate::wire::Resp::Output`] and the closing
    /// [`crate::wire::Resp::Closed`] follow on `tx` from a task, in that order.
    ///
    /// The order of what happens here is the same as [`crate::exec::Runner::spawn`]'s
    /// and for the same reasons: the caller's own fence is checked *before* the
    /// hand widens it, the widenings are made before the plan because a launcher
    /// cannot add to a plan it is handed, and a fence that cannot be honoured is a
    /// refusal on this side of the `exec` rather than a death on the other.
    ///
    /// # Arguments
    /// * `req` - A [`crate::wire::Req::Open`]; any other variant is a caller bug.
    /// * `tx` - Where every response about this session is sent.
    ///
    /// # Returns
    /// [`Opening::Opened`] with the child's process id, or [`Opening::Refused`].
    pub async fn open(&self, req: Req, tx: Sender<Resp>) -> Outcome<Opening> {
        let (id, argv, cwd, mut env, size, mut fence) = match req {
            // `toolkits` is spent before the request gets here; see `Runner::spawn`.
            Req::Open { id, argv, cwd, env, size, fence, toolkits: _ } =>
                (id, argv, cwd, env, size, fence),
            other => return Err(err!(
                "PtySessions::open was given {:?}, which is not an Open request.", other;
                Bug, Invalid, Input)),
        };

        if argv.is_empty() {
            return self.refuse(&id, &tx, fmt!(
                "Refused: a terminal was asked for with no program to run in it. The first element \
                of argv is the program and the rest are its arguments -- a shell is a perfectly \
                ordinary thing to put there, and usually what you want.")).await;
        }

        // The answers are taken out of the lock before they are used, so that no
        // guard is held across the `await` that sends a refusal.
        let (already, open_now) = {
            let g = lock_mutex!(self.live);
            (g.contains_key(&id), g.len())
        };
        if already {
            return self.refuse(&id, &tx, fmt!(
                "Refused: '{}' is already the identifier of a terminal that is still open. \
                Identifiers are how keystrokes reach a session and how its output is recognised, \
                so two cannot share one. Give this one a different id, or close the one already \
                open.", id)).await;
        }
        if open_now >= SESSIONS_MAX {
            return self.refuse(&id, &tx, fmt!(
                "Refused: {} terminals are already open, which is as many as this hand will hold. \
                Every one is a pseudo-terminal device shared with the rest of the machine. Close \
                one before opening another.", SESSIONS_MAX)).await;
        }

        if let Some(s) = screen_env(&env) {
            return self.refuse(&id, &tx, s).await;
        }
        if let Some(s) = screen_scratch(&env) {
            return self.refuse(&id, &tx, s).await;
        }
        if let Some(s) = screen_term(&env) {
            return self.refuse(&id, &tx, s).await;
        }

        // Against the fence the caller sent, before the hand widens it: the
        // scratch and the terminal are roots the caller did not ask for, and a
        // spec that grants nothing must still read as granting nothing.
        let dir = match vet_cwd(&cwd, &fence) {
            Vetted::Ok(p)       => p,
            Vetted::Refused(s)  => return self.refuse(&id, &tx, s).await,
        };

        let scratch = match Scratch::make(&id) {
            Ok(s)  => s,
            Err(e) => return self.refuse(&id, &tx, fmt!(
                "Refused: this session could not be given a private directory to write temporary \
                files in, and the hand will not run one without. {} ", e.msgs().join(" "))).await,
        };
        fence.rw.push(fmt!("{}", scratch.dir().display()));
        // Appended after the caller's pairs, so that the hand's answer is the
        // last word even if one of these names ever reached this far.
        for k in TMP_VARS {
            env.push((fmt!("{}", k), fmt!("{}", scratch.dir().display())));
        }
        env.push((fmt!("TERM"), fmt!("{}", TERM)));

        let term = match Pty::make(size) {
            Ok(p)  => p,
            Err(e) => return self.refuse(&id, &tx, fmt!(
                "Refused: this machine would not give the hand a pseudo-terminal, so there is no \
                terminal to attach the command to. {}", e.msgs().join(" "))).await,
        };

        // The terminal the hand made is added to the fence, like the scratch and
        // for the same reason: a program on a terminal is entitled to its own
        // terminal, and `sudo` asking for a password opens `/dev/tty` to do it.
        // Neither grant widens anything the caller could have reached otherwise
        // -- `/dev/tty` resolves to the process's own controlling terminal, which
        // is this pty and nothing else.
        fence.rw.push(fmt!("{}", term.path.display()));
        fence.rw.push(fmt!("/dev/tty"));

        let plan = match detected_fence().plan(&fence, &Unfenced::Refuse) {
            Ok(p)  => p,
            Err(e) => return self.refuse(&id, &tx, fmt!(
                "Refused: {}", e.msgs().join(" "))).await,
        };

        let prog = match vet_program(&argv[0], &dir, &env, &plan) {
            Vetted0::Ok(p)      => p,
            Vetted0::Refused(s) => return self.refuse(&id, &tx, s).await,
        };

        let payload = res!(encode_payload(&Payload {
            prog: prog.clone(),
            argv: argv.clone(),
            env:  env.clone(),
            plan: plan.clone(),
            tty:  true,
        }));

        let mut cmd = Command::new(res!(self.launcher.prog()));
        cmd.args(self.launcher.args());
        cmd.current_dir(&dir);
        cmd.env_clear();
        for (k, v) in self.launcher.env() {
            cmd.env(k, v);
        }

        // Standard input is the launcher's channel, exactly as it is for a piped
        // run: the plan arrives there, and the launcher replaces the descriptor
        // with the terminal before it becomes the command. Standard output and
        // standard error are the terminal from the first instant, which means the
        // pty has a reader before the hand starts watching it -- without that,
        // reading a master no slave has opened yet answers EIO, and the session
        // would close before it began. It also means a launcher that dies saying
        // why says it on the terminal, where the page can see it.
        cmd.stdin(Stdio::piped());
        cmd.stdout(Stdio::from(res!(term.slave_dup())));
        cmd.stderr(Stdio::from(res!(term.slave_dup())));
        cmd.kill_on_drop(true);

        // Deliberately no `process_group(0)`: the launcher calls `setsid`, which
        // fails with EPERM for a process that already leads a group. It arrives
        // at the same place -- a session leader leads a new group whose id is its
        // own process id -- so the group kill below reaches the whole tree just
        // as it does for a piped run.

        let mut child = res!(cmd.spawn()
            .map_err(|e| err!(e,
                "The hand could not start the launcher that fences '{}' on a terminal in '{}'.",
                prog.display(), dir.display();
                IO, Init)));

        let pid = match child.id() {
            Some(p) => p,
            None    => return Err(err!(
                "The child exited before the hand could learn its process id."; IO, Unexpected)),
        };

        if let Some(mut w) = child.stdin.take() {
            tokio::spawn(async move {
                let _ = w.write_all(&payload).await;
                let _ = w.shutdown().await; // Nothing follows the plan: input is typed.
            });
        }

        // The hand's own copy of the slave goes now, so that when the command
        // exits and the last descriptor on it closes, the master reports it and
        // the session ends. Held on to, it would keep the terminal open for ever
        // and the page would wait for a `Closed` that could not come.
        let Pty { master, path: _, slave } = term;
        drop(slave);

        let (wordtx, wordrx) = tokio::sync::mpsc::channel::<Word>(WORD_QUEUE);
        let session = PtySession { id: id.clone(), pid, words: wordtx.clone() };
        {
            let mut g = lock_mutex!(self.live);
            g.insert(id.clone(), session);
        }

        if tx.send(Resp::Opened { id: id.clone(), pid }).await.is_err() {
            // The entry was made before the announcement and must not outlive it:
            // left behind it is permanent, because there would be no supervisor
            // to receive anything sent to it. The child dies with `cmd`, which
            // was built with `kill_on_drop`.
            {
                let mut g = lock_mutex!(self.live);
                g.remove(&id);
            }
            return Err(err!(
                "The page stopped listening before '{}' could be announced.", id;
                Channel, IO));
        }

        let sess = Watch {
            id:      id.clone(),
            pgid:    pid,
            live:    Arc::clone(&self.live),
            tx:      tx.clone(),
            scratch: Some(scratch),
        };
        tokio::spawn(async move {
            let wid = sess.id.clone();
            let wtx = sess.tx.clone();
            if let Err(e) = watch(sess, child, master, wordrx, wordtx).await {
                let _ = wtx.send(Resp::Error {
                    id:      Some(wid),
                    message: fmt!("{}", e),
                }).await;
            }
        });

        Ok(Opening::Opened(pid))
    }

    /// Types at a live session, decoding the base64 the wire carries.
    ///
    /// Never waits, so the dispatcher can answer this while a session floods.
    ///
    /// # Arguments
    /// * `id` - The identifier given at [`crate::wire::Req::Open`].
    /// * `data` - Base64 of the bytes typed.
    pub fn input(&self, id: &str, data: &str) -> Outcome<Reached> {
        let bytes = res!(base64::decode(data).map_err(|e| err!(e,
            "The keystrokes for '{}' are not the base64 the wire carries, so the hand does not \
            know what was typed and will not guess.", id;
            Invalid, Input, Decode)));
        if bytes.len() > INPUT_MAX {
            return Err(err!(
                "'{}' was sent {} bytes of input at once and {} is the most a terminal will take. \
                A terminal is for typing; a payload that size wants Exec and a stdin field.",
                id, bytes.len(), INPUT_MAX;
                Excessive, Input, Size));
        }
        Ok(self.with(id, |s| s.write(bytes)))
    }

    /// Tells a live session's terminal that the window changed size.
    ///
    /// # Arguments
    /// * `id` - The identifier given at [`crate::wire::Req::Open`].
    /// * `size` - The new size, in character cells.
    pub fn resize(&self, id: &str, size: PtySize) -> Outcome<Reached> {
        Ok(self.with(id, |s| s.resize(size)))
    }

    /// Ends one session.
    ///
    /// # Arguments
    /// * `id` - The identifier given at [`crate::wire::Req::Open`].
    pub fn close(&self, id: &str) -> Outcome<Reached> {
        Ok(self.with(id, |s| s.close()))
    }

    /// Ends every session, on the way out of a conversation.
    ///
    /// Called from the shutdown block in `main`, beside `Runner::stop_all`, which is the one place
    /// every ending passes through -- a goodbye, a page that vanished, a loop that failed.  Putting
    /// it in the [`crate::wire::Req::Bye`] arm as well would be a second call site for one rule,
    /// and it is the second call site that eventually gets forgotten: this had NO call site for
    /// long enough that its own doc comment described a caller that did not exist.
    ///
    /// Each session's stop sweeps every process group in it and not merely the leader's -- see
    /// [`sweep`], and the `sleep 60 &` that is the reason.
    ///
    /// # Returns
    /// How many sessions were told to stop.
    pub fn close_all(&self) -> Outcome<usize> {
        let all = {
            let g = lock_mutex!(self.live);
            g.values().cloned().collect::<Vec<_>>()
        };
        let mut n = 0;
        for s in all {
            if s.close() != Reached::Finished {
                n += 1;
            }
        }
        Ok(n)
    }

    /// The process id of a live session, or `None` if it has closed.
    ///
    /// # Arguments
    /// * `id` - The identifier given at [`crate::wire::Req::Open`].
    pub fn pid_of(&self, id: &str) -> Outcome<Option<u32>> {
        let g = lock_mutex!(self.live);
        Ok(g.get(id).map(|s| s.pid))
    }

    /// How many sessions are open.
    pub fn live_count(&self) -> Outcome<usize> {
        let g = lock_mutex!(self.live);
        Ok(g.len())
    }

    /// Does something to a named session, if it is still there.
    ///
    /// The handle is cloned out of the lock before it is used, so the registry is
    /// never locked while a message is being handed over.
    ///
    /// # Arguments
    /// * `id` - The session.
    /// * `f` - What to do with it.
    fn with<F>(&self, id: &str, f: F) -> Reached
    where
        F: FnOnce(&PtySession) -> Reached,
    {
        let found = {
            let g = match self.live.lock() {
                Ok(g)  => g,
                Err(p) => p.into_inner(), // A poisoned registry is still a registry.
            };
            g.get(id).cloned()
        };
        match found {
            Some(s) => f(&s),
            None    => Reached::Finished,
        }
    }

    /// Sends a refusal and reports it, so the caller does not repeat itself.
    ///
    /// # Arguments
    /// * `id` - The session the refusal concerns.
    /// * `tx` - Where the refusal is sent.
    /// * `reason` - The whole sentence.
    async fn refuse(&self, id: &str, tx: &Sender<Resp>, reason: String) -> Outcome<Opening> {
        if tx.send(Resp::Refused { id: fmt!("{}", id), reason }).await.is_err() {
            return Err(err!(
                "The page stopped listening before the refusal for '{}' could be sent.", id;
                Channel, IO));
        }
        Ok(Opening::Refused)
    }
}

/// Refuses an environment that tries to say what the terminal is.
///
/// Refused rather than dropped, for the reason [`crate::exec`]'s screens give: a
/// caller whose setting silently did not take effect has no way to find that out.
///
/// # Arguments
/// * `env` - The pairs the caller asked for.
///
/// # Returns
/// The refusal sentence, or `None` if the caller left the question alone.
fn screen_term(env: &[(String, String)]) -> Option<String> {
    for (k, _) in env {
        if k == "TERM" {
            return Some(fmt!(
                "Refused: this session asked to run with TERM set. TERM is what a program asks in \
                order to know what the terminal can draw, and the hand sets it to {} because that \
                is what the page implements. A caller able to name it could promise a program \
                capabilities nothing on the other end can draw.", TERM));
        }
    }
    None
}

// ┌───────────────────────────────────────────────────────────────┐
// │ The terminal itself                                            │
// └───────────────────────────────────────────────────────────────┘

/// A pseudo-terminal pair, before the command is attached to it.
struct Pty {
    /// The end the hand holds: what the program writes appears here, and what is
    /// written here is what the program reads.
    master: OwnedFd,
    /// The end the command holds, by name.  The launcher opens this after
    /// `setsid` so that it becomes the command's controlling terminal.
    path:   std::path::PathBuf,
    /// The end the command holds, as a descriptor, kept only long enough to give
    /// the launcher one.
    slave:  OwnedFd,
}

impl Pty {

    /// Allocates a terminal of the size the page asked for.
    ///
    /// The four calls are the POSIX ritual and all four are safe here:
    /// `posix_openpt` takes the master, `grantpt` and `unlockpt` make the slave
    /// openable, and `ptsname` says what to open.  `O_NOCTTY` is on both opens
    /// because neither the hand nor anything it does should acquire a controlling
    /// terminal by accident -- only the launcher does that, deliberately, after
    /// `setsid`.
    ///
    /// # Arguments
    /// * `size` - How big the terminal is when it opens.
    fn make(size: PtySize) -> Outcome<Self> {
        use rustix::{
            fs::{
                Mode,
                OFlags,
            },
            pty::{
                grantpt,
                openpt,
                ptsname,
                unlockpt,
            },
        };

        let master = res!(openpt(
            rustix::pty::OpenptFlags::RDWR
            | rustix::pty::OpenptFlags::NOCTTY
            | rustix::pty::OpenptFlags::CLOEXEC)
            .map_err(|e| err!(e,
                "This machine would not open a pseudo-terminal."; IO, System)));
        res!(grantpt(&master).map_err(|e| err!(e,
            "The pseudo-terminal's far end could not be made usable."; IO, System)));
        res!(unlockpt(&master).map_err(|e| err!(e,
            "The pseudo-terminal's far end could not be unlocked."; IO, System)));

        let name = res!(ptsname(&master, Vec::new()).map_err(|e| err!(e,
            "The pseudo-terminal has no name, so there is nothing for the command to open.";
            IO, System)));
        let path = std::path::PathBuf::from(match name.into_string() {
            Ok(s)  => s,
            Err(e) => return Err(err!(
                "The pseudo-terminal's name is not text ({:?}).", e; IO, System, Invalid)),
        });

        // Opened by the hand as well as by the launcher: this is the descriptor
        // the launcher is started with, and holding the terminal open across the
        // whole of the launcher's life is what stops the master reporting the end
        // of the session before the session has begun.
        let slave = res!(rustix::fs::open(&path, OFlags::RDWR | OFlags::NOCTTY, Mode::empty())
            .map_err(|e| err!(e,
                "The pseudo-terminal '{}' could not be opened.", path.display(); IO, System)));

        // Non-blocking, because the master is about to be watched by the runtime,
        // and a blocking read on it would stop every other task on the thread.
        res!(rustix::io::ioctl_fionbio(&master, true).map_err(|e| err!(e,
            "The pseudo-terminal could not be made non-blocking."; IO, System)));

        let this = Self { master, path, slave };
        res!(this.set_size(size));
        Ok(this)
    }

    /// Another descriptor on the command's end of the terminal.
    ///
    /// One each for the launcher's standard output and standard error, because
    /// `Stdio` takes ownership of what it is given.
    fn slave_dup(&self) -> Outcome<OwnedFd> {
        Ok(res!(self.slave.try_clone().map_err(|e| err!(e,
            "The pseudo-terminal's far end could not be duplicated."; IO, System))))
    }

    /// Tells the kernel how big the terminal is.
    ///
    /// # Arguments
    /// * `size` - The size, in character cells.
    fn set_size(&self, size: PtySize) -> Outcome<()> {
        res!(set_winsize(&self.master, size));
        Ok(())
    }
}

/// Sets a terminal's window size, which is what makes the kernel signal the
/// program.
///
/// The size is clamped rather than refused: a window of no columns is not a
/// window, and a page that reports one has a layout problem, not a request the
/// hand should end a session over.
///
/// # Arguments
/// * `fd` - Either end of the terminal.
/// * `size` - The size, in character cells.
fn set_winsize<F: AsFd>(fd: F, size: PtySize) -> Outcome<()> {
    let ws = rustix::termios::Winsize {
        ws_row:    size.rows.clamp(1, CELLS_MAX),
        ws_col:    size.cols.clamp(1, CELLS_MAX),
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    res!(rustix::termios::tcsetwinsize(fd, ws).map_err(|e| err!(e,
        "The terminal would not take a size of {} columns by {} rows.", size.cols, size.rows;
        IO, System)));
    Ok(())
}

// ┌───────────────────────────────────────────────────────────────┐
// │ The launcher's half                                            │
// └───────────────────────────────────────────────────────────────┘

/// Makes the terminal on descriptor 1 this process's controlling terminal, and
/// hands back the same terminal for descriptor 0.
///
/// Called by [`crate::exec::launch_main`] when the plan says the command is to
/// have a terminal, and called there rather than here because it must happen in
/// the process that is about to *become* the command: a controlling terminal, like
/// the fence, is inherited across `exec` and cannot be given to somebody else's
/// child.
///
/// Three steps and each is necessary:
///
/// * `setsid` puts this process in a session of its own with no controlling
///   terminal.  Without it `TIOCSCTTY` fails, because only a session leader may
///   claim a terminal.  It also makes this process a group leader, which is why
///   the hand does not ask for a process group when it spawns the launcher --
///   `setsid` would then fail with `EPERM`.
/// * `TIOCSCTTY` claims the terminal.  The kernel makes this process's group the
///   terminal's foreground group as it does so, which is what makes `Ctrl-C`
///   reach the command: the line discipline signals the foreground group, and a
///   shell that starts a job moves that group to the job.
/// * Descriptor 0 is still the pipe the plan arrived on, so the terminal is
///   duplicated for it.  Descriptors 1 and 2 are already the terminal.
///
/// It runs **before** the fence is applied.  Nothing here needs a grant that way,
/// so a session's fence does not have to include the machinery that built it.
///
/// # Returns
/// What the command's standard input should be.
pub fn adopt_terminal() -> Outcome<Stdio> {
    let out = std::io::stdout();
    if !rustix::termios::isatty(&out) {
        return Err(err!(
            "The plan says this command is to have a terminal, and the descriptor the hand \
            provided is not one. Nothing was run.";
            Invalid, Input, Bug));
    }
    res!(rustix::process::setsid().map_err(|e| err!(e,
        "This process could not start a session of its own, so it cannot own a terminal.";
        IO, System)));
    res!(rustix::process::ioctl_tiocsctty(&out).map_err(|e| err!(e,
        "The terminal would not become this process's controlling terminal, so Ctrl-C would \
        reach nothing and /dev/tty could not be opened.";
        IO, System)));
    let dup = res!(out.as_fd().try_clone_to_owned().map_err(|e| err!(e,
        "The terminal could not be duplicated onto standard input."; IO, System)));
    Ok(Stdio::from(dup))
}

// ┌───────────────────────────────────────────────────────────────┐
// │ Supervision                                                    │
// └───────────────────────────────────────────────────────────────┘

/// Everything the supervisor needs that is not the terminal or the child.
struct Watch {
    /// The caller's identifier.
    id:      String,
    /// The child's process group, which is its process id.
    pgid:    u32,
    /// The shared registry, so the session can forget itself when it ends.
    live:    Arc<Mutex<HashMap<String, PtySession>>>,
    /// Where responses go.
    tx:      Sender<Resp>,
    /// The session's private temporary directory, removed by the one piece of
    /// code that sees every way a session can end.
    scratch: Option<Scratch>,
}

/// Watches one session to its end and sends the closing [`crate::wire::Resp::Closed`].
///
/// # Arguments
/// * `watch` - The session's identity and outputs.
/// * `child` - The spawned launcher, which has become the command.
/// * `master` - The hand's end of the terminal.
/// * `words` - Keystrokes, resizes and the order to stop.
/// * `wordtx` - A live sender, kept so the receiver never reports closure and so
///   the reader can ask for the session to end.
async fn watch(
    mut watch:  Watch,
    mut child:  Child,
    master:     OwnedFd,
    mut words:  Receiver<Word>,
    wordtx:     Sender<Word>,
)
    -> Outcome<()>
{
    // Two descriptors on one terminal: the reader owns one and this task owns the
    // other. That is what lets a session whose output nobody is taking still be
    // resized and still be killed -- a single task doing both would be waiting on
    // the channel with the keystrokes unread behind it.
    let for_read = res!(master.try_clone().map_err(|e| err!(e,
        "The terminal could not be duplicated for reading."; IO, System)));
    let read_fd = res!(AsyncFd::new(File::from(for_read)).map_err(|e| err!(e,
        "The terminal could not be watched for output."; IO, System)));
    let write_fd = res!(AsyncFd::new(File::from(master)).map_err(|e| err!(e,
        "The terminal could not be watched for input."; IO, System)));

    let mut reader: JoinHandle<()> = tokio::spawn(read_out(
        read_fd, watch.id.clone(), watch.tx.clone(), wordtx.clone()));

    let mut stopped = false;
    let mut degraded: Option<String> = None;

    let status = loop {
        tokio::select! {
            r = child.wait() => break r,
            w = words.recv() => {
                match w {
                    Some(Word::Type(bytes)) => {
                        match timeout(
                            Duration::from_millis(TYPE_GRACE_MS),
                            type_in(&write_fd, &bytes)).await
                        {
                            Ok(Ok(()))  => (),
                            Ok(Err(e))  => {
                                let _ = watch.tx.send(Resp::Error {
                                    id:      Some(watch.id.clone()),
                                    message: fmt!(
                                        "What was typed did not reach the terminal. {}",
                                        e.msgs().join(" ")),
                                }).await;
                            },
                            Err(_) => {
                                let _ = watch.tx.send(Resp::Error {
                                    id:      Some(watch.id.clone()),
                                    message: fmt!(
                                        "The program has not read its terminal for {} ms and the \
                                        terminal's own buffer is full, so {} bytes of what was \
                                        typed were dropped. The session is still open.",
                                        TYPE_GRACE_MS, bytes.len()),
                                }).await;
                            },
                        }
                    },
                    Some(Word::Size(size)) => {
                        if let Err(e) = set_winsize(write_fd.get_ref(), size) {
                            let _ = watch.tx.send(Resp::Error {
                                id:      Some(watch.id.clone()),
                                message: fmt!(
                                    "The terminal could not be resized, so the program still \
                                    believes it has the size it had. {}", e.msgs().join(" ")),
                            }).await;
                        }
                    },
                    Some(Word::Spent(why)) => {
                        let _ = watch.tx.send(Resp::Error {
                            id:      Some(watch.id.clone()),
                            message: why,
                        }).await;
                        stopped = true;
                        sweep(watch.pgid, &mut degraded).await;
                        let _ = child.start_kill();
                    },
                    Some(Word::Stop) | None => {
                        stopped = true;
                        // The group and not the child: a shell's own children are
                        // what a terminal session is made of, and killing only the
                        // shell leaves them holding the terminal open.
                        sweep(watch.pgid, &mut degraded).await;
                        let _ = child.start_kill();
                    },
                }
            },
        }
    };

    // The command has gone. Anything it started is still running, and this is
    // where that ends: a session must not leave processes behind it. Swept again
    // even when it was swept on the way in, because the first sweep raced with
    // whatever the shell was starting at the time. The reader is then given a
    // moment to take what is still in the terminal's buffer before it is
    // abandoned.
    sweep(watch.pgid, &mut degraded).await;
    if timeout(Duration::from_millis(DRAIN_GRACE_MS), &mut reader).await.is_err() {
        reader.abort();
    }

    if let Some(why) = &degraded {
        let _ = watch.tx.send(Resp::Error {
            id:      Some(watch.id.clone()),
            message: fmt!(
                "The signal reached the command itself but not the process group it leads, so \
                anything it had started may still be running. {}", why),
        }).await;
    }

    // Forgotten before it is announced, so that a keystroke arriving after the
    // announcement is answered `Finished` rather than sent nowhere.
    {
        let mut g = lock_mutex!(watch.live);
        g.remove(&watch.id);
    }

    if let Some(mut s) = watch.scratch.take() {
        if let Err(e) = s.remove() {
            let _ = watch.tx.send(Resp::Error {
                id:      Some(watch.id.clone()),
                message: fmt!(
                    "The session's private temporary directory could not be removed, so what it \
                    wrote there is still on this machine. {}", e.msgs().join(" ")),
            }).await;
        }
    }

    let (exit, killed) = match &status {
        Ok(st) => match st.code() {
            Some(c) => (c, stopped),
            // No exit code means a signal ended it, which is the ordinary way a
            // terminal's Ctrl-C ends a program and is exactly what the page needs
            // to be able to tell apart from the program's own decision to stop.
            None    => (-1, true),
        },
        Err(_) => (-1, stopped),
    };

    if watch.tx.send(Resp::Closed { id: watch.id.clone(), exit, killed }).await.is_err() {
        return Err(err!(
            "The page stopped listening before '{}' could be closed off.", watch.id;
            Channel, IO));
    }

    if let Err(e) = status {
        return Err(err!(e, "Waiting on '{}' failed.", watch.id; IO));
    }
    Ok(())
}

/// Kills everything in a session, and not merely the group its leader leads.
///
/// The distinction is the whole of this function, and it was found by a test
/// rather than reasoned about in advance.  A terminal is what makes job control
/// work, and job control means the shell puts **each job in a process group of
/// its own**: `sleep 60 &` typed at a session leaves a process the leader's group
/// does not contain.  Signalling that one group -- which is what
/// [`crate::exec`] does, correctly, for a piped run where no job control exists
/// -- left the `sleep` running after the page had been told the session had
/// closed.  Closing the terminal does not help either: the kernel hangs up the
/// *foreground* group, and a background job is by definition not it.
///
/// So every group in the session is signalled.  The session is read from `/proc`,
/// which the hand may do because the hand is not the fenced thing; where there is
/// no `/proc` the leader's own group is still signalled, and that is the same
/// guarantee the pipe path gives.
///
/// # Arguments
/// * `sid` - The session, whose id is the process id the launcher was given.
/// * `degraded` - Where the first failure to signal is kept.
async fn sweep(sid: u32, degraded: &mut Option<String>) {
    // The leader's own group first: it is the common case, and it stops the
    // shell starting anything else while the rest is being worked out.
    note(degraded, timeout(
        Duration::from_millis(KILL_GRACE_MS),
        signal_group(sid, Sig::Kill)).await);

    for pgid in session_groups(sid) {
        if pgid == sid || pgid == 0 {
            continue;
        }
        note(degraded, timeout(
            Duration::from_millis(KILL_GRACE_MS),
            signal_group(pgid, Sig::Kill)).await);
    }
}

/// Every distinct process group in a session, according to `/proc`.
///
/// The fourth and sixth fields of `stat` are the group and the session, and both
/// are read from after the last `)` because the second field is the executable's
/// name and may contain brackets, spaces and anything else a file name may.
///
/// A process that ends while the directory is being read is skipped rather than
/// reported: this is a best effort by construction, which is why the caller
/// signals the leader's group whatever this returns.
///
/// # Arguments
/// * `sid` - The session to look for.
fn session_groups(sid: u32) -> Vec<u32> {
    let dir = match std::fs::read_dir("/proc") {
        Ok(d)  => d,
        Err(_) => return Vec::new(), // No /proc: the leader's group is all there is.
    };
    let mut found = Vec::new();
    for entry in dir.flatten() {
        let name = entry.file_name();
        if !name.to_string_lossy().chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        let stat = match std::fs::read_to_string(entry.path().join("stat")) {
            Ok(s)  => s,
            Err(_) => continue, // It ended while we were looking at it.
        };
        let tail = match stat.rsplit_once(')') {
            Some((_, t)) => t,
            None         => continue,
        };
        // What follows the name is: state, parent, group, session.
        let mut fields = tail.split_whitespace().skip(2);
        let pgrp = match fields.next().and_then(|f| f.parse::<u32>().ok()) {
            Some(v) => v,
            None    => continue,
        };
        let sess = match fields.next().and_then(|f| f.parse::<u32>().ok()) {
            Some(v) => v,
            None    => continue,
        };
        if sess == sid && !found.contains(&pgrp) {
            found.push(pgrp);
        }
    }
    found
}

/// Keeps the first thing that went wrong with a group signal, if anything did.
///
/// # Arguments
/// * `slot` - Where the explanation is kept.
/// * `got` - What the attempt returned, or `Err` if it ran out of time.
fn note(
    slot: &mut Option<String>,
    got:  Result<Signalling, tokio::time::error::Elapsed>,
) {
    if slot.is_some() {
        return;
    }
    *slot = match got {
        Ok(Signalling::Sent)                => None,
        // A group that is already gone is the ORDINARY case, not a degradation: a session
        // usually ends because the shell exited, and by the time the sweep runs there is
        // nothing left to signal. Reported as a fault, it told the page a clean `exit` had
        // failed to stop something -- which is both untrue and the opposite of reassuring.
        Ok(Signalling::Degraded(why)) if gone(&why)    => None,
        Ok(Signalling::Unavailable(why)) if gone(&why) => None,
        Ok(Signalling::Degraded(why))       => Some(why),
        Ok(Signalling::Unavailable(why))    => Some(why),
        Err(_)                              => Some(fmt!(
            "The kill helper did not finish within {} ms and was given up on.", KILL_GRACE_MS)),
    };
}

/// Whether a failure to signal means the target had already finished.
///
/// `kill` says so in words rather than by exit code, and the words differ between util-linux
/// and BusyBox, so both spellings of the one condition are matched.  Anything else is a real
/// failure and is kept.
///
/// # Arguments
/// * `why` - What the signal attempt reported.
fn gone(why: &str) -> bool {
    let w = why.to_ascii_lowercase();
    w.contains("no such process") || w.contains("esrch")
}

/// Reads the terminal to its end, emitting bounded, sequenced, base64 output.
///
/// Nothing is decoded and nothing is held back: every byte the terminal produced
/// is forwarded as it was produced.  The wait for room on the channel is the
/// terminal's own back pressure and is left in place deliberately -- a program
/// writing faster than the far end can draw is made to wait by the pty, which is
/// what every terminal since the teletype has done, and is better than a screen
/// drawn from bytes with a hole in them.
///
/// # Arguments
/// * `fd` - The hand's end of the terminal.
/// * `id` - The caller's identifier.
/// * `tx` - Where output is sent.
/// * `words` - The line to the supervisor, used only to end a runaway session.
async fn read_out(
    fd:    AsyncFd<File>,
    id:    String,
    tx:    Sender<Resp>,
    words: Sender<Word>,
) {
    let mut buf   = vec![0u8; READ_MAX];
    let mut seq   = 0u64;
    let mut spent = 0u64;

    loop {
        let mut guard = match fd.readable().await {
            Ok(g)  => g,
            Err(_) => return,
        };
        let got = match guard.try_io(|f| (&*f.get_ref()).read(&mut buf)) {
            Ok(Ok(0))   => return, // The terminal is closed.
            Ok(Ok(n))   => n,
            // EIO on a master is not a fault: it is what the kernel says when the
            // last descriptor on the other end has gone, which is how the end of
            // a session announces itself.
            Ok(Err(_))  => return,
            Err(_)      => {
                guard.clear_ready();
                continue;
            },
        };

        spent += got as u64;
        if spent > SESSION_OUTPUT_MAX {
            let _ = words.try_send(Word::Spent(fmt!(
                "This terminal has produced {} bytes, which is more than the {} one session may \
                send, and it is being closed. Output was not truncated: a terminal drawn from \
                bytes with a hole in them is wrong from that point on, so the session ends \
                instead. Whatever is producing this much output wants Exec, not a terminal.",
                spent, SESSION_OUTPUT_MAX)));
            return;
        }

        let msg = Resp::Output {
            id:   fmt!("{}", id),
            seq,
            data: base64::encode(&buf[..got]),
        };
        if tx.send(msg).await.is_err() {
            return; // The page stopped listening; the supervisor will notice.
        }
        seq += 1;
    }
}

/// Writes every byte of `bytes` to the terminal, however many turns it takes.
///
/// # Arguments
/// * `fd` - The hand's end of the terminal.
/// * `bytes` - What was typed.
async fn type_in(fd: &AsyncFd<File>, bytes: &[u8]) -> Outcome<()> {
    let mut at = 0usize;
    while at < bytes.len() {
        let mut guard = res!(fd.writable().await.map_err(|e| err!(e,
            "The terminal could not be waited on for room."; IO)));
        match guard.try_io(|f| (&*f.get_ref()).write(&bytes[at..])) {
            Ok(Ok(0))   => return Err(err!(
                "The terminal took none of the {} bytes still to be typed.", bytes.len() - at;
                IO, Write)),
            Ok(Ok(n))   => at += n,
            Ok(Err(e))  => return Err(err!(e,
                "The terminal would not take what was typed."; IO, Write)),
            Err(_)      => guard.clear_ready(),
        }
    }
    Ok(())
}

// ┌───────────────────────────────────────────────────────────────┐
// │ Tests                                                          │
// └───────────────────────────────────────────────────────────────┘

#[cfg(test)]
mod tests {
    use super::*;

    use crate::exec::launch_main;

    use std::path::{
        Path,
        PathBuf,
    };

    use tokio::sync::mpsc::Receiver as RespRx;

    // ── Becoming the launcher ───────────────────────────────────────
    //
    // As in `exec`: every session here is really fenced, by the real
    // `launch_main`, in a real second process, because the test binary can be
    // made to re-enter itself. `/proc/self/exe` here is libtest, whose `main`
    // will not dispatch `LAUNCH_ARG`, so the launcher is invoked as "run exactly
    // the test named below" and that test calls `launch_main`.
    //
    // One artefact, and it is louder here than there: libtest announces itself on
    // standard output before reaching the test, and standard output is the
    // terminal, so every session opens with that announcement -- with its
    // newlines turned into carriage-return line-feed pairs by the terminal's own
    // output processing, which is itself a small proof that a terminal is what
    // this is. The tests therefore look for what they expect inside the output
    // rather than at the whole of it.

    /// The environment name that turns a copy of the test binary into a launcher.
    const LAUNCH_CHILD: &str = "DAIMOND_HAND_TEST_PTY_LAUNCHER";

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
            "The launcher tests need to know their own binary."; Test, IO)));
        Ok(Launcher::Explicit {
            prog: exe,
            args: vec![
                fmt!("pty::tests::launcher_child_entry"),
                fmt!("--exact"),
                fmt!("--nocapture"),
                fmt!("--test-threads=1"),
            ],
            env:  vec![(fmt!("{}", LAUNCH_CHILD), fmt!("1"))],
        })
    }

    /// A registry whose launcher is this test binary.
    fn sessions() -> Outcome<PtySessions> {
        Ok(PtySessions::with_launcher(res!(test_launcher())))
    }

    /// A directory that certainly exists and that the tests never write to.
    fn root() -> String {
        fmt!("{}", env!("CARGO_MANIFEST_DIR"))
    }

    /// A fence that permits the crate's own directory and nothing else.
    fn fence_here() -> crate::wire::FenceSpec {
        crate::wire::FenceSpec {
            rw:   vec![root()],
            ro:   Vec::new(),
            deny: Vec::new(),
            net:  false,
        }
    }

    /// A workspace with something in it, and something outside it.
    ///
    /// Under the home cache and never `/tmp`: that is a tmpfs here, and filling it
    /// has taken this machine down before.
    ///
    /// # Arguments
    /// * `name` - A name unique to the calling test.
    fn fixture(name: &str) -> Outcome<PathBuf> {
        let home = match std::env::var("HOME") {
            Ok(h) => h,
            Err(e) => return Err(err!(e,
                "The pty tests need HOME to know where to put fixtures."; Test, Configuration)),
        };
        let base = PathBuf::from(home).join(".cache/daimond-hand-pty-tests").join(name);
        let _ = std::fs::remove_dir_all(&base);
        res!(std::fs::create_dir_all(base.join("ws")));
        res!(std::fs::create_dir_all(base.join("outside")));
        res!(std::fs::write(base.join("ws/inside.txt"), "INSIDE-THE-FENCE"));
        res!(std::fs::write(base.join("outside/other.txt"), "OUTSIDE-THE-FENCE"));
        Ok(res!(base.canonicalize()))
    }

    /// An `Open` request with the fields the tests vary and sensible rest.
    ///
    /// # Arguments
    /// * `id` - The session's identifier.
    /// * `argv` - The program and its arguments.
    fn open(id: &str, argv: &[&str]) -> Req {
        Req::Open {
            id:    fmt!("{}", id),
            argv:  argv.iter().map(|a| fmt!("{}", a)).collect(),
            cwd:   root(),
            env:   Vec::new(),
            size:  PtySize { cols: 80, rows: 24 },
            fence: fence_here(),
            toolkits: Vec::new(),
        }
    }

    /// The same, in a workspace of its own.
    ///
    /// # Arguments
    /// * `id` - The session's identifier.
    /// * `argv` - The program and its arguments.
    /// * `ws` - The workspace, which is the whole of the fence.
    fn open_in(id: &str, argv: &[&str], ws: &Path) -> Req {
        Req::Open {
            id:    fmt!("{}", id),
            argv:  argv.iter().map(|a| fmt!("{}", a)).collect(),
            cwd:   fmt!("{}", ws.display()),
            env:   Vec::new(),
            size:  PtySize { cols: 80, rows: 24 },
            fence: crate::wire::FenceSpec {
                rw:   vec![fmt!("{}", ws.display())],
                ro:   Vec::new(),
                deny: Vec::new(),
                net:  false,
            },
            toolkits: Vec::new(),
        }
    }

    /// Everything a session said, until it closed or the patience ran out.
    ///
    /// # Arguments
    /// * `rx` - Where the session's responses arrive.
    /// * `ms` - How long to wait in total.
    async fn collect(rx: &mut RespRx<Resp>, ms: u64) -> Vec<Resp> {
        let mut v = Vec::new();
        let deadline = tokio::time::Instant::now() + Duration::from_millis(ms);
        loop {
            let left = deadline.saturating_duration_since(tokio::time::Instant::now());
            if left.is_zero() {
                return v;
            }
            match timeout(left, rx.recv()).await {
                Ok(Some(r)) => {
                    let done = matches!(r, Resp::Closed { .. } | Resp::Refused { .. });
                    v.push(r);
                    if done {
                        return v;
                    }
                },
                Ok(None) => return v,
                Err(_)   => return v,
            }
        }
    }

    /// Every byte the terminal produced, in order, base64 decoded.
    ///
    /// # Arguments
    /// * `rs` - Everything the session said.
    fn bytes_of(rs: &[Resp]) -> Outcome<Vec<u8>> {
        let mut out = Vec::new();
        let mut want = 0u64;
        for r in rs {
            if let Resp::Output { seq, data, .. } = r {
                assert_eq!(*seq, want, "the output sequence skipped a number");
                want += 1;
                out.extend_from_slice(&res!(base64::decode(data)));
            }
        }
        Ok(out)
    }

    /// The same, as lossy text, for the tests that look for a word.
    ///
    /// # Arguments
    /// * `rs` - Everything the session said.
    fn text_of(rs: &[Resp]) -> Outcome<String> {
        Ok(String::from_utf8_lossy(&res!(bytes_of(rs))).to_string())
    }

    /// The closing message.
    ///
    /// # Arguments
    /// * `rs` - Everything the session said.
    fn closed(rs: &[Resp]) -> Option<(i32, bool)> {
        for r in rs {
            if let Resp::Closed { exit, killed, .. } = r {
                return Some((*exit, *killed));
            }
        }
        None
    }

    /// Types text at a session, as the page would.
    ///
    /// # Arguments
    /// * `s` - The registry.
    /// * `id` - The session.
    /// * `text` - What to type.
    fn typed(s: &PtySessions, id: &str, text: &str) -> Outcome<Reached> {
        s.input(id, &base64::encode(text.as_bytes()))
    }

    /// A shell session, opened and ready to be typed at.
    ///
    /// # Arguments
    /// * `s` - The registry.
    /// * `id` - The session's identifier.
    async fn shell(s: &PtySessions, id: &str) -> Outcome<RespRx<Resp>> {
        let (tx, rx) = tokio::sync::mpsc::channel::<Resp>(256);
        match res!(s.open(open(id, &["/bin/sh"]), tx).await) {
            Opening::Opened(_)  => Ok(rx),
            Opening::Refused    => Err(err!(
                "The shell session was refused."; Test, Unexpected)),
        }
    }

    // ── 1. A program that asks the kernel gets the right answer ─────

    /// The whole reason this module exists.
    ///
    /// `test -t 0` asks the kernel, not the hand, and the shell only answers yes
    /// when standard input really is a terminal.
    ///
    /// **The marker is composed by the shell and never typed.**  A terminal
    /// echoes what is typed at it, so a test looking for a word it had just sent
    /// finds its own keystrokes and passes with the program removed entirely.
    /// The first draft of this test did exactly that, and the broken-case run is
    /// what found it: with the controlling terminal taken away, it still passed.
    /// Expanding `$t` is the fix -- `REAL-TTY` exists only in what the program
    /// wrote.
    #[tokio::test]
    async fn test_the_program_really_has_a_terminal() -> Outcome<()> {
        let s = res!(sessions());
        let mut rx = res!(shell(&s, "t1").await);
        res!(typed(&s, "t1", "t=REAL; test -t 0 && echo \"$t-TTY\"\nexit\n"));
        let rs = collect(&mut rx, 10_000).await;
        let said = res!(text_of(&rs));
        assert!(said.contains("REAL-TTY"),
            "the program did not see a terminal on its standard input: {:?}", said);
        Ok(())
    }

    // ── 2. And it is the CONTROLLING terminal ───────────────────────

    /// The discriminating test, and the one that fails when `setsid` or
    /// `TIOCSCTTY` is missed.
    ///
    /// `/dev/tty` is the kernel's name for *this process's controlling terminal*.
    /// A process that has none gets `ENXIO` -- "No such device or address" -- and
    /// with the two calls in place the write comes back around the pty, because
    /// `/dev/tty` and the terminal the hand is holding are the same device.
    ///
    /// Proved against the broken case: with the `TIOCSCTTY` call taken out of
    /// [`adopt_terminal`], the same session answers `/bin/sh: 1: cannot create
    /// /dev/tty: No such device or address` and says `can't access tty; job
    /// control turned off` on the way in.  The marker is composed by the shell
    /// for the reason given on the test above.
    #[tokio::test]
    async fn test_the_terminal_is_the_controlling_terminal() -> Outcome<()> {
        let s = res!(sessions());
        let mut rx = res!(shell(&s, "t2").await);
        // Two names for the same terminal, and the session is granted both: the
        // magic one every program means by "my terminal", and the real one it has
        // in `/dev/pts`, which is what a program that reopens its own tty by name
        // asks for.
        res!(typed(&s, "t2",
            "t=CTTY; echo \"$t-OK\" > /dev/tty; echo \"$t-BY-NAME\" > $(tty)\nexit\n"));
        let rs = collect(&mut rx, 10_000).await;
        let said = res!(text_of(&rs));
        assert!(said.contains("CTTY-OK"),
            "the command has no controlling terminal: {:?}", said);
        assert!(said.contains("CTTY-BY-NAME"),
            "the session could not reopen its own terminal by name: {:?}", said);
        // The other half of the same fact, in the shell's own words: a shell
        // with no controlling terminal cannot do job control and says so.
        assert!(!said.contains("job control turned off"),
            "the shell could not take job control of the terminal: {:?}", said);
        Ok(())
    }

    // ── 3. Ctrl-C ───────────────────────────────────────────────────

    /// One byte, `0x03`, and the program stops.
    ///
    /// Nothing in the hand sends a signal here.  The byte goes into the terminal,
    /// the line discipline recognises it as the interrupt character, and the
    /// kernel signals the terminal's foreground process group -- which exists only
    /// because the launcher claimed the terminal.  A session without a controlling
    /// terminal swallows the byte and `sleep 30` runs to completion.
    #[tokio::test]
    async fn test_control_c_reaches_the_program() -> Outcome<()> {
        let s = res!(sessions());
        let (tx, mut rx) = tokio::sync::mpsc::channel::<Resp>(256);
        let opened = res!(s.open(open("t3", &["/bin/sleep", "30"]), tx).await);
        assert!(matches!(opened, Opening::Opened(_)), "the session did not open");

        // Long enough that `sleep` is certainly the program on the terminal.
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert_eq!(res!(s.input("t3", &base64::encode(&[0x03u8]))), Reached::Delivered);

        let rs = collect(&mut rx, 8_000).await;
        let (exit, killed) = match closed(&rs) {
            Some(c) => c,
            None    => return Err(err!(
                "Ctrl-C did not reach the program: it was still running after 8 seconds.";
                Test, Unexpected)),
        };
        assert_eq!(exit, -1, "a program ended by a signal has no exit code");
        assert!(killed, "the closing message did not say a signal ended it");
        Ok(())
    }

    // ── 4. Resize ───────────────────────────────────────────────────

    /// `stty size` asks the kernel how big the terminal is.
    ///
    /// Proved against the broken case: with [`set_winsize`] made a no-op the same
    /// session answers `24 80`, the size it opened with.
    #[tokio::test]
    async fn test_resize_is_seen_by_the_program() -> Outcome<()> {
        let s = res!(sessions());
        let mut rx = res!(shell(&s, "t4").await);
        assert_eq!(
            res!(s.resize("t4", PtySize { cols: 100, rows: 37 })),
            Reached::Delivered);
        res!(typed(&s, "t4", "stty size\nexit\n"));
        let rs = collect(&mut rx, 10_000).await;
        let said = res!(text_of(&rs));
        assert!(said.contains("37 100"),
            "the program was not told the terminal had been resized: {:?}", said);
        Ok(())
    }

    // ── 5. Bytes, not text ──────────────────────────────────────────

    /// Three bytes that are not UTF-8 arrive as themselves.
    ///
    /// Proved against the broken case: forwarding
    /// `String::from_utf8_lossy(&buf[..got])` instead of the bytes turns each of
    /// them into the three bytes of U+FFFD, and the assertion below fails.
    #[tokio::test]
    async fn test_output_is_byte_exact_through_base64() -> Outcome<()> {
        let s = res!(sessions());
        let (tx, mut rx) = tokio::sync::mpsc::channel::<Resp>(256);
        // Octal escapes, so the bytes are the program's and not the test's: 0xFF
        // and 0xFE are never valid UTF-8 anywhere, and 0x81 is a continuation
        // byte with nothing to continue.
        let opened = res!(s.open(
            open("t5", &["/usr/bin/printf", "A\\377\\376\\201Z"]), tx).await);
        assert!(matches!(opened, Opening::Opened(_)), "the session did not open");
        let rs = collect(&mut rx, 10_000).await;
        let raw = res!(bytes_of(&rs));
        let want = [b'A', 0xFF, 0xFE, 0x81, b'Z'];
        assert!(raw.windows(want.len()).any(|w| w == want),
            "the bytes did not survive the wire: {:?}", raw);
        Ok(())
    }

    // ── 6. Lifecycle ────────────────────────────────────────────────

    /// A session ends by itself, is reaped, and leaves the registry empty.
    #[tokio::test]
    async fn test_a_session_ends_cleanly_and_is_reaped() -> Outcome<()> {
        let s = res!(sessions());
        let (tx, mut rx) = tokio::sync::mpsc::channel::<Resp>(256);
        let opened = res!(s.open(open("t6", &["/bin/echo", "hello"]), tx).await);
        let pid = match opened {
            Opening::Opened(p)  => p,
            Opening::Refused    => return Err(err!(
                "The session was refused."; Test, Unexpected)),
        };
        assert_eq!(res!(s.pid_of("t6")), Some(pid));

        let rs = collect(&mut rx, 10_000).await;
        let said = res!(text_of(&rs));
        // A terminal turns the program's newline into a carriage return and a
        // line feed. Asserted rather than tolerated: it is what tells the page it
        // is talking to a terminal and not a pipe.
        assert!(said.contains("hello\r\n"), "the terminal said {:?}", said);

        let (exit, killed) = match closed(&rs) {
            Some(c) => c,
            None    => return Err(err!("No Closed was sent."; Test, Missing)),
        };
        assert_eq!(exit, 0);
        assert!(!killed, "nothing signalled this session");
        assert_eq!(res!(s.live_count()), 0, "the session was not forgotten");
        assert_eq!(res!(s.pid_of("t6")), None);
        assert_eq!(res!(s.input("t6", &base64::encode(b"x"))), Reached::Finished);
        Ok(())
    }

    /// `Bye` closes a session that would otherwise sit there for ever.
    #[tokio::test]
    async fn test_close_all_ends_a_waiting_session() -> Outcome<()> {
        let s = res!(sessions());
        let mut rx = res!(shell(&s, "t7").await);
        assert_eq!(res!(s.live_count()), 1);
        assert_eq!(res!(s.close_all()), 1);
        let rs = collect(&mut rx, 8_000).await;
        let (_, killed) = match closed(&rs) {
            Some(c) => c,
            None    => return Err(err!(
                "The session was still open after close_all."; Test, Unexpected)),
        };
        assert!(killed);
        assert_eq!(res!(s.live_count()), 0);
        Ok(())
    }

    /// Everything the session started goes with it.
    ///
    /// A terminal session is mostly other processes: the shell starts them, and a
    /// kill that reached only the shell would leave them holding the terminal
    /// open and running behind the page's back.  The group is read out of
    /// `/proc` rather than inferred, and it is asserted to be more than one
    /// process *before* the close, so that a test which killed nothing could not
    /// pass by finding nothing.
    #[tokio::test]
    async fn test_a_closed_session_leaves_no_orphans() -> Outcome<()> {
        let s = res!(sessions());
        let mut rx = res!(shell(&s, "t13").await);
        let sid = match res!(s.pid_of("t13")) {
            Some(p) => p,
            None    => return Err(err!("The session was not registered."; Test, Missing)),
        };

        res!(typed(&s, "t13", "sleep 60 &\n"));
        // Long enough for the shell to have started it.
        tokio::time::sleep(Duration::from_millis(800)).await;
        let before = session_members(sid);
        assert!(before >= 2,
            "the session had nothing to orphan: {} processes in session {}", before, sid);

        res!(s.close_all());
        let _ = collect(&mut rx, 8_000).await;

        // The kill is delivered to the group and the reaping is init's, so a
        // moment is allowed for the last of it.
        let mut left = session_members(sid);
        for _ in 0..50 {
            if left == 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
            left = session_members(sid);
        }
        assert_eq!(left, 0,
            "{} processes were left running in session {}", left, sid);
        Ok(())
    }

    /// How many processes are in a session, according to `/proc`.
    ///
    /// By session and not by process group, because that is where the defect
    /// was: with job control on -- which is what having a terminal *means* -- a
    /// shell puts each job in a group of its own, so the leader's group is not
    /// the session and counting it would have missed the orphan.
    ///
    /// # Arguments
    /// * `sid` - The session to count.
    fn session_members(sid: u32) -> usize {
        let dir = match std::fs::read_dir("/proc") {
            Ok(d)  => d,
            Err(_) => return 0,
        };
        let mut n = 0;
        for entry in dir.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if !name.chars().all(|c| c.is_ascii_digit()) {
                continue;
            }
            let stat = match std::fs::read_to_string(entry.path().join("stat")) {
                Ok(s)  => s,
                Err(_) => continue, // It ended while we were looking at it.
            };
            let tail = match stat.rsplit_once(')') {
                Some((_, t)) => t,
                None         => continue,
            };
            // After the name come the state and then the parent, so the group is
            // the third field of what is left.
            if let Some(field) = tail.split_whitespace().nth(3) {
                if field.parse::<u32>() == Ok(sid) {
                    n += 1;
                }
            }
        }
        n
    }

    // ── 7. The fence, inside a terminal ─────────────────────────────

    /// The one that matters most: a terminal is not a way around the compartment.
    ///
    /// Both halves are asserted in one test on purpose.  A command that failed for
    /// any reason would satisfy the first half alone, so the same shell in the
    /// same session reads a file inside the fence and a file outside it, and the
    /// difference between the two answers is the fence and nothing else.
    #[tokio::test]
    async fn test_the_fence_holds_inside_a_terminal_session() -> Outcome<()> {
        let base = res!(fixture("fence"));
        let s = res!(sessions());
        let (tx, mut rx) = tokio::sync::mpsc::channel::<Resp>(256);
        let opened = res!(s.open(
            open_in("t8", &["/bin/sh"], &base.join("ws")), tx).await);
        assert!(matches!(opened, Opening::Opened(_)), "the session did not open");

        res!(typed(&s, "t8", &fmt!(
            "cat {}\ncat {}\nexit\n",
            base.join("ws/inside.txt").display(),
            base.join("outside/other.txt").display())));

        let rs = collect(&mut rx, 10_000).await;
        let said = res!(text_of(&rs));
        assert!(said.contains("INSIDE-THE-FENCE"),
            "the fence refused a file it granted: {:?}", said);
        assert!(!said.contains("OUTSIDE-THE-FENCE"),
            "a terminal session read a file outside its fence: {:?}", said);
        Ok(())
    }

    // ── 8. Refusals ─────────────────────────────────────────────────

    /// Two sessions cannot share an identifier.
    #[tokio::test]
    async fn test_a_second_session_cannot_take_a_live_identifier() -> Outcome<()> {
        let s = res!(sessions());
        let mut rx = res!(shell(&s, "t9").await);
        let (tx2, mut rx2) = tokio::sync::mpsc::channel::<Resp>(16);
        let again = res!(s.open(open("t9", &["/bin/sh"]), tx2).await);
        assert_eq!(again, Opening::Refused);
        match rx2.recv().await {
            Some(Resp::Refused { reason, .. }) => assert!(reason.starts_with("Refused: ")),
            other => return Err(err!(
                "Expected a refusal, got {:?}.", other; Test, Mismatch)),
        }
        res!(s.close_all());
        let _ = collect(&mut rx, 8_000).await;
        Ok(())
    }

    /// The caller does not get to say what the terminal is, and the hand does.
    #[tokio::test]
    async fn test_term_is_the_hands_to_set() -> Outcome<()> {
        let s = res!(sessions());
        let (tx, mut rx) = tokio::sync::mpsc::channel::<Resp>(16);
        let req = match open("t10", &["/bin/sh"]) {
            Req::Open { id, argv, cwd, size, fence, .. } => Req::Open {
                id, argv, cwd, size, fence,
                env: vec![(fmt!("TERM"), fmt!("nonsense-9000"))],
                toolkits: Vec::new(),
            },
            other => other,
        };
        assert_eq!(res!(s.open(req, tx).await), Opening::Refused);
        match rx.recv().await {
            Some(Resp::Refused { reason, .. }) => assert!(reason.contains("TERM")),
            other => return Err(err!(
                "Expected a refusal, got {:?}.", other; Test, Mismatch)),
        }

        // And the value the hand sets is the one the program sees.
        let (tx2, mut rx2) = tokio::sync::mpsc::channel::<Resp>(256);
        let opened = res!(s.open(open("t11", &["/bin/sh"]), tx2).await);
        assert!(matches!(opened, Opening::Opened(_)), "the session did not open");
        res!(typed(&s, "t11", "echo TERM-IS-$TERM\nexit\n"));
        let rs = collect(&mut rx2, 10_000).await;
        let said = res!(text_of(&rs));
        assert!(said.contains(&fmt!("TERM-IS-{}", TERM)),
            "the program was told a different terminal: {:?}", said);
        Ok(())
    }

    /// Typing more at once than a terminal takes is an error with a sentence.
    #[tokio::test]
    async fn test_an_oversized_paste_is_refused() -> Outcome<()> {
        let s = res!(sessions());
        let mut rx = res!(shell(&s, "t12").await);
        let big = base64::encode(&vec![b'x'; INPUT_MAX + 1]);
        assert!(s.input("t12", &big).is_err(), "an oversized paste was accepted");
        // And a non-base64 payload is refused rather than guessed at.
        assert!(s.input("t12", "not base64 at all").is_err());
        res!(s.close_all());
        let _ = collect(&mut rx, 8_000).await;
        Ok(())
    }

    /// Everything that reaches a session that has ended answers `Finished`.
    #[tokio::test]
    async fn test_a_closed_session_answers_finished() -> Outcome<()> {
        let s = res!(sessions());
        assert_eq!(res!(s.input("nobody", &base64::encode(b"x"))), Reached::Finished);
        assert_eq!(res!(s.resize("nobody", PtySize { cols: 80, rows: 24 })), Reached::Finished);
        assert_eq!(res!(s.close("nobody")), Reached::Finished);
        assert_eq!(res!(s.close_all()), 0);
        Ok(())
    }
}
