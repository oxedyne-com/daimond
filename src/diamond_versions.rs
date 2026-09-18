//! What a Diamond's FILES held before the change that overwrote them, and what keeping that
//! costs.
//!
//! The crystal has had a version chain since it existed ([`crate::diamond_delta`] and
//! [`crate::wasm::diamond`]), and nothing else in a Diamond has had anything at all.
//! `REQUIREMENTS.md`, `DECISIONS.md` and `STATE.md` earn a version NUMBER when a turn changes
//! them and their bytes are never stored; a `.typ` a daimon rewrote, a file it wrote into a
//! folder the user marked in, a note the user saved from the Files panel -- none of those could
//! be got back by any means the app had. This module is the record that makes them recoverable.
//!
//! Two kinds of file, in the Diamond's own `versions/` directory beside the crystal's:
//!
//! ```text
//! versions/NNNN.files.json      the MANIFEST of version N: what changed at N, and why
//! versions/b/<sha256hex>        a BODY: the bytes of one file's content, stored once
//! ```
//!
//! # Three properties, and each of them is bought by the same decision
//!
//! **A manifest is SPARSE.** It lists the paths that changed at N and nothing else, so an
//! unchanged file costs no entry and no body. What a path held "as at N" is therefore the newest
//! entry at or before N -- the rule the page's own snapshots already live under -- and
//! [`state_at`] is where that is worked out.
//!
//! **A body is a KEYFRAME, addressed by its content.** No chains, no splices: the third write of
//! content already held writes nothing, and a body deleted by a prune can never invalidate
//! another version the way a broken patch in a delta chain can. That is the whole of why
//! [`prune_plan`] can be a reference count rather than a rebuild, and it is the decision (D1 of
//! the launch plan) the delta follow-up is contained by.
//!
//! **Nothing here touches the disk.** The OPFS edge over this -- reading the directory, writing
//! the bodies, minting the version number -- lives in [`crate::wasm::diamond`], which is compiled
//! for wasm32 alone and which no native test can reach. What decides is here instead, where the
//! parse, the resolver, the prune order and the sweep are tested against the manifests they will
//! actually meet.

use crate::llm::{extract_json_bool, extract_json_number, extract_json_string, json_escape};

use oxedyne_fe2o3_core::prelude::*;
use oxedyne_fe2o3_hash::sha256;

use std::collections::{BTreeMap, BTreeSet};


// ┌───────────────────────────────────────────────────────────────┐
// │ Names and ceilings                                             │
// └───────────────────────────────────────────────────────────────┘

/// What a manifest is called, after its zero-padded version number.
///
/// Two dots, and that is what keeps it out of the crystal chain's way: `classify` in
/// [`crate::wasm::diamond`] reads `0007.json` as a data keyframe by stripping `.json` and parsing
/// what is left, and `0007.files` does not parse -- so the two kinds of file share one directory
/// and neither reads the other's.
pub const MANIFEST_EXT: &str = ".files.json";

/// The subdirectory bodies live in, `versions/b/`.
pub const BODY_DIR: &str = "b";

/// The schema version a manifest carries.
pub const MANIFEST_V: u64 = 1;

/// What all of one Diamond's bodies may weigh before a prune runs, in bytes.
///
/// A quarter of a Diamond's 4 MiB share of the sync parcel. The three standing files are capped
/// at 8 + 16 + 4 KiB, so a turn that rewrites all three costs at most 28 KiB and this holds about
/// thirty-six of the worst of them, or several hundred ordinary ones. A 50 KiB source edited
/// every turn eats it in twenty, which is the case the gauge exists to show coming.
pub const VERSIONS_BYTES_DEFAULT: u64 = 1024 * 1024;

/// The rungs the settings pulldown offers, in bytes.
///
/// The ceiling is four and not eight because a Diamond's export is built as ONE string in wasm
/// memory and wasm memory never shrinks: what the store weighs is paid again, as base64 where the
/// bodies are not text, every time the phone packs the Diamond for a sync.
pub const VERSIONS_BYTES_RUNGS: [u64; 4] = [512 * 1024, 1024 * 1024, 2 * 1024 * 1024, 4 * 1024 * 1024];

/// How many manifests one Diamond keeps.
pub const MANIFESTS_MAX: usize = 200;

/// The most one file's body may weigh to be kept at all, in bytes.
///
/// A larger file is recorded as `skipped` -- the row still says it changed, and Restore is
/// refused rather than silently absent.
pub const VERSION_FILE_MAX: usize = 512 * 1024;

/// The most entries one manifest carries.
///
/// A turn that wrote more records the first [`TURN_FILES_MAX`] and says how many it did not,
/// rather than growing a manifest without limit on the one turn that ran a build.
pub const TURN_FILES_MAX: usize = 64;

/// The most lines [`line_diff`] will compare, on either side.
///
/// **Four thousand because the shipped Log Life page is 2,214 lines**, and a ceiling that refuses
/// the one page the product actually ships would put "Cannot compare" on the commonest row in the
/// History. The launch plan's two thousand was a round number chosen without measuring against it.
///
/// It is not the bound on the WORK -- [`DIFF_LCS_MAX`] is, over the middle once the common ends
/// are off -- so raising it costs the trim scan and the rows, both linear.
pub const DIFF_LINES_MAX: usize = 4_000;

/// How much of a diff is worked out line by line once the common ends are off.
///
/// Beyond this the middle is reported as one replacement rather than matched through: the table
/// an exact match needs is the product of the two sides, and the device least able to afford it
/// is the one this runs on.
const DIFF_LCS_MAX: usize = 600;

