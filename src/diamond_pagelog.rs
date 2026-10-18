//! The record of which files in a Diamond are page logs: the paths a crystal page has APPENDED
//! to, one Diamond-relative path per LF line in `.daimond/pagelogs` (r547 page-log guard, PLB).
//!
//! A page log is a file whose lines are each a record a person made, so two devices that both
//! logged between syncs each hold rows the other lacks.  The import needs to know which files
//! those are before it can join them line by line rather than replace one copy with the other,
//! and a guess from the file's name or contents would be wrong in both directions.  So the one
//! door a page appends through writes the path here, and only an append does: a `replace` is a
//! whole-file save, which the import already carries correctly.
//!
//! Target-agnostic, so the rules are tested natively while the OPFS edge that writes the file
//! stays in [`crate::wasm::diamond`].
//!
//! The join (PLC) is planned here too, from bytes already read: an import that finds both
//! devices moved joins each recorded log as a multiset of rows ([`lineset::union_lines`]), and
//! a log it cannot read whole holds that Diamond's import back rather than replacing it.

use crate::diamond_versions::{hash_of, Cause, Manifest};
use crate::llm::json_escape;

use oxedyne_fe2o3_core::prelude::*;
use oxedyne_fe2o3_text::lineset;

/// Where the record lives, relative to the Diamond's directory.
pub const PAGELOGS_REL: &str = ".daimond/pagelogs";

/// The recorded paths, in the order they were first recorded.  Blank lines are not paths.
pub fn records(text: &str) -> Vec<&str> {
	text.split('\n').filter(|l| !l.is_empty()).collect()
}

/// The record with `rel` added at its end, or `None` when `rel` is already recorded and the file
/// need not be written at all.
pub fn with_path(text: &str, rel: &str) -> Option<String> {
	if records(text).iter().any(|r| *r == rel) {
		return None;
	}
	let mut out = String::with_capacity(text.len() + rel.len() + 2);
	out.push_str(text);
	if !out.is_empty() && !out.ends_with('\n') {
		out.push('\n');
	}
	out.push_str(rel);
	out.push('\n');
	Some(out)
}

/// May `rel` be recorded as a page log?
///
/// Only a plain relative path inside the Diamond's own files: never Daimond's store directory
/// (nor its pre-rename name, `.red`), never the version store, never a step outside, and never a
/// byte that would split or blur a line of the record.
pub fn is_recordable(rel: &str) -> bool {
	if rel.is_empty() || rel.starts_with('/') || rel.contains('\\') {
		return false;
	}
	if rel.chars().any(|c| c.is_control()) {
		return false;
	}
	match rel.split('/').next() {
		Some(".daimond") | Some(".red") | Some("versions") | None => return false,
		Some(_) => (),
	}
	rel.split('/').all(|p| !p.is_empty() && p != "." && p != "..")
}

/// The most one page log may weigh, on either side, for the import to join it.  A larger one,
/// like one this device cannot read, holds the Diamond's import back for the round
/// (r547 ruling R3): nothing is written, and the next round tries again.
pub const PAGELOG_JOIN_MAX: usize = 16 * 1024 * 1024;

/// One file of this device's, as the join found it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LocalLog {
	Body(Vec<u8>),
	Absent,
	Unreadable,
	TooBig,			// over [`PAGELOG_JOIN_MAX`]
}

/// This device's page-log record and the logs it read, each by its path inside the Diamond.  A
/// path not listed in `files` is taken to be absent here.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LocalLogs {
	pub record:	LocalLog,
	pub files:	Vec<(String, LocalLog)>,
}

impl LocalLogs {
	fn get(&self, rel: &str) -> &LocalLog {
		match self.files.iter().find(|(r, _)| r == rel) {
			Some((_, l))	=> l,
			None			=> &LocalLog::Absent,
		}
	}
}

/// One recorded file, joined.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LogJoin {
	pub rel:			String,
	pub bytes:			Vec<u8>,	// the join; byte for byte the arriving copy where here adds nothing
	pub was:			Option<Vec<u8>>,	// this device's copy, where it had one
	pub here_adds:		usize,		// rows only this device held
	pub arriving_adds:	usize,		// rows only the arriving copy held
}

/// The rows each side gave the other, and how many log files were written for them.  The page-log
/// record itself is not counted: its lines are paths, not anybody's entries.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Counts {
	pub files:		usize,
	pub here:		usize,
	pub arriving:	usize,
}

/// The joins of every recorded file, and of the record.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct Join {
	pub record:	Option<LogJoin>,	// None where neither side has a record
	pub logs:	Vec<LogJoin>,
}

impl Join {

	/// What an import lays down over the arriving copy: every file this device held rows of that
	/// the copy lacks, the record among them.
	pub fn import_writes(&self) -> Vec<(String, Vec<u8>)> {
		self.record.iter().chain(self.logs.iter())
			.filter(|j| j.here_adds > 0)
			.map(|j| (j.rel.clone(), j.bytes.clone()))
			.collect()
	}

	pub fn import_counts(&self) -> Counts {
		self.counts(|j| j.here_adds > 0)
	}

	/// What a join in place writes to this device: every file the arriving copy held rows of that
	/// this device lacks, the record among them (#8: nothing is written for a file that gains
	/// nothing here).
	pub fn local_writes(&self) -> Vec<(String, Vec<u8>)> {
		self.record.iter().chain(self.logs.iter())
			.filter(|j| j.arriving_adds > 0)
			.map(|j| (j.rel.clone(), j.bytes.clone()))
			.collect()
	}

	pub fn local_counts(&self) -> Counts {
		self.counts(|j| j.arriving_adds > 0)
	}

