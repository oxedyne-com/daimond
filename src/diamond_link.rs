//! The target-agnostic core of a link: the record shape, its parse/serialise
//! pair, and node-reference normalisation.
//!
//! A **link** joins one thing to another and says, in a word and a sentence,
//! how they are related.  The things are not only Diamonds: a link may name a
//! file, a page, a chat or a Diamond, because the substrate is meant to outlive
//! the first use anyone puts it to, and a link space that can only join Diamonds
//! to Diamonds would need replacing the first time a Diamond had to point at a
//! file.
//!
//! The OPFS edge that reads and writes the sidecar lives in
//! [`crate::wasm::diamond`], which is compiled only for wasm32 and so cannot be
//! reached by the native test suite.  What is pure sits here instead, where it
//! is tested -- the parse in particular, because a link written by a hand or by
//! an older build must still open.

use crate::llm::{extract_json_number, extract_json_string, json_escape};

use oxedyne_fe2o3_core::prelude::*;


/// The most characters a relation may carry; the excess is truncated.
const MAX_REL_LEN: usize = 32;

/// The most characters a note may carry; the excess is truncated.
const MAX_NOTE_LEN: usize = 2_000;

/// The node-reference kinds this build knows how to name.
///
/// The list is open on purpose: [`Node::parse`] keeps a kind it does not know
/// rather than rejecting it, so a link written by a later build -- or by a hand
/// naming something not yet modelled -- survives a round trip through this one
/// instead of being silently dropped.
pub const KNOWN_KINDS: [&str; 4] = ["diamond", "file", "url", "chat"];


/// One end of a link: a kind and the thing it names, spelled `kind:rest`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Node {
	/// The kind, lowercased. // e.g. `diamond`
	pub kind: String,
	/// Whatever the kind uses to name one of its own. // an id, a path, a URL
	pub rest: String,
}

impl Node {

	/// Parse a `kind:rest` reference, or nothing if it is not one.
	///
	/// Only the FIRST colon separates, because a `url:` reference carries
	/// colons of its own and splitting on the last would truncate every link to
	/// a page.  An empty kind or an empty rest is not a reference.
	pub fn parse(s: &str) -> Option<Self> {
		let t = s.trim();
		let (kind, rest) = match t.find(':') {
			Some(i) => (&t[..i], &t[i + 1..]),
			None    => return None,
		};
		if kind.is_empty() || rest.is_empty() {
			return None;
		}
		// A kind is a bare word, so a stray colon in prose cannot read as one.
		if !kind.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
			return None;
		}
		Some(Self { kind: kind.to_lowercase(), rest: rest.to_string() })
	}

	/// Whether this is a kind the current build models.
	///
	/// An unknown kind is not an error -- it is stored, listed and returned
	/// untouched -- but a caller that must act on a reference can ask first.
	pub fn is_known(&self) -> bool {
		KNOWN_KINDS.contains(&self.kind.as_str())
	}

	/// The canonical `kind:rest` spelling.
	pub fn to_ref(&self) -> String {
		fmt!("{}:{}", self.kind, self.rest)
	}
}


/// One link, as held on a line of a Diamond's `links.jsonl`.
///
/// Direction is recorded -- `from` and `to` are not interchangeable -- but
/// nothing here implies that anything flows along it.  A reader that wants
/// what points AT something scans for it in `to`; that is what makes the
/// links two-way without a second copy of each one.
#[derive(Clone, Debug)]
pub struct Link {
	/// Stable link id, so a link can be named to delete it.
	pub id:   String,
	/// Creation time, wall-clock milliseconds.
	pub ts:   u64,
	/// The end this link is asserted from.
	pub from: Node,
	/// The end it points at.
	pub to:   Node,
	/// What kind of relation this is, as [`normalise_rel`] leaves it.
	pub rel:  String,
	/// A free sentence about the link, for whatever the relation does not say.
	pub note: String,
	/// Who asserted it: `user`, or `agent:<name>`.
	pub by:   String,
}

impl Link {

	/// Serialise to a compact single-line JSON object.
	pub fn to_json(&self) -> String {
		fmt!(
			"{{\"id\":\"{}\",\"ts\":{},\"from\":\"{}\",\"to\":\"{}\",\
			  \"rel\":\"{}\",\"note\":\"{}\",\"by\":\"{}\"}}",
			json_escape(&self.id), self.ts,
			json_escape(&self.from.to_ref()), json_escape(&self.to.to_ref()),
			json_escape(&self.rel), json_escape(&self.note), json_escape(&self.by),
		)
	}

