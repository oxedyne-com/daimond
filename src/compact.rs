//! Folding a conversation that has outgrown the model's context window.
//!
//! A working session grows without limit: every round re-sends the whole history, and a
//! coding session's history is mostly tool results -- a 60 KB file read is 60 KB in every
//! request from then until the chat is deleted.  Left alone it ends one way.  The provider
//! refuses the request for being longer than the window, the turn dies, and the NEXT turn
//! sends the same oversized history and dies the same way.  The chat is then permanently
//! unusable, with no recovery but folding it into a Diamond or throwing it away.
//!
//! ## What a fold is
//!
//! Everything before a cut is replaced by ONE message; everything after it is kept exactly
//! as it was.  The replacement carries two things, produced two different ways:
//!
//! * **A ledger**, read from the tool calls themselves by [`ledger_of`].  Which files were
//!   read, which were written, which commands ran, and -- separately -- which of those were
//!   REFUSED or FAILED.  This is arithmetic, not judgement: no model is asked, so none can
//!   lose it or invent it.  A fold that drops which files were written leaves the model
//!   claiming work it can no longer verify, which is worse than the overflow it was avoiding
//!   -- and a fold that lists a REFUSED write as a write is that same claim, made by the app
//!   itself, in the one part of the note the model is told to trust.
//! * **A summary**, written by a model from a bounded rendering of the folded part (see
//!   [`render_for_fold`]).  Goal, decisions, findings, open threads -- the part that needs
//!   judgement.
//!
//! The split is what makes failure survivable.  When the summarising call fails -- refused
//! key, no network, the user pressed Stop -- the ledger alone still folds the conversation,
//! truthfully, and the turn goes on.  Falling back to "send the oversized history" would
//! reproduce the exact bug this module exists to remove.
//!
//! ## The rule that breaks a compactor
//!
//! An assistant message bearing `tool_calls` MUST be followed by one tool reply per call.
//! A cut that lands between them produces a conversation the provider rejects outright --
//! and it rejects it on every subsequent turn, which is the very failure being fixed, now
//! caused by the fix.  So the cut is chosen by [`tail_start`], which cannot land inside a
//! block, and [`fold`] then REFUSES to return a conversation with more orphans than it was
//! given ([`orphan_count`]).  A refused fold is not a dead end: [`elide_bulk`] shrinks the
//! same conversation without adding or removing a single message, so pairing cannot be
//! touched at all.
//!
//! ## The other fold
//!
//! [`crystal_proposal`] belongs to the reducer rather than to any of the above: it is the
//! check a proposed crystal must pass before a user is offered it to accept.  It is here
//! because it is the same rule -- a fold is refused before it is offered, never after --
//! and because the two would otherwise drift apart, which is how one of them ends up with
//! the reasoning and the other with the bug.

use crate::llm::{extract_json_number, extract_json_string, extract_json_string_array};
use crate::protocol::{ChatMessage, ImagePart, MessageContent, ToolCall};
use crate::protocol::Retired;
use crate::protocol::Origin;
use crate::tools::{CallOutcome, Tool, call_outcome};

use oxedyne_fe2o3_core::prelude::*;
use oxedyne_fe2o3_jdat::Dat;
use oxedyne_fe2o3_jdat::{FromDat, ToDat};
use oxedyne_fe2o3_jdat::bdat::DecodeLimits;
use oxedyne_fe2o3_jdat::string::dec::DecoderConfig;
use oxedyne_fe2o3_jdat::usr::{UsrKind, UsrKindCode, UsrKindId};

use std::cell::Cell;
use std::collections::BTreeMap;


// ┌───────────────────────────────────────────────────────────────┐
// │ The numbers                                                    │
// └───────────────────────────────────────────────────────────────┘

/// Tool-call rounds a single turn may take before the app stops it.
///
/// A real task -- find the wiring, read three files, make the change, build, fix two errors,
/// run the tests -- is comfortably thirty to fifty calls.  The old ceiling of 25 stopped
/// such a turn in the middle and wrote its own surrender into the conversation.  Runaway
/// cost is not what this defends against; the spend governor does that, with the user's own
/// figure and their own decision.
pub const DEFAULT_MAX_ROUNDS: usize = 150;

/// How many times a turn that reaches the round limit is allowed to carry on by itself.
///
/// **The round limit was a full stop and is now a breath.**  A turn stopped at 150 rounds left
/// the user holding a half-finished task and a Continue button, so the work carried on only as
/// fast as somebody was watching -- and the next turn re-sent the whole log anyway, which is
/// what the forced fold at the cap was written to bound.  On the owner's ruling of 2026-09-12
/// the app takes that press itself, up to three times, so a long task runs to
/// `DEFAULT_MAX_ROUNDS * (1 + MAX_CONTINUATIONS)` rounds unattended.
///
/// Three, not unlimited.  Each continuation costs another hundred and fifty rounds of a prompt
/// that was already at the context ceiling, and the thing that actually stops a runaway is the
/// spend ceiling -- see [`Limits::spend_cap_usd`], which is checked at the same seam.  The round
/// count is the backstop for a turn that is looping cheaply.
pub const MAX_CONTINUATIONS: usize = 3;

// K for UNBLOCK-27 R4: rounds with no completed write outside a scratch folder before a turn is
// told to deliver; from 2K the read class refuses.  The default for `Limits::no_progress_rounds`,
// which a Diamond may set for itself (`diamond_meta::Meta::no_progress`).
pub const NO_PROGRESS_ROUNDS: usize = 12;

/// What window to assume when nobody has said what the model's is.
///
/// The smallest window in Daimond's own price table, so assuming it is the assumption that
/// fails safe: on a bigger model the conversation is folded earlier than it needed to be,
/// which costs one summary; on a smaller one the reactive path in the agent still catches
/// the refusal.
pub const DEFAULT_WINDOW: u64 = 131_072;

// Where a conversation folds
//
// It was 0.8 until 2026-08-28, and the owner moved it down after a tester read a long chat
// as losing its history.  Two things go wrong close to the ceiling and both are silent: the
// budget is computed against a window this app only GUESSED at, so an estimate a fifth too
// generous puts the request over the real line before anything here notices; and the fold's
// own summary is paid for out of the same window, so a fold begun at 0.8 can leave the
// folded conversation still over it.  Folding earlier costs one summary sooner and buys the
// headroom both of those want.
//
// The band exists because `Limits::budget` clamped whatever it was handed anyway, and the
// figures now have to be read by the control that offers the choice: one offering 0.05 would
// be offering a conversation folded to nothing, and one offering 0.99 no fold at all until
// the provider refuses.

pub const FOLD_AT:     f64 = 0.65;	// default, overridden by the user's own figure
pub const FOLD_AT_MIN: f64 = 0.1;	// below this a fold leaves nothing standing
pub const FOLD_AT_MAX: f64 = 0.95;	// above it the provider refuses before the fold runs

/// The most context any one round will carry, whatever the model's window.
///
/// `fold_at` is a FRACTION of the window, so a model with a very large window folds only
/// near a very large figure: at 0.65 a 1,310,720-token window does not fold until ~852k,
/// which on a long agentic turn means every round re-sends a context grown to half a million
/// tokens -- billed in full even though almost all of it is cached, and that carry is where a
/// big-window bill goes.  This ceiling caps the EFFECTIVE budget below the window's fraction,
/// so the same turn folds at the cap and the per-round carry stays bounded.
///
/// A lower value folds more often, and each fold busts the prefix cache once.
///
/// IT WAS 200,000 UNTIL 2026-09-12, AND 200,000 WAS ABOVE THE LINE IT WAS DRAWN TO HOLD.  A
/// GLM turn settled at a per-round prompt of about 182k -- under the cap, so no fold ever
/// fired, for a hundred and fifty rounds, each carrying the lot.  A ceiling only a runaway
/// reaches is not a ceiling.
///
/// 120,000 SINCE 2026-09-12.  It was lowered to 80,000 on 2026-09-13 off the tune loop's `cap80`
/// arm and raised back the same day: no trial's prompt had peaked above 48K, so that arm never
/// bound and its saving was repeat noise, while a real daimon turn peaks above 90K and 80,000
/// would fold it twice for no measured gain.  The owner kept 120,000 on 2026-10-20 (D-20261020-02).
/// A default-window chat (131,072 * 0.65 = ~85k) therefore folds at its own fraction, under it.
///
/// It is now the DEFAULT of [`Limits::context_cap`] rather than the figure itself, because the
/// owner has to be able to see it and move it: a number that decides what a turn costs, and
/// that nothing in the product names, is a number nobody can act on.
pub const ABSOLUTE_CAP: u64 = 120_000;

/// The band a chosen context ceiling is held inside.
///
/// Below the floor the cap would be under what a fold's own tail keeps, so every turn would
/// fold and none would get anywhere; above the ceiling it is not a cap at all, since no
/// published window's fraction reaches it.
pub const CONTEXT_CAP_MIN: u64 =     16_000;
pub const CONTEXT_CAP_MAX: u64 = 1_000_000;

/// What one turn may spend before the app stops it, in US dollars.
///
/// **This, and not the round count, is what actually holds a runaway.**  A turn now takes its own
/// Continue at the round limit -- see [`MAX_CONTINUATIONS`] -- so the rounds alone no longer bound
/// what a turn costs, and the figure that does has to be one the user sets: five dollars is a
/// great deal of work on a cheap model and two long legs on an expensive one, and only the person
/// paying knows which of those they meant.
///
/// Five is the shipped default on the owner's ruling of 2026-09-12.  It is deliberately well above
/// an ordinary turn and well below a night's accident.
pub const DEFAULT_SPEND_CAP_USD: f64 = 5.0;

/// The band a chosen per-turn spend ceiling is held inside.
///
/// The floor is a cent rather than zero, because zero is how "the user has not chosen" travels
/// everywhere else in [`Limits`] and a ceiling of nothing would end every turn at its first round.
/// The roof is where a ceiling stops being one.
pub const SPEND_CAP_MIN_USD: f64 =    0.01;
pub const SPEND_CAP_MAX_USD: f64 = 1000.0;

// What a dispatched worker may have, whatever the chat is set to
//
// A worker runs on the chat's own `Limits` -- `Workers.start` applies the user's settings to the
// worker's app exactly as it does to the chat's -- and the only mark that ever said a worker was
// different is `set_unsupervised`, which governs asking rather than spending.  So a worker
// inherited 150 rounds times four legs, a 120,000-token carry and a five-dollar ceiling: six
// hundred rounds of an agent nobody is reading, dispatched several at a time, each one of them
// allowed to cost what the user's whole turn is allowed to cost.  A live one measured on
// 2026-09-12 was 85 rounds in at 77.5K tokens a round, US$2.14 spent, with another 652 calls of
// headroom.
//
// The figures are a CEILING and not a setting: [`Limits::hold_to_worker`] lowers whatever it is
// given and never raises it, so a user who has chosen a tighter leash than these keeps theirs.
// A worker is a bounded errand by construction -- it is dispatched with one task, cannot ask a
// question, and reports back -- so the work it cannot finish inside these is work that should
// come back to the daimon rather than run on unwatched.

// Raised on 2026-09-13 from 60 rounds / 48,000 -- the `wloose` arm of the same tune loop
// scored 1.00/1.00 on the two worker tasks where the tighter preset scored 0.33/0.67, with
// re-reads after retirement the likely cause (`stubRR` 0.30 under the old preset, 0.00-0.07
// under the others measured).
//
// WORKER_MAX_ROUNDS IS A LEG, NOT A TOTAL. `hold_to_worker` carries WORKER_CONTINUATIONS
// across as well, so a worker's true ceiling is `WORKER_MAX_ROUNDS * (1 + WORKER_CONTINUATIONS)`
// -- 200 rounds over two legs at today's figures, not 100. Turn 55 (2026-09-14) read w21's
// 112 rounds against the 100 alone and called it a cap the engine had missed; it had not --
// 112 is twelve rounds into the second leg, exactly what `at_the_cap` grants once. See
// `test_a_workers_true_ceiling_is_the_leg_times_its_continuations_00` in agent.rs.
pub const WORKER_MAX_ROUNDS:    usize = 100;
pub const WORKER_CONTINUATIONS: usize = 1;	// one breath, not three
pub const WORKER_CONTEXT_CAP:   u64   = 0;	// none: a worker folds at its parent's cap
pub const WORKER_KEEP:          f64   = 0.3;
pub const WORKER_SPEND_CAP_USD: f64   = 1.0;

/// Rounds a worker may still take once the turn that dispatched it has ended.
///
/// **A worker nobody is waiting for is not owed its whole ceiling.**  On 2026-09-15 a `gather`
/// ran out of time at 120 s, the daimon answered and its turn ended, and the worker went on
/// alone for thirty minutes to the full 200 rounds (`WORKER_MAX_ROUNDS` times its one
/// continuation) at US$0.47, with nothing left in the page able to read what it found.  The
/// ceiling above is calibrated for a worker whose report a turn is holding a promise on; once
/// that promise is gone the remaining rounds buy a report that will be read, at best, at the top
/// of somebody's next turn.
///
/// Five is enough to finish the file in hand and write the answer, and far too few to start a
/// fresh line of work.  The worker is TOLD at the seam of the round it is orphaned in -- see
/// [`orphan_note`] -- so the bound is something it can work to rather than something that
/// happens to it.
pub const ORPHAN_GRACE_ROUNDS: usize = 5;

/// Seconds `gather` waits for the workers it was named before it answers with whatever has
/// finished.
///
/// Ten minutes, the same order as a long turn's round cap, and inside every bound that encloses a
/// handed-off turn: the errand deadline (15 min), the lease's ticker backstop (30 min) and the
/// runner's own fan-out drain (10 min).  A ceiling and not a target -- a gather answers the moment
/// its workers are terminal, so the wait only bites while one is genuinely still running.
pub const GATHER_TIMEOUT_S: u64 = 600;

/// Milliseconds a turn may go without its model stream saying anything before it is taken as
/// stalled: `N` of the liveness rule (U3a, UNBLOCK-16; [`crate::engine::worker::Liveness`]).
///
/// **PROGRESS, NOT A WALL CLOCK.**  This replaces the page's 540 s ceiling on a whole worker turn,
/// which stopped a worker that was working as readily as one that was not.  Only the model stream
/// beats it -- any line, keep-alives included -- and a tool call is bounded by its own ceiling
/// instead (below).  Settable per app (`Agent::set_liveness_ms`); re-set from measured gaps by
/// U3a-N.  Nothing expires on it yet: the turn races it from LV2 on.
pub const LIVENESS_MS: u64 = 120_000;

/// Milliseconds a tool call with no ceiling of its own may run before the turn drops it (U3a LV2).
///
/// Ten minutes: the longest a tool the page knows of waits without one (`gather`'s own
/// [`GATHER_TIMEOUT_S`]).  A tool with a ceiling (`run`'s timeout, `verify`'s budget) is held to
/// that plus [`TOOL_CEILING_MARGIN_MS`], and a person's wait beats its own deadline.
pub const TOOL_CEILING_DEFAULT_MS: u64 = 600_000;

/// Milliseconds past a tool's own ceiling before the turn drops it: room for the tool to end
/// itself and say why, so the backstop only meets a tool that did not.
pub const TOOL_CEILING_MARGIN_MS: u64 = 60_000;

/// Fraction of the budget kept verbatim at the end of the conversation.
///
/// The recent exchanges are the ones that must survive intact: a model that has just been
/// told the answer, or has just read the file it is editing, must not find that summarised
/// away.  Two fifths of the budget is several full rounds of tool calls at typical sizes.
pub const KEEP: f64 = 0.4;

/// Fraction of the budget a fold shrinks the conversation to, below the line that triggers it.
///
/// A fold that ends just under its own trigger is re-triggered by the next round's tool result,
/// and on 2026-10-12 that was sixteen folds in sixteen rounds, each paying a summary.  Folding to
/// three quarters leaves several rounds of headroom before the next one.
pub const FOLD_TARGET: f64 = 0.75;

/// Fraction of the budget a fold must free to be worth its summary.
///
/// A fold whose cut covers less than this, or a pass that left the conversation above
/// [`FOLD_TARGET`], is not repeated until the carry has grown by this much again.
pub const MIN_FOLD_GAIN: f64 = 0.10;

/// Messages always kept verbatim however big they are, so a fold cannot leave a turn with
/// nothing but a summary and the user's own sentence.
pub const MIN_KEEP_MESSAGES: usize = 6;

/// Tokens held back from the budget for the reply itself, on top of the model's own cap.
const RESERVE_TOKENS: u64 = 1_024;

/// The smallest budget that will ever be computed, so a mis-reported tiny window cannot
/// produce a budget nothing fits in.
const MIN_BUDGET_TOKENS: u64 = 1_000;

/// The smallest window a refusal will ever teach, so one wild size estimate cannot leave a
/// chat folding itself to nothing on every turn.
pub const MIN_LEARNED_WINDOW: u64 = 4_096;

/// The prompt size below which a bare refusal is not read as an overflow.
///
/// Two things have to be told apart with no help from the provider: a request refused for
/// being too long, and a request refused for being wrong.  Size is the only signal, and it
/// has to be an ABSOLUTE floor rather than a fraction of the budget, because the case that
/// matters most is the one where the budget is wrong -- a model with a 16k window that
/// nobody published, which the app is treating as 131k.  Judged against that budget the
/// refused prompt looks small; judged against this it plainly is not.
pub const OVERFLOW_FLOOR_TOKENS: u64 = 4_000;

/// Tokens per byte before any provider has said otherwise -- English prose and source code
/// both sit near this.
const DEFAULT_TOKENS_PER_BYTE: f64 = 0.27;

/// The band a calibrated ratio is held inside, so one odd `usage` block cannot make the
/// gauge useless.
const MIN_TOKENS_PER_BYTE: f64 = 0.15;

/// See [`MIN_TOKENS_PER_BYTE`].
const MAX_TOKENS_PER_BYTE: f64 = 0.60;

/// Bytes of rendered history handed to the summarising call.
///
/// Bounded on purpose, and it is the whole reason the fold cannot fail the way the request
/// it is fixing failed: the part being folded is by definition near the window, so a
/// summarising call carrying it whole would be refused for the same reason.  It is also
/// what makes the cost of a fold a fixed number rather than a fraction of the session.
///
/// It has been cited as the reason a crystal carrying a page would be dear to fold.  That
/// reasoning was for a design where the crystal was one markdown file with the markup
/// inside it, and it does not survive the split: presentation lives in `crystal.html`,
/// which the reducer is never shown and which never enters a system prompt, so no page
/// reaches this budget by any route.  The crystal's data half does, since it rides in the
/// standing context of every request -- which is what its own cap is for, and why that cap
/// bounds only the half a model reads.
pub const FOLD_INPUT_CAP: u64 = 48_000;

/// Bytes of a tool result kept when it is elided in place.
pub const TOOL_ELISION_CAP: usize = 400;

/// The side of the square block of pixels a vision model charges one token for.
///
/// From Anthropic's vision documentation: "Claude views images in patches instead of pixels. Each
/// patch is a 28x28-pixel block of the image, referred to as a visual token. An image, therefore,
/// costs ceil(width / 28) x ceil(height / 28) visual tokens."  OpenAI tiles differently -- 85
/// tokens plus 170 per 512-pixel tile after fitting the image inside 2048x2048 with a 768-pixel
/// short edge -- and comes out LOWER on every size worth sending, so the one formula here is the
/// dearer of the two and therefore the safe one to budget against.
pub const IMAGE_PATCH_PX: u64 = 28;

/// The most visual tokens one image can cost, whatever its size.
///
/// The provider downscales anything bigger before it charges for it, so the patch count above is
/// bounded: 4,784 on the high-resolution tier (long edge 2,576 px), 1,568 on the standard tier
/// (long edge 1,568 px).  The higher figure is the one used, because nothing in the browser knows
/// which tier a configured model sits in, and a budget that overstates folds a turn early where
/// one that understates has the provider refuse it.
pub const IMAGE_TOKEN_CAP: u64 = 4_784;

/// Tokens per byte for an image whose pixel dimensions this build cannot read.
///
/// PNG and JPEG headers are read directly, so this covers GIF and WebP and a file whose header is
/// damaged.  Measured against this repository's own screenshots -- 1500x950 in 199,280 bytes is
/// 1,836 visual tokens (0.0092 tokens per byte) and 390x844 in 52,783 bytes is 434 (0.0082) -- and
/// then set several times higher, because the two formats it actually covers compress harder for
/// the same pixel count and because overstating is the direction to err in.  It is bounded above
/// by [`IMAGE_TOKEN_CAP`] regardless, so a large file is charged the ceiling rather than a
/// runaway figure.
const FALLBACK_IMAGE_TOKENS_PER_BYTE: f64 = 0.05;

/// Tokens the summarising call may generate.
///
/// The CONTEXT fold's, and only that one -- it is set on the client where the summarising
/// call is made in `agent.rs` and nowhere else.  Nothing caps what the crystal reducer
/// emits, which is a different fold under a different prompt, so a figure derived from this
/// one is not a statement about how large a crystal a fold can produce.  The crystal's own
/// ceiling is [`crate::tools::crystal_cap`], enforced at the write.
pub const FOLD_MAX_TOKENS: u32 = 1_400;

/// Items a ledger line names before it counts the rest.
pub const LEDGER_SHOWN: usize = 40;

/// Tokens below which a fold's room is too small to ask a summary of: the notice keeps the
/// ledger alone, and no call is paid for a note that could not say anything.
pub const FOLD_MIN_ASK: u32 = 200;

/// The share of a fold's room a summary is asked for (M1).  The gauge prices a byte at its
/// measured ratio, and English prose runs more bytes a token than code: a reply written to the
/// whole room at 4.4 bytes a token overran a room measured at 3.7 and was dropped whole.  The
/// fifth held back is that difference, with some to spare.
pub const FOLD_ASK_MARGIN: f64 = 0.8;

/// What a summary the provider cut at its length limit ends with, once it is trimmed back to
/// its last whole sentence.  See [`cut_short`].
pub const CUT_SHORT_NOTE: &str =
	"(This summary reached its length limit and was cut short there; what stands above is whole.)";

