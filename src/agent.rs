//! Agent loop — the core Daimond agent that drives conversations.
//!
//! Receives a user message, sends it to the LLM with conversation
//! history, streams the response back to the client via events,
//! and stores the exchange in the session.

use oxedyne_fe2o3_core::prelude::*;

use std::cell::{Cell, RefCell};
use std::future::Future;
use std::pin::Pin;
use std::rc::Rc;

use crate::engine::race::{race, Won};
use crate::engine::worker::Liveness;
use crate::llm::{Delta, LlmClient};
use crate::prompts::Role;
use crate::protocol::{AgentEvent, ChatMessage, MessageContent, Session};
use crate::tools::ToolRegistry;
use crate::engine::host::{DefaultHost, Host};
use crate::engine::host::{clock::HostClock, store::HostStore};

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

/// The seam between two rounds of a turn, asked at the head of each before anything of it is
/// spent.  The session actor publishes its snapshot here and offers the newest registry its
/// controls hold, so a turn adopts a scope change at its next round (`crate::engine::actor`).
pub trait Boundary<H: Host = DefaultHost> {
    /// A newer registry to run the rest of the turn under, if there is one.
    fn round(&mut self, session: &Session) -> Option<Rc<ToolRegistry<H>>>;
}

/// The boundary of a turn with nothing to adopt.
pub struct Fixed;

impl<H: Host> Boundary<H> for Fixed {
    fn round(&mut self, _session: &Session) -> Option<Rc<ToolRegistry<H>>> { None }
}


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
pub type Interjections = Rc<RefCell<Vec<Said>>>;

/// One thing the user said into a running turn, and the app's note that rides ahead of it.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct Said {
    pub text: String,
    pub pre:  String,	// joined ahead of `text` on the wire, never shown as it; empty for none
    pub mid:  String,	// the row the page drew it as; empty for none, and the seam mints one
}

/// Give the session's copy of a tool result the notes its sent copy now carries (r578).
///
/// The round loop writes the budget and turn-state lines onto the SENT copy; a session without
/// them would make the next turn send that result without them, a rewrite of bytes the provider
/// has cached.  Found by its call id, the newest first, since the two lists are numbered apart.
fn keep_post(session: &mut Session, sent: &ChatMessage) {
    let (id, note) = match sent {
        ChatMessage::Tool { tool_call_id, post, .. } => (tool_call_id, post),
        _ => return,
    };
    let at = session.messages.iter().rposition(|m|
        matches!(m, ChatMessage::Tool { tool_call_id, .. } if tool_call_id == id));
    if let Some(j) = at {
        if let ChatMessage::Tool { post, .. } = &mut session.messages[j] {
            *post = note.clone();
        }
    }
}

/// A fresh, empty interjection queue.
pub fn new_interjections() -> Interjections {
    Rc::new(RefCell::new(Vec::new()))
}

/// Queue what the user said, `text` with its note `pre`, on `q`; blank words queue nothing.
/// Returns how many are now waiting.  See [`Agent::interject_marked`].
///
/// # Arguments
/// * `mid` - The row id the page drew the words as, empty for none.
pub fn say_into(q: &Interjections, text: &str, pre: &str, mid: &str) -> usize {
    let mut q = q.borrow_mut();
    let t = text.trim();
    if !t.is_empty() {
        q.push(Said { text: t.to_string(), pre: pre.to_string(), mid: mid.to_string() });
    }
    q.len()
}

/// Take the words of everything waiting on `q`, leaving it empty.
pub fn take_said(q: &Interjections) -> Vec<String> {
    std::mem::take(&mut *q.borrow_mut()).into_iter().map(|s| s.text).collect()
}


// ┌───────────────────────────────────────────────────────────────┐
// │ Agent                                                          │
// └───────────────────────────────────────────────────────────────┘

/// Where a fold puts his words (U2a, qa-ccp3-b F2).  A runner keeps no words log of its own: its
/// folds stage them over the log the tab sent, and they ride home on the report for the tab to
/// file, so its notice and `recall` are the tab's own.
#[derive(Clone, Debug, Default, PartialEq)]
pub enum WordsHome {
    /// No words home: a fold carries all his words in its notice (R1).
    #[default]
    None,
    /// The store files them in this keeper's words log.
    Store(String),
    /// A runner's: the tab's keeper, its words log as a file (`compact::log_file`) with this
    /// turn's filings merged in, and the entries filed, in `compact::log_entries` form.
    Staged { keeper: String, log: String, added: String },
}

impl WordsHome {
    /// The keeper his words are filed under, empty for none.
    pub fn keeper(&self) -> &str {
        match self {
            Self::None                      => "",
            Self::Store(k)
            | Self::Staged { keeper: k, .. } => k,
        }
    }
}

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
    /// Estimated tokens below which this turn does not fold again unless forced.
    ///
    /// Set where a pass could not take the conversation below `compact::FOLD_TARGET`, or freed
    /// less than `compact::MIN_FOLD_GAIN`, to the carry it left plus that gain: a fold that
    /// cannot make progress is not retried on every round.  Cleared at the top of each turn.
    fold_rest:           Cell<u64>,
    /// The conversation as the last fold left it: its length and the notice it opens with.  A
    /// refold is paid for only once history has grown past it (CCP3 (a)); see
    /// [`Agent::fold_plan`].
    folded_at:           RefCell<Option<(usize, String)>>,
    /// Did the last fold fail to file his words?  Then they all ride in the notice (R1), and
    /// the next fold plans to carry them all again.
    words_unfiled:       Cell<bool>,
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
    words_home:          Rc<RefCell<WordsHome>>,         // where a fold puts his words
    pending_only:        Cell<bool>,                     // reports on Pending, see `set_pending_only`
    /// The turn's last-progress clock (U3a LV1, UNBLOCK-16): beaten by every line the model
    /// stream hears, through the same clock handed to `llm`, and nothing else.  Its limit is
    /// [`compact::LIVENESS_MS`] until [`Agent::set_liveness_ms`] says otherwise.  Shared on clone,
    /// as `llm`'s copy of it is.  Nothing expires on it yet: the turn races it from LV2 on.
    pub liveness:        Liveness,
    /// What this turn's standing context holds, block by block: the crystal, the three files,
    /// what is attached, the machine, the date, the tree.  Never composed into the system
    /// message, which must not change between two turns of one conversation (r578): each block
    /// rides in the turn's own note and is restated only when it changed; see
    /// [`crate::prompts::turn_note`].  Shared on clone for the reason `briefing` is.
    pub blocks:          Rc<RefCell<crate::prompts::TurnBlocks>>,
    /// The caller's own note for the turn in flight, before the blocks were put ahead of it, so
    /// a fold mid-turn can restate every block over the same words.  Not shared on clone.
    turn_pre:            RefCell<String>,
    // The parent's request this worker was copied from (r578c); see `crate::fork`.  Its system
    // text is sent verbatim, and its tools array too while the model is the parent's.
    fork:                RefCell<Option<std::sync::Arc<crate::fork::Fork>>>,
    fork_same:           Cell<bool>,	// the worker's model is the parent's
    fork_fresh:          Cell<bool>,	// the copy has not yet had its first turn
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


/// What [`Agent::fold_plan`] decided: the figures the fold works to, and where it cuts.
struct FoldPlan {
	budget:  u64,					// tokens the request must fit
	ceiling: u64,					// bytes, the budget less the tool schemas
	gain:    u64,					// tokens a pass must free to be worth its cost
	cut:     usize,					// messages folded; 0 shortens the copy only
	pin:     Option<ChatMessage>,	// the turn's opening, set back behind the notice
}

/// What a pass of [`Agent::fold_if_needed`] did to the request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refit {
	Untouched,	// nothing moved
	Shortened,	// the sent copy was shortened, nothing folded
	Folded,		// the record was folded
}

impl Refit {

	/// Did the request change, so a refused one is worth sending again?
	pub fn changed(self) -> bool {
		!matches!(self, Self::Untouched)
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
	// The work was not delivered and the model could not mend it: a refusal left standing
	// after one must-fix nudge, a call that failed twice the same way and was not sent a third
	// time, a page put back as it was, or a page whose last check failed.  Its own word and
	// not `Answered`, which is the 2026-10-08 defect: a turn that restored its starting state
	// was booked as a reply that worked.
	Blocked,
	// The model stream said nothing for the liveness limit, twice in one round: the stall retry
	// was spent (U3a LV2).  A tool never ends a turn this way; it fails on its own ceiling.
	TimedOut,
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
			// AN OLD PAGE DRAWS AN UNKNOWN WORD AS NOTHING (`appendEnding` skips a turn that
			// drew text and carried no refusal) and files it as done (`endedHow`'s default),
			// so `Blocked` travels as the word every page knows to be a failure, and names
			// itself in `why`.
			Self::Blocked	=> "failed",
			Self::TimedOut	=> "failed",
		}
	}

	/// What a page that knows more than [`Self::wire`] says should read; empty for the rest.
	pub fn why(&self) -> &'static str {
		match self {
			Self::Blocked	=> "blocked",
			Self::TimedOut	=> "timed_out",
			_			=> "",
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
	pub said:		String,			// the sentence a blocked, malformed or failed turn ends on, else empty
	pub fault:		&'static str,	// a failed turn's class of failure (`llm::failure_class`), else empty
	// Paths the turn's completed write calls left on the store, in first-touch order, at most
	// `TOUCHED_CAP` and then one "+k more".  A worker that ends anything but `done` reports
	// them, so the conductor learns what the work left even when no verdict came (U3a REP).
	pub touched:	Vec<String>,
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
	"You stopped without a reply. If the task is not done, continue it; otherwise report \
	 what you did and what stops you.".to_string()
}

// The pending-only turn's word, named in its note and both its nudges.
const PENDING_ENDS: &str = "pending_raise, pending_clear or pending_none";

/// What a pending-only turn's message is led by: its words go to Pending, never its chat.
fn pending_only_note() -> String {
	fmt!("This turn reports only through the Pending panel: post no reply, and end with {}.", PENDING_ENDS)
}

/// [`report_nudge`] for a pending-only turn, which ends on a pending call rather than a report.
fn pending_report_nudge() -> String {
	fmt!("You stopped without a word on Pending. If the task is not done, continue it; \
		otherwise end with {}.", PENDING_ENDS)
}

/// [`reasoned_only_nudge`] for a pending-only turn.
fn pending_reasoned_nudge() -> String {
	fmt!("You reasoned but called no tool; end now with {}.", PENDING_ENDS)
}
/// The most paths an ending lists as touched before the rest become one "+k more".
pub const TOUCHED_CAP: usize = 40;

/// One dispatched tool call, as the audit sees it.
#[derive(Clone, Debug)]
struct Claim {
	outcome:	crate::tools::CallOutcome,
	opaque:		bool,										// see [`crate::tools::Tool::opaque`]
	paths:		Vec<(String, crate::tools::PathClaim)>,
	alerted:	bool,										// a pending_raise/pending_clear that landed
	pending:	bool,										// any completed pending_raise/_clear/_none
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
	/// taken: a write the fence stopped is not a file anybody should be looking for.  `daimon` is
	/// the Diamond the turn acts for, inside which a call's default path is placed.
	fn record(&mut self, name: &str, args: &str, outcome: crate::tools::CallOutcome, daimon: Option<&str>) {
		self.record_said(name, args, outcome, daimon, "");
	}

	/// [`Claims::record`], with the result the model was handed: whether a Pending call LANDED
	/// is read from the engine's own words ([`crate::tools::pending_landed`]), since `Done`
	/// alone also covers a clear that found nothing and a raise that stayed dismissed.
	fn record_said(&mut self, name: &str, args: &str, outcome: crate::tools::CallOutcome, daimon: Option<&str>,
		result: &str) {
		let tool = crate::tools::Tool::from_name(name);
		let paths = match tool {
			Some(t) if outcome == crate::tools::CallOutcome::Done => t.path_claims(args, daimon),
			_ => Vec::new(),
		};
		// A refused shell ran nothing, so it cannot have moved a file.  Anything else that
		// reached a shell, a build or a worker did.
		let opaque = tool.map(|t| t.opaque()).unwrap_or(false)
			&& outcome != crate::tools::CallOutcome::Refused;
		// The Pending panel is the one place a person looks for what a Diamond found
		// (D-20261016-17, rulings section 16), so a turn that put its word there has reported --
		// a raise that is on the panel, or a clear that took one off.  A clear of nothing is not
		// a report (review AP-3): a failing turn's precautionary clear must not spare it the nudge.
		let alerted = matches!(tool, Some(crate::tools::Tool::PendingRaise) | Some(crate::tools::Tool::PendingClear))
			&& outcome == crate::tools::CallOutcome::Done
			&& crate::tools::pending_landed(result);
		let pending = matches!(tool, Some(crate::tools::Tool::PendingRaise)
				| Some(crate::tools::Tool::PendingClear) | Some(crate::tools::Tool::PendingNone))
			&& outcome == crate::tools::CallOutcome::Done;
		self.calls.push(Claim { outcome, opaque, paths, alerted, pending });
	}

	/// Did a pending-only turn give its word on Pending?  A completed `pending_raise`,
	/// `pending_clear` or `pending_none`, whether or not the panel changed: `pending_none` says
	/// in terms that nothing needed it, which is what an empty reply alone cannot say.
	fn reported(&self) -> bool {
		self.calls.iter().any(|c| c.pending)
	}

	/// Did this turn report on the Pending panel?  Then an empty final reply is not silence:
	/// it is the Email daimon doing as it is told, posting nothing in its chat.  No nudge to
	/// "report what you did" (which would put the alert in the chat as well), and no
	/// "ended without a reply" card under a turn whose answer is on the panel.
	fn alerted(&self) -> bool {
		self.calls.iter().any(|c| c.alerted)
	}

	/// The paths this turn's completed calls left on the store, each once, in the order they
	/// were first left; past [`TOUCHED_CAP`] the rest are one "+k more".
	///
	/// Unlike [`Claims::standing`] a later delete does not take a path back out: the question
	/// here is what the work touched, for a report, not what should be on the store now.
	fn touched(&self) -> Vec<String> {
		let mut seen: Vec<String> = Vec::new();
		for call in &self.calls {
			for (path, claim) in &call.paths {
				if *claim == crate::tools::PathClaim::Left && !seen.contains(path) {
					seen.push(path.clone());
				}
			}
		}
		if seen.len() > TOUCHED_CAP {
			let more = seen.len() - TOUCHED_CAP;
			seen.truncate(TOUCHED_CAP);
			seen.push(fmt!("+{} more", more));
		}
		seen
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

    pub fn new(mut llm: LlmClient, system_prompt: &str) -> Self {
        // Beaten at nought: nothing races it before a turn does, and a turn beats it as it starts.
        let liveness = Liveness::new(compact::LIVENESS_MS, 0);
        llm.liveness = Some(liveness.clone());
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
            fold_rest:       Cell::new(0),
            folded_at:       RefCell::new(None),
            words_unfiled:   Cell::new(false),
            orphaned:        Cell::new(false),
            pending_only:    Cell::new(false),
            ending:          Rc::new(RefCell::new(None)),
            diamond:         Rc::new(RefCell::new(String::new())),
            words_home:      Rc::new(RefCell::new(WordsHome::None)),
            liveness,
            blocks:          Rc::new(RefCell::new(crate::prompts::TurnBlocks::default())),
            turn_pre:        RefCell::new(String::new()),
            fork:            RefCell::new(None),
            fork_same:       Cell::new(false),
            fork_fresh:      Cell::new(false),
        }
    }

    /// Set the liveness limit `N`, in milliseconds: how long a turn may go without its model
    /// stream saying anything.  Nought is taken as one millisecond, never as "no limit".  Tests
    /// set 300 ms natively; the page sets a worker's from `window.__livenessMs` (U3a END).
    pub fn set_liveness_ms(&self, ms: u64) {
        self.liveness.set_limit_ms(ms);
    }

    /// The liveness limit `N` in force, in milliseconds.
    pub fn liveness_ms(&self) -> u64 {
        self.liveness.limit_ms()
    }

