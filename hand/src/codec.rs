//! Turning the wire's messages into bytes, and hostile bytes back into messages.
//!
//! Two concerns live here and they are kept apart on purpose:
//!
//! * **The JSON.**  Every [`wire::Req`] and [`wire::Resp`] is a tagged object
//!   carrying a `"t"` discriminator, built and read through `Dat` and
//!   `fe2o3_jdat`'s JSON encoder rather than a parser written here.  The
//!   messages are transport-neutral: the same text is what a native messaging
//!   host writes to stdout and what a WebSocket carries as one text payload.
//! * **The framing.**  [`Frame`] says how one message is marked off from the
//!   next, and it is an enum rather than a trait object because there are two
//!   answers and there will not be many more.
//!
//! Everything that reads is written for input the hand did not create.  A short
//! read, a truncated body, a length prefix that promises a gigabyte, bytes that
//! are not UTF-8, JSON of the wrong shape and a `"t"` from a future build each
//! produce a named [`Fault`], and none of them panics.
//!
//! # The terminal half
//!
//! The pty messages carry their payload as base64 rather than as text, because a
//! terminal is a byte stream and a lossy conversion corrupts exactly the case a
//! terminal exists for.  Two consequences land here:
//!
//! * The base64 is [`oxedyne_fe2o3_text::base64`], which is strict on decode --
//!   non-alphabet characters, misplaced padding, a length that is not a whole
//!   quantum and non-zero trailing bits are all refused.  `data` arrives from a
//!   page, so a decoder that guesses is a decoder that can be steered.
//! * Sizing a [`Resp::Output`] is [`output_frames`], not arithmetic.  Base64
//!   inflates by four thirds *before* the JSON envelope is paid for, and the
//!   envelope holds a caller-supplied identifier, so a byte budget subtracted
//!   from [`FRAME_MAX`] is wrong in both directions.

use crate::wire::{
    Breaks,
    Capture,
    FenceSpec,
    PtySize,
    Req,
    Resp,
    Run,
    RunState,
    Sig,
    Stream,
    CHUNK_MAX,
    FRAME_MAX,
    RUNS_MAX,
    RUN_WHAT_MAX,
    SAFE_INT_MAX,
};

use oxedyne_fe2o3_core::prelude::*;
use oxedyne_fe2o3_text::base64;
use oxedyne_fe2o3_jdat::prelude::*;
use oxedyne_fe2o3_jdat::{
    bdat::limits::DecodeLimits,
    string::dec::DecoderConfig,
    usr::{
        UsrKind,
        UsrKindCode,
        UsrKindId,
    },
};

use std::{
    collections::BTreeMap,
    io::{
        Read,
        Write,
    },
};

// ┌───────────────────────────────────────────────────────────────┐
// │ Limits                                                         │
// └───────────────────────────────────────────────────────────────┘

/// The width of the native messaging length prefix, in bytes.
///
/// Four, native-endian, because that is what Chrome writes and reads.  It is
/// not a choice and it is not negotiable.
pub const LEN_PREFIX: usize = 4;

/// The largest inbound frame the hand will accept.
///
/// Chrome allows an extension→host message of up to 4 GB, which is an offer the
/// hand declines: nothing the page has to say is larger than what the hand is
/// allowed to say back, so the same ceiling applies in both directions and a
/// hostile prefix is refused before a byte of body is read.
pub const INBOUND_MAX: usize = FRAME_MAX;

/// Greatest nesting the decoder will descend to.
///
/// The wire's deepest shape is an [`Req::Exec`] envelope holding a `fence`
/// object holding a list holding a string, so four levels carry the protocol
/// and the rest is slack for a decoder that counts brackets rather than values.
const MAX_DEPTH: usize = 16;

/// The largest run of raw terminal bytes a single [`Resp::Output`] carries.
///
/// Derived from [`CHUNK_MAX`] rather than chosen: base64 turns three bytes into
/// four characters, so this is the byte count whose encoding is the same size as
/// the text an exec chunk may carry, and one pty frame therefore costs the wire
/// no more than one exec frame.
pub const OUTPUT_MAX: usize = CHUNK_MAX / 4 * 3;

// ┌───────────────────────────────────────────────────────────────┐
// │ Faults                                                         │
// └───────────────────────────────────────────────────────────────┘

/// The named ways a frame fails to become a message, or a message a frame.
///
/// Named rather than merely described, because a caller deciding whether to
/// close the connection or answer with a [`Resp::Error`] needs to know *which*
/// thing went wrong, and a substring match on prose is not a decision procedure.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Fault {
    /// The stream ended part-way through a length prefix.
    ShortRead,
    /// The stream ended before the declared number of payload bytes arrived.
    Truncated,
    /// The length prefix declared more than [`INBOUND_MAX`] bytes.
    LengthTooBig,
    /// The payload was not UTF-8.
    NotUtf8,
    /// The payload was not JSON that could be read at all.
    NotJson,
    /// The payload was readable JSON of the wrong shape for what it claims to be.
    WrongShape,
    /// The payload carried a `"t"` this build does not know.
    UnknownTag,
    /// The message would encode to more than [`FRAME_MAX`] bytes.
    FrameTooBig,
    /// The stream could not be read or written at all.
    Io,
}

impl Fault {

    /// Every fault, so a search over them is exhaustive by construction.
    pub const ALL: [Self; 9] = [
        Self::ShortRead,
        Self::Truncated,
        Self::LengthTooBig,
        Self::NotUtf8,
        Self::NotJson,
        Self::WrongShape,
        Self::UnknownTag,
        Self::FrameTooBig,
        Self::Io,
    ];

    /// The stable identifier that begins every message this fault raises.
    pub fn name(&self) -> &'static str {
        match self {
            Self::ShortRead		=> "codec.short-read",
            Self::Truncated		=> "codec.truncated",
            Self::LengthTooBig	=> "codec.length-too-big",
            Self::NotUtf8		=> "codec.not-utf8",
            Self::NotJson		=> "codec.not-json",
            Self::WrongShape	=> "codec.wrong-shape",
            Self::UnknownTag	=> "codec.unknown-tag",
            Self::FrameTooBig	=> "codec.frame-too-big",
            Self::Io			=> "codec.io",
        }
    }

    /// Builds the error this fault raises, with the detail that identifies the case.
    ///
    /// # Arguments
    /// * `detail` - What was wrong, in a sentence a developer reading a journal can use.
    pub fn raise(&self, detail: &str) -> Error<ErrTag> {
        match self {
            Self::ShortRead		=> err!("{}: {}", self.name(), detail; Input, Decode, Missing),
            Self::Truncated		=> err!("{}: {}", self.name(), detail; Input, Decode, Missing),
            Self::LengthTooBig	=> err!("{}: {}", self.name(), detail; Input, Decode, TooBig),
            Self::NotUtf8		=> err!("{}: {}", self.name(), detail; Input, Decode, UTF8),
            Self::NotJson		=> err!("{}: {}", self.name(), detail; Input, Decode, Invalid),
            Self::WrongShape	=> err!("{}: {}", self.name(), detail; Input, Decode, Mismatch),
            Self::UnknownTag	=> err!("{}: {}", self.name(), detail; Input, Decode, Unknown),
            Self::FrameTooBig	=> err!("{}: {}", self.name(), detail; Output, Encode, TooBig),
            Self::Io			=> err!("{}: {}", self.name(), detail; IO, Wire),
        }
    }

    /// The fault an error carries, where it carries one.
    ///
    /// # Arguments
    /// * `e` - The error to inspect.
    pub fn of(e: &Error<ErrTag>) -> Option<Self> {
        for msg in e.msgs() {
            for f in Self::ALL {
                if msg.starts_with(f.name()) {
                    return Some(f);
                }
            }
        }
        None
    }
}

// ┌───────────────────────────────────────────────────────────────┐
// │ Enum vocabulary                                                │
// └───────────────────────────────────────────────────────────────┘

/// The wire spelling of a [`Capture`].
///
/// # Arguments
/// * `c` - The capture mode.
pub fn capture_name(c: Capture) -> &'static str {
    match c {
        Capture::Both	=> "both",
        Capture::Out	=> "out",
        Capture::Err	=> "err",
        Capture::None	=> "none",
    }
}

/// The [`Capture`] a wire spelling names.
///
/// # Arguments
/// * `s` - The word from the `capture` field.
pub fn capture_of(s: &str) -> Outcome<Capture> {
    match s {
        "both"	=> Ok(Capture::Both),
        "out"	=> Ok(Capture::Out),
        "err"	=> Ok(Capture::Err),
        "none"	=> Ok(Capture::None),
        other	=> Err(Fault::WrongShape.raise(&fmt!(
            "The capture mode {:?} is not one of both, out, err or none.", other))),
    }
}

/// The wire spelling of a [`Sig`].
///
/// # Arguments
/// * `s` - The signal.
pub fn sig_name(s: Sig) -> &'static str {
    match s {
        Sig::Term	=> "term",
        Sig::Kill	=> "kill",
        Sig::Int	=> "int",
    }
}

/// The [`Sig`] a wire spelling names.
///
/// # Arguments
/// * `s` - The word from the `sig` field.
pub fn sig_of(s: &str) -> Outcome<Sig> {
    match s {
        "term"	=> Ok(Sig::Term),
        "kill"	=> Ok(Sig::Kill),
        "int"	=> Ok(Sig::Int),
        other	=> Err(Fault::WrongShape.raise(&fmt!(
            "The signal {:?} is not one of term, kill or int.", other))),
    }
}

/// The wire spelling of a [`Stream`].
///
/// # Arguments
/// * `s` - The stream.
pub fn stream_name(s: Stream) -> &'static str {
    match s {
        Stream::Out	=> "out",
        Stream::Err	=> "err",
    }
}

/// The [`Stream`] a wire spelling names.
///
/// # Arguments
/// * `s` - The word from the `stream` field.
pub fn stream_of(s: &str) -> Outcome<Stream> {
    match s {
        "out"	=> Ok(Stream::Out),
        "err"	=> Ok(Stream::Err),
        other	=> Err(Fault::WrongShape.raise(&fmt!(
            "The stream {:?} is neither out nor err.", other))),
    }
}

// ┌───────────────────────────────────────────────────────────────┐
// │ Bytes on the wire                                              │
// └───────────────────────────────────────────────────────────────┘

/// The wire spelling of a run of raw bytes.
///
/// Standard, padded RFC 4648 §4 base64, which is what a browser's `atob` reads
/// and what the `data` field of [`Req::Input`] and [`Resp::Output`] holds.
///
/// # Arguments
/// * `bytes` - The raw bytes.
pub fn data_encode(bytes: &[u8]) -> String {
    base64::encode(bytes)
}

/// The bytes a `data` field carries, refusing anything that is not base64.
///
/// Strict, because this is attacker-reachable input: a character outside the
/// alphabet, whitespace, the URL-safe alphabet, padding in the wrong place, a
/// length that is not a whole four-character quantum and a final quantum whose
/// unused bits are set are each refused rather than guessed at.  Two decoders
/// that disagree about the same string are how a page and a hand end up holding
/// different bytes and both believing they agree.
///
/// # Arguments
/// * `data` - The base64 text.
pub fn data_decode(data: &str) -> Outcome<Vec<u8>> {
    match base64::decode(data) {
        Ok(v) => Ok(v),
        Err(e) => Err(Fault::WrongShape.raise(&fmt!(
            "The \"data\" field is not standard base64: {}.", e.msgs().join("; ")))),
    }
}

/// Refuses a `data` field that is not base64, without keeping the bytes.
///
/// # Arguments
/// * `data` - The base64 text.
fn data_check(data: &str) -> Outcome<()> {
    res!(data_decode(data));
    Ok(())
}

/// The `Dat` object a terminal size encodes to.
///
/// # Arguments
/// * `size` - The size.
fn size_dat(size: &PtySize) -> Dat {
    omapdat!{
        "cols"	=> size.cols,
        "rows"	=> size.rows,
    }
}

// ┌───────────────────────────────────────────────────────────────┐
// │ Reading fields out of a decoded object                         │
// └───────────────────────────────────────────────────────────────┘

/// The decoder configuration every inbound payload is read through.
///
/// JSON rather than JDAT, and bounded in both length and depth, because the
/// text arrives from somewhere the hand does not control.
fn dec_cfg() -> DecoderConfig<BTreeMap<UsrKindCode, UsrKind>, BTreeMap<String, UsrKindId>> {
    DecoderConfig::json(None)
        .with_limits(DecodeLimits::new(MAX_DEPTH, INBOUND_MAX))
}

/// The value at a key, or a fault naming the message and the key that is missing.
///
/// # Arguments
/// * `obj` - The decoded object.
/// * `what` - The message being read, for the error.
/// * `key` - The field wanted.
fn field<'a>(obj: &'a Dat, what: &str, key: &str) -> Outcome<&'a Dat> {
    match res!(obj.map_get(&Dat::Str(key.to_string()))) {
        Some(v) => Ok(v),
        None => Err(Fault::WrongShape.raise(&fmt!(
            "A {:?} message has no {:?} field.", what, key))),
    }
}

/// A string field.
///
/// # Arguments
/// * `obj` - The decoded object.
/// * `what` - The message being read, for the error.
/// * `key` - The field wanted.
fn str_field(obj: &Dat, what: &str, key: &str) -> Outcome<String> {
    let v = res!(field(obj, what, key));
    match v.get_string() {
        Some(s) => Ok(s),
        None => Err(Fault::WrongShape.raise(&fmt!(
            "The {:?} field of a {:?} message is not a string.", key, what))),
    }
}

/// A boolean field.
///
/// # Arguments
/// * `obj` - The decoded object.
/// * `what` - The message being read, for the error.
/// * `key` - The field wanted.
fn bool_field(obj: &Dat, what: &str, key: &str) -> Outcome<bool> {
    let v = res!(field(obj, what, key));
    match v.get_bool() {
        Some(b) => Ok(b),
        None => Err(Fault::WrongShape.raise(&fmt!(
            "The {:?} field of a {:?} message is not a boolean.", key, what))),
    }
}

/// A `u32` field.
///
/// # Arguments
/// * `obj` - The decoded object.
/// * `what` - The message being read, for the error.
/// * `key` - The field wanted.
fn u32_field(obj: &Dat, what: &str, key: &str) -> Outcome<u32> {
    let v = res!(field(obj, what, key));
    match v.get_u32() {
        Some(n) => Ok(n),
        None => Err(Fault::WrongShape.raise(&fmt!(
            "The {:?} field of a {:?} message is not a number in 0..=u32::MAX.", key, what))),
    }
}

/// A `u64` field.
///
/// # Arguments
/// * `obj` - The decoded object.
/// * `what` - The message being read, for the error.
/// * `key` - The field wanted.
fn u64_field(obj: &Dat, what: &str, key: &str) -> Outcome<u64> {
    let v = res!(field(obj, what, key));
    match v.get_u64() {
        Some(n) => Ok(n),
        None => Err(Fault::WrongShape.raise(&fmt!(
            "The {:?} field of a {:?} message is not a number in 0..=u64::MAX.", key, what))),
    }
}

/// An `i32` field, which is how an exit status arrives.
///
/// # Arguments
/// * `obj` - The decoded object.
/// * `what` - The message being read, for the error.
/// * `key` - The field wanted.
fn i32_field(obj: &Dat, what: &str, key: &str) -> Outcome<i32> {
    let v = res!(field(obj, what, key));
    match v.get_i32() {
        Some(n) => Ok(n),
        None => Err(Fault::WrongShape.raise(&fmt!(
            "The {:?} field of a {:?} message is not a number in i32::MIN..=i32::MAX.",
            key, what))),
    }
}

/// A `u16` field, which is how a terminal dimension arrives.
///
/// One check catches four hostile shapes at once: a negative number decodes to a
/// signed daticle, a fractional one to a float, and anything above 65535 to a
/// wider unsigned one, none of which [`Dat::get_u16`] answers.
///
/// # Arguments
/// * `obj` - The decoded object.
/// * `what` - The message being read, for the error.
/// * `key` - The field wanted.
fn u16_field(obj: &Dat, what: &str, key: &str) -> Outcome<u16> {
    let v = res!(field(obj, what, key));
    match v.get_u16() {
        Some(n) => Ok(n),
        None => Err(Fault::WrongShape.raise(&fmt!(
            "The {:?} field of a {:?} message is not a whole number in 0..=65535.",
            key, what))),
    }
}

