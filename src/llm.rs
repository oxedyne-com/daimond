//! LLM client — chat completions with SSE streaming, in two wire dialects.
//!
//! Natively the TLS connection is tokio + rustls; in the browser, fetch.  Parses the
//! `text/event-stream` response line-by-line, extracting `data:` lines
//! containing JSON objects with `delta` content.
//!
//! No `serde` or `reqwest` — neither API's JSON is complicated enough to
//! need one, and both are parsed by string scanning.  This keeps the
//! dependency surface minimal and stays within the fe2o3 ecosystem.
//!
//! Two dialects share every public entry point, the retry policy and the
//! prompt-cache placement: the OpenAI-compatible `/chat/completions` that
//! every router speaks, and Anthropic's own `/v1/messages`.  See
//! [`Dialect`] for why the second one could not simply be bent into the
//! first.

use oxedyne_fe2o3_core::prelude::*;
use oxedyne_fe2o3_core::rand::Rand;
use oxedyne_fe2o3_core::channels::{watch, WatchReceiver, WatchSender};
use oxedyne_fe2o3_jdat::prelude::*;

use crate::engine::race::{self as racing, Won};
use crate::engine::worker::Liveness;
use crate::protocol::{ChatMessage, ContentPart, Dropped, HostPin, ImagePart, MessageContent, ToolCall};

// Native transport imports — the hand-rolled TLS client lives behind
// tokio + rustls, which do not target wasm32.
#[cfg(not(target_arch = "wasm32"))]
use std::sync::Arc;
#[cfg(not(target_arch = "wasm32"))]
use tokio::io::{AsyncReadExt, AsyncWriteExt};
#[cfg(not(target_arch = "wasm32"))]
use tokio_rustls::rustls::ClientConfig;

use zeroize::Zeroizing;


// ┌───────────────────────────────────────────────────────────────┐
// │ Dialect                                                        │
// └───────────────────────────────────────────────────────────────┘

/// Which wire protocol an endpoint speaks.
///
/// The OpenAI-compatible shape carried every provider Daimond had, so the
/// client was written as if there were only one.  Anthropic's own Messages
/// API is not that shape and cannot be made into it: the system prompt is a
/// top-level field rather than a message, content is an array of typed
/// blocks rather than a string, a tool call is a `tool_use` block and its
/// result a `tool_result` block inside the *user* turn, the streamed events
/// are named rather than deltas of one object, and the usage counts have
/// different names and a different meaning.  Bending one into the other
/// would have meant a translation layer that silently dropped whatever it
/// did not understand -- thinking blocks above all -- so the seam is
/// explicit instead, and every branch that needs it says which side it is on.
///
/// The dialect is a property of the *endpoint*, not of the model: the same
/// Claude model is reachable through a router's `/chat/completions` (where
/// it speaks OpenAI) and through Anthropic's `/v1/messages` (where it does
/// not).  Prompt caching gates on the model id for exactly the same reason
/// in reverse -- see [`model_caches_on_request`].
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Dialect {
    /// OpenAI-compatible chat completions.
    OpenAi,
    /// Anthropic's Messages API.
    Anthropic,
}

impl Dialect {

    /// Which dialect the endpoint at `host``path` speaks.
    ///
    /// Two independent signals, either of which is conclusive: Anthropic's
    /// own host, and the `/v1/messages` path that only the Messages API
    /// serves.  Everything else is OpenAI-compatible, which is the right
    /// default -- a router serving `anthropic/claude-opus-5` is still
    /// speaking OpenAI.
    ///
    /// # Arguments
    /// * `host` - The request host, without scheme or port.
    /// * `path` - The request path.
    pub fn for_endpoint(host: &str, path: &str) -> Self {
        let h = host.to_ascii_lowercase();
        let p = path.trim_end_matches('/').to_ascii_lowercase();
        if h == "api.anthropic.com" || h.ends_with(".anthropic.com") || p.ends_with("/v1/messages") {
            Self::Anthropic
        } else {
            Self::OpenAi
        }
    }
}


// ┌───────────────────────────────────────────────────────────────┐
// │ Thinking, as a setting                                         │
// └───────────────────────────────────────────────────────────────┘

/// Whether a turn asks the model to think before it answers.
///
/// Adaptive is the only on-mode any current model takes; see
/// [`model_takes_adaptive_thinking`].  `Off` is a request rather than a
/// guarantee -- three models think whatever they are told (see
/// [`model_always_thinks`]) and Opus 5 refuses to be switched off above
/// effort `high` -- so what actually went on the wire is read back out of
/// the body, never assumed from this.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Thinking {
    Adaptive,
    Off,
}

impl Thinking {

    /// The wire spelling, which `set_tune` reads and `turn_limits` reports.
    pub fn wire(self) -> &'static str {
        match self {
            Self::Adaptive => "adaptive",
            Self::Off      => "off",
        }
    }

    /// Read a spelling; anything else is `None` rather than a silent default.
    pub fn from_wire(s: &str) -> Option<Self> {
        match s.trim() {
            "adaptive"          => Some(Self::Adaptive),
            "off" | "disabled"  => Some(Self::Off),
            _                   => None,
        }
    }
}

/// How deeply a thinking model is asked to work: `output_config.effort`.
///
/// `High` is the API's own default, so it is what an untuned client asks
/// for.  `XHigh` arrived with Opus 4.7 and is a 400 on the two 4.6 models,
/// which is why [`effort_accepted`] exists rather than the field simply
/// being written out.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Effort {
    Low,
    Medium,
    High,
    XHigh,
    Max,
}

impl Effort {

    /// The wire spelling, which `set_tune` reads and `turn_limits` reports.
    pub fn wire(self) -> &'static str {
        match self {
            Self::Low    => "low",
            Self::Medium => "medium",
            Self::High   => "high",
            Self::XHigh  => "xhigh",
            Self::Max    => "max",
        }
    }

    /// Read a spelling; anything else is `None` rather than a silent default.
    pub fn from_wire(s: &str) -> Option<Self> {
        match s.trim() {
            "low"    => Some(Self::Low),
            "medium" => Some(Self::Medium),
            "high"   => Some(Self::High),
            "xhigh"  => Some(Self::XHigh),
            "max"    => Some(Self::Max),
            _        => None,
        }
    }

    /// Is this one of the levels at which thinking may be switched off at all?
    ///
    /// Opus 5 takes `{"type":"disabled"}` only at `high` or below and answers
    /// a 400 above it, so the ceiling is part of the setting rather than a
    /// property of the model alone.
    pub fn at_most_high(self) -> bool {
        matches!(self, Self::Low | Self::Medium | Self::High)
    }
}

/// What a client asks of a thinking model, as one value a shared cell can hold.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ThinkTune {
    pub thinking: Thinking,
    pub effort:   Effort,
}

impl Default for ThinkTune {
    /// What the client asked for before either was a setting: adaptive
    /// thinking, at the effort the API itself defaults to.
    fn default() -> Self {
        Self { thinking: Thinking::Adaptive, effort: Effort::High }
    }
}

/// A [`ThinkTune`] shared across clones of a client.
///
/// `Rc<Cell<..>>` on both targets: this client is
/// single-threaded on either transport, and a worker built from a cloned
/// client is continuing the same turn and must think the same way.
type Tune = std::rc::Rc<std::cell::Cell<ThinkTune>>;


// ┌───────────────────────────────────────────────────────────────┐
// │ Thinking carry                                                 │
// └───────────────────────────────────────────────────────────────┘

/// How many assistant turns of signed reasoning to hold at once.
///
/// A round of an agentic loop adds one entry, so this bounds the memory a very
/// long loop can hold while covering more rounds than any single tool loop runs.
const CARRY_MAX_TURNS: usize = 32;

/// How long a stream may go without a byte before [`LlmClient::stream_sse`] reads it as
/// stalled and ends the round rather than waiting on a dead connection.  Proposal 15,
/// 2026-09-15: OpenRouter's own export showed a round with `generation_time` 83.7 s that the
/// app sat on for 318 s -- roughly four minutes on a stream that had already stopped sending.
/// Overridable per turn via `Limits::stream_idle_ms`; see `Agent::set_stream_idle_ms`.
///
/// Measured from the last REAL data -- the accumulator growing -- and not from the last byte.
/// OpenRouter holds a request whose provider has gone quiet by sending `: OPENROUTER
/// PROCESSING` comment lines, and a watchdog re-armed by those ran a round to the daimon's
/// 30-minute cap (r540).  Before any chunk the limit is 1.5 x this, once a chunk has shown the
/// provider took the request it is 5 x, and so it is while a model reasons without answering;
/// see [`StreamWatch`].
pub const DEFAULT_STREAM_IDLE_MS: u64 = 60_000;

/// How many times a round that produced NO data at all is asked again.
///
/// One, and with the provider that stalled it left out: after the first retry no new
/// provider name is known, so a second exclusion would have nothing to exclude.
const STALL_RETRIES: u32 = 1;

/// How long a model that is plainly working may be quiet, as a multiple of the idle ceiling --
/// 5 x 60 s = 5 minutes by default.  That is the retry of a stalled round waiting for its first
/// data, any attempt once a chunk has shown the provider took the request, and a stream that
/// is reasoning and has not begun its answer.  A model that thinks silently is not abandoned
/// at 90 s, nor cut mid-thought at 60 s.
const STALL_WAIT_FACTOR: u64 = 5;

/// The most a round may wait, across all its attempts, for real data, as a multiple of the idle
/// ceiling: its two attempts' widest waits back to back, 2 x 5 x 60 s = 600 s by default.  It was
/// 480 s, a minute inside the page's 540 s worker wall clock, which r578c T removed: that clock
/// killed healthy slow workers, and this bound is the round's own, so a model that never answers
/// ends the round with its own reason and nothing outside the engine has to time it.  A worker's
/// whole turn is bounded by its rounds, its spend and, once its turn has ended,
/// `compact::ORPHAN_GRACE_ROUNDS`.
const ROUND_QUIET_FACTOR: u64 = 2 * STALL_WAIT_FACTOR;

/// The absolute ceiling on [`ROUND_QUIET_FACTOR`] x the idle ceiling (r578d A4): a chat with a
/// 120 s idle figure would otherwise sit 20 minutes on a provider that never answers.
const ROUND_QUIET_CEILING_MS: u64 = 600_000;

/// The waits of one attempt at a round: how long its first data may take, and the most any quiet
/// before real data may last, given the `elapsed` milliseconds of the round so far.
///
/// The first attempt gives a provider 1.5 x the idle ceiling to begin; the one retry gives it
/// 5 x, so a model that thinks silently is not cut a second time.  Neither may carry the round
/// past [`ROUND_QUIET_FACTOR`] x the idle ceiling, nor past [`ROUND_QUIET_CEILING_MS`].
fn attempt_wait(idle: u64, stall_tries: u32, elapsed: u64) -> (u64, u64) {
    let first_ms = if stall_tries == 0 { idle.saturating_mul(3) / 2 }
                   else { idle.saturating_mul(STALL_WAIT_FACTOR) };
    let bound = idle.saturating_mul(ROUND_QUIET_FACTOR).min(ROUND_QUIET_CEILING_MS);
    (first_ms.min(bound), bound.saturating_sub(elapsed).max(1))
}

/// How much longer a non-streaming reply may take to arrive than a stream's first byte.
///
/// `do_request_full` (the transport behind `chat_once`, which serves the fold summary) awaits
/// the WHOLE body in one piece, where `stream_sse` only needs the first token to arrive within
/// `stream_idle_ms`.  A non-streaming provider generates the entire answer before it sends a
/// byte, so a slow fold must not be cut at the streaming ceiling: its first-byte bound is this
/// multiple of the idle figure -- 5 x 60 s = 300 s by default.
pub(crate) const REPLY_WAIT_FACTOR: u64 = 5;

/// The most of an error status's body the native transport reads to explain it (GW-RESTART):
/// the status already decided the round, and only the first `ERR_BODY_BYTES` are shown.
#[cfg(not(target_arch = "wasm32"))]
const ERR_BODY_READ_MAX: usize = 64 * 1024;

/// How hard an OpenAI-dialect model is asked to reason: OpenRouter's `reasoning.effort`.
///
/// Not [`Effort`], which is the Anthropic Messages API's own ladder: OpenRouter's has `none`
/// and `minimal` below it, and each model publishes which rungs it takes in its catalogue
/// entry (`reasoning.supported_efforts`).  The page draws the per-chat control from that list
/// and sends only a level the model named, so nothing here guesses at a model's ladder.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReasoningEffort {
    None,
    Minimal,
    Low,
    Medium,
    High,
    XHigh,
    Max,
}

impl ReasoningEffort {

    pub fn wire(self) -> &'static str {
        match self {
            Self::None    => "none",
            Self::Minimal => "minimal",
            Self::Low     => "low",
            Self::Medium  => "medium",
            Self::High    => "high",
            Self::XHigh   => "xhigh",
            Self::Max     => "max",
        }
    }

    /// Read a spelling; anything else is `None` rather than a silent default.
    pub fn from_wire(s: &str) -> Option<Self> {
        match s.trim() {
            "none"    => Some(Self::None),
            "minimal" => Some(Self::Minimal),
            "low"     => Some(Self::Low),
            "medium"  => Some(Self::Medium),
            "high"    => Some(Self::High),
            "xhigh"   => Some(Self::XHigh),
            "max"     => Some(Self::Max),
            _         => None,
        }
    }
}

/// A chosen [`ReasoningEffort`] and the model it was chosen for.
///
/// The model rides with the level because a level is a choice about ONE model's ladder: a
/// clone of the client pointed at another model (the fold's own model, say) must not carry
/// a level that model may not take, so the body sends it only while the models agree.
#[derive(Clone, Debug, Eq, PartialEq)]
struct ChosenEffort {
    model:  String,
    effort: ReasoningEffort,
}

/// Which upstream providers OpenRouter should try for this model, and in what order.
///
/// Sent as the request body's `provider` object, OpenRouter's own field -- never a client
/// this app talks to directly, so no provider name is ever hard-coded here: every string in
/// `order` and `ignore` is whatever the user typed on the model's own row.  Empty (the
/// default) sends no `provider` object at all, which is OpenRouter's own free choice.
#[derive(Clone, Debug, Default)]
struct ProviderRouting {
    /// Providers to try first, in this order.  OpenRouter's `provider.order`.
    order:  Vec<String>,
    /// Providers never to route to.  OpenRouter's `provider.ignore`.
    ignore: Vec<String>,
    /// Refuse every provider but `order` rather than falling back past it.
    /// OpenRouter's `provider.allow_fallbacks`, sent only when this is `true` (the field's
    /// own default is `true`, so `false` is the only value worth a byte on the wire).
    only:   bool,
}

/// The signed thinking blocks of recent assistant turns, held until their tool
/// results come back.
///
/// Anthropic requires that a thinking-enabled assistant turn which asked for
/// tools be handed back *complete and unmodified* alongside the tool results:
/// "within a tool-use turn, pass thinking blocks back".  A block the caller
/// edited is rejected with a 400; a block the caller dropped makes the API
/// silently disable thinking for the request, which is the same defect wearing
/// a quieter coat.  Passing every turn's blocks back is the documented
/// recommendation beyond that: on the models that keep them, the reasoning
/// stays in context and caches incrementally with the tool results, so dropping
/// it costs both continuity and money on every round after the first.
///
/// The conversation type this client is given ([`ChatMessage`]) has nowhere to
/// put a thinking block -- it is OpenAI-shaped, and OpenAI has no such thing --
/// so the blocks are held here instead, keyed by the tool-call id they were
/// generated beside.  That id is what makes the association safe: the very next
/// request carries the same id in its assistant turn, so a turn's reasoning can
/// only ever be handed back with the call it actually produced.  A turn that
/// asked for no tools stores nothing, because it is already over.
#[derive(Clone, Debug, Default)]
struct ThinkCarry {
    /// `(first tool-call id, blocks)`, oldest first.  The blocks are already
    /// serialised as JSON objects, in the order the model produced them.
    turns: Vec<(String, Vec<String>)>,
}

/// A [`ThinkCarry`] shared across clones of a client.
#[cfg(not(target_arch = "wasm32"))]
type Carry = std::sync::Arc<std::sync::Mutex<ThinkCarry>>;

/// A [`ThinkCarry`] shared across clones of a client.
#[cfg(target_arch = "wasm32")]
type Carry = std::rc::Rc<std::cell::RefCell<ThinkCarry>>;

/// Whether an endpoint has been caught refusing pictures, shared across clones of a client.
///
/// Learned rather than declared. [`model_can_see`] is a list of eight model ids known to be
/// blind, so every model it has not heard of is assumed sighted -- which is the right default
/// (a new sighted model works at once) and is wrong for exactly as long as it takes one turn
/// to fail. This is the other half: once a request carrying pictures comes back refused and the
/// same request without them succeeds, the endpoint is marked and no later turn pays for the
/// discovery twice.
#[cfg(not(target_arch = "wasm32"))]
type Blind = std::sync::Arc<std::sync::atomic::AtomicBool>;

/// Whether an endpoint has been caught refusing pictures, shared across clones of a client.
#[cfg(target_arch = "wasm32")]
type Blind = std::rc::Rc<std::cell::Cell<bool>>;

/// A fresh flag, unset: nothing has been refused yet.
fn new_blind() -> Blind {
    #[cfg(not(target_arch = "wasm32"))]
    { std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)) }
    #[cfg(target_arch = "wasm32")]
    { std::rc::Rc::new(std::cell::Cell::new(false)) }
}

/// A fresh, empty carry.
fn new_carry() -> Carry {
    #[cfg(not(target_arch = "wasm32"))]
    { std::sync::Arc::new(std::sync::Mutex::new(ThinkCarry::default())) }
    #[cfg(target_arch = "wasm32")]
    { std::rc::Rc::new(std::cell::RefCell::new(ThinkCarry::default())) }
}


/// One piece of a streamed turn, labelled with what kind of thing it is.
///
/// The two are different KINDS of content and not two shades of one.  Text is the
/// answer: it is accumulated, persisted, and sent back to the model next turn as
/// what the assistant said.  Reasoning is the model's working, which the user pays
/// for and which decides the answer, but which is not the answer and must never be
/// stored as one -- see `AgentEvent::Thinking` in src/protocol.rs.
///
/// One sink and not two, because a caller holds ONE `&mut` to whatever it is
/// forwarding into.  Two closures over the same event sink is a borrow the compiler
/// refuses, and the ways round it (a `RefCell`, a channel) buy nothing: the stream
/// is serial, so exactly one delta is in flight at a time.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Delta<'a> {
    Text(&'a str),
    Reasoning(&'a str),
    // A transient provider failure being retried BEFORE the first token. Its own
    // variant, never `Text`, so the retry notice cannot enter the assistant's
    // message nor read as "writing the answer": the caller turns it into an
    // `AgentEvent::Roading` and shows a retry caption, exactly as the tool-loop's
    // own road ladder does. Carries no borrow, so the lifetime is unused here.
    Roading { attempt: u32, of: u32, wait_ms: u64 },
    // The provider has taken the request and shown nothing yet: `secs` since the last real
    // data (text, reasoning or a call fragment -- never a keep-alive comment).  Raised every
    // half of the idle ceiling while it lasts, so a page can say what it is waiting on.
    Waiting { provider: &'a str, secs: u64 },
    // A round ended with no data at all.  `retrying` says whether it is being asked again
    // (with this provider left out where OpenRouter can be told so) or has been given up on.
    Stalled { provider: &'a str, secs: u64, retrying: bool },
}

// What the transport hands the stream's sink.
pub(crate) enum Wire<'a> {
    Data(&'a str),      // one `data:` payload
    Silence(u64),       // seconds without real data; a notice is due
}

// The most of a one-body reply kept for parsing.  Past it the body is cut, which no parse
// accepts, so an oversized body ends as an error naming its first bytes rather than in memory.
const ONE_BODY_CAP: usize = 8 << 20;

/// What one line of a streamed reply is to the reader; see [`SseLines`].
pub(crate) enum SseLine<'l> {
    Data(&'l str),  // one `data:` payload
    Done,           // `data: [DONE]`
    Skip,           // an SSE field line, a comment, a blank, or kept for a one-body reply
}

/// The line discipline both transports' `stream_sse` share.
///
/// **ONE BODY WHERE A STREAM WAS ASKED FOR.**  Some providers answer `stream: true` with one
/// plain chat completion.  The reader used to skip every line that was not `data:`, so that
/// reply was dropped whole: nothing on screen, nothing stored, an empty assistant turn.  So a
/// reply is read as one body when its `Content-Type` is not an event stream, or when it never
/// yields a `data:` line, and [`LlmClient::deliver_body`] hands it on.
pub(crate) struct SseLines {
    sse:  bool,     // the reply is labelled an event stream, or not labelled
    seen: bool,     // a `data:` line has arrived
    body: String,   // what was not SSE, while no data has arrived
}

impl SseLines {

    pub(crate) fn new(ctype: Option<&str>) -> Self {
        let sse = match ctype {
            Some(t) => t.to_ascii_lowercase().contains("event-stream"),
            None    => true,
        };
        Self { sse, seen: false, body: String::new() }
    }

    /// Is the reply labelled a stream (or not labelled)?  If not, it is one whole body.
    pub(crate) fn is_stream(&self) -> bool {
        self.sse
    }

    pub(crate) fn sort<'l>(&mut self, line: &'l str) -> SseLine<'l> {
        if self.sse {
            let line = line.trim();
            if let Some(rest) = line.strip_prefix("data:") {
                // The space after the colon is optional on the wire.
                let data = rest.strip_prefix(' ').unwrap_or(rest);
                if data == "[DONE]" {
                    return SseLine::Done;
                }
                self.seen = true;
                return SseLine::Data(data);
            }
            if line.is_empty()
                || line.starts_with(':')
                || line.starts_with("event:")
                || line.starts_with("id:")
                || line.starts_with("retry:")
                || self.seen
            {
                return SseLine::Skip;
            }
        }
        if self.body.len() < ONE_BODY_CAP {
            self.body.push_str(line);
            self.body.push('\n');
        }
        SseLine::Skip
    }

    /// The reply as one body, when it was one.
    pub(crate) fn body(&self) -> Option<&str> {
        let b = self.body.trim();
        if !self.sse || (!self.seen && !b.is_empty()) { Some(b) } else { None }
    }
}

/// Is `body` one whole OpenAI-style chat completion, with at least one choice?
fn openai_completion(body: &str) -> bool {
    match find_json_array(body, "choices") {
        Some(arr) => !split_top_level_objects(&arr).is_empty(),
        None      => false,
    }
}

// ┌───────────────────────────────────────────────────────────────┐
// │ Halt: one turn's stop                                          │
// └───────────────────────────────────────────────────────────────┘

/// How many stopped turn tags a [`StopSet`] keeps: enough for every turn a page can have
/// running, and bounded so a long-lived conversation's set does not grow.
pub const STOP_TAGS_KEPT: usize = 32;

/// What the conversation's stop cell holds: how many times every turn was stopped, the tags of
/// turns stopped before they began, newest last, and the stops that reached a turn already
/// running.  Written copy-on-write by the handle (`abort`, `abort_turn`) and read by every
/// [`Halt`] made with [`Halt::watching`].
///
/// **A STOP OF A RUNNING TURN IS NOT REMEMBERED BY ITS TAG** (D1 of the U1d check).  It is an edge,
/// like `all`: a strike numbered past every turn's [`StopMark`] at the time, which only a turn
/// whose mark it passes obeys.  So a later turn that reuses the tag -- a hand-off rerun under the
/// same turn id -- starts clear.  Only a stop that reached no running turn is kept by tag, for the
/// turn to obey as it begins (the early rule).
///
/// **NOR IS A STOP THAT CAME TOO LATE, OR ONE ALREADY OBEYED** (D1b of the U1d check).  `ended`
/// holds the tags of the last [`STOP_TAGS_KEPT`] turns to end, and a stop of one of them that
/// reaches no running turn is refused rather than kept: it is a second Stop press, or the runner's
/// late abort, of a turn already over.  And a turn ending takes its own tag out of `tags`, so an
/// early stop it obeyed does not stop the next turn under the tag too.  Sending a turn takes its
/// tag back out of `ended`, so a stop of that turn before it begins is kept again.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct StopSet {
    pub all:    u64,
    pub tags:   std::collections::VecDeque<String>,
    pub struck: u64,
    pub hits:   std::collections::VecDeque<(String, u64)>,
    pub ended:  std::collections::VecDeque<String>,
}

/// Where the stop cell stood when a turn was sent or its halt made: what it obeys is only what
/// moves past this.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct StopMark {
    pub all:    u64,
    pub struck: u64,
}

impl StopSet {

    /// This set with every turn stopped.
    pub fn all_stopped(&self) -> Self {
        let mut next = self.clone();
        next.all = next.all.wrapping_add(1);
        next
    }

    /// This set with the turn tagged `tag` stopped before it began, the oldest tag let go past
    /// [`STOP_TAGS_KEPT`].  An empty tag names no turn and changes nothing.
    pub fn tag_stopped(&self, tag: &str) -> Self {
        let mut next = self.clone();
        if tag.is_empty() || next.holds(tag) {
            return next;
        }
        next.tags.push_back(tag.to_string());
        while next.tags.len() > STOP_TAGS_KEPT {
            next.tags.pop_front();
        }
        next
    }

    /// This set with the RUNNING turn tagged `tag` stopped: a strike that turn obeys, and that a
    /// turn sent after it under the same tag does not.  An empty tag changes nothing.
    pub fn tag_struck(&self, tag: &str) -> Self {
        let mut next = self.clone();
        if tag.is_empty() {
            return next;
        }
        next.struck = next.struck.wrapping_add(1);
        next.hits.push_back((tag.to_string(), next.struck));
        while next.hits.len() > STOP_TAGS_KEPT {
            next.hits.pop_front();
        }
        next
    }

    /// This set with a turn tagged `tag` just sent: a stop of the tag from here on is for it, so
    /// the tag is no longer one whose turn has ended.
    pub fn tag_sent(&self, tag: &str) -> Self {
        let mut next = self.clone();
        next.ended.retain(|t| t != tag);
        next
    }

    /// This set with the turn tagged `tag` ended: an early stop of it is used up, and a stop that
    /// arrives after, while no turn of the tag runs, is refused (see [`StopSet::stop_unrun`]).
    /// The oldest ended tag is let go past [`STOP_TAGS_KEPT`].  An empty tag changes nothing.
    pub fn tag_ended(&self, tag: &str) -> Self {
        let mut next = self.clone();
        if tag.is_empty() {
            return next;
        }
        next.tags.retain(|t| t != tag);
        next.ended.retain(|t| t != tag);
        next.ended.push_back(tag.to_string());
        while next.ended.len() > STOP_TAGS_KEPT {
            next.ended.pop_front();
        }
        next
    }

    /// This set with a stop of `tag` that reached no running turn: kept for the turn to obey as
    /// it begins, unless a turn of the tag lately ended, when it is a late stop and stops nothing.
    pub fn stop_unrun(&self, tag: &str) -> Self {
        if self.ended_lately(tag) {
            return self.clone();
        }
        self.tag_stopped(tag)
    }

    /// Has a turn tagged `tag` ended, with none sent under it since?
    pub fn ended_lately(&self, tag: &str) -> bool { self.ended.iter().any(|t| t == tag) }

    /// Has the turn tagged `tag` been stopped before it began?
    pub fn holds(&self, tag: &str) -> bool { self.tags.iter().any(|t| t == tag) }

    /// Where the cell stands now, for a turn being sent.
    pub fn mark(&self) -> StopMark { StopMark { all: self.all, struck: self.struck } }

    /// Is the turn tagged `tag`, sent at `mark`, stopped?  By an `abort` after its mark, by a stop
    /// of its tag before it began, or by a strike of its tag after its mark.  An empty tag hears
    /// only `abort`.
    pub fn stops(&self, tag: &str, mark: StopMark) -> bool {
        self.all != mark.all
            || (!tag.is_empty()
                && (self.holds(tag)
                    || self.hits.iter().any(|(t, n)| t == tag && n.wrapping_sub(mark.struck) as i64 > 0)))
    }
}

/// One turn's stop, which a Stop or a pause sets and the turn obeys at its next seam.
///
/// **STICKY, AND THE TURN'S OWN.**  The client used to hold one abort slot, the controller of
/// whichever request had been armed LAST, shared by every clone.  An abort that landed while a
/// round's tools ran fired a controller whose request had already finished, and the next round
/// armed a fresh one, so the rest of the turn ran (PQA W, WD).  And every Diamond on one model
/// shares one client, so pausing one Diamond fired whichever Diamond's request was armed last
/// (PQA D).  A halt is made per turn and stays set: the loop asks it before every request and at
/// every round boundary ([`LlmClient::halted`], `Agent::run_tool_loop`), and a clone of the
/// client made for another turn carries a halt of its own ([`LlmClient::with_halt`]).
///
/// The controller of the request in flight is held here too and fired with the flag, so a turn
/// that is mid-stream stops at once rather than at the end of its round.
///
/// **IT ALSO HEARS THE HANDLE'S STOP CELL.**  A halt made with [`watching`](Self::watching) holds
/// its turn's tag and a reader of the conversation's [`StopSet`].  It reads as set once the
/// cell's `all` has moved past where it stood when the halt was made, or once the cell names its
/// tag.  A tag stopped before its turn began is already there, so that turn fires at once.  No
/// actor relays it: [`fired`](Self::fired) awaits the cell itself, and the stream reader and each
/// tool call race that, so a Stop lands while the loop is deep inside a turn.
#[derive(Clone)]
pub struct Halt(std::rc::Rc<HaltInner>);

struct HaltInner {
    set:    std::cell::Cell<bool>,
    rung:   WatchSender<()>,                                        // wakes `fired` on `fire`
    stop:   Option<Watched>,
    #[cfg(target_arch = "wasm32")]
    ctrl:   std::cell::RefCell<Option<web_sys::AbortController>>,   // the request in flight
}

/// The conversation's stop cell, as one turn reads it.
struct Watched {
    tag:    String,
    rx:     WatchReceiver<StopSet>,
    base:   std::cell::Cell<StopMark>,  // the cell when the halt was made or last re-armed
}

impl Watched {

    /// Does the cell say this turn is stopped?  A cell that cannot be read reads as stopped: a
    /// Stop that fails open would leave a turn no one can end.
    fn stopped(&self) -> bool {
        match self.rx.borrow() {
            Ok(s)   => s.stops(&self.tag, self.base.get()),
            Err(_)  => true,
        }
    }
}

impl std::fmt::Debug for Halt {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Halt")
            .field("set", &self.0.set.get())
            .field("tag", &self.0.stop.as_ref().map(|w| w.tag.as_str()))
            .finish()
    }
}

impl Default for Halt {
    fn default() -> Self { Self::new() }
}

impl Halt {

    pub fn new() -> Self { Self::make(None) }

    /// A turn's halt that also obeys the conversation's stop cell: `abort` (every turn) and
    /// `abort_turn(tag)` (this one).  An empty `tag` hears only `abort`.
    pub fn watching(tag: &str, rx: WatchReceiver<StopSet>) -> Self {
        let base = match rx.borrow() {
            Ok(s)   => s.mark(),
            Err(_)  => StopMark::default(),
        };
        Self::make(Some(Watched { tag: tag.to_string(), rx, base: std::cell::Cell::new(base) }))
    }

    fn make(stop: Option<Watched>) -> Self {
        let (rung, _) = watch(());
        Self(std::rc::Rc::new(HaltInner {
            set: std::cell::Cell::new(false),
            rung,
            stop,
            #[cfg(target_arch = "wasm32")]
            ctrl: std::cell::RefCell::new(None),
        }))
    }

    /// Stop the turn: the flag, which every later request and seam reads, and then the request
    /// in flight.
    pub fn fire(&self) {
        self.0.set.set(true);
        // Fails only on a poisoned lock, which one thread cannot leave; the flag above is set.
        let _ = self.0.rung.send(());
        self.tear_down();
    }

    /// Has this turn been stopped, by [`fire`](Self::fire) or by the stop cell?
    pub fn is_set(&self) -> bool {
        if self.0.set.get() {
            return true;
        }
        match &self.0.stop {
            Some(w) if w.stopped() => {
                self.0.set.set(true);
                true
            },
            _ => false,
        }
    }

    /// Resolves once this turn is stopped, and tears the request in flight down as it does.
    /// What the stream reader and each tool call race: the loser is dropped where it stands.
    pub async fn fired(&self) {
        let mut own = self.0.rung.subscribe();
        let mut cell = self.0.stop.as_ref().map(|w| w.rx.clone());
        loop {
            // Both readers are taken BEFORE this check, so a stop that lands after it moves a
            // version they have not seen and the wait below returns at once.
            if self.is_set() {
                self.tear_down();
                return;
            }
            let closed = match cell.as_mut() {
                Some(rx) => match racing::race(own.changed(), rx.changed()).await {
                    Won::Second(Err(_)) => true,
                    _                   => false,
                },
                None => {
                    // The sender is this halt's own, so it outlives the wait.
                    let _ = own.changed().await;
                    false
                },
            };
            if closed {
                // The handle has gone; its last word stands, and only `fire` is left to hear.
                cell = None;
            }
        }
    }

    /// Clear a stop, for the turn about to start on a client that ran the one before it.
    ///
    /// Only the owner of a client that runs one turn at a time calls this -- a chat's own agent,
    /// at the top of its turn -- and only before anything of the new turn has gone out.  A stop
    /// of every turn that came before, and a strike of a running one, is forgotten; a stop of this
    /// halt's own tag before it began is not.
    pub fn rearm(&self) {
        self.0.set.set(false);
        if let Some(w) = &self.0.stop {
            if let Ok(s) = w.rx.borrow() {
                w.base.set(s.mark());
            }
        }
        #[cfg(target_arch = "wasm32")]
        {
            *self.0.ctrl.borrow_mut() = None;
        }
    }

    /// Is this the same turn's stop as `other`?
    pub fn same(&self, other: &Halt) -> bool { std::rc::Rc::ptr_eq(&self.0, &other.0) }

    /// Cancel the request in flight WITHOUT stopping the turn: what a stalled stream's watchdog
    /// does to a `fetch` it has stopped reading.  A stall is not a Stop, and the turn decides
    /// what to do about one.
    pub(crate) fn tear_down(&self) {
        #[cfg(target_arch = "wasm32")]
        {
            if let Some(ctrl) = self.0.ctrl.borrow().as_ref() {
                ctrl.abort();
            }
        }
    }

    /// Hold the controller of the request about to go out, so [`fire`](Self::fire) reaches it.
    #[cfg(target_arch = "wasm32")]
    pub(crate) fn arm(&self, ctrl: web_sys::AbortController) {
        *self.0.ctrl.borrow_mut() = Some(ctrl);
    }
}

// ┌───────────────────────────────────────────────────────────────┐
// │ LlmClient                                                      │
// └───────────────────────────────────────────────────────────────┘

