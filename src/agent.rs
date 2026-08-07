//! Agent loop — the core Daimond agent that drives conversations.
//!
//! Receives a user message, sends it to the LLM with conversation
//! history, streams the response back to the client via events,
//! and stores the exchange in the session.

use oxedyne_fe2o3_core::prelude::*;

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use crate::llm::LlmClient;
use crate::prompts::Role;
use crate::protocol::{AgentEvent, ChatMessage, MessageContent, Session};
use crate::tools::ToolRegistry;

/// Folding a conversation that has outgrown the model's context window.
///
/// Declared here, from its own file, rather than beside the other modules in `lib.rs`:
/// compaction is part of running a turn and has no caller outside this one.
#[path = "compact.rs"]
pub mod compact;

use crate::agent::compact::{Gauge, Limits};

// The TLS client-config helper below is native-only; the wasm build
// delegates TLS trust to the browser and constructs `LlmClient`
// without a `ClientConfig`.
#[cfg(not(target_arch = "wasm32"))]
use std::sync::Arc;
#[cfg(not(target_arch = "wasm32"))]
use tokio_rustls::rustls::ClientConfig;


// ┌───────────────────────────────────────────────────────────────┐
// │ Speaking into a turn that is already running                    │
// └───────────────────────────────────────────────────────────────┘

/// Words the user has said since the turn began, waiting for a gap to be said in.
///
/// **What this is for.** A turn is not one request; it is a round of requests, each
/// carrying the last round's tool results.  A model twenty tool calls into the wrong
/// approach cannot be corrected by waiting -- by the time the turn ends the work is
/// done and the cost is spent -- and stopping it throws away everything it has
/// learned on the way.  So the user's correction is put where it can be acted on:
/// into the message list, at the seam between one round and the next.
///
/// **What it is NOT.** Nothing can be added to a request that is already in flight;
/// the message list is fixed the moment it is sent, and no provider offers otherwise.
/// So a turn spending a minute writing prose with no tool call has no seam in it and
/// cannot be interrupted -- for that, stopping is still the only answer.  The seam
/// exists because agentic work is made of many requests, not because a request can
/// be reopened.
///
/// Shared by `Rc<RefCell<..>>` rather than a channel: the browser build is
/// single-threaded, the queue is short, and the UI needs to READ it to draw what is
/// waiting, which a consumed channel cannot offer.
pub type Interjections = Rc<RefCell<Vec<String>>>;

/// A fresh, empty interjection queue.
pub fn new_interjections() -> Interjections {
    Rc::new(RefCell::new(Vec::new()))
}


// ┌───────────────────────────────────────────────────────────────┐
// │ Agent                                                          │
// └───────────────────────────────────────────────────────────────┘

/// The Daimond agent — drives a single conversation turn.
///
/// Holds a reference to the LLM client (shared across sessions) and
/// the system prompt to prepend to every conversation.
#[derive(Clone, Debug)]
pub struct Agent {
    pub llm:           LlmClient,
    pub system_prompt: String,
    /// Cumulative prompt tokens for the turn in flight, updated round by round
    /// alongside the session total. Held here, outside the session, so the
    /// browser can read a running agent's spend without borrowing the session
    /// the turn already holds mutably -- reading it there would panic the
    /// `RefCell`, so a running tile could not show its cost.
    pub live_prompt:     Cell<u64>,
    /// Cumulative completion tokens for the turn in flight; see `live_prompt`.
    pub live_completion: Cell<u64>,
    /// Cumulative cached prompt tokens for the turn in flight; see `live_prompt`.
    pub live_cached:     Cell<u64>,
    /// Cumulative provider-reported USD for the turn in flight; see `live_prompt`.
    pub live_cost:       Cell<f64>,
    /// What the user has said since this turn began (see [`Interjections`]).
    pub interject:       Interjections,
    /// Facts about the machine this turn can reach, refreshed before each turn.
    ///
    /// Held behind a shared cell rather than folded into `system_prompt` because it changes
    /// per TURN and the prompt does not: what a command may touch depends on the Diamond's
    /// bounds and on whether this turn has read a stranger's words, neither of which is known
    /// when the agent is built.  Shared on clone, exactly as [`Interjections`] is, so a
    /// derived agent sees the same machine -- and, unlike cloning the whole agent, this does
    /// not silently detach the live token counters the panel is reading.
    ///
    /// Empty when no hand is attached, and then nothing is added to the prompt at all: an
    /// absent capability is not worth describing on every request of every turn.
    pub briefing:        Rc<RefCell<String>>,
    /// How long a turn may run and how big its conversation may get.
    ///
    /// Shared on clone, exactly as [`Interjections`] is, so a worker dispatched from a turn
    /// inherits the model's context window rather than falling back to the default and
    /// folding its own conversation at the wrong size.
    pub limits:          Rc<RefCell<Limits>>,
    /// What a byte of this conversation costs in tokens, as the provider last charged it.
    pub gauge:           Rc<Gauge>,
    /// The user's replacement for the compactor's prompt, from `prompts/compactor.md`;
    /// empty means the shipped default.
    ///
    /// Held here rather than composed into `system_prompt` because it is not this
    /// agent's prompt at all -- it is what a DIFFERENT, tool-less model is told when the
    /// conversation is folded.  Shared on clone for the same reason [`Interjections`] is.
    pub fold_prompt:     Rc<RefCell<String>>,
}

impl Agent {

    pub fn new(llm: LlmClient, system_prompt: &str) -> Self {
        Self {
            llm,
            system_prompt: system_prompt.to_string(),
            live_prompt:     Cell::new(0),
            live_completion: Cell::new(0),
            live_cached:     Cell::new(0),
            live_cost:       Cell::new(0.0),
            interject:       new_interjections(),
            briefing:        Rc::new(RefCell::new(String::new())),
            limits:          Rc::new(RefCell::new(Limits::default())),
            gauge:           Rc::new(Gauge::default()),
            fold_prompt:     Rc::new(RefCell::new(String::new())),
        }
    }

    /// Tell this agent how big the model's context window is, so a conversation is folded
    /// before the provider refuses it rather than after.
    ///
    /// Zero means nobody has said, and the default window is assumed instead; the reactive
    /// path still catches a refusal either way.
    ///
    /// # Arguments
    /// * `tokens` - The window the provider publishes for this model.
    pub fn set_context_window(&self, tokens: u64) {
        self.limits.borrow_mut().window = tokens;
    }

    /// Set how many tool-call rounds one turn may take.
    ///
    /// # Arguments
    /// * `n` - The ceiling; zero is ignored, since a turn that may take no rounds is a turn
    ///   with no tools.
    pub fn set_max_rounds(&self, n: usize) {
        if n > 0 {
            self.limits.borrow_mut().max_rounds = n;
        }
    }

    /// Fold this agent's conversations with a different model from the one it chats with.
    ///
    /// Empty -- the default -- means the chat's own model.  A summary becomes the session's
    /// memory, so the cheaper model is not chosen on the user's behalf: they choose it.
    ///
    /// # Arguments
    /// * `model` - The provider's id for the model, or empty for the chat's own.
    pub fn set_fold_model(&self, model: &str) {
        self.limits.borrow_mut().fold_model = model.to_string();
    }

    /// What bounds this agent's turns right now.
    pub fn limits(&self) -> Limits {
        self.limits.borrow().clone()
    }

    /// Fold by the same figures as another agent.
    ///
    /// [`Agent::new`] starts from [`Limits::default`], which assumes a window nobody has
    /// published and the shipped round ceiling.  A Diamond's daimon and its reducer are
    /// each built that way, from the chat's own client -- so without this they would fold
    /// the SAME model's conversation at a different size from the chat, and on a model
    /// whose real window is smaller than the assumed one they would learn that the hard
    /// way all over again.  Cloning an agent shares these already; this is for the case
    /// where a fresh one is constructed because its system prompt differs.
    ///
    /// # Arguments
    /// * `from` - The agent whose limits are the right ones.
    pub fn adopt_limits(&self, from: &Agent) {
        *self.limits.borrow_mut() = from.limits();
    }

