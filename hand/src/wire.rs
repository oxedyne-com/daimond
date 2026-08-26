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

// ── What a run leaves behind, and how it is reached afterwards ──────
//
// A command may outlive itself.  `bash dev/world.sh 3 --up` starts a dev server
// and a mock provider in the background and exits; the direct child is reaped,
// its process GROUP is not empty, and the two servers go on holding their ports.
// That is a legitimate thing to want -- a browser verifier needs a server to
// drive -- so the answer is not to refuse it.
//
// The answer that was there was worse than none.  Nothing recorded the group, so
// nothing could reach it; the fence scopes signals to the Landlock domain that
// sent them, so a LATER command cannot signal an earlier one's leftovers and gets
// "Operation not permitted"; `/proc` is outside the fence, so the pid cannot even
// be found; and `dev/world.sh --down` swallowed the failed kill with `2>/dev/null`,
// reported success and deleted its own pid files.  Two servers were left on 8780
// and 9102 with no route to them and a person had to clear them from outside.
//
// So the hand keeps what it started.  [`Req::Runs`] asks what is still going and
// [`Req::Signal`] stops one of them BY THE IDENTIFIER THE RUN WAS GIVEN -- never
// a pid, never a name, never a pattern, because a hand that took any of those
// would be `pkill` with extra steps.  Only a group this hand's own launcher
// created can be named at all, which is the whole of the guard.
//
// There is deliberately no "stopped" answer.  A signal that could not be
// delivered comes back as [`Resp::Error`]; a signal that could is confirmed by
// asking again, because the listing is a measurement and an acknowledgement is a
// claim.  Reporting success on a kill that failed is the defect this exists to
// close, and the cheapest way not to write it again is to have nowhere to write
// it.

/// Where a run this hand started has got to.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RunState {
    Running,	// the command itself has not finished
    Standing,	// the command has finished and its process group has not emptied
}

impl RunState {
    /// The word this travels under.
    pub fn word(&self) -> &'static str {
        match self {
            Self::Running	=> "running",
            Self::Standing	=> "standing",
        }
    }
}

/// One command this hand started, as [`Resp::Runs`] reports it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Run {
    pub id:    String,	// the identifier the run was given, and the way to signal it
    pub pid:   u32,		// the process, which is also its group
    pub what:  String,	// the command line, cut to [`RUN_WHAT_MAX`]
    pub state: RunState,
    pub secs:  u32,		// how long it has been in that state
}

/// The longest command line a listing carries for one run.
///
/// Enough to recognise a command by and not enough for a listing of many runs to
/// approach [`FRAME_MAX`].  A cut is marked, because a command line a reader
/// takes for whole is one they will try to run again.
pub const RUN_WHAT_MAX: usize = 160;

/// The most runs one [`Resp::Runs`] carries.
///
/// A listing is bounded so that a page asking what is running cannot be answered
/// with a frame it must then refuse.  What did not fit is COUNTED rather than
/// dropped -- see [`Resp::Runs`]'s `more`.
pub const RUNS_MAX: usize = 200;

// ── Why a file edit is a message and not a command ──────────────────
//
// Everything below this line is the answer to one measured failure. A daimon asked to
// restore one localisation key in eight files had no way to change a file on the machine
// except by running a program that changes files, so it ran `sed -i`; call 20 put a French
// apostrophe into a single-quoted JavaScript string, and 71 of the 91 remaining calls went
// on repairing that one line, every attempt another `sed` whose own quoting had to survive
// the argument vector and the JavaScript string at once.
//
// The missing thing was never a permission. `Req::Exec` already carries the fence, the
// working directory and the whole compartment; what it does not carry is a VERB that says
// "replace this text with that text", so the intent had to be spelled as a program, and a
// program that edits text is a small language with its own escaping.
//
// So this is a request rather than a convention on top of `Exec`, for the same reason
// `Req::Verify` is: there is no element of it a page can turn into a program. The op names
// what to do, the paths are absolute and vetted, and the strings are DATA at both ends --
// nothing here is ever parsed as syntax by anything.
//
// **It is fenced exactly as a command is, by the same kernel, from the same plan.** The
// hand does not touch the file: it spawns the same launcher a command is spawned through,
// which applies the same Landlock ruleset and the same system-call filter and only then
// opens anything. A path the fence does not reach fails with the kernel's own refusal, not
// with a check written here -- which is the whole reason the work happens in a child at all
// rather than in the hand, whose own process is deliberately unfenced.

