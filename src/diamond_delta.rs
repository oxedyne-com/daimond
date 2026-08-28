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
mod tests {
	use super::*;

	use std::collections::HashMap;

	/// The shipped Log Life page, 101,834 bytes: the file `versions/` is
	/// actually full of, and the one the owner's own Diamond has been
	/// accumulating full copies of. A fixture shaped by hand would flatter the
	/// diff; this is the real thing, its real CSS, its real script and its real
	/// repeated markup.
	const PAGE: &str = include_str!("../www/capps/lifelog/crystal.html");

	/// A whole stored history for one file: what each version holds, and what a
	/// reader gets back for it.
	///
	/// Not a mock. These are [`record`], [`plan_at`] and [`materialise`]
	/// themselves, with the OPFS calls replaced by a map -- which is exactly
	/// what [`crate::wasm::diamond`] puts round them.
	struct Log {
		held:  Vec<(u64, Snap)>,
		bytes: HashMap<u64, Vec<u8>>,
	}

	impl Log {
		fn new() -> Self {
			Self { held: Vec::new(), bytes: HashMap::new() }
		}

		fn write(&mut self, version: u64, content: &[u8])
			-> Outcome<Snap>
		{
			let parent = match self.held.iter().map(|(n, _)| *n).max() {
				Some(p)	=> Some(res!(self.read(p))),
				None	=> None,
			};
			let rec = record(parent.as_deref(), content, &self.held);
			self.bytes.insert(version, rec.bytes().to_vec());
			self.held.push((version, rec.snap()));
			Ok(rec.snap())
		}

		fn read(&self, version: u64)
			-> Outcome<Vec<u8>>
		{
			let chain = res!(plan_at(&self.held, version));
			self.follow(&chain)
		}

		fn follow(&self, chain: &[u64])
			-> Outcome<Vec<u8>>
		{
			let kf = res!(self.file(chain[0]));
			let mut patches: Vec<Vec<u8>> = Vec::new();
			for n in &chain[1..] {
				patches.push(res!(self.file(*n)));
			}
			materialise(kf, &patches)
		}

		fn file(&self, version: u64)
			-> Outcome<Vec<u8>>
		{
			match self.bytes.get(&version) {
				Some(b)	=> Ok(b.clone()),
				None	=> Err(err!("Version {} has no file.", version; Missing, Data)),
			}
		}

		fn stored(&self) -> usize {
			self.bytes.values().map(|b| b.len()).sum()
		}

		fn keyframes(&self) -> usize {
			self.held.iter().filter(|(_, s)| *s == Snap::Keyframe).count()
		}
	}

	/// One turn's worth of change to a capp page, of the shapes the daimon's
	/// own `file_edit` makes. Deterministic, so a failure is reproducible.
	fn turn(page: &str, n: usize) -> String {
		let mut lines: Vec<String> = page.split('\n').map(|s| s.to_string()).collect();
		let len = lines.len();
		match n % 4 {
			// The commonest turn by far: one line, changed.
			0 => {
				let at = (n * 37 + 11) % len;
				lines[at] = fmt!("{} <!-- {} -->", lines[at], n);
			},
			// A small block rewritten, which is what a fix to one function is.
			1 => {
				let at = (n * 53 + 7) % (len - 3);
				for k in 0..3 {
					lines[at + k] = fmt!("  /* turn {} line {} */", n, k);
				}
			},
			// A section added, which is what a new lane or a new card is.
			2 => {
				let at = (n * 71 + 3) % len;
				let mut block: Vec<String> = Vec::new();
				block.push(fmt!("<section class=\"lane lane-{}\">", n));
				for k in 0..6 {
					block.push(fmt!("  <div class=\"row\" data-k=\"{}\">entry {}</div>", k, n));
				}
				block.push("</section>".to_string());
				for (k, b) in block.into_iter().enumerate() {
					lines.insert(at + k, b);
				}
			},
			// A value changed in the stylesheet, which is a theme tweak.
			_ => {
				let at = (n * 17 + 5) % len;
				lines[at] = lines[at].replace("128", &fmt!("{}", 100 + (n % 50)));
			},
		}
		lines.join("\n")
	}

