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

use crate::llm::{extract_json_bool, extract_json_number, extract_json_string,
	extract_json_string_array, json_escape};
use crate::rating::Author;

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
///
/// 2 (11 Oct 2026, D-26 review A F1-F3): a row a person's door wrote says so (`door`), so a
/// manifest of 2 or above is read for page data by its rows ([`page_paths`]); one of 1 by its
/// cause, the only evidence it had.
pub const MANIFEST_V: u64 = 2;

/// The first [`MANIFEST_V`] whose rows carry `door`.
pub const DOOR_V: u64 = 2;

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

/// The most entries one manifest carries, and the most copies one turn keeps ([`claim_room`]).
///
/// A turn that wrote more records [`TURN_FILES_MAX`] rows, those holding copies first
/// ([`cut_order`]), and says how many it did not, rather than growing a manifest without limit on
/// the one turn that ran a build.
pub const TURN_FILES_MAX: usize = 64;

/// The most runs one turn may seal as versions of their own ([`seal_broken`]) before an act that
/// would seal another is refused.
///
/// **Each seal is one of the Diamond's [`MANIFESTS_MAX`] versions** (R2-4 of the Q5-1 fix's QA,
/// 2026-09-24).  An editor autosaving a file the daimon keeps editing seals a run at every act, and
/// the history older than the turn that is not held as a destruction is pruned that much sooner.  A
/// person saving between a turn's acts is worth a version each time; a file that has changed under
/// the turn this many times is being written by something else, and the turn is told to stop and
/// ask rather than spend a twelfth of the history on it.
pub const TURN_SEALS_MAX: usize = 16;

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
/// writes there that leave less than half of a file ([`wipes`]): one count, keyed by FILE
/// ([`open_file_key`]), so a file emptied and then deleted is one file -- and a user's file moved
/// onto a path the turn has already deleted a file from is another, asked about in its own right
/// (Q5-1, 2026-09-24: keyed by path, the person's yes to deleting the turn's own one-byte file
/// there let the user's file be emptied unasked).
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

	/// May `path` -- a file, as [`open_file_key`] names it -- be deleted now, `limit` being how
	/// many a turn may delete before asking?  An answer of [`OpenDelete::Go`] counts it; a file
	/// already counted costs nothing more.
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

/// The file a turn's delete or wipe destroys, as the open folder's tally counts it: its path, and
/// the file as the turns found it there -- the copy the destruction keeps.  A file wiped and then
/// deleted is the one file, since both keep the same copy; bytes that came to the path from
/// anywhere else are another.
pub fn open_file_key(path: &str, copy: &[u8]) -> String {
	fmt!("{}\n{}", path, hash_of(copy))
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
	pub folder:  Option<String>,	// which folder a workspace-relative path was in: see `needs_folder`
	pub by:      Option<Author>,	// the agent that wrote it; None for the user's door or a walk
	pub door:    bool,		// a person's door wrote it (the dirty set), not a walk: see `page_paths`
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
			folder:  None,
			by:      None,
			door:    false,
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
		// Written only where a folder holds the path: a build that has never heard of it reads the
		// row as one from before folders were recorded, which is what it was to that build.
		if let Some(f) = &self.folder {
			out.push_str(&fmt!(",\"folder\":\"{}\"", json_escape(f)));
		}
		// Last and nested, so an older build reads the row it always read: its flat extractors
		// find `path` and `hash` first, and none of the author's keys is one of an entry's.
		if let Some(by) = &self.by {
			out.push_str(&fmt!(",\"by\":{}", by.to_json()));
		}
		// Written only when true: a build that has never heard of it reads the row it always read.
		if self.door {
			out.push_str(",\"door\":true");
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
			folder:  extract_json_string(s, "folder").filter(|f| !f.is_empty()),
			by:      object_inside(s, "by").and_then(Author::from_json),
			door:    extract_json_bool(s, "door").unwrap_or(false),
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

	/// Does this version hold the user's own work: a copy of a file of theirs, or data a page
	/// keeps in its Diamond ([`is_page_data`])?
	///
	/// Decided by the PATH, never by the stored `mark`: rows written before the path decided whose
	/// a file is often carry no `mark` for a file in the user's folder (history_prune_diag,
	/// 10 Oct 2026), and a flag that was wrong when written stays wrong on disk.
	///
	/// `page` is the store's page data, [`page_paths`].
	pub fn keeps_users_work(&self, home: &str, page: &BTreeSet<String>) -> bool {
		self.files.iter().any(|e|
			(e.was.is_some() && is_users_path(home, &e.path)) || page.contains(&e.path))
	}

	/// Set every row's `mark` from its path, as [`is_users_path`] decides it for the keeper whose
	/// home is `home`.
	///
	/// The read-side half of the rule `stored_is_mark` applies on write, so a row an older build
	/// recorded unmarked is restored through the fence like any other file of the user's.
	pub fn settle_marks(&mut self, home: &str) {
		for e in self.files.iter_mut() {
			e.mark = is_users_path(home, &e.path);
		}
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

/// A turn's rows in the order [`truncate`] keeps them, where there are more than it keeps: every
/// row whose `was` is a copy this record took before any other, destructions first.
///
/// **A row the cut leaves out is a change with no way back only where it held a copy** (QF1 of the
/// Q5-1 fix's QA, 2026-09-24).  The copies a turn takes are bounded at [`TURN_FILES_MAX`]
/// ([`claim_room`]); the files it makes are not, since a made file keeps nothing, so their rows are
/// the ones to go -- its bytes still stand where the turn left them.  Stable, and the rows are left
/// as they came where nothing is cut.
///
/// # Arguments
/// * `rows` - Each row, and whether its `was` names a copy this record keeps.
pub fn cut_order(rows: Vec<(Entry, bool)>) -> Vec<Entry> {
	ranked(rows).into_iter().map(|(e, _)| e).collect()
}

/// The rows in [`cut_order`], each still carrying whether it holds a copy.
fn ranked(mut rows: Vec<(Entry, bool)>) -> Vec<(Entry, bool)> {
	if rows.len() > TURN_FILES_MAX {
		rows.sort_by_key(|(e, kept)| match (*kept, e.gone || e.wiped) {
			(true, true)	=> 0u8,
			(true, false)	=> 1,
			(false, true)	=> 2,
			(false, false)	=> 3,
		});
	}
	rows
}

/// A turn's rows as the versions that record them, first to last, and how many rows were cut.
///
/// The first version holds [`TURN_FILES_MAX`] rows in [`cut_order`].  **A row past it that holds a
/// copy this record keeps goes into a further version, [`TURN_FILES_MAX`] at a time, and is never
/// cut** (R2-3 of the Q5-1 fix's QA, 2026-09-24).  The copies a turn takes are bounded by
/// [`claim_room`], but the notes a turn end adopts from an earlier life of the page are bounded by
/// nothing: 64 adopted copies and one new one made 65 copy rows, and the cut dropped an original.
/// Only a row of a file the turn made is cut, and counted -- its bytes still stand where the turn
/// left them.  There is always a first version, empty where there are no rows.
///
/// # Arguments
/// * `rows` - Each row, and whether its `was` names a copy this record keeps.
pub fn split_rows(rows: Vec<(Entry, bool)>) -> (Vec<Vec<Entry>>, usize) {
	let mut groups: Vec<Vec<Entry>> = vec![Vec::new()];
	let mut cut = 0usize;
	for (i, (e, copy)) in ranked(rows).into_iter().enumerate() {
		if i < TURN_FILES_MAX {
			groups[0].push(e);
			continue;
		}
		if !copy {
			cut += 1;
			continue;
		}
		let fits = match groups.last() {
			Some(g) => groups.len() > 1 && g.len() < TURN_FILES_MAX,
			None    => false,
		};
		if !fits {
			groups.push(Vec::new());
		}
		if let Some(g) = groups.last_mut() {
			g.push(e);
		}
	}
	(groups, cut)
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
// │ What a turn captured                                           │
// └───────────────────────────────────────────────────────────────┘
//
// "THIS TURN MADE IT" IS A FACT ABOUT BYTES, NOT ABOUT A PATH (Q5-1, 2026-09-24).  A turn's capture
// of a path said what the turn left there, and the write guard took it for the truth about
// whatever stood at that path afterwards.  So a file the turn wrote and then moved away left its
// "made here" behind; a user's file moved onto the path took it on; and emptying that file was
// measured against nothing -- no question, no count, and its copy held as an ordinary edit.  Four
// model calls, no person, and the user's file was gone from their folder.
//
// Three rules close it, each at the one place it is decided.  A capture speaks for a path only
// while exactly the bytes it left are there ([`this_turn_found`], [`capture_into`]).  A move
// records both of its ends ([`moved`]).  And bytes a move carries keep their own history
// ([`Carried`]): what they are measured against travels with them, while the path they land on
// keeps what it held when the turn came to it.
//
// A fourth follows from the first (QF2 of the fix's QA, 2026-09-24).  Bytes from outside the turn
// arriving between two of its acts END the run its capture records, and the run so far becomes a
// version of its own before the next act, which starts the path's run again ([`seal_broken`]).  A
// manifest holds one row a path, and a run the turn had already begun holds a copy the next act
// must not drop -- nor may it drop its own.
//
// Here rather than beside the callers in `crate::wasm::diamond`, which only a wasm build compiles,
// so the rules are tested natively.

/// What a path holds now, as the caller found it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Body {
	Held(Vec<u8>),		// the bytes, read whole
	TooLarge(u64),		// it is there, it is this long, and it was not read
	Unseen,			// it changed and the app never saw what it became
	Gone,			// there is nothing at the path
}

/// What an act found at the path it changed, which [`capture_into`] compares with what the turn's
/// capture says it left there.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Found {
	Nothing,		// no file stood there
	Hash(String),		// the hash of the bytes that stood there
	Unread,			// a file stood there and its bytes were not read
}

impl Found {

	/// What an act that read `bytes` found: nothing, where there was no file.
	pub fn of(bytes: Option<&[u8]>) -> Self {
		match bytes {
			Some(b)	=> Self::Hash(hash_of(b)),
			None	=> Self::Nothing,
		}
	}
}

/// Where the bytes a move left at a path came from: what a write over them is measured against,
/// and what a destruction of them keeps.  The path itself keeps its own `before`, which is what a
/// restore of it puts back.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Carried {
	Made,			// this turn made them, wherever it did
	Kept(Vec<u8>),		// the file as the turns found it where the move took it from
	Unread,			// the move could not read them: they are measured as they stand
}

/// One path as a caller found it, before anything has been decided about it.
///
/// `before` is filled in only where the caller CAPTURED the prior bytes itself: a file tool, the
/// moment before its act.  Everywhere else it is `None` and `crate::wasm::diamond::versions_record`
/// answers "what stood there" from the history instead, which costs no read at all.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Change {
	pub path:    String,		// workspace-relative, or absolute where `mark`
	pub after:   Body,
	pub before:  Option<Vec<u8>>,	// the prior bytes, where the caller captured them
	pub found:   Found,		// what the act found at `path`, which the merge compares
	pub carried: Option<Carried>,	// where a move brought `after` from
	pub mark:    bool,		// a file on this computer, under a folder the user marked in
	pub refused: Option<String>,	// why the prior bytes could not be read, in the hand's words
	pub wiped:   bool,		// a write in this turn left under half: see `wipes`
	pub folder:  Option<String>,	// the folder it was made in, where known at the act: see `needs_folder`
	pub by:      Option<Author>,	// the agent whose act left `after`, from its `ToolContext`
	pub door:    bool,		// read off the dirty set: a person's door wrote it
}

impl Change {

	/// A path the caller has just read off the disk.
	pub fn of(path: &str, body: Vec<u8>) -> Self {
		Self { path: path.to_string(), after: Body::Held(body), before: None,
			found: Found::Unread, carried: None, mark: false, refused: None, wiped: false,
			folder: None, by: None, door: false }
	}

	/// A path that is no longer there.
	pub fn gone(path: &str) -> Self {
		Self { path: path.to_string(), after: Body::Gone, before: None,
			found: Found::Unread, carried: None, mark: false, refused: None, wiped: false,
			folder: None, by: None, door: false }
	}
}

/// Did the turn leave exactly what an act `found` at a path, where the turn's capture of the path
/// says it left `after`?  `None` where either side was never read, so it cannot be told.
pub fn left_there(after: &Body, found: &Found) -> Option<bool> {
	match (after, found) {
		(_, Found::Unread)				=> None,
		(Body::Held(b), Found::Hash(h))			=> Some(hash_of(b) == *h),
		(Body::Held(_), Found::Nothing)			=> Some(false),
		(Body::Gone, Found::Nothing)			=> Some(true),
		(Body::Gone, Found::Hash(_))			=> Some(false),
		(Body::TooLarge(_), _) | (Body::Unseen, _)	=> None,
	}
}

/// The file at a path as THIS turn found it, from its captures: what [`run_copies`] starts from.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TurnFound {
	Made,			// the turn made what stands there, so nothing of anyone else's is in it
	Carried(Vec<u8>),	// a move brought it here, and this is the file as the turns found it there
	Was(Vec<u8>),		// what the turn found at this path: where its run of turns' changes begins
}

/// What the file at `path` was when this turn came to it, as the turn's own captures `held` say
/// -- **and they say it only while the bytes at the path are the ones the turn left there.**  A
/// path holding anything else (a file moved onto it, a copy the hand made, the user's own editor,
/// a sync) is measured as it stands, `now`, and never as the turn's own.
///
/// A capture that was never read back -- an edit on the machine whose result the app did not see
/// -- is trusted for a first the turn found, which is a real copy, and never for "made here".
///
/// # Arguments
/// * `held` - The turn's captures, `(the path the model wrote, the capture)`.
/// * `path` - As the captures name it: normalised, or absolute for a machine file.
/// * `now` - The bytes at `path` as the act found them.
pub fn this_turn_found(held: &[(String, Change)], path: &str, now: &[u8]) -> TurnFound {
	let h = match held.iter().find(|(_, h)| h.path == path) {
		Some((_, h))	=> h,
		None		=> return TurnFound::Was(now.to_vec()),
	};
	// `left_there`'s rule, on the bytes themselves rather than on two hashes of them.
	let theirs = match &h.after {
		Body::Held(b)	=> Some(b.as_slice() == now),
		Body::Gone	=> Some(false),
		_		=> None,
	};
	match (theirs, &h.carried, &h.before) {
		(Some(true), Some(Carried::Made), _)		=> TurnFound::Made,
		(Some(true), None, None)			=> TurnFound::Made,
		(Some(true), None, Some(first))			=> TurnFound::Was(first.clone()),
		(Some(true), Some(Carried::Kept(k)), _)
			| (None, Some(Carried::Kept(k)), _)	=> TurnFound::Carried(k.clone()),
		(None, None, Some(first))			=> TurnFound::Was(first.clone()),
		_						=> TurnFound::Was(now.to_vec()),
	}
}

/// Fold one capture into what a turn holds, one entry a path.
///
/// A turn that changed one file six times records the bytes it STARTED with and the bytes it
/// ENDED with and nothing between: the newest content wins, and the prior bytes stay those of the
/// first capture, because that is the state the row has to go back to -- which is also why a file
/// wiped and then deleted in one turn keeps what stood before the wipe, not the empty file.  A
/// wipe anywhere in the turn marks the row, whatever the turn wrote after it.
///
/// Three exceptions, and each is the same question -- which bytes does the row's first copy
/// describe?
///
/// * **The turn's first destruction of a path brings its own prior bytes**: the file as the turns
///   found it, the copy a wipe was measured against and a delete keeps -- never newer than what
///   this turn first captured, and older where earlier turns had already cut it down.
/// * **"Made here" lasts only while the run is unbroken** (Q5-1).  Where what the act `found` is
///   not what the entry says the turn left there, something else put those bytes at the path.  An
///   act that read bytes there has already had the run it ended sealed as a version of its own
///   ([`seal_broken`]), so what still reaches here broken is a path the act found empty, and it
///   brings no copy: an entry that says the turn made the path is replaced, and one holding a first
///   copy keeps it.  What the entry said of the bytes it left goes.
/// * **Bytes a move carried in keep their own history** ([`Carried`]), and the path keeps its
///   first: a restore of it puts back what it held when the turn came, while a write over the
///   bytes is measured against where they came from.
pub fn capture_into(held: &mut Vec<(String, Change)>, raw: &str, change: Change) {
	let at = match held.iter().position(|(_, h)| h.path == change.path) {
		Some(at)	=> at,
		None		=> {
			held.push((raw.to_string(), change));
			return;
		},
	};
	let destroys = |c: &Change| c.wiped || matches!(c.after, Body::Gone);
	let h = &held[at].1;
	// A MOVE'S DESTINATION is new bytes by construction, so it never breaks the path's run.  Where
	// the act could not read what it found, a first the turn found stands and "made here" does not.
	let unbroken = change.carried.is_some() || match left_there(&h.after, &change.found) {
		Some(t)	=> t,
		None	=> h.before.is_some(),
	};
	let first_destruction = unbroken && change.carried.is_none() && h.carried.is_none()
		&& destroys(&change) && !destroys(h) && h.before.is_some() && change.before.is_some();
	if (!unbroken && h.before.is_none()) || first_destruction {
		held[at] = (raw.to_string(), change);
		return;
	}
	let Change { path, after, found, carried, mark, wiped, folder, by, .. } = change;
	let slot = &mut held[at];
	let carried = match (carried, &after) {
		(Some(c), _)			=> Some(c),
		(None, Body::Gone)		=> None,	// nothing stands there to have come from anywhere
		(None, _) if !unbroken		=> None,	// what the entry said came here is not there
		(None, _)			=> slot.1.carried.take(),
	};
	slot.0 = raw.to_string();
	slot.1 = Change {
		path,
		after,
		before:  slot.1.before.take(),
		found,
		carried,
		mark,
		refused: slot.1.refused.take(),
		wiped:   slot.1.wiped || wiped,
		folder:  slot.1.folder.take().or(folder),
		// The row is a product of whoever left the bytes that stand, so the latest act names it.
		by,
		door:    false,
	};
}

/// Does the path still hold what the turn left there, `after`, where the turn end found `now`?
/// Only a difference that can be seen says no: where either side was never read whole, it cannot
/// be told, and the capture is recorded as it stands.
///
/// **A turn end records its captures as the newest rows** (release 5.1's restore follow-ups,
/// 2026-09-25), and a write from outside the turn after its last act -- a Restore in another tab,
/// which cannot end this page's run, or the person's own editor -- left the History naming the
/// turn's bytes over what was on disk, and the turn's Undo putting its first bytes back over them.
/// A capture this says no to is sealed as a version of its own, and what stands is recorded after
/// it.
pub fn stands_as_left(after: &Body, now: &Body) -> bool {
	match (after, now) {
		(Body::Held(a), Body::Held(b))		=> a == b,
		(Body::Held(a), Body::TooLarge(n))	=> a.len() as u64 == *n,
		(Body::Held(_), Body::Gone)		=> false,
		(Body::Gone, Body::Gone)		=> true,
		(Body::Gone, Body::Held(_))
			| (Body::Gone, Body::TooLarge(_))	=> false,
		_					=> true,
	}
}

/// Does an act that `found` those bytes at the path end the run of this turn's changes that `h`
/// describes?  Where it read bytes the turn did not leave there, something outside the turn -- the
/// user's editor, a sync, a hand's shell -- changed the file between two of the turn's acts.  A path
/// found empty, and bytes never read, end no run a copy is owed for: such an act brings none.
pub fn run_broken(h: &Change, found: &Found) -> bool {
	matches!(found, Found::Hash(_)) && left_there(&h.after, found) == Some(false)
}

/// Take out of `held` the run of this turn's changes to `path` that an act finding `now` there has
/// ended ([`run_broken`]), for the caller to record as a version of its own, and start the path's
/// run again from `now`.  `None` where the run goes on, or the turn holds none on `path`.
///
/// **One row a path, and two copies to keep** (QF2 of the Q5-1 fix's QA, 2026-09-24).  A turn
/// edited the user's `e.md`, the user's editor saved over it, and the turn wrote its first text
/// back: a wipe, so the person was asked, and the question said a copy is kept.  The entry kept the
/// copy of what the turn first found and dropped the one the question promised; the run's net
/// change was then nothing, and the turn ended with no row at all.  Dropping the other copy loses
/// as much -- it is what the file was when the turn came.  A manifest holds one row a path, so the
/// run so far is its own version, sealed BEFORE the act, and the act's capture folds into a run
/// that starts at what it found: each copy has its row, and the notes of copies on disk
/// ([`crate::wasm::diamond::pend`]) never have to name two for one path.
///
/// The run begins again as the bytes the act found, before and after alike, so an act that never
/// lands leaves it recording no change.
pub fn seal_broken(held: &mut Vec<(String, Change)>, path: &str, now: &[u8])
	-> Option<(String, Change)>
{
	let found = Found::of(Some(now));
	let at = match held.iter().position(|(_, h)| h.path == path && run_broken(h, &found)) {
		Some(at)	=> at,
		None		=> return None,
	};
	let again = restarted(path, now, held[at].1.mark, held[at].1.folder.clone());
	let raw = held[at].0.clone();
	let run = std::mem::replace(&mut held[at].1, again);
	Some((raw, run))
}

/// Would an act finding `now` at `path` seal a run of the turn's ([`seal_broken`])?  Asked of the
/// captures alone, before the act, so a turn past [`TURN_SEALS_MAX`] is refused rather than seal.
pub fn seal_due(held: &[(String, Change)], path: &str, now: &[u8]) -> bool {
	let found = Found::of(Some(now));
	held.iter().any(|(_, h)| h.path == path && run_broken(h, &found))
}

/// Put back a run [`seal_broken`] took out whose version could not be recorded, where the path's
/// entry is still the run it began again and nothing has folded into it since.
pub fn unseal(held: &mut Vec<(String, Change)>, sealed: (String, Change), now: &[u8]) {
	let again = restarted(&sealed.1.path, now, sealed.1.mark, sealed.1.folder.clone());
	if let Some(slot) = held.iter_mut().find(|(_, h)| h.path == sealed.1.path) {
		if slot.1 == again {
			*slot = sealed;
		}
	}
}

/// The run of `path` begun again at `now`, as [`seal_broken`] leaves it.
fn restarted(path: &str, now: &[u8], mark: bool, folder: Option<String>) -> Change {
	Change {
		path:    path.to_string(),
		after:   Body::Held(now.to_vec()),
		before:  Some(now.to_vec()),
		found:   Found::of(Some(now)),
		carried: None,
		mark,
		refused: None,
		wiped:   false,
		folder,
		by:      None,		// the bytes found were nobody's in this turn
		door:    false,
	}
}

/// Why a turn may not keep one more copy, as [`claim_room`] answers it.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Short {
	Count,		// the turn keeps as many copies as one manifest holds rows
	Bytes(u64),	// the turn holds a destruction, and its copies would pass the room left: the room
}

/// An act a turn has been allowed and has not yet captured.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Reserved {
	pub path:       String,		// as the capture will name it
	pub copy:       Option<u64>,	// the length of the copy it keeps; none where it keeps none
	pub destroying: bool,		// a delete, or a write that wipes the file
}

/// May a turn holding `held`, with the acts `reserved` in flight, replace or remove `path` and
/// still keep what it owes?  A yes reserves the act: `Ok(true)` where this call did, `Ok(false)`
/// where the path was already held or reserved.
///
/// Two bounds, each about what can be put back, and so **each about copies**:
///
/// * **Copies.**  A manifest keeps [`TURN_FILES_MAX`] rows, and a row the cut leaves out is a
///   change with no way back only where it held a copy ([`cut_order`]).  So a turn keeps that many
///   copies -- of files that were there before it changed, moved or deleted them -- and no more.
///   Until the fix's QA (QF1, 2026-09-24) every entry counted, the files the turn made and the
///   destinations of its moves included: renaming a folder of 33 files the turn had just written
///   was refused as "64 existing files", and so was an edit of the user's file after 64 new ones.
/// * **Bytes, once the turn holds a destruction** -- a delete, or a write that left less than half
///   of a user's file ([`wipes`]).  A version recording one is kept through its hold whatever the
///   ceiling says ([`DELETE_HOLD_MS`]), so what the turn keeps -- every copy in it, since the whole
///   manifest is held -- must fit in `room`, the ceiling less what the held versions already weigh.
///   Past it, the store could keep the copy only by letting the ceiling go.
///
/// A path the turn already holds costs nothing more -- its first copy stands -- but a destruction of
/// it still makes the turn one that holds a destruction.  **Except a run the act ends**
/// ([`run_broken`]): that run leaves for a version of its own ([`seal_broken`]) and the path starts
/// again with a copy of what the act found, so it counts as a path the turn does not yet hold.  An
/// act that keeps no copy is bound by neither.
///
/// # Arguments
/// * `path` - As the capture names it: normalised, or absolute for a machine file.
/// * `found` - What the act found at `path`.
/// * `copy` - The length of the copy the act keeps, or `None` where it keeps none.
/// * `destroying` - Is the act a delete, or a write that leaves less than half of the file?
/// * `room` - The ceiling less what held destructions weigh.
pub fn claim_room(
	held:       &[(String, Change)],
	reserved:   &mut Vec<Reserved>,
	path:       &str,
	found:      &Found,
	copy:       Option<u64>,
	destroying: bool,
	room:       u64,
)
	-> Result<bool, Short>
{
	let ends = |h: &Change| h.path == path && run_broken(h, found);
	let at = reserved.iter().position(|r| r.path == path);
	let known = at.is_some() || held.iter().any(|(_, h)| h.path == path && !ends(h));
	if let Some(bytes) = copy {
		if !known {
			let kept = held.iter().filter(|(_, h)| h.before.is_some() && !ends(h)).count()
				+ reserved.iter().filter(|r| r.copy.is_some()).count();
			if kept >= TURN_FILES_MAX {
				return Err(Short::Count);
			}
		}
		let destroys = destroying
			|| held.iter().any(|(_, h)| matches!(h.after, Body::Gone) || h.wiped)
			|| reserved.iter().any(|r| r.destroying);
		if destroys {
			// A run the act ends still counts here: its version is held as long as this one.
			let total = held.iter()
				.map(|(_, h)| h.before.as_ref().map(|b| b.len() as u64).unwrap_or(0))
				.chain(reserved.iter().map(|r| r.copy.unwrap_or(0)))
				.fold(if known { 0u64 } else { bytes }, |a, b| a.saturating_add(b));
			if total > room {
				return Err(Short::Bytes(room));
			}
		}
	}
	match at {
		Some(i) => {
			// A destruction of a path the turn has so far only edited makes it a turn holding a
			// destruction, which the reservation has to say for the next caller's sum.
			if destroying {
				reserved[i].destroying = true;
			}
			Ok(false)
		},
		None if known	=> Ok(false),
		None		=> {
			reserved.push(Reserved { path: path.to_string(), copy, destroying });
			Ok(true)
		},
	}
}

/// One file a move carries, as the move found it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Moving {
	Read(Vec<u8>, Option<Vec<u8>>),	// its bytes, and the file as the turns found it (none: made here)
	Unread(Body, String),		// `TooLarge` or `Unseen`, and why its bytes were not read
}