/// Async client for a chat completions API, in either [`Dialect`].
///
/// Connects via TLS to the configured host, POSTs a chat completion
/// request with `stream: true`, and parses the SSE response
/// incrementally — calling `on_token` for each chunk as it arrives,
/// saying whether it is the answer or the model's working ([`Delta`]).
#[derive(Clone)]
pub struct LlmClient {
    pub host:       String,
    pub port:       u16,
    pub path:       String,
    pub api_key:    Zeroizing<String>, // wiped on drop: a runner's child holds his own key (M1)
    pub model:      String,
    /// Upper bound on generated tokens per turn.  Prevents runaway
    /// reasoning loops (e.g. GLM-5.2 without a cap).
    pub max_tokens: u32,
    /// Which wire protocol the endpoint speaks, derived from the host and
    /// path at construction.  See [`Dialect`].
    pub dialect:    Dialect,
    /// How transient provider failures are retried.  Shared by both transports.
    pub retry:      RetryPolicy,
    /// The signed thinking blocks of the assistant turn now awaiting tool
    /// results, so they can be handed back on the next request.  Shared
    /// across clones, because a sub-agent built from a cloned client is
    /// continuing the same turn.  See [`ThinkCarry`].
    think:          Carry,
    /// What this client asks of a thinking model, from `set_tune`.  Shared
    /// across clones for the reason the carry is; see [`Tune`].
    tune:           Tune,
    /// Set once this endpoint has been caught refusing a request that carried pictures.
    /// See [`Blind`]; read by [`LlmClient::vision_guard`] and set by the strip-and-retry in
    /// [`LlmClient::stream_turn`] and [`LlmClient::chat_once`].
    blind:          Blind,
    /// Set once a request that carried pictures has been answered, never refused: the model is
    /// shown to take one. The other half of [`Blind`]; see [`LlmClient::mark_seen`].
    seen:           Blind,
    /// What the provider's own model list says of pictures, pushed by the page through
    /// [`set_sight`](Self::set_sight): 0 nothing said, 1 takes pictures, 2 text-only.  Shared
    /// across clones as `stream_idle_ms` is, and it outranks both name tables and a refusal.
    sight:          std::rc::Rc<std::cell::Cell<u8>>,
    /// How long a stream may go without a byte before it is read as stalled rather than
    /// slow; see [`stream_sse`](Self::stream_sse) and `Limits::stream_idle_ms` in
    /// `src/compact.rs`, which `Agent::set_stream_idle_ms` pushes down into this.  An
    /// `Rc<Cell<…>>` for the reason `tune` is one: shared across clones, so a sub-agent
    /// built from a cloned client carries the same figure.
    pub(crate) stream_idle_ms: std::rc::Rc<std::cell::Cell<u64>>,
    /// Which upstream provider OpenRouter should route this model's calls to, from a
    /// setting on the model's own row (`www/js/models.js`); see
    /// [`set_provider_routing`](Self::set_provider_routing).  `Rc<RefCell<…>>` for the
    /// reason `stream_idle_ms` is a shared cell: one client, one routing preference,
    /// wherever it is cloned.
    provider_routing: std::rc::Rc<std::cell::RefCell<ProviderRouting>>,
    /// The chat's own reasoning level, or none for the model's default; see
    /// [`set_reasoning_effort`](Self::set_reasoning_effort).  Shared across clones as
    /// `provider_routing` is.
    reasoning:      std::rc::Rc<std::cell::RefCell<Option<ChosenEffort>>>,
    // THE CONVERSATION'S HOST (r578 U3), handed in by the agent at the head of every round from
    // the session that owns it and read back after the round; see `set_pin` and `settle_pin`.
    // A plain cell and NOT an `Rc` like the routing above: the routing is the model row's and
    // one for every clone, but a pin is one conversation's, and a worker's or another chat's
    // client must never be handed it.
    pin:            std::cell::RefCell<Option<HostPin>>,
    /// Root-trust TLS configuration for the native transport.  The wasm
    /// transport delegates trust to the browser's `fetch`, so this field
    /// is native-only.
    #[cfg(not(target_arch = "wasm32"))]
    pub tls_config: Arc<ClientConfig>,
    // This turn's stop (see [`Halt`]): shared by a clone made inside the turn, such as the
    // fold's compactor, and replaced by `with_halt` for a clone that runs a turn of its own.
    pub(crate) halt: Halt,
    // The turn's last-progress clock, beaten by every line the stream hears (U3a LV1): the
    // agent's, given here by `Agent::new`, and shared by every clone, `with_halt`'s included.
    // None for a client no agent holds.
    pub(crate) liveness: Option<Liveness>,
    /// Wasm transport URL scheme selector: `true` builds `https://…`,
    /// `false` builds `http://…`.  Defaults to `https` (all real
    /// providers are TLS-only); an `http` client targets a local mock
    /// over `127.0.0.1` for headless testing, where the browser still
    /// treats the origin as a secure context.
    #[cfg(target_arch = "wasm32")]
    pub secure: bool,
    /// The native transport's plain `http` form, for a local mock over `127.0.0.1` only (RKEY-b):
    /// set by [`LlmClient::from_url`] alone, which refuses `http` to any other host, and checked
    /// again where the connection is opened.  Private, so no caller can set it around that check.
    #[cfg(not(target_arch = "wasm32"))]
    plain: bool,
    /// The one address the native transport connects to in place of resolving `host`: set only
    /// by [`LlmClient::fetch_linked`], to an address the [`crate::net_guard::Guard`] judged.
    #[cfg(not(target_arch = "wasm32"))]
    dial_at: Option<std::net::SocketAddr>,
}

/// Written by hand so that a client printed into a log, an error or a panic names its endpoint
/// and model and never its key (RKEY-c rider (a): a runner's run child holds one).
impl std::fmt::Debug for LlmClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LlmClient")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("path", &self.path)
            .field("model", &self.model)
            .field("max_tokens", &self.max_tokens)
            .field("dialect", &self.dialect)
            .field("api_key", &"<redacted>")
            .finish_non_exhaustive()
    }
}

/// The `usage` block a provider reports for a call.
///
/// The token counts were always read; the other two are what the provider
/// says about its own billing, and are worth strictly more than any estimate
/// made from them.  A router charges its own negotiated rate, and a prompt
/// cache read is a fraction of a fresh one -- neither is visible in a token
/// count, so pricing from tokens alone overstated spend several-fold.
#[derive(Clone, Copy, Debug, Default)]
pub struct Usage {
    pub prompt:     u64,
    pub completion: u64,
    /// Prompt tokens served from the provider's cache, a subset of `prompt`.
    pub cached:     u64,
    /// What the provider says the call actually cost, in USD.  Zero means it
    /// said nothing, never that the call was free.
    pub cost_usd:   f64,
}

/// The response from a completed streaming chat call.
#[derive(Clone, Debug, Default)]
pub struct ChatResponse {
    pub content:           String,
    pub prompt_tokens:     u64,
    pub completion_tokens: u64,
    /// Prompt tokens the provider served from its cache.
    pub cached_tokens:     u64,
    /// What the provider says this call cost, in USD; `0.0` when it did not
    /// say.  An aborted stream may never deliver the usage chunk at all.
    pub cost_usd:          f64,
    /// Set when the turn was cancelled mid-stream (browser abort).  The
    /// `content` then holds whatever streamed before the cancellation, so
    /// the caller keeps the partial answer rather than reporting an error.
    pub aborted:           bool,
    /// How many times this call was retried before it succeeded; see
    /// [`ChatOnceResponse::retries`].
    pub retries:           u32,
    /// The model's own reasoning; see [`ChatOnceResponse::thinking`].
    pub thinking:          String,
    /// Set when the provider stopped because the reply hit `max_tokens` --
    /// `finish_reason: "length"`, or Anthropic's `stop_reason: "max_tokens"`.
    ///
    /// A tool call cut here arrives as MALFORMED JSON, so the caller needs to
    /// tell "the model wrote bad JSON" from "the reply ran out of room": the
    /// first is the model's mistake, the second is a setting, and only one of
    /// them is worth retrying.
    ///
    /// It is NOT an error and is never retried.  A reply that hit the cap is a
    /// complete HTTP 200, and sending the same request again costs money and
    /// produces the same cut.
    pub truncated:         bool,
    pub provider:          String,  // the host that answered, as `ChatOnceResponse::provider`
    pub stalled:           bool,    // as `ChatOnceResponse::stalled`
}

/// What a finished round says about its host, for [`LlmClient::settle_pin`]: either kind of
/// response, so a turn with tools and one without pin by the same rule (r578b F5).
pub trait PinRound {
    fn host(&self) -> &str;
    /// Did the round end neither stopped nor stalled, so its host is worth asking again?
    fn ended_clean(&self) -> bool;
    fn stalled(&self) -> bool;
}

impl PinRound for ChatOnceResponse {
    fn host(&self) -> &str { &self.provider }
    fn ended_clean(&self) -> bool { !self.aborted && !self.stalled }
    fn stalled(&self) -> bool { self.stalled }
}

impl PinRound for ChatResponse {
    fn host(&self) -> &str { &self.provider }
    fn ended_clean(&self) -> bool { !self.aborted && !self.stalled }
    fn stalled(&self) -> bool { self.stalled }
}

/// A tool call that arrived as TEXT, written in the model's own native call syntax, with no
/// JSON `tool_calls` beside it.
///
/// Seen live on 2026-09-14, turn 56, glm-5.3 through OpenRouter: the round came back carrying
/// `name</arg_key><arg_value>daimonfold</arg_value>…</tool_call>` as its whole content, the
/// engine read a reply with no calls in it, ended the turn `answered` in 39 seconds, and the
/// page drew `namedaimonfoldtimeout_ms600000worldtrue` as the model's answer.  No tool ran and
/// nothing warned.  A wire fault had ended a turn as a success, which is the one ending this
/// app may not report wrongly.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToolCallLeak {
    /// The leaked markup exactly as it arrived, kept verbatim so a reader sees the evidence
    /// rather than a summary of it.
    pub fragment:  String,
    /// The call rebuilt from the fragment, where the fragment held a whole one.
    ///
    /// `None` when the head `<tool_call>NAME` was consumed upstream, which is what happened in
    /// the live case: without a name there is nothing to dispatch, and guessing one from the
    /// surrounding text would be the app inventing a tool call the model never made.
    pub recovered: Option<ToolCall>,
}

/// What shape a reply arrived in, once it was whole.
///
/// Read ONCE, where the response is assembled, so the streamed and the non-streamed paths
/// cannot disagree about the same bytes.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub enum ReplyShape {
    /// An answer, or an answer with properly delivered tool calls beside it.
    #[default]
    Plain,
    /// A tool call that arrived as prose.
    Malformed(ToolCallLeak),
}

/// The four markers that say a native tool call has been written into the content.
///
/// `<arg_key>` and `</arg_value>` are deliberately absent: a fragment carrying either carries
/// one of these too, and a shorter list is a shorter thing to keep honest.
const LEAK_MARKS: [&str; 4] = ["<tool_call>", "</tool_call>", "<arg_value>", "</arg_key>"];

/// The leak in `content`, or `None` where the model was only talking.
///
/// **A marker inside a fenced code block is not a leak.**  A model showing a reader what its
/// own call syntax looks like -- which the daimon is asked to do whenever this defect is
/// discussed -- writes exactly these bytes on purpose, and classifying that as malformed would
/// nudge a model that had done nothing wrong and then end its turn under an error word.
/// [`fenced_spans`] is the same reader the fold stripper trusts for the same judgement.
///
/// The fragment runs from the start of the LINE holding the first marker to the end of the line
/// holding the last, rather than from marker to marker: the head-stripped form opens with the
/// argument name (`name</arg_key>…`) and a span that began at the first marker would throw that
/// word away -- the one word that says which argument was being written.
pub fn leaked_tool_call(content: &str) -> Option<ToolCallLeak> {
    let spans = fenced_spans(content);
    let fenced = |i: usize| spans.iter().any(|(a, b)| i >= *a && i < *b);
    let (mut lo, mut hi) = (usize::MAX, 0usize);
    for mark in LEAK_MARKS {
        let mut at = 0usize;
        while let Some(i) = content[at..].find(mark) {
            let start = at + i;
            at = start + mark.len();
            if fenced(start) {
                continue;
            }
            lo = lo.min(start);
            hi = hi.max(at);
        }
    }
    if lo == usize::MAX {
        return None;
    }
    // Out to the line ends, for the reason the doc comment gives.
    let from = content[..lo].rfind('\n').map(|i| i + 1).unwrap_or(0);
    let to = content[hi..].find('\n').map(|i| hi + i).unwrap_or(content.len());
    let fragment = content[from..to].trim().to_string();
    let recovered = recover_tool_call(&fragment);
    Some(ToolCallLeak { fragment, recovered })
}

/// The call `fragment` holds, where it holds a whole one.
///
/// **Only a fragment with its NAME still on it is recovered.**  The name lives between
/// `<tool_call>` and the first `<arg_key>`, and when the head has been consumed upstream there
/// is no name in the bytes at all.  Inferring one from the preceding `think_log` would be the
/// app dispatching a tool off the model's working rather than off its call, which is the
/// mistake `dev/CONTRACT_OUTCOME.md` exists to keep out of this tree.
fn recover_tool_call(fragment: &str) -> Option<ToolCall> {
    let open = fragment.find("<tool_call>")? + "<tool_call>".len();
    let close = fragment[open..].find("</tool_call>")? + open;
    let body = &fragment[open..close];
    let first_key = body.find("<arg_key>")?;
    let name = body[..first_key].trim();
    // A name is one bare word.  Anything carrying markup is a fragment that has been cut or
    // interleaved, and dispatching off it would be a guess.
    if name.is_empty() || name.contains('<') || name.contains('>') || name.contains(char::is_whitespace) {
        return None;
    }
    let mut pairs: Vec<(String, String)> = Vec::new();
    let mut rest = &body[first_key..];
    while !rest.trim().is_empty() {
        let ks = match rest.find("<arg_key>") {
            Some(i) => i + "<arg_key>".len(),
            None    => break,
        };
        let ke = rest[ks..].find("</arg_key>")? + ks;
        let vs = rest[ke..].find("<arg_value>")? + ke + "<arg_value>".len();
        let ve = rest[vs..].find("</arg_value>")? + vs;
        // The key must sit immediately before its value, or the pairs have been interleaved
        // with something this reader does not understand.
        if rest[ke + "</arg_key>".len()..vs - "<arg_value>".len()].trim() != "" {
            return None;
        }
        pairs.push((rest[ks..ke].trim().to_string(), rest[vs..ve].to_string()));
        rest = &rest[ve + "</arg_value>".len()..];
    }
    if pairs.is_empty() {
        return None;
    }
    let args: Vec<String> = pairs.iter()
        .map(|(k, v)| fmt!("\"{}\":{}", json_escape(k), json_literal(v)))
        .collect();
    Some(ToolCall {
        // Marked as recovered rather than given a provider's id, because no provider issued
        // one: the call never existed on the wire as a call.
        id:        fmt!("leak_{}", name),
        name:      name.to_string(),
        arguments: fmt!("{{{}}}", args.join(",")),
    })
}

/// One leaked argument value as JSON.
///
/// The native syntax is untyped -- every value arrives as text -- so `true`, `false` and a bare
/// number are written unquoted and everything else becomes a JSON string.  The live fragment
/// carried `600000` and `true`, both of which a tool schema types as something other than a
/// string, so a reader that quoted everything would recover a call the door then refused.
fn json_literal(v: &str) -> String {
    let t = v.trim();
    if t == "true" || t == "false" || t == "null" {
        return t.to_string();
    }
    if !t.is_empty() && t.parse::<f64>().is_ok() {
        return t.to_string();
    }
    fmt!("\"{}\"", json_escape(v))
}


/// The response from a chat call that may include tool calls the model
/// wants executed.  Whether it was produced by a streaming or a
/// non-streaming request, the accumulated shape is the same.
#[derive(Clone, Debug, Default)]
pub struct ChatOnceResponse {
    pub content:           String,
    pub tool_calls:        Vec<ToolCall>,
    pub prompt_tokens:     u64,
    pub completion_tokens: u64,
    /// Prompt tokens the provider served from its cache.
    pub cached_tokens:     u64,
    /// What the provider says this call cost, in USD; see
    /// [`ChatResponse::cost_usd`].
    pub cost_usd:          f64,
    /// Set when the turn was cancelled mid-stream (browser abort); see
    /// [`ChatResponse::aborted`].
    pub aborted:           bool,
    /// How many times this call was retried before it succeeded.  Zero is the
    /// ordinary case; anything else is time the user waited for a provider that
    /// was not ready, and is worth showing rather than hiding.
    pub retries:           u32,
    /// The model's whole reasoning for this turn, gathered as it streamed.  Anthropic
    /// direct returns it from `thinking_delta`; an OpenAI-dialect endpoint returns it
    /// on `reasoning` (OpenRouter's spelling) or `reasoning_content` (DeepSeek's own).
    /// Empty for a model that does not reason, which is most of them.
    ///
    /// NEVER part of `content`: reasoning is not the answer, and a caller that
    /// persisted it as one would be putting the model's working out where its reply
    /// should be -- and handing it back next turn as something the model said.  The
    /// tokens are already counted in `completion_tokens`, because thinking is billed
    /// as output whether or not its text comes back.
    ///
    /// A streaming caller does not need this: the same words reached it as
    /// [`Delta::Reasoning`] while the round ran, which is the only time showing them
    /// does any good.  It is here for the callers that take a turn whole.
    pub thinking:          String,
    /// Set when the provider stopped because the reply hit `max_tokens` --
    /// `finish_reason: "length"`, or Anthropic's `stop_reason: "max_tokens"`.
    ///
    /// A tool call cut here arrives as MALFORMED JSON, so the caller needs to
    /// tell "the model wrote bad JSON" from "the reply ran out of room": the
    /// first is the model's mistake, the second is a setting, and only one of
    /// them is worth retrying.
    ///
    /// It is NOT an error and is never retried.  A reply that hit the cap is a
    /// complete HTTP 200, and sending the same request again costs money and
    /// produces the same cut.
    pub truncated:         bool,
    /// Set when the stream went quiet for longer than `stream_idle_ms` and the round was
    /// given up on rather than waited on further; see [`DEFAULT_STREAM_IDLE_MS`] and
    /// [`StreamOutcome`].  Distinct from `truncated`: that is the provider SAYING it cut
    /// the reply, this is the app giving up on a provider that said nothing at all.  Always
    /// `false` on the non-streaming path, which has no notion of a gap between bytes.
    pub stalled:           bool,
    /// Whether the reply arrived as a reply at all; see [`ReplyShape`].
    ///
    /// Settled by [`ChatOnceResponse::classified`] at each of the three places a response is
    /// assembled, so a caller never has to remember to look.
    pub shape:             ReplyShape,
    /// The provider's own id for this generation (OpenRouter's `"gen-…"`), so a round that
    /// went wrong can be traced back to the provider's own logs afterwards.  Proposal 15,
    /// 2026-09-15: a round that answered nothing had no id anywhere this app kept, and
    /// nothing to ask OpenRouter about.  Empty off OpenRouter and on the Anthropic dialect.
    pub gen_id:               String,
    /// The wire's own `finish_reason` -- `"stop"`, `"length"`, `"tool_calls"`, … -- kept
    /// beside `truncated` as the word behind that bit, for the same trace.  Empty on the
    /// Anthropic dialect, which reports `stop_reason` instead; see `anthropic_truncated`.
    pub finish_reason:        String,
    /// OpenRouter's own `native_finish_reason`: the upstream provider's word, before
    /// OpenRouter's normalisation to the field above.  Empty off OpenRouter.
    pub native_finish_reason: String,
    /// The upstream provider OpenRouter routed this call to (`"Novita"`, …).  Empty off
    /// OpenRouter.
    pub provider:             String,
    /// The round's timing facts, read off the stream by [`StreamWatch`] (U3a RM, UNBLOCK-16):
    /// the body bytes read, the milliseconds from the request to the first of them, the
    /// longest quiet after that one (the quiet before the stream ended included), and the
    /// milliseconds from the round's first request to its end.  They are what a worker's
    /// liveness limit is tuned from.  Zero on the non-streaming path, and `first_ms` is the
    /// whole wait where no byte came at all (`bytes` 0 tells the two apart).
    pub bytes:                u64,
    pub first_ms:             u64,
    pub gap_ms:               u64,
    pub ms:                   u64,
    // The host's speed for this round (D-20261020-10): ms from the request to the first token
    // (keep-alives are bytes, not tokens, so `first_ms` cannot say this), and ms from that token
    // to the end.  Both 0 where no token came, and on the non-streaming path.
    pub tok_ms:               u64,
    pub gen_ms:               u64,
}

impl ChatOnceResponse {

    /// Read the reply's shape, and recover a leaked tool call where the fragment holds one.
    ///
    /// Called on every assembled response -- streamed, whole, OpenAI dialect and Anthropic --
    /// because the fault is the MODEL writing its own call syntax into the text, and nothing
    /// about that is particular to a transport.
    ///
    /// A recovered call joins `tool_calls` and its markup is taken out of `content`, so
    /// everything downstream sees the round the model meant to send.  An unrecovered one is
    /// left exactly as it arrived: the agent loop nudges once and then ends the turn under its
    /// own word, and the fragment is the evidence both of those rest on.
    fn classified(mut self) -> Self {
        // A round that already carries calls is a round whose calls arrived.  Prose beside them
        // showing the syntax is a model explaining itself, not a model failing.
        if !self.tool_calls.is_empty() {
            return self;
        }
        let leak = match leaked_tool_call(&self.content) {
            Some(l) => l,
            None    => return self,
        };
        if let Some(call) = leak.recovered.clone() {
            self.content = self.content.replace(&leak.fragment, "").trim().to_string();
            self.tool_calls.push(call);
        }
        self.shape = ReplyShape::Malformed(leak);
        self
    }
}


// ┌───────────────────────────────────────────────────────────────┐
// │ Retry                                                          │
// └───────────────────────────────────────────────────────────────┘

/// Extra milliseconds added on top of a provider's `Retry-After`, so a fan-out
/// of workers told the same thing does not all come back at the same instant.
const RETRY_AFTER_JITTER_MS: u64 = 250;

/// Bytes of a refusal's body carried into the error.
///
/// Enough for what every provider puts first -- the message, the type and the code --
/// and short enough that a provider answering an oversized request with an echo of it
/// cannot put the whole thing in a user's message pane.  Both transports use it, so the
/// browser and the native path say the same thing about the same failure.
pub(crate) const ERR_BODY_BYTES: usize = 300;

/// What a refused key's error says in place of the provider's body (KEY-BODY).
pub(crate) const KEY_BODY_WITHHELD: &str =
    "the provider's reply is withheld, as a key refusal can echo part of the key";

/// Is `status` the provider refusing the KEY -- 401 (not a key it knows) or 403 (not one allowed
/// to do this)?  Such a refusal's body is never put into an error: OpenAI's 401 names the key's
/// last characters, and an error's words reach fold notes, rows, frames and journals.
pub(crate) fn refuses_key(status: u16) -> bool {
    status == 401 || status == 403
}

/// The plain reason a refused key gives the caller: the provider by name where its host is one
/// Daimond knows, else the host, and the status.  "Your OpenAI key was refused (HTTP 401)".
///
/// # Arguments
/// * `host` - The host the request went to.
/// * `status` - The refusing status, 401 or 403.
pub(crate) fn key_refused_words(host: &str, status: u16) -> String {
    match provider_name(host) {
        Some(p) => fmt!("Your {} key was refused (HTTP {})", p, status),
        None    => fmt!("Your key was refused by {} (HTTP {})", host, status),
    }
}

/// The name a person knows a provider's API host by, or `None` for a host not on the list.
fn provider_name(host: &str) -> Option<&'static str> {
    const KNOWN: [(&str, &str); 12] = [
        ("openai.com",      "OpenAI"),
        ("anthropic.com",   "Anthropic"),
        ("openrouter.ai",   "OpenRouter"),
        ("googleapis.com",  "Google"),
        ("deepseek.com",    "DeepSeek"),
        ("mistral.ai",      "Mistral"),
        ("x.ai",            "xAI"),
        ("groq.com",        "Groq"),
        ("together.xyz",    "Together"),
        ("deepinfra.com",   "DeepInfra"),
        ("fireworks.ai",    "Fireworks"),
        ("moonshot.ai",     "Moonshot"),
    ];
    let h = host.trim().trim_end_matches('.').to_ascii_lowercase();
    KNOWN.iter().find(|(d, _)| h == *d || h.ends_with(&fmt!(".{}", d))).map(|(_, n)| *n)
}

/// The fewest characters of the client's own key that count as a fragment of it (KEY-REDACT).
pub(crate) const KEY_FRAGMENT_MIN: usize = 4;

/// What stands in a quoted body where the client's own key, or a fragment of it, was.
pub(crate) const KEY_REDACTED: &str = "[key]";

/// `body` with the client's own `key` blanked out, and with it every prefix and every suffix of
/// the key of [`KEY_FRAGMENT_MIN`] or more characters (KEY-REDACT).
///
/// A provider's body is quoted into errors that reach rows, notes and frames, and a provider may
/// echo the key -- whole, or masked to its first or last characters ("sk-proj-****abcd").  So no
/// body is quoted anywhere before this has run over it.  Left to right, the longest fragment at
/// each place wins.  A key shorter than the minimum is left alone: matching it would blank
/// ordinary text.
///
/// # Arguments
/// * `body` - The provider's words, as they would be quoted.
/// * `key` - The key this client sends.
pub(crate) fn redact_own_key(body: &str, key: &str) -> String {
    let k = key.trim().as_bytes();
    if k.len() < KEY_FRAGMENT_MIN {
        return body.to_string();
    }
    let b = body.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        // The longest prefix of the key that starts here.
        let mut pre = 0;
        while pre < k.len() && i + pre < b.len() && b[i + pre] == k[pre] {
            pre += 1;
        }
        // The longest suffix of the key that starts here: suffixes shrink as `s` grows, so the
        // first that matches is the longest.
        let mut suf = 0;
        for s in 0..=(k.len() - KEY_FRAGMENT_MIN) {
            if b[i..].starts_with(&k[s..]) {
                suf = k.len() - s;
                break;
            }
        }
        let n = pre.max(suf);
        if n >= KEY_FRAGMENT_MIN {
            out.extend_from_slice(KEY_REDACTED.as_bytes());
            i += n;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// `s` cut to at most `n` bytes, never through the middle of a character.
///
/// `&s[..n]` panics on a multi-byte boundary, and the one place this is used is an error
/// path handed arbitrary bytes from a provider -- exactly where a panic is least welcome
/// and least likely to be noticed in testing.
///
/// # Arguments
/// * `s` - The text to cut.
/// * `n` - The most bytes the result may occupy.
pub(crate) fn clip_bytes(s: &str, n: usize) -> &str {
    let mut cut = s.len().min(n);
    while cut > 0 && !s.is_char_boundary(cut) {
        cut -= 1;
    }
    &s[..cut]
}

/// Bounded exponential backoff for transient provider failures.
///
/// A 429, a 5xx or a dropped connection is the provider saying "not now"; every
/// other 4xx is the request itself being wrong, and sending it again only costs
/// money and time.  Only the former is retried.
#[derive(Clone, Copy, Debug)]
pub struct RetryPolicy {
    /// Total attempts including the first.  One disables retrying.
    pub max_attempts:      u32,
    /// Backoff before the first retry, doubling for each one after it.
    pub base_ms:           u64,
    /// Ceiling on any single backoff.
    pub max_backoff_ms:    u64,
    /// Ceiling on the sum of every backoff within one call, so a turn ends
    /// while the user is still watching it.
    pub max_total_wait_ms: u64,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        // Widened 2026-08-19: a laptop moving between locations routinely drops
        // the network for tens of seconds while it wakes, reconnects and DNS
        // resolves. The previous budget (4 attempts, 20s total) survived a flaky
        // access point but not a 30-second gap, so a turn that could have completed
        // once the machine settled died instead. Eight attempts over up to two
        // minutes gives the reconnect time to happen, while still bounded so a
        // genuinely down provider ends the turn rather than hanging. The stub test
        // client overrides this with a fast policy, so the suite is unaffected.
        Self {
            max_attempts:      8,
            base_ms:           1_000,
            max_backoff_ms:    30_000,
            max_total_wait_ms: 120_000,
        }
    }
}

impl RetryPolicy {

    /// The delay before retry number `retry`, counting the first retry as one.
    ///
    /// A provider's own `Retry-After` wins over the computed backoff and is
    /// never shortened -- it is the one party that knows when it will be ready.
    /// Jitter is added either way: eight workers that hit the same 429 must not
    /// retry in lockstep.
    pub fn delay_ms(&self, retry: u32, after_ms: Option<u64>) -> u64 {
        if let Some(ms) = after_ms {
            return ms.saturating_add(Rand::in_range(0u64, RETRY_AFTER_JITTER_MS));
        }
        let shift = retry.saturating_sub(1).min(16);
        let nominal = self.base_ms
            .saturating_mul(1u64 << shift)
            .min(self.max_backoff_ms);
        // Equal jitter: half the nominal delay, plus a random part of the rest.
        let half = nominal / 2;
        half + Rand::in_range(0u64, nominal - half)
    }

    /// Whether another attempt is allowed, and what it must wait first.
    ///
    /// `None` ends the attempt: either the budget of attempts is spent, or the
    /// next backoff would push the total wait past its bound.
    ///
    /// # Arguments
    /// * `retries` - Retries already made.
    /// * `waited` - Milliseconds already slept within this call.
    /// * `after_ms` - What the provider asked for, if it asked.
    pub fn next_delay(&self, retries: u32, waited: u64, after_ms: Option<u64>) -> Option<u64> {
        if retries + 1 >= self.max_attempts {
            return None;
        }
        let delay = self.delay_ms(retries + 1, after_ms);
        if waited.saturating_add(delay) > self.max_total_wait_ms {
            return None;
        }
        Some(delay)
    }
}

/// A transport failure, and whether trying again could plausibly succeed.
///
/// Retryability is decided where the status code is still in hand, rather than
/// by reading it back out of an error message later.
pub(crate) struct TransportErr {
    retryable: bool,            // is another attempt worth making?
    after_ms:  Option<u64>,     // what the provider asked us to wait, if it said
    status:    u16,             // the HTTP status that refused the request, else 0
    // A few plain words for the retry notice, and -- since 2026-08-28 -- for the
    // caller.  The error itself carries file, line and ANSI colouring, none of
    // which belongs in a user's message pane.  See [`TransportErr::crossed`].
    reason:    String,
    err:       Error<ErrTag>,
}

impl TransportErr {

    /// A failure worth another attempt: a 429, a 5xx, or a broken connection.
    pub(crate) fn transient(reason: String, err: Error<ErrTag>) -> Self {
        Self { retryable: true, after_ms: None, status: 0, reason, err }
    }

    /// A failure that will fail again the same way: a malformed request, a bad
    /// key, an unknown model.
    pub(crate) fn fatal(reason: String, err: Error<ErrTag>) -> Self {
        Self { retryable: false, after_ms: None, status: 0, reason, err }
    }

    /// Classify a transport error by its tags, terminal if it is a first-byte/idle timeout.
    ///
    /// THE ONE DOOR.  A first-byte or idle timeout is a stall, and a stall is not fixed by
    /// retrying it: the provider took the connection and stopped answering, so an identical
    /// second attempt only waits out the same ceiling again -- worst case eight times over,
    /// tens of minutes, on a path with no outer wall clock.  So a timeout is `fatal` and ends
    /// the round.  Every other transient -- a 429, a 5xx, a reset connection -- still retries,
    /// exactly as before.  This is the single site that decision is made (per transport), so
    /// the several timeout arms (header wait, body wait, browser first byte) cannot drift apart
    /// into per-caller overrides.
    pub(crate) fn classify(reason: String, err: Error<ErrTag>) -> Self {
        if err.tags().contains(&ErrTag::Timeout) {
            Self::fatal(reason, err)
        } else {
            Self::transient(reason, err)
        }
    }

    /// Attach the provider's requested delay.
    pub(crate) fn after(mut self, after_ms: Option<u64>) -> Self {
        self.after_ms = after_ms;
        self
    }

    /// Say which HTTP status the failure was, so a caller can tell a refusal from a broken line.
    pub(crate) fn at(mut self, status: u16) -> Self {
        self.status = status;
        self
    }

    /// The failure as it LEAVES this module, with the reason in front of it.
    ///
    /// WHY THE REASON HAS TO TRAVEL.  Until this existed only `err` was returned,
    /// and `err` on the browser path is the browser's own sentence -- Chromium
    /// says `Failed to fetch` and WebKit says `Load failed` for the identical
    /// event.  The app's offline classifier (`isUnreachable`, www/js/daimond.js)
    /// was therefore reduced to matching one vendor's prose, and on iOS it matched
    /// nothing: a turn that died before the first token was written off as a
    /// provider refusal, and the recovery built for exactly that case never ran.
    ///
    /// `reason` is this client's own wording and is the same on every browser, so
    /// putting it in front of the error makes the classification a property of
    /// Daimond rather than of Safari.  It is first because the reader -- person or
    /// regex -- should meet the plain sentence before the framing.
    ///
    /// WHAT THE ERROR IS TRAVELS IN ITS TAGS, ON THE OUTER ERROR.  `tags()` now gathers the tags
    /// of the whole chain, outermost first, but the outer error is still where the kind is said:
    /// a stall wrapped here under plain network tags would read first as a network failure, and a
    /// refusal's status would be left as digits in prose for the caller to guess at.  The agent's
    /// overflow test once did guess, and a stall that took 400 seconds read as a 400 (r541 QA N2).
    /// So a timeout keeps `Timeout`; a refusal for SIZE ([`too_big`](Self::too_big)) leaves
    /// `TooBig`, so the fold that answers it, and the picture
    /// rule that must not, read the tag rather than the provider's prose a second time; and a
    /// bare 400 or 422 -- the status a refused picture gets too -- leaves `Size`, which says only
    /// that size MAY be why: [`compact::looks_like_overflow`](crate::agent::compact::looks_like_overflow)
    /// still weighs it against the prompt.
    fn crossed(self) -> Error<ErrTag> {
        if self.err.tags().contains(&ErrTag::Timeout) {
            err!(self.err, "{}", self.reason; IO, Network, Wire, Timeout)
        } else if self.too_big() {
            err!(self.err, "{}", self.reason; IO, Network, Wire, TooBig)
        } else if self.status == 401 {
            // The provider refused the KEY: a runner's held key is dead (revoked, swept) and
            // must be forgotten so the next turn mints afresh. 402 (no credit) and 403 (not
            // allowed) are not dead keys.
            err!(self.err, "{}", self.reason; IO, Network, Wire, Unauthorised)
        } else if self.status == 403 {
            // The provider will not let this key do this: no dead key, so no forget, but on his
            // own key on a runner it ends the turn with a fixed note (OWNKEY L3).
            err!(self.err, "{}", self.reason; IO, Network, Wire, Security)
        } else if matches!(self.status, 400 | 422) {
            err!(self.err, "{}", self.reason; IO, Network, Wire, Size)
        } else if self.status == 429 {
            // The passing kinds are tagged too, so whoever reads the failure later -- a worker's
            // parent deciding whether to dispatch again -- reads the tag, never the digits
            // (ZERO-ROUND run 4, see `failure_class`).
            err!(self.err, "{}", self.reason; IO, Network, Wire, LimitReached)
        } else if (500..600).contains(&self.status) {
            err!(self.err, "{}", self.reason; IO, Network, Wire, Upstream)
        } else if self.status == 0 && self.retryable {
            // No status and worth another go: the road broke before the provider answered.
            err!(self.err, "{}", self.reason; IO, Network, Wire, Unreachable)
        } else {
            err!(self.err, "{}", self.reason; IO, Network, Wire)
        }
    }

    /// Was the request refused for its SIZE rather than for anything in it?
    ///
    /// A 413, an error already tagged `TooBig`, or a refusal whose own words are about the
    /// context window ([`says_overflow`](crate::agent::compact::says_overflow)). The words are
    /// read here, once, because nothing else on a 400 says it: the status is the same one a
    /// refused picture gets.
    fn too_big(&self) -> bool {
        self.status == 413
            || self.err.tags().contains(&ErrTag::TooBig)
            || crate::agent::compact::says_overflow(&fmt!("{}", self.err))
    }

    /// Could this refusal be about a picture the request carried?
    ///
    /// Only a refusal that will fail the same way again, and is not one for size: a context
    /// window overflowed by a long conversation is not cured by taking a picture out of it, and
    /// curing it that way would mark a model that sees as blind for the rest of the session.
    /// The fold answers a size refusal; see [`too_big`](Self::too_big).
    fn may_be_the_picture(&self) -> bool {
        !self.retryable && !self.too_big()
    }

    /// Was it the picture's own size that was refused -- "image exceeds 5 MB" -- and not the
    /// picture as such?
    ///
    /// The status cannot say: it is the same 400 a text model gives any picture.  So the
    /// provider's words decide ([`says_picture_too_large`]).  Taking the picture out still cures
    /// it, but the model sees, and marking it blind would refuse every later picture, however
    /// small, for the rest of the session.
    fn picture_too_large(&self) -> bool {
        self.may_be_the_picture() && says_picture_too_large(&fmt!("{}", self.err))
    }
}

// The providers' own words for a picture refused for its size, lower-cased: Anthropic's, OpenAI's,
// Google's and the routers' that pass them on.  The one list every reader goes by.
const PICTURE_TOO_LARGE: [&str; 9] = [
    "image exceeds",
    "image is too large",
    "image too large",
    "image_too_large",
    "image is too big",
    "image size exceeds",
    "image file is too large",
    "image dimensions exceed",
    "exceeds the maximum image size",
];

/// Do the provider's words say a picture was refused for its size?  See [`PICTURE_TOO_LARGE`].
pub(crate) fn says_picture_too_large(err: &str) -> bool {
    let low = err.to_lowercase();
    PICTURE_TOO_LARGE.iter().any(|m| low.contains(m))
}

/// What [`LlmClient::stream_sse`] ended on, alongside whatever it already handed `on_data`.
///
/// Two different reasons a stream returns with nothing more to read, and the caller treats
/// them differently: an abort is the app's own cancellation and the leak-nudge machinery
/// never needs to know it happened; a stall is the provider's, and the turn should read
/// honestly as `stalled` rather than as an ordinary clean end.  See `DEFAULT_STREAM_IDLE_MS`.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct StreamOutcome {
    /// The turn was stopped while the request was in flight: the browser fired the abort
    /// signal, or (natively) the read lost its race against the turn's halt.
    pub(crate) aborted: bool,
    /// No byte arrived for `stream_idle_ms`, and the connection was given up on.
    pub(crate) stalled: bool,
    /// The body bytes read; see [`StreamWatch::ended`].
    pub(crate) bytes:    u64,
    /// Milliseconds from the request to the first body byte, or the whole wait if none came.
    pub(crate) first_ms: u64,
    /// The longest quiet after the first byte, the quiet before the end included.
    pub(crate) gap_ms:   u64,
}

