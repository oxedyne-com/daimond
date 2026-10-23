//! THE MARKS RULE, owned by the engine (HIST-SAFE U2, 2026-10-12).
//!
//! What a Diamond may write was the caller's to say: `run_diamond_tool`, `steer_crystal` and
//! the Wire took `attached` and `read_only` from the page, so a mark withdrawn, or made
//! read-only, while a restore's question stood open was still written through when the
//! question was answered, and a page script that claimed a folder writable was believed (F5).
//! The rule now lives here, and every act asks it afresh: the rows a Diamond's sidecar holds,
//! this device's own record of which of them were pressed here (`daimond-marks-here`), the
//! workspace that is open, and the trash.
//!
//! A port of `www/js/markshere.js`'s decisions and of `Files.bounds` in `daimond.js`, which now
//! asks the engine rather than answering itself.  The storage edge -- the record read from
//! local storage, the root from the open folder -- is [`crate::wasm::marks`]; what is here is
//! pure, so the native suite tests it.

use crate::agent::compact::json_cfg;
use crate::diamond_link::Link;
use crate::diamond_link::Node;

use oxedyne_fe2o3_core::prelude::*;
use oxedyne_fe2o3_file::relpath::RelPath;
use oxedyne_fe2o3_jdat::Dat;
use oxedyne_fe2o3_jdat::map::DaticleMap;
use oxedyne_fe2o3_jdat::{FromDat, ToDat};

use std::collections::BTreeMap;


/// Where every Diamond keeps its record, per account (accounts.js prefixes it), never synced.
pub const KEY: &str = "daimond-marks-here";

/// Why a write, a delete or a worker's start is refused when this device's record cannot be read
/// (lead ruling, 2026-10-12): FAIL CLOSED.  Locked, unreadable, missing or damaged are all the same
/// answer -- never "nothing is pressed, so carry on", which a cold tab reading an unloaded store
/// would give.
pub const UNREAD: &str = "This device's record of the folders marked here could not be read -- \
	the account is locked, or this browser's storage could not be read, or the record is missing \
	or damaged -- so Daimond will not write or delete anything until it can. Unlock the account \
	and try again. Nothing was done.";

/// Is a share counted here only where it was pressed on this device as well?  Owner decision
/// O2; see `SHARE_NEEDS_PRESS_HERE` in markshere.js.
const SHARE_NEEDS_PRESS_HERE: bool = true;

/// The two default Diamonds' read-only sight of their folders (`DaimondMarksHere.seeds` in
/// daimond.js), in force in the browser workspace only and never a write or a share.
pub const SEEDS: [(&str, &str); 2] = [
	("0da1000000e1", "system/guide"),	// Daimond Help
	("0da1000000f2", "system/usage"),	// Daimond Optimiser
];


/// A reference taken apart: `kind:[browser]path` or `kind:[machine:name@devices]path`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Ref {
	pub kind:    String,
	pub root:    Option<String>,	// `browser`, `machine`, or none before roots were recorded
	pub name:    String,		// a machine folder's name
	pub devices: Vec<String>,
	pub path:    String,
}

/// The one parse of a reference (`parseRef`).  The path is kept exactly as written: whitespace
/// is a legal part of a folder name, so a trim made a mark on `" sp"` a grant on `sp` (U2 QA F1).
/// Whether it is a place is [`Ref::place`]'s question.
pub fn parse_ref(s: &str) -> Ref {
	let i = match s.find(':') {
		Some(i) if i > 0 => i,
		_                => return Ref::default(),
	};
	let kind = s[..i].to_string();
	let rest = &s[i + 1..];
	let head = |r: &str| -> Option<(String, Option<String>, usize)> {
		let body = match r.strip_prefix('[') {
			Some(b) => b,
			None    => return None,
		};
		let close = match body.find(']') {
			Some(c) => c,
			None    => return None,
		};
		let inner = &body[..close];
		let (root, name) = match inner.split_once(':') {
			Some((k, n)) => (k, Some(n.to_string())),
			None         => (inner, None),
		};
		match root {
			"browser" | "machine" => Some((root.to_string(), name, close + 2)),
			_                     => None,
		}
	};
	let (root, name, used) = match head(rest) {
		Some(h) => h,
		None    => return Ref { kind, path: rest.to_string(), ..Ref::default() },
	};
	let mut name = name.unwrap_or_default();
	let mut devices = Vec::new();
	// The devices a machine reference was made on, after the LAST `@`: hex ids of 16 or 32,
	// comma-separated.  An earlier `@` cannot start a match, since an id holds none.
	if let Some(at) = name.rfind('@') {
		let list: Vec<&str> = name[at + 1..].split(',').collect();
		let hex = |d: &str| (d.len() == 16 || d.len() == 32)
			&& d.chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c));
		if list.iter().all(|d| hex(d)) {
			devices = list.iter().map(|d| d.to_string()).collect();
			name.truncate(at);
		}
	}
	Ref { kind, root: Some(root), name, devices, path: rest[used..].to_string() }
}

impl Ref {
	/// The place this reference names, `None` where its path is not one canonical relative path
	/// (`code/../secret`, `/secret`, `secret/`, `./secret`, `" secret"`, ...).  THE ONE TEST OF A
	/// MARK'S PATH: [`fits`] asks it, so a damaged row or holding is neither in force nor waiting.
	pub fn place(&self) -> Option<RelPath> {
		RelPath::parse(&self.path).ok()
	}
}

/// A workspace as the record names it: `browser`, or `machine:<name>#<folder id>`.
#[derive(Clone, Debug, PartialEq)]
pub struct Root {
	pub machine: bool,
	pub name:    String,
	pub fid:     String,
}

fn is_hex(s: &str) -> bool {
	s.chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
}

/// The record's key for a workspace (`rootKey`).
pub fn root_key(machine: bool, name: &str, fid: &str) -> String {
	match machine {
		true  => fmt!("machine:{}#{}", name, fid),
		false => fmt!("browser"),
	}
}

