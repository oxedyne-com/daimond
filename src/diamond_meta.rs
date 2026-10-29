//! The target-agnostic core of a Diamond's metadata: the `meta.json` shape, its
//! parse/serialise pair, and tag normalisation.
//!
//! The OPFS edge that reads and writes the file lives in
//! [`crate::wasm::diamond`], which is compiled only for wasm32 and so cannot be
//! reached by the native test suite.  What is pure sits here instead, where it
//! is tested: the parse in particular, because a `meta.json` written before a
//! field existed must still open the Diamond it describes.

use crate::llm::{extract_json_bool, extract_json_number, extract_json_string, extract_json_string_array, json_escape};

use oxedyne_fe2o3_core::prelude::*;
use oxedyne_fe2o3_jdat::prelude::*;
use oxedyne_fe2o3_jdat::string::dec::DecoderConfig;


/// The most tags one Diamond may carry; the excess is dropped.
const MAX_TAGS: usize = 8;

/// The most characters one tag may carry; the excess is truncated.
const MAX_TAG_LEN: usize = 24;

/// The largest `meta.json` whose unknown fields are carried; above it the text is damage (see
/// `read_meta`), and only the fields this build knows are read out of it.
const MAX_CARRIED: usize = 65_536;

/// Every key this build reads into a [`Meta`] field; any other is carried in [`Meta::extra`].
const KNOWN_KEYS: [&str; 10] = ["name", "crystal_version", "brief_version", "updated", "touched",
	"builtin", "builtin_named", "tags", "toolkits", "no_progress_rounds"];


/// Per-Diamond metadata held in `meta.json`.
///
/// Two stamps, because they answer two different questions.  `updated` means
/// *worked on* and orders the rail; `touched` means *changed at all* and is what
/// the cross-device merge compares.  Tagging moves the second and not the first,
/// which is the whole reason there are two: filing a Diamond must not shuffle it
/// to the top of the rail, and it must still travel.
pub struct Meta {
	/// Human-readable Diamond name.
	pub name:    String,
	/// Current crystal version (the latest snapshot).
	pub version: u64,
	/// Last-worked-on wall-clock time in whole milliseconds; the rail's order.
	pub updated: u64,
	/// Last-changed-in-any-way wall-clock time in whole milliseconds; the
	/// merge's freshness test.
	pub touched: u64,
	/// User-defined tags, as [`normalise_tags`] leaves them.
	pub tags:    Vec<String>,
	/// The toolchains the user granted this Diamond, as [`normalise_kits`] leaves them.
	///
	/// A GRANT and not a tag, and the difference is the whole reason this is its own field rather
	/// than a reserved tag name.  A tag is an arbitrary string the user types; deriving a
	/// toolchain grant from one would mean a Diamond filed under "rust" quietly reaching the
	/// compiler, which is a permission nobody gave.  What is in here reaches
	/// `Toolkit::parse` and decides what a COMMAND may touch outside the workspace.
	pub kits:    Vec<String>,
	/// Which built-in Diamond this record IS, as the fixed id that built-in is seeded at, or
	/// empty for every Diamond a person made (NAMES N1, 2026-10-16).
	///
	/// A lasting marker in the record itself, because a NAME cannot carry identity: the two
	/// built-ins are called Neil and Lucy, which are names a person gives their own Diamonds,
	/// and the boot that matched by name moved such a Diamond into the Built-in group and could
	/// put it in the Trash.  Set by the page on the copies at the fixed ids and on an older
	/// copy seeded at a random id, which it recognises by its old seed name and text; never by
	/// anything a person types.  See [`normalise_builtin`].
	pub builtin: String,
	/// Has the page given this built-in its current name once already (R568-FU F2)?
	///
	/// A built-in seeded under an old default name is renamed once at boot.  Without a record of
	/// that, one he renamed BACK to the old name was renamed again on every boot.  Held in the
	/// record beside the marker, so it travels and a second device does not do it over.
	pub named:   bool,
	/// This Diamond's own K for the no-progress rule (UNBLOCK-27 R4), or 0 for the app's figure.
	/// Applied to its daimon after `adopt_limits`, since `Limits` is shared by every Diamond.
	pub no_progress: usize,
	/// The fields this build does not know, as `(key, canonical JSON value)` in key order.
	///
	/// Carried through every read-modify-write (R568-FU F1).  The r567 `to_json` wrote only what
	/// it knew, so a device on it that renamed a built-in wrote the `builtin` marker away for
	/// good; a field a later build adds must ride through this build's writes untouched.
	pub extra:   Vec<(String, String)>,
}

