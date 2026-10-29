//! `STATE.md` as keyed sections: the one owner of the file, and the end of its refusal.
//!
//! **UNBLOCK-18 (D-20261015-21).**  `STATE.md` was one 4 KiB file overwritten whole, and a write
//! over the line was REFUSED.  Daimons use it as a running log, so in thirty turns on one device
//! it was refused 32 times: the model trimmed, overshot by a few bytes, and tried again, each
//! round paid for and nothing landed.  Raising the ceiling only moves the storm.
//!
//! So the file is now a list of keyed sections -- the text above the first `## ` heading, then
//! one section per `## ` heading, keyed by the heading's words -- and it is RENDERED from them.
//! Every door that writes it comes through [`land`]: `state_set`, the daimon's own `file_write`
//! and `file_edit`, and a context fold.  None of them is refused for size:
//!
//! - **A section over [`SECTION_CAP`]**, changed or not, keeps its first 2 KiB in the file with a
//!   pointer, and only the bytes beyond that head go to the archive, with no DECISIONS line.
//! - **A section the write takes out** (an empty `state_set`, or left out of a whole-file write) is
//!   archived whole and dated.
//! - **A file over [`crate::tools::STATE_CAP`]** retires its OLDEST-TOUCHED sections, whole, to
//!   `.daimond/decisions-archive.md` until it fits, and each retirement is one dated line in
//!   `DECISIONS.md` -- one line, so the twenty-line window of that file is not flooded.
//!
//! Which section was touched when is the Diamond's own record, `.daimond/state-touched.tsv`: one
//! line per live section, `<ms>\t<key>`.  Bound: one line per section of a file that is itself
//! bounded at 4 KiB.  Shed: every landing rewrites it with only the keys the file still holds.
//! A key with no line (a file older than this, or a fold) counts as touched at 0, oldest, and
//! among equals the section higher in the file is the older.
//!
//! Pure, and proved without a browser; the store's I/O is `crate::wasm::diamond::standing_retired`.

use oxedyne_fe2o3_core::prelude::*;

use std::collections::BTreeMap;

/// What one section may weigh before its tail goes to the archive, in bytes.
pub const SECTION_CAP: usize = 2 * 1024;

/// Where the Diamond keeps when each section was last touched, under its own directory.
pub const TOUCHED_LEAF: &str = "state-touched.tsv";

/// The archive both `STATE.md` and `DECISIONS.md` retire into, as a Diamond-relative leaf.
pub const ARCHIVE_LEAF: &str = ".daimond/decisions-archive.md";

/// One keyed section of the file.
#[derive(Debug, Clone, PartialEq)]
pub struct Section {
	pub key:  String,	// the heading's words; empty for the text above the first heading
	pub text: String,	// the whole section, heading line included, ending in a newline
}

/// The section key a `## ` heading line names, or nothing for any other line.
fn heading_key(line: &str) -> Option<String> {
	let t = line.trim_end();
	match t.strip_prefix("## ") {
		Some(k) => Some(k.trim().to_string()),
		None    => None,
	}
}

/// The file as its sections, in order.  The text above the first heading, where there is any,
/// is the section with the empty key.  Lossless: [`render`] of the answer is the input, with a
/// final newline added where it had none.
pub fn parse(text: &str) -> Vec<Section> {
	let mut out: Vec<Section> = Vec::new();
	let mut cur = Section { key: String::new(), text: String::new() };
	for line in text.split_inclusive('\n') {
		if let Some(key) = heading_key(line) {
			if !cur.text.is_empty() || !cur.key.is_empty() {
				out.push(cur);
			}
			cur = Section { key, text: String::new() };
		}
		cur.text.push_str(line);
	}
	if !cur.text.is_empty() || !cur.key.is_empty() {
		out.push(cur);
	}
	for s in out.iter_mut() {
		if !s.text.ends_with('\n') {
			s.text.push('\n');
		}
	}
	out
}

