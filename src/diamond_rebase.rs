//! What an import does with this device's own history before it lays another device's copy of a
//! Diamond over it.
//!
//! **Two devices mint the same version numbers, and a crystal snapshot is read through the one
//! below it** (audit of 2026-09-23, found beside R5).  The counter is the Diamond's, so two
//! devices that each record between syncs take the same next numbers, and `import_diamond` keeps
//! `versions/` and lays the other device's files over it by name.  That is a union for bodies and
//! not for a chain: a local `NNNN.json` keyframe and an incoming `NNNN.jpatch` stood at one
//! number and the reader took the keyframe, so version N read as this device's memory under the
//! other device's record of it; and this device's snapshots above the incoming counter stayed in
//! the chains every later version was read through.
//!
//! [`refile_plan`] keeps the rule R5 set for manifests -- nothing is written over, and what this
//! device recorded since the two parted is filed above both histories, in order, under numbers
//! nothing holds -- and applies it to a VERSION as a whole: the memory, the page, the file
//! manifest and the log record of one version move together, so a number still names one version
//! in the store, in the tools and in History.  The refiled run starts with full copies, so no
//! chain runs from one device's snapshots into the other's.

use crate::diamond_delta::{
	self,
	Snap,
	DATA_KEYFRAME_EXT,
	DATA_PATCH_EXT,
	PAGE_KEYFRAME_EXT,
	PAGE_PATCH_EXT,
};
use crate::diamond_versions::{
	hash_of,
	manifest_name,
	manifest_version,
};
use crate::llm::{
	extract_json_i64,
	extract_json_number,
	extract_json_string,
	json_escape,
};

use oxedyne_fe2o3_core::prelude::*;
use oxedyne_fe2o3_ore::diff;

use std::collections::{
	BTreeMap,
	BTreeSet,
};


// ┌───────────────────────────────────────────────────────────────┐
// │ The plan                                                       │
// └───────────────────────────────────────────────────────────────┘

/// One side of an import, as [`refile_plan`] reads it.
pub struct Side<'a> {
	pub files:	&'a BTreeMap<String, Vec<u8>>,	// `versions/` files by name, top level only
	pub lost:	&'a BTreeSet<String>,		// names listed there that could not be read
	pub log:	&'a str,			// `.daimond/log`, as it stands
}

/// What an import has to do with this device's own history before it lays its files down.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct Refile {
	pub fork:	Option<u64>,			// the first version the two sides do not share
	pub moves:	Vec<(u64, u64)>,		// a version of this device's, and the number it is filed at
	pub writes:	Vec<(String, Vec<u8>)>,		// `versions/` files to write, in this order
	pub drops:	Vec<String>,			// `versions/` files to remove once every write stands
	pub log:	Vec<String>,			// this device's own log lines, relabelled, for the import's log
	pub deltas:	Vec<(u64, u64)>,		// fold deltas to carry, from one number to the other
}

impl Refile {
	pub fn is_empty(&self) -> bool {
		self.moves.is_empty() && self.writes.is_empty() && self.drops.is_empty()
	}
}

