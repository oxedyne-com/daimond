//! What the page and the hand say to each other, and how it is framed.
//!
//! **Designed for remote from the first line.**  Loopback is the degenerate
//! case of remote, and a protocol built for localhost only is a rewrite waiting
//! to happen.  So the *messages* here are transport-neutral JSON, and the
//! framing is a separate, swappable concern:
//!
//! * **Native messaging** (the `Machine` tier): a 4-byte native-endian length
//!   prefix followed by UTF-8 JSON, which is Chrome's format and not
//!   negotiable.  Chrome caps a host→extension message at 1 MB.
//! * **WebSocket** (the `Cloud` tier): the identical JSON as one text frame,
//!   so a phone can drive a desktop with the same hand binary.
//!
//! The types below are the contract.  Everything else in the crate is written
//! against them.

use crate::PROTO;

use oxedyne_fe2o3_core::prelude::*;

// ┌───────────────────────────────────────────────────────────────┐
// │ Limits                                                         │
// └───────────────────────────────────────────────────────────────┘

/// The largest encoded frame the hand will ever emit.
///
/// Chrome caps a host→extension message at 1 MB and drops the connection
/// without ceremony when one exceeds it.  JSON escaping can inflate a payload
/// severalfold in the worst case (a control byte costs six), so the budget for
/// the *data* inside a chunk is set well below the cap rather than at it.
pub const FRAME_MAX: usize = 1_000_000;

/// The largest run of output bytes carried in a single [`Resp::Chunk`].
///
/// Chosen so that even output escaping at the worst rate JSON can manage still
/// lands inside [`FRAME_MAX`] with room for the envelope.
pub const CHUNK_MAX: usize = 128 * 1024;

/// The largest whole number the wire carries, in either direction.
///
/// `Number.MAX_SAFE_INTEGER`.  One end of this conversation is JavaScript, where
/// a number is a `f64`: past 2^53 the integers stop being consecutive, so
/// `JSON.parse` reads `18446744073709551615` back as `18446744073709552000` and
/// reads 2^53 and 2^53+1 as the same value.  A `u64` field is therefore only a
/// `u64` up to here, and the contract says so rather than leaving each message
/// to find out.
///
/// It binds all five numbers that could reach it: [`Req::Exec`]'s `timeout_ms`,
/// [`Resp::Chunk`]'s and [`Resp::Output`]'s `seq`, and [`Resp::Ended`]'s
/// `out_bytes` and `err_bytes`.  The rest of the wire's numbers are `u32`, `i32`
/// or `u16`, all of which cross unharmed.
///
/// **Exceeding it is refused at both ends, never clamped** -- see [`crate::codec`]
/// for why a clamp is the worse failure.
pub const SAFE_INT_MAX: u64 = (1u64 << 53) - 1;

// ┌───────────────────────────────────────────────────────────────┐
// │ Requests: the page asks                                        │
// └───────────────────────────────────────────────────────────────┘

/// Which of a command's streams the caller wants back.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Capture {
    /// Both stdout and stderr, tagged by [`Stream`].
    Both,
    /// Standard output only; standard error is discarded.
    Out,
    /// Standard error only; standard output is discarded.
    Err,
    /// Neither: the exit code is the whole of the answer.
    None,
}

/// A signal the page may send to a running command.
///
/// Three, not the whole POSIX set: an agent needs to ask a process to stop, to
/// insist, or to interrupt it as a terminal would.  The rest are a way to reach
/// behaviour nobody asked for.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Sig {
    /// Ask it to stop (`SIGTERM`).
    Term,
    /// Insist (`SIGKILL`).
    Kill,
    /// Interrupt, as `Ctrl-C` would (`SIGINT`).
    Int,
}

/// What a command may touch, in the shape `diamond_bounds` already produces.
///
/// The app's `Bound::OnlyUnder` list, its `NoWrite` prefixes and its deny of
/// `.daimond/` map onto these three fields exactly.  That is not a coincidence
/// and it is the point: the compartment is **not a new concept**, it is the
/// same rule enforced one layer down, so the guarantee the guide already
/// describes survives the move from a structural boundary to a kernel one.
///
/// Paths are absolute and already resolved by the caller; the hand does not
/// interpret workspace-relative spellings.
#[derive(Clone, Debug, Eq, PartialEq, Default)]
pub struct FenceSpec {
    /// Roots the command may read and write.
    pub rw:   Vec<String>,
    /// Roots the command may read and not write.
    pub ro:   Vec<String>,
    /// Subtrees denied outright, even where they sit inside `rw` or `ro`.
    pub deny: Vec<String>,
    /// Whether the command may reach the network at all.
    ///
    /// False is the interesting case: it is what makes a fenced build unable to
    /// post the source tree somewhere, whatever it was told to do.
    pub net:  bool,
}