/// A key taken apart at its LAST `#`, and only before a folder id (`rootOf`).
pub fn root_of(key: &str) -> Root {
	let rest = match key.strip_prefix("machine:") {
		Some(r) => r,
		None    => return Root { machine: false, name: String::new(), fid: String::new() },
	};
	if let Some(j) = rest.rfind('#') {
		let fid = &rest[j + 1..];
		if fid.len() == 32 && is_hex(fid) {
			return Root { machine: true, name: rest[..j].to_string(), fid: fid.to_string() };
		}
		if fid.is_empty() {
			return Root { machine: true, name: rest[..j].to_string(), fid: String::new() };
		}
	}
	Root { machine: true, name: rest.to_string(), fid: String::new() }
}

/// May a grant stand under this key?  The browser, or a machine folder with its id.
pub fn keyed(key: &str) -> bool {
	let r = root_of(key);
	match r.machine {
		false => key == "browser",
		true  => !r.fid.is_empty(),
	}
}

/// Is `path` `dir` or under it?
fn under(path: &str, dir: &str) -> bool {
	path == dir || (path.len() > dir.len() && path.starts_with(dir) && path.as_bytes()[dir.len()] == b'/')
}

/// Store paths, which follow no folder (`is_store_path` in tools.rs, `isStorePath`).
pub fn is_store_path(path: &str) -> bool {
	["diamonds", "mail", "chats", "system/agents", "system/guide", "system/usage", "system/journal"]
		.iter().any(|d| under(path, d))
}

/// Can a reference be opened from the workspace `key` names (`fits`)?  Only a reference to a
/// place: a path that is not canonical is damaged, and fails closed.
pub fn fits(r: &str, key: &str) -> bool {
	let p = parse_ref(r);
	if (p.kind != "file" && p.kind != "dir") || p.place().is_none() {
		return false;
	}
	reachable(&p, &root_of(key))
}

/// The same question for a parsed reference of a known kind (`refReachable`).
fn reachable(p: &Ref, r: &Root) -> bool {
	let root = match &p.root {
		None    => return true,
		Some(x) => x.as_str(),
	};
	if is_store_path(&p.path) {
		return true;
	}
	match (root, r.machine) {
		("browser", false) => true,
		("machine", true)  => p.name.is_empty() || p.name == r.name,
		_                  => false,
	}
}

/// One sidecar row as the rule reads it, with the Diamond whose sidecar holds it.
#[derive(Clone, Debug, PartialEq)]
pub struct Row {
	pub owner: String,
	pub id:    String,
	pub from:  String,
	pub to:    String,
	pub rel:   String,
	pub by:    String,
	pub share: bool,
}

impl Row {
	pub fn of(owner: &str, l: &Link) -> Self {
		Self {
			owner: owner.to_string(),
			id:    l.id.clone(),
			from:  l.from.to_ref(),
			to:    l.to.to_ref(),
			rel:   l.rel.clone(),
			by:    l.by.clone(),
			share: l.share,
		}
	}
}

/// Is `path` the Diamond `owner`'s own directory, or inside it?
pub fn in_own_dir(owner: &str, path: &str) -> bool {
	!owner.is_empty() && under(path, &fmt!("diamonds/{}", owner))
}

/// Is this row a mark at all (`isMark`): the user's (or an unsigned old) `holds` or `consulted`
/// on a file or a folder outside its own Diamond's directory?
pub fn is_mark(row: &Row) -> bool {
	if row.rel != "holds" && row.rel != "consulted" {
		return false;
	}
	if row.by != "user" && !row.by.is_empty() {
		return false;
	}
	let p = parse_ref(&row.to);
	(p.kind == "file" || p.kind == "dir") && !in_own_dir(&row.owner, &p.path)
}

/// Is this row stored as `owner`'s own, in its own sidecar and from its own end?
pub fn owned_by(owner: &str, row: &Row) -> bool {
	!owner.is_empty() && row.owner == owner && row.from == fmt!("diamond:{}", owner)
}

/// A Diamond's entry in this device's record: the row it was pressed for, and where.
#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
	pub id:    String,
	pub to:    String,
	pub rel:   String,
	pub share: bool,
	pub root:  String,
}

/// A chat's entry: the holding it was pressed for, and what it grants.
#[derive(Clone, Debug, PartialEq)]
pub struct ChatEntry {
	pub r:    String,	// the holding's ref
	pub path: String,
	pub ws:   bool,
	pub read: bool,
	pub root: String,
}

/// This device's record, as `readRecord` normalises it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Record {
	pub d: BTreeMap<String, Vec<Entry>>,
	pub c: BTreeMap<String, Vec<ChatEntry>>,
}

/// Is this a Diamond id the store mints (`generate_session_id`: hex)?
pub fn is_diamond_id(id: &str) -> bool {
	!id.is_empty() && is_hex(id)
}

/// A Diamond's id, validated once where it enters the engine, so no unchecked string can name the
/// directory a scope is composed on.  `""` named `diamonds/` -- every Diamond's home -- and
/// `<X>/../<Y>` normalised to Y's (QA B F2, 2026-10-12); neither is hex, so neither is one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiamondId(String);

impl DiamondId {

	/// The id, or a refusal naming what was given.
	pub fn parse(id: &str) -> Outcome<Self> {
		if is_diamond_id(id) {
			Ok(Self(id.to_string()))
		} else {
			Err(err!("'{}' is not a Diamond's id: an id is the hex the store mints.", id;
				Invalid, Input))
		}
	}

	pub fn as_str(&self) -> &str { &self.0 }

	/// Its own directory, `diamonds/<id>`.
	pub fn dir(&self) -> String { fmt!("diamonds/{}", self.0) }
}

// By hand, so a decoded id passes the same check as one parsed: a peer cannot name `diamonds/`
// or climb out of it with an id that never was one.
impl oxedyne_fe2o3_jdat::conv::ToDat for DiamondId {
	fn to_dat(&self) -> Outcome<Dat> {
		Ok(Dat::Str(self.0.clone()))
	}
}

