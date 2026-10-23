//! The wire's own forms of the port's values: every body as a [`BodyRef`] (spec §16.3a).
//!
//! The port keeps `Vec<u8>` and `Body::Held`; the wire never carries a body but in a `body_put`
//! chunk or a `body_get` answer.  [`refer`](WireChange::refer) turns a port value into its wire
//! form, and `resolve` turns it back, fetching each named body through the caller's `get`, which
//! is `RemoteStore`'s `body_get` (D1r3) or the store's own staged uploads (D1v3).

use crate::{
    diamond_link::{Link, LinksPage, PageLink, Unlink},
    diamond_versions::{
        hash_of, is_hash, Body, BodyRef, Carried, Change, Found, Prior, Seen, Stamp, TurnFound,
        TurnSaid,
        VERSION_FILE_MAX,
    },
    engine::host::types::store::{JournalKey, Standing, Wants},
    rating::Author,
};

use oxedyne_fe2o3_core::prelude::*;
use oxedyne_fe2o3_jdat::prelude::*;


// ┌───────────────────────────────────────────────────────────────┐
// │ Hashes                                                         │
// └───────────────────────────────────────────────────────────────┘

/// A body's hash on the wire: 64 lowercase hex digits ([`is_hash`]) and nothing else, sent or
/// read (d1k2 check D2).  Every hash a `Seen`, a `BodyRef` or a `Found` names crosses as one,
/// so `WANT_ENTRY_MAX` and every page bound that counts a hash as a word hold by type.
#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct HexHash(String);

impl HexHash {

    pub fn new(s: &str) -> Outcome<Self> {
        if !is_hash(s) {
            return Err(err!(
                "'{}' ({} bytes) is not a hash: one is 64 lowercase hex digits.",
                cut(s, 80, CUT_MARK), s.len();
            Invalid, Input, Wire));
        }
        Ok(Self(s.to_string()))
    }

    pub fn of(bytes: &[u8]) -> Self { Self(hash_of(bytes)) }

    pub fn as_str(&self) -> &str { &self.0 }
}

impl std::ops::Deref for HexHash {
    type Target = str;
    fn deref(&self) -> &str { &self.0 }
}

impl ToDat for HexHash {
    fn to_dat(&self) -> Outcome<Dat> { Ok(Dat::Str(self.0.clone())) }
}

impl FromDat for HexHash {
    fn from_dat(dat: Dat) -> Outcome<Self> {
        match dat {
            Dat::Str(s) => Self::new(&s),
            other       => Err(err!("A hash must be a string, not {:?}.", other; Decode, Wire)),
        }
    }
}

// The port's `BodyRef`, `Seen` and `Found` cross in the shape their derives gave them, each hash
// through `HexHash`, so a peer's malformed hash is refused at decode and ours at encode.

#[derive(ToDat, FromDat)]
struct BodyRefDat {
    hash:   HexHash,
    len:    u64,
}

impl ToDat for BodyRef {
    fn to_dat(&self) -> Outcome<Dat> {
        BodyRefDat { hash: res!(HexHash::new(&self.hash)), len: self.len }.to_dat()
    }
}

impl FromDat for BodyRef {
    fn from_dat(dat: Dat) -> Outcome<Self> {
        let r = res!(BodyRefDat::from_dat(dat));
        Ok(Self { hash: r.hash.0, len: r.len })
    }
}

#[derive(ToDat, FromDat)]
enum SeenDat {
    Absent,
    Bytes(HexHash),
    Unread,
}

impl ToDat for Seen {
    fn to_dat(&self) -> Outcome<Dat> {
        match self {
            Self::Absent    => SeenDat::Absent,
            Self::Bytes(h)  => SeenDat::Bytes(res!(HexHash::new(h))),
            Self::Unread    => SeenDat::Unread,
        }.to_dat()
    }
}

impl FromDat for Seen {
    fn from_dat(dat: Dat) -> Outcome<Self> {
        Ok(match res!(SeenDat::from_dat(dat)) {
            SeenDat::Absent     => Self::Absent,
            SeenDat::Bytes(h)   => Self::Bytes(h.0),
            SeenDat::Unread     => Self::Unread,
        })
    }
}