/// The file the sections render to.
pub fn render(sections: &[Section]) -> String {
	sections.iter().map(|s| s.text.as_str()).collect()
}

/// The file with one section set: replaced where the key is there, added at the end where it is
/// not, and taken out where `body` is empty.  The heading is the engine's, so a body that opens
/// with its own `## <key>` line does not get it twice.
///
/// # Arguments
/// * `text` - The file as it stands.
/// * `key` - The section's heading words, without `## `; empty for the text above the first one.
/// * `body` - What goes under the heading.
pub fn set(text: &str, key: &str, body: &str) -> String {
	let key = key.trim().trim_start_matches('#').trim();
	let mut body = body.trim_matches('\n').to_string();
	if !key.is_empty() {
		if let Some(first) = body.lines().next() {
			if heading_key(first).as_deref() == Some(key) {
				body = body[first.len()..].trim_start_matches('\n').to_string();
			}
		}
	}
	let mut secs = parse(text);
	let at = secs.iter().position(|s| s.key == key);
	if body.trim().is_empty() {
		if let Some(i) = at {
			secs.remove(i);
		}
		return render(&secs);
	}
	let made = match key.is_empty() {
		true  => fmt!("{}\n\n", body),
		false => fmt!("## {}\n\n{}\n\n", key, body),
	};
	match at {
		Some(i) => secs[i].text = made,
		None if key.is_empty() => secs.insert(0, Section { key: String::new(), text: made }),
		None    => {
			if let Some(last) = secs.last_mut() {
				if !last.text.ends_with("\n\n") {
					last.text.push('\n');
				}
			}
			secs.push(Section { key: key.to_string(), text: made });
		},
	}
	render(&secs)
}

/// [`set`], taking out the section `replaces` in the same write (UNBLOCK-52): a section renamed,
/// say "Code base size" to "Code base size (2026-10-28)", is one landing, whole or not at all.
/// Two `state_set` calls made it two writes, and a second one declined or failed left both
/// sections standing.  The new section takes the old one's place in the file where it is not
/// already there; `replaces` naming `key`, or no section, is [`set`] alone.
///
/// # Arguments
/// * `text` - The file as it stands.
/// * `key` - The section's heading words.
/// * `body` - What goes under the heading; empty takes `key` out as well.
/// * `replaces` - The heading words of a section this write retires, if any.
pub fn set_replacing(text: &str, key: &str, body: &str, replaces: Option<&str>) -> String {
	let clean = |k: &str| k.trim().trim_start_matches('#').trim().to_string();
	let new = clean(key);
	let old = match replaces.map(clean) {
		Some(o) if o != new => o,
		_                   => return set(text, key, body),
	};
	let mut secs = parse(text);
	let at = match secs.iter().position(|s| s.key == old) {
		Some(i) => i,
		None    => return set(text, key, body),
	};
	match !body.trim().is_empty() && !secs.iter().any(|s| s.key == new) {
		// Its heading, so `set` below finds it there and writes the body in its place.
		true  => secs[at] = Section { text: fmt!("## {}\n\n", new), key: new },
		false => { secs.remove(at); },
	}
	set(&render(&secs), key, body)
}

/// The touched record as it is stored: `<ms>\t<key>` a line.  A line that does not read is
/// skipped; the record is a hint about age, and a damaged one makes a section look old, no more.
pub fn touched_parse(text: &str) -> BTreeMap<String, u64> {
	let mut out = BTreeMap::new();
	for line in text.lines() {
		let mut it = line.splitn(2, '\t');
		if let (Some(ms), Some(key)) = (it.next(), it.next()) {
			if let Ok(ms) = ms.trim().parse::<u64>() {
				out.insert(key.to_string(), ms);
			}
		}
	}
	out
}

/// The touched record as it is written.
pub fn touched_render(touched: &BTreeMap<String, u64>) -> String {
	touched.iter().map(|(k, ms)| fmt!("{}\t{}\n", ms, k)).collect()
}