/// The largest text one [`Resp::Filed`] carries back.
///
/// A read is paged by the caller, so this is the backstop rather than the budget: a read stops
/// on the last whole line that fits and SAYS how many lines went, and a single line longer than
/// this is cut with the count of what was left on it, because a frame that will not fit is
/// dropped and silence is the one answer that lies.
pub const FILE_TEXT_MAX: usize = 512 * 1024;

/// The prefix a walk's glob is written against, and why one is needed.
///
/// **A glob is written by a MODEL, in the paths a model sees.**  `www/i18n/en.js` is the
/// spelling in the workspace; on this machine the same file is
/// `/home/…/granted/repo/www/i18n/en.js`, and a glob matched against the second excludes every
/// file there is.  Measured on the door's first live run, 2026-08-25: three searches in a row
/// answered *"No matches"* with *"804 file(s) the glob excluded"* beside them, which is the
/// note doing its job and the filter doing the opposite of its job.
///
/// So the page sends the prefix it would strip off a result, and the hand matches the glob
/// against what is left.  A path that is somehow not under it is matched whole, because a file
/// silently excluded is the failure this exists to end.
pub const GLOB_BASE_DOC: () = ();

/// The largest answer a [`FileOp::Search`] builds before it stops adding files.
///
/// A search answers with the LINES its pattern matched on, so its size is set by how much
/// matched rather than by how big the files are.  Below [`FILE_TEXT_MAX`] on purpose: an answer
/// at the frame's own ceiling leaves nothing for the envelope.  What did not fit is COUNTED and
/// named, never dropped in silence -- a search that stopped early and did not say so is a search
/// that has established nothing.
///
/// **It answered with whole file texts until 2026-08-25**, which made this a ceiling on the SIZE
/// OF A FILE rather than on the size of an answer: `src/tools.rs`, 1,211,990 bytes, was passed
/// over with the answer still empty, and no `glob` or `path` a caller could write made one file
/// smaller.  That is `dev/BLOCKERS.md` B17.
pub const SEARCH_ANSWER_MAX: usize = 384 * 1024;

/// How many neighbours of a matching line travel with it.
///
/// The page's own ceiling on `before` and `after` (`SEARCH_CONTEXT_MAX` in `src/tools.rs`), so
/// every line the page could be asked to print is in the answer and none of the ones it could
/// not are.  The two numbers are the same number and a search that sent fewer would silently
/// print less context than it was asked for.
pub const SEARCH_CONTEXT_LINES: usize = 20;

