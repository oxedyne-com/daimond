//! Crystal version history as a delta log: what is stored at each version, and
//! which stored files rebuild any one of them.
//!
//! Every capp page edit used to write a full uncompressed copy of the page into
//! `versions/`, and nothing anywhere prunes them. The shipped Log Life page is
//! 101,834 bytes, so a hundred edits was 10.2 MB against a per-Diamond share of
//! 4 MiB -- and the daimon had already computed the difference twice by then and
//! thrown it away both times.
//!
//! So a version stores either a full copy, called a KEYFRAME, or the splices
//! from the snapshot before it, called a PATCH. One keyframe every
//! [`KEYFRAME_EVERY`] versions bounds two things that rebuild time does not:
//! how much history one bad patch can invalidate, and how many files the history
//! view reads to answer a question about an old version.
//!
//! The OPFS edge that reads and writes the files lives in
//! [`crate::wasm::diamond`], which is compiled only for wasm32 and so cannot be
//! reached by the native test suite. What decides -- when a keyframe is due,
//! which files rebuild version N, and whether a patch may be recorded at all --
//! sits here instead, where it is tested against the real page.
//!
//! # Why nothing here can record a delta that will not read back
//!
//! [`record`] never returns a patch it has not already applied. It gets its
//! patch from [`oxedyne_fe2o3_ore::diff::make_patch`], which decodes and applies
//! what it just encoded and refuses to return anything whose reconstruction is
//! not the bytes it was given; and where that refuses, [`record`] falls back to
//! the full copy the store wrote before this module existed. A patch is
//! therefore either provably reconstructible or not written, and the failure
//! mode of every fault in the diff, the encoding and the decoding is one
//! keyframe -- which costs space and loses nothing.

use oxedyne_fe2o3_core::prelude::*;
use oxedyne_fe2o3_ore::diff;


/// How many versions one full copy has to serve.
///
/// Not bought by rebuild time, which is negligible -- a thousand-deep chain
/// rebuilds in about two milliseconds. Bought by blast radius, because one bad
/// patch invalidates every version back to the keyframe before it, and by the
/// history view, which reads the whole chain to show one old version. Twenty
/// bounds the loss at twenty versions and costs five per cent of one full copy
/// per version.
pub const KEYFRAME_EVERY: usize = 20;

// What a snapshot of each file is called, after its version number.  A version holds the keyframe
// extension or the patch one and never both; where it somehow holds both, the keyframe wins,
// because that is the one that stands on its own.
pub const DATA_KEYFRAME_EXT:	&str = ".json";
pub const DATA_PATCH_EXT:	&str = ".jpatch";
pub const PAGE_KEYFRAME_EXT:	&str = ".html";
pub const PAGE_PATCH_EXT:	&str = ".hpatch";


/// What one stored snapshot is.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Snap {
	Keyframe,	// the file's whole bytes
	Patch,		// splices from the snapshot before this one
}

/// What [`record`] decided to store, and the bytes to store.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Recorded {
	Keyframe(Vec<u8>),
	Patch(Vec<u8>),
}

impl Recorded {
	pub fn bytes(&self) -> &[u8] {
		match self {
			Self::Keyframe(b)	=> b,
			Self::Patch(b)		=> b,
		}
	}

	pub fn snap(&self) -> Snap {
		match self {
			Self::Keyframe(_)	=> Snap::Keyframe,
			Self::Patch(_)		=> Snap::Patch,
		}
	}

	/// Does this hold splices rather than a whole file?
	pub fn is_patch(&self) -> bool {
		matches!(self, Self::Patch(_))
	}
}


/// Is the next snapshot due to be a full copy?
///
/// True where there is no full copy to build on at all, and true where
/// [`KEYFRAME_EVERY`] - 1 patches already stand between the newest snapshot and
/// the keyframe under them -- so a chain is never longer than that, and one
/// version in [`KEYFRAME_EVERY`] is a full copy.
///
/// Counted over the snapshots rather than taken from the version number,
/// because the page is snapshotted only where it changed: its versions are
/// sparse and arbitrary, and `N % 20` over them would put keyframes wherever
/// the user happened to edit.
pub fn wants_keyframe(snaps: &[(u64, Snap)]) -> bool {
	let mut sorted: Vec<(u64, Snap)> = snaps.to_vec();
	sorted.sort_by_key(|(n, _)| *n);
	let last_kf = sorted.iter().rposition(|(_, s)| *s == Snap::Keyframe);
	match last_kf {
		None		=> true,
		Some(at)	=> sorted.len() - 1 - at >= KEYFRAME_EVERY - 1,
	}
}

/// What to store for a new version of a file, given the file as it stood at the
/// snapshot before it and the snapshots already held.
///
/// **A patch comes back only when it has already been applied and the result
/// compared with `new`.** That check is inside
/// [`oxedyne_fe2o3_ore::diff::make_patch`], which refuses rather than returning
/// a patch whose reconstruction is not the bytes it was handed, and every
/// refusal lands here as a keyframe. The failure mode of the whole delta log is
/// therefore the full copy the store wrote before it existed.
///
/// A patch no smaller than the file is refused as well, so a version whose
/// content was replaced wholesale costs a full copy and not a full copy plus a
/// header.
///
/// # Arguments
/// * `parent` - The file as at the snapshot before this one, or `None` where
///   there is no snapshot before it or it could not be rebuilt.
/// * `new` - The file as it now stands.
/// * `snaps` - Every snapshot already held for this file, in any order.
pub fn record(parent: Option<&[u8]>, new: &[u8], snaps: &[(u64, Snap)]) -> Recorded {
	let old = match parent {
		Some(o) if !wants_keyframe(snaps)	=> o,
		_					=> return Recorded::Keyframe(new.to_vec()),
	};
	match diff::make_patch(old, new) {
		Ok(p) if p.len() < new.len()	=> Recorded::Patch(p),
		_				=> Recorded::Keyframe(new.to_vec()),
	}
}

