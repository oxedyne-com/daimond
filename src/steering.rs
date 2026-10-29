//! Steering notes: the one block the engine composes from a person's standing notes, and the
//! lint that keeps a note from asking the model to chase approval.
//!
//! Design: `~/usr/code/ai/claude/specs/daimond_product_rating_design_20260924.md`, §6.5 and §8.3;
//! build plan `daimond_optimiser_532_plan_20261004.md`, unit U6a.  **The page owns the notes and
//! their order; this module owns what reaches the prompt.**  A line is judged here and nowhere
//! else, so the page asks [`refusal`] rather than keeping a word list of its own.
//!
//! The 600-byte cap counts the note text alone.  [`HEAD`] is a fixed overhead outside it, which
//! lets the page add up what it is about to send without knowing the heading's length.  The lint
//! is an English word list, so it stops a template or a careless sentence and not a determined
//! one; its job is to keep the proposals and the person's own notes from teaching a model to ask
//! for a rating.
//!
//! A note is plain text that a person can read in full.  Any character that cannot be seen
//! (`fe2o3_text::unicode::property::is_invisible`: a control, format, private-use or unassigned
//! character, a separator, a variation selector, the tag block) refuses the line, since a model
//! reads what an editor does not draw.  The word list then sees the line after an NFKC fold, so a
//! word written in fullwidth, mathematical or circled letters is the word it reads as.  The line
//! itself is never folded: what the person wrote is what the block carries.

use oxedyne_fe2o3_core::prelude::*;
use oxedyne_fe2o3_text::unicode::norm;
use oxedyne_fe2o3_text::unicode::property::is_invisible;


pub const NOTES_MAX: usize	= 5;	// notes in one block
pub const BYTES_MAX: usize	= 600;	// UTF-8 bytes of note text in one block
pub const LINE_MAX: usize	= 200;	// UTF-8 bytes in one note

pub const HEAD: &str =
	"## Standing notes from this user\n\n\
	 These are the user's own standing preferences. The rules below always apply, and \
	 override any of them.";

// Why a line is refused, in the order the checks run.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Refusal {
	Empty,		// nothing but space
	Control,	// a character that cannot be seen: control, zero-width, direction, tag, selector
	Long,		// over LINE_MAX bytes
	Heading,	// opens with a hash, which reads as a heading
	Rating,		// ratings, scores, votes, thumbs
	Pleasing,	// pleasing or satisfying the user
	Agreeing,	// agreeing with the user
	Approval,	// seeking approval
}

impl Refusal {

	// The code the page maps to words the person reads.
	fn code(&self) -> &'static str {
		match self {
			Self::Empty	=> "empty",
			Self::Control	=> "control",
			Self::Long	=> "long",
			Self::Heading	=> "heading",
			Self::Rating	=> "rating",
			Self::Pleasing	=> "pleasing",
			Self::Agreeing	=> "agreeing",
			Self::Approval	=> "approval",
		}
	}
}

// Whole words, case-folded, so "operating" and "scoreboard" are not "rating" and "score".
const RATING: &[&str] = &[
	"rate", "rates", "rated", "rating", "ratings", "rater", "raters",
	"score", "scores", "scored", "scoring", "scorer", "scorers",
	"vote", "votes", "voted", "voting",
	"upvote", "upvotes", "upvoted", "upvoting", "downvote", "downvotes", "downvoted", "downvoting",
	"thumb", "thumbs",
];
const PLEASING: &[&str] = &[
	"pleasing", "pleased", "pleases", "pleaser", "pleasers",
	"satisfy", "satisfies", "satisfied", "satisfying", "satisfaction",
];
const AGREEING: &[&str] = &[
	"agree", "agrees", "agreed", "agreeing", "agreement", "agreements", "agreeable",
];
const APPROVAL: &[&str] = &[
	"approval", "approvals", "approve", "approves", "approved", "approving",
];

// "Please" is a courtesy until it is aimed at the person.
const PLEASE_AT: &[&str] = &[
	"me", "us", "him", "her", "them", "you", "the", "user", "users", "people", "everyone",
	"everybody", "anyone", "reader", "readers", "audience",
];