/// A window path's stamp (D1v2b): its length and write time, or its hash, the hash through
/// `HexHash` as every other.
#[derive(ToDat, FromDat)]
enum StampDat {
    Seen(u64, Option<u64>),
    Hashed(HexHash),
}

impl ToDat for Stamp {
    fn to_dat(&self) -> Outcome<Dat> {
        match self {
            Self::Seen(len, ms) => StampDat::Seen(*len, *ms),
            Self::Hashed(h)     => StampDat::Hashed(res!(HexHash::new(h))),
        }.to_dat()
    }
}

impl FromDat for Stamp {
    fn from_dat(dat: Dat) -> Outcome<Self> {
        Ok(match res!(StampDat::from_dat(dat)) {
            StampDat::Seen(len, ms) => Self::Seen(len, ms),
            StampDat::Hashed(h)     => Self::Hashed(h.0),
        })
    }
}

#[derive(ToDat, FromDat)]
enum FoundDat {
    Nothing,
    Hash(HexHash),
    Unread,
}

impl ToDat for Found {
    fn to_dat(&self) -> Outcome<Dat> {
        match self {
            Self::Nothing   => FoundDat::Nothing,
            Self::Hash(h)   => FoundDat::Hash(res!(HexHash::new(h))),
            Self::Unread    => FoundDat::Unread,
        }.to_dat()
    }
}

impl FromDat for Found {
    fn from_dat(dat: Dat) -> Outcome<Self> {
        Ok(match res!(FoundDat::from_dat(dat)) {
            FoundDat::Nothing   => Self::Nothing,
            FoundDat::Hash(h)   => Self::Hash(h.0),
            FoundDat::Unread    => Self::Unread,
        })
    }
}


// ┌───────────────────────────────────────────────────────────────┐
// │ Bodies by reference                                            │
// └───────────────────────────────────────────────────────────────┘

/// `Body` on the wire.  `Held` names a body the store keeps, uploaded first; `Large` one over
/// `VERSION_FILE_MAX`, never uploaded and known by hash and length alone.
#[derive(Clone, Debug, Eq, PartialEq, ToDat, FromDat)]
pub enum WireBody {
    Held(BodyRef),
    TooLarge(u64),
    Unseen,
    Gone,
    Large(BodyRef),
}

impl WireBody {

    pub fn refer(body: &Body) -> Self {
        match body {
            Body::Held(b) if b.len() > VERSION_FILE_MAX => Self::Large(BodyRef::of(b)),
            Body::Held(b)       => Self::Held(BodyRef::of(b)),
            Body::TooLarge(n)   => Self::TooLarge(*n),
            Body::Unseen        => Self::Unseen,
            Body::Gone          => Self::Gone,
            Body::Large(r)      => Self::Large(r.clone()),
            Body::Stored(r) if r.len as usize > VERSION_FILE_MAX => Self::Large(r.clone()),
            Body::Stored(r)     => Self::Held(r.clone()),
        }
    }

    /// [`WireBody::resolve`] for bodies the store has put down already (D1mem fix B): each named
    /// `Stored` by hash, with no copy of its bytes.  `has` says which it holds; one of no bytes is
    /// in hand.
    pub fn stored(&self, has: &impl Fn(&BodyRef) -> bool) -> Outcome<Body> {
        Ok(match self {
            Self::Held(r)       => Body::Stored(res!(stored_ref(r, has))),
            Self::TooLarge(n)   => Body::TooLarge(*n),
            Self::Unseen        => Body::Unseen,
            Self::Gone          => Body::Gone,
            Self::Large(r)      => Body::Large(r.clone()),
        })
    }

    pub fn resolve(&self, get: &mut impl FnMut(&BodyRef) -> Outcome<Vec<u8>>) -> Outcome<Body> {
        Ok(match self {
            Self::Held(r)       => Body::Held(res!(fetch(r, get))),
            Self::TooLarge(n)   => Body::TooLarge(*n),
            Self::Unseen        => Body::Unseen,
            Self::Gone          => Body::Gone,
            Self::Large(r)      => Body::Large(r.clone()),
        })
    }
}

/// The bytes `r` names, through `get`, refused where they are not the bytes it names.
pub fn fetch(r: &BodyRef, get: &mut impl FnMut(&BodyRef) -> Outcome<Vec<u8>>) -> Outcome<Vec<u8>> {
    let b = res!(get(r));
    if !r.names(&b) {
        return Err(err!(
            "A body fetched as {} ({} bytes) came back as {} bytes that are not it.",
            r.hash, r.len, b.len();
        Mismatch, Wire));
    }
    Ok(b)
}