thread_local! {
	/// The body ceiling in force, or 0 for [`VERSIONS_BYTES_DEFAULT`].
	static VERSIONS_BYTES: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

/// The body ceiling in force, in bytes.
pub fn versions_bytes_cap() -> u64 {
	let set = VERSIONS_BYTES.with(|c| c.get());
	if set == 0 { VERSIONS_BYTES_DEFAULT } else { set }
}

/// Set the body ceiling; 0 restores [`VERSIONS_BYTES_DEFAULT`].
///
/// # Arguments
/// * `bytes` - The new ceiling, or 0 for the default.
pub fn set_versions_bytes_cap(bytes: u64) {
	VERSIONS_BYTES.with(|c| c.set(bytes));
}

/// A manifest's file name, `NNNN.files.json`.
pub fn manifest_name(version: u64) -> String {
	fmt!("{:04}{}", version, MANIFEST_EXT)
}

/// The version a manifest's file name carries, or `None` for somebody else's file.
pub fn manifest_version(name: &str) -> Option<u64> {
	name.strip_suffix(MANIFEST_EXT).and_then(|s| s.parse::<u64>().ok())
}

/// A body's path inside `versions/`, `b/<sha256hex>`.
pub fn body_name(hash: &str) -> String {
	fmt!("{}/{}", BODY_DIR, hash)
}

/// The SHA-256 of some bytes, lowercase hex.
///
/// The same function for every hash in this module -- the content address a body is filed under,
/// the `hash` an entry carries and the `was` it compares against -- because two of them computed
/// differently would dedupe against nothing and would never say so.
pub fn hash_of(bytes: &[u8]) -> String {
	let digest = sha256::digest(bytes);
	let mut out = String::with_capacity(digest.len() * 2);
	for b in digest.iter() {
		out.push_str(&fmt!("{:02x}", b));
	}
	out
}

/// Is this a hash this module could have written?
///
/// Checked wherever a hash arrives from outside -- a manifest that travelled, an argument a model
/// chose -- because a body is addressed by it and an address is a path component.
pub fn is_hash(s: &str) -> bool {
	s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}


// ┌───────────────────────────────────────────────────────────────┐
// │ What a version was made for                                    │
// └───────────────────────────────────────────────────────────────┘

/// Why a version was minted.
///
/// It decides two things and they are not the same: what the History row says, and what
/// [`prune_plan`] is willing to throw away first.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Cause {
	Turn,		// a daimon turn wrote files
	User,		// the user's own doors wrote files, drained at the next turn's start
	Save,		// the user pressed Save a version
	Fold,		// taken before a fold re-reduced the crystal
	Restore,	// taken before a restore overwrote anything
	Share,		// a Diamond arrived, and this is what arrived
}

impl Cause {

	/// The word the manifest carries.
	pub fn wire(&self) -> &'static str {
		match self {
			Self::Turn	=> "turn",
			Self::User	=> "user",
			Self::Save	=> "save",
			Self::Fold	=> "fold",
			Self::Restore	=> "restore",
			Self::Share	=> "share",
		}
	}

	/// The cause that word names, or `None` for one this build has never heard of.
	pub fn of(s: &str) -> Option<Self> {
		match s {
			"turn"		=> Some(Self::Turn),
			"user"		=> Some(Self::User),
			"save"		=> Some(Self::Save),
			"fold"		=> Some(Self::Fold),
			"restore"	=> Some(Self::Restore),
			"share"		=> Some(Self::Share),
			_		=> None,
		}
	}

	/// Which round of pruning takes this one, lowest first.
	///
	/// The order is the whole of the policy: the versions a turn and the user's own doors make
	/// go first because there are hundreds of them; a fold, a share and a restore are the
	/// discontinuities and go next; and a version the user deliberately SAVED is taken only when
	/// there is nothing else left to take, which is what makes Save a version mean something.
	pub fn prune_rank(&self) -> u8 {
		match self {
			Self::Turn | Self::User			=> 0,
			Self::Fold | Self::Share | Self::Restore	=> 1,
			Self::Save				=> 2,
		}
	}
}


// ┌───────────────────────────────────────────────────────────────┐
// │ The manifest                                                   │
// └───────────────────────────────────────────────────────────────┘

/// One path, as one version changed it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Entry {
	pub path:    String,		// workspace-relative, or absolute where `mark`
	pub hash:    String,		// the content AFTER; empty where `gone`
	pub bytes:   u64,		// how long that content is
	pub was:     Option<String>,	// the content BEFORE, or None where there was none to read
	pub gone:    bool,		// the path does not exist after this version
	pub mark:    bool,		// a file on this computer, in a folder the user marked in
	pub skipped: Option<String>,	// why no body was kept: "size", or the hand's own reason
}

impl Entry {

	/// An ordinary change: content, and what stood there before it.
	pub fn changed(path: &str, body: &[u8], was: Option<String>) -> Self {
		Self {
			path:    path.to_string(),
			hash:    hash_of(body),
			bytes:   body.len() as u64,
			was,
			gone:    false,
			mark:    false,
			skipped: None,
		}
	}

	/// Is there a body to restore this entry from?
	///
	/// A `skipped` entry says the file changed and the bytes were not kept, which is a row the
	/// user can read and not a row they can act on.
	pub fn restorable(&self) -> bool {
		self.gone || (self.skipped.is_none() && !self.hash.is_empty())
	}

	fn to_json(&self) -> String {
		let mut out = fmt!("{{\"path\":\"{}\"", json_escape(&self.path));
		if self.gone {
			out.push_str(",\"gone\":true");
		} else {
			out.push_str(&fmt!(",\"hash\":\"{}\",\"bytes\":{}", json_escape(&self.hash),
				self.bytes));
		}
		// Absent rather than null where there was nothing before: a new file and a file whose
		// prior bytes could not be read are different rows, and `was` distinguishes them only
		// if it is written when it is known and left out when it is not.
		if let Some(was) = &self.was {
			out.push_str(&fmt!(",\"was\":\"{}\"", json_escape(was)));
		}
		if self.mark {
			out.push_str(",\"mark\":true");
		}
		if let Some(why) = &self.skipped {
			out.push_str(&fmt!(",\"skipped\":\"{}\"", json_escape(why)));
		}
		out.push('}');
		out
	}

	/// Read one entry, or `None` where the object names no path.
	fn from_json(s: &str) -> Option<Self> {
		let path = match extract_json_string(s, "path") {
			Some(p) if !p.is_empty()	=> p,
			_				=> return None,
		};
		Some(Self {
			path,
			hash:    extract_json_string(s, "hash").unwrap_or_default(),
			bytes:   extract_json_number(s, "bytes").unwrap_or(0),
			was:     extract_json_string(s, "was"),
			gone:    extract_json_bool(s, "gone").unwrap_or(false),
			mark:    extract_json_bool(s, "mark").unwrap_or(false),
			skipped: extract_json_string(s, "skipped"),
		})
	}
}

/// What changed at one version, and why.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Manifest {
	pub v:         u64,		// the schema version; see MANIFEST_V
	pub ts:        u64,		// wall clock, whole milliseconds
	pub cause:     Cause,
	pub turn:      String,		// the user message id of the turn, or empty
	pub note:      String,		// what the user typed, or the name they gave a save
	pub files:     Vec<Entry>,
	pub truncated: usize,		// entries this turn had and this manifest does not
}

impl Manifest {

	pub fn new(cause: Cause, ts: u64, turn: &str, note: &str, files: Vec<Entry>) -> Self {
		let (files, truncated) = truncate(files);
		Self { v: MANIFEST_V, ts, cause, turn: turn.to_string(), note: note.to_string(),
			files, truncated }
	}

