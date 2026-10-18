//! The Diamond's activity record: one line per settled daimon turn, written by the engine
//! (UNBLOCK-11 F2, design (2) §3 row -11 and §5).
//!
//! **What it is for.** The owner: *"the whole point of diamonds is that they remember things
//! ... we have to improve shorter term incidental memory retention."* What a turn built or
//! changed used to survive only in the model session of the device that ran it, so a daimon on
//! another device, or after a fold, did not know a widget had been made the day before. The
//! record is a fact of the Diamond, not of any device's session: the engine writes it, never
//! the model, and every turn's prompt loads it by recency.
//!
//! **Single writer per file.** Each device appends only to its own
//! `.daimond/activity/<device>.log`, so the file sync that carries a Diamond today cannot lose a
//! line to a second writer, and the reader merges every device's file by stamp. Identity is
//! `(at, dev)` for a turn line and `(day, dev)` for a compacted day line, so a file met twice
//! (an arrival joined with the local copy) holds each line once.
//!
//! **Bound and shed (§5).** The last [`FULL_DAYS`] days are kept a line per turn; days 8 to
//! [`KEEP_DAYS`] are compacted to one line per day per device; older lines drop. Age is read
//! from the line's own stamp until the carrier gives receipt time. In the prompt the record
//! loads newest first up to [`PROMPT_CAP`] bytes, the rest reachable by `recall`. A day line is
//! capped at [`DAY_LINE_CAP`] bytes (a door that compaction never reaches: a turn line is at most
//! about 1.2 KiB and a day holds what one device can run in a day).
//!
//! Pure: the OPFS edge is in [`crate::wasm::diamond`], so this is tested natively.

use crate::llm::{extract_json_number, extract_json_string, extract_json_string_array, json_escape};

use oxedyne_fe2o3_core::prelude::*;


/// Where a Diamond keeps its activity files, under its own directory.
pub const ACTIVITY_DIR: &str = ".daimond/activity";
/// The most bytes of the record a prompt carries.
pub const PROMPT_CAP: usize = 8 * 1024;
/// The days kept a line per turn.
pub const FULL_DAYS: i64 = 7;
/// The days kept at all; older lines drop.
pub const KEEP_DAYS: i64 = 90;
/// The most bytes one compacted day line's text may reach.
pub const DAY_LINE_CAP: usize = 64 * 1024;
/// What one turn line keeps of the request, in characters.
const ASKED_CAP: usize = 300;
/// What one turn line keeps of the answer's first line, in characters.
const SAID_CAP: usize = 240;
/// The files one turn line names; the rest are counted.
const FILES_KEPT: usize = 8;
/// What one file name may carry, in characters.
const FILE_CAP: usize = 160;
/// What a device id may carry, in characters (and what a file name built from it may).
const DEV_CAP: usize = 64;
/// Milliseconds in a day.
const DAY_MS: i64 = 86_400_000;


/// One settled turn.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Turn {
	/// When it settled, ms since the epoch (UTC).
	pub at:    i64,
	/// The device that ran it.
	pub dev:   String,
	/// The version it minted, where it changed anything.
	pub v:     Option<u64>,
	/// What was asked, clipped.
	pub asked: String,
	/// The files it changed, the first [`FILES_KEPT`].
	pub files: Vec<String>,
	/// How many more it changed.
	pub more:  u64,
	/// The answer's first line, clipped.
	pub said:  String,
}

/// One device's turns of one day older than [`FULL_DAYS`], folded to a line.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Day {
	/// The day, as days since the epoch (UTC).
	pub day:  i64,
	/// The latest stamp it holds, which orders it.
	pub at:   i64,
	/// The device whose turns these were.
	pub dev:  String,
	/// How many turns it folds.
	pub n:    u64,
	/// What they asked and changed, joined, at most [`DAY_LINE_CAP`] bytes.
	pub text: String,
}

/// A line of the record.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Entry {
	Turn(Turn),
	Day(Day),
}

impl Entry {
	/// The stamp the record is ordered by.
	pub fn at(&self) -> i64 {
		match self {
			Entry::Turn(t) => t.at,
			Entry::Day(d)  => d.at,
		}
	}

