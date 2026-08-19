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
// │ Thinking carry                                                 │
// └───────────────────────────────────────────────────────────────┘

/// How many assistant turns of signed reasoning to hold at once.
///
/// A round of an agentic loop adds one entry, so this bounds the memory a very
/// long loop can hold while covering more rounds than any single tool loop runs.
const CARRY_MAX_TURNS: usize = 32;

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
type OpenFolds = std::rc::Rc<std::cell::RefCell<std::collections::HashSet<String>>>;

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


// ┌───────────────────────────────────────────────────────────────┐
// │ LlmClient                                                      │
// └───────────────────────────────────────────────────────────────┘

/// Async client for a chat completions API, in either [`Dialect`].
///
/// Connects via TLS to the configured host, POSTs a chat completion
/// request with `stream: true`, and parses the SSE response
/// incrementally — calling `on_token` for each text chunk as it
/// arrives.
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
    /// Set once this endpoint has been caught refusing a request that carried pictures.
    /// See [`Blind`]; read by [`LlmClient::vision_guard`] and set by the strip-and-retry in
    /// [`LlmClient::stream_turn`] and [`LlmClient::chat_once`].
    blind:          Blind,
    /// Root-trust TLS configuration for the native transport.  The wasm
    /// transport delegates trust to the browser's `fetch`, so this field
    /// is native-only.
    #[cfg(not(target_arch = "wasm32"))]
    pub tls_config: Arc<ClientConfig>,
    /// Wasm transport URL scheme selector: `true` builds `https://…`,
    /// `false` builds `http://…`.  Defaults to `https` (all real
    /// providers are TLS-only); an `http` client targets a local mock
    /// over `127.0.0.1` for headless testing, where the browser still
    /// treats the origin as a secure context.
    #[cfg(target_arch = "wasm32")]
    pub secure: bool,
    /// Shared abort slot for the browser transport.  Each `fetch` installs
    /// a fresh [`web_sys::AbortController`] here and wires its signal into
    /// the request; [`abort`](Self::abort) fires it to cancel the in-flight
    /// turn.  An `Rc<RefCell<…>>` (never `unsafe`), shared across clones so
    /// a sub-agent built from a cloned client aborts on the same signal.
    #[cfg(target_arch = "wasm32")]
    abort: std::rc::Rc<std::cell::RefCell<Option<web_sys::AbortController>>>,
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
    /// The model's summarised reasoning; see [`ChatOnceResponse::thinking`].
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
    /// The model's summarised reasoning for this turn, when it thought and the
    /// endpoint returns thinking at all -- so, Anthropic direct, on a model that
    /// takes adaptive thinking.  Empty otherwise, and never part of `content`:
    /// reasoning is not the answer, and a caller that persisted it as one would
    /// be putting the model's working out where its reply should be.  The
    /// tokens are already counted in `completion_tokens`, because thinking is
    /// billed as output whether or not its text comes back.
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
    /// Whether another attempt is worth making.
    retryable: bool,
    /// What the provider asked us to wait, in milliseconds, if it said.
    after_ms:  Option<u64>,
    /// A few plain words for the retry notice.  The error itself carries file,
    /// line and ANSI colouring, none of which belongs in a user's message pane.
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

    /// Attach the provider's requested delay.
    fn after(mut self, after_ms: Option<u64>) -> Self {
        self.after_ms = after_ms;
        self
    }
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
async fn sleep_ms(ms: u64) {
    tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
}