/// `Carried` on the wire.
#[derive(Clone, Debug, Eq, PartialEq, ToDat, FromDat)]
pub enum WireCarried {
    Made,
    Kept(BodyRef),
    Unread,
}

impl WireCarried {

    pub fn refer(c: &Carried) -> Self {
        match c {
            Carried::Made       => Self::Made,
            Carried::Kept(b)    => Self::Kept(b.by_ref()),
            Carried::Unread     => Self::Unread,
        }
    }

    pub fn resolve(&self, get: &mut impl FnMut(&BodyRef) -> Outcome<Vec<u8>>) -> Outcome<Carried> {
        Ok(match self {
            Self::Made          => Carried::Made,
            Self::Kept(r)       => Carried::Kept(Prior::Held(res!(fetch(r, get)))),
            Self::Unread        => Carried::Unread,
        })
    }

    /// [`WireCarried::resolve`] by hash ([`WireBody::stored`]).
    pub fn stored(&self, has: &impl Fn(&BodyRef) -> bool) -> Outcome<Carried> {
        Ok(match self {
            Self::Made          => Carried::Made,
            Self::Kept(r)       => Carried::Kept(res!(stored_prior(r, has))),
            Self::Unread        => Carried::Unread,
        })
    }
}

/// `Change` on the wire: its bodies by reference, `refused` cut to `TEXT_WIRE_MAX` (§9.11 O4).
#[derive(Clone, Debug, Eq, PartialEq, ToDat, FromDat)]
pub struct WireChange {
    pub path:    String,
    pub after:   WireBody,
    pub before:  Option<BodyRef>,
    pub found:   Found,
    pub carried: Option<WireCarried>,
    pub mark:    bool,
    pub refused: Option<String>,
    pub wiped:   bool,
    pub folder:  Option<String>,
    pub by:      Option<Author>,
    pub door:    bool,
}

impl WireChange {

    pub fn refer(c: &Change) -> Self {
        Self {
            path:       c.path.clone(),
            after:      WireBody::refer(&c.after),
            before:     c.before.as_ref().map(Prior::by_ref),
            found:      c.found.clone(),
            carried:    c.carried.as_ref().map(WireCarried::refer),
            mark:       c.mark,
            refused:    c.refused.as_deref().map(|r| cut(r, super::TEXT_WIRE_MAX, CUT_MARK)),
            wiped:      c.wiped,
            folder:     c.folder.clone(),
            by:         c.by.clone(),
            door:       c.door,
        }
    }

    pub fn resolve(&self, get: &mut impl FnMut(&BodyRef) -> Outcome<Vec<u8>>) -> Outcome<Change> {
        Ok(Change {
            path:       self.path.clone(),
            after:      res!(self.after.resolve(get)),
            before:     match &self.before {
                Some(r) => Some(Prior::Held(res!(fetch(r, get)))),
                None    => None,
            },
            found:      self.found.clone(),
            carried:    match &self.carried {
                Some(c) => Some(res!(c.resolve(get))),
                None    => None,
            },
            mark:       self.mark,
            refused:    self.refused.clone(),
            wiped:      self.wiped,
            folder:     self.folder.clone(),
            by:         self.by.clone(),
            door:       self.door,
        })
    }

    /// Every body this names that the store keeps, so the sender uploads it first (§16.3a 3).
    /// [`WireChange::resolve`] for a store that put every uploaded body down already (D1mem fix
    /// B): the change names each by hash, so a turn's ledger holds no bytes.  `has` says which
    /// bodies the store holds.
    pub fn stored(&self, has: &impl Fn(&BodyRef) -> bool) -> Outcome<Change> {
        Ok(Change {
            path:       self.path.clone(),
            after:      match &self.after {
                WireBody::Held(r) if r.len == 0 => Body::Held(Vec::new()),
                other                           => res!(other.stored(has)),
            },
            before:     match &self.before {
                Some(r) => Some(res!(stored_prior(r, has))),
                None    => None,
            },
            found:      self.found.clone(),
            carried:    match &self.carried {
                Some(c) => Some(res!(c.stored(has))),
                None    => None,
            },
            mark:       self.mark,
            refused:    self.refused.clone(),
            wiped:      self.wiped,
            folder:     self.folder.clone(),
            by:         self.by.clone(),
            door:       self.door,
        })
    }