/// What a move of one file captures at its two ends, source first: the source gone, keeping the
/// file as the turns found it there, and the destination holding what the move carried.
///
/// Both go through [`capture_into`].  The source's is a destruction of that path, as a delete's is,
/// and brings the same copy a delete there would keep; the destination's carries the bytes' own
/// history, so a user's file moved onto a path this turn made is still the user's file, and a path
/// the turn emptied earlier still goes back to what it held.
///
/// # Arguments
/// * `from`, `to` - As the captures name them, each with whether it is a file of the user's.
pub fn moved(from: (&str, bool), to: (&str, bool), what: Moving) -> (Change, Change) {
	let (after, before, found, carried, refused) = match what {
		Moving::Read(bytes, first) => {
			let found = Found::of(Some(&bytes));
			let carried = match &first {
				Some(k)	=> Carried::Kept(k.clone()),
				None	=> Carried::Made,
			};
			(Body::Held(bytes), first, found, carried, None)
		},
		Moving::Unread(body, why) => (body, None, Found::Unread, Carried::Unread, Some(why)),
	};
	let src = Change {
		path:    from.0.to_string(),
		after:   Body::Gone,
		before,
		found,
		carried: None,
		mark:    from.1,
		refused: refused.clone(),
		wiped:   false,
		folder:  None,
		by:      None,		// the mover names itself, which only its caller knows
		door:    false,
	};
	let dst = Change {
		path:    to.0.to_string(),
		after,
		before:  None,
		found:   Found::Nothing,
		carried: Some(carried),
		mark:    to.1,
		refused,
		wiped:   false,
		folder:  None,
		by:      None,
		door:    false,
	};
	(src, dst)
}

/// Each file the turn holds under the folder `from`: `(the capture's path, the rest of it below
/// `from`, the path the model wrote)`.  Nothing where `from` is a file, or a folder the turn holds
/// nothing under.
///
/// A folder's move carries only these.  The rest of what it holds the turn neither destroys nor
/// made, and where it lands it is measured as it stands ([`this_turn_found`]).
pub fn held_under(held: &[(String, Change)], from: &str) -> Vec<(String, String, String)> {
	let dir = fmt!("{}/", from.trim_end_matches('/'));
	held.iter()
		.filter_map(|(raw, h)| h.path.strip_prefix(dir.as_str())
			.map(|rest| (h.path.clone(), rest.to_string(), raw.clone())))
		.collect()
}


// ┌───────────────────────────────────────────────────────────────┐
// │ Who ran a command                                              │
// └───────────────────────────────────────────────────────────────┘

// A file tool says whose act it was, because it captures the file at the act.  A command, a
// verifier or a download names no path and captures nothing, so the only account of what it
// changed is a look at the scope before and after.  That look is a WINDOW around the call, and
// what it may say is bounded by one rule (J1): a change is credited only where exactly one agent
// can have made it.  Two agents' windows that overlap on a store cannot tell whose call a change
// was, so a path both saw change names nobody.

/// What a walk saw of one file, which is enough to tell that it moved and says nothing of how.
///
/// A walk that read and hashed every file cost 234 to 265 ms at the 500-file bound (release
/// 5.3.0, check-first 1), against 85 to 99 ms for the length and the modification time the
/// listing already carries.  A window takes two walks per call, so it asks the cheap question
/// and reads only the files that moved.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Stamp {
	Seen(u64, Option<u64>),	// its length, and when it was last written in ms
	Hashed(String),		// the hash of its bytes, for a file whose backend keeps no time
}

/// A scope as one walk found it: each path with its stamp, and no entry for a path with no file.
pub type Snap = BTreeMap<String, Stamp>;

/// What a credited author carries in `via` when a command or helper window named it, and what a
/// file tool's capture never does.
pub const VIA_COMMAND: &str = "command";

/// The most closed windows one store keeps for its next turn end.  A turn runs a few dozen
/// commands; a store that is never drained would otherwise grow with every call.
pub const WINDOWS_MAX: usize = 1000;

/// One call whose file effects no capture records, and what moved while it was in flight.
///
/// `from` and `to` are places in one order shared by every window of a store, so two windows
/// overlap exactly where their intervals do.  `shifted` is `None` for a call that never closed
/// or has not yet: nothing is known of what it moved, and it can only spoil another's claim.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Window {
	pub by:      Option<Author>,
	pub from:    u64,
	pub to:      u64,
	pub shifted: Option<Vec<(String, Option<Stamp>)>>,
}

impl Window {

	/// Did this window's interval and `other`'s share a place in the order?
	fn overlaps(&self, other: &Window) -> bool {
		self.from <= other.to && other.from <= self.to
	}
}

/// The paths two walks of one scope disagree about, each with what the later walk saw there, or
/// `None` where the file has gone.  In path order.
pub fn shifted(before: &Snap, after: &Snap) -> Vec<(String, Option<Stamp>)> {
	let mut out: Vec<(String, Option<Stamp>)> = Vec::new();
	for (path, now) in after.iter() {
		if before.get(path) != Some(now) {
			out.push((path.clone(), Some(now.clone())));
		}
	}
	for path in before.keys() {
		if !after.contains_key(path) {
			out.push((path.clone(), None));
		}
	}
	out.sort_by(|a, b| a.0.cmp(&b.0));
	out
}

/// One changed path and who may be named for it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Credit {
	pub path: String,
	pub by:   Option<Author>,	// `None` names nobody
	pub left: Option<Stamp>,	// what the last window to move it left there; `None` where gone
}

/// Who made each path that a window saw change (J1, J2), in path order.
///
/// * A path a file tool captured keeps the capture's author, and its `via` is the capture's own.
///   A tool knew whose act it was; a window can only infer it.
/// * A path that windows of one author alone saw change is that author's, with `via` set to
///   [`VIA_COMMAND`].
/// * A path that windows of two authors both saw change names nobody, as does one that moved
///   while a window of another author was in flight and nothing is known of what it moved.
///
/// A window that did not see a path change did not change it: a change inside its interval would
/// have been in its two walks.  So a path that moved in one agent's window alone is that agent's
/// even where another's window overlapped it.
///
/// # Arguments
/// * `held` - The paths the file tools captured this turn, each with the author of its act.
pub fn attribute(windows: &[Window], held: &[(String, Option<Author>)]) -> Vec<Credit> {
	// Every path a closed window moved, with the windows that moved it.
	let mut seen: BTreeMap<&str, Vec<&Window>> = BTreeMap::new();
	for w in windows.iter() {
		if let Some(list) = &w.shifted {
			for (path, _) in list.iter() {
				seen.entry(path.as_str()).or_default().push(w);
			}
		}
	}
	let mut out: Vec<Credit> = Vec::new();
	for (path, movers) in seen.into_iter() {
		// The last window to move it, by where it closed, says what the file was left as.
		let last = movers.iter().copied().max_by_key(|w| w.to);
		let left = last.and_then(|w| w.shifted.as_ref())
			.and_then(|list| list.iter().find(|(p, _)| p == path))
			.and_then(|(_, stamp)| stamp.clone());
		if let Some((_, cap)) = held.iter().find(|(p, _)| p == path) {
			out.push(Credit { path: path.to_string(), by: cap.clone(), left });
			continue;
		}
		let first = match movers.first() {
			Some(w) => w.by.clone(),
			None    => None,
		};
		let alone = movers.iter().all(|w| w.by == first);
		// A call nothing is known of, by someone else, which was in flight at the same time.
		let spoilt = windows.iter().any(|lost| lost.shifted.is_none() && lost.by != first
			&& movers.iter().any(|w| w.overlaps(lost)));
		let by = match (&first, alone && !spoilt) {
			(Some(a), true) => Some(Author { via: VIA_COMMAND.to_string(), ..a.clone() }),
			_               => None,
		};
		out.push(Credit { path: path.to_string(), by, left });
	}
	out
}

/// An open window: a call in flight.
#[derive(Debug)]
struct Open {
	by:     Option<Author>,
	from:   u64,			// where the snapshot it began from was first taken
	before: Option<Snap>,		// that snapshot, once it is in hand
	mid:    u64,			// where the call returned and its closing walk began
	acts:   u64,			// the act count then, which the closing snapshot is stamped with
}

/// A snapshot a later window of the same author may begin from, so that N calls cost N+1 walks.
#[derive(Debug)]
struct Shot {
	snap: Snap,
	from: u64,		// where its walk began, which a window that begins from it inherits
	acts: u64,		// the act count when that walk began
	by:   Option<Author>,
}

/// The windows of one store, from the call that opens one to the turn end that takes them.
///
/// The walks are the caller's, because they await the disk.  What is here is the order they come
/// in, whether a walk is needed at all, and what each window saw.  [`Windows::act`] is for
/// anything that can change the scope behind a window's back and is known to: a file tool's
/// capture, a person's own door, another agent's call.  A snapshot is reused only where nothing
/// of the kind has come since it was taken.
#[derive(Debug, Default)]
pub struct Windows {
	tick: u64,		// the order: one place per walk begun or ended
	acts: u64,		// bumped by every act that may have changed the scope
	next: u64,
	last: Option<Shot>,
	open: BTreeMap<u64, Open>,
	done: Vec<Window>,
}

impl Windows {

	fn place(&mut self) -> u64 {
		self.tick += 1;
		self.tick
	}

	/// Open a window for a call by `by`, answering its id and whether the caller walks the scope
	/// and hands it to [`Windows::began`].  It does not where the last window of the same author
	/// closed with nothing since to change the scope.
	pub fn begin(&mut self, by: Option<Author>) -> (u64, bool) {
		self.next += 1;
		let id = self.next;
		let reuse = match &self.last {
			Some(s) if s.acts == self.acts && s.by == by => Some((s.snap.clone(), s.from)),
			_                                            => None,
		};
		// This call may change the scope, so no snapshot taken before it serves what comes after.
		self.acts += 1;
		match reuse {
			Some((snap, from)) => {
				self.open.insert(id, Open { by, from, before: Some(snap), mid: 0, acts: 0 });
				(id, false)
			},
			None => {
				let from = self.place();
				self.open.insert(id, Open { by, from, before: None, mid: 0, acts: 0 });
				(id, true)
			},
		}
	}

	/// The scope as the walk `begin` asked for found it.
	pub fn began(&mut self, id: u64, snap: Snap) {
		self.place();
		if let Some(o) = self.open.get_mut(&id) {
			o.before = Some(snap);
		}
	}

	/// The call has returned, and the caller is about to walk the scope for [`Windows::ended`].
	pub fn finish(&mut self, id: u64) {
		self.acts += 1;
		let (acts, mid) = (self.acts, self.place());
		if let Some(o) = self.open.get_mut(&id) {
			o.mid = mid;
			o.acts = acts;
		}
	}

	/// The scope as the walk after the call found it: the window closes and says what moved.
	pub fn ended(&mut self, id: u64, snap: Snap) {
		let to = self.place();
		let o = match self.open.remove(&id) {
			Some(o) => o,
			None    => return,
		};
		let shifted = o.before.as_ref().map(|before| shifted(before, &snap));
		self.done.push(Window { by: o.by.clone(), from: o.from, to, shifted });
		if self.done.len() > WINDOWS_MAX {
			// The oldest go: what they moved is then in no window and is not the turn's.
			let over = self.done.len() - WINDOWS_MAX;
			self.done.drain(..over);
		}
		self.last = Some(Shot { snap, from: o.mid, acts: o.acts, by: o.by });
	}

	/// The call never closed: its future was dropped.  Nothing is known of what it moved, and
	/// nothing it left can be trusted as the scope's last snapshot.
	pub fn lost(&mut self, id: u64) {
		let to = self.place();
		if let Some(o) = self.open.remove(&id) {
			self.done.push(Window { by: o.by, from: o.from, to, shifted: None });
		}
		self.last = None;
	}

	/// Something outside every window may have changed the scope.
	pub fn act(&mut self) {
		self.acts += 1;
	}

	/// The closed windows, leaving none.  A call still in flight is in the answer as a window
	/// that moved nothing known, so it can spoil a claim, and stays open to be taken when it
	/// closes.
	pub fn take(&mut self) -> Vec<Window> {
		// A snapshot does not outlive its turn: what changed since, a sync arrival or a person's
		// edit, would be this turn's first window's.
		self.last = None;
		let mut out = std::mem::take(&mut self.done);
		for o in self.open.values() {
			out.push(Window { by: o.by.clone(), from: o.from, to: u64::MAX, shifted: None });
		}
		out
	}
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
// │ Which folder a row was written in                              │
// └───────────────────────────────────────────────────────────────┘
//
// **A workspace-relative path names a file only together with the folder it is in** (HR of the
// release 5.1 fix's third QA, built for release 5.2, 2026-09-25).  `notes/x.md` is one file in the
// browser's own storage, another in a folder opened on this computer, and a third on the machine
// behind a hand, and which of them a path reaches depends on what is open at the moment it is
// used.  A row recorded while one was open was put back through whichever reached the path at the
// restore: a Restore through a hand whose folder held a different `notes/x.md` wrote over it, and
// asked nothing.  The row kept what it replaced, so nothing was lost, but the person's file was
// replaced by a stranger's.
//
// So a row of a relative path records the folder it was written in, and a restore puts it back
// only where the path reaches that same folder ([`route`]).  The folder is named by an id, never
// a path, since a manifest travels with the Diamond and a machine path names its owner: the
// browser's storage is [`BROWSER_FOLDER`], one workspace the account's devices share, and a
// folder opened on this computer is the id this device gave it when it was first picked (M2 of
// 2026-09-24, `FsaDB.folderId` in the page).  A machine file is recorded by its absolute path,
// which names its place already, and the store's own paths are the same place from every folder.

/// The folder name a row carries for the browser's own storage.
pub const BROWSER_FOLDER: &str = "browser";

/// What a folder opened with no id of its own is called in a row: the device's record of folders
/// refused one, or the caller gave none.  **It names no folder**: two such folders cannot be told
/// apart, so a row of one is never taken to be a file of another, nor of itself (HX2 of HR's QA).
pub const UNNAMED_FOLDER: &str = "opened";

/// Does a row of `path` need the folder it was written in to say which file it is?  A
/// workspace-relative path does; an absolute machine path and one of the store's own do not.
pub fn needs_folder(path: &str) -> bool {
	!path.starts_with('/') && !crate::tools::is_store_path(path)
}

/// Why a restore cannot tell whether a row's file is the one its path reaches now.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Unplaced {
	Unrecorded,	// written before rows recorded their folder
	Unknown,	// written in a folder this device does not know, or in one opened unnamed
}

/// What a restore's act may do at the place its path reaches now.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Route {
	Go,		// the row's own file: put it back
	Left,		// another place's file of the same name: leave it as it stands
	Ask(Unplaced),	// over different bytes, and whose file it is cannot be told: the person decides
}

/// Where a row of `row` written in `row_folder` may be put back, now that its path reaches
/// `landed` in `landed_folder`.
///
/// **Only into the file it was written from, where that can be told.**  A machine row lands only
/// at its own absolute path, and a relative row never lands on the machine.  A relative row lands
/// in its own folder, and is left where the path reaches another place this device can name:
/// browser storage from a folder or a folder from it, or another folder this device knows.
///
/// **A row whose folder cannot be named here is not left for good** (HX1 and HX2 of HR's QA,
/// 2026-09-25).  A folder's id belongs to the device that picked it, so a row from a folder on
/// another device, from one moved or renamed, from one picked again after "Forget", or from
/// before the site's data was cleared, names a folder this device does not know; and a folder
/// opened unnamed names none.  Leaving such rows left them by every route, silently, on every
/// device but the one that wrote them.  They are placed as a row from before folders were
/// recorded is: put back where nothing stands or the same bytes do, and over different bytes the
/// person is asked first.  No row lands over different bytes unasked.
///
/// # Arguments
/// * `row` - The path as the row names it: workspace-relative, or absolute on the machine.
/// * `landed` - Where the act reaches: normalised, or absolute where it goes through the hand.
/// * `known` - Is `row_folder` a folder this device knows ([`crate::wasm::opfs::folder_known`])?
/// * `overwrites` - Would the act replace bytes other than the ones it puts back?
pub fn route(
	row:		&str,
	row_folder:	Option<&str>,
	landed:		&str,
	landed_folder:	Option<&str>,
	known:		bool,
	overwrites:	bool,
)
	-> Route
{
	if row.starts_with('/') || landed.starts_with('/') || row != landed {
		return if row == landed { Route::Go } else { Route::Left };
	}
	if !needs_folder(row) {
		return Route::Go;
	}
	if elsewhere(row_folder, landed_folder, known) {
		return Route::Left;
	}
	let unplaced = |why| if overwrites { Route::Ask(why) } else { Route::Go };
	match (row_folder, landed_folder) {
		(None, _)						=> unplaced(Unplaced::Unrecorded),
		(Some(r), Some(l)) if r == l && r != UNNAMED_FOLDER	=> Route::Go,
		(Some(_), _)						=> unplaced(Unplaced::Unknown),
	}
}

/// Is a row of a relative path, written in `row_folder`, another place's file where the path
/// reaches `here`: a place this device can name, and not this one?  Browser storage from a folder
/// or a folder from it, or a folder this device knows with another named folder open.  A row from
/// before folders were recorded, from this folder, or from a folder this device cannot name is not.
///
/// **The one question the restore's route and the history's resolvers both ask** (HQ1 of HR's QA
/// round 2, 2026-09-27).  [`route`] leaves exactly these rows, and [`answering`] drops exactly
/// these; any other row may be this folder's file, and answers for it.
///
/// # Arguments
/// * `known` - Is `row_folder` a folder this device knows ([`crate::wasm::opfs::folder_known`])?
pub fn elsewhere(row_folder: Option<&str>, here: Option<&str>, known: bool) -> bool {
	match (row_folder, here) {
		(None, _)						=> false,
		(Some(r), Some(l)) if r == l && r != UNNAMED_FOLDER	=> false,
		(Some(BROWSER_FOLDER), _) | (_, Some(BROWSER_FOLDER))	=> true,
		(Some(_), Some(l))					=> known && l != UNNAMED_FOLDER,
		(Some(_), None)						=> false,
	}
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
		folder:  Option<String>,	// the folder the answering row was written in
	},
	Gone {
		mark:    bool,		// the path is in a folder the user marked in, so only a fenced door removes it
		folder:  Option<String>,
	},
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
	///
	/// Asked of a `Gone` state as well (F5, 2026-09-25): a marked path that was not there at the
	/// version is still the user's file NOW, and removing it is the fenced door's to do, not the
	/// store's.
	pub fn mark(&self) -> bool {
		match self {
			Self::Held { mark, .. }	=> *mark,
			Self::Gone { mark, .. }	=> *mark,
		}
	}

	/// The folder the row this state comes from was written in ([`needs_folder`]).
	pub fn folder(&self) -> Option<&str> {
		match self {
			Self::Held { folder, .. } | Self::Gone { folder, .. }	=> folder.as_deref(),
		}
	}

	/// The state an entry's creation leaves before it: nothing, in the entry's own folder.
	fn made(e: &Entry) -> Self {
		Self::Gone { mark: e.mark, folder: e.folder.clone() }
	}

	/// What an entry says stood at its path once its version was recorded.
	fn after(e: &Entry) -> Self {
		match e.gone {
			true	=> Self::made(e),
			false	=> Self::Held {
				hash:    e.hash.clone(),
				bytes:   e.bytes,
				mark:    e.mark,
				skipped: e.skipped.clone(),
				folder:  e.folder.clone(),
			},
		}
	}

	/// What stood at a path BEFORE an entry, where the entry says: its `was`.  `None` for an entry
	/// with no `was`, a file the store saw being created.  The size is not recoverable from a
	/// `was` (a manifest records the hash alone), so the row answers `bytes: 0`; nothing restores
	/// from the length, and the hash is exact.
	fn before(e: &Entry) -> Option<Self> {
		e.was.as_ref().map(|w| Self::Held {
			hash:    w.clone(),
			bytes:   0,
			mark:    e.mark,
			skipped: None,
			folder:  e.folder.clone(),
		})
	}
}

// **A relative path's history is its history in one folder** (HX3 of HR's QA, 2026-09-25).  Every
// resolver below read a path's rows alone, so where one path had rows from two places -- browser
// storage and an opened folder, or two folders -- one place's newer row shadowed the other's: a
// whole-version Restore in F1 took browser storage's row and left F1's own, and a change in F1
// that kept no bytes took no `was` because the newest row was F2's, so a delete went unrecorded.
// So each asks for the rows of the folder its path reaches ([`answering`]), and a row from before
// folders were recorded answers for every folder, as it did before.
//
// **And "the folder it reaches" is decided by the route's own question** (HQ1 of HR's QA round 2,
// 2026-09-27).  HX3 kept only the open folder's rows and the rows from before folders, so a row
// from a folder this device cannot name -- another device's, the same folder under its id from
// before a "Forget" -- stopped answering the moment the open folder had a row of the path.  A
// whole Restore then put back the open folder's own older row, or its first row's `was`, and
// `route` let it go unasked: another version's bytes, reported as success.  Such a row is placed
// as a row from before folders is ([`route`]), so it answers as one: only a row of a place this
// device can name as another ([`elsewhere`]) is dropped.  The `was` of a change that kept no bytes
// is not a resolver's answer but a claim filed under the folder, and keeps to the folder's own rows
// ([`indexed_was`]).

/// Every row naming each path, with its version, oldest first (a version's rows in their order).
fn rows_by_path(manifests: &[(u64, Manifest)]) -> BTreeMap<&str, Vec<(u64, &Entry)>> {
	let mut sorted: Vec<&(u64, Manifest)> = manifests.iter().collect();
	sorted.sort_by_key(|(n, _)| *n);
	let mut out: BTreeMap<&str, Vec<(u64, &Entry)>> = BTreeMap::new();
	for (n, m) in sorted.into_iter() {
		for e in m.files.iter() {
			out.entry(e.path.as_str()).or_default().push((*n, e));
		}
	}
	out
}

/// The rows of one path that answer for it in the folder `here`: every row but those of a place
/// this device can name as another ([`elsewhere`]), where any is left; else every row, which the
/// restore then leaves ([`route`]) and says so.  Every row where `here` names no folder: the path
/// is absolute on the machine or one of the store's own, whose rows carry none.
fn answering<'a, K>(rows: Vec<(u64, &'a Entry)>, here: Option<&str>, known: K) -> Vec<(u64, &'a Entry)>
	where K: Fn(&str) -> bool
{
	if here.is_none() {
		return rows;
	}
	let own: Vec<(u64, &Entry)> = rows.iter()
		.filter(|(_, e)| !elsewhere(e.folder.as_deref(), here, e.folder.as_deref().map(&known).unwrap_or(false)))
		.cloned()
		.collect();
	match own.is_empty() {
		true	=> rows,
		false	=> own,
	}
}

/// Of the rows at version `n`, the one written in `prefer`, else the first.
fn pick<'a>(rows: &[(u64, &'a Entry)], n: u64, prefer: Option<&str>) -> Option<&'a Entry> {
	let at: Vec<&Entry> = rows.iter().filter(|(v, _)| *v == n).map(|(_, e)| *e).collect();
	at.iter().find(|e| prefer.is_some() && e.folder.as_deref() == prefer)
		.or_else(|| at.first())
		.copied()
}

/// The row answering for `rows` (oldest first) at `want`: the newest at or before it, `true`; or
/// else the earliest after it, `false`.
fn answer<'a>(rows: &[(u64, &'a Entry)], want: u64, prefer: Option<&str>) -> Option<(&'a Entry, bool)> {
	match rows.iter().map(|(n, _)| *n).filter(|n| *n <= want).max() {
		Some(n)	=> pick(rows, n, prefer).map(|e| (e, true)),
		None	=> rows.iter().map(|(n, _)| *n).filter(|n| *n > want).min()
			.and_then(|n| pick(rows, n, prefer))
			.map(|e| (e, false)),
	}
}

/// Every path these manifests have ever named, as it stood at `want` in the folder each reaches.
///
/// **The union and not the survivors**, because that is what a whole-version restore needs: a
/// file created AFTER `want` has to be removed to put the Diamond back, and a resolver that
/// answered only about paths known by `want` would leave it standing and report success.
///
/// **A path with no entry at or before `want` answers what its EARLIEST later entry says stood
/// there** -- that entry's `was` -- exactly as [`path_at`] does.  Only an earliest later entry
/// with no `was`, a file the store saw being created, makes the path [`At::Gone`].  Until
/// 2026-09-25 (F5) every such path was `Gone`, so a whole-version restore took a file the store
/// first met AFTER `want` -- a marked file a turn edited, most commonly -- to have been absent,
/// and deleted it straight off the user's open folder.  Its `was` said otherwise all along.
///
/// **In the folder the path reaches** ([`answering`]): every row but another nameable place's
/// answers for it, and another place's only where no other row does.
///
/// Ordered by path, so two calls over the same store answer in the same order.
///
/// # Arguments
/// * `manifests` - Every manifest held, by version, in any order.
/// * `want` - The version to resolve as at.
/// * `here` - The folder each path reaches now ([`crate::wasm::diamond::folder_of`]).
/// * `known` - Is a folder one this device knows ([`crate::wasm::opfs::folder_known`])?
pub fn state_at<F, K>(manifests: &[(u64, Manifest)], want: u64, here: F, known: K) -> Vec<(String, At)>
	where
		F: Fn(&str) -> Option<String>,
		K: Fn(&str) -> bool,
{
	let mut out: Vec<(String, At)> = Vec::new();
	for (path, rows) in rows_by_path(manifests).into_iter() {
		let h = here(path);
		let rows = answering(rows, h.as_deref(), &known);
		match answer(&rows, want, h.as_deref()) {
			Some((e, true))		=> out.push((path.to_string(), At::after(e))),
			Some((e, false))	=> out.push((path.to_string(), At::before(e).unwrap_or_else(|| At::made(e)))),
			None			=> {},
		}
	}
	out
}

/// What one path held as at `want`, or `None` where the store cannot say.
///
/// **A file the store met part-way through its life still held something before it.**  The first
/// entry naming a path that already existed carries its prior bytes as `was`, so "what did this
/// hold at a version before that entry" has an answer, and it is that hash -- which is the whole
/// of what makes the FIRST change to a file undoable rather than only the second.
///
/// `None` is kept for the two cases where there really is nothing: a path no manifest names, and
/// one whose earliest later entry carries no `was` -- a file this store first saw being CREATED
/// did not exist before it, and a later entry's `was` is not an answer to a question about a
/// state the user never saw.  [`state_at`] answers every path by the same rule.
///
/// **One row, the one named**: a row's own Restore puts back that row, so of two rows of the path
/// at the version -- two folders' -- the one written in `prefer` answers.
///
/// # Arguments
/// * `prefer` - The folder of the row the person chose, else the folder the path reaches now.
pub fn path_at(manifests: &[(u64, Manifest)], path: &str, want: u64, prefer: Option<&str>)
	-> Option<At>
{
	held_at(&rows_by_path(manifests).remove(path).unwrap_or_default(), want, prefer)
}

/// What one path held as at `want` in the folder `here` it reaches now, by [`path_at`]'s rule over
/// the rows that answer there ([`answering`]): the daimon's `file_revert` to a version, which names
/// no row.  Another nameable place's newer row does not shadow this folder's own (HQ1's sweep).
pub fn path_here<K>(manifests: &[(u64, Manifest)], path: &str, want: u64, here: Option<&str>, known: K)
	-> Option<At>
	where K: Fn(&str) -> bool
{
	let rows = answering(rows_by_path(manifests).remove(path).unwrap_or_default(), here, known);
	held_at(&rows, want, here)
}

/// [`path_at`]'s answer from `rows`, oldest first.
fn held_at(rows: &[(u64, &Entry)], want: u64, prefer: Option<&str>) -> Option<At> {
	match answer(rows, want, prefer) {
		Some((e, true))		=> Some(At::after(e)),
		Some((e, false))	=> At::before(e),
		None			=> None,
	}
}

