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

use crate::llm::{extract_json_bool, extract_json_number, extract_json_objects,
	extract_json_string, extract_json_string_array, json_escape};
use crate::rating::Author;

use oxedyne_fe2o3_core::prelude::*;
use oxedyne_fe2o3_jdat::{FromDat, ToDat};
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

/// The most one kept copy may weigh, in bytes: `None`, no cap, until the owner decides (spec
/// §16.3a, d1_plan §9.10).  Set, an act whose copy would pass it is refused at [`claim_room`],
/// before it lands, as a delete of a file too large to keep is refused, so History never shows a
/// row whose bytes it could not put back.  An `after` is never bound by it, since none over
/// [`VERSION_FILE_MAX`] is kept, and a body kept under an earlier setting stays readable.
pub const BODY_KEEP_MAX: Option<u64> = None;

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
#[derive(Clone, Copy, Debug, Eq, PartialEq, ToDat, FromDat)]
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

/// The changes to the user's files a turn was told not to make (UNBLOCK-26 U3): the paths the
/// person answered "Don't change" for, or left unanswered, while the turn asked.
///
/// **A no is final for the rest of the turn**, as the open folder's stop is ([`OpenTally`]): a
/// retry, a worker, or the same change by another verb is refused without asking again.  It holds
/// through a folder both ways -- a no to a folder's move refuses each file in it, and a no to one
/// file refuses the move of a folder that carries it -- since either is the change he declined,
/// made another way.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ChangeRefusals {
	paths: BTreeSet<String>,	// as the captures name them: normalised, or absolute on the machine
}

impl ChangeRefusals {

	pub fn refuse(&mut self, path: &str) {
		self.paths.insert(path.trim_end_matches('/').to_string());
	}

	/// Did the person decline a change to `path`, or to a folder it is in, or to a file in it?
	pub fn refused(&self, path: &str) -> bool {
		let p = path.trim_end_matches('/');
		let inside = |a: &str, b: &str| a == b || (a.starts_with(b) && a[b.len()..].starts_with('/'));
		self.paths.iter().any(|r| inside(p, r) || inside(r, p))
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
#[derive(Clone, Copy, Debug, Eq, PartialEq, ToDat, FromDat)]
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
	pub made:    bool,		// a turn's own act found nothing there and made the file: see `made_by_turns`
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
			made:    false,
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
		// Written only when true, so a row from before it existed reads as one that vouches for
		// nothing: a file made then is asked about as the user's, which is the safe way to be wrong.
		if self.made {
			out.push_str(",\"made\":true");
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
			made:    extract_json_bool(s, "made").unwrap_or(false),
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
	pub away:      Option<Away>,	// a turn another device ran, carried here: see [`Away`]
}

/// Where a version's files are, when they are on another device (RUN-HIST S1): a runner's turn
/// that wrote files on argonaut, carried back in its report's `turnRec` and recorded on the asker
/// so the History shows it.  Its rows name the runner's paths, not this device's, so nothing here
/// that reasons about this device's files reads them ([`Manifest::is_here`]); the Undo goes to the
/// runner, by `{on, run}`, and the runner looks `since` up itself.
///
/// Written last in the manifest, nested, with no key a manifest or an entry reads at its top
/// level: a build that has never heard of it reads the rows it always read, and only the Undo is
/// absent.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct Away {
	pub on:      String,	// the runner device's id, where an undo is posted
	pub on_name: String,	// its name, as the row says it
	pub run:     String,	// the run the runner settled, `e-<eid>`; an undo's own is `u-<uid>`
	pub since:   u64,	// the meter's trash key on the runner, 0 where nothing was kept
	pub until:   u64,	// epoch ms past which the runner keeps no earlier files
	pub more:    u64,	// rows the runner did not list, still covered by its Undo
	pub net:     Vec<NetRow>,	// where the turn's commands reached the network, at most NET_ROWS_MAX
	pub net_more: u64,	// destinations past those
}

/// Destinations one carried turn lists ([`Away::net`]); the runner counts the rest in `netMore`.
pub const NET_ROWS_MAX: usize = 32;

/// What the runner's proxy did with one destination a turn's commands reached.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NetKind {
	Registry,	// allowed: a registry or other destination the clean chat may read
	Outside,	// allowed, and it tripped the latch: later commands ran offline
	Refused,	// refused, for the row's `why`
}

impl NetKind {

	pub fn wire(self) -> &'static str {
		match self {
			Self::Registry	=> "registry",
			Self::Outside	=> "outside",
			Self::Refused	=> "refused",
		}
	}

	pub fn of(word: &str) -> Option<Self> {
		match word {
			"registry"	=> Some(Self::Registry),
			"outside"	=> Some(Self::Outside),
			"refused"	=> Some(Self::Refused),
			_		=> None,
		}
	}
}

/// One destination a runner's turn reached through its proxy, as its History row lists it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NetRow {
	pub host: String,	// lower-case
	pub port: u16,
	pub up:   u64,	// bytes sent
	pub down: u64,	// bytes received
	pub kind: NetKind,
	pub why:  String,	// a refusal's reason, empty otherwise
}

const NET_HOST_MAX: usize = 253;	// the longest DNS name
const NET_WHY_MAX:  usize = 200;	// a refusal's reason, in chars

impl NetRow {

	/// The wire and stored form, `{"host","port","up","down","v"}` and `why` on a refusal.
	pub fn to_json(&self) -> String {
		let mut out = fmt!("{{\"host\":\"{}\",\"port\":{},\"up\":{},\"down\":{},\"v\":\"{}\"",
			json_escape(&self.host), self.port, self.up, self.down, self.kind.wire());
		if !self.why.is_empty() {
			out.push_str(&fmt!(",\"why\":\"{}\"", json_escape(&self.why)));
		}
		out.push('}');
		out
	}

	/// Read one row, or `None` for a row the History cannot say: no host or one no name could
	/// be, a port out of range, or a verdict this build does not know.
	pub fn from_json(obj: &str) -> Option<Self> {
		let host = match extract_json_string(obj, "host") {
			Some(h)	=> h.to_ascii_lowercase(),
			None	=> return None,
		};
		if host.is_empty() || host.len() > NET_HOST_MAX
			|| host.chars().any(|c| c.is_whitespace() || c.is_control() || c == '/')
		{
			return None;
		}
		let port = match extract_json_number(obj, "port") {
			Some(p) if p > 0 && p <= u16::MAX as u64	=> p as u16,
			_						=> return None,
		};
		let kind = match NetKind::of(&extract_json_string(obj, "v").unwrap_or_default()) {
			Some(k)	=> k,
			None	=> return None,
		};
		let why = match kind {
			NetKind::Refused	=> extract_json_string(obj, "why").unwrap_or_default()
				.chars().filter(|c| !c.is_control()).take(NET_WHY_MAX).collect(),
			_			=> String::new(),
		};
		Some(Self {
			host,
			port,
			up:   extract_json_number(obj, "up").unwrap_or(0),
			down: extract_json_number(obj, "down").unwrap_or(0),
			kind,
			why,
		})
	}
}

/// The `net` rows of `obj` and the count past them: rows it cannot say are dropped, at most
/// [`NET_ROWS_MAX`] are kept, and good rows past those add to its `netMore`.
fn net_rows(obj: &str) -> (Vec<NetRow>, u64) {
	let mut more = extract_json_number(&without(obj, "net"), "netMore").unwrap_or(0);
	let mut rows: Vec<NetRow> = Vec::new();
	if let Some(arr) = array_inside(obj, "net") {
		for row in objects_in(arr).into_iter().filter_map(NetRow::from_json) {
			match rows.len() < NET_ROWS_MAX {
				true	=> rows.push(row),
				false	=> more = more.saturating_add(1),
			}
		}
	}
	(rows, more)
}

impl Away {