impl StreamOutcome {
    /// The turn was stopped while the request was in flight.
    pub(crate) const ABORTED: Self = Self { aborted: true, stalled: false, bytes: 0, first_ms: 0, gap_ms: 0 };
    /// The stream went quiet past its limit and was given up on.
    pub(crate) const STALLED: Self = Self { aborted: false, stalled: true, bytes: 0, first_ms: 0, gap_ms: 0 };
}

/// Whether an HTTP status is worth another attempt.
///
/// 429 is rate limiting and 5xx is the provider's own trouble; every other
/// status is about this request and will not change by being sent twice.
pub(crate) fn status_retryable(status: u16) -> bool {
    status == 429 || (500..600).contains(&status)
}

/// The class of a failure, read from its tags, in the words the page's `failureClass` uses.
///
/// `offline`, `timed_out`, `rate_limited` and `server_error` pass: the same dispatch again is
/// right.  Every other class fails the same way twice.  The tags are set by
/// [`TransportErr::crossed`], where the status code was still in hand, so no source line number
/// in the error's text can be mistaken for a status (ZERO-ROUND run 4).  Outermost tag first,
/// as `tags()` gathers them, so a stall wrapped around a refusal reads as the stall.
pub(crate) fn failure_class(e: &Error<ErrTag>) -> &'static str {
    for tag in e.tags() {
        match tag {
            ErrTag::Timeout                         => return "timed_out",
            ErrTag::Unreachable                     => return "offline",
            ErrTag::LimitReached                    => return "rate_limited",
            ErrTag::Upstream                        => return "server_error",
            ErrTag::Unauthorised | ErrTag::Security => return "refused",
            ErrTag::TooBig                          => return "too_large",
            _                                       => (),
        }
    }
    "other"
}

/// Read a `Retry-After` header value as milliseconds.
///
/// Only the delta-seconds form is understood.  The HTTP-date form reads as
/// absent, which falls back to the client's own backoff rather than guessing.
pub(crate) fn parse_retry_after(value: &str) -> Option<u64> {
    value.trim().parse::<u64>().ok().map(|s| s.saturating_mul(1_000))
}

/// Read the status code out of an HTTP status line.
#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn status_code(line: &str) -> Option<u16> {
    line.split_whitespace().nth(1).and_then(|c| c.parse::<u16>().ok())
}

/// Find a header's value in a raw HTTP header block, case-insensitively.
#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn header_value(headers: &str, name: &str) -> Option<String> {
    for line in headers.lines() {
        let (key, value) = match line.split_once(':') {
            Some(kv) => kv,
            None     => continue,
        };
        if key.trim().eq_ignore_ascii_case(name) {
            return Some(value.trim().to_string());
        }
    }
    None
}

/// Sleep for `ms` milliseconds on the native transport.
#[cfg(not(target_arch = "wasm32"))]
pub(crate) async fn sleep_ms(ms: u64) {
    tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
}

/// Sleep for `ms` milliseconds in the browser, via `setTimeout`.
///
/// A scope with no timer resolves immediately, so a retry still happens -- just
/// without the pause.
#[cfg(target_arch = "wasm32")]
pub(crate) async fn sleep_ms(ms: u64) {
    use wasm_bindgen::JsCast;
    use wasm_bindgen::JsValue;

    let ms = ms.min(i32::MAX as u64) as i32;
    let promise = js_sys::Promise::new(&mut |resolve: js_sys::Function, _reject| {
        let scheduled = if let Some(win) = web_sys::window() {
            win.set_timeout_with_callback_and_timeout_and_arguments_0(&resolve, ms)
        } else {
            match js_sys::global().dyn_into::<web_sys::WorkerGlobalScope>() {
                Ok(scope) => scope
                    .set_timeout_with_callback_and_timeout_and_arguments_0(&resolve, ms),
                Err(_) => Err(JsValue::NULL),
            }
        };
        if scheduled.is_err() {
            let _ = resolve.call0(&JsValue::NULL);
        }
    });
    let _ = crate::wasm::settle_js(promise).await;
}

/// Milliseconds on a clock that only moves forward.
#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn now_ms() -> u64 {
    static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    START.get_or_init(std::time::Instant::now).elapsed().as_millis() as u64
}

/// Milliseconds on the browser's monotonic clock (`performance.now()`).
///
/// Not `Date.now()`: the wall clock steps when the system clock is set or an NTP correction
/// lands.  A step back would stop the watch from ever expiring until the clock caught up, and
/// a step forward would expire a live round at once.
#[cfg(target_arch = "wasm32")]
pub(crate) fn now_ms() -> u64 {
    use wasm_bindgen::JsCast;
    let perf = match web_sys::window() {
        Some(win) => win.performance(),
        None      => js_sys::global().dyn_into::<web_sys::WorkerGlobalScope>().ok()
                         .and_then(|scope| scope.performance()),
    };
    match perf {
        Some(p) => p.now() as u64,
        None    => js_sys::Date::now() as u64,  // a scope with no performance clock at all
    }
}

/// What the stream's sink makes of one `data:` chunk, for the watch.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct Pulse {
    grew:     bool,     // the accumulator grew: real data
    thinking: bool,     // the model is reasoning and has not begun its answer
}

/// The clocks of one stream, kept apart from the transports so both read them the same way.
///
/// **A BYTE IS NOT DATA.**  The watchdog used to be re-armed by every line the provider sent,
/// and OpenRouter sends `: OPENROUTER PROCESSING` while the provider behind it says nothing:
/// the comment re-armed the timeout and was then dropped by the `data: ` test, so a round
/// whose provider never answered ran to the daimon's 30-minute cap and the turn ended
/// "Stopped".  Only progress re-arms it now -- the sink reports whether the accumulator
/// grew -- and how long the quiet may last depends on what the stream has shown:
///
/// - no `data:` chunk at all: `first_ms`, 1.5 x the idle ceiling on a first attempt;
/// - a chunk that carried nothing yet (a role, a provider's name), which shows the provider
///   took the request and is working: `wide_ms`, 5 x the ceiling, but only while some byte
///   keeps arriving -- `first_ms` after the last one, as if nothing had come;
/// - real data: `idle_ms`, except while the model is reasoning and has not begun to answer,
///   when it is `wide_ms` again.  A model that thinks without streaming its thinking (an
///   Anthropic block with the text omitted, or reasoning in bursts minutes apart) is working
///   behind its pings.  That wider limit holds only while some byte keeps arriving: a
///   connection gone wholly silent is cut at `idle_ms`, as it always was.
#[derive(Clone, Debug)]
pub(crate) struct StreamWatch {
    idle_ms:   u64,     // the limit once something has arrived
    first_ms:  u64,     // the limit before any chunk has
    wide_ms:   u64,     // the limit for a model that is working without saying so
    wait_ms:   u64,     // how often a notice is due while it is quiet
    last_real: u64,     // clock at the start, then at the last progress
    last_wait: u64,     // clock at the last notice, or progress
    last_byte: u64,     // clock at the last line of any kind, comments included
    any:       bool,    // has real data arrived
    accepted:  bool,    // has any `data:` chunk arrived
    thinking:  bool,    // is the model reasoning, with no answer yet
    quiet_cap: u64,     // the most any quiet before real data may last
    asked:     u64,     // clock when the request went out
    first_at:  Option<u64>, // clock at the first line
    gap_max:   u64,     // the longest quiet between lines after the first
    bytes:     u64,     // body bytes read
    liveness:  Option<Liveness>, // the turn's last-progress clock, beaten by every line
}

impl StreamWatch {

    pub(crate) fn new(now: u64, idle_ms: u64, first_ms: u64) -> Self {
        Self {
            idle_ms,
            first_ms,
            wide_ms:   idle_ms.saturating_mul(STALL_WAIT_FACTOR).max(first_ms),
            wait_ms:   (idle_ms / 2).max(1),
            last_real: now,
            last_wait: now,
            last_byte: now,
            any:       false,
            accepted:  false,
            thinking:  false,
            quiet_cap: u64::MAX,
            asked:     now,
            first_at:  None,
            gap_max:   0,
            bytes:     0,
            liveness:  None,
        }
    }

    // The turn's last-progress clock, beaten by every line this stream hears: see
    // [`Liveness`].  None, for a stream no turn is racing (a fold's summary, a test).
    pub(crate) fn beating(mut self, liveness: Option<Liveness>) -> Self {
        self.liveness = liveness;
        self
    }

    // When the request went out, if before the watch began: the first byte is timed from it.
    pub(crate) fn asked(mut self, asked: u64) -> Self {
        self.asked = asked.min(self.asked);
        self
    }

    // Bounds the quiet before real data, whatever the ceilings: see [`attempt_wait`].
    pub(crate) fn capped(mut self, quiet_cap: u64) -> Self {
        self.quiet_cap = quiet_cap;
        self
    }

    // A line of any kind arrived, a keep-alive comment included.  Also the round's timing
    // facts: the first byte, and the longest quiet since it.
    pub(crate) fn heard(&mut self, now: u64) {
        if let Some(live) = &self.liveness { live.beat(now); }
        if self.first_at.is_none() {
            self.first_at = Some(now);
        } else {
            self.gap_max = self.gap_max.max(now.saturating_sub(self.last_byte));
        }
        self.last_byte = now;
    }

    // `bytes` more of the body were read.
    pub(crate) fn took(&mut self, bytes: u64) {
        self.bytes = self.bytes.saturating_add(bytes);
    }

    // The stream ended at `now` with `how`: the timing facts joined to it.  The quiet from the
    // last byte to the end counts as a gap, because it is the quiet a liveness limit would cut.
    pub(crate) fn ended(&self, now: u64, how: StreamOutcome) -> StreamOutcome {
        let (first_ms, gap_ms) = match self.first_at {
            None        => (now.saturating_sub(self.asked), 0),
            Some(first) => (first.saturating_sub(self.asked),
                self.gap_max.max(now.saturating_sub(self.last_byte))),
        };
        StreamOutcome { bytes: self.bytes, first_ms, gap_ms, ..how }
    }

    // A `data:` chunk arrived, and the sink has read it.
    pub(crate) fn data(&mut self, now: u64, pulse: Pulse) {
        if let Some(live) = &self.liveness { live.beat(now); }
        self.accepted = true;
        self.thinking = pulse.thinking;
        if pulse.grew { self.progress(now); }
    }

    // Real data arrived: both clocks restart.
    fn progress(&mut self, now: u64) {
        self.any       = true;
        self.last_real = now;
        self.last_wait = now;
    }

    fn limit(&self) -> u64 {
        if self.thinking      { self.wide_ms }
        else if self.any      { self.idle_ms }
        else if self.accepted { self.wide_ms.min(self.quiet_cap) }
        else                  { self.first_ms.min(self.quiet_cap) }
    }

    // Where the wide limit gives way to plain silence.  The wide limit is for a model that is
    // working, and a working model sends something: a socket that has gone wholly silent gets
    // what it would have had with no sign of life at all.  So the reasoning state falls back to
    // the idle ceiling after the last byte, and a stream that has sent only a chunk with nothing
    // in it -- a role, a provider's name, Anthropic's `message_start` -- falls back to the
    // first-chunk ceiling.  Without the second, a dead socket after that one chunk was held
    // 5 x idle, past the page's worker limit (r541 QA N1).
    fn dead_at(&self) -> u64 {
        if self.thinking                    { self.last_byte.saturating_add(self.idle_ms) }
        else if self.accepted && !self.any  { self.last_byte.saturating_add(self.first_ms) }
        else                                { u64::MAX }
    }

    // Has the quiet outlasted its limit?
    pub(crate) fn expired(&self, now: u64) -> bool {
        now.saturating_sub(self.last_real) >= self.limit() || now >= self.dead_at()
    }

    // The seconds of quiet, if a notice is due now; arms the next one.
    pub(crate) fn tick(&mut self, now: u64) -> Option<u64> {
        if now.saturating_sub(self.last_wait) < self.wait_ms { return None; }
        self.last_wait = now;
        Some(now.saturating_sub(self.last_real) / 1000)
    }

    // Milliseconds to the next thing that needs doing: a notice or the end of the wait.
    pub(crate) fn next_in(&self, now: u64) -> u64 {
        let to_end  = self.last_real.saturating_add(self.limit()).min(self.dead_at()).saturating_sub(now);
        let to_tick = self.last_wait.saturating_add(self.wait_ms).saturating_sub(now);
        to_end.min(to_tick).max(1)
    }
}

impl LlmClient {

    /// Construct a client for the native transport (tokio + rustls).
    #[cfg(not(target_arch = "wasm32"))]
    pub fn new(
        host:       &str,
        port:       u16,
        path:       &str,
        api_key:    &str,
        model:      &str,
        max_tokens: u32,
        tls_config: Arc<ClientConfig>,
    ) -> Self {
        Self {
            dialect:    Dialect::for_endpoint(host, path),
            host:       host.to_string(),
            port,
            path:       path.to_string(),
            api_key:    Zeroizing::new(api_key.to_string()),
            model:      model.to_string(),
            max_tokens,
            retry:      RetryPolicy::default(),
            think:      new_carry(),
            tune:       std::rc::Rc::new(std::cell::Cell::new(ThinkTune::default())),
            blind:      new_blind(),
            seen:       new_blind(),
            sight:      std::rc::Rc::new(std::cell::Cell::new(0)),
            stream_idle_ms: std::rc::Rc::new(std::cell::Cell::new(DEFAULT_STREAM_IDLE_MS)),
            provider_routing: std::rc::Rc::new(std::cell::RefCell::new(ProviderRouting::default())),
            reasoning:  std::rc::Rc::new(std::cell::RefCell::new(None)),
            pin:        std::cell::RefCell::new(None),
            tls_config,
            halt:       Halt::new(),
            liveness:   None,
            plain:      false,
            dial_at:    None,
        }
    }