impl Meta {

	/// Stamp a local change at `now`, and never at or below the stamp it replaces.
	///
	/// **A copy adopted from a device whose clock runs ahead carries a `touched` above this
	/// device's clock** (CLK-1, the state review of 2026-09-25).  Stamped with `now` alone, the
	/// next edit here went backwards; the merge compares stamps, so that edit read as older than
	/// the copy it was made on and the next pull imported over it.  The floor keeps every local
	/// change strictly above what it changed.
	///
	/// # Arguments
	/// * `now` - Wall clock, whole milliseconds.
	pub fn bump_touched(&mut self, now: u64) {
		self.touched = now.max(self.touched.saturating_add(1));
	}

	/// Serialise to a compact single-line JSON object.
	pub fn to_json(&self) -> String {
		fmt!(
			"{{\"name\":\"{}\",\"crystal_version\":{},\"updated\":{},\"touched\":{},\"builtin\":\"{}\",\"builtin_named\":{},\"tags\":{},\"toolkits\":{}{}{}}}",
			json_escape(&self.name), self.version, self.updated, self.touched,
			json_escape(&self.builtin), self.named, self.tags_json(), self.kits_json(),
			// Only when set, so a record nobody tuned is byte for byte what it was.
			if self.no_progress > 0 { fmt!(",\"no_progress_rounds\":{}", self.no_progress) }
				else { String::new() },
			self.extra_json(),
		)
	}

	/// The carried unknown fields as `,"key":value` members, empty when there are none.
	fn extra_json(&self) -> String {
		let mut out = String::new();
		for (k, v) in &self.extra {
			out.push_str(&fmt!(",\"{}\":{}", json_escape(k), v));
		}
		out
	}

	/// The tags as a JSON array of strings, `[]` when there are none.
	///
	/// Shared with the Diamond list, which carries the same array per Diamond.
	pub fn tags_json(&self) -> String {
		let items: Vec<String> = self.tags.iter()
			.map(|t| fmt!("\"{}\"", json_escape(t)))
			.collect();
		fmt!("[{}]", items.join(","))
	}

	/// The granted toolkits as a JSON array of strings, `[]` when there are none.
	pub fn kits_json(&self) -> String {
		let items: Vec<String> = self.kits.iter()
			.map(|k| fmt!("\"{}\"", json_escape(k)))
			.collect();
		fmt!("[{}]", items.join(","))
	}