/// A summary the provider cut at `max_tokens`, trimmed back to its last whole sentence or line
/// and marked as cut short, so the model never reads a thought that stops mid-word as if it were
/// whole.  `None` where not one sentence ended before the cut.
pub fn cut_short(text: &str) -> Option<String> {
	let end = match text.rfind(|c| matches!(c, '.' | '!' | '?' | '\n')) {
		Some(i) => i,
		None    => return None,
	};
	let kept = text[..=end].trim_end();
	if kept.is_empty() {
		return None;
	}
	Some(fmt!("{}\n\n{}", kept, CUT_SHORT_NOTE))
}

/// Tokens the summarising call may generate when it is asked for the structured shape.
///
/// Seven headings with bullets under each need more room than a paragraph of prose, and running
/// out is not a smaller note: it is a note cut mid-sentence.  The layout puts `## Task` and
/// `## Next step` first precisely so that what a cut loses is `## Files read`, which the ledger
/// already carries -- but the budget is raised as well, because relying on the ordering alone
/// would be relying on a model to write the important part first every time.
pub const FOLD_MAX_TOKENS_STRUCTURED: u32 = 2_000;

/// Which shape the compactor is asked to write in.
///
/// Data rather than a constant for the reason every other figure in [`Limits`] is: an arm of a
/// measurement has to be able to be "as it was before this existed" without a rebuild.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FoldShape {
	/// The fixed heading layout of [`FoldNotes`].
	Structured,
	/// Whatever prose the compactor writes, as it was before 2026-09-13.
	Prose,
}

impl FoldShape {
	/// The wire spelling, which `set_tune` reads and `turn_limits` reports.
	pub fn wire(self) -> &'static str {
		match self {
			Self::Structured => "structured",
			Self::Prose      => "prose",
		}
	}

	/// Read a spelling; anything else is `None` rather than a silent default.
	pub fn from_wire(s: &str) -> Option<Self> {
		match s.trim() {
			"structured" => Some(Self::Structured),
			"prose"      => Some(Self::Prose),
			_            => None,
		}
	}

	/// Tokens the summarising call may generate under this shape.
	pub fn max_tokens(self) -> u32 {
		match self {
			Self::Structured => FOLD_MAX_TOKENS_STRUCTURED,
			Self::Prose      => FOLD_MAX_TOKENS,
		}
	}
}


// ┌───────────────────────────────────────────────────────────────┐
// │ Limits                                                         │
// └───────────────────────────────────────────────────────────────┘

/// What bounds a turn: how long it may run, and how big its conversation may get.
///
/// Held as data rather than as constants because both are per-model and per-user: the
/// window is whatever the provider published for the model in the chat's header, and a user
/// who wants a longer leash than 150 rounds should be able to have one without a rebuild.
#[derive(Clone, Debug)]
pub struct Limits {
	/// Tool-call rounds a single turn may take.
	pub max_rounds: usize,
	/// The model's context window in tokens; zero when nobody has said.
	pub window:     u64,
	/// Fraction of the window at which the conversation is folded.
	pub fold_at:    f64,
	/// Most tokens any one round may carry, whatever the window; see [`ABSOLUTE_CAP`].
	pub context_cap: u64,
	/// Most one turn may spend, in US dollars; see [`DEFAULT_SPEND_CAP_USD`].
	pub spend_cap_usd: f64,
	/// Times a turn at the round cap may carry itself on; see [`MAX_CONTINUATIONS`].
	pub max_continuations: usize,
	/// Fraction of the budget kept verbatim at the end.
	pub keep:       f64,
	/// Model to fold with; empty means the chat's own.
	pub fold_model: String,
	/// Which shape the compactor is asked to write its note in.
	pub fold_shape: FoldShape,
	// A worker's ceiling
	pub worker:     bool,	// held to the worker figures, which a user setting may lower only

	// ── What compaction does, as data rather than as constants ──
	//
	// Every figure below was a compile-time constant read at its call site, so the three
	// retire measures and the worker preset could not be turned off, varied, or measured
	// against each other.  They are here so that one tune -- `Agent::set_tune` -- can move
	// any of them, and so that an arm of a measurement can be "as off as the engine allows"
	// rather than a rebuild.  The DEFAULTS are today's constants exactly; nothing about a
	// tree nobody tunes changes.
	pub retire_prior: bool,		// retire a turn's predecessors on the way out; see `retire_upto`
	pub retire_keep_turns: u32,	// completed turns left whole first; see `RETIRE_KEEP_TURNS`
	pub retire_at:    f64,		// fraction of the fold budget past which results retire; see `RETIRE_AT`
	pub result_age:   usize,	// rounds a result must be old; see `IN_TURN_RESULT_AGE`
	pub result_cap:   usize,	// bytes left whole however old; see `IN_TURN_RESULT_CAP`
	pub sweep_every:  usize,	// rounds between sweeps; see `IN_TURN_RETIRE_EVERY`

	// The worker preset, which `hold_to_worker` reads
	pub worker_max_rounds:    usize,
	pub worker_continuations: usize,
	pub worker_context_cap:   u64,
	pub worker_keep:          f64,
	pub worker_spend_usd:     f64,
	pub orphan_grace_rounds:  usize,	// see `ORPHAN_GRACE_ROUNDS`

	// The no-progress rule
	pub no_progress_rounds:   usize,	// K; see `NO_PROGRESS_ROUNDS` and `crate::turn_state`

	// How long an in-turn gather waits
	pub gather_timeout_s: u64,	// seconds; see `GATHER_TIMEOUT_S`

	/// Say, once per turn, that independent calls belong in one reply.  On by default; the
	/// `batchline_off` arm is the pair a measurement turns it off with.
	pub batch_line: bool,

	// Which measures still under trial are on
	//
	// Not a figure and not a ceiling: a switch, so a bank arm can run one measure against the
	// `cur` control instead of against a build. `compound` offers `Tool::Compound`, which is
	// held on every belt and withheld from the schema array until this says otherwise -- see
	// `crate::tools::ToolRegistry::offered` and `crate::agent::Agent::run_turn`, which hands it
	// to the turn's context. Off by the shipped default, which is what makes `cur` a control.
	pub compound: bool,

	// The never-forget file set (`dev/CRYSTAL_CONTRACT.md` §5, §12-13), each switch off by
	// itself so `dev/verify_neverforget.mjs` can turn off ONE mechanism at a time and prove
	// the assertion it is about actually depends on it -- an un-switchable piece of engine
	// logic is a piece no `--break` can discriminate against. All four default on, which is
	// what shipped; see `dev/tune/arms.json`'s `nofiles` arm for `standing_files`.
	//
	/// Whether `REQUIREMENTS.md`, `DECISIONS.md` and `STATE.md` ride in the daimon's system
	/// message at all. Off is the `nofiles` measurement arm: the crystal still rides, the
	/// three files do not, and the hot room they would have taken goes to it instead.
	pub standing_files: bool,
	/// Whether the daimon's briefing names its open tasks by their own words ("top three: …")
	/// or only their count. Off leaves "N objectives, M open tasks" and drops the list.
	pub briefing_top3: bool,
	/// Whether a ticked task earns its own `kind:"task"` line in `.daimond/log`. Off leaves
	/// the version-minting `kind:"edit"` record in place -- a Diamond still gets a version for
	/// the turn -- but nothing says WHICH task moved or what backed the claim.
	pub task_log: bool,
	/// Whether a turn that changed files without updating `REQUIREMENTS.md`/`STATE.md` gets
	/// the one-line reconcile warning. Off is the world before `dev/CRYSTAL_CONTRACT.md` §5.2:
	/// the turn-end check still runs and the log still gets its `task` records, but nothing
	/// tells the daimon it left the never-forget file behind.
	pub tail_note: bool,

	// Thinking, which only the Anthropic dialect can carry
	pub thinking: crate::llm::Thinking,	// adaptive, or off where the model allows it
	pub effort:   crate::llm::Effort,	// how deeply; `output_config.effort`

	/// How long a stream may go without a byte before it is read as stalled; see
	/// `LlmClient::stream_idle_ms` and [`crate::llm::DEFAULT_STREAM_IDLE_MS`].
	pub stream_idle_ms: u64,
}

impl Default for Limits {
	fn default() -> Self {
		Self {
			max_rounds: DEFAULT_MAX_ROUNDS,
			window:     0,
			fold_at:    FOLD_AT,
			context_cap: ABSOLUTE_CAP,
			spend_cap_usd: DEFAULT_SPEND_CAP_USD,
			max_continuations: MAX_CONTINUATIONS,
			keep:       KEEP,
			fold_model: String::new(),
			fold_shape: FoldShape::Structured,
			worker:     false,
			retire_prior: true,
			retire_keep_turns: RETIRE_KEEP_TURNS,
			retire_at:    RETIRE_AT,
			result_age:   IN_TURN_RESULT_AGE,
			result_cap:   IN_TURN_RESULT_CAP,
			sweep_every:  IN_TURN_RETIRE_EVERY,
			worker_max_rounds:    WORKER_MAX_ROUNDS,
			worker_continuations: WORKER_CONTINUATIONS,
			worker_context_cap:   WORKER_CONTEXT_CAP,
			worker_keep:          WORKER_KEEP,
			worker_spend_usd:     WORKER_SPEND_CAP_USD,
			orphan_grace_rounds:  ORPHAN_GRACE_ROUNDS,
			no_progress_rounds:   NO_PROGRESS_ROUNDS,
			gather_timeout_s:     GATHER_TIMEOUT_S,
			batch_line:           true,
			compound:             false,
			standing_files:       true,
			briefing_top3:        true,
			task_log:             true,
			tail_note:            true,
			// What the client asked for before either was a setting, so a tree nobody tunes
			// sends exactly what it sent before.  The per-family figure is applied over this
			// where the model is known; see `profile::Family::thinking_default`.
			thinking:             crate::llm::Thinking::Adaptive,
			effort:               crate::llm::Effort::High,
			stream_idle_ms:       crate::llm::DEFAULT_STREAM_IDLE_MS,
		}
	}
}

impl Limits {

	/// Tokens past which old tool results are retired: [`RETIRE_AT`] of [`Limits::budget`], so the
	/// line moves with the fold point and always sits under it.
	///
	/// # Arguments
	/// * `max_completion` - The cap the client puts on generated tokens.
	pub fn retire_line(&self, max_completion: u32) -> u64 {
		(self.budget(max_completion) as f64 * self.retire_at.clamp(0.0, 1.0)) as u64
	}

	/// The largest prompt this turn should send, in tokens.
	///
	/// Ceilings, and the lowest wins.  The first is the fraction of the window a fold is
	/// meant to trigger at, itself held under [`ABSOLUTE_CAP`] so a very large window cannot
	/// let the per-round carry balloon.  The second is what is left of the window once the
	/// reply the model is allowed to generate has been subtracted -- on a small window the
	/// reply is the bigger share, and a budget that ignored it would leave the prompt legal
	/// and the call still refused.
	///
	/// # Arguments
	/// * `max_completion` - The cap the client puts on generated tokens.
	pub fn budget(&self, max_completion: u32) -> u64 {
		let w = if self.window == 0 { DEFAULT_WINDOW } else { self.window };
		// The window's fraction, but never above the absolute ceiling: on a large-window model
		// the fraction folds far too late, so the carry -- not any one message -- is what runs
		// the bill up.  See [`ABSOLUTE_CAP`].
		// The ceiling is the user's where they have set one; zero is how "they have not" travels,
		// exactly as it does for `fold_at`, so the shipped figure lives in one place.
		let cap = if self.context_cap == 0 {
			ABSOLUTE_CAP
		} else {
			self.context_cap.clamp(CONTEXT_CAP_MIN, CONTEXT_CAP_MAX)
		};
		let by_fraction = ((w as f64 * self.fold_at.clamp(FOLD_AT_MIN, FOLD_AT_MAX)) as u64)
			.min(cap);
		// Never more than half the window to the reply, however big the client's cap is.
		// A cap larger than the whole window is not a reason to leave no budget for the
		// conversation; it is a reason to ignore most of the cap.
		let reserved   = (max_completion as u64).min(w / 2) + RESERVE_TOKENS;
		let by_reserve = w.saturating_sub(reserved);
		by_fraction.min(by_reserve).max(MIN_BUDGET_TOKENS)
	}

	/// Take a provider's refusal as the fact it is: a prompt this big did not fit.
	///
	/// The one authority on the window is the provider, and this is the only occasion it
	/// speaks -- so a chat against a model nobody published a window for learns its size the
	/// hard way, once, rather than dying of it repeatedly.  The window is set BELOW the
	/// prompt that was refused, because that prompt is known not to have fitted, and never
	/// upward: a bigger figure than the one already held would undo what an earlier refusal
	/// taught.
	///
	/// Returns whether the figure moved.
	///
	/// # Arguments
	/// * `refused_tokens` - Estimated size of the prompt the provider would not take.
	pub fn learn_from_refusal(&mut self, refused_tokens: u64) -> bool {
		let held  = if self.window == 0 { DEFAULT_WINDOW } else { self.window };
		let learnt = (refused_tokens * 3 / 4).max(MIN_LEARNED_WINDOW);
		if learnt >= held {
			return false;
		}
		self.window = learnt;
		true
	}

	/// Hold these limits down to what a dispatched worker may have, and remember that they are
	/// held.
	///
	/// **Every figure is lowered and none is ever raised**, which is what makes the order of the
	/// calls in `Workers.start` not matter: the preset is applied after the user's own settings,
	/// and a user who asked for 30 rounds keeps 30 rather than being given 60.  It is re-applied
	/// after every later setter -- see [`crate::agent::Agent::set_max_rounds`] and its siblings --
	/// so a setting that arrives mid-run cannot lift a worker back over the ceiling either.
	///
	/// Idempotent, because it is called again on every setting: each field is a `min` against a
	/// figure that is already at or below the ceiling -- `context_cap` aside, which is the
	/// parent's own; see the comment at that field below.  A zero is read as
	/// "the user has not chosen" exactly as [`Limits::budget`] reads it, so the shipped default
	/// is what the ceiling is taken against rather than nought.
	pub fn hold_to_worker(&mut self) {
		self.worker = true;
		// READ OFF THESE LIMITS rather than off the constants, so a tune can move the preset --
		// see `crate::agent::Agent::set_tune`.  Zero is how "nobody has chosen" travels
		// everywhere else here, so it means the shipped figure rather than a ceiling of nothing:
		// a preset of nought rounds would end every worker before its first call.
		let rounds = if self.worker_max_rounds == 0 { WORKER_MAX_ROUNDS } else { self.worker_max_rounds };
		let wkeep  = if self.worker_keep <= 0.0 { WORKER_KEEP } else { self.worker_keep };
		let wspend = if self.worker_spend_usd <= 0.0 { WORKER_SPEND_CAP_USD } else { self.worker_spend_usd };
		self.max_rounds = self.max_rounds.min(rounds).max(1);
		// A continuation count of zero IS a choice -- one leg and no more -- so it is not read
		// as absent the way the four above are.
		self.max_continuations = self.max_continuations.min(self.worker_continuations);
		// THE CARRY IS THE PARENT'S OWN (2026-10-20, r578c): a worker starts as a copy of its
		// parent's conversation, so it folds where the parent folds -- a user cap above 120,000
		// included.  Only a tune that names a worker figure still lowers it.
		let own = if self.context_cap == 0 { ABSOLUTE_CAP } else { self.context_cap };
		let cap = if self.worker_context_cap == 0 { own } else { own.min(self.worker_context_cap) };
		self.context_cap = cap.clamp(CONTEXT_CAP_MIN, CONTEXT_CAP_MAX);
		self.keep = self.keep.min(wkeep);
		let spend = if self.spend_cap_usd <= 0.0 { DEFAULT_SPEND_CAP_USD } else { self.spend_cap_usd };
		self.spend_cap_usd = spend.min(wspend)
			.clamp(SPEND_CAP_MIN_USD, SPEND_CAP_MAX_USD);
	}

	/// How much of the budget is kept verbatim, in tokens.
	pub fn tail_budget(&self, max_completion: u32) -> u64 {
		((self.budget(max_completion) as f64) * self.keep.clamp(0.1, 0.8)) as u64
	}
}


// ┌───────────────────────────────────────────────────────────────┐
// │ Gauge                                                          │
// └───────────────────────────────────────────────────────────────┘

/// How many tokens a byte of this conversation costs, learned from the provider.
///
/// Nothing in the browser can tokenise the way a given model does, and shipping a tokeniser
/// per model is not on offer.  But the provider reports `prompt_tokens` for every call, and
/// the bytes that produced that figure are known here -- so the ratio is measured rather
/// than assumed, against the only authority that matters.  It is held inside a band so that
/// one odd `usage` block, or a provider that reports nothing, cannot leave the gauge unable
/// to see an overflow coming.
#[derive(Debug, Default)]
pub struct Gauge {
	/// Bytes of the last request whose token count came back.
	bytes:  Cell<u64>,
	/// What the provider charged for those bytes.
	tokens: Cell<u64>,
}

impl Gauge {

	/// Record what a request of `bytes` actually cost in prompt tokens.
	///
	/// A call that reported nothing is ignored rather than recorded as free.
	///
	/// # Arguments
	/// * `bytes` - Bytes of conversation and tool schema sent.
	/// * `tokens` - Prompt tokens the provider says it charged.
	pub fn observe(&self, bytes: u64, tokens: u64) {
		if bytes == 0 || tokens == 0 {
			return;
		}
		self.bytes.set(bytes);
		self.tokens.set(tokens);
	}

	/// Tokens per byte, as last measured or the default.
	pub fn ratio(&self) -> f64 {
		let b = self.bytes.get();
		if b == 0 {
			return DEFAULT_TOKENS_PER_BYTE;
		}
		(self.tokens.get() as f64 / b as f64).clamp(MIN_TOKENS_PER_BYTE, MAX_TOKENS_PER_BYTE)
	}

	/// What `bytes` will cost in tokens.
	pub fn tokens(&self, bytes: u64) -> u64 {
		(bytes as f64 * self.ratio()).ceil() as u64
	}

	/// How many bytes fit in `tokens`.
	pub fn bytes(&self, tokens: u64) -> u64 {
		(tokens as f64 / self.ratio()) as u64
	}
}


// ┌───────────────────────────────────────────────────────────────┐
// │ Measuring                                                      │
// └───────────────────────────────────────────────────────────────┘

/// What one image costs the model, in tokens.
///
/// Pixels, not bytes.  A screenshot is the clearest case: 1500x950 weighs 199,280 bytes on disk,
/// which the text ratio of 0.27 prices at 53,806 tokens; the provider charges 1,836.  Left alone,
/// that thirty-fold overstatement puts a single screenshot most of the way through a 131k budget
/// and folds the conversation on the turn it was read -- and on every turn after it, since the
/// fold cannot shrink what it is mis-measuring.  A feature that cannot survive its own first use
/// is not a feature, which is why this function exists.
///
/// See [`IMAGE_PATCH_PX`] for the formula and where it comes from, [`IMAGE_TOKEN_CAP`] for the
/// ceiling, and [`FALLBACK_IMAGE_TOKENS_PER_BYTE`] for the formats whose header this build cannot
/// read.
///
/// # Arguments
/// * `img` - The image part being measured.
pub fn image_tokens(img: &ImagePart) -> u64 {
	let raw = match img.dims() {
		Some((w, h)) => {
			let cols = (w as u64).div_ceil(IMAGE_PATCH_PX);
			let rows = (h as u64).div_ceil(IMAGE_PATCH_PX);
			cols.saturating_mul(rows)
		},
		None => (img.data.len() as f64 * FALLBACK_IMAGE_TOKENS_PER_BYTE).ceil() as u64,
	};
	raw.min(IMAGE_TOKEN_CAP).max(1)
}

/// What one image costs in the currency the rest of this module counts in: bytes.
///
/// Everything here -- the tail budget, the elision target, the fold trigger -- is measured in
/// bytes and converted to tokens once, by [`Gauge`].  An image has no honest byte count in that
/// sense, so it is given the byte count that WOULD produce its token count at the default ratio.
/// Two things follow, and both are the point: every existing byte-denominated calculation keeps
/// working untouched, and the gauge's learned ratio stays near the ratio for text, because the
/// image is no longer being fed to it as thirty times its own weight.
///
/// # Arguments
/// * `img` - The image part being measured.
pub fn image_bytes(img: &ImagePart) -> u64 {
	(image_tokens(img) as f64 / DEFAULT_TOKENS_PER_BYTE).ceil() as u64
}

/// Bytes one message costs on the wire, its role framing and any tool calls included.
///
/// Bytes rather than characters: multi-byte text overstates slightly, and overstating is
/// the direction a size estimate should err in.
///
/// An image is counted by [`image_bytes`], NOT by its own length -- see there for why the
/// difference is the whole of this feature's viability.
///
/// An assistant message is sized by its real text and its calls' raw arguments, because that is
/// what the wire carries: a fold, inline or in a stored `say`, goes out verbatim
/// (daimond_rulings.md §17).
pub fn msg_bytes(m: &ChatMessage) -> u64 {
	// The JSON around every message: the role, the two keys, the braces and the commas.
	let mut n = 32u64;
	for img in m.content().images() {
		n += image_bytes(img);
	}
	match m {
		ChatMessage::Assistant { content, tool_calls } => {
			n += content.text_len() as u64;
			for tc in tool_calls {
				n += (tc.id.len() + tc.name.len() + tc.arguments.len()) as u64 + 64;
			}
		},
		ChatMessage::Tool { tool_call_id, .. } => {
			n += m.content().text_len() as u64 + tool_call_id.len() as u64 + m.post().len() as u64;
		},
		// A note is sent joined to the words ([`crate::protocol::join_notes`]), so it is weight.
		ChatMessage::User { content, pre, .. } => {
			n += content.text_len() as u64;
			if !pre.is_empty() {
				n += pre.len() as u64 + 2;	// and the blank line between
			}
		},
		_ => n += m.content().text_len() as u64,
	}
	n
}

/// Bytes a whole conversation costs on the wire.
pub fn conversation_bytes(msgs: &[ChatMessage]) -> u64 {
	msgs.iter().map(msg_bytes).sum()
}


// ┌───────────────────────────────────────────────────────────────┐
// │ Pairing                                                        │
// └───────────────────────────────────────────────────────────────┘