    /// A native client for the chat endpoint at `url` (RKEY-b): `https://host[:port]/path`, or
    /// `http://127.0.0.1:port/path` for a local mock and for nothing else.  A base without
    /// `/chat/completions` (the gateway's `https://openrouter.ai/api/v1`) has it added.
    ///
    /// The key is never in an error this makes: a refusal names the URL, never the key.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn from_url(
        url:        &str,
        api_key:    &str,
        model:      &str,
        max_tokens: u32,
        tls_config: Arc<ClientConfig>,
    ) -> Outcome<Self> {
        let (plain, host, port, path) = res!(Self::url_parts(url));
        let path = path.trim_end_matches('/');
        let path = if path.ends_with("/chat/completions") || path.ends_with("/messages") {
            path.to_string()
        } else {
            fmt!("{}/chat/completions", path)
        };
        let mut c = Self::new(&host, port, &path, api_key, model, max_tokens, tls_config);
        c.plain = plain;
        Ok(c)
    }

    /// The endpoint beside the chat endpoint `url` named `leaf`, as models.js `siblingUrl` makes
    /// it: the first `/chat/completions` becomes `/<leaf>`, or else `/<leaf>` is appended.  A row
    /// holds the chat endpoint (`https://api.mistral.ai/v1/chat/completions`), so Mistral's OCR is
    /// `sibling(url, "ocr")`, `…/v1/ocr`, on the row's own host (I3).
    pub fn sibling(url: &str, leaf: &str) -> String {
        const CHAT: &str = "/chat/completions";
        match url.find(CHAT) {
            Some(i) => fmt!("{}/{}{}", &url[..i], leaf, &url[i + CHAT.len()..]),
            None    => fmt!("{}/{}", url.trim_end_matches('/'), leaf),
        }
    }

    /// A native client for exactly `url`, nothing appended, for a raw
    /// [`post_whole`](Self::post_whole) of a body that is not a chat: Mistral's OCR [`sibling`](Self::sibling), as
    /// the tab's `ocr.js` posts it.  The URL is vetted as [`from_url`](Self::from_url)'s is.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn for_post(url: &str, api_key: &str, tls_config: Arc<ClientConfig>) -> Outcome<Self> {
        let (plain, host, port, path) = res!(Self::url_parts(url));
        let mut c = Self::new(&host, port, &path, api_key, "", 0, tls_config);
        c.plain = plain;
        Ok(c)
    }

    /// `url` read as `(plain, host, port, path)`: `https://host[:port]/path`, or
    /// `http://127.0.0.1:port/path` for a local mock and for nothing else.  The key is never in
    /// an error this makes.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn url_parts(url: &str) -> Outcome<(bool, String, u16, String)> {
        let (plain, rest) = if let Some(r) = url.strip_prefix("https://") {
            (false, r)
        } else if let Some(r) = url.strip_prefix("http://") {
            (true, r)
        } else {
            return Err(err!("A model URL begins https:// (or http://127.0.0.1 for a local mock), \
                not {:?}.", url; Invalid, Input, Security));
        };
        let (auth, path) = match rest.find('/') {
            Some(i) => (&rest[..i], &rest[i..]),
            None    => (rest, "/"),
        };
        let no_host = || err!("The model URL {:?} has no plain host.", url; Invalid, Input);
        // An IPv6 host is bracketed (`[fd00::5]:8443`, a LAN row's), so its own colons are not
        // the port's; the brackets are dropped, as connect and the TLS name want it bare.
        let (host, port) = match auth.strip_prefix('[') {
            Some(b) => match b.split_once(']') {
                Some((h, rest)) if h.parse::<std::net::Ipv6Addr>().is_ok() => match rest {
                    ""  => (h, None),
                    _   => match rest.strip_prefix(':') {
                        Some(p) => (h, Some(p)),
                        None    => return Err(no_host()),
                    },
                },
                _   => return Err(no_host()),
            },
            None    => match auth.rsplit_once(':') {
                Some((h, _)) if h.contains(':') => return Err(no_host()), // IPv6 unbracketed
                Some((h, p))                    => (h, Some(p)),
                None                            => (auth, None),
            },
        };
        let port = match port {
            Some(p) => match p.parse::<u16>() {
                Ok(n) if n > 0  => n,
                _               => return Err(err!("The model URL's port {:?} is not a port.", p;
                    Invalid, Input)),
            },
            None    => if plain { 80 } else { 443 },
        };
        if host.is_empty() || host.contains(|c: char| c == '@' || c == '?' || c == '#' || c == '[' || c == ']') {
            return Err(no_host());
        }
        if path.contains(|c: char| c == '?' || c == '#' || c.is_whitespace()) {
            return Err(err!("The model URL {:?} carries a query, fragment or space.", url; Invalid, Input));
        }
        if plain && host != "127.0.0.1" {
            return Err(err!("The model URL {:?} is plain http to somewhere other than 127.0.0.1, \
                so it is refused.", url; Invalid, Input, Security));
        }
        Ok((plain, host.to_string(), port, path.to_string()))
    }

    /// The request's `Host` value: an IPv6 host bracketed again, as HTTP requires.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn host_header(&self) -> String {
        match self.host.contains(':') {
            true    => fmt!("[{}]", self.host),
            false   => self.host.clone(),
        }
    }

    /// Whether this client speaks plain `http` (a loopback mock only).
    #[cfg(not(target_arch = "wasm32"))]
    pub fn is_plain(&self) -> bool { self.plain }

    /// POST `body` as it stands to this client's endpoint, with its key, and return the whole
    /// response body: the tab's `ocr.js` `post` for a body the tool code built itself (an OCR
    /// vision or file-parser request), sent once.  A refusal names the endpoint, never the key.
    #[cfg(not(target_arch = "wasm32"))]
    pub async fn post_whole(&self, body: &str) -> Outcome<String> {
        match self.do_request_full(body).await {
            Ok(r)   => Ok(r),
            Err(e)  => Err(e.crossed()),
        }
    }

    /// Construct a client for the wasm transport (browser `fetch`).
    ///
    /// TLS trust is handled by the browser, so no `tls_config` is
    /// required — the streaming API (`chat_stream` / `chat_once`) is
    /// otherwise identical to the native client.
    #[cfg(target_arch = "wasm32")]
    pub fn new(
        host:       &str,
        port:       u16,
        path:       &str,
        api_key:    &str,
        model:      &str,
        max_tokens: u32,
    ) -> Self {
        Self::new_with_scheme(host, port, path, api_key, model, max_tokens, true)
    }

    /// Construct a wasm client with an explicit URL scheme.
    ///
    /// `secure` selects `https` (`true`) or `http` (`false`).  Real
    /// providers always use `https`; the `http` form exists so a local
    /// mock over `127.0.0.1` can be driven in a headless test.
    #[cfg(target_arch = "wasm32")]
    pub fn new_with_scheme(
        host:       &str,
        port:       u16,
        path:       &str,
        api_key:    &str,
        model:      &str,
        max_tokens: u32,
        secure:     bool,
    ) -> Self {
        Self {
            dialect:    Dialect::for_endpoint(host, path),
            host:       host.to_string(),
            port,
            path:       path.to_string(),
            api_key:    Zeroizing::new(api_key.to_string()),
            model:      model.to_string(),
            max_tokens,
            retry:      RetryPolicy::default(),
            think:      new_carry(),
            tune:       std::rc::Rc::new(std::cell::Cell::new(ThinkTune::default())),
            blind:      new_blind(),
            seen:       new_blind(),
            sight:      std::rc::Rc::new(std::cell::Cell::new(0)),
            stream_idle_ms: std::rc::Rc::new(std::cell::Cell::new(DEFAULT_STREAM_IDLE_MS)),
            provider_routing: std::rc::Rc::new(std::cell::RefCell::new(ProviderRouting::default())),
            reasoning:  std::rc::Rc::new(std::cell::RefCell::new(None)),
            pin:        std::cell::RefCell::new(None),
            secure,
            halt:       Halt::new(),
            liveness:   None,
        }
    }

    /// Send a streaming chat completion request.
    ///
    /// Reads the SSE response line-by-line from the TLS stream, calling `on_token` for
    /// each delta *as it arrives* -- [`Delta::Text`] for the answer, [`Delta::Reasoning`]
    /// for the model's own working, which is never part of it.
    /// Returns the full accumulated response and token usage when
    /// the stream completes.
    /// A stream that failed before emitting a token is retried; one that failed
    /// after is not, because the caller has already been handed those tokens
    /// and a fresh attempt would hand them over a second time.
    pub async fn chat_stream(
        &self,
        messages:   &[ChatMessage],
        on_token:   &mut impl FnMut(Delta<'_>),
    ) -> Outcome<ChatResponse> {
        // ok!, not res!: the transport's tags (TooBig, Size, Timeout) are what the agent's fold
        // reads, and the pinned fe2o3's tags() does not look past a wrapper.
        let resp = ok!(self.stream_turn(messages, None, on_token, false).await);
        Ok(ChatResponse {
            content:           resp.content,
            prompt_tokens:     resp.prompt_tokens,
            completion_tokens: resp.completion_tokens,
            cached_tokens:     resp.cached_tokens,
            cost_usd:          resp.cost_usd,
            aborted:           resp.aborted,
            retries:           resp.retries,
            thinking:          resp.thinking,
            truncated:         resp.truncated,
            provider:          resp.provider,
            stalled:           resp.stalled,
        })
    }

    /// Streaming chat completion with tools enabled.
    ///
    /// Issues the request with `stream: true` and reconstructs the
    /// assistant turn from the SSE deltas: text and reasoning are forwarded
    /// to `on_token` as they arrive, each labelled (so the answer streams even
    /// while tools are active, and so does the working that precedes it), and
    /// any `tool_calls` fragments are accumulated across chunks into whole
    /// calls (see [`StreamAcc`]).  Returns the same
    /// [`ChatOnceResponse`] shape as [`chat_once`](Self::chat_once).
    ///
    /// A 429, a 5xx or a dropped connection is retried with bounded exponential
    /// backoff -- but only while the turn has produced nothing.  Once a token,
    /// or a fragment of a tool call, has reached the caller, a retry would
    /// deliver it twice, so the partial and the error are surfaced instead.
    /// Each retry announces itself through `on_token`, because a thirty-second
    /// turn that silently becomes ninety is its own defect.
    pub async fn chat_stream_tools(
        &self,
        messages:   &[ChatMessage],
        tools:      Option<&str>,
        on_token:   &mut impl FnMut(Delta<'_>),
    ) -> Outcome<ChatOnceResponse> {
        self.stream_turn(messages, tools, on_token, true).await
    }

    /// The conversation a resent request carries: the picture-less one once the blind retry
    /// has made it, else what the sight check left, else the caller's own.
    fn resend_of<'m>(
        blind:    &'m Option<Vec<ChatMessage>>,
        stripped: &'m Option<Vec<ChatMessage>>,
        messages: &'m [ChatMessage],
    )
        -> &'m [ChatMessage]
    {
        match (blind, stripped) {
            (Some(b), _)    => b,
            (None, Some(s)) => s,
            (None, None)    => messages,
        }
    }

    /// The one streamed turn both public streaming entry points run.
    ///
    /// Builds the request in whichever [`Dialect`] the endpoint speaks, drives
    /// the SSE response through the matching accumulator, and applies the retry
    /// policy.  `notify` decides whether a retry announces itself through
    /// `on_token`: the tool path does (a thirty-second turn that silently
    /// becomes ninety is its own defect), the plain-chat path does not, because
    /// its caller treats every token as answer text.
    ///
    /// # Arguments
    /// * `messages` - The conversation so far.
    /// * `tools` - A ready-made OpenAI-shaped tool array, translated for the
    ///   Anthropic dialect; `None` disables tools.
    /// * `on_token` - Called with each delta as it arrives, labelled by kind.
    /// * `notify` - Whether to announce a retry through `on_token`, as text.
    async fn stream_turn(
        &self,
        messages:   &[ChatMessage],
        tools:      Option<&str>,
        on_token:   &mut impl FnMut(Delta<'_>),
        notify:     bool,
    ) -> Outcome<ChatOnceResponse> {
        let images = res!(self.vision_guard(messages));
        let stripped = self.sighted(messages, images);
        let mut body = self.build_body(stripped.as_deref().unwrap_or(messages), tools, true);
        // Set once the pictures have been taken out and the turn tried again, so the retry
        // happens at most once and a second failure is reported as itself.
        let mut retried_blind = stripped.is_some();
        // Set only once the text-only retry SUCCEEDS, never on the error alone: a 429 or a context overflow is not a refusal of the picture.
        let mut blind_pending = false;
        let mut waited = 0u64;
        let mut retries = 0u32;
        // The picture-less messages, once the blind retry has made them, so that a stalled
        // round asked again sends the same conversation as the one it replaces.
        let mut blind_msgs: Option<Vec<ChatMessage>> = None;
        // Rounds that produced nothing at all and were asked again, and the providers
        // they are asked to leave out.
        let mut stall_tries = 0u32;
        let mut stall_ignore: Vec<String> = Vec::new();
        // Set once a retry that left a provider out was refused for it and sent again without.
        let mut unexcluded = false;
        // When the turn began, so a stall reports the wait of every attempt and not the last.
        let turn_began = now_ms();
        let idle = self.stream_idle_ms.get();
        loop {
            // A STOPPED TURN SENDS NOTHING MORE, asked at the top of EVERY attempt.  A Stop or a
            // pause in `www/js/daimond.js` may land during the backoff
            // between attempts or between two rounds, where there is no request to cancel; the
            // halt is the turn's and stays set, so it is read here before anything goes out.  It
            // was read only once a retry was in hand, from the last controller armed, and an
            // abort landing between rounds was lost (PQA W).  A clean stop, so the round returns
            // aborted, never an error.
            if self.halted() {
                return Ok(Acc::new(self.dialect).into_response(true, retries));
            }
            let mut acc = Acc::new(self.dialect);
            let mut emitted = false;
            let (first_ms, quiet_cap) = attempt_wait(idle, stall_tries,
                now_ms().saturating_sub(turn_began));
            // The host's speed (D-20261020-10): when this attempt went out, and when its first
            // token came -- the first chunk that grew the reply, which a keep-alive does not.
            let asked = now_ms();
            let mut tok_at: Option<u64> = None;
            let outcome = {
                let mut sink = |w: Wire<'_>| -> Pulse {
                    match w {
                        Wire::Data(data) => {
                            let before = acc.size();
                            acc.ingest(data, &mut |d: Delta<'_>| {
                                // ONLY TEXT MAKES A TURN UNREPEATABLE. Reasoning already shown and
                                // then shown again reads as the model thinking twice, which is odd;
                                // an answer delivered twice is wrong. So a turn that has only
                                // reasoned so far is still safe to start over.
                                if matches!(d, Delta::Text(_)) { emitted = true; }
                                on_token(d);
                            });
                            if tok_at.is_none() && acc.size() > before { tok_at = Some(now_ms()); }
                            // PROGRESS IS GROWTH.  A role-only chunk or a usage block parses and
                            // adds nothing, and does not hold the watchdog off; it does show the
                            // provider took the request.  And a model reasoning with no answer
                            // yet is allowed its quiet: see [`StreamWatch`].
                            Pulse { grew: acc.size() > before, thinking: acc.thinking_open() }
                        }
                        Wire::Silence(secs) => {
                            // THIS round's provider, and none until a chunk names one.  The
                            // client is shared by every Diamond on the model, so a name kept
                            // from an earlier round would be somebody else's.
                            on_token(Delta::Waiting { provider: acc.provider(), secs });
                            Pulse::default()
                        }
                    }
                };
                self.stream_sse(&body, first_ms, quiet_cap, &mut sink).await
            };
            // An `error` event on a 200 stream is the provider's own trouble
            // arriving after the headers, so it is classified like a status code
            // rather than read as a short answer.
            let outcome = match outcome {
                Ok(o) => match acc.stream_error() {
                    Some(e) if !emitted && !acc.has_output() => Err(e),
                    _ => Ok(o),
                },
                Err(e) => Err(e),
            };
            match outcome {
                // A ROUND THAT NEVER SAID ANYTHING.  The provider took the request and went
                // quiet behind OpenRouter's keep-alives, which used to hold the round to the
                // daimon's 30-minute cap.  Asked again once, with that provider left out where
                // OpenRouter can be told so; if that is silent too, the turn ends with a plain
                // reason.  It is an error and not an empty `Ok`, because an empty answer
                // reaches the agent's nudges, which would send ANOTHER request.  A round that
                // had begun to reason keeps the old way out: it has something to show.
                Ok(StreamOutcome { aborted: false, stalled: true, .. })
                    if acc.size() == 0 && !self.halted() =>
                {
                    let secs = now_ms().saturating_sub(turn_began) / 1000;
                    // Only the provider THIS round named is blamed and left out.  A round
                    // that named nobody leaves nothing out, and the error names the model.
                    let named = acc.provider().to_string();
                    crate::hostspeed::record(&self.model, &named, crate::hostspeed::Sample {
                        at: crate::hostspeed::wall_ms(), stalled: true,
                        ..crate::hostspeed::Sample::default() });
                    if stall_tries < STALL_RETRIES {
                        stall_tries += 1;
                        self.exclude_stalled(&named, &mut stall_ignore);
                        on_token(Delta::Stalled { provider: &named, secs, retrying: true });
                        let cur = Self::resend_of(&blind_msgs, &stripped, messages);
                        body = self.build_body_ignoring(cur, tools, true, &stall_ignore);
                        continue;
                    }
                    on_token(Delta::Stalled { provider: &named, secs, retrying: false });
                    let who = if named.is_empty() { self.model.clone() } else { named.clone() };
                    return Err(self.vision_error(TransportErr::fatal(
                        fmt!("the model did not answer ({})", who),
                        err!("LLM: no data from '{}' in {} s, asked twice.", who, secs;
                            IO, Network, Timeout)).crossed(), images));
                }
                Ok(StreamOutcome { aborted, stalled, bytes, first_ms, gap_ms }) => {
                    // The native transport cannot cut a read, so a Stop that landed during a
                    // silent wait only shows when the watch gives up: that round is the
                    // person's stop, not a model that ended without a word.
                    let aborted = aborted || (stalled && self.halted());
                    if blind_pending { self.mark_blind(); }
                    else if images > 0 && !retried_blind && !aborted { self.mark_seen(); }
                    let thinking = acc.take_thinking();
                    let mut resp = acc.into_response(aborted, retries);
                    resp.stalled = stalled;
                    // The timing facts are this attempt's; the round's length counts from its
                    // first request, retries included.
                    resp.bytes    = bytes;
                    resp.first_ms = first_ms;
                    resp.gap_ms   = gap_ms;
                    resp.ms       = now_ms().saturating_sub(turn_began);
                    let ended = now_ms();
                    if let Some(t) = tok_at {
                        resp.tok_ms = t.saturating_sub(asked);
                        resp.gen_ms = ended.saturating_sub(t);
                    }
                    // EVERY ROUND IS MEASURED, whoever asked for it: a chat's, a daimon's, a
                    // worker's and a fold's all come through here.  A stopped round is the
                    // person's doing and says nothing about the host.
                    if !aborted {
                        let host = if resp.provider.is_empty() { &self.host } else { &resp.provider };
                        crate::hostspeed::record(&self.model, host, crate::hostspeed::Sample {
                            at:       crate::hostspeed::wall_ms(),
                            first_ms: resp.tok_ms,
                            gen_ms:   resp.gen_ms,
                            out:      resp.completion_tokens,
                            stalled,
                        });
                    }
                    // ANTHROPIC REPORTS NO `cost` AT ALL: the account is billed and the API says
                    // nothing about what one call cost, so `into_response` above always hands
                    // back zero here. The spend cap is inert against that zero and the ledger
                    // reads $0 on a call that plainly cost something -- so it is booked from the
                    // token counts the same response already carries, at list price.
                    if resp.cost_usd == 0.0 && matches!(self.dialect, Dialect::Anthropic) {
                        resp.cost_usd = anthropic_list_price_usd(&self.model,
                            resp.prompt_tokens, resp.completion_tokens, resp.cached_tokens);
                    }
                    // The signed reasoning of a turn that asked for tools is held
                    // for the request that returns their results; see [`ThinkCarry`].
                    if let Some(tc) = resp.tool_calls.first() {
                        self.carry_put(&tc.id, thinking);
                    }
                    return Ok(resp);
                }
                Err(e) => {
                    // Anything the caller has already seen -- streamed text, or a
                    // tool-call fragment that will become one -- makes this turn
                    // unrepeatable.
                    let started = emitted || acc.has_output();
                    // THE EXCLUSION MAY BE WHAT WAS REFUSED.  Where the provider that stalled
                    // was the only one serving the model (or the only one taking this request's
                    // tools or data policy), OpenRouter answers the retry that leaves it out
                    // with a 404 "No allowed providers".  The retry was for a fresh connection,
                    // not for that refusal, so it is sent once more without the exclusion; if
                    // that stalls too, the ordinary end applies and the person is told the
                    // model did not answer, never the 404.
                    // The hosts left out for being measured slow are the same case: where they
                    // were all the model had, they stand down for a while and the request goes
                    // again without them.
                    let measured = self.measured_avoid();
                    if (!stall_ignore.is_empty() || !measured.is_empty()) && !unexcluded && !started
                        && !e.retryable && e.status != 0
                    {
                        unexcluded = true;
                        stall_ignore.clear();
                        if !measured.is_empty() {
                            crate::hostspeed::stand_down(&self.model, crate::hostspeed::wall_ms());
                        }
                        let cur = Self::resend_of(&blind_msgs, &stripped, messages);
                        body = self.build_body_ignoring(cur, tools, true, &stall_ignore);
                        continue;
                    }
                    // A REFUSED PICTURE IS NOT A DEAD TURN. The provider would not take this
                    // request and it carried images, so the likeliest reason is the one thing
                    // in it a text model cannot read. Take them out, say so in their place, and
                    // send it again -- once. Only where nothing has been emitted: a turn the
                    // user has already seen tokens from cannot be started over.
                    if !started && !retried_blind && images > 0 && e.may_be_the_picture() {
                        // A picture too large is not a model that cannot see: it goes, and
                        // the model is not marked blind.
                        let too_large = e.picture_too_large();
                        retried_blind = true;
                        blind_pending = !too_large;
                        let why = if too_large { Dropped::TooLarge } else { self.dropped_why(true) };
                        let text_only: Vec<ChatMessage> =
                            messages.iter()
                            .map(|m| m.with_content(m.content().without_images(why)))
                            .collect();
                        body = self.build_body_ignoring(&text_only, tools, true, &stall_ignore);
                        blind_msgs = Some(text_only);
                        if notify {
                            // The provider's list says it sees: the request was refused, not the
                            // model blind, and the notice says which.
                            let verdict = if too_large {
                                if images == 1 { "it is too large for the provider" }
                                else { "they are too large for the provider" }
                            } else if self.declared() == Some(true) {
                                "the provider refused the request, though it lists this model as \
                                 taking pictures"
                            } else {
                                "it cannot see"
                            };
                            on_token(Delta::Text(&fmt!(
                                "\n[daimond: the model would not take {} image{}; asking again \
                                 without {} -- {}]\n",
                                images,
                                if images == 1 { "" } else { "s" },
                                if images == 1 { "it" } else { "them" },
                                verdict)));
                        }
                        continue;
                    }
                    if started || !e.retryable {
                        return Err(self.vision_error(e.crossed(), images));
                    }
                    let delay = match self.retry.next_delay(retries, waited, e.after_ms) {
                        Some(d) => d,
                        None    => return Err(self.vision_error(e.crossed(), images)),
                    };
                    waited += delay;
                    retries += 1;
                    if notify {
                        // A RETRY NOTICE IS NOT ANSWER PROSE. It used to go out as
                        // `Delta::Text`, so the app appended "[daimond: … retrying …]"
                        // into the reply tile (it persisted as the stored turn text) and
                        // flipped the caption to "Writing the answer…" while the request
                        // was in fact failing and being retried. It is a `Roading` delta
                        // now: the caller shows a retry caption and writes nothing to the
                        // transcript, the same way the tool-loop road ladder already does.
                        on_token(Delta::Roading {
                            attempt: retries + 1,
                            of:      self.retry.max_attempts,
                            wait_ms: delay,
                        });
                    }
                    sleep_ms(delay).await;
                }
            }
        }
    }

    /// Non-streaming chat completion, optionally with tools.
    ///
    /// Returns the assistant content and any `tool_calls` the model
    /// wants executed, plus token usage.  Retained for callers that
    /// prefer a single whole-response parse over streamed fragments.
    pub async fn chat_once(
        &self,
        messages:   &[ChatMessage],
        tools:      Option<&str>,
    ) -> Outcome<ChatOnceResponse> {
        let images = res!(self.vision_guard(messages));
        let stripped = self.sighted(messages, images);
        let mut body = self.build_body(stripped.as_deref().unwrap_or(messages), tools, false);
        let mut retried_blind = stripped.is_some();
        // Set only once the text-only retry SUCCEEDS, never on the error alone: a 429 or a context overflow is not a refusal of the picture.
        let mut blind_pending = false;
        let mut waited = 0u64;
        let mut retries = 0u32;
        let raw = loop {
            // A stopped turn sends nothing more, as in `stream_turn`. The fold has no partial to
            // preserve, so the aborted response is returned as itself (its empty content ends
            // the fold upstream).
            if self.halted() {
                return Ok(Acc::new(self.dialect).into_response(true, retries));
            }
            match self.do_request_full(&body).await {
                Ok(r)  => break r,
                Err(e) => {
                    // Nothing streams on this path, so there is never a partial
                    // to protect -- only the classification matters.
                    // The picture retry, exactly as `stream_turn` does it and for the same
                    // reason; there is no emitted-tokens condition here because nothing has
                    // been shown to anybody yet.
                    if !retried_blind && images > 0 && e.may_be_the_picture() {
                        let too_large = e.picture_too_large();
                        retried_blind = true;
                        blind_pending = !too_large;
                        let why = if too_large { Dropped::TooLarge } else { self.dropped_why(true) };
                        let text_only: Vec<ChatMessage> =
                            messages.iter()
                            .map(|m| m.with_content(m.content().without_images(why)))
                            .collect();
                        body = self.build_body(&text_only, tools, false);
                        continue;
                    }
                    if !e.retryable {
                        return Err(self.vision_error(e.crossed(), images));
                    }
                    let delay = match self.retry.next_delay(retries, waited, e.after_ms) {
                        Some(d) => d,
                        None    => return Err(self.vision_error(e.crossed(), images)),
                    };
                    waited += delay;
                    retries += 1;
                    sleep_ms(delay).await;
                }
            }
        };
        if blind_pending { self.mark_blind(); }
        else if images > 0 && !retried_blind { self.mark_seen(); }
        match self.dialect {
            // ONE PARSER FOR BOTH PATHS.  `chat_once` had a parser of its own for the whole
            // completion it asks for, which read none of the reasoning and fell behind every
            // field the stream's parser learned since.  The body now goes through the stream's
            // line discipline and accumulator: a whole completion is a delta that says
            // everything at once, an event stream sent anyway is read as one, and a body that
            // is neither is an error naming who sent it (see `deliver_body`).
            Dialect::OpenAi => {
                let mut acc = Acc::new(self.dialect);
                let mut lines = SseLines::new(None);
                let mut sink = |w: Wire<'_>| -> Pulse {
                    if let Wire::Data(data) = w { acc.ingest(data, &mut |_| {}); }
                    Pulse::default()
                };
                for line in raw.lines() {
                    match lines.sort(line) {
                        SseLine::Data(data) => { sink(Wire::Data(data)); }
                        SseLine::Done       => break,
                        SseLine::Skip       => {}
                    }
                }
                if let Some(b) = lines.body() {
                    if let Err(e) = self.deliver_body(200, b, &mut sink) {
                        return Err(e.crossed());
                    }
                }
                Ok(acc.into_response(false, retries))
            }
            Dialect::Anthropic => Ok(self.anthropic_whole(&raw, retries)),
        }
    }

    /// A whole Anthropic Messages response as a [`ChatOnceResponse`].  Its shape is not a
    /// stream's events, so it has a parser of its own; see [`parse_anthropic_response`].
    fn anthropic_whole(&self, raw: &str, retries: u32) -> ChatOnceResponse {
        let (content, tool_calls, use_, thinking) = parse_anthropic_response(raw);
        let thinking_text = thinking.iter()
            .filter_map(|b| extract_json_string(b, "thinking"))
            .filter(|s| !s.is_empty())
            .collect::<Vec<String>>()
            .join("\n");
        if let Some(tc) = tool_calls.first() {
            self.carry_put(&tc.id, thinking);
        }
        // See the same branch in `stream_turn`: Anthropic reports no `cost` at all, so `use_`
        // always carries zero here and the ledger is booked from the token counts instead.
        let cost_usd = if use_.cost_usd == 0.0 {
            anthropic_list_price_usd(&self.model, use_.prompt, use_.completion, use_.cached)
        } else {
            use_.cost_usd
        };
        // The four trace fields are empty: the Anthropic dialect sends none of them.
        ChatOnceResponse {
            content,
            tool_calls,
            prompt_tokens:     use_.prompt,
            completion_tokens: use_.completion,
            cached_tokens:     use_.cached,
            cost_usd,
            aborted:           false,
            retries,
            thinking:          thinking_text,
            truncated:         anthropic_truncated(raw),
            stalled:           false,
            shape:             ReplyShape::Plain,
            gen_id:               String::new(),
            finish_reason:        String::new(),
            native_finish_reason: String::new(),
            provider:             String::new(),
            // Set by `stream_turn` from the `StreamOutcome`; zero on a whole reply.
            bytes: 0, first_ms: 0, gap_ms: 0, ms: 0, tok_ms: 0, gen_ms: 0,
        }.classified()
    }

    /// Refuse, before the request is built, to send an image to a model known not to see.
    ///
    /// Returns how many images the conversation carries, which is zero on nearly every turn and
    /// is what [`vision_error`](Self::vision_error) needs afterwards.
    ///
    /// The refusal names the model, because that is the fact the user has to act on: the app
    /// cannot tell them which model to pick, but it can tell them the one they picked is the
    /// reason nothing was looked at.  A provider's own 400 says none of that -- at best it names
    /// a content type.
    ///
    /// # Arguments
    /// * `messages` - The conversation about to be sent.
    /// Whether this endpoint has already been caught refusing pictures.
    fn is_blind(&self) -> bool {
        match self.declared() {
            Some(d) => !d,
            None    => self.refused(),
        }
    }

    /// The learned flag alone: has a request carrying pictures been turned away here?
    fn refused(&self) -> bool {
        #[cfg(not(target_arch = "wasm32"))]
        { self.blind.load(std::sync::atomic::Ordering::Relaxed) }
        #[cfg(target_arch = "wasm32")]
        { self.blind.get() }
    }

    /// What the provider's model list says of this model: `Some(true)` takes pictures,
    /// `Some(false)` is text-only, `None` when it said nothing or was never asked.
    pub(crate) fn declared(&self) -> Option<bool> {
        match self.sight.get() {
            1 => Some(true),
            2 => Some(false),
            _ => None,
        }
    }

    /// Take the provider's word on pictures, from the `/models` reply the page already holds.
    ///
    /// The provider knows its own models and a hand table does not, so what it says outranks
    /// both name tables ([`model_can_see`], [`model_sight_proven`]) and a refusal.  A refusal
    /// of a model it lists as seeing is a fault in the request or the route, and is not
    /// recorded as blindness.  Applies from the next request.
    ///
    /// # Arguments
    /// * `state` - 1 the list shows pictures accepted, -1 text-only, anything else nothing said.
    pub fn set_sight(&self, state: i32) {
        self.sight.set(match state { 1 => 1, -1 => 2, _ => 0 });
    }

    /// Where this client's verdict on pictures comes from, for a message that must name it.
    pub(crate) fn sight_source(&self) -> &'static str {
        if self.declared().is_some()    { "provider" }
        else if !model_can_see(&self.model) { "table" }
        else                            { "refusal" }
    }

    /// Why pictures come out of a request or a tool reply for this client, as the elision says it.
    ///
    /// # Arguments
    /// * `refused` - Whether the provider has just turned a request with pictures away.
    pub(crate) fn dropped_why(&self, refused: bool) -> Dropped {
        match (self.declared(), refused) {
            (Some(true),  true)  => Dropped::Refused,
            (Some(true),  false) => Dropped::Unconfirmed,
            (Some(false), _)     => Dropped::Listed,
            (None, _)            => {
                if refused || !model_can_see(&self.model) || self.refused() {
                    Dropped::Unseeable
                } else {
                    Dropped::Unconfirmed
                }
            }
        }
    }

    /// Record that it does, so no later turn pays to find out again.
    ///
    /// Not recorded where the provider lists the model as taking pictures: the refusal was
    /// about the request, and a sticky verdict of blindness would be the provider's list
    /// contradicted by one bad call.
    fn mark_blind(&self) {
        if self.declared() == Some(true) {
            return;
        }
        #[cfg(not(target_arch = "wasm32"))]
        { self.blind.store(true, std::sync::atomic::Ordering::Relaxed) }
        #[cfg(target_arch = "wasm32")]
        { self.blind.set(true) }
    }

    /// Has this endpoint answered a request that carried a picture without refusing it?
    fn is_seen(&self) -> bool {
        #[cfg(not(target_arch = "wasm32"))]
        { self.seen.load(std::sync::atomic::Ordering::Relaxed) }
        #[cfg(target_arch = "wasm32")]
        { self.seen.get() }
    }

    /// Record that it has: the model takes a picture, whatever the allow-list says of its name.
    ///
    /// Learned, never persisted, and shared across clones as `blind` is. Set only where a
    /// picture went out whole and the answer came back (not aborted, not the text-only retry),
    /// so a refusal never proves anything and [`mark_blind`](Self::mark_blind) still outranks it.
    pub(crate) fn mark_seen(&self) {
        #[cfg(not(target_arch = "wasm32"))]
        { self.seen.store(true, std::sync::atomic::Ordering::Relaxed) }
        #[cfg(target_arch = "wasm32")]
        { self.seen.set(true) }
    }

    /// May a picture be put in front of this endpoint?
    ///
    /// Both halves of what is known, and nothing else: the deny-list [`model_can_see`] before any
    /// request has been sent, and the refusal [`is_blind`](Self::is_blind) records after one has
    /// been turned away.  There is no third source -- no `vision` flag is published by anybody --
    /// so a model released after this line was written is taken to see until it says otherwise.
    pub fn can_take_images(&self) -> bool {
        match self.declared() {
            Some(d) => d,
            None    => model_can_see(&self.model) && !self.refused(),
        }
    }

    /// Is this endpoint KNOWN to take pictures: a model on the allow-list
    /// ([`model_sight_proven`]) or one that has taken a picture ([`mark_seen`](Self::mark_seen)),
    /// and has not been turned away?
    ///
    /// What the engine tells a tool, where [`can_take_images`](Self::can_take_images) is what the
    /// request layer asks before it sends one.  A tool that spends a picture's bytes on the
    /// chance that a model sees it asks this, so a model nobody has proven reads the table.
    pub fn sight_proven(&self) -> bool {
        match self.declared() {
            Some(d) => d,
            None    => self.can_take_images()
                && (self.is_seen() || model_sight_proven(&self.model)),
        }
    }

    /// The conversation as it must be sent: whole, or with the pictures turned into words when
    /// this endpoint has been caught refusing them.
    ///
    /// Returns `None` when nothing needs changing, so the ordinary turn copies no messages.
    fn sighted<'m>(&self, messages: &'m [ChatMessage], images: usize)
        -> Option<Vec<ChatMessage>>
    {
        if images == 0 || !self.is_blind() {
            return None;
        }
        let _ = messages.len();
        let why = self.dropped_why(false);
        Some(messages.iter()
                            .map(|m| m.with_content(m.content().without_images(why)))
                            .collect())
    }

    fn vision_guard(&self, messages: &[ChatMessage]) -> Outcome<usize> {
        let images: usize = messages.iter().map(|m| m.content().images().count()).sum();
        // A refusal already seen is not an error any more: the pictures come out and the turn
        // goes ahead. Refusing here instead would leave a conversation that carries one image
        // permanently unable to take a turn -- which is what happened to a real Diamond on
        // 2026-08-13, where a cover read into the daimon's history bricked every later steer.
        if images == 0 || self.declared().unwrap_or_else(|| model_can_see(&self.model))
            || self.is_blind()
        {
            return Ok(images);
        }
        Err(err!(
            "The model '{}' cannot see. This turn carries {} image{} and that model takes text \
             only, so it would answer as though nothing had been shown to it. Choose a model with \
             vision and read the file again.",
            self.model, images, if images == 1 { "" } else { "s" };
            Invalid, Input, Unimplemented))
    }

    /// Say what a failed request that carried images most likely failed for.
    ///
    /// [`vision_guard`](Self::vision_guard) can only refuse a model it has been told about, and no
    /// list of those is ever complete -- Daimond takes an arbitrary endpoint and an arbitrary
    /// model id.  So the second half of the answer is here: when a turn that carried images comes
    /// back refused, and the provider's words are about images, the model is named and the reason
    /// is said plainly, with the provider's own sentence kept after it rather than replaced.
    ///
    /// A failure with no images in the turn, or whose text says nothing about them, is returned
    /// exactly as it arrived.  Guessing at an unrelated failure would be worse than saying nothing.
    ///
    /// # Arguments
    /// * `e` - The error the provider produced.
    /// * `images` - How many images the refused turn carried.
    fn vision_error(&self, e: Error<ErrTag>, images: usize) -> Error<ErrTag> {
        // A refusal for size is the fold's to answer, and its words may well mention the image
        // that made the request too big; it is not the model failing to see.
        if images == 0 || e.tags().contains(&ErrTag::TooBig) {
            return e;
        }
        let low = fmt!("{}", e).to_lowercase();
        let about_images = [
            "image", "vision", "multimodal", "media_type", "media type", "image_url",
        ].iter().any(|m| low.contains(m));
        if !about_images {
            return e;
        }
        err!(
            "The model '{}' could not be shown the {} image{} in this turn -- it appears not to \
             see. Choose a model with vision. The provider said: {}",
            self.model, images, if images == 1 { "" } else { "s" }, e;
            Invalid, Input, Unimplemented)
    }

    /// Build the JSON request body for the OpenAI-compatible API.
    ///
    /// `tools` (if present) is a ready-made JSON array injected as the
    /// `tools` field with `tool_choice: auto`.  `stream` toggles SSE
    /// streaming and usage reporting.
    ///
    /// Messages chosen by [`cache_breakpoints`](Self::cache_breakpoints) carry an
    /// Anthropic `cache_control` marker.  Providers that cache automatically
    /// ignore it; Claude models, which do not, need it or an agentic session
    /// re-pays full price for the same prompt on every round.
    ///
    /// **The one place an app note is joined to the person's words** (see
    /// [`crate::protocol::join_notes`]), because every request in this client, whichever dialect
    /// carries it, is built here.  Neither builder below reads a message's `pre`.
    pub(crate) fn build_body(&self, messages: &[ChatMessage], tools: Option<&str>, stream: bool) -> String {
        self.build_body_ignoring(messages, tools, stream, &[])
    }

    /// [`build_body`](Self::build_body) with more providers left out for this one request.
    ///
    /// `extra` joins the person's own `ignore` list on OpenRouter's `provider.ignore` and is
    /// never stored: it is what a round that stalled asks again with.  The Anthropic dialect
    /// has no such field and passes over it.
    fn build_body_ignoring(
        &self,
        messages: &[ChatMessage],
        tools:    Option<&str>,
        stream:   bool,
        extra:    &[String],
    )
        -> String
    {
        let sent = crate::protocol::join_notes(messages);
        match self.dialect {
            Dialect::OpenAi    => self.build_openai_body(&sent, tools, stream, extra),
            Dialect::Anthropic => self.build_anthropic_body(&sent, tools, stream),
        }
    }

    /// Leave `culprit` out of the next attempt, if that is permitted.
    ///
    /// Not when the person set `only` (they asked for these providers and no others, and a
    /// retry that routed around that would be a decision made for them), nor when no provider
    /// is known, nor when it is listed already.  The retry then goes out unchanged, which
    /// still gets a fresh connection and, on OpenRouter, a fresh choice of provider.
    ///
    /// A stall on the conversation's pinned host also clears the pin, whatever else holds: the
    /// host that answers the retry is the one [`settle_pin`](Self::settle_pin) pins next.  A
    /// stall that names no host (keep-alives and no data chunk) clears it too: the pinned host
    /// was asked first, so it is the likely culprit, though not proven enough to ignore.
    fn exclude_stalled(&self, culprit: &str, ignore: &mut Vec<String>) {
        let pinned = matches!(&*self.pin.borrow(), Some(p) if culprit.is_empty() || p.host == culprit);
        if pinned { *self.pin.borrow_mut() = None; }
        if culprit.is_empty() || self.provider_routing.borrow().only { return; }
        if ignore.iter().any(|p| p == culprit) { return; }
        ignore.push(culprit.to_string());
    }

    /// The hosts measured slow for this model that a request to OpenRouter leaves out.  None
    /// when the person set `only`, nor one they typed into `order`: their choice outranks a
    /// measurement.
    fn measured_avoid(&self) -> Vec<String> {
        if !self.host.contains("openrouter") { return Vec::new(); }
        let routing = self.provider_routing.borrow();
        if routing.only { return Vec::new(); }
        crate::hostspeed::avoid(&self.model).into_iter()
            .filter(|h| !routing.order.iter().any(|o| o == h)).collect()
    }

    /// Hand this client the conversation's pin for the round about to be sent.
    pub fn set_pin(&self, pin: Option<HostPin>) {
        *self.pin.borrow_mut() = pin;
    }

    pub fn pin(&self) -> Option<HostPin> {
        self.pin.borrow().clone()
    }

    /// The pin after a round, for the conversation to keep.
    ///
    /// A round that finished on a named host pins it when there is no pin for this model -- none
    /// yet, one cleared by a stall, or one taken under another model.  A standing pin is not
    /// moved by a round a fallback answered: the pinned host is still the one asked for.  A
    /// stalled or stopped round names no host worth asking for again, and a pin taken under
    /// another model is dropped, whichever round this was.
    ///
    /// A pinned host is let go when this round stalled on it, or when its measured speed over
    /// the window (`crate::hostspeed`) is slow; a host measured slow is never pinned.  A quick
    /// pinned host is kept, so the conversation's prompt cache is met again (D-20261020-10).
    pub fn settle_pin<R: PinRound>(&self, resp: &R) -> Option<HostPin> {
        let mut pin = self.pin.borrow_mut();
        if matches!(&*pin, Some(p) if p.model != self.model) { *pin = None; }
        if matches!(&*pin, Some(p) if (resp.stalled() && p.host == resp.host())
            || crate::hostspeed::is_slow(&self.model, &p.host))
        {
            *pin = None;
        }
        if pin.is_none() && resp.ended_clean() && !resp.host().is_empty()
            && !crate::hostspeed::is_slow(&self.model, resp.host())
        {
            *pin = Some(HostPin { model: self.model.clone(), host: resp.host().to_string() });
        }
        pin.clone()
    }

    /// The OpenAI-compatible request body.
    ///
    /// See [`build_body`](Self::build_body) for the shared contract.
    ///
    /// One thing here is not a straight translation of the message list.  A `tool` message on this
    /// side may hold text and nothing else -- the content-part union for that role has no image
    /// member -- so an image returned by a tool cannot ride in the reply that returned it.  It is
    /// re-homed instead: the tool reply carries its text, and the images from a whole RUN of tool
    /// replies are emitted together in one `user` message directly after the run.  After the run
    /// and not between the replies, because a run of `tool` messages answers one assistant turn
    /// and a message of another role wedged inside it is a conversation the API rejects.
    fn build_openai_body(
        &self,
        messages: &[ChatMessage],
        tools:    Option<&str>,
        stream:   bool,
        extra:    &[String],
    )
        -> String
    {
        let marks = self.cache_breakpoints(messages, tools);
        let mut out = String::with_capacity(1024);
        out.push('{');
        out.push_str(&fmt!("\"model\":\"{}\",", self.model));
        out.push_str("\"messages\":[");
        let mut first = true;
        // Images lifted out of the tool replies of the run now being emitted.
        let mut carried: Vec<String> = Vec::new();
        for (i, msg) in messages.iter().enumerate() {
            if !matches!(msg, ChatMessage::Tool { .. }) && !carried.is_empty() {
                if !first { out.push(','); }
                out.push_str(&tool_image_message(&carried));
                carried.clear();
                first = false;
            }
            if let ChatMessage::Tool { content, .. } = msg {
                for img in content.images() {
                    carried.push(fmt!(
                        "{{\"type\":\"image_url\",\"image_url\":{{\"url\":\"data:{};base64,{}\"}}}}",
                        img.media.mime(), img.base64()));
                }
            }
            // An assistant turn that said nothing and asked for nothing -- a round stopped before
            // its first byte, in a session saved before that stopped being stored -- is not
            // carried: a strict provider (Anthropic behind a router) refuses an empty one.
            if let ChatMessage::Assistant { content, tool_calls } = msg {
                if tool_calls.is_empty() && content.as_text().trim().is_empty() { continue; }
            }
            if !first { out.push(','); }
            first = false;
            if marks.contains(&i) {
                out.push_str(&message_to_json_cached(msg));
            } else {
                out.push_str(&message_to_json(msg));
            }
        }
        if !carried.is_empty() {
            if !first { out.push(','); }
            out.push_str(&tool_image_message(&carried));
        }
        out.push_str("],");
        if let Some(t) = tools {
            out.push_str(&fmt!("\"tools\":{},", t));
            out.push_str("\"tool_choice\":\"auto\",");
        }
        // OPENROUTER'S OWN PROVIDER ROUTING, from the model's own row -- and only ever sent
        // to OpenRouter itself: a direct provider has no `provider` field in its own API and
        // this app must never guess it would ignore one gracefully. No provider name is
        // hard-coded on this side; every entry here is whatever the user typed.
        if self.host.contains("openrouter") {
            // HOSTS MEASURED SLOW for this model (D-20261020-10), from `crate::hostspeed`.
            let measured = self.measured_avoid();
            let routing = self.provider_routing.borrow();
            // The person's list first, then what this request adds; none twice.
            let mut ignore: Vec<&String> = routing.ignore.iter().collect();
            for e in extra.iter().chain(measured.iter()) {
                if !ignore.iter().any(|p| *p == e) { ignore.push(e); }
            }
            // THE CONVERSATION'S HOST, asked for first so its prompt cache is met again, with
            // fallbacks allowed so a host that is down costs a miss and not the round.  Never
            // over the person's own routing: a typed order wins, `only` is theirs to narrow,
            // and a host they or this round's stall ignore is not asked for.  The name goes as
            // the response gave it: OpenRouter's `ProviderName` schema, which `order` takes, is
            // these display names ("InferenceNet", "DeepInfra").
            let pin = self.pin.borrow();
            let pinned = match &*pin {
                Some(p) if routing.order.is_empty() && !routing.only && p.model == self.model
                    && !p.host.is_empty() && !ignore.iter().any(|i| **i == p.host) => Some(&p.host),
                _ => None,
            };
            if !routing.order.is_empty() || pinned.is_some() || !ignore.is_empty() {
                out.push_str("\"provider\":{");
                let mut wrote = false;
                if !routing.order.is_empty() {
                    out.push_str("\"order\":[");
                    out.push_str(&routing.order.iter()
                        .map(|p| fmt!("\"{}\"", json_escape(p)))
                        .collect::<Vec<String>>().join(","));
                    out.push(']');
                    wrote = true;
                } else if let Some(host) = pinned {
                    out.push_str(&fmt!("\"order\":[\"{}\"]", json_escape(host)));
                    wrote = true;
                }
                if !ignore.is_empty() {
                    if wrote { out.push(','); }
                    out.push_str("\"ignore\":[");
                    out.push_str(&ignore.iter()
                        .map(|p| fmt!("\"{}\"", json_escape(p)))
                        .collect::<Vec<String>>().join(","));
                    out.push(']');
                    wrote = true;
                }
                if routing.only {
                    if wrote { out.push(','); }
                    out.push_str("\"allow_fallbacks\":false");
                } else if pinned.is_some() {
                    out.push_str(",\"allow_fallbacks\":true");
                }
                // Where a host has been measured slow, OpenRouter's own choice among the rest
                // prefers hosts that meet a throughput floor.  Never a `sort`: it switches off
                // OpenRouter's price weighting, and the fast hosts are often the dear ones, so
                // a turn would cost up to 2.6x without his say (INT QA M-a, 2026-10-23).
                if !measured.is_empty() {
                    out.push_str(&fmt!(",\"preferred_min_throughput\":{}",
                        crate::hostspeed::SLOW_TPS as u64));
                }
                out.push_str("},");
            }
        }
        // THE CHAT'S OWN REASONING LEVEL, drawn by the page from the model's catalogue entry
        // and set for this model alone (`ChosenEffort`).  Unset sends nothing, which is the
        // model's own default.
        if let Some(c) = self.reasoning.borrow().as_ref() {
            if c.model == self.model {
                out.push_str(&fmt!("\"reasoning\":{{\"effort\":\"{}\"}},", c.effort.wire()));
            }
        }
        if stream {
            out.push_str("\"stream\":true,");
            out.push_str("\"stream_options\":{\"include_usage\":true},");
        } else {
            out.push_str("\"stream\":false,");
        }
        out.push_str(&fmt!("\"max_tokens\":{}", self.max_tokens));
        out.push('}');
        out
    }

    /// Streaming body (no tools).  Kept for the pure-chat path's unit test,
    /// which is the only caller now that both paths share [`stream_turn`](Self::stream_turn).
    #[cfg(test)]
    pub(crate) fn build_request_body(&self, messages: &[ChatMessage]) -> String {
        self.build_body(messages, None, true)
    }

    /// The Anthropic Messages API request body.
    ///
    /// Four things differ from the OpenAI shape, and each one is why this
    /// could not be a couple of extra fields on the other builder:
    ///
    /// * the system prompt is a top-level `system`, not a message, so every
    ///   system message is hoisted out and joined;
    /// * content is an array of typed blocks, so a `cache_control` marker has
    ///   somewhere to live without changing the message's shape;
    /// * a tool call is a `tool_use` block on the assistant turn and its result
    ///   a `tool_result` block on the *user* turn, so a run of tool results
    ///   coalesces into one user message rather than becoming several;
    /// * thinking blocks precede the `tool_use` blocks they were generated
    ///   beside, and must be handed back unmodified -- see [`ThinkCarry`].
    ///
    /// Thinking is requested only for the models that take the adaptive form
    /// ([`model_takes_adaptive_thinking`]) and only while the client's own
    /// setting asks for it ([`LlmClient::set_thinking`]); `output_config.effort`
    /// rides the same gate.
    fn build_anthropic_body(&self, messages: &[ChatMessage], tools: Option<&str>, stream: bool)
        -> String
    {
        let marks = self.cache_breakpoints(messages, tools);
        let tune = self.thinking_tune();
        let adaptive = model_takes_adaptive_thinking(&self.model);
        // THREE STATES, not two.  `thinks` is whether this request ASKS for thinking;
        // `off_lands` is whether asking for it to stop is something this model will accept at
        // this effort.  Where it is not -- Fable and Mythos think whatever they are told, and
        // Opus 5 refuses to be switched off above effort `high` -- the field is left off and
        // the model reasons anyway, so the output cap must still make room for it.  A cap
        // chosen from the request instead of from what the model will do truncates the answer
        // mid-sentence and nothing reports it.
        let thinks = adaptive && matches!(tune.thinking, Thinking::Adaptive);
        let off_lands = matches!(tune.thinking, Thinking::Off)
            && thinking_off_accepted(&self.model, tune.effort);
        let reasons = adaptive && !off_lands;
        let mut out = String::with_capacity(1024);
        out.push('{');
        out.push_str(&fmt!("\"model\":\"{}\",", self.model));
        out.push_str(&fmt!("\"max_tokens\":{},", self.anthropic_max_tokens(reasons, stream)));

        // The system prompt, hoisted.  Several system messages become one
        // block: the API takes a single system field, and the model reads a
        // joined prompt exactly as it read separate messages.
        let sys: Vec<String> = messages.iter().filter_map(|m| match m {
            ChatMessage::System { content } => Some(content.as_text().into_owned()),
            _ => None,
        }).collect();
        if !sys.is_empty() {
            let mark = messages.iter().enumerate().any(|(i, m)|
                matches!(m, ChatMessage::System { .. }) && marks.contains(&i));
            out.push_str("\"system\":[{\"type\":\"text\",\"text\":\"");
            out.push_str(&json_escape(&sys.join("\n\n")));
            out.push('"');
            if mark { out.push_str(",\"cache_control\":{\"type\":\"ephemeral\"}"); }
            out.push_str("}],");
        }

        // The conversation.  `pending` holds the content blocks of the user
        // message being assembled, so consecutive tool results land in one
        // message rather than in several the API would reject.
        let mut msgs: Vec<String> = Vec::new();
        let mut pending: Vec<String> = Vec::new();
        for (i, msg) in messages.iter().enumerate() {
            match msg {
                ChatMessage::System { .. } => {}
                ChatMessage::User { content, .. } => {
                    // An empty text block is rejected outright, where the
                    // OpenAI side simply carries the empty string through.
                    pending.extend(anthropic_blocks(content, marks.contains(&i)));
                }
                ChatMessage::Tool { tool_call_id, content, .. } => {
                    // A `tool_result` takes either a string or an array of blocks, and this side
                    // -- unlike OpenAI's -- takes an image among them.  So a screenshot stays
                    // attached to the call that produced it rather than being re-homed.
                    //
                    // `cache_control` goes on the `tool_result` BLOCK ITSELF, marked here rather
                    // than pushed onto an inner part: `cache_breakpoints` marks at most one Tool
                    // message, and it is always the LAST one this loop reaches (the highest index
                    // it saw), so the block built here is necessarily the final entry `pending`
                    // holds when it flushes -- which is where the API requires the marker to sit.
                    let mark = if marks.contains(&i) {
                        ",\"cache_control\":{\"type\":\"ephemeral\"}"
                    } else {
                        ""
                    };
                    if content.has_image() {
                        let blocks = anthropic_blocks(content, false);
                        pending.push(fmt!(
                            "{{\"type\":\"tool_result\",\"tool_use_id\":\"{}\",\"content\":[{}]{}}}",
                            json_escape(tool_call_id), blocks.join(","), mark));
                    } else {
                        pending.push(fmt!(
                            "{{\"type\":\"tool_result\",\"tool_use_id\":\"{}\",\"content\":\"{}\"{}}}",
                            json_escape(tool_call_id), json_escape(&content.as_text()), mark));
                    }
                }
                ChatMessage::Assistant { content, tool_calls } => {
                    let mut blocks: Vec<String> = Vec::new();
                    // The reasoning that led to these tool calls, first and
                    // verbatim.  Absent for a turn that asked for nothing.
                    if let Some(tc) = tool_calls.first() {
                        blocks.extend(self.carry_get(&tc.id));
                    }
                    // Assistant turns are the model's own words; an image cannot appear in one.
                    let said = content.as_text();
                    // Whitespace alone is refused as a text block as surely as nothing is.
                    if !said.trim().is_empty() {
                        blocks.push(text_block(&said, false));
                    }
                    for tc in tool_calls {
                        let args = if tc.arguments.trim_start().starts_with('{') {
                            tc.arguments.as_str()
                        } else {
                            "{}"
                        };
                        blocks.push(fmt!(
                            "{{\"type\":\"tool_use\",\"id\":\"{}\",\"name\":\"{}\",\"input\":{}}}",
                            json_escape(&tc.id), json_escape(&tc.name), args));
                    }
                    // An assistant turn with no content at all is not a message
                    // the API will take, and it says nothing the model needs.  Nor does it
                    // end the user message being assembled: the words either side of it are
                    // one user turn, not two in a row.
                    if !blocks.is_empty() {
                        if !pending.is_empty() {
                            msgs.push(fmt!("{{\"role\":\"user\",\"content\":[{}]}}", pending.join(",")));
                            pending.clear();
                        }
                        msgs.push(fmt!("{{\"role\":\"assistant\",\"content\":[{}]}}", blocks.join(",")));
                    }
                }
            }
        }
        if !pending.is_empty() {
            msgs.push(fmt!("{{\"role\":\"user\",\"content\":[{}]}}", pending.join(",")));
        }
        out.push_str(&fmt!("\"messages\":[{}],", msgs.join(",")));

        if let Some(t) = tools {
            out.push_str(&fmt!("\"tools\":{},", openai_tools_to_anthropic(t)));
            out.push_str("\"tool_choice\":{\"type\":\"auto\"},");
        }
        if thinks {
            // `display` defaults to `omitted` on every current model, which
            // streams thinking blocks whose text is empty.  Summarised costs
            // the same -- the billed thinking is the full reasoning either way
            // -- and is the difference between a visible pause and a silent one.
            out.push_str("\"thinking\":{\"type\":\"adaptive\",\"display\":\"summarized\"},");
        } else if off_lands {
            // Asked for, and legal here.  Sent rather than the field being omitted: omitting
            // it on Opus 5 runs adaptive thinking, so "off" and "say nothing" are opposite
            // instructions on the very model the arm measures.
            out.push_str("\"thinking\":{\"type\":\"disabled\"},");
        }
        // HOW DEEPLY, which is a setting on the thinking models and a 400 on the rest.
        // Written even at `high`, the API's own default, so the wire says what the engine was
        // asked for rather than leaving a reader to infer it from an absence.
        if effort_accepted(&self.model, tune.effort) {
            out.push_str(&fmt!("\"output_config\":{{\"effort\":\"{}\"}},", tune.effort.wire()));
        }
        out.push_str(&fmt!("\"stream\":{}", if stream { "true" } else { "false" }));
        out.push('}');
        out
    }

    /// The output cap for a Messages API request.
    ///
    /// On the OpenAI side `max_tokens` bounds the answer.  On this side it
    /// bounds the reasoning *and* the answer together -- thinking is billed as
    /// output and counts against the same cap -- so a figure chosen for the
    /// first meaning truncates under the second, and the app's is 4096: enough
    /// for an answer, not enough for a hard problem thought through first.  A
    /// floor is applied rather than the configured value being used, because
    /// that value is an internal default and not something a user chose.
    ///
    /// It applies only where both halves of the reason hold: a model that
    /// actually thinks, and a streamed request.  The one-shot path keeps the
    /// configured cap, since a large one there risks an HTTP timeout on a
    /// connection with nothing arriving on it.
    ///
    /// # Arguments
    /// * `thinks` - Whether this request asks for thinking.
    /// * `stream` - Whether the response is streamed.
    fn anthropic_max_tokens(&self, thinks: bool, stream: bool) -> u32 {
        if thinks && stream {
            self.max_tokens.max(THINKING_MIN_MAX_TOKENS)
        } else {
            self.max_tokens
        }
    }

    /// The headers this request needs beyond `Host` and `Content-Length`.
    ///
    /// The two dialects do not merely differ in the name of the auth header:
    /// Anthropic wants `x-api-key` plus a pinned API version, and refuses a
    /// bearer token.  `browser` adds the header that makes Anthropic's edge
    /// answer a cross-origin `fetch` at all -- the same one the official
    /// TypeScript SDK sends for `dangerouslyAllowBrowser`.  It is sent only
    /// from the browser transport, where it is the difference between the app
    /// working and CORS refusing it.
    ///
    /// # Arguments
    /// * `browser` - Whether the request is being made from a browser.
    pub(crate) fn auth_headers(&self, browser: bool) -> Vec<(&'static str, String)> {
        let mut out = vec![("Content-Type", "application/json".to_string())];
        match self.dialect {
            Dialect::OpenAi => {
                out.push(("Authorization", fmt!("Bearer {}", self.api_key.as_str())));
            }
            Dialect::Anthropic => {
                out.push(("x-api-key", self.api_key.to_string()));
                out.push(("anthropic-version", ANTHROPIC_VERSION.to_string()));
                if browser {
                    out.push(("anthropic-dangerous-direct-browser-access", "true".to_string()));
                }
            }
        }
        out
    }

    /// Hold this turn's thinking blocks against the tool call they accompany.
    ///
    /// A poisoned lock loses the carry rather than the turn: the next request
    /// then goes without thinking blocks, which the API answers by quietly
    /// disabling thinking for it.  That is a worse answer, not a broken one,
    /// and it is the right trade against failing a turn the user is watching.
    ///
    /// # Arguments
    /// * `id` - The first tool-call id of the turn the blocks came from.
    /// * `blocks` - The serialised blocks, in the order the model produced them.
    fn carry_put(&self, id: &str, blocks: Vec<String>) {
        if id.is_empty() || blocks.is_empty() {
            return;
        }
        let go = |c: &mut ThinkCarry| {
            // A retried round re-reports the same id; the newer blocks replace
            // the older rather than sitting beside them.
            c.turns.retain(|(k, _)| k != id);
            c.turns.push((id.to_string(), blocks.clone()));
            if c.turns.len() > CARRY_MAX_TURNS {
                let drop = c.turns.len() - CARRY_MAX_TURNS;
                c.turns.drain(..drop);
            }
        };
        #[cfg(not(target_arch = "wasm32"))]
        { if let Ok(mut g) = self.think.lock() { go(&mut g); } }
        #[cfg(target_arch = "wasm32")]
        { go(&mut self.think.borrow_mut()); }
    }

    /// Every thinking block this client holds, by tool-call id, for a worker's copy (r578c).
    pub fn carry_export(&self) -> Vec<(String, Vec<String>)> {
        #[cfg(not(target_arch = "wasm32"))]
        { match self.think.lock() { Ok(g) => g.turns.clone(), Err(_) => Vec::new() } }
        #[cfg(target_arch = "wasm32")]
        { self.think.borrow().turns.clone() }
    }

    /// Take a parent's thinking blocks, so the copied assistant turns serialise byte for byte.
    pub fn carry_import(&self, turns: &[(String, Vec<String>)]) {
        for (id, blocks) in turns {
            self.carry_put(id, blocks.clone());
        }
    }

    /// What this client is currently asking of a thinking model.
    pub fn thinking_tune(&self) -> ThinkTune {
        self.tune.get()
    }

    /// Ask for a different depth of thinking, from `Agent::set_tune`.
    ///
    /// **Only the Anthropic dialect can carry either half.**  Adaptive thinking is requested
    /// there and its signed blocks are handed back by [`ThinkCarry`]; the OpenAI-shaped body
    /// has nowhere to put a thinking block and no field this app has ever sent, so a setting
    /// that reached it would be a request whose answer could not be replayed on the next
    /// round.  So the OpenAI builder ignores this, and `turn_limits` reports the figure the
    /// engine holds rather than one a caller could take for something that went out.
    ///
    /// # Arguments
    /// * `thinking` - Adaptive, or off where the model and the effort allow it.
    /// * `effort` - `output_config.effort`; `High` is the API's own default.
    pub fn set_thinking(&self, thinking: Thinking, effort: Effort) {
        self.tune.set(ThinkTune { thinking, effort });
    }

    /// How long a stream may currently go without a byte before it is read as stalled.
    pub fn stream_idle_ms(&self) -> u64 {
        self.stream_idle_ms.get()
    }

    /// Move the idle-stream ceiling, from `Agent::set_stream_idle_ms`.  Floored at one
    /// second: zero would fire the watchdog on the gap between two SSE chunks of an
    /// ordinary round.
    pub fn set_stream_idle_ms(&self, ms: u64) {
        self.stream_idle_ms.set(ms.max(1_000));
    }

    /// Set which upstream providers OpenRouter should try for this model, from the setting
    /// on its own row; see [`ProviderRouting`].  Only ever reaches the wire when the
    /// endpoint's host names OpenRouter -- see [`build_openai_body`](Self::build_openai_body)
    /// -- so setting this against a direct provider is inert rather than a 400.
    ///
    /// `order`/`ignore` take a blank string as empty and trim every entry; an entry that
    /// trims to nothing is dropped rather than sent as `""`.
    ///
    /// # Arguments
    /// * `order` - Comma-separated provider names to try first, in that order.
    /// * `ignore` - Comma-separated provider names never to route to.
    /// * `only` - Refuse every provider but `order` rather than falling back past it.
    pub fn set_provider_routing(&self, order: &str, ignore: &str, only: bool) {
        let split = |s: &str| -> Vec<String> {
            s.split(',').map(|p| p.trim().to_string()).filter(|p| !p.is_empty()).collect()
        };
        *self.provider_routing.borrow_mut() = ProviderRouting {
            order:  split(order),
            ignore: split(ignore),
            only,
        };
    }

    /// Ask this client's model for a reasoning level, or `None` for the model's own default.
    ///
    /// Sent as `reasoning.effort` on the OpenAI dialect only, and only while the client's
    /// model is the one the level was set for (see [`ChosenEffort`]).  The Anthropic dialect
    /// has its own ladder, `output_config.effort`, set through
    /// [`set_thinking`](Self::set_thinking).
    pub fn set_reasoning_effort(&self, effort: Option<ReasoningEffort>) {
        *self.reasoning.borrow_mut() = effort.map(|e| ChosenEffort {
            model:  self.model.clone(),
            effort: e,
        });
    }

    /// The thinking blocks held for `id`, or none when no held turn produced
    /// that call (or a lock could not be taken; see
    /// [`carry_put`](Self::carry_put)).
    ///
    /// # Arguments
    /// * `id` - The first tool-call id of the assistant turn being serialised.
    fn carry_get(&self, id: &str) -> Vec<String> {
        if id.is_empty() {
            return Vec::new();
        }
        let find = |c: &ThinkCarry| c.turns.iter()
            .find(|(k, _)| k == id)
            .map(|(_, b)| b.clone())
            .unwrap_or_default();
        #[cfg(not(target_arch = "wasm32"))]
        {
            match self.think.lock() {
                Ok(g) => find(&g),
                Err(_) => Vec::new(),
            }
        }
        #[cfg(target_arch = "wasm32")]
        { find(&self.think.borrow()) }
    }

    /// Which message indices get an Anthropic prompt-cache breakpoint.
    ///
    /// Two at most, both placed at a boundary between what stays the same and
    /// what changes:
    ///
    /// * the last system message, which with the tool definitions rendered ahead
    ///   of it is the largest block that never varies within a session;
    /// * the tip of the settled conversation -- the last USER OR TOOL message,
    ///   whichever comes later -- so the next request reads everything before it
    ///   back out of the cache.
    ///
    /// **The tip used to mean only the last user message.** A tool round never
    /// appends one: `run_tool_loop` sends the assistant's calls and their results
    /// straight back, so the conversation this method actually sees tails off in
    /// `Tool` messages, several rounds past the user message it was marking. Every
    /// round after the first then re-paid the whole tool-result history at the
    /// full input rate, because the one breakpoint that could have covered it sat
    /// further back than anything the marker was moving forward to cache.
    ///
    /// Nothing is marked for a model that does not honour the marker, and
    /// nothing is marked when the prefix is too short to be cacheable at all.
    /// Assistant messages are deliberately left unmarked: the array content form
    /// they would need is the one an OpenAI-compatible router is least certain to
    /// carry through, and a rejected body loses the whole turn.
    fn cache_breakpoints(&self, messages: &[ChatMessage], tools: Option<&str>) -> Vec<usize> {
        let mut marks = Vec::new();
        if !model_caches_on_request(&self.model) {
            return marks;
        }
        // The prefix at each message, in characters, standing in for tokens.
        let mut prefix = tools.map(|t| t.len()).unwrap_or(0);
        let mut sys = None;
        let mut tip = None;
        for (i, msg) in messages.iter().enumerate() {
            prefix += message_len(msg);
            if prefix < CACHE_MIN_PREFIX_CHARS {
                continue;
            }
            match msg {
                ChatMessage::System { .. } => sys = Some(i),
                ChatMessage::User { .. } | ChatMessage::Tool { .. } => tip = Some(i),
                _ => {}
            }
        }
        if let Some(i) = sys { marks.push(i); }
        if let Some(i) = tip {
            if Some(i) != sys { marks.push(i); }
        }
        marks
    }

    /// Connect, TLS-handshake, send the request, and consume the
    /// response headers.  Returns the stream positioned at the body
    /// start plus whether the body uses chunked transfer encoding.
    /// Errors on a non-200 status (with body detail).
    ///
    /// Every failure here is classified but none is retried: retrying belongs to
    /// the public call, which is the only layer that knows whether anything has
    /// already reached the caller and is the only one that can say so.
    #[cfg(not(target_arch = "wasm32"))]
    async fn open(
        &self,
        body:    &str,
        wait_ms: u64,
    )
        -> Result<(Conn, bool, Option<String>), TransportErr>
    {
        self.open_with(Some(body), wait_ms).await
    }

    /// [`open`](Self::open) for a POST of `Some(body)` with this client's key, or for a bare GET
    /// of the path when `None`: no key, no auth headers and no body, as a picture a provider
    /// links to is fetched.
    #[cfg(not(target_arch = "wasm32"))]
    async fn open_with(
        &self,
        body:    Option<&str>,
        wait_ms: u64,
    )
        -> Result<(Conn, bool, Option<String>), TransportErr>
    {
        use tokio_rustls::TlsConnector;
        use tokio::net::TcpStream;

        let body_bytes = match body {
            Some(b) => b.as_bytes(),
            None    => &[][..],
        };

        let mut request = String::with_capacity(512 + body_bytes.len());
        match body {
            Some(_) => {
                request.push_str(&fmt!("POST {} HTTP/1.1\r\n", self.path));
                request.push_str(&fmt!("Host: {}\r\n", self.host_header()));
                for (name, value) in self.auth_headers(false) {
                    request.push_str(&fmt!("{}: {}\r\n", name, value));
                }
                request.push_str(&fmt!("Content-Length: {}\r\n", body_bytes.len()));
            },
            None    => {
                request.push_str(&fmt!("GET {} HTTP/1.1\r\n", self.path));
                request.push_str(&fmt!("Host: {}\r\n", self.host_header()));
                request.push_str("Accept: */*\r\n");
            },
        }
        request.push_str("Connection: close\r\n");
        request.push_str("\r\n");

        // A connection that never came up carries no partial answer, so every
        // failure from here to the status line is worth another attempt.
        // EVERY WAIT BEFORE THE STREAM IS BOUNDED BY THE IDLE FIGURE (GW-RESTART, 26 Oct).  The
        // header read always was; the dial, the TLS handshake, the request's write and an error
        // status's body were not, and a gateway restarting under a live run held one of them for
        // 13 minutes, ended only by the page's Stop.  A timeout is a stall, so it ends the round
        // with its sentence ([`TransportErr::classify`]), as the header wait's does, rather than
        // being sent again: the exception to the line above.
        let idle = std::time::Duration::from_millis(wait_ms);
        let dial = async {
            match self.dial_at {
                Some(at)    => TcpStream::connect(at).await,
                None        => TcpStream::connect((self.host.as_str(), self.port)).await,
            }
        };
        let tcp = match tokio::time::timeout(idle, dial).await {
            Ok(Ok(s)) => s,
            Ok(Err(e)) => return Err(TransportErr::transient(fmt!("could not reach {}", self.host), err!(e,
                "LLM: TCP connect to {}:{} failed.", self.host, self.port;
                IO, Network, Init))),
            Err(_elapsed) => return Err(TransportErr::classify(
                fmt!("could not reach {} in {} s", self.host, wait_ms / 1000), err!(
                "LLM: TCP connect to {}:{} took over {} ms.", self.host, self.port, wait_ms;
                IO, Network, Init, Timeout))),
        };
        let mut stream = if self.plain {
            // Checked again here, so plain http can reach nothing but this machine's loopback
            // whatever made the client.
            if self.host != "127.0.0.1" {
                return Err(TransportErr::fatal(fmt!("plain http to {} refused", self.host), err!(
                    "LLM: plain http is for 127.0.0.1 only, not {}.", self.host;
                    IO, Network, Security, Invalid)));
            }
            Conn::Plain(tcp)
        } else {
            let server_name = match tokio_rustls::rustls::pki_types::ServerName::try_from(self.host.clone()) {
                Ok(n) => n,
                // A name that will not parse will not parse next time either.
                Err(e) => return Err(TransportErr::fatal(fmt!("invalid server name '{}'", self.host), err!(e,
                    "LLM: invalid server name '{}'.", self.host;
                    IO, Network, Invalid, Input))),
            };
            let connector = TlsConnector::from(self.tls_config.clone());
            match tokio::time::timeout(idle, connector.connect(server_name, tcp)).await {
                Ok(Ok(s)) => Conn::Tls(Box::new(s)),
                Ok(Err(e)) => return Err(TransportErr::transient(fmt!("TLS handshake with {} failed", self.host), err!(e,
                    "LLM: TLS handshake to {} failed.", self.host;
                    IO, Network, Init))),
                Err(_elapsed) => return Err(TransportErr::classify(
                    fmt!("the TLS handshake with {} did not finish in {} s", self.host, wait_ms / 1000), err!(
                    "LLM: TLS handshake to {} took over {} ms.", self.host, wait_ms;
                    IO, Network, Init, Timeout))),
            }
        };

        let mut req = Vec::with_capacity(request.as_bytes().len() + body_bytes.len());
        req.extend_from_slice(request.as_bytes());
        req.extend_from_slice(body_bytes);
        let sent = tokio::time::timeout(idle, async {
            match stream.write_all(&req).await {
                Ok(()) => stream.flush().await,
                Err(e) => Err(e),
            }
        }).await;
        match sent {
            Ok(Ok(())) => {},
            Ok(Err(e)) => return Err(TransportErr::transient("could not send the request".to_string(), err!(e,
                "LLM: write request failed."; IO, Network, Wire, Write))),
            Err(_elapsed) => return Err(TransportErr::classify(
                fmt!("{} did not take the request in {} s", self.host, wait_ms / 1000), err!(
                "LLM: writing the request to {} took over {} ms.", self.host, wait_ms;
                IO, Network, Wire, Write, Timeout))),
        }

        // Read headers byte-by-byte until \r\n\r\n.  Each read is bounded by the first-byte
        // watchdog: a provider that accepts the connection and then never sends a status line
        // is the same hang the stream watchdog catches mid-body, so it ends the attempt as a
        // transient timeout rather than blocking the round.  Per-read, so a header block that
        // dribbles in is never cut -- each byte that arrives re-arms the window.
        let mut hdr_buf = Vec::with_capacity(2048);
        let mut byte = [0u8; 1];
        loop {
            match tokio::time::timeout(idle, stream.read(&mut byte)).await {
                Ok(Ok(0)) => break,
                Ok(Ok(_)) => {
                    hdr_buf.push(byte[0]);
                    if hdr_buf.ends_with(b"\r\n\r\n") { break; }
                }
                Ok(Err(e)) if e.kind() == tokio::io::ErrorKind::UnexpectedEof => break,
                Ok(Err(e)) => return Err(TransportErr::transient("the provider closed before replying".to_string(), err!(e,
                    "LLM: read headers failed."; IO, Network, Wire, Read))),
                Err(_elapsed) => return Err(TransportErr::classify("no response from the provider".to_string(), err!(
                    "LLM: no response headers within {} ms.", wait_ms; IO, Network, Timeout))),
            }
        }

        let headers_str = String::from_utf8_lossy(&hdr_buf);
        let is_chunked = headers_str
            .to_ascii_lowercase()
            .contains("transfer-encoding: chunked");

        let status_line = headers_str.lines().next().unwrap_or("");
        let status = status_code(status_line).unwrap_or(0);
        if status != 200 {
            // The status decides the round; the body only explains it.  So it is read for the idle
            // figure at most and to ERR_BODY_READ_MAX bytes at most, and a body a restarting
            // gateway never finishes on a socket it never closes is cut there, not waited on.
            let mut err_body = Vec::new();
            let mut chunk = [0u8; 4096];
            let _ = tokio::time::timeout(idle, async {
                while err_body.len() < ERR_BODY_READ_MAX {
                    match stream.read(&mut chunk).await {
                        Ok(0) => break,
                        Ok(n) => err_body.extend_from_slice(&chunk[..n]),
                        Err(_) => break,
                    }
                }
            }).await;
            // A REFUSED KEY'S BODY NEVER TRAVELS (KEY-BODY, QA R7 check 1): OpenAI's 401 echoes the
            // key's last characters, and whatever this error carries reaches fold notes, rows and
            // frames.  The status says all that is needed.
            let (reason, err) = if refuses_key(status) {
                drop(err_body);
                (key_refused_words(&self.host, status), err!(
                    "LLM: HTTP error: {} | {}", status_line, KEY_BODY_WITHHELD;
                    IO, Network, Wire, Read))
            } else {
                let err_msg = String::from_utf8_lossy(&err_body);
                (fmt!("the provider returned HTTP {}", status), err!(
                    "LLM: HTTP error: {} | {}", status_line, self.quoted_body(&err_msg);
                    IO, Network, Wire, Read))
            };
            // A 429 or a 5xx is the provider saying "not now"; a 400 is this
            // request being wrong, and sending it again only costs money.
            return Err(if status_retryable(status) {
                let after = header_value(&headers_str, "retry-after")
                    .and_then(|v| parse_retry_after(&v));
                TransportErr::transient(reason, err).after(after)
            } else {
                TransportErr::fatal(reason, err)
            }.at(status));
        }

        // The `Content-Type`, which says whether a reply to a streaming request is a stream.
        let ctype = header_value(&headers_str, "content-type");
        Ok((stream, is_chunked, ctype))
    }

    /// Perform a non-streaming request and return the full response
    /// body as one string.  Lines are concatenated (JSON does not need
    /// the newlines), dechunking transparently.
    #[cfg(not(target_arch = "wasm32"))]
    async fn do_request_full(
        &self,
        body: &str,
    ) -> Result<String, TransportErr> {
        // A non-streaming provider generates the whole answer before it sends a byte, so both
        // the header wait (in `open`) and the body wait below get the wider ceiling; see
        // `REPLY_WAIT_FACTOR`.
        let wait_ms = self.stream_idle_ms.get().saturating_mul(REPLY_WAIT_FACTOR);
        let (stream, is_chunked, _) = match self.open(body, wait_ms).await {
            Ok(v)  => v,
            Err(e) => return Err(e),
        };
        let mut reader = LineReader::new(stream, is_chunked);
        let idle = std::time::Duration::from_millis(wait_ms);
        let mut full = String::new();
        loop {
            // Bounded per line, like the streaming path: a body that stops arriving ends the
            // attempt as a transient timeout rather than hanging on a dead connection.
            match tokio::time::timeout(idle, reader.read_line()).await {
                // The line's end goes back in: an event stream sent anyway is one event to a
                // line, and lines run together are one line no reader can split.
                Ok(Ok(Some(l))) => { full.push_str(&l); full.push('\n'); }
                Ok(Ok(None)) => break,
                Ok(Err(e)) if e.kind() == tokio::io::ErrorKind::UnexpectedEof => break,
                Ok(Err(e)) => return Err(TransportErr::transient("the reply was cut short".to_string(), err!(e,
                    "LLM: read response body failed."; IO, Network, Wire, Read))),
                Err(_elapsed) => return Err(TransportErr::classify("the reply was cut short".to_string(), err!(
                    "LLM: no response body within {} ms.", wait_ms; IO, Network, Timeout))),
            }
        }
        Ok(full)
    }

    /// GETs the picture a remote party linked at `url`, without a key, through `guard` (R3 F1):
    /// https only, the name resolved once and every address it resolves to judged, the connection
    /// made to a judged address with the TLS name still `url`'s host, no redirect followed, and a
    /// body past `max` refused.  The bytes and their declared `Content-Type`.
    #[cfg(not(target_arch = "wasm32"))]
    pub async fn fetch_linked(
        url:    &str,
        guard:  &crate::net_guard::Guard,
        tls:    Arc<ClientConfig>,
        max:    usize,
    )
        -> Outcome<(Vec<u8>, Option<String>)>
    {
        if !url.starts_with("https://") {
            return Err(err!("The picture's link is not https, so it was not fetched."; Network, Security));
        }
        let (_, host, port, path) = res!(Self::url_parts(url));
        let addrs = res!(guard.judge(&host, port).await);
        let mut last = None;
        for at in addrs {
            let mut c = Self::new(&host, port, &path, "", "", 0, tls.clone());
            c.dial_at = Some(at);
            match c.get_bytes(max).await {
                Ok(got) => return Ok(got),
                Err(e)  => last = Some(e),
            }
        }
        Err(last.unwrap_or_else(|| err!("{} had no address to fetch from.", host; Network, Missing)))
    }

    /// GET this client's URL without its key: the body's bytes, at most `max` of them, and its
    /// declared `Content-Type`.  Bounded per read as [`post_whole`](Self::post_whole) is; a body
    /// past `max` is refused, not cut.  Private: a link a remote party names is fetched only
    /// through [`fetch_linked`](Self::fetch_linked).
    #[cfg(not(target_arch = "wasm32"))]
    async fn get_bytes(&self, max: usize) -> Outcome<(Vec<u8>, Option<String>)> {
        let wait_ms = self.stream_idle_ms.get().saturating_mul(REPLY_WAIT_FACTOR);
        let (stream, is_chunked, ctype) = match self.open_with(None, wait_ms).await {
            Ok(v)  => v,
            Err(e) => return Err(e.crossed()),
        };
        let mut reader = LineReader::new(stream, is_chunked);
        let idle = std::time::Duration::from_millis(wait_ms);
        let mut out = Vec::new();
        loop {
            match tokio::time::timeout(idle, reader.read_chunk()).await {
                Ok(Ok(Some(b))) => {
                    if out.len() + b.len() > max {
                        return Err(err!("The download from {} passed {} bytes, so it was \
                            refused.", self.host, max; IO, Network, TooBig, Size));
                    }
                    out.extend_from_slice(&b);
                },
                Ok(Ok(None)) => break,
                Ok(Err(e)) if e.kind() == tokio::io::ErrorKind::UnexpectedEof => break,
                Ok(Err(e)) => return Err(err!(e, "The download from {} was cut short.", self.host;
                    IO, Network, Wire, Read)),
                Err(_elapsed) => return Err(err!("The download from {} stopped for {} ms.",
                    self.host, wait_ms; IO, Network, Timeout)),
            }
        }
        Ok((out, ctype))
    }

    /// Send the HTTP request and stream the SSE response line-by-line,
    /// handing `on_data` each `data:` payload (the JSON after the `data: ` prefix) as it
    /// arrives, stopping at `[DONE]`.  Handles both chunked and identity transfer encoding
    /// via [`LineReader`].
    ///
    /// `on_data` answers with a [`Pulse`]: whether the payload was real data (the accumulator
    /// grew), which alone re-arms the watchdog, and whether the model is still reasoning;
    /// see [`StreamWatch`].  It is also told, as
    /// [`Wire::Silence`], whenever half the idle ceiling has gone by without any.
    /// `first_ms` is how long the first real data may take.
    ///
    /// Returns whether the stream was aborted.  The native transport has
    /// no cancellation path, so it always returns `false`; the wasm
    /// transport returns `true` when the browser fired the abort signal.
    #[cfg(not(target_arch = "wasm32"))]
    async fn stream_sse(
        &self,
        body:       &str,
        first_ms:   u64,
        quiet_cap:  u64,
        on_data:    &mut impl FnMut(Wire<'_>) -> Pulse,
    ) -> Result<StreamOutcome, TransportErr>
    {
        // Headers arrive before the first token on a streaming request, so the header wait in
        // `open` is the plain idle ceiling; the watch below covers the body.
        let idle_ms = self.stream_idle_ms.get();
        let asked   = now_ms();
        // The wait for the reply is held outside the liveness race (U3a LV2); see `ReplyHold`.
        let mut held = crate::engine::worker::liveness::ReplyHold::new(self.liveness.clone(),
            asked.saturating_add(idle_ms.saturating_mul(REPLY_WAIT_FACTOR)));
        // A Stop while the provider has yet to answer ends the round there, with nothing in it.
        let opened = match racing::race(self.open(body, idle_ms), self.halt.fired()).await {
            Won::First(opened)  => opened,
            Won::Second(())     => return Ok(StreamOutcome::ABORTED),
        };
        let (stream, is_chunked, ctype) = match opened {
            Ok(v)  => v,
            Err(e) => return Err(e),
        };
        let mut reader = LineReader::new(stream, is_chunked);
        let mut watch  = StreamWatch::new(now_ms(), idle_ms, first_ms).capped(quiet_cap).asked(asked)
            .beating(self.liveness.clone());
        let mut lines  = SseLines::new(ctype.as_deref());
        // A stream has answered with its headers; a whole body has not until it is all here.
        if lines.is_stream() { held.release(now_ms()); }
        let mut counted: u64 = 0;   // the reader's byte count already given to the watch
        loop {
            // THE IDLE WATCHDOG. Proposal 15, 2026-09-15: OpenRouter's own export showed a
            // round with `generation_time` 83.7 s that this app sat on for 318 s -- about
            // four minutes reading a connection the provider had already stopped writing
            // to.  r540: and a provider that never answers at all, behind OpenRouter's
            // keep-alive comments, held a round open to the 30-minute cap, because each
            // comment re-armed a per-line timeout.  So the clock is the watch's, restarted
            // only by real data, and the read is polled across its ticks rather than
            // dropped: `read_line` holds the half-read line in its own state, and a future
            // dropped mid-line would lose it.
            let mut next = Box::pin(reader.read_line());
            let line = loop {
                let now = now_ms();
                // Whatever `on_data` already delivered this round is kept -- the round
                // ends `stalled` rather than erroring, so a reply that reasoned and got
                // this far still reaches the nudge path instead of being thrown away and
                // the whole request sent again.
                if watch.expired(now) {
                    return Ok(watch.ended(now, StreamOutcome::STALLED));
                }
                if let Some(secs) = watch.tick(now) {
                    on_data(Wire::Silence(secs));
                }
                let nap = std::time::Duration::from_millis(watch.next_in(now_ms()));
                // A STOP LANDS IN THE SILENCE, not after it: the read is raced against the
                // turn's halt, so a provider that has gone quiet cannot hold a Stop to the
                // watchdog's ceiling.  What `on_data` already delivered is the round's partial,
                // kept as a Stop mid-stream keeps it.
                match racing::race(tokio::time::timeout(nap, &mut next), self.halt.fired()).await {
                    Won::First(Ok(read))    => break read,
                    Won::First(Err(_))      => {},
                    Won::Second(())         =>
                        return Ok(watch.ended(now_ms(), StreamOutcome::ABORTED)),
                }
            };
            // The read is done with the reader, so its count can be read: the line just read.
            drop(next);
            watch.took(reader.read.saturating_sub(counted));
            counted = reader.read;
            let line = match line {
                Ok(Some(l)) => l,
                Ok(None) => break,
                Err(e) if e.kind() == tokio::io::ErrorKind::UnexpectedEof => break,
                Err(e) => return Err(TransportErr::transient("the stream broke".to_string(), err!(e,
                    "LLM: read SSE line failed."; IO, Network, Wire, Read))),
            };
            watch.heard(now_ms());
            match lines.sort(&line) {
                SseLine::Skip       => continue,
                SseLine::Done       => break,
                SseLine::Data(data) => {
                    let pulse = on_data(Wire::Data(data));
                    watch.data(now_ms(), pulse);
                }
            }
        }
        let end = now_ms();
        held.release(end);
        match lines.body() {
            // The headers said 200, or `open` would have refused the reply.
            Some(b) => self.deliver_body(200, b, on_data).map(|o| watch.ended(end, o)),
            None    => Ok(watch.ended(end, StreamOutcome::default())),
        }
    }
}