/// How big the terminal is, in character cells.
///
/// A program asks the kernel this, not the page, so it has to be told at the pty
/// and told again whenever the window changes -- a `less` that thinks it has 24
/// rows on an 80-row screen is the visible symptom of forgetting the second half.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PtySize {
    /// Columns.
    pub cols: u16,
    /// Rows.
    pub rows: u16,
}

/// Which of a verifier's declared breaks a [`Req::Verify`] should run.
///
/// **Not a free string, and that is the point.**  A break is a mode the verifier
/// itself implements and names in its own source; a caller who could invent one
/// would run the file unchanged and be handed a pass that measured nothing.  So
/// the only shapes here are "every break the file declares", "this one, which
/// the file must declare", and "none, and say so".
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Breaks {
    /// Every break the verifier declares, one run each.
    All,
    /// One named break, which the verifier must declare or the request is refused.
    One(String),
    /// None.  The clean run alone, whose result is UNPROVEN and says so in words.
    None,
}

impl Breaks {
    /// The word this travels under.
    pub fn word(&self) -> &'static str {
        match self {
            Self::All	=> "all",
            Self::One(_)	=> "one",
            Self::None	=> "none",
        }
    }
}

// ── Why a pty is a separate pair of messages ────────────────────────
//
// [`Req::Exec`] is non-interactive by design: stdin is a string decided before the
// command starts, output is captured, and nothing can answer a question. That covers
// nearly everything an agent does, and it is deliberately the simpler shape.
//
// A pty is the other thing. `sudo` wants a password, `ssh` wants a passphrase, `git`
// wants an editor, `vim` wants the whole screen, and a REPL wants a conversation.
// None of them work down a pipe, because they ask the kernel whether they are talking
// to a terminal and behave differently when they are not. So the hand allocates a real
// terminal, gives the command the far end of it as its controlling terminal, and the
// bytes flow both ways for as long as the program lives.
//
// It is kept as its own messages rather than a flag on `Exec` because almost nothing
// is shared: there are no separate out and err streams (a terminal merges them by
// construction), input arrives repeatedly rather than once, the size matters and can
// change, and the interesting end is a session rather than a result.
//
// **Data is base64 in both directions**, unlike `Chunk`, which carries text. A pty
// carries arbitrary bytes -- a `cat` of a binary file, a half-written UTF-8 character
// at the edge of a read, a control sequence -- and a terminal that mangles one byte
// draws the rest of the screen wrong. Text with a lossy conversion would be smaller
// and would silently corrupt exactly the case a terminal exists to handle.