/// What one landing of the file does.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Landing {
	pub kept:     String,			// the file as it is written, at most `STATE_CAP`
	pub archived: String,			// appended to the archive; empty when nothing moved
	pub noted:    Vec<String>,		// one dated line for `DECISIONS.md` per retirement
	pub touched:  BTreeMap<String, u64>,	// the touched record after this landing
	pub moved:    Vec<String>,		// the keys retired whole, oldest first
	pub cut:      Vec<String>,		// the keys whose tail went to the archive
	pub gone:     Vec<String>,		// the keys the write itself took out, archived whole
}

impl Landing {
	/// What the tool result says, or nothing where nothing moved.
	pub fn said(&self) -> String {
		if self.moved.is_empty() && self.cut.is_empty() && self.gone.is_empty() {
			return String::new();
		}
		let names = |v: &Vec<String>| v.iter().map(|k| fmt!("'{}'", shown(k)))
			.collect::<Vec<String>>().join(", ");
		let mut out = String::new();
		if !self.gone.is_empty() {
			out.push_str(&fmt!(
				"\nSTATE.md: section(s) {} left the file, so their text is in {}.",
				names(&self.gone), ARCHIVE_LEAF));
		}
		if !self.cut.is_empty() {
			out.push_str(&fmt!(
				"\nSTATE.md: section(s) {} were over {} bytes, so each keeps its head here with a \
				pointer and the rest is in {}.",
				names(&self.cut), SECTION_CAP, ARCHIVE_LEAF));
		}
		if !self.moved.is_empty() {
			out.push_str(&fmt!(
				"\nSTATE.md was over its {}-byte ceiling, so the {} oldest-touched section(s) {} \
				moved to {}, each with one dated line in DECISIONS.md.",
				crate::tools::STATE_CAP, self.moved.len(), names(&self.moved), ARCHIVE_LEAF));
		}
		out.push_str(" Nothing was deleted; recall and file_read still reach the archive.");
		out
	}
}

/// A key as a person reads it: the empty key is the file's opening text.
fn shown(key: &str) -> &str {
	if key.is_empty() { "(top)" } else { key }
}

/// Why a `state_set` call cannot be landed, or nothing where it can.
///
/// A call with no `text` at all is not one that empties its section: an argument the model left
/// out, or one that would not read, must not take a section out of the file.  A key across lines
/// would make a heading that never parses back to itself, so every call would add another.
///
/// # Arguments
/// * `key` - The `key` argument as it arrived.
/// * `text` - The `text` argument, or nothing where there was none.
pub fn set_refusal(key: &str, text: Option<&str>) -> Option<String> {
	if key.contains('\n') || key.contains('\r') {
		return Some("state_set: 'key' is one line, the heading's words. Nothing was written."
			.to_string());
	}
	if text.is_none() {
		return Some("state_set: 'text' is missing, so nothing was written. Send the section's \
			whole text, or \"\" to take the section out.".to_string());
	}
	None
}

/// The longest prefix of `text` within `cap` bytes, ended at a line where one is in reach.
fn head_of(text: &str, cap: usize) -> &str {
	if text.len() <= cap {
		return text;
	}
	let mut end = cap;
	while end > 0 && !text.is_char_boundary(end) {
		end -= 1;
	}
	let head = &text[..end];
	match head.rfind('\n') {
		Some(i) if i >= cap / 2 => &text[..=i],
		_                       => head,
	}
}

/// The pointer line a cut section ends in, without its blank lines.
fn pointer_line() -> String {
	fmt!("[... the rest of this section is in {}]", ARCHIVE_LEAF)
}