/// A whole-number field, held to [`SAFE_INT_MAX`] (`REVIEW.md` §3.11).
///
/// Every `u64` on the wire comes through here, so there is one answer to "what
/// happens past 2^53" rather than one per field, and a `u64` added to the wire
/// later inherits it by being read the same way.
///
/// # Why the number is refused rather than clamped
///
/// Clamping was considered and rejected, because the worst defect of the
/// reviewed session was exactly that shape: `extract_json_number` in
/// `src/tools.rs` parsed an exit status as `u64`, so `-1` failed to parse and
/// `.unwrap_or(0)` made it zero -- and a **killed** `cargo test` was presented
/// to the model as `[exit code: 0]`, a crashed build read as a green one
/// (`REVIEW.md` §1.11).  Nothing about it was loud.
///
/// A clamped number here would be the same trade.  `Resp::Ended`'s byte counts
/// exist so the page can notice that output went missing (§1.17), and a count
/// lowered to fit would say that none did; a clamped `seq` breaks the gap
/// detection it exists for, because two frames would compare equal; a clamped
/// `timeout_ms` is a limit the caller did not ask for.  String encoding was the
/// other candidate and was rejected too: it moves the same ceiling into every
/// reader's `BigInt` handling and changes the contract for four fields to fix a
/// case none of them can reach.
///
/// So the rule is the one with no silent arm.  A number that would not survive
/// the crossing is a named [`Fault`] on decode and a refusal to write on encode;
/// both ends fail at the boundary, and neither invents a value the far end would
/// believe.  Nothing legitimate is refused -- the ceiling is 800 exabytes of
/// terminal output, nine petabytes down one pipe, or a wall-clock limit of
/// 285,000 years -- so a number that reaches it is a counter that went wrong or a
/// sender that is not the page, and both are worth hearing about.
///
/// # Arguments
/// * `obj` - The decoded object.
/// * `what` - The message being read, for the error.
/// * `key` - The field wanted.
fn safe_int_field(obj: &Dat, what: &str, key: &str) -> Outcome<u64> {
    let n = res!(u64_field(obj, what, key));
    if n > SAFE_INT_MAX {
        return Err(Fault::WrongShape.raise(&fmt!(
            "The {:?} field of a {:?} message is {}, and the largest whole \
            number both ends can carry unchanged is {}. A larger one does not \
            survive the page's JSON.parse, so whichever end read it would be \
            acting on a rounded number without being told.", key, what, n,
            SAFE_INT_MAX)));
    }
    Ok(n)
}

/// A base64 field, kept as its wire spelling once it is known to be base64.
///
/// # Arguments
/// * `obj` - The decoded object.
/// * `what` - The message being read, for the error.
/// * `key` - The field wanted.
fn b64_field(obj: &Dat, what: &str, key: &str) -> Outcome<String> {
    let s = res!(str_field(obj, what, key));
    match base64::decode(&s) {
        Ok(_) => Ok(s),
        Err(e) => Err(Fault::WrongShape.raise(&fmt!(
            "The {:?} field of a {:?} message is not standard base64: {}.",
            key, what, e.msgs().join("; ")))),
    }
}

/// The terminal size field.
///
/// # Arguments
/// * `obj` - The decoded object.
/// * `what` - The message being read, for the error.
/// * `key` - The field wanted.
fn size_field(obj: &Dat, what: &str, key: &str) -> Outcome<PtySize> {
    let v = res!(field(obj, what, key));
    res!(want_object(v, "terminal size"));
    Ok(PtySize {
        cols: res!(u16_field(v, "size", "cols")),
        rows: res!(u16_field(v, "size", "rows")),
    })
}

/// A list-of-strings field.
///
/// # Arguments
/// * `obj` - The decoded object.
/// * `what` - The message being read, for the error.
/// * `key` - The field wanted.
fn strs_field(obj: &Dat, what: &str, key: &str) -> Outcome<Vec<String>> {
    let v = res!(field(obj, what, key));
    let items = match v.get_list() {
        Some(l) => l,
        None => return Err(Fault::WrongShape.raise(&fmt!(
            "The {:?} field of a {:?} message is not a list.", key, what))),
    };
    let mut out = Vec::with_capacity(items.len());
    for (i, item) in items.iter().enumerate() {
        match item.get_string() {
            Some(s) => out.push(s),
            None => return Err(Fault::WrongShape.raise(&fmt!(
                "Entry {} of the {:?} field of a {:?} message is not a string.",
                i, key, what))),
        }
    }
    Ok(out)
}

/// A list-of-strings field that may be absent, reading as the empty list.
///
/// Absence is a real answer here and it is the SAFE one: the field says which
/// toolchains the user granted, and a request that does not mention any has
/// granted none.  So an older page, a hand-written request, and a request that
/// says `"toolkits":[]` all mean the same thing and all fail closed.  A field
/// that is present and not a list is still an error, because that is a caller
/// saying something this end cannot read rather than saying nothing.
///
/// # Arguments
/// * `obj` - The decoded object.
/// * `what` - The message being read, for the error.
/// * `key` - The field wanted.
fn opt_strs_field(obj: &Dat, what: &str, key: &str) -> Outcome<Vec<String>> {
    match res!(obj.map_get(&Dat::Str(key.to_string()))) {
        Some(_) => strs_field(obj, what, key),
        None    => Ok(Vec::new()),
    }
}

/// A field that is either a string or JSON `null`.
///
/// An absent key reads as absent rather than as an error, since "there is no
/// standard input" and "the field saying so was left out" are the same claim.
///
/// # Arguments
/// * `obj` - The decoded object.
/// * `what` - The message being read, for the error.
/// * `key` - The field wanted.
fn opt_str_field(obj: &Dat, what: &str, key: &str) -> Outcome<Option<String>> {
    let v = match res!(obj.map_get(&Dat::Str(key.to_string()))) {
        Some(v) => v,
        None => return Ok(None),
    };
    match v {
        Dat::Str(s) => Ok(Some(s.clone())),
        // `null` decodes to an absent option, which is exactly what it means.
        Dat::Opt(b) => match b.as_ref() {
            None => Ok(None),
            Some(Dat::Str(s)) => Ok(Some(s.clone())),
            Some(_) => Err(Fault::WrongShape.raise(&fmt!(
                "The {:?} field of a {:?} message is neither a string nor null.", key, what))),
        },
        _ => Err(Fault::WrongShape.raise(&fmt!(
            "The {:?} field of a {:?} message is neither a string nor null.", key, what))),
    }
}

/// The environment field, a list of two-element `[name, value]` lists.
///
/// # Arguments
/// * `obj` - The decoded object.
/// * `what` - The message being read, for the error.
/// * `key` - The field wanted.
fn env_field(obj: &Dat, what: &str, key: &str) -> Outcome<Vec<(String, String)>> {
    let v = res!(field(obj, what, key));
    let pairs = match v.get_list() {
        Some(l) => l,
        None => return Err(Fault::WrongShape.raise(&fmt!(
            "The {:?} field of a {:?} message is not a list.", key, what))),
    };
    let mut out = Vec::with_capacity(pairs.len());
    for (i, pair) in pairs.iter().enumerate() {
        let kv = match pair.get_list() {
            Some(l) => l,
            None => return Err(Fault::WrongShape.raise(&fmt!(
                "Entry {} of the {:?} field of a {:?} message is not a list.", i, key, what))),
        };
        if kv.len() != 2 {
            return Err(Fault::WrongShape.raise(&fmt!(
                "Entry {} of the {:?} field of a {:?} message has {} items, not the \
                two an environment pair has.", i, key, what, kv.len())));
        }
        match (kv[0].get_string(), kv[1].get_string()) {
            (Some(k), Some(val)) => out.push((k, val)),
            _ => return Err(Fault::WrongShape.raise(&fmt!(
                "Entry {} of the {:?} field of a {:?} message is not a pair of strings.",
                i, key, what))),
        }
    }
    Ok(out)
}

/// The `runs` field of a [`Resp::Runs`].
///
/// # Arguments
/// * `obj` - The decoded object.
fn runs_field(obj: &Dat) -> Outcome<Vec<Run>> {
    let v = res!(field(obj, "runs", "runs"));
    let items = match v.get_list() {
        Some(l) => l,
        None => return Err(Fault::WrongShape.raise(&fmt!(
            "The \"runs\" field of a \"runs\" message is not a list."))),
    };
    if items.len() > RUNS_MAX {
        return Err(Fault::WrongShape.raise(&fmt!(
            "A \"runs\" message listed {} runs and {} is the most one carries. What did not \
            fit is counted in \"more\" rather than sent.", items.len(), RUNS_MAX)));
    }
    let mut out = Vec::with_capacity(items.len());
    for (i, it) in items.iter().enumerate() {
        res!(want_object(it, "run"));
        let what = res!(str_field(it, "run", "what"));
        if what.len() > RUN_WHAT_MAX {
            return Err(Fault::WrongShape.raise(&fmt!(
                "Entry {} of a \"runs\" message carries a command line of {} bytes and {} is \
                the most one carries.", i, what.len(), RUN_WHAT_MAX)));
        }
        out.push(Run {
            id:    res!(str_field(it, "run", "id")),
            pid:   res!(u32_field(it, "run", "pid")),
            what,
            state: res!(run_state_of(&res!(str_field(it, "run", "state")))),
            secs:  res!(u32_field(it, "run", "secs")),
        });
    }
    Ok(out)
}

/// The word a [`RunState`] travels under, read back.
///
/// # Arguments
/// * `s` - The word.
fn run_state_of(s: &str) -> Outcome<RunState> {
    match s {
        "running"	=> Ok(RunState::Running),
        "standing"	=> Ok(RunState::Standing),
        other => Err(Fault::WrongShape.raise(&fmt!(
            "A listed run says its state is {:?}, and the only two are \"running\" -- the \
            command itself has not finished -- and \"standing\" -- it has, and the process \
            group it led has not emptied.", other))),
    }
}

/// The fence field.
///
/// # Arguments
/// * `obj` - The decoded object.
/// * `what` - The message being read, for the error.
/// * `key` - The field wanted.
fn fence_field(obj: &Dat, what: &str, key: &str) -> Outcome<FenceSpec> {
    let v = res!(field(obj, what, key));
    res!(want_object(v, "fence"));
    Ok(FenceSpec {
        rw:   res!(strs_field(v, "fence", "rw")),
        ro:   res!(strs_field(v, "fence", "ro")),
        deny: res!(strs_field(v, "fence", "deny")),
        net:  res!(bool_field(v, "fence", "net")),
    })
}

/// Refuses anything that is not a JSON object.
///
/// The JDAT decoder is happy to read a bare string, a bare number or nothing at
/// all, none of which is a message, so the top of every payload is checked
/// before a field is looked for in it.
///
/// # Arguments
/// * `d` - The decoded value.
/// * `what` - What was expected, for the error.
/// Which breaks a `verify` request asks for.
///
/// Two fields rather than one, because `all` and `none` are decisions and a
/// break name is a value, and a single string field would make `all` a name
/// somebody could give a break.  `one` without a `break` is refused rather than
/// read as `none`: a request that asked to prove something must not quietly
/// become a request that proves nothing.
///
/// # Arguments
/// * `obj` - The decoded object.
fn breaks_of(obj: &Dat) -> Outcome<Breaks> {
    let word = res!(str_field(obj, "verify", "breaks"));
    match word.as_str() {
        "all"	=> Ok(Breaks::All),
        "none"	=> Ok(Breaks::None),
        "one"	=> match res!(opt_str_field(obj, "verify", "break")) {
            Some(b) if !b.is_empty()	=> Ok(Breaks::One(b)),
            _				=> Err(Fault::WrongShape.raise(
                "A verify asking for one break did not say which. Send \"breaks\":\"one\" \
                with a \"break\" naming one the verifier declares, or \"breaks\":\"all\".")),
        },
        other	=> Err(Fault::WrongShape.raise(&fmt!(
            "A verify's \"breaks\" is {:?}, which is none of \"all\", \"one\" or \"none\".",
            other))),
    }
}

fn want_object(d: &Dat, what: &str) -> Outcome<()> {
    match d {
        Dat::Map(_) | Dat::OrdMap(_) => Ok(()),
        other => Err(Fault::WrongShape.raise(&fmt!(
            "A {} is a JSON object; this is {}.", what, other.kind()))),
    }
}

/// The `"t"` discriminator, which says which message this is.
///
/// # Arguments
/// * `obj` - The decoded object.
fn tag_of(obj: &Dat) -> Outcome<String> {
    match res!(obj.map_get(&Dat::Str("t".to_string()))) {
        Some(Dat::Str(s)) => Ok(s.clone()),
        Some(_) => Err(Fault::WrongShape.raise(
            "The \"t\" field, which says which message this is, is not a string.")),
        None => Err(Fault::WrongShape.raise(
            "There is no \"t\" field, so there is no saying which message this is.")),
    }
}

/// A list of strings as a `Dat`, without the `Vek` that `From<Vec<String>>` gives.
///
/// # Arguments
/// * `v` - The strings.
fn strs(v: &[String]) -> Dat {
    Dat::List(v.iter().map(|s| Dat::Str(s.clone())).collect())
}

// ┌───────────────────────────────────────────────────────────────┐
// │ Strict JSON, before the decoder is asked anything              │
// └───────────────────────────────────────────────────────────────┘

/// Refuses a payload that is not exactly one RFC 8259 JSON value.
///
/// Two findings live here and they are the same finding twice.
///
/// * `REVIEW.md` §3.12: the JDAT decoder is a *superset* of JSON, so
///   `{'t':'bye'}`, `{t:"bye"}`, a trailing comma and a `#` comment are all
///   accepted here and all rejected by `JSON.parse`.
/// * `REVIEW.md` §3.2: it also stops at the end of the first value, so a payload
///   holding two objects runs the first and discards the second in silence.
///
/// Either way the hand and any second reader of the same bytes -- the page, a
/// journal, a policy layer, a reviewer with `jq` -- disagree about what the
/// frame said, and a protocol whose meaning depends on which parser you use has
/// no meaning.  So the text is scanned once, strictly, before the decoder is
/// asked anything, and what the decoder then sees is JSON both ends agree on.
///
/// # Arguments
/// * `txt` - The payload.
fn want_strict_json(txt: &str) -> Outcome<()> {
    let b = txt.as_bytes();
    let start = skip_ws(b, 0);
    let end = res!(scan_value(b, start, 0));
    let tail = skip_ws(b, end);
    if tail != b.len() {
        return Err(Fault::NotJson.raise(&fmt!(
            "The payload carries {} more bytes after the message ends at offset \
            {}. One frame is one message; a reader that stopped at the first \
            value would run it and never see the rest.",
            b.len() - tail, end)));
    }
    Ok(())
}

/// The first index at or after `i` that is not JSON whitespace.
///
/// The four bytes RFC 8259 allows and no others: a vertical tab or a form feed
/// is not whitespace to `JSON.parse` and is not whitespace here.
///
/// # Arguments
/// * `b` - The payload.
/// * `i` - Where to start.
fn skip_ws(b: &[u8], mut i: usize) -> usize {
    while i < b.len() && matches!(b[i], b' ' | b'\t' | b'\n' | b'\r') {
        i += 1;
    }
    i
}

/// Scans one value, returning the index just past it.
///
/// Recursive, and bounded by [`MAX_DEPTH`] rather than by the stack: a payload
/// of a hundred thousand open brackets is refused at the sixteenth.
///
/// # Arguments
/// * `b` - The payload.
/// * `i` - Where the value starts.
/// * `depth` - How deep this value sits.
fn scan_value(b: &[u8], i: usize, depth: usize) -> Outcome<usize> {
    if depth > MAX_DEPTH {
        return Err(Fault::NotJson.raise(&fmt!(
            "The payload nests more than {} levels deep at offset {}.", MAX_DEPTH, i)));
    }
    if i >= b.len() {
        return Err(Fault::NotJson.raise(
            "The payload ends where a value was expected."));
    }
    match b[i] {
        b'{'			=> scan_object(b, i, depth),
        b'['			=> scan_array(b, i, depth),
        b'"'			=> scan_string(b, i),
        b't'			=> scan_word(b, i, "true"),
        b'f'			=> scan_word(b, i, "false"),
        b'n'			=> scan_word(b, i, "null"),
        b'-' | b'0'..=b'9'	=> scan_number(b, i),
        other			=> Err(Fault::NotJson.raise(&fmt!(
            "A JSON value cannot begin with {:?}, at offset {}.",
            char::from(other), i))),
    }
}

/// Scans one object, returning the index just past its closing brace.
///
/// # Arguments
/// * `b` - The payload.
/// * `i` - The opening brace.
/// * `depth` - How deep the object sits.
fn scan_object(b: &[u8], i: usize, depth: usize) -> Outcome<usize> {
    let mut i = skip_ws(b, i + 1);
    if i < b.len() && b[i] == b'}' {
        return Ok(i + 1);
    }
    loop {
        i = skip_ws(b, i);
        if i >= b.len() || b[i] != b'"' {
            // Also where a trailing comma lands, since what follows one must be
            // a key and a `}` is not one.
            return Err(Fault::NotJson.raise(&fmt!(
                "A JSON object member needs a double-quoted key, and offset {} \
                is not one.", i)));
        }
        i = res!(scan_string(b, i));
        i = skip_ws(b, i);
        if i >= b.len() || b[i] != b':' {
            return Err(Fault::NotJson.raise(&fmt!(
                "A JSON object member needs a colon after its key, at offset {}.", i)));
        }
        i = skip_ws(b, i + 1);
        i = res!(scan_value(b, i, depth + 1));
        i = skip_ws(b, i);
        if i >= b.len() {
            return Err(Fault::NotJson.raise("The payload ends inside an object."));
        }
        match b[i] {
            b','	=> i += 1,
            b'}'	=> return Ok(i + 1),
            other	=> return Err(Fault::NotJson.raise(&fmt!(
                "A JSON object member is followed by a comma or a brace, not \
                {:?}, at offset {}.", char::from(other), i))),
        }
    }
}