impl oxedyne_fe2o3_jdat::conv::FromDat for DiamondId {
	fn from_dat(dat: Dat) -> Outcome<Self> {
		let id: String = res!(oxedyne_fe2o3_jdat::conv::FromDat::from_dat(dat));
		Self::parse(&id)
	}
}

impl std::fmt::Display for DiamondId {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		write!(f, "{}", self.0)
	}
}

/// Whose marks a turn's writes are held to, re-read at every call ([`crate::tools::ToolContext::live`]).
#[derive(Clone, Debug, PartialEq, ToDat, FromDat)]
pub enum Live {
	Diamond(DiamondId, Vec<String>),	// the Diamond, and its granted toolkit names
	Chat(String, Vec<Hold>),		// the chat, and its holdings as the page gave them
}

/// This device's record with the press of `owner`'s row `id` dropped, as stored text, or `None`
/// where the record is not one or holds no such entry.  The engine's `remove_link` calls it in
/// the same act as the row goes, so no press outlives its row to come back into force when a
/// sync merge returns the row (QA B F4, 2026-10-12).  Everything else in the record is kept as
/// it was read.
pub fn drop_entry(raw: &str, owner: &str, id: &str) -> Option<String> {
	let mut top = match Dat::decode_string_with_config(raw, &json_cfg()) {
		Ok(Dat::Map(m)) if is_one(m.get(&Dat::Str(fmt!("v")))) => m,
		_ => return None,
	};
	let dkey = Dat::Str(fmt!("d"));
	let mut d = match top.get(&dkey) {
		Some(Dat::Map(d)) => d.clone(),
		_                 => return None,
	};
	let okey = Dat::Str(owner.to_string());
	let list = match d.get(&okey) {
		Some(Dat::List(l)) => l.clone(),
		_                  => return None,
	};
	let kept: Vec<Dat> = list.iter().filter(|e| match e {
		Dat::Map(m) => text_of(m, "id").as_deref() != Some(id),
		_           => true,
	}).cloned().collect();
	if kept.len() == list.len() {
		return None;
	}
	if kept.is_empty() {
		d.remove(&okey);
	} else {
		d.insert(okey, Dat::List(kept));
	}
	top.insert(dkey, Dat::Map(d));
	Dat::Map(top).json().ok()
}

/// Is this a chat id the page mints: `c` and digits, or `c` and `newMid`'s three parts?
pub fn is_chat_id(id: &str) -> bool {
	let rest = match id.strip_prefix('c') {
		Some(r) => r,
		None    => return false,
	};
	if !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit()) {
		return true;
	}
	let parts: Vec<&str> = rest.split('-').collect();
	let word = |s: &str| s.chars().all(|c| c.is_ascii_digit() || c.is_ascii_lowercase());
	parts.len() == 3 && !parts[0].is_empty() && !parts[1].is_empty() && parts.iter().all(|p| word(p))
}

fn text_of(m: &DaticleMap, k: &str) -> Option<String> {
	match m.get(&Dat::Str(k.to_string())) {
		Some(Dat::Str(s)) => Some(s.clone()),
		_                 => None,
	}
}

fn bool_of(m: &DaticleMap, k: &str) -> bool {
	matches!(m.get(&Dat::Str(k.to_string())), Some(Dat::Bool(true)))
}

fn is_one(d: Option<&Dat>) -> bool {
	matches!(d,
		Some(Dat::U8(1)) | Some(Dat::U16(1)) | Some(Dat::U32(1)) | Some(Dat::U64(1))
		| Some(Dat::U128(1)) | Some(Dat::I8(1)) | Some(Dat::I16(1)) | Some(Dat::I32(1))
		| Some(Dat::I64(1)) | Some(Dat::I128(1)))
}

/// A stored record, normalised, or `None` where it is not one.  An entry that is not well
/// formed, under a key that is not an id, or under a root that is not keyed is dropped, which
/// errs towards waiting.
pub fn read_record(raw: &str) -> Option<Record> {
	let top = match Dat::decode_string_with_config(raw, &json_cfg()) {
		Ok(Dat::Map(m)) => m,
		_               => return None,
	};
	if !is_one(top.get(&Dat::Str(fmt!("v")))) {
		return None;
	}
	let mut rec = Record::default();
	if let Some(Dat::Map(d)) = top.get(&Dat::Str(fmt!("d"))) {
		for (k, v) in d.iter() {
			let (key, list) = match (k, v) {
				(Dat::Str(key), Dat::List(list)) if is_diamond_id(key) => (key, list),
				_ => continue,
			};
			for e in list {
				let m = match e { Dat::Map(m) => m, _ => continue };
				let (id, to, root, rel) = match (text_of(m, "id"), text_of(m, "to"),
					text_of(m, "root"), text_of(m, "rel")) {
					(Some(a), Some(b), Some(c), Some(r)) => (a, b, c, r),
					_ => continue,
				};
				if (rel != "holds" && rel != "consulted") || !keyed(&root) {
					continue;
				}
				rec.d.entry(key.clone()).or_default()
					.push(Entry { id, to, rel, share: bool_of(m, "share"), root });
			}
		}
	}
	if let Some(Dat::Map(c)) = top.get(&Dat::Str(fmt!("c"))) {
		for (k, v) in c.iter() {
			let (key, list) = match (k, v) {
				(Dat::Str(key), Dat::List(list)) if is_chat_id(key) => (key, list),
				_ => continue,
			};
			for e in list {
				let m = match e { Dat::Map(m) => m, _ => continue };
				let (r, path, root) = match (text_of(m, "ref"), text_of(m, "path"), text_of(m, "root")) {
					(Some(a), Some(b), Some(c)) => (a, b, c),
					_ => continue,
				};
				let (ws, read) = (bool_of(m, "ws"), bool_of(m, "read"));
				if (!ws && !read) || !keyed(&root) {
					continue;
				}
				rec.c.entry(key.clone()).or_default().push(ChatEntry { r, path, ws, read, root });
			}
		}
	}
	Some(rec)
}

/// Where the trash is kept, per account (`trash.js`).
pub const TRASH_KEY: &str = "daimond-trash";