	/// Parse from the stored JSON, tolerating missing fields.
	///
	/// `tags` postdates every Diamond already on a user's device, so a `meta.json`
	/// without the field parses to no tags rather than failing: a strict parse
	/// here would shut every Diamond made before tags existed.
	pub fn from_json(s: &str) -> Self {
		Self {
			name:    extract_json_string(s, "name").unwrap_or_default(),
			// `brief_version` is what this field was called before the rename.
			// A workspace written by an older build still says that, and reading
			// only the new name would report every Diamond as being at version 0
			// -- which is not a cosmetic error: the next fold would then snapshot
			// over `versions/0000.md` and the real history would be overwritten.
			version: extract_json_number(s, "crystal_version")
				.or_else(|| extract_json_number(s, "brief_version"))
				.unwrap_or(0),
			updated: extract_json_number(s, "updated").unwrap_or(0),
			// `touched` postdates every Diamond already on a device, and a
			// missing one reads as the stamp that was there: before it existed,
			// every change moved `updated`, so `updated` IS when the Diamond was
			// last changed. Defaulting to 0 instead would tell the merge that
			// every existing Diamond is infinitely stale, and the first device to
			// touch anything would overwrite the other's copy of all of them.
			touched: extract_json_number(s, "touched")
				.unwrap_or_else(|| extract_json_number(s, "updated").unwrap_or(0)),
			// NORMALISED ON THE WAY IN, not only on the way out. `normalise_tags`
			// caps the list at MAX_TAGS and each tag at MAX_TAG_LEN, and it was
			// applied to what a caller SET and never to what was read back — so a
			// `meta.json` that had somehow acquired a huge tags array kept it
			// through every read-modify-write for ever, and nothing could heal it.
			// One of a user's Diamonds reached 702 MB, and reading it killed the
			// tab (see `read_meta`). Normalising here means the very next write
			// puts the file right.
			tags:    normalise_tags(&extract_json_string_array(s, "tags").unwrap_or_default()),
			// Postdates every Diamond already on a device, and an absent field means no grant --
			// which is both the honest reading and the safe one. A toolkit is off by default.
			kits:    normalise_kits(
				&extract_json_string_array(s, "toolkits").unwrap_or_default()),
			// Postdates every Diamond already on a device; absent means a person's own Diamond,
			// and the page marks the built-ins it can prove on the next boot.
			builtin: normalise_builtin(&extract_json_string(s, "builtin").unwrap_or_default()),
			// Postdates every Diamond already on a device; absent means not yet named.
			named:   extract_json_bool(s, "builtin_named").unwrap_or(false),
			no_progress: extract_json_number(s, "no_progress_rounds").unwrap_or(0) as usize,
			extra:   unknown_fields(s),
		}
	}
}

/// Decode a `meta.json` as one JSON object, or `None` when it is too large to be sound or is not
/// one.  The hand scans in [`Meta::from_json`] still read the known fields out of such a file.
fn meta_map(s: &str) -> Option<DaticleMap> {
	if s.len() > MAX_CARRIED {
		return None;
	}
	let cfg = DecoderConfig::<(), ()>::json(None);
	match Dat::decode_string_with_config(s, &cfg) {
		Ok(Dat::Map(m))	=> Some(m),
		_				=> None,
	}
}

/// The members of a `meta.json` this build does not know, each as canonical JSON.
///
/// A value with no canonical JSON form (a float, an integer past 2^53) is the one thing not
/// carried; no build writes either into this record.
fn unknown_fields(s: &str) -> Vec<(String, String)> {
	let mut out = Vec::new();
	if let Some(m) = meta_map(s) {
		for (k, v) in m.iter() {
			if let Dat::Str(key) = k {
				if KNOWN_KEYS.contains(&key.as_str()) {
					continue;
				}
				if let Ok(text) = v.json_canonical() {
					out.push((key.clone(), text));
				}
			}
		}
	}
	out
}

/// The incoming `meta.json` rewritten to keep this device's built-in record, or `None` when it
/// is to be written as it came (R568-FU F1).
///
/// An older build's metadata has no `builtin` key at all, because it did not know the field; a
/// copy it renamed and sent back would otherwise unmark the built-in here for good.  An absent
/// key is not a decision to unmark -- a build that knows the field always writes it, empty when
/// the Diamond is a person's own -- so only an absent key is filled in, and `builtin_named` the
/// same way.  The stamps are left as they came: the arrival is not a change of this device's.
///
/// # Arguments
/// * `incoming` - The `meta.json` text an import is about to write.
/// * `local` - This device's metadata for the same Diamond.
pub fn keep_built_in_marker(incoming: &str, local: &Meta) -> Option<String> {
	let has = |key: &str| match meta_map(incoming) {
		Some(m)	=> m.get(&dat!(key)).is_some(),
		None	=> extract_json_string(incoming, key).is_some()
			|| extract_json_bool(incoming, key).is_some(),
	};
	let keep_mark = !local.builtin.is_empty() && !has("builtin");
	let keep_named = local.named && !has("builtin_named");
	if !keep_mark && !keep_named {
		return None;
	}
	let mut m = Meta::from_json(incoming);
	if keep_mark {
		m.builtin = local.builtin.clone();
	}
	if keep_named {
		m.named = true;
	}
	Some(m.to_json())
}