/// Scans one array, returning the index just past its closing bracket.
///
/// # Arguments
/// * `b` - The payload.
/// * `i` - The opening bracket.
/// * `depth` - How deep the array sits.
fn scan_array(b: &[u8], i: usize, depth: usize) -> Outcome<usize> {
    let mut i = skip_ws(b, i + 1);
    if i < b.len() && b[i] == b']' {
        return Ok(i + 1);
    }
    loop {
        i = skip_ws(b, i);
        // A trailing comma lands here, where `]` is not the start of a value.
        i = res!(scan_value(b, i, depth + 1));
        i = skip_ws(b, i);
        if i >= b.len() {
            return Err(Fault::NotJson.raise("The payload ends inside an array."));
        }
        match b[i] {
            b','	=> i += 1,
            b']'	=> return Ok(i + 1),
            other	=> return Err(Fault::NotJson.raise(&fmt!(
                "A JSON array element is followed by a comma or a bracket, not \
                {:?}, at offset {}.", char::from(other), i))),
        }
    }
}

/// Scans one string, returning the index just past its closing quote.
///
/// # Arguments
/// * `b` - The payload.
/// * `i` - The opening quote.
fn scan_string(b: &[u8], i: usize) -> Outcome<usize> {
    let mut i = i + 1;
    while i < b.len() {
        match b[i] {
            b'"' => return Ok(i + 1),
            b'\\' => {
                i += 1;
                if i >= b.len() {
                    return Err(Fault::NotJson.raise(
                        "The payload ends inside a string escape."));
                }
                match b[i] {
                    b'"' | b'\\' | b'/' | b'b' | b'f' | b'n' | b'r' | b't' => i += 1,
                    b'u' => {
                        if i + 4 >= b.len() {
                            return Err(Fault::NotJson.raise(
                                "The payload ends inside a \\u escape."));
                        }
                        for k in 1..=4 {
                            if !b[i + k].is_ascii_hexdigit() {
                                return Err(Fault::NotJson.raise(&fmt!(
                                    "A \\u escape needs four hexadecimal digits, \
                                    at offset {}.", i)));
                            }
                        }
                        i += 5;
                    },
                    other => return Err(Fault::NotJson.raise(&fmt!(
                        "{:?} is not a JSON string escape, at offset {}.",
                        char::from(other), i))),
                }
            },
            // A raw control byte in a string is what a terminal's output would
            // put there, and JSON requires it escaped.
            c if c < 0x20 => return Err(Fault::NotJson.raise(&fmt!(
                "A JSON string cannot hold the unescaped control byte {:#04x}, \
                at offset {}.", c, i))),
            _ => i += 1,
        }
    }
    Err(Fault::NotJson.raise("The payload ends inside a string."))
}

/// Scans one number, returning the index just past it.
///
/// # Arguments
/// * `b` - The payload.
/// * `i` - The first character of the number.
fn scan_number(b: &[u8], i: usize) -> Outcome<usize> {
    let mut i = i;
    let bad = |at: usize| Fault::NotJson.raise(&fmt!(
        "A JSON number is malformed at offset {}.", at));
    if b[i] == b'-' {
        i += 1;
    }
    if i >= b.len() {
        return Err(bad(i));
    }
    if b[i] == b'0' {
        // A leading zero admits no further digits, so `01` is not a number.
        i += 1;
    } else if b[i].is_ascii_digit() {
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
    } else {
        return Err(bad(i));
    }
    if i < b.len() && b[i] == b'.' {
        i += 1;
        if i >= b.len() || !b[i].is_ascii_digit() {
            return Err(bad(i));
        }
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        i += 1;
        if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
            i += 1;
        }
        if i >= b.len() || !b[i].is_ascii_digit() {
            return Err(bad(i));
        }
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
    }
    Ok(i)
}

/// Scans one of the three bare words, returning the index just past it.
///
/// # Arguments
/// * `b` - The payload.
/// * `i` - Where the word starts.
/// * `word` - The word expected.
fn scan_word(b: &[u8], i: usize, word: &str) -> Outcome<usize> {
    if b.len() - i >= word.len() && &b[i..i + word.len()] == word.as_bytes() {
        Ok(i + word.len())
    } else {
        Err(Fault::NotJson.raise(&fmt!(
            "A JSON value beginning here can only be {:?}, at offset {}.", word, i)))
    }
}

// ┌───────────────────────────────────────────────────────────────┐
// │ JSON: requests                                                 │
// └───────────────────────────────────────────────────────────────┘

/// The `Dat` object a request encodes to.
///
/// Order-preserving, so the text on the wire reads in the order the contract
/// states rather than in whatever order a sorted key set produces.
///
/// # Arguments
/// * `req` - The request.
fn req_dat(req: &Req) -> Dat {
    match req {
        Req::Hello { proto, client } => omapdat!{
            "t"			=> "hello",
            "proto"		=> *proto,
            "client"	=> Dat::Str(client.clone()),
        },
        Req::Exec { id, argv, cwd, env, stdin, timeout_ms, capture, fence, toolkits } => {
            let pairs = env.iter()
                .map(|(k, v)| Dat::List(vec![Dat::Str(k.clone()), Dat::Str(v.clone())]))
                .collect::<Vec<_>>();
            omapdat!{
                "t"				=> "exec",
                "id"			=> Dat::Str(id.clone()),
                "argv"			=> strs(argv),
                "cwd"			=> Dat::Str(cwd.clone()),
                "env"			=> Dat::List(pairs),
                "stdin"			=> match stdin {
                    Some(s)	=> Dat::Str(s.clone()),
                    None	=> Dat::Opt(Box::new(None)),
                },
                "timeout_ms"	=> *timeout_ms,
                "capture"		=> capture_name(*capture),
                "fence"			=> omapdat!{
                    "rw"	=> strs(&fence.rw),
                    "ro"	=> strs(&fence.ro),
                    "deny"	=> strs(&fence.deny),
                    "net"	=> fence.net,
                },
                "toolkits"		=> strs(toolkits),
            }
        },
        Req::Verify { id, name, breaks, timeout_ms } => omapdat!{
            "t"				=> "verify",
            "id"			=> Dat::Str(id.clone()),
            "name"			=> Dat::Str(name.clone()),
            "breaks"		=> Dat::Str(breaks.word().to_string()),
            "break"			=> match breaks {
                Breaks::One(b)	=> Dat::Str(b.clone()),
                _		=> Dat::Opt(Box::new(None)),
            },
            "timeout_ms"	=> *timeout_ms,
        },
        Req::Signal { id, sig } => omapdat!{
            "t"		=> "signal",
            "id"	=> Dat::Str(id.clone()),
            "sig"	=> sig_name(*sig),
        },
        Req::Open { id, argv, cwd, env, size, fence, toolkits } => {
            let pairs = env.iter()
                .map(|(k, v)| Dat::List(vec![Dat::Str(k.clone()), Dat::Str(v.clone())]))
                .collect::<Vec<_>>();
            omapdat!{
                "t"		=> "open",
                "id"	=> Dat::Str(id.clone()),
                "argv"	=> strs(argv),
                "cwd"	=> Dat::Str(cwd.clone()),
                "env"	=> Dat::List(pairs),
                "size"	=> size_dat(size),
                "fence"	=> omapdat!{
                    "rw"	=> strs(&fence.rw),
                    "ro"	=> strs(&fence.ro),
                    "deny"	=> strs(&fence.deny),
                    "net"	=> fence.net,
                },
                "toolkits"	=> strs(toolkits),
            }
        },
        Req::Input { id, data } => omapdat!{
            "t"		=> "input",
            "id"	=> Dat::Str(id.clone()),
            "data"	=> Dat::Str(data.clone()),
        },
        Req::Resize { id, size } => omapdat!{
            "t"		=> "resize",
            "id"	=> Dat::Str(id.clone()),
            "size"	=> size_dat(size),
        },
        Req::Runs => omapdat!{
            "t"	=> "runs",
        },
        Req::Bye => omapdat!{
            "t"	=> "bye",
        },
    }
}

/// Refuses a request the hand should never put on the wire.
///
/// The decode side already refuses these, and encoding is where a bug in the
/// hand's own code would otherwise become a page's problem: a `data` that is not
/// base64 is a mistake somewhere upstream of here, and it is caught before it is
/// written rather than after the far end fails to decode it.  A `timeout_ms`
/// past [`SAFE_INT_MAX`] is the same case in the other direction -- the hand
/// composes requests in the Cloud tier's tests and in `dev/`, and a limit the
/// far end would read as a different limit is not a limit.
///
/// # Arguments
/// * `req` - The request.
fn check_req(req: &Req) -> Outcome<()> {
    match req {
        Req::Input { data, .. } => res!(data_check(data)),
        Req::Exec { id, timeout_ms, .. } =>
            res!(safe_int(*timeout_ms, id, "the wall-clock limit")),
        Req::Verify { id, timeout_ms, .. } =>
            res!(safe_int(*timeout_ms, id, "the whole sequence's budget")),
        _ => (),
    }
    Ok(())
}

/// The JSON text of a request.
///
/// # Arguments
/// * `req` - The request.
pub fn req_json(req: &Req) -> Outcome<String> {
    res!(check_req(req));
    Ok(res!(req_dat(req).json()))
}

/// The request a JSON text carries.
///
/// # Arguments
/// * `txt` - The payload, without any framing.
pub fn req_of_json(txt: &str) -> Outcome<Req> {
    res!(want_strict_json(txt));
    let obj = match Dat::decode_string_with_config(txt, &dec_cfg()) {
        Ok(d) => d,
        Err(e) => return Err(Fault::NotJson.raise(&fmt!(
            "The payload is not JSON that can be read: {}.",
            e.msgs().join("; ")))),
    };
    res!(want_object(&obj, "request"));
    let t = res!(tag_of(&obj));
    match t.as_str() {
        "hello" => Ok(Req::Hello {
            proto:  res!(u32_field(&obj, "hello", "proto")),
            client: res!(str_field(&obj, "hello", "client")),
        }),
        "exec" => Ok(Req::Exec {
            id:         res!(str_field(&obj, "exec", "id")),
            argv:       res!(strs_field(&obj, "exec", "argv")),
            cwd:        res!(str_field(&obj, "exec", "cwd")),
            env:        res!(env_field(&obj, "exec", "env")),
            stdin:      res!(opt_str_field(&obj, "exec", "stdin")),
            timeout_ms: res!(safe_int_field(&obj, "exec", "timeout_ms")),
            capture:    res!(capture_of(&res!(str_field(&obj, "exec", "capture")))),
            fence:      res!(fence_field(&obj, "exec", "fence")),
            toolkits:   res!(opt_strs_field(&obj, "exec", "toolkits")),
        }),
        "verify" => Ok(Req::Verify {
            id:         res!(str_field(&obj, "verify", "id")),
            name:       res!(str_field(&obj, "verify", "name")),
            breaks:     res!(breaks_of(&obj)),
            timeout_ms: res!(safe_int_field(&obj, "verify", "timeout_ms")),
        }),
        "signal" => Ok(Req::Signal {
            id:  res!(str_field(&obj, "signal", "id")),
            sig: res!(sig_of(&res!(str_field(&obj, "signal", "sig")))),
        }),
        "open" => Ok(Req::Open {
            id:    res!(str_field(&obj, "open", "id")),
            argv:  res!(strs_field(&obj, "open", "argv")),
            cwd:   res!(str_field(&obj, "open", "cwd")),
            env:   res!(env_field(&obj, "open", "env")),
            size:  res!(size_field(&obj, "open", "size")),
            fence: res!(fence_field(&obj, "open", "fence")),
            toolkits: res!(opt_strs_field(&obj, "open", "toolkits")),
        }),
        "input" => Ok(Req::Input {
            id:   res!(str_field(&obj, "input", "id")),
            data: res!(b64_field(&obj, "input", "data")),
        }),
        "resize" => Ok(Req::Resize {
            id:   res!(str_field(&obj, "resize", "id")),
            size: res!(size_field(&obj, "resize", "size")),
        }),
        "runs" => Ok(Req::Runs),
        "bye" => Ok(Req::Bye),
        other => Err(Fault::UnknownTag.raise(&fmt!(
            "There is no request called {:?}. This page is asking for something \
            this hand has never heard of; one of the two is newer than the other.",
            other))),
    }
}

// ┌───────────────────────────────────────────────────────────────┐
// │ JSON: responses                                                │
// └───────────────────────────────────────────────────────────────┘

/// The `Dat` object a response encodes to.
///
/// # Arguments
/// * `resp` - The response.
fn resp_dat(resp: &Resp) -> Dat {
    match resp {
        Resp::Hello { proto, host, version, os, caps } => omapdat!{
            "t"			=> "hello",
            "proto"		=> *proto,
            "host"		=> Dat::Str(host.clone()),
            "version"	=> Dat::Str(version.clone()),
            "os"		=> Dat::Str(os.clone()),
            "caps"		=> strs(caps),
        },
        Resp::Started { id, pid } => omapdat!{
            "t"		=> "started",
            "id"	=> Dat::Str(id.clone()),
            "pid"	=> *pid,
        },
        Resp::Chunk { id, stream, seq, data } => omapdat!{
            "t"			=> "chunk",
            "id"		=> Dat::Str(id.clone()),
            "stream"	=> stream_name(*stream),
            "seq"		=> *seq,
            "data"		=> Dat::Str(data.clone()),
        },
        Resp::Ended { id, exit, timed_out, killed, out_bytes, err_bytes } => omapdat!{
            "t"			=> "ended",
            "id"		=> Dat::Str(id.clone()),
            "exit"		=> *exit,
            "timed_out"	=> *timed_out,
            "killed"	=> *killed,
            "out_bytes"	=> *out_bytes,
            "err_bytes"	=> *err_bytes,
        },
        Resp::Refused { id, reason } => omapdat!{
            "t"			=> "refused",
            "id"		=> Dat::Str(id.clone()),
            "reason"	=> Dat::Str(reason.clone()),
        },
        Resp::Opened { id, pid } => omapdat!{
            "t"		=> "opened",
            "id"	=> Dat::Str(id.clone()),
            "pid"	=> *pid,
        },
        Resp::Output { id, seq, data } => omapdat!{
            "t"		=> "output",
            "id"	=> Dat::Str(id.clone()),
            "seq"	=> *seq,
            "data"	=> Dat::Str(data.clone()),
        },
        Resp::Runs { runs, more } => omapdat!{
            "t"		=> "runs",
            "runs"	=> Dat::List(runs.iter().map(|r| omapdat!{
                "id"	=> Dat::Str(r.id.clone()),
                "pid"	=> r.pid,
                "what"	=> Dat::Str(r.what.clone()),
                "state"	=> r.state.word(),
                "secs"	=> r.secs,
            }).collect()),
            "more"	=> *more,
        },
        Resp::Closed { id, exit, killed } => omapdat!{
            "t"			=> "closed",
            "id"		=> Dat::Str(id.clone()),
            "exit"		=> *exit,
            "killed"	=> *killed,
        },
        Resp::Error { id, message } => omapdat!{
            "t"			=> "error",
            "id"		=> match id {
                Some(s)	=> Dat::Str(s.clone()),
                None	=> Dat::Opt(Box::new(None)),
            },
            "message"	=> Dat::Str(message.clone()),
        },
    }
}

/// Refuses a response the hand should never put on the wire.
///
/// Every one of these is a case where writing the frame would be worse than
/// failing to: a `data` that is not base64 arrives at the page as bytes it
/// cannot recover, and any number above [`SAFE_INT_MAX`] arrives rounded, which
/// silently breaks whatever the number was for instead of loudly breaking the
/// send.  The failure is at the hand's own boundary, before a byte is written,
/// so a counter that has gone wrong is heard about here rather than believed
/// there.
///
/// # Arguments
/// * `resp` - The response.
fn check_resp(resp: &Resp) -> Outcome<()> {
    match resp {
        Resp::Output { id, seq, data } => {
            res!(data_check(data));
            res!(safe_int(*seq, id, "the sequence number of an output frame"));
        },
        Resp::Chunk { id, seq, .. } => {
            res!(safe_int(*seq, id, "the sequence number of an output chunk"));
        },
        Resp::Ended { id, out_bytes, err_bytes, .. } => {
            res!(safe_int(*out_bytes, id, "the standard output byte count"));
            res!(safe_int(*err_bytes, id, "the standard error byte count"));
        },
        _ => (),
    }
    Ok(())
}

/// Refuses a number the far end would read as a different number.
///
/// # Arguments
/// * `n` - The value.
/// * `id` - The run or session it belongs to, for the sentence.
/// * `what` - What the number is, for the sentence.
fn safe_int(n: u64, id: &str, what: &str) -> Outcome<()> {
    if n > SAFE_INT_MAX {
        return Err(Fault::WrongShape.raise(&fmt!(
            "For {:?}, {} is {}, and the largest whole number the page can read \
            unchanged is {}. The frame was not written, because the page would \
            read a rounded number and believe it.", id, what, n, SAFE_INT_MAX)));
    }
    Ok(())
}

/// The JSON text of a response.
///
/// # Arguments
/// * `resp` - The response.
pub fn resp_json(resp: &Resp) -> Outcome<String> {
    res!(check_resp(resp));
    Ok(res!(resp_dat(resp).json()))
}

