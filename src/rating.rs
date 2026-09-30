//! Per-product rating: the handle a product is named by, the author a version entry records, the
//! form `daimond/1`, and the rating record.
//!
//! Design: `~/usr/code/ai/claude/specs/daimond_product_rating_design_20260924.md`, §3 to §5.
//! Unit U1 of that design stamps provenance and ships this module; the record is written and read
//! from U2 on.  Tag codes are pooled as integers (§9.2), so **a code once shipped is never reused
//! or renumbered**: a tag withdrawn keeps its number, retired, and a new tag takes the next one.

use crate::diamond_versions::is_hash;
use crate::llm::{extract_json_string, json_escape};

use oxedyne_fe2o3_core::prelude::*;
use oxedyne_fe2o3_jdat::prelude::*;
use oxedyne_fe2o3_jdat::string::dec::DecoderConfig;

use std::collections::BTreeMap;


pub const FORM: &str		= "daimond/1";	// the form this build writes
pub const HANDLE_V: &str	= "p1";		// the handle grammar's version
pub const DIM_MAX: u8		= 4;		// a detail dimension runs 0..=DIM_MAX
pub const NOTE_MAX: usize	= 8 * 1024;	// bytes of the user's own words one rating keeps
const TAG_ID_MAX: usize		= 32;		// characters in a tag or dimension id


// ┌───────────────────────────────────────────────────────────────┐
// │ What can be rated                                              │
// └───────────────────────────────────────────────────────────────┘

/// The kinds of product, which decide a handle's shape and a form's base tags.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub enum Kind {
	Answer,
	File,
	Crystal,
	Worker,
	Mail,
	Proposal,
}

impl Kind {

	pub fn all() -> [Self; 6] {
		[Self::Answer, Self::File, Self::Crystal, Self::Worker, Self::Mail, Self::Proposal]
	}

	pub fn wire(&self) -> &'static str {
		match self {
			Self::Answer	=> "answer",
			Self::File	=> "file",
			Self::Crystal	=> "crystal",
			Self::Worker	=> "worker",
			Self::Mail	=> "mail",
			Self::Proposal	=> "proposal",
		}
	}

	pub fn of(s: &str) -> Option<Self> {
		match s {
			"answer"	=> Some(Self::Answer),
			"file"		=> Some(Self::File),
			"crystal"	=> Some(Self::Crystal),
			"worker"	=> Some(Self::Worker),
			"mail"		=> Some(Self::Mail),
			"proposal"	=> Some(Self::Proposal),
			_		=> None,
		}
	}
}


// ┌───────────────────────────────────────────────────────────────┐
// │ The form                                                       │
// └───────────────────────────────────────────────────────────────┘

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Side {
	Down,
	Up,
}

impl Side {
	pub fn wire(&self) -> &'static str {
		match self {
			Self::Down	=> "down",
			Self::Up	=> "up",
		}
	}
}

/// One base tag of the form: a stable ASCII id, a pooling code and the kinds it is offered on.
#[derive(Clone, Copy, Debug)]
pub struct Tag {
	pub id:    &'static str,
	pub code:  u16,
	pub side:  Side,
	pub kinds: &'static [Kind],
}

impl Tag {
	/// The catalogue key of the tag's label.
	pub fn i18n(&self) -> String { fmt!("rating.tag.{}", self.id) }
}

const AW: &[Kind]	= &[Kind::Answer, Kind::Worker];
const AWF: &[Kind]	= &[Kind::Answer, Kind::Worker, Kind::File];
const AWM: &[Kind]	= &[Kind::Answer, Kind::Worker, Kind::Mail];
const WRONG: &[Kind]	= &[Kind::Answer, Kind::Worker, Kind::Crystal, Kind::Mail, Kind::Proposal];
const F: &[Kind]	= &[Kind::File];
const C: &[Kind]	= &[Kind::Crystal];
const M: &[Kind]	= &[Kind::Mail];
const P: &[Kind]	= &[Kind::Proposal];