	/// Serialise to the stored JSON.
	pub fn to_json(&self) -> String {
		let rows: Vec<String> = self.files.iter().map(|e| e.to_json()).collect();
		let mut out = fmt!(
			"{{\"v\":{},\"ts\":{},\"cause\":\"{}\",\"turn\":\"{}\",\"note\":\"{}\"",
			self.v, self.ts, self.cause.wire(), json_escape(&self.turn),
			json_escape(&self.note));
		if self.truncated > 0 {
			out.push_str(&fmt!(",\"truncated\":{}", self.truncated));
		}
		out.push_str(&fmt!(",\"files\":[{}]}}", rows.join(",")));
		out
	}

	/// Parse a stored manifest.
	///
	/// A cause this build does not know is an error rather than a guess. Every other field is
	/// tolerated missing, because a manifest written before a field existed still describes the
	/// version it was written for -- but the cause decides what the row SAYS and what the prune
	/// is willing to throw away, and defaulting it would silently reclassify somebody's saved
	/// version as a turn's.
	pub fn from_json(s: &str) -> Outcome<Self> {
		let word = extract_json_string(s, "cause").unwrap_or_default();
		let cause = res!(Cause::of(&word).ok_or_else(|| err!(
			"A version manifest says it was made for '{}', which this build does not know. It \
			was written by a newer Daimond; update this device rather than reading it as \
			something else.", word; Invalid, Data)));
		let mut files: Vec<Entry> = Vec::new();
		if let Some(arr) = array_inside(s, "files") {
			for obj in objects_in(arr) {
				if let Some(e) = Entry::from_json(obj) {
					files.push(e);
				}
			}
		}
		Ok(Self {
			v:         extract_json_number(s, "v").unwrap_or(MANIFEST_V),
			ts:        extract_json_number(s, "ts").unwrap_or(0),
			cause,
			turn:      extract_json_string(s, "turn").unwrap_or_default(),
			note:      extract_json_string(s, "note").unwrap_or_default(),
			files,
			truncated: extract_json_number(s, "truncated").unwrap_or(0) as usize,
		})
	}

	/// Every hash this manifest names, as content and as what stood before it.
	///
	/// BOTH halves count, and that is what the sweep rests on: a body named only as some later
	/// version's `was` is the body the row before it restores, and counting `hash` alone would
	/// collect exactly the bytes a user pressing Restore is asking for.
	pub fn hashes(&self) -> Vec<String> {
		let mut out: Vec<String> = Vec::new();
		for e in self.files.iter() {
			if !e.hash.is_empty() {
				out.push(e.hash.clone());
			}
			if let Some(w) = &e.was {
				out.push(w.clone());
			}
		}
		out
	}
}

/// The first [`TURN_FILES_MAX`] entries, and how many were left behind.
pub fn truncate(files: Vec<Entry>) -> (Vec<Entry>, usize) {
	let had = files.len();
	if had <= TURN_FILES_MAX {
		return (files, 0);
	}
	(files.into_iter().take(TURN_FILES_MAX).collect(), had - TURN_FILES_MAX)
}


// ┌───────────────────────────────────────────────────────────────┐
// │ What a path held at a version                                  │
// └───────────────────────────────────────────────────────────────┘

/// What one path was, as at some version.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum At {
	Held {
		hash:    String,
		bytes:   u64,
		mark:    bool,
		skipped: Option<String>,
	},
	Gone,
}

impl At {

	/// The body this state restores from, or `None` where there is nothing to write.
	pub fn hash(&self) -> Option<&str> {
		match self {
			Self::Held { hash, skipped: None, .. }	=> Some(hash.as_str()),
			_					=> None,
		}
	}

	/// Is this a file on the user's computer rather than in browser storage?
	pub fn mark(&self) -> bool {
		matches!(self, Self::Held { mark: true, .. })
	}
}

/// Every path these manifests have ever named, as it stood at `want`.
///
/// **The union and not the survivors**, because that is what a whole-version restore needs: a
/// file created AFTER `want` has to be removed to put the Diamond back, and a resolver that
/// answered only about paths known by `want` would leave it standing and report success. A path
/// with no entry at or before `want` is therefore [`At::Gone`], exactly as one whose newest entry
/// at or before it says the file was deleted.
///
/// Sparse, so the answer for a path is its newest entry at or before `want` and nothing is walked
/// twice. Ordered by path, so two calls over the same store answer in the same order.
///
/// # Arguments
/// * `manifests` - Every manifest held, by version, in any order.
/// * `want` - The version to resolve as at.
pub fn state_at(manifests: &[(u64, Manifest)], want: u64) -> Vec<(String, At)> {
	let mut sorted: Vec<&(u64, Manifest)> = manifests.iter().collect();
	sorted.sort_by_key(|(n, _)| *n);
	let mut out: BTreeMap<String, At> = BTreeMap::new();
	for (n, m) in sorted.iter() {
		for e in m.files.iter() {
			// Every path is admitted whatever its version, so the union holds; only the
			// STATE is taken from the entries at or before `want`.
			out.entry(e.path.clone()).or_insert(At::Gone);
			if *n > want {
				continue;
			}
			let at = if e.gone {
				At::Gone
			} else {
				At::Held {
					hash:    e.hash.clone(),
					bytes:   e.bytes,
					mark:    e.mark,
					skipped: e.skipped.clone(),
				}
			};
			out.insert(e.path.clone(), at);
		}
	}
	out.into_iter().collect()
}

/// What one path held as at `want`, or `None` where the store cannot say.
///
/// **A file the store met part-way through its life still held something before it.**  The first
/// entry naming a path that already existed carries its prior bytes as `was`, so "what did this
/// hold at a version before that entry" has an answer, and it is that hash -- which is the whole
/// of what makes the FIRST change to a file undoable rather than only the second.  Without the
/// fallback below, the one change a person is likeliest to regret answered "no record of it at
/// that version" while the bytes sat in the store under the hash the manifest names.
///
/// `None` is kept for the two cases where there really is nothing: a path no manifest names, and
/// one whose earliest entry carries no `was` -- a file this store first saw being CREATED did not
/// exist before it, and an older version is not an answer to a question about a state the user
/// never saw.  The size is not recoverable from a `was` (a manifest records the hash alone), so
/// the row answers `bytes: 0`; nothing restores from the length, and the hash is exact.
///
/// [`state_at`] is deliberately NOT changed to match.  It composes a whole SNAPSHOT out of the
/// rows at or before `want`, and a path with no row there was not in that snapshot -- which is
/// what lets a whole-version restore remove a file made since.
pub fn path_at(manifests: &[(u64, Manifest)], path: &str, want: u64) -> Option<At> {
	let held = |e: &Entry| -> At {
		if e.gone {
			At::Gone
		} else {
			At::Held {
				hash:    e.hash.clone(),
				bytes:   e.bytes,
				mark:    e.mark,
				skipped: e.skipped.clone(),
			}
		}
	};
	let mut best:   Option<(u64, At)> = None;
	let mut before: Option<(u64, At)> = None;      // what the earliest LATER entry says stood here
	for (n, m) in manifests.iter() {
		for e in m.files.iter().filter(|e| e.path == path) {
			if *n > want {
				let was = match &e.was {
					Some(w) => w.clone(),
					None    => continue,           // created here, so there was nothing before
				};
				let stood = At::Held { hash: was, bytes: 0, mark: e.mark, skipped: None };
				match &before {
					Some((seen, _)) if *seen <= *n	=> {},
					_				=> before = Some((*n, stood)),
				}
				continue;
			}
			match &best {
				Some((seen, _)) if *seen >= *n	=> {},
				_				=> best = Some((*n, held(e))),
			}
		}
	}
	best.or(before).map(|(_, at)| at)
}