/// Which of this device's versions an import must file above both histories, and the files that
/// carries them, so that afterwards every number reads as one device's version and no chain runs
/// through the other's.
///
/// **The fork is the first number at which the two do not hold the same version**: different
/// crystal snapshots, a manifest the import holds differently, or a log record of this device's
/// that the import does not carry.  Snapshots the import adds below this device's newest one count
/// too, since the reader would walk this device's later patches through them.  Every version this
/// device holds from the fork on is then one of three things:
///
/// - the same version the import holds at that number, byte for byte, and left alone;
/// - a version the import carries under another number (its log records say so, as a third device
///   refiling it would leave them), whose files here go, since they would stand among the
///   import's;
/// - this device's own, filed in order above `top` with its memory, its page, its manifest and its
///   log records -- the manifest unless the import already carries it, which R5's pass keeps once.
///
/// **The refiled run stands on its own.**  Its first memory and its first page are full copies
/// rebuilt from this device's chain; after that each snapshot is copied byte for byte where the
/// run below it holds exactly what it was recorded against, and written in full where it does not.
/// A snapshot that cannot be read or rebuilt here is not written again, and is removed: it was
/// already unreadable, and left in place it would stand among the import's.
///
/// # Arguments
/// * `mine` - This device's store.
/// * `theirs` - The copy arriving.
/// * `top` - The highest version number either side holds, counters included.
/// * `deltas` - The versions this device holds a retained fold delta for.
/// * `delta_ref` - The path a fold record names its delta by, for a version.
pub fn refile_plan<F>(
	mine:		&Side,
	theirs:		&Side,
	top:		u64,
	deltas:		&BTreeSet<u64>,
	delta_ref:	F,
)
	-> Refile
	where F: Fn(u64) -> String
{
	let ms = slots(mine);
	let ts = slots(theirs);
	let mine_recs  = records(mine.log);
	let their_recs = records(theirs.log);
	let their_ids: BTreeMap<&str, u64> = their_recs.iter()
		.map(|r| (r.id.as_str(), r.version))
		.collect();
	let mut recs_at: BTreeMap<u64, Vec<&Rec>> = BTreeMap::new();
	for r in mine_recs.iter() {
		recs_at.entry(r.version).or_default().push(r);
	}
	// The manifests the import carries anywhere, by content: one of those held here is the same
	// record, and R5's pass keeps it once.
	let carried: BTreeSet<String> = ts.values()
		.filter_map(|s| s.manifest.as_ref())
		.filter_map(|name| theirs.files.get(name))
		.map(|b| hash_of(b))
		.collect();
	let is_carried = |name: &str| -> bool {
		match mine.files.get(name) {
			Some(b)	=> carried.contains(&hash_of(b)),
			None	=> false,
		}
	};
	let empty = Slot::default();

	// The crystal snapshots at one number, the same on both sides byte for byte.
	let same_crystal = |n: u64| -> bool {
		let (a, b) = (at(&ms, n, &empty), at(&ts, n, &empty));
		let mut an: Vec<&String> = a.crystal().collect();
		let mut bn: Vec<&String> = b.crystal().collect();
		an.sort();
		bn.sort();
		an == bn && an.iter().all(|name| match (mine.files.get(*name), theirs.files.get(*name)) {
			(Some(x), Some(y))	=> x == y,
			_			=> false,
		})
	};
	let same_manifest = |x: &str, y: &str| -> bool {
		match (mine.files.get(x), theirs.files.get(y)) {
			(Some(a), Some(b))	=> a == b,
			_			=> false,
		}
	};
	let top_crystal = ms.iter().filter(|(_, s)| s.has_crystal()).map(|(n, _)| *n).max();

	let differs = |n: u64| -> bool {
		let (a, b) = (at(&ms, n, &empty), at(&ts, n, &empty));
		// A snapshot the import adds under this device's newest one differs as much as one it
		// replaces: this device's later patches would be read through it.
		let crystal = !same_crystal(n)
			&& (a.has_crystal() || top_crystal.map_or(false, |t| n < t));
		let manifest = match (&a.manifest, &b.manifest) {
			(Some(x), Some(y))	=> !same_manifest(x, y) && !is_carried(x),
			// A version here with files and no crystal, where the import's has a crystal. A
			// manifest here the import merely lacks, over the same crystal, is one it pruned.
			(Some(x), None)		=> !a.has_crystal() && b.has_crystal() && !is_carried(x),
			_			=> false,
		};
		let record = recs_at.get(&n).map_or(false,
			|rs| rs.iter().any(|r| !their_ids.contains_key(r.id.as_str())));
		crystal || manifest || record
	};

	let mut numbers: BTreeSet<u64> = ms.keys().copied().collect();
	numbers.extend(recs_at.keys().copied());
	if let Some(t) = top_crystal {
		numbers.extend(ts.keys().copied().filter(|n| *n < t));
	}
	let fork = match numbers.iter().copied().find(|n| differs(*n)) {
		Some(f)	=> f,
		None	=> return Refile::default(),
	};

	let fate = |n: u64| -> Fate {
		let (a, b) = (at(&ms, n, &empty), at(&ts, n, &empty));
		let rs = recs_at.get(&n);
		let recs_same = rs.map_or(true,
			|rs| rs.iter().all(|r| their_ids.get(r.id.as_str()) == Some(&n)));
		let manifest_same = match (&a.manifest, &b.manifest) {
			(Some(x), Some(y))	=> same_manifest(x, y),
			_			=> true,
		};
		if same_crystal(n) && recs_same && manifest_same {
			return Fate::Same;
		}
		let elsewhere = rs.map_or(false, |rs| !rs.is_empty() && rs.iter().all(
				|r| matches!(their_ids.get(r.id.as_str()), Some(v) if *v != n)))
			&& a.manifest.as_ref().map_or(true, |x| is_carried(x));
		if elsewhere { Fate::Elsewhere } else { Fate::Refile }
	};

	// Every number this device holds anything at from the fork on, and what becomes of it.
	let mut held: BTreeSet<u64> = ms.keys().copied().filter(|n| *n >= fork).collect();
	held.extend(recs_at.keys().copied().filter(|n| *n >= fork));
	let top = [
		Some(top),
		ms.keys().max().copied(),
		ts.keys().max().copied(),
		recs_at.keys().max().copied(),
		their_recs.iter().map(|r| r.version).max(),
	].iter().filter_map(|n| *n).max().unwrap_or(top);
	let mut out = Refile { fork: Some(fork), ..Refile::default() };
	let mut fates: Vec<(u64, Fate)> = Vec::with_capacity(held.len());
	let mut next = top;
	for n in held.into_iter() {
		let f = fate(n);
		if f == Fate::Refile {
			next = next.saturating_add(1);
			out.moves.push((n, next));
		}
		fates.push((n, f));
	}
	let moved: BTreeMap<u64, u64> = out.moves.iter().copied().collect();

	// This device's two files as its own reader has them just below the fork, walked forward one
	// snapshot at a time; and what a reader of the refiled run holds below the next number it is
	// given.  Below the run's first page stands the import's newest page.
	let below = fork.checked_sub(1);
	let mut mine_data = match below {
		Some(b)	=> rebuild(mine, &ms, false, b),
		None	=> Held::Nothing,
	};
	let mut mine_page = match below {
		Some(b)	=> rebuild(mine, &ms, true, b),
		None	=> Held::Nothing,
	};
	let mut run_data: Option<Vec<u8>> = None;
	let mut run_page = match ts.iter().filter(|(_, s)| !s.page.is_empty()).map(|(n, _)| *n).max() {
		Some(t)	=> rebuild(theirs, &ts, true, t),
		None	=> Held::Nothing,
	};
	let mut run_page_own = false;

	for (n, f) in fates.into_iter() {
		let slot = at(&ms, n, &empty);
		let data_file = Slot::taken(&slot.data).cloned();
		let data_below = mine_data.clone();
		if let Some((name, snap)) = &data_file {
			mine_data = advance(&data_below, *snap, mine.files.get(name));
		}
		let page_file = Slot::taken(&slot.page).cloned();
		let page_below = mine_page.clone();
		if let Some((name, snap)) = &page_file {
			mine_page = advance(&page_below, *snap, mine.files.get(name));
		}
		let to = match (f, moved.get(&n)) {
			(Fate::Same, _)		=> continue,
			(Fate::Elsewhere, _)	=> {
				out.drops.extend(slot.crystal().cloned());
				continue;
			},
			(Fate::Refile, Some(to))	=> *to,
			(Fate::Refile, None)		=> continue,
		};
		// The memory, which every version holds.
		if let Some((name, snap)) = &data_file {
			match &mine_data {
				Held::Bytes(content) => {
					let copy = match snap {
						Snap::Keyframe	=> true,
						Snap::Patch	=> matches!((&run_data, &data_below),
							(Some(r), Held::Bytes(b)) if r == b),
					};
					match (copy, mine.files.get(name)) {
						(true, Some(bytes))	=> out.writes.push(
							(snap_name(to, false, *snap), bytes.clone())),
						_			=> out.writes.push(
							(snap_name(to, false, Snap::Keyframe), content.clone())),
					}
					run_data = Some(content.clone());
				},
				_ => run_data = None,
			}
		}
		// The page, only where what a reader would otherwise find below is not it.
		if !mine_page.reads_as(&run_page) {
			match &mine_page {
				Held::Bytes(p) => {
					let copy = match &page_file {
						Some((_, Snap::Keyframe))	=> true,
						Some((_, Snap::Patch))		=> run_page_own && run_page == page_below,
						None				=> false,
					};
					let bytes = page_file.as_ref().and_then(|(name, _)| mine.files.get(name));
					match (copy, bytes, &page_file) {
						(true, Some(b), Some((_, snap)))	=> out.writes.push(
							(snap_name(to, true, *snap), b.clone())),
						_					=> out.writes.push(
							(snap_name(to, true, Snap::Keyframe), p.clone())),
					}
					run_page = mine_page.clone();
					run_page_own = true;
				},
				// This device had no page here and the import has one below: an empty page
				// reads as none, and keeps the import's from standing in for it.
				Held::Nothing => {
					out.writes.push((snap_name(to, true, Snap::Keyframe), Vec::new()));
					run_page = Held::Bytes(Vec::new());
					run_page_own = true;
				},
				Held::Unknown => run_page = Held::Unknown,
			}
		}
		out.drops.extend(slot.crystal().cloned());
		if let Some(name) = &slot.manifest {
			match mine.files.get(name) {
				Some(bytes) if !is_carried(name)	=> {
					out.writes.push((manifest_name(to), bytes.clone()));
					out.drops.push(name.clone());
				},
				Some(_)	=> {},				// the import carries it: R5's pass keeps it once
				None	=> out.drops.push(name.clone()),	// unreadable, and not to stand among the import's
			}
		}
	}

	// The log records of the versions refiled, under their new numbers.  A record the import
	// already carries is not carried twice.
	for (n, to) in out.moves.iter() {
		let rs = match recs_at.get(n) {
			Some(rs)	=> rs,
			None		=> continue,
		};
		for r in rs.iter() {
			if their_ids.contains_key(r.id.as_str()) {
				continue;
			}
			let parent = extract_json_i64(r.line, "parent_crystal_version").map(|p| {
				match moved.get(&(p.max(0) as u64)) {
					Some(m) if p >= 0	=> *m as i64,
					_			=> p,
				}
			});
			let dref = match extract_json_string(r.line, "delta_ref") {
				Some(d) if !d.is_empty() && d == delta_ref(*n) => if deltas.contains(n) {
					out.deltas.push((*n, *to));
					Some(delta_ref(*to))
				} else {
					Some(String::new())		// the delta goes with the import
				},
				_ => None,
			};
			if let Some(line) = relabel(r.line, *to, parent, dref.as_deref()) {
				out.log.push(line);
			}
		}
	}
	out.deltas.sort();
	out.deltas.dedup();
	out
}