	/// Parse one stored line, or nothing if it does not describe a link.
	///
	/// A line missing either end is not a link and is dropped; everything else
	/// is tolerated and defaulted, so a record written before a field existed
	/// still opens rather than taking the whole sidecar down with it.
	pub fn from_json(s: &str) -> Option<Self> {
		let from = res_opt(extract_json_string(s, "from"))?;
		let to   = res_opt(extract_json_string(s, "to"))?;
		Some(Self {
			id:   extract_json_string(s, "id").unwrap_or_default(),
			ts:   extract_json_number(s, "ts").unwrap_or(0),
			from: Node::parse(&from)?,
			to:   Node::parse(&to)?,
			rel:  normalise_rel(&extract_json_string(s, "rel").unwrap_or_default()),
			note: extract_json_string(s, "note").unwrap_or_default(),
			by:   extract_json_string(s, "by").unwrap_or_default(),
		})
	}

	/// Whether either end of this link names `node`.
	///
	/// This is the whole of what makes the graph two-way: one stored record,
	/// found from both of its ends.
	pub fn touches(&self, node: &Node) -> bool {
		&self.from == node || &self.to == node
	}

	/// The end that is not `node`, or nothing if `node` is neither end.
	pub fn other(&self, node: &Node) -> Option<&Node> {
		if &self.from == node {
			Some(&self.to)
		} else if &self.to == node {
			Some(&self.from)
		} else {
			None
		}
	}
}

/// `Option` in the shape the `?` above needs, without introducing `?` on a
/// `Result`.  Kept tiny and local rather than pulled from anywhere.
fn res_opt(o: Option<String>) -> Option<String> {
	match o {
		Some(s) if !s.trim().is_empty() => Some(s),
		_                               => None,
	}
}


/// Normalise a relation into the form the store holds.
///
/// A relation is typed by hand, so nothing about it can be assumed: it is
/// trimmed, its internal whitespace collapsed to single spaces, lowercased so
/// `Supersedes` and `supersedes` are one relation rather than two, and capped
/// at [`MAX_REL_LEN`] characters.  An empty relation is allowed and means only
/// that the link exists.
///
/// Nothing here knows any relation by name.  Which ones to suggest is the
/// interface's business alone, exactly as it is for a Diamond's tags.
pub fn normalise_rel(rel: &str) -> String {
	let mut out = String::new();
	for (i, word) in rel.split_whitespace().enumerate() {
		if i > 0 {
			out.push(' ');
		}
		out.push_str(&word.to_lowercase());
	}
	// Cap by characters, not bytes, so a multi-byte relation is never cut
	// mid-character.
	out.chars().take(MAX_REL_LEN).collect()
}

/// Cap a note at [`MAX_NOTE_LEN`] characters, leaving it otherwise as written.
///
/// A note is prose and belongs to whoever wrote it, so unlike a relation it is
/// neither lowercased nor collapsed -- only bounded, so one link cannot grow
/// until it crowds out the sidecar it lives in.
pub fn normalise_note(note: &str) -> String {
	note.trim().chars().take(MAX_NOTE_LEN).collect()
}

/// Parse a whole sidecar, skipping blank and unreadable lines.
///
/// A line that will not parse is dropped rather than failing the read: a
/// sidecar is hand-editable by design, and one fat-fingered line must not make
/// every other link in the file disappear.
pub fn parse_links(text: &str) -> Vec<Link> {
	text.lines()
		.map(|l| l.trim())
		.filter(|l| !l.is_empty())
		.filter_map(Link::from_json)
		.collect()
}

/// Serialise links back to sidecar text, one per line.
pub fn write_links(links: &[Link]) -> String {
	let mut s = String::new();
	for l in links {
		s.push_str(&l.to_json());
		s.push('\n');
	}
	s
}


#[cfg(test)]
mod tests {
	use super::*;

	fn node(s: &str) -> Node {
		Node::parse(s).expect("a test reference must parse")
	}

	fn link(from: &str, to: &str, rel: &str) -> Link {
		Link {
			id:   fmt!("l1"),
			ts:   1_700_000_000_000,
			from: node(from),
			to:   node(to),
			rel:  normalise_rel(rel),
			note: fmt!(""),
			by:   fmt!("user"),
		}
	}