/// Sleep for `ms` milliseconds in the browser, via `setTimeout`.
///
/// A scope with no timer resolves immediately, so a retry still happens -- just
/// without the pause.
#[cfg(target_arch = "wasm32")]
async fn sleep_ms(ms: u64) {
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
            blind:      new_blind(),
            tls_config,
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
            blind:      new_blind(),
            secure,
            abort:      std::rc::Rc::new(std::cell::RefCell::new(None)),
        }
    }

    /// Send a streaming chat completion request.
    ///
    /// Reads the SSE response line-by-line from the TLS stream,
    /// calling `on_token` for each text delta *as it arrives*.
    /// Returns the full accumulated response and token usage when
    /// the stream completes.
    /// A stream that failed before emitting a token is retried; one that failed
    /// after is not, because the caller has already been handed those tokens
    /// and a fresh attempt would hand them over a second time.
    pub async fn chat_stream(
        &self,
        messages:   &[ChatMessage],
        on_token:   &mut impl FnMut(&str),
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
    /// assistant turn from the SSE deltas: text is forwarded to
    /// `on_token` as it arrives (so the answer streams even while tools
    /// are active), and any `tool_calls` fragments are accumulated across
    /// chunks into whole calls (see [`StreamAcc`]).  Returns the same
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
        on_token:   &mut impl FnMut(&str),
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
    /// * `on_token` - Called with each text delta as it arrives.
    /// * `notify` - Whether to announce a retry through `on_token`.
    async fn stream_turn(
        &self,
        messages:   &[ChatMessage],
        tools:      Option<&str>,
        on_token:   &mut impl FnMut(&str),
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
            let mut acc = Acc::new(self.dialect);
            let mut emitted = false;
            let outcome = {
                let mut sink = |data: &str| {
                    acc.ingest(data, &mut |token: &str| {
                        emitted = true;
                        on_token(token);
                    });
                };
                self.stream_sse(&body, &mut sink).await
            };
            // An `error` event on a 200 stream is the provider's own trouble
            // arriving after the headers, so it is classified like a status code
            // rather than read as a short answer.
            let outcome = match outcome {
                Ok(aborted) => match acc.stream_error() {
                    Some(e) if !emitted && !acc.has_output() => Err(e),
                    _ => Ok(aborted),
                },
                Err(e) => Err(e),
            };
            match outcome {
                Ok(aborted) => {
                    let thinking = acc.take_thinking();
                    let resp = acc.into_response(aborted, retries);
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
                            on_token(&fmt!(
                                "\n[daimond: the model would not take {} image{}; asking again \
                                 without {} -- it cannot see]\n",
                                images,
                                if images == 1 { "" } else { "s" },
                                if images == 1 { "it" } else { "them" }));
                        }
                        continue;
                    }
                    if started || !e.retryable {
                        return Err(self.vision_error(e.err, images));
                    }
                    let delay = match self.retry.next_delay(retries, waited, e.after_ms) {
                        Some(d) => d,
                        None    => return Err(self.vision_error(e.err, images)),
                    };
                    waited += delay;
                    retries += 1;
                    if notify {
                        on_token(&fmt!(
                            "\n[daimond: {}; retrying in {}.{:01}s -- attempt {} of {}]\n",
                            e.reason,
                            delay / 1_000,
                            (delay % 1_000) / 100,
                            retries + 1,
                            self.retry.max_attempts));
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
                        return Err(self.vision_error(e.err, images));
                    }
                    let delay = match self.retry.next_delay(retries, waited, e.after_ms) {
                        Some(d) => d,
                        None    => return Err(self.vision_error(e.err, images)),
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
        Ok(ChatOnceResponse {
            content,
            tool_calls,
            prompt_tokens:     use_.prompt,
            completion_tokens: use_.completion,
            cached_tokens:     use_.cached,
            cost_usd:          use_.cost_usd,
            aborted:           false,
            retries,
            thinking:          thinking_text,
            truncated,
        })
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
    /// Thinking is requested only for the models that take the adaptive form;
    /// see [`model_takes_adaptive_thinking`].
    fn build_anthropic_body(&self, messages: &[ChatMessage], tools: Option<&str>, stream: bool)
        -> String
    {
        let marks = self.cache_breakpoints(messages, tools);
        let thinks = model_takes_adaptive_thinking(&self.model);
        let mut out = String::with_capacity(1024);
        out.push('{');
        out.push_str(&fmt!("\"model\":\"{}\",", self.model));
        out.push_str(&fmt!("\"max_tokens\":{},", self.anthropic_max_tokens(thinks, stream)));

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
                    if content.has_image() {
                        let blocks = anthropic_blocks(content, false);
                        pending.push(fmt!(
                            "{{\"type\":\"tool_result\",\"tool_use_id\":\"{}\",\"content\":[{}]}}",
                            json_escape(tool_call_id), blocks.join(",")));
                    } else {
                        pending.push(fmt!(
                            "{{\"type\":\"tool_result\",\"tool_use_id\":\"{}\",\"content\":\"{}\"}}",
                            json_escape(tool_call_id), json_escape(&content.as_text())));
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
                        blocks.push(text_block(&said, false));
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
    /// * the last user message, which is the tip of the settled conversation --
    ///   the next turn reads everything before it back out of the cache.
    ///
    /// Nothing is marked for a model that does not honour the marker, and
    /// nothing is marked when the prefix is too short to be cacheable at all.
    /// Assistant and tool messages are deliberately left unmarked: the array
    /// content form they would need is the one an OpenAI-compatible router is
    /// least certain to carry through, and a rejected body loses the whole turn.
    fn cache_breakpoints(&self, messages: &[ChatMessage], tools: Option<&str>) -> Vec<usize> {
        let mut marks = Vec::new();
        if !model_caches_on_request(&self.model) {
            return marks;
        }
        // The prefix at each message, in characters, standing in for tokens.
        let mut prefix = tools.map(|t| t.len()).unwrap_or(0);
        let mut sys = None;
        let mut usr = None;
        for (i, msg) in messages.iter().enumerate() {
            prefix += message_len(msg);
            if prefix < CACHE_MIN_PREFIX_CHARS {
                continue;
            }
            match msg {
                ChatMessage::System { .. } => sys = Some(i),
                ChatMessage::User { .. }   => usr = Some(i),
                _ => {}
            }
        }
        if let Some(i) = sys { marks.push(i); }
        if let Some(i) = usr {
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
        body: &str,
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

        // Read headers byte-by-byte until \r\n\r\n.
        let mut hdr_buf = Vec::with_capacity(2048);
        let mut byte = [0u8; 1];
        loop {
            match stream.read(&mut byte).await {
                Ok(0) => break,
                Ok(_) => {
                    hdr_buf.push(byte[0]);
                    if hdr_buf.ends_with(b"\r\n\r\n") { break; }
                }
                Err(e) if e.kind() == tokio::io::ErrorKind::UnexpectedEof => break,
                Err(e) => return Err(TransportErr::transient("the provider closed before replying".to_string(), err!(e,
                    "LLM: read headers failed."; IO, Network, Wire, Read))),
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
        let (stream, is_chunked) = match self.open(body).await {
            Ok(v)  => v,
            Err(e) => return Err(e),
        };
        let mut reader = LineReader::new(stream, is_chunked);
        let mut full = String::new();
        loop {
            match reader.read_line().await {
                Ok(Some(l)) => full.push_str(&l),
                Ok(None) => break,
                Err(e) if e.kind() == tokio::io::ErrorKind::UnexpectedEof => break,
                Err(e) => return Err(TransportErr::transient("the reply was cut short".to_string(), err!(e,
                    "LLM: read response body failed."; IO, Network, Wire, Read))),
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
    ) -> Result<bool, TransportErr>
    {
        let (stream, is_chunked) = match self.open(body).await {
            Ok(v)  => v,
            Err(e) => return Err(e),
        };
        let mut reader = LineReader::new(stream, is_chunked);
        loop {
            let line = match reader.read_line().await {
                Ok(Some(l)) => l,
                Ok(None) => break,
                Err(e) if e.kind() == tokio::io::ErrorKind::UnexpectedEof => break,
                Err(e) => return Err(TransportErr::transient("the stream broke".to_string(), err!(e,
                    "LLM: read SSE line failed."; IO, Network, Wire, Read))),
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
        Ok(false)
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
        let resp = res!(self.wasm_fetch_raw(&body).await);
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
    async fn wasm_fetch(&self, body: &str) -> Result<web_sys::Response, TransportErr> {
        let resp = match self.wasm_fetch_raw(body).await {
            Ok(r) => r,
            // A rejected `fetch` is a network or CORS failure; an armed abort is
            // the caller cancelling, and must not be retried.
            Err(e) => return Err(if self.abort_signalled() {
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
            let detail = self.body_detail(&resp).await;
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
    async fn body_detail(&self, resp: &web_sys::Response) -> String {
        use wasm_bindgen_futures::JsFuture;

        let text = match resp.text() {
            Ok(p) => match JsFuture::from(p).await {
                Ok(v)  => v.as_string().unwrap_or_default(),
                Err(_) => String::new(),
            },
            Err(_) => String::new(),
        };
        clip_bytes(&text, ERR_BODY_BYTES).to_string()
    }

    /// POST `body` via `fetch` and await the `Response` without checking
    /// the status, mapping any JS error into an `Outcome`.  TLS trust is
    /// the browser's.  Callers that need a 2xx guarantee go through
    /// [`wasm_fetch`](Self::wasm_fetch).
    async fn wasm_fetch_raw(&self, body: &str) -> Outcome<web_sys::Response> {
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
            *self.abort.borrow_mut() = Some(ctrl);
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

        let resp_val = res!(JsFuture::from(promise).await
            .map_err(|e| err!("LLM: fetch failed: {}.", js_str(&e); IO, Network, Wire)));
        let resp: Response = res!(resp_val.dyn_into()
            .map_err(|_| err!("LLM: fetch did not return a Response."; IO, Network, Wire)));
        Ok(resp)
    }

    /// Non-streaming request — await the full response body as text.
    async fn do_request_full(&self, body: &str) -> Result<String, TransportErr> {
        use wasm_bindgen_futures::JsFuture;

        let resp = match self.wasm_fetch(body).await {
            Ok(r)  => r,
            Err(e) => return Err(e),
        };
        let text_promise = match resp.text() {
            Ok(p)  => p,
            Err(e) => return Err(TransportErr::transient("the reply was cut short".to_string(), err!(
                "LLM: read response text failed: {}.", js_str(&e); IO, Network, Wire, Read))),
        };
        let text_val = match JsFuture::from(text_promise).await {
            Ok(v)  => v,
            Err(e) => return Err(TransportErr::transient("the reply was cut short".to_string(), err!(
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
    ) -> Result<bool, TransportErr>
    {
        use wasm_bindgen::JsValue;
        use wasm_bindgen_futures::JsFuture;
        use web_sys::{ReadableStream, ReadableStreamDefaultReader};

        let resp = match self.wasm_fetch(body).await {
            Ok(r) => r,
            Err(e) => {
                if self.abort_signalled() { return Ok(true); }
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
            let result = match JsFuture::from(reader.read()).await {
                Ok(r) => r,
                Err(e) => {
                    if self.abort_signalled() { return Ok(true); }
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
                    return Ok(false);
                }
                on_data(data);
            }
        }

        Ok(false)
    }

    /// Fire the abort signal for the in-flight request, if any.  Safe to
    /// call when idle: with no armed controller it is a no-op.
    pub fn abort(&self) {
        if let Some(ctrl) = self.abort.borrow().as_ref() {
            ctrl.abort();
        }
    }

    /// Whether the armed abort controller's signal has fired.  Used to
    /// tell a cancelled fetch/stream apart from a genuine failure.
    fn abort_signalled(&self) -> bool {
        self.abort
            .borrow()
            .as_ref()
            .map(|ctrl| ctrl.signal().aborted())
            .unwrap_or(false)
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
fn find_json_object(json: &str, key: &str) -> Option<String> {
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

/// Serialise a `ChatMessage` to an OpenAI-API JSON object, including
/// assistant `tool_calls` and the `tool` role — which `datmap_to_json`
/// does not carry.
/// Only the `user` role may carry an image on this side; `system`, `assistant` and `tool` take a
/// string or text parts and nothing else.  A message of another role that somehow holds one is
/// flattened to the `[image …]` stand-in rather than sent as a part the API would reject; the
/// The arguments a `say` call is REPLAYED with, or `None` for every other tool.
///
/// `say` answers at two depths: a summary the user reads at once and a detail behind a fold. The
/// detail is for a person, once. Left in the transcript it would be re-sent on every later request
/// for the life of the conversation -- so a model that explains at length would charge for that
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

/// tool results that legitimately produce images are re-homed by
/// [`build_openai_body`](LlmClient::build_openai_body) instead.
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
            let text = json_escape(&content.as_text());
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
    /// The last usage block the stream reported.  An aborted stream may never
    /// deliver one, which leaves this at its default rather than erroring.
    usage:             Usage,
    calls:             Vec<StreamCall>,
    /// Whether a chunk said the reply stopped at the output limit.
    truncated:         bool,
}

impl StreamAcc {

    /// Fold one SSE `data:` payload into the accumulator, forwarding any
    /// text delta to `on_token` as it arrives.
    fn ingest(&mut self, data: &str, on_token: &mut impl FnMut(&str)) {
        // Text delta — scoped to before any `tool_calls` so a `content`
        // key inside a tool call's arguments is never mistaken for it.
        let scope_end = data.find("\"tool_calls\"").unwrap_or(data.len());
        if let Some(content) = extract_json_string(&data[..scope_end], "content") {
            if !content.is_empty() {
                on_token(&content);
                self.content.push_str(&content);
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
            // The OpenAI shape has no thinking block; a router that surfaces a
            // model's reasoning does it as ordinary content.
            thinking:          String::new(),
            truncated:         self.truncated,
        }
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

    /// Fold one SSE `data:` payload in, forwarding text deltas to `on_token`.
    ///
    /// Thinking deltas are deliberately *not* forwarded: the plain-chat caller
    /// treats every token it is handed as the assistant's answer and would
    /// persist the reasoning as the reply.  The summary is kept on the response
    /// instead ([`ChatOnceResponse::thinking`]), where a caller that wants to
    /// show it can, and the tokens are already counted -- thinking is billed as
    /// output whether or not its text comes back.
    fn ingest(&mut self, data: &str, on_token: &mut impl FnMut(&str)) {
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
                                on_token(&t);
                                self.content.push_str(&t);
                            }
                        }
                    }
                    "thinking_delta" => {
                        if let Some(t) = extract_json_string(&d, "thinking") {
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
        }
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
    fn ingest(&mut self, data: &str, on_token: &mut impl FnMut(&str)) {
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
fn split_top_level_objects(arr: &str) -> Vec<String> {
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

    /// Drive a sequence of SSE `data:` payloads through a fresh
    /// [`StreamAcc`], collecting the forwarded text tokens.
    fn run_stream(chunks: &[&str]) -> (ChatOnceResponse, Vec<String>) {
        let mut acc = StreamAcc::default();
        let mut tokens = Vec::new();
        for c in chunks {
            acc.ingest(c, &mut |t| tokens.push(t.to_string()));
        }
        (acc.into_response(false, 0), tokens)
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

    /// **The detail a `say` folds does not go over the wire, and the summary does.**
    ///
    /// This is the whole point of the tool. Prose written into a reply is re-sent on every later
    /// request for the life of the conversation; a fold is read once by a person who then has it
    /// on their own screen. Left in the payload the tool would save nothing at all — it would be
    /// a presentation device that quietly cost the same as saying everything twice.
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
            acc.ingest(c, &mut |t| tokens.push(t.to_string()));
        }
        (acc, tokens)
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
        let resp = match client.chat_stream_tools(&msgs, None, &mut |t| {
            tokens.push(t.to_string());
        }).await {
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
        let mut sink = |_: &str| {};
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
        let resp = match client.chat_stream_tools(&msgs, None, &mut |t| {
            tokens.push(t.to_string());
        }).await {
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

    #[tokio::test]
    async fn test_a_400_is_never_retried() {
        let (port, seen) = start_stub(vec![Reply::bad_request()]).await;
        let client = stub_client(port);
        let msgs = [ChatMessage::user("hello".to_string())];
        let mut tokens = Vec::new();

        let result = client.chat_stream_tools(&msgs, None, &mut |t| tokens.push(t.to_string())).await;
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

        let resp = match client.chat_stream_tools(&msgs, None, &mut |t| {
            tokens.push(t.to_string());
        }).await {
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

        let _ = client.chat_stream_tools(&msgs, None, &mut |t| tokens.push(t.to_string())).await;

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

        let _ = client.chat_stream_tools(&msgs, None, &mut |t| tokens.push(t.to_string())).await;

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

        let resp = match client.chat_stream_tools(&msgs, None, &mut |t| {
            tokens.push(t.to_string());
        }).await {
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