	/// The stored form, `{"on","onName","run","since","until","more"}`, then `net` and `netMore`
	/// where the turn reached the network (U8h): a manifest written before them is unchanged.
	pub fn to_json(&self) -> String {
		let mut out = fmt!("{{\"on\":\"{}\",\"onName\":\"{}\",\"run\":\"{}\",\"since\":{},\"until\":{},\"more\":{}",
			json_escape(&self.on), json_escape(&self.on_name), json_escape(&self.run),
			self.since, self.until, self.more);
		if !self.net.is_empty() {
			let rows: Vec<String> = self.net.iter().map(|r| r.to_json()).collect();
			out.push_str(&fmt!(",\"net\":[{}]", rows.join(",")));
		}
		if self.net_more > 0 {
			out.push_str(&fmt!(",\"netMore\":{}", self.net_more));
		}
		out.push('}');
		out
	}

	/// Read the object `obj`, or `None` where it names no run: a reference with no run reaches
	/// nothing on the runner.  Its scalars are read with `net` taken out, so no row's key is read
	/// as the reference's.
	pub fn from_json(obj: &str) -> Option<Self> {
		let (net, net_more) = net_rows(obj);
		let head = without(obj, "net");
		let obj = head.as_str();
		let run = match extract_json_string(obj, "run") {
			Some(r) if !r.is_empty()	=> r,
			_				=> return None,
		};
		Some(Self {
			on:      extract_json_string(obj, "on").unwrap_or_default(),
			on_name: extract_json_string(obj, "onName").unwrap_or_default(),
			run,
			since:   extract_json_number(obj, "since").unwrap_or(0),
			until:   extract_json_number(obj, "until").unwrap_or(0),
			more:    extract_json_number(obj, "more").unwrap_or(0),
			net,
			net_more,
		})
	}

	/// Has the runner's keep of the turn's earlier files run out at `now`?  A reference with no
	/// `until` never had one.
	pub fn lapsed_at(&self, now: u64) -> bool {
		self.until > 0 && now >= self.until
	}
}

impl Manifest {

	pub fn new(cause: Cause, ts: u64, turn: &str, note: &str, files: Vec<Entry>) -> Self {
		let (files, truncated) = truncate(files);
		Self { v: MANIFEST_V, ts, cause, turn: turn.to_string(), note: note.to_string(),
			files, truncated, away: None }
	}

