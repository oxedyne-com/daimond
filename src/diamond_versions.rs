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

/// How long a version recording a destruction is kept whatever the ceiling says, in milliseconds:
/// a file deleted, or a user's file written over with less than half of it left ([`wipes`]).
///
/// **A destroyed file's copy is the one a person cannot get back any other way**, and until
/// 2026-09-23 it went in the same prune round as every ordinary edit: an audit deleted three
/// 400 KiB files in three turns, and after the third the first had no copy left, while the
/// description the model read still said Daimond kept one.  The re-check that day did the same by
/// emptying files instead of deleting them.  Within this window such a version is not a prune
/// candidate at all; after it, it is the last to go ([`prune_rank_of`]).  What keeps the window
/// from holding the store over its ceiling is the turn's side: a destruction the store has no room
/// left to keep is refused ([`retained_bytes`]).
pub const DELETE_HOLD_MS: u64 = 7 * 24 * 60 * 60 * 1000;

/// How many files a turn may delete from a folder the user opened on this computer, or write over
/// leaving less than half of them ([`wipes`]), before the person is asked whether it may go on.
///
/// **Far below [`TURN_FILES_MAX`], on purpose** (decision review of 2026-09-23, decision 2).  The
/// sixty-four a manifest keeps is a fact about the store, not about the property the bound is
/// for: sixty-four deletes on a real disk, each carried off the machine at once by whatever syncs
/// the folder, is a bulk delete however well each copy is kept -- and the copy is on this device
/// only.  So a turn deletes a handful there and then the PERSON is asked, never only the model
/// told.  An emptied file is the same loss under another verb (re-check R4, 2026-09-23: twelve
/// emptied in one turn with no question), and so is one emptied of most of itself, so they count
/// too.  An edit that leaves half of the file or more, and deletes in Daimond's own storage, stay
/// bounded by the store alone.
pub const OPEN_DELETES_ASK_DEFAULT: usize = 8;

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

	/// The open-folder delete limit the user chose, or `None` for [`OPEN_DELETES_ASK_DEFAULT`].
	static OPEN_DELETES_ASK: std::cell::Cell<Option<usize>> = const { std::cell::Cell::new(None) };
}

/// How many files a turn may delete from the user's open folder before they are asked.
pub fn open_deletes_ask() -> usize {
	OPEN_DELETES_ASK.with(|c| c.get()).unwrap_or(OPEN_DELETES_ASK_DEFAULT)
}

/// Set that limit; `None` restores [`OPEN_DELETES_ASK_DEFAULT`].  Held at [`TURN_FILES_MAX`] at
/// most, where the store stops a turn whatever was asked.
///
/// # Arguments
/// * `n` - Files a turn may delete there before the person is asked, or `None` for the default.
pub fn set_open_deletes_ask(n: Option<usize>) {
	OPEN_DELETES_ASK.with(|c| c.set(n.map(|v| v.min(TURN_FILES_MAX))));
}

/// What a turn's next delete from the user's open folder may do, as [`OpenTally::room`] answers.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OpenDelete {
	Go(bool),			// under the limit, or let go on: true where this call counted the path
	Ask(usize, u64),	// at the limit, having deleted this many: ask, and answer this question
	Stopped(usize),		// the person said stop: refused for the rest of the turn
}

// A question's ticket: the tally's epoch in the high half and the question in the low, so an
// answer carried over from a turn that has ended cannot land on a question the next turn asks.
// A turn asks at most one question per file, and deletes or wipes `TURN_FILES_MAX` at most.
const TALLY_TICKETS: u64 = 1 << 32;

/// One turn's deletes from the folder the user opened on this computer, in one store, and its
/// writes there that leave less than half of a file ([`wipes`]): one count, keyed by path, so a
/// file emptied and then deleted is one file.
///
/// **Past the limit the PERSON is asked** ([`open_deletes_ask`]) -- once a turn, and the answer
/// holds for the rest of it, as the machine hand's own meter does: go on, still inside the store's
/// bound, or stop.  A stop is final for the turn, so a model cannot ask again by trying again.
///
/// **A limit of none asks about every file** (re-check of 2026-09-23, R7).  The setting reads
/// "Ask before every one", and it asked once: the first yes let the rest of the turn delete there
/// unasked, up to the store's own sixty-four.  At that limit each file is its own question, a yes
/// lets that file go and no other, and a stop is still final for the turn.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct OpenTally {
	epoch:   u64,								// which turn's tally this is
	paths:   std::collections::BTreeSet<String>,	// deleted, or allowed and in flight
	allowed: bool,								// the person let the turn go on
	asked:   Vec<String>,						// the files asked about one at a time, by ticket
	granted: std::collections::BTreeSet<String>,	// let go one at a time, and not yet counted
	stopped: bool,								// the person said stop, or nobody answered
}

impl OpenTally {

	pub fn new(epoch: u64) -> Self {
		Self { epoch, ..Self::default() }
	}

	/// The ticket of the turn's one question; a file's own question is numbered after it.
	fn base(&self) -> u64 {
		self.epoch.saturating_mul(TALLY_TICKETS)
	}

	/// May `path` be deleted now, `limit` being how many a turn may delete before asking?  An
	/// answer of [`OpenDelete::Go`] counts it; a path already counted costs nothing more.
	///
	/// A limit of [`TURN_FILES_MAX`] or more never asks: the store's own bound stops the turn
	/// there first, in words that send the model to the user, and a question the person could
	/// answer yes to only for the store to refuse anyway would be a question that means nothing.
	pub fn room(&mut self, path: &str, limit: usize) -> OpenDelete {
		if self.paths.contains(path) {
			return OpenDelete::Go(false);
		}
		if self.stopped {
			return OpenDelete::Stopped(self.paths.len());
		}
		// A file the person let go on its own is counted now, and it is the only one that is.
		if self.granted.remove(path) {
			self.paths.insert(path.to_string());
			return OpenDelete::Go(true);
		}
		if limit < TURN_FILES_MAX && self.paths.len() >= limit {
			if limit == 0 {
				// Asked about again while unanswered, a file is still one question.
				let k = match self.asked.iter().position(|p| p == path) {
					Some(i)	=> i + 1,
					None	=> {
						self.asked.push(path.to_string());
						self.asked.len()
					},
				};
				return OpenDelete::Ask(self.paths.len(), self.base().saturating_add(k as u64));
			}
			if !self.allowed {
				return OpenDelete::Ask(self.paths.len(), self.base());
			}
		}
		self.paths.insert(path.to_string());
		OpenDelete::Go(true)
	}

	/// The person's answer to the question `ticket` names, taken only by the tally that asked it:
	/// a yes to the turn's question lets the turn go on, a yes to a file's lets that file go, and
	/// a no to either stops the turn.
	pub fn answer(&mut self, ticket: u64, allow: bool) {
		let base = self.base();
		if ticket < base || ticket - base > self.asked.len() as u64 {
			return;
		}
		if !allow {
			self.stopped = true;
			return;
		}
		match (ticket - base) as usize {
			0	=> self.allowed = true,
			k	=> {
				let path = self.asked[k - 1].clone();
				self.granted.insert(path);
			},
		}
	}

