//! What was run, what it returned, and what it was stopped from doing.
//!
//! Daimond's claim is that it can be **checked rather than trusted**: the client
//! is public, it rebuilds byte for byte, and every release is sealed in a public
//! append-only log whose entries chain onto one another.  The hand extends that
//! claim onto the user's machine, and this module is how.  A refusal is recorded
//! as carefully as a success, because *what an agent was stopped from doing* is
//! the half of the record nobody else offers.
//!
//! # The shape of the record
//!
//! One JSON object per line, appended and never rewritten, in the same idiom as
//! `verify/transparency.jsonl` so that a reader who has learned to check one has
//! learned to check both:
//!
//! ```text
//! {"seq":N,"ts":MS,"kind":"exec","body":{…},"prev":"<64 hex>","entry":"<64 hex>"}
//! ```
//!
//! `entry` is the SHA-256 of **everything on the line before `,"entry":"`** --
//! that is, of the line's own text including the `prev` it points at.  So the
//! check is arithmetic anyone can do with `sha256sum` and `sed`, in any
//! language, with no JSON parser:
//!
//! ```text
//! head -1 hand-00000000.jsonl | sed 's/,"entry":"[0-9a-f]*"}$//' \
//!     | tr -d '\n' | sha256sum
//! ```
//!
//! The transparency log hashes a pipe-joined preimage of its fields; this hashes
//! the emitted text instead, because a hand entry's body varies by kind and a
//! per-kind preimage rule is one more thing to get wrong.  Hashing the text
//! covers every field of every kind by construction.  The `body` is itself
//! RFC 8785 canonical JSON, so a second implementation that rebuilds the body
//! from parsed values arrives at the identical bytes.
//!
//! `ts` is UTC milliseconds since the Unix epoch, as an integer, rather than the
//! ISO string the transparency log carries.  It is unambiguous, needs no
//! calendar code in a binary whose reproducible rebuild is part of the product's
//! claim, and the rotation boundary falls out of it by integer division.  The
//! record stores the fact; the page renders it.
//!
//! # Where the journal lives, and why it is not in the Diamond
//!
//! **The authoritative journal lives in the hand's own directory, outside every
//! fence the hand ever applies.**  An earlier design note put it in the Diamond's
//! own directory.  That is wrong, and the reason is worth stating plainly: a
//! daimon's fence grants it read *and write* over its Diamond directory, so a
//! journal kept there is a journal the journalled process can edit.  Hash
//! chaining does not rescue it.  A chain is evidence against an editor who
//! cannot recompute the hashes; anyone holding the whole file can recompute all
//! of them and produce a shorter, perfectly self-consistent history.  The entry
//! a misbehaving process would most want gone -- its own refusal -- would be the
//! one sitting in the only directory it was handed a pen for.
//!
//! So: the record goes under the hand's data directory (see [`default_dir`]),
//! [`Journal::check_fence`] refuses outright if that path falls inside any
//! `FenceSpec.rw` root, and [`Journal::fence_guard`] adds the journal root to
//! every fence's `deny` list so a command cannot so much as read it.  A copy may
//! be surfaced to the page for display; the copy is not the record.
//!
//! What this does **not** claim: the hand runs as the user, so the user's own
//! account can still rewrite the file.  Nothing local can prevent that.  What the
//! chain gives is that any such rewrite is *detectable* by anyone who has seen an
//! earlier `entry` hash -- so publishing the head, exactly as the transparency
//! log publishes its head, is what turns detectability into evidence.  That step
//! is deliberately left to the caller.
//!
//! # What a chain cannot do for itself, and what does it instead
//!
//! A hash chain answers *"has any entry been changed?"*.  It cannot answer
//! *"is anything missing from the end?"*, because a shorter history is a
//! perfectly good chain.  An earlier version of this module said that only the
//! live file's tail was unprotected; that was wrong, and the review of
//! 2026-08-02 proved it by deleting the last three files of a twenty-nine file
//! journal, getting `Intact`, and letting the hand resume and *stay* intact.
//! Blanking the final file did the same.  **Any suffix of history erased
//! silently** -- precisely the property a tamper-evident log exists to deny.
//!
//! [`Mark`] closes it: one line, outside the rotated files, naming how far the
//! record has got.  It is written after every flush, so it is a lower bound --
//! a history shorter than the mark has lost something and [`verify_dir`] says
//! so; a history longer than the mark is a crash between an entry reaching the
//! disk and the mark following it, which is ordinary.  Where a loss is found,
//! [`Journal::open`] writes an [`Event::Gap`] recording what the mark vouched
//! for against what is there, and every later verification reports the history
//! as broken from that entry on.  Removing the gap entry breaks the chain of
//! everything after it, so the loss cannot be quietly undone.
//!
//! The residual is stated rather than glossed: an attacker who can write the
//! journal directory can rewrite the mark as well as the files, and a
//! consistent pair of forgeries verifies.  What the mark buys is that
//! truncation is no longer *free* -- it costs two coordinated forgeries instead
//! of one `truncate` -- and that the honest failures, a crash and an
//! interrupted write, are told apart from the dishonest one.  Publishing the
//! head remains the only thing that makes any of it evidence rather than
//! detection.
//!
//! # One writer
//!
//! [`Journal::open`] takes an exclusive lock on the directory and holds it for
//! as long as the journal lives.  Chrome will launch more than one host, and
//! the design expects one per tab; two writers resuming from the same head and
//! interleaving their appends broke the chain permanently in the review.  The
//! lock is `flock` through `std::fs::File::try_lock`, which is safe Rust,
//! needs no dependency, and is released by the operating system when the
//! process goes away.
//!
//! # Secrets
//!
//! A journal is written to be shown to someone.  Everything in it must therefore
//! be safe to show, and the policy follows from that one sentence:
//!
//! * **Environment values are never recorded -- keys only.**  `Req::Exec.env` is
//!   an explicit allow-list, which is precisely where a caller lends a command a
//!   credential.  The accountability question is *"was this command handed a
//!   credential, and which one"*, and the key answers it; the value answers
//!   nothing further.  Redacting values by pattern was considered and rejected:
//!   a pattern list over user-chosen names cannot be complete (`FOO` may hold a
//!   token), so it fails **open** on the names nobody thought of -- which is the
//!   exact shape of the leak this project has already suffered once.
//! * **Standard input is recorded only by length.**  Same reasoning; a heredoc is
//!   as good a place to pass a key as an environment variable is.
//! * **Output is recorded only by byte count.**  Never the bytes.
//! * **`argv` is recorded verbatim**, because a journal that redacts what was run
//!   does not record what was run.  [`redact_argv`] removes the credential
//!   shapes first and counts what it removed, so the record says that something
//!   was taken out rather than quietly altering it.  That pass fails *open* by
//!   design and is a courtesy, not a guarantee: an argument vector is visible in
//!   `ps` to every process the user owns, so it was never a safe place for a
//!   secret.  The journal cannot make it one and does not pretend to.
//! * **Every free-text field goes through [`redact_text`], at one chokepoint.**
//!   The review of 2026-08-02 got a single secret into the file eight times
//!   through fields nobody had thought of as free text: a refusal's reason -- a
//!   refusal that quotes the offending command is the natural wording, and what
//!   the app's own refusals do -- an error's message, the working directory, the
//!   run's own identifier, an environment *key*, a fence path, a mechanism name
//!   and the client's build string.  A redaction applied to the fields somebody
//!   listed is a redaction applied to the wrong list, so it is applied in
//!   [`Event::body`], which is the one place every field of every kind passes
//!   through, and every body carries a `redactions` count so that a removal is
//!   never invisible.
//!
//! # Durability
//!
//! Every entry is written to the operating system the moment it is made
//! ([`Durability::Os`], the default).  It is not `fsync`ed.  The reasoning:
//!
//! * A write into the page cache is a memcpy.  It does not stall the command
//!   loop, so the "buffer it" instinct buys nothing here -- the hand journals
//!   about three lines per command, not three thousand, because output chunks
//!   are never journalled.
//! * The realistic threat to the record is the hand being killed or crashing,
//!   and `Os` survives that intact.  A power cut can still lose the tail; that is
//!   what [`Durability::Sync`] is for, and it costs a disk round trip per entry.
//! * [`Durability::Batched`] exists for bulk replay and is documented as lossy.
//!   An unflushed journal loses the last thing that happened, which is exactly
//!   the thing you most want to read afterwards.
//!
//! The ordering rule that makes the above sound: **journal before acting.**
//! Append the `exec` entry before spawning and the `refused` entry before
//! sending the refusal, so the record can never be missing something that
//! happened.
//!
//! # Rotation
//!
//! Files are `hand-00000000.jsonl`, `hand-00000001.jsonl`, … and roll over on
//! size or on a change of UTC day -- including a day that turned while the hand
//! was not running, which is why a resumed file takes its day from its last
//! entry rather than from the clock.  `seq` is global and `prev` carries across
//! the boundary, so the whole history verifies as one chain ([`verify_dir`]).
//! The first entry of each rolled file is a `rotated` entry naming the file it
//! continues -- which also means that lopping whole lines off the end of a
//! *rotated* file is caught, since the next file's `seq` no longer follows on.
//!
//! The index is bounded by the eight digits the name format carries: rotation
//! stops rather than writing `hand-100000000.jsonl`, a name no verifier reads.
//! Anything else in the directory named like a journal file, including a
//! directory or a symbolic link with such a name, is moved aside and recorded
//! as an [`Event::Stray`] before a byte is appended -- it is never deleted, and
//! it never steers the writer.

use crate::wire::{
    Capture,
    FenceSpec,
    Req,
    Resp,
    Sig,
};

use oxedyne_fe2o3_core::{
    prelude::*,
    byte::B32,
    string::ToHexString,
};
use oxedyne_fe2o3_hash::sha256;
use oxedyne_fe2o3_jdat::prelude::*;

use std::{
    fs,
    fs::{
        File,
        OpenOptions,
    },
    io::Write,
    path::{
        Component,
        Path,
        PathBuf,
    },
    sync::{
        Arc,
        atomic::{
            AtomicI64,
            Ordering,
        },
    },
    time::{
        SystemTime,
        UNIX_EPOCH,
    },
};

// ┌───────────────────────────────────────────────────────────────┐
// │ The line format, stated once                                   │
// └───────────────────────────────────────────────────────────────┘

/// The predecessor of the first entry: a chain has to start pointing at nothing.
///
/// Sixty four zeros, the same sentinel `verify/lib.mjs` uses for `GENESIS_PREV`.
pub const GENESIS: &str = "0000000000000000000000000000000000000000000000000000000000000000";

/// The characters separating an entry's hashed text from the hash itself.
const ENTRY_TAG: &str = ",\"entry\":\"";

/// The characters introducing the predecessor's hash, last field before it.
const PREV_TAG: &str = ",\"prev\":\"";

/// The characters every entry opens with, which also carry its sequence.
const SEQ_TAG: &str = "{\"seq\":";

/// The characters introducing the timestamp.
const TS_TAG: &str = ",\"ts\":";

/// The characters introducing the event kind.
const KIND_TAG: &str = ",\"kind\":\"";

/// The characters introducing the body.
const BODY_TAG: &str = ",\"body\":";

/// A SHA-256 digest's length in lower case hexadecimal.
const HEX_LEN: usize = 64;

/// How many bytes of a line follow the hashed text: `,"entry":"<64 hex>"}`.
const ENTRY_SUFFIX: usize = ENTRY_TAG.len() + HEX_LEN + 2;

/// How many bytes of the hashed text are the predecessor: `,"prev":"<64 hex>"`.
const PREV_SUFFIX: usize = PREV_TAG.len() + HEX_LEN + 1;

/// What a journal file is called, before its index.
const FILE_STEM: &str = "hand-";

/// What a journal file is called, after its index.
const FILE_EXT: &str = ".jsonl";

/// How many digits a journal file's index is padded to, so the names sort.
const FILE_DIGITS: usize = 8;

/// The largest index the name format can carry.
///
/// The review found `maybe_rotate` incrementing past a planted
/// `hand-99999999.jsonl` into `hand-100000000.jsonl`, a nine-digit name that
/// [`journal_files`] never returns and no verifier ever reads.  The rotation is
/// bounded here so that a name outside the format is a refusal rather than a
/// silent hole.
const MAX_IDX: u32 = 99_999_999;

/// Where the high-water mark lives: outside the rotated files, by design.
///
/// A chain proves that a history has not been *edited*.  It cannot, on its own,
/// prove that a history has not been *shortened*, because a shorter chain is
/// still a chain.  The mark is the smallest thing that closes that: one line
/// naming how far the record had got, kept where lopping the tail off the files
/// does not touch it.
const MARK_FILE: &str = "head.json";

/// Where the mark is written before it is renamed into place.
const MARK_TMP: &str = "head.json.new";

/// The lock every writer must hold, so that two hands cannot interleave.
const LOCK_FILE: &str = "lock";

/// What a file named like a journal file but written by something else becomes.
///
/// Moved rather than deleted: the journal does not destroy what it did not
/// write, and a plant is evidence about whoever planted it.
const STRAY_STEM: &str = "foreign-";

/// The characters introducing the mark's own hash, last field on its line.
const MARK_TAG: &str = ",\"mark\":\"";

/// How many times the directory's lock is asked for before it is a refusal.
const LOCK_TRIES: usize = 25;

/// How long to wait between asking for the lock, in milliseconds.
const LOCK_WAIT_MS: u64 = 20;

/// Milliseconds in a UTC day, which is the rotation boundary.
///
/// UTC has no daylight saving, so the day a timestamp falls in is integer
/// division and needs no calendar.
const DAY_MS: i64 = 86_400_000;

/// The default size at which a file rolls over: generous enough that a working
/// day lands in one file, small enough that the file stays readable.
pub const DEFAULT_MAX_BYTES: u64 = 8 * 1024 * 1024;

/// The largest integer canonical JSON will carry, `2^53 - 1`.
///
/// The encoder refuses anything beyond it, on the grounds that a JavaScript
/// reader could not hold it exactly.  A byte count that large is not physical, so
/// clamping is the right failure: a journal must not decline to record an event
/// because a counter was absurd.
const JS_SAFE: u64 = 9_007_199_254_740_991;

/// What replaces a value the journal declined to write down.
pub const REDACTED: &str = "<redacted>";

// ┌───────────────────────────────────────────────────────────────┐
// │ Time                                                           │
// └───────────────────────────────────────────────────────────────┘

/// Where an entry's timestamp comes from.
///
/// An enum rather than a trait object: there are exactly two sources, the system
/// and a test's own hand, and a boxed closure would buy nothing but an
/// allocation and an indirection.
#[derive(Clone, Debug)]
pub enum Clock {
    /// The machine's own clock.
    System,
    /// A clock the caller moves, for tests and for replay.
    Fixed(Arc<AtomicI64>),
}

impl Default for Clock {
    fn default() -> Self {
        Self::System
    }
}

impl Clock {

    /// Creates a clock stopped at a given instant.
    ///
    /// # Arguments
    /// * `ms` - UTC milliseconds since the Unix epoch.
    pub fn fixed(ms: i64) -> Self {
        Self::Fixed(Arc::new(AtomicI64::new(ms)))
    }

    /// Reads the clock, in UTC milliseconds since the Unix epoch.
    ///
    /// # Returns
    /// The instant, or an error where the system clock reads before the epoch.
    pub fn now_ms(&self) -> Outcome<i64> {
        match self {
            Self::System => match SystemTime::now().duration_since(UNIX_EPOCH) {
                Ok(d)  => Ok(d.as_millis() as i64),
                Err(_) => Err(err!(
                    "The system clock reads before the Unix epoch, so the hand \
                    cannot stamp an entry with a time anyone could order.";
                    System, Invalid)),
            },
            Self::Fixed(a) => Ok(a.load(Ordering::SeqCst)),
        }
    }

    /// Moves a fixed clock forward.
    ///
    /// # Arguments
    /// * `ms` - How far to advance, in milliseconds.
    ///
    /// # Returns
    /// An error where the clock is the system's, which nobody may move.
    pub fn advance(&self, ms: i64) -> Outcome<()> {
        match self {
            Self::Fixed(a) => {
                a.fetch_add(ms, Ordering::SeqCst);
                Ok(())
            },
            Self::System => Err(err!(
                "The system clock cannot be advanced by the journal.";
                Invalid, Input)),
        }
    }
}

/// The UTC day a timestamp falls in, counted from the epoch.
///
/// # Arguments
/// * `ts` - UTC milliseconds since the Unix epoch.
fn day_of(ts: i64) -> i64 {
    ts.div_euclid(DAY_MS)
}

// ┌───────────────────────────────────────────────────────────────┐
// │ Events                                                         │
// └───────────────────────────────────────────────────────────────┘

/// One thing worth writing down.
///
/// The variants track the wire's own vocabulary, so turning a message into a
/// record is a `match` and not a judgement call.  [`Event::Refused`] is the
/// load-bearing one: a record of what the hand declined is what separates this
/// from a shell history.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Event {
    /// A page introduced itself.
    Opened {
        /// The protocol version it speaks.
        proto:  u32,
        /// Which build of the app is asking.
        client: String,
    },
    /// A command was about to be run.
    ///
    /// Written **before** the spawn, so the record cannot be missing a command
    /// that started.
    Exec {
        /// The caller's identifier for the run.
        id:          String,
        /// The program and its arguments, credential shapes removed.
        argv:        Vec<String>,
        /// How many arguments [`redact_argv`] took something out of.
        redactions:  u32,
        /// The working directory.
        cwd:         String,
        /// The environment's keys.  Never its values -- see the module doc.
        env_keys:    Vec<String>,
        /// How many bytes of standard input were supplied.  Never the bytes.
        stdin_bytes: u64,
        /// The hard wall-clock limit that was set.
        timeout_ms:  u64,
        /// Which streams the caller asked for.
        capture:     Capture,
        /// What the command was allowed to touch.
        fence:       FenceSpec,
        /// Which fence mechanisms were actually in force.
        ///
        /// Free-form names supplied by the fence layer, because *what was asked
        /// for* and *what the kernel actually enforced* are different facts and
        /// only the second one is a guarantee.
        mechs:       Vec<String>,
    },
    /// A command started, and is now a real process.
    Started {
        /// The caller's identifier.
        id:  String,
        /// The child's process id.
        pid: u32,
    },
    /// A signal was delivered to a running command.
    Signalled {
        /// The caller's identifier.
        id:  String,
        /// Which signal.
        sig: Sig,
    },
    /// A command finished, one way or another.
    Ended {
        /// The caller's identifier.
        id:        String,
        /// The exit status, or -1 where there was none.
        exit:      i32,
        /// Whether the hard timeout killed it.
        timed_out: bool,
        /// Whether a signal killed it.
        killed:    bool,
        /// How many bytes of standard output were produced.
        out_bytes: u64,
        /// How many bytes of standard error were produced.
        err_bytes: u64,
    },
    /// The hand declined, and this is why.
    Refused {
        /// The caller's identifier.
        id:     String,
        /// The whole sentence the model was given.
        reason: String,
    },
    /// Something went wrong that is nobody's fault in particular.
    Failed {
        /// The run it concerns, where there is one.
        id:      Option<String>,
        /// What happened.
        message: String,
    },
    /// A new file continues the chain from an older one.
    Rotated {
        /// The file this one continues.
        from_file:  String,
        /// The last sequence number that file carried.
        from_seq:   u64,
        /// The last entry hash that file carried.
        from_entry: String,
        /// Trailing bytes found after its last complete entry, from a torn write.
        torn_bytes: u64,
        /// The line at which that file stopped verifying, where it did.
        broken_at:  Option<u64>,
    },
    /// History that the high-water mark vouched for is no longer there.
    ///
    /// The one entry a journal cannot write about itself honestly unless it
    /// keeps a mark outside the rotated files -- see [`Mark`].  A `gap` is
    /// indelible in the only sense that matters locally: [`verify_dir`] reports
    /// the whole history as broken from here on, and removing the entry breaks
    /// the chain of everything after it.
    Gap {
        /// The sequence number the mark said the next entry would carry.
        expect_seq:   u64,
        /// The entry hash the mark said the record had reached.
        expect_entry: String,
        /// The sequence number actually found.
        found_seq:    u64,
        /// The entry hash actually found.
        found_entry:  String,
        /// What was noticed, in a sentence.
        note:         String,
    },
    /// Something named like a journal file, which the journal did not write.
    ///
    /// Recorded rather than ignored, because the review of 2026-08-02 showed a
    /// single planted name silently sending every later entry to a file no
    /// verifier reads.
    Stray {
        /// What it was called.
        name:     String,
        /// What it was: `file`, `directory` or `other`.
        shape:    String,
        /// Where it was moved to, so nothing is destroyed.
        moved_to: String,
    },
    /// The page went away.
    Closed {
        /// Why, in a phrase.
        reason: String,
    },
}

impl Event {