pub(crate) fn num(d: Option<&Dat>) -> f64 {
	match d {
		Some(Dat::U8(n))   => *n as f64,
		Some(Dat::U16(n))  => *n as f64,
		Some(Dat::U32(n))  => *n as f64,
		Some(Dat::U64(n))  => *n as f64,
		Some(Dat::U128(n)) => *n as f64,
		Some(Dat::I8(n))   => *n as f64,
		Some(Dat::I16(n))  => *n as f64,
		Some(Dat::I32(n))  => *n as f64,
		Some(Dat::I64(n))  => *n as f64,
		Some(Dat::I128(n)) => *n as f64,
		Some(Dat::F32(n))  => n.0 as f64,
		Some(Dat::F64(n))  => n.0,
		_                  => 0.0,
	}
}

/// The ids in the trash right now, from its stored text: `items[id].at > items[id].back`
/// (`DaimondTrash.has`).  `None` for text that is there but is not a trash record: a damaged
/// trash read as empty brought every trashed Diamond's marks back into force (QA A F2).
pub fn trashed_ids(raw: &str) -> Option<Vec<String>> {
	let top = match Dat::decode_string_with_config(raw, &json_cfg()) {
		Ok(Dat::Map(m)) => m,
		_               => return None,
	};
	let items = match top.get(&Dat::Str(fmt!("items"))) {
		Some(Dat::Map(m)) => m,
		None              => return Some(Vec::new()),	// a trash never written to
		Some(_)           => return None,
	};
	// An entry that is there but is not one -- `at` as a string, the entry a bare word --
	// damages the whole record, as a damaged record does: dropping it read a trashed
	// Diamond as live (U2 QA F3). Absent `at` or `back` is a Diamond never trashed or restored.
	let stamp = |r: &DaticleMap, k: &str| match r.get(&Dat::Str(k.to_string())) {
		None    => Some(0.0),
		Some(d) => match d {
			Dat::U8(_) | Dat::U16(_) | Dat::U32(_) | Dat::U64(_) | Dat::U128(_)
			| Dat::I8(_) | Dat::I16(_) | Dat::I32(_) | Dat::I64(_) | Dat::I128(_)
			| Dat::F32(_) | Dat::F64(_) => Some(num(Some(d))),
			_                           => None,
		},
	};
	let mut out = Vec::new();
	for (k, v) in items.iter() {
		let (id, r) = match (k, v) {
			(Dat::Str(id), Dat::Map(r)) => (id, r),
			_                           => return None,
		};
		match (stamp(r, "at"), stamp(r, "back")) {
			(Some(at), Some(back)) => if at > back { out.push(id.clone()); },
			_                      => return None,
		}
	}
	Some(out)
}

/// A grant in force here.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Grant {
	pub holds: bool,	// written to; else consulted
	pub share: bool,
}

/// Is this one of the two default Diamonds' seeded folders, in the browser workspace?
pub fn seeded(owner: &str, row: &Row, root: &str) -> bool {
	if root != "browser" {
		return false;
	}
	let p = parse_ref(&row.to);
	if p.kind != "dir" || p.root.as_deref().is_some_and(|r| r != "browser") {
		return false;
	}
	SEEDS.iter().any(|(o, path)| *o == owner && p.path == *path)
}

/// THE TEST OF A DIAMOND'S GRANT HERE (`force`): the grant where `row` is in force on this
/// device in the workspace `root`, `None` where it is not.
pub fn force(rec: &Record, owner: &str, row: &Row, root: &str) -> Option<Grant> {
	if !is_mark(row) || !owned_by(owner, row) || !fits(&row.to, root) {
		return None;
	}
	if let Some(list) = rec.d.get(owner) {
		for e in list {
			if e.id != row.id || e.to != row.to || e.root != root {
				continue;
			}
			return Some(Grant {
				holds: e.rel == "holds" && row.rel == "holds",
				share: row.share && (!SHARE_NEEDS_PRESS_HERE || e.share),
			});
		}
	}
	match seeded(owner, row, root) {
		true  => Some(Grant { holds: false, share: false }),
		false => None,
	}
}

/// Is this a mark of `owner`'s, not in force here, that one press here would bring in?
pub fn waiting(rec: &Record, owner: &str, row: &Row, root: &str) -> bool {
	is_mark(row) && owned_by(owner, row) && fits(&row.to, root) && force(rec, owner, row, root).is_none()
}

/// A chat holding as the page keeps it: its ref and path, the workspace mark, and Read.
#[derive(Clone, Debug, Default, PartialEq, ToDat, FromDat)]
pub struct Hold {
	pub r:    String,
	pub path: String,
	pub ws:   bool,
	pub read: bool,
}

/// A chat's holdings as the page keeps them, `[{ref, path, ws, state}]`; what does not read as
/// one is dropped, which grants nothing.
pub fn parse_holds(json: &str) -> Vec<Hold> {
	let list = match Dat::decode_string_with_config(json, &json_cfg()) {
		Ok(Dat::List(l)) => l,
		_                => return Vec::new(),
	};
	list.iter().filter_map(|h| match h {
		Dat::Map(m) => match (text_of(m, "ref"), text_of(m, "path")) {
			(Some(r), Some(path)) => Some(Hold {
				r,
				path,
				ws:   bool_of(m, "ws"),
				read: text_of(m, "state").as_deref() == Some("read"),
			}),
			_ => None,
		},
		_ => None,
	}).collect()
}

/// A chat holding's grant here, `(ws, read)`, or `None` (`chatForce`).
pub fn chat_force(rec: &Record, chat: &str, a: &Hold, root: &str) -> Option<(bool, bool)> {
	if parse_ref(&a.r).path != a.path || !fits(&a.r, root) {
		return None;
	}
	for e in rec.c.get(chat).map(|l| l.as_slice()).unwrap_or(&[]) {
		if e.r != a.r || e.path != a.path || e.root != root {
			continue;
		}
		let (ws, read) = (a.ws && e.ws, a.read && e.read);
		return match ws || read {
			true  => Some((ws, read)),
			false => None,
		};
	}
	None
}