/// What each path version `of` changed held just before it: the undo of that version, which puts
/// back what it replaced and nothing older.
///
/// **Its own row's `was`, never the state at `of - 1`** (U1 of the release 5.1 fix's second QA,
/// 2026-09-25).  The Undo asked [`path_at`] for `of - 1`, which answers the newest entry at or
/// before it.  Where anything changed the file between that entry and `of` -- the person's own
/// save, most often -- that older entry's text went back, and the save was left as a `was` that
/// no button restores.  A row with no `was` made its file, so undoing it takes the file away:
/// [`At::Gone`] with the row's mark, which the caller puts to the person where the file is theirs.
///
/// A record past the rows one version holds goes on into the versions after it ([`split_rows`]),
/// so a path named and not at `of` answers its earliest entry after `of`.  A path no entry at or
/// after `of` names is left out, because there is nothing to put back.  Of two rows of a path at
/// that version, the one written in the folder the path reaches answers.
///
/// # Arguments
/// * `paths` - The paths to undo, as the store names them; empty for every path `of` names.
/// * `here` - The folder each path reaches now.
pub fn undo_of<F>(manifests: &[(u64, Manifest)], of: u64, paths: &[String], here: F)
	-> Vec<(String, At)>
	where F: Fn(&str) -> Option<String>
{
	let mut out: Vec<(String, At)> = Vec::new();
	for (path, rows) in rows_by_path(manifests).into_iter() {
		if !paths.is_empty() && !paths.iter().any(|p| p == path) {
			continue;
		}
		let first = rows.iter().map(|(n, _)| *n)
			.filter(|n| *n == of || (*n > of && !paths.is_empty()))
			.min();
		let h = here(path);
		if let Some(e) = first.and_then(|n| pick(&rows, n, h.as_deref())) {
			out.push((path.to_string(), At::before(e).unwrap_or_else(|| At::made(e))));
		}
	}
	out
}

/// The version to undo one path to when nobody said which: what it held before the newest change
/// to it in the folder it reaches now, and the version that change was recorded at.
///
/// `None` where the path has no history here at all, and where its newest entry carries no `was`
/// -- a file whose prior bytes were never captured has nothing to go back to, and answering with
/// an older version would restore a state the user never saw.
///
/// Answered with the folder that entry was written in ([`needs_folder`]), which decides where
/// the bytes may go back.  The newest change is the newest of the rows that answer here
/// ([`answering`]): another device's change counts, and another folder of this device's does not.
pub fn undo_target<K>(manifests: &[(u64, Manifest)], path: &str, here: Option<&str>, known: K)
	-> Option<(u64, String, Option<String>)>
	where K: Fn(&str) -> bool
{
	let rows = answering(rows_by_path(manifests).remove(path).unwrap_or_default(), here, known);
	let n = rows.iter().map(|(n, _)| *n).max()?;
	let e = pick(&rows, n, here)?;
	e.was.clone().map(|was| (n, was, e.folder.clone()))
}

/// The newest row of every path in every folder: `(path, folder)` to the version and the hash it
/// left, `None` where it left no body -- a deletion, or a change kept without its bytes.
///
/// **This is the index, derived rather than stored.** The launch plan kept it in a
/// `versions/index.json`; a second copy of a fact the manifests already carry is a second thing
/// for a prune to leave behind, and the store is small enough that reading it costs one directory
/// walk either way. A path whose whole history has been pruned falls out of this and its next
/// change records `was: null`, which is honest -- the body it would have named is gone too.
pub fn index_placed(manifests: &[(u64, Manifest)])
	-> BTreeMap<(String, Option<String>), (u64, Option<String>)>
{
	let mut out = BTreeMap::new();
	for (path, rows) in rows_by_path(manifests).into_iter() {
		for (n, e) in rows.into_iter() {
			// Oldest first, so each place ends on its newest row.
			let hash = match At::after(e) {
				At::Held { hash, skipped: None, .. } if !hash.is_empty()	=> Some(hash),
				_								=> None,
			};
			out.insert((path.to_string(), e.folder.clone()), (n, hash));
		}
	}
	out
}

/// What stood at `path` before a change made in `folder` that captured no bytes of its own: the
/// hash its newest row in that folder left, a row from before folders were recorded counting as
/// every folder's, and that folder's own row first at a tie.  A change that names no folder takes
/// the path's newest row anywhere.  Never another folder's, whose file of the same name this is
/// not.
///
/// **This folder's own knowledge only, unlike the resolvers** (HQ1 of HR's QA round 2, 2026-09-27).
/// The answer becomes the `was` of a row filed under `folder`, so its Undo puts it back as this
/// folder's own, unasked; a hash borrowed from a folder this device cannot name would lose where
/// it came from, and go back over the folder's file as though the folder had held it.  The
/// resolvers ([`answering`]) may offer such a row, because it reaches [`route`] with its own
/// folder and is asked about there; this answer never does.
pub fn indexed_was(
	index:	&BTreeMap<(String, Option<String>), (u64, Option<String>)>,
	path:	&str,
	folder:	Option<&str>,
)
	-> Option<String>
{
	index.range((path.to_string(), None)..)
		.take_while(|((p, _), _)| p == path)
		.filter(|((_, f), _)| folder.is_none() || f.is_none() || f.as_deref() == folder)
		.max_by_key(|((_, f), (n, _))| (*n, folder.is_some() && f.as_deref() == folder))
		.and_then(|(_, (_, h))| h.clone())
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

/// How far below its ceilings a prune takes the store, in percent of each.
pub const PRUNE_LOW_PCT: u64 = 90;

impl Caps {
	/// The low-water mark a prune works down to: [`PRUNE_LOW_PCT`] of each ceiling.
	pub fn low(self) -> Self {
		Self {
			bytes:     ((self.bytes as u128) * (PRUNE_LOW_PCT as u128) / 100) as u64,
			manifests: ((self.manifests as u64) * PRUNE_LOW_PCT / 100) as usize,
		}
	}
}

impl Default for Caps {
	fn default() -> Self {
		Self { bytes: versions_bytes_cap(), manifests: MANIFESTS_MAX }
	}
}

/// What a prune would remove: the manifests, then the bodies nothing names any more.
///
/// `pages` is the page data the plan ranked by ([`page_paths`]): the store's own list joined with
/// what the manifests show.  The caller keeps it ([`PAGES_LOG`]) BEFORE it deletes anything, so the
/// evidence a prune takes away is never the last word on whose a path is.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct Prune {
	pub manifests: Vec<u64>,
	pub bodies:    Vec<String>,
	pub pages:     BTreeSet<String>,
}

impl Prune {
	pub fn is_empty(&self) -> bool {
		self.manifests.is_empty() && self.bodies.is_empty()
	}
}

/// Is `path` outside the keeper's home `home` (`diamonds/<id>` or `chats/<id>`), and so a file of
/// the user's, in a folder they opened or marked in?
pub fn is_users_path(home: &str, path: &str) -> bool {
	home_rel(home, path).is_none()
}

/// The keeper's own directories that hold its working state rather than anybody's data.
const KEEPER_DIRS: [&str; 4] = [".daimond", "versions", "shots", "dev"];

/// The keeper's own records at the top of a home, which a page may never write (`crystal.js`
/// `PAGE_NEVER_WRITES`).
const KEEPER_FILES: [&str; 5] = ["crystal.json", "crystal.html", "crystal.md", "capp.json",
	"triggers.json"];

/// Could `path` be data a page keeps in its Diamond: inside the keeper's home `home`, and not one of
/// the keeper's own directories ([`KEEPER_DIRS`]) or records ([`KEEPER_FILES`])?
///
/// Where the path sits says nothing more (D-26 review A F1, 11 Oct 2026): the Life log page keeps
/// `index.json` at the top of its home, beside the daimon's `STATE.md`.  Whose a path IS, is
/// [`page_paths`]'s, by who wrote it.
pub fn is_page_data(home: &str, path: &str) -> bool {
	match home_rel(home, path) {
		Some(rel) => {
			let top = rel.split('/').next().unwrap_or(rel);
			let dir = rel.contains('/');
			!(dir && KEEPER_DIRS.contains(&top)) && !(!dir && KEEPER_FILES.contains(&rel))
		},
		None      => false,
	}
}

/// The paths that hold a page's data: those a person's door has written, by PROVENANCE and never
/// by where the path sits (D-26 review A F1-F3, F8).
///
/// * `known`, the store's own list ([`PAGES_LOG`]): grow-only, so a path stays page data after
///   the prune has taken every manifest that showed a door writing it (F2).
/// * A row a door wrote (`door`), whatever the manifest's cause: a page write a Save drained is
///   page data, while the Save's walk of the home is not (F3; verify_versions arm 7).
/// * A manifest from before rows carried `door` ([`DOOR_V`]): its rows if its cause is
///   [`Cause::User`], the only evidence it had.
/// * A page file moved: a manifest that deletes a page path and writes its bytes elsewhere carries
///   the status to the new path (F8).
///
/// Only paths [`is_page_data`] allows.  A path only turns have written is the daimon's notes
/// wherever it sits, so its edits still go first.
pub fn page_paths(
	manifests: &[(u64, Manifest)],
	home:      &str,
	known:     &BTreeSet<String>,
)
	-> BTreeSet<String>
{
	let mut out: BTreeSet<String> = known.iter()
		.filter(|p| is_page_data(home, p))
		.cloned()
		.collect();
	let mut order: Vec<&(u64, Manifest)> = manifests.iter().collect();
	order.sort_by_key(|(n, _)| *n);
	for (_, m) in order.into_iter() {
		let legacy = m.v < DOOR_V && m.cause == Cause::User;
		for e in m.files.iter() {
			if (e.door || legacy) && is_page_data(home, &e.path) {
				out.insert(e.path.clone());
			}
		}
		let moved: BTreeSet<&str> = m.files.iter()
			.filter(|e| e.gone && out.contains(&e.path))
			.filter_map(|e| e.was.as_deref())
			.collect();
		if moved.is_empty() {
			continue;
		}
		for e in m.files.iter() {
			if !e.gone && moved.contains(e.hash.as_str()) && is_page_data(home, &e.path) {
				out.insert(e.path.clone());
			}
		}
	}
	out
}

/// The file in `versions/` that keeps the paths known to hold page data ([`page_paths`]), as a JSON
/// array.  Grow-only: it travels with an export and is joined, never replaced, on import.
pub const PAGES_LOG: &str = "pages.json";

/// The paths a [`PAGES_LOG`] holds; nothing where it will not read.
pub fn pages_read(json: &str) -> BTreeSet<String> {
	extract_json_string_array(&fmt!("{{\"p\":{}}}", json.trim()), "p")
		.unwrap_or_default()
		.into_iter()
		.filter(|p| !p.is_empty())
		.collect()
}

/// `pages` as the file to write.
pub fn pages_json(pages: &BTreeSet<String>) -> String {
	let rows: Vec<String> = pages.iter().map(|p| fmt!("\"{}\"", json_escape(p))).collect();
	fmt!("[{}]", rows.join(","))
}

/// `path` relative to the keeper's home, or `None` where it is not inside it.
fn home_rel<'a>(home: &str, path: &'a str) -> Option<&'a str> {
	path.strip_prefix(home).and_then(|r| r.strip_prefix('/')).filter(|r| !r.is_empty())
}