/// Tool calls with no reply, plus tool replies with no call.
///
/// The number a fold is not allowed to increase.  It is counted rather than merely detected
/// because a conversation can arrive already broken -- a session read back from storage
/// loses the `tool_calls` off its assistant turns -- and a fold that refused to run on such
/// a conversation would leave it with no way out of an overflow at all.  What matters is
/// that the fold adds none of its own.
pub fn orphan_count(msgs: &[ChatMessage]) -> usize {
	let mut n = 0;
	let mut i = 0;
	while i < msgs.len() {
		match &msgs[i] {
			ChatMessage::Assistant { tool_calls, .. } if !tool_calls.is_empty() => {
				let mut k = 0;
				while k < tool_calls.len() {
					match msgs.get(i + 1 + k) {
						Some(ChatMessage::Tool { tool_call_id, .. })
							if *tool_call_id == tool_calls[k].id => k += 1,
						_ => break,
					}
				}
				n += tool_calls.len() - k;	// calls nobody answered
				i += 1 + k;
			},
			ChatMessage::Tool { .. } => { n += 1; i += 1; },	// a reply to no call
			_ => i += 1,
		}
	}
	n
}

/// Bytes the folded part must weigh before a fold at the ROUND LIMIT is attempted at all.
///
/// A notice carries its own header, its trailer, the ledger, and up to
/// [`FOLD_MAX_TOKENS_STRUCTURED`] of the model's own words.  Folding less than this cannot make
/// the conversation smaller, and `fold_if_needed` would discard the result -- after paying a
/// model for it.  So the cut is not taken below this, and the one thing it costs is that a very
/// short capped turn continues on its log, which fits.
pub const CAPPED_FOLD_MIN_BYTES: u64 = 4_000;

/// The cut a fold at the round limit takes when the ordinary one is nothing.
///
/// **[`tail_start`] returns 0 whenever the WHOLE conversation fits `keep_bytes`**, and at the
/// round limit that is the common case rather than the rare one: a turn capped at ten rounds has
/// not filled a 48,000-token tail budget, so `cut == 0`, no summary is made, and the leg that
/// continues starts from the raw log with no plan in front of it.  That was recorded as a known
/// limit and left; it is the reason a fold fired once in four hundred and twenty-two trials.
///
/// The answer is not to lower the tail budget -- that would change every fold -- but to ask a
/// different question at this one door: keep [`MIN_KEEP_MESSAGES`] verbatim and fold what is
/// behind them, because at the cap the alternative is re-sending that log on every round of the
/// next leg.  `keep_bytes` of nought is what spells "keep the minimum and no more"; `hard_bytes`
/// still wins, so a tail of six enormous messages is still cut down to what may be sent.
///
/// Zero when there is nothing worth folding -- fewer than `MIN_KEEP_MESSAGES + 1` messages, or
/// less than [`CAPPED_FOLD_MIN_BYTES`] behind the cut.
///
/// # Arguments
/// * `msgs` - The conversation, oldest first.
/// * `hard_bytes` - Bytes the tail may not exceed, whatever the minimum asks for.
pub fn capped_cut(msgs: &[ChatMessage], hard_bytes: u64) -> usize {
	let cut = tail_start(msgs, 0, MIN_KEEP_MESSAGES, hard_bytes);
	if cut == 0 {
		return 0;
	}
	let behind: u64 = msgs[..cut].iter().map(|m| msg_bytes(m)).sum();
	if behind < CAPPED_FOLD_MIN_BYTES {
		return 0;
	}
	cut
}

/// The turn's opening message, where a cut at `cut` would fold it away.
///
/// A fold may cut inside the turn in flight, because a long turn has nothing else to fold and a
/// floor at its start would leave it over the ceiling for good.  What it may not do is lose the
/// sentence the turn began with: on 2026-10-18 a fold 120 calls into a re-check turn took the ask
/// with it, the summary dropped it, and the model spent its next rounds asking itself what it had
/// been asked.  So the caller keeps this message verbatim behind the notice, counting its bytes
/// against the tail.  A fold notice is not an opening and is never pinned.
///
/// # Arguments
/// * `msgs` - The conversation, oldest first.
/// * `turn_start` - Index of the turn's opening message.
/// * `cut` - Index of the first message the fold keeps.
pub fn pinned_opening(msgs: &[ChatMessage], turn_start: usize, cut: usize)
	-> Option<&ChatMessage>
{
	if turn_start >= cut || turn_start >= msgs.len() {
		return None;
	}
	let m = &msgs[turn_start];
	match m {
		ChatMessage::User { .. } if !is_fold_notice(m) => Some(m),
		_                                              => None,
	}
}

/// Said in a fold notice that has a turn's opening message pinned behind it.
pub const TURN_CONTINUES_NOTE: &str =
	"\n\nThis turn is still running. Its opening message follows this note word for word: that \
	 is the request being worked on, and the work continues from here.";

/// Whether every tool call is answered and every tool reply was asked for.
pub fn pairing_is_whole(msgs: &[ChatMessage]) -> bool {
	orphan_count(msgs) == 0
}


// ┌───────────────────────────────────────────────────────────────┐
// │ Choosing the cut                                               │
// └───────────────────────────────────────────────────────────────┘

/// Where the verbatim tail begins: the index of the first message to keep.
///
/// Walks back from the end taking messages until `keep_bytes` is spent, then off any tool
/// reply it stopped on, because a reply may never be the first kept message: its call would
/// have been folded away and the provider would reject the whole request.  The step is back
/// to the call, keeping the WHOLE block, where that fits `hard_bytes`; where it does not and a
/// message follows the block, it is forward past the block instead, so the block is folded.
///
/// `min_keep` is a preference, not a promise, and `hard_bytes` is why.  Six messages is the
/// right number when messages are ordinary; when two of them are twenty-kilobyte replies it
/// is a tail bigger than the whole budget, and a fold that honoured it would shrink the
/// conversation by two messages and leave it just as unsendable as before.  That is not
/// hypothetical -- it is what a mock provider with a real context ceiling did to the first
/// version of this function.  So the ceiling wins, and the last message is kept whatever
/// its size, because it is the request being answered.
///
/// Zero means there is nothing to fold.
///
/// # Arguments
/// * `msgs` - The conversation, oldest first.
/// * `keep_bytes` - Bytes of tail to keep verbatim.
/// * `min_keep` - Messages to keep where they fit inside `hard_bytes`.
/// * `hard_bytes` - Bytes the tail may not exceed, whatever `min_keep` asks for.
pub fn tail_start(
	msgs:       &[ChatMessage],
	keep_bytes: u64,
	min_keep:   usize,
	hard_bytes: u64,
)
	-> usize
{
	let n = msgs.len();
	if n <= min_keep {
		return 0;
	}
	let mut i   = n;
	let mut acc = 0u64;
	while i > 0 {
		let c    = msg_bytes(&msgs[i - 1]);
		let kept = n - i;
		if kept >= 1 && acc + c > hard_bytes {
			break;
		}
		if kept >= min_keep && acc + c > keep_bytes {
			break;
		}
		acc += c;
		i -= 1;
	}
	// A tool reply cannot open the kept tail.  Step back to the assistant turn that asked for
	// it, taking the rest of its block along -- unless that drags the tail past `hard_bytes`
	// and a message follows the block, in which case the cut moves FORWARD to that message,
	// which keeps every call beside its reply just as well.  Stepping back regardless kept a
	// block bigger than the budget through every fold: on 2026-10-12 one reply's 390 reads
	// pinned sixteen folds in a row to the note in front of them.  A block still in flight,
	// with nothing after it, is kept whole and left to elision.
	if i < n && matches!(msgs[i], ChatMessage::Tool { .. }) {
		let mut back = i;
		while back > 0 && matches!(msgs[back], ChatMessage::Tool { .. }) {
			back -= 1;
		}
		let mut fwd = i;
		while fwd < n && matches!(msgs[fwd], ChatMessage::Tool { .. }) {
			fwd += 1;
		}
		let grown: u64 = msgs[back..i].iter().map(|m| msg_bytes(m)).sum();
		i = if acc + grown > hard_bytes && fwd < n { fwd } else { back };
	}
	i
}


// ┌───────────────────────────────────────────────────────────────┐
// │ The ledger                                                     │
// └───────────────────────────────────────────────────────────────┘

/// What the folded part of a conversation actually did.
///
/// Derived from the tool calls and their replies, so it is a record rather than a claim.
/// The distinction between this and the prose summary is the whole point of the module: a
/// file read twenty rounds ago is worth one line, but WHICH files were read and written is
/// worth keeping exactly, because a model that has lost it will describe work it cannot
/// check.
#[derive(Clone, Debug, Default)]
pub struct Ledger {
	/// Files and directories read or searched.
	pub read:    Vec<String>,
	/// Files created, changed, moved or deleted.
	pub wrote:   Vec<String>,
	/// Commands run.
	pub ran:     Vec<String>,
	/// Pages fetched or driven.
	pub fetched: Vec<String>,
	/// Agents dispatched, by name.
	pub spawned: Vec<String>,
	/// Calls a door refused, as `tool path`.  Kept apart from [`Ledger::failed`] because they
	/// are different news for the model: a refusal is a rule it met and can work around, an
	/// error is a tool that broke.  Told the wrong one, it retries the wrong thing.
	pub refused: Vec<String>,
	/// Calls that came back an error, as `tool path`.  Kept apart from the rest so a fold
	/// never reports an attempted write as a write.
	pub failed:  Vec<String>,
	/// Workers whose reports were read this turn, by name -- a `gather` that actually
	/// answered with something, never one that was refused for having nothing outstanding
	/// (that lands in [`Ledger::refused`], not here).  Kept apart from [`Ledger::spawned`]
	/// because starting a worker and reading its report are different turns as often as
	/// not: a task ticked on the strength of `spawned` alone is ticked on a report nobody
	/// has read yet.
	pub reported: Vec<String>,
}

impl Ledger {

	/// Whether nothing at all was recorded.
	pub fn is_empty(&self) -> bool {
		self.read.is_empty() && self.wrote.is_empty() && self.ran.is_empty()
			&& self.fetched.is_empty() && self.spawned.is_empty() && self.refused.is_empty()
			&& self.failed.is_empty() && self.reported.is_empty()
	}

	/// The ledger as lines for the fold notice, each capped so one pathological session
	/// cannot fill the window with its own history.
	pub fn lines(&self) -> Vec<String> {
		self.lines_showing(LEDGER_SHOWN)
	}

	/// The ledger as lines naming at most `per` items each, the rest counted.  A fold short of
	/// room names fewer and drops none: every kind of act stays on its line.
	pub fn lines_showing(&self, per: usize) -> Vec<String> {
		let mut out = Vec::new();
		let mut put = |label: &str, items: &Vec<String>| {
			if items.is_empty() {
				return;
			}
			let shown = items.len().min(per);
			let mut s = match shown {
				0 => fmt!("{}: {} items", label, items.len()),
				_ => fmt!("{}: {}", label, items[..shown].join(", ")),
			};
			if shown > 0 && items.len() > shown {
				s.push_str(&fmt!(" (and {} more)", items.len() - shown));
			}
			out.push(s);
		};
		put("Files read", &self.read);
		put("Files written", &self.wrote);
		put("Commands run", &self.ran);
		put("Pages fetched", &self.fetched);
		put("Agents dispatched", &self.spawned);
		put("Worker reports read", &self.reported);
		// Said in full rather than as one word: "REFUSED" alone invites the model to read a
		// closed door as a broken tool and try it again.
		put("REFUSED, so nothing was touched", &self.refused);
		put("FAILED", &self.failed);
		out
	}

	/// Add `item` to `into` unless it is already there or empty.
	fn push(into: &mut Vec<String>, item: String) {
		let t = item.trim();
		if t.is_empty() || into.iter().any(|x| x == t) {
			return;
		}
		into.push(t.to_string());
	}
}

/// Read the ledger out of a conversation's tool calls.
///
/// **What a reply MEANS is the tool layer's to say, and [`call_outcome`] is where it says it.**
/// This module used to decide for itself, with `!reply.trim_start().starts_with("Error")` -- and
/// every refusal in the build is returned as an `Ok` sentence that opens "Refused", so a write the
/// scope fence had just stopped was booked as a write.  A live run refused two writes by the chat
/// fence and the fold then told the model `Files written: alpha.txt, beta.txt`, directly above the
/// line instructing it to claim nothing that is not listed.  The ledger is the half of a fold that
/// is supposed to be arithmetic rather than judgement, and it was inventing files.
///
/// Adding "Refused" to the sniff would have been the same defect one layer along: a list of
/// openings held in this file, against wording held in another, kept in step by nobody.  So the
/// question is asked of the layer that composes the wording, and answered there.
pub fn ledger_of(msgs: &[ChatMessage]) -> Ledger {
	let mut l = Ledger::default();
	let mut i = 0;
	while i < msgs.len() {
		let calls = match &msgs[i] {
			ChatMessage::Assistant { tool_calls, .. } if !tool_calls.is_empty() => tool_calls,
			_ => { i += 1; continue; },
		};
		for (k, tc) in calls.iter().enumerate() {
			let reply = match msgs.get(i + 1 + k) {
				Some(ChatMessage::Tool { content, .. }) => content.as_text(),
				_ => std::borrow::Cow::Borrowed(""),
			};
			record(&mut l, tc, call_outcome(&reply));
		}
		i += 1 + calls.len();
	}
	l
}

/// Put one call in the right column of the ledger.
///
/// Whether it did anything is NOT decided here: [`crate::tools::call_outcome`] decides it, beside
/// the two constructors that compose every refusal and every error, and the answer arrives as
/// `outcome`.
///
/// Which column a call that DID happen belongs in is still worked out from its name.  That
/// duplicates what `Tool::write_targets` knows, and the standing note here said a visibility
/// change would let this call it instead -- it would not: `write_targets` needs a `ToolContext`,
/// which is the turn's, and a fold reads a conversation long after the turn that made it is gone.
/// The mapping below is over tool NAMES, which is the stable wire contract; a tool added without
/// a line here is listed in no column, which is a fold that says less than it could and never one
/// that says something untrue.
///
/// # Arguments
/// * `l` - The ledger being built.
/// * `tc` - The call the model made.
/// * `outcome` - What the tool layer says became of it.
fn record(l: &mut Ledger, tc: &ToolCall, outcome: CallOutcome) {
	let arg = |k: &str| extract_json_string(&tc.arguments, k).unwrap_or_default();
	let path = arg("path");
	// A call that did not happen is recorded as what it was and in no other column.  A refusal
	// and an error are held apart because they are different news: one is a rule the model met,
	// the other is a tool that broke.
	if !matches!(outcome, CallOutcome::Done) {
		let what  = if path.is_empty() { arg("url") } else { path.clone() };
		let entry = fmt!("{} {}", tc.name, what).trim().to_string();
		match outcome {
			CallOutcome::Refused	=> Ledger::push(&mut l.refused, entry),
			CallOutcome::Failed		=> Ledger::push(&mut l.failed, entry),
			CallOutcome::Done		=> {},	// answered above
		}
		return;
	}
	match tc.name.as_str() {
		"file_read"											=> Ledger::push(&mut l.read, path),
		// One line however many cold sections a turn fetched: WHICH sections were read is in
		// the crystal itself, which survives the fold, so naming them would be the ledger
		// repeating what the next round can simply look at.
		"crystal_read"										=> Ledger::push(&mut l.read,
			fmt!("crystal")),
		"file_list" | "file_search"							=> Ledger::push(&mut l.read,
			if path.is_empty() { fmt!(".") } else { path }),
		// `file_revert` writes a path exactly as the three above it do -- it puts an earlier
		// copy back -- so a fold that left it out would tell the model a file it can see
		// changed was not written this turn.
		"file_write" | "file_edit" | "file_delete" | "file_revert"
		| "dir_create" | "file_fetch" | "artefact_add"		=> Ledger::push(&mut l.wrote, path),
		"typst_compile"										=> Ledger::push(&mut l.wrote, path),
		"file_move"											=> Ledger::push(&mut l.wrote,
			fmt!("{} -> {}", path, arg("to"))),
		"shell"												=> Ledger::push(&mut l.ran, arg("command")),
		"run" => {
			let argv = extract_json_string_array(&tc.arguments, "argv").unwrap_or_default();
			Ledger::push(&mut l.ran, argv.join(" "));
		},
		"web_fetch" | "web_open" | "web_read"				=> Ledger::push(&mut l.fetched, arg("url")),
		"spawn_agent"										=> Ledger::push(&mut l.spawned, arg("name")),
		// `CallOutcome::Done` here means `gather` actually answered with a report -- the
		// "nothing outstanding" case opens with `REFUSAL_OPENING` and is caught above, in
		// `l.refused`, before this match is ever reached.
		"gather" => {
			let names = extract_json_string_array(&tc.arguments, "names").unwrap_or_default();
			if names.is_empty() {
				Ledger::push(&mut l.reported, fmt!("gather"));
			} else {
				for n in names {
					Ledger::push(&mut l.reported, n);
				}
			}
		},
		_ => {},
	}
}


// ┌───────────────────────────────────────────────────────────────┐
// │ Rendering what is being folded                                 │
// └───────────────────────────────────────────────────────────────┘

/// One message as a line of transcript for the summarising call.
fn render_one(m: &ChatMessage) -> String {
	match m {
		ChatMessage::System { content }   => fmt!("[system] {}", clip(&content.as_text(), 600)),
		ChatMessage::User { content, .. } => fmt!("user: {}", clip(&content.as_text(), 2_000)),
		ChatMessage::Assistant { content, tool_calls } => {
			let mut s = fmt!("assistant: {}", clip(&content.as_text(), 2_000));
			for tc in tool_calls {
				s.push_str(&fmt!("\n  calls {}({})", tc.name, clip(&tc.arguments, 240)));
			}
			s
		},
		ChatMessage::Tool { content, .. } =>
			fmt!("  result ({} bytes): {}", content.text_len(), clip(&content.as_text(), 300)),
	}
}

/// `s` cut to `n` bytes on a character boundary, with a marker when anything went.
fn clip(s: &str, n: usize) -> String {
	if s.len() <= n {
		return s.to_string();
	}
	let mut end = n;
	while end > 0 && !s.is_char_boundary(end) {
		end -= 1;
	}
	fmt!("{}… (+{} bytes)", &s[..end], s.len() - end)
}

/// The part being folded, rendered for the model that will summarise it, never larger than
/// `cap` bytes.
///
/// The cap is the point.  What is being folded is by definition most of a context window,
/// so handing it over whole would fail exactly as the request that triggered the fold
/// failed.  When it does not fit, the OPENING quarter is kept and the rest of the budget
/// goes to the most recent part: the opening is where the user said what they wanted, which
/// nothing later restates, and the recent part is where the work actually is.  What is
/// dropped is the middle, and the notice says how much.
///
/// # Arguments
/// * `msgs` - The messages being folded, oldest first.
/// * `cap` - Bytes the rendering may occupy.
pub fn render_for_fold(msgs: &[ChatMessage], cap: u64) -> String {
	let lines: Vec<String> = msgs.iter().map(render_one).collect();
	let total: u64 = lines.iter().map(|l| l.len() as u64 + 1).sum();
	if total <= cap {
		return lines.join("\n");
	}
	let head_cap = cap / 4;
	let mut used = 0u64;
	let mut i    = 0;
	while i < lines.len() {
		let c = lines[i].len() as u64 + 1;
		if used + c > head_cap {
			break;
		}
		used += c;
		i += 1;
	}
	let mut j     = lines.len();
	let mut tused = 0u64;
	while j > i {
		let c = lines[j - 1].len() as u64 + 1;
		if used + tused + c > cap {
			break;
		}
		tused += c;
		j -= 1;
	}
	let mut out: Vec<String> = lines[..i].to_vec();
	if j > i {
		out.push(fmt!("[{} messages in the middle were too long to include here]", j - i));
	}
	out.extend_from_slice(&lines[j..]);
	out.join("\n")
}


// ┌───────────────────────────────────────────────────────────────┐
// │ The notice                                                     │
// └───────────────────────────────────────────────────────────────┘

/// What a structured fold carries: one slot per heading, any of which may be empty.
///
/// **Not JSON, and the reason is compliance rather than taste.**  Measured over six open-weight
/// models, `badArgs` -- arguments that are not JSON at all -- was 0.00 for every one of them,
/// while `toolFail` on a tool with a nested argument SHAPE ran 33%, 44% and 100% on three of
/// them.  A model asked for one object by a tool schema produces one; a model asked for a
/// 1,400-token free-form document with nested arrays produces something that truncates at the
/// output cap, and a truncated JSON document loses the whole note.  A truncated heading document
/// keeps every heading that arrived.
///
/// The fold notice is already markdown, and the model reads its own markdown back better than it
/// reads JSON in prose.
#[derive(Clone, Debug, Default, PartialEq, ToDat, FromDat)]
pub struct FoldNotes {
	pub task:      String,
	pub next:      String,
	pub open:      Vec<String>,
	pub decisions: Vec<String>,
	pub found:     Vec<String>,
	pub edited:    Vec<String>,	// "path -- what", reconciled against the ledger
	pub read:      Vec<String>,	// "path -- region"
}

/// The headings the compactor is told to write, in the order it is told to write them.
///
/// The ORDER is load-bearing: a reply cut at the output cap loses the last heading first, so the
/// two that a continuation cannot do without come first and the one the ledger already carries
/// comes last.
pub const FOLD_HEADINGS: [&str; 7] =
	["Task", "Next step", "Open", "Decisions", "Found", "Files edited", "Files read"];

/// Which slot a heading names, however the model spelled it.
///
/// Case is folded, a trailing `s` is tolerated on either side, and the two headings a model
/// habitually lengthens -- "Open questions", "Next steps" -- are matched on their opening word.
/// Anything else is not a heading this layout names.
fn fold_slot(head: &str) -> Option<usize> {
	let h = head.trim().trim_end_matches(':').trim().to_lowercase();
	let h = h.trim_start_matches("##").trim_start_matches('#').trim();
	let h = h.trim_matches('*').trim();
	for (i, want) in FOLD_HEADINGS.iter().enumerate() {
		let w = want.to_lowercase();
		if h == w || h == fmt!("{}s", w) || fmt!("{}s", h) == w {
			return Some(i);
		}
	}
	// The lengthened spellings, matched on the opening word so "Open questions" and "Open
	// threads" are one heading rather than two more entries in a list nobody can finish.
	if h.starts_with("open ")  { return Some(2); }
	if h.starts_with("next ")  { return Some(1); }
	if h.starts_with("decision") { return Some(3); }
	if h.starts_with("found") || h.starts_with("learned") { return Some(4); }
	if h.starts_with("files edited") || h.starts_with("edited") || h.starts_with("files changed") {
		return Some(5);
	}
	if h.starts_with("files read") || h.starts_with("read") { return Some(6); }
	None
}

