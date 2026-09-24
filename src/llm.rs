//! LLM client — chat completions with SSE streaming, in two wire dialects.
//!
//! Uses `fe2o3_net` for the underlying TLS connection.  Parses the
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
use oxedyne_fe2o3_jdat::prelude::*;

use crate::protocol::{ChatMessage, ContentPart, Dropped, ImagePart, MessageContent, ToolCall};

// Native transport imports — the hand-rolled TLS client lives behind
// tokio + rustls, which do not target wasm32.
#[cfg(not(target_arch = "wasm32"))]
use std::sync::Arc;
#[cfg(not(target_arch = "wasm32"))]
use tokio::io::{AsyncReadExt, AsyncWriteExt};
#[cfg(not(target_arch = "wasm32"))]
use tokio_rustls::rustls::ClientConfig;


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
/// `Rc<Cell<..>>` on both targets, exactly as `open_folds` is: this client is
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
pub const DEFAULT_STREAM_IDLE_MS: u64 = 60_000;

/// How much longer a non-streaming reply may take to arrive than a stream's first byte.
///
/// `do_request_full` (the transport behind `chat_once`, which serves the fold summary) awaits
/// the WHOLE body in one piece, where `stream_sse` only needs the first token to arrive within
/// `stream_idle_ms`.  A non-streaming provider generates the entire answer before it sends a
/// byte, so a slow fold must not be cut at the streaming ceiling: its first-byte bound is this
/// multiple of the idle figure -- 5 x 60 s = 300 s by default, still inside the JS 540 s wall
/// clock that wraps the round.
const REPLY_WAIT_FACTOR: u64 = 5;

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

impl ProviderRouting {
    fn is_empty(&self) -> bool { self.order.is_empty() && self.ignore.is_empty() }
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

/// The `say` calls whose fold the user currently has OPEN, by tool-call id.
///
/// **THE FOLD IS THE CONTEXT CONTROL, and this is what makes that true.** A folded detail is
/// stripped from the payload, which is right when the user has closed it: they are done with it,
/// and re-sending it on every later turn buys nothing. But a fold they have OPENED is a fold they
/// are reading, and the next thing they say is likely to be about it -- so the model should be
/// holding what the user is looking at.
///
/// The user's own gesture therefore decides the model's working set, with no second control to
/// learn and no decision to make twice. What is on their screen and what is in its context are
/// the same set, which is the only arrangement where "why does it not remember that?" has an
/// answer they can see.
///
/// It is rebuilt from the page before every request rather than accumulated here, because a fold
/// can be opened and closed between two turns and the payload has to follow.
///
/// **It costs a cache miss on the turn it changes.** Opening a fold rewrites a message that was
/// already in the prefix, so everything from that point is re-read once. Stable again afterwards.
type OpenFolds = std::rc::Rc<std::cell::RefCell<OpenSet>>;

/// The call ids of the `say` folds the user has open, as [`LlmClient::open_folds`] hands them
/// over and as the sizing path in [`crate::agent::compact`] reads them.
pub type OpenSet = std::collections::HashSet<String>;

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
}

// ┌───────────────────────────────────────────────────────────────┐
// │ Halt: one turn's stop                                          │
// └───────────────────────────────────────────────────────────────┘

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
#[derive(Clone, Debug, Default)]
pub struct Halt(std::rc::Rc<HaltInner>);

#[derive(Debug, Default)]
struct HaltInner {
    set:  std::cell::Cell<bool>,
    #[cfg(target_arch = "wasm32")]
    ctrl: std::cell::RefCell<Option<web_sys::AbortController>>,    // the request in flight
}

impl Halt {

    pub fn new() -> Self { Self::default() }

    /// Stop the turn: the flag, which every later request and seam reads, and then the request
    /// in flight.
    pub fn fire(&self) {
        self.0.set.set(true);
        self.tear_down();
    }

    /// Has this turn been stopped?
    pub fn is_set(&self) -> bool { self.0.set.get() }