    /// The event's kind, as the line spells it.
    ///
    /// Drawn from a closed vocabulary of lower case ASCII, so the field never
    /// needs escaping and a reader can match on it without a parser.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Opened    {..} => "opened",
            Self::Exec      {..} => "exec",
            Self::Started   {..} => "started",
            Self::Signalled {..} => "signalled",
            Self::Ended     {..} => "ended",
            Self::Refused   {..} => "refused",
            Self::Failed    {..} => "failed",
            Self::Rotated   {..} => "rotated",
            Self::Gap       {..} => "gap",
            Self::Stray     {..} => "stray",
            Self::Closed    {..} => "closed",
        }
    }

    /// The event as RFC 8785 canonical JSON, which is what the line carries.
    ///
    /// **This is where redaction happens**, and it happens here rather than at
    /// each of the places an event is built because the review of 2026-08-02
    /// found the same credential reaching the file eight times through fields
    /// nobody had listed as free text.  One chokepoint that every field passes
    /// through is a rule; a list of the fields somebody remembered is a hope.
    ///
    /// Every body carries `redactions`, so that a value having been removed is
    /// never invisible -- including on the kinds where a redaction is unlikely,
    /// because a caller-chosen `id` is free text like any other.
    ///
    /// # Returns
    /// The canonical text, or an error where a value has no canonical form.
    pub fn body(&self) -> Outcome<String> {
        let mut s = Scrub::new();
        let d = match self {
            Self::Opened { proto, client } => {
                let client = s.one(client);
                mapdat!{
                    "proto"      => Dat::U32(*proto),
                    "client"     => client,
                    "redactions" => Dat::U32(s.cut),
                }
            },
            Self::Exec {
                id,
                argv,
                redactions,
                cwd,
                env_keys,
                stdin_bytes,
                timeout_ms,
                capture,
                fence,
                mechs,
            } => {
                let id       = s.one(id);
                let argv     = s.argv(argv);
                let cwd      = s.one(cwd);
                let env_keys = s.many(env_keys);
                let fence    = fence_dat(&mut s, fence);
                let mechs    = s.many(mechs);
                mapdat!{
                    "id"          => id,
                    "argv"        => argv,
                    // What `from_req` already took out, plus what this pass did.
                    // The pass is idempotent, so a vector redacted twice is not
                    // counted twice.
                    "redactions"  => Dat::U32(redactions.saturating_add(s.cut)),
                    "cwd"         => cwd,
                    "env_keys"    => env_keys,
                    "stdin_bytes" => Dat::U64(clamp(*stdin_bytes)),
                    "timeout_ms"  => Dat::U64(clamp(*timeout_ms)),
                    "capture"     => Dat::Str(capture_name(*capture).to_string()),
                    "fence"       => fence,
                    "mechs"       => mechs,
                }
            },
            Self::Started { id, pid } => {
                let id = s.one(id);
                mapdat!{
                    "id"         => id,
                    "pid"        => Dat::U32(*pid),
                    "redactions" => Dat::U32(s.cut),
                }
            },
            Self::Signalled { id, sig } => {
                let id = s.one(id);
                mapdat!{
                    "id"         => id,
                    "sig"        => Dat::Str(sig_name(*sig).to_string()),
                    "redactions" => Dat::U32(s.cut),
                }
            },
            Self::Ended { id, exit, timed_out, killed, out_bytes, err_bytes } => {
                let id = s.one(id);
                mapdat!{
                    "id"         => id,
                    "exit"       => Dat::I32(*exit),
                    "timed_out"  => Dat::Bool(*timed_out),
                    "killed"     => Dat::Bool(*killed),
                    "out_bytes"  => Dat::U64(clamp(*out_bytes)),
                    "err_bytes"  => Dat::U64(clamp(*err_bytes)),
                    "redactions" => Dat::U32(s.cut),
                }
            },
            Self::Refused { id, reason } => {
                let id     = s.one(id);
                let reason = s.one(reason);
                mapdat!{
                    "id"         => id,
                    "reason"     => reason,
                    "redactions" => Dat::U32(s.cut),
                }
            },
            Self::Failed { id, message } => {
                let id      = s.opt(id);
                let message = s.one(message);
                mapdat!{
                    "id"         => id,
                    "message"    => message,
                    "redactions" => Dat::U32(s.cut),
                }
            },
            Self::Rotated { from_file, from_seq, from_entry, torn_bytes, broken_at } => {
                let from_file  = s.one(from_file);
                let from_entry = s.one(from_entry);
                mapdat!{
                    "from_file"  => from_file,
                    "from_seq"   => Dat::U64(clamp(*from_seq)),
                    "from_entry" => from_entry,
                    "torn_bytes" => Dat::U64(clamp(*torn_bytes)),
                    "broken_at"  => match broken_at {
                        Some(n) => Dat::U64(clamp(*n)),
                        None    => Dat::Empty,
                    },
                    "redactions" => Dat::U32(s.cut),
                }
            },
            Self::Gap { expect_seq, expect_entry, found_seq, found_entry, note } => {
                let note   = s.one(note);
                let expect = s.one(expect_entry);
                let found  = s.one(found_entry);
                mapdat!{
                    "expect_seq"   => Dat::U64(clamp(*expect_seq)),
                    "expect_entry" => expect,
                    "found_seq"    => Dat::U64(clamp(*found_seq)),
                    "found_entry"  => found,
                    "note"         => note,
                    "redactions"   => Dat::U32(s.cut),
                }
            },
            Self::Stray { name, shape, moved_to } => {
                let name  = s.one(name);
                let moved = s.one(moved_to);
                mapdat!{
                    "name"       => name,
                    "shape"      => Dat::Str(shape.clone()),
                    "moved_to"   => moved,
                    "redactions" => Dat::U32(s.cut),
                }
            },
            Self::Closed { reason } => {
                let reason = s.one(reason);
                mapdat!{
                    "reason"     => reason,
                    "redactions" => Dat::U32(s.cut),
                }
            },
        };
        Ok(res!(d.json_canonical()))
    }

    /// The event a request deserves, where it deserves one.
    ///
    /// # Arguments
    /// * `req`   - The message the page sent.
    /// * `mechs` - The fence mechanisms actually in force for this run.
    ///
    /// # Returns
    /// `None` for a message not worth a line of its own.
    pub fn from_req(req: &Req, mechs: &[String]) -> Option<Self> {
        match req {
            Req::Hello { proto, client } => Some(Self::Opened {
                proto:  *proto,
                client: client.clone(),
            }),
            // A terminal session is recorded exactly as a command is: what was run, where, and
            // under what fence. It is the same act.
            // The toolkit names are not recorded beside the fence because the fence already
            // carries what they resolved to -- the absolute toolchain paths are in `rw` and `ro`,
            // which is the answer to "what could this command reach" in the form that decides it.
            Req::Open { id, argv, cwd, env, size: _, fence, toolkits: _ } => {
                let (safe, cut) = redact_argv(argv);
                Some(Self::Exec {
                    id:          id.clone(),
                    argv:        safe,
                    cwd:         cwd.clone(),
                    env_keys:    env_keys(env),
                    stdin_bytes: 0,
                    timeout_ms:  0,
                    // A terminal merges the two streams by construction, so Both is the only
                    // honest answer; the size is not a capture and is not recorded as one.
                    capture:     Capture::Both,
                    fence:       fence.clone(),
                    mechs:       mechs.to_vec(),
                    redactions:  cut,
                })
            },
            // **Keystrokes are NEVER written down.** A pty exists so that a program can ask a
            // question, and the questions are `sudo` wanting a password, `ssh` wanting a
            // passphrase, `gpg` wanting the key. Recording input would put the one secret the
            // user typed by hand into a file whose whole purpose is to be kept and read. The
            // count is not recorded either: how many characters a password has is not nothing.
            Req::Input { .. } => None,
            // Nothing happened that anyone need answer for.
            Req::Resize { .. } => None,
            Req::Exec { id, argv, cwd, env, stdin, timeout_ms, capture, fence, toolkits: _ } => {
                let (safe, cut) = redact_argv(argv);
                Some(Self::Exec {
                    id:          id.clone(),
                    argv:        safe,
                    redactions:  cut,
                    cwd:         cwd.clone(),
                    env_keys:    env_keys(env),
                    stdin_bytes: match stdin {
                        Some(s) => s.len() as u64,
                        None    => 0,
                    },
                    timeout_ms:  *timeout_ms,
                    capture:     *capture,
                    fence:       fence.clone(),
                    mechs:       mechs.to_vec(),
                })
            },
            // A VERIFY IS NOT ITSELF AN ACT, and writing it down as one would put a verb in the
            // record where a reader expects a process. Every run it makes is journalled as the
            // `Exec` it really is -- the node command line, the granted root, and `fence:none` in
            // the mechanisms, because a verifier runs outside the command fence on purpose. A
            // verify that is REFUSED is still recorded, by the refusal on its way out.
            Req::Verify { .. } => None,
            Req::Signal { id, sig } => Some(Self::Signalled {
                id:  id.clone(),
                sig: *sig,
            }),
            Req::Bye => Some(Self::Closed {
                reason: "the page said goodbye".to_string(),
            }),
        }
    }

    /// The event a response deserves, where it deserves one.
    ///
    /// # Arguments
    /// * `resp` - The message the hand is about to send.
    ///
    /// # Returns
    /// `None` for output chunks and for the opening handshake.  A chunk carries
    /// the command's output, which the journal never keeps; the handshake says
    /// nothing the request has not already said.
    pub fn from_resp(resp: &Resp) -> Option<Self> {
        match resp {
            Resp::Opened { id, pid } => Some(Self::Started {
                id:  id.clone(),
                pid: *pid,
            }),
            // As a chunk is: the terminal's own bytes are the command's output, and the journal
            // never keeps output. Here it matters twice over, because a terminal echoes what was
            // typed -- so keeping output would keep the password the input arm refuses.
            Resp::Output { .. } => None,
            Resp::Closed { id, exit, killed } => Some(Self::Ended {
                id:        id.clone(),
                exit:      *exit,
                timed_out: false,
                killed:    *killed,
                out_bytes: 0,
                err_bytes: 0,
            }),
            Resp::Started { id, pid } => Some(Self::Started {
                id:  id.clone(),
                pid: *pid,
            }),
            Resp::Ended { id, exit, timed_out, killed, out_bytes, err_bytes } => Some(Self::Ended {
                id:        id.clone(),
                exit:      *exit,
                timed_out: *timed_out,
                killed:    *killed,
                out_bytes: *out_bytes,
                err_bytes: *err_bytes,
            }),
            Resp::Refused { id, reason } => Some(Self::Refused {
                id:     id.clone(),
                reason: reason.clone(),
            }),
            Resp::Error { id, message } => Some(Self::Failed {
                id:      id.clone(),
                message: message.clone(),
            }),
            Resp::Hello {..} | Resp::Chunk {..} => None,
        }
    }
}

/// A fence specification as a daticle, with its roots ordered and redacted.
///
/// Sorting means two callers who granted the same thing in a different order
/// produce the same record, so a diff of two entries is about the grant rather
/// than about the spelling.  A path is free text like any other -- a directory
/// can be named after a token -- so it goes through the scrubber too.
///
/// # Arguments
/// * `s` - The running redaction count for this entry.
/// * `f` - The specification that was applied.
fn fence_dat(s: &mut Scrub, f: &FenceSpec) -> Dat {
    let rw   = s.sorted(&f.rw);
    let ro   = s.sorted(&f.ro);
    let deny = s.sorted(&f.deny);
    mapdat!{
        "rw"   => rw,
        "ro"   => ro,
        "deny" => deny,
        "net"  => Dat::Bool(f.net),
    }
}

/// A capture selection, as the line spells it.
///
/// # Arguments
/// * `c` - The selection.
fn capture_name(c: Capture) -> &'static str {
    match c {
        Capture::Both => "both",
        Capture::Out  => "out",
        Capture::Err  => "err",
        Capture::None => "none",
    }
}

/// A signal, as the line spells it.
///
/// # Arguments
/// * `s` - The signal.
fn sig_name(s: Sig) -> &'static str {
    match s {
        Sig::Term => "term",
        Sig::Kill => "kill",
        Sig::Int  => "int",
    }
}

/// A count canonical JSON can carry, clamped rather than refused.
///
/// # Arguments
/// * `n` - The count.
fn clamp(n: u64) -> u64 {
    if n > JS_SAFE { JS_SAFE } else { n }
}

// ┌───────────────────────────────────────────────────────────────┐
// │ Secrets                                                        │
// └───────────────────────────────────────────────────────────────┘

/// The environment's keys, sorted, with the values discarded.
///
/// Duplicates are kept: two pairs with the same name is an oddity a reader
/// should see rather than one the journal quietly tidies away.
///
/// # Arguments
/// * `env` - The pairs the page supplied.
pub fn env_keys(env: &[(String, String)]) -> Vec<String> {
    let mut out: Vec<String> = env.iter().map(|(k, _)| k.clone()).collect();
    out.sort();
    out
}

/// Name tails that make a value a credential, wherever the name is spelled.
///
/// Matched as a plain suffix of the normalised name, which is what catches
/// `PGPASSWORD` and `AWS_SECRET_ACCESS_KEY` as well as `--password`.  The
/// review of 2026-08-02 found the previous exact-match list catching none of
/// `--PASSWORD`, `--Token`, `--secret-access-key` or `--private-key`: an
/// exact list over a case-sensitive comparison is a list of the spellings
/// somebody happened to think of.
const SECRET_TAILS: &[&str] = &[
    "password",
    "passwd",
    "passphrase",
    "secret",
    "token",
    "credential",
    "credentials",
    "authorization",
    "apikey",
    "api-key",
    "access-key",
    "private-key",
    "signing-key",
    "session-key",
    "session",
    "master-key",
    "encryption-key",
    "cookie",
    "bearer",
];

/// Flags whose value is a `user:password` pair rather than a bare credential.
///
/// `-u` is deliberately not a secret flag -- `useradd -u 1000` is not a
/// credential and over-redaction damages the record -- but `curl -u me:hunter2`
/// is, and the colon is what tells them apart.  So the value is redacted only
/// from the colon onwards, and an argument without one is left alone.
const USERINFO_FLAGS: &[&str] = &[
    "u",
    "user",
    "username",
    "userinfo",
    "login",
];

/// Name tails that count only where they stand as a whole word.
///
/// `--pass` is a credential and `--bypass` is not, so these match at the start
/// of a name or after a separator and nowhere else.
const SECRET_WORDS: &[&str] = &[
    "pass",
    "auth",
    "pwd",
    "pat",
];

/// Published key formats, each with the least trailing length worth believing.
///
/// The length matters: `sk-` is three characters and appears inside ordinary
/// words, so a bare prefix test over a long string is a false positive waiting
/// to happen.  A real key of that family is long, and requiring the length
/// keeps `sk-headless-renderer` out of the redactor while keeping every real
/// key in it.
const SECRET_PREFIXES: &[(&str, usize)] = &[
    ("sk-",         20),
    ("sk_live_",     8),
    ("sk_test_",     8),
    ("rk_live_",     8),
    ("pk_live_",     8),
    ("ghp_",         8),
    ("gho_",         8),
    ("ghu_",         8),
    ("ghs_",         8),
    ("ghr_",         8),
    ("github_pat_",  8),
    ("xoxb-",        8),
    ("xoxp-",        8),
    ("xoxa-",        8),
    ("xoxs-",        8),
    ("AKIA",         8),
    ("ASIA",         8),
    ("AIza",         8),
    ("ya29.",        8),
    ("eyJ",          8),
];

/// Header names whose value is an authorisation and never anything else.
const SECRET_HEADERS: &[&str] = &[
    "authorization:",
    "proxy-authorization:",
    "x-api-key:",
    "x-auth-token:",
    "x-amz-security-token:",
    "api-key:",
    "cookie:",
    "set-cookie:",
];

/// Authorisation schemes whose next word is the credential.
const SCHEMES: &[&str] = &[
    "bearer",
    "basic",
    "token",
];

/// A name with the spellings that differ but do not matter folded together.
///
/// # Arguments
/// * `s` - The name as it was written.
fn norm_name(s: &str) -> String {
    s.trim_start_matches('-')
        .chars()
        .map(|c| if c == '_' { '-' } else { c.to_ascii_lowercase() })
        .collect()
}

/// Whether a name says its value is a credential.
///
/// # Arguments
/// * `name` - The flag or variable name, as it was written.
fn looks_secret_name(name: &str) -> bool {
    let n = norm_name(name);
    if n.is_empty() {
        return false;
    }
    if SECRET_TAILS.iter().any(|t| n.ends_with(t)) {
        return true;
    }
    SECRET_WORDS.iter().any(|t| {
        if !n.ends_with(t) {
            return false;
        }
        match n.len().checked_sub(t.len()) {
            Some(0) => true,
            Some(i) => n.as_bytes()[i - 1] == b'-',
            None    => false,
        }
    })
}

/// Whether a string is shaped like a flag or an environment variable's name.
///
/// Used to decide whether the text before an `=` is a *name* at all, so that a
/// URL carrying a `?key=` is not mistaken for one.
///
/// # Arguments
/// * `s` - The text before the `=`.
fn is_name_like(s: &str) -> bool {
    let t = s.trim_start_matches('-');
    !t.is_empty() && t.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-' || b == b'.')
}

/// The last segment of a name reached through a path, a query or a colon.
///
/// `//registry.npmjs.org/:_authToken` names a credential and is not shaped like
/// a flag; its last segment is.
///
/// # Arguments
/// * `s` - The text before the `=`.
fn tail_name(s: &str) -> &str {
    match s.rfind(|c| c == '/' || c == ':' || c == '?' || c == '&' || c == '.') {
        Some(i) => &s[i + 1..],
        None    => s,
    }
}

/// Whether a byte may sit immediately before a published key format.
///
/// A token inside a URL is the commonest way a key lands in an argument vector,
/// so the test cannot be `starts_with`; but it cannot be `contains` either, or
/// every word with `sk-` in the middle is redacted.  The answer is a boundary.
///
/// # Arguments
/// * `b` - The byte before the candidate.
fn is_boundary(b: u8) -> bool {
    matches!(b,
        b'/' | b':' | b'=' | b'?' | b'&' | b'@' | b',' | b';' | b'"' | b'\'' |
        b'`' | b'(' | b'[' | b'{' | b'<' | b'-' | b'_' | b' ' | b'\t')
}

/// Whether a character ends a run of credential text.
///
/// # Arguments
/// * `c` - The character.
fn is_run_end(c: char) -> bool {
    c.is_whitespace() || matches!(c,
        '"' | '\'' | '`' | '&' | '@' | ',' | ';' | '<' | '>' | ')' | ']' | '}' | '/' | ':' | '\\')
}

/// An ASCII case-insensitive prefix test that never slices by the wrong length.
///
/// The review found `&a[..h.len()]` indexing the original string by the length
/// of its *lowercased* copy.  No panic was reachable with the constants of the
/// day, but the bug was one added constant away from one.  Comparing bytes in
/// place removes the second string, and with it the second length.
///
/// # Arguments
/// * `s`   - The text.
/// * `pre` - The ASCII prefix to look for.
fn starts_ci(s: &str, pre: &str) -> bool {
    s.len() >= pre.len() && s.as_bytes()[..pre.len()].eq_ignore_ascii_case(pre.as_bytes())
}

/// Whether a value is a port, a port mapping or a protocol-qualified one.
///
/// `docker run -p8080:80` and `mysql -phunter2` are the same shape, and only
/// one of them is a credential.  This is what tells them apart.
///
/// # Arguments
/// * `v` - The text attached to the short flag.
fn is_port_like(v: &str) -> bool {
    let core = match v.rsplit_once('/') {
        Some((head, tail)) if tail == "tcp" || tail == "udp" => head,
        _ => v,
    };
    !core.is_empty() && core.bytes().all(|b| b.is_ascii_digit() || b == b':' || b == b'.')
}

/// The text before and after the first `=`, where there is one.
///
/// # Arguments
/// * `s` - The candidate.
fn split_assign(s: &str) -> Option<(&str, &str)> {
    s.split_once('=')
}

/// One redaction pass, and what it has taken out so far.
///
/// The state is one bit -- whether the last thing read named a credential that
/// the next thing carries -- plus the count.  An enum would be two variants of
/// one boolean, so a boolean it is.
struct Pass {
    /// What the next thing read is expected to be.
    pending: Pend,
    /// How many values have been taken out.
    cut:     u32,
}

/// What the thing after a flag is.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Pend {
    /// Nothing in particular.
    No,
    /// The whole of it is a credential.
    Value,
    /// It is a `user:password` pair, and only the half after the colon is.
    UserInfo,
}

impl Pass {

    /// A pass that has taken nothing out yet.
    fn new() -> Self {
        Self { pending: Pend::No, cut: 0 }
    }

    /// A `user:password` pair with the password taken out.
    ///
    /// # Arguments
    /// * `v` - The pair, or something that is not one.
    fn userinfo(&mut self, v: &str) -> String {
        match v.find(':') {
            Some(c) => {
                let r = self.replace(&v[c + 1..]);
                fmt!("{}{}", &v[..c + 1], r)
            },
            None => v.to_string(),
        }
    }

    /// The `name=value` pairs of a form-encoded body, redacted by name.
    ///
    /// `--data 'grant_type=password&client_secret=hunter2'` is one argument
    /// carrying two fields, and splitting only at the first `=` reads the whole
    /// of it as one.
    ///
    /// # Arguments
    /// * `a` - The candidate.
    fn scrub_pairs(&mut self, a: &str) -> String {
        if !a.contains('&') {
            return a.to_string();
        }
        let mut out   = String::with_capacity(a.len());
        let mut first = true;
        for pair in a.split('&') {
            if !first {
                out.push('&');
            }
            first = false;
            match split_assign(pair) {
                Some((k, v)) if is_name_like(k) && looks_secret_name(k) => {
                    let r = self.replace(v);
                    out.push_str(k);
                    out.push('=');
                    out.push_str(&r);
                },
                _ => out.push_str(pair),
            }
        }
        out
    }

    /// Replaces a value, counting it unless it has already been replaced.
    ///
    /// Idempotence is what lets the same pass run twice -- once on the way into
    /// an [`Event`] and once on the way out to the line -- without the count
    /// telling the reader that two things were removed when one was.
    ///
    /// # Arguments
    /// * `v` - The value to remove.
    fn replace(&mut self, v: &str) -> String {
        if v == REDACTED {
            return v.to_string();
        }
        self.cut += 1;
        REDACTED.to_string()
    }

    /// The rules that do not depend on what came before: headers, schemes,
    /// URLs, joined `name=value` forms, attached short flags and key formats.
    ///
    /// # Arguments
    /// * `a` - One argument, or one word of free text.
    fn scrub(&mut self, a: &str) -> String {
        // An authorisation header carried as one argument.  The name is kept,
        // because which header was set is part of what was run.
        for h in SECRET_HEADERS.iter() {
            if starts_ci(a, h) {
                let rest = a[h.len()..].trim();
                if rest.is_empty() || rest == REDACTED {
                    return a.to_string();
                }
                self.cut += 1;
                return fmt!("{} {}", &a[..h.len()], REDACTED);
            }
        }
        // `Bearer <token>`, and its friends, as one argument.
        for s in SCHEMES.iter() {
            let pre = fmt!("{} ", s);
            if starts_ci(a, &pre) {
                let rest = a[pre.len()..].trim();
                if rest.is_empty() || rest == REDACTED {
                    return a.to_string();
                }
                self.cut += 1;
                return fmt!("{} {}", &a[..s.len()], REDACTED);
            }
        }
        if let Some(s) = self.short_attached(a) {
            return s;
        }
        // A flag and its value in one argument, as `--passphrase hunter2`.
        if a.starts_with('-') {
            if let Some((head, val)) = a.split_once(' ') {
                if looks_secret_name(head) {
                    let v = self.replace(val.trim_start());
                    return fmt!("{} {}", head, v);
                }
            }
        }
        if let Some((head, val)) = split_assign(a) {
            if is_name_like(head) {
                if looks_secret_name(head) {
                    let v = self.replace(val);
                    return fmt!("{}={}", head, v);
                }
                if USERINFO_FLAGS.iter().any(|f| *f == norm_name(head)) {
                    let v = self.userinfo(val);
                    return fmt!("{}={}", head, v);
                }
                // A flag whose value may itself be a header, a URL or a key.
                let v = self.scrub(val);
                return fmt!("{}={}", head, v);
            }
            // A name reached through a path or a query, as npm's
            // `//registry/:_authToken=…`.  The last segment is the name.
            if looks_secret_name(tail_name(head)) {
                let v = self.replace(val);
                return fmt!("{}={}", head, v);
            }
        }
        let a = self.scrub_url(a);
        let a = self.scrub_pairs(&a);
        self.scrub_prefixes(&a)
    }

    /// A short flag with its value stuck to it, such as `-phunter2`.
    ///
    /// # Arguments
    /// * `a` - The argument.
    ///
    /// # Returns
    /// The redacted argument, or `None` where this is not that shape.
    fn short_attached(&mut self, a: &str) -> Option<String> {
        if a.len() <= 2 || a.starts_with("--") || !a.starts_with('-') {
            return None;
        }
        let letter = &a[1..2];
        if letter != "p" {
            return None;
        }
        let val = &a[2..];
        if is_port_like(val) {
            return None;
        }
        let v = self.replace(val);
        Some(fmt!("-p{}", v))
    }

    /// A URL with its credentials taken out, in the two places URLs carry them.
    ///
    /// # Arguments
    /// * `a` - The candidate.
    fn scrub_url(&mut self, a: &str) -> String {
        let at = match a.find("://") {
            Some(n) => n + 3,
            None    => return a.to_string(),
        };
        let rest = &a[at..];
        let end  = match rest.find(|c| c == '/' || c == '?' || c == '#') {
            Some(n) => n,
            None    => rest.len(),
        };
        let mut out = a[..at].to_string();
        let authority = &rest[..end];
        match authority.rfind('@') {
            Some(u) => {
                let info = &authority[..u];
                let host = &authority[u..];
                match info.find(':') {
                    Some(c) => {
                        let v = self.replace(&info[c + 1..]);
                        out.push_str(&info[..c + 1]);
                        out.push_str(&v);
                    },
                    None => {
                        if secret_prefix_at(info, 0).is_some() {
                            let v = self.replace(info);
                            out.push_str(&v);
                        } else {
                            out.push_str(info);
                        }
                    },
                }
                out.push_str(host);
            },
            None => out.push_str(authority),
        }
        // The query string, where a key is as often carried as in the authority.
        let tail = &rest[end..];
        match tail.find('?') {
            Some(q) => {
                out.push_str(&tail[..q + 1]);
                let (query, frag) = match tail[q + 1..].find('#') {
                    Some(h) => (&tail[q + 1..q + 1 + h], &tail[q + 1 + h..]),
                    None    => (&tail[q + 1..], ""),
                };
                let mut first = true;
                for pair in query.split('&') {
                    if !first {
                        out.push('&');
                    }
                    first = false;
                    match split_assign(pair) {
                        Some((k, v)) if is_name_like(k) && looks_secret_name(k) => {
                            let r = self.replace(v);
                            out.push_str(k);
                            out.push('=');
                            out.push_str(&r);
                        },
                        _ => out.push_str(pair),
                    }
                }
                out.push_str(frag);
            },
            None => out.push_str(tail),
        }
        out
    }

