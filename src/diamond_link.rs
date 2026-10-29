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
#[path = "../tests/unit/diamond_link/tests.rs"]
mod tests;
