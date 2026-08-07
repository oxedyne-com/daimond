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
//!   read, which were written, which commands ran, and -- separately -- which of those
//!   FAILED.  This is arithmetic, not judgement: no model is asked, so none can lose it or
//!   invent it.  A fold that drops which files were written leaves the model claiming work
//!   it can no longer verify, which is worse than the overflow it was avoiding.
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

use crate::llm::{extract_json_string, extract_json_string_array};
use crate::protocol::{ChatMessage, ImagePart, MessageContent, ToolCall};

use oxedyne_fe2o3_core::prelude::*;

use std::cell::Cell;


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

/// What window to assume when nobody has said what the model's is.
///
/// The smallest window in Daimond's own price table, so assuming it is the assumption that
/// fails safe: on a bigger model the conversation is folded earlier than it needed to be,
/// which costs one summary; on a smaller one the reactive path in the agent still catches
/// the refusal.
pub const DEFAULT_WINDOW: u64 = 131_072;

/// Fraction of the window at which a conversation is folded.
pub const FOLD_AT: f64 = 0.8;

/// Fraction of the budget kept verbatim at the end of the conversation.
///
/// The recent exchanges are the ones that must survive intact: a model that has just been
/// told the answer, or has just read the file it is editing, must not find that summarised
/// away.  Two fifths of the budget is several full rounds of tool calls at typical sizes.
pub const KEEP: f64 = 0.4;

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
pub const FOLD_MAX_TOKENS: u32 = 1_400;


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
	/// Fraction of the budget kept verbatim at the end.
	pub keep:       f64,
	/// Model to fold with; empty means the chat's own.
	pub fold_model: String,
}

impl Default for Limits {
	fn default() -> Self {
		Self {
			max_rounds: DEFAULT_MAX_ROUNDS,
			window:     0,
			fold_at:    FOLD_AT,
			keep:       KEEP,
			fold_model: String::new(),
		}
	}
}

impl Limits {