    /// Every run of text that opens with a published key format, taken out.
    ///
    /// # Arguments
    /// * `a` - The candidate.
    fn scrub_prefixes(&mut self, a: &str) -> String {
        let mut out = String::with_capacity(a.len());
        let mut i   = 0usize;
        let bytes   = a.as_bytes();
        while i < a.len() {
            let boundary = i == 0 || is_boundary(bytes[i - 1]);
            if boundary && secret_prefix_at(a, i).is_some() {
                let rest = &a[i..];
                let j    = i + match rest.find(is_run_end) {
                    Some(n) => n,
                    None    => rest.len(),
                };
                match a.get(i..j) {
                    Some(run) => {
                        let r = self.replace(run);
                        out.push_str(&r);
                        i = j;
                        continue;
                    },
                    None => {},
                }
            }
            match a[i..].chars().next() {
                Some(c) => {
                    out.push(c);
                    i += c.len_utf8();
                },
                None => break,
            }
        }
        out
    }

    /// One argument of a vector, with the flag rules that reach across arguments.
    ///
    /// # Arguments
    /// * `a` - The argument.
    fn element(&mut self, a: &str) -> String {
        match self.pending {
            Pend::Value => {
                self.pending = Pend::No;
                return self.replace(a);
            },
            Pend::UserInfo => {
                self.pending = Pend::No;
                return self.userinfo(a);
            },
            Pend::No => {},
        }
        if a.starts_with('-') && !a.contains('=') {
            if looks_secret_name(a) {
                self.pending = Pend::Value;
                return a.to_string();
            }
            if USERINFO_FLAGS.iter().any(|f| *f == norm_name(a)) {
                self.pending = Pend::UserInfo;
                return a.to_string();
            }
        }
        self.scrub(a)
    }

    /// One word of free text, with the punctuation around it put back.
    ///
    /// Free text carries a credential when a refusal quotes the command it
    /// refused -- which is the natural wording, and the way the app's own
    /// refusals are written.  The rules are the argument rules, applied a word
    /// at a time, with one difference: a scheme word between a header name and
    /// its value is kept and the expectation passed on, so
    /// `Authorization: Bearer …` redacts the token rather than the word.
    ///
    /// # Arguments
    /// * `t` - The word, punctuation and all.
    fn token(&mut self, t: &str) -> String {
        let (lead, core, trail) = split_punct(t);
        if core.is_empty() {
            return t.to_string();
        }
        let low  = core.to_lowercase();
        let done = match self.pending {
            Pend::Value if SCHEMES.iter().any(|s| *s == low) => core.to_string(),
            Pend::Value => {
                self.pending = Pend::No;
                self.replace(core)
            },
            Pend::UserInfo => {
                self.pending = Pend::No;
                self.userinfo(core)
            },
            Pend::No => {
                if core.ends_with(':') && SECRET_HEADERS.iter().any(|h| starts_ci(core, h)) {
                    self.pending = Pend::Value;
                    core.to_string()
                // The HTTP schemes, in the spelling a header uses.  Lower case
                // `basic` is an ordinary English word and is left alone; capital
                // `Basic` in the middle of a sentence is a header being quoted.
                } else if low == "bearer" || core == "Basic" || core == "Token" {
                    self.pending = Pend::Value;
                    core.to_string()
                } else if core.starts_with('-') && !core.contains('=')
                    && looks_secret_name(core) {
                    self.pending = Pend::Value;
                    core.to_string()
                } else if core.starts_with('-') && !core.contains('=')
                    && USERINFO_FLAGS.iter().any(|f| *f == norm_name(core)) {
                    self.pending = Pend::UserInfo;
                    core.to_string()
                } else {
                    self.scrub(core)
                }
            },
        };
        fmt!("{}{}{}", lead, done, trail)
    }
}

/// Where a published key format starts at a given offset, and how long it is.
///
/// # Arguments
/// * `s` - The text.
/// * `i` - Where to look.
fn secret_prefix_at(s: &str, i: usize) -> Option<usize> {
    let rest = match s.get(i..) {
        Some(r) => r,
        None    => return None,
    };
    let run = match rest.find(is_run_end) {
        Some(n) => n,
        None    => rest.len(),
    };
    for (p, min) in SECRET_PREFIXES.iter() {
        // The published formats are ASCII, and their case is part of the format.
        if rest.starts_with(p) && run >= p.len() + min {
            return Some(p.len());
        }
    }
    None
}

/// A word split into the punctuation around it and the word itself.
///
/// # Arguments
/// * `t` - The word as it appeared.
fn split_punct(t: &str) -> (&str, &str, &str) {
    // `<` and `>` are deliberately absent: `<redacted>` is spelled with them,
    // and stripping them would make the pass replace its own replacement.
    let lead: &[char]  = &['`', '\'', '"', '(', '[', '{'];
    let trail: &[char] = &['`', '\'', '"', ')', ']', '}', ',', ';', '!', '?'];
    let a = t.trim_start_matches(lead);
    let b = a.trim_end_matches(trail);
    let l = &t[..t.len() - a.len()];
    let r = &a[b.len()..];
    (l, b, r)
}

/// An argument vector with the credential shapes taken out, and a count.
///
/// A courtesy, not a guarantee, and the distinction is worth stating twice: the
/// pass fails **open**, so a secret in an argument no rule recognises is
/// recorded.  An argument vector is visible in `ps` to every process the user
/// owns, so it was never a safe place for a secret; the journal cannot make it
/// one.  What the journal *can* do is never write down the places a caller is
/// entitled to think are private -- the environment and standard input -- and it
/// does not.
///
/// # What is deliberately left alone
///
/// Ambiguous single-letter flags with a *separate* value: `redis-cli -a secret`
/// and `docker login -p secret` are recorded in full, because `ls -a`,
/// `mkdir -p dir`, `cp -p file` and `docker run -p 8080:80` are not credentials
/// and redacting them would damage far more records than it protected.  The
/// attached forms are caught, because `-p8080:80` and `-phunter2` can be told
/// apart by shape.  A flag whose value is a *path* to a credential --
/// `--access-token-file=/etc/tok` -- is also left alone: the path is not the
/// secret, and the file is not something the journal reads.
///
/// # Arguments
/// * `argv` - The program and its arguments, as the page sent them.
///
/// # Returns
/// The vector to record, and how many values something was taken out of.
pub fn redact_argv(argv: &[String]) -> (Vec<String>, u32) {
    let mut p   = Pass::new();
    let mut out = Vec::with_capacity(argv.len());
    for a in argv {
        out.push(p.element(a));
    }
    (out, p.cut)
}

/// Free text with the credential shapes taken out, and a count.
///
/// Every string the journal writes goes through this, because the review of
/// 2026-08-02 got one secret into the file eight times through fields nobody
/// had thought of as free text: a refusal's reason, an error's message, the
/// working directory, the run's own identifier, an environment *key*, a fence
/// path, a mechanism name and the client's build string.  A redaction applied
/// to the fields somebody remembered is a redaction applied to the wrong list,
/// so this is applied at the one place every field passes through:
/// [`Event::body`].
///
/// Whitespace and punctuation are preserved exactly, so a sentence still reads
/// as a sentence.
///
/// # Arguments
/// * `s` - The text.
///
/// # Returns
/// The text to record, and how many values were taken out.
pub fn redact_text(s: &str) -> (String, u32) {
    let mut p   = Pass::new();
    let mut out = String::with_capacity(s.len());
    for part in s.split_inclusive(char::is_whitespace) {
        let (tok, ws) = match part.char_indices().next_back() {
            Some((i, c)) if c.is_whitespace() => (&part[..i], &part[i..]),
            _                                 => (part, ""),
        };
        out.push_str(&p.token(tok));
        out.push_str(ws);
    }
    (out, p.cut)
}

/// Somewhere to put the redacted text while a body is being built, and the
/// running count of what has been taken out of it.
struct Scrub {
    /// How many values have been removed from this entry.
    cut: u32,
}

impl Scrub {

    /// A scrubber that has removed nothing yet.
    fn new() -> Self {
        Self { cut: 0 }
    }

    /// One string, redacted.
    ///
    /// # Arguments
    /// * `s` - The text.
    fn one(&mut self, s: &str) -> Dat {
        let (t, c) = redact_text(s);
        self.cut = self.cut.saturating_add(c);
        Dat::Str(t)
    }

    /// A list of strings, each redacted.
    ///
    /// # Arguments
    /// * `v` - The strings.
    fn many(&mut self, v: &[String]) -> Dat {
        let mut out = Vec::with_capacity(v.len());
        for s in v {
            out.push(self.one(s));
        }
        Dat::List(out)
    }

    /// A list of strings sorted first, so the record is about the grant rather
    /// than about the order it was written in.
    ///
    /// # Arguments
    /// * `v` - The strings.
    fn sorted(&mut self, v: &[String]) -> Dat {
        let mut s = v.to_vec();
        s.sort();
        self.many(&s)
    }

    /// An argument vector, redacted by the rules that reach across arguments.
    ///
    /// # Arguments
    /// * `v` - The vector.
    fn argv(&mut self, v: &[String]) -> Dat {
        let (out, c) = redact_argv(v);
        self.cut = self.cut.saturating_add(c);
        Dat::List(out.into_iter().map(Dat::Str).collect())
    }

    /// An optional string, redacted where there is one.
    ///
    /// # Arguments
    /// * `o` - The string, or nothing.
    fn opt(&mut self, o: &Option<String>) -> Dat {
        match o {
            Some(s) => self.one(s),
            None    => Dat::Empty,
        }
    }
}

// ┌───────────────────────────────────────────────────────────────┐
// │ Where the journal lives                                        │
// └───────────────────────────────────────────────────────────────┘

/// The hand's own journal directory, outside every fence it will ever apply.
///
/// `DAIMOND_HAND_JOURNAL_DIR` overrides it, for an operator keeping the record
/// on a different volume.  Otherwise it is the platform's data directory, which
/// belongs to the hand and to no Diamond -- see the module doc for why that
/// distinction is the whole point.
///
/// # Returns
/// The directory, or an error naming the variable that would have said where it
/// is.  There is deliberately no fallback to the working directory: a journal
/// written somewhere nobody expected is worse than one that refuses to start.
pub fn default_dir() -> Outcome<PathBuf> {
    if let Ok(v) = std::env::var("DAIMOND_HAND_JOURNAL_DIR") {
        if !v.is_empty() {
            return Ok(PathBuf::from(v));
        }
    }
    let tail = Path::new("daimond").join("hand").join("journal");
    match crate::os() {
        "macos" => match std::env::var("HOME") {
            Ok(h) if !h.is_empty() => Ok(Path::new(&h)
                .join("Library")
                .join("Application Support")
                .join(&tail)),
            _ => Err(err!(
                "HOME is not set, so the hand cannot say where its journal \
                belongs. Set DAIMOND_HAND_JOURNAL_DIR.";
                Missing, Configuration, Path)),
        },
        "windows" => match std::env::var("APPDATA") {
            Ok(a) if !a.is_empty() => Ok(Path::new(&a).join(&tail)),
            _ => Err(err!(
                "APPDATA is not set, so the hand cannot say where its journal \
                belongs. Set DAIMOND_HAND_JOURNAL_DIR.";
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
                    say where its journal belongs. Set \
                    DAIMOND_HAND_JOURNAL_DIR.";
                    Missing, Configuration, Path)),
            }
        },
    }
}

/// A path with `.` and `..` resolved textually, and symlinks resolved where the
/// path exists.
///
/// Canonicalisation is attempted first because a symlinked grant pointing at the
/// journal would defeat a purely textual comparison.  Where the path does not
/// exist yet -- a fence root for a directory a command is about to create -- the
/// textual form is all there is, and that residual is noted on
/// [`Journal::check_fence`].
///
/// # Arguments
/// * `p` - The path to settle.
fn settle(p: &Path) -> PathBuf {
    if let Ok(c) = fs::canonicalize(p) {
        return c;
    }
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::CurDir    => {},
            Component::ParentDir => { out.pop(); },
            other                => out.push(other.as_os_str()),
        }
    }
    out
}

/// Whether `child` is `root` or sits beneath it.
///
/// Compared by path component, so `/home/u/database` is not beneath
/// `/home/u/dat`.
///
/// # Arguments
/// * `child` - The path in question.
/// * `root`  - The root it might sit under.
fn is_inside(child: &Path, root: &Path) -> bool {
    let c = settle(child);
    let r = settle(root);
    c == r || c.starts_with(&r)
}

// ┌───────────────────────────────────────────────────────────────┐
// │ The journal                                                    │
// └───────────────────────────────────────────────────────────────┘

/// When an entry reaches the disk.
///
/// See the module doc for the reasoning; the short of it is that `Os` survives
/// the failure that actually happens, and the rest is opt-in.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Durability {
    /// Written to the operating system as each entry is made, not `fsync`ed.
    ///
    /// Survives the hand crashing or being killed.  A power cut may lose the
    /// tail.  This is the default.
    Os,
    /// `fsync`ed after every entry.
    ///
    /// Survives a power cut, and puts a disk round trip in the command loop.
    Sync,
    /// Held in memory until `n` entries have accrued or [`Journal::flush`] is
    /// called.
    ///
    /// **Lossy on a crash**, and lossy in the worst way: what is lost is the last
    /// thing that happened, which is the thing you most want to read afterwards.
    /// For bulk replay only.
    Batched(usize),
}

impl Default for Durability {
    fn default() -> Self {
        Self::Os
    }
}

/// How a journal is set up.
#[derive(Clone, Debug)]
pub struct Cfg {
    /// Where the files live.  Must be outside every fence -- see the module doc.
    pub dir:        PathBuf,
    /// The size at which a file rolls over.
    pub max_bytes:  u64,
    /// When an entry reaches the disk.
    pub durability: Durability,
    /// Where a timestamp comes from.
    pub clock:      Clock,
}

impl Cfg {

    /// A configuration writing to a given directory, with the defaults.
    ///
    /// # Arguments
    /// * `dir` - Where the files live.
    pub fn at<P: AsRef<Path>>(dir: P) -> Self {
        Self {
            dir:        dir.as_ref().to_path_buf(),
            max_bytes:  DEFAULT_MAX_BYTES,
            durability: Durability::default(),
            clock:      Clock::default(),
        }
    }
}

/// How far a chain has got: the next sequence number and the head hash.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Chain {
    /// The sequence number the next entry will carry.
    pub seq:  u64,
    /// The hash the next entry will point at.
    pub head: String,
}

impl Chain {

    /// The state a chain starts in, pointing at nothing.
    pub fn genesis() -> Self {
        Self {
            seq:  0,
            head: GENESIS.to_string(),
        }
    }
}

/// The append-only record.
///
/// Deliberately neither `Clone` nor shareable: one writer, one file, one chain.
/// A second writer would interleave entries and the `prev` links would stop
/// meaning what they say.
pub struct Journal {
    /// How it was set up.
    cfg:     Cfg,
    /// The file being appended to.
    file:    File,
    /// Its path.
    path:    PathBuf,
    /// Its index in the rotation.
    idx:     u32,
    /// How far the chain has got.
    chain:   Chain,
    /// How many bytes the current file holds, including anything buffered.
    bytes:   u64,
    /// The UTC day the current file was opened on.
    day:     i64,
    /// Entries written but not yet handed to the operating system.
    buf:     String,
    /// How many entries `buf` holds.
    pending: usize,
    /// The exclusive lock on the directory, held for as long as this is.
    ///
    /// Kept as a field and never read: dropping it closes the descriptor, and
    /// closing the descriptor is what releases the lock.  One writer, one file,
    /// one chain -- the review interleaved two hands on one directory and broke
    /// the chain permanently, and Chrome will launch more than one host.
    _lock:   File,
}

impl Journal {

    /// Opens the journal, continuing whatever chain is already there.
    ///
    /// Only the newest file is read, which is what resuming needs; checking the
    /// whole history is [`verify_dir`]'s job and not something to do on every
    /// launch.  Where that newest file does not verify to its end -- a torn write
    /// from a kill, or an edit -- the damaged file is **left exactly as it is**
    /// and a fresh one is started whose first entry records the break.
    /// Truncating the evidence to tidy up would be the one unforgivable thing a
    /// journal could do.
    ///
    /// # Arguments
    /// * `cfg` - Where the files live and how they are written.
    ///
    /// # Returns
    /// The open journal, or an error where the directory cannot be made or read.
    pub fn open(cfg: Cfg) -> Outcome<Self> {
        res!(ensure_dir(&cfg.dir));
        let now = res!(cfg.clock.now_ms());
        // The journal's own furniture is moved aside where it is not a plain
        // file, before anything depends on being able to open it.  A directory
        // named `lock` or `head.json` would otherwise stop the hand for good,
        // which is the shape of failure the review found and named.
        let mut told = res!(clear_furniture(&cfg.dir, now));
        let lock = res!(take_lock(&cfg.dir));

        let mark = res!(read_mark(&cfg.dir));

        // Anything named like a journal file that the journal did not write is
        // moved aside before a single byte is appended, so the writer's idea of
        // "the newest file" is never steered by a plant.
        let mut surv = res!(survey(&cfg.dir));
        let vouched  = match &mark {
            MarkState::At(m) => Some(m.files),
            _                => None,
        };
        let mut keep = Vec::new();
        for (idx, path) in surv.files.drain(..) {
            match vouched {
                Some(v) if idx > v => surv.stray.push((path, Shape::File)),
                _                  => keep.push((idx, path)),
            }
        }
        for (path, shape) in surv.stray.iter() {
            let to = res!(quarantine(path, now));
            told.push(Event::Stray {
                name:     match path.file_name() {
                    Some(n) => n.to_string_lossy().to_string(),
                    None    => path.to_string_lossy().to_string(),
                },
                shape:    shape.name().to_string(),
                moved_to: to,
            });
        }

        // Where the record had got to, as the files say it.
        //
        // The newest file with anything in it is the one that says so.  A newer
        // *empty* one is a file created a moment before the hand died, and
        // reading the chain from it would say the history had gone back to
        // nothing -- a false alarm on a log whose whole value is that its alarms
        // mean something.
        let mut at = None;
        for (i, (_, p)) in keep.iter().enumerate() {
            let len = match fs::metadata(p) {
                Ok(m)  => m.len(),
                Err(_) => 0,
            };
            if len > 0 {
                at = Some(i);
            }
        }
        let (found, scan) = match at.and_then(|i| keep.get(i)) {
            None            => (Chain::genesis(), None),
            Some((_, path)) => {
                let s = res!(scan_file(path));
                (s.chain.clone(), Some(s))
            },
        };
        let damaged = match &scan {
            Some(s) => s.torn_bytes > 0 || s.broken_at.is_some(),
            None    => false,
        };

        // And where the mark says it had got to, which the files cannot shorten.
        let (start, gap) = match &mark {
            MarkState::At(m) => {
                if found.seq < m.seq {
                    (Chain { seq: m.seq, head: m.head.clone() }, Some(fmt!(
                        "the record reaches entry {} and the mark vouches for {}, \
                        so {} entries have been removed from the end of the \
                        history", found.seq, m.seq, m.seq - found.seq)))
                } else if found.seq == m.seq && found.head != m.head {
                    (Chain { seq: m.seq, head: m.head.clone() }, Some(
                        "the record is the length the mark vouches for and does \
                        not end in the entry it names, so the history has been \
                        rewritten".to_string()))
                } else {
                    (found.clone(), None)
                }
            },
            MarkState::Damaged(why) => (found.clone(), Some(fmt!(
                "the high-water mark is there and {}, so nothing vouches for how \
                far the record had got", why))),
            MarkState::Absent => {
                if found.seq > 0 {
                    (found.clone(), Some(
                        "the high-water mark is missing, so nothing vouches for \
                        how far the record had got".to_string()))
                } else {
                    (found.clone(), None)
                }
            },
        };

        // A damaged file is left exactly as it is and a new one started, and so
        // is a file the mark says has lost entries: appending to either would
        // put a break in the middle of a file rather than at a boundary a reader
        // can see.
        let fresh = keep.is_empty() || damaged || gap.is_some();
        let (idx, path, bytes, day) = if fresh {
            let highest = keep.last().map(|(n, _)| *n);
            let vouched = match &mark {
                MarkState::At(m) => Some(m.files),
                _                => None,
            };
            let next = match (highest, vouched) {
                (None,    None)    => 0,
                (None,    Some(v)) => if v == 0 { 0 } else { res!(next_idx(v)) },
                (Some(h), None)    => res!(next_idx(h)),
                (Some(h), Some(v)) => res!(next_idx(h.max(v))),
            };
            let path = cfg.dir.join(file_name(next));
            (next, path, 0u64, day_of(now))
        } else {
            match keep.last() {
                Some((n, p)) => {
                    // A file resumed on a later day takes its day from its last
                    // entry, so the rotation the doc describes actually happens
                    // when the hand was not running as the day turned.
                    let (bytes, when) = match (&scan, at == Some(keep.len() - 1)) {
                        // The newest file is the one the chain was read from.
                        (Some(s), true) => (s.bytes, match s.last_ts {
                            Some(t) => t,
                            None    => now,
                        }),
                        // The newest file is empty, so it is where the next
                        // entry goes and it carries no day of its own yet.
                        _ => (0u64, now),
                    };
                    (*n, p.clone(), bytes, day_of(when))
                },
                None => (0, cfg.dir.join(file_name(0)), 0u64, day_of(now)),
            }
        };

        let file = res!(open_append(&path));
        let mut j = Self {
            cfg,
            file,
            path,
            idx,
            chain: start,
            bytes,
            day,
            buf:     String::new(),
            pending: 0,
            _lock:   lock,
        };

        // The mark is written before the first entry, so the window in which a
        // fresh directory has files and no mark is as short as it can be.
        res!(j.stamp());

        for ev in told.iter() {
            res!(j.append(ev));
        }
        if damaged {
            if let Some(s) = &scan {
                if let Some((n, _)) = at.and_then(|i| keep.get(i)) {
                    res!(j.append(&Event::Rotated {
                        from_file:  file_name(*n),
                        from_seq:   found.seq.saturating_sub(1),
                        from_entry: found.head.clone(),
                        torn_bytes: s.torn_bytes,
                        broken_at:  s.broken_at,
                    }));
                }
            }
        }
        if let Some(note) = gap {
            let (eseq, ehead) = match &mark {
                MarkState::At(m) => (m.seq, m.head.clone()),
                _                => (found.seq, found.head.clone()),
            };
            res!(j.append(&Event::Gap {
                expect_seq:   eseq,
                expect_entry: ehead,
                found_seq:    found.seq,
                found_entry:  found.head.clone(),
                note,
            }));
        }
        Ok(j)
    }

    /// Appends an event and returns its entry hash.
    ///
    /// # Arguments
    /// * `ev` - What happened.
    ///
    /// # Returns
    /// The new head of the chain, which a caller may publish, or an error where
    /// the event has no canonical form or the file cannot be written.
    pub fn append(&mut self, ev: &Event) -> Outcome<String> {
        let ts = res!(self.cfg.clock.now_ms());
        res!(self.maybe_rotate(ts));
        let hash = res!(self.push(ts, ev));
        let due = match self.cfg.durability {
            Durability::Os | Durability::Sync => true,
            Durability::Batched(n)            => self.pending >= n.max(1),
        };
        if due {
            res!(self.flush());
        }
        Ok(hash)
    }

    /// Hands everything buffered to the operating system, and to the disk where
    /// [`Durability::Sync`] was asked for.
    ///
    /// # Returns
    /// An error where the write fails.
    pub fn flush(&mut self) -> Outcome<()> {
        if !self.buf.is_empty() {
            res!(self.file.write_all(self.buf.as_bytes()), IO, File);
            self.buf.clear();
            self.pending = 0;
        }
        res!(self.file.flush(), IO, File);
        if let Durability::Sync = self.cfg.durability {
            res!(self.file.sync_data(), IO, File);
        }
        res!(self.reachable());
        res!(self.stamp());
        Ok(())
    }

