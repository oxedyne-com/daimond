//! Per-product rating: the handle a product is named by, the author a version entry records, the
//! form `daimond/1`, and the rating record with the chat messages it travels in.
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


pub const FORM: &str		= "daimond/1.1";	// the form this build writes (1.1: RATE-REASONS)
const FORM_MAJOR: &str	= "daimond/1";	// the major this build reads, and every minor of it
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
	/// On the one-tap row after a down tap. False keeps a reason in Details only, for one that
	/// names an area rather than a fault (`tool`) or one a newer reason replaces on the row.
	pub quick: bool,
}

impl Tag {
	/// The catalogue key of the tag's label.
	pub fn i18n(&self) -> String { fmt!("rating.tag.{}", self.id) }
}

const AW: &[Kind]	= &[Kind::Answer, Kind::Worker];
const AWF: &[Kind]	= &[Kind::Answer, Kind::Worker, Kind::File];
const AWM: &[Kind]	= &[Kind::Answer, Kind::Worker, Kind::Mail];
const MISSED: &[Kind]	= &[Kind::Answer, Kind::Worker, Kind::File, Kind::Mail];
const WRONG: &[Kind]	= &[Kind::Answer, Kind::Worker, Kind::Crystal, Kind::Mail, Kind::Proposal];
const F: &[Kind]	= &[Kind::File];
const C: &[Kind]	= &[Kind::Crystal];
const M: &[Kind]	= &[Kind::Mail];
const P: &[Kind]	= &[Kind::Proposal];