    pub fn uploads(&self) -> Vec<&BodyRef> {
        let mut v = Vec::new();
        if let WireBody::Held(r) = &self.after { v.push(r); }
        if let Some(r) = &self.before { v.push(r); }
        if let Some(WireCarried::Kept(r)) = &self.carried { v.push(r); }
        v
    }
}

/// `Standing` on the wire.
#[derive(Clone, Debug, Eq, PartialEq, ToDat, FromDat)]
pub enum WireStanding {
    Now(WireBody),
    Unknown,
}

impl WireStanding {

    pub fn refer(s: &Standing) -> Self {
        match s {
            Standing::Now(b)    => Self::Now(WireBody::refer(b)),
            Standing::Unknown   => Self::Unknown,
        }
    }

    pub fn resolve(&self, get: &mut impl FnMut(&BodyRef) -> Outcome<Vec<u8>>) -> Outcome<Standing> {
        Ok(match self {
            Self::Now(b)        => Standing::Now(res!(b.resolve(get))),
            Self::Unknown       => Standing::Unknown,
        })
    }
}

/// `r` where the store holds it, refused where it does not.
fn stored_ref(r: &BodyRef, has: &impl Fn(&BodyRef) -> bool) -> Outcome<BodyRef> {
    if has(r) {
        return Ok(r.clone());
    }
    Err(err!("store: no upload of this run and no stored body names {} ({} bytes).",
        r.hash, r.len; Missing, Data))
}

/// `r` as a ledger names it: the stored body, or no bytes in hand.
fn stored_prior(r: &BodyRef, has: &impl Fn(&BodyRef) -> bool) -> Outcome<Prior> {
    if r.len == 0 {
        return Ok(Prior::Held(Vec::new()));
    }
    Ok(Prior::Stored(res!(stored_ref(r, has))))
}

/// `TurnFound` on the wire: a copy by reference, which `RemoteStore` maps to the caller's own
/// `now` where it names it, and fetches otherwise.
#[derive(Clone, Debug, Eq, PartialEq, ToDat, FromDat)]
pub enum WireTurnFound {
    Made,
    Carried(BodyRef),
    Was(BodyRef),
}

impl WireTurnFound {

    pub fn refer(t: &TurnFound) -> Self {
        match t {
            TurnFound::Made         => Self::Made,
            TurnFound::Carried(b)   => Self::Carried(BodyRef::of(b)),
            TurnFound::Was(b)       => Self::Was(BodyRef::of(b)),
        }
    }

    /// What a turn's ledger said, by reference (D1mem fix B).
    pub fn said(t: &TurnSaid) -> Self {
        match t {
            TurnSaid::Made          => Self::Made,
            TurnSaid::Carried(p)    => Self::Carried(p.by_ref()),
            TurnSaid::Was(p)        => Self::Was(p.by_ref()),
        }
    }

    pub fn resolve(&self, now: &[u8], get: &mut impl FnMut(&BodyRef) -> Outcome<Vec<u8>>)
        -> Outcome<TurnFound>
    {
        Ok(match self {
            Self::Made          => TurnFound::Made,
            Self::Carried(r)    => TurnFound::Carried(res!(copy_of(r, now, get))),
            Self::Was(r)        => TurnFound::Was(res!(copy_of(r, now, get))),
        })
    }
}

/// The bytes a copy reply names: the caller's own `now` where it names them, with no fetch.
pub fn copy_of(r: &BodyRef, now: &[u8], get: &mut impl FnMut(&BodyRef) -> Outcome<Vec<u8>>)
    -> Outcome<Vec<u8>>
{
    if r.names(now) { Ok(now.to_vec()) } else { fetch(r, get) }
}

/// Words the person typed, or the crystal's own: never cut.  Over `TEXT_WIRE_MAX` they travel as
/// a body (lead ruling, 17 Oct): `record_steer`'s `json` and `instruction`, and every
/// `versions_record*` `note`.
#[derive(Clone, Debug, Eq, PartialEq, ToDat, FromDat)]
pub enum WireText {
    Words(String),
    Body(BodyRef),
}