/// Does this holding claim a workspace mark or a Read not in force here (`chatWaiting`)?
pub fn chat_waiting(rec: &Record, chat: &str, a: &Hold, root: &str) -> bool {
	if parse_ref(&a.r).path != a.path || !fits(&a.r, root) {
		return false;
	}
	let (ws, read) = chat_force(rec, chat, a, root).unwrap_or((false, false));
	(a.ws && !ws) || (a.read && !read)
}

/// What a Diamond reaches here: the three lists `diamond_bounds` takes beside its own
/// directory, and the marks waiting for a press.
#[derive(Clone, Debug, Default, PartialEq, ToDat, FromDat)]
pub struct Reach {
	pub attached:    Vec<String>,
	pub read_only:   Vec<String>,
	pub unconfirmed: Vec<String>,
	pub nested:      Vec<String>,	// in force, drawn as an attached ancestor
}

impl Reach {
	/// Every place a turn's bounds name: the attached marks, then the marks in force inside one.
	///
	/// A nested mark adds no reach -- its ancestor already allows everything beneath it -- but it
	/// is still a mark, and a mark's own root is neither deleted nor moved by a model's turn
	/// (`tools::mark_root_refusal`, which reads the bounds). Drawn once as the folder, so it is
	/// not in `attached`; dropped from the bounds as well, `vault/pinned.md` under a marked
	/// `vault` was deleted (filedelete H6, deletekeep F7, r560histsafe2 12 Oct 2026). Its
	/// read-only grant still yields to the ancestor's, as the page has always drawn it.
	pub fn places(&self) -> Vec<String> {
		let mut v = self.attached.clone();
		v.extend(self.nested.iter().cloned());
		v
	}

	/// A chat's reach: its workspace marks in force, and those waiting for a press.  A chat has
	/// no read-only grant and no nested mark of its own (`wasm::marks::chat_reach`).
	pub fn of_chat(ws: Vec<String>, wait: Vec<String>) -> Self {
		Self {
			attached:    ws,
			unconfirmed: wait,
			..Default::default()
		}
	}
}

/// THE ONE COMPOSITION OF A DIAMOND'S REACH (`attachmentsOf` and `Files.bounds`).
///
/// # Arguments
/// * `links` - Every link touching `diamond:<id>`, each with the Diamond whose sidecar holds it.
/// * `trashed` - Is this Diamond in the trash?
pub fn reach<F: Fn(&str) -> bool>(
	rec:     &Record,
	id:      &str,
	links:   &[(String, Link)],
	root:    &str,
	trashed: F,
)
	-> Reach
{
	let mut out = Reach::default();
	if id.is_empty() || trashed(id) {
		return out;
	}
	let me = Node { kind: fmt!("diamond"), rest: id.to_string() };
	let own = fmt!("diamonds/{}", id);
	let here = root_of(root);
	// (path, kind:path, force, reachable, waiting), deduplicated on the thing.
	let mut rows: Vec<(String, String, Option<Grant>, bool, bool)> = Vec::new();
	for (owner, l) in links {
		let other = match l.other(&me) {
			Some(n) => n.to_ref(),
			None    => continue,
		};
		let p = parse_ref(&other);
		// Only a place is a row: the bounds normalise what they are given, so `code/../secret`,
		// nested under `code` by its prefix, would reach `secret`. `force` and `waiting` already
		// refuse such a row through `fits`; it is left out here as well so a damaged row is not
		// even a candidate beside a sound one of the same thing.
		if (p.kind != "file" && p.kind != "dir") || p.place().is_none() || under(&p.path, &own) {
			continue;
		}
		// A door onto a Diamond in the trash is shut.
		if let Some(rest) = p.path.strip_prefix("diamonds/") {
			let d = rest.split('/').next().unwrap_or("");
			if trashed(d) {
				continue;
			}
		}
		let row = Row::of(owner, l);
		// A mark not stored as THIS Diamond's own is never its mark (R2).
		if is_mark(&row) && !owned_by(id, &row) {
			continue;
		}
		let fz = force(rec, id, &row, root);
		let wait = !trashed(&row.owner) && waiting(rec, &row.owner, &row, root);
		let cand = (p.path.clone(), fmt!("{}:{}", p.kind, p.path), fz, reachable(&p, &here), wait);
		let rank = |c: &(String, String, Option<Grant>, bool, bool)|
			if c.2.is_some() { 2 } else if c.3 { 1 } else { 0 };
		match rows.iter().position(|r| r.1 == cand.1) {
			Some(at) => if rank(&cand) > rank(&rows[at]) { rows[at] = cand; },
			None     => rows.push(cand),
		}
	}
	// A path under an attached ANCESTOR is not a second entry: the folder already says
	// it is there (`attachmentsOf`). Sorted, an ancestor comes before what it holds. Not
	// under an ancestor that only waits here, though: a mark in force on this device
	// inside one that is not is the grant this device HAS, and dropping it would take it
	// out of the fence.
	rows.sort_by(|a, b| a.0.cmp(&b.0));
	let covered: Vec<bool> = rows.iter().enumerate().map(|(i, a)|
		rows[..i].iter().any(|b| under(&a.0, &b.0) && (b.2.is_some() || a.2.is_none()))
	).collect();
	for ((path, _, fz, _, wait), gone) in rows.into_iter().zip(covered) {
		if gone {
			if fz.is_some() {
				out.nested.push(path);
			}
			continue;
		}
		if let Some(g) = fz {
			out.attached.push(path.clone());
			if !g.holds {
				out.read_only.push(path.clone());
			}
		}
		if wait {
			out.unconfirmed.push(path);
		}
	}
	out
}


#[cfg(test)]
mod tests {
	use super::*;

	const D: &str = "0da1";
	const FID: &str = "0123456789abcdef0123456789abcdef";

	fn link(owner_from: &str, to: &str, rel: &str, by: &str) -> Link {
		let l = fmt!("{{\"id\":\"l1\",\"from\":\"diamond:{}\",\"to\":\"{}\",\"rel\":\"{}\",\"by\":\"{}\"}}",
			owner_from, to, rel, by);
		Link::from_json(&l).unwrap_or_else(|| panic!("link {}", l))
	}