	/// The device that wrote it.
	pub fn dev(&self) -> &str {
		match self {
			Entry::Turn(t) => &t.dev,
			Entry::Day(d)  => &d.dev,
		}
	}

	/// The line's identity: two copies of one line are one line.
	fn key(&self) -> (u8, i64, String) {
		match self {
			Entry::Turn(t) => (0, t.at, t.dev.clone()),
			Entry::Day(d)  => (1, d.day, d.dev.clone()),
		}
	}
}

/// `s` cut to at most `n` characters on one line, an ellipsis marking the cut.
fn clip(s: &str, n: usize) -> String {
	let flat: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
	if flat.chars().count() <= n {
		return flat;
	}
	let mut out: String = flat.chars().take(n.saturating_sub(1)).collect();
	out.push('\u{2026}');
	out
}

/// `s` cut to at most `n` bytes on a character boundary.
fn clip_bytes(s: &str, n: usize) -> &str {
	if s.len() <= n {
		return s;
	}
	let mut end = n;
	while end > 0 && !s.is_char_boundary(end) {
		end -= 1;
	}
	&s[..end]
}

/// The device id as a file leaf: letters, digits, `-` and `_`, never empty.
pub fn device_leaf(dev: &str) -> String {
	let out: String = dev.chars()
		.filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
		.take(DEV_CAP)
		.collect();
	if out.is_empty() { "device".to_string() } else { out }
}

/// The path of `dev`'s activity file, relative to the Diamond's directory.
pub fn file_rel(dev: &str) -> String {
	fmt!("{}/{}.log", ACTIVITY_DIR, device_leaf(dev))
}

/// Whether `rel`, relative to a Diamond's directory, is an activity file.
pub fn is_activity_rel(rel: &str) -> bool {
	rel.strip_prefix(ACTIVITY_DIR)
		.and_then(|r| r.strip_prefix('/'))
		.map(|leaf| !leaf.is_empty() && !leaf.contains('/') && leaf.ends_with(".log"))
		.unwrap_or(false)
}

impl Turn {
	/// One settled turn, its fields clipped to their bounds.
	///
	/// # Arguments
	/// * `at` - When it settled, ms since the epoch.
	/// * `dev` - The device that ran it.
	/// * `v` - The version it minted, if it changed anything.
	/// * `asked` - What the person asked, as typed.
	/// * `files` - The paths it changed.
	/// * `said` - The answer; its first non-empty line is kept.
	pub fn new(at: i64, dev: &str, v: Option<u64>, asked: &str, files: &[String], said: &str) -> Self {
		let first = said.lines().map(|l| l.trim()).find(|l| !l.is_empty()).unwrap_or("");
		Self {
			at,
			dev:   device_leaf(dev),
			v,
			asked: clip(asked, ASKED_CAP),
			files: files.iter().take(FILES_KEPT).map(|f| clip(f, FILE_CAP)).collect(),
			more:  files.len().saturating_sub(FILES_KEPT) as u64,
			said:  clip(first, SAID_CAP),
		}
	}

	/// The turn as a day line's part: the version, what was asked, the files.
	fn brief(&self) -> String {
		let mut s = String::new();
		if let Some(v) = self.v {
			s.push_str(&fmt!("v{} ", v));
		}
		s.push_str(&clip(&self.asked, 120));
		if !self.files.is_empty() {
			s.push_str(&fmt!(" [{}]", self.files.join(", ")));
		}
		s
	}
}

/// The line `e` is stored as.
pub fn encode(e: &Entry) -> String {
	match e {
		Entry::Turn(t) => {
			let files: Vec<String> = t.files.iter().map(|f| fmt!("\"{}\"", json_escape(f))).collect();
			fmt!("{{\"at\":{},\"dev\":\"{}\",\"v\":{},\"asked\":\"{}\",\"files\":[{}],\"more\":{},\"said\":\"{}\"}}",
				t.at.max(0), json_escape(&t.dev), t.v.unwrap_or(0), json_escape(&t.asked),
				files.join(","), t.more, json_escape(&t.said))
		},
		Entry::Day(d) => fmt!("{{\"day\":{},\"at\":{},\"dev\":\"{}\",\"n\":{},\"text\":\"{}\"}}",
			d.day.max(0), d.at.max(0), json_escape(&d.dev), d.n, json_escape(&d.text)),
	}
}