/// The version to undo one path to when nobody said which: what it held before the newest change
/// to it, and the version that change was recorded at.
///
/// `None` where the path has no history here at all, and where its newest entry carries no `was`
/// -- a file whose prior bytes were never captured has nothing to go back to, and answering with
/// an older version would restore a state the user never saw.
pub fn undo_target(manifests: &[(u64, Manifest)], path: &str) -> Option<(u64, String)> {
	let mut best: Option<(u64, Option<String>)> = None;
	for (n, m) in manifests.iter() {
		for e in m.files.iter().filter(|e| e.path == path) {
			match &best {
				Some((seen, _)) if *seen >= *n	=> {},
				_				=> best = Some((*n, e.was.clone())),
			}
		}
	}
	match best {
		Some((n, Some(was)))	=> Some((n, was)),
		_			=> None,
	}
}

/// The last-known hash of every path the manifests name, which is what a fresh change is compared
/// against.
///
/// **This is the index, derived rather than stored.** The launch plan kept it in a
/// `versions/index.json`; a second copy of a fact the manifests already carry is a second thing
/// for a prune to leave behind, and the store is small enough that reading it costs one directory
/// walk either way. A path whose whole history has been pruned falls out of this and its next
/// change records `was: null`, which is honest -- the body it would have named is gone too.
pub fn index_of(manifests: &[(u64, Manifest)]) -> BTreeMap<String, String> {
	let mut out = BTreeMap::new();
	for (path, at) in state_at(manifests, u64::MAX) {
		if let At::Held { hash, .. } = at {
			if !hash.is_empty() {
				out.insert(path, hash);
			}
		}
	}
	out
}


// ┌───────────────────────────────────────────────────────────────┐
// │ Pruning, and the sweep under it                                │
// └───────────────────────────────────────────────────────────────┘

/// What a prune is working to.
#[derive(Clone, Copy, Debug)]
pub struct Caps {
	pub bytes:     u64,
	pub manifests: usize,
}

impl Default for Caps {
	fn default() -> Self {
		Self { bytes: versions_bytes_cap(), manifests: MANIFESTS_MAX }
	}
}

/// What a prune would remove: the manifests, then the bodies nothing names any more.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct Prune {
	pub manifests: Vec<u64>,
	pub bodies:    Vec<String>,
}

impl Prune {
	pub fn is_empty(&self) -> bool {
		self.manifests.is_empty() && self.bodies.is_empty()
	}
}

/// Which manifests to drop, and which bodies fall out with them.
///
/// **Manifests go by cause and then by age**, in the order [`Cause::prune_rank`] sets: the
/// hundreds a turn and the user's own doors make, then the discontinuities, then -- only when
/// there is nothing else left -- a version the user deliberately saved.
///
/// **Bodies go by reference count**, over the manifests that remain, counting `hash` and `was`
/// alike. There are no chains, so a body swept here cannot invalidate a version that is still
/// held: every remaining version names every body it needs, directly.
///
/// The newest manifest is never dropped. A store whose single manifest is already over the
/// ceiling is left at one rather than emptied -- a cap is a budget, and emptying the history to
/// meet it would spend the thing the budget is for.
///
/// # Arguments
/// * `manifests` - Every manifest held, by version, in any order.
/// * `held` - The bodies actually on disk, by hash and size in bytes.
/// * `caps` - The ceilings in force.
pub fn prune_plan(manifests: &[(u64, Manifest)], held: &[(String, u64)], caps: Caps) -> Prune {
	let sizes: BTreeMap<&str, u64> = held.iter().map(|(h, n)| (h.as_str(), *n)).collect();
	let newest = manifests.iter().map(|(n, _)| *n).max().unwrap_or(0);

	// Oldest and cheapest first, and the newest manifest is not a candidate at all.
	let mut order: Vec<(u8, u64)> = manifests.iter()
		.filter(|(n, _)| *n != newest)
		.map(|(n, m)| (m.cause.prune_rank(), *n))
		.collect();
	order.sort();

	let mut keep: BTreeSet<u64> = manifests.iter().map(|(n, _)| *n).collect();
	let mut dropped: Vec<u64> = Vec::new();
	for (_, n) in order.into_iter() {
		if within(manifests, &keep, &sizes, caps) {
			break;
		}
		keep.remove(&n);
		dropped.push(n);
	}

	let live = live_hashes(manifests, &keep);
	let mut bodies: Vec<String> = held.iter()
		.map(|(h, _)| h.clone())
		.filter(|h| !live.contains(h))
		.collect();
	bodies.sort();
	dropped.sort();
	Prune { manifests: dropped, bodies }
}

/// The bodies nothing on disk names any more.
///
/// The sweep on its own, for the caller that has just written a manifest and wants the store tidy
/// without asking whether a cap was crossed.
pub fn unreferenced(manifests: &[(u64, Manifest)], held: &[String]) -> Vec<String> {
	let keep: BTreeSet<u64> = manifests.iter().map(|(n, _)| *n).collect();
	let live = live_hashes(manifests, &keep);
	let mut out: Vec<String> = held.iter().filter(|h| !live.contains(*h)).cloned().collect();
	out.sort();
	out
}

/// Every hash the kept manifests name, as content or as what stood before it.
fn live_hashes(manifests: &[(u64, Manifest)], keep: &BTreeSet<u64>) -> BTreeSet<String> {
	let mut out = BTreeSet::new();
	for (_, m) in manifests.iter().filter(|(n, _)| keep.contains(n)) {
		for h in m.hashes() {
			out.insert(h);
		}
	}
	out
}

/// Is the store inside both ceilings with just these manifests kept?
fn within(
	manifests: &[(u64, Manifest)],
	keep:      &BTreeSet<u64>,
	sizes:     &BTreeMap<&str, u64>,
	caps:      Caps,
)
	-> bool
{
	if keep.len() > caps.manifests {
		return false;
	}
	let live = live_hashes(manifests, keep);
	let used: u64 = live.iter()
		.map(|h| sizes.get(h.as_str()).copied().unwrap_or(0))
		.fold(0u64, |a, b| a.saturating_add(b));
	used <= caps.bytes
}