// ┌───────────────────────────────────────────────────────────────┐
// │ Stopping a turn                                                │
// └───────────────────────────────────────────────────────────────┘

impl LlmClient {

    /// Hand a reply that came back as one body, where a stream was asked for, to `on_data` as
    /// the one payload of a stream, so it reaches the screen, the store, the ledger and the
    /// usage exactly as a streamed reply does; see [`SseLines`].
    ///
    /// The first [`ERR_BODY_BYTES`] of a provider's `body` as it may be quoted: this client's own
    /// key and its fragments blanked out first ([`redact_own_key`]).  Both transports quote a
    /// body only through here.  The cut is taken a key's length wide before the blanking, so a
    /// fragment straddling the final cut is still blanked whole.
    ///
    /// # Arguments
    /// * `body` - The provider's words.
    pub(crate) fn quoted_body(&self, body: &str) -> String {
        let key = self.api_key.as_str();
        let wide = clip_bytes(body, ERR_BODY_BYTES + key.len());
        clip_bytes(&redact_own_key(wide, key), ERR_BODY_BYTES).to_string()
    }

    /// A whole completion is a delta that says everything at once: the accumulator reads it as
    /// it reads a stream's chunks.  A body that is not one -- an HTML error page, a truncated
    /// body, an Anthropic dialect that never answers this way -- is a provider error naming the
    /// provider, the status and what came, never an empty turn.  Not retried: the same request
    /// gets the same answer.
    pub(crate) fn deliver_body(
        &self,
        status:  u16,
        body:    &str,
        on_data: &mut impl FnMut(Wire<'_>) -> Pulse,
    )
        -> Result<StreamOutcome, TransportErr>
    {
        if matches!(self.dialect, Dialect::OpenAi) && openai_completion(body) {
            on_data(Wire::Data(body));
            return Ok(StreamOutcome::default());
        }
        let head = self.quoted_body(body);
        Err(TransportErr::fatal(
            fmt!("{} answered HTTP {} with no reply it could read: {}", self.host, status, head),
            err!("LLM: '{}' ({}) answered a streaming request with HTTP {} and a body that is \
                neither an event stream nor a chat completion ({} bytes).",
                self.host, self.model, status, body.len(); IO, Network, Wire, Read)))
    }

    /// Stop the turn this client is running: every later request of it is refused before it
    /// goes out, and the one in flight is cancelled.  Safe to call when idle.  See [`Halt`].
    pub fn abort(&self) {
        self.halt.fire();
    }

    /// Has the turn this client is running been stopped?  Also what tells a fetch or a stream a
    /// Stop cancelled apart from one that failed: a stall's tear-down fires the controller too,
    /// and is not a Stop.
    pub fn halted(&self) -> bool {
        self.halt.is_set()
    }

    /// This client's stop, for whoever has to fire it from outside the turn.
    pub fn halt(&self) -> Halt {
        self.halt.clone()
    }

    /// A clone of this client that stops only with `halt`: what a turn of its own runs on,
    /// when the client it came from is shared by several turns at once.
    pub fn with_halt(&self, halt: Halt) -> Self {
        let mut llm = self.clone();
        llm.halt = halt;
        llm
    }
}



// ┌───────────────────────────────────────────────────────────────┐
// │ LineReader — incremental line reader for TLS streams           │
// └───────────────────────────────────────────────────────────────┘

/// Reads lines from a TLS stream, handling HTTP chunked transfer
/// encoding transparently.
///
/// For identity (Content-Length) encoding, lines are read directly
/// from the stream.  For chunked encoding, chunk headers are parsed
/// and chunk data is dechunked on the fly, so the caller sees a
/// continuous stream of lines.
///
/// A line is terminated by `\n` (with or without a preceding `\r`).
#[cfg(not(target_arch = "wasm32"))]
/// The native transport's connection: TLS, or plain TCP to a loopback mock (see
/// [`LlmClient::from_url`]).  Both halves are `Unpin`, so each poll is a plain delegation.
#[cfg(not(target_arch = "wasm32"))]
pub(crate) enum Conn {
    Tls(Box<tokio_rustls::client::TlsStream<tokio::net::TcpStream>>),
    Plain(tokio::net::TcpStream),
}

#[cfg(not(target_arch = "wasm32"))]
impl tokio::io::AsyncRead for Conn {
    fn poll_read(self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>) -> std::task::Poll<std::io::Result<()>>
    {
        match self.get_mut() {
            Self::Tls(s)    => std::pin::Pin::new(s.as_mut()).poll_read(cx, buf),
            Self::Plain(s)  => std::pin::Pin::new(s).poll_read(cx, buf),
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl tokio::io::AsyncWrite for Conn {
    fn poll_write(self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>, buf: &[u8])
        -> std::task::Poll<std::io::Result<usize>>
    {
        match self.get_mut() {
            Self::Tls(s)    => std::pin::Pin::new(s.as_mut()).poll_write(cx, buf),
            Self::Plain(s)  => std::pin::Pin::new(s).poll_write(cx, buf),
        }
    }

    fn poll_flush(self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>)
        -> std::task::Poll<std::io::Result<()>>
    {
        match self.get_mut() {
            Self::Tls(s)    => std::pin::Pin::new(s.as_mut()).poll_flush(cx),
            Self::Plain(s)  => std::pin::Pin::new(s).poll_flush(cx),
        }
    }

    fn poll_shutdown(self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>)
        -> std::task::Poll<std::io::Result<()>>
    {
        match self.get_mut() {
            Self::Tls(s)    => std::pin::Pin::new(s.as_mut()).poll_shutdown(cx),
            Self::Plain(s)  => std::pin::Pin::new(s).poll_shutdown(cx),
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
struct LineReader<S: tokio::io::AsyncRead + Unpin> {
    stream:     S,
    buf:        Vec<u8>,
    buf_pos:    usize,
    is_chunked: bool,
    // For chunked encoding: remaining bytes in the current chunk.
    // None means we need to read the next chunk header.
    chunk_remaining: Option<usize>,
    eof:        bool,
    // Body bytes handed out as lines so far, line endings included.
    read:       u64,
}

#[cfg(not(target_arch = "wasm32"))]
impl<S: tokio::io::AsyncRead + Unpin> LineReader<S> {

    fn new(stream: S, is_chunked: bool) -> Self {
        Self {
            stream,
            buf: Vec::with_capacity(8192),
            buf_pos: 0,
            is_chunked,
            chunk_remaining: None,
            eof: false,
            read: 0,
        }
    }

    /// Read the next line (without the trailing newline).
    ///
    /// Returns `Ok(None)` at end of stream.
    async fn read_line(&mut self) -> std::io::Result<Option<String>> {
        loop {
            // Try to find a complete line in the buffer.
            if let Some(line) = self.try_extract_line() {
                return Ok(Some(line));
            }
            if self.eof {
                // If there's remaining data without a newline,
                // return it as the last line.
                if self.buf_pos < self.buf.len() {
                    let rest = String::from_utf8_lossy(
                        &self.buf[self.buf_pos..]
                    ).to_string();
                    self.read = self.read.saturating_add((self.buf.len() - self.buf_pos) as u64);
                    self.buf_pos = self.buf.len();
                    return Ok(Some(rest));
                }
                return Ok(None);
            }
            // Need more data.
            match self.fill_buf().await {
                Ok(())  => {},
                Err(e)  => return Err(e),
            }
        }
    }

    /// The next run of body bytes as they stand, dechunked, or `None` at the end: a binary body
    /// read whole, where lines mean nothing.
    async fn read_chunk(&mut self) -> std::io::Result<Option<Vec<u8>>> {
        loop {
            if self.buf_pos < self.buf.len() {
                let out = self.buf.split_off(self.buf_pos);
                self.read = self.read.saturating_add(out.len() as u64);
                self.buf.clear();
                self.buf_pos = 0;
                return Ok(Some(out));
            }
            if self.eof {
                return Ok(None);
            }
            match self.fill_buf().await {
                Ok(())  => {},
                Err(e)  => return Err(e),
            }
        }
    }

    /// Try to extract a complete line from the buffer.
    fn try_extract_line(&mut self) -> Option<String> {
        let search_start = self.buf_pos;
        let rest = &self.buf[search_start..];
        if let Some(pos) = rest.iter().position(|&b| b == b'\n') {
            let end = search_start + pos;
            let line = &self.buf[self.buf_pos..end];
            // Strip trailing \r if present.
            let line = if line.ends_with(b"\r") { &line[..line.len()-1] } else { line };
            let s = String::from_utf8_lossy(line).to_string();
            self.read = self.read.saturating_add((end + 1 - self.buf_pos) as u64);
            self.buf_pos = end + 1; // skip the \n
            // Compact buffer periodically.
            if self.buf_pos > 16384 {
                self.buf.drain(..self.buf_pos);
                self.buf_pos = 0;
            }
            return Some(s);
        }
        None
    }

    /// Read more data into the buffer.
    async fn fill_buf(&mut self) -> std::io::Result<()> {
        let mut tmp = [0u8; 4096];

        if self.is_chunked {
            // For chunked encoding, we need to be careful about
            // chunk boundaries.  However, SSE lines are always
            // within a single chunk in practice (servers don't
            // split a data: line across chunks).  We read raw
            // bytes and handle chunk boundaries in the line
            // buffer.  This is simpler than tracking exact chunk
            // positions and works because we only need lines.
            //
            // For correctness, we parse chunk headers when we
            // run out of chunk data.
            if self.chunk_remaining == Some(0) {
                // Read and discard the trailing \r\n after a chunk,
                // then read the next chunk header.
                let mut crlf = [0u8; 2];
                match self.stream.read_exact(&mut crlf).await {
                    Ok(_) => {}
                    Err(e) if e.kind() == tokio::io::ErrorKind::UnexpectedEof => {
                        self.eof = true;
                        return Ok(());
                    }
                    Err(e) => return Err(e),
                }
                self.chunk_remaining = None;
            }

            if self.chunk_remaining.is_none() {
                // Read chunk size line.
                let mut size_line = Vec::new();
                let mut byte = [0u8; 1];
                loop {
                    match self.stream.read(&mut byte).await {
                        Ok(0) => { self.eof = true; return Ok(()); }
                        Ok(_) => {
                            size_line.push(byte[0]);
                            if size_line.ends_with(b"\r\n") {
                                break;
                            }
                            // Some servers include chunk extensions
                            // after the size: 1a;ext=val\r\n
                            if size_line.ends_with(b"\n") {
                                break;
                            }
                        }
                        Err(e) if e.kind() == tokio::io::ErrorKind::UnexpectedEof => {
                            self.eof = true;
                            return Ok(());
                        }
                        Err(e) => return Err(e),
                    }
                }
                let size_str = String::from_utf8_lossy(&size_line);
                let size_str = size_str.trim();
                // Strip chunk extensions (everything after ;).
                let size_str = size_str.split(';').next().unwrap_or("0").trim();
                let size = match usize::from_str_radix(size_str, 16) {
                    Ok(n) => n,
                    Err(_) => { self.eof = true; return Ok(()); }
                };
                if size == 0 {
                    // Last chunk — end of body.
                    self.eof = true;
                    return Ok(());
                }
                self.chunk_remaining = Some(size);
            }

            // Read up to chunk_remaining bytes or tmp.len(), whichever is smaller.
            let remaining = match self.chunk_remaining {
                Some(r) => r,
                None    => return Err(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    "chunk_remaining unexpectedly unset")),
            };
            let to_read = remaining.min(tmp.len());
            match self.stream.read(&mut tmp[..to_read]).await {
                Ok(0) => { self.eof = true; return Ok(()); }
                Ok(n) => {
                    self.buf.extend_from_slice(&tmp[..n]);
                    self.chunk_remaining = Some(remaining - n);
                }
                Err(e) if e.kind() == tokio::io::ErrorKind::UnexpectedEof => {
                    self.eof = true;
                    return Ok(());
                }
                Err(e) => return Err(e),
            }
        } else {
            // Identity encoding — read directly.
            match self.stream.read(&mut tmp).await {
                Ok(0) => { self.eof = true; return Ok(()); }
                Ok(n) => self.buf.extend_from_slice(&tmp[..n]),
                Err(e) if e.kind() == tokio::io::ErrorKind::UnexpectedEof => {
                    self.eof = true;
                    return Ok(());
                }
                Err(e) => return Err(e),
            }
        }
        Ok(())
    }
}

/// Parse an SSE response body, calling `on_token` for each text delta.
///
/// SSE format:
/// ```text
/// data: {"choices":[{"delta":{"content":"Hello"}}]}
///
/// data: {"choices":[{"delta":{"content":" world"}}]}
///
/// data: [DONE]
/// ```
///
/// We scan for `"content":"..."` in each `data:` line.  This is a
/// deliberately simple parser — it handles the common case without
/// needing a full JSON parser.  Escaped quotes inside content are
/// handled by scanning for the matching unescaped quote.
pub fn parse_sse_stream(body: &[u8], on_token: &mut impl FnMut(&str))
    -> (String, Usage)
{
    let text = String::from_utf8_lossy(body);
    let mut full = String::new();
    let mut use_ = Usage::default();

    for line in text.lines() {
        let line = line.trim();
        if !line.starts_with("data: ") {
            continue;
        }
        let data = &line[6..];
        if data == "[DONE]" {
            break;
        }
        // Extract content from: {"choices":[{"delta":{"content":"..."}}]}
        if let Some(content) = extract_json_string(data, "content") {
            on_token(&content);
            full.push_str(&content);
        }
        // Extract usage from the final chunk:
        // {"choices":[],"usage":{"prompt_tokens":13,"completion_tokens":200}}
        if let Some(u) = parse_usage(data) {
            use_ = u;
        }
    }

    (full, use_)
}

/// Read a `usage` object out of a whole response body or one SSE chunk,
/// returning `None` when the chunk carries none.
///
/// Intermediate streamed chunks send `"usage":null`, which is not an object
/// and so reads as absent rather than as a zeroed usage -- otherwise the last
/// chunk before `[DONE]` would erase what the usage chunk reported.
///
/// # Arguments
/// * `json` - A response body, or one SSE `data:` payload.
pub(crate) fn parse_usage(json: &str) -> Option<Usage> {
    let usage = match find_json_object(json, "usage") {
        Some(u) => u,
        None    => return None,
    };
    let mut u = Usage::default();
    if let Some(p) = extract_json_number(&usage, "prompt_tokens")     { u.prompt     = p; }
    if let Some(c) = extract_json_number(&usage, "completion_tokens") { u.completion = c; }
    // Cache reads live in a nested `prompt_tokens_details`; a provider that
    // flattens the field is read too, so neither shape is missed.  A cache read
    // bills at a fraction of a fresh prompt token, and in an agentic tool loop
    // -- where every round's prompt is the last round's plus a little -- it is
    // most of the prompt, so counting it at the full input rate was the single
    // largest source of overstatement.
    // Three spellings, because three providers report the same figure three
    // ways: the OpenAI-compatible nesting, a flattened copy of it, and
    // Anthropic's own `cache_read_input_tokens`.  Missing the last one would
    // read a working prompt cache as no cache at all.
    u.cached = match find_json_object(&usage, "prompt_tokens_details") {
        Some(d) => extract_json_number(&d, "cached_tokens").unwrap_or(0),
        None    => extract_json_number(&usage, "cached_tokens")
            .or_else(|| extract_json_number(&usage, "cache_read_input_tokens"))
            .unwrap_or(0),
    };
    // What the provider actually drew.  This is money, not an estimate, and it
    // supersedes anything the price table would have guessed.
    if let Some(c) = extract_json_f64(&usage, "cost") { u.cost_usd = c; }
    Some(u)
}

/// Extract a JSON object value for a key from a JSON string.
///
/// Scans for `"key":{...}` and returns the inner object string
/// (including the braces).  Used to extract the `usage` object
/// from the final SSE chunk.
pub(crate) fn find_json_object(json: &str, key: &str) -> Option<String> {
    let needle = fmt!("\"{}\":", key);
    let pos = match json.find(&needle) {
        Some(p) => p,
        None    => return None,
    };
    let bytes = json.as_bytes();
    // Skip whitespace after the colon to the opening brace.
    let mut start = pos + needle.len();
    while start < bytes.len() && bytes[start].is_ascii_whitespace() { start += 1; }
    if start >= bytes.len() || bytes[start] != b'{' { return None; }
    let mut depth = 0i32;
    let mut i = start;
    while i < bytes.len() {
        match bytes[i] {
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(json[start..=i].to_string());
                }
            }
            b'"' => {
                // Skip string contents.
                i += 1;
                while i < bytes.len() {
                    if bytes[i] == b'\\' { i += 2; continue; }
                    if bytes[i] == b'"' { break; }
                    i += 1;
                }
            }
            _ => (),
        }
        i += 1;
    }
    None
}

/// Extract a numeric value for a key from a JSON string.
///
/// Scans for `"key":number` and returns the parsed value.
pub(crate) fn extract_json_number(json: &str, key: &str) -> Option<u64> {
    let needle = fmt!("\"{}\":", key);
    let pos = match json.find(&needle) {
        Some(p) => p,
        None    => return None,
    };
    let mut start = pos + needle.len();
    let bytes = json.as_bytes();
    // Skip whitespace.
    while start < bytes.len() && bytes[start].is_ascii_whitespace() {
        start += 1;
    }
    let mut end = start;
    while end < bytes.len() && (bytes[end].is_ascii_digit() || bytes[end] == b'-') {
        end += 1;
    }
    json[start..end].parse::<u64>().ok()
}

/// Extract a SIGNED integer value for a key from a JSON string.
///
/// [`extract_json_number`] parses a `u64`, so a negative number does not merely come back wrong --
/// it comes back as `None`, and every caller that reached for `unwrap_or(0)` then read a negative
/// value as zero.  For a process exit status that is the difference between "the command was
/// killed" and "the command succeeded", so the signed reader exists separately rather than as a
/// cast at the call site.
///
/// # Arguments
/// * `json` - The JSON text to read.
/// * `key` - The key whose value is wanted.
pub(crate) fn extract_json_i64(json: &str, key: &str) -> Option<i64> {
    let needle = fmt!("\"{}\":", key);
    let pos = match json.find(&needle) {
        Some(p) => p,
        None    => return None,
    };
    let mut start = pos + needle.len();
    let bytes = json.as_bytes();
    while start < bytes.len() && bytes[start].is_ascii_whitespace() {
        start += 1;
    }
    let mut end = start;
    while end < bytes.len() && (bytes[end].is_ascii_digit() || bytes[end] == b'-') {
        end += 1;
    }
    json[start..end].parse::<i64>().ok()
}

/// Extract a fractional numeric value for a key from a JSON string.
///
/// [`extract_json_number`] stops at the first non-digit, so it reads `0.0021`
/// as `0` -- which silently priced every reported cost at nothing.  This scans
/// the whole JSON number grammar: sign, digits, decimal point and exponent.
///
/// # Arguments
/// * `json` - The JSON text to scan.
/// * `key` - The key whose value is wanted.
pub(crate) fn extract_json_f64(json: &str, key: &str) -> Option<f64> {
    let needle = fmt!("\"{}\":", key);
    let pos = match json.find(&needle) {
        Some(p) => p,
        None    => return None,
    };
    let bytes = json.as_bytes();
    let mut start = pos + needle.len();
    // Skip whitespace, and an opening quote for a provider that sends the
    // figure as a string.
    while start < bytes.len() && bytes[start].is_ascii_whitespace() {
        start += 1;
    }
    if start < bytes.len() && bytes[start] == b'"' {
        start += 1;
    }
    let mut end = start;
    while end < bytes.len() {
        let b = bytes[end];
        let numeric = b.is_ascii_digit()
            || b == b'.'
            || b == b'-'
            || b == b'+'
            || b == b'e'
            || b == b'E';
        if !numeric { break; }
        end += 1;
    }
    json[start..end].parse::<f64>().ok()
}

/// Extract a boolean value for a key from a JSON string.
///
/// Scans for `"key":true`/`false` and accepts the quoted forms too, since
/// models routinely send a boolean argument as the string `"true"`.
pub fn extract_json_bool(json: &str, key: &str) -> Option<bool> {
    let needle = fmt!("\"{}\":", key);
    let pos = match json.find(&needle) {
        Some(p) => p,
        None    => return None,
    };
    let bytes = json.as_bytes();
    let mut i = pos + needle.len();
    // Skip whitespace, then an optional opening quote.
    while i < bytes.len() && bytes[i].is_ascii_whitespace() {
        i += 1;
    }
    if i < bytes.len() && bytes[i] == b'"' {
        i += 1;
    }
    let rest = &json[i..];
    if rest.starts_with("true") {
        Some(true)
    } else if rest.starts_with("false") {
        Some(false)
    } else {
        None
    }
}

/// Extract an array of strings for a key from a JSON string.
///
/// `None` when the key is absent or its value is not an array, which is what
/// lets a caller tell a field that was never written from one written empty.
pub(crate) fn extract_json_string_array(json: &str, key: &str) -> Option<Vec<String>> {
    let arr = match find_json_array(json, key) {
        Some(a) => a,
        None    => return None,
    };
    Some(parse_json_string_array(&arr))
}

/// Extract an array of objects for a key from a JSON string, each as its own text.
///
/// The sibling of [`extract_json_string_array`] for the shape a tool argument takes when one call
/// carries several of a thing -- `"edits":[{...},{...}]`. Each element comes back whole, for
/// [`extract_json_string`] and its siblings to read the fields out of.
///
/// `None` when the key is absent or its value is not an array, which is what lets a caller tell a
/// field that was never written from one written empty.
pub(crate) fn extract_json_objects(json: &str, key: &str) -> Option<Vec<String>> {
    find_json_array(json, key).map(|arr| split_top_level_objects(&arr))
}

/// Parse a JSON array's text into its string elements, ignoring any element
/// that is not a string.
///
/// Handles the escapes [`json_escape`] emits, `\uXXXX` among them, so a value
/// survives the round trip out to storage and back.
pub(crate) fn parse_json_string_array(arr: &str) -> Vec<String> {
    let bytes = arr.as_bytes();
    let mut out: Vec<String> = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        // Anything outside a quoted element -- brackets, commas, a number --
        // is not a string, and is stepped over.
        if bytes[i] != b'"' {
            i += 1;
            continue;
        }
        i += 1; // past the opening quote
        // Collect as bytes, then decode as UTF-8, so multi-byte characters survive.
        let mut buf: Vec<u8> = Vec::new();
        while i < bytes.len() {
            let b = bytes[i];
            if b == b'\\' && i + 1 < bytes.len() {
                match bytes[i + 1] {
                    b'"'  => { buf.push(b'"');  i += 2; }
                    b'\\' => { buf.push(b'\\'); i += 2; }
                    b'n'  => { buf.push(b'\n'); i += 2; }
                    b't'  => { buf.push(b'\t'); i += 2; }
                    b'r'  => { buf.push(b'\r'); i += 2; }
                    b'/'  => { buf.push(b'/');  i += 2; }
                    b'b'  => { buf.push(0x08);  i += 2; }
                    b'f'  => { buf.push(0x0c);  i += 2; }
                    b'u'  => match decode_json_unicode(bytes, i + 2) {
                        Some((c, next)) => {
                            let mut enc = [0u8; 4];
                            buf.extend_from_slice(c.encode_utf8(&mut enc).as_bytes());
                            i = next;
                        }
                        // Not a well-formed escape; keep it as written rather
                        // than lose the characters.
                        None => { buf.push(b'\\'); buf.push(b'u'); i += 2; }
                    },
                    other => { buf.push(b'\\'); buf.push(other); i += 2; }
                }
            } else if b == b'"' {
                i += 1; // past the closing quote
                break;
            } else {
                buf.push(b);
                i += 1;
            }
        }
        out.push(String::from_utf8_lossy(&buf).to_string());
    }
    out
}

/// Decode a `\uXXXX` escape whose first hex digit is at `i`, pairing a leading
/// surrogate with the trailing one that follows it.
///
/// Returns the character and the index just past the escape, or `None` when the
/// escape is malformed or a surrogate is left unpaired.
fn decode_json_unicode(bytes: &[u8], i: usize) -> Option<(char, usize)> {
    // Four hex digits at `s`, as a code unit.
    let unit = |s: usize| -> Option<u32> {
        if s + 4 > bytes.len() {
            return None;
        }
        match std::str::from_utf8(&bytes[s..s + 4]) {
            Ok(txt) => u32::from_str_radix(txt, 16).ok(),
            Err(_)  => None,
        }
    };
    let first = match unit(i) {
        Some(v) => v,
        None    => return None,
    };
    // A leading surrogate is only half a character: its pair follows as a
    // second `\uXXXX`, and the two combine into one code point.
    if (0xD800..0xDC00).contains(&first) {
        let j = i + 4;
        if j + 6 <= bytes.len() && bytes[j] == b'\\' && bytes[j + 1] == b'u' {
            if let Some(second) = unit(j + 2) {
                if (0xDC00..0xE000).contains(&second) {
                    let cp = 0x10000 + ((first - 0xD800) << 10) + (second - 0xDC00);
                    return char::from_u32(cp).map(|c| (c, j + 6));
                }
            }
        }
        return None;
    }
    char::from_u32(first).map(|c| (c, i + 4))
}


/// Handles `\"`, `\\`, `\n`, `\t` escapes.
///
/// The search ensures `key` is a complete JSON key, not a suffix of
/// a longer key (e.g. `"content"` must not match inside
/// `"reasoning_content"`).  This is done by requiring the character
/// before the opening quote to be `{` or `,` (whitespace-tolerant).
pub(crate) fn extract_json_string(json: &str, key: &str) -> Option<String> {
    let needle = fmt!("\"{}\":", key);
    let bytes = json.as_bytes();
    let mut search_from = 0;
    loop {
        let pos = match json[search_from..].find(&needle) {
            Some(p) => search_from + p,
            None => return None,
        };
        // Reject suffix matches (e.g. "content" inside
        // "reasoning_content") by checking the character before the
        // key's opening quote.
        let valid_prefix = pos == 0 || {
            let prev = bytes[pos - 1];
            prev == b'{' || prev == b',' || prev.is_ascii_whitespace()
        };
        if !valid_prefix {
            search_from = pos + needle.len();
            continue;
        }
        // Skip whitespace between the colon and the value — real API
        // output uses `"key": "value"` with a space.
        let mut i = pos + needle.len();
        while i < bytes.len() && bytes[i].is_ascii_whitespace() { i += 1; }
        if i >= bytes.len() || bytes[i] != b'"' {
            // Value is not a string (null / number / object); keep
            // searching in case the key appears again.
            search_from = pos + needle.len();
            continue;
        }
        i += 1; // past the opening quote
        // Collect the string value as bytes, then decode as UTF-8, so
        // multi-byte characters survive.
        let mut out: Vec<u8> = Vec::new();
        while i < bytes.len() {
            let b = bytes[i];
            if b == b'\\' && i + 1 < bytes.len() {
                match bytes[i + 1] {
                    b'"'  => out.push(b'"'),
                    b'\\' => out.push(b'\\'),
                    b'n'  => out.push(b'\n'),
                    b't'  => out.push(b'\t'),
                    b'r'  => out.push(b'\r'),
                    b'/'  => out.push(b'/'),
                    other => { out.push(b'\\'); out.push(other); }
                }
                i += 2;
            } else if b == b'"' {
                return Some(String::from_utf8_lossy(&out).to_string());
            } else {
                out.push(b);
                i += 1;
            }
        }
        return None;
    }
}

/// The keys of a JSON object's own top level, in the order they were written.
///
/// For a refusal that has to say what it was actually sent.  A tool that answers "neither shape
/// was readable" and then does not say which shape DID arrive leaves the model guessing, and a
/// model guessing spends rounds: measured 2026-09-12, two refused `file_edit` calls before a
/// third found a shape that parsed.  Nested objects and arrays are stepped over, so what comes
/// back is the argument names and nothing from inside them.
pub(crate) fn json_top_level_keys(json: &str) -> Vec<String> {
    let bytes = json.as_bytes();
    let mut out: Vec<String> = Vec::new();
    let mut depth = 0i32;
    let mut i = 0usize;
    while i < bytes.len() {
        match bytes[i] {
            b'{' | b'[' => { depth += 1; i += 1; },
            b'}' | b']' => { depth -= 1; i += 1; },
            b'"' => {
                // The key's own text, then whether a colon follows it: a string in the value
                // position is not a key, and at depth 1 the two are told apart by that colon.
                let from = i + 1;
                let mut j = from;
                while j < bytes.len() {
                    if bytes[j] == b'\\' { j += 2; continue; }
                    if bytes[j] == b'"' { break; }
                    j += 1;
                }
                let end = j.min(bytes.len());
                let mut k = end + 1;
                while k < bytes.len() && bytes[k].is_ascii_whitespace() { k += 1; }
                if depth == 1 && k < bytes.len() && bytes[k] == b':' && end > from {
                    out.push(json[from..end].to_string());
                }
                i = end + 1;
            },
            _ => i += 1,
        }
    }
    out
}

/// Convert a JDAT DaticleMap to a minimal JSON string.
///
/// This is used to build the LLM API request body without `serde`.
/// Only handles the types we need: String, U64, Bool, Map, List.
/// The shortest prefix worth a cache breakpoint, in characters.
///
/// Anthropic will not cache a prefix below a per-model minimum, and says nothing
/// when it declines -- the request simply reports no cache write.  512 tokens is
/// the lowest of those minimums (Claude Opus 5; other models want 1024 or more),
/// and four characters per token is the usual rough conversion, so a prefix
/// shorter than this cannot cache on any model and the marker is not sent.
pub(crate) const CACHE_MIN_PREFIX_CHARS: usize = 2048;

/// Whether this model honours an explicit `cache_control` breakpoint.
///
/// Claude is the case that needs one: Fireworks, DeepSeek and OpenAI cache
/// automatically, and Anthropic does not.  The model id is what selects the
/// upstream model -- the host varies (direct, a router, Daimond's own gateway
/// proxy) while the same Claude model behind any of them reads the same marker,
/// so the id is what this gates on.  Every id form is covered: the OpenRouter
/// `anthropic/claude-...`, the Bedrock `anthropic.claude-...`, and the bare
/// `claude-...`.
pub(crate) fn model_caches_on_request(model: &str) -> bool {
    let m = model.to_ascii_lowercase();
    m.contains("claude") || m.starts_with("anthropic/") || m.starts_with("anthropic.")
}

/// The Anthropic API version this client is written against.
///
/// Pinned rather than tracking latest: the version header is what stops a
/// breaking change to the wire shape arriving without a code change.
pub(crate) const ANTHROPIC_VERSION: &str = "2023-06-01";

/// The smallest output cap a streamed thinking request is sent with.
///
/// Well under the 128k ceiling every thinking-capable model offers, and enough
/// room for the reasoning and the answer that follows it.  See
/// [`anthropic_max_tokens`](LlmClient::anthropic_max_tokens).
pub(crate) const THINKING_MIN_MAX_TOKENS: u32 = 32_000;

/// An Anthropic `text` content block, optionally carrying a cache breakpoint.
///
/// # Arguments
/// * `text` - The block's text, escaped here.
/// * `cached` - Whether to attach an ephemeral `cache_control` marker.
fn text_block(text: &str, cached: bool) -> String {
    if cached {
        fmt!("{{\"type\":\"text\",\"text\":\"{}\",\"cache_control\":{{\"type\":\"ephemeral\"}}}}",
            json_escape(text))
    } else {
        fmt!("{{\"type\":\"text\",\"text\":\"{}\"}}", json_escape(text))
    }
}

/// An Anthropic `image` content block, base64 source.
///
/// The shape is the one the Messages API publishes:
/// `{"type":"image","source":{"type":"base64","media_type":…,"data":…}}`.  Key order matters to
/// nothing but the fixture that pins it, and it is the documentation's order.
///
/// A cache breakpoint may sit on an image block as on any other, and it has to be able to: the
/// breakpoint caches everything up to the block it is on, so a message whose last block is the
/// image would otherwise have no legal place to put one and would silently lose the cache.
///
/// # Arguments
/// * `img` - The image; its bytes are base64-encoded here, once per request.
/// * `cached` - Whether to attach an ephemeral `cache_control` marker.
fn image_block(img: &ImagePart, cached: bool) -> String {
    let mark = if cached { ",\"cache_control\":{\"type\":\"ephemeral\"}" } else { "" };
    fmt!(
        "{{\"type\":\"image\",\"source\":{{\"type\":\"base64\",\"media_type\":\"{}\",\
         \"data\":\"{}\"}}{}}}",
        img.media.mime(), img.base64(), mark)
}

/// A message's content as Anthropic content blocks, in order.
///
/// The cache marker goes on the LAST block, because a breakpoint caches the prefix up to and
/// including the block it sits on -- putting it on the first of several would leave the rest of
/// the message re-billed on every turn, which is the opposite of what marking it was for.
///
/// # Arguments
/// * `content` - What the message carries.
/// * `cached` - Whether this message is a cache breakpoint.
fn anthropic_blocks(content: &MessageContent, cached: bool) -> Vec<String> {
    let parts: Vec<&ContentPart> = match content {
        MessageContent::Text(s) => {
            // An empty text block is rejected outright, where the OpenAI side simply carries the
            // empty string through.
            return if s.is_empty() { Vec::new() } else { vec![text_block(s, cached)] };
        },
        MessageContent::Parts(parts) => parts.iter().collect(),
    };
    let last = parts.len().saturating_sub(1);
    let mut out = Vec::with_capacity(parts.len());
    for (i, p) in parts.iter().enumerate() {
        match p {
            ContentPart::Text(t) if t.is_empty() => {},
            ContentPart::Text(t)  => out.push(text_block(t, cached && i == last)),
            ContentPart::Image(m) => out.push(image_block(m, cached && i == last)),
        }
    }
    out
}

/// The `user` message that carries images lifted out of a run of OpenAI tool replies.
///
/// The leading sentence is not decoration: without it the model receives images with no statement
/// of where they came from, and the turn reads as the user having pasted them.
///
/// # Arguments
/// * `blocks` - Ready-made `image_url` parts, in the order the tools returned them.
fn tool_image_message(blocks: &[String]) -> String {
    fmt!(
        "{{\"role\":\"user\",\"content\":[{{\"type\":\"text\",\"text\":\"{}\"}},{}]}}",
        json_escape("[The images returned by the tool calls above, in order.]"),
        blocks.join(","))
}

/// A message's content as the OpenAI `content` field: a JSON string, or an array of parts.
///
/// A bare string whenever there is no image, because that is what every OpenAI-compatible router
/// has always been sent and the array form buys nothing.  With an image it becomes the documented
/// parts array, where an image is `{"type":"image_url","image_url":{"url":"data:…;base64,…"}}` --
/// the `url` field takes "a URL or a base64 encoded data URL", so the bytes ride in an RFC 2397
/// data URL rather than in a field of their own.
///
/// # Arguments
/// * `content` - What the message carries.
fn openai_content(content: &MessageContent) -> String {
    match content {
        MessageContent::Text(s) => fmt!("\"{}\"", json_escape(s)),
        MessageContent::Parts(parts) => {
            let items: Vec<String> = parts.iter().map(|p| match p {
                ContentPart::Text(t) =>
                    fmt!("{{\"type\":\"text\",\"text\":\"{}\"}}", json_escape(t)),
                ContentPart::Image(m) => fmt!(
                    "{{\"type\":\"image_url\",\"image_url\":{{\"url\":\"data:{};base64,{}\"}}}}",
                    m.media.mime(), m.base64()),
            }).collect();
            fmt!("[{}]", items.join(","))
        },
    }
}

/// Whether `model` takes Anthropic's adaptive thinking configuration.
///
/// Adaptive is the only form worth sending: `budget_tokens` is removed on every
/// model released since Opus 4.7 and returns a 400 there, and deprecated on the
/// two before it.  So a model that does not take adaptive is sent no thinking
/// configuration at all rather than a guessed budget -- an older model then
/// simply answers without thinking, which is what it did before this existed.
///
/// The list is explicit rather than a `claude-` prefix test, because the whole
/// point of the gate is that the newer families and the older ones disagree
/// about what the parameter even means.
///
/// # Arguments
/// * `model` - The model id, in any of the forms a caller can configure.
pub(crate) fn model_takes_adaptive_thinking(model: &str) -> bool {
    let m = model.to_ascii_lowercase();
    const ADAPTIVE: [&str; 8] = [
        "claude-fable-5",
        "claude-mythos-5",
        "claude-opus-5",
        "claude-opus-4-8",
        "claude-opus-4-7",
        "claude-opus-4-6",
        "claude-sonnet-5",
        "claude-sonnet-4-6",
    ];
    ADAPTIVE.iter().any(|id| m.contains(id))
}

/// Whether `model` thinks whatever it is told.
///
/// Thinking is always on for these three families: `{"type":"disabled"}` is a 400 and omitting
/// the field runs adaptive anyway.  So a tune that asks for thinking off cannot be honoured on
/// them, and the honest thing is to send no `thinking` field and still allow the output cap the
/// room the reasoning will take.
///
/// # Arguments
/// * `model` - The model id, in any of the forms a caller can configure.
fn model_always_thinks(model: &str) -> bool {
    let m = model.to_ascii_lowercase();
    m.contains("claude-fable") || m.contains("claude-mythos")
}

/// Whether `model` predates `output_config.effort`'s `xhigh` level.
///
/// `xhigh` arrived with Opus 4.7.  The two 4.6 models take `low`, `medium`, `high` and `max`
/// and answer a 400 to `xhigh`, so an arm that asks for it on one of them is refused the
/// field rather than quietly given a level it did not choose.
fn model_predates_xhigh(model: &str) -> bool {
    let m = model.to_ascii_lowercase();
    m.contains("claude-opus-4-6") || m.contains("claude-sonnet-4-6")
}

/// Whether `{"type":"disabled"}` is a legal thing to send this model at this effort.
///
/// The tightest rule that is legal on every model that takes adaptive thinking at all: Opus 5
/// accepts it only at effort `high` or below, the 4.7/4.8 and Sonnet models accept it at any
/// effort, and Fable and Mythos accept it nowhere.  Holding all three to Opus 5's ceiling
/// sends a little less than the API would allow and never sends something it refuses.
///
/// # Arguments
/// * `model` - The model id, in any of the forms a caller can configure.
/// * `effort` - The level this request will carry.
fn thinking_off_accepted(model: &str, effort: Effort) -> bool {
    model_takes_adaptive_thinking(model)
        && !model_always_thinks(model)
        && effort.at_most_high()
}

/// Whether `output_config.effort` may carry `effort` to `model`.
///
/// The field errors on the models that do not think (Sonnet 4.5, Haiku 4.5 and everything
/// older), so the gate is the same list adaptive thinking uses, less `xhigh` on the two models
/// released before that level existed.
///
/// # Arguments
/// * `model` - The model id, in any of the forms a caller can configure.
/// * `effort` - The level this request would carry.
fn effort_accepted(model: &str, effort: Effort) -> bool {
    if !model_takes_adaptive_thinking(model) {
        return false;
    }
    match effort {
        Effort::XHigh => !model_predates_xhigh(model),
        _             => true,
    }
}

/// Whether `model` can be shown an image.
///
/// The test is a list of what is KNOWN BLIND, not a list of what is known to see, and the default
/// is that a model sees.  That direction is chosen deliberately: nearly every model a user would
/// configure today is multimodal, an allow-list would refuse every model released after this line
/// was written, and the cost of getting it wrong in this direction is one clear error from
/// [`LlmClient::vision_error`] rather than a refusal to try.  The names are matched as substrings
/// because a router spells the same model half a dozen ways (`openai/gpt-3.5-turbo`,
/// `gpt-3.5-turbo-0125`), and the family is what is blind, not the spelling.
///
/// # Arguments
/// * `model` - The model id, in whatever form the user configured it.
pub(crate) fn model_can_see(model: &str) -> bool {
    let m = model.to_ascii_lowercase();
    const BLIND: [&str; 8] = [
        "gpt-3.5",
        "text-davinci",
        "o1-mini",
        "o1-preview",
        "claude-instant",
        "claude-1",
        "claude-2",
        "embedding",
    ];
    !BLIND.iter().any(|id| m.contains(id))
}

/// Whether `model` is KNOWN to take pictures, which is the narrower question than
/// [`model_can_see`] and the one to ask before a picture is sent for the sake of a result.
///
/// An allow-list of the families that read them, where [`model_can_see`] is a deny-list that lets
/// every model it does not know through.  A model that is allowed but not proven is offered a
/// picture only where the request can afford the refusal that finds it out, and a Diamond's
/// `capture` does not go to such a model blind: it takes the table.  Anything the deny-list or a
/// refusal rules out is out here too.
///
/// # Arguments
/// * `model` - The model id, in whatever form the user configured it.
pub(crate) fn model_sight_proven(model: &str) -> bool {
    if !model_can_see(model) {
        return false;
    }
    let m = model.to_ascii_lowercase();
    // The id without its vendor prefix and without a router's `:free` style suffix.
    let base = m.rsplit('/').next().unwrap_or("").split(':').next().unwrap_or("");
    // A leading token, so `o3-mini` is the model and `foo3` is not.
    let leads = |t: &str| base == t || base.starts_with(&fmt!("{}-", t));
    // `glm-4v`, `glm-4.5v`: a 4 series id whose first token ends in `v`.
    let glm_v = base.strip_prefix("glm-")
        .and_then(|r| r.split('-').next())
        .map_or(false, |t| t.starts_with('4') && t.ends_with('v'));
    m.contains("claude")
        || base.starts_with("gpt-4o") || base.starts_with("chatgpt-4o") || base.starts_with("gpt-4.1")
        || base.starts_with("gpt-4-turbo") || base.starts_with("gpt-4-vision")
        || base.starts_with("gpt-4.5") || base.starts_with("gpt-5")
        || leads("o1") || leads("o3") || leads("o4")
        || m.contains("gemini")
        || m.contains("pixtral")
        || ((base.contains("llama-3.2") || base.contains("llama3.2")) && base.contains("vision"))
        || base.contains("llama-4") || base.contains("llama4")
        || (base.contains("qwen") && base.contains("-vl"))
        || base.contains("qvq")
        || base.contains("grok")
        || glm_v
}

/// Translate an OpenAI-shaped tool array into the Anthropic one.
///
/// `[{"type":"function","function":{"name":…,"description":…,"parameters":{…}}}]`
/// becomes `[{"name":…,"description":…,"input_schema":{…}}]`.  The schema
/// itself is JSON Schema in both, so it is carried through verbatim; only the
/// wrapper differs.  A definition missing a name or a schema is dropped rather
/// than sent half-built, since the API would reject the whole request for it.
///
/// # Arguments
/// * `tools` - The OpenAI-shaped tool array, as JSON text.
fn openai_tools_to_anthropic(tools: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    for elem in split_top_level_objects(tools) {
        // The function object, so `name` and `description` are read from it
        // rather than from a property of the schema that happens to share a key.
        let f = match find_json_object(&elem, "function") {
            Some(f) => f,
            None    => elem.clone(),
        };
        let name = match extract_json_string(&f, "name") {
            Some(n) if !n.is_empty() => n,
            _ => continue,
        };
        let schema = match find_json_object(&f, "parameters")
            .or_else(|| find_json_object(&f, "input_schema"))
        {
            Some(s) => s,
            None    => continue,
        };
        let desc = extract_json_string(&f, "description").unwrap_or_default();
        out.push(fmt!(
            "{{\"name\":\"{}\",\"description\":\"{}\",\"input_schema\":{}}}",
            json_escape(&name), json_escape(&desc), schema));
    }
    fmt!("[{}]", out.join(","))
}

/// The character length of a message's payload, as a stand-in for its tokens.
///
/// An image counts its own bytes here rather than its token cost, because this figure decides
/// only WHERE the prompt-cache breakpoints go, and what matters for that is what the message
/// weighs on the wire -- which for an image is its bytes.
fn message_len(msg: &ChatMessage) -> usize {
    let content = msg.content();
    let mut n = content.text_len() + content.images().map(|i| i.data.len()).sum::<usize>();
    if let ChatMessage::Assistant { tool_calls, .. } = msg {
        n += tool_calls.iter().map(|tc| tc.name.len() + tc.arguments.len()).sum::<usize>();
    }
    n
}

/// Serialise a `ChatMessage` with an Anthropic prompt-cache breakpoint on it.
///
/// The marker only exists on a content *block*, so the content becomes a
/// one-element array rather than a bare string.  Only the system and user roles
/// are given this form; anything else falls back to the plain serialisation, so
/// a caller that marks the wrong message loses the cache rather than the turn.
fn message_to_json_cached(msg: &ChatMessage) -> String {
    // A `tool` message carries its own id ahead of the content this function marks, so it is
    // built here rather than falling in with `system`/`user` below -- both of which pass a
    // caller-supplied `content` straight through and have nowhere to put one.
    //
    // Only ever reached for a Claude model (`cache_breakpoints` gates on
    // `model_caches_on_request`), so this is the same marker OpenRouter already passes through
    // for the system and user breakpoints above, now reaching the tool result that `run_tool_loop`
    // actually tails off in -- see the note on `LlmClient::cache_breakpoints`.
    if let ChatMessage::Tool { tool_call_id, content, .. } = msg {
        return fmt!(
            "{{\"role\":\"tool\",\"tool_call_id\":\"{}\",\"content\":[{{\"type\":\"text\",\
             \"text\":\"{}\",\"cache_control\":{{\"type\":\"ephemeral\"}}}}]}}",
            json_escape(tool_call_id), json_escape(&content.as_text()));
    }
    let (role, content) = match msg {
        ChatMessage::System { content }   => ("system", content),
        ChatMessage::User { content, .. } => ("user", content),
        _ => return message_to_json(msg),
    };
    // With an image in it the content is already an array, and the marker goes on the last block
    // rather than replacing the whole thing with one text block -- which would drop the image.
    //
    // On this side the marker goes on the last TEXT part and nowhere else. `cache_control` is an
    // Anthropic field that routers pass through; putting it inside an `image_url` part would put
    // an unrecognised key somewhere every OpenAI-compatible server validates strictly, to buy a
    // cache hit on a request that is mostly image bytes anyway. A message ending in an image
    // simply is not a breakpoint.
    if let MessageContent::Parts(parts) = content {
        let last = parts.iter().rposition(|p| matches!(p, ContentPart::Text(_)))
            .unwrap_or(usize::MAX);
        let items: Vec<String> = parts.iter().enumerate().map(|(i, p)| match p {
            ContentPart::Text(t) if i == last => fmt!(
                "{{\"type\":\"text\",\"text\":\"{}\",\"cache_control\":{{\"type\":\"ephemeral\"}}}}",
                json_escape(t)),
            ContentPart::Text(t) => fmt!("{{\"type\":\"text\",\"text\":\"{}\"}}", json_escape(t)),
            ContentPart::Image(m) => fmt!(
                "{{\"type\":\"image_url\",\"image_url\":{{\"url\":\"data:{};base64,{}\"}}}}",
                m.media.mime(), m.base64()),
        }).collect();
        return fmt!("{{\"role\":\"{}\",\"content\":[{}]}}", role, items.join(","));
    }
    fmt!(
        "{{\"role\":\"{}\",\"content\":[{{\"type\":\"text\",\"text\":\"{}\",\
         \"cache_control\":{{\"type\":\"ephemeral\"}}}}]}}",
        role, json_escape(&content.as_text()))
}


// ┌───────────────────────────────────────────────────────────────┐
// │ The two-depth answer, written inline                           │
// └───────────────────────────────────────────────────────────────┘
//
// `say` answered at two depths through a tool call.  The model now writes the same two depths
// into its own prose as a `<details>` element, and this is the reading half of it.  The fold is
// for the person reading: the wire carries it verbatim, as stored (daimond_rulings.md §17,
// 19 Oct 2026, which removed the strip that took a closed fold's body off the wire).  The shared
// shape is pinned in `dev/CONTRACT_FOLD.md`; the fixture both languages are tested against is
// `dev/fixtures/fold_keys.json`.

/// One `<details>` fold found in one assistant message's text.
///
/// Byte offsets rather than copied strings, so every character outside the body stays exactly
/// where the model put it.
struct Fold {
    ord:        usize,                  // 0-based over the real folds of this message
    summary:    String,                 // tags removed, whitespace runs collapsed to one space
    body:       std::ops::Range<usize>, // the TRIMMED body, as byte offsets into the text
    chars:      usize,                  // characters of that trimmed body
    closed:     bool,                   // whether a `</details>` was found for it
}

impl Fold {
    /// The one name the Rust and JS halves must agree on: `"<ordinal>:<summary>"`.
    ///
    /// No hash and no message identity, deliberately -- see `dev/CONTRACT_FOLD.md` §2.  Two
    /// messages can therefore share a key, and the only consequence is that opening one fold
    /// sends the body of a same-labelled, same-ordinal fold in another.  Nothing renders wrong.
    fn key(&self) -> String {
        fmt!("{}:{}", self.ord, self.summary)
    }
}

/// The fence a line opens or closes, as `(character, run length, whether an info string follows)`.
///
/// CommonMark's rule, to the part that matters here: up to three leading spaces, then three or
/// more backticks or tildes.  A run with an info string after it can only OPEN a fence, never
/// close one, which is what keeps ```` ```html ```` from closing the fence it opened.
fn fence_run(line: &str) -> Option<(u8, usize, bool)> {
    let t = line.trim_end_matches(['\n', '\r']);
    let lead = t.len() - t.trim_start_matches(' ').len();
    if lead > 3 {
        return None;
    }
    let rest = &t[lead..];
    let ch = match rest.as_bytes().first() {
        Some(&c) if c == b'`' || c == b'~' => c,
        _                                  => return None,
    };
    let n = rest.bytes().take_while(|&b| b == ch).count();
    if n < 3 {
        return None;
    }
    Some((ch, n, !rest[n..].trim().is_empty()))
}

/// The byte ranges of every line inside a fenced code region, the fence lines included.
///
/// **This is the single most likely source of a wrong fold.**  A `<details>` inside a fence is
/// literal text the model is SHOWING the user -- the markup itself, quoted.  It is not a fold, it
/// takes no ordinal, and seaming around it would edit the example out from under the person
/// reading it.  The renderer is already safe there because `marked` escapes it.
fn fenced_spans(text: &str) -> Vec<(usize, usize)> {
    let mut out: Vec<(usize, usize)> = Vec::new();
    let mut open: Option<(u8, usize)> = None;
    let mut at = 0usize;
    for line in text.split_inclusive('\n') {
        let end = at + line.len();
        match (fence_run(line), open) {
            // A close must match the character it opened with, be at least as long, and carry no
            // info string.
            (Some((ch, n, info)), Some((c, k))) if ch == c && n >= k && !info => {
                out.push((at, end));
                open = None;
            },
            (Some((ch, n, _)), None) => {
                out.push((at, end));
                open = Some((ch, n));
            },
            // Anything else inside a fence is fenced; anything else outside one is prose.
            _ => if open.is_some() { out.push((at, end)); },
        }
        at = end;
    }
    out
}

// ── The seam the APP places ─────────────────────────────────────────────────────────────────
//
// Three wordings by three authors asked the model to write the `<details>` itself, and 5 answers
// in 76 carried one -- `dev/PROMPT_NOTES.md` §5 and `dev/REGISTER_NOTES.md` §11, across two
// register kinds on the shape of question the note exists for.  So the markup is the app's now
// and the model writes one line: `Fold:` and a sentence or two of what the working below it
// concludes.  [`seam_text`] turns that line into exactly the element a model used to write, and
// [`folds`] below never learns that anything is different.
//
// **The refusals are the point, not the fold.**  A length threshold applied blindly produces
// FOLD-ALL, which `dev/CONTRACT_FOLD.md` §5 calls worse than no control at all.  Here the two
// failures no wording could prevent are unreachable instead: too little above the line, too few
// words in the summary, or too little below it, and there is no fold -- the sentence is left as
// prose and nothing is hidden.
//
// `www/js/render.js`'s `seamText` is the other half and the two must agree character for
// character, for `Fold::key`'s reason: the page names the fold the reader opened and this side
// matches the name.  `dev/fixtures/fold_seam.json` is what both are tested against.

/// Enough above the seam to be an answer.  The same forty characters `dev/probe_notes.mjs` calls
/// FOLD-ALL below, counted the same way -- whitespace collapsed, ends trimmed -- because it is
/// the same rule and not a second opinion about it.
const SEAM_LEAD_MIN:  usize = 40;
/// Enough below it to be worth a control, which is `dev/CONTRACT_FOLD.md` §5's carve-out.
const SEAM_BODY_MIN:  usize = 240;
/// A summary is a summary and not a label -- §13.
const SEAM_WORDS_MIN: usize = 6;

/// The summary a `Fold:` line carries, or `None` if the line is not one.
///
/// Generous in what it accepts, because a model that has understood the note and reached for a
/// heading or for bold should not lose its fold over the decoration: `Fold:`, `**Fold:**`,
/// `## Fold:` and `_Fold:_` all seam.  What it will not accept is an indented line, which is a
/// code block, or one whose summary is empty.
fn seam_line(line: &str) -> Option<String> {
    let raw = line.trim_end_matches(['\n', '\r']);
    if raw.starts_with("    ") || raw.starts_with('\t') {
        return None;
    }
    let mut s = raw.trim_start_matches(' ');
    // A heading marker, then at least one space, or `#Fold:` would seam as a heading.
    let hashes = s.bytes().take_while(|&b| b == b'#').count();
    if (1..=6).contains(&hashes) && s[hashes..].starts_with(' ') {
        s = s[hashes..].trim_start_matches(' ');
    }
    let lead = emphasis_at(s);
    s = &s[lead.len()..];
    // BY BYTES, NEVER BY A SLICE.  `&s[..4]` panicked on every answer whose first line began
    // with three ASCII characters and then a multi-byte one -- `OK \u{2014} but ...` -- because
    // byte 4 fell inside the em dash.  A panic here traps the wasm in the middle of the turn,
    // the JS `await` never settles, and every piece of end-of-turn bookkeeping is skipped:
    // measured 2026-09-12 on build 4d4fd190f1ef, where it cost a turn its `ended` event, its
    // workers their `end` events and the Diamond its busy flag, permanently.  `fold` is four
    // ASCII bytes, so a line that starts with it has a boundary at 4 and one that does not is
    // not a seam whatever it has there.
    let word = match s.as_bytes().get(..4) {
        Some(w) => w,
        None    => return None,
    };
    if !word.eq_ignore_ascii_case(b"fold") {
        return None;
    }
    let after = s[4..].trim_start_matches([' ', '\t']);
    let mut rest = match after.strip_prefix(':') {
        Some(r) => r,
        None    => return None,
    };
    let shut = emphasis_at(rest);
    if !shut.is_empty() {
        rest = &rest[shut.len()..];
    } else if !lead.is_empty() {
        let t = rest.trim_end();
        let tail = emphasis_end(t);
        if !tail.is_empty() {
            rest = &t[..t.len() - tail.len()];
        }
    }
    let sum = rest.split_whitespace().collect::<Vec<_>>().join(" ");
    if sum.is_empty() { None } else { Some(sum) }
}

/// The emphasis run a markdown span opens with, longest first.
fn emphasis_at(s: &str) -> &str {
    for m in ["**", "__", "*", "_"] {
        if s.starts_with(m) {
            return &s[..m.len()];
        }
    }
    ""
}

/// The emphasis run a markdown span closes with, longest first.
fn emphasis_end(s: &str) -> &str {
    for m in ["**", "__", "*", "_"] {
        if s.ends_with(m) {
            return &s[s.len() - m.len()..];
        }
    }
    ""
}

/// How much of `t` a reader would actually see, counted as the page counts it.
///
/// UTF-16 units rather than characters, because the other half of this is JavaScript and a
/// boundary the two halves disagreed on would fold on one side and not the other.
fn seam_visible(t: &str) -> usize {
    t.split_whitespace().collect::<Vec<_>>().join(" ").encode_utf16().count()
}

/// `text` with the model's `Fold:` line turned into the element it stands for, or `None` where
/// there is nothing to do.
///
/// Four outcomes and only one of them is a fold: no line at all, or a model that wrote its own
/// `<details>`, leaves the text alone; a line on a qualifying answer becomes one top-level fold,
/// blank lines and all; a line on an answer that does not qualify loses its `Fold:` and stays as
/// prose, so nothing is hidden and nothing is lost.  The page has a fourth, which this side
/// cannot have: mid-stream it holds the line back rather than showing a fold that might unwind.
pub fn seam_text(text: &str) -> Option<String> {
    if !text.to_ascii_lowercase().contains("fold") {
        return None;
    }
    // A model that wrote the markup itself has already placed its seam.
    if text.contains("<details") && !folds(text).is_empty() {
        return None;
    }
    let fenced = fenced_spans(text);
    let hidden = |p: usize| fenced.iter().any(|&(a, b)| p >= a && p < b);
    // Every `Fold:` line outside a fence: where it starts, how long it is, and what it says.
    let mut marks: Vec<(usize, usize, String)> = Vec::new();
    let mut at = 0usize;
    for line in text.split_inclusive('\n') {
        let bare = line.trim_end_matches(['\n', '\r']);
        if !hidden(at) {
            if let Some(sum) = seam_line(bare) {
                marks.push((at, bare.len(), sum));
            }
        }
        at += line.len();
    }
    let (start, len, sum) = match marks.first() {
        Some(m) => (m.0, m.1, m.2.clone()),
        None    => return None,
    };
    // Only the first line is the seam.  A second would otherwise reach the reader with its
    // marker still on it, so every later one loses the marker and stays where it is.
    let bare_from = |from: usize| -> String {
        let mut out = String::with_capacity(text.len());
        let mut cut = from;
        for &(a, n, ref s) in &marks {
            if a < from {
                continue;
            }
            out.push_str(&text[cut..a]);
            out.push_str(s);
            cut = a + n;
        }
        out.push_str(&text[cut..]);
        out
    };
    let above = &text[..start];
    // The line's own newline goes with the line.
    let rest_at = (start + len + 1).min(text.len());
    let body = &text[rest_at..];
    // A summary carrying the very tags this builds would close the element early and leave the
    // rest of the answer outside it.
    let tagged = sum.to_ascii_lowercase();
    if tagged.contains("<summary") || tagged.contains("</summary")
        || tagged.contains("<details") || tagged.contains("</details")
        || sum.split_whitespace().count() < SEAM_WORDS_MIN
        || seam_visible(above) < SEAM_LEAD_MIN
        || seam_visible(body) < SEAM_BODY_MIN
    {
        return Some(bare_from(0));
    }
    Some(fmt!("{}\n\n<details>\n<summary>{}</summary>\n\n{}\n\n</details>",
        above.trim_end(), sum, bare_from(rest_at).trim()))
}

/// [`seam_text`] applied, for a caller that only wants the text back.
///
/// The answer is stored seamed rather than seamed on the way out, so the element exists exactly
/// once and everything downstream -- the wire, the compactor, a reload of the thread a year
/// later -- meets an ordinary fold and nothing has to know about a marker line.
pub fn seamed(text: String) -> String {
    match seam_text(&text) {
        Some(t) => t,
        None    => text,
    }
}

/// Every real fold in one assistant message's text, in document order.
///
/// Four shapes are deliberately NOT folds, and each one is a case in the fixture.  A `<details>`
/// in a fence is quoted markup.  A `<details>` with no `<summary>` has no label, so it has no key.
/// A `<details>` NESTED inside another belongs to its parent's body, so it takes no key of its
/// own.  A `<details>` with no `</details>` is a fold still being written: it keys, because the
/// ordinal it takes is settled the moment its summary is.
///
/// **Elements are paired by DEPTH, not by the first closing tag that turns up.**  The browser's
/// parser nests correctly, so a scanner that closed an outer fold at its child's `</details>`
/// would disagree with the renderer about where the fold ENDS, cutting the body short.  Measured: the shared fixture's nested case gives a 48-character body under
/// first-close pairing and the correct 67 under this one.
fn folds(text: &str) -> Vec<Fold> {
    let fenced = fenced_spans(text);
    let hidden = |p: usize| fenced.iter().any(|&(a, b)| p >= a && p < b);
    // The next occurrence of `tag` at or after `from` that is not inside a fence.
    let next = |from: usize, tag: &str| -> Option<usize> {
        let mut at = from;
        while at < text.len() {
            match text[at..].find(tag) {
                Some(p) => {
                    let abs = at + p;
                    if !hidden(abs) {
                        return Some(abs);
                    }
                    at = abs + tag.len();
                },
                None => return None,
            }
        }
        None
    };
    let mut out: Vec<Fold> = Vec::new();
    let mut at = 0usize;
    while at < text.len() {
        let open = match next(at, "<details") {
            Some(p) => p,
            None    => break,
        };
        // Walk to the MATCHING close, counting depth.  `inner` is where the first child element
        // starts, which is the bound on how far the label may be looked for.
        let mut depth = 1usize;
        let mut scan  = open + "<details".len();
        let mut close: Option<usize> = None;
        let mut inner: Option<usize> = None;
        while depth > 0 {
            // `"<details"` cannot match inside `"</details>"`, so the two searches never see the
            // same tag twice.
            match (next(scan, "<details"), next(scan, "</details>")) {
                (Some(o), Some(c)) if o < c => {
                    depth += 1;
                    if inner.is_none() {
                        inner = Some(o);
                    }
                    scan = o + "<details".len();
                },
                (_, Some(c)) => {
                    depth -= 1;
                    scan = c + "</details>".len();
                    if depth == 0 {
                        close = Some(c);
                    }
                },
                // Nothing closes it: the model is still writing.
                (_, None) => break,
            }
        }
        // Without a close the element runs to the end of what has been written so far, which is
        // what a fold looks like part way through a stream.
        let limit = close.unwrap_or(text.len());
        // Where scanning resumes whether or not this element turns out to be a fold.  Past the
        // WHOLE element, which is what keeps a nested fold from taking an ordinal of its own.
        let after = match close {
            Some(c) => c + "</details>".len(),
            None    => text.len(),
        };
        // The label must belong to THIS element: a `<summary>` after the first child is the
        // child's, and borrowing it would put a nested fold's name on its parent's body.
        let labelled = |p: usize| p < limit && inner.map_or(true, |i| p < i);
        let sum_open = match next(open, "<summary").filter(|&p| labelled(p)) {
            Some(p) => p,
            None    => { at = after; continue; },
        };
        // AND IT MUST BE THE FIRST THING INSIDE, whitespace aside.  This is stricter than the
        // browser, which takes the first `<summary>` child as the control wherever it sits, and
        // the strictness is the point: it is the only shape in which "the body is what lies
        // between `</summary>` and `</details>`" is unambiguous, and it is exactly what the
        // prompt asks the model to write.  Prose before the label makes the element not a fold,
        // so it is left alone -- the reader still gets a native disclosure widget and the body
        // is not keyed.
        let head_gt = match text[open..limit].find('>') {
            Some(p) => open + p + 1,
            None    => { at = after; continue; },
        };
        if !text[head_gt..sum_open].trim().is_empty() {
            at = after;
            continue;
        }
        let sum_gt = match text[sum_open..limit].find('>') {
            Some(p) => sum_open + p + 1,
            None    => { at = after; continue; },
        };
        let sum_close = match next(sum_gt, "</summary>").filter(|&p| p < limit) {
            Some(p) => p,
            None    => { at = after; continue; },
        };
        let body_from = sum_close + "</summary>".len();
        let raw = &text[body_from..limit];
        let lead = raw.len() - raw.trim_start().len();
        let trimmed = raw.trim();
        out.push(Fold {
            ord:     out.len(),
            summary: collapse_ws(&strip_tags(&text[sum_gt..sum_close])),
            body:    (body_from + lead)..(body_from + lead + trimmed.len()),
            chars:   trimmed.chars().count(),
            closed:  close.is_some(),
        });
        at = after;
    }
    out
}

/// Everything outside `<...>`, which is the `<summary>` element's own text.
///
/// A `<` with no `>` after it is NOT a tag and is kept, because the browser keeps it too: the JS
/// half reads this same summary with `textContent`, and a model writing `a < b` in a label would
/// otherwise key it as `a` here and as `a < b` there -- one label, two keys, and a fold that
/// never opens.
fn strip_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    loop {
        let lt = match rest.find('<') {
            Some(p) => p,
            None    => { out.push_str(rest); return out; },
        };
        match rest[lt..].find('>') {
            Some(gt) => {
                out.push_str(&rest[..lt]);
                rest = &rest[lt + gt + 1..];
            },
            None => { out.push_str(rest); return out; },
        }
    }
}

/// Trimmed, with every internal whitespace run collapsed to one space.
fn collapse_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Serialise a `ChatMessage` to an OpenAI-API JSON object, including
/// assistant `tool_calls` and the `tool` role — which `datmap_to_json`
/// does not carry.
///
/// Only the `user` role may carry an image on this side; `system`, `assistant` and `tool` take a
/// string or text parts and nothing else.  A message of another role that somehow holds one is
/// flattened to the `[image …]` stand-in rather than sent as a part the API would reject; the
/// tool results that legitimately produce images are re-homed by
/// [`build_openai_body`](LlmClient::build_openai_body) instead.
///
fn message_to_json(msg: &ChatMessage) -> String {
    match msg {
        ChatMessage::System { content } =>
            fmt!("{{\"role\":\"system\",\"content\":\"{}\"}}", json_escape(&content.as_text())),
        ChatMessage::User { content, .. } =>
            fmt!("{{\"role\":\"user\",\"content\":{}}}", openai_content(content)),
        ChatMessage::Assistant { content, tool_calls } => {
            // The assistant's words go out as stored, folds and all (daimond_rulings.md §17).
            let text = json_escape(&content.as_text());
            if tool_calls.is_empty() {
                fmt!("{{\"role\":\"assistant\",\"content\":\"{}\"}}", text)
            } else {
                let calls: Vec<String> = tool_calls.iter().map(|tc| {
                    fmt!(
                    "{{\"id\":\"{}\",\"type\":\"function\",\"function\":{{\"name\":\"{}\",\"arguments\":\"{}\"}}}}",
                    json_escape(&tc.id), json_escape(&tc.name), json_escape(&tc.arguments))
                }).collect();
                fmt!("{{\"role\":\"assistant\",\"content\":\"{}\",\"tool_calls\":[{}]}}",
                    text, calls.join(","))
            }
        }
        ChatMessage::Tool { tool_call_id, content, .. } =>
            fmt!("{{\"role\":\"tool\",\"tool_call_id\":\"{}\",\"content\":\"{}\"}}",
                json_escape(tool_call_id), json_escape(&content.as_text())),
    }
}

/// Whether an OpenAI-shaped payload says the reply was cut at the output limit.
///
/// `finish_reason` is `null` on every delta but the last, and `"stop"` on an answer
/// that finished; `"length"` is the one value that means the model was still writing.
/// Read from the raw payload rather than inferred from malformed arguments, which is
/// what the browser had to do and which cannot see a plain text reply cut short.
fn openai_truncated(json: &str) -> bool {
    matches!(extract_json_string(json, "finish_reason").as_deref(), Some("length"))
}

/// Whether an Anthropic payload says the same thing.
fn anthropic_truncated(json: &str) -> bool {
    matches!(extract_json_string(json, "stop_reason").as_deref(), Some("max_tokens"))
}

// ┌───────────────────────────────────────────────────────────────┐
// │ StreamAcc — streamed delta accumulator                         │
// └───────────────────────────────────────────────────────────────┘

/// One tool call being reconstructed from streamed fragments.
///
/// A streamed `tool_calls` delta arrives in pieces keyed by `index`: the
/// first fragment usually carries the `id` and function `name` with an
/// empty `arguments`, and later fragments append `arguments` text until
/// the call is whole.
struct StreamCall {
    /// Position of this call within the assistant turn.
    index:     i64,
    id:        String,
    name:      String,
    /// Accumulated raw JSON arguments, concatenated across fragments.
    arguments: String,
}

/// Accumulates OpenAI-style streaming chat deltas across SSE chunks:
/// text content, incrementally-built tool calls, and usage.
///
/// Each `data:` payload is fed to [`ingest`](StreamAcc::ingest); when the
/// stream ends, [`into_response`](StreamAcc::into_response) yields the
/// assembled [`ChatOnceResponse`].
#[derive(Default)]
struct StreamAcc {
    content:           String,
    // The model's own working, kept apart from the answer it produced.
    reasoning:         String,
    // Bytes of `reasoning_details` seen: never shown, but data all the same; see `size`.
    pulse:             usize,
    /// The last usage block the stream reported.  An aborted stream may never
    /// deliver one, which leaves this at its default rather than erroring.
    usage:             Usage,
    calls:             Vec<StreamCall>,
    /// Whether a chunk said the reply stopped at the output limit.
    truncated:         bool,
    // The four trace fields; see `ChatOnceResponse` for what each is and why.
    gen_id:               String,
    finish_reason:        String,
    native_finish_reason: String,
    provider:             String,
}

impl StreamAcc {