    /// Refuses to call an entry written where nothing can read it back.
    ///
    /// A descriptor outlives the name it was opened by.  After the journal
    /// directory was removed mid-run the review saw `append` return `Ok` and the
    /// refusal it had just recorded vanish -- the write reached an inode with no
    /// path to it.  Under "journal before acting" that is not a cosmetic defect:
    /// the caller acts on the strength of an entry that does not exist.
    ///
    /// # Returns
    /// An error where the file the journal holds open is no longer the file its
    /// own path names.
    fn reachable(&self) -> Outcome<()> {
        let named = match fs::metadata(&self.path) {
            Ok(m)  => m,
            Err(e) => return Err(err!(e,
                "The journal wrote to '{}' and that path no longer names a file, \
                so the entry has reached nothing anybody can read back.",
                self.path.display();
                IO, File, Path)),
        };
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let held = res!(self.file.metadata(), IO, File);
            if held.dev() != named.dev() || held.ino() != named.ino() {
                return Err(err!(
                    "The journal is writing to a file that '{}' no longer names, \
                    so the entry has reached nothing anybody can read back.",
                    self.path.display();
                    IO, File, Path, Security));
            }
        }
        #[cfg(not(unix))]
        {
            if named.len() < self.bytes {
                return Err(err!(
                    "The file at '{}' is shorter than the journal has written to \
                    it, so the entry has reached nothing anybody can read back.",
                    self.path.display();
                    IO, File, Path));
            }
        }
        Ok(())
    }

    /// Writes the high-water mark, so the record cannot be shortened silently.
    ///
    /// Written *after* the entry, never before: the mark is a lower bound on
    /// what must exist, so a crash between the two leaves the files ahead of the
    /// mark, which is recoverable, rather than the mark ahead of the files,
    /// which would read as tampering.
    fn stamp(&self) -> Outcome<()> {
        let sync = matches!(self.cfg.durability, Durability::Sync);
        write_mark(&self.cfg.dir, &Mark {
            seq:   self.chain.seq,
            files: self.idx,
            head:  self.chain.head.clone(),
        }, sync)
    }

    /// Builds one entry and buffers it, advancing the chain.
    ///
    /// Shared by [`Journal::append`] and the rotation entry, so a rolled file's
    /// first line is chained by exactly the same code as every other line.
    ///
    /// # Arguments
    /// * `ts` - The instant to stamp it with.
    /// * `ev` - What happened.
    fn push(&mut self, ts: i64, ev: &Event) -> Outcome<String> {
        let body = res!(ev.body());
        let line = res!(build_line(self.chain.seq, ts, ev.kind(), &body, &self.chain.head));
        let hash = match entry_hash_of(&line) {
            Some(h) => h.to_string(),
            None    => return Err(err!(
                "The entry just built does not end in a hash, which is a fault \
                in the journal itself rather than in what it was asked to \
                record.";
                Bug, Encode)),
        };
        self.buf.push_str(&line);
        self.buf.push('\n');
        self.bytes      += (line.len() + 1) as u64;
        self.pending    += 1;
        self.chain.seq  += 1;
        self.chain.head  = hash.clone();
        Ok(hash)
    }

    /// Starts a new file where the current one is full or the UTC day has turned.
    ///
    /// # Arguments
    /// * `ts` - The instant the next entry will carry.
    fn maybe_rotate(&mut self, ts: i64) -> Outcome<()> {
        let full = self.bytes >= self.cfg.max_bytes;
        let aged = day_of(ts) != self.day;
        if !full && !aged {
            return Ok(());
        }
        // Nothing to roll where the file is still empty; rolling would produce a
        // file whose only content is the note saying it was produced.
        if self.bytes == 0 {
            self.day = day_of(ts);
            return Ok(());
        }
        res!(self.flush());

        let ev = Event::Rotated {
            from_file:  file_name(self.idx),
            from_seq:   self.chain.seq.saturating_sub(1),
            from_entry: self.chain.head.clone(),
            torn_bytes: 0,
            broken_at:  None,
        };

        self.idx   = res!(next_idx(self.idx));
        self.path  = self.cfg.dir.join(file_name(self.idx));
        self.file  = res!(open_append(&self.path));
        self.bytes = 0;
        self.day   = day_of(ts);

        // The head entry stitches the files together, and is chained like any
        // other, so the boundary is not a special case for the verifier.
        res!(self.push(ts, &ev));
        res!(self.flush());
        Ok(())
    }

    /// Refuses a fence that would let a command reach the journal.
    ///
    /// This is the defensive check the module doc argues for.  A grant of write
    /// access over the journal is a grant to rewrite the record of what the grant
    /// was used for, and no amount of hashing survives it, so the hand declines
    /// to run the command at all rather than run it and record it somewhere the
    /// command can edit.
    ///
    /// Read-only grants are refused too.  The journal names every command every
    /// Diamond has run; handing one Diamond a reader over that crosses the
    /// compartment boundary the fence exists to draw.
    ///
    /// A root that is not absolute is refused rather than compared, because a
    /// comparison that cannot be resolved must not be allowed to pass quietly.
    ///
    /// Residual: a root that does not exist yet is compared textually, so a
    /// symlink created between this check and the command's first write is not
    /// caught here.  [`Journal::fence_guard`] closes that, by denying the journal
    /// root outright at the layer the kernel enforces.
    ///
    /// # Arguments
    /// * `fence` - The specification about to be applied.
    ///
    /// # Returns
    /// An error naming the offending root, or nothing.
    pub fn check_fence(&self, fence: &FenceSpec) -> Outcome<()> {
        check_fence_at(&self.cfg.dir, fence)
    }

    /// The same fence with the journal root denied outright.
    ///
    /// Belt and braces over [`Journal::check_fence`]: that one refuses a grant
    /// naming the journal, this one makes sure the kernel would refuse the access
    /// even if a root were widened later or reached through a link.
    ///
    /// # Arguments
    /// * `fence` - The specification to harden.
    pub fn fence_guard(&self, fence: &FenceSpec) -> FenceSpec {
        let mut out = fence.clone();
        let dir     = self.cfg.dir.to_string_lossy().to_string();
        if !out.deny.iter().any(|d| d == &dir) {
            out.deny.push(dir);
        }
        out
    }

    /// The file currently being appended to.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The directory the record lives in.
    pub fn dir(&self) -> &Path {
        &self.cfg.dir
    }

    /// How far the chain has got: the next sequence number and the head hash.
    pub fn chain(&self) -> &Chain {
        &self.chain
    }
}

impl Drop for Journal {
    /// Hands anything buffered over on the way out, and moves the mark with it.
    ///
    /// A best effort: a failure here has nowhere to be reported, which is one
    /// more reason [`Durability::Os`] rather than [`Durability::Batched`] is the
    /// default.
    fn drop(&mut self) {
        if !self.buf.is_empty() {
            let _ = self.file.write_all(self.buf.as_bytes());
            let _ = self.file.flush();
            self.buf.clear();
            self.pending = 0;
        }
        let _ = self.stamp();
    }
}

/// The next index in the rotation, or a refusal to leave the name format.
///
/// # Arguments
/// * `idx` - The index now in use.
fn next_idx(idx: u32) -> Outcome<u32> {
    if idx >= MAX_IDX {
        return Err(err!(
            "The journal has reached '{}', the last name its format allows. The \
            next file would be named outside the format, where no verifier would \
            ever read it, so the hand stops instead. Archive the directory and \
            start a fresh one.", file_name(idx);
            LimitReached, File, Path));
    }
    Ok(idx + 1)
}

/// Takes the directory's exclusive lock, or says who has it.
///
/// `flock` through `std::fs::File::try_lock`, which is safe Rust and needs no
/// dependency, and which the platform releases when the descriptor closes --
/// including when the process dies, which a lock file holding a process id does
/// not manage.  The lock is per open file description, so two journals in one
/// process contend exactly as two processes do.
///
/// # Arguments
/// * `dir` - The journal directory.
fn take_lock(dir: &Path) -> Outcome<File> {
    let path = dir.join(LOCK_FILE);
    let mut o = OpenOptions::new();
    o.create(true).write(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600);
    }
    let f = res!(o.open(&path), IO, File, Path);
    // A held lock is held until its owner goes away, so a lock that is genuinely
    // another hand's is still refused after the last try.  What the tries are
    // for is the other thing that holds a descriptor briefly: a `fork` anywhere
    // in the process duplicates every open descriptor until the matching `exec`
    // closes it, and the hand forks for every command it runs.  Refusing to
    // journal because a sibling command was starting would be a fault invented
    // by the fix.
    let mut last = None;
    for n in 0..LOCK_TRIES {
        match f.try_lock() {
            Ok(())                                 => return Ok(f),
            Err(std::fs::TryLockError::WouldBlock) => last = None,
            Err(std::fs::TryLockError::Error(e))   => last = Some(e),
        }
        if n + 1 < LOCK_TRIES {
            std::thread::sleep(std::time::Duration::from_millis(LOCK_WAIT_MS));
        }
    }
    match last {
        Some(e) => Err(err!(e,
            "The journal's lock at '{}' cannot be taken, and the hand will not \
            write a record it cannot claim sole authorship of.", path.display();
            IO, Lock, File)),
        None => Err(err!(
            "Another hand is already writing the journal at '{}'. Two writers \
            would interleave their entries and the chain would stop meaning what \
            it says, so this one will not start.", dir.display();
            Conflict, Lock, File)),
    }
}

/// Moves the journal's own furniture aside where it is not a plain file.
///
/// The lock, the mark and the mark's temporary file are opened by name on every
/// launch.  A directory or a symbolic link with one of those names makes the
/// open fail, and "journal before acting" turns a failed open into a hand that
/// can never run anything again -- a denial of service any process running as
/// the user could arrange with one `mkdir`.
///
/// # Arguments
/// * `dir` - The journal directory.
/// * `now` - The instant, for the name the stray is given.
///
/// # Returns
/// An event for each thing moved, to be recorded once the journal is open.
fn clear_furniture(dir: &Path, now: i64) -> Outcome<Vec<Event>> {
    let mut out = Vec::new();
    for name in [LOCK_FILE, MARK_FILE, MARK_TMP] {
        let path = dir.join(name);
        let md = match fs::symlink_metadata(&path) {
            Ok(m)  => m,
            Err(_) => continue,
        };
        if md.file_type().is_file() {
            continue;
        }
        let shape = if md.file_type().is_dir() { Shape::Directory } else { Shape::Other };
        let to    = res!(quarantine(&path, now));
        out.push(Event::Stray {
            name:     name.to_string(),
            shape:    shape.name().to_string(),
            moved_to: to,
        });
    }
    Ok(out)
}

/// Moves something named like a journal file out of the way, without losing it.
///
/// # Arguments
/// * `path` - What was found.
/// * `ts`   - The instant, so two of the same name do not collide.
///
/// # Returns
/// What it is now called.
fn quarantine(path: &Path, ts: i64) -> Outcome<String> {
    let name = match path.file_name() {
        Some(n) => n.to_string_lossy().to_string(),
        None    => return Err(err!(
            "'{}' has no file name to move.", path.display(); Bug, Path)),
    };
    let dir = match path.parent() {
        Some(d) => d.to_path_buf(),
        None    => return Err(err!(
            "'{}' has no directory to move within.", path.display(); Bug, Path)),
    };
    let mut to   = fmt!("{}{}.{}", STRAY_STEM, name, ts);
    let mut nth  = 0u32;
    while dir.join(&to).exists() {
        nth += 1;
        to = fmt!("{}{}.{}.{}", STRAY_STEM, name, ts, nth);
        if nth > 1_000 {
            return Err(err!(
                "'{}' cannot be moved aside: a thousand names like it are taken.",
                path.display(); File, Path));
        }
    }
    res!(fs::rename(path, dir.join(&to)), IO, File, Path);
    Ok(to)
}

/// Refuses a fence that would let a command reach a journal directory.
///
/// Split out from [`Journal::check_fence`] so the rule can be applied before a
/// journal has been opened, and so it can be tested on its own.
///
/// # Arguments
/// * `dir`   - Where the journal lives.
/// * `fence` - The specification about to be applied.
pub fn check_fence_at(dir: &Path, fence: &FenceSpec) -> Outcome<()> {
    for (kind, roots) in [("rw", &fence.rw), ("ro", &fence.ro)] {
        for r in roots.iter() {
            let p = Path::new(r);
            if !p.is_absolute() {
                return Err(err!(
                    "The fence names '{}' as a {} root, which is not an absolute \
                    path. The hand cannot tell whether it covers the journal at \
                    '{}', and a comparison it cannot make is not one it will \
                    assume passed.", r, kind, dir.display();
                    Invalid, Input, Path, Security));
            }
            if is_inside(dir, p) {
                return Err(err!(
                    "The fence grants '{}' access to '{}', and the journal lives \
                    at '{}', inside it. A command that can reach its own record \
                    can delete the entry that says it was refused, so the hand \
                    will not run under this fence. Move the journal, or narrow \
                    the grant.", kind, r, dir.display();
                    Invalid, Input, Path, Security));
            }
        }
    }
    Ok(())
}

/// Restricts a journal directory to its owner, where the platform has the notion.
///
/// # Arguments
/// * `dir` - The directory the journal made for itself.
#[cfg(unix)]
fn tighten(dir: &Path) -> Outcome<()> {
    use std::os::unix::fs::PermissionsExt;
    let md = res!(fs::metadata(dir), IO, File, Path);
    let mut perm = md.permissions();
    perm.set_mode(0o700);
    res!(fs::set_permissions(dir, perm), IO, File, Path);
    Ok(())
}

/// Restricts a journal directory to its owner, where the platform has the notion.
///
/// # Arguments
/// * `dir` - The directory the journal made for itself.
#[cfg(not(unix))]
fn tighten(_dir: &Path) -> Outcome<()> {
    Ok(())
}

/// Whether a directory holds nothing but the journal's own furniture.
///
/// The test for "may this be tightened to 0700": a directory the journal
/// plainly owns.  `DAIMOND_HAND_JOURNAL_DIR` is an operator's variable and can
/// name anything, and the old code chmodded whatever it named -- point it at a
/// home directory and the home directory became 0700.
///
/// # Arguments
/// * `dir` - The directory.
fn is_ours(dir: &Path) -> Outcome<bool> {
    let rd = res!(fs::read_dir(dir), IO, File, Path);
    for ent in rd {
        let ent  = res!(ent, IO, File);
        let name = ent.file_name().to_string_lossy().to_string();
        // `root.txt` counts, because the hand puts it here and the installer
        // writes it here. Without it, the directory the documented install
        // produces is one the hand refuses to tighten and then refuses to use.
        let mine = (name.starts_with(FILE_STEM) && name.ends_with(FILE_EXT))
            || name.starts_with(STRAY_STEM)
            || name == MARK_FILE
            || name == MARK_TMP
            || name == LOCK_FILE
            || name == crate::ROOT_FILE;
        if !mine {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Whether a directory is readable by anyone but its owner.
///
/// # Arguments
/// * `dir` - The directory.
#[cfg(unix)]
fn too_open(dir: &Path) -> Outcome<bool> {
    use std::os::unix::fs::PermissionsExt;
    let md = res!(fs::metadata(dir), IO, File, Path);
    Ok(md.permissions().mode() & 0o077 != 0)
}

/// Whether a directory is readable by anyone but its owner.
///
/// # Arguments
/// * `dir` - The directory.
#[cfg(not(unix))]
fn too_open(_dir: &Path) -> Outcome<bool> {
    Ok(false)
}

/// Makes sure the journal has a private directory to write in.
///
/// Creates it where it is absent and tightens *that*.  Where it is already
/// there, it is tightened only if it holds nothing but the journal's own files;
/// otherwise a directory open to other users is a refusal, naming the variable
/// that chose it, rather than a silent re-permissioning of somebody's data.
///
/// # Arguments
/// * `dir` - Where the journal is to live.
fn ensure_dir(dir: &Path) -> Outcome<()> {
    if dir.is_dir() {
        if res!(is_ours(dir)) {
            res!(tighten(dir));
            return Ok(());
        }
        if res!(too_open(dir)) {
            return Err(err!(
                "The journal directory '{}' is readable by other users and \
                holds files the journal did not write, so the hand will not \
                tighten it -- that would re-permission your files, and leaving \
                it puts the record of every command every Diamond ran where \
                others can read it. Fix: chmod 700 '{}', or point \
                DAIMOND_HAND_JOURNAL_DIR at a directory of its own.",
                dir.display(), dir.display();
                Invalid, Configuration, Path, Security));
        }
        return Ok(());
    }
    if let Some(p) = dir.parent() {
        if !p.as_os_str().is_empty() {
            res!(fs::create_dir_all(p), IO, File, Path);
        }
    }
    match fs::create_dir(dir) {
        Ok(())                                                        => {},
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {},
        Err(e) => return Err(err!(e, "Creating '{}'.", dir.display(); IO, File, Path)),
    }
    res!(tighten(dir));
    Ok(())
}

/// Opens a journal file for appending, creating it readable by nobody else.
///
/// The mode is set at creation *and* after, because the flag only applies to a
/// file this call brings into being and a file left behind by an older build
/// would keep whatever the umask gave it.  0664 was what the review found: only
/// the directory's own 0700 stood between the record and every other user.
///
/// # Arguments
/// * `path` - The file.
fn open_append(path: &Path) -> Outcome<File> {
    let mut o = OpenOptions::new();
    o.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600);
    }
    let f = res!(o.open(path), IO, File, Path);
    res!(make_private(path));
    Ok(f)
}

/// Creates or replaces a file readable by nobody else.
///
/// # Arguments
/// * `path` - The file.
fn create_private(path: &Path) -> Outcome<File> {
    let mut o = OpenOptions::new();
    o.create(true).write(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600);
    }
    let f = res!(o.open(path), IO, File, Path);
    res!(make_private(path));
    Ok(f)
}

/// Takes group and world access off a file, where the platform has the notion.
///
/// # Arguments
/// * `path` - The file.
#[cfg(unix)]
fn make_private(path: &Path) -> Outcome<()> {
    use std::os::unix::fs::PermissionsExt;
    let md = res!(fs::metadata(path), IO, File, Path);
    let mut perm = md.permissions();
    if perm.mode() & 0o177 != 0 {
        perm.set_mode(0o600);
        res!(fs::set_permissions(path, perm), IO, File, Path);
    }
    Ok(())
}

/// Takes group and world access off a file, where the platform has the notion.
///
/// # Arguments
/// * `path` - The file.
#[cfg(not(unix))]
fn make_private(_path: &Path) -> Outcome<()> {
    Ok(())
}

/// The name of the journal file with a given index.
///
/// # Arguments
/// * `idx` - Its place in the rotation.
fn file_name(idx: u32) -> String {
    fmt!("{}{:0width$}{}", FILE_STEM, idx, FILE_EXT, width = FILE_DIGITS)
}

/// What a directory holds that is named like a journal file.
///
/// The two lists are the point: the old `journal_files` returned only the names
/// it liked and said nothing about the rest, so a planted name was invisible to
/// every reader while still steering the writer.  Anything named like a journal
/// file and not written by the journal now has somewhere to be reported.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Survey {
    /// Well-formed journal files, in index order.
    pub files: Vec<(u32, PathBuf)>,
    /// Named like a journal file, and not one.
    pub stray: Vec<(PathBuf, Shape)>,
}

/// What a stray turned out to be.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum Shape {
    /// A regular file whose name is outside the format.
    File,
    /// A directory, which would make every read of it an error.
    Directory,
    /// A symbolic link or anything else, which could redirect a write.
    Other,
}

impl Shape {

    /// The word the record uses.
    pub fn name(&self) -> &'static str {
        match self {
            Self::File      => "file",
            Self::Directory => "directory",
            Self::Other     => "other",
        }
    }
}

/// Everything in a directory named like a journal file, sorted into the two.
///
/// A name is a journal file's when it is `hand-`, exactly eight digits,
/// `.jsonl`, **and it is a regular file**.  The last clause is not pedantry: a
/// directory with that name made both `open` and `verify_dir` return an error,
/// which under "journal before acting" means the hand can never act again; and
/// a symbolic link with that name would send the writer wherever the link
/// pointed.
///
/// # Arguments
/// * `dir` - Where the files live.
pub fn survey(dir: &Path) -> Outcome<Survey> {
    let mut files = Vec::new();
    let mut stray = Vec::new();
    let rd = res!(fs::read_dir(dir), IO, File, Path);
    for ent in rd {
        let ent  = res!(ent, IO, File);
        let name = ent.file_name().to_string_lossy().to_string();
        if !name.starts_with(FILE_STEM) || !name.ends_with(FILE_EXT) {
            continue;
        }
        let shape = match ent.file_type() {
            Ok(t) if t.is_file() => None,
            Ok(t) if t.is_dir()  => Some(Shape::Directory),
            Ok(_)                => Some(Shape::Other),
            Err(_)               => Some(Shape::Other),
        };
        if let Some(s) = shape {
            stray.push((ent.path(), s));
            continue;
        }
        let mid = &name[FILE_STEM.len()..name.len() - FILE_EXT.len()];
        if mid.len() != FILE_DIGITS || !mid.bytes().all(|b| b.is_ascii_digit()) {
            stray.push((ent.path(), Shape::File));
            continue;
        }
        match mid.parse::<u32>() {
            Ok(n)  => files.push((n, ent.path())),
            Err(_) => stray.push((ent.path(), Shape::File)),
        }
    }
    files.sort_by_key(|(n, _)| *n);
    stray.sort();
    Ok(Survey { files, stray })
}

/// Every well-formed journal file in a directory, ordered by index.
///
/// # Arguments
/// * `dir` - Where the files live.
pub fn journal_files(dir: &Path) -> Outcome<Vec<(u32, PathBuf)>> {
    Ok(res!(survey(dir)).files)
}

// ┌───────────────────────────────────────────────────────────────┐
// │ The high-water mark                                            │
// └───────────────────────────────────────────────────────────────┘

/// How far the record had got, kept outside the files it describes.
///
/// # Why this exists
///
/// A hash chain answers "has any entry been changed?" and cannot, by
/// construction, answer "is anything missing from the end?" -- a shorter
/// history is a perfectly good chain.  The review of 2026-08-02 deleted the
/// last three files of a twenty-nine file journal and got `Intact`, then let
/// the hand resume and *stay* intact.  Blanking the final file did the same.
/// Any suffix of history erased silently, which is exactly the property a
/// tamper-evident log exists to deny.
///
/// The mark is one line naming the sequence number the next entry will carry,
/// the hash the record had reached, and the highest file index in the rotation.
/// It is written after every flush, so it is a **lower bound**: a history
/// shorter than the mark is a history that lost something, and a history longer
/// than the mark is a crash between an entry reaching the disk and the mark
/// following it.
///
/// # What it does not claim
///
/// The hand runs as the user, so the user's own account can rewrite the mark
/// too.  What the mark buys is that truncation is no longer *free*: it takes
/// two consistent forgeries instead of a `truncate`.  Publishing the head, as
/// `verify/transparency.jsonl` publishes its own, is what turns detectability
/// into evidence, and that step remains the caller's.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Mark {
    /// The sequence number the next entry will carry.
    pub seq:   u64,
    /// The highest file index the rotation has reached.
    pub files: u32,
    /// The hash of the last entry written.
    pub head:  String,
}

/// What reading the mark found.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MarkState {
    /// No mark has been written yet.
    Absent,
    /// A mark is there and does not read back.
    Damaged(String),
    /// A mark is there.
    At(Mark),
}

/// Where the mark lives.
///
/// # Arguments
/// * `dir` - The journal directory.
pub fn mark_path(dir: &Path) -> PathBuf {
    dir.join(MARK_FILE)
}