	// ── Node references: what keeps the substrate general ────────────

	#[test]
	fn test_a_reference_splits_on_the_first_colon_only() {
		// A URL carries colons of its own. Splitting on the last would leave
		// every link to a page pointing at a truncated address.
		let n = node("url:https://example.com:8443/a?b=1");
		assert_eq!("url", n.kind);
		assert_eq!("https://example.com:8443/a?b=1", n.rest);
		assert_eq!("url:https://example.com:8443/a?b=1", n.to_ref());
	}

	#[test]
	fn test_every_modelled_kind_parses() {
		for kind in KNOWN_KINDS {
			let n = node(&fmt!("{}:something", kind));
			assert_eq!(kind, n.kind);
			assert!(n.is_known(), "{} should be known", kind);
		}
	}

	#[test]
	fn test_an_unknown_kind_survives_rather_than_being_dropped() {
		// The substrate has to outlive this build's idea of what can be linked.
		// A kind written by a later version round-trips untouched; it simply
		// answers false when asked whether this build models it.
		let n = node("email:msg-1234@example.com");
		assert_eq!("email", n.kind);
		assert!(!n.is_known());
		assert_eq!("email:msg-1234@example.com", n.to_ref());
	}

	#[test]
	fn test_a_kind_is_case_folded_but_what_it_names_is_not() {
		// `File:` and `file:` are one kind. A path is not ours to fold: on a
		// case-sensitive filesystem `Notes.md` and `notes.md` are two files.
		let n = node("FILE:Notes/Report.md");
		assert_eq!("file", n.kind);
		assert_eq!("Notes/Report.md", n.rest);
	}

	#[test]
	fn test_what_is_not_a_reference_is_refused() {
		assert!(Node::parse("no colon here").is_none());
		assert!(Node::parse(":nokind").is_none(), "an empty kind is not a kind");
		assert!(Node::parse("norest:").is_none(), "an empty rest names nothing");
		assert!(Node::parse("").is_none());
		// A colon inside prose must not read as a kind, or a sentence becomes a link.
		assert!(Node::parse("as follows: the thing").is_none());
	}

	// ── The record: what an existing link depends on ─────────────────

	#[test]
	fn test_a_link_round_trips() {
		let mut l = link("diamond:abc", "file:notes/report.md", "produced");
		l.note = fmt!("The figures came out of this run.");
		let back = Link::from_json(&l.to_json()).expect("must parse back");
		assert_eq!("diamond:abc", back.from.to_ref());
		assert_eq!("file:notes/report.md", back.to.to_ref());
		assert_eq!("produced", back.rel);
		assert_eq!("The figures came out of this run.", back.note);
		assert_eq!("user", back.by);
		assert_eq!(1_700_000_000_000, back.ts);
	}

	#[test]
	fn test_a_record_missing_the_newer_fields_still_opens() {
		// The two ends are the link. Everything else postdates something, and a
		// strict parse would shut every link written before whatever came last.
		let old = r#"{"from":"diamond:a","to":"diamond:b"}"#;
		let l = Link::from_json(old).expect("a two-ended record is a link");
		assert_eq!("diamond:a", l.from.to_ref());
		assert_eq!("diamond:b", l.to.to_ref());
		assert!(l.rel.is_empty() && l.note.is_empty() && l.by.is_empty());
		assert_eq!(0, l.ts);
	}