// §4.2's table.  `wrong` and `style` recur across kinds and keep one code each, so a pooled count
// of either means the same thing whatever was rated.
pub const TAGS: &[Tag] = &[
	Tag { id: "wrong",		code: 1,	side: Side::Down,	kinds: WRONG },
	Tag { id: "ignored",		code: 2,	side: Side::Down,	kinds: AW },
	Tag { id: "long",		code: 3,	side: Side::Down,	kinds: AWM },
	Tag { id: "short",		code: 4,	side: Side::Down,	kinds: AW },
	Tag { id: "style",		code: 5,	side: Side::Down,	kinds: AWF },
	Tag { id: "tool",		code: 6,	side: Side::Down,	kinds: AW },
	Tag { id: "refused",		code: 7,	side: Side::Down,	kinds: AW },
	Tag { id: "slow",		code: 8,	side: Side::Down,	kinds: AW },
	Tag { id: "correct",		code: 9,	side: Side::Up,		kinds: AW },
	Tag { id: "followed",		code: 10,	side: Side::Up,		kinds: AW },
	Tag { id: "concise",		code: 11,	side: Side::Up,		kinds: AW },
	Tag { id: "style_good",		code: 12,	side: Side::Up,		kinds: AW },
	Tag { id: "broke",		code: 13,	side: Side::Down,	kinds: F },
	Tag { id: "wrong_change",	code: 14,	side: Side::Down,	kinds: F },
	Tag { id: "incomplete",		code: 15,	side: Side::Down,	kinds: F },
	Tag { id: "scope",		code: 16,	side: Side::Down,	kinds: F },
	Tag { id: "wiped",		code: 17,	side: Side::Down,	kinds: F },
	Tag { id: "clean",		code: 18,	side: Side::Up,		kinds: F },
	Tag { id: "complete",		code: 19,	side: Side::Up,		kinds: F },
	Tag { id: "lost",		code: 20,	side: Side::Down,	kinds: C },
	Tag { id: "bloated",		code: 21,	side: Side::Down,	kinds: C },
	Tag { id: "faithful",		code: 22,	side: Side::Up,		kinds: C },
	Tag { id: "tidy",		code: 23,	side: Side::Up,		kinds: C },
	Tag { id: "tone",		code: 24,	side: Side::Down,	kinds: M },
	Tag { id: "ready",		code: 25,	side: Side::Up,		kinds: M },
	Tag { id: "not_useful",		code: 26,	side: Side::Down,	kinds: P },
	Tag { id: "already_knew",	code: 27,	side: Side::Down,	kinds: P },
	Tag { id: "useful",		code: 28,	side: Side::Up,		kinds: P },
];

// The four optional detail dimensions, each 0..=DIM_MAX: (id, code).
pub const DIMS: &[(&str, u16)] = &[
	("correct",	1),
	("followed",	2),
	("length",	3),	// right length
	("style",	4),
];

// The five steps of the scale, and the word each is labelled with.
pub const SCALE: &[(i8, &str)] = &[
	(-2,	"wrong"),
	(-1,	"poor"),
	(0,	"fine"),
	(1,	"good"),
	(2,	"great"),
];

/// The pooling code of base tag `id` on a product of `kind`, or `None` for a tag the user or a
/// Diamond added -- which is private by construction, having no code to pool under.
pub fn tag_code(id: &str, kind: Kind) -> Option<u16> {
	TAGS.iter().find(|t| t.id == id && t.kinds.contains(&kind)).map(|t| t.code)
}

/// Form `daimond/1` as JSON, for the page's widget: the scale, the dimensions and every base tag
/// with its code, side, kinds and catalogue key.
pub fn form_json() -> String {
	let scale: Vec<String> = SCALE.iter()
		.map(|(s, w)| fmt!("{{\"s\":{},\"id\":\"{}\",\"key\":\"rating.scale.{}\"}}", s, w, w))
		.collect();
	let dims: Vec<String> = DIMS.iter()
		.map(|(id, code)| fmt!(
			"{{\"id\":\"{}\",\"code\":{},\"max\":{},\"key\":\"rating.dim.{}\"}}",
			id, code, DIM_MAX, id))
		.collect();
	let tags: Vec<String> = TAGS.iter()
		.map(|t| {
			let kinds: Vec<String> = t.kinds.iter().map(|k| fmt!("\"{}\"", k.wire())).collect();
			fmt!("{{\"id\":\"{}\",\"code\":{},\"side\":\"{}\",\"kinds\":[{}],\"key\":\"{}\"}}",
				t.id, t.code, t.side.wire(), kinds.join(","), t.i18n())
		})
		.collect();
	fmt!("{{\"form\":\"{}\",\"scale\":[{}],\"dims\":[{}],\"tags\":[{}]}}",
		FORM, scale.join(","), dims.join(","), tags.join(","))
}


// ┌───────────────────────────────────────────────────────────────┐
// │ The handle                                                     │
// └───────────────────────────────────────────────────────────────┘

