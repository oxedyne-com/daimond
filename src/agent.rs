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
    /// Prompt tokens of the last round this turn has sent, updated alongside
    /// `session.last_prompt_tokens` -- one round, not the turn's running total; see
    /// `live_prompt` for why this sits outside the session's borrow.
    pub live_last_prompt: Cell<u64>,
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
    /// How many of the session's messages predate the turn in flight.
    ///
    /// The boundary [`compact::retire_upto`] is given.  Recorded rather than worked out from the
    /// conversation, because the one structural clue -- the last user message -- is also what an
    /// INTERJECTION is, and taking that as the boundary mid-turn would retire the results of the
    /// very turn it interrupted.  Not shared on clone: it belongs to whichever agent is running
    /// the turn.
    prior_end:           Cell<usize>,
    /// Where the turn in flight's own messages start in `session.messages`.
    ///
    /// Set at the top of `run_turn`, just before the user's sentence is pushed, and carried
    /// across every fold the turn makes -- because a fold RENUMBERS the conversation, and an
    /// index a caller took before the turn then reaches past the end of the list it names.
    /// The turn-end check in `DaimondApp::steer_inner` read exactly such an index, and a
    /// steering turn whose 200-message prior folded to 27 died at the slice with the promise
    /// never settled; see [`Agent::turn_start`].
    turn_start:          Cell<usize>,
    /// Whether the turn in flight has been orphaned: whatever dispatched this agent has
    /// ended, so nothing is holding a promise on what it is about to say.
    ///
    /// Written from outside a running turn -- [`crate::wasm::app::DaimondApp::orphan_worker`],
    /// from the page's `releaseTurn` -- which is why it is a cell and not an argument: by the
    /// time the dispatcher ends, the turn it is about is already several rounds in.  Read at
    /// the seam of each round; see [`compact::ORPHAN_GRACE_ROUNDS`].  Not shared on clone,
    /// like `prior_end` and `turn_start` beside it: it belongs to whichever agent is running
    /// the turn.
    orphaned:            Cell<bool>,
    // How the last turn ended.  Shared on clone rather than copied, exactly as the
    // interjection queue is: the page holds a clone of the agent and has to be able to read
    // the ending of the turn it just watched, which a detached cell would not carry.  Written
    // once per turn, at the single exit in `Agent::ended`.
    ending:              Rc<RefCell<Option<TurnEnding>>>,
    /// Which Diamond this turn is steering, or empty for a chat.
    ///
    /// **A FOLD HAS TO KNOW, AND ONLY THE CALLER DOES.**  `fold_if_needed` is handed the
    /// conversation and the limits and nothing that names a Diamond, so until this existed the
    /// one moment a conversation's memory is rewritten with no way back could not write any of
    /// it into the files that survive the conversation -- see `dev/CRYSTAL_CONTRACT.md` §13.
    /// Set beside the briefing, by `DaimondApp::compose_daimon`, and shared on clone for the
    /// reason `briefing` is: a worker dispatched from a steering turn is inside the same
    /// Diamond.
    diamond:             Rc<RefCell<String>>,
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
	/// The turn hit its round limit.  Fold regardless of the estimate -- the next turn is about
	/// to re-send this whole log -- and learn nothing about the window, because nothing was
	/// refused.
	Capped,
}

impl Fold {
	/// Should the estimate be overridden and the conversation folded anyway?
	fn forces(self) -> bool {
		!matches!(self, Self::IfNeeded)
	}

	/// Is this the fold that runs because a turn was stopped at its round limit?
	pub fn at_the_cap(self) -> bool {
		matches!(self, Self::Capped)
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
	SpendCapped,// the turn spent past the per-turn ceiling, with work still going
	Silent,     // the final message carried no text at all
	Failed,     // the provider or the transport ended the turn
	// The model wrote its own native tool-call syntax into the reply TEXT, twice running, so
	// the round produced neither an answer nor a call.  Its own word and not `Answered`,
	// which is the whole of the 2026-09-14 defect: a wire fault that ends a turn as a
	// success is a turn nobody can tell from one that worked.
	Malformed,
	// The model reasoned, was nudged once to answer or call a tool, and did neither again.
	// Its own word and not `Silent`, which is a reply with nothing in it and no reasoning
	// behind it either -- the 2026-09-15 defect this exists to name: a round that spent
	// 3,372 tokens thinking and ended mid-sentence was booked `TurnEnd::Silent` the same as
	// a reply that never tried.
	ReasonedOnly,
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
			Self::SpendCapped	=> "spend_cap",
			Self::Silent	=> "silent",
			Self::Failed	=> "failed",
			Self::Malformed	=> "malformed",
			Self::ReasonedOnly	=> "reasoned_only",
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
	// Rounds whose reply carried a tool call written as TEXT and had to be sent again.  A
	// leak the reader recovered is not counted: it cost no round and the tool ran.
	pub malformed:	usize,
	// Rounds thrown away to a reply that carried reasoning and nothing else -- no answer, no
	// tool call.  Counted even where the very next round answered fine, for the same reason
	// `malformed` is: the round still cost a request and a nudge, and a turn that ends
	// `Answered` after one of these is not the same as a turn that never needed telling.
	pub reasoned:	usize,
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
			|| self.malformed > 0 || self.reasoned > 0
	}
}

/// What the model is told when its tool call arrived as text.
///
/// **Tool-shaped, and deliberately short.**  It names what arrived, says what to do instead,
/// and stops -- a paragraph of apology is a paragraph the model reads on a round it is already
/// having to pay for twice.  The family's own note is appended where its bank rows earned one;
/// see [`crate::profile::Family::leak_hint`].
///
/// # Arguments
/// * `model` - The provider's slug, which is what names the family.
fn leak_nudge(model: &str) -> String {
	let base = "Your tool call arrived as text, not as a tool call. Emit it as a tool call.";
	match crate::profile::Family::detect(model).leak_hint() {
		Some(hint) => fmt!("{} {}", base, hint),
		None       => base.to_string(),
	}
}

/// What the model is told when its reply carried reasoning and nothing else -- no answer,
/// no tool call.
fn reasoned_only_nudge() -> String {
	"You reasoned but neither answered nor called a tool; do one of them now.".to_string()
}