	fn rec(rel: &str, root: &str) -> Record {
		let raw = fmt!("{{\"v\":1,\"d\":{{\"{}\":[{{\"id\":\"l1\",\"to\":\"dir:[browser]proj\",\
			\"rel\":\"{}\",\"root\":\"{}\"}}]}}}}", D, rel, root);
		read_record(&raw).unwrap_or_else(|| panic!("record {}", raw))
	}

	#[test]
	fn marks_parse_ref_takes_devices_off_the_name() {
		let p = parse_ref("dir:[machine:my@usr@0123456789abcdef]books/x");
		assert_eq!((p.kind.as_str(), p.root.as_deref(), p.name.as_str(), p.path.as_str()),
			("dir", Some("machine"), "my@usr", "books/x"));
		assert_eq!(p.devices, vec![fmt!("0123456789abcdef")]);
		let q = parse_ref("file:notes.md");
		assert_eq!((q.root, q.path.as_str()), (None, "notes.md"));
	}

	#[test]
	fn marks_root_keys_need_a_folder_id() {
		assert!(keyed("browser"));
		assert!(keyed(&fmt!("machine:usr#{}", FID)));
		assert!(!keyed("machine:usr#"));
		assert!(!keyed("machine:usr"));
		assert_eq!(root_of(&fmt!("machine:a#b#{}", FID)).name, "a#b");
	}

	#[test]
	fn marks_reach_is_the_pressed_mark_only() {
		let links = vec![(D.to_string(), link(D, "dir:[browser]proj", "holds", "user"))];
		let none = |_: &str| false;
		// Pressed here: written to.
		let r = reach(&rec("holds", "browser"), D, &links, "browser", none);
		assert_eq!((r.attached.clone(), r.read_only.clone()), (vec![fmt!("proj")], vec![]));
		// Made read-only here: consulted.
		let r = reach(&rec("consulted", "browser"), D, &links, "browser", none);
		assert_eq!((r.attached.clone(), r.read_only.clone()), (vec![fmt!("proj")], vec![fmt!("proj")]));
		// Not pressed here: nothing in force, and it waits.
		let r = reach(&Record::default(), D, &links, "browser", none);
		assert_eq!((r.attached.is_empty(), r.unconfirmed.clone()), (true, vec![fmt!("proj")]));
		// Pressed in another workspace: nothing.
		let r = reach(&rec("holds", &fmt!("machine:usr#{}", FID)), D, &links, "browser", none);
		assert!(r.attached.is_empty());
		// Trashed: nothing at all.
		let r = reach(&rec("holds", "browser"), D, &links, "browser", |d: &str| d == D);
		assert_eq!(r, Reach::default());
	}

	#[test]
	fn marks_reach_refuses_rows_not_the_users_or_not_its_own() {
		let none = |_: &str| false;
		let model = vec![(D.to_string(), link(D, "dir:[browser]proj", "holds", "agent:x"))];
		assert!(reach(&rec("holds", "browser"), D, &model, "browser", none).attached.is_empty());
		// Kept in another Diamond's sidecar: never this one's mark.
		let other = vec![(fmt!("beef"), link(D, "dir:[browser]proj", "holds", "user"))];
		assert!(reach(&rec("holds", "browser"), D, &other, "browser", none).attached.is_empty());
	}

	#[test]
	fn marks_reach_draws_a_path_under_an_attached_folder_once() {
		let none = |_: &str| false;
		let mk = |id: &str, to: &str| {
			let l = fmt!("{{\"id\":\"{}\",\"from\":\"diamond:{}\",\"to\":\"{}\",\"rel\":\"holds\",\"by\":\"user\"}}",
				id, D, to);
			(D.to_string(), Link::from_json(&l).unwrap_or_else(|| panic!("link {}", l)))
		};
		let pressed = |ids: &[(&str, &str)]| {
			let es: Vec<String> = ids.iter().map(|(id, to)|
				fmt!("{{\"id\":\"{}\",\"to\":\"{}\",\"rel\":\"holds\",\"root\":\"browser\"}}", id, to)).collect();
			let raw = fmt!("{{\"v\":1,\"d\":{{\"{}\":[{}]}}}}", D, es.join(","));
			read_record(&raw).unwrap_or_else(|| panic!("record {}", raw))
		};
		let links = vec![
			mk("l2", "file:[browser]code/nested.rs"),
			mk("l1", "dir:[browser]code"),
			mk("l3", "file:[browser]misc/ghost.txt"),
		];
		let all = [("l1", "dir:[browser]code"), ("l2", "file:[browser]code/nested.rs"),
			("l3", "file:[browser]misc/ghost.txt")];
		// Under a folder in force here: drawn once, as the folder.
		let r = reach(&pressed(&all), D, &links, "browser", none);
		assert_eq!(r.attached, vec![fmt!("code"), fmt!("misc/ghost.txt")]);
		// But still a mark of its own, whose own root the bounds guard (filedelete H6).
		assert_eq!(r.nested, vec![fmt!("code/nested.rs")]);
		assert_eq!(r.places(), vec![fmt!("code"), fmt!("misc/ghost.txt"), fmt!("code/nested.rs")]);
		// In force here under a folder that only waits: kept, it is the grant this device has.
		let r = reach(&pressed(&all[1..]), D, &links, "browser", none);
		assert_eq!((r.attached.clone(), r.unconfirmed.clone()),
			(vec![fmt!("code/nested.rs"), fmt!("misc/ghost.txt")], vec![fmt!("code")]));
		assert!(r.nested.is_empty());
		// Waiting under a folder that waits too: one ask, for the folder.
		let r = reach(&pressed(&all[2..]), D, &links, "browser", none);
		assert_eq!((r.attached.clone(), r.unconfirmed.clone()),
			(vec![fmt!("misc/ghost.txt")], vec![fmt!("code")]));
	}