/// Whether a line is a heading of any spelling this parse accepts, and which slot it names.
///
/// `## `, `### `, and a bold line (`**Task**`) are all accepted, because all three are what a
/// model writes when it is told "under the headings you are given" and left to choose markup.
fn fold_heading(line: &str) -> Option<usize> {
	let t = line.trim();
	if t.starts_with('#') {
		return fold_slot(t);
	}
	if t.starts_with("**") && t.ends_with("**") && t.len() > 4 {
		return fold_slot(t);
	}
	None
}

/// One bullet, stripped of whatever marker it arrived with; `None` for a line that is not one.
fn fold_bullet(line: &str) -> Option<String> {
	let t = line.trim();
	if t.is_empty() {
		return None;
	}
	for m in ["- ", "* ", "+ "] {
		if let Some(rest) = t.strip_prefix(m) {
			return Some(rest.trim().to_string());
		}
	}
	// A numbered list, which several models write whatever the layout asks for.
	let digits: String = t.chars().take_while(|c| c.is_ascii_digit()).collect();
	if !digits.is_empty() {
		let rest = &t[digits.len()..];
		for m in [". ", ") "] {
			if let Some(r) = rest.strip_prefix(m) {
				return Some(r.trim().to_string());
			}
		}
	}
	Some(t.to_string())
}

/// Parse the compactor's reply into the slots the layout names.
///
/// `None` when the reply is not this shape at all -- no heading the layout names appears in it --
/// so the caller can fall back to prose and lose nothing but the structure.  **A reply that is
/// half the shape is kept**, which is the whole reason the shape is headings: each heading
/// validates on its own, so a note cut at the output cap keeps every heading that arrived
/// instead of being thrown away entire.
///
/// Text under a heading the layout does NOT name goes to `found` rather than being dropped: a
/// model that invented "## Context" has written something, and the slot for "what was learned" is
/// the one place it can go without being claimed as an edit or a decision.
///
/// # Arguments
/// * `raw` - The compactor's reply, fences and all.
pub fn parse_fold_notes(raw: &str) -> Option<FoldNotes> {
	let text = unfence(raw);
	let mut n = FoldNotes::default();
	let mut slot: Option<usize> = None;
	let mut seen = false;
	let mut task_lines: Vec<String> = Vec::new();
	let mut next_lines: Vec<String> = Vec::new();
	for line in text.lines() {
		if let Some(i) = fold_heading(line) {
			slot = Some(i);
			seen = true;
			continue;
		}
		// A heading the layout does not name still ENDS the slot before it, or its text would be
		// filed under somebody else's heading -- which is the one failure worse than losing it.
		if line.trim_start().starts_with('#') {
			slot = Some(4);
			continue;
		}
		let at = match slot {
			Some(i) => i,
			None    => continue,	// anything before the first heading is preamble
		};
		match at {
			0 => { if !line.trim().is_empty() { task_lines.push(line.trim().to_string()); } },
			1 => { if !line.trim().is_empty() { next_lines.push(line.trim().to_string()); } },
			_ => {
				if let Some(b) = fold_bullet(line) {
					match at {
						2 => n.open.push(b),
						3 => n.decisions.push(b),
						4 => n.found.push(b),
						5 => n.edited.push(b),
						6 => n.read.push(b),
						_ => {},
					}
				}
			},
		}
	}
	if !seen {
		return None;
	}
	n.task = task_lines.join(" ");
	n.next = next_lines.join(" ");
	Some(n)
}

/// Keep only the edits the ledger confirms, and move the rest where they cannot be read as work.
///
/// **The one rule this module already enforces, applied to the new slot.**  The ledger is
/// arithmetic and the prose is judgement, and the whole design is that the prose must never
/// contradict the record: a fold that lists a refused write as a write is the app itself making
/// the claim, in the part of the note the model is told to trust.  A path the model names that
/// `ledger.wrote` does not have therefore stops being an edit and becomes an open thread saying
/// so, which is the honest thing to carry forward -- the model may have MEANT to make it.
///
/// Matched on the path, which is the first token of the line before the ` -- ` the layout asks
/// for; a ledger entry that spells the same path differently is not reconciled, which errs
/// towards demoting an edit rather than confirming one.
///
/// # Arguments
/// * `notes` - What the model wrote.
/// * `ledger` - What the transcript shows.
pub fn reconcile(mut notes: FoldNotes, ledger: &Ledger) -> FoldNotes {
	let head = |line: &str| -> String {
		line.split_whitespace().next().unwrap_or("").trim_matches('`').to_string()
	};
	let confirmed = |line: &str, against: &[String]| -> bool {
		let p = head(line);
		!p.is_empty() && against.iter().any(|w| head(w) == p || w.contains(&p))
	};
	let (kept, claimed): (Vec<String>, Vec<String>) = notes.edited.into_iter()
		.partition(|l| confirmed(l, &ledger.wrote));
	notes.edited = kept;
	for l in claimed {
		notes.open.push(fmt!("claimed edit not in the record: {}", l));
	}
	// Reads are not reconciled the same way: a read is not a claim about the world, and a model
	// that names the region it read is saying something the ledger's bare path cannot.
	notes
}