	/// A hundred turns of the real page, and the whole history read back.
	fn hundred() -> Outcome<(Log, Vec<Vec<u8>>)> {
		let mut log = Log::new();
		let mut want: Vec<Vec<u8>> = Vec::new();
		let mut cur = PAGE.to_string();
		res!(log.write(0, cur.as_bytes()));
		want.push(cur.clone().into_bytes());
		for n in 1..=100usize {
			cur = turn(&cur, n);
			res!(log.write(n as u64, cur.as_bytes()));
			want.push(cur.clone().into_bytes());
		}
		Ok((log, want))
	}


	/// The fixture is the file the measurements were taken against, so a page
	/// swapped for a smaller one would quietly weaken every assertion below.
	#[test]
	fn test_the_fixture_is_the_real_shipped_capp_page() {
		assert_eq!(PAGE.len(), 101_834, "the Log Life page is not the size it was measured at");
	}

	/// **The whole claim.** A hundred turns of the real page, every version
	/// rebuilt from what was stored and compared with what was written.
	#[test]
	fn test_a_hundred_turns_of_the_real_capp_page_rebuild_byte_for_byte() -> Outcome<()> {
		let (log, want) = res!(hundred());
		for (n, w) in want.iter().enumerate() {
			let got = res!(log.read(n as u64));
			assert_eq!(
				got.len(), w.len(),
				"version {} rebuilt to {} bytes and was written as {}", n, got.len(), w.len());
			assert!(got == *w, "version {} did not rebuild to the bytes it was written as", n);
		}
		Ok(())
	}

	/// What it costs, against what it cost. The old store wrote a full copy at
	/// every version; a hundred turns of this page was 10.2 MB.
	#[test]
	fn test_a_hundred_turns_cost_a_fraction_of_a_hundred_copies() -> Outcome<()> {
		let (log, want) = res!(hundred());
		let full: usize = want.iter().map(|w| w.len()).sum();
		let held = log.stored();
		println!(
			"  {} versions of the {} byte Log Life page: {} bytes as a delta log, {} bytes as \
			full copies, {:.0}x",
			want.len(), PAGE.len(), held, full, full as f64 / held as f64);
		assert!(
			held * 6 < full,
			"a hundred turns stored {} bytes against {} as full copies, which is not the \
			saving this exists for", held, full);
		// Five keyframes: version 0, then one every twenty after it.
		assert_eq!(log.keyframes(), 6, "keyframe count over 101 versions");
		Ok(())
	}

	/// **The break the brief names.** A reader that walked the chain but forgot
	/// to apply the patches over it would return the keyframe, silently, and
	/// look right in every test that only checks the call succeeded. Every
	/// version between two keyframes must differ from the keyframe under it,
	/// and must be its own bytes.
	#[test]
	fn test_no_version_is_ever_answered_with_the_keyframe_under_it() -> Outcome<()> {
		let (log, want) = res!(hundred());
		let mut checked = 0;
		for n in 0..want.len() {
			let chain = res!(plan_at(&log.held, n as u64));
			let kf = res!(log.file(chain[0]));
			let got = res!(log.read(n as u64));
			assert!(got == want[n], "version {} is not its own bytes", n);
			if chain.len() > 1 {
				assert!(
					got != kf,
					"version {} came back as the keyframe at version {} under it",
					n, chain[0]);
				checked += 1;
			}
		}
		assert!(checked >= 90, "only {} versions stood on a keyframe to be confused with", checked);
		Ok(())
	}

	/// The interval is what bounds the blast radius and the history view's
	/// reads, so the bound is asserted from both ends: never deeper than the
	/// interval, and actually reaching it, so a keyframe on every version would
	/// fail this rather than pass it.
	#[test]
	fn test_the_chain_is_never_deeper_than_the_keyframe_interval() -> Outcome<()> {
		let (log, want) = res!(hundred());
		let mut deepest = 0;
		for n in 0..want.len() {
			let chain = res!(plan_at(&log.held, n as u64));
			assert!(
				chain.len() <= KEYFRAME_EVERY,
				"version {} is rebuilt from {} files, past the {} the interval allows",
				n, chain.len(), KEYFRAME_EVERY);
			deepest = deepest.max(chain.len());
		}
		assert_eq!(
			deepest, KEYFRAME_EVERY,
			"the deepest chain in a hundred versions was {} files, so the interval in force is \
			not {}", deepest, KEYFRAME_EVERY);
		Ok(())
	}