	/// The largest prompt this turn should send, in tokens.
	///
	/// Two ceilings, and the lower wins.  The first is the fraction of the window a fold is
	/// meant to trigger at.  The second is what is left of the window once the reply the
	/// model is allowed to generate has been subtracted -- on a small window the reply is
	/// the bigger share, and a budget that ignored it would leave the prompt legal and the
	/// call still refused.
	///
	/// # Arguments
	/// * `max_completion` - The cap the client puts on generated tokens.
	pub fn budget(&self, max_completion: u32) -> u64 {
		let w = if self.window == 0 { DEFAULT_WINDOW } else { self.window };
		let by_fraction = (w as f64 * self.fold_at.clamp(0.1, 0.95)) as u64;
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
pub fn msg_bytes(m: &ChatMessage) -> u64 {
	// The JSON around every message: the role, the two keys, the braces and the commas.
	let mut n = m.content().text_len() as u64 + 32;
	for img in m.content().images() {
		n += image_bytes(img);
	}
	match m {
		ChatMessage::Assistant { tool_calls, .. } => {
			for tc in tool_calls {
				n += (tc.id.len() + tc.name.len() + tc.arguments.len()) as u64 + 64;
			}
		},
		ChatMessage::Tool { tool_call_id, .. } => n += tool_call_id.len() as u64,
		_ => {},
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

/// Whether every tool call is answered and every tool reply was asked for.
pub fn pairing_is_whole(msgs: &[ChatMessage]) -> bool {
	orphan_count(msgs) == 0
}


// ┌───────────────────────────────────────────────────────────────┐
// │ Choosing the cut                                               │
// └───────────────────────────────────────────────────────────────┘

/// Where the verbatim tail begins: the index of the first message to keep.
///
/// Walks back from the end taking messages until `keep_bytes` is spent, then walks back
/// further over any tool replies, because a reply may never be the first kept message: its
/// call would have been folded away and the provider would reject the whole request.  That
/// backward step keeps a WHOLE block rather than dropping the rest of it, so a fold errs
/// towards keeping too much, never towards keeping something unanswerable.
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
	// A tool reply cannot open the kept tail; step back to the assistant turn that asked
	// for it, taking the rest of its block along.
	while i > 0 && matches!(msgs[i], ChatMessage::Tool { .. }) {
		i -= 1;
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
	/// Calls that came back an error, as `tool path`.  Kept apart from the rest so a fold
	/// never reports an attempted write as a write.
	pub failed:  Vec<String>,
}

impl Ledger {

	/// Whether nothing at all was recorded.
	pub fn is_empty(&self) -> bool {
		self.read.is_empty() && self.wrote.is_empty() && self.ran.is_empty()
			&& self.fetched.is_empty() && self.spawned.is_empty() && self.failed.is_empty()
	}

	/// The ledger as lines for the fold notice, each capped so one pathological session
	/// cannot fill the window with its own history.
	pub fn lines(&self) -> Vec<String> {
		let mut out = Vec::new();
		let mut put = |label: &str, items: &Vec<String>| {
			if items.is_empty() {
				return;
			}
			let shown = items.len().min(40);
			let mut s = fmt!("{}: {}", label, items[..shown].join(", "));
			if items.len() > shown {
				s.push_str(&fmt!(" (and {} more)", items.len() - shown));
			}
			out.push(s);
		};
		put("Files read", &self.read);
		put("Files written", &self.wrote);
		put("Commands run", &self.ran);
		put("Pages fetched", &self.fetched);
		put("Agents dispatched", &self.spawned);
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
/// A call whose reply begins `Error` is recorded as failed and nowhere else.  Daimond's own
/// dispatcher returns every tool failure in that shape, so the test is the dispatcher's own
/// convention rather than a guess about wording.
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
			let ok = !reply.trim_start().starts_with("Error");
			record(&mut l, tc, ok);
		}
		i += 1 + calls.len();
	}
	l
}

/// Put one call in the right column of the ledger.
///
/// The classification duplicates what `Tool::write_targets` and `Tool::read_target` already
/// know, because both are private to `tools`; see the report accompanying this module for
/// the two-word visibility change that would let this call them instead.
///
/// # Arguments
/// * `l` - The ledger being built.
/// * `tc` - The call the model made.
/// * `ok` - Whether its reply was not an error.
fn record(l: &mut Ledger, tc: &ToolCall, ok: bool) {
	let arg = |k: &str| extract_json_string(&tc.arguments, k).unwrap_or_default();
	let path = arg("path");
	if !ok {
		let what = if path.is_empty() { arg("url") } else { path.clone() };
		Ledger::push(&mut l.failed, fmt!("{} {}", tc.name, what).trim().to_string());
		return;
	}
	match tc.name.as_str() {
		"file_read"											=> Ledger::push(&mut l.read, path),
		"file_list" | "file_search"							=> Ledger::push(&mut l.read,
			if path.is_empty() { fmt!(".") } else { path }),
		"file_write" | "file_edit" | "file_delete"
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
		_ => {},
	}
}


// ┌───────────────────────────────────────────────────────────────┐
// │ Rendering what is being folded                                 │
// └───────────────────────────────────────────────────────────────┘

/// One message as a line of transcript for the summarising call.
fn render_one(m: &ChatMessage) -> String {
	match m {
		ChatMessage::System { content } => fmt!("[system] {}", clip(&content.as_text(), 600)),
		ChatMessage::User { content }   => fmt!("user: {}", clip(&content.as_text(), 2_000)),
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

/// The one message a fold leaves in place of everything it folded.
///
/// A user message, and deliberately not an assistant one: a summary in the assistant's own
/// voice is the model reading invented memories as things it said, and the round-limit note
/// this codebase used to write proved how badly that reads.  Not a system message either,
/// for a duller reason that decides it -- the browser rehydrates a reloaded chat from
/// `user` and `assistant` messages only, so a system-role fold would silently vanish on
/// reload and the conversation would spring back to full size.
///
/// # Arguments
/// * `folded` - How many messages went.
/// * `summary` - The model's prose, or empty when the call could not be made.
/// * `ledger` - What the folded part did.
/// * `why` - Why there is no prose, when there is none.
pub fn notice(folded: usize, summary: &str, ledger: &Ledger, why: Option<&str>) -> String {
	let mut s = fmt!(
		"[Daimond folded the earlier part of this conversation to keep it inside the model's \
		 context window. {} messages were replaced by this note; everything after it is \
		 exactly as it was. This note is the only record of them that the model now has.]\n",
		folded);
	if !summary.trim().is_empty() {
		s.push_str("\n## What happened\n\n");
		s.push_str(summary.trim());
		s.push('\n');
	} else if let Some(reason) = why {
		s.push_str(&fmt!(
			"\n## What happened\n\nNo summary could be written ({}), so what follows is the \
			 record of the tool calls themselves and nothing more. Ask before assuming \
			 anything not listed here was done.\n", reason));
	}
	let lines = ledger.lines();
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
pub fn round_limit_note(max_rounds: usize) -> ChatMessage {
	ChatMessage::system(fmt!(
		"[Daimond stopped the previous turn after {} tool-call rounds, which is its \
		 limit. The assistant did not choose to stop and the task may be unfinished; \
		 say where it had got to before carrying on.]", max_rounds))
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
	if cut == 0 || cut >= msgs.len() {
		return Err(err!(
			"Fold: a cut at {} of {} messages folds nothing or everything.", cut, msgs.len();
			Invalid, Input));
	}
	let mut out = Vec::with_capacity(msgs.len() - cut + 1);
	out.push(ChatMessage::user(notice));
	out.extend_from_slice(&msgs[cut..]);
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
		msgs[i] = msgs[i].with_content(msgs[i].content().without_images());
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
// │ Recognising the failure                                        │
// └───────────────────────────────────────────────────────────────┘

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
/// # Arguments
/// * `err` - The error text from the failed call.
/// * `prompt_tokens` - The estimated size of the prompt that was refused.
/// * `budget` - The turn's token budget.
pub fn looks_like_overflow(err: &str, prompt_tokens: u64, budget: u64) -> bool {
	let low = err.to_lowercase();
	for m in [
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
	] {
		if low.contains(m) {
			return true;
		}
	}
	// The fallback: no words that say so, so the status and the size are all there is.
	let refused = low.contains("400") || low.contains("413") || low.contains("422");
	refused && prompt_tokens >= OVERFLOW_FLOOR_TOKENS.min(budget / 2)
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
mod tests {
	use super::*;

	/// An assistant turn asking for one tool call.
	fn asks(id: &str, name: &str, args: &str) -> ChatMessage {
		ChatMessage::Assistant {
			content:    MessageContent::text(""),
			tool_calls: vec![ToolCall {
				id: id.to_string(), name: name.to_string(), arguments: args.to_string(),
			}],
		}
	}

	/// The reply to one.
	fn replies(id: &str, body: &str) -> ChatMessage {
		ChatMessage::tool(id.to_string(), body.to_string())
	}

	fn user(s: &str) -> ChatMessage { ChatMessage::user(s.to_string()) }
	fn says(s: &str) -> ChatMessage {
		ChatMessage::assistant(s.to_string())
	}

	// ── Images ───────────────────────────────────────────────────────────────

	/// One of this repository's own screenshots, read off disk.
	///
	/// A real file rather than a synthesised one, because the numbers in [`image_tokens`]'s
	/// documentation were measured against these two files: a test built on a fabricated header
	/// would confirm the arithmetic and say nothing about whether the arithmetic describes a
	/// screenshot.
	///
	/// # Arguments
	/// * `name` - The file under `shots/`.
	fn shot(name: &str) -> ImagePart {
		let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("shots").join(name);
		let data = std::fs::read(&path)
			.unwrap_or_else(|e| panic!("the fixture {} must be readable: {}", path.display(), e));
		let media = crate::protocol::ImageMedia::sniff(&data).expect("the fixture must be an image");
		ImagePart::new(media, data, fmt!("shots/{}", name))
	}

	/// A tool reply carrying a screenshot, as `file_read` produces one.
	fn replies_with_image(id: &str, name: &str) -> ChatMessage {
		ChatMessage::tool(id.to_string(), MessageContent::parts(vec![
			crate::protocol::ContentPart::Text(fmt!("Read the image shots/{}.", name)),
			crate::protocol::ContentPart::Image(shot(name)),
		]))
	}

	/// An image is charged by its area, and the figures in the documentation are the figures a
	/// real screenshot produces.
	///
	/// The formula is Anthropic's published one -- ceil(w/28) x ceil(h/28) visual tokens -- so
	/// this is checking our arithmetic against a provider's rule and two files on disk, not
	/// against another function of ours.
	#[test]
	fn test_a_screenshot_costs_what_the_provider_charges_for_its_area() {
		let big = shot("mobile-desktop-after.png");
		assert_eq!(Some((1500, 950)), big.dims(), "the fixture is not the size the docs assume");
		// ceil(1500/28) = 54 columns, ceil(950/28) = 34 rows.
		assert_eq!(54 * 34, image_tokens(&big));

		let small = shot("mobile-sheet-web.png");
		assert_eq!(Some((390, 844)), small.dims());
		assert_eq!(14 * 31, image_tokens(&small));
	}

	/// The catastrophe this whole change exists to prevent: a screenshot priced as if it were
	/// text.
	///
	/// 199,280 bytes at the text ratio of 0.27 is 53,806 tokens -- most of a 131k budget, on a
	/// file the provider charges 1,836 for. Priced that way, the conversation folds on the turn
	/// the screenshot is read and on every turn after it.
	#[test]
	fn test_an_image_is_not_priced_as_if_it_were_text() {
		let img = shot("mobile-desktop-after.png");
		let as_text = (img.data.len() as f64 * DEFAULT_TOKENS_PER_BYTE) as u64;
		let actual  = image_tokens(&img);
		assert!(as_text > actual * 20,
			"the fixture no longer demonstrates the overstatement: {} vs {}", as_text, actual);

		// What the module actually counts.
		let msg = ChatMessage::user(MessageContent::parts(vec![
			crate::protocol::ContentPart::Image(img.clone()),
		]));
		let charged = msg_bytes(&msg);
		let gauge = Gauge::default();
		assert!(gauge.tokens(charged) < 2_200,
			"a screenshot is being charged {} tokens", gauge.tokens(charged));
		assert!(gauge.tokens(charged) >= actual,
			"a screenshot is being charged less than the provider will");

		// And it does not, on its own, trip the fold.
		let limits = Limits { window: 131_072, ..Limits::default() };
		assert!(charged < limits.budget(4_096) / 4,
			"one screenshot took a quarter of the budget: {} of {}",
			charged, limits.budget(4_096));
	}

	/// A format whose header this build cannot read is estimated from its bytes and bounded by the
	/// same ceiling, rather than falling through to the text ratio.
	#[test]
	fn test_an_unreadable_header_falls_back_to_a_bounded_estimate() {
		// A RIFF/WEBP wrapper with nothing decodable inside it.
		let mut data = b"RIFF\x00\x00\x00\x00WEBPVP8 ".to_vec();
		data.resize(300_000, 0x5A);
		let img = ImagePart::new(crate::protocol::ImageMedia::WebP, data, "big.webp".to_string());
		assert_eq!(None, img.dims(), "this build should not claim to read a WebP header");
		assert_eq!(IMAGE_TOKEN_CAP, image_tokens(&img), "the fallback must be capped");

		let small = ImagePart::new(
			crate::protocol::ImageMedia::WebP,
			b"RIFF\x00\x00\x00\x00WEBPVP8 ".to_vec(),
			"tiny.webp".to_string());
		assert!(image_tokens(&small) >= 1, "an image never costs nothing");
		assert!(image_tokens(&small) < 100, "a tiny file must not be charged the ceiling");
	}

	/// Elision drops the images before it shortens any prose.
	///
	/// Ordered that way because an image is the largest thing in the transcript and the least
	/// re-readable; the assertion is that the prose is still whole once the images have gone.
	#[test]
	fn test_elision_drops_images_before_it_touches_prose() {
		let mut v = vec![
			user("look at these"),
			asks("call_0", "file_read", r#"{"path":"shots/mobile-desktop-after.png"}"#),
			replies_with_image("call_0", "mobile-desktop-after.png"),
			asks("call_1", "file_read", r#"{"path":"src/main.rs"}"#),
			replies("call_1", &"z".repeat(4_000)),
			says("done"),
		];
		let before = conversation_bytes(&v);
		// A target that the images alone can meet.
		let target = before - msg_bytes(&v[2]) / 2;
		let n = elide_bulk(&mut v, target, 1);
		assert_eq!(1, n, "exactly the image message should have been touched");
		assert!(!v[2].content().has_image(), "the image survived");
		assert_eq!(4_000, v[4].content().text_len(), "the prose was shortened before it had to be");
	}

	/// An elided image leaves the file's name behind, so the model can read it again.
	#[test]
	fn test_an_elided_image_says_which_file_it_was() {
		let mut v = vec![
			user("look"),
			asks("call_0", "file_read", r#"{"path":"shots/mobile-desktop-after.png"}"#),
			replies_with_image("call_0", "mobile-desktop-after.png"),
			says("done"),
		];
		elide_bulk(&mut v, 100, 1);
		let left = v[2].text();
		assert!(!v[2].content().has_image(), "the image should have gone");
		assert!(left.contains("shots/mobile-desktop-after.png"),
			"the elision must name the file: {}", left);
		assert!(left.contains("read it again"), "it must say what to do: {}", left);
		// The pairing the provider checks is untouched.
		assert_eq!(0, orphan_count(&v));
		assert!(matches!(v[2], ChatMessage::Tool { .. }), "the role changed");
	}

	/// Elision still gets a conversation under the target when the images alone are not enough.
	#[test]
	fn test_images_then_prose_reaches_the_target() {
		let mut v = vec![user("go")];
		for r in 0..4 {
			let id = fmt!("call_{}", r);
			v.push(asks(&id, "file_read", r#"{"path":"x"}"#));
			v.push(if r % 2 == 0 {
				replies_with_image(&id, "mobile-sheet-web.png")
			} else {
				replies(&id, &"q".repeat(8_000))
			});
		}
		v.push(says("done"));
		let target = 4_000;
		elide_bulk(&mut v, target, 1);
		assert!(conversation_bytes(&v) <= target + 2_000,
			"elision left {} bytes against a target of {}", conversation_bytes(&v), target);
		assert!(!v.iter().any(|m| m.content().has_image()), "an image survived");
		assert_eq!(0, orphan_count(&v));
	}

	/// The fold's own input cap counts an image at its token cost too, so a folded conversation
	/// carrying screenshots does not produce a summarising call that is itself refused.
	#[test]
	fn test_the_fold_input_cap_measures_an_image_by_its_tokens() {
		let v = vec![
			user("go"),
			asks("call_0", "file_read", r#"{"path":"shots/mobile-desktop-after.png"}"#),
			replies_with_image("call_0", "mobile-desktop-after.png"),
		];
		assert!(conversation_bytes(&v) < FOLD_INPUT_CAP,
			"one screenshot exceeded the whole fold input cap: {} of {}",
			conversation_bytes(&v), FOLD_INPUT_CAP);
		// And what the summariser is shown names the file rather than carrying it.
		let r = render_for_fold(&v, FOLD_INPUT_CAP);
		assert!(r.contains("shots/mobile-desktop-after.png"), "{}", r);
		assert!(!r.contains("iVBORw0KGgo"), "base64 reached the summarising call: {}", r);
	}

	/// A conversation of `rounds` complete tool blocks, each carrying a fat result.
	fn session(rounds: usize, result_bytes: usize) -> Vec<ChatMessage> {
		let mut v = vec![user("please refactor the parser")];
		for r in 0..rounds {
			let id = fmt!("call_{}", r);
			v.push(asks(&id, "file_read", &fmt!("{{\"path\":\"src/f{}.rs\"}}", r)));
			v.push(replies(&id, &"x".repeat(result_bytes)));
		}
		v.push(says("done"));
		v
	}

	// ── Pairing: the rule that breaks a compactor ────────────────────────────

	#[test]
	fn test_a_whole_conversation_has_no_orphans_00() {
		assert_eq!(orphan_count(&session(3, 10)), 0);
		assert!(pairing_is_whole(&session(3, 10)));
	}

	#[test]
	fn test_a_reply_whose_call_was_folded_away_is_an_orphan_00() {
		// The shape a careless cut produces, and the one a provider rejects outright.
		let v = session(2, 10);
		let orphaned = &v[2..];		// starts at the tool reply, not the assistant turn
		assert!(matches!(orphaned[0], ChatMessage::Tool { .. }));
		assert_eq!(orphan_count(orphaned), 1);
		assert!(!pairing_is_whole(orphaned));
	}

	#[test]
	fn test_a_call_whose_reply_was_dropped_is_an_orphan_00() {
		let mut v = session(1, 10);
		v.remove(2);				// the reply
		assert_eq!(orphan_count(&v), 1);
	}

	#[test]
	fn test_two_calls_in_one_turn_need_two_replies_00() {
		let both = ChatMessage::Assistant {
			content: MessageContent::text(""),
			tool_calls: vec![
				ToolCall { id: fmt!("a"), name: fmt!("file_read"), arguments: fmt!("{{}}") },
				ToolCall { id: fmt!("b"), name: fmt!("file_list"), arguments: fmt!("{{}}") },
			],
		};
		let whole = vec![user("go"), both.clone(), replies("a", "1"), replies("b", "2")];
		assert_eq!(orphan_count(&whole), 0);
		let half = vec![user("go"), both, replies("a", "1")];
		assert_eq!(orphan_count(&half), 1);
	}

	#[test]
	fn test_replies_out_of_order_do_not_count_as_paired_00() {
		let both = ChatMessage::Assistant {
			content: MessageContent::text(""),
			tool_calls: vec![
				ToolCall { id: fmt!("a"), name: fmt!("file_read"), arguments: fmt!("{{}}") },
				ToolCall { id: fmt!("b"), name: fmt!("file_list"), arguments: fmt!("{{}}") },
			],
		};
		let swapped = vec![user("go"), both, replies("b", "2"), replies("a", "1")];
		assert!(orphan_count(&swapped) > 0);
	}

	// ── The cut ──────────────────────────────────────────────────────────────

	#[test]
	fn test_the_cut_never_lands_inside_a_tool_block_00() {
		// Every budget, on a conversation made entirely of blocks. The cut must never be a
		// tool reply, whatever the arithmetic wanted.
		let v = session(12, 500);
		for keep in (0..conversation_bytes(&v)).step_by(37) {
			let cut = tail_start(&v, keep, MIN_KEEP_MESSAGES, u64::MAX);
			assert!(!matches!(v.get(cut), Some(ChatMessage::Tool { .. })),
				"a cut at {} opens the tail with a reply to a call that was folded away", cut);
		}
	}

	#[test]
	fn test_folding_at_any_cut_leaves_a_whole_conversation_00() {
		// The property that actually matters, checked across the whole range rather than at
		// one convenient point.
		let v = session(12, 500);
		for keep in (0..conversation_bytes(&v)).step_by(37) {
			let cut = tail_start(&v, keep, MIN_KEEP_MESSAGES, u64::MAX);
			if cut == 0 {
				continue;
			}
			let out = match fold(&v, cut, fmt!("folded")) {
				Ok(o)  => o,
				Err(e) => panic!("a fold at {} was refused: {}", cut, e),
			};
			assert!(pairing_is_whole(&out), "cut {} orphaned something", cut);
		}
	}

	#[test]
	fn test_a_cut_that_would_orphan_a_call_is_refused_00() {
		// Constructed by hand, because `tail_start` will not produce one: the fold itself
		// must refuse it, so that no future caller computing its own cut can reintroduce the
		// bug this module exists to remove.
		let v = session(3, 100);
		let bad = v.iter().position(|m| matches!(m, ChatMessage::Tool { .. }))
			.expect("a tool reply");
		assert!(bad > 0);
		let r = fold(&v, bad, fmt!("folded"));
		assert!(r.is_err(), "a cut opening on a tool reply must be refused, not returned");
		let msg = match r { Ok(_) => fmt!(""), Err(e) => fmt!("{}", e) };
		assert!(msg.contains("unpaired"), "{}", msg);
	}

	#[test]
	fn test_a_conversation_already_broken_can_still_be_folded_00() {
		// A session read back from storage loses the tool_calls off its assistant turns, so
		// it arrives with orphans through no fault of the fold. Refusing to fold it would
		// leave it with no way out of an overflow at all; what the fold must not do is add
		// orphans of its own.
		let mut v = session(4, 100);
		for m in v.iter_mut() {
			if let ChatMessage::Assistant { tool_calls, .. } = m {
				tool_calls.clear();
			}
		}
		let before = orphan_count(&v);
		assert!(before > 0, "the fixture is meant to arrive broken");
		let out = match fold(&v, 3, fmt!("folded")) {
			Ok(o)  => o,
			Err(e) => panic!("a fold on an already-broken conversation was refused: {}", e),
		};
		assert!(orphan_count(&out) <= before);
	}

	#[test]
	fn test_the_newest_messages_are_always_kept_00() {
		let v = session(20, 800);
		let cut = tail_start(&v, 1_000, MIN_KEEP_MESSAGES, u64::MAX);
		assert!(v.len() - cut >= MIN_KEEP_MESSAGES,
			"only {} messages kept; a model just told the answer must not lose it",
			v.len() - cut);
		// And the very last message is always in the tail.
		assert_eq!(v[v.len() - 1], v[v.len() - 1]);
		assert!(cut < v.len());
	}

	#[test]
	fn test_a_huge_recent_message_does_not_defeat_the_fold_00() {
		// Found by a mock provider with a real context ceiling, not by reasoning: two
		// twenty-kilobyte replies among the six messages `min_keep` asks for made a tail
		// bigger than the whole budget, so the fold shrank the conversation by two messages
		// and it was refused again. A preference for six messages cannot outrank the size
		// that may actually be sent.
		let mut v = vec![user("go")];
		for i in 0..8 {
			v.push(user(&fmt!("more {}", i)));
			v.push(says(&"z".repeat(20_000)));
		}
		let ceiling = 8_000u64;
		let cut = tail_start(&v, ceiling, MIN_KEEP_MESSAGES, ceiling);
		let kept: u64 = v[cut..].iter().map(msg_bytes).sum();
		assert!(kept <= ceiling + 20_100,
			"the tail is {} bytes against a ceiling of {}", kept, ceiling);
		assert!(v.len() - cut < MIN_KEEP_MESSAGES,
			"six messages were kept anyway, which is the bug");
		assert!(cut < v.len(), "the message being answered is always kept");
	}

	#[test]
	fn test_a_long_assistant_turn_can_be_shortened_too_00() {
		// A tool result is not the only bulky thing in a conversation. Machine output can be
		// shortened; the user's own words cannot.
		let mut v = vec![
			user(&"u".repeat(5_000)),
			says(&"a".repeat(5_000)),
			user("what now?"),
		];
		let n = elide_bulk(&mut v, 3_000, 1);
		assert_eq!(n, 1, "the assistant's own turn should have been shortened");
		assert!(v[1].content().text_len() < 1_000, "{}", v[1].content().text_len());
		assert_eq!(v[0].content().text_len(), 5_000, "the user's own words were shortened");
	}

	#[test]
	fn test_shortening_an_assistant_turn_keeps_its_tool_calls_00() {
		// Shrinking the prose must not orphan the block the turn opens.
		let mut v = vec![
			user("go"),
			ChatMessage::Assistant {
				content:    MessageContent::text("z".repeat(5_000)),
				tool_calls: vec![ToolCall {
					id: fmt!("a"), name: fmt!("file_read"), arguments: fmt!("{{}}") }],
			},
			replies("a", "1"),
			user("next"),
		];
		elide_bulk(&mut v, 500, 1);
		assert_eq!(orphan_count(&v), 0, "the block lost its call");
		assert!(v[1].content().text_len() < 1_000);
	}

	#[test]
	fn test_a_short_conversation_is_not_folded_00() {
		let v = vec![user("hello"), says("hi")];
		assert_eq!(tail_start(&v, 0, MIN_KEEP_MESSAGES, u64::MAX), 0);
		assert!(fold(&v, 0, fmt!("x")).is_err(), "a fold of nothing is not a fold");
		// Not even under a ceiling it cannot meet. There is nothing worth folding in three
		// messages, and replacing one of them with a note explaining the fold is pure loss.
		let three = vec![user("hello"), says(&"x".repeat(50_000)), user("and?")];
		assert_eq!(tail_start(&three, 100, MIN_KEEP_MESSAGES, 100), 0);
	}

	// ── The ledger ───────────────────────────────────────────────────────────

	#[test]
	fn test_the_ledger_keeps_which_files_were_read_and_written_00() {
		let v = vec![
			user("go"),
			asks("a", "file_read", r#"{"path":"src/lib.rs"}"#),
			replies("a", "fn main() {}"),
			asks("b", "file_write", r#"{"path":"src/new.rs","content":"x"}"#),
			replies("b", "Wrote 1 byte."),
			asks("c", "run", r#"{"argv":["cargo","test"]}"#),
			replies("c", "ok"),
		];
		let l = ledger_of(&v);
		assert_eq!(l.read,  vec![fmt!("src/lib.rs")]);
		assert_eq!(l.wrote, vec![fmt!("src/new.rs")]);
		assert_eq!(l.ran,   vec![fmt!("cargo test")]);
		assert!(l.failed.is_empty());
	}

	#[test]
	fn test_a_write_that_failed_is_never_reported_as_a_write_00() {
		// The failure that matters most: a fold claiming a file was written, when the write
		// was refused, leaves the model describing work it cannot verify.
		let v = vec![
			user("go"),
			asks("a", "file_write", r#"{"path":"/etc/passwd","content":"x"}"#),
			replies("a", "Error: path is outside the workspace."),
		];
		let l = ledger_of(&v);
		assert!(l.wrote.is_empty(), "a refused write must not appear as a write: {:?}", l.wrote);
		assert_eq!(l.failed.len(), 1);
		assert!(l.failed[0].contains("/etc/passwd"));
	}

	#[test]
	fn test_the_same_file_read_twice_is_listed_once_00() {
		let v = vec![
			user("go"),
			asks("a", "file_read", r#"{"path":"a.rs"}"#), replies("a", "1"),
			asks("b", "file_read", r#"{"path":"a.rs"}"#), replies("b", "1"),
		];
		assert_eq!(ledger_of(&v).read, vec![fmt!("a.rs")]);
	}

	#[test]
	fn test_a_move_records_both_ends_00() {
		let v = vec![
			user("go"),
			asks("a", "file_move", r#"{"path":"old.rs","to":"new.rs"}"#),
			replies("a", "Moved."),
		];
		assert_eq!(ledger_of(&v).wrote, vec![fmt!("old.rs -> new.rs")]);
	}

	#[test]
	fn test_the_notice_carries_the_ledger_even_with_no_summary_00() {
		// What a failed summarising call leaves behind. It must still be a truthful record,
		// and it must say that the prose is missing rather than quietly omitting it.
		let l = ledger_of(&vec![
			user("go"),
			asks("a", "file_write", r#"{"path":"src/new.rs"}"#),
			replies("a", "Wrote."),
		]);
		let n = notice(9, "", &l, Some("the key was refused"));
		assert!(n.contains("src/new.rs"), "{}", n);
		assert!(n.contains("No summary could be written"), "{}", n);
		assert!(n.contains("the key was refused"), "{}", n);
		assert!(n.contains("9 messages"), "{}", n);
	}

	#[test]
	fn test_the_notice_is_not_in_the_assistants_voice_00() {
		// It is a user message on purpose. An assistant-voiced summary is the model reading
		// invented memories back as things it said.
		let out = match fold(&session(4, 100), 3, notice(3, "did things", &Ledger::default(), None)) {
			Ok(o)  => o,
			Err(e) => panic!("{}", e),
		};
		assert_eq!(out[0].role(), "user");
		assert!(out[0].text().contains("Daimond folded"));
	}

	// ── The round limit ──────────────────────────────────────────────────────

	#[test]
	fn test_the_round_limit_is_not_recorded_in_the_assistants_voice_00() {
		// The bug this replaces: an assistant message reading "[Reached the tool-call round
		// limit (25).]", which the next turn read back as its own words.
		let n = round_limit_note(150);
		assert_eq!(n.role(), "system",
			"a limit the app imposed must not be said in the model's own voice");
		assert!(n.text().contains("Daimond stopped"), "{}", n.text());
		assert!(n.text().contains("did not choose to stop"), "{}", n.text());
		assert!(n.text().contains("may be unfinished"), "{}", n.text());
		assert!(n.text().contains("150"), "{}", n.text());
	}

	#[test]
	fn test_a_turn_is_allowed_a_real_tasks_worth_of_rounds_00() {
		// Find the wiring, read three files, change one, build, fix two errors, run the
		// tests: comfortably thirty to fifty calls. Twenty-five stopped that in the middle.
		assert!(DEFAULT_MAX_ROUNDS >= 100, "{} rounds", DEFAULT_MAX_ROUNDS);
		assert_eq!(Limits::default().max_rounds, DEFAULT_MAX_ROUNDS);
	}

	// ── Rendering ────────────────────────────────────────────────────────────

	#[test]
	fn test_what_is_handed_to_the_summariser_is_bounded_00() {
		// The fold must not fail the way the request that triggered it failed. Whatever the
		// history's size, the summarising call's input is capped.
		for rounds in [4usize, 40, 400] {
			let v = session(rounds, 4_000);
			let r = render_for_fold(&v, FOLD_INPUT_CAP);
			assert!(r.len() as u64 <= FOLD_INPUT_CAP + 200,
				"{} rounds rendered to {} bytes", rounds, r.len());
		}
	}

	#[test]
	fn test_the_opening_of_the_conversation_survives_rendering_00() {
		// What the user asked for is said once, at the start, and nothing later restates it.
		let mut v = session(200, 2_000);
		v[0] = user("SENTINEL: port the parser to the new lexer");
		let r = render_for_fold(&v, FOLD_INPUT_CAP);
		assert!(r.contains("SENTINEL"), "the original request was dropped from the rendering");
		assert!(r.contains("too long to include"), "the gap must be declared");
	}

	// ── Eliding ──────────────────────────────────────────────────────────────

	#[test]
	fn test_eliding_shrinks_without_touching_pairing_00() {
		let mut v = session(10, 5_000);
		let before = conversation_bytes(&v);
		let n = elide_bulk(&mut v, before / 4, 4);
		assert!(n > 0);
		assert!(conversation_bytes(&v) < before);
		assert_eq!(orphan_count(&v), 0, "eliding must not add or remove a message");
		assert_eq!(v.len(), session(10, 5_000).len());
	}

	#[test]
	fn test_eliding_leaves_the_newest_results_whole_00() {
		let mut v = session(10, 5_000);
		elide_bulk(&mut v, 100, 4);
		let last_tool = v.iter().rposition(|m| matches!(m, ChatMessage::Tool { .. }))
			.expect("a reply");
		assert_eq!(v[last_tool].content().text_len(), 5_000,
			"the newest result was elided; that is the one the model is working from");
	}

	#[test]
	fn test_eliding_says_what_it_took_00() {
		let mut v = session(3, 5_000);
		elide_bulk(&mut v, 100, 0);
		let t = v.iter().find(|m| matches!(m, ChatMessage::Tool { .. })).expect("a reply");
		assert!(t.text().contains("folded away"), "{}", t.text());
		assert!(t.text().contains("read it again"), "{}", t.text());
	}

	// ── The budget ───────────────────────────────────────────────────────────

	#[test]
	fn test_an_unknown_window_still_yields_a_budget_00() {
		let l = Limits::default();
		assert_eq!(l.window, 0);
		assert!(l.budget(4_096) > MIN_BUDGET_TOKENS);
		assert!(l.budget(4_096) < DEFAULT_WINDOW);
	}

	#[test]
	fn test_the_reply_is_subtracted_from_a_small_window_00() {
		// On an 8k window with a 4k reply cap, eighty per cent of the window is not a legal
		// prompt: the reply has to fit too.
		let l = Limits { window: 8_192, ..Limits::default() };
		assert!(l.budget(4_096) <= 8_192 - 4_096,
			"budget {} leaves no room for the reply", l.budget(4_096));
	}

	#[test]
	fn test_the_budget_tracks_the_window_00() {
		let small = Limits { window: 32_768, ..Limits::default() };
		let big   = Limits { window: 1_048_576, ..Limits::default() };
		assert!(big.budget(8_192) > small.budget(8_192));
	}

	// ── The gauge ────────────────────────────────────────────────────────────

	#[test]
	fn test_the_gauge_learns_from_what_the_provider_charged_00() {
		let g = Gauge::default();
		assert_eq!(g.ratio(), DEFAULT_TOKENS_PER_BYTE);
		// A provider that charged 1 token per 2 bytes -- dense code, say.
		g.observe(20_000, 10_000);
		assert!((g.ratio() - 0.5).abs() < 1e-9, "{}", g.ratio());
		assert_eq!(g.tokens(1_000), 500);
	}

	#[test]
	fn test_a_provider_that_reports_nothing_leaves_the_gauge_alone_00() {
		let g = Gauge::default();
		g.observe(20_000, 0);
		assert_eq!(g.ratio(), DEFAULT_TOKENS_PER_BYTE);
	}

	#[test]
	fn test_an_absurd_ratio_is_held_inside_the_band_00() {
		let g = Gauge::default();
		g.observe(10, 10_000);
		assert!(g.ratio() <= MAX_TOKENS_PER_BYTE);
		g.observe(10_000, 1);
		assert!(g.ratio() >= MIN_TOKENS_PER_BYTE);
	}

	// ── Recognising the failure ──────────────────────────────────────────────

	#[test]
	fn test_a_providers_own_words_are_enough_00() {
		for msg in [
			"LLM: HTTP error: 400 | {\"error\":{\"message\":\"This model's maximum context \
			 length is 131072 tokens, however you requested 140000\"}}",
			"input length exceeds the model limit",
			"Request too large for model",
		] {
			assert!(looks_like_overflow(msg, 0, 100_000), "{}", msg);
		}
	}

	#[test]
	fn test_both_dialects_say_it_in_words_the_test_knows_00() {
		// The browser transport now carries the refusal body, so the words are available
		// wherever the app runs -- and the two wire dialects word it differently. Each of
		// these is a real refusal shape, in the form the browser now reports it.
		for msg in [
			// OpenAI-compatible.
			"LLM: HTTP error: 400 Bad Request | {\"error\":{\"message\":\"This model's \
			 maximum context length is 131072 tokens, however you requested 174233 \
			 tokens\",\"code\":\"context_length_exceeded\"}}",
			// Anthropic's Messages API, which says it two ways.
			"LLM: HTTP error: 400 Bad Request | {\"type\":\"error\",\"error\":{\"type\":\
			 \"invalid_request_error\",\"message\":\"prompt is too long: 213412 tokens > \
			 200000 maximum\"}}",
			"LLM: HTTP error: 400 Bad Request | {\"type\":\"error\",\"error\":{\"type\":\
			 \"invalid_request_error\",\"message\":\"input length and `max_tokens` exceed \
			 context limit: 198000 + 8192 > 200000\"}}",
		] {
			// Recognised on the words alone: the prompt size is given as zero, so
			// nothing here can be passing on the fallback below.
			assert!(looks_like_overflow(msg, 0, 100_000), "{}", msg);
		}
	}

	#[test]
	fn test_the_words_decide_even_when_the_prompt_looks_small_00() {
		// The case the size fallback cannot reach: a model with a window nobody
		// published, refusing a prompt that is small against the ASSUMED budget. Before
		// the browser carried the body this was indistinguishable from a mistyped
		// request unless the prompt cleared an absolute floor.
		let body = "LLM: HTTP error: 400 Bad Request | {\"error\":{\"message\":\"This \
			model's maximum context length is 8192 tokens\"}}";
		assert!(looks_like_overflow(body, 100, Limits::default().budget(4_096)),
			"the provider said so and it was not believed");
	}

	#[test]
	fn test_a_refusal_with_no_words_still_falls_back_to_the_size_00() {
		// The fallback earns its place: a provider can refuse with an empty body, a CDN
		// can answer 413 with a page of its own that says nothing about tokens, and a
		// body can fail to read at all. Then the status and the size are all there is.
		for bare in [
			"LLM: HTTP error: 400 Bad Request | ",
			"LLM: HTTP error: 413 Request Entity Too Large | <html><head><title>413 \
			 Request Entity Too Large</title></head><body><center><h1>413 Request \
			 Entity Too Large</h1></center><hr><center>nginx</center></body></html>",
		] {
			assert!(looks_like_overflow(bare, 90_000, 100_000), "{}", bare);
			assert!(!looks_like_overflow(bare, 500, 100_000),
				"a small prompt refused with no explanation is a bad request: {}", bare);
		}
	}

	#[test]
	fn test_a_bare_status_needs_a_big_prompt_behind_it_00() {
		// What the browser transport reports, which carries no body at all. A 400 with a
		// small prompt is a mistyped request, not an overflow, and folding on it would throw
		// away the user's history for nothing.
		let bare = "LLM: HTTP error: 400 Bad Request.";
		assert!(!looks_like_overflow(bare, 500, 100_000));
		assert!(looks_like_overflow(bare, 90_000, 100_000));
	}

	#[test]
	fn test_a_window_smaller_than_the_one_assumed_is_still_recognised_00() {
		// The case that decides the whole reactive path. A model with a 16k window that
		// nobody published is being treated as 131k, so its refusal arrives with a prompt
		// that looks small against the assumed budget. Judged as a fraction of that budget
		// it would be dismissed as a malformed request, and the chat would die exactly as
		// it did before.
		let assumed = Limits::default().budget(4_096);
		assert!(assumed > 90_000, "the assumed budget is {}", assumed);
		let bare = "LLM: HTTP error: 400 Bad Request.";
		assert!(looks_like_overflow(bare, 12_000, assumed),
			"a 12k-token prompt refused by a 16k-window model was not recognised");
	}

	#[test]
	fn test_a_refusal_teaches_the_window_and_only_downwards_00() {
		let mut l = Limits::default();
		assert_eq!(l.window, 0);
		assert!(l.learn_from_refusal(16_000), "a refusal at 16k tokens says something");
		assert_eq!(l.window, 12_000);
		// A later, larger refusal must not undo it: what was learned is a ceiling.
		assert!(!l.learn_from_refusal(100_000));
		assert_eq!(l.window, 12_000);
		// And it never learns its way down to nothing.
		let mut tiny = Limits::default();
		tiny.learn_from_refusal(10);
		assert_eq!(tiny.window, MIN_LEARNED_WINDOW);
	}

	#[test]
	fn test_what_a_refusal_teaches_makes_the_next_prompt_smaller_00() {
		// The property the recovery rests on: after learning, the budget is BELOW the
		// prompt that was refused. A fold that targeted the old budget would change nothing
		// and the retry would be refused again.
		let mut l = Limits::default();
		let refused = 16_000;
		l.learn_from_refusal(refused);
		assert!(l.budget(4_096) < refused,
			"budget {} is not below the {} tokens the provider refused", l.budget(4_096), refused);
	}

	#[test]
	fn test_an_ordinary_failure_is_not_an_overflow_00() {
		for msg in [
			"LLM: HTTP error: 401 Unauthorized.",
			"LLM: fetch failed: NetworkError.",
			"LLM: HTTP error: 429 Too Many Requests.",
			"LLM: HTTP error: 500 Internal Server Error.",
		] {
			assert!(!looks_like_overflow(msg, 200_000, 100_000), "{}", msg);
		}
	}

	// ── End to end, on the conversation the bug actually killed ──────────────

	#[test]
	fn test_a_session_too_big_for_its_window_folds_to_something_that_fits_00() {
		// Forty rounds of six-kilobyte file reads: a quarter of a megabyte of history, which
		// is what an afternoon's work looks like and what used to make a chat unusable
		// forever.
		let v = session(40, 6_000);
		let limits = Limits { window: 32_768, ..Limits::default() };
		let gauge  = Gauge::default();
		let budget = limits.budget(4_096);
		assert!(gauge.tokens(conversation_bytes(&v)) > budget, "the fixture must be too big");

		let keep = gauge.bytes(limits.tail_budget(4_096));
		let cut  = tail_start(&v, keep, MIN_KEEP_MESSAGES, u64::MAX);
		assert!(cut > 0);
		let l   = ledger_of(&v[..cut]);
		let mut out = match fold(&v, cut, notice(cut, "read forty files", &l, None)) {
			Ok(o)  => o,
			Err(e) => panic!("{}", e),
		};
		elide_bulk(&mut out, gauge.bytes(budget), MIN_KEEP_MESSAGES);

		assert!(out.len() < v.len(),
			"the fold kept {} of {} messages, so nothing was folded at all",
			out.len(), v.len());
		assert!(gauge.tokens(conversation_bytes(&out)) <= budget,
			"still {} tokens against a budget of {}",
			gauge.tokens(conversation_bytes(&out)), budget);
		assert!(pairing_is_whole(&out), "the folded conversation would be rejected");
		// And it still knows what it did: the earliest file it read is named in the note,
		// and the latest is still in the conversation verbatim.
		assert!(out[0].text().contains("src/f0.rs"),
			"the fold forgot the first file it read: {}", out[0].content());
		let tail_mentions = out.iter().skip(1).any(|m| match m {
			ChatMessage::Assistant { tool_calls, .. } =>
				tool_calls.iter().any(|tc| tc.arguments.contains("src/f39.rs")),
			_ => m.text().contains("src/f39.rs"),
		});
		assert!(tail_mentions, "the newest work was folded away instead of kept");
	}

	#[test]
	fn test_folding_the_same_conversation_twice_is_stable_00() {
		// A folded conversation that folds again must keep shrinking, or a long session ends
		// up folding on every single turn and paying for a summary each time.
		let v = session(40, 6_000);
		let g = Gauge::default();
		let cut = tail_start(&v, g.bytes(4_000), MIN_KEEP_MESSAGES, u64::MAX);
		let once = match fold(&v, cut, notice(cut, "", &ledger_of(&v[..cut]), None)) {
			Ok(o) => o, Err(e) => panic!("{}", e),
		};
		let cut2 = tail_start(&once, g.bytes(2_000), MIN_KEEP_MESSAGES, u64::MAX);
		if cut2 > 0 {
			let twice = match fold(&once, cut2, notice(cut2, "", &ledger_of(&once[..cut2]), None)) {
				Ok(o) => o, Err(e) => panic!("{}", e),
			};
			assert!(conversation_bytes(&twice) < conversation_bytes(&once));
			assert!(pairing_is_whole(&twice));
		}
	}
}