    /// Set what the model folding this agent's conversations is told.
    ///
    /// Empty -- the default -- means [`Role::Compactor`]'s shipped prompt, which is how
    /// deleting `prompts/compactor.md` puts the original back.
    ///
    /// # Arguments
    /// * `text` - What the user wrote, or empty for the default.
    pub fn set_fold_prompt(&self, text: &str) {
        *self.fold_prompt.borrow_mut() = text.to_string();
    }

    /// What the folding model is told, composed from the user's text or the default.
    pub fn fold_prompt(&self) -> String {
        Role::Compactor.compose(&self.fold_prompt.borrow())
    }

    /// Set what this turn should know about the machine it can reach.
    ///
    /// Called before a turn, from the caller that can await the hand.  Empty clears it.
    ///
    /// # Arguments
    /// * `text` - The briefing, already composed.
    pub fn set_briefing(&self, text: &str) {
        *self.briefing.borrow_mut() = text.to_string();
    }

    /// Say something into a turn that is already running.
    ///
    /// Takes effect at the next seam between rounds, which is the earliest moment a
    /// model can act on it.  Returns how many are now waiting, so the caller can draw
    /// them without reaching into the queue itself.
    ///
    /// # Arguments
    /// * `text` - What the user said. Blank input is ignored rather than queued.
    pub fn interject(&self, text: &str) -> usize {
        let t = text.trim();
        if t.is_empty() {
            return self.interject.borrow().len();
        }
        let mut q = self.interject.borrow_mut();
        q.push(t.to_string());
        q.len()
    }

    /// What is waiting to be said, for the UI to draw.
    pub fn interjections(&self) -> Vec<String> {
        self.interject.borrow().clone()
    }

    /// Take everything waiting, leaving the queue empty.
    ///
    /// Drained rather than read so that a message cannot be delivered twice: it is
    /// pushed into the conversation the moment it is taken, and the conversation is
    /// the record from then on.
    fn take_interjections(&self) -> Vec<String> {
        let mut q = self.interject.borrow_mut();
        if q.is_empty() { return Vec::new(); }
        std::mem::take(&mut *q)
    }

    /// Run a single agent turn.
    ///
    /// 1. Append the user message to the session.
    /// 2. Build the LLM request: system prompt + conversation history.
    /// 3. Call the LLM with streaming.
    /// 4. Stream tokens back to the caller via `on_event`.
    /// 5. Append the assistant response to the session.
    /// 6. Emit `Done`.
    pub async fn run_turn(
        &self,
        session:    &mut Session,
        user_msg:   String,
        registry:   &ToolRegistry,
        on_event:   &mut impl FnMut(AgentEvent),
    ) -> Outcome<()> {
        // Append the user message to the persisted history.
        session.messages.push(ChatMessage::user(user_msg));

        // Build the working conversation: system prompt + history.
        let mut working = Vec::with_capacity(session.messages.len() + 1);
        if !self.system_prompt.is_empty() {
            let mut sys = self.system_prompt.clone();
            if !registry.is_empty() {
                // Name the tools that are actually registered. A fixed sentence
                // here once promised a shell tool the browser build does not
                // have, so a capable model would call it, fail, and report the
                // failure as work done.
                sys.push_str(&fmt!(
                    "\n\nYou have exactly these tools, all scoped to the user's \
                     workspace: {}. Use them to inspect and change the workspace \
                     when completing a task. You have no other tools; never claim \
                     to have performed an action you had no tool to perform.",
                    registry.tool_names().join(", ")));
            }
            // The machine, last, so it sits closest to the conversation and is the most recent
            // thing the model read before the user's own words.
            let brief = self.briefing.borrow();
            if !brief.trim().is_empty() {
                sys.push_str("\n\n");
                sys.push_str(brief.trim());
            }
            working.push(ChatMessage::system(sys));
        }
        working.extend(session.messages.iter().cloned());

        if registry.is_empty() {
            return self.run_streaming(session, working, on_event).await;
        }
        self.run_tool_loop(session, working, registry, on_event).await
    }

    /// Pure-chat path: stream tokens as they arrive (no tools).
    ///
    /// Folded before the request goes out, and folded again if the provider refuses it for
    /// being too long -- the second is the net under the first.  Without it a chat whose
    /// window nobody published dies once and then dies on every turn after, because the
    /// same oversized history is sent again.
    async fn run_streaming(
        &self,
        session:    &mut Session,
        mut working: Vec<ChatMessage>,
        on_event:   &mut impl FnMut(AgentEvent),
    ) -> Outcome<()> {
        let mut refolded = false;
        loop {
            self.fold_if_needed(session, &mut working, 0, false, on_event).await;
            let sent = compact::conversation_bytes(&working);
            let mut full = String::new();
            let result = self.llm.chat_stream(
                &working,
                &mut |token| {
                    full.push_str(token);
                    on_event(AgentEvent::Text(token.to_string()));
                },
            ).await;
            match result {
                Ok(resp) => {
                    let content = if resp.content.is_empty() { full } else { resp.content };
                    session.messages.push(ChatMessage::assistant(content));
                    session.prompt_tokens += resp.prompt_tokens;
                    session.completion_tokens += resp.completion_tokens;
                    session.cached_tokens += resp.cached_tokens;
                    session.cost_usd += resp.cost_usd;
                    if resp.prompt_tokens > 0 { session.last_prompt_tokens = resp.prompt_tokens; }
                    if resp.truncated { on_event(AgentEvent::Truncated); }
                    self.gauge.observe(sent, resp.prompt_tokens);
                    self.live_prompt.set(session.prompt_tokens);
                    self.live_completion.set(session.completion_tokens);
                    self.live_cached.set(session.cached_tokens);
                    self.live_cost.set(session.cost_usd);
                    on_event(AgentEvent::Done);
                    return Ok(());
                }
                Err(e) => {
                    if !refolded && self.overflowed(&e, sent) {
                        refolded = true;
                        if self.fold_if_needed(session, &mut working, 0, true, on_event).await {
                            continue;
                        }
                    }
                    on_event(AgentEvent::Error(e.to_string()));
                    return Err(e);
                }
            }
        }
    }