/// The mark's line, hash and all.
///
/// Hashed exactly as an entry is, so the same `sed` and `sha256sum` idiom
/// checks it and a reader who has learned one has learned both.
///
/// # Arguments
/// * `m` - What to write down.
fn mark_line(m: &Mark) -> Outcome<String> {
    if !is_hex64(&m.head) {
        return Err(err!(
            "The mark's head '{}' is not sixty four hexadecimal characters.", m.head;
            Bug, Invalid, Encode));
    }
    let mut line = String::with_capacity(200);
    line.push_str("{\"seq\":");
    line.push_str(&fmt!("{}", m.seq));
    line.push_str(",\"files\":");
    line.push_str(&fmt!("{}", m.files));
    line.push_str(",\"head\":\"");
    line.push_str(&m.head);
    line.push('"');
    let hash = hex(sha256::digest(line.as_bytes()));
    line.push_str(MARK_TAG);
    line.push_str(&hash);
    line.push_str("\"}");
    Ok(line)
}

/// Reads the mark, saying what it found rather than guessing.
///
/// # Arguments
/// * `dir` - The journal directory.
pub fn read_mark(dir: &Path) -> Outcome<MarkState> {
    let path = mark_path(dir);
    // A mark that cannot be read at all is damaged, not an error: an error here
    // makes `verify_dir` unable to reach a verdict, and under "journal before
    // acting" a verifier that cannot answer is a hand that cannot act.  Planting
    // a *directory* called `head.json` would otherwise do exactly that.
    let text = match fs::read(&path) {
        Ok(b)  => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(MarkState::Absent),
        Err(e) => return Ok(MarkState::Damaged(fmt!("it cannot be read: {}", e))),
    };
    let text = match String::from_utf8(text) {
        Ok(t)  => t,
        Err(_) => return Ok(MarkState::Damaged("the mark is not text".to_string())),
    };
    let line = text.trim_end_matches('\n');
    let suffix = MARK_TAG.len() + HEX_LEN + 2;
    if line.len() < suffix || !line.ends_with("\"}") {
        return Ok(MarkState::Damaged("the mark does not close with a hash".to_string()));
    }
    let cut = line.len() - suffix;
    match line.get(cut..cut + MARK_TAG.len()) {
        Some(t) if t == MARK_TAG => {},
        _ => return Ok(MarkState::Damaged(
            "the mark does not carry its hash where it must".to_string())),
    }
    let claimed = match line.get(cut + MARK_TAG.len()..line.len() - 2) {
        Some(h) if is_hex64(h) => h,
        _ => return Ok(MarkState::Damaged(
            "the mark's hash is not sixty four hexadecimal characters".to_string())),
    };
    let covered = match line.get(..cut) {
        Some(c) => c,
        None    => return Ok(MarkState::Damaged(
            "the mark's hashed text does not end on a character boundary".to_string())),
    };
    if hex(sha256::digest(covered.as_bytes())) != claimed {
        return Ok(MarkState::Damaged(
            "the mark's hash does not match the text it covers".to_string()));
    }
    // Read the three fields by position, exactly as an entry is read.
    let rest = match covered.strip_prefix("{\"seq\":") {
        Some(r) => r,
        None    => return Ok(MarkState::Damaged("the mark does not open with a seq".to_string())),
    };
    let (seq, rest) = match take_int(rest, ",\"files\":") {
        Some(p) => p,
        None    => return Ok(MarkState::Damaged("the mark's seq is not an integer".to_string())),
    };
    let (files, rest) = match take_int(rest, ",\"head\":\"") {
        Some(p) => p,
        None    => return Ok(MarkState::Damaged("the mark's file index is not an integer".to_string())),
    };
    let head = match rest.strip_suffix('"') {
        Some(h) if is_hex64(h) => h.to_string(),
        _ => return Ok(MarkState::Damaged("the mark's head is not a hash".to_string())),
    };
    let seq = match u64::try_from(seq) {
        Ok(n)  => n,
        Err(_) => return Ok(MarkState::Damaged("the mark's seq is negative".to_string())),
    };
    let files = match u32::try_from(files) {
        Ok(n)  => n,
        Err(_) => return Ok(MarkState::Damaged("the mark's file index is out of range".to_string())),
    };
    Ok(MarkState::At(Mark { seq, files, head }))
}

/// Writes the mark, atomically, so a torn write never loses the old one.
///
/// # Arguments
/// * `dir`  - The journal directory.
/// * `m`    - What the record has reached.
/// * `sync` - Whether to wait for the disk.
fn write_mark(dir: &Path, m: &Mark, sync: bool) -> Outcome<()> {
    let line = res!(mark_line(m));
    let tmp  = dir.join(MARK_TMP);
    {
        let mut f = res!(create_private(&tmp));
        res!(f.write_all(line.as_bytes()), IO, File);
        res!(f.write_all(b"\n"), IO, File);
        res!(f.flush(), IO, File);
        if sync {
            res!(f.sync_data(), IO, File);
        }
    }
    res!(fs::rename(&tmp, mark_path(dir)), IO, File, Path);
    Ok(())
}

// ┌───────────────────────────────────────────────────────────────┐
// │ Building and reading a line                                    │
// └───────────────────────────────────────────────────────────────┘

/// Builds one journal line, hash and all.
///
/// The field order is fixed here and nowhere else, and it matters: `entry` must
/// be last so that the text it covers is a prefix of the line, which is what
/// makes the check doable with `sed` and `sha256sum`.
///
/// # Arguments
/// * `seq`  - The entry's place in the chain.
/// * `ts`   - UTC milliseconds since the Unix epoch.
/// * `kind` - The event kind, lower case ASCII from a closed vocabulary.
/// * `body` - The event as canonical JSON.
/// * `prev` - The previous entry's hash, or [`GENESIS`].
fn build_line(seq: u64, ts: i64, kind: &str, body: &str, prev: &str) -> Outcome<String> {
    if kind.is_empty() || !kind.bytes().all(|b| b.is_ascii_lowercase() || b == b'_') {
        return Err(err!(
            "The event kind '{}' is outside the closed vocabulary the line \
            format assumes, so it would need escaping and the reader does not \
            unescape it.", kind;
            Bug, Invalid, Encode));
    }
    if !is_hex64(prev) {
        return Err(err!(
            "The previous entry's hash '{}' is not sixty four hexadecimal \
            characters, so the chain would not read back.", prev;
            Bug, Invalid, Encode));
    }
    let mut line = String::with_capacity(body.len() + 220);
    line.push_str(SEQ_TAG);
    line.push_str(&fmt!("{}", seq));
    line.push_str(TS_TAG);
    line.push_str(&fmt!("{}", ts));
    line.push_str(KIND_TAG);
    line.push_str(kind);
    line.push('"');
    line.push_str(BODY_TAG);
    line.push_str(body);
    line.push_str(PREV_TAG);
    line.push_str(prev);
    line.push('"');
    let hash = hex(sha256::digest(line.as_bytes()));
    line.push_str(ENTRY_TAG);
    line.push_str(&hash);
    line.push_str("\"}");
    Ok(line)
}

/// A digest as lower case hexadecimal.
///
/// # Arguments
/// * `d` - The digest.
fn hex(d: [u8; 32]) -> String {
    B32(d).to_hex_string()
}

/// Whether a string is sixty four lower case hexadecimal characters.
///
/// # Arguments
/// * `s` - The candidate.
fn is_hex64(s: &str) -> bool {
    s.len() == HEX_LEN && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// The hash a line claims for itself, by position rather than by parsing.
///
/// # Arguments
/// * `line` - The line, without its newline.
fn entry_hash_of(line: &str) -> Option<&str> {
    if line.len() < ENTRY_SUFFIX {
        return None;
    }
    let at = line.len() - ENTRY_SUFFIX + ENTRY_TAG.len();
    line.get(at..line.len() - 2)
}

/// What one line of a journal says, once taken apart.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Entry {
    /// Its place in the chain.
    pub seq:   u64,
    /// UTC milliseconds since the Unix epoch.
    pub ts:    i64,
    /// The event kind.
    pub kind:  String,
    /// The event as canonical JSON.
    pub body:  String,
    /// The previous entry's hash.
    pub prev:  String,
    /// This entry's hash.
    pub entry: String,
}

/// Takes one line apart, without a JSON parser.
///
/// Everything is located by fixed markers and fixed widths, so a reader in any
/// language can do the same with two string operations.  Every slice is taken
/// with `get`, so a malformed line is reported rather than splitting a character.
///
/// # Arguments
/// * `line` - One line of a journal file, without its newline.
///
/// # Returns
/// The entry, or an error saying what is wrong with the line.
pub fn parse_line(line: &str) -> Outcome<Entry> {
    if line.len() < ENTRY_SUFFIX + PREV_SUFFIX + SEQ_TAG.len() {
        return Err(err!("The line is too short to be an entry."; Invalid, Decode));
    }
    if !line.starts_with(SEQ_TAG) {
        return Err(err!("The line does not open with {}.", SEQ_TAG; Invalid, Decode));
    }
    if !line.ends_with("\"}") {
        return Err(err!("The line does not close with a hash."; Invalid, Decode));
    }
    // The hash, and the text it covers.
    let cut = line.len() - ENTRY_SUFFIX;
    match line.get(cut..cut + ENTRY_TAG.len()) {
        Some(t) if t == ENTRY_TAG => {},
        _ => return Err(err!(
            "The line does not carry {} where it must.", ENTRY_TAG; Invalid, Decode)),
    }
    let entry = match entry_hash_of(line) {
        Some(h) if is_hex64(h) => h.to_string(),
        _ => return Err(err!(
            "The entry hash is not sixty four hexadecimal characters."; Invalid, Decode)),
    };
    let covered = match line.get(..cut) {
        Some(c) => c,
        None    => return Err(err!(
            "The hashed text does not end on a character boundary."; Invalid, Decode)),
    };
    // The predecessor, which is the last field of the covered text.
    if cut < PREV_SUFFIX {
        return Err(err!("The line carries no predecessor."; Invalid, Decode));
    }
    let pcut = cut - PREV_SUFFIX;
    match covered.get(pcut..pcut + PREV_TAG.len()) {
        Some(t) if t == PREV_TAG => {},
        _ => return Err(err!(
            "The line does not carry {} where it must.", PREV_TAG; Invalid, Decode)),
    }
    let prev = match covered.get(pcut + PREV_TAG.len()..covered.len() - 1) {
        Some(h) if is_hex64(h) => h.to_string(),
        _ => return Err(err!(
            "The previous hash is not sixty four hexadecimal characters."; Invalid, Decode)),
    };
    // The head fields, read forwards.
    let rest = &covered[SEQ_TAG.len()..];
    let (seq, rest) = match take_int(rest, TS_TAG) {
        Some(p) => p,
        None    => return Err(err!("The sequence number is not an integer."; Invalid, Decode)),
    };
    let (ts, rest) = match take_int(rest, KIND_TAG) {
        Some(p) => p,
        None    => return Err(err!("The timestamp is not an integer."; Invalid, Decode)),
    };
    let kind_end = match rest.find('"') {
        Some(n) => n,
        None    => return Err(err!("The kind is not closed."; Invalid, Decode)),
    };
    let kind = rest[..kind_end].to_string();
    let rest = &rest[kind_end + 1..];
    if !rest.starts_with(BODY_TAG) {
        return Err(err!(
            "The line does not carry {} where it must.", BODY_TAG; Invalid, Decode));
    }
    // Where `rest` begins within the covered text, so the body's end can be
    // taken from the predecessor's start.
    let off = covered.len() - rest.len();
    if pcut < off + BODY_TAG.len() {
        return Err(err!("The body runs past the predecessor."; Invalid, Decode));
    }
    let body = match rest.get(BODY_TAG.len()..pcut - off) {
        Some(b) => b.to_string(),
        None    => return Err(err!(
            "The body does not end on a character boundary."; Invalid, Decode)),
    };
    let seq = match u64::try_from(seq) {
        Ok(n)  => n,
        Err(_) => return Err(err!("The sequence number is negative."; Invalid, Decode)),
    };
    Ok(Entry { seq, ts, kind, body, prev, entry })
}

/// Reads a decimal integer up to a marker, returning it and what follows.
///
/// # Arguments
/// * `s`    - The text to read from.
/// * `mark` - The marker the integer runs up to.
fn take_int<'a>(s: &'a str, mark: &str) -> Option<(i64, &'a str)> {
    let end = match s.find(mark) {
        Some(n) => n,
        None    => return None,
    };
    let n = match s[..end].parse::<i64>() {
        Ok(n)  => n,
        Err(_) => return None,
    };
    Some((n, &s[end + mark.len()..]))
}

/// Recomputes an entry's hash from the line it came on.
///
/// # Arguments
/// * `line` - The line, without its newline.
pub fn recompute(line: &str) -> Option<String> {
    if line.len() < ENTRY_SUFFIX {
        return None;
    }
    let cut = line.len() - ENTRY_SUFFIX;
    match line.get(..cut) {
        Some(c) => Some(hex(sha256::digest(c.as_bytes()))),
        None    => None,
    }
}

// ┌───────────────────────────────────────────────────────────────┐
// │ Verification                                                   │
// └───────────────────────────────────────────────────────────────┘

/// What a walk of a journal found.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Verdict {
    /// Every entry chains onto the one before it.
    Intact {
        /// How many entries were read.
        entries: u64,
        /// Where the chain has got to.
        chain:   Chain,
    },
    /// The chain does not hold, and this is the first place it does not.
    Broken {
        /// Which file.
        file:   PathBuf,
        /// Which line of it, counting from one, as an editor would.
        ///
        /// Zero where the fault is not on a line: a missing high-water mark, a
        /// history shorter than the mark vouches for, or a stray file.
        line:   usize,
        /// The sequence number the entry claims, where the line parsed at all.
        seq:    Option<u64>,
        /// What is wrong, in a sentence.
        reason: String,
    },
}

impl Verdict {

    /// Whether the chain held.
    pub fn is_intact(&self) -> bool {
        matches!(self, Self::Intact {..})
    }
}

/// What reading a file for resumption found.
struct Scan {
    /// Where the chain had got to at the last entry that verified.
    chain:      Chain,
    /// How many bytes the good prefix occupies.
    bytes:      u64,
    /// Trailing bytes after the last complete line, from a torn write.
    torn_bytes: u64,
    /// The line at which verification first failed, counting from one.
    broken_at:  Option<u64>,
    /// When the last entry that verified was stamped.
    ///
    /// Carried so that a hand restarted on a later day rolls over rather than
    /// appending into the previous day's file, which is what the rotation rule
    /// says it does.
    last_ts:    Option<i64>,
}

/// Reads a file for resumption, stopping at the first entry that does not hold.
///
/// The file's own first entry supplies the starting point, since resuming does
/// not need to know how the history before this file went.
///
/// # Arguments
/// * `path` - The file.
fn scan_file(path: &Path) -> Outcome<Scan> {
    let text = match res!(read_body(path)) {
        Body::Text(t)     => t,
        Body::NotUtf8 { line } => return Ok(Scan {
            chain:      Chain::genesis(),
            bytes:      0,
            torn_bytes: 0,
            broken_at:  Some(line),
            last_ts:    None,
        }),
    };
    let (whole, torn) = split_tail(&text);

    let mut chain     = Chain::genesis();
    let mut first     = true;
    let mut bytes     = 0u64;
    let mut broken_at = None;
    let mut last_ts   = None;

    for (i, line) in split_lines(whole).into_iter().enumerate() {
        let e = match parse_line(line) {
            Ok(e)  => e,
            Err(_) => { broken_at = Some((i + 1) as u64); break; },
        };
        match recompute(line) {
            Some(h) if h == e.entry => {},
            _ => { broken_at = Some((i + 1) as u64); break; },
        }
        if first {
            chain = Chain { seq: e.seq, head: e.prev.clone() };
            first = false;
        }
        if e.prev != chain.head || e.seq != chain.seq {
            broken_at = Some((i + 1) as u64);
            break;
        }
        last_ts = Some(e.ts);
        chain   = Chain { seq: e.seq + 1, head: e.entry };
        bytes  += (line.len() + 1) as u64;
    }
    Ok(Scan { chain, bytes, torn_bytes: torn, broken_at, last_ts })
}

/// A journal file's contents, or the news that they are not text.
enum Body {
    /// The file, as text.
    Text(String),
    /// The file holds bytes that are not UTF-8.
    NotUtf8 {
        /// Which line they are on, counting from one.
        line: u64,
    },
}

/// Reads a whole file, saying so rather than failing where it is not text.
///
/// A journal that is not text is a journal somebody has interfered with, and
/// the right answer is [`Verdict::Broken`] rather than an error: an error at
/// this layer means the hand can never verify and, under "journal before
/// acting", can never act.
///
/// # Arguments
/// * `path` - The file.
fn read_body(path: &Path) -> Outcome<Body> {
    let bytes = res!(fs::read(path), IO, File, Path, Read);
    match String::from_utf8(bytes) {
        Ok(t)  => Ok(Body::Text(t)),
        Err(e) => {
            let at = e.utf8_error().valid_up_to();
            let n  = e.as_bytes()[..at].iter().filter(|b| **b == b'\n').count();
            Ok(Body::NotUtf8 { line: (n + 1) as u64 })
        },
    }
}

/// Reads a whole file as text.
///
/// Only the tests need this now: everything else goes through [`read_body`],
/// which reports a file that is not text rather than failing on it.
///
/// # Arguments
/// * `path` - The file.
#[cfg(test)]
fn read_text(path: &Path) -> Outcome<String> {
    use std::io::Read;
    let mut f = res!(File::open(path), IO, File, Path);
    let mut s = String::new();
    res!(f.read_to_string(&mut s), IO, File, Read);
    Ok(s)
}

/// Splits text into lines the way `sed` does, and `str::lines` does not.
///
/// `str::lines` strips a trailing `\r`, so a journal converted to CRLF verified
/// as intact in Rust while the documented `sed 's/…//' | sha256sum` mismatched
/// every line.  Two independent checks that disagree is the one failure this
/// product cannot afford, and the shell is the one that is right: a `\r` is a
/// byte of the line and the hash covers it.
///
/// # Arguments
/// * `whole` - The newline-terminated prefix of a file.
fn split_lines(whole: &str) -> Vec<&str> {
    let mut out = Vec::new();
    for l in whole.split_inclusive('\n') {
        out.push(match l.strip_suffix('\n') {
            Some(s) => s,
            None    => l,
        });
    }
    out
}

/// Splits a file's complete lines from any fragment left by a torn write.
///
/// # Arguments
/// * `text` - The file's contents.
///
/// # Returns
/// The newline-terminated prefix, and how many bytes follow it.
fn split_tail(text: &str) -> (&str, u64) {
    match text.rfind('\n') {
        Some(n) => (&text[..n + 1], (text.len() - n - 1) as u64),
        None    => ("", text.len() as u64),
    }
}

/// Walks one journal file and says whether its chain is intact.
///
/// # Arguments
/// * `path` - The file.
/// * `from` - The state the chain should arrive in, or `None` to check the file
///            only against itself, taking its first entry's `prev` and `seq` as
///            the starting point.  A file checked alone can say that nobody has
///            edited it; only [`verify_dir`] can say that it follows on from the
///            file before it.
///
/// # Returns
/// [`Verdict::Intact`] with the state the chain reached, or [`Verdict::Broken`]
/// naming the first line that does not hold.
pub fn verify_file(path: &Path, from: Option<&Chain>) -> Outcome<Verdict> {
    let text = match res!(read_body(path)) {
        Body::Text(t) => t,
        Body::NotUtf8 { line } => return Ok(Verdict::Broken {
            file:   path.to_path_buf(),
            line:   line as usize,
            seq:    None,
            reason: "the file holds bytes that are not text, so it is not a \
                journal any more".to_string(),
        }),
    };
    let (whole, torn) = split_tail(&text);

    let mut chain = match from {
        Some(c) => c.clone(),
        None    => Chain::genesis(),
    };
    let mut first = from.is_none();
    let mut count = 0u64;

    for (i, line) in split_lines(whole).into_iter().enumerate() {
        let no = i + 1;
        if line.is_empty() {
            return Ok(Verdict::Broken {
                file:   path.to_path_buf(),
                line:   no,
                seq:    None,
                reason: "the line is blank, and a journal has no blank lines".to_string(),
            });
        }
        let e = match parse_line(line) {
            Ok(e)  => e,
            Err(m) => return Ok(Verdict::Broken {
                file:   path.to_path_buf(),
                line:   no,
                seq:    None,
                reason: fmt!("the line will not read back: {}", m),
            }),
        };
        match recompute(line) {
            Some(h) if h == e.entry => {},
            Some(h) => return Ok(Verdict::Broken {
                file:   path.to_path_buf(),
                line:   no,
                seq:    Some(e.seq),
                reason: fmt!(
                    "the entry hash does not match the text it covers: the line \
                    says {} and its own bytes give {}", e.entry, h),
            }),
            None => return Ok(Verdict::Broken {
                file:   path.to_path_buf(),
                line:   no,
                seq:    Some(e.seq),
                reason: "the entry hash cannot be recomputed from the line".to_string(),
            }),
        }
        if first {
            chain = Chain { seq: e.seq, head: e.prev.clone() };
            first = false;
        }
        if e.seq != chain.seq {
            return Ok(Verdict::Broken {
                file:   path.to_path_buf(),
                line:   no,
                seq:    Some(e.seq),
                reason: fmt!(
                    "the entry is numbered {} where the chain had reached {}, so \
                    an entry is missing or has been moved", e.seq, chain.seq),
            });
        }
        if e.prev != chain.head {
            return Ok(Verdict::Broken {
                file:   path.to_path_buf(),
                line:   no,
                seq:    Some(e.seq),
                reason: fmt!(
                    "the entry points at {} where the entry before it hashed to \
                    {}, so the chain has been rewritten at or before here",
                    e.prev, chain.head),
            });
        }
        // A `gap` entry is the record saying, in its own words, that history it
        // once vouched for is no longer there.  It is written by
        // [`Journal::open`] and never by anything else, and the whole point of
        // writing it is that the verdict from here on is Broken: the entry
        // cannot be removed without breaking the chain of everything after it,
        // so the loss stays visible across every later restart.
        if e.kind == "gap" {
            return Ok(Verdict::Broken {
                file:   path.to_path_buf(),
                line:   no,
                seq:    Some(e.seq),
                reason: fmt!(
                    "the record itself says history was lost here: {}", e.body),
            });
        }
        chain  = Chain { seq: e.seq + 1, head: e.entry };
        count += 1;
    }

    if torn > 0 {
        return Ok(Verdict::Broken {
            file:   path.to_path_buf(),
            line:   count as usize + 1,
            seq:    None,
            reason: fmt!(
                "{} bytes follow the last complete entry with no newline, which \
                is a torn write or a truncation", torn),
        });
    }
    Ok(Verdict::Intact { entries: count, chain })
}