/// The entry a stored line holds, or `None` for a line this build cannot read (kept out of the
/// prompt, never a failure: a file met from a later build still loads what it can).
pub fn decode(line: &str) -> Option<Entry> {
	let line = line.trim();
	if !line.starts_with('{') {
		return None;
	}
	let (at, dev) = match (extract_json_number(line, "at"), extract_json_string(line, "dev")) {
		(Some(at), Some(dev)) => (at as i64, dev),
		_                     => return None,
	};
	if let Some(day) = extract_json_number(line, "day") {
		return Some(Entry::Day(Day {
			day:  day as i64,
			at,
			dev,
			n:    extract_json_number(line, "n").unwrap_or(0),
			text: extract_json_string(line, "text").unwrap_or_default(),
		}));
	}
	let v = extract_json_number(line, "v").filter(|v| *v > 0);
	Some(Entry::Turn(Turn {
		at,
		dev,
		v,
		asked: extract_json_string(line, "asked").unwrap_or_default(),
		files: extract_json_string_array(line, "files").unwrap_or_default(),
		more:  extract_json_number(line, "more").unwrap_or(0),
		said:  extract_json_string(line, "said").unwrap_or_default(),
	}))
}

/// Every readable entry of one file's text.
pub fn parse(text: &str) -> Vec<Entry> {
	text.lines().filter_map(decode).collect()
}

/// The age of a stamp in whole days at `now`.
fn age_days(at: i64, now: i64) -> i64 {
	(now - at).max(0) / DAY_MS
}

/// The entries, shed for `now`: within [`FULL_DAYS`] kept as they are; days 8 to [`KEEP_DAYS`]
/// folded into one day line per (day, device); older dropped. One copy of each line, ordered by
/// stamp then device.
///
/// **A day line held is the owner's fold of that day, and supersedes every turn line of it up to
/// its stamp** (C2 r2 F1). The owner is the file's single writer, so its day line is a superset
/// of the turns any other copy holds of that day to then; folding those turns in as well counted
/// each twice. **Of two day lines for one (day, device) the larger `n` wins, then the later
/// `at`** (C2 r2 F2): a copy folded before a late turn arrived holds fewer, and first-met-wins
/// lost that turn for good.
pub fn shed(entries: Vec<Entry>, now: i64) -> Vec<Entry> {
	use std::collections::{BTreeMap, BTreeSet};
	let mut keep: Vec<Entry> = Vec::new();
	let mut held: BTreeMap<(i64, String), Day> = BTreeMap::new();
	let mut turns: Vec<Turn> = Vec::new();
	let mut seen = BTreeSet::new();
	for e in entries {
		// A turn line met twice is one; two day lines of one key are weighed below.
		if matches!(e, Entry::Turn(_)) && !seen.insert(e.key()) {
			continue;
		}
		if age_days(e.at(), now) >= KEEP_DAYS {
			continue;
		}
		match e {
			Entry::Day(d) => {
				let key = (d.day, d.dev.clone());
				let wins = match held.get(&key) {
					Some(h) => (d.n, d.at) > (h.n, h.at),
					None    => true,
				};
				if wins {
					held.insert(key, d);
				}
			},
			Entry::Turn(t) => turns.push(t),
		}
	}
	// A held day line covers every turn of its (day, device) up to its own stamp: those are in
	// its fold. A later turn of that day (the day's last turns age past FULL_DAYS after its first
	// did) is folded into it. Turns folded in stamp order, so a day's text does not depend on
	// which copy was met first.
	let cover: BTreeMap<(i64, String), i64> = held.iter().map(|(k, d)| (k.clone(), d.at)).collect();
	turns.sort_by(|a, b| a.at.cmp(&b.at).then_with(|| a.dev.cmp(&b.dev)));
	let mut folded = held;
	for t in turns {
		let day = t.at.max(0) / DAY_MS;
		let key = (day, t.dev.clone());
		if cover.get(&key).map_or(false, |at| t.at <= *at) {
			continue;
		}
		if age_days(t.at, now) < FULL_DAYS {
			keep.push(Entry::Turn(t));
			continue;
		}
		let slot = folded.entry(key).or_insert_with(|| Day {
			day, at: t.at, dev: t.dev.clone(), n: 0, text: String::new() });
		slot.n += 1;
		slot.at = slot.at.max(t.at);
		let part = t.brief();
		let joined = if slot.text.is_empty() { part } else { fmt!("{}; {}", slot.text, part) };
		slot.text = clip_bytes(&joined, DAY_LINE_CAP).to_string();
	}
	keep.extend(folded.into_values().map(Entry::Day));
	keep.sort_by(|a, b| a.at().cmp(&b.at()).then_with(|| a.dev().cmp(b.dev())));
	keep
}

