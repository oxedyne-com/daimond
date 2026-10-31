//! UNBLOCK-26 U5, 18 Oct 2026: a turn about to change a file the person made asks first, with
//! the change shown, and nothing is written but on their Apply.  The asking edge is
//! [`crate::wasm::deletes::ask_change`]; what the question shows and what each answer means are
//! here, target-agnostic, so they are tested natively.
//!
//! The diff is cut to [`SHOWN_MAX_BYTES`] so that the question fits the relay's 64 KiB envelope
//! when it is carried to another device (gateway `post.rs`), with a count of the changed lines
//! left out.  Every answer but Apply writes nothing, and silence is never read as a yes.

use crate::diamond_versions::{
	self as versions,
	Row,
};
use crate::llm::json_escape;
use crate::tools::refusal_line;

use oxedyne_fe2o3_core::prelude::*;


pub const SHOWN_MAX_BYTES:	usize	= 32 * 1024;	// the diff's share of the envelope, escaped
pub const LINE_MAX_CHARS:	usize	= 400;			// one shown line, past which it is cut with '…'
pub const CONTEXT_LINES:	usize	= 3;			// unchanged lines kept either side of a change
pub const WAIT_MS:			u64		= 600_000;		// ten minutes on this device, then "not answered"

/// What the turn wants to do to the person's file.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Change<'a> {
	Write(&'a [u8]),	// the bytes it would leave there
	Delete,
	Move(&'a str),		// the workspace-relative path it would move it to
}

impl<'a> Change<'a> {
	pub fn act(&self) -> &'static str {
		match self {
			Self::Write(_)	=> "change",
			Self::Delete	=> "delete",
			Self::Move(_)	=> "move",
		}
	}
}

/// The person's answer.  Only `Apply` lets the change through.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Answer {
	Apply,
	Refused,		// they pressed Don't Change
	Unanswered,		// ten minutes, a reload, no page to ask on, or no device to ask
	Unkept(String),	// a host that keeps instead of asking could not keep a copy first: why
}

impl Answer {
	/// The page's word for an answer.  Anything it does not know is `Unanswered`, never a yes.
	pub fn from_word(word: &str) -> Self {
		match word {
			"apply"		=> Self::Apply,
			"refused"	=> Self::Refused,
			_			=> Self::Unanswered,
		}
	}

	/// What the model is told when the change was not made, or `None` on Apply.  The sentence
	/// forbids the way round, because a model told only "no" reaches for `run` and `sed`.
	///
	/// Every answer but Apply is a refusal, and is composed by [`refusal_line`] so that
	/// [`crate::tools::call_outcome`] reads it back as one.  Until 31 Oct 2026 these opened with
	/// their own words, so a change Kimberlite could not keep a copy of, or one the person
	/// declined, was booked as done and drawn `file_write · ok` (TOOLROW-STATUS).
	pub fn told(&self, path: &str) -> Option<String> {
		let why = match self {
			Self::Apply			=> return None,
			Self::Refused		=> "The user chose not to have",
			Self::Unanswered	=> "The user did not answer whether to have",
			Self::Unkept(why)	=> return Some(refusal_line(&fmt!("A copy of '{}' could not be \
				kept first, so that it could be put back: {}. Nothing was changed. Do not make this \
				change another way; finish the rest and say in your answer what you would have \
				changed.", path, why.trim_end_matches('.')))),
		};
		Some(refusal_line(&fmt!("{} '{}' changed. Nothing was changed. Do not make this change \
			another way; finish the rest and say in your answer what you would have changed.",
			why, path)))
	}
}

/// One line of the diff the question shows.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Shown {
	Same(String),
	Del(String),
	Add(String),
	Skip(usize),	// a run of unchanged lines folded away
}

/// The diff as the question shows it.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct Diff {
	pub rows:	Vec<Shown>,
	pub add:	usize,
	pub del:	usize,
	pub more:	usize,	// changed lines cut off by the size bound
	pub text:	bool,	// false: binary, or past the line cap, so no rows
}

fn cut(line: &str) -> String {
	match line.char_indices().nth(LINE_MAX_CHARS) {
		Some((i, _))	=> fmt!("{}…", &line[..i]),
		None			=> line.to_string(),
	}
}