/// Walks a whole journal directory as one chain.
///
/// The files are taken in index order and the chain is carried across each
/// boundary, so the history verifies end to end.  This is also what catches whole
/// lines being lopped off the end of a rotated file: the next file's first entry
/// no longer follows on by sequence number.
///
/// # Arguments
/// * `dir` - Where the files live.
///
/// # Returns
/// [`Verdict::Intact`] over the whole history, or [`Verdict::Broken`] naming the
/// file and line where it first fails.
pub fn verify_dir(dir: &Path) -> Outcome<Verdict> {
    let surv = res!(survey(dir));

    // Anything named like a journal file and not written by the journal is
    // reported rather than skipped.  The old walk ignored what it did not
    // recognise, which is how one planted name steered every later entry into a
    // file no verifier read.
    if let Some((path, shape)) = surv.stray.first() {
        return Ok(Verdict::Broken {
            file:   path.clone(),
            line:   0,
            seq:    None,
            reason: fmt!(
                "a {} named like a journal file is in the directory and the \
                journal did not write it, so what else is here cannot be taken \
                at face value", shape.name()),
        });
    }

    let mut chain = Chain::genesis();
    let mut total = 0u64;
    for (_, path) in surv.files.iter() {
        match res!(verify_file(path, Some(&chain))) {
            Verdict::Intact { entries, chain: c } => {
                total += entries;
                chain  = c;
            },
            broken => return Ok(broken),
        }
    }

    // And now the part a chain cannot do for itself: is anything missing from
    // the *end*?  A shorter history is a perfectly good chain, so only something
    // kept outside the rotated files can answer it.
    let here = surv.files.last().map(|(n, _)| *n);
    let last = match surv.files.last() {
        Some((_, p)) => p.clone(),
        None         => dir.to_path_buf(),
    };
    match res!(read_mark(dir)) {
        MarkState::Absent => {
            if total > 0 {
                return Ok(Verdict::Broken {
                    file:   mark_path(dir),
                    line:   0,
                    seq:    None,
                    reason: fmt!(
                        "the history holds {} entries and there is no high-water \
                        mark to say whether that is all of them; a chain cannot \
                        detect its own truncation", total),
                });
            }
        },
        MarkState::Damaged(why) => return Ok(Verdict::Broken {
            file:   mark_path(dir),
            line:   0,
            seq:    None,
            reason: fmt!("the high-water mark does not read back: {}", why),
        }),
        MarkState::At(m) => {
            if chain.seq < m.seq {
                return Ok(Verdict::Broken {
                    file:   last,
                    line:   0,
                    seq:    Some(chain.seq),
                    reason: fmt!(
                        "the history reaches entry {} and the high-water mark \
                        vouches for {}, so {} entries have been removed from the \
                        end", chain.seq, m.seq, m.seq - chain.seq),
                });
            }
            if chain.seq == m.seq && chain.head != m.head {
                return Ok(Verdict::Broken {
                    file:   last,
                    line:   0,
                    seq:    Some(chain.seq),
                    reason: fmt!(
                        "the history ends at {} and the high-water mark names \
                        {}, so it has been rewritten", chain.head, m.head),
                });
            }
            if let Some(h) = here {
                if h < m.files {
                    return Ok(Verdict::Broken {
                        file:   dir.join(file_name(m.files)),
                        line:   0,
                        seq:    None,
                        reason: fmt!(
                            "the rotation had reached '{}' and the newest file \
                            here is '{}', so whole files have been removed",
                            file_name(m.files), file_name(h)),
                    });
                }
            }
        },
    }
    Ok(Verdict::Intact { entries: total, chain })
}

// ┌───────────────────────────────────────────────────────────────┐
// │ Tests                                                          │
// └───────────────────────────────────────────────────────────────┘

#[cfg(test)]
mod tests {
    use super::*;

    /// A directory to work in, under the build's own target tree.
    ///
    /// Never `/tmp`: it is a tmpfs here, and a test that fills it takes the
    /// machine's memory with it.
    ///
    /// # Arguments
    /// * `name` - A name unique to the test.
    fn scratch(name: &str) -> Outcome<PathBuf> {
        let base = match std::env::var("CARGO_TARGET_DIR") {
            Ok(v) if !v.is_empty() => PathBuf::from(v),
            _ => PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target"),
        };
        let dir = base.join("journal-tests").join(name);
        if dir.exists() {
            res!(fs::remove_dir_all(&dir));
        }
        res!(fs::create_dir_all(&dir));
        Ok(dir)
    }

    /// A configuration with a stopped clock, so a test owns the day boundary.
    ///
    /// # Arguments
    /// * `dir` - Where the files go.
    fn cfg_at(dir: &Path) -> Cfg {
        let mut c = Cfg::at(dir);
        c.clock = Clock::fixed(1_754_000_000_000);
        c
    }

    /// A request with something in every field the journal reads.
    fn sample_exec() -> Req {
        Req::Exec {
            id:         "run-1".to_string(),
            argv:       vec!["cargo".to_string(), "test".to_string()],
            cwd:        "/home/u/proj".to_string(),
            env:        vec![("PATH".to_string(), "/usr/bin".to_string())],
            stdin:      None,
            timeout_ms: 30_000,
            capture:    Capture::Both,
            fence:      FenceSpec {
                rw:   vec!["/home/u/proj".to_string()],
                ro:   vec!["/usr".to_string()],
                deny: vec!["/home/u/proj/.daimond".to_string()],
                net:  false,
            },
            toolkits: Vec::new(),
        }
    }

    /// Reads a journal file as lines.
    ///
    /// # Arguments
    /// * `path` - The file.
    fn lines_of(path: &Path) -> Outcome<Vec<String>> {
        let text = res!(read_text(path));
        Ok(text.lines().map(|s| s.to_string()).collect())
    }

    /// Writes lines back over a file, newline terminated.
    ///
    /// # Arguments
    /// * `path`  - The file.
    /// * `lines` - What it should now say.
    fn write_lines(path: &Path, lines: &[String]) -> Outcome<()> {
        let mut f = res!(File::create(path), IO, File);
        for l in lines {
            res!(f.write_all(l.as_bytes()), IO, File);
            res!(f.write_all(b"\n"), IO, File);
        }
        Ok(())
    }

    /// Writes a short journal and returns the directory and the file.
    ///
    /// # Arguments
    /// * `name` - A name unique to the test.
    fn seeded(name: &str) -> Outcome<(PathBuf, PathBuf)> {
        let dir   = res!(scratch(name));
        let mut j = res!(Journal::open(cfg_at(&dir)));
        let mechs = vec!["landlock".to_string(), "unshare-net".to_string()];
        match Event::from_req(&sample_exec(), &mechs) {
            Some(ev) => { res!(j.append(&ev)); },
            None     => return Err(err!("The exec request produced no event."; Bug)),
        }
        res!(j.append(&Event::Started { id: "run-1".to_string(), pid: 4242 }));
        res!(j.append(&Event::Ended {
            id:        "run-1".to_string(),
            exit:      0,
            timed_out: false,
            killed:    false,
            out_bytes: 128,
            err_bytes: 0,
        }));
        res!(j.append(&Event::Refused {
            id:     "run-2".to_string(),
            reason: "That path is outside every root this Diamond was granted.".to_string(),
        }));
        res!(j.flush());
        let path = j.path().to_path_buf();
        drop(j);
        Ok((dir, path))
    }

    // ── The good case, so the broken ones mean something ──────────────

    /// A journal written normally verifies, from genesis to its head.
    #[test]
    fn test_a_written_journal_verifies_00() -> Outcome<()> {
        let (dir, path) = res!(seeded("verifies_00"));
        let v = res!(verify_file(&path, Some(&Chain::genesis())));
        assert!(v.is_intact(), "a freshly written journal should verify: {:?}", v);
        match v {
            Verdict::Intact { entries, chain } => {
                assert_eq!(entries, 4);
                assert_eq!(chain.seq, 4);
                assert!(is_hex64(&chain.head));
            },
            other => return Err(err!("Expected Intact, got {:?}", other; Bug)),
        }
        assert!(res!(verify_dir(&dir)).is_intact());
        Ok(())
    }

    /// The entry hash is the SHA-256 of the line's own text up to `,"entry":"`.
    ///
    /// Computed here independently of the journal's own opinion, so the check is
    /// not merely self-consistent.
    #[test]
    fn test_the_entry_hash_covers_the_line_prefix_00() -> Outcome<()> {
        let (_dir, path) = res!(seeded("prefix_00"));
        let lines = res!(lines_of(&path));
        assert_eq!(lines.len(), 4);
        for l in lines.iter() {
            let cut  = l.len() - ENTRY_SUFFIX;
            let want = hex(sha256::digest(l[..cut].as_bytes()));
            let got  = &l[cut + ENTRY_TAG.len()..l.len() - 2];
            assert_eq!(want, got, "the hash must cover exactly the text before it");
        }
        Ok(())
    }

    // ── Tampering: every check proved on input that breaks it ─────────

    /// Editing a middle entry is caught, and that entry is named.
    #[test]
    fn test_a_tampered_middle_line_is_named_00() -> Outcome<()> {
        let (_dir, path) = res!(seeded("middle_00"));
        let mut lines = res!(lines_of(&path));
        // Line two is the `started` entry; move the pid.
        lines[1] = lines[1].replace("\"pid\":4242", "\"pid\":4243");
        assert!(lines[1].contains("4243"), "the tamper must actually have landed");
        res!(write_lines(&path, &lines));

        match res!(verify_file(&path, Some(&Chain::genesis()))) {
            Verdict::Broken { line, seq, reason, .. } => {
                assert_eq!(line, 2, "the verifier must name the line that was edited");
                assert_eq!(seq, Some(1));
                assert!(reason.contains("does not match"), "reason was: {}", reason);
            },
            other => return Err(err!(
                "An edited entry must not verify, but the verdict was {:?}", other; Bug)),
        }
        Ok(())
    }

    /// Editing the last entry is caught too, which is where a lazy verifier
    /// stops looking.
    #[test]
    fn test_a_tampered_last_line_is_named_00() -> Outcome<()> {
        let (_dir, path) = res!(seeded("last_00"));
        let mut lines = res!(lines_of(&path));
        let n = lines.len();
        lines[n - 1] = lines[n - 1].replace("outside every root", "inside every root");
        res!(write_lines(&path, &lines));

        match res!(verify_file(&path, Some(&Chain::genesis()))) {
            Verdict::Broken { line, .. } => assert_eq!(line, n),
            other => return Err(err!(
                "An edited last entry must not verify, got {:?}", other; Bug)),
        }
        Ok(())
    }

    /// Editing an entry *and* recomputing its own hash still breaks the chain,
    /// at the entry after it.  This is the check that earns the word "chain".
    #[test]
    fn test_a_rehashed_middle_line_still_breaks_the_next_00() -> Outcome<()> {
        let (_dir, path) = res!(seeded("rehash_00"));
        let mut lines = res!(lines_of(&path));
        let edited = lines[1].replace("\"pid\":4242", "\"pid\":4243");
        let cut    = edited.len() - ENTRY_SUFFIX;
        let fresh  = hex(sha256::digest(edited[..cut].as_bytes()));
        lines[1]   = fmt!("{}{}{}\"}}", &edited[..cut], ENTRY_TAG, fresh);
        // The doctored line is now internally consistent, which is the premise.
        match recompute(&lines[1]) {
            Some(h) => {
                let claimed = match entry_hash_of(&lines[1]) {
                    Some(c) => c.to_string(),
                    None    => return Err(err!("The doctored line has no hash."; Bug)),
                };
                assert_eq!(h, claimed, "the forgery must be self-consistent to be a test");
            },
            None => return Err(err!("The doctored line will not rehash."; Bug)),
        }
        res!(write_lines(&path, &lines));

        match res!(verify_file(&path, Some(&Chain::genesis()))) {
            Verdict::Broken { line, reason, .. } => {
                assert_eq!(line, 3, "the break must surface at the entry after the forgery");
                assert!(reason.contains("points at"), "reason was: {}", reason);
            },
            other => return Err(err!(
                "A self-consistent forgery must still break the chain, got {:?}", other; Bug)),
        }
        Ok(())
    }

    /// Deleting a middle entry is caught by the sequence number.
    #[test]
    fn test_a_removed_line_is_named_00() -> Outcome<()> {
        let (_dir, path) = res!(seeded("removed_00"));
        let mut lines = res!(lines_of(&path));
        lines.remove(1);
        res!(write_lines(&path, &lines));

        match res!(verify_file(&path, Some(&Chain::genesis()))) {
            Verdict::Broken { line, seq, reason, .. } => {
                assert_eq!(line, 2);
                assert_eq!(seq, Some(2));
                assert!(reason.contains("numbered"), "reason was: {}", reason);
            },
            other => return Err(err!("A deleted entry must be caught, got {:?}", other; Bug)),
        }
        Ok(())
    }

    /// Swapping two entries is caught.
    #[test]
    fn test_a_reordered_pair_is_named_00() -> Outcome<()> {
        let (_dir, path) = res!(seeded("reorder_00"));
        let mut lines = res!(lines_of(&path));
        lines.swap(1, 2);
        res!(write_lines(&path, &lines));

        match res!(verify_file(&path, Some(&Chain::genesis()))) {
            Verdict::Broken { line, .. } => assert_eq!(line, 2),
            other => return Err(err!("Reordering must be caught, got {:?}", other; Bug)),
        }
        Ok(())
    }

    /// A file cut mid-entry is reported as torn, not read as though it were whole.
    #[test]
    fn test_a_torn_final_line_is_named_00() -> Outcome<()> {
        let (_dir, path) = res!(seeded("torn_00"));
        let text = res!(read_text(&path));
        let keep = text.len() - 40;
        let mut f = res!(File::create(&path), IO, File);
        res!(f.write_all(text[..keep].as_bytes()), IO, File);
        drop(f);

        match res!(verify_file(&path, Some(&Chain::genesis()))) {
            Verdict::Broken { reason, .. } => {
                assert!(reason.contains("torn write"), "reason was: {}", reason);
            },
            other => return Err(err!("A torn file must not verify, got {:?}", other; Bug)),
        }
        Ok(())
    }

    /// A line whose body has been lengthened without touching the tail is caught,
    /// which is the case a fixed-offset reader would get wrong.
    #[test]
    fn test_a_lengthened_body_is_caught_00() -> Outcome<()> {
        let (_dir, path) = res!(seeded("lengthen_00"));
        let mut lines = res!(lines_of(&path));
        lines[0] = lines[0].replace("\"cwd\":\"/home/u/proj\"", "\"cwd\":\"/home/u/proj/deeper\"");
        res!(write_lines(&path, &lines));

        match res!(verify_file(&path, Some(&Chain::genesis()))) {
            Verdict::Broken { line, .. } => assert_eq!(line, 1),
            other => return Err(err!("A lengthened body must be caught, got {:?}", other; Bug)),
        }
        Ok(())
    }

    // ── Rotation ──────────────────────────────────────────────────────

    /// The chain carries across a size rotation, and the whole history verifies.
    #[test]
    fn test_the_chain_survives_a_size_rotation_00() -> Outcome<()> {
        let dir = res!(scratch("rotate_size_00"));
        let mut c = cfg_at(&dir);
        c.max_bytes = 900;
        let mut j = res!(Journal::open(c));
        for i in 0..40u32 {
            res!(j.append(&Event::Started { id: fmt!("run-{}", i), pid: 1000 + i }));
        }
        res!(j.flush());
        drop(j);

        let files = res!(journal_files(&dir));
        assert!(files.len() > 1, "the journal should have rolled over, files: {}", files.len());

        let v = res!(verify_dir(&dir));
        assert!(v.is_intact(), "the chain must carry across rotation: {:?}", v);
        match v {
            // Forty events, plus one rotation entry per boundary.
            Verdict::Intact { entries, chain } => {
                assert_eq!(entries as usize, 40 + files.len() - 1);
                assert_eq!(chain.seq, entries);
            },
            other => return Err(err!("Expected Intact, got {:?}", other; Bug)),
        }
        Ok(())
    }

    /// The chain carries across a change of UTC day.
    #[test]
    fn test_the_chain_survives_a_day_rotation_00() -> Outcome<()> {
        let dir = res!(scratch("rotate_day_00"));
        let c   = cfg_at(&dir);
        let clk = c.clock.clone();
        let mut j = res!(Journal::open(c));
        res!(j.append(&Event::Started { id: "a".to_string(), pid: 1 }));
        res!(clk.advance(DAY_MS));
        res!(j.append(&Event::Started { id: "b".to_string(), pid: 2 }));
        res!(j.flush());
        drop(j);

        let files = res!(journal_files(&dir));
        assert_eq!(files.len(), 2, "a change of UTC day must start a new file");
        assert!(res!(verify_dir(&dir)).is_intact());
        Ok(())
    }

    /// Lopping whole entries off the end of a *rotated* file is caught, because
    /// the next file no longer follows on by sequence number.
    #[test]
    fn test_a_truncated_rotated_file_is_named_00() -> Outcome<()> {
        let dir = res!(scratch("rotate_trunc_00"));
        let mut c = cfg_at(&dir);
        c.max_bytes = 900;
        let mut j = res!(Journal::open(c));
        for i in 0..40u32 {
            res!(j.append(&Event::Started { id: fmt!("run-{}", i), pid: 1000 + i }));
        }
        res!(j.flush());
        drop(j);

        let files = res!(journal_files(&dir));
        assert!(files.len() > 1);
        // Drop the last entry of the first file, tidily, newline and all.
        let first = files[0].1.clone();
        let mut lines = res!(lines_of(&first));
        lines.pop();
        res!(write_lines(&first, &lines));

        match res!(verify_dir(&dir)) {
            Verdict::Broken { file, line, reason, .. } => {
                assert_eq!(file, files[1].1, "the break should surface in the next file");
                assert_eq!(line, 1);
                assert!(reason.contains("numbered"), "reason was: {}", reason);
            },
            other => return Err(err!(
                "Truncating a rotated file must be caught, got {:?}", other; Bug)),
        }
        Ok(())
    }

    /// Reopening continues the chain rather than starting a second one.
    #[test]
    fn test_reopening_continues_the_chain_00() -> Outcome<()> {
        let dir = res!(scratch("reopen_00"));
        let head = {
            let mut j = res!(Journal::open(cfg_at(&dir)));
            res!(j.append(&Event::Started { id: "a".to_string(), pid: 1 }));
            res!(j.flush());
            j.chain().clone()
        };
        let mut j = res!(Journal::open(cfg_at(&dir)));
        assert_eq!(j.chain(), &head, "a reopened journal must resume where it stopped");
        res!(j.append(&Event::Started { id: "b".to_string(), pid: 2 }));
        res!(j.flush());
        drop(j);
        assert!(res!(verify_dir(&dir)).is_intact());
        Ok(())
    }

    /// A torn tail found on opening is left alone and recorded, not tidied away.
    #[test]
    fn test_a_torn_tail_is_recorded_not_repaired_00() -> Outcome<()> {
        let dir = res!(scratch("torn_open_00"));
        {
            let mut j = res!(Journal::open(cfg_at(&dir)));
            res!(j.append(&Event::Started { id: "a".to_string(), pid: 1 }));
            res!(j.flush());
        }
        let files  = res!(journal_files(&dir));
        let first  = files[0].1.clone();
        let before = res!(read_text(&first));
        // A kill mid-write leaves a fragment with no newline.
        let fragment = b"{\"seq\":1,\"ts\":17540000";
        let mut f = res!(OpenOptions::new().append(true).open(&first), IO, File);
        res!(f.write_all(fragment), IO, File);
        drop(f);

        let mut j = res!(Journal::open(cfg_at(&dir)));
        res!(j.append(&Event::Started { id: "b".to_string(), pid: 2 }));
        res!(j.flush());
        let live = j.path().to_path_buf();
        drop(j);

        assert_ne!(live, first, "a damaged file must not be appended to");
        let after = res!(read_text(&first));
        assert!(after.starts_with(&before), "the damaged file must be left as it is");
        let lines = res!(lines_of(&live));
        assert!(lines[0].contains("\"kind\":\"rotated\""), "line was: {}", lines[0]);
        assert!(lines[0].contains(&fmt!("\"torn_bytes\":{}", fragment.len())),
            "line was: {}", lines[0]);
        // The new file alone is a sound chain from its own starting point.
        assert!(res!(verify_file(&live, None)).is_intact());
        Ok(())
    }

    // ── Refusals ──────────────────────────────────────────────────────

    /// A refusal is recorded, with its reason, and verifies like anything else.
    #[test]
    fn test_a_refusal_is_recorded_00() -> Outcome<()> {
        let (_dir, path) = res!(seeded("refusal_00"));
        let lines = res!(lines_of(&path));
        let last  = match lines.last() {
            Some(l) => l,
            None    => return Err(err!("The journal is empty."; Bug)),
        };
        assert!(last.contains("\"kind\":\"refused\""));
        assert!(last.contains("outside every root"));
        let e = res!(parse_line(last));
        assert_eq!(e.kind, "refused");
        assert!(e.body.contains("\"id\":\"run-2\""));
        Ok(())
    }

    // ── Where the journal lives ───────────────────────────────────────

    /// A fence that grants write access over the journal is refused.
    #[test]
    fn test_a_journal_inside_a_writable_fence_root_is_refused_00() -> Outcome<()> {
        let dir = res!(scratch("fence_rw_00"));
        let j   = res!(Journal::open(cfg_at(&dir)));

        // The exact mistake the earlier design would have made: the journal
        // sitting inside the directory the daimon is handed a pen for.
        let inside = FenceSpec {
            rw: vec![dir.to_string_lossy().to_string()],
            ..Default::default()
        };
        match j.check_fence(&inside) {
            Ok(()) => return Err(err!(
                "A fence granting write access over the journal must be refused."; Bug)),
            Err(e) => {
                let s = fmt!("{}", e);
                assert!(s.contains("delete the entry"), "message was: {}", s);
            },
        }

        // A parent of the journal is just as bad.
        let parent = match dir.parent() {
            Some(p) => p.to_string_lossy().to_string(),
            None    => return Err(err!("The scratch directory has no parent."; Bug)),
        };
        let above = FenceSpec { rw: vec![parent], ..Default::default() };
        assert!(j.check_fence(&above).is_err(), "a grant above the journal must be refused");

        // A read grant is refused too: it leaks every command every Diamond ran.
        let ro = FenceSpec {
            ro: vec![dir.to_string_lossy().to_string()],
            ..Default::default()
        };
        assert!(j.check_fence(&ro).is_err(), "a read grant over the journal must be refused");
        Ok(())
    }

    /// A fence clear of the journal passes, and a sibling whose name merely
    /// starts the same way is not mistaken for a parent.
    #[test]
    fn test_a_fence_clear_of_the_journal_passes_00() -> Outcome<()> {
        let dir = res!(scratch("fence_ok_00"));
        let j   = res!(Journal::open(cfg_at(&dir)));
        let sibling = fmt!("{}-elsewhere", dir.to_string_lossy());
        let ok = FenceSpec {
            rw:   vec![sibling],
            ro:   vec!["/usr".to_string()],
            deny: vec![],
            net:  false,
        };
        res!(j.check_fence(&ok));
        Ok(())
    }

    /// A relative fence root is refused rather than compared, because a
    /// comparison that cannot be made must not be assumed to have passed.
    #[test]
    fn test_a_relative_fence_root_is_refused_00() -> Outcome<()> {
        let dir = res!(scratch("fence_rel_00"));
        let j   = res!(Journal::open(cfg_at(&dir)));
        let rel = FenceSpec { rw: vec!["proj".to_string()], ..Default::default() };
        match j.check_fence(&rel) {
            Ok(()) => Err(err!("A relative fence root must be refused."; Bug)),
            Err(e) => {
                let s = fmt!("{}", e);
                assert!(s.contains("absolute"), "message was: {}", s);
                Ok(())
            },
        }
    }

    /// The guard adds the journal root to a fence's deny list, once.
    #[test]
    fn test_fence_guard_denies_the_journal_root_00() -> Outcome<()> {
        let dir = res!(scratch("fence_guard_00"));
        let j   = res!(Journal::open(cfg_at(&dir)));
        let g   = j.fence_guard(&FenceSpec::default());
        assert!(g.deny.iter().any(|d| Path::new(d) == dir));
        let g2 = j.fence_guard(&g);
        assert_eq!(g.deny.len(), g2.deny.len(), "the guard must not add the root twice");
        Ok(())
    }

    // ── Secrets ───────────────────────────────────────────────────────

    /// An environment value never reaches the file, and its key does.
    #[test]
    fn test_env_values_never_reach_the_journal_00() -> Outcome<()> {
        let dir = res!(scratch("env_00"));
        let mut j = res!(Journal::open(cfg_at(&dir)));
        // A synthetic value with a credential's shape and none of its danger.
        let value = "NOT-A-REAL-SECRET-abcdefghijklmnopqrstuvwxyz012345"; // allowlist secret
        let req = Req::Exec {
            id:         "run-1".to_string(),
            argv:       vec!["aws".to_string(), "s3".to_string(), "ls".to_string()],
            cwd:        "/home/u".to_string(),
            env:        vec![
                ("AWS_SECRET_ACCESS_KEY".to_string(), value.to_string()),
                ("PATH".to_string(), "/usr/bin".to_string()),
            ],
            stdin:      None,
            timeout_ms: 1000,
            capture:    Capture::Both,
            fence:      FenceSpec::default(),
            toolkits: Vec::new(),
        };
        match Event::from_req(&req, &[]) {
            Some(ev) => { res!(j.append(&ev)); },
            None     => return Err(err!("The exec request produced no event."; Bug)),
        }
        res!(j.flush());
        let path = j.path().to_path_buf();
        drop(j);

        let text = res!(read_text(&path));
        assert!(!text.contains(value), "an environment value must never be written down");
        assert!(text.contains("AWS_SECRET_ACCESS_KEY"), "the key is the accountable part");
        assert!(text.contains("\"env_keys\""));
        Ok(())
    }