// ┌───────────────────────────────────────────────────────────────┐
// │ What is at each number                                         │
// └───────────────────────────────────────────────────────────────┘

/// What becomes of a version this device holds at or above the fork.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Fate {
	Same,		// the import holds it at the same number
	Elsewhere,	// the import holds it at another number
	Refile,		// this device's own
}

/// What a `versions/` file is.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Kind {
	Data(Snap),
	Page(Snap),
	Manifest,
}

/// Which version a `versions/` file belongs to and what it is, or `None` for anything else: the
/// body directory, a pre-migration `.md`, somebody else's file.
fn kind_of(name: &str) -> Option<(u64, Kind)> {
	if let Some(n) = manifest_version(name) {
		return Some((n, Kind::Manifest));
	}
	let kinds = [
		(DATA_KEYFRAME_EXT,	Kind::Data(Snap::Keyframe)),
		(DATA_PATCH_EXT,	Kind::Data(Snap::Patch)),
		(PAGE_KEYFRAME_EXT,	Kind::Page(Snap::Keyframe)),
		(PAGE_PATCH_EXT,	Kind::Page(Snap::Patch)),
	];
	for (ext, kind) in kinds.iter() {
		if let Some(n) = name.strip_suffix(ext).and_then(|s| s.parse::<u64>().ok()) {
			return Some((n, *kind));
		}
	}
	None
}

