//! Agent loop — the core Daimond agent that drives conversations.
//!
//! Receives a user message, sends it to the LLM with conversation
//! history, streams the response back to the client via events,
//! and stores the exchange in the session.

use oxedyne_fe2o3_core::prelude::*;

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use crate::llm::{Delta, LlmClient};
use crate::prompts::Role;
use crate::protocol::{AgentEvent, ChatMessage, Dropped, MessageContent, Session};
use crate::tools::ToolRegistry;

/// Folding a conversation that has outgrown the model's context window.
///
/// Declared here, from its own file, rather than beside the other modules in `lib.rs`:
/// compaction is part of running a turn and has no caller outside this one.
#[path = "compact.rs"]
pub mod compact;

/// Which of a round's tool calls may run at the same time.
///
/// Declared here for the same reason `compact` is: deciding what a round dispatches together is
/// part of running a turn, and nothing outside this module asks.
#[path = "batch.rs"]
pub mod batch;

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
    // How the last turn ended.  Shared on clone rather than copied, exactly as the
    // interjection queue is: the page holds a clone of the agent and has to be able to read
    // the ending of the turn it just watched, which a detached cell would not carry.  Written
    // once per turn, at the single exit in `Agent::ended`.
    ending:              Rc<RefCell<Option<TurnEnding>>>,
}


// ┌───────────────────────────────────────────────────────────────┐
// │ Why a fold is happening                                        │
// └───────────────────────────────────────────────────────────────┘

/// What brought a fold about, which decides two things a boolean could not keep apart.
///
/// The distinction matters because [`Limits::learn_from_refusal`] moves the window DOWN
/// and never up: it is the one occasion the provider speaks about its own size, and
/// believing it is what lets a chat against an unpublished model recover.  A fold the
/// user asked for carries no such news -- the prompt was never refused -- so taking it as
/// a refusal would shrink the window on every press of a button, and a user who folded
/// three times would end up with a quarter of the context they started with.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fold {
	/// Fold only if the estimate says the next prompt will not fit.
	IfNeeded,
	/// The provider refused this prompt, so fold whatever the estimate says -- and take
	/// the refusal as the truth about the window.
	Refused,
	/// The user pressed Fold.  Fold regardless of the estimate, and learn nothing about
	/// the window from it.
	ByHand,
}

impl Fold {
	/// Should the estimate be overridden and the conversation folded anyway?
	fn forces(self) -> bool {
		!matches!(self, Self::IfNeeded)
	}

	/// Does this fold carry news about how big the window really is?
	fn teaches_window(self) -> bool {
		matches!(self, Self::Refused)
	}
}


// ┌───────────────────────────────────────────────────────────────┐
// │ How a turn ended, and whether its claims stood up              │
// └───────────────────────────────────────────────────────────────┘

/// How a turn stopped running.
///
/// Three of these were already announced -- the output cap, the round limit and a turn that said
/// nothing -- and every other ending was silence.  A user watched a model say it would rewrite
/// lines 43 to 49, watched the spinner clear, and was left with "I have no visibility on what
/// occurred here": nothing had gone wrong, so nothing had been said.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TurnEnd {
	Answered,   // a reply with no tool call in it, which is how a turn is meant to end
	Stopped,    // the user cancelled while the reply was streaming
	Capped,     // the tool-round budget ran out with work still going
	Silent,     // the final message carried no text at all
	Failed,     // the provider or the transport ended the turn
}

impl TurnEnd {

	/// The word this ending travels as, on the wire and in a stored turn.
	///
	/// Spelled here and nowhere else, for the reason [`crate::tools::CallOutcome::wire`] gives:
	/// the browser knows these words and no others, so a second speller would not fail loudly,
	/// it would quietly draw an ending nobody recognises.
	pub fn wire(&self) -> &'static str {
		match self {
			Self::Answered	=> "answered",
			Self::Stopped	=> "stopped",
			Self::Capped	=> "capped",
			Self::Silent	=> "silent",
			Self::Failed	=> "failed",
		}
	}
}

/// What a turn came to, in figures the app measured rather than sentences the model wrote.
///
/// **Every field here is decidable from the tool log.**  Nothing in it is read out of the model's
/// prose, and nothing in it may be: this crate removed thirty-four prose sniffs on one night of
/// 2026-08 and `dev/CONTRACT_OUTCOME.md` exists because four consumers were guessing a tool's
/// outcome by reading its reply.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TurnEnding {
	pub how:		TurnEnd,
	pub offered:	usize,			// tools this turn was allowed to call
	pub rounds:		usize,			// requests it sent
	pub calls:		usize,			// tool calls it dispatched
	pub refused:	usize,			// ... of which a door turned away
	pub failed:		usize,			// ... of which broke
	// Paths a completed call said it had left on the store, and which are not there.
	pub missing:	Vec<String>,
}

impl TurnEnding {

	/// Is there anything here for a reader to act on?
	///
	/// **This is the line between a status and a warning, and the reason the app can afford to
	/// report every ending.**  A turn that did what it was asked answers `false` and is drawn as
	/// furniture; only a turn with a refusal, a breakage or a missing file answers `true`.  An app
	/// that appended a warning to every turn would teach its reader to skip the one that mattered,
	/// which is the failure this whole mechanism exists to prevent.
	pub fn unaccounted(&self) -> bool {
		self.refused > 0 || self.failed > 0 || !self.missing.is_empty()
	}
}

/// One dispatched tool call, as the audit sees it.
#[derive(Clone, Debug)]
struct Claim {
	outcome:	crate::tools::CallOutcome,
	opaque:		bool,										// see [`crate::tools::Tool::opaque`]
	paths:		Vec<(String, crate::tools::PathClaim)>,
}

/// The turn's tool log, and the findings that can be read out of it.
///
/// Built as the turn runs and audited once at the end.  It holds no prose and offers no way to
/// look at any: a reader of this type cannot accidentally start sniffing sentences.
#[derive(Clone, Debug, Default)]
struct Claims {
	calls: Vec<Claim>,
}

impl Claims {

	/// Record one dispatched call.
	///
	/// A call that was refused or that broke states nothing about the store, so its paths are not
	/// taken: a write the fence stopped is not a file anybody should be looking for.
	fn record(&mut self, name: &str, args: &str, outcome: crate::tools::CallOutcome) {
		let tool = crate::tools::Tool::from_name(name);
		let paths = match tool {
			Some(t) if outcome == crate::tools::CallOutcome::Done => t.path_claims(args),
			_ => Vec::new(),
		};
		// A refused shell ran nothing, so it cannot have moved a file.  Anything else that
		// reached a shell, a build or a worker did.
		let opaque = tool.map(|t| t.opaque()).unwrap_or(false)
			&& outcome != crate::tools::CallOutcome::Refused;
		self.calls.push(Claim { outcome, opaque, paths });
	}

	fn tally(&self, want: crate::tools::CallOutcome) -> usize {
		self.calls.iter().filter(|c| c.outcome == want).count()
	}

	/// Can a missing file be blamed on anybody?
	///
	/// False once the turn has run something whose reach is not in its arguments; see
	/// [`crate::tools::Tool::opaque`] for why that silences the check rather than qualifying it.
	fn accountable(&self) -> bool {
		!self.calls.iter().any(|c| c.opaque)
	}