// §4.2's table.  `wrong` and `style` recur across kinds and keep one code each, so a pooled count
// of either means the same thing whatever was rated.
//
// RATE-REASONS (D-20261015-07, form 1.1): "Wrong" was two faults, so `missed` ("Missed the
// point") is added and leads every row it is on, and `wrong` keeps code 1 and its meaning,
// labelled "Incorrect". No id changes meaning, so a 1.0 record reads unchanged. `on_point`
// mirrors `missed` on the up side. Their codes are 32 and 33, not the next free 29 and 30,
// because the model-compare plan's MC3 (specs/daimond_model_compare_plan_20261009.md §2.3)
// already holds 29-31 for `made_up`, `checked` and `unchecked`; MC3 moves to form 1.2. `tool` and `wrong_change` leave the row (`quick: false`) and
// stay in Details. The order here is the order of every row.
pub const TAGS: &[Tag] = &[
	Tag { id: "missed",		code: 32,	side: Side::Down,	kinds: MISSED,	quick: true },
	Tag { id: "on_point",		code: 33,	side: Side::Up,		kinds: AW,	quick: true },
	Tag { id: "wrong",		code: 1,	side: Side::Down,	kinds: WRONG,	quick: true },
	Tag { id: "ignored",		code: 2,	side: Side::Down,	kinds: AW,	quick: true },
	Tag { id: "long",		code: 3,	side: Side::Down,	kinds: AWM,	quick: true },
	Tag { id: "short",		code: 4,	side: Side::Down,	kinds: AW,	quick: true },
	Tag { id: "style",		code: 5,	side: Side::Down,	kinds: AWF,	quick: true },
	Tag { id: "tool",		code: 6,	side: Side::Down,	kinds: AW,	quick: false },
	Tag { id: "refused",		code: 7,	side: Side::Down,	kinds: AW,	quick: true },
	Tag { id: "slow",		code: 8,	side: Side::Down,	kinds: AW,	quick: true },
	Tag { id: "correct",		code: 9,	side: Side::Up,		kinds: AW,	quick: true },
	Tag { id: "followed",		code: 10,	side: Side::Up,		kinds: AW,	quick: true },
	Tag { id: "concise",		code: 11,	side: Side::Up,		kinds: AW,	quick: true },
	Tag { id: "style_good",		code: 12,	side: Side::Up,		kinds: AW,	quick: true },
	Tag { id: "broke",		code: 13,	side: Side::Down,	kinds: F,	quick: true },
	Tag { id: "wrong_change",	code: 14,	side: Side::Down,	kinds: F,	quick: false },
	Tag { id: "incomplete",		code: 15,	side: Side::Down,	kinds: F,	quick: true },
	Tag { id: "scope",		code: 16,	side: Side::Down,	kinds: F,	quick: true },
	Tag { id: "wiped",		code: 17,	side: Side::Down,	kinds: F,	quick: true },
	Tag { id: "clean",		code: 18,	side: Side::Up,		kinds: F,	quick: true },
	Tag { id: "complete",		code: 19,	side: Side::Up,		kinds: F,	quick: true },
	Tag { id: "lost",		code: 20,	side: Side::Down,	kinds: C,	quick: true },
	Tag { id: "bloated",		code: 21,	side: Side::Down,	kinds: C,	quick: true },
	Tag { id: "faithful",		code: 22,	side: Side::Up,		kinds: C,	quick: true },
	Tag { id: "tidy",		code: 23,	side: Side::Up,		kinds: C,	quick: true },
	Tag { id: "tone",		code: 24,	side: Side::Down,	kinds: M,	quick: true },
	Tag { id: "ready",		code: 25,	side: Side::Up,		kinds: M,	quick: true },
	Tag { id: "not_useful",		code: 26,	side: Side::Down,	kinds: P,	quick: true },
	Tag { id: "already_knew",	code: 27,	side: Side::Down,	kinds: P,	quick: true },
	Tag { id: "useful",		code: 28,	side: Side::Up,		kinds: P,	quick: true },
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
			fmt!("{{\"id\":\"{}\",\"code\":{},\"side\":\"{}\",\"kinds\":[{}],\"key\":\"{}\",\"quick\":{}}}",
				t.id, t.code, t.side.wire(), kinds.join(","), t.i18n(), t.quick)
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
#[derive(Clone, Debug, Default, Eq, PartialEq, ToDat, FromDat)]
pub struct Author {
	pub role: String,	// chat, daimon, worker, reducer, compactor or vision
	pub m:    String,	// the model as sent, in the provider's own spelling
	pub pv:   String,	// the serving provider's id
	pub sp:   String,	// the system-prompt fingerprint, see `prompts::fingerprint`
	pub run:  String,	// a worker's run id, else empty
	pub via:  String,	// 'command' where a command or helper window credited it, else empty
}

impl Author {

	/// Is there an author to record -- a model's turn rather than the user's own door?
	pub fn is_known(&self) -> bool { !self.role.is_empty() }

	/// The nested object an entry carries, in a fixed order, empty fields left out.
	pub fn to_json(&self) -> String {
		let mut out = fmt!("{{\"role\":\"{}\"", json_escape(&self.role));
		// `via` last, so a reader that has never heard of it finds every key it looks for.
		for (k, v) in [("m", &self.m), ("pv", &self.pv), ("sp", &self.sp), ("run", &self.run),
			("via", &self.via)]
		{
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
			via: extract_json_string(obj, "via").unwrap_or_default(),
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

/// The largest whole number a page holds exactly (`2^53 - 1`), and so the largest a record carries.
pub const BIG: u64 = 9_007_199_254_740_991;

// The enums a `Prod` is declared with (fix brief section 3).  A value outside them is refused: a
// build that names a new one writes a new record version, with its upgrade step.
pub const CLASSES: &[&str]	= &["frontier", "fast", "open-frontier", "open-fast", "reasoning", "coder",
	"vision", "unknown"];
pub const ROLES: &[&str]	= &["chat", "daimon", "worker", "reducer", "compactor", "vision"];
pub const VIAS: &[&str]		= &["", "command"];

// The keys of each record, in the order the page writes them.  `JSON.stringify` keeps insertion
// order, so this order is part of the bytes, and the fixtures hold both languages to it.
const PROD_KEYS: &[&str]	= &["h", "k", "m", "pv", "cm", "fam", "fi", "cls", "role", "sp", "d", "c", "t",
	"dev", "at", "hash", "run", "via"];
const RATING_KEYS: &[&str]	= &["h", "hash", "s", "clear", "tags", "dims", "note", "form", "src", "sup",
	"priv", "hx", "burst", "tools", "len", "prod"];

/// The product's provenance, copied into the rating so aggregation never loads a transcript.
///
/// Version 2 of the declaration (`PROD_KEYS`, `via` last).  Every key is always present.  A version
/// 1 record, written before `via` existed, is read with `via` empty and is never rewritten; this
/// build writes version 2.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Prod {
	pub h:    String,		// the product's handle
	pub k:    Kind,
	pub m:    String,		// the model as sent, in the provider's own spelling
	pub pv:   String,		// the serving provider's id
	pub cm:   String,		// canonical model id
	pub fam:  String,
	pub fi:   bool,			// the family is a guess from the name
	pub cls:  String,
	pub role: String,
	pub sp:   String,		// the system-prompt fingerprint
	pub d:    String,		// Diamond id, or empty
	pub c:    String,		// chat id
	pub t:    String,		// turn id, the user message mid
	pub dev:  String,		// the device that made it
	pub at:   u64,			// ms
	pub hash: String,		// a file row's content; empty for everything else
	pub run:  String,		// a worker's run id, else empty
	pub via:  String,		// 'command' where a command or helper window credited it, else empty
}

impl Prod {

	/// Refuse a record this build would not have written.
	pub fn check(&self) -> Outcome<()> {
		let h = res!(Handle::parse(&self.h));
		if h.kind != self.k {
			return Err(err!("A product record names handle '{}', a {}, and says it is a {}.",
				self.h, h.kind.wire(), self.k.wire(); Invalid, Input));
		}
		if !CLASSES.contains(&self.cls.as_str()) {
			return Err(err!("Product '{}' is of class '{}', which is not one of {:?}.",
				self.h, self.cls, CLASSES; Invalid, Input));
		}
		if !ROLES.contains(&self.role.as_str()) {
			return Err(err!("Product '{}' was made by role '{}', which is not one of {:?}.",
				self.h, self.role, ROLES; Invalid, Input));
		}
		if !VIAS.contains(&self.via.as_str()) {
			return Err(err!("Product '{}' says it came via '{}', which is not one of {:?}.",
				self.h, self.via, VIAS; Invalid, Input));
		}
		if self.at > BIG {
			return Err(err!("Product '{}' was made at {}, past the {} a page holds exactly.",
				self.h, self.at, BIG; Invalid, Input, TooBig));
		}
		if self.k != Kind::File && !self.hash.is_empty() {
			return Err(err!("Product '{}' carries a content hash, and only a file row does.", self.h;
				Invalid, Input));
		}
		// A file row that is gone has no hash, so the hash is checked only where there is one.
		if !self.hash.is_empty() && !is_hash(&self.hash) {
			return Err(err!("Product '{}' carries '{}' as its content hash, which is not one.",
				self.h, self.hash; Invalid, Input));
		}
		Ok(())
	}

	/// The record as the page writes it: every key, in declared order.
	pub fn to_json(&self) -> Outcome<String> {
		res!(self.check());
		let strs = [&self.h, &self.m, &self.pv, &self.cm, &self.fam];
		let [h, m, pv, cm, fam] = strs.map(|v| jstr(v));
		let rest = [&self.cls, &self.role, &self.sp, &self.d, &self.c, &self.t, &self.dev,
			&self.hash, &self.run, &self.via];
		let [cls, role, sp, d, c, t, dev, hash, run, via] = rest.map(|v| jstr(v));
		Ok(fmt!(
			"{{\"h\":{},\"k\":\"{}\",\"m\":{},\"pv\":{},\"cm\":{},\"fam\":{},\"fi\":{},\"cls\":{},\
			\"role\":{},\"sp\":{},\"d\":{},\"c\":{},\"t\":{},\"dev\":{},\"at\":{},\"hash\":{},\
			\"run\":{},\"via\":{}}}",
			res!(h), self.k.wire(), res!(m), res!(pv), res!(cm), res!(fam), self.fi, res!(cls),
			res!(role), res!(sp), res!(d), res!(c), res!(t), res!(dev), self.at, res!(hash),
			res!(run), res!(via)))
	}

	/// Read a record, version 2, or version 1 where it has no `via`.
	pub fn from_map(m: &DaticleMap) -> Outcome<Self> {
		res!(only_keys("A product record", m, PROD_KEYS, &["via"]));
		let h = res!(text_of(m, "A product record", "h"));
		let what = fmt!("The product record '{}'", h);
		let k = res!(text_of(m, &what, "k"));
		let k = res!(Kind::of(&k).ok_or_else(|| err!(
			"{} names kind '{}', which this build does not know.", what, k; Invalid, Input)));
		let prod = Self {
			h,
			k,
			m:    res!(text_of(m, &what, "m")),
			pv:   res!(text_of(m, &what, "pv")),
			cm:   res!(text_of(m, &what, "cm")),
			fam:  res!(text_of(m, &what, "fam")),
			fi:   res!(bool_of(m, &what, "fi")),
			cls:  res!(text_of(m, &what, "cls")),
			role: res!(text_of(m, &what, "role")),
			sp:   res!(text_of(m, &what, "sp")),
			d:    res!(text_of(m, &what, "d")),
			c:    res!(text_of(m, &what, "c")),
			t:    res!(text_of(m, &what, "t")),
			dev:  res!(text_of(m, &what, "dev")),
			at:   res!(whole_of(m, &what, "at")),
			hash: res!(text_of(m, &what, "hash")),
			run:  res!(text_of(m, &what, "run")),
			// Absent is version 1, and reads as no mark.
			via:  match m.get(&dat!("via")) {
				None	=> String::new(),
				Some(_)	=> res!(text_of(m, &what, "via")),
			},
		};
		res!(prod.check());
		Ok(prod)
	}

	pub fn from_json(s: &str) -> Outcome<Self> {
		Self::from_map(&res!(map_of(s, "A product record")))
	}
}

/// One rating of one product by one person, exactly as the page's `rating_log` message carries it
/// in its `rating` key (U2 plan section 2.2).  Immutable: a change of mind is a new record naming
/// this one in `sup`.  The id and the time are the message's own (`RatingLog`), not the record's.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Rating {
	pub h:       String,		// the product's handle, equal to `prod.h`
	pub hash:    String,		// the content rated; files only, equal to `prod.hash`
	pub s:       i8,		// -2..=2; 0 when `clear`
	pub clear:   bool,		// withdrawn; then no score, tags or words
	pub tags:    Vec<String>,	// sorted ascending, unique
	pub dims:    [i8; 4],		// the four of `DIMS`, in order; -1 for not given, else 0..=DIM_MAX
	pub note:    String,		// the user's own words
	pub form:    String,
	pub src:     Source,
	pub sup:     String,		// the rating this supersedes, or empty
	pub private: bool,		// never pooled, whatever the settings
	pub hx:      String,		// the harness: daimond, or cc
	pub burst:   String,		// the id of the first record committed with it
	pub tools:   String,		// the tool path joined by '>'; empty for none
	pub len:     u64,		// characters of the product
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

/// Is this a form this build reads: `daimond/1`, or a minor version of it?
fn is_known_form(form: &str) -> bool {
	form == FORM_MAJOR || form.strip_prefix(FORM_MAJOR)
		.and_then(|t| t.strip_prefix('.'))
		.map(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
		.unwrap_or(false)
}

impl Rating {

	/// Refuse a record this build would not have written.  Every field a reader would misfile on
	/// is checked here, once, so the writer, the index, the parcel and the gateway refuse the same
	/// records.
	pub fn check(&self) -> Outcome<()> {
		let h = res!(Handle::parse(&self.h));
		res!(self.prod.check());
		let who = fmt!("The rating of '{}'", self.h);
		if self.prod.h != self.h {
			return Err(err!("{} carries the provenance of '{}', a different product.", who,
				self.prod.h; Invalid, Input));
		}
		if self.hash != self.prod.hash {
			return Err(err!("{} holds content hash '{}' and its provenance '{}'.", who, self.hash,
				self.prod.hash; Invalid, Input));
		}
		if h.kind == Kind::File && !is_hash(&self.hash) {
			return Err(err!(
				"{} of a file carries no content hash, so it could not keep its meaning after a \
				restore.", who; Invalid, Input, Missing));
		}
		if !(-2..=2).contains(&self.s) {
			return Err(err!("{} scores {}, outside -2 to +2.", who, self.s; Invalid, Input));
		}
		for (i, t) in self.tags.iter().enumerate() {
			if !is_tag_id(t) {
				return Err(err!("{} carries tag '{}', which is not a tag id.", who, t;
					Invalid, Input));
			}
			if i > 0 && self.tags[i - 1] >= *t {
				return Err(err!("{} lists tag '{}' after '{}', and tags are sorted and unique.",
					who, t, self.tags[i - 1]; Invalid, Input));
			}
		}
		for (i, v) in self.dims.iter().enumerate() {
			if !(-1..=(DIM_MAX as i8)).contains(v) {
				return Err(err!("{} puts '{}' at {}, outside -1 (not given) to {}.", who,
					DIMS[i].0, v, DIM_MAX; Invalid, Input));
			}
		}
		if self.clear && (self.s != 0 || !self.tags.is_empty() || self.dims != [-1; 4]
			|| !self.note.is_empty())
		{
			return Err(err!(
				"{} is a withdrawal, which scores 0 and carries no tags, no dimensions and no \
				words.", who; Invalid, Input));
		}
		if self.note.len() > NOTE_MAX {
			return Err(err!("{} keeps {} bytes of words, over the {} a rating holds.", who,
				self.note.len(), NOTE_MAX; Invalid, Input, TooBig));
		}
		if !is_known_form(&self.form) {
			return Err(err!(
				"{} was given on form '{}', which this build does not read; a newer Daimond \
				wrote it.", who, self.form; Invalid, Input, Version));
		}
		if !self.sup.is_empty() && !is_rating_id(&self.sup) {
			return Err(err!("{} supersedes '{}', which is not a rating id.", who, self.sup;
				Invalid, Input));
		}
		if !self.burst.is_empty() && !is_rating_id(&self.burst) {
			return Err(err!("{} belongs to burst '{}', which is not a rating id.", who, self.burst;
				Invalid, Input));
		}
		if self.len > BIG {
			return Err(err!("{} measures the product at {}, past the {} a page holds exactly.",
				who, self.len, BIG; Invalid, Input, TooBig));
		}
		Ok(())
	}

	/// The record as the page writes it: every key, in declared order, with no whitespace.  The
	/// same bytes `JSON.stringify` makes from the same record, which is what the parcel's fixed
	/// point needs and what `dev/fixtures/rating_u2.json` and `rating_u3.json` hold this to.
	pub fn to_json(&self) -> Outcome<String> {
		res!(self.check());
		let mut tags = Vec::with_capacity(self.tags.len());
		for t in &self.tags {
			tags.push(res!(jstr(t)));
		}
		let dims: Vec<String> = DIMS.iter().zip(self.dims.iter())
			.map(|((id, _), v)| fmt!("\"{}\":{}", id, v))
			.collect();
		Ok(fmt!(
			"{{\"h\":{},\"hash\":{},\"s\":{},\"clear\":{},\"tags\":[{}],\"dims\":{{{}}},\"note\":{},\
			\"form\":{},\"src\":\"{}\",\"sup\":{},\"priv\":{},\"hx\":{},\"burst\":{},\"tools\":{},\
			\"len\":{},\"prod\":{}}}",
			res!(jstr(&self.h)), res!(jstr(&self.hash)), self.s, self.clear, tags.join(","),
			dims.join(","), res!(jstr(&self.note)), res!(jstr(&self.form)), self.src.wire(),
			res!(jstr(&self.sup)), self.private, res!(jstr(&self.hx)), res!(jstr(&self.burst)),
			res!(jstr(&self.tools)), self.len, res!(self.prod.to_json())))
	}

	/// Read and validate a record.  A missing key and an extra one are each refused; a version 1
	/// `prod` without `via` is read with it empty.
	pub fn from_map(m: &DaticleMap) -> Outcome<Self> {
		res!(only_keys("A rating record", m, RATING_KEYS, &[]));
		let h = res!(text_of(m, "A rating record", "h"));
		let what = fmt!("The rating of '{}'", h);
		let score = res!(int_of(m, &what, "s"));
		let score = match i8::try_from(score) {
			Ok(n)	=> n,
			Err(_)	=> return Err(err!("{} scores {}, outside -2 to +2.", what, score;
				Invalid, Input)),
		};
		let mut tags = Vec::new();
		match m.get(&dat!("tags")) {
			Some(Dat::List(v))	=> for d in v.iter() {
				match d {
					Dat::Str(t)	=> tags.push(t.clone()),
					other		=> return Err(err!(
						"{}: tags holds strings, and one is a {:?}.", what, other.kind();
						Invalid, Input)),
				}
			},
			other			=> return Err(err!(
				"{}: tags is a list, and this one is {:?}.", what, other; Invalid, Input)),
		}
		let mut dims = [-1i8; 4];
		match m.get(&dat!("dims")) {
			Some(Dat::Map(dm))	=> {
				let names: Vec<&str> = DIMS.iter().map(|(id, _)| *id).collect();
				res!(only_keys(&fmt!("{}: dims", what), dm, &names, &[]));
				for (i, id) in names.iter().enumerate() {
					let v = res!(int_of(dm, &fmt!("{}: dims", what), id));
					dims[i] = match i8::try_from(v) {
						Ok(n)	=> n,
						Err(_)	=> return Err(err!(
							"{} puts '{}' at {}, outside -1 (not given) to {}.", what, id, v,
							DIM_MAX; Invalid, Input)),
					};
				}
			},
			other			=> return Err(err!(
				"{}: dims is an object, and this one is {:?}.", what, other; Invalid, Input)),
		}
		let src_word = res!(text_of(m, &what, "src"));
		let src = res!(Source::of(&src_word).ok_or_else(|| err!(
			"{} says it came from '{}', which this build does not know.", what, src_word;
			Invalid, Input)));
		let prod = match m.get(&dat!("prod")) {
			Some(Dat::Map(pm))	=> res!(Prod::from_map(pm)),
			other			=> return Err(err!(
				"{}: prod is a product record, and this one is {:?}.", what, other;
				Invalid, Input)),
		};
		let rating = Self {
			h,
			hash:    res!(text_of(m, &what, "hash")),
			s:       score,
			clear:   res!(bool_of(m, &what, "clear")),
			tags,
			dims,
			note:    res!(text_of(m, &what, "note")),
			form:    res!(text_of(m, &what, "form")),
			src,
			sup:     res!(text_of(m, &what, "sup")),
			private: res!(bool_of(m, &what, "priv")),
			hx:      res!(text_of(m, &what, "hx")),
			burst:   res!(text_of(m, &what, "burst")),
			tools:   res!(text_of(m, &what, "tools")),
			len:     res!(whole_of(m, &what, "len")),
			prod,
		};
		res!(rating.check());
		Ok(rating)
	}

	pub fn from_json(s: &str) -> Outcome<Self> {
		Self::from_map(&res!(map_of(s, "A rating record")))
	}
}


// ┌───────────────────────────────────────────────────────────────┐
// │ The messages a chat carries these in                           │
// └───────────────────────────────────────────────────────────────┘

/// A chat's `rating_log` message: `{ role, mid, ts, rating }`.  It has no `content`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RatingLog {
	pub mid:    String,		// the rating's id, `r-<ts36>-<rand5>`
	pub ts:     u64,		// the commit time, the same for a whole burst
	pub rating: Rating,
}

/// A chat turn's display-only `files_log` message: `{ role, mid, ts, prod, delta }`, one `file`
/// record per row of the turn's changed-files tile.  It is never sent to the model.
///
/// `delta` sits beside `prod` and not in its records, because a record is the exact [`Prod`] that a
/// rating copies whole.  It is always written, `[]` when no row could be counted, and the reader
/// refuses a message without it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FilesLog {
	pub mid:   String,
	pub ts:    u64,
	pub prod:  Vec<Prod>,
	pub delta: Vec<FileDelta>,	// a count for each row the store could diff, in `prod` order
}

/// The lines a turn added to and removed from one row of a [`FilesLog`], counted from the chat's
/// own store when the message was made.  A gone file, and one the store could not diff (a binary
/// body, past the diff's cap, a body not held), has no entry.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FileDelta {
	pub h:   String,	// the handle of a row of the same message's `prod`
	pub add: u64,		// lines added against the version before, or all of a new file
	pub del: u64,		// lines removed
}

/// A user message as the page stores it: `{ role, content, mid, ts[, iturn][, pre][, app] }`.
///
/// `pre`, the app's note, sits beside the words and never in them, and is absent when there is no
/// note.  `app` marks a message the app made itself (a trigger, a preset, a gather round, a
/// Continue), which never carries a note, and is absent on a person's own.  Only the keys the page
/// writes today are read; a new one is refused until it is declared here, which is how a field the
/// engine does not know about is found.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UserLog {
	pub content: String,		// what the person typed
	pub mid:     String,
	pub ts:      u64,
	pub iturn:   String,		// the turn it began, where it differs from `mid`; else empty
	pub pre:     String,		// the app's note, else empty
	pub app:     bool,		// the app's own message, not the person's
}