    /// Agentic path: streaming request/response, executing tool calls
    /// between rounds until the model returns a final answer.  Each round
    /// streams with tools enabled, so assistant text arrives token by
    /// token even while tools are active (via `chat_stream_tools`); tool
    /// calls are reconstructed from the streamed fragments and fired as
    /// before.  The whole exchange -- the assistant turn that asked for the
    /// tools, each tool result, and the final answer -- is persisted to the
    /// session, so a later turn still sees what this agent did.  Persisting
    /// only the final text once left the model amnesiac: asked a follow-up, it
    /// had no record of its own tool calls and could not say what it had done.
    async fn run_tool_loop(
        &self,
        session:    &mut Session,
        mut working: Vec<ChatMessage>,
        registry:   &ToolRegistry,
        on_event:   &mut impl FnMut(AgentEvent),
    ) -> Outcome<()> {
        let tools_json = registry.definitions_json();
        // The tool schema rides on every request and is not in the conversation, so it is
        // counted separately -- a budget blind to it is short by however many tools are
        // registered, which for the browser set is several thousand tokens.
        let schema = tools_json.as_ref().map(|s| s.len() as u64).unwrap_or(0);
        let max_rounds = self.limits.borrow().max_rounds;
        for _ in 0..max_rounds {
            // Fold before the request rather than after the refusal. Checked every round,
            // because a single turn of fifty file reads can outgrow the window on its own,
            // without any earlier turn being large at all.
            self.fold_if_needed(session, &mut working, schema, false, on_event).await;
            let mut sent = compact::conversation_bytes(&working);

            // Stream this round's assistant text as it arrives; the tool
            // calls (if any) are returned assembled once the round ends.
            let mut refolded = false;
            let resp = loop {
                match self.llm.chat_stream_tools(
                    &working,
                    tools_json.as_deref(),
                    &mut |token| on_event(AgentEvent::Text(token.to_string())),
                ).await {
                    Ok(r) => break r,
                    Err(e) => {
                        // The net under the proactive fold: a window nobody published, or
                        // an estimate that ran short. One retry, and only for a refusal
                        // that looks like the prompt being too long.
                        if !refolded && self.overflowed(&e, sent + schema) {
                            refolded = true;
                            if self.fold_if_needed(session, &mut working, schema, true, on_event).await {
                                sent = compact::conversation_bytes(&working);
                                continue;
                            }
                        }
                        on_event(AgentEvent::Error(e.to_string()));
                        return Err(e);
                    }
                }
            };
            self.gauge.observe(sent + schema, resp.prompt_tokens);
            session.prompt_tokens += resp.prompt_tokens;
            session.completion_tokens += resp.completion_tokens;
            // Both are per ROUND, and a tool loop runs many: each round's prompt
            // is the last one's plus a little, so the cache read and the reported
            // cost accumulate exactly as the token counters do.
            session.cached_tokens += resp.cached_tokens;
            session.cost_usd += resp.cost_usd;
            if resp.prompt_tokens > 0 { session.last_prompt_tokens = resp.prompt_tokens; }
            self.live_prompt.set(session.prompt_tokens);
            self.live_completion.set(session.completion_tokens);
            self.live_cached.set(session.cached_tokens);
            self.live_cost.set(session.cost_usd);

            // Said outright rather than left to be inferred. It is not an error and is
            // not retried: the request succeeded and a setting was reached, so sending
            // it again would cost the same money and produce the same cut.
            if resp.truncated {
                on_event(AgentEvent::Truncated);
            }

            // Cancelled mid-stream: keep the partial answer already
            // streamed and end the turn cleanly, without an error.
            if resp.aborted {
                session.messages.push(ChatMessage::Assistant {
                    content: MessageContent::text(resp.content), tool_calls: Vec::new(),
                });
                on_event(AgentEvent::Done);
                return Ok(());
            }

            if resp.tool_calls.is_empty() {
                // Final answer — its text has already streamed via the
                // token callback, so it is not re-emitted here.
                session.messages.push(ChatMessage::Assistant {
                    content: MessageContent::text(resp.content), tool_calls: Vec::new(),
                });
                on_event(AgentEvent::Done);
                return Ok(());
            }

            // Any interim assistant text alongside the tool calls has already
            // streamed. Record the assistant turn in both the working vec, which
            // drives the rest of this turn, and the session, so a later turn
            // still carries it. The API also requires that an assistant turn
            // bearing tool_calls be followed by a tool reply for each of them,
            // which the loop below then supplies.
            let asked = ChatMessage::Assistant {
                content: MessageContent::text(resp.content.clone()),
                tool_calls: resp.tool_calls.clone(),
            };
            working.push(asked.clone());
            session.messages.push(asked);

            // Execute each requested tool call, recording every result in both
            // places for the same reason.
            for tc in &resp.tool_calls {
                on_event(AgentEvent::ToolCall { name: tc.name.clone(), args: tc.arguments.clone() });
                // A call cut at the output limit is not a call. Its arguments are a JSON
                // object that stops in the middle, and dispatching it yields a parse
                // error -- which reads to the model as its own mistake, so it writes the
                // same thing again and is cut in the same place. Told what actually
                // happened, it splits the work instead.
                let result = if cut_short(resp.truncated, &tc.arguments) {
                    // The cap that was SENT, not the one configured. The note says the number so
                    // the model can size its next call by it, and telling a model its reply was
                    // cut at 4,096 when it was cut at 32,000 sends it splitting the work eight
                    // times finer than it needs to.
                    MessageContent::text(truncated_call_note(self.reply_cap()))
                } else {
                    registry.dispatch(&tc.name, &tc.arguments).await
                };
                // The event carries the TEXT of the result and not the image. Everything
                // downstream of it -- the panel, the journal's write-ahead log, the transcript on
                // screen -- renders a string, and an image inside that string would be a base64
                // wall in a tile. The image travels in the message instead, where the model is
                // the only reader of it.
                on_event(AgentEvent::ToolResult {
                    name:   tc.name.clone(),
                    result: result.as_text().into_owned(),
                });
                let reply = ChatMessage::tool(tc.id.clone(), result);
                working.push(reply.clone());
                session.messages.push(reply);
            }

            // THE SEAM. The tool replies are in, and the next request has not gone out,
            // so this is the one moment in a round where the conversation can grow by
            // something the model has not already been told. Anything the user said
            // while the tools ran goes in here, and the next round is built with it.
            //
            // After the tool replies rather than before them, because the API requires
            // every tool_call to be answered by a tool message: a user turn wedged
            // between the two is a malformed request, and a provider is entitled to
            // reject the whole thing.
            for said in self.take_interjections() {
                on_event(AgentEvent::Interjected(said.clone()));
                let msg = ChatMessage::user(said);
                working.push(msg.clone());
                session.messages.push(msg);
            }
        }

        // Exceeded the tool-round budget.
        //
        // Recorded in the SYSTEM voice, because that is whose it is. It used to be pushed
        // as an assistant message reading "[Reached the tool-call round limit (25).]", so
        // on the next turn the model read its own surrender back as something it had said
        // and behaved accordingly -- a turn that was stopped from outside became, in the
        // record, a turn that gave up. The boundary belongs to the app, so it is said in
        // the app's voice, and it says the work may be unfinished rather than that it is
        // over.
        let msg = fmt!("Reached the tool-call round limit ({}).", max_rounds);
        on_event(AgentEvent::Error(msg.clone()));
        session.messages.push(compact::round_limit_note(max_rounds));
        on_event(AgentEvent::Done);
        Ok(())
    }


    // ┌───────────────────────────────────────────────────────────┐
    // │ Folding a conversation that no longer fits                 │
    // └───────────────────────────────────────────────────────────┘

    /// The output cap this turn's requests will ACTUALLY carry, which is not always the one the
    /// client was configured with.
    ///
    /// [`crate::compact::Limits::budget`] subtracts the reply from the window to decide how big a
    /// prompt may be, so it has to be given the figure the provider will be sent.  It was being
    /// given `llm.max_tokens`, and on the one path that matters that is the wrong figure by a
    /// factor of eight: a streamed Anthropic request to a model that takes adaptive thinking is
    /// sent `THINKING_MIN_MAX_TOKENS`, because thinking is billed as output and counts against the
    /// same cap.
    ///
    /// **On a large window the error is invisible and on a small one it is fatal.**  With 131,072
    /// tokens the fraction ceiling is the lower of the two and wins whatever the reserve says.  But
    /// a window is not always the published one: [`Limits::learn_from_refusal`] sets it from a
    /// provider's refusal, and at 40,000 the old figure reserved 5,120 tokens for a reply that may
    /// run to 32,000, left a budget the conversation already fitted, folded nothing, sent the same
    /// prompt, and was refused again -- a turn with no way out, arrived at by the very mechanism
    /// that exists to recover from the first refusal.
    ///
    /// The agent always streams (see [`Agent::run_streaming`] and the tool loop), so the streaming
    /// half of the client's rule is a constant here and only the model has to be asked about.
    fn reply_cap(&self) -> u32 {
        match self.llm.dialect {
            crate::llm::Dialect::Anthropic
                if crate::llm::model_takes_adaptive_thinking(&self.llm.model) =>
                    self.llm.max_tokens.max(crate::llm::THINKING_MIN_MAX_TOKENS),
            _ => self.llm.max_tokens,
        }
    }

    /// Whether a failed round was the provider refusing an oversized prompt.
    ///
    /// # Arguments
    /// * `e` - The error the call returned.
    /// * `bytes` - Bytes of prompt that were refused.
    fn overflowed(&self, e: &Error<ErrTag>, bytes: u64) -> bool {
        let budget = self.limits.borrow().budget(self.reply_cap());
        compact::looks_like_overflow(&fmt!("{}", e), self.gauge.tokens(bytes), budget)
    }