	#[test]
	fn test_a_record_missing_an_end_is_not_a_link() {
		assert!(Link::from_json(r#"{"from":"diamond:a"}"#).is_none());
		assert!(Link::from_json(r#"{"to":"diamond:b"}"#).is_none());
		assert!(Link::from_json(r#"{"from":"diamond:a","to":"not a ref"}"#).is_none());
	}

	#[test]
	fn test_notes_needing_escapes_survive_the_round_trip() {
		// A note is arbitrary prose, so it can hold the characters the JSON it
		// is written into uses. Written naively it closes the string early and
		// the whole sidecar stops parsing.
		let mut l = link("diamond:a", "diamond:b", "relates to");
		l.note = fmt!("he said \"use this\"\nand a back\\slash, caf\u{e9} \u{65e5}\u{672c}");
		let back = Link::from_json(&l.to_json()).expect("must parse back");
		assert_eq!(l.note, back.note);
	}

	#[test]
	fn test_a_note_holding_a_field_key_does_not_become_that_field() {
		// The parse is a scan, not a grammar, so a value that reads like a
		// field is worth pinning.
		let mut l = link("diamond:a", "diamond:b", "");
		l.note = fmt!("\"rel\":\"fake\"");
		let back = Link::from_json(&l.to_json()).expect("must parse back");
		assert_eq!("", back.rel, "the real field is the one that follows a comma");
	}

	// ── Two-way: one record, found from both ends ────────────────────

	#[test]
	fn test_a_link_is_found_from_either_end() {
		let l = link("diamond:a", "diamond:b", "informs");
		assert!(l.touches(&node("diamond:a")));
		assert!(l.touches(&node("diamond:b")));
		assert!(!l.touches(&node("diamond:c")));
	}

	#[test]
	fn test_the_other_end_is_whichever_one_you_did_not_ask_from() {
		let l = link("diamond:a", "file:x.md", "produced");
		assert_eq!(Some(&node("file:x.md")), l.other(&node("diamond:a")));
		assert_eq!(Some(&node("diamond:a")),   l.other(&node("file:x.md")));
		assert_eq!(None, l.other(&node("diamond:zzz")));
	}

	#[test]
	fn test_direction_is_kept_even_though_both_ends_find_it() {
		// Two-way means traversable from either end, NOT that the ends are
		// interchangeable. A later reader may care which way `supersedes` ran,
		// and it cannot recover a direction that was never stored.
		let l = link("diamond:new", "diamond:old", "supersedes");
		let back = Link::from_json(&l.to_json()).expect("must parse back");
		assert_eq!("diamond:new", back.from.to_ref());
		assert_eq!("diamond:old", back.to.to_ref());
	}

	// ── Normalisation: what the store is spared ──────────────────────

	#[test]
	fn test_case_and_whitespace_fold_into_one_relation() {
		assert_eq!(fmt!("derives from"), normalise_rel("  Derives\t\tFrom  "));
		assert_eq!(normalise_rel("DERIVES FROM"), normalise_rel("derives from"));
	}

	#[test]
	fn test_an_empty_relation_is_allowed() {
		// A link with no relation still says the two things are connected,
		// which is the least a link can usefully mean.
		assert_eq!("", normalise_rel("   \t\n  "));
	}

	#[test]
	fn test_a_long_relation_is_capped_by_characters_not_bytes() {
		let got = normalise_rel(&"\u{65e5}".repeat(40));
		assert_eq!(MAX_REL_LEN, got.chars().count());
	}

	#[test]
	fn test_a_note_is_bounded_but_otherwise_left_as_written() {
		// Unlike a relation, a note is prose and keeps its case and its shape.
		assert_eq!("Keep This Case, and  the  spacing.",
			normalise_note("  Keep This Case, and  the  spacing.  "));
		assert_eq!(MAX_NOTE_LEN, normalise_note(&"x".repeat(MAX_NOTE_LEN + 500)).chars().count());
	}

	// ── The sidecar: hand-editable, so forgiving ─────────────────────

	#[test]
	fn test_a_sidecar_round_trips() {
		let links = vec![
			link("diamond:a", "diamond:b", "informs"),
			link("diamond:a", "file:notes/x.md", "produced"),
		];
		let back = parse_links(&write_links(&links));
		assert_eq!(2, back.len());
		assert_eq!("diamond:b", back[0].to.to_ref());
		assert_eq!("file:notes/x.md", back[1].to.to_ref());
	}

	#[test]
	fn test_one_bad_line_does_not_take_the_others_with_it() {
		// The sidecar is meant to be hand-edited, so a fat-fingered line is a
		// normal event. Failing the whole read would make every other link in
		// the file vanish -- the worst possible answer to a typo.
		let text = concat!(
			"{\"from\":\"diamond:a\",\"to\":\"diamond:b\"}\n",
			"this line is not JSON at all\n",
			"\n",
			"{\"from\":\"diamond:a\",\"to\":\"diamond:c\"}\n",
		);
		let links = parse_links(text);
		assert_eq!(2, links.len(), "the readable lines still read");
		assert_eq!("diamond:b", links[0].to.to_ref());
		assert_eq!("diamond:c", links[1].to.to_ref());
	}

	#[test]
	fn test_an_empty_sidecar_is_no_links_rather_than_a_failure() {
		assert!(parse_links("").is_empty());
		assert!(parse_links("\n\n  \n").is_empty());
	}
}