/// A snapshot's file name.
fn snap_name(n: u64, page: bool, snap: Snap) -> String {
	let ext = match (page, snap) {
		(false, Snap::Keyframe)	=> DATA_KEYFRAME_EXT,
		(false, Snap::Patch)	=> DATA_PATCH_EXT,
		(true, Snap::Keyframe)	=> PAGE_KEYFRAME_EXT,
		(true, Snap::Patch)	=> PAGE_PATCH_EXT,
	};
	fmt!("{:04}{}", n, ext)
}

/// What one side holds at one version number.
#[derive(Default)]
struct Slot {
	data:		Vec<(String, Snap)>,	// two only where a failed write left both
	page:		Vec<(String, Snap)>,
	manifest:	Option<String>,
}

impl Slot {
	/// The snapshot a reader takes: the keyframe, where a number somehow holds both.
	fn taken(v: &[(String, Snap)]) -> Option<&(String, Snap)> {
		match v.iter().find(|(_, s)| *s == Snap::Keyframe) {
			Some(k)	=> Some(k),
			None	=> v.first(),
		}
	}

	fn crystal(&self) -> impl Iterator<Item = &String> {
		self.data.iter().chain(self.page.iter()).map(|(name, _)| name)
	}

	fn has_crystal(&self) -> bool {
		!self.data.is_empty() || !self.page.is_empty()
	}
}