    /// Fold one SSE `data:` payload into the accumulator, forwarding each delta to
    /// `on_token` as it arrives, labelled as answer or as working.
    fn ingest(&mut self, data: &str, on_token: &mut impl FnMut(Delta<'_>)) {
        // Text delta — scoped to before any `tool_calls` so a `content`
        // key inside a tool call's arguments is never mistaken for it.
        let scope_end = data.find("\"tool_calls\"").unwrap_or(data.len());
        if let Some(content) = extract_json_string(&data[..scope_end], "content") {
            if !content.is_empty() {
                on_token(Delta::Text(&content));
                self.content.push_str(&content);
            }
        }

        // THE MODEL'S OWN WORKING, which every reasoning model on this dialect streams
        // and which this client read none of until 2026-08-28. A measured DeepSeek round
        // pulled 1.8 MB down the wire over 84 seconds and put fifty characters on the
        // screen; all the rest was this field, discarded delta by delta, and the user was
        // billed for it while watching a spinner.
        //
        // Two spellings, and never both in one delta: `reasoning` is what OpenRouter
        // sends, `reasoning_content` is what DeepSeek's own endpoint calls it. So one is
        // read and then the other, rather than both concatenated.
        //
        // `reasoning_details` is NOT SHOWN. OpenRouter sends it alongside `reasoning` with
        // the same words in it, verbatim, so a reader that took both would put every
        // token on the page twice.  It is COUNTED, though, in `pulse`: a model that streams
        // only this field is working, and the stream's watch must not read it as silent.
        //
        // `null` is the value on the deltas that carry no reasoning, and
        // `extract_json_string` answers None for a value that is not a string -- so the
        // absence needs no test of its own here.
        let think = extract_json_string(&data[..scope_end], "reasoning")
            .or_else(|| extract_json_string(&data[..scope_end], "reasoning_content"));
        if let Some(t) = think {
            if !t.is_empty() {
                on_token(Delta::Reasoning(&t));
                self.reasoning.push_str(&t);
            }
        }

        if let Some(d) = find_json_array(&data[..scope_end], "reasoning_details") {
            if !d.trim_matches(|c: char| c == '[' || c == ']' || c.is_whitespace()).is_empty() {
                self.pulse += d.len();
            }
        }

        // Tool-call fragments — merge each into its slot by `index`.
        if let Some(arr) = find_json_array(data, "tool_calls") {
            for (pos, elem) in split_top_level_objects(&arr).into_iter().enumerate() {
                // A stream's fragment names its call; a whole completion's calls carry no
                // `index` and are told apart by where they stand.
                let index = extract_json_number(&elem, "index")
                    .map(|n| n as i64)
                    .unwrap_or(pos as i64);
                // Locate an existing slot by index before borrowing
                // mutably, so a new slot can be pushed without an
                // overlapping borrow.
                let pos = self.calls.iter().position(|c| c.index == index);
                let slot = match pos {
                    Some(p) => &mut self.calls[p],
                    None => {
                        self.calls.push(StreamCall {
                            index,
                            id:        String::new(),
                            name:      String::new(),
                            arguments: String::new(),
                        });
                        let last = self.calls.len() - 1;
                        &mut self.calls[last]
                    }
                };
                if let Some(id) = extract_json_string(&elem, "id") {
                    if !id.is_empty() { slot.id = id; }
                }
                if let Some(name) = extract_json_string(&elem, "name") {
                    if !name.is_empty() { slot.name = name; }
                }
                if let Some(args) = extract_json_string(&elem, "arguments") {
                    slot.arguments.push_str(&args);
                }
            }
        }

        // Usage — present on the final chunk when include_usage is set.
        if let Some(u) = parse_usage(data) {
            self.usage = u;
        }

        // Why the model stopped, which arrives on the last delta and nowhere else.
        // Sticky: a later chunk carrying only usage must not unsay it.
        if openai_truncated(data) {
            self.truncated = true;
        }

        // THE FOUR TRACE FIELDS, all sticky for the reason `truncated` is above: each
        // arrives on one delta (`id`/`provider` on every one in practice, `finish_reason`/
        // `native_finish_reason` only on the last) and a later chunk carrying none of them
        // must not blank out what an earlier one said.  `id` and `provider` are scoped to
        // before `choices` so a tool call's own nested `id` is never mistaken for the
        // generation's.
        let head_end = data.find("\"choices\"").unwrap_or(data.len());
        if let Some(id) = extract_json_string(&data[..head_end], "id") {
            if !id.is_empty() { self.gen_id = id; }
        }
        if let Some(p) = extract_json_string(&data[..head_end], "provider") {
            if !p.is_empty() { self.provider = p; }
        }
        if let Some(fr) = extract_json_string(data, "finish_reason") {
            if !fr.is_empty() { self.finish_reason = fr; }
        }
        if let Some(nfr) = extract_json_string(data, "native_finish_reason") {
            if !nfr.is_empty() { self.native_finish_reason = nfr; }
        }
    }

    /// Whether this turn has produced anything yet.
    ///
    /// A retry is only safe while this is false: text has already been handed to
    /// the caller, and a tool-call fragment is a partial the next attempt would
    /// duplicate rather than replace.
    fn has_output(&self) -> bool {
        !self.content.is_empty() || !self.calls.is_empty()
    }

    /// How much the model has said so far, in bytes: answer, working and call fragments.
    ///
    /// What "real data" means to the stream's watch -- it grew, or it did not.  A role-only
    /// first chunk, a usage block and a keep-alive are not progress, however many arrive.
    /// `reasoning_details` is progress too, though it is never shown (see `ingest`).
    fn size(&self) -> usize {
        self.content.len()
            + self.reasoning.len()
            + self.pulse
            + self.calls.iter().map(|c| c.id.len() + c.name.len() + c.arguments.len()).sum::<usize>()
    }

    /// Is the model reasoning, with no answer and no call begun?
    ///
    /// The one case where a quiet stream is still working: reasoning that arrives in bursts,
    /// or only as `reasoning_details`, with minutes between them.  See [`StreamWatch`].
    fn thinking_open(&self) -> bool {
        (!self.reasoning.is_empty() || self.pulse > 0)
            && self.content.is_empty()
            && self.calls.is_empty()
    }

    /// Consume the accumulator into a [`ChatOnceResponse`].  Calls with no
    /// name are dropped (a stray fragment), and an empty arguments string
    /// becomes `{}` so tool dispatch always sees a valid JSON object.
    fn into_response(self, aborted: bool, retries: u32) -> ChatOnceResponse {
        let tool_calls = self.calls.into_iter()
            .filter(|c| !c.name.is_empty())
            .map(|c| ToolCall {
                id:        c.id,
                name:      c.name,
                arguments: if c.arguments.is_empty() { "{}".to_string() } else { c.arguments },
            })
            .collect();
        ChatOnceResponse {
            content:           self.content,
            tool_calls,
            prompt_tokens:     self.usage.prompt,
            completion_tokens: self.usage.completion,
            cached_tokens:     self.usage.cached,
            cost_usd:          self.usage.cost_usd,
            aborted,
            retries,
            thinking:          self.reasoning,
            truncated:         self.truncated,
            // Set by the caller (`stream_turn`) from the `StreamOutcome` this accumulator
            // never sees; a placeholder here so the struct is never partly built.
            stalled:           false,
            shape:             ReplyShape::Plain,
            gen_id:               self.gen_id,
            finish_reason:        self.finish_reason,
            native_finish_reason: self.native_finish_reason,
            provider:             self.provider,
            // Set by `stream_turn` from the `StreamOutcome`; zero on a whole reply.
            bytes: 0, first_ms: 0, gap_ms: 0, ms: 0, tok_ms: 0, gen_ms: 0,
        }.classified()
    }
}

// ┌───────────────────────────────────────────────────────────────┐
// │ AnthropicAcc — Messages API event accumulator                  │
// └───────────────────────────────────────────────────────────────┘

/// What one Anthropic content block is.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AnthKind {
    Text,
    Thinking,
    /// A `redacted_thinking` block, which is opaque and replayed verbatim.
    Redacted,
    ToolUse,
    /// A block this client does not act on (a server tool, a fallback marker).
    Other,
}

/// One content block being rebuilt from the event stream.
struct AnthBlock {
    /// Position in the message's `content` array; the streamed events key on it.
    index: i64,
    kind:  AnthKind,
    id:    String,
    name:  String,
    /// `input_json_delta` fragments, concatenated into the tool's arguments.
    args:  String,
    /// `thinking_delta` fragments, concatenated.
    think: String,
    /// The block's signature, which the API verifies when it is handed back.
    sig:   String,
    /// A block replayed verbatim rather than rebuilt, as JSON.
    raw:   String,
}

/// The Anthropic `usage` counts, kept as reported.
///
/// Held raw rather than folded into [`Usage`] on arrival because they arrive
/// twice -- once on `message_start` and again, cumulatively, on `message_delta`
/// -- and the second report names only the fields that changed.  Overwriting
/// [`Usage`] wholesale from the second would zero the input counts.
#[derive(Clone, Copy, Debug, Default)]
struct AnthUsage {
    input:  u64,
    output: u64,
    /// Prompt tokens served from the cache, billed at a tenth of a fresh read.
    read:   u64,
    /// Prompt tokens written to the cache, billed at 1.25x a fresh read.
    write:  u64,
}

/// One Anthropic model's list price, USD per million tokens.
///
/// Anthropic itself reports no `cost` on any response (`AnthUsage::into_usage` always hands back
/// zero), so a direct call books nothing unless something on this side prices the tokens it DID
/// report. Kept in step BY HAND with the browser's own table (`www/js/pricing.js`, "Anthropic"
/// section) -- there is no source the two could share, and the JS file is the one a router call's
/// ledger already reads, this the one a call that reports no cost at all needs instead.
struct AnthPrice {
    model:  &'static str,   // the bare model id, without a provider prefix or a date suffix
    input:  f64,            // per million fresh prompt tokens
    output: f64,            // per million completion tokens
    cached: f64,            // per million prompt tokens served from the cache
}

const ANTHROPIC_PRICES: &[AnthPrice] = &[
    AnthPrice { model: "claude-fable-5",     input: 10.00, output: 50.00, cached: 1.00 },
    AnthPrice { model: "claude-mythos-5",    input: 10.00, output: 50.00, cached: 1.00 },
    AnthPrice { model: "claude-opus-5",      input:  5.00, output: 25.00, cached: 0.50 },
    AnthPrice { model: "claude-opus-4-8",    input:  5.00, output: 25.00, cached: 0.50 },
    AnthPrice { model: "claude-opus-4-7",    input:  5.00, output: 25.00, cached: 0.50 },
    AnthPrice { model: "claude-opus-4-6",    input:  5.00, output: 25.00, cached: 0.50 },
    // Introductory pricing, as `pricing.js` documents; update both files together when it lapses.
    AnthPrice { model: "claude-sonnet-5",    input:  2.00, output: 10.00, cached: 0.20 },
    AnthPrice { model: "claude-sonnet-4-6",  input:  3.00, output: 15.00, cached: 0.30 },
    AnthPrice { model: "claude-haiku-4.5",   input:  1.00, output:  5.00, cached: 0.10 },
    // Still served and still one click away in the picker; see `pricing.js`'s own comment on the
    // unknown-model fallback these three would otherwise fall to.
    AnthPrice { model: "claude-opus-4-5",    input:  5.00, output: 25.00, cached: 0.50 },
    AnthPrice { model: "claude-sonnet-4-5",  input:  3.00, output: 15.00, cached: 0.30 },
    AnthPrice { model: "claude-opus-4-1",    input: 15.00, output: 75.00, cached: 1.50 },
];

/// The price row for `model`, or `None` for one this table does not know.
///
/// Matches the bare id exactly, or as a prefix followed by `-` -- so
/// `claude-opus-4-5-20251101` prices as `claude-opus-4-5` without a separate entry for every
/// dated snapshot, the same way `pricing.js`'s own `alias` arrays do.
fn anthropic_price_row(model: &str) -> Option<&'static AnthPrice> {
    let bare = model.strip_prefix("anthropic/").unwrap_or(model);
    ANTHROPIC_PRICES.iter().find(|p| bare == p.model || bare.starts_with(&fmt!("{}-", p.model)))
}

/// List-price cost of one call, in USD, from Anthropic's own token counts -- the fallback for a
/// dialect that reports usage and never a cost (see the module note above `ANTHROPIC_PRICES`).
///
/// Zero for a model this table does not know, deliberately: a wrong guess is worse than a ledger
/// that honestly has nothing to show for an unpriced call, and `0.0` already means exactly that
/// everywhere else `cost_usd` is read (see [`Usage::cost_usd`]).
///
/// # Arguments
/// * `model` - The provider's own id, exactly as [`LlmClient::model`] holds it.
/// * `prompt` - Every prompt token processed, cache included (see [`Usage::prompt`]).
/// * `cached` - The subset of `prompt` served from the cache, billed at the cheaper rate.
fn anthropic_list_price_usd(model: &str, prompt: u64, completion: u64, cached: u64) -> f64 {
    let row = match anthropic_price_row(model) {
        Some(r) => r,
        None    => return 0.0,
    };
    let fresh = prompt.saturating_sub(cached);
    (fresh as f64 * row.input + cached as f64 * row.cached) / 1_000_000.0
        + completion as f64 * row.output / 1_000_000.0
}

impl AnthUsage {