/// One message of a chat, of the three kinds `rating_u3.json` holds.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LogMessage {
	Rating(RatingLog),
	Files(FilesLog),
	User(UserLog),
}

impl LogMessage {

	/// The message as the page writes it.
	pub fn to_json(&self) -> Outcome<String> {
		match self {
			Self::Rating(r) => {
				if !is_rating_id(&r.mid) {
					return Err(err!("A rating_log message is named '{}', which is not a rating id.",
						r.mid; Invalid, Input));
				}
				if r.ts == 0 || r.ts > BIG {
					return Err(err!("The rating_log message '{}' was committed at {}, which is not \
						a time a page holds.", r.mid, r.ts; Invalid, Input));
				}
				Ok(fmt!("{{\"role\":\"rating_log\",\"mid\":{},\"ts\":{},\"rating\":{}}}",
					res!(jstr(&r.mid)), r.ts, res!(r.rating.to_json())))
			},
			Self::Files(f) => {
				if f.ts == 0 || f.ts > BIG {
					return Err(err!("The files_log message '{}' was made at {}, which is not a \
						time a page holds.", f.mid, f.ts; Invalid, Input));
				}
				let mut rows = Vec::with_capacity(f.prod.len());
				for p in &f.prod {
					if p.k != Kind::File {
						return Err(err!("The files_log message '{}' holds a {} record, and it \
							holds file rows alone.", f.mid, p.k.wire(); Invalid, Input));
					}
					rows.push(res!(p.to_json()));
				}
				res!(delta_fits(&fmt!("The files_log message '{}'", f.mid), "writing", &f.prod,
					&f.delta));
				let mut counts = Vec::with_capacity(f.delta.len());
				for d in &f.delta {
					counts.push(fmt!("{{\"h\":{},\"add\":{},\"del\":{}}}", res!(jstr(&d.h)), d.add,
						d.del));
				}
				Ok(fmt!("{{\"role\":\"files_log\",\"mid\":{},\"ts\":{},\"prod\":[{}],\"delta\":[{}]}}",
					res!(jstr(&f.mid)), f.ts, rows.join(","), counts.join(",")))
			},
			Self::User(u) => {
				if u.ts == 0 || u.ts > BIG {
					return Err(err!("The user message '{}' was said at {}, which is not a time a \
						page holds.", u.mid, u.ts; Invalid, Input));
				}
				let mut out = fmt!("{{\"role\":\"user\",\"content\":{},\"mid\":{},\"ts\":{}",
					res!(jstr(&u.content)), res!(jstr(&u.mid)), u.ts);
				if !u.iturn.is_empty() {
					out.push_str(&fmt!(",\"iturn\":{}", res!(jstr(&u.iturn))));
				}
				if !u.pre.is_empty() {
					out.push_str(&fmt!(",\"pre\":{}", res!(jstr(&u.pre))));
				}
				if u.app {
					out.push_str(",\"app\":true");
				}
				out.push('}');
				Ok(out)
			},
		}
	}