/// The response a JSON text carries.
///
/// # Arguments
/// * `txt` - The payload, without any framing.
pub fn resp_of_json(txt: &str) -> Outcome<Resp> {
    res!(want_strict_json(txt));
    let obj = match Dat::decode_string_with_config(txt, &dec_cfg()) {
        Ok(d) => d,
        Err(e) => return Err(Fault::NotJson.raise(&fmt!(
            "The payload is not JSON that can be read: {}.",
            e.msgs().join("; ")))),
    };
    res!(want_object(&obj, "response"));
    let t = res!(tag_of(&obj));
    match t.as_str() {
        "hello" => Ok(Resp::Hello {
            proto:   res!(u32_field(&obj, "hello", "proto")),
            host:    res!(str_field(&obj, "hello", "host")),
            version: res!(str_field(&obj, "hello", "version")),
            os:      res!(str_field(&obj, "hello", "os")),
            caps:    res!(strs_field(&obj, "hello", "caps")),
        }),
        "started" => Ok(Resp::Started {
            id:  res!(str_field(&obj, "started", "id")),
            pid: res!(u32_field(&obj, "started", "pid")),
        }),
        "chunk" => Ok(Resp::Chunk {
            id:     res!(str_field(&obj, "chunk", "id")),
            stream: res!(stream_of(&res!(str_field(&obj, "chunk", "stream")))),
            seq:    res!(safe_int_field(&obj, "chunk", "seq")),
            data:   res!(str_field(&obj, "chunk", "data")),
        }),
        "ended" => Ok(Resp::Ended {
            id:        res!(str_field(&obj, "ended", "id")),
            exit:      res!(i32_field(&obj, "ended", "exit")),
            timed_out: res!(bool_field(&obj, "ended", "timed_out")),
            killed:    res!(bool_field(&obj, "ended", "killed")),
            out_bytes: res!(safe_int_field(&obj, "ended", "out_bytes")),
            err_bytes: res!(safe_int_field(&obj, "ended", "err_bytes")),
        }),
        "refused" => Ok(Resp::Refused {
            id:     res!(str_field(&obj, "refused", "id")),
            reason: res!(str_field(&obj, "refused", "reason")),
        }),
        "opened" => Ok(Resp::Opened {
            id:  res!(str_field(&obj, "opened", "id")),
            pid: res!(u32_field(&obj, "opened", "pid")),
        }),
        "output" => Ok(Resp::Output {
            id:   res!(str_field(&obj, "output", "id")),
            seq:  res!(safe_int_field(&obj, "output", "seq")),
            data: res!(b64_field(&obj, "output", "data")),
        }),
        "closed" => Ok(Resp::Closed {
            id:     res!(str_field(&obj, "closed", "id")),
            exit:   res!(i32_field(&obj, "closed", "exit")),
            killed: res!(bool_field(&obj, "closed", "killed")),
        }),
        "runs" => Ok(Resp::Runs {
            runs: res!(runs_field(&obj)),
            more: res!(u32_field(&obj, "runs", "more")),
        }),
        "error" => Ok(Resp::Error {
            id:      res!(opt_str_field(&obj, "error", "id")),
            message: res!(str_field(&obj, "error", "message")),
        }),
        other => Err(Fault::UnknownTag.raise(&fmt!(
            "There is no response called {:?}. This hand is answering with \
            something the page has never heard of; one of the two is newer than \
            the other.", other))),
    }
}

// ┌───────────────────────────────────────────────────────────────┐
// │ Framing                                                        │
// └───────────────────────────────────────────────────────────────┘

/// How one message is marked off from the next.
///
/// An enum and not a trait object: there are two answers, the second exists so
/// that the protocol is transport-neutral now rather than after a rewrite, and
/// neither needs a vtable to be reached.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Frame {
    /// Chrome's native messaging format: a 4-byte native-endian length prefix
    /// followed by the UTF-8 JSON.
    ///
    /// Native-endian, not network-endian, which is a wart in Chrome's design
    /// and not one either end gets to correct.
    NativeMessaging,
    /// The identical JSON as one WebSocket text payload, with no prefix.
    ///
    /// The transport marks off its own messages, so the framing here is the
    /// absence of framing.
    WebSocket,
}

impl Frame {

    /// The bytes one payload occupies on this framing.
    ///
    /// # Arguments
    /// * `txt` - The JSON text.
    ///
    /// # Returns
    /// The whole frame, or a [`Fault::FrameTooBig`] where it would exceed
    /// [`FRAME_MAX`]. The refusal matters: Chrome drops the connection without
    /// ceremony when a host writes more than it allows, so a frame that would
    /// be over the cap must never reach the pipe.
    pub fn wrap(&self, txt: &str) -> Outcome<Vec<u8>> {
        let body = txt.as_bytes();
        let total = match self {
            Self::NativeMessaging	=> LEN_PREFIX + body.len(),
            Self::WebSocket			=> body.len(),
        };
        if total > FRAME_MAX {
            return Err(Fault::FrameTooBig.raise(&fmt!(
                "The frame is {} bytes and the cap is {}. It was not written, \
                because writing it would end the connection rather than \
                deliver it.", total, FRAME_MAX)));
        }
        match self {
            Self::NativeMessaging => {
                // The cast is safe: `total` is at or below FRAME_MAX, which is
                // far inside u32.
                let n = body.len() as u32;
                let mut out = Vec::with_capacity(total);
                out.extend_from_slice(&n.to_ne_bytes());
                out.extend_from_slice(body);
                Ok(out)
            },
            Self::WebSocket => Ok(body.to_vec()),
        }
    }

    /// The payload a whole frame carries.
    ///
    /// # Arguments
    /// * `buf` - Exactly one frame, with its prefix where the framing has one.
    pub fn unwrap(&self, buf: &[u8]) -> Outcome<String> {
        let body = match self {
            Self::NativeMessaging => {
                if buf.len() < LEN_PREFIX {
                    return Err(Fault::ShortRead.raise(&fmt!(
                        "A frame needs a {}-byte length prefix and only {} bytes \
                        arrived.", LEN_PREFIX, buf.len())));
                }
                let mut pre = [0u8; LEN_PREFIX];
                pre.copy_from_slice(&buf[..LEN_PREFIX]);
                let n = u32::from_ne_bytes(pre) as usize;
                if n > INBOUND_MAX {
                    return Err(Fault::LengthTooBig.raise(&fmt!(
                        "The prefix declares {} bytes and the cap is {}. Nothing \
                        was read, because reading it is what the sender wanted.",
                        n, INBOUND_MAX)));
                }
                if buf.len() < LEN_PREFIX + n {
                    return Err(Fault::Truncated.raise(&fmt!(
                        "The prefix declares {} bytes and {} arrived after it.",
                        n, buf.len() - LEN_PREFIX)));
                }
                &buf[LEN_PREFIX..LEN_PREFIX + n]
            },
            Self::WebSocket => {
                if buf.len() > INBOUND_MAX {
                    return Err(Fault::LengthTooBig.raise(&fmt!(
                        "The payload is {} bytes and the cap is {}.",
                        buf.len(), INBOUND_MAX)));
                }
                buf
            },
        };
        match std::str::from_utf8(body) {
            Ok(s) => Ok(s.to_string()),
            Err(e) => Err(Fault::NotUtf8.raise(&fmt!(
                "The payload is not UTF-8: {}.", e))),
        }
    }

    /// Writes one request.
    ///
    /// # Arguments
    /// * `w` - Where the frame goes.
    /// * `req` - The request.
    pub fn write_req<W: Write>(&self, w: &mut W, req: &Req) -> Outcome<()> {
        let txt = res!(req_json(req));
        res!(self.write_bytes(w, &res!(self.wrap(&txt))));
        Ok(())
    }

    /// Writes one response.
    ///
    /// # Arguments
    /// * `w` - Where the frame goes.
    /// * `resp` - The response.
    pub fn write_resp<W: Write>(&self, w: &mut W, resp: &Resp) -> Outcome<()> {
        let txt = res!(resp_json(resp));
        res!(self.write_bytes(w, &res!(self.wrap(&txt))));
        Ok(())
    }

    /// Reads one request, or nothing where the stream has ended cleanly.
    ///
    /// # Arguments
    /// * `r` - Where the frame comes from.
    pub fn read_req<R: Read>(&self, r: &mut R) -> Outcome<Option<Req>> {
        match res!(self.read_payload(r)) {
            Some(txt) => Ok(Some(res!(req_of_json(&txt)))),
            None => Ok(None),
        }
    }

    /// Reads one response, or nothing where the stream has ended cleanly.
    ///
    /// # Arguments
    /// * `r` - Where the frame comes from.
    pub fn read_resp<R: Read>(&self, r: &mut R) -> Outcome<Option<Resp>> {
        match res!(self.read_payload(r)) {
            Some(txt) => Ok(Some(res!(resp_of_json(&txt)))),
            None => Ok(None),
        }
    }

    /// Reads one payload, or nothing where the stream has ended cleanly.
    ///
    /// The WebSocket arm reads to the end of the stream, because a WebSocket
    /// payload is delivered whole by the transport and one payload is one
    /// message; a byte stream carrying several of them needs the length prefix,
    /// which is what the other arm is.
    ///
    /// # Arguments
    /// * `r` - Where the frame comes from.
    pub fn read_payload<R: Read>(&self, r: &mut R) -> Outcome<Option<String>> {
        match self {
            Self::NativeMessaging => {
                let mut pre = [0u8; LEN_PREFIX];
                let got = res!(read_upto(r, &mut pre));
                if got == 0 {
                    // A clean end between frames, which is how Chrome says goodbye.
                    return Ok(None);
                }
                if got < LEN_PREFIX {
                    return Err(Fault::ShortRead.raise(&fmt!(
                        "The stream ended {} bytes into a {}-byte length prefix.",
                        got, LEN_PREFIX)));
                }
                let n = u32::from_ne_bytes(pre) as usize;
                if n > INBOUND_MAX {
                    return Err(Fault::LengthTooBig.raise(&fmt!(
                        "The prefix declares {} bytes and the cap is {}. Nothing \
                        was read, because reading it is what the sender wanted.",
                        n, INBOUND_MAX)));
                }
                let mut body = vec![0u8; n];
                let got = res!(read_upto(r, &mut body));
                if got < n {
                    return Err(Fault::Truncated.raise(&fmt!(
                        "The prefix declares {} bytes and the stream ended after {}.",
                        n, got)));
                }
                match String::from_utf8(body) {
                    Ok(s) => Ok(Some(s)),
                    Err(e) => Err(Fault::NotUtf8.raise(&fmt!(
                        "The payload is not UTF-8: {}.", e))),
                }
            },
            Self::WebSocket => {
                let mut body = Vec::new();
                // One more than the cap, so a payload sitting exactly on the
                // cap is read and one byte over it is caught rather than
                // silently truncated.
                let mut lim = r.take((INBOUND_MAX + 1) as u64);
                match lim.read_to_end(&mut body) {
                    Ok(_) => (),
                    Err(e) => return Err(Fault::Io.raise(&fmt!(
                        "The payload could not be read: {}.", e))),
                }
                if body.is_empty() {
                    return Ok(None);
                }
                Ok(Some(res!(self.unwrap(&body))))
            },
        }
    }

    /// Writes whole bytes, turning an I/O failure into a named fault.
    ///
    /// # Arguments
    /// * `w` - Where the bytes go.
    /// * `buf` - The bytes.
    fn write_bytes<W: Write>(&self, w: &mut W, buf: &[u8]) -> Outcome<()> {
        match w.write_all(buf) {
            Ok(()) => (),
            Err(e) => return Err(Fault::Io.raise(&fmt!(
                "The frame could not be written: {}.", e))),
        }
        match w.flush() {
            Ok(()) => Ok(()),
            Err(e) => Err(Fault::Io.raise(&fmt!(
                "The frame could not be flushed: {}.", e))),
        }
    }
}

/// Fills a buffer, returning how much of it arrived before the stream ended.
///
/// `Read::read_exact` cannot tell a clean end from a short one, and the
/// difference is the whole of what a reader needs to know: nothing at all means
/// the page has gone, and three bytes of a four-byte prefix means something is
/// wrong.
///
/// # Arguments
/// * `r` - The stream.
/// * `buf` - The buffer to fill.
fn read_upto<R: Read>(r: &mut R, buf: &mut [u8]) -> Outcome<usize> {
    let mut n = 0;
    while n < buf.len() {
        match r.read(&mut buf[n..]) {
            Ok(0) => break,
            Ok(k) => n += k,
            Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(Fault::Io.raise(&fmt!(
                "The stream could not be read: {}.", e))),
        }
    }
    Ok(n)
}

// ┌───────────────────────────────────────────────────────────────┐
// │ Fitting output into a frame                                    │
// └───────────────────────────────────────────────────────────────┘

/// Whether a response fits in one frame.
///
/// # Arguments
/// * `frame` - The framing in use.
/// * `resp` - The response.
pub fn resp_fits(frame: Frame, resp: &Resp) -> Outcome<bool> {
    Ok(res!(resp_frame_len(frame, resp)) <= FRAME_MAX)
}

/// The number of bytes a response occupies once framed.
///
/// # Arguments
/// * `frame` - The framing in use.
/// * `resp` - The response.
pub fn resp_frame_len(frame: Frame, resp: &Resp) -> Outcome<usize> {
    let txt = res!(resp_json(resp));
    Ok(match frame {
        Frame::NativeMessaging	=> LEN_PREFIX + txt.len(),
        Frame::WebSocket		=> txt.len(),
    })
}

/// The framed length of a chunk carrying the given text.
///
/// # Arguments
/// * `frame` - The framing in use.
/// * `id` - The run's identifier.
/// * `stream` - Which stream the text came from.
/// * `seq` - The sequence number the chunk would carry.
/// * `text` - The text the chunk would carry.
fn chunk_frame_len(
    frame:  Frame,
    id:     &str,
    stream: Stream,
    seq:    u64,
    text:   &str,
)
    -> Outcome<usize>
{
    resp_frame_len(frame, &Resp::Chunk {
        id:     id.to_string(),
        stream,
        seq,
        data:   text.to_string(),
    })
}

/// How many bytes of `text` a single chunk can carry.
///
/// **Measured, not calculated.**  JSON escaping inflates: a quote costs two
/// bytes, a control byte costs six, so the answer is not `FRAME_MAX` less a
/// fixed envelope and a caller that assumes it is will write a frame Chrome
/// drops.  The size is therefore found by encoding candidate prefixes and
/// asking how long they came out, which cannot drift from what the encoder
/// actually does because it *is* what the encoder actually does.
///
/// The answer is also held at or below [`CHUNK_MAX`], and always lands on a
/// character boundary so that a chunk never splits a code point.
///
/// # Arguments
/// * `frame` - The framing in use.
/// * `id` - The run's identifier, which is part of the envelope and so part of the cost.
/// * `stream` - Which stream the text came from.
/// * `seq` - The sequence number the chunk would carry.
/// * `text` - The text waiting to be sent.
///
/// # Returns
/// A byte count in `0..=text.len()` on a character boundary, or an error where
/// the envelope alone is too large for a frame, in which case no split helps.
pub fn chunk_fit(
    frame:  Frame,
    id:     &str,
    stream: Stream,
    seq:    u64,
    text:   &str,
)
    -> Outcome<usize>
{
    // The most the two limits and the text itself allow, on a boundary.
    let mut ceil = text.len().min(CHUNK_MAX);
    while ceil > 0 && !text.is_char_boundary(ceil) {
        ceil -= 1;
    }
    if res!(chunk_frame_len(frame, id, stream, seq, &text[..ceil])) <= FRAME_MAX {
        return Ok(ceil);
    }
    // An envelope that does not fit empty will not fit with anything in it.
    if res!(chunk_frame_len(frame, id, stream, seq, "")) > FRAME_MAX {
        return Err(Fault::FrameTooBig.raise(&fmt!(
            "A chunk for run {:?} does not fit in a {}-byte frame even with no \
            data in it, so no way of splitting the output will help.",
            id, FRAME_MAX)));
    }
    // Bisect, keeping `lo` a boundary that fits and `hi` one that does not.
    let mut lo = 0usize;
    let mut hi = ceil;
    while hi - lo > 1 {
        let mid = lo + (hi - lo) / 2;
        // Snap to a boundary strictly inside the interval, downwards first and
        // upwards where downwards would land on `lo`.
        let mut m = mid;
        while m > lo && !text.is_char_boundary(m) {
            m -= 1;
        }
        if m == lo {
            m = mid;
            while m < hi && !text.is_char_boundary(m) {
                m += 1;
            }
            if m >= hi {
                break;
            }
        }
        if res!(chunk_frame_len(frame, id, stream, seq, &text[..m])) <= FRAME_MAX {
            lo = m;
        } else {
            hi = m;
        }
    }
    Ok(lo)
}

// ┌───────────────────────────────────────────────────────────────┐
// │ Fitting terminal output into frames                            │
// └───────────────────────────────────────────────────────────────┘

/// The framed length of an output frame carrying the given base64.
///
/// # Arguments
/// * `frame` - The framing in use.
/// * `id` - The session's identifier.
/// * `seq` - The sequence number the frame would carry.
/// * `data` - The base64 the frame would carry.
fn output_frame_len(
    frame: Frame,
    id:    &str,
    seq:   u64,
    data:  &str,
)
    -> Outcome<usize>
{
    resp_frame_len(frame, &Resp::Output {
        id:   id.to_string(),
        seq,
        data: data.to_string(),
    })
}

/// One output frame carrying exactly these bytes.
///
/// Does not check that they fit: [`output_frames`] is what a caller streaming a
/// terminal wants, and this is what it builds each frame with.
///
/// # Arguments
/// * `id` - The session's identifier.
/// * `seq` - The sequence number.
/// * `bytes` - The raw bytes from the terminal.
pub fn output_msg(id: &str, seq: u64, bytes: &[u8]) -> Resp {
    Resp::Output {
        id:   id.to_string(),
        seq,
        data: data_encode(bytes),
    }
}