/// What a product is called, stamped when it is made and never rewritten (§3.3).
///
/// ```text
/// p1:answer:<chatId>/<mid>          p1:worker:<runId>
/// p1:file:<storeId>/v<N>/<path>     p1:mail:<draftId>
/// p1:crystal:<diamondId>/v<N>       p1:proposal:<pendingId>
/// p1:crystal:<chatId>/<mid>         a compactor's fold, carried by its `fold_log`
/// ```
///
/// A chat, store or Diamond id never holds a `/`; a path, a draft id and a run id may, and are
/// always the last part, so every `/` after the first belongs to them.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Handle {
	pub kind:  Kind,
	pub scope: String,	// chat, store or Diamond id; empty for worker, mail and proposal
	pub v:     Option<u64>,	// the version, for a file and a reducer's crystal
	pub item:  String,	// mid, path, run, draft or pending id; empty for a reducer's crystal
}

impl Handle {

	pub fn answer(chat: &str, mid: &str) -> Self {
		Self { kind: Kind::Answer, scope: chat.to_string(), v: None, item: mid.to_string() }
	}

	pub fn file(store: &str, v: u64, path: &str) -> Self {
		Self { kind: Kind::File, scope: store.to_string(), v: Some(v), item: path.to_string() }
	}

	pub fn crystal(diamond: &str, v: u64) -> Self {
		Self { kind: Kind::Crystal, scope: diamond.to_string(), v: Some(v), item: String::new() }
	}

	/// A compactor's fold of a conversation, named by the `fold_log` message that shows it.
	pub fn fold(chat: &str, mid: &str) -> Self {
		Self { kind: Kind::Crystal, scope: chat.to_string(), v: None, item: mid.to_string() }
	}

	/// A product named by one id alone: a worker's run, a mail draft or a Pending proposal.
	pub fn single(kind: Kind, id: &str) -> Self {
		Self { kind, scope: String::new(), v: None, item: id.to_string() }
	}

	pub fn wire(&self) -> String {
		let head = fmt!("{}:{}:", HANDLE_V, self.kind.wire());
		match (self.kind, self.v) {
			(Kind::File, Some(v))		=> fmt!("{}{}/v{}/{}", head, self.scope, v, self.item),
			(Kind::Crystal, Some(v))	=> fmt!("{}{}/v{}", head, self.scope, v),
			(Kind::Answer, _) | (Kind::Crystal, None) | (Kind::File, None) =>
				fmt!("{}{}/{}", head, self.scope, self.item),
			_				=> fmt!("{}{}", head, self.item),
		}
	}

	pub fn parse(s: &str) -> Outcome<Self> {
		if s.chars().any(|c| (c as u32) < 0x20) {
			return Err(err!("A product handle may not hold a control character: {:?}.", s;
				Invalid, Input));
		}
		let (ver, rest) = match s.split_once(':') {
			Some(p)	=> p,
			None	=> return Err(err!("'{}' is not a product handle: it has no version.", s;
				Invalid, Input)),
		};
		if ver != HANDLE_V {
			return Err(err!(
				"The product handle '{}' is in grammar '{}', which this build does not read.",
				s, ver; Invalid, Input, Version));
		}
		let (kind, body) = match rest.split_once(':') {
			Some((k, b))	=> match Kind::of(k) {
				Some(kind)	=> (kind, b),
				None		=> return Err(err!(
					"The product handle '{}' names kind '{}', which this build does not know.",
					s, k; Invalid, Input)),
			},
			None		=> return Err(err!("'{}' is not a product handle: it has no kind.", s;
				Invalid, Input)),
		};
		let bad = |why: &str| err!("The product handle '{}' is malformed: {}.", s, why;
			Invalid, Input);
		let ver_of = |t: &str| -> Option<u64> {
			match t.strip_prefix('v') {
				Some(n) if !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()) => n.parse().ok(),
				_ => None,
			}
		};
		match kind {
			Kind::Answer | Kind::Crystal | Kind::File => {
				let (scope, tail) = match body.split_once('/') {
					Some((a, b)) if !a.is_empty() && !b.is_empty()	=> (a, b),
					_ => return Err(bad("it needs an id, a '/' and what follows")),
				};
				match kind {
					Kind::Answer => Ok(Self::answer(scope, tail)),
					Kind::Crystal => match ver_of(tail) {
						Some(v)	=> Ok(Self::crystal(scope, v)),
						None	=> Ok(Self::fold(scope, tail)),
					},
					_ => {
						let (vtxt, path) = match tail.split_once('/') {
							Some((a, b)) if !b.is_empty()	=> (a, b),
							_ => return Err(bad("a file needs a version and a path")),
						};
						match ver_of(vtxt) {
							Some(v)	=> Ok(Self::file(scope, v, path)),
							None	=> Err(bad("a file's version is 'v' and digits")),
						}
					},
				}
			},
			Kind::Worker | Kind::Mail | Kind::Proposal => {
				if body.trim().is_empty() {
					return Err(bad("it names nothing"));
				}
				Ok(Self::single(kind, body))
			},
		}
	}
}