/// One side's slot at `n`, or the empty one where it holds nothing there.
fn at<'a>(m: &'a BTreeMap<u64, Slot>, n: u64, empty: &'a Slot) -> &'a Slot {
	match m.get(&n) {
		Some(s)	=> s,
		None	=> empty,
	}
}

fn slots(side: &Side) -> BTreeMap<u64, Slot> {
	let mut out: BTreeMap<u64, Slot> = BTreeMap::new();
	for name in side.files.keys().chain(side.lost.iter()) {
		let (n, kind) = match kind_of(name) {
			Some(k)	=> k,
			None	=> continue,
		};
		let slot = out.entry(n).or_default();
		match kind {
			Kind::Data(s)	=> slot.data.push((name.clone(), s)),
			Kind::Page(s)	=> slot.page.push((name.clone(), s)),
			Kind::Manifest	=> slot.manifest = Some(name.clone()),
		}
	}
	out
}


// ┌───────────────────────────────────────────────────────────────┐
// │ Rebuilding                                                     │
// └───────────────────────────────────────────────────────────────┘

/// What a reader holds for one file at one point in a chain.
#[derive(Clone, Debug, Eq, PartialEq)]
enum Held {
	Bytes(Vec<u8>),
	Nothing,	// no snapshot at or below it
	Unknown,	// one that cannot be read or rebuilt
}

impl Held {
	/// Do the two read as the same file?  No page and an empty page both read as none.
	fn reads_as(&self, other: &Held) -> bool {
		match (self, other) {
			(Held::Bytes(a), Held::Bytes(b))	=> a == b,
			(Held::Bytes(a), Held::Nothing)		=> a.is_empty(),
			(Held::Nothing, Held::Bytes(b))		=> b.is_empty(),
			(Held::Nothing, Held::Nothing)		=> true,
			_					=> false,
		}
	}
}