	/// A version with no snapshot of its own is not answered by the version
	/// next to it. Answering "what did this hold at v12" with v9's bytes,
	/// silently, is the failure a delta log must not have.
	#[test]
	fn test_a_version_with_no_snapshot_is_refused_rather_than_approximated() -> Outcome<()> {
		let held = vec![
			(0u64, Snap::Keyframe),
			(1, Snap::Patch),
			(2, Snap::Patch),
			(4, Snap::Patch),
		];
		assert!(plan_at(&held, 3).is_err(), "version 3 was answered by one of its neighbours");
		assert_eq!(res!(plan_at(&held, 2)), vec![0, 1, 2]);
		// The page's reader is the one that MAY walk back, because a page is
		// snapshotted only where it changed.
		let (at, chain) = match res!(plan_upto(&held, 3)) {
			Some(p)	=> p,
			None	=> panic!("the page reader found nothing at or below version 3"),
		};
		assert_eq!(at, 2);
		assert_eq!(chain, vec![0, 1, 2]);
		Ok(())
	}

	/// A chain with a link missing is refused rather than half applied. The
	/// patch after the gap was made against bytes that are not there, and it
	/// says so.
	#[test]
	fn test_a_chain_with_a_link_missing_is_refused() -> Outcome<()> {
		let (log, _want) = res!(hundred());
		let chain = res!(plan_at(&log.held, 39));
		assert!(chain.len() > 3);
		let mut gapped = chain.clone();
		gapped.remove(2);
		assert!(
			log.follow(&gapped).is_err(),
			"a chain missing its third link rebuilt something anyway");
		// And out of order, which is the same fault wearing a different hat.
		let mut swapped = chain.clone();
		swapped.swap(1, 2);
		assert!(log.follow(&swapped).is_err(), "a chain applied out of order rebuilt something");
		Ok(())
	}

	/// A patch recorded against one lineage cannot be applied inside another.
	/// This is the fault that would otherwise be found months later: the
	/// splices fit, the offsets are legal, and the answer is a file nobody
	/// wrote.
	#[test]
	fn test_a_patch_from_another_lineage_is_refused() -> Outcome<()> {
		let (mine, _) = res!(hundred());
		// A second history from the same page but a different sequence of turns.
		let mut theirs = Log::new();
		let mut cur = PAGE.to_string();
		res!(theirs.write(0, cur.as_bytes()));
		for n in 1..=40usize {
			cur = turn(&cur, n * 3 + 1);
			res!(theirs.write(n as u64, cur.as_bytes()));
		}
		let chain = res!(plan_at(&mine.held, 25));
		let kf = res!(mine.file(chain[0]));
		let mut patches: Vec<Vec<u8>> = Vec::new();
		for n in &chain[1..] {
			patches.push(res!(mine.file(*n)));
		}
		// One patch swapped for the other history's patch at the same version.
		let swap = patches.len() / 2;
		patches[swap] = res!(theirs.file(chain[1 + swap]));
		assert!(
			materialise(kf, &patches).is_err(),
			"a patch from another Diamond's history was applied without complaint");
		Ok(())
	}