    /// Standard input is recorded by length and never by content.
    #[test]
    fn test_stdin_is_recorded_only_by_length_00() -> Outcome<()> {
        let dir = res!(scratch("stdin_00"));
        let mut j = res!(Journal::open(cfg_at(&dir)));
        let given = "passphrase-that-must-not-be-written"; // allowlist secret
        let req = Req::Exec {
            id:         "run-1".to_string(),
            argv:       vec!["gpg".to_string()],
            cwd:        "/home/u".to_string(),
            env:        vec![],
            stdin:      Some(given.to_string()),
            timeout_ms: 1000,
            capture:    Capture::Both,
            fence:      FenceSpec::default(),
            toolkits: Vec::new(),
        };
        match Event::from_req(&req, &[]) {
            Some(ev) => { res!(j.append(&ev)); },
            None     => return Err(err!("The exec request produced no event."; Bug)),
        }
        res!(j.flush());
        let path = j.path().to_path_buf();
        drop(j);

        let text = res!(read_text(&path));
        assert!(!text.contains(given), "standard input must never be written down");
        assert!(text.contains(&fmt!("\"stdin_bytes\":{}", given.len())));
        Ok(())
    }

    /// Credential shapes in the argument vector are taken out and counted.
    #[test]
    fn test_a_credential_shaped_argument_is_redacted_00() -> Outcome<()> {
        // Synthetic strings with published keys' shapes, assembled at run time.
        let key    = fmt!("{}{}", "sk-", "0000000000000000000000000000"); // allowlist secret
        let bearer = fmt!("Authorization: Bearer {}", key);
        let argv = vec![
            "curl".to_string(),
            "-H".to_string(),
            bearer,
            "--token".to_string(),
            "hunter2".to_string(),
            fmt!("--api-key={}", key),
            key.clone(),
            "https://example.com".to_string(),
        ];
        let (out, cut) = redact_argv(&argv);
        assert_eq!(cut, 4, "four arguments carried something worth removing");
        assert_eq!(out[0], "curl");
        assert_eq!(out[1], "-H");
        assert_eq!(out[2], fmt!("Authorization: {}", REDACTED));
        assert_eq!(out[3], "--token");
        assert_eq!(out[4], REDACTED);
        assert_eq!(out[5], fmt!("--api-key={}", REDACTED));
        assert_eq!(out[6], REDACTED);
        assert_eq!(out[7], "https://example.com");
        let joined = out.join(" ");
        assert!(!joined.contains(&key), "the key must not survive the pass");
        assert!(!joined.contains("hunter2"), "the flag's value must not survive the pass");
        Ok(())
    }

    /// The redaction pass leaves an ordinary command alone, because
    /// over-redaction damages the record it is meant to protect.
    #[test]
    fn test_an_ordinary_argument_vector_is_untouched_00() -> Outcome<()> {
        let argv = vec![
            "docker".to_string(),
            "run".to_string(),
            "-p".to_string(),
            "8080:80".to_string(),
            "-u".to_string(),
            "1000".to_string(),
            "alpine".to_string(),
        ];
        let (out, cut) = redact_argv(&argv);
        assert_eq!(cut, 0, "nothing here is a credential");
        assert_eq!(out, argv);
        Ok(())
    }

    /// A redacted argument vector reaches the file redacted, and the record says
    /// that something was removed.
    #[test]
    fn test_a_redacted_argv_reaches_the_file_redacted_00() -> Outcome<()> {
        let dir = res!(scratch("argv_00"));
        let mut j = res!(Journal::open(cfg_at(&dir)));
        let key = fmt!("{}{}", "ghp_", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"); // allowlist secret
        let req = Req::Exec {
            id:         "run-1".to_string(),
            argv:       vec!["gh".to_string(), "auth".to_string(), key.clone()],
            cwd:        "/home/u".to_string(),
            env:        vec![],
            stdin:      None,
            timeout_ms: 1000,
            capture:    Capture::None,
            fence:      FenceSpec::default(),
            toolkits: Vec::new(),
        };
        match Event::from_req(&req, &[]) {
            Some(ev) => { res!(j.append(&ev)); },
            None     => return Err(err!("The exec request produced no event."; Bug)),
        }
        res!(j.flush());
        let path = j.path().to_path_buf();
        drop(j);

        let text = res!(read_text(&path));
        assert!(!text.contains(&key), "a published key shape must not reach the file");
        assert!(text.contains(REDACTED));
        assert!(text.contains("\"redactions\":1"), "the record must say something was removed");
        Ok(())
    }

    // ── The record's own shape ────────────────────────────────────────

    /// The exec entry says which fence mechanisms were actually in force, which
    /// is a different fact from which were asked for.
    #[test]
    fn test_the_exec_entry_records_the_mechanisms_in_force_00() -> Outcome<()> {
        let (_dir, path) = res!(seeded("mechs_00"));
        let lines = res!(lines_of(&path));
        assert!(lines[0].contains("\"mechs\":[\"landlock\",\"unshare-net\"]"),
            "line was: {}", lines[0]);
        assert!(lines[0].contains("\"net\":false"), "line was: {}", lines[0]);
        Ok(())
    }

    /// A body is canonical JSON, so a second implementation gets the same bytes.
    #[test]
    fn test_a_body_is_canonical_json_00() -> Outcome<()> {
        let ev = Event::Refused {
            id:     "x".to_string(),
            reason: "no".to_string(),
        };
        let body = res!(ev.body());
        assert_eq!(body, "{\"id\":\"x\",\"reason\":\"no\",\"redactions\":0}",
            "keys sorted, no spaces, and every body says how much was taken out");
        // Re-canonicalising what was written gives the identical bytes.
        let back = res!(Dat::decode_string(&body));
        assert_eq!(res!(back.json_canonical()), body);
        Ok(())
    }

    /// A reason carrying a quote, a backslash, a newline and a control character
    /// still reads back, and does not become two lines.
    #[test]
    fn test_an_awkward_reason_still_reads_back_00() -> Outcome<()> {
        let dir = res!(scratch("escape_00"));
        let mut j = res!(Journal::open(cfg_at(&dir)));
        let reason = "It said \"no\" \\ then\nstopped.\u{7}";
        res!(j.append(&Event::Refused {
            id:     "run-1".to_string(),
            reason: reason.to_string(),
        }));
        res!(j.flush());
        let path = j.path().to_path_buf();
        drop(j);

        assert!(res!(verify_file(&path, Some(&Chain::genesis()))).is_intact());
        let lines = res!(lines_of(&path));
        assert_eq!(lines.len(), 1, "an embedded newline must not become a second line");
        let e    = res!(parse_line(&lines[0]));
        let back = res!(Dat::decode_string(&e.body));
        assert_eq!(res!(back.json_canonical()), e.body);
        Ok(())
    }

    /// A body carrying multi-byte text reads back, which is the case a
    /// byte-offset reader would split a character on.
    #[test]
    fn test_a_multibyte_body_reads_back_00() -> Outcome<()> {
        let dir = res!(scratch("utf8_00"));
        let mut j = res!(Journal::open(cfg_at(&dir)));
        res!(j.append(&Event::Refused {
            id:     "run-1".to_string(),
            reason: "Le répertoire « données » n'est pas accessible — 日本語も.".to_string(),
        }));
        res!(j.flush());
        let path = j.path().to_path_buf();
        drop(j);

        assert!(res!(verify_file(&path, Some(&Chain::genesis()))).is_intact());
        let lines = res!(lines_of(&path));
        let e = res!(parse_line(&lines[0]));
        assert!(e.body.contains("日本語"), "body was: {}", e.body);
        Ok(())
    }

    /// Batching really does hold entries back, which is the tradeoff the default
    /// exists to avoid.
    #[test]
    fn test_batching_holds_entries_back_00() -> Outcome<()> {
        let dir = res!(scratch("batch_00"));
        let mut c = cfg_at(&dir);
        c.durability = Durability::Batched(4);
        let mut j = res!(Journal::open(c));
        res!(j.append(&Event::Started { id: "a".to_string(), pid: 1 }));
        let path = j.path().to_path_buf();
        let md = res!(fs::metadata(&path), IO, File);
        assert_eq!(md.len(), 0, "a batched journal has not written the entry yet");
        res!(j.flush());
        let md = res!(fs::metadata(&path), IO, File);
        assert!(md.len() > 0, "flushing must write it");
        drop(j);
        Ok(())
    }

    /// The default writes each entry as it is made, which is the property a
    /// crash-time record depends on.
    #[test]
    fn test_the_default_writes_every_entry_at_once_00() -> Outcome<()> {
        let dir = res!(scratch("durable_00"));
        let mut j = res!(Journal::open(cfg_at(&dir)));
        res!(j.append(&Event::Refused {
            id:     "run-1".to_string(),
            reason: "declined".to_string(),
        }));
        let path = j.path().to_path_buf();
        // Read it without flushing and without dropping the journal.
        let text = res!(read_text(&path));
        assert!(text.contains("\"kind\":\"refused\""),
            "the refusal must be on disk before the next thing happens");
        drop(j);
        Ok(())
    }

    /// An empty directory is a chain that has not started, not a broken one.
    #[test]
    fn test_an_empty_directory_verifies_00() -> Outcome<()> {
        let dir = res!(scratch("empty_00"));
        match res!(verify_dir(&dir)) {
            Verdict::Intact { entries, chain } => {
                assert_eq!(entries, 0);
                assert_eq!(chain, Chain::genesis());
            },
            other => return Err(err!("An empty journal must verify, got {:?}", other; Bug)),
        }
        Ok(())
    }

    // ── The adversarial review of 2026-08-02, reproduced ──────────────
    //
    // Every test below was written against the code as the review found it,
    // watched to fail, and only then fixed.  They are kept in review order so a
    // later reader can match a test to the finding it came from.

    /// §2.1 Deleting whole files off the end of a history must not verify.
    #[test]
    fn test_a_truncated_history_is_caught_00() -> Outcome<()> {
        let dir = res!(scratch("trunc_hist_00"));
        let mut c = cfg_at(&dir);
        c.max_bytes = 700;
        {
            let mut j = res!(Journal::open(c));
            for i in 0..60u32 {
                res!(j.append(&Event::Started { id: fmt!("run-{}", i), pid: 1000 + i }));
            }
            res!(j.flush());
        }
        let files = res!(journal_files(&dir));
        assert!(files.len() >= 4, "need several files to lop three off, got {}", files.len());
        for (_, p) in files.iter().rev().take(3) {
            res!(fs::remove_file(p), IO, File);
        }
        match res!(verify_dir(&dir)) {
            Verdict::Broken {..} => {},
            other => return Err(err!(
                "A history missing its last three files must not verify, got {:?}", other; Bug)),
        }
        Ok(())
    }

    /// §2.1 And a hand reopened on that history must not go on as though nothing
    /// had happened.
    #[test]
    fn test_a_truncated_history_does_not_resume_intact_00() -> Outcome<()> {
        let dir = res!(scratch("trunc_resume_00"));
        let mut c = cfg_at(&dir);
        c.max_bytes = 700;
        {
            let mut j = res!(Journal::open(c.clone()));
            for i in 0..60u32 {
                res!(j.append(&Event::Started { id: fmt!("run-{}", i), pid: 1000 + i }));
            }
            res!(j.flush());
        }
        let files = res!(journal_files(&dir));
        for (_, p) in files.iter().rev().take(3) {
            res!(fs::remove_file(p), IO, File);
        }
        {
            let mut j = res!(Journal::open(c));
            res!(j.append(&Event::Started { id: "after".to_string(), pid: 7 }));
            res!(j.flush());
        }
        match res!(verify_dir(&dir)) {
            Verdict::Broken {..} => {},
            other => return Err(err!(
                "Appending onto a truncated history must not restore it to \
                intact, got {:?}", other; Bug)),
        }
        Ok(())
    }

    /// §2.1 Blanking the final file to zero bytes erases its entries just as
    /// surely as deleting it.
    #[test]
    fn test_a_blanked_final_file_is_caught_00() -> Outcome<()> {
        let dir = res!(scratch("blank_00"));
        let mut c = cfg_at(&dir);
        c.max_bytes = 700;
        {
            let mut j = res!(Journal::open(c));
            for i in 0..40u32 {
                res!(j.append(&Event::Started { id: fmt!("run-{}", i), pid: 1000 + i }));
            }
            res!(j.flush());
        }
        let files = res!(journal_files(&dir));
        let last  = match files.last() {
            Some((_, p)) => p.clone(),
            None         => return Err(err!("No journal files."; Bug)),
        };
        res!(File::create(&last), IO, File);
        match res!(verify_dir(&dir)) {
            Verdict::Broken {..} => {},
            other => return Err(err!(
                "A blanked final file must not verify, got {:?}", other; Bug)),
        }
        Ok(())
    }

    /// §2.2 A file planted with the highest name the format allows must not push
    /// the hand into writing somewhere nothing ever reads.
    #[test]
    fn test_a_planted_high_index_file_is_not_written_past_00() -> Outcome<()> {
        let dir = res!(scratch("plant_high_00"));
        {
            let mut j = res!(Journal::open(cfg_at(&dir)));
            res!(j.append(&Event::Started { id: "a".to_string(), pid: 1 }));
            res!(j.flush());
        }
        // Any process running as the user can drop this in.
        let plant = dir.join("hand-99999999.jsonl");
        res!(fs::write(&plant, b"not a journal at all\n"), IO, File);

        let live = {
            let mut j = res!(Journal::open(cfg_at(&dir)));
            res!(j.append(&Event::Started { id: "b".to_string(), pid: 2 }));
            res!(j.flush());
            j.path().to_path_buf()
        };
        let name = live.to_string_lossy().to_string();
        assert!(!name.contains("hand-100000000"),
            "the hand must not write to a name outside the format: {}", name);
        // Whatever the hand just wrote must be part of what a verifier reads.
        let files = res!(journal_files(&dir));
        assert!(files.iter().any(|(_, p)| *p == live),
            "the live file must be one a verifier walks: {:?}", files);
        Ok(())
    }

    /// §2.2 An empty plant must not fork a second chain from zero and leave the
    /// record broken for ever.
    #[test]
    fn test_an_empty_plant_does_not_fork_the_chain_00() -> Outcome<()> {
        let dir = res!(scratch("plant_empty_00"));
        {
            let mut j = res!(Journal::open(cfg_at(&dir)));
            res!(j.append(&Event::Started { id: "a".to_string(), pid: 1 }));
            res!(j.flush());
        }
        res!(fs::write(dir.join("hand-00000042.jsonl"), b""), IO, File);
        {
            let mut j = res!(Journal::open(cfg_at(&dir)));
            res!(j.append(&Event::Started { id: "b".to_string(), pid: 2 }));
            res!(j.flush());
        }
        match res!(verify_dir(&dir)) {
            Verdict::Intact {..} => Ok(()),
            other => Err(err!(
                "A planted empty file must not break the record, got {:?}", other; Bug)),
        }
    }

    /// §2.2 A *directory* with a journal file's name must not stop the hand
    /// dead, because under "journal before acting" that means it can never act.
    #[test]
    fn test_a_planted_directory_does_not_stop_the_hand_00() -> Outcome<()> {
        let dir = res!(scratch("plant_dir_00"));
        {
            let mut j = res!(Journal::open(cfg_at(&dir)));
            res!(j.append(&Event::Started { id: "a".to_string(), pid: 1 }));
            res!(j.flush());
        }
        res!(fs::create_dir(dir.join("hand-00000077.jsonl")), IO, File);

        let mut j = res!(Journal::open(cfg_at(&dir)));
        res!(j.append(&Event::Started { id: "b".to_string(), pid: 2 }));
        res!(j.flush());
        drop(j);
        // And the verifier must have an opinion rather than an error.
        res!(verify_dir(&dir));
        Ok(())
    }

    /// §2.3 A refusal that quotes the command it refused -- the natural wording
    /// -- must not write the credential down.
    #[test]
    fn test_a_refusal_quoting_a_command_is_redacted_00() -> Outcome<()> {
        let dir = res!(scratch("refuse_quote_00"));
        let key = fmt!("{}{}", "ghp_", "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"); // allowlist secret
        let mut j = res!(Journal::open(cfg_at(&dir)));
        res!(j.append(&Event::Refused {
            id:     "run-1".to_string(),
            reason: fmt!("I will not run `gh auth login --with-token {}` here.", key),
        }));
        res!(j.append(&Event::Failed {
            id:      Some("run-2".to_string()),
            message: fmt!("curl exited 1: Authorization: Bearer {}", key),
        }));
        res!(j.flush());
        let path = j.path().to_path_buf();
        drop(j);

        let text = res!(read_text(&path));
        assert!(!text.contains(&key), "a refusal must not write the credential down");
        Ok(())
    }

    /// §2.3 And through the constructors the message loop actually calls, since
    /// `Event::from_resp` applied no redaction whatever.
    #[test]
    fn test_from_resp_and_from_req_redact_00() -> Outcome<()> {
        let dir = res!(scratch("from_resp_00"));
        let key = fmt!("{}{}", "ghp_", "EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE"); // allowlist secret
        let mut j = res!(Journal::open(cfg_at(&dir)));
        let resps = vec![
            Resp::Refused {
                id:     "run-1".to_string(),
                reason: fmt!("refusing `gh auth login --with-token {}`", key),
            },
            Resp::Error {
                id:      Some(fmt!("run-{}", key)),
                message: fmt!("the token {} was rejected", key),
            },
            Resp::Started { id: fmt!("run-{}", key), pid: 3 },
            Resp::Ended {
                id: fmt!("run-{}", key), exit: 1, timed_out: false, killed: false,
                out_bytes: 0, err_bytes: 0,
            },
        ];
        for r in resps.iter() {
            match Event::from_resp(r) {
                Some(ev) => { res!(j.append(&ev)); },
                None     => return Err(err!("A response produced no event."; Bug)),
            }
        }
        match Event::from_req(&Req::Hello { proto: 1, client: fmt!("app/{}", key) }, &[]) {
            Some(ev) => { res!(j.append(&ev)); },
            None     => return Err(err!("Hello produced no event."; Bug)),
        }
        res!(j.flush());
        let path = j.path().to_path_buf();
        drop(j);

        let text = res!(read_text(&path));
        assert!(!text.contains(&key), "no response field may carry a credential");
        assert!(text.contains(REDACTED), "and the record must say something was removed");
        Ok(())
    }

    /// §2.3 Every other free-text field the review found unguarded.
    #[test]
    fn test_every_free_text_field_is_redacted_00() -> Outcome<()> {
        let dir = res!(scratch("free_text_00"));
        let key = fmt!("{}{}", "sk-", "live0000000000000000000000000"); // allowlist secret
        let mut j = res!(Journal::open(cfg_at(&dir)));

        res!(j.append(&Event::Opened { proto: 1, client: fmt!("daimond/{}", key) }));
        let req = Req::Exec {
            id:         fmt!("run-{}", key),
            argv:       vec!["cargo".to_string()],
            cwd:        fmt!("/home/u/{}", key),
            env:        vec![(fmt!("TOK_{}", key), "v".to_string())],
            stdin:      None,
            timeout_ms: 1,
            capture:    Capture::None,
            fence:      FenceSpec {
                rw:   vec![fmt!("/home/u/{}", key)],
                ro:   vec![fmt!("/opt/{}", key)],
                deny: vec![fmt!("/srv/{}", key)],
                net:  false,
            },
            toolkits: Vec::new(),
        };
        match Event::from_req(&req, &[fmt!("landlock-{}", key)]) {
            Some(ev) => { res!(j.append(&ev)); },
            None     => return Err(err!("The exec request produced no event."; Bug)),
        }
        res!(j.append(&Event::Started { id: fmt!("run-{}", key), pid: 1 }));
        res!(j.append(&Event::Signalled { id: fmt!("run-{}", key), sig: Sig::Term }));
        res!(j.append(&Event::Ended {
            id: fmt!("run-{}", key), exit: 0, timed_out: false, killed: false,
            out_bytes: 0, err_bytes: 0,
        }));
        res!(j.append(&Event::Closed { reason: fmt!("dropped while holding {}", key) }));
        res!(j.flush());
        let path = j.path().to_path_buf();
        drop(j);

        let text = res!(read_text(&path));
        assert!(!text.contains(&key), "no field may carry a credential value");
        Ok(())
    }

    /// §2.4 The twelve credential shapes that all came back `cut=0`.
    #[test]
    fn test_real_credential_shapes_are_redacted_00() -> Outcome<()> {
        let gh   = fmt!("{}{}", "ghp_", "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC"); // allowlist secret
        let sk   = fmt!("{}{}", "sk-", "0123456789abcdef0123456789"); // allowlist secret
        let cases: Vec<(Vec<String>, Vec<String>)> = vec![
            (vec![fmt!("https://oauth2:{}@github.com/o/r.git", gh)], vec![gh.clone()]),
            (vec!["psql".to_string(), "postgres://u:hunter2@db/app".to_string()],
                vec!["hunter2".to_string()]),
            (vec![fmt!("--header=Authorization: Bearer {}", sk)], vec![sk.clone()]),
            (vec!["--PASSWORD=hunter2".to_string()], vec!["hunter2".to_string()]),
            (vec!["--Token".to_string(), "hunter2".to_string()], vec!["hunter2".to_string()]),
            (vec!["--secret-access-key".to_string(), "hunter2".to_string()],
                vec!["hunter2".to_string()]),
            (vec!["--private-key".to_string(), "hunter2".to_string()],
                vec!["hunter2".to_string()]),
            (vec!["mysql".to_string(), "-phunter2".to_string()], vec!["hunter2".to_string()]),
            (vec!["--api_key=hunter2".to_string()], vec!["hunter2".to_string()]),
            (vec!["env".to_string(), "PGPASSWORD=hunter2".to_string()],
                vec!["hunter2".to_string()]),
            (vec![fmt!("https://api.example.com/v1?api_key={}", sk)], vec![sk.clone()]),
            (vec!["-H".to_string(), "X-Api-Key: hunter2".to_string()],
                vec!["hunter2".to_string()]),
        ];
        for (argv, must_go) in cases.iter() {
            let (out, cut) = redact_argv(argv);
            let joined = out.join(" ");
            for s in must_go.iter() {
                assert!(!joined.contains(s.as_str()),
                    "'{}' survived redaction of {:?} -> {:?}", s, argv, out);
            }
            assert!(cut > 0, "nothing was counted as removed from {:?}", argv);
        }
        Ok(())
    }

    /// §2.5 Two hands on one directory must not both think they own the chain.
    #[test]
    fn test_a_second_journal_on_one_directory_is_refused_00() -> Outcome<()> {
        let dir = res!(scratch("lock_00"));
        let mut first = res!(Journal::open(cfg_at(&dir)));
        res!(first.append(&Event::Started { id: "a".to_string(), pid: 1 }));
        res!(first.flush());
        match Journal::open(cfg_at(&dir)) {
            Ok(_)  => return Err(err!(
                "A second journal on one directory must be refused."; Bug)),
            Err(e) => {
                let s = fmt!("{}", e);
                assert!(s.contains("Another hand is already writing"), "message was: {}", s);
            },
        }
        drop(first);
        // And the lock must be released when the first journal goes away.
        let _second = res!(Journal::open(cfg_at(&dir)));
        Ok(())
    }

    /// §2.6 A write that reaches nothing must be an error, so that "journal
    /// before acting" refuses the command rather than running it unrecorded.
    #[test]
    fn test_a_write_that_reaches_nothing_is_an_error_00() -> Outcome<()> {
        let dir = res!(scratch("gone_00"));
        let mut j = res!(Journal::open(cfg_at(&dir)));
        res!(j.append(&Event::Started { id: "a".to_string(), pid: 1 }));
        res!(fs::remove_dir_all(&dir), IO, File);
        match j.append(&Event::Refused {
            id:     "run-2".to_string(),
            reason: "no".to_string(),
        }) {
            Ok(_)  => Err(err!(
                "An entry that reached nothing must not be reported as written."; Bug)),
            Err(_) => Ok(()),
        }
    }

    /// §2.7 The Rust verifier and the documented shell verifier must agree, and
    /// a CRLF conversion is where they parted company.
    #[test]
    fn test_crlf_disagrees_with_no_verifier_00() -> Outcome<()> {
        let (dir, path) = res!(seeded("crlf_00"));
        let text = res!(read_text(&path));
        let crlf = text.replace('\n', "\r\n");
        res!(fs::write(&path, crlf.as_bytes()), IO, File);
        match res!(verify_file(&path, Some(&Chain::genesis()))) {
            Verdict::Broken {..} => {},
            other => return Err(err!(
                "A CRLF journal mismatches every line under `sed | sha256sum`, so \
                the Rust verifier must not call it intact, got {:?}", other; Bug)),
        }
        let _ = dir;
        Ok(())
    }

    /// §2.8 A journal file is readable by its owner and by nobody else.
    #[cfg(unix)]
    #[test]
    fn test_journal_files_are_private_00() -> Outcome<()> {
        use std::os::unix::fs::PermissionsExt;
        let (_dir, path) = res!(seeded("perm_00"));
        let md = res!(fs::metadata(&path), IO, File);
        let mode = md.permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "a journal file must not be group or world readable");
        Ok(())
    }