/// What the bodies these manifests name weigh, of what is actually on disk.
///
/// The gauge's numerator. A hash the manifests name and the disk does not weighs nothing -- it is
/// the "not on this device" case, and charging for bytes that are not here would read as a store
/// the user cannot empty.
pub fn used_bytes(manifests: &[(u64, Manifest)], held: &[(String, u64)]) -> u64 {
	let keep: BTreeSet<u64> = manifests.iter().map(|(n, _)| *n).collect();
	let live = live_hashes(manifests, &keep);
	held.iter()
		.filter(|(h, _)| live.contains(h))
		.map(|(_, n)| *n)
		.fold(0u64, |a, b| a.saturating_add(b))
}


// ┌───────────────────────────────────────────────────────────────┐
// │ What the daimon is told                                        │
// └───────────────────────────────────────────────────────────────┘

/// The one line appended to a turn's outcome when that turn earned a manifest.
///
/// Model-facing English, one sentence, and it says both halves: what changed, and that there is a
/// way back. Without the second half a daimon asked to undo its own work reports that it cannot
/// -- the failure `Tool::FileShow` was written for, arriving by another road.
///
/// # Arguments
/// * `version` - The version the manifest was written at.
/// * `names` - The paths it listed, in the order the manifest holds them.
pub fn tail_note(version: u64, names: &[String]) -> String {
	let shown: Vec<&str> = names.iter().take(6).map(|s| s.as_str()).collect();
	let rest = names.len().saturating_sub(shown.len());
	let tail = if rest > 0 { fmt!(" and {} more", rest) } else { String::new() };
	fmt!("[Daimond: this turn changed {} file{} (v{}): {}{}. The user can restore any of them \
		from History, and file_revert does the same when they ask.]",
		names.len(), if names.len() == 1 { "" } else { "s" }, version, shown.join(", "), tail)
}


// ┌───────────────────────────────────────────────────────────────┐
// │ Showing one change                                             │
// └───────────────────────────────────────────────────────────────┘

/// One row of a before/after view.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Row {
	Same(String),
	Del(String),
	Add(String),
}

/// The lines that differ between two versions of a file, for the History's View.
///
/// `fe2o3_ore::diff` makes byte patches, which is what the crystal chain wants and the opposite
/// of what a person reading a row wants; this is the readable one, and it is here rather than in
/// the page because the daimon's `file_revert` answer shows the same thing.
///
/// Bounded twice over, and both bounds are about the phone. A file past [`DIFF_LINES_MAX`] lines
/// is refused outright. Inside that, the common head and tail are taken off first and only the
/// middle is matched line by line -- and where the middle is past [`DIFF_LCS_MAX`] on either side
/// it is reported as one replacement, because the table an exact match needs is the product of
/// the two sides.
pub fn line_diff(before: &str, after: &str) -> Outcome<Vec<Row>> {
	// `"".split('\n')` yields one empty element, not zero -- unguarded, a brand-new file (an
	// empty `before`) reads as one phantom blank line removed, and a deleted file as one
	// phantom blank line added.
	let a: Vec<&str> = if before.is_empty() { Vec::new() } else { before.split('\n').collect() };
	let b: Vec<&str> = if after.is_empty() { Vec::new() } else { after.split('\n').collect() };
	if a.len() > DIFF_LINES_MAX || b.len() > DIFF_LINES_MAX {
		return Err(err!(
			"A comparison of {} lines against {} is past the {} this shows, so these two \
			versions are not compared line by line.", a.len(), b.len(), DIFF_LINES_MAX;
			Invalid, Input, Size));
	}
	let mut head = 0;
	while head < a.len() && head < b.len() && a[head] == b[head] {
		head += 1;
	}
	let mut tail = 0;
	while tail < a.len() - head && tail < b.len() - head
		&& a[a.len() - 1 - tail] == b[b.len() - 1 - tail]
	{
		tail += 1;
	}
	let mid_a = &a[head..a.len() - tail];
	let mid_b = &b[head..b.len() - tail];

	let mut out: Vec<Row> = Vec::new();
	for line in a[..head].iter() {
		out.push(Row::Same(line.to_string()));
	}
	if mid_a.len() > DIFF_LCS_MAX || mid_b.len() > DIFF_LCS_MAX {
		for line in mid_a.iter() {
			out.push(Row::Del(line.to_string()));
		}
		for line in mid_b.iter() {
			out.push(Row::Add(line.to_string()));
		}
	} else {
		out.extend(lcs_rows(mid_a, mid_b));
	}
	for line in a[a.len() - tail..].iter() {
		out.push(Row::Same(line.to_string()));
	}
	Ok(out)
}

/// The middle of a diff, matched through the longest common subsequence of its lines.
fn lcs_rows(a: &[&str], b: &[&str]) -> Vec<Row> {
	let (n, m) = (a.len(), b.len());
	// One row longer than each side, so the walk below never tests an index against a bound.
	let mut table = vec![0u32; (n + 1) * (m + 1)];
	let at = |i: usize, j: usize| i * (m + 1) + j;
	for i in (0..n).rev() {
		for j in (0..m).rev() {
			table[at(i, j)] = if a[i] == b[j] {
				table[at(i + 1, j + 1)] + 1
			} else {
				table[at(i + 1, j)].max(table[at(i, j + 1)])
			};
		}
	}
	let mut out: Vec<Row> = Vec::new();
	let (mut i, mut j) = (0usize, 0usize);
	while i < n && j < m {
		if a[i] == b[j] {
			out.push(Row::Same(a[i].to_string()));
			i += 1;
			j += 1;
		} else if table[at(i + 1, j)] >= table[at(i, j + 1)] {
			out.push(Row::Del(a[i].to_string()));
			i += 1;
		} else {
			out.push(Row::Add(b[j].to_string()));
			j += 1;
		}
	}
	while i < n {
		out.push(Row::Del(a[i].to_string()));
		i += 1;
	}
	while j < m {
		out.push(Row::Add(b[j].to_string()));
		j += 1;
	}
	out
}

/// How many lines a diff adds and removes, for the row's `+12 −3`.
pub fn diff_counts(rows: &[Row]) -> (usize, usize) {
	let add = rows.iter().filter(|r| matches!(r, Row::Add(_))).count();
	let del = rows.iter().filter(|r| matches!(r, Row::Del(_))).count();
	(add, del)
}


// ┌───────────────────────────────────────────────────────────────┐
// │ Reading an array of objects                                    │
// └───────────────────────────────────────────────────────────────┘