/// A message from the page to the hand.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Req {
    /// The opening exchange, which settles whether the two ends agree.
    Hello {
        /// The protocol version the page speaks.
        proto:  u32,
        /// Which build of the app is asking, for the journal.
        client: String,
    },
    /// Run a command.
    ///
    /// **`argv`, never a shell string.**  Handing a string to `sh -c` means
    /// defending against the shell itself -- `;`, `$(…)`, backticks, `|`,
    /// `eval`, `base64 -d | sh`, `find -exec`, `tar --to-command` -- and a
    /// fence made of string matching is not a fence.  Passing the argument
    /// vector removes the entire injection surface rather than guarding it.
    Exec {
        /// Caller-chosen identifier, echoed on every response about this run.
        id:         String,
        /// The program and its arguments.  Never a shell string.
        argv:       Vec<String>,
        /// Absolute working directory.  Must lie inside the fence.
        cwd:        String,
        /// The environment the command runs with, as explicit pairs.
        ///
        /// An allow-list rather than an inheritance: the hand's own environment
        /// holds whatever launched the browser, and a command that inherits it
        /// inherits credentials nobody meant to lend it.
        env:        Vec<(String, String)>,
        /// Text written to the command's standard input, then closed.
        ///
        /// This is what replaces a pipeline: redirection becomes a field rather
        /// than a character the shell would have interpreted.
        stdin:      Option<String>,
        /// Hard wall-clock limit.  On expiry the child is killed.
        ///
        /// At most [`SAFE_INT_MAX`], which is 285,000 years; a larger one is
        /// refused rather than trimmed, because a limit the two ends disagree
        /// about is worse than no limit.
        timeout_ms: u64,
        /// Which streams to send back.
        capture:    Capture,
        /// What the command may touch.
        fence:      FenceSpec,
        /// The toolchains the USER granted this turn, by name (`rust`, `node`,
        /// `python`, `go`).
        ///
        /// The hand needs these to clamp the fence, and it needs them stated
        /// rather than inferred.  A toolchain does not live in the workspace, so
        /// a fence naming `~/.cargo/registry` cannot be checked against the
        /// granted root -- and the obvious repair, allowing every toolchain
        /// folder unconditionally, is what let a fence name `~/.local/bin`
        /// writable when no toolkit had been granted at all.  `~/.local/bin` is
        /// first on `PATH`; a shim written there is unfenced execution as the
        /// user on the next shell command.
        ///
        /// **Never derived from `argv`.**  The whole arrangement rests on the
        /// fence not being one the model can widen by asking for a program, and
        /// a hand that read the toolchain out of the command would hand that
        /// back.  A name this build does not know grants nothing, and an absent
        /// field is no grant -- both fail closed.
        toolkits:   Vec<String>,
    },
    /// Run one named verifier from the tracked tree, clean and under its breaks.
    ///
    /// **A NAME, not a path and not a command line.**  `name` is looked up in the
    /// granted root's `dev/` directory and must match a `verify_<name>.mjs` that
    /// is actually there; what reaches the argument vector is the directory
    /// entry's own file name, never the caller's string.  `breaks` is checked
    /// against the declarations in that file's own source.  So there is no
    /// element of this request that a page can turn into a program, an argument
    /// or a path -- which is why it is a request of its own rather than an
    /// [`Req::Exec`] with a convention attached to it.
    ///
    /// **It runs OUTSIDE the command fence, deliberately.**  A fenced command
    /// cannot open the display server's socket or listen on a port, so every
    /// verifier that drives a real browser dies under it -- and those are the
    /// ones a release actually rests on.  The justification is provenance and
    /// not confinement: a verifier is tracked repository code in the same trust
    /// class as `cargo test`, and the model supplies a selector rather than a
    /// command.  The journal records each run with `fence:none` in its
    /// mechanisms, so the claim is checkable rather than merely written down.
    Verify {
        /// Caller-chosen identifier, echoed on every response about this run.
        id:         String,
        /// The verifier's short name: `graph` for `dev/verify_graph.mjs`.
        name:       String,
        /// Which of its declared breaks to run beside the clean pass.
        breaks:     Breaks,
        /// The WHOLE sequence's wall-clock budget, not one run's.
        ///
        /// The page arms one timer from this, so it has to cover every run the
        /// sequence makes.  A break the budget does not reach is reported as
        /// never having run, which is a worse result than a slow one and is
        /// meant to be.
        timeout_ms: u64,
    },
    /// Send a signal to a running command.
    Signal {
        /// The identifier given at [`Req::Exec`].
        id:  String,
        /// Which signal.
        sig: Sig,
    },
    /// Open a terminal and run a command attached to it.
    ///
    /// Everything `Exec` says about `argv`, `env` and the fence holds here too; only
    /// the shape of the conversation differs.
    Open {
        /// Caller-chosen identifier, echoed on every response about this session.
        id:      String,
        /// The program and its arguments. Never a shell string -- though a shell is a
        /// perfectly ordinary thing to put in `argv[0]` here, and usually the point.
        argv:    Vec<String>,
        /// Absolute working directory. Must lie inside the fence.
        cwd:     String,
        /// The environment, as explicit pairs. `TERM` is the hand's to set: a program
        /// asks it what the terminal can do, and a caller who could name it could
        /// promise capabilities the page cannot draw.
        env:     Vec<(String, String)>,
        /// How big the terminal is when it opens.
        size:    PtySize,
        /// What the session may touch.
        fence:   FenceSpec,
        /// The toolchains the user granted, exactly as [`Req::Exec`] carries them
        /// and for exactly the same reason: a terminal is a command with a
        /// screen, and it is clamped by the same rule.
        toolkits: Vec<String>,
    },
    /// Keystrokes for a terminal, base64 of the raw bytes.
    ///
    /// Raw, and not a line: a terminal is a byte stream, and `Ctrl-C`, an arrow key and
    /// a bracketed paste are all just bytes the program is entitled to see as they were
    /// typed.
    Input {
        /// The session's identifier.
        id:   String,
        /// Base64 of the bytes typed.
        data: String,
    },
    /// The window changed size; tell the kernel, which tells the program.
    Resize {
        /// The session's identifier.
        id:   String,
        /// The new size.
        size: PtySize,
    },
    /// The page is going away; stop everything and exit.
    Bye,
}

