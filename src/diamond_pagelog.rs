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
#[path = "../tests/unit/diamond_pagelog/tests.rs"]
mod tests;