    /// §2.8 An operator's own directory must not be chmodded to 0700 behind
    /// their back.
    #[cfg(unix)]
    #[test]
    fn test_an_operator_directory_is_not_chmodded_00() -> Outcome<()> {
        use std::os::unix::fs::PermissionsExt;
        let base = res!(scratch("chmod_00"));
        let dir  = base.join("shared");
        res!(fs::create_dir(&dir), IO, File);
        // Something of the operator's that is not a journal.
        res!(fs::write(dir.join("notes.txt"), b"mine"), IO, File);
        let mut p = res!(fs::metadata(&dir), IO, File).permissions();
        p.set_mode(0o755);
        res!(fs::set_permissions(&dir, p), IO, File);

        let opened = Journal::open(cfg_at(&dir));
        let mode = res!(fs::metadata(&dir), IO, File).permissions().mode() & 0o777;
        assert_eq!(mode, 0o755,
            "the journal must not silently tighten a directory it did not make");
        // Refusing is a fine answer; quietly re-permissioning is not.
        drop(opened);
        Ok(())
    }

    /// A directory holding only the record and `root.txt` is one the hand made.
    ///
    /// The documented install puts `root.txt` beside the journal, so counting
    /// it as somebody else's file made the ordinary layout a directory the hand
    /// would neither tighten nor use -- a refusal produced by following the
    /// instructions.
    #[cfg(unix)]
    #[test]
    fn test_root_txt_beside_the_journal_is_ours_00() -> Outcome<()> {
        use std::os::unix::fs::PermissionsExt;
        let base = res!(scratch("chmod_root_00"));
        let dir  = base.join("journal");
        res!(fs::create_dir(&dir), IO, File);
        res!(fs::write(dir.join(crate::ROOT_FILE), b"/home/u/work\n"), IO, File);
        let mut p = res!(fs::metadata(&dir), IO, File).permissions();
        p.set_mode(0o755);
        res!(fs::set_permissions(&dir, p), IO, File);

        let opened = Journal::open(cfg_at(&dir));
        assert!(opened.is_ok(), "the hand must open a directory holding only its own files");
        let mode = res!(fs::metadata(&dir), IO, File).permissions().mode() & 0o777;
        assert_eq!(mode, 0o700,
            "a directory holding only the record and root.txt is the hand's, and is tightened");
        drop(opened);
        Ok(())
    }

    /// §2.8 A hand restarted on a later day starts a new file rather than
    /// appending into the previous day's.
    #[test]
    fn test_a_restart_on_a_later_day_rotates_00() -> Outcome<()> {
        let dir = res!(scratch("day_restart_00"));
        let c   = cfg_at(&dir);
        {
            let mut j = res!(Journal::open(c.clone()));
            res!(j.append(&Event::Started { id: "a".to_string(), pid: 1 }));
            res!(j.flush());
        }
        let mut later = cfg_at(&dir);
        later.clock = Clock::fixed(1_754_000_000_000 + 2 * DAY_MS);
        {
            let mut j = res!(Journal::open(later));
            res!(j.append(&Event::Started { id: "b".to_string(), pid: 2 }));
            res!(j.flush());
        }
        let files = res!(journal_files(&dir));
        assert_eq!(files.len(), 2,
            "a restart two days later must not append into the old day's file");
        assert!(res!(verify_dir(&dir)).is_intact());
        Ok(())
    }

    // ── Attacks on the fixes themselves ───────────────────────────────

    /// Removing the mark along with the files does not restore the verdict:
    /// a history with entries and nothing vouching for its length is broken.
    #[test]
    fn test_deleting_the_mark_too_is_still_caught_00() -> Outcome<()> {
        let dir = res!(scratch("mark_gone_00"));
        let mut c = cfg_at(&dir);
        c.max_bytes = 700;
        {
            let mut j = res!(Journal::open(c));
            for i in 0..40u32 {
                res!(j.append(&Event::Started { id: fmt!("run-{}", i), pid: i }));
            }
            res!(j.flush());
        }
        let files = res!(journal_files(&dir));
        for (_, p) in files.iter().rev().take(2) {
            res!(fs::remove_file(p), IO, File);
        }
        res!(fs::remove_file(mark_path(&dir)), IO, File);
        match res!(verify_dir(&dir)) {
            Verdict::Broken { reason, .. } => {
                assert!(reason.contains("no high-water mark"), "reason was: {}", reason);
            },
            other => return Err(err!(
                "Deleting the mark must not launder a truncation, got {:?}", other; Bug)),
        }
        Ok(())
    }

    /// And an edited mark is caught by its own hash rather than believed.
    #[test]
    fn test_an_edited_mark_is_caught_00() -> Outcome<()> {
        let dir = res!(scratch("mark_edit_00"));
        {
            let mut j = res!(Journal::open(cfg_at(&dir)));
            res!(j.append(&Event::Started { id: "a".to_string(), pid: 1 }));
            res!(j.flush());
        }
        let path = mark_path(&dir);
        let text = res!(read_text(&path));
        res!(fs::write(&path, text.replace("\"seq\":1", "\"seq\":9").as_bytes()), IO, File);
        match res!(verify_dir(&dir)) {
            Verdict::Broken { reason, .. } => {
                assert!(reason.contains("does not read back"), "reason was: {}", reason);
            },
            other => return Err(err!("An edited mark must be caught, got {:?}", other; Bug)),
        }
        Ok(())
    }

    /// A gap, once recorded, stays recorded: restarting the hand does not put a
    /// truncated history back to intact.
    #[test]
    fn test_a_recorded_gap_survives_a_restart_00() -> Outcome<()> {
        let dir = res!(scratch("gap_sticky_00"));
        let mut c = cfg_at(&dir);
        c.max_bytes = 700;
        {
            let mut j = res!(Journal::open(c.clone()));
            for i in 0..40u32 {
                res!(j.append(&Event::Started { id: fmt!("run-{}", i), pid: i }));
            }
            res!(j.flush());
        }
        let files = res!(journal_files(&dir));
        for (_, p) in files.iter().rev().take(2) {
            res!(fs::remove_file(p), IO, File);
        }
        for _ in 0..3 {
            let mut j = res!(Journal::open(c.clone()));
            res!(j.append(&Event::Started { id: "after".to_string(), pid: 9 }));
            res!(j.flush());
            drop(j);
            match res!(verify_dir(&dir)) {
                Verdict::Broken {..} => {},
                other => return Err(err!(
                    "A recorded gap must not wash out with a restart, got {:?}", other; Bug)),
            }
        }
        // And the record says so in its own words.
        let mut said = false;
        for (_, p) in res!(journal_files(&dir)).iter() {
            if res!(read_text(p)).contains("\"kind\":\"gap\"") {
                said = true;
            }
        }
        assert!(said, "the record must carry the gap it detected");
        Ok(())
    }

    /// Every credential shape brought against the redactor, in argv and in the
    /// free text of a refusal alike.
    #[test]
    fn test_more_credential_shapes_are_redacted_00() -> Outcome<()> {
        let jwt = fmt!("{}{}", "eyJ", "hbGciOiJIUzI1NiJ9.e30.abcdefghijkl"); // allowlist secret
        let aws = fmt!("{}{}", "AKIA", "IOSFODNN7EXAMPLE");                  // allowlist secret
        let cases: Vec<(Vec<String>, &str)> = vec![
            (vec!["curl".to_string(), "-u".to_string(), "me:hunter2".to_string()], "hunter2"),
            (vec!["curl".to_string(), "--user=me:hunter2".to_string()], "hunter2"),
            (vec!["curl".to_string(), "-d".to_string(),
                "grant_type=password&client_secret=hunter2".to_string()], "hunter2"),
            (vec!["curl".to_string(), "-d".to_string(), "password=hunter2".to_string()],
                "hunter2"),
            (vec!["-H".to_string(), fmt!("Cookie: session={}", jwt)], jwt.as_str()),
            (vec![fmt!("Authorization:Bearer {}", jwt)], jwt.as_str()),
            (vec!["aws".to_string(), "--access-key".to_string(), aws.clone()], aws.as_str()),
            (vec![fmt!("/home/u/{}/build", aws)], aws.as_str()),
            (vec!["--client-secret".to_string(), "hunter2".to_string()], "hunter2"),
            (vec![fmt!("--auth-token={}", jwt)], jwt.as_str()),
        ];
        for (argv, must_go) in cases.iter() {
            let (out, cut) = redact_argv(argv);
            let joined = out.join(" ");
            assert!(!joined.contains(must_go),
                "'{}' survived redaction of {:?} -> {:?}", must_go, argv, out);
            assert!(cut > 0, "nothing was counted as removed from {:?}", argv);
        }
        // The shapes found by sweeping a wider net over real tools, each of
        // which came back untouched before the rule that catches it was written.
        let odd: Vec<(Vec<String>, &str)> = vec![
            (vec!["curl".to_string(), fmt!("--oauth2-bearer={}", jwt)], jwt.as_str()),
            (vec!["npm".to_string(), "config".to_string(), "set".to_string(),
                fmt!("//registry.npmjs.org/:_authToken={}", jwt)], jwt.as_str()),
            (vec!["ssh-add".to_string(), fmt!("--passphrase {}", jwt)], jwt.as_str()),
            (vec!["mongo".to_string(), fmt!("mongodb+srv://u:hunter2@h/db")], "hunter2"),
            (vec!["curl".to_string(), fmt!("--cookie=session={}", jwt)], jwt.as_str()),
        ];
        for (argv, must_go) in odd.iter() {
            let (out, cut) = redact_argv(argv);
            let joined = out.join(" ");
            assert!(!joined.contains(must_go),
                "'{}' survived redaction of {:?} -> {:?}", must_go, argv, out);
            assert!(cut > 0, "nothing was counted as removed from {:?}", argv);
        }
        // The same shapes inside a sentence, which is how a refusal quotes them.
        let prose = vec![
            fmt!("Refusing `curl -H 'Authorization: Bearer {}'` in a tainted turn.", jwt),
            fmt!("The command set --password hunter2 and I will not run it."),
            fmt!("Cannot reach {} from here.", aws),
            fmt!("It wanted https://oauth2:{}@github.com and the fence says no.", jwt),
        ];
        let prose2 = vec![
            fmt!("It tried Basic {} against the gateway.", jwt),
            fmt!("Refused: curl -u me:hunter2 https://h"),
        ];
        for p in prose2.iter() {
            let (out, _) = redact_text(p);
            assert!(!out.contains(jwt.as_str()) && !out.contains("hunter2"),
                "a credential survived '{}' -> '{}'", p, out);
        }
        for p in prose.iter() {
            let (out, cut) = redact_text(p);
            assert!(!out.contains(jwt.as_str()) && !out.contains(aws.as_str())
                && !out.contains("hunter2"),
                "a credential survived '{}' -> '{}'", p, out);
            assert!(cut > 0, "nothing was counted as removed from '{}'", p);
        }
        Ok(())
    }

    /// Redaction is idempotent, so running it twice never says that two values
    /// were removed where one was.
    #[test]
    fn test_redaction_is_idempotent_00() -> Outcome<()> {
        let key  = fmt!("{}{}", "ghp_", "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD"); // allowlist secret
        let argv = vec![
            "gh".to_string(),
            "--token".to_string(),
            "hunter2".to_string(),
            fmt!("--api-key={}", key),
            key.clone(),
            fmt!("Authorization: Bearer {}", key),
        ];
        let (once, a) = redact_argv(&argv);
        let (twice, b) = redact_argv(&once);
        assert_eq!(once, twice, "a second pass must change nothing");
        assert_eq!(b, 0, "a second pass must count nothing, but counted {} (first {})", b, a);
        let (t1, c1) = redact_text("Bearer hunter2 and --password hunter2");
        let (t2, c2) = redact_text(&t1);
        assert_eq!(t1, t2);
        assert_eq!(c2, 0, "a second pass over text must count nothing (first {})", c1);
        Ok(())
    }

    /// Over-redaction is a real cost, so the shapes that merely look alike are
    /// left as they are.
    #[test]
    fn test_ordinary_arguments_survive_redaction_00() -> Outcome<()> {
        let argv = vec![
            "docker".to_string(),
            "run".to_string(),
            "-p8080:80".to_string(),
            "-p".to_string(),
            "127.0.0.1:5432:5432/tcp".to_string(),
            "-u".to_string(),
            "1000".to_string(),
            "--key-file".to_string(),
            "/etc/ssl/x.pem".to_string(),
            "--user".to_string(),
            "bob".to_string(),
            "cargo".to_string(),
            "test".to_string(),
            "--package".to_string(),
            "sk-headless".to_string(),
            "PATH=/usr/bin".to_string(),
            "https://example.com/a?page=2".to_string(),
        ];
        let (out, cut) = redact_argv(&argv);
        assert_eq!(cut, 0, "nothing here is a credential, but {:?} was produced", out);
        assert_eq!(out, argv);
        let (text, c) = redact_text(
            "The build failed in /home/u/proj and the bypass flag was ignored.");
        assert_eq!(c, 0, "ordinary prose must survive: {}", text);
        Ok(())
    }

    /// A journal file holding bytes that are not text is a verdict, not an
    /// error, because an error means the hand can never act again.
    #[test]
    fn test_a_file_that_is_not_text_is_a_verdict_00() -> Outcome<()> {
        let (dir, path) = res!(seeded("binary_00"));
        res!(fs::write(&path, [0x7bu8, 0xff, 0xfe, 0x0a]), IO, File);
        match res!(verify_dir(&dir)) {
            Verdict::Broken {..} => Ok(()),
            other => Err(err!("Binary rubbish must be Broken, got {:?}", other; Bug)),
        }
    }

    /// A crash between rotating and writing the first entry of the new file
    /// leaves an empty newest file, and that must not read as history lost.
    /// A tamper-evident log that cries wolf is worth nothing.
    #[test]
    fn test_an_empty_newest_file_is_not_a_gap_00() -> Outcome<()> {
        let dir = res!(scratch("empty_newest_00"));
        let c   = cfg_at(&dir);
        {
            let mut j = res!(Journal::open(c.clone()));
            for i in 0..5u32 {
                res!(j.append(&Event::Started { id: fmt!("run-{}", i), pid: i }));
            }
            res!(j.flush());
        }
        // Exactly what the hand leaves behind when it dies between opening the
        // next file and writing that file's first entry: an empty file, and a
        // mark that already names it.
        let next = res!(journal_files(&dir));
        let n = match next.last() {
            Some((n, _)) => *n,
            None         => return Err(err!("No journal files."; Bug)),
        };
        res!(File::create(dir.join(file_name(n + 1))), IO, File);
        let m = match res!(read_mark(&dir)) {
            MarkState::At(m) => m,
            other            => return Err(err!("Expected a mark, got {:?}", other; Bug)),
        };
        let line = res!(mark_line(&Mark { files: n + 1, ..m }));
        res!(fs::write(mark_path(&dir), fmt!("{}\n", line).as_bytes()), IO, File);

        let mut j = res!(Journal::open(c));
        res!(j.append(&Event::Started { id: "after".to_string(), pid: 9 }));
        res!(j.flush());
        drop(j);

        match res!(verify_dir(&dir)) {
            Verdict::Intact { entries, .. } => {
                assert_eq!(entries, 6, "no entry should be lost or invented");
                for (_, p) in res!(journal_files(&dir)).iter() {
                    assert!(!res!(read_text(p)).contains("\"kind\":\"gap\""),
                        "an interrupted rotation is not a loss of history");
                }
                Ok(())
            },
            other => Err(err!(
                "An empty file left by a rotation must not read as a gap, got {:?}",
                other; Bug)),
        }
    }

    /// A directory planted where the lock or the mark goes does not stop the
    /// hand, which is the denial of service one `mkdir` would otherwise buy.
    #[test]
    fn test_planted_furniture_does_not_stop_the_hand_00() -> Outcome<()> {
        for name in ["lock", "head.json", "head.json.new"] {
            let dir = res!(scratch(&fmt!("furniture_{}", name.replace('.', "_"))));
            {
                let mut j = res!(Journal::open(cfg_at(&dir)));
                res!(j.append(&Event::Started { id: "a".to_string(), pid: 1 }));
                res!(j.flush());
            }
            res!(fs::remove_file(dir.join(name)).or_else(|_| Ok::<(), std::io::Error>(())),
                IO, File);
            res!(fs::create_dir(dir.join(name)), IO, File);

            let mut j = res!(Journal::open(cfg_at(&dir)));
            res!(j.append(&Event::Started { id: "b".to_string(), pid: 2 }));
            res!(j.flush());
            drop(j);
            // A verdict, either way, rather than an error.
            res!(verify_dir(&dir));
        }
        Ok(())
    }

    /// The residual, stated as a test so it cannot quietly get worse: a
    /// truncation is caught unless the mark is forged to match it, and a forged
    /// mark is what an attacker with write access to the directory must now
    /// produce.  The chain alone never could have caught this; the mark makes it
    /// cost a second, consistent forgery.
    #[test]
    fn test_truncation_needs_a_forged_mark_00() -> Outcome<()> {
        let dir = res!(scratch("forge_00"));
        let mut c = cfg_at(&dir);
        c.max_bytes = 700;
        {
            let mut j = res!(Journal::open(c));
            for i in 0..40u32 {
                res!(j.append(&Event::Started { id: fmt!("run-{}", i), pid: i }));
            }
            res!(j.flush());
        }
        let files = res!(journal_files(&dir));
        for (_, p) in files.iter().rev().take(2) {
            res!(fs::remove_file(p), IO, File);
        }
        // Truncated, mark untouched: caught.
        assert!(!res!(verify_dir(&dir)).is_intact(), "a bare truncation must be caught");

        // Now forge the mark to agree with the shortened history, which is the
        // work the mark forces on anyone who wants the truncation to pass.
        let left  = res!(journal_files(&dir));
        let mut chain = Chain::genesis();
        let mut top   = 0u32;
        for (n, p) in left.iter() {
            match res!(verify_file(p, Some(&chain))) {
                Verdict::Intact { chain: ch, .. } => { chain = ch; top = *n; },
                other => return Err(err!("The kept files should verify: {:?}", other; Bug)),
            }
        }
        let line = res!(mark_line(&Mark { seq: chain.seq, files: top, head: chain.head }));
        res!(fs::write(mark_path(&dir), fmt!("{}\n", line).as_bytes()), IO, File);
        assert!(res!(verify_dir(&dir)).is_intact(),
            "a consistent forgery of both is the residual the module doc states");
        Ok(())
    }


    /// The rotation stops rather than writing a name outside its own format.
    #[test]
    fn test_the_rotation_will_not_leave_its_name_format_00() -> Outcome<()> {
        assert!(next_idx(MAX_IDX).is_err(), "the last name must be the last name");
        match next_idx(MAX_IDX - 1) {
            Ok(n)  => assert_eq!(n, MAX_IDX),
            Err(e) => return Err(err!("The last-but-one index must roll: {}", e; Bug)),
        }
        Ok(())
    }

    // ── The external oracle ───────────────────────────────────────────

    /// Every entry hash is reproduced by coreutils, not by this module.
    ///
    /// The pipeline is the one the module doc documents, run by a real shell over
    /// a journal full of the text most likely to break a byte-exact rule: emoji,
    /// DEL, U+2029, CJK, quotes, backslashes, tabs and a three-hundred element
    /// argument vector.  A check that only agrees with itself proves nothing.
    #[test]
    fn test_coreutils_reproduces_every_entry_hash_00() -> Outcome<()> {
        use std::process::Command;
        // Skip where the tools are not installed rather than fail a build.
        match Command::new("sha256sum").arg("--version").output() {
            Ok(o) if o.status.success() => {},
            _ => return Ok(()),
        }
        let dir = res!(scratch("oracle_00"));
        let mut j = res!(Journal::open(cfg_at(&dir)));
        let awkward = "quote\" backslash\\ tab\t emoji😀 del\u{7f} sep\u{2029} 日本語";
        for i in 0..200u32 {
            match i % 4 {
                0 => { res!(j.append(&Event::Refused {
                    id:     fmt!("run-{}", i),
                    reason: fmt!("{} #{}", awkward, i),
                })); },
                1 => {
                    let argv: Vec<String> = (0..300).map(|k| fmt!("arg{}{}", k, awkward)).collect();
                    res!(j.append(&Event::Exec {
                        id:          fmt!("run-{}", i),
                        argv,
                        redactions:  0,
                        cwd:         fmt!("/home/u/{}", awkward),
                        env_keys:    vec!["PATH".to_string()],
                        stdin_bytes: 12,
                        timeout_ms:  1000,
                        capture:     Capture::Both,
                        fence:       FenceSpec::default(),
                        mechs:       vec!["landlock".to_string()],
                    }));
                },
                2 => { res!(j.append(&Event::Started { id: fmt!("run-{}", i), pid: i })); },
                _ => { res!(j.append(&Event::Closed { reason: fmt!("{}", awkward) })); },
            }
        }
        res!(j.flush());
        let path = j.path().to_path_buf();
        drop(j);

        // The documented idiom, run by a real shell: strip the trailing hash and
        // hash what is left.
        let script = fmt!(
            "set -e; sed 's/,\"entry\":\"[0-9a-f]*\"}}$//' '{}' | \
             while IFS= read -r l; do printf '%s' \"$l\" | sha256sum | cut -d' ' -f1; done",
            path.to_string_lossy());
        let out = res!(Command::new("sh").arg("-c").arg(&script).output(), IO, File);
        if !out.status.success() {
            return Err(err!(
                "The shell verifier would not run: {}",
                String::from_utf8_lossy(&out.stderr); Test, IO));
        }
        let theirs: Vec<String> = String::from_utf8_lossy(&out.stdout)
            .lines().map(|s| s.trim().to_string()).collect();
        let ours: Vec<String> = res!(lines_of(&path)).iter()
            .filter_map(|l| entry_hash_of(l).map(|h| h.to_string()))
            .collect();
        assert_eq!(ours.len(), 200, "every entry should have been written");
        assert_eq!(theirs.len(), ours.len(), "the shell read a different number of lines");
        for (i, (a, b)) in ours.iter().zip(theirs.iter()).enumerate() {
            assert_eq!(a, b, "coreutils and this module disagree on line {}", i + 1);
        }
        Ok(())
    }

    /// A line the format does not allow is refused at the point of building it,
    /// rather than written and discovered later.
    #[test]
    fn test_a_line_that_cannot_be_read_back_is_not_written_00() -> Outcome<()> {
        assert!(build_line(0, 0, "Exec", "{}", GENESIS).is_err(),
            "an upper case kind would need escaping");
        assert!(build_line(0, 0, "exec", "{}", "not-a-hash").is_err(),
            "a malformed predecessor must be refused");
        res!(build_line(0, 0, "exec", "{}", GENESIS));
        Ok(())
    }
}
