//! The turn's own state, kept by the engine outside the conversation (UNBLOCK-27 R3 and R4,
//! 2026-10-18).
//!
//! A turn on the Reit letter ran 102 rounds re-checking crops and never wrote the letter: it could
//! end only by the model choosing to stop, its reasoning was dropped every round and a fold cut its
//! ask, so nothing the model read told it the work was done.  This holds what the turn is for and
//! where it has got to, in the engine, where neither a dropped reasoning block nor a fold can
//! reach it.  Each round it is shown to the model as one line in the last tool result
//! ([`crate::compact::note_turn_state`]).
//!
//! **R4 is its own counter and does NOT replace the ORCHESTRATE hands-on budget** (§16,
//! D-20261015-09, the owner's ruling).  That budget counts a conductor's OWN rounds and steers it
//! to hand the work to workers; this counts rounds in which no file outside a scratch folder
//! changed, whoever made the calls.  They meet at one point: past that budget the conductor's
//! delivering act is `spawn_agent` of the assembly, and this rule counts a completed dispatch as
//! progress and never refuses one, so neither can block the act the other is asking for.  Each
//! speaks under its own marker -- `[turn state: ` here, distinct from `[budget]` and
//! `[turn budget: `.  Diagnosis and check: `notes/daimond_recheck_20261018/{diag,check}.md`.
//!
//! **R4b (2026-10-18): the rule binds only a turn whose ask names a file deliverable.**  A
//! question answered in text, or a research or review turn that only reads, gets neither the
//! deliver line nor the refusals, since without the scope a legitimate 40-round read-only turn
//! was refused from round 24.  The state line and "Unchanged since round r" stay on every turn.

use crate::tools::CallOutcome;
use crate::tools::PathClaim;
use crate::tools::Tool;

use oxedyne_fe2o3_core::prelude::*;


/// File types an ask can name as the thing to produce.  A closed list rather than "anything
/// with a dot", which would take "e.g." or a web address for a deliverable.
const DELIVERABLE_EXTS: [&str; 30] = ["typ", "md", "pdf", "txt", "html", "htm", "css", "js",
	"mjs", "ts", "json", "csv", "tsv", "xlsx", "docx", "pptx", "odt", "rtf", "tex", "rs", "py",
	"sh", "toml", "yaml", "yml", "xml", "svg", "png", "jpg", "jpeg"];

/// What has become of the deliverable this turn.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Stage {
	Absent,				// not written this turn
	Written(usize),		// the round it was last written
	Checked(usize),		// the round it was read back, built or run after writing
}

/// How a call bears on the no-progress rule.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Class {
	Read,		// refused at 2K
	Write,		// progress when it lands outside scratch
	Deliver,	// progress whenever it completes: an artefact, a dispatched worker
	Neutral,	// `run`, a build, everything else: never refused, never progress
}

impl Class {
	pub fn of(name: &str) -> Self {
		match Tool::from_name(name) {
			Some(Tool::FileRead) | Some(Tool::Ocr) | Some(Tool::FileShow) | Some(Tool::FileList)
			| Some(Tool::FileGlob) | Some(Tool::FileSearch) | Some(Tool::Recall)	=> Self::Read,
			Some(Tool::FileWrite) | Some(Tool::FileEdit) | Some(Tool::FileDelete)
			| Some(Tool::FileMove) | Some(Tool::DocEdit) | Some(Tool::SheetWrite)
			| Some(Tool::TypstCompile) | Some(Tool::ImageEdit)						=> Self::Write,
			Some(Tool::ArtefactAdd) | Some(Tool::SpawnAgent)						=> Self::Deliver,
			_																		=> Self::Neutral,
		}
	}
}

/// Is this path in a scratch folder -- a component opening with `_`, such as `_work/`?
pub fn is_scratch(path: &str) -> bool {
	path.split(|c| c == '/' || c == '\\').any(|part| part.starts_with('_'))
}

/// The file the ask names as its product: the LAST file name with a known extension, because an
/// ask names its inputs first and its output last ("read notes.md and write summary.md").
pub fn deliverable_in(ask: &str) -> Option<String> {
	let edge = |c: char| !(c.is_alphanumeric() || matches!(c, '.' | '_' | '-' | '/'));
	ask.split(|c: char| c.is_whitespace() || matches!(c, ',' | ';' | '"' | '\'' | '`' | '(' | ')'))
		.map(|w| w.trim_matches(edge).trim_end_matches('.'))
		.filter(|w| !w.contains("://"))
		.filter(|w| match w.rsplit_once('.') {
			Some((stem, ext)) => !stem.is_empty() && !stem.ends_with('/')
				&& DELIVERABLE_EXTS.contains(&ext.to_lowercase().as_str()),
			None => false,
		})
		.last()
		.map(|w| w.to_string())
}

/// The engine's ledger of one turn.
#[derive(Clone, Debug)]
pub struct TurnState {
	k:		usize,						// rounds without progress before the deliver line
	goal:	Option<String>,				// the deliverable named in the ask
	stage:	Stage,
	round:	usize,						// the turn's round count at the last `end_round`
	moved:	usize,						// the last round with progress, 0 for the turn's start
	reads:	Vec<(String, u64, usize)>,	// (call, result hash, round first returned)
}

impl TurnState {
	pub fn new(ask: &str, k: usize) -> Self {
		Self {
			k:		k.max(1),
			goal:	deliverable_in(ask),
			stage:	Stage::Absent,
			round:	0,
			moved:	0,
			reads:	Vec::new(),
		}
	}

	pub fn goal(&self) -> Option<&str> { self.goal.as_deref() }
	pub fn stage(&self) -> Stage { self.stage }