	/// Read one message, refusing a missing key, an extra one and a record that fails its own check.
	pub fn from_map(m: &DaticleMap) -> Outcome<Self> {
		let role = match m.get(&dat!("role")) {
			Some(Dat::Str(r))	=> r.clone(),
			other			=> return Err(err!(
				"A chat message has a role, and this one has {:?}.", other; Invalid, Input, Missing)),
		};
		match role.as_str() {
			"rating_log" => {
				res!(only_keys("A rating_log message", m, &["role", "mid", "ts", "rating"], &[]));
				let mid = res!(text_of(m, "A rating_log message", "mid"));
				let what = fmt!("The rating_log message '{}'", mid);
				if !is_rating_id(&mid) {
					return Err(err!("{} is named something that is not a rating id.", what;
						Invalid, Input));
				}
				let ts = res!(time_of(m, &what));
				let rating = match m.get(&dat!("rating")) {
					Some(Dat::Map(rm))	=> res!(Rating::from_map(rm)),
					other			=> return Err(err!(
						"{}: rating is a rating record, and this one is {:?}.", what, other;
						Invalid, Input)),
				};
				Ok(Self::Rating(RatingLog { mid, ts, rating }))
			},
			"files_log" => {
				res!(only_keys("A files_log message", m, &["role", "mid", "ts", "prod", "delta"], &[]));
				let mid = res!(text_of(m, "A files_log message", "mid"));
				let what = fmt!("The files_log message '{}'", mid);
				let ts = res!(time_of(m, &what));
				let mut prod = Vec::new();
				match m.get(&dat!("prod")) {
					Some(Dat::List(rows))	=> for row in rows.iter() {
						match row {
							Dat::Map(pm)	=> {
								let p = res!(Prod::from_map(pm));
								if p.k != Kind::File {
									return Err(err!("{} holds a {} record, and it holds file \
										rows alone.", what, p.k.wire(); Invalid, Input));
								}
								prod.push(p);
							},
							other		=> return Err(err!(
								"{}: prod holds product records, and one is a {:?}.", what,
								other.kind(); Invalid, Input)),
						}
					},
					other			=> return Err(err!(
						"{}: prod is a list, and this one is {:?}.", what, other; Invalid, Input)),
				}
				let mut delta = Vec::new();
				match m.get(&dat!("delta")) {
					Some(Dat::List(rows))	=> for (i, row) in rows.iter().enumerate() {
						match row {
							Dat::Map(dm)	=> {
								let at = fmt!("{}: delta entry {}", what, i);
								res!(only_keys(&at, dm, &["h", "add", "del"], &[]));
								delta.push(FileDelta {
									h:	res!(text_of(dm, &at, "h")),
									add:	res!(whole_of(dm, &at, "add")),
									del:	res!(whole_of(dm, &at, "del")),
								});
							},
							other		=> return Err(err!(
								"{}: delta holds counts, and entry {} is a {:?}.", what, i,
								other.kind(); Invalid, Input)),
						}
					},
					other			=> return Err(err!(
						"{}: delta is a list, and this one is {:?}.", what, other; Invalid, Input)),
				}
				res!(delta_fits(&what, "reading", &prod, &delta));
				Ok(Self::Files(FilesLog { mid, ts, prod, delta }))
			},
			"user" => {
				res!(only_keys("A user message", m,
					&["role", "content", "mid", "ts", "iturn", "pre", "app"], &["iturn", "pre", "app"]));
				let mid = res!(text_of(m, "A user message", "mid"));
				let what = fmt!("The user message '{}'", mid);
				let opt = |k: &str| -> Outcome<String> {
					match m.get(&dat!(k)) {
						None	=> Ok(String::new()),
						Some(_)	=> {
							let v = res!(text_of(m, &what, k));
							// Absent is the no-note form, so an empty one would not survive a
							// round trip and is refused rather than quietly dropped.
							if v.is_empty() {
								return Err(err!("{} has an empty '{}', which is written as no \
									key.", what, k; Invalid, Input));
							}
							Ok(v)
						},
					}
				};
				// Present means true, since absent is how a person's own message reads.
				let app = match m.get(&dat!("app")) {
					None	=> false,
					Some(_)	=> {
						if !res!(bool_of(m, &what, "app")) {
							return Err(err!("{} has 'app' false, which is written as no key.", what;
								Invalid, Input));
						}
						true
					},
				};
				let pre = res!(opt("pre"));
				if app && !pre.is_empty() {
					return Err(err!("{} is the app's own and carries a note, and only a person's \
						message does.", what; Invalid, Input));
				}
				Ok(Self::User(UserLog {
					content: res!(text_of(m, &what, "content")),
					ts:      res!(time_of(m, &what)),
					iturn:   res!(opt("iturn")),
					pre,
					app,
					mid,
				}))
			},
			other => Err(err!("A chat message of role '{}' is not one this build reads; it reads \
				rating_log, files_log and user.", other; Invalid, Input)),
		}
	}

