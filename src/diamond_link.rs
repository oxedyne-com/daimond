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

use crate::{
	llm::{extract_json_bool, extract_json_number, extract_json_string, json_escape},
	store::call::{cut, links_changed, HexHash, CUT_MARK, LINK_PAGE, PATH_WIRE_MAX, WORD_WIRE_MAX},
};

use oxedyne_fe2o3_core::prelude::*;
use oxedyne_fe2o3_jdat::{
	string::json_edit::JsonObjectText,
	FromDat,
	ToDat,
};


/// The most characters a relation may carry; the excess is truncated.
const MAX_REL_LEN: usize = 32;

/// The most characters a note may carry; the excess is truncated.
const MAX_NOTE_LEN: usize = 2_000;

// The note a user's share flag was written as before it had a field of its own.
const LEGACY_SHARE_NOTE: &str = "share";

/// The node-reference kinds this build knows how to name.
///
/// The list is open on purpose: [`Node::parse`] keeps a kind it does not know
/// rather than rejecting it, so a link written by a later build -- or by a hand
/// naming something not yet modelled -- survives a round trip through this one
/// instead of being silently dropped.
pub const KNOWN_KINDS: [&str; 4] = ["diamond", "file", "url", "chat"];


/// One end of a link: a kind and the thing it names, spelled `kind:rest`.
#[derive(Clone, Debug, Eq, PartialEq, ToDat, FromDat)]
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
		// Only the kind side is forgiving: the rest is kept exactly, so a path
		// with a stray space reads as itself and the place check refuses it.
		let t = s.trim_start();
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
#[derive(Clone, Debug, ToDat, FromDat)]
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
	pub share: bool,	// the user's copy grant on their own mark; see `share_link_in`
}

impl Link {

	/// Serialise to a compact single-line JSON object.
	///
	/// `share` is written only when it is on, so a link that was never flagged is the same bytes
	/// it was before the field existed.
	pub fn to_json(&self) -> String {
		fmt!(
			"{{\"id\":\"{}\",\"ts\":{},\"from\":\"{}\",\"to\":\"{}\",\
			  \"rel\":\"{}\",\"note\":\"{}\",\"by\":\"{}\"{}}}",
			json_escape(&self.id), self.ts,
			json_escape(&self.from.to_ref()), json_escape(&self.to.to_ref()),
			json_escape(&self.rel), json_escape(&self.note), json_escape(&self.by),
			if self.share { ",\"share\":true" } else { "" },
		)
	}

	/// Parse one stored line, or nothing if it does not describe a link.
	///
	/// A line missing either end is not a link and is dropped; everything else
	/// is tolerated and defaulted, so a record written before a field existed
	/// still opens rather than taking the whole sidecar down with it.
	///
	/// **A user's link whose note is the word `share`, and that has no `share` of its own, is
	/// read as flagged with the note empty.**  That is how the flag was written from 2026-09-14
	/// until the re-check of 2026-09-23 (R3) moved it out of the note, which a model writes; the
	/// user's own flags keep working, and a model's note saying the same word is only a note.
	///
	/// **The row's own top-level members, decoded** (d1k45 check, defect 3): a row that is one
	/// JSON object is read through [`JsonObjectText`], the reader the writers edit it with, so a
	/// member of the same name nested deeper is not taken for it and every escape reads as JSON
	/// reads it.  A row the strict reader refuses still reads, by the forgiving extractor.
	pub fn from_json(s: &str) -> Option<Self> {
		match JsonObjectText::new(s) {
			Ok(o) => Self::from_fields(
				|k| o.get_str(k),
				|k| match o.get(k) {
					Some("true") | Some("\"true\"")	=> Some(true),
					Some("false") | Some("\"false\"")	=> Some(false),
					_					=> None,
				},
				|k| o.get(k).and_then(|v| v.parse::<u64>().ok()),
			),
			Err(_) => Self::from_fields(
				|k| extract_json_string(s, k),
				|k| extract_json_bool(s, k),
				|k| extract_json_number(s, k),
			),
		}
	}

	// One reading of a row's fields, whichever reader finds them.
	fn from_fields(
		string:	impl Fn(&str) -> Option<String>,
		boolean: impl Fn(&str) -> Option<bool>,
		number:	impl Fn(&str) -> Option<u64>,
	)
		-> Option<Self>
	{
		let from = res_opt(string("from"))?;
		let to   = res_opt(string("to"))?;
		let mut note = string("note").unwrap_or_default();
		let by = string("by").unwrap_or_default();
		let share = match boolean("share") {
			Some(on) => on,
			None if by == "user" && note == LEGACY_SHARE_NOTE => {
				note.clear();
				true
			},
			None => false,
		};
		Some(Self {
			id:   string("id").unwrap_or_default(),
			ts:   number("ts").unwrap_or(0),
			from: Node::parse(&from)?,
			to:   Node::parse(&to)?,
			rel:  normalise_rel(&string("rel").unwrap_or_default()),
			note,
			by,
			share,
		})
	}