/// The line diff of `before` against `after`, folded to [`CONTEXT_LINES`] around each change and
/// cut to `max_bytes` of escaped text, with the changed lines it could not show counted.
pub fn diff(before: &[u8], after: &[u8], max_bytes: usize) -> Diff {
	let (a, b) = match (std::str::from_utf8(before), std::str::from_utf8(after)) {
		(Ok(a), Ok(b))	=> (a, b),
		_				=> return Diff::default(),
	};
	let rows = match versions::line_diff(a, b) {
		Ok(r)	=> r,
		Err(_)	=> return Diff::default(),
	};
	let (add, del) = versions::diff_counts(&rows);
	// Which unchanged lines are near enough to a change to keep.
	let n = rows.len();
	let mut keep = vec![false; n];
	for (i, r) in rows.iter().enumerate() {
		if !matches!(r, Row::Same(_)) {
			let lo = i.saturating_sub(CONTEXT_LINES);
			let hi = (i + CONTEXT_LINES + 1).min(n);
			for k in keep[lo..hi].iter_mut() {
				*k = true;
			}
		}
	}
	let mut out = Diff { rows: Vec::new(), add, del, more: 0, text: true };
	let mut bytes = 0usize;
	let mut skip = 0usize;
	let mut full = false;
	for (i, r) in rows.into_iter().enumerate() {
		if full {
			if !matches!(r, Row::Same(_)) {
				out.more += 1;
			}
			continue;
		}
		if !keep[i] {
			skip += 1;
			continue;
		}
		if skip > 0 {
			out.rows.push(Shown::Skip(skip));
			bytes += 16;
			skip = 0;
		}
		let line = match r {
			Row::Same(t)	=> Shown::Same(cut(&t)),
			Row::Del(t)		=> Shown::Del(cut(&t)),
			Row::Add(t)		=> Shown::Add(cut(&t)),
		};
		let size = match &line {
			Shown::Same(t) | Shown::Del(t) | Shown::Add(t)	=> json_escape(t).len() + 16,
			Shown::Skip(_)									=> 16,
		};
		if bytes + size > max_bytes {
			full = true;
			if !matches!(line, Shown::Same(_)) {
				out.more += 1;
			}
			continue;
		}
		bytes += size;
		out.rows.push(line);
	}
	if skip > 0 && !full {
		out.rows.push(Shown::Skip(skip));
	}
	out
}

/// The question as JSON, for the page's `DaimondDeletes.change`.
///
/// # Arguments
/// * `keeper` - The Diamond's id, or `chat:<id>`, whose turn is asking.
/// * `turn` - The turn's tag, so a handed-off turn's question is put on the device it came from.
pub fn payload(keeper: &str, path: &str, turn: &str, before: &[u8], change: &Change<'_>) -> String {
	let d = match change {
		Change::Write(after)	=> diff(before, after, SHOWN_MAX_BYTES),
		_						=> Diff { text: true, ..Diff::default() },
	};
	let to = match change {
		Change::Move(p)	=> json_escape(p),
		_				=> String::new(),
	};
	let rows: Vec<String> = d.rows.iter().map(|r| match r {
		Shown::Same(t)	=> fmt!("{{\"k\":\" \",\"t\":\"{}\"}}", json_escape(t)),
		Shown::Del(t)	=> fmt!("{{\"k\":\"-\",\"t\":\"{}\"}}", json_escape(t)),
		Shown::Add(t)	=> fmt!("{{\"k\":\"+\",\"t\":\"{}\"}}", json_escape(t)),
		Shown::Skip(n)	=> fmt!("{{\"k\":\"~\",\"n\":{}}}", n),
	}).collect();
	fmt!("{{\"keeper\":\"{}\",\"path\":\"{}\",\"turn\":\"{}\",\"act\":\"{}\",\"to\":\"{}\",\
		\"add\":{},\"del\":{},\"more\":{},\"text\":{},\"wait\":{},\"rows\":[{}]}}",
		json_escape(keeper), json_escape(path), json_escape(turn), change.act(), to,
		d.add, d.del, d.more, d.text, WAIT_MS, rows.join(","))
}


#[cfg(test)]
#[path = "../tests/unit/held_change/tests.rs"]
mod tests;