	#[test]
	fn marks_reach_places_never_leave_the_attached_folder() {
		// Every place is a canonical workspace path, and a nested one sits inside an attached
		// folder AS THE BOUNDS READ IT: `diamond_bounds` normalises, so `code/../secret`, drawn
		// as nested under `code` by the string prefix, would become a grant on `secret`.
		// OPFS has no symlinks, so here the rule is the path's; the hand refuses a symlink
		// escape itself (hand/src/fence.rs, a_symlink_escape_is_refused_by_the_kernel).
		let none = |_: &str| false;
		let tos = ["dir:[browser]code", "file:[browser]", "file:[browser]code/../secret",
			"dir:[browser]code/..", "file:[browser]code/./a.rs", "file:[browser]code//b.rs",
			"file:[browser]/etc/passwd", "file:[browser]../x", "file:[browser]code\\..\\y",
			"file:[browser]code/ok.rs"];
		let links: Vec<(String, Link)> = tos.iter().enumerate().map(|(i, to)| {
			let l = fmt!("{{\"id\":\"l{}\",\"from\":\"diamond:{}\",\"to\":\"{}\",\"rel\":\"holds\",\"by\":\"user\"}}",
				i, D, to.replace('\\', "\\\\"));
			(D.to_string(), Link::from_json(&l).unwrap_or_else(|| panic!("link {}", l)))
		}).collect();
		let es: Vec<String> = tos.iter().enumerate().map(|(i, to)|
			fmt!("{{\"id\":\"l{}\",\"to\":\"{}\",\"rel\":\"holds\",\"root\":\"browser\"}}",
				i, to.replace('\\', "\\\\"))).collect();
		let raw = fmt!("{{\"v\":1,\"d\":{{\"{}\":[{}]}}}}", D, es.join(","));
		let rec = read_record(&raw).unwrap_or_else(|| panic!("record {}", raw));
		let r = reach(&rec, D, &links, "browser", none);
		for p in r.places() {
			assert!(!p.is_empty() && crate::tools::normalise(&p) == p,
				"a place that is not a canonical workspace path: {:?} in {:?}", p, r);
		}
		for n in &r.nested {
			assert!(r.attached.iter().any(|a| under(&crate::tools::normalise(n), a)),
				"nested {:?} is outside every attached folder {:?}", n, r.attached);
		}
		// The well-formed marks are untouched.
		assert_eq!((r.attached.clone(), r.nested.clone()), (vec![fmt!("code")], vec![fmt!("code/ok.rs")]));
	}

	#[test]
	fn marks_seeds_are_read_only_in_the_browser_only() {
		let h = "0da1000000e1";
		let links = vec![(h.to_string(), link(h, "dir:[browser]system/guide", "holds", "user"))];
		let r = reach(&Record::default(), h, &links, "browser", |_: &str| false);
		assert_eq!((r.attached.clone(), r.read_only.clone()),
			(vec![fmt!("system/guide")], vec![fmt!("system/guide")]));
		let r = reach(&Record::default(), h, &links, &fmt!("machine:usr#{}", FID), |_: &str| false);
		assert!(r.read_only.is_empty());
	}

	#[test]
	fn marks_read_record_drops_what_is_not_well_formed() {
		assert!(read_record("{\"v\":2}").is_none());
		assert!(read_record("not json").is_none());
		let raw = "{\"v\":1,\"d\":{\"zz\":[{\"id\":\"a\",\"to\":\"dir:x\",\"rel\":\"holds\",\"root\":\"browser\"}],\
			\"ab\":[{\"id\":\"a\",\"to\":\"dir:x\",\"rel\":\"produced\",\"root\":\"browser\"},\
			{\"id\":\"b\",\"to\":\"dir:x\",\"rel\":\"holds\",\"root\":\"machine:usr#\"}]},\
			\"c\":{\"c12\":[{\"ref\":\"dir:[browser]p\",\"path\":\"p\",\"ws\":true,\"root\":\"browser\"}]}}";
		let r = read_record(raw).unwrap_or_default();
		assert!(r.d.is_empty());
		let h = Hold { r: fmt!("dir:[browser]p"), path: fmt!("p"), ws: true, read: false };
		assert_eq!(chat_force(&r, "c12", &h, "browser"), Some((true, false)));
		assert_eq!(chat_force(&r, "c13", &h, "browser"), None);
		assert!(chat_waiting(&r, "c13", &h, "browser"));
		let hs = parse_holds("[{\"ref\":\"dir:[browser]p\",\"path\":\"p\",\"ws\":true,\"state\":\"note\"},7]");
		assert_eq!(hs, vec![h.clone()]);
		assert!(is_chat_id("c1a-2b-") && is_chat_id("c12") && !is_chat_id("constructor"));
	}

	#[test]
	fn marks_trash_is_at_after_back() {
		let raw = "{\"items\":{\"aa\":{\"k\":\"d\",\"at\":1760000000000,\"back\":0},\
			\"bb\":{\"k\":\"d\",\"at\":5,\"back\":9}}}";
		assert_eq!(trashed_ids(raw), Some(vec![fmt!("aa")]));
		assert_eq!(trashed_ids("{}"), Some(Vec::new()));
		for bad in ["", "{\"items\":{", "null", "[]", "{\"items\":[]}", "{\"items\":7}"] {
			assert_eq!(trashed_ids(bad), None, "{:?} read as a trash record", bad);
		}
	}

	#[test]
	fn marks_diamond_id_refuses_what_is_not_one() {
		for bad in ["", "/", "..", "0da1/../0db2", "0DA1", "0da1 ", "diamonds/0da1"] {
			assert!(DiamondId::parse(bad).is_err(), "{:?} was taken as an id", bad);
		}
		match DiamondId::parse("0da1") {
			Ok(id) => assert_eq!(id.dir(), "diamonds/0da1"),
			Err(e) => panic!("{}", e),
		}
	}