/// How many raw bytes a single output frame can carry.
///
/// **Measured, not calculated.**  A first estimate is arithmetic -- base64 turns
/// three bytes into four characters, and those characters are the one alphabet
/// JSON never escapes, so the encoding costs exactly its own length -- but the
/// *envelope* is not arithmetic at all: `id` is caller-supplied, is echoed on
/// every frame, and may hold quotes and control bytes that cost two and six
/// characters each.  So the envelope is priced by encoding one, and the answer
/// is then confirmed by encoding the candidate rather than trusted.
///
/// The answer is also held at or below [`OUTPUT_MAX`], and always lands on a
/// whole base64 quantum where it is a cut rather than the whole buffer, so the
/// far end never has to stitch two frames to decode one quantum.
///
/// # Arguments
/// * `frame` - The framing in use.
/// * `id` - The session's identifier, which is part of the envelope and so part of the cost.
/// * `seq` - The sequence number the frame would carry.
/// * `bytes` - The bytes waiting to be sent.
///
/// # Returns
/// A byte count in `0..=bytes.len()`, or a [`Fault::FrameTooBig`] where the
/// envelope alone is too large for a frame, in which case no split helps.
pub fn output_fit(
    frame: Frame,
    id:    &str,
    seq:   u64,
    bytes: &[u8],
)
    -> Outcome<usize>
{
    // What the envelope costs before a byte of payload is paid for.
    let envelope = res!(output_frame_len(frame, id, seq, ""));
    if envelope > FRAME_MAX {
        return Err(Fault::FrameTooBig.raise(&fmt!(
            "An output frame for session {:?} does not fit in a {}-byte frame \
            even with no data in it, so no way of splitting the output will \
            help.", id, FRAME_MAX)));
    }
    if bytes.is_empty() {
        return Ok(0);
    }
    // The room left for base64, and the whole quanta that fit in it.
    let room = FRAME_MAX - envelope;
    let mut n = bytes.len()
        .min(OUTPUT_MAX)
        .min(room / 4 * 3);
    // Confirm by encoding.  The estimate is exact for every encoder that escapes
    // JSON the way JSON is defined, and this loop is what makes the answer true
    // of the encoder actually in use rather than of the one described here.
    while n > 0 && res!(output_frame_len(frame, id, seq, &data_encode(&bytes[..n]))) > FRAME_MAX {
        n = n.saturating_sub(3);
    }
    Ok(n)
}

/// Every frame a run of terminal bytes becomes, each one sendable.
///
/// **This is what a caller streaming a pty should reach for.**  `REVIEW.md` §3.1
/// records the shape of the alternative: `exec.rs` split its output at a fixed
/// size, a caller-supplied identifier made the envelope larger than the split
/// assumed, and the resulting frame was refused at the pipe and the output
/// silently lost.  A helper that has to be remembered is a helper that is
/// forgotten, so the whole buffer goes in and frames that fit come out.
///
/// The result is one frame per [`OUTPUT_MAX`] bytes and the base64 of each is
/// held until the caller has them, so this wants one read's worth of terminal
/// output rather than a whole session's: the caller decides how much memory the
/// call costs by deciding how much it hands over.
///
/// # Arguments
/// * `frame` - The framing in use.
/// * `id` - The session's identifier.
/// * `seq` - The sequence number of the first frame; later ones follow it.
/// * `bytes` - The bytes read from the terminal.
///
/// # Returns
/// One [`Resp::Output`] per frame, in order, each of which
/// [`resp_fits`] accepts.  Empty input yields no frames, since a frame carrying
/// nothing says nothing.  Fails where the envelope alone is too large for a
/// frame, or where the run would need a sequence number above [`SAFE_INT_MAX`].
pub fn output_frames(
    frame: Frame,
    id:    &str,
    seq:   u64,
    bytes: &[u8],
)
    -> Outcome<Vec<Resp>>
{
    if seq > SAFE_INT_MAX {
        return Err(Fault::WrongShape.raise(&fmt!(
            "An output frame for session {:?} would start at sequence {}, and \
            the largest one the page can compare is {}.", id, seq, SAFE_INT_MAX)));
    }
    let mut out = Vec::new();
    let mut pos = 0usize;
    let mut n = seq;
    while pos < bytes.len() {
        let take = res!(output_fit(frame, id, n, &bytes[pos..]));
        if take == 0 {
            // `output_fit` refuses an impossible envelope, so a zero here can
            // only mean the room shrank to nothing between the two calls, which
            // it cannot; refusing loudly beats looping.
            return Err(Fault::FrameTooBig.raise(&fmt!(
                "No output frame for session {:?} at sequence {} can carry even \
                one byte.", id, n)));
        }
        out.push(output_msg(id, n, &bytes[pos..pos + take]));
        pos += take;
        if pos < bytes.len() {
            if n == SAFE_INT_MAX {
                return Err(Fault::WrongShape.raise(&fmt!(
                    "Session {:?} has reached sequence {}, the largest the page \
                    can compare, with {} bytes still to send.",
                    id, SAFE_INT_MAX, bytes.len() - pos)));
            }
            n += 1;
        }
    }
    Ok(out)
}

// ┌───────────────────────────────────────────────────────────────┐
// │ Tests                                                          │
// └───────────────────────────────────────────────────────────────┘

#[cfg(test)]
mod tests {
    use super::*;

    use std::io::Cursor;

    /// One of each request, for the round trips.
    fn reqs() -> Vec<Req> {
        vec![
            Req::Hello {
                proto:  1,
                client: fmt!("daimond/60"),
            },
            Req::Exec {
                id:         fmt!("run-1"),
                argv:       vec![fmt!("cargo"), fmt!("test")],
                cwd:        fmt!("/abs"),
                env:        vec![(fmt!("K"), fmt!("V")), (fmt!("PATH"), fmt!("/usr/bin"))],
                stdin:      None,
                timeout_ms: 120_000,
                capture:    Capture::Both,
                fence:      FenceSpec {
                    rw:   vec![fmt!("/a")],
                    ro:   vec![],
                    deny: vec![],
                    net:  false,
                },
                toolkits: Vec::new(),
            },
            Req::Exec {
                id:         fmt!("run-2"),
                argv:       vec![fmt!("sh")],
                cwd:        fmt!("/tmp/x"),
                env:        vec![],
                stdin:      Some(fmt!("a \"quoted\" line\nand a tab\there")),
                timeout_ms: 0,
                capture:    Capture::None,
                fence:      FenceSpec {
                    rw:   vec![fmt!("/a"), fmt!("/b")],
                    ro:   vec![fmt!("/usr")],
                    deny: vec![fmt!("/a/.daimond")],
                    net:  true,
                },
                toolkits: Vec::new(),
            },
            Req::Verify {
                id:         fmt!("v-1"),
                name:       fmt!("graph"),
                breaks:     Breaks::All,
                timeout_ms: 1_200_000,
            },
            Req::Verify {
                id:         fmt!("v-2"),
                name:       fmt!("a11y_aria"),
                breaks:     Breaks::One(fmt!("nolinks")),
                timeout_ms: 60_000,
            },
            Req::Verify {
                id:         fmt!("v-3"),
                name:       fmt!("graph"),
                breaks:     Breaks::None,
                timeout_ms: SAFE_INT_MAX,
            },
            Req::Signal { id: fmt!("run-1"), sig: Sig::Term },
            Req::Signal { id: fmt!("run-1"), sig: Sig::Kill },
            Req::Signal { id: fmt!("run-1"), sig: Sig::Int  },
            Req::Open {
                id:    fmt!("pty-1"),
                argv:  vec![fmt!("bash"), fmt!("-l")],
                cwd:   fmt!("/abs"),
                env:   vec![(fmt!("K"), fmt!("V"))],
                size:  PtySize { cols: 80, rows: 24 },
                fence: FenceSpec {
                    rw:   vec![fmt!("/a")],
                    ro:   vec![fmt!("/usr")],
                    deny: vec![fmt!("/a/.daimond")],
                    net:  false,
                },
                toolkits: Vec::new(),
            },
            Req::Open {
                id:    fmt!("pty-2"),
                argv:  vec![fmt!("sh")],
                cwd:   fmt!("/"),
                env:   vec![],
                // The extremes of the field's own type, which is where a decoder
                // that widened or narrowed it would show.
                size:  PtySize { cols: 0, rows: u16::MAX },
                fence: FenceSpec::default(),
                toolkits: Vec::new(),
            },
            // A carriage return, an escape, a NUL and a byte no UTF-8 decoder
            // accepts: the four things a terminal sends that text would lose.
            Req::Input { id: fmt!("pty-1"), data: data_encode(&[0x0d]) },
            Req::Input { id: fmt!("pty-1"), data: data_encode(&[0x1b, b'[', b'A']) },
            Req::Input { id: fmt!("pty-1"), data: data_encode(&[0x00, 0xff, 0xfe]) },
            Req::Input { id: fmt!("pty-1"), data: data_encode(&[]) },
            Req::Resize { id: fmt!("pty-1"), size: PtySize { cols: 120, rows: 40 } },
            Req::Runs,
            Req::Bye,
        ]
    }

    /// One of each response, for the round trips.
    fn resps() -> Vec<Resp> {
        vec![
            Resp::Hello {
                proto:   1,
                host:    fmt!("daimond-hand"),
                version: fmt!("0.1.0"),
                os:      fmt!("linux"),
                caps:    vec![fmt!("exec")],
            },
            Resp::Started { id: fmt!("run-1"), pid: 1234 },
            Resp::Chunk {
                id:     fmt!("run-1"),
                stream: Stream::Out,
                seq:    0,
                data:   fmt!("hello — 日本\u{1}\n"),
            },
            Resp::Chunk {
                id:     fmt!("run-1"),
                stream: Stream::Err,
                seq:    SAFE_INT_MAX,
                data:   fmt!(""),
            },
            Resp::Ended {
                id:        fmt!("run-1"),
                exit:      0,
                timed_out: false,
                killed:    false,
                out_bytes: 12,
                err_bytes: 0,
            },
            Resp::Ended {
                id:        fmt!("run-2"),
                exit:      -1,
                timed_out: true,
                killed:    true,
                out_bytes: 0,
                err_bytes: 9,
            },
            Resp::Refused { id: fmt!("run-3"), reason: fmt!("Outside the fence.") },
            Resp::Opened  { id: fmt!("pty-1"), pid: 4321 },
            Resp::Output  { id: fmt!("pty-1"), seq: 0, data: data_encode(b"$ ") },
            Resp::Output  {
                id:   fmt!("pty-1"),
                seq:  SAFE_INT_MAX,
                data: data_encode(&[0x1b, b'[', b'2', b'J', 0x00, 0xc3, 0x28]),
            },
            Resp::Output  { id: fmt!("pty-1"), seq: 7, data: data_encode(&[]) },
            Resp::Closed  { id: fmt!("pty-1"), exit: 0,  killed: false },
            Resp::Closed  { id: fmt!("pty-2"), exit: -1, killed: true  },
            Resp::Error   { id: Some(fmt!("run-3")), message: fmt!("Broke.") },
            Resp::Error   { id: None, message: fmt!("Broke before there was a run.") },
            Resp::Runs    { runs: Vec::new(), more: 0 },
            Resp::Runs {
                runs: vec![
                    Run {
                        id:    fmt!("run-bash-3"),
                        pid:   4242,
                        what:  fmt!("bash dev/world.sh 3 --up"),
                        state: RunState::Standing,
                        secs:  91,
                    },
                    // The extremes of the fields' own types, which is where a
                    // decoder that widened or narrowed one would show.
                    Run {
                        id:    fmt!("run-cargo-1"),
                        pid:   u32::MAX,
                        what:  fmt!(""),
                        state: RunState::Running,
                        secs:  u32::MAX,
                    },
                ],
                more: 7,
            },
        ]
    }

    /// Every capture mode is spelled and read back.
    #[test]
    fn capture_vocabulary() -> Outcome<()> {
        for c in [Capture::Both, Capture::Out, Capture::Err, Capture::None] {
            assert_eq!(c, res!(capture_of(capture_name(c))));
        }
        assert!(capture_of("BOTH").is_err());
        assert!(capture_of("").is_err());
        Ok(())
    }

    /// Every run state is spelled and read back, and nothing else is accepted.
    #[test]
    fn run_state_vocabulary() -> Outcome<()> {
        for st in [RunState::Running, RunState::Standing] {
            assert_eq!(st, res!(run_state_of(st.word())));
        }
        assert!(run_state_of("Running").is_err());
        assert!(run_state_of("stopped").is_err());
        assert!(run_state_of("").is_err());
        Ok(())
    }