	/// The guarantee, stated as a property over content that has nothing in
	/// common with the fixture: whatever [`record`] says is a patch, applying
	/// it to the parent gives the new bytes exactly.
	#[test]
	fn test_nothing_is_recorded_as_a_patch_that_does_not_rebuild() -> Outcome<()> {
		let long = PAGE.as_bytes().to_vec();
		let mut binary: Vec<u8> = Vec::with_capacity(40_000);
		let mut x: u64 = 0x2545_f491_4f6c_dd1d;
		for _ in 0..40_000 {
			x ^= x << 13; x ^= x >> 7; x ^= x << 17;
			binary.push((x & 0xff) as u8);
		}
		let mut shuffled = binary.clone();
		shuffled[100..200].fill(0);
		shuffled.extend_from_slice(b"tail");
		let turned = turn(PAGE, 7);
		let cases: Vec<(&[u8], &[u8])> = vec![
			(b"", b""),
			(b"", &long),
			(&long, b""),
			(&long, &long),
			(&long, b"a completely different page"),
			(b"a completely different page", &long),
			(&binary, &shuffled),
			(&shuffled, &binary),
			(&long, turned.as_bytes()),
		];
		// A pool of snapshots that is not due a keyframe, so `record` is free
		// to choose a patch and the choice is the thing under test.
		let held = vec![(0u64, Snap::Keyframe), (1, Snap::Patch)];
		let mut patched = 0;
		for (old, new) in cases {
			match record(Some(old), new, &held) {
				Recorded::Keyframe(b) => assert_eq!(b, new.to_vec(), "a keyframe is the file"),
				Recorded::Patch(p) => {
					patched += 1;
					let back = res!(diff::apply_patch(old, &p));
					assert!(back == new.to_vec(), "a recorded patch did not rebuild its version");
					assert!(p.len() < new.len(), "a patch was stored that is not smaller");
				},
			}
		}
		assert!(patched >= 3, "only {} of the cases were stored as patches", patched);
		Ok(())
	}

	/// The worst case measured against this page -- a pasted section of sixty
	/// rows -- still costs a fraction of a full copy.
	#[test]
	fn test_a_pasted_section_still_costs_less_than_the_page() -> Outcome<()> {
		let mut lines: Vec<String> = PAGE.split('\n').map(|s| s.to_string()).collect();
		let at = lines.len() / 2;
		for k in 0..60 {
			lines.insert(at + k, fmt!(
				"  <div class=\"row\" data-k=\"{}\"><span>meal</span><span>{} kcal</span></div>",
				k, 300 + k * 7));
		}
		let new = lines.join("\n");
		let patch = res!(diff::make_patch(PAGE.as_bytes(), new.as_bytes()));
		assert!(
			patch.len() * 5 < PAGE.len(),
			"sixty pasted rows cost {} bytes against a page of {}", patch.len(), PAGE.len());
		assert!(res!(diff::apply_patch(PAGE.as_bytes(), &patch)) == new.as_bytes().to_vec());
		Ok(())
	}

	/// Where the splices would cost more than the file, the file is stored.
	#[test]
	fn test_a_wholesale_replacement_is_stored_as_the_file() -> Outcome<()> {
		let held = vec![(0u64, Snap::Keyframe), (1, Snap::Patch)];
		// Two files with nothing in common and nothing to save.
		let rec = record(Some(b"aaaa"), b"zzzz", &held);
		assert!(!rec.is_patch(), "four bytes were stored as splices over four bytes");
		assert_eq!(rec.bytes(), b"zzzz");
		Ok(())
	}

	/// **Migration.** Every Diamond in the wild holds a full copy at every
	/// version, and a full copy is exactly what a keyframe is -- so nothing is
	/// converted, nothing is rewritten, and the first version written after the
	/// upgrade is a patch against the last full copy.
	#[test]
	fn test_an_existing_diamond_of_full_copies_needs_no_conversion() -> Outcome<()> {
		let mut log = Log::new();
		// A Diamond that has been running since before this module existed.
		let mut cur = PAGE.to_string();
		for n in 0..=137u64 {
			if n > 0 {
				cur = turn(&cur, n as usize);
			}
			log.bytes.insert(n, cur.clone().into_bytes());
			log.held.push((n, Snap::Keyframe));
		}
		// Every one of them still reads, with no chain to walk.
		for n in [0u64, 1, 68, 137] {
			assert_eq!(res!(plan_at(&log.held, n)), vec![n], "version {} needs a chain", n);
			assert!(res!(log.read(n)).len() > 90_000);
		}
		// And the next version is a patch, not a copy.
		let next = turn(&cur, 138);
		let snap = res!(log.write(138, next.as_bytes()));
		assert_eq!(snap, Snap::Patch, "the first version after the upgrade was a full copy");
		assert!(res!(log.read(138)) == next.as_bytes().to_vec());
		Ok(())
	}