/// Which round of pruning takes this version, lowest first.
///
/// Its cause's rank ([`Cause::prune_rank`]), with two exceptions above a Save.  A version keeping a
/// copy of one of the USER'S files goes after a Save: the Diamond's own files are the daimon's
/// working state, while a copy of the user's file is the only one there is, and an edit of the
/// Diamond's own files must not evict it (re-check R4, 2026-09-23).  Data a page keeps in its
/// Diamond ranks with the user's files: it is what the user entered, not the daimon's notes
/// ([`Manifest::keeps_users_work`]).  A version recording a destruction -- a delete, or a write
/// that left less than half ([`wipes`]) -- goes last of all.
///
/// # Arguments
/// * `home` - The keeper's home, `diamonds/<id>` or `chats/<id>`, which decides whose a path is.
/// * `page` - The store's page data, [`page_paths`].
pub fn prune_rank_of(m: &Manifest, home: &str, page: &BTreeSet<String>) -> u8 {
	if m.holds_destruction() {
		4
	} else if m.keeps_users_work(home, page) {
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
/// * `home` - The keeper's home, for [`prune_rank_of`].
/// * `known` - The paths the store already knows hold page data ([`PAGES_LOG`]).
pub fn prune_plan(
	manifests: &[(u64, Manifest)],
	held:      &[(String, u64)],
	pinned:    &[String],
	caps:      Caps,
	now:       u64,
	home:      &str,
	known:     &BTreeSet<String>,
)
	-> Prune
{
	let sizes: BTreeMap<&str, u64> = held.iter().map(|(h, n)| (h.as_str(), *n)).collect();
	let newest = manifests.iter().map(|(n, _)| *n).max().unwrap_or(0);
	let page   = page_paths(manifests, home, known);

	// Oldest and cheapest first; the newest manifest and a deletion inside its hold are not
	// candidates at all.
	let mut order: Vec<(u8, u64)> = manifests.iter()
		.filter(|(n, m)| *n != newest && !m.held_at(now))
		.map(|(n, m)| (prune_rank_of(m, home, &page), *n))
		.collect();
	order.sort();

	let mut keep: BTreeSet<u64> = manifests.iter().map(|(n, _)| *n).collect();
	let mut dropped: Vec<u64> = Vec::new();
	// A store inside its ceilings loses nothing; one over them goes down to the low-water mark, so
	// a store at its limit prunes in rare batches rather than one version per save (D-26 A F6).
	let low = if within(manifests, &keep, pinned, &sizes, caps) { caps } else { caps.low() };
	for (_, n) in order.into_iter() {
		if within(manifests, &keep, pinned, &sizes, low) {
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
	Prune { manifests: dropped, bodies, pages: page }
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

/// How long after a body file is written a sweep leaves it alone, in ms, where the claims of the
/// writes in flight cannot be read.
pub const SWEEP_GRACE_MS: u64 = 60_000;	// far past any write's gap between its bodies and its name

/// The claims of the writes in flight in every tab, under `versions/`: device-local, never carried.
pub const CLAIMS_FILE: &str = "claims.json";

/// How long a claim holds without renewal, in ms.
pub const CLAIM_LEASE_MS: u64 = 120_000;	// a claimed write is one body and one note, seconds; a tab silent this long has closed or crashed

/// A write in flight outside the version hold: its bodies are down, or going down, and the note
/// naming them is not yet written (D-26 HISTFIX2 b5, rc-b ruling).  Written to [`CLAIMS_FILE`]
/// before the first body and cleared once the name is written, each time under the version hold,
/// so a sweep, which holds it too, reads every claim there is.
#[derive(Clone, Debug, PartialEq)]
pub struct Claim {
	pub tab:		String,			// the page that writes
	pub token:		u64,			// its write, within the page
	pub bodies:		Vec<String>,	// the hashes it relies on, written or found
	pub started:	u64,			// epoch ms
	pub until:		u64,			// the lease, epoch ms
}

impl Claim {
	pub fn new(tab: &str, token: u64, bodies: Vec<String>, now: u64) -> Self {
		Self { tab: tab.to_string(), token, bodies, started: now, until: now.saturating_add(CLAIM_LEASE_MS) }
	}

	/// Is the lease still running at `now`?  A claim past it is a write whose tab has gone.
	pub fn live_at(&self, now: u64) -> bool {
		now < self.until
	}

	pub fn is(&self, tab: &str, token: u64) -> bool {
		self.tab == tab && self.token == token
	}

	fn to_json(&self) -> String {
		let hs: Vec<String> = self.bodies.iter().map(|h| fmt!("\"{}\"", json_escape(h))).collect();
		fmt!("{{\"tab\":\"{}\",\"token\":{},\"bodies\":[{}],\"started\":{},\"until\":{}}}",
			json_escape(&self.tab), self.token, hs.join(","), self.started, self.until)
	}
}

/// The claims a [`CLAIMS_FILE`] holds.  Refused where it will not read whole: a sweep must then
/// fall back to [`SWEEP_GRACE_MS`], since a claim it cannot read is a write it cannot see.
pub fn claims_read(json: &str) -> Outcome<Vec<Claim>> {
	let t = json.trim();
	if !(t.starts_with('[') && t.ends_with(']')) {
		return Err(err!("The version claims file '{}' is not a JSON array: {:?}.",
			CLAIMS_FILE, t.chars().take(40).collect::<String>(); Invalid, Input, Decode));
	}
	let body = &t[1..t.len() - 1];
	let objs = objects_in(body);
	if objs.is_empty() && !body.trim().is_empty() {
		return Err(err!("The version claims file '{}' holds no whole claim: {:?}.",
			CLAIMS_FILE, body.chars().take(40).collect::<String>(); Invalid, Input, Decode));
	}
	let mut out = Vec::new();
	for (i, o) in objs.into_iter().enumerate() {
		let tab = extract_json_string(o, "tab");
		let token = extract_json_number(o, "token");
		let started = extract_json_number(o, "started");
		let until = extract_json_number(o, "until");
		let bodies = extract_json_string_array(o, "bodies");
		match (tab, token, started, until, bodies) {
			(Some(tab), Some(token), Some(started), Some(until), Some(bodies)) =>
				out.push(Claim { tab, token, bodies, started, until }),
			_ => return Err(err!("Claim {} of the version claims file '{}' is missing a field: {}.",
				i, CLAIMS_FILE, o; Invalid, Input, Decode)),
		}
	}
	Ok(out)
}

/// `claims` as the [`CLAIMS_FILE`] to write.
pub fn claims_json(claims: &[Claim]) -> String {
	let rows: Vec<String> = claims.iter().map(|c| c.to_json()).collect();
	fmt!("[{}]", rows.join(","))
}

/// What a sweep knows of the writes in flight: when the oldest began, the bodies they rely on,
/// and whether it is blind to some of them because the claims would not read.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct InFlight {
	pub oldest:		Option<u64>,
	pub claimed:	BTreeSet<String>,
	pub blind:		bool,			// the claims file would not read
	pub expired:	Vec<Claim>,		// past their lease: ignored, and cleared by the sweep
}

impl InFlight {
	/// This page's own writes in flight (`local`: when each began, and the bodies they claim),
	/// with every tab's claims where they read (`claims`), or blind where they did not.
	pub fn of(local: (Option<u64>, BTreeSet<String>), claims: Option<&[Claim]>, now: u64) -> Self {
		let (mut oldest, mut claimed) = local;
		let mut expired = Vec::new();
		let blind = claims.is_none();
		for c in claims.unwrap_or(&[]).iter() {
			if !c.live_at(now) {
				expired.push(c.clone());
				continue;
			}
			oldest = Some(oldest.map_or(c.started, |o| o.min(c.started)));
			claimed.extend(c.bodies.iter().cloned());
		}
		Self { oldest, claimed, blind, expired }
	}

	/// The claims to write back: those read, less the expired.
	pub fn kept(claims: &[Claim], now: u64) -> Vec<Claim> {
		claims.iter().filter(|c| c.live_at(now)).cloned().collect()
	}
}

/// The time before which an unnamed body may be swept, or `None` where any may: the start of the
/// oldest write in flight, and no later than [`SWEEP_GRACE_MS`] ago where the claims are unseen.
pub fn sweep_cutoff(now: u64, f: &InFlight) -> Option<u64> {
	let grace = if f.blind { Some(now.saturating_sub(SWEEP_GRACE_MS)) } else { None };
	match (f.oldest, grace) {
		(Some(a), Some(b))	=> Some(a.min(b)),
		(a, b)				=> a.or(b),
	}
}

/// The bodies of `cands` a sweep may delete: none that a manifest in `left` names, none a write in
/// flight claims, and none written at or after `cutoff`.
///
/// **A body no version names may be one a version is writing now** (D-26 HISTFIX2 fix 3b): every
/// write puts its bodies down before the manifest or note that names them, and one that finds a
/// body already there writes nothing, so its age says nothing and only the claim keeps it.
///
/// # Arguments
/// * `stamps` - When each body file was last written, in epoch ms.
/// * `cutoff` - From [`sweep_cutoff`]; with a cutoff, a body of unknown age is kept.
pub fn sweepable(
	left:		&[(u64, Manifest)],
	cands:		&[String],
	stamps:		&BTreeMap<String, u64>,
	cutoff:		Option<u64>,
	claimed:	&BTreeSet<String>,
)
	-> Vec<String>
{
	unreferenced(left, cands).into_iter()
		.filter(|h| !claimed.contains(h))
		.filter(|h| match cutoff {
			None	=> true,
			Some(c)	=> stamps.get(h).map_or(false, |t| *t < c),
		})
		.collect()
}

/// The bodies on disk no manifest names that the sweep must leave: the writes in flight's.  A
/// prune weighs them against the cap as it weighs a pinned body, since they stay on disk.
pub fn staying(
	manifests:	&[(u64, Manifest)],
	held:		&[(String, u64)],
	stamps:		&BTreeMap<String, u64>,
	f:			&InFlight,
	now:		u64,
)
	-> Vec<String>
{
	let all: Vec<String> = held.iter().map(|(h, _)| h.clone()).collect();
	let free: BTreeSet<String> = sweepable(manifests, &all, stamps, sweep_cutoff(now, f), &f.claimed)
		.into_iter().collect();
	unreferenced(manifests, &all).into_iter().filter(|h| !free.contains(h)).collect()
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

/// What the store weighs on disk: every body there, named or not.
///
/// The gauge's numerator, and the bytes the cap is held against (D-26 HISTFIX2 b5): a body no
/// version names still fills the device until the sweep takes it, so the gauge shows it.  A hash
/// the manifests name and the disk does not weighs nothing -- the "not on this device" case.
pub fn disk_bytes(held: &[(String, u64)]) -> u64 {
	held.iter().map(|(_, n)| *n).fold(0u64, |a, b| a.saturating_add(b))
}


// ┌───────────────────────────────────────────────────────────────┐
// │ What a prune removed                                           │
// └───────────────────────────────────────────────────────────────┘

/// The file in `versions/` that keeps the record of each prune, newest last.
pub const PRUNE_LOG: &str = "pruned.json";

/// The most prune records [`PRUNE_LOG`] keeps; past it the oldest fold into one summary record.
pub const PRUNE_RECORDS_MAX: usize = 20;

/// The `on` of the record the oldest prune records fold into ([`prune_log_push`]).
pub const PRUNE_SUMMARY: &str = "summary";

/// The `on` of the record a prune writes BEFORE it deletes anything: what it set out to remove.
pub const PRUNE_INTENT: &str = "intent";

/// The `on` an intent record is settled to when its prune never wrote the final record
/// ([`prune_settle`]): a prune cut short, its counts those it planned.
pub const PRUNE_INTERRUPTED: &str = "interrupted";

/// The `on` of a row that records no prune but a renumbering: this device's versions filed above
/// both histories when another copy arrived holding their numbers ([`PruneRecord::renumbered`]),
/// so a jump in the numbers is said rather than read as a prune (D-26 B F2).
pub const PRUNE_RENUMBER: &str = "renumber";

/// Who a version is, whatever number it is filed at: when it was made and what its manifest says.
/// A refile changes the number and not this, so a record keyed by it cannot go stale (D-26 B F2).
pub fn version_id(m: &Manifest) -> String {
	let h = hash_of(m.to_json().as_bytes());
	fmt!("{}-{}", m.ts, &h[..h.len().min(12)])
}

/// What one prune removed.
///
/// Kept so the History can say that older versions went and when they were from, and so a later
/// reader can tell a pruned body from a lost one: the prune of 10 Oct 2026 could be explained only
/// because a scratch dump happened to exist (history_prune_diag).
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct PruneRecord {
	pub ts:       u64,		// when it ran, whole milliseconds
	pub on:       String,		// what it ran after: "record" or "arrival"
	pub versions: Vec<u64>,		// the manifests removed, oldest first
	pub ids:      Vec<String>,	// each one's version_id, beside it; "" where not known
	pub to:       Vec<u64>,		// a renumbering's new numbers, beside the old
	pub first:    u64,		// when the oldest of them was made
	pub last:     u64,		// when the newest of them was made
	pub bodies:   usize,		// bodies swept with them
	pub orphans:  usize,		// of those, bodies no manifest named before the prune
	pub bytes:    u64,		// what the swept bodies weighed
}

impl PruneRecord {

	/// The record of `plan`, run over `manifests` and the bodies `held` at `now`.
	pub fn of(plan: &Prune, manifests: &[(u64, Manifest)], held: &[(String, u64)], now: u64,
		on: &str) -> Self
	{
		Self::of_removed(&plan.manifests, &plan.bodies, manifests, held, now, on)
	}

	/// The record of a prune that removed the manifests `removed` and the bodies `swept`, of the
	/// `manifests` and bodies `held` it started from: what was actually deleted, not what was
	/// planned (D-26 A F7).
	pub fn of_removed(removed: &[u64], swept: &[String], manifests: &[(u64, Manifest)],
		held: &[(String, u64)], now: u64, on: &str) -> Self
	{
		let gone: Vec<&Manifest> = manifests.iter()
			.filter(|(n, _)| removed.contains(n))
			.map(|(_, m)| m)
			.collect();
		let all: BTreeSet<u64> = manifests.iter().map(|(n, _)| *n).collect();
		let named = live_hashes(manifests, &all);
		let mut versions: Vec<u64> = removed.to_vec();
		versions.sort();
		versions.dedup();
		let ids: Vec<String> = versions.iter()
			.map(|v| manifests.iter().find(|(n, _)| n == v)
				.map(|(_, m)| version_id(m))
				.unwrap_or_default())
			.collect();
		let swept_set: BTreeSet<&str> = swept.iter().map(|h| h.as_str()).collect();
		Self {
			ts:       now,
			on:       on.to_string(),
			versions,
			ids,
			to:       Vec::new(),
			first:    gone.iter().map(|m| m.ts).min().unwrap_or(0),
			last:     gone.iter().map(|m| m.ts).max().unwrap_or(0),
			bodies:   swept_set.len(),
			orphans:  swept_set.iter().filter(|h| !named.contains(**h)).count(),
			bytes:    held.iter()
				.filter(|(h, _)| swept_set.contains(h.as_str()))
				.map(|(_, n)| *n)
				.fold(0u64, |a, b| a.saturating_add(b)),
		}
	}

	/// The row of a refile that filed this device's versions at new numbers, `moves` being each
	/// old number and its new one, of the `manifests` as they stood before it.
	pub fn renumbered(moves: &[(u64, u64)], manifests: &[(u64, Manifest)], now: u64) -> Self {
		let mut moves: Vec<(u64, u64)> = moves.to_vec();
		moves.sort();
		moves.dedup();
		let of = |v: u64| manifests.iter().find(|(n, _)| *n == v).map(|(_, m)| m);
		let tss: Vec<u64> = moves.iter().filter_map(|(v, _)| of(*v)).map(|m| m.ts).collect();
		Self {
			ts:       now,
			on:       PRUNE_RENUMBER.to_string(),
			versions: moves.iter().map(|(v, _)| *v).collect(),
			ids:      moves.iter().map(|(v, _)| of(*v).map(version_id).unwrap_or_default()).collect(),
			to:       moves.iter().map(|(_, t)| *t).collect(),
			first:    tss.iter().copied().min().unwrap_or(0),
			last:     tss.iter().copied().max().unwrap_or(0),
			..Self::default()
		}
	}

	/// Is this a renumbering's row rather than a prune's?
	pub fn is_renumber(&self) -> bool {
		self.on == PRUNE_RENUMBER
	}

	/// Take `other` into this record, which becomes the [`PRUNE_SUMMARY`] of both; two
	/// renumbering rows fold into one renumbering row.
	fn fold(&mut self, other: &PruneRecord) {
		// Each version beside its identity and its new number, so the three stay in step.
		let mut rows: Vec<(u64, String, u64)> = Vec::new();
		for r in [&*self, other] {
			for (i, v) in r.versions.iter().enumerate() {
				rows.push((*v, r.ids.get(i).cloned().unwrap_or_default(),
					r.to.get(i).copied().unwrap_or(0)));
			}
		}
		rows.sort();
		rows.dedup();
		// A 0 is a time nobody knew, not the earliest.
		let first = [self.first, other.first].into_iter().filter(|t| *t > 0).min().unwrap_or(0);
		let renumber  = self.is_renumber() && other.is_renumber();
		self.ts       = self.ts.max(other.ts);
		self.on       = if renumber { PRUNE_RENUMBER } else { PRUNE_SUMMARY }.to_string();
		self.versions = rows.iter().map(|(v, _, _)| *v).collect();
		self.ids      = rows.iter().map(|(_, i, _)| i.clone()).collect();
		self.to       = if renumber { rows.iter().map(|(_, _, t)| *t).collect() } else { Vec::new() };
		self.first    = first;
		self.last     = self.last.max(other.last);
		self.bodies   = self.bodies.saturating_add(other.bodies);
		self.orphans  = self.orphans.saturating_add(other.orphans);
		self.bytes    = self.bytes.saturating_add(other.bytes);
	}

	pub fn to_json(&self) -> String {
		let vs: Vec<String> = self.versions.iter().map(|v| fmt!("{}", v)).collect();
		let ids: Vec<String> = self.ids.iter().map(|i| fmt!("\"{}\"", json_escape(i))).collect();
		let to = if self.to.is_empty() { String::new() } else {
			let t: Vec<String> = self.to.iter().map(|v| fmt!("{}", v)).collect();
			fmt!(",\"to\":[{}]", t.join(","))
		};
		fmt!("{{\"ts\":{},\"on\":\"{}\",\"versions\":[{}],\"ids\":[{}]{},\"first\":{},\"last\":{},\
			\"bodies\":{},\"orphans\":{},\"bytes\":{}}}", self.ts, json_escape(&self.on),
			vs.join(","), ids.join(","), to, self.first, self.last, self.bodies, self.orphans,
			self.bytes)
	}

	fn from_json(s: &str) -> Self {
		let nums = |key: &str| -> Vec<u64> { array_inside(s, key)
			.map(|a| a.split(',').filter_map(|v| v.trim().parse::<u64>().ok()).collect())
			.unwrap_or_default() };
		let versions = nums("versions");
		let mut ids: Vec<String> = array_inside(s, "ids")
			.filter(|a| !a.trim().is_empty())
			.map(|a| a.split(',').map(|i| i.trim().trim_matches('"').to_string()).collect())
			.unwrap_or_default();
		// A record from before identities, or one that does not line up, keys by number alone.
		if ids.len() != versions.len() {
			ids = vec![String::new(); versions.len()];
		}
		let mut to = nums("to");
		if to.len() != versions.len() {
			to = Vec::new();
		}
		Self {
			ts:       extract_json_number(s, "ts").unwrap_or(0),
			on:       extract_json_string(s, "on").unwrap_or_default(),
			versions,
			ids,
			to,
			first:    extract_json_number(s, "first").unwrap_or(0),
			last:     extract_json_number(s, "last").unwrap_or(0),
			bodies:   extract_json_number(s, "bodies").unwrap_or(0) as usize,
			orphans:  extract_json_number(s, "orphans").unwrap_or(0) as usize,
			bytes:    extract_json_number(s, "bytes").unwrap_or(0),
		}
	}
}

/// The records a [`PRUNE_LOG`] holds, oldest first; nothing where it will not read.
pub fn prune_log_read(json: &str) -> Vec<PruneRecord> {
	objects_in(json).into_iter().map(PruneRecord::from_json).collect()
}

/// `json`'s records with `rec` added, as the file to write.
///
/// The log is bounded by folding, never by dropping (D-26 A F6, B F1): past [`PRUNE_RECORDS_MAX`]
/// the second-oldest record folds into the oldest, a running [`PRUNE_SUMMARY`], so every version a
/// prune removed stays named by some row.
pub fn prune_log_push(json: &str, rec: &PruneRecord) -> String {
	let mut all = prune_log_read(json);
	all.push(rec.clone());
	prune_log_json(all)
}

/// `recs` as the file to write: a version a record already names is not named again, and the
/// prune rows and the renumbering rows are each folded to at most [`PRUNE_RECORDS_MAX`].
///
/// **A version is named by who it is, not its number** ([`version_id`]): a copy of a pruned
/// version that arrives and is pruned again was already recorded, and gets no second row
/// (D-26 B F2).  A record with no identities keys by nothing and is kept whole.
pub fn prune_log_json(recs: Vec<PruneRecord>) -> String {
	let mut seen_p: BTreeSet<String> = BTreeSet::new();
	let mut seen_r: BTreeSet<String> = BTreeSet::new();
	let mut prunes: Vec<PruneRecord> = Vec::new();
	let mut renums: Vec<PruneRecord> = Vec::new();
	for mut r in recs.into_iter() {
		let had = !r.versions.is_empty();
		let seen = if r.is_renumber() { &mut seen_r } else { &mut seen_p };
		let keep: Vec<bool> = r.ids.iter().map(|i| i.is_empty() || seen.insert(i.clone())).collect();
		if keep.iter().any(|k| !k) {
			let pick = |xs: &Vec<u64>| -> Vec<u64> { xs.iter().zip(keep.iter())
				.filter(|(_, k)| **k).map(|(x, _)| *x).collect() };
			r.versions = pick(&r.versions);
			if !r.to.is_empty() {
				r.to = pick(&r.to);
			}
			r.ids = r.ids.iter().zip(keep.iter()).filter(|(_, k)| **k).map(|(i, _)| i.clone()).collect();
			// Everything it named is named already; its bodies were counted where they went.
			if had && r.versions.is_empty() {
				continue;
			}
		}
		if r.is_renumber() { renums.push(r); } else { prunes.push(r); }
	}
	for list in [&mut prunes, &mut renums] {
		while list.len() > PRUNE_RECORDS_MAX {
			let next = list.remove(1);
			list[0].fold(&next);
		}
	}
	let mut all: Vec<PruneRecord> = prunes;
	all.extend(renums.into_iter());
	all.sort_by_key(|r| r.ts);
	let rows: Vec<String> = all.iter().map(|r| r.to_json()).collect();
	fmt!("[{}]", rows.join(","))
}

/// `json` after a refile filed this device's versions at new numbers, `moves` being each old
/// number and its new one: every prune record names what it removed at the number that version
/// now stands at, and one [`PRUNE_RENUMBER`] row, `row`, says the move (D-26 B F2).  Without the
/// first, a record named a number that now holds nothing, or another device's version.
pub fn prune_log_refiled(json: &str, moves: &[(u64, u64)], row: &PruneRecord) -> String {
	let map: std::collections::BTreeMap<u64, u64> = moves.iter().copied().collect();
	let mut all = prune_log_read(json);
	for r in all.iter_mut().filter(|r| !r.is_renumber()) {
		for v in r.versions.iter_mut() {
			if let Some(to) = map.get(v) {
				*v = *to;
			}
		}
	}
	if !row.versions.is_empty() {
		all.push(row.clone());
	}
	prune_log_json(all)
}

/// The rows History draws from `recs`: a pruned version that came back -- a copy arrived holding
/// it, so `held` has it again -- is not shown as gone, and a row left naming nothing is not shown.
/// The log itself keeps saying it was pruned; this is what is true now.
pub fn prune_shown(recs: Vec<PruneRecord>, held: &[(u64, Manifest)]) -> Vec<PruneRecord> {
	let here: BTreeSet<String> = held.iter().map(|(_, m)| version_id(m)).collect();
	recs.into_iter().filter_map(|mut r| {
		if r.is_renumber() || r.versions.is_empty() {
			return Some(r);
		}
		let keep: Vec<bool> = r.ids.iter().map(|i| i.is_empty() || !here.contains(i)).collect();
		if keep.iter().all(|k| *k) {
			return Some(r);
		}
		r.versions = r.versions.iter().zip(keep.iter()).filter(|(_, k)| **k).map(|(v, _)| *v).collect();
		r.ids = r.ids.iter().zip(keep.iter()).filter(|(_, k)| **k).map(|(i, _)| i.clone()).collect();
		if r.versions.is_empty() { None } else { Some(r) }
	}).collect()
}

/// This device's [`PRUNE_LOG`] `mine` joined with `theirs`, arriving with another copy, as the
/// file to write: never one laid over the other (D-26 A F5, B F2).
///
/// Every record of this device's stays, summaries and interrupted ones included.  Of the
/// arriving ones, an intent goes -- its prune ran, or did not, on the other device, and only that
/// device can settle it -- and one this device already holds, by its time, kind and versions, is
/// not held twice.  The rest join in time order, and [`prune_log_json`] drops any version already
/// named and folds past the bound.
pub fn prune_log_merge(mine: &str, theirs: &str) -> String {
	let mut all = prune_log_read(mine);
	let key = |r: &PruneRecord| (r.ts, r.on.clone(), r.versions.clone(), r.ids.clone());
	let have: BTreeSet<(u64, String, Vec<u64>, Vec<String>)> = all.iter().map(key).collect();
	for r in prune_log_read(theirs).into_iter() {
		if r.on == PRUNE_INTENT || have.contains(&key(&r)) {
			continue;
		}
		all.push(r);
	}
	all.sort_by_key(|r| r.ts);
	prune_log_json(all)
}

/// `json` with its [`PRUNE_INTENT`] record at `ts` replaced by `fin`, the record of what that
/// prune actually removed; a prune that removed nothing leaves no record at all.
pub fn prune_log_finish(json: &str, ts: u64, fin: &PruneRecord) -> String {
	let mut all: Vec<PruneRecord> = prune_log_read(json).into_iter()
		.filter(|r| !(r.on == PRUNE_INTENT && r.ts == ts))
		.collect();
	if !fin.versions.is_empty() || fin.bodies > 0 {
		all.push(fin.clone());
	}
	prune_log_json(all)
}

/// `recs` with every [`PRUNE_INTENT`] left by a prune that never finished settled against the
/// manifests still `present`: it names only the versions that are gone, as
/// [`PRUNE_INTERRUPTED`], and goes where it names none.  Whether it changed anything comes back
/// with it, so a caller writes only a log that moved.
pub fn prune_settle(recs: Vec<PruneRecord>, present: &BTreeSet<u64>) -> (Vec<PruneRecord>, bool) {
	let mut moved = false;
	let mut out = Vec::with_capacity(recs.len());
	for mut r in recs.into_iter() {
		if r.on != PRUNE_INTENT {
			out.push(r);
			continue;
		}
		moved = true;
		r.versions.retain(|v| !present.contains(v));
		r.on = PRUNE_INTERRUPTED.to_string();
		if !r.versions.is_empty() {
			out.push(r);
		}
	}
	(out, moved)
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
	// A newline ends a line rather than starting one, so neither `""` (a new or deleted file)
	// nor a final `\n` (nearly every file) may count as a blank line of its own: unguarded, a
	// three-line file written with its final newline read as +4.
	fn lines(t: &str) -> Vec<&str> {
		let mut v: Vec<&str> = t.split('\n').collect();
		if t.is_empty() || t.ends_with('\n') {
			v.pop();
		}
		v
	}
	let a = lines(before);
	let b = lines(after);
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

/// The whole of `"key":{ … }`, braces included, or `None` where the key names no object.
///
/// String-aware like [`array_inside`], so a model string or a run id holding a brace does not end
/// the object early.
fn object_inside<'a>(json: &'a str, key: &str) -> Option<&'a str> {
	let needle = fmt!("\"{}\":", key);
	let mut i = match json.find(&needle) {
		Some(p)	=> p + needle.len(),
		None	=> return None,
	};
	let bytes = json.as_bytes();
	while i < bytes.len() && bytes[i].is_ascii_whitespace() {
		i += 1;
	}
	if i >= bytes.len() || bytes[i] != b'{' {
		return None;
	}
	objects_in(&json[i..]).into_iter().next()
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


/// The version a `file_revert` of one half of a crystal goes back to, read off that half's chain.
///
/// The crystal's two files are not rows in the files store: their history is the crystal chain,
/// `versions/NNNN.json|html`, written at turn end. `snaps` is the half's snapshot numbers, `head`
/// the version the Diamond is at, and `moved` whether the file on disk differs from the half at
/// `head` -- a write this turn made. A moved file goes back to `head`; one that stands as recorded
/// goes back to the version before the newest snapshot that changed it. `None` where nothing
/// earlier was ever recorded.
pub fn chain_undo_version(snaps: &[u64], head: u64, moved: bool) -> Option<u64> {
	if moved {
		return Some(head);
	}
	match snaps.iter().copied().filter(|n| *n <= head).max() {
		Some(n) if n > 0	=> Some(n - 1),
		_			=> None,	// first recorded at 0, or never
	}
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

	const HOME: &str = "diamonds/t";			// the keeper every test manifest belongs to
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
		// Room for three bodies of seven at the low-water mark (1_200): inside the hold both
		// deletions stay, whatever else goes.
		let caps = Caps { bytes: 1_334, manifests: MANIFESTS_MAX };
		let plan = prune_plan(&ms, &held, &[], caps, TS + 1_000, HOME, &BTreeSet::new());
		assert!(!plan.manifests.contains(&1) && !plan.manifests.contains(&2),
			"a deletion inside its hold was pruned: {:?}", plan.manifests);
		assert!(!plan.bodies.contains(&hash_of(b"A1")), "a deleted file's copy was swept");
		assert_eq!(vec![3, 4], plan.manifests, "the ordinary versions go first, a save last of them");
		// Past the hold, a deletion is still the LAST to go: after a Save.
		let later = prune_plan(&ms, &held, &[], caps, LATER, HOME, &BTreeSet::new());
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
		let plan = prune_plan(&ms, &held, &[], caps, TS + 1_000, HOME, &BTreeSet::new());
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
		let later = prune_plan(&ms, &held, &[], roomier, LATER, HOME, &BTreeSet::new());
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
		// Room for the newest and one other version's pair of bodies at the low-water mark (400).
		let plan = prune_plan(&ms, &held, &[], Caps { bytes: 445, manifests: MANIFESTS_MAX }, LATER, "diamonds/d1", &BTreeSet::new());
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
		let plan = prune_plan(&ms, &held, &pin, Caps { bytes: 100, manifests: MANIFESTS_MAX }, LATER, HOME, &BTreeSet::new());
		assert!(plan.bodies.is_empty(), "a pending copy was swept: {:?}", plan.bodies);
		let bare = prune_plan(&ms, &held, &[], Caps { bytes: 100, manifests: MANIFESTS_MAX }, LATER, HOME, &BTreeSet::new());
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

	/// **A row names the agent that wrote it, and a row written before it could still reads.**  The
	/// author is nested and last, so an entry without one is the entry an older build wrote, and an
	/// author whose strings hold braces and quotes does not cut the row short.
	#[test]
	fn test_an_entry_carries_its_author_and_one_without_still_parses_00() -> Outcome<()> {
		let mut worker = e("notes/a.md", "new\n", Some("old\n"));
		worker.by = Some(Author {
			role: "worker".to_string(),
			m:    "accounts/fireworks/models/glm-5p2".to_string(),
			pv:   "fireworks".to_string(),
			sp:   "sp1:3f9a0c12".to_string(),
			run:  "w-{7}\"x\"".to_string(),
			via:  String::new(),
		});
		let mut daimon = e("crystal.md", "c", None);
		daimon.by = Some(Author { role: "daimon".to_string(), m: "glm-5".to_string(),
			..Default::default() });
		let walked = e("out/log.txt", "ran", None);
		let want = Manifest::new(Cause::Turn, 17, "m_1", "", vec![worker.clone(), daimon, walked]);
		let json = want.to_json();
		let got = res!(Manifest::from_json(&json));
		assert_eq!(want, got);
		assert_eq!(got.files[0].by.as_ref().map(|a| a.run.as_str()), Some("w-{7}\"x\""));
		assert_eq!(got.files[2].by, None);
		// The author follows every field an older reader looks for.
		let row = worker.to_json();
		assert!(row.ends_with(&fmt!(",\"by\":{}}}", worker.by.as_ref().map(|a| a.to_json())
			.unwrap_or_default())), "{}", row);
		// A manifest from before authors parses as it always did.
		let old = r#"{"v":1,"ts":5,"cause":"turn","turn":"","note":"","files":[{"path":"a.md","hash":"h","bytes":1}]}"#;
		let got = res!(Manifest::from_json(old));
		assert_eq!(got.files.len(), 1);
		assert_eq!(got.files[0].by, None);
		assert_eq!(got.files[0].path, "a.md");
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
		let at3 = state_at(&ms, 3, |_| None, |_| false);
		let a = at3.iter().find(|(p, _)| p == "a.md").map(|(_, s)| s.clone());
		assert_eq!(Some(hash_of(b"two")), a.and_then(|s| s.hash().map(|h| h.to_string())));
		// Named at 5 and so present in the union, and Gone as at 3 -- which is what makes a
		// whole-version restore able to REMOVE it.
		let b = at3.iter().find(|(p, _)| p == "b.md").map(|(_, s)| s.clone());
		assert_eq!(Some(At::Gone { mark: false, folder: None }), b);
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
		assert!(matches!(path_at(&ms, "a.md", 1, None), Some(At::Held { .. })));
		assert_eq!(Some(At::Gone { mark: false, folder: None }), path_at(&ms, "a.md", 3, None));
		assert_eq!(Some(hash_of(b"three")),
			path_at(&ms, "a.md", 9, None).and_then(|s| s.hash().map(|h| h.to_string())));
		assert_eq!(None, path_at(&ms, "never.md", 9, None));
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
			path_at(&ms, "live/site.txt", 3, None).and_then(|s| s.hash().map(|h| h.to_string())));
		// And the EARLIEST later entry, not whichever one came to hand: v6's `was` is v2, which
		// is a state that did exist -- but not at 3.
		assert_eq!(Some(hash_of(b"v2 by the daimon")),
			path_at(&ms, "live/site.txt", 4, None).and_then(|s| s.hash().map(|h| h.to_string())));
		// A file this store first saw being CREATED did not exist before it, and answering with
		// an older version would restore a state the user never saw.
		let made = vec![(4, m(Cause::Turn, vec![e("notes/new.md", "born here", None)]))];
		assert_eq!(None, path_at(&made, "notes/new.md", 3, None));
		// A path no manifest has ever named is still nothing at all.
		assert_eq!(None, path_at(&ms, "never.md", 3, None));
		// THE SNAPSHOT ANSWERS THE SAME (F5, 2026-09-25): a whole-version restore to 3 puts the
		// file back as it stood, and does not take it to have been absent.
		let at3 = state_at(&ms, 3, |_| None, |_| false);
		assert_eq!(Some(hash_of(b"v1 on the site")), at3.iter().find(|(p, _)| p == "live/site.txt")
			.and_then(|(_, s)| s.hash().map(|h| h.to_string())));
	}

	/// **A whole-version restore never takes a marked file the store met later to be absent.**
	///
	/// F5 (2026-09-25): two files in the user's open folder, marked in, edited by a turn after a
	/// version that never named them.  `state_at` answered both `Gone`, and the restore deleted
	/// them off the folder.  Their earliest later entries carry `was`, so they stood, and a marked
	/// path that really was created later is `Gone` WITH its mark, for the fenced door to take.
	#[test]
	fn test_state_at_seeds_a_path_from_its_earliest_later_entry() {
		let mut one = e("vault/w/one.md", "turn one", Some("orig one"));
		one.mark = true;
		let mut two = e("vault/w/two.md", "turn two", Some("orig two"));
		two.mark = true;
		let mut born = e("vault/w/born.md", "born", None);
		born.mark = true;
		let mut born2 = e("vault/w/born.md", "born again", Some("born"));
		born2.mark = true;
		let ms = vec![
			(1, m(Cause::Save, vec![e("diamonds/d/notes.md", "notes", None)])),
			(2, m(Cause::Turn, vec![one, two, born])),
			(3, m(Cause::Turn, vec![born2])),
		];
		let at1 = state_at(&ms, 1, |_| None, |_| false);
		let get = |p: &str| at1.iter().find(|(q, _)| q == p).map(|(_, s)| s.clone());
		for (p, was) in [("vault/w/one.md", "orig one"), ("vault/w/two.md", "orig two")] {
			let s = get(p);
			assert_eq!(Some(hash_of(was.as_bytes())), s.as_ref().and_then(|s| s.hash().map(|h| h.to_string())), "{}", p);
			assert!(s.map(|s| s.mark()).unwrap_or(false), "{} keeps its mark", p);
		}
		// Created at 2, so absent at 1 -- and marked, so the caller's fenced door removes it.
		// v3's `was` is v2's body, a state that did exist, but not at 1.
		assert_eq!(Some(At::Gone { mark: true, folder: None }), get("vault/w/born.md"));
		assert_eq!(None, path_at(&ms, "vault/w/born.md", 1, None));
		// And the per-path answer is the snapshot's answer, path for path.
		for (p, s) in at1.iter() {
			match path_at(&ms, p, 1, None) {
				Some(q) => assert_eq!(&q, s, "{}", p),
				None    => assert!(matches!(s, At::Gone { .. }), "{}", p),
			}
		}
	}

	#[test]
	fn test_undo_of_a_path_goes_to_what_stood_before_its_newest_change() {
		let ms = vec![
			(1, m(Cause::Turn, vec![e("a.md", "one", None)])),
			(3, m(Cause::Turn, vec![e("a.md", "two", Some("one"))])),
		];
		assert_eq!(Some((3, hash_of(b"one"), None)), undo_target(&ms, "a.md", None, |_| false));
		// A file this store first saw as a creation has nothing to go back to, and an older
		// version is not an answer to a question about a state the user never saw.
		let fresh = vec![(1, m(Cause::Turn, vec![e("new.md", "x", None)]))];
		assert_eq!(None, undo_target(&fresh, "new.md", None, |_| false));
	}

	/// **The Undo of a version puts back what that version replaced, not the version before it.**
	///
	/// U1 of the release 5.1 fix's second QA (2026-09-25): turn one writes a.md, the person saves
	/// it, turn two edits it.  The Undo of turn two answered `path_at(1)`, turn one's text, and the
	/// person's save was left as a `was` nothing restores.  Row two's own `was` is their save.
	#[test]
	fn test_the_undo_of_a_version_puts_back_its_own_rows_was() {
		let mut born = e("vault/u/born.md", "born", None);
		born.mark = true;
		let mut edited = e("vault/u/a.md", "turn two", Some("the person's save"));
		edited.mark = true;
		// The person's save between the turns is no row of its own: turn two's capture of what it
		// found is the only place it is kept.
		let ms = vec![
			(1, m(Cause::Turn, vec![e("vault/u/a.md", "turn one", Some("orig"))])),
			(3, m(Cause::Turn, vec![edited, born, gone("diamonds/d/old.md", "old notes")])),
			(4, m(Cause::Turn, vec![e("vault/u/a.md", "turn three", Some("turn two"))])),
		];
		let all = undo_of(&ms, 3, &[], |_| None);
		let get = |p: &str| all.iter().find(|(q, _)| q == p).map(|(_, s)| s.clone());
		assert_eq!(Some(hash_of(b"the person's save")),
			get("vault/u/a.md").and_then(|s| s.hash().map(|h| h.to_string())),
			"the undo went back past the person's save");
		// The old answer, for the record: the state at the version before, turn one's text.
		assert_eq!(Some(hash_of(b"turn one")),
			path_at(&ms, "vault/u/a.md", 3 - 1, None).and_then(|s| s.hash().map(|h| h.to_string())));
		// A file the version made is taken away again, with its mark, for the person's yes.
		assert_eq!(Some(At::Gone { mark: true, folder: None }), get("vault/u/born.md"));
		// A file it deleted comes back.
		assert_eq!(Some(hash_of(b"old notes")),
			get("diamonds/d/old.md").and_then(|s| s.hash().map(|h| h.to_string())));
		assert_eq!(3, all.len(), "only the paths version 3 changed");
		// Named paths: only those.
		let one = undo_of(&ms, 3, &["vault/u/born.md".to_string()], |_| None);
		assert_eq!(vec![("vault/u/born.md".to_string(), At::Gone { mark: true, folder: None })], one);
		// A record split past one version: a named path met first after `of` answers that row.
		let split = vec![
			(5, m(Cause::Turn, vec![e("x.md", "x after", Some("x before"))])),
			(6, m(Cause::Turn, vec![e("y.md", "y after", Some("y before"))])),
		];
		let both = undo_of(&split, 5, &["x.md".to_string(), "y.md".to_string()], |_| None);
		assert_eq!(Some(hash_of(b"y before")), both.iter().find(|(p, _)| p == "y.md")
			.and_then(|(_, s)| s.hash().map(|h| h.to_string())));
		// Unnamed, the version alone.
		assert_eq!(1, undo_of(&split, 5, &[], |_| None).len());
		// Nothing at or after `of` names it: nothing to put back.
		assert!(undo_of(&ms, 5, &["vault/u/a.md".to_string()], |_| None).is_empty());
	}

	#[test]
	fn test_the_index_is_the_newest_hash_of_every_path_and_needs_no_file() {
		let ms = vec![
			(1, m(Cause::Turn, vec![e("a.md", "one", None), e("b.md", "bee", None)])),
			(3, m(Cause::User, vec![e("a.md", "two", Some("one"))])),
		];
		let ix = index_placed(&ms);
		assert_eq!(Some(hash_of(b"two")), indexed_was(&ix, "a.md", None));
		assert_eq!(Some(hash_of(b"bee")), indexed_was(&ix, "b.md", None));
		assert_eq!(None, indexed_was(&ix, "c.md", None));
	}

	/// A row in a folder, as a record stamps it (HR).
	fn e_in(path: &str, body: &str, was: Option<&str>, folder: Option<&str>) -> Entry {
		let mut x = e(path, body, was);
		x.folder = folder.map(|f| f.to_string());
		x
	}

	/// **A relative row goes back only into the folder it was written in** (HR, 2026-09-25).  A row
	/// written in browser storage, or in one opened folder, was put back through whatever the path
	/// reached at the restore -- a hand's folder, another opened folder -- over a different file of
	/// the same name.  A machine row lands only at its own absolute path; a row from before folders
	/// were recorded is asked about wherever it would replace other bytes.
	#[test]
	fn test_a_row_goes_back_only_into_the_folder_it_was_written_in_00() {
		let f1 = "0123456789abcdef0123456789abcdef";
		let f2 = "fedcba9876543210fedcba9876543210";
		// The same folder: go.
		assert_eq!(Route::Go, route("proj/x.md", Some(BROWSER_FOLDER), "proj/x.md", Some(BROWSER_FOLDER), false, true));
		assert_eq!(Route::Go, route("proj/x.md", Some(f1), "proj/x.md", Some(f1), true, true));
		// Another folder this device knows, whatever stands there: left.
		assert_eq!(Route::Left, route("proj/x.md", Some(f1), "proj/x.md", Some(f2), true, false));
		assert_eq!(Route::Left, route("proj/x.md", Some(f1), "proj/x.md", Some(f2), true, true));
		// Browser storage and a folder, known or not: left, both ways.
		assert_eq!(Route::Left, route("proj/x.md", Some(BROWSER_FOLDER), "proj/x.md", Some(f1), false, false));
		assert_eq!(Route::Left, route("proj/x.md", Some(f1), "proj/x.md", Some(BROWSER_FOLDER), true, true));
		assert_eq!(Route::Left, route("proj/x.md", Some(f1), "proj/x.md", Some(BROWSER_FOLDER), false, true));
		// A relative row reaching the machine through a hand: left, folder recorded or not.
		assert_eq!(Route::Left, route("proj/x.md", Some(BROWSER_FOLDER), "/home/u/g/proj/x.md", None, false, false));
		assert_eq!(Route::Left, route("proj/x.md", None, "/home/u/g/proj/x.md", None, false, false));
		// A machine row lands at its own absolute path and nowhere else.
		assert_eq!(Route::Go, route("/home/u/g/proj/x.md", None, "/home/u/g/proj/x.md", None, false, true));
		assert_eq!(Route::Left, route("/home/u/g/proj/x.md", None, "/home/u/g2/proj/x.md", None, false, false));
		assert_eq!(Route::Left, route("/home/u/g/proj/x.md", None, "proj/x.md", Some(f1), false, false));
		// From before folders were recorded: asked only over different bytes.
		assert_eq!(Route::Ask(Unplaced::Unrecorded), route("proj/x.md", None, "proj/x.md", Some(f1), true, true));
		assert_eq!(Route::Go, route("proj/x.md", None, "proj/x.md", Some(f1), true, false));
		// The store's own paths are one place from every folder.
		assert!(!needs_folder("diamonds/abc/notes.md"));
		assert!(!needs_folder("/home/u/g/x.md"));
		assert!(needs_folder("proj/x.md"));
		assert_eq!(Route::Go, route("diamonds/abc/notes.md", None, "diamonds/abc/notes.md", None, false, true));
	}

	/// The folder travels with the row, and a build that has never heard of it reads the row as one
	/// from before folders were recorded.
	#[test]
	fn test_a_rows_folder_round_trips_and_answers_with_its_state_00() {
		let f1 = "0123456789abcdef0123456789abcdef";
		let row = e_in("proj/x.md", "one", None, Some(f1));
		let mf = Manifest::new(Cause::User, TS, "", "", vec![row.clone(), e("a.md", "a", None)]);
		let back = res_ok(Manifest::from_json(&mf.to_json()));
		assert_eq!(Some(f1.to_string()), back.files[0].folder);
		assert_eq!(None, back.files[1].folder);
		assert!(!mf.to_json().contains("\"folder\":\"\""), "an empty folder is never written");
		let ms = vec![
			(1, Manifest::new(Cause::User, TS, "", "", vec![row])),
			(2, Manifest::new(Cause::Turn, TS, "", "", vec![e_in("proj/x.md", "two", Some("one"), Some(f1))])),
		];
		let at1 = path_at(&ms, "proj/x.md", 1, None);
		assert_eq!(Some(f1), at1.as_ref().and_then(|a| a.folder()));
		assert_eq!(Some(f1), undo_of(&ms, 2, &[], |_| None)[0].1.folder());
		assert_eq!(Some((2, hash_of(b"one"), Some(f1.to_string()))), undo_target(&ms, "proj/x.md", None, |_| true));
		// A change in another folder takes no `was` from this folder's row; one in the same folder,
		// or one that does not say, does.
		let ix = index_placed(&ms);
		assert_eq!(None, indexed_was(&ix, "proj/x.md", Some(BROWSER_FOLDER)));
		assert_eq!(Some(hash_of(b"two")), indexed_was(&ix, "proj/x.md", Some(f1)));
		assert_eq!(Some(hash_of(b"two")), indexed_was(&ix, "proj/x.md", None));
	}

	/// **A row whose folder this device cannot name is placed as a row from before folders**
	/// (HX1 and HX2 of HR's QA, 2026-09-25).  A folder's id is the picking device's own, so a row
	/// from another device's folder, a moved or renamed one, or one picked again after "Forget",
	/// was left by every route, silently, for good.  Two folders opened with no id were one place,
	/// and a row of one went over a different file in the other unasked.  Both now go back where
	/// nothing stands or the same bytes do, and ask over different bytes; a folder this device
	/// knows is still left.
	#[test]
	fn test_a_row_from_a_folder_this_device_cannot_name_is_asked_about_not_left_00() {
		let theirs = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";	// picked on another device
		let here = "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2";
		// Not known here: asked over different bytes, and put back where it replaces nothing.
		assert_eq!(Route::Ask(Unplaced::Unknown), route("proj/x.md", Some(theirs), "proj/x.md", Some(here), false, true));
		assert_eq!(Route::Go, route("proj/x.md", Some(theirs), "proj/x.md", Some(here), false, false));
		// Known here: another folder's file, left.
		assert_eq!(Route::Left, route("proj/x.md", Some(theirs), "proj/x.md", Some(here), true, true));
		// Still never into browser storage, nor onto the machine.
		assert_eq!(Route::Left, route("proj/x.md", Some(theirs), "proj/x.md", Some(BROWSER_FOLDER), false, true));
		assert_eq!(Route::Left, route("proj/x.md", Some(theirs), "/home/u/proj/x.md", None, false, false));
		// Two folders with no id are not one place: asked, never assumed the same.
		assert_eq!(Route::Ask(Unplaced::Unknown), route("proj/x.md", Some(UNNAMED_FOLDER), "proj/x.md", Some(UNNAMED_FOLDER), false, true));
		assert_eq!(Route::Go, route("proj/x.md", Some(UNNAMED_FOLDER), "proj/x.md", Some(UNNAMED_FOLDER), false, false));
		// A known folder's row, with a folder open that has no id (it may be that very folder).
		assert_eq!(Route::Ask(Unplaced::Unknown), route("proj/x.md", Some(here), "proj/x.md", Some(UNNAMED_FOLDER), true, true));
		// And an unnamed folder's row in a named one.
		assert_eq!(Route::Ask(Unplaced::Unknown), route("proj/x.md", Some(UNNAMED_FOLDER), "proj/x.md", Some(here), false, true));
	}

	/// **A path's history is read in the folder it reaches** (HX3 of HR's QA, 2026-09-25).  One
	/// path with rows from browser storage and from F1: a whole-version Restore in F1 resolved the
	/// later row, browser storage's, and left F1's own; and a delete in F1 that kept no bytes found
	/// F2's newer row, refused its hash, and was never recorded.
	#[test]
	fn test_each_folder_resolves_its_own_rows_of_a_path_00() {
		let f1 = "0123456789abcdef0123456789abcdef";
		let f2 = "fedcba9876543210fedcba9876543210";
		let mut browser_row = e_in("proj/x.md", "", Some("browser before"), Some(BROWSER_FOLDER));
		browser_row.hash = String::new();
		browser_row.skipped = Some("folder".to_string());
		// PF: one record took F1's row and browser storage's, browser storage's second.
		let ms = vec![
			(2, Manifest::new(Cause::User, TS, "", "", vec![e_in("proj/x.md", "f1 save", None, Some(f1)), browser_row])),
			(3, Manifest::new(Cause::User, TS, "", "", vec![e_in("proj/x.md", "f1 later", Some("f1 save"), Some(f1))])),
		];
		let in_f1 = |_: &str| Some(f1.to_string());
		let mine = |_: &str| true;	// this device picked both folders
		let whole = state_at(&ms, 2, in_f1, mine);
		assert_eq!(Some(hash_of(b"f1 save")), whole[0].1.hash().map(String::from), "F1's own row at v2");
		assert_eq!(Some(f1), whole[0].1.folder());
		// Browser storage's own row at v2, from browser storage.
		let whole_b = state_at(&ms, 2, |_| Some(BROWSER_FOLDER.to_string()), mine);
		assert_eq!(Some(BROWSER_FOLDER), whole_b[0].1.folder());
		// A row's own Restore puts back the row named, whichever folder is open.
		assert_eq!(Some(f1), path_at(&ms, "proj/x.md", 2, Some(f1)).as_ref().and_then(|a| a.folder()));
		assert_eq!(Some(BROWSER_FOLDER), path_at(&ms, "proj/x.md", 2, Some(BROWSER_FOLDER)).as_ref().and_then(|a| a.folder()));
		// The Undo of v2 in F1 is F1's row's.
		let undo = undo_of(&ms, 2, &[], in_f1);
		assert_eq!(Some(f1), undo[0].1.folder());
		// A folder with no rows of the path resolves another's, which the restore then routes.
		assert_eq!(Some(f1), state_at(&ms, 3, |_| Some(f2.to_string()), mine)[0].1.folder());
		// IX: F1's row, then F2's; a change in F1 with no bytes takes F1's newest as its `was`.
		let ix_ms = vec![
			(2, Manifest::new(Cause::User, TS, "", "", vec![e_in("proj/y.md", "in f1", None, Some(f1))])),
			(3, Manifest::new(Cause::User, TS, "", "", vec![e_in("proj/y.md", "in f2", None, Some(f2))])),
		];
		let ix = index_placed(&ix_ms);
		assert_eq!(Some(hash_of(b"in f1")), indexed_was(&ix, "proj/y.md", Some(f1)));
		assert_eq!(Some(hash_of(b"in f2")), indexed_was(&ix, "proj/y.md", Some(f2)));
		assert_eq!(None, indexed_was(&ix, "proj/y.md", Some(BROWSER_FOLDER)));
		assert_eq!(Some(hash_of(b"in f2")), indexed_was(&ix, "proj/y.md", None), "no folder: the newest anywhere");
		// A row from before folders counts as every folder's, and a newer delete in F1 ends it.
		let mut gone_f1 = e_in("proj/z.md", "", Some("old"), Some(f1));
		gone_f1.gone = true;
		gone_f1.hash = String::new();
		let old = vec![
			(1, Manifest::new(Cause::User, TS, "", "", vec![e("proj/z.md", "old", None)])),
			(4, Manifest::new(Cause::User, TS, "", "", vec![gone_f1])),
		];
		let ix = index_placed(&old);
		assert_eq!(Some(hash_of(b"old")), indexed_was(&ix, "proj/z.md", Some(f2)));
		assert_eq!(None, indexed_was(&ix, "proj/z.md", Some(f1)));
		// The file-revert target is the newest change in the folder the path reaches.
		assert_eq!(Some((3, hash_of(b"f1 save"), Some(f1.to_string()))), undo_target(&ms, "proj/x.md", Some(f1), mine));
		assert_eq!(Some((2, hash_of(b"browser before"), Some(BROWSER_FOLDER.to_string()))),
			undo_target(&ms, "proj/x.md", Some(BROWSER_FOLDER), mine));
	}

	/// **A row from a folder this device cannot name answers beside the open folder's own** (HQ1 of
	/// HR's QA round 2, 2026-09-27).  HX3 kept only the open folder's rows once it had any, so over
	/// the sync a whole Restore on A to B's version put back A's own older row, and on B to A's
	/// newer version B's own; after "Forget" and a re-pick, the Restore of a version recorded under
	/// the old id put back the new id's first `was`.  Each went back unasked, since the route saw
	/// the open folder's own row.  Now the rows that answer are exactly those the route does not
	/// leave, and a folder this device knows is still another folder.
	#[test]
	fn test_a_row_from_a_folder_this_device_cannot_name_answers_beside_its_own_00() {
		let fa = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";	// A's folder
		let fb = "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2";	// B's folder
		let on = |f: &'static str| move |_: &str| Some(f.to_string());
		let knows = |f: &'static str| move |id: &str| id == f;
		// TS: A saves A1 (v2), B saves B1 over it (v3), A saves A2 (v4); one project, two devices.
		let ts = vec![
			(2, Manifest::new(Cause::User, TS, "", "", vec![e_in("proj/x.md", "A1", None, Some(fa))])),
			(3, Manifest::new(Cause::User, TS, "", "", vec![e_in("proj/x.md", "B1", Some("A1"), Some(fb))])),
			(4, Manifest::new(Cause::User, TS, "", "", vec![e_in("proj/x.md", "A2", Some("B1"), Some(fa))])),
		];
		// TS1: on A, the whole Restore to v3 is B's row, asked about over A2.
		let a3 = state_at(&ts, 3, on(fa), knows(fa));
		assert_eq!(Some(hash_of(b"B1")), a3[0].1.hash().map(String::from), "TS1: B1, not A's own A1");
		assert_eq!(Some(fb), a3[0].1.folder());
		assert_eq!(Route::Ask(Unplaced::Unknown), route("proj/x.md", a3[0].1.folder(), "proj/x.md", Some(fa), false, true));
		// TS3: on B, the whole Restore to v4 is A's A2, not B's own older B1.
		let b4 = state_at(&ts, 4, on(fb), knows(fb));
		assert_eq!(Some(hash_of(b"A2")), b4[0].1.hash().map(String::from), "TS3: A2, not B's own B1");
		// Control: were B's folder one A knows, it would be another folder's file, and A's own
		// rows would answer (HX3 holds).
		let known_other = state_at(&ts, 3, on(fa), |_| true);
		assert_eq!(Some(hash_of(b"A1")), known_other[0].1.hash().map(String::from));
		assert_eq!(Some(fa), known_other[0].1.folder());
		// The file-revert target reads the same rows: on A after v3, the newest change here is B's,
		// handed on with B's folder, so the revert asks rather than writes.
		let upto3 = ts[..2].to_vec();
		assert_eq!(Some((3, hash_of(b"A1"), Some(fb.to_string()))), undo_target(&upto3, "proj/x.md", Some(fa), knows(fa)));
		assert_eq!(None, undo_target(&upto3, "proj/x.md", Some(fa), |_| true), "a known other folder's change is not this folder's");
		// A no-bytes change's `was` is filed under this folder and goes back unasked, so it takes this
		// folder's own row, never B's, known or not (IX of round 1, with the folder unknown).
		let ix = index_placed(&upto3);
		assert_eq!(Some(hash_of(b"A1")), indexed_was(&ix, "proj/x.md", Some(fa)));
		assert_eq!(None, indexed_was(&ix, "proj/x.md", Some(BROWSER_FOLDER)));
		// A version to revert to reads them too: on A, the path as at v3 is B1.
		assert_eq!(Some(hash_of(b"B1")), path_here(&upto3, "proj/x.md", 3, Some(fa), knows(fa)).as_ref().and_then(|a| a.hash().map(String::from)));
		// FG: F1 records One (v2) and Two (v3) under id `old`; "Forget", a re-pick gives `new`; a
		// Restore of v2 (v4, over Two) and a save of Three (v5, `was` Two) are filed under `new`.
		let old = "c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3";
		let new = "d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4";
		let fg = vec![
			(2, Manifest::new(Cause::User,    TS, "", "", vec![e_in("proj/x.md", "One", None, Some(old))])),
			(3, Manifest::new(Cause::User,    TS, "", "", vec![e_in("proj/x.md", "Two", Some("One"), Some(old))])),
			(4, Manifest::new(Cause::Restore, TS, "", "", vec![e_in("proj/x.md", "One", Some("Two"), Some(new))])),
			(5, Manifest::new(Cause::User,    TS, "", "", vec![e_in("proj/x.md", "Three", Some("Two"), Some(new))])),
		];
		let fg2 = state_at(&fg, 2, on(new), knows(new));
		assert_eq!(Some(hash_of(b"One")), fg2[0].1.hash().map(String::from), "FG (2): One, not the new id's first `was`");
		assert_eq!(Some(old), fg2[0].1.folder());
		// A tie at one version goes to the open folder's own row, in the resolver and the index.
		let tie = vec![
			(2, Manifest::new(Cause::User, TS, "", "", vec![
				e_in("proj/x.md", "theirs", None, Some(fb)),
				e_in("proj/x.md", "mine", None, Some(fa)),
			])),
		];
		assert_eq!(Some(fa), state_at(&tie, 2, on(fa), knows(fa))[0].1.folder());
		assert_eq!(Some(hash_of(b"mine")), indexed_was(&index_placed(&tie), "proj/x.md", Some(fa)));
		// A tie between this folder's row and one from before folders goes to this folder's.
		let mut legacy = e("proj/x.md", "legacy", None);
		legacy.folder = None;
		let tie_old = vec![(2, Manifest::new(Cause::User, TS, "", "", vec![e_in("proj/x.md", "mine", None, Some(fa)), legacy]))];
		assert_eq!(Some(hash_of(b"mine")), indexed_was(&index_placed(&tie_old), "proj/x.md", Some(fa)));
		// A row's own Restore still puts back the row pressed, whichever folder is open.
		assert_eq!(Some(fb), path_at(&tie, "proj/x.md", 2, Some(fb)).as_ref().and_then(|a| a.folder()));
	}

	/// **The resolvers drop exactly the rows the route leaves** (HQ1).  One question, [`elsewhere`],
	/// asked of every pair of places a row and its path can be in, known or not.
	#[test]
	fn test_the_resolvers_and_the_route_ask_one_question_00() {
		let places = [None, Some(BROWSER_FOLDER), Some(UNNAMED_FOLDER),
			Some("0123456789abcdef0123456789abcdef"), Some("fedcba9876543210fedcba9876543210")];
		let mut asked = 0;
		for row in places.iter() {
			for here in places.iter().filter(|h| h.is_some()) {
				for known in [false, true] {
					let left = route("proj/x.md", *row, "proj/x.md", *here, known, true) == Route::Left;
					assert_eq!(left, elsewhere(*row, *here, known), "row {:?} here {:?} known {}", row, here, known);
					asked += 1;
				}
			}
		}
		assert_eq!(40, asked);
	}

	fn res_ok<T>(r: Outcome<T>) -> T {
		match r {
			Ok(v)  => v,
			Err(e) => panic!("{}", e),
		}
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
		// Room for three manifests' worth of bodies at the low-water mark (3_000), so three must go.
		let plan = prune_plan(&ms, &held, &[], Caps { bytes: 3_334, manifests: MANIFESTS_MAX }, LATER, HOME, &BTreeSet::new());
		// The two cheapest causes first, oldest within each, and then a discontinuity; the
		// list itself comes back in version order.
		assert_eq!(vec![1, 3, 4], plan.manifests);
		assert!(!plan.manifests.contains(&2), "a user's own save was pruned before a turn's");
		assert!(!plan.manifests.contains(&5), "a restore went before the fold above it");
		assert!(!plan.manifests.contains(&6), "the newest manifest was pruned");
	}

	/// **A store inside its ceilings loses nothing; one over them goes down to 90% of each.**
	#[test]
	fn test_a_prune_goes_down_to_the_low_water_mark_00() {
		let ms: Vec<(u64, Manifest)> = (1..=10)
			.map(|n| (n, m(Cause::Turn, vec![e("a", &fmt!("{}", n), None)])))
			.collect();
		let held: Vec<(String, u64)> = (1..=10)
			.map(|n| (hash_of(fmt!("{}", n).as_bytes()), 100u64))
			.collect();
		let at = prune_plan(&ms, &held, &[], Caps { bytes: 1_000, manifests: 10 }, LATER, HOME, &BTreeSet::new());
		assert!(at.manifests.is_empty(), "a store at its ceiling, not over it, was pruned: {:?}", at.manifests);
		let over = prune_plan(&ms, &held, &[], Caps { bytes: 999, manifests: 10 }, LATER, HOME, &BTreeSet::new());
		assert_eq!(vec![1, 2], over.manifests, "down to 899 bytes, not just under 999");
	}

	#[test]
	fn test_the_manifest_ceiling_prunes_even_where_the_bytes_would_fit() {
		let ms: Vec<(u64, Manifest)> = (1..=5)
			.map(|n| (n, m(Cause::Turn, vec![e("a", &fmt!("{}", n), None)])))
			.collect();
		let held: Vec<(String, u64)> = (1..=5)
			.map(|n| (hash_of(fmt!("{}", n).as_bytes()), 1u64))
			.collect();
		// A ceiling of 4 has its low-water mark at 3.
		let plan = prune_plan(&ms, &held, &[], Caps { bytes: u64::MAX, manifests: 4 }, LATER, HOME, &BTreeSet::new());
		assert_eq!(vec![1, 2], plan.manifests);
	}

	#[test]
	fn test_a_store_of_one_oversized_manifest_is_left_at_one_rather_than_emptied() {
		let ms = vec![(7, m(Cause::Turn, vec![e("a", "big", None)]))];
		let held = vec![(hash_of(b"big"), 9_000_000u64)];
		let plan = prune_plan(&ms, &held, &[], Caps { bytes: 1, manifests: 1 }, LATER, HOME, &BTreeSet::new());
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
		let plan = prune_plan(&ms, &held, &[], Caps { bytes: 4, manifests: MANIFESTS_MAX }, LATER, HOME, &BTreeSet::new());
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
	fn test_the_gauge_weighs_what_is_on_disk_named_or_not() {
		// "two" is named and not here: it weighs nothing.  The orphan is here: it weighs.
		let held = vec![(hash_of(b"one"), 100u64), (hash_of(b"orphan"), 30u64)];
		assert_eq!(130, disk_bytes(&held));
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
		assert_eq!(PAGE.lines().count(), rows.len());	// a final newline ends the last line
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

	/// A newline ENDS a line; it does not start an empty one. A new file of three lines, written
	/// the ordinary way with a final newline, is three added lines -- the Files tile showed +4.
	#[test]
	fn test_a_final_newline_is_no_extra_line() -> Outcome<()> {
		assert_eq!((3, 0), diff_counts(&res!(line_diff("", "a\nb\nc\n"))));
		assert_eq!((0, 3), diff_counts(&res!(line_diff("a\nb\nc\n", ""))));
		assert_eq!((1, 1), diff_counts(&res!(line_diff("a\nb\n", "a\nB\n"))));
		assert_eq!((1, 0), diff_counts(&res!(line_diff("a\n", "a\nb\n"))));
		// A blank last line is still a line: two newlines are one line and one blank one.
		assert_eq!((2, 0), diff_counts(&res!(line_diff("", "a\n\n"))));
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

	// ── What a turn captured (Q5-1) ──────────────────────────────────────────
	//
	// The page's glue around these rules -- `before_overwrite`, `Overwrite::prior`, the file tools'
	// captures -- is wasm and is driven live by `dev/q5probe_launder.mjs`.  `wrote` and `moving`
	// below are that glue reduced to what it decides, with no history held, so `run_copies` has
	// nothing to add to what `this_turn_found` says.

	const USERS: &str = "The user's own notes, which no turn wrote.\n";

	/// The turn's capture of `path`, where it holds one.
	fn entry<'a>(held: &'a [(String, Change)], path: &str) -> Option<&'a Change> {
		held.iter().find(|(_, h)| h.path == path).map(|(_, h)| h)
	}

	/// What a wipe over `path` holding `now` is measured against: `measured_against`, with no
	/// history held.
	fn against(held: &[(String, Change)], path: &str, now: &[u8]) -> Vec<u8> {
		match this_turn_found(held, path, now) {
			TurnFound::Made		=> Vec::new(),
			TurnFound::Carried(k)	=> k,
			TurnFound::Was(w)	=> w,
		}
	}

	/// A turn's write of `after` over `path`, a file of the user's, where it `found` those bytes:
	/// measured, and captured with the copy a wipe keeps.  Answers whether it wiped.
	fn wrote(held: &mut Vec<(String, Change)>, path: &str, found: Option<&[u8]>, after: &[u8])
		-> bool
	{
		let copy = found.map(|now| against(held, path, now));
		let wiped = match &copy {
			Some(c)	=> wipes(c, after),
			None	=> false,
		};
		let before = if wiped { copy } else { found.map(|b| b.to_vec()) };
		capture_into(held, path, Change { path: path.to_string(), after: Body::Held(after.to_vec()),
			before, found: Found::of(found), carried: None, mark: true, refused: None, wiped,
			folder: None, by: None, door: false });
		wiped
	}

	/// A turn's move of `from`, holding `bytes`, to `to`: both ends captured.
	fn moving(held: &mut Vec<(String, Change)>, from: &str, to: &str, bytes: &[u8]) {
		let first = match this_turn_found(held, from, bytes) {
			TurnFound::Made		=> None,
			TurnFound::Carried(k)	=> Some(k),
			TurnFound::Was(w)	=> Some(w),
		};
		let (src, dst) = moved((from, true), (to, true), Moving::Read(bytes.to_vec(), first));
		capture_into(held, from, src);
		capture_into(held, to, dst);
	}

	/// **A user's file on a path the turn made is still the user's file** (Q5-1, brief test 1 and
	/// its control).  The turn wrote `b.md`, the file moved on without a capture -- a hand's `mv`,
	/// the user's own editor, a sync -- and the user's file now stands there: emptying it is
	/// measured against their bytes and is a wipe.  The turn's own file, still as it left it, is
	/// emptied without asking, as it always was.
	#[test]
	fn test_a_users_file_on_a_path_the_turn_made_is_measured_as_theirs_00() {
		let mut held: Vec<(String, Change)> = Vec::new();
		assert!(!wrote(&mut held, "vault/q/b.md", None, b"x"), "a new file was a wipe");
		// The control: the turn's own bytes, still there.
		assert_eq!(TurnFound::Made, this_turn_found(&held, "vault/q/b.md", b"x"));
		assert!(!wipes(&against(&held, "vault/q/b.md", b"x"), b""),
			"emptying the turn's own file was a wipe");
		// The user's bytes where the turn's were: measured as they stand, and emptying them wipes.
		assert_eq!(TurnFound::Was(USERS.as_bytes().to_vec()),
			this_turn_found(&held, "vault/q/b.md", USERS.as_bytes()),
			"a user's file on a path the turn made was taken for the turn's own");
		assert!(wipes(&against(&held, "vault/q/b.md", USERS.as_bytes()), b""),
			"emptying the user's file there was not a wipe");
		// A path the turn made and then removed says nothing of what stands there now.
		capture_into(&mut held, "vault/q/b.md", Change {
			found: Found::of(Some(b"x")), ..Change::gone("vault/q/b.md") });
		assert_eq!(TurnFound::Was(USERS.as_bytes().to_vec()),
			this_turn_found(&held, "vault/q/b.md", USERS.as_bytes()));
		// An edit on the machine the app never read back is trusted for a first copy, never for
		// "made here".
		let unseen = vec![("n.md".to_string(), Change { after: Body::Unseen, ..Change::gone("n.md") })];
		assert_eq!(TurnFound::Was(b"now".to_vec()), this_turn_found(&unseen, "n.md", b"now"));
	}

	/// **A write over bytes the turn did not leave starts the run again** (Q5-1, brief test 1b).
	/// The capture of the write that empties the user's file on a path the turn made keeps the
	/// user's bytes as the path's first copy -- not the turn's "made here", which a restore would
	/// have put back as nothing.  An entry that already holds a first copy is sealed with its run
	/// first, and the path's run begins again with the bytes the act found.
	#[test]
	fn test_a_write_over_bytes_the_turn_did_not_leave_starts_the_run_again_00() {
		let mut held: Vec<(String, Change)> = Vec::new();
		wrote(&mut held, "vault/q/b.md", None, b"x");
		assert!(wrote(&mut held, "vault/q/b.md", Some(USERS.as_bytes()), b""),
			"emptying the user's file was not a wipe");
		match entry(&held, "vault/q/b.md") {
			Some(b)	=> {
				assert_eq!(Some(USERS.as_bytes().to_vec()), b.before,
					"the row keeps the turn's \"made here\", not the user's bytes");
				assert!(b.wiped);
			},
			None	=> panic!("the write was not captured"),
		}
		// Unbroken, the turn's own file stays its own however often it is written.
		let mut own: Vec<(String, Change)> = Vec::new();
		wrote(&mut own, "vault/q/o.md", None, b"one");
		assert!(!wrote(&mut own, "vault/q/o.md", Some(b"one"), b""));
		assert_eq!(Some(None), entry(&own, "vault/q/o.md").map(|h| h.before.clone()));
		// A first copy goes with its run at a break, and so does the stale history of the bytes.
		let mut edited: Vec<(String, Change)> = Vec::new();
		let orig = "The user's report, as it was before the turn began.\n";
		let edit = "The user's report, as it was before the turn began, edited.\n";
		wrote(&mut edited, "vault/r.md", Some(orig.as_bytes()), edit.as_bytes());
		if let Some((_, h)) = edited.iter_mut().find(|(_, h)| h.path == "vault/r.md") {
			h.carried = Some(Carried::Kept(b"stale".to_vec()));
		}
		assert_eq!(TurnFound::Was(USERS.as_bytes().to_vec()),
			this_turn_found(&edited, "vault/r.md", USERS.as_bytes()),
			"bytes the turn did not leave were measured as the turn's");
		match seal_broken(&mut edited, "vault/r.md", USERS.as_bytes()) {
			Some((_, run))	=> assert_eq!(
				(Some(orig.as_bytes().to_vec()), Some(Carried::Kept(b"stale".to_vec()))),
				(run.before, run.carried), "the run sealed was not the turn's"),
			None		=> panic!("the run the user's bytes ended was not sealed"),
		}
		wrote(&mut edited, "vault/r.md", Some(USERS.as_bytes()), b"new");
		match entry(&edited, "vault/r.md") {
			Some(r)	=> {
				assert_eq!(Some(USERS.as_bytes().to_vec()), r.before,
					"the path did not start again from the bytes the write found");
				assert_eq!(None, r.carried, "a history of bytes no longer there was kept");
			},
			None	=> panic!("the write was not captured"),
		}
	}

	/// **Bytes from outside the turn end its run, and each copy keeps a row** (QF2 of the Q5-1
	/// fix's QA, 2026-09-24).  The turn edits the user's `e.md`, the user's editor saves over it,
	/// and the turn writes its first text back.  On b21e5a74 the entry kept the first copy and
	/// dropped the one the wipe's question promised, and a net change of nothing wrote no row.
	/// Now the run so far is sealed before the write, and the write's run keeps the user's save.
	#[test]
	fn test_bytes_from_outside_end_the_run_and_each_copy_keeps_a_row_00() {
		let first = "hello world\n";
		let edit = "hello world!\n";
		let later = "the user saved this later, line\n".repeat(300);
		let mut held: Vec<(String, Change)> = Vec::new();
		assert!(!wrote(&mut held, "vault/e.md", Some(first.as_bytes()), edit.as_bytes()));
		// Unbroken, nothing is sealed.
		assert_eq!(None, seal_broken(&mut held, "vault/e.md", edit.as_bytes()));
		match entry(&held, "vault/e.md") {
			Some(h)	=> assert!(run_broken(h, &Found::of(Some(later.as_bytes())))),
			None	=> panic!("the edit was not captured"),
		}
		let (raw, run) = match seal_broken(&mut held, "vault/e.md", later.as_bytes()) {
			Some(s)	=> s,
			None	=> panic!("the user's save did not end the turn's run"),
		};
		assert_eq!(("vault/e.md", Some(first.as_bytes().to_vec()), Body::Held(edit.as_bytes().to_vec())),
			(raw.as_str(), run.before.clone(), run.after.clone()), "the sealed run is not the turn's edit");
		// The path begins again at the user's save, and the write back is a wipe of it.
		assert_eq!(TurnFound::Was(later.as_bytes().to_vec()),
			this_turn_found(&held, "vault/e.md", later.as_bytes()));
		assert!(wrote(&mut held, "vault/e.md", Some(later.as_bytes()), first.as_bytes()),
			"writing the first text back over the user's save was not a wipe");
		match entry(&held, "vault/e.md") {
			Some(e)	=> assert_eq!((Some(later.as_bytes().to_vec()), true), (e.before.clone(), e.wiped),
				"the row does not keep the user's save as the copy the wipe promised"),
			None	=> panic!("the write was not captured"),
		}
		assert_eq!(1, held.len());
		// A path found empty ends no run a copy is owed for, and nothing is sealed.
		let mut gone: Vec<(String, Change)> = Vec::new();
		wrote(&mut gone, "vault/g.md", Some(first.as_bytes()), edit.as_bytes());
		assert!(!run_broken(&gone[0].1, &Found::Nothing));
		assert!(!run_broken(&gone[0].1, &Found::Unread));
		// The builder's own open case: deleted (copy B0), a hand's `cp` onto the path, then written.
		let b0 = "The user's b.md, which the turn deleted.\n";
		let cp = "What a hand's cp put there afterwards, which is not the turn's.\n";
		let mut del: Vec<(String, Change)> = Vec::new();
		capture_into(&mut del, "vault/b.md", Change { before: Some(b0.as_bytes().to_vec()),
			found: Found::of(Some(b0.as_bytes())), mark: true, ..Change::gone("vault/b.md") });
		match seal_broken(&mut del, "vault/b.md", cp.as_bytes()) {
			Some((_, run))	=> assert_eq!((Body::Gone, Some(b0.as_bytes().to_vec())),
				(run.after, run.before), "the delete's copy was not sealed with its run"),
			None		=> panic!("bytes on a path the turn deleted did not end its run"),
		}
		assert!(wrote(&mut del, "vault/b.md", Some(cp.as_bytes()), b""));
		assert_eq!(Some(Some(cp.as_bytes().to_vec())), entry(&del, "vault/b.md").map(|b| b.before.clone()));
	}

	/// **A run whose version could not be written goes back as it was** -- unless the path has moved
	/// on since, and then what stands is left.
	#[test]
	fn test_a_seal_that_was_not_recorded_is_put_back_00() {
		let mut held: Vec<(String, Change)> = Vec::new();
		wrote(&mut held, "vault/p.md", Some(b"one"), b"two");
		let before = held.clone();
		let sealed = match seal_broken(&mut held, "vault/p.md", b"three") {
			Some(s)	=> s,
			None	=> panic!("not sealed"),
		};
		unseal(&mut held, sealed.clone(), b"three");
		assert_eq!(before, held, "the run was not put back");
		let again = match seal_broken(&mut held, "vault/p.md", b"three") {
			Some(s)	=> s,
			None	=> panic!("not sealed"),
		};
		wrote(&mut held, "vault/p.md", Some(b"three"), b"three and four");
		let now = held.clone();
		unseal(&mut held, again, b"three");
		assert_eq!(now, held, "a run the path had moved on from was put back over it");
	}

	/// **The turn's bound counts copies, not files** (QF1 of the Q5-1 fix's QA, 2026-09-24).  On
	/// b21e5a74 every entry counted, a move's two ends included, so 64 files the turn made refused
	/// the next move or edit of anything, and a folder of 33 of them could not be renamed.
	#[test]
	fn test_the_turn_bound_counts_copies_not_the_files_the_turn_made_00() {
		let mut held: Vec<(String, Change)> = Vec::new();
		for i in 0..TURN_FILES_MAX {
			wrote(&mut held, &fmt!("vault/new/f{}.md", i), None, b"made");
		}
		let mut reserved: Vec<Reserved> = Vec::new();
		// An edit of a user file, and a move's source, each keep a copy, and there is room.
		assert_eq!(Ok(true), claim_room(&held, &mut reserved, "vault/u.md",
			&Found::of(Some(USERS.as_bytes())), Some(USERS.len() as u64), false, u64::MAX));
		// A file the turn made keeps nothing, however many there are.
		assert_eq!(Ok(false), claim_room(&held, &mut reserved, "vault/new/f0.md",
			&Found::of(Some(b"made")), Some(4), true, u64::MAX));
		assert_eq!(Ok(true), claim_room(&held, &mut reserved, "vault/elsewhere.md",
			&Found::Nothing, None, false, 0));
		// Sixty-four copies, and the sixty-fifth is refused; one already held costs nothing more.
		let mut copies: Vec<(String, Change)> = Vec::new();
		for i in 0..TURN_FILES_MAX {
			let p = fmt!("vault/u{}.md", i);
			wrote(&mut copies, &p, Some(USERS.as_bytes()), b"edited, most of it kept? no");
		}
		let mut none: Vec<Reserved> = Vec::new();
		assert_eq!(Err(Short::Count), claim_room(&copies, &mut none, "vault/u64.md",
			&Found::of(Some(USERS.as_bytes())), Some(1), false, u64::MAX));
		assert_eq!(Ok(false), claim_room(&copies, &mut none, "vault/u3.md",
			&Found::of(Some(b"edited, most of it kept? no")), Some(1), false, u64::MAX));
		// A run bytes from outside end is a copy the turn does not yet hold: a path it made, once the
		// user's editor saved over it, counts; one holding a copy trades it for the new one.
		let mut made = copies.clone();
		wrote(&mut made, "vault/mine.md", None, b"made");
		assert_eq!(Err(Short::Count), claim_room(&made, &mut none, "vault/mine.md",
			&Found::of(Some(USERS.as_bytes())), Some(1), false, u64::MAX),
			"a made path the user saved over took a 65th copy");
		assert_eq!(Ok(true), claim_room(&copies, &mut none, "vault/u3.md",
			&Found::of(Some(b"the user's later save")), Some(1), false, u64::MAX));
		// Reservations in flight count as copies, and an act keeping none is never refused.
		let mut in_flight: Vec<Reserved> = (0..TURN_FILES_MAX)
			.map(|i| Reserved { path: fmt!("vault/r{}.md", i), copy: Some(1), destroying: false })
			.collect();
		assert_eq!(Err(Short::Count), claim_room(&[], &mut in_flight, "vault/x.md",
			&Found::of(Some(b"x")), Some(1), false, u64::MAX));
		assert_eq!(Ok(true), claim_room(&[], &mut in_flight, "vault/x.md", &Found::Nothing, None,
			true, 0));
		// The byte bound still holds once the turn holds a destruction.
		let mut small: Vec<Reserved> = Vec::new();
		assert_eq!(Err(Short::Bytes(10)), claim_room(&[], &mut small, "vault/big.md",
			&Found::of(Some(b"x")), Some(11), true, 10));
	}

	/// **Past the rows one version keeps, the rows holding copies stay** (QF1, the cut): a turn of
	/// 70 made files that also moved and edited a user's file keeps both copies.
	#[test]
	fn test_the_cut_keeps_the_rows_that_hold_copies_00() {
		let row = |p: &str, was: Option<&str>, gone: bool| Entry { path: p.to_string(),
			hash: if gone { String::new() } else { hash_of(p.as_bytes()) }, bytes: 1,
			was: was.map(|w| w.to_string()), gone, wiped: false, mark: true, skipped: None,
			folder: None, by: None, door: false };
		let mut rows: Vec<(Entry, bool)> = (0..70)
			.map(|i| (row(&fmt!("vault/new/f{}.md", i), None, false), false)).collect();
		rows.push((row("vault/u.md", Some(&hash_of(b"u")), true), true));
		rows.push((row("vault/w.md", Some(&hash_of(b"w")), false), true));
		let (kept, cut) = truncate(cut_order(rows));
		assert_eq!((TURN_FILES_MAX, 8), (kept.len(), cut));
		assert_eq!(("vault/u.md", "vault/w.md"), (kept[0].path.as_str(), kept[1].path.as_str()));
		// Where nothing is cut, the rows stay as they came.
		let few: Vec<(Entry, bool)> = vec![(row("a", None, false), false), (row("b", Some("h"), true), true)];
		assert_eq!(vec!["a", "b"], cut_order(few).iter().map(|e| e.path.as_str()).collect::<Vec<_>>());
	}

	/// **No row holding a copy is ever cut** (R2-3): 64 adopted copies, one more the turn took and
	/// ten made files.  The copies fill the first version and the one over goes into a second; only
	/// the made files are cut.
	#[test]
	fn test_rows_holding_copies_past_the_bound_go_into_a_further_version_00() {
		let row = |p: &str, was: Option<&str>| Entry { path: p.to_string(),
			hash: hash_of(p.as_bytes()), bytes: 1, was: was.map(|w| w.to_string()), gone: false,
			wiped: false, mark: true, skipped: None, folder: None, by: None, door: false };
		let mut rows: Vec<(Entry, bool)> = (0..10)
			.map(|i| (row(&fmt!("vault/new/f{}.md", i), None), false)).collect();
		for i in 0..65 {
			let p = fmt!("vault/u{:02}.md", i);
			rows.push((row(&p, Some(&hash_of(p.as_bytes()))), true));
		}
		let (groups, cut) = split_rows(rows);
		assert_eq!((2, 10), (groups.len(), cut));
		assert_eq!((TURN_FILES_MAX, 1), (groups[0].len(), groups[1].len()));
		let copies = groups.iter().flatten().filter(|e| e.path.starts_with("vault/u")).count();
		assert_eq!(65, copies);
		// 130 copies: two full versions and a third, nothing cut.
		let many: Vec<(Entry, bool)> = (0..130).map(|i| {
			let p = fmt!("vault/m{:03}.md", i);
			(row(&p, Some(&hash_of(p.as_bytes()))), true)
		}).collect();
		let (g, c) = split_rows(many);
		assert_eq!((vec![64, 64, 2], 0), (g.iter().map(|x| x.len()).collect::<Vec<_>>(), c));
		// Under the bound: one version, as it came.
		let (g, c) = split_rows(vec![(row("a", None), false), (row("b", Some("h")), true)]);
		assert_eq!((1, 2, 0), (g.len(), g[0].len(), c));
		// Nothing at all: one empty version.
		let (g, c) = split_rows(Vec::new());
		assert_eq!((1, 0, 0), (g.len(), g[0].len(), c));
	}

	/// **A move records both of its ends, and the bytes keep their own history** (Q5-1, brief
	/// test 3): the probe's four calls.  The turn's `b.md` goes to `c.md` still its own; the user's
	/// `victim.md` is gone from its path with its copy kept, and at `b.md` it is still theirs, so
	/// emptying it there is a wipe.  `b.md` itself goes back to what it held when the turn came to
	/// it, which was nothing.
	#[test]
	fn test_a_move_records_both_ends_and_the_bytes_keep_their_history_00() {
		let mut held: Vec<(String, Change)> = Vec::new();
		wrote(&mut held, "vault/q/b.md", None, b"x");
		moving(&mut held, "vault/q/b.md", "vault/q/c.md", b"x");
		moving(&mut held, "vault/q/victim.md", "vault/q/b.md", USERS.as_bytes());
		// c.md: the turn's own file, moved.
		match entry(&held, "vault/q/c.md") {
			Some(c)	=> {
				assert_eq!((None, Body::Held(b"x".to_vec()), Some(Carried::Made)),
					(c.before.clone(), c.after.clone(), c.carried.clone()));
			},
			None	=> panic!("the destination of the first move was not captured"),
		}
		assert_eq!(TurnFound::Made, this_turn_found(&held, "vault/q/c.md", b"x"));
		// victim.md: gone, and what a restore puts back is the user's file.
		match entry(&held, "vault/q/victim.md") {
			Some(v)	=> assert_eq!((Body::Gone, Some(USERS.as_bytes().to_vec())),
				(v.after.clone(), v.before.clone())),
			None	=> panic!("the source of the second move was not captured"),
		}
		// b.md: the user's bytes, carried, on a path that held nothing when the turn came.
		match entry(&held, "vault/q/b.md") {
			Some(b)	=> assert_eq!(
				(None, Body::Held(USERS.as_bytes().to_vec()), Some(Carried::Kept(USERS.as_bytes().to_vec()))),
				(b.before.clone(), b.after.clone(), b.carried.clone())),
			None	=> panic!("the destination of the second move was not captured"),
		}
		assert_eq!(TurnFound::Carried(USERS.as_bytes().to_vec()),
			this_turn_found(&held, "vault/q/b.md", USERS.as_bytes()));
		// The last call: a wipe, and the user's copy is still the one victim.md keeps.
		assert!(wrote(&mut held, "vault/q/b.md", Some(USERS.as_bytes()), b""),
			"emptying the user's file after it was moved was not a wipe");
		assert_eq!(Some(Some(USERS.as_bytes().to_vec())),
			entry(&held, "vault/q/victim.md").map(|v| v.before.clone()));
		assert_eq!(Some(true), entry(&held, "vault/q/b.md").map(|b| b.wiped));
		assert_eq!(3, held.len());
	}

	/// **A move onto a path the turn emptied keeps that path's first copy**, and a destruction of
	/// the bytes it brought does not take the path's first for theirs: a restore of `b.md` puts
	/// back the user's `b.md`, and the moved file's copy is where it came from.
	#[test]
	fn test_a_move_onto_a_path_the_turn_emptied_keeps_that_paths_first_00() {
		let mut held: Vec<(String, Change)> = Vec::new();
		let theirs_b = "The user's b.md, which the turn deleted.\n";
		capture_into(&mut held, "vault/b.md", Change { before: Some(theirs_b.as_bytes().to_vec()),
			found: Found::of(Some(theirs_b.as_bytes())), mark: true, ..Change::gone("vault/b.md") });
		moving(&mut held, "vault/a.md", "vault/b.md", USERS.as_bytes());
		assert!(wrote(&mut held, "vault/b.md", Some(USERS.as_bytes()), b""));
		match entry(&held, "vault/b.md") {
			Some(b)	=> assert_eq!((Some(theirs_b.as_bytes().to_vec()), true),
				(b.before.clone(), b.wiped), "the deleted b.md's copy was taken for a.md's"),
			None	=> panic!("b.md was not captured"),
		}
		assert_eq!(Some(Some(USERS.as_bytes().to_vec())),
			entry(&held, "vault/a.md").map(|a| a.before.clone()));
	}

	/// **Bytes a move could not read are measured as they stand**, never as the turn's own, and a
	/// folder's move carries exactly the files the turn holds under it.
	#[test]
	fn test_an_unread_move_is_never_made_here_and_a_folder_carries_its_captures_00() {
		let mut held: Vec<(String, Change)> = Vec::new();
		wrote(&mut held, "vault/big.bin", None, b"x");
		let (src, dst) = moved(("vault/big.bin", true), ("vault/moved.bin", true),
			Moving::Unread(Body::TooLarge(1 << 30), "size".to_string()));
		capture_into(&mut held, "vault/big.bin", src);
		capture_into(&mut held, "vault/moved.bin", dst);
		assert_eq!(TurnFound::Was(b"now".to_vec()), this_turn_found(&held, "vault/moved.bin", b"now"));
		assert_eq!(Some(Some("size".to_string())),
			entry(&held, "vault/moved.bin").map(|m| m.refused.clone()));
		wrote(&mut held, "vault/d/one.md", None, b"1");
		wrote(&mut held, "vault/d/sub/two.md", None, b"2");
		wrote(&mut held, "vault/dx/three.md", None, b"3");
		let mut under = held_under(&held, "vault/d/");
		under.sort();
		assert_eq!(vec![
			("vault/d/one.md".to_string(), "one.md".to_string(), "vault/d/one.md".to_string()),
			("vault/d/sub/two.md".to_string(), "sub/two.md".to_string(),
				"vault/d/sub/two.md".to_string()),
		], under);
		assert!(held_under(&held, "vault/d/one.md").is_empty(), "a file was taken for a folder");
	}

	/// **An unbroken run keeps the turn's first copy, and the first destruction brings its own**
	/// -- the rule the capture always had, now tested where it lives.
	#[test]
	fn test_an_unbroken_run_keeps_its_first_and_a_first_destruction_brings_its_own_00() {
		let p0 = "The plan, first draft, with every section the user wrote.\n".to_string();
		let p1 = fmt!("{}One more line.\n", p0);
		let p2 = fmt!("{}And another.\n", p1);
		let mut held: Vec<(String, Change)> = Vec::new();
		assert!(!wrote(&mut held, "vault/p.md", Some(p0.as_bytes()), p1.as_bytes()));
		assert!(!wrote(&mut held, "vault/p.md", Some(p1.as_bytes()), p2.as_bytes()));
		assert_eq!(Some(Some(p0.as_bytes().to_vec())),
			entry(&held, "vault/p.md").map(|p| p.before.clone()));
		// A delete keeping the file as earlier turns found it: older than this turn's first.
		capture_into(&mut held, "vault/p.md", Change { before: Some(b"R, before earlier trims".to_vec()),
			found: Found::of(Some(p2.as_bytes())), mark: true, ..Change::gone("vault/p.md") });
		assert_eq!(Some(Some(b"R, before earlier trims".to_vec())),
			entry(&held, "vault/p.md").map(|p| p.before.clone()));
	}

	/// **A row names whoever left the bytes that stand** (rating U1, `Entry.by`).  The daimon writes
	/// a file and a worker writes over it in the same turn: the row is the worker's, and its first
	/// copy is still what stood when the turn came.  A run begun again at bytes from outside the
	/// turn names nobody, and the sealed run keeps its own author.
	#[test]
	fn test_a_folded_capture_names_the_agent_whose_bytes_stand_00() {
		let who = |role: &str| Some(Author { role: role.to_string(), m: fmt!("{}-model", role),
			..Default::default() });
		let mut held: Vec<(String, Change)> = Vec::new();
		capture_into(&mut held, "notes/a.md", Change { before: Some(b"old\n".to_vec()),
			found: Found::of(Some(b"old\n")), by: who("daimon"),
			..Change::of("notes/a.md", b"daimon's\n".to_vec()) });
		capture_into(&mut held, "notes/a.md", Change { before: Some(b"daimon's\n".to_vec()),
			found: Found::of(Some(b"daimon's\n")), by: who("worker"),
			..Change::of("notes/a.md", b"worker's\n".to_vec()) });
		assert_eq!(Some((Some(b"old\n".to_vec()), who("worker"))),
			entry(&held, "notes/a.md").map(|c| (c.before.clone(), c.by.clone())));
		// The user's editor saves over it: the turn's run is sealed with its author, and the run
		// begun again at the user's bytes names nobody.
		let sealed = seal_broken(&mut held, "notes/a.md", b"user's\n");
		assert_eq!(Some(who("worker")), sealed.map(|(_, c)| c.by));
		assert_eq!(Some(None), entry(&held, "notes/a.md").map(|c| c.by.clone()));
		// A move's ends name nobody until the mover's caller says who it is.
		let (src, dst) = moved(("notes/b.md", false), ("notes/c.md", false),
			Moving::Read(b"b\n".to_vec(), None));
		assert_eq!((None, None), (src.by, dst.by));
	}

	/// A turn end tells its own bytes from a write that came after its last act.
	#[test]
	fn test_a_turn_end_sees_bytes_that_are_not_its_own_00() {
		let t = Body::Held(b"the turn's".to_vec());
		// Still what the turn left: recorded as ever.
		assert!(stands_as_left(&t, &Body::Held(b"the turn's".to_vec())));
		assert!(stands_as_left(&Body::Gone, &Body::Gone));
		// A restore in another tab, or the person's editor, wrote after the turn's last act.
		assert!(!stands_as_left(&t, &Body::Held(b"put back".to_vec())));
		assert!(!stands_as_left(&t, &Body::Gone));
		assert!(!stands_as_left(&Body::Gone, &Body::Held(b"put back".to_vec())));
		assert!(!stands_as_left(&Body::Gone, &Body::TooLarge(600_000)));
		assert!(!stands_as_left(&t, &Body::TooLarge(600_000)));
		// What cannot be told is left as the capture says.
		assert!(stands_as_left(&Body::Held(vec![b'x'; 10]), &Body::TooLarge(10)));
		assert!(stands_as_left(&Body::Unseen, &Body::Held(b"x".to_vec())));
		assert!(stands_as_left(&Body::TooLarge(700_000), &Body::Gone));
	}

	/// **The open folder's tally counts files, not paths** (Q5-1, the delete variant).  A yes to
	/// deleting the turn's own file at `b2.md`, asking before every one, is not a yes to emptying
	/// the user's file moved there after it; a file wiped and then deleted is still one file.
	#[test]
	fn test_the_open_folder_tally_counts_a_file_by_its_bytes_not_its_path_00() {
		let mut held: Vec<(String, Change)> = Vec::new();
		let mut t = OpenTally::new(3);
		let own = open_file_key("vault/q/b2.md", b"x");
		let q = match t.room(&own, 0) {
			OpenDelete::Ask(0, q)	=> q,
			other			=> panic!("the delete of the turn's own file was not asked: {:?}", other),
		};
		t.answer(q, true);
		assert_eq!(OpenDelete::Go(true), t.room(&own, 0));
		wrote(&mut held, "vault/q/b2.md", None, b"x");
		capture_into(&mut held, "vault/q/b2.md", Change { before: Some(b"x".to_vec()),
			found: Found::of(Some(b"x")), mark: true, ..Change::gone("vault/q/b2.md") });
		moving(&mut held, "vault/q/victim2.md", "vault/q/b2.md", USERS.as_bytes());
		let theirs = open_file_key("vault/q/b2.md", &against(&held, "vault/q/b2.md", USERS.as_bytes()));
		assert_ne!(own, theirs);
		assert!(matches!(t.room(&theirs, 0), OpenDelete::Ask(1, _)),
			"the user's file at a path already counted was not asked about");
		// One file, wiped and then deleted: both keep the same copy, and it is counted once.
		let mut one = OpenTally::new(4);
		let mut p: Vec<(String, Change)> = Vec::new();
		assert!(wrote(&mut p, "vault/p.md", Some(USERS.as_bytes()), b"."));
		let wipe = open_file_key("vault/p.md", USERS.as_bytes());
		assert_eq!(OpenDelete::Go(true), one.room(&wipe, 8));
		let delete = open_file_key("vault/p.md", &against(&p, "vault/p.md", b"."));
		assert_eq!(wipe, delete);
		assert_eq!(OpenDelete::Go(false), one.room(&delete, 8));
	}

	// ── Who ran a command (release 5.3.0, E1a) ───────────────────────────────────────────────

	fn seen(n: u64) -> Stamp {
		Stamp::Seen(n, Some(n))
	}

	fn agent(role: &str) -> Option<Author> {
		Some(Author { role: role.to_string(), m: fmt!("{}-model", role), ..Default::default() })
	}

	/// Run one call by `by` against `scope` the way the executor does: a walk to open it unless
	/// the last window's will serve, the call's own changes, and a walk to close it.  `walks`
	/// counts every walk taken.
	fn call(
		w:     &mut Windows,
		scope: &mut Snap,
		walks: &mut u32,
		by:    &Option<Author>,
		work:  impl FnOnce(&mut Snap),
	) {
		let (id, walk) = w.begin(by.clone());
		if walk {
			*walks += 1;
			w.began(id, scope.clone());
		}
		work(scope);
		w.finish(id);
		*walks += 1;
		w.ended(id, scope.clone());
	}

	fn credit_of<'a>(credits: &'a [Credit], path: &str) -> Option<&'a Credit> {
		credits.iter().find(|c| c.path == path)
	}

	#[test]
	fn test_a_command_s_change_is_credited_to_the_agent_that_ran_it() {
		let alice = agent("worker");
		let mut w = Windows::default();
		let mut scope = Snap::new();
		let mut walks = 0;
		call(&mut w, &mut scope, &mut walks, &alice, |s| { s.insert("out/a.txt".to_string(), seen(1)); });
		let got = attribute(&w.take(), &[]);
		let c = credit_of(&got, "out/a.txt").expect("the path the command made was not credited");
		let by = c.by.as_ref().expect("a command's change named nobody");
		assert_eq!(by.via, VIA_COMMAND);
		assert_eq!((by.role.as_str(), by.m.as_str()), ("worker", "worker-model"));
		assert_eq!(c.left, Some(seen(1)));
		// What the agent carried in is not altered but for the mark.
		assert_eq!(Author { via: String::new(), ..by.clone() }, alice.clone().unwrap_or_default());
	}

	#[test]
	fn test_changes_inside_overlapping_windows_of_two_agents_name_nobody() {
		let (alice, bob) = (agent("worker"), agent("daimon"));
		let mut w = Windows::default();
		let mut scope = Snap::new();
		let (a, walk) = w.begin(alice.clone());
		assert!(walk);
		w.began(a, scope.clone());
		scope.insert("h".to_string(), seen(1));			// alice's alone: before bob opens
		let (b, walk) = w.begin(bob.clone());
		assert!(walk, "a different author's window must walk for itself");
		w.began(b, scope.clone());
		scope.insert("f".to_string(), seen(2));			// inside both windows
		w.finish(a);
		w.ended(a, scope.clone());
		scope.insert("g".to_string(), seen(3));			// bob's alone: after alice has closed
		w.finish(b);
		w.ended(b, scope.clone());
		let got = attribute(&w.take(), &[]);
		assert_eq!(credit_of(&got, "h").map(|c| c.by.clone().map(|x| x.role)),
			Some(Some("worker".to_string())), "a change outside the overlap lost its author");
		assert_eq!(credit_of(&got, "g").map(|c| c.by.clone().map(|x| x.role)),
			Some(Some("daimon".to_string())), "a change outside the overlap lost its author");
		assert_eq!(credit_of(&got, "f").map(|c| c.by.clone()), Some(None),
			"a change inside two agents' overlap was credited to one of them");
	}

	#[test]
	fn test_an_unfinished_call_spoils_a_claim_it_overlaps_and_no_other() {
		let (alice, bob) = (agent("worker"), agent("daimon"));
		let mut w = Windows::default();
		let mut scope = Snap::new();
		let mut walks = 0;
		call(&mut w, &mut scope, &mut walks, &alice, |s| { s.insert("early".to_string(), seen(1)); });
		let (b, walk) = w.begin(bob.clone());
		assert!(walk);
		w.began(b, scope.clone());
		call(&mut w, &mut scope, &mut walks, &alice, |s| { s.insert("during".to_string(), seen(2)); });
		// Bob's call is still running at the turn end, or its future was dropped.
		let got = attribute(&w.take(), &[]);
		assert_eq!(credit_of(&got, "early").map(|c| c.by.is_some()), Some(true));
		assert_eq!(credit_of(&got, "during").map(|c| c.by.clone()), Some(None),
			"a change while another agent's call was in flight was credited");
		w.lost(b);
		let after = attribute(&w.take(), &[]);
		assert!(credit_of(&after, "early").is_none(), "a taken window was taken twice");
	}

	#[test]
	fn test_a_capture_keeps_its_author_inside_another_agent_s_window() {
		let (alice, bob) = (agent("worker"), agent("daimon"));
		let mut w = Windows::default();
		let mut scope = Snap::new();
		let mut walks = 0;
		// Alice's command runs while bob's file tool writes `p`, which bob's capture names.
		call(&mut w, &mut scope, &mut walks, &alice, |s| {
			s.insert("p".to_string(), seen(1));
			s.insert("q".to_string(), seen(2));
		});
		let held = vec![("p".to_string(), bob.clone())];
		let got = attribute(&w.take(), &held);
		let p = credit_of(&got, "p").expect("the captured path was dropped");
		assert_eq!(p.by, bob, "a capture lost its own author to a window");
		assert_eq!(p.by.as_ref().map(|a| a.via.as_str()), Some(""), "a capture is marked as a command's");
		assert_eq!(credit_of(&got, "q").and_then(|c| c.by.clone()).map(|a| a.via), Some(VIA_COMMAND.to_string()));
	}

	#[test]
	fn test_a_change_outside_every_window_is_not_the_turn_s() {
		let alice = agent("worker");
		let mut w = Windows::default();
		let mut scope = Snap::new();
		let mut walks = 0;
		call(&mut w, &mut scope, &mut walks, &alice, |s| { s.insert("x".to_string(), seen(1)); });
		// A person's edit, or a sync arrival, between two calls: something the store was told of.
		scope.insert("theirs".to_string(), seen(7));
		w.act();
		call(&mut w, &mut scope, &mut walks, &alice, |s| { s.insert("z".to_string(), seen(2)); });
		let got = attribute(&w.take(), &[]);
		let paths: Vec<&str> = got.iter().map(|c| c.path.as_str()).collect();
		assert_eq!(paths, vec!["x", "z"], "a change no window saw was filed under the turn");
		assert_eq!(walks, 4, "the second call began from a snapshot that predates the act");
	}

	#[test]
	fn test_seeded_files_are_not_in_the_turn_s_version() {
		let alice = agent("worker");
		let mut w = Windows::default();
		// `ensure_standing` ran at composition, before any window opened.
		let mut scope = Snap::new();
		for f in ["STATE.md", "REQUIREMENTS.md", "DECISIONS.md"] {
			scope.insert(format!("diamonds/d1/{}", f), seen(100));
		}
		// What a walk at the turn's end sees against a store that has never recorded them.
		assert_eq!(shifted(&Snap::new(), &scope).len(), 3);
		let mut walks = 0;
		call(&mut w, &mut scope, &mut walks, &alice, |s| {
			s.insert("diamonds/d1/out.txt".to_string(), seen(5));
		});
		let got = attribute(&w.take(), &[]);
		let paths: Vec<&str> = got.iter().map(|c| c.path.as_str()).collect();
		assert_eq!(paths, vec!["diamonds/d1/out.txt"]);
	}

	#[test]
	fn test_consecutive_windows_share_a_snapshot() {
		let (alice, bob) = (agent("worker"), agent("daimon"));
		let mut w = Windows::default();
		let mut scope = Snap::new();
		let mut walks = 0;
		for n in 1..=3u64 {
			call(&mut w, &mut scope, &mut walks, &alice, |s| {
				s.insert(fmt!("f{}", n), seen(n));
			});
		}
		assert_eq!(walks, 4, "three calls with nothing between them cost four walks");
		let got = attribute(&w.take(), &[]);
		for n in 1..=3 {
			assert!(credit_of(&got, &fmt!("f{}", n)).map(|c| c.by.is_some()).unwrap_or(false),
				"f{} was not credited through the shared boundary", n);
		}
		// Another agent's call between, or any act, ends the sharing.
		call(&mut w, &mut scope, &mut walks, &bob, |_| {});
		assert_eq!(walks, 6);
		call(&mut w, &mut scope, &mut walks, &alice, |_| {});
		assert_eq!(walks, 8, "a call began from a snapshot another agent's call had come after");
		w.act();
		call(&mut w, &mut scope, &mut walks, &alice, |_| {});
		assert_eq!(walks, 10, "a call began from a snapshot an act had come after");
		call(&mut w, &mut scope, &mut walks, &alice, |_| {});
		assert_eq!(walks, 11);
		// And so does a turn end: the next turn begins from a look of its own.
		let _ = w.take();
		call(&mut w, &mut scope, &mut walks, &alice, |_| {});
		assert_eq!(walks, 13, "a turn began from a snapshot the last turn took");
	}

	#[test]
	fn test_a_file_that_moved_is_told_from_one_that_was_only_listed() {
		let mut before = Snap::new();
		before.insert("same".to_string(), seen(1));
		before.insert("edited".to_string(), seen(2));
		before.insert("removed".to_string(), Stamp::Hashed("aa".to_string()));
		let mut after = before.clone();
		after.insert("edited".to_string(), Stamp::Seen(2, Some(3)));
		after.remove("removed");
		after.insert("made".to_string(), seen(4));
		let got = shifted(&before, &after);
		assert_eq!(got, vec![
			("edited".to_string(), Some(Stamp::Seen(2, Some(3)))),
			("made".to_string(), Some(seen(4))),
			("removed".to_string(), None),
		]);
	}

	/// The reader 5.2.9 shipped for an entry's author, ported as it was: `Author::from_json` at
	/// `<R529>`, which has no `via`.  A 5.3.0 manifest reaches 5.2.9 devices through sync.
	fn author_as_5_2_9_read_it(obj: &str) -> Option<(String, String, String, String, String)> {
		let role = match extract_json_string(obj, "role") {
			Some(r) if !r.is_empty()	=> r,
			_				=> return None,
		};
		Some((
			role,
			extract_json_string(obj, "m").unwrap_or_default(),
			extract_json_string(obj, "pv").unwrap_or_default(),
			extract_json_string(obj, "sp").unwrap_or_default(),
			extract_json_string(obj, "run").unwrap_or_default(),
		))
	}

	#[test]
	fn test_a_5_2_9_reader_parses_an_author_with_via() -> Outcome<()> {
		let by = Author {
			role: "worker".to_string(),
			m:    "glm-5p2".to_string(),
			pv:   "fireworks".to_string(),
			sp:   "sp1:3f9a0c12".to_string(),
			run:  "w-7".to_string(),
			via:  VIA_COMMAND.to_string(),
		};
		let mut row = e("out/a.txt", "new\n", Some("old\n"));
		row.by = Some(by.clone());
		let manifest = Manifest::new(Cause::Turn, 17, "m_1", "", vec![row.clone()]);
		let json = manifest.to_json();
		// The mark is nested, last, and after every key an older reader looks for.
		assert!(json.contains(",\"run\":\"w-7\",\"via\":\"command\"}"), "{}", json);
		let nested = res!(object_inside(&json, "by")
			.ok_or_else(|| err!("no `by` object in {}", json; Missing)));
		assert_eq!(author_as_5_2_9_read_it(nested), Some((
			"worker".to_string(), "glm-5p2".to_string(), "fireworks".to_string(),
			"sp1:3f9a0c12".to_string(), "w-7".to_string())));
		// And its row: the flat keys 5.2.9 extracts come before the nested object.
		assert_eq!(extract_json_string(&row.to_json(), "path").as_deref(), Some("out/a.txt"));
		// 5.3.0 reads it back whole.
		let back = res!(Manifest::from_json(&json));
		assert_eq!(back.files[0].by, Some(by));
		Ok(())
	}

	#[test]
	fn test_chain_undo_version_goes_back_past_the_last_change_00() -> Outcome<()> {
		// A write this turn: back to the version the Diamond is at.
		assert_eq!(chain_undo_version(&[1, 4], 6, true), Some(6));
		// Standing as recorded: back past the newest snapshot that changed it.
		assert_eq!(chain_undo_version(&[1, 4], 6, false), Some(3));
		assert_eq!(chain_undo_version(&[1, 4, 9], 6, false), Some(3));	// a snapshot above head is not this history
		// The first page ever written goes back to before it: no page, the shipped one.
		assert_eq!(chain_undo_version(&[1], 1, false), Some(0));
		// Recorded first at 0, or never: nothing earlier.
		assert_eq!(chain_undo_version(&[0], 3, false), None);
		assert_eq!(chain_undo_version(&[], 3, false), None);
		Ok(())
	}

	// ┌───────────────────────────────────────────────────────────────┐
	// │ Prune replay                                                   │
	// └───────────────────────────────────────────────────────────────┘

	const REPLAY: &str = include_str!("testdata/prune_replay_ontheism.txt");

	/// The store a replay file describes: the manifests, the bodies on disk, and the time.
	fn replay(text: &str) -> (Vec<(u64, Manifest)>, Vec<(String, u64)>, u64) {
		let mut ms: Vec<(u64, Manifest)> = Vec::new();
		let mut held: Vec<(String, u64)> = Vec::new();
		let mut now = 0u64;
		for line in text.lines().filter(|l| !l.starts_with('#')) {
			let cols: Vec<&str> = line.splitn(3, '\t').collect();
			match cols.as_slice() {
				["now", ts]		=> now = ts.parse().unwrap_or(0),
				["m", n, json]		=> match Manifest::from_json(json) {
					Ok(m)	=> ms.push((n.parse().unwrap_or(0), m)),
					Err(e)	=> panic!("replay manifest {} will not parse: {}", n, e),
				},
				["b", h, size]		=> held.push((h.to_string(), size.parse().unwrap_or(0))),
				_			=> panic!("replay line not understood: {}", line),
			}
		}
		(ms, held, now)
	}

	/// **The prune of 10 Oct 2026 kept the copies of the user's chapters** (history_prune_diag).
	/// Ontheism's v14, v18 and v19 held the only Daimond copies of chapters in the user's own
	/// folder, but rows written before the path decided whose a file is carried no `mark`, so the
	/// three ranked as ordinary turns and went before thirty later STATE-only versions.
	#[test]
	fn test_replay_of_the_ontheism_prune_keeps_copies_of_the_users_files_00() {
		let (ms, held, now) = replay(REPLAY);
		assert_eq!(38, ms.len());
		let caps = Caps { bytes: VERSIONS_BYTES_DEFAULT, manifests: MANIFESTS_MAX };
		let plan = prune_plan(&ms, &held, &[], caps, now, "diamonds/ont", &BTreeSet::new());
		for v in [14u64, 18, 19] {
			assert!(!plan.manifests.contains(&v),
				"v{} holds a copy of the user's file and was pruned: {:?}", v, plan.manifests);
		}
		assert!(!plan.manifests.is_empty(), "the store is over its ceiling and nothing went");
	}

	/// **A page's own data goes with the user's files, after the daimon's notes** (Life log,
	/// 10 Oct 2026, at 99.8% of its limit).  Its page appends the user's entries to
	/// `log/<lane>/<month>.jsonl` inside the Diamond, and those versions ranked as ordinary edits,
	/// so the next change would have pruned the oldest entries' history before the daimon's
	/// STATE.md rewrites.
	#[test]
	fn test_a_pages_own_data_outlasts_the_daimons_turn_edits_00() {
		let own = |p: &str| fmt!("{}/{}", HOME, p);
		let mut ms: Vec<(u64, Manifest)> = Vec::new();
		let mut bodies: Vec<String> = Vec::new();
		// Oldest first: four log entries by the page, then six turns rewriting STATE.md.
		for n in 1..=4u64 {
			let (now, was) = (fmt!("log {}", n), fmt!("log {}", n - 1));
			let mut row = e(&own("log/diet/2026-10.jsonl"), &now, Some(&was));
			row.door = true;
			ms.push((n, m(Cause::User, vec![row])));
			bodies.push(now);
			bodies.push(was);
		}
		for n in 5..=10u64 {
			let (now, was) = (fmt!("state {}", n), fmt!("state {}", n - 1));
			ms.push((n, m(Cause::Turn, vec![e(&own("STATE.md"), &now, Some(&was))])));
			bodies.push(now);
			bodies.push(was);
		}
		// A daimon turn that edits the page's data is the user's data too.
		ms.push((11, m(Cause::Turn, vec![e(&own("log/diet/2026-10.jsonl"), "lane b", Some("log 4"))])));
		bodies.push("lane b".to_string());
		ms.push((12, m(Cause::Turn, vec![e(&own("STATE.md"), "state 12", Some("state 10"))])));
		bodies.push("state 12".to_string());
		bodies.sort();
		bodies.dedup();
		let held: Vec<(String, u64)> = bodies.iter().map(|b| (hash_of(b.as_bytes()), 100u64)).collect();
		// Room for every version but the turns' notes: the turns must make room among themselves.
		let caps = Caps { bytes: 1_000, manifests: MANIFESTS_MAX };
		let plan = prune_plan(&ms, &held, &[], caps, LATER, HOME, &BTreeSet::new());
		assert!(!plan.manifests.is_empty(), "the store is over its ceiling and nothing went");
		for v in [1u64, 2, 3, 4, 11] {
			assert!(!plan.manifests.contains(&v),
				"v{} holds the page's data and went before a turn's notes: {:?}", v, plan.manifests);
		}
		assert!(is_page_data(HOME, &own("log/diet/2026-10.jsonl")));
		assert!(is_page_data(HOME, &own("cat/gym.json")));
		assert!(is_page_data(HOME, &own("index.json")), "a page may keep data at the top (A F1)");
		assert!(!is_page_data(HOME, &own("crystal.json")), "the keeper's own record");
		assert!(!is_page_data(HOME, &own("capp.json")), "the keeper's own record");
		assert!(!page_paths(&ms, HOME, &BTreeSet::new()).contains(&own("STATE.md")),
			"only turns wrote the daimon's notes");
		assert!(!is_page_data(HOME, &own("shots/a.png")));
		assert!(!is_page_data(HOME, &own(".daimond/log")));
		assert!(!is_page_data(HOME, "diamonds/other/log/x.jsonl"), "another Diamond's data");
		assert!(!is_page_data(HOME, "book/ch1.typ"), "the user's folder is not page data");
		assert!(is_users_path(HOME, "book/ch1.typ"));
		assert!(!is_users_path(HOME, &own("STATE.md")));
		assert!(is_users_path(HOME, "diamonds/tt/STATE.md"), "a keeper whose id begins with t's");
	}

	#[test]
	fn test_a_save_outlasts_turns_writing_a_subfolder_no_page_wrote_00() {
		// verify_versions arm 7 in miniature: turns rewrite `notes/p.md`, a subfolder of the
		// Diamond's own folder that no page and no user door has ever written. Those are the
		// daimon's notes, and they go before the Save.
		let own = |p: &str| fmt!("{}/{}", HOME, p);
		let mut ms: Vec<(u64, Manifest)> = Vec::new();
		let mut bodies: Vec<String> = vec!["saved".to_string()];
		ms.push((1, m(Cause::Save, vec![e(&own("notes/a.md"), "saved", None)])));
		for n in 2..=12u64 {
			let (now, was) = (fmt!("p {}", n), fmt!("p {}", n - 1));
			ms.push((n, m(Cause::Turn, vec![e(&own("notes/p.md"), &now, Some(&was))])));
			bodies.push(now);
			bodies.push(was);
		}
		bodies.sort();
		bodies.dedup();
		let held: Vec<(String, u64)> = bodies.iter().map(|b| (hash_of(b.as_bytes()), 100u64)).collect();
		let caps = Caps { bytes: 1_000, manifests: MANIFESTS_MAX };
		let plan = prune_plan(&ms, &held, &[], caps, LATER, HOME, &BTreeSet::new());
		assert!(!plan.manifests.is_empty(), "the store is over its ceiling and nothing went");
		assert!(!plan.manifests.contains(&1), "the Save went before the daimon's notes: {:?}",
			plan.manifests);
		let page = page_paths(&ms, HOME, &BTreeSet::new());
		assert!(page.is_empty(), "no page wrote anything: {:?}", page);
	}

	/// **A prune leaves a record of what it removed** (history_prune_diag, fix 3): the versions,
	/// their dates, the bodies and their bytes, and which bodies nothing had named.
	#[test]
	fn test_a_prune_records_what_it_removed_00() {
		let ms = vec![
			(1, Manifest::new(Cause::Turn, TS, "", "", vec![e(&fmt!("{}/STATE.md", HOME), "s1", Some("s0"))])),
			(2, Manifest::new(Cause::Turn, TS + 5, "", "", vec![e(&fmt!("{}/STATE.md", HOME), "s2", Some("s1"))])),
			(3, Manifest::new(Cause::Turn, TS + 9, "", "", vec![e(&fmt!("{}/STATE.md", HOME), "s3", Some("s2"))])),
		];
		let mut held: Vec<(String, u64)> = ["s0", "s1", "s2", "s3"].iter()
			.map(|b| (hash_of(b.as_bytes()), 100u64)).collect();
		held.push((hash_of(b"orphan"), 7));
		let caps = Caps { bytes: 200, manifests: MANIFESTS_MAX };
		let plan = prune_plan(&ms, &held, &[], caps, LATER, HOME, &BTreeSet::new());
		assert_eq!(vec![1, 2], plan.manifests);
		let rec = PruneRecord::of(&plan, &ms, &held, LATER, "record");
		assert_eq!(vec![1, 2], rec.versions);
		assert_eq!((TS, TS + 5), (rec.first, rec.last));
		assert_eq!(3, rec.bodies, "s0, s1 and the orphan: {:?}", plan.bodies);
		assert_eq!(1, rec.orphans);
		assert_eq!(207, rec.bytes);
		let log = prune_log_push("", &rec);
		assert_eq!(vec![rec.clone()], prune_log_read(&log));
		let mut long = String::new();
		for n in 0..(PRUNE_RECORDS_MAX as u64 + 3) {
			let mut r = rec.clone();
			r.ts = n;
			r.ids = vec![String::new(); r.versions.len()];	// the same versions again, by number only
			long = prune_log_push(&long, &r);
		}
		let back = prune_log_read(&long);
		assert_eq!(PRUNE_RECORDS_MAX, back.len());
		assert_eq!((3, PRUNE_SUMMARY), (back[0].ts, back[0].on.as_str()), "the oldest records fold");
		assert_eq!(vec![1, 2], back[0].versions);
		assert_eq!(4 * rec.bytes, back[0].bytes);
	}

	/// **A row an older build left unmarked reads back marked when its path is the user's.**
	#[test]
	fn test_settle_marks_decides_by_path_00() {
		let mut man = m(Cause::Turn, vec![
			e("book/ch1.typ", "b", Some("a")),
			e(&fmt!("{}/STATE.md", HOME), "d", Some("c")),
		]);
		man.files[1].mark = true;
		assert!(!man.files[0].mark);
		man.settle_marks(HOME);
		assert!(man.files[0].mark && !man.files[1].mark);
		assert!(man.keeps_users_file());
	}
}
#[cfg(test)]
mod qa_d26a {
	use super::*;

	const HOME: &str = "diamonds/t";
	const TS: u64 = 1_757_900_000_000;
	const LATER: u64 = TS + 30 * 24 * 60 * 60 * 1000;

	fn own(p: &str) -> String { fmt!("{}/{}", HOME, p) }
	fn e(path: &str, body: &str, was: Option<&str>) -> Entry {
		Entry::changed(path, body.as_bytes(), was.map(|s| hash_of(s.as_bytes())))
	}
	fn gone(path: &str, was: &str) -> Entry {
		let mut g = e(path, "", None);
		g.gone = true;
		g.hash = String::new();
		g.bytes = 0;
		g.was = Some(hash_of(was.as_bytes()));
		g
	}
	fn m(cause: Cause, files: Vec<Entry>) -> Manifest { Manifest::new(cause, TS, "m_1", "", files) }
	// A person's door wrote these rows: what `dirty_changes` records.
	fn dm(files: Vec<Entry>) -> Manifest {
		m(Cause::User, files.into_iter().map(|mut f| { f.door = true; f }).collect())
	}
	fn held_of(ms: &[(u64, Manifest)]) -> Vec<(String, u64)> {
		let mut hs: BTreeSet<String> = BTreeSet::new();
		for (_, mf) in ms.iter() { for h in mf.hashes() { hs.insert(h); } }
		hs.into_iter().map(|h| (h, 100u64)).collect()
	}
	fn scratch(ms: &mut Vec<(u64, Manifest)>, from: u64, to: u64) {
		for n in from..=to {
			let was = if n == from { None } else { Some(fmt!("s{}", n - 1)) };
			ms.push((n, m(Cause::Turn, vec![e(&own("STATE.md"), &fmt!("s{}", n), was.as_deref())])));
		}
	}
	fn plan(ms: &[(u64, Manifest)], bytes: u64) -> Prune {
		plan_known(ms, bytes, &BTreeSet::new())
	}
	fn plan_known(ms: &[(u64, Manifest)], bytes: u64, known: &BTreeSet<String>) -> Prune {
		prune_plan(ms, &held_of(ms), &[], Caps { bytes, manifests: MANIFESTS_MAX }, LATER, HOME, known)
	}

	// A1: page status erodes once the prune takes the last User manifest naming the path.
	#[test]
	fn qa_a1_page_status_survives_its_user_manifest_being_pruned() {
		let mut ms: Vec<(u64, Manifest)> = Vec::new();
		ms.push((1, dm(vec![e(&own("log/d.jsonl"), "L1", None)])));
		for n in 2..=5u64 {
			ms.push((n, m(Cause::Turn, vec![e(&own("log/d.jsonl"), &fmt!("L{}", n), Some(&fmt!("L{}", n - 1)))])));
		}
		scratch(&mut ms, 6, 15);
		let p1 = plan(&ms, 600);
		let known = p1.pages.clone();	// kept in PAGES_LOG before the deletes
		println!("A1 plan1 {:?} page {:?}", p1.manifests, known);
		ms.retain(|(n, _)| !p1.manifests.contains(n));
		scratch(&mut ms, 16, 25);
		// n=16 must chain from s15
		ms.retain(|(n, _)| *n != 16);
		ms.push((16, m(Cause::Turn, vec![e(&own("STATE.md"), "s16", Some("s15"))])));
		let p2 = plan_known(&ms, 1200, &known);
		println!("A1 plan2 {:?} page {:?}", p2.manifests, p2.pages);
		let page_gone: Vec<u64> = p2.manifests.iter().copied().filter(|n| *n >= 2 && *n <= 5).collect();
		let scratch_kept: Vec<u64> = (16..25u64).filter(|n| !p2.manifests.contains(n)).collect();
		assert!(page_gone.is_empty() || scratch_kept.is_empty(),
			"page-data versions {:?} pruned while daimon scratch {:?} survives", page_gone, scratch_kept);
	}

	// A2: a page (or the Files panel) writing a top-level file of the home.
	#[test]
	fn qa_a2_top_level_page_file_outlasts_scratch() {
		let mut ms: Vec<(u64, Manifest)> = Vec::new();
		for n in 1..=4u64 {
			let was = if n == 1 { None } else { Some(fmt!("E{}", n - 1)) };
			ms.push((n, dm(vec![e(&own("entries.jsonl"), &fmt!("E{}", n), was.as_deref())])));
		}
		scratch(&mut ms, 5, 10);
		let p = plan(&ms, 800);
		println!("A2 plan {:?}", p.manifests);
		let user_gone: Vec<u64> = p.manifests.iter().copied().filter(|n| *n <= 4).collect();
		let scratch_kept: Vec<u64> = (5..10u64).filter(|n| !p.manifests.contains(n)).collect();
		assert!(user_gone.is_empty() || scratch_kept.is_empty(),
			"the person's top-level writes {:?} pruned while scratch {:?} survives", user_gone, scratch_kept);
	}

	// A3: written first by the daimon, then by the person.
	#[test]
	fn qa_a3_daimon_first_then_person() {
		let mut ms: Vec<(u64, Manifest)> = Vec::new();
		ms.push((1, m(Cause::Turn, vec![e(&own("log/x.jsonl"), "X1", None)])));
		ms.push((2, m(Cause::Turn, vec![e(&own("log/x.jsonl"), "X2", Some("X1"))])));
		ms.push((3, dm(vec![e(&own("log/x.jsonl"), "X3", Some("X2"))])));
		scratch(&mut ms, 4, 12);
		let p = plan(&ms, 900);
		println!("A3 plan {:?}", p.manifests);
		let scratch_kept: Vec<u64> = (4..12u64).filter(|n| !p.manifests.contains(n)).collect();
		for v in [1u64, 2, 3] {
			assert!(!p.manifests.contains(&v) || scratch_kept.is_empty(), "v{} went before scratch {:?}", v, scratch_kept);
		}
	}

	// A4: the page's write drained into a Save (versions_save drains the dirty set as Cause::Save).
	#[test]
	fn qa_a4_page_write_recorded_by_save_is_page_data() {
		let mut ms: Vec<(u64, Manifest)> = Vec::new();
		// The page's write the Save drained from the dirty set carries `door`; its walk does not.
		let mut row = e(&own("log/x.jsonl"), "X1", None);
		row.door = true;
		ms.push((1, m(Cause::Save, vec![row, e(&own("notes/w.md"), "W", None)])));
		for n in 2..=4u64 {
			ms.push((n, m(Cause::Turn, vec![e(&own("log/x.jsonl"), &fmt!("X{}", n), Some(&fmt!("X{}", n - 1)))])));
		}
		scratch(&mut ms, 5, 14);
		let p = plan(&ms, 1100);
		println!("A4 plan {:?} page {:?}", p.manifests, p.pages);
		assert!(!p.pages.contains(&own("notes/w.md")), "the Save's walk made no page data: {:?}", p.pages);
		let page_gone: Vec<u64> = p.manifests.iter().copied().filter(|n| (2..=4).contains(n)).collect();
		let scratch_kept: Vec<u64> = (5..14u64).filter(|n| !p.manifests.contains(n)).collect();
		assert!(page_gone.is_empty() || scratch_kept.is_empty(),
			"edits of a page path the person Saved {:?} pruned while scratch {:?} survives", page_gone, scratch_kept);
	}

	// A5: the person renames a page file in the Files panel; later daimon edits of the new name.
	#[test]
	fn qa_a5_user_rename() {
		let mut ms: Vec<(u64, Manifest)> = Vec::new();
		ms.push((1, dm(vec![e(&own("log/a.jsonl"), "A1", None)])));
		ms.push((2, dm(vec![gone(&own("log/a.jsonl"), "A1"), e(&own("log/b.jsonl"), "A1", None)])));
		ms.push((3, m(Cause::Turn, vec![e(&own("log/b.jsonl"), "B3", Some("A1"))])));
		scratch(&mut ms, 4, 12);
		let p = plan(&ms, 800);
		println!("A5 plan {:?}", p.manifests);
		let scratch_kept: Vec<u64> = (4..12u64).filter(|n| !p.manifests.contains(n)).collect();
		for v in [1u64, 2, 3] {
			assert!(!p.manifests.contains(&v) || scratch_kept.is_empty(), "v{} went before scratch {:?}", v, scratch_kept);
		}
	}

	// A6: the daimon moves a page file to a new subfolder and keeps editing it there.
	#[test]
	fn qa_a6_daimon_moves_page_file() {
		let mut ms: Vec<(u64, Manifest)> = Vec::new();
		ms.push((1, dm(vec![e(&own("log/a.jsonl"), "A1", None)])));
		ms.push((2, m(Cause::Turn, vec![gone(&own("log/a.jsonl"), "A1"), e(&own("arch/a.jsonl"), "A1", None)])));
		for n in 3..=5u64 {
			let was = if n == 3 { "A1".to_string() } else { fmt!("R{}", n - 1) };
			ms.push((n, m(Cause::Turn, vec![e(&own("arch/a.jsonl"), &fmt!("R{}", n), Some(&was))])));
		}
		scratch(&mut ms, 6, 14);
		let p = plan(&ms, 1000);
		println!("A6 plan {:?} page {:?}", p.manifests, page_paths(&ms, HOME, &BTreeSet::new()));
		let moved_gone: Vec<u64> = p.manifests.iter().copied().filter(|n| (3..=5).contains(n)).collect();
		let scratch_kept: Vec<u64> = (6..14u64).filter(|n| !p.manifests.contains(n)).collect();
		assert!(moved_gone.is_empty() || scratch_kept.is_empty(),
			"the moved page file's versions {:?} pruned while scratch {:?} survives", moved_gone, scratch_kept);
	}

	// A7: deleted by the daimon then recreated (by the daimon, then the page).
	#[test]
	fn qa_a7_deleted_then_recreated() {
		let mut ms: Vec<(u64, Manifest)> = Vec::new();
		ms.push((1, dm(vec![e(&own("log/x.jsonl"), "X1", None)])));
		ms.push((2, m(Cause::Turn, vec![gone(&own("log/x.jsonl"), "X1")])));
		ms.push((3, m(Cause::Turn, vec![e(&own("log/x.jsonl"), "Y3", None)])));
		ms.push((4, dm(vec![e(&own("log/x.jsonl"), "Y4", Some("Y3"))])));
		scratch(&mut ms, 5, 13);
		let p = plan(&ms, 900);
		println!("A7 plan {:?}", p.manifests);
		let scratch_kept: Vec<u64> = (5..13u64).filter(|n| !p.manifests.contains(n)).collect();
		for v in [1u64, 2, 3, 4] {
			assert!(!p.manifests.contains(&v) || scratch_kept.is_empty(), "v{} went before scratch {:?}", v, scratch_kept);
		}
	}

	// A8: a prune whose manifest deletes failed is planned and recorded again. Since HISTFIX2 fix 3
	// the prune is two-phase (prune_held): intent, deletes, then a final record of what went.
	fn two_phase(log: &str, ms: &mut Vec<(u64, Manifest)>, bytes: u64, now: u64, fails: &[u64]) -> String {
		let held = held_of(ms);
		let p = plan(ms, bytes);
		let intent = PruneRecord::of(&p, ms, &held, now, PRUNE_INTENT);
		let logged = prune_log_push(log, &intent);
		let removed: Vec<u64> = p.manifests.iter().copied().filter(|n| !fails.contains(n)).collect();
		let fin = PruneRecord::of_removed(&removed, &[], ms, &held, now, "record");
		ms.retain(|(n, _)| !removed.contains(n));
		prune_log_finish(&logged, now, &fin)
	}
	#[test]
	fn qa_a8_failed_delete_is_recorded_twice() {
		let mut ms: Vec<(u64, Manifest)> = Vec::new();
		scratch(&mut ms, 1, 12);
		let all: Vec<u64> = (1..=12).collect();
		// every delete failed: ms unchanged
		let log1 = two_phase("", &mut ms, 800, LATER, &all);
		let log2 = two_phase(&log1, &mut ms, 800, LATER + 1, &all);
		let recs = prune_log_read(&log2);
		let total: usize = recs.iter().map(|r| r.versions.len()).sum();
		let distinct: BTreeSet<u64> = recs.iter().flat_map(|r| r.versions.iter().copied()).collect();
		println!("A8 records {} versions counted {} distinct {}", recs.len(), total, distinct.len());
		assert_eq!(total, distinct.len(), "versions counted twice across records: {:?}", recs);
		let present: BTreeSet<u64> = ms.iter().map(|(n, _)| *n).collect();
		assert!(distinct.is_disjoint(&present), "a record names versions still held: {:?}", recs);
		// Half the deletes fail, then the next prune takes them: each version named once, when it went.
		let log3 = two_phase(&log2, &mut ms, 800, LATER + 2, &[2, 4]);
		let log4 = two_phase(&log3, &mut ms, 800, LATER + 3, &[]);
		let recs = prune_log_read(&log4);
		let total: usize = recs.iter().map(|r| r.versions.len()).sum();
		let named: BTreeSet<u64> = recs.iter().flat_map(|r| r.versions.iter().copied()).collect();
		let present: BTreeSet<u64> = ms.iter().map(|(n, _)| *n).collect();
		println!("A8b records {:?} present {:?}", recs.iter().map(|r| r.versions.clone()).collect::<Vec<_>>(), present);
		assert_eq!(total, named.len(), "versions counted twice: {:?}", recs);
		assert!(named.is_disjoint(&present));
		assert!(named.contains(&2) && named.contains(&4), "the retried versions went unrecorded");
		assert!(recs.iter().all(|r| r.on != PRUNE_INTENT), "an intent outlived its prune");
	}

	// Fix 3: a prune cut short between its intent and its final record. The intent is settled
	// against what is gone: only deleted versions are named, and an intent naming none goes.
	#[test]
	fn qa_f3_interrupted_intent_names_only_what_went() {
		let mut ms: Vec<(u64, Manifest)> = Vec::new();
		scratch(&mut ms, 1, 12);
		let held = held_of(&ms);
		let p = plan(&ms, 800);
		assert!(p.manifests.len() >= 3, "{:?}", p.manifests);
		let log = prune_log_push("", &PruneRecord::of(&p, &ms, &held, LATER, PRUNE_INTENT));
		// the crash: only the first planned manifest was deleted
		let gone = p.manifests[0];
		ms.retain(|(n, _)| *n != gone);
		let present: BTreeSet<u64> = ms.iter().map(|(n, _)| *n).collect();
		let (recs, moved) = prune_settle(prune_log_read(&log), &present);
		assert!(moved);
		assert_eq!(1, recs.len());
		assert_eq!((vec![gone], PRUNE_INTERRUPTED), (recs[0].versions.clone(), recs[0].on.as_str()));
		// nothing deleted at all: the intent leaves no row
		let all: BTreeSet<u64> = (1..=12).collect();
		let (none, _) = prune_settle(prune_log_read(&log), &all);
		assert!(none.is_empty(), "{:?}", none);
		// a log with no intent is not rewritten
		let fin = prune_log_finish(&log, LATER, &PruneRecord::of(&p, &ms, &held, LATER, "record"));
		assert!(!prune_settle(prune_log_read(&fin), &present).1);
	}

	// A9: the record log keeps 20; the 21st prune drops the first record.
	#[test]
	fn qa_a9_record_cap_forgets_prunes() {
		let mut log = String::new();
		for i in 0..21u64 {
			let r = PruneRecord { ts: i, on: "record".into(), versions: vec![i], first: i, last: i, bodies: 1, orphans: 0, bytes: 1, ..Default::default() };
			log = prune_log_push(&log, &r);
		}
		let recs = prune_log_read(&log);
		let named: BTreeSet<u64> = recs.iter().flat_map(|r| r.versions.iter().copied()).collect();
		println!("A9 kept {} records, v0 named: {}", recs.len(), named.contains(&0));
		assert!(named.contains(&0), "version 0 was pruned and no record names it any more");
	}

	// B P6 as a unit: a store at its version limit, 230 saves of page data. Every version History
	// no longer holds is named by a prune row, none it still holds is, and the rows outlast 20 saves.
	#[test]
	fn qa_b_p6_rows_survive_many_saves_at_the_limit() {
		let mut ms: Vec<(u64, Manifest)> = Vec::new();
		let mut log = String::new();
		let mut rows_seen = 0usize;
		for n in 1..=230u64 {
			let was = if n == 1 { None } else { Some(fmt!("L{}", n - 1)) };
			ms.push((n, dm(vec![e(&own("lanes/log.json"), &fmt!("L{}", n), was.as_deref())])));
			let p = plan(&ms, u64::MAX);
			if !p.manifests.is_empty() {
				let r = PruneRecord::of(&p, &ms, &held_of(&ms), LATER + n, "record");
				log = prune_log_push(&log, &r);
				ms.retain(|(v, _)| !p.manifests.contains(v));
				rows_seen += 1;
			}
		}
		let recs = prune_log_read(&log);
		let named: BTreeSet<u64> = recs.iter().flat_map(|r| r.versions.iter().copied()).collect();
		let present: BTreeSet<u64> = ms.iter().map(|(v, _)| *v).collect();
		let unexplained: Vec<u64> = (1..=230u64)
			.filter(|v| !present.contains(v) && !named.contains(v)).collect();
		let both: Vec<u64> = named.intersection(&present).copied().collect();
		println!("B P6 held {} prunes {} rows {} unexplained {}", present.len(), rows_seen, recs.len(), unexplained.len());
		assert!(present.len() <= MANIFESTS_MAX);
		assert!(unexplained.is_empty(), "versions gone with no prune row: {:?}", unexplained);
		assert!(both.is_empty(), "prune rows name versions still held: {:?}", both);
		assert!(rows_seen <= 3, "a store at its limit prunes in rare batches, not once per save: {} prunes", rows_seen);
	}

	// A10: the shipped Life log page saves `index.json` at the top of its home (crystal.html:1668).
	#[test]
	fn qa_a10_lifelog_index_json_is_page_data() {
		assert!(is_page_data(HOME, &own("lanes/diet.json")), "lanes/ is page data");
		let mut ms: Vec<(u64, Manifest)> = Vec::new();
		for n in 1..=3u64 {
			let was = if n == 1 { None } else { Some(fmt!("I{}", n - 1)) };
			ms.push((n, dm(vec![e(&own("index.json"), &fmt!("I{}", n), was.as_deref())])));
		}
		scratch(&mut ms, 4, 10);
		let p = plan(&ms, 800);
		println!("A10 plan {:?} index.json page data: {}", p.manifests, is_page_data(HOME, &own("index.json")));
		let gone: Vec<u64> = p.manifests.iter().copied().filter(|n| *n <= 3).collect();
		assert!(gone.is_empty(), "the Life log's index.json versions {:?} went before the daimon's STATE.md", gone);
	}

	// A manifest from before rows carried `door` is read by its cause.
	#[test]
	fn qa_a11_legacy_user_manifest_is_page_data() {
		let mut old = m(Cause::User, vec![e(&own("index.json"), "I1", None)]);
		old.v = 1;
		let now = m(Cause::User, vec![e(&own("STATE.md"), "S1", None)]);
		let page = page_paths(&[(1, old), (2, now)], HOME, &BTreeSet::new());
		assert!(page.contains(&own("index.json")), "{:?}", page);
		assert!(!page.contains(&own("STATE.md")), "a v2 walk row is not a door's: {:?}", page);
	}

	// The store's page list reads back what it wrote, and is joined, never replaced.
	#[test]
	fn qa_a12_pages_log_round_trip() {
		let mut set: BTreeSet<String> = BTreeSet::new();
		set.insert(own("log/a \"b\".jsonl"));
		set.insert(own("index.json"));
		let back = pages_read(&pages_json(&set));
		assert_eq!(set, back);
		assert!(pages_read("").is_empty() && pages_read("not json").is_empty());
		let known: BTreeSet<String> = [own("index.json"), "book/x.typ".to_string()].into_iter().collect();
		let page = page_paths(&[], HOME, &known);
		assert_eq!(vec![own("index.json")], page.into_iter().collect::<Vec<_>>(), "only page-data paths");
	}

	// Fix 4 (A F5, B F2): manifests 1..=n, each its own content, so each has its own identity.
	fn run(n: u64) -> Vec<(u64, Manifest)> {
		(1..=n).map(|v| (v, dm(vec![e(&own("log/a.jsonl"), &fmt!("L{}", v), None)]))).collect()
	}

	fn named(json: &str) -> Vec<u64> {
		prune_log_read(json).iter().filter(|r| !r.is_renumber())
			.flat_map(|r| r.versions.iter().copied()).collect()
	}

	// An arriving log is joined with this device's, never laid over it: B2's local prunes stay.
	#[test]
	fn qa_f4_import_joins_prune_logs() {
		let ms = run(18);
		let rec = |vs: &[u64], ts: u64, on: &str| PruneRecord::of_removed(vs, &[], &ms, &[], ts, on);
		let mut mine = String::new();
		for (i, vs) in [vec![2u64, 3], vec![4], vec![12], vec![13, 14], vec![15, 16, 17, 18]].iter().enumerate() {
			mine = prune_log_push(&mine, &rec(vs, LATER + i as u64, "record"));
		}
		let mut theirs = String::new();
		theirs = prune_log_push(&theirs, &rec(&[2, 3], LATER, "record"));	// shared history
		theirs = prune_log_push(&theirs, &rec(&[4], LATER + 1, "record"));
		theirs = prune_log_push(&theirs, &rec(&[5, 6], LATER + 9, "record"));	// theirs alone
		theirs = prune_log_push(&theirs, &rec(&[7], LATER + 10, PRUNE_INTENT));	// in flight there
		let all = prune_log_merge(&mine, &theirs);
		let mut got = named(&all);
		got.sort();
		assert_eq!(vec![2u64, 3, 4, 5, 6, 12, 13, 14, 15, 16, 17, 18], got, "{}", all);
		assert!(prune_log_read(&all).iter().all(|r| r.on != PRUNE_INTENT), "{}", all);
		assert_eq!(all, prune_log_merge(&all, &all), "a log joined with itself is itself");
		// A summary of this device's stays whatever arrives.
		let ms30 = run(30);
		let mut big = String::new();
		for i in 0..25u64 {
			big = prune_log_push(&big, &PruneRecord::of_removed(&[i + 1], &[], &ms30, &[], LATER + 100 + i, "record"));
		}
		let sum = prune_log_merge(&big, "");
		assert!(prune_log_read(&sum).iter().any(|r| r.on == PRUNE_SUMMARY), "{}", sum);
		assert!(prune_log_read(&prune_log_merge(&sum, &theirs)).iter().any(|r| r.on == PRUNE_SUMMARY));
	}

	// A copy of a pruned version that arrives and is pruned again is recorded once (B F2, PEERAT=3).
	#[test]
	fn qa_f4_repruned_arrival_named_once() {
		let ms = run(5);
		let mut log = prune_log_push("", &PruneRecord::of_removed(&[2, 3, 4, 5], &[], &ms, &[], LATER, "record"));
		log = prune_log_finish(&log, LATER + 1,
			&PruneRecord::of_removed(&[2, 3, 4, 5], &[], &ms, &[], LATER + 1, "arrival"));
		assert_eq!(vec![2u64, 3, 4, 5], named(&log), "{}", log);
		// Another version, same number, is another version: it is named.
		let other = vec![(2u64, dm(vec![e(&own("log/a.jsonl"), "elsewhere", None)]))];
		log = prune_log_push(&log, &PruneRecord::of_removed(&[2], &[], &other, &[], LATER + 2, "arrival"));
		assert_eq!(vec![2u64, 3, 4, 5, 2], named(&log), "{}", log);
		// A record from before identities keeps every number it names.
		let old = "[{\"ts\":5,\"on\":\"record\",\"versions\":[2,3],\"first\":1,\"last\":2,\"bodies\":1,\"orphans\":0,\"bytes\":9}]";
		let back = prune_log_read(&prune_log_merge(old, ""));
		assert_eq!(vec![2u64, 3], back[0].versions);
		assert_eq!(vec![String::new(), String::new()], back[0].ids);
		// A pruned version a copy brought back is not shown as gone; the log still says it went.
		let shown = prune_shown(prune_log_read(&log), &ms[2..3]);
		let vs: Vec<u64> = shown.iter().flat_map(|r| r.versions.iter().copied()).collect();
		assert_eq!(vec![2u64, 4, 5, 2], vs, "v3 is held again");
	}

	// A refile's renumbering is its own row, never read as a prune nor folded into one.
	#[test]
	fn qa_f4_renumber_row() {
		let ms = run(16);
		let r = PruneRecord::renumbered(&[(15, 21), (14, 20), (16, 22)], &ms, LATER);
		assert!(r.is_renumber());
		assert_eq!((vec![14u64, 15, 16], vec![20u64, 21, 22]), (r.versions.clone(), r.to.clone()));
		let mut log = prune_log_push("", &r);
		let back = prune_log_read(&log);
		assert_eq!(r, back[0], "round trip: {}", log);
		let ms30 = run(30);
		for i in 0..30u64 {
			log = prune_log_push(&log, &PruneRecord::of_removed(&[i + 1], &[], &ms30, &[], LATER + 1 + i, "record"));
		}
		let recs = prune_log_read(&log);
		let ren: Vec<&PruneRecord> = recs.iter().filter(|x| x.is_renumber()).collect();
		assert_eq!(1, ren.len(), "{}", log);
		assert_eq!(vec![20u64, 21, 22], ren[0].to);
		assert!(recs.iter().filter(|x| !x.is_renumber()).all(|x| x.to.is_empty()));
		// Past the bound, renumbering rows fold into one renumbering row, each old number beside its new.
		let mut many = String::new();
		for i in 0..25u64 {
			many = prune_log_push(&many, &PruneRecord::renumbered(&[(i + 1, i + 100)], &run(26), LATER + i));
		}
		let rs = prune_log_read(&many);
		assert!(rs.len() <= PRUNE_RECORDS_MAX && rs.iter().all(|x| x.is_renumber()), "{}", many);
		let pairs: Vec<(u64, u64)> = rs.iter().flat_map(|x| x.versions.iter().copied().zip(x.to.iter().copied())).collect();
		assert_eq!(25, pairs.len());
		assert!(pairs.iter().all(|(a, b)| *b == *a + 99), "{:?}", pairs);
	}

	// After a refile a prune record names the number its version now stands at (B2: this device's
	// pruned v12-v18, whose memory moved to v22-v28, read as 12-18 and as the renumbered 12-21).
	#[test]
	fn qa_f4_refile_renumbers_prune_records() {
		let ms = run(21);
		let mut log = prune_log_push("", &PruneRecord::of_removed(&[2, 3], &[], &ms, &[], LATER, "record"));
		log = prune_log_push(&log, &PruneRecord::of_removed(&[12, 13], &[], &ms, &[], LATER + 1, "record"));
		let moves: Vec<(u64, u64)> = (12..=21u64).map(|v| (v, v + 10)).collect();
		let row = PruneRecord::renumbered(&moves, &ms, LATER + 2);
		let out = prune_log_read(&prune_log_refiled(&log, &moves, &row));
		let prunes: Vec<Vec<u64>> = out.iter().filter(|r| !r.is_renumber()).map(|r| r.versions.clone()).collect();
		assert_eq!(vec![vec![2u64, 3], vec![22, 23]], prunes);
		let ren: Vec<&PruneRecord> = out.iter().filter(|r| r.is_renumber()).collect();
		assert_eq!(1, ren.len());
		assert_eq!((12..=21u64).collect::<Vec<_>>(), ren[0].versions);
		assert_eq!(prune_log_read(&log)[1].ids, out[1].ids, "who they are does not move");
	}

	// Fix 3b: a version being written has its bodies down and no manifest yet. A prune whose intent
	// write is refused sweeps unnamed bodies, then deletes and sweeps again; the version completes,
	// and every body it names must be there.
	#[test]
	fn qa_f3b_sweep_leaves_a_version_being_written() {
		let mut ms: Vec<(u64, Manifest)> = Vec::new();
		scratch(&mut ms, 1, 12);
		let now = LATER;
		let start = now - 2_000;				// the write began two seconds ago
		// Its bodies: one it wrote, one it found already there (an orphan of long ago).
		let fresh = hash_of(b"being written");
		let found = hash_of(b"old orphan");
		let mut disk: Vec<(String, u64)> = held_of(&ms);
		disk.push((fresh.clone(), 100));
		disk.push((found.clone(), 100));
		let mut stamps: BTreeMap<String, u64> = disk.iter().map(|(h, _)| (h.clone(), TS)).collect();
		stamps.insert(fresh.clone(), start + 500);
		let claimed: BTreeSet<String> = [fresh.clone(), found.clone()].into_iter().collect();
		let f = InFlight::of((Some(start), claimed.clone()), Some(&[]), now);
		let cutoff = sweep_cutoff(now, &f);
		let p = prune_plan(&ms, &disk, &[], Caps { bytes: 800, manifests: MANIFESTS_MAX }, now, HOME,
			&BTreeSet::new());
		assert!(p.bodies.contains(&fresh) && p.bodies.contains(&found), "{:?}", p.bodies);
		let mut on_disk: BTreeSet<String> = disk.iter().map(|(h, _)| h.clone()).collect();
		// The intent write is refused: the orphan-only sweep.
		for h in sweepable(&ms, &p.bodies, &stamps, cutoff, &claimed) { on_disk.remove(&h); }
		// The deletes, then the sweep of what no surviving manifest names.
		ms.retain(|(n, _)| !p.manifests.contains(n));
		for h in sweepable(&ms, &p.bodies, &stamps, cutoff, &claimed) { on_disk.remove(&h); }
		// The version completes.
		let v = m(Cause::Turn, vec![e(&own("a.md"), "being written", None), e(&own("b.md"), "old orphan", None)]);
		let missing: Vec<String> = v.hashes().into_iter().filter(|h| !on_disk.contains(h)).collect();
		assert!(missing.is_empty(), "the new version names bodies the sweep took: {:?}", missing);
		// Past the grace window and with no write in flight, an orphan does go.
		let late = sweepable(&ms, &p.bodies, &stamps, sweep_cutoff(now, &InFlight::default()), &BTreeSet::new());
		assert!(late.contains(&fresh) && late.contains(&found), "{:?}", late);
	}

	// prune_held's selection: the plan with the bodies the sweep must leave weighed, the deletes,
	// then the sweep of what no surviving manifest names.  What it leaves on disk.
	fn prune_as_held(
		ms:		&mut Vec<(u64, Manifest)>,
		disk:	&mut Vec<(String, u64)>,
		stamps:	&BTreeMap<String, u64>,
		f:		&InFlight,
		cap:	u64,
		now:	u64,
	) {
		let pinned = staying(ms, disk, stamps, f, now);
		let p = prune_plan(ms, disk, &pinned, Caps { bytes: cap, manifests: MANIFESTS_MAX }, now, HOME,
			&BTreeSet::new());
		ms.retain(|(n, _)| !p.manifests.contains(n));
		let gone = sweepable(ms, &p.bodies, stamps, sweep_cutoff(now, f), &f.claimed);
		disk.retain(|(h, _)| !gone.contains(h));
	}

	// H-b: tab B's write is in flight -- a slow one, its lease renewed, one body written over a
	// minute ago and one found already there as an orphan of long ago -- while tab A sweeps.  B's
	// bodies stay, and B's version lands whole.
	#[test]
	fn qa_hf2_b_another_tabs_write_in_flight_keeps_its_bodies() -> Outcome<()> {
		let mut ms: Vec<(u64, Manifest)> = Vec::new();
		scratch(&mut ms, 1, 12);
		let now = LATER;
		let fresh = hash_of(b"being written");
		let found = hash_of(b"old orphan");
		let mut disk = held_of(&ms);
		disk.push((fresh.clone(), 100));
		disk.push((found.clone(), 100));
		let mut stamps: BTreeMap<String, u64> = disk.iter().map(|(h, _)| (h.clone(), TS)).collect();
		stamps.insert(fresh.clone(), now - 90_000);
		let mut b = Claim::new("tabB", 7, vec![fresh.clone(), found.clone()], now - 100_000);
		b.until = now + CLAIM_LEASE_MS / 2;	// renewed while it runs
		let other = Claim::new("tabC", 1, vec![], now - 1_000);
		// The file as tab A reads it, under the hold.
		let claims = res!(claims_read(&claims_json(&[b.clone(), other])));
		assert_eq!(b, claims[0]);
		let f = InFlight::of((None, BTreeSet::new()), Some(&claims), now);
		prune_as_held(&mut ms, &mut disk, &stamps, &f, 800, now);
		let v = m(Cause::Turn, vec![e(&own("a.md"), "being written", None), e(&own("b.md"), "old orphan", None)]);
		let missing: Vec<String> = v.hashes().into_iter().filter(|h| !disk.iter().any(|(d, _)| d == h)).collect();
		assert!(missing.is_empty(), "B's version names bodies A's sweep took: {:?}", missing);
		// And the store is held to its cap with B's bodies weighed.
		assert!(disk_bytes(&disk) <= 800, "{} bytes on disk", disk_bytes(&disk));
		Ok(())
	}

	// H-c: a tab killed mid-write leaves its claim and its bodies.  While the lease runs they stay
	// and are weighed, so the disk is held under the cap; past the lease the claim is ignored and
	// cleared, and the next sweep collects them.
	#[test]
	fn qa_hf2_c_a_killed_tabs_claim_expires_and_its_orphans_go() -> Outcome<()> {
		let mut ms: Vec<(u64, Manifest)> = Vec::new();
		scratch(&mut ms, 1, 12);
		let t0 = LATER;
		let orphans: Vec<String> = (0..3).map(|i| hash_of(fmt!("killed {}", i).as_bytes())).collect();
		let mut disk = held_of(&ms);
		for o in orphans.iter() { disk.push((o.clone(), 300)); }
		let mut stamps: BTreeMap<String, u64> = disk.iter().map(|(h, _)| (h.clone(), TS)).collect();
		for o in orphans.iter() { stamps.insert(o.clone(), t0 + 1_000); }
		let dead = Claim::new("tabK", 3, orphans.clone(), t0);
		let claims = res!(claims_read(&claims_json(&[dead.clone()])));
		// The lease runs: kept, and weighed.
		let now1 = t0 + 10_000;
		let f1 = InFlight::of((None, BTreeSet::new()), Some(&claims), now1);
		assert!(f1.expired.is_empty());
		prune_as_held(&mut ms, &mut disk, &stamps, &f1, 1_400, now1);
		for o in orphans.iter() { assert!(disk.iter().any(|(d, _)| d == o), "taken under a live lease"); }
		assert!(disk_bytes(&disk) <= 1_400, "{} bytes on disk under a live claim", disk_bytes(&disk));
		// Past the lease: ignored, cleared, collected.
		let now2 = dead.until + 1;
		let f2 = InFlight::of((None, BTreeSet::new()), Some(&claims), now2);
		assert_eq!(vec![dead], f2.expired);
		assert!(InFlight::kept(&claims, now2).is_empty());
		prune_as_held(&mut ms, &mut disk, &stamps, &f2, 1_400, now2);
		for o in orphans.iter() { assert!(!disk.iter().any(|(d, _)| d == o), "left past the lease"); }
		assert!(disk_bytes(&disk) <= 1_400);
		Ok(())
	}

	// H-d: a claims file that will not read is a write the sweep cannot see: it falls back to the
	// grace window, so a body in flight stays, and an orphan of long ago still goes.
	#[test]
	fn qa_hf2_d_unreadable_claims_fall_back_to_the_grace_window() {
		for bad in ["", "garbage", "[{\"tab\":\"x\"", "[{\"tab\":\"x\",\"token\":1}]"] {
			assert!(claims_read(bad).is_err(), "{:?} read", bad);
		}
		assert_eq!(Ok(0), claims_read(" [ ] ").map(|c| c.len()).map_err(|_| ()));
		let mut ms: Vec<(u64, Manifest)> = Vec::new();
		scratch(&mut ms, 1, 12);
		let now = LATER;
		let fresh = hash_of(b"being written");
		let old = hash_of(b"old orphan");
		let mut disk = held_of(&ms);
		disk.push((fresh.clone(), 100));
		disk.push((old.clone(), 100));
		let mut stamps: BTreeMap<String, u64> = disk.iter().map(|(h, _)| (h.clone(), TS)).collect();
		stamps.insert(fresh.clone(), now - 5_000);
		let f = InFlight::of((None, BTreeSet::new()), None, now);
		assert!(f.blind);
		assert_eq!(Some(now - SWEEP_GRACE_MS), sweep_cutoff(now, &f));
		prune_as_held(&mut ms, &mut disk, &stamps, &f, 800, now);
		assert!(disk.iter().any(|(d, _)| *d == fresh), "a body in flight was taken blind");
		assert!(!disk.iter().any(|(d, _)| *d == old), "an orphan of long ago was kept");
	}
}