    /// Fold the conversation if it no longer fits, and rebuild `working` from what is left.
    ///
    /// Returns whether anything changed.  Two mechanisms, tried in that order and both
    /// bounded:
    ///
    /// 1. **Fold.** Everything before the cut becomes one note carrying a summary and a
    ///    ledger of what was touched; everything after it is kept exactly as it was.
    /// 2. **Elide.** Whatever is still too big has its older tool results shrunk in place.
    ///    This adds and removes nothing, so it cannot orphan a tool call, and it is the only
    ///    thing that helps when the conversation is one enormous turn with no earlier part
    ///    to fold.
    ///
    /// It never gives up and sends the oversized history, because that is the bug: the
    /// provider refuses it, the turn dies, and the next turn sends the same thing.
    ///
    /// # Arguments
    /// * `session` - The durable conversation, folded in place.
    /// * `working` - This turn's message list, rebuilt from the session when anything moved.
    /// * `schema` - Bytes of tool definitions riding alongside the conversation.
    /// * `force` - Fold whatever the estimate says, because the provider has already refused.
    /// * `on_event` - Where the user is told, since a silent fold is the one people hate.
    async fn fold_if_needed(
        &self,
        session:    &mut Session,
        working:    &mut Vec<ChatMessage>,
        schema:     u64,
        force:      bool,
        on_event:   &mut impl FnMut(AgentEvent),
    )
        -> bool
    {
        // Forced means the provider has already refused this prompt, which is the only
        // occasion it ever says anything about the size of its window. Believing it is what
        // lets a chat against a model nobody published a window for recover instead of
        // folding to a budget that was never the real one.
        if force {
            let refused = self.gauge.tokens(compact::conversation_bytes(working) + schema);
            self.limits.borrow_mut().learn_from_refusal(refused);
        }
        let (budget, tail, model) = {
            let l = self.limits.borrow();
            let cap = self.reply_cap();
            (l.budget(cap), l.tail_budget(cap), l.fold_model.clone())
        };
        let before = compact::conversation_bytes(&session.messages);
        if !force && self.gauge.tokens(compact::conversation_bytes(working) + schema) <= budget {
            return false;
        }

        let mut folded  = 0usize;
        let mut trouble = String::new();
        // The hard ceiling is the budget itself: however few messages that leaves, a tail
        // bigger than what may be sent is a fold that changed nothing.
        let ceiling = self.gauge.bytes(budget).saturating_sub(schema);
        let cut = compact::tail_start(&session.messages, self.gauge.bytes(tail).min(ceiling),
            compact::MIN_KEEP_MESSAGES, ceiling);
        if cut > 0 {
            // Built before the summarising call, so a call that fails still leaves a
            // truthful record: which files were read, which were written, what ran, and
            // which of those failed. That is the part no model is asked for and so no model
            // can lose.
            let ledger   = compact::ledger_of(&session.messages[..cut]);
            let rendered = compact::render_for_fold(&session.messages[..cut],
                compact::FOLD_INPUT_CAP);
            let (prose, why) = match self.summarise(&rendered, &model, session).await {
                Ok(s)  => (s, None),
                Err(e) => (String::new(), Some(fmt!("{}", e))),
            };
            if let Some(ref w) = why { trouble = w.clone(); }
            let note = compact::notice(cut, &prose, &ledger, why.as_deref());
            match compact::fold(&session.messages, cut, note) {
                Ok(new) => {
                    // A fold that made the conversation bigger is not a fold; it happens
                    // when the folded part was small and the note is not.
                    if compact::conversation_bytes(&new) < before {
                        session.messages = new;
                        folded = cut;
                    }
                },
                // Refused rather than allowed to orphan a tool call. Eliding below still
                // shrinks the same conversation, and cannot orphan anything at all.
                Err(e) => trouble = fmt!("{}", e),
            }
        }

        // Two passes, and the second is what makes the guarantee hold: the first leaves the
        // newest messages alone, and if the conversation is STILL too big it is because
        // those are the bulky ones, so the second reaches them too. The user's own words
        // are never touched by either.
        let mut elided = compact::elide_bulk(&mut session.messages, ceiling,
            compact::MIN_KEEP_MESSAGES);
        elided += compact::elide_bulk(&mut session.messages, ceiling, 1);
        let changed = folded > 0 || elided > 0;
        if !changed {
            return false;
        }

        // Rebuild the turn's list: the system prompt this turn was built with, then the
        // conversation as it now stands. The two are kept in lockstep for the whole turn,
        // so anything else would leave the model reading a history the session no longer
        // holds.
        let sys = match working.first() {
            Some(m @ ChatMessage::System { .. }) => Some(m.clone()),
            _ => None,
        };
        working.clear();
        if let Some(s) = sys { working.push(s); }
        working.extend(session.messages.iter().cloned());

        // Told, not done quietly. A fold is lossy, and a user who is not shown one has no
        // way to tell a model that forgot from a model that never knew.
        let after = compact::conversation_bytes(&session.messages);
        let mut said = fmt!(
            "Folded {} earlier messages and shortened {} tool results: {} tokens of \
             conversation became about {}.",
            folded, elided, self.gauge.tokens(before), self.gauge.tokens(after));
        if !trouble.is_empty() {
            said.push_str(&fmt!(" The summary could not be written ({}), so only the record \
                of what was read and written was kept.", trouble));
        }
        // Its own event, not a borrowed tool row. A fold is something the app did to the
        // user's conversation, and it is lossy; the counts travel beside the sentence so a
        // client can draw it as the act it was rather than parse prose to find out.
        on_event(AgentEvent::Compacted {
            folded,
            kept: session.messages.len(),
            note: said,
        });
        true
    }

    /// Ask a model to summarise the part of the conversation being folded.
    ///
    /// Non-streaming and tool-less: nothing here should reach the user's thread or touch
    /// their files.  The input is already bounded by [`compact::render_for_fold`], and the
    /// output is capped, so the call costs a fixed amount however long the session got --
    /// which matters, because the alternative to folding is paying for the whole history on
    /// every round from now until the chat is closed.
    ///
    /// # Arguments
    /// * `rendered` - The folded part as a bounded transcript.
    /// * `model` - The model to fold with, or empty for the chat's own.
    /// * `session` - Charged with what the call cost, so the fold is not spent invisibly.
    async fn summarise(
        &self,
        rendered: &str,
        model:    &str,
        session:  &mut Session,
    )
        -> Outcome<String>
    {
        let mut llm = self.llm.clone();
        if !model.trim().is_empty() {
            llm.model = model.trim().to_string();
        }
        llm.max_tokens = compact::FOLD_MAX_TOKENS;
        let msgs = vec![
            ChatMessage::system(self.fold_prompt()),
            ChatMessage::user(fmt!(
                "Here is the earlier part of the conversation.\n\n{}", rendered)),
        ];
        let resp = res!(llm.chat_once(&msgs, None).await);
        session.prompt_tokens     += resp.prompt_tokens;
        session.completion_tokens += resp.completion_tokens;
        session.cached_tokens     += resp.cached_tokens;
        session.cost_usd          += resp.cost_usd;
        self.live_prompt.set(session.prompt_tokens);
        self.live_completion.set(session.completion_tokens);
        self.live_cached.set(session.cached_tokens);
        self.live_cost.set(session.cost_usd);
        if resp.content.trim().is_empty() {
            return Err(err!("Fold: the model returned an empty summary."; Invalid, Data));
        }
        Ok(resp.content)
    }
}


// ┌───────────────────────────────────────────────────────────────┐
// │ A reply that ran out of room                                   │
// └───────────────────────────────────────────────────────────────┘

/// Whether a tool call's arguments are the wreckage of a reply cut at the output limit.
///
/// Both halves are needed.  The provider's `finish_reason` says the reply was cut, but a
/// turn can be cut in its trailing prose with every tool call already whole -- and
/// refusing a complete call because a later sentence was truncated would break a turn
/// that was working.  So the arguments are checked too, and only a call that is BOTH
/// truncated and structurally incomplete is treated as one.
///
/// # Arguments
/// * `truncated` - What the provider said about why it stopped.
/// * `arguments` - The raw JSON arguments object as the model produced it.
pub fn cut_short(truncated: bool, arguments: &str) -> bool {
    truncated && !json_object_is_whole(arguments)
}