	/// Rounds since the last progress, as of the last [`end_round`](Self::end_round).
	pub fn quiet(&self) -> usize { self.round.saturating_sub(self.moved) }

	/// Is the turn held to the no-progress rule?  Only a turn whose ask names a file deliverable
	/// is: a question answered in text, or a research or review turn that only reads, has no file
	/// to deliver, so a long run of reads is its work and not a stall (UNBLOCK-27 R4b).
	pub fn bound(&self) -> bool { self.goal.is_some() }

	/// Has the turn gone 2K rounds without progress, so that the read class is closed?
	pub fn reads_closed(&self) -> bool { self.bound() && self.quiet() >= 2 * self.k }

	/// Is this call refused by the no-progress rule?  Only the read class ever is: the write that
	/// delivers, a build, `run` and a dispatched worker stay open, because each of those is how a
	/// turn delivers (turn 2 of the Reit letter delivered through `run` and `typst_compile`).
	pub fn refuses(&self, name: &str) -> bool {
		self.reads_closed() && Class::of(name) == Class::Read
	}

	/// The refusal a closed read is answered with.  Opens "Refused" so every reader books it as
	/// one ([`crate::tools::call_outcome`]).
	pub fn refusal(&self) -> String {
		fmt!("Refused: no file outside a scratch folder has changed in {} rounds, so reading is \
			closed for the rest of this turn. Deliver now: {}. Writing, running, compiling and \
			dispatching a worker are all still open.", self.quiet(), self.deliver_what())
	}

	fn deliver_what(&self) -> String {
		match &self.goal {
			Some(g) => fmt!("write {} from what you already have, or give your answer", g),
			None    => fmt!("give your answer from what you already have"),
		}
	}

	/// Book one call that has run.  `paths` are its [`Tool::path_claims`]; `seen` the hash of its
	/// result when it was a read.  Hands back the round an identical read first returned the same
	/// result in, so the caller can say "unchanged since round r".
	pub fn record(&mut self, name: &str, args: &str, outcome: CallOutcome,
		paths: &[(String, PathClaim)], seen: Option<u64>, round: usize) -> Option<usize>
	{
		if outcome != CallOutcome::Done {
			return None;
		}
		let class = Class::of(name);
		let landed = paths.iter().any(|(p, _)| !is_scratch(p));
		if class == Class::Deliver || (class == Class::Write && landed) {
			self.moved = round;
		}
		if let Some(g) = self.goal.clone() {
			let hits = |p: &str| p == g || p.ends_with(&fmt!("/{}", g));
			let wrote = class == Class::Write && name != Tool::TypstCompile.name()
				&& paths.iter().any(|(p, c)| *c == PathClaim::Left && hits(p));
			if wrote {
				self.stage = Stage::Written(round);
			} else if matches!(self.stage, Stage::Written(_)) && args.contains(g.as_str())
				&& (class == Class::Read || name == Tool::TypstCompile.name()
					|| name == Tool::Run.name())
			{
				self.stage = Stage::Checked(round);
			}
		}
		let hash = match (class, seen) {
			(Class::Read, Some(h)) => h,
			_                      => return None,
		};
		match self.reads.iter_mut().find(|(c, _, _)| c.as_str() == args_key(name, args)) {
			Some(slot) if slot.1 == hash => Some(slot.2),
			Some(slot) => {
				slot.1 = hash;
				slot.2 = round;
				None
			},
			None => {
				self.reads.push((args_key(name, args).to_string(), hash, round));
				None
			},
		}
	}

	/// Close round `round` and give the line the model is shown for it.  On a
	/// [bound](Self::bound) turn the deliver line appears from K quiet rounds on and the read
	/// refusal follows from 2K; any other turn gets the state line alone.
	pub fn end_round(&mut self, round: usize) -> String {
		self.round = round;
		let what = match (&self.goal, self.stage) {
			(None, _)						=> fmt!("none named in the ask, so it is the reply"),
			(Some(g), Stage::Absent)		=> fmt!("{}, absent", g),
			(Some(g), Stage::Written(r))	=> fmt!("{}, written in round {}", g, r),
			(Some(g), Stage::Checked(r))	=> fmt!("{}, written and checked in round {}", g, r),
		};
		let since = if self.moved == 0 {
			fmt!("no file outside a scratch folder has changed this turn")
		} else {
			fmt!("the last file outside a scratch folder changed in round {}", self.moved)
		};
		let mut line = fmt!("round {}. Deliverable: {}; {}.", round, what, since);
		let quiet = self.quiet();
		if self.bound() && quiet >= self.k {
			line.push_str(&fmt!(" {} rounds without a change: deliver now -- {}.", quiet,
				self.deliver_what()));
			if self.reads_closed() {
				line.push_str(" Reading is closed; writing, running, compiling and dispatching \
					are not.");
			} else {
				line.push_str(&fmt!(" After {} more rounds without one, reading closes.",
					2 * self.k - quiet));
			}
		}
		line
	}
}

/// The key a read is matched on: the tool and its arguments, byte for byte.
fn args_key(name: &str, args: &str) -> String {
	fmt!("{}\u{1f}{}", name, args)
}

/// The hash a read's result is compared on: its words and every picture's bytes.
pub fn result_hash(c: &crate::protocol::MessageContent) -> u64 {
	let mut bytes = c.as_text().into_owned().into_bytes();
	for img in c.images() {
		bytes.extend_from_slice(&img.data);
	}
	crate::tools::content_hash(&bytes)
}

#[cfg(test)]
#[path = "../tests/unit/turn_state/tests.rs"]
mod tests;