// ┌───────────────────────────────────────────────────────────────┐
// │ Who wrote a file                                               │
// └───────────────────────────────────────────────────────────────┘

/// The agent that issued a write, as a version entry records it (`Entry.by`).
///
/// Self-contained on purpose: a worker's writes land in the manifest of the daimon turn after it,
/// when the run may be gone from memory, so the entry has to carry everything a rating copies.
/// `role` is a string rather than an enum so a role a newer build adds survives a round trip
/// through this one.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct Author {
	pub role: String,	// chat, daimon, worker, reducer, compactor or vision
	pub m:    String,	// the model as sent, in the provider's own spelling
	pub pv:   String,	// the serving provider's id
	pub sp:   String,	// the system-prompt fingerprint, see `prompts::fingerprint`
	pub run:  String,	// a worker's run id, else empty
}

impl Author {

	/// Is there an author to record -- a model's turn rather than the user's own door?
	pub fn is_known(&self) -> bool { !self.role.is_empty() }

	/// The nested object an entry carries, in a fixed order, empty fields left out.
	pub fn to_json(&self) -> String {
		let mut out = fmt!("{{\"role\":\"{}\"", json_escape(&self.role));
		for (k, v) in [("m", &self.m), ("pv", &self.pv), ("sp", &self.sp), ("run", &self.run)] {
			if !v.is_empty() {
				out.push_str(&fmt!(",\"{}\":\"{}\"", k, json_escape(v)));
			}
		}
		out.push('}');
		out
	}

	/// Read the object [`Author::to_json`] writes, or `None` where it names no role.
	pub fn from_json(obj: &str) -> Option<Self> {
		let role = match extract_json_string(obj, "role") {
			Some(r) if !r.is_empty()	=> r,
			_				=> return None,
		};
		Some(Self {
			role,
			m:   extract_json_string(obj, "m").unwrap_or_default(),
			pv:  extract_json_string(obj, "pv").unwrap_or_default(),
			sp:  extract_json_string(obj, "sp").unwrap_or_default(),
			run: extract_json_string(obj, "run").unwrap_or_default(),
		})
	}
}


// ┌───────────────────────────────────────────────────────────────┐
// │ The rating record                                              │
// └───────────────────────────────────────────────────────────────┘

/// How a rating was given.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Source {
	Tap,
	Popup,
	Typed,
	ImportCc,	// imported from a Claude Code session
}

impl Source {

	pub fn wire(&self) -> &'static str {
		match self {
			Self::Tap	=> "tap",
			Self::Popup	=> "popup",
			Self::Typed	=> "typed",
			Self::ImportCc	=> "import:cc",
		}
	}

	pub fn of(s: &str) -> Option<Self> {
		match s {
			"tap"		=> Some(Self::Tap),
			"popup"		=> Some(Self::Popup),
			"typed"		=> Some(Self::Typed),
			"import:cc"	=> Some(Self::ImportCc),
			_		=> None,
		}
	}
}

/// The product's provenance, copied into the rating so aggregation never loads a transcript.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct Prod {
	pub m:     String,
	pub pv:    String,
	pub cm:    String,		// canonical model id
	pub fam:   String,
	pub cls:   String,
	pub role:  String,
	pub sp:    String,
	pub d:     String,		// Diamond id, or empty
	pub c:     String,		// chat id
	pub t:     String,		// turn id, the user message mid
	pub tools: Vec<String>,		// tool path, runs collapsed
	pub len:   Option<u64>,		// characters of the product
}

/// One rating of one product by one person (§5.1).  Immutable: a change of mind is a new record
/// naming this one in `sup`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Rating {
	pub id:      String,			// r-<ts36>-<rand5>
	pub at:      u64,			// ms
	pub by:      String,			// the device it was given on
	pub h:       Handle,
	pub hash:    String,			// the content rated; files only
	pub s:       Option<i8>,		// -2..=2; None withdraws
	pub tags:    Vec<String>,
	pub dims:    BTreeMap<String, u8>,
	pub note:    String,			// the user's own words
	pub form:    String,
	pub src:     Source,
	pub sup:     String,			// the rating this supersedes, or empty
	pub private: bool,			// never pooled, whatever the settings
	pub hx:      String,			// the harness: daimond, or cc
	pub prod:    Prod,
}