	fn counts<F: Fn(&LogJoin) -> bool>(&self, written: F) -> Counts {
		Counts {
			files:		self.logs.iter().filter(|j| written(j)).count(),
			here:		self.logs.iter().map(|j| j.here_adds).sum(),
			arriving:	self.logs.iter().map(|j| j.arriving_adds).sum(),
		}
	}
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Plan {
	Held(Vec<String>),	// the paths that could not be joined; nothing may be written
	Join(Join),
}

/// What an import, or a join in place, did: held back, naming the paths, or joined.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ImportOutcome {
	Held(Vec<String>),
	Joined(Counts),
}

impl ImportOutcome {

	/// `{"held":[…]|null,"files":n,"here":n,"arriving":n}`, the shape the page reads.  A held
	/// answer counts nothing, since nothing was written.
	pub fn to_json(&self) -> String {
		match self {
			Self::Held(paths) => {
				let list: Vec<String> = paths.iter()
					.map(|p| fmt!("\"{}\"", json_escape(p)))
					.collect();
				fmt!("{{\"held\":[{}],\"files\":0,\"here\":0,\"arriving\":0}}", list.join(","))
			}
			Self::Joined(c) => fmt!("{{\"held\":null,\"files\":{},\"here\":{},\"arriving\":{}}}",
				c.files, c.here, c.arriving),
		}
	}
}

fn arriving_body<'a>(arriving: &'a [(String, Vec<u8>)], rel: &str) -> Option<&'a [u8]> {
	arriving.iter().find(|(r, _)| r == rel).map(|(_, b)| b.as_slice())
}

/// The paths either side's record names, the arriving record's first, each once and only where
/// [`is_recordable`] passes it: a record from another device is that device's word, and a line
/// naming the store or a step outside is not a log to join.
pub fn recorded_paths(arriving: &[(String, Vec<u8>)], local_record: &[u8]) -> Vec<String> {
	let theirs = arriving_body(arriving, PAGELOGS_REL).unwrap_or(&[]);
	let joined = lineset::union_lines(theirs, local_record).bytes;
	let text = String::from_utf8_lossy(&joined);
	let mut out: Vec<String> = Vec::new();
	for rel in records(&text) {
		if is_recordable(rel) && !out.iter().any(|o| o == rel) {
			out.push(rel.to_string());
		}
	}
	out
}

/// Plan the join of an arriving copy's page logs with this device's.
///
/// Only a recorded path joins (R2): a file no record names is carried as the import always
/// carried it, whatever it is called.  A path only this device holds is added whole, one only
/// the arriving copy holds is left as it came, and one both hold is their [`lineset::union_lines`].
/// Any log either side holds over [`PAGELOG_JOIN_MAX`], or that this device could not read, makes
/// the plan [`Plan::Held`]: an import never falls back to replacing a log it could not join.
pub fn join_plan(arriving: &[(String, Vec<u8>)], local: &LocalLogs) -> Plan {
	let mut held: Vec<String> = Vec::new();
	let mut check = |rel: &str, here: &LocalLog, theirs: Option<&[u8]>| {
		let over = theirs.is_some_and(|b| b.len() > PAGELOG_JOIN_MAX);
		if over || matches!(here, LocalLog::Unreadable | LocalLog::TooBig) {
			held.push(rel.to_string());
		}
	};
	check(PAGELOGS_REL, &local.record, arriving_body(arriving, PAGELOGS_REL));
	let local_record: &[u8] = match &local.record {
		LocalLog::Body(b)	=> b,
		_					=> &[],
	};
	let paths = recorded_paths(arriving, local_record);
	for rel in &paths {
		check(rel, local.get(rel), arriving_body(arriving, rel));
	}
	if !held.is_empty() {
		return Plan::Held(held);
	}

	let record = join_one(PAGELOGS_REL, arriving_body(arriving, PAGELOGS_REL), &local.record);
	let logs = paths.iter()
		.filter_map(|rel| join_one(rel, arriving_body(arriving, rel), local.get(rel)))
		.collect();
	Plan::Join(Join { record, logs })
}

fn join_one(rel: &str, theirs: Option<&[u8]>, here: &LocalLog) -> Option<LogJoin> {
	let mine = match here {
		LocalLog::Body(b)	=> Some(b.as_slice()),
		_					=> None,
	};
	let (bytes, here_adds, arriving_adds) = match (theirs, mine) {
		(None, None)		=> return None,
		// Added whole, byte for byte: the join of a file with nothing would re-end its lines.
		(None, Some(m))		=> (m.to_vec(), lineset::union_lines(&[], m).here_adds, 0),
		(Some(t), None)		=> (t.to_vec(), 0, lineset::union_lines(t, &[]).arriving_adds),
		(Some(t), Some(m))	=> {
			let j = lineset::union_lines(t, m);
			(j.bytes, j.here_adds, j.arriving_adds)
		}
	};
	Some(LogJoin {
		rel:			rel.to_string(),
		bytes,
		was:			mine.map(|m| m.to_vec()),
		here_adds,
		arriving_adds,
	})
}

// ┌───────────────────────────────────────────────────────────────┐
// │ The heal (PLE)                                                 │
// └───────────────────────────────────────────────────────────────┘

/// The heal's mark lives in its own directory of the version store, `versions/heal/pagelogs`, for
/// two reasons the store's other files do not share.  An import deletes everything in a Diamond
/// but `versions/` before laying the arriving copy down, and the export passes this directory over
/// as it does `pending/` and `outputs/`: which kept versions this device has joined is this
/// device's to know, and another device adopting it would skip versions it never read.
pub const HEAL_DIR: &str = "heal";
pub const HEAL_MARK_FILE: &str = "pagelogs";

/// The History note of the version a heal mints.
pub const HEAL_NOTE: &str = "rows an earlier sync dropped, put back";

/// How an import's kept version is noted: `keep_local_before_import`'s note opens with it.
const KEPT_NOTE: &str = "kept before sync";

