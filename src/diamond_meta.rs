//! The target-agnostic core of a Diamond's metadata: the `meta.json` shape, its
//! parse/serialise pair, and tag normalisation.
//!
//! The OPFS edge that reads and writes the file lives in
//! [`crate::wasm::diamond`], which is compiled only for wasm32 and so cannot be
//! reached by the native test suite.  What is pure sits here instead, where it
//! is tested: the parse in particular, because a `meta.json` written before a
//! field existed must still open the Diamond it describes.

use crate::llm::{extract_json_number, extract_json_string, extract_json_string_array, json_escape};

use oxedyne_fe2o3_core::prelude::*;


/// The most tags one Diamond may carry; the excess is dropped.
const MAX_TAGS: usize = 8;

/// The most characters one tag may carry; the excess is truncated.
const MAX_TAG_LEN: usize = 24;


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
}

impl Meta {

	/// Serialise to a compact single-line JSON object.
	pub fn to_json(&self) -> String {
		fmt!(
			"{{\"name\":\"{}\",\"crystal_version\":{},\"updated\":{},\"touched\":{},\"tags\":{}}}",
			json_escape(&self.name), self.version, self.updated, self.touched, self.tags_json(),
		)
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
			tags:    extract_json_string_array(s, "tags").unwrap_or_default(),
		}
	}
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
mod tests {
	use super::*;

	// ── The parse: what an existing Diamond depends on ─────────────────