    /// A listing that overruns either of its two ceilings is refused rather than
    /// read.
    ///
    /// Both are the wire's own limits and both matter for the same reason: the
    /// listing is the ONE message that has to be believed about what is still
    /// running, so a frame that could not have been produced by this hand is
    /// better refused by name than silently half-read.
    #[test]
    fn a_listing_past_its_ceilings_is_refused() -> Outcome<()> {
        let one = |what: &str| -> String {
            fmt!(r#"{{"t":"runs","more":0,"runs":[{{"id":"a","pid":1,"what":"{}",                "state":"standing","secs":0}}]}}"#, what)
        };
        let ok = res!(resp_of_json(&one(&"x".repeat(RUN_WHAT_MAX))));
        match ok {
            Resp::Runs { runs, .. } => assert_eq!(runs[0].what.len(), RUN_WHAT_MAX),
            other => return Err(err!("Expected a listing, got {:?}.", other; Test, Mismatch)),
        }
        assert!(resp_of_json(&one(&"x".repeat(RUN_WHAT_MAX + 1))).is_err(),
            "a command line past RUN_WHAT_MAX was accepted");

        let entry = r#"{"id":"a","pid":1,"what":"x","state":"running","secs":0}"#;
        let many = |n: usize| -> String {
            fmt!(r#"{{"t":"runs","more":0,"runs":[{}]}}"#,
                vec![entry; n].join(","))
        };
        assert!(resp_of_json(&many(RUNS_MAX)).is_ok(), "a listing of exactly RUNS_MAX was refused");
        assert!(resp_of_json(&many(RUNS_MAX + 1)).is_err(),
            "a listing past RUNS_MAX was accepted");
        Ok(())
    }

    /// Every signal and stream is spelled and read back.
    #[test]
    fn sig_and_stream_vocabulary() -> Outcome<()> {
        for s in [Sig::Term, Sig::Kill, Sig::Int] {
            assert_eq!(s, res!(sig_of(sig_name(s))));
        }
        for s in [Stream::Out, Stream::Err] {
            assert_eq!(s, res!(stream_of(stream_name(s))));
        }
        assert!(sig_of("hup").is_err());
        assert!(stream_of("both").is_err());
        Ok(())
    }

    /// Every request survives the JSON.
    #[test]
    fn req_round_trip() -> Outcome<()> {
        for req in reqs() {
            let txt = res!(req_json(&req));
            let back = res!(req_of_json(&txt));
            assert_eq!(req, back, "{}", txt);
        }
        Ok(())
    }

    /// A verify asking for one break and naming none is refused, not read as
    /// asking for none.
    ///
    /// The two are opposite requests: one asks to prove something and the other
    /// proves nothing, so a decoder that quietly turned the first into the
    /// second would hand back a pass with nothing behind it.
    #[test]
    fn a_verify_asking_for_one_break_must_name_it() -> Outcome<()> {
        let bad = r#"{"t":"verify","id":"v","name":"graph","breaks":"one","break":null,"timeout_ms":1000}"#;
        assert!(req_of_json(bad).is_err(), "'one' with no break was accepted");
        let worse = r#"{"t":"verify","id":"v","name":"graph","breaks":"most","break":null,"timeout_ms":1000}"#;
        assert!(req_of_json(worse).is_err(), "an invented breaks word was accepted");
        let good = r#"{"t":"verify","id":"v","name":"graph","breaks":"one","break":"x","timeout_ms":1000}"#;
        assert_eq!(Req::Verify {
            id:         fmt!("v"),
            name:       fmt!("graph"),
            breaks:     Breaks::One(fmt!("x")),
            timeout_ms: 1000,
        }, res!(req_of_json(good)));
        Ok(())
    }

    /// Every response survives the JSON.
    #[test]
    fn resp_round_trip() -> Outcome<()> {
        for resp in resps() {
            let txt = res!(resp_json(&resp));
            let back = res!(resp_of_json(&txt));
            assert_eq!(resp, back, "{}", txt);
        }
        Ok(())
    }

    /// Every message survives both framings.
    #[test]
    fn frame_round_trip() -> Outcome<()> {
        for frame in [Frame::NativeMessaging, Frame::WebSocket] {
            for req in reqs() {
                let buf = res!(frame.wrap(&res!(req_json(&req))));
                let back = res!(req_of_json(&res!(frame.unwrap(&buf))));
                assert_eq!(req, back);
            }
            for resp in resps() {
                let buf = res!(frame.wrap(&res!(resp_json(&resp))));
                let back = res!(resp_of_json(&res!(frame.unwrap(&buf))));
                assert_eq!(resp, back);
            }
        }
        Ok(())
    }

    /// The tagged shapes are the ones the contract states.
    #[test]
    fn tagged_shapes() -> Outcome<()> {
        let txt = res!(req_json(&Req::Signal { id: fmt!("x"), sig: Sig::Term }));
        assert!(txt.contains("\"t\""), "{}", txt);
        assert!(txt.contains("\"signal\""), "{}", txt);
        assert!(txt.contains("\"term\""), "{}", txt);

        let txt = res!(req_json(&Req::Exec {
            id:         fmt!("x"),
            argv:       vec![fmt!("cargo"), fmt!("test")],
            cwd:        fmt!("/abs"),
            env:        vec![(fmt!("K"), fmt!("V"))],
            stdin:      None,
            timeout_ms: 120_000,
            capture:    Capture::Both,
            fence:      FenceSpec { rw: vec![fmt!("/a")], ..Default::default() },
            toolkits: Vec::new(),
        }));
        // The absent standard input is `null`, not the word "none": in
        // JavaScript the latter is a truthy string and would read as present.
        assert!(txt.contains("null"), "{}", txt);
        assert!(txt.contains("[ \"K\", \"V\"]") || txt.contains("[\"K\",\"V\"]"), "{}", txt);
        assert!(txt.contains("\"both\""), "{}", txt);
        assert!(txt.contains("\"net\""), "{}", txt);

        let txt = res!(resp_json(&Resp::Error { id: None, message: fmt!("m") }));
        assert!(txt.contains("null"), "{}", txt);
        Ok(())
    }

    /// A native messaging frame is a 4-byte native-endian prefix and the JSON.
    #[test]
    fn framing_is_byte_for_byte() -> Outcome<()> {
        let buf = res!(Frame::NativeMessaging.wrap(&res!(req_json(&Req::Bye))));

        // The whole frame, hand written.
        let body: &[u8] = b"{ \"t\": \"bye\"}";
        assert_eq!(13, body.len());
        let prefix: [u8; 4] = if cfg!(target_endian = "little") {
            [13, 0, 0, 0]
        } else {
            [0, 0, 0, 13]
        };
        let mut want = Vec::new();
        want.extend_from_slice(&prefix);
        want.extend_from_slice(body);
        assert_eq!(want, buf);

        // The WebSocket arm is the same bytes with nothing in front.
        let ws = res!(Frame::WebSocket.wrap(&res!(req_json(&Req::Bye))));
        assert_eq!(body.to_vec(), ws);
        Ok(())
    }

    /// A frame written to a stream is the frame read back from it.
    #[test]
    fn write_then_read() -> Outcome<()> {
        let mut buf = Vec::new();
        for req in reqs() {
            res!(Frame::NativeMessaging.write_req(&mut buf, &req));
        }
        let mut cur = Cursor::new(buf);
        for req in reqs() {
            match res!(Frame::NativeMessaging.read_req(&mut cur)) {
                Some(back) => assert_eq!(req, back),
                None => return Err(err!("The stream ended early."; Test, Missing)),
            }
        }
        // And then a clean end, not an error.
        assert!(res!(Frame::NativeMessaging.read_req(&mut cur)).is_none());
        Ok(())
    }

    /// Responses go the other way just as well.
    #[test]
    fn write_then_read_resps() -> Outcome<()> {
        let mut buf = Vec::new();
        for resp in resps() {
            res!(Frame::NativeMessaging.write_resp(&mut buf, &resp));
        }
        let mut cur = Cursor::new(buf);
        for resp in resps() {
            match res!(Frame::NativeMessaging.read_resp(&mut cur)) {
                Some(back) => assert_eq!(resp, back),
                None => return Err(err!("The stream ended early."; Test, Missing)),
            }
        }
        Ok(())
    }

    /// A stream that stops inside the length prefix is a short read.
    #[test]
    fn hostile_short_read() -> Outcome<()> {
        let mut cur = Cursor::new(vec![1u8, 0, 0]);
        match Frame::NativeMessaging.read_req(&mut cur) {
            Ok(v) => return Err(err!("Expected a refusal, got {:?}.", v; Test, Invalid)),
            Err(e) => assert_eq!(Some(Fault::ShortRead), Fault::of(&e), "{}", e),
        }
        // A prefix that never began is a clean end, not a fault.
        let mut cur = Cursor::new(Vec::new());
        assert!(res!(Frame::NativeMessaging.read_req(&mut cur)).is_none());
        Ok(())
    }

    /// A stream that stops inside the body is a truncated frame.
    #[test]
    fn hostile_truncated() -> Outcome<()> {
        let mut buf = Vec::new();
        res!(Frame::NativeMessaging.write_req(&mut buf, &Req::Bye));
        buf.truncate(buf.len() - 3);
        let mut cur = Cursor::new(buf.clone());
        match Frame::NativeMessaging.read_req(&mut cur) {
            Ok(v) => return Err(err!("Expected a refusal, got {:?}.", v; Test, Invalid)),
            Err(e) => assert_eq!(Some(Fault::Truncated), Fault::of(&e), "{}", e),
        }
        // The slice form says the same.
        match Frame::NativeMessaging.unwrap(&buf) {
            Ok(v) => return Err(err!("Expected a refusal, got {:?}.", v; Test, Invalid)),
            Err(e) => assert_eq!(Some(Fault::Truncated), Fault::of(&e), "{}", e),
        }
        Ok(())
    }

    /// A prefix promising more than the cap is refused before a byte is read.
    #[test]
    fn hostile_length_too_big() -> Outcome<()> {
        let n = (INBOUND_MAX + 1) as u32;
        let mut buf = n.to_ne_bytes().to_vec();
        buf.extend_from_slice(b"{}");
        let mut cur = Cursor::new(buf.clone());
        match Frame::NativeMessaging.read_req(&mut cur) {
            Ok(v) => return Err(err!("Expected a refusal, got {:?}.", v; Test, Invalid)),
            Err(e) => assert_eq!(Some(Fault::LengthTooBig), Fault::of(&e), "{}", e),
        }
        // And 4 GB, which is what a hostile sender actually writes.
        let mut buf = u32::MAX.to_ne_bytes().to_vec();
        buf.extend_from_slice(b"{}");
        match Frame::NativeMessaging.unwrap(&buf) {
            Ok(v) => return Err(err!("Expected a refusal, got {:?}.", v; Test, Invalid)),
            Err(e) => assert_eq!(Some(Fault::LengthTooBig), Fault::of(&e), "{}", e),
        }
        Ok(())
    }

    /// Bytes that are not UTF-8 are refused rather than replaced.
    #[test]
    fn hostile_not_utf8() -> Outcome<()> {
        let body = vec![0xffu8, 0xfe, 0xfd];
        let mut buf = (body.len() as u32).to_ne_bytes().to_vec();
        buf.extend_from_slice(&body);
        let mut cur = Cursor::new(buf.clone());
        match Frame::NativeMessaging.read_req(&mut cur) {
            Ok(v) => return Err(err!("Expected a refusal, got {:?}.", v; Test, Invalid)),
            Err(e) => assert_eq!(Some(Fault::NotUtf8), Fault::of(&e), "{}", e),
        }
        match Frame::WebSocket.unwrap(&body) {
            Ok(v) => return Err(err!("Expected a refusal, got {:?}.", v; Test, Invalid)),
            Err(e) => assert_eq!(Some(Fault::NotUtf8), Fault::of(&e), "{}", e),
        }
        Ok(())
    }

    /// Text that is not JSON at all, and text that is JSON but not an object.
    #[test]
    fn hostile_not_json_or_not_an_object() -> Outcome<()> {
        // Unclosed braces do not parse, and nor does nothing at all.
        for bad in ["{", "{\"t\":", "{\"t\": \"bye\"", "[[[[", ""] {
            match req_of_json(bad) {
                Ok(v) => return Err(err!(
                    "Expected a refusal for {:?}, got {:?}.", bad, v; Test, Invalid)),
                Err(e) => assert_eq!(Some(Fault::NotJson), Fault::of(&e), "{}: {}", bad, e),
            }
        }
        // These parse, and are not messages.
        for bad in ["5", "\"bye\"", "[1, 2]"] {
            match req_of_json(bad) {
                Ok(v) => return Err(err!(
                    "Expected a refusal for {:?}, got {:?}.", bad, v; Test, Invalid)),
                Err(e) => assert_eq!(Some(Fault::WrongShape), Fault::of(&e), "{}: {}", bad, e),
            }
        }
        Ok(())
    }

    /// JSON of the right kind and the wrong shape.
    #[test]
    fn hostile_wrong_shape() -> Outcome<()> {
        let cases = [
            // No discriminator.
            "{\"proto\": 1}",
            // A discriminator that is not a string.
            "{\"t\": 5}",
            // Missing field.
            "{\"t\": \"hello\", \"proto\": 1}",
            // Wrong type for a field.
            "{\"t\": \"hello\", \"proto\": \"one\", \"client\": \"c\"}",
            "{\"t\": \"hello\", \"proto\": 1, \"client\": 5}",
            // A signal nobody offers.
            "{\"t\": \"signal\", \"id\": \"a\", \"sig\": \"hup\"}",
            // An environment entry that is not a pair.
            "{\"t\": \"exec\", \"id\": \"a\", \"argv\": [\"x\"], \"cwd\": \"/\", \
              \"env\": [[\"K\"]], \"stdin\": null, \"timeout_ms\": 1, \
              \"capture\": \"both\", \"fence\": {\"rw\": [], \"ro\": [], \
              \"deny\": [], \"net\": false}}",
            // An argv holding something that is not a string.
            "{\"t\": \"exec\", \"id\": \"a\", \"argv\": [5], \"cwd\": \"/\", \
              \"env\": [], \"stdin\": null, \"timeout_ms\": 1, \
              \"capture\": \"both\", \"fence\": {\"rw\": [], \"ro\": [], \
              \"deny\": [], \"net\": false}}",
            // A fence that is not an object.
            "{\"t\": \"exec\", \"id\": \"a\", \"argv\": [\"x\"], \"cwd\": \"/\", \
              \"env\": [], \"stdin\": null, \"timeout_ms\": 1, \
              \"capture\": \"both\", \"fence\": []}",
        ];
        for bad in cases {
            match req_of_json(bad) {
                Ok(v) => return Err(err!(
                    "Expected a refusal for {:?}, got {:?}.", bad, v; Test, Invalid)),
                Err(e) => assert_eq!(Some(Fault::WrongShape), Fault::of(&e), "{}: {}", bad, e),
            }
        }
        // An exit status too large for an i32 is a shape fault, not a wrap.
        let bad = "{\"t\": \"ended\", \"id\": \"a\", \"exit\": 5000000000, \
            \"timed_out\": false, \"killed\": false, \"out_bytes\": 0, \"err_bytes\": 0}";
        match resp_of_json(bad) {
            Ok(v) => return Err(err!("Expected a refusal, got {:?}.", v; Test, Invalid)),
            Err(e) => assert_eq!(Some(Fault::WrongShape), Fault::of(&e), "{}", e),
        }
        Ok(())
    }

    /// A `"t"` from a build that does not exist yet.
    #[test]
    fn hostile_unknown_tag() -> Outcome<()> {
        match req_of_json("{\"t\": \"detonate\"}") {
            Ok(v) => return Err(err!("Expected a refusal, got {:?}.", v; Test, Invalid)),
            Err(e) => assert_eq!(Some(Fault::UnknownTag), Fault::of(&e), "{}", e),
        }
        match resp_of_json("{\"t\": \"gloat\"}") {
            Ok(v) => return Err(err!("Expected a refusal, got {:?}.", v; Test, Invalid)),
            Err(e) => assert_eq!(Some(Fault::UnknownTag), Fault::of(&e), "{}", e),
        }
        Ok(())
    }

    /// An oversized frame is refused rather than written.
    #[test]
    fn oversize_is_refused() -> Outcome<()> {
        let big = Resp::Chunk {
            id:     fmt!("run-1"),
            stream: Stream::Out,
            seq:    0,
            data:   "x".repeat(2 * FRAME_MAX),
        };
        assert!(!res!(resp_fits(Frame::NativeMessaging, &big)));
        let mut sink = Vec::new();
        match Frame::NativeMessaging.write_resp(&mut sink, &big) {
            Ok(()) => return Err(err!("The oversized frame was written."; Test, Invalid)),
            Err(e) => assert_eq!(Some(Fault::FrameTooBig), Fault::of(&e), "{}", e),
        }
        // Nothing reached the pipe: a partial frame is worse than none.
        assert!(sink.is_empty());
        Ok(())
    }

    /// The check measures the *encoded* size, not the raw one.
    ///
    /// Half a megabyte of `0x01` is well inside the cap as bytes and six times
    /// over it as JSON, so a check that subtracted a fixed envelope from
    /// [`FRAME_MAX`] would pass this and Chrome would drop the connection.
    #[test]
    fn oversize_is_measured_after_escaping() -> Outcome<()> {
        let raw = "\u{1}".repeat(500_000);
        assert!(raw.len() < FRAME_MAX, "the raw text must be inside the cap for this to prove anything");
        let resp = Resp::Chunk {
            id:     fmt!("run-1"),
            stream: Stream::Out,
            seq:    0,
            data:   raw,
        };
        assert!(res!(resp_frame_len(Frame::NativeMessaging, &resp)) > FRAME_MAX);
        assert!(!res!(resp_fits(Frame::NativeMessaging, &resp)));
        match Frame::NativeMessaging.wrap(&res!(resp_json(&resp))) {
            Ok(_) => return Err(err!("The oversized frame was wrapped."; Test, Invalid)),
            Err(e) => assert_eq!(Some(Fault::FrameTooBig), Fault::of(&e), "{}", e),
        }
        Ok(())
    }

    /// The next character boundary strictly above `n`, or the length of the text.
    fn next_boundary(text: &str, n: usize) -> usize {
        let mut m = n + 1;
        while m < text.len() && !text.is_char_boundary(m) {
            m += 1;
        }
        m
    }

    /// The fit helper returns a size that fits, and one character more that does not.
    ///
    /// The envelope is made large by a long identifier so that [`FRAME_MAX`]
    /// rather than [`CHUNK_MAX`] is the binding limit, which is the branch that
    /// has to measure the escaping.
    #[test]
    fn chunk_fit_is_tight() -> Outcome<()> {
        // A long run identifier is caller-supplied and therefore part of what
        // the envelope costs.
        let id = "i".repeat(900_000);
        // Control bytes cost six each in JSON and one byte here.
        let text = "\u{1}".repeat(200_000);
        let n = res!(chunk_fit(Frame::NativeMessaging, &id, Stream::Out, 0, &text));
        assert!(n > 0);
        assert!(n < CHUNK_MAX, "the frame cap must be what binds, not the chunk cap");
        assert!(res!(chunk_frame_len(
            Frame::NativeMessaging, &id, Stream::Out, 0, &text[..n])) <= FRAME_MAX);
        // One character more does not fit, which is what makes the answer tight
        // rather than merely safe.
        let more = next_boundary(&text, n);
        assert!(res!(chunk_frame_len(
            Frame::NativeMessaging, &id, Stream::Out, 0, &text[..more])) > FRAME_MAX);
        Ok(())
    }

    /// The fit helper never splits a code point.
    #[test]
    fn chunk_fit_lands_on_a_boundary() -> Outcome<()> {
        let id = "i".repeat(900_000);
        // Three bytes each, so two byte offsets in three are not boundaries.
        let text = "日".repeat(100_000);
        let n = res!(chunk_fit(Frame::NativeMessaging, &id, Stream::Out, 0, &text));
        assert!(text.is_char_boundary(n), "{} is not a boundary", n);
        assert_eq!(0, n % 3);
        assert!(n > 0 && n < text.len());
        assert!(res!(chunk_frame_len(
            Frame::NativeMessaging, &id, Stream::Out, 0, &text[..n])) <= FRAME_MAX);
        let more = next_boundary(&text, n);
        assert!(res!(chunk_frame_len(
            Frame::NativeMessaging, &id, Stream::Out, 0, &text[..more])) > FRAME_MAX);
        Ok(())
    }

    /// An envelope too large for a frame is an error, since no split helps.
    #[test]
    fn chunk_fit_refuses_an_impossible_envelope() -> Outcome<()> {
        let id = "i".repeat(FRAME_MAX + 1);
        match chunk_fit(Frame::NativeMessaging, &id, Stream::Out, 0, "x") {
            Ok(v) => return Err(err!("Expected a refusal, got {}.", v; Test, Invalid)),
            Err(e) => assert_eq!(Some(Fault::FrameTooBig), Fault::of(&e), "{}", e),
        }
        Ok(())
    }

    /// Text that already fits is not split, and the chunk cap still holds.
    #[test]
    fn chunk_fit_holds_both_caps() -> Outcome<()> {
        let small = fmt!("hello");
        assert_eq!(
            small.len(),
            res!(chunk_fit(Frame::NativeMessaging, "run-1", Stream::Out, 0, &small)));

        // Plain bytes escape to themselves, so CHUNK_MAX is the binding limit.
        let plain = "x".repeat(CHUNK_MAX * 2);
        assert_eq!(
            CHUNK_MAX,
            res!(chunk_fit(Frame::NativeMessaging, "run-1", Stream::Out, 0, &plain)));

        // Nothing at all is nothing at all, not an error.
        assert_eq!(0, res!(chunk_fit(Frame::NativeMessaging, "run-1", Stream::Out, 0, "")));
        Ok(())
    }

    /// The WebSocket arm carries the same payload with no prefix.
    #[test]
    fn websocket_carries_the_same_payload() -> Outcome<()> {
        let resp = Resp::Started { id: fmt!("run-1"), pid: 1234 };
        let txt = res!(resp_json(&resp));
        let ws = res!(Frame::WebSocket.wrap(&txt));
        let nm = res!(Frame::NativeMessaging.wrap(&txt));
        assert_eq!(ws.as_slice(), &nm[LEN_PREFIX..]);
        assert_eq!(txt, res!(Frame::WebSocket.unwrap(&ws)));

        let mut cur = Cursor::new(ws);
        match res!(Frame::WebSocket.read_resp(&mut cur)) {
            Some(back) => assert_eq!(resp, back),
            None => return Err(err!("The payload read as nothing."; Test, Missing)),
        }
        Ok(())
    }

    /// Every fault has its own name, so `Fault::of` cannot confuse two of them.
    #[test]
    fn fault_names_are_distinct() -> Outcome<()> {
        for (i, a) in Fault::ALL.iter().enumerate() {
            for b in Fault::ALL.iter().skip(i + 1) {
                assert_ne!(a.name(), b.name());
                // Nor may one name be a prefix of another, since `of` matches
                // on the start of the message.
                assert!(!b.name().starts_with(a.name()));
                assert!(!a.name().starts_with(b.name()));
            }
            assert_eq!(Some(*a), Fault::of(&a.raise("because")));
        }
        Ok(())
    }

    // ── The terminal half ───────────────────────────────────────────

    /// The six pty messages have the tags and the field order the contract states.
    #[test]
    fn pty_tagged_shapes() -> Outcome<()> {
        let txt = res!(req_json(&Req::Open {
            id:    fmt!("p"),
            argv:  vec![fmt!("bash")],
            cwd:   fmt!("/abs"),
            env:   vec![(fmt!("K"), fmt!("V"))],
            size:  PtySize { cols: 80, rows: 24 },
            fence: FenceSpec { rw: vec![fmt!("/a")], ..Default::default() },
            toolkits: Vec::new(),
        }));
        assert!(txt.contains("\"open\""), "{}", txt);
        assert!(txt.contains("\"cols\""), "{}", txt);
        assert!(txt.contains("\"rows\""), "{}", txt);
        // The order the contract states, not the sorted one `mapdat!` gives.
        let order = ["\"t\"", "\"id\"", "\"argv\"", "\"cwd\"", "\"env\"", "\"size\"", "\"fence\""];
        let mut at = 0;
        for key in order {
            match txt[at..].find(key) {
                Some(k) => at += k + key.len(),
                None => return Err(err!(
                    "{:?} is missing or out of order in {}", key, txt; Test, Invalid)),
            }
        }

        let txt = res!(req_json(&Req::Input { id: fmt!("p"), data: data_encode(b"hi") }));
        assert!(txt.contains("\"input\""), "{}", txt);
        assert!(txt.contains("\"aGk=\""), "{}", txt);

        let txt = res!(req_json(&Req::Resize {
            id:   fmt!("p"),
            size: PtySize { cols: 120, rows: 40 },
        }));
        assert!(txt.contains("\"resize\""), "{}", txt);
        assert!(txt.contains("120") && txt.contains("40"), "{}", txt);

        let txt = res!(resp_json(&Resp::Opened { id: fmt!("p"), pid: 1234 }));
        assert!(txt.contains("\"opened\"") && txt.contains("1234"), "{}", txt);

        let txt = res!(resp_json(&output_msg("p", 3, b"hi")));
        assert!(txt.contains("\"output\""), "{}", txt);
        assert!(txt.contains("\"aGk=\""), "{}", txt);

        let txt = res!(resp_json(&Resp::Closed { id: fmt!("p"), exit: -1, killed: true }));
        assert!(txt.contains("\"closed\"") && txt.contains("-1") && txt.contains("true"),
            "{}", txt);
        Ok(())
    }

    /// The terminal's bytes arrive as the terminal's bytes, whatever they are.
    ///
    /// Every one of the 256 values, invalid UTF-8 and embedded NUL included: the
    /// reason the pty half carries base64 rather than text is that a lossy
    /// conversion corrupts exactly this, and a test that only sends ASCII would
    /// pass against a codec that had thrown the guarantee away.
    #[test]
    fn pty_data_is_byte_exact() -> Outcome<()> {
        let all: Vec<u8> = (0u16..=255).map(|b| b as u8).collect();
        let cases: Vec<Vec<u8>> = vec![
            Vec::new(),
            vec![0x00],
            vec![0x00, 0x00, 0x00],
            // Lone continuation bytes, a truncated three-byte sequence, and an
            // overlong encoding: `from_utf8_lossy` turns each into U+FFFD.
            vec![0x80, 0xbf, 0xc3, 0x28, 0xe2, 0x82],
            vec![0xff, 0xfe, 0xfd, 0xfc],
            // A half-written character at the edge of a read.
            fmt!("日本").into_bytes()[..4].to_vec(),
            b"\x1b[31mred\x1b[0m\r\n".to_vec(),
            all.clone(),
            all.repeat(7),
        ];
        for raw in cases {
            // Out: the hand to the page.
            let msg = output_msg("pty-1", 1, &raw);
            let back = res!(resp_of_json(&res!(resp_json(&msg))));
            match back {
                Resp::Output { data, .. } => assert_eq!(raw, res!(data_decode(&data))),
                other => return Err(err!("Read back {:?}.", other; Test, Invalid)),
            }
            // In: the page to the hand.
            let msg = Req::Input { id: fmt!("pty-1"), data: data_encode(&raw) };
            let back = res!(req_of_json(&res!(req_json(&msg))));
            match back {
                Req::Input { data, .. } => assert_eq!(raw, res!(data_decode(&data))),
                other => return Err(err!("Read back {:?}.", other; Test, Invalid)),
            }
        }
        Ok(())
    }

    /// Anything that is not standard base64 is refused, in both directions.
    #[test]
    fn hostile_bad_base64() -> Outcome<()> {
        let bad = [
            "Zm9",			// Not a whole quantum.
            "Zm9vY",		// Nor this.
            "Zm9v Zg==",	// Whitespace is not in the alphabet.
            // Nor a newline, which a folded header would have.  Spelled as the
            // JSON escape, so that the strict-JSON gate passes it through to the
            // base64 check rather than refusing the raw control byte first.
            "Zm9v\\nZg==",
            "!!!!",			// Nothing in the alphabet at all.
            "Zm-_",			// The URL-safe alphabet is a different alphabet.
            "Zm=9",			// Padding in the middle.
            "====",			// Padding and nothing else.
            "Zm9v====",		// Three pad characters is Base2x, not RFC 4648.
            "Zm9=",			// A final quantum whose unused bits are set.
            "\u{65e5}m9v",	// Not even ASCII.
        ];
        for s in bad {
            let txt = fmt!("{{\"t\": \"input\", \"id\": \"p\", \"data\": \"{}\"}}", s);
            match req_of_json(&txt) {
                Ok(v) => return Err(err!(
                    "Expected a refusal for {:?}, got {:?}.", s, v; Test, Invalid)),
                Err(e) => assert_eq!(Some(Fault::WrongShape), Fault::of(&e), "{}: {}", s, e),
            }
            let txt = fmt!(
                "{{\"t\": \"output\", \"id\": \"p\", \"seq\": 0, \"data\": \"{}\"}}", s);
            match resp_of_json(&txt) {
                Ok(v) => return Err(err!(
                    "Expected a refusal for {:?}, got {:?}.", s, v; Test, Invalid)),
                Err(e) => assert_eq!(Some(Fault::WrongShape), Fault::of(&e), "{}: {}", s, e),
            }
            // And the hand refuses to write one it built wrongly itself.
            let out = Resp::Output { id: fmt!("p"), seq: 0, data: s.to_string() };
            match resp_json(&out) {
                Ok(v) => return Err(err!(
                    "Expected a refusal for {:?}, got {:?}.", s, v; Test, Invalid)),
                Err(e) => assert_eq!(Some(Fault::WrongShape), Fault::of(&e), "{}: {}", s, e),
            }
        }
        // A `data` that is not a string at all is caught before base64 is asked.
        match req_of_json("{\"t\": \"input\", \"id\": \"p\", \"data\": 5}") {
            Ok(v) => return Err(err!("Expected a refusal, got {:?}.", v; Test, Invalid)),
            Err(e) => assert_eq!(Some(Fault::WrongShape), Fault::of(&e), "{}", e),
        }
        // And a missing one.
        match req_of_json("{\"t\": \"input\", \"id\": \"p\"}") {
            Ok(v) => return Err(err!("Expected a refusal, got {:?}.", v; Test, Invalid)),
            Err(e) => assert_eq!(Some(Fault::WrongShape), Fault::of(&e), "{}", e),
        }
        Ok(())
    }

    /// A terminal size that is not one.
    #[test]
    fn hostile_bad_size() -> Outcome<()> {
        let cases = [
            // Missing outright.
            "{\"t\": \"resize\", \"id\": \"p\"}",
            // Not an object.
            "{\"t\": \"resize\", \"id\": \"p\", \"size\": 80}",
            "{\"t\": \"resize\", \"id\": \"p\", \"size\": [80, 24]}",
            "{\"t\": \"resize\", \"id\": \"p\", \"size\": null}",
            // Half a size.
            "{\"t\": \"resize\", \"id\": \"p\", \"size\": {\"cols\": 80}}",
            "{\"t\": \"resize\", \"id\": \"p\", \"size\": {\"rows\": 24}}",
            // Negative.
            "{\"t\": \"resize\", \"id\": \"p\", \"size\": {\"cols\": -1, \"rows\": 24}}",
            "{\"t\": \"resize\", \"id\": \"p\", \"size\": {\"cols\": 80, \"rows\": -24}}",
            // Enormous: one past the field, and far past it.
            "{\"t\": \"resize\", \"id\": \"p\", \"size\": {\"cols\": 65536, \"rows\": 24}}",
            "{\"t\": \"resize\", \"id\": \"p\", \"size\": {\"cols\": 80, \"rows\": 4294967296}}",
            // Not a whole number.
            "{\"t\": \"resize\", \"id\": \"p\", \"size\": {\"cols\": 80.5, \"rows\": 24}}",
            "{\"t\": \"resize\", \"id\": \"p\", \"size\": {\"cols\": \"80\", \"rows\": 24}}",
            "{\"t\": \"resize\", \"id\": \"p\", \"size\": {\"cols\": true, \"rows\": 24}}",
        ];
        for bad in cases {
            match req_of_json(bad) {
                Ok(v) => return Err(err!(
                    "Expected a refusal for {:?}, got {:?}.", bad, v; Test, Invalid)),
                Err(e) => assert_eq!(Some(Fault::WrongShape), Fault::of(&e), "{}: {}", bad, e),
            }
        }
        // The same field on `open`, so the check is not attached to one message.
        let bad = "{\"t\": \"open\", \"id\": \"p\", \"argv\": [\"sh\"], \"cwd\": \"/\", \
            \"env\": [], \"size\": {\"cols\": 100000, \"rows\": 24}, \
            \"fence\": {\"rw\": [], \"ro\": [], \"deny\": [], \"net\": false}}";
        match req_of_json(bad) {
            Ok(v) => return Err(err!("Expected a refusal, got {:?}.", v; Test, Invalid)),
            Err(e) => assert_eq!(Some(Fault::WrongShape), Fault::of(&e), "{}", e),
        }
        // The two extremes of the field itself are accepted, since they are what
        // the contract says a size is.
        let good = "{\"t\": \"resize\", \"id\": \"p\", \"size\": {\"cols\": 0, \"rows\": 65535}}";
        assert_eq!(
            Req::Resize { id: fmt!("p"), size: PtySize { cols: 0, rows: 65535 } },
            res!(req_of_json(good)));
        Ok(())
    }

    /// A sequence number the page could not compare is refused, not rounded.
    ///
    /// `REVIEW.md` §3.11.  `JSON.parse` reads 2^53 as 9007199254740992 and 2^53+1
    /// as the same number, so the page's `msg.seq !== want` would be comparing
    /// two different frames' sequence numbers and finding them equal.
    #[test]
    fn hostile_seq_beyond_javascript() -> Outcome<()> {
        // The largest that works, which is the boundary the check sits on.
        let txt = fmt!(
            "{{\"t\": \"output\", \"id\": \"p\", \"seq\": {}, \"data\": \"\"}}", SAFE_INT_MAX);
        match res!(resp_of_json(&txt)) {
            Resp::Output { seq, .. } => assert_eq!(SAFE_INT_MAX, seq),
            other => return Err(err!("Read back {:?}.", other; Test, Invalid)),
        }
        // One past it, and the value the review actually observed.
        for n in [SAFE_INT_MAX + 1, u64::MAX] {
            let txt = fmt!(
                "{{\"t\": \"output\", \"id\": \"p\", \"seq\": {}, \"data\": \"\"}}", n);
            match resp_of_json(&txt) {
                Ok(v) => return Err(err!(
                    "Expected a refusal for {}, got {:?}.", n, v; Test, Invalid)),
                Err(e) => assert_eq!(Some(Fault::WrongShape), Fault::of(&e), "{}", e),
            }
            // The hand will not write one either.
            match resp_json(&Resp::Output { id: fmt!("p"), seq: n, data: fmt!("") }) {
                Ok(v) => return Err(err!(
                    "Expected a refusal for {}, got {:?}.", n, v; Test, Invalid)),
                Err(e) => assert_eq!(Some(Fault::WrongShape), Fault::of(&e), "{}", e),
            }
        }
        // A negative sequence is not a sequence.
        match resp_of_json("{\"t\": \"output\", \"id\": \"p\", \"seq\": -1, \"data\": \"\"}") {
            Ok(v) => return Err(err!("Expected a refusal, got {:?}.", v; Test, Invalid)),
            Err(e) => assert_eq!(Some(Fault::WrongShape), Fault::of(&e), "{}", e),
        }
        Ok(())
    }

    /// Every `u64` the contract names is refused past 2^53, in both directions.
    ///
    /// `REVIEW.md` §3.11 names four: two sequence numbers, two byte counts and a
    /// wall-clock limit.  The pty's `seq` was fixed when the message was added
    /// and the other four were left, which is the interesting half of the
    /// finding: the fix has to be a rule about numbers rather than a patch on
    /// one message, or the next `u64` added to the wire arrives unguarded.
    ///
    /// The refusal is deliberate and is checked in both directions.  Clamping
    /// would put back the shape of §1.11 -- a value quietly replaced by a
    /// plausible one, which is how a killed `cargo test` was read as a green
    /// build -- and there is no third answer that is not a lie to one end.
    #[test]
    fn every_wire_number_is_refused_past_what_javascript_can_hold() -> Outcome<()> {
        // Responses, as text with the number spliced in.
        let resps: [(&str, &str); 3] = [
            ("chunk seq", "{\"t\": \"chunk\", \"id\": \"r\", \"stream\": \"out\", \
                \"seq\": N, \"data\": \"\"}"),
            ("ended out_bytes", "{\"t\": \"ended\", \"id\": \"r\", \"exit\": 0, \
                \"timed_out\": false, \"killed\": false, \"out_bytes\": N, \
                \"err_bytes\": 0}"),
            ("ended err_bytes", "{\"t\": \"ended\", \"id\": \"r\", \"exit\": 0, \
                \"timed_out\": false, \"killed\": false, \"out_bytes\": 0, \
                \"err_bytes\": N}"),
        ];
        for (what, shape) in resps {
            // The boundary itself is carried, since it is the largest number the
            // page reads back unchanged.
            let ok = shape.replace("N", &fmt!("{}", SAFE_INT_MAX));
            res!(resp_of_json(&ok));
            for n in [SAFE_INT_MAX + 1, u64::MAX] {
                let txt = shape.replace("N", &fmt!("{}", n));
                match resp_of_json(&txt) {
                    Ok(v) => return Err(err!(
                        "{} accepted {}, reading back {:?}.", what, n, v;
                        Test, Invalid)),
                    Err(e) => assert_eq!(
                        Some(Fault::WrongShape), Fault::of(&e), "{}: {}", what, e),
                }
            }
        }

        // The same field on the way out. Nothing legitimate produces these, which
        // is why the check is here: it fires for a counter that went wrong.
        let out: [(&str, Resp); 3] = [
            ("chunk seq", Resp::Chunk {
                id:     fmt!("r"),
                stream: Stream::Out,
                seq:    SAFE_INT_MAX + 1,
                data:   fmt!(""),
            }),
            ("ended out_bytes", Resp::Ended {
                id:        fmt!("r"),
                exit:      0,
                timed_out: false,
                killed:    false,
                out_bytes: u64::MAX,
                err_bytes: 0,
            }),
            ("ended err_bytes", Resp::Ended {
                id:        fmt!("r"),
                exit:      0,
                timed_out: false,
                killed:    false,
                out_bytes: 0,
                err_bytes: SAFE_INT_MAX + 1,
            }),
        ];
        for (what, resp) in out {
            match resp_json(&resp) {
                Ok(v) => return Err(err!(
                    "{} was written as {}.", what, v; Test, Invalid)),
                Err(e) => assert_eq!(
                    Some(Fault::WrongShape), Fault::of(&e), "{}: {}", what, e),
            }
        }

        // And the one number that travels the other way.
        let exec = "{\"t\": \"exec\", \"id\": \"r\", \"argv\": [\"x\"], \"cwd\": \"/\", \
            \"env\": [], \"stdin\": null, \"timeout_ms\": N, \"capture\": \"both\", \
            \"fence\": {\"rw\": [], \"ro\": [], \"deny\": [], \"net\": false}}";
        res!(req_of_json(&exec.replace("N", &fmt!("{}", SAFE_INT_MAX))));
        for n in [SAFE_INT_MAX + 1, u64::MAX] {
            let txt = exec.replace("N", &fmt!("{}", n));
            match req_of_json(&txt) {
                Ok(v) => return Err(err!(
                    "timeout_ms accepted {}, reading back {:?}.", n, v; Test, Invalid)),
                Err(e) => assert_eq!(Some(Fault::WrongShape), Fault::of(&e), "{}", e),
            }
            match req_json(&Req::Exec {
                id:         fmt!("r"),
                argv:       vec![fmt!("x")],
                cwd:        fmt!("/"),
                env:        Vec::new(),
                stdin:      None,
                timeout_ms: n,
                capture:    Capture::Both,
                fence:      FenceSpec::default(),
                toolkits: Vec::new(),
            }) {
                Ok(v) => return Err(err!(
                    "timeout_ms {} was written as {}.", n, v; Test, Invalid)),
                Err(e) => assert_eq!(Some(Fault::WrongShape), Fault::of(&e), "{}", e),
            }
        }

        // A negative number is not a count, a sequence or a limit, and the
        // unsigned read must refuse it rather than default it away: `-1` parsed
        // as `u64` and defaulted to zero is how a killed command reported success
        // (`REVIEW.md` §1.11).
        let negatives = [
            "{\"t\": \"chunk\", \"id\": \"r\", \"stream\": \"out\", \"seq\": -1, \"data\": \"\"}",
            "{\"t\": \"ended\", \"id\": \"r\", \"exit\": 0, \"timed_out\": false, \
              \"killed\": false, \"out_bytes\": -1, \"err_bytes\": 0}",
        ];
        for txt in negatives {
            match resp_of_json(txt) {
                Ok(v) => return Err(err!(
                    "A negative number was read as {:?}.", v; Test, Invalid)),
                Err(e) => assert_eq!(Some(Fault::WrongShape), Fault::of(&e), "{}", e),
            }
        }
        match req_of_json(&exec.replace("N", "-1")) {
            Ok(v) => return Err(err!(
                "A negative timeout was read as {:?}.", v; Test, Invalid)),
            Err(e) => assert_eq!(Some(Fault::WrongShape), Fault::of(&e), "{}", e),
        }
        Ok(())
    }

    /// A pty message with a field left out is refused, one field at a time.
    #[test]
    fn hostile_pty_missing_fields() -> Outcome<()> {
        let cases = [
            "{\"t\": \"open\", \"argv\": [\"sh\"], \"cwd\": \"/\", \"env\": [], \
              \"size\": {\"cols\": 80, \"rows\": 24}, \
              \"fence\": {\"rw\": [], \"ro\": [], \"deny\": [], \"net\": false}}",
            "{\"t\": \"open\", \"id\": \"p\", \"cwd\": \"/\", \"env\": [], \
              \"size\": {\"cols\": 80, \"rows\": 24}, \
              \"fence\": {\"rw\": [], \"ro\": [], \"deny\": [], \"net\": false}}",
            "{\"t\": \"open\", \"id\": \"p\", \"argv\": [\"sh\"], \"env\": [], \
              \"size\": {\"cols\": 80, \"rows\": 24}, \
              \"fence\": {\"rw\": [], \"ro\": [], \"deny\": [], \"net\": false}}",
            "{\"t\": \"open\", \"id\": \"p\", \"argv\": [\"sh\"], \"cwd\": \"/\", \
              \"size\": {\"cols\": 80, \"rows\": 24}, \
              \"fence\": {\"rw\": [], \"ro\": [], \"deny\": [], \"net\": false}}",
            "{\"t\": \"open\", \"id\": \"p\", \"argv\": [\"sh\"], \"cwd\": \"/\", \
              \"env\": [], \"size\": {\"cols\": 80, \"rows\": 24}}",
            "{\"t\": \"input\", \"data\": \"aGk=\"}",
            "{\"t\": \"resize\", \"size\": {\"cols\": 80, \"rows\": 24}}",
        ];
        for bad in cases {
            match req_of_json(bad) {
                Ok(v) => return Err(err!(
                    "Expected a refusal for {:?}, got {:?}.", bad, v; Test, Invalid)),
                Err(e) => assert_eq!(Some(Fault::WrongShape), Fault::of(&e), "{}: {}", bad, e),
            }
        }
        let cases = [
            "{\"t\": \"opened\", \"id\": \"p\"}",
            "{\"t\": \"opened\", \"pid\": 1}",
            "{\"t\": \"output\", \"id\": \"p\", \"data\": \"\"}",
            "{\"t\": \"output\", \"id\": \"p\", \"seq\": 0}",
            "{\"t\": \"closed\", \"id\": \"p\", \"killed\": false}",
            "{\"t\": \"closed\", \"id\": \"p\", \"exit\": 0}",
        ];
        for bad in cases {
            match resp_of_json(bad) {
                Ok(v) => return Err(err!(
                    "Expected a refusal for {:?}, got {:?}.", bad, v; Test, Invalid)),
                Err(e) => assert_eq!(Some(Fault::WrongShape), Fault::of(&e), "{}: {}", bad, e),
            }
        }
        Ok(())
    }

    // ── Sizing an output frame ──────────────────────────────────────

    /// A single output frame that would exceed the cap is refused, and splitting works.
    ///
    /// The payload is chosen so that a naive byte budget passes it: as raw bytes
    /// it is comfortably inside [`FRAME_MAX`], and it is the four-thirds of
    /// base64 that takes it over.
    #[test]
    fn output_over_the_cap_is_refused_then_split() -> Outcome<()> {
        let raw = vec![0x41u8; 900_000];
        assert!(raw.len() < FRAME_MAX,
            "the raw bytes must be inside the cap for this to prove anything");
        let one = output_msg("pty-1", 0, &raw);
        assert!(res!(resp_frame_len(Frame::NativeMessaging, &one)) > FRAME_MAX);
        assert!(!res!(resp_fits(Frame::NativeMessaging, &one)));
        let mut sink = Vec::new();
        match Frame::NativeMessaging.write_resp(&mut sink, &one) {
            Ok(()) => return Err(err!("The oversized frame was written."; Test, Invalid)),
            Err(e) => assert_eq!(Some(Fault::FrameTooBig), Fault::of(&e), "{}", e),
        }
        assert!(sink.is_empty());

        // And the same bytes, split, all of which are sendable and which carry
        // the identical stream back.
        let frames = res!(output_frames(Frame::NativeMessaging, "pty-1", 0, &raw));
        assert!(frames.len() > 1);
        let mut got = Vec::new();
        for (i, f) in frames.iter().enumerate() {
            assert!(res!(resp_fits(Frame::NativeMessaging, f)), "frame {} does not fit", i);
            let mut buf = Vec::new();
            res!(Frame::NativeMessaging.write_resp(&mut buf, f));
            assert!(buf.len() <= FRAME_MAX);
            match f {
                Resp::Output { id, seq, data } => {
                    assert_eq!("pty-1", id);
                    assert_eq!(i as u64, *seq);
                    got.extend_from_slice(&res!(data_decode(data)));
                },
                other => return Err(err!("Not an output frame: {:?}.", other; Test, Invalid)),
            }
        }
        assert_eq!(raw, got);
        Ok(())
    }

    /// The fit is tight: one more byte would not fit in the frame it was cut for.
    ///
    /// A long session identifier is caller-supplied and part of the envelope, so
    /// this is the branch where [`FRAME_MAX`] binds rather than [`OUTPUT_MAX`] --
    /// which is the branch `REVIEW.md` §3.1 says the shipping path got wrong.
    #[test]
    fn output_fit_is_tight() -> Outcome<()> {
        let id = "i".repeat(900_000);
        let raw = vec![0x41u8; 200_000];
        let n = res!(output_fit(Frame::NativeMessaging, &id, 0, &raw));
        assert!(n > 0);
        assert!(n < OUTPUT_MAX, "the frame cap must be what binds, not the output cap");
        assert!(n < raw.len());
        assert!(res!(output_frame_len(
            Frame::NativeMessaging, &id, 0, &data_encode(&raw[..n]))) <= FRAME_MAX);
        // One byte more crosses a base64 quantum and does not fit.
        assert!(res!(output_frame_len(
            Frame::NativeMessaging, &id, 0, &data_encode(&raw[..n + 1]))) > FRAME_MAX);
        // And the cut lands on a whole quantum, so no frame ends mid-quantum.
        assert_eq!(0, n % 3);
        Ok(())
    }

    /// A long, caller-supplied identifier does not produce an unsendable frame.
    ///
    /// This is `REVIEW.md` §3.1 in the pty's own terms: `id` comes from the page,
    /// is echoed on every frame, and a splitter that assumed a fixed envelope
    /// emitted frames the pipe refused and the output vanished.  Every frame
    /// here is written for real, which is the only check that cannot be fooled
    /// by agreeing with the splitter's own arithmetic.
    #[test]
    fn output_frames_survive_a_long_identifier() -> Outcome<()> {
        let id = "i".repeat(900_000);
        let raw: Vec<u8> = (0..300_000u32).map(|i| (i % 251) as u8).collect();
        let frames = res!(output_frames(Frame::NativeMessaging, &id, 0, &raw));
        assert!(frames.len() > 3, "only {} frames", frames.len());
        let mut got = Vec::new();
        for (i, f) in frames.iter().enumerate() {
            let mut buf = Vec::new();
            res!(Frame::NativeMessaging.write_resp(&mut buf, f));
            assert!(buf.len() <= FRAME_MAX, "frame {} is {} bytes", i, buf.len());
            match f {
                Resp::Output { seq, data, .. } => {
                    assert_eq!(i as u64, *seq);
                    got.extend_from_slice(&res!(data_decode(data)));
                },
                other => return Err(err!("Not an output frame: {:?}.", other; Test, Invalid)),
            }
        }
        assert_eq!(raw, got);
        Ok(())
    }

    /// An identifier so long that no output frame can carry anything is an error.
    #[test]
    fn output_fit_refuses_an_impossible_envelope() -> Outcome<()> {
        let id = "i".repeat(FRAME_MAX + 1);
        match output_fit(Frame::NativeMessaging, &id, 0, b"x") {
            Ok(v) => return Err(err!("Expected a refusal, got {}.", v; Test, Invalid)),
            Err(e) => assert_eq!(Some(Fault::FrameTooBig), Fault::of(&e), "{}", e),
        }
        match output_frames(Frame::NativeMessaging, &id, 0, b"x") {
            Ok(v) => return Err(err!("Expected a refusal, got {:?}.", v; Test, Invalid)),
            Err(e) => assert_eq!(Some(Fault::FrameTooBig), Fault::of(&e), "{}", e),
        }
        Ok(())
    }

    /// Both caps hold, and nothing at all yields no frames rather than an empty one.
    #[test]
    fn output_frames_hold_both_caps() -> Outcome<()> {
        // A short identifier leaves room to spare, so OUTPUT_MAX binds.
        let raw = vec![0x41u8; OUTPUT_MAX * 2 + 5];
        let frames = res!(output_frames(Frame::NativeMessaging, "p", 0, &raw));
        assert_eq!(3, frames.len());
        let mut got = Vec::new();
        for (i, f) in frames.iter().enumerate() {
            match f {
                Resp::Output { seq, data, .. } => {
                    assert_eq!(i as u64, *seq);
                    let bytes = res!(data_decode(data));
                    assert!(bytes.len() <= OUTPUT_MAX);
                    got.extend_from_slice(&bytes);
                },
                other => return Err(err!("Not an output frame: {:?}.", other; Test, Invalid)),
            }
        }
        assert_eq!(raw, got);

        // Nothing at all.
        assert!(res!(output_frames(Frame::NativeMessaging, "p", 0, &[])).is_empty());
        assert_eq!(0, res!(output_fit(Frame::NativeMessaging, "p", 0, &[])));

        // A short run is one frame, unsplit, starting where it was told to.
        let frames = res!(output_frames(Frame::WebSocket, "p", 41, b"hello"));
        assert_eq!(vec![output_msg("p", 41, b"hello")], frames);
        Ok(())
    }

    /// A run that would need a sequence past what the page can compare is refused.
    #[test]
    fn output_frames_refuse_a_sequence_overflow() -> Outcome<()> {
        // Starting past the ceiling.
        match output_frames(Frame::NativeMessaging, "p", SAFE_INT_MAX + 1, b"hi") {
            Ok(v) => return Err(err!("Expected a refusal, got {:?}.", v; Test, Invalid)),
            Err(e) => assert_eq!(Some(Fault::WrongShape), Fault::of(&e), "{}", e),
        }
        // Reaching it part-way through: two frames' worth of bytes, one frame of
        // room left.
        let raw = vec![0x41u8; OUTPUT_MAX + 1];
        match output_frames(Frame::NativeMessaging, "p", SAFE_INT_MAX, &raw) {
            Ok(v) => return Err(err!(
                "Expected a refusal, got {} frames.", v.len(); Test, Invalid)),
            Err(e) => assert_eq!(Some(Fault::WrongShape), Fault::of(&e), "{}", e),
        }
        // One frame's worth at the ceiling is fine, since it needs no successor.
        let raw = vec![0x41u8; OUTPUT_MAX];
        assert_eq!(1, res!(output_frames(Frame::NativeMessaging, "p", SAFE_INT_MAX, &raw)).len());
        Ok(())
    }

    // ── Strict JSON ─────────────────────────────────────────────────

    /// The decoder accepts what `JSON.parse` accepts and nothing else.
    ///
    /// `REVIEW.md` §3.12 and §3.2.  Each of these was accepted before, and each
    /// is rejected by the page, by `jq` and by any second reader of the frame.
    #[test]
    fn strict_json_refuses_what_the_page_would() -> Outcome<()> {
        let bad = [
            // JDAT's spellings, none of which is JSON.
            "{'t':'bye'}",
            "{t:\"bye\"}",
            "{\"t\": \"bye\",}",
            "#a comment#{\"t\": \"bye\"}",
            "{\"t\": \"bye\"} #trailing#",
            "(u8|1)",
            "{\"t\": \"hello\", \"proto\": (u32|1), \"client\": \"c\"}",
            // §3.2: a second message in the same frame, which was run silently.
            "{\"t\": \"bye\"}{\"t\": \"bye\"}",
            "{\"t\": \"bye\"} {\"t\": \"exec\"}",
            "{\"t\": \"bye\"}]",
            "{\"t\": \"bye\"}\u{0}",
            // Numbers JSON does not have.
            "{\"t\": \"hello\", \"proto\": 01, \"client\": \"c\"}",
            "{\"t\": \"hello\", \"proto\": +1, \"client\": \"c\"}",
            "{\"t\": \"hello\", \"proto\": 1., \"client\": \"c\"}",
            "{\"t\": \"hello\", \"proto\": .1, \"client\": \"c\"}",
            "{\"t\": \"hello\", \"proto\": 1e, \"client\": \"c\"}",
            // Strings JSON does not have.
            "{\"t\": \"by\\ze\"}",
            "{\"t\": \"by\\u00ze\"}",
            "{\"t\": \"by\te\"}",
            // Structure.
            "{\"t\" \"bye\"}",
            "{\"t\": }",
            "[1,]",
            "{,}",
            "truex",
            "tru",
        ];
        for txt in bad {
            match req_of_json(txt) {
                Ok(v) => return Err(err!(
                    "Expected a refusal for {:?}, got {:?}.", txt, v; Test, Invalid)),
                Err(e) => {
                    let f = Fault::of(&e);
                    assert!(
                        f == Some(Fault::NotJson) || f == Some(Fault::WrongShape),
                        "{:?} gave {:?}: {}", txt, f, e);
                },
            }
        }
        // The tab is only illegal *inside* a string; between values it is
        // whitespace, and refusing it would refuse pretty-printed JSON.
        assert_eq!(Req::Bye, res!(req_of_json("\t\r\n {\n\t\"t\": \"bye\"\r\n}\n ")));
        // An escaped control byte is how a terminal's output legally travels.
        match res!(req_of_json("{\"t\": \"exec\", \"id\": \"a\", \"argv\": [\"x\"], \
            \"cwd\": \"/\", \"env\": [], \"stdin\": \"a\\u0001b\\tc\", \
            \"timeout_ms\": 1, \"capture\": \"both\", \
            \"fence\": {\"rw\": [], \"ro\": [], \"deny\": [], \"net\": false}}"))
        {
            Req::Exec { stdin, .. } => assert_eq!(Some(fmt!("a\u{1}b\tc")), stdin),
            other => return Err(err!("Read back {:?}.", other; Test, Invalid)),
        }
        Ok(())
    }

    /// Deep nesting is refused by count rather than by running out of stack.
    #[test]
    fn strict_json_is_depth_bounded() -> Outcome<()> {
        let txt = fmt!("{}{}", "[".repeat(100_000), "]".repeat(100_000));
        match req_of_json(&txt) {
            Ok(v) => return Err(err!("Expected a refusal, got {:?}.", v; Test, Invalid)),
            Err(e) => assert_eq!(Some(Fault::NotJson), Fault::of(&e), "{}", e),
        }
        Ok(())
    }
}