/// A `STATE.md` write as it lands: sections stamped, every key that leaves archived, oversized
/// sections cut, the file brought under its ceiling by retiring the oldest-touched sections.
/// Never refuses.
///
/// # Arguments
/// * `old` - The file as it stands; empty where there is none.
/// * `new` - What the write would leave.
/// * `touched` - The touched record as it stands.
/// * `now` - The landing's time, ms; every section this write changed is touched at it.
/// * `today` - `YYYY-MM-DD`, for the archive and the dated lines.
pub fn land(old: &str, new: &str, touched: &BTreeMap<String, u64>, now: u64, today: &str)
	-> Landing
{
	let olds = parse(old);
	let was: BTreeMap<String, String> = olds.iter()
		.map(|s| (s.key.clone(), s.text.clone())).collect();
	let mut secs = parse(new);
	let mut out = Landing::default();
	// Stamped first: a section this write changed is touched now, whatever it weighs.
	for s in secs.iter() {
		let ms = match was.get(&s.key) == Some(&s.text) {
			true  => touched.get(&s.key).copied().unwrap_or(0),
			false => now,
		};
		out.touched.insert(s.key.clone(), ms);
	}
	// A key the write took out -- emptied by `state_set`, or left out of a whole-file write -- is
	// archived whole: the writer's leaving it out is not the record's losing it.  No DECISIONS
	// line: the writer chose it, and the tool result names it.
	for s in olds.iter() {
		if out.touched.contains_key(&s.key) || s.text.trim().is_empty() {
			continue;
		}
		out.archived.push_str(&fmt!(
			"\n## STATE.md, section '{}', taken out {}\n\n{}\n",
			shown(&s.key), today, s.text.trim_end()));
		out.gone.push(s.key.clone());
	}
	// A section over its own bound keeps its head here, and only the bytes BEYOND that head go
	// to the archive -- the head is in the file, and a log that grows under its pointer sends
	// each new line once, not the whole head again every turn.  Every section, changed or not,
	// and the opening text with them: a file written by another door (a revert, a move, an
	// older device) can hold an oversized one, and left alone it would hold the file at its
	// ceiling and bounce every new section into the archive.  No DECISIONS line either: the
	// pointer already names the archive, and that file's window is for rulings.
	let ptr = pointer_line();
	let pointer = fmt!("\n{}\n\n", ptr);
	let room = SECTION_CAP.saturating_sub(pointer.len());
	for s in secs.iter_mut() {
		if s.text.len() <= SECTION_CAP {
			continue;
		}
		let clean: String = s.text.split_inclusive('\n')
			.filter(|l| l.trim() != ptr)
			.collect();
		let head = head_of(&clean, room);
		let tail = clean[head.len()..].trim_matches('\n');
		if !tail.trim().is_empty() {
			out.archived.push_str(&fmt!(
				"\n## STATE.md, section '{}', beyond its first {} bytes, {}\n\n{}\n",
				shown(&s.key), head.len(), today, tail));
			out.cut.push(s.key.clone());
		}
		s.text = fmt!("{}{}", head.trim_end_matches('\n'), pointer);
	}
	// Then the file under its ceiling, oldest-touched first.  The opening text is never retired:
	// cut to its own bound above, changed or not, it cannot hold the file over 4 KiB alone.
	loop {
		let size: usize = secs.iter().map(|s| s.text.len()).sum();
		if size <= crate::tools::STATE_CAP {
			break;
		}
		let pick = secs.iter().enumerate()
			.filter(|(_, s)| !s.key.is_empty())
			.min_by_key(|(i, s)| (out.touched.get(&s.key).copied().unwrap_or(0), *i))
			.map(|(i, _)| i);
		let i = match pick {
			Some(i) => i,
			None    => break,
		};
		let s = secs.remove(i);
		let ms = out.touched.remove(&s.key).unwrap_or(0);
		out.archived.push_str(&fmt!(
			"\n## STATE.md, section '{}', retired {}\n\n{}\n", s.key, today, s.text.trim_end()));
		out.noted.push(fmt!(
			"- {} STATE.md section '{}' ({} bytes{}) retired to {} to keep STATE.md under {} bytes.",
			today, s.key, s.text.len(),
			if ms == 0 { String::new() } else { fmt!(", touched {}", day_of(ms)) },
			ARCHIVE_LEAF, crate::tools::STATE_CAP));
		out.moved.push(s.key);
	}
	out.kept = render(&secs);
	out
}