/// This device's file after one more turn: the old text, the turn, shed for `now`.
///
/// # Arguments
/// * `old` - The file as stored, empty for none.
/// * `turn` - The turn that settled.
/// * `now` - The time, ms since the epoch.
pub fn append(old: &str, turn: Turn, now: i64) -> String {
	let mut all = parse(old);
	all.push(Entry::Turn(turn));
	let mut out = String::new();
	for e in shed(all, now) {
		out.push_str(&encode(&e));
		out.push('\n');
	}
	out
}

/// Two copies of one device's file joined: every line either holds, once, shed for `now`.
/// What an arriving Diamond does with an activity file this device also holds, so a pull
/// never takes a line the other copy did not know.
pub fn join(mine: &str, theirs: &str, now: i64) -> String {
	let mut all = parse(mine);
	all.extend(parse(theirs));
	let mut out = String::new();
	for e in shed(all, now) {
		out.push_str(&encode(&e));
		out.push('\n');
	}
	out
}

/// Every device's file merged into one record, ordered by stamp, shed for `now`.
pub fn merge(files: &[String], now: i64) -> Vec<Entry> {
	let mut all = Vec::new();
	for text in files {
		all.extend(parse(text));
	}
	shed(all, now)
}

/// A stamp as `YYYY-MM-DD HH:MM` (UTC).
fn when(at: i64) -> String {
	let (y, m, d) = civil(at.max(0) / DAY_MS);
	let secs = (at.max(0) % DAY_MS) / 1000;
	fmt!("{:04}-{:02}-{:02} {:02}:{:02}", y, m, d, secs / 3600, (secs / 60) % 60)
}

/// A day number as `YYYY-MM-DD`.
fn day_name(day: i64) -> String {
	let (y, m, d) = civil(day);
	fmt!("{:04}-{:02}-{:02}", y, m, d)
}

/// The civil date of a day count since 1970-01-01 (proleptic Gregorian).
fn civil(z: i64) -> (i64, i64, i64) {
	let z = z + 719_468;
	let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
	let doe = z - era * 146_097;
	let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
	let y = yoe + era * 400;
	let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
	let mp = (5 * doy + 2) / 153;
	let d = doy - (153 * mp + 2) / 5 + 1;
	let m = if mp < 10 { mp + 3 } else { mp - 9 };
	(if m <= 2 { y + 1 } else { y }, m, d)
}

/// One entry as the model and `recall` read it.
pub fn render(e: &Entry) -> String {
	match e {
		Entry::Turn(t) => {
			let mut s = when(t.at);
			if let Some(v) = t.v {
				s.push_str(&fmt!(" v{}", v));
			}
			s.push_str(&fmt!(" ({}) asked: {}", clip(&t.dev, 12), t.asked));
			if !t.files.is_empty() {
				s.push_str(&fmt!(" | changed: {}", t.files.join(", ")));
				if t.more > 0 {
					s.push_str(&fmt!(" and {} more", t.more));
				}
			}
			if !t.said.is_empty() {
				s.push_str(&fmt!(" | said: {}", t.said));
			}
			s
		},
		Entry::Day(d) => fmt!("{} ({}, {} turn{}): {}", day_name(d.day), clip(&d.dev, 12), d.n,
			if d.n == 1 { "" } else { "s" }, d.text),
	}
}