/// What the summarising call produced, which is three different things and not two.
///
/// It was a string and an `Option<&str>` reason, which could not tell "the model answered in the
/// shape" from "the model answered in prose" -- and the notice has to render those differently
/// or the structure is thrown away between parsing it and writing it down.
pub enum Summary<'a> {
	/// The compactor wrote the layout, and it has been reconciled against the ledger.
	Notes(FoldNotes),
	/// The same, after [`crate::tools::absorb_notes`] filed it into the Diamond's three files.
	///
	/// A VARIANT AND NOT A FLAG, because every caller that hands this in has already decided
	/// which of the two it is, and the twenty tests that build a notice from prose or from
	/// unfiled notes should not have to say so.  What it carries is what a ceiling REFUSED --
	/// ordinarily nothing -- since the rest is in `REQUIREMENTS.md`, `DECISIONS.md` and
	/// `STATE.md`, which ride in the prompt on every round.  See `dev/CRYSTAL_CONTRACT.md` §13.
	Filed(FoldNotes),
	/// It wrote something else, which is kept exactly as it came.
	Prose(&'a str),
	/// The call could not be made, and this is why.
	None(&'a str),
}

/// The one message a fold leaves in place of everything it folded.
///
/// A user message, and deliberately not an assistant one: a summary in the assistant's own
/// voice is the model reading invented memories as things it said, and the round-limit note
/// this codebase used to write proved how badly that reads.  Not a system message either,
/// for a duller reason that decides it -- the browser rehydrates a reloaded chat from
/// `user` and `assistant` messages only, so a system-role fold would silently vanish on
/// reload and the conversation would spring back to full size.
///
/// **One function for all three outcomes**, because the three used to be a string and an
/// `Option`, and a caller that had parsed the layout had no way to say so: the structure would
/// have been thrown away between the parse and the note.
///
/// # Arguments
/// * `folded` - How many messages went.
/// * `summary` - What the summarising call produced, in whichever of the three forms.
/// * `ledger` - What the folded part did.
/// * `capped` - Whether the turn is CONTINUING from this note, which changes what `Next step` is.
pub fn notice(folded: usize, summary: &Summary<'_>, ledger: &Ledger, capped: bool) -> String {
	notice_showing(folded, "", summary, ledger, capped, LEDGER_SHOWN)
}

/// [`notice`] carrying `words`, his messages from the folded part, ahead of the summary: they
/// come first and the summary gives way to them.  See [`person_words`].
pub fn notice_saying(folded: usize, words: &[String], summary: &Summary<'_>, ledger: &Ledger,
	capped: bool)
	-> String
{
	notice_showing(folded, &words_section(words), summary, ledger, capped, LEDGER_SHOWN)
}

/// [`notice_saying`] carrying a words section already made (see [`said_section`]).
pub fn notice_with(folded: usize, words: &str, summary: &Summary<'_>, ledger: &Ledger,
	capped: bool)
	-> String
{
	notice_showing(folded, words, summary, ledger, capped, LEDGER_SHOWN)
}

/// [`notice_with`] with the ledger naming at most `per` items a line.
fn notice_showing(folded: usize, words: &str, summary: &Summary<'_>, ledger: &Ledger,
	capped: bool, per: usize)
	-> String
{
	let mut s = fmt!(
		"[Daimond folded the earlier part of this conversation to keep it inside the model's \
		 context window. {} messages were replaced by this note; everything after it is \
		 exactly as it was. This note is the only record of them that the model now has.]\n",
		folded);
	s.push_str(words);
	match summary {
		Summary::Notes(n) => s.push_str(&structured_body(n, capped, false)),
		Summary::Filed(n) => s.push_str(&structured_body(n, capped, true)),
		Summary::Prose(p) if !p.trim().is_empty() => {
			s.push_str("\n## What happened\n\n");
			s.push_str(p.trim());
			s.push('\n');
		},
		Summary::Prose(_) => {},
		Summary::None(reason) => s.push_str(&fmt!(
			"\n## What happened\n\nNo summary could be written ({}), so what follows is the \
			 record of the tool calls themselves and nothing more. Ask before assuming \
			 anything not listed here was done.\n", reason)),
	}
	let lines = ledger.lines_showing(per);
	if !lines.is_empty() {
		s.push_str("\n## What was touched\n\n");
		for l in lines {
			s.push_str(&fmt!("- {}\n", l));
		}
	}
	s.push_str(
		"\nFile contents from before this note are gone; read a file again rather than \
		 recalling it. Do not claim to have done anything that is not listed above.");
	s
}

/// The structured half of a notice: one heading per slot that carries anything.
///
/// An empty slot is left out rather than written as a heading with nothing under it -- a heading
/// over silence reads as "there were no decisions", which is a claim, and the model was not asked
/// one.  `## What was touched` follows from the LEDGER and stays app-built, so nothing here can
/// put a refused write in it.
///
/// # Arguments
/// * `n` - The parsed and reconciled slots.
/// * `capped` - Whether the turn continues from this note, which is what makes `Next step` a plan
///   the next round starts on rather than a note about the future.
/// * `filed` - Whether the notes are now in the Diamond's three files, which is what lets this
///   note SHRINK to the task, the next step and a sentence saying where the rest went.  Carrying
///   the lists here as well would be the duplication `open[]` was deleted for, and the two file
///   lists would say what `## What was touched` says with less authority.
fn structured_body(n: &FoldNotes, capped: bool, filed: bool) -> String {
	let mut s = String::new();
	if !n.task.trim().is_empty() {
		s.push_str(&fmt!("\n## Task\n\n{}\n", n.task.trim()));
	}
	if !n.next.trim().is_empty() {
		s.push_str("\n## Next step\n\n");
		if capped {
			s.push_str("The turn continues from here: ");
		}
		s.push_str(n.next.trim());
		s.push('\n');
	}
	let list = |s: &mut String, head: &str, items: &[String]| {
		if items.is_empty() {
			return;
		}
		s.push_str(&fmt!("\n## {}\n\n", head));
		for i in items {
			s.push_str(&fmt!("- {}\n", i));
		}
	};
	if filed {
		s.push_str(
			"\nDecisions and open items were filed into DECISIONS.md and REQUIREMENTS.md, and \
			 what was found into STATE.md; all three are in front of you on every round.\n");
		// A ceiling refused these, so they are in no file and this note is the only place they
		// exist. Said as such, or a reader of the sentence above would go looking for them.
		if !n.open.is_empty() || !n.decisions.is_empty() || !n.found.is_empty() {
			s.push_str("\nThese would not fit their files' ceilings and are here instead.\n");
		}
	}
	list(&mut s, "Open",        &n.open);
	list(&mut s, "Decisions",   &n.decisions);
	list(&mut s, "Found",       &n.found);
	if !filed {
		list(&mut s, "Files edited", &n.edited);
		list(&mut s, "Files read",  &n.read);
	}
	s
}


/// Bytes a fold notice may take and still let the fold land under `target`.
///
/// What the fold keeps is measured at its floor, as the first elision pass can leave it: the
/// newest [`MIN_KEEP_MESSAGES`] whole, everything older shrunk.  The user's words are never
/// shrunk, so the pinned opening counts in full -- that is the room reserved for them.  His words
/// from the folded part ride inside the notice (`## Your words`), so they come out of this room,
/// ahead of the summary, through the notice's own frame.
///
/// # Arguments
/// * `kept` - The messages after the cut, as the fold keeps them.
/// * `pin` - The turn's opening, set back verbatim behind the notice, if any.
/// * `target` - The bytes the sent conversation must land under.
pub fn notice_room(kept: &[ChatMessage], pin: Option<&ChatMessage>, target: u64) -> u64 {
	let mut floor = kept.to_vec();
	elide_bulk(&mut floor, 0, MIN_KEEP_MESSAGES);
	let pinned = pin.map(msg_bytes).unwrap_or(0);
	target.saturating_sub(conversation_bytes(&floor) + pinned)
}

/// The notice a fold writes, made to fit `room` bytes as a message.
///
/// One defined path and no second model call (R3): the notice as [`notice_saying`] writes it;
/// failing that, the summary is dropped whole and the notice says why, since a summary cut short
/// is a thought cut mid-way; failing that, the ledger names fewer items a line, down to counts.
/// His words are never given up (R1): where they alone exceed the room the notice still carries
/// them and the fold lands over target, since a fold that loses what he said is worse than one
/// that lands high.  Returns the text and whether the summary rode in it.
///
/// # Arguments
/// * `words` - The section carrying his words; see [`said_section`].
/// * `tail` - Appended after the body, such as [`TURN_CONTINUES_NOTE`]; counted in the fit.
pub fn notice_within(folded: usize, words: &str, summary: &Summary<'_>, ledger: &Ledger,
	capped: bool, tail: &str, room: u64)
	-> (String, bool)
{
	let fits = |t: &String| msg_bytes(&ChatMessage::user(t.clone())) <= room;
	let mut s = notice_with(folded, words, summary, ledger, capped);
	s.push_str(tail);
	if fits(&s) {
		return (s, true);
	}
	let why = match summary {
		Summary::None(r)  => r.to_string(),
		// Its decisions, open items and findings are already in their files (L3).
		Summary::Filed(_) => fmt!("the summary came back longer than the {} bytes this fold had \
			room for, and was left out whole rather than cut short; its decisions, open items and \
			findings were filed into DECISIONS.md, REQUIREMENTS.md and STATE.md, which are in \
			front of you on every round", room),
		_                 => fmt!("the summary came back longer than the {} bytes this fold had \
			room for, and was left out whole rather than cut short", room),
	};
	let mut last = String::new();
	for per in [LEDGER_SHOWN, 20, 10, 5, 2, 0] {
		let mut t = notice_showing(folded, words, &Summary::None(&why), ledger, capped, per);
		t.push_str(tail);
		if fits(&t) {
			return (t, false);
		}
		last = t;
	}
	(last, false)
}

/// What opens the section of a fold notice that carries his words.
const WORDS_HEAD: &str = "\n## Your words\n\nEvery message sent to you as the user before this \
	note, word for word, oldest first:\n\n";

/// Every message the person sent in `folded`, word for word, oldest first: what a fold notice
/// carries under `## Your words` (R1, invariant 2).
///
/// The summary is a model's paraphrase and may be missing altogether -- a call that failed, a
/// reply left out for room, a fold with no room for one -- so his words cannot rest on it.  An
/// earlier notice among `folded` hands its own section on, so a second fold loses nothing the
/// first kept.  The app's `pre` note is not his and is left out, and so is every message whose
/// stored origin is the app's (nudges, a turn's tail notes): the origin says so, and the words
/// are never read to guess it (MEDIUM-B).  A message with no stored origin reads as his.  `pin`
/// is set back verbatim behind the notice, so it is not repeated here.
///
/// # Arguments
/// * `folded` - The messages the fold replaces.
/// * `pin` - The turn's opening, kept behind the notice, if any.
pub fn person_words(folded: &[ChatMessage], pin: Option<&ChatMessage>) -> Vec<String> {
	person_said(folded, pin).into_iter().map(|w| w.text).collect()
}

/// One message of his, with the transcript row it was said as (`mid`, empty for none).
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct Said {
	pub mid:  String,
	pub text: String,
}

/// [`person_words`] with each message's row id, which is what files it in the words log once and
/// names it in a notice.
pub fn person_said(folded: &[ChatMessage], pin: Option<&ChatMessage>) -> Vec<Said> {
	let mut out = Vec::new();
	for m in folded {
		match m {
			ChatMessage::User { content, origin, mid, .. } => {
				let text = content.as_text();
				match origin {
					Origin::Notice => out.extend(said_in_notice(&text)),
					Origin::App    => {},
					Origin::Person => if !text.trim().is_empty() && pin != Some(m) {
						out.push(Said { mid: mid.clone(), text: text.to_string() });
					},
				}
			},
			_ => {},
		}
	}
	out
}

/// The `## Your words` section of a notice, empty where there are none.  Each message is quoted
/// line by line (`> `, a bare `>` for an empty line), so a blank line ends one message and
/// [`words_in_notice`] reads them back exactly.
pub fn words_section(words: &[String]) -> String {
	let said: Vec<Said> = words.iter().map(|w| Said { mid: String::new(), text: w.clone() })
		.collect();
	said_section(&said, "")
}

/// The `## Your words` section of a notice for `said`, each message labelled `[mid]` where it
/// has one, and `older` (a sentence naming the messages filed but not carried) after them.  Empty
/// where there is neither.
pub fn said_section(said: &[Said], older: &str) -> String {
	if said.is_empty() && older.is_empty() {
		return String::new();
	}
	let mut s = String::from(WORDS_HEAD);
	for (i, w) in said.iter().enumerate() {
		if i > 0 {
			s.push('\n');
		}
		if !w.mid.is_empty() {
			s.push_str(&fmt!("[{}]\n", w.mid));
		}
		quote_into(&mut s, &w.text);
	}
	if !older.is_empty() {
		if !said.is_empty() {
			s.push('\n');
		}
		s.push_str(older);
		s.push('\n');
	}
	s
}

/// `text` quoted line by line (`> `, a bare `>` for an empty line) onto `s`.
fn quote_into(s: &mut String, text: &str) {
	for line in text.split('\n') {
		match line.is_empty() {
			true  => s.push_str(">\n"),
			false => s.push_str(&fmt!("> {}\n", line)),
		}
	}
}

/// Is `line` a `[mid]` label over a quoted message?
fn label_of(line: &str) -> Option<&str> {
	line.strip_prefix('[').and_then(|r| r.strip_suffix(']'))
		.filter(|m| !m.is_empty() && !m.contains(' '))
}

/// Quoted messages read from `lines`, each with the label or `### ` header line over it, until a
/// line that is neither.  `head` reads an entry's id from a non-quote line, `None` for a line that
/// ends the run.
fn quoted<'a>(lines: impl Iterator<Item = &'a str>, head: impl Fn(&'a str) -> Option<String>)
	-> Vec<Said>
{
	let mut out = Vec::new();
	let mut mid = String::new();
	let mut cur: Option<Vec<&str>> = None;
	for line in lines {
		if line == ">" {
			cur.get_or_insert_with(Vec::new).push("");
		} else if let Some(rest) = line.strip_prefix("> ") {
			cur.get_or_insert_with(Vec::new).push(rest);
		} else {
			if let Some(c) = cur.take() {
				out.push(Said { mid: std::mem::take(&mut mid), text: c.join("\n") });
			}
			if line.is_empty() {
				continue;
			}
			match head(line) {
				Some(m) => mid = m,
				None    => break,
			}
		}
	}
	if let Some(c) = cur.take() {
		out.push(Said { mid, text: c.join("\n") });
	}
	out
}

/// His words as a notice carries them, each message exactly as [`words_section`] took it.
pub fn words_in_notice(text: &str) -> Vec<String> {
	said_in_notice(text).into_iter().map(|w| w.text).collect()
}

/// [`words_in_notice`] with each message's label.
pub fn said_in_notice(text: &str) -> Vec<Said> {
	match text.find(WORDS_HEAD) {
		Some(i) => quoted(text[i + WORDS_HEAD.len()..].split('\n'),
			|l| label_of(l).map(str::to_string)),
		None    => Vec::new(),
	}
}

// ── The words log (CCP2-FOLDFIX2) ────────────────────────────────────────────
//
// Every message of his a fold takes out of the conversation is filed verbatim, with its date and
// row id, under `## His words` in the keeper's words log (`chats/<id>/WORDS.md`, or the Diamond's)
// before the notice stops carrying it.  The app files it, never the model: the log is part of the
// keeper's record (`tools::KEEPER_LOGS`), so no door a model, a page or a run reaches writes it
// (CCP3 F1).  What accumulates is his typing alone; it lives with the chat, not in the prompt, and
// goes with the chat's deletion.

/// The share of the fold's target his newest words may take in a notice: 6k tokens of the 90k
/// target at the standard 120k budget.  The rest are named, with a pointer to the words log.
pub const WORDS_SHARE: f64 = 1.0 / 15.0;

/// The words log's own file at the top of the keeper's home, beside its notes, and written by the
/// app alone.
pub const WORDS_FILE: &str = "WORDS.md";

/// The heading of the words log in [`WORDS_FILE`].
pub const WORDS_LOG_HEAD: &str = "## His words";

/// `said` as words-log entries dated `date`: `### [<mid>] <date>` (`### <date>` with no row id),
/// his message quoted, a blank line.
pub fn log_entries(said: &[Said], date: &str) -> String {
	let mut s = String::new();
	for w in said {
		match w.mid.is_empty() {
			true  => s.push_str(&fmt!("### {}\n", date)),
			false => s.push_str(&fmt!("### [{}] {}\n", w.mid, date)),
		}
		quote_into(&mut s, &w.text);
		s.push('\n');
	}
	s
}

/// The entries of a words log, or of the text [`log_entries`] wrote, oldest first.
fn entries_in(text: &str) -> Vec<Said> {
	quoted(text.split('\n'), |l| l.strip_prefix("### ").map(head_mid))
}

/// The row id a log entry's header names, empty for none.
fn head_mid(h: &str) -> String {
	h.strip_prefix('[').and_then(|r| r.split_once(']')).map(|(m, _)| m.to_string())
		.unwrap_or_default()
}

/// The UTC date of `ms` since the epoch, `YYYY-MM-DD`: a log entry's date.
pub fn utc_date(ms: f64) -> String {
	// Days to civil date (H. Hinnant's algorithm), proleptic Gregorian.
	let z = (ms / 86_400_000.0).floor() as i64 + 719_468;
	let era = z.div_euclid(146_097);
	let doe = z.rem_euclid(146_097);
	let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
	let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
	let mp = (5 * doy + 2) / 153;
	let d = doy - (153 * mp + 2) / 5 + 1;
	let m = if mp < 10 { mp + 3 } else { mp - 9 };
	let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
	fmt!("{:04}-{:02}-{:02}", y, m, d)
}

/// Where the words log's body runs in `file`: from after its heading to the next `## ` heading or
/// the end.  `None` where the file has no log.
fn log_span(file: &str) -> Option<(usize, usize)> {
	let mut at = 0usize;
	let mut start: Option<usize> = None;
	for line in file.split_inclusive('\n') {
		let l = line.trim_end_matches('\n');
		match start {
			None    => if l == WORDS_LOG_HEAD { start = Some(at + line.len()); },
			Some(b) => if l.starts_with("## ") { return Some((b, at)); },
		}
		at += line.len();
	}
	start.map(|b| (b, file.len()))
}

/// Every message in the words log of `file`, oldest first; none where it has no log.
pub fn log_read(file: &str) -> Vec<Said> {
	match log_span(file) {
		Some((b, e)) => entries_in(&file[b..e]),
		None         => Vec::new(),
	}
}

/// `file` with `entries` merged into its words log, which is made at the end if absent.  An entry
/// the log already holds, by row id and words, is not added again, so a refold that files the
/// same words twice changes nothing.
pub fn log_merge(file: &str, entries: &str) -> String {
	let have = log_read(file);
	let mut add = String::new();
	let mut lines = entries.split_inclusive('\n').peekable();
	// Entry by entry, so each keeps its own header and date.
	while lines.peek().is_some() {
		let mut one = String::new();
		while let Some(l) = lines.next() {
			one.push_str(l);
			if l.trim_end_matches('\n').is_empty() {
				break;
			}
		}
		for w in entries_in(&one) {
			if !have.contains(&w) && !entries_in(&add).contains(&w) {
				if !one.ends_with("\n\n") {
					one.push('\n');
				}
				add.push_str(&one);
			}
		}
	}
	if add.is_empty() {
		return file.to_string();
	}
	match log_span(file) {
		Some((b, e)) => {
			let mut body = file[b..e].trim_end_matches('\n').to_string();
			body.push_str(if body.is_empty() { "\n" } else { "\n\n" });
			body.push_str(&add);
			fmt!("{}{}{}", &file[..b], body, &file[e..])
		},
		None => {
			let mut out = file.trim_end_matches('\n').to_string();
			if !out.is_empty() {
				out.push_str("\n\n");
			}
			out.push_str(&fmt!("{}\n\n{}", WORDS_LOG_HEAD, add));
			out
		},
	}
}

/// The words log of `file` whole, as `recall` reads it; empty for none.
pub fn log_text(file: &str) -> String {
	match log_span(file) {
		Some((b, e)) => file[b..e].to_string(),
		None         => String::new(),
	}
}

/// A words log rebuilt from the text [`log_text`] read of it, so it files and answers as the log
/// itself does (U2a: a runner stages over the log the tab sent); empty for none.
pub fn log_file(text: &str) -> String {
	match text.is_empty() {
		true  => String::new(),
		false => fmt!("{}\n{}", WORDS_LOG_HEAD, text),
	}
}

/// What the store answers a filing once it has read the file back: each of `entries` is checked
/// to be in the log, and the answer is `<entries in the log> <row id of the oldest>`, small however
/// long the log grows (a filing changes the store, so its answer must always frame).
pub fn log_answer(file: &str, entries: &str, path: &str) -> Outcome<String> {
	let asked = entries_in(entries);
	let log = log_read(file);
	if let Some(w) = asked.iter().find(|w| !log.contains(w)) {
		return Err(err!("'{}' did not read back holding his message{} after it was written, so \
			it was not filed.", path, if w.mid.is_empty() { String::new() } else {
			fmt!(" {}", w.mid) }; IO, File, Write));
	}
	Ok(fmt!("{} {}", log.len(), log.first().map(|w| w.mid.as_str()).unwrap_or("")))
}

/// The count and the oldest row id a filing answered (see [`log_answer`]).
pub fn log_tally(answer: &str) -> (usize, String) {
	let (n, first) = answer.split_once(' ').unwrap_or((answer, ""));
	(n.trim().parse().unwrap_or(0), first.trim().to_string())
}

/// His newest messages that fit `share` bytes as a notice section, contiguous back from the
/// newest, and the rest, oldest first.
pub fn newest_within(said: &[Said], share: u64) -> (Vec<Said>, Vec<Said>) {
	let mut from = said.len();
	while from > 0 {
		let trial = said_section(&said[from - 1..], "");
		if trial.len() as u64 > share {
			break;
		}
		from -= 1;
	}
	(said[from..].to_vec(), said[..from].to_vec())
}

/// The sentence a notice says over his words that were filed and not carried: how many, which
/// rows, and where to read them.
pub fn older_words_line(older: &[Said], path: &str) -> String {
	let first = older.first().map(|w| w.mid.as_str()).unwrap_or("");
	let last  = older.last().map(|w| w.mid.as_str()).unwrap_or("");
	older_line(older.len(), first, last, path)
}

/// [`older_words_line`] for `n` messages, from row `first` to row `last` (empty for unknown).
pub fn older_line(n: usize, first: &str, last: &str, path: &str) -> String {
	if n == 0 {
		return String::new();
	}
	let rows = match (first.is_empty(), last.is_empty()) {
		(false, false) if first != last => fmt!(", rows {} to {},", first, last),
		(false, true)                   => fmt!(", from row {},", first),
		(false, false)                  => fmt!(", row {},", first),
		_                               => String::new(),
	};
	fmt!("({} earlier message{} of yours{} are kept word for word under \"{}\" in {} on his \
		device, where `recall` reads them.)", n, if n == 1 { "" } else { "s" }, rows, WORDS_LOG_HEAD,
		path)
}

/// Whether a message is a fold notice this module wrote: its stored origin, never its words, so
/// a message of his that opens with a pasted notice stays his (MEDIUM-B).
pub fn is_fold_notice(m: &ChatMessage) -> bool {
	m.origin() == Some(Origin::Notice)
}

/// Every line of every fold notice in `msgs` that `re` matches, oldest notice first.
///
/// **The half of `recall` no tool could answer.**  A tool is handed a `ToolContext` and never the
/// session, and what a conversation has folded away lives only in its own messages -- so this is
/// pure, takes the messages, and is called from the one place that has them
/// ([`crate::agent::Agent::run_tool_loop`]).  Written here rather than there because it is a
/// statement about what a fold left behind, which is this module's subject.
///
/// Lines are reported as `fold:<k>:<n>: text`, `k` counting notices oldest first and `n` the line
/// within that notice -- the same `path:line:text` shape `file_search` reports in, so a model
/// reads one answer in one form.
///
/// # Arguments
/// * `msgs` - The conversation, oldest first.
/// * `matches` - Whether one line matches; undecidable lines answer `false`.
/// * `before` - Context lines before each match.
/// * `after` - Context lines after each match.
/// * `limit` - Most matches to report.
pub fn recall_folds(
	msgs:    &[ChatMessage],
	log:     &str,
	matches: &mut impl FnMut(&str) -> bool,
	before:  usize,
	after:   usize,
	limit:   usize,
)
	-> Vec<String>
{
	let mut out  = Vec::new();
	let mut note = 0usize;
	let mut hits = 0usize;
	for m in msgs.iter().filter(|m| is_fold_notice(m)) {
		note += 1;
		let text = match m {
			ChatMessage::User { content, .. } => content.as_text(),
			_                             => continue,
		};
		let lines: Vec<&str> = text.lines().collect();
		let mut done: Option<usize> = None;
		for (i, line) in lines.iter().enumerate() {
			if !matches(line) {
				continue;
			}
			if hits >= limit {
				return out;
			}
			hits += 1;
			let lo = i.saturating_sub(before);
			let hi = (i + after).min(lines.len().saturating_sub(1));
			let start = match done {
				Some(p) if lo <= p + 1 => p + 1,
				_                      => lo,
			};
			for n in start..=hi {
				let sep = if n == i { ':' } else { '-' };
				out.push(fmt!("fold:{}{}{}{}{}", note, sep, n + 1, sep, lines[n]));
			}
			done = Some(hi);
		}
	}
	// His words log, as `words:<n>:` lines, after the notices.
	for (i, line) in log.lines().enumerate() {
		if !matches(line) {
			continue;
		}
		if hits >= limit {
			return out;
		}
		hits += 1;
		out.push(fmt!("words:{}:{}", i + 1, line));
	}
	out
}

/// What goes into the conversation when a turn is stopped at the round limit.
///
/// A SYSTEM message, because the limit is the app's and so is the sentence.  It used to be
/// written as an assistant message reading `[Reached the tool-call round limit (25).]`, so
/// the next turn began with the model reading its own surrender back as something it had
/// said -- a turn stopped from outside became, in the record, a turn that gave up.  It also
/// says the work may be unfinished, because a boundary that reads like a conclusion invites
/// the model to write one.
///
/// # Arguments
/// * `max_rounds` - The limit that was reached.
/// Said to the model when the turn before it produced no words at all.
///
/// A turn can finish having said nothing: the provider returns an empty final
/// message, and on a reasoning model the whole answer sometimes goes to a channel
/// the app does not print.  Nothing then appears on screen, the spinner clears,
/// and the user cannot tell a finished turn from a hung one -- which is what was
/// reported against a DeepSeek model after it had read five files and stopped.
///
/// It is said in the app's voice, for the reason [`round_limit_note`] gives: a
/// silence the app noticed must not read, on the next turn, as something the
/// assistant chose to say.
pub fn empty_turn_note() -> ChatMessage {
	ChatMessage::system(
		"[The previous turn ended without producing any text. Daimond noticed and \
		 said so; the assistant did not choose to stop. Say what was found and \
		 carry on from there.]".to_string())
}

pub fn round_limit_note(max_rounds: usize) -> ChatMessage {
	ChatMessage::system(fmt!(
		"[Daimond stopped the previous turn after {} tool-call rounds, which is its \
		 limit. The assistant did not choose to stop and the task may be unfinished; \
		 say where it had got to before carrying on.]", max_rounds))
}

/// What goes into the conversation when a turn is stopped after using up its continuations.
///
/// Said separately from [`round_limit_note`] because it is a different fact: that note reports a
/// boundary the app could have pushed back and chose not to, while this one reports a boundary
/// with nothing left behind it.  A model told only "the round limit" after six hundred rounds
/// would reasonably expect another Continue to get further, and the figure is what says it will
/// not -- see [`MAX_CONTINUATIONS`].
///
/// # Arguments
/// * `rounds` - Rounds the whole turn ran, continuations included.
/// * `continuations` - How many times it carried on by itself.
pub fn continuation_limit_note(rounds: usize, continuations: usize) -> ChatMessage {
	ChatMessage::system(fmt!(
		"[Daimond stopped the previous turn after {} tool-call rounds, having already \
		 carried it on {} times by itself, which is its limit. The assistant did not choose \
		 to stop and the task may be unfinished; say where it had got to before carrying on.]",
		rounds, continuations))
}

/// What goes into the conversation when a turn is stopped because it spent its ceiling.
///
/// In the app's voice, for the reason [`round_limit_note`] gives.  It names both figures: a
/// ceiling the model cannot see is one it cannot take account of, and the next turn's first act
/// is usually to decide how much more work to attempt.
///
/// # Arguments
/// * `spent` - What the turn reported spending, in US dollars.
/// * `cap` - The per-turn ceiling it passed, in US dollars.
pub fn spend_limit_note(spent: f64, cap: f64) -> ChatMessage {
	ChatMessage::system(fmt!(
		"[Daimond stopped the previous turn after it had spent about US${:.2}, which is past \
		 the US${:.2} a turn is allowed. The assistant did not choose to stop and the task may \
		 be unfinished; say where it had got to before carrying on.]", spent, cap))
}

/// What a worker is told at the seam of the round its dispatcher's turn ended in.
///
/// **It is told, rather than simply stopped.**  A bound a model cannot see is a bound it walks
/// into mid-file; told the figure, it can write down what it has.  In the app's voice, for the
/// reason [`round_limit_note`] gives, and it names what became of the audience rather than only
/// the number -- a worker that knows nobody is holding a promise on its report knows to make
/// that report short.
///
/// # Arguments
/// * `grace` - Rounds it has left; see [`ORPHAN_GRACE_ROUNDS`].
pub fn orphan_note(grace: usize) -> ChatMessage {
	ChatMessage::system(fmt!(
		"[The turn that dispatched you has ended, so nothing is waiting on your report and \
		 there is nobody to ask. Daimond will stop this turn after {} more tool-call round(s). \
		 Finish what is in hand and write your report now; it will be read at the top of the \
		 next turn rather than in this one.]", grace))
}

/// What goes into the conversation when an orphaned worker is stopped at that grace.
///
/// Said separately from [`round_limit_note`] and [`continuation_limit_note`] because it is a
/// different fact from either: the round budget was not spent and no continuation was refused --
/// the audience went away.  A worker resumed by hand from here has its whole ceiling again, and
/// the sentence says the work may be unfinished so that whoever reads it knows to ask.
///
/// # Arguments
/// * `rounds` - Rounds the whole turn ran.
/// * `grace` - The ceiling it met; see [`ORPHAN_GRACE_ROUNDS`].
pub fn orphan_limit_note(rounds: usize, grace: usize) -> ChatMessage {
	ChatMessage::system(fmt!(
		"[Daimond stopped the previous turn after {} tool-call rounds, {} of them after the turn \
		 that dispatched this worker had ended and left nothing waiting for its report. The \
		 assistant did not choose to stop and the task may be unfinished; say where it had got \
		 to before carrying on.]", rounds, grace))
}


// ┌───────────────────────────────────────────────────────────────┐
// │ Folding                                                        │
// └───────────────────────────────────────────────────────────────┘

/// Replace everything before `cut` with one notice, keeping the rest exactly as it was.
///
/// Refuses -- returning the reason rather than a conversation -- when the result would
/// carry more orphaned tool calls or replies than it was given.  That refusal is the point:
/// a fold that orphans a call produces a request every provider rejects, on this turn and
/// on every turn after it, which is the failure this module exists to prevent.  The caller
/// falls back to [`elide_tool_results`], which cannot orphan anything because it adds and
/// removes nothing.
///
/// # Arguments
/// * `msgs` - The conversation, oldest first.
/// * `cut` - Index of the first message to keep.
/// * `notice` - What replaces the folded part.
pub fn fold(msgs: &[ChatMessage], cut: usize, notice: String) -> Outcome<Vec<ChatMessage>> {
	fold_keeping(msgs, cut, None, notice)
}

/// [`fold`], with `pin` set straight after the notice and ahead of `msgs[cut..]`.
///
/// The pin is the opening message of a turn the cut passes through -- see [`pinned_opening`] --
/// so the turn's ask stands word for word however many times the turn folds.
pub fn fold_keeping(
	msgs:   &[ChatMessage],
	cut:    usize,
	pin:    Option<&ChatMessage>,
	notice: String,
)
	-> Outcome<Vec<ChatMessage>>
{
	if cut == 0 || cut >= msgs.len() {
		return Err(err!(
			"Fold: a cut at {} of {} messages folds nothing or everything.", cut, msgs.len();
			Invalid, Input));
	}
	let mut out = Vec::with_capacity(msgs.len() - cut + 2);
	out.push(ChatMessage::notice(notice));
	if let Some(p) = pin {
		out.push(p.clone());
	}
	// What the fold keeps it keeps byte for byte, but a mark it carries is no longer a
	// shortening of the conversation it leaves; see `shortened`.
	out.extend(msgs[cut..].iter().map(|m| m.clone().as_folded()));
	let before = orphan_count(msgs);
	let after  = orphan_count(&out);
	if after > before {
		return Err(err!(
			"Fold: cutting at {} would leave {} unpaired tool calls where the conversation \
			 had {}; a provider rejects that outright.", cut, after, before;
			Invalid, Data));
	}
	Ok(out)
}

/// Shrink the oldest bulky messages in place until the conversation fits.
///
/// The safe half of compaction, and the fallback for every case the folding half refuses:
/// no message is added, removed or reordered and no `tool_call_id` changes, so pairing is
/// untouched by construction.  It is also the only thing that helps when the conversation
/// is one turn long and already too big -- there is no earlier part to fold.
///
/// Two kinds of message are shrunk and two are not.  A tool result and a long assistant
/// turn are both machine output and can be read or asked for again; the user's own words
/// and the system prompt are neither, and are left exactly as they are.  An assistant turn
/// keeps its `tool_calls` untouched -- only its prose is shortened -- so the block it opens
/// stays answerable.
///
/// IMAGES GO FIRST, in a pass of their own before any prose is touched.  Three reasons, in the
/// order they matter: an image is the largest single thing a transcript can hold, so dropping one
/// buys more room than shortening every tool result in the conversation; it is the least
/// re-readable, because nothing in the text can stand in for what it showed; and it is the most
/// cheaply recovered, because the ledger already records which file was read and `file_read` will
/// fetch it again.  The line left in its place names that file -- see [`ImagePart::elision`] --
/// so an elided image is a pointer, not a hole.  A user's own image is dropped too, unlike a
/// user's own words: the words cannot be recovered and the file can.
///
/// Returns how many messages were shrunk.
///
/// # Arguments
/// * `msgs` - The conversation, edited in place.
/// * `target_bytes` - The size to get under.
/// * `keep_last` - Trailing messages never touched, so the newest work stays whole.
pub fn elide_bulk(
	msgs:         &mut [ChatMessage],
	target_bytes: u64,
	keep_last:    usize,
)
	-> usize
{
	let mut total = conversation_bytes(msgs);
	if total <= target_bytes {
		return 0;
	}
	let last = msgs.len().saturating_sub(keep_last);
	let mut n = 0;

	// Pass one: the images, oldest first.
	for i in 0..last {
		if total <= target_bytes {
			return n;
		}
		if !msgs[i].content().has_image() {
			continue;
		}
		let before = msg_bytes(&msgs[i]);
		msgs[i] = msgs[i].with_content(msgs[i].content().without_images(crate::protocol::Dropped::ToFit));
		total = total.saturating_sub(before.saturating_sub(msg_bytes(&msgs[i])));
		n += 1;
	}

	// Pass two: the prose, as before.
	for i in 0..last {
		if total <= target_bytes {
			break;
		}
		let len = match &msgs[i] {
			ChatMessage::Tool { content, .. } if content.text_len() > TOOL_ELISION_CAP =>
				content.text_len(),
			ChatMessage::Assistant { content, .. } if content.text_len() > TOOL_ELISION_CAP =>
				content.text_len(),
			_ => continue,
		};
		let shrunk = fmt!(
			"{}\n[the remaining {} bytes were folded away to fit the context window; read it \
			 again if you need it]",
			clip(&msgs[i].text(), TOOL_ELISION_CAP), len - TOOL_ELISION_CAP.min(len));
		msgs[i] = msgs[i].with_content(MessageContent::text(shrunk.clone()));
		total = total.saturating_sub((len - shrunk.len().min(len)) as u64);
		n += 1;
	}
	n
}


// ┌───────────────────────────────────────────────────────────────┐
// │ Retiring what an earlier turn carried                          │
// └───────────────────────────────────────────────────────────────┘
//
// A fold and an elision are both LAST RESORTS: they fire when the conversation has already
// outgrown what may be sent.  The bill that provoked this section is not that one.  A turn
// costing five dollars ran a hundred and fifty rounds at a prompt that FROZE just under the
// ceiling -- so nothing here ever fired, nothing was ever too big, and the same hundred and
// fifty kilobytes of a previous turn's file reads were re-sent a hundred and fifty times at
// the cached-input rate.  Ninety-seven per cent of it was a cache hit, which is why it was
// cheap per token and ruinous in total: the lever is not the price of a token, it is how many
// tokens a round carries at all.
//
// So this is the UNCONDITIONAL half of compaction, and the only half that runs when nothing is
// wrong.  A tool result from a turn that has already ended is not working memory -- the model
// has read it, acted on it, and written whatever it was going to write.  What it needs from
// that result afterwards is the fact that the call happened and what it was called with, which
// is one line.  The file is still there to be read again, and saying so in the line is what
// makes the retirement safe rather than lossy.
//
// THE STORED TRANSCRIPT IS NOT TOUCHED, by the same ruling that governs `elide_bulk`: a
// model's window is a property of the REQUEST, so the lossy form is the request's and is built
// from a record that stays whole.  Every function here takes the SENT copy.

/// Rounds between in-turn retirement sweeps.
///
/// NOT every round, and the reason is the bill this section exists to reduce.  Every byte of the
/// prompt that changes costs a prefix-cache MISS on the round after it, charged at the full input
/// rate -- so a sweep that rewrote one result per round would pay a miss every round to save a
/// carry it had already mostly saved.  Ten rounds amortises the miss over the nine that follow it,
/// and a long turn still gets a dozen sweeps.
pub const IN_TURN_RETIRE_EVERY: usize = 10;

/// Rounds a tool RESULT must be old before it is retired mid-turn.
///
/// **The result is what a long turn is mostly made of**, and until now nothing aged one: the
/// results were carried whole to the end of the turn, so a worker that read twenty files re-sent all twenty on every round after the last of
/// them.  A measured turn sat at 77.5K tokens a round for 85 rounds with nothing ever too big to
/// fold, which is the same arithmetic `ABSOLUTE_CAP` was lowered for -- 97% of it a cache hit,
/// cheap per token and ruinous in total.
///
/// A result is working memory, and a model reads back over the last several rounds of it -- a file it read four rounds ago is
/// a file it is probably still editing.
///
/// DOUBLED TO 16 ON 2026-09-13.  Eight left a worker re-reading what the sweep had just retired
/// -- the tune loop's `stubRR` (stub re-read rate) sat at 0.30 under the old figure against
/// 0.00-0.07 on every other arm measured, and the tight preset was the worst arm overall, 0.75
/// against 0.83-0.88.  Sixteen is still well inside a hundred-round worker's turn.
pub const IN_TURN_RESULT_AGE: usize = 16;

/// Bytes of a tool result left whole mid-turn, however old it is.
///
/// The stub costs a line, so retiring a result already near that size would buy nothing and lose
/// the content: two kilobytes is a couple of screenfuls of output, and a result that big is a
/// file read, a listing or a command's output -- all of which can be asked for again, which is
/// what the stub says.  Below it are the one-line confirmations a turn is mostly made of by
/// COUNT, and they are not what it is made of by size.
pub const IN_TURN_RESULT_CAP: usize = 2_048;

/// Completed turns left verbatim in the sent copy before retirement begins.
///
/// **One, not nought, and the experiment is the reason.**  Retiring every finished turn is right
/// for a fifty-round daimon session -- it took a per-round prompt from 182K tokens to 92K -- and
/// wrong for the two- and three-turn chat a user actually has.  Measured on 2026-09-13 against
/// deepseek-v4.1-flash, a three-turn memory task carried 41% MORE tokens on turn two with the
/// retirement on than with it off: the model met a stub of what it had just been told, asked for
/// the file again, and paid for both copies.  Between 3.6 and 8.6 re-reads-after-stub a trial,
/// against nought with the measure off, for no gain in what the answer was worth.
///
/// So the boundary moves back one turn.  The turn the user is most likely to be talking ABOUT
/// keeps every byte, and a session long enough for the saving to matter still has every turn
/// before that retired.
///
/// **CONFIRMED BY THE RUN THAT FOLLOWED**, `rexp2`, thirty trials on the same model: nought
/// re-reads-after-stub in all ten trials at this figure, against 3 to 12 a trial in all ten at a
/// keep of nought -- the same tell the run before it found, and gone.  On the three-turn task the
/// third turn's opening prompt is still 5.6% below what never retiring carries, so the measure is
/// working on the turn it is left to work on.  `fix_two` is a two-turn task and this figure
/// therefore retires nothing in it at all, which makes its row a NULL CONTROL: the two arms are
/// the same engine there and their costs differ by 12% and their second turn's prompt by 17%,
/// which is the noise floor every other figure in that report has to clear.
pub const RETIRE_KEEP_TURNS: u32 = 1;

/// Fraction of the fold budget ([`Limits::budget`]) past which old tool results are retired.
///
/// **Below it nothing is shortened, at a turn boundary or mid-turn** (daimond_rulings.md §17,
/// D-20261020-11, "Only past a size line").  Retiring at every boundary rewrote the turn before
/// last on every turn, and a provider's prompt cache pays out only on a byte-identical prefix, so
/// each turn re-billed the conversation from the oldest newly retired result at the full input
/// rate (QA-B r578c B2: 5 breaks in 5 boundaries on a read-heavy Diamond).  A result carried whole
/// costs the cached rate, a tenth or less; a rewrite costs the full rate on everything after it.
/// So results are kept whole and cached while the conversation is small, and shortened ONCE as it
/// nears the fold -- one cache miss -- after which the turns append again on the shorter prefix.
/// [`ChatMessage::as_retired`] is what keeps a result short on every later request, byte for byte.
///
/// **Two-thirds, and tied to the budget rather than a figure of its own**: at the shipped 120k
/// [`ABSOLUTE_CAP`] the line is the owner's ~80k, and on a smaller window, whose fold comes
/// sooner, it comes sooner with it, so the shortening always has room to land before a fold.  Lower
/// shortens earlier and more often; one turns it into a fold's companion; nought is the old rule,
/// every boundary, and is the arm a measurement of this one compares against (`set_tune`'s
/// `retire_at`).
///
/// Claude Code keeps tool results verbatim and lets caching carry them until context is large; its
/// API context edit (`clear_tool_uses`) likewise fires at an input-token threshold and keeps the
/// call inputs.  This is the same rule.
pub const RETIRE_AT: f64 = 2.0 / 3.0;

/// **Once, then append until the summary (r578f, QA r578e C1/C2, D-20261020-11).**  Past the
/// line a conversation is shortened ONCE -- at the turn boundary or in the tool loop's sweep,
/// whichever comes first -- and nothing more is retired until a fold renews it; see
/// [`shortened`].  The stubs, the model's own arguments and the notes are a floor retirement cannot
/// go under, so a conversation shortened once can stay past the line, and every later shortening
/// re-bills everything after the first result it touches at the full input rate: r578d did that at
/// every boundary, r578e every ~20k tokens of new results and every tenth round of a long loop.
/// The summary at the fold is the relief valve, as it is for Claude Code.

/// How the turn's budget line opens, and the marker that finds an earlier one to remove.
///
/// On its own line inside the last tool result, so removing it is a truncation rather than a
/// rewrite and a result that happens to contain the word "budget" is not mistaken for one.
///
/// **Not `[budget]`, which is taken.**  `crate::tools` already appends that marker to a result
/// whose output ran past the turn's BYTE budget, and a strip that could truncate one of those
/// would delete a real result's last line.  Two markers, two subjects.
const BUDGET_NOTE_OPEN: &str = "\n[turn budget: ";

/// The notice speaks only when the nearer of the two limits is this close.  Under a fifth of
/// the rounds or of the spend left, whichever is nearer: early enough to plan around, late
/// enough that an ordinary turn never sees it and so never stops for it.  ONE rule for the
/// whole notice -- it appears near a real limit, says what remains and what happens there, and
/// never invites stopping, because the model that reads it cannot tell a near limit from a
/// distant one and a mention of either reads as "stop now".  2026-10-05: a turn at 21 of 600
/// rounds ended on an empty reply after reading this line on a comfortable budget.
pub const BUDGET_NOTE_UNDER: f64 = 0.20;

/// The tail every retired tool RESULT ends with.
///
/// It is how a second pass recognises its own work, which is what makes retirement
/// idempotent: a stub rebuilt from the same call would be identical but for the byte count,
/// and a count of a count is a lie that grows.
const RESULT_RETIRED_TAIL: &str = "; call it again if you need it]";

/// Bytes of a key argument kept in a stub, so one enormous path cannot undo the saving.
const STUB_ARG_CAP: usize = 200;

/// Retire what the conversation carried before the last `keep` completed turns.
///
/// Returns how many messages were changed.
///
/// Use [`retire_upto`] where the boundary is known for other reasons -- mid-turn, an
/// interjection is a user message too, and taking it as the boundary would retire the work of
/// the turn it is interrupting.
///
/// # Arguments
/// * `msgs` - The SENT copy of the conversation, edited in place.
/// * `keep` - Completed turns left whole; see [`RETIRE_KEEP_TURNS`].
pub fn retire_prior(msgs: &mut [ChatMessage], keep: u32) -> usize {
	retire_upto(msgs, prior_end(msgs, keep))
}

/// Where retirement stops: the start of the oldest turn that is to be left whole.
///
/// With `keep` of nought that is the message the current turn opened with, because at the top of
/// a turn the user's sentence has just been pushed, so everything before it belongs to a turn that
/// has ended.  Each further turn kept walks the boundary back over one more opening, so `keep` of
/// one leaves the turn just finished exactly as the model saw it.
///
/// Zero when the user has not spoken that often, which retires nothing -- a conversation with
/// two turns in it and two to keep has no finished turn to take anything from.
///
/// **A turn is counted by the message it opened with, never by role alone** (r578d, QA-B B1).
/// The app's own end-of-turn notes and a mid-turn interjection are user messages too, and while
/// they counted, a Diamond turn that changed files ended with two of them and the boundary landed
/// on the last: the read the model had just finished went as a stub on the very next turn.  See
/// [`ChatMessage::opening`].  A conversation stored before the mark carries none, so the part of it
/// before the first marked opening counts every user message, as it always did.
///
/// # Arguments
/// * `keep` - Completed turns left whole; see [`RETIRE_KEEP_TURNS`].
pub fn prior_end(msgs: &[ChatMessage], keep: u32) -> usize {
	let first = msgs.iter().position(|m| m.opens_turn()).unwrap_or(msgs.len());
	let mut seen = 0;
	for (i, m) in msgs.iter().enumerate().rev() {
		let opens = m.opens_turn() || (i < first && matches!(m, ChatMessage::User { .. }));
		if opens {
			if seen == keep {
				return i;
			}
			seen += 1;
		}
	}
	0
}

/// Retire the tool results in `msgs[..end]`.
///
/// **Results only** (daimond_rulings.md §17, D-20261020-01).  A tool call's arguments are the
/// model's own past actions and reach it exactly as it sent them: they are what it copies, and
/// a shortened write it met as its own came back as a write of nothing (a copied `retired` key
/// reached a new `file_edit` on 2026-10-08).  Assistant prose, user messages, the system prompt and a fold's own notice are all left
/// exactly as they are: the first two cannot be read again from anywhere, and the notice is
/// already the compressed form of everything it replaced.
///
/// # Arguments
/// * `msgs` - The SENT copy of the conversation, edited in place.
/// * `end` - One past the last message that may be retired.
pub fn retire_upto(msgs: &mut [ChatMessage], end: usize) -> usize {
	let end = end.min(msgs.len());
	let mut n = 0;
	let mut i = 0;
	while i < end {
		// Cloned, so the replies can be rewritten while the calls that name them are read.
		let calls = match &msgs[i] {
			ChatMessage::Assistant { tool_calls, .. } if !tool_calls.is_empty() =>
				tool_calls.clone(),
			_ => { i += 1; continue; },
		};
		for (k, tc) in calls.iter().enumerate() {
			let j = i + 1 + k;
			if j >= end {
				break;
			}
			if let Some(stub) = result_stub(tc, &msgs[j]) {
				msgs[j] = msgs[j].with_content(MessageContent::text(stub)).as_retired();
				n += 1;
			}
		}
		i += 1 + calls.len();
	}
	n
}

/// Send again, as stubs, the results an earlier request already sent short.
///
/// The stored conversation keeps every result whole and only marks the ones that went out retired
/// ([`ChatMessage::as_retired`]), so a copy built from it has to be shortened again at the same
/// places, or the next request would carry the whole result where the last carried its stub and
/// the cached prefix would end there.  [`result_stub`] is a function of the call and the whole
/// result, so the stub rebuilt here is the stub that went out.  A result already short -- a
/// worker's copy of its parent's request -- is left as it is.
///
/// Returns how many results were shortened.
///
/// # Arguments
/// * `msgs` - The SENT copy of the conversation, edited in place.
pub fn restub(msgs: &mut [ChatMessage]) -> usize {
	let mut n = 0;
	let mut i = 0;
	while i < msgs.len() {
		let calls = match &msgs[i] {
			ChatMessage::Assistant { tool_calls, .. } if !tool_calls.is_empty() =>
				tool_calls.clone(),
			_ => { i += 1; continue; },
		};
		for (k, tc) in calls.iter().enumerate() {
			let j = i + 1 + k;
			if j >= msgs.len() {
				break;
			}
			if !msgs[j].is_retired() {
				continue;
			}
			if let Some(stub) = result_stub(tc, &msgs[j]) {
				msgs[j] = msgs[j].with_content(MessageContent::text(stub));
				n += 1;
			}
		}
		i += 1 + calls.len();
	}
	n
}

/// Mark in the stored conversation every result `sent` went out retired, by the call it answers.
///
/// By id rather than by index, because the sent copy leads with the system message (and a worker's
/// with its parent's) and a turn in flight pushes to both lists; an id names one call.
///
/// Returns how many stored results were newly marked.
///
/// # Arguments
/// * `stored` - The session's own conversation, whose content is never touched.
/// * `sent` - The copy that was, or is about to be, sent.
pub fn carry_retired(stored: &mut [ChatMessage], sent: &[ChatMessage]) -> usize {
	let ids: std::collections::HashSet<&str> = sent.iter().filter_map(|m| match m {
		ChatMessage::Tool { tool_call_id, .. } if m.is_retired() => Some(tool_call_id.as_str()),
		_ => None,
	}).collect();
	if ids.is_empty() {
		return 0;
	}
	let mut n = 0;
	for m in stored.iter_mut() {
		let hit = matches!(m, ChatMessage::Tool { tool_call_id, retired: Retired::No, .. }
			if ids.contains(tool_call_id.as_str()));
		if hit {
			*m = m.clone().as_retired();
			n += 1;
		}
	}
	n
}

/// Is the conversation past the line old results retire at?  Either figure over it is past, as
/// for [`needs_fold`]: the estimate before a request, the provider's own count after one.
///
/// # Arguments
/// * `est_tokens` - The gauge's byte-based estimate of the prompt about to be sent.
/// * `real_tokens` - The provider's `prompt_tokens` from the last round, or 0 if none yet.
/// * `line` - See [`Limits::retire_line`].
pub fn past_line(est_tokens: u64, real_tokens: u64, line: u64) -> bool {
	est_tokens > line || real_tokens > line
}

/// Has the conversation been shortened since it last folded?  Past the line, the first of the turn
/// boundary and the tool loop's sweep to find it not shortens it, and nothing more is retired
/// until a fold; see [`RETIRE_AT`].
///
/// **One state for both, read off the conversation itself** (r578f, QA r578e C1/C2): a result
/// marked [`Retired::Now`] is a shortening that happened, and the marks are stored, exported and
/// handed back with the messages, so a reload, a fork or a resume past the line reads the same
/// answer and does not shorten again.  A fold turns the marks it keeps into [`Retired::Before`]
/// ([`fold_keeping`]), so the folded conversation starts unshortened and may be shortened once
/// more when it nears the line again.
pub fn shortened(msgs: &[ChatMessage]) -> bool {
	msgs.iter().any(|m| m.retired_since_fold())
}

/// Where the prior-turn boundary lands once a fold has moved every index behind it.
///
/// **A fold renumbers the conversation, and an index into the old one then points at the wrong
/// message -- the WRONG WAY.**  Folding 70 of 83 messages leaves 14, so a boundary of 81 is
/// clamped to 14 and suddenly names the whole list, including the tool results the turn in
/// flight is working from.  [`elide_bulk`] is protected from this by construction, since it
/// adds and removes nothing; a recorded boundary is not, and it has to be carried across.
///
/// [`fold`] keeps `msgs[cut..]` in order behind exactly one notice, so a message at `i >= cut`
/// is at `i - cut + 1` afterwards.  Where the boundary itself was folded away the prior turns
/// are already summarised and there is nothing left to retire, which is what 1 means.
///
/// # Arguments
/// * `prior_end` - The boundary as it was before the fold.
/// * `cut` - Index the fold cut at, as [`fold`] was given it.
pub fn prior_end_after_fold(prior_end: usize, cut: usize) -> usize {
	1 + prior_end.saturating_sub(cut)
}

/// Retire the big, old tool RESULTS in `msgs[..end]`, leaving everything else alone.
///
/// The in-turn half: a turn's results are most of its bytes and nothing aged them at all.  A result older than the
/// caller's horizon and larger than `over` is replaced by [`result_stub`] -- the tool, what it was
/// called on, what became of it, the size of what went, and that it can be called again.  The
/// stored transcript is not touched, by the ruling at the top of this section: the lossy form is
/// the REQUEST's.
///
/// **A picture is left where it is.**  [`result_stub`] would take one, and between turns it
/// should; mid-turn a screenshot is usually the thing being worked on, and the size gate here is
/// the text's so that a result whose bytes are all in an image does not qualify on its caption.
/// `sighted` and the fold are what bound pictures.
///
/// Returns how many results were retired.
///
/// # Arguments
/// * `msgs` - The SENT copy of the conversation, edited in place.
/// * `end` - One past the last message that may be retired; the caller's round horizon.
/// * `over` - Bytes a result must exceed to be worth retiring; see [`IN_TURN_RESULT_CAP`].
pub fn retire_results(msgs: &mut [ChatMessage], end: usize, over: usize) -> usize {
	let end = end.min(msgs.len());
	let mut n = 0;
	let mut i = 0;
	while i < end {
		// Cloned for the reason `retire_upto` clones: the replies are rewritten while the calls
		// that name them are read.
		let calls = match &msgs[i] {
			ChatMessage::Assistant { tool_calls, .. } if !tool_calls.is_empty() =>
				tool_calls.clone(),
			_ => { i += 1; continue; },
		};
		for (k, tc) in calls.iter().enumerate() {
			let j = i + 1 + k;
			if j >= end {
				break;
			}
			// ANSWERED BY THIS CALL, or nothing is touched. The reply has to be the one the call
			// names, or a stub would be filed against the wrong tool -- and an unanswered call is
			// a call that may still be in flight.
			match &msgs[j] {
				ChatMessage::Tool { tool_call_id, content, .. } => {
					if *tool_call_id != tc.id || content.text_len() <= over {
						continue;
					}
				},
				_ => continue,
			}
			if let Some(stub) = result_stub(tc, &msgs[j]) {
				msgs[j] = msgs[j].with_content(MessageContent::text(stub)).as_retired();
				n += 1;
			}
		}
		i += 1 + calls.len();
	}
	n
}

/// The in-turn sweep, once per round at the top of the round, on the loop's own arithmetic.
///
/// `round_at` holds where each round of the turn began, this one last.  On a `sweep_every`th
/// round the results older than `result_age` rounds and larger than `result_cap` bytes are
/// retired -- **only once the conversation is `past` the line** ([`RETIRE_AT`]) **and only if it
/// has not been [`shortened`] since it last folded**; below the line a long turn appends and the
/// cache carries it, and after the one shortening it appends until the summary, by the same ruling
/// the turn boundary follows (r578f, QA r578e C1: r578e swept again every tenth round).
///
/// **The one shortening does the whole job.**  Where the sweep is first, the finished turns the
/// boundary would have retired go in the same rewrite (`retire_prior`, keeping
/// `retire_keep_turns`), since the next boundary will find the conversation already shortened.
/// One function for the loop and its tests, so a fixture cannot flatter the sweep by running it
/// more often or reaching further back than the app.
pub fn sweep_in_turn(msgs: &mut [ChatMessage], round_at: &[usize], l: &Limits, past: bool)
	-> usize
{
	let every = l.sweep_every.max(1);	// a cadence of nought would be a modulo by nought
	let swept = round_at.len();
	if !past || swept <= l.result_age || swept % every != 0 || shortened(msgs) {
		return 0;
	}
	let mut n = retire_results(msgs, round_at[swept - 1 - l.result_age], l.result_cap);
	if l.retire_prior {
		n += retire_upto(msgs, prior_end(msgs, l.retire_keep_turns).min(round_at[0]));
	}
	n
}

/// Say what is left of the turn, in the LAST tool result rather than in the system prompt.
///
/// **The system prompt is the cached prefix, and a figure that changes every tenth round is the
/// worst possible thing to put in it**: every round after the change pays the whole standing
/// context at the full input rate instead of the cached one, which is the bill this module exists
/// to reduce.  A tool result at the tail of the conversation invalidates nothing before itself, and
/// it is also where an instruction is most likely to be acted on.
///
/// Why say it at all: a turn that reaches its ceiling stops in the middle of the work, and the
/// model has no way to see that coming -- it cannot count its own rounds and cannot see the bill.
/// Told how much is left, it can report what it has found rather than being cut off mid-file.
///
/// **An earlier line is LEFT where it stood (r578, audit row 10).**  It used to be removed so the
/// model read one figure, and removing it rewrote a message the provider had already cached, so
/// every round after a note re-billed the conversation from that result on.  Each line names its
/// own figures, the newest is the last thing read, and only rounds under [`BUDGET_NOTE_UNDER`]
/// carry one at all.  The line goes in the result's stored `post` note, written onto this round's
/// own result and never onto one already sent, and [`crate::protocol::join_notes`] puts it after
/// the result's words; so the next turn sends it again, byte for byte.  A result carrying a
/// picture takes it too, after its last text.
///
/// **The figures are named, and the precedent says not to name a figure.**  `tools`' own output
/// budget line deliberately states none, because a model told how many bytes it had left spent up
/// to them.  A countdown is the opposite case: there is nothing here to spend faster, the only act
/// the line asks for is to report sooner, and a model that cannot see the end coming is the reason
/// a capped turn ends mid-file.
///
/// Returns the index of the result the line was written on, if any.
///
/// # Arguments
/// * `msgs` - The SENT copy of the conversation, edited in place.
/// * `from` - Where this round's own messages begin: the length of the request just sent.  No
///   message before it is touched, because it is already in the provider's cache.
/// * `rounds_left` - Rounds the turn may still take, its remaining legs included.
/// * `usd_left` - Dollars left of the per-turn ceiling, or `None` where the provider reports no
///   cost at all -- in which case the ceiling is not enforced either, and a figure would be a
///   claim about money nobody quoted.
pub fn note_budget(msgs: &mut [ChatMessage], from: usize, rounds_left: usize,
					usd_left: Option<f64>, fraction_left: f64) -> Option<usize> {
	let i = last_result_from(msgs, from)?;	// a round with no result has nowhere to say this
	if fraction_left >= BUDGET_NOTE_UNDER {
		// Nothing near a limit, so nothing is said: the model cannot tell a near limit from a
		// distant one, and a mention of either reads as "stop now".
		return None;
	}
	let money = match usd_left {
		Some(usd) => fmt!(" and US${:.2}", usd.max(0.0)),
		None      => String::new(),
	};
	let line = fmt!("{}{} rounds{} left. When they are spent the turn ends, so use them on \
		the task]", BUDGET_NOTE_OPEN, rounds_left, money);
	msgs[i] = msgs[i].clone().noted_after(&line);
	Some(i)
}

/// The last tool result at or after `from`.
fn last_result_from(msgs: &[ChatMessage], from: usize) -> Option<usize> {
	(from..msgs.len()).rev().find(|&i| matches!(msgs[i], ChatMessage::Tool { .. }))
}

/// How the turn-state line opens (UNBLOCK-27 R3).  Its own marker: `[budget]` and `[turn budget: `
/// are taken, and [`note_budget`]'s strip must never find this one.
pub const STATE_NOTE_OPEN: &str = "\n[turn state: ";

/// Put the turn's state line on this round's last tool result, every round.
///
/// An earlier line is LEFT where it stood: each names its own round, so none goes stale, and
/// rewriting the previous round's result would re-price it out of the provider's prompt cache
/// every round.  In the result's stored `post` note, as [`note_budget`]'s line is, so the next
/// turn sends the same bytes (r578).  Returns the index written on, if any.
///
/// # Arguments
/// * `from` - Where this round's own messages begin; see [`note_budget`].
pub fn note_turn_state(msgs: &mut [ChatMessage], from: usize, line: &str) -> Option<usize> {
	let i = last_result_from(msgs, from)?;
	msgs[i] = msgs[i].clone().noted_after(&fmt!("{}{}]", STATE_NOTE_OPEN, line));
	Some(i)
}

/// The reconcile warning, byte for byte -- named so [`note_reconcile`], the tail-note dedupe
/// and `dev/verify_neverforget.mjs` cannot drift from three different spellings of the same
/// sentence. The bracket punctuation matches [`BUDGET_NOTE_OPEN`]'s own, deliberately: both are
/// the app speaking in its own voice inside a conversation otherwise made of the user's and the
/// model's, and one look should tell a reader which lines are which.
pub const RECONCILE_NOTE: &str =
	"[Daimond: this turn changed files but REQUIREMENTS.md and STATE.md were not updated; \
	 next turn, reconcile them first]";

/// Say, once, that a turn touched files without updating the never-forget file or where things
/// are -- see `dev/CRYSTAL_CONTRACT.md` §5.2 and [`RECONCILE_NOTE`] for the sentence.
///
/// **The same mechanism as [`note_budget`], read the other way round.** That function marks
/// the tail of the SENT copy so a per-round figure never doubles up within one turn; this marks
/// the tail of the RETURNED session so a warning that would recur every turn the daimon ignores
/// it is said once and then left alone -- pushed as a new `user` message rather than folded
/// into an existing one, because there is no tool call here to attach it to and a session
/// rehydrates from `user` and `assistant` roles only (see [`fold`]'s own note on that).
///
/// **Never twice in a row.** `prior_tail` is the message that stood at the end of the session
/// before this turn began -- the daimon's own last word, or the note this function itself left
/// last time. When it is already exactly [`RECONCILE_NOTE`], nothing is pushed: the daimon has
/// not had a turn to act on it yet, and repeating the same sentence at it is not more likely to
/// land the second time than the first. The turn after THAT, `prior_tail` is whatever the
/// daimon actually said, so the same condition holding again is said again -- it is not being
/// silenced, only never doubled.
///
/// Returns whether the note was pushed.
///
/// # Arguments
/// * `msgs` - The session as it will be returned to the browser, appended to in place.
/// * `prior_tail` - The last message of the session as it stood before this turn's user
///   instruction was appended, or `None` for a session with nothing in it yet.
pub fn note_reconcile(msgs: &mut Vec<ChatMessage>, prior_tail: Option<&ChatMessage>) -> bool {
	let said_last_turn = matches!(prior_tail, Some(ChatMessage::User { content, .. })
		if content.as_text() == RECONCILE_NOTE);
	if said_last_turn {
		return false;
	}
	msgs.push(ChatMessage::app(RECONCILE_NOTE.to_string()));
	true
}

/// The one line that stands in for a tool result, or `None` to leave the message alone.
///
/// `None` covers three cases and they are not the same: the message is not a tool reply at
/// all, it has already been retired, or it is short enough that a stub would cost more than
/// it saves.
fn result_stub(tc: &ToolCall, reply: &ChatMessage) -> Option<String> {
	let content = match reply {
		ChatMessage::Tool { content, .. } => content,
		_ => return None,
	};
	let text = content.as_text();
	if text.starts_with('[') && text.ends_with(RESULT_RETIRED_TAIL) {
		return None;	// already retired, and a count of a count grows
	}
	let imgs  = content.images().count();
	let bytes = content.text_len();
	// A reply already shorter than the stub would be is left alone; a picture is retired
	// whatever its caption weighs, because the bytes are not in the caption.
	if imgs == 0 && bytes <= RESULT_RETIRED_TAIL.len() + STUB_ARG_CAP {
		return None;
	}
	let gone = match imgs {
		0 => fmt!("{} bytes", bytes),
		1 => fmt!("{} bytes and 1 picture", bytes),
		n => fmt!("{} bytes and {} pictures", bytes, n),
	};
	// WHAT BECAME OF THE CALL IS PART OF THE LINE.  A retired refusal that read like a
	// retired result would leave the model believing a file was written that never was --
	// the same defect the fold's ledger is built to avoid, arriving by another route.
	let how = match call_outcome(&text) {
		CallOutcome::Done    => "",
		CallOutcome::Refused => ", refused",
		CallOutcome::Failed  => ", failed",
	};
	Some(fmt!("[{}{} — {} retired{}", call_label(tc), how, gone, RESULT_RETIRED_TAIL))
}

/// A call named the way a person reads it: the tool, then what it was called on.
///
/// The NAMING half of what [`record`] does; that function decides which of the ledger's
/// columns a call belongs in, which is a different question and stays there.
fn call_label(tc: &ToolCall) -> String {
	let arg = |k: &str| extract_json_string(&tc.arguments, k).unwrap_or_default();
	let num = |k: &str| extract_json_number(&tc.arguments, k);
	let path = arg("path");
	// CANONICALISED, whatever the wire spelled it. `run_tool_loop` already rewrites `tc.name`
	// in place the moment a round arrives, so this is normally a no-op -- but a label built
	// straight off a fixture, or off a call that reached here some other way, must read the
	// same either way: a Claude-family model's `Read` is `file_read` here just as it is
	// everywhere else that names a tool. See `Tool::from_name` for the alias table.
	let name = Tool::from_name(&tc.name).map(|t| t.name()).unwrap_or(tc.name.as_str());
	match name {
		"file_read" => {
			// The RANGE, where there was one: a retired read of lines 1-200 and a retired
			// read of the whole file are different facts, and the model is about to decide
			// whether to ask again.
			let from = num("offset").unwrap_or(1);
			let line = match (num("end"), num("limit")) {
				(Some(to), _)   => fmt!(" {}-{}", from, to),
				(None, Some(n)) => fmt!(" {}-{}", from, from + n.saturating_sub(1)),
				(None, None) if from > 1 => fmt!(" from {}", from),
				_ => String::new(),
			};
			fmt!("file_read {}{}", path, line)
		},
		"run" => {
			let argv = extract_json_string_array(&tc.arguments, "argv").unwrap_or_default();
			fmt!("run {}", clip(&argv.join(" "), STUB_ARG_CAP))
		},
		"shell"             => fmt!("shell {}", clip(&arg("command"), STUB_ARG_CAP)),
		"file_move"         => fmt!("file_move {} -> {}", path, arg("to")),
		"file_search"       => fmt!("file_search {} {}", clip(&arg("query"), STUB_ARG_CAP), path),
		// The path and the page, because a retired outline of a big file whose stub said only
		// "outline" is an outline the model asks for again.
		"outline"           => {
			let page = match num("offset") {
				Some(n) if n > 0 => fmt!(" from row {}", n),
				_                => String::new(),
			};
			fmt!("outline {}{}", path, page)
		},
		"serve"             => {
			let act = match arg("act").as_str() { "" => fmt!("list"), a => fmt!("{}", a) };
			let what = if !arg("id").is_empty() { arg("id") } else { path };
			fmt!("serve {} {}", act, what).trim_end().to_string()
		},
		// WHAT of the memory was fetched, because "crystal_read" alone is a stub the model
		// reads as "I have already looked" while not knowing which section it looked at.
		"crystal_read"      => {
			let what = if !arg("section").is_empty() { arg("section") } else { arg("key") };
			fmt!("crystal_read {}", what).trim_end().to_string()
		},
		"recall"            => fmt!("recall {}", clip(&arg("query"), STUB_ARG_CAP)),
		// EVERY OP, NAMED. A retired compound whose stub said only "compound" would tell the
		// model it had already looked and not say at what -- and a compound is by construction
		// the call that read several things, so that stub loses more than any other. The namer
		// is `crate::tools::compound_op_label`, the same one the result's own `--- [n]` headers
		// are built from, so what the stub says is what the model read.
		"compound" => {
			let ops = crate::llm::extract_json_objects(&tc.arguments, "ops").unwrap_or_default();
			if ops.is_empty() {
				fmt!("compound")
			} else {
				let said: Vec<String> = ops.iter()
					.map(|o| crate::tools::compound_op_label(o))
					.collect();
				fmt!("compound({})", clip(&said.join(", "), STUB_ARG_CAP * 2))
			}
		},
		"web_fetch" | "web_open" | "web_read"
		                    => fmt!("{} {}", name, clip(&arg("url"), STUB_ARG_CAP)),
		"spawn_agent"       => fmt!("spawn_agent {}", arg("name")),
		// The KEY, so a retired raise says which alert is up and the model can clear it.
		"pending_raise" | "pending_clear"
		                    => fmt!("{} {}", name, clip(&arg("key"), STUB_ARG_CAP)),
		// The workers a retired gather was waiting on, so the stub says WHOSE reports went.
		// The model can call `gather` again on the same names and re-read them at no cost, and a
		// stub naming nobody would leave it guessing which reports it had lost.
		"gather" => {
			let who = extract_json_string_array(&tc.arguments, "names").unwrap_or_default();
			if who.is_empty() {
				fmt!("gather")
			} else {
				fmt!("gather {}", clip(&who.join(", "), STUB_ARG_CAP))
			}
		},
		_ => {
			let what = if path.is_empty() { arg("url") } else { path };
			fmt!("{} {}", name, clip(&what, STUB_ARG_CAP)).trim().to_string()
		},
	}
}



// ┌───────────────────────────────────────────────────────────────┐
// │ The crystal fold's gate                                        │
// └───────────────────────────────────────────────────────────────┘
//
// A different fold from the rest of this module -- the reducer's, which folds one delta
// into a Diamond's memory rather than a conversation into a notice -- and it sits here
// because it is the same refusal.  [`fold`] will not hand back a conversation a provider
// would reject; this will not hand back a crystal nothing can read.  A fold is checked
// BEFORE it is offered, or the checking is left to a user who has already pressed accept.
//
// The check earns its place at the moment the crystal stopped being markdown.  Markdown
// has no parse failure, so anything the reducer said was a crystal and the only sensible
// gate was "is it empty".  JSON does have one, and the failure it admits is total: an
// accepted proposal REPLACES the file, so one stray sentence of preamble costs the user
// everything the Diamond remembered.  The prompt asks for bare JSON
// ([`crate::prompts::CRYSTAL_SCHEMA_NOTE`]); this is what happens when the model does not
// listen.

/// Greatest nesting the crystal check will descend to.
///
/// A crystal is an object of lists of small objects, so honest text reaches five or six
/// levels and never more.  The decoder's own default for text is 512, which is chosen so
/// that a 2 MiB native thread stack survives the worst case -- and this runs in a browser,
/// where the stack is a quarter of that.  Thirty-two levels is generous for the shape and
/// costs well under a tenth of what is there, so a crystal nested to provoke a crash is
/// refused with a sentence rather than taking the wasm module down.
const CRYSTAL_MAX_DEPTH: usize = 32;

/// Greatest proposal the crystal check will parse at all.
///
/// Far above [`crate::tools::CRYSTAL_CAP_DEFAULT`] on purpose: the cap is a judgement
/// about what a summary should weigh and belongs at the write, whereas this is only a
/// bound on how much text is worth handing a parser before refusing outright.  A proposal
/// this large has gone wrong in some way the cap will also catch.
const CRYSTAL_MAX_BYTES: usize = 1024 * 1024;

/// The reducer's raw output as a crystal, or the reason it is not one.
///
/// Three refusals, in the order they cost the user.  An EMPTY proposal is nothing to fold
/// in.  One that is not a single whole object -- truncated, or trailing prose, or a bare
/// list -- carries no crystal keys the app, the page or the next reducer could name; and
/// the next reducer matters most, because it is handed the crystal as its input and would
/// fold the following delta into wreckage.  One that is shaped right and still will not
/// parse is the same loss arriving a step later.
///
/// **Two checks and not one, and the structural one is not the belt.**  The daticle
/// decoder is what says whether the text is JSON, but its text form is forgiving where a
/// browser is not: a map whose input simply stops is returned as a map of what arrived, so
/// `{"title": "half` decodes happily here and is refused by `JSON.parse` -- and a reply cut
/// at the model's output limit is the commonest way a fold goes wrong.  It also stops
/// reading at the close, so a second object after the first is neither read nor complained
/// about.  [`one_whole_object`] answers exactly the question the decoder does not: one
/// object, opened at the first byte and closed at the last.
///
/// What comes back is the model's OWN text, unfenced and trimmed, never a re-encoding of
/// what was parsed.  Re-encoding would sort the keys and normalise the numbers, and the
/// contract turns on carrying a key through exactly as it arrived -- including one this
/// build has never heard of.  The parse is a question asked of the text, not a stage the
/// text passes through.
///
/// # Arguments
/// * `raw` - Everything the reducer emitted, exactly as it emitted it.
pub fn crystal_proposal(raw: &str) -> Outcome<String> {
	let text = unfence(raw);
	if text.is_empty() {
		return Err(err!(
			"The reducer returned an empty proposal, so there is nothing to fold in. A fold \
			 never empties a crystal; try again, or steer the Diamond instead.";
			Invalid, Data));
	}
	if !one_whole_object(text) {
		return Err(err!(
			"The reducer's proposal is not one whole JSON object, so accepting it would \
			 replace this Diamond's crystal with something nothing can read. A crystal opens \
			 with a brace and closes with the matching one, and carries nothing on either \
			 side of it.";
			Invalid, Data));
	}
	let cfg = json_cfg();
	let dat = match Dat::decode_string_with_config(text, &cfg) {
		Ok(d)  => d,
		Err(e) => return Err(err!(e,
			"The reducer's proposal is not JSON, so accepting it would replace this \
			 Diamond's crystal with text nothing can read.";
			Invalid, Data)),
	};
	match dat {
		Dat::Map(_) | Dat::OrdMap(_) => Ok(text.to_string()),
		// Unreachable through the check above, and kept because it is the assertion that
		// makes the check above load-bearing rather than decorative.
		_ => Err(err!(
			"The reducer's proposal is JSON but not an object, so it carries no crystal keys \
			 at all. A crystal is one object: title, summary, sections, facts, open, links.";
			Invalid, Data)),
	}
}

/// The four documents a crystal fold now returns: the crystal, and whichever files it rewrote.
///
/// A `None` file is one the reducer said nothing about, and it is left exactly as it is.  So is
/// one it opened a heading for and wrote nothing under -- see [`fold_proposal`].
#[derive(Debug, Clone, Default, PartialEq)]
pub struct FoldProposal {
	pub crystal:      String,
	pub requirements: Option<String>,
	pub decisions:    Option<String>,
	pub state:        Option<String>,
}

/// Which of the three files a heading line names, or nothing.
///
/// `## REQUIREMENTS.md`, `# REQUIREMENTS.md`, `**REQUIREMENTS.md**` and a backticked spelling
/// are all accepted, for the reason [`fold_heading`] accepts three markups: a model told "under
/// the headings you are given" picks its own, and the block is worth more than the punctuation.
fn standing_heading(line: &str) -> Option<&'static str> {
	let t = line.trim();
	if t.is_empty() {
		return None;
	}
	let t = t.trim_start_matches('#').trim();
	let t = t.trim_matches('*').trim();
	let t = t.trim_matches('`').trim();
	crate::tools::STANDING_FILES.iter().copied()
		.find(|leaf| t.eq_ignore_ascii_case(leaf))
}

/// The reducer's raw output as a crystal and up to three markdown files.
///
/// **THE CRYSTAL IS EVERYTHING BEFORE THE FIRST FILE HEADING**, and it goes through
/// [`crystal_proposal`] exactly as it did when that was the whole reply -- so every refusal that
/// already stood stands here: empty, not one whole object, not JSON.  A reply with no file
/// heading in it at all is therefore the old reply, parsed the old way, and answers with three
/// `None`s.
///
/// **Headings and not JSON**, for the compliance reason set out on [`FoldNotes`] and in
/// `dev/CRYSTAL_CONTRACT.md` §13: a model asked for a long document with nested strings truncates
/// at its output cap, and a truncated JSON document loses everything while a truncated heading
/// document keeps every block that arrived.
///
/// **An EMPTY block leaves its file alone**, exactly as a missing one does.  A heading with
/// nothing under it is a model that started a block and stopped, and a fold never empties a file
/// -- which is the same rule [`crystal_proposal`] applies to an empty crystal, at a second door.
/// The alternative, refusing the whole fold for it, would throw away a good crystal over a blank
/// heading.
///
/// # Arguments
/// * `raw` - Everything the reducer emitted, exactly as it emitted it.
pub fn fold_proposal(raw: &str) -> Outcome<FoldProposal> {
	let lines: Vec<&str> = raw.lines().collect();
	// Where each block begins, in the order they arrived; a file named twice keeps the LAST,
	// which is what a model correcting itself mid-reply means by it.
	let mut marks: Vec<(usize, &'static str)> = Vec::new();
	for (i, line) in lines.iter().enumerate() {
		if let Some(leaf) = standing_heading(line) {
			marks.push((i, leaf));
		}
	}
	let head_end = marks.first().map(|(i, _)| *i).unwrap_or(lines.len());
	let mut out = FoldProposal {
		crystal: res!(crystal_proposal(&lines[..head_end].join("\n"))),
		..Default::default()
	};
	for (n, (at, leaf)) in marks.iter().enumerate() {
		let end = marks.get(n + 1).map(|(i, _)| *i).unwrap_or(lines.len());
		let block = lines[at + 1..end].join("\n");
		let body  = unfence(&block);
		if body.trim().is_empty() {
			continue;
		}
		// Every file ends with a newline on disk, and a model's block does not.
		let text = fmt!("{}\n", body.trim_end());
		match *leaf {
			crate::tools::REQUIREMENTS_FILE => out.requirements = Some(text),
			crate::tools::DECISIONS_FILE    => out.decisions    = Some(text),
			crate::tools::STATE_FILE        => out.state        = Some(text),
			_                               => {},
		}
	}
	Ok(out)
}

/// Ticked task lines that are in `old` and not in `new`.
///
/// **A TICK IS THE ONE THING IN THE NEVER-FORGET FILE THAT CANNOT BE RE-DERIVED.**  It says a
/// piece of work was VERIFIED, and it carries the version that did it; a reducer rewriting the
/// whole file from one delta has no way to know either fact, so a tick it drops is a claim about
/// the past that nothing downstream can put back.  An OPEN task it drops is a different matter
/// and is not reported: closing work is what a fold is for, and a task struck out by the user is
/// exactly how the file is meant to shrink.
///
/// Compared on what a line SAYS, through the same key [`crate::tools::absorb_notes`] dedupes on,
/// so a reducer that re-words the version stamp or renumbers an id has not "lost" anything.
///
/// # Arguments
/// * `old` - `REQUIREMENTS.md` as it stands on disk.
/// * `new` - The block the reducer proposed for it.
pub fn ticked_lost(old: &str, new: &str) -> Vec<String> {
	let ticked = |text: &str| -> Vec<String> {
		text.lines().filter(|l| {
			let t = l.trim().trim_start_matches("- ").trim_start_matches("* ").trim();
			t.starts_with("[x]") || t.starts_with("[X]")
		}).map(|l| l.trim().to_string()).collect()
	};
	let keys: Vec<String> = ticked(new).iter().map(|l| crate::tools::task_key(l)).collect();
	ticked(old).into_iter()
		.filter(|l| !keys.contains(&crate::tools::task_key(l)))
		.collect()
}

/// Decision lines that are in `old` and not in `new`.
///
/// `DECISIONS.md` is APPEND-ONLY, so every line of it is protected and not merely the ticked
/// ones: a dated ruling with its reason is a record of a moment, and a model rewriting the file
/// has nothing to replace a deleted one with.  Headings and blank lines are not records and are
/// not counted.
///
/// # Arguments
/// * `old` - `DECISIONS.md` as it stands on disk.
/// * `new` - The block the reducer proposed for it.
pub fn decisions_lost(old: &str, new: &str) -> Vec<String> {
	let records = |text: &str| -> Vec<String> {
		text.lines()
			.filter(|l| !l.trim().is_empty() && !l.trim_start().starts_with('#'))
			.map(|l| l.trim().to_string())
			.collect()
	};
	let keys: Vec<String> = records(new).iter().map(|l| crate::tools::decision_key(l)).collect();
	records(old).into_iter()
		.filter(|l| !keys.contains(&crate::tools::decision_key(l)))
		.collect()
}

/// Everything a proposal would destroy, named in the words a reducer can act on.
///
/// Empty when it destroys nothing, which is the ordinary fold.  The four tests are the four
/// things no later turn can recover: a populated top-level crystal key, EVERY hot flag, a ticked
/// task, a decision line.  See `dev/CRYSTAL_CONTRACT.md` §13 for why each is a refusal now and
/// was a console warning before -- one click commits, so there is no moment at which a person
/// reads a warning.
///
/// # Arguments
/// * `old_crystal` - The crystal as it stands on disk.
/// * `files` - The three files as they stand on disk.
/// * `proposal` - What the reducer returned, as [`fold_proposal`] parsed it.
pub fn fold_losses(
	old_crystal: &str,
	files:       &crate::tools::Standing,
	proposal:    &FoldProposal,
)
	-> Vec<String>
{
	let mut lost = Vec::new();
	for key in crystal_keys_lost(old_crystal, &proposal.crystal) {
		lost.push(fmt!("the crystal's `{}` key, which carried something", key));
	}
	// ALL of them, never one. A fold that legitimately makes a single section cold is ordinary
	// work, and a refusal that fired on it would be one nothing could satisfy.
	let cold = hot_flags_lost(old_crystal, &proposal.crystal);
	if !cold.is_empty() && hot_of_count(&proposal.crystal) == 0 {
		lost.push(fmt!(
			"every `\"hot\": true` flag in the crystal ({}), which is what decides what is in \
			the prompt on every round", cold.join(", ")));
	}
	if let Some(req) = &proposal.requirements {
		for line in ticked_lost(&files.requirements, req) {
			lost.push(fmt!("a TICKED task from {}: {}", crate::tools::REQUIREMENTS_FILE, line));
		}
	}
	if let Some(dec) = &proposal.decisions {
		for line in decisions_lost(&files.decisions, dec) {
			lost.push(fmt!("a line of {}, which is append-only: {}",
				crate::tools::DECISIONS_FILE, line));
		}
	}
	lost
}

/// Everything a fold will write, settled before the first byte is.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct FoldLanding {
	pub crystal: String,                          // as it lands, demoted where it had to be
	pub files:   Vec<(&'static str, String)>,     // leaf, text after retirement
	pub retired: Vec<(&'static str, String)>,     // leaf, lines for its archive
	pub moved:   Vec<String>,                     // headings moved to cold
}

/// What a fold would leave on disk, or the refusal sentence -- asked of the NEW files.
///
/// **ALL OR NOTHING** (D-20261010-01).  A fold writes up to four documents, and the crystal's hot
/// ceiling counts the three files inside it.  Checked one write at a time, the files landed and
/// the crystal was then refused against their new weight: three rewritten files with no version,
/// no log row and no undo.  So every ceiling is asked here, of the state the whole fold would
/// leave, and the store writes only a landing this returned.
///
/// **THE HOT CEILING IS NOT A DEAD END.**  The round has been paid for and no daimon is there to
/// write again, so the largest hot sections go cold until the crystal fits -- the move the file
/// tools make on a second refusal.  Only what no move can fix (an over-long summary, a file over
/// its ceiling after retirement, the total) is refused, and the reducer's retry is told the room.
///
/// # Arguments
/// * `id` - The Diamond, for the archive a refusal names.
/// * `old_crystal` - The crystal as it stands on disk.
/// * `last_good` - As for [`crate::tools::crystal_hot_refusal`], so the fold door measures a
///   mend the way the other two do.
/// * `files` - The three files as they stand on disk.
/// * `want` - The proposal.
/// * `today` - `YYYY-MM-DD`, for the dated line a `STATE.md` retirement writes into
///   `DECISIONS.md` (UNBLOCK-18): `STATE.md` is never refused, it retires by section.
pub fn fold_landing(
	id:          &str,
	old_crystal: &str,
	last_good:   &str,
	files:       &crate::tools::Standing,
	want:        &FoldProposal,
	today:       &str,
)
	-> std::result::Result<FoldLanding, String>
{
	use crate::tools::{DECISIONS_FILE, REQUIREMENTS_FILE, STATE_FILE};
	let mut land = FoldLanding::default();
	let mut after = files.clone();
	// `STATE.md` first, because what it retires is noted in `DECISIONS.md`.  A fold keeps no
	// touched record, so its sections age by their place in the file.
	let mut decisions = want.decisions.clone();
	let state = want.state.as_ref().map(|t| crate::state_md::land(
		&files.state, t, &std::collections::BTreeMap::new(), 0, today));
	if let Some(l) = &state {
		if !l.noted.is_empty() {
			let mut d = decisions.clone().unwrap_or_else(|| files.decisions.clone());
			if !d.is_empty() && !d.ends_with('\n') {
				d.push('\n');
			}
			for line in l.noted.iter() {
				d.push_str(line);
				d.push('\n');
			}
			decisions = Some(d);
		}
	}
	let state_kept = state.as_ref().map(|l| l.kept.clone());
	for (leaf, text, old) in [
		(REQUIREMENTS_FILE, &want.requirements, &files.requirements),
		(DECISIONS_FILE,    &decisions,         &files.decisions),
		(STATE_FILE,        &state_kept,        &files.state),
	] {
		let text = match text {
			Some(t) => t,
			None    => continue,
		};
		let out = match (leaf, &state) {
			(STATE_FILE, Some(l)) => crate::tools::Retired {
				kept: l.kept.clone(), retired: l.archived.clone() },
			_ => crate::tools::standing_retire(leaf, text),
		};
		if crate::tools::standing_refused(leaf, out.kept.len(), old.len()) {
			return Err(crate::tools::standing_cap_message(leaf, out.kept.len(), id));
		}
		match leaf {
			REQUIREMENTS_FILE => after.requirements = out.kept.clone(),
			DECISIONS_FILE    => after.decisions    = out.kept.clone(),
			_                 => after.state        = out.kept.clone(),
		}
		if !out.retired.is_empty() {
			land.retired.push((leaf, out.retired));
		}
		land.files.push((leaf, out.kept));
	}
	let hot = after.hot_bytes();
	let mut crystal = want.crystal.clone();
	if let Some(msg) = crate::tools::crystal_hot_refusal(&crystal, old_crystal, last_good, hot) {
		match crate::tools::crystal_demote_to_fit(&crystal, crate::tools::crystal_hot_room(hot)) {
			Some((text, moved)) => {
				crystal   = text;
				land.moved = moved;
			},
			None => return Err(msg),
		}
		if let Some(msg) = crate::tools::crystal_hot_refusal(&crystal, old_crystal, last_good, hot) {
			return Err(msg);
		}
	}
	if crate::tools::crystal_write_refused(crystal.len(), old_crystal.len()) {
		return Err(crate::tools::crystal_cap_message(crystal.len()));
	}
	land.crystal = crystal;
	Ok(land)
}

/// What the reducer's second round is told when its first answer would not land.
///
/// # Arguments
/// * `why` - The refusal [`fold_landing`] gave.
/// * `room` - The bytes the always-present part may weigh beside the files.
pub fn fold_room_note(why: &str, room: usize) -> String {
	fmt!(
		"\n\n---\nYour last answer could not be stored, and it was not accepted:\n\n{}\n\n\
		Write the whole answer again so that it fits. The always-present part of the crystal -- \
		title, summary and every hot section -- has room for {} bytes beside the three files. \
		Shorten the summary to what someone needs first, and put detail in a cold section.",
		why, room)
}

/// How many sections a crystal flags hot, or 0 where it will not parse.
fn hot_of_count(text: &str) -> usize {
	let cfg = json_cfg();
	let map = match Dat::decode_string_with_config(unfence(text), &cfg) {
		Ok(Dat::Map(m)) => m,
		_               => return 0,
	};
	let secs = match map.get(&Dat::Str(fmt!("sections"))) {
		Some(Dat::List(v)) => v.clone(),
		_                  => return 0,
	};
	secs.iter().filter(|sec| match sec {
		Dat::Map(m) => matches!(m.get(&Dat::Str(fmt!("hot"))), Some(Dat::Bool(true))),
		_           => false,
	}).count()
}

/// How a crystal is read, wherever it is read: strictly, as JSON, and bounded.
///
/// One function so that every question asked of a crystal -- here, and at the hot/cold split in
/// [`crate::tools::crystal_split`] -- cannot come to disagree about what a crystal is.  The decoder's JSON configuration rather than its own
/// -- no comments and no trailing comma -- because being laxer here than the browser is the
/// one thing this must not be: a proposal Rust waves through and `JSON.parse` then rejects
/// is a crystal the user accepted and cannot open, which is worse than a refusal, since a
/// refusal at least leaves the old crystal standing.
///
/// `use_ordmaps` stays off, as it is by default, so a decoded object is always a
/// [`Dat::Map`] and never a [`Dat::OrdMap`].
pub(crate) fn json_cfg()
	-> DecoderConfig<BTreeMap<UsrKindCode, UsrKind>, BTreeMap<String, UsrKindId>>
{
	DecoderConfig::json(None)
		.with_limits(DecodeLimits::new(CRYSTAL_MAX_DEPTH, CRYSTAL_MAX_BYTES))
}

/// Top-level keys that carried something in `old` and are simply not in `new`.
///
/// The rule the whole crystal design turns on is that nothing may ever drop a key it does
/// not recognise, and the fold is the one place that rule can be broken wholesale: an
/// accepted proposal REPLACES the file, on a single click, by a user who is being invited
/// to click.  No parse check can catch it, because a crystal that has lost half its keys is
/// as valid a document as one that has not -- `{}` itself is legal, since every core key is
/// optional.  Only the crystal it replaces knows what went.
///
/// So this is not a refusal and must not become one.  A key may leave for good reasons: the
/// user asked for it to go, or the delta superseded the only thing it held.  What it must
/// not do is leave WITHOUT ANYONE SEEING, which is the Home Assistant failure the schema
/// exists to prevent, and a form editor at least knows which fields it understands.  The
/// answer is handed back as the keys themselves rather than as a sentence, so the app can
/// put them in front of the user in the user's own language and let them decide.
///
/// **Absence only.**  A key emptied in place -- `open` going from three threads to none --
/// is not reported, because closing the last open thread is exactly what a good fold does
/// and flagging it would train the user to wave the warning through. That is the known
/// limitation: an unknown key emptied rather than removed passes unremarked.
///
/// Silent, deliberately, where it cannot be sure: either text failing to parse, or either
/// one not being an object, yields nothing rather than a claim.  A crystal still in its
/// legacy markdown is the ordinary case of that, and the migration owns it -- reporting
/// every key in the world as lost there would be noise at exactly the moment the user is
/// least able to judge it.
///
/// The keys come back in the decoder's own order, which is alphabetical rather than the
/// order they sit in the file.  Nothing is re-encoded and no crystal text is produced here:
/// this reads two documents and names a difference between them.
///
/// # Arguments
/// * `old` - The crystal as it stands, from disk.
/// * `new` - The proposal, as [`crystal_proposal`] returned it.
pub fn crystal_keys_lost(old: &str, new: &str) -> Vec<String> {
	let cfg = json_cfg();
	let (before, after) = match (
		Dat::decode_string_with_config(unfence(old), &cfg),
		Dat::decode_string_with_config(unfence(new), &cfg),
	) {
		(Ok(b), Ok(a)) => (b, a),
		_              => return Vec::new(),
	};
	let (before, after) = match (before, after) {
		(Dat::Map(b), Dat::Map(a)) => (b, a),
		_                          => return Vec::new(),
	};
	let mut lost = Vec::new();
	for (key, val) in &before {
		let name = match key {
			Dat::Str(s) => s,
			// A crystal's keys are strings. Anything else is not a key a page or a form
			// could name, so there is nothing to tell the user about it.
			_ => continue,
		};
		if !carries_content(val) {
			continue;
		}
		if !after.contains_key(key) {
			lost.push(name.clone());
		}
	}
	lost
}

/// Headings that carried `"hot": true` in `old` and do not in `new`.
///
/// **The reducer is the one thing that rewrites every section at once**, and a hot flag is six
/// bytes of a key it has never been told about -- exactly the shape of key the schema note
/// spends a paragraph telling it not to drop.  A crystal that came back with every flag gone
/// would compose as title-and-summary on the next round, the daimon would not know why, and the
/// only tell would be a system message that quietly got shorter.  So the flags are counted the
/// way keys are, and the answer goes in front of the user with the proposal.
///
/// Silent where either text will not parse or is not an object, as [`crystal_keys_lost`] is and
/// for the same reason: a claim nothing can check is worse than no claim.
///
/// # Arguments
/// * `old` - The crystal as it stands, from disk.
/// * `new` - The proposal.
pub fn hot_flags_lost(old: &str, new: &str) -> Vec<String> {
	// `None` where the text is not one JSON object, so that a crystal still in its legacy
	// markdown -- or a proposal that arrived damaged -- yields NOTHING rather than reporting
	// every flag in the world as lost.  The same silence, and the same reason, as
	// [`crystal_keys_lost`]'s.
	let hot_of = |text: &str| -> Option<Vec<String>> {
		let cfg = json_cfg();
		let map = match Dat::decode_string_with_config(unfence(text), &cfg) {
			Ok(Dat::Map(m)) => m,
			_               => return None,
		};
		let secs = match map.get(&Dat::Str(fmt!("sections"))) {
			Some(Dat::List(v)) => v.clone(),
			_                  => return Some(Vec::new()),
		};
		let mut out = Vec::new();
		for sec in &secs {
			let m = match sec {
				Dat::Map(m) => m,
				_           => continue,
			};
			if !matches!(m.get(&Dat::Str(fmt!("hot"))), Some(Dat::Bool(true))) {
				continue;
			}
			match m.get(&Dat::Str(fmt!("heading"))) {
				Some(Dat::Str(h)) => out.push(h.clone()),
				_                 => out.push(fmt!("(no heading)")),
			}
		}
		Some(out)
	};
	match (hot_of(old), hot_of(new)) {
		(Some(before), Some(after)) =>
			before.into_iter().filter(|h| !after.contains(h)).collect(),
		_ => Vec::new(),
	}
}

/// Whether a value holds anything a user would miss.
///
/// The point is not tidiness, it is noise: a crystal often carries a key standing empty --
/// `open` with no threads left, a `summary` not yet written -- and reporting one of those as
/// lost when the reducer drops it would be a warning about nothing, which is how a warning
/// stops being read.  Anything this build does not recognise counts as content, because the
/// keys most worth protecting are exactly the ones it has never heard of.
///
/// # Arguments
/// * `d` - A top-level value from a crystal.
fn carries_content(d: &Dat) -> bool {
	match d {
		Dat::Empty   => false,
		Dat::Str(s)  => !s.trim().is_empty(),
		Dat::List(v) => !v.is_empty(),
		Dat::Map(m)  => !m.is_empty(),
		// JSON `null`, which the decoder reads as an absent option.
		Dat::Opt(o)  => matches!(**o, Some(_)),
		_            => true,
	}
}

/// Whether `s` is one JSON object and nothing else: it opens with `{`, every brace, bracket
/// and quote closes, and the closing brace is the last byte.
///
/// A near relation of [`crate::agent::json_object_is_whole`] and deliberately not a call to
/// it, because the two answer different questions.  That one asks whether a tool call's
/// arguments arrived whole and is right to ignore whatever follows the close -- a provider
/// may append anything and the call is still dispatchable.  A crystal is a FILE: text after
/// the close is written into it and makes it unreadable, so "and nothing else" is half of
/// what is being asked here.
///
/// String contents are skipped, so a brace inside a body of markdown is not counted as
/// structure, and a string the reply stopped inside runs to the end of the input and is
/// reported as the truncation it is.
///
/// # Arguments
/// * `s` - The proposal, already unfenced and trimmed.
fn one_whole_object(s: &str) -> bool {
	let b = s.as_bytes();
	if b.first() != Some(&b'{') {
		return false;
	}
	let mut depth = 0i32;
	let mut i     = 0usize;
	// The last byte that mattered, outside any string.  It is here for one job: a comma
	// immediately before a closer.  `DecoderConfig::json` tolerates a trailing comma and
	// `JSON.parse` refuses one, and being laxer than the browser that reads the file is the
	// one thing this gate must never be -- a crystal accepted here and refused there is
	// written to disk and then unreadable, which is worse than a fold that was never offered.
	let mut last  = 0u8;
	while i < b.len() {
		match b[i] {
			b'{' | b'[' => depth += 1,
			b'}' | b']' => {
				if last == b',' {
					return false;
				}
				depth -= 1;
				if depth == 0 {
					return i + 1 == b.len();
				}
				if depth < 0 {
					return false;
				}
			},
			b'"' => {
				i += 1;
				while i < b.len() {
					if b[i] == b'\\' {
						i += 2;
						continue;
					}
					if b[i] == b'"' {
						break;
					}
					i += 1;
				}
				if i >= b.len() {
					// The reply stopped inside a string.
					return false;
				}
			},
			_ => {},
		}
		// Whitespace between a comma and its closer must not hide the comma, so it is the
		// last SIGNIFICANT byte that is remembered.  After a string the cursor sits on the
		// closing quote, which is significant and is what lands here.
		if !b[i].is_ascii_whitespace() {
			last = b[i];
		}
		i += 1;
	}
	false
}

/// `raw` trimmed, with one markdown code fence taken off it if it is wearing one.
///
/// Told and stripped both, deliberately.  A prompt is a request, and this is the request a
/// model ignores most reliably; the cost of losing it here is the whole crystal, so the
/// cheap defence is taken as well as asked for.
///
/// It strips a fence the text OPENS with, and nothing else.  Prose wrapped around the
/// object is a reducer that has ignored a plain instruction, and digging the JSON out of it
/// would make that invisible -- the fold would quietly work, the prompt would stay
/// unheeded, and nobody would learn.  A fence is different: it is punctuation the model
/// adds without meaning anything by it.
///
/// # Arguments
/// * `raw` - Everything the reducer emitted.
fn unfence(raw: &str) -> &str {
	let t = raw.trim();
	if !t.starts_with("```") {
		return t;
	}
	// The opening line carries the fence and whatever language tag rides on it, and a fence
	// with no newline after it is a fence and nothing else.
	let body = match t.find('\n') {
		Some(i) => t[i + 1..].trim_end(),
		None    => return "",
	};
	match body.strip_suffix("```") {
		Some(b) => b.trim(),
		None    => body.trim(),
	}
}


// ┌───────────────────────────────────────────────────────────────┐
// │ Recognising the failure                                        │
// └───────────────────────────────────────────────────────────────┘

/// Should the conversation be folded before this round goes out?
///
/// A fold the caller forces always happens.  Otherwise it is size, read TWO ways against the
/// same budget: the byte estimate the gauge can compute up front, and the provider's real
/// `prompt_tokens` from the last round.  The estimate UNDER-counts -- the ratio is an average
/// and a growing tool log tokenises dearer than prose -- so a turn can sit under the estimated
/// budget while the real prompt already passed it, which is the case the absolute cap in
/// [`Limits::budget`] exists to catch and which the estimate alone would miss until a refusal.
/// Either figure over the budget folds, so the cap is enforced against what the provider
/// actually charged and not only what this app guessed.
///
/// # Arguments
/// * `est_tokens` - The gauge's byte-based estimate of the prompt about to be sent.
/// * `real_tokens` - The provider's `prompt_tokens` from the last round, or 0 if none yet.
/// * `budget` - The largest prompt this turn should send; see [`Limits::budget`].
/// * `forced` - Whether the caller has asked for a fold regardless of size.
pub fn needs_fold(est_tokens: u64, real_tokens: u64, budget: u64, forced: bool) -> bool {
	forced || est_tokens > budget || real_tokens > budget
}

/// Whether a failed round looks like the context window being exceeded.
///
/// Two ways of telling, and the first is now the ordinary one.  The provider's own words
/// are decisive, and BOTH transports carry them: the native one always did, and the
/// browser one does since `LlmClient::body_detail` -- until then it could report no more
/// than `LLM: HTTP error: 400 Bad Request.`, and the size test below was the only thing
/// standing between a browser chat and permanent death by overflow.
///
/// The size test is therefore a FALLBACK rather than the browser's whole answer.  It
/// still earns its place: a provider can refuse with an empty body, a CDN can answer 413
/// with an HTML page of its own that says nothing about tokens, and a body can fail to
/// read at all.  In each of those the status plus a prompt big enough to explain it is
/// all there is.  Both halves are needed even then -- acting on the status alone would
/// fold the conversation every time a key was mistyped.
///
/// THE STATUS IS READ FROM THE TAGS, NEVER FROM THE TEXT.  The transport marks a 413, or a
/// refusal whose words say size, `TooBig`, and a bare 400 or 422 `Size`, where the status is
/// still in hand (`TransportErr::crossed`).  Digits in
/// the prose were read instead until r541: a source line "llm.rs:1400" and a stall "in 400
/// s" both passed for a refusal, folded the conversation and learnt the window down for
/// the rest of the session.  And a `Timeout` is never an overflow, whatever it says: a
/// model that did not answer did not refuse the prompt's size.
///
/// # Arguments
/// * `e` - The error from the failed call.
/// * `prompt_tokens` - The estimated size of the prompt that was refused.
/// * `budget` - The turn's token budget.
pub fn looks_like_overflow(e: &Error<ErrTag>, prompt_tokens: u64, budget: u64) -> bool {
	let tags = e.tags();
	if tags.contains(&ErrTag::Timeout) {
		return false;
	}
	if says_overflow(&fmt!("{}", e)) {
		return true;
	}
	// The fallback: no words that say so, so the status and the size are all there is.  The
	// transport tags a 413 `TooBig` and a bare 400 or 422 `Size` (size MAY be why).
	(tags.contains(&ErrTag::TooBig) || tags.contains(&ErrTag::Size))
		&& prompt_tokens >= OVERFLOW_FLOOR_TOKENS.min(budget / 2)
}

/// Do the provider's own words say the request was too big -- for the context window, or for
/// the wire -- whatever size the prompt was thought to be?
///
/// The decisive half of [`looks_like_overflow`], on its own for the one caller that has no size
/// to weigh: the transport, which turns these words into the `TooBig` tag where the refusal
/// leaves it, so that nothing downstream reads them again.
pub fn says_overflow(err: &str) -> bool {
	let low = err.to_lowercase();
	[
		"context length",
		"context_length",
		"maximum context",
		"context window",
		"too many tokens",
		"prompt is too long",
		"reduce the length",
		"input length",
		"request too large",
		"payload too large",
	].iter().any(|m| low.contains(m))
}


// ┌───────────────────────────────────────────────────────────────┐
// │ The prompt the fold runs under                                 │
// └───────────────────────────────────────────────────────────────┘
//
// It lives in `crate::prompts` as [`crate::prompts::Role::Compactor`], not here.  A prompt
// held as a private constant beside the code that sends it is a prompt the user cannot
// read, and this was the last one in the app: as a `Role` it is backed by
// `prompts/compactor.md` like every other, so it can be read, edited and put back by
// deleting the file.  [`crate::agent::Agent::fold_prompt`] composes it.


// ┌───────────────────────────────────────────────────────────────┐
// │ Tests                                                          │
// └───────────────────────────────────────────────────────────────┘

#[cfg(test)]
#[path = "../tests/unit/compact/tests.rs"]
mod tests;