impl WireText {

    pub fn refer(s: &str) -> Self {
        if s.len() <= super::TEXT_WIRE_MAX {
            Self::Words(s.to_string())
        } else {
            Self::Body(BodyRef::of(s.as_bytes()))
        }
    }

    pub fn resolve(&self, get: &mut impl FnMut(&BodyRef) -> Outcome<Vec<u8>>) -> Outcome<String> {
        match self {
            Self::Words(s)  => Ok(s.clone()),
            Self::Body(r)   => match String::from_utf8(res!(fetch(r, get))) {
                Ok(s)   => Ok(s),
                Err(e)  => Err(err!(e, "The text body {} is not UTF-8.", r.hash; Decode, Wire)),
            },
        }
    }
}


// ┌───────────────────────────────────────────────────────────────┐
// │ Bounded replies                                                │
// └───────────────────────────────────────────────────────────────┘

/// `Unlink` on the wire: a count in place of the remaining sidecar, which `RemoteStore` reads
/// back by `links_page` (§16.3a 4).
///
/// **What [`Unlinked::rebuild`] returns is a view, and is never written back** (d1k3 check,
/// section 1).  It is read by page, so it holds no refused row (an end over the wire's bounds)
/// and only the page's 2,000-character copy of each note: writing it to a sidecar would lose
/// both.  Its one consumer, `link_remove` in `tools.rs`, reads only which arm it is.  Writers edit
/// the stored text row by row (`diamond_link::edit_rows`), and `write_links`, the only way to turn
/// a list back into a sidecar, is compiled for tests alone.
#[derive(Clone, Debug, Eq, PartialEq, ToDat, FromDat)]
pub enum Unlinked {
    Missing,
    Users,
    Removed { count: u32 },
}

impl Unlinked {

    pub fn of(u: &Unlink) -> Self {
        match u {
            Unlink::Missing         => Self::Missing,
            Unlink::Users           => Self::Users,
            Unlink::Removed(left)   => Self::Removed { count: left.len() as u32 },
        }
    }

    /// The port's `Unlink`, from the sidecar read back: a lossy view, never to be written back
    /// (see [`Unlinked`]).
    pub fn rebuild(&self, left: Vec<Link>) -> Unlink {
        match self {
            Self::Missing           => Unlink::Missing,
            Self::Users             => Unlink::Users,
            Self::Removed { .. }    => Unlink::Removed(left),
        }
    }
}

/// How many times a links walk starts again on [`links_changed`](super::links_changed) before
/// it gives up: a sidecar rewritten under every walk is a fault, not a page.
pub const LINKS_WALK_TRIES: usize = 4;

/// Every link of a sidecar, read page by page through `page(at, stamp)`, which is
/// `RemoteStore`'s `links_page`: the links, and each refused link's id and why.
///
/// A refused link is passed over, so the links after it are still read.  A page refused as
/// [`links_changed`](super::links_changed) starts the walk again from row 0; one that does not
/// advance is refused, so no walk loops.
pub fn walk_links(
    mut page: impl FnMut(u64, Option<&HexHash>) -> Outcome<LinksPage>,
)
    -> Outcome<(Vec<Link>, Vec<(String, String)>)>
{
    let mut tries = 0;
    'walk: loop {
        tries += 1;
        let mut links = Vec::new();
        let mut refused = Vec::new();
        let mut stamp: Option<HexHash> = None;
        let mut at = 0;
        loop {
            let p = match page(at, stamp.as_ref()) {
                Ok(p) => p,
                Err(e) if super::is_links_changed(&e) && tries < LINKS_WALK_TRIES =>
                    continue 'walk,
                Err(e) => return Err(e),
            };
            if stamp.as_ref().map_or(false, |s| *s != p.stamp) {
                if tries < LINKS_WALK_TRIES {
                    continue 'walk;
                }
                return Err(super::links_changed());
            }
            stamp = Some(p.stamp);
            for e in p.links {
                match e {
                    PageLink::Link(l)               => links.push(l),
                    PageLink::Refused { id, why }   => refused.push((id, why)),
                }
            }
            match p.next {
                None                => return Ok((links, refused)),
                Some(n) if n > at   => at = n,
                Some(n)             => return Err(err!(
                    "links_page answered row {} as the next after row {}: the walk would loop.",
                    n, at;
                    Invalid, Input, Wire)),
            }
        }
    }
}