/// The toolkit names this build knows, in the order they are offered.
///
/// Named here as strings rather than reached for from `crate::tools::Toolkit`, because this module
/// is the STORE and the store's job is to hold what the user chose, not to decide what it means.
/// A name that survives this is still put through `Toolkit::parse` before it grants anything, and
/// one this build does not know grants nothing there.
///
/// **This list and `Toolkit` are two copies of one fact, and they have already drifted once.**
/// `git` was added to the enum, to the fence's `TOOLKIT_ROOTS` and to the page's `KITS` row, and
/// not to this array -- so the chip drew, the click was written, the store dropped the name, and
/// the chip redrew unlit. Nothing was broken and nothing said anything: the store was doing
/// exactly what it is for, against a list that was one name short. Add a toolkit here whenever one
/// is added there, and see `test_every_toolkit_the_engine_knows_is_a_name_the_store_keeps`, which
/// fails when they disagree.
const KNOWN_KITS: [&str; 5] = ["rust", "node", "python", "go", "git"];

/// Normalise a built-in marker: a fixed Diamond id is twelve lowercase hex digits, and anything
/// else is no marker at all, so a damaged or hand-written field cannot make a Diamond a built-in
/// under some other name.
///
/// # Arguments
/// * `mark` - The marker as stored or offered.
pub fn normalise_builtin(mark: &str) -> String {
	let m = mark.trim();
	if m.len() == 12 && m.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
		m.to_string()
	} else {
		String::new()
	}
}

/// Normalise a caller's toolkit grants into the form the store holds.
///
/// Lowercased, trimmed, de-duplicated keeping first-seen order, and -- unlike a tag -- checked
/// against [`KNOWN_KITS`].  A tag is an arbitrary string and this is not: it decides what a command
/// may reach outside the workspace, so a name nobody can act on has no business being stored as
/// though somebody had granted something.
///
/// An unknown name is DROPPED rather than refused, so a `meta.json` written by a later build that
/// knows a fifth toolchain still opens, carrying the grants this build does understand.
///
/// # Arguments
/// * `kits` - The names the caller offered.
pub fn normalise_kits(kits: &[String]) -> Vec<String> {
	let mut out: Vec<String> = Vec::new();
	for kit in kits {
		let name = kit.trim().to_lowercase();
		if !KNOWN_KITS.contains(&name.as_str()) {
			continue;
		}
		if !out.contains(&name) {
			out.push(name);
		}
	}
	out
}

/// Normalise a caller's tags into the form the store holds.
///
/// Tags are typed by hand, so nothing about them can be assumed: each is
/// trimmed, its internal whitespace runs collapsed to a single space, and it is
/// lowercased, so `Person` and `person` are one tag rather than two.  Empties
/// are dropped, duplicates fall away keeping first-seen order, each tag is
/// capped at [`MAX_TAG_LEN`] characters and the list at [`MAX_TAGS`].
///
/// Nothing here knows any tag by name: a tag is an arbitrary string, and which
/// ones to suggest is the interface's business alone.
pub fn normalise_tags(tags: &[String]) -> Vec<String> {
	let mut out: Vec<String> = Vec::new();
	for tag in tags {
		// `split_whitespace` trims and collapses in one pass.
		let mut norm = String::new();
		for (i, word) in tag.split_whitespace().enumerate() {
			if i > 0 {
				norm.push(' ');
			}
			norm.push_str(&word.to_lowercase());
		}
		if norm.is_empty() {
			continue;
		}
		// Cap by characters, not bytes, so a multi-byte tag is never cut
		// mid-character.
		let capped: String = norm.chars().take(MAX_TAG_LEN).collect();
		if !out.contains(&capped) {
			out.push(capped);
		}
		if out.len() == MAX_TAGS {
			break;      // the excess is dropped, not truncated into the last tag
		}
	}
	out
}


#[cfg(test)]
#[path = "../tests/unit/diamond_meta/tests.rs"]
mod tests;

#[cfg(test)]
#[path = "../tests/unit/diamond_meta/real_file_tests.rs"]
mod real_file_tests;

#[cfg(test)]
#[path = "../tests/unit/diamond_meta/unknown_field_tests.rs"]
mod unknown_field_tests;