	pub fn from_json(s: &str) -> Outcome<Self> {
		Self::from_map(&res!(map_of(s, "A chat message")))
	}

	/// A chat's messages as the page writes the array: no whitespace, each in its own form.
	pub fn list_to_json(msgs: &[Self]) -> Outcome<String> {
		let mut parts = Vec::with_capacity(msgs.len());
		for m in msgs {
			parts.push(res!(m.to_json()));
		}
		Ok(fmt!("[{}]", parts.join(",")))
	}

	/// Read an array of messages, as `rating_u2.json` and `rating_u3.json` hold them.
	pub fn list_from_json(s: &str) -> Outcome<Vec<Self>> {
		let cfg = DecoderConfig::<(), ()>::json(None);
		let items = match res!(Dat::decode_string_with_config(s, &cfg)) {
			Dat::List(v)	=> v,
			other		=> return Err(err!(
				"A chat's messages are a JSON array, and this is a {:?}.", other.kind();
				Invalid, Input, Decode)),
		};
		let mut out = Vec::with_capacity(items.len());
		for (i, item) in items.iter().enumerate() {
			match item {
				Dat::Map(m)	=> out.push(res!(Self::from_map(m))),
				other		=> return Err(err!(
					"Message {} of the array is a {:?}, and a message is an object.", i,
					other.kind(); Invalid, Input)),
			}
		}
		Ok(out)
	}
}