/// Is this the version an import kept of what it replaced?
///
/// The heal reads only these.  Any other version holds a state the person chose, a restore or an
/// undo among them, and putting its rows back would undo the choice.
pub fn is_kept_before_sync(m: &Manifest) -> bool {
	m.cause == Cause::Restore && m.note.starts_with(KEPT_NOTE)
}

/// Which kept versions this device has joined into its page logs, and against which record
/// (r547 ruling R1).
///
/// Content hashes, not a high-water version number: an import lays the other device's kept
/// versions down at that device's own numbers, which may sit below any mark this device holds, and
/// refiles this device's own upward.  A kept manifest whose hash the mark does not name is read,
/// wherever it is numbered.  The record's digest is held so that a path recorded after its rows
/// were lost (R2, no guessed seeding) makes the next heal read every kept version again.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct HealMark {
	pub record:	String,		// digest of the page-log record the mark was taken against
	pub joined:	Vec<String>,	// content hashes of the kept manifests joined
}

impl HealMark {

	/// Read a mark, `record <digest>` then one `kept <hash>` per line.  A line that reads as
	/// neither is passed over: the worst a damaged mark can cost is a rescan, which adds nothing
	/// twice.
	pub fn read(text: &str) -> Self {
		let mut m = Self::default();
		for line in text.split('\n') {
			match line.split_once(' ') {
				Some(("record", d))	=> m.record = d.to_string(),
				Some(("kept", h))	=> if !m.joined.iter().any(|j| j == h) {
					m.joined.push(h.to_string());
				},
				_					=> (),
			}
		}
		m
	}

	pub fn to_text(&self) -> String {
		let mut out = fmt!("record {}\n", self.record);
		for h in &self.joined {
			out.push_str(&fmt!("kept {}\n", h));
		}
		out
	}
}

/// One log the heal writes.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HealLog {
	pub rel:	String,
	pub bytes:	Vec<u8>,	// the live log with the dropped rows put back
	pub was:	Vec<u8>,	// the live log as the heal found it
	pub rows:	usize,		// rows put back
}

/// What one heal writes, what it could not read, and the mark it leaves.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct HealPlan {
	pub logs:	Vec<HealLog>,
	pub gone:	usize,		// copies of a recorded log a kept version names and no longer holds
	pub mark:	HealMark,
}

/// The paths a record names that may be logs, each once.
fn heal_paths(record: &[u8]) -> Vec<String> {
	let text = String::from_utf8_lossy(record);
	let mut out: Vec<String> = Vec::new();
	for rel in records(&text) {
		if is_recordable(rel) && !out.iter().any(|o| o == rel) {
			out.push(rel.to_string());
		}
	}
	out
}

/// The kept versions a heal reads against `mark`: every one where the record has changed since
/// the mark was taken, and otherwise those the mark does not name.
fn heal_scan<'a>(kept: &'a [(String, Manifest)], record: &[u8], mark: &HealMark)
	-> Vec<&'a (String, Manifest)>
{
	let rescan = mark.record != hash_of(record);
	kept.iter()
		.filter(|(k, m)| is_kept_before_sync(m) && (rescan || !mark.joined.contains(k)))
		.collect()
}

/// A version entry's path inside the Diamond whose directory is `dir`.
fn entry_rel<'a>(path: &'a str, dir: &str) -> Option<&'a str> {
	path.strip_prefix(dir).and_then(|p| p.strip_prefix('/'))
}

/// The bodies a heal reads, by hash: each kept version's copy of each recorded log, for the kept
/// versions [`heal_plan`] will scan.  So the edge reads nothing a heal will not use.
pub fn heal_wants(kept: &[(String, Manifest)], dir: &str, record: &[u8], mark: &HealMark) -> Vec<String> {
	let paths = heal_paths(record);
	let mut out: Vec<String> = Vec::new();
	for (_, m) in heal_scan(kept, record, mark) {
		for e in &m.files {
			let recorded = entry_rel(&e.path, dir).is_some_and(|r| paths.iter().any(|p| p == r));
			if recorded && !e.gone && e.restorable() && !out.contains(&e.hash) {
				out.push(e.hash.clone());
			}
		}
	}
	out
}

/// Plan the heal of this device's page logs from its kept versions (PL4).
///
/// Each kept version not yet joined has its copy of every recorded log joined into the live log
/// as a multiset of rows ([`lineset::union_lines`], the live log arriving), so a row an earlier
/// sync's replace dropped is put back once and a row the live log holds is never taken out: the
/// heal only adds.  `kept` is each manifest by the hash of its bytes, and `bodies` the copies
/// [`heal_wants`] asked for that could be read.
///
/// A kept version joins the mark once every recorded log it names was read here.  A copy the store
/// no longer holds is counted in `gone` and is not asked for again.  A live log this device could
/// not read leaves its version out of the mark, to be tried on the next heal.  A recorded log no
/// longer here is not brought back: a person may have deleted it, and rows are put back only into
/// a log that is still kept.  An unreadable record plans nothing and leaves the mark as it was.
pub fn heal_plan(kept: &[(String, Manifest)], dir: &str, live: &LocalLogs, mark: &HealMark,
	bodies: &[(String, Vec<u8>)]) -> HealPlan
{
	let record: &[u8] = match &live.record {
		LocalLog::Body(b)	=> b,
		LocalLog::Absent	=> &[],
		LocalLog::Unreadable | LocalLog::TooBig => return HealPlan {
			logs:	Vec::new(),
			gone:	0,
			mark:	mark.clone(),
		},
	};
	let paths = heal_paths(record);
	let digest = hash_of(record);
	// A pruned version leaves the mark; on a rescan the mark is rebuilt from what is read.
	let mut joined: Vec<String> = if mark.record == digest {
		mark.joined.iter().filter(|h| kept.iter().any(|(k, _)| k == *h)).cloned().collect()
	} else {
		Vec::new()
	};
	let mut cur: Vec<HealLog> = paths.iter().filter_map(|rel| match live.get(rel) {
		LocalLog::Body(b)	=> Some(HealLog { rel: rel.clone(), bytes: b.clone(), was: b.clone(), rows: 0 }),
		_					=> None,
	}).collect();
	let mut gone = 0;
	for (key, m) in heal_scan(kept, record, mark) {
		let mut read_all = true;
		for e in &m.files {
			let rel = match entry_rel(&e.path, dir) {
				Some(r) if paths.iter().any(|p| p == r)	=> r,
				_										=> continue,
			};
			if e.gone {
				continue;			// the log was deleted at that version: no rows
			}
			match live.get(rel) {
				LocalLog::Body(_)						=> (),
				LocalLog::Absent						=> continue,
				LocalLog::Unreadable | LocalLog::TooBig	=> { read_all = false; continue; }
			}
			let body = match bodies.iter().find(|(h, _)| e.restorable() && *h == e.hash) {
				Some((_, b))	=> b,
				None			=> { gone += 1; continue; }
			};
			if let Some(slot) = cur.iter_mut().find(|c| c.rel == rel) {
				let j = lineset::union_lines(&slot.bytes, body);
				if j.here_adds > 0 {
					slot.bytes = j.bytes;
					slot.rows += j.here_adds;
				}
			}
		}
		if read_all && !joined.contains(key) {
			joined.push(key.clone());
		}
	}
	HealPlan {
		logs:	cur.into_iter().filter(|l| l.rows > 0).collect(),
		gone,
		mark:	HealMark { record: digest, joined },
	}
}