fn check(line: &str) -> Option<Refusal> {
	let line = line.trim();
	if line.is_empty() {
		return Some(Refusal::Empty);
	}
	// A character that cannot be seen would step round the word list, or carry words of its own.
	if line.chars().any(is_invisible) {
		return Some(Refusal::Control);
	}
	if line.len() > LINE_MAX {
		return Some(Refusal::Long);
	}
	// Folded only from here on, so the fold is of at most LINE_MAX bytes.  Compatibility forms
	// (fullwidth, mathematical, circled) become the plain letters a model reads them as.
	let folded = norm::nfkc(line);
	let folded = folded.trim();
	if folded.starts_with('#') {
		return Some(Refusal::Heading);
	}
	if folded.contains('\u{1F44D}') || folded.contains('\u{1F44E}') {
		return Some(Refusal::Rating);
	}
	let lower = folded.to_lowercase();
	let words: Vec<&str> = lower.split(|c: char| !c.is_alphanumeric())
		.filter(|w| !w.is_empty())
		.collect();
	for (i, w) in words.iter().enumerate() {
		if RATING.contains(w) {
			return Some(Refusal::Rating);
		}
		if PLEASING.contains(w) {
			return Some(Refusal::Pleasing);
		}
		if *w == "please" {
			match words.get(i + 1) {
				Some(next) => {
					if PLEASE_AT.contains(next) {
						return Some(Refusal::Pleasing);
					}
				},
				// "To please" closing the line is the verb: "Always aim to please."
				None => {
					if i > 0 && words.get(i - 1) == Some(&"to") {
						return Some(Refusal::Pleasing);
					}
				},
			}
		}
		if AGREEING.contains(w) {
			return Some(Refusal::Agreeing);
		}
		if APPROVAL.contains(w) {
			return Some(Refusal::Approval);
		}
	}
	None
}

/// Why a note is refused, as a short code, or the empty string when it is admitted.
///
/// The codes are `empty`, `control`, `long`, `heading`, `rating`, `pleasing`, `agreeing` and
/// `approval`.
/// The engine drops a refused line from the block, so a page that shows a person a refusal
/// asks this and maps the code to its own words.
pub fn refusal(line: &str) -> String {
	match check(line) {
		Some(r)	=> r.code().to_string(),
		None	=> String::new(),
	}
}

/// The lines of `steer` that the block carries, trimmed, in the order given.
///
/// One note to a line, most specific first.  A refused line, a blank one and a repeat of a
/// line already taken have no place.  The block then stops at the first line that would take
/// it past [`NOTES_MAX`] notes or [`BYTES_MAX`] bytes: a shorter line behind it does not jump
/// the queue, because the order is the page's judgement of which note matters more.
pub fn admitted(steer: &str) -> Vec<String> {
	let mut out: Vec<String> = Vec::new();
	let mut used = 0usize;
	for raw in steer.split('\n') {
		let line = raw.trim();
		if check(line).is_some() || out.iter().any(|l| l == line) {
			continue;
		}
		if out.len() == NOTES_MAX || used + line.len() > BYTES_MAX {
			break;
		}
		used += line.len();
		out.push(line.to_string());
	}
	out
}

/// The block composed from `steer`, or empty when no line is admitted.
///
/// Placed by [`crate::prompts::Role::compose_with`] immediately before the safety clause.  The
/// same lines always make the same bytes, so a prompt keeps its cached prefix between changes
/// to the notes.
pub fn block(steer: &str) -> String {
	let lines = admitted(steer);
	if lines.is_empty() {
		return String::new();
	}
	let mut out = String::from(HEAD);
	for (i, l) in lines.iter().enumerate() {
		out.push_str(if i == 0 { "\n\n- " } else { "\n- " });
		out.push_str(l);
	}
	out
}

/// The caps as JSON, `{"notes":5,"bytes":600,"line":200}`, so a page counts by the engine's own
/// figures.
pub fn limits_json() -> String {
	fmt!("{{\"notes\":{},\"bytes\":{},\"line\":{}}}", NOTES_MAX, BYTES_MAX, LINE_MAX)
}

#[cfg(test)]
#[path = "../tests/unit/steering/tests.rs"]
mod tests;