// ┌───────────────────────────────────────────────────────────────┐
// │ Reading and writing the records                                │
// └───────────────────────────────────────────────────────────────┘

/// A string as the page's `JSON.stringify` writes it, quotes included (RFC 8785 section 3.2.2.2).
fn jstr(s: &str) -> Outcome<String> {
	Dat::Str(s.to_string()).json_canonical()
}

/// Decode `s` as one JSON object.
fn map_of(s: &str, what: &str) -> Outcome<DaticleMap> {
	let cfg = DecoderConfig::<(), ()>::json(None);
	match res!(Dat::decode_string_with_config(s, &cfg)) {
		Dat::Map(m)	=> Ok(m),
		other		=> Err(err!("{} is a JSON object, and this is a {:?}.", what, other.kind();
			Invalid, Input, Decode)),
	}
}

/// Refuse a record with a key its declaration does not name, or without one it does.  `keys` is
/// every key allowed and `optional` the ones that may be absent.
fn only_keys(what: &str, m: &DaticleMap, keys: &[&str], optional: &[&str]) -> Outcome<()> {
	for k in keys {
		if !optional.contains(k) && m.get(&dat!(*k)).is_none() {
			return Err(err!("{} has no '{}'; a record carries every key its declaration names.",
				what, k; Invalid, Input, Missing));
		}
	}
	for (k, _) in m.iter() {
		match k {
			Dat::Str(name) if keys.contains(&name.as_str())	=> {},
			other	=> return Err(err!(
				"{} carries a key {:?} that its declaration does not name; a record with an extra \
				key is refused, not read past.", what, other; Invalid, Input)),
		}
	}
	Ok(())
}