	/// Is this a mark the user made -- their own `holds` or `consulted` link, which is the only
	/// kind a share flag may stand on?
	pub fn is_users_mark(&self) -> bool {
		self.by == "user" && (self.rel == "holds" || self.rel == "consulted")
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

/// One entry of a [`LinksPage`]: a link, or the refusal of one whose field is over what the wire
/// carries, naming it, so one bad row never hides the links after it.
#[derive(Clone, Debug, ToDat, FromDat)]
pub enum PageLink {
	Link(Link),
	Refused { id: String, why: String },
}

/// One page of a links sidecar (D1k3 ruling 1, lead ruling on the cursor).
///
/// The cursor is the position of a row: `next` is the row the following page starts at, `None`
/// once the file is read to its end.  `stamp` is the hash of the whole file the page was read
/// from; a page asked under another stamp is refused with [`links_changed`], and the walk starts
/// again from row 0.  So blank or repeated ids neither loop nor skip.
#[derive(Clone, Debug, ToDat, FromDat)]
pub struct LinksPage {
	pub stamp:	HexHash,
	pub links:	Vec<PageLink>,
	pub next:	Option<u64>,
}

/// Why `l` cannot cross the wire whole, if it cannot.  The note needs no check: the page's copy
/// of it is capped to [`MAX_NOTE_LEN`] characters in [`links_page`], under the wire's text ceiling.
fn too_long(l: &Link) -> Option<String> {
	for (field, v) in [("from", &l.from.rest), ("to", &l.to.rest)] {
		if v.len() > PATH_WIRE_MAX {
			return Some(fmt!("its {} end is {} bytes, over the {} a path may be",
				field, v.len(), PATH_WIRE_MAX));
		}
	}
	for (field, v) in [
		("id", &l.id), ("rel", &l.rel), ("by", &l.by),
		("from kind", &l.from.kind), ("to kind", &l.to.kind),
	] {
		if v.len() > WORD_WIRE_MAX {
			return Some(fmt!("its {} is {} bytes, over the {} a word may be",
				field, v.len(), WORD_WIRE_MAX));
		}
	}
	None
}

/// The page of the sidecar `text` that starts at row `at`: at most [`LINK_PAGE`] entries.
///
/// A row is a non-blank line.  A row that is not a link is passed over, as [`parse_links`]
/// does; a link over the wire's bounds is answered as [`PageLink::Refused`].  `stamp` is the one
/// the walk's first page answered, and `None` only on that first page, at row 0.
pub fn links_page(text: &str, at: u64, stamp: Option<&HexHash>) -> Outcome<LinksPage> {
	let now = HexHash::of(text.as_bytes());
	match stamp {
		Some(s) if *s == now	=> (),
		None if at == 0		=> (),
		_			=> return Err(links_changed()),
	}
	let mut links = Vec::new();
	let mut next = None;
	let rows = text.lines().map(|l| l.trim()).filter(|l| !l.is_empty());
	for (i, row) in rows.enumerate().skip(at as usize) {
		if links.len() == LINK_PAGE {
			next = Some(i as u64);
			break;
		}
		if let Some(mut l) = Link::from_json(row) {
			// The cap is on the page's copy only: the parse stays lossless, so a writer that reads
			// the row never cuts it on disk (d1k3 check, section 1).
			if l.note.chars().count() > MAX_NOTE_LEN {
				l.note = l.note.chars().take(MAX_NOTE_LEN).collect();
			}
			links.push(match too_long(&l) {
				None		=> PageLink::Link(l),
				Some(why)	=> PageLink::Refused { id: cut(&l.id, WORD_WIRE_MAX, CUT_MARK), why },
			});
		}
	}
	Ok(LinksPage { stamp: now, links, next })
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

/// Change the relation and note of the link with `id`, keeping everything that
/// identifies it.  True when one was found and something about it moved.
///
/// **This is what a delete plus a fresh assertion is not.**  Re-asserting an
/// edited link mints a new [`Link::id`] and a new [`Link::ts`], so the record of
/// when the relationship was FIRST claimed is lost and every reader that named
/// the old id is left naming nothing.  A relation is a judgement about two
/// things that were already joined, and refining the judgement does not make it
/// a different joining, so the id and the timestamp are held and only what was
/// actually revised is written.
///
/// The ends are not editable here, and deliberately: changing `from` or `to`
/// makes it a link between two other things, which is a new claim and should
/// cost a new record.
///
/// Nothing false is returned as a success.  An unchanged relation and note write
/// nothing, which is what stops the surface stamping the Diamond -- and the
/// stamp is what the merge reads, so a no-op that stamped would make one device
/// fresher than the other for having done nothing (see
/// [`crate::wasm::diamond::update_link`]).
///
/// # Arguments
/// * `links` - The owner's sidecar, edited in place.
/// * `id` - The link to revise.
/// * `rel` - The new relation, normalised as [`normalise_rel`] leaves it.
/// * `note` - The new note, bounded as [`normalise_note`] leaves it.
pub fn update_link_in(links: &mut [Link], id: &str, rel: &str, note: &str) -> bool {
	// A blank id names no link.  Matching one would revise every hand-written
	// record in the sidecar at once, since that is exactly what those carry.
	if id.trim().is_empty() {
		return false;
	}
	let (rel, note) = (normalise_rel(rel), normalise_note(note));
	for l in links.iter_mut() {
		if l.id != id {
			continue;
		}
		if l.rel == rel && l.note == note {
			return false;
		}
		l.rel  = rel;
		l.note = note;
		return true;
	}
	false
}

/// Turn the share flag of the link with `id` on or off.  True when one was found and it moved.
///
/// **The copy grant is the user's, on the user's own mark, and nothing else writes it** (re-check
/// of 2026-09-23, R3).  It lived in the link's free-text `note`, which `link_add` passes through
/// from whatever a model wrote, and the share roots counted it on any row -- so a daimon could
/// flag a folder of its choosing, and sync would then write into it, and delete from it on
/// another device's word, with no copy kept here.  It is a field now, which no link tool reads
/// from its arguments, and this refuses it on any link that is not the user's mark.  Whether it
/// counts on THIS device is the page's to say, since only the page knows where a mark is in force.
///
/// # Arguments
/// * `links` - The owner's sidecar, edited in place.
/// * `id` - The link to flag.
/// * `on` - True to share it, false to stop.
pub fn share_link_in(links: &mut [Link], id: &str, on: bool) -> Outcome<bool> {
	// A blank id names no link, as in [`update_link_in`].
	if id.trim().is_empty() {
		return Ok(false);
	}
	for l in links.iter_mut() {
		if l.id != id {
			continue;
		}
		if on && !l.is_users_mark() {
			return Err(err!(
				"Link '{}' is not a mark the user made (it is '{}' by '{}'), so it cannot be \
				shared: only a folder or file the user marked in may be copied to other devices.",
				id, l.rel, l.by; Invalid, Input));
		}
		if l.share == on {
			return Ok(false);
		}
		l.share = on;
		return Ok(true);
	}
	Ok(false)
}

/// What a model's removal of one link from a sidecar comes to; see [`model_unlink`].
#[derive(Clone, Debug, ToDat, FromDat)]
pub enum Unlink {
	Missing,			// no link has that id, and a blank id names none
	Users,				// a row the id names is the user's, so nothing goes
	Removed(Vec<Link>),	// the sidecar without it
}

/// Take the link `id` out of `links` for a MODEL's tool: never a row the user drew.
///
/// **Every row the id names is asked, in every turn** (signed-marks design §11).  The refusal
/// was asked only of a turn with a daimon or a write fence, so an ordinary chat's model could
/// take the user's mark out; and it asked the FIRST row the id named, while the removal took
/// every row, so a blank id -- which is what a hand-written row carries -- named the user's rows
/// along with the rest.  A blank id names no link here, as in [`update_link_in`].
///
/// # Arguments
/// * `links` - The owner's sidecar, as read.
/// * `id` - The link the model named.
pub fn model_unlink(links: &[Link], id: &str) -> Unlink {
	if id.trim().is_empty() {
		return Unlink::Missing;
	}
	let mut named = false;
	for l in links.iter().filter(|l| l.id == id) {
		named = true;
		if crate::tools::is_users_link(&l.by) {
			return Unlink::Users;
		}
	}
	if !named {
		return Unlink::Missing;
	}
	Unlink::Removed(links.iter().filter(|l| l.id != id).cloned().collect())
}
/// Parse a whole sidecar, skipping blank and unreadable lines.
///
/// A line that will not parse is dropped rather than failing the read: a
/// sidecar is hand-editable by design, and one fat-fingered line must not make
/// every other link in the file disappear.
pub fn parse_links(text: &str) -> Vec<Link> {
	link_rows(text).into_iter().map(|(_, l)| l).collect()
}

/// Serialise links back to sidecar text, one per line: fixtures only.
///
/// **Test-only, so no writer can put a parsed list back on disk** (d1k3 check, section 1).  A
/// parsed list has lost every unreadable line and every field `Link` does not know, and a page
/// walk's list ([`crate::store::call::Unlinked::rebuild`]) has also lost refused rows and
/// the tail of long notes.  Every writer goes through [`edit_rows`] instead.
#[cfg(test)]
pub fn write_links(links: &[Link]) -> String {
	let mut s = String::new();
	for l in links {
		s.push_str(&l.to_json());
		s.push('\n');
	}
	s
}

/// Rewrite the node kind an earlier build wrote.
///
/// A sidecar written before the rename names its ends `facet:<id>` -- what a
/// Diamond was called when the link substrate shipped.  An unknown kind is kept
/// rather than refused, so those links survive, but they survive pointing at a
/// kind nothing resolves any more.
///
/// **Row by row, the ends alone** (d1k45 check, defect 2): only a top-level `from` or `to` whose
/// value starts `facet:` is changed, through [`edit_rows`], and every other byte -- a note that
/// says the word, an unknown member, a line that is not a link -- is copied as written.  A row
/// the raw editor cannot read is left as it stands.  Nothing to repair is the same text back.
pub fn fix_legacy_kinds(text: &str) -> String {
	let mut moved = false;
	let out = edit_rows(text, |_, raw, _| match legacy_row(raw) {
		Some(t)	=> { moved = true; Row::Text(t) },
		None	=> Row::Keep,
	}, &[]);
	match out {
		Ok(t) if moved	=> t,
		_		=> text.to_string(),
	}
}

/// The row `raw` with each top-level end named `facet:<id>` renamed `diamond:<id>`, or nothing
/// when it names none or cannot be edited in place.
fn legacy_row(raw: &str) -> Option<String> {
	let mut row = match JsonObjectText::new(raw) {
		Ok(r)	=> r,
		Err(_)	=> return None,
	};
	let mut moved = false;
	for key in ["from", "to"] {
		let rest = match row.get_str(key) {
			Some(v) => match v.strip_prefix("facet:") {
				Some(r)	=> r.to_string(),
				None	=> continue,
			},
			None => continue,
		};
		if row.set(key, &fmt!("\"diamond:{}\"", json_escape(&rest))).is_err() {
			return None;
		}
		moved = true;
	}
	if moved { Some(row.into_string()) } else { None }
}

/// What identifies a link when two copies of one sidecar are reconciled.
///
/// The id, which is assigned once and travels with the record.  Two devices
/// that each asserted "the same" link asserted two links, with two ids, and
/// both are kept -- deciding that they meant one is a judgement about content,
/// and nothing here is entitled to make it.  A record written by a hand or by a
/// build that assigned no id has only what it says, so that is what it is keyed
/// by; the two forms are prefixed apart so neither can be mistaken for the
/// other.
fn identity(l: &Link) -> String {
	let id = l.id.trim();
	if id.is_empty() {
		fmt!("k:{}\u{1f}{}\u{1f}{}\u{1f}{}\u{1f}{}\u{1f}{}",
			l.from.to_ref(), l.to.to_ref(), l.rel, l.note, l.by, l.share)
	} else {
		fmt!("i:{}", id)
	}
}

/// Add to `mine` every link of `theirs` it does not already hold, or nothing at
/// all when it holds them all.
///
/// This is what lets two stores whose sidecars disagree come back together.  It
/// is deliberately not a merge of link CONTENT: a link is not edited in place,
/// so two records sharing an id are the same record, and the copy already here
/// is kept rather than compared field by field.
///
/// Returning nothing when there is nothing to add is the whole of why it
/// settles.  The caller writes only when it is handed a list, and writing is
/// what stamps the Diamond; a union that wrote unconditionally would stamp each
/// side fresher than the other for ever.
pub fn union_links(mine: &[Link], theirs: &[Link]) -> Option<Vec<Link>> {
	let take = union_take(mine, theirs);
	if take.is_empty() {
		return None;
	}
	let mut out = mine.to_vec();
	out.extend(take.iter().filter_map(|&i| theirs.get(i).cloned()));
	Some(out)
}

/// The positions in `theirs` of the links [`union_links`] takes, in order.
fn union_take(mine: &[Link], theirs: &[Link]) -> Vec<usize> {
	// A linear scan, because a sidecar holds a handful of links and a set for a
	// dozen short strings costs more to read than it saves.
	let mut keys: Vec<String> = mine.iter().map(identity).collect();
	let mut take = Vec::new();
	for (i, l) in theirs.iter().enumerate() {
		let key = identity(l);
		// What is taken includes what was just added, so a sidecar carrying the
		// same link twice does not land it twice.
		if keys.iter().any(|k| k == &key) {
			continue;
		}
		keys.push(key);
		take.push(i);
	}
	take
}


// ┌───────────────────────────────────────────────────────────────┐
// │ The writers' edits: row by row over the raw sidecar            │
// └───────────────────────────────────────────────────────────────┘
//
// **A writer changes the row it was asked to change, and no other byte** (d1k3 check,
// section 1).  The sidecar is hand-editable and written by other builds and other devices, so a
// row can hold a field [`Link`] does not know, a `rel` spelling it folds, or no link at all.
// Rebuilding the file from parsed rows dropped or rewrote all of those on every add, edit,
// share, remove and union.  So the parsed `Link` only decides WHICH row moves; every other line
// is copied as it stands, and a changed row is edited in its own raw JSON, the changed fields
// alone.

/// What [`edit_rows`] does with one row that reads as a link.
pub enum Row {
	Keep,
	Drop,
	Put(Link),	// the row as it should now read; only the fields that differ are rewritten
	Text(String),	// the row's new text, made by the caller from its raw text
}

/// The one editor every link writer goes through.
///
/// `each` is asked of every row that reads as a link, with its index in [`parse_links`] order and
/// its raw text, trimmed;
/// a blank or unreadable line is copied unasked.  `add` lines are appended, after a line ending
/// if the text lacks a final one.
///
/// **A row to change that the raw editor cannot bring to its new reading is refused**, by its id
/// and line, and nothing is written: writing it whole from the parsed `Link` would drop the
/// fields `Link` does not know.
pub fn edit_rows(
	text:		&str,
	mut each:	impl FnMut(usize, &str, &Link) -> Row,
	add:		&[String],
)
	-> Outcome<String>
{
	let mut out = String::with_capacity(text.len());
	let mut n = 0;
	for (line, piece) in text.split_inclusive('\n').enumerate() {
		let body = piece.trim();
		let l = match if body.is_empty() { None } else { Link::from_json(body) } {
			Some(l) => l,
			None => {
				out.push_str(piece);
				continue;
			},
		};
		let i = n;
		n += 1;
		let row = match each(i, body, &l) {
			Row::Keep	=> { out.push_str(piece); continue; },
			Row::Drop	=> continue,
			Row::Text(t)	=> t,
			Row::Put(new)	=> match rewrite_row(body, &new) {
				Ok(r)	=> r,
				Err(e)	=> return Err(err!(e,
					"The link '{}' on line {} of the sidecar was not changed: its row cannot be \
					edited in place, and writing it whole would drop the fields this build does \
					not know.", l.id, line + 1;
				Invalid, Input)),
			},
		};
		let start = piece.len() - piece.trim_start().len();
		out.push_str(&piece[..start]);
		out.push_str(&row);
		out.push_str(&piece[start + body.len()..]);
	}
	if !add.is_empty() && !out.is_empty() && !out.ends_with('\n') {
		out.push('\n');
	}
	for line in add {
		out.push_str(line);
		out.push('\n');
	}
	Ok(out)
}

/// Every row that reads as a link, with its raw text, in [`parse_links`] order.
fn link_rows(text: &str) -> Vec<(&str, Link)> {
	text.lines()
		.map(|l| l.trim())
		.filter(|l| !l.is_empty())
		.filter_map(|r| Link::from_json(r).map(|l| (r, l)))
		.collect()
}

/// Whether two links read the same in every field.
fn same(a: &Link, b: &Link) -> bool {
	a.id == b.id && a.ts == b.ts && a.from == b.from && a.to == b.to
		&& a.rel == b.rel && a.note == b.note && a.by == b.by && a.share == b.share
}

/// Write back only the rows `edited` (the file's links, as [`parse_links`] read them, after an
/// edit) changed.
fn put_changed(text: &str, edited: &[Link]) -> Outcome<String> {
	edit_rows(text, |i, _, l| match edited.get(i) {
		Some(e) if !same(l, e)	=> Row::Put(e.clone()),
		_			=> Row::Keep,
	}, &[])
}

/// The row `raw` with the fields in which it reads differently from `new` rewritten, and every
/// other member, known or not, as it was.
///
/// Read back after each round, because a field can depend on another: a user's row whose note is
/// the legacy `share` word reads as flagged until it is given a `share` of its own, and then its
/// note reads.  A row the raw edit cannot bring to `new` is refused: one that is not a JSON object
/// `Link` nonetheless reads, or one that differs where no writer edits.
fn rewrite_row(raw: &str, new: &Link) -> Outcome<String> {
	let mut row = res!(JsonObjectText::new(raw));
	for round in 0..4 {
		let now = match Link::from_json(row.as_str()) {
			Some(l) => l,
			None	=> return Err(err!("The edited row no longer reads as a link."; Invalid, Input)),
		};
		if same(&now, new) {
			return Ok(row.into_string());
		}
		let mut sets: Vec<(&str, Option<String>)> = Vec::new();
		if now.rel != new.rel {
			sets.push(("rel", Some(fmt!("\"{}\"", json_escape(&new.rel)))));
		}
		if now.note != new.note {
			sets.push(("note", Some(fmt!("\"{}\"", json_escape(&new.note)))));
		}
		if now.share != new.share {
			// Off is the field's absence, as `to_json` writes it, unless absence still reads on.
			sets.push(("share", match (new.share, round) {
				(true, _)	=> Some(fmt!("true")),
				(false, 0)	=> None,
				(false, _)	=> Some(fmt!("false")),
			}));
		}
		if sets.is_empty() {
			return Err(err!("The row differs from its edit where no writer edits."; Invalid, Input));
		}
		for (key, val) in sets {
			match val {
				Some(v)	=> res!(row.set(key, &v)),
				None	=> { res!(row.remove(key)); },
			}
		}
	}
	Err(err!("The row did not settle to its edit."; Invalid, Input))
}

/// The sidecar `text` with `link` appended.
pub fn sidecar_add(text: &str, link: &Link) -> Outcome<String> {
	edit_rows(text, |_, _, _| Row::Keep, &[link.to_json()])
}

/// The sidecar after [`update_link_in`], or nothing when nothing moved.
pub fn sidecar_update(text: &str, id: &str, rel: &str, note: &str) -> Outcome<Option<String>> {
	let mut links = parse_links(text);
	Ok(if update_link_in(&mut links, id, rel, note) { Some(res!(put_changed(text, &links))) } else { None })
}

/// The sidecar after [`share_link_in`], or nothing when nothing moved.
pub fn sidecar_share(text: &str, id: &str, on: bool) -> Outcome<Option<String>> {
	let mut links = parse_links(text);
	Ok(if res!(share_link_in(&mut links, id, on)) { Some(res!(put_changed(text, &links))) } else { None })
}

/// The sidecar without every row whose id is `id`, or nothing when none had it.
///
/// **A blank id is refused** (d1k45 check, defect 1): every hand-written row carries one, so it
/// named them all at once.  Such a row goes by what it says instead, through
/// [`sidecar_remove_bare`].
pub fn sidecar_remove(text: &str, id: &str) -> Outcome<Option<String>> {
	if id.trim().is_empty() {
		return Err(err!(
			"A blank link id names no link: a hand-written link has none, so it is removed by \
			its ends and relation instead."; Invalid, Input));
	}
	let mut gone = false;
	let out = res!(edit_rows(text, |_, _, l| if l.id == id { gone = true; Row::Drop } else { Row::Keep }, &[]));
	Ok(if gone { Some(out) } else { None })
}

/// The sidecar without the one hand-written row, a row with no id, that runs `from` to `to` (both
/// references) as `rel`; every other byte as it was.  Refused when no such row, or more than one,
/// says it: nothing else tells two of them apart.
pub fn sidecar_remove_bare(text: &str, from: &str, to: &str, rel: &str) -> Outcome<String> {
	let (from, to) = match (Node::parse(from), Node::parse(to)) {
		(Some(f), Some(t))	=> (f, t),
		_			=> return Err(err!("No such hand-written link."; Missing, Input)),
	};
	let rel = normalise_rel(rel);
	let hit = |l: &Link| l.id.trim().is_empty() && l.from == from && l.to == to && l.rel == rel;
	match parse_links(text).iter().filter(|l| hit(l)).count() {
		1 => edit_rows(text, |_, _, l| if hit(l) { Row::Drop } else { Row::Keep }, &[]),
		0 => Err(err!("No such hand-written link."; Missing, Input)),
		_ => Err(err!("Identical hand-written links: remove one in the sidecar."; Invalid, Input)),
	}
}

/// [`model_unlink`] over the sidecar, and the text to write when it removed.
pub fn sidecar_model_remove(text: &str, id: &str) -> Outcome<(Unlink, Option<String>)> {
	let out = model_unlink(&parse_links(text), id);
	let new = match &out {
		Unlink::Removed(_)	=> res!(sidecar_remove(text, id)),
		_			=> None,
	};
	Ok((out, new))
}

/// The sidecar `mine` with the rows of `theirs` it does not hold appended as they were written,
/// or nothing when it holds them all ([`union_links`]).
pub fn sidecar_union(mine: &str, theirs: &str) -> Outcome<Option<String>> {
	let rows = link_rows(theirs);
	let links: Vec<Link> = rows.iter().map(|(_, l)| l.clone()).collect();
	let take = union_take(&parse_links(mine), &links);
	if take.is_empty() {
		return Ok(None);
	}
	let add: Vec<String> = take.iter().filter_map(|&i| rows.get(i).map(|(r, _)| r.to_string())).collect();
	Ok(Some(res!(edit_rows(mine, |_, _, _| Row::Keep, &add))))
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
			share: false,
		}
	}

	// ── A model never takes the user's mark out ───────────────────────

	fn by(id: &str, who: &str) -> Link {
		let mut l = link("diamond:d1", "file:/home/u/books", "holds");
		l.id = fmt!("{}", id);
		l.by = fmt!("{}", who);
		l
	}

	#[test]
	fn test_a_model_cannot_remove_the_users_mark() {
		let links = vec![by("m1", "user"), by("a1", "agent:chat")];
		assert!(matches!(model_unlink(&links, "m1"), Unlink::Users), "the user's mark went");
		// A row from before `by` existed is the user's to confirm, not a model's to tidy.
		let old = vec![by("m2", "")];
		assert!(matches!(model_unlink(&old, "m2"), Unlink::Users), "an unsigned row went");
	}

	#[test]
	fn test_a_blank_id_names_no_link_and_so_none_of_the_users_rows() {
		// Hand-written rows carry no id: a blank id used to name every one of them.
		let links = vec![by("", "agent:daimon"), by("", "user"), by("a1", "agent:chat")];
		assert!(matches!(model_unlink(&links, ""), Unlink::Missing));
		assert!(matches!(model_unlink(&links, "  "), Unlink::Missing));
	}

	#[test]
	fn test_every_row_an_id_names_is_asked_not_only_the_first() {
		// Two rows under one id, the model's first: the removal would take both.
		let links = vec![by("x", "agent:chat"), by("x", "user")];
		assert!(matches!(model_unlink(&links, "x"), Unlink::Users), "the second row was not asked");
	}

	#[test]
	fn test_a_models_own_link_is_removed_and_the_rest_kept() {
		let links = vec![by("m1", "user"), by("a1", "agent:chat"), by("a2", "agent:daimon")];
		match model_unlink(&links, "a1") {
			Unlink::Removed(kept) => {
				let ids: Vec<&str> = kept.iter().map(|l| l.id.as_str()).collect();
				assert_eq!(vec!["m1", "a2"], ids);
			}
			other => panic!("a model's own link was not removed: {:?}", other),
		}
		assert!(matches!(model_unlink(&links, "zz"), Unlink::Missing));
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

	// ── The share flag: the user's copy grant, and nobody else's ─────

	#[test]
	fn test_a_models_note_saying_share_is_only_a_note_00() {
		// Re-check of 2026-09-23, R3: `link_add` passes `note` through, and the share roots
		// counted `note == "share"` on any row -- so a daimon could flag a folder to be copied,
		// and synced into and deleted from on another device's word.
		let line = r#"{"id":"m1","ts":1,"from":"diamond:d","to":"dir:secret","rel":"holds","note":"share","by":"agent:daimon"}"#;
		let l = Link::from_json(line).expect("a model's link is a link");
		assert!(!l.share, "a model's note is never the flag");
		assert_eq!("share", l.note, "and it stays what the model wrote");
		// Nor does a model's link claiming the field itself count as a mark it could stand on.
		let forged = r#"{"id":"m2","ts":1,"from":"diamond:d","to":"dir:secret","rel":"holds","note":"","by":"agent:daimon","share":true}"#;
		let f = Link::from_json(forged).expect("still a link");
		assert!(!f.is_users_mark(), "a model's link is not the user's mark");
	}

	#[test]
	fn test_a_users_share_note_from_before_the_field_reads_as_the_flag_00() {
		// The owner's own flags, written as the note until the field existed, keep working.
		let line = r#"{"id":"u1","ts":1,"from":"diamond:d","to":"dir:book","rel":"holds","note":"share","by":"user"}"#;
		let l = Link::from_json(line).expect("the user's link");
		assert!(l.share);
		assert_eq!("", l.note, "the word was the flag, not a note");
		let back = Link::from_json(&l.to_json()).expect("round trip");
		assert!(back.share && back.note.is_empty());
		// A field present wins over the note, whatever the note says.
		let explicit = r#"{"id":"u2","ts":1,"from":"diamond:d","to":"dir:book","rel":"holds","note":"share","by":"user","share":false}"#;
		let e = Link::from_json(explicit).expect("the user's link");
		assert!(!e.share);
		assert_eq!("share", e.note);
		// A row from before rows said who made them is nobody's, so its note is only a note.
		let old = r#"{"id":"o1","ts":1,"from":"diamond:d","to":"dir:book","rel":"holds","note":"share"}"#;
		assert!(!Link::from_json(old).expect("a link").share);
	}

	#[test]
	fn test_a_link_never_flagged_is_the_same_bytes_as_before_the_field_00() {
		let l = link("diamond:a", "dir:x", "holds");
		assert!(!l.to_json().contains("share"), "an unflagged link writes no field");
		let mut on = l.clone();
		on.share = true;
		assert!(on.to_json().ends_with(",\"share\":true}"));
	}

	#[test]
	fn test_only_the_users_own_mark_can_be_flagged_00() {
		let mut links = vec![
			link("diamond:a", "dir:mine", "holds"),
			link("diamond:a", "dir:read", "consulted"),
			link("diamond:a", "file:out.md", "produced"),
			link("diamond:a", "dir:model", "holds"),
			link("diamond:a", "dir:old", "holds"),
		];
		for (i, l) in links.iter_mut().enumerate() {
			l.id = fmt!("l{}", i);
		}
		links[3].by = fmt!("agent:daimon");
		links[4].by = String::new();
		assert!(share_link_in(&mut links, "l0", true).expect("the user's holds"));
		assert!(!share_link_in(&mut links, "l0", true).expect("already on"), "a no-op says so");
		assert!(share_link_in(&mut links, "l1", true).expect("the user's consulted"));
		assert!(share_link_in(&mut links, "l2", true).is_err(), "provenance is not a mark");
		assert!(share_link_in(&mut links, "l3", true).is_err(), "a model's link is not the user's");
		assert!(share_link_in(&mut links, "l4", true).is_err(), "nor is a row nobody signed");
		assert!(!links[2].share && !links[3].share && !links[4].share);
		// Off is always allowed: taking a grant back never needs the grant to be sound.
		links[3].share = true;
		assert!(share_link_in(&mut links, "l3", false).expect("off"));
		assert!(!share_link_in(&mut links, "nosuch", true).expect("no such link"));
		assert!(!share_link_in(&mut links, "", true).expect("a blank id names none"));
	}

	#[test]
	fn test_revising_a_relation_leaves_the_share_flag_alone_00() {
		let mut links = vec![link("diamond:a", "dir:mine", "holds")];
		links[0].id = fmt!("east");
		links[0].share = true;
		assert!(update_link_in(&mut links, "east", "consulted", "only to read"));
		assert!(links[0].share, "the note and the relation are not the flag");
		// And the note can no longer set it: the word is prose now.
		links[0].share = false;
		assert!(update_link_in(&mut links, "east", "holds", "share"));
		assert!(!links[0].share);
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

	#[test]
	fn test_the_note_cap_is_two_thousand_characters_and_that_is_the_promise() {
		// THE ONE PLACE THE FIGURE IS WRITTEN DOWN, and it is written down on purpose.
		// The line above says `MAX_NOTE_LEN` on both sides, which is a sentence about
		// itself: move the constant to 200 and it stays green while every note a user
		// writes is cut to a tenth.  That is not hypothetical -- `dev/mutate.mjs` did
		// exactly that on 2026-08-28 and all 857 tests passed.
		//
		// So the symbolic form stays, because it is the right way to say "capped by
		// characters, not bytes", and this stands beside it holding the figure the
		// product actually promises.  A cap that changes must change here too, which is
		// the point: the edit becomes visible instead of silent.
		assert_eq!(2_000, MAX_NOTE_LEN, "the note cap is part of what the app promises");
		assert_eq!(2_000, normalise_note(&"x".repeat(3_000)).chars().count());
	}

	// ── Revising a link: the same claim, said better ─────────────────

	#[test]
	fn test_a_revision_keeps_the_id_and_the_first_assertion_time() {
		// The whole reason this exists. Delete-plus-re-add mints a new id and a
		// new `ts`, so the record of when the two things were first said to be
		// related is destroyed by an edit to the WORDING of the relation.
		let mut links = vec![link("diamond:a", "diamond:b", "relates to")];
		links[0].id = fmt!("east");
		assert!(update_link_in(&mut links, "east", "Supersedes", "the newer figures"));
		assert_eq!("east", links[0].id, "the id must survive the revision");
		assert_eq!(1_700_000_000_000, links[0].ts, "and so must the first assertion");
		assert_eq!("supersedes", links[0].rel, "a revised relation is normalised like any other");
		assert_eq!("the newer figures", links[0].note);
		// And the ends are untouched: this revises a claim, it does not move it.
		assert_eq!("diamond:a", links[0].from.to_ref());
		assert_eq!("diamond:b", links[0].to.to_ref());
	}

	#[test]
	fn test_a_revision_that_changes_nothing_reports_nothing() {
		// The caller writes only when it is told something moved, and writing is
		// what stamps the Diamond. A no-op that reported a change would make this
		// device fresher than the other for having done nothing, and the merge
		// would then carry this copy over a genuine edit made elsewhere.
		let mut links = vec![link("diamond:a", "diamond:b", "informs")];
		links[0].id   = fmt!("east");
		links[0].note = fmt!("as written");
		assert!(!update_link_in(&mut links, "east", "informs", "as written"));
		// Normalisation is applied BEFORE the comparison, so a relation that
		// differs only in case or spacing is the same relation.
		assert!(!update_link_in(&mut links, "east", "  INFORMS  ", "as written"));
	}

	#[test]
	fn test_a_revision_touches_only_the_link_it_names() {
		let mut links = vec![
			link("diamond:a", "diamond:b", "informs"),
			link("diamond:a", "diamond:c", "informs"),
		];
		links[0].id = fmt!("east");
		links[1].id = fmt!("west");
		assert!(update_link_in(&mut links, "west", "supersedes", ""));
		assert_eq!("informs", links[0].rel, "the link that was not named must not move");
		assert_eq!("supersedes", links[1].rel);
	}

	#[test]
	fn test_an_id_that_names_no_link_revises_nothing() {
		let mut links = vec![link("diamond:a", "diamond:b", "informs")];
		links[0].id = fmt!("east");
		assert!(!update_link_in(&mut links, "nosuch", "supersedes", ""));
		assert_eq!("informs", links[0].rel);
	}

	#[test]
	fn test_a_blank_id_does_not_revise_every_hand_written_link_at_once() {
		// A link written by hand carries no id, so an empty id matches all of
		// them -- and one careless call would rewrite the relation on every
		// hand-written record in the sidecar.
		let mut links = parse_links(concat!(
			"{\"from\":\"diamond:a\",\"to\":\"diamond:b\",\"rel\":\"informs\"}\n",
			"{\"from\":\"diamond:a\",\"to\":\"diamond:c\",\"rel\":\"informs\"}\n",
		));
		assert!(!update_link_in(&mut links, "", "supersedes", "wholesale"));
		assert!(!update_link_in(&mut links, "   ", "supersedes", "wholesale"));
		assert!(links.iter().all(|l| l.rel == "informs"), "nothing may have moved");
	}

	#[test]
	fn test_a_revision_does_not_travel_by_union_and_the_union_does_not_undo_it() {
		// The union keys on the id and keeps the copy already here, so a revision
		// is NOT how an edit reaches the other device -- the stamp is, and the
		// merge carries the Diamond wholesale on it. What matters here is the
		// other half: the stale copy coming back must not silently un-revise the
		// edit, and it does not, because a held id is never taken twice.
		let mut mine = vec![with_id("east", "diamond:b")];
		let stale    = mine.clone();
		assert!(update_link_in(&mut mine, "east", "supersedes", "revised here"));
		assert!(union_links(&mine, &stale).is_none(), "the stale copy is the same record");
		assert_eq!("supersedes", mine[0].rel);
		assert_eq!("revised here", mine[0].note);
	}

	// ── The user's remove: a bare refusal is short ──────────────────

	/// The refusals reach the user as they are (`graph.write_failed`), so they say it in a few
	/// words and carry no `diamond:<hex>` reference.
	#[test]
	fn test_a_bare_refusal_is_short_and_names_no_ref() {
		let text = two_bare_one_named();
		let twins = fmt!("{}\n{}\n", BARE_AB, BARE_AB);
		for e in [
			sidecar_remove_bare(&text, "diamond:a", "diamond:c", "cites").unwrap_err(),
			sidecar_remove_bare(&twins, "diamond:a", "diamond:b", "informs").unwrap_err(),
		] {
			let s = fmt!("{}", e);
			assert!(!s.contains("diamond:"), "names a ref: {}", s);
			assert!(!s.contains("hand-written links run"), "the long form: {}", s);
		}
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

	// ── A write touches only the row it was asked to (d1k3 check, section 1) ──

	fn long_note_sidecar() -> (String, String) {
		let mut a = link("diamond:a", "diamond:b", "informs");
		a.id = fmt!("keep");
		a.note = "n".repeat(3_000);
		let mut b = link("diamond:a", "diamond:c", "informs");
		b.id = fmt!("go");
		b.by = fmt!("agent:x");
		let keep = a.to_json();
		(fmt!("{}\n{}\n", keep, b.to_json()), keep)
	}

	#[test]
	fn test_an_untouched_long_note_is_byte_identical_after_another_row_goes() {
		// Red with the cap in `from_json`: the remove wrote the untouched row back cut to 2,000.
		let (text, keep) = long_note_sidecar();
		let left = match model_unlink(&parse_links(&text), "go") {
			Unlink::Removed(left) => left,
			other => panic!("not removed: {:?}", other),
		};
		assert_eq!(write_links(&left), fmt!("{}\n", keep));
	}

	// Rows `Link` would rewrite: a field it does not know, a rel spelling it folds, a line it
	// cannot read, a share flag, a note with escapes, and a row by the user to share.
	const ODD: &str = "{\"id\":\"u1\",\"ts\":5,\"from\":\"diamond:a\",\"to\":\"file:/x\",\"rel\":\"holds\",\"note\":\"\",\"by\":\"user\",\"later\":{\"k\":[1,\"}\"]}}";
	const MIXED: &str = "{\"id\":\"m1\", \"from\":\"diamond:a\", \"to\":\"diamond:q\", \"rel\":\"  Super   SEDES \", \"by\":\"agent:x\"}";
	const BAD: &str = "  this line is not JSON at all  ";

	fn odd_sidecar() -> String {
		fmt!("{}\n{}\n\n{}\n{}\n", ODD, BAD, MIXED,
			fmt!("{}", link("diamond:a", "diamond:z", "informs").to_json()).replace("\"l1\"", "\"g1\"").replace("\"user\"", "\"agent:x\""))
	}

	fn has_line(text: &str, line: &str) -> bool {
		text.split('\n').any(|l| l == line)
	}

	#[test]
	fn test_an_unreadable_line_survives_an_add() {
		let text = odd_sidecar();
		let mut l = link("diamond:a", "diamond:new", "informs");
		l.id = fmt!("n1");
		let out = sidecar_add(&text, &l).expect("added");
		assert!(has_line(&out, BAD), "{}", out);
		assert!(out.starts_with(&text), "every earlier byte kept: {}", out);
		assert!(has_line(&out, &l.to_json()));
	}

	#[test]
	fn test_an_unknown_field_survives_a_share_toggle() {
		let text = odd_sidecar();
		let out = sidecar_share(&text, "u1", true).expect("a mark").expect("moved");
		let row = out.lines().next().expect("a row");
		assert!(row.contains("\"later\":{\"k\":[1,\"}\"]}"), "{}", row);
		let l = Link::from_json(row).expect("a link");
		assert!(l.share);
		assert_eq!(out.replacen(row, ODD, 1), text, "only the shared row moved");
		let back = sidecar_share(&out, "u1", false).expect("a mark").expect("moved");
		assert!(!parse_links(&back)[0].share);
		assert!(back.lines().next().expect("a row").contains("\"later\""));
	}

	#[test]
	fn test_a_mixed_case_rel_in_another_row_survives_a_remove() {
		let text = odd_sidecar();
		let out = sidecar_remove(&text, "g1").expect("read").expect("removed");
		assert_eq!(out, fmt!("{}\n{}\n\n{}\n", ODD, BAD, MIXED));
		let (u, out) = sidecar_model_remove(&text, "g1").expect("read");
		assert!(matches!(u, Unlink::Removed(ref k) if k.len() == 2), "{:?}", u);
		assert_eq!(out.expect("removed"), fmt!("{}\n{}\n\n{}\n", ODD, BAD, MIXED));
	}

	#[test]
	fn test_an_update_rewrites_only_the_changed_field_of_its_own_row() {
		let text = odd_sidecar();
		let out = sidecar_update(&text, "m1", "super Sedes", "now said").expect("read").expect("moved");
		let row = out.lines().nth(3).expect("the row");
		assert!(row.contains("\"rel\":\"  Super   SEDES \""), "rel untouched as it reads the same: {}", row);
		assert_eq!(Link::from_json(row).expect("a link").note, "now said");
		assert!(has_line(&out, BAD) && has_line(&out, ODD));
		assert!(sidecar_update(&out, "m1", "Super sedes", "now said").expect("read").is_none(), "nothing moved");
	}

	#[test]
	fn test_a_union_keeps_both_sides_unknown_fields() {
		let mine = odd_sidecar();
		let theirs = fmt!("{}\nnot a link either\n{}\n",
			"{\"id\":\"t1\",\"from\":\"diamond:a\",\"to\":\"diamond:t\",\"Rel\":1,\"rel\":\"Cites\",\"theirs\":true}",
			ODD.replace("later", "other"));
		let out = sidecar_union(&mine, &theirs).expect("read").expect("something new");
		assert!(out.starts_with(&mine), "{}", out);
		assert_eq!(&out[mine.len()..],
			"{\"id\":\"t1\",\"from\":\"diamond:a\",\"to\":\"diamond:t\",\"Rel\":1,\"rel\":\"Cites\",\"theirs\":true}\n",
			"their new row lands as they wrote it, and the id held here is not taken twice");
		assert!(sidecar_union(&out, &theirs).expect("read").is_none(), "it settles");
	}

	#[test]
	fn test_a_legacy_share_note_turned_off_reads_off_and_with_no_note() {
		let row = "{\"id\":\"s1\",\"from\":\"diamond:a\",\"to\":\"file:/b\",\"rel\":\"holds\",\"note\":\"share\",\"by\":\"user\",\"x\":2}";
		let out = sidecar_share(&fmt!("{}\n", row), "s1", false).expect("a mark").expect("moved");
		let l = Link::from_json(out.trim()).expect("a link");
		assert!(!l.share && l.note.is_empty(), "{}", out);
		assert!(out.contains("\"x\":2"), "{}", out);
	}

	#[test]
	fn test_a_file_with_no_final_newline_gains_one_before_an_add() {
		let mut l = link("diamond:a", "diamond:new", "informs");
		l.id = fmt!("n1");
		let out = sidecar_add(BAD, &l).expect("added");
		assert_eq!(out, fmt!("{}\n{}\n", BAD, l.to_json()));
		let crlf = fmt!("{}\r\n", MIXED);
		assert_eq!(sidecar_add(&crlf, &l).expect("added"), fmt!("{}{}\n", crlf, l.to_json()), "CRLF kept");
	}

	#[test]
	fn test_a_row_the_editor_cannot_read_is_refused_by_id_and_line() {
		// `Link` reads this row; it is not one JSON object (the trailing comma), so it cannot be
		// edited in place, and written whole it would lose `x`.
		let loose = "{\"id\":\"w1\",\"from\":\"diamond:a\",\"to\":\"diamond:c\",\"rel\":\"cites\",\"x\":1,}";
		let text = fmt!("{}\n{}\n", ODD, loose);
		let e = match sidecar_update(&text, "w1", "cites", "new") {
			Err(e)	=> e.to_string(),
			Ok(out)	=> panic!("answered {:?}", out),
		};
		assert!(e.contains("'w1'") && e.contains("line 2"), "{}", e);
		assert!(sidecar_remove(&text, "w1").expect("a remove edits no row").is_some());
		assert!(sidecar_update(&text, "u1", "holds", "said").expect("another row edits").is_some());
	}

	#[test]
	fn test_the_page_alone_carries_the_note_cap() {
		let (text, _) = long_note_sidecar();
		let page = links_page(&text, 0, None).expect("a page");
		match &page.links[0] {
			PageLink::Link(l) => assert_eq!(l.note.chars().count(), MAX_NOTE_LEN),
			other => panic!("not a link: {:?}", other),
		}
		assert_eq!(parse_links(&text)[0].note.chars().count(), 3_000);
	}

	#[test]
	fn test_a_sidecar_from_before_the_rename_reads_as_diamonds() {
		let old = concat!(
			"{\"from\":\"facet:a\",\"to\":\"facet:b\",\"note\":\"a facet: is what it was\"}\n",
		);
		let links = parse_links(&fix_legacy_kinds(old));
		assert_eq!(1, links.len());
		assert_eq!("diamond:a", links[0].from.to_ref());
		assert_eq!("diamond:b", links[0].to.to_ref());
		// Only the quoted prefix is a reference; the same word in prose is prose.
		assert_eq!("a facet: is what it was", links[0].note);
	}

	// ── The union: two copies of one sidecar coming back together ────

	fn with_id(id: &str, to: &str) -> Link {
		let mut l = link("diamond:a", to, "relates to");
		l.id = fmt!("{}", id);
		l
	}

	fn ids(links: &[Link]) -> String {
		links.iter().map(|l| l.id.clone()).collect::<Vec<_>>().join(",")
	}

	#[test]
	fn test_the_union_takes_what_the_other_copy_has_and_keeps_what_this_one_had() {
		let mine  = vec![with_id("east", "diamond:b")];
		let there = vec![with_id("west", "diamond:c")];
		let out = union_links(&mine, &there).expect("one side had a link the other lacked");
		assert_eq!("east,west", ids(&out), "this copy's links come first, in order");
	}

	#[test]
	fn test_a_union_with_nothing_to_add_writes_nothing() {
		// The whole of why it settles: no addition, no write, no stamp, and the
		// round after a convergence is quiet.
		let mine  = vec![with_id("east", "diamond:b"), with_id("west", "diamond:c")];
		let there = vec![with_id("west", "diamond:c")];
		assert!(union_links(&mine, &there).is_none());
		assert!(union_links(&mine, &mine).is_none());
		assert!(union_links(&mine, &[]).is_none());
	}

	#[test]
	fn test_an_id_already_held_is_not_taken_a_second_time() {
		// The id is the identity, so the copy already here is kept rather than
		// compared: a link is never edited in place, and re-adding it every
		// round is how a sidecar would grow without bound.
		let mut theirs = with_id("east", "diamond:b");
		theirs.note = fmt!("the other device's wording");
		let mine = vec![with_id("east", "diamond:b")];
		assert!(union_links(&mine, &[theirs]).is_none());
	}

	#[test]
	fn test_two_devices_asserting_the_same_link_keep_both() {
		// Two ids are two assertions. Deciding they meant one is a judgement
		// about content, which the wholesale merge does not make either.
		let mine  = vec![with_id("here", "diamond:b")];
		let there = vec![with_id("there", "diamond:b")];
		let out = union_links(&mine, &there).expect("two ids are two links");
		assert_eq!("here,there", ids(&out));
	}

	#[test]
	fn test_a_hand_written_link_with_no_id_is_keyed_by_what_it_says() {
		// Nothing else can tell two of them apart, and keying them all as ""
		// would let one unrelated link hide every other.
		let text = concat!(
			"{\"from\":\"diamond:a\",\"to\":\"diamond:b\",\"rel\":\"informs\"}\n",
			"{\"from\":\"diamond:a\",\"to\":\"diamond:c\",\"rel\":\"informs\"}\n",
		);
		let mine  = parse_links(&text);
		let there = parse_links(&text);
		assert_eq!(2, mine.len());
		assert!(union_links(&mine, &there).is_none(), "the same two, not four");

		let extra = parse_links("{\"from\":\"diamond:a\",\"to\":\"diamond:d\"}\n");
		let out = union_links(&mine, &extra).expect("a third link is new");
		assert_eq!(3, out.len());
	}

	#[test]
	fn test_a_link_repeated_in_the_incoming_sidecar_lands_once() {
		let there = vec![with_id("west", "diamond:c"), with_id("west", "diamond:c")];
		let out = union_links(&[], &there).expect("this side held none");
		assert_eq!("west", ids(&out));
	}

	// ── d1k45 check: a blank id, the legacy repair, top-level reads ───

	const BARE_AB: &str = "{\"from\":\"diamond:a\",\"to\":\"diamond:b\",\"rel\":\"informs\"}";
	const BARE_BC: &str = "{\"from\":\"diamond:b\",\"to\":\"diamond:c\",\"rel\":\"informs\", \"x\":1}";
	const NAMED_K1: &str = "{\"id\":\"k1\",\"from\":\"diamond:a\",\"to\":\"diamond:c\",\"rel\":\"cites\"}";

	fn two_bare_one_named() -> String {
		fmt!("{}\n{}\n{}\n{}\n", BARE_AB, BAD, BARE_BC, NAMED_K1)
	}

	#[test]
	fn test_a_blank_id_removes_nothing() {
		let text = two_bare_one_named();
		assert!(sidecar_remove(&text, "").is_err(), "a blank id names every hand-written row");
		assert!(sidecar_remove(&text, "  ").is_err());
		assert!(matches!(sidecar_model_remove(&text, ""), Ok((Unlink::Missing, None))));
		let out = sidecar_remove(&text, "k1").expect("an id is asked").expect("k1 is there");
		assert_eq!(out, fmt!("{}\n{}\n{}\n", BARE_AB, BAD, BARE_BC));
	}

	#[test]
	fn test_a_bare_row_goes_by_its_content_alone() {
		let text = two_bare_one_named();
		let out = sidecar_remove_bare(&text, "diamond:a", "diamond:b", "Informs").expect("one row says it");
		assert_eq!(out, fmt!("{}\n{}\n{}\n", BAD, BARE_BC, NAMED_K1), "every other byte kept");
		// None, or a named row only, is no hand-written row to remove.
		assert!(sidecar_remove_bare(&text, "diamond:a", "diamond:b", "cites").is_err());
		assert!(sidecar_remove_bare(&text, "diamond:a", "diamond:c", "cites").is_err());
		// Two that say the same: which one is not known, so neither goes.
		let twins = fmt!("{}\n{}\n", BARE_AB, BARE_AB);
		assert!(sidecar_remove_bare(&twins, "diamond:a", "diamond:b", "informs").is_err());
	}

	#[test]
	fn test_the_legacy_repair_moves_only_the_ends_of_its_rows() {
		let text = concat!(
			"{\"id\":\"f1\", \"from\":\"facet:a\",\"to\":\"facet:b\",\"note\":\"facet: the colour\",\"later\":\"\\\"facet:z\"}\r\n",
			"not json \"facet:x\n",
			"{\"id\":\"f2\",\"from\":\"diamond:a\",\"to\":\"file:/x\",\"note\":\"\\\"facet:y\"}",
		);
		let out = fix_legacy_kinds(text);
		assert_eq!(out, concat!(
			"{\"id\":\"f1\", \"from\":\"diamond:a\",\"to\":\"diamond:b\",\"note\":\"facet: the colour\",\"later\":\"\\\"facet:z\"}\r\n",
			"not json \"facet:x\n",
			"{\"id\":\"f2\",\"from\":\"diamond:a\",\"to\":\"file:/x\",\"note\":\"\\\"facet:y\"}",
		));
		// Nothing to repair is the same text back.
		let clean = fmt!("{}\n{}\n", BAD, NAMED_K1);
		assert_eq!(fix_legacy_kinds(&clean), clean);
	}

	#[test]
	fn test_a_link_reads_its_own_top_level_members_decoded() {
		// A nested `note` ahead of the row's own is not the row's note.
		let row = "{\"id\":\"n1\",\"meta\":{\"note\":\"deep\",\"id\":\"x\"},\"from\":\"diamond:a\",\"to\":\"diamond:b\",\"note\":\"top\"}";
		let l = Link::from_json(row).expect("a link");
		assert_eq!(("n1", "top"), (l.id.as_str(), l.note.as_str()));
		// Escapes read as JSON reads them.
		let row = "{\"id\":\"n2\",\"from\":\"diamond:a\",\"to\":\"diamond:b\",\"note\":\"a\\u000bb\\u00e9\\ud83d\\ude00\"}";
		assert_eq!("a\u{0b}b\u{e9}\u{1f600}", Link::from_json(row).expect("a link").note);
		// A row the strict reader refuses still reads, as before.
		let loose = "{\"from\":\"diamond:a\",\"to\":\"diamond:b\",\"note\":\"n\",}";
		assert_eq!("n", Link::from_json(loose).expect("a loose row still reads").note);
	}

	#[test]
	fn test_an_edit_settles_on_a_nested_note_and_a_control_character() {
		let text = fmt!("{}\n{}\n",
			"{\"id\":\"c1\",\"from\":\"diamond:a\",\"to\":\"diamond:b\",\"note\":\"old\"}",
			"{\"id\":\"c2\",\"meta\":{\"note\":\"deep\"},\"from\":\"diamond:a\",\"to\":\"diamond:b\",\"note\":\"old\"}");
		let out = sidecar_update(&text, "c1", "", "a\u{0b}b").expect("it settles").expect("moved");
		assert_eq!("a\u{0b}b", parse_links(&out)[0].note);
		let out = sidecar_update(&out, "c2", "", "new").expect("it settles").expect("moved");
		assert!(out.contains("\"meta\":{\"note\":\"deep\"}"), "{}", out);
		assert_eq!("new", parse_links(&out)[1].note);
	}
}