/// Which snapshots rebuild the file as at exactly `want`, keyframe first.
///
/// For the crystal's memory, which is snapshotted at every version. A version
/// with no snapshot of its own is an error and not a walk back to an older one:
/// answering "what did this hold at v12" with v9's bytes, silently, is the one
/// failure a delta log must not have.
pub fn plan_at(snaps: &[(u64, Snap)], want: u64)
	-> Outcome<Vec<u64>>
{
	let sorted = sorted(snaps);
	let at = match sorted.iter().position(|(n, _)| *n == want) {
		Some(i)	=> i,
		None	=> return Err(err!(
			"Version {} has no snapshot of its own, and the versions either side of it are \
			not it.", want; Missing, Data)),
	};
	back_to_keyframe(&sorted, at, want)
}

/// Which snapshots rebuild the file as at the newest version at or before
/// `want`, keyframe first, and which version that is.
///
/// For the page, which is snapshotted only where it changed, so most versions
/// have none and asking for one of those is asking for whatever page was on
/// screen at the time. `None` means nothing was ever stored at or before
/// `want`, which is what every version from before there were pages says.
pub fn plan_upto(snaps: &[(u64, Snap)], want: u64)
	-> Outcome<Option<(u64, Vec<u64>)>>
{
	let sorted = sorted(snaps);
	let at = match sorted.iter().rposition(|(n, _)| *n <= want) {
		Some(i)	=> i,
		None	=> return Ok(None),
	};
	let target = sorted[at].0;
	Ok(Some((target, res!(back_to_keyframe(&sorted, at, target)))))
}

/// Rebuild a file from the keyframe and the patches after it, in the order
/// [`plan_at`] and [`plan_upto`] gave them.
///
/// Every patch names the length and the checksum of what it was made against
/// and of what it makes, so a chain assembled in the wrong order, one missing a
/// link, or one carrying a decayed file, is refused at the link that is wrong.
/// Nothing here returns a partial rebuild, and in particular nothing returns
/// the keyframe when the patches over it could not be applied.
pub fn materialise(keyframe: Vec<u8>, patches: &[Vec<u8>])
	-> Outcome<Vec<u8>>
{
	let mut at = keyframe;
	for (i, p) in patches.iter().enumerate() {
		at = match diff::apply_patch(&at, p) {
			Ok(b)	=> b,
			Err(e)	=> return Err(err!(e,
				"Patch {} of {} in this version's chain could not be applied to the {} \
				bytes under it.", i + 1, patches.len(), at.len(); Invalid, Data)),
		};
	}
	Ok(at)
}

/// Does a snapshot stand between the version the Diamond is at and the one about to be written?
///
/// **The reader and the writer have to agree on what a patch is against.**  A reader applies a
/// version's patch to the snapshot below it in number order ([`plan_at`]); a writer records it
/// against the version the Diamond is at.  The two are the same snapshot until something is filed
/// above the counter -- this device's own history kept above another device's by an import, or a
/// version whose metadata never landed -- and a patch recorded then is read over the wrong bytes
/// and never rebuilds.  So where one stands between, the new version is written in full, which
/// also starts a chain that runs through nothing filed from elsewhere.
///
/// # Arguments
/// * `snaps` - The file's snapshots.
/// * `live` - The version the Diamond is at.
/// * `next` - The version about to be written.
pub fn stands_between(snaps: &[(u64, Snap)], live: u64, next: u64) -> bool {
	snaps.iter().any(|(n, _)| *n > live && *n < next)
}

/// Version numbers in the order a reader falls back through them when the file itself is gone:
/// the version the Diamond is at and every one below it, newest first, and only then anything
/// filed above it.
///
/// Newest first alone would answer with whatever stands highest, and after an import that is this
/// device's own history kept above the copy that arrived -- a memory that is no longer the one the
/// Diamond is at.
pub fn live_first(mut ns: Vec<u64>, live: u64) -> Vec<u64> {
	ns.sort_unstable_by(|a, b| (*a > live).cmp(&(*b > live)).then(b.cmp(a)));
	ns
}

fn sorted(snaps: &[(u64, Snap)]) -> Vec<(u64, Snap)> {
	let mut out: Vec<(u64, Snap)> = snaps.to_vec();
	out.sort_by_key(|(n, _)| *n);
	out
}

/// The run from the last keyframe at or below `at` up to `at` inclusive.
fn back_to_keyframe(sorted: &[(u64, Snap)], at: usize, want: u64)
	-> Outcome<Vec<u64>>
{
	let mut i = at;
	loop {
		if sorted[i].1 == Snap::Keyframe {
			return Ok(sorted[i..=at].iter().map(|(n, _)| *n).collect());
		}
		if i == 0 {
			return Err(err!(
				"Version {} is built on patches all the way back to version {}, and there is \
				no full copy under them.", want, sorted[0].0; Missing, Data));
		}
		i -= 1;
	}
}


#[cfg(test)]
#[path = "../tests/unit/diamond_delta/tests.rs"]
mod tests;