/// The inside of `"key":[ … ]`, brackets excluded, or `None` where the key names no array.
fn array_inside<'a>(json: &'a str, key: &str) -> Option<&'a str> {
	let needle = fmt!("\"{}\":", key);
	let pos = json.find(&needle)? + needle.len();
	let bytes = json.as_bytes();
	let mut i = pos;
	while i < bytes.len() && bytes[i].is_ascii_whitespace() {
		i += 1;
	}
	if i >= bytes.len() || bytes[i] != b'[' {
		return None;
	}
	let open = i;
	let mut depth = 0i32;
	let mut in_str = false;
	let mut esc = false;
	while i < bytes.len() {
		let c = bytes[i];
		if in_str {
			if esc {
				esc = false;
			} else if c == b'\\' {
				esc = true;
			} else if c == b'"' {
				in_str = false;
			}
		} else {
			match c {
				b'"'		=> in_str = true,
				b'[' | b'{'	=> depth += 1,
				b']' | b'}'	=> {
					depth -= 1;
					if depth == 0 {
						return Some(&json[open + 1..i]);
					}
				},
				_		=> {},
			}
		}
		i += 1;
	}
	None
}

/// Each top-level `{ … }` inside an array's body, whole.
///
/// The scan is string-aware, so a path holding a brace or a quote does not end an object early --
/// which is not a theoretical file name: a capp's own data directories are named by their users.
fn objects_in(arr: &str) -> Vec<&str> {
	let bytes = arr.as_bytes();
	let mut out: Vec<&str> = Vec::new();
	let mut depth = 0i32;
	let mut start = 0usize;
	let mut in_str = false;
	let mut esc = false;
	for (i, &c) in bytes.iter().enumerate() {
		if in_str {
			if esc {
				esc = false;
			} else if c == b'\\' {
				esc = true;
			} else if c == b'"' {
				in_str = false;
			}
			continue;
		}
		match c {
			b'"'	=> in_str = true,
			b'{'	=> {
				if depth == 0 {
					start = i;
				}
				depth += 1;
			},
			b'}'	=> {
				depth -= 1;
				if depth == 0 {
					out.push(&arr[start..=i]);
				}
			},
			_	=> {},
		}
	}
	out
}


#[cfg(test)]
mod tests {
	use super::*;

	/// The shipped Log Life page: the real file the history is full of, so the diff is measured
	/// against real markup rather than a fixture shaped to flatter it.
	const PAGE: &str = include_str!("../www/capps/lifelog/crystal.html");

	fn e(path: &str, body: &str, was: Option<&str>) -> Entry {
		Entry::changed(path, body.as_bytes(), was.map(|s| hash_of(s.as_bytes())))
	}

	fn m(cause: Cause, files: Vec<Entry>) -> Manifest {
		Manifest::new(cause, 1_757_900_000_000, "m_1", "", files)
	}

	#[test]
	fn test_a_manifest_reads_back_as_the_manifest_it_was_written_from() -> Outcome<()> {
		let mut gone = e("old.md", "", None);
		gone.gone = true;
		gone.hash = String::new();
		gone.was = Some(hash_of(b"was here"));
		let mut mark = e("/home/j/site/index.html", "<p>hi</p>", Some("<p>ho</p>"));
		mark.mark = true;
		let mut big = e("big.pdf", "x", None);
		big.skipped = Some("size".to_string());
		let want = Manifest::new(Cause::Turn, 17, "m_9f3c",
			"/pickup \"daimond\"\nand a tab\t", vec![
				e("REQUIREMENTS.md", "- [ ] one\n", Some("- [ ] nought\n")),
				e("notes/pl{an}.typ", "#set page()\n", None),
				gone,
				mark,
				big,
			]);
		let got = res!(Manifest::from_json(&want.to_json()));
		assert_eq!(want, got);
		Ok(())
	}

	#[test]
	fn test_a_cause_this_build_does_not_know_is_refused_rather_than_read_as_a_turn() {
		let json = r#"{"v":1,"ts":1,"cause":"rewind","turn":"","note":"","files":[]}"#;
		assert!(Manifest::from_json(json).is_err());
	}