/// The record as the prompt carries it: newest first, whole lines only, at most `cap` bytes,
/// saying how many older lines `recall` still reaches. Empty for an empty record.
///
/// # Arguments
/// * `entries` - The merged record ([`merge`]).
/// * `cap` - The most bytes, [`PROMPT_CAP`] in a turn.
pub fn prompt_block(entries: &[Entry], cap: usize) -> String {
	if entries.is_empty() {
		return String::new();
	}
	let head = "\n\nRecent activity in this Diamond, newest first, from every device (written by \
		the app at the end of each turn; recall searches all of it):\n";
	let mut out = String::from(head);
	let mut shown = 0usize;
	for e in entries.iter().rev() {
		let line = fmt!("- {}\n", render(e));
		// The footer's room is kept, so the block never passes the cap.
		if out.len() + line.len() + 80 > cap {
			break;
		}
		out.push_str(&line);
		shown += 1;
	}
	let left = entries.len() - shown;
	if left > 0 {
		out.push_str(&fmt!("({} older line{} not shown; recall finds them.)\n", left,
			if left == 1 { "" } else { "s" }));
	}
	out
}

/// The turn a steering turn's end records, settled or failed: every turn that ran gets its
/// line, so a turn that died part-way still says what it was asked and what it changed.
///
/// # Arguments
/// * `at` - When it ended, ms since the epoch.
/// * `dev` - The device that ran it.
/// * `version` - The version it minted and the files it recorded, where it recorded any.
/// * `asked` - What the person typed.
/// * `said` - The turn's last answer, empty for none.
/// * `failed` - Why the turn failed, `None` for a turn that settled.
pub fn ended(
	at:      i64,
	dev:     &str,
	version: Option<(u64, &[String])>,
	asked:   &str,
	said:    &str,
	failed:  Option<&str>,
)
	-> Turn
{
	let first = said.lines().map(|l| l.trim()).find(|l| !l.is_empty()).unwrap_or("");
	let said = match failed {
		None                          => first.to_string(),
		Some(why) if first.is_empty() => fmt!("(failed) {}", why.trim()),
		Some(_)                       => fmt!("(failed part-way) {}", first),
	};
	match version {
		Some((v, files)) => Turn::new(at, dev, Some(v), asked, files, &said),
		None             => Turn::new(at, dev, None, asked, &[], &said),
	}
}

/// The block a daimon's prompt carries: every device's file merged, newest first, at most
/// [`PROMPT_CAP`] bytes. Empty where there is no record.
///
/// # Arguments
/// * `files` - The text of every activity file of the Diamond.
/// * `now` - The time, ms since the epoch.
pub fn prompt_from(files: &[String], now: i64) -> String {
	prompt_block(&merge(files, now), PROMPT_CAP)
}

/// The activity files a Diamond holds after a pull: every file the export carried, joined with
/// this device's copy where it has one, and every file of this device's the export lacked, kept
/// as it was. A pull lays the export down over a deleted tree, so without this a device's own
/// lines not yet carried out would go with it.
///
/// # Arguments
/// * `local` - `(rel, text)` of every activity file here before the pull.
/// * `arriving` - `(rel, text)` of every activity file the export carries.
/// * `now` - The time, ms since the epoch.
pub fn after_import(local: &[(String, String)], arriving: &[(String, String)], now: i64)
	-> Vec<(String, String)>
{
	let mut out: Vec<(String, String)> = Vec::new();
	for (rel, theirs) in arriving {
		let mine = local.iter().find(|(r, _)| r == rel).map(|(_, t)| t.as_str()).unwrap_or("");
		out.push((rel.clone(), join(mine, theirs, now)));
	}
	for (rel, mine) in local {
		if !arriving.iter().any(|(r, _)| r == rel) {
			out.push((rel.clone(), mine.clone()));
		}
	}
	out
}

/// The whole record as numbered text for `recall`, oldest first.
pub fn recall_text(entries: &[Entry]) -> String {
	let mut out = String::new();
	for e in entries {
		out.push_str(&render(e));
		out.push('\n');
	}
	out
}