/// Is this an id [`Rating`] mints -- `r-`, then two runs of base-36 joined by a `-`?
fn is_rating_id(s: &str) -> bool {
	let base36 = |t: &str| !t.is_empty() && t.bytes().all(|b| b.is_ascii_digit() || b.is_ascii_lowercase());
	match s.strip_prefix("r-").and_then(|t| t.split_once('-')) {
		Some((a, b))	=> base36(a) && base36(b),
		None		=> false,
	}
}

/// Is this a tag or dimension id: 1 to 32 of lowercase ASCII, digits and `_`?
fn is_tag_id(s: &str) -> bool {
	!s.is_empty() && s.len() <= TAG_ID_MAX
		&& s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

impl Rating {

	/// The record as canonical JSON (RFC 8785): members ordered by key and no whitespace, so two
	/// devices holding the same rating hold the same bytes, which is what the parcel's fixed-point
	/// rule needs.  Empty optional fields are left out; `s` is always written, `null` withdrawing.
	pub fn to_json(&self) -> Outcome<String> {
		let mut m = DaticleMap::new();
		let mut put = |k: &str, v: Dat| { m.insert(dat!(k), v); };
		put("id",	dat!(self.id.clone()));
		put("at",	dat!(self.at));
		put("by",	dat!(self.by.clone()));
		put("h",	dat!(self.h.wire()));
		put("s",	match self.s { Some(n) => dat!(n as i64), None => Dat::Empty });
		put("form",	dat!(self.form.clone()));
		put("src",	dat!(self.src.wire()));
		put("hx",	dat!(self.hx.clone()));
		let strs = [
			("hash", &self.hash), ("note", &self.note), ("sup", &self.sup),
			("m", &self.prod.m), ("pv", &self.prod.pv), ("cm", &self.prod.cm),
			("fam", &self.prod.fam), ("cls", &self.prod.cls), ("role", &self.prod.role),
			("sp", &self.prod.sp), ("d", &self.prod.d), ("c", &self.prod.c), ("t", &self.prod.t),
		];
		for (k, v) in strs {
			if !v.is_empty() {
				put(k, dat!(v.clone()));
			}
		}
		if !self.tags.is_empty() {
			put("tags", Dat::List(self.tags.iter().map(|t| dat!(t.clone())).collect()));
		}
		if !self.prod.tools.is_empty() {
			put("tools", Dat::List(self.prod.tools.iter().map(|t| dat!(t.clone())).collect()));
		}
		if !self.dims.is_empty() {
			let mut d = DaticleMap::new();
			for (k, v) in self.dims.iter() {
				d.insert(dat!(k.clone()), dat!(*v as u64));
			}
			put("dims", Dat::Map(d));
		}
		if self.private {
			put("priv", dat!(1u64));
		}
		if let Some(n) = self.prod.len {
			put("len", dat!(n));
		}
		Dat::Map(m).json_canonical()
	}

	/// Read and validate a record.  Every field a reader would misfile on is checked here, once,
	/// so the index, the parcel and the gateway all refuse the same records.
	pub fn from_json(s: &str) -> Outcome<Self> {
		let cfg = DecoderConfig::<(), ()>::json(None);
		let map = match res!(Dat::decode_string_with_config(s, &cfg)) {
			Dat::Map(m)	=> m,
			other		=> return Err(err!(
				"A rating record is a JSON object, and this is a {:?}.", other.kind();
				Invalid, Input, Decode)),
		};
		let get = |k: &str| map.get(&dat!(k));
		let text = |k: &str| -> Outcome<String> {
			match get(k) {
				None | Some(Dat::Empty)	=> Ok(String::new()),
				Some(Dat::Str(v))	=> Ok(v.clone()),
				Some(other)		=> Err(err!(
					"A rating's '{}' is a string, and this one is a {:?}.", k, other.kind();
					Invalid, Input)),
			}
		};
		let list = |k: &str| -> Outcome<Vec<String>> {
			match get(k) {
				None			=> Ok(Vec::new()),
				Some(Dat::List(v))	=> {
					let mut out = Vec::new();
					for d in v.iter() {
						match d {
							Dat::Str(t)	=> out.push(t.clone()),
							other		=> return Err(err!(
								"A rating's '{}' holds strings, and one is a {:?}.",
								k, other.kind(); Invalid, Input)),
						}
					}
					Ok(out)
				},
				Some(other)		=> Err(err!(
					"A rating's '{}' is a list, and this one is a {:?}.", k, other.kind();
					Invalid, Input)),
			}
		};

		let id = res!(text("id"));
		if !is_rating_id(&id) {
			return Err(err!("'{}' is not a rating id; one reads r-<ts36>-<rand>.", id;
				Invalid, Input));
		}
		let at = match get("at").and_then(|d| d.get_u64()) {
			Some(n) if n > 0	=> n,
			_			=> return Err(err!(
				"Rating {} has no time it was given.", id; Invalid, Input, Missing)),
		};
		let by = res!(text("by"));
		if by.is_empty() {
			return Err(err!("Rating {} names no device it was given on.", id;
				Invalid, Input, Missing));
		}
		let h = res!(Handle::parse(&res!(text("h"))));
		let hash = res!(text("hash"));
		if h.kind == Kind::File && !is_hash(&hash) {
			return Err(err!(
				"Rating {} of a file carries no content hash, so it could not keep its meaning \
				after a restore.", id; Invalid, Input, Missing));
		}
		if h.kind != Kind::File && !hash.is_empty() {
			return Err(err!("Rating {} carries a content hash, and only a file's rating does.", id;
				Invalid, Input));
		}
		let score = match get("s") {
			None				=> return Err(err!(
				"Rating {} has no score; a withdrawal says null.", id; Invalid, Input, Missing)),
			Some(Dat::Empty)		=> None,
			Some(Dat::Opt(o)) if o.is_none() => None,
			Some(d)				=> match d.get_i64() {
				Some(n) if (-2..=2).contains(&n)	=> Some(n as i8),
				_				=> return Err(err!(
					"Rating {} scores {:?}, outside -2 to +2.", id, d; Invalid, Input)),
			},
		};
		let tags = res!(list("tags"));
		for (i, t) in tags.iter().enumerate() {
			if !is_tag_id(t) {
				return Err(err!("Rating {} carries tag '{}', which is not a tag id.", id, t;
					Invalid, Input));
			}
			if tags[..i].contains(t) {
				return Err(err!("Rating {} carries tag '{}' twice.", id, t; Invalid, Input));
			}
		}
		let mut dims = BTreeMap::new();
		match get("dims") {
			None			=> {},
			Some(Dat::Map(dm))	=> for (k, v) in dm.iter() {
				let key = match k {
					Dat::Str(t) if is_tag_id(t)	=> t.clone(),
					other				=> return Err(err!(
						"Rating {} names dimension {:?}, which is not a dimension id.",
						id, other; Invalid, Input)),
				};
				match v.get_u64() {
					Some(n) if n <= DIM_MAX as u64	=> { dims.insert(key, n as u8); },
					_ => return Err(err!("Rating {} puts '{}' at {:?}, outside 0 to {}.",
						id, key, v, DIM_MAX; Invalid, Input)),
				}
			},
			Some(other)		=> return Err(err!(
				"Rating {}'s dims is an object, and this one is a {:?}.", id, other.kind();
				Invalid, Input)),
		}
		let note = res!(text("note"));
		if note.len() > NOTE_MAX {
			return Err(err!("Rating {} keeps {} bytes of words, over the {} a rating holds.",
				id, note.len(), NOTE_MAX; Invalid, Input, TooBig));
		}
		let form = res!(text("form"));
		let known_form = form == FORM || form.strip_prefix(FORM)
			.and_then(|t| t.strip_prefix('.'))
			.map(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
			.unwrap_or(false);
		if !known_form {
			return Err(err!(
				"Rating {} was given on form '{}', which this build does not read; a newer \
				Daimond wrote it.", id, form; Invalid, Input, Version));
		}
		let src_word = res!(text("src"));
		let src = res!(Source::of(&src_word).ok_or_else(|| err!(
			"Rating {} says it came from '{}', which this build does not know.", id, src_word;
			Invalid, Input)));
		let sup = res!(text("sup"));
		if !sup.is_empty() && !is_rating_id(&sup) {
			return Err(err!("Rating {} supersedes '{}', which is not a rating id.", id, sup;
				Invalid, Input));
		}
		let private = match get("priv") {
			None | Some(Dat::Empty)		=> false,
			Some(Dat::Bool(b))		=> *b,
			Some(d)				=> match d.get_u64() {
				Some(0)	=> false,
				Some(1)	=> true,
				_	=> return Err(err!("Rating {}'s priv is {:?}, not 0 or 1.", id, d;
					Invalid, Input)),
			},
		};
		let hx = res!(text("hx"));
		let len = match get("len") {
			None | Some(Dat::Empty)	=> None,
			Some(d)			=> match d.get_u64() {
				Some(n)	=> Some(n),
				None	=> return Err(err!("Rating {}'s len is {:?}, not a count.", id, d;
					Invalid, Input)),
			},
		};
		let prod = Prod {
			m:     res!(text("m")),
			pv:    res!(text("pv")),
			cm:    res!(text("cm")),
			fam:   res!(text("fam")),
			cls:   res!(text("cls")),
			role:  res!(text("role")),
			sp:    res!(text("sp")),
			d:     res!(text("d")),
			c:     res!(text("c")),
			t:     res!(text("t")),
			tools: res!(list("tools")),
			len,
		};
		Ok(Self { id, at, by, h, hash, s: score, tags, dims, note, form, src, sup, private,
			hx: if hx.is_empty() { "daimond".to_string() } else { hx }, prod })
	}
}


#[cfg(test)]
mod tests {
	use super::*;

	fn rated() -> Rating {
		Rating {
			id:      "r-mfz3k2a1-ab12c".to_string(),
			at:      1_790_000_123_456,
			by:      "dev-a".to_string(),
			h:       Handle::file("d-thesis", 12, "src/parse.rs"),
			hash:    "a".repeat(64),
			s:       Some(-1),
			tags:    vec!["scope".to_string()],
			dims:    [("followed".to_string(), 1u8)].into_iter().collect(),
			note:    "I only asked for the \"test\"".to_string(),
			form:    FORM.to_string(),
			src:     Source::Popup,
			sup:     String::new(),
			private: true,
			hx:      "daimond".to_string(),
			prod:    Prod {
				m:     "accounts/fireworks/models/glm-5p2".to_string(),
				pv:    "fireworks".to_string(),
				cm:    "glm-5.2".to_string(),
				fam:   "glm-5".to_string(),
				cls:   "open-frontier".to_string(),
				role:  "worker".to_string(),
				sp:    "sp1:3f9a0c12".to_string(),
				d:     "d-thesis".to_string(),
				c:     "cabc".to_string(),
				t:     "m1".to_string(),
				tools: vec!["file_read".to_string(), "file_edit".to_string()],
				len:   Some(1840),
			},
		}
	}

	#[test]
	fn test_the_form_keeps_one_code_per_tag_00() {
		let mut codes: Vec<u16> = TAGS.iter().map(|t| t.code).collect();
		let mut ids: Vec<&str> = TAGS.iter().map(|t| t.id).collect();
		codes.sort();
		ids.sort();
		codes.dedup();
		ids.dedup();
		assert_eq!(codes.len(), TAGS.len(), "a code is shared");
		assert_eq!(ids.len(), TAGS.len(), "an id is listed twice");
		assert!(TAGS.iter().all(|t| is_tag_id(t.id) && t.code > 0 && !t.kinds.is_empty()));
		// The two that recur across kinds keep one code each.
		assert_eq!(tag_code("wrong", Kind::Answer), tag_code("wrong", Kind::Crystal));
		assert_eq!(tag_code("style", Kind::Answer), tag_code("style", Kind::File));
		// A base tag on a kind it is not offered on is the user's own, and pools as nothing.
		assert_eq!(tag_code("broke", Kind::Answer), None);
		assert_eq!(tag_code("voice", Kind::Answer), None);
	}

	#[test]
	fn test_the_form_is_the_design_table_00() {
		let on = |k: Kind, side: Side| -> Vec<&str> {
			TAGS.iter().filter(|t| t.side == side && t.kinds.contains(&k)).map(|t| t.id).collect()
		};
		assert_eq!(on(Kind::Answer, Side::Down),
			vec!["wrong", "ignored", "long", "short", "style", "tool", "refused", "slow"]);
		assert_eq!(on(Kind::Worker, Side::Up), vec!["correct", "followed", "concise", "style_good"]);
		assert_eq!(on(Kind::File, Side::Down),
			vec!["style", "broke", "wrong_change", "incomplete", "scope", "wiped"]);
		assert_eq!(on(Kind::Crystal, Side::Down), vec!["wrong", "lost", "bloated"]);
		assert_eq!(on(Kind::Mail, Side::Down), vec!["wrong", "long", "tone"]);
		assert_eq!(on(Kind::Proposal, Side::Up), vec!["useful"]);
		let json = form_json();
		assert!(json.starts_with("{\"form\":\"daimond/1\""), "{}", json);
		assert!(json.contains("{\"id\":\"wiped\",\"code\":17,\"side\":\"down\",\"kinds\":[\"file\"],\
			\"key\":\"rating.tag.wiped\"}"), "{}", json);
		assert!(json.contains("{\"s\":-2,\"id\":\"wrong\",\"key\":\"rating.scale.wrong\"}"), "{}", json);
		// And it is JSON a reader can take.
		let cfg = DecoderConfig::<(), ()>::json(None);
		assert!(Dat::decode_string_with_config(json, &cfg).is_ok());
	}

	#[test]
	fn test_every_handle_round_trips_00() -> Outcome<()> {
		let all = [
			(Handle::answer("cmfz3-1-abcde", "mfz3-2-fghij"),	"p1:answer:cmfz3-1-abcde/mfz3-2-fghij"),
			(Handle::file("chat:cabc", 3, "notes/v2/a b.md"),	"p1:file:chat:cabc/v3/notes/v2/a b.md"),
			(Handle::crystal("d-thesis", 41),			"p1:crystal:d-thesis/v41"),
			(Handle::fold("cabc", "mfz3-9-zzzzz"),			"p1:crystal:cabc/mfz3-9-zzzzz"),
			(Handle::single(Kind::Worker, "w-7"),			"p1:worker:w-7"),
			(Handle::single(Kind::Mail, "mail/drafts/2026/x.eml"),	"p1:mail:mail/drafts/2026/x.eml"),
			(Handle::single(Kind::Proposal, "p-1"),			"p1:proposal:p-1"),
		];
		for (h, wire) in all.iter() {
			assert_eq!(&h.wire(), wire);
			assert_eq!(&res!(Handle::parse(wire)), h, "{}", wire);
		}
		Ok(())
	}

	#[test]
	fn test_a_malformed_handle_is_refused_00() {
		for bad in [
			"", "answer:c/m", "p2:answer:c/m", "p1:thing:c/m", "p1:answer:c", "p1:answer:/m",
			"p1:file:s/3/p", "p1:file:s/v3", "p1:file:s/v3/", "p1:worker:", "p1:mail: ",
			"p1:answer:c/m\n",
		] {
			assert!(Handle::parse(bad).is_err(), "{:?} parsed", bad);
		}
	}

	#[test]
	fn test_an_author_round_trips_and_an_empty_one_is_none_00() {
		let a = Author {
			role: "worker".to_string(),
			m:    "claude-sonnet-5".to_string(),
			pv:   "anthropic".to_string(),
			sp:   "sp1:0badf00d".to_string(),
			run:  "w-\"7\"".to_string(),
		};
		assert_eq!(Author::from_json(&a.to_json()), Some(a.clone()));
		let daimon = Author { role: "daimon".to_string(), m: "glm".to_string(), ..Default::default() };
		assert_eq!(daimon.to_json(), "{\"role\":\"daimon\",\"m\":\"glm\"}");
		assert_eq!(Author::from_json("{\"m\":\"glm\"}"), None);
		assert!(!Author::default().is_known());
	}

	#[test]
	fn test_a_rating_round_trips_canonically_00() -> Outcome<()> {
		let r = rated();
		let json = res!(r.to_json());
		assert!(json.starts_with("{\"at\":1790000123456,\"by\":\"dev-a\",\"c\":\"cabc\""), "{}", json);
		assert!(json.contains("\"s\":-1") && json.contains("\"priv\":1"), "{}", json);
		let back = res!(Rating::from_json(&json));
		assert_eq!(back, r);
		assert_eq!(res!(back.to_json()), json, "not a fixed point");
		// A withdrawal says null, and is not a missing score.
		let gone = Rating { s: None, ..r.clone() };
		let gj = res!(gone.to_json());
		assert!(gj.contains("\"s\":null"), "{}", gj);
		assert_eq!(res!(Rating::from_json(&gj)).s, None);
		Ok(())
	}

	#[test]
	fn test_a_bad_rating_is_refused_00() -> Outcome<()> {
		let good = res!(rated().to_json());
		let swap = |from: &str, to: &str| -> String {
			assert!(good.contains(from), "{} not in {}", from, good);
			good.replacen(from, to, 1)
		};
		for bad in [
			swap("\"s\":-1", "\"s\":-3"),
			swap("\"s\":-1,", ""),
			swap("\"id\":\"r-mfz3k2a1-ab12c\"", "\"id\":\"x-1\""),
			swap(&fmt!("\"hash\":\"{}\",", "a".repeat(64)), ""),
			swap("\"form\":\"daimond/1\"", "\"form\":\"daimond/2\""),
			swap("\"src\":\"popup\"", "\"src\":\"shout\""),
			swap("\"followed\":1", "\"followed\":5"),
			swap("[\"scope\"]", "[\"scope\",\"scope\"]"),
			swap("[\"scope\"]", "[\"Scope!\"]"),
			swap("\"h\":\"p1:file:d-thesis/v12/src/parse.rs\"", "\"h\":\"p1:answer:c/m\""),
		] {
			assert!(Rating::from_json(&bad).is_err(), "accepted {}", bad);
		}
		// A minor version of the same form is read.
		assert!(Rating::from_json(&swap("\"form\":\"daimond/1\"", "\"form\":\"daimond/1.3\"")).is_ok());
		Ok(())
	}
}