	/// The page is snapshotted only where it changed, so its versions are
	/// sparse and its keyframes are counted over the snapshots rather than
	/// taken from the version number.
	#[test]
	fn test_the_page_keyframes_are_counted_over_its_own_sparse_versions() -> Outcome<()> {
		let mut log = Log::new();
		let mut cur = PAGE.to_string();
		// Version numbers a page edit might land on across a busy Diamond.
		let at: Vec<u64> = (0..60u64).map(|k| k * k + k).collect();
		for (i, n) in at.iter().enumerate() {
			if i > 0 {
				cur = turn(&cur, i);
			}
			res!(log.write(*n, cur.as_bytes()));
		}
		// One in twenty is a full copy, whatever the numbers were.
		assert_eq!(log.keyframes(), 3, "keyframes over 60 sparse page snapshots");
		// And a version between two page snapshots reads as the one before it.
		let between = at[7] + 1;
		let (target, _chain) = match res!(plan_upto(&log.held, between)) {
			Some(p)	=> p,
			None	=> panic!("no page at or below version {}", between),
		};
		assert_eq!(target, at[7]);
		Ok(())
	}

	/// A history built entirely of patches, with no full copy under it, is
	/// refused. It cannot arise from [`record`], which writes a keyframe
	/// wherever there is nothing to build on, and it is what a lost keyframe
	/// leaves behind.
	#[test]
	fn test_a_history_with_no_full_copy_under_it_is_refused() {
		let held = vec![(0u64, Snap::Patch), (1, Snap::Patch)];
		assert!(plan_at(&held, 1).is_err(), "a history of patches alone was planned");
		assert!(plan_upto(&held, 9).is_err(), "a history of patches alone was planned");
		assert!(wants_keyframe(&held), "a history with no full copy is not asking for one");
	}

	/// **A patch has to survive the pack a sync carries it in.** A version
	/// snapshot used to be text in every case, and a patch is not: its header
	/// carries two checksums, which are arbitrary bytes, so most patches are not
	/// valid UTF-8 and travel base64 in the pack's `binary` map instead of as
	/// themselves. That map is not new, but nothing routine had ever gone
	/// through it -- a Diamond carrying a picture did -- so the path a hundred
	/// versions of every Diamond now take was, until this, exercised only by
	/// what somebody happened to drag in.
	#[test]
	fn test_a_patch_survives_the_pack_a_sync_carries_it_in() -> Outcome<()> {
		let (log, _want) = res!(hundred());
		let mut files: Vec<(String, Vec<u8>)> = Vec::new();
		for (n, snap) in &log.held {
			let ext = match snap {
				Snap::Keyframe	=> ".html",
				Snap::Patch	=> ".hpatch",
			};
			files.push((fmt!("versions/{:04}{}", n, ext), res!(log.file(*n))));
		}
		let packed = crate::protocol::pack_diamond("abc123", 1, &files);
		let mut binary = 0;
		let mut text = 0;
		for (path, bytes) in &files {
			// The pack's own rule for which map a file goes in.
			if std::str::from_utf8(bytes).is_ok() {
				// Valid UTF-8 travels as itself, and JSON is lossless over it.
				text += 1;
				continue;
			}
			let raw = res!(crate::llm::extract_json_string(&packed, path)
				.ok_or_else(|| err!("'{}' is in neither of the pack's maps.", path; Missing)));
			let got = res!(crate::protocol::unpack_binary(path, &raw));
			assert!(got == *bytes, "'{}' did not survive the pack", path);
			binary += 1;
		}
		assert!(binary > 50, "only {} of {} patches took the binary path", binary, files.len());
		assert!(text > 0, "no snapshot at all travelled as text");
		Ok(())
	}

	/// The interval in force, read straight off the counting rule rather than
	/// through a hundred turns of a real page.
	#[test]
	fn test_a_keyframe_is_due_once_the_interval_is_used_up() {
		let mut held = vec![(0u64, Snap::Keyframe)];
		for k in 1..KEYFRAME_EVERY {
			assert!(
				!wants_keyframe(&held),
				"a keyframe was called for with {} patches over the last one", k - 1);
			held.push((k as u64, Snap::Patch));
		}
		assert!(
			wants_keyframe(&held),
			"{} patches stand over the last full copy and none is due",
			KEYFRAME_EVERY - 1);
		assert!(wants_keyframe(&[]), "an empty history is not asking for a full copy");
	}
}