	#[test]
	fn marks_drop_entry_drops_the_press_and_keeps_the_rest() {
		let raw = "{\"v\":1,\"d\":{\"0da1\":[{\"id\":\"a\",\"to\":\"dir:x\",\"rel\":\"holds\",\"root\":\"browser\"},\
			{\"id\":\"b\",\"to\":\"dir:y\",\"rel\":\"consulted\",\"root\":\"browser\",\"share\":true}],\
			\"0db2\":[{\"id\":\"a\",\"to\":\"dir:z\",\"rel\":\"holds\",\"root\":\"browser\"}]},\
			\"c\":{\"c12\":[{\"ref\":\"dir:[browser]p\",\"path\":\"p\",\"ws\":true,\"root\":\"browser\"}]}}";
		let out = drop_entry(raw, "0da1", "a").unwrap_or_default();
		let r = read_record(&out).unwrap_or_default();
		let ids = |k: &str| r.d.get(k).map(|l| l.iter().map(|e| e.id.clone()).collect::<Vec<_>>());
		assert_eq!(ids("0da1"), Some(vec![fmt!("b")]));
		assert_eq!(ids("0db2"), Some(vec![fmt!("a")]));
		assert!(r.d.get("0da1").map(|l| l[0].share).unwrap_or(false));
		assert_eq!(r.c.get("c12").map(|l| l.len()), Some(1));
		// The last press of an owner takes its key with it; an id not there changes nothing.
		let out2 = drop_entry(&out, "0da1", "b").unwrap_or_default();
		assert!(read_record(&out2).map(|r| !r.d.contains_key("0da1")).unwrap_or(false));
		assert!(drop_entry(&out2, "0da1", "b").is_none());
		assert!(drop_entry("not json", "0da1", "a").is_none());
	}


	/// PATHTYPE (R3, D-20261012-07): a mark's path is kept exactly as written, and only a
	/// canonical one is a place. A trim let a mark on the real folder `" sp"` go into force as
	/// `sp` (HIST-SAFE U2 post-deploy QA F1, arm C1x).
	#[test]
	fn marks_a_path_is_kept_exactly_and_only_a_canonical_one_is_a_place() {
		let none = |_: &str| false;
		let mut bad = Vec::new();
		for (r, want) in [("dir:[browser] sp", " sp"), ("dir:secret ", "secret ")] {
			if parse_ref(r).path != want {
				bad.push(fmt!("parse_ref({:?}).path = {:?}", r, parse_ref(r).path));
			}
		}
		for to in ["dir:[browser] sp", "dir:[browser] secret", "dir:[browser]secret ",
			"dir:[browser]\tsecret"]
		{
			let js = to.replace('\t', "\\t");
			let l = fmt!("{{\"id\":\"l1\",\"from\":\"diamond:{}\",\"to\":\"{}\",\"rel\":\"holds\",\"by\":\"user\"}}",
				D, js);
			let links = vec![(D.to_string(), Link::from_json(&l).unwrap_or_else(|| panic!("link {}", l)))];
			let raw = fmt!("{{\"v\":1,\"d\":{{\"{}\":[{{\"id\":\"l1\",\"to\":\"{}\",\"rel\":\"holds\",\"root\":\"browser\"}}]}}}}",
				D, js);
			let rec = read_record(&raw).unwrap_or_else(|| panic!("record {}", raw));
			let r = reach(&rec, D, &links, "browser", none);
			if !r.places().is_empty() || !r.unconfirmed.is_empty() {
				bad.push(fmt!("the mark {:?} reached {:?}", to, r));
			}
			if fits(to, "browser") {
				bad.push(fmt!("{:?} fits as a place", to));
			}
		}
		assert!(bad.is_empty(), "{} case(s):\n{}", bad.len(), bad.join("\n"));
	}

	/// PATHTYPE: a chat holding is in force only on a canonical path (HIST-SAFE U2 post-deploy
	/// QA F2, arm C2x: these four let a chat write `secret/c1..c4.txt`).
	#[test]
	fn marks_a_chat_holding_is_in_force_only_on_a_canonical_path() {
		let chat = "c1";
		let hold = |path: &str| {
			let r = fmt!("dir:[browser]{}", path);
			let mut rec = Record::default();
			rec.c.insert(chat.to_string(), vec![ChatEntry { r: r.clone(), path: path.to_string(),
				ws: true, read: false, root: fmt!("browser") }]);
			(rec, Hold { r, path: path.to_string(), ws: true, read: false })
		};
		let mut bad = Vec::new();
		for path in ["chatc/../secret", "/secret", "secret/", "./secret", " secret", "secret ",
			"\tsecret", ".", "chatc/..", "chatc//x", "a\\b"]
		{
			let (rec, a) = hold(path);
			if chat_force(&rec, chat, &a, "browser").is_some() {
				bad.push(fmt!("{:?} is in force", path));
			}
			if chat_waiting(&rec, chat, &a, "browser") {
				bad.push(fmt!("{:?} waits for a press", path));
			}
		}
		assert!(bad.is_empty(), "{} case(s):\n{}", bad.len(), bad.join("\n"));
		let (rec, a) = hold("chatc");
		assert_eq!(chat_force(&rec, chat, &a, "browser"), Some((true, false)));
	}

	/// PATHTYPE LOW (HIST-SAFE U2 post-deploy QA F3): an entry that is there but is not a trash
	/// entry damages the record (UNREAD), as a damaged record does; it is never read as live.
	#[test]
	fn marks_a_malformed_trash_entry_is_a_damaged_trash() {
		for bad in ["{\"items\":{\"aa\":{\"at\":\"1760000000000\"}}}", "{\"items\":{\"aa\":\"trashed\"}}",
			"{\"items\":{\"aa\":{\"at\":1760000000000,\"back\":\"0\"}}}", "{\"items\":{\"aa\":7}}"]
		{
			assert_eq!(trashed_ids(bad), None, "{:?} read as a trash record: {:?}", bad, trashed_ids(bad));
		}
		// An entry restored, or never trashed, is still well formed.
		assert_eq!(trashed_ids("{\"items\":{\"aa\":{\"k\":\"d\",\"at\":5,\"back\":9},\"bb\":{\"k\":\"d\"}}}"),
			Some(Vec::new()));
	}
}