    /// Fold in one `usage` object, taking only the fields it actually carries.
    fn merge(&mut self, usage: &str) {
        if let Some(v) = extract_json_number(usage, "input_tokens")                { self.input  = v; }
        if let Some(v) = extract_json_number(usage, "output_tokens")               { self.output = v; }
        if let Some(v) = extract_json_number(usage, "cache_read_input_tokens")     { self.read   = v; }
        if let Some(v) = extract_json_number(usage, "cache_creation_input_tokens") { self.write  = v; }
    }

    /// The client's own usage shape.
    ///
    /// Anthropic's `input_tokens` counts only what was neither read from nor
    /// written to the cache, where this client's `prompt` means every prompt
    /// token processed -- so the three are added, and `cached` is the read.
    /// The 1.25x premium on a cache *write* is not modelled: the price table
    /// carries one cached rate, not two, so a write is priced as a fresh read.
    /// That understates the first request of a session slightly and nothing
    /// afterwards, which is the smaller of the two errors available.
    fn into_usage(self) -> Usage {
        Usage {
            prompt:     self.input.saturating_add(self.read).saturating_add(self.write),
            completion: self.output,
            cached:     self.read,
            // Anthropic bills against an account and reports no per-call cost,
            // so this stays zero and the price table answers instead.
            cost_usd:   0.0,
        }
    }
}

/// Accumulates the Anthropic Messages API event stream: text, thinking,
/// incrementally-built tool calls, and usage.
///
/// The events are named (`content_block_start`, `content_block_delta`, …) and
/// keyed by block index, rather than being deltas of one growing object, so
/// this is a different machine from [`StreamAcc`] rather than a variation of it.
#[derive(Default)]
struct AnthropicAcc {
    content: String,
    usage:   AnthUsage,
    blocks:  Vec<AnthBlock>,
    /// An `error` event delivered on an otherwise-successful stream, as
    /// `(type, message)`.
    error:   Option<(String, String)>,
    /// Whether a `message_delta` said the reply stopped at the output limit.
    truncated: bool,
}

impl AnthropicAcc {