    /// Start this worker as a copy of its parent's latest request (r578c).
    ///
    /// The conversation is the parent's as sent, and so is the system message.  On the parent's
    /// own model the tools array, the host pin and the thinking blocks come too, so the first
    /// round is the parent's request plus one message and reuses its cache.  On another model
    /// the copy is still whole, but the tools array is this agent's own -- a family's tool names
    /// and a model's thinking signatures do not carry -- and there is no cache to reuse.
    ///
    /// Answers the conversation the worker's session is to hold, which the caller writes as it
    /// writes any (the tab through its actor); the parent's host pin is the session's at the
    /// copy's first turn, in [`Agent::run_turn`].
    pub fn adopt_fork(&self, f: std::sync::Arc<crate::fork::Fork>) -> Vec<ChatMessage> {
        let messages = f.messages.clone();
        let same = f.model == self.llm.model;
        if same {
            self.llm.carry_import(&f.carry);
        }
        self.fork_same.set(same);
        self.fork_fresh.set(true);
        *self.fork.borrow_mut() = Some(f);
        messages
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
            why:     ending.how.why().to_string(),
            said:    ending.said.clone(),
            fault:   ending.fault.to_string(),
            touched: ending.touched.clone(),
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
    async fn audit<H: Host>(
        &self,
        how:        TurnEnd,
        rounds:     usize,
        claims:     &Claims,
        registry:   Option<&ToolRegistry<H>>,
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
            said:    String::new(),
            fault:   "",
            touched: claims.touched(),
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

    /// Set K for this agent alone (UNBLOCK-27 R4).  Called for a Diamond's daimon AFTER
    /// [`Agent::adopt_limits`], which copies the app agent's `Limits` -- shared by every Diamond
    /// on one model -- so a figure set before it, or set on the shared agent, would not be this
    /// Diamond's own.  Zero is ignored and the adopted figure stands.
    pub fn set_no_progress_rounds(&self, k: usize) {
        if k > 0 {
            self.limits.borrow_mut().no_progress_rounds = k;
        }
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
    /// the parent's own carry, a tail of three tenths and a dollar.
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
        // The listing caps (HATE-17), process-wide because the tools that read them are: zero
        // or absent keeps the figure in force.
        {
            let n = |k: &str| crate::llm::extract_json_number(text, k).map(|n| n as usize)
                .unwrap_or(0);
            let caps = crate::tools::OutputCaps {
                glob_paths:     n("glob_paths"),
                glob_bytes:     n("glob_bytes"),
                search_matches: n("search_matches"),
                search_bytes:   n("search_bytes"),
                list_bytes:     n("list_bytes"),
                read_bytes:     n("read_bytes"),
            };
            if caps != (crate::tools::OutputCaps { glob_paths: 0, glob_bytes: 0,
                search_matches: 0, search_bytes: 0, list_bytes: 0, read_bytes: 0 })
            {
                crate::tools::set_output_caps(caps);
            }
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
            // Nought puts the line at the start: shortened once, at the first chance, then
            // appended until the summary (r578f).
            if let Some(f) = crate::llm::extract_json_f64(text, "retire_at") {
                l.retire_at = f.clamp(0.0, 1.0);
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
            if let Some(n) = crate::llm::extract_json_number(text, "no_progress_rounds") {
                if n > 0 { l.no_progress_rounds = n as usize; }
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

    /// Set the chat's own reasoning level from its wire spelling; an empty string clears
    /// it, back to the model's default.  See `LlmClient::set_reasoning_effort`.
    pub fn set_reasoning_effort(&self, effort: &str) -> Outcome<()> {
        let e = effort.trim();
        if e.is_empty() {
            self.llm.set_reasoning_effort(None);
            return Ok(());
        }
        match crate::llm::ReasoningEffort::from_wire(e) {
            Some(level) => {
                self.llm.set_reasoning_effort(Some(level));
                Ok(())
            }
            None => Err(err!("Reasoning effort '{}' is not one of none, minimal, low, medium, \
                high, xhigh or max; the model keeps its previous setting.", e; Invalid, Input)),
        }
    }

    /// Hand the engine the provider's word on pictures; see `LlmClient::set_sight`.
    pub fn set_sight(&self, state: i32) {
        self.llm.set_sight(state);
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
    /// * `host` - The host the Diamond's notes are filed through.
    /// * `session` - The durable conversation, folded in place.
    /// * `on_event` - Where the fold is announced, exactly as an automatic one is.
    pub async fn fold_by_hand<H: Host>(
        &self,
        host:     &H,
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
        self.fold_if_needed(host, session, &mut working, 0, Fold::ByHand, on_event).await.changed()
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

    /// Set what this turn's standing context holds, block by block (r578).
    ///
    /// Called before a turn, beside [`set_briefing`](Self::set_briefing), which now carries only
    /// what cannot change between two turns of a conversation.
    pub fn set_blocks(&self, blocks: crate::prompts::TurnBlocks) {
        *self.blocks.borrow_mut() = blocks;
    }

    /// Rewrite the turn's opening note to carry every block, ahead of the caller's own note.
    fn restate_blocks(&self, session: &mut Session) {
        let note = crate::prompts::turn_note(&self.blocks.borrow(), &[]);
        if note.is_empty() {
            return;	// no blocks at all, so nothing was cut that needs saying again
        }
        let caller = self.turn_pre.borrow().clone();
        if let Some(ChatMessage::User { pre, .. }) = session.messages.get_mut(self.turn_start.get()) {
            // Only the message this turn opened with, whose note ends in the caller's own.
            if pre.ends_with(caller.as_str()) {
                *pre = crate::prompts::join_note(&note, &caller);
            }
        }
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

    /// Say that this turn reports through the Pending panel and never in its chat.
    ///
    /// A triggered daimon turn -- mail arriving, a schedule firing -- has no person waiting on
    /// its reply (D-20261016-17, rulings section 16: "Post nothing in this chat").  Its word is
    /// a `pending_raise`, a `pending_clear`, or `pending_none` (refused outside such a turn).  An
    /// empty final reply after one of them completed, with no call failed or refused, is a quiet
    /// [`TurnEnd::Answered`], whatever the model reasoned: no "report what you did" nudge, which
    /// is what made the model post routine mail in the chat (review R569 R4), and no "ended
    /// without a reply" card.  Without one the turn is nudged, then ends `Silent` or
    /// `ReasonedOnly`, and the arrival stays owed.
    pub fn set_pending_only(&self, on: bool) {
        self.pending_only.set(on);
    }

    /// May this turn end on an empty reply without a word?
    fn quiet_end(&self, claims: &Claims) -> bool {
        // Its word is a completed pending call (MAIL-FIX2 item 2): reasoning does not matter, and
        // an empty reply with no such call stays `Silent` / `ReasonedOnly`, failed and owed (B-1).
        // A failed or refused call keeps the nudges, so a precautionary clear does not spare a
        // failing turn them (review AP-3).
        self.pending_only.get()
            && claims.reported()
            && claims.tally(crate::tools::CallOutcome::Failed) == 0
            && claims.tally(crate::tools::CallOutcome::Refused) == 0
    }

    /// Which Diamond this turn is steering, or empty.
    pub fn diamond(&self) -> String {
        self.diamond.borrow().clone()
    }

    /// Say whose notes file a fold files his words into: a held Diamond's id or `chat:<id>`, as
    /// `tools::keeper_home` reads it; empty for none, and then a fold carries all his words in
    /// its notice as before (R1).
    pub fn set_words_home(&self, keeper: &str) {
        *self.words_home.borrow_mut() = match keeper.is_empty() {
            true    => WordsHome::None,
            false   => WordsHome::Store(keeper.to_string()),
        };
    }

    /// The keeper a fold files his words under, or empty.
    pub fn words_home(&self) -> String {
        self.words_home.borrow().keeper().to_string()
    }

    /// Stage his words rather than file them (U2a, a runner's turn): a fold merges them into
    /// `log`, the tab's words log as its `words_read` answers it ([`compact::log_text`]), and
    /// answers as the tab's store would over it, and [`Self::staged_words`] says what it filed.
    /// `keeper` is the tab's, which names the log in the notice.
    pub fn set_words_staged(&self, keeper: &str, log: &str) {
        *self.words_home.borrow_mut() = WordsHome::Staged { keeper: keeper.to_string(),
            log: compact::log_file(log), added: String::new() };
    }

    /// Does a fold stage his words rather than file them?
    pub fn is_staged(&self) -> bool {
        matches!(*self.words_home.borrow(), WordsHome::Staged { .. })
    }

    /// The entries this agent's folds staged, oldest first, for the tab to file; empty for none.
    pub fn staged_words(&self) -> String {
        match &*self.words_home.borrow() {
            WordsHome::Staged { added, .. } => added.clone(),
            _                               => String::new(),
        }
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
        self.interject_noted(text, "")
    }

    /// [`interject`](Self::interject) with the app's note for what the user said.
    ///
    /// The note travels with the words and is joined ahead of them where the request is built,
    /// exactly as a turn's first message carries it (see [`Agent::run_turn_noted`]).  Blank words
    /// queue nothing, and a note with no words is not said.
    ///
    /// # Arguments
    /// * `text` - What the user said.
    /// * `pre` - The note for it, empty for none.
    pub fn interject_noted(&self, text: &str, pre: &str) -> usize {
        self.interject_marked(text, pre, "")
    }

    /// [`interject_noted`](Self::interject_noted) under the row id `mid` the page drew the words
    /// as, so the message in the conversation and the row on the page are one, and two equal
    /// corrections are two of his messages in his words log (CCP3 F3).  An empty `mid` gets one
    /// minted at the seam.
    pub fn interject_marked(&self, text: &str, pre: &str, mid: &str) -> usize {
        say_into(&self.interject, text, pre, mid)
    }

    /// Take `said` as this agent's interjection queue, in place of the empty one it was built with.
    ///
    /// **A TURN RUN ON A FRESH AGENT CAN STILL BE SPOKEN TO (UNBLOCK-27 R7).**  A Diamond's daimon
    /// turn runs on an agent composed for that one turn, so its own queue was one nothing outside
    /// the turn could reach, and words the user sent while it ran waited until it ended.  The
    /// holder keeps the queue and hands it to every agent that runs a turn for it; what the turn
    /// never reached a seam for is still in the holder's queue when it ends, for the page to take
    /// back.
    pub fn share_interjections(&mut self, said: &Interjections) {
        self.interject = said.clone();
    }

    /// What is waiting to be said, for the UI to draw.
    pub fn interjections(&self) -> Vec<String> {
        self.interject.borrow().iter().map(|s| s.text.clone()).collect()
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
    fn take_interjections(&self) -> Vec<Said> {
        let mut q = self.interject.borrow_mut();
        if q.is_empty() { return Vec::new(); }
        std::mem::take(&mut *q)
    }

    /// Hand back the words of everything waiting, leaving the queue empty: what the page takes
    /// back at a turn's end, when no seam was left to carry them.
    pub fn take_interjected(&self) -> Vec<String> {
        self.take_interjections().into_iter().map(|s| s.text).collect()
    }

    /// Take one waiting message back out by position, oldest first; `None` past the end.
    pub fn drop_interjected(&self, index: usize) -> Option<String> {
        let mut q = self.interject.borrow_mut();
        if index >= q.len() {
            return None;
        }
        Some(q.remove(index).text)
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
    pub fn system_parts<H: Host>(&self, registry: &ToolRegistry<H>) -> (String, String, String) {
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


    pub async fn run_turn<H: Host>(
        &self,
        session:    &mut Session,
        user_msg:   String,
        registry:   &ToolRegistry<H>,
        on_event:   &mut impl FnMut(AgentEvent),
    ) -> Outcome<()> {
        self.run_turn_noted(session, user_msg, String::new(), String::new(), registry, on_event).await
    }

    /// [`run_turn`](Self::run_turn) for a message that carries an app note.
    ///
    /// The note rides on the user message beside its words and is joined ahead of them where the
    /// request is built, so the session, the store and the page's bubble hold only what the person
    /// typed.  See [`crate::protocol::join_notes`].  A turn no person began -- a trigger, a preset,
    /// a gather round, a worker -- goes through [`run_turn`](Self::run_turn) and carries none.
    ///
    /// # Arguments
    /// * `pre` - The app's note for this message, empty for none.
    /// * `mid` - The transcript row the message was said as, empty for none; see
    ///   [`ChatMessage::marked`].
    pub async fn run_turn_noted<H: Host>(
        &self,
        session:    &mut Session,
        user_msg:   String,
        pre:        String,
        mid:        String,
        registry:   &ToolRegistry<H>,
        on_event:   &mut impl FnMut(AgentEvent),
    ) -> Outcome<()> {
        self.run_turn_bounded(session, user_msg, pre, mid, registry, &mut Fixed, on_event).await
    }

    /// [`run_turn_noted`](Self::run_turn_noted) under a [`Boundary`], which is asked at the head
    /// of every round for a newer registry to run the rest of the turn under.
    pub async fn run_turn_bounded<H: Host>(
        &self,
        session:    &mut Session,
        user_msg:   String,
        pre:        String,
        mid:        String,
        registry:   &ToolRegistry<H>,
        boundary:   &mut impl Boundary<H>,
        on_event:   &mut impl FnMut(AgentEvent),
    ) -> Outcome<()> {
        // THE TURN'S BYTE LEDGER STARTS HERE, and here is the only place it does. Every turn in
        // the app arrives through this function -- the browser chat, a Diamond's daimon, a
        // dispatched worker and `examples/devcycle_probe.rs` alike -- and a Diamond's daimon
        // SHARES its `read_seen` with the chat that made it, so an allowance reset anywhere else
        // would leak from one turn into the next. See `crate::tools::TurnState::spent`.
        let _turn_end = registry.begin_turn();
        // AND THE TUNED GATHER CEILING GOES WITH IT.  `gather` is a tool and cannot see `Limits`;
        // this is the one place a turn begins, so it is where the figure is handed over.
        registry.ctx.set_gather_timeout_s(self.limits.borrow().gather_timeout_s);
        // AND THE MEASURE UNDER TRIAL, handed over at the same seam and for the same reason:
        // `offered` decides the schema array synchronously, once a round, and cannot see
        // `Limits`. Written every turn rather than once, so an arm that changes it between two
        // turns of one conversation is obeyed by the second of them.
        registry.ctx.set_compound(self.limits.borrow().compound);
        // AND WHETHER THIS TURN REPORTS ON PENDING ALONE, which lets `pending_none` run and leads
        // its message with the note that names its three endings (MAIL-FIX2 item 2).
        let pending_only = self.pending_only.get();
        registry.ctx.set_pending_only(pending_only);
        let pre = match (pending_only, pre.is_empty()) {
            (false, _)    => pre,
            (true, true)  => pending_only_note(),
            (true, false) => fmt!("{}\n\n{}", pending_only_note(), pre),
        };
        // AND WHAT THE ASK WANTS THE DIAMOND'S PAGE TO DRAW, for the load proof an edit of the page
        // takes (K1): an infographic ask must draw graphics, not only words.
        registry.ctx.set_ask(&user_msg);
        // THIS TURN'S OWN MESSAGES BEGIN WITH THE SENTENCE ABOUT TO BE PUSHED, and the index is
        // recorded on the agent rather than left to the caller, because a fold later in the turn
        // moves it; see `Agent::turn_start`.
        self.turn_start.set(session.messages.len());
        self.fold_rest.set(0);
        // THE TURN'S STANDING CONTEXT RIDES IN ITS OWN NOTE (r578), each block only where it
        // differs from its latest copy in the conversation as sent, so the system message stays
        // byte-identical from turn to turn and the provider's cache holds across them.  Stored
        // with the message, so a reload sends the same bytes.  See `prompts::turn_note`.
        let blocks = crate::prompts::turn_note(&self.blocks.borrow(), &session.messages);
        *self.turn_pre.borrow_mut() = pre.clone();
        let pre = crate::prompts::join_note(&blocks, &pre);
        // Append the user message to the persisted history.
        session.messages.push(ChatMessage::user_noted(user_msg, pre).marked(mid).opening());

        // Build the working conversation: system prompt + history.
        let mut working = Vec::with_capacity(session.messages.len() + 1);
        let fork = self.fork.borrow().clone();
        if let Some(f) = fork.as_ref() {
            // A WORKER SENDS ITS PARENT'S SYSTEM MESSAGE, byte for byte (r578c).
            if !f.system.is_empty() {
                working.push(ChatMessage::system(f.system.clone()));
            }
        } else if !self.system_prompt.is_empty() {
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
        // pushed belongs to a turn that has ENDED: its tool results have been read and acted on.
        // Its tool-call ARGUMENTS are not touched: they are the model's own past actions, and it
        // copies what it sees (daimond_rulings.md §17).  The results, carried whole, are re-sent
        // on every one of this turn's rounds -- a hundred and fifty of them, at the cached-input
        // rate, which is how a turn came to cost five dollars without any request being too big.
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
        // A FRESH COPY IS NOT RETIRED AGAIN: it is the parent's request as sent, already retired
        // at the parent's own boundary, and moving that boundary would change its bytes.
        // AND IT GOES TO THE PARENT'S HOST on the parent's own model, whose cache it reuses.
        if self.fork_fresh.replace(false) {
            self.prior_end.set(0);
            if self.fork_same.get() {
                if let Some(f) = self.fork.borrow().as_ref() {
                    session.pin = f.pin.clone();
                }
            }
        }
        let mut prior = session.messages.clone();
        // Under a switch, so the measure can be turned off and its worth measured rather than
        // asserted -- see `Agent::set_tune`. On by default, which is what shipped.
        //
        // ONLY PAST THE LINE (D-20261020-11). What went out short before goes out short again,
        // byte for byte, so the cached prefix holds; anything newer is retired only once the
        // conversation nears the fold, once, and marked so it stays that way. See
        // `compact::RETIRE_AT`.
        //
        // ONCE, THEN APPEND UNTIL THE SUMMARY (r578f, QA r578e C1/C2): a conversation already
        // shortened since its last fold -- here or by the tool loop's sweep, one state read off
        // the stored marks -- is left whole for the summary; see `compact::shortened`.  AND THE
        // TOOL LIST COUNTS (B2): it rides on every request, and the mid-turn and summary checks
        // count it, so a Diamond's ~13k tokens of tools no longer put its line ~13k later than a
        // chat's.
        if self.limits.borrow().retire_prior {
            compact::restub(&mut prior);
            let line = self.limits.borrow().retire_line(self.reply_cap());
            let schema = self.schema_bytes(registry);
            let est = self.gauge.tokens(compact::conversation_bytes(&working)
                + compact::conversation_bytes(&prior) + schema);
            let end = self.prior_end.get();
            if compact::past_line(est, session.last_prompt_tokens, line)
                && !compact::shortened(&prior)
                && compact::retire_upto(&mut prior, end) > 0
            {
                compact::carry_retired(&mut session.messages, &prior);
            }
        }
        working.extend(prior);

        // THE CONVERSATION'S HOST GOES IN HERE AND COMES BACK OUT ON EVERY EXIT (r578b F2, F5).
        // A round settles the pin as it ends, but a turn that fails, stops or is cut short returns
        // before that, and a stall has by then cleared the client's pin while the session kept the
        // dead host for the next turn to ask first.  Both paths, with tools or without.
        self.llm.set_pin(session.pin.clone());
        let out = if registry.is_empty() {
            self.run_streaming(registry.ctx.host(), session, working, on_event).await
        } else {
            self.run_tool_loop(session, working, registry, boundary, on_event).await
        };
        session.pin = self.llm.pin();
        out
    }

    /// Pure-chat path: stream tokens as they arrive (no tools).
    ///
    /// Folded before the request goes out, and folded again if the provider refuses it for
    /// being too long -- the second is the net under the first.  Without it a chat whose
    /// window nobody published dies once and then dies on every turn after, because the
    /// same oversized history is sent again.
    fn run_streaming<'a, H: Host>(
        &'a self,
        host:     &'a H,
        session:  &'a mut Session,
        working:  Vec<ChatMessage>,
        on_event: &'a mut impl FnMut(AgentEvent),
    )
        -> Pin<Box<impl Future<Output = Outcome<()>> + 'a>>
    {
        // Boxed where it is defined, so a caller's poll frame holds a pointer and not this
        // future: a debug wasm turn otherwise overflows its 1 MiB stack (CCP4-STACKPIN).
        Box::pin(self.run_streaming_body(host, session, working, on_event))
    }

    async fn run_streaming_body<H: Host>(
        &self,
        host:       &H,
        session:    &mut Session,
        mut working: Vec<ChatMessage>,
        on_event:   &mut impl FnMut(AgentEvent),
    ) -> Outcome<()> {
        let mut refolded = false;
        let mut rounds = 0usize;
        let mut expiries = 0u32; // liveness expiries of this turn's one round
        loop {
            // A STOPPED TURN SENDS NOTHING, the fold's request included; see `Halt`.
            if self.llm.halted() {
                return self.stop_halted(rounds, &Claims::default(), None::<&ToolRegistry<H>>, on_event).await;
            }
            self.fold_if_needed(host, session, &mut working, 0, Fold::IfNeeded, on_event).await;
            let sent = compact::conversation_bytes(&working);
            let mut full = String::new();
            rounds += 1;
            // Has this attempt handed the caller anything?  Then it is not asked again.
            let said = std::cell::Cell::new(false);
            let result = match self.live_call(self.llm.chat_stream(
                &working,
                &mut |d| { said_any(&said, &d); match d {
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
                    // A request retry's wait is the client's own pause, not a silent model.
                    Delta::Roading { attempt, of, wait_ms } => {
                        self.liveness.beat(crate::llm::now_ms().saturating_add(wait_ms));
                        on_event(AgentEvent::Roading { name: String::new(), attempt, of, wait_ms })
                    }
                    // The provider has taken the round and said nothing; a caption, never `full`.
                    Delta::Waiting { provider, secs } =>
                        on_event(AgentEvent::Wait {
                            model: self.llm.model.clone(), provider: provider.to_string(), secs }),
                    Delta::Stalled { provider, secs, retrying } =>
                        on_event(AgentEvent::Stall {
                            model: self.llm.model.clone(), provider: provider.to_string(),
                            secs, retried: retrying }),
                }},
            )).await {
                Some(r) => r,
                // NO PROGRESS FOR THE LIVENESS LIMIT (U3a LV2): once is the round's stall retry,
                // twice ends the turn `TimedOut`.  A Stop that landed meanwhile is a Stop.
                None if self.llm.halted() =>
                    return self.stop_halted(rounds, &Claims::default(), None::<&ToolRegistry<H>>, on_event).await,
                None => {
                    if self.stalled_live(&mut expiries, said.get(), on_event) {
                        rounds -= 1;
                        continue;
                    }
                    return self.end_timed_out(rounds, &Claims::default(), None::<&ToolRegistry<H>>, on_event).await;
                }
            };
            match result {
                Ok(resp) => {
                    // The host this round leaves the conversation pinned to (r578b F5).
                    session.pin = self.llm.settle_pin(&resp);
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
                    // A STOP BEFORE THE FIRST BYTE leaves nothing said, and an empty assistant
                    // message is not one a strict provider takes on replay: the next send in the
                    // chat would be refused.  A partial answer is still kept.
                    if !(silent && resp.aborted) {
                        session.messages.push(ChatMessage::assistant(content));
                    }
                    if silent && !resp.aborted {
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
                    // its ending is the shape of the turn and nothing else.  A Stop is its own
                    // ending whatever it cut off, as it is on the tool path.
                    let how = if resp.aborted { TurnEnd::Stopped }
                        else if silent        { TurnEnd::Silent }
                        else                  { TurnEnd::Answered };
                    let ending = self.audit(how, rounds, &Claims::default(), None::<&ToolRegistry<H>>).await;
                    self.ended(ending, on_event);
                    on_event(AgentEvent::Done);
                    return Ok(());
                }
                Err(e) => {
                    if !refolded && self.overflowed(&e, sent) {
                        refolded = true;
                        if self.fold_if_needed(host, session, &mut working, 0, Fold::Refused, on_event).await
                            .changed() {
                            continue;
                        }
                    }
                    on_event(AgentEvent::Error(e.to_string()));
                    let mut ending = self.audit(TurnEnd::Failed, rounds, &Claims::default(), None::<&ToolRegistry<H>>).await;
                    ending.said = e.to_string();
                    ending.fault = crate::llm::failure_class(&e);
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
    async fn over_the_road<H: Host>(
        &self,
        registry: &ToolRegistry<H>,
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
                    if H::HOSTED {
                        waited += registry.ctx.host().clock().await_restored(waited).await;
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
    async fn with_folds<H: Host>(
        &self,
        host:    &H,
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
        // AND HIS WORDS LOG (CCP2-FOLDFIX2): his messages a fold filed rather than carried.
        // A runner's is the log the tab sent with what its folds staged (U2a); a log this host
        // cannot reach is said in the store's own words, never read as empty: on the runner his
        // filed words are the tab's (QA ccp3r B, M2).
        let home = self.words_home.borrow().clone();
        let (log, away) = match home {
            WordsHome::None                 => (String::new(), None),
            WordsHome::Store(k)             => match host.store().his_words_read(&k).await {
                Ok(log) => (log, None),
                Err(e)  => (String::new(), Some(e.plain())),
            },
            WordsHome::Staged { log, .. }   => (compact::log_text(&log), None),
        };
        let lines = compact::recall_folds(
            &session.messages, &log, &mut |l: &str| q.matches(l), q.before, q.after, q.limit);
        let head = match (lines.is_empty(), away) {
            (true, None)        => fmt!("[recall] Nothing this conversation has folded away matches.\n\n"),
            (true, Some(away))  => fmt!("[recall] {}\n\n", away),
            (false, away)       => fmt!("{}\n\n[recall] {} line(s) from {} fold(s) of this conversation.{}\n\n",
                lines.join("\n"), lines.len(),
                session.messages.iter().filter(|m| compact::is_fold_notice(m)).count(),
                away.map(|a| fmt!(" {}", a)).unwrap_or_default()),
        };
        MessageContent::text(fmt!("{}{}", head, result.as_text()))
    }

    /// The event that tells the page a call has started.
    ///
    /// The ID travels with it, so the event names WHICH call it is.
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
    fn one_call<'a, H: Host>(
        &'a self,
        registry:  &'a ToolRegistry<H>,
        tc:        &'a crate::protocol::ToolCall,
        truncated: bool,
        on_event:  &'a mut impl FnMut(AgentEvent),
    )
        -> Pin<Box<impl Future<Output = Outcome<MessageContent>> + 'a>>
    {
        // Boxed where it is defined, so a caller's poll frame holds a pointer and not this
        // future: a debug wasm turn otherwise overflows its 1 MiB stack (CCP4-STACKPIN).
        Box::pin(self.one_call_body(registry, tc, truncated, on_event))
    }

    async fn one_call_body<H: Host>(
        &self,
        registry:  &ToolRegistry<H>,
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
        // WHAT THIS MODEL IS KNOWN TO TAKE, as it stands NOW, handed to the tool that is about to
        // run: a tool that makes a picture (`capture`) either attaches it or gets it described, and
        // only the engine knows which, because a refusal learned mid-turn changes it between
        // rounds.  A model not proven to take pictures is told to the tool as blind, so a picture
        // is never spent on a model that has not been shown to read one.
        registry.ctx.set_blind(!self.llm.sight_proven());
        // A call that never returns, for the tests of a Stop that lands mid-call.
        #[cfg(test)]
        if tc.name == HANGS {
            return std::future::pending().await;
        }
        // EACH CALL IS HELD TO ITS OWN CEILING, never to the turn's liveness (U3a LV2): `run`
        // its timeout, `verify` its budget, `gather` its wait, the rest the default, all plus a
        // margin.  A call past it is dropped as a Stop drops it, and fails; the turn goes on.
        let ceiling = crate::engine::worker::deadline::ceiling_of(
            &tc.name, &tc.arguments, registry.ctx.gather_timeout_s());
        match crate::engine::worker::deadline::within_ceiling(ceiling,
            self.over_the_road(registry, &tc.name, &tc.arguments, on_event)).await
        {
            Ok(out)     => out,
            Err(secs)   => Ok(MessageContent::text(crate::tools::error_line(
                &tool_ceiling_note(secs)))),
        }
    }

    /// A tool result as the model running this turn may be shown it: whole when the model is
    /// proven to read a picture ([`LlmClient::sight_proven`]), and with its pictures turned into
    /// words when it is not, so a picture is never spent on a model nobody has shown can read one.
    ///
    /// Only a model that has REFUSED pictures is announced as one that would not look; an unproven
    /// model has refused nothing, and the chat would record "would not look" of it untruly.
    async fn shown<H: Host>(
        &self,
        registry:   &ToolRegistry<H>,
        result:     MessageContent,
        on_event:   &mut impl FnMut(AgentEvent),
    )
        -> MessageContent
    {
        if !result.has_image() || self.llm.sight_proven() {
            return result;
        }
        if !self.llm.can_take_images() {
            on_event(AgentEvent::Unseeable {
                images: result.images().count(),
                model:  self.llm.model.clone(),
                source: self.llm.sight_source().to_string(),
            });
        }
        crate::tools::unproven_sight(&registry.ctx, result, self.llm.dropped_why(false)).await
    }

    /// [`Self::one_call`] with its events put in a buffer instead of on the wire.
    ///
    /// The one thing a batch cannot share is the `&mut` event closure, so each call in a batch
    /// gets a `Vec` of its own and the round drains them in the model's order.  A method rather
    /// than a closure at the call site because the borrow of the sink has to outlive the future,
    /// which a closure built inside a `map` cannot arrange.
    fn call_buffered<'a, H: Host>(
        &'a self,
        registry:  &'a ToolRegistry<H>,
        tc:        &'a crate::protocol::ToolCall,
        truncated: bool,
        sink:      &'a mut Vec<AgentEvent>,
    )
        -> Pin<Box<impl Future<Output = Outcome<MessageContent>> + 'a>>
    {
        // Boxed where it is defined, so a caller's poll frame holds a pointer and not this
        // future: a debug wasm turn otherwise overflows its 1 MiB stack (CCP4-STACKPIN).
        Box::pin(self.call_buffered_body(registry, tc, truncated, sink))
    }

    async fn call_buffered_body<H: Host>(
        &self,
        registry:  &ToolRegistry<H>,
        tc:        &crate::protocol::ToolCall,
        truncated: bool,
        sink:      &mut Vec<AgentEvent>,
    )
        -> Outcome<MessageContent>
    {
        let mut into = |e: AgentEvent| sink.push(e);
        self.one_call(registry, tc, truncated, &mut into).await
    }

    /// Answer every call of a group a Stop cut off mid-run, as a failure that says so: the
    /// first call was announced before the group ran, and each after it is announced here, so
    /// the page's events still alternate call, result.
    fn answer_stopped(
        &self,
        session:    &mut Session,
        working:    &mut Vec<ChatMessage>,
        group:      &[crate::protocol::ToolCall],
        on_event:   &mut impl FnMut(AgentEvent),
    ) {
        for (n, tc) in group.iter().enumerate() {
            if n > 0 {
                on_event(Self::announce(tc));
            }
            // A command is answered as told to stop (r578e D1), any other call as stopped.
            let text = stopped_call(&tc.name).to_string();
            on_event(AgentEvent::ToolResult {
                name:       tc.name.clone(),
                result:     text.clone(),
                outcome:    crate::tools::CallOutcome::Failed,
                paused:     String::new(),
                class:      String::new(),
            });
            let reply = ChatMessage::tool(tc.id.clone(), MessageContent::text(text.clone()));
            working.push(reply.clone());
            session.messages.push(reply);
        }
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

    /// Race one model call against the turn's liveness clock, beaten at the call's start and by
    /// every line its stream delivers; `None` when the clock ran out first and the call was
    /// dropped.  Stop still wins: the stream reader races the halt itself, and the call is
    /// polled first here.
    fn live_call<'a, F: std::future::Future + 'a>(
        &'a self,
        call: F,
    )
        -> Pin<Box<impl Future<Output = Option<F::Output>> + 'a>>
    {
        // Boxed where it is defined, so a caller's poll frame holds a pointer and not this
        // future: a debug wasm turn otherwise overflows its 1 MiB stack (CCP4-STACKPIN).
        Box::pin(self.live_call_body(call))
    }

    async fn live_call_body<F: std::future::Future>(&self, call: F) -> Option<F::Output> {
        let live = self.liveness.clone();
        live.beat(crate::llm::now_ms());
        let out = async move {
            loop {
                let (now, due) = (crate::llm::now_ms(), live.due_at());
                if now >= due { return; }
                // Never past one limit at a nap: a reply hold released early brings `due` in.
                crate::llm::sleep_ms((due - now).min(live.limit_ms())).await;
            }
        };
        match race(call, out).await {
            Won::First(v)   => Some(v),
            Won::Second(()) => None,
        }
    }

    /// A model call ran out its liveness limit: the first time in a round is the round's stall
    /// retry and is said as one; the second is not retried.  Does the round ask again?
    ///
    /// ONE RULE FOR BOTH RETRIES.  The stream's own stall retry asks again only a round that
    /// produced nothing (`acc.size() == 0` in `stream_turn`); a round that had begun keeps what it
    /// said.  So here: an attempt that has already handed the caller text or reasoning (`said`)
    /// is not asked again, or the page would show that text twice; it ends the turn.
    fn stalled_live(&self, expiries: &mut u32, said: bool, on_event: &mut impl FnMut(AgentEvent))
        -> bool
    {
        *expiries += 1;
        let again = *expiries == 1 && !said;
        on_event(AgentEvent::Stall {
            model:    self.llm.model.clone(),
            provider: String::new(),
            secs:     self.liveness.limit_ms() / 1_000,
            retried:  again,
        });
        again
    }

    /// End a turn whose model stream made no progress for the liveness limit: twice in a round,
    /// or once after it had already said something (which is never asked again, so the sentence
    /// does not claim a second ask).
    async fn end_timed_out<H: Host>(
        &self,
        rounds:     usize,
        claims:     &Claims,
        registry:   Option<&ToolRegistry<H>>,
        on_event:   &mut impl FnMut(AgentEvent),
    )
        -> Outcome<()>
    {
        let secs = self.liveness.limit_ms() as f64 / 1_000.0;
        on_event(AgentEvent::Error(fmt!(
            "The model made no progress for {:.1} s, so the turn ended there.", secs)));
        // THE ROUND THAT WENT QUIET IS NOT ONE OF THE ROUNDS (U3a REP): it was sent and never
        // answered, so the ending counts the rounds the model did answer.  A worker that worked
        // three rounds and then went silent "timed out after 3 rounds", never 4.
        let ending = self.audit(TurnEnd::TimedOut, rounds.saturating_sub(1), claims, registry).await;
        self.ended(ending, on_event);
        on_event(AgentEvent::Done);
        Ok(())
    }

    /// End a turn its halt has stopped, at a seam: nothing more is sent and nothing is said.
    ///
    /// The ending is `Stopped`, the one a Stop that lands mid-stream gives, so the page hands
    /// the turn back the same way whichever moment the Stop or the pause landed in.
    async fn stop_halted<H: Host>(
        &self,
        rounds:     usize,
        claims:     &Claims,
        registry:   Option<&ToolRegistry<H>>,
        on_event:   &mut impl FnMut(AgentEvent),
    )
        -> Outcome<()>
    {
        let ending = self.audit(TurnEnd::Stopped, rounds, claims, registry).await;
        self.ended(ending, on_event);
        on_event(AgentEvent::Done);
        Ok(())
    }

    fn run_tool_loop<'a, H: Host>(
        &'a self,
        session:  &'a mut Session,
        working:  Vec<ChatMessage>,
        first:    &'a ToolRegistry<H>,
        boundary: &'a mut impl Boundary<H>,
        on_event: &'a mut impl FnMut(AgentEvent),
    )
        -> Pin<Box<impl Future<Output = Outcome<()>> + 'a>>
    {
        // Boxed where it is defined, so a caller's poll frame holds a pointer and not this
        // future: a debug wasm turn otherwise overflows its 1 MiB stack (CCP4-STACKPIN).
        Box::pin(self.run_tool_loop_body(session, working, first, boundary, on_event))
    }

    async fn run_tool_loop_body<H: Host>(
        &self,
        session:    &mut Session,
        mut working: Vec<ChatMessage>,
        first:      &ToolRegistry<H>,
        boundary:   &mut impl Boundary<H>,
        on_event:   &mut impl FnMut(AgentEvent),
    ) -> Outcome<()> {
        // A worker on its parent's model sends its parent's tools array, byte for byte (r578c).
        let mut tools_json = self.tools_json(first);
        // The tool schema rides on every request and is not in the conversation, so it is
        // counted separately -- a budget blind to it is short by however many tools are
        // registered, which for the browser set is several thousand tokens.
        let mut schema = tools_json.as_ref().map(|s| s.len() as u64).unwrap_or(0);
        // THE REGISTRY A ROUND RUNS UNDER, once the boundary has offered a newer one: a scope or
        // a roster changed mid-turn waits for the next round and is never refused.
        let mut adopted: Option<Rc<ToolRegistry<H>>> = None;
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
        let mut setbacks = Setbacks::default();
        // Set when a call was held back as a repeat, or a target failed once too often; the turn
        // ends on it, blocked, at the end of the round, so every call of the round still gets its
        // result.  The flag is whether the user is offered the Decision as well: a turn that
        // ended wanting a machine asks its one question in the sentence alone (UNBLOCK-32 F4).
        let mut blocked: Option<(String, bool)> = None;
        // A refusal left standing when the model tries to end gets ONE must-fix nudge.
        let mut refusal_nudged = false;
        // And a page that fails its load proof when the model tries to end gets ONE as well (K1).
        let mut proof_nudged = false;
        // What this turn did to its Diamond's page, for the honest ending (infographic fix 5).
        let mut page = PageLog::default();
        // How many looks the engine took itself: a turn that changed its page and has not looked
        // since is looked for before it ends (D-20261009-27), at most `LOOKS_AUTO_MAX` times.
        let mut looks_auto = 0usize;
        // THE ENGINE'S OWN LOOK, by the id it was given: the flag that tells its call from the
        // model's.  Not read off the id's text, which the model could also produce.
        let mut look_call: Option<String> = None;
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
        // THE TURN'S OWN STATE, held here and not in the conversation (UNBLOCK-27 R3, R4): what
        // the ask names as its product, whether that is written, and how long since any file
        // outside a scratch folder changed.  A fold or a dropped reasoning block cannot reach it.
        // See `crate::turn_state` for how its no-progress rule and the ORCHESTRATE budget meet.
        let mut state = {
            let ask = working.iter().rev().find_map(|m| match m {
                ChatMessage::User { content, .. } => Some(content.as_text().into_owned()),
                _                                 => None,
            }).unwrap_or_default();
            crate::turn_state::TurnState::new(&ask, self.limits.borrow().no_progress_rounds)
        };
        loop {
            if let Some(next) = boundary.round(session) {
                // THE PROMPT NAMES THE ROSTER THE ROUND IS OFFERED: a sentence left naming the old
                // one promises a tool the model lacks, or hides one it has. One cache miss per
                // change, and only the tools sentence is rewritten.
                let was = match &adopted {
                    Some(r) => self.system_parts(r).1,
                    None    => self.system_parts(first).1,
                };
                let (_, now, brief) = self.system_parts(&next);
                if was != now {
                    if let Some(ChatMessage::System { content: MessageContent::Text(sys) })
                        = working.first_mut()
                    {
                        *sys = retell_tools(sys, &was, &now, &brief);
                    }
                }
                tools_json = next.definitions_json();
                schema = tools_json.as_ref().map(|s| s.len() as u64).unwrap_or(0);
                adopted = Some(next);
            }
            let registry: &ToolRegistry<H> = match &adopted {
                Some(r) => r,
                None    => first,
            };
            self.llm.set_pin(session.pin.clone());          // this conversation's host (r578 U3)
            // A STOPPED TURN GOES NO FURTHER, asked before anything of the next round -- the
            // cap's fold, the proactive fold, the request -- can spend.  The seam below asks it
            // too; this is the top of a round a nudge `continue`s straight into, and of the first.
            if self.llm.halted() {
                return self.stop_halted(rounds, &claims, Some(registry), on_event).await;
            }
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
            if self.fold_if_needed(registry.ctx.host(), session, &mut working, schema, Fold::IfNeeded, on_event).await
                == Refit::Folded {
                round_at.clear();
            }
            round_at.push(working.len());
            // THE RESULTS THE TURN HAS FINISHED READING, in batches; see
            // `compact::sweep_in_turn`. The figures are read off `Limits`, not off the constants
            // they default to, so that `Agent::set_tune` can move them. Copied out of the borrow:
            // the loop awaits below, and a `RefCell` borrow held across an await is a panic
            // waiting for a second caller.
            let limits = self.limits.borrow().clone();
            let past = compact::past_line(
                self.gauge.tokens(compact::conversation_bytes(&working) + schema),
                session.last_prompt_tokens, limits.retire_line(self.reply_cap()));
            if compact::sweep_in_turn(&mut working, &round_at, &limits, past) > 0 {
                compact::carry_retired(&mut session.messages, &working);
            }
            let (swept, sweep_every) = (round_at.len(), limits.sweep_every.max(1));
            let mut sent = compact::conversation_bytes(&working);

            // Stream this round's assistant text as it arrives; the tool
            // calls (if any) are returned assembled once the round ends.
            let mut refolded = false;
            // What this endpoint would take BEFORE the request goes out. Only a refusal can
            // change it and it changes it exactly once, so sampling either side of the round is
            // the whole of the learned signal -- no counter and no flag of our own.
            let could_see = self.llm.can_take_images();
            let mut expiries = 0u32; // this round's liveness expiries
            let mut resp = loop {
                // Has this attempt handed the caller anything?  Then it is not asked again.
                let said = std::cell::Cell::new(false);
                let got = self.live_call(self.llm.chat_stream_tools(
                    &working,
                    tools_json.as_deref(),
                    &mut |d| { said_any(&said, &d); match d {
                        Delta::Text(token)  => on_event(AgentEvent::Text(token.to_string())),
                        Delta::Reasoning(t) => on_event(AgentEvent::Thinking(t.to_string())),
                        // A pre-first-token retry, shown as a caption and never written
                        // to the transcript — see the note in the streaming loop above.
                        Delta::Roading { attempt, of, wait_ms } => {
                            self.liveness.beat(crate::llm::now_ms().saturating_add(wait_ms));
                            on_event(AgentEvent::Roading { name: String::new(), attempt, of, wait_ms })
                        }
                        // A silent provider, as in the streaming loop above.
                        Delta::Waiting { provider, secs } =>
                            on_event(AgentEvent::Wait {
                                model: self.llm.model.clone(), provider: provider.to_string(), secs }),
                        Delta::Stalled { provider, secs, retrying } =>
                            on_event(AgentEvent::Stall {
                                model: self.llm.model.clone(), provider: provider.to_string(),
                                secs, retried: retrying }),
                    }},
                )).await;
                // NO PROGRESS FOR THE LIVENESS LIMIT (U3a LV2), as in the streaming loop.
                let got = match got {
                    Some(g) => g,
                    None if self.llm.halted() =>
                        return self.stop_halted(rounds, &claims, Some(registry), on_event).await,
                    None => {
                        if self.stalled_live(&mut expiries, said.get(), on_event) { continue; }
                        return self.end_timed_out(rounds, &claims, Some(registry), on_event).await;
                    }
                };
                match got {
                    Ok(r) => break r,
                    Err(e) => {
                        // The net under the proactive fold: a window nobody published, or
                        // an estimate that ran short. One retry, and only for a refusal
                        // that looks like the prompt being too long.
                        if !refolded && self.overflowed(&e, sent + schema) {
                            refolded = true;
                            if self.fold_if_needed(registry.ctx.host(), session, &mut working, schema, Fold::Refused,
                                on_event).await.changed() {
                                sent = compact::conversation_bytes(&working);
                                continue;
                            }
                        }
                        on_event(AgentEvent::Error(e.to_string()));
                        let mut ending = self.audit(
                            TurnEnd::Failed, rounds, &claims, Some(registry)).await;
                        ending.said = e.to_string();
                        ending.fault = crate::llm::failure_class(&e);
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
                on_event(AgentEvent::Unseeable {
                    images,
                    model:  self.llm.model.clone(),
                    source: self.llm.sight_source().to_string(),
                });
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
            // why a round that answered nothing is exactly the one this has to reach.  On EVERY
            // round, ids or none (U3a RM): its timing facts are what a worker's liveness limit
            // is tuned from, and a healthy round is the one that sets it.
            on_event(AgentEvent::RoundMeta {
                gen_id:               resp.gen_id.clone(),
                finish_reason:        resp.finish_reason.clone(),
                native_finish_reason: resp.native_finish_reason.clone(),
                provider:             resp.provider.clone(),
                stalled:              resp.stalled,
                bytes:                resp.bytes,
                first_ms:             resp.first_ms,
                gap_ms:               resp.gap_ms,
                ms:                   resp.ms,
                prompt_tokens:        resp.prompt_tokens,
                cached_tokens:        resp.cached_tokens,
                completion_tokens:    resp.completion_tokens,
                tok_ms:               resp.tok_ms,
                gen_ms:               resp.gen_ms,
            });
            // The host this round leaves the conversation pinned to (r578 U3).
            session.pin = self.llm.settle_pin(&resp);

            // Cancelled mid-stream: keep the partial answer already
            // streamed and end the turn cleanly, without an error.  STOPPED AFTER THE STREAM
            // ENDED is the same ending: a halt set as the round's last bytes arrived, or by the
            // round's own trace event, leaves tool calls this turn must not run.
            if resp.aborted || self.llm.halted() {
                // Nothing at all arrived before the Stop: no message, because an empty
                // assistant turn is one a strict provider refuses when the chat is replayed.
                if !resp.content.trim().is_empty() {
                    session.messages.push(ChatMessage::Assistant {
                        content: MessageContent::text(crate::llm::seamed(resp.content)),
                        tool_calls: Vec::new(),
                    });
                }
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
                        working.push(ChatMessage::app(nudge.clone()));
                        session.messages.push(ChatMessage::app(nudge));
                        continue;
                    }
                    let mut ending = self.audit(
                        TurnEnd::Malformed, rounds, &claims, Some(registry)).await;
                    // A malformed turn resolves rather than errs, so this sentence is the only
                    // reason a parent of a worker ever reads (ZERO-ROUND QA 2).
                    ending.said = fmt!("The model wrote its tool calls as text twice running, so none of them ran.");
                    self.ended(ending, on_event);
                    on_event(AgentEvent::Done);
                    return Ok(());
                }
            } else {
                leaks = 0;
            }

            // THE ENGINE LOOKS (D-20261009-27: "it should be able to view the crystal pixels itself,
            // can it, and why isn't it??").  A daimon that changed its Diamond's page and has not
            // looked at it since may not end blind: its ending becomes a round that draws the page
            // at a phone and a desktop width, with the owner's theme and data, and measures what
            // the style edits named.  The model then answers with the look in front of it -- the
            // pictures when it reads pictures, else the images model's words and the table.  Not
            // over a refusal or a failed load proof, whose nudges come first.  Nor on the leg's
            // last round: the look is a round, and one past the cap forces a fold over an answer
            // already given (r546 D-26 F4), or on the final leg ends the turn `Capped`.
            if resp.tool_calls.is_empty() && leg < max_rounds && looks_auto < LOOKS_AUTO_MAX && page.look_due()
                && setbacks.unmended().is_none() && registry.ctx.crystal_proof_blocked().is_none()
            {
                if let Some(dia) = registry.ctx.daimon() {
                    looks_auto += 1;
                    let id = engine_call_id(
                        crate::tools::LOOK_AUTO_ID, &[&session.messages, &working]);
                    look_call = Some(id.clone());
                    resp.tool_calls.push(crate::protocol::ToolCall {
                        id,
                        name:      crate::tools::Tool::Capture.name().to_string(),
                        arguments: crate::tools::auto_look_args(&dia, &page.sels),
                    });
                }
            }
            if resp.tool_calls.is_empty() {
                let empty_reply = resp.content.trim().is_empty();
                // A TURN THAT REPORTS ON PENDING, GAVE ITS WORD THERE AND ENDED EMPTY IS DONE.
                // Its silence is the routine-mail outcome the ruling asks for, so neither nudge
                // below may ask it to say something.  Reasoning no longer decides it: a reasoning
                // model always sends some, and routine mail ended `reasoned_only`, a false alert
                // re-run and billed again (post-QA r569qa2 item 2).  A cut-off thought made no
                // pending call, so it is still nudged (CHECK_ABC B2).
                let quiet = empty_reply && self.quiet_end(&claims);
                let pending_only = self.pending_only.get();
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
                if empty_reply && !quiet && !report_nudged && !claims.calls.is_empty() && !claims.alerted() {
                    report_nudged = true;
                    let said = ChatMessage::Assistant {
                        content:    MessageContent::text(crate::llm::seamed(resp.content.clone())),
                        tool_calls: Vec::new(),
                    };
                    working.push(said.clone());
                    session.messages.push(said);
                    let nudge = if pending_only { pending_report_nudge() } else { report_nudge() };
                    working.push(ChatMessage::app(nudge.clone()));
                    session.messages.push(ChatMessage::app(nudge));
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
                if empty_reply && !quiet && !claims.alerted() && (reasoned_only > 0 || !resp.thinking.trim().is_empty()) {
                    reasoned_only += 1;
                    claims.reasoned += 1;
                    let said = ChatMessage::Assistant {
                        content:    MessageContent::text(crate::llm::seamed(resp.content.clone())),
                        tool_calls: Vec::new(),
                    };
                    working.push(said.clone());
                    session.messages.push(said);
                    if reasoned_only == 1 {
                        let nudge = if pending_only { pending_reasoned_nudge() } else { reasoned_only_nudge() };
                        working.push(ChatMessage::app(nudge.clone()));
                        session.messages.push(ChatMessage::app(nudge));
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
                let mut how = if empty_reply && !quiet && !claims.alerted() { TurnEnd::Silent } else { TurnEnd::Answered };
                // A REFUSAL STILL STANDING IS NOT AN ANSWER.  Told once that it must mend it,
                // the model gets the round; a second ending over it is `Blocked`, and the
                // refusal's own words are what the user reads.
                let mut said = String::new();
                // A refusal of a side action, its kind of work done in an earlier round, that nothing
                // mended: the turn is done, and says what was refused (`Setbacks`).
                let mut side = String::new();
                let all_side = setbacks.unmended().is_some() && setbacks.blocking().is_none()
                    && refusal_nudged;
                // A refusal another route went round is said too, never dropped (SETBACKS2).
                let mut said_side: Vec<&Unmended> = setbacks.routed().iter().collect();
                if all_side {
                    said_side.extend(setbacks.side());
                }
                for u in said_side {
                    match &u.named {
                        Some(p) => side.push_str(&fmt!("\n\nRefused: {} {}: {}", u.tool, p, u.head)),
                        None    => side.push_str(&fmt!("\n\nRefused: {}: {}", u.tool, u.head)),
                    }
                }
                if let Some(u) = setbacks.unmended().filter(|_| !all_side) {
                    if !refusal_nudged {
                        refusal_nudged = true;
                        let nudge = refusal_nudge(&u.tool, &u.head);
                        let reply = ChatMessage::Assistant {
                            content: MessageContent::text(resp.content.clone()),
                            tool_calls: Vec::new(),
                        };
                        working.push(reply.clone());
                        session.messages.push(reply);
                        working.push(ChatMessage::app(nudge.clone()));
                        session.messages.push(ChatMessage::app(nudge));
                        continue;
                    }
                    let u = setbacks.blocking().unwrap_or(u);
                    how = TurnEnd::Blocked;
                    said = fmt!("Not done: {} was refused and I could not mend it. {}",
                        u.tool, u.head);
                } else if let Some(why) = page.undelivered() {
                    how = TurnEnd::Blocked;
                    said = why.to_string();
                } else if let Some(proof) = registry.ctx.crystal_proof_blocked() {
                    // THE PAGE FAILS ITS LOAD PROOF, READ FROM OUTSIDE AS THE OWNER SEES IT (K1,
                    // D-20261008-08): the edit's result said MUST FIX, and a model that ends over
                    // it is told so once; ending over it again is `Blocked`, not a delivery.
                    if !proof_nudged {
                        proof_nudged = true;
                        let nudge = proof.must_fix().unwrap_or_default();
                        let reply = ChatMessage::Assistant {
                            content: MessageContent::text(resp.content.clone()),
                            tool_calls: Vec::new(),
                        };
                        working.push(reply.clone());
                        session.messages.push(reply);
                        working.push(ChatMessage::app(nudge.clone()));
                        session.messages.push(ChatMessage::app(nudge));
                        continue;
                    }
                    how = TurnEnd::Blocked;
                    said = proof.said().unwrap_or_default();
                }
                if how != TurnEnd::Blocked && !side.is_empty() {
                    on_event(AgentEvent::Text(side.clone()));
                    resp.content.push_str(&side);
                }
                // THE SEAM, and only here. A run of prose with a tool call after it is
                // working rather than an answer -- `demoteToWorking` in the page draws it as
                // the model's own thinking -- so a `Fold:` line in one of those would build a
                // control over something nobody is meant to read as a reply.
                session.messages.push(ChatMessage::Assistant {
                    content: MessageContent::text(crate::llm::seamed(resp.content)),
                    tool_calls: Vec::new(),
                });
                let mut ending = self.audit(how, rounds, &claims, Some(registry)).await;
                ending.said = said;
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
            // A ROUND THAT ASKS FOR A WORKER HOLDS ITS REQUEST AS SENT (r578c), before the asking
            // turn joins it: each worker starts as this request plus its own hand-off.  See
            // `crate::fork`.  A worker's own spawn is refused at the call, so it holds nothing.
            if !registry.ctx.is_unsupervised() && resp.tool_calls.iter()
                .any(|t| crate::tools::Tool::from_name(&t.name) == Some(crate::tools::Tool::SpawnAgent))
            {
                let (system, messages) = crate::fork::Fork::from_working(&working);
                registry.ctx.hold_fork(crate::fork::Fork {
                    model:     self.llm.model.clone(),
                    system,
                    tools:     tools_json.clone(),
                    belt:      registry.tools.clone(),
                    daimon_of: registry.ctx.daimon_of.clone(),
                    messages,
                    carry:     self.llm.carry_export(),
                    pin:       self.llm.pin(),
                });
            }
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
            // One response's calls are one round of setbacks (`FAILS_STOP`).
            setbacks.next_round();
            let names: Vec<&str> = resp.tool_calls.iter().map(|t| t.name.as_str()).collect();
            // SETTLED BEFORE ANYTHING RUNS, and ahead of `held`: a duplicate or a call past the
            // cap never reaches a tool, `with_folds`, the setbacks, the claims or the page, so a
            // call that never ran is never recorded as done.  It still gets its `ToolResult` and
            // its reply, so the pairing holds.  See [`settle_calls`].
            let settled = settle_calls(&resp.tool_calls, resp.truncated);
            let mut outcomes: Vec<Option<crate::tools::CallOutcome>> =
                vec![None; resp.tool_calls.len()];
            for span in batch::batches(&names) {
                let base = span.start; // index of the group's first call in the reply
                // A HALT SET WHILE AN EARLIER CALL OF THIS ROUND RAN stops the calls after it.
                // Their assistant turn is already in the session, so the calls left unanswered
                // are paired off as a road failure's are (`abandon_round`).
                if self.llm.halted() {
                    self.abandon_round(session, &mut working);
                    return self.stop_halted(rounds, &claims, Some(registry), on_event).await;
                }
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
                // WHERE A DESTRUCTIVE CALL'S PATH SAT, asked before it runs: after a delete there
                // is nothing left to ask. For the lens, which carries no path.
                let class = registry.path_class(&group[0].name, &group[0].arguments).await;
                // A sink per call while a batch runs, drained into `on_event` in the model's
                // order as each result is recorded.  Empty for a batch of one, which keeps its
                // events live.  Today it is provably empty for a batch of several as well --
                // only `over_the_road` writes to it, and nothing in `batch::may_run_beside` is
                // `road_retryable` -- but a tool that later becomes both would otherwise have its
                // caption emitted from inside a concurrent poll, against a `&mut` closure that
                // cannot be shared.
                let mut sinks: Vec<Vec<AgentEvent>> = Vec::new();
                // A CALL THAT ALREADY FAILED TWICE THE SAME WAY IS NOT SENT A THIRD TIME.  It is
                // answered as a refusal, so the conversation stays well formed, and the turn ends
                // at the seam with the choice put to the user.  Only the same call, arguments and
                // all: a corrected one is sent.
                let pre: Vec<bool> = (0..group.len())
                    .map(|n| settled[base + n] != Settled::Run)
                    .collect();
                // AND A CALL TO THE `run` STUB IS NOT SENT EITHER (UNBLOCK-32 F4).  It could only
                // be refused, and calling the stub the request offered is how the model says the
                // ask needs a command; the turn ends at the seam on the question that says what
                // is missing, rather than probing on with the file tools.  Only the stub
                // (UNBLOCK-32 F4b): a machine tool never offered gets its own refusal and the
                // turn goes on.  And never in a worker, which nobody can answer: there the
                // refusal comes back as a result and the worker carries on to its report.
                let alone = registry.ctx.is_unsupervised();
                let wanting: Vec<bool> = group.iter().zip(pre.iter())
                    .map(|(tc, p)| !*p && crate::tools::Tool::from_name(&tc.name)
                        .map_or(false, |t| registry.stubbed(&t)))
                    .collect();
                let held: Vec<Option<(String, String)>> = group.iter().zip(pre.iter())
                    .zip(wanting.iter())
                    .map(|((tc, p), w)| if *p { None } else if *w {
                        Some((wanting_said(&tc.name, alone),
                            wanting_told(&tc.name, &registry.ctx.unconfirmed,
                                &crate::tools::device_label())))
                    } else {
                        setbacks.held(&tc.name, &tc.arguments)
                            .map(|head| (held_said(&tc.name, head), held_told(&tc.name, head)))
                    })
                    .collect();
                // A READ PAST 2K QUIET ROUNDS IS NOT SENT (UNBLOCK-27 R4).  Answered as a refusal
                // that says to deliver; nothing that writes, builds, runs or dispatches is ever
                // held here, so the act that delivers always goes through.
                let closed: Vec<bool> = group.iter().map(|tc| state.refuses(&tc.name)).collect();
                let shut = state.refusal();
                let truncated = resp.truncated;
                let halt = self.llm.halt();
                let work = async { if group.len() == 1 {
                    if pre[0] {
                        // Answered in the record loop below, once the original's outcome is known.
                        vec![Ok(MessageContent::text(String::new()))]
                    } else if let Some((said, _)) = &held[0] {
                        vec![Ok(MessageContent::text(crate::tools::refusal_line(said)))]
                    } else if closed[0] {
                        vec![Ok(MessageContent::text(shut.clone()))]
                    } else {
                        vec![self.one_call(registry, &group[0], truncated, on_event).await]
                    }
                } else {
                    sinks = group.iter().map(|_| Vec::new()).collect();
                    let futs: Vec<_> = group.iter().zip(sinks.iter_mut()).zip(held.iter())
                        .zip(pre.iter()).zip(closed.iter())
                        .map(|((((tc, sink), h), p), c)| {
                            let shut = &shut;
                            async move {
                                if *p {
                                    Ok(MessageContent::text(String::new()))
                                } else if let Some((said, _)) = h {
                                    Ok(MessageContent::text(crate::tools::refusal_line(said)))
                                } else if *c {
                                    Ok(MessageContent::text(shut.clone()))
                                } else {
                                    self.call_buffered(registry, tc, truncated, sink).await
                                }
                            }
                        })
                        .collect();
                    batch::all_of(futs).await
                } };
                // A STOP LANDS WHILE A TOOL RUNS, not when it finishes: the group is raced against
                // the turn's halt and dropped where it stands.  A dropped command's child goes
                // with it and a JS promise's late answer is discarded; what a call had already
                // done stays done, and its reply says so.  Every call of the group is answered, so
                // the conversation stays whole, and the turn ends at the seam as a Stop between
                // groups ends it.
                let outs: Vec<Outcome<MessageContent>> = match race(work, halt.fired()).await {
                    Won::First(outs)    => outs,
                    Won::Second(())     => {
                        self.answer_stopped(session, &mut working, group, on_event);
                        self.abandon_round(session, &mut working);
                        return self.stop_halted(rounds, &claims, Some(registry), on_event).await;
                    },
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
                            let mut ending = self.audit(
                                TurnEnd::Failed, rounds, &claims, Some(registry)).await;
                            ending.said = e.plain();
                            ending.fault = crate::llm::failure_class(&e);
                            self.ended(ending, on_event);
                            return Err(e);
                        }
                    };
                    // A SETTLED CALL is answered here and nowhere else: its event and its reply,
                    // with the outcome of the call that answers for it, and nothing recorded.
                    let said = match settled[base + n] {
                        Settled::Run		=> None,
                        Settled::Same(j)	=> {
                            let o = outcomes[j].unwrap_or(crate::tools::CallOutcome::Failed);
                            Some((same_call_reply(&resp.tool_calls[j].id, o), o))
                        },
                        Settled::Unrun		=> Some((unrun_call_note(self.reply_cap()),
                            crate::tools::CallOutcome::Failed)),
                    };
                    if let Some((text, outcome)) = said {
                        outcomes[base + n] = Some(outcome);
                        on_event(AgentEvent::ToolResult {
                            name:   tc.name.clone(),
                            result: text.clone(),
                            outcome,
                            paused: String::new(),
                            class:  String::new(),
                        });
                        let reply = ChatMessage::tool(tc.id.clone(), MessageContent::text(text));
                        working.push(reply.clone());
                        session.messages.push(reply);
                        continue;
                    }
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
                    let result = self.with_folds(registry.ctx.host(), session, tc, result).await;
                    let outcome = crate::tools::call_outcome(&result.as_text());
                    // INTO THE TURN'S STATE, and a read that returns what the same call returned
                    // before says so (R3).  Prefixed rather than replacing the result: the
                    // earlier copy may since have been retired or folded away.
                    let seen = match crate::turn_state::Class::of(&tc.name) {
                        crate::turn_state::Class::Read => Some(crate::turn_state::result_hash(&result)),
                        _                              => None,
                    };
                    let claimed = crate::tools::Tool::from_name(&tc.name)
                        .map(|t| t.path_claims(&tc.arguments, registry.ctx.daimon().as_deref()))
                        .unwrap_or_default();
                    let result = match state.record(&tc.name, &tc.arguments, outcome, &claimed,
                        seen, rounds)
                    {
                        Some(r) => headed(result, &fmt!("Unchanged since round {}: the same call \
                            returned exactly this then.", r)),
                        None    => result,
                    };
                    // Mutable because the setbacks below may add a line to it; see `Setbacks`.
                    let mut text = result.as_text().into_owned();
                    // The engine's own look opens on what it is, and a look that could not be
                    // taken on why, so the daimon says so rather than calling the page seen.
                    let auto = look_call.as_deref() == Some(tc.id.as_str());
                    let result = if auto {
                        let head = look_auto_head(outcome);
                        text = fmt!("{}\n\n{}", head, text);
                        headed(result, &head)
                    } else {
                        result
                    };
                    // THE SAME FAILURE, COUNTED, by the tool layer's own outcome.  Only a call
                    // that failed or was refused is counted: reading one file twice is ordinary,
                    // and a turn that verifies its own work makes the same successful call on
                    // purpose.
                    //
                    // A read the no-progress rule closed (R4) is not booked: the engine withheld
                    // it rather than the call failing, and what lifts it is the delivery, not a
                    // mend of the read.  Booked, it stood as an unmended refusal that no write of
                    // the deliverable could clear, so a turn that delivered ended `Blocked`.
                    // Nor is a worker's wanting call (UNBLOCK-32 F4b): its result told it to carry
                    // on and say in its report what it could not run, so it is not a refusal to
                    // mend, and booked it turned a delivered report into `Blocked`.
                    let paused = crate::tools::paused_node(&text).is_some();
                    let wants = wanting.get(n).copied().unwrap_or(false);
                    let verdict = if closed.get(n).copied().unwrap_or(false) || (wants && alone) {
                        Verdict::default()
                    } else {
                        setbacks.record(&tc.name, &tc.arguments, &text, outcome, paused)
                    };
                    if let Some(w) = verdict.warn {
                        text.push_str(&fmt!("\n{}", w));
                    }
                    if wants && alone {
                        // A worker's wanting is its result alone; see `wanting` above.
                    } else if let Some(Some((_, told))) = held.get(n) {
                        // THE WANTING QUESTION OUTRANKS A SETBACK earlier in the round (UNBLOCK-32
                        // F4b): it says what is missing and what to do, where the setback's card
                        // only says the turn could not get past something.  The first wanting
                        // call's question stands.
                        match &blocked {
                            Some((_, false))        => {},
                            Some(_) if !wants       => {},
                            _                       => blocked = Some((told.clone(), !wants)),
                        }
                    } else if let Some(stop) = verdict.stop {
                        blocked.get_or_insert((stop, true));
                    }
                    if auto {
                        // Taken or not, the engine's look is spent: its result says which.
                        look_call = None;
                        page.looked();
                    } else if outcome == crate::tools::CallOutcome::Done {
                        page.saw(&tc.name, &tc.arguments);
                    } else {
                        page.failed(&tc.name, &tc.arguments);
                    }
                    // AND THE AUDIT IS KEPT FROM THE SAME VERDICT, not from a second reading of
                    // it. The paths come from the ARGUMENTS the model sent, which name the file
                    // it meant whatever the reply says about it.
                    claims.record_said(&tc.name, &tc.arguments, outcome, registry.ctx.daimon().as_deref(), &text);
                    outcomes[base + n] = Some(outcome);
                    // ASKED OF THE RESULT, and of every call in the round rather than of the
                    // first: a round may carry several, and the question may not be the one that
                    // came back first.
                    asked |= ends_turn(&tc.name, outcome);
                    on_event(AgentEvent::ToolResult {
                        name:   tc.name.clone(),
                        result: text.clone(),
                        outcome,
                        // Which pause node refused it, read from the line the registry composed
                        // for it (`crate::tools::paused_line`), never from the sentence.
                        paused: crate::tools::paused_node(&text).unwrap_or_default(),
                        // Only the first of a group can be destructive: `batch` runs nothing
                        // beside a call that writes.
                        class:  match (&class, n) {
                            (Some(c), 0) => c.wire(matches!(outcome,
                                crate::tools::CallOutcome::Refused)),
                            _            => String::new(),
                        },
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
                    let result = self.shown(registry, result, on_event).await;
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

            // STOPPED WHILE THE TOOLS RAN, which is where a slow tool's turn spends its time:
            // every call is answered, so the conversation is whole, and the next request is
            // never sent.  Asked before the interjections, which stay queued for the page to
            // take back rather than being written into a turn that is over.
            if self.llm.halted() {
                return self.stop_halted(rounds, &claims, Some(registry), on_event).await;
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
            // EACH WITH ITS OWN ROW ID (CCP3 F3): the words log knows his messages by (row, text),
            // so two equal ones with none were filed as one.  The page's id where it gave one.
            let now = registry.ctx.host().clock().now_ms();
            for (k, said) in self.take_interjections().into_iter().enumerate() {
                on_event(AgentEvent::Interjected(said.text.clone()));
                let mid = match said.mid.is_empty() {
                    true  => fmt!("said-{:x}-{}", now as u64, k),
                    false => said.mid,
                };
                let msg = ChatMessage::user_noted(said.text, said.pre).marked(mid);
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

            // A TURN THAT IS GOING ROUND IN A CIRCLE IS ENDED, AND THE USER IS ASKED.  At the
            // seam rather than inside the round, so every call the model made this round still
            // gets its own result and the conversation is well formed.
            if let Some((said, decide)) = blocked.take() {
                self.end_blocked(session, &mut working, said, decide, rounds, &claims, registry,
                    on_event).await;
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
                let (rounds_left, usd_left, fraction_left) = {
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
                    // THE NEARER of the two real limits, as the fraction of it left.  A turn
                    // that is nowhere near either is told nothing: a notice that appears while
                    // hundreds of rounds remain is read as an invitation to stop, and one that
                    // names a figure is a number a model spends to.
                    // The WHOLE turn's rounds, every leg it may run, which is what `left`
                    // counts down from; the legs run so far would put `left` over its total.
                    let rounds_total = (l.max_continuations + 1) * max_rounds;
                    let round_frac = if rounds_total == 0 { 0.0 }
                        else { left as f64 / rounds_total as f64 };
                    let frac = match usd {
                        Some(u) => round_frac.min(u / l.spend_cap_usd),
                        None    => round_frac,
                    };
                    (left, usd, frac)
                };
                let from = round_at.last().copied().unwrap_or(working.len());
                if let Some(i) = compact::note_budget(&mut working, from, rounds_left, usd_left,
                    fraction_left)
                {
                    keep_post(session, &working[i]);
                }
            }
            // AND WHERE THE TURN STANDS, every round, after the budget line (R3), with the deliver
            // line from K quiet rounds (R4).  Both on this round's own result, and both KEPT with
            // the session's copy of it, so the next turn sends the bytes this one cached (r578).
            let line = state.end_round(rounds);
            let from = round_at.last().copied().unwrap_or(working.len());
            if let Some(i) = compact::note_turn_state(&mut working, from, &line) {
                keep_post(session, &working[i]);
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
    fn over_the_spend_cap<H: Host>(
        &self,
        session:      &Session,
        opening_cost: f64,
        registry:     &ToolRegistry<H>,
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
    async fn stop_on_spend<H: Host>(
        &self,
        session:    &mut Session,
        spent:      f64,
        cap:        f64,
        rounds:     usize,
        claims:     &Claims,
        registry:   &ToolRegistry<H>,
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

    /// End a turn that is going round in a circle: say why, offer the choice, end `Blocked`.
    ///
    /// The sentence is the assistant's last word, so the model reads it next turn and the user
    /// reads it now.  The Decision is the app's own `ask`, dispatched like any other, so the card,
    /// its answer and the turn after it work exactly as a daimon's own question does; where `ask`
    /// is not on offer, or this is a worker nobody can be asked from, the sentence stands alone.
    ///
    /// # Arguments
    /// * `decide` - Whether to offer the Decision at all; a sentence that is itself the question
    ///   stands alone, so the user is asked one thing and not two.
    fn end_blocked<'a, H: Host>(
        &'a self,
        session:  &'a mut Session,
        working:  &'a mut Vec<ChatMessage>,
        said:     String,
        decide:   bool,
        rounds:   usize,
        claims:   &'a Claims,
        registry: &'a ToolRegistry<H>,
        on_event: &'a mut impl FnMut(AgentEvent),
    )
        -> Pin<Box<impl Future<Output = ()> + 'a>>
    {
        // Boxed where it is defined, so a caller's poll frame holds a pointer and not this
        // future: a debug wasm turn otherwise overflows its 1 MiB stack (CCP4-STACKPIN).
        Box::pin(self.end_blocked_body(session, working, said, decide, rounds, claims, registry,
            on_event))
    }

    async fn end_blocked_body<H: Host>(
        &self,
        session:    &mut Session,
        working:    &mut Vec<ChatMessage>,
        said:       String,
        decide:     bool,
        rounds:     usize,
        claims:     &Claims,
        registry:   &ToolRegistry<H>,
        on_event:   &mut impl FnMut(AgentEvent),
    ) {
        let ask = crate::tools::Tool::Ask;
        let can_ask = decide && registry.offered().contains(&ask) && !registry.ctx.is_unsupervised();
        on_event(AgentEvent::Text(said.clone()));
        if can_ask {
            let tc = crate::protocol::ToolCall {
                id:        fmt!("daimond-blocked-{}", rounds),
                name:      ask.name().to_string(),
                arguments: blocked_ask_args(),
            };
            let asked = ChatMessage::Assistant {
                content:    MessageContent::text(said.clone()),
                tool_calls: vec![tc.clone()],
            };
            working.push(asked.clone());
            session.messages.push(asked);
            on_event(Self::announce(&tc));
            let result = match self.one_call(registry, &tc, false, on_event).await {
                Ok(c)  => c,
                Err(e) => MessageContent::text(fmt!("{}: {}", crate::tools::ERROR_OPENING, e.plain())),
            };
            let text = result.as_text().into_owned();
            let outcome = crate::tools::call_outcome(&text);
            on_event(AgentEvent::ToolResult {
                name:    tc.name.clone(),
                result:  text,
                outcome,
                paused:  String::new(),
                class:   String::new(),
            });
            let reply = ChatMessage::tool(tc.id.clone(), result);
            working.push(reply.clone());
            session.messages.push(reply);
        } else {
            let msg = ChatMessage::assistant(said.clone());
            working.push(msg.clone());
            session.messages.push(msg);
        }
        let mut ending = self.audit(TurnEnd::Blocked, rounds, claims, Some(registry)).await;
        ending.said = said;
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
    async fn stop_on_orphan<H: Host>(
        &self,
        session:    &mut Session,
        rounds:     usize,
        grace:      usize,
        claims:     &Claims,
        registry:   &ToolRegistry<H>,
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
    fn at_the_cap<'a, H: Host>(
        &'a self,
        session:       &'a mut Session,
        working:       &'a mut Vec<ChatMessage>,
        round_at:      &'a mut Vec<usize>,
        schema:        u64,
        registry:      &'a ToolRegistry<H>,
        claims:        &'a Claims,
        rounds:        usize,
        max_rounds:    usize,
        continuations: &'a mut usize,
        opening_cost:  f64,
        on_event:      &'a mut impl FnMut(AgentEvent),
    )
        -> Pin<Box<impl Future<Output = Option<Outcome<()>>> + 'a>>
    {
        // Boxed where it is defined, so a caller's poll frame holds a pointer and not this
        // future: a debug wasm turn otherwise overflows its 1 MiB stack (CCP4-STACKPIN).
        Box::pin(self.at_the_cap_body(session, working, round_at, schema, registry, claims, rounds, max_rounds,
            continuations, opening_cost, on_event))
    }

    async fn at_the_cap_body<H: Host>(
        &self,
        session:        &mut Session,
        working:        &mut Vec<ChatMessage>,
        round_at:       &mut Vec<usize>,
        schema:         u64,
        registry:       &ToolRegistry<H>,
        claims:         &Claims,
        rounds:         usize,
        max_rounds:     usize,
        continuations:  &mut usize,
        opening_cost:   f64,
        on_event:       &mut impl FnMut(AgentEvent),
    )
        -> Option<Outcome<()>>
    {
        self.fold_if_needed(registry.ctx.host(), session, working, schema, Fold::Capped, on_event).await;
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
        // The transport tags a refusal for size where it can tell (`LlmClient`'s `too_big`);
        // the words and the size estimate remain for an error that reached here untagged.
        if e.tags().contains(&ErrTag::TooBig) {
            return true;
        }
        let budget = self.limits.borrow().budget(self.reply_cap());
        compact::looks_like_overflow(e, self.gauge.tokens(bytes), budget)
    }

    /// Whether a fold is due and where it would cut, decided before anything is asked of a
    /// model.  [`Agent::fold_if_needed`] acts on it, and the Wire asks it of the conversation a
    /// turn will open on (r578d B3), so the two cannot disagree about a turn that folds first.
    /// `None` is no fold; a plan with `cut` 0 shortens the sent copy and folds nothing.
    ///
    /// # Arguments
    /// * `est` - The estimated tokens of the request, tool schemas included.
    /// * `real` - The provider's own prompt tokens from the last round, 0 where none is known.
    /// * `ts` - The index of the turn's opening message, `usize::MAX` for none to keep.
    /// * `rest` - Tokens the carry must reach before an unforced pass runs again.
    fn fold_plan(&self, msgs: &[ChatMessage], est: u64, real: u64, schema: u64, why: Fold,
        ts: usize, rest: u64)
        -> Option<FoldPlan>
    {
        let (budget, tail) = {
            let l = self.limits.borrow();
            let cap = self.reply_cap();
            (l.budget(cap), l.tail_budget(cap))
        };
        // Size read two ways -- the up-front byte estimate and the provider's real prompt_tokens
        // from the last round -- because the estimate under-counts and can sit under budget while
        // the real carry has passed it. `last_prompt_tokens` refreshes after this round's own send,
        // so a fold prompted by it is corrected within the round and does not repeat once the carry
        // is back under. See `compact::needs_fold`.
        if !compact::needs_fold(est, real, budget, why.forces()) {
            return None;
        }
        // AN EARLIER PASS THIS TURN COULD NOT GET UNDER THE TARGET, so the same pass is not run
        // again until the carry has grown by a fold's worth.  See `Agent::fold_rest`.
        if !why.forces() && est < rest {
            return None;
        }
        let gain = (budget as f64 * compact::MIN_FOLD_GAIN) as u64;
        // The hard ceiling is the budget itself: however few messages that leaves, a tail
        // bigger than what may be sent is a fold that changed nothing.
        let ceiling = self.gauge.bytes(budget).saturating_sub(schema);
        let keep = self.gauge.bytes(tail).min(ceiling);
        let mut cut = compact::tail_start(&msgs, keep, compact::MIN_KEEP_MESSAGES,
            ceiling);
        // A FOLD AT THE ROUND LIMIT THAT FOLDS NOTHING IS THE COMMON CASE, not the rare one.
        // `tail_start` answers 0 whenever the whole conversation fits the tail budget, and a
        // turn stopped at ten rounds has not filled 48,000 tokens -- so the leg that continues
        // started from the raw log with no plan in front of it, and no summary was ever made.
        // That is why a fold fired once in four hundred and twenty-two bank trials.  At this one
        // door the question is different: the log is about to be re-sent on every round of the
        // next leg, so it is worth replacing with a note.  See `compact::capped_cut`, which
        // answers 0 when there is genuinely nothing worth folding.
        let capped = cut == 0 && why.at_the_cap();
        if capped {
            cut = compact::capped_cut(&msgs, ceiling);
        }
        // THE TURN'S OWN ASK SURVIVES A CUT THROUGH THE TURN.  The cut may land inside the turn
        // in flight -- a floor at its start would stop a long turn ever folding -- so the
        // opening message is set back verbatim behind the notice, and its bytes come out of the
        // tail it joins: the cut is chosen again against what is left, which only moves it
        // later.  See `compact::pinned_opening`.
        //
        // AND SO DO HIS WORDS FROM THE FOLDED PART (R1, invariant 2).  His newest ride verbatim
        // in the notice up to a fixed share, the rest are filed in his words log (HIGH-A), so only
        // that bounded section is reserved here as the pin's bytes are, before the summary is
        // sized.  With no words log they all ride, as before.
        let pin0  = compact::pinned_opening(&msgs, ts, cut);
        let said  = if cut > 0 { compact::person_said(&msgs[..cut], pin0) } else { Vec::new() };
        let held  = pin0.map(compact::msg_bytes).unwrap_or(0)
            + self.planned_words(&said, budget).len() as u64;
        if held > 0 {
            let ceil = ceiling.saturating_sub(held);
            cut = if capped {
                compact::capped_cut(&msgs, ceil)
            } else {
                compact::tail_start(&msgs, keep.saturating_sub(held),
                    compact::MIN_KEEP_MESSAGES, ceil)
            };
        }
        let pin = compact::pinned_opening(&msgs, ts, cut).cloned();
        // A FOLD THAT FREES TOO LITTLE IS NOT PAID FOR.  A cut over nothing but an earlier fold
        // note re-summarises a summary, and one that frees less than a tenth of the budget, net
        // of the note it writes, is re-triggered by the next tool result: on 2026-10-12 that was
        // sixteen paid summaries in sixteen rounds, each folding one message or none.  A forced
        // fold is asked for whatever it frees, so only the first test binds it.
        //
        // AND WORDS CARRIED AGAIN ARE NOT FREED (HIGH-A): what the new notice carries back of the
        // old one's words is counted out, so a fold that only re-carries them is not made.
        if cut > 0 {
            let only_notes = msgs[..cut].iter().all(compact::is_fold_notice);
            let again = self.planned_words(&compact::person_said(&msgs[..cut], pin.as_ref()),
                budget).len() as u64;
            let freed = compact::conversation_bytes(&msgs[..cut]).saturating_sub(again);
            let worth = self.gauge.bytes(gain + compact::FOLD_MAX_TOKENS as u64);
            if only_notes || (!why.forces() && freed < worth) {
                cut = 0;
            }
        }
        // NO REFOLD WITHOUT NEW HISTORY (CCP3 (a)).  A conversation that is still the one the
        // last fold left holds nothing a new summary could say, so folding it again only rewrites
        // the notice -- a new cache epoch and a paid summary -- turn after turn, which is the
        // loop a notice carrying all his words (R1) fell into.  The copy is still shortened.
        // Only his own press folds regardless.
        if cut > 0 && !matches!(why, Fold::ByHand) && self.no_new_history(msgs) {
            cut = 0;
        }
        Some(FoldPlan { budget, ceiling, gain, cut, pin })
    }

    /// Is `msgs` still the conversation the last fold left, with nothing said since?
    fn no_new_history(&self, msgs: &[ChatMessage]) -> bool {
        match &*self.folded_at.borrow() {
            Some((n, note)) => msgs.len() <= *n
                && msgs.first().map(|m| m.text() == note.as_str()).unwrap_or(false),
            None            => false,
        }
    }

    /// The bytes his newest words may take in a notice: [`compact::WORDS_SHARE`] of the fold's
    /// target under `budget`.
    fn words_share(&self, budget: u64) -> u64 {
        self.gauge.bytes((budget as f64 * compact::FOLD_TARGET * compact::WORDS_SHARE) as u64)
    }

    /// Where his words log is, as the notice names it: the words home's log file.
    fn words_path(&self) -> String {
        fmt!("{}/{}", crate::tools::keeper_home(&self.words_home()), compact::WORDS_FILE)
    }

    /// The words section a fold plans to carry for `said`: with a words home, his newest words
    /// within the share and a line naming the rest; with none, every one of them (R1).
    fn planned_words(&self, said: &[compact::Said], budget: u64) -> String {
        if self.words_home().is_empty() || self.words_unfiled.get() {
            return compact::said_section(said, "");
        }
        let (carried, older) = compact::newest_within(said, self.words_share(budget));
        compact::said_section(&carried, &compact::older_words_line(&older, &self.words_path()))
    }

    /// File `said` in his words log before the notice stops carrying it, and answer the section
    /// the notice carries: his newest words within the share and a line naming every older one
    /// the log holds.  `Err` when there is no words home, or the write or its read-back failed;
    /// the notice then carries them all (R1).
    async fn file_words<H: Host>(&self, host: &H, said: &[compact::Said], budget: u64)
        -> Outcome<String>
    {
        let date = compact::utc_date(host.clock().now_ms());
        let entries = compact::log_entries(said, &date);
        // A runner's fold files into the staged log by the store's own steps, so it answers as
        // the tab's store would, and never into the runner's store (U2a).
        let home = self.words_home.borrow().clone();
        let answer = match home {
            WordsHome::None         => return Err(err!("this conversation keeps no notes file"; Missing)),
            WordsHome::Store(k)     => res!(host.store().his_words(&k, entries).await),
            WordsHome::Staged { keeper, log, added } => {
                let merged = compact::log_merge(&log, &entries);
                let answer = res!(compact::log_answer(&merged, &entries, &self.words_path()));
                *self.words_home.borrow_mut() = WordsHome::Staged { keeper, log: merged,
                    added: fmt!("{}{}", added, entries) };
                answer
            },
        };
        let (total, first) = compact::log_tally(&answer);
        let (carried, older) = compact::newest_within(said, self.words_share(budget));
        // The newest older one is this fold's where it has any; else it was filed by an earlier
        // fold and only the oldest is named.
        let last = older.last().map(|w| w.mid.clone()).unwrap_or_default();
        Ok(compact::said_section(&carried, &compact::older_line(
            total.saturating_sub(carried.len()), &first, &last, &self.words_path())))
    }

    /// The tools array a request carries.  A worker on its parent's model sends its parent's,
    /// byte for byte (r578c).
    fn tools_json<H: Host>(&self, registry: &ToolRegistry<H>) -> Option<String> {
        match (self.fork.borrow().as_ref(), self.fork_same.get()) {
            (Some(f), true) => f.tools.clone(),
            _               => registry.definitions_json(),
        }
    }

    /// Bytes of the tools array riding beside the conversation: nothing where the turn runs
    /// without tools, which is `run_streaming`'s request.
    fn schema_bytes<H: Host>(&self, registry: &ToolRegistry<H>) -> u64 {
        match registry.is_empty() {
            true  => 0,
            false => self.tools_json(registry).map(|s| s.len() as u64).unwrap_or(0),
        }
    }

    /// Will a turn opening on `prior` fold before its first request?  The question
    /// [`Agent::run_turn_noted`] meets at its first round, asked of the request it would build:
    /// the system message, the earlier turns retired, and the turn's own note.  The words the
    /// user is about to send are not known here, so they count as none.  `real` is the
    /// provider's prompt tokens from the last round, `session.last_prompt_tokens`, which the
    /// turn reads beside the estimate (r578e D4); 0 where none is known.
    pub fn opens_with_fold(&self, prior: &[ChatMessage], registry: &ToolRegistry, real: u64)
        -> bool
    {
        let note = crate::prompts::turn_note(&self.blocks.borrow(), prior);
        let mut msgs = prior.to_vec();
        msgs.push(ChatMessage::user_noted(String::new(), note).said_by(crate::protocol::Origin::App));
        let mut sent = msgs.clone();
        let (keep, retire) = {
            let l = self.limits.borrow();
            (l.retire_keep_turns, l.retire_prior)
        };
        if retire {
            compact::retire_upto(&mut sent, compact::prior_end(&msgs, keep));
        }
        // The system message as the turn composes it (see `run_turn_noted`), counted the same way.
        let system = match self.system_prompt.is_empty() {
            true  => 0,
            false => {
                let (mut sys, tools, brief) = self.system_parts(registry);
                for part in [tools, brief] {
                    if !part.is_empty() {
                        sys.push_str("\n\n");
                        sys.push_str(&part);
                    }
                }
                compact::msg_bytes(&ChatMessage::system(sys))
            },
        };
        let schema = self.schema_bytes(registry);
        let est = self.gauge.tokens(system + compact::conversation_bytes(&sent) + schema);
        match self.fold_plan(&msgs, est, real, schema, Fold::IfNeeded, msgs.len() - 1, 0) {
            Some(p) => p.cut > 0,
            None    => false,
        }
    }

    /// The note a turn opening on `prior` sends, for the Wire: only the blocks changed since
    /// their last copy, or every block where the turn folds first and restates them all.
    pub fn wire_note(&self, prior: &[ChatMessage], registry: &ToolRegistry, real: u64) -> String {
        match self.opens_with_fold(prior, registry, real) {
            true  => crate::prompts::turn_note(&self.blocks.borrow(), &[]),
            false => crate::prompts::turn_note(&self.blocks.borrow(), prior),
        }
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
    /// * `host` - The host the fold files its notes through.
    /// * `session` - The durable conversation, folded in place.
    /// * `working` - This turn's message list, rebuilt from the session when anything moved.
    /// * `schema` - Bytes of tool definitions riding alongside the conversation.
    /// * `why` - What brought the fold about; see [`Fold`].
    /// * `on_event` - Where the user is told, since a silent fold is the one people hate.
    fn fold_if_needed<'a, H: Host>(
        &'a self,
        host:     &'a H,
        session:  &'a mut Session,
        working:  &'a mut Vec<ChatMessage>,
        schema:   u64,
        why:      Fold,
        on_event: &'a mut impl FnMut(AgentEvent),
    )
        -> Pin<Box<impl Future<Output = Refit> + 'a>>
    {
        // Boxed where it is defined, so a caller's poll frame holds a pointer and not this
        // future: a debug wasm turn otherwise overflows its 1 MiB stack (CCP4-STACKPIN).
        Box::pin(self.fold_if_needed_body(host, session, working, schema, why, on_event))
    }

    async fn fold_if_needed_body<H: Host>(
        &self,
        host:       &H,
        session:    &mut Session,
        working:    &mut Vec<ChatMessage>,
        schema:     u64,
        why:        Fold,
        on_event:   &mut impl FnMut(AgentEvent),
    )
        -> Refit
    {
        // A refusal is the only occasion the provider ever says anything about the size of
        // its window. Believing it is what lets a chat against a model nobody published a
        // window for recover instead of folding to a budget that was never the real one --
        // and it is why a fold the USER asked for must not come through here, since that
        // one carries no news at all.
        if why.teaches_window() {
            let refused = self.gauge.tokens(compact::conversation_bytes(working) + schema);
            self.limits.borrow_mut().learn_from_refusal(refused);
        }
        let (model, shape) = {
            let l = self.limits.borrow();
            (l.fold_model.clone(), l.fold_shape)
        };
        let before = compact::conversation_bytes(&session.messages);
        let est = self.gauge.tokens(compact::conversation_bytes(working) + schema);
        // A fold the user asked for runs between turns, where `turn_start` names the last turn's
        // opening and pinning it would carry an old request forward.  See `Agent::fold_plan`.
        let ts = if matches!(why, Fold::ByHand) { usize::MAX } else { self.turn_start.get() };
        let FoldPlan { budget, ceiling, gain, cut, pin } = match self.fold_plan(&session.messages,
            est, session.last_prompt_tokens, schema, why, ts, self.fold_rest.get())
        {
            Some(p) => p,
            None    => return Refit::Untouched,
        };
        let mut folded  = 0usize;
        let mut trouble = String::new();
        let mut unfiled = String::new();     // filing his words failed, said on the fold row
        // WHO WROTE THE SUMMARY, for the product record its notice carries: the model the fold
        // actually asked -- the fold model where one is set, else this agent's -- and the
        // fingerprint of the compactor's instructions.  Both stay empty where no summary was
        // asked for, since a notice with nothing a model wrote behind it is not a product.
        let mut by_model = String::new();
        let mut by_sp    = String::new();
        // Whether the note came back in the layout, which the feed carries and the bank counts.
        let mut structured = false;
        let mut summarised = false;
        // THE LINE THE FOLD LANDS UNDER, set before the summary is asked for so the summary can
        // be sized to it (invariant 7).  See `compact::FOLD_TARGET`.
        let target = self.gauge.bytes((budget as f64 * compact::FOLD_TARGET) as u64)
            .saturating_sub(schema);
        if cut > 0 {
            // Built before the summarising call, so a call that fails still leaves a
            // truthful record: which files were read, which were written, what ran, and
            // which of those failed. That is the part no model is asked for and so no model
            // can lose.
            let ledger   = compact::ledger_of(&session.messages[..cut]);
            let rendered = compact::render_for_fold(&session.messages[..cut],
                compact::FOLD_INPUT_CAP);
            // A SUMMARY IS ASKED FOR ONLY WHAT ROOM IS LEFT.  The notice is a user message, so
            // no elision shortens it: a summary as long as the model cared to write was a fold
            // that landed over target (KT-5b, 18.9k tokens against 11.2k).  The room is what the
            // target leaves after the kept tail at its elided floor, his pinned words in full,
            // and the notice's own frame and ledger.
            let capped = why.at_the_cap() || pin.is_some();
            let tail   = if pin.is_some() { compact::TURN_CONTINUES_NOTE } else { "" };
            // HIS WORDS FIRST (R1): his newest messages before the cut ride verbatim in the
            // notice, up to their share, and are part of its frame, so the summary is sized to
            // what they leave; the rest are filed in his words log below (HIGH-A).
            let said   = compact::person_said(&session.messages[..cut], pin.as_ref());
            let planned = self.planned_words(&said, budget);
            let room   = compact::notice_room(&session.messages[cut..], pin.as_ref(), target);
            // THE FRAME A REAL SUMMARY SITS IN, heading and all: measured with a one-byte
            // summary, less that byte.  An empty one leaves the heading out (M1).
            let frame  = {
                let mut f = compact::notice_with(cut, &planned, &compact::Summary::Prose("x"),
                    &ledger, capped);
                f.push_str(tail);
                compact::msg_bytes(&ChatMessage::user(f)).saturating_sub(1)
            };
            // Rounded down, and a fifth held back for a reply denser in bytes than the gauge
            // prices it; see `compact::FOLD_ASK_MARGIN`.
            let ask = ((room.saturating_sub(frame) as f64 * self.gauge.ratio()
                * compact::FOLD_ASK_MARGIN) as u64).min(shape.max_tokens() as u64) as u32;
            let raw = if ask < compact::FOLD_MIN_ASK {
                Err(fmt!("there was no room left for one under the fold's target"))
            } else {
                by_model = if model.trim().is_empty() { self.llm.model.clone() } else {
                    model.trim().to_string() };
                by_sp = crate::prompts::fingerprint(&self.fold_prompt());
                summarised = true;
                match self.summarise(&rendered, &model, session, why, pin.is_some(), shape, ask)
                    .await
                {
                    Ok((s, false)) => Ok(s),
                    // CUT AT ITS LIMIT IS A DEFINED OUTCOME (M1): trimmed to its last whole
                    // sentence and marked, never riding cut mid-word and never dropped unsaid.
                    Ok((s, true))  => match compact::cut_short(&s) {
                        Some(t) => Ok(t),
                        None    => Err(fmt!("it reached its length limit before one sentence \
                            ended")),
                    },
                    // In plain words: the model reads this, and so does he (L1).
                    Err(e)         => Err(e.plain()),
                }
            };
            // A STOP DURING THE FOLD IS A FOLD NOT MADE (M2).  The halt makes the summary call
            // come back empty, and folding on would rewrite the session under a notice that
            // blames the model for an empty summary it never wrote.  Asked once the call is back,
            // before anything is filed or touched, so the session stands exactly as it was.
            if self.llm.halt().is_set() {
                return Refit::Untouched;
            }
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
                Some(n) => self.file_notes(host, n).await,
                None    => None,
            };
            let summary = match (filed, parsed, &raw) {
                (Some(left), _, _)   => compact::Summary::Filed(left),
                (None, Some(n), _)   => compact::Summary::Notes(n),
                (None, None, Ok(t))  => compact::Summary::Prose(t),
                (None, None, Err(e)) => compact::Summary::None(e),
            };
            if let Err(ref e) = raw { trouble = e.clone(); }
            // HIS WORDS ARE FILED BEFORE THE NOTICE STOPS CARRYING THEM (HIGH-A): written, read
            // back and compared by the store, and only then left out.  Filing that fails leaves
            // every one of them in the notice (R1), and he is told.
            let filing = self.file_words(host, &said, budget).await;
            self.words_unfiled.set(filing.is_err() && !said.is_empty());
            let words = match filing {
                Ok(w)  => w,
                Err(e) => {
                    if !said.is_empty() && !self.words_home().is_empty() {
                        unfiled = fmt!(" Your earlier messages could not be filed in this \
                            conversation's notes ({}), so all of them stay in the note.", e.plain());
                    }
                    compact::said_section(&said, "")
                },
            };
            // A turn cut through CONTINUES from the note, exactly as a capped one does.  And a
            // reply longer than it was asked for -- a model, or a mock, that ignores
            // `max_tokens` -- still lands under target: see `compact::notice_within`.
            let (note, kept) = compact::notice_within(cut, &words, &summary, &ledger, capped,
                tail, room);
            structured = kept && matches!(summary,
                compact::Summary::Notes(_) | compact::Summary::Filed(_));
            if !kept && trouble.is_empty() {
                trouble = fmt!("it came back longer than the fold had room for");
            }
            match compact::fold_keeping(&session.messages, cut, pin.as_ref(), note) {
                Ok(new) => {
                    // A fold that made the conversation bigger is not a fold; it happens
                    // when the folded part was small and the note is not.
                    if compact::conversation_bytes(&new) < before {
                        session.messages = new;
                        folded = cut;
                        *self.folded_at.borrow_mut() = session.messages.first()
                            .map(|m| (session.messages.len(), m.text().to_string()));
                        // AND THE BOUNDARY COMES WITH IT. A fold renumbers the conversation, so
                        // the index recorded at the top of the turn now names a different message
                        // -- a later one, because the list got shorter, which is the turn in
                        // flight. See `compact::prior_end_after_fold`.
                        self.prior_end.set(compact::prior_end_after_fold(
                            self.prior_end.get(), cut));
                        // AND SO DOES THE TURN'S OWN START, by the same arithmetic: a caller
                        // that slices `session.messages[turn_start..]` after the turn must be
                        // handed an index into the list as it now is, not as it was.
                        // Where the opening was pinned it is the message behind the notice.
                        self.turn_start.set(if pin.is_some() { 1 } else {
                            compact::prior_end_after_fold(self.turn_start.get(), cut) });
                        // AND THE TURN'S NOTE RESTATES EVERY BLOCK (r578).  The copies the fold
                        // cut are gone from what the model reads, and a fold is a new cache epoch,
                        // so rewriting this one note costs nothing the fold had not already cost.
                        // Between turns there is no turn in flight: the next one's note is worked
                        // out against the folded conversation and restates them by itself.
                        if !matches!(why, Fold::ByHand) {
                            self.restate_blocks(session);
                        }
                    }
                },
                // Refused rather than allowed to orphan a tool call. Eliding below still
                // shrinks the same conversation, and cannot orphan anything at all.
                Err(e) => trouble = e.plain(),
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
        // A fold is a new cache epoch, so retiring here costs nothing the fold had not; marked, so
        // the turns after it send the same stubs (D-20261020-11).
        if self.limits.borrow().retire_prior {
            compact::restub(&mut sent);
            compact::retire_upto(&mut sent, self.prior_end.get().min(session.messages.len()));
            compact::carry_retired(&mut session.messages, &sent);
        }
        //
        // TO THE TARGET, NOT TO THE LINE.  Shortened only until it was under the trigger, the
        // conversation crossed it again with the next round's tool result and folded again; see
        // `compact::FOLD_TARGET`.  The second pass, which reaches the newest messages, goes only
        // as far as the line: the newest work is cut only when it would not otherwise fit.
        let mut elided = compact::elide_bulk(&mut sent, target,
            compact::MIN_KEEP_MESSAGES);
        elided += compact::elide_bulk(&mut sent, ceiling, 1);
        // Measured on what will be SENT, since that is what the sentence below is about.
        let after = compact::conversation_bytes(&sent);
        // NO PROGRESS, NO REPEAT: left above the target, or freed less than a fold's worth, the
        // turn does not run this again until it has grown by that much.  See `fold_rest`.
        let was = compact::conversation_bytes(working);
        let left = self.gauge.tokens(after + schema);
        if after > target || was.saturating_sub(after) < self.gauge.bytes(gain) {
            self.fold_rest.set(left.max(est) + gain);
        } else {
            self.fold_rest.set(0);
        }
        if folded == 0 && elided == 0 {
            // And `working` is left exactly as it was, elisions and all. Rebuilding it from the
            // session on the way out of a fold that changed nothing would throw away an earlier
            // round's shortening and hand the caller a request over the budget again.
            return Refit::Untouched;
        }

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
        if folded > 0 {
            said.push_str(&unfiled);
        }
        // OVER THE TARGET IS SAID, WITH WHY (invariant 7, M1).  What is left is the newest work,
        // which the second elision pass shortens only as far as the ceiling, and his own words,
        // which nothing shortens.
        if after > target {
            said.push_str(&fmt!(" That is still above the fold's target of about {} tokens: \
                what is left is the newest work and your own words, which are kept whole.",
                self.gauge.tokens(target)));
        }
        // Its own event, not a borrowed tool row. A fold is something the app did to the
        // user's conversation, and it is lossy; the counts travel beside the sentence so a
        // client can draw it as the act it was rather than parse prose to find out.
        on_event(AgentEvent::Compacted {
            folded,
            kept: session.messages.len(),
            note: said,
            structured,
            model: by_model,
            sp: by_sp,
            cut,
            summarised,
        });
        // SHORTENING ALONE IS NOT A FOLD.  The user is still told (the 2026-08-28 ruling), but the
        // record is untouched and nothing was summarised, so the caller does not treat it as one
        // and the page does not file it in the feed as a fold; see `Refit`.
        if folded == 0 { Refit::Shortened } else { Refit::Folded }
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
    /// Off the browser (a host that is not `HOSTED`) there are no Diamonds and nothing to file
    /// into: a Diamond is browser storage -- `diamonds/<id>/` is OPFS and nothing else -- so the
    /// native build has no store to write to rather than a store it declines to write to.
    ///
    /// # Arguments
    /// * `notes` - The parsed notes, already reconciled against the ledger.
    async fn file_notes<H: Host>(&self, host: &H, notes: &compact::FoldNotes) -> Option<compact::FoldNotes> {
        if !H::HOSTED {
            return None;
        }
        let id = self.diamond();
        if id.trim().is_empty() {
            return None;
        }
        host.store().absorb_fold_notes(&id, notes).await
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
    /// * `mid_turn` - Whether the cut runs through the turn in flight, which then continues.
    /// * `shape` - Which layout the compactor is asked for.
    /// * `ask` - Tokens it may write: the shape's budget, or less where the fold has less room.
    ///
    /// Answers the summary and whether the provider cut it at `ask`.
    async fn summarise(
        &self,
        rendered: &str,
        model:    &str,
        session:  &mut Session,
        why:      Fold,
        mid_turn: bool,
        shape:    compact::FoldShape,
        ask:      u32,
    )
        -> Outcome<(String, bool)>
    {
        let mut llm = self.llm.clone();
        if !model.trim().is_empty() {
            llm.model = model.trim().to_string();
        }
        llm.max_tokens = ask;
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
        // is the plan it starts on rather than a remark about the future. So is a fold that cuts
        // through the turn in flight (`mid_turn`), whose opening is pinned behind the note. The
        // others are a record for whatever comes next, which may be the user.
        let opening = if why.at_the_cap() {
            "The turn has hit its round limit and CONTINUES from your note in the next round. \
             Write `## Next step` as the plan it starts on."
        } else if mid_turn {
            "The turn is still running and CONTINUES from your note in the next round; its \
             opening request is kept word for word after the note. Write `## Next step` as the \
             plan it carries on with."
        } else if matches!(why, Fold::ByHand) {
            "The user asked for this fold."
        } else {
            "Here is the earlier part of the conversation."
        };
        // THE LENGTH IS SAID, not only capped (M1): a model told nothing writes to its own idea
        // of a summary and is cut mid-sentence at `max_tokens`.  Three words to four tokens.
        let words = (ask as u64 * 3 / 4).max(1);
        let msgs = vec![
            ChatMessage::system(system),
            ChatMessage::user(fmt!("{} Write at most {} words.\n\n{}", opening, words, rendered)),
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
        Ok((resp.content, resp.truncated))
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

// ┌───────────────────────────────────────────────────────────────┐
// │ A failure repeated is a change of approach, never a loop        │
// └───────────────────────────────────────────────────────────────┘

/// How many failures the same way, of the same call, before that call is not sent again.
const SAME_WAY_HOLDS: usize = 2;

/// Note in `said` that a delta the caller sees -- text or reasoning -- has gone out.
fn said_any(said: &std::cell::Cell<bool>, d: &Delta<'_>) {
    if matches!(d, Delta::Text(_) | Delta::Reasoning(_)) { said.set(true); }
}

/// What a call cut at its own ceiling reads as: a failure, said plainly.
fn tool_ceiling_note(secs: u64) -> String {
    fmt!("did not finish within its own limit of {} s, so it was cut there. Anything it had \
        already written stays written: check before doing it again, or ask for a longer limit \
        where the tool takes one.", secs)
}

/// How many model ROUNDS in a row with a failure on the same target, with nothing landing on it
/// between them, before the turn stops and asks.
///
/// Rounds, not calls (UNBLOCK-16 SETBACKS, w114): one response that sent three searches of one
/// folder was stopped on its own three refusals before the model had read a single one of them.
/// A response's calls are one decision, so they count once.
///
/// The 2026-10-08 Ontheism turn checked its page eleven times, each failing differently, and
/// nothing in the loop could tell that from progress.  A call on the target that completes is
/// that progress, and clears the count (r543 QA F-A2-1).
const FAILS_STOP: usize = 3;

/// One failed or refused call, as the turn's setbacks keep it.
#[derive(Clone, Debug)]
struct Fail {
	target:	u64,	// the tool and the thing it acted on
	call:	u64,	// the tool and its whole arguments, normalised
	sig:	u64,	// the tool and its error, numbers masked
	head:	String,	// the error's first line, for the sentence a held call is answered with
	round:	usize,	// the model round that sent it
}

/// A refusal the turn has not yet mended.
#[derive(Clone, Debug)]
struct Unmended {
	place:	Option<u64>,	// the path it named, normalised; none for a call with no place
	named:	Option<String>,	// that place as the user will read it
	tool:	String,
	head:	String,			// the refusal's first line, as the user will read it
	round:	usize,			// the model round that sent it
}

/// What the turn has seen go wrong, and what that now requires.
///
/// **A repeated identical failure ends in a change of approach or a Decision, never a loop**
/// (the 2026-10-08 transcript analysis).  The second failure of one call the same way says so in
/// the result; that same call, sent a third time unchanged, is not sent and the user is asked;
/// three failures in a row on one target, with nothing completing on it between them, stop the
/// turn the same way.  Every count is read off the tool layer's own outcome and the arguments
/// the model sent, never off its prose.
///
/// **"The same call" means the same tool and the same arguments** (r543 QA F-A2-1).  Keyed on
/// the target alone, two different misses on a file held every later edit of it, so the usual
/// recovery -- re-read the file and send the right `old_string` -- was refused as "this exact
/// call".  A different call is always sent; the target only counts towards `FAILS_STOP`.
///
/// **A refusal is mended by the same place done by its own kind of work, or by another route of
/// the same kind**
/// (UNBLOCK-16 SETBACKS, lead ruling on diagnosis fix 3).  The nudge tells the model to "take
/// another route", and w137 did -- it moved its work to its Diamond's own folder -- yet ended
/// `blocked`, as did w127, which read the path it had first written with a `..`.  So the place
/// is compared normalised, and a done call of the same [`call_kind`] in a LATER round mends it
/// too -- a later round, because only then has the model read the refusal and chosen the route.
/// A refusal of a side action -- one whose kind of work completed in an EARLIER round, like
/// w141's tidy-up delete after its writes -- that nothing mends ends the turn done, with the
/// refusal said.  Work refused beside work landing in the same response, or work that never
/// landed at all, is still `Blocked` (T3, 2026-10-09).
///
/// **A route never erases the refusal** (UNBLOCK-16 SETBACKS2, lead ruling 1): it moves it to
/// `routed`, so the turn ends done AND says "Refused: X".  Only the same place done erases it, and
/// only by the refused call's own tool or a producing one of its kind: a read of a refused write
/// erases nothing (U3a QA2 #2).
/// **Only work that makes something counts** as the route or as earlier work (ruling 2): a
/// listing, a close, a folder made or a file deleted produces nothing ([`call_produces`]), so
/// `runs` after a refused `run` is no route, and `dir_create` is no earlier work.
#[derive(Clone, Debug, Default)]
struct Setbacks {
	fails:	Vec<Fail>,
	open:	Vec<Unmended>,
	routed:	Vec<Unmended>,				// refusals the turn went round, said at its end
	done:	Vec<(&'static str, usize)>,	// each kind of call that completed, and its first round
	round:	usize,						// the model round now being recorded
}

/// What a recorded result now calls for.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
struct Verdict {
	warn:	Option<String>,	// a line added to the result, for the model
	stop:	Option<String>,	// the sentence the turn ends on, blocked
}

impl Setbacks {

	/// Begin recording the calls of the next model response.
	fn next_round(&mut self) {
		self.round += 1;
	}

	/// The error this exact call already failed with twice the same way, if it did, in which
	/// case it is held back rather than sent.
	fn held(&self, name: &str, args: &str) -> Option<&str> {
		let c = call_key(name, args);
		let mine: Vec<&Fail> = self.fails.iter().filter(|f| f.call == c).collect();
		mine.iter()
			.find(|f| mine.iter().filter(|g| g.sig == f.sig).count() >= SAME_WAY_HOLDS)
			.map(|f| f.head.as_str())
	}

	/// Record one result, and say what it calls for.
	///
	/// # Arguments
	/// * `paused` - Whether a pause the user set refused it, which is their decision and not a
	///   fault to mend.
	fn record(
		&mut self,
		name:		&str,
		args:		&str,
		text:		&str,
		outcome:	crate::tools::CallOutcome,
		paused:		bool,
	)
		-> Verdict
	{
		let place = call_place(args);
		let target = call_target(name, args);
		let kind = call_kind(name);
		let round = self.round;
		if outcome == crate::tools::CallOutcome::Done {
			// Progress on the target: what failed on it before no longer counts.
			self.fails.retain(|f| f.target != target);
			// Mended: the same place, normalised, done by the refused call's own kind of work --
			// the same tool, or one of that kind producing something.  A read of a refused write
			// mends nothing, nor a write a refused read (U3a QA2 #2).  Gone round: another route
			// of the same kind, producing something, in a later round -- kept, to be said.
			let produces = !kind.is_empty() && call_produces(name);
			let here = |u: &Unmended| call_kind(&u.tool) == kind
				&& (u.tool == name || produces)
				&& match (u.place, place.as_deref()) {
					(Some(p), Some(q))	=> p == call_fingerprint("", q),
					_					=> false,
				};
			self.routed.retain(|u| !here(u));
			let mut open = Vec::with_capacity(self.open.len());
			for u in self.open.drain(..) {
				if here(&u) {
					continue;
				}
				if produces && call_kind(&u.tool) == kind && u.round < round {
					self.routed.push(u);
				} else {
					open.push(u);
				}
			}
			self.open = open;
			if produces && !self.done.iter().any(|(k, _)| *k == kind) {
				self.done.push((kind, round));
			}
			return Verdict::default();
		}
		let call = call_key(name, args);
		let head = first_line(text);
		let sig = call_fingerprint(name, &masked(&head));
		self.fails.push(Fail { target, call, sig, head: head.clone(), round: self.round });
		if outcome == crate::tools::CallOutcome::Refused && !paused {
			self.open.push(Unmended {
				place: place.as_deref().map(|q| call_fingerprint("", q)),
				named: place.clone(),
				tool:  name.to_string(),
				head:  head.clone(),
				round,
			});
		}
		let same = self.fails.iter().filter(|f| f.call == call && f.sig == sig).count();
		// Distinct rounds, in order: the fails are pushed as the rounds go.
		let mut all = 0;
		let mut last = None;
		for f in self.fails.iter().filter(|f| f.target == target) {
			if last != Some(f.round) {
				all += 1;
				last = Some(f.round);
			}
		}
		let mut v = Verdict::default();
		if same == SAME_WAY_HOLDS {
			v.warn = Some(fmt!("This exact call has failed twice the same way: change approach, \
				or ask the user. Sent again with the same arguments it will not be sent; a call \
				with corrected arguments will be."));
		}
		if all >= FAILS_STOP {
			v.stop = Some(fmt!("{} failed {} times in a row on {}, with nothing completing \
				between, so I have stopped rather than try it again. The last answer was: {}",
				name, all, place.unwrap_or_else(|| fmt!("the same call")), head));
		}
		v
	}

	/// The first refusal still standing, as the user should read it.
	fn unmended(&self) -> Option<&Unmended> {
		self.open.first()
	}

	/// The first refusal still standing that is not of a side action: the one that makes the
	/// turn `Blocked`.
	fn blocking(&self) -> Option<&Unmended> {
		self.open.iter().find(|u| !self.is_side(u))
	}

	/// The refusals still standing of side actions: each is said in the turn's last words, and
	/// none makes it `Blocked`.
	fn side(&self) -> Vec<&Unmended> {
		self.open.iter().filter(|u| self.is_side(u)).collect()
	}

	/// The refusals another route went round: none makes the turn `Blocked`, and each is said
	/// in its last words (UNBLOCK-16 SETBACKS2, lead ruling 1).
	fn routed(&self) -> &[Unmended] {
		&self.routed
	}

	/// Whether a refusal is of a side action: work of its kind completed in an earlier round.
	fn is_side(&self, u: &Unmended) -> bool {
		let kind = call_kind(&u.tool);
		self.done.iter().any(|(k, r)| !kind.is_empty() && *k == kind && *r < u.round)
	}
}

/// Whether a tool's success produces something -- content read, written, run or fetched -- and
/// so counts as another route round a refusal, or as earlier work beside which one is a side
/// action (UNBLOCK-16 SETBACKS2, lead ruling 2).  A listing (`file_list`, `file_glob`,
/// `link_list`, `mail_list`, `runs`, `recall`), a close (`web_close`) and a change that makes
/// nothing (`dir_create`, `file_delete`, `link_remove`) do not.
fn call_produces(name: &str) -> bool {
	use crate::tools::Tool as T;
	!matches!(T::from_name(name), Some(
		T::FileList | T::FileGlob | T::LinkList | T::MailList | T::Runs | T::Recall
		| T::WebClose | T::DirCreate | T::FileDelete | T::LinkRemove))
}

/// The kind of work a tool does -- read, write, run or web -- for deciding that a later success
/// is another route to what a refusal stopped.  A tool of no one kind is its own kind.
fn call_kind(name: &str) -> &'static str {
	use crate::tools::Tool as T;
	let tool = match T::from_name(name) {
		Some(t)	=> t,
		None	=> return "",
	};
	match tool {
		T::FileRead | T::FileList | T::FileSearch | T::FileGlob | T::Outline | T::FileShow
		| T::SheetRead | T::CrystalRead | T::Recall | T::LinkList | T::MailList
		| T::MailSearch | T::MailRead | T::SocialRead
			=> "read",
		T::FileWrite | T::FileEdit | T::FileDelete | T::FileRevert | T::FileMove | T::DirCreate
		| T::ArtefactAdd | T::DocEdit | T::SheetWrite | T::LinkAdd | T::LinkRemove
		| T::MailDraft
			=> "write",
		T::Run | T::Shell | T::Runs | T::Verify | T::Serve | T::TypstCompile
			=> "run",
		T::FileFetch | T::WebOpen | T::WebClose | T::WebFetch | T::WebSearch | T::WebSnapshot
		| T::WebRead | T::WebClick | T::WebType | T::WebScroll
			=> "web",
		other	=> other.name(),
	}
}

/// A call's identity for holding a repeat: its tool and its arguments, with the whitespace
/// between JSON tokens taken out, so a reformatted resend of the same call is the same call.
fn call_key(name: &str, args: &str) -> u64 {
	let mut out = String::with_capacity(args.len());
	let mut quoted = false;
	let mut escaped = false;
	for c in args.trim().chars() {
		if quoted {
			out.push(c);
			match (escaped, c) {
				(true, _)		=> escaped = false,
				(false, '\\')	=> escaped = true,
				(false, '"')	=> quoted = false,
				_				=> {},
			}
		} else if c == '"' {
			quoted = true;
			out.push(c);
		} else if !c.is_whitespace() {
			out.push(c);
		}
	}
	call_fingerprint(name, &out)
}

/// What a call acts on: its path, URL, destination or Diamond, whichever it names first.  A path
/// is normalised, so `a/b/../c` and `a/c` are one place (UNBLOCK-16 SETBACKS, w127) -- but only
/// one whose `..` stays inside: `../x.md` keeps its raw form, so reading `x.md` does not mend a
/// refused climb out (SETBACKS2, lead ruling 3).
fn call_place(args: &str) -> Option<String> {
	["path", "url", "to", "id"].iter()
		.filter_map(|k| crate::llm::extract_json_string(args, k)
			.filter(|v| !v.trim().is_empty())
			.map(|v| match *k {
				"path" | "to" if v.split(|c| c == '/' || c == '\\').any(|s| s == "..")
								=> crate::tools::dotdot_fold(&v).unwrap_or(v),
				"path" | "to"	=> crate::tools::normalise(&v),
				_				=> v,
			}))
		.next()
}

/// A call's target: the tool and its place, or the tool and its whole arguments where it names
/// no place.
fn call_target(name: &str, args: &str) -> u64 {
	match call_place(args) {
		Some(p)	=> call_fingerprint(name, &p),
		None	=> call_fingerprint(name, args),
	}
}

/// A result's first non-empty line, bounded.
fn first_line(text: &str) -> String {
	let line = text.lines().map(|l| l.trim()).find(|l| !l.is_empty()).unwrap_or("");
	line.chars().take(240).collect()
}

/// An error with its numbers masked, so "line 41" and "line 42" read as the same failure.
fn masked(line: &str) -> String {
	line.chars().map(|c| if c.is_ascii_digit() { '#' } else { c }).collect()
}

/// What a turn did to its Diamond's page, read off its tool log.
///
/// **Infographic fix 5, 2026-10-08.**  A turn that put the page back as it was, or whose last
/// check of the page failed, ended as `answered` and its tile read as a delivery.  Both facts are
/// in the calls' outcomes and arguments, so neither is read out of the model's prose.
#[derive(Clone, Debug, Default)]
struct PageLog {
	wrote:		bool,			// a completed call changed the page this turn
	restored:	bool,			// ... and the last one to touch it was a revert
	checked:	Option<bool>,	// the last check of the page: did it fail?
	unseen:		bool,			// the page changed since the turn last looked at it
	sels:		Vec<String>,	// the selectors the edits since then styled
}

impl PageLog {

	/// Note a completed call.
	fn saw(&mut self, name: &str, args: &str) {
		if crate::tools::Tool::looks_at_crystal(name, args) {
			self.checked = Some(false);
			self.looked();
			return;
		}
		let tool = match crate::tools::Tool::from_name(name) {
			Some(t)	=> t,
			None	=> return,
		};
		// No Diamond is named: only a default path depends on it, and a default is never the page.
		let page = tool.path_claims(args, None).iter()
			.any(|(p, _)| crate::tools::is_crystal_page_path(p));
		if !page {
			return;
		}
		if tool == crate::tools::Tool::FileRevert {
			self.restored = self.wrote;
		} else {
			self.wrote = true;
			self.restored = false;
			self.unseen = true;
			for sel in crate::tools::style_targets(args) {
				if !self.sels.contains(&sel) && self.sels.len() < crate::tools::LOOK_TARGETS_MAX {
					self.sels.push(sel);
				}
			}
		}
	}

	/// Note a look at the page: what it showed is the page as it now stands.
	fn looked(&mut self) {
		self.unseen = false;
		self.sels.clear();
	}

	/// Does the turn end on a page it changed and has not looked at since, and did not put back?
	fn look_due(&self) -> bool {
		self.unseen && !self.restored
	}

	/// Note a call that failed or was refused; only a failed check of the page counts.
	fn failed(&mut self, name: &str, args: &str) {
		if crate::tools::Tool::looks_at_crystal(name, args) {
			self.checked = Some(true);
		}
	}

	/// Why the turn did not deliver, or nothing.
	fn undelivered(&self) -> Option<&'static str> {
		if self.restored {
			return Some("I could not make the page; it is back as it was.");
		}
		if self.checked == Some(true) {
			return Some("I could not make the page work; its last check failed.");
		}
		None
	}
}

// How many looks the engine takes itself in one turn: one after the turn's edits, and one more
// when the model edits again after reading it; never a loop.
const LOOKS_AUTO_MAX: usize = 2;

/// An id for a call the engine makes itself, unique in the conversation `held` carries.
///
/// A provider is handed every earlier turn's calls with each request, and Anthropic refuses a
/// request whose `tool_use` ids repeat, so a per-turn counter will not do (r546 D-26 F1: the
/// round number gave `look_auto_3` to most edit turns).  The number starts past every call
/// already held and moves on until the id is free, so a fold that dropped old calls cannot
/// hand out one still standing.
fn engine_call_id(base: &str, held: &[&[ChatMessage]]) -> String {
	let ids = || held.iter().flat_map(|ms| ms.iter()).flat_map(|m| match m {
		ChatMessage::Assistant { tool_calls, .. }	=> tool_calls.iter().map(|t| t.id.as_str()).collect(),
		ChatMessage::Tool { tool_call_id, .. }		=> vec![tool_call_id.as_str()],
		_											=> Vec::new(),
	});
	let mut n = ids().count() + 1;
	loop {
		let id = fmt!("{}_{}", base, n);
		if !ids().any(|t| t == id) {
			return id;
		}
		n += 1;
	}
}

/// What opens the result of the engine's own look: what it is, or, when it could not be taken,
/// that the daimon must say so (the result's own words give the reason).
fn look_auto_head(outcome: crate::tools::CallOutcome) -> String {
	match outcome {
		crate::tools::CallOutcome::Done	=> crate::tools::LOOK_AUTO_HEAD.to_string(),
		_								=> "The engine tried to look at your page after your last edit \
			and could not; the reason follows. Say in your answer that the page was not seen, and \
			why.".to_string(),
	}
}

/// A tool result with `head` put before it, pictures and all.
fn headed(c: MessageContent, head: &str) -> MessageContent {
	match c {
		MessageContent::Text(t)		=> MessageContent::text(fmt!("{}\n\n{}", head, t)),
		MessageContent::Parts(mut v)	=> {
			v.insert(0, crate::protocol::ContentPart::Text(fmt!("{}\n\n", head)));
			MessageContent::Parts(v)
		},
	}
}

/// What the model is told once when it tries to end with a refusal standing.
fn refusal_nudge(tool: &str, head: &str) -> String {
	fmt!("You are ending the turn with {} still refused: {} You MUST fix this now: change the \
		call so it is accepted, or take another route. If you cannot, say plainly what is \
		blocked; the turn will end as not done.", tool, head)
}

/// The sentence a call held back as a repeat is answered with: what was identical, what it
/// failed with, and what to change.
fn held_said(name: &str, head: &str) -> String {
	fmt!("{} was not sent: the same call, with the same arguments, already failed twice with \
		the same error ({}). Sent unchanged it would fail again; change the arguments or take \
		another route.", name, head)
}

/// What the user is told when the turn ends on a held call.
fn held_told(name: &str, head: &str) -> String {
	fmt!("I did not send {} a third time: the same call, with the same arguments, had already \
		failed twice with the same error ({}).", name, head)
}

/// What a call that needs a machine this page has none of is answered with, for the model.
///
/// # Arguments
/// * `alone` - A worker, which nobody can ask: its turn goes on, and its report says what it
///   could not run.
fn wanting_said(name: &str, alone: bool) -> String {
	if alone {
		fmt!("{} was not sent: no folder on this computer is reachable from this page, so no \
			command can run here. Carry on without it, and say in your report what you could not \
			run or check.", name)
	} else {
		fmt!("{} was not sent: no folder on this computer is reachable from this page, so no \
			command can run here. The turn ends now and the user is asked for what is missing.",
			name)
	}
}

/// The one question a turn that needs a machine it has none of ends on: what is missing, where,
/// and what the user can do about it (UNBLOCK-32 F4).
///
/// It names the device that ran the turn and never says "this device": a handed-off turn is
/// read on the device it was sent from, where "this one" is the wrong machine (F4b).
///
/// # Arguments
/// * `waiting` - The folders added on another device and not yet confirmed on the runner, from
///   [`crate::tools::ToolContext::unconfirmed`]; where there are none, what is missing is the
///   machine hand itself.
/// * `runner` - The name of the device the turn ran on; see [`crate::tools::device_label`].
fn wanting_told(name: &str, waiting: &[String], runner: &str) -> String {
	match waiting.first() {
		Some(f)	=> fmt!("This needs a command run on {} ({}), and `{}` was added on another \
			device and is not yet confirmed on {}, so nothing can run in it there. Will you \
			confirm it on {}, with one press on the notice above the message box there, and \
			then ask me again?", runner, name, f, runner, runner),
		None	=> fmt!("This needs a command run on {} ({}), and no folder there is open to \
			commands: Daimond's machine hand is not running on {}, or no folder is granted to \
			it. Will you start the hand there and grant the folder, and then ask me again?",
			runner, name, runner),
	}
}

/// The arguments of the Decision the app offers when a turn is blocked.
///
/// It only asks: the reason is the turn's text, drawn just above it.  `app` marks it as the
/// app's own, so the page draws it in the user's language (r543 QA F-A2-3).
pub(crate) fn blocked_ask_args() -> String {
	fmt!(r#"{{"app":"blocked","question":"I could not get past this. How should I go on?","options":[{{"label":"Try another way","means":"I change approach rather than repeat what failed, for example a smaller step or a different tool."}},{{"label":"Stop here","means":"I leave things as they are and report what was done and what is left."}}],"recommend":"Try another way","why":"Sending the same thing again would fail the same way and cost another round.","if_silent":"I leave things as they are."}}"#)
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
         via sh -c) or web_fetch it with 'to' set to a path, and name the path. Chunking data \
         through yourself is never the answer.",
        max_tokens)
}

/// How many different calls a reply cut at its output limit may have run.
///
/// Measured on 2026-10-12 over the lens archive: of 1,042 rounds seen one by one, the largest
/// batch was 9 calls (six `spawn_agent` and three `run`), and 97% carried five or fewer.  Lens
/// turn `mv42uu3m` was cut carrying 390 calls.  Sixteen is the largest honest batch with room to
/// spare, so a reply past it is a model looping in its own output, not a plan.  Applied only to a
/// cut reply: a whole one ended where the model meant it to.
pub const TRUNCATED_CALL_CAP: usize = 16;

/// What a round does with each of the calls one reply carried.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Settled {
	Run,		// dispatched as usual
	Same(usize),	// identical to the earlier call at this index, whose reply answers it
	Unrun,		// past `TRUNCATED_CALL_CAP` on a cut reply
}

/// What a tool call the person stopped while it ran is answered with.  It may have partly run,
/// and the model is told so rather than left to assume it did nothing.
const STOPPED_CALL: &str = "Stopped: the person stopped the turn while this call was running. \
    It may have partly run; check before relying on its effect.";

/// What a stopped COMMAND is answered with: its process was told to stop (QA r578d D1).  The
/// hand's `run` sends it `term` as the call is dropped (`wasm::hand::run`), and a native command
/// is killed with its future (`executor`), so the model is told the command is no longer running
/// rather than left to wait on it or start it again beside itself.
const STOPPED_COMMAND: &str = "Stopped: the person stopped the turn while this command was \
    running, and the command was told to stop. It may have partly run; check before relying on \
    its effect.";

/// The answer a call stopped while it ran is given, by the tool it called.
fn stopped_call(name: &str) -> &'static str {
    match name {
        "run" | "verify" | "serve" | "shell"	=> STOPPED_COMMAND,
        _					=> STOPPED_CALL,
    }
}

/// Settle a reply's calls before any of them runs.
///
/// Lens turn `mv42uu3m-9m-0hlao` (2026-10-12): one reply, cut at its output limit, carried 390
/// identical reads of one 4 kB file.  Every one ran, and the 1.6 MB of replies they made is what
/// the turn then folded over and over.  A call identical to an earlier one in the same reply --
/// the name and the arguments, verbatim -- is answered by a pointer to it.  On a cut reply, the
/// different calls past [`TRUNCATED_CALL_CAP`] are not run either.
pub fn settle_calls(calls: &[crate::protocol::ToolCall], truncated: bool) -> Vec<Settled> {
	let mut first: std::collections::HashMap<(&str, &str), usize> =
		std::collections::HashMap::new();
	let mut out = Vec::with_capacity(calls.len());
	for (i, tc) in calls.iter().enumerate() {
		let key = (tc.name.as_str(), tc.arguments.as_str());
		if let Some(j) = first.get(&key) {
			out.push(Settled::Same(*j));
			continue;
		}
		let distinct = first.len();
		first.insert(key, i);
		out.push(if truncated && distinct >= TRUNCATED_CALL_CAP {
			Settled::Unrun
		} else {
			Settled::Run
		});
	}
	out
}

/// The reply to a call identical to an earlier one in the same reply, kept under 200 B, which
/// opens as the earlier call's did so the outcome reads the same.
fn same_call_reply(id: &str, outcome: crate::tools::CallOutcome) -> String {
	let said = fmt!("same call as {}, with the same arguments, so it was not run again; that \
		call's reply answers this one.", id);
	match outcome {
		crate::tools::CallOutcome::Done		=> fmt!("The {}", said),
		crate::tools::CallOutcome::Refused	=> crate::tools::refusal_line(&fmt!("the {}", said)),
		crate::tools::CallOutcome::Failed	=> crate::tools::error_line(&fmt!("the {}", said)),
	}
}

/// The reply to a call past [`TRUNCATED_CALL_CAP`] on a reply cut at its output limit.
fn unrun_call_note(max_tokens: u32) -> String {
	crate::tools::error_line(&fmt!("not run. Your reply was cut off at the output limit of {} \
		tokens carrying more than {} different tool calls, so this call and those after it were \
		not run. Nothing was changed. Send them again, a few per reply.",
		max_tokens, TRUNCATED_CALL_CAP))
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

/// The system prompt with its tools sentence `was` replaced by `now`.
///
/// The sentence is a paragraph of its own between the role prompt and the `brief`, so one that
/// goes is taken out with the blank line in front of it, and one that arrives goes in front of
/// the brief.
fn retell_tools(sys: &str, was: &str, now: &str, brief: &str) -> String {
    match (was.is_empty(), now.is_empty()) {
        (false, false) => sys.replacen(was, now, 1),
        (false, true)  => sys.replacen(&fmt!("\n\n{}", was), "", 1),
        (true, false)  => {
            let tail = fmt!("\n\n{}", brief);
            match !brief.is_empty() && sys.ends_with(&tail) {
                true  => fmt!("{}\n\n{}{}", &sys[..sys.len() - tail.len()], now, tail),
                false => fmt!("{}\n\n{}", sys, now),
            }
        }
        (true, true)   => sys.to_string(),
    }
}

/// The name of a test tool whose call never returns (`Agent::one_call`).
#[cfg(test)]
const HANGS: &str = "test_hangs";

#[cfg(test)]
#[path = "../tests/unit/agent/tests.rs"]
mod tests;

/// ALERT-PENDING (D-20261016-17): a turn that reported on the Pending panel may end with no
/// chat text, so a triggered Email turn posts nothing in its chat and leaves no card there.
#[cfg(test)]
#[path = "../tests/unit/agent/tests_alerted.rs"]
mod tests_alerted;