#[cfg(test)]
mod tests {
	use super::*;

	const NOW: i64 = 1_792_000_000_000;		// 2026-10-14 (UTC), a fixed clock

	fn turn(at: i64, dev: &str, asked: &str) -> Turn {
		Turn::new(at, dev, Some(7), asked, &["diamonds/d/crystal.html".to_string()], "Done.")
	}

	#[test]
	fn a_line_reads_back_as_written() {
		let t = Turn::new(NOW, "dev-A", Some(115), "gym set: \"sideways\" drum\npicker",
			&["diamonds/d/crystal.html".to_string(), "diamonds/d/mockups/w.html".to_string()],
			"\nBuilt the sideways drum picker.\nMore detail.");
		let line = encode(&Entry::Turn(t.clone()));
		assert!(!line.contains('\n'), "one line: {}", line);
		assert_eq!(Some(Entry::Turn(t.clone())), decode(&line));
		assert_eq!("Built the sideways drum picker.", t.said);
		assert_eq!("gym set: \"sideways\" drum picker", t.asked);
	}

	#[test]
	fn an_unreadable_line_is_skipped_not_fatal() {
		let good = encode(&Entry::Turn(turn(NOW, "A", "x")));
		let text = fmt!("garbage\n{{\"half\":\n{}\n", good);
		assert_eq!(1, parse(&text).len());
	}

	#[test]
	fn two_devices_merge_by_stamp_and_a_line_met_twice_is_one() {
		let a = append(&append("", turn(NOW - 3_000, "A", "first"), NOW), turn(NOW - 1_000, "A", "third"), NOW);
		let b = append("", turn(NOW - 2_000, "B", "second"), NOW);
		let all = merge(&[a.clone(), b.clone(), a.clone()], NOW);
		let asked: Vec<String> = all.iter().map(|e| match e { Entry::Turn(t) => t.asked.clone(), _ => String::new() }).collect();
		assert_eq!(vec!["first", "second", "third"], asked);
	}

	#[test]
	fn the_join_of_two_copies_loses_no_line() {
		let base = append("", turn(NOW - 5_000, "A", "one"), NOW);
		let mine = append(&base, turn(NOW - 1_000, "A", "two"), NOW);
		let theirs = base.clone();
		let joined = join(&mine, &theirs, NOW);
		assert_eq!(2, parse(&joined).len());
		assert_eq!(joined, join(&theirs, &mine, NOW), "the join does not depend on the side");
	}

	#[test]
	fn days_eight_to_ninety_compact_and_older_drop() {
		let old = NOW - 10 * DAY_MS;
		let mut text = String::new();
		for i in 0..3 {
			text = append(&text, turn(old + i * 60_000, "A", &fmt!("old {}", i)), NOW);
		}
		text = append(&text, turn(NOW - 100 * DAY_MS, "A", "ancient"), NOW);
		text = append(&text, turn(NOW - 1_000, "A", "fresh"), NOW);
		let all = parse(&text);
		assert_eq!(2, all.len(), "one day line and one fresh line: {:?}", all);
		match &all[0] {
			Entry::Day(d) => {
				assert_eq!(3, d.n);
				assert!(d.text.contains("old 0") && d.text.contains("old 2"), "{}", d.text);
			},
			other => panic!("not a day line: {:?}", other),
		}
		assert!(!text.contains("ancient"));
		// A day line met again joins rather than doubling.
		let again = join(&text, &text, NOW);
		assert_eq!(text, again);
	}

	#[test]
	fn the_prompt_is_newest_first_and_capped_at_eight_kib() {
		let mut a = String::new();
		let mut b = String::new();
		for i in 0..200 {
			let t = Turn::new(NOW - (400 - i) * 60_000, if i % 2 == 0 { "A" } else { "B" }, Some(i as u64 + 1),
				&fmt!("turn {} {}", i, "x".repeat(200)), &["diamonds/d/crystal.html".to_string()], "ok");
			if i % 2 == 0 { a = append(&a, t, NOW); } else { b = append(&b, t, NOW); }
		}
		let all = merge(&[a, b], NOW);
		let block = prompt_block(&all, PROMPT_CAP);
		assert!(block.len() <= PROMPT_CAP, "{} bytes", block.len());
		let first = block.find("turn 199 ").unwrap_or(usize::MAX);
		let second = block.find("turn 198 ").unwrap_or(usize::MAX);
		assert!(first < second, "newest first");
		assert!(block.contains("recall finds them"), "says the rest is reachable");
		assert!(!block.contains("turn 0 "), "the oldest did not fit");
	}