	#[test]
	fn test_meta_written_before_the_rename_keeps_its_version() {
		// The version field was called `brief_version` until the brief became a
		// crystal. Every Diamond on a device that has not been opened since then
		// still says so, and reading only the new name would report version 0 --
		// which is not cosmetic: the next fold would snapshot over
		// `versions/0000.md` and overwrite the real history.
		let old = Meta::from_json(r#"{"name":"Old","brief_version":7,"updated":123}"#);
		assert_eq!(7, old.version);
		assert_eq!("Old", old.name);

		// And the current name still wins where both somehow appear.
		let both = Meta::from_json(r#"{"name":"X","crystal_version":9,"brief_version":7}"#);
		assert_eq!(9, both.version);
	}

	#[test]
	fn test_meta_without_tags_still_opens_its_diamond() {
		// Every Diamond on a user's device predates the tags field. Its meta.json
		// says nothing about tags, and it must still parse -- with its name,
		// version and stamp intact, and simply no tags. A strict parse here
		// would brick every Diamond anyone already has.
		let old = r#"{"name":"X","crystal_version":3,"updated":123}"#;
		let meta = Meta::from_json(old);
		assert_eq!("X", meta.name);
		assert_eq!(3, meta.version);
		assert_eq!(123, meta.updated);
		assert!(meta.tags.is_empty(), "a missing field is no tags, not a failure");
	}

	#[test]
	fn test_meta_without_touched_reads_as_updated() {
		// Every Diamond already on a device was written before the second stamp
		// existed, and back then every change moved `updated` -- so `updated` is
		// exactly when such a Diamond was last changed. Reading the missing field
		// as 0 would instead declare all of them infinitely stale, and the first
		// device to change anything would overwrite the other device's copy of
		// every Diamond it holds.
		let old = Meta::from_json(r#"{"name":"X","crystal_version":3,"updated":123,"tags":[]}"#);
		assert_eq!(123, old.updated);
		assert_eq!(123, old.touched, "a missing second stamp is the first one");

		// And a Diamond so old it carries no stamp at all still parses.
		let ancient = Meta::from_json(r#"{"name":"Y","brief_version":2}"#);
		assert_eq!(0, ancient.updated);
		assert_eq!(0, ancient.touched);
	}

	#[test]
	fn test_the_two_stamps_round_trip_apart() {
		// Tagging moves `touched` and leaves `updated` where it was, so the file
		// has to be able to say two different things. A serialisation that wrote
		// one over the other would put the rail's order and the merge's freshness
		// back into the same number, which is the bug this field exists to fix.
		let meta = Meta {
			name:    fmt!("Filed"),
			version: 4,
			updated: 1_700_000_000_000,
			touched: 1_700_000_009_999,
			tags:    vec![fmt!("work")],
		};
		let back = Meta::from_json(&meta.to_json());
		assert_eq!(1_700_000_000_000, back.updated);
		assert_eq!(1_700_000_009_999, back.touched);
	}

	#[test]
	fn test_a_meta_with_tags_round_trips() {
		let meta = Meta {
			name:    fmt!("Ship the thing"),
			version: 7,
			updated: 1_700_000_000_000,
			touched: 1_700_000_000_000,
			tags:    vec![fmt!("work"), fmt!("urgent")],
		};
		let back = Meta::from_json(&meta.to_json());
		assert_eq!("Ship the thing", back.name);
		assert_eq!(7, back.version);
		assert_eq!(1_700_000_000_000, back.updated);
		assert_eq!(vec![fmt!("work"), fmt!("urgent")], back.tags);
	}

	#[test]
	fn test_a_meta_with_no_tags_round_trips_as_an_empty_array() {
		let meta = Meta { name: fmt!("Quiet"), version: 0, updated: 1, touched: 1, tags: Vec::new() };
		let json = meta.to_json();
		assert!(json.contains("\"tags\":[]"), "{}", json);
		assert!(Meta::from_json(&json).tags.is_empty());
	}

	#[test]
	fn test_tags_needing_escapes_survive_the_round_trip() {
		// A tag is an arbitrary string, so it can hold the very characters the
		// JSON it is written into uses. Written naively, `he said "hi"` closes
		// the string early and the file no longer parses.
		let tags = vec![
			fmt!("he said \"hi\""),
			fmt!("back\\slash"),
			fmt!("two\nlines"),
			fmt!("caf\u{e9} \u{65e5}\u{672c}"),   // multi-byte, passed through raw
			fmt!("bell\u{7}"),                     // a control character, \u-escaped
		];
		let meta = Meta { name: fmt!("N"), version: 1, updated: 2, touched: 2, tags: tags.clone() };
		assert_eq!(tags, Meta::from_json(&meta.to_json()).tags);
	}

	#[test]
	fn test_a_name_holding_a_tags_key_does_not_become_the_tags() {
		// The parse is a scan, not a grammar, so a value that reads like a field
		// is worth pinning: the real field wins because it is the one whose key
		// follows a comma.
		let meta = Meta {
			name:    fmt!("\"tags\":[\"fake\"]"),
			version: 1,
			updated: 2,
			touched: 2,
			tags:    vec![fmt!("real")],
		};
		assert_eq!(vec![fmt!("real")], Meta::from_json(&meta.to_json()).tags);
	}

	// ── Normalisation: what the store is spared ──────────────────────

	#[test]
	fn test_case_and_whitespace_fold_into_one_tag() {
		let got = normalise_tags(&[fmt!("  Person  "), fmt!("PERSON"), fmt!("person")]);
		assert_eq!(vec![fmt!("person")], got, "one tag, however it was typed");
	}

	#[test]
	fn test_internal_whitespace_runs_collapse() {
		let got = normalise_tags(&[fmt!("Big\t\tRed  \n Book")]);
		assert_eq!(vec![fmt!("big red book")], got);
	}

	#[test]
	fn test_empty_and_blank_tags_are_dropped() {
		let got = normalise_tags(&[fmt!("work"), fmt!(""), fmt!("   "), fmt!("\t\n")]);
		assert_eq!(vec![fmt!("work")], got);
	}

	#[test]
	fn test_duplicates_fall_away_keeping_first_seen_order() {
		// Order is the user's, not the alphabet's: the list reads back as typed.
		let got = normalise_tags(&[fmt!("zeta"), fmt!("alpha"), fmt!("zeta"), fmt!("beta")]);
		assert_eq!(vec![fmt!("zeta"), fmt!("alpha"), fmt!("beta")], got);
	}

	#[test]
	fn test_a_long_tag_is_capped_at_twenty_four_characters() {
		let got = normalise_tags(&[fmt!("abcdefghijklmnopqrstuvwxyz")]);   // 26
		assert_eq!(vec![fmt!("abcdefghijklmnopqrstuvwx")], got);
		assert_eq!(24, got[0].chars().count());
	}

	#[test]
	fn test_a_long_multibyte_tag_is_capped_by_characters_not_bytes() {
		// Capping bytes would cut a character in half and corrupt the tag.
		let got = normalise_tags(&[fmt!("{}", "\u{65e5}".repeat(30))]);
		assert_eq!(24, got[0].chars().count());
		assert_eq!(fmt!("{}", "\u{65e5}".repeat(24)), got[0]);
	}

	#[test]
	fn test_tags_that_differ_only_past_the_cap_are_one_tag() {
		// They are the same stored tag, so the dedupe has to run after the cap.
		let a = fmt!("aaaaaaaaaaaaaaaaaaaaaaaa-one");
		let b = fmt!("aaaaaaaaaaaaaaaaaaaaaaaa-two");
		assert_eq!(1, normalise_tags(&[a, b]).len());
	}

	#[test]
	fn test_only_the_first_eight_tags_are_kept() {
		let many: Vec<String> = (0..12).map(|i| fmt!("tag{}", i)).collect();
		let got = normalise_tags(&many);
		assert_eq!(8, got.len());
		assert_eq!(fmt!("tag0"), got[0]);
		assert_eq!(fmt!("tag7"), got[7], "the excess is dropped from the end");
	}

	#[test]
	fn test_the_cap_counts_what_is_kept_not_what_was_offered() {
		// Nine tags, but the duplicates and the blank are not tags at all, so
		// what survives is under the cap and nothing is lost to it.
		let offered = vec![
			fmt!("a"), fmt!("A"), fmt!(""), fmt!("b"), fmt!("b"),
			fmt!("c"), fmt!("d"), fmt!("e"), fmt!("f"),
		];
		assert_eq!(
			vec![fmt!("a"), fmt!("b"), fmt!("c"), fmt!("d"), fmt!("e"), fmt!("f")],
			normalise_tags(&offered),
		);
	}

	#[test]
	fn test_normalised_tags_round_trip_through_the_stored_json() {
		// The two halves have to agree: what normalisation produces is exactly
		// what the file gives back, or the store drifts from the interface.
		let tags = normalise_tags(&[fmt!("  Work "), fmt!("Deep\tDiamond"), fmt!("work")]);
		let meta = Meta { name: fmt!("N"), version: 2, updated: 3, touched: 3, tags: tags.clone() };
		assert_eq!(tags, Meta::from_json(&meta.to_json()).tags);
	}
}