/// Does each count of a `files_log` belong to a row it holds, once, and to no gone file?  `phase` is
/// `"reading"` or `"writing"`, so that the message says which side refused.
fn delta_fits(what: &str, phase: &str, prod: &[Prod], delta: &[FileDelta]) -> Outcome<()> {
	for (i, d) in delta.iter().enumerate() {
		if d.add > BIG || d.del > BIG {
			return Err(err!("{} ({}): delta entry {} counts +{} -{}, and a page holds a whole \
				number only up to {}.", what, phase, i, d.add, d.del, BIG; Invalid, Input));
		}
		let row = match prod.iter().find(|p| p.h == d.h) {
			Some(p)	=> p,
			None	=> return Err(err!("{} ({}): delta entry {} names '{}', which is no row of \
				its prod; a count belongs to a row the message holds.", what, phase, i, d.h;
				Invalid, Input)),
		};
		if row.hash.is_empty() {
			return Err(err!("{} ({}): delta entry {} counts '{}', a file that is gone, and a \
				gone file has no count.", what, phase, i, d.h; Invalid, Input));
		}
		if delta[..i].iter().any(|e| e.h == d.h) {
			return Err(err!("{} ({}): delta entry {} counts '{}' a second time; each row has \
				one count at most.", what, phase, i, d.h; Invalid, Input));
		}
	}
	Ok(())
}