    /// Clear a stop, for the turn about to start on a client that ran the one before it.
    ///
    /// Only the owner of a client that runs one turn at a time calls this -- a chat's own agent,
    /// at the top of its turn -- and only before anything of the new turn has gone out.
    pub fn rearm(&self) {
        self.0.set.set(false);
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
    fn tear_down(&self) {
        #[cfg(target_arch = "wasm32")]
        {
            if let Some(ctrl) = self.0.ctrl.borrow().as_ref() {
                ctrl.abort();
            }
        }
    }

    /// Hold the controller of the request about to go out, so [`fire`](Self::fire) reaches it.
    #[cfg(target_arch = "wasm32")]
    fn arm(&self, ctrl: web_sys::AbortController) {
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
#[derive(Clone, Debug)]
pub struct LlmClient {
    pub host:       String,
    pub port:       u16,
    pub path:       String,
    pub api_key:    String,
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
    /// The `say` folds the user has open. See [`OpenFolds`].
    open_folds:     OpenFolds,
    /// What this client asks of a thinking model, from `set_tune`.  Shared
    /// across clones for the reason the carry is; see [`Tune`].
    tune:           Tune,
    /// Set once this endpoint has been caught refusing a request that carried pictures.
    /// See [`Blind`]; read by [`LlmClient::vision_guard`] and set by the strip-and-retry in
    /// [`LlmClient::stream_turn`] and [`LlmClient::chat_once`].
    blind:          Blind,
    /// How long a stream may go without a byte before it is read as stalled rather than
    /// slow; see [`stream_sse`](Self::stream_sse) and `Limits::stream_idle_ms` in
    /// `src/compact.rs`, which `Agent::set_stream_idle_ms` pushes down into this.  An
    /// `Rc<Cell<…>>` for the reason `tune` is one: shared across clones, so a sub-agent
    /// built from a cloned client carries the same figure.
    stream_idle_ms: std::rc::Rc<std::cell::Cell<u64>>,
    /// Which upstream provider OpenRouter should route this model's calls to, from a
    /// setting on the model's own row (`www/js/models.js`); see
    /// [`set_provider_routing`](Self::set_provider_routing).  `Rc<RefCell<…>>` for the
    /// reason `stream_idle_ms` is a shared cell: one client, one routing preference,
    /// wherever it is cloned.
    provider_routing: std::rc::Rc<std::cell::RefCell<ProviderRouting>>,
    /// Root-trust TLS configuration for the native transport.  The wasm
    /// transport delegates trust to the browser's `fetch`, so this field
    /// is native-only.
    #[cfg(not(target_arch = "wasm32"))]
    pub tls_config: Arc<ClientConfig>,
    // This turn's stop (see [`Halt`]): shared by a clone made inside the turn, such as the
    // fold's compactor, and replaced by `with_halt` for a clone that runs a turn of its own.
    halt:           Halt,
    /// Wasm transport URL scheme selector: `true` builds `https://…`,
    /// `false` builds `http://…`.  Defaults to `https` (all real
    /// providers are TLS-only); an `http` client targets a local mock
    /// over `127.0.0.1` for headless testing, where the browser still
    /// treats the origin as a secure context.
    #[cfg(target_arch = "wasm32")]
    pub secure: bool,
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
const ERR_BODY_BYTES: usize = 300;

/// `s` cut to at most `n` bytes, never through the middle of a character.
///
/// `&s[..n]` panics on a multi-byte boundary, and the one place this is used is an error
/// path handed arbitrary bytes from a provider -- exactly where a panic is least welcome
/// and least likely to be noticed in testing.
///
/// # Arguments
/// * `s` - The text to cut.
/// * `n` - The most bytes the result may occupy.
fn clip_bytes(s: &str, n: usize) -> &str {
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
struct TransportErr {
    retryable: bool,            // is another attempt worth making?
    after_ms:  Option<u64>,     // what the provider asked us to wait, if it said
    // A few plain words for the retry notice, and -- since 2026-08-28 -- for the
    // caller.  The error itself carries file, line and ANSI colouring, none of
    // which belongs in a user's message pane.  See [`TransportErr::crossed`].
    reason:    String,
    err:       Error<ErrTag>,
}

impl TransportErr {

    /// A failure worth another attempt: a 429, a 5xx, or a broken connection.
    fn transient(reason: String, err: Error<ErrTag>) -> Self {
        Self { retryable: true, after_ms: None, reason, err }
    }

    /// A failure that will fail again the same way: a malformed request, a bad
    /// key, an unknown model.
    fn fatal(reason: String, err: Error<ErrTag>) -> Self {
        Self { retryable: false, after_ms: None, reason, err }
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
    fn classify(reason: String, err: Error<ErrTag>) -> Self {
        if err.tags().contains(&ErrTag::Timeout) {
            Self::fatal(reason, err)
        } else {
            Self::transient(reason, err)
        }
    }

    /// Attach the provider's requested delay.
    fn after(mut self, after_ms: Option<u64>) -> Self {
        self.after_ms = after_ms;
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
    fn crossed(self) -> Error<ErrTag> {
        err!(self.err, "{}", self.reason; IO, Network, Wire)
    }
}

/// What [`LlmClient::stream_sse`] ended on, alongside whatever it already handed `on_data`.
///
/// Two different reasons a stream returns with nothing more to read, and the caller treats
/// them differently: an abort is the app's own cancellation and the leak-nudge machinery
/// never needs to know it happened; a stall is the provider's, and the turn should read
/// honestly as `stalled` rather than as an ordinary clean end.  See `DEFAULT_STREAM_IDLE_MS`.
#[derive(Clone, Copy, Debug, Default)]
struct StreamOutcome {
    /// The browser fired the abort signal (wasm only; always `false` on native).
    aborted: bool,
    /// No byte arrived for `stream_idle_ms`, and the connection was given up on.
    stalled: bool,
}

/// Whether an HTTP status is worth another attempt.
///
/// 429 is rate limiting and 5xx is the provider's own trouble; every other
/// status is about this request and will not change by being sent twice.
pub(crate) fn status_retryable(status: u16) -> bool {
    status == 429 || (500..600).contains(&status)
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
    use wasm_bindgen_futures::JsFuture;

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
    let _ = JsFuture::from(promise).await;
}

/// Whichever of two same-shaped futures becomes ready first; the other is dropped.
///
/// Hand-rolled rather than `tokio::select!` or a `futures` crate helper: `tokio` is not in
/// this target's dependency graph (the wasm build has no TCP sockets or TLS stack, so
/// nothing before this needed its executor), and pulling one in for a macro would be a
/// second async runtime contending with `wasm-bindgen-futures` for the same microtask
/// queue. A boxed, pinned trait object on each side is what lets the two callers of this
/// (one `JsFuture`, one `sleep_ms`) share a Future poll loop despite being different
/// concrete types.
#[cfg(target_arch = "wasm32")]
async fn race<T>(
    mut a: std::pin::Pin<Box<dyn std::future::Future<Output = T>>>,
    mut b: std::pin::Pin<Box<dyn std::future::Future<Output = T>>>,
)
    -> T
{
    std::future::poll_fn(move |cx| {
        if let std::task::Poll::Ready(v) = a.as_mut().poll(cx) { return std::task::Poll::Ready(v); }
        if let std::task::Poll::Ready(v) = b.as_mut().poll(cx) { return std::task::Poll::Ready(v); }
        std::task::Poll::Pending
    }).await
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
            api_key:    api_key.to_string(),
            model:      model.to_string(),
            max_tokens,
            retry:      RetryPolicy::default(),
            think:      new_carry(),
            open_folds: std::rc::Rc::new(std::cell::RefCell::new(std::collections::HashSet::new())),
            tune:       std::rc::Rc::new(std::cell::Cell::new(ThinkTune::default())),
            blind:      new_blind(),
            stream_idle_ms: std::rc::Rc::new(std::cell::Cell::new(DEFAULT_STREAM_IDLE_MS)),
            provider_routing: std::rc::Rc::new(std::cell::RefCell::new(ProviderRouting::default())),
            tls_config,
            halt:       Halt::new(),
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
            api_key:    api_key.to_string(),
            model:      model.to_string(),
            max_tokens,
            retry:      RetryPolicy::default(),
            think:      new_carry(),
            open_folds: std::rc::Rc::new(std::cell::RefCell::new(std::collections::HashSet::new())),
            tune:       std::rc::Rc::new(std::cell::Cell::new(ThinkTune::default())),
            blind:      new_blind(),
            stream_idle_ms: std::rc::Rc::new(std::cell::Cell::new(DEFAULT_STREAM_IDLE_MS)),
            provider_routing: std::rc::Rc::new(std::cell::RefCell::new(ProviderRouting::default())),
            secure,
            halt:       Halt::new(),
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
        let resp = res!(self.stream_turn(messages, None, on_token, false).await);
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
        let mut waited = 0u64;
        let mut retries = 0u32;
        loop {
            // A STOPPED TURN SENDS NOTHING MORE, asked at the top of EVERY attempt.  A Stop, a
            // pause or the 540 s wall clock in `www/js/daimond.js` may land during the backoff
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
            let outcome = {
                let mut sink = |data: &str| {
                    acc.ingest(data, &mut |d: Delta<'_>| {
                        // ONLY TEXT MAKES A TURN UNREPEATABLE. Reasoning already shown and
                        // then shown again reads as the model thinking twice, which is odd;
                        // an answer delivered twice is wrong. So a turn that has only
                        // reasoned so far is still safe to start over.
                        if matches!(d, Delta::Text(_)) { emitted = true; }
                        on_token(d);
                    });
                };
                self.stream_sse(&body, &mut sink).await
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
                Ok(StreamOutcome { aborted, stalled }) => {
                    let thinking = acc.take_thinking();
                    let mut resp = acc.into_response(aborted, retries);
                    resp.stalled = stalled;
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
                    // A REFUSED PICTURE IS NOT A DEAD TURN. The provider would not take this
                    // request and it carried images, so the likeliest reason is the one thing
                    // in it a text model cannot read. Take them out, say so in their place, and
                    // send it again -- once. Only where nothing has been emitted: a turn the
                    // user has already seen tokens from cannot be started over.
                    if !started && !retried_blind && images > 0 {
                        retried_blind = true;
                        self.mark_blind();
                        let text_only: Vec<ChatMessage> =
                            messages.iter()
                            .map(|m| m.with_content(m.content().without_images(Dropped::Unseeable)))
                            .collect();
                        body = self.build_body(&text_only, tools, true);
                        if notify {
                            on_token(Delta::Text(&fmt!(
                                "\n[daimond: the model would not take {} image{}; asking again \
                                 without {} -- it cannot see]\n",
                                images,
                                if images == 1 { "" } else { "s" },
                                if images == 1 { "it" } else { "them" })));
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
                    if !retried_blind && images > 0 {
                        retried_blind = true;
                        self.mark_blind();
                        let text_only: Vec<ChatMessage> =
                            messages.iter()
                            .map(|m| m.with_content(m.content().without_images(Dropped::Unseeable)))
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
        let (content, tool_calls, use_, thinking) = match self.dialect {
            Dialect::OpenAi    => {
                let (c, t, u) = parse_full_response(&raw);
                (c, t, u, Vec::new())
            }
            Dialect::Anthropic => parse_anthropic_response(&raw),
        };
        let thinking_text = thinking.iter()
            .filter_map(|b| extract_json_string(b, "thinking"))
            .filter(|s| !s.is_empty())
            .collect::<Vec<String>>()
            .join("\n");
        if let Some(tc) = tool_calls.first() {
            self.carry_put(&tc.id, thinking);
        }
        // Read from the whole body, in whichever dialect it came back in.
        let truncated = match self.dialect {
            Dialect::OpenAi    => openai_truncated(&raw),
            Dialect::Anthropic => anthropic_truncated(&raw),
        };
        // The four trace fields; see `ChatOnceResponse` for what each is and why. Empty on
        // the Anthropic dialect, which sends none of them.
        let (gen_id, finish_reason, native_finish_reason, provider) = match self.dialect {
            Dialect::OpenAi => {
                let head_end = raw.find("\"choices\"").unwrap_or(raw.len());
                (
                    extract_json_string(&raw[..head_end], "id").unwrap_or_default(),
                    extract_json_string(&raw, "finish_reason").unwrap_or_default(),
                    extract_json_string(&raw, "native_finish_reason").unwrap_or_default(),
                    extract_json_string(&raw[..head_end], "provider").unwrap_or_default(),
                )
            }
            Dialect::Anthropic => Default::default(),
        };
        // See the same branch in `stream_turn`: Anthropic reports no `cost` at all, so `use_`
        // above always carries zero here and the ledger is booked from the token counts instead.
        let cost_usd = if use_.cost_usd == 0.0 && matches!(self.dialect, Dialect::Anthropic) {
            anthropic_list_price_usd(&self.model, use_.prompt, use_.completion, use_.cached)
        } else {
            use_.cost_usd
        };
        Ok(ChatOnceResponse {
            content,
            tool_calls,
            prompt_tokens:     use_.prompt,
            completion_tokens: use_.completion,
            cached_tokens:     use_.cached,
            cost_usd,
            aborted:           false,
            retries,
            thinking:          thinking_text,
            truncated,
            stalled:           false,
            shape:             ReplyShape::Plain,
            gen_id,
            finish_reason,
            native_finish_reason,
            provider,
        }.classified())
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
        #[cfg(not(target_arch = "wasm32"))]
        { self.blind.load(std::sync::atomic::Ordering::Relaxed) }
        #[cfg(target_arch = "wasm32")]
        { self.blind.get() }
    }

    /// Record that it does, so no later turn pays to find out again.
    fn mark_blind(&self) {
        #[cfg(not(target_arch = "wasm32"))]
        { self.blind.store(true, std::sync::atomic::Ordering::Relaxed) }
        #[cfg(target_arch = "wasm32")]
        { self.blind.set(true) }
    }

    /// May a picture be put in front of this endpoint?
    ///
    /// Both halves of what is known, and nothing else: the deny-list [`model_can_see`] before any
    /// request has been sent, and the refusal [`is_blind`](Self::is_blind) records after one has
    /// been turned away.  There is no third source -- no `vision` flag is published by anybody --
    /// so a model released after this line was written is taken to see until it says otherwise.
    pub fn can_take_images(&self) -> bool {
        model_can_see(&self.model) && !self.is_blind()
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
        Some(messages.iter()
                            .map(|m| m.with_content(m.content().without_images(Dropped::Unseeable)))
                            .collect())
    }

    fn vision_guard(&self, messages: &[ChatMessage]) -> Outcome<usize> {
        let images: usize = messages.iter().map(|m| m.content().images().count()).sum();
        // A refusal already seen is not an error any more: the pictures come out and the turn
        // goes ahead. Refusing here instead would leave a conversation that carries one image
        // permanently unable to take a turn -- which is what happened to a real Diamond on
        // 2026-08-13, where a cover read into the daimon's history bricked every later steer.
        if images == 0 || model_can_see(&self.model) || self.is_blind() {
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
        if images == 0 {
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
    fn build_body(&self, messages: &[ChatMessage], tools: Option<&str>, stream: bool) -> String {
        match self.dialect {
            Dialect::OpenAi    => self.build_openai_body(messages, tools, stream),
            Dialect::Anthropic => self.build_anthropic_body(messages, tools, stream),
        }
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
    fn build_openai_body(&self, messages: &[ChatMessage], tools: Option<&str>, stream: bool)
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
            if !first { out.push(','); }
            first = false;
            if marks.contains(&i) {
                out.push_str(&message_to_json_cached(msg, &self.open_folds.borrow()));
            } else {
                out.push_str(&message_to_json(msg, &self.open_folds.borrow()));
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
            let routing = self.provider_routing.borrow();
            if !routing.is_empty() {
                out.push_str("\"provider\":{");
                let mut wrote = false;
                if !routing.order.is_empty() {
                    out.push_str("\"order\":[");
                    out.push_str(&routing.order.iter()
                        .map(|p| fmt!("\"{}\"", json_escape(p)))
                        .collect::<Vec<String>>().join(","));
                    out.push(']');
                    wrote = true;
                }
                if !routing.ignore.is_empty() {
                    if wrote { out.push(','); }
                    out.push_str("\"ignore\":[");
                    out.push_str(&routing.ignore.iter()
                        .map(|p| fmt!("\"{}\"", json_escape(p)))
                        .collect::<Vec<String>>().join(","));
                    out.push(']');
                    wrote = true;
                }
                if routing.only {
                    if wrote { out.push(','); }
                    out.push_str("\"allow_fallbacks\":false");
                }
                out.push_str("},");
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
    fn build_request_body(&self, messages: &[ChatMessage]) -> String {
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
                ChatMessage::User { content } => {
                    // An empty text block is rejected outright, where the
                    // OpenAI side simply carries the empty string through.
                    pending.extend(anthropic_blocks(content, marks.contains(&i)));
                }
                ChatMessage::Tool { tool_call_id, content } => {
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
                    if !pending.is_empty() {
                        msgs.push(fmt!("{{\"role\":\"user\",\"content\":[{}]}}", pending.join(",")));
                        pending.clear();
                    }
                    let mut blocks: Vec<String> = Vec::new();
                    // The reasoning that led to these tool calls, first and
                    // verbatim.  Absent for a turn that asked for nothing.
                    if let Some(tc) = tool_calls.first() {
                        blocks.extend(self.carry_get(&tc.id));
                    }
                    // Assistant turns are the model's own words; an image cannot appear in one.
                    let said = content.as_text();
                    if !said.is_empty() {
                        // The same fold strip the OpenAI side applies.  Applied at one site and
                        // not the other, the same conversation would cost different amounts
                        // through different endpoints, silently.
                        let folded = strip_folds(&said, &self.open_folds.borrow());
                        blocks.push(text_block(folded.as_deref().unwrap_or(&said), false));
                    }
                    for tc in tool_calls {
                        let stripped = strip_said(&tc.name, &tc.arguments, self.fold_open(&tc.id));
                        let raw = stripped.as_deref().unwrap_or(&tc.arguments);
                        let args = if raw.trim_start().starts_with('{') {
                            raw
                        } else {
                            "{}"
                        };
                        blocks.push(fmt!(
                            "{{\"type\":\"tool_use\",\"id\":\"{}\",\"name\":\"{}\",\"input\":{}}}",
                            json_escape(&tc.id), json_escape(&tc.name), args));
                    }
                    // An assistant turn with no content at all is not a message
                    // the API will take, and it says nothing the model needs.
                    if !blocks.is_empty() {
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
    fn auth_headers(&self, browser: bool) -> Vec<(&'static str, String)> {
        let mut out = vec![("Content-Type", "application/json".to_string())];
        match self.dialect {
            Dialect::OpenAi => {
                out.push(("Authorization", fmt!("Bearer {}", self.api_key)));
            }
            Dialect::Anthropic => {
                out.push(("x-api-key", self.api_key.clone()));
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

    /// Is this `say` call's fold open on screen?
    fn fold_open(&self, id: &str) -> bool {
        !id.is_empty() && self.open_folds.borrow().contains(id)
    }

    /// The open folds, copied out.
    ///
    /// A COPY and not a borrow: the sizing path holds this across the awaits of a fold, and the
    /// page may set the folds again at any point in between -- a `RefCell` borrow still live at
    /// that moment would panic.  The set holds one short id per fold on screen.
    pub fn open_folds(&self) -> OpenSet {
        self.open_folds.borrow().clone()
    }

    /// Replace the set of open folds, from the page, before a request goes out.
    ///
    /// REPLACED and not added to: a fold the user has since closed must leave the payload, and an
    /// accumulating set could only ever grow.
    pub fn set_open_folds(&self, ids: Vec<String>) {
        let mut f = self.open_folds.borrow_mut();
        f.clear();
        for id in ids {
            f.insert(id);
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
        -> Result<(tokio_rustls::client::TlsStream<tokio::net::TcpStream>, bool), TransportErr>
    {
        use tokio_rustls::TlsConnector;
        use tokio::net::TcpStream;

        let body_bytes = body.as_bytes();

        let mut request = String::with_capacity(512 + body_bytes.len());
        request.push_str(&fmt!("POST {} HTTP/1.1\r\n", self.path));
        request.push_str(&fmt!("Host: {}\r\n", self.host));
        for (name, value) in self.auth_headers(false) {
            request.push_str(&fmt!("{}: {}\r\n", name, value));
        }
        request.push_str(&fmt!("Content-Length: {}\r\n", body_bytes.len()));
        request.push_str("Connection: close\r\n");
        request.push_str("\r\n");

        // A connection that never came up carries no partial answer, so every
        // failure from here to the status line is worth another attempt.
        let tcp = match TcpStream::connect((self.host.as_str(), self.port)).await {
            Ok(s) => s,
            Err(e) => return Err(TransportErr::transient(fmt!("could not reach {}", self.host), err!(e,
                "LLM: TCP connect to {}:{} failed.", self.host, self.port;
                IO, Network, Init))),
        };
        let server_name = match tokio_rustls::rustls::pki_types::ServerName::try_from(self.host.clone()) {
            Ok(n) => n,
            // A name that will not parse will not parse next time either.
            Err(e) => return Err(TransportErr::fatal(fmt!("invalid server name '{}'", self.host), err!(e,
                "LLM: invalid server name '{}'.", self.host;
                IO, Network, Invalid, Input))),
        };
        let connector = TlsConnector::from(self.tls_config.clone());
        let mut stream = match connector.connect(server_name, tcp).await {
            Ok(s) => s,
            Err(e) => return Err(TransportErr::transient(fmt!("TLS handshake with {} failed", self.host), err!(e,
                "LLM: TLS handshake to {} failed.", self.host;
                IO, Network, Init))),
        };

        let mut req = Vec::with_capacity(request.as_bytes().len() + body_bytes.len());
        req.extend_from_slice(request.as_bytes());
        req.extend_from_slice(body_bytes);
        if let Err(e) = stream.write_all(&req).await {
            return Err(TransportErr::transient("could not send the request".to_string(), err!(e,
                "LLM: write request failed."; IO, Network, Wire, Write)));
        }
        if let Err(e) = stream.flush().await {
            return Err(TransportErr::transient("could not send the request".to_string(), err!(e,
                "LLM: flush failed."; IO, Network, Wire, Write)));
        }

        // Read headers byte-by-byte until \r\n\r\n.  Each read is bounded by the first-byte
        // watchdog: a provider that accepts the connection and then never sends a status line
        // is the same hang the stream watchdog catches mid-body, so it ends the attempt as a
        // transient timeout rather than blocking the round.  Per-read, so a header block that
        // dribbles in is never cut -- each byte that arrives re-arms the window.
        let idle = std::time::Duration::from_millis(wait_ms);
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
            let mut err_body = Vec::new();
            let mut chunk = [0u8; 4096];
            loop {
                match stream.read(&mut chunk).await {
                    Ok(0) => break,
                    Ok(n) => err_body.extend_from_slice(&chunk[..n]),
                    Err(_) => break,
                }
            }
            let err_msg = String::from_utf8_lossy(&err_body);
            let err = err!(
                "LLM: HTTP error: {} | {}", status_line, clip_bytes(&err_msg, ERR_BODY_BYTES);
                IO, Network, Wire, Read);
            // A 429 or a 5xx is the provider saying "not now"; a 400 is this
            // request being wrong, and sending it again only costs money.
            let reason = fmt!("the provider returned HTTP {}", status);
            return Err(if status_retryable(status) {
                let after = header_value(&headers_str, "retry-after")
                    .and_then(|v| parse_retry_after(&v));
                TransportErr::transient(reason, err).after(after)
            } else {
                TransportErr::fatal(reason, err)
            });
        }

        Ok((stream, is_chunked))
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
        let (stream, is_chunked) = match self.open(body, wait_ms).await {
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
                Ok(Ok(Some(l))) => full.push_str(&l),
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

    /// Send the HTTP request and stream the SSE response line-by-line,
    /// calling `on_data` with each `data:` payload (the JSON after the
    /// `data: ` prefix) as it arrives, stopping at `[DONE]`.  Handles
    /// both chunked and identity transfer encoding via [`LineReader`].
    ///
    /// Returns whether the stream was aborted.  The native transport has
    /// no cancellation path, so it always returns `false`; the wasm
    /// transport returns `true` when the browser fired the abort signal.
    #[cfg(not(target_arch = "wasm32"))]
    async fn stream_sse(
        &self,
        body:       &str,
        on_data:    &mut impl FnMut(&str),
    ) -> Result<StreamOutcome, TransportErr>
    {
        // Headers arrive before the first token on a streaming request, so the header wait in
        // `open` is the plain idle ceiling; the per-line watchdog below covers the body.
        let (stream, is_chunked) = match self.open(body, self.stream_idle_ms.get()).await {
            Ok(v)  => v,
            Err(e) => return Err(e),
        };
        let mut reader = LineReader::new(stream, is_chunked);
        let idle = std::time::Duration::from_millis(self.stream_idle_ms.get());
        loop {
            // THE IDLE WATCHDOG. Proposal 15, 2026-09-15: OpenRouter's own export showed a
            // round with `generation_time` 83.7 s that this app sat on for 318 s -- about
            // four minutes reading a connection the provider had already stopped writing
            // to. Bounded per line rather than per round, so an ordinary slow-but-live
            // stream is never cut: each byte that DOES arrive re-arms the timeout.
            let line = match tokio::time::timeout(idle, reader.read_line()).await {
                Ok(Ok(Some(l))) => l,
                Ok(Ok(None)) => break,
                Ok(Err(e)) if e.kind() == tokio::io::ErrorKind::UnexpectedEof => break,
                Ok(Err(e)) => return Err(TransportErr::transient("the stream broke".to_string(), err!(e,
                    "LLM: read SSE line failed."; IO, Network, Wire, Read))),
                // Whatever `on_data` already delivered this round is kept -- the round
                // ends `stalled` rather than erroring, so a reply that reasoned and got
                // this far still reaches the nudge path instead of being thrown away and
                // the whole request sent again.
                Err(_elapsed) => return Ok(StreamOutcome { aborted: false, stalled: true }),
            };
            let line = line.trim();
            if !line.starts_with("data: ") {
                continue;
            }
            let data = &line[6..];
            if data == "[DONE]" {
                break;
            }
            on_data(data);
        }
        Ok(StreamOutcome::default())
    }
}


// ┌───────────────────────────────────────────────────────────────┐
// │ Wasm transport — browser `fetch` + `ReadableStream`            │
// └───────────────────────────────────────────────────────────────┘
//
// The wasm build has no TCP sockets or TLS stack; the browser owns
// both.  These methods mirror the native transport's private contract
// (`do_request_full` / `stream_sse`) using `fetch`, so the
// `chat_stream` / `chat_stream_tools` / `chat_once` API above is
// target-agnostic.

#[cfg(target_arch = "wasm32")]
impl LlmClient {

    /// The absolute request URL for the browser transport.
    ///
    /// The scheme follows [`secure`](Self::secure); the port is elided
    /// only when it is the scheme's default (443 for `https`, 80 for
    /// `http`), so a mock on a custom port is addressed explicitly.
    fn wasm_url(&self) -> String {
        let (scheme, default_port) = if self.secure { ("https", 443u16) } else { ("http", 80u16) };
        if self.port == default_port {
            fmt!("{}://{}{}", scheme, self.host, self.path)
        } else {
            fmt!("{}://{}:{}{}", scheme, self.host, self.port, self.path)
        }
    }

    /// Issue a lightweight transport probe and return the raw HTTP
    /// status the provider replies with.
    ///
    /// Unlike [`wasm_fetch`](Self::wasm_fetch), a non-2xx status is *not*
    /// treated as an error — the status number is the whole point.  A
    /// `401` from a real provider with a dummy key proves the full
    /// `fetch` + CORS + transport path end-to-end without a valid key.
    pub async fn probe_status(&self) -> Outcome<u16> {
        let messages = [crate::protocol::ChatMessage::User {
            content: MessageContent::text("ping"),
        }];
        let body = self.build_body(&messages, None, false);
        let resp = res!(self.wasm_fetch_raw(&body, self.stream_idle_ms.get()).await);
        Ok(resp.status())
    }

    /// POST `body` via `fetch`, retrying a transient failure with bounded
    /// backoff, and await the `Response`.
    ///
    /// Nothing has reached the caller at this point, so a dropped `fetch`, a 429
    /// or a 5xx is simply tried again; every other non-2xx is this request being
    /// wrong and is returned as-is.  `waited` is the shared backoff budget; see
    /// the native [`open`](LlmClient::open).
    ///
    /// A refusal carries the provider's OWN WORDS, as the native transport has always
    /// done.  Without them the browser could say no more than
    /// `LLM: HTTP error: 400 Bad Request.`, which tells the user nothing they can act on
    /// and tells [`compact::looks_like_overflow`](crate::agent::compact::looks_like_overflow)
    /// nothing at all -- so a request refused for being too long and one refused for
    /// being wrong had to be told apart by size alone.  Both dialects are covered,
    /// because it is the raw body that is carried and neither is parsed.
    async fn wasm_fetch(&self, body: &str, wait_ms: u64) -> Result<web_sys::Response, TransportErr> {
        let resp = match self.wasm_fetch_raw(body, wait_ms).await {
            Ok(r) => r,
            // The first-byte watchdog fired: the provider accepted the connection and then
            // never answered.  Checked BEFORE `halted` -- abort-first would read
            // this as a user cancel and mislabel a stall as a Stop -- and the tear-down is
            // fired HERE (as the stream idle watchdog does) so a dropped future does not
            // leave the `fetch` running.  TERMINAL, not transient: a stall is not fixed by
            // retrying it, so `classify` ends the round rather than re-entering the ladder.
            Err(e) if e.tags().contains(&ErrTag::Timeout) => {
                self.halt.tear_down();
                return Err(TransportErr::classify(
                    "no response from the provider".to_string(), e));
            }
            // A rejected `fetch` is a network or CORS failure; an armed abort is
            // the caller cancelling, and must not be retried.
            Err(e) => return Err(if self.halted() {
                TransportErr::fatal("the turn was cancelled".to_string(), e)
            } else {
                TransportErr::transient("could not reach the provider".to_string(), e)
            }),
        };
        if !resp.ok() {
            let status = resp.status();
            let status_text = resp.status_text();
            // Read BEFORE the body: consuming the stream cannot then cost the retry its
            // requested delay, and a `Retry-After` is the one thing on a 429 worth more
            // than the message.
            let after = if status_retryable(status) {
                resp.headers().get("retry-after").ok().flatten()
                    .and_then(|v| parse_retry_after(&v))
            } else {
                None
            };
            let detail = self.body_detail(&resp, wait_ms).await;
            let err = err!(
                "LLM: HTTP error: {} {} | {}", status, status_text, detail;
                IO, Network, Wire, Read);
            let reason = fmt!("the provider returned HTTP {}", status);
            return Err(if status_retryable(status) {
                TransportErr::transient(reason, err).after(after)
            } else {
                TransportErr::fatal(reason, err)
            });
        }
        Ok(resp)
    }

    /// The first [`ERR_BODY_BYTES`] of a refusal's body, or nothing when it cannot be read.
    ///
    /// Consumes the response, which is why it is called only on the failing path.  A body
    /// that will not resolve -- an abort landing between the headers and the text, a
    /// provider that sent none -- yields an empty string rather than turning a refusal
    /// with a known status into a failure of a different kind.
    ///
    /// # Arguments
    /// * `resp` - The non-2xx response, whose body is read to exhaustion.
    async fn body_detail(&self, resp: &web_sys::Response, wait_ms: u64) -> String {
        use wasm_bindgen::JsValue;
        use wasm_bindgen_futures::JsFuture;

        let text = match resp.text() {
            // Race the body against the same idle ceiling: a refusal whose body will not
            // resolve resolves to nothing rather than hanging the error path itself.
            Ok(p) => {
                enum Raced { Done(Result<JsValue, JsValue>), Idle }
                let raced = race(
                    Box::pin(async move { Raced::Done(JsFuture::from(p).await) }),
                    Box::pin(async move { sleep_ms(wait_ms).await; Raced::Idle }),
                ).await;
                match raced {
                    Raced::Done(Ok(v)) => v.as_string().unwrap_or_default(),
                    Raced::Idle | Raced::Done(Err(_)) => String::new(),
                }
            }
            Err(_) => String::new(),
        };
        clip_bytes(&text, ERR_BODY_BYTES).to_string()
    }

    /// POST `body` via `fetch` and await the `Response` without checking
    /// the status, mapping any JS error into an `Outcome`.  TLS trust is
    /// the browser's.  Callers that need a 2xx guarantee go through
    /// [`wasm_fetch`](Self::wasm_fetch).
    async fn wasm_fetch_raw(&self, body: &str, wait_ms: u64) -> Outcome<web_sys::Response> {
        use wasm_bindgen::JsCast;
        use wasm_bindgen::JsValue;
        use wasm_bindgen_futures::JsFuture;
        use web_sys::{Headers, Request, RequestInit, RequestMode, Response};

        let headers = res!(Headers::new()
            .map_err(|e| err!("LLM: create headers failed: {}.", js_str(&e); IO, Network, Init)));
        // `true`: this is the browser transport, so an Anthropic endpoint also
        // gets the header that makes its edge answer a cross-origin request.
        for (name, value) in self.auth_headers(true) {
            res!(headers.append(name, &value)
                .map_err(|e| err!("LLM: set header {} failed: {}.", name, js_str(&e);
                    IO, Network, Init)));
        }

        let opts = RequestInit::new();
        opts.set_method("POST");
        opts.set_mode(RequestMode::Cors);
        opts.set_headers(&headers);
        opts.set_body(&JsValue::from_str(body));

        // Install a fresh abort controller for this request and wire its
        // signal in, so `abort` can cancel the in-flight fetch/stream.  A
        // controller that fails to construct simply leaves the request
        // uncancellable rather than failing the turn.
        if let Ok(ctrl) = web_sys::AbortController::new() {
            opts.set_signal(Some(&ctrl.signal()));
            self.halt.arm(ctrl);
        }

        let url = self.wasm_url();
        let request = res!(Request::new_with_str_and_init(&url, &opts)
            .map_err(|e| err!("LLM: build request failed: {}.", js_str(&e); IO, Network, Init)));

        // `fetch` lives on the window in a document context and on the
        // global scope in a worker; support both.
        let promise = if let Some(win) = web_sys::window() {
            win.fetch_with_request(&request)
        } else {
            let scope = res!(js_sys::global()
                .dyn_into::<web_sys::WorkerGlobalScope>()
                .map_err(|_| err!(
                    "LLM: no window or worker scope for fetch."; IO, Network, Init)));
            scope.fetch_with_request(&request)
        };

        // Bound the wait for the response the same way `stream_sse` bounds the wait for a
        // stream chunk: race the `fetch` against `sleep_ms`, so a provider that accepts the
        // connection and then never answers ends the attempt instead of hanging.  No
        // `self.abort()` here -- that is the caller's to fire once it has classified the
        // timeout (see `wasm_fetch`), so this layer stays a plain "did it arrive?".
        enum Raced { Done(Result<JsValue, JsValue>), Idle }
        let raced = race(
            Box::pin(async move { Raced::Done(JsFuture::from(promise).await) }),
            Box::pin(async move { sleep_ms(wait_ms).await; Raced::Idle }),
        ).await;
        let resp_val = match raced {
            Raced::Idle         => return Err(err!(
                "LLM: no response within {} ms.", wait_ms; IO, Network, Timeout)),
            Raced::Done(Ok(v))  => v,
            Raced::Done(Err(e)) => return Err(err!(
                "LLM: fetch failed: {}.", js_str(&e); IO, Network, Wire)),
        };
        let resp: Response = res!(resp_val.dyn_into()
            .map_err(|_| err!("LLM: fetch did not return a Response."; IO, Network, Wire)));
        Ok(resp)
    }

    /// Non-streaming request — await the full response body as text.
    async fn do_request_full(&self, body: &str) -> Result<String, TransportErr> {
        use wasm_bindgen::JsValue;
        use wasm_bindgen_futures::JsFuture;

        // The whole reply arrives in one body here (`chat_once` -> the fold summary), and a
        // non-streaming provider generates the answer before sending a byte, so this path gets
        // the wider first-byte ceiling; see `REPLY_WAIT_FACTOR`.
        let wait_ms = self.stream_idle_ms.get().saturating_mul(REPLY_WAIT_FACTOR);
        let resp = match self.wasm_fetch(body, wait_ms).await {
            Ok(r)  => r,
            Err(e) => return Err(e),
        };
        let text_promise = match resp.text() {
            Ok(p)  => p,
            Err(e) => return Err(TransportErr::transient("the reply was cut short".to_string(), err!(
                "LLM: read response text failed: {}.", js_str(&e); IO, Network, Wire, Read))),
        };
        // Bound the body wait as well: headers can arrive before a slow generation finishes,
        // so a body that never resolves must end the attempt rather than hang it.
        enum Raced { Done(Result<JsValue, JsValue>), Idle }
        let raced = race(
            Box::pin(async move { Raced::Done(JsFuture::from(text_promise).await) }),
            Box::pin(async move { sleep_ms(wait_ms).await; Raced::Idle }),
        ).await;
        let text_val = match raced {
            Raced::Idle => {
                // The body never resolved.  Read the abort flag BEFORE tearing the fetch down
                // (which itself fires the signal): if a Stop or the 540 s wall clock already
                // landed, this is a cancel; otherwise it is a first-byte-class stall.  Either
                // way TERMINAL -- `classify` on the timeout tag, and an abort is never
                // retryable -- so the body wait no longer re-enters the ladder (was the hole
                // that retried an abort landing between the headers and the text).
                let cancelled = self.halted();
                self.halt.tear_down();
                return Err(if cancelled {
                    TransportErr::fatal("the turn was cancelled".to_string(), err!(
                        "LLM: aborted awaiting the response body."; IO, Network))
                } else {
                    TransportErr::classify("the reply was cut short".to_string(), err!(
                        "LLM: no response body within {} ms.", wait_ms; IO, Network, Timeout))
                });
            }
            Raced::Done(Ok(v))  => v,
            Raced::Done(Err(e)) => return Err(TransportErr::transient("the reply was cut short".to_string(), err!(
                "LLM: await response text failed: {}.", js_str(&e); IO, Network, Wire, Read))),
        };
        Ok(text_val.as_string().unwrap_or_default())
    }

    /// Streaming request — read the SSE body incrementally from the
    /// response's `ReadableStream`, calling `on_data` with each `data:`
    /// payload as it arrives, stopping at `[DONE]`.
    ///
    /// Returns whether the browser fired the abort signal.  When the
    /// initial `fetch` or a stream read rejects, an armed abort is
    /// distinguished from a genuine transport failure: an abort resolves
    /// to `Ok(true)` (the caller keeps whatever streamed and ends the
    /// turn cleanly), any other rejection is a real error.
    async fn stream_sse(
        &self,
        body:       &str,
        on_data:    &mut impl FnMut(&str),
    ) -> Result<StreamOutcome, TransportErr>
    {
        use wasm_bindgen::JsValue;
        use wasm_bindgen_futures::JsFuture;
        use web_sys::{ReadableStream, ReadableStreamDefaultReader};

        // Headers arrive before the first token on a streaming request, so the first-byte
        // wait is the plain idle ceiling; the per-chunk watchdog below covers the rest.
        let resp = match self.wasm_fetch(body, self.stream_idle_ms.get()).await {
            Ok(r) => r,
            Err(e) => {
                if self.halted() {
                    return Ok(StreamOutcome { aborted: true, stalled: false });
                }
                return Err(e);
            }
        };
        let stream: ReadableStream = match resp.body() {
            Some(s) => s,
            None => return Err(TransportErr::transient("the reply carried no stream".to_string(), err!(
                "LLM: response has no body stream."; IO, Network, Wire, Read))),
        };
        let reader = match ReadableStreamDefaultReader::new(&stream) {
            Ok(r)  => r,
            Err(e) => return Err(TransportErr::fatal("the stream could not be read".to_string(), err!(
                "LLM: acquire stream reader failed: {}.", js_str(&e); IO, Network, Wire, Read))),
        };

        // Accumulate raw bytes and extract complete SSE lines as they
        // arrive, mirroring the native `LineReader` line discipline.
        let mut buf: Vec<u8> = Vec::with_capacity(8192);

        loop {
            // THE IDLE WATCHDOG, raced against the read rather than wrapped around it, so a
            // chunk that DOES arrive re-arms the timeout for the next one; see the same
            // note on the native `stream_sse`. `sleep_ms` is the browser `setTimeout` this
            // client already uses for retry backoff, so no new timer mechanism is added.
            // `race` (below) rather than `tokio::select!`: `tokio` is not in this target's
            // dependency graph at all -- the wasm build has no TCP sockets or TLS stack, and
            // pulling in tokio's executor for one macro would be a second async runtime
            // fighting `wasm-bindgen-futures` for the same microtask queue.
            enum Raced { Data(Result<JsValue, JsValue>), Idle }
            // A cloned HANDLE, not a second reader: `ReadableStreamDefaultReader` is a thin
            // wasm-bindgen wrapper around one JS object, so cloning it is what lets the read
            // future OWN a reference to it (required for the `'static` bound `race` needs)
            // while `reader` itself is still there to read from on the next loop iteration.
            let reader_handle = reader.clone();
            let idle_ms = self.stream_idle_ms.get();
            let raced = race(
                Box::pin(async move { Raced::Data(JsFuture::from(reader_handle.read()).await) }),
                Box::pin(async move { sleep_ms(idle_ms).await; Raced::Idle }),
            ).await;
            let result = match raced {
                Raced::Idle => {
                    // Tear the `fetch` down, as a Stop would, but leave the turn's halt alone: a
                    // stall is not a Stop.  Nothing else tears down a `fetch` this client has
                    // stopped reading from, and a dropped `JsFuture` does not reach the
                    // connection at all.
                    self.halt.tear_down();
                    return Ok(StreamOutcome { aborted: false, stalled: true });
                }
                Raced::Data(Ok(r)) => r,
                Raced::Data(Err(e)) => {
                    if self.halted() {
                        return Ok(StreamOutcome { aborted: true, stalled: false });
                    }
                    // A stream that broke mid-flight; whether it is safe to try
                    // again is the caller's judgement, not this layer's.
                    return Err(TransportErr::transient("the stream broke".to_string(), err!(
                        "LLM: read stream chunk failed: {}.", js_str(&e);
                        IO, Network, Wire, Read)));
                }
            };
            let done = match js_sys::Reflect::get(&result, &JsValue::from_str("done")) {
                Ok(v)  => v.as_bool().unwrap_or(true),
                Err(e) => return Err(TransportErr::fatal("the stream was malformed".to_string(), err!(
                    "LLM: read 'done' failed: {}.", js_str(&e); IO, Network, Wire, Read))),
            };
            if done {
                break;
            }
            let value = match js_sys::Reflect::get(&result, &JsValue::from_str("value")) {
                Ok(v)  => v,
                Err(e) => return Err(TransportErr::fatal("the stream was malformed".to_string(), err!(
                    "LLM: read 'value' failed: {}.", js_str(&e); IO, Network, Wire, Read))),
            };
            let chunk = js_sys::Uint8Array::new(&value).to_vec();
            buf.extend_from_slice(&chunk);

            // Drain complete lines (terminated by `\n`) from the buffer.
            loop {
                let nl = match buf.iter().position(|&b| b == b'\n') {
                    Some(p) => p,
                    None    => break,
                };
                let line_bytes: Vec<u8> = buf.drain(..=nl).collect();
                let line = String::from_utf8_lossy(&line_bytes[..line_bytes.len() - 1]);
                let line = line.trim();
                if !line.starts_with("data: ") {
                    continue;
                }
                let data = &line[6..];
                if data == "[DONE]" {
                    return Ok(StreamOutcome::default());
                }
                on_data(data);
            }
        }

        Ok(StreamOutcome::default())
    }
}

// ┌───────────────────────────────────────────────────────────────┐
// │ Stopping a turn                                                │
// └───────────────────────────────────────────────────────────────┘

impl LlmClient {

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

/// Render a JS error value as a human-readable string for error tags.
#[cfg(target_arch = "wasm32")]
fn js_str(v: &wasm_bindgen::JsValue) -> String {
    v.as_string().unwrap_or_else(|| fmt!("{:?}", v))
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
struct LineReader<S: tokio::io::AsyncRead + Unpin> {
    stream:     S,
    buf:        Vec<u8>,
    buf_pos:    usize,
    is_chunked: bool,
    // For chunked encoding: remaining bytes in the current chunk.
    // None means we need to read the next chunk header.
    chunk_remaining: Option<usize>,
    eof:        bool,
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
fn message_to_json_cached(msg: &ChatMessage, open: &std::collections::HashSet<String>) -> String {
    // A `tool` message carries its own id ahead of the content this function marks, so it is
    // built here rather than falling in with `system`/`user` below -- both of which pass a
    // caller-supplied `content` straight through and have nowhere to put one.
    //
    // Only ever reached for a Claude model (`cache_breakpoints` gates on
    // `model_caches_on_request`), so this is the same marker OpenRouter already passes through
    // for the system and user breakpoints above, now reaching the tool result that `run_tool_loop`
    // actually tails off in -- see the note on `LlmClient::cache_breakpoints`.
    if let ChatMessage::Tool { tool_call_id, content } = msg {
        return fmt!(
            "{{\"role\":\"tool\",\"tool_call_id\":\"{}\",\"content\":[{{\"type\":\"text\",\
             \"text\":\"{}\",\"cache_control\":{{\"type\":\"ephemeral\"}}}}]}}",
            json_escape(tool_call_id), json_escape(&content.as_text()));
    }
    let (role, content) = match msg {
        ChatMessage::System { content } => ("system", content),
        ChatMessage::User { content }   => ("user", content),
        _ => return message_to_json(msg, open),
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

/// The arguments a `say` call is REPLAYED with, or `None` for every other tool.
///
/// **`say` was a tool and is not one any more.**  Folding is written into the model's own prose as
/// a `<details>` element now -- see [`sent_text_len`] -- and no model is offered `say` or can call
/// it.  This stays because STORED CONVERSATIONS still carry `say` tool_calls: every one of them
/// travels on every request for the life of that conversation, so a stripper deleted here is not a
/// tidying, it is every old folded answer going out in full again, on exactly the conversations
/// the feature existed to make cheap.
///
/// `say` answered at two depths: a summary the user read at once and a detail behind a fold. The
/// detail is for a person, once. Left in the transcript it would be re-sent on every later request
/// for the life of the conversation -- so a model that explained at length would charge for that
/// explanation again on every turn, whether or not anybody looked at it twice.
///
/// So the wire carries the summary and a note in the detail's place. Nothing is lost: the browser
/// keeps the whole call in its own transcript record, which is what the fold opens and what
/// survives a reload. The local record and the payload simply stop being the same thing.
///
/// ONE FUNCTION FOR BOTH DIALECTS. The OpenAI body escapes these arguments into a string and the
/// Anthropic body embeds them as JSON, so the two sites look nothing alike -- and a rule applied at
/// one and not the other would mean the same conversation cost different amounts through different
/// endpoints, silently.
///
/// It costs ONE cache miss, at the request after the call: the prefix changes once where the
/// arguments shrink, and is stable from then on.
///
/// # Arguments
/// * `name` - The tool the call names.
/// * `arguments` - Its arguments, as the model wrote them.
fn strip_said(name: &str, arguments: &str, open: bool) -> Option<String> {
    if name != "say" {
        return None;
    }
    // OPEN MEANS THE USER IS READING IT, so the model holds it too. Their own gesture decides the
    // working set, and the two things that ought to agree -- what is on their screen and what it
    // knows -- do.
    if open {
        return None;
    }
    // A call whose summary cannot be read is left alone. It is malformed, and rewriting a
    // malformed call would replace one problem the model can see with one it cannot.
    let summary = extract_json_string(arguments, "summary")?;
    let n = extract_json_string(arguments, "detail")
        .map(|d| d.chars().count())
        .unwrap_or(0);
    Some(fmt!(
        "{{\"summary\":\"{}\",\"detail\":\"{}\"}}",
        json_escape(&summary),
        json_escape(&fmt!(
            "[folded to the user, {} characters. They have it on screen; you no longer carry it. \
             Ask them, or read the file you wrote it from, if you need it again.]", n))))
}

/// How many bytes of `arguments` this call will actually put on the wire.
///
/// **The compaction trigger's half of [`strip_said`], and it calls that function rather than
/// restating its rule.**  [`crate::agent::compact::msg_bytes`] sized a `say` with the length the
/// model wrote, so the trigger measured a conversation nobody was going to send: every closed
/// fold in it was counted at full length, the budget was spent on bytes that leave at
/// serialisation, and a conversation was folded earlier than it needed to be.  The
/// [`Gauge`](crate::agent::compact::Gauge) absorbed part of the error by recalibrating tokens-per-byte against the provider's real
/// `prompt_tokens` -- but that ratio is one number for the whole conversation, so the correction
/// was paid for by every other message's estimate.
///
/// Whether the detail travels depends on the fold state, which is why `open` is asked for here
/// and not decided here: an OPEN fold is one the user is reading and its detail goes out in full.
///
/// # Arguments
/// * `name` - The tool the call names.
/// * `arguments` - Its arguments, as the model wrote them.
/// * `open` - Whether this call's fold is open on screen.
pub fn sent_args_len(name: &str, arguments: &str, open: bool) -> usize {
    match strip_said(name, arguments, open) {
        Some(replayed) => replayed.len(),
        None           => arguments.len(),
    }
}


// ┌───────────────────────────────────────────────────────────────┐
// │ The two-depth answer, written inline                           │
// └───────────────────────────────────────────────────────────────┘
//
// `say` answered at two depths through a tool call.  The model now writes the same two depths
// into its own prose as a `<details>` element, and this is the reading half of it: the same
// economy applied to text rather than to tool arguments.  `strip_said` above stays exactly as it
// is -- stored conversations carry `say` tool_logs, and a reader deleted is an answer that
// renders as nothing.  The shared shape is pinned in `dev/CONTRACT_FOLD.md`; the fixture both
// languages are tested against is `dev/fixtures/fold_keys.json`.

/// The note a stripped fold leaves in place of its body.
///
/// [`strip_said`]'s wording, near enough, so the two paths read alike to a model that may hold
/// both in one conversation.  The exact string is pinned by the fixture.
///
/// # Arguments
/// * `n` - Characters of the fold's trimmed body, as the user still has it on screen.
fn fold_note(n: usize) -> String {
    fmt!("[folded to the user, {} characters. They have it on screen; you no longer carry it. \
          Ask them if you need it again.]", n)
}

/// One `<details>` fold found in one assistant message's text.
///
/// Byte offsets rather than copied strings, so the strip rewrites in place and every character
/// outside the body stays exactly where the model put it -- including the blank lines the
/// renderer needs, which a reconstructed element would have to get right a second time.
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
/// **This is the single most likely source of a wrong strip.**  A `<details>` inside a fence is
/// literal text the model is SHOWING the user -- the markup itself, quoted.  It is not a fold, it
/// takes no ordinal, and rewriting it would edit the example out from under the person reading
/// it.  The renderer is already safe there because `marked` escapes it; nothing but this function
/// makes the stripper safe.
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
/// once and everything downstream -- the strip, the compactor, a reload of the thread a year
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
/// in a fence is quoted markup.  A `<details>` with no `<summary>` has no label, so it has no key
/// and could not be matched against the open set anyway.  A `<details>` NESTED inside another is
/// carried away by its parent's strip, so a key of its own would name a body that no longer
/// exists.  A `<details>` with no `</details>` is a fold still being written: it keys, because the
/// ordinal it takes is settled the moment its summary is, but it is left alone by the strip --
/// see [`strip_folds`].
///
/// **Elements are paired by DEPTH, not by the first closing tag that turns up.**  The browser's
/// parser nests correctly, so a scanner that closed an outer fold at its child's `</details>`
/// would disagree with the renderer about where the fold ENDS -- and then replace the wrong span
/// of text, cutting the body short and leaving the remainder of the element dangling in the
/// payload.  Measured: the shared fixture's nested case gives a 48-character body under
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
        // still travels, which costs tokens.  Keying it instead would strip a fold whose open
        // state the page never tracked, and lose the reader's gesture rather than some money.
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

/// The text an assistant message is REPLAYED with, or `None` when nothing in it changes.
///
/// The text sibling of [`strip_said`], and it exists for the same reason: a fold's body is for a
/// person, once.  Left in the transcript it is re-sent on every later request for the life of the
/// conversation, so a model that explains at length charges for the explanation again on every
/// turn whether or not anybody looked at it twice.
///
/// **The element is kept and only the body is replaced.**  A model that sees the fold it wrote
/// still knows it folded something and what it called it, which a wholesale deletion would take
/// away along with the bytes.
///
/// Two folds are passed over.  An OPEN one is on the user's screen, so the model holds it too --
/// their own gesture decides the working set.  An UNCLOSED one is malformed, and [`strip_said`]'s
/// rule applies: rewriting it replaces a problem the model can see with one it cannot.
///
/// # Arguments
/// * `text` - The assistant's own words, as the model wrote them.
/// * `open` - The keys of the folds the user has open. See [`Fold::key`].
fn strip_folds(text: &str, open: &OpenSet) -> Option<String> {
    let found = folds(text);
    if found.is_empty() {
        return None;
    }
    let mut out = String::with_capacity(text.len());
    let mut at = 0usize;
    for f in &found {
        if !f.closed || open.contains(&f.key()) {
            continue;
        }
        // An empty body would be REPLACED by a hundred characters of note, so the one case where
        // stripping costs tokens rather than saving them is not stripped.
        if f.chars == 0 {
            continue;
        }
        out.push_str(&text[at..f.body.start]);
        out.push_str(&fold_note(f.chars));
        at = f.body.end;
    }
    if at == 0 {
        return None;
    }
    out.push_str(&text[at..]);
    Some(out)
}

/// How many bytes of an assistant message's text will actually go on the wire.
///
/// The sibling of [`sent_args_len`] for the inline fold, and it exists for the same defect: the
/// compaction trigger in [`crate::agent::compact::msg_bytes`] sized a message by what the model
/// wrote, while serialisation takes every closed fold's body out.  So the trigger measured a
/// conversation nobody was going to send, spent the budget on bytes that leave on the way out,
/// and folded a conversation earlier than it needed to.  Asked here rather than restated there,
/// because a rule written twice is a rule that eventually disagrees with itself.
///
/// # Arguments
/// * `text` - The assistant's own words.
/// * `open` - The keys of the folds the user has open.
pub fn sent_text_len(text: &str, open: &OpenSet) -> usize {
    match strip_folds(text, open) {
        Some(replayed) => replayed.len(),
        None           => text.len(),
    }
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
/// # Arguments
/// * `msg` - The message to serialise.
/// * `open` - The `say` folds the user has open, whose detail therefore travels. See
///   [`OpenFolds`].
fn message_to_json(msg: &ChatMessage, open: &std::collections::HashSet<String>) -> String {
    match msg {
        ChatMessage::System { content } =>
            fmt!("{{\"role\":\"system\",\"content\":\"{}\"}}", json_escape(&content.as_text())),
        ChatMessage::User { content } =>
            fmt!("{{\"role\":\"user\",\"content\":{}}}", openai_content(content)),
        ChatMessage::Assistant { content, tool_calls } => {
            // The assistant's own words are the one role's text that serialisation rewrites: a
            // closed `<details>` fold travels as a note in its body's place.  Both branches below
            // read this, so neither can be given the fold and the other the raw text.
            let said = content.as_text();
            let folded = strip_folds(&said, open);
            let text = json_escape(folded.as_deref().unwrap_or(&said));
            if tool_calls.is_empty() {
                fmt!("{{\"role\":\"assistant\",\"content\":\"{}\"}}", text)
            } else {
                let calls: Vec<String> = tool_calls.iter().map(|tc| {
                    let stripped = strip_said(&tc.name, &tc.arguments, open.contains(&tc.id));
                    let args = stripped.as_deref().unwrap_or(&tc.arguments);
                    fmt!(
                    "{{\"id\":\"{}\",\"type\":\"function\",\"function\":{{\"name\":\"{}\",\"arguments\":\"{}\"}}}}",
                    json_escape(&tc.id), json_escape(&tc.name), json_escape(args))
                }).collect();
                fmt!("{{\"role\":\"assistant\",\"content\":\"{}\",\"tool_calls\":[{}]}}",
                    text, calls.join(","))
            }
        }
        ChatMessage::Tool { tool_call_id, content } =>
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

/// Parse a non-streaming chat completion body into
/// `(content, tool_calls, usage)`.
fn parse_full_response(body: &str) -> (String, Vec<ToolCall>, Usage) {
    // Scope content extraction to before "tool_calls" so we don't pick
    // up a "content" key inside a tool call's arguments.
    let scope_end = body.find("\"tool_calls\"").unwrap_or(body.len());
    let content = extract_json_string(&body[..scope_end], "content").unwrap_or_default();

    let mut tool_calls = Vec::new();
    if let Some(arr) = find_json_array(body, "tool_calls") {
        for elem in split_top_level_objects(&arr) {
            let name = match extract_json_string(&elem, "name") {
                Some(n) if !n.is_empty() => n,
                _ => continue,
            };
            let id = extract_json_string(&elem, "id").unwrap_or_default();
            let arguments = extract_json_string(&elem, "arguments")
                .unwrap_or_else(|| "{}".to_string());
            tool_calls.push(ToolCall { id, name, arguments });
        }
    }

    (content, tool_calls, parse_usage(body).unwrap_or_default())
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
        // `reasoning_details` is NOT read. OpenRouter sends it alongside `reasoning` with
        // the same words in it, verbatim, so a reader that took both would put every
        // token on the page twice.
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

        // Tool-call fragments — merge each into its slot by `index`.
        if let Some(arr) = find_json_array(data, "tool_calls") {
            for elem in split_top_level_objects(&arr) {
                let index = extract_json_number(&elem, "index")
                    .map(|n| n as i64)
                    .unwrap_or(0);
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
pub mod tests {
    use super::*;

    use crate::protocol::ImageMedia;

    // ── A tool call that arrived as prose ───────────────────────────────────
    //
    // Every string below is the wire, verbatim, off turn 56 of 2026-09-14 (glm-5.3 through
    // OpenRouter, build 1f8ca7ce44f0). Typing a plausible-looking fragment instead is how a
    // reader ends up testing the shape it expected rather than the shape that arrives.

    /// What actually reached the page: the head `<tool_call>verify<arg_key>` consumed
    /// upstream, so the reply opens on an argument name with no call around it.
    pub const LEAK_HEADLESS: &str = "name</arg_key><arg_value>daimonfold</arg_value>\
        <arg_key>timeout_ms</arg_key><arg_value>600000</arg_value>\
        <arg_key>world</arg_key><arg_value>true</arg_value></tool_call>";

    /// The same call with its head intact, which is what the provider was sent and what a
    /// recovery has to be able to rebuild.
    pub const LEAK_WHOLE: &str = "<tool_call>verify<arg_key>name</arg_key>\
        <arg_value>daimonfold</arg_value><arg_key>timeout_ms</arg_key>\
        <arg_value>600000</arg_value><arg_key>world</arg_key>\
        <arg_value>true</arg_value></tool_call>";

    /// The real fragment is a leak, and it is not recoverable: no name, nothing to dispatch.
    #[test]
    fn test_the_fragment_that_ended_turn_56_as_an_answer_is_read_as_a_leak() {
        let leak = leaked_tool_call(LEAK_HEADLESS)
            .unwrap_or_else(|| panic!("the live fragment was read as ordinary prose"));
        assert_eq!(LEAK_HEADLESS, leak.fragment, "the fragment was not kept verbatim");
        assert_eq!(None, leak.recovered,
            "a call with no name was rebuilt, which is the app inventing one");
    }

    /// A whole call is rebuilt, with its arguments typed the way a schema wants them.
    #[test]
    fn test_a_whole_leaked_call_is_recovered_with_its_arguments_typed() {
        let leak = leaked_tool_call(LEAK_WHOLE)
            .unwrap_or_else(|| panic!("a whole leaked call was read as prose"));
        let call = match leak.recovered {
            Some(c) => c,
            None    => panic!("a whole call was not recovered: {:?}", leak.fragment),
        };
        assert_eq!("verify", call.name);
        assert_eq!(Some(fmt!("daimonfold")), extract_json_string(&call.arguments, "name"));
        // UNQUOTED, both of them. `verify`'s schema types `timeout_ms` as a number and
        // `world` as a boolean, so a reader that made every value a string would recover a
        // call the door then refused -- a fix that looks like one and is not.
        assert!(call.arguments.contains("\"timeout_ms\":600000"),
            "a numeric argument was quoted: {}", call.arguments);
        assert!(call.arguments.contains("\"world\":true"),
            "a boolean argument was quoted: {}", call.arguments);
    }

    /// The markup INSIDE a fence is a model showing its reader the syntax, not using it.
    ///
    /// The daimon is asked to explain this very defect, and an explanation that got its
    /// author nudged and then its turn ended under an error word would be the fix doing more
    /// damage than the fault.
    #[test]
    fn test_the_same_markup_inside_a_fence_is_a_model_showing_its_working() {
        let shown = fmt!("A leaked call looks like this:\n\n```\n{}\n```\n\nThat is the shape.",
            LEAK_WHOLE);
        assert_eq!(None, leaked_tool_call(&shown),
            "a fenced example was classified as a malformed reply");
        // And a fence that is still open -- the ordinary mid-stream case -- is fenced too.
        let mid = fmt!("Here is the shape:\n\n```\n{}", LEAK_HEADLESS);
        assert_eq!(None, leaked_tool_call(&mid),
            "an unclosed fence stopped protecting what is inside it");
    }

    /// Ordinary prose, including prose about tools, is not a leak.
    #[test]
    fn test_ordinary_prose_is_not_a_leak() {
        for said in ["I will run verify next.", "", "<details><summary>a</summary>b</details>",
            "The arg_key is name.", "a < b and c > d"]
        {
            assert_eq!(None, leaked_tool_call(said), "prose was read as a leak: {:?}", said);
        }
    }

    /// A whole response carrying the leak comes back MALFORMED, with the call dispatched and
    /// the markup out of the answer.
    #[test]
    fn test_a_recovered_leak_leaves_the_round_looking_like_the_one_the_model_meant() {
        let resp = ChatOnceResponse {
            content: fmt!("Let me check.\n{}", LEAK_WHOLE),
            ..Default::default()
        }.classified();
        assert!(matches!(resp.shape, ReplyShape::Malformed(_)),
            "a recovered leak stopped being reported");
        assert_eq!(1, resp.tool_calls.len(), "the recovered call did not reach the round");
        assert_eq!("Let me check.", resp.content,
            "the markup was left in the answer: {:?}", resp.content);
    }

    /// A round that carries proper tool calls is never malformed, whatever its prose shows.
    #[test]
    fn test_a_round_whose_calls_arrived_is_plain_however_its_prose_reads() {
        let resp = ChatOnceResponse {
            content:    fmt!("The syntax is {}", LEAK_WHOLE),
            tool_calls: vec![ToolCall {
                id: fmt!("call_1"), name: fmt!("file_list"), arguments: fmt!("{{}}"),
            }],
            ..Default::default()
        }.classified();
        assert_eq!(ReplyShape::Plain, resp.shape,
            "a model explaining the syntax beside a real call was nudged for it");
    }

    // ── The two-depth answer, written inline ─────────────────────────────────

    /// The fixture the Rust and JS halves are BOTH tested against.
    ///
    /// Authored by the orchestrator and read from disk rather than transcribed into this file,
    /// so a case added or corrected there cannot silently stop being checked here.
    const FOLD_FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/dev/fixtures/fold_keys.json");

    /// The integers in a JSON array, for the fixture's `body_chars`.
    fn json_numbers(json: &str, key: &str) -> Vec<usize> {
        let arr = match find_json_array(json, key) {
            Some(a) => a,
            None    => return Vec::new(),
        };
        arr.split(|c: char| !c.is_ascii_digit())
            .filter(|s| !s.is_empty())
            .filter_map(|s| s.parse::<usize>().ok())
            .collect()
    }

    /// **Every case in `dev/fixtures/fold_keys.json`, driven from the file itself.**
    ///
    /// The key is the one name the two languages must agree on, and the fixture is where they
    /// agree. Three things are checked per case, and the third is the one that carries the risk:
    /// the keys, the body character counts, and the stripped text -- where a `null` means the
    /// stripper must leave the input EXACTLY as it found it, which is the assertion a stripper
    /// that rewrites too eagerly fails.
    #[test]
    fn test_every_case_in_the_shared_fold_fixture() {
        let json = match std::fs::read_to_string(FOLD_FIXTURE) {
            Ok(s)  => s,
            Err(e) => panic!("the shared fixture must be readable at {}: {}", FOLD_FIXTURE, e),
        };
        // The wording of the note, pinned by the fixture rather than by this file: the JS half
        // renders the same sentence and the two must not drift apart.
        let want_note = extract_json_string(&json, "_placeholder").unwrap_or_default();
        assert_eq!(fold_note(7), want_note.replace("N characters", "7 characters"),
            "the placeholder wording has drifted from the fixture");

        let cases = match extract_json_objects(&json, "cases") {
            Some(c) => c,
            None    => panic!("the fixture has no `cases` array: {}", FOLD_FIXTURE),
        };
        // A fixture that stopped being read would pass every case it no longer had, and one that
        // LOST a case would pass just as quietly.  The floor rises with the file: 11 at first
        // writing, 15 once nesting, the empty body and the lone angle bracket were pinned.
        assert!(cases.len() >= 15, "only {} cases read from {}", cases.len(), FOLD_FIXTURE);

        let shut = OpenSet::new();
        for c in &cases {
            let name = extract_json_string(c, "name").unwrap_or_default();
            let input = match extract_json_string(c, "input") {
                Some(i) => i,
                None    => panic!("case '{}' has no input", name),
            };
            let found = folds(&input);

            let keys: Vec<String> = found.iter().map(|f| f.key()).collect();
            let want: Vec<String> = extract_json_string_array(c, "keys").unwrap_or_default();
            assert_eq!(keys, want, "case '{}': keys, from {:?}", name, input);

            let chars: Vec<usize> = found.iter().map(|f| f.chars).collect();
            assert_eq!(chars, json_numbers(c, "body_chars"),
                "case '{}': body characters, from {:?}", name, input);

            let got = strip_folds(&input, &shut);
            match extract_json_string(c, "stripped_all_closed") {
                Some(w) => assert_eq!(got.as_deref(), Some(w.as_str()),
                    "case '{}': the strip", name),
                None    => assert!(got.is_none(),
                    "case '{}': the stripper rewrote a text it must leave exactly as it found \
                     it.\n  in:  {:?}\n  out: {:?}", name, input, got),
            }
        }
    }

    /// The fixture the two halves of the SEAM are both tested against.
    const SEAM_FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/dev/fixtures/fold_seam.json");

    /// **Every case in `dev/fixtures/fold_seam.json`, driven from the file itself.**
    ///
    /// Three assertions a case, and the second is the one with the risk in it. The expansion has
    /// to be exactly the text `www/js/render.js` builds, because a character between the two is a
    /// key the page and the engine disagree about and a fold the reader opens that never leaves
    /// the payload. `null` means the seam must leave the text exactly as it found it, which is
    /// what a seam that fires on a fenced line or on `Folder:` fails. And the keys are read off
    /// the RESULT, so a case proves the fold that comes out of the expansion and not just the
    /// string.
    #[test]
    fn test_every_case_in_the_shared_seam_fixture() {
        let json = match std::fs::read_to_string(SEAM_FIXTURE) {
            Ok(s)  => s,
            Err(e) => panic!("the shared fixture must be readable at {}: {}", SEAM_FIXTURE, e),
        };
        let cases = match extract_json_objects(&json, "cases") {
            Some(c) => c,
            None    => panic!("the fixture has no `cases` array: {}", SEAM_FIXTURE),
        };
        // A fixture that stopped being read would pass every case it no longer had.
        assert!(cases.len() >= 14, "only {} cases read from {}", cases.len(), SEAM_FIXTURE);
        for c in &cases {
            let name = extract_json_string(c, "name").unwrap_or_default();
            let input = match extract_json_string(c, "input") {
                Some(i) => i,
                None    => panic!("case '{}' has no input", name),
            };
            let got = seam_text(&input);
            match extract_json_string(c, "seamed") {
                Some(w) => assert_eq!(got.as_deref(), Some(w.as_str()),
                    "case '{}': the seam", name),
                None    => assert!(got.is_none(),
                    "case '{}': the seam rewrote a text it must leave exactly as it found \
                     it.\n  in:  {:?}\n  out: {:?}", name, input, got),
            }
            let after = got.unwrap_or(input.clone());
            let keys: Vec<String> = folds(&after).iter().map(|f| f.key()).collect();
            let want: Vec<String> = extract_json_string_array(c, "keys").unwrap_or_default();
            assert_eq!(keys, want, "case '{}': the keys of what came out", name);
        }
    }

    /// **The seam refuses the two failures no wording could prevent.**
    ///
    /// `dev/PROMPT_NOTES.md` §5 measured a candidate wording that folded 8 answers in 8 and put
    /// nothing above the fold in 8 of 8 -- FOLD-ALL, which `dev/CONTRACT_FOLD.md` §5 calls worse
    /// than no control at all. A length threshold applied blindly does the same thing by another
    /// route. So the refusals are asserted as behaviour rather than left to the fixture's
    /// examples: below the lead, below the summary's words, below the body, nothing folds, and
    /// the reader still gets every word the model wrote.
    #[test]
    fn test_the_seam_refuses_rather_than_folding_everything() {
        let body = "x. ".repeat(120);
        let sum  = "The store wins on scans and loses on isolation, so I take the file.";
        let lead = "Take one file per Diamond: isolation is worth more here than scan speed.";
        for (what, text) in [
            ("nothing above the seam",  fmt!("Fold: {}\n\n{}", sum, body)),
            ("a lead of a few words",   fmt!("Short.\n\nFold: {}\n\n{}", sum, body)),
            ("a label, not a summary",  fmt!("{}\n\nFold: Reasoning\n\n{}", lead, body)),
            ("nothing below the seam",  fmt!("{}\n\nFold: {}\n\nTiny.", lead, sum)),
        ] {
            let got = seam_text(&text).unwrap_or_else(|| text.clone());
            assert!(folds(&got).is_empty(), "{}: it folded anyway: {:?}", what, got);
            assert!(!got.contains("<details"), "{}: it built an element: {:?}", what, got);
            // Refused is not lost: every word the model wrote is still there, marker aside.
            for line in text.lines().filter(|l| !l.trim().is_empty()) {
                let want = line.trim_start_matches("Fold: ");
                assert!(got.contains(want), "{}: {:?} went missing from {:?}", what, want, got);
            }
        }
        // And the one that does qualify folds, or the four above would pass on a seam that never
        // fires at all.
        let good = fmt!("{}\n\nFold: {}\n\n{}", lead, sum, body);
        let got = match seam_text(&good) {
            Some(g) => g,
            None    => panic!("a qualifying answer did not seam"),
        };
        let found = folds(&got);
        assert_eq!(found.len(), 1, "one fold, from {:?}", got);
        assert_eq!(found[0].key(), fmt!("0:{}", sum));
        // The blank lines CONTRACT_FOLD.md §1 calls mandatory, without which `marked` never
        // parses the markdown inside the element.
        assert!(got.contains(&fmt!("<summary>{}</summary>\n\n", sum)), "no blank line after the \
            summary: {:?}", got);
        assert!(got.contains("\n\n</details>"), "no blank line before the close: {:?}", got);
    }

    /// **The seam reads a line BY BYTES, because a slice of one panics.**
    ///
    /// `panicked at src/llm.rs:3096:25: byte index 4 is not a char boundary; it is inside
    /// '\u{2014}' (bytes 3..6)` -- observed on build `4d4fd190f1ef`, 2026-09-12, on an answer
    /// opening `OK \u{2014} but right now ...`.  A panic in here is not a lost fold: it traps the
    /// wasm mid-turn, the JS `await` on the turn never settles, and the end-of-turn bookkeeping
    /// on the other side of it -- the `ended` event, a worker's `end`, the Diamond's busy flag --
    /// is skipped for good.  So the line is read as four bytes and never sliced at four.
    ///
    /// Every case here is a line whose fourth BYTE falls inside a character, at each of the three
    /// places the reader walks before it compares: after the indent, after the hashes and after
    /// the emphasis run.
    #[test]
    fn test_the_seam_does_not_panic_on_a_multibyte_fourth_byte() {
        let lines = [
            "OK \u{2014} but right now let me also read the mock interplay",
            "\u{2014}\u{2014} a rule, not a fold",
            "No\u{2014}",
            "ab\u{e9}",
            "\u{1f600}",
            "## \u{2014} a heading that is not one",
            "**\u{2014} emphasised, and not a fold**",
            "_\u{4e16}\u{754c}_",
            "fol\u{2014}",
            "\u{2014}",
            "",
            "   \u{2014} indented past the marker",
        ];
        for line in lines {
            // The refusal is the assertion; reaching it at all is the regression.
            assert!(seam_line(line).is_none(), "{:?} seamed", line);
        }
        // And through the public door, which is how it reached production: the word the guard
        // looks for is in the text, so `seam_text` walks every line of it.
        let body = "x. ".repeat(120);
        let text = fmt!("OK \u{2014} but right now let me also read the mock interplay, which \
            the fold above does not cover.\n\n{}", body);
        let _ = seam_text(&text);
        // A real seam still seams with a multi-byte summary, or the fix could be a refusal.
        let sum  = "The store wins on scans \u{2014} so I take the file, not the row.";
        let lead = "Take one file per Diamond: isolation is worth more here than scan speed.";
        let good = fmt!("{}\n\n**Fold:** {}\n\n{}", lead, sum, body);
        let got = match seam_text(&good) {
            Some(g) => g,
            None    => panic!("a qualifying answer with an em dash in its summary did not seam"),
        };
        assert_eq!(folds(&got).len(), 1, "one fold, from {:?}", got);
        assert_eq!(folds(&got)[0].key(), fmt!("0:{}", sum));
    }

    /// **A `<details>` inside a fenced region is markup being SHOWN, not a fold.**
    ///
    /// Named rather than incidental because it is the likeliest wrong strip in the feature: a
    /// model quoting the convention to the user -- which the prompt now invites, since the prompt
    /// itself contains the markup -- would have its example silently edited out from under the
    /// person reading it, and the fake would steal the ordinal of the real fold below.
    ///
    /// Four shapes, and each has failed a stripper written without one of them: a fence with an
    /// info string, a tilde fence, a fence indented up to three spaces, and a fence INSIDE a
    /// real fold whose contents include a literal `</details>` that must not end the element.
    #[test]
    fn test_a_fold_inside_a_fenced_region_is_not_a_fold() {
        let shut = OpenSet::new();
        for (what, text) in [
            ("a backtick fence with an info string",
             "```html\n<details>\n<summary>Not a fold</summary>\n\nLiteral.\n\n</details>\n```\n"),
            ("a tilde fence",
             "~~~\n<details>\n<summary>Not a fold</summary>\n\nLiteral.\n\n</details>\n~~~\n"),
            ("a fence indented three spaces",
             "   ```\n   <details>\n   <summary>Not a fold</summary>\n\n   Literal.\n\n   </details>\n   ```\n"),
        ] {
            assert!(folds(text).is_empty(), "{} produced folds: {:?}", what, folds(text).len());
            assert!(strip_folds(text, &shut).is_none(), "{} was rewritten", what);
        }

        // The fake takes no ordinal, so the real fold below it is fold ZERO.
        let mixed = "```\n<details>\n<summary>Fake</summary>\nx\n</details>\n```\n\n\
                     <details>\n<summary>Real</summary>\n\nYes.\n\n</details>\n";
        let f = folds(mixed);
        assert_eq!(1, f.len(), "the fenced fake was counted as a fold");
        assert_eq!("0:Real", f[0].key(), "the fenced fake consumed an ordinal");

        // A run carrying an INFO STRING opens a fence and can never close one, so a `\u{60}\u{60}\u{60}rust`
        // line part way through a code block does not end it and hand the rest of the answer back
        // to the scanner as prose.
        let info = "```\n<details>\n<summary>Fake</summary>\nx\n```rust\nstill fenced\n```\n\n\
                    <details>\n<summary>Real</summary>\n\nYes.\n\n</details>\n";
        assert_eq!(vec![fmt!("0:Real")],
            folds(info).iter().map(|f| f.key()).collect::<Vec<_>>(),
            "an info string closed a fence it can only open");

        // And a SHORTER run does not close a longer fence, which is how a model shows a fenced
        // block inside a fenced block.
        let longer = "````\n```\n<details>\n<summary>Fake</summary>\nx\n</details>\n```\n````\n\n\
                      <details>\n<summary>Real</summary>\n\nYes.\n\n</details>\n";
        assert_eq!(vec![fmt!("0:Real")],
            folds(longer).iter().map(|f| f.key()).collect::<Vec<_>>(),
            "a three-backtick run closed a four-backtick fence");

        // A fence INSIDE a fold: the literal `</details>` in the code block must not be taken for
        // this element's close, or the body is cut short and the remainder left dangling.
        let inner = "<details>\n<summary>How to write one</summary>\n\n\
                     ```\n</details>\n```\n\nand that is the shape.\n\n</details>\n";
        let g = folds(inner);
        assert_eq!(1, g.len(), "the fold with a fence in it was lost");
        assert_eq!("0:How to write one", g[0].key());
        assert!(inner[g[0].body.clone()].ends_with("and that is the shape."),
            "the body stopped at the fenced `</details>`: {:?}", &inner[g[0].body.clone()]);
    }

    /// **A nested fold belongs to its parent: no ordinal, no key, no strip of its own.**
    ///
    /// Pairing by the FIRST `</details>` rather than the matching one is the failure this guards.
    /// The browser's parser nests, so the renderer's idea of where the outer fold ends is the
    /// last tag and the scanner's was the first -- and the strip then replaced the wrong span,
    /// cutting the body short and leaving the tail of the element sitting in the payload it was
    /// meant to remove. The shared fixture measures it at 48 characters against the correct 67.
    ///
    /// The inner fold needs no key because the outer strip carries it away entirely: a key for a
    /// body that no longer exists is a fold the user can open to no effect.
    #[test]
    fn test_a_nested_fold_is_carried_by_its_parent() {
        let shut = OpenSet::new();
        let text = "<details>\n<summary>Outer</summary>\n\nbefore\n\n\
                    <details>\n<summary>Inner</summary>\n\ndeep\n\n</details>\n\n\
                    after\n\n</details>\n";
        let f = folds(text);
        assert_eq!(vec![fmt!("0:Outer")], f.iter().map(|x| x.key()).collect::<Vec<_>>(),
            "the inner fold took an ordinal of its own");
        // The body runs to the LAST closing tag, so it holds the whole inner element.
        let body = &text[f[0].body.clone()];
        assert!(body.starts_with("before") && body.ends_with("after"),
            "the outer body was cut at the inner fold's close: {:?}", body);
        assert!(body.contains("<summary>Inner</summary>"),
            "the inner element fell outside its parent's body: {:?}", body);
        // And the strip takes the whole of it, leaving one element where there were two.
        let out = match strip_folds(text, &shut) {
            Some(o) => o,
            None    => panic!("the outer fold was not stripped"),
        };
        assert_eq!(1, out.matches("<details>").count(),
            "the inner element survived its parent's strip: {}", out);
        assert!(out.contains("folded to the user, 67 characters"), "{}", out);

        // A nested pair consumes NOTHING, so the next top-level fold is ordinal one.
        let after = fmt!("{}\n<details>\n<summary>Sibling</summary>\n\nYes.\n\n</details>\n", text);
        assert_eq!(vec![fmt!("0:Outer"), fmt!("1:Sibling")],
            folds(&after).iter().map(|x| x.key()).collect::<Vec<_>>(),
            "the nested fold shifted the ordinal of the one after it");

        // An unlabelled parent does NOT borrow its child's summary. It is not a fold, and neither
        // is the child, which is inside it -- so the answer is no folds rather than a fold whose
        // label names something else.
        let borrowed = "<details>\n\n<details>\n<summary>Inner</summary>\n\ndeep\n\n</details>\n\n</details>\n";
        assert!(folds(borrowed).is_empty(),
            "an unlabelled parent wore its child's label: {:?}",
            folds(borrowed).iter().map(|x| x.key()).collect::<Vec<_>>());
        assert!(strip_folds(borrowed, &shut).is_none());
    }

    /// **A malformed fold is left exactly as the model wrote it.**
    ///
    /// [`strip_said`]'s rule, and the reason is the same: rewriting a malformed element replaces
    /// a problem the model can SEE -- its own broken markup, in its own transcript -- with one it
    /// cannot. An unclosed fold still keys, because its ordinal is settled the moment its summary
    /// is and the user may already have opened it; it is only the rewrite that stands off.
    #[test]
    fn test_a_malformed_fold_is_left_alone() {
        let shut = OpenSet::new();
        let unclosed = "<details>\n<summary>Partial</summary>\n\nStill being written";
        assert_eq!(vec![fmt!("0:Partial")],
            folds(unclosed).iter().map(|f| f.key()).collect::<Vec<_>>());
        assert!(strip_folds(unclosed, &shut).is_none(), "an unclosed fold was rewritten");

        let unlabelled = "<details>\n\nNo summary here.\n\n</details>\n";
        assert!(folds(unlabelled).is_empty(), "a `<details>` with no `<summary>` keyed");
        assert!(strip_folds(unlabelled, &shut).is_none(), "an unlabelled fold was rewritten");

        // A well-formed fold BESIDE a malformed one is still stripped: the leniency is per fold,
        // not per message, or one broken element would keep a whole answer on the wire forever.
        let both = fmt!("{}\n\nand then\n\n{}", unlabelled.trim_end(), unclosed);
        assert!(strip_folds(&both, &shut).is_none());
        let good = fmt!("<details>\n<summary>Good</summary>\n\nkept short.\n\n</details>\n\n{}",
            unclosed);
        let out = match strip_folds(&good, &shut) {
            Some(s) => s,
            None    => panic!("the sound fold beside a broken one was not stripped"),
        };
        assert!(out.contains("folded to the user, 11 characters"), "{}", out);
        assert!(out.ends_with("Still being written"), "the broken fold was touched: {}", out);

        // A fold with an EMPTY body is left alone too, and for the opposite reason: there is
        // nothing to save, and replacing nothing with a hundred characters of note would cost
        // tokens rather than save them.
        let hollow = "<details>\n<summary>Nothing in here</summary>\n\n</details>\n";
        assert_eq!(vec![fmt!("0:Nothing in here")],
            folds(hollow).iter().map(|f| f.key()).collect::<Vec<_>>());
        assert!(strip_folds(hollow, &shut).is_none(), "an empty fold grew a note: {:?}",
            strip_folds(hollow, &shut));
    }

    /// **A `<` that opens no tag stays in the label, because the browser keeps it too.**
    ///
    /// The JS half reads the summary with `textContent`, which returns `a < b` unchanged. A
    /// stripper that treated every `<` as a tag opener would key that label `0:a` while the page
    /// keyed it `0:a < b` -- one label, two keys, and a fold the user opens that never travels.
    /// The contract says HTML TAGS removed; a `<` with no `>` after it is not one.
    #[test]
    fn test_a_lone_angle_bracket_in_a_summary_is_not_a_tag() {
        let text = "<details>\n<summary>when a < b</summary>\n\nBody.\n\n</details>\n";
        assert_eq!(vec![fmt!("0:when a < b")],
            folds(text).iter().map(|f| f.key()).collect::<Vec<_>>());
        // And a real tag is still removed, which is the half the fixture already pins.
        let tagged = "<details>\n<summary><em>when</em> a < b</summary>\n\nBody.\n\n</details>\n";
        assert_eq!(vec![fmt!("0:when a < b")],
            folds(tagged).iter().map(|f| f.key()).collect::<Vec<_>>());
    }

    /// **The strip reaches ALL THREE serialisation sites.**
    ///
    /// `message_to_json` has two assistant branches -- with tool calls and without -- and
    /// `build_anthropic_body` has an assistant text path of its own. Missing one means the same
    /// conversation costs different amounts through different endpoints, silently, which is
    /// exactly the failure [`sent_args_len`]'s doc comment records for `say`.
    ///
    /// Asserted on the finished bodies of both dialects, not on the stripper: a stripper that
    /// works and is never called is the shape this defect takes.
    #[test]
    fn test_the_folded_body_leaves_by_every_serialisation_path() {
        use rustls::crypto::ring;
        let _ = ring::default_provider().install_default();
        let tls = Arc::new(ClientConfig::builder().dangerous()
            .with_custom_certificate_verifier(Arc::new(NoVerify)).with_no_client_auth());
        const BODY: &str = "THE-WORKING-BEHIND-THE-FOLD";
        let said = fmt!("Yes, it terminates.\n\n<details>\n<summary>the working</summary>\n\n\
                         {}\n\n</details>\n", BODY);
        let msgs = vec![
            ChatMessage::user(fmt!("does it terminate?")),
            // The assistant branch with NO tool calls.
            ChatMessage::Assistant {
                content:    MessageContent::text(said.clone()),
                tool_calls: Vec::new(),
            },
            ChatMessage::user(fmt!("and again?")),
            // The assistant branch WITH tool calls, which formats its text separately.
            ChatMessage::Assistant {
                content:    MessageContent::text(said.clone()),
                tool_calls: vec![crate::protocol::ToolCall {
                    id:        fmt!("call_3"),
                    name:      fmt!("file_read"),
                    arguments: fmt!("{{\"path\":\"a.txt\"}}"),
                }],
            },
            ChatMessage::tool(fmt!("call_3"), MessageContent::text(fmt!("ok"))),
        ];
        for (host, path) in [("api.test.com", "/v1/chat"), ("api.anthropic.com", "/v1/messages")] {
            let c = LlmClient::new(host, 443, path, "key", "claude-opus-5", 4096, tls.clone());
            c.set_open_folds(Vec::new());
            let body = c.build_body(&msgs, None, false);
            assert_eq!(0, body.matches(BODY).count(),
                "a closed fold's body is still on the wire via {}: {}", path, body);
            assert_eq!(2, body.matches("folded to the user").count(),
                "via {} only {} of the two assistant messages left a note, so one \
                 serialisation path does not strip: {}",
                path, body.matches("folded to the user").count(), body);
            // The element is KEPT: a model that sees the fold it wrote still knows it folded
            // something and what it called it.
            assert_eq!(2, body.matches("<summary>the working</summary>").count(),
                "the element was deleted rather than emptied, via {}: {}", path, body);
            assert!(body.contains("Yes, it terminates."),
                "the short answer above the fold was stripped too, via {}: {}", path, body);

            // And the key JS sends is the key Rust matches: open it and the body travels.
            c.set_open_folds(vec![fmt!("0:the working")]);
            assert_eq!(2, c.build_body(&msgs, None, false).matches(BODY).count(),
                "an OPEN fold was withheld via {}, so the model cannot see what the user is \
                 reading", path);
        }

        // The cache-marked serialisation delegates the assistant role rather than repeating it,
        // and this is the assertion that keeps that true.
        let shut = OpenSet::new();
        assert_eq!(message_to_json(&msgs[1], &shut), message_to_json_cached(&msgs[1], &shut),
            "the cached path grew an assistant branch of its own");
    }

    /// **What the compaction trigger measures is the text the wire will carry.**
    ///
    /// Defect F, one depth further in. [`crate::agent::compact::msg_bytes`] was taught to ask
    /// [`sent_args_len`] what a `say` costs; an inline fold folds the assistant's own prose
    /// instead, and a sizer that knew about one and not the other would leave the same defect
    /// standing with a new name.
    ///
    /// The second assertion is the one that matters. A closed fold sizing smaller than an open
    /// one is satisfied by any discount at all; that the discount is exactly what serialisation
    /// saves is satisfied only by asking the serialiser.
    #[test]
    fn test_the_trigger_sizes_the_folded_text_the_wire_will_carry() {
        use crate::agent::compact::conversation_bytes;
        use rustls::crypto::ring;
        let _ = ring::default_provider().install_default();
        let tls = Arc::new(ClientConfig::builder().dangerous()
            .with_custom_certificate_verifier(Arc::new(NoVerify)).with_no_client_auth());
        // Plain letters and spaces on both sides of the swap, so the two bodies differ by the
        // fold's body and by nothing an escape would change.
        let working = "the long working behind the fold ".repeat(40);
        let said = fmt!("Yes.\n\n<details>\n<summary>the working</summary>\n\n{}\n\n</details>\n",
            working.trim());
        let msgs = vec![
            ChatMessage::user(fmt!("explain")),
            ChatMessage::Assistant {
                content:    MessageContent::text(said),
                tool_calls: Vec::new(),
            },
        ];
        let shut = OpenSet::new();
        let open: OpenSet = [fmt!("0:the working")].into_iter().collect();
        let sized_shut = conversation_bytes(&msgs, &shut);
        let sized_open = conversation_bytes(&msgs, &open);

        for (host, path) in [("api.test.com", "/v1/chat"), ("api.anthropic.com", "/v1/messages")] {
            let c = LlmClient::new(host, 443, path, "key", "claude-opus-5", 4096, tls.clone());
            c.set_open_folds(Vec::new());
            let wire_shut = c.build_body(&msgs, None, false).len() as u64;
            c.set_open_folds(vec![fmt!("0:the working")]);
            let wire_open = c.build_body(&msgs, None, false).len() as u64;

            assert!(wire_shut < wire_open, "the fixture proves nothing via {}: closing the fold \
                did not shrink the payload", path);
            assert!(sized_shut < sized_open,
                "a closed fold is sized as though its body were still sent, so the trigger folds \
                 a conversation of {} bytes that goes out as {} (via {})",
                sized_shut, wire_shut, path);
            assert_eq!(sized_open - sized_shut, wire_open - wire_shut,
                "the sizer books {} bytes for closing the fold and the wire saves {} (via {}), \
                 so the trigger is measuring a rule of its own rather than the serialiser's",
                sized_open - sized_shut, wire_open - wire_shut, path);
        }
    }

    #[test]
    fn test_extract_json_string() {
        let json = r#"{"choices":[{"delta":{"content":"hello"}}]}"#;
        assert_eq!(extract_json_string(json, "content"), Some("hello".to_string()));
    }

    #[test]
    fn test_extract_json_bool() {
        assert_eq!(extract_json_bool(r#"{"submit":true}"#, "submit"), Some(true));
        assert_eq!(extract_json_bool(r#"{"submit": false}"#, "submit"), Some(false));
        // A model that quotes the boolean is still understood.
        assert_eq!(extract_json_bool(r#"{"submit":"true"}"#, "submit"), Some(true));
        assert_eq!(extract_json_bool(r#"{"ref":3}"#, "submit"), None);
    }

    #[test]
    fn test_extract_json_f64() {
        // The case that made a reported cost read as free: `extract_json_number`
        // stops at the '.', so `0.0021` was 0.
        assert_eq!(extract_json_number(r#"{"cost":0.0021}"#, "cost"), Some(0));
        assert_eq!(extract_json_f64(r#"{"cost":0.0021}"#, "cost"), Some(0.0021));
        // Whitespace, exponents both ways, a negative, and a quoted figure.
        assert_eq!(extract_json_f64(r#"{"cost": 1.5}"#, "cost"), Some(1.5));
        assert_eq!(extract_json_f64(r#"{"cost":2.1e-5}"#, "cost"), Some(2.1e-5));
        assert_eq!(extract_json_f64(r#"{"cost":3E+2}"#, "cost"), Some(300.0));
        assert_eq!(extract_json_f64(r#"{"cost":-0.5,"x":1}"#, "cost"), Some(-0.5));
        assert_eq!(extract_json_f64(r#"{"cost":"0.0021"}"#, "cost"), Some(0.0021));
        // A whole number is still a number, and an absent key is still absent.
        assert_eq!(extract_json_f64(r#"{"cost":0}"#, "cost"), Some(0.0));
        assert_eq!(extract_json_f64(r#"{"total":1.0}"#, "cost"), None);
        // A longer key that merely ends in the wanted one is not it.
        assert_eq!(extract_json_f64(r#"{"upstream_inference_cost":9.0}"#, "cost"), None);
    }

    #[test]
    fn test_parse_usage_openrouter() {
        // The shape OpenRouter actually returns: authoritative cost, and the
        // cache read nested under `prompt_tokens_details`.
        let body = r#"{"id":"gen-1","choices":[{"message":{"content":"hi"}}],"usage":{"prompt_tokens":10240,"completion_tokens":128,"total_tokens":10368,"cost":0.0021,"cost_details":{"upstream_inference_cost":null},"prompt_tokens_details":{"cached_tokens":9216},"completion_tokens_details":{"reasoning_tokens":0}}}"#;
        let u = match parse_usage(body) {
            Some(u) => u,
            None    => panic!("usage not found"),
        };
        assert_eq!(u.prompt, 10240);
        assert_eq!(u.completion, 128);
        assert_eq!(u.cached, 9216);
        assert_eq!(u.cost_usd, 0.0021);
    }

    #[test]
    fn test_parse_usage_absent_and_null() {
        // No usage at all, and the `"usage":null` every intermediate streamed
        // chunk carries: both must read as absent, so the usage chunk that came
        // before is not erased by the chunk that follows it.
        assert!(parse_usage(r#"{"choices":[{"delta":{"content":"x"}}]}"#).is_none());
        assert!(parse_usage(r#"{"choices":[{"delta":{}}],"usage":null}"#).is_none());
        // A provider reporting only tokens leaves cost and cache at zero, which
        // is "it did not say", never "it was free".
        let u = match parse_usage(r#"{"usage":{"prompt_tokens":4,"completion_tokens":2}}"#) {
            Some(u) => u,
            None    => panic!("usage not found"),
        };
        assert_eq!(u.cached, 0);
        assert_eq!(u.cost_usd, 0.0);
    }

    #[test]
    fn test_parse_usage_anthropic_native_cache_read() {
        // Anthropic's own name for the figure.  A prompt cache that is working
        // must not read as one that is not, or the breakpoint looks inert.
        let u = match parse_usage(
            r#"{"usage":{"prompt_tokens":100,"cache_read_input_tokens":80}}"#) {
            Some(u) => u,
            None    => panic!("usage not found"),
        };
        assert_eq!(u.cached, 80);
    }

    #[test]
    fn test_parse_usage_flat_cached() {
        // A provider that flattens the cache read onto `usage` is read too.
        let u = match parse_usage(r#"{"usage":{"prompt_tokens":100,"cached_tokens":80}}"#) {
            Some(u) => u,
            None    => panic!("usage not found"),
        };
        assert_eq!(u.cached, 80);
    }

    #[test]
    fn test_extract_json_string_escaped() {
        let json = r#"{"choices":[{"delta":{"content":"hello \"world\""}}]}"#;
        assert_eq!(extract_json_string(json, "content"), Some("hello \"world\"".to_string()));
    }

    #[test]
    fn test_extract_json_string_newline() {
        let json = r#"{"choices":[{"delta":{"content":"line1\nline2"}}]}"#;
        assert_eq!(extract_json_string(json, "content"), Some("line1\nline2".to_string()));
    }

    #[test]
    fn test_raw_fetch_reply_parses_to_bytes() {
        // `fetch_raw` (src/wasm/web.rs) reads the gateway's raw reply with this same
        // `extract_json_string`, on the same snake_case keys `raw_fetch_fields`
        // (gateway/src/handlers/web.rs) answers with -- `content_type` and `body_b64`.
        // The web panel used to rename those keys to camelCase in flight, so this
        // field never matched and every raw download failed with "no bytes". This
        // fixes the JS side; the guard is here so a future rename trips a native test
        // rather than only a browser downloading a real file.
        let json = r#"{"ok":true,"url":"https://example.com/words.bin","content_type":"application/octet-stream","bytes":11,"body_b64":"AP/+d29yZIAKwyg="}"#;
        let content_type = extract_json_string(json, "content_type").unwrap_or_default();
        assert_eq!(content_type, "application/octet-stream");
        let b64 = match extract_json_string(json, "body_b64") {
            Some(b) => b,
            None    => panic!("body_b64 must be found in the gateway's own reply shape"),
        };
        let bytes = match oxedyne_fe2o3_text::base64::decode(&b64) {
            Ok(b)  => b,
            Err(e) => panic!("body_b64 must decode: {}", e),
        };
        assert!(!bytes.is_empty(), "a real download must not parse to zero bytes");
        assert_eq!(bytes, vec![0x00, 0xFF, 0xFE, b'w', b'o', b'r', b'd', 0x80, 0x0A, 0xC3, 0x28]);
    }

    #[test]
    fn test_parse_sse_simple() {
        let sse = "data: {\"choices\":[{\"delta\":{\"content\":\"Hello\"}}]}\n\ndata: {\"choices\":[{\"delta\":{\"content\":\" world\"}}]}\n\ndata: [DONE]\n";
        let mut tokens = Vec::new();
        let (full, _use) = parse_sse_stream(sse.as_bytes(), &mut |t| tokens.push(t.to_string()));
        assert_eq!(tokens, vec!["Hello", " world"]);
        assert_eq!(full, "Hello world");
    }

    #[test]
    fn test_parse_sse_empty_lines() {
        let sse = "\r\ndata: {\"choices\":[{\"delta\":{\"content\":\"Hi\"}}]}\r\n\r\ndata: [DONE]\r\n";
        let mut tokens = Vec::new();
        let (full, _use) = parse_sse_stream(sse.as_bytes(), &mut |t| tokens.push(t.to_string()));
        assert_eq!(tokens, vec!["Hi"]);
        assert_eq!(full, "Hi");
    }

    // Chunked transfer decoding is now handled inline by `LineReader`;
    // the standalone `dechunk` helper and its tests were removed.

    #[test]
    fn test_parse_full_response_tool_calls() {
        let body = r#"{"choices":[{"index":0,"message":{"role":"assistant","content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"file_read","arguments":"{\"path\":\"a.txt\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":12,"completion_tokens":8}}"#;
        let (content, calls, use_) = parse_full_response(body);
        assert_eq!(content, "");
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].id, "call_1");
        assert_eq!(calls[0].name, "file_read");
        assert_eq!(calls[0].arguments, r#"{"path":"a.txt"}"#);
        assert_eq!(use_.prompt, 12);
        assert_eq!(use_.completion, 8);
    }

    #[test]
    fn test_extract_json_string_whitespace() {
        // Real model output has a space after the colon.
        assert_eq!(extract_json_string(r#"{"path": "a.txt"}"#, "path"), Some("a.txt".to_string()));
        assert_eq!(extract_json_string(r#"{ "content": "hi" }"#, "content"), Some("hi".to_string()));
        // A null value is not a string.
        assert_eq!(extract_json_string(r#"{"content": null, "x":"y"}"#, "content"), None);
    }

    #[test]
    fn test_parse_full_response_spaced() {
        // Whitespace after colons, as real APIs emit.
        let body = r#"{"choices": [{"message": {"content": null, "tool_calls": [{"id": "c1", "type": "function", "function": {"name": "file_write", "arguments": "{\"path\": \"a.txt\", \"content\": \"hi\"}"}}]}}], "usage": {"prompt_tokens": 4, "completion_tokens": 2}}"#;
        let (content, calls, use_) = parse_full_response(body);
        assert_eq!(content, "");
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "file_write");
        assert_eq!(calls[0].arguments, r#"{"path": "a.txt", "content": "hi"}"#);
        assert_eq!(use_.prompt, 4);
        assert_eq!(use_.completion, 2);
        // And the tool can extract the spaced args.
        assert_eq!(extract_json_string(&calls[0].arguments, "path"), Some("a.txt".to_string()));
    }

    #[test]
    fn test_parse_full_response_text() {
        let body = r#"{"choices":[{"message":{"role":"assistant","content":"Hello there."},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":3}}"#;
        let (content, calls, use_) = parse_full_response(body);
        assert_eq!(content, "Hello there.");
        assert!(calls.is_empty());
        assert_eq!(use_.prompt, 5);
        assert_eq!(use_.completion, 3);
    }

    #[test]
    fn test_parse_full_response_two_calls() {
        let body = r#"{"choices":[{"message":{"content":null,"tool_calls":[{"id":"c1","type":"function","function":{"name":"file_list","arguments":"{}"}},{"id":"c2","type":"function","function":{"name":"shell","arguments":"{\"command\":\"ls\"}"}}]}}]}"#;
        let (_c, calls, _use) = parse_full_response(body);
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].name, "file_list");
        assert_eq!(calls[1].name, "shell");
        assert_eq!(calls[1].arguments, r#"{"command":"ls"}"#);
    }

    /// A sink that keeps the ANSWER and throws the working away.
    ///
    /// What nearly every check in this module is about: the answer is what gets
    /// persisted and sent back next turn, so a check that let reasoning into the
    /// same vector would pass on a client that confused the two.
    fn text_sink(out: &mut Vec<String>) -> impl FnMut(Delta<'_>) + '_ {
        move |d| if let Delta::Text(t) = d { out.push(t.to_string()); }
    }

    /// The other half: the working, kept and the answer thrown away.
    fn think_sink(out: &mut Vec<String>) -> impl FnMut(Delta<'_>) + '_ {
        move |d| if let Delta::Reasoning(t) = d { out.push(t.to_string()); }
    }

    /// Drive a sequence of SSE `data:` payloads through a fresh
    /// [`StreamAcc`], collecting the forwarded text tokens.
    fn run_stream(chunks: &[&str]) -> (ChatOnceResponse, Vec<String>) {
        let mut acc = StreamAcc::default();
        let mut tokens = Vec::new();
        for c in chunks {
            acc.ingest(c, &mut text_sink(&mut tokens));
        }
        (acc.into_response(false, 0), tokens)
    }

    /// Drive the same payloads and keep BOTH sides, so a check can say which sink
    /// each piece reached rather than only that it arrived somewhere.
    fn run_stream_both(chunks: &[&str]) -> (ChatOnceResponse, Vec<String>, Vec<String>) {
        let mut acc     = StreamAcc::default();
        let mut tokens  = Vec::new();
        let mut thought = Vec::new();
        for c in chunks {
            acc.ingest(c, &mut |d: Delta<'_>| match d {
                Delta::Text(t)      => tokens.push(t.to_string()),
                Delta::Reasoning(t) => thought.push(t.to_string()),
                Delta::Roading { .. } => {}   // the SSE accumulator never emits a retry delta
            });
        }
        (acc.into_response(false, 0), tokens, thought)
    }

    #[test]
    fn test_the_working_of_an_openai_dialect_model_reaches_the_page_as_it_arrives() {
        // Captured from OpenRouter on 2026-08-28, `z-ai/glm-4.6` by way of DeepInfra:
        // the reasoning is on `delta.reasoning` and repeated VERBATIM inside
        // `delta.reasoning_details`, and `content` is an empty string throughout it.
        // A round of this model spent 230 of its 300 output tokens here, and the app
        // showed a spinner for all of them.
        let (resp, tokens, thought) = run_stream_both(&[
            r#"{"choices":[{"delta":{"content":"","role":"assistant","reasoning":"1","reasoning_details":[{"type":"reasoning.text","text":"1","format":"unknown","index":0}]}}]}"#,
            r#"{"choices":[{"delta":{"content":"","role":"assistant","reasoning":"7 x 23","reasoning_details":[{"type":"reasoning.text","text":"7 x 23","format":"unknown","index":0}]}}]}"#,
            r#"{"choices":[{"delta":{"content":"391","role":"assistant","reasoning":null}}]}"#,
            r#"{"choices":[{"delta":{},"finish_reason":"stop"}]}"#,
        ]);
        // ONE copy of each piece. `reasoning_details` says the same words again, so a
        // reader that took both would show every token twice.
        assert_eq!(thought, vec!["1", "7 x 23"],
            "the model's working was dropped, or doubled by reasoning_details: {:?}", thought);
        // A `null` reasoning field is the provider saying there is none this chunk.
        assert_eq!(tokens, vec!["391"], "reasoning reached the answer sink: {:?}", tokens);
        assert_eq!(resp.content, "391", "reasoning was accumulated as the reply");
        assert_eq!(resp.thinking, "17 x 23",
            "the round's working was not kept on the response");
    }

    #[test]
    fn test_deepseeks_own_spelling_of_its_working_is_read_too() {
        // `reasoning_content` is what DeepSeek's own endpoint calls it; `reasoning` is
        // OpenRouter's. Both are wanted -- Daimond reaches DeepSeek both ways -- and
        // never both in one delta, which is why one is read and then the other.
        let (resp, tokens, thought) = run_stream_both(&[
            r#"{"choices":[{"delta":{"role":"assistant","content":null,"reasoning_content":"So the"}}]}"#,
            r#"{"choices":[{"delta":{"content":null,"reasoning_content":" answer is"}}]}"#,
            r#"{"choices":[{"delta":{"content":"391","reasoning_content":null}}]}"#,
        ]);
        assert_eq!(thought, vec!["So the", " answer is"], "{:?}", thought);
        assert_eq!(tokens, vec!["391"], "{:?}", tokens);
        assert_eq!(resp.thinking, "So the answer is");
        assert_eq!(resp.content, "391");
    }

    #[test]
    fn test_a_models_working_is_never_stored_as_what_it_said() {
        // THE DEFECT THIS WHOLE PATH IS ONE MISTAKE AWAY FROM. The reply is what gets
        // written into the transcript and sent back to the model next turn as its own
        // words. Reasoning put there is the model's working out quoted back to it as
        // its answer -- and the working of a tool round is mostly wrong turns.
        let (resp, tokens, thought) = run_stream_both(&[
            r#"{"choices":[{"delta":{"content":"","reasoning":"Maybe I should delete it."}}]}"#,
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"file_read","arguments":"{}"}}]}}]}"#,
        ]);
        assert!(resp.content.is_empty(),
            "the working was accumulated as the reply: {:?}", resp.content);
        assert!(tokens.is_empty(), "the working reached the answer sink: {:?}", tokens);
        assert_eq!(thought, vec!["Maybe I should delete it."]);
        assert_eq!(resp.tool_calls.len(), 1, "the tool call was lost");
    }

    #[test]
    fn test_a_reasoning_key_inside_tool_arguments_is_not_the_models_working() {
        // A model writing JSON about reasoning is not reasoning. The argument text is
        // an escaped string, so the key form never matches -- asserted rather than
        // assumed, because the same trap already caught `content` once.
        let (resp, tokens, thought) = run_stream_both(&[
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"note_write","arguments":"{\"reasoning\":\"not mine\",\"content\":\"nor this\"}"}}]}}]}"#,
        ]);
        assert!(thought.is_empty(), "a tool argument was read as reasoning: {:?}", thought);
        assert!(tokens.is_empty(), "a tool argument was read as text: {:?}", tokens);
        assert_eq!(resp.tool_calls[0].arguments,
            r#"{"reasoning":"not mine","content":"nor this"}"#);
    }

    #[test]
    fn test_stream_acc_text_only() {
        let (resp, tokens) = run_stream(&[
            r#"{"choices":[{"delta":{"role":"assistant","content":"Hel"}}]}"#,
            r#"{"choices":[{"delta":{"content":"lo!"}}]}"#,
            r#"{"choices":[{"delta":{}}],"usage":{"prompt_tokens":7,"completion_tokens":3}}"#,
        ]);
        assert_eq!(tokens, vec!["Hel", "lo!"]);
        assert_eq!(resp.content, "Hello!");
        assert!(resp.tool_calls.is_empty());
        assert_eq!(resp.prompt_tokens, 7);
        assert_eq!(resp.completion_tokens, 3);
        assert!(!resp.aborted);
        // Nothing said about cost or caching, so nothing is claimed.
        assert_eq!(resp.cached_tokens, 0);
        assert_eq!(resp.cost_usd, 0.0);
    }

    #[test]
    fn test_stream_acc_reported_cost_survives_later_chunks() {
        // The usage chunk arrives, and a `"usage":null` chunk follows it before
        // `[DONE]`.  The reported figures must survive that.
        let (resp, _tokens) = run_stream(&[
            r#"{"choices":[{"delta":{"content":"ok"}}],"usage":null}"#,
            r#"{"choices":[],"usage":{"prompt_tokens":8192,"completion_tokens":64,"cost":0.0021,"prompt_tokens_details":{"cached_tokens":7168}}}"#,
            r#"{"choices":[{"delta":{}}],"usage":null}"#,
        ]);
        assert_eq!(resp.prompt_tokens, 8192);
        assert_eq!(resp.cached_tokens, 7168);
        assert_eq!(resp.cost_usd, 0.0021);
    }

    #[test]
    fn test_stream_acc_tool_call_fragments() {
        // The name arrives with the first fragment; the arguments are split
        // across two later fragments and must be concatenated verbatim.
        let (resp, tokens) = run_stream(&[
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"file_read","arguments":""}}]}}]}"#,
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"path\":\""}}]}}]}"#,
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"a.txt\"}"}}]}}]}"#,
            r#"{"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":12,"completion_tokens":8}}"#,
        ]);
        assert!(tokens.is_empty());
        assert_eq!(resp.tool_calls.len(), 1);
        assert_eq!(resp.tool_calls[0].id, "call_1");
        assert_eq!(resp.tool_calls[0].name, "file_read");
        assert_eq!(resp.tool_calls[0].arguments, r#"{"path":"a.txt"}"#);
        assert_eq!(resp.prompt_tokens, 12);
        assert_eq!(resp.completion_tokens, 8);
    }

    #[test]
    fn test_stream_acc_two_parallel_calls() {
        // Two calls interleaved by index across chunks.
        let (resp, _t) = run_stream(&[
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c0","function":{"name":"file_list","arguments":"{}"}}]}}]}"#,
            r#"{"choices":[{"delta":{"tool_calls":[{"index":1,"id":"c1","function":{"name":"file_read","arguments":"{\"path\":"}}]}}]}"#,
            r#"{"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":"\"b.txt\"}"}}]}}]}"#,
        ]);
        assert_eq!(resp.tool_calls.len(), 2);
        assert_eq!(resp.tool_calls[0].name, "file_list");
        assert_eq!(resp.tool_calls[0].arguments, "{}");
        assert_eq!(resp.tool_calls[1].name, "file_read");
        assert_eq!(resp.tool_calls[1].arguments, r#"{"path":"b.txt"}"#);
    }

    #[test]
    fn test_stream_acc_text_then_tool_call() {
        // Interim assistant text streams, then a tool call is requested.
        let (resp, tokens) = run_stream(&[
            r#"{"choices":[{"delta":{"content":"Let me check. "}}]}"#,
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c0","function":{"name":"file_list","arguments":"{}"}}]}}]}"#,
        ]);
        assert_eq!(tokens, vec!["Let me check. "]);
        assert_eq!(resp.content, "Let me check. ");
        assert_eq!(resp.tool_calls.len(), 1);
        assert_eq!(resp.tool_calls[0].name, "file_list");
    }

    #[test]
    fn test_message_to_json_assistant_tool_calls() {
        let msg = ChatMessage::Assistant {
            content: MessageContent::text(""),
            tool_calls: vec![ToolCall {
                id: "c1".to_string(),
                name: "shell".to_string(),
                arguments: r#"{"command":"ls"}"#.to_string(),
            }],
        };
        let j = message_to_json(&msg, &std::collections::HashSet::new());
        assert!(j.contains(r#""role":"assistant""#));
        assert!(j.contains(r#""tool_calls""#));
        assert!(j.contains(r#""name":"shell""#));
        // Arguments must be re-escaped as a JSON string literal.
        assert!(j.contains(r#""arguments":"{\"command\":\"ls\"}""#));
    }

    #[test]
    fn test_datmap_to_json() {
        let mut m = DaticleMap::new();
        m.insert(dat!("role"), dat!("user"));
        m.insert(dat!("content"), dat!("hello"));
        let json = datmap_to_json(&m);
        // Keys are sorted.
        assert!(json.contains("\"content\":\"hello\""));
        assert!(json.contains("\"role\":\"user\""));
    }

    #[test]
    fn test_datmap_to_json_escaped() {
        let mut m = DaticleMap::new();
        m.insert(dat!("content"), dat!("hello \"world\"\n"));
        let json = datmap_to_json(&m);
        assert!(json.contains("\\\"world\\\""));
        assert!(json.contains("\\n"));
    }

    /// **The detail a stored `say` folds does not go over the wire, and the summary does.**
    ///
    /// This was the whole point of the tool, and the tool is gone — so this is now the guard on
    /// what remains of it. A conversation saved before the `<details>` convention still carries
    /// `say` tool_calls, and every one of them is re-sent on every later request for the life of
    /// that conversation. Delete the stripper with the tool and nothing on screen changes: those
    /// answers simply start travelling in full again, and the bill goes up on the conversations
    /// the feature existed to make cheap. The message below is exactly that — an assistant turn
    /// out of an old transcript, built by NAME rather than through any `Tool`, because there is no
    /// longer a variant to build it from.
    ///
    /// BOTH DIALECTS, because they serialise a call in ways that look nothing alike: one escapes
    /// the arguments into a JSON string, the other embeds them as an object. A rule applied at one
    /// site and not the other means the same conversation costs different amounts through
    /// different endpoints, and nothing on screen would say so.
    ///
    /// And a NON-`say` call is asserted to keep its arguments, which is what stops this from being
    /// a stripper aimed at everything: `file_write`'s content has to survive, or a write replayed
    /// to the model becomes a write of a placeholder.
    #[test]
    fn test_a_folded_detail_never_reaches_the_wire() {
        use rustls::crypto::ring;
        let _ = ring::default_provider().install_default();
        let tls = Arc::new(
            ClientConfig::builder()
                .dangerous()
                .with_custom_certificate_verifier(Arc::new(NoVerify))
                .with_no_client_auth()
        );
        const DETAIL: &str = "THE-LONG-EXPLANATION-NOBODY-SHOULD-RESEND";
        const GIST:   &str = "the fence is a path allow-list";
        let msgs = vec![
            ChatMessage::user("explain the fence".to_string()),
            ChatMessage::Assistant {
                content: MessageContent::text(String::new()),
                tool_calls: vec![
                    crate::protocol::ToolCall {
                        id:        fmt!("c1"),
                        name:      fmt!("say"),
                        arguments: fmt!("{{\"summary\":\"{}\",\"detail\":\"{}\"}}", GIST, DETAIL),
                    },
                    crate::protocol::ToolCall {
                        id:        fmt!("c2"),
                        name:      fmt!("file_write"),
                        arguments: fmt!("{{\"path\":\"a.md\",\"content\":\"{}\"}}", DETAIL),
                    },
                ],
            },
        ];
        for (host, path) in [("api.test.com", "/v1/chat"), ("api.anthropic.com", "/v1/messages")] {
            let c = LlmClient::new(host, 443, path, "key", "claude-opus-5", 4096, tls.clone());
            let body = c.build_body(&msgs, None, false);
            assert!(!body.contains(DETAIL) || body.matches(DETAIL).count() == 1,
                "the folded detail is still on the wire via {}: {}", path, body);
            // Exactly once — carried by `file_write`, never by `say`.
            assert_eq!(1, body.matches(DETAIL).count(),
                "via {} the detail appears {} times; it must survive file_write and never say",
                path, body.matches(DETAIL).count());
            assert!(body.contains(GIST), "the summary was stripped too, via {}: {}", path, body);
            assert!(body.contains("folded to the user"),
                "nothing tells the model what became of the detail, via {}: {}", path, body);
        }
    }

    /// **An OPEN fold travels; a closed one does not.**
    ///
    /// The user's own gesture decides the model's working set. A fold they have closed is one they
    /// are done with, and re-sending it every turn buys nothing; a fold they have OPEN is one they
    /// are reading, and the next thing they say is likely to be about it — so the model holds what
    /// they are looking at. Two controls for one idea would be one control too many.
    ///
    /// Asserted BOTH WAYS from the same message, because either half alone is satisfied by a
    /// stripper that is simply broken: always-strip passes the closed case, never-strip passes the
    /// open one.
    #[test]
    fn test_an_open_fold_travels_and_a_closed_one_does_not() {
        use rustls::crypto::ring;
        let _ = ring::default_provider().install_default();
        let tls = Arc::new(ClientConfig::builder().dangerous()
            .with_custom_certificate_verifier(Arc::new(NoVerify)).with_no_client_auth());
        const DETAIL: &str = "THE-DETAIL-BEHIND-THE-FOLD";
        let msgs = vec![
            ChatMessage::user("explain".to_string()),
            ChatMessage::Assistant {
                content: MessageContent::text(String::new()),
                tool_calls: vec![crate::protocol::ToolCall {
                    id:        fmt!("call_7"),
                    name:      fmt!("say"),
                    arguments: fmt!("{{\"summary\":\"the gist\",\"detail\":\"{}\"}}", DETAIL),
                }],
            },
        ];
        for (host, path) in [("api.test.com", "/v1/chat"), ("api.anthropic.com", "/v1/messages")] {
            let c = LlmClient::new(host, 443, path, "key", "claude-opus-5", 4096, tls.clone());

            c.set_open_folds(Vec::new());
            assert!(!c.build_body(&msgs, None, false).contains(DETAIL),
                "a CLOSED fold was sent via {}", path);

            c.set_open_folds(vec![fmt!("call_7")]);
            assert!(c.build_body(&msgs, None, false).contains(DETAIL),
                "an OPEN fold was withheld via {}, so the model cannot see what the user is \
                 reading", path);

            // And closing it again takes it back out, which is what makes this a control rather
            // than a one-way door.
            c.set_open_folds(vec![fmt!("some_other_call")]);
            assert!(!c.build_body(&msgs, None, false).contains(DETAIL),
                "closing a fold did not take it back out of the payload, via {}", path);
        }
    }

    /// **What the compaction trigger measures is what the wire will carry.**
    ///
    /// [`crate::agent::compact::msg_bytes`] sized a `say` with `tc.arguments.len()` -- the full
    /// call as the model wrote it -- while [`strip_said`] takes a closed fold's detail out at
    /// serialisation.  So the trigger measured a conversation nobody was going to send, spent the
    /// budget on bytes that leave on the way out, and folded earlier than it needed to.  The
    /// [`Gauge`](crate::agent::compact::Gauge) absorbed part of that by recalibrating
    /// tokens-per-byte against the provider's real `prompt_tokens`, but the ratio is one number
    /// for the whole conversation, so the correction was paid for by distorting every other
    /// message's estimate.
    ///
    /// Two things are asserted and the second is the one that matters.  A closed fold sizing
    /// smaller than an open one is satisfied by ANY discount, arbitrary or not; that the discount
    /// is exactly the number of bytes serialisation actually saves is satisfied only by asking
    /// the serialiser, which is what [`sent_args_len`] does.
    ///
    /// Both dialects, because the strip applies to both and a sizing that matched one of them
    /// would mean the same conversation folded at different lengths through different endpoints.
    #[test]
    fn test_the_fold_trigger_sizes_what_the_wire_will_carry() {
        use crate::agent::compact::conversation_bytes;
        use rustls::crypto::ring;
        let _ = ring::default_provider().install_default();
        let tls = Arc::new(ClientConfig::builder().dangerous()
            .with_custom_certificate_verifier(Arc::new(NoVerify)).with_no_client_auth());
        // Plain letters and spaces: nothing here is escaped differently from the note that
        // replaces it, so the two bodies differ by the detail and by nothing else.
        let detail = "the long explanation behind the fold ".repeat(40);
        let msgs = vec![
            ChatMessage::user(fmt!("explain")),
            ChatMessage::Assistant {
                content: MessageContent::text(String::new()),
                tool_calls: vec![crate::protocol::ToolCall {
                    id:        fmt!("call_9"),
                    name:      fmt!("say"),
                    arguments: fmt!("{{\"summary\":\"the gist\",\"detail\":\"{}\"}}", detail),
                }],
            },
            ChatMessage::tool(fmt!("call_9"), MessageContent::text(fmt!("Shown."))),
        ];
        let shut = OpenSet::new();
        let open: OpenSet = [fmt!("call_9")].into_iter().collect();
        let sized_shut = conversation_bytes(&msgs, &shut);
        let sized_open = conversation_bytes(&msgs, &open);

        for (host, path) in [("api.test.com", "/v1/chat"), ("api.anthropic.com", "/v1/messages")] {
            let c = LlmClient::new(host, 443, path, "key", "claude-opus-5", 4096, tls.clone());
            c.set_open_folds(Vec::new());
            let wire_shut = c.build_body(&msgs, None, false).len() as u64;
            c.set_open_folds(vec![fmt!("call_9")]);
            let wire_open = c.build_body(&msgs, None, false).len() as u64;

            assert!(wire_shut < wire_open, "the fixture proves nothing via {}: closing the fold \
                did not shrink the payload", path);
            assert!(sized_shut < sized_open,
                "a closed fold is sized as though its detail were still sent, so the trigger \
                folds a conversation of {} bytes that goes out as {} (via {})",
                sized_shut, wire_shut, path);
            assert_eq!(sized_open - sized_shut, wire_open - wire_shut,
                "the sizer books {} bytes for closing the fold and the wire saves {} (via {}), \
                so the trigger is measuring a rule of its own rather than the serialiser's",
                sized_open - sized_shut, wire_open - wire_shut, path);
        }
    }

    #[test]
    fn test_build_request_body() {
        use rustls::crypto::ring;
        let _ = ring::default_provider().install_default();
        let tls = Arc::new(
            ClientConfig::builder()
                .dangerous()
                .with_custom_certificate_verifier(Arc::new(NoVerify))
                .with_no_client_auth()
        );
        let client = LlmClient::new("api.test.com", 443, "/v1/chat", "key", "model", 4096, tls);
        let messages = vec![
            ChatMessage::system("You are helpful".to_string()),
            ChatMessage::user("Hello".to_string()),
        ];
        let body = client.build_request_body(&messages);
        assert!(body.contains("\"model\":\"model\""));
        assert!(body.contains("\"stream\":true"));
        assert!(body.contains("\"role\":\"system\""));
        assert!(body.contains("\"role\":\"user\""));
        assert!(body.contains("\"content\":\"You are helpful\""));
        assert!(body.contains("\"content\":\"Hello\""));
    }

    /// No routing set: no `provider` object at all -- OpenRouter's own free choice, and the
    /// shape every existing request keeps.
    #[test]
    fn test_no_provider_routing_set_sends_no_provider_field_00() {
        use rustls::crypto::ring;
        let _ = ring::default_provider().install_default();
        let tls = Arc::new(ClientConfig::builder().dangerous()
            .with_custom_certificate_verifier(Arc::new(NoVerify)).with_no_client_auth());
        let client = LlmClient::new("openrouter.ai", 443, "/api/v1/chat/completions",
            "key", "z-ai/glm-5.3", 4096, tls);
        let body = client.build_request_body(&[ChatMessage::user("hi".to_string())]);
        assert!(!body.contains("\"provider\""), "an unset routing must send nothing: {}", body);
    }

    /// A routing preference reaches OpenRouter as its own `provider` object, `order` before
    /// `ignore`, with no name hard-coded on this side -- both came from `set_provider_routing`.
    #[test]
    fn test_provider_routing_reaches_openrouter_as_order_and_ignore_00() {
        use rustls::crypto::ring;
        let _ = ring::default_provider().install_default();
        let tls = Arc::new(ClientConfig::builder().dangerous()
            .with_custom_certificate_verifier(Arc::new(NoVerify)).with_no_client_auth());
        let client = LlmClient::new("openrouter.ai", 443, "/api/v1/chat/completions",
            "key", "z-ai/glm-5.3", 4096, tls);
        client.set_provider_routing(" Novita , Together ", "DeepInfra", false);
        let body = client.build_request_body(&[ChatMessage::user("hi".to_string())]);
        assert!(body.contains("\"provider\":{\"order\":[\"Novita\",\"Together\"],\
            \"ignore\":[\"DeepInfra\"]},"), "the routing object was not built as expected: {}", body);
        assert!(!body.contains("allow_fallbacks"), "`only` was false and must send nothing: {}", body);
    }

    /// `only` sends `allow_fallbacks:false`; whitespace-only entries are dropped rather than
    /// sent as an empty provider name.
    #[test]
    fn test_provider_routing_only_refuses_every_fallback_00() {
        use rustls::crypto::ring;
        let _ = ring::default_provider().install_default();
        let tls = Arc::new(ClientConfig::builder().dangerous()
            .with_custom_certificate_verifier(Arc::new(NoVerify)).with_no_client_auth());
        let client = LlmClient::new("openrouter.ai", 443, "/api/v1/chat/completions",
            "key", "z-ai/glm-5.3", 4096, tls);
        client.set_provider_routing("Novita, ,", "", true);
        let body = client.build_request_body(&[ChatMessage::user("hi".to_string())]);
        assert!(body.contains("\"order\":[\"Novita\"]"), "a blank entry was not dropped: {}", body);
        assert!(!body.contains("\"ignore\""), "an empty ignore list must not appear at all: {}", body);
        assert!(body.contains("\"allow_fallbacks\":false"), "only was true: {}", body);
    }

    /// A DIRECT provider never sees the `provider` object, whatever routing is set: it is an
    /// OpenRouter-only field and this app must never guess a direct API would ignore it.
    #[test]
    fn test_provider_routing_is_inert_off_openrouter_00() {
        use rustls::crypto::ring;
        let _ = ring::default_provider().install_default();
        let tls = Arc::new(ClientConfig::builder().dangerous()
            .with_custom_certificate_verifier(Arc::new(NoVerify)).with_no_client_auth());
        let client = LlmClient::new("api.openai.com", 443, "/v1/chat/completions",
            "key", "gpt-5", 4096, tls);
        client.set_provider_routing("Novita", "DeepInfra", true);
        let body = client.build_request_body(&[ChatMessage::user("hi".to_string())]);
        assert!(!body.contains("\"provider\""),
            "routing set for OpenRouter reached a direct provider's own request: {}", body);
    }

    // ┌───────────────────────────────────────────────────────────────┐
    // │ Retry — pure parts                                             │
    // └───────────────────────────────────────────────────────────────┘

    #[test]
    fn test_status_retryable() {
        // Which statuses mean "not now" and which mean "not ever" is HTTP's
        // answer, not ours: 429 carries Retry-After and 5xx is the server's own
        // trouble, while every other 4xx describes this request.
        for code in [429u16, 500, 502, 503, 504, 529] {
            assert!(status_retryable(code), "{} should be retryable", code);
        }
        for code in [400u16, 401, 403, 404, 413, 422] {
            assert!(!status_retryable(code), "{} must NOT be retried", code);
        }
    }

    #[test]
    fn test_parse_retry_after() {
        // The delta-seconds form, which is what a provider sends.
        assert_eq!(parse_retry_after("2"), Some(2_000));
        assert_eq!(parse_retry_after("  30 "), Some(30_000));
        assert_eq!(parse_retry_after("0"), Some(0));
        // The HTTP-date form is not understood, and reads as absent rather than
        // as zero -- a zero would retry instantly against a provider that asked
        // for a minute.
        assert_eq!(parse_retry_after("Wed, 21 Oct 2026 07:28:00 GMT"), None);
        assert_eq!(parse_retry_after(""), None);
    }

    #[test]
    fn test_status_code_and_header_value() {
        assert_eq!(status_code("HTTP/1.1 429 Too Many Requests"), Some(429));
        assert_eq!(status_code("HTTP/1.1 200 OK"), Some(200));
        assert_eq!(status_code("garbage"), None);
        let head = "HTTP/1.1 429 Too Many Requests\r\nRetry-After: 3\r\nContent-Length: 0\r\n";
        assert_eq!(header_value(head, "retry-after"), Some("3".to_string()));
        assert_eq!(header_value(head, "RETRY-AFTER"), Some("3".to_string()));
        assert_eq!(header_value(head, "x-absent"), None);
    }

    #[test]
    fn test_backoff_grows_jitters_and_is_capped() {
        let p = RetryPolicy { max_attempts: 6, base_ms: 100, max_backoff_ms: 400,
            max_total_wait_ms: 10_000 };
        // Equal jitter: every delay sits in the top half of its nominal window,
        // so it is neither instant nor in lockstep with another worker's.
        let mut spread = std::collections::BTreeSet::new();
        for _ in 0..64 {
            let d = p.delay_ms(1, None);
            assert!((50..=100).contains(&d), "first backoff out of band: {}", d);
            spread.insert(d);
        }
        assert!(spread.len() > 1, "no jitter: eight workers would retry in lockstep");
        for _ in 0..16 {
            assert!((100..=200).contains(&p.delay_ms(2, None)));
            assert!((200..=400).contains(&p.delay_ms(3, None)));
            // Capped, not doubled forever.
            assert!((200..=400).contains(&p.delay_ms(9, None)));
        }
    }

    #[test]
    fn test_retry_after_is_honoured_and_never_shortened() {
        let p = RetryPolicy::default();
        for _ in 0..32 {
            let d = p.delay_ms(1, Some(3_000));
            // The provider is the one party that knows when it will be ready, so
            // its figure is a floor -- jitter is only ever added to it.
            assert!(d >= 3_000, "Retry-After was shortened to {}", d);
            assert!(d <= 3_000 + RETRY_AFTER_JITTER_MS);
        }
    }

    #[test]
    fn test_attempts_and_total_wait_are_both_bounded() {
        let p = RetryPolicy { max_attempts: 3, base_ms: 100, max_backoff_ms: 100,
            max_total_wait_ms: 10_000 };
        assert!(p.next_delay(0, 0, None).is_some());
        assert!(p.next_delay(1, 0, None).is_some());
        // Three attempts means two retries.
        assert!(p.next_delay(2, 0, None).is_none());
        // And a backoff that would push the total past its bound ends the
        // attempt, however many are left -- the user is watching a spinner.
        assert!(p.next_delay(0, 9_990, None).is_none());
        assert!(p.next_delay(0, 0, Some(60_000)).is_none());
    }

    // ┌───────────────────────────────────────────────────────────────┐
    // │ Prompt caching                                                 │
    // └───────────────────────────────────────────────────────────────┘

    // ┌───────────────────────────────────────────────────────────────┐
    // │ Anthropic — the direct path books its own cost                 │
    // └───────────────────────────────────────────────────────────────┘

    #[test]
    fn test_anthropic_list_price_looks_up_by_bare_id_and_dated_suffix() {
        assert_eq!(5.00, anthropic_list_price_usd("claude-opus-5", 1_000_000, 0, 0));
        // The provider prefix a picker writes is not part of the price table's own key.
        assert_eq!(5.00, anthropic_list_price_usd("anthropic/claude-opus-5", 1_000_000, 0, 0));
        // A dated snapshot prices as its bare model, exactly as `pricing.js`'s own aliases do.
        assert_eq!(25.00, anthropic_list_price_usd("claude-opus-4-5-20251101", 0, 1_000_000, 0));
        // The cached share is a SUBSET of `prompt`, billed at the cheaper rate; a wholly-cached
        // prompt prices at the cached rate alone, not at the fresh one on top of it.
        let got = anthropic_list_price_usd("claude-opus-5", 1_000_000, 0, 1_000_000);
        assert!((got - 0.50).abs() < 1e-9, "a fully-cached prompt should price at $0.50: {}", got);
    }

    #[test]
    fn test_an_unpriced_model_books_nothing_rather_than_a_guess() {
        // Zero already means "not measured" everywhere else `cost_usd` is read; a wrong guess at
        // an unknown model's rate would be worse than the honest zero it would replace.
        assert_eq!(0.0, anthropic_list_price_usd("some-future-model", 1_000_000, 1_000_000, 0));
    }

    #[test]
    fn test_model_caches_on_request() {
        // Claude is the model family that needs an explicit breakpoint, in every
        // id form a caller can configure.
        assert!(model_caches_on_request("anthropic/claude-opus-5"));
        assert!(model_caches_on_request("claude-sonnet-5"));
        assert!(model_caches_on_request("anthropic.claude-opus-5"));
        assert!(model_caches_on_request("us.anthropic.claude-haiku-4.5"));
        assert!(model_caches_on_request("ANTHROPIC/CLAUDE-OPUS-5"));
        // Everything else caches automatically or not at all, and must not be
        // sent a marker it did not ask for.
        assert!(!model_caches_on_request("accounts/fireworks/models/glm-5p2"));
        assert!(!model_caches_on_request("openai/gpt-5.4"));
        assert!(!model_caches_on_request("deepseek/deepseek-v3"));
        assert!(!model_caches_on_request("google/gemini-3.1-pro-preview"));
        assert!(!model_caches_on_request("x-ai/grok-4.5"));
    }

    /// A system prompt long enough to be worth caching.
    fn long_system() -> String {
        "You are a careful assistant. ".repeat(120)
    }

    #[test]
    fn test_cache_breakpoints_for_a_claude_model() {
        let client = test_client("openrouter.ai", 443, "anthropic/claude-opus-5");
        let messages = vec![
            ChatMessage::system(long_system()),
            ChatMessage::user("Hello".to_string()),
        ];
        let body = client.build_body(&messages, None, true);
        // The system message carries a breakpoint, in the content-block form the
        // marker can only live on.
        assert!(body.contains("\"role\":\"system\",\"content\":[{\"type\":\"text\""),
            "system message did not become a content block: {}", body);
        // Two breakpoints: the stable system prefix, and the tip of the settled
        // conversation for the next turn to read back.
        assert_eq!(body.matches("\"cache_control\":{\"type\":\"ephemeral\"}").count(), 2,
            "expected a system and a user breakpoint: {}", body);
        assert!(body.contains("\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"Hello\""));
    }

    #[test]
    fn test_no_cache_control_for_a_model_that_does_not_take_it() {
        let client = test_client("api.fireworks.ai", 443, "accounts/fireworks/models/glm-5p2");
        let messages = vec![
            ChatMessage::system(long_system()),
            ChatMessage::user("Hello".to_string()),
        ];
        let body = client.build_body(&messages, None, true);
        assert!(!body.contains("cache_control"),
            "a marker reached a provider that never asked for one: {}", body);
        // And the message shape is untouched: plain string content, as before.
        assert!(body.contains("\"role\":\"user\",\"content\":\"Hello\""));
    }

    #[test]
    fn test_a_prefix_too_short_to_cache_gets_no_breakpoint() {
        // Below Anthropic's minimum cacheable prefix nothing is stored, and the
        // provider says nothing about having declined -- so the marker is simply
        // not sent.
        let client = test_client("openrouter.ai", 443, "anthropic/claude-opus-5");
        let messages = vec![
            ChatMessage::system("Be brief.".to_string()),
            ChatMessage::user("Hi".to_string()),
        ];
        assert!(!client.build_body(&messages, None, true).contains("cache_control"));
    }

    #[test]
    fn test_tool_definitions_count_towards_the_cacheable_prefix() {
        // The tools render ahead of the system message, so a large tool array is
        // itself most of what the breakpoint caches.
        let client = test_client("openrouter.ai", 443, "anthropic/claude-opus-5");
        let messages = vec![ChatMessage::system("Be brief.".to_string())];
        assert!(!client.build_body(&messages, None, true).contains("cache_control"));
        let tools = "[".to_string() + &"x".repeat(CACHE_MIN_PREFIX_CHARS) + "]";
        assert!(client.build_body(&messages, Some(&tools), true).contains("cache_control"));
    }

    #[test]
    fn test_the_second_breakpoint_follows_the_conversation() {
        // Several turns in, the second breakpoint sits on the LAST user message,
        // so everything settled before it is read from the cache next round.
        let client = test_client("openrouter.ai", 443, "anthropic/claude-opus-5");
        let messages = vec![
            ChatMessage::system(long_system()),
            ChatMessage::user("first".to_string()),
            ChatMessage::assistant("ok".to_string()),
            ChatMessage::user("second".to_string()),
        ];
        let body = client.build_body(&messages, None, true);
        assert!(body.contains("\"text\":\"second\",\"cache_control\""),
            "breakpoint is not on the latest user turn: {}", body);
        assert!(!body.contains("\"text\":\"first\",\"cache_control\""),
            "a stale breakpoint was left on an earlier turn: {}", body);
        assert_eq!(body.matches("cache_control").count(), 2);
    }

    /// A conversation whose LAST message is a tool result, as every round after the first tool
    /// call actually looks: `run_tool_loop` sends the calls and their results straight back
    /// without appending a fresh user message.
    #[test]
    fn test_the_last_breakpoint_lands_on_the_latest_tool_result() {
        let client = test_client("openrouter.ai", 443, "anthropic/claude-opus-5");
        let messages = vec![
            ChatMessage::system(long_system()),
            ChatMessage::user("read the file and fix it".to_string()),
            ChatMessage::assistant_calling("".to_string(),
                vec![ToolCall { id: "c1".to_string(), name: "file_read".to_string(),
                    arguments: "{}".to_string() }]),
            ChatMessage::tool("c1".to_string(), "line one\nline two\n".to_string()),
        ];
        let body = client.build_anthropic_body(&messages, None, true);
        assert!(body.contains("\"type\":\"tool_result\""), "no tool_result block at all: {}", body);
        assert!(body.contains("\"content\":\"line one\\nline two\\n\",\"cache_control\""),
            "the breakpoint is not on the tool result: {}", body);
        assert!(!body.contains("\"text\":\"read the file and fix it\",\"cache_control\""),
            "a stale breakpoint was left on the turn's own user message: {}", body);
        // Never more than the API's own ceiling of four, and here exactly the two this body
        // earns: the system prefix, and the tip now sitting on the tool result.
        let marks = body.matches("\"cache_control\":{\"type\":\"ephemeral\"}").count();
        assert!(marks <= 4, "over Anthropic's own breakpoint ceiling: {} in {}", marks, body);
        assert_eq!(2, marks, "expected exactly a system and a tool-result breakpoint: {}", body);
    }

    /// A run of SEVERAL tool results in one round still marks only the last of them -- the block
    /// the marker lands on must be the final entry of the merged `pending` array, which is what
    /// the API requires the marker to sit on.
    #[test]
    fn test_only_the_last_of_several_tool_results_in_one_round_is_marked() {
        let client = test_client("openrouter.ai", 443, "anthropic/claude-opus-5");
        let messages = vec![
            ChatMessage::system(long_system()),
            ChatMessage::user("read both files".to_string()),
            ChatMessage::assistant_calling("".to_string(), vec![
                ToolCall { id: "c1".to_string(), name: "file_read".to_string(),
                    arguments: "{}".to_string() },
                ToolCall { id: "c2".to_string(), name: "file_read".to_string(),
                    arguments: "{}".to_string() },
            ]),
            ChatMessage::tool("c1".to_string(), "first file".to_string()),
            ChatMessage::tool("c2".to_string(), "second file".to_string()),
        ];
        let body = client.build_anthropic_body(&messages, None, true);
        assert!(body.contains("\"content\":\"second file\",\"cache_control\""),
            "the LAST tool result of the round is not marked: {}", body);
        assert!(!body.contains("\"content\":\"first file\",\"cache_control\""),
            "an earlier tool result in the same round was marked too: {}", body);
    }

    /// The same fix, on the OTHER dialect: a Claude model reached through an OpenAI-shaped
    /// router (the `cur` arm's own path) gets the same moved breakpoint, because
    /// `cache_breakpoints` is the one function both builders call.
    #[test]
    fn test_the_last_breakpoint_lands_on_a_tool_result_through_the_router_too() {
        let client = test_client("openrouter.ai", 443, "anthropic/claude-opus-5");
        let messages = vec![
            ChatMessage::system(long_system()),
            ChatMessage::user("read the file and fix it".to_string()),
            ChatMessage::assistant_calling("".to_string(),
                vec![ToolCall { id: "c1".to_string(), name: "file_read".to_string(),
                    arguments: "{}".to_string() }]),
            ChatMessage::tool("c1".to_string(), "line one\nline two\n".to_string()),
        ];
        let body = client.build_body(&messages, None, true);
        assert!(body.contains("\"role\":\"tool\",\"tool_call_id\":\"c1\",\"content\":[{\"type\":\"text\""),
            "the tool message did not take the array form the marker needs: {}", body);
        assert!(body.contains("\"cache_control\""), "no breakpoint reached the tool result: {}", body);
        assert_eq!(2, body.matches("\"cache_control\":{\"type\":\"ephemeral\"}").count());
    }

    #[test]
    fn test_a_marked_message_still_round_trips_its_escapes() {
        let client = test_client("openrouter.ai", 443, "anthropic/claude-opus-5");
        let messages = vec![
            ChatMessage::system(long_system() + "say \"hi\"\n"),
        ];
        let body = client.build_body(&messages, None, true);
        assert!(body.contains("say \\\"hi\\\"\\n"), "escapes broke: {}", body);
    }

    // ┌───────────────────────────────────────────────────────────────┐
    // │ Anthropic — dialect, request shape, headers                    │
    // └───────────────────────────────────────────────────────────────┘

    #[test]
    fn test_the_dialect_is_chosen_by_the_endpoint_not_the_model() {
        // The same Claude model is reachable both ways, so the model id cannot
        // decide this; the endpoint can, and does.
        assert_eq!(Dialect::for_endpoint("api.anthropic.com", "/v1/messages"),
            Dialect::Anthropic);
        assert_eq!(Dialect::for_endpoint("API.Anthropic.Com", "/v1/messages/"),
            Dialect::Anthropic);
        // A proxy in front of the Messages API is still speaking it.
        assert_eq!(Dialect::for_endpoint("gateway.example.com", "/proxy/v1/messages"),
            Dialect::Anthropic);
        // And a router serving a Claude model over chat completions is not.
        assert_eq!(Dialect::for_endpoint("openrouter.ai", "/api/v1/chat/completions"),
            Dialect::OpenAi);
        assert_eq!(Dialect::for_endpoint("api.fireworks.ai", "/inference/v1/chat/completions"),
            Dialect::OpenAi);
    }

    #[test]
    fn test_the_auth_headers_differ_by_dialect() {
        // Anthropic refuses a bearer token, wants a pinned version, and answers
        // a browser only when asked to.
        let anth = test_client_at("api.anthropic.com", 443, "/v1/messages", "claude-opus-5");
        let native: Vec<String> = anth.auth_headers(false).iter()
            .map(|(k, v)| fmt!("{}: {}", k, v)).collect();
        assert!(native.iter().any(|h| h == "x-api-key: key"), "{:?}", native);
        assert!(native.iter().any(|h| h == &fmt!("anthropic-version: {}", ANTHROPIC_VERSION)),
            "{:?}", native);
        assert!(!native.iter().any(|h| h.starts_with("Authorization")),
            "a bearer token reached the Messages API: {:?}", native);
        assert!(!native.iter().any(|h| h.contains("dangerous-direct-browser-access")),
            "the browser header was sent from a transport that is not one: {:?}", native);
        let browser: Vec<String> = anth.auth_headers(true).iter()
            .map(|(k, v)| fmt!("{}: {}", k, v)).collect();
        assert!(browser.iter().any(|h| h == "anthropic-dangerous-direct-browser-access: true"),
            "without this header the browser call never leaves CORS: {:?}", browser);

        // And the OpenAI side is untouched, in either transport.
        let oai = test_client("openrouter.ai", 443, "anthropic/claude-opus-5");
        for browser in [false, true] {
            let hs: Vec<String> = oai.auth_headers(browser).iter()
                .map(|(k, v)| fmt!("{}: {}", k, v)).collect();
            assert!(hs.iter().any(|h| h == "Authorization: Bearer key"), "{:?}", hs);
            assert!(!hs.iter().any(|h| h.starts_with("anthropic-")),
                "an Anthropic header reached an OpenAI endpoint: {:?}", hs);
        }
    }

    /// A client speaking the Messages API to Anthropic.
    fn anth_client(model: &str) -> LlmClient {
        test_client_at("api.anthropic.com", 443, "/v1/messages", model)
    }

    // ── Images on the wire ───────────────────────────────────────────────────
    //
    // The fixtures below are NOT what this code produces; they are what the two providers publish,
    // copied out of their own documents, and every one of them says where it came from.  A
    // serialisation test written the other way round -- build with our encoder, read with our
    // parser -- proves only that the two halves agree with each other, which they would go on
    // doing while both were wrong.

    /// The one-pixel PNG from Anthropic's vision documentation, base64 exactly as printed there.
    ///
    /// Source: `platform.claude.com/docs/en/build-with-claude/vision`, the "Multiple images"
    /// example, `image1_data`.  Using the provider's own bytes rather than bytes of this test's
    /// invention means the encoder is checked against a string a provider published, not against
    /// itself.
    const DOC_PNG_B64: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nG\
                               P4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

    /// Those bytes, decoded.
    fn doc_png() -> Vec<u8> {
        oxedyne_fe2o3_text::base64::decode(DOC_PNG_B64).expect("the documented base64 must decode")
    }

    /// An image part holding the documented PNG.
    fn doc_image(source: &str) -> ImagePart {
        ImagePart::new(ImageMedia::Png, doc_png(), source.to_string())
    }

    /// The base64 encoder agrees with the provider on the provider's own bytes.
    ///
    /// The fixtures below all embed [`DOC_PNG_B64`]; if the encoder disagreed with Anthropic about
    /// how those bytes are spelled, every one of them would fail for a reason that had nothing to
    /// do with the shape being tested.  This isolates that.
    #[test]
    fn test_the_base64_encoding_matches_the_providers_own_string() {
        let bytes = doc_png();
        assert!(!bytes.is_empty(), "the documented base64 decoded to nothing");
        assert_eq!(DOC_PNG_B64, oxedyne_fe2o3_text::base64::encode(&bytes),
            "our base64 disagrees with the string Anthropic published for these bytes");
    }

    /// An Anthropic image block is the block Anthropic documents.
    ///
    /// Fixture source: `platform.claude.com/docs/en/build-with-claude/vision`, "Base64-encoded
    /// image example", the cURL request body -- `{"type":"image","source":{"type":"base64",
    /// "media_type":…,"data":…}}`, in that key order.
    #[test]
    fn test_an_anthropic_image_block_is_the_documented_shape() {
        let want = fmt!(
            "{{\"type\":\"image\",\"source\":{{\"type\":\"base64\",\"media_type\":\"image/png\",\
             \"data\":\"{}\"}}}}", DOC_PNG_B64);
        let client = anth_client("claude-opus-5");
        let msgs = vec![ChatMessage::user(MessageContent::parts(vec![
            ContentPart::Image(doc_image("shots/after.png")),
            ContentPart::Text("Describe this image.".to_string()),
        ]))];
        let body = client.build_anthropic_body(&msgs, None, true);
        assert!(body.contains(&want), "the image block is not the documented one.\nwant: {}\ngot:  {}",
            want, body);
        // The image precedes the text, as the documentation recommends and as the part order says.
        let img = body.find("\"type\":\"image\"").expect("no image block");
        let txt = body.find("Describe this image.").expect("no text block");
        assert!(img < txt, "the parts were reordered");
    }

    /// An OpenAI image part is the part OpenAI documents.
    ///
    /// Fixture source: OpenAI's own OpenAPI specification, schema
    /// `ChatCompletionRequestMessageContentPartImage` -- `type` is the constant `"image_url"`, and
    /// `image_url.url` is documented as "URL of the image. This can be a URL or a base64 encoded
    /// data URL".  The data URL itself is RFC 2397 syntax, `data:<media-type>;base64,<data>`.
    /// `detail` is optional and defaults to `"auto"`, so it is not sent.
    #[test]
    fn test_an_openai_image_part_is_the_documented_shape() {
        let want = fmt!(
            "{{\"type\":\"image_url\",\"image_url\":{{\"url\":\"data:image/png;base64,{}\"}}}}",
            DOC_PNG_B64);
        let client = test_client("api.example.com", 443, "gpt-5.6");
        let msgs = vec![ChatMessage::user(MessageContent::parts(vec![
            ContentPart::Text("What is in this image?".to_string()),
            ContentPart::Image(doc_image("shots/after.png")),
        ]))];
        let body = client.build_openai_body(&msgs, None, true);
        assert!(body.contains(&want), "the image part is not the documented one.\nwant: {}\ngot:  {}",
            want, body);
        assert!(body.contains("\"content\":[{\"type\":\"text\",\"text\":\"What is in this image?\"}"),
            "an image turns the content into the documented parts array: {}", body);
    }

    /// A message with no image keeps the bare-string content it always had.
    ///
    /// The parts array is legal for text too, and switching every message to it would have been
    /// simpler -- and would have changed the bytes of every request every router has ever been
    /// sent, for nothing.
    #[test]
    fn test_text_only_content_stays_a_bare_string_on_both_sides() {
        let msgs = vec![ChatMessage::user("Hello".to_string())];
        let openai = test_client("api.example.com", 443, "gpt-5.6")
            .build_openai_body(&msgs, None, true);
        assert!(openai.contains("{\"role\":\"user\",\"content\":\"Hello\"}"),
            "text content grew an array: {}", openai);
        let anth = anth_client("claude-opus-5").build_anthropic_body(&msgs, None, true);
        assert!(anth.contains("{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"Hello\"}]}"),
            "the Anthropic user turn is not the block form it always was: {}", anth);
    }

    /// Anthropic takes an image inside a `tool_result`; OpenAI does not, and the image is re-homed
    /// into a `user` turn after the run of tool replies rather than dropped.
    ///
    /// Source for the asymmetry: Anthropic's `tool_result` content is documented as a string or an
    /// array of text and image blocks; OpenAI's tool-message content part union
    /// (`ChatCompletionRequestToolMessageContentPart`) has a text member and no image member.
    #[test]
    fn test_a_tool_result_image_rides_the_reply_on_one_side_and_a_user_turn_on_the_other() {
        let msgs = vec![
            ChatMessage::user("look at the page".to_string()),
            ChatMessage::assistant_calling("", vec![ToolCall {
                id: "call_1".to_string(),
                name: "file_read".to_string(),
                arguments: r#"{"path":"shots/after.png"}"#.to_string(),
            }]),
            ChatMessage::tool("call_1".to_string(), MessageContent::parts(vec![
                ContentPart::Text("Read the image shots/after.png.".to_string()),
                ContentPart::Image(doc_image("shots/after.png")),
            ])),
        ];

        let anth = anth_client("claude-opus-5").build_anthropic_body(&msgs, None, true);
        assert!(anth.contains("\"type\":\"tool_result\",\"tool_use_id\":\"call_1\",\"content\":["),
            "the Anthropic tool result should carry blocks: {}", anth);
        let result_at = anth.find("tool_result").expect("no tool_result");
        let image_at  = anth.find("\"type\":\"image\"").expect("no image block");
        assert!(image_at > result_at, "the image left the tool result it belongs to");

        let openai = test_client("api.example.com", 443, "gpt-5.6")
            .build_openai_body(&msgs, None, true);
        // The tool reply itself is text only -- the API has nowhere else to put an image.
        let tool_msg = openai.find("\"role\":\"tool\"").expect("no tool message");
        let img_at   = openai.find("image_url").expect("the image was dropped");
        assert!(img_at > tool_msg, "an image_url was put inside the tool reply");
        assert!(openai[tool_msg..img_at].contains("\"role\":\"user\""),
            "the image should be re-homed into a user turn after the run: {}", openai);
    }

    /// A cache breakpoint survives a message that ends in an image.
    ///
    /// The marker caches everything up to the block it sits on. If it could only go on a text
    /// block, a user turn whose last part is the screenshot would carry no marker at all and the
    /// whole prefix would be re-billed on every round of the turn -- silently, since nothing
    /// fails.
    #[test]
    fn test_a_cache_breakpoint_survives_a_message_that_ends_in_an_image() {
        let ends_in_image = MessageContent::parts(vec![
            ContentPart::Text("here".to_string()),
            ContentPart::Image(doc_image("shots/after.png")),
        ]);
        let blocks = anthropic_blocks(&ends_in_image, true);
        assert_eq!(2, blocks.len());
        assert!(!blocks[0].contains("cache_control"),
            "the marker must be on the LAST block, not the first: {}", blocks[0]);
        assert!(blocks[1].contains("\"cache_control\":{\"type\":\"ephemeral\"}"),
            "a message ending in an image lost its cache breakpoint: {}", blocks[1]);

        // And the marker is not attached when the message is not a breakpoint.
        let plain = anthropic_blocks(&ends_in_image, false);
        assert!(!plain.iter().any(|b| b.contains("cache_control")));
    }

    /// A model on the known-blind list is refused before the request is built, by name.
    #[test]
    fn test_a_model_that_cannot_see_is_refused_by_name() {
        let client = test_client("api.example.com", 443, "openai/gpt-3.5-turbo-0125");
        let msgs = vec![ChatMessage::user(MessageContent::parts(vec![
            ContentPart::Image(doc_image("shots/after.png")),
        ]))];
        let e = client.vision_guard(&msgs).expect_err("a blind model must be refused");
        let msg = fmt!("{}", e);
        assert!(msg.contains("gpt-3.5-turbo-0125"), "the refusal must name the model: {}", msg);
        assert!(msg.contains("cannot see"), "the refusal must say what is wrong: {}", msg);
        // And a turn with no image goes through on the same model, because the model is only
        // unusable for the thing it cannot do.
        assert_eq!(0, client.vision_guard(&[ChatMessage::user("hi".to_string())])
            .expect("text must still be allowed"));
    }

    /// THE CLIENT'S OWN REASON MUST LEAVE THIS MODULE, because the browser's does not survive
    /// the crossing intact and is not the same on two browsers.
    ///
    /// A failed `fetch` reads `TypeError: Failed to fetch` in Chromium and `TypeError: Load
    /// failed` in WebKit for the identical event. `www/js/daimond.js` decides from that string
    /// whether to hand a turn back with a Continue button or write it off, so while only `err`
    /// crossed, that decision was a property of the browser. `crossed` puts `reason` -- which is
    /// this file's wording and is the same everywhere -- in front of it.
    #[test]
    fn test_a_transport_failure_carries_its_reason_out_of_this_module() {
        // The exact shape of the iOS case: the fetch never got a response, and the browser's
        // own sentence is the only thing in the error.
        let e = TransportErr::transient(
            "could not reach the provider".to_string(),
            err!("LLM: fetch failed: TypeError: Load failed."; IO, Network, Wire));
        let out = fmt!("{}", e.crossed());
        assert!(out.contains("could not reach the provider"),
            "the client's own reason did not cross: {}", out);
        assert!(out.contains("Load failed"),
            "the provider's -- or the browser's -- own words must survive with it: {}", out);
        // And a failure that is the PROVIDER answering carries a reason that says so, which is
        // what keeps the app from reading a 429 as a dead road.
        let e = TransportErr::fatal(
            "the provider returned HTTP 400".to_string(),
            err!("LLM: HTTP error: 400 Bad Request | context length exceeded"; IO, Network, Wire));
        let out = fmt!("{}", e.crossed());
        assert!(out.contains("the provider returned HTTP 400"), "{}", out);
        // `compact::looks_like_overflow` reads this text, so the body detail must still be in it.
        assert!(out.contains("context length"),
            "the refusal's own body was lost, and overflow detection reads it: {}", out);
    }

    /// A model NOT on the list is allowed through -- the list is of what is known blind, not of
    /// what is known to see, so a model released tomorrow is not refused today.
    #[test]
    fn test_an_unknown_model_is_assumed_to_see() {
        assert!(model_can_see("some-vendor/brand-new-model-9"));
        assert!(model_can_see("claude-opus-5"));
        assert!(!model_can_see("gpt-3.5-turbo"));
        assert!(!model_can_see("anthropic/claude-2.1"));
    }

    /// When the provider refuses a turn that carried images and its words are about images, the
    /// error names the model and says it cannot see -- with the provider's own sentence kept.
    #[test]
    fn test_a_provider_refusal_about_images_is_rewritten_to_name_the_model() {
        let client = test_client("api.example.com", 443, "some-router/mystery-model");
        let raw = err!("HTTP error: 400 Bad Request: invalid_request_error: \
                        this model does not support image_url content"; Invalid, Input);
        let out = fmt!("{}", client.vision_error(raw, 1));
        assert!(out.contains("some-router/mystery-model"), "the model must be named: {}", out);
        assert!(out.contains("not to see"), "it must say what is wrong: {}", out);
        assert!(out.contains("400 Bad Request"), "the provider's own words must survive: {}", out);
    }

    /// A failure unrelated to images is handed back untouched, even on a turn that carried one.
    #[test]
    fn test_an_unrelated_failure_is_not_blamed_on_the_images() {
        let client = test_client("api.example.com", 443, "some-router/mystery-model");
        let raw = err!("HTTP error: 401 Unauthorized"; Invalid, Input);
        let out = fmt!("{}", client.vision_error(raw, 1));
        assert!(out.contains("401 Unauthorized"), "the provider's words were lost: {}", out);
        assert!(!out.contains("not to see"),
            "an unrelated failure was rewritten as a vision failure: {}", out);
        assert!(!out.contains("mystery-model"),
            "an unrelated failure was rewritten as a vision failure: {}", out);
    }

    #[test]
    fn test_the_system_prompt_is_hoisted_out_of_the_messages() {
        // The Messages API has no system role: a system message left in the
        // array is a 400, and one silently dropped is an agent with no rules.
        let client = anth_client("claude-opus-5");
        let msgs = vec![
            ChatMessage::system(long_system()),
            ChatMessage::system("And be brief.".to_string()),
            ChatMessage::user("Hello".to_string()),
        ];
        let body = client.build_anthropic_body(&msgs, None, true);
        assert!(body.contains("\"system\":[{\"type\":\"text\""),
            "no top-level system field: {}", body);
        assert!(!body.contains("\"role\":\"system\""),
            "a system message was left in the array: {}", body);
        // Both of them, joined, rather than only the last.
        assert!(body.contains("And be brief."), "the second system message was lost: {}", body);
        assert!(body.contains("You are a careful assistant."), "{}", body);
    }

    #[test]
    fn test_the_breakpoints_land_on_the_anthropic_blocks() {
        // The marker only exists on a content block, and the Messages API's
        // blocks are in different places from the OpenAI ones.
        let client = anth_client("claude-opus-5");
        let msgs = vec![
            ChatMessage::system(long_system()),
            ChatMessage::user("first".to_string()),
            ChatMessage::assistant("ok".to_string()),
            ChatMessage::user("second".to_string()),
        ];
        let body = client.build_anthropic_body(&msgs, None, true);
        assert_eq!(body.matches("\"cache_control\":{\"type\":\"ephemeral\"}").count(), 2,
            "expected a system and a user breakpoint: {}", body);
        assert!(body.contains("\"text\":\"second\",\"cache_control\""),
            "the second breakpoint is not on the latest user turn: {}", body);
        assert!(!body.contains("\"text\":\"first\",\"cache_control\""),
            "a stale breakpoint was left on an earlier turn: {}", body);
        // The system block carries the other one.
        let sys_end = match body.find("}],\"messages\"") {
            Some(p) => p,
            None    => panic!("no system block: {}", body),
        };
        assert!(body[..sys_end].contains("cache_control"),
            "the system prefix -- the largest stable block there is -- is uncached: {}", body);
    }

    #[test]
    fn test_a_model_that_does_not_cache_gets_no_marker_on_this_path_either() {
        // The gate is the model id, and it must still be the model id here.
        let client = test_client_at("api.example.com", 443, "/v1/messages", "some-other-model");
        let msgs = vec![
            ChatMessage::system(long_system()),
            ChatMessage::user("Hello".to_string()),
        ];
        let body = client.build_anthropic_body(&msgs, None, true);
        assert!(!body.contains("cache_control"),
            "a marker reached a model that never asked for one: {}", body);
    }

    #[test]
    fn test_a_run_of_tool_results_becomes_one_user_message() {
        // Two parallel tool calls produce two `Tool` messages in a row.  The
        // Messages API wants both results as blocks of a SINGLE user turn;
        // sending two consecutive user messages is a different conversation.
        let client = anth_client("claude-opus-5");
        let msgs = vec![
            ChatMessage::user("list and read".to_string()),
            ChatMessage::Assistant {
                content: MessageContent::text(""),
                tool_calls: vec![
                    ToolCall { id: "t1".to_string(), name: "file_list".to_string(),
                        arguments: "{}".to_string() },
                    ToolCall { id: "t2".to_string(), name: "file_read".to_string(),
                        arguments: r#"{"path":"a.txt"}"#.to_string() },
                ],
            },
            ChatMessage::tool("t1".to_string(), "a.txt".to_string()),
            ChatMessage::tool("t2".to_string(), "hello".to_string()),
        ];
        let body = client.build_anthropic_body(&msgs, None, false);
        assert_eq!(body.matches("\"role\":\"user\"").count(), 2,
            "the two tool results did not coalesce into one turn: {}", body);
        assert_eq!(body.matches("\"type\":\"tool_result\"").count(), 2, "{}", body);
        assert!(body.contains("\"tool_use_id\":\"t1\""), "{}", body);
        assert!(body.contains("\"tool_use_id\":\"t2\""), "{}", body);
        // And the assistant turn's calls are `tool_use` blocks whose input is a
        // JSON OBJECT -- the OpenAI form is a string, and sending that is a 400.
        assert!(body.contains("\"type\":\"tool_use\",\"id\":\"t2\",\"name\":\"file_read\",\
            \"input\":{\"path\":\"a.txt\"}"),
            "the arguments were not carried as an object: {}", body);
    }

    #[test]
    fn test_tool_definitions_are_translated_to_the_anthropic_shape() {
        let tools = r#"[{"type":"function","function":{"name":"file_read",
            "description":"Read a file","parameters":{"type":"object","properties":{
            "path":{"type":"string","description":"name"}},"required":["path"]}}}]"#;
        let out = openai_tools_to_anthropic(tools);
        assert!(out.contains("\"name\":\"file_read\""), "{}", out);
        assert!(out.contains("\"description\":\"Read a file\""),
            "the description was read from the schema instead of the function: {}", out);
        assert!(out.contains("\"input_schema\":{\"type\":\"object\""),
            "the schema is not under input_schema: {}", out);
        assert!(!out.contains("\"parameters\""), "the OpenAI wrapper survived: {}", out);
        assert!(!out.contains("\"type\":\"function\""), "{}", out);
        // A definition with no schema is dropped rather than sent half-built.
        assert_eq!(openai_tools_to_anthropic(r#"[{"type":"function","function":{"name":"x"}}]"#),
            "[]");
    }

    #[test]
    fn test_thinking_is_asked_for_only_where_it_is_taken() {
        // `budget_tokens` is a 400 on every model since Opus 4.7, and adaptive
        // is a 400 on the ones before Opus 4.6 -- so the gate is a list, not a
        // family test.
        for id in ["claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6",
                   "claude-sonnet-5", "claude-sonnet-4-6", "claude-fable-5", "claude-mythos-5",
                   "anthropic/claude-opus-5", "us.anthropic.claude-sonnet-5-v1"] {
            assert!(model_takes_adaptive_thinking(id), "{} takes adaptive thinking", id);
        }
        for id in ["claude-haiku-4-5", "claude-sonnet-4-5", "claude-opus-4-5", "claude-3-opus",
                   "accounts/fireworks/models/glm-5p2", "openai/gpt-5.4"] {
            assert!(!model_takes_adaptive_thinking(id), "{} must not be sent adaptive", id);
        }
        // And the request follows the gate.
        let msgs = [ChatMessage::user("Hi".to_string())];
        let on = anth_client("claude-opus-5").build_anthropic_body(&msgs, None, true);
        assert!(on.contains("\"thinking\":{\"type\":\"adaptive\",\"display\":\"summarized\"}"),
            "{}", on);
        assert!(!on.contains("budget_tokens"), "a removed parameter was sent: {}", on);
        let off = anth_client("claude-haiku-4-5").build_anthropic_body(&msgs, None, true);
        assert!(!off.contains("thinking"), "{}", off);
    }

    /// The tune reaches the Anthropic body, and the OpenAI one never learns of it.
    #[test]
    fn test_the_thinking_tune_reaches_the_anthropic_body_and_not_the_openai_one() {
        let msgs = [ChatMessage::user("Hi".to_string())];

        // Untuned: what the client sent before either was a setting, plus the effort the API
        // itself defaults to -- written out so the wire says what was asked for.
        let c = anth_client("claude-opus-5");
        let dflt = c.build_anthropic_body(&msgs, None, true);
        assert!(dflt.contains("\"thinking\":{\"type\":\"adaptive\",\"display\":\"summarized\"}"),
            "{}", dflt);
        assert!(dflt.contains("\"output_config\":{\"effort\":\"high\"}"), "{}", dflt);

        // Tuned deeper: the level goes out and the thinking request is untouched.
        c.set_thinking(Thinking::Adaptive, Effort::XHigh);
        let deep = c.build_anthropic_body(&msgs, None, true);
        assert!(deep.contains("\"output_config\":{\"effort\":\"xhigh\"}"), "{}", deep);
        assert!(deep.contains("\"type\":\"adaptive\""), "{}", deep);

        // OFF, at an effort where Opus 5 accepts being switched off.  Sent as `disabled`
        // rather than as an absent field: omitting it on this model runs adaptive.
        c.set_thinking(Thinking::Off, Effort::High);
        let off = c.build_anthropic_body(&msgs, None, true);
        assert!(off.contains("\"thinking\":{\"type\":\"disabled\"}"), "{}", off);
        assert!(!off.contains("adaptive"), "{}", off);
        // And with the reasoning gone, the output cap is the configured one again rather than
        // the floor a thinking turn needs.
        assert!(off.contains("\"max_tokens\":4096"), "{}", off);

        // THE SAME SETTING ON THE OPENAI DIALECT CHANGES NOTHING.  There is no field this app
        // has ever sent there and nowhere to hand a signed block back, so a request that
        // carried one would be asking for something it could not replay next round.
        let router = test_client("openrouter.ai", 443, "anthropic/claude-opus-5");
        router.set_thinking(Thinking::Off, Effort::Max);
        let openai = router.build_body(&msgs, None, true);
        assert!(!openai.contains("thinking"), "{}", openai);
        assert!(!openai.contains("output_config"), "{}", openai);
        assert!(!openai.contains("effort"), "{}", openai);
        assert!(!openai.contains("reasoning"), "{}", openai);
    }

    /// A level or a switch the model would answer a 400 to is not sent.
    #[test]
    fn test_a_thinking_setting_the_model_refuses_is_withheld_rather_than_guessed_at() {
        let msgs = [ChatMessage::user("Hi".to_string())];

        // OPUS 5 ABOVE EFFORT `high`: `{"type":"disabled"}` is a 400 there.  Nothing is sent,
        // the model reasons anyway, and the output cap makes room for it -- which is the half
        // that would fail silently, by truncating the answer.
        let c = anth_client("claude-opus-5");
        c.set_thinking(Thinking::Off, Effort::Max);
        let body = c.build_anthropic_body(&msgs, None, true);
        assert!(!body.contains("disabled"), "a 400 was sent rather than withheld: {}", body);
        assert!(body.contains(&fmt!("\"max_tokens\":{}", THINKING_MIN_MAX_TOKENS)),
            "a model that thinks anyway was capped at the answer-only figure: {}", body);
        assert!(body.contains("\"output_config\":{\"effort\":\"max\"}"), "{}", body);

        // FABLE THINKS WHATEVER IT IS TOLD, at every effort.
        assert!(model_always_thinks("claude-fable-5"));
        assert!(model_always_thinks("claude-mythos-5"));
        assert!(!model_always_thinks("claude-opus-5"));
        let f = anth_client("claude-fable-5");
        f.set_thinking(Thinking::Off, Effort::Low);
        let fable = f.build_anthropic_body(&msgs, None, true);
        assert!(!fable.contains("disabled"), "{}", fable);
        assert!(fable.contains(&fmt!("\"max_tokens\":{}", THINKING_MIN_MAX_TOKENS)), "{}", fable);

        // `xhigh` ARRIVED WITH OPUS 4.7, so the two 4.6 models are sent no level at all
        // rather than one they did not choose.
        let old = anth_client("claude-sonnet-4-6");
        old.set_thinking(Thinking::Adaptive, Effort::XHigh);
        let refused = old.build_anthropic_body(&msgs, None, true);
        assert!(!refused.contains("output_config"), "{}", refused);
        old.set_thinking(Thinking::Adaptive, Effort::Max);
        assert!(old.build_anthropic_body(&msgs, None, true)
            .contains("\"output_config\":{\"effort\":\"max\"}"));

        // AND A MODEL THAT DOES NOT THINK IS SENT NEITHER FIELD: `output_config.effort` errors
        // on Haiku 4.5 and everything older.
        let h = anth_client("claude-haiku-4-5");
        h.set_thinking(Thinking::Adaptive, Effort::High);
        let haiku = h.build_anthropic_body(&msgs, None, true);
        assert!(!haiku.contains("thinking"), "{}", haiku);
        assert!(!haiku.contains("output_config"), "{}", haiku);
    }

    /// The spellings `set_tune` reads, and the ones it must refuse.
    #[test]
    fn test_the_thinking_spellings_round_trip_and_a_typo_is_refused() {
        for t in [Thinking::Adaptive, Thinking::Off] {
            assert_eq!(Some(t), Thinking::from_wire(t.wire()));
        }
        for e in [Effort::Low, Effort::Medium, Effort::High, Effort::XHigh, Effort::Max] {
            assert_eq!(Some(e), Effort::from_wire(e.wire()));
        }
        // `disabled` is the API's own word for it and is taken as well as `off`.
        assert_eq!(Some(Thinking::Off), Thinking::from_wire("disabled"));
        // A typo is None rather than a silent default, so an arm that measured the shipped
        // engine cannot report that it measured something else.
        assert_eq!(None, Thinking::from_wire("adpative"));
        assert_eq!(None, Effort::from_wire("xxhigh"));
        assert_eq!(None, Effort::from_wire(""));
        // The one ceiling that is part of the setting rather than of the model.
        assert!(Effort::High.at_most_high());
        assert!(!Effort::XHigh.at_most_high());
        assert!(!Effort::Max.at_most_high());
    }

    /// A tuned effort does not cost the turn its signed reasoning.
    ///
    /// The carry is what makes a thinking tool round legal at all (see [`ThinkCarry`]), and it
    /// is held on the client beside the tune -- so a setter that replaced the wrong cell, or a
    /// body builder that stopped consulting `carry_get` once it had a second field to write,
    /// would produce a request the API rejects on every round after the first.
    #[test]
    fn test_a_tuned_turn_still_hands_its_thinking_back_with_the_tool_results() {
        let c = anth_client("claude-opus-5");
        c.set_thinking(Thinking::Adaptive, Effort::XHigh);
        c.carry_put("toolu_1", vec![
            r#"{"type":"thinking","thinking":"Euclid first.","signature":"SIG-1"}"#.to_string(),
        ]);
        let round_two = vec![
            ChatMessage::user("read a.txt".to_string()),
            ChatMessage::Assistant {
                content:    MessageContent::text(""),
                tool_calls: vec![ToolCall {
                    id:        "toolu_1".to_string(),
                    name:      "file_read".to_string(),
                    arguments: r#"{"path":"a.txt"}"#.to_string(),
                }],
            },
            ChatMessage::tool("toolu_1".to_string(), "hello".to_string()),
        ];
        let body = c.build_anthropic_body(&round_two, None, true);
        assert!(body.contains("\"signature\":\"SIG-1\""),
            "the tune cost the turn its signed thinking: {}", body);
        assert!(body.contains("\"output_config\":{\"effort\":\"xhigh\"}"), "{}", body);
        let think_at = match body.find("\"type\":\"thinking\"") {
            Some(p) => p,
            None    => panic!("no thinking block in the assistant turn: {}", body),
        };
        let call_at = match body.find("\"type\":\"tool_use\"") {
            Some(p) => p,
            None    => panic!("no tool_use block: {}", body),
        };
        assert!(think_at < call_at, "the reasoning must precede the call it produced: {}", body);
    }

    #[test]
    fn test_an_empty_message_does_not_become_an_empty_block() {
        // The Messages API rejects a text block with no text, where the OpenAI
        // side carries the empty string through without comment.  One stray
        // empty user message would then fail every turn of the conversation.
        let client = anth_client("claude-opus-5");
        let msgs = vec![
            ChatMessage::user("hello".to_string()),
            ChatMessage::assistant(String::new()),
            ChatMessage::user(String::new()),
        ];
        let body = client.build_anthropic_body(&msgs, None, true);
        assert!(!body.contains("\"text\":\"\""), "an empty text block was sent: {}", body);
        // And the assistant turn that says nothing and asks for nothing is left
        // out entirely rather than sent as a message with no content.
        assert_eq!(body.matches("\"role\":\"assistant\"").count(), 0, "{}", body);
        assert!(body.contains("\"text\":\"hello\""), "{}", body);
    }

    #[test]
    fn test_a_thinking_turn_is_given_room_for_the_reasoning_and_the_answer() {
        // `max_tokens` caps thinking AND the reply together here, and the app's
        // internal default is 4096 -- chosen when it only ever meant the reply.
        // Left alone, a hard question is answered with a truncated sentence.
        let msgs = [ChatMessage::user("Hi".to_string())];
        let c = anth_client("claude-opus-5");
        assert_eq!(c.max_tokens, 4096, "the fixture no longer reflects the app's default");
        let streamed = c.build_anthropic_body(&msgs, None, true);
        assert!(streamed.contains(&fmt!("\"max_tokens\":{}", THINKING_MIN_MAX_TOKENS)),
            "a streamed thinking turn was capped at the answer-only figure: {}", streamed);
        // The one-shot path keeps the configured cap: a big one there is a long
        // silence on an open connection, which is how a request times out.
        let once = c.build_anthropic_body(&msgs, None, false);
        assert!(once.contains("\"max_tokens\":4096"), "{}", once);
        // And a model that does not think is not given the extra room either.
        let plain = anth_client("claude-haiku-4-5").build_anthropic_body(&msgs, None, true);
        assert!(plain.contains("\"max_tokens\":4096"), "{}", plain);
    }

    #[test]
    fn test_the_openai_body_is_unchanged_by_all_this() {
        // The regression that matters most: five providers already work through
        // the other dialect, and none of them may notice this.
        let client = test_client("openrouter.ai", 443, "anthropic/claude-opus-5");
        let msgs = vec![
            ChatMessage::system(long_system()),
            ChatMessage::user("Hello".to_string()),
        ];
        let body = client.build_body(&msgs, None, true);
        assert!(body.contains("\"stream_options\":{\"include_usage\":true}"), "{}", body);
        assert!(body.contains("\"role\":\"system\""), "{}", body);
        assert!(!body.contains("\"system\":["), "{}", body);
        assert!(!body.contains("\"thinking\""), "{}", body);
        assert!(!body.contains("input_schema"), "{}", body);
    }

    // ┌───────────────────────────────────────────────────────────────┐
    // │ Anthropic — the event stream                                   │
    // └───────────────────────────────────────────────────────────────┘

    /// Drive a sequence of Anthropic SSE payloads through a fresh accumulator.
    fn run_anth(chunks: &[&str]) -> (AnthropicAcc, Vec<String>) {
        let mut acc = AnthropicAcc::default();
        let mut tokens = Vec::new();
        for c in chunks {
            acc.ingest(c, &mut text_sink(&mut tokens));
        }
        (acc, tokens)
    }

    /// The same, keeping the working rather than the answer.
    fn run_anth_thinking(chunks: &[&str]) -> (AnthropicAcc, Vec<String>) {
        let mut acc = AnthropicAcc::default();
        let mut thought = Vec::new();
        for c in chunks {
            acc.ingest(c, &mut think_sink(&mut thought));
        }
        (acc, thought)
    }

    #[test]
    fn test_the_anthropic_stream_rebuilds_text_and_tool_calls() {
        // The documented event sequence, verbatim from the streaming reference.
        let (acc, tokens) = run_anth(&[
            r#"{"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":472,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":2}}}"#,
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#,
            r#"{"type":"ping"}"#,
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Okay"}}"#,
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":", checking"}}"#,
            r#"{"type":"content_block_stop","index":0}"#,
            r#"{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"get_weather","input":{}}}"#,
            r#"{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"location\":"}}"#,
            r#"{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":" \"Paris\"}"}}"#,
            r#"{"type":"content_block_stop","index":1}"#,
            r#"{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":89}}"#,
            r#"{"type":"message_stop"}"#,
        ]);
        assert_eq!(tokens, vec!["Okay", ", checking"]);
        let resp = acc.into_response(false, 0);
        assert_eq!(resp.content, "Okay, checking");
        assert_eq!(resp.tool_calls.len(), 1);
        assert_eq!(resp.tool_calls[0].id, "toolu_1");
        assert_eq!(resp.tool_calls[0].name, "get_weather");
        assert_eq!(resp.tool_calls[0].arguments, r#"{"location": "Paris"}"#);
        // The `message_delta` counts are CUMULATIVE and name only what changed:
        // taking them wholesale would zero the input side of the bill.
        assert_eq!(resp.prompt_tokens, 472);
        assert_eq!(resp.completion_tokens, 89);
    }

    #[test]
    fn test_the_whole_prompt_is_counted_and_the_cache_read_named() {
        // Anthropic's `input_tokens` EXCLUDES what it read from and wrote to the
        // cache; this client's `prompt` means every prompt token processed, and
        // the ledger prices `prompt - cached` at the fresh rate.  Reading
        // `input_tokens` straight across would bill a 90%-cached turn as if the
        // cache were not there at all.
        let (acc, _t) = run_anth(&[
            r#"{"type":"message_start","message":{"usage":{"input_tokens":120,"cache_creation_input_tokens":40,"cache_read_input_tokens":9000,"output_tokens":1}}}"#,
            r#"{"type":"message_delta","delta":{},"usage":{"output_tokens":64}}"#,
        ]);
        let resp = acc.into_response(false, 0);
        assert_eq!(resp.prompt_tokens, 9160, "the cached prefix is part of the prompt");
        assert_eq!(resp.cached_tokens, 9000);
        assert_eq!(resp.completion_tokens, 64);
        // Anthropic reports no money, so nothing is claimed about it.
        assert_eq!(resp.cost_usd, 0.0);
    }

    #[test]
    fn test_thinking_streams_are_kept_but_never_handed_over_as_the_answer() {
        let (acc, tokens) = run_anth(&[
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}"#,
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Euclid: 1071 = 2 x 462 + 147"}}"#,
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"EqQBCgIYAhIM"}}"#,
            r#"{"type":"content_block_stop","index":0}"#,
            r#"{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}"#,
            r#"{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"21."}}"#,
        ]);
        // The reasoning is not the reply: a caller that streamed it into the
        // message would persist the model's working out as its answer.
        assert_eq!(tokens, vec!["21."], "thinking reached the token sink: {:?}", tokens);
        // And it IS handed over, as its own kind, while the round is still running.
        // Held back until the round ended, a model that thinks for a minute and a half
        // is a minute and a half of blank spinner.
        let (_a2, thought) = run_anth_thinking(&[
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}"#,
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Euclid: 1071 = 2 x 462 + 147"}}"#,
            r#"{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"21."}}"#,
        ]);
        assert_eq!(thought, vec!["Euclid: 1071 = 2 x 462 + 147"],
            "the working did not reach the reasoning sink: {:?}", thought);
        let blocks = acc.thinking_blocks();
        assert_eq!(blocks.len(), 1, "the signed block was not kept for replay");
        assert!(blocks[0].contains("\"signature\":\"EqQBCgIYAhIM\""), "{}", blocks[0]);
        assert!(blocks[0].contains("1071 = 2 x 462 + 147"), "{}", blocks[0]);
        let resp = acc.into_response(false, 0);
        assert_eq!(resp.content, "21.");
        assert_eq!(resp.thinking, "Euclid: 1071 = 2 x 462 + 147",
            "the reasoning was neither shown nor accounted for");
    }

    #[test]
    fn test_an_unsigned_thinking_run_is_not_replayed() {
        // A stream cut before its `signature_delta` leaves a block the API will
        // not verify.  The run must match what the model generated, so half of
        // it is worse than none: sending it is a 400 on every following turn.
        let (acc, _t) = run_anth(&[
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}"#,
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"half a thought"}}"#,
        ]);
        assert!(acc.thinking_blocks().is_empty(),
            "an unsigned block was queued for replay");
    }

    #[test]
    fn test_a_redacted_thinking_block_is_replayed_verbatim() {
        let (acc, _t) = run_anth(&[
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"redacted_thinking","data":"EroBCkYIAxgCKkB"}}"#,
        ]);
        let blocks = acc.thinking_blocks();
        assert_eq!(blocks.len(), 1);
        assert!(blocks[0].contains("\"data\":\"EroBCkYIAxgCKkB\""),
            "an opaque block was rebuilt rather than replayed: {}", blocks[0]);
    }

    #[test]
    fn test_a_stream_error_event_is_not_read_as_an_answer() {
        // An overload arrives INSIDE a 200 stream here, not as a status code.
        // Read as a short answer it would end the turn silently and wrongly.
        let (acc, _t) = run_anth(&[
            r#"{"type":"message_start","message":{"usage":{"input_tokens":10}}}"#,
            r#"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#,
        ]);
        let wrapped = Acc::Anthropic(acc);
        let e = match wrapped.stream_error() {
            Some(e) => e,
            None    => panic!("the error event was swallowed"),
        };
        assert!(e.retryable, "an overload is the provider saying 'not now'");
        assert!(e.reason.contains("overloaded_error"), "{}", e.reason);
        // A complaint about the request is not retried, exactly as for a 400.
        let (bad, _t) = run_anth(&[
            r#"{"type":"error","error":{"type":"invalid_request_error","message":"bad"}}"#,
        ]);
        let e = match Acc::Anthropic(bad).stream_error() {
            Some(e) => e,
            None    => panic!("the error event was swallowed"),
        };
        assert!(!e.retryable, "a malformed request was queued for another attempt");
    }

    #[test]
    fn test_a_whole_anthropic_response_parses() {
        let body = r#"{"id":"msg_1","type":"message","role":"assistant","model":"claude-opus-5",
            "content":[{"type":"thinking","thinking":"work","signature":"sig1"},
            {"type":"text","text":"Here you are."},
            {"type":"tool_use","id":"toolu_9","name":"file_read","input":{"path":"a.txt"}}],
            "stop_reason":"tool_use",
            "usage":{"input_tokens":100,"cache_read_input_tokens":900,"output_tokens":12}}"#;
        let (content, calls, use_, thinking) = parse_anthropic_response(body);
        assert_eq!(content, "Here you are.");
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "file_read");
        assert_eq!(calls[0].arguments, r#"{"path":"a.txt"}"#);
        assert_eq!(use_.prompt, 1000);
        assert_eq!(use_.cached, 900);
        assert_eq!(use_.completion, 12);
        assert_eq!(thinking.len(), 1);
        assert!(thinking[0].contains("\"signature\":\"sig1\""), "{}", thinking[0]);
    }

    // ┌───────────────────────────────────────────────────────────────┐
    // │ A real HTTPS server to retry against                           │
    // └───────────────────────────────────────────────────────────────┘
    //
    // Not a mock of the client's own idea of a provider: a TCP listener, a TLS
    // handshake, an HTTP/1.1 status line and a chunked SSE body.  What the
    // client does with a 429 is then observed rather than asserted about.

    /// One scripted reply from the stub provider.
    #[derive(Clone)]
    pub enum Reply {
        /// A complete response: status line, headers, body.
        Http {
            status:  u16,
            reason:  &'static str,
            headers: Vec<(&'static str, String)>,
            body:    String,
        },
        /// A chunked `text/event-stream` body.  `reset_after` cuts the
        /// connection with an RST once that many chunks have gone out, which is
        /// what a provider dropping mid-answer looks like on the wire.
        Sse {
            chunks:      Vec<String>,
            reset_after: Option<usize>,
        },
        /// A chunked stream that sends `chunks` and then goes silent for `idle_ms` before
        /// closing normally, never reaching `[DONE]` in between -- what a provider that has
        /// stopped generating but not yet closed the connection looks like on the wire (see
        /// proposal 15, 2026-09-15: `generation_time` 83.7 s against an app that waited 318).
        Stall {
            chunks:  Vec<String>,
            idle_ms: u64,
        },
        /// Accept the connection, send NO status line and NO headers, then hold the socket
        /// open silently for `idle_ms` before closing -- what a provider that took the request
        /// and then never answered looks like on the wire.  The client's first-byte watchdog,
        /// not this close, should decide when the attempt ends.  Distinct from `Stall`, which
        /// answers with headers and some body before going quiet; here nothing arrives at all.
        Hang {
            idle_ms: u64,
        },
    }

    impl Reply {
        /// A 429, optionally with the provider's own `Retry-After`.
        fn too_many(retry_after: Option<u64>) -> Self {
            let mut headers = vec![("Content-Type", "application/json".to_string())];
            if let Some(s) = retry_after {
                headers.push(("Retry-After", fmt!("{}", s)));
            }
            Self::Http {
                status: 429, reason: "Too Many Requests", headers,
                body: "{\"error\":{\"message\":\"rate limited\"}}".to_string(),
            }
        }

        /// A 500, the provider's own trouble.
        fn server_error() -> Self {
            Self::Http {
                status: 500, reason: "Internal Server Error", headers: Vec::new(),
                body: "{\"error\":{\"message\":\"upstream fell over\"}}".to_string(),
            }
        }

        /// A 400, this request being wrong.
        fn bad_request() -> Self {
            Self::Http {
                status: 400, reason: "Bad Request", headers: Vec::new(),
                body: "{\"error\":{\"message\":\"unknown field\"}}".to_string(),
            }
        }

        /// A 404 with a body that says nothing about images -- which is the case that mattered:
        /// `vision_error` can only rewrite a refusal whose words mention pictures, and a bare
        /// 404 gives it nothing to work with.
        fn not_found() -> Self {
            Self::Http {
                status: 404, reason: "Not Found", headers: Vec::new(),
                body: "{\"error\":{\"message\":\"No endpoint found\"}}".to_string(),
            }
        }

        /// A whole answer, streamed as two deltas and a usage chunk.
        fn answer() -> Self {
            Self::Sse {
                chunks: vec![
                    "data: {\"choices\":[{\"delta\":{\"content\":\"Hello\"}}]}\n\n".to_string(),
                    "data: {\"choices\":[{\"delta\":{\"content\":\" world\"}}]}\n\n".to_string(),
                    "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":11,\"completion_tokens\":2,\
                        \"cost\":0.0003,\"prompt_tokens_details\":{\"cached_tokens\":9}}}\n\n".to_string(),
                    "data: [DONE]\n\n".to_string(),
                ],
                reset_after: None,
            }
        }

        /// An Anthropic turn that thinks, then asks for a tool.
        fn anth_thinks_then_calls() -> Self {
            Self::Sse {
                chunks: vec![
                    "event: message_start\ndata: {\"type\":\"message_start\",\"message\":\
                        {\"id\":\"msg_1\",\"usage\":{\"input_tokens\":30,\
                        \"cache_read_input_tokens\":900,\"output_tokens\":1}}}\n\n".to_string(),
                    "event: content_block_start\ndata: {\"type\":\"content_block_start\",\
                        \"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\",\
                        \"signature\":\"\"}}\n\n".to_string(),
                    "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\
                        \"index\":0,\"delta\":{\"type\":\"thinking_delta\",\
                        \"thinking\":\"I should read the file.\"}}\n\n".to_string(),
                    "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\
                        \"index\":0,\"delta\":{\"type\":\"signature_delta\",\
                        \"signature\":\"SIGNATURE-1\"}}\n\n".to_string(),
                    "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\
                        \"index\":0}\n\n".to_string(),
                    "event: content_block_start\ndata: {\"type\":\"content_block_start\",\
                        \"index\":1,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_1\",\
                        \"name\":\"file_read\",\"input\":{}}}\n\n".to_string(),
                    "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\
                        \"index\":1,\"delta\":{\"type\":\"input_json_delta\",\
                        \"partial_json\":\"{\\\"path\\\":\\\"a.txt\\\"}\"}}\n\n".to_string(),
                    "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\
                        \"index\":1}\n\n".to_string(),
                    "event: message_delta\ndata: {\"type\":\"message_delta\",\
                        \"delta\":{\"stop_reason\":\"tool_use\"},\
                        \"usage\":{\"output_tokens\":40}}\n\n".to_string(),
                    "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n".to_string(),
                ],
                reset_after: None,
            }
        }

        /// A second thinking-plus-tool round, with its own signature and call id.
        fn anth_thinks_then_calls_again() -> Self {
            match Self::anth_thinks_then_calls() {
                Self::Sse { chunks, reset_after } => Self::Sse {
                    chunks: chunks.iter()
                        .map(|c| c.replace("SIGNATURE-1", "SIGNATURE-2")
                                  .replace("toolu_1", "toolu_2"))
                        .collect(),
                    reset_after,
                },
                other => other,
            }
        }

        /// An Anthropic turn that just answers.
        fn anth_answer() -> Self {
            Self::Sse {
                chunks: vec![
                    "event: message_start\ndata: {\"type\":\"message_start\",\"message\":\
                        {\"id\":\"msg_2\",\"usage\":{\"input_tokens\":60,\
                        \"output_tokens\":1}}}\n\n".to_string(),
                    "event: content_block_start\ndata: {\"type\":\"content_block_start\",\
                        \"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n"
                        .to_string(),
                    "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\
                        \"index\":0,\"delta\":{\"type\":\"text_delta\",\
                        \"text\":\"It says hello.\"}}\n\n".to_string(),
                    "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\
                        \"index\":0}\n\n".to_string(),
                    "event: message_delta\ndata: {\"type\":\"message_delta\",\
                        \"delta\":{\"stop_reason\":\"end_turn\"},\
                        \"usage\":{\"output_tokens\":8}}\n\n".to_string(),
                    "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n".to_string(),
                ],
                reset_after: None,
            }
        }
    }

    /// What the stub provider saw, readable once the turn is over.
    #[derive(Default)]
    pub struct Seen {
        /// One entry per accepted connection, holding the request body.
        pub bodies: Vec<String>,
    }

    /// A self-signed certificate and key for the stub, generated once.
    ///
    /// Real TLS, because the native transport has no other mode -- the client is
    /// exercised through exactly the path a provider gets.
    fn stub_cert() -> &'static (Vec<u8>, Vec<u8>) {
        static CERT: std::sync::OnceLock<(Vec<u8>, Vec<u8>)> = std::sync::OnceLock::new();
        CERT.get_or_init(|| {
            // Under the user cache, not the tmpfs at `/tmp`. The key is written to
            // disk for as long as openssl takes to write it, and a private key in a
            // tmpfs is a private key in the machine's memory.
            let dir = match oxedyne_fe2o3_test::scratch::scratch_dir("daimond_llm_cert") {
                Ok(d)  => d,
                Err(e) => panic!("could not make a cert directory: {}", e),
            };
            let cert = dir.join("cert.pem");
            let key = dir.join("key.pem");
            let out = std::process::Command::new("openssl")
                // P-256, because the test verifier below advertises
                // `ECDSA_NISTP256_SHA256` and TLS 1.3 will not sign an RSA
                // certificate with any scheme it also advertises.
                .args(["req", "-x509", "-newkey", "ec",
                       "-pkeyopt", "ec_paramgen_curve:prime256v1",
                       "-nodes", "-days", "1", "-subj", "/CN=localhost"])
                .arg("-keyout").arg(&key)
                .arg("-out").arg(&cert)
                .output();
            let out = match out {
                Ok(o)  => o,
                // Loudly, rather than skipping: a check that quietly does not run
                // is a check that proves nothing.
                Err(e) => panic!("openssl is required for the stub provider: {}", e),
            };
            assert!(out.status.success(), "openssl failed: {}",
                String::from_utf8_lossy(&out.stderr));
            let pair = match (std::fs::read(&cert), std::fs::read(&key)) {
                (Ok(c), Ok(k)) => (c, k),
                _ => panic!("openssl wrote no certificate"),
            };
            let _ = std::fs::remove_dir_all(&dir);
            pair
        })
    }

    /// Start the stub provider on an ephemeral port.
    ///
    /// Each connection is served the next reply in `script`; the last one repeats
    /// for as long as the client keeps trying, so "gives up" is observable as a
    /// connection count rather than as a hang.
    pub async fn start_stub(script: Vec<Reply>) -> (u16, Arc<std::sync::Mutex<Seen>>) {
        // THE STUB IS A TLS SERVER AND NEEDS A PROVIDER TOO.  Every client helper here installs
        // one, so in a whole-suite run some earlier test has always installed it process-wide by
        // the time a stub starts, and every stub test passed.  Run one of them ALONE and the
        // server is built first, with nothing installed, and rustls panics -- so
        // `cargo test -- one_test_name` failed for a reason that had nothing to do with the test.
        //
        // That is not a hypothetical: a daimon changed the retry policy, wrote a test for it, and
        // told the user to prove it with exactly that command.  Both it and the test beside it
        // would have failed, and the change would have looked broken.  Idempotent, so installing
        // it here costs nothing where a client got there first.
        let _ = rustls::crypto::ring::default_provider().install_default();
        use tokio_rustls::rustls::ServerConfig;
        use tokio_rustls::rustls::pki_types::CertificateDer;
        use tokio_rustls::TlsAcceptor;

        let (cert_pem, key_pem) = stub_cert();
        let certs: Vec<CertificateDer<'static>> = rustls_pemfile::certs(&mut &cert_pem[..])
            .filter_map(|c| c.ok())
            .collect();
        let key = match rustls_pemfile::private_key(&mut &key_pem[..]) {
            Ok(Some(k)) => k,
            _ => panic!("no private key in the stub's PEM"),
        };
        let cfg = match ServerConfig::builder().with_no_client_auth().with_single_cert(certs, key) {
            Ok(c)  => c,
            Err(e) => panic!("stub TLS config: {}", e),
        };
        let acceptor = TlsAcceptor::from(Arc::new(cfg));

        let listener = match tokio::net::TcpListener::bind(("127.0.0.1", 0)).await {
            Ok(l)  => l,
            Err(e) => panic!("stub listen: {}", e),
        };
        let port = match listener.local_addr() {
            Ok(a)  => a.port(),
            Err(e) => panic!("stub addr: {}", e),
        };
        let seen = Arc::new(std::sync::Mutex::new(Seen::default()));
        let seen_task = seen.clone();

        tokio::spawn(async move {
            let mut n = 0usize;
            loop {
                let (tcp, _) = match listener.accept().await {
                    Ok(v)  => v,
                    Err(_) => return,
                };
                let reply = script[n.min(script.len() - 1)].clone();
                n += 1;
                let acceptor = acceptor.clone();
                let seen = seen_task.clone();
                tokio::spawn(async move {
                    let mut tls = match acceptor.accept(tcp).await {
                        Ok(s)  => s,
                        Err(_) => return,
                    };
                    let body = read_request(&mut tls).await;
                    if let Ok(mut g) = seen.lock() {
                        g.bodies.push(body);
                    }
                    write_reply(&mut tls, &reply).await;
                });
            }
        });
        (port, seen)
    }

    /// Read one HTTP request off the stream and return its body.
    async fn read_request(
        tls: &mut tokio_rustls::server::TlsStream<tokio::net::TcpStream>,
    ) -> String {
        let mut head = Vec::new();
        let mut byte = [0u8; 1];
        loop {
            match tls.read(&mut byte).await {
                Ok(0)  => return String::new(),
                Ok(_)  => {
                    head.push(byte[0]);
                    if head.ends_with(b"\r\n\r\n") { break; }
                }
                Err(_) => return String::new(),
            }
        }
        let head_str = String::from_utf8_lossy(&head).to_string();
        let len: usize = header_value(&head_str, "content-length")
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);
        let mut body = vec![0u8; len];
        let mut got = 0usize;
        while got < len {
            match tls.read(&mut body[got..]).await {
                Ok(0)  => break,
                Ok(n)  => got += n,
                Err(_) => break,
            }
        }
        String::from_utf8_lossy(&body[..got]).to_string()
    }

    /// Serve one scripted reply.
    async fn write_reply(
        tls: &mut tokio_rustls::server::TlsStream<tokio::net::TcpStream>,
        reply: &Reply,
    ) {
        match reply {
            Reply::Http { status, reason, headers, body } => {
                let mut out = fmt!("HTTP/1.1 {} {}\r\n", status, reason);
                for (k, v) in headers {
                    out.push_str(&fmt!("{}: {}\r\n", k, v));
                }
                out.push_str(&fmt!("Content-Length: {}\r\n", body.len()));
                out.push_str("Connection: close\r\n\r\n");
                out.push_str(body);
                let _ = tls.write_all(out.as_bytes()).await;
                let _ = tls.flush().await;
            }
            Reply::Sse { chunks, reset_after } => {
                let head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\
                    Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n";
                let _ = tls.write_all(head.as_bytes()).await;
                let _ = tls.flush().await;
                for (i, chunk) in chunks.iter().enumerate() {
                    if Some(i) == *reset_after {
                        // Abrupt reset: no close_notify, no final chunk -- the
                        // provider vanishing mid-answer.  A reset discards
                        // anything still unacknowledged, so give what has
                        // already gone out time to land first; otherwise the
                        // client never sees the partial and the test proves
                        // nothing about replaying it.
                        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                        let _ = tls.get_ref().0.set_linger(Some(std::time::Duration::ZERO));
                        return;
                    }
                    let framed = fmt!("{:x}\r\n{}\r\n", chunk.len(), chunk);
                    let _ = tls.write_all(framed.as_bytes()).await;
                    let _ = tls.flush().await;
                }
                let _ = tls.write_all(b"0\r\n\r\n").await;
                let _ = tls.flush().await;
            }
            Reply::Stall { chunks, idle_ms } => {
                let head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\
                    Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n";
                let _ = tls.write_all(head.as_bytes()).await;
                let _ = tls.flush().await;
                for chunk in chunks {
                    let framed = fmt!("{:x}\r\n{}\r\n", chunk.len(), chunk);
                    let _ = tls.write_all(framed.as_bytes()).await;
                    let _ = tls.flush().await;
                }
                // Silence past whatever the client's idle watchdog is set to. The connection
                // stays open and nothing more arrives until this sleep ends, at which point
                // the client's own timeout should long since have fired and moved on.
                tokio::time::sleep(std::time::Duration::from_millis(*idle_ms)).await;
                let _ = tls.write_all(b"0\r\n\r\n").await;
                let _ = tls.flush().await;
            }
            Reply::Hang { idle_ms } => {
                // Not a byte of a reply -- no status line, no headers.  Just hold the
                // connection open past whatever the client's first-byte watchdog is set to,
                // so the watchdog and not this close is what ends the attempt.
                tokio::time::sleep(std::time::Duration::from_millis(*idle_ms)).await;
            }
        }
    }

    /// A client pointed at the stub, with a fast retry policy so the suite does
    /// not spend its time asleep.
    pub fn stub_client(port: u16) -> LlmClient {
        let mut client = test_client("localhost", port, "anthropic/claude-opus-5");
        client.retry = RetryPolicy {
            max_attempts:      4,
            base_ms:           20,
            max_backoff_ms:    40,
            max_total_wait_ms: 5_000,
        };
        client
    }

    /// A client with a certificate verifier that accepts the stub's self-signed
    /// certificate, at the OpenAI-compatible path.
    fn test_client(host: &str, port: u16, model: &str) -> LlmClient {
        test_client_at(host, port, "/v1/chat/completions", model)
    }

    /// The same, at an explicit path -- which is what selects the [`Dialect`].
    fn test_client_at(host: &str, port: u16, path: &str, model: &str) -> LlmClient {
        use rustls::crypto::ring;
        let _ = ring::default_provider().install_default();
        let tls = Arc::new(
            ClientConfig::builder()
                .dangerous()
                .with_custom_certificate_verifier(Arc::new(NoVerify))
                .with_no_client_auth()
        );
        LlmClient::new(host, port, path, "key", model, 4096, tls)
    }

    /// How many connections the stub accepted.
    pub fn connections(seen: &Arc<std::sync::Mutex<Seen>>) -> usize {
        match seen.lock() {
            Ok(g)  => g.bodies.len(),
            Err(e) => panic!("stub bookkeeping poisoned: {}", e),
        }
    }

    /// A picture the endpoint will not take costs the pictures, not the turn.
    ///
    /// THE DEFECT. A daimon read a book's cover, the request went to a text-only model, and the
    /// provider answered a bare 404. The turn died -- and the picture stayed in the daimon's
    /// stored conversation, so every later turn re-sent it and died the same way. The Diamond's
    /// daimon was unusable until its whole conversation was thrown away.
    ///
    /// Neither existing guard could have caught it. `model_can_see` is a list of eight ids known
    /// to be blind, so an unheard-of model is assumed sighted; `vision_error` only rewrites a
    /// refusal whose text mentions images, and this one said "No endpoint found".
    #[tokio::test]
    async fn test_a_refused_picture_costs_the_pictures_and_not_the_turn() {
        let (port, seen) = start_stub(vec![
            Reply::not_found(),
            Reply::answer(),
        ]).await;
        let client = stub_client(port);
        let msgs = [ChatMessage::user(MessageContent::parts(vec![
            ContentPart::Text("what is on this cover".to_string()),
            ContentPart::Image(doc_image("cover.png")),
        ]))];
        let mut tokens = Vec::new();
        let resp = match client.chat_stream_tools(&msgs, None, &mut text_sink(&mut tokens)).await {
            Ok(r)  => r,
            Err(e) => panic!("a refused picture must not kill the turn: {}", e),
        };

        assert_eq!(connections(&seen), 2, "the turn was not tried again without the picture");
        assert_eq!(resp.content, "Hello world", "the second attempt did not produce the answer");

        let bodies = match seen.lock() {
            Ok(g)  => g.bodies.clone(),
            Err(e) => panic!("stub bookkeeping poisoned: {}", e),
        };
        // The first attempt carried it, so the failure being recovered from is the real one.
        assert!(bodies[0].contains(DOC_PNG_B64), "the first request did not carry the picture");
        // The second did not, and says why in its place -- a silently dropped image would leave
        // the model describing a cover nobody showed it.
        assert!(!bodies[1].contains(DOC_PNG_B64), "the picture was sent a second time");
        assert!(bodies[1].contains("cannot be shown"),
            "the model was not told the picture was left out: {}", bodies[1]);
        assert!(bodies[1].contains("cover.png"), "the file was not named in its place");
        assert!(bodies[1].contains("what is on this cover"), "the prose beside it was lost");
        // And the user is told, because a turn that quietly stops seeing is its own defect.
        assert!(tokens.iter().any(|t| t.contains("cannot see")),
            "nothing said the model had turned out to be blind: {:?}", tokens);
    }

    /// And once it is known, no later turn pays to discover it again.
    #[tokio::test]
    async fn test_an_endpoint_caught_refusing_pictures_is_not_asked_twice() {
        let (port, seen) = start_stub(vec![
            Reply::not_found(),
            Reply::answer(),
            Reply::answer(),
        ]).await;
        let client = stub_client(port);
        let msgs = [ChatMessage::user(MessageContent::parts(vec![
            ContentPart::Text("and this one".to_string()),
            ContentPart::Image(doc_image("cover.png")),
        ]))];
        let mut sink = |_: Delta<'_>| {};
        let _ = client.chat_stream_tools(&msgs, None, &mut sink).await
            .expect("the first turn recovers");
        let _ = client.chat_stream_tools(&msgs, None, &mut sink).await
            .expect("the second turn goes straight through");

        // Three replies were queued and only three connections may have been made: two for the
        // first turn, ONE for the second. A fourth would mean the client had forgotten.
        assert_eq!(connections(&seen), 3, "the second turn re-sent a picture already refused");
        let bodies = match seen.lock() {
            Ok(g)  => g.bodies.clone(),
            Err(e) => panic!("stub bookkeeping poisoned: {}", e),
        };
        assert!(!bodies[2].contains(DOC_PNG_B64),
            "the second turn sent the picture the endpoint had already refused");
    }

    #[tokio::test]
    async fn test_a_429_is_retried_and_the_turn_completes() {
        let (port, seen) = start_stub(vec![
            Reply::too_many(Some(1)),
            Reply::answer(),
        ]).await;
        let client = stub_client(port);
        let msgs = [ChatMessage::user("hello".to_string())];
        let mut tokens = Vec::new();

        let started = std::time::Instant::now();
        let resp = match client.chat_stream_tools(&msgs, None, &mut text_sink(&mut tokens)).await {
            Ok(r)  => r,
            Err(e) => panic!("a 429 followed by a 200 should complete: {}", e),
        };
        let elapsed = started.elapsed();

        assert_eq!(connections(&seen), 2, "the stub was not asked a second time");
        assert_eq!(resp.content, "Hello world");
        assert_eq!(resp.retries, 1, "the retry was not counted for the user to see");
        // The provider asked for a second and got one: its own figure beat the
        // client's 20ms backoff.
        assert!(elapsed >= std::time::Duration::from_millis(1_000),
            "Retry-After was ignored; waited only {:?}", elapsed);
        // The answer streamed once, and the retry announced itself.
        let text: String = tokens.iter().filter(|t| !t.starts_with("\n[daimond")).cloned().collect();
        assert_eq!(text, "Hello world");
        let notice = match tokens.iter().find(|t| t.contains("[daimond")) {
            Some(n) => n.clone(),
            None    => panic!("a retry the user cannot see is its own defect: {:?}", tokens),
        };
        assert!(notice.contains("HTTP 429"), "the notice does not say what happened: {}", notice);
        assert!(notice.contains("attempt 2 of 4"), "the notice does not say where we are: {}", notice);
        // The error's own rendering carries file, line and terminal colouring.
        assert!(!notice.contains('\u{1b}'),
            "ANSI escapes reached the user's message pane: {:?}", notice);
        // Provider-reported figures survive the retry.
        assert_eq!(resp.prompt_tokens, 11);
        assert_eq!(resp.cached_tokens, 9);
        assert_eq!(resp.cost_usd, 0.0003);
    }

    /// A stream that goes quiet is read as STALLED rather than waited on for however long the
    /// provider takes to close it. Proposal 15, 2026-09-15: OpenRouter's own export showed a
    /// round with `generation_time` 83.7 s that this app sat on for 318 s.
    #[tokio::test]
    async fn test_a_stalled_stream_ends_the_round_rather_than_hanging_on_it() {
        let (port, seen) = start_stub(vec![Reply::Stall {
            chunks: vec![
                "data: {\"choices\":[{\"delta\":{\"reasoning\":\"thinking hard about it\"}}]}\n\n"
                    .to_string(),
            ],
            // Comfortably longer than the client's own ceiling below, so the watchdog and
            // not the stub decides when the round ends.
            idle_ms: 3_000,
        }]).await;
        let client = stub_client(port);
        client.set_stream_idle_ms(80);
        let msgs = [ChatMessage::user("hello".to_string())];
        let mut tokens = Vec::new();

        let started = std::time::Instant::now();
        let resp = match client.chat_stream_tools(&msgs, None, &mut text_sink(&mut tokens)).await {
            Ok(r)  => r,
            Err(e) => panic!("a stall should end the round honestly, not fail it: {}", e),
        };
        let elapsed = started.elapsed();

        assert!(elapsed < std::time::Duration::from_millis(1_500),
            "the watchdog did not fire against an 80ms ceiling: waited {:?}", elapsed);
        assert!(resp.stalled, "the round did not report itself as stalled");
        assert!(!resp.truncated, "a stall is not the same fault as a length cut");
        assert!(resp.content.is_empty(), "nothing was ever said, and none should be invented");
        assert_eq!(resp.thinking, "thinking hard about it",
            "the reasoning that DID arrive before the stall must not be thrown away");
        // ONE CONNECTION. A stall is not a transport failure the retry ladder should act on --
        // the round is over, with whatever it had, not sent again from the top.
        assert_eq!(connections(&seen), 1,
            "a stall must not trigger a full resend of the request");
    }

    /// A provider that accepts the connection and then sends NOTHING is given up on by the
    /// first-byte watchdog after ONE attempt -- not waited on until it closes, and not retried.
    /// A first-byte/idle timeout is a stall, and a stall is not fixed by retrying it: another
    /// identical attempt only waits out the same ceiling again. So the round ends as an error
    /// after one connection, never as a fabricated success and never as a resend storm. This is
    /// the transport half of the vision self-verify fix: the JS wall clock (seq 290) is the
    /// outer bound and the tools.rs wording refuses to read a non-reporting worker as a pass;
    /// this stops the hang that started it.
    #[tokio::test]
    async fn test_a_provider_that_never_answers_is_given_up_on_not_hung_on() {
        // Two replies are scripted, but only the first should ever be reached: a terminal
        // timeout must not advance to the second.
        let (port, seen) = start_stub(vec![
            Reply::Hang {
                // Comfortably longer than the client's own ceiling below, so the watchdog and
                // not the stub's close is what ends the attempt.
                idle_ms: 4_000,
            },
            Reply::answer(),
        ]).await;
        let mut client = stub_client(port);
        // Room for retries in the policy, precisely so the test proves the timeout does NOT use
        // them: a stall is terminal, so the ladder must stop after one attempt regardless.
        client.retry = RetryPolicy {
            max_attempts:      4,
            base_ms:           20,
            max_backoff_ms:    40,
            max_total_wait_ms: 5_000,
        };
        client.set_stream_idle_ms(80); // floored to 1_000ms by set_stream_idle_ms
        let msgs = [ChatMessage::user("hello".to_string())];
        let mut tokens = Vec::new();

        let started = std::time::Instant::now();
        let result = client.chat_stream_tools(&msgs, None, &mut text_sink(&mut tokens)).await;
        let elapsed = started.elapsed();

        assert!(result.is_err(),
            "a provider that never answered must not be reported as a completed round");
        // ONE 1s ceiling, no retry. Without the terminal classification the ladder would sit
        // on a fresh socket each attempt; without the watchdog it would wait out the stub's 4s
        // close. Either would put this well past the bound.
        assert!(elapsed < std::time::Duration::from_millis(2_500),
            "the first-byte timeout was retried or waited out: waited {:?}", elapsed);
        assert!(tokens.is_empty(),
            "nothing was ever sent, so nothing should have streamed: {:?}", tokens);
        // ONE CONNECTION. The timeout is TERMINAL: the stall ends the round after a single
        // attempt rather than re-entering the retry ladder. The scripted `answer()` is never
        // reached.
        assert_eq!(connections(&seen), 1,
            "a first-byte timeout was retried instead of ending the round");
    }

    /// An abort that lands during a retry backoff halts the ladder at the top of the next
    /// attempt, rather than opening another connection.
    ///
    /// This is the abort-authority half of the ruling. On the browser a user's Stop and the
    /// 540 s wall clock in `www/js/daimond.js` both fire `abort()`, and a fresh
    /// `AbortController` is armed per attempt -- so the retry loop, not the per-fetch
    /// controller, has to be what stops the ladder. Here a 500 backs the first attempt off; the
    /// abort fires during that backoff (native `abort` sets the shared flag the wasm controller
    /// stands in for); the second attempt must never be opened. An abort is a clean stop, so
    /// the round returns aborted, not an error.
    #[tokio::test]
    async fn test_an_abort_during_backoff_halts_the_retry_ladder() {
        let (port, seen) = start_stub(vec![
            Reply::server_error(),  // attempt 1: retryable, so the ladder backs off
            Reply::answer(),        // attempt 2: only reached if the abort is lost
        ]).await;
        let mut client = stub_client(port);
        // A backoff long enough for the abort to land inside it, deterministically ahead of the
        // 500ms retry pause.
        client.retry = RetryPolicy {
            max_attempts:      4,
            base_ms:           500,
            max_backoff_ms:    500,
            max_total_wait_ms: 5_000,
        };
        let msgs = [ChatMessage::user("hello".to_string())];
        let mut tokens = Vec::new();

        let started = std::time::Instant::now();
        // Fire the abort 100ms in -- after attempt 1's immediate 500, during its 500ms backoff.
        let mut sink = text_sink(&mut tokens);
        let run = client.chat_stream_tools(&msgs, None, &mut sink);
        let abort_at = async {
            sleep_ms(100).await;
            client.abort();
        };
        let (result, ()) = tokio::join!(run, abort_at);
        let elapsed = started.elapsed();

        let resp = match result {
            Ok(r)  => r,
            Err(e) => panic!("an abort is a clean stop, not an error: {}", e),
        };
        assert!(resp.aborted, "the aborted round did not report itself aborted");
        // ONE CONNECTION. The abort landed during the backoff and stopped the ladder at the top
        // of attempt 2, so the second connection was never opened and the good answer was never
        // fetched -- exactly the hole where a fresh controller per attempt lost the abort.
        assert_eq!(connections(&seen), 1,
            "the ladder opened another connection after the abort");
        assert!(resp.content.is_empty(),
            "an aborted round must not carry the answer it never fetched: {:?}", resp.content);
        assert!(elapsed < std::time::Duration::from_millis(2_000),
            "the aborted ladder did not stop promptly: waited {:?}", elapsed);
    }

    /// A turn stopped between two requests sends nothing more: the halt is read at the top of
    /// EVERY attempt, not only once a retry is in hand (PQA W).
    #[tokio::test]
    async fn test_a_halt_set_before_a_request_sends_nothing() {
        let (port, seen) = start_stub(vec![Reply::answer()]).await;
        let client = stub_client(port);
        client.abort();
        let msgs = [ChatMessage::user("hello".to_string())];
        let mut tokens = Vec::new();
        let resp = match client.chat_stream_tools(&msgs, None, &mut text_sink(&mut tokens)).await {
            Ok(r)  => r,
            Err(e) => panic!("a stopped turn is a clean stop, not an error: {}", e),
        };
        assert!(resp.aborted, "the stopped round did not say it was stopped");
        assert_eq!(connections(&seen), 0, "a request went out after the turn was stopped");
        let once = match client.chat_once(&msgs, None).await {
            Ok(r)  => r,
            Err(e) => panic!("a stopped fold is a clean stop, not an error: {}", e),
        };
        assert!(once.aborted && once.content.is_empty());
        assert_eq!(connections(&seen), 0, "the fold's request went out after the stop");
    }

    /// A clone made for a turn of its own stops with its own halt and with no other: every
    /// Diamond on one model shares one client, and pausing one stopped another (PQA D).
    #[tokio::test]
    async fn test_a_turn_of_its_own_is_not_stopped_by_another_turns_halt() {
        let (port, seen) = start_stub(vec![Reply::answer()]).await;
        let shared = stub_client(port);
        let mine = shared.with_halt(Halt::new());
        let theirs = shared.with_halt(Halt::new());
        theirs.abort();
        assert!(theirs.halted() && !mine.halted() && !shared.halted(),
            "one turn's stop reached a turn beside it");
        let msgs = [ChatMessage::user("hello".to_string())];
        let mut tokens = Vec::new();
        let resp = match mine.chat_stream_tools(&msgs, None, &mut text_sink(&mut tokens)).await {
            Ok(r)  => r,
            Err(e) => panic!("the unstopped turn failed: {}", e),
        };
        assert!(!resp.aborted, "the unstopped turn was stopped");
        assert_eq!(connections(&seen), 1);
        // A clone INSIDE a turn -- the fold's compactor -- shares its stop.
        let inside = mine.clone();
        mine.abort();
        assert!(inside.halted(), "a clone inside the turn did not share its stop");
        // And a client that runs one turn at a time clears it for the next.
        mine.halt().rearm();
        assert!(!mine.halted() && !inside.halted());
    }

    #[tokio::test]
    async fn test_a_400_is_never_retried() {
        let (port, seen) = start_stub(vec![Reply::bad_request()]).await;
        let client = stub_client(port);
        let msgs = [ChatMessage::user("hello".to_string())];
        let mut tokens = Vec::new();

        let result = client.chat_stream_tools(&msgs, None, &mut text_sink(&mut tokens)).await;
        assert!(result.is_err(), "a malformed request must not be reported as success");
        // The whole point: a 400 will fail the same way next time, and retrying
        // it only costs the user money and time.
        assert_eq!(connections(&seen), 1, "a 400 was sent again");
        assert!(tokens.is_empty(), "nothing should have streamed: {:?}", tokens);
    }

    #[tokio::test]
    async fn test_a_5xx_is_retried_until_it_clears() {
        let (port, seen) = start_stub(vec![
            Reply::server_error(),
            Reply::server_error(),
            Reply::answer(),
        ]).await;
        let client = stub_client(port);
        let msgs = [ChatMessage::user("hello".to_string())];
        let mut tokens = Vec::new();

        let resp = match client.chat_stream_tools(&msgs, None, &mut text_sink(&mut tokens)).await {
            Ok(r)  => r,
            Err(e) => panic!("two 500s then a 200 should complete: {}", e),
        };
        assert_eq!(connections(&seen), 3);
        assert_eq!(resp.content, "Hello world");
        assert_eq!(resp.retries, 2);
    }

    #[tokio::test]
    async fn test_a_refusal_carries_the_providers_own_words() {
        // What the compactor reads to tell an oversized prompt from a malformed one.
        // Without the body it has only the status and a size estimate to go on, and a
        // provider that publishes no window can then kill a chat permanently.
        let over = "{\"error\":{\"message\":\"This model's maximum context length is \
            131072 tokens, however you requested 174233 tokens.\",\
            \"code\":\"context_length_exceeded\"}}";
        let (port, _seen) = start_stub(vec![Reply::Http {
            status: 400, reason: "Bad Request", headers: Vec::new(), body: over.to_string(),
        }]).await;
        let client = stub_client(port);
        let msgs = [ChatMessage::user("hello".to_string())];

        let e = match client.chat_stream_tools(&msgs, None, &mut |_| {}).await {
            Ok(_)  => panic!("a 400 must not be reported as success"),
            Err(e) => fmt!("{}", e),
        };
        assert!(e.contains("maximum context length"),
            "the provider said why and the error does not: {}", e);
        assert!(e.contains("400"), "{}", e);
        // And that is enough on its own -- no size estimate needed.
        assert!(crate::agent::compact::looks_like_overflow(&e, 0, 100_000),
            "the words the provider used were not recognised: {}", e);
    }

    // ── A reply that hit the output limit ───────────────────────────────

    #[test]
    fn test_both_dialects_say_when_a_reply_ran_out_of_room() {
        // Neither was read anywhere outside a test, so the browser had to infer
        // truncation from tool arguments that would not parse -- which cannot see a
        // plain text reply cut short, and cannot tell the model anything at all.
        assert!(openai_truncated(
            "{\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"length\"}]}"));
        assert!(anthropic_truncated(
            "{\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"max_tokens\"}}"));
        // And a reply that simply finished is not truncated, in either dialect.
        assert!(!openai_truncated(
            "{\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}"));
        assert!(!openai_truncated(
            "{\"choices\":[{\"delta\":{\"content\":\"hi\"},\"finish_reason\":null}]}"));
        assert!(!openai_truncated(
            "{\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}"));
        assert!(!anthropic_truncated(
            "{\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"}}"));
        assert!(!anthropic_truncated(
            "{\"type\":\"message_start\",\"message\":{\"stop_reason\":null}}"));
    }

    #[test]
    fn test_a_stream_cut_at_the_limit_says_so_on_the_response() {
        // Through the accumulator, which is where the app reads it: the flag is sticky,
        // because the usage chunk arrives AFTER the finish reason and must not unsay it.
        let mut acc = StreamAcc::default();
        acc.ingest("{\"choices\":[{\"delta\":{\"content\":\"fn main\"}}]}", &mut |_| {});
        assert!(!acc.into_response(false, 0).truncated);

        let mut acc = StreamAcc::default();
        acc.ingest("{\"choices\":[{\"delta\":{\"content\":\"fn main\"}}]}", &mut |_| {});
        acc.ingest("{\"choices\":[{\"delta\":{},\"finish_reason\":\"length\"}]}", &mut |_| {});
        acc.ingest("{\"choices\":[],\"usage\":{\"prompt_tokens\":9,\"completion_tokens\":8192}}",
            &mut |_| {});
        let r = acc.into_response(false, 0);
        assert!(r.truncated, "the usage chunk unsaid the finish reason");
        assert_eq!(r.completion_tokens, 8192);
    }

    #[test]
    fn test_an_anthropic_stream_cut_at_the_limit_says_so_too() {
        let mut acc = AnthropicAcc::default();
        acc.ingest("{\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":9}}}",
            &mut |_| {});
        acc.ingest("{\"type\":\"content_block_delta\",\"index\":0,\
            \"delta\":{\"type\":\"text_delta\",\"text\":\"fn main\"}}", &mut |_| {});
        assert!(!acc.truncated, "nothing has said the reply was cut");
        acc.ingest("{\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"max_tokens\"},\
            \"usage\":{\"output_tokens\":8192}}", &mut |_| {});
        assert!(acc.into_response(false, 0).truncated);
    }

    #[tokio::test]
    async fn test_a_truncated_reply_is_not_an_error_and_is_not_retried() {
        // The interaction that matters. A reply that hit `max_tokens` is a complete
        // HTTP 200: sending it again costs money and produces the same cut, and treating
        // it as a failure would throw away text the user has already been shown.
        let (port, seen) = start_stub(vec![Reply::Sse { chunks: vec![
            "data: {\"choices\":[{\"delta\":{\"content\":\"fn main() {\"}}]}\n\n".to_string(),
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"length\"}]}\n\n".to_string(),
            "data: [DONE]\n\n".to_string(),
        ], reset_after: None }]).await;
        let client = stub_client(port);
        let msgs = [ChatMessage::user("write the file".to_string())];

        let r = match client.chat_stream_tools(&msgs, None, &mut |_| {}).await {
            Ok(r)  => r,
            Err(e) => panic!("a reply that hit the cap is not a failed call: {}", e),
        };
        assert!(r.truncated, "the cap was reached and the response does not say so");
        assert_eq!(r.content, "fn main() {", "the partial answer was thrown away");
        assert_eq!(connections(&seen), 1, "a complete 200 was sent again");
        assert_eq!(r.retries, 0);
    }

    #[test]
    fn test_a_refusal_body_is_cut_without_splitting_a_character() {
        // A provider's body is arbitrary bytes on an error path, which is exactly where
        // a panic is least welcome and least likely to be found in testing. `&s[..300]`
        // on a multi-byte boundary is a panic, not a truncation.
        // One ASCII byte in front, so the two-byte characters after it sit on ODD
        // offsets and the cut at 300 lands in the middle of one. Without the offset the
        // boundaries happen to line up and a broken clip passes.
        let s = fmt!("a{}", "é".repeat(400));
        assert!(!s.is_char_boundary(ERR_BODY_BYTES), "the fixture must actually straddle");
        let cut = clip_bytes(&s, ERR_BODY_BYTES);
        assert!(cut.len() <= ERR_BODY_BYTES);
        assert!(cut.chars().skip(1).all(|c| c == 'é'), "a character was split");
        // A short body is untouched, and an empty one is not a special case.
        assert_eq!(clip_bytes("short", ERR_BODY_BYTES), "short");
        assert_eq!(clip_bytes("", ERR_BODY_BYTES), "");
    }

    #[tokio::test]
    async fn test_retrying_stops_at_the_attempt_budget() {
        // A provider that is never ready: the attempt must end, not loop.
        let (port, seen) = start_stub(vec![Reply::too_many(None)]).await;
        let mut client = stub_client(port);
        client.retry.max_attempts = 3;
        let msgs = [ChatMessage::user("hello".to_string())];

        let result = client.chat_stream_tools(&msgs, None, &mut |_| {}).await;
        assert!(result.is_err());
        assert_eq!(connections(&seen), 3,
            "the attempt budget was not the bound on how many requests went out");
    }

    #[tokio::test]
    async fn test_a_retry_after_beyond_the_wait_bound_ends_the_attempt() {
        // The provider asks for a minute; the user is watching a spinner.  The
        // turn ends rather than honouring it.
        let (port, seen) = start_stub(vec![Reply::too_many(Some(60))]).await;
        let mut client = stub_client(port);
        client.retry.max_total_wait_ms = 2_000;
        let msgs = [ChatMessage::user("hello".to_string())];

        let started = std::time::Instant::now();
        let result = client.chat_stream_tools(&msgs, None, &mut |_| {}).await;
        assert!(result.is_err());
        assert_eq!(connections(&seen), 1);
        assert!(started.elapsed() < std::time::Duration::from_secs(5),
            "the client slept through a Retry-After it had no budget for");
    }

    #[tokio::test]
    async fn test_a_stream_that_breaks_after_tokens_is_not_replayed() {
        // THE streaming hazard.  The provider streams one delta and then
        // vanishes; a retry here would hand the caller "Hello" a second time.
        let (port, seen) = start_stub(vec![
            Reply::Sse {
                chunks: vec![
                    "data: {\"choices\":[{\"delta\":{\"content\":\"Hello\"}}]}\n\n".to_string(),
                    "data: {\"choices\":[{\"delta\":{\"content\":\" world\"}}]}\n\n".to_string(),
                ],
                reset_after: Some(1),
            },
            Reply::answer(),
        ]).await;
        let client = stub_client(port);
        let msgs = [ChatMessage::user("hello".to_string())];
        let mut tokens = Vec::new();

        let _ = client.chat_stream_tools(&msgs, None, &mut text_sink(&mut tokens)).await;

        let text: String = tokens.iter().filter(|t| !t.starts_with("\n[daimond")).cloned().collect();
        assert_eq!(text, "Hello",
            "the partial was replayed or lost -- got {:?}", tokens);
        assert_eq!(connections(&seen), 1,
            "the turn was restarted after tokens had already reached the caller");
    }

    #[tokio::test]
    async fn test_a_stream_that_breaks_after_a_tool_call_fragment_is_not_replayed() {
        // No text has streamed, so `emitted` is false -- but a half-built tool
        // call is output all the same, and starting over would either duplicate
        // the call or splice two halves of different ones together.
        let (port, seen) = start_stub(vec![
            Reply::Sse {
                chunks: vec![
                    "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"c0\",\
                        \"function\":{\"name\":\"file_read\",\"arguments\":\"{\\\"path\\\":\\\"\"}}]}}]}\n\n"
                        .to_string(),
                    "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\
                        \"function\":{\"arguments\":\"a.txt\\\"}\"}}]}}]}\n\n".to_string(),
                ],
                reset_after: Some(1),
            },
            Reply::answer(),
        ]).await;
        let client = stub_client(port);
        let msgs = [ChatMessage::user("hello".to_string())];
        let mut tokens = Vec::new();

        let _ = client.chat_stream_tools(&msgs, None, &mut text_sink(&mut tokens)).await;

        assert_eq!(connections(&seen), 1,
            "the turn was restarted on top of a partial tool call");
        assert!(tokens.iter().all(|t| t.starts_with("\n[daimond")),
            "text streamed from a replayed turn: {:?}", tokens);
    }

    #[tokio::test]
    async fn test_a_stream_that_breaks_before_any_token_is_retried() {
        // A network drop before the provider has streamed anything — the laptop
        // moving between locations, the wifi handing off — is the failure the
        // widened retry policy is for. The stream resets on chunk 0, nothing has
        // been emitted, and the turn should start over and complete. This is the
        // exact shape of "the stream broke" the user sees on the road.
        let (port, seen) = start_stub(vec![
            Reply::Sse {
                chunks: vec![
                    "data: {\"choices\":[{\"delta\":{\"content\":\"Hello\"}}]}\n\n".to_string(),
                    "data: {\"choices\":[{\"delta\":{\"content\":\" world\"}}]}\n\n".to_string(),
                    "data: [DONE]\n\n".to_string(),
                ],
                reset_after: Some(0),
            },
            Reply::answer(),
        ]).await;
        let client = stub_client(port);
        let msgs = [ChatMessage::user("hello".to_string())];
        let mut tokens = Vec::new();

        let resp = match client.chat_stream_tools(&msgs, None, &mut text_sink(&mut tokens)).await {
            Ok(r)  => r,
            Err(e) => panic!("a stream that breaks before tokens should recover: {}", e),
        };

        assert_eq!(connections(&seen), 2,
            "the broken stream was not retried");
        assert_eq!(resp.content, "Hello world",
            "the retry did not produce the answer");
        assert_eq!(resp.retries, 1,
            "the retry was not counted");
        let text: String = tokens.iter().filter(|t| !t.starts_with("\n[daimond")).cloned().collect();
        assert_eq!(text, "Hello world",
            "the answer was not streamed cleanly after the retry: {:?}", tokens);
    }

    #[tokio::test]
    async fn test_the_breakpoint_reaches_the_wire() {
        // What the provider actually receives, read back off its own socket.
        let (port, seen) = start_stub(vec![Reply::answer()]).await;
        let client = stub_client(port);
        let msgs = [
            ChatMessage::system(long_system()),
            ChatMessage::user("hello".to_string()),
        ];
        let _ = client.chat_stream_tools(&msgs, None, &mut |_| {}).await;

        let body = match seen.lock() {
            Ok(g)  => g.bodies[0].clone(),
            Err(e) => panic!("stub bookkeeping poisoned: {}", e),
        };
        assert!(body.contains("\"cache_control\":{\"type\":\"ephemeral\"}"),
            "no breakpoint reached the provider: {}", body);
        assert!(body.contains("\"role\":\"system\",\"content\":[{\"type\":\"text\""));
    }

    /// A client pointed at the stub, speaking the Messages API.
    fn anth_stub_client(port: u16) -> LlmClient {
        let mut client = test_client_at("localhost", port, "/v1/messages", "claude-opus-5");
        client.retry = RetryPolicy {
            max_attempts:      4,
            base_ms:           20,
            max_backoff_ms:    40,
            max_total_wait_ms: 5_000,
        };
        client
    }

    #[tokio::test]
    async fn test_the_messages_api_request_reaches_the_wire_in_its_own_shape() {
        // What the provider actually receives, read back off its own socket --
        // not what this file believes it sent.
        let (port, seen) = start_stub(vec![Reply::anth_answer()]).await;
        let client = anth_stub_client(port);
        let tools = r#"[{"type":"function","function":{"name":"file_read",
            "description":"Read a file","parameters":{"type":"object","properties":{}}}}]"#;
        let msgs = [
            ChatMessage::system(long_system()),
            ChatMessage::user("hello".to_string()),
        ];
        let resp = match client.chat_stream_tools(&msgs, Some(tools), &mut |_| {}).await {
            Ok(r)  => r,
            Err(e) => panic!("the Messages API turn failed: {}", e),
        };
        assert_eq!(resp.content, "It says hello.");
        assert_eq!(resp.prompt_tokens, 60);
        assert_eq!(resp.completion_tokens, 8);

        let body = match seen.lock() {
            Ok(g)  => g.bodies[0].clone(),
            Err(e) => panic!("stub bookkeeping poisoned: {}", e),
        };
        assert!(body.contains("\"system\":[{\"type\":\"text\""),
            "the system prompt did not reach the wire hoisted: {}", body);
        assert!(!body.contains("\"role\":\"system\""), "{}", body);
        assert!(body.contains("\"input_schema\""),
            "the tools reached the wire in the OpenAI shape: {}", body);
        assert!(body.contains("\"thinking\":{\"type\":\"adaptive\""), "{}", body);
        assert!(body.contains("\"cache_control\":{\"type\":\"ephemeral\"}"),
            "no breakpoint reached the provider: {}", body);
        assert!(!body.contains("\"stream_options\""),
            "an OpenAI-only field reached the Messages API: {}", body);
    }

    #[tokio::test]
    async fn test_a_direct_anthropic_reply_with_no_cost_books_one_from_the_price_table() {
        // Anthropic reports usage and NEVER a `cost` (`AnthUsage::into_usage` always hands back
        // zero) -- so without the fix in `stream_turn` the spend cap is inert on this path and
        // the ledger reads $0 on a call that plainly cost something. `anth_answer` reports 60
        // prompt tokens and 8 completion (the LAST `output_tokens`, on `message_delta`, wins);
        // `claude-opus-5` prices at $5 / $25 per million.
        let (port, _seen) = start_stub(vec![Reply::anth_answer()]).await;
        let client = anth_stub_client(port);
        let msgs = [
            ChatMessage::system(long_system()),
            ChatMessage::user("hello".to_string()),
        ];
        let resp = match client.chat_stream_tools(&msgs, None, &mut |_| {}).await {
            Ok(r)  => r,
            Err(e) => panic!("the Messages API turn failed: {}", e),
        };
        assert_eq!(60, resp.prompt_tokens);
        assert_eq!(8,  resp.completion_tokens);
        let expected = 60.0 * 5.00 / 1_000_000.0 + 8.0 * 25.00 / 1_000_000.0;
        assert!((resp.cost_usd - expected).abs() < 1e-9,
            "expected {} booked from the price table, got {}", expected, resp.cost_usd);
    }

    #[tokio::test]
    async fn test_thinking_blocks_are_handed_back_with_the_tool_results() {
        // The constraint that produces an error on EVERY following turn when it
        // is missed: within a tool-use turn, the signed thinking blocks must go
        // back complete and unmodified, ahead of the tool_use block they
        // accompanied.  Two real requests, and the second one is read off the
        // provider's socket.
        let (port, seen) = start_stub(vec![
            Reply::anth_thinks_then_calls(),
            Reply::anth_answer(),
        ]).await;
        let client = anth_stub_client(port);
        let tools = r#"[{"type":"function","function":{"name":"file_read",
            "description":"Read a file","parameters":{"type":"object","properties":{}}}}]"#;

        // Round one: the model thinks, then asks for a tool.
        let first = match client.chat_stream_tools(
            &[ChatMessage::user("read a.txt".to_string())],
            Some(tools), &mut |_| {}).await
        {
            Ok(r)  => r,
            Err(e) => panic!("round one failed: {}", e),
        };
        assert_eq!(first.tool_calls.len(), 1);
        assert_eq!(first.tool_calls[0].id, "toolu_1");
        assert_eq!(first.thinking, "I should read the file.");
        assert_eq!(first.cached_tokens, 900);
        assert_eq!(first.prompt_tokens, 930, "the cached prefix is part of the prompt");

        // Round two: the agent loop's shape -- the assistant turn that asked,
        // then the result.
        let round_two = vec![
            ChatMessage::user("read a.txt".to_string()),
            ChatMessage::Assistant {
                content:    MessageContent::text(""),
                tool_calls: first.tool_calls.clone(),
            },
            ChatMessage::tool("toolu_1".to_string(), "hello".to_string()),
        ];
        if let Err(e) = client.chat_stream_tools(&round_two, Some(tools), &mut |_| {}).await {
            panic!("round two failed: {}", e);
        }

        let body = match seen.lock() {
            Ok(g)  => g.bodies[1].clone(),
            Err(e) => panic!("stub bookkeeping poisoned: {}", e),
        };
        assert!(body.contains("\"signature\":\"SIGNATURE-1\""),
            "the signed thinking block never went back: {}", body);
        assert!(body.contains("I should read the file."),
            "the thinking text was dropped, which the API reads as a modified block: {}", body);
        // Order matters: the reasoning precedes the call it produced.
        let think_at = match body.find("\"type\":\"thinking\"") {
            Some(p) => p,
            None    => panic!("no thinking block in the assistant turn: {}", body),
        };
        let call_at = match body.find("\"type\":\"tool_use\"") {
            Some(p) => p,
            None    => panic!("no tool_use block: {}", body),
        };
        assert!(think_at < call_at,
            "the thinking block was placed after the call it led to: {}", body);
    }

    #[tokio::test]
    async fn test_reasoning_only_ever_goes_back_with_the_call_that_produced_it() {
        // Blocks are kept across a whole tool loop -- that is the documented
        // recommendation, and on the models that keep them it is what makes the
        // round-by-round cache hits happen.  What must NOT happen is one turn's
        // reasoning being glued to a different turn's call: within an assistant
        // message the run has to match what the model generated there, so a
        // block from elsewhere is a rearrangement and a 400.
        let (port, seen) = start_stub(vec![
            Reply::anth_thinks_then_calls(),
            Reply::anth_answer(),
        ]).await;
        let client = anth_stub_client(port);
        let msgs = [ChatMessage::user("hello".to_string())];
        let _ = client.chat_stream_tools(&msgs, None, &mut |_| {}).await;

        // A later turn quoting a DIFFERENT call: the held reasoning belongs to
        // `toolu_1`, and nothing may hand it to `toolu_other`.
        let elsewhere = vec![
            ChatMessage::user("hello".to_string()),
            ChatMessage::Assistant {
                content:    MessageContent::text(""),
                tool_calls: vec![ToolCall { id: "toolu_other".to_string(),
                    name: "file_read".to_string(), arguments: "{}".to_string() }],
            },
            ChatMessage::Tool { tool_call_id: "toolu_other".to_string(),
                content: MessageContent::text("x") },
        ];
        let _ = client.chat_stream_tools(&elsewhere, None, &mut |_| {}).await;
        let body = match seen.lock() {
            Ok(g)  => g.bodies[1].clone(),
            Err(e) => panic!("stub bookkeeping poisoned: {}", e),
        };
        assert!(!body.contains("SIGNATURE-1"),
            "one turn's reasoning was handed to another turn's call: {}", body);
        assert!(!body.contains("\"type\":\"thinking\""), "{}", body);
    }

    #[tokio::test]
    async fn test_every_round_of_a_tool_loop_keeps_its_own_reasoning() {
        // Round three carries BOTH earlier rounds' blocks, each beside its own
        // call.  A client that held only the latest would drop the first
        // round's reasoning from a loop that is, to the model, one turn -- and
        // with it the cache hit that the tool results were supposed to earn.
        let (port, seen) = start_stub(vec![
            Reply::anth_thinks_then_calls(),
            Reply::anth_thinks_then_calls_again(),
            Reply::anth_answer(),
        ]).await;
        let client = anth_stub_client(port);
        let call = |id: &str| ToolCall {
            id: id.to_string(), name: "file_read".to_string(), arguments: "{}".to_string() };

        let mut working = vec![ChatMessage::user("read them".to_string())];
        for _ in 0..2 {
            let r = match client.chat_stream_tools(&working, None, &mut |_| {}).await {
                Ok(r)  => r,
                Err(e) => panic!("round failed: {}", e),
            };
            let id = r.tool_calls[0].id.clone();
            working.push(ChatMessage::Assistant {
                content: MessageContent::text(""), tool_calls: vec![call(&id)] });
            working.push(ChatMessage::tool(id, "ok".to_string()));
        }
        let _ = client.chat_stream_tools(&working, None, &mut |_| {}).await;

        let body = match seen.lock() {
            Ok(g)  => g.bodies[2].clone(),
            Err(e) => panic!("stub bookkeeping poisoned: {}", e),
        };
        assert!(body.contains("SIGNATURE-1"),
            "the first round's reasoning was dropped from the loop: {}", body);
        assert!(body.contains("SIGNATURE-2"),
            "the second round's reasoning was dropped: {}", body);
        assert_eq!(body.matches("\"type\":\"thinking\"").count(), 2, "{}", body);
    }

    // Test verifier that accepts any certificate (for unit tests only).
    use tokio_rustls::rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
    use std::sync::Arc;

    #[derive(Debug)]
    pub struct NoVerify;

    impl ServerCertVerifier for NoVerify {
        fn verify_server_cert(
            &self,
            _end_entity: &tokio_rustls::rustls::pki_types::CertificateDer<'_>,
            _intermediates: &[tokio_rustls::rustls::pki_types::CertificateDer<'_>],
            _server_name: &tokio_rustls::rustls::pki_types::ServerName<'_>,
            _ocsp_response: &[u8],
            _now: tokio_rustls::rustls::pki_types::UnixTime,
        ) -> Result<ServerCertVerified, tokio_rustls::rustls::Error> {
            Ok(ServerCertVerified::assertion())
        }
        fn verify_tls12_signature(
            &self,
            _message: &[u8],
            _cert: &tokio_rustls::rustls::pki_types::CertificateDer<'_>,
            _dss: &tokio_rustls::rustls::DigitallySignedStruct,
        ) -> Result<HandshakeSignatureValid, tokio_rustls::rustls::Error> {
            Ok(HandshakeSignatureValid::assertion())
        }
        fn verify_tls13_signature(
            &self,
            _message: &[u8],
            _cert: &tokio_rustls::rustls::pki_types::CertificateDer<'_>,
            _dss: &tokio_rustls::rustls::DigitallySignedStruct,
        ) -> Result<HandshakeSignatureValid, tokio_rustls::rustls::Error> {
            Ok(HandshakeSignatureValid::assertion())
        }
        fn supported_verify_schemes(&self) -> Vec<tokio_rustls::rustls::SignatureScheme> {
            vec![
                tokio_rustls::rustls::SignatureScheme::RSA_PKCS1_SHA256,
                tokio_rustls::rustls::SignatureScheme::ECDSA_NISTP256_SHA256,
                tokio_rustls::rustls::SignatureScheme::ED25519,
            ]
        }
    }
}