	/// The paths this turn's completed calls say are on the store now.
	///
	/// Resolved in call order, so the turn's LAST word about a path is the turn's word about it: a
	/// file written and then deleted is claimed by nobody, and one deleted and then written back
	/// is claimed.  Without that, every scratch file a turn tidied up after itself would be
	/// reported as a write that did not happen.
	fn standing(&self) -> Vec<String> {
		let mut seen: Vec<(String, crate::tools::PathClaim)> = Vec::new();
		for call in &self.calls {
			for (path, claim) in &call.paths {
				match seen.iter_mut().find(|(p, _)| p == path) {
					Some(slot)	=> slot.1 = *claim,
					None		=> seen.push((path.clone(), *claim)),
				}
			}
		}
		seen.into_iter()
			.filter(|(_, c)| *c == crate::tools::PathClaim::Left)
			.map(|(p, _)| p)
			.collect()
	}
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
            ending:          Rc::new(RefCell::new(None)),
        }
    }

    /// How the last turn on this agent ended.
    ///
    /// `None` before any turn has run.  Read after `run_turn` returns -- including after it
    /// returns an error, which is the ending that used to be the least visible of all.
    pub fn ending(&self) -> Option<TurnEnding> {
        self.ending.borrow().clone()
    }

    /// Settle the turn's ending, and say it.
    ///
    /// **The one exit.**  Every path out of a turn comes through here, which is what makes the
    /// promise -- every turn says how it ended -- checkable rather than aspirational: a new exit
    /// that forgot to call this would leave `ending()` holding the turn before it, and the test
    /// that reads the ending after each kind of finish is what catches that.
    ///
    /// # Arguments
    /// * `ending` - What the turn came to; see [`TurnEnding`].
    fn ended(&self, ending: TurnEnding, on_event: &mut impl FnMut(AgentEvent)) {
        // THE ONE EXIT. Every path out of a turn comes through here, which is why the emit can
        // be one line and why no second exit can grow beside it -- an ending reported from two
        // places is an ending that can be reported from neither.
        on_event(AgentEvent::Ended {
            how:     ending.how.wire().to_string(),
            offered: ending.offered,
            rounds:  ending.rounds,
            calls:   ending.calls,
            refused: ending.refused,
            failed:  ending.failed,
            missing: ending.missing.clone(),
        });
        *self.ending.borrow_mut() = Some(ending);
    }

    /// Check the turn's claims against the store, and settle what it came to.
    ///
    /// The audit is two questions, and neither of them is asked of the model's prose:
    ///
    /// 1. **A refused call is not a completed step.**  The tool layer already decided this and
    ///    `AgentEvent::ToolResult` already carries it, so the count is a tally rather than a
    ///    reading.
    /// 2. **A file a completed call said it left is on the store.**  The claim is in the call's
    ///    ARGUMENTS, which name a path; whether that path is there afterwards is a fact.
    ///
    /// # Arguments
    /// * `how` - How the turn stopped running.
    /// * `rounds` - Requests the turn sent.
    /// * `claims` - The turn's tool log; empty on the pure-chat path.
    /// * `registry` - The tools this turn held, which is also what answers for the store.
    async fn audit(
        &self,
        how:        TurnEnd,
        rounds:     usize,
        claims:     &Claims,
        registry:   Option<&ToolRegistry>,
    )
        -> TurnEnding
    {
        let mut missing = Vec::new();
        if let Some(reg) = registry {
            if claims.accountable() {
                for path in claims.standing() {
                    if !reg.path_is_there(&path).await {
                        missing.push(path);
                    }
                }
            }
        }
        TurnEnding {
            how,
            offered: registry.map(|r| r.offered().len()).unwrap_or(0),
            rounds,
            calls:   claims.calls.len(),
            refused: claims.tally(crate::tools::CallOutcome::Refused),
            failed:  claims.tally(crate::tools::CallOutcome::Failed),
            missing,
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

    /// Set the fraction of the window at which this agent folds.
    ///
    /// Held inside [`compact::FOLD_AT_MIN`]..[`compact::FOLD_AT_MAX`] here rather than only in
    /// [`compact::Limits::budget`], so `Agent::limits` reports the figure that is actually in
    /// force -- a control that draws itself from the getter would otherwise show a number the
    /// arithmetic never used.  Zero, or anything below it, leaves the default alone, which is
    /// how a caller says "the user has not chosen".
    ///
    /// # Arguments
    /// * `f` - The fraction, between 0 and 1; zero or less is ignored.
    pub fn set_fold_at(&self, f: f64) {
        if f > 0.0 {
            self.limits.borrow_mut().fold_at = f.clamp(compact::FOLD_AT_MIN, compact::FOLD_AT_MAX);
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
        // The fold PROMPT travels with them, for the same reason and by the same argument.
        // It is not part of `Limits` because it is text rather than a figure, but it is the
        // same setting: what the folding model is told.  Without this line a Diamond's
        // daimon and its reducer folded on the user's chosen model -- `fold_model` rides in
        // `Limits` -- while ignoring the instructions the user wrote for it in
        // `prompts/compactor.md`, which is the half of the setting that is visible on disk.
        *self.fold_prompt.borrow_mut() = from.fold_prompt.borrow().clone();
    }

    /// Fold this conversation because the user asked, not because it had to be folded.
    ///
    /// The same path a turn takes when the estimate says the next prompt will not fit --
    /// there is deliberately no second folding routine -- but entered with [`Fold::ByHand`],
    /// so nothing is learned about the window from a prompt the provider never saw.
    ///
    /// Returns whether anything actually moved.  It can be false: a conversation of six
    /// messages or fewer has no tail to cut and no bulk to elide, and saying so is better
    /// than a spinner that ends with the meter where it was.
    ///
    /// # Arguments
    /// * `session` - The durable conversation, folded in place.
    /// * `on_event` - Where the fold is announced, exactly as an automatic one is.
    pub async fn fold_by_hand(
        &self,
        session:  &mut Session,
        on_event: &mut impl FnMut(AgentEvent),
    )
        -> bool
    {
        // The working list a turn would build: the system prompt, then the conversation.
        // Rebuilt here rather than borrowed because there is no turn in flight -- this is
        // the user at rest, between turns, pressing a button.
        let mut working = vec![ChatMessage::system(self.system_prompt.clone())];
        working.extend(session.messages.iter().cloned());
        self.fold_if_needed(session, &mut working, 0, Fold::ByHand, on_event).await
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

    /// The three pieces the system message is built from, in the order they are joined.
    ///
    /// **Read by the Wire view, and by nothing else that decides anything.** It exists so a person
    /// can see what is actually sent -- which of it is their own role prompt, which was appended
    /// after their edits, which is derived from the fence -- and the only way that view can be
    /// trusted is if it is composed by the same code the request is. So `run_turn` calls this and
    /// so does the getter; there is no second assembly to drift from the first.
    ///
    /// # Arguments
    /// * `registry` - The tools this turn holds, which decide the middle sentence.
    pub fn system_parts(&self, registry: &ToolRegistry) -> (String, String, String) {
        let tools = if registry.is_empty() {
            String::new()
        } else {
            fmt!(
                "You have exactly these tools, all scoped to the user's \
                 workspace: {}. Use them to inspect and change the workspace \
                 when completing a task. You have no other tools; never claim \
                 to have performed an action you had no tool to perform.",
                registry.tool_names().join(", "))
        };
        let brief = self.briefing.borrow().trim().to_string();
        (self.system_prompt.clone(), tools, brief)
    }


    pub async fn run_turn(
        &self,
        session:    &mut Session,
        user_msg:   String,
        registry:   &ToolRegistry,
        on_event:   &mut impl FnMut(AgentEvent),
    ) -> Outcome<()> {
        // THE TURN'S BYTE LEDGER STARTS HERE, and here is the only place it does. Every turn in
        // the app arrives through this function -- the browser chat, a Diamond's daimon, a
        // dispatched worker and `examples/devcycle_probe.rs` alike -- and a Diamond's daimon
        // SHARES its `read_seen` with the chat that made it, so an allowance reset anywhere else
        // would leak from one turn into the next. See `crate::tools::TurnState::spent`.
        registry.ctx.begin_turn();
        // Append the user message to the persisted history.
        session.messages.push(ChatMessage::user(user_msg));

        // Build the working conversation: system prompt + history.
        let mut working = Vec::with_capacity(session.messages.len() + 1);
        if !self.system_prompt.is_empty() {
            // ONE COMPOSER, read here and by the Wire view. The sentence naming the tools is
            // derived from the registry because a fixed one once promised a shell tool the
            // browser build has not got, so a capable model called it, failed, and reported the
            // failure as work done. The machine note goes LAST, so it sits closest to the
            // conversation and is the most recent thing the model read before the user's words.
            let (mut sys, tools, brief) = self.system_parts(registry);
            if !tools.is_empty() {
                sys.push_str("\n\n");
                sys.push_str(&tools);
            }
            if !brief.is_empty() {
                sys.push_str("\n\n");
                sys.push_str(&brief);
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
        let mut rounds = 0usize;
        loop {
            self.fold_if_needed(session, &mut working, 0, Fold::IfNeeded, on_event).await;
            let sent = compact::conversation_bytes(&working, &self.llm.open_folds());
            let mut full = String::new();
            rounds += 1;
            let result = self.llm.chat_stream(
                &working,
                &mut |d| match d {
                    Delta::Text(token) => {
                        full.push_str(token);
                        on_event(AgentEvent::Text(token.to_string()));
                    }
                    // THE WORKING GOES OUT WHILE IT IS STILL BEING DONE, which is the whole
                    // point of reading it: a reasoning model spends most of a round thinking,
                    // and a page that waits for the round to end shows a blank spinner for all
                    // of it. Its own event, never `Text`, so `full` -- which becomes the
                    // assistant's message -- cannot pick it up.
                    Delta::Reasoning(think) => on_event(AgentEvent::Thinking(think.to_string())),
                    // A pre-first-token retry: a caption, never part of `full`. No tool
                    // name to give (this is a plain request retry), so the name is empty
                    // and the UI reads "trying that again".
                    Delta::Roading { attempt, of, wait_ms } =>
                        on_event(AgentEvent::Roading { name: String::new(), attempt, of, wait_ms }),
                },
            ).await;
            match result {
                Ok(resp) => {
                    // The working is NOT emitted here. It went out delta by delta while the
                    // round was running (the `Delta::Reasoning` arm above), which is the only
                    // way it can do the job it is drawn for: a reasoning model spends most of
                    // a round thinking, and working delivered after the round is over arrives
                    // at the one moment it no longer explains the wait. `resp.thinking` still
                    // carries the whole of it for a caller that wants it in one piece.
                    let content = if resp.content.is_empty() { full } else { resp.content };
                    // A TURN MUST NEVER END IN SILENCE. Both empty means the provider
                    // returned a final message with nothing in it -- which happens on a
                    // reasoning model whose answer went entirely to a channel this app
                    // does not print, and happened to a user after the model had read
                    // five files and then appeared to do nothing at all. The spinner
                    // clears, the screen does not change, and there is no way to tell a
                    // finished turn from a hung one. Whatever the cause, saying so is
                    // strictly better than saying nothing.
                    let silent = content.trim().is_empty();
                    session.messages.push(ChatMessage::assistant(content));
                    if silent {
                        on_event(AgentEvent::Error(
                            "The model ended its turn without saying anything.".to_string()));
                        session.messages.push(compact::empty_turn_note());
                    }
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
                    // A pure chat holds no tools, so it can claim nothing about the store and
                    // its ending is the shape of the turn and nothing else.
                    let how = if silent { TurnEnd::Silent } else { TurnEnd::Answered };
                    let ending = self.audit(how, rounds, &Claims::default(), None).await;
                    self.ended(ending, on_event);
                    on_event(AgentEvent::Done);
                    return Ok(());
                }
                Err(e) => {
                    if !refolded && self.overflowed(&e, sent) {
                        refolded = true;
                        if self.fold_if_needed(session, &mut working, 0, Fold::Refused, on_event).await {
                            continue;
                        }
                    }
                    on_event(AgentEvent::Error(e.to_string()));
                    let ending = self.audit(TurnEnd::Failed, rounds, &Claims::default(), None).await;
                    self.ended(ending, on_event);
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
    /// Run one tool call, retrying it while the failure is the ROAD rather than an answer.
    ///
    /// **THE LADDER GUARDS THE CALL TO THE MODEL; THIS GUARDS THE CALLS THE MODEL MAKES.**  The
    /// provider retry in [`crate::llm::LlmClient::stream_turn`] has always survived a laptop
    /// waking or a phone coming back, and that was read as the problem being solved.  It was not.
    /// A `web_fetch` that dies because the page was frozen is handed back to the model AS A TOOL
    /// RESULT SAYING IT FAILED, and the model then does the reasonable thing with a failed tool:
    /// it apologises and answers around it.  The owner met that on a real iPhone on 2026-08-28 --
    /// "I can't get through to the web right now to look this up" -- and the sentence is now a
    /// permanent turn in the conversation.
    ///
    /// **`self.llm.retry`, not a schedule of its own.**  The same eight attempts, the same
    /// jittered backoff, the same total bound, and the same object -- so a test client's fast
    /// policy governs this ladder too and the suite does not grow two minutes per road failure.
    ///
    /// Only a READ is climbed: see [`crate::tools::Tool::road_retryable`].  Anything else fails
    /// on the first attempt, which still means the model is told nothing -- it simply means the
    /// turn ends sooner rather than after eight tries.
    ///
    /// # Arguments
    /// * `name` - The tool's wire name, as the model spelled it.
    /// * `args` - The raw argument object.
    async fn over_the_road(
        &self,
        registry: &ToolRegistry,
        name:     &str,
        args:     &str,
        on_event: &mut impl FnMut(AgentEvent),
    )
        -> Outcome<MessageContent>
    {
        let again = crate::tools::Tool::from_name(name)
            .map(|t| t.road_retryable())
            .unwrap_or(false);
        let mut waited  = 0u64;
        let mut retries = 0u32;
        loop {
            match registry.try_dispatch(name, args).await {
                Ok(c)  => return Ok(c),
                Err(e) => {
                    if !again {
                        return Err(e);
                    }
                    let delay = match self.llm.retry.next_delay(retries, waited, None) {
                        Some(d) => d,
                        None    => return Err(e),
                    };
                    waited  += delay;
                    retries += 1;
                    // SAID WHILE IT HAPPENS, and said by the APP. A tool call quietly retrying
                    // for up to two minutes looks exactly like a hung turn, which is the one
                    // thing a spinner cannot tell a user. It is a `Roading` event and not
                    // assistant text for the reason a fold is not assistant text: this is
                    // something Daimond is doing, the model neither said it nor will read it.
                    on_event(AgentEvent::Roading {
                        name:    name.to_string(),
                        attempt: retries + 1,
                        of:      self.llm.retry.max_attempts,
                        wait_ms: delay,
                    });
                    crate::llm::sleep_ms(delay).await;
                    // AND THEN WAIT FOR THE PAGE, which is the half a backoff cannot do. On iOS
                    // the page is frozen for as long as the user is in another app, so a ladder
                    // that only sleeps spends all eight attempts into a dead page and reports
                    // failure the moment the user comes back. Charged to the same budget, so
                    // being backgrounded cannot extend a turn without bound.
                    #[cfg(target_arch = "wasm32")]
                    {
                        waited += crate::wasm::await_restored(waited).await;
                    }
                }
            }
        }
    }

    /// The event that tells the page a call has started.
    ///
    /// The ID travels with it. A stored conversation's `say` fold is opened and closed on the
    /// page, and the page has to be able to name WHICH call it is talking about when it tells the
    /// engine what is open -- see `set_open_folds`. Nothing else reads it.
    ///
    /// One function because a batch announces its first call before it runs and the rest as their
    /// results are recorded, and two spellings of the same event would eventually differ.
    fn announce(tc: &crate::protocol::ToolCall) -> AgentEvent {
        AgentEvent::ToolCall {
            id:   tc.id.clone(),
            name: tc.name.clone(),
            args: tc.arguments.clone(),
        }
    }

    /// One tool call, from the model's arguments to a result the conversation can carry.
    ///
    /// # Arguments
    /// * `truncated` - Whether the reply these calls were parsed out of hit the output limit.
    async fn one_call(
        &self,
        registry:  &ToolRegistry,
        tc:        &crate::protocol::ToolCall,
        truncated: bool,
        on_event:  &mut impl FnMut(AgentEvent),
    )
        -> Outcome<MessageContent>
    {
        // A call cut at the output limit is not a call. Its arguments are a JSON object that
        // stops in the middle, and dispatching it yields a parse error -- which reads to the
        // model as its own mistake, so it writes the same thing again and is cut in the same
        // place. Told what actually happened, it splits the work instead.
        if cut_short(truncated, &tc.arguments) {
            // The cap that was SENT, not the one configured. The note says the number so the
            // model can size its next call by it, and telling a model its reply was cut at 4,096
            // when it was cut at 32,000 sends it splitting the work eight times finer than it
            // needs to.
            return Ok(MessageContent::text(truncated_call_note(self.reply_cap())));
        }
        self.over_the_road(registry, &tc.name, &tc.arguments, on_event).await
    }

    /// [`Self::one_call`] with its events put in a buffer instead of on the wire.
    ///
    /// The one thing a batch cannot share is the `&mut` event closure, so each call in a batch
    /// gets a `Vec` of its own and the round drains them in the model's order.  A method rather
    /// than a closure at the call site because the borrow of the sink has to outlive the future,
    /// which a closure built inside a `map` cannot arrange.
    async fn call_buffered(
        &self,
        registry:  &ToolRegistry,
        tc:        &crate::protocol::ToolCall,
        truncated: bool,
        sink:      &mut Vec<AgentEvent>,
    )
        -> Outcome<MessageContent>
    {
        let mut into = |e: AgentEvent| sink.push(e);
        self.one_call(registry, tc, truncated, &mut into).await
    }

    /// Leave a round whose tool call died on the road, with nothing false left behind.
    ///
    /// The assistant turn that asked for the tools is already in the session -- it has to be,
    /// because the API requires it to precede the replies -- and abandoning the round leaves its
    /// unanswered calls dangling.  A conversation in that state is rejected WHOLE by every
    /// provider, so it cannot simply be left.
    ///
    /// **[`crate::protocol::pair_up`], and deliberately not a rollback.**  Dropping the whole
    /// assistant turn would also discard the prose the model wrote before deciding to call the
    /// tool -- text the user has already read and already paid for, and exactly what
    /// `continueTurn` (www/js/daimond.js) works to preserve when a PROVIDER call dies.  A road
    /// failure during a tool call and a road failure during a provider call would then leave
    /// different things behind, which reads as a bug to whoever meets it.  `pair_up` keeps the
    /// prose and the answered calls and drops only the unanswered ones, which is what the
    /// restore path has always done to the same conversation coming back out of the store.
    ///
    /// **It is needed for the SITTING, not for the reload.**  Press Continue, or reload, and
    /// `restore_session` runs `pair_up` anyway.  Ignore the badge and simply type again, and the
    /// live session is the one holding the dangling call -- which is the case nothing else
    /// covers.
    ///
    /// # Arguments
    /// * `working` - This turn's own message list, repaired alongside the session's.
    fn abandon_round(
        &self,
        session: &mut Session,
        working: &mut Vec<ChatMessage>,
    ) {
        let msgs = std::mem::take(&mut session.messages);
        session.messages = crate::protocol::pair_up(msgs);
        let work = std::mem::take(working);
        *working = crate::protocol::pair_up(work);
    }

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
        // THE TURN'S TOOL LOG, and the only thing the audit reads. It carries an outcome and a
        // set of argument-named paths per call, and no prose at all -- so no reader of it can
        // slip back into working out what happened by reading what the model said about it.
        let mut claims = Claims::default();
        let mut rounds = 0usize;
        for _ in 0..max_rounds {
            rounds += 1;
            // Fold before the request rather than after the refusal. Checked every round,
            // because a single turn of fifty file reads can outgrow the window on its own,
            // without any earlier turn being large at all.
            self.fold_if_needed(session, &mut working, schema, Fold::IfNeeded, on_event).await;
            let mut sent = compact::conversation_bytes(&working, &self.llm.open_folds());

            // Stream this round's assistant text as it arrives; the tool
            // calls (if any) are returned assembled once the round ends.
            let mut refolded = false;
            // What this endpoint would take BEFORE the request goes out. Only a refusal can
            // change it and it changes it exactly once, so sampling either side of the round is
            // the whole of the learned signal -- no counter and no flag of our own.
            let could_see = self.llm.can_take_images();
            let resp = loop {
                match self.llm.chat_stream_tools(
                    &working,
                    tools_json.as_deref(),
                    &mut |d| match d {
                        Delta::Text(token)  => on_event(AgentEvent::Text(token.to_string())),
                        Delta::Reasoning(t) => on_event(AgentEvent::Thinking(t.to_string())),
                        // A pre-first-token retry, shown as a caption and never written
                        // to the transcript — see the note in the streaming loop above.
                        Delta::Roading { attempt, of, wait_ms } =>
                            on_event(AgentEvent::Roading { name: String::new(), attempt, of, wait_ms }),
                    },
                ).await {
                    Ok(r) => break r,
                    Err(e) => {
                        // The net under the proactive fold: a window nobody published, or
                        // an estimate that ran short. One retry, and only for a refusal
                        // that looks like the prompt being too long.
                        if !refolded && self.overflowed(&e, sent + schema) {
                            refolded = true;
                            if self.fold_if_needed(session, &mut working, schema, Fold::Refused, on_event).await {
                                sent = compact::conversation_bytes(&working, &self.llm.open_folds());
                                continue;
                            }
                        }
                        on_event(AgentEvent::Error(e.to_string()));
                        let ending = self.audit(
                            TurnEnd::Failed, rounds, &claims, Some(registry)).await;
                        self.ended(ending, on_event);
                        return Err(e);
                    }
                }
            };
            // The working is NOT emitted here either; see the note in `run_streaming`. It
            // streamed while the round ran, and a tool loop is where that matters most --
            // this is the path that runs many rounds, each of which may think for a minute
            // before it says a word.
            // The endpoint has just been caught refusing pictures, mid-turn, having taken
            // them a moment ago. Said out loud rather than left in the client: it is the one
            // moment the app knows it is on the wrong model, and `stream_turn` has already
            // stripped the pictures and answered anyway, so nothing downstream would ever
            // find out.
            if could_see && !self.llm.can_take_images() {
                let images: usize = working.iter().map(|m| m.content().images().count()).sum();
                on_event(AgentEvent::Unseeable { images, model: self.llm.model.clone() });
            }
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
                    content: MessageContent::text(crate::llm::seamed(resp.content)),
                    tool_calls: Vec::new(),
                });
                let ending = self.audit(TurnEnd::Stopped, rounds, &claims, Some(registry)).await;
                self.ended(ending, on_event);
                on_event(AgentEvent::Done);
                return Ok(());
            }

            if resp.tool_calls.is_empty() {
                // Final answer — its text has already streamed via the
                // token callback, so it is not re-emitted here.
                //
                // A final message with nothing in it is the ending the user met: the spinner
                // clears, the screen does not change, and a finished turn is indistinguishable
                // from a hung one. The streaming path has said so since it was found; here the
                // ending names it, which costs nothing and is the same fact.
                let how = if resp.content.trim().is_empty() {
                    TurnEnd::Silent
                } else {
                    TurnEnd::Answered
                };
                // THE SEAM, and only here. A run of prose with a tool call after it is
                // working rather than an answer -- `demoteToWorking` in the page draws it as
                // the model's own thinking -- so a `Fold:` line in one of those would build a
                // control over something nobody is meant to read as a reply.
                session.messages.push(ChatMessage::Assistant {
                    content: MessageContent::text(crate::llm::seamed(resp.content)),
                    tool_calls: Vec::new(),
                });
                let ending = self.audit(how, rounds, &claims, Some(registry)).await;
                self.ended(ending, on_event);
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

            // Whether this round put a question to the user, which is what ends the turn.  Set
            // from the tool RESULT and not from the call, because a question can be refused --
            // see [`ends_turn`], and see what happened the last time a rule like this read a
            // name alone.
            let mut asked = false;

            // Execute the round's tool calls, recording every result in both places for the
            // same reason.  WHAT MAY RUN TOGETHER, AND WHY SO LITTLE MAY, IS `batch`'s RULE --
            // read it there rather than inferring it from here.  Everything this loop does with
            // a result it does in the model's own order, whatever ran together underneath.
            let names: Vec<&str> = resp.tool_calls.iter().map(|t| t.name.as_str()).collect();
            for span in batch::batches(&names) {
                let group = &resp.tool_calls[span];
                // THE EVENTS STAY STRICTLY ALTERNATING: one `ToolCall`, then its `ToolResult`,
                // then the next.  `www/js/daimond.js` keeps ONE `pendingTool` and ONE
                // `pendingCallId` -- in the chat, in the worker dock and in the daimon alike --
                // and files a result against whichever call was announced last.  Announce two
                // calls back to back and the first result is filed under the second call while
                // every result after it is dropped, in the transcript and in the write-ahead
                // journal both.  So a batch is invisible on the wire and shows only as the round
                // being quicker.
                //
                // The FIRST call is announced BEFORE the batch runs rather than after, so
                // "Running <tool>, step n…" names something that is actually running for as long
                // as the batch is in flight, exactly as it does for a batch of one.
                on_event(Self::announce(&group[0]));
                // A sink per call while a batch runs, drained into `on_event` in the model's
                // order as each result is recorded.  Empty for a batch of one, which keeps its
                // events live.  Today it is provably empty for a batch of several as well --
                // only `over_the_road` writes to it, and nothing in `batch::may_run_beside` is
                // `road_retryable` -- but a tool that later becomes both would otherwise have its
                // caption emitted from inside a concurrent poll, against a `&mut` closure that
                // cannot be shared.
                let mut sinks: Vec<Vec<AgentEvent>> = Vec::new();
                let outs: Vec<Outcome<MessageContent>> = if group.len() == 1 {
                    vec![self.one_call(registry, &group[0], resp.truncated, on_event).await]
                } else {
                    sinks = group.iter().map(|_| Vec::new()).collect();
                    let futs: Vec<_> = group.iter().zip(sinks.iter_mut())
                        .map(|(tc, sink)| self.call_buffered(registry, tc, resp.truncated, sink))
                        .collect();
                    batch::all_of(futs).await
                };
                for (n, (tc, out)) in group.iter().zip(outs).enumerate() {
                    // Announced here for every call after the first, whose announcement went out
                    // before the batch started.
                    if n > 0 {
                        on_event(Self::announce(tc));
                    }
                    if let Some(sink) = sinks.get_mut(n) {
                        for e in std::mem::take(sink) {
                            on_event(e);
                        }
                    }
                    let result = match out {
                        Ok(c) => c,
                        // THE ROAD IS SPENT, SO THE TURN IS OVER, and the model is told nothing.
                        //
                        // This is the whole point of the exercise. Handing the model an
                        // exhausted ladder produces the same apology the first failure would
                        // have produced, ninety seconds later and for more money -- and that
                        // apology is a durable assistant turn, re-sent on every turn after it.
                        // So nothing is written for it to read. The app says what happened
                        // instead, in its own voice, and offers the turn back.
                        //
                        // `Error` then `Err`, in that order, because that is the pair the page
                        // is already built around: `runTurn`'s error handler recognises a road
                        // failure and declines to write a line for it, and its catch classifies
                        // the same failure a second time and hands the turn back badged with a
                        // Continue. Both live in www/js/daimond.js and neither needed changing.
                        //
                        // A SIBLING THAT RAN BESIDE THIS ONE AND SUCCEEDED IS DROPPED WITH IT,
                        // and that is deliberate: serially it would never have run at all, so
                        // keeping its result would put something in the conversation that
                        // today's behaviour does not. The calls BEFORE it in the model's order
                        // are already recorded, exactly as they are serially, and `abandon_round`
                        // pairs off what is left.
                        Err(e) => {
                            self.abandon_round(session, &mut working);
                            on_event(AgentEvent::Error(e.plain()));
                            let ending = self.audit(
                                TurnEnd::Failed, rounds, &claims, Some(registry)).await;
                            self.ended(ending, on_event);
                            return Err(e);
                        }
                    };
                    // The event carries the TEXT of the result and not the image. Everything
                    // downstream of it -- the panel, the journal's write-ahead log, the
                    // transcript on screen -- renders a string, and an image inside that string
                    // would be a base64 wall in a tile. The image travels in the message instead,
                    // where the model is the only reader of it.
                    //
                    // WHAT THE CALL CAME TO IS DECIDED HERE, ONCE. This is the only place the
                    // event is built, so it is the only place the outcome is set; every reader
                    // downstream asks rather than re-reading the prose. Four readers used to
                    // guess it back out of the text, and one of them did not know that a refusal
                    // opens "Refused" rather than "Error" -- so a write the fence had just
                    // stopped was drawn as a completed step.
                    let text    = result.as_text().into_owned();
                    let outcome = crate::tools::call_outcome(&text);
                    // AND THE AUDIT IS KEPT FROM THE SAME VERDICT, not from a second reading of
                    // it. The paths come from the ARGUMENTS the model sent, which name the file
                    // it meant whatever the reply says about it.
                    claims.record(&tc.name, &tc.arguments, outcome);
                    // ASKED OF THE RESULT, and of every call in the round rather than of the
                    // first: a round may carry several, and the question may not be the one that
                    // came back first.
                    asked |= ends_turn(&tc.name, outcome);
                    on_event(AgentEvent::ToolResult {
                        name:   tc.name.clone(),
                        result: text,
                        outcome,
                    });
                    // A PICTURE FOR A MODEL THAT WILL NOT TAKE ONE NEVER ENTERS THE SESSION.
                    //
                    // `sighted()` takes it out of every request anyway, so the model sees the
                    // same words either way -- but stored, the picture is folded around,
                    // reloaded, and re-stripped for the life of the conversation. That is what
                    // bricked a real Diamond on 2026-08-13. Left out here it costs one elision
                    // that names the file, and the act is announced once instead of being
                    // invisible.
                    let result = if result.has_image() && !self.llm.can_take_images() {
                        on_event(AgentEvent::Unseeable {
                            images: result.images().count(),
                            model:  self.llm.model.clone(),
                        });
                        result.without_images(Dropped::Unseeable)
                    } else {
                        result
                    };
                    let reply = ChatMessage::tool(tc.id.clone(), result);
                    working.push(reply.clone());
                    session.messages.push(reply);
                }
            }

            // A QUESTION IS THE ANSWER, so the turn is over.  The model has just put a decision
            // on the user's screen and cannot say anything useful until it is answered: going
            // round again would buy a whole extra request whose only possible content is a
            // paragraph restating the question, printed under a card that already asks it.
            //
            // **The turn ending is what makes an unanswered question free.**  Nothing is held --
            // no promise, no engine, no slot -- so a question nobody answers for an hour costs
            // exactly what a question nobody answers for a second does, and there is no timeout
            // to invent because there is nothing to time out.  That is the difference between
            // this and `parkConsent`, which holds a worker on a `resolve` in memory and loses it
            // to a reload.
            //
            // Ended as `Answered` rather than under an ending of its own: this is a reply with
            // nothing further to say, which is what that word means, and a sixth `TurnEnd` would
            // be a word every locale and every reader of the ledger had to learn to draw a
            // distinction nothing acts on.
            if asked {
                let ending = self.audit(TurnEnd::Answered, rounds, &claims, Some(registry)).await;
                self.ended(ending, on_event);
                on_event(AgentEvent::Done);
                return Ok(());
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
        let ending = self.audit(TurnEnd::Capped, rounds, &claims, Some(registry)).await;
        self.ended(ending, on_event);
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
    /// * `why` - What brought the fold about; see [`Fold`].
    /// * `on_event` - Where the user is told, since a silent fold is the one people hate.
    async fn fold_if_needed(
        &self,
        session:    &mut Session,
        working:    &mut Vec<ChatMessage>,
        schema:     u64,
        why:        Fold,
        on_event:   &mut impl FnMut(AgentEvent),
    )
        -> bool
    {
        // THE FOLDS THE USER HAS OPEN, taken once for the whole fold. Every size below is a
        // size on the wire, and a closed fold's detail is not on the wire: `msg_bytes` asks the
        // serialiser's own `sent_args_len` what a `say` costs, and that answer depends on this
        // set. A copy rather than a borrow, because the page may set the folds again while the
        // summarising call is in flight and a live borrow at that moment would panic.
        let open = self.llm.open_folds();

        // A refusal is the only occasion the provider ever says anything about the size of
        // its window. Believing it is what lets a chat against a model nobody published a
        // window for recover instead of folding to a budget that was never the real one --
        // and it is why a fold the USER asked for must not come through here, since that
        // one carries no news at all.
        if why.teaches_window() {
            let refused = self.gauge.tokens(compact::conversation_bytes(working, &open) + schema);
            self.limits.borrow_mut().learn_from_refusal(refused);
        }
        let (budget, tail, model) = {
            let l = self.limits.borrow();
            let cap = self.reply_cap();
            (l.budget(cap), l.tail_budget(cap), l.fold_model.clone())
        };
        let before = compact::conversation_bytes(&session.messages, &open);
        if !why.forces()
            && self.gauge.tokens(compact::conversation_bytes(working, &open) + schema) <= budget
        {
            return false;
        }

        let mut folded  = 0usize;
        let mut trouble = String::new();
        // The hard ceiling is the budget itself: however few messages that leaves, a tail
        // bigger than what may be sent is a fold that changed nothing.
        let ceiling = self.gauge.bytes(budget).saturating_sub(schema);
        let cut = compact::tail_start(&session.messages, self.gauge.bytes(tail).min(ceiling),
            compact::MIN_KEEP_MESSAGES, ceiling, &open);
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
                    if compact::conversation_bytes(&new, &open) < before {
                        session.messages = new;
                        folded = cut;
                    }
                },
                // Refused rather than allowed to orphan a tool call. Eliding below still
                // shrinks the same conversation, and cannot orphan anything at all.
                Err(e) => trouble = fmt!("{}", e),
            }
        }

        // SHORTENED ON THE WAY OUT, AND NOWHERE ELSE. This edited `session.messages` until
        // 2026-08-28, and that list is the one `crate::wasm::app::DaimondApp::export_session`
        // hands the browser to store, to back up and to put in the sync parcel -- so a
        // thousand-word answer became four hundred characters in the user's own record,
        // permanently, with nothing said and no way back. A model's window is a property of the
        // REQUEST; a lossy form of the conversation is therefore the request's and is built here,
        // from a record that stays whole. The owner's ruling: the model gets the shortened
        // version, his transcript keeps every word.
        //
        // Two passes, and the second is what makes the guarantee hold: the first leaves the
        // newest messages alone, and if the conversation is STILL too big it is because those
        // are the bulky ones, so the second reaches them too. The user's own words are never
        // touched by either.
        //
        // IT ALSO SETTLES WHAT THE FOLD READS. `render_for_fold` above summarises
        // `session.messages`, and while the elision edited that list a later fold summarised
        // whatever an earlier elision had left of it -- a summary of four-hundred-character
        // stubs, which is a second silent loss standing behind the first. Nothing clips that
        // list now, so there is no arrangement of turns in which it can happen.
        let mut sent = session.messages.clone();
        let mut elided = compact::elide_bulk(&mut sent, ceiling,
            compact::MIN_KEEP_MESSAGES, &open);
        elided += compact::elide_bulk(&mut sent, ceiling, 1, &open);
        let changed = folded > 0 || elided > 0;
        if !changed {
            // And `working` is left exactly as it was, elisions and all. Rebuilding it from the
            // session on the way out of a fold that changed nothing would throw away an earlier
            // round's shortening and hand the caller a request over the budget again.
            return false;
        }
        // Measured on what will be SENT, since that is what the sentence below is about.
        let after = compact::conversation_bytes(&sent, &open);

        // Rebuild the turn's list: the system prompt this turn was built with, then the
        // conversation as it now stands, shortened to fit. The two are kept in lockstep for
        // the whole turn, so anything else would leave the model reading a history the session
        // no longer holds.
        let sys = match working.first() {
            Some(m @ ChatMessage::System { .. }) => Some(m.clone()),
            _ => None,
        };
        working.clear();
        if let Some(s) = sys { working.push(s); }
        working.extend(sent);

        // Told, not done quietly. A fold is lossy, and a user who is not shown one has no
        // way to tell a model that forgot from a model that never knew.
        //
        // "TOOL RESULTS" WAS NOT TRUE. `compact::elide_bulk` shrinks a long ASSISTANT turn on
        // exactly the same rule it shrinks a tool reply on, and a pure chat has no tool replies
        // at all -- so a user whose own answers had just been clipped to 400 characters was told
        // the app had shortened some tool output. That is the fold telling them the one thing
        // they would not go looking for.
        //
        // AND IT SAYS WHERE THE SHORTENING APPLIES, which is four words and the whole of the
        // second half of the ruling. The sentence was true of a record that no longer changes:
        // a reader who is told his answers were shortened, and is looking at them in full on
        // the screen above, has been handed a contradiction to resolve on his own.
        //
        // AND IT NAMES ONLY WHAT HAPPENED. One sentence covered both mechanisms and reported the
        // one that did not fire as a zero, so a conversation that was merely shortened opened
        // with "Folded 0 earlier messages and", under a heading that had just said the opposite.
        // A count of nothing is not information; it is a reader working out which half to ignore.
        let did = match (folded, elided) {
            (0, n) => fmt!("Shortened {} long tool results and answers on the way to the model",
                n),
            (f, 0) => fmt!("Folded {} earlier messages", f),
            (f, n) => fmt!("Folded {} earlier messages and shortened {} long tool results and \
                answers on the way to the model", f, n),
        };
        let mut said = fmt!("{}: {} tokens of conversation became about {}.",
            did, self.gauge.tokens(before), self.gauge.tokens(after));
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
// │ The tool that ends a turn                                      │
// └───────────────────────────────────────────────────────────────┘

/// Whether this tool result is the turn's answer, so the loop stops here.
///
/// **The rule is back and the tool under it is not the old one.**  It used to say `say`, which
/// folded a reply for the reader -- one-way presentation that a model could simply decline, and
/// that is now a convention in the model's own prose with no tool to call.  `ask` is the opposite
/// shape: a round trip, whose whole point is that the model has stopped and is waiting.  Prose
/// cannot return a tap, so there is no convention that could replace it.
///
/// **It reads the OUTCOME and never the name alone**, and that clause is the scar.  A refused
/// `say` ended a worker's turn, so the report the refusal had just told it to write was never
/// written and the whole errand came back as whatever prose accompanied the call -- work done,
/// paid for and thrown away.  `ask` has as many ways to be refused as `say` had, each of them
/// telling the model to put the question properly, and every one of those is advice the model
/// must be given a round to take.  [`crate::tools::call_outcome`] is the tool layer's own
/// statement of what became of a call; nothing here reads the wording again.
///
/// # Arguments
/// * `name` - The tool the call named.
/// * `outcome` - What the layer said became of it.
fn ends_turn(name: &str, outcome: crate::tools::CallOutcome) -> bool {
	name == crate::tools::Tool::Ask.name()
		&& matches!(outcome, crate::tools::CallOutcome::Done)
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
    use crate::tools::CallOutcome;

    use oxedyne_fe2o3_jdat::prelude::*;

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

    #[test]
    fn test_a_derived_agent_folds_by_the_instructions_the_user_wrote_00() {
        // `fold_model` rides in `Limits` and so was adopted already; the fold PROMPT is
        // text and did not, so a Diamond's daimon folded on the user's chosen model
        // while ignoring what they had written for it in `prompts/compactor.md` -- the
        // half of the setting that is visible on disk, and so the half whose absence
        // looks like the file not being read at all.
        let chat = make_test_agent();
        chat.set_fold_prompt("Keep only the file names.");
        let derived = Agent::new(chat.llm.clone(), "daimon");
        assert_eq!(derived.fold_prompt(), compact_role_default(),
            "a fresh agent starts on the shipped prompt");
        derived.adopt_limits(&chat);
        assert_eq!(derived.fold_prompt(), "Keep only the file names.");
        // One way, like the figures: a worker must not rewrite the chat's.
        derived.set_fold_prompt("something else");
        assert_eq!(chat.fold_prompt(), "Keep only the file names.",
            "the chat's fold prompt moved under it");
    }

    // ── Why a fold is happening ─────────────────────────────────────────

    #[test]
    fn test_only_a_providers_refusal_teaches_the_window_00() {
        // The distinction the `Fold` enum exists for. `learn_from_refusal` moves the
        // window DOWN and never up, so routing a user's button press through the same
        // arm as a refusal would shrink the window on every press: fold three times and
        // a third of the context is gone, with nothing on screen to say why.
        assert!(Fold::Refused.teaches_window());
        assert!(!Fold::ByHand.teaches_window(), "a hand fold shrinks the window");
        assert!(!Fold::IfNeeded.teaches_window());
        // Both of the other two override the estimate; only `IfNeeded` consults it.
        assert!(Fold::Refused.forces());
        assert!(Fold::ByHand.forces(), "a hand fold that consults the estimate is a no-op");
        assert!(!Fold::IfNeeded.forces());
    }

    #[tokio::test]
    async fn test_a_hand_fold_leaves_the_window_where_it_was_00() {
        // The property stated as the user would see it, rather than as the enum states
        // it: press Fold on a chat that is nowhere near full, and the window it is
        // measured against must be the one it had a moment ago.
        let a = make_test_agent();
        a.set_context_window(32_768);
        let mut s = Session::new("s".into(), "u".into(), "m".into());
        for i in 0..12 {
            s.messages.push(ChatMessage::user(fmt!("message {}", i)));
        }
        let mut seen = Vec::new();
        let mut sink = |ev: AgentEvent| seen.push(ev);
        let _ = a.fold_by_hand(&mut s, &mut sink).await;
        assert_eq!(a.limits().window, 32_768,
            "the user's own fold was read as a provider refusal");
    }

    #[tokio::test]
    async fn test_a_hand_fold_of_a_short_conversation_says_nothing_moved_00() {
        // `false` rather than a fold that changed nothing. Below `MIN_KEEP_MESSAGES`
        // there is no tail to cut and no bulky tool result to shorten, and the honest
        // answer is that this conversation cannot be made smaller -- not a spinner that
        // ends with the meter exactly where it started.
        let a = make_test_agent();
        a.set_context_window(32_768);
        let mut s = Session::new("s".into(), "u".into(), "m".into());
        s.messages.push(ChatMessage::user("hello"));
        let mut sink = |_ev: AgentEvent| {};
        let moved = a.fold_by_hand(&mut s, &mut sink).await;
        assert!(!moved, "a two-message conversation reported a fold");
        assert_eq!(s.messages.len(), 1, "the one message was folded away");
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
            daimon_of:   String::new(),
        })
    }

    /// A registry holding one tool, so a turn takes the agentic path.
    fn one_tool() -> crate::tools::ToolRegistry {
        let mut r = no_tools();
        r.tools = vec![crate::tools::Tool::FileWrite];
        r
    }

    // ── A picture in front of a model that will not take one ────────────

    /// The one-pixel PNG whose base64 `src/llm.rs` documents.
    ///
    /// The same bytes, so a test asserting the picture did NOT travel is naming a string a
    /// provider published rather than one this file invented.
    const COVER_PNG_B64: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nG\
                                 P4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

    /// A registry holding `file_read` over a scratch workspace with `cover.png` in it.
    fn image_tools() -> crate::tools::ToolRegistry {
        let dir = match oxedyne_fe2o3_test::scratch::scratch_dir("daimond_agent_vision") {
            Ok(d)  => d,
            Err(e) => panic!("a scratch directory: {}", e),
        };
        let png = match oxedyne_fe2o3_text::base64::decode(COVER_PNG_B64) {
            Ok(b)  => b,
            Err(e) => panic!("the documented base64 must decode: {}", e),
        };
        if let Err(e) = std::fs::write(dir.join("cover.png"), &png) {
            panic!("the fixture picture could not be written: {}", e);
        }
        let ws = match crate::workspace::Workspace::new(dir) {
            Ok(w)  => w,
            Err(e) => panic!("a scratch workspace: {}", e),
        };
        crate::tools::ToolRegistry::new(vec![crate::tools::Tool::FileRead],
            crate::tools::ToolContext {
                workspace:   ws,
                executor:    crate::executor::Executor::local_default(),
                cwd:         String::new(),
                path_prefix: String::new(),
                root:        crate::tools::FileRoot::Workspace,
                read_seen:   crate::tools::new_read_cache(),
                no_write:    Vec::new(),
                daimon_of:   String::new(),
            })
    }

    /// One streamed round that asks to LOOK at the fixture picture.
    fn asks_to_look() -> crate::llm::tests::Reply {
        crate::llm::tests::Reply::Sse {
            chunks: vec![
                "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"c1\",\
                    \"type\":\"function\",\"function\":{\"name\":\"file_read\",\"arguments\":\
                    \"{\\\"path\\\":\\\"cover.png\\\",\\\"as\\\":\\\"image\\\"}\"}}]}}]}\n\n"
                    .to_string(),
                "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}],\
                    \"usage\":{\"prompt_tokens\":10,\"completion_tokens\":5}}\n\n".to_string(),
                "data: [DONE]\n\n".to_string(),
            ],
            reset_after: None,
        }
    }

    /// A plain streamed answer, ending the turn.
    fn plain_answer() -> crate::llm::tests::Reply {
        crate::llm::tests::Reply::Sse {
            chunks: vec![
                "data: {\"choices\":[{\"delta\":{\"content\":\"Done\"}}]}\n\n".to_string(),
                "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":11,\"completion_tokens\":2}}\n\n"
                    .to_string(),
                "data: [DONE]\n\n".to_string(),
            ],
            reset_after: None,
        }
    }

    /// A refusal that says nothing about images, which is what a real one often does.
    fn refuses() -> crate::llm::tests::Reply {
        crate::llm::tests::Reply::Http {
            status: 404, reason: "Not Found", headers: Vec::new(),
            body: "{\"error\":{\"message\":\"No endpoint found\"}}".to_string(),
        }
    }

    /// Every `Unseeable` in a run, as `(images, model)`.
    fn unseeable(events: &[AgentEvent]) -> Vec<(usize, String)> {
        events.iter().filter_map(|e| match e {
            AgentEvent::Unseeable { images, model } => Some((*images, model.clone())),
            _ => None,
        }).collect()
    }

    #[tokio::test]
    async fn test_a_picture_for_a_model_known_blind_is_announced_and_left_out_00() {
        // The DECLARED half: `model_can_see` refuses this family before any request, so the
        // picture is taken out of the tool reply and never reaches the session at all. What it
        // leaves behind names the file, so the same read on a sighted endpoint still works.
        let (port, _seen) = crate::llm::tests::start_stub(vec![
            asks_to_look(),
            plain_answer(),
        ]).await;
        let mut llm = crate::llm::tests::stub_client(port);
        llm.model = fmt!("openai/gpt-3.5-turbo-0125");
        let a = Agent::new(llm, "You are Daimond.");
        let registry = image_tools();
        let mut session = Session::new(fmt!("s"), fmt!("look"), fmt!("openai/gpt-3.5-turbo-0125"));
        let mut events: Vec<AgentEvent> = Vec::new();
        let _ = a.run_turn(&mut session, fmt!("what is on the cover"), &registry,
            &mut |ev| events.push(ev)).await;

        let said = unseeable(&events);
        assert_eq!(said.len(), 1, "the picture was left out and nothing said so: {:?}", events);
        assert_eq!(said[0].0, 1, "the count of pictures left out is wrong");
        assert!(said[0].1.contains("gpt-3.5"), "the model was not named: {}", said[0].1);

        let tool_text = session.messages.iter()
            .filter(|m| m.role() == "tool")
            .map(|m| m.text())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(!tool_text.is_empty(), "the tool reply never reached the session");
        assert!(!tool_text.contains(COVER_PNG_B64), "the bytes went into the session anyway");
        assert!(tool_text.contains("cannot be shown"),
            "the elision does not say why: {}", tool_text);
        assert!(tool_text.contains("cover.png"), "the file is not named in its place");
        assert!(!session.messages.iter().any(|m| m.content().has_image()),
            "an image survived into the stored conversation");
    }

    #[tokio::test]
    async fn test_a_model_learned_blind_mid_turn_is_announced_once_00() {
        // The LEARNED half: nothing declares this model blind, so the picture goes out, the
        // endpoint refuses it, and `stream_turn` strips and retries. That retry is the only
        // moment the app knows it is on the wrong model, and it used to pass in silence.
        let (port, _seen) = crate::llm::tests::start_stub(vec![
            asks_to_look(),
            refuses(),
            plain_answer(),
        ]).await;
        let a = Agent::new(crate::llm::tests::stub_client(port), "You are Daimond.");
        let registry = image_tools();
        let mut session = Session::new(fmt!("s"), fmt!("look"), fmt!("anthropic/claude-opus-5"));
        let mut events: Vec<AgentEvent> = Vec::new();
        let _ = a.run_turn(&mut session, fmt!("what is on the cover"), &registry,
            &mut |ev| events.push(ev)).await;

        let said = unseeable(&events);
        assert_eq!(said.len(), 1,
            "a refusal learned mid-turn was announced {} time(s): {:?}", said.len(), events);
        assert!(said[0].1.contains("claude-opus-5"), "the model was not named: {}", said[0].1);
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

    // ── What a tool call came to travels with the event ─────────────────

    /// Three real calls in one round: one that works, one the fence stops, one that is not there.
    ///
    /// Written as a script for the stub provider rather than as three hand-built strings, because
    /// a fixture that states the reply AND the expected reading agrees with itself whatever the
    /// tool layer does.  What is under test is that the app carries the tool layer's own verdict,
    /// so the verdict has to come from the tool layer.
    fn three_calls() -> crate::llm::tests::Reply {
        crate::llm::tests::Reply::Sse {
            chunks: vec![
                // Works: a relative path inside the scratch workspace.
                "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"c0\",\
                    \"type\":\"function\",\"function\":{\"name\":\"file_write\",\"arguments\":\
                    \"{\\\"path\\\":\\\"notes/ok.txt\\\",\\\"content\\\":\\\"hi\\\"}\"}}]}}]}\n\n"
                    .to_string(),
                // Refused: an absolute path on the machine, which `guard` stops before any write.
                "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":1,\"id\":\"c1\",\
                    \"type\":\"function\",\"function\":{\"name\":\"file_write\",\"arguments\":\
                    \"{\\\"path\\\":\\\"/etc/passwd\\\",\\\"content\\\":\\\"x\\\"}\"}}]}}]}\n\n"
                    .to_string(),
                // Failed: a real tool, not registered here, so `dispatch` composes an error line.
                "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":2,\"id\":\"c2\",\
                    \"type\":\"function\",\"function\":{\"name\":\"spawn_agent\",\"arguments\":\
                    \"{}\"}}]}}]}\n\n".to_string(),
                "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n"
                    .to_string(),
                "data: [DONE]\n\n".to_string(),
            ],
            reset_after: None,
        }
    }

    /// Every `ToolResult` in a run, as `(name, outcome, text)`.
    fn tool_results(events: &[AgentEvent]) -> Vec<(String, CallOutcome, String)> {
        events.iter().filter_map(|e| match e {
            AgentEvent::ToolResult { name, result, outcome } =>
                Some((name.clone(), *outcome, result.clone())),
            _ => None,
        }).collect()
    }

    #[tokio::test]
    async fn test_a_tool_result_carries_what_the_call_came_to_00() {
        // The app used to flatten the tool layer's verdict into the reply's opening word and let
        // four browser consumers read it back out of the prose, each with its own reading. One of
        // them tested for "Error" alone -- so a refusal, which opens "Refused", was drawn as a
        // completed step, journalled as a success and reported to the Optimiser as a tool that
        // worked.
        let (port, _seen) = crate::llm::tests::start_stub(vec![
            three_calls(),
            plain_answer(),
        ]).await;
        let mut llm = crate::llm::tests::stub_client(port);
        llm.retry.max_attempts = 1;
        let a = Agent::new(llm, "You are Daimond.");
        a.set_max_rounds(2);

        let registry = one_tool();
        let mut session = Session::new(fmt!("s1"), fmt!("three"), fmt!("model"));
        let mut events: Vec<AgentEvent> = Vec::new();
        let _ = a.run_turn(&mut session, fmt!("do three things"), &registry,
            &mut |ev| events.push(ev)).await;

        let got = tool_results(&events);
        assert_eq!(3, got.len(), "three calls went out and {} results came back: {:?}",
            got.len(), events.iter().map(|e| fmt!("{:?}", e)).collect::<Vec<_>>());

        // Each verdict is the tool layer's, on a reply the tool layer actually composed.
        assert_eq!(CallOutcome::Done, got[0].1, "a write inside the workspace: {}", got[0].2);
        assert_eq!(CallOutcome::Refused, got[1].1, "a write the fence stopped: {}", got[1].2);
        assert_eq!(CallOutcome::Failed, got[2].1, "a tool that is not here: {}", got[2].2);

        // THE DEFECT, NAMED. The refused reply does not contain the word a reader looking for
        // failure would look for, which is why reading the prose lost it.
        assert!(got[1].2.trim_start().starts_with("Refused"),
            "the refusal no longer opens with its own word: {}", got[1].2);
        assert!(!got[1].2.starts_with("Error"),
            "if a refusal ever opens 'Error' this test stops proving anything: {}", got[1].2);
        assert!(got[2].2.trim_start().starts_with("Error"), "{}", got[2].2);

        // And the refused call is a refusal and not a write with a warning on it: if the fence
        // ever let this path through, the reply would be `file_write`'s own success sentence and
        // the outcome above would be Done -- which is the whole failure, arriving one layer down.
        assert!(!got[1].2.contains("Wrote"),
            "the fence let the write through: {}", got[1].2);

        // The wire. Exactly the three words, in the key the browser reads.
        let maps: Vec<DaticleMap> = events.iter()
            .filter(|e| matches!(e, AgentEvent::ToolResult { .. }))
            .map(|e| e.to_datmap()).collect();
        let words = ["done", "refused", "failed"];
        for (i, m) in maps.iter().enumerate() {
            assert_eq!(Some(&dat!("tool_result")), m.get(&dat!("type")));
            assert_eq!(Some(&dat!(words[i])), m.get(&dat!("outcome")),
                "call {} spelled its outcome {:?}", i, m.get(&dat!("outcome")));
            // The two fields that were always there are still there: this is a field added,
            // not a shape changed. The event carries the result TEXT, and not the image.
            assert_eq!(Some(&dat!(got[i].0.clone())), m.get(&dat!("name")));
            assert_eq!(Some(&dat!(got[i].2.clone())), m.get(&dat!("content")));
        }
    }


    // ── The round's dispatch: what runs together, and in what order ──────
    //
    // The rule itself is `agent::batch`, and its own tests cover which tools may share a batch.
    // What is covered HERE is the round loop around it: that batching changes nothing a reader of
    // the event stream or of the conversation can see, and in particular that it does not change
    // the one thing the page depends on.

    /// A registry over a scratch workspace holding three small files, with the file tools a batch
    /// is made of and the write tool that breaks one.
    fn batch_tools() -> crate::tools::ToolRegistry {
        let dir = match oxedyne_fe2o3_test::scratch::scratch_dir("daimond_agent_batch") {
            Ok(d)  => d,
            Err(e) => panic!("a scratch directory: {}", e),
        };
        for (name, body) in [("one.txt", "first"), ("two.txt", "second"), ("three.txt", "third")] {
            if let Err(e) = std::fs::write(dir.join(name), body) {
                panic!("the fixture file '{}' could not be written: {}", name, e);
            }
        }
        let ws = match crate::workspace::Workspace::new(dir) {
            Ok(w)  => w,
            Err(e) => panic!("a scratch workspace: {}", e),
        };
        let mut r = crate::tools::ToolRegistry::new(Vec::new(), crate::tools::ToolContext {
            workspace:   ws,
            executor:    crate::executor::Executor::local_default(),
            cwd:         String::new(),
            path_prefix: String::new(),
            root:        crate::tools::FileRoot::Workspace,
            read_seen:   crate::tools::new_read_cache(),
            no_write:    Vec::new(),
            daimon_of:   String::new(),
        });
        r.tools = vec![crate::tools::Tool::FileRead, crate::tools::Tool::FileWrite];
        r
    }

    /// Every tool call and tool result in a run, in the order they reached the page, as
    /// `("call"|"result", name)`.
    fn call_stream(events: &[AgentEvent]) -> Vec<(&'static str, String)> {
        events.iter().filter_map(|e| match e {
            AgentEvent::ToolCall   { name, .. } => Some(("call",   name.clone())),
            AgentEvent::ToolResult { name, .. } => Some(("result", name.clone())),
            _ => None,
        }).collect()
    }

    /// Run one turn of the given tool calls against a scripted provider, and hand back every
    /// event it produced.
    async fn round_of(
        calls:    &[(&str, &str)],
        registry: &ToolRegistry,
    )
        -> Vec<AgentEvent>
    {
        let (port, _seen) = crate::llm::tests::start_stub(vec![
            tool_round(calls),
            plain_answer(),
        ]).await;
        let mut llm = crate::llm::tests::stub_client(port);
        llm.retry.max_attempts = 1;
        let a = Agent::new(llm, "You are Daimond.");
        a.set_max_rounds(2);
        let mut session = Session::new(fmt!("s1"), fmt!("batch"), fmt!("model"));
        let mut events: Vec<AgentEvent> = Vec::new();
        let _ = a.run_turn(&mut session, fmt!("do the work"), registry,
            &mut |ev| events.push(ev)).await;
        events
    }

    /// A batch of reads answers in the order the MODEL gave, not the order the reads finished.
    ///
    /// The three files hold different words, so an answer that came back out of order is caught
    /// by its content and not merely by its position.
    #[tokio::test]
    async fn test_a_batch_of_reads_answers_in_the_models_order_00() {
        let registry = batch_tools();
        let events = round_of(&[
            ("file_read", "{\"path\":\"one.txt\"}"),
            ("file_read", "{\"path\":\"two.txt\"}"),
            ("file_read", "{\"path\":\"three.txt\"}"),
        ], &registry).await;

        let got = tool_results(&events);
        assert_eq!(3, got.len(), "three reads went out and {} results came back", got.len());
        for (i, word) in ["first", "second", "third"].iter().enumerate() {
            assert!(got[i].2.contains(word),
                "result {} is not the answer to call {}: {}", i, i, got[i].2);
        }
    }

    /// ONE CALL ANNOUNCED, THEN ITS RESULT, WHATEVER RAN TOGETHER UNDERNEATH.
    ///
    /// This is the page's contract and not a tidiness: `www/js/daimond.js` keeps one
    /// `pendingTool` and one `pendingCallId` for the chat, the worker dock and the daimon alike,
    /// and files each result against whichever call was announced last.  Announce a whole batch
    /// up front and the first result is filed under the last call while the rest are dropped --
    /// out of the transcript and out of the write-ahead journal both.
    #[tokio::test]
    async fn test_a_round_announces_one_call_at_a_time_00() {
        let registry = batch_tools();
        let events = round_of(&[
            ("file_read", "{\"path\":\"one.txt\"}"),
            ("file_read", "{\"path\":\"two.txt\"}"),
            ("file_read", "{\"path\":\"three.txt\"}"),
        ], &registry).await;

        let stream = call_stream(&events);
        assert_eq!(6, stream.len(), "three calls did not produce three pairs: {:?}", stream);
        for (i, (kind, _)) in stream.iter().enumerate() {
            let want = if i % 2 == 0 { "call" } else { "result" };
            assert_eq!(want, *kind, "the stream stopped alternating at {}: {:?}", i, stream);
        }
    }

    /// A WRITE KEEPS ITS PLACE AMONG THE READS AROUND IT.
    ///
    /// The order the model gave is the order it intended, and a write is what separates the reads
    /// before it from the reads after it.  Asserted on the stream the page sees rather than on the
    /// batching, so it holds however the batching is later rewritten.
    #[tokio::test]
    async fn test_a_write_keeps_its_place_among_the_reads_00() {
        let registry = batch_tools();
        let events = round_of(&[
            ("file_read",  "{\"path\":\"one.txt\"}"),
            ("file_read",  "{\"path\":\"two.txt\"}"),
            ("file_write", "{\"path\":\"four.txt\",\"content\":\"fourth\"}"),
            ("file_read",  "{\"path\":\"three.txt\"}"),
        ], &registry).await;

        let names: Vec<String> = call_stream(&events).into_iter()
            .filter(|(kind, _)| *kind == "call")
            .map(|(_, name)| name)
            .collect();
        assert_eq!(vec!["file_read", "file_read", "file_write", "file_read"], names,
            "the round did not run the calls in the order the model gave them");
    }

    // ── The claims audit, and how a turn says it ended ──────────────────

    /// A registry over its own scratch workspace, holding the tools named.
    fn tools_over_scratch(tools: Vec<crate::tools::Tool>) -> crate::tools::ToolRegistry {
        let mut r = no_tools();
        r.tools = tools;
        r
    }

    /// One round of tool calls, as a provider streams them.
    ///
    /// Scripted rather than hand-built so a test states the CALL and lets the tool layer decide
    /// what becomes of it.  What is under test is that the app carries the tool layer's own
    /// verdict and the model's own arguments, so both have to come from the real thing.
    ///
    /// # Arguments
    /// * `calls` - Each call as its wire name and its arguments JSON.
    fn tool_round(calls: &[(&str, &str)]) -> crate::llm::tests::Reply {
        let mut chunks = Vec::new();
        for (i, (name, args)) in calls.iter().enumerate() {
            // The arguments ride as a JSON string inside a JSON object, so they are escaped once
            // here and unescaped once by the stream accumulator.
            let esc = args.replace('\\', "\\\\").replace('"', "\\\"");
            chunks.push(fmt!(
                "data: {{\"choices\":[{{\"delta\":{{\"tool_calls\":[{{\"index\":{},\
                 \"id\":\"c{}\",\"type\":\"function\",\"function\":{{\"name\":\"{}\",\
                 \"arguments\":\"{}\"}}}}]}}}}]}}\n\n",
                i, i, name, esc));
        }
        chunks.push(
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n".to_string());
        chunks.push("data: [DONE]\n\n".to_string());
        crate::llm::tests::Reply::Sse { chunks, reset_after: None }
    }

    /// Run one turn against a scripted provider, and hand back what the turn came to.
    async fn ran(
        script:     Vec<crate::llm::tests::Reply>,
        registry:   &ToolRegistry,
        max_rounds: usize,
    )
        -> TurnEnding
    {
        let (port, _seen) = crate::llm::tests::start_stub(script).await;
        let mut llm = crate::llm::tests::stub_client(port);
        llm.retry.max_attempts = 1;
        let a = Agent::new(llm, "You are Daimond.");
        a.set_max_rounds(max_rounds);
        let mut session = Session::new(fmt!("s1"), fmt!("audit"), fmt!("model"));
        let _ = a.run_turn(&mut session, fmt!("do the work"), registry, &mut |_| {}).await;
        match a.ending() {
            Some(e) => e,
            None    => panic!("a turn ran and said nothing at all about how it ended"),
        }
    }

    /// A turn's byte allowance starts AT THE TURN, wherever the turn came from.
    ///
    /// Nothing resets itself.  The ledger lives on a [`ToolContext`] that OUTLIVES the turn -- the
    /// browser chat builds one for the life of the app, and a Diamond's daimon shares that very
    /// one -- so if the reset sat anywhere but at the entry to a turn, a single long read would
    /// narrow every turn after it for the rest of the session.
    #[tokio::test]
    async fn test_a_turn_starts_its_byte_allowance_at_the_turn() {
        let a = dead_agent();
        let registry = no_tools();
        registry.ctx.charge_spend(500_000);
        assert_eq!(0, registry.ctx.spend_left(), "the fixture did not spend the allowance");
        let mut session = Session::new(fmt!("s1"), fmt!("budget"), fmt!("model"));
        // The provider is a port nothing is listening on, so the turn fails at once -- which is
        // the point: what is under test happens BEFORE the request goes out.
        let _ = a.run_turn(&mut session, fmt!("read the file"), &registry, &mut |_| {}).await;
        assert!(!registry.ctx.spend_is_short(),
            "this turn began already short, having spent nothing of its own");
        assert_eq!(crate::tools::TURN_SPEND_BUDGET, registry.ctx.spend_left(),
            "the last turn's spending is still charged to this one");
    }

    #[tokio::test]
    async fn test_a_refused_tool_is_not_a_completed_step_00() {
        // Three real calls: one that works, one the fence stops, one that is not registered. The
        // audit tallies the tool layer's own verdict -- it does not re-read the sentence, which is
        // how a refusal, whose reply opens "Refused" rather than "Error", was drawn as a completed
        // step, journalled as a success and reported to the Optimiser as a tool that had worked.
        let registry = one_tool();
        let end = ran(vec![three_calls(), plain_answer()], &registry, 2).await;

        assert_eq!(3, end.calls, "{:?}", end);
        assert_eq!(1, end.refused, "the call the fence stopped was booked as work: {:?}", end);
        assert_eq!(1, end.failed, "{:?}", end);
        assert!(end.unaccounted(),
            "a turn holding a refusal and a breakage reported nothing to answer for: {:?}", end);
        // And the ending itself is the ordinary one: the turn ANSWERED. What is unaccounted for
        // is a separate question from how the turn finished, and collapsing the two would make
        // every turn with one refused call look like a turn that fell over.
        assert_eq!(TurnEnd::Answered, end.how, "{:?}", end);
    }

    #[tokio::test]
    async fn test_a_file_a_call_said_it_left_and_did_not_is_reported_00() {
        // The claim is not in the prose. It is in the ARGUMENTS of the call, which name a path,
        // and after the turn a named path that is not there is a fact rather than a reading.
        //
        // Two calls, identical but for the file: one names a path that is on the store and one
        // names a path that is not. The pair is what makes either half mean anything -- an audit
        // that reported both, or neither, would satisfy a test of only one.
        let registry = one_tool();
        let there = registry.ctx.workspace.root().join("there.txt");
        if let Err(e) = std::fs::write(&there, "x") {
            panic!("the fixture file must exist for the control half to mean anything: {}", e);
        }
        let mut claims = Claims::default();
        claims.record("file_write", r#"{"path":"there.txt","content":"x"}"#, CallOutcome::Done);
        claims.record("file_write", r#"{"path":"ghost.txt","content":"x"}"#, CallOutcome::Done);

        let a = dead_agent();
        let end = a.audit(TurnEnd::Answered, 1, &claims, Some(&registry)).await;
        assert_eq!(vec![fmt!("ghost.txt")], end.missing,
            "the file that is there, the file that is not, or both: {:?}", end);
        assert!(end.unaccounted(), "{:?}", end);
    }

    #[tokio::test]
    async fn test_a_call_that_never_ran_claims_nothing_00() {
        // A REFUSED WRITE IS NOT A FILE ANYBODY SHOULD BE LOOKING FOR, and neither is one whose
        // call was cut off at the output limit -- that reply opens "Error", so the call is booked
        // `Failed`. Both carry a perfectly readable `path`; the outcome is what keeps them out of
        // the audit, which is the same rule `AgentEvent::ToolResult` carries.
        let registry = one_tool();
        let mut claims = Claims::default();
        claims.record("file_write", r#"{"path":"stopped.txt","content":"x"}"#,
            CallOutcome::Refused);
        claims.record("file_write", r#"{"path":"src/big.rs","content":"fn main() {"#,
            CallOutcome::Failed);
        let a = dead_agent();
        let end = a.audit(TurnEnd::Answered, 1, &claims, Some(&registry)).await;
        assert!(end.missing.is_empty(),
            "a turn was told to go looking for a file no tool ever wrote: {:?}", end);
        // Counted, though. They are the other half of the audit and the reason the turn has
        // something to answer for at all.
        assert_eq!(1, end.refused, "{:?}", end);
        assert_eq!(1, end.failed, "{:?}", end);
        assert!(end.unaccounted(), "{:?}", end);
    }

    #[tokio::test]
    async fn test_a_file_written_and_then_deleted_is_not_reported_missing_00() {
        // The turn's LAST word about a path is the turn's word about it. Without that rule every
        // scratch file a turn tidied up after itself would be reported as a write that did not
        // happen -- which is a warning on a turn that did exactly what it said, and an app that
        // does that is teaching its reader to skip the warning that matters.
        let registry = tools_over_scratch(vec![
            crate::tools::Tool::FileWrite,
            crate::tools::Tool::FileDelete,
        ]);
        let end = ran(vec![
            tool_round(&[
                ("file_write",  r#"{"path":"scratch.txt","content":"working"}"#),
                ("file_delete", r#"{"path":"scratch.txt"}"#),
            ]),
            plain_answer(),
        ], &registry, 2).await;

        assert_eq!(2, end.calls, "{:?}", end);
        assert_eq!(0, end.refused, "{:?}", end);
        assert_eq!(0, end.failed, "{:?}", end);
        assert!(end.missing.is_empty(), "{:?}", end);
        assert!(!end.unaccounted(), "{:?}", end);
        // AND THE FILE REALLY IS GONE. Without this the test would pass just as well against a
        // delete that silently did nothing, and would be proving that the audit ignores a file
        // that is present rather than that it forgives one that was deliberately removed.
        assert!(!registry.ctx.workspace.root().join("scratch.txt").exists(),
            "the delete did not happen, so nothing here is being tested");
    }

    #[tokio::test]
    async fn test_a_turn_that_ran_a_shell_command_is_not_told_a_file_is_missing_00() {
        // A shell command, a build, a verifier run and a worker each act on paths nobody wrote
        // down. The app cannot know which of them removed a file, and the honest answer to a
        // question it cannot answer is silence -- an audit that guessed here would raise a finding
        // on any turn that wrote a file and then ran `cargo test`.
        let registry = one_tool();
        let a = dead_agent();
        let write = r#"{"path":"ghost.txt","content":"x"}"#;

        // The control: with no shell in the turn, the missing file IS reported.
        let mut alone = Claims::default();
        alone.record("file_write", write, CallOutcome::Done);
        let end = a.audit(TurnEnd::Answered, 1, &alone, Some(&registry)).await;
        assert_eq!(vec![fmt!("ghost.txt")], end.missing,
            "the control half does not report the file, so the half below proves nothing: {:?}",
            end);

        // The same turn, having also run a command.
        let mut with_shell = Claims::default();
        with_shell.record("file_write", write, CallOutcome::Done);
        with_shell.record("shell", r#"{"command":"rm ghost.txt"}"#, CallOutcome::Done);
        let end = a.audit(TurnEnd::Answered, 1, &with_shell, Some(&registry)).await;
        assert!(end.missing.is_empty(),
            "the app claimed to know what a shell command did not do: {:?}", end);

        // A command the fence turned away ran nothing, so it explains nothing and silences
        // nothing. Without this the whole check would be switched off by any refused shell call.
        let mut refused_shell = Claims::default();
        refused_shell.record("file_write", write, CallOutcome::Done);
        refused_shell.record("shell", r#"{"command":"rm ghost.txt"}"#, CallOutcome::Refused);
        let end = a.audit(TurnEnd::Answered, 1, &refused_shell, Some(&registry)).await;
        assert_eq!(vec![fmt!("ghost.txt")], end.missing,
            "a refused command switched the audit off: {:?}", end);
    }

    #[tokio::test]
    async fn test_a_turn_that_did_what_it_said_has_nothing_to_answer_for_00() {
        // THIS MATTERS AS MUCH AS THE FINDING DOES. An audit that raises something on an ordinary
        // turn is an audit nobody reads, and then the one turn that needed reading goes past with
        // everything else.
        let registry = one_tool();
        let end = ran(vec![
            tool_round(&[("file_write", r#"{"path":"notes/kept.txt","content":"hi"}"#)]),
            plain_answer(),
        ], &registry, 2).await;

        assert_eq!(TurnEnd::Answered, end.how, "{:?}", end);
        assert_eq!(1, end.calls, "{:?}", end);
        assert_eq!(0, end.refused, "{:?}", end);
        assert_eq!(0, end.failed, "{:?}", end);
        assert!(end.missing.is_empty(), "{:?}", end);
        assert!(!end.unaccounted(),
            "an ordinary turn was given something to answer for: {:?}", end);
        // The check RAN and passed, rather than being skipped: the file the call named is there.
        assert!(registry.ctx.workspace.root().join("notes/kept.txt").exists(),
            "the write did not land, so the audit had nothing to be right about");
    }

    #[tokio::test]
    async fn test_a_turn_that_used_none_of_its_tools_says_so_00() {
        // THE CASE THIS WAS BUILT FOR. A model announced "let me rewrite from line 43 through 49
        // applying the lessons" and then ended its turn having written nothing. The spinner
        // stopped, which was correct, and the user was left saying "I have no visibility on what
        // occurred here". Nothing was technically wrong, so nothing was said.
        //
        // The figures say it without reading a word of the reply: tools on the table, no call
        // made. What the model promised is the reader's business; whether it did anything is the
        // app's, and this is the app's answer.
        let registry = one_tool();
        let end = ran(vec![plain_answer()], &registry, 4).await;

        assert_eq!(TurnEnd::Answered, end.how, "{:?}", end);
        assert_eq!(0, end.calls, "{:?}", end);
        assert_eq!(1, end.rounds, "{:?}", end);
        assert!(end.offered > 0,
            "a turn that held no tools is a different case entirely: {:?}", end);
        // AND IT IS NOT A WARNING. Nothing went wrong -- the model may simply have answered a
        // question -- so the ending reports the shape of the turn and claims no fault.
        assert!(!end.unaccounted(),
            "a turn that merely answered was reported as having something wrong: {:?}", end);
    }

    #[tokio::test]
    async fn test_a_turn_that_spent_its_round_budget_says_so_00() {
        // The round limit was already announced, in the app's own voice. What it did not do was
        // say what the turn had MADE OF that budget, which is the figure that tells a reader
        // whether to raise the ceiling or stop the work.
        let registry = one_tool();
        let end = ran(vec![
            tool_round(&[("file_write", r#"{"path":"a.txt","content":"1"}"#)]),
            tool_round(&[("file_write", r#"{"path":"b.txt","content":"2"}"#)]),
        ], &registry, 2).await;

        assert_eq!(TurnEnd::Capped, end.how, "{:?}", end);
        assert_eq!(2, end.rounds, "{:?}", end);
        assert_eq!(2, end.calls, "{:?}", end);
        assert!(end.missing.is_empty(), "{:?}", end);
    }

    #[tokio::test]
    async fn test_a_turn_the_provider_ended_still_says_how_it_ended_00() {
        // The ending that was least visible of all: the turn returns an error, and until now
        // nothing recorded that a turn had finished at all.
        let a = dead_agent();
        let registry = no_tools();
        let mut session = Session::new(fmt!("s1"), fmt!("dead"), fmt!("model"));
        let out = a.run_turn(&mut session, fmt!("hello"), &registry, &mut |_| {}).await;
        assert!(out.is_err(), "the stub agent reached a provider, so this proves nothing");

        let end = match a.ending() {
            Some(e) => e,
            None    => panic!("a turn ended in an error and said nothing about how it ended"),
        };
        assert_eq!(TurnEnd::Failed, end.how, "{:?}", end);
        assert!(!end.unaccounted(),
            "a turn that never reached a tool has no tool to answer for: {:?}", end);
    }

    #[tokio::test]
    async fn test_a_turn_that_said_nothing_says_that_it_said_nothing_00() {
        // The one ending the app already explained, kept explained -- and now in the same words
        // every other ending uses, so a reader does not have to know which of two mechanisms
        // produced the line in front of them.
        let quiet = crate::llm::tests::Reply::Sse {
            chunks: vec![
                "data: {\"choices\":[{\"delta\":{}}]}\n\n".to_string(),
                "data: [DONE]\n\n".to_string(),
            ],
            reset_after: None,
        };
        let registry = no_tools();
        let end = ran(vec![quiet], &registry, 1).await;
        assert_eq!(TurnEnd::Silent, end.how, "{:?}", end);
        assert_eq!(0, end.offered, "a pure chat holds no tools: {:?}", end);
    }

    #[test]
    fn test_an_ending_travels_as_one_of_five_words_00() {
        // Spelled once, for the reason `CallOutcome::wire` is: the browser knows these words and
        // no others, so a second speller would not fail loudly -- it would draw an ending nobody
        // recognises, which is the silence this whole mechanism replaces.
        let all = [
            (TurnEnd::Answered, "answered"),
            (TurnEnd::Stopped,  "stopped"),
            (TurnEnd::Capped,   "capped"),
            (TurnEnd::Silent,   "silent"),
            (TurnEnd::Failed,   "failed"),
        ];
        for (end, word) in all {
            assert_eq!(word, end.wire(), "{:?}", end);
        }
        // `Stopped` is the browser's alone: the native transport has no cancellation path, so
        // `stream_sse` always reports a stream that ran to its end. It is spelled here so the two
        // halves of the seam agree about a word only one of them can produce.
        assert_eq!("stopped", TurnEnd::Stopped.wire());
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
    async fn test_every_turn_says_how_it_ended_and_says_it_before_done_00() {
        // The owner watched a model announce work and then end its turn having done none.
        // The spinner stopped, correctly -- the turn HAD ended -- and there was no way to
        // tell that from a turn that finished.  Three endings were explained before this
        // and every other one was silence, so the assertion is that there is no longer any
        // such thing as a turn that ends without saying so.
        use crate::llm::tests::{start_stub, stub_client, Reply};
        let (port, _seen) = start_stub(vec![Reply::Sse {
            chunks: vec![
                "data: {\"choices\":[{\"delta\":{\"content\":\"I will rewrite it.\"}}]}\n\n"
                    .to_string(),
                "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n"
                    .to_string(),
                "data: [DONE]\n\n".to_string(),
            ],
            reset_after: None,
        }]).await;
        let mut llm = stub_client(port);
        llm.retry.max_attempts = 1;
        let a = Agent::new(llm, "You are Daimond.");
        a.set_max_rounds(2);

        let registry = one_tool();
        let mut session = Session::new(fmt!("s1"), fmt!("ended"), fmt!("model"));
        let mut events: Vec<AgentEvent> = Vec::new();
        let _ = a.run_turn(&mut session, fmt!("rewrite lines 43 to 49"), &registry,
            &mut |ev| events.push(ev)).await;

        let end = events.iter().position(|e| matches!(e, AgentEvent::Ended { .. }));
        assert!(end.is_some(), "a turn ended and said nothing about how: {:?}",
            events.iter().map(|e| fmt!("{:?}", e)).collect::<Vec<_>>());
        // ORDER, because a reader draws the closing line under the turn: an ending that
        // arrived after `Done` would be drawn under the turn after it.
        if let Some(done) = events.iter().position(|e| matches!(e, AgentEvent::Done)) {
            assert!(end < Some(done), "the ending arrived after the turn was declared done");
        }
        // Tools were on the table and none was called, which is exactly the owner's case.
        // It is reported as a FACT and not as a fault: what the model promised is the
        // reader's business, whether it did anything is the app's.
        match events.iter().find(|e| matches!(e, AgentEvent::Ended { .. })) {
            Some(AgentEvent::Ended { how, offered, calls, .. }) => {
                assert_eq!(how, "answered", "a plain stop is not a failure");
                assert!(*offered > 0, "the turn was offered no tools, so it proves nothing here");
                assert_eq!(*calls, 0, "the stub called nothing, so the count must say so");
            }
            _ => panic!("no ending to read"),
        }
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

    // ── A question put to the user ends the turn; a refused one does not ──

    /// **The rule the tool loop ends a turn by, in all four of its cases.**
    ///
    /// Two of them are the defect and two are the controls.  A question that was PUT must end the
    /// turn, or the model is charged a whole extra request whose only content is a paragraph
    /// restating the question under a card that already asks it.  A question that was REFUSED
    /// must not, because every refusal `ask_step` composes is advice -- put the options back,
    /// name the recommendation, ask one thing rather than six -- and advice the model is denied
    /// the round to take is advice it never takes.
    ///
    /// **That second case is a scar and not a hypothesis.**  The rule stood here before, read a
    /// tool's NAME alone, and named `say`; a worker refused the fold had its turn ended on the
    /// refusal telling it to write a report, so the report was never written and the whole errand
    /// came back as whatever prose accompanied the call.  Work done, paid for and thrown away, on
    /// 2026-08-21.
    #[test]
    fn test_only_a_question_that_reached_the_screen_ends_the_turn_00() {
        use crate::tools::CallOutcome;
        assert!(ends_turn("ask", CallOutcome::Done),
            "a question that is on the user's screen no longer ends the turn, so the model is \
             charged a request to say it has asked");
        assert!(!ends_turn("ask", CallOutcome::Refused),
            "a refused question ended the turn, so the model never got the round in which to put \
             it properly -- which is what `say` did to a worker's report");
        assert!(!ends_turn("ask", CallOutcome::Failed),
            "a question the page could not draw ended the turn, so the user is left with nothing \
             on screen and the model with nothing to say");
        assert!(!ends_turn("file_write", CallOutcome::Done),
            "a tool that is not a question ended the turn");
    }

    // ── A refused tool call does not end the turn ───────────────────────

    /// **A worker whose tool call is refused gets the round it was told to use, and its report
    /// survives.**
    ///
    /// Two rounds from the stub. In the first the worker calls `file_show`, which a dispatched
    /// worker may not take -- nobody is reading its transcript. In the second it writes the report
    /// the refusal told it to write.
    ///
    /// **The subject used to be `say`, and it was the tool that ended a turn.** A `say` that
    /// ANSWERED ended it; the rule first read the tool's NAME alone, so a `say` that was REFUSED
    /// ended it too -- and a worker told to put the detail in its report was denied the round in
    /// which to write one, so the errand came back as whatever prose happened to accompany the
    /// call, which is usually nothing. Work done, paid for and thrown away. The tool is gone and
    /// no tool ends a turn now, which makes this the guard on that: a refusal must still leave the
    /// loop running, whichever tool refused.
    ///
    /// **Asserted on the report's CONTENT and not on the round count**, because a count is
    /// satisfied by any second round at all -- including one that says nothing.
    #[tokio::test]
    async fn test_a_worker_refused_a_tool_still_reports_00() {
        use crate::llm::tests::{start_stub, stub_client, Reply};
        const REPORT: &str = "THE-CRATE-FAILS-TO-BUILD-ON-LINE-42";
        let (port, _seen) = start_stub(vec![
            // Round one: the call, which is refused.
            Reply::Sse {
                chunks: vec![
                    "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\
                     \"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\
                     \"file_show\",\"arguments\":\"{\\\"path\\\":\\\"report.md\\\"}\"}}]}}]}\n\n"
                        .to_string(),
                    "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n"
                        .to_string(),
                    "data: [DONE]\n\n".to_string(),
                ],
                reset_after: None,
            },
            // Round two: the report, in the place the refusal told it to put it.
            Reply::Sse {
                chunks: vec![
                    fmt!("data: {{\"choices\":[{{\"delta\":{{\"content\":\"{}\"}}}}]}}\n\n",
                        REPORT),
                    "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n"
                        .to_string(),
                    "data: [DONE]\n\n".to_string(),
                ],
                reset_after: None,
            },
        ]).await;
        let mut llm = stub_client(port);
        llm.retry.max_attempts = 1;
        let a = Agent::new(llm, "You are a worker.");
        a.set_max_rounds(3);

        let mut registry = no_tools();
        registry.tools = vec![crate::tools::Tool::FileShow];
        registry.ctx.set_unsupervised();

        let mut session = Session::new(fmt!("s1"), fmt!("worker"), fmt!("model"));
        let mut events: Vec<AgentEvent> = Vec::new();
        let _ = a.run_turn(&mut session, fmt!("check the build"), &registry,
            &mut |ev| events.push(ev)).await;

        // What the agent that dispatched this worker actually receives.
        let report = session.messages.iter().rev()
            .find_map(|m| match m {
                ChatMessage::Assistant { content, tool_calls } if tool_calls.is_empty() =>
                    Some(content.as_text().into_owned()),
                _ => None,
            })
            .unwrap_or_default();
        assert!(report.contains(REPORT),
            "the worker's report is not in the transcript: the turn ended on a refused call and \
             its findings were discarded. Last assistant turn: {:?}", report);
        // And the refusal is still on the record, so the transcript is well formed and the
        // model can see why it was asked to write prose.
        assert!(session.messages.iter().any(|m| matches!(m, ChatMessage::Tool { .. })),
            "the refused call was never answered, which is a malformed conversation");
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
        //
        // THE WINDOW IS 80,000 BECAUSE `FOLD_AT` MOVED. At 0.8 the two figures parted on a
        // 100,000 window; at 0.65 the fraction ceiling is 65,000 there, which is below the honest
        // reserve ceiling of 66,976 -- so both budgets come out at 65,000 and this test could see
        // nothing to compare. The reserve binds where the fraction does not, which above 64,000 is
        // any window under 94,354; 80,000 sits inside it with room to spare.
        let window = 80_000;

        // Told the truth, the fold fits first time and the learned window is left alone.
        let fixed = thinking_agent(4_096);
        fixed.set_context_window(window);
        assert_eq!(32_000, fixed.reply_cap());
        assert_eq!(Some((0, 46_976)), recovery(&fixed, window, fixed.reply_cap()),
            "the budget must leave room for the reply the client asks for");
        assert_eq!(window, fixed.limits().window, "and must not have to learn anything");

        // Blind, it sends the fold fraction of the window with 32,000 of reply behind it, is
        // refused, and pays for the mistake twice: a wasted round trip, and a window permanently
        // taught to be 39,000 -- `learn_from_refusal` never revises upward, so every later fold in
        // this session is made against a model half the size of the real one.
        let blind = thinking_agent(4_096);
        blind.set_context_window(window);
        assert_eq!(Some((1, 25_350)), recovery(&blind, window, blind.llm.max_tokens),
            "the old figure must cost a refusal it did not need to");
        assert_eq!(39_000, blind.limits().window, "and mis-teach the window for the rest of the run");
        // And the conversation pays: the fold that finally goes out is little more than half the
        // one the honest figure would have sent, on the same model, for no reason.
        assert!(25_350 < 46_976);
    }

    #[test]
    fn test_a_small_learned_window_recovers_in_one_refusal_rather_than_several_00() {
        // The case the fix is really for. At 40,000 the reply is most of the window, so a budget
        // that ignores it is wrong by a factor of eight and the grinding-down is visible: the
        // blind figure is refused twice and lands on a 4,386-token conversation, the honest one is
        // refused once and keeps forty per cent more.
        //
        // It was THREE refusals and 2,366 tokens while `FOLD_AT` was 0.8. Lowering it to 0.65
        // makes the blind figure smaller from the start, so it crosses under the real window one
        // round sooner -- the blind path is still worse on both counts, which is the whole claim,
        // and the counts themselves are a property of the fraction rather than of the fix.
        let honest = thinking_agent(4_096);
        honest.set_context_window(40_000);
        let (h_rounds, h_prompt) = recovery(&honest, 40_000, honest.reply_cap())
            .expect("the honest figure converges");

        let blind = thinking_agent(4_096);
        blind.set_context_window(40_000);
        let (b_rounds, b_prompt) = recovery(&blind, 40_000, blind.llm.max_tokens)
            .expect("the blind figure converges too, eventually");

        assert_eq!((1, 6_092), (h_rounds, h_prompt));
        assert_eq!((2, 4_386), (b_rounds, b_prompt));
        assert!(h_rounds < b_rounds, "the fix must cost fewer round trips");
        assert!(h_prompt > b_prompt, "and leave more of the conversation standing");
    }

    #[test]
    fn test_a_user_moves_where_their_conversation_folds_00() {
        // The setting exists so the person watching the meter can decide, so what is asserted is
        // that the BUDGET moves -- not that a field was written. A window of 100,000 makes the
        // arithmetic readable: two thirds of it against four fifths of it is a difference of
        // 15,000 tokens of conversation, which is several exchanges.
        let a = make_test_agent();
        a.set_context_window(100_000);
        let cap = 0u32;   // no reply reserve in the way, so the fraction is the only ceiling
        let shipped = a.limits().budget(cap);
        assert_eq!(compact::FOLD_AT, a.limits().fold_at,
            "a fresh agent must fold at the shipped figure");

        a.set_fold_at(0.8);
        let later = a.limits().budget(cap);
        assert!(later > shipped,
            "folding at 0.8 must leave more room than the shipped {}: {} against {}",
            compact::FOLD_AT, later, shipped);

        // Zero is how a caller says "the user has not chosen". It must leave the figure alone
        // rather than fold the conversation to nothing, because that is what the browser passes
        // for every chat nobody has set a fraction on.
        a.set_fold_at(0.0);
        assert_eq!(later, a.limits().budget(cap),
            "zero must leave the agent's own figure standing");

        // Held at the band, and asserted through the GETTER: a control that draws itself from
        // `fold_at` would otherwise show a figure the arithmetic never used.
        a.set_fold_at(9.0);
        assert_eq!(compact::FOLD_AT_MAX, a.limits().fold_at);
        a.set_fold_at(0.001);
        assert_eq!(compact::FOLD_AT_MIN, a.limits().fold_at);
    }

    #[tokio::test]
    async fn test_the_fold_does_not_call_a_shortened_answer_a_tool_result_00() {
        // A PURE CHAT HAS NO TOOL RESULTS AT ALL, and `compact::elide_bulk` shrinks a long
        // assistant turn on the same rule it shrinks a tool reply on. The sentence used to say
        // "shortened N tool results" either way, so the one user whose own answers had just been
        // clipped to 400 characters was told about tool output they never had.
        //
        // Built too short to fold -- six messages is `MIN_KEEP_MESSAGES`, so `tail_start` answers
        // zero -- and too big to send, which is the only shape where eliding does all the work.
        let a = dead_thinking_agent();
        a.set_context_window(20_000);
        let mut session = Session::new(fmt!("s2"), fmt!("bulky"), fmt!("claude-opus-5"));
        for i in 0..2 {
            session.messages.push(ChatMessage::user(fmt!("ask {}", i)));
            session.messages.push(ChatMessage::Assistant {
                content: MessageContent::text("y".repeat(30_000)), tool_calls: Vec::new(),
            });
        }
        // COUNTED AS THE TURN WILL SEE IT. `run_turn` pushes the user's own message first, so a
        // fixture measured before that push is one message short -- which is how the first draft
        // of this test built five messages, watched `run_turn` make it six, and folded when it
        // meant to elide.
        let mut as_sent = session.messages.clone();
        as_sent.push(ChatMessage::user(fmt!("carry on")));
        assert_eq!(0, compact::tail_start(&as_sent,
            1_000, compact::MIN_KEEP_MESSAGES, 1_000, &a.llm.open_folds()),
            "the fixture must be too short to fold, or this tests the other half");

        let registry = no_tools();
        let mut events: Vec<AgentEvent> = Vec::new();
        let _ = a.run_turn(&mut session, fmt!("carry on"), &registry,
            &mut |ev| events.push(ev)).await;
        let note = events.iter().find_map(|e| match e {
            AgentEvent::Compacted { note, .. } => Some(note.clone()),
            _ => None,
        }).expect("a conversation many times its window must have been compacted");
        assert!(note.starts_with("Shortened "),
            "the fixture must have elided rather than folded: {}", note);
        assert!(!note.contains("tool results:"),
            "the fold called an answer a tool result: {}", note);
        assert!(note.contains("tool results and answers"),
            "the fold must name both kinds, since it shortens both: {}", note);
        // AND WHERE, which is the second half of the 2026-08-28 ruling. A sentence saying the
        // answers were shortened, read beside those answers sitting in full on the screen above,
        // is a contradiction handed to the reader to resolve.
        assert!(note.contains("on the way to the model"),
            "the notice does not say the shortening is the request's and not the record's: {}",
            note);

        // And the claim behind the wording: an ANSWER really was the thing that shrank. Asked of
        // the COUNT rather than of the stored text, because since 2026-08-28 the stored text is
        // exactly what it was -- see `test_an_answer_shortened_to_fit_stays_whole_in_the_record_00`,
        // which reads the request body a stub provider really received and is where the claim
        // that something shrank on the wire now lives.
        let shrank = note.split("hortened ").nth(1)
            .and_then(|s| s.split(' ').next())
            .and_then(|s| s.parse::<usize>().ok())
            .unwrap_or(0);
        assert!(shrank > 0,
            "nothing was shortened at all, so the wording is not what this is about: {}", note);
        // THE RECORD IS UNTOUCHED, and this is the assertion that was the other way round until
        // the ruling. A conversation with no fold and no room has had its request shortened; the
        // session it was built from still holds every character of both answers.
        for m in session.messages.iter() {
            assert!(!m.text().contains("folded away to fit the context window"),
                "the engine's own elision note was written into the stored conversation");
        }
        assert_eq!(2, session.messages.iter()
            .filter(|m| matches!(m, ChatMessage::Assistant { .. }) && m.text().len() >= 30_000)
            .count(),
            "an answer the model was sent a clipped copy of came back short in the record");
    }

    /// A conversation that is too short to fold and too big to send, with a word past the cap.
    ///
    /// The marker sits a thousand characters into each answer, which is well past
    /// [`compact::TOOL_ELISION_CAP`], so it survives only where the whole answer survives.  Both
    /// tests below turn on that one word being somewhere and not somewhere else.
    fn bulky_session(mark: &str) -> Session {
        let mut session = Session::new(fmt!("s"), fmt!("bulky"), fmt!("model"));
        for i in 0..2 {
            session.messages.push(ChatMessage::user(fmt!("ask {}", i)));
            session.messages.push(ChatMessage::Assistant {
                content: MessageContent::text(
                    fmt!("{}{}{}", "y".repeat(1_000), mark, "y".repeat(30_000))),
                tool_calls: Vec::new(),
            });
        }
        session
    }

    #[tokio::test]
    async fn test_an_answer_shortened_to_fit_stays_whole_in_the_record_00() {
        // THE OWNER'S RULING OF 2026-08-28: the model gets the shortened version, his transcript
        // keeps every word. `compact::elide_bulk` edited `session.messages` in place, and that
        // list is the one `DaimondApp::export_session` hands the browser to store, to back up and
        // to sync -- so a thousand-word answer became four hundred characters in the user's own
        // record, permanently, with nothing said and no way back.
        //
        // Both halves are asked of an artefact rather than of the app. What the model got is read
        // out of the request body a stub provider really received; what the user kept is read out
        // of the session the turn was run against.
        const MARK: &str = "MARKER-PAST-THE-CAP";
        let (port, seen) = crate::llm::tests::start_stub(vec![plain_answer()]).await;
        let a = Agent::new(crate::llm::tests::stub_client(port), "You are Daimond.");
        a.set_context_window(20_000);
        let mut session = bulky_session(MARK);
        // Six messages is `MIN_KEEP_MESSAGES`, and `run_turn` adds the user's own before any of
        // this runs -- so a fixture measured before that push is one short, which is how an
        // earlier test in this file folded when it meant to elide.
        let mut as_sent = session.messages.clone();
        as_sent.push(ChatMessage::user(fmt!("carry on")));
        assert_eq!(0, compact::tail_start(&as_sent,
            1_000, compact::MIN_KEEP_MESSAGES, 1_000, &a.llm.open_folds()),
            "the fixture must be too short to fold, or this tests the other half");

        let registry = no_tools();
        let mut events: Vec<AgentEvent> = Vec::new();
        let _ = a.run_turn(&mut session, fmt!("carry on"), &registry,
            &mut |ev| events.push(ev)).await;

        let bodies = match seen.lock() {
            Ok(g)  => g.bodies.clone(),
            Err(e) => panic!("the stub's log: {}", e),
        };
        assert!(!bodies.is_empty(), "the stub was never called, so nothing was sent to read");
        let wire = bodies.join("\n");
        // The fixture reached the branch: something really was shortened on the way out.
        assert!(wire.contains("folded away to fit the context window"),
            "nothing was shortened for the model, so this proves nothing about what was kept");
        // COUNTED, not looked for. `elide_bulk` stops the moment the conversation fits, so with
        // two long answers it may clip one and leave the other -- and an assertion that the
        // marker is absent from the wire would then be red for a reason that is the elision
        // working. What must be true is that the model saw FEWER whole answers than the record
        // holds, and that is what is asked.
        let on_wire   = wire.matches(MARK).count();
        let in_record = session.messages.iter().filter(|m| m.text().contains(MARK)).count();
        assert_eq!(2, in_record,
            "the stored conversation lost the words past the cap -- the record is still the wire");
        assert!(on_wire < in_record,
            "the model was sent {} whole answers of the {} the record holds, so nothing was \
             shortened on the wire", on_wire, in_record);

        // AND THE RECORD IS WHOLE, which is the ruling. Red before it: the two lists were one.
        for m in session.messages.iter() {
            assert!(!m.text().contains("folded away to fit the context window"),
                "the engine's own elision note was written into the stored conversation");
        }
    }

    #[tokio::test]
    async fn test_a_later_fold_summarises_the_words_and_not_the_stubs_00() {
        // THE SECOND LOSS, which stood behind the first and was quieter. `fold_if_needed` renders
        // `session.messages` for the summarising model (`compact::render_for_fold`) and then, in
        // the same function, used to clip that same list. So the FIRST fold read the words and
        // every fold after it read whatever the elision had left -- four hundred characters and a
        // note, per message. A conversation folded twice was summarised from stubs, and the
        // summary is the only thing that survives a fold.
        //
        // Asked of `render_for_fold` itself, over the session a real turn left behind, because
        // that is the call the fold makes and the input it makes it on.
        const MARK: &str = "MARKER-PAST-THE-CAP";
        let (port, _seen) = crate::llm::tests::start_stub(vec![plain_answer()]).await;
        let a = Agent::new(crate::llm::tests::stub_client(port), "You are Daimond.");
        a.set_context_window(20_000);
        let mut session = bulky_session(MARK);
        let registry = no_tools();
        let mut events: Vec<AgentEvent> = Vec::new();
        let _ = a.run_turn(&mut session, fmt!("carry on"), &registry,
            &mut |ev| events.push(ev)).await;
        // The turn really did shorten something, or there is no "afterwards" to test.
        assert!(events.iter().any(|e| matches!(e, AgentEvent::Compacted { .. })),
            "the conversation was sent unshortened, so no later fold could read a stub");

        let rendered = compact::render_for_fold(&session.messages, compact::FOLD_INPUT_CAP);
        assert!(rendered.contains(MARK),
            "the next fold would summarise clipped stubs: {} bytes rendered, no marker in them",
            rendered.len());
        assert!(!rendered.contains("folded away to fit the context window"),
            "the next fold would be handed the engine's own elision notes as if they were the \
             conversation");
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
        // the call site rather than the function. The window is 80,000; the honest budget is
        // 46,976 and the blind one 52,000, so a conversation sitting between the two folds under
        // the figure that will be sent and does not fold under the figure that was configured --
        // the window was 100,000 while `FOLD_AT` was 0.8, and at 0.65 the fraction wins there and
        // closes the gap, so the fixture moved down with the constant --
        // and not folding is a prompt the provider refuses.
        let a = dead_thinking_agent();
        a.set_context_window(80_000);
        let mut session = Session::new(fmt!("s1"), fmt!("long"), fmt!("claude-opus-5"));
        for i in 0..46 {
            session.messages.push(ChatMessage::user(fmt!("step {}", i)));
            session.messages.push(ChatMessage::Assistant {
                content: MessageContent::text("x".repeat(4_000)), tool_calls: Vec::new(),
            });
        }
        // The conversation is deliberately built into the gap, and the gap is asserted rather
        // than assumed: a change to the gauge or to `FOLD_AT` that closed it would otherwise make
        // this test pass while testing nothing.
        let tokens = a.gauge.tokens(
            compact::conversation_bytes(&session.messages, &a.llm.open_folds()));
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
        // As the FRACTION, not as the figure it happened to come to. That is what the sentence
        // beside it claims, and writing it as 32,000 made a test about the reply reserve go red
        // when the fold fraction moved.
        assert_eq!((40_000.0 * compact::FOLD_AT) as u64, blind,
            "blind, the fold fraction was left untouched");
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