/// One side's file as at `want`, the newest snapshot at or below it, rebuilt as its reader would.
fn rebuild(side: &Side, slots: &BTreeMap<u64, Slot>, page: bool, want: u64) -> Held {
	let snaps: Vec<(u64, Snap)> = slots.iter()
		.filter_map(|(n, s)| Slot::taken(if page { &s.page } else { &s.data }).map(|(_, k)| (*n, *k)))
		.collect();
	let chain = match diamond_delta::plan_upto(&snaps, want) {
		Ok(Some((_, c)))	=> c,
		Ok(None)		=> return Held::Nothing,
		Err(_)			=> return Held::Unknown,
	};
	let mut files: Vec<Vec<u8>> = Vec::with_capacity(chain.len());
	for n in chain.iter() {
		let name = match slots.get(n).and_then(|s| Slot::taken(if page { &s.page } else { &s.data })) {
			Some((name, _))	=> name,
			None		=> return Held::Unknown,
		};
		match side.files.get(name) {
			Some(b)	=> files.push(b.clone()),
			None	=> return Held::Unknown,
		}
	}
	let mut it = files.into_iter();
	let kf = match it.next() {
		Some(k)	=> k,
		None	=> return Held::Unknown,
	};
	let patches: Vec<Vec<u8>> = it.collect();
	match diamond_delta::materialise(kf, &patches) {
		Ok(b)	=> Held::Bytes(b),
		Err(_)	=> Held::Unknown,
	}
}

/// The file one snapshot further on: a keyframe stands alone, a patch applies to what is below it.
fn advance(below: &Held, snap: Snap, bytes: Option<&Vec<u8>>) -> Held {
	match (snap, bytes, below) {
		(Snap::Keyframe, Some(b), _)			=> Held::Bytes(b.clone()),
		(Snap::Patch, Some(p), Held::Bytes(base))	=> match diff::apply_patch(base, p) {
			Ok(out)	=> Held::Bytes(out),
			Err(_)	=> Held::Unknown,
		},
		_						=> Held::Unknown,
	}
}


// ┌───────────────────────────────────────────────────────────────┐
// │ Log records                                                    │
// └───────────────────────────────────────────────────────────────┘

/// One line of a Diamond's log, as the plan needs it.
struct Rec<'a> {
	id:		String,
	version:	u64,
	line:		&'a str,
}

/// The records of a log that carry an id and a version.  A record written before the rename says
/// `brief_version`.
fn records(log: &str) -> Vec<Rec<'_>> {
	let mut out: Vec<Rec> = Vec::new();
	for line in log.lines() {
		let line = line.trim();
		if line.is_empty() {
			continue;
		}
		let id = match extract_json_string(line, "id") {
			Some(i) if !i.is_empty()	=> i,
			_				=> continue,
		};
		let version = match extract_json_number(line, "crystal_version") {
			Some(v)	=> v,
			None	=> match extract_json_number(line, "brief_version") {
				Some(v)	=> v,
				None	=> continue,
			},
		};
		out.push(Rec { id, version, line });
	}
	out
}

/// A record under a new version number, with its parent and its delta path changed where given.
/// `None` where the line has no `crystal_version` this can find.
fn relabel(line: &str, version: u64, parent: Option<i64>, delta: Option<&str>) -> Option<String> {
	let mut out = match with_value(line, "crystal_version", &fmt!("{}", version)) {
		Some(l)	=> l,
		None	=> return None,
	};
	if let Some(p) = parent {
		if let Some(l) = with_value(&out, "parent_crystal_version", &fmt!("{}", p)) {
			out = l;
		}
	}
	if let Some(d) = delta {
		if let Some(l) = with_value(&out, "delta_ref", &fmt!("\"{}\"", json_escape(d))) {
			out = l;
		}
	}
	Some(out)
}