fn text_of(m: &DaticleMap, what: &str, k: &str) -> Outcome<String> {
	match m.get(&dat!(k)) {
		Some(Dat::Str(v))	=> Ok(v.clone()),
		other			=> Err(err!("{}: '{}' is a string, and this one is {:?}.", what, k, other;
			Invalid, Input)),
	}
}

fn bool_of(m: &DaticleMap, what: &str, k: &str) -> Outcome<bool> {
	match m.get(&dat!(k)) {
		Some(Dat::Bool(b))	=> Ok(*b),
		other			=> Err(err!("{}: '{}' is true or false, and this one is {:?}.", what, k,
			other; Invalid, Input)),
	}
}

/// A whole number from 0 to [`BIG`].
fn whole_of(m: &DaticleMap, what: &str, k: &str) -> Outcome<u64> {
	match m.get(&dat!(k)).and_then(|d| d.get_u64()) {
		Some(n) if n <= BIG	=> Ok(n),
		_			=> Err(err!("{}: '{}' is a whole number from 0 to {}, and this one is {:?}.",
			what, k, BIG, m.get(&dat!(k)); Invalid, Input)),
	}
}

/// A message's time: a whole number past 0, since a message with none is not one a page wrote.
fn time_of(m: &DaticleMap, what: &str) -> Outcome<u64> {
	match res!(whole_of(m, what, "ts")) {
		0	=> Err(err!("{} has no time: 'ts' is 0.", what; Invalid, Input, Missing)),
		n	=> Ok(n),
	}
}

fn int_of(m: &DaticleMap, what: &str, k: &str) -> Outcome<i64> {
	match m.get(&dat!(k)).and_then(|d| d.get_i64()) {
		Some(n)	=> Ok(n),
		None	=> Err(err!("{}: '{}' is a whole number, and this one is {:?}.", what, k,
			m.get(&dat!(k)); Invalid, Input)),
	}
}


#[cfg(test)]
#[path = "../tests/unit/rating/tests.rs"]
mod tests;