/// What another device's copy of the archive holds that this one does not, to append here.
///
/// The archive is append-only on one device but not across sync: a two-sided import replaces
/// `.daimond/` whole, so the losing device's retirements would leave the only file `recall`
/// reaches (UNBLOCK-18 F4).  Joined by entry -- each `## ` block whole, and each loose line before
/// the first one -- and an entry already here, anywhere, is not added again.  A duplicate in an
/// append-only archive costs bytes, never content, so the join errs that way.  Until the carrier
/// (C11) makes it a Log kind.
///
/// # Arguments
/// * `here` - This device's archive, as it stands after the import.
/// * `there` - The loser's archive, read before the import replaced it.
pub fn archive_union(here: &str, there: &str) -> String {
	let mut entries: Vec<String> = Vec::new();
	let mut cur: Option<String> = None;
	for line in there.split_inclusive('\n') {
		if line.starts_with("## ") {
			if let Some(c) = cur.take() {
				entries.push(c);
			}
			cur = Some(line.to_string());
			continue;
		}
		match cur.as_mut() {
			Some(c) => c.push_str(line),
			None    => entries.push(line.to_string()),
		}
	}
	if let Some(c) = cur {
		entries.push(c);
	}
	let mut add = String::new();
	for e in entries {
		let t = e.trim();
		if t.is_empty() || here.contains(t) || add.contains(t) {
			continue;
		}
		add.push_str(&fmt!("\n{}\n", t));
	}
	add
}

/// `YYYY-MM-DD` of a UTC millisecond stamp.
fn day_of(ms: u64) -> String {
	// Days since 1970-01-01 to a civil date (Howard Hinnant's algorithm).
	let z = (ms / 86_400_000) as i64 + 719_468;
	let era = z.div_euclid(146_097);
	let doe = z - era * 146_097;
	let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
	let y = yoe + era * 400;
	let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
	let mp = (5 * doy + 2) / 153;
	let d = doy - (153 * mp + 2) / 5 + 1;
	let m = if mp < 10 { mp + 3 } else { mp - 9 };
	fmt!("{:04}-{:02}-{:02}", if m <= 2 { y + 1 } else { y }, m, d)
}

/// A `file_edit` of `STATE.md`, applied section by section.
///
/// **Not all or nothing, here and only here.**  Every other file refuses a call with one hunk
/// that will not place, so the model knows the file is untouched.  `STATE.md`'s sections have one
/// owner each and are independent: a hunk aimed at a section that changed under the call (the
/// fold, another device, the engine's own retirement) cannot place, and refusing the hunks aimed
/// at sections that did NOT change cost a round each for nothing.  So the hunks that place land,
/// and the answer names the ones that did not.
///
/// # Arguments
/// * `data` - The file as it stands.
/// * `hunks` - The find/replace pairs.
/// * `apply` - The ordinary all-or-nothing edit of one hunk, `file_edited`.
///
/// Answers the edited text and the 1-based numbers of the hunks that did not place with why, or
/// the first refusal where none placed.
pub fn edited_by_section<F>(data: &str, hunks: &[(String, String)], apply: F)
	-> Outcome<(String, Vec<String>)>
	where F: Fn(&str, &[(String, String)]) -> Outcome<String>
{
	let mut out = data.to_string();
	let mut missed = Vec::new();
	let mut first: Option<Error<ErrTag>> = None;
	for (i, h) in hunks.iter().enumerate() {
		match apply(&out, std::slice::from_ref(h)) {
			Ok(t)  => out = t,
			Err(e) => {
				missed.push(fmt!("{}: {}", i + 1, e));
				if first.is_none() {
					first = Some(e);
				}
			},
		}
	}
	if missed.len() == hunks.len() {
		if let Some(e) = first {
			return Err(e);
		}
	}
	Ok((out, missed))
}

#[cfg(test)]
#[path = "../tests/unit/state_md/tests.rs"]
mod tests;