	/// Diag §4 check (a)-(c), the record's half: a widget built on A two days ago is in B's prompt
	/// by name and path, from A's file alone, whatever B's session holds.
	#[test]
	fn the_widget_built_on_another_device_is_in_the_prompt() {
		let a = append("", Turn::new(NOW - 2 * DAY_MS, "A", Some(115),
			"make a sideways slider widget for the gym set",
			&["diamonds/d/crystal.html".to_string(), "diamonds/d/mockups/w.html".to_string()],
			"Built the sideways drum picker."), NOW);
		let block = prompt_block(&merge(&[a, String::new()], NOW), PROMPT_CAP);
		assert!(block.contains("mockups/w.html") && block.contains("crystal.html")
			&& block.contains("sideways drum picker"), "{}", block);
	}

	#[test]
	fn activity_paths_are_recognised() {
		assert!(is_activity_rel(".daimond/activity/abc.log"));
		assert!(!is_activity_rel(".daimond/activity/x/abc.log"));
		assert!(!is_activity_rel(".daimond/steering.md"));
		assert_eq!(".daimond/activity/ab-b_c.log", file_rel("a/b.-b_c"));
		assert_eq!("2026-10-14", day_name(NOW / DAY_MS));
		assert_eq!("2024-10-04", day_name(20_000));
	}

	#[test]
	fn a_settled_turn_appends_one_line() {
		let files = vec!["widgets/clock.html".to_string()];
		let old = append("", turn(NOW - 9_000, "A", "earlier"), NOW);
		let t = ended(NOW - 1_000, "A", Some((12, &files)), "build a clock widget",
			"Built the clock.\nMore detail.", None);
		let new = append(&old, t, NOW);
		assert_eq!(old.lines().count() + 1, new.lines().count());
		let last = render(parse(&new).last().expect("a line"));
		assert!(last.contains("v12") && last.contains("widgets/clock.html")
			&& last.contains("said: Built the clock."), "{}", last);
	}

	#[test]
	fn a_failed_turn_appends_one_line_too() {
		let old = append("", turn(NOW - 9_000, "A", "earlier"), NOW);
		let t = ended(NOW - 1_000, "A", None, "fix the page", "", Some("the provider timed out"));
		let new = append(&old, t, NOW);
		assert_eq!(old.lines().count() + 1, new.lines().count());
		let last = render(parse(&new).last().expect("a line"));
		assert!(last.contains("(failed) the provider timed out"), "{}", last);
		let part = ended(NOW, "A", None, "go", "Half done", Some("stopped"));
		assert_eq!("(failed part-way) Half done", part.said);
	}

	#[test]
	fn the_prompt_carries_every_device_merged_within_eight_kib() {
		let mut a = String::new();
		let mut b = String::new();
		for i in 0..200 {
			a = append(&a, turn(NOW - 1_000_000 + i * 1_000, "A", &fmt!("a-turn {} {}", i, "x".repeat(60))), NOW);
			b = append(&b, turn(NOW - 999_500 + i * 1_000, "B", &fmt!("b-turn {}", i)), NOW);
		}
		let block = prompt_from(&[a, b], NOW);
		assert!(block.len() <= PROMPT_CAP, "{} bytes", block.len());
		assert!(block.contains("a-turn 199") && block.contains("b-turn 199"), "both devices, newest");
		assert!(!block.contains("a-turn 0 "), "the oldest is left to recall");
		assert!(block.contains("recall finds them"));
		assert!(prompt_from(&[], NOW).is_empty());
	}