/// What a `versions_record*` recorded: the version, how many paths, and the first page of them;
/// `recorded_names` reads the rest.
#[derive(Clone, Debug, Eq, PartialEq, ToDat, FromDat)]
pub struct Recorded {
    pub version:    u64,
    pub count:      u32,
    pub first:      Vec<String>,
}

impl Recorded {

    pub fn of(version: u64, names: &[String]) -> Self {
        Self {
            version,
            count:  names.len() as u32,
            first:  names.iter().take(super::LIST_PAGE).cloned().collect(),
        }
    }

    /// Is every name in `first`, so no page need be read?
    pub fn whole(&self) -> bool { self.first.len() as u32 >= self.count }
}

/// One page of a run's `Wants` snapshot: at most `LIST_PAGE` entries over its five lists.
#[derive(Clone, Debug, Default, Eq, PartialEq, ToDat, FromDat)]
pub struct WantsPage {
    pub wants:  Wants,
    pub total:  u32,    // the snapshot's entries over every page
    pub more:   bool,   // another page follows
}

impl WantsPage {

    pub fn entries(&self) -> usize { wants_len(&self.wants) }
}

pub fn wants_len(w: &Wants) -> usize {
    w.own.len() + w.notes.len() + w.windows.len() + w.large.len() + w.wipe.len()
}

/// Where an upload stands after one chunk.
#[derive(Clone, Copy, Debug, Eq, PartialEq, ToDat, FromDat)]
pub enum Put {
    More,   // send the next chunk
    Done,   // the last chunk, its hash checked
    Held,   // the store already holds it for this Diamond: nothing more to send
}

/// One chunk of one record of a run's journal, as `journal_read` answers it (U4e): the record (a
/// round, or the parent's open record, R1i), its whole length, and at most `BODY_CHUNK` of its
/// bytes from the offset asked.
#[derive(Clone, Debug, Eq, PartialEq, ToDat, FromDat)]
pub struct JournalChunk {
    pub key:    JournalKey,
    pub len:    u64,
    pub chunk:  Vec<u8>,
}


// ┌───────────────────────────────────────────────────────────────┐
// │ Cuts                                                           │
// └───────────────────────────────────────────────────────────────┘

pub const CUT_MARK:     &str = " [cut]";
pub const DEEPER_MARK:  &str = " [deeper frames dropped]";

/// `s` in at most `max` bytes, ending `mark` where it was cut, on a character boundary.
pub fn cut(s: &str, max: usize, mark: &str) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max.saturating_sub(mark.len());
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    fmt!("{}{}", &s[..end], mark)
}

/// `s` with `mark` added, still in `max` bytes.
fn marked_in(s: &str, max: usize, mark: &str) -> String {
    let mut end = s.len().min(max.saturating_sub(mark.len()));
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    fmt!("{}{}", &s[..end], mark)
}

/// Every error and fault in a frame's `Dat`, cut to `ERR_WORDS_MAX` a frame and `ERR_FRAMES_MAX`
/// frames (§16.3a 4): a diagnostic, not his data, so cut and marked rather than refused.
pub fn cut_errors(d: &mut Dat) {
    match d {
        Dat::Map(m) => {
            let n = m.len();
            for (k, v) in m.iter_mut() {
                match k {
                    Dat::Str(s) if n == 1 && s == "Err" && is_err_wire(v) => {
                        let mut left = super::ERR_FRAMES_MAX;
                        cut_wire(v, &mut left);
                    },
                    Dat::Str(s) if n == 1 && s == "Fault" => cut_strs(v),
                    _ => cut_errors(v),
                }
            }
        },
        Dat::List(l) => for v in l.iter_mut() { cut_errors(v) },
        Dat::Opt(o) => if let Some(v) = o.as_mut() { cut_errors(v) },
        Dat::Box(b) => cut_errors(b),
        Dat::Tup2(t) => for v in t.iter_mut() { cut_errors(v) },
        Dat::Tup3(t) => for v in t.iter_mut() { cut_errors(v) },
        Dat::Tup4(t) => for v in t.iter_mut() { cut_errors(v) },
        Dat::Tup5(t) => for v in t.iter_mut() { cut_errors(v) },
        Dat::Tup6(t) => for v in t.iter_mut() { cut_errors(v) },
        _ => (),
    }
}