/// Whether `s` is a single JSON object with every brace, bracket and quote closed.
///
/// Structural only -- it says nothing about whether the fields are the right ones -- and
/// that is the whole question here: an object that stops in the middle is a reply that
/// ran out of room, and one that closes is a call worth dispatching whatever else may be
/// wrong with it.  String contents are skipped, so a brace inside a path or a piece of
/// source code is not counted.
///
/// # Arguments
/// * `s` - The raw arguments text.
pub fn json_object_is_whole(s: &str) -> bool {
    let t = s.trim();
    // The empty call, which `StreamAcc` normalises to `{}` and which is legal.
    if t.is_empty() {
        return true;
    }
    let b = t.as_bytes();
    if b[0] != b'{' {
        return false;
    }
    let mut depth = 0i32;
    let mut i = 0usize;
    while i < b.len() {
        match b[i] {
            b'{' | b'[' => depth += 1,
            b'}' | b']' => {
                depth -= 1;
                if depth == 0 {
                    // Anything after the close is not this object's business, but the
                    // object itself arrived whole.
                    return true;
                }
                if depth < 0 {
                    return false;
                }
            },
            // Skip the string's contents. Without this a brace inside a file being
            // written -- `fn main() {` -- would be counted as structure, and a complete
            // call would read as a cut one. A string the reply stopped INSIDE, which is
            // the commonest cut of all, runs to the end of the input and falls out of
            // the loop below unclosed, which is already the answer.
            b'"' => {
                i += 1;
                while i < b.len() {
                    if b[i] == b'\\' { i += 2; continue; }
                    if b[i] == b'"'  { break; }
                    i += 1;
                }
            },
            _ => {},
        }
        i += 1;
    }
    false
}

/// What the model is told when its own tool call was cut at the output limit.
///
/// A sentence it can act on, not a parse error.  Shown a parse error a model reads its
/// own JSON as the mistake and writes the same call again, which is cut in the same
/// place; told that the reply ran out of room, it splits the work.  It says the number,
/// because "smaller" without a figure is advice rather than a constraint.
///
/// # Arguments
/// * `max_tokens` - The output cap this turn ran under.
pub fn truncated_call_note(max_tokens: u32) -> String {
    fmt!(
        "Error: your reply was cut off at the output limit of {} tokens, part-way through \
         the arguments of this tool call, so it could not be run. Nothing was changed. \
         The JSON was not wrong -- there was no room left for the rest of it. Do the same \
         work in smaller pieces: write or edit a part at a time, or read a range rather \
         than a whole file, so that no single call carries this much text.",
        max_tokens)
}


// ┌───────────────────────────────────────────────────────────────┐
// │ TLS config helper                                              │
// └───────────────────────────────────────────────────────────────┘

/// Build a TLS client config using the system CA bundle.
///
/// Reused from Steel's `build_outbound_tls_client` — same approach
/// but kept here so `daimond` can be used standalone.
#[cfg(not(target_arch = "wasm32"))]
pub fn build_tls_client_config() -> Outcome<Arc<ClientConfig>> {
    use tokio_rustls::rustls::{
        ClientConfig,
        RootCertStore,
        pki_types::CertificateDer,
    };

    let ca_paths = [
        "/etc/ssl/certs/ca-certificates.crt",
        "/etc/pki/tls/certs/ca-bundle.crt",
        "/etc/ssl/cert.pem",
    ];
    let ca_file = match ca_paths.iter().find(|p| std::path::Path::new(p).exists()) {
        Some(p) => *p,
        None => return Err(err!(
            "No system CA bundle found."; Init, Missing, File)),
    };

    let pem_data = match std::fs::read(ca_file) {
        Ok(d) => d,
        Err(e) => return Err(err!(e, "Failed to read CA bundle."; File, Read)),
    };

    let mut roots = RootCertStore::empty();
    let certs: Vec<CertificateDer> = rustls_pemfile::certs(&mut pem_data.as_slice())
        .filter_map(|c| c.ok())
        .map(CertificateDer::from)
        .collect();
    for cert in certs {
        let _ = roots.add(cert);
    }

    let mut config = ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    // Advertise HTTP/1.1 via ALPN so CDN-fronted servers (e.g.
    // Fireworks.ai behind Cloudflare) don't close the connection
    // after the TLS handshake when no protocol is negotiated.
    config.alpn_protocols = vec![b"http/1.1".to_vec()];

    Ok(Arc::new(config))
}