/// The line with the value of one top-level key replaced by `value`, already encoded.
fn with_value(json: &str, key: &str, value: &str) -> Option<String> {
	match value_span(json, key) {
		Some((s, e))	=> Some(fmt!("{}{}{}", &json[..s], value, &json[e..])),
		None		=> None,
	}
}

/// Where the value of a top-level key of a one-line JSON object sits, as a byte range.
///
/// Walked key by key rather than searched for, because a note or a task may hold any text,
/// including one that looks like a key.
fn value_span(json: &str, key: &str) -> Option<(usize, usize)> {
	let b = json.as_bytes();
	let mut i = skip_ws(b, 0);
	if b.get(i) != Some(&b'{') {
		return None;
	}
	i += 1;
	loop {
		i = skip_ws(b, i);
		if b.get(i) != Some(&b'"') {
			return None;
		}
		let kend = match string_end(b, i) {
			Some(e)	=> e,
			None	=> return None,
		};
		let name = &json[i + 1..kend];
		i = skip_ws(b, kend + 1);
		if b.get(i) != Some(&b':') {
			return None;
		}
		i = skip_ws(b, i + 1);
		let vstart = i;
		let vend = match value_end(b, i) {
			Some(e)	=> e,
			None	=> return None,
		};
		if name == key {
			return Some((vstart, vend));
		}
		i = skip_ws(b, vend);
		match b.get(i) {
			Some(b',')	=> i += 1,
			_		=> return None,
		}
	}
}

/// The index of the quote closing the string that opens at `at`.
fn string_end(b: &[u8], at: usize) -> Option<usize> {
	let mut i = at + 1;
	while i < b.len() {
		match b[i] {
			b'\\'	=> i += 2,
			b'"'	=> return Some(i),
			_	=> i += 1,
		}
	}
	None
}

/// One past the end of the value that opens at `at`.
fn value_end(b: &[u8], at: usize) -> Option<usize> {
	match b.get(at) {
		Some(b'"') => string_end(b, at).map(|e| e + 1),
		Some(b'{') | Some(b'[') => {
			let mut depth = 0usize;
			let mut i = at;
			while i < b.len() {
				match b[i] {
					b'"' => {
						i = match string_end(b, i) {
							Some(e)	=> e + 1,
							None	=> return None,
						};
						continue;
					},
					b'{' | b'['	=> depth += 1,
					b'}' | b']'	=> {
						depth = depth.saturating_sub(1);
						if depth == 0 {
							return Some(i + 1);
						}
					},
					_		=> {},
				}
				i += 1;
			}
			None
		},
		Some(_) => {
			let mut i = at;
			while i < b.len() && !matches!(b[i], b',' | b'}' | b']') && !b[i].is_ascii_whitespace() {
				i += 1;
			}
			if i == at { None } else { Some(i) }
		},
		None => None,
	}
}

fn skip_ws(b: &[u8], mut i: usize) -> usize {
	while i < b.len() && b[i].is_ascii_whitespace() {
		i += 1;
	}
	i
}


/// What a wholesale replace does with one entry of the Diamond's directory.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OnReplace {
	Keep,		// survives the replace whole
	Descend,	// a directory holding something kept: its entries are weighed one by one
	Delete,
}

/// What a pull's wholesale replace does with the entry at `rel` under the Diamond's directory.
/// The version store survives it (S-SYNC #4), and so does the activity record (item 24): each
/// device's file holds lines no export carries yet, and joined in place it is never off the disk.
pub fn on_replace(rel: &str) -> OnReplace {
	const KEPT: [&str; 2] = ["versions", crate::activity::ACTIVITY_DIR];
	if KEPT.contains(&rel) {
		return OnReplace::Keep;
	}
	if KEPT.iter().any(|k| k.len() > rel.len() && k.starts_with(rel) && k.as_bytes()[rel.len()] == b'/') {
		return OnReplace::Descend;
	}
	OnReplace::Delete
}


#[cfg(test)]
#[path = "../tests/unit/diamond_rebase/tests.rs"]
mod tests;