/// What a [`Req::File`] is asking to be done to one file.
///
/// The shapes are the file tools' own, deliberately: the app already offers a page a read
/// by line range, an overwrite, an exact-substring replacement, a rename and a listing, and
/// a second editing model reaching the machine would be worse than one that only half
/// works.  Nothing is added here that browser storage does not already do.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum FileOp {
    /// Text from `path`, from the 1-based line `offset`, at most `limit` lines.
    Read {
        path:   String,
        offset: u32,
        limit:  u32,
    },
    /// Replace the whole of `path` with `content`, creating it and its parents.
    Write {
        path:    String,
        content: String,
    },
    /// Replace `old` with `new` in `path`, exactly once.
    ///
    /// The count is the answer, not a detail: an `old` occurring twice or not at all is
    /// REFUSED with the number it found, so a caller is never left guessing which of six
    /// edits landed.
    Edit {
        path: String,
        old:  String,
        new:  String,
    },
    /// Rename `path` to `to`, which must not already exist.
    Move {
        path: String,
        to:   String,
    },
    /// What is in the directory `path`.
    List {
        path: String,
    },
    /// Create the directory `path` and any parent it needs.
    MkDir {
        path: String,
    },
    /// Walk `paths` and return the text of every file the pattern matches somewhere in.
    ///
    /// **A verb of its own, and not a `List` the page then walks.**  A search is the one file
    /// operation whose cost is in the WALK rather than in the file, and a page that listed a
    /// directory, then listed its children, then read each candidate would pay a round trip per
    /// entry for a question whose answer is usually "no".  Measured 2026-08-25: with the editing
    /// door open, 33 of a daimon's 45 calls were `run grep -n` for a line number.
    ///
    /// **The hand's match is a FILTER and the page's is the answer.**  Both ends compile the
    /// same `fe2o3_text` regex from the same source, so what comes back is every file the page
    /// would have found something in -- and the page then runs its own scan over those files
    /// unchanged, which is what keeps the context lines, the paging and the report one
    /// implementation rather than two that agree until they do not.
    Search {
        paths:  Vec<String>,	// absolute start directories, walked in this order
        query:  String,		// the regex source, already quoted where the caller asked for a literal
        ci:     bool,		// fold case
        glob:   String,		// only consider paths matching this; empty for all
        base:   String,		// the prefix the glob is written against; see below
        skip:   Vec<String>,	// directory NAMES to pass over, decided by the page
        budget: u32,		// entries the walk may look at before it stops and says where
        cap:    u32,		// the largest file, in bytes, worth opening
    },
    /// Walk `paths` and return every path matching `pattern`, reading none of them.
    Glob {
        paths:   Vec<String>,
        pattern: String,
        base:    String,
        skip:    Vec<String>,
        budget:  u32,
    },
}