// ┌───────────────────────────────────────────────────────────────┐
// │ Responses: the hand answers                                    │
// └───────────────────────────────────────────────────────────────┘

/// Which of a command's output streams a chunk came from.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Stream {
    /// Standard output.
    Out,
    /// Standard error.
    Err,
}

/// A message from the hand to the page.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Resp {
    /// The answering half of the opening exchange.
    Hello {
        /// The protocol version this hand speaks.
        proto:   u32,
        /// The host's name, for the device roster.
        host:    String,
        /// The build.
        version: String,
        /// Which operating system, in the wire's own vocabulary.
        os:      String,
        /// What this build can actually do.
        ///
        /// A list rather than a version number, because the fence lands on one
        /// platform before another and the page must be able to say *which*
        /// guarantee it is offering the user on this machine.
        caps:    Vec<String>,
    },
    /// The command started.
    Started {
        /// The caller's identifier.
        id:  String,
        /// The child's process id, so the journal names something real.
        pid: u32,
    },
    /// A run of output.
    Chunk {
        /// The caller's identifier.
        id:     String,
        /// Which stream it came from.
        stream: Stream,
        /// Monotonic per-stream sequence, so a dropped frame is detectable.
        ///
        /// At most [`SAFE_INT_MAX`]: the page detects a gap by comparing this
        /// for equality, and two sequence numbers that read back as one number
        /// break exactly the check they are here for.
        seq:    u64,
        /// The bytes, as text.  Invalid UTF-8 is replaced, not rejected.
        data:   String,
    },
    /// The command finished, one way or another.
    Ended {
        /// The caller's identifier.
        id:        String,
        /// The exit status, or -1 where there was none.
        exit:      i32,
        /// Whether the hard timeout killed it.
        timed_out: bool,
        /// Whether a [`Req::Signal`] killed it.
        killed:    bool,
        /// How many bytes of standard output were produced.
        ///
        /// The *true* total, not the total forwarded, so a reader comparing it
        /// against what arrived can tell that a tail was lost.  At most
        /// [`SAFE_INT_MAX`], since a count the page rounds down is a count that
        /// says nothing went missing.
        out_bytes: u64,
        /// How many bytes of standard error were produced, on the same terms.
        err_bytes: u64,
    },
    /// The hand declined, and this is the sentence the model reads.
    ///
    /// A refusal is not an error.  It says what was refused and why, in the
    /// same voice the file tools already use, so a model can recover instead of
    /// retrying the same call.
    Refused {
        /// The caller's identifier.
        id:     String,
        /// The whole sentence.
        reason: String,
    },
    /// A terminal is open and the command is attached to it.
    Opened {
        /// The caller's identifier.
        id:  String,
        /// The child's process id.
        pid: u32,
    },
    /// Bytes from the terminal, base64 of exactly what it produced.
    ///
    /// One stream, not two: a terminal merges them by construction, and a program
    /// writing a prompt to stderr expects it to land in the same place as the rest.
    Output {
        /// The session's identifier.
        id:   String,
        /// Monotonic sequence, so a dropped frame is detectable.  At most
        /// [`SAFE_INT_MAX`], for the reason [`Resp::Chunk`] gives.
        seq:  u64,
        /// Base64 of the bytes.
        data: String,
    },
    /// The terminal closed and the command is gone.
    Closed {
        /// The session's identifier.
        id:     String,
        /// The exit status, or -1 where there was none.
        exit:   i32,
        /// Whether a signal ended it rather than the program itself.
        killed: bool,
    },
    /// Something went wrong that is nobody's fault in particular.
    Error {
        /// The run it concerns, where there is one.
        id:      Option<String>,
        /// What happened.
        message: String,
    },
}

/// Whether a page speaking `proto` can talk to this hand.
///
/// # Arguments
/// * `proto` - The version the page announced.
pub fn proto_ok(proto: u32) -> bool {
    proto == PROTO
}

/// The sentence a version mismatch produces, which names both ends.
///
/// # Arguments
/// * `proto` - The version the page announced.
pub fn proto_refusal(proto: u32) -> String {
    fmt!(
        "This hand speaks protocol {} and the page speaks {}. Update whichever \
        is older; they cannot agree on what a command is until you do.",
        PROTO, proto)
}