	/// Are this version's files on this device: not a turn another device ran ([`Away`])?
	///
	/// Every reader that decides something about this device's files -- what stood at a path,
	/// what the Diamond made, what a restore or an undo puts back -- reads only these.  A runner's
	/// path can be this device's path too (`/home/jason/x/out.mp3` on both), and its row says
	/// nothing about the file here.
	pub fn is_here(&self) -> bool {
		self.away.is_none()
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
		out.push_str(&fmt!(",\"files\":[{}]", rows.join(",")));
		// Last, after every key an older build reads off the top level.
		if let Some(a) = &self.away {
			out.push_str(&fmt!(",\"away\":{}", a.to_json()));
		}
		out.push('}');
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
			away:      away_of(s),
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

/// A manifest's [`Away`], read after its `files`: the key is the manifest's own, never an entry's,
/// so it is looked for only past the rows.
fn away_of(s: &str) -> Option<Away> {
	let tail = match array_inside(s, "files") {
		Some(arr) => {
			let base = s.as_ptr() as usize;
			let end = arr.as_ptr() as usize - base + arr.len();
			&s[end..]
		},
		None => s,
	};
	object_inside(tail, "away").and_then(Away::from_json)
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
		.filter(|(_, m)| m.is_here())
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

/// Did this Diamond's own turns make the file at `path`, which now hashes to `now`?  Yes only where
/// the unbroken run of turns' changes that led to `now` begins at a row whose act MADE the file
/// ([`Entry::made`]) -- so nothing of anyone else's can be in it.  It is what lets a turn change
/// its own files freely while every other file in a held folder is put to the user (UNBLOCK-26).
///
/// **When unsure, no.**  The walk is [`run_copies`]' and ends where that one does, at any change a
/// turn did not make: the user's door, a Save, a fold, a Diamond that arrived, a row whose content
/// is not what the row after it replaced (an edit the store never saw), or bytes on disk that are
/// not what the newest row left.  Each of those answers no, as does running out of rows before a
/// made one, a deletion in the run, and a row with no hash to chain.  **A restore answers no as
/// well, even back to bytes a turn made**: the restore is the user's act, he chose what stands, and
/// the row cannot be trusted to say whose bytes it put back.
///
/// **`was: None` is not "made"** (UNBLOCK-26 check, 2026-10-18).  It says only that no earlier hash
/// was known: a command's edit of a file the store never recorded, or the destination of a file a
/// move carried, both write such a row over the user's bytes.  The walk ends only at `made`.
///
/// A wipe's `was` is the file as the turns found it, older than what the wipe replaced, so after a
/// wipe the walk passes over turns' rows until it reaches one that left those bytes.  A row from
/// another device's turn counts as this device's does: the manifests travel with the Diamond, and
/// a row vouches for nothing unless the bytes on disk hash to the run it starts.
///
/// # Arguments
/// * `manifests` - Every manifest held, by version, in any order.
/// * `path` - As the manifests name it: normalised, or absolute for a machine file.
/// * `folder` - The folder a relative path is in, as its rows record it; `None` for a machine file.
/// * `now` - The hash of the bytes at `path` now.
pub fn made_by_turns(
	manifests:	&[(u64, Manifest)],
	path:		&str,
	folder:		Option<&str>,
	now:		&str,
) -> bool {
	turns_made(&manifests.iter().collect::<Vec<_>>(), path, folder, now)
}

/// [`made_by_turns`] over the manifests named, such as the newest window of them.
fn turns_made(
	manifests:	&[&(u64, Manifest)],
	path:		&str,
	folder:		Option<&str>,
	now:		&str,
) -> bool {
	let mut rows: Vec<(u64, u64, Cause, &Entry)> = manifests.iter()
		.filter(|(_, m)| m.is_here())
		.flat_map(|(n, m)| m.files.iter()
			.filter(move |e| e.path == path && e.folder.as_deref() == folder)
			.map(move |e| (*n, m.ts, m.cause, e)))
		.collect();
	// Newest first; two devices mint the same number between syncs, so a tie goes by the clock.
	rows.sort_by(|a, b| (b.0, b.1).cmp(&(a.0, a.1)));
	let mut at = now.to_string();
	let mut past_wipe = false;	// looking for the row that left a wipe's `was`
	for (_, _, cause, e) in rows.into_iter() {
		if cause != Cause::Turn || e.gone || !is_hash(&e.hash) {
			return false;
		}
		if e.hash != at {
			match past_wipe {
				true	=> continue,
				false	=> return false,
			}
		}
		if e.made {
			return true;
		}
		match &e.was {
			Some(w) if is_hash(w) => {
				at = w.clone();
				past_wipe = e.wiped;
			},
			_ => return false,
		}
	}
	false
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
#[derive(Clone, Debug, Eq, PartialEq, ToDat, FromDat)]
pub enum Body {
	Held(Vec<u8>),		// the bytes, read whole
	TooLarge(u64),		// it is there, it is this long, and it was not read
	Unseen,			// it changed and the app never saw what it became
	Gone,			// there is nothing at the path
	Large(BodyRef),		// read whole by the run's child, known here by hash and length only
	Stored(BodyRef),	// read whole and put down in the Diamond's body store: see `Prior`
}

/// Bytes a turn's ledger holds of a file: in hand, or put down in the Diamond's body store and
/// known there by hash and length (D1mem fix B).  **A ledger holds no file's bytes past the act
/// that captured them**: the record names the stored body, so a turn that edited a 20 MB file
/// costs its ledger a hash, and a second name for the same bytes is one body.  Every rule asks of
/// a `Stored` one what it asks of the `Held` bytes it names, by hash.
#[derive(Clone, Debug, Eq, PartialEq, ToDat, FromDat)]
pub enum Prior {
	Held(Vec<u8>),		// the bytes, in hand
	Stored(BodyRef),	// in the Diamond's body store, by hash and length
}

impl Prior {

	/// The hash of the bytes.
	pub fn hash(&self) -> String {
		match self {
			Self::Held(b)	=> hash_of(b),
			Self::Stored(r)	=> r.hash.clone(),
		}
	}

	/// Their length.
	pub fn len(&self) -> u64 {
		match self {
			Self::Held(b)	=> b.len() as u64,
			Self::Stored(r)	=> r.len,
		}
	}

	/// Are there none?
	pub fn is_empty(&self) -> bool { self.len() == 0 }

	/// The bytes by reference.
	pub fn by_ref(&self) -> BodyRef {
		match self {
			Self::Held(b)	=> BodyRef::of(b),
			Self::Stored(r)	=> r.clone(),
		}
	}

	/// Are these `bytes`?
	pub fn names(&self, bytes: &[u8]) -> bool {
		match self {
			Self::Held(b)	=> b.as_slice() == bytes,
			Self::Stored(r)	=> r.names(bytes),
		}
	}

	/// The bytes in hand, where they are.
	pub fn held(&self) -> Option<&[u8]> {
		match self {
			Self::Held(b)	=> Some(b),
			Self::Stored(_)	=> None,
		}
	}
}

impl From<Vec<u8>> for Prior {
	fn from(b: Vec<u8>) -> Self { Self::Held(b) }
}

/// Bytes known by their hash and length, never carried (spec §16.3a): the store's form of an
/// `after` the child never uploads, [`Body::Large`].  **Every rule asks of it what it asks of the
/// `Held` bytes it names**, so a turn recorded with either gives the same rows; the tab never
/// makes one.
// Its `Dat` form is the wire's, which holds every hash to [`is_hash`] (`store::call::HexHash`).
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BodyRef {
	pub hash: String,	// [`hash_of`] the bytes
	pub len:  u64,		// their length
}

impl BodyRef {

	/// `bytes` by reference.
	pub fn of(bytes: &[u8]) -> Self { Self { hash: hash_of(bytes), len: bytes.len() as u64 } }

	/// Is this a reference to `bytes`?
	pub fn names(&self, bytes: &[u8]) -> bool {
		self.len == bytes.len() as u64 && self.hash == hash_of(bytes)
	}
}

/// Does a file at `path`, `len` bytes long and hashing to `hash` where it was read whole, stand as
/// a `Large` `after` left it?  **The tab's own rule (d1_plan §9.11 O1), asked of the tab's one
/// copy of it, [`stands_as_left`]**: this only builds the `now` the tab's re-read would find.  A
/// workspace path is read capped, so a file over the ceiling is `TooLarge` and stands on its
/// length alone, and one at or under it is read whole and judged by its bytes, or by its length
/// where no hash was given; a machine path is read whole, so it stands on its bytes, by hash.
/// `None` where a machine file was not read whole, so it cannot be told.  The one rule the
/// child's stand-or-stage choice and its wipe check ask (D1r2).
pub fn large_stands(path: &str, left: &BodyRef, len: u64, hash: Option<&str>) -> Option<bool> {
	let capped = !path.starts_with('/');
	let now = match hash {
		Some(h) if !capped || len as usize <= VERSION_FILE_MAX =>
			Body::Large(BodyRef { hash: h.to_string(), len }),
		// What a capped read of a workspace path tells without the bytes: their length.
		_ if capped => Body::TooLarge(len),
		_ => return None,
	};
	Some(stands_as_left(&Body::Large(left.clone()), &now))
}

/// What an act found at the path it changed, which [`capture_into`] compares with what the turn's
/// capture says it left there.
// Its `Dat` form is the wire's, which holds every hash to [`is_hash`] (`store::call::HexHash`).
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
#[derive(Clone, Debug, Eq, PartialEq, ToDat, FromDat)]
pub enum Carried {
	Made,			// this turn made them, wherever it did
	Kept(Prior),		// the file as the turns found it where the move took it from
	Unread,			// the move could not read them: they are measured as they stand
}

/// One path as a caller found it, before anything has been decided about it.
///
/// `before` is filled in only where the caller CAPTURED the prior bytes itself: a file tool, the
/// moment before its act.  Everywhere else it is `None` and `crate::wasm::diamond::versions_record`
/// answers "what stood there" from the history instead, which costs no read at all.
#[derive(Clone, Debug, Eq, PartialEq, ToDat, FromDat)]
pub struct Change {
	pub path:    String,		// workspace-relative, or absolute where `mark`
	pub after:   Body,
	pub before:  Option<Prior>,	// the prior bytes, where the caller captured them
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

	/// Did a turn's own act make the file this capture describes ([`Entry::made`])?
	///
	/// Only a file tool's capture can say so: its first act read the path, found nothing and
	/// captured no prior bytes, and every later act it folds in found the bytes the turn had left
	/// (`capture_into` replaces a run another hand broke).  A walk's or a ledger's re-read found
	/// nothing it can vouch for ([`Found::Unread`]), a refused read knows nothing, and bytes a move
	/// carried keep their own history -- made only where the turn made them at the source.  A
	/// held after put down and named by hash ([`Body::Stored`], D1mem fix B) is the same capture:
	/// a runner keeper's ledger holds every one so (RT-D1 Finding A).
	///
	/// A command's row ([`ran_rows`]) says so where the hand's write meter reported the file
	/// `created`: the run found nothing there, which the row keeps as [`Found::Nothing`].  One it
	/// reported `changed` found bytes that stood, and is made only through the run of rows before it.
	pub fn made(&self) -> bool {
		let tool = matches!(self.after, Body::Held(_) | Body::Stored(_))
			&& self.refused.is_none()
			&& matches!(self.found, Found::Nothing | Found::Hash(_))
			&& matches!(self.carried, None | Some(Carried::Made));
		let command = matches!(self.after, Body::Large(_))
			&& self.refused.as_deref() == Some(MADE_BY_COMMAND)
			&& self.found == Found::Nothing
			&& self.carried.is_none()
			&& self.by.as_ref().is_some_and(|a| a.via == VIA_COMMAND);
		self.before.is_none() && (tool || command)
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
		(Body::Large(r), Found::Hash(h))		=> Some(r.hash == *h),
		(Body::Large(_), Found::Nothing)		=> Some(false),
		(Body::Stored(r), Found::Hash(h))		=> Some(r.hash == *h),
		(Body::Stored(_), Found::Nothing)		=> Some(false),
		(Body::TooLarge(_), _) | (Body::Unseen, _)	=> None,
	}
}

/// The file at a path as THIS turn found it, from its captures: what [`run_copies`] starts from.
#[derive(Clone, Debug, Eq, PartialEq, ToDat, FromDat)]
pub enum TurnFound {
	Made,			// the turn made what stands there, so nothing of anyone else's is in it
	Carried(Vec<u8>),	// a move brought it here, and this is the file as the turns found it there
	Was(Vec<u8>),		// what the turn found at this path: where its run of turns' changes begins
}

/// [`TurnFound`] as a turn's ledger says it, before any bytes are read: what [`this_turn_found`]
/// answers, whose `Stored` copies the caller reads from the body store where it needs the bytes.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TurnSaid {
	Made,			// as `TurnFound::Made`
	Carried(Prior),		// as `TurnFound::Carried`
	Was(Prior),		// as `TurnFound::Was`
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
pub fn this_turn_found(held: &[(String, Change)], path: &str, now: &[u8]) -> TurnSaid {
	let h = match held.iter().find(|(_, h)| h.path == path) {
		Some((_, h))	=> h,
		None		=> return TurnSaid::Was(Prior::Held(now.to_vec())),
	};
	// `left_there`'s rule, on the bytes themselves rather than on two hashes of them.
	let theirs = match &h.after {
		Body::Held(b)				=> Some(b.as_slice() == now),
		Body::Large(r) | Body::Stored(r)	=> Some(r.names(now)),
		Body::Gone				=> Some(false),
		Body::TooLarge(_) | Body::Unseen	=> None,
	};
	match (theirs, &h.carried, &h.before) {
		(Some(true), Some(Carried::Made), _)		=> TurnSaid::Made,
		(Some(true), None, None)			=> TurnSaid::Made,
		(Some(true), None, Some(first))			=> TurnSaid::Was(first.clone()),
		(Some(true), Some(Carried::Kept(k)), _)
			| (None, Some(Carried::Kept(k)), _)	=> TurnSaid::Carried(k.clone()),
		(None, None, Some(first))			=> TurnSaid::Was(first.clone()),
		_						=> TurnSaid::Was(Prior::Held(now.to_vec())),
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
		// A `Stored` body as the `Held` bytes it names, which is as a `Large` one stands.
		(Body::Stored(a), _)			=> stands_as_left(&Body::Large(a.clone()), now),
		(_, Body::Stored(b))			=> stands_as_left(after, &Body::Large(b.clone())),
		(Body::Held(a), Body::Held(b))		=> a == b,
		(Body::Held(a), Body::TooLarge(n))	=> a.len() as u64 == *n,
		(Body::Held(_), Body::Gone)		=> false,
		// A `Large` after as the `Held` bytes it names (O1): by hash where the bytes were read,
		// by length against `TooLarge`, as the tab's capped re-read of a workspace path.
		(Body::Large(a), Body::Large(b))	=> a == b,
		(Body::Large(a), Body::Held(b))
			| (Body::Held(b), Body::Large(a))	=> a.names(b),
		(Body::Large(a), Body::TooLarge(n))	=> a.len == *n,
		(Body::Large(_), Body::Gone)		=> false,
		(Body::Large(_), Body::Unseen)		=> true,
		(Body::Gone, Body::Gone)		=> true,
		(Body::Gone, Body::Held(_))
			| (Body::Gone, Body::TooLarge(_))
			| (Body::Gone, Body::Large(_))	=> false,
		(Body::TooLarge(_), Body::Large(_))
			| (Body::Unseen, Body::Large(_))	=> true,
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
		before:  Some(Prior::Held(now.to_vec())),
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
#[derive(Clone, Debug, Eq, PartialEq, ToDat, FromDat)]
pub enum Short {
	Count,		// the turn keeps as many copies as one manifest holds rows
	Bytes(u64),	// the turn holds a destruction, and its copies would pass the room left: the room
	Kept(u64, u64),	// the act's one copy would pass [`BODY_KEEP_MAX`]: its length, and the cap
	Store(String),	// the store refused the claim itself: its reason, keeper and op named (LOUD-FAIL)
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
	claim_room_under(held, reserved, path, found, copy, destroying, room, BODY_KEEP_MAX)
}

/// What the other runs keeping into the same store hold and have in flight, which the 64 cap and
/// the bytes bound count with the asking run's own (the tab counts a daimon and its workers
/// together), though each run's turn end takes only its own.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Others {
	pub kept:	usize,	// the copies they keep, held or reserved
	pub destroys:	bool,	// does any of them hold or reserve a destruction?
	pub bytes:	u64,	// what their copies weigh
}

impl Others {
	/// Add one other run's ledger: what it holds and what it has reserved.
	pub fn add(&mut self, held: &[(String, Change)], reserved: &[Reserved]) {
		self.kept = self.kept
			+ held.iter().filter(|(_, h)| h.before.is_some()).count()
			+ reserved.iter().filter(|r| r.copy.is_some()).count();
		self.destroys = self.destroys
			|| held.iter().any(|(_, h)| matches!(h.after, Body::Gone) || h.wiped)
			|| reserved.iter().any(|r| r.destroying);
		self.bytes = held.iter()
			.map(|(_, h)| h.before.as_ref().map(Prior::len).unwrap_or(0))
			.chain(reserved.iter().map(|r| r.copy.unwrap_or(0)))
			.fold(self.bytes, |a, b| a.saturating_add(b));
	}
}

/// [`claim_room`] for one run among several keeping into the store: `held` and `reserved` are the
/// run's own, so whether `path` is known and the reservation are its own, and `others` is added
/// to the copies counted and the bytes weighed.
#[allow(clippy::too_many_arguments)]
pub fn claim_room_among(
	held:       &[(String, Change)],
	reserved:   &mut Vec<Reserved>,
	others:     Others,
	path:       &str,
	found:      &Found,
	copy:       Option<u64>,
	destroying: bool,
	room:       u64,
)
	-> Result<bool, Short>
{
	claim_room_core(held, reserved, path, found, copy, destroying, room, BODY_KEEP_MAX, others)
}

/// [`claim_room`] under the per-copy cap `keep_max` ([`BODY_KEEP_MAX`]): a copy this act would
/// keep that passes it is refused before anything is reserved, and `None` changes nothing.
#[allow(clippy::too_many_arguments)]
pub(crate) fn claim_room_under(
	held:       &[(String, Change)],
	reserved:   &mut Vec<Reserved>,
	path:       &str,
	found:      &Found,
	copy:       Option<u64>,
	destroying: bool,
	room:       u64,
	keep_max:   Option<u64>,
)
	-> Result<bool, Short>
{
	claim_room_core(held, reserved, path, found, copy, destroying, room, keep_max,
		Others::default())
}

#[allow(clippy::too_many_arguments)]
fn claim_room_core(
	held:       &[(String, Change)],
	reserved:   &mut Vec<Reserved>,
	path:       &str,
	found:      &Found,
	copy:       Option<u64>,
	destroying: bool,
	room:       u64,
	keep_max:   Option<u64>,
	others:     Others,
)
	-> Result<bool, Short>
{
	let ends = |h: &Change| h.path == path && run_broken(h, found);
	let at = reserved.iter().position(|r| r.path == path);
	let known = at.is_some() || held.iter().any(|(_, h)| h.path == path && !ends(h));
	if let Some(bytes) = copy {
		if !known {
			// A path already held keeps its first copy, so only a new one is weighed.
			if let Some(max) = keep_max {
				if bytes > max {
					return Err(Short::Kept(bytes, max));
				}
			}
			let kept = held.iter().filter(|(_, h)| h.before.is_some() && !ends(h)).count()
				+ reserved.iter().filter(|r| r.copy.is_some()).count()
				+ others.kept;
			if kept >= TURN_FILES_MAX {
				return Err(Short::Count);
			}
		}
		let destroys = destroying
			|| held.iter().any(|(_, h)| matches!(h.after, Body::Gone) || h.wiped)
			|| reserved.iter().any(|r| r.destroying)
			|| others.destroys;
		if destroys {
			// A run the act ends still counts here: its version is held as long as this one.
			let total = held.iter()
				.map(|(_, h)| h.before.as_ref().map(Prior::len).unwrap_or(0))
				.chain(reserved.iter().map(|r| r.copy.unwrap_or(0)))
				.fold(if known { 0u64 } else { bytes }, |a, b| a.saturating_add(b))
				.saturating_add(others.bytes);
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
				Some(k)	=> Carried::Kept(Prior::Held(k.clone())),
				None	=> Carried::Made,
			};
			(Body::Held(bytes), first.map(Prior::Held), found, carried, None)
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
// │ What the Diamond made, for the hand's write meter              │
// └───────────────────────────────────────────────────────────────┘

// The hand lets a command change a file that was there before the run only where the page's
// `made` names it with the sha256 of the bytes on disk (write_meter_plan.md invariants 1 and 9,
// QA-B3).  What the Diamond made is read from its own record and nowhere else: the History's
// manifests of past turns and this turn's captures, each row written by a file tool at its act.
// Nothing a model says reaches it, so a path the record never wrote is named by no `made`.

/// How many of the newest manifests are read for [`made_by_diamond`]: the record's recent window.
/// A file the Diamond last wrote further back is not named, so a command finds it the user's
/// and is refused, which is the safe side.
pub const MADE_WINDOW: usize = 64;

/// The most files [`made_by_diamond`] names, newest first.  Under the hand's own bounds
/// (`MADE_FILES_MAX` 4096 a root) and small enough for the exec frame: at most
/// `MADE_SENT_MAX` × (`MADE_PATH_SENT_MAX` + 64) bytes, about 270 KiB, of a 1 MB frame.
pub const MADE_SENT_MAX: usize = 256;

/// The longest path [`made_by_diamond`] names, in bytes; a longer one is left out (the user's).
pub const MADE_PATH_SENT_MAX: usize = 1024;

/// Is this a row the Diamond's own file tool wrote?  An agent's act (`by`), not one a command or
/// helper window was credited with (`via`), and not a person's door.
fn tool_wrote(by: &Option<Author>, door: bool) -> bool {
	!door && by.as_ref().is_some_and(|a| a.via.is_empty())
}

/// Is this a row a command of the Diamond's made (MADE-2): the hand's write meter reported the
/// file created or changed by the run, with the sha256 it left, and the turn record kept it under
/// the agent that ran the command (`via` [`VIA_COMMAND`]) with no body ([`MADE_BY_COMMAND`]).
/// A window's credit for the same agent is `via` command too, but its bytes were read by a walk
/// and not reported by the meter, so it is not one: only the meter knows the run made the file.
fn command_made(by: &Option<Author>, door: bool, skipped: &Option<String>) -> bool {
	!door && skipped.as_deref() == Some(MADE_BY_COMMAND)
		&& by.as_ref().is_some_and(|a| a.via == VIA_COMMAND)
}

/// The files on this computer the Diamond's file tools last wrote, each with the sha256 of the
/// bytes they left, newest first: what the exec request's `made` names.  [`made_by_diamond_ran`]
/// with no file a command made this turn.
pub fn made_by_diamond(manifests: &[(u64, Manifest)], held: &[(String, Change)])
	-> Vec<(String, String)>
{
	made_by_diamond_ran(manifests, held, &[])
}

/// The files on this computer the Diamond made, each with the sha256 of the bytes it left,
/// newest first: what the exec request's `made` names.  Made by its file tools (MADE-1), or by a
/// command its agent ran, as the hand's write meter reported it (MADE-2).
///
/// The NEWEST row of a path decides it, this turn's capture before any manifest: a row by a
/// person's door, a restore or a walk, or one saying the file is gone, makes it the user's
/// however often the Diamond wrote it before.  A file he changed with no row (his editor
/// between turns) keeps the Diamond's hash here, and the hand finds the bytes differ and refuses.
///
/// # Arguments
/// * `manifests` - The Diamond's manifests; the newest [`MADE_WINDOW`] by version are read.
/// * `held` - This turn's captures, not yet in any manifest.
/// A row, a file tool's or a command's, is the Diamond's on the ONE fact UNBLOCK-26 records, [`Entry::made`]: the run of
/// turns' rows that left its bytes begins at a row whose act made the file ([`made_by_turns`], over
/// the same window).  So a file a command created is the Diamond's, and so is one a later command
/// changed after the Diamond made it; a file of his that a command changed stays his.  This turn's
/// commands are read the same way: a file one created is the Diamond's, and one it changed is only
/// where the record already says the Diamond made it.  A file tool's change of his file, after his
/// yes, stays his (PORTG-AF): his yes covered that one shown change, never the file, so a command
/// may not change it after unasked.  This turn's tool captures count only where the capture made
/// the file ([`Change::made`]) or the bytes it first found were the Diamond's on the record.
///
/// * `ran` - What this turn's commands made, as the meter reported it ([`RanMade`]), oldest first:
///   each path, the hash it was left with, and whether the run created it.
pub fn made_by_diamond_ran(
	manifests:	&[(u64, Manifest)],
	held:		&[(String, Change)],
	ran:		&[(String, String, bool)],
)
	-> Vec<(String, String)>
{
	let mut decided: BTreeSet<String> = BTreeSet::new();
	let mut out: Vec<(String, String)> = Vec::new();
	let mut take = |path: &str, hash: Option<String>, out: &mut Vec<(String, String)>| {
		if !path.starts_with('/') || !decided.insert(path.to_string()) {
			return;
		}
		if let Some(h) = hash {
			if out.len() < MADE_SENT_MAX && path.len() <= MADE_PATH_SENT_MAX && is_hash(&h) {
				out.push((path.to_string(), h));
			}
		}
	};
	// This device's versions alone ([`Manifest::is_here`]): a runner's carried turn made its files
	// there, and a file of the same path here is not the Diamond's for it.
	let mut newest: Vec<&(u64, Manifest)> = manifests.iter().filter(|(_, m)| m.is_here()).collect();
	newest.sort_by(|a, b| b.0.cmp(&a.0));
	newest.truncate(MADE_WINDOW);
	// This turn's captures: a tool's is the Diamond's only where it made the file, or where the
	// bytes it first found were already the Diamond's on the record.  His yes to a shown change
	// covers that change, never the file (PORTG-AF).
	for (_, c) in held.iter().rev() {
		let made = tool_wrote(&c.by, c.door)
			&& (c.made() || c.before.as_ref().is_some_and(|b|
				turns_made(&newest, &c.path, c.folder.as_deref(), &b.hash())));
		let hash = match (&c.after, made) {
			(Body::Held(b), true)	=> Some(hash_of(b)),
			(Body::Large(r), true)
				| (Body::Stored(r), true)	=> Some(r.hash.clone()),
			_			=> None,
		};
		take(&c.path, hash, &mut out);
	}
	// What the record says, newest row of each path first, before this turn's commands use it.
	let mut recorded: Vec<(&str, Option<String>)> = Vec::new();
	let mut seen: BTreeSet<&str> = BTreeSet::new();
	for (_, m) in newest.iter() {
		for e in m.files.iter().rev() {
			if !seen.insert(e.path.as_str()) {
				continue;
			}
			// One fact for tool and command rows alike: U1's, over the same window.
			let made = (tool_wrote(&e.by, e.door) || command_made(&e.by, e.door, &e.skipped))
				&& turns_made(&newest, &e.path, e.folder.as_deref(), &e.hash);
			let his = m.cause == Cause::Turn && !e.gone && made;
			recorded.push((e.path.as_str(), if his { Some(e.hash.clone()) } else { None }));
		}
	}
	for (path, hash, created) in ran.iter().rev() {
		let ours = *created || recorded.iter().any(|(p, h)| *p == path.as_str() && h.is_some());
		take(path, if ours { Some(hash.clone()) } else { None }, &mut out);
	}
	for (path, hash) in recorded.into_iter() {
		take(path, hash, &mut out);
	}
	out
}

/// Why a row a command made keeps no body: the meter reported its hash, and the bytes were
/// never read.  It also marks the row as the meter's ([`made_by_diamond_ran`]).
pub const MADE_BY_COMMAND: &str = "command";

/// What one run's meter reported its command made, read off the hand's run JSON: each file
/// `created` or `changed`, the run's own and its leftovers' (`metered_late`), as an absolute path
/// with the sha256 it left; and whether any list was capped (`created_capped`), past which the
/// meter named nothing.  At most [`MADE_SENT_MAX`] files, the first reported: the rest are not
/// named, and the result says it is capped.  A path that is not plainly absolute, or whose hash is
/// not one, is left out.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct RanMade {
	pub files:  Vec<(String, String, bool)>,	// path, the sha256 it left, and whether the run created it
	pub capped: bool,
}

impl RanMade {

	/// What the run JSON `res` reports made.
	pub fn of(res: &str) -> Self {
		let mut out = Self::default();
		let mut lists: Vec<String> = vec![res.to_string()];
		if let Some(late) = extract_json_objects(res, "metered_late") {
			lists.extend(late);
		}
		for (i, obj) in lists.iter().enumerate() {
			// The run's own lists are read off its top level, before `metered_late`.
			let own = match i {
				0 => match obj.find("\"metered_late\":") {
					Some(at) => &obj[..at],
					None	 => obj.as_str(),
				},
				_ => obj.as_str(),
			};
			if extract_json_bool(own, "created_capped").unwrap_or(false) {
				out.capped = true;
			}
			// `kept`: his files changed, each kept first (METER-KEEP), so Undo restores them.
			for (key, created) in [("created", true), ("changed", false), ("kept", false)] {
				for w in extract_json_objects(own, key).unwrap_or_default() {
					out.add(&w, created);
				}
			}
		}
		out
	}

	/// One meter entry `{"root","path","sha256"}`, where it is whole; `created` where the run found
	/// nothing there.  A path the run created and then changed again is still one it created.
	fn add(&mut self, w: &str, created: bool) {
		let (root, rel, sha) = match (extract_json_string(w, "root"),
			extract_json_string(w, "path"), extract_json_string(w, "sha256"))
		{
			(Some(r), Some(p), Some(h)) => (r, p, h),
			_			    => return,
		};
		let path = match rel.starts_with('/') {
			true  => rel,
			false => fmt!("{}/{}", root.trim_end_matches('/'), rel),
		};
		let plain = path.starts_with('/') && !path.contains('\0')
			&& path.split('/').skip(1).all(|c| !c.is_empty() && c != "." && c != "..");
		if !plain || !is_hash(&sha) || path.len() > MADE_PATH_SENT_MAX {
			return;
		}
		if let Some(f) = self.files.iter_mut().find(|(p, _, _)| *p == path) {
			f.1 = sha;
			f.2 = f.2 || created;
			return;
		}
		if self.files.len() >= MADE_SENT_MAX {
			self.capped = true;
			return;
		}
		self.files.push((path, sha, created));
	}
}

/// The rows a turn record keeps for what its commands made (MADE-2): one each, cause the turn's,
/// credited to the agent that ran the command (`via` [`VIA_COMMAND`]), with the meter's hash and
/// no body ([`MADE_BY_COMMAND`]), so the History shows it and a Restore leaves it alone.  None
/// where no agent is named: a command nobody ran made nothing of the Diamond's.
///
/// A file the run created keeps that as the row's [`Found::Nothing`], so the record writes it
/// [`Entry::made`] ([`Change::made`]); one it changed found bytes nobody read, [`Found::Unread`].
///
/// # Arguments
/// * `ran` - Each file a command made, with its hash, whether the run created it, and who ran the
///   command, oldest first.
pub fn ran_rows(ran: &[(String, String, bool, Option<Author>)]) -> Vec<Change> {
	let ran: Vec<(String, String, bool, Option<Author>)> = ran.iter()
		.map(|(p, h, c, by)| (p.clone(), h.clone(), *c,
			by.as_ref().map(|a| Author { via: VIA_COMMAND.to_string(), ..a.clone() })))
		.collect();
	meter_rows(&ran)
}

/// The rows of `ran` in [`ran_rows`]' shape, each credited as it is named: a carried turn's file
/// tool keeps its `via` empty, as Here, where a command's reads [`VIA_COMMAND`] (RT-D2).
fn meter_rows(ran: &[(String, String, bool, Option<Author>)]) -> Vec<Change> {
	let mut out: Vec<Change> = Vec::new();
	for (path, hash, created, by) in ran.iter().rev() {
		let by = match by {
			Some(a) => a.clone(),
			None	=> continue,
		};
		if out.iter().any(|c| c.path == *path) {
			continue;
		}
		out.push(Change {
			after:   Body::Large(BodyRef { hash: hash.clone(), len: 0 }),
			mark:    true,
			refused: Some(MADE_BY_COMMAND.to_string()),
			found:   if *created { Found::Nothing } else { Found::Unread },
			by:      Some(by),
			..Change::gone(path)
		});
	}
	out.reverse();
	out
}



/// The rows a runner's turn record (`turnRec`, RUN-HIST S1) carries back to the asker: one per file
/// the runner's command made or changed, in [`ran_rows`]' shape -- the meter's hash and no body
/// ([`MADE_BY_COMMAND`]), [`Found::Nothing`] where the run created it and [`Found::Unread`] where
/// it changed one, credited as the runner credited it: `via` [`VIA_COMMAND`] where a command
/// changed it, else empty, the file tool's, as Here (RT-D2).  A row whose path is not plainly absolute or whose hash is not one is left out, as the meter's own are; at most
/// [`MADE_SENT_MAX`].  An author the record does not name is still the runner's agent, so no row
/// is dropped for want of one.
///
/// # Arguments
/// * `rec` - The `turnRec` object, as the report carried it.
pub fn carried_rows(rec: &str) -> Vec<Change> {
	let mut ran: Vec<(String, String, bool, Option<Author>)> = Vec::new();
	let arr = match array_inside(rec, "files") {
		Some(a)	=> a,
		None	=> return Vec::new(),
	};
	for obj in objects_in(arr) {
		if ran.len() >= MADE_SENT_MAX {
			break;
		}
		// The row's own keys, read with its author taken out: an author's keys are not a row's.
		let own = without(obj, "by");
		let (path, hash) = match (extract_json_string(&own, "path"), extract_json_string(&own, "hash")) {
			(Some(p), Some(h))	=> (p, h),
			_			=> continue,
		};
		let plain = path.starts_with('/') && !path.contains('\0')
			&& path.split('/').skip(1).all(|c| !c.is_empty() && c != "." && c != "..");
		if !plain || !is_hash(&hash) || path.len() > MADE_PATH_SENT_MAX {
			continue;
		}
		let created = extract_json_bool(&own, "created").unwrap_or(false);
		let by = object_inside(obj, "by");
		let author = match by.and_then(Author::from_json) {
			Some(a)	=> a,
			None	=> Author {
				role: by.and_then(|b| extract_json_string(b, "agent"))
					.filter(|a| !a.is_empty())
					.unwrap_or_else(|| "daimon".to_string()),
				// The runner's own credit: a command's, else its file tool's, as Here (RT-D2).
				via:  match by.and_then(|b| extract_json_string(b, "via")).as_deref() {
					Some(VIA_COMMAND)	=> VIA_COMMAND.to_string(),
					_			=> String::new(),
				},
				..Default::default()
			},
		};
		ran.push((path, hash, created, Some(author)));
	}
	meter_rows(&ran)
}

/// The [`Away`] a runner's turn record names: `{on, onName, run, since, until, more}` off its top
/// level, with its `net` rows and `netMore` (U8h), its file rows taken out first so no row's key is read as the record's.  `None` where it names
/// no run.
pub fn carried_away(rec: &str) -> Option<Away> {
	Away::from_json(&without(rec, "files"))
}

/// A runner turn record's top level, its file and network rows taken out: where `turnId`, `ts` and
/// `keeper` are read.
pub fn carried_head(rec: &str) -> String {
	without(&without(rec, "files"), "net")
}

/// The row one carried change writes: the runner's path and the hash it was left with, no body and
/// no `was` -- the bytes before are on the runner, in its trash -- marked as the meter's
/// ([`MADE_BY_COMMAND`]), and `made` where the runner's turn created the file.
pub fn carried_entry(ch: Change) -> Entry {
	// The runner said it created the file, whether its command or its file tool did (RT-D2).
	let made = matches!(ch.after, Body::Large(_)) && ch.before.is_none() && ch.found == Found::Nothing;
	let (hash, gone) = match ch.after {
		Body::Large(r)	=> (r.hash, false),
		Body::Gone	=> (String::new(), true),
		_		=> (String::new(), false),
	};
	Entry {
		path:    ch.path,
		hash,
		bytes:   0,
		was:     None,
		gone,
		wiped:   false,
		mark:    true,
		skipped: Some(MADE_BY_COMMAND.to_string()),
		folder:  None,
		by:      ch.by,
		door:    false,
		made:    made && !gone,
	}
}

/// What a runner's `undone` answer (RUN-HIST §3.1) records on the asker: the run it undid, the
/// undo's own restore reference -- whose `run` is `u-<uid>` -- and a row per path it put back or
/// removed, as [`carried_entry`] writes them (no hash: the runner reported none).  `None` unless
/// the status is `done` with a reference: `already`, `busy`, `expired` and `error` changed nothing.
pub fn undone_rows(json: &str) -> Option<(String, Away, Vec<Entry>)> {
	let head = without(json, "undo");
	if extract_json_string(&head, "status").as_deref() != Some("done") {
		return None;
	}
	let run = match extract_json_string(&head, "run") {
		Some(r) if !r.is_empty()	=> r,
		_				=> return None,
	};
	let undo = match object_inside(json, "undo").and_then(Away::from_json) {
		Some(u)	=> u,
		None	=> return None,
	};
	let mut rows: Vec<Entry> = Vec::new();
	for (key, gone) in [("restored", false), ("removed", true)] {
		let list = match array_inside(&head, key) {
			Some(a)	=> crate::llm::parse_json_string_array(&fmt!("[{}]", a)),
			None	=> Vec::new(),
		};
		for path in list.into_iter() {
			let plain = path.starts_with('/') && !path.contains('\0')
				&& path.split('/').skip(1).all(|c| !c.is_empty() && c != "." && c != "..");
			if !plain || path.len() > MADE_PATH_SENT_MAX || rows.len() >= MADE_SENT_MAX
				|| rows.iter().any(|e| e.path == path)
			{
				continue;
			}
			let after = match gone {
				true  => Body::Gone,
				false => Body::Unseen,
			};
			rows.push(carried_entry(Change { after, ..Change::gone(&path) }));
		}
	}
	Some((run, undo, rows))
}

/// `json` with the value of `"key":` -- an object or an array -- taken out, string-aware, so the
/// keys left are read off the level `json` is at.  `json` as it is where the key names neither.
fn without(json: &str, key: &str) -> String {
	let inner = match object_inside(json, key) {
		Some(o)	=> Some(o),
		None	=> array_inside(json, key),
	};
	let inner = match inner {
		Some(i)	=> i,
		None	=> return json.to_string(),
	};
	let base = json.as_ptr() as usize;
	let from = inner.as_ptr() as usize - base;
	let to = from + inner.len();
	// An array's inside leaves its brackets, which hold nothing once it is empty.
	fmt!("{}{}", &json[..from], &json[to..])
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

	/// What [`Windows::take`] would answer, leaving every window and the snapshot where they are.
	pub fn peek(&self) -> Vec<Window> {
		let mut out = self.done.clone();
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
	output_note_by_hash(tool, path, &hash_of(bytes))
}

/// [`output_note`] by the bytes' `hash`, for a caller holding them by reference ([`BodyRef`]).
pub fn output_note_by_hash(tool: &str, path: &str, hash: &str) -> String {
	fmt!("{{\"tool\":\"{}\",\"path\":\"{}\",\"hash\":\"{}\"}}",
		json_escape(tool), json_escape(path), json_escape(hash))
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
	output_note_says_hash(note, tool, path, &hash_of(bytes))
}

/// [`output_note_says`] of the bytes whose hash is `hash`.
pub fn output_note_says_hash(note: &str, tool: &str, path: &str, hash: &str) -> bool {
	extract_json_string(note, "tool").as_deref() == Some(tool)
		&& extract_json_string(note, "path").as_deref() == Some(path)
		&& extract_json_string(note, "hash").map(|h| h == hash).unwrap_or(false)
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
#[derive(Clone, Copy, Debug, Eq, PartialEq, ToDat, FromDat)]
pub enum Unplaced {
	Unrecorded,	// written before rows recorded their folder
	Unknown,	// written in a folder this device does not know, or in one opened unnamed
}

/// What a restore's act may do at the place its path reaches now.
#[derive(Clone, Copy, Debug, Eq, PartialEq, ToDat, FromDat)]
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

/// What stood at one of the person's paths when a restore was decided on: when it was opened, or
/// when the door last refused an act there and the person was asked about it.
///
/// **An answer is bound to the bytes it was asked about** (hist-safe R2, 2026-10-12).  A restore's
/// questions can stay open for minutes, and the door wrote with no look at what was there by
/// then: a file that matched at the open, and was changed by the person's editor, a daimon's turn,
/// another tab or another restore while a question was open, was written over unasked.
// Its `Dat` form is the wire's, which holds every hash to [`is_hash`] (`store::call::HexHash`).
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Seen {
	Absent,		// nothing stood there
	Bytes(String),	// these bytes, by their hash
	Unread,		// something stood there that could not be read whole
}

impl Seen {

	/// `now` as a [`Seen`]; `None` is nothing there.
	pub fn of(now: Option<&[u8]>) -> Self {
		match now {
			Some(b)	=> Self::Bytes(hash_of(b)),
			None	=> Self::Absent,
		}
	}
}

/// What a failed lookup of one name in a folder means (PLF-NF).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Lookup {
	/// The store's own "nothing there": `NotFoundError`.
	Absent,
	/// Something stands at the name, but of the other kind -- a folder where a file was asked
	/// for, or the reverse: `TypeMismatchError`.
	OtherKind,
}

/// Read a failed lookup (`getFileHandle`, `getDirectoryHandle`) by its exception `name`.
///
/// **Absent only on `NotFoundError`.**  Every other failure -- a read blocked by another handle,
/// a security refusal, a rejection with no name at all -- is a fault naming the `path` and the
/// `phase`, because an existence probe or a bound write's compare that took it for "absent"
/// would write a new file over one that stands (PORT-LF re-QA, limit 1).
pub fn lookup_failed(name: Option<&str>, path: &str, phase: &str) -> Outcome<Lookup> {
	match name {
		Some("NotFoundError")       => Ok(Lookup::Absent),
		Some("TypeMismatchError")   => Ok(Lookup::OtherKind),
		other                       => Err(err!(
			"OPFS: the lookup of '{}' failed ({}) at the {}, so whether it stands is not known, \
			and it is not taken for absent.", path, other.unwrap_or("no error name"), phase;
			IO, File, Read)),
	}
}

/// What a conditional write does with the writable it opened, once its bytes are staged and its
/// re-check is in (OPFS-LOCK, 2026-10-17): only a write that passed is closed, and every other
/// end -- a refusal, a failed write, a failed re-check -- aborts it.
///
/// **A failed write returned with its writable still open**, and an exclusive writable left open
/// holds the file against every other writer until the engine collects it.  So the ends are
/// decided here, in one place, and `opfs::write_file_if` acts on the answer.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StagedEnd {
	Close,		// the re-check passed: commit the staged bytes
	Abort,		// anything else: the staged bytes are dropped and the file let go
}

impl StagedEnd {

	/// The end for what staging came to: `Ok(None)` passed, `Ok(Some(found))` refused.
	pub fn of<T>(staged: &Outcome<Option<T>>) -> Self {
		match staged {
			Ok(None)		=> Self::Close,
			Ok(Some(_)) | Err(_)	=> Self::Abort,
		}
	}
}

/// What staging came to, carried through `pre` (held-lock settle P1): the end to take and the
/// answer.  `pre` runs only where the re-check passed ([`StagedEnd::Close`]), so a refused or a
/// failed stage never runs it, and a `pre` that fails turns the end to [`StagedEnd::Abort`] with
/// its error, so nothing lands.  OPFS's held write calls it after `stage` and before `close`.
pub async fn staged_then<T, P, F>(staged: Outcome<Option<T>>, pre: P)
	-> (StagedEnd, Outcome<Option<T>>)
where
	P: FnOnce() -> F,
	F: std::future::Future<Output = Outcome<()>>,
{
	match StagedEnd::of(&staged) {
		StagedEnd::Abort => (StagedEnd::Abort, staged),
		StagedEnd::Close => match pre().await {
			Ok(())	=> (StagedEnd::Close, staged),
			Err(e)	=> (StagedEnd::Abort, Err(e)),
		},
	}
}

/// What a restore's act at the row's own file may do, by what stands there now.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Bound {
	Same,		// it already holds what the act would leave: done, and nothing written
	Go,		// it holds what the person decided on
	Changed,	// it changed since: nothing is written until the person says so again
}

/// May a restore's act go ahead, given what stood at its path when it was decided on (`seen`),
/// what stands there `now`, and what it `puts` there (`None` for a delete)?
///
/// **Equal bytes are not written** (hist-safe, 2026-10-12): the door rewrote a file that already
/// held the version's bytes, so a restore that changed nothing still touched the person's files.
pub fn bound(seen: &Seen, now: Option<&[u8]>, puts: Option<&[u8]>) -> Bound {
	let same = match (now, puts) {
		(Some(n), Some(p))	=> n == p,
		(None, None)		=> true,
		_			=> false,
	};
	if same {
		return Bound::Same;
	}
	match seen {
		Seen::Unread			=> Bound::Changed,
		s if *s == Seen::of(now)	=> Bound::Go,
		_				=> Bound::Changed,
	}
}

/// What a restore's act at one of the person's files may do ([`act`]).
#[derive(Clone, Copy, Debug, Eq, PartialEq, ToDat, FromDat)]
pub enum Act {
	Go,		// put the row back
	Same,		// it already holds those bytes: done, nothing written
	Changed,	// changed since the person decided: asked again first
	Left,		// another place's file of the same name
	Ask(Unplaced),	// whose file it is cannot be told: the person decides
	Unasked,	// a file the open restore never handed out: nobody was asked
	Unanswered,	// he was asked about it and has not said yes: nothing goes until he does
}

/// One of the person's files a restore's open handed out, as [`act`] weighs it.
#[derive(Clone, Copy, Debug)]
pub struct Handout<'a> {
	pub row:	&'a str,		// the path as its row names it
	pub folder:	Option<&'a str>,	// the folder the row was written in
	pub known:	bool,			// does this device know that folder?
	pub seen:	&'a Seen,		// at the open, or at the page's look
	pub must:	bool,			// does the open ask him before it goes over `seen`?
	pub asked:	Option<&'a Seen>,	// when an act was last refused and put to them
	pub yes:	Option<&'a Seen>,	// the bytes he last said yes to, as the engine recorded it
}

/// May a restore's act, reaching `landed` (in `landed_folder`), put its row back over what stands
/// there `now`?  `handed` is the open's handout for the act's spelling, `None` where it handed
/// none out.
///
/// **Bound to the bytes the person decided on** (hist-safe R2, 2026-10-12): those seen at the open
/// (or the page's look), or those he said yes to.  Anything else there is [`Act::Changed`]; bytes
/// already equal to the act's are [`Act::Same`].
///
/// **Only at a file the open handed out** (hist-safe QA A, 2026-10-12).  An act at any other path
/// is [`Act::Unasked`]: the question named only what the open handed out, so a write elsewhere
/// would land on bytes nobody decided on, and be recorded as the restore's.
///
/// **Only after his yes, where he is asked** (hist-safe QA A F2, 2026-10-12).  The answer was the
/// page's to remember, and a put-back over his flagged edit went before he answered, so "Keep
/// them" kept nothing.  A file the open asks about, every delete, and one an act's refusal put to
/// him again is [`Act::Unanswered`] until the engine holds his yes ([`Handout::yes`]).  A yes
/// given after a refusal also answers the route's own question: whose file it is.
///
/// # Arguments
/// * `puts` - The bytes the act puts there, or `None` for a delete.
pub fn act(
	handed:		Option<Handout>,
	landed:		&str,
	landed_folder:	Option<&str>,
	now:		Option<&[u8]>,
	puts:		Option<&[u8]>,
)
	-> Act
{
	let h = match handed {
		Some(h)	=> h,
		None	=> return Act::Unasked,
	};
	if (h.must || puts.is_none() || h.asked.is_some()) && h.yes.is_none() {
		return Act::Unanswered;
	}
	let over = h.asked.is_some() && h.yes.is_some();	// his yes to a question an act put
	let overwrites = !over && match (now, puts) {
		(Some(n), Some(p))	=> n != p,
		_			=> false,
	};
	match route(h.row, h.folder, landed, landed_folder, h.known, overwrites) {
		Route::Go	=> {},
		Route::Left	=> return Act::Left,
		Route::Ask(why)	=> return Act::Ask(why),
	}
	match bound(h.yes.unwrap_or(h.seen), now, puts) {
		Bound::Same	=> Act::Same,
		Bound::Go	=> Act::Go,
		Bound::Changed	=> Act::Changed,
	}
}

/// Is the person asked before a restore writes `target` over what stands at their path (`now`)?
/// Not where nothing stands, nor where it already holds `target`, nor where it holds `quiet`: for
/// an undo, what the undone version left there, which nobody has changed since.
///
/// **Item 6 of D-20261009-29 for every plan** (hist-safe R1, 2026-10-12).  Only a whole-version
/// restore asked; an undo -- "Restore before", "Undo this restore", a turn's Undo -- wrote over the
/// person's edit since the version unasked.
pub fn asks_over(now: &Seen, target: &str, quiet: Option<&str>) -> bool {
	match now {
		Seen::Absent	=> false,
		Seen::Unread	=> true,
		Seen::Bytes(h)	=> h != target && Some(h.as_str()) != quiet,
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
	// This device's versions alone: a turn another device ran names its paths, not these.
	for (n, m) in sorted.into_iter().filter(|(_, m)| m.is_here()) {
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
	undo_rows(manifests, of, paths, here).into_iter()
		.map(|(p, e)| (p, At::before(e).unwrap_or_else(|| At::made(e))))
		.collect()
}

/// What the rows [`undo_of`] undoes left at each path: the hash each wrote, or `None` where it
/// deleted the path.  A file that holds anything else now was changed since, by the person or by
/// someone else, so the undo asks before it writes over it (hist-safe R1, 2026-10-12).
pub fn undo_left<F>(manifests: &[(u64, Manifest)], of: u64, paths: &[String], here: F)
	-> Vec<(String, Option<String>)>
	where F: Fn(&str) -> Option<String>
{
	undo_rows(manifests, of, paths, here).into_iter()
		.map(|(p, e)| (p, if e.gone { None } else { Some(e.hash.clone()) }))
		.collect()
}

/// The row of each path that [`undo_of`] undoes, by its rule.
fn undo_rows<'a, F>(manifests: &'a [(u64, Manifest)], of: u64, paths: &[String], here: F)
	-> Vec<(String, &'a Entry)>
	where F: Fn(&str) -> Option<String>
{
	let mut out: Vec<(String, &Entry)> = Vec::new();
	for (path, rows) in rows_by_path(manifests).into_iter() {
		if !paths.is_empty() && !paths.iter().any(|p| p == path) {
			continue;
		}
		let first = rows.iter().map(|(n, _)| *n)
			.filter(|n| *n == of || (*n > of && !paths.is_empty()))
			.min();
		let h = here(path);
		if let Some(e) = first.and_then(|n| pick(&rows, n, h.as_deref())) {
			out.push((path.to_string(), e));
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
/// `PAGE_NEVER_WRITES`), his words log among them (`tools::KEEPER_LOGS`).
const KEEPER_FILES: [&str; 6] = ["crystal.json", "crystal.html", "crystal.md", "capp.json",
	"triggers.json", crate::agent::compact::WORDS_FILE];

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
	// candidates at all.  A turn another device ran whose keep there has run out goes before any
	// (RUN-HIST): its Undo is gone, and its rows were only ever a note of what happened there.
	let mut order: Vec<(u8, u64)> = manifests.iter()
		.filter(|(n, m)| *n != newest && !m.held_at(now))
		.map(|(n, m)| match m.away.as_ref().is_some_and(|a| a.lapsed_at(now)) {
			true  => (0, *n),
			false => (prune_rank_of(m, home, &page).saturating_add(1), *n),
		})
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
#[path = "../tests/unit/diamond_versions/tests.rs"]
mod tests;
#[cfg(test)]
#[path = "../tests/unit/diamond_versions/qa_d26a.rs"]
mod qa_d26a;
#[cfg(test)]
#[path = "../tests/unit/diamond_versions/made1.rs"]
mod made1;

#[cfg(test)]
#[path = "../tests/unit/diamond_versions/ublk26_change_refusals.rs"]
mod ublk26_change_refusals;

#[cfg(test)]
#[path = "../tests/unit/diamond_versions/made2.rs"]
mod made2;

#[cfg(test)]
#[path = "../tests/unit/diamond_versions/qa_portg_a.rs"]
mod qa_portg_a;