/// What a WORKER is told when it did its work through tools and then ended with an empty
/// final reply.  It wrote no report, and the fan-out that dispatched it reads that silence
/// as "nothing found" -- so it is asked, once, to write the report the work is worth.
fn report_nudge() -> String {
	"You have finished your tool calls but written no report. Write your report now: \
	 say what you did, what you found, and where you left it. This is the only thing the \
	 person who dispatched you will read.".to_string()
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
	// Rounds thrown away to a leaked tool call.  It rides here rather than on `audit`'s
	// signature because it is the same KIND of fact as the rest -- a tally of what the turn
	// did, decidable without reading a word of the model's prose -- and because a tenth
	// parameter on the one exit is how a later exit comes to forget one.
	malformed: usize,
	// Rounds thrown away to a reply that reasoned and answered nothing.  Same reasoning as
	// `malformed`, immediately above.
	reasoned: usize,
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
            live_prompt:      Cell::new(0),
            live_completion:  Cell::new(0),
            live_cached:      Cell::new(0),
            live_cost:        Cell::new(0.0),
            live_last_prompt: Cell::new(0),
            interject:       new_interjections(),
            briefing:        Rc::new(RefCell::new(String::new())),
            limits:          Rc::new(RefCell::new(Limits::default())),
            gauge:           Rc::new(Gauge::default()),
            fold_prompt:     Rc::new(RefCell::new(String::new())),
            prior_end:       Cell::new(0),
            turn_start:      Cell::new(0),
            orphaned:        Cell::new(false),
            ending:          Rc::new(RefCell::new(None)),
            diamond:         Rc::new(RefCell::new(String::new())),
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
            malformed: ending.malformed,
            reasoned: ending.reasoned,
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
            malformed: claims.malformed,
            reasoned: claims.reasoned,
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
        self.hold_worker();
    }

    /// Set how many tool-call rounds one turn may take.
    ///
    /// # Arguments
    /// * `n` - The ceiling; zero is ignored, since a turn that may take no rounds is a turn
    ///   with no tools.
    pub fn set_max_rounds(&self, n: usize) {
        if n > 0 {
            self.limits.borrow_mut().max_rounds = n;
            self.hold_worker();
        }
    }

    /// Set the most context any one round of this agent's turns may carry, in tokens.
    ///
    /// The ceiling `fold_at`'s fraction is held under; see [`compact::ABSOLUTE_CAP`].  Held inside
    /// [`compact::CONTEXT_CAP_MIN`]..[`compact::CONTEXT_CAP_MAX`] here rather than only in
    /// [`compact::Limits::budget`], for the reason [`Agent::set_fold_at`] gives: a control drawn
    /// from the getter must show the figure the arithmetic used.
    ///
    /// # Arguments
    /// * `tokens` - The ceiling; zero restores the shipped default.
    pub fn set_context_cap(&self, tokens: u64) {
        self.limits.borrow_mut().context_cap = if tokens == 0 {
            compact::ABSOLUTE_CAP
        } else {
            tokens.clamp(compact::CONTEXT_CAP_MIN, compact::CONTEXT_CAP_MAX)
        };
        self.hold_worker();
    }

    /// Set the most one of this agent's turns may spend, in US dollars.
    ///
    /// **The ceiling that actually holds a runaway**, now that the round limit is a breath rather
    /// than a full stop: see [`compact::MAX_CONTINUATIONS`].  Held inside
    /// [`compact::SPEND_CAP_MIN_USD`]..[`compact::SPEND_CAP_MAX_USD`] here rather than only where
    /// it is read, for the reason [`Agent::set_fold_at`] gives: a control drawn from the getter
    /// must show the figure the arithmetic used.
    ///
    /// # Arguments
    /// * `usd` - The ceiling; zero or less restores the shipped default.
    pub fn set_spend_cap_usd(&self, usd: f64) {
        self.limits.borrow_mut().spend_cap_usd = if usd <= 0.0 {
            compact::DEFAULT_SPEND_CAP_USD
        } else {
            usd.clamp(compact::SPEND_CAP_MIN_USD, compact::SPEND_CAP_MAX_USD)
        };
        self.hold_worker();
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
            self.hold_worker();
        }
    }

    /// Hold this agent to what a dispatched worker may have: a hundred rounds, one continuation,
    /// a 96,000-token carry, a tail of three tenths and a dollar.
    ///
    /// **The mark is sticky and every figure is a ceiling**, so this may be called before or after
    /// the user's own settings reach the app and the answer is the same.  `Workers.start` applies
    /// the chat's settings to a worker's app and then calls this, which is the order that reads
    /// most naturally; it is the stickiness rather than the order that makes a user's 150 rounds
    /// unable to reach a worker.  See [`compact::Limits::hold_to_worker`] for why a worker gets
    /// its own figures at all.
    ///
    /// One-way, like [`crate::wasm::app::DaimondApp::set_unsupervised`], and for the same reason:
    /// an errand does not become a conversation part way through.
    pub fn set_worker_limits(&self) {
        self.limits.borrow_mut().hold_to_worker();
    }

    /// Set any of the compaction and worker-preset figures from one flat JSON object.
    ///
    /// **One setter for every knob**, because the alternative is a dozen wasm methods and a dozen
    /// JS call sites for figures nobody changes in ordinary use.  What they are for is
    /// MEASUREMENT: the three retire measures and the worker preset were compile-time constants,
    /// so nothing could say what any of them was worth -- an arm of a trial could not turn one off
    /// and compare.  See `dev/tune/` for the loop that reads them.
    ///
    /// A key that is absent is left alone, and so is a zero -- the same rule [`Agent::set_fold_at`]
    /// and its siblings follow, so `{}` is a no-op and a partial object is a partial change.  The
    /// exceptions are the three that are meaningfully false or zero: `retire_prior` is a boolean,
    /// `worker_continuations` of nought means one leg and no more, and `retire_keep_turns` of
    /// nought means no finished turn is spared.
    ///
    /// The worker ceiling is re-asserted afterwards, so a tune that arrives mid-run cannot lift a
    /// worker back over its own figures -- the rule every other setter here follows.
    ///
    /// # Arguments
    /// * `json` - A flat JSON object; empty, or `{}`, changes nothing.
    pub fn set_tune(&self, json: &str) -> Outcome<()> {
        let text = json.trim();
        if text.is_empty() {
            return Ok(());
        }
        if !(text.starts_with('{') && text.ends_with('}')) {
            return Err(err!("set_tune: expected a flat JSON object, got {} byte(s) \
                starting {:?}", text.len(), text.chars().take(24).collect::<String>();
                Invalid, Input));
        }
        {
            let mut l = self.limits.borrow_mut();
            // The retire measures.
            if let Some(b) = crate::llm::extract_json_bool(text, "retire_prior") {
                l.retire_prior = b;
            }
            // NOUGHT IS A CHOICE HERE TOO, and it is the one an arm of the trial wants: keeping no
            // finished turn whole is the behaviour that shipped before 2026-09-13, so it has to be
            // reachable rather than read as "absent".
            if let Some(n) = crate::llm::extract_json_number(text, "retire_keep_turns") {
                l.retire_keep_turns = n as u32;
            }
            if let Some(n) = crate::llm::extract_json_number(text, "written_age") {
                if n > 0 { l.written_age = n as usize; }
            }
            if let Some(n) = crate::llm::extract_json_number(text, "result_age") {
                if n > 0 { l.result_age = n as usize; }
            }
            if let Some(n) = crate::llm::extract_json_number(text, "result_cap") {
                if n > 0 { l.result_cap = n as usize; }
            }
            // A cadence of nought is a modulo by zero at the sweep, so it is floored here as
            // well as there -- a figure read back out of `limits()` has to be the one used.
            if let Some(n) = crate::llm::extract_json_number(text, "sweep_every") {
                if n > 0 { l.sweep_every = n as usize; }
            }
            // The worker preset.
            if let Some(n) = crate::llm::extract_json_number(text, "worker_max_rounds") {
                if n > 0 { l.worker_max_rounds = n as usize; }
            }
            // Nought legs IS a choice, so this one is taken as written.
            if let Some(n) = crate::llm::extract_json_number(text, "worker_continuations") {
                l.worker_continuations = n as usize;
            }
            if let Some(n) = crate::llm::extract_json_number(text, "worker_context_cap") {
                if n > 0 { l.worker_context_cap = n; }
            }
            if let Some(f) = crate::llm::extract_json_f64(text, "worker_keep") {
                if f > 0.0 { l.worker_keep = f; }
            }
            if let Some(f) = crate::llm::extract_json_f64(text, "worker_spend_usd") {
                if f > 0.0 { l.worker_spend_usd = f; }
            }
            // How long an in-turn gather waits.  A trial arm that wants to see a turn carry on
            // past a slow worker sets this low; nought is "absent", as everywhere above.
            if let Some(n) = crate::llm::extract_json_number(text, "gather_timeout_s") {
                if n > 0 { l.gather_timeout_s = n; }
            }
            // What an orphaned worker has left.  Nought is a choice here and not an absence:
            // "stop at the next seam" is the tightest arm of the measure, and a verifier's
            // break needs the other end of it -- see `dev/verify_spawn_gather.mjs`.
            if let Some(n) = crate::llm::extract_json_number(text, "orphan_grace_rounds") {
                l.orphan_grace_rounds = n as usize;
            }
            // A MEASURE UNDER TRIAL, which is a switch and not a figure -- so false is taken as
            // written, exactly as `retire_prior` is, and the arm that turns the measure OFF is
            // as reachable as the one that turns it on.
            if let Some(b) = crate::llm::extract_json_bool(text, "compound") {
                l.compound = b;
            }
            // THE NEVER-FORGET FILE SET'S OWN SWITCHES, each independent so a measurement or a
            // verifier can turn off exactly one mechanism. See `compact::Limits` for what each
            // does; `"standing"` is the name `dev/tune/arms.json`'s `nofiles` arm sets.
            if let Some(b) = crate::llm::extract_json_bool(text, "standing") {
                l.standing_files = b;
            }
            if let Some(b) = crate::llm::extract_json_bool(text, "briefing_top3") {
                l.briefing_top3 = b;
            }
            if let Some(b) = crate::llm::extract_json_bool(text, "task_log") {
                l.task_log = b;
            }
            if let Some(b) = crate::llm::extract_json_bool(text, "tail_note") {
                l.tail_note = b;
            }
            // Which shape the compactor is asked for. A spelling this build does not know is
            // IGNORED rather than defaulted, so an arm with a typo in it stays on whatever the
            // engine had and `turn_limits` reports it -- a silent fall back to the default is
            // how a measurement ends up being about the wrong engine.
            if let Some(w) = crate::llm::extract_json_string(text, "fold_shape") {
                if let Some(sh) = compact::FoldShape::from_wire(&w) {
                    l.fold_shape = sh;
                }
            }
            // The `batchline_off` arm's whole content: on by default, so a trial that wants to
            // measure the sentence's own worth turns it off rather than the engine growing a
            // second untested path.
            if let Some(b) = crate::llm::extract_json_bool(text, "batch_line") {
                l.batch_line = b;
            }
            // HOW MUCH THE MODEL THINKS FIRST, and how deeply.  A spelling this build does not
            // know is ignored rather than defaulted, for `fold_shape`'s reason above: an arm
            // with a typo in it must stay on whatever the engine had and be reported doing so.
            // Only the Anthropic dialect carries either -- see `LlmClient::set_thinking` --
            // which is why the `think_*` arms are paired with the direct provider.
            if let Some(w) = crate::llm::extract_json_string(text, "thinking") {
                if let Some(t) = crate::llm::Thinking::from_wire(&w) {
                    l.thinking = t;
                }
            }
            if let Some(w) = crate::llm::extract_json_string(text, "effort") {
                if let Some(e) = crate::llm::Effort::from_wire(&w) {
                    l.effort = e;
                }
            }
            // HOW LONG A STREAM MAY GO QUIET before the round is read as stalled rather than
            // slow; see `LlmClient::stream_idle_ms`. Nought is "absent", as the figures above.
            if let Some(n) = crate::llm::extract_json_number(text, "stream_idle_ms") {
                if n > 0 { l.stream_idle_ms = n; }
            }
        }
        self.hold_worker();
        // The client builds the wire, so the setting has to reach it; `Limits` alone would be
        // a figure `turn_limits` reports and no request carries.
        self.push_thinking();
        self.push_stream_idle();
        Ok(())
    }

    /// Ask this agent's model to think, or not, and how deeply.
    ///
    /// Separate from [`Agent::set_tune`] because the per-family default is applied from the
    /// model rather than from a tune string; see `profile::Family::thinking_default`.
    ///
    /// # Arguments
    /// * `thinking` - Adaptive, or off where the model and the effort allow it.
    /// * `effort` - `output_config.effort`; `High` is the API's own default.
    pub fn set_thinking(&self, thinking: crate::llm::Thinking, effort: crate::llm::Effort) {
        {
            let mut l = self.limits.borrow_mut();
            l.thinking = thinking;
            l.effort   = effort;
        }
        self.push_thinking();
    }

    /// Hand the thinking setting to the client, where the request body is built.
    fn push_thinking(&self) {
        let l = self.limits.borrow();
        self.llm.set_thinking(l.thinking, l.effort);
    }

    /// Move the idle-stream ceiling for this agent's turns.
    ///
    /// A stream that goes this long without a byte is read as stalled rather than slow, and
    /// the round ends on whatever it had accumulated instead of waiting on a dead connection
    /// further; see `DEFAULT_STREAM_IDLE_MS` in `src/llm.rs`.  Zero restores the shipped
    /// default, exactly as `set_context_cap` does.
    ///
    /// # Arguments
    /// * `ms` - The ceiling in milliseconds; zero restores the default.
    pub fn set_stream_idle_ms(&self, ms: u64) {
        {
            let mut l = self.limits.borrow_mut();
            l.stream_idle_ms = if ms == 0 { crate::llm::DEFAULT_STREAM_IDLE_MS } else { ms };
        }
        self.push_stream_idle();
    }

    /// Hand the idle-stream ceiling to the client, where the stream is actually read.
    fn push_stream_idle(&self) {
        let l = self.limits.borrow();
        self.llm.set_stream_idle_ms(l.stream_idle_ms);
    }

    /// Set which upstream providers OpenRouter should try for this agent's model, from the
    /// setting on its own row (`www/js/models.js`).  Inert against a direct provider; see
    /// `LlmClient::set_provider_routing`.
    ///
    /// # Arguments
    /// * `order` - Comma-separated provider names to try first, in that order.
    /// * `ignore` - Comma-separated provider names never to route to.
    /// * `only` - Refuse every provider but `order` rather than falling back past it.
    pub fn set_provider_routing(&self, order: &str, ignore: &str, only: bool) {
        self.llm.set_provider_routing(order, ignore, only);
    }

    /// Re-assert the worker ceiling after a setting has been written.
    ///
    /// Nothing on a chat's agent: `hold_to_worker` has never been called, so the mark is off and
    /// this is a borrow and a branch.
    fn hold_worker(&self) {
        let mut l = self.limits.borrow_mut();
        if l.worker {
            l.hold_to_worker();
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

    /// Where the last turn's own messages start in the session it was run against.
    ///
    /// Valid AFTER `run_turn` returns, and only as an index into the session that turn was given:
    /// the user's sentence and everything the turn appended come from here to the end.  Read this
    /// rather than the length the session had before the turn -- a fold during the turn replaces
    /// the folded prefix with one notice, so a length taken before it reaches past the end of the
    /// list, and a slice at it panics.  Where the fold cut into the turn's own messages the answer
    /// is 1, the message after the notice, and what the notice absorbed is in its own ledger.
    pub fn turn_start(&self) -> usize {
        self.turn_start.get()
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
        // Including the thinking setting, which lives on the CLIENT as well: an agent built
        // fresh from a chat's client holds that client's tune already, but one whose client
        // was constructed separately would otherwise fold and answer at a different depth
        // from the chat it was adopted from.
        self.push_thinking();
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
        // WHAT COUNTS AS PRIOR, for a fold with no turn behind it.  The last thing the user said
        // is still the boundary: a reader pressing Fold has just been answered and may ask about
        // that answer next, so the newest turn keeps its results and everything older is retired.
        let keep = self.limits.borrow().retire_keep_turns;
        self.prior_end.set(compact::prior_end(&session.messages, keep));
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

    /// Say which Diamond this turn is steering, so a fold can file its notes into its files.
    ///
    /// Empty -- the default -- is a chat, which has no Diamond and no files, and whose fold
    /// therefore leaves a notice exactly as it always did.
    ///
    /// # Arguments
    /// * `id` - The Diamond, as `diamonds/<id>/` spells it.
    pub fn set_diamond(&self, id: &str) {
        *self.diamond.borrow_mut() = id.to_string();
    }

    /// Which Diamond this turn is steering, or empty.
    pub fn diamond(&self) -> String {
        self.diamond.borrow().clone()
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

    /// Say that whatever dispatched this agent has ended, so nothing is waiting for its report.
    ///
    /// **The bound it arms is on ROUNDS and not on the clock**, which is what makes it safe to
    /// arm from outside a running turn: a request already in flight is never torn up, the round
    /// that is running finishes and is paid for, and the turn stops at the next seam once the
    /// grace is used.  See [`compact::ORPHAN_GRACE_ROUNDS`] for the figure and why a worker
    /// nobody is waiting for is not owed the whole ceiling.
    ///
    /// Idempotent: a second call says the same thing, and the grace is counted from the first
    /// round that read the flag rather than from the call.
    ///
    /// **It is never cleared, and that is what lets it be armed EARLY.**  A worker still in the
    /// queue when its dispatcher ends has no turn to interrupt, so the page arms the flag on its
    /// app and the bound applies from its first seam.  A turn that reset it would undo exactly
    /// that.  Nothing carries into work the user later resumes: `Workers.start` builds a fresh
    /// `DaimondApp` for every session, so a resumed worker is a fresh agent with the flag unset.
    pub fn orphan(&self) {
        self.orphaned.set(true);
    }

    /// Has the turn in flight been orphaned?
    pub fn is_orphaned(&self) -> bool {
        self.orphaned.get()
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
            let names = registry.tool_names();
            // ONE SENTENCE, AND ONLY WHERE THE TOOL IS THERE. A model reaches for the shape it
            // has been shown, and `compound` is the one tool whose whole value is that it
            // replaces a habit -- reading one file per round -- rather than adding a capability.
            // It goes here rather than in `DEFAULT_DAIMON`, which the user may rewrite: a
            // briefing line about a tool is a fact about the belt and not a preference.
            let several = match names.iter().any(|n| n == "compound") {
                true  => " For several reads that go together -- list a folder, then read what \
                          you found in it -- use compound and get them all in one call.",
                false => "",
            };
            let mut t = fmt!(
                "You have exactly these tools, all scoped to the user's \
                 workspace: {}. Use them to inspect and change the workspace \
                 when completing a task. You have no other tools; never claim \
                 to have performed an action you had no tool to perform.{}",
                names.join(", "), several);
            // TWO SENTENCES, on by default, and both true of what `batch::batches` actually does
            // -- see the note there. The old one sentence ("Independent calls go in ONE reply;
            // they run together") was not: everything in a reply runs in the model's OWN order,
            // and only a read beside another read runs at the same time as it, so a model that
            // believed "together" meant "at once, in any order" had no way to learn from the
            // wording that an edit and the read or test that checks it belong in that same
            // reply -- the sentence that would have told it so was the one place this was hidden.
            if self.limits.borrow().batch_line {
                t.push_str(" Calls in one reply run in the order you give them; only reads run \
                    side by side within that order. So an edit and the read or test that checks \
                    it can go in the same reply -- the edit still finishes first.");
            }
            // ONE SENTENCE, AND ONLY WHERE THE TOOL IS THERE, same rule as `compound` above.
            // The rounds census habit this replaces is a page-at-a-time read of one import after
            // another once a task has named where the work is; `file_read`'s own description
            // says the same thing for a reader who has not seen this sentence.
            if names.iter().any(|n| n == "file_read") {
                t.push_str(" When a task names a file or folder, read it whole in one file_read \
                    -- \"path\":\"src/*.js\" or \"paths\":[..] -- before following its imports \
                    one at a time.");
            }
            t
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
        registry.begin_turn();
        // AND THE TUNED GATHER CEILING GOES WITH IT.  `gather` is a tool and cannot see `Limits`;
        // this is the one place a turn begins, so it is where the figure is handed over.
        registry.ctx.set_gather_timeout_s(self.limits.borrow().gather_timeout_s);
        // AND THE MEASURE UNDER TRIAL, handed over at the same seam and for the same reason:
        // `offered` decides the schema array synchronously, once a round, and cannot see
        // `Limits`. Written every turn rather than once, so an arm that changes it between two
        // turns of one conversation is obeyed by the second of them.
        registry.ctx.set_compound(self.limits.borrow().compound);
        // THIS TURN'S OWN MESSAGES BEGIN WITH THE SENTENCE ABOUT TO BE PUSHED, and the index is
        // recorded on the agent rather than left to the caller, because a fold later in the turn
        // moves it; see `Agent::turn_start`.
        self.turn_start.set(session.messages.len());
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
        // RETIRED ON THE WAY OUT, and this is the seam.  Everything before the sentence just
        // pushed belongs to a turn that has ENDED: its tool results have been read and acted on,
        // and its file writes are on disk.  Carried whole they are re-sent on every one of this
        // turn's rounds -- a hundred and fifty of them, at the cached-input rate, which is how a
        // turn came to cost five dollars without any single request ever being too big.
        //
        // On the COPY, never on `session.messages`: the owner's ruling is that the model gets the
        // shortened version and his transcript keeps every word.  See `compact::retire_upto` and
        // the note at the elision in `fold_if_needed`, which is the same rule at a later seam.
        //
        // The boundary is recorded because a fold may rebuild `working` from the session later in
        // the turn, and that rebuild has to retire the same prefix rather than work it out again
        // from a conversation an interjection has since added a user message to.
        //
        // AND THE LAST FEW TURNS ARE LEFT OUT OF IT.  The boundary is not the sentence just
        // pushed but `retire_keep_turns` turns before it: on a short chat the model is still
        // reading the turn it has just finished, and handing it a stub of that made it ask for
        // the content again -- see `compact::RETIRE_KEEP_TURNS` for the trial.
        let keep = self.limits.borrow().retire_keep_turns;
        self.prior_end.set(compact::prior_end(&session.messages, keep));
        let mut prior = session.messages.clone();
        // Under a switch, so the measure can be turned off and its worth measured rather than
        // asserted -- see `Agent::set_tune`. On by default, which is what shipped.
        if self.limits.borrow().retire_prior {
            compact::retire_upto(&mut prior, self.prior_end.get());
        }
        working.extend(prior);

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
                    if resp.prompt_tokens > 0 {
                        session.last_prompt_tokens = resp.prompt_tokens;
                        self.live_last_prompt.set(resp.prompt_tokens);
                    }
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

    /// A `recall` result with what this conversation folded away in front of it.
    ///
    /// Everything but `recall` comes back untouched, and cheaply: the name is compared before
    /// anything is read.  The fold half is prepended rather than appended because what a fold
    /// replaced is older than the crystal's standing record and reads as the answer to "did we
    /// discuss this"; the crystal is the answer to "was it written down".
    ///
    /// The pattern is compiled by the SAME function the tool half uses, so the two halves of one
    /// answer cannot disagree about what the query meant.  A query the matcher cannot compile has
    /// already been refused by the tool half, which is why a failure here is silent: the result
    /// being prepended to is the refusal.
    ///
    /// # Arguments
    /// * `session` - The conversation, whose fold notices are what is searched.
    /// * `tc` - The call, for its name and its arguments.
    /// * `result` - What the tool half answered.
    fn with_folds(
        &self,
        session: &Session,
        tc:      &crate::protocol::ToolCall,
        result:  MessageContent,
    )
        -> MessageContent
    {
        if tc.name != crate::tools::Tool::Recall.name() {
            return result;
        }
        let q = match crate::tools::recall_query(&tc.arguments) {
            Ok(q)  => q,
            Err(_) => return result,
        };
        let lines = compact::recall_folds(
            &session.messages, &mut |l: &str| q.matches(l), q.before, q.after, q.limit);
        let head = if lines.is_empty() {
            fmt!("[recall] Nothing this conversation has folded away matches.\n\n")
        } else {
            fmt!("{}\n\n[recall] {} line(s) from {} fold(s) of this conversation.\n\n",
                lines.join("\n"), lines.len(),
                session.messages.iter().filter(|m| matches!(m,
                    ChatMessage::User { content }
                        if content.as_text().starts_with("[Daimond folded the earlier part")))
                    .count())
        };
        MessageContent::text(fmt!("{}{}", head, result.as_text()))
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
        // EVERY FAILED CALL THIS TURN HAS ALREADY MADE, by the hash of its name and arguments.
        //
        // A model that sends the same malformed call again after being told exactly what is
        // wrong with it will send it a third time and a twentieth: Kimi did so twenty times in
        // one turn on the bank, against a refusal that named the keys it had sent, and nothing
        // in the loop could tell the difference between that and progress. So the answer says
        // the count, and then the turn ends -- because a turn that cannot be told it is stuck
        // spends its whole round budget being stuck.
        let mut repeats: Vec<(u64, u8)> = Vec::new();
        // Set when a call has been refused the same way once too often; the turn ends on it at
        // the end of the round, so every call of the round still gets its result.
        let mut stuck: Option<String> = None;
        // WHERE EACH ROUND STARTED IN `working`, so "three rounds old" is a position rather than a
        // guess.  Cleared whenever a fold rebuilds the list, because a fold moves every index in
        // it and a stale mark would retire the wrong messages -- the newest ones.
        let mut round_at: Vec<usize> = Vec::new();
        // ROUNDS IN THIS LEG, which is not `rounds`.  A turn reaching the cap now takes its own
        // Continue -- see `compact::MAX_CONTINUATIONS` -- so the turn is made of up to four legs
        // of `max_rounds` each, and it is the LEG that the cap measures while `rounds` goes on
        // counting the whole turn for the audit, the note and the feed.
        let mut leg = 0usize;
        let mut continuations = 0usize;
        // CONSECUTIVE ROUNDS WHOSE TOOL CALL ARRIVED AS TEXT.  Reset by any round that comes
        // back properly, so a model that leaks once, is nudged and then behaves is not held
        // against a fault it has already corrected; two in a row is the model unable to emit a
        // call at all, and the turn ends on it rather than nudging round after round at the
        // user's expense.
        let mut leaks = 0usize;
        // CONSECUTIVE ROUNDS WHOSE REPLY CARRIED REASONING AND NOTHING ELSE -- no content, no
        // tool call.  Bounded at one nudge the same way `leaks` is; see the note where it is
        // read, in the empty-reply arm below.
        let mut reasoned_only = 0usize;
        // WHETHER THIS TURN HAS ALREADY BEEN ASKED TO WRITE ITS REPORT.  A worker that did its
        // work through tools and then ended with an EMPTY final reply wrote no report at all, so
        // the fan-out reads its silence as "nothing found" and re-dispatches finished work.  It is
        // nudged ONCE to write the report, bounded the same way `leaks` and `reasoned_only` are: a
        // second empty round after being asked is not something a third sentence fixes.
        let mut report_nudged = false;
        // WHAT THE SESSION HAD SPENT BEFORE THIS TURN OPENED.  `session.cost_usd` is the whole
        // conversation's bill, and the ceiling is PER TURN -- measured against the session's total
        // it would end every turn of a long chat the moment the chat itself got expensive.
        let opening_cost = session.cost_usd;
        // THE ROUND THIS TURN WAS ORPHANED IN, or `None` while something is still waiting for it.
        // Read at the seam, so the grace is counted in rounds the model actually got to use --
        // see the seam below and `compact::ORPHAN_GRACE_ROUNDS`.
        let mut orphan_from: Option<usize> = None;
        loop {
            // THE CAP IS MET AT THE TOP OF A ROUND and not after the loop, because what happens
            // there is no longer one thing: either the turn carries on into another leg or it
            // ends, and both want the same forced fold in front of them.
            if leg == max_rounds {
                if let Some(out) = self.at_the_cap(
                    session, &mut working, &mut round_at, schema, registry, &claims,
                    rounds, max_rounds, &mut continuations, opening_cost, on_event).await
                {
                    return out;
                }
                leg = 0;
                continue;
            }
            leg += 1;
            rounds += 1;
            // Fold before the request rather than after the refusal. Checked every round,
            // because a single turn of fifty file reads can outgrow the window on its own,
            // without any earlier turn being large at all.
            if self.fold_if_needed(session, &mut working, schema, Fold::IfNeeded, on_event).await {
                round_at.clear();
            }
            round_at.push(working.len());
            // THE WRITE BODIES THIS TURN HAS ALREADY FINISHED WITH.  A `file_write` carries the
            // whole of a file in its ARGUMENTS, and nothing aged them: `elide_bulk` clips a tool
            // RESULT and leaves `tool_calls` untouched, so a turn that wrote twenty files carried
            // twenty files in every round after the last of them.  The result has come back, so
            // the write has happened and the file can be read again.
            //
            // In batches rather than every round; see `compact::IN_TURN_RETIRE_EVERY`.
            //
            // THE FOUR FIGURES ARE READ OFF `Limits`, not off the constants they default to, so
            // that `Agent::set_tune` can move them and a measurement can have an arm with the
            // sweeps effectively off. Lifted out of the borrow in one go: the loop awaits below,
            // and a `RefCell` borrow held across an await is a panic waiting for a second caller.
            // A sweep cadence of zero would be a modulo by zero, so the floor is one round.
            let (written_age, result_age, result_cap, sweep_every) = {
                let l = self.limits.borrow();
                (l.written_age, l.result_age, l.result_cap, l.sweep_every.max(1))
            };
            let swept = round_at.len();
            if swept > written_age && swept % sweep_every == 0 {
                let horizon = round_at[swept - 1 - written_age];
                compact::retire_written(&mut working, horizon);
            }
            // AND THE RESULTS THE TURN HAS FINISHED READING, which is where the bytes actually are.
            // The write bodies above are the dearest thing in a long turn AFTER the results, and
            // the results were carried whole to the end of it: a turn that read twenty files
            // re-sent all twenty on every round after the last of them, which is how a prompt
            // settles at 77.5K and stays there for eighty-five rounds.
            //
            // A longer horizon than the bodies get, and the same batch: see
            // `compact::IN_TURN_RESULT_AGE` for why sixteen rounds rather than three, and
            // `compact::IN_TURN_RETIRE_EVERY` for why both run every tenth round rather than every
            // round. One cache miss for the pair of them.
            if swept > result_age && swept % sweep_every == 0 {
                let horizon = round_at[swept - 1 - result_age];
                compact::retire_results(&mut working, horizon, result_cap);
            }
            let mut sent = compact::conversation_bytes(&working, &self.llm.open_folds());

            // Stream this round's assistant text as it arrives; the tool
            // calls (if any) are returned assembled once the round ends.
            let mut refolded = false;
            // What this endpoint would take BEFORE the request goes out. Only a refusal can
            // change it and it changes it exactly once, so sampling either side of the round is
            // the whole of the learned signal -- no counter and no flag of our own.
            let could_see = self.llm.can_take_images();
            let mut resp = loop {
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
            // CANONICALISED HERE, ONCE, before the round's calls are stored or dispatched.  A
            // Claude-family model with the alias switch on may write `Read` where every other
            // build says `file_read`; rewriting the wire name back to Daimond's own, in place,
            // before it is cloned into the session, is what lets `call_label`, the feed and the
            // ledger go on reading `tc.name` directly and never learn a second spelling exists.
            // See `crate::profile::Family::tool_alias` for the table and `Tool::from_name` for
            // the both-ways lookup this reads.
            for tc in resp.tool_calls.iter_mut() {
                if let Some(t) = crate::tools::Tool::from_name(&tc.name) {
                    tc.name = t.name().to_string();
                }
            }
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
            if resp.prompt_tokens > 0 {
                session.last_prompt_tokens = resp.prompt_tokens;
                self.live_last_prompt.set(resp.prompt_tokens);
            }
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
            // THE ROUND'S OWN TRACE FACTS, unconditionally: see `AgentEvent::RoundMeta` for
            // why a round that answered nothing is exactly the one this has to reach.
            if !resp.gen_id.is_empty() || !resp.finish_reason.is_empty() || resp.stalled {
                on_event(AgentEvent::RoundMeta {
                    gen_id:               resp.gen_id.clone(),
                    finish_reason:        resp.finish_reason.clone(),
                    native_finish_reason: resp.native_finish_reason.clone(),
                    provider:             resp.provider.clone(),
                    stalled:              resp.stalled,
                });
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

            // A TOOL CALL THAT ARRIVED AS PROSE, which until 2026-09-14 ended the turn as an
            // answer.  glm-5.3 put its own native call syntax in `content` with no JSON
            // `tool_calls` beside it; `resp.tool_calls` was empty, so the branch below read a
            // final answer, `audit` recorded `calls: 0`, and the page drew the markup with its
            // tags stripped out -- `namedaimonfoldtimeout_ms600000worldtrue` -- as the reply.
            // Thirty-nine seconds and US$0.16 for a round in which nothing ran and nothing
            // warned.
            //
            // A WHOLE CALL IS RECOVERED RATHER THAN REFUSED.  `ChatOnceResponse::classified`
            // has already rebuilt it and put it in `tool_calls`, so the turn simply carries on
            // -- but the event still goes out, because a provider getting the wire wrong is
            // worth measuring whether or not this app could paper over it.
            if let crate::llm::ReplyShape::Malformed(leak) = resp.shape.clone() {
                let recovered = leak.recovered.is_some();
                on_event(AgentEvent::Leaked { fragment: leak.fragment.clone(), recovered });
                if recovered {
                    leaks = 0;
                } else {
                    leaks += 1;
                    claims.malformed += 1;
                    // VERBATIM, in both places.  The fragment is the only evidence of what the
                    // model tried to call, and a reply the app had tidied would leave the next
                    // reader with the app's account of the fault instead of the fault.
                    let said = ChatMessage::Assistant {
                        content:    MessageContent::text(resp.content.clone()),
                        tool_calls: Vec::new(),
                    };
                    working.push(said.clone());
                    session.messages.push(said);
                    if leaks == 1 {
                        // ONE NUDGE, then the turn ends under its own word.  The model is told
                        // what arrived and what to do about it, in the family's own words where
                        // the family has earned any; a second leak after that is not something
                        // another sentence will fix.
                        let nudge = leak_nudge(&self.llm.model);
                        working.push(ChatMessage::user(nudge.clone()));
                        session.messages.push(ChatMessage::user(nudge));
                        continue;
                    }
                    let ending = self.audit(
                        TurnEnd::Malformed, rounds, &claims, Some(registry)).await;
                    self.ended(ending, on_event);
                    on_event(AgentEvent::Done);
                    return Ok(());
                }
            } else {
                leaks = 0;
            }

            if resp.tool_calls.is_empty() {
                let empty_reply = resp.content.trim().is_empty();
                // A TOOL-USING WORKER THAT ENDED WITH AN EMPTY FINAL REPLY.  It did the work --
                // `claims.calls` is non-empty -- and then said nothing, so no report is written;
                // the fan-out that dispatched it reads that silence as "nothing found" and
                // re-dispatches FINISHED work (the `Silent` note used to invite exactly that:
                // "ask again with a narrower task").  Nudge it ONCE to write its report, ahead of
                // the reasoned-only arm because a worker that DID something should be told to
                // report it, not merely to "finish the thought".  Bounded at one, like `leaks`
                // and `reasoned_only`: a second empty round after being asked ends the turn on its
                // own word (Silent/ReasonedOnly below), now carrying `calls > 0` so the note names
                // the work rather than inviting a re-dispatch.
                if empty_reply && !report_nudged && !claims.calls.is_empty() {
                    report_nudged = true;
                    let said = ChatMessage::Assistant {
                        content:    MessageContent::text(crate::llm::seamed(resp.content.clone())),
                        tool_calls: Vec::new(),
                    };
                    working.push(said.clone());
                    session.messages.push(said);
                    let nudge = report_nudge();
                    working.push(ChatMessage::user(nudge.clone()));
                    session.messages.push(ChatMessage::user(nudge));
                    continue;
                }
                // THE MODEL REASONED AND THEN SAID NOTHING.  Found by proposal 15's naive
                // drive on 2026-09-15: a round returned 3,372 tokens on `resp.thinking` and
                // an empty `content`, ending mid-sentence, with no tool call either.  This
                // engine took that for a plain empty answer -- `TurnEnd::Silent` below -- and
                // the turn was booked a success: 318 s and US$0.10 for nothing.
                //
                // ONE NUDGE, then the turn ends under its own word, exactly as a leaked tool
                // call is handled above and for the same reason `leaks` there is bounded: a
                // model that reasoned for the whole round and wrote nothing is told once to
                // finish the thought, and `reasoned_only > 0` catches the round after that
                // whether or not IT carried reasoning too -- a second empty round is not
                // something a third sentence will fix, whatever produced it.
                if empty_reply && (reasoned_only > 0 || !resp.thinking.trim().is_empty()) {
                    reasoned_only += 1;
                    claims.reasoned += 1;
                    let said = ChatMessage::Assistant {
                        content:    MessageContent::text(crate::llm::seamed(resp.content.clone())),
                        tool_calls: Vec::new(),
                    };
                    working.push(said.clone());
                    session.messages.push(said);
                    if reasoned_only == 1 {
                        let nudge = reasoned_only_nudge();
                        working.push(ChatMessage::user(nudge.clone()));
                        session.messages.push(ChatMessage::user(nudge));
                        continue;
                    }
                    // A ROUND EMPTY AGAIN AFTER THE NUDGE IS HONEST ABOUT WHY: `Silent` is a
                    // reply with nothing in it and no explanation; `ReasonedOnly` is a model
                    // that reasoned, was told to answer or call a tool, and still did neither --
                    // a different fault with a different remedy, and one nobody could see on
                    // the wire until now.
                    let ending = self.audit(
                        TurnEnd::ReasonedOnly, rounds, &claims, Some(registry)).await;
                    self.ended(ending, on_event);
                    on_event(AgentEvent::Done);
                    return Ok(());
                }
                // Final answer — its text has already streamed via the
                // token callback, so it is not re-emitted here.
                //
                // A final message with nothing in it is the ending the user met: the spinner
                // clears, the screen does not change, and a finished turn is indistinguishable
                // from a hung one. The streaming path has said so since it was found; here the
                // ending names it, which costs nothing and is the same fact.
                let how = if empty_reply { TurnEnd::Silent } else { TurnEnd::Answered };
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
                    // `recall` HAS TWO HALVES AND ONLY ONE OF THEM IS A TOOL'S.  The crystal
                    // half is answered by the registry like any other call; what this
                    // conversation FOLDED AWAY lives in its own messages, which no tool is ever
                    // handed. So the fold half is answered here, where the session is, and
                    // prepended to the result before anything downstream sees it -- the
                    // announce, the claims, the event and the stored reply are all built from
                    // this one value, so the pairing flow is untouched.
                    let result = self.with_folds(session, tc, result);
                    // Mutable because the repeat counter below may add a line to it; see
                    // `stuck_said`.
                    let mut text = result.as_text().into_owned();
                    let outcome = crate::tools::call_outcome(&text);
                    // THE SAME CALL, REFUSED THE SAME WAY, COUNTED.  Only a call that FAILED is
                    // counted: reading one file twice is ordinary, and a turn that verifies its
                    // own work makes the same successful call on purpose.
                    if !matches!(outcome, crate::tools::CallOutcome::Done) {
                        let key = call_fingerprint(&tc.name, &tc.arguments);
                        let n = match repeats.iter_mut().find(|(k, _)| *k == key) {
                            Some(slot) => { slot.1 = slot.1.saturating_add(1); slot.1 },
                            None       => { repeats.push((key, 1)); 1 },
                        };
                        if n >= STUCK_WARNS {
                            text.push_str(&fmt!("\n{}", stuck_said(n)));
                        }
                        if n >= STUCK_ENDS_TURN {
                            stuck = Some(stuck_said(n));
                        }
                    }
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
                        result: text.clone(),
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
                    // The stuck note goes to the MODEL as well as to the screen, which is the
                    // whole point of it: `text` is the result plus that line, and a plain result
                    // is byte for byte what it always was.
                    let result = if text.len() != result.text_len() && !result.has_image() {
                        MessageContent::text(text)
                    } else {
                        result
                    };
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

            // NOTHING IS WAITING FOR THIS TURN ANY MORE, and this is the seam where that
            // becomes a bound.  The page arms it when the turn that dispatched this worker ends
            // (`Workers.releaseTurn` -> `DaimondApp::orphan_worker`), which is always mid-flight:
            // the worker is several rounds in by then.  Here rather than inside the round, so
            // the request that is running is never torn up and every call of this round has its
            // result -- the same rule the spend ceiling below follows.
            //
            // Told first, stopped afterwards.  See `compact::ORPHAN_GRACE_ROUNDS` for why a
            // worker nobody is holding a promise on is not owed the two hundred rounds its
            // preset allows, and `compact::orphan_note` for why it is told the figure.
            if self.orphaned.get() {
                let grace = self.limits.borrow().orphan_grace_rounds;
                let armed = *orphan_from.get_or_insert(rounds);
                if rounds.saturating_sub(armed) >= grace {
                    self.stop_on_orphan(session, rounds, grace, &claims, registry, on_event).await;
                    return Ok(());
                }
                // Once, in the round it was orphaned in: a standing sentence re-sent every round
                // after it would be read as the app nagging rather than as a boundary moving.
                if armed == rounds {
                    let msg = compact::orphan_note(grace);
                    working.push(msg.clone());
                    session.messages.push(msg);
                }
            }

            // A TURN THAT CANNOT BE TOLD IT IS STUCK IS ENDED.  At the seam rather than inside
            // the round, so every call the model made this round still gets its own result and
            // the conversation is well formed. The sentence is the assistant's last word, the way
            // a spend ceiling's is.
            if let Some(said) = stuck.take() {
                let msg = ChatMessage::assistant(said.clone());
                working.push(msg.clone());
                session.messages.push(msg);
                on_event(AgentEvent::Text(said));
                let ending = self.audit(TurnEnd::Failed, rounds, &claims, Some(registry)).await;
                self.ended(ending, on_event);
                on_event(AgentEvent::Done);
                return Ok(());
            }

            // AND THE SEAM IS WHERE THE MONEY IS CHECKED.  The round's cost has just been added
            // and the next request has not gone out, so this is the last moment a ceiling can stop
            // the turn without paying for another round first.
            if let Some((spent, cap)) = self.over_the_spend_cap(session, opening_cost, registry) {
                self.stop_on_spend(session, spent, cap, rounds, &claims, registry, on_event).await;
                return Ok(());
            }

            // AND THE MODEL IS TOLD WHAT IS LEFT OF IT, because a turn that hits a ceiling stops in
            // the middle of the work and nothing could see it coming: a model cannot count its own
            // rounds and cannot see the bill.  Told the figures, it can report what it has rather
            // than be cut off mid-file.
            //
            // In the LAST TOOL RESULT and never in the system prompt: that prompt is the cached
            // prefix, and a figure that moves every tenth round would cost the whole standing
            // context at the full input rate on every round after it moved.  See
            // `compact::note_budget`.  On the sweeps' own cadence, so the round that rewrites old
            // messages is the round that rewrites this one.
            if swept % sweep_every == 0 {
                let (rounds_left, usd_left) = {
                    let l = self.limits.borrow();
                    let legs = l.max_continuations.saturating_sub(continuations);
                    let left = (max_rounds.saturating_sub(leg)) + legs * max_rounds;
                    // NOTHING IS SAID ABOUT MONEY WHERE NONE IS REPORTED, for the reason
                    // `over_the_spend_cap` does not enforce a ceiling there: several endpoints put
                    // no cost in the response and a local model has none, so a figure would be a
                    // claim about a price nobody quoted.
                    // The workers' share too, so the figure the model reads is the one the
                    // ceiling is about to be judged on -- see `over_the_spend_cap`.
                    let spent = (session.cost_usd - opening_cost) + registry.ctx.worker_usd();
                    let usd = if l.spend_cap_usd > 0.0 && spent > 0.0 {
                        Some(l.spend_cap_usd - spent)
                    } else {
                        None
                    };
                    (left, usd)
                };
                compact::note_budget(&mut working, rounds_left, usd_left);
            }
        }
    }

    /// Has this turn spent past its ceiling, and if so by what?
    ///
    /// **A turn that reports no cost is never stopped by this**, and that is deliberate rather than
    /// an oversight: `cost_usd` is whatever the provider chose to put in the response, several
    /// endpoints put nothing there at all, and a local model costs nothing by definition.  A
    /// ceiling enforced on a figure of zero would either never fire or, if it were made to guess,
    /// end turns over a price nobody quoted.  The round count is the backstop for those.
    ///
    /// # Arguments
    /// * `opening_cost` - The session's bill before this turn opened, so the figure is the TURN's.
    fn over_the_spend_cap(
        &self,
        session:      &Session,
        opening_cost: f64,
        registry:     &ToolRegistry,
    )
        -> Option<(f64, f64)>
    {
        // WORKER SPEND COUNTS AGAINST THE TURN'S CEILING AND IS NOT ADDED TO THE SESSION'S BILL.
        // The ceiling is "what one turn may cost" -- a turn that can start eight workers of a
        // dollar each outside it has a thirteen-dollar ceiling in effect -- while `cost_usd` is
        // the provider's bill for THIS session, and a worker's own spend is booked separately by
        // the page when the worker finishes.  Adding it there would bill it twice.
        let spent = (session.cost_usd - opening_cost) + registry.ctx.worker_usd();
        if spent <= 0.0 {
            return None;
        }
        let cap = self.limits.borrow().spend_cap_usd;
        if cap > 0.0 && spent > cap { Some((spent, cap)) } else { None }
    }

    /// End the turn because it has spent its ceiling, saying both figures.
    ///
    /// Its own ending rather than [`TurnEnd::Capped`]: a user whose turn stopped on money and was
    /// told it had run out of rounds would raise the round limit, which is the one remedy that
    /// cannot work.
    async fn stop_on_spend(
        &self,
        session:    &mut Session,
        spent:      f64,
        cap:        f64,
        rounds:     usize,
        claims:     &Claims,
        registry:   &ToolRegistry,
        on_event:   &mut impl FnMut(AgentEvent),
    ) {
        let msg = fmt!("Stopped after spending US${:.2} of this turn's US${:.2} ceiling.",
            spent, cap);
        on_event(AgentEvent::Error(msg));
        session.messages.push(compact::spend_limit_note(spent, cap));
        let ending = self.audit(TurnEnd::SpendCapped, rounds, claims, Some(registry)).await;
        self.ended(ending, on_event);
        on_event(AgentEvent::Done);
    }

    /// End a turn nobody is waiting for, at the grace its orphaning allowed it.
    ///
    /// Shaped exactly like [`Agent::stop_on_spend`], and it ends as [`TurnEnd::Capped`] for the
    /// same reason that one ends as `SpendCapped`: a ceiling was met with work still going.
    /// Which ceiling is in the sentence and in the note, not in a further word of the ending
    /// vocabulary -- every reader of `TurnEnd::wire()` would have to learn a word to draw a
    /// distinction none of them acts on, and the browser's own `isTerminal` is the reader that
    /// would have gone wrong quietly.
    ///
    /// # Arguments
    /// * `rounds` - The whole turn's count, legs included.
    /// * `grace` - The ceiling it met; see [`compact::ORPHAN_GRACE_ROUNDS`].
    async fn stop_on_orphan(
        &self,
        session:    &mut Session,
        rounds:     usize,
        grace:      usize,
        claims:     &Claims,
        registry:   &ToolRegistry,
        on_event:   &mut impl FnMut(AgentEvent),
    ) {
        let msg = fmt!("Stopped after {} rounds: the turn that dispatched this worker ended, \
            and a worker nobody is waiting for runs on for {} more round(s).", rounds, grace);
        on_event(AgentEvent::Error(msg));
        session.messages.push(compact::orphan_limit_note(rounds, grace));
        let ending = self.audit(TurnEnd::Capped, rounds, claims, Some(registry)).await;
        self.ended(ending, on_event);
        on_event(AgentEvent::Done);
    }

    /// The tool-round cap has been met: either carry the turn on into another leg, or end it.
    ///
    /// `None` means carry on, and the caller resets its leg counter; `Some` is the turn's ending
    /// and is returned straight out of [`Agent::run_tool_loop`].
    ///
    /// **A fold runs either way, and this is the one place a fold pays for itself twice.**  A
    /// capped leg is by definition the longest this conversation has had -- a hundred and fifty
    /// rounds of tool calls -- and whatever happens next re-sends every one of them: another leg
    /// on each of its own hundred and fifty rounds, or the user's next turn on each of its.  One
    /// summary against a hundred and fifty carries of a log nobody is going to read again.
    ///
    /// `Fold::Capped` rather than `IfNeeded`: the estimate is precisely what did not fire for the
    /// whole of this leg -- the prompt sat just under the ceiling, which is how a turn reaches the
    /// round limit at all -- so a fold that waited for it would not happen here either.  And not
    /// `Refused`, because nothing was refused: see [`Fold::teaches_window`].
    ///
    /// **AND UNTIL 2026-09-13 IT FOLDED NOTHING IN THE ORDINARY CASE.**  `compact::tail_start`
    /// answers 0 whenever the WHOLE conversation fits the tail budget -- some 48,000 tokens at
    /// the 120K cap -- and a turn capped at ten rounds has not filled that.  So `cut` was 0, no
    /// summary was ever written, and the leg that continued started from the raw log with no
    /// plan in front of it: the paragraph above describes a fold that was not happening.  It is
    /// also why a fold fired ONCE in four hundred and twenty-two bank trials.
    /// `compact::capped_cut` is the answer at this one door, and it declines when there is
    /// genuinely nothing worth folding.
    ///
    /// # Arguments
    /// * `rounds` - The whole turn's count, legs included, not this leg's.
    /// * `continuations` - How many legs the turn has already taken; raised when it takes another.
    async fn at_the_cap(
        &self,
        session:        &mut Session,
        working:        &mut Vec<ChatMessage>,
        round_at:       &mut Vec<usize>,
        schema:         u64,
        registry:       &ToolRegistry,
        claims:         &Claims,
        rounds:         usize,
        max_rounds:     usize,
        continuations:  &mut usize,
        opening_cost:   f64,
        on_event:       &mut impl FnMut(AgentEvent),
    )
        -> Option<Outcome<()>>
    {
        self.fold_if_needed(session, working, schema, Fold::Capped, on_event).await;
        // THE FOLD MOVED EVERY INDEX IN `round_at`, which the next leg reads to decide what is old
        // enough to retire.  Cleared for the reason the in-loop fold clears it: a stale mark
        // retires the NEWEST messages, which is the worst thing it could do.
        round_at.clear();
        // AND THEN IT CARRIES ON, which is the whole of the owner's ruling of 2026-09-12.  The
        // user used to be handed a half-finished task and a Continue button, so a long job only
        // ran as fast as somebody was watching; the app takes that press itself now.
        //
        // AFTER the fold rather than before it, so the next leg runs on the summary the fold just
        // wrote rather than on the log it replaced.
        // AND THE MONEY IS CHECKED AGAIN HERE, after the fold rather than only at the seam before
        // it: the fold's summary is written by a MODEL, so the cap itself costs something, and a
        // turn that was a cent under the ceiling at the seam can be over it by the time the next
        // leg would start.  Checked before the continuation is granted, because granting one is
        // what commits the user to another `max_rounds` of spending.
        if let Some((spent, cap)) = self.over_the_spend_cap(session, opening_cost, registry) {
            self.stop_on_spend(session, spent, cap, rounds, claims, registry, on_event).await;
            return Some(Ok(()));
        }
        // THE FIGURE IS THE AGENT'S AND NOT THE CONSTANT, because a worker's is not a chat's: see
        // `compact::WORKER_CONTINUATIONS`.  A chat's is `compact::MAX_CONTINUATIONS` by default and
        // nothing else writes it, so this is the same three it has always been.
        let legs = self.limits.borrow().max_continuations;
        if *continuations < legs {
            *continuations += 1;
            // Said out loud rather than left to be read out of a round count nobody sees.  Not an
            // `Error`: nothing failed, and the turn is still running.
            on_event(AgentEvent::Continued { n: *continuations, rounds_so_far: rounds });
            // NOTHING IS WRITTEN INTO THE CONVERSATION.  The model never met this boundary, and a
            // note telling it that one was pushed back is a durable sentence about the app's own
            // bookkeeping -- re-sent on every round of every leg after it, and the one thing it
            // could plausibly provoke is the wrap-up the continuation exists to avoid.
            return None;
        }

        // Out of continuations, so the turn is over.
        //
        // Recorded in the SYSTEM voice, because that is whose it is. It used to be pushed
        // as an assistant message reading "[Reached the tool-call round limit (25).]", so
        // on the next turn the model read its own surrender back as something it had said
        // and behaved accordingly -- a turn that was stopped from outside became, in the
        // record, a turn that gave up. The boundary belongs to the app, so it is said in
        // the app's voice, and it says the work may be unfinished rather than that it is
        // over.
        //
        // It names the WHOLE turn's rounds and its continuations rather than `max_rounds` alone:
        // a reader told "150" after six hundred rounds of work has been handed the wrong figure,
        // and a model told it would reasonably expect another Continue to get further.
        let msg = fmt!("Reached the tool-call round limit ({} rounds: {} plus {} continuations).",
            rounds, max_rounds, continuations);
        on_event(AgentEvent::Error(msg.clone()));
        session.messages.push(compact::continuation_limit_note(rounds, *continuations));
        let ending = self.audit(TurnEnd::Capped, rounds, claims, Some(registry)).await;
        self.ended(ending, on_event);
        on_event(AgentEvent::Done);
        Some(Ok(()))
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
        let (budget, tail, model, shape) = {
            let l = self.limits.borrow();
            let cap = self.reply_cap();
            (l.budget(cap), l.tail_budget(cap), l.fold_model.clone(), l.fold_shape)
        };
        let before = compact::conversation_bytes(&session.messages, &open);
        // Size read two ways -- the up-front byte estimate and the provider's real prompt_tokens
        // from the last round -- because the estimate under-counts and can sit under budget while
        // the real carry has passed it. `last_prompt_tokens` refreshes after this round's own send,
        // so a fold prompted by it is corrected within the round and does not repeat once the carry
        // is back under. See `compact::needs_fold`.
        let est = self.gauge.tokens(compact::conversation_bytes(working, &open) + schema);
        if !compact::needs_fold(est, session.last_prompt_tokens, budget, why.forces()) {
            return false;
        }

        let mut folded  = 0usize;
        let mut trouble = String::new();
        // Whether the note came back in the layout, which the feed carries and the bank counts.
        let mut structured = false;
        // The hard ceiling is the budget itself: however few messages that leaves, a tail
        // bigger than what may be sent is a fold that changed nothing.
        let ceiling = self.gauge.bytes(budget).saturating_sub(schema);
        let mut cut = compact::tail_start(&session.messages, self.gauge.bytes(tail).min(ceiling),
            compact::MIN_KEEP_MESSAGES, ceiling, &open);
        // A FOLD AT THE ROUND LIMIT THAT FOLDS NOTHING IS THE COMMON CASE, not the rare one.
        // `tail_start` answers 0 whenever the whole conversation fits the tail budget, and a
        // turn stopped at ten rounds has not filled 48,000 tokens -- so the leg that continues
        // started from the raw log with no plan in front of it, and no summary was ever made.
        // That is why a fold fired once in four hundred and twenty-two bank trials.  At this one
        // door the question is different: the log is about to be re-sent on every round of the
        // next leg, so it is worth replacing with a note.  See `compact::capped_cut`, which
        // answers 0 when there is genuinely nothing worth folding.
        if cut == 0 && why.at_the_cap() {
            cut = compact::capped_cut(&session.messages, ceiling, &open);
        }
        if cut > 0 {
            // Built before the summarising call, so a call that fails still leaves a
            // truthful record: which files were read, which were written, what ran, and
            // which of those failed. That is the part no model is asked for and so no model
            // can lose.
            let ledger   = compact::ledger_of(&session.messages[..cut]);
            let rendered = compact::render_for_fold(&session.messages[..cut],
                compact::FOLD_INPUT_CAP);
            let raw = match self.summarise(&rendered, &model, session, why, shape).await {
                Ok(s)  => Ok(s),
                Err(e) => Err(fmt!("{}", e)),
            };
            // THE STRUCTURE IS WON OR LOST HERE AND THE FOLD IS NEITHER.  A reply that is not
            // the layout costs the structure and nothing else: the prose still becomes the
            // note, the ledger is still beneath it, and the turn never loses its fold to a
            // model that answered in paragraphs.
            let parsed = match &raw {
                Ok(text) => compact::parse_fold_notes(text)
                    .map(|n| compact::reconcile(n, &ledger)),
                Err(_) => None,
            };
            // FILED BEFORE THE NOTICE IS WRITTEN, because what it answers decides what the
            // notice says: the decisions and open threads leave the note only when they are
            // really in `DECISIONS.md` and `REQUIREMENTS.md`, and a write that failed must
            // leave the note exactly as long as it always was.  A chat has no Diamond and
            // files nothing.  See `dev/CRYSTAL_CONTRACT.md` §13.
            let filed = match &parsed {
                Some(n) => self.file_notes(n).await,
                None    => None,
            };
            let summary = match (filed, parsed, &raw) {
                (Some(left), _, _)   => compact::Summary::Filed(left),
                (None, Some(n), _)   => compact::Summary::Notes(n),
                (None, None, Ok(t))  => compact::Summary::Prose(t),
                (None, None, Err(e)) => compact::Summary::None(e),
            };
            structured = matches!(summary,
                compact::Summary::Notes(_) | compact::Summary::Filed(_));
            if let Err(ref e) = raw { trouble = e.clone(); }
            let note = compact::notice(cut, &summary, &ledger, why.at_the_cap());
            match compact::fold(&session.messages, cut, note) {
                Ok(new) => {
                    // A fold that made the conversation bigger is not a fold; it happens
                    // when the folded part was small and the note is not.
                    if compact::conversation_bytes(&new, &open) < before {
                        session.messages = new;
                        folded = cut;
                        // AND THE BOUNDARY COMES WITH IT. A fold renumbers the conversation, so
                        // the index recorded at the top of the turn now names a different message
                        // -- a later one, because the list got shorter, which is the turn in
                        // flight. See `compact::prior_end_after_fold`.
                        self.prior_end.set(compact::prior_end_after_fold(
                            self.prior_end.get(), cut));
                        // AND SO DOES THE TURN'S OWN START, by the same arithmetic: a caller
                        // that slices `session.messages[turn_start..]` after the turn must be
                        // handed an index into the list as it now is, not as it was.
                        self.turn_start.set(compact::prior_end_after_fold(
                            self.turn_start.get(), cut));
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
        // AND THE PRIOR TURNS STAY RETIRED.  `sent` is rebuilt from the whole record, so without
        // this a fold would hand the model back every byte `run_turn` had just retired -- and the
        // prompt it produced would be over the budget the fold was called to get under.
        //
        // The same switch the outbound seam is under, and it has to be the SAME switch: retiring
        // here while the turn did not would hand the fold a shorter history than the turn is
        // carrying, and a fold is the one place that difference becomes permanent.
        if self.limits.borrow().retire_prior {
            compact::retire_upto(&mut sent, self.prior_end.get().min(session.messages.len()));
        }
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
            structured,
        });
        true
    }

    /// File a fold's notes into this Diamond's three markdown files.
    ///
    /// `Some(left)` when they are really on disk, carrying whatever a ceiling refused so the
    /// notice can keep it; `None` when there is no Diamond to file into or a write failed, and
    /// then the notice carries everything exactly as it did before any of this existed.
    ///
    /// **The failure has to be the quiet one.**  A fold happens because a conversation no longer
    /// fits, and refusing to fold because a file could not be written would leave the turn dead
    /// with nothing sent; so a Diamond whose store is unwritable gets the long notice and the
    /// fold it needed, and the console says why.
    ///
    /// # Arguments
    /// * `notes` - The parsed notes, already reconciled against the ledger.
    #[cfg(target_arch = "wasm32")]
    async fn file_notes(&self, notes: &compact::FoldNotes) -> Option<compact::FoldNotes> {
        let id = self.diamond();
        if id.trim().is_empty() {
            return None;
        }
        crate::wasm::diamond::absorb_fold_notes(&id, notes).await
    }

    /// The same, off the browser, where there are no Diamonds and nothing to file into.
    ///
    /// A Diamond is browser storage -- `diamonds/<id>/` is OPFS and nothing else -- so the
    /// native build has no store to write to rather than a store it declines to write to.
    #[cfg(not(target_arch = "wasm32"))]
    async fn file_notes(&self, _notes: &compact::FoldNotes) -> Option<compact::FoldNotes> {
        None
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
    /// * `why` - What brought the fold about, which decides how the user message opens.
    /// * `shape` - Which layout the compactor is asked for, and therefore its output budget.
    async fn summarise(
        &self,
        rendered: &str,
        model:    &str,
        session:  &mut Session,
        why:      Fold,
        shape:    compact::FoldShape,
    )
        -> Outcome<String>
    {
        let mut llm = self.llm.clone();
        if !model.trim().is_empty() {
            llm.model = model.trim().to_string();
        }
        llm.max_tokens = shape.max_tokens();
        // THE SHAPE IS APPENDED OVER A USER-EDITED PROMPT, on the reducer's own reasoning
        // (`prompts::Role::compose_for`): the compactor's prompt is the user's to rewrite, and
        // what `compact::parse_fold_notes` then reads is not. A user who rewrote the job
        // description has not asked for a note nothing can parse.
        //
        // HERE rather than in `compose_for`, and the reason is in `FOLD_SHAPE_NOTE`'s own
        // doc: `fold_prompt` hands back the user's text verbatim by contract, and a prose
        // fold has to be able to run with nothing appended or the arm measuring whether the
        // structure pays for itself is comparing two prompts that both ask for headings.
        let mut system = self.fold_prompt();
        if matches!(shape, compact::FoldShape::Structured) {
            system.push_str("\n\n");
            system.push_str(crate::prompts::FOLD_SHAPE_NOTE);
        }
        // WHY THE FOLD IS HAPPENING CHANGES WHAT THE NOTE IS FOR, and only the capped one is a
        // different job: the turn CONTINUES from this note in the next round, so `## Next step`
        // is the plan it starts on rather than a remark about the future. The others are a
        // record for whatever comes next, which may be the user.
        let opening = if why.at_the_cap() {
            "The turn has hit its round limit and CONTINUES from your note in the next round. \
             Write `## Next step` as the plan it starts on."
        } else if matches!(why, Fold::ByHand) {
            "The user asked for this fold."
        } else {
            "Here is the earlier part of the conversation."
        };
        let msgs = vec![
            ChatMessage::system(system),
            ChatMessage::user(fmt!("{}\n\n{}", opening, rendered)),
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

/// How many identical failed calls a turn takes before the result says so.
const STUCK_WARNS: u8 = 3;

/// How many before the turn ends on it.
///
/// Five and not three, so a model that can recover is given two more rounds after being told.
const STUCK_ENDS_TURN: u8 = 5;

/// What a result says once the same call has failed the same way [`STUCK_WARNS`] times.
///
/// **Named because nothing else in the loop could see it.**  A refusal is information and a model
/// is entitled to read it and try again; what no refusal can convey is that this is the third
/// attempt, because each one arrives looking exactly like the first.  Kimi sent one malformed
/// `file_edit` twenty times in a single turn on the bank against a refusal that named the very
/// keys it had sent.  So the count is said out loud, and the last sentence says what happens next
/// -- a model cannot plan around a wall it cannot see.
fn stuck_said(n: u8) -> String {
    fmt!("This exact call has now failed {} times with the same answer. Change the call or \
        report what you cannot do; sending it again will end the turn.", n)
}

/// A call's identity, for counting repeats: its name and its arguments, verbatim.
///
/// FNV-1a over the two, rather than keeping the strings: a turn may make a hundred and fifty
/// rounds of calls whose arguments are whole files, and a table of them would be the largest
/// thing in the turn.  A collision costs a warning sentence on a call that did not earn one,
/// which is the cheapest possible way to be wrong here.
fn call_fingerprint(name: &str, args: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in name.as_bytes().iter().chain(b"\0").chain(args.as_bytes()) {
        h ^= *b as u64;
        h = h.wrapping_mul(0x1000_0000_01b3);
    }
    h
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
         than a whole file, so that no single call carries this much text. But if what was \
         cut is data you did not author -- a list, a download, the output of a command -- \
         do not type it at all: produce it with run on the machine (a redirection to a file \
         via sh -c) or fetch it to a file, and name the path. Chunking data through yourself \
         is never the answer.",
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

    // ── What bounds a worker's turn ─────────────────────────────────

    #[test]
    fn test_a_worker_keeps_its_ceiling_when_the_chats_settings_arrive_00() {
        // THE ORDER IN `Workers.start` IS SETTINGS THEN PRESET, and the preset has to survive a
        // setting that arrives after it as well -- a re-mint rebuilds the app and applies the
        // user's figures again. So the mark is sticky and every setter re-asserts it.
        let a = make_test_agent();
        a.set_worker_limits();
        a.set_max_rounds(150);
        a.set_context_cap(200_000);
        a.set_spend_cap_usd(5.0);
        a.set_context_window(1_310_720);
        let l = a.limits();
        assert!(l.worker);
        assert_eq!(100,    l.max_rounds, "the chat's round setting reached a worker");
        assert_eq!(1,      l.max_continuations);
        assert_eq!(96_000, l.context_cap, "the chat's carry ceiling reached a worker");
        assert_eq!(1.0,    l.spend_cap_usd, "the chat's dollar ceiling reached a worker");
        assert_eq!(96_000, l.budget(0), "a worker's per-round carry is not bounded");
        // A tighter setting is still the user's, whichever order it arrives in.
        a.set_max_rounds(15);
        assert_eq!(15, a.limits().max_rounds);
    }

    #[test]
    fn test_a_chat_is_not_held_to_a_workers_ceiling_00() {
        // The other half, and the one a mistake here would make invisible: nothing may lower a
        // conversation the user is sitting in front of.
        let a = make_test_agent();
        a.set_max_rounds(150);
        a.set_context_cap(200_000);
        a.set_spend_cap_usd(5.0);
        let l = a.limits();
        assert!(!l.worker);
        assert_eq!(150, l.max_rounds);
        assert_eq!(200_000, l.context_cap);
        assert_eq!(5.0, l.spend_cap_usd);
        assert_eq!(compact::MAX_CONTINUATIONS, l.max_continuations);
    }

    // ── Calls per round ────────────────────────────────────────────

    #[test]
    fn test_the_batch_line_rides_the_tools_sentence_by_default_00() {
        let a = make_test_agent();
        let (_, tools, _) = a.system_parts(&one_tool());
        assert!(tools.contains("Calls in one reply run in the order you give them"),
            "the batching sentence is not sent by default: {}", tools);
        // A role with no tools has nothing to batch, so nothing is said and nothing is paid for.
        let (_, empty_tools, _) = a.system_parts(&no_tools());
        assert!(empty_tools.is_empty(), "a toolless registry was given a tools paragraph");
    }

    #[test]
    fn test_the_batch_line_is_the_batchline_off_arms_whole_content_00() {
        let a = make_test_agent();
        if let Err(e) = a.set_tune(r#"{"batch_line":false}"#) {
            panic!("set_tune refused a plain bool: {}", e);
        }
        let (_, tools, _) = a.system_parts(&one_tool());
        assert!(!tools.contains("Calls in one reply run in the order you give them"),
            "set_tune(\"batch_line\":false) did not turn the sentence off: {}", tools);
    }

    #[test]
    fn test_the_whole_folder_sentence_rides_with_file_read_only_00() {
        let a = make_test_agent();
        // `one_tool()` holds `file_write`, not `file_read`: nothing to say about reading a
        // folder whole where there is no tool that reads one.
        let (_, no_read, _) = a.system_parts(&one_tool());
        assert!(!no_read.contains("read it whole in one file_read"),
            "the whole-folder sentence was sent with no file_read tool: {}", no_read);
        let (_, with_read, _) = a.system_parts(&image_tools());
        assert!(with_read.contains("read it whole in one file_read"),
            "file_read is on the belt and the whole-folder sentence was not sent: {}", with_read);
        assert!(with_read.contains("before following its imports one at a time"),
            "the sentence does not say what habit it replaces: {}", with_read);
    }

    // ── The Claude Code tool profile ─────────────────────────────────

    /// The tools sentence names the Claude Code alias for a Claude-family registry with the
    /// switch on, Daimond's own name for every other combination.
    #[test]
    fn test_the_composed_tools_line_aliases_for_claude_and_not_otherwise_00() {
        let a = make_test_agent();
        let mut plain = no_tools();
        plain.tools = vec![crate::tools::Tool::FileRead];
        let claude = plain.clone()
            .with_family(crate::profile::Family::Claude)
            .with_claude_names(true);

        let (_, tools_default, _) = a.system_parts(&plain);
        assert!(tools_default.contains("file_read"), "{}", tools_default);
        assert!(!tools_default.contains("Read"),
            "an un-aliased registry named the Claude alias: {}", tools_default);

        let (_, tools_claude, _) = a.system_parts(&claude);
        assert!(tools_claude.contains("Read"), "{}", tools_claude);
        assert!(!tools_claude.contains("file_read"),
            "the switch was on and the canonical name still showed: {}", tools_claude);

        // The switch OFF, same family, restores Daimond's own name -- `cur` against
        // `claudenames` differs in exactly this.
        let off = plain.clone().with_family(crate::profile::Family::Claude);
        let (_, tools_off, _) = a.system_parts(&off);
        assert!(tools_off.contains("file_read"),
            "claude_names off lost the canonical name: {}", tools_off);
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

    #[test]
    fn test_the_round_cap_forces_a_fold_and_teaches_nothing_00() {
        // The estimate is exactly what did not fire for the whole of a capped turn -- the prompt
        // sat just under the ceiling for a hundred and fifty rounds -- so a fold at the cap that
        // consulted it would not happen either.  And nothing was refused, so it must not move the
        // window: `learn_from_refusal` only ever moves it DOWN.
        assert!(Fold::Capped.forces(), "a fold at the cap that consults the estimate is a no-op");
        assert!(!Fold::Capped.teaches_window(), "a round limit was read as a provider refusal");
        assert!(Fold::Capped.at_the_cap());
        assert!(!Fold::ByHand.at_the_cap());
    }

    #[tokio::test]
    async fn test_a_capped_turn_hands_the_next_one_a_folded_conversation_00() {
        // THE CONTINUATION IS WHERE A CAPPED TURN COSTS ITS MONEY.  The note it ends with invites
        // the user to carry on, so the next turn opens by re-sending every round of the longest
        // turn the conversation has had -- and then re-sends it again on each of its own rounds.
        //
        // The window is the default one and the history is well under its budget, so NO fold can
        // fire from the estimate: what is under test is the one at the cap, and a fold from any
        // other cause would pass this test for the wrong reason.
        let registry = one_tool();
        let (port, _seen) = crate::llm::tests::start_stub(vec![
            tool_round(&[("file_write", r#"{"path":"a.txt","content":"1"}"#)]),
        ]).await;
        let mut llm = crate::llm::tests::stub_client(port);
        llm.retry.max_attempts = 1;
        let a = Agent::new(llm, "You are Daimond.");
        a.set_context_window(131_072);
        a.set_max_rounds(1);
        let mut session = Session::new(fmt!("s1"), fmt!("capped"), fmt!("model"));
        // 200,000 bytes of plain conversation: over the fold's TAIL budget, which is what a forced
        // fold cuts against, and comfortably under the budget the estimate would fold at.
        for i in 0..40 {
            session.messages.push(ChatMessage::user(fmt!("step {}", i)));
            session.messages.push(ChatMessage::Assistant {
                content: MessageContent::text("x".repeat(5_000)), tool_calls: Vec::new(),
            });
        }
        let held = session.messages.len();
        let mut events: Vec<AgentEvent> = Vec::new();
        let _ = a.run_turn(&mut session, fmt!("carry on"), &registry,
            &mut |ev| events.push(ev)).await;

        assert_eq!(Some(TurnEnd::Capped), a.ending().map(|e| e.how),
            "the turn did not end at the round limit, so nothing here is about the cap");
        // The conversation the NEXT turn will send: folded, and the round-limit note last.
        assert!(session.messages.len() < held,
            "the session still holds {} messages of {}, so nothing was folded at the cap",
            session.messages.len(), held);
        let folded = session.messages.iter()
            .position(|m| m.text().contains("folded the earlier part of this conversation"));
        let at = match folded {
            Some(i) => i,
            None    => panic!("no fold notice in a conversation of {} messages",
                session.messages.len()),
        };
        assert!(at < session.messages.len() - 1,
            "the notice is the last thing in the conversation, so the note was folded away");
        assert!(session.messages.last().map(|m| m.text().contains("round")).unwrap_or(false),
            "the round-limit note is not where the next turn will read it");
        // AND IN THAT ORDER.  The fold has to happen before the turn is handed back, or the next
        // turn opens on the unfolded log whatever the session ends up holding.
        let fold_at  = events.iter().position(|e| matches!(e, AgentEvent::Compacted { .. }));
        let limit_at = events.iter().position(|e| match e {
            AgentEvent::Error(m) => m.contains("round limit"),
            _ => false,
        });
        match (fold_at, limit_at) {
            (Some(f), Some(l)) => assert!(f < l,
                "the fold was announced after the limit was: {:?}", events),
            other => panic!("a capped turn announced {:?} of the two", other),
        }
    }

    #[test]
    fn test_the_context_ceiling_is_settable_and_held_in_its_band_00() {
        // The third of the three figures that decide what a turn carries, and the only one the
        // owner could not see: `fold_at` is a FRACTION, so on a large window it folds near a large
        // number, and this is the ceiling it is held under.
        let a = make_test_agent();
        assert_eq!(compact::ABSOLUTE_CAP, a.limits().context_cap);
        a.set_context_cap(60_000);
        assert_eq!(60_000, a.limits().context_cap);
        // Zero restores the shipped figure, as it does for `fold_at` -- that is how "the user has
        // not chosen" travels from the page.
        a.set_context_cap(0);
        assert_eq!(compact::ABSOLUTE_CAP, a.limits().context_cap);
        // Held at the band HERE and not only in `budget`, so a control drawn from the getter shows
        // the figure the arithmetic used.
        a.set_context_cap(1);
        assert_eq!(compact::CONTEXT_CAP_MIN, a.limits().context_cap);
        a.set_context_cap(u64::MAX);
        assert_eq!(compact::CONTEXT_CAP_MAX, a.limits().context_cap);
    }

    #[test]
    fn test_the_tune_carries_every_figure_and_defaults_to_todays_constants_00() {
        // THE DEFAULTS ARE THE POINT OF THIS HALF.  Ten compile-time constants became fields so a
        // measurement could move them, and the whole claim of that change is that a tree nobody
        // tunes behaves exactly as it did.  So the defaults are asserted against the constants
        // themselves rather than against figures restated here, which would pass a rename.
        let a = make_test_agent();
        let l = a.limits();
        assert!(l.retire_prior, "a default agent does not retire its prior turns");
        assert_eq!(compact::RETIRE_KEEP_TURNS,    l.retire_keep_turns);
        assert_eq!(compact::IN_TURN_RETIRE_AGE,   l.written_age);
        assert_eq!(compact::IN_TURN_RESULT_AGE,   l.result_age);
        assert_eq!(compact::IN_TURN_RESULT_CAP,   l.result_cap);
        assert_eq!(compact::IN_TURN_RETIRE_EVERY, l.sweep_every);
        assert_eq!(compact::WORKER_MAX_ROUNDS,    l.worker_max_rounds);
        assert_eq!(compact::WORKER_CONTINUATIONS, l.worker_continuations);
        assert_eq!(compact::WORKER_CONTEXT_CAP,   l.worker_context_cap);
        assert_eq!(compact::WORKER_KEEP,          l.worker_keep);
        assert_eq!(compact::WORKER_SPEND_CAP_USD, l.worker_spend_usd);

        // An empty tune, and an empty object, are both no-ops -- that is how "the user has not
        // chosen" reaches here from the page, on every single app that is built.
        if let Err(e) = a.set_tune("") { panic!("an empty tune must change nothing: {}", e); }
        if let Err(e) = a.set_tune("{}") { panic!("an empty object must change nothing: {}", e); }
        assert_eq!(compact::IN_TURN_RESULT_AGE, a.limits().result_age);
        assert!(a.limits().retire_prior);

        // AND IT ROUND-TRIPS.  Every key the loop sets, in one object, read back out of the
        // getter a control and a trial both draw from.
        let tune = r#"{"retire_prior":false,"retire_keep_turns":3,"written_age":6,
            "result_age":16,"result_cap":4096,
            "sweep_every":5,"worker_max_rounds":100,"worker_continuations":2,
            "worker_context_cap":96000,"worker_keep":0.45,"worker_spend_usd":2.5}"#;
        if let Err(e) = a.set_tune(tune) { panic!("the tune was refused: {}", e); }
        let l = a.limits();
        assert!(!l.retire_prior, "retire_prior stayed on");
        assert_eq!(3,      l.retire_keep_turns);
        assert_eq!(6,      l.written_age);
        assert_eq!(16,     l.result_age);
        assert_eq!(4_096,  l.result_cap);
        assert_eq!(5,      l.sweep_every);
        assert_eq!(100,    l.worker_max_rounds);
        assert_eq!(2,      l.worker_continuations);
        assert_eq!(96_000, l.worker_context_cap);
        assert_eq!(0.45,   l.worker_keep);
        assert_eq!(2.5,    l.worker_spend_usd);
        // A SECOND TUNE IS A PARTIAL CHANGE, not a reset: an absent key is left alone, which is
        // what lets an arm be written as the one figure it varies.
        if let Err(e) = a.set_tune(r#"{"result_age":20}"#) { panic!("{}", e); }
        assert_eq!(20, a.limits().result_age);
        assert_eq!(6,  a.limits().written_age);
        // Not an object is refused rather than silently tuning nothing: an arm that measured the
        // default while reporting itself as tuned is a figure about the wrong engine.
        assert!(a.set_tune("result_age=20").is_err(), "a tune that is not an object was taken");
        // NOUGHT TURNS KEPT IS A CHOICE, not an absence: it is the arm of the trial that holds
        // what shipped before 2026-09-13, so a setter that floored it would leave the experiment
        // measuring the new default twice.
        if let Err(e) = a.set_tune(r#"{"retire_keep_turns":0}"#) { panic!("{}", e); }
        assert_eq!(0, a.limits().retire_keep_turns, "nought turns kept was read as absent");

        // AND THE WORKER PRESET IS READ OFF THESE FIELDS.  In `Workers.start`'s own order:
        // `applyFoldSettings` -- which is where the tune reaches the app -- runs BEFORE
        // `set_worker_limits`, so a loosened preset is in place by the time the hold is taken.
        let w = make_test_agent();
        if let Err(e) = w.set_tune(r#"{"worker_max_rounds":100,"worker_context_cap":96000,
            "worker_keep":0.4,"worker_spend_usd":5}"#) { panic!("{}", e); }
        w.set_worker_limits();
        assert_eq!(100,    w.limits().max_rounds,  "the tuned worker round ceiling did not hold");
        assert_eq!(96_000, w.limits().context_cap, "the tuned worker carry did not hold");
        assert_eq!(0.4,    w.limits().keep);
        assert_eq!(5.0,    w.limits().spend_cap_usd);
        // A LATER SETTING STILL CANNOT LIFT IT ABOVE THE TUNED FIGURE, which is the stickiness
        // `hold_worker` exists for -- the tune moves the ceiling, it does not remove it.
        w.set_max_rounds(150);
        assert_eq!(100, w.limits().max_rounds);

        // AND A TUNE THAT ARRIVES AFTER THE HOLD CANNOT LOOSEN WHAT IS ALREADY HELD.  Every
        // figure in `hold_to_worker` is a `min`, so raising the preset on an agent already at the
        // old ceiling leaves it there -- which is why the page tunes before it holds, and why a
        // trial that got the order wrong would silently measure `cur`.
        let late = make_test_agent();
        late.set_worker_limits();
        if let Err(e) = late.set_tune(r#"{"worker_context_cap":96000}"#) { panic!("{}", e); }
        assert_eq!(compact::WORKER_CONTEXT_CAP, late.limits().context_cap,
            "a tune after the hold raised a ceiling");
    }

    /// The thinking tune reaches the CLIENT, which is the only place it can do anything.
    ///
    /// `Limits` holding the figure is not the measure: the request body is built by
    /// `LlmClient`, so a setter that wrote only the limits would give `turn_limits` a figure to
    /// report and every request the shipped default -- an arm measuring the wrong engine while
    /// the selftest passed.
    #[test]
    fn test_the_thinking_tune_reaches_the_client_and_not_only_the_limits_00() {
        use crate::llm::{Effort, Thinking};

        let a = make_test_agent();
        // The default is what the client asked for before it was a setting.
        assert_eq!(Thinking::Adaptive, a.limits().thinking);
        assert_eq!(Effort::High,       a.limits().effort);
        assert_eq!(Thinking::Adaptive, a.llm.thinking_tune().thinking);

        if let Err(e) = a.set_tune(r#"{"thinking":"off","effort":"xhigh"}"#) {
            panic!("the tune was refused: {}", e);
        }
        assert_eq!(Thinking::Off,  a.limits().thinking);
        assert_eq!(Effort::XHigh,  a.limits().effort);
        assert_eq!(Thinking::Off,  a.llm.thinking_tune().thinking, "the client was not told");
        assert_eq!(Effort::XHigh,  a.llm.thinking_tune().effort,   "the client was not told");

        // A SPELLING THIS BUILD DOES NOT KNOW IS IGNORED, as `fold_shape` is: the engine stays
        // on whatever it held and `turn_limits` reports that, rather than a typo silently
        // measuring the default under another name.
        if let Err(e) = a.set_tune(r#"{"thinking":"adpative","effort":"xxhigh"}"#) {
            panic!("{}", e);
        }
        assert_eq!(Thinking::Off, a.limits().thinking);
        assert_eq!(Effort::XHigh, a.limits().effort);

        // AND AN AGENT THAT ADOPTS ANOTHER'S LIMITS ADOPTS ITS DEPTH.  A Diamond's reducer is
        // built from a fresh client for the same model; without this it would fold at a
        // different effort from the chat it was built for.
        let b = make_test_agent();
        b.adopt_limits(&a);
        assert_eq!(Thinking::Off, b.llm.thinking_tune().thinking);
        assert_eq!(Effort::XHigh, b.llm.thinking_tune().effort);
    }

    #[tokio::test]
    async fn test_a_tune_that_keeps_the_prior_turn_sends_its_results_whole_00() {
        // The mirror of `test_a_turn_sends_a_retired_history_and_stores_a_whole_one_00`, and it is
        // the measure's OFF switch that is under test: a trial arm cannot ask what retiring the
        // prior turn is worth unless it can run the same fixture without it.
        let registry = one_tool();
        let (port, seen) = crate::llm::tests::start_stub(vec![plain_answer()]).await;
        let mut llm = crate::llm::tests::stub_client(port);
        llm.retry.max_attempts = 1;
        let a = Agent::new(llm, "You are Daimond.");
        if let Err(e) = a.set_tune(r#"{"retire_prior":false}"#) { panic!("{}", e); }
        let mut session = Session::new(fmt!("s1"), fmt!("retire"), fmt!("model"));
        let body = "source line\n".repeat(2_000);
        session.messages.push(ChatMessage::user("read it"));
        session.messages.push(ChatMessage::Assistant {
            content:    MessageContent::text(""),
            tool_calls: vec![crate::protocol::ToolCall {
                id: fmt!("r1"), name: fmt!("file_read"),
                arguments: fmt!(r#"{{"path":"src/a.rs","offset":1,"end":200}}"#),
            }],
        });
        session.messages.push(ChatMessage::tool(fmt!("r1"), body.clone()));
        session.messages.push(ChatMessage::assistant("I have read it."));
        let _ = a.run_turn(&mut session, fmt!("now change it"), &registry, &mut |_| {}).await;

        let bodies = match seen.lock() {
            Ok(g)  => g.bodies.clone(),
            Err(e) => panic!("the stub's record: {}", e),
        };
        assert!(!bodies.is_empty(), "no request reached the provider");
        let sent = bodies.join("\n");
        // THE WHOLE READ WENT OUT, which is exactly what the shipped default prevents.
        assert!(sent.contains("source line\\nsource line"),
            "the prior turn was retired although the tune turned that off");
        assert!(!sent.contains("file_read src/a.rs 1-200"),
            "a stub naming the call was sent as well as the body");
    }

    #[tokio::test]
    async fn test_an_off_tune_leaves_a_long_turns_write_bodies_where_they_are_00() {
        // THE SAME TWELVE ROUNDS, TWICE.  The in-turn sweep fires at round ten on the shipped
        // figures, so a twelve-round turn is the shortest fixture that shows the measure working;
        // the `off` arm of the tune loop sets the two ages past any turn's length, and the proof
        // that it is off is that the bytes of the eleventh request are the UNSWEPT ones.
        //
        // Asserted against what the provider was SENT, never against the session: the owner's
        // ruling is that the transcript keeps every word whichever way this is tuned.
        let body = "x".repeat(4_000);
        let args = fmt!(r#"{{"path":"a.txt","content":"{}"}}"#, body);
        let ran_with = |tune: &'static str, args: String| async move {
            let registry = one_tool();
            let mut script: Vec<crate::llm::tests::Reply> = (0..12)
                .map(|_| tool_round(&[("file_write", args.as_str())]))
                .collect();
            script.push(plain_answer());
            let (port, seen) = crate::llm::tests::start_stub(script).await;
            let mut llm = crate::llm::tests::stub_client(port);
            llm.retry.max_attempts = 1;
            let a = Agent::new(llm, "You are Daimond.");
            a.set_max_rounds(20);
            if !tune.is_empty() {
                if let Err(e) = a.set_tune(tune) { panic!("the tune was refused: {}", e); }
            }
            let mut session = Session::new(fmt!("s1"), fmt!("sweep"), fmt!("model"));
            let _ = a.run_turn(&mut session, fmt!("write them all"), &registry, &mut |_| {}).await;
            let bodies = match seen.lock() {
                Ok(g)  => g.bodies.clone(),
                Err(e) => panic!("the stub's record: {}", e),
            };
            bodies
        };

        // The shipped figures: the sweep fires and the old write bodies are gone from the request.
        let shipped = ran_with("", args.clone()).await;
        assert!(shipped.len() > compact::IN_TURN_RETIRE_EVERY,
            "the turn did not reach the sweep: {} requests", shipped.len());
        let last = match shipped.last() { Some(b) => b.clone(), None => panic!("no request") };
        assert!(last.contains("retired"),
            "the shipped sweep did not retire a write body, so the off arm proves nothing");
        let kept_shipped = last.matches(&body).count();

        // The `off` arm: both ages past any turn's length, which is as off as the engine allows.
        let off = ran_with(r#"{"written_age":100000,"result_age":100000}"#, args.clone()).await;
        let last_off = match off.last() { Some(b) => b.clone(), None => panic!("no request") };
        assert!(!last_off.contains("retired"),
            "the off tune still retired something");
        let kept_off = last_off.matches(&body).count();
        assert!(kept_off > kept_shipped,
            "the off arm carried {} whole bodies and the shipped one {} -- the tune changed \
            nothing", kept_off, kept_shipped);
        // Every one of the twelve, whole, which is the unswept run by definition.
        assert_eq!(12, kept_off, "the off arm dropped a write body anyway");
    }

    #[tokio::test]
    async fn test_a_turn_sends_a_retired_history_and_stores_a_whole_one_00() {
        // The owner's ruling, at the new seam: the model gets the shortened version and his
        // transcript keeps every word.  `elide_bulk` already obeyed it; retirement runs on every
        // turn rather than only on an oversized one, so it is the seam that would do the damage.
        //
        // ONE FINISHED TURN, so the keep is set to nought to have anything to retire at all --
        // the shipped figure leaves the turn just finished whole, which is what
        // `test_the_default_leaves_the_turn_just_finished_whole_00` is about.  What is under test
        // here is the SEAM, and it is the same seam at either figure.
        let registry = one_tool();
        let (port, seen) = crate::llm::tests::start_stub(vec![plain_answer()]).await;
        let mut llm = crate::llm::tests::stub_client(port);
        llm.retry.max_attempts = 1;
        let a = Agent::new(llm, "You are Daimond.");
        if let Err(e) = a.set_tune(r#"{"retire_keep_turns":0}"#) { panic!("{}", e); }
        let mut session = Session::new(fmt!("s1"), fmt!("retire"), fmt!("model"));
        let body = "source line\n".repeat(2_000);
        session.messages.push(ChatMessage::user("read it"));
        session.messages.push(ChatMessage::Assistant {
            content:    MessageContent::text(""),
            tool_calls: vec![crate::protocol::ToolCall {
                id: fmt!("r1"), name: fmt!("file_read"),
                arguments: fmt!(r#"{{"path":"src/a.rs","offset":1,"end":200}}"#),
            }],
        });
        session.messages.push(ChatMessage::tool(fmt!("r1"), body.clone()));
        session.messages.push(ChatMessage::assistant("I have read it."));
        let _ = a.run_turn(&mut session, fmt!("now change it"), &registry, &mut |_| {}).await;

        // THE RECORD. Every byte of the read is still in the user's own transcript.
        assert!(session.messages.iter().any(|m| m.text().len() >= body.len()),
            "the stored conversation was shortened: {:?}",
            session.messages.iter().map(|m| m.text().len()).collect::<Vec<_>>());
        // THE REQUEST. The body did not go out, and what went in its place names the call.
        let bodies = match seen.lock() {
            Ok(g)  => g.bodies.clone(),
            Err(e) => panic!("the stub's record: {}", e),
        };
        assert!(!bodies.is_empty(), "no request reached the provider");
        let sent = bodies.join("\n");
        assert!(!sent.contains("source line\\nsource line"),
            "a finished turn's file read was re-sent whole");
        assert!(sent.contains("file_read src/a.rs 1-200"),
            "the retired result does not name the call that made it");
    }

    #[tokio::test]
    async fn test_the_default_leaves_the_turn_just_finished_whole_00() {
        // THE 2026-09-13 CORRECTION AT THE SEAM THAT SENDS.  Retiring every finished turn is
        // right for a fifty-round session and wrong for a three-turn chat: the model met a stub
        // of what it had just been told and asked for the file again, which carried 41% MORE
        // tokens on turn two than not retiring at all.  So the newest finished turn goes out
        // whole and the one before it does not.  See `compact::RETIRE_KEEP_TURNS`.
        let registry = one_tool();
        let (port, seen) = crate::llm::tests::start_stub(vec![plain_answer()]).await;
        let mut llm = crate::llm::tests::stub_client(port);
        llm.retry.max_attempts = 1;
        let a = Agent::new(llm, "You are Daimond.");
        let mut session = Session::new(fmt!("s1"), fmt!("keep"), fmt!("model"));
        // Two finished turns, each a read of its own file, so one figure tells them apart.
        for (id, path, line) in [("r1", "src/a.rs", "older line\n"), ("r2", "src/b.rs", "newer line\n")] {
            session.messages.push(ChatMessage::user(fmt!("read {}", path)));
            session.messages.push(ChatMessage::Assistant {
                content:    MessageContent::text(""),
                tool_calls: vec![crate::protocol::ToolCall {
                    id: fmt!("{}", id), name: fmt!("file_read"),
                    arguments: fmt!(r#"{{"path":"{}","offset":1,"end":200}}"#, path),
                }],
            });
            session.messages.push(ChatMessage::tool(fmt!("{}", id), line.repeat(2_000)));
            session.messages.push(ChatMessage::assistant("I have read it."));
        }
        let _ = a.run_turn(&mut session, fmt!("now change it"), &registry, &mut |_| {}).await;

        let bodies = match seen.lock() {
            Ok(g)  => g.bodies.clone(),
            Err(e) => panic!("the stub's record: {}", e),
        };
        assert!(!bodies.is_empty(), "no request reached the provider");
        let sent = bodies.join("\n");
        assert!(sent.contains("newer line\\nnewer line"),
            "the turn just finished was retired, which is what the keep exists to stop");
        assert!(!sent.contains("older line\\nolder line"),
            "the turn before last was sent whole, so retirement has been turned off rather \
             than moved back one turn");
        assert!(sent.contains("file_read src/a.rs 1-200"),
            "the older turn's retired result does not name the call that made it");
    }

    #[tokio::test]
    async fn test_a_long_turn_is_told_what_is_left_of_it_00() {
        // A turn that reaches a ceiling stops in the middle of the work, and nothing could see it
        // coming: a model cannot count its own rounds and cannot see the bill.  So the figures are
        // put where it will read them and where they cost nothing to change -- the last tool
        // result, never the system prompt, which is the cached prefix.
        let registry = one_tool();
        let mut script: Vec<crate::llm::tests::Reply> =
            (0..compact::IN_TURN_RETIRE_EVERY).map(|_| round_costing(0.05)).collect();
        script.push(plain_answer());
        let (port, seen) = crate::llm::tests::start_stub(script).await;
        let mut llm = crate::llm::tests::stub_client(port);
        llm.retry.max_attempts = 1;
        let a = Agent::new(llm, "You are Daimond.");
        a.set_max_rounds(60);
        let mut session = Session::new(fmt!("s1"), fmt!("budget"), fmt!("model"));
        let _ = a.run_turn(&mut session, fmt!("do the work"), &registry, &mut |_| {}).await;

        let bodies = match seen.lock() {
            Ok(g)  => g.bodies.clone(),
            Err(e) => panic!("the stub's record: {}", e),
        };
        assert!(bodies.len() > compact::IN_TURN_RETIRE_EVERY,
            "the turn did not reach the round the line is said on: {} requests", bodies.len());
        // THE LAST REQUEST, because that is the one the line was written for: it is appended at the
        // seam of round ten and the eleventh request is the first to carry it.
        let last = match bodies.last() {
            Some(b) => b.clone(),
            None    => panic!("no request reached the provider"),
        };
        // 50 left of this leg and three more legs of 60, which is what the app will actually run
        // unattended -- see `compact::MAX_CONTINUATIONS`. Ten rounds at five cents of a
        // five-dollar ceiling.
        let want = "[turn budget: 230 rounds and US$4.50 left; if short, report now]";
        assert!(last.contains(want), "the turn was not told what was left of it: {}",
            &last[last.len().saturating_sub(600)..]);
        // AND IT IS SAID ONCE AND NOWHERE ELSE: not in the system prompt, which is the cached
        // prefix, and not twice in the same request.
        assert_eq!(1, last.matches("[turn budget:").count(), "the line was said more than once");
        // AND THE TRANSCRIPT DOES NOT CARRY IT. The figure is true of one round of one turn; stored,
        // it would be re-sent for the life of the conversation and be wrong every time.
        assert!(!session.messages.iter().any(|m| m.text().contains("[turn budget:")),
            "the app's own bookkeeping was written into the user's transcript");
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
            AgentEvent::Compacted { folded, kept, note, .. } => {
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

    /// One malformed `file_edit`, the same one every time -- Kimi's own shape from the bank.
    fn same_bad_edit() -> crate::llm::tests::Reply {
        crate::llm::tests::Reply::Sse {
            chunks: vec![
                "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"e0\",\
                    \"type\":\"function\",\"function\":{\"name\":\"file_edit\",\"arguments\":\
                    \"{\\\"path\\\":\\\"notes/ok.txt\\\"}\"}}]}}]}\n\n".to_string(),
                "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n"
                    .to_string(),
                "data: [DONE]\n\n".to_string(),
            ],
            reset_after: None,
        }
    }

    /// A model that will not stop sending the same refused call is told, and then stopped.
    ///
    /// **Kimi sent one malformed `file_edit` twenty times in a single turn on the tune bank**,
    /// against a refusal that named the very keys it had sent; nothing in the loop could tell
    /// that from progress, so the turn spent its whole round budget being stuck. The counter is
    /// what a refusal cannot be: a refusal looks the same on the first attempt and the twentieth.
    #[tokio::test]
    async fn test_a_turn_that_cannot_be_told_it_is_stuck_is_stopped_00() {
        let (port, _seen) = crate::llm::tests::start_stub(
            (0..8).map(|_| same_bad_edit()).collect()).await;
        let mut llm = crate::llm::tests::stub_client(port);
        llm.retry.max_attempts = 1;
        let a = Agent::new(llm, "You are Daimond.");
        a.set_max_rounds(20);

        let mut registry = no_tools();
        registry.tools = vec![crate::tools::Tool::FileEdit];
        let mut session = Session::new(fmt!("s1"), fmt!("stuck"), fmt!("model"));
        let mut events: Vec<AgentEvent> = Vec::new();
        let _ = a.run_turn(&mut session, fmt!("edit it"), &registry,
            &mut |ev| events.push(ev)).await;

        let got = tool_results(&events);
        assert_eq!(STUCK_ENDS_TURN as usize, got.len(),
            "the turn ran {} rounds rather than stopping at {}", got.len(), STUCK_ENDS_TURN);
        // Said on the third, which is two rounds before the turn ends, so a model that can
        // recover has somewhere to go.
        let warned = (STUCK_WARNS - 1) as usize;
        assert!(!got[warned - 1].2.contains("failed"),
            "the count was said before it had happened: {}", got[warned - 1].2);
        assert!(got[warned].2.contains("has now failed 3 times"),
            "the third identical failure said nothing: {}", got[warned].2);
        assert!(got[warned].2.contains("will end the turn"),
            "the model is not told what happens next: {}", got[warned].2);
        // And the turn's last word is that sentence, not a silent stop.
        let said = events.iter().rev().find_map(|e| match e {
            AgentEvent::Text(t) if t.contains("has now failed") => Some(t.clone()),
            _ => None,
        });
        assert!(said.is_some(), "the turn ended without saying why: {:?}",
            events.iter().map(|e| fmt!("{:?}", e)).collect::<Vec<_>>());
    }

    /// A call that SUCCEEDS is not counted, however often it is repeated.
    ///
    /// A turn that verifies its own work reads the same file twice on purpose, and a rule that
    /// counted that would end the turns that are going best.
    #[test]
    fn test_the_repeat_counter_is_about_failures_and_not_about_repetition_00() {
        let a = call_fingerprint("file_edit", "{\"path\":\"a\"}");
        let b = call_fingerprint("file_edit", "{\"path\":\"a\"}");
        let c = call_fingerprint("file_edit", "{\"path\":\"b\"}");
        let d = call_fingerprint("file_read", "{\"path\":\"a\"}");
        assert_eq!(a, b, "the same call fingerprints differently");
        assert_ne!(a, c, "two different arguments share a fingerprint");
        assert_ne!(a, d, "two different tools share a fingerprint");
        assert!(stuck_said(3).contains("3 times"), "the sentence does not carry the count");
        assert!(stuck_said(5).contains("5 times"));
    }

    /// Every `ToolResult` in a run, as `(name, outcome, text)`.
    fn tool_results(events: &[AgentEvent]) -> Vec<(String, CallOutcome, String)> {
        events.iter().filter_map(|e| match e {
            AgentEvent::ToolResult { name, result, outcome } =>
                Some((name.clone(), *outcome, result.clone())),
            _ => None,
        }).collect()
    }

    // ── A worker's report read inside the turn that started it ───────────────

    /// A registry holding the two worker tools and `file_list`, over a scratch workspace, with
    /// its workers coming from a script rather than from a page.
    fn worker_tools(reports: Vec<crate::tools::ScriptedReport>) -> crate::tools::ToolRegistry {
        let mut r = batch_tools();
        r.tools = vec![crate::tools::Tool::SpawnAgent, crate::tools::Tool::Gather,
                       crate::tools::Tool::FileList];
        r.ctx.set_worker_source(crate::tools::WorkerSource::Scripted(reports));
        r
    }

    /// One scripted worker, terminal unless told otherwise.
    fn scripted_worker(name: &str, report: &str, usd: f64, terminal: bool)
        -> crate::tools::ScriptedReport
    {
        crate::tools::ScriptedReport {
            name:   fmt!("{}", name),
            status: fmt!("done"),
            report: fmt!("{}", report),
            usd,
            rounds: 6,
            terminal,
        }
    }

    /// The same round with a price on it, so a turn's ceiling has something to be judged against.
    fn priced(reply: crate::llm::tests::Reply, usd: f64) -> crate::llm::tests::Reply {
        match reply {
            crate::llm::tests::Reply::Sse { mut chunks, reset_after } => {
                let last = chunks.len().saturating_sub(1);
                chunks.insert(last, fmt!(
                    "data: {{\"choices\":[],\"usage\":{{\"prompt_tokens\":11,\
                     \"completion_tokens\":2,\"cost\":{}}}}}\n\n", usd));
                crate::llm::tests::Reply::Sse { chunks, reset_after }
            }
            other => other,
        }
    }

    /// THE WHOLE ITEM, IN ONE TURN.  A worker is started, its report is read back, and the model
    /// answers -- with no second turn spent on the reading.
    ///
    /// That second turn is what this removes: the page used to spend a fresh turn handing the
    /// reports over, which re-sends the whole standing context for the sake of a few kilobytes of
    /// report.  So what is asserted is the SHAPE: the report arrives as a tool result, inside the
    /// turn, and the turn ends once.
    #[tokio::test]
    async fn test_a_gathered_report_lands_as_a_tool_result_in_the_same_turn_00() {
        let registry = worker_tools(vec![scripted_worker("audit", "AUDITREPORT", 0.3, true)]);
        let (port, _seen) = crate::llm::tests::start_stub(vec![
            tool_round(&[("spawn_agent", r#"{"name":"audit","task":"read the file"}"#)]),
            tool_round(&[("gather", r#"{"names":["audit"]}"#)]),
            plain_answer(),
        ]).await;
        let mut llm = crate::llm::tests::stub_client(port);
        llm.retry.max_attempts = 1;
        let a = Agent::new(llm, "You are Daimond.");
        a.set_max_rounds(4);
        let mut session = Session::new(fmt!("s1"), fmt!("gather"), fmt!("model"));
        let mut events: Vec<AgentEvent> = Vec::new();
        let _ = a.run_turn(&mut session, fmt!("send a worker"), &registry,
            &mut |ev| events.push(ev)).await;

        let got = tool_results(&events);
        let gathered = match got.iter().find(|(n, _, _)| n == "gather") {
            Some(g) => g,
            None    => panic!("no gather result in {:?}",
                got.iter().map(|(n, _, _)| n.clone()).collect::<Vec<String>>()),
        };
        assert_eq!(CallOutcome::Done, gathered.1, "a gather that read a report is work");
        assert!(gathered.2.contains("AUDITREPORT"),
            "the worker's report did not reach the turn: {}", gathered.2);
        assert!(gathered.2.contains("### audit"), "the report has no heading: {}", gathered.2);

        // AND IT ARRIVED BEFORE THE TURN ENDED, which is the whole claim.
        let at_result = events.iter().position(|e|
            matches!(e, AgentEvent::ToolResult { name, .. } if name == "gather"));
        let at_done = events.iter().position(|e| matches!(e, AgentEvent::Done));
        assert!(at_result.is_some() && (at_done.is_none() || at_result < at_done),
            "the report arrived after the turn was done");

        // ONE TURN, NOT TWO.  A second `Ended` would be the hand-back turn this replaces.
        let ended = events.iter().filter(|e| matches!(e, AgentEvent::Ended { .. })).count();
        assert_eq!(1, ended, "the turn ended {} times", ended);

        // And the report is in the conversation the next round was built from, as a tool reply.
        let in_session = session.messages.iter().any(|m| match m {
            ChatMessage::Tool { content, .. } =>
                content.as_text().contains("AUDITREPORT"),
            _ => false,
        });
        assert!(in_session, "the gathered report is not in the session as a tool reply");

        // The spawn said the worker was started, and the scripted source is what made that so.
        assert!(got.iter().any(|(n, _, _)| n == "spawn_agent"), "no spawn in {:?}", got);
    }

    /// A WORKER'S SPEND COUNTS AGAINST THE TURN THAT READ ITS REPORT.
    ///
    /// The ceiling is what one turn may cost.  A turn that can start eight workers of a dollar
    /// each outside it has a thirteen-dollar ceiling in effect, which is not the ceiling the user
    /// set.  Counted on the gather, because that is the moment the turn takes the benefit; a
    /// worker nobody gathers stays bounded by its own preset and the dispatch gate.
    #[tokio::test]
    async fn test_worker_spend_counts_toward_the_turn_ceiling_00() {
        // Two rounds at ten cents plus a worker at forty-five: over a fifty-cent ceiling.
        let dear = worker_tools(vec![scripted_worker("audit", "AUDITREPORT", 0.45, true)]);
        let script = vec![
            priced(tool_round(&[("spawn_agent", r#"{"name":"audit","task":"look"}"#)]), 0.1),
            priced(tool_round(&[("gather", r#"{"names":["audit"]}"#)]), 0.1),
            plain_answer(),
        ];
        let (port, _seen) = crate::llm::tests::start_stub(script.clone()).await;
        let mut llm = crate::llm::tests::stub_client(port);
        llm.retry.max_attempts = 1;
        let a = Agent::new(llm, "You are Daimond.");
        a.set_max_rounds(6);
        a.set_spend_cap_usd(0.5);
        let mut session = Session::new(fmt!("s1"), fmt!("spend"), fmt!("model"));
        let mut events: Vec<AgentEvent> = Vec::new();
        let _ = a.run_turn(&mut session, fmt!("send a worker"), &dear,
            &mut |ev| events.push(ev)).await;
        assert_eq!(Some(TurnEnd::SpendCapped), a.ending().map(|e| e.how),
            "the worker's spend was not counted against the turn's ceiling");

        // The same turn with a free worker runs on and answers, so what stopped it was the money
        // and not the rounds.
        let free = worker_tools(vec![scripted_worker("audit", "AUDITREPORT", 0.0, true)]);
        let (port2, _seen2) = crate::llm::tests::start_stub(script).await;
        let mut llm2 = crate::llm::tests::stub_client(port2);
        llm2.retry.max_attempts = 1;
        let b = Agent::new(llm2, "You are Daimond.");
        b.set_max_rounds(6);
        b.set_spend_cap_usd(0.5);
        let mut session2 = Session::new(fmt!("s2"), fmt!("spend"), fmt!("model"));
        let mut events2: Vec<AgentEvent> = Vec::new();
        let _ = b.run_turn(&mut session2, fmt!("send a worker"), &free,
            &mut |ev| events2.push(ev)).await;
        assert_eq!(Some(TurnEnd::Answered), b.ending().map(|e| e.how),
            "a free worker's gather stopped the turn on money it had not spent");
    }

    /// A GATHER RESULT IS RETIRED LIKE ANY OTHER RESULT, and the stub says whose reports went.
    ///
    /// Intended rather than regrettable: a long report read sixteen rounds ago is working memory
    /// the turn has finished with, and the model is told it can gather the same names again --
    /// which re-reads the report off the run at no cost.  `result_age` is tuned down here so the
    /// sweep bites in five rounds rather than eighteen; the mechanism is the shipped one, and
    /// `sweep_every` is turned up to one so the sweep runs on the round the horizon is reached.
    #[tokio::test]
    async fn test_a_gather_result_is_retired_like_any_result_00() {
        let registry = worker_tools(vec![
            scripted_worker("audit", &"x".repeat(3_000), 0.0, true)]);
        let mut script = vec![
            tool_round(&[("spawn_agent", r#"{"name":"audit","task":"look"}"#)]),
            tool_round(&[("gather", r#"{"names":["audit"]}"#)]),
        ];
        for _ in 0..6 {
            script.push(tool_round(&[("file_list", r#"{"path":"."}"#)]));
        }
        script.push(plain_answer());
        let (port, seen) = crate::llm::tests::start_stub(script).await;
        let mut llm = crate::llm::tests::stub_client(port);
        llm.retry.max_attempts = 1;
        let a = Agent::new(llm, "You are Daimond.");
        a.set_max_rounds(12);
        if let Err(e) = a.set_tune(r#"{"sweep_every":1,"result_age":3}"#) {
            panic!("the tune must be taken: {}", e);
        }
        let mut session = Session::new(fmt!("s1"), fmt!("retire"), fmt!("model"));
        let mut events: Vec<AgentEvent> = Vec::new();
        let _ = a.run_turn(&mut session, fmt!("send a worker"), &registry,
            &mut |ev| events.push(ev)).await;

        let bodies = match seen.lock() {
            Ok(g)  => g.bodies.clone(),
            Err(e) => panic!("the stub's record: {}", e),
        };
        let last = match bodies.last() {
            Some(b) => b.clone(),
            None    => panic!("the stub saw no request at all"),
        };
        assert!(last.contains("[gather audit"),
            "the retired gather does not name the worker whose report went: {}",
            &last[..last.len().min(3_000)]);
        // AND THE REPORT ITSELF IS GONE FROM THE SENT COPY, which is the point of retiring it.
        assert!(!last.contains(&"x".repeat(500)),
            "the report was still being re-sent after it was retired");
        // The STORED transcript keeps it, by the rule at the top of `compact`: the lossy form is
        // the request's.
        assert!(session.messages.iter().any(|m| match m {
            ChatMessage::Tool { content, .. } => content.as_text().contains(&"x".repeat(500)),
            _ => false,
        }), "retirement reached the stored transcript");
    }

    /// A gather that runs out of time NAMES WHAT IS STILL RUNNING, and the turn carries on.
    ///
    /// A fact rather than a failure: the workers are still out there, and a turn told so can do
    /// its own part of the work and gather again, or finish and let them report as a later turn.
    /// An outcome of `Failed` here would be read by the model as the tool being broken.
    #[tokio::test]
    async fn test_a_timed_out_gather_names_the_pending_worker_and_the_turn_goes_on_00() {
        let registry = worker_tools(vec![scripted_worker("census", "never", 0.0, false)]);
        let (port, _seen) = crate::llm::tests::start_stub(vec![
            tool_round(&[("spawn_agent", r#"{"name":"census","task":"count"}"#)]),
            tool_round(&[("gather", r#"{"names":["census"],"timeout_s":10}"#)]),
            plain_answer(),
        ]).await;
        let mut llm = crate::llm::tests::stub_client(port);
        llm.retry.max_attempts = 1;
        let a = Agent::new(llm, "You are Daimond.");
        a.set_max_rounds(4);
        let mut session = Session::new(fmt!("s1"), fmt!("timeout"), fmt!("model"));
        let mut events: Vec<AgentEvent> = Vec::new();
        let _ = a.run_turn(&mut session, fmt!("send a worker"), &registry,
            &mut |ev| events.push(ev)).await;

        let got = tool_results(&events);
        let g = match got.iter().find(|(n, _, _)| n == "gather") {
            Some(g) => g,
            None    => panic!("no gather result"),
        };
        assert!(g.2.contains("census"), "the pending worker was not named: {}", g.2);
        assert!(g.2.contains("still running"), "the result does not say it is running: {}", g.2);
        assert_eq!(CallOutcome::Done, g.1, "a timed-out gather is a fact, not a failure");
        assert_eq!(Some(TurnEnd::Answered), a.ending().map(|e| e.how),
            "the turn did not carry on after a gather that found nothing");
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

    /// A tool round whose usage block reports a price, which most of them do not.
    ///
    /// The spend ceiling is enforced on the provider's own figure and on nothing else, so a test
    /// for it has to produce one: see `Agent::over_the_spend_cap`.
    ///
    /// # Arguments
    /// * `usd` - What this one round reports costing.
    fn round_costing(usd: f64) -> crate::llm::tests::Reply {
        match tool_round(&[("file_write", r#"{"path":"a.txt","content":"1"}"#)]) {
            crate::llm::tests::Reply::Sse { mut chunks, reset_after } => {
                // Before the [DONE] the round ends with, because that is where a provider puts it.
                let last = chunks.len().saturating_sub(1);
                chunks.insert(last, fmt!(
                    "data: {{\"choices\":[],\"usage\":{{\"prompt_tokens\":11,\
                     \"completion_tokens\":2,\"cost\":{}}}}}\n\n", usd));
                crate::llm::tests::Reply::Sse { chunks, reset_after }
            }
            other => other,
        }
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

    /// **The compound switch crosses from the tune into the turn's own registry.**
    ///
    /// `Limits` belongs to the agent and `offered` to the registry, and nothing joins them but
    /// the one line at the top of [`Agent::run_turn`].  A measure whose switch never crossed
    /// that seam would be echoed as taken by `turn_limits` and be off in every request the turn
    /// actually made -- which is a measurement about the wrong engine, reported as an arm.
    #[tokio::test]
    async fn test_the_compound_switch_crosses_from_the_tune_into_the_turns_registry() {
        let a = dead_agent();
        let mut registry = no_tools();
        registry.tools.push(crate::tools::Tool::Compound);
        registry.tools.push(crate::tools::Tool::FileRead);
        let mut session = Session::new(fmt!("s1"), fmt!("compound"), fmt!("model"));

        // OFF BY THE SHIPPED DEFAULT, which is the whole of what makes the bank's `cur` arm a
        // control rather than a second copy of the treatment.
        assert!(!a.limits().compound, "the shipped default is on, so `cur` is not a control");
        let _ = a.run_turn(&mut session, fmt!("read the files"), &registry, &mut |_| {}).await;
        assert!(!registry.ctx.compound_on(), "a turn switched it on with nothing asking");
        let (_, tools, _) = a.system_parts(&registry);
        assert!(!tools.contains("compound"),
            "the tool is named to the model before any arm asked for it: {}", tools);

        // On, through the one door an arm comes through.
        if let Err(e) = a.set_tune(r#"{"compound":true}"#) { panic!("the tune was refused: {}", e); }
        assert!(a.limits().compound, "the tune did not reach Limits");
        let _ = a.run_turn(&mut session, fmt!("read the files"), &registry, &mut |_| {}).await;
        assert!(registry.ctx.compound_on(), "the switch did not cross into the turn's context");
        let (_, tools, _) = a.system_parts(&registry);
        assert!(tools.contains("compound"), "the tool is not named to the model: {}", tools);
        // AND THE SENTENCE THAT CHANGES THE HABIT, which is the half the rounds turn on: the
        // tool is worth nothing to a model that goes on reading one file per round.
        assert!(tools.contains("use compound and get them all in one call"),
            "the briefing line did not travel with the tool: {}", tools);

        // False is taken as written, so the arm that turns the measure OFF is as reachable as
        // the one that turns it on -- the rule `retire_prior` already follows.
        if let Err(e) = a.set_tune(r#"{"compound":false}"#) { panic!("{}", e); }
        assert!(!a.limits().compound, "false was read as absent");
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
        // THE WHOLE TURN'S ROUNDS, legs included: the ceiling was two and the turn ran eight,
        // because the cap is taken three times over before the turn is handed back.  A figure of
        // two here would be the one thing this ending exists to avoid -- a reader deciding
        // whether to raise the ceiling, told a quarter of what the turn actually cost.
        let legs = 1 + compact::MAX_CONTINUATIONS;
        assert_eq!(2 * legs, end.rounds, "{:?}", end);
        assert_eq!(2 * legs, end.calls, "{:?}", end);
        assert!(end.missing.is_empty(), "{:?}", end);
    }

    #[tokio::test]
    async fn test_a_capped_turn_carries_itself_on_three_times_and_then_stops_00() {
        // THE OWNER'S RULING OF 2026-09-12.  The round limit used to be a full stop: the user was
        // handed a half-finished task and a Continue button, so a long job ran only as fast as
        // somebody was watching it.  It is a breath now, taken three times and then not again.
        let registry = one_tool();
        let end = ran(vec![
            tool_round(&[("file_write", r#"{"path":"a.txt","content":"1"}"#)]),
        ], &registry, 1).await;

        // Four legs of one round, and not a fifth: the backstop has to hold, because each leg
        // costs another `max_rounds` of a prompt already at the context ceiling.
        assert_eq!(1 + compact::MAX_CONTINUATIONS, end.rounds,
            "the turn did not run exactly its legs: {:?}", end);
        assert_eq!(TurnEnd::Capped, end.how,
            "a turn out of continuations must still end at the round limit: {:?}", end);
    }

    #[tokio::test]
    async fn test_each_continuation_is_announced_and_the_last_cap_is_not_one_00() {
        // The continuations are the figure anybody chasing what a long turn cost has to have: a
        // turn that silently ran to six hundred rounds is, in the record and on the bill,
        // indistinguishable from four turns the user asked for.
        let registry = one_tool();
        let (port, _seen) = crate::llm::tests::start_stub(vec![
            tool_round(&[("file_write", r#"{"path":"a.txt","content":"1"}"#)]),
        ]).await;
        let mut llm = crate::llm::tests::stub_client(port);
        llm.retry.max_attempts = 1;
        let a = Agent::new(llm, "You are Daimond.");
        a.set_max_rounds(1);
        let mut session = Session::new(fmt!("s1"), fmt!("legs"), fmt!("model"));
        let mut events: Vec<AgentEvent> = Vec::new();
        let _ = a.run_turn(&mut session, fmt!("carry on"), &registry,
            &mut |ev| events.push(ev)).await;

        let legs: Vec<(usize, usize)> = events.iter().filter_map(|e| match e {
            AgentEvent::Continued { n, rounds_so_far } => Some((*n, *rounds_so_far)),
            _ => None,
        }).collect();
        // THREE, not four.  The fourth cap is the end of the turn and is announced as one; a
        // `Continued` there would tell the page a leg had started that never runs.
        assert_eq!(compact::MAX_CONTINUATIONS, legs.len(), "{:?}", legs);
        // Counting from one, and carrying the TURN's rounds rather than the leg's -- a leg number
        // beside a count that restarts at each leg says nothing about how long the turn is.
        assert_eq!(vec![(1, 1), (2, 2), (3, 3)], legs, "{:?}", legs);
        // AND THE END IS STILL SAID, which is what the user reads.  Nothing is written into the
        // conversation for a continuation, so the ONE system note a capped turn leaves is the one
        // at the end -- otherwise every leg would leave a sentence the model re-reads for the rest
        // of the chat.
        let notes = session.messages.iter().filter(|m| match m {
            ChatMessage::System { content } => content.as_text().contains("tool-call rounds"),
            _ => false,
        }).count();
        assert_eq!(1, notes, "a continuation wrote itself into the conversation");
    }

    #[tokio::test]
    async fn test_a_workers_true_ceiling_is_the_leg_times_its_continuations_00() {
        // Turn 55, 2026-09-14: w21 ran 112 rounds against a `worker_max_rounds` of 100, and that
        // read as a cap the engine had missed. It had not: `hold_to_worker` carries
        // `WORKER_CONTINUATIONS` across too, so a worker's true ceiling is
        // `worker_max_rounds * (1 + worker_continuations)`, and 112 sits twelve rounds into the
        // second leg -- exactly what `at_the_cap` grants once. Pinned at two rounds a leg, so the
        // same shape a hundred rounds a leg makes is proved in milliseconds rather than by
        // replaying a hundred rounds twice.
        let registry = one_tool();
        let (port, _seen) = crate::llm::tests::start_stub(vec![
            tool_round(&[("file_write", r#"{"path":"a.txt","content":"1"}"#)]),
        ]).await;
        let mut llm = crate::llm::tests::stub_client(port);
        llm.retry.max_attempts = 1;
        let a = Agent::new(llm, "You are Daimond.");
        if let Err(e) = a.set_tune(r#"{"worker_max_rounds":2,"worker_continuations":1}"#) {
            panic!("the worker tune was refused: {}", e);
        }
        a.set_worker_limits();
        let mut session = Session::new(fmt!("s1"), fmt!("w21"), fmt!("model"));
        let mut events: Vec<AgentEvent> = Vec::new();
        let _ = a.run_turn(&mut session, fmt!("keep going"), &registry,
            &mut |ev| events.push(ev)).await;

        let legs = events.iter().filter(|e| matches!(e, AgentEvent::Continued { .. })).count();
        assert_eq!(1, legs,
            "a worker's one breath granted something other than one continuation: {}", legs);
        let end = a.ending().unwrap_or_else(|| panic!("a turn ran and said nothing about how it ended"));
        assert_eq!(TurnEnd::Capped, end.how,
            "out of continuations must still end at the round limit: {:?}", end);
        assert_eq!(4, end.rounds,
            "a worker's true ceiling is its leg times (1 + its continuations), not the leg alone: {:?}",
            end);
    }

    #[tokio::test]
    async fn test_an_orphaned_worker_stops_at_its_grace_rather_than_its_ceiling_00() {
        // Proposal 15's drive, 2026-09-15: a `gather` ran out of time at 120 s, the daimon
        // answered, its turn ended -- and the worker went on ALONE for thirty minutes to the
        // full two hundred rounds with nothing left able to read what it found. The ceiling is
        // calibrated for a worker whose report a turn is holding a promise on; once that promise
        // is gone the grace is what it gets. Two rounds here rather than five, so the shape is
        // proved in milliseconds.
        let registry = one_tool();
        let (port, _seen) = crate::llm::tests::start_stub(vec![
            tool_round(&[("file_write", r#"{"path":"a.txt","content":"1"}"#)]),
        ]).await;
        let mut llm = crate::llm::tests::stub_client(port);
        llm.retry.max_attempts = 1;
        let a = Agent::new(llm, "You are Daimond.");
        // A worker's own ceiling, and then the orphaning: the point is that the SECOND is what
        // ends the turn, well inside the first.
        if let Err(e) = a.set_tune(r#"{"worker_max_rounds":50,"worker_continuations":1,
            "orphan_grace_rounds":2}"#) {
            panic!("the worker tune was refused: {}", e);
        }
        a.set_worker_limits();
        a.orphan();
        let mut session = Session::new(fmt!("s1"), fmt!("w-orphan"), fmt!("model"));
        let mut events: Vec<AgentEvent> = Vec::new();
        let _ = a.run_turn(&mut session, fmt!("read the whole repository"), &registry,
            &mut |ev| events.push(ev)).await;

        let end = a.ending().unwrap_or_else(|| panic!("a turn ran and said nothing about how it ended"));
        assert_eq!(TurnEnd::Capped, end.how,
            "an orphaned worker must end at a ceiling, not as though it had answered: {:?}", end);
        assert_eq!(3, end.rounds,
            "the grace is counted from the round it was orphaned in: {:?}", end);
        // AND IT WAS TOLD, once. A bound a model cannot see is a bound it walks into mid-file.
        let told = session.messages.iter().filter(|m| match m {
            ChatMessage::System { content } =>
                content.as_text().contains("The turn that dispatched you has ended"),
            _ => false,
        }).count();
        assert_eq!(1, told, "the worker was told {} times that its dispatcher had gone", told);
        // And the ending note is the orphan's own, not the round limit's: a reader told only
        // "the round limit" would look for a budget that was never spent.
        let note = session.messages.iter().any(|m| match m {
            ChatMessage::System { content } =>
                content.as_text().contains("left nothing waiting for its report"),
            _ => false,
        });
        assert!(note, "the turn ended with no note saying why: {:?}", session.messages.last());
    }

    #[tokio::test]
    async fn test_a_worker_nobody_orphaned_keeps_its_whole_ceiling_00() {
        // The other half, and the one that says the bound above is the orphaning and not the
        // tune: the same figures, nobody orphaning it, and the turn runs its leg and its one
        // continuation to the end.
        let registry = one_tool();
        let (port, _seen) = crate::llm::tests::start_stub(vec![
            tool_round(&[("file_write", r#"{"path":"a.txt","content":"1"}"#)]),
        ]).await;
        let mut llm = crate::llm::tests::stub_client(port);
        llm.retry.max_attempts = 1;
        let a = Agent::new(llm, "You are Daimond.");
        if let Err(e) = a.set_tune(r#"{"worker_max_rounds":2,"worker_continuations":1,
            "orphan_grace_rounds":2}"#) {
            panic!("the worker tune was refused: {}", e);
        }
        a.set_worker_limits();
        let mut session = Session::new(fmt!("s1"), fmt!("w-kept"), fmt!("model"));
        let mut events: Vec<AgentEvent> = Vec::new();
        let _ = a.run_turn(&mut session, fmt!("keep going"), &registry,
            &mut |ev| events.push(ev)).await;

        let end = a.ending().unwrap_or_else(|| panic!("a turn ran and said nothing about how it ended"));
        assert_eq!(4, end.rounds,
            "a worker still being waited for lost rounds to a grace nobody armed: {:?}", end);
        assert!(!a.is_orphaned(), "nothing orphaned this worker and the flag says otherwise");
    }

    #[tokio::test]
    async fn test_live_last_prompt_advances_per_round_on_the_stub_00() {
        // `live_last_prompt` exists because `session.last_prompt_tokens` cannot be read
        // mid-turn: `run_turn` holds the session mutably for the whole of it, so a getter
        // that borrows it panics the `RefCell` if a caller reaches it from an `on_event`
        // fired synchronously inside a round.  This is the stub proof that the agent-side
        // Cell actually tracks the LAST round's figure, not the turn's running total, and
        // that it is already current by the time the round's own event fires -- which is
        // the moment `www/js/daimond.js`'s debug-share `round` payload reads it.
        let registry = one_tool();
        let round_one = crate::llm::tests::Reply::Sse {
            chunks: vec![
                "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"c0\",\
                 \"type\":\"function\",\"function\":{\"name\":\"file_write\",\"arguments\":\
                 \"{\\\"path\\\":\\\"a.txt\\\",\\\"content\\\":\\\"1\\\"}\"}}]}}]}\n\n"
                    .to_string(),
                "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}],\
                 \"usage\":{\"prompt_tokens\":50,\"completion_tokens\":2}}\n\n".to_string(),
                "data: [DONE]\n\n".to_string(),
            ],
            reset_after: None,
        };
        // The turn-ending round: a different figure, so a test that read the FIRST round's
        // value by accident (a stale Cell, or one set before the round it names) would not
        // pass by coincidence.
        let round_two = crate::llm::tests::Reply::Sse {
            chunks: vec![
                "data: {\"choices\":[{\"delta\":{\"content\":\"Done\"}}]}\n\n".to_string(),
                "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":120,\
                 \"completion_tokens\":2}}\n\n".to_string(),
                "data: [DONE]\n\n".to_string(),
            ],
            reset_after: None,
        };
        let (port, _seen) = crate::llm::tests::start_stub(vec![round_one, round_two]).await;
        let mut llm = crate::llm::tests::stub_client(port);
        llm.retry.max_attempts = 1;
        let a = Agent::new(llm, "You are Daimond.");
        a.set_max_rounds(10);
        let mut session = Session::new(fmt!("s1"), fmt!("live"), fmt!("model"));
        // What the FIRST round's tool-call event saw, read the same way the JS round payload
        // does: off the agent, mid-turn, with no session borrow in reach.
        let mut mid_turn_reading = 0u64;
        let res = a.run_turn(&mut session, fmt!("go"), &registry, &mut |ev| {
            if let AgentEvent::ToolCall { .. } = ev {
                mid_turn_reading = a.live_last_prompt.get();
            }
        }).await;
        assert!(res.is_ok(), "{:?}", res);
        assert_eq!(50, mid_turn_reading,
            "the live counter was not current by the time the round's own event fired");
        assert_eq!(120, a.live_last_prompt.get(),
            "the live counter did not move on to the second round's figure");
        assert_eq!(120, session.last_prompt_tokens,
            "the live and the session-borrowing figures disagree once the turn has ended");
    }

    #[test]
    fn test_the_stop_after_three_continuations_names_both_figures_00() {
        // A model told only "the round limit" after six hundred rounds would reasonably expect
        // another Continue to get further, and the continuation count is what says it will not.
        let n = compact::continuation_limit_note(600, 3);
        let said = match &n {
            ChatMessage::System { content } => content.as_text().into_owned(),
            other => panic!("the note was not in the app's own voice: {:?}", other),
        };
        assert!(said.contains("600"), "{}", said);
        assert!(said.contains("3 times"), "{}", said);
        // In the APP's voice, for the reason `round_limit_note` gives: a boundary the app imposed
        // must not read, on the next turn, as something the assistant chose.
        assert!(said.contains("Daimond"), "{}", said);
        assert!(said.contains("did not choose to stop"), "{}", said);
    }

    #[test]
    fn test_the_spend_ceiling_is_five_dollars_until_the_user_says_otherwise_00() {
        // The figure that actually holds a runaway, now that the round limit carries a turn on by
        // itself. It has to be visible and movable: five dollars is a day's work on a cheap model
        // and two legs on an expensive one, and only the payer knows which they meant.
        assert_eq!(5.0, compact::DEFAULT_SPEND_CAP_USD);
        let a = dead_agent();
        assert_eq!(compact::DEFAULT_SPEND_CAP_USD, a.limits().spend_cap_usd);

        a.set_spend_cap_usd(2.5);
        assert_eq!(2.5, a.limits().spend_cap_usd);
        // Zero is how "the user has not chosen" travels, exactly as it does for the context
        // ceiling, so the shipped figure is named in one place.
        a.set_spend_cap_usd(0.0);
        assert_eq!(compact::DEFAULT_SPEND_CAP_USD, a.limits().spend_cap_usd);
        // Held at the band HERE and not only where it is read, so a control drawn from the getter
        // shows the figure the arithmetic used.
        a.set_spend_cap_usd(0.0001);
        assert_eq!(compact::SPEND_CAP_MIN_USD, a.limits().spend_cap_usd);
        a.set_spend_cap_usd(1.0e9);
        assert_eq!(compact::SPEND_CAP_MAX_USD, a.limits().spend_cap_usd);
    }

    #[tokio::test]
    async fn test_a_turn_past_its_spend_ceiling_stops_at_the_round_seam_00() {
        // Two rounds at three dollars each against a five-dollar ceiling: the first is under it and
        // the second is not, so the turn stops at the seam after the second rather than buying a
        // third round first. The round limit is ten and nowhere near reached -- what is under test
        // is the money, and a turn stopped by the rounds would pass this for the wrong reason.
        let registry = one_tool();
        let (port, _seen) = crate::llm::tests::start_stub(vec![round_costing(3.0)]).await;
        let mut llm = crate::llm::tests::stub_client(port);
        llm.retry.max_attempts = 1;
        let a = Agent::new(llm, "You are Daimond.");
        a.set_max_rounds(10);
        a.set_spend_cap_usd(5.0);
        let mut session = Session::new(fmt!("s1"), fmt!("spend"), fmt!("model"));
        let mut events: Vec<AgentEvent> = Vec::new();
        let _ = a.run_turn(&mut session, fmt!("do the work"), &registry,
            &mut |ev| events.push(ev)).await;

        let end = match a.ending() {
            Some(e) => e,
            None    => panic!("a turn ran and said nothing about how it ended"),
        };
        // ITS OWN ENDING, not `Capped`: a user whose turn stopped on money and was told it ran out
        // of rounds would raise the round limit, which is the one remedy that cannot work.
        assert_eq!(TurnEnd::SpendCapped, end.how, "{:?}", end);
        assert_eq!(2, end.rounds, "the turn bought a round past its ceiling: {:?}", end);
        // AND BOTH FIGURES ARE SAID. A ceiling the reader cannot see is one they cannot move.
        let said = session.messages.iter().filter_map(|m| match m {
            ChatMessage::System { content } => {
                let t = content.as_text().into_owned();
                if t.contains("spent") { Some(t) } else { None }
            }
            _ => None,
        }).next().unwrap_or_default();
        assert!(said.contains("6.00"), "{}", said);
        assert!(said.contains("5.00"), "{}", said);
    }

    #[tokio::test]
    async fn test_a_turn_whose_provider_quotes_no_price_is_never_stopped_on_money_00() {
        // DELIBERATE, and the reason is in `over_the_spend_cap`: several endpoints report no cost
        // at all and a local model costs nothing by definition. A ceiling enforced on a figure of
        // zero either never fires or, made to guess, ends turns over a price nobody quoted. So a
        // priceless turn runs to its ROUNDS -- which is what the backstop is for.
        let registry = one_tool();
        let a = {
            let (port, _seen) = crate::llm::tests::start_stub(vec![
                tool_round(&[("file_write", r#"{"path":"a.txt","content":"1"}"#)]),
            ]).await;
            let mut llm = crate::llm::tests::stub_client(port);
            llm.retry.max_attempts = 1;
            let a = Agent::new(llm, "You are Daimond.");
            a.set_max_rounds(1);
            // A ceiling a round of ANY reported price would break, so only a figure of zero can
            // carry this turn to its round limit.
            a.set_spend_cap_usd(compact::SPEND_CAP_MIN_USD);
            let mut session = Session::new(fmt!("s1"), fmt!("free"), fmt!("model"));
            let _ = a.run_turn(&mut session, fmt!("do the work"), &registry, &mut |_| {}).await;
            a
        };
        let end = match a.ending() {
            Some(e) => e,
            None    => panic!("a turn ran and said nothing about how it ended"),
        };
        assert_eq!(TurnEnd::Capped, end.how,
            "a turn with no reported cost was stopped on money: {:?}", end);
        assert_eq!(1 + compact::MAX_CONTINUATIONS, end.rounds, "{:?}", end);
    }

    #[tokio::test]
    async fn test_the_spend_ceiling_is_read_again_before_a_continuation_is_granted_00() {
        // Granting a continuation commits the user to another `max_rounds` of spending, so the
        // ceiling is read at that point as well as at the seam -- and the fold the cap forces is
        // itself a paid model call, so a turn a cent under the line at the seam can be over it by
        // the time the next leg would start.
        let registry = one_tool();
        let (port, _seen) = crate::llm::tests::start_stub(vec![round_costing(9.0)]).await;
        let mut llm = crate::llm::tests::stub_client(port);
        llm.retry.max_attempts = 1;
        let a = Agent::new(llm, "You are Daimond.");
        a.set_max_rounds(1);
        a.set_spend_cap_usd(5.0);
        let mut session = Session::new(fmt!("s1"), fmt!("leg-money"), fmt!("model"));
        let mut events: Vec<AgentEvent> = Vec::new();
        let _ = a.run_turn(&mut session, fmt!("do the work"), &registry,
            &mut |ev| events.push(ev)).await;

        assert_eq!(Some(TurnEnd::SpendCapped), a.ending().map(|e| e.how),
            "a turn nine dollars over its ceiling took another leg");
        let legs = events.iter().filter(|e| matches!(e, AgentEvent::Continued { .. })).count();
        assert_eq!(0, legs, "a continuation was announced for a turn that had spent its ceiling");
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

    #[tokio::test]
    async fn test_a_tool_using_worker_with_an_empty_final_reply_is_nudged_to_write_its_report_00() {
        // Ontheism worker-report fix. A worker that did its work through TOOLS and then returned
        // an EMPTY final reply wrote no report -- and the fan-out that dispatched it reads that
        // silence as "nothing found", re-dispatching FINISHED work. So an empty reply in a turn
        // whose `claims.calls > 0` is nudged ONCE to write its report, exactly as a reasoned-only
        // round is nudged to finish its thought. Without the nudge the turn ends `Silent` at the
        // empty round -- one round early, with no report at all -- which is what this asserts is
        // no longer so.
        let registry = one_tool();
        // Round 1: a tool call, so the turn has done work by the empty round.
        let tool_round = crate::llm::tests::Reply::Sse {
            chunks: vec![
                "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"c0\",\
                 \"type\":\"function\",\"function\":{\"name\":\"file_write\",\"arguments\":\
                 \"{\\\"path\\\":\\\"a.txt\\\",\\\"content\\\":\\\"1\\\"}\"}}]}}]}\n\n".to_string(),
                "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n".to_string(),
                "data: [DONE]\n\n".to_string(),
            ],
            reset_after: None,
        };
        // Round 2: an empty final reply, no reasoning -- the shape that used to end `Silent`.
        let empty_round = crate::llm::tests::Reply::Sse {
            chunks: vec![
                "data: {\"choices\":[{\"delta\":{}}]}\n\n".to_string(),
                "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n".to_string(),
                "data: [DONE]\n\n".to_string(),
            ],
            reset_after: None,
        };
        // Round 3: the report the nudge asks for. Only reached if the empty round was nudged.
        let report_round = sse_saying("I wrote a.txt; it holds 1.");
        let (port, seen) = crate::llm::tests::start_stub(
            vec![tool_round, empty_round, report_round]).await;
        let mut llm = crate::llm::tests::stub_client(port);
        llm.retry.max_attempts = 1;
        let a = Agent::new(llm, "You are Daimond.");
        a.set_max_rounds(10);
        let mut session = Session::new(fmt!("s1"), fmt!("worker-report"), fmt!("model"));
        let _ = a.run_turn(&mut session, fmt!("do the work"), &registry, &mut |_| {}).await;

        let end = a.ending().expect("the turn said nothing about how it ended");
        // The empty round did NOT end the turn: it was nudged, and a report followed.
        assert_eq!(TurnEnd::Answered, end.how,
            "an empty final reply after tool work ended the turn instead of being nudged to \
             report: {:?}", end);
        assert_eq!(1, end.calls, "the tool call the worker made was not counted: {:?}", end);
        // THE NUDGE REACHED THE MODEL: the report round was actually requested. Two rounds means
        // the empty reply ended the turn (the pre-fix behaviour); three means it was nudged.
        let asked = match seen.lock() { Ok(g) => g.bodies.len(), Err(e) => panic!("{}", e) };
        assert_eq!(3, asked,
            "the worker was not nudged to write its report -- the turn ended at the empty round \
             ({} rounds requested)", asked);
    }

    #[test]
    fn test_an_ending_travels_as_one_of_six_words_00() {
        // Spelled once, for the reason `CallOutcome::wire` is: the browser knows these words and
        // no others, so a second speller would not fail loudly -- it would draw an ending nobody
        // recognises, which is the silence this whole mechanism replaces.
        let all = [
            (TurnEnd::Answered,    "answered"),
            (TurnEnd::Stopped,     "stopped"),
            (TurnEnd::Capped,      "capped"),
            (TurnEnd::SpendCapped, "spend_cap"),
            (TurnEnd::Silent,      "silent"),
            (TurnEnd::Failed,      "failed"),
        ];
        for (end, word) in all {
            assert_eq!(word, end.wire(), "{:?}", end);
        }
        // `Stopped` is the browser's alone: the native transport has no cancellation path, so
        // `stream_sse` always reports a stream that ran to its end. It is spelled here so the two
        // halves of the seam agree about a word only one of them can produce.
        assert_eq!("stopped", TurnEnd::Stopped.wire());
    }

    #[test]
    fn test_the_page_knows_the_two_words_a_stopped_turn_can_arrive_as_00() {
        // THE FEED'S `endedHow` IS THE SECOND SPELLER this mechanism warns about, and a word it
        // does not know is not an error -- it is drawn as `done`, which is the silence the ending
        // exists to replace. So the page is asked, here, in a millisecond.
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("www/js/daimond.js");
        let src = match std::fs::read_to_string(&path) {
            Ok(s)  => s,
            Err(e) => { eprintln!("the page could not be read ({}), so the mapping was not \
                checked: {}", path.display(), e); return; },
        };
        for end in [TurnEnd::Capped, TurnEnd::SpendCapped] {
            let want = fmt!("case '{}':", end.wire());
            assert!(src.contains(&want),
                "the page does not map {:?}; `endedHow` should carry `{}`", end, want);
        }
        // AND THE TWO ARE NOT COLLAPSED. The remedy differs -- one is a round limit to raise and
        // one is a ceiling in dollars -- so a reader sent to the wrong setting has been told the
        // wrong thing about what stopped their turn.
        assert!(src.contains("return 'round_limit';"), "the round-limit case lost its word");
        assert!(src.contains("return 'spend_cap';"), "the spend-ceiling case lost its word");
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

    /// One SSE round whose whole reply is `text`, ending on `stop`.
    fn sse_saying(text: &str) -> crate::llm::tests::Reply {
        crate::llm::tests::Reply::Sse {
            chunks: vec![
                fmt!("data: {{\"choices\":[{{\"delta\":{{\"content\":\"{}\"}}}}]}}\n\n", text),
                fmt!("data: {{\"choices\":[{{\"delta\":{{}},\"finish_reason\":\"stop\"}}]}}\n\n"),
                fmt!("data: [DONE]\n\n"),
            ],
            reset_after: None,
        }
    }

    /// One SSE round whose whole reply is reasoning -- no content, no tool call.  Proposal
    /// 15, 2026-09-15: exactly this shape, 3,372 tokens of it, ending mid-sentence.
    fn sse_reasoning_only(think: &str) -> crate::llm::tests::Reply {
        crate::llm::tests::Reply::Sse {
            chunks: vec![
                fmt!("data: {{\"choices\":[{{\"delta\":{{\"reasoning\":\"{}\"}}}}]}}\n\n", think),
                fmt!("data: {{\"choices\":[{{\"delta\":{{}},\"finish_reason\":\"stop\"}}]}}\n\n"),
                fmt!("data: [DONE]\n\n"),
            ],
            reset_after: None,
        }
    }

    /// A single HTTP 429, the shape `LlmClient`'s own retry ladder is meant to absorb before
    /// it ever reaches the agent as a round.
    fn http_429() -> crate::llm::tests::Reply {
        crate::llm::tests::Reply::Http {
            status: 429, reason: "Too Many Requests", headers: Vec::new(),
            body: "{\"error\":{\"message\":\"rate limited\"}}".to_string(),
        }
    }

    /// A leaked tool call is nudged ONCE and the round is sent again.
    ///
    /// Turn 56 of 2026-09-14: the round came back carrying glm-5.3's own call syntax as
    /// content, `tool_calls` was empty, and the turn ended `answered` with `calls: 0` in 39
    /// seconds.  The model had planned the call correctly and the wire lost it; one nudge is
    /// what that costs, and the turn goes on.
    #[tokio::test]
    async fn test_a_tool_call_that_arrived_as_text_is_nudged_and_the_turn_goes_on_00() {
        use crate::llm::tests::{start_stub, stub_client, LEAK_HEADLESS};
        let (port, seen) = start_stub(vec![
            sse_saying(LEAK_HEADLESS),
            sse_saying("Right, it verified."),
        ]).await;
        let mut llm = stub_client(port);
        llm.retry.max_attempts = 1;
        let a = Agent::new(llm, "You are Daimond.");
        a.set_max_rounds(4);

        let registry = one_tool();
        let mut session = Session::new(fmt!("s1"), fmt!("leak"), fmt!("z-ai/glm-5.3"));
        let mut events: Vec<AgentEvent> = Vec::new();
        let _ = a.run_turn(&mut session, fmt!("run verify"), &registry,
            &mut |ev| events.push(ev)).await;

        // THE EVENT, which is the whole of what was missing: nothing anywhere said a call
        // had been lost.
        let leaked: Vec<&AgentEvent> = events.iter()
            .filter(|e| matches!(e, AgentEvent::Leaked { .. })).collect();
        assert_eq!(1, leaked.len(), "the leak was not reported: {:?}", leaked);
        match leaked[0] {
            AgentEvent::Leaked { fragment, recovered } => {
                assert_eq!(LEAK_HEADLESS, fragment, "the fragment was not carried verbatim");
                assert!(!recovered, "a headless fragment was claimed as recovered");
            }
            _ => panic!("not a leak event"),
        }
        // THE NUDGE REACHED THE MODEL, in the family's own words.
        let asked = match seen.lock() { Ok(g) => g.bodies.clone(), Err(e) => panic!("{}", e) };
        assert_eq!(2, asked.len(), "the round was not sent again: {} request(s)", asked.len());
        assert!(asked[1].contains("arrived as text"),
            "the second request carried no nudge: {}", asked[1]);
        assert!(asked[1].contains("arg_key"),
            "Glm's own hint did not ride with the nudge: {}", asked[1]);
        // AND THE TURN ANSWERED, because one leak is a wire fault and not a broken model.
        match events.iter().find(|e| matches!(e, AgentEvent::Ended { .. })) {
            Some(AgentEvent::Ended { how, malformed, rounds, .. }) => {
                assert_eq!("answered", how, "one leak ended the turn");
                assert_eq!(1, *malformed, "the re-sent round was not counted");
                assert_eq!(2, *rounds, "the nudge did not cost exactly one round");
            }
            _ => panic!("no ending to read"),
        }
    }

    /// A SECOND leak in a row ends the turn under its own word, never `answered`.
    #[tokio::test]
    async fn test_two_leaks_in_a_row_end_the_turn_malformed_and_not_answered_00() {
        use crate::llm::tests::{start_stub, stub_client, LEAK_HEADLESS};
        let (port, _seen) = start_stub(vec![
            sse_saying(LEAK_HEADLESS),
            sse_saying(LEAK_HEADLESS),
        ]).await;
        let mut llm = stub_client(port);
        llm.retry.max_attempts = 1;
        let a = Agent::new(llm, "You are Daimond.");
        a.set_max_rounds(6);

        let registry = one_tool();
        let mut session = Session::new(fmt!("s1"), fmt!("leak2"), fmt!("z-ai/glm-5.3"));
        let mut events: Vec<AgentEvent> = Vec::new();
        let _ = a.run_turn(&mut session, fmt!("run verify"), &registry,
            &mut |ev| events.push(ev)).await;

        assert_eq!(2, events.iter().filter(|e| matches!(e, AgentEvent::Leaked { .. })).count(),
            "both leaks must be reported, not just the one that ended the turn");
        match events.iter().find(|e| matches!(e, AgentEvent::Ended { .. })) {
            Some(AgentEvent::Ended { how, malformed, calls, .. }) => {
                // THE WHOLE POINT. `answered` here is the defect.
                assert_eq!("malformed", how, "a wire fault was reported as an answer");
                assert_eq!(2, *malformed, "end_log.malformed did not count both rounds");
                assert_eq!(0, *calls, "nothing ran, and the count must say so");
            }
            _ => panic!("no ending to read"),
        }
        // And the ending asks to be read, rather than sitting as furniture.
        let end = a.ending().unwrap_or_else(|| panic!("the turn recorded no ending"));
        assert_eq!(TurnEnd::Malformed, end.how);
        assert!(end.unaccounted(), "a turn that called nothing was drawn as accounted for");
    }

    /// A leak with its head still on it is RECOVERED: the tool runs, the turn is not nudged.
    #[tokio::test]
    async fn test_a_whole_leaked_call_is_recovered_and_the_turn_never_stalls_00() {
        use crate::llm::tests::{start_stub, stub_client, LEAK_WHOLE};
        let (port, _seen) = start_stub(vec![
            sse_saying(LEAK_WHOLE),
            sse_saying("Verified."),
        ]).await;
        let mut llm = stub_client(port);
        llm.retry.max_attempts = 1;
        let a = Agent::new(llm, "You are Daimond.");
        a.set_max_rounds(4);

        let registry = one_tool();
        let mut session = Session::new(fmt!("s1"), fmt!("leak3"), fmt!("z-ai/glm-5.3"));
        let mut events: Vec<AgentEvent> = Vec::new();
        let _ = a.run_turn(&mut session, fmt!("run verify"), &registry,
            &mut |ev| events.push(ev)).await;

        match events.iter().find(|e| matches!(e, AgentEvent::Leaked { .. })) {
            Some(AgentEvent::Leaked { recovered, .. }) =>
                assert!(*recovered, "a whole call was reported as unrecoverable"),
            _ => panic!("a recovered leak went unreported, so nobody can measure it"),
        }
        // The recovered call was DISPATCHED -- `verify` is not in this registry, so the door
        // answers rather than the tool, but the round is a tool round either way.
        assert!(events.iter().any(|e| matches!(e, AgentEvent::ToolCall { .. })),
            "the recovered call was never dispatched");
        match events.iter().find(|e| matches!(e, AgentEvent::Ended { .. })) {
            Some(AgentEvent::Ended { how, malformed, .. }) => {
                assert_eq!("answered", how, "a recovered leak ended the turn");
                assert_eq!(0, *malformed,
                    "a recovered leak cost no round and must not be counted as one");
            }
            _ => panic!("no ending to read"),
        }
    }

    // ── A round that reasoned and said nothing ──────────────────────────────

    /// Reasoning-only is nudged ONCE and the turn goes on to answer.
    ///
    /// Proposal 15, 2026-09-15: a round returned 3,372 tokens of reasoning, an empty
    /// `content`, and no tool call, ending mid-sentence.  The engine took that for a plain
    /// empty answer and booked the turn `silent` -- 318 s and US$0.10 for nothing that
    /// looked, from the outside, like it might have worked.
    #[tokio::test]
    async fn test_reasoning_only_is_nudged_then_the_turn_answers_00() {
        use crate::llm::tests::{start_stub, stub_client};
        let (port, seen) = start_stub(vec![
            sse_reasoning_only("One more thing: let me check the file before I answer."),
            sse_saying("Here is the answer."),
        ]).await;
        let mut llm = stub_client(port);
        llm.retry.max_attempts = 1;
        let a = Agent::new(llm, "You are Daimond.");
        a.set_max_rounds(4);

        let registry = one_tool();
        let mut session = Session::new(fmt!("s1"), fmt!("reasoned1"), fmt!("z-ai/glm-5.3"));
        let mut events: Vec<AgentEvent> = Vec::new();
        let _ = a.run_turn(&mut session, fmt!("do the thing"), &registry,
            &mut |ev| events.push(ev)).await;

        // THE NUDGE REACHED THE MODEL, in its own words.
        let asked = match seen.lock() { Ok(g) => g.bodies.clone(), Err(e) => panic!("{}", e) };
        assert_eq!(2, asked.len(), "the round was not sent again: {} request(s)", asked.len());
        assert!(asked[1].contains("neither answered nor called a tool"),
            "the second request carried no nudge: {}", asked[1]);
        // AND THE TURN ANSWERED, because one reasoning-only round is not a broken model.
        match events.iter().find(|e| matches!(e, AgentEvent::Ended { .. })) {
            Some(AgentEvent::Ended { how, reasoned, rounds, .. }) => {
                assert_eq!("answered", how, "one reasoning-only round ended the turn");
                assert_eq!(1, *reasoned, "the re-sent round was not counted");
                assert_eq!(2, *rounds, "the nudge did not cost exactly one round");
            }
            _ => panic!("no ending to read"),
        }
    }

    /// REASONING-ONLY TWICE IN A ROW ends the turn under its own word, never `silent` and
    /// never `answered`.
    #[tokio::test]
    async fn test_reasoning_only_twice_ends_the_turn_honestly_00() {
        use crate::llm::tests::{start_stub, stub_client};
        let (port, _seen) = start_stub(vec![
            sse_reasoning_only("Thinking about the first step."),
            sse_reasoning_only("Still thinking, this time about the second."),
        ]).await;
        let mut llm = stub_client(port);
        llm.retry.max_attempts = 1;
        let a = Agent::new(llm, "You are Daimond.");
        a.set_max_rounds(6);

        let registry = one_tool();
        let mut session = Session::new(fmt!("s1"), fmt!("reasoned2"), fmt!("z-ai/glm-5.3"));
        let mut events: Vec<AgentEvent> = Vec::new();
        let _ = a.run_turn(&mut session, fmt!("do the thing"), &registry,
            &mut |ev| events.push(ev)).await;

        match events.iter().find(|e| matches!(e, AgentEvent::Ended { .. })) {
            Some(AgentEvent::Ended { how, reasoned, calls, .. }) => {
                // THE WHOLE POINT. Neither `silent` nor `answered` here is honest; only
                // `reasoned_only` says what actually happened.
                assert_eq!("reasoned_only", how,
                    "a turn that reasoned twice and answered nothing was not reported honestly");
                assert_eq!(2, *reasoned, "end_log.reasoned did not count both rounds");
                assert_eq!(0, *calls, "nothing ran, and the count must say so");
            }
            _ => panic!("no ending to read"),
        }
        let end = a.ending().unwrap_or_else(|| panic!("the turn recorded no ending"));
        assert_eq!(TurnEnd::ReasonedOnly, end.how);
        assert!(end.unaccounted(), "a turn that answered nothing was drawn as accounted for");
    }

    /// A round that reasoned AND answered is never nudged: content present is untouched.
    #[tokio::test]
    async fn test_reasoning_beside_an_answer_is_never_nudged_00() {
        use crate::llm::tests::{start_stub, stub_client, Reply};
        let (port, seen) = start_stub(vec![Reply::Sse {
            chunks: vec![
                "data: {\"choices\":[{\"delta\":{\"reasoning\":\"Let me check.\"}}]}\n\n"
                    .to_string(),
                "data: {\"choices\":[{\"delta\":{\"content\":\"Done.\"}}]}\n\n".to_string(),
                "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n".to_string(),
                "data: [DONE]\n\n".to_string(),
            ],
            reset_after: None,
        }]).await;
        let mut llm = stub_client(port);
        llm.retry.max_attempts = 1;
        let a = Agent::new(llm, "You are Daimond.");
        a.set_max_rounds(4);

        let registry = one_tool();
        let mut session = Session::new(fmt!("s1"), fmt!("reasoned3"), fmt!("z-ai/glm-5.3"));
        let mut events: Vec<AgentEvent> = Vec::new();
        let _ = a.run_turn(&mut session, fmt!("do the thing"), &registry,
            &mut |ev| events.push(ev)).await;

        let asked = match seen.lock() { Ok(g) => g.bodies.clone(), Err(e) => panic!("{}", e) };
        assert_eq!(1, asked.len(),
            "a round that answered was sent again, which the reasoning-only path must never do");
        match events.iter().find(|e| matches!(e, AgentEvent::Ended { .. })) {
            Some(AgentEvent::Ended { how, reasoned, .. }) => {
                assert_eq!("answered", how);
                assert_eq!(0, *reasoned, "a round with an answer must never count as reasoning-only");
            }
            _ => panic!("no ending to read"),
        }
    }

    /// A 429 IS UNTOUCHED: the transport's own retry ladder absorbs it inside one round,
    /// and the reasoning-only machinery never sees it as a round of its own.
    #[tokio::test]
    async fn test_a_429_before_the_answer_is_retried_and_never_read_as_reasoning_only_00() {
        use crate::llm::tests::{start_stub, stub_client};
        let (port, seen) = start_stub(vec![http_429(), sse_saying("All good now.")]).await;
        let llm = stub_client(port);
        let a = Agent::new(llm, "You are Daimond.");
        a.set_max_rounds(4);

        let registry = one_tool();
        let mut session = Session::new(fmt!("s1"), fmt!("retry429"), fmt!("z-ai/glm-5.3"));
        let mut events: Vec<AgentEvent> = Vec::new();
        let _ = a.run_turn(&mut session, fmt!("do the thing"), &registry,
            &mut |ev| events.push(ev)).await;

        match events.iter().find(|e| matches!(e, AgentEvent::Ended { .. })) {
            Some(AgentEvent::Ended { how, reasoned, malformed, rounds, .. }) => {
                assert_eq!("answered", how, "a 429 followed by a real answer must still answer");
                assert_eq!(0, *reasoned, "a transport retry is not a reasoning-only round");
                assert_eq!(0, *malformed, "a transport retry is not a leaked tool call either");
                assert_eq!(1, *rounds,
                    "the 429 is retried inside the client, and must not count as a second round");
            }
            _ => panic!("no ending to read"),
        }
        let bodies = match seen.lock() { Ok(g) => g.bodies.len(), Err(e) => panic!("{}", e) };
        assert_eq!(2, bodies, "the 429 must still be retried at the transport level");
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

    /// A non-streaming completion carrying `text`, which is what `chat_once` reads.
    ///
    /// The summarising call is tool-less and non-streaming, so a fold's answer never comes
    /// through the SSE path the rest of these fixtures use.
    fn completion(text: &str) -> crate::llm::tests::Reply {
        let body = fmt!(
            "{{\"choices\":[{{\"message\":{{\"role\":\"assistant\",\"content\":\"{}\"}},\
             \"finish_reason\":\"stop\"}}],\"usage\":{{\"prompt_tokens\":9,\
             \"completion_tokens\":9}}}}",
            crate::llm::json_escape(text));
        crate::llm::tests::Reply::Http {
            status: 200, reason: "OK",
            headers: vec![("Content-Type", "application/json".to_string())],
            body,
        }
    }

    /// A conversation long enough that `tail_start` has something to cut.
    ///
    /// [`bulky_session`] is deliberately too SHORT to fold -- four messages, under
    /// `MIN_KEEP_MESSAGES` -- so it exercises elision and never the summarising call.  These
    /// tests are about what the summarising call comes back with, so they need the other shape.
    ///
    /// # Arguments
    /// * `pairs` - User/assistant rounds.
    /// * `bytes` - Roughly what each answer weighs.
    fn foldable_session(pairs: usize, bytes: usize) -> Session {
        let mut session = Session::new(fmt!("s"), fmt!("foldable"), fmt!("model"));
        for i in 0..pairs {
            session.messages.push(ChatMessage::user(fmt!("ask {}", i)));
            session.messages.push(ChatMessage::Assistant {
                content: MessageContent::text(fmt!("answer {} {}", i, "y".repeat(bytes))),
                tool_calls: Vec::new(),
            });
        }
        session
    }

    /// The layout the compactor is told to write, as a stub would answer it.
    fn structured_fold_reply() -> &'static str {
        "## Task\nMake the caps agree.\n## Next step\nRewrite m07.js.\n## Found\n- m07.js CAP=4120\n"
    }

    #[tokio::test]
    async fn test_a_structured_reply_folds_into_a_structured_notice_00() {
        // End to end through the engine rather than over `parse_fold_notes` alone: the parse is
        // proved in `compact`, and what is proved here is that `fold_if_needed` ASKS it, keeps
        // what it returns, and writes it into the conversation the model will read next.
        let (port, seen) = crate::llm::tests::start_stub(
            vec![completion(structured_fold_reply()), plain_answer()]).await;
        let a = Agent::new(crate::llm::tests::stub_client(port), "You are Daimond.");
        a.set_context_window(20_000);
        let mut session = foldable_session(30, 3_000);
        let registry = no_tools();
        let mut events: Vec<AgentEvent> = Vec::new();
        let _ = a.run_turn(&mut session, fmt!("carry on"), &registry,
            &mut |ev| events.push(ev)).await;

        let folded = events.iter().any(|e| matches!(e, AgentEvent::Compacted { .. }));
        assert!(folded, "nothing was folded, so there is no notice to look at");
        assert!(events.iter().any(|e| matches!(e,
            AgentEvent::Compacted { structured: true, .. })),
            "the fold did not report itself as structured, so nothing downstream can count it");
        let note = session.messages.iter()
            .find(|m| m.text().starts_with("[Daimond folded the earlier part"))
            .map(|m| m.text().to_string())
            .unwrap_or_default();
        assert!(note.contains("## Task"), "the notice lost the structure:\n{}", note);
        assert!(note.contains("## Next step"), "{}", note);
        assert!(note.contains("m07.js CAP=4120"),
            "the value the fold exists to carry did not survive it:\n{}", note);
        assert!(!note.contains("## What happened"),
            "a structured notice must not also carry the prose heading:\n{}", note);

        // AND THE SHAPE WAS ASKED FOR, over whatever prompt the user has. Read out of the
        // request the stub really received, because a note appended by a function nothing calls
        // is a note that is not in the prompt.
        let bodies = match seen.lock() { Ok(g) => g.bodies.clone(), Err(e) => panic!("{}", e) };
        let fold_req = bodies.iter().find(|b| b.contains("folding the earlier part"))
            .cloned().unwrap_or_default();
        assert!(!fold_req.is_empty(), "no summarising call was made");
        assert!(fold_req.contains("## Files edited"),
            "the compactor was not told the layout:\n{}", &fold_req[..fold_req.len().min(600)]);
    }

    #[tokio::test]
    async fn test_a_fold_moves_the_turns_own_start_with_it_00() {
        // THE VERIFIER'S SHAPE, AND THE OWNER'S: two hundred small messages before the turn, the
        // whole thing over the window, so the turn folds before its first request. The turn-end
        // check in `steer_inner` then reads `session.messages[turn_start..]` to see what THIS
        // turn wrote -- and on 2026-09-15 it took `turn_start` as the length before the turn,
        // which a fold of 178 messages had just made an index past the end of a 27-message
        // list. In the browser that is a trap, and a trapped future settles nothing: every
        // padded fold in `dev/verify_foldabsorb.mjs` and `dev/verify_neverforget.mjs` sat until
        // the outer timeout with the mock's log showing both requests answered.
        let (port, _seen) = crate::llm::tests::start_stub(
            vec![completion(structured_fold_reply()), plain_answer()]).await;
        let a = Agent::new(crate::llm::tests::stub_client(port), "You are Daimond.");
        a.set_context_window(20_000);
        let mut session = foldable_session(100, 600);
        let before = session.messages.len();
        let registry = no_tools();
        let mut events: Vec<AgentEvent> = Vec::new();
        let _ = a.run_turn(&mut session, fmt!("carry on"), &registry,
            &mut |ev| events.push(ev)).await;
        let note = events.iter().find_map(|e| match e {
            AgentEvent::Compacted { note, .. } => Some(note.clone()),
            _ => None,
        }).expect("a conversation many times its window must have folded");
        assert!(note.starts_with("Folded "), "the fixture must fold, not elide: {}", note);
        assert!(session.messages.len() < before,
            "the fold left the list no shorter ({} -> {}), so the old index would not have \
             reached past it and this proves nothing", before, session.messages.len());
        // The index the caller took would have been `before`, which is now out of range.
        let start = a.turn_start();
        assert!(start < session.messages.len(),
            "turn_start {} is not inside the {} messages the fold left", start,
            session.messages.len());
        assert_eq!("carry on", session.messages[start].text(),
            "turn_start does not name the sentence the turn began with");
        // And nothing of the turn's own is before it: the slot ahead is the fold's notice or an
        // earlier turn's, never this turn's user message twice over.
        assert!(!session.messages[..start].iter().any(|m| m.text() == "carry on"),
            "the turn's own sentence sits before turn_start");
    }

    #[tokio::test]
    async fn test_a_garbage_reply_still_folds_and_still_announces_00() {
        // A malformed reply costs the STRUCTURE and nothing else. The turn must never lose its
        // fold to a model that answered in paragraphs -- which is the whole reason the parse
        // falls back rather than refusing.
        let (port, _seen) = crate::llm::tests::start_stub(
            vec![completion("I read some files and changed one of them, probably."),
                plain_answer()]).await;
        let a = Agent::new(crate::llm::tests::stub_client(port), "You are Daimond.");
        a.set_context_window(20_000);
        let mut session = foldable_session(30, 3_000);
        let registry = no_tools();
        let mut events: Vec<AgentEvent> = Vec::new();
        let _ = a.run_turn(&mut session, fmt!("carry on"), &registry,
            &mut |ev| events.push(ev)).await;

        assert!(events.iter().any(|e| matches!(e, AgentEvent::Compacted { .. })),
            "a fold was lost because the model did not write the layout");
        assert!(events.iter().any(|e| matches!(e,
            AgentEvent::Compacted { structured: false, .. })),
            "a prose fold must report itself as prose, or the count of structured folds lies");
        let note = session.messages.iter()
            .find(|m| m.text().starts_with("[Daimond folded the earlier part"))
            .map(|m| m.text().to_string())
            .unwrap_or_default();
        assert!(note.contains("## What happened"), "the prose is still the note:\n{}", note);
        assert!(note.contains("probably"), "and it is the model's own words:\n{}", note);
    }

    #[tokio::test]
    async fn test_the_capped_fold_prefaces_the_summariser_with_the_continuation_00() {
        // A capped fold is a different job from an ordinary one: the turn CONTINUES from the
        // note in the next round, so `## Next step` is the plan it starts on. Asserted against
        // the request body, because a preface composed and not sent is no preface.
        let (port, seen) = crate::llm::tests::start_stub(
            vec![completion(structured_fold_reply())]).await;
        let a = Agent::new(crate::llm::tests::stub_client(port), "You are Daimond.");
        a.set_context_window(20_000);
        // SMALL ENOUGH THAT THE ORDINARY CUT IS NOTHING, which is the ordinary shape of a
        // capped turn and the reason a fold fired once in four hundred and twenty-two bank
        // trials. `compact::capped_cut` is what gives this turn a note at all.
        let mut session = foldable_session(10, 1_200);
        assert_eq!(0, compact::tail_start(&session.messages, u64::MAX,
            compact::MIN_KEEP_MESSAGES, u64::MAX, &crate::llm::OpenSet::new()),
            "the fixture has to be one the ordinary cut declines, or this proves nothing");
        let mut working = session.messages.clone();
        let mut events: Vec<AgentEvent> = Vec::new();
        a.fold_if_needed(&mut session, &mut working, 0, Fold::Capped,
            &mut |ev| events.push(ev)).await;

        let bodies = match seen.lock() { Ok(g) => g.bodies.clone(), Err(e) => panic!("{}", e) };
        let fold_req = bodies.iter().find(|b| b.contains("folding the earlier part"))
            .cloned().unwrap_or_default();
        assert!(!fold_req.is_empty(), "no summarising call was made at the cap");
        assert!(fold_req.contains("hit its round limit and CONTINUES"),
            "the compactor was not told the turn carries on from its note");
        assert!(fold_req.contains("Write `## Next step` as the plan it starts on"),
            "nor what that makes `## Next step`");
        let note = session.messages.iter()
            .find(|m| m.text().starts_with("[Daimond folded the earlier part"))
            .map(|m| m.text().to_string())
            .unwrap_or_default();
        assert!(note.contains("The turn continues from here: Rewrite m07.js"),
            "the capped notice does not open its next step as a continuation:\n{}", note);
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