impl FileOp {
    /// The word this travels under.
    pub fn word(&self) -> &'static str {
        match self {
            Self::Read  { .. }	=> "read",
            Self::Write { .. }	=> "write",
            Self::Edit  { .. }	=> "edit",
            Self::Move  { .. }	=> "move",
            Self::List  { .. }	=> "list",
            Self::MkDir { .. }	=> "mkdir",
            Self::Search { .. }	=> "search",
            Self::Glob { .. }	=> "glob",
        }
    }

    /// The path the op is about, which is the one a refusal must name.
    ///
    /// A walk names several, and answers the FIRST -- the place the caller asked about, which is
    /// where a refusal is most useful and what the journal should record it under.
    pub fn path(&self) -> &str {
        match self {
            Self::Read  { path, .. } | Self::Write { path, .. } | Self::Edit { path, .. }
            | Self::Move { path, .. } | Self::List { path } | Self::MkDir { path } => path,
            Self::Search { paths, .. } | Self::Glob { paths, .. } =>
                paths.first().map(|s| s.as_str()).unwrap_or(""),
        }
    }

    /// Every path the op names, which is what a caller vetting them has to see.
    pub fn paths(&self) -> Vec<&str> {
        match self {
            Self::Move { path, to } => vec![path.as_str(), to.as_str()],
            Self::Search { paths, .. } | Self::Glob { paths, .. } =>
                paths.iter().map(|s| s.as_str()).collect(),
            other => vec![other.path()],
        }
    }

    /// Does the op change anything on disk?
    pub fn writes(&self) -> bool {
        !matches!(self, Self::Read { .. } | Self::List { .. }
            | Self::Search { .. } | Self::Glob { .. })
    }
}

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
    /// Change one file on the machine, behind the same fence a command runs behind.
    ///
    /// **No program, no argument vector, no shell, and nothing to escape.**  That is the
    /// whole of why it exists; the section above this enum has the measurement.
    File {
        /// Caller-chosen identifier, echoed on the response.
        id:       String,
        /// What to do, and to what.
        op:       FileOp,
        /// Absolute working directory, which must lie inside the fence.
        ///
        /// Carried for the same reason [`Req::Exec`] carries one -- it is the place the op
        /// happens in, and the hand vets it against the fence before anything is opened --
        /// though every path in an op is absolute, so nothing is resolved against it.
        cwd:      String,
        /// What the op may touch.  The same field, the same shape and the same clamp as
        /// [`Req::Exec`]'s.
        fence:    FenceSpec,
        /// The toolchains the user granted this turn, carried for the same reason
        /// [`Req::Exec`] carries them: the hand clamps the fence against them and will not
        /// take a root on the page's word alone.
        toolkits: Vec<String>,
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
    /// What is this hand still running, including what a finished run left
    /// standing.
    ///
    /// Takes nothing, on purpose.  A field would be a filter and a filter is a
    /// selector, and the one selector this message must not grow is one that
    /// names a process the hand did not start.
    Runs,
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
    /// One [`Req::File`] finished, and this is what to tell the model.
    ///
    /// One blob and not a stream, because a file op has one answer.  `ok` false is a
    /// refusal in the same voice as [`Resp::Refused`] -- the string was not found, it was
    /// found twice, the kernel would not open the path -- and it is carried here rather
    /// than as a `Refused` so that the caller can tell "the hand declined the request" from
    /// "the request was carried out and this is what happened".
    Filed {
        /// The caller's identifier.
        id:   String,
        /// Whether anything was done.
        ok:   bool,
        /// The answer: the file's text, the listing, or the sentence explaining the refusal.
        text: String,
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
    /// Everything this hand started that has not finished going.
    ///
    /// The honest picture and not a receipt: a run listed here was measured a
    /// moment ago, and a run absent from it is one the hand can no longer reach.
    /// After a [`Req::Signal`] this is what says whether the signal took.
    Runs {
        runs: Vec<Run>,
        more: u32,	// how many did not fit, past [`RUNS_MAX`]
    },
    /// Something went wrong that is nobody's fault in particular.
    Error {
        /// The run it concerns, where there is one.
        id:      Option<String>,
        /// What happened.
        message: String,
    },
    /// The hand will not start, and this is the sentence saying why.
    ///
    /// The one response sent before the opening exchange, and the only one that names no
    /// run, because there is no conversation yet to name anything in.  A hand that cannot
    /// configure itself -- no granted root, a journal it cannot open, a second hand already
    /// holding the record -- has always had a whole sentence for the reader and has always
    /// written it to standard error, where a browser discards it.  What reached the page was
    /// the browser's own "Native host has exited", from which nothing can be worked out and
    /// nothing can be done.
    ///
    /// So the sentence goes down the pipe first and the process exits after it.  It is
    /// written for a PERSON: whoever has to fix a hand that will not start is at the keyboard,
    /// not in a turn.
    Fault {
        /// The whole sentence: what happened, and the one thing that fixes it.
        reason: String,
    },
}

/// Whether a page speaking `proto` can talk to this hand.
///
/// # Arguments
/// * `proto` - The version the page announced.
pub fn proto_ok(proto: u32) -> bool {
    proto == PROTO
}

/// The sentence a version mismatch produces, which names both ends and the
/// executable that is actually running.
///
/// The path is there because a mismatch is nearly always a mismatch of BUILDS,
/// and the manifest a browser reads can name something other than the checkout
/// a reader is looking at. Without it the sentence states a contradiction --
/// the source says 2, the hand says 1 -- and leaves the reader to guess which
/// of a dozen target directories answered. On 2026-08-26 that guess cost an
/// afternoon.
///
/// # Arguments
/// * `proto` - The version the page announced.
pub fn proto_refusal(proto: u32) -> String {
    let exe = match std::env::current_exe() {
        Ok(p)  => p.display().to_string(),
        Err(e) => fmt!("<a path this hand cannot name: {}>", e),
    };
    fmt!(
        "This hand, at '{}', speaks protocol {} and the page speaks {}. Update whichever \
        is older; they cannot agree on what a command is until you do.",
        exe, PROTO, proto)
}