	#[test]
	fn a_pull_keeps_a_local_file_the_export_lacks_and_joins_one_it_has() {
		let mine_a = append("", turn(NOW - 3_000, "A", "local only line"), NOW);
		let base_b = append("", turn(NOW - 5_000, "B", "b one"), NOW);
		let mine_b = append(&base_b, turn(NOW - 2_000, "B", "b two not yet carried"), NOW);
		let theirs_b = append(&base_b, turn(NOW - 1_000, "B", "b three from there"), NOW);
		let local = vec![(file_rel("A"), mine_a.clone()), (file_rel("B"), mine_b)];
		let arriving = vec![(file_rel("B"), theirs_b)];
		let out = after_import(&local, &arriving, NOW);
		assert_eq!(2, out.len());
		let a = out.iter().find(|(r, _)| *r == file_rel("A")).expect("A kept");
		assert_eq!(mine_a, a.1);
		let b = out.iter().find(|(r, _)| *r == file_rel("B")).expect("B joined");
		assert_eq!(3, parse(&b.1).len(), "{}", b.1);
	}

	/// C2 r2 F1: A's day held as turn lines on B, then A's own day line arriving, is counted once.
	#[test]
	fn a_day_line_replaces_that_devices_turn_lines_for_that_day() {
		let old = NOW - 10 * DAY_MS;
		// B pulled A's turns while they were fresh, so B holds them as turn lines.
		let mut raw = String::new();
		for i in 0..3 {
			raw.push_str(&encode(&Entry::Turn(turn(old + i * 60_000, "A", &fmt!("t{}", i)))));
			raw.push('\n');
		}
		// A compacted its own day.
		let a_own = join(&raw, "", NOW);
		let a_n = match &parse(&a_own)[0] { Entry::Day(d) => d.n, other => panic!("{:?}", other) };
		assert_eq!(3, a_n);
		for (mine, theirs) in [(&raw, &a_own), (&a_own, &raw)] {
			let b = join(mine, theirs, NOW);
			let all = parse(&b);
			assert_eq!(1, all.len(), "{}", b);
			match &all[0] {
				Entry::Day(d) => {
					assert_eq!(3, d.n, "counted once: {}", b);
					assert_eq!(1, d.text.matches("t0").count(), "{}", d.text);
				},
				other => panic!("not a day line: {:?}", other),
			}
		}
	}

	/// C2 r2 F2: of two day lines for one (day, dev), the larger n wins, whichever is met first.
	#[test]
	fn of_two_day_lines_the_larger_wins() {
		let old = NOW - 10 * DAY_MS;
		let mut two = String::new();
		let mut three = String::new();
		for i in 0..3 {
			let line = fmt!("{}\n", encode(&Entry::Turn(turn(old + i * 60_000, "A", &fmt!("t{}", i)))));
			if i < 2 { two.push_str(&line); }
			three.push_str(&line);
		}
		let short = join(&two, "", NOW);
		let full = join(&three, "", NOW);
		for (mine, theirs) in [(&short, &full), (&full, &short)] {
			let all = parse(&join(mine, theirs, NOW));
			assert_eq!(1, all.len());
			match &all[0] {
				Entry::Day(d) => {
					assert_eq!(3, d.n, "the third turn of the day is kept");
					assert!(d.text.contains("t2"), "{}", d.text);
				},
				other => panic!("not a day line: {:?}", other),
			}
		}
	}

	/// C2 r2 F5: the append's read-modify-write is under the Diamond's version hold, the lock
	/// `import_diamond` holds across its read, delete and rewrite of the activity files, so a pull
	/// landing in the middle cannot drop the turn's line. The OPFS edge is wasm, so this reads the
	/// source: the append takes the hold before it reads.
	#[test]
	fn the_append_is_under_the_version_hold() {
		let src = include_str!("wasm/diamond.rs");
		let at = src.find("pub async fn activity_append(").unwrap_or(src.len());
		let body = &src[at..];
		let end = body.find("\n}\n").unwrap_or(body.len());
		let body = &body[..end];
		let hold = body.find("hold_versions(id)").unwrap_or(usize::MAX);
		let read = body.find("opfs::read_file").unwrap_or(0);
		assert!(hold < read, "activity_append holds the version store before it reads: {}", body);
	}
}