// ┌───────────────────────────────────────────────────────────────┐
// │ Tests                                                          │
// └───────────────────────────────────────────────────────────────┘

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::LlmClient;

    fn make_test_agent() -> Agent {
        let tls = build_test_tls_config();
        let llm = LlmClient::new("api.test.com", 443, "/v1/chat", "key", "model", 4096, tls);
        Agent::new(llm, "You are Daimond, an AI assistant.")
    }

    fn build_test_tls_config() -> Arc<ClientConfig> {
        use rustls::crypto::ring;
        let _ = ring::default_provider().install_default();
        ClientConfig::builder()
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(crate::llm::tests::NoVerify))
            .with_no_client_auth().into()
    }

    #[test]
    fn test_agent_creation() {
        let agent = make_test_agent();
        assert_eq!(agent.system_prompt, "You are Daimond, an AI assistant.");
    }

    // ── Speaking into a running turn ────────────────────────────────

    #[test]
    fn test_what_the_user_says_mid_turn_is_kept_until_there_is_a_seam_00() {
        let a = make_test_agent();
        assert_eq!(a.interjections().len(), 0, "nothing is waiting before anything is said");
        assert_eq!(a.interject("no, use the other file"), 1);
        assert_eq!(a.interject("  and run the tests  "), 2);
        // Held, not lost: the UI has to be able to draw what is waiting, because a
        // correction that vanishes between typing it and its taking effect reads as
        // an app that ignored you.
        assert_eq!(a.interjections(), vec![
            fmt!("no, use the other file"), fmt!("and run the tests")]);
    }

    #[test]
    fn test_blank_input_is_not_an_interjection_00() {
        let a = make_test_agent();
        assert_eq!(a.interject("   "), 0);
        assert_eq!(a.interject("\n\t"), 0);
        assert!(a.interjections().is_empty(), "whitespace is not a correction");
    }

    #[test]
    fn test_taking_them_empties_the_queue_so_none_is_said_twice_00() {
        // Drained rather than read: once it is in the conversation, the conversation
        // is the record. A queue that still held it would say it again next round,
        // and a model told the same correction three times reasonably concludes it
        // has not yet complied.
        let a = make_test_agent();
        a.interject("stop and summarise");
        let taken = a.take_interjections();
        assert_eq!(taken, vec![fmt!("stop and summarise")]);
        assert!(a.interjections().is_empty());
        assert!(a.take_interjections().is_empty(), "a second take yields nothing");
    }

    #[test]
    fn test_an_interjection_is_a_user_turn_in_the_conversation_00() {
        // The shape the seam pushes. It has to be a User message: an Assistant or a
        // Tool message would be the model reading its own words back as though it
        // had said them, which is the opposite of being corrected.
        let a = make_test_agent();
        a.interject("actually, target wasm");
        let taken = a.take_interjections();
        let msg = ChatMessage::user(taken[0].clone());
        assert_eq!(msg.role(), "user");
        assert_eq!(msg.text(), "actually, target wasm");
    }

    // ── What bounds a turn ──────────────────────────────────────────────

    #[test]
    fn test_the_round_limit_and_the_window_are_settable_00() {
        // Neither is a constant any more: the window is per-model and comes from the
        // provider's own catalogue, and a user who wants a longer leash should be able to
        // have one without a rebuild.
        let a = make_test_agent();
        assert_eq!(a.limits().max_rounds, compact::DEFAULT_MAX_ROUNDS);
        assert_eq!(a.limits().window, 0, "nobody has said what the window is yet");
        a.set_context_window(204_800);
        a.set_max_rounds(60);
        assert_eq!(a.limits().window, 204_800);
        assert_eq!(a.limits().max_rounds, 60);
        // A ceiling of zero is a turn with no tools, which is not what anyone means.
        a.set_max_rounds(0);
        assert_eq!(a.limits().max_rounds, 60);
    }

    #[test]
    fn test_a_worker_inherits_the_window_of_the_turn_that_dispatched_it_00() {
        // Shared on clone, exactly as the interjection queue is. A worker that fell back to
        // the default window would fold its own conversation at the wrong size.
        let a = make_test_agent();
        a.set_context_window(32_768);
        let worker = a.clone();
        assert_eq!(worker.limits().window, 32_768);
        worker.set_max_rounds(9);
        assert_eq!(a.limits().max_rounds, 9);
    }

    #[test]
    fn test_an_agent_built_fresh_can_adopt_the_chats_figures_00() {
        // A Diamond's daimon and its reducer are each built with `Agent::new` rather
        // than cloned, because their system prompt differs -- and `Agent::new` starts
        // from the default window, which is a figure nobody published. Against the same
        // model as the chat they would then fold at a different size, and on a model
        // whose real window is smaller than the assumed one they would learn it the hard
        // way all over again, one dead turn each.
        let chat = make_test_agent();
        chat.set_context_window(32_768);
        chat.set_max_rounds(40);
        chat.set_fold_model("cheap/fast");
        let derived = Agent::new(chat.llm.clone(), "a different prompt");
        assert_eq!(derived.limits().window, 0, "a fresh agent starts knowing nothing");
        derived.adopt_limits(&chat);
        assert_eq!(derived.limits().window, 32_768);
        assert_eq!(derived.limits().max_rounds, 40);
        assert_eq!(derived.limits().fold_model, "cheap/fast");
        assert_eq!(derived.limits().budget(4_096), chat.limits().budget(4_096),
            "the two fold at different sizes against the same model");
    }

    #[test]
    fn test_adopting_leaves_the_agent_it_copied_from_alone_00() {
        // It copies one way. Writing into `from` instead -- or as well -- would let a
        // worker's own overflow shrink the chat's window under the user, which is a
        // thing they never did and cannot see.
        let chat = make_test_agent();
        chat.set_context_window(32_768);
        chat.set_max_rounds(40);
        let derived = Agent::new(chat.llm.clone(), "worker");
        derived.set_max_rounds(9);
        derived.adopt_limits(&chat);
        assert_eq!(chat.limits().window, 32_768, "the chat's window moved");
        assert_eq!(chat.limits().max_rounds, 40, "the chat's round ceiling moved");
        // And afterwards the two are independent, not one cell shared between them.
        derived.set_context_window(8_192);
        assert_eq!(chat.limits().window, 32_768, "the two share one figure");
    }

    // ── What the fold is told ───────────────────────────────────────────

    #[test]
    fn test_the_fold_runs_under_the_compactors_prompt_00() {
        // It used to be a private constant in `compact`, which made it the one prompt in
        // the app the user could neither read nor change.
        let a = make_test_agent();
        assert_eq!(a.fold_prompt(), compact_role_default());
        assert!(a.fold_prompt().contains("context window"), "{}", a.fold_prompt());
    }

    #[test]
    fn test_a_rewritten_fold_prompt_reaches_the_summarising_call_00() {
        let a = make_test_agent();
        a.set_fold_prompt("Answer with the file names and nothing else.");
        assert_eq!(a.fold_prompt(), "Answer with the file names and nothing else.");
        // And emptying it puts the shipped prompt back, which is what deleting
        // `prompts/compactor.md` does.
        a.set_fold_prompt("   ");
        assert_eq!(a.fold_prompt(), compact_role_default());
    }

    #[test]
    fn test_the_fold_prompt_is_not_the_reducers_00() {
        // A user who has rewritten `prompts/reducer.md` for their Diamonds must not
        // thereby change how their chats are folded.
        let a = make_test_agent();
        assert_ne!(a.fold_prompt(), crate::prompts::DEFAULT_REDUCER);
        assert!(!a.fold_prompt().contains("crystal"), "{}", a.fold_prompt());
    }

    /// What the compactor is told when the user has not said otherwise.
    fn compact_role_default() -> String {
        Role::Compactor.compose("")
    }

    // ── How a fold reaches the user ─────────────────────────────────────

    /// An agent whose provider is a port nothing is listening on.
    ///
    /// Every call fails at once, which is the point: what is under test is what the app
    /// does BEFORE the request goes out, and a fold has to happen and be announced
    /// whether or not the turn that provoked it then succeeds.  Retrying is turned off
    /// so a refused connection costs no backoff.
    fn dead_agent() -> Agent {
        let tls = build_test_tls_config();
        let mut llm = LlmClient::new("127.0.0.1", 1, "/v1/chat", "key", "model", 4_096, tls);
        llm.retry.max_attempts = 1;
        Agent::new(llm, "You are Daimond.")
    }

    /// A registry with no tools, so a turn takes the plain streaming path.
    fn no_tools() -> crate::tools::ToolRegistry {
        // A scratch directory under the user cache, not the tmpfs at `/tmp`, and one
        // per call rather than one per process: keyed on the process identifier, every
        // turn in the file shared a workspace.
        let dir = match oxedyne_fe2o3_test::scratch::scratch_dir("daimond_agent_test") {
            Ok(d)  => d,
            Err(e) => panic!("a scratch directory: {}", e),
        };
        let ws = match crate::workspace::Workspace::new(dir) {
            Ok(w)  => w,
            Err(e) => panic!("a scratch workspace: {}", e),
        };
        crate::tools::ToolRegistry::new(Vec::new(), crate::tools::ToolContext {
            workspace:   ws,
            executor:    crate::executor::Executor::local_default(),
            cwd:         String::new(),
            path_prefix: String::new(),
            root:        crate::tools::FileRoot::Workspace,
            read_seen:   crate::tools::new_read_cache(),
            no_write:    Vec::new(),
        })
    }

    #[tokio::test]
    async fn test_a_fold_reaches_the_user_as_a_fold_00() {
        // It used to borrow the tool surface -- a ToolCall and a ToolResult both named
        // `context_compaction` -- so the browser drew the app's own lossy edit of the
        // user's conversation as an action row the model had taken. A fold is neither a
        // tool nor prose the model produced, and it now says so in its own variant.
        let a = dead_agent();
        a.set_context_window(8_192);
        let mut session = Session::new(fmt!("s1"), fmt!("long"), fmt!("model"));
        for i in 0..40 {
            session.messages.push(ChatMessage::user(fmt!("step {}", i)));
            session.messages.push(ChatMessage::Assistant {
                content: MessageContent::text("x".repeat(2_000)), tool_calls: Vec::new(),
            });
        }
        let registry = no_tools();
        let mut events: Vec<AgentEvent> = Vec::new();
        let _ = a.run_turn(&mut session, fmt!("carry on"), &registry,
            &mut |ev| events.push(ev)).await;

        let folds: Vec<&AgentEvent> = events.iter()
            .filter(|e| matches!(e, AgentEvent::Compacted { .. })).collect();
        assert_eq!(folds.len(), 1, "the conversation was {} events and none was a fold",
            events.len());
        match folds[0] {
            AgentEvent::Compacted { folded, kept, note } => {
                assert!(*folded > 0, "a fold that folded nothing");
                assert_eq!(*kept, session.messages.len(),
                    "the count does not match what the session now holds");
                assert!(note.contains("Folded"), "{}", note);
            }
            other => panic!("{:?}", other),
        }
        // And nothing on the borrowed surface, which a client draws as a collapsible
        // action row: a turn with no tools registered has no tool events at all.
        assert!(!events.iter().any(|e| matches!(e,
            AgentEvent::ToolCall { .. } | AgentEvent::ToolResult { .. })),
            "the fold is still announcing itself as a tool");
    }

    // ── A reply that ran out of room ────────────────────────────────────

    #[test]
    fn test_a_call_cut_at_the_limit_is_told_the_truth_rather_than_a_parse_error_00() {
        // The failure this replaces is the single most confusing one in a coding
        // session: the model asks to write a long file, the reply is cut in the middle
        // of the arguments, the dispatcher says the JSON was bad, and the model -- told
        // its own JSON was the mistake -- writes exactly the same thing again.
        let cut = r#"{"path":"src/big.rs","content":"fn main() {\n    let x ="#;
        assert!(cut_short(true, cut), "a cut object was not recognised as cut");
        let note = truncated_call_note(8_192);
        assert!(note.contains("cut off at the output limit"), "{}", note);
        assert!(note.contains("8192"), "the figure is what makes it actionable: {}", note);
        assert!(note.contains("smaller pieces"), "{}", note);
        assert!(note.contains("Nothing was changed"),
            "a model that thinks a half-written file exists will read it back: {}", note);
        // And it must not read as the model's own mistake, which is what sends it round
        // the same loop again.
        assert!(!note.to_lowercase().contains("invalid json"), "{}", note);
        assert!(!note.to_lowercase().contains("malformed"), "{}", note);
    }

    #[tokio::test]
    async fn test_a_turn_whose_tool_call_was_cut_tells_the_model_and_the_user_00() {
        // End to end, against a real TLS server streaming a real SSE body: the provider
        // says `finish_reason: "length"` half-way through a `file_write`'s arguments,
        // which is exactly what a model asked for a long file does under an output cap.
        use crate::llm::tests::{start_stub, stub_client, Reply};
        let (port, _seen) = start_stub(vec![Reply::Sse {
            chunks: vec![
                "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\
                 \"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\
                 \"file_write\",\"arguments\":\"\"}}]}}]}\n\n".to_string(),
                "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\
                 \"function\":{\"arguments\":\"{\\\"path\\\":\\\"big.rs\\\",\
                 \\\"content\\\":\\\"fn main() {\"}}]}}]}\n\n".to_string(),
                "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"length\"}]}\n\n"
                    .to_string(),
                "data: [DONE]\n\n".to_string(),
            ],
            reset_after: None,
        },
        // The round after it, so the turn ends of its own accord: a turn stopped at
        // the round limit emits an error of its own, which would mask the question.
        Reply::Sse {
            chunks: vec![
                "data: {\"choices\":[{\"delta\":{\"content\":\"I will split it.\"}}]}\n\n"
                    .to_string(),
                "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n"
                    .to_string(),
                "data: [DONE]\n\n".to_string(),
            ],
            reset_after: None,
        }]).await;
        let mut llm = stub_client(port);
        llm.retry.max_attempts = 1;
        llm.max_tokens = 8_192;
        let a = Agent::new(llm, "You are Daimond.");
        a.set_max_rounds(2);

        let registry = one_tool();
        let mut session = Session::new(fmt!("s1"), fmt!("cut"), fmt!("model"));
        let mut events: Vec<AgentEvent> = Vec::new();
        let _ = a.run_turn(&mut session, fmt!("write me a long file"), &registry,
            &mut |ev| events.push(ev)).await;

        // The user is told, in its own event rather than by the browser guessing from
        // arguments that will not parse.
        assert!(events.iter().any(|e| matches!(e, AgentEvent::Truncated)),
            "the reply was cut and nothing said so: {:?}",
            events.iter().map(|e| fmt!("{:?}", e)).collect::<Vec<_>>());
        // It is not reported as a failure: the request succeeded and a setting was hit.
        assert!(!events.iter().any(|e| matches!(e, AgentEvent::Error(_))),
            "a reply that hit the output cap was reported as an error");
        // And the MODEL is told what actually happened, in the tool reply it will read
        // on the next round -- not that its JSON was bad, which sends it round the same
        // loop writing the same thing.
        let reply = session.messages.iter().rev()
            .find_map(|m| match m {
                ChatMessage::Tool { content, .. } => Some(content.clone()),
                _ => None,
            })
            .expect("the cut call must still be answered, or the conversation is illegal");
        assert!(reply.as_text().contains("cut off at the output limit"), "{}", reply);
        assert!(reply.as_text().contains("smaller pieces"), "{}", reply);
        // Nothing was written: the arguments never reached the dispatcher.
        assert!(!reply.as_text().contains("Wrote"), "{}", reply);
    }

    /// A registry holding one tool, so a turn takes the agentic path.
    fn one_tool() -> crate::tools::ToolRegistry {
        let mut r = no_tools();
        r.tools = vec![crate::tools::Tool::FileWrite];
        r
    }

    #[test]
    fn test_a_whole_call_is_dispatched_even_when_the_reply_was_cut_00() {
        // A turn can be cut in its trailing prose with every call already complete.
        // Refusing those would break a turn that was working.
        for whole in [
            r#"{"path":"a.rs"}"#,
            r#"{}"#,
            r#"  {"argv":["cargo","test"]}  "#,
            // A brace and a quote inside a string are contents, not structure.
            r#"{"content":"fn main() { \"hi\" }"}"#,
            // And an UNBALANCED brace inside one, which is what the first line of
            // almost every source file the model writes looks like.
            r#"{"path":"a.rs","content":"fn main() {"}"#,
            r#"{"content":"}"}"#,
        ] {
            assert!(!cut_short(true, whole),
                "a complete call was withheld because a later sentence was cut: {}", whole);
            assert!(json_object_is_whole(whole), "{}", whole);
        }
    }

    #[test]
    fn test_a_broken_call_on_an_uncut_reply_is_still_the_models_own_mistake_00() {
        // Only the provider says why it stopped. Without that, an unbalanced object is
        // the model writing bad JSON, and telling it otherwise would send it splitting
        // work that was never too big.
        let broken = r#"{"path":"a.rs""#;
        assert!(!cut_short(false, broken));
        assert!(!json_object_is_whole(broken));
    }

    #[test]
    fn test_an_unterminated_string_is_the_commonest_cut_of_all_00() {
        // A file's contents, stopped mid-word. Every brace is balanced; the quote is not.
        let s = r#"{"path":"a.rs","content":"fn main() {}"#;
        assert!(!json_object_is_whole(s), "an unterminated string read as whole");
        assert!(cut_short(true, s));
    }

    /// An agent whose provider is Anthropic and whose model takes adaptive thinking, which is the
    /// one combination the client silently raises the output cap for.
    fn thinking_agent(max_tokens: u32) -> Agent {
        let tls = build_test_tls_config();
        let llm = LlmClient::new("api.anthropic.com", 443, "/v1/messages", "key",
            "claude-opus-5", max_tokens, tls);
        Agent::new(llm, "You are Daimond.")
    }

    /// How a turn recovers from a refusal: fold to the budget, send it, and be refused again
    /// whenever the prompt plus the reply the client will ask for still exceeds the window.
    ///
    /// Returns how many refusals it took to fit, and the prompt budget that finally did -- because
    /// the count alone understates the harm.  Each refusal costs a whole round trip AND teaches
    /// [`Limits::learn_from_refusal`] a smaller window, which is permanent for the session and
    /// never revised upward, so a needless refusal leaves the app folding a large model as though
    /// it were a small one for the rest of the conversation.
    ///
    /// The iteration is bounded: what is under test is a loop that need not terminate, and a test
    /// that reproduced it faithfully would not return.
    ///
    /// # Arguments
    /// * `a` - The agent, whose limits are ground down in place exactly as a real turn grinds them.
    /// * `window` - The provider's real window, which the app does not know and must discover.
    /// * `cap` - The output cap the budget is computed against; the bug is passing the wrong one.
    fn recovery(a: &Agent, window: u64, cap: u32) -> Option<(usize, u64)> {
        for round in 0..40 {
            let prompt = a.limits.borrow().budget(cap);
            // The whole request: what is sent, plus the room the client asks the provider to
            // leave for the answer. That sum is what the provider measures against its window.
            if prompt + (a.reply_cap() as u64) <= window {
                return Some((round, prompt));
            }
            // Refused. The app learns from the size of the PROMPT, which is all it sent.
            if !a.limits.borrow_mut().learn_from_refusal(prompt) {
                return None;         // nothing left to learn: the same prompt goes out for ever
            }
        }
        None
    }

    #[test]
    fn test_the_reply_cap_is_the_one_the_client_will_actually_send_00() {
        // A streamed Anthropic request to a thinking model is sent 32,000 whatever the client was
        // configured with, because thinking is billed as output and counts against the same cap.
        assert_eq!(32_000, thinking_agent(4_096).reply_cap());
        // A cap already above the floor is its own figure.
        assert_eq!(50_000, thinking_agent(50_000).reply_cap());
        // And nothing else is raised: not an Anthropic model that takes no adaptive thinking...
        let tls = build_test_tls_config();
        let old = Agent::new(LlmClient::new("api.anthropic.com", 443, "/v1/messages", "key",
            "claude-3-5-sonnet-20241022", 4_096, tls.clone()), "x");
        assert_eq!(4_096, old.reply_cap());
        // ...nor an OpenAI-dialect endpoint, whose max_tokens bounds the answer alone.
        let oa = Agent::new(LlmClient::new("api.test.com", 443, "/v1/chat/completions", "key",
            "claude-opus-5", 4_096, tls), "x");
        assert_eq!(4_096, oa.reply_cap());
    }

    #[test]
    fn test_a_budget_blind_to_the_real_reply_refuses_its_way_down_the_window_00() {
        // `budget` subtracts the reply from the window to decide how big a prompt may be, so it
        // has to be given the figure the provider will be SENT. Handed `llm.max_tokens` it
        // reserved 5,120 for a reply that may run to 32,000. On the published 131,072 window the
        // fraction ceiling is the lower of the two and wins anyway, so nothing shows; on a window
        // learned from a refusal -- the mechanism that exists to recover from the first one -- the
        // prompt is legal by the app's arithmetic and refused by the provider, over and over.
        let window = 100_000;

        // Told the truth, the fold fits first time and the learned window is left alone.
        let fixed = thinking_agent(4_096);
        fixed.set_context_window(window);
        assert_eq!(32_000, fixed.reply_cap());
        assert_eq!(Some((0, 66_976)), recovery(&fixed, window, fixed.reply_cap()),
            "the budget must leave room for the reply the client asks for");
        assert_eq!(window, fixed.limits().window, "and must not have to learn anything");

        // Blind, it sends 80,000 against a 100,000 window with 32,000 of reply behind it, is
        // refused, and pays for the mistake twice: a wasted round trip, and a window permanently
        // taught to be 60,000 -- `learn_from_refusal` never revises upward, so every later fold in
        // this session is made against a model 40% smaller than the real one.
        let blind = thinking_agent(4_096);
        blind.set_context_window(window);
        assert_eq!(Some((1, 48_000)), recovery(&blind, window, blind.llm.max_tokens),
            "the old figure must cost a refusal it did not need to");
        assert_eq!(60_000, blind.limits().window, "and mis-teach the window for the rest of the run");
        // And the conversation pays: the fold that finally goes out is a third smaller than the
        // one the honest figure would have sent, on the same model, for no reason.
        assert!(48_000 < 66_976);
    }

    #[test]
    fn test_a_small_learned_window_recovers_in_one_refusal_rather_than_three_00() {
        // The case the fix is really for. At 40,000 the reply is most of the window, so a budget
        // that ignores it is wrong by a factor of eight and the grinding-down is visible: the
        // blind figure is refused three times and lands on a 2,366-token conversation, the honest
        // one is refused once and keeps two and a half times that.
        let honest = thinking_agent(4_096);
        honest.set_context_window(40_000);
        let (h_rounds, h_prompt) = recovery(&honest, 40_000, honest.reply_cap())
            .expect("the honest figure converges");

        let blind = thinking_agent(4_096);
        blind.set_context_window(40_000);
        let (b_rounds, b_prompt) = recovery(&blind, 40_000, blind.llm.max_tokens)
            .expect("the blind figure converges too, eventually");

        assert_eq!((1, 6_092), (h_rounds, h_prompt));
        assert_eq!((3, 2_366), (b_rounds, b_prompt));
        assert!(h_rounds < b_rounds, "the fix must cost fewer round trips");
        assert!(h_prompt > b_prompt, "and leave more of the conversation standing");
    }

    /// A dead-endpoint agent whose dialect and model are the ones the client raises the output cap
    /// for, so a fold's arithmetic is exercised under the figure that actually goes out.
    fn dead_thinking_agent() -> Agent {
        let tls = build_test_tls_config();
        let mut llm = LlmClient::new("127.0.0.1", 1, "/v1/messages", "key",
            "claude-opus-5", 4_096, tls);
        llm.retry.max_attempts = 1;
        Agent::new(llm, "You are Daimond.")
    }

    #[tokio::test]
    async fn test_whether_to_fold_is_decided_by_the_reply_that_will_be_sent_00() {
        // The two arithmetics above are only worth anything if the fold ASKS them, so this pins
        // the call site rather than the function. The window is 100,000; the honest budget is
        // 66,976 and the blind one 80,000, so a conversation sitting between the two folds under
        // the figure that will be sent and does not fold under the figure that was configured --
        // and not folding is a prompt the provider refuses.
        let a = dead_thinking_agent();
        a.set_context_window(100_000);
        let mut session = Session::new(fmt!("s1"), fmt!("long"), fmt!("claude-opus-5"));
        for i in 0..70 {
            session.messages.push(ChatMessage::user(fmt!("step {}", i)));
            session.messages.push(ChatMessage::Assistant {
                content: MessageContent::text("x".repeat(4_000)), tool_calls: Vec::new(),
            });
        }
        // The conversation is deliberately built into the gap, and the gap is asserted rather
        // than assumed: a change to the gauge or to `FOLD_AT` that closed it would otherwise make
        // this test pass while testing nothing.
        let tokens = a.gauge.tokens(compact::conversation_bytes(&session.messages));
        let honest = a.limits().budget(a.reply_cap());
        let blind  = a.limits().budget(a.llm.max_tokens);
        assert!(honest < tokens && tokens <= blind,
            "{} tokens is not between the honest budget {} and the blind one {}",
            tokens, honest, blind);

        let registry = no_tools();
        let mut events: Vec<AgentEvent> = Vec::new();
        let _ = a.run_turn(&mut session, fmt!("carry on"), &registry,
            &mut |ev| events.push(ev)).await;
        assert_eq!(1, events.iter().filter(|e| matches!(e, AgentEvent::Compacted { .. })).count(),
            "a conversation over the real budget was sent unfolded");
    }

    #[test]
    fn test_the_reserve_is_capped_at_half_the_window_and_that_is_not_this_files_call_00() {
        // Recorded rather than asserted away, because the fix here does not finish the job.
        // `Limits::budget` never gives the reply more than half the window, so wherever the window
        // is below twice the output cap the reserve is short however truthful the figure handed to
        // it: on 40,000 the reply may be 32,000 and at most 20,000 is set aside. What this file
        // owes is the true figure, and it now passes it; the clamp belongs to `compact.rs`, and a
        // build whose learned window falls under twice its cap wants a lower CAP, not a bigger
        // prompt.
        let a = thinking_agent(4_096);
        a.set_context_window(40_000);
        let honest = a.limits().budget(a.reply_cap());
        let blind  = a.limits().budget(a.llm.max_tokens);
        assert_eq!(32_000, blind, "blind, the fold fraction was left untouched");
        assert_eq!(18_976, honest, "honest, the clamped reserve of 20,000 is taken out");
        assert!(honest + 20_000 <= 40_000, "the clamped reserve must at least be honoured");
        assert!(honest + (a.reply_cap() as u64) > 40_000,
            "and the clamp still leaves a gap, which is compact.rs's to close");
    }

    #[test]
    fn test_the_budget_leaves_room_for_the_reply_00() {
        // `max_tokens` on the client is what the model may generate, and it is counted
        // against the same window. A budget blind to it is legal arithmetic and an illegal
        // request.
        let a = make_test_agent();
        a.set_context_window(8_192);
        let b = a.limits().budget(a.llm.max_tokens);
        assert!(b + (a.llm.max_tokens as u64) <= 8_192, "budget {} of 8192", b);
    }

    #[test]
fn test_agent_message_building() {
        let mut session = Session::new("s1".to_string(), "Test".to_string(), "model".to_string());
        session.messages.push(ChatMessage::user("Hello".to_string()));
        assert_eq!(session.messages.len(), 1);
        assert_eq!(session.messages[0].role(), "user");
        assert_eq!(session.messages[0].text(), "Hello");
    }
}