/// Is `d` an `ErrWire`: `{"Frame": {msg, tags, cause}}` or `{"Collection": [...]}`?
pub(crate) fn is_err_wire(d: &Dat) -> bool {
    match d {
        Dat::Map(m) if m.len() == 1 => match m.iter().next() {
            Some((Dat::Str(k), Dat::Map(f))) if k == "Frame" =>
                f.len() == 3 && ["msg", "tags", "cause"].iter()
                    .all(|n| f.contains_key(&Dat::Str(n.to_string()))),
            Some((Dat::Str(k), Dat::List(_))) => k == "Collection",
            _ => false,
        },
        _ => false,
    }
}

/// Cuts one `ErrWire` in place, spending `left` frames; answers whether anything was dropped.
fn cut_wire(d: &mut Dat, left: &mut usize) -> bool {
    let m = match d {
        Dat::Map(m) => m,
        _ => return false,
    };
    let (k, v) = match m.iter_mut().next() {
        Some(kv) => kv,
        None => return false,
    };
    match (k, v) {
        (Dat::Str(k), Dat::Map(f)) if k == "Frame" => {
            *left = left.saturating_sub(1);
            let msg_key = Dat::Str("msg".to_string());
            if let Some(Dat::Str(msg)) = f.get_mut(&msg_key) {
                *msg = cut(msg, super::ERR_WORDS_MAX, CUT_MARK);
            }
            match f.get_mut(&Dat::Str("cause".to_string())) {
                Some(Dat::Opt(o)) if o.is_some() && *left == 0 => **o = None,
                Some(Dat::Opt(o)) => return match o.as_mut() {
                    Some(c) => cut_wire(c, left),
                    None    => false,
                },
                _ => return false,
            }
            // The last frame kept says the rest were dropped.
            if let Some(Dat::Str(msg)) = f.get_mut(&msg_key) {
                *msg = marked_in(msg, super::ERR_WORDS_MAX, DEEPER_MARK);
            }
            true
        },
        (Dat::Str(k), Dat::List(l)) if k == "Collection" => {
            let mut dropped = false;
            let mut kept = 0;
            for e in l.iter_mut() {
                if *left == 0 {
                    break;
                }
                dropped |= cut_wire(e, left);
                kept += 1;
            }
            // A collection is entered with a frame to spend, so one at least is kept.
            if kept < l.len() {
                l.truncate(kept);
                dropped = true;
                mark_last(l.last_mut());
            }
            dropped
        },
        _ => false,
    }
}

/// Marks the deepest frame of the last error kept in a cut collection.
fn mark_last(d: Option<&mut Dat>) {
    let mut d = match d {
        Some(d) => d,
        None => return,
    };
    loop {
        let m = match d {
            Dat::Map(m) => m,
            _ => return,
        };
        match m.iter_mut().next() {
            Some((Dat::Str(k), Dat::Map(f))) if k == "Frame" => {
                let deeper = matches!(f.get(&Dat::Str("cause".to_string())),
                    Some(Dat::Opt(o)) if o.is_some());
                if !deeper {
                    if let Some(Dat::Str(msg)) = f.get_mut(&Dat::Str("msg".to_string())) {
                        *msg = marked_in(msg, super::ERR_WORDS_MAX, DEEPER_MARK);
                    }
                    return;
                }
                match f.get_mut(&Dat::Str("cause".to_string())) {
                    Some(Dat::Opt(o)) => match o.as_mut() {
                        Some(c) => d = c,
                        None => return,
                    },
                    _ => return,
                }
            },
            Some((Dat::Str(k), Dat::List(l))) if k == "Collection" => match l.last_mut() {
                Some(e) => d = e,
                None => return,
            },
            _ => return,
        }
    }
}

/// Every string in a fault, cut to `ERR_WORDS_MAX`.
fn cut_strs(d: &mut Dat) {
    match d {
        Dat::Str(s) => *s = cut(s, super::ERR_WORDS_MAX, CUT_MARK),
        Dat::Map(m) => for (_, v) in m.iter_mut() { cut_strs(v) },
        Dat::List(l) => for v in l.iter_mut() { cut_strs(v) },
        Dat::Box(b) => cut_strs(b),
        _ => (),
    }
}