    /// The slot for `index`, created if this is the first event for it.
    fn slot(&mut self, index: i64, kind: AnthKind) -> &mut AnthBlock {
        match self.blocks.iter().position(|b| b.index == index) {
            Some(p) => &mut self.blocks[p],
            None => {
                self.blocks.push(AnthBlock {
                    index,
                    kind,
                    id:    String::new(),
                    name:  String::new(),
                    args:  String::new(),
                    think: String::new(),
                    sig:   String::new(),
                    raw:   String::new(),
                });
                let last = self.blocks.len() - 1;
                &mut self.blocks[last]
            }
        }
    }

    /// Fold one SSE `data:` payload in, forwarding both kinds of delta to `on_token`.
    ///
    /// Thinking goes out as [`Delta::Reasoning`] and never as [`Delta::Text`], which is
    /// the whole of what keeps it out of the answer.  It used not to be forwarded at
    /// all, because the sink took a bare `&str` and a caller that was handed one had no
    /// way to tell working from reply -- so the reasoning was held back until the round
    /// ended.  Now the sink says which is which, so it can be shown as it arrives, and a
    /// round that thinks for a minute stops looking like a round that has hung.
    fn ingest(&mut self, data: &str, on_token: &mut impl FnMut(Delta<'_>)) {
        let ty = match extract_json_string(data, "type") {
            Some(t) => t,
            None    => return,
        };
        match ty.as_str() {
            "message_start" | "message_delta" => {
                if let Some(u) = find_json_object(data, "usage") { self.usage.merge(&u); }
                // `message_start` carries `stop_reason: null`, so only a real one sets
                // this; and once set, nothing later unsets it.
                if anthropic_truncated(data) { self.truncated = true; }
            }
            "content_block_start" => {
                let index = extract_json_number(data, "index").map(|n| n as i64).unwrap_or(0);
                let cb = match find_json_object(data, "content_block") {
                    Some(c) => c,
                    None    => return,
                };
                match extract_json_string(&cb, "type").unwrap_or_default().as_str() {
                    "text"     => { self.slot(index, AnthKind::Text); }
                    "thinking" => { self.slot(index, AnthKind::Thinking); }
                    "redacted_thinking" => {
                        let slot = self.slot(index, AnthKind::Redacted);
                        slot.kind = AnthKind::Redacted;
                        slot.raw  = cb.clone();
                    }
                    "tool_use" => {
                        let id   = extract_json_string(&cb, "id").unwrap_or_default();
                        let name = extract_json_string(&cb, "name").unwrap_or_default();
                        let slot = self.slot(index, AnthKind::ToolUse);
                        slot.kind = AnthKind::ToolUse;
                        slot.id   = id;
                        slot.name = name;
                    }
                    // A server tool, or a block type added after this was
                    // written: recorded so its deltas land somewhere harmless.
                    _ => { self.slot(index, AnthKind::Other); }
                }
            }
            "content_block_delta" => {
                let index = extract_json_number(data, "index").map(|n| n as i64).unwrap_or(0);
                let d = match find_json_object(data, "delta") {
                    Some(d) => d,
                    None    => return,
                };
                match extract_json_string(&d, "type").unwrap_or_default().as_str() {
                    "text_delta" => {
                        if let Some(t) = extract_json_string(&d, "text") {
                            if !t.is_empty() {
                                on_token(Delta::Text(&t));
                                self.content.push_str(&t);
                            }
                        }
                    }
                    "thinking_delta" => {
                        if let Some(t) = extract_json_string(&d, "thinking") {
                            if !t.is_empty() { on_token(Delta::Reasoning(&t)); }
                            self.slot(index, AnthKind::Thinking).think.push_str(&t);
                        }
                    }
                    "signature_delta" => {
                        if let Some(s) = extract_json_string(&d, "signature") {
                            self.slot(index, AnthKind::Thinking).sig.push_str(&s);
                        }
                    }
                    "input_json_delta" => {
                        if let Some(p) = extract_json_string(&d, "partial_json") {
                            self.slot(index, AnthKind::ToolUse).args.push_str(&p);
                        }
                    }
                    _ => {}
                }
            }
            "error" => {
                let e = find_json_object(data, "error").unwrap_or_default();
                self.error = Some((
                    extract_json_string(&e, "type").unwrap_or_else(|| "api_error".to_string()),
                    extract_json_string(&e, "message").unwrap_or_default()));
            }
            _ => {}
        }
    }

    /// Whether this turn has produced anything the caller now holds.
    ///
    /// Thinking does not count: it is never handed to the caller, and a retry
    /// would simply produce a fresh block rather than a duplicate one.
    fn has_output(&self) -> bool {
        !self.content.is_empty()
            || self.blocks.iter().any(|b| b.kind == AnthKind::ToolUse)
    }

    /// How much the model has said so far, thinking included; see [`StreamAcc::size`].
    ///
    /// A block opening counts, so a model that opens a thinking block and then reasons
    /// silently (its text omitted, the signature arriving last) is not mistaken for one that
    /// never started.  A `ping` and a `message_start` are not progress.
    fn size(&self) -> usize {
        self.content.len()
            + self.blocks.len()
            + self.blocks.iter()
                .map(|b| b.id.len() + b.name.len() + b.args.len() + b.think.len() + b.sig.len())
                .sum::<usize>()
    }

    /// Is a thinking block open, its signature (which closes it) not yet in?
    ///
    /// With the thinking text omitted (`display` defaults to that when the request sends no
    /// thinking), the block opens, the model thinks behind `ping` events, and the signature
    /// arrives last.  That quiet is work, not a stall.  See [`StreamWatch`].
    fn thinking_open(&self) -> bool {
        self.blocks.last().map_or(false, |b| b.kind == AnthKind::Thinking && b.sig.is_empty())
    }

    /// The signed thinking blocks of this turn, serialised for replay.
    ///
    /// Empty when any block of the run is unsigned -- a stream cut before its
    /// `signature_delta`, say.  The API requires the run to match what the model
    /// generated, so half of it is worse than none: an unsigned block is a 400,
    /// and a run with one block quietly dropped is a rearrangement.
    fn thinking_blocks(&self) -> Vec<String> {
        let mut out = Vec::new();
        for b in &self.blocks {
            match b.kind {
                AnthKind::Thinking => {
                    if b.sig.is_empty() { return Vec::new(); }
                    out.push(fmt!(
                        "{{\"type\":\"thinking\",\"thinking\":\"{}\",\"signature\":\"{}\"}}",
                        json_escape(&b.think), json_escape(&b.sig)));
                }
                AnthKind::Redacted => {
                    if b.raw.is_empty() { return Vec::new(); }
                    out.push(b.raw.clone());
                }
                _ => {}
            }
        }
        out
    }

    /// The summarised reasoning of this turn, for a caller that wants to show it.
    fn thinking_text(&self) -> String {
        let parts: Vec<&str> = self.blocks.iter()
            .filter(|b| b.kind == AnthKind::Thinking && !b.think.is_empty())
            .map(|b| b.think.as_str())
            .collect();
        parts.join("\n")
    }

    /// Consume the accumulator into a [`ChatOnceResponse`].
    fn into_response(self, aborted: bool, retries: u32) -> ChatOnceResponse {
        let thinking = self.thinking_text();
        let tool_calls = self.blocks.iter()
            .filter(|b| b.kind == AnthKind::ToolUse && !b.name.is_empty())
            .map(|b| ToolCall {
                id:        b.id.clone(),
                name:      b.name.clone(),
                arguments: if b.args.is_empty() { "{}".to_string() } else { b.args.clone() },
            })
            .collect();
        ChatOnceResponse {
            content:           self.content,
            tool_calls,
            prompt_tokens:     self.usage.into_usage().prompt,
            completion_tokens: self.usage.output,
            cached_tokens:     self.usage.read,
            cost_usd:          0.0,
            aborted,
            retries,
            thinking,
            truncated:         self.truncated,
            // Set by the caller (`stream_turn`) from the `StreamOutcome` this accumulator
            // never sees; a placeholder here so the struct is never partly built.
            stalled:           false,
            shape:             ReplyShape::Plain,
            // The Anthropic dialect carries none of these; see `ChatOnceResponse`.
            gen_id:               String::new(),
            finish_reason:        String::new(),
            native_finish_reason: String::new(),
            provider:             String::new(),
            // Set by `stream_turn` from the `StreamOutcome`; zero on a whole reply.
            bytes: 0, first_ms: 0, gap_ms: 0, ms: 0, tok_ms: 0, gen_ms: 0,
        }.classified()
    }
}


// ┌───────────────────────────────────────────────────────────────┐
// │ Acc — whichever accumulator the dialect needs                  │
// └───────────────────────────────────────────────────────────────┘

/// The stream accumulator for a [`Dialect`].
///
/// An enum rather than a trait object: there are exactly two wire shapes, both
/// known here, and the retry loop wants them by value.
enum Acc {
    OpenAi(StreamAcc),
    Anthropic(AnthropicAcc),
}

impl Acc {

    /// A fresh accumulator for `dialect`.
    fn new(dialect: Dialect) -> Self {
        match dialect {
            Dialect::OpenAi    => Self::OpenAi(StreamAcc::default()),
            Dialect::Anthropic => Self::Anthropic(AnthropicAcc::default()),
        }
    }

    /// Fold one SSE `data:` payload in, forwarding text deltas to `on_token`.
    fn ingest(&mut self, data: &str, on_token: &mut impl FnMut(Delta<'_>)) {
        match self {
            Self::OpenAi(a)    => a.ingest(data, on_token),
            Self::Anthropic(a) => a.ingest(data, on_token),
        }
    }

    /// Whether this turn has produced anything the caller now holds.
    fn has_output(&self) -> bool {
        match self {
            Self::OpenAi(a)    => a.has_output(),
            Self::Anthropic(a) => a.has_output(),
        }
    }

    /// How much the model has said so far; see [`StreamAcc::size`].
    fn size(&self) -> usize {
        match self {
            Self::OpenAi(a)    => a.size(),
            Self::Anthropic(a) => a.size(),
        }
    }

    /// Is the model reasoning and not yet answering; see [`StreamAcc::thinking_open`].
    fn thinking_open(&self) -> bool {
        match self {
            Self::OpenAi(a)    => a.thinking_open(),
            Self::Anthropic(a) => a.thinking_open(),
        }
    }

    /// The upstream provider the stream has named, or empty.  Only OpenRouter names one.
    fn provider(&self) -> &str {
        match self {
            Self::OpenAi(a)    => &a.provider,
            Self::Anthropic(_) => "",
        }
    }

    /// An error the provider delivered inside an otherwise-successful stream.
    ///
    /// Only Anthropic sends one: an OpenAI-compatible endpoint that is
    /// overloaded says so with a status code, before the body starts.
    fn stream_error(&self) -> Option<TransportErr> {
        let (kind, msg) = match self {
            Self::OpenAi(_) => return None,
            Self::Anthropic(a) => match &a.error {
                Some(e) => e.clone(),
                None    => return None,
            },
        };
        let err = err!(
            "LLM: stream error: {} | {}", kind, msg; IO, Network, Wire, Read);
        let reason = fmt!("the provider reported {}", kind);
        // The same split as the status codes: the provider's own trouble is
        // worth another attempt, a complaint about this request is not.
        let transient = kind == "overloaded_error"
            || kind == "api_error"
            || kind == "rate_limit_error";
        Some(if transient {
            TransportErr::transient(reason, err)
        } else {
            TransportErr::fatal(reason, err)
        })
    }

    /// The signed thinking blocks to hold against this turn's tool calls.
    fn take_thinking(&self) -> Vec<String> {
        match self {
            Self::OpenAi(_)    => Vec::new(),
            Self::Anthropic(a) => a.thinking_blocks(),
        }
    }

    /// Consume the accumulator into a [`ChatOnceResponse`].
    fn into_response(self, aborted: bool, retries: u32) -> ChatOnceResponse {
        match self {
            Self::OpenAi(a)    => a.into_response(aborted, retries),
            Self::Anthropic(a) => a.into_response(aborted, retries),
        }
    }
}

/// Parse a whole (non-streamed) Anthropic Messages response into
/// `(content, tool_calls, usage, thinking blocks)`.
///
/// The thinking blocks come back serialised for replay, exactly as the streamed
/// path produces them -- see [`AnthropicAcc::thinking_blocks`].
///
/// # Arguments
/// * `body` - The response body, as JSON text.
fn parse_anthropic_response(body: &str) -> (String, Vec<ToolCall>, Usage, Vec<String>) {
    let mut content = String::new();
    let mut tool_calls = Vec::new();
    let mut thinking: Vec<String> = Vec::new();
    let mut signed = true;
    if let Some(arr) = find_json_array(body, "content") {
        for elem in split_top_level_objects(&arr) {
            match extract_json_string(&elem, "type").unwrap_or_default().as_str() {
                "text" => {
                    if let Some(t) = extract_json_string(&elem, "text") { content.push_str(&t); }
                }
                "thinking" => {
                    match extract_json_string(&elem, "signature") {
                        Some(s) if !s.is_empty() => thinking.push(elem.clone()),
                        _ => signed = false,
                    }
                }
                "redacted_thinking" => thinking.push(elem.clone()),
                "tool_use" => {
                    let name = match extract_json_string(&elem, "name") {
                        Some(n) if !n.is_empty() => n,
                        _ => continue,
                    };
                    let id = extract_json_string(&elem, "id").unwrap_or_default();
                    let input = find_json_object(&elem, "input")
                        .unwrap_or_else(|| "{}".to_string());
                    tool_calls.push(ToolCall { id, name, arguments: input });
                }
                _ => {}
            }
        }
    }
    // A run with an unsigned block in it cannot be replayed; see
    // [`AnthropicAcc::thinking_blocks`].
    if !signed { thinking.clear(); }
    let mut usage = AnthUsage::default();
    if let Some(u) = find_json_object(body, "usage") { usage.merge(&u); }
    (content, tool_calls, usage.into_usage(), thinking)
}

/// Extract a JSON array value for a key, returning the inner text
/// including the surrounding brackets.  String contents are skipped so
/// brackets inside strings don't confuse the depth count.
fn find_json_array(json: &str, key: &str) -> Option<String> {
    let needle = fmt!("\"{}\":", key);
    let pos = match json.find(&needle) {
        Some(p) => p,
        None    => return None,
    };
    let bytes = json.as_bytes();
    // Skip whitespace after the colon to the opening bracket.
    let mut start = pos + needle.len();
    while start < bytes.len() && bytes[start].is_ascii_whitespace() { start += 1; }
    if start >= bytes.len() || bytes[start] != b'[' { return None; }
    let mut depth = 0i32;
    let mut in_str = false;
    let mut i = start;
    while i < bytes.len() {
        let b = bytes[i];
        if in_str {
            if b == b'\\' { i += 2; continue; }
            if b == b'"' { in_str = false; }
        } else {
            match b {
                b'"' => in_str = true,
                b'[' => depth += 1,
                b']' => {
                    depth -= 1;
                    if depth == 0 { return Some(json[start..=i].to_string()); }
                }
                _ => {}
            }
        }
        i += 1;
    }
    None
}

/// Split a JSON array's text into its top-level `{...}` object elements.
pub(crate) fn split_top_level_objects(arr: &str) -> Vec<String> {
    let bytes = arr.as_bytes();
    let mut out = Vec::new();
    let mut depth = 0i32;
    let mut start = 0usize;
    let mut in_str = false;
    let mut i = 0usize;
    while i < bytes.len() {
        let b = bytes[i];
        if in_str {
            if b == b'\\' { i += 2; continue; }
            if b == b'"' { in_str = false; }
        } else {
            match b {
                b'"' => in_str = true,
                b'{' => { if depth == 0 { start = i; } depth += 1; }
                b'}' => {
                    depth -= 1;
                    if depth == 0 { out.push(arr[start..=i].to_string()); }
                }
                _ => {}
            }
        }
        i += 1;
    }
    out
}

/// `json` with one top-level member removed, or the text unchanged where the key is not there.
///
/// For an argument object that carries a key of its OWN beside the keys it is passing on -- the
/// `compound` tool's `{"op":"read","path":…}`, where `op` chooses the primitive and everything
/// else belongs to it.  Handing the object on whole would work and then lie: a failed call is
/// answered with the unknown-key line [`crate::tools::ToolRegistry::guided`] composes, and it
/// would name `op` as a key the primitive does not know.
///
/// Textual rather than a parse-and-re-emit, like every other reader in this section: what comes
/// back is the model's own bytes with one member cut out, so a value this file has no type for
/// cannot be reshaped on the way through.
pub(crate) fn json_without_key(json: &str, key: &str) -> String {
    let bytes = json.as_bytes();
    let mut depth = 0i32;
    let mut i = 0usize;
    while i < bytes.len() {
        match bytes[i] {
            b'{' | b'[' => { depth += 1; i += 1; },
            b'}' | b']' => { depth -= 1; i += 1; },
            b'"' => {
                // The key's own text, then whether a colon follows: a string in the value
                // position is not a key, and at depth 1 the colon is what tells them apart.
                let from = i + 1;
                let mut j = from;
                while j < bytes.len() {
                    if bytes[j] == b'\\' { j += 2; continue; }
                    if bytes[j] == b'"' { break; }
                    j += 1;
                }
                let end = j.min(bytes.len());
                let mut k = end + 1;
                while k < bytes.len() && bytes[k].is_ascii_whitespace() { k += 1; }
                if depth == 1 && k < bytes.len() && bytes[k] == b':' && &json[from..end] == key {
                    let mut cut_from = i;
                    let mut cut_to   = json_value_end(json, k + 1);
                    // One comma goes with the member, or the object is left with a hole in it.
                    // The comma AFTER, where there is one; otherwise this was the last member
                    // and the comma before it is the one that has to go.
                    let mut after = cut_to;
                    while after < bytes.len() && bytes[after].is_ascii_whitespace() { after += 1; }
                    if after < bytes.len() && bytes[after] == b',' {
                        cut_to = after + 1;
                    } else {
                        while cut_from > 0 && bytes[cut_from - 1].is_ascii_whitespace() {
                            cut_from -= 1;
                        }
                        if cut_from > 0 && bytes[cut_from - 1] == b',' {
                            cut_from -= 1;
                        }
                    }
                    let mut out = String::with_capacity(json.len());
                    out.push_str(&json[..cut_from]);
                    out.push_str(&json[cut_to..]);
                    return out;
                }
                i = end + 1;
            },
            _ => i += 1,
        }
    }
    json.to_string()
}

/// The byte just past the JSON value beginning at or after `from`.
///
/// A string, an object or an array is followed to its own close; anything else -- a number,
/// `true`, `false`, `null` -- ends where the member does, at the first comma or closing bracket.
fn json_value_end(json: &str, from: usize) -> usize {
    let bytes = json.as_bytes();
    let mut i = from;
    while i < bytes.len() && bytes[i].is_ascii_whitespace() { i += 1; }
    if i >= bytes.len() {
        return i;
    }
    match bytes[i] {
        b'"' => {
            i += 1;
            while i < bytes.len() {
                if bytes[i] == b'\\' { i += 2; continue; }
                if bytes[i] == b'"'  { return i + 1; }
                i += 1;
            }
            i
        },
        b'{' | b'[' => {
            let mut depth  = 0i32;
            let mut in_str = false;
            while i < bytes.len() {
                let b = bytes[i];
                if in_str {
                    if b == b'\\' { i += 2; continue; }
                    if b == b'"'  { in_str = false; }
                } else {
                    match b {
                        b'"'        => in_str = true,
                        b'{' | b'[' => depth += 1,
                        b'}' | b']' => {
                            depth -= 1;
                            if depth == 0 { return i + 1; }
                        },
                        _ => (),
                    }
                }
                i += 1;
            }
            i
        },
        _ => {
            while i < bytes.len() && !matches!(bytes[i], b',' | b'}' | b']') { i += 1; }
            i
        },
    }
}

pub fn datmap_to_json(m: &DaticleMap) -> String {
    let mut out = String::with_capacity(256);
    out.push('{');
    let mut first = true;
    // DaticleMap iteration is not ordered — we sort keys for
    // deterministic output (not required by the API but cleaner).
    let mut entries: Vec<(&Dat, &Dat)> = m.iter().collect();
    entries.sort_by(|a, b| {
        match (a.0, b.0) {
            (Dat::Str(a_s), Dat::Str(b_s)) => a_s.cmp(b_s),
            _ => std::cmp::Ordering::Equal,
        }
    });
    for (k, v) in entries {
        if !first { out.push(','); }
        first = false;
        if let Dat::Str(k_s) = k {
            out.push('"');
            out.push_str(k_s);
            out.push_str("\":");
            out.push_str(&dat_to_json(v));
        }
    }
    out.push('}');
    out
}

/// Escape a string for embedding inside a JSON string literal (no
/// surrounding quotes).  Shared with the tool-definition builder.
pub(crate) fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '"'  => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            '\r' => out.push_str("\\r"),
            c if (c as u32) < 0x20 => out.push_str(&fmt!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

/// Convert a JDAT Dat value to JSON.
fn dat_to_json(d: &Dat) -> String {
    match d {
        Dat::Str(s) => {
            let mut out = String::with_capacity(s.len() + 2);
            out.push('"');
            for c in s.chars() {
                match c {
                    '"' => out.push_str("\\\""),
                    '\\' => out.push_str("\\\\"),
                    '\n' => out.push_str("\\n"),
                    '\t' => out.push_str("\\t"),
                    '\r' => out.push_str("\\r"),
                    c if (c as u32) < 0x20 => {
                        out.push_str(&fmt!("\\u{:04x}", c as u32));
                    }
                    c => out.push(c),
                }
            }
            out.push('"');
            out
        }
        Dat::U64(n) => fmt!("{}", n),
        Dat::Bool(b) => fmt!("{}", b),
        Dat::List(list) => {
            let items: Vec<String> = list.iter().map(dat_to_json).collect();
            fmt!("[{}]", items.join(","))
        }
        Dat::Map(m) => datmap_to_json(m),
        Dat::Empty => "null".to_string(),
        _ => "null".to_string(),
    }
}


// ┌───────────────────────────────────────────────────────────────┐
// │ Tests                                                          │
// └───────────────────────────────────────────────────────────────┘

#[cfg(test)]
#[path = "../tests/unit/llm/tests.rs"]
pub mod tests;