	#[test]
	fn test_a_manifest_missing_every_optional_field_still_parses() -> Outcome<()> {
		let got = res!(Manifest::from_json(r#"{"cause":"user"}"#));
		assert_eq!(Cause::User, got.cause);
		assert!(got.files.is_empty());
		assert_eq!(0, got.truncated);
		Ok(())
	}

	#[test]
	fn test_the_same_content_written_three_times_is_one_body() {
		let a = hash_of(b"alpha");
		let b = hash_of(b"beta");
		assert_eq!(a, hash_of(b"alpha"));
		assert_ne!(a, b);
		let held: BTreeSet<String> = [a.clone(), b.clone(), a.clone()].into_iter().collect();
		assert_eq!(2, held.len(), "the third write of content already held is not a body");
	}

	#[test]
	fn test_a_hash_is_sixty_four_lowercase_hex_characters() {
		let h = hash_of(b"");
		assert_eq!(64, h.len());
		assert!(is_hash(&h));
		assert!(!is_hash("../../etc/passwd"));
		assert!(!is_hash(&h.to_uppercase()));
	}

	#[test]
	fn test_the_state_at_a_version_is_the_newest_entry_at_or_before_it() {
		let ms = vec![
			(1, m(Cause::Turn, vec![e("a.md", "one", None)])),
			(3, m(Cause::Turn, vec![e("a.md", "two", Some("one"))])),
			(5, m(Cause::Turn, vec![e("b.md", "bee", None)])),
		];
		let at3 = state_at(&ms, 3);
		let a = at3.iter().find(|(p, _)| p == "a.md").map(|(_, s)| s.clone());
		assert_eq!(Some(hash_of(b"two")), a.and_then(|s| s.hash().map(|h| h.to_string())));
		// Named at 5 and so present in the union, and Gone as at 3 -- which is what makes a
		// whole-version restore able to REMOVE it.
		let b = at3.iter().find(|(p, _)| p == "b.md").map(|(_, s)| s.clone());
		assert_eq!(Some(At::Gone), b);
	}

	#[test]
	fn test_a_path_deleted_and_made_again_reads_as_each_in_turn() {
		let mut gone = e("a.md", "", None);
		gone.gone = true;
		gone.hash = String::new();
		gone.was = Some(hash_of(b"one"));
		let ms = vec![
			(1, m(Cause::Turn, vec![e("a.md", "one", None)])),
			(2, m(Cause::Turn, vec![gone])),
			(4, m(Cause::User, vec![e("a.md", "three", None)])),
		];
		assert!(matches!(path_at(&ms, "a.md", 1), Some(At::Held { .. })));
		assert_eq!(Some(At::Gone), path_at(&ms, "a.md", 3));
		assert_eq!(Some(hash_of(b"three")),
			path_at(&ms, "a.md", 9).and_then(|s| s.hash().map(|h| h.to_string())));
		assert_eq!(None, path_at(&ms, "never.md", 9));
	}

	/// **The FIRST change to a file is undoable, not only the second.**
	///
	/// A file the store meets part-way through its life has no row before the one that changed
	/// it -- but that row carries what stood there, and the body is kept under that hash. Without
	/// the fallback a Restore aimed one version back answered "no record of it at that version"
	/// about bytes that were on disk the whole time, which is the marked-folder case in
	/// `dev/verify_versions.mjs` §11 and the commonest case of all: the file nobody has touched
	/// since Daimond met it.
	#[test]
	fn test_a_file_the_store_met_part_way_still_says_what_stood_before_it() {
		let ms = vec![
			(4, m(Cause::Turn, vec![e("live/site.txt", "v2 by the daimon", Some("v1 on the site"))])),
			(6, m(Cause::Turn, vec![e("live/site.txt", "v3", Some("v2 by the daimon"))])),
		];
		// Before the store had ever named it: what the earliest entry says stood there.
		assert_eq!(Some(hash_of(b"v1 on the site")),
			path_at(&ms, "live/site.txt", 3).and_then(|s| s.hash().map(|h| h.to_string())));
		// And the EARLIEST later entry, not whichever one came to hand: v6's `was` is v2, which
		// is a state that did exist -- but not at 3.
		assert_eq!(Some(hash_of(b"v2 by the daimon")),
			path_at(&ms, "live/site.txt", 4).and_then(|s| s.hash().map(|h| h.to_string())));
		// A file this store first saw being CREATED did not exist before it, and answering with
		// an older version would restore a state the user never saw.
		let made = vec![(4, m(Cause::Turn, vec![e("notes/new.md", "born here", None)]))];
		assert_eq!(None, path_at(&made, "notes/new.md", 3));
		// A path no manifest has ever named is still nothing at all.
		assert_eq!(None, path_at(&ms, "never.md", 3));
		// THE SNAPSHOT IS NOT CHANGED WITH IT: a whole-version restore composes what the rows at
		// or before N say, which is what lets it remove a file made since.
		let at3 = state_at(&ms, 3);
		assert_eq!(Some(At::Gone), at3.iter().find(|(p, _)| p == "live/site.txt").map(|(_, s)| s.clone()));
	}

	#[test]
	fn test_undo_of_a_path_goes_to_what_stood_before_its_newest_change() {
		let ms = vec![
			(1, m(Cause::Turn, vec![e("a.md", "one", None)])),
			(3, m(Cause::Turn, vec![e("a.md", "two", Some("one"))])),
		];
		assert_eq!(Some((3, hash_of(b"one"))), undo_target(&ms, "a.md"));
		// A file this store first saw as a creation has nothing to go back to, and an older
		// version is not an answer to a question about a state the user never saw.
		let fresh = vec![(1, m(Cause::Turn, vec![e("new.md", "x", None)]))];
		assert_eq!(None, undo_target(&fresh, "new.md"));
	}

	#[test]
	fn test_the_index_is_the_newest_hash_of_every_path_and_needs_no_file() {
		let ms = vec![
			(1, m(Cause::Turn, vec![e("a.md", "one", None), e("b.md", "bee", None)])),
			(3, m(Cause::User, vec![e("a.md", "two", Some("one"))])),
		];
		let ix = index_of(&ms);
		assert_eq!(Some(&hash_of(b"two")), ix.get("a.md"));
		assert_eq!(Some(&hash_of(b"bee")), ix.get("b.md"));
	}

	#[test]
	fn test_prune_takes_turns_before_folds_and_a_user_save_last_of_all() {
		let ms = vec![
			(1, m(Cause::Turn,    vec![e("a", "1", None)])),
			(2, m(Cause::Save,    vec![e("a", "2", None)])),
			(3, m(Cause::Fold,    vec![e("a", "3", None)])),
			(4, m(Cause::User,    vec![e("a", "4", None)])),
			(5, m(Cause::Restore, vec![e("a", "5", None)])),
			(6, m(Cause::Turn,    vec![e("a", "6", None)])),
		];
		let held: Vec<(String, u64)> = (1..=6)
			.map(|n| (hash_of(fmt!("{}", n).as_bytes()), 1_000u64))
			.collect();
		// Room for three manifests' worth of bodies, so three must go.
		let plan = prune_plan(&ms, &held, Caps { bytes: 3_000, manifests: MANIFESTS_MAX });
		// The two cheapest causes first, oldest within each, and then a discontinuity; the
		// list itself comes back in version order.
		assert_eq!(vec![1, 3, 4], plan.manifests);
		assert!(!plan.manifests.contains(&2), "a user's own save was pruned before a turn's");
		assert!(!plan.manifests.contains(&5), "a restore went before the fold above it");
		assert!(!plan.manifests.contains(&6), "the newest manifest was pruned");
	}

	#[test]
	fn test_the_manifest_ceiling_prunes_even_where_the_bytes_would_fit() {
		let ms: Vec<(u64, Manifest)> = (1..=5)
			.map(|n| (n, m(Cause::Turn, vec![e("a", &fmt!("{}", n), None)])))
			.collect();
		let held: Vec<(String, u64)> = (1..=5)
			.map(|n| (hash_of(fmt!("{}", n).as_bytes()), 1u64))
			.collect();
		let plan = prune_plan(&ms, &held, Caps { bytes: u64::MAX, manifests: 3 });
		assert_eq!(vec![1, 2], plan.manifests);
	}

	#[test]
	fn test_a_store_of_one_oversized_manifest_is_left_at_one_rather_than_emptied() {
		let ms = vec![(7, m(Cause::Turn, vec![e("a", "big", None)]))];
		let held = vec![(hash_of(b"big"), 9_000_000u64)];
		let plan = prune_plan(&ms, &held, Caps { bytes: 1, manifests: 1 });
		assert!(plan.manifests.is_empty(), "the only version held was pruned away");
		assert!(plan.bodies.is_empty(), "the body of the only version held was swept");
	}

	#[test]
	fn test_the_sweep_keeps_a_body_named_only_as_what_stood_before() {
		// Version 2 changed `a` and names the OLD content as `was`. Version 1, which held that
		// content, is pruned -- and the body must stay, because version 2's row restores it.
		let ms = vec![
			(1, m(Cause::Turn, vec![e("a", "one", None)])),
			(2, m(Cause::Turn, vec![e("a", "two", Some("one"))])),
		];
		let held = vec![(hash_of(b"one"), 3u64), (hash_of(b"two"), 3u64)];
		let plan = prune_plan(&ms, &held, Caps { bytes: 4, manifests: MANIFESTS_MAX });
		assert_eq!(vec![1], plan.manifests);
		assert!(plan.bodies.is_empty(),
			"the body version 2 names as `was` was swept, so its row restores nothing");
	}

	#[test]
	fn test_a_body_nothing_names_is_swept() {
		let ms = vec![(1, m(Cause::Turn, vec![e("a", "one", None)]))];
		let held = vec![hash_of(b"one"), hash_of(b"orphan")];
		assert_eq!(vec![hash_of(b"orphan")], unreferenced(&ms, &held));
	}

	#[test]
	fn test_a_body_named_but_not_on_disk_weighs_nothing_in_the_gauge() {
		let ms = vec![(1, m(Cause::Turn, vec![e("a", "one", None), e("b", "two", None)]))];
		let held = vec![(hash_of(b"one"), 100u64)];
		assert_eq!(100, used_bytes(&ms, &held));
	}

	#[test]
	fn test_a_turn_that_wrote_more_than_sixty_four_files_records_the_first_sixty_four() -> Outcome<()> {
		let files: Vec<Entry> = (0..100)
			.map(|n| e(&fmt!("f{}.md", n), &fmt!("{}", n), None))
			.collect();
		let man = m(Cause::Turn, files);
		assert_eq!(TURN_FILES_MAX, man.files.len());
		assert_eq!(100 - TURN_FILES_MAX, man.truncated);
		let back = res!(Manifest::from_json(&man.to_json()));
		assert_eq!(100 - TURN_FILES_MAX, back.truncated);
		Ok(())
	}

	#[test]
	fn test_a_manifest_name_carries_its_version_and_is_not_a_crystal_snapshot() {
		assert_eq!("0007.files.json", manifest_name(7));
		assert_eq!(Some(7), manifest_version("0007.files.json"));
		assert_eq!(None, manifest_version("0007.json"));
		assert_eq!(None, manifest_version("0007.jpatch"));
		// The crystal chain's own reader, read the other way: `0007.files` does not parse as a
		// number, so a manifest is not taken for a data keyframe.
		assert_eq!(None, "0007.files.json".strip_suffix(".json")
			.and_then(|s| s.parse::<u64>().ok()));
	}

	/// The fixture is the page a Diamond's History will most often be asked to compare, so the
	/// ceiling is asserted against it rather than against a number: a page that outgrew the
	/// ceiling would show "Cannot compare" and nothing would say why.
	#[test]
	fn test_the_shipped_capp_page_fits_inside_the_comparison_ceiling() {
		assert!(PAGE.split('\n').count() <= DIFF_LINES_MAX,
			"the Log Life page is {} lines, past the {} a comparison shows",
			PAGE.split('\n').count(), DIFF_LINES_MAX);
	}

	#[test]
	fn test_the_diff_of_a_page_against_itself_is_every_line_unchanged() -> Outcome<()> {
		let rows = res!(line_diff(PAGE, PAGE));
		assert_eq!((0, 0), diff_counts(&rows));
		assert_eq!(PAGE.split('\n').count(), rows.len());
		Ok(())
	}

	#[test]
	fn test_one_changed_line_in_a_page_is_one_added_and_one_removed() -> Outcome<()> {
		let first = PAGE.split('\n').next().unwrap_or_default();
		let after = PAGE.replacen(first, "<!-- changed -->", 1);
		let rows = res!(line_diff(PAGE, &after));
		assert_eq!((1, 1), diff_counts(&rows));
		Ok(())
	}

	#[test]
	fn test_an_insertion_is_read_as_an_addition_and_not_as_a_rewrite() -> Outcome<()> {
		let rows = res!(line_diff("a\nb\nc", "a\nb\nnew\nc"));
		assert_eq!((1, 0), diff_counts(&rows));
		assert!(rows.contains(&Row::Add("new".to_string())));
		Ok(())
	}

	#[test]
	fn test_a_file_past_the_line_ceiling_is_refused_rather_than_compared() {
		let long = vec!["x"; DIFF_LINES_MAX + 1].join("\n");
		assert!(line_diff(&long, "x").is_err());
	}

	/// A brand-new file has no `before` at all, not a `before` of one blank line -- so its diff
	/// must be all-add, with no phantom deletion.
	#[test]
	fn test_a_new_file_diffs_as_all_add_with_no_phantom_deletion() -> Outcome<()> {
		let rows = res!(line_diff("", "a\nb\nc"));
		assert_eq!((3, 0), diff_counts(&rows));
		Ok(())
	}

	/// A deleted file has no `after` at all -- its diff must be all-remove, with no phantom
	/// addition.
	#[test]
	fn test_a_deleted_file_diffs_as_all_remove_with_no_phantom_addition() -> Outcome<()> {
		let rows = res!(line_diff("a\nb\nc", ""));
		assert_eq!((0, 3), diff_counts(&rows));
		Ok(())
	}

	#[test]
	fn test_the_tail_note_names_the_files_and_the_way_back() {
		let note = tail_note(54, &["a.md".to_string(), "b.md".to_string()]);
		assert!(note.contains("2 files (v54): a.md, b.md"), "{}", note);
		assert!(note.contains("file_revert"), "{}", note);
		let one = tail_note(1, &["a.md".to_string()]);
		assert!(one.contains("1 file (v1)"), "{}", one);
	}

	#[test]
	fn test_the_cap_setter_moves_the_ceiling_and_zero_puts_it_back() {
		set_versions_bytes_cap(64 * 1024);
		assert_eq!(64 * 1024, versions_bytes_cap());
		set_versions_bytes_cap(0);
		assert_eq!(VERSIONS_BYTES_DEFAULT, versions_bytes_cap());
	}

	#[test]
	fn test_an_object_scan_is_not_ended_early_by_a_brace_inside_a_path() {
		let arr = r#"{"path":"a{b}.md","hash":"x"},{"path":"c\"d.md","hash":"y"}"#;
		let objs = objects_in(arr);
		assert_eq!(2, objs.len());
		assert_eq!(Some("a{b}.md".to_string()), extract_json_string(objs[0], "path"));
		assert_eq!(Some("c\"d.md".to_string()), extract_json_string(objs[1], "path"));
	}

	#[test]
	fn test_an_array_is_found_whole_past_the_objects_nested_in_it() {
		let json = r#"{"note":"[not an array]","files":[{"path":"a"},{"path":"b"}]}"#;
		let arr = array_inside(json, "files").unwrap_or_default();
		assert_eq!(2, objects_in(arr).len());
		assert_eq!(None, array_inside(json, "note"));
	}
}