	/// Uncount `path`, whose delete did not happen.
	pub fn release(&mut self, path: &str) {
		self.paths.remove(path);
	}
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
// │ Numbers two devices both minted                                │
// └───────────────────────────────────────────────────────────────┘

/// The version number a `versions/` file name begins with -- the four (or more) leading digits
/// before the first dot -- or `None` for a name that is not one of ours (the body directory `b`,
/// a stray file).  `0005.json`, `0005.jpatch`, `0005.html` and `0005.files.json` all answer 5.
pub fn version_prefix(name: &str) -> Option<u64> {
	let stem = name.split('.').next().unwrap_or("");
	if !stem.is_empty() && stem.bytes().all(|b| b.is_ascii_digit()) {
		stem.parse::<u64>().ok()
	} else {
		None
	}
}

/// The number the next version takes: one past the Diamond's counter, and past every number a
/// file in `versions/` already holds.
///
/// **A number already on disk is never minted again** (re-check of 2026-09-23, R5).  An import
/// lays another device's counter down with its `meta.json`, and this device's own manifests
/// above that counter stay where they are -- so the next turn here took one of their numbers and
/// wrote its manifest over it, and a deletion's row and its copy with it.
///
/// # Arguments
/// * `counter` - The version the Diamond's metadata says it is at.
/// * `names` - The names of the files in `versions/`.
pub fn next_version<'a, I>(counter: u64, names: I) -> u64
	where I: IntoIterator<Item = &'a str>
{
	names.into_iter().filter_map(version_prefix).fold(counter, u64::max).saturating_add(1)
}

/// What an import has to do before it lays its own manifests down: see [`rebase_plan`].
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct Rebase {
	pub moves: Vec<(u64, u64)>,	// a manifest here, and the fresh number it is refiled at
	pub drops: Vec<u64>,		// manifest files here to remove once the moves are written
}

impl Rebase {
	pub fn is_empty(&self) -> bool {
		self.moves.is_empty() && self.drops.is_empty()
	}
}

/// Which of this device's manifests an import must refile, and which it must remove, so that both
/// devices' histories survive it.
///
/// **Two devices mint the same numbers.**  A manifest is named by its version, the counter is the
/// Diamond's, and two devices that each record a turn between syncs both take the next number.
/// An import lays the other device's `versions/` over this one's by name, so it wrote over this
/// device's manifest with a different one (re-check of 2026-09-23, R5): a deletion recorded here
/// lost its row, its body was swept as named by nothing, and the copy the user was promised went
/// with no word.
///
/// **What this device recorded since the two parted is rebased above the import**, as the copy
/// kept before a sync already is: every manifest here that the import does not carry, from the
/// first one it would write over, is refiled in order at fresh numbers above everything either
/// side holds.  The import's numbers are left alone, since its metadata, its log and its crystal
/// snapshots are about those.  A manifest the import carries byte for byte, under whatever number,
/// is the same record arriving and is not refiled; a manifest this device holds twice is kept
/// once.  Nothing is ever written over: a number the import fills is either the same bytes, or
/// bytes already refiled, or bytes the import carries elsewhere.
///
/// # Arguments
/// * `mine` - This device's manifests, as (version, [`hash_of`] the file's bytes).
/// * `theirs` - The import's, the same.
/// * `top` - The highest version number either side holds, its counters and its crystal
///   snapshots included.
pub fn rebase_plan(mine: &[(u64, String)], theirs: &[(u64, String)], top: u64) -> Rebase {
	let at: BTreeMap<u64, &str> = theirs.iter().map(|(n, h)| (*n, h.as_str())).collect();
	let carried: BTreeSet<&str> = theirs.iter().map(|(_, h)| h.as_str()).collect();
	let mut sorted: Vec<&(u64, String)> = mine.iter().collect();
	sorted.sort_by_key(|(n, _)| *n);
	let mut seen: BTreeSet<&str> = BTreeSet::new();
	let mut only: Vec<u64> = Vec::new();
	let mut drops: Vec<u64> = Vec::new();
	for (n, h) in sorted.into_iter() {
		let h = h.as_str();
		if at.get(n) == Some(&h) {
			seen.insert(h);
			continue;				// the same record on both sides
		}
		// Carried by the import under a number of its own, or held here twice already: the file
		// goes, unless the import is about to fill its number anyway.
		if carried.contains(h) || !seen.insert(h) {
			if !at.contains_key(n) {
				drops.push(*n);
			}
			continue;
		}
		only.push(*n);
	}
	let fork = match only.iter().find(|n| at.contains_key(*n)) {
		Some(n)	=> *n,
		None	=> return Rebase { moves: Vec::new(), drops },
	};
	let mut moves: Vec<(u64, u64)> = Vec::new();
	let mut next = top;
	for n in only.into_iter().filter(|n| *n >= fork) {
		next = next.saturating_add(1);
		moves.push((n, next));
		// Vacated, and not a number the import fills: the old file would be a second copy.
		if !at.contains_key(&n) {
			drops.push(n);
		}
	}
	drops.sort();
	Rebase { moves, drops }
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
	pub wiped:   bool,		// written over with less than half of `was` left: see `wipes`
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
			wiped:   false,
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
		// Written only when true, like `mark`: a build that has never heard of it reads the row as
		// the ordinary change it also is, and prunes it as one.
		if self.wiped {
			out.push_str(",\"wiped\":true");
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
			wiped:   extract_json_bool(s, "wiped").unwrap_or(false),
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

	/// Does this version record a file destroyed with a copy kept of it -- deleted, or written
	/// over with less than half of it left ([`wipes`])?
	pub fn holds_destruction(&self) -> bool {
		self.files.iter().any(|e| (e.gone || e.wiped) && e.was.is_some())
	}

	/// Does this version keep a copy of a file of the user's -- one outside the keeper's own
	/// home, in the folder they opened or marked in -- that it changed?
	pub fn keeps_users_file(&self) -> bool {
		self.files.iter().any(|e| e.mark && e.was.is_some())
	}

	/// Is this version inside its destruction hold at `now`, and so not a prune candidate?
	///
	/// # Arguments
	/// * `now` - Wall clock, whole milliseconds.
	pub fn held_at(&self, now: u64) -> bool {
		self.holds_destruction() && now.saturating_sub(self.ts) < DELETE_HOLD_MS
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
// │ What a write destroys                                          │
// └───────────────────────────────────────────────────────────────┘

// THE RULE: a write wipes a user's file when less than half of the file, as the turns found it,
// survives the write.
//
// What "survives" means is [`wipes`]; what "as the turns found it" means is [`run_copies`].  A
// wipe is a delete for the hold and for the question: its copy is kept through
// [`DELETE_HOLD_MS`], and in the folder the user opened it counts in [`OpenTally`] as a delete
// does.  Re-check R4 of 2026-09-23, closed in two steps: first a write that kept nothing of a
// file, then -- in the reopen plan's own words -- one that empties most of it.

const KEPT_RUN: usize = 8;					// characters, whitespace aside, that a kept run holds
const KEPT_MEASURE_MAX: usize = 1024 * 1024;	// bytes of changed new text measured; past it, a wipe

/// Does writing `after` over `before` leave less than half of what `before` held?
///
/// **Emptying most of a user's file is a delete by another verb.**  The first form of this rule
/// took a write for a wipe only where it kept no line of the file, so cutting a file down to its
/// first line -- or to the "rest unchanged" a model writes in place of what it did not copy -- was
/// an edit whose copy could be pruned; and a write that changed every line while keeping every
/// word, a paragraph re-wrapped or a file re-indented, was a wipe.
///
/// **What survives is counted in characters, whitespace aside, and a character survives where it
/// lies in a run of eight of the old text's characters that the new text also holds**, each run of
/// the new text standing for one of the old.  Not lines: a paragraph written as one line, as most
/// editors write one, is lost whole to one changed word, and a re-wrap or a re-indent keeps no line
/// at all.  Not size: padding hides any loss from a size, and a page of something else the same
/// length loses nothing by it.  Not single words: a long enough text of any kind holds most of
/// another's words.  Eight is where these part, measured on this repository's own prose, code and
/// Chinese strings: an edit changing one word in three keeps well over half, and a page of
/// something else -- three times as long, or a tenth of the file padded out to three times its
/// length -- keeps under two fifths.
///
/// The common head and tail count as they stand before any run is sought, which is also what makes
/// an ordinary edit cheap to measure: only the changed middle is compared.  A changed middle of the
/// new text past [`KEPT_MEASURE_MAX`] bytes is not measured and is taken for a wipe, the side that
/// keeps the copy.  A text too short for one run is one run.  Where either side is not text, any
/// change replaces it; and a file with no content -- empty, or nothing but whitespace -- has
/// nothing to lose.
///
/// # Arguments
/// * `before` - What the write is measured against ([`run_copies`]), as the reader of it sees it:
///   a document's text, not its archive (see `crate::tools::wiped`).
/// * `after` - What the write leaves there, seen the same way.
pub fn wipes(before: &[u8], after: &[u8]) -> bool {
	let (was, now) = match (std::str::from_utf8(before), std::str::from_utf8(after)) {
		(Ok(w), Ok(n))	=> (w, n),
		_		=> return before != after && !before.iter().all(|b| b.is_ascii_whitespace()),
	};
	let held = inked(was);
	if held == 0 {
		return false;
	}
	match kept_of(was, now) {
		Some(kept)	=> kept * 2 < held,
		None		=> true,
	}
}

/// How many of the characters of `s` carry content: every one but whitespace.
fn inked(s: &str) -> usize {
	s.chars().filter(|c| !c.is_whitespace()).count()
}

/// How many characters of `was`, whitespace aside, survive in `now` (see [`wipes`]), or `None`
/// where the changed middle is past what is measured.
fn kept_of(was: &str, now: &str) -> Option<usize> {
	let (w, n) = (was.as_bytes(), now.as_bytes());
	// THE COMMON ENDS, as they stand, each cut on a character boundary of both texts.
	let mut head = w.iter().zip(n.iter()).take_while(|(a, b)| a == b).count();
	while head > 0 && !(was.is_char_boundary(head) && now.is_char_boundary(head)) {
		head -= 1;
	}
	let room = w.len().min(n.len()) - head;
	let mut tail = w.iter().rev().zip(n.iter().rev()).take(room).take_while(|(a, b)| a == b)
		.count();
	while tail > 0
		&& !(was.is_char_boundary(w.len() - tail) && now.is_char_boundary(n.len() - tail))
	{
		tail -= 1;
	}
	let (lead, old, trail, new) = match (was.get(..head), was.get(head..w.len() - tail),
		was.get(w.len() - tail..), now.get(head..n.len() - tail))
	{
		(Some(a), Some(b), Some(c), Some(d))	=> (a, b, c, d),
		_					=> return None,
	};
	let mut kept = inked(lead) + inked(trail);
	if new.len() > KEPT_MEASURE_MAX {
		return None;
	}
	let k = KEPT_RUN.min(inked(was));
	// Every run of the new middle once, with how many times it holds it.
	let mut hashes: Vec<u32> = Vec::new();
	runs_in(new, k, |_, h| hashes.push(h));
	hashes.sort_unstable();
	let mut runs: Vec<(u32, u32)> = Vec::new();
	for h in hashes.into_iter() {
		match runs.last_mut() {
			Some((last, count)) if *last == h	=> *count += 1,
			_					=> runs.push((h, 1)),
		}
	}
	// The old middle's runs in order, each taking one of the new's: a character is kept once,
	// however many kept runs it lies in.
	let mut reach = 0usize;
	runs_in(old, k, |i, h| {
		if let Ok(at) = runs.binary_search_by_key(&h, |(x, _)| *x) {
			if runs[at].1 > 0 {
				runs[at].1 -= 1;
				kept += i + k - i.max(reach);
				reach = i + k;
			}
		}
	});
	Some(kept)
}

/// Call `f` with the index and the hash of every run of `k` characters of `s`, whitespace aside,
/// in order.
fn runs_in<F: FnMut(usize, u32)>(s: &str, k: usize, mut f: F) {
	if k == 0 {
		return;
	}
	let mut ring: Vec<char> = Vec::with_capacity(k);
	let mut at = 0usize;
	for c in s.chars().filter(|c| !c.is_whitespace()) {
		if ring.len() == k {
			ring.remove(0);
		}
		ring.push(c);
		at += 1;
		if ring.len() == k {
			f(at - k, run_hash(&ring));
		}
	}
}

/// FNV-1a over a run's characters, folded to 32 bits.
fn run_hash(run: &[char]) -> u32 {
	let mut h: u64 = 0xcbf2_9ce4_8422_2325;
	for c in run.iter() {
		h = (h ^ (*c as u64)).wrapping_mul(0x0000_0100_0000_01b3);
	}
	((h >> 32) ^ h) as u32
}

/// The copies a write over `path` may be measured against, newest first: what the file held before
/// each change of the unbroken run of turns' changes that led to `found`, the file as the writing
/// turn found it.  The oldest of them whose body is on this device is the file as the turns found
/// it, which [`wipes`] measures against; where there is none, `found` is.
///
/// **This is what makes a run of trims add up.**  Measured against what each write replaced, a file
/// cut to three quarters, then to three quarters of that, then to half of that again, lost nothing
/// any one write was asked about -- and ended with a quarter of itself.  Measured against the file
/// as the turns found it, the write that takes it below half is the wipe it is.
///
/// **The run ends at any change a turn did not make**, since that change is the user's: their own
/// door, a restore, a Save, a fold, a Diamond that arrived -- or a row whose content is not what
/// the row after it replaced, a change the store never saw (their editor, another program, a
/// sync).  A turn's write is never measured against a state the user has since moved the file on
/// from.  It ends at a wipe or a delete too: that copy is held already, and what it left is where
/// the next run starts -- so a document a daimon rewrites turn after turn is a wipe once each time
/// half of it has gone, not at every turn once it has drifted from where it began.
///
/// # Arguments
/// * `manifests` - Every manifest held, by version, in any order.
/// * `path` - As the manifests name it: normalised, or absolute for a machine file.
/// * `found` - The hash of the file as the writing turn found it.
pub fn run_copies(manifests: &[(u64, Manifest)], path: &str, found: &str) -> Vec<String> {
	let mut rows: Vec<(u64, Cause, &Entry)> = manifests.iter()
		.flat_map(|(n, m)| m.files.iter()
			.filter(move |e| e.path == path)
			.map(move |e| (*n, m.cause, e)))
		.collect();
	rows.sort_by(|a, b| b.0.cmp(&a.0));
	let mut out: Vec<String> = Vec::new();
	let mut at = found.to_string();
	for (_, cause, e) in rows.into_iter() {
		let led_here = cause == Cause::Turn && !e.gone && !e.wiped && e.skipped.is_none()
			&& e.hash == at;
		match &e.was {
			Some(w) if led_here && is_hash(w) && *w != at => {
				out.push(w.clone());
				at = w.clone();
			},
			_ => break,
		}
	}
	out
}


// ┌───────────────────────────────────────────────────────────────┐
// │ A generated output, made again                                 │
// └───────────────────────────────────────────────────────────────┘

/// The note a generating tool leaves once its output has landed at `path`: which tool, and the
/// hash of exactly the bytes it wrote.  Read back by [`output_note_says`].
pub fn output_note(tool: &str, path: &str, bytes: &[u8]) -> String {
	fmt!("{{\"tool\":\"{}\",\"path\":\"{}\",\"hash\":\"{}\"}}",
		json_escape(tool), json_escape(path), hash_of(bytes))
}

/// Does `note` say that `tool` itself left exactly `bytes` at `path`?
///
/// **The one exemption from keeping what a write replaces, decided by where the bytes came from
/// and never by what kind of file they are.**  `typst_compile` and `capture` make their own
/// outputs again and again -- a compile loop writes one book's PDF dozens of times -- and keeping
/// each would fill the store with what the source makes again, and ask the person about every
/// compile in the folder they opened.  Until 2026-09-23 the exemption was "a PDF over a PDF, a
/// PNG over a PNG", which let a compile or a capture replace the user's own PDF or photograph
/// with no copy and no question.  It now holds only where the bytes at the path are the very
/// bytes this tool last wrote there: a file the user put there, or has changed since by one byte,
/// is theirs, and is kept as every other write keeps it.
///
/// # Arguments
/// * `note` - The note as stored; anything that does not parse says no.
/// * `bytes` - What stands at `path` now.
pub fn output_note_says(note: &str, tool: &str, path: &str, bytes: &[u8]) -> bool {
	extract_json_string(note, "tool").as_deref() == Some(tool)
		&& extract_json_string(note, "path").as_deref() == Some(path)
		&& extract_json_string(note, "hash").map(|h| h == hash_of(bytes)).unwrap_or(false)
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

/// Which round of pruning takes this version, lowest first.
///
/// Its cause's rank ([`Cause::prune_rank`]), with two exceptions above a Save.  A version keeping a
/// copy of one of the USER'S files goes after a Save: the Diamond's own files are the daimon's
/// working state, while a copy of the user's file is the only one there is, and an edit of the
/// Diamond's own files must not evict it (re-check R4, 2026-09-23).  A version recording a
/// destruction -- a delete, or a write that left less than half ([`wipes`]) -- goes last of all.
pub fn prune_rank_of(m: &Manifest) -> u8 {
	if m.holds_destruction() {
		4
	} else if m.keeps_users_file() {
		3
	} else {
		m.cause.prune_rank()
	}
}

/// Which manifests to drop, and which bodies fall out with them.
///
/// **Manifests go by cause and then by age**, in the order [`prune_rank_of`] sets: the
/// hundreds a turn and the user's own doors make, then the discontinuities, then a version the
/// user deliberately saved, then one keeping a copy of the user's own file, and last of all one
/// recording a destruction.  **A version recording a destruction inside [`DELETE_HOLD_MS`] is not
/// a candidate at all.**
///
/// `pinned` are bodies something still to be recorded names -- a turn's copy written before its
/// delete ran, whose manifest is written at the turn's end.  They are kept, and weighed.
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
/// * `pinned` - Bodies to keep whatever the manifests say.
/// * `caps` - The ceilings in force.
/// * `now` - Wall clock, whole milliseconds, for the destruction hold.
pub fn prune_plan(
	manifests: &[(u64, Manifest)],
	held:      &[(String, u64)],
	pinned:    &[String],
	caps:      Caps,
	now:       u64,
)
	-> Prune
{
	let sizes: BTreeMap<&str, u64> = held.iter().map(|(h, n)| (h.as_str(), *n)).collect();
	let newest = manifests.iter().map(|(n, _)| *n).max().unwrap_or(0);

	// Oldest and cheapest first; the newest manifest and a deletion inside its hold are not
	// candidates at all.
	let mut order: Vec<(u8, u64)> = manifests.iter()
		.filter(|(n, m)| *n != newest && !m.held_at(now))
		.map(|(n, m)| (prune_rank_of(m), *n))
		.collect();
	order.sort();

	let mut keep: BTreeSet<u64> = manifests.iter().map(|(n, _)| *n).collect();
	let mut dropped: Vec<u64> = Vec::new();
	for (_, n) in order.into_iter() {
		if within(manifests, &keep, pinned, &sizes, caps) {
			break;
		}
		keep.remove(&n);
		dropped.push(n);
	}

	let mut live = live_hashes(manifests, &keep);
	live.extend(pinned.iter().cloned());
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
	pinned:    &[String],
	sizes:     &BTreeMap<&str, u64>,
	caps:      Caps,
)
	-> bool
{
	if keep.len() > caps.manifests {
		return false;
	}
	let mut live = live_hashes(manifests, keep);
	live.extend(pinned.iter().cloned());
	let used: u64 = live.iter()
		.map(|h| sizes.get(h.as_str()).copied().unwrap_or(0))
		.fold(0u64, |a, b| a.saturating_add(b));
	used <= caps.bytes
}

/// What the bodies named by versions inside their destruction hold weigh, of what is on disk.
///
/// The store's side of the turn's byte bound: those bodies are not prune candidates, so the room a
/// turn holding a destruction may fill is the ceiling less this.  A body a held version shares with
/// another is counted once.
///
/// # Arguments
/// * `now` - Wall clock, whole milliseconds.
pub fn retained_bytes(manifests: &[(u64, Manifest)], held: &[(String, u64)], now: u64) -> u64 {
	let keep: BTreeSet<u64> = manifests.iter()
		.filter(|(_, m)| m.held_at(now))
		.map(|(n, _)| *n)
		.collect();
	let live = live_hashes(manifests, &keep);
	held.iter()
		.filter(|(h, _)| live.contains(h))
		.map(|(_, n)| *n)
		.fold(0u64, |a, b| a.saturating_add(b))
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

	const TS: u64 = 1_757_900_000_000;			// when every test manifest was made
	const LATER: u64 = TS + 30 * 24 * 60 * 60 * 1000;	// a month on, past any hold

	fn m(cause: Cause, files: Vec<Entry>) -> Manifest {
		Manifest::new(cause, TS, "m_1", "", files)
	}

	/// A row recording `path` deleted, with `was` kept.
	fn gone(path: &str, was: &str) -> Entry {
		let mut g = e(path, "", None);
		g.gone = true;
		g.hash = String::new();
		g.bytes = 0;
		g.was = Some(hash_of(was.as_bytes()));
		g
	}

	/// **A turn deletes a handful from the user's open folder and then the PERSON is asked**
	/// (decision review of 2026-09-23, decision 2): once a turn, their answer holding for the rest
	/// of it, a stop final, and an answer to an earlier turn read by nobody.
	#[test]
	fn test_a_turns_open_folder_deletes_are_held_for_the_person_past_the_limit_00() {
		assert_eq!(8, OPEN_DELETES_ASK_DEFAULT);
		assert!(OPEN_DELETES_ASK_DEFAULT < TURN_FILES_MAX);
		let mut t = OpenTally::new(7);
		let q = t.base();
		for i in 0..8 {
			assert_eq!(OpenDelete::Go(true), t.room(&fmt!("vault/f{}.md", i), 8), "delete {}", i);
		}
		// The same path again costs nothing, before or after the limit.
		assert_eq!(OpenDelete::Go(false), t.room("vault/f3.md", 8));
		// The ninth is held, and held again until somebody answers: asking twice is one question.
		assert_eq!(OpenDelete::Ask(8, q), t.room("vault/f8.md", 8));
		assert_eq!(OpenDelete::Ask(8, q), t.room("vault/f9.md", 8));
		// An answer meant for another turn's tally moves nothing.
		t.answer(OpenTally::new(6).base(), true);
		assert_eq!(OpenDelete::Ask(8, q), t.room("vault/f8.md", 8));
		// Let go on: the rest of the turn goes, and the store's own bound is what stops it next.
		let mut go = t.clone();
		go.answer(q, true);
		assert_eq!(OpenDelete::Go(true), go.room("vault/f8.md", 8));
		assert_eq!(OpenDelete::Go(true), go.room("vault/f9.md", 8));
		// Stopped: final for the turn, whatever else is asked for, and a yes after it moves nothing.
		let mut stop = t.clone();
		stop.answer(q, false);
		assert_eq!(OpenDelete::Stopped(8), stop.room("vault/f8.md", 8));
		stop.answer(q, true);
		assert_eq!(OpenDelete::Stopped(8), stop.room("vault/f9.md", 8));
		// A delete that did not happen gives its count back.
		let mut back = OpenTally::new(1);
		assert_eq!(OpenDelete::Go(true), back.room("a", 1));
		back.release("a");
		assert_eq!(OpenDelete::Go(true), back.room("b", 1));
		assert_eq!(OpenDelete::Ask(1, back.base()), back.room("c", 1));
		// At the store's own bound it never asks: the store refuses there first.
		let mut top = OpenTally::new(4);
		for i in 0..(TURN_FILES_MAX + 3) {
			assert_eq!(OpenDelete::Go(true), top.room(&fmt!("f{}", i), TURN_FILES_MAX));
		}
	}

	/// **"Ask before every one" asks before every one** (re-check of 2026-09-23, R7).  At a limit
	/// of none the first yes let the rest of the turn delete there unasked; now each file is its
	/// own question, a yes lets that file go and no other, and a stop is final for the turn.
	#[test]
	fn test_ask_before_every_one_asks_about_every_file_00() {
		let mut t = OpenTally::new(3);
		let a = match t.room("vault/a.md", 0) {
			OpenDelete::Ask(0, k) => k,
			other => panic!("the first file must be asked about, got {:?}", other),
		};
		assert_ne!(t.base(), a, "a file's question is not the turn's");
		// Asked again while unanswered, the same file is the same question.
		assert_eq!(OpenDelete::Ask(0, a), t.room("vault/a.md", 0));
		// Another file is another question, standing beside the first.
		let b = match t.room("vault/b.md", 0) {
			OpenDelete::Ask(0, k) => k,
			other => panic!("the second file must be asked about too, got {:?}", other),
		};
		assert_ne!(a, b);
		// A yes to the first lets the first go, and only the first.
		t.answer(a, true);
		assert_eq!(OpenDelete::Ask(0, b), t.room("vault/b.md", 0), "a yes to one file is not a yes to another");
		assert_eq!(OpenDelete::Go(true), t.room("vault/a.md", 0));
		assert_eq!(OpenDelete::Go(false), t.room("vault/a.md", 0), "counted once");
		// The next file is asked about again, however many went before it.
		let c = match t.room("vault/c.md", 0) {
			OpenDelete::Ask(1, k) => k,
			other => panic!("every file is asked about, got {:?}", other),
		};
		t.answer(b, true);
		assert_eq!(OpenDelete::Go(true), t.room("vault/b.md", 0));
		// A no to any file stops the turn there, whatever was let go before.
		t.answer(c, false);
		assert_eq!(OpenDelete::Stopped(2), t.room("vault/c.md", 0));
		assert_eq!(OpenDelete::Stopped(2), t.room("vault/d.md", 0));
		// An answer to another turn's file moves nothing.
		let mut next = OpenTally::new(4);
		let d = match next.room("vault/d.md", 0) {
			OpenDelete::Ask(0, k) => k,
			other => panic!("a new turn asks afresh, got {:?}", other),
		};
		next.answer(a, true);
		next.answer(OpenTally::new(5).base() + 1, true);
		assert_eq!(OpenDelete::Ask(0, d), next.room("vault/d.md", 0));
		// And the turn's own question, at a limit above none, is still one question a turn.
		let mut some = OpenTally::new(6);
		assert_eq!(OpenDelete::Go(true), some.room("x", 1));
		let q = some.base();
		assert_eq!(OpenDelete::Ask(1, q), some.room("y", 1));
		some.answer(q, true);
		assert_eq!(OpenDelete::Go(true), some.room("y", 1));
		assert_eq!(OpenDelete::Go(true), some.room("z", 1));
	}

	/// The open-folder limit is the user's to set, back to the default, and never past the store's
	/// own per-turn bound.
	#[test]
	fn test_the_open_folder_delete_limit_is_settable_and_bounded_00() {
		set_open_deletes_ask(Some(3));
		assert_eq!(3, open_deletes_ask());
		set_open_deletes_ask(Some(0));
		assert_eq!(0, open_deletes_ask());
		set_open_deletes_ask(Some(1_000));
		assert_eq!(TURN_FILES_MAX, open_deletes_ask());
		set_open_deletes_ask(None);
		assert_eq!(OPEN_DELETES_ASK_DEFAULT, open_deletes_ask());
	}

	/// **A deleted file's copy outlives the turns after it** (audit of 2026-09-23, finding 2).
	/// Three turns each deleted a 400 KiB file and later edits pushed the first copy out, while
	/// the model was told Daimond kept one.
	#[test]
	fn test_a_deletion_is_held_through_later_turns_and_goes_last_after_its_hold_00() {
		let ms = vec![
			(1, m(Cause::Turn, vec![gone("a1", "A1")])),
			(2, m(Cause::Turn, vec![gone("a2", "A2")])),
			(3, m(Cause::Turn, vec![e("e1", "E1", Some("e0"))])),
			(4, m(Cause::Save, vec![e("s", "S", None)])),
			(5, m(Cause::Turn, vec![e("e2", "E2", Some("e1b"))])),
		];
		let held: Vec<(String, u64)> = ["A1", "A2", "E1", "e0", "S", "E2", "e1b"].iter()
			.map(|x| (hash_of(x.as_bytes()), 400u64)).collect();
		// Room for three bodies of seven: inside the hold both deletions stay, whatever else goes.
		let caps = Caps { bytes: 1_200, manifests: MANIFESTS_MAX };
		let plan = prune_plan(&ms, &held, &[], caps, TS + 1_000);
		assert!(!plan.manifests.contains(&1) && !plan.manifests.contains(&2),
			"a deletion inside its hold was pruned: {:?}", plan.manifests);
		assert!(!plan.bodies.contains(&hash_of(b"A1")), "a deleted file's copy was swept");
		assert_eq!(vec![3, 4], plan.manifests, "the ordinary versions go first, a save last of them");
		// Past the hold, a deletion is still the LAST to go: after a Save.
		let later = prune_plan(&ms, &held, &[], caps, LATER);
		assert_eq!(vec![1, 3, 4], later.manifests);
		assert!(!later.manifests.contains(&2), "the newer deletion went before it had to");
		// What the store may still take for a turn that holds a delete.
		assert_eq!(800, retained_bytes(&ms, &held, TS + 1_000));
		assert_eq!(0, retained_bytes(&ms, &held, LATER));
	}

	/// Twelve lines of a person's notes, each much the length of the others, so a trim to the first
	/// n of them keeps about n twelfths.
	const NOTES: &str = "\
Monday: the boiler engineer comes at nine.
Tuesday: send the Harbour Street invoice.
Wednesday: dentist at half past three, Ada.
Thursday: pick up the framed map from Ada.
Friday: book the train to Edinburgh early.
Saturday: plant the garlic along a fence.
Sunday: call Mum about the October visit.
Rent: the standing order moves to the 3rd.
Car: its MOT is due before the month ends.
Bins: recycling goes out on alternate days.
Library: return the Pevsner guide by 30th.
Garden: order two bags of bark for a bed.
";

	/// The first `n` lines of [`NOTES`].
	fn notes(n: usize) -> String {
		NOTES.lines().take(n).map(|l| fmt!("{}\n", l)).collect()
	}

	/// **Cutting a user's file down to its first line is a wipe** (R4, "emptying most").  The
	/// rule it replaces took a write for a wipe only where it kept no line, so a trim to the first
	/// line -- or to the "rest unchanged" a model writes in place of what it did not copy -- was an
	/// edit, and its copy could be pruned.
	#[test]
	fn test_a_trim_to_one_line_is_a_wipe_00() {
		assert!(wipes(NOTES.as_bytes(), notes(1).as_bytes()),
			"a file cut to its first line of twelve was not a wipe");
		assert!(wipes(b"# Title\nbody one\nbody two\n", b"# Title\n// rest unchanged\n"),
			"a file's body replaced by 'rest unchanged' was not a wipe");
		// And the first line padded out with somebody else's text: a size cannot see the loss.
		let pad: String = PAGE.chars().take(3 * NOTES.len()).collect();
		let padded = fmt!("{}{}", notes(1), pad);
		assert!(wipes(NOTES.as_bytes(), padded.as_bytes()),
			"a file cut to one line and padded to three times its size was not a wipe");
	}

	/// **Three trims that each leave most of what they replaced, and together leave a third of the
	/// file, are a wipe at the third** (R4: repeated trims add up).  Each write is measured
	/// against the file as the turns found it: the oldest copy of the unbroken run of turns'
	/// changes that led to it ([`run_copies`]).
	#[test]
	fn test_trims_that_together_remove_most_of_a_file_are_a_wipe_00() {
		let (r, a, b, c) = (NOTES.to_string(), notes(9), notes(7), notes(4));
		// Measured against what each replaced, none of the three loses half.
		assert!(!wipes(r.as_bytes(), a.as_bytes()) && !wipes(a.as_bytes(), b.as_bytes())
			&& !wipes(b.as_bytes(), c.as_bytes()), "a single trim of the three was already a wipe");
		// Two turns have made the first two; the third write finds the file as the second left it.
		let h = |s: &str| hash_of(s.as_bytes());
		let turn = |was: &str, now: &str| {
			let mut row = e("vault/notes.md", now, Some(was));
			row.mark = true;
			m(Cause::Turn, vec![row])
		};
		let ms = vec![(2, turn(&a, &b)), (1, turn(&r, &a))];
		let copies = run_copies(&ms, "vault/notes.md", &h(&b));
		assert_eq!(vec![h(&a), h(&r)], copies,
			"the run did not lead back to the file as the turns found it");
		// The oldest is the file as the turns found it, and against it the third trim is a wipe.
		assert!(wipes(r.as_bytes(), c.as_bytes()), "trims to a third of the file were not a wipe");
		// The first two, measured the same way, are not.
		assert!(!wipes(r.as_bytes(), b.as_bytes()),
			"a trim that leaves seven lines of twelve was a wipe");
	}

	/// **The turns' run ends at any change a turn did not make, and at a destruction.**  A write is
	/// never measured against a state the user has since moved the file on from, and a document a
	/// daimon keeps rewriting is a wipe once each time half of it has gone, not at every turn.
	#[test]
	fn test_the_turns_run_ends_where_anything_else_changed_the_file_00() {
		let h = |s: &str| hash_of(s.as_bytes());
		let row = |was: Option<&str>, now: &str| {
			let mut r = e("vault/p.md", now, was);
			r.mark = true;
			r
		};
		// Turn, turn: back to the first turn's `was`.  Rows of other paths are passed over.
		let ms = vec![
			(1, m(Cause::Turn, vec![row(Some("R"), "A"), e("vault/q.md", "Q", Some("q"))])),
			(2, m(Cause::Turn, vec![row(Some("A"), "B")])),
		];
		assert_eq!(vec![h("A"), h("R")], run_copies(&ms, "vault/p.md", &h("B")));
		// The file is not what the newest row left: changed where the store did not see it.
		assert!(run_copies(&ms, "vault/p.md", &h("B, edited in another program")).is_empty());
		// The user's own door, a restore, a Save: each is the start of a new run.
		for cause in [Cause::User, Cause::Restore, Cause::Save, Cause::Fold, Cause::Share] {
			let ms = vec![
				(1, m(Cause::Turn, vec![row(Some("R"), "A")])),
				(2, m(cause, vec![row(Some("A"), "B")])),
				(3, m(Cause::Turn, vec![row(Some("B"), "C")])),
			];
			assert_eq!(vec![h("B")], run_copies(&ms, "vault/p.md", &h("C")), "{:?}", cause);
		}
		// A row whose `was` is not what the row before it left: the user's change came between.
		let ms = vec![
			(1, m(Cause::Turn, vec![row(Some("R"), "A")])),
			(2, m(Cause::Turn, vec![row(Some("A, changed by hand"), "B")])),
		];
		assert_eq!(vec![h("A, changed by hand")], run_copies(&ms, "vault/p.md", &h("B")));
		// A wipe ends it: its copy is held, and what it left is where the next run starts.
		let mut wipe = row(Some("R"), "A");
		wipe.wiped = true;
		let ms = vec![
			(1, m(Cause::Turn, vec![wipe])),
			(2, m(Cause::Turn, vec![row(Some("A"), "B")])),
		];
		assert_eq!(vec![h("A")], run_copies(&ms, "vault/p.md", &h("B")));
		// So does a file a turn made: there was nothing before it.
		let ms = vec![
			(1, m(Cause::Turn, vec![row(None, "A")])),
			(2, m(Cause::Turn, vec![row(Some("A"), "B")])),
		];
		assert_eq!(vec![h("A")], run_copies(&ms, "vault/p.md", &h("B")));
		// And a row whose body was never kept: the store cannot say what it led from.
		let mut big = row(Some("R"), "A");
		big.skipped = Some("size".to_string());
		let ms = vec![
			(1, m(Cause::Turn, vec![big])),
			(2, m(Cause::Turn, vec![row(Some("A"), "B")])),
		];
		assert_eq!(vec![h("A")], run_copies(&ms, "vault/p.md", &h("B")));
		// No history at all: nothing older than the file as the turn found it.
		assert!(run_copies(&[], "vault/p.md", &h("B")).is_empty());
	}

	/// **An ordinary edit is not a wipe**, however many lines it touches: one word changed in a
	/// paragraph written as one line, as most editors write one, and a file re-indented.  The rule
	/// it replaces took both for wipes, since neither keeps a line as it was.
	#[test]
	fn test_an_ordinary_edit_is_not_a_wipe_00() {
		let para = "The survey found that most of the older houses on the east side of the village \
			still had their original sash windows, although many had been painted shut decades ago \
			and would need careful work before they opened again.\n";
		let edited = para.replace("careful", "patient");
		assert!(!wipes(para.as_bytes(), edited.as_bytes()),
			"a one-word edit of a paragraph on one line was a wipe");
		let tabs = "\tfn area(&self) -> f64 {\n\t\tself.w * self.h\n\t}\n\
			\tfn perimeter(&self) -> f64 {\n\t\t2.0 * (self.w + self.h)\n\t}\n";
		let spaces = tabs.replace('\t', "    ");
		assert!(!wipes(tabs.as_bytes(), spaces.as_bytes()), "a re-indent was a wipe");
		// And the edits a person makes every day.
		assert!(!wipes(NOTES.as_bytes(), NOTES.replace("nine", "ten").as_bytes()));
		assert!(!wipes(NOTES.as_bytes(), fmt!("{}Monday: gas meter reading.\n", NOTES).as_bytes()));
		assert!(!wipes(NOTES.as_bytes(), notes(9).as_bytes()), "a quarter of the file cut was a wipe");
		assert!(!wipes(b"keep me 0", b"keep me 0 and more"));
	}

	/// **A rewrite the same size that keeps what the file said is not a wipe**: the same sentences,
	/// laid out again.  The rule it replaces took it for one, since no line survives a re-wrap.
	#[test]
	fn test_a_same_size_rewrite_that_keeps_the_text_is_not_a_wipe_00() {
		let one_per_line = "The kiln was fired on Friday.\nIt held two hundred pots.\n\
			Most came out whole.\nThe glaze on the blue ones ran.\nWe will fire again in May.\n";
		let as_paragraph = one_per_line.trim_end().replace('\n', " ") + "\n";
		assert_eq!(one_per_line.len(), as_paragraph.len(), "the fixture is not the same size");
		assert!(!wipes(one_per_line.as_bytes(), as_paragraph.as_bytes()),
			"sentences joined into one paragraph were a wipe");
		// Sections put in another order keep everything.
		let turned: String = NOTES.lines().rev().map(|l| fmt!("{}\n", l)).collect();
		assert!(!wipes(NOTES.as_bytes(), turned.as_bytes()),
			"the same lines in another order were a wipe");
	}

	/// **What the rule took for a wipe before, it still does**: emptied, a byte of junk, a page of
	/// something else the same size, a scramble of the same letters, content that is not text
	/// changed -- and a row says so and reads back saying so.
	#[test]
	fn test_a_write_that_keeps_nothing_is_still_a_wipe_00() {
		assert!(wipes(b"keep me 0", b""));
		let big = "t1:0.123:".repeat(40_000);
		assert!(wipes(big.as_bytes(), b""));
		assert!(wipes(b"keep me 0", b"x"));
		assert!(wipes(b"# Chapter 3\n\nIt was a dark night.\n", b"TODO\n"));
		assert!(wipes(b"alpha beta\ngamma\n", b"ammag\nateb ahpla\n"));
		assert!(wipes(b"one\n\ntwo\n", b"\n\nsomething else\n"));
		let other: String = PAGE.chars().take(NOTES.len()).collect();
		assert!(wipes(NOTES.as_bytes(), other.as_bytes()),
			"a page of something else the same size was not a wipe");
		// Nothing to lose: an empty or blank file, written over.
		assert!(!wipes(b"", b"x"));
		assert!(!wipes(b"  \n\t\n", b"x"));
		// Content that is not text: any change replaces it, and none does not.
		assert!(wipes(&[0xff, 0x00, 1], &[0xff, 0x00, 2]));
		assert!(!wipes(&[0xff, 0x00, 1], &[0xff, 0x00, 1]));
		assert!(wipes(b"text\n", &[0xff, 0xfe]));
		assert!(wipes(&[0xff, 0xfe], b"text\n"));
		let mut w = e("vault/m0.md", "", Some("keep me 0"));
		w.wiped = true;
		w.mark = true;
		let man = m(Cause::Turn, vec![w]);
		assert!(man.holds_destruction() && man.keeps_users_file());
		match Manifest::from_json(&man.to_json()) {
			Ok(back) => assert_eq!(man, back),
			Err(e)   => panic!("a wiped row did not read back: {}", e),
		}
	}

	/// **A change too large to measure is taken for a wipe**, the side that keeps the copy: a
	/// changed middle of the new text past [`KEPT_MEASURE_MAX`] bytes is not compared, and the
	/// same change inside it is measured as it is.
	#[test]
	fn test_a_change_too_large_to_measure_is_taken_for_a_wipe_00() {
		let line = "a line of the file, one of very many\n";
		let long = line.repeat(KEPT_MEASURE_MAX / line.len() + 2);
		let dotted = fmt!("x{}", long.replace("many\n", "many.\n"));
		assert!(dotted.len() > KEPT_MEASURE_MAX);
		assert!(wipes(long.as_bytes(), dotted.as_bytes()), "a change past the bound was measured");
		let short = line.repeat(1_000);
		assert!(!wipes(short.as_bytes(), fmt!("x{}", short.replace("many\n", "many.\n")).as_bytes()),
			"a full stop on every line of a file inside the bound was a wipe");
	}

	/// **A generated output is its tool's own only where the bytes are the very ones it wrote**
	/// (re-check R4's generated-output door, 2026-09-23).  The exemption was "a PDF over a PDF",
	/// so a compile could replace the user's own PDF with no copy; the kind of file says nothing
	/// about whose it is.
	#[test]
	fn test_a_generated_output_is_its_own_only_by_the_bytes_it_wrote_00() {
		let pdf = b"%PDF-1.7\nthe book, compiled\n%%EOF\n";
		let note = output_note("typst_compile", "vault/book.pdf", pdf);
		// Made again: the very bytes this tool left at this path.
		assert!(output_note_says(&note, "typst_compile", "vault/book.pdf", pdf));
		// The user's own PDF at the same path, or this one changed by a byte, is not the tool's.
		assert!(!output_note_says(&note, "typst_compile", "vault/book.pdf",
			b"%PDF-1.4\nthe signed contract\n%%EOF\n"), "a PDF was taken for the tool's own by its kind");
		let mut touched = pdf.to_vec();
		touched[10] ^= 1;
		assert!(!output_note_says(&note, "typst_compile", "vault/book.pdf", &touched),
			"a PDF changed since the compile was taken for the compile's own");
		// Another tool's output, or another path's, vouches for nothing here.
		assert!(!output_note_says(&note, "capture", "vault/book.pdf", pdf));
		assert!(!output_note_says(&note, "typst_compile", "vault/other.pdf", pdf));
		// A note that does not parse, or is not there, says no.
		assert!(!output_note_says("", "typst_compile", "vault/book.pdf", pdf));
		assert!(!output_note_says("{\"tool\":\"typst_compile\"}", "typst_compile", "vault/book.pdf", pdf));
		// A path that needs escaping reads back as itself.
		let odd = "vault/a \"b\"\\c.png";
		assert!(output_note_says(&output_note("capture", odd, b"x"), "capture", odd, b"x"));
	}

	/// **A wiped file's copy is held through later turns, as a deleted file's is** (re-check R4).
	///
	/// Live on 2026-09-23: a turn emptied twelve files, four later 300 KiB edits followed, and
	/// `file_revert` of the first found no copy; a file emptied in one turn and deleted in the
	/// next kept only the empty file.  The manifests are read from their stored JSON, which is
	/// where a build decides what a row is.
	#[test]
	fn test_a_wiped_file_is_held_through_later_turns_as_a_deletion_is_00() {
		let h = |s: &str| hash_of(s.as_bytes());
		let row = |path: &str, now: &str, was: &str, extra: &str| fmt!(
			r#"{{"path":"{}","hash":"{}","bytes":{},"was":"{}","mark":true{}}}"#,
			path, h(now), now.len(), h(was), extra);
		let man = |ts: u64, rows: Vec<String>| -> Manifest {
			let json = fmt!(r#"{{"v":1,"ts":{},"cause":"turn","turn":"m","note":"","files":[{}]}}"#,
				ts, rows.join(","));
			match Manifest::from_json(&json) {
				Ok(m)  => m,
				Err(e) => panic!("{}", e),
			}
		};
		// Turn 1 empties a user's file; turns 2 to 4 edit other files of theirs, 400 bytes each.
		let ms = vec![
			(1, man(TS, vec![row("vault/t1.bin", "", "T1 as it was", r#","wiped":true"#)])),
			(2, man(TS, vec![row("vault/e1.bin", "E1 new", "E1 old", "")])),
			(3, man(TS, vec![row("vault/e2.bin", "E2 new", "E2 old", "")])),
			(4, man(TS, vec![row("vault/e3.bin", "E3 new", "E3 old", "")])),
		];
		let held: Vec<(String, u64)> = ["", "T1 as it was", "E1 new", "E1 old", "E2 new",
			"E2 old", "E3 new", "E3 old"].iter().map(|x| (h(x), 400u64)).collect();
		// Room for three bodies of eight: the edits must make room among themselves.
		let caps = Caps { bytes: 1_200, manifests: MANIFESTS_MAX };
		let plan = prune_plan(&ms, &held, &[], caps, TS + 1_000);
		assert!(!plan.manifests.contains(&1),
			"the version that emptied a user's file was pruned inside its hold: {:?}", plan.manifests);
		assert!(!plan.bodies.contains(&h("T1 as it was")),
			"what the file held before it was emptied was swept");
		// It is weighed as a held destruction, so a turn holding one is bounded by what is left.
		assert!(retained_bytes(&ms, &held, TS + 1_000) >= 400,
			"a wiped file's copy was not counted against the room a destruction may take");
		// And the row says what it is after a round trip, rather than being read back as an edit.
		assert!(ms[0].1.to_json().contains(r#""wiped":true"#),
			"the store forgot that the file was wiped: {}", ms[0].1.to_json());
		// Past the hold it is still the last to go: with room for two versions besides the newest,
		// the two edits go and the wipe stays.
		let roomier = Caps { bytes: 2_000, manifests: MANIFESTS_MAX };
		let later = prune_plan(&ms, &held, &[], roomier, LATER);
		assert_eq!(vec![2, 3], later.manifests,
			"a wiped file's version went before the edits after its hold");
	}

	/// **A copy of the user's own file goes after a Save** (re-check R4): the Diamond's own
	/// files are the daimon's working state, and a copy of the user's is the only one there is.
	#[test]
	fn test_a_copy_of_the_users_file_goes_after_a_save_00() {
		let h = |s: &str| hash_of(s.as_bytes());
		let json = |cause: &str, path: &str, mark: bool| fmt!(
			r#"{{"v":1,"ts":{},"cause":"{}","turn":"","note":"","files":[{{"path":"{}","hash":"{}","bytes":4,"was":"{}"{}}}]}}"#,
			TS, cause, path, h(path), h(&fmt!("{} before", path)),
			if mark { r#","mark":true"# } else { "" });
		let parse = |j: String| match Manifest::from_json(&j) {
			Ok(m)  => m,
			Err(e) => panic!("{}", e),
		};
		let ms = vec![
			(1, parse(json("turn", "vault/chapter.md", true))),        // the user's file
			(2, parse(json("save", "diamonds/d1/notes.md", false))),   // a Save of the Diamond
			(3, parse(json("turn", "diamonds/d1/STATE.md", false))),   // the Diamond's own state
			(4, parse(json("turn", "diamonds/d1/newest.md", false))),  // the newest, never pruned
		];
		let held: Vec<(String, u64)> = ms.iter()
			.flat_map(|(_, m)| m.hashes())
			.map(|x| (x, 100u64))
			.collect();
		// Room for the newest and one other version's pair of bodies.
		let plan = prune_plan(&ms, &held, &[], Caps { bytes: 400, manifests: MANIFESTS_MAX }, LATER);
		assert_eq!(vec![2, 3], plan.manifests,
			"a copy of the user's file went before a Save or the Diamond's own state");
	}

	/// A body a turn wrote before its delete ran is named by no manifest until the turn ends, and
	/// the sweep keeps it.
	#[test]
	fn test_a_pinned_body_is_kept_and_weighed_00() {
		let ms = vec![(1, m(Cause::Turn, vec![e("a", "one", None)]))];
		let held = vec![(hash_of(b"one"), 3u64), (hash_of(b"pending"), 3u64)];
		let pin = vec![hash_of(b"pending")];
		let plan = prune_plan(&ms, &held, &pin, Caps { bytes: 100, manifests: MANIFESTS_MAX }, LATER);
		assert!(plan.bodies.is_empty(), "a pending copy was swept: {:?}", plan.bodies);
		let bare = prune_plan(&ms, &held, &[], Caps { bytes: 100, manifests: MANIFESTS_MAX }, LATER);
		assert_eq!(vec![hash_of(b"pending")], bare.bodies);
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
		let plan = prune_plan(&ms, &held, &[], Caps { bytes: 3_000, manifests: MANIFESTS_MAX }, LATER);
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
		let plan = prune_plan(&ms, &held, &[], Caps { bytes: u64::MAX, manifests: 3 }, LATER);
		assert_eq!(vec![1, 2], plan.manifests);
	}

	#[test]
	fn test_a_store_of_one_oversized_manifest_is_left_at_one_rather_than_emptied() {
		let ms = vec![(7, m(Cause::Turn, vec![e("a", "big", None)]))];
		let held = vec![(hash_of(b"big"), 9_000_000u64)];
		let plan = prune_plan(&ms, &held, &[], Caps { bytes: 1, manifests: 1 }, LATER);
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
		let plan = prune_plan(&ms, &held, &[], Caps { bytes: 4, manifests: MANIFESTS_MAX }, LATER);
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

	// ── Two devices' numbers (re-check of 2026-09-23, R5) ───────────────

	/// The store as it stands after `plan` is carried out and the import laid down over it: the
	/// moves written, the drops removed, then every one of the import's manifests by its number.
	fn after_import(mine: &[(u64, String)], theirs: &[(u64, String)], plan: &Rebase)
		-> BTreeMap<u64, String>
	{
		let mut out: BTreeMap<u64, String> = mine.iter().cloned().collect();
		for (from, to) in plan.moves.iter() {
			let body = out.get(from).cloned().expect("a move names a manifest this device holds");
			assert!(!out.contains_key(to), "a move must land on a free number, not {}", to);
			out.insert(*to, body);
		}
		for n in plan.drops.iter() {
			out.remove(n);
		}
		for (n, h) in theirs.iter() {
			out.insert(*n, h.clone());
		}
		out
	}

	/// Every record either side held is in `out`, and none of them twice.
	fn holds_each_once(out: &BTreeMap<u64, String>, mine: &[(u64, String)], theirs: &[(u64, String)]) {
		let mut all: BTreeSet<&str> = mine.iter().map(|(_, h)| h.as_str()).collect();
		all.extend(theirs.iter().map(|(_, h)| h.as_str()));
		for h in all.iter() {
			let n = out.values().filter(|v| v.as_str() == *h).count();
			assert_eq!(1, n, "record {} is held {} times in {:?}", h, n, out);
		}
		assert_eq!(all.len(), out.len(), "nothing else is held: {:?}", out);
	}

	fn recs(v: &[(u64, &str)]) -> Vec<(u64, String)> {
		v.iter().map(|(n, h)| (*n, h.to_string())).collect()
	}

	#[test]
	fn test_a_number_already_on_disk_is_never_minted_again_00() {
		let names = ["0001.json", "0005.files.json", "b", "0004.jpatch", "pending", "0003.html"];
		assert_eq!(6, next_version(3, names.iter().copied()), "past the manifest above the counter");
		assert_eq!(10, next_version(9, names.iter().copied()), "the counter where it is higher");
		assert_eq!(1, next_version(0, std::iter::empty()));
		assert_eq!(Some(12), version_prefix("0012.files.json"));
		assert_eq!(None, version_prefix("b"));
		assert_eq!(None, version_prefix("12a.json"));
	}

	/// The re-check's own case: a delete recorded here as version 1, and another device's turn
	/// arriving as its own version 1.
	#[test]
	fn test_an_import_never_writes_over_a_manifest_this_device_made_00() {
		let mine   = recs(&[(1, "delete-here")]);
		let theirs = recs(&[(1, "turn-there")]);
		let plan = rebase_plan(&mine, &theirs, 1);
		assert_eq!(vec![(1, 2)], plan.moves, "refiled above both histories");
		assert!(plan.drops.is_empty(), "number 1 is the import's to fill");
		let out = after_import(&mine, &theirs, &plan);
		holds_each_once(&out, &mine, &theirs);
		assert_eq!(Some(&fmt!("turn-there")), out.get(&1), "the import's numbers are its own");
		assert_eq!(Some(&fmt!("delete-here")), out.get(&2));
	}

	#[test]
	fn test_what_this_device_made_since_the_fork_keeps_its_order_above_the_import_00() {
		// 1 and 2 are shared; 3 and 4 were made here, 3 and 5 there.
		let mine   = recs(&[(1, "s1"), (2, "s2"), (3, "mine3"), (4, "mine4")]);
		let theirs = recs(&[(1, "s1"), (2, "s2"), (3, "their3"), (5, "their5")]);
		let plan = rebase_plan(&mine, &theirs, 5);
		assert_eq!(vec![(3, 6), (4, 7)], plan.moves, "in order, from the first collision on");
		assert_eq!(vec![4], plan.drops, "4 is vacated and the import does not fill it");
		let out = after_import(&mine, &theirs, &plan);
		holds_each_once(&out, &mine, &theirs);
		// Made here before the first collision and not written over: left where it is.
		let mine   = recs(&[(1, "s1"), (2, "early-here"), (3, "mine3")]);
		let theirs = recs(&[(1, "s1"), (3, "their3")]);
		let plan = rebase_plan(&mine, &theirs, 3);
		assert_eq!(vec![(3, 4)], plan.moves);
		holds_each_once(&after_import(&mine, &theirs, &plan), &mine, &theirs);
	}

	#[test]
	fn test_nothing_moves_where_nothing_would_be_written_over_00() {
		// The same history, and a history the import only extends.
		let same = recs(&[(1, "a"), (2, "b")]);
		assert!(rebase_plan(&same, &same, 2).is_empty());
		let theirs = recs(&[(1, "a"), (2, "b"), (3, "c")]);
		assert!(rebase_plan(&same, &theirs, 3).is_empty());
		// Made here above everything the import holds: it collides with nothing, and the counter
		// never mints its number again (`next_version`).
		let mine = recs(&[(1, "a"), (4, "late-here")]);
		assert!(rebase_plan(&mine, &theirs, 4).is_empty());
		holds_each_once(&after_import(&mine, &theirs, &Rebase::default()), &mine, &theirs);
	}

	/// Syncs going both ways, and through a third device, converge on one copy of each record.
	#[test]
	fn test_devices_that_sync_both_ways_hold_every_record_once_00() {
		// A and B share X at 5. A meets C's Q at 5 first, and refiles X.
		let a0 = recs(&[(5, "X")]);
		let c  = recs(&[(5, "Q")]);
		let plan = rebase_plan(&a0, &c, 5);
		let a1: Vec<(u64, String)> = after_import(&a0, &c, &plan).into_iter().collect();
		assert_eq!(recs(&[(5, "Q"), (6, "X")]), a1);
		// B, still holding X at 5, takes A's copy: X arrives at 6, and B's own 5 is written by Q.
		let b0 = recs(&[(5, "X")]);
		let plan = rebase_plan(&b0, &a1, 6);
		assert!(plan.moves.is_empty(), "X is carried, so it is not refiled");
		let b1: Vec<(u64, String)> = after_import(&b0, &a1, &plan).into_iter().collect();
		assert_eq!(a1, b1, "converged");
		// The other order: A, having refiled X, takes B's copy that still has X at 5.
		let plan = rebase_plan(&a1, &b0, 6);
		let a2 = after_import(&a1, &b0, &plan);
		holds_each_once(&a2, &a1, &b0);
		// And one device holding a record twice, as a failed import can leave it, keeps it once.
		let twice  = recs(&[(5, "X"), (7, "X")]);
		let theirs = recs(&[(5, "Y")]);
		let plan = rebase_plan(&twice, &theirs, 7);
		assert_eq!(vec![7], plan.drops);
		holds_each_once(&after_import(&twice, &theirs, &plan), &twice, &theirs);
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