/// What a heal did, `{"files":n,"rows":n,"gone":n}` as the page reads it.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct HealCounts {
	pub files:	usize,
	pub rows:	usize,
	pub gone:	usize,
}

impl HealCounts {
	pub fn of(plan: &HealPlan) -> Self {
		Self {
			files:	plan.logs.len(),
			rows:	plan.logs.iter().map(|l| l.rows).sum(),
			gone:	plan.gone,
		}
	}

	pub fn to_json(&self) -> String {
		fmt!("{{\"files\":{},\"rows\":{},\"gone\":{}}}", self.files, self.rows, self.gone)
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	// The record
	#[test]
	fn test_records_reads_one_path_per_line_and_skips_blanks() {
		assert_eq!(records(""), Vec::<&str>::new());
		assert_eq!(records("log.txt\n\nmeals/oats.jsonl\n"), vec!["log.txt", "meals/oats.jsonl"]);
		assert_eq!(records("log.txt"), vec!["log.txt"]);
	}

	#[test]
	fn test_with_path_adds_a_new_path_on_its_own_line() {
		assert_eq!(with_path("", "log.txt"), Some("log.txt\n".to_string()));
		assert_eq!(with_path("a.txt\n", "log.txt"), Some("a.txt\nlog.txt\n".to_string()));
		// A record that lost its final newline still gets the path on a line of its own.
		assert_eq!(with_path("a.txt", "log.txt"), Some("a.txt\nlog.txt\n".to_string()));
	}

	#[test]
	fn test_with_path_answers_none_for_a_path_already_recorded() {
		assert_eq!(with_path("log.txt\n", "log.txt"), None);
		assert_eq!(with_path("a.txt\nlog.txt", "log.txt"), None);
		// A prefix of a recorded path is a different path.
		assert_eq!(with_path("log.txt.old\n", "log.txt"), Some("log.txt.old\nlog.txt\n".to_string()));
	}

	#[test]
	fn test_a_path_added_once_reads_back_once() {
		let one = match with_path("", "log.txt") {
			Some(t)	=> t,
			None	=> panic!("a new path must be added"),
		};
		assert_eq!(with_path(&one, "log.txt"), None);
		assert_eq!(records(&one), vec!["log.txt"]);
	}

	// What may be recorded
	#[test]
	fn test_a_plain_relative_path_is_recordable() {
		assert!(is_recordable("log.txt"));
		assert!(is_recordable("meals/2026/oats.jsonl"));
		assert!(is_recordable(".hidden/log.txt"));
		assert!(is_recordable("versions.txt"));
	}

	#[test]
	fn test_the_store_and_the_versions_are_not_recordable() {
		assert!(!is_recordable(".daimond/log"));
		assert!(!is_recordable(".daimond/pagelogs"));
		assert!(!is_recordable(".daimond"));
		assert!(!is_recordable(".red/links.json"));
		assert!(!is_recordable("versions/0001.json"));
	}

	#[test]
	fn test_a_path_that_steps_out_or_is_malformed_is_not_recordable() {
		assert!(!is_recordable(""));
		assert!(!is_recordable("../other/log.txt"));
		assert!(!is_recordable("a/../../log.txt"));
		assert!(!is_recordable("a/./log.txt"));
		assert!(!is_recordable("/abs/log.txt"));
		assert!(!is_recordable("a//log.txt"));
		assert!(!is_recordable("a/"));
		assert!(!is_recordable("a\\log.txt"));
		assert!(!is_recordable("log\n.txt"));
		assert!(!is_recordable("log\r.txt"));
	}
	// The join (PLC)
	fn files(list: &[(&str, &str)]) -> Vec<(String, Vec<u8>)> {
		list.iter().map(|(r, b)| (r.to_string(), b.as_bytes().to_vec())).collect()
	}

	fn here(record: &str, list: &[(&str, LocalLog)]) -> LocalLogs {
		LocalLogs {
			record:	if record.is_empty() { LocalLog::Absent } else { LocalLog::Body(record.as_bytes().to_vec()) },
			files:	list.iter().map(|(r, l)| (r.to_string(), l.clone())).collect(),
		}
	}

	fn body(s: &str) -> LocalLog {
		LocalLog::Body(s.as_bytes().to_vec())
	}

	fn joined(plan: Plan) -> Join {
		match plan {
			Plan::Join(j)	=> j,
			Plan::Held(p)	=> panic!("expected a join, the plan held {:?}", p),
		}
	}

	fn write_of<'a>(writes: &'a [(String, Vec<u8>)], rel: &str) -> Option<&'a str> {
		writes.iter().find(|(r, _)| r == rel).and_then(|(_, b)| std::str::from_utf8(b).ok())
	}

	fn sorted_rows(text: &str) -> Vec<&str> {
		let mut v: Vec<&str> = text.split('\n').filter(|l| !l.is_empty()).collect();
		v.sort();
		v
	}

	#[test]
	fn two_sided_keeps_both() {
		let arriving = files(&[(PAGELOGS_REL, "log.txt\n"), ("log.txt", "a\nb\n")]);
		let local = here("log.txt\n", &[("log.txt", body("a\nc\n"))]);
		let j = joined(join_plan(&arriving, &local));
		let w = j.import_writes();
		let log = match write_of(&w, "log.txt") {
			Some(t)	=> t,
			None	=> panic!("the joined log must be laid over the arriving copy"),
		};
		assert_eq!(sorted_rows(log), vec!["a", "b", "c"]);
		assert_eq!(j.import_counts(), Counts { files: 1, here: 1, arriving: 1 });
	}

	#[test]
	fn local_only_log_survives() {
		// The other device never logged here, so its copy carries neither the file nor a record
		// of it: the import's delete-then-write would take the file with it.
		let arriving = files(&[("crystal.json", "{}")]);
		let local = here("meals.jsonl\n", &[("meals.jsonl", body("{\"oats\":1}\r\n{\"tea\":2}"))]);
		let j = joined(join_plan(&arriving, &local));
		let w = j.import_writes();
		assert_eq!(write_of(&w, "meals.jsonl"), Some("{\"oats\":1}\r\n{\"tea\":2}"), "added byte for byte");
		assert_eq!(write_of(&w, PAGELOGS_REL), Some("meals.jsonl\n"), "and still recorded");
		assert_eq!(j.import_counts(), Counts { files: 1, here: 2, arriving: 0 });
	}

	#[test]
	fn unrecorded_jsonl_not_joined() {
		// A daimon wrote this through its own tools: no record names it, so it is carried as
		// the import always carried it, however much it looks like a log.
		let arriving = files(&[(PAGELOGS_REL, "log.txt\n"), ("log.txt", "a\n"),
			("notes.jsonl", "{\"x\":1}\n")]);
		let local = here("log.txt\n", &[("log.txt", body("a\n")),
			("notes.jsonl", body("{\"x\":1}\n{\"y\":2}\n"))]);
		let j = joined(join_plan(&arriving, &local));
		assert!(write_of(&j.import_writes(), "notes.jsonl").is_none());
		assert!(j.logs.iter().all(|l| l.rel != "notes.jsonl"));
		assert_eq!(j.import_counts(), Counts::default());
		assert_eq!(recorded_paths(&arriving, b"log.txt\n"), vec!["log.txt".to_string()]);
	}

	#[test]
	fn record_joins_both_ways() {
		let arriving = files(&[(PAGELOGS_REL, "a.txt\n"), ("a.txt", "1\n")]);
		let local = here("b.txt\n", &[("b.txt", body("2\n"))]);
		let j = joined(join_plan(&arriving, &local));
		let imp = j.import_writes();
		let rec = match write_of(&imp, PAGELOGS_REL) {
			Some(t)	=> t,
			None	=> panic!("the import must lay the joined record down"),
		};
		assert_eq!(sorted_rows(rec), vec!["a.txt", "b.txt"]);
		let loc = j.local_writes();
		let rec = match write_of(&loc, PAGELOGS_REL) {
			Some(t)	=> t,
			None	=> panic!("a join in place must write the joined record here"),
		};
		assert_eq!(sorted_rows(rec), vec!["a.txt", "b.txt"]);
		assert_eq!(write_of(&loc, "a.txt"), Some("1\n"));
		assert!(write_of(&loc, "b.txt").is_none(), "nothing arrived for b.txt");
	}

	#[test]
	fn counts_both_directions() {
		// Here only: this device logged, the other did not.
		let arriving = files(&[(PAGELOGS_REL, "log.txt\n"), ("log.txt", "a\n")]);
		let local = here("log.txt\n", &[("log.txt", body("a\nb\n"))]);
		let j = joined(join_plan(&arriving, &local));
		assert_eq!(j.import_counts(), Counts { files: 1, here: 1, arriving: 0 });
		assert_eq!(j.local_counts(), Counts { files: 0, here: 1, arriving: 0 });
		assert!(j.local_writes().is_empty(), "#8: nothing written here for a file that gains nothing");
		// Arriving only: the reverse.
		let arriving = files(&[(PAGELOGS_REL, "log.txt\n"), ("log.txt", "a\nb\n")]);
		let local = here("log.txt\n", &[("log.txt", body("a\n"))]);
		let j = joined(join_plan(&arriving, &local));
		assert_eq!(j.import_counts(), Counts { files: 0, here: 0, arriving: 1 });
		assert_eq!(j.local_counts(), Counts { files: 1, here: 0, arriving: 1 });
		assert!(j.import_writes().is_empty(), "the arriving copy already holds every row");
		assert_eq!(write_of(&j.local_writes(), "log.txt"), Some("a\nb\n"));
	}

	#[test]
	fn held_when_unreadable() {
		let arriving = files(&[(PAGELOGS_REL, "log.txt\n"), ("log.txt", "a\n")]);
		let local = here("log.txt\n", &[("log.txt", LocalLog::Unreadable)]);
		assert_eq!(join_plan(&arriving, &local), Plan::Held(vec!["log.txt".to_string()]));
		let local = LocalLogs { record: LocalLog::Unreadable, files: Vec::new() };
		match join_plan(&arriving, &local) {
			Plan::Held(p)	=> assert!(p.contains(&PAGELOGS_REL.to_string())),
			Plan::Join(_)	=> panic!("an unreadable record must hold the import"),
		}
	}

	#[test]
	fn held_when_over_cap() {
		let arriving = files(&[(PAGELOGS_REL, "log.txt\n"), ("log.txt", "a\n")]);
		let local = here("log.txt\n", &[("log.txt", LocalLog::TooBig)]);
		assert_eq!(join_plan(&arriving, &local), Plan::Held(vec!["log.txt".to_string()]));
		// Over the cap on the arriving side holds it too.
		let mut big = vec![b'x'; PAGELOG_JOIN_MAX];
		big.push(b'\n');
		let arriving = vec![
			(PAGELOGS_REL.to_string(), b"log.txt\n".to_vec()),
			("log.txt".to_string(), big),
		];
		let local = here("log.txt\n", &[("log.txt", body("a\n"))]);
		assert_eq!(join_plan(&arriving, &local), Plan::Held(vec!["log.txt".to_string()]));
	}

	#[test]
	fn joins_over_512k() {
		// 600 KB on each side, past the version store's 512 KB body limit: joined, not held and
		// not skipped (#4).
		let mut shared = String::new();
		let mut n = 0;
		while shared.len() < 600 * 1024 {
			shared.push_str(&fmt!("{{\"row\":{},\"pad\":\"{}\"}}\n", n, "p".repeat(80)));
			n += 1;
		}
		let theirs = fmt!("{}{{\"there\":1}}\n", shared);
		let mine = fmt!("{}{{\"here\":1}}\n", shared);
		let arriving = files(&[(PAGELOGS_REL, "big.jsonl\n"), ("big.jsonl", &theirs)]);
		let local = here("big.jsonl\n", &[("big.jsonl", body(&mine))]);
		let j = joined(join_plan(&arriving, &local));
		assert_eq!(j.import_counts(), Counts { files: 1, here: 1, arriving: 1 });
		let w = j.import_writes();
		let log = match write_of(&w, "big.jsonl") {
			Some(t)	=> t,
			None	=> panic!("a 600 KB log must join"),
		};
		assert!(log.contains("{\"there\":1}") && log.contains("{\"here\":1}"));
		assert_eq!(log.len(), shared.len() + 12 + 11);
	}

	#[test]
	fn one_sided_untouched() {
		// Both hold the same rows: nothing to write either way, and the answer counts nothing.
		let arriving = files(&[(PAGELOGS_REL, "log.txt\n"), ("log.txt", "a\nb\n")]);
		let local = here("log.txt\n", &[("log.txt", body("a\nb\n"))]);
		let j = joined(join_plan(&arriving, &local));
		assert!(j.import_writes().is_empty());
		assert!(j.local_writes().is_empty());
		assert_eq!(j.import_counts(), Counts::default());
		// Neither side has ever logged.
		let arriving = files(&[("crystal.json", "{}")]);
		let j = joined(join_plan(&arriving, &here("", &[])));
		assert_eq!(j, Join::default());
		assert_eq!(ImportOutcome::Joined(j.import_counts()).to_json(),
			"{\"held\":null,\"files\":0,\"here\":0,\"arriving\":0}");
	}

	#[test]
	fn test_import_outcome_json_names_the_held_paths() {
		let o = ImportOutcome::Held(vec!["log.txt".to_string(), "a \"q\".txt".to_string()]);
		assert_eq!(o.to_json(),
			"{\"held\":[\"log.txt\",\"a \\\"q\\\".txt\"],\"files\":0,\"here\":0,\"arriving\":0}");
		let o = ImportOutcome::Joined(Counts { files: 2, here: 3, arriving: 1 });
		assert_eq!(o.to_json(), "{\"held\":null,\"files\":2,\"here\":3,\"arriving\":1}");
	}

	// The heal (PLE)
	use crate::diamond_versions::Entry;

	const DIR: &str = "diamonds/d1";
	const KEPT: &str = "kept before sync — a local edit the merge replaced";

	// A version of `logs`, each by its path inside the Diamond, and the bodies it names.
	fn version(note: &str, ts: u64, logs: &[(&str, &str)]) -> ((String, Manifest), Vec<(String, Vec<u8>)>) {
		let files: Vec<Entry> = logs.iter()
			.map(|(r, b)| Entry::changed(&fmt!("{}/{}", DIR, r), b.as_bytes(), None))
			.collect();
		let m = Manifest::new(Cause::Restore, ts, "", note, files);
		let key = hash_of(m.to_json().as_bytes());
		let bodies = logs.iter().map(|(_, b)| (hash_of(b.as_bytes()), b.as_bytes().to_vec())).collect();
		((key, m), bodies)
	}

	// One heal as the edge runs it: read only what it asks for, plan, lay the logs down.
	fn heal_once(kept: &[(String, Manifest)], store: &[(String, Vec<u8>)], live: &mut LocalLogs,
		mark: &mut HealMark) -> HealPlan
	{
		let rec = match &live.record {
			LocalLog::Body(b)	=> b.clone(),
			_					=> Vec::new(),
		};
		let wants = heal_wants(kept, DIR, &rec, mark);
		let bodies: Vec<(String, Vec<u8>)> = store.iter()
			.filter(|(h, _)| wants.contains(h))
			.cloned()
			.collect();
		let plan = heal_plan(kept, DIR, live, mark, &bodies);
		for l in &plan.logs {
			match live.files.iter_mut().find(|(r, _)| *r == l.rel) {
				Some(slot)	=> slot.1 = LocalLog::Body(l.bytes.clone()),
				None		=> panic!("the heal wrote '{}', a log that was not here", l.rel),
			}
		}
		*mark = plan.mark.clone();
		plan
	}

	fn live_text(live: &LocalLogs, rel: &str) -> String {
		match live.get(rel) {
			LocalLog::Body(b)	=> String::from_utf8_lossy(b).into_owned(),
			other				=> panic!("'{}' is {:?}, not a body", rel, other),
		}
	}

	fn shared_rows(n: usize) -> String {
		(0..n).map(|i| fmt!("{{\"id\":\"row{:02}\",\"w\":{}}}\n", i, 1000 + i)).collect()
	}

	fn rows_heal(plan: &HealPlan) -> usize {
		plan.logs.iter().map(|l| l.rows).sum()
	}

	// A synthetic row of the one known real candidate's shape: 132 ASCII bytes, no CR.
	const SYNTH_ROW: &str = "{\"id\":\"zq0synthrow1\",\"at\":\"2026-01-02T08:30:00+08:00\",\"day\":\"2026-01-02\",\
		\"src\":\"scale\",\"f\":{\"food\":\"rye\",\"qty\":3},\"w\":1767313800000}";

	fn owner_profile() -> (Vec<(String, Manifest)>, Vec<(String, Vec<u8>)>, LocalLogs) {
		let shared = shared_rows(11);
		let own: String = (0..7).map(|i| fmt!("{{\"id\":\"own{}\",\"w\":{}}}\n", i, 2000 + i)).collect();
		let v52 = fmt!("{}{}\n", shared, SYNTH_ROW);
		let v48 = shared_rows(6);
		let restore = fmt!("{}{{\"id\":\"undone\"}}\n", shared);
		let (k48, b48) = version(KEPT, 48, &[("log/diet.jsonl", &v48)]);
		let (k52, b52) = version(KEPT, 52, &[("log/diet.jsonl", &v52)]);
		// A restore the person chose: its rows are not the heal's to put back.
		let (k79, b79) = version("restore v74", 79, &[("log/diet.jsonl", &restore)]);
		let store = b48.into_iter().chain(b52).chain(b79).collect();
		let live = here("log/diet.jsonl\n", &[("log/diet.jsonl", body(&fmt!("{}{}", shared, own)))]);
		(vec![k48, k52, k79], store, live)
	}

	#[test]
	fn owner_shape() {
		let (kept, store, mut live) = owner_profile();
		let mut mark = HealMark::default();
		let plan = heal_once(&kept, &store, &mut live, &mut mark);
		assert_eq!(plan.logs.len(), 1, "one log written, so one History row");
		assert_eq!(rows_heal(&plan), 1);
		assert_eq!(plan.gone, 0);
		assert_eq!(HealCounts::of(&plan).to_json(), "{\"files\":1,\"rows\":1,\"gone\":0}");
		let text = live_text(&live, "log/diet.jsonl");
		assert_eq!(text.split('\n').filter(|l| *l == SYNTH_ROW).count(), 1);
		assert!(!text.contains("undone"), "a chosen restore's rows stay out");
		assert_eq!(text.split('\n').filter(|l| !l.is_empty()).count(), 19);
		// A second run writes nothing, the mark included.
		let before = mark.clone();
		let again = heal_once(&kept, &store, &mut live, &mut mark);
		assert!(again.logs.is_empty());
		assert_eq!(again.gone, 0);
		assert_eq!(mark, before);
	}

	#[test]
	fn candidate_sha_shape_restores_exactly_one_line() {
		assert_eq!(SYNTH_ROW.len(), 132);
		assert!(SYNTH_ROW.is_ascii() && !SYNTH_ROW.contains('\r'));
		let want = hash_of(SYNTH_ROW.as_bytes());
		let (kept, store, mut live) = owner_profile();
		let had: Vec<String> = live_text(&live, "log/diet.jsonl").split('\n')
			.filter(|l| !l.is_empty()).map(|l| l.to_string()).collect();
		assert_eq!(had.len(), 18);
		assert!(had.iter().all(|l| hash_of(l.as_bytes()) != want));
		let mut mark = HealMark::default();
		let _ = heal_once(&kept, &store, &mut live, &mut mark);
		let now: Vec<String> = live_text(&live, "log/diet.jsonl").split('\n')
			.filter(|l| !l.is_empty()).map(|l| l.to_string()).collect();
		assert_eq!(now.len(), 19, "exactly one line restored");
		assert_eq!(now.iter().filter(|l| hash_of(l.as_bytes()) == want).count(), 1);
		let mut rest = now.clone();
		rest.retain(|l| hash_of(l.as_bytes()) != want);
		assert_eq!(rest, had, "every other line as it was, in its order");
	}

	#[test]
	fn arriving_below_mark() {
		// This device joined its own kept version at 60.  The other device's arrives at 40,
		// below it, and holds a row only that device kept.
		let (k60, b60) = version(KEPT, 60, &[("log.txt", "a\nb\n")]);
		let mut live = here("log.txt\n", &[("log.txt", body("a\nb\n"))]);
		let mut mark = HealMark::default();
		let _ = heal_once(&[k60.clone()], &b60, &mut live, &mut mark);
		assert_eq!(mark.joined, vec![k60.0.clone()]);
		let (k40, b40) = version(KEPT, 40, &[("log.txt", "a\nthere\n")]);
		let kept = vec![k40, k60];
		let store: Vec<(String, Vec<u8>)> = b40.into_iter().chain(b60).collect();
		let plan = heal_once(&kept, &store, &mut live, &mut mark);
		assert_eq!(rows_heal(&plan), 1);
		assert_eq!(sorted_rows(&live_text(&live, "log.txt")), vec!["a", "b", "there"]);
		assert!(heal_once(&kept, &store, &mut live, &mut mark).logs.is_empty());
	}

	#[test]
	fn late_registration() {
		// The rows were lost before the log was ever recorded: the first heal cannot know it is
		// a log, and marks the version joined.
		let (k, b) = version(KEPT, 30, &[("log.txt", "a\nlost\n")]);
		let mut live = here("other.txt\n", &[("other.txt", body("o\n")), ("log.txt", body("a\nnew\n"))]);
		let mut mark = HealMark::default();
		assert!(heal_once(&[k.clone()], &b, &mut live, &mut mark).logs.is_empty());
		assert_eq!(mark.joined, vec![k.0.clone()]);
		// The next append records it, and the heal rescans every kept version.
		live.record = body("other.txt\nlog.txt\n");
		let plan = heal_once(&[k], &b, &mut live, &mut mark);
		assert_eq!(rows_heal(&plan), 1);
		assert_eq!(sorted_rows(&live_text(&live, "log.txt")), vec!["a", "lost", "new"]);
	}

	#[test]
	fn version_gone() {
		// The body was pruned, and another kept version kept no body at all: reported, no error.
		let (k1, _) = version(KEPT, 10, &[("log.txt", "a\nlost\n")]);
		let (mut k2, _) = version(KEPT, 11, &[("log.txt", "a\nbig\n")]);
		k2.1.files[0].skipped = Some("size".to_string());
		k2.0 = hash_of(k2.1.to_json().as_bytes());
		let mut live = here("log.txt\n", &[("log.txt", body("a\n"))]);
		// The mark also names a kept version that has since been pruned.
		let mut mark = HealMark { record: String::new(), joined: vec!["pruned".to_string()] };
		let kept = vec![k1.clone(), k2.clone()];
		let plan = heal_once(&kept, &[], &mut live, &mut mark);
		assert!(plan.logs.is_empty());
		assert_eq!(plan.gone, 2);
		assert_eq!(mark.joined, vec![k1.0, k2.0], "the pruned one leaves the mark");
		let again = heal_once(&kept, &[], &mut live, &mut mark);
		assert_eq!(again.gone, 0, "reported once");
	}

	#[test]
	fn mixed_version_window() {
		// A healed and marked; then an r547 B, meeting it two-sidedly, replaced the log with its
		// own copy and kept A's (with the healed row) before sync.  That kept version reaches A.
		let (ka, ba) = version(KEPT, 5, &[("log.txt", "a\nlost\n")]);
		let mut live = here("log.txt\n", &[("log.txt", body("a\n"))]);
		let mut mark = HealMark::default();
		assert_eq!(rows_heal(&heal_once(&[ka.clone()], &ba, &mut live, &mut mark)), 1);
		let healed = live_text(&live, "log.txt");
		live.files[0].1 = body("a\nfromb\n");
		// Without B's kept version there is nothing to heal from.
		assert!(heal_once(&[ka.clone()], &ba, &mut live, &mut mark).logs.is_empty());
		let (kb, bb) = version(KEPT, 6, &[("log.txt", &healed)]);
		let kept = vec![ka, kb];
		let store: Vec<(String, Vec<u8>)> = ba.into_iter().chain(bb).collect();
		let plan = heal_once(&kept, &store, &mut live, &mut mark);
		assert_eq!(rows_heal(&plan), 1);
		assert_eq!(sorted_rows(&live_text(&live, "log.txt")), vec!["a", "fromb", "lost"]);
	}

	#[test]
	fn heal_never_removes_a_line() {
		let live_body = "a\nb\nb\nc\n";
		let (k, b) = version(KEPT, 1, &[("log.txt", "a\nd\n")]);
		let mut live = here("log.txt\n", &[("log.txt", body(live_body))]);
		let mut mark = HealMark::default();
		let plan = heal_once(&[k], &b, &mut live, &mut mark);
		assert_eq!(rows_heal(&plan), 1);
		assert_eq!(sorted_rows(&live_text(&live, "log.txt")), vec!["a", "b", "b", "c", "d"]);
		assert_eq!(plan.logs[0].was, live_body.as_bytes().to_vec());
	}

	#[test]
	fn heal_waits_for_an_unreadable_log() {
		let (k, b) = version(KEPT, 1, &[("log.txt", "a\nlost\n")]);
		let mut live = here("log.txt\n", &[("log.txt", LocalLog::Unreadable)]);
		let mut mark = HealMark::default();
		assert!(heal_once(&[k.clone()], &b, &mut live, &mut mark).logs.is_empty());
		assert!(mark.joined.is_empty(), "not joined, so tried again");
		live.files[0].1 = body("a\n");
		assert_eq!(rows_heal(&heal_once(&[k], &b, &mut live, &mut mark)), 1);
		// An unreadable record changes nothing, the mark included.
		let before = mark.clone();
		live.record = LocalLog::Unreadable;
		let (k2, b2) = version(KEPT, 2, &[("log.txt", "a\nmore\n")]);
		assert!(heal_once(&[k2], &b2, &mut live, &mut mark).logs.is_empty());
		assert_eq!(mark, before);
	}

	#[test]
	fn heal_does_not_bring_back_a_deleted_log() {
		let (k, b) = version(KEPT, 1, &[("log.txt", "a\n")]);
		let mut live = here("log.txt\n", &[]);
		let mut mark = HealMark::default();
		let plan = heal_once(&[k.clone()], &b, &mut live, &mut mark);
		assert!(plan.logs.is_empty());
		assert_eq!(mark.joined, vec![k.0]);
	}

	#[test]
	fn test_heal_mark_text_round_trips() {
		let m = HealMark { record: "ab12".to_string(), joined: vec!["k1".to_string(), "k2".to_string()] };
		assert_eq!(HealMark::read(&m.to_text()), m);
		// A damaged line costs a rescan, never a refusal.
		assert_eq!(HealMark::read("record ab12\nnonsense\nkept k1\nkept k1\n").joined, vec!["k1".to_string()]);
		assert_eq!(HealMark::read(""), HealMark::default());
	}
}
