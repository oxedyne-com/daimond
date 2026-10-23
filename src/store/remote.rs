//! The store port over a link: a run's child reaches the store in another process (spec §16.1,
//! d1_plan §3 D1r).
//!
//! [`RemoteStore`] is a [`HostStore`] whose every method is one [`StoreCall`] through a
//! [`StoreLink`], or a few: the bodies a call names are uploaded first, by `body_put`, and the
//! bodies a reply names are fetched after, by `body_get`.  The link is R1's seam: the store server's
//! [`LoopLink`] in process, the pipe between processes.
//!
//! - **The port's own values cross as tickets.**  A `Window`, `Hold`, `Steer` or `Marked` is a
//!   [`Ticket`] holding the store's [`Handle`]; dropping it sends [`StoreCall::LetGo`], and
//!   `close_window` closes its window instead.
//! - **What the child does itself.**  `standing_retired`'s arithmetic, which writes nothing, so
//!   that only an accepted landing's side files cross (`standing_settle`, UNBLOCK-18 F6), a
//!   `STATE.md` write landed by section over what `state_read` read (PL-A2); and `mark_passed`'s
//!   two sha256 marks, so neither the page nor the data crosses.
//! - **Lists come back in pages.**  A record's names after its first page are read by
//!   `recorded_names`, an `Unlink`'s remaining links by `links_page`, and `held_under` by its key.
//! - **A refusal the port cannot carry is kept.**  `ran_opaque` answers `()` at the port, so a
//!   lost mark is kept for that Diamond's `drain_turn`, which refuses with it.  `capture` and
//!   `restore_landed` answer an `Outcome` since D1int, which the act's answer tells, so theirs is
//!   no longer kept (the D1r1 interim, retired).
//! - **A gate that cannot be asked holds.**  Where the link fails or the store answers a fault, a
//!   method with no `Outcome` answers as a host without a store does (u2_plan §9.2).

use crate::{
    agent::compact::FoldNotes,
    diamond_link::{Link, Unlink},
    diamond_versions::{Act, BodyRef, Cause, Change, Found, OpenDelete, Route, Seen, Short,
        TurnFound},
    engine::host::{
        Host,
        store::{Drained, HostStore},
        types::store::{CrystalHalf, FileAct},
    },
    marks::{Live, Reach},
    rating::Author,
    store::{
        call::{
            encode_call, fetch, walk_links, Fault, Handle, HexHash, Put, Recorded, StoreCall, StoreReply,
            WantsPage, WireBody, WireChange, WireText, BODY_CHUNK, JOURNAL_PAGE, JournalKey,
            JournalRun,
        },
        diamond::{restore_ended, standing_split, Landed, Retire, SettlePhase},
        server::LoopLink,
    },
    tools::{Bound, CrystalPassed, FileRoot, ToolContext},
};

use oxedyne_fe2o3_core::prelude::*;

use std::{
    collections::BTreeMap,
    sync::{
        Mutex,
        atomic::{AtomicU64, Ordering},
    },
};

// ┌───────────────────────────────────────────────────────────────┐
// │ The link                                                       │
// └───────────────────────────────────────────────────────────────┘

/// One run's way to the store: each call as its frame, each reply decoded.  R1 adds the pipe.
#[allow(async_fn_in_trait)]
pub trait StoreLink: Clone {
    /// `call`'s reply, or the store's fault as [`StoreReply::Fault`].  Err where the link fails.
    async fn call(&self, call: &StoreCall) -> Outcome<StoreReply>;
    /// [`call`](Self::call), blocking the calling thread: for the port's plain `fn`s, which the
    /// store answers inline (spec §16.5).
    fn call_blocking(&self, call: &StoreCall) -> Outcome<StoreReply>;
    /// Sends `call` with no wait for its answer: a ticket dropped.
    fn notify(&self, call: &StoreCall);
}

impl StoreLink for LoopLink {
    async fn call(&self, call: &StoreCall) -> Outcome<StoreReply> { LoopLink::call(self, call).await }
    fn call_blocking(&self, call: &StoreCall) -> Outcome<StoreReply> {
        LoopLink::call_blocking(self, call)
    }
    fn notify(&self, call: &StoreCall) {
        let _ = self.send(call);
    }
}

/// One of the port's own values: the store's [`Handle`], let go when this is dropped.  `None`
/// where the store did not give one, which nothing then names.
pub struct Ticket<L: StoreLink> {
    link:   L,
    handle: Option<Handle>,
}

impl<L: StoreLink> Ticket<L> {
    fn new(link: &L, handle: Option<Handle>) -> Self { Self { link: link.clone(), handle } }

    /// The store's handle, if it gave one.
    pub fn handle(&self) -> Option<Handle> { self.handle }

    /// The handle, taken so the drop lets nothing go: the call that takes it ends it.
    fn take(mut self) -> Option<Handle> { self.handle.take() }
}

impl<L: StoreLink> Drop for Ticket<L> {
    fn drop(&mut self) {
        if let Some(handle) = self.handle.take() {
            self.link.notify(&StoreCall::LetGo { handle });
        }
    }
}

impl<L: StoreLink> std::fmt::Debug for Ticket<L> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Ticket({:?})", self.handle)
    }
}

// ┌───────────────────────────────────────────────────────────────┐
// │ Replies                                                        │
// └───────────────────────────────────────────────────────────────┘

/// The reply's own value, or the store's fault as its error, or a reply to another call refused.
macro_rules! answer {
    ($got:expr, $var:ident) => {
        match $got {
            Ok(StoreReply::$var(v))     => Ok(v),
            Ok(StoreReply::Fault(f))    => Err(fault_error(&f)),
            Ok(other)                   => Err(mismatch(stringify!($var), other.name())),
            Err(e)                      => Err(e),
        }
    };
}

/// The store's binding answered that no restore holds `ticket` (its `refusal`, "ticket N"): the
/// direct store's answer for a ticket no restore opened is then the remote's too (D1r1d).
fn no_restore(got: &Outcome<StoreReply>, ticket: u64) -> bool {
    matches!(got, Ok(StoreReply::Fault(Fault::Unbound(u))) if u.id == fmt!("ticket {}", ticket))
}

/// The store's fault as its error, an outcome-unknown one counted first
/// ([`note_unknown`](crate::store::call::note_unknown)), so a hold taken before the call keeps
/// what it holds (QA1-C).
fn fault_error(f: &Fault) -> Error<ErrTag> {
    if let Fault::Unknown(_) = f {
        crate::store::call::note_unknown();
    }
    f.to_error()
}

fn mismatch(asked: &str, got: &str) -> Error<ErrTag> {
    err!("The store answered store.{} to a {} call.", got, asked; Mismatch, Wire)
}

fn utf8(b: Vec<u8>, what: &str) -> Outcome<String> {
    match String::from_utf8(b) {
        Ok(s)   => Ok(s),
        Err(e)  => Err(err!(e, "The {} the store sent is not UTF-8.", what; Decode, Wire)),
    }
}

// ┌───────────────────────────────────────────────────────────────┐
// │ The store                                                      │
// └───────────────────────────────────────────────────────────────┘

/// The store port over `L` (d1_plan §3 D1r).
pub struct RemoteStore<L: StoreLink> {
    link:   L,
    acts:   AtomicU64,                               // the last act id minted
    kept:   Mutex<BTreeMap<String, Error<ErrTag>>>,  // a lost opaque-run mark, by Diamond
    held:   Mutex<Option<Gathered>>,                 // a held write's ARCHIVE, gathered (HL5b)
}

/// The ARCHIVE phase of a held write in progress on the child (HL5b): the standing path it is
/// for, and the retired text its `pre` step settled, gathered to cross in the write's one
/// [`StoreCall::StoreWriteThen`] instead of a call of its own.
#[derive(Debug)]
struct Gathered {
    path:       String,
    archive:    Vec<(String, String)>,
}

impl<L: StoreLink> RemoteStore<L> {

    pub fn new(link: L) -> Self {
        Self {
            link,
            acts:       AtomicU64::new(0),
            kept:       Mutex::new(BTreeMap::new()),
            held:       Mutex::new(None),
        }
    }

    pub fn link(&self) -> &L { &self.link }

    // ── A run's child reads its Diamonds' files from the store (HL5a) ──
    // Not `HostStore` methods: they are `NativeFs`'s reads of a store-owned path
    // (`tools::store_owned`), which on the child are the store's, never the run's disk.

    /// At most `max` bytes of the Diamond `id`'s file at `path` as the store holds it, with its
    /// whole length; `None` where nothing stands there.  A file that will not read is an `Err`.
    pub async fn store_file_read(&self, id: &str, path: &str, max: u32)
        -> Outcome<Option<(Vec<u8>, u64)>>
    {
        let call = StoreCall::StoreFileRead { id: s(id), path: s(path), max };
        match res!(res!(answer!(self.link.call(&call).await, StoreFileRead))) {
            Some((r, total))    => Ok(Some((res!(self.get(id, &r).await), total))),
            None                => Ok(None),
        }
    }

    /// The Diamond `id`'s folder at `dir` as the store holds it: each entry's name, whether it
    /// is a folder, its length and its write time in milliseconds where known.
    pub async fn store_file_list(&self, id: &str, dir: &str)
        -> Outcome<Vec<(String, bool, u64, Option<f64>)>>
    {
        let call = StoreCall::StoreFileList { id: s(id), dir: s(dir) };
        let listed = res!(res!(answer!(self.link.call(&call).await, StoreFileList)));
        Ok(listed.into_iter().map(|(name, is_dir, len, when)| (name, is_dir, len,
            when.map(|ms| ms as f64))).collect())
    }

    // ── A run's child's held write of a standing file (HL5b) ──
    // Not `HostStore` methods: they are `NativeFs`'s held write of a store-owned path, whose
    // compare, ARCHIVE and bytes are one store op, so no lock is held across a wire round trip.

    /// Gather, rather than send, the ARCHIVE phase settled for the standing file at `path` until
    /// [`gathered`](Self::gathered) takes it.  Refused while another is being gathered.
    pub fn gather(&self, path: &str) -> Outcome<()> {
        let mut held = match self.held.lock() {
            Ok(h)   => h,
            Err(_)  => return Err(err!("The held write's gathering is poisoned."; Lock, Bug)),
        };
        if let Some(g) = held.as_ref() {
            return Err(err!("A held write of '{}' is already gathering its archive, so the held \
                write of '{}' was refused.", g.path, path; Lock, Invalid));
        }
        *held = Some(Gathered { path: crate::tools::normalise(path), archive: Vec::new() });
        Ok(())
    }

    /// The ARCHIVE gathered since [`gather`](Self::gather), taken; gathering stops.
    pub fn gathered(&self) -> Vec<(String, String)> {
        match self.held.lock() {
            Ok(mut h)   => h.take().map(|g| g.archive).unwrap_or_default(),
            Err(_)      => Vec::new(),
        }
    }

    /// While a held write gathers: its own ARCHIVE phase gathered, `Ok`; any other settle
    /// refused, since nothing may cross the wire between its compare and its bytes.  `None`
    /// where no held write gathers.
    fn gathering(&self, path: &str, landed: &Landed, phase: SettlePhase) -> Option<Outcome<()>> {
        let mut held = match self.held.lock() {
            Ok(h)   => h,
            Err(_)  => return Some(Err(err!("The held write's gathering is poisoned."; Lock, Bug))),
        };
        let g = match held.as_mut() {
            Some(g) => g,
            None    => return None,
        };
        if phase != SettlePhase::Archive || crate::tools::normalise(path) != g.path {
            return Some(Err(err!("A {:?} settle of '{}' was refused inside the held write of \
                '{}': its only step is that file's own ARCHIVE.", phase, path, g.path;
                Lock, Invalid)));
        }
        g.archive.extend(landed.archive.iter().cloned());
        Some(Ok(()))
    }

    /// The child's held write of the Diamond `id`'s standing file at `path`, in one store op
    /// ([`StoreCall::StoreWriteThen`]): under the store's lock, compare with `expect`, append
    /// `archive`, write `body`.  `Ok(None)` written; `Ok(Some(found))` refused, nothing archived.
    pub async fn store_write_then(&self, id: &str, path: &str, body: &[u8], expect: Option<&Seen>,
        archive: &[(String, String)]) -> Outcome<Option<Seen>>
    {
        let mut have: Vec<&[u8]> = vec![body];
        let archive = archive.iter().map(|(leaf, t)| {
            have.push(t.as_bytes());
            (leaf.clone(), BodyRef::of(t.as_bytes()))
        }).collect();
        let call = StoreCall::StoreWriteThen {
            id: s(id), root: FileRoot::Opfs, path: s(path), body: BodyRef::of(body),
            expect: expect.cloned(), archive,
        };
        res!(answer!(self.send(id, call, &have).await, StoreWriteThen))
    }

    /// The child's folder, delete or move of the Diamond `id`'s `path`, in the store
    /// ([`StoreCall::StoreFileAct`], HL5c).
    pub async fn store_file_act(&self, id: &str, path: &str, act: FileAct) -> Outcome<()> {
        let call = StoreCall::StoreFileAct { id: s(id), root: FileRoot::Opfs, path: s(path), act };
        res!(answer!(self.send(id, call, &[]).await, StoreFileAct))
    }

    // ── The parent's journal calls (R1i) ──────────────────────────
    // Not `HostStore` methods: the store refuses both to a run and to a door, so only the
    // parent's own client has a use for them.

    /// Every run that has a journal, in order, each with whether it holds the parent's open
    /// record, a page of `JOURNAL_PAGE` at a time: what a restarted parent finds open.
    pub async fn journal_list(&self) -> Outcome<Vec<JournalRun>> {
        let mut out: Vec<JournalRun> = Vec::new();
        loop {
            let call = StoreCall::JournalList { after: out.last().map(|r| r.run.clone()) };
            let page = res!(res!(answer!(self.link.call(&call).await, JournalList)));
            if let (Some(last), Some(first)) = (out.last(), page.first()) {
                if first.run <= last.run {
                    return Err(err!("store.journal_list answered '{}' after '{}': out of order.",
                        first.run, last.run; Mismatch, Wire));
                }
            }
            let more = page.len() >= JOURNAL_PAGE;
            out.extend(page);
            if !more {
                return Ok(out);
            }
        }
    }

    /// Writes the parent's open record of `run` (R1i), over any it had.
    pub async fn journal_open_put(&self, run: &str, record: &[u8]) -> Outcome<()> {
        self.record_put(run, JournalKey::Open, record).await
    }

    /// The parent's open record of `run`, if it has one (R1i).
    pub async fn journal_open(&self, run: &str) -> Outcome<Option<Vec<u8>>> {
        Ok(res!(self.record_read(run, JournalKey::Open).await).map(|(_, b)| b))
    }

    /// Record `key` of `run` up, in `BODY_CHUNK` chunks, as a body crosses.
    async fn record_put(&self, run: &str, key: JournalKey, record: &[u8]) -> Outcome<()> {
        let mut at = 0;
        loop {
            let end = if off("chunk") { record.len() } else { record.len().min(at + BODY_CHUNK) };
            let call = StoreCall::JournalPut {
                run:    s(run),
                key,
                len:    record.len() as u64,
                offset: at as u64,
                chunk:  record[at..end].to_vec(),
            };
            match res!(res!(answer!(self.link.call(&call).await, JournalPut))) {
                Put::Done if end == record.len()    => return Ok(()),
                Put::More if end < record.len()     => at = end,
                put => return Err(err!(
                    "store.journal_put answered {:?} at {} of the {} bytes of {:?}.",
                    put, end, record.len(), key; Mismatch, Wire)),
            }
        }
    }

    /// The first record of `run` at or after `from` (a round), or its open record, whole.
    async fn record_read(&self, run: &str, from: JournalKey) -> Outcome<Option<(JournalKey, Vec<u8>)>> {
        let call = StoreCall::JournalRead { run: s(run), from, offset: 0 };
        let first = match res!(res!(answer!(self.link.call(&call).await, JournalRead))) {
            Some(c) => c,
            None    => return Ok(None),
        };
        let (key, len) = (first.key, first.len);
        if !matches!((from, key), (JournalKey::Open, JournalKey::Open)
            | (JournalKey::Round(_), JournalKey::Round(_)))
        {
            return Err(err!("store.journal_read asked {:?} of '{}' and answered {:?}.",
                from, run, key; Mismatch, Data, Wire));
        }
        let mut bytes = first.chunk;
        while (bytes.len() as u64) < len {
            let call = StoreCall::JournalRead { run: s(run), from: key,
                offset: bytes.len() as u64 };
            match res!(res!(answer!(self.link.call(&call).await, JournalRead))) {
                Some(c) if c.key == key && c.len == len && !c.chunk.is_empty() =>
                    bytes.extend_from_slice(&c.chunk),
                _ => return Err(err!(
                    "store.journal_read: {:?} of '{}' changed or ended at {} of its {} \
                    bytes.", key, run, bytes.len(), len; Mismatch, Data, Wire)),
            }
        }
        if bytes.len() as u64 != len {
            return Err(err!("store.journal_read: {:?} of '{}' came as {} bytes, not {}.",
                key, run, bytes.len(), len; Mismatch, Data, Wire));
        }
        Ok(Some((key, bytes)))
    }

    /// The TTL sweep of the journals: every run's journal whose newest round is at least `ttl_ms`
    /// old at `now_ms`, on the caller's clock, deleted.  The records deleted.
    pub async fn journal_sweep(&self, ttl_ms: u64, now_ms: u64) -> Outcome<u64> {
        res!(answer!(self.link.call(&StoreCall::JournalSweep { ttl_ms, now_ms }).await, JournalSweep))
    }

    fn act(&self) -> u64 { self.acts.fetch_add(1, Ordering::Relaxed) + 1 }

    fn keep(&self, id: &str, e: Error<ErrTag>) {
        if let Ok(mut k) = self.kept.lock() {
            k.entry(id.to_string()).or_insert(e);
        }
    }

    /// The kept refusal of `id`'s `ran_opaque`, taken.
    fn kept_of(&self, id: &str) -> Option<Error<ErrTag>> {
        self.kept.lock().ok().and_then(|mut k| k.remove(id))
    }

    /// The Diamond the open restore `ticket` puts back: `Ok(None)` where none is open, `Err` where
    /// the link or the store failed, so a fault is never read as "no restore open".
    /// The binding's "ticket N" (no restore holds it) is the direct store's `None`.
    fn restore_of(&self, ticket: u64) -> Outcome<Option<String>> {
        let r = self.link.call_blocking(&StoreCall::RestoreStore { ticket });
        if no_restore(&r, ticket) {
            return Ok(None);
        }
        answer!(r, RestoreStore)
    }

    // ── The body channel ──────────────────────────────────────────

    /// The `body_put` frames that upload each body `call` names first, in one act, from `have`.
    fn puts(&self, id: &str, call: &StoreCall, have: &[&[u8]]) -> Outcome<Vec<Vec<StoreCall>>> {
        let refs = call.uploads();
        if refs.iter().all(|r| r.len == 0) {
            return Ok(Vec::new());
        }
        let act = self.act();
        let mut done: Vec<&str> = Vec::new();
        let mut all = Vec::new();
        for r in refs.iter() {
            if r.len == 0 || done.contains(&r.hash.as_str()) {
                continue;
            }
            let bytes = match have.iter().find(|b| r.names(b)) {
                Some(b) => *b,
                None    => return Err(err!(
                    "store.{} names the body {} ({} bytes), which its sender does not hold.",
                    call.name(), r.hash, r.len; Bug, Missing)),
            };
            let hash = res!(HexHash::new(&r.hash));
            let mut chunks = Vec::new();
            let mut at = 0;
            loop {
                let end = if off("chunk") { bytes.len() } else { bytes.len().min(at + BODY_CHUNK) };
                chunks.push(StoreCall::BodyPut {
                    id:     id.to_string(),
                    act,
                    hash:   hash.clone(),
                    len:    bytes.len() as u64,
                    offset: at as u64,
                    chunk:  bytes[at..end].to_vec(),
                });
                if end == bytes.len() {
                    break;
                }
                at = end;
            }
            all.push(chunks);
            done.push(&r.hash);
        }
        Ok(all)
    }

    /// Uploads what `call` names, then sends it.  A call it cannot frame, such as a path over
    /// `PATH_WIRE_MAX`, is refused before any frame, its uploads included (§16.3a rule 3).
    async fn send(&self, id: &str, call: StoreCall, have: &[&[u8]]) -> Outcome<StoreReply> {
        res!(Self::frames(&call));
        for chunks in res!(self.puts(id, &call, have)) {
            for put in chunks {
                match res!(res!(answer!(self.link.call(&put).await, BodyPut))) {
                    Put::More   => continue,
                    Put::Done | Put::Held => break,
                }
            }
        }
        self.link.call(&call).await
    }

    /// [`send`](Self::send), blocking: for a plain `fn` of the port.
    fn send_blocking(&self, id: &str, call: StoreCall, have: &[&[u8]]) -> Outcome<StoreReply> {
        res!(Self::frames(&call));
        for chunks in res!(self.puts(id, &call, have)) {
            for put in chunks {
                match res!(res!(answer!(self.link.call_blocking(&put), BodyPut))) {
                    Put::More   => continue,
                    Put::Done | Put::Held => break,
                }
            }
        }
        self.link.call_blocking(&call)
    }

    /// Whether `call` frames, asked before its uploads go.
    fn frames(call: &StoreCall) -> Outcome<()> {
        if off("bound") {
            return Ok(());
        }
        encode_call(call).map(|_| ())
    }

    fn get_call(id: &str, r: &BodyRef, at: u64) -> Outcome<StoreCall> {
        Ok(StoreCall::BodyGet {
            id:     id.to_string(),
            hash:   res!(HexHash::new(&r.hash)),
            offset: at,
            max:    BODY_CHUNK as u64,
        })
    }

    /// The bytes `r` names, fetched chunk by chunk.
    async fn get(&self, id: &str, r: &BodyRef) -> Outcome<Vec<u8>> {
        let mut b = Vec::new();
        while (b.len() as u64) < r.len {
            let call = res!(Self::get_call(id, r, b.len() as u64));
            let chunk = res!(res!(answer!(self.link.call(&call).await, BodyGet)));
            if chunk.is_empty() {
                break;
            }
            b.extend_from_slice(&chunk);
        }
        fetch(r, &mut |_| Ok(std::mem::take(&mut b)))
    }

    /// [`get`](Self::get), blocking.
    fn get_blocking(&self, id: &str, r: &BodyRef) -> Outcome<Vec<u8>> {
        let mut b = Vec::new();
        while (b.len() as u64) < r.len {
            let call = res!(Self::get_call(id, r, b.len() as u64));
            let chunk = res!(res!(answer!(self.link.call_blocking(&call), BodyGet)));
            if chunk.is_empty() {
                break;
            }
            b.extend_from_slice(&chunk);
        }
        fetch(r, &mut |_| Ok(std::mem::take(&mut b)))
    }

    async fn text(&self, id: &str, got: Outcome<BodyRef>) -> Outcome<String> {
        let r = res!(got);
        utf8(res!(self.get(id, &r).await), "text")
    }

    // ── Pages ─────────────────────────────────────────────────────

    /// A record's answer whole: its first page, then `recorded_names` to its count.
    async fn names(&self, id: &str, got: Outcome<Option<Recorded>>)
        -> Outcome<Option<(u64, Vec<String>)>>
    {
        let rec = match res!(got) {
            Some(r) => r,
            None    => return Ok(None),
        };
        let mut names = rec.first;
        while (names.len() as u32) < rec.count && !off("names") {
            let call = StoreCall::RecordedNames {
                id:         id.to_string(),
                version:    rec.version,
                after:      names.last().cloned(),
            };
            let page = res!(res!(answer!(self.link.call(&call).await, RecordedNames)));
            if page.is_empty() {
                return Err(err!(
                    "store.recorded_names of version {} ended at {} of its {} names.",
                    rec.version, names.len(), rec.count; Missing, Data, Wire));
            }
            names.extend(page);
        }
        Ok(Some((rec.version, names)))
    }

    /// Every link left in `owner`'s sidecar, by `links_page`: the view an `Unlink` carries.
    fn links_left(&self, owner: &str) -> Outcome<Vec<Link>> {
        let (links, _refused) = res!(walk_links(|at, stamp| {
            let call = StoreCall::LinksPage {
                owner:  owner.to_string(),
                at,
                stamp:  stamp.cloned(),
            };
            res!(answer!(self.link.call_blocking(&call), LinksPage))
        }));
        Ok(links)
    }

    /// The whole `Wants` snapshot of the turn, read page by page.
    async fn wants(&self, id: &str) -> Outcome<WantsPage> {
        let call = StoreCall::TurnWants { id: id.to_string() };
        let mut all = res!(res!(answer!(self.link.call(&call).await, TurnWants)));
        let mut n = 1;
        while all.more && !off("one_page") {
            let call = StoreCall::TurnWantsPage { id: id.to_string(), n };
            let page = res!(res!(answer!(self.link.call(&call).await, TurnWantsPage)));
            all.wants.own.extend(page.wants.own);
            all.wants.notes.extend(page.wants.notes);
            all.wants.windows.extend(page.wants.windows);
            all.wants.large.extend(page.wants.large);
            all.wants.wipe.extend(page.wants.wipe);
            all.more = page.more;
            n += 1;
        }
        Ok(all)
    }
}

/// The bodies a change names, for its upload.
fn bodies_of(c: &Change) -> Vec<&[u8]> {
    let mut v: Vec<&[u8]> = Vec::new();
    if let crate::diamond_versions::Body::Held(b) = &c.after { v.push(b); }
    if let Some(b) = c.before.as_ref().and_then(|p| p.held()) { v.push(b); }
    if let Some(crate::diamond_versions::Carried::Kept(p)) = &c.carried {
        if let Some(b) = p.held() { v.push(b); }
    }
    v
}

fn wire_text(s: &str) -> (WireText, Vec<&[u8]>) {
    let t = WireText::refer(s);
    let have = match t {
        WireText::Body(_)   => vec![s.as_bytes()],
        WireText::Words(_)  => Vec::new(),
    };
    (t, have)
}

fn s(v: &str) -> String { v.to_string() }

// ── A test's switches (D1r1c): each rule turned off on this thread, to show its test's red ──

#[cfg(test)]
thread_local! {
    static OFF: std::cell::RefCell<Vec<&'static str>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// Turn `rule` off on this thread, or every rule back on with `None`.
#[cfg(test)]
pub(crate) fn switch_off(rule: Option<&'static str>) {
    OFF.with(|o| match rule {
        Some(r) => o.borrow_mut().push(r),
        None    => o.borrow_mut().clear(),
    })
}

#[cfg(test)]
fn off(rule: &str) -> bool { OFF.with(|o| o.borrow().contains(&rule)) }

#[cfg(not(test))]
#[inline(always)]
fn off(_: &str) -> bool { false }

impl<L: StoreLink> HostStore for RemoteStore<L> {
    type Window = Ticket<L>;
    type Hold   = Ticket<L>;
    type Steer  = Ticket<L>;
    type Marked = Ticket<L>;

    // Crystal
    async fn read_crystal_data(&self, id: &str) -> Outcome<String> {
        let got = answer!(self.link.call(&StoreCall::ReadCrystalData { id: s(id) }).await,
            ReadCrystalData);
        self.text(id, res!(got)).await
    }
    async fn read_crystal_data_strict(&self, id: &str) -> Outcome<String> {
        let got = answer!(self.link.call(&StoreCall::ReadCrystalDataStrict { id: s(id) }).await,
            ReadCrystalDataStrict);
        self.text(id, res!(got)).await
    }
    async fn read_crystal_page(&self, id: &str) -> Outcome<String> {
        let got = answer!(self.link.call(&StoreCall::ReadCrystalPage { id: s(id) }).await,
            ReadCrystalPage);
        self.text(id, res!(got)).await
    }
    async fn read_crystal_page_strict(&self, id: &str) -> Outcome<String> {
        let got = answer!(self.link.call(&StoreCall::ReadCrystalPageStrict { id: s(id) }).await,
            ReadCrystalPageStrict);
        self.text(id, res!(got)).await
    }
    fn crystal_half(&self, id: &str, path: &str) -> Option<CrystalHalf> {
        answer!(self.link.call_blocking(&StoreCall::CrystalHalf { id: s(id), path: s(path) }),
            CrystalHalf).unwrap_or(None)
    }
    async fn crystal_undo_target(&self, id: &str, half: CrystalHalf, at: Option<u64>)
        -> Outcome<Option<(u64, String)>>
    {
        let call = StoreCall::CrystalUndoTarget { id: s(id), half, at };
        res!(answer!(self.link.call(&call).await, CrystalUndoTarget))
    }
    async fn hot_refusals(&self, id: &str) -> u32 {
        answer!(self.link.call(&StoreCall::HotRefusals { id: s(id) }).await, HotRefusals)
            .unwrap_or(0)
    }
    async fn set_hot_refusals(&self, id: &str, n: u32) -> Outcome<()> {
        res!(answer!(self.link.call(&StoreCall::SetHotRefusals { id: s(id), n }).await,
            SetHotRefusals))
    }
    /// A crystal that parses has no last good to ask for, so nothing crosses for it.
    async fn crystal_hot_last_good(&self, id: &str, old: &str) -> String {
        if crate::tools::crystal_json_fault(old).is_none() {
            return String::new();
        }
        let call = StoreCall::CrystalHotLastGood { id: s(id), old: BodyRef::of(old.as_bytes()) };
        match answer!(self.send(id, call, &[old.as_bytes()]).await, CrystalHotLastGood) {
            Ok(got) => self.text(id, got).await.unwrap_or_default(),
            Err(_)  => String::new(),
        }
    }
    async fn last_passed(&self, id: &str) -> Option<CrystalPassed> {
        answer!(self.link.call(&StoreCall::LastPassed { id: s(id) }).await, LastPassed)
            .unwrap_or(None)
    }
    /// The child hashes the page and the data and sends the two marks alone (§9.11 rider).
    async fn mark_passed(&self, id: &str, version: u64, page: &str, data: &str, debug: u32)
        -> Outcome<CrystalPassed>
    {
        let page_text = page;
        let mark = crate::tools::crystal_page_mark(page);
        let page = if mark.is_empty() { None } else { Some(res!(HexHash::new(&mark))) };
        if off("marks") {
            // The shape before the rider: the page and the data cross to be hashed.
            let act = self.act();
            for b in [page_text.as_bytes(), data.as_bytes()] {
                let put = StoreCall::BodyPut { id: s(id), act, hash: HexHash::of(b), len: b.len() as u64,
                    offset: 0, chunk: b.to_vec() };
                let _ = self.link.call(&put).await;
            }
        }
        let call = StoreCall::MarkPassed {
            id: s(id), version, page, data: HexHash::of(data.as_bytes()), debug,
        };
        res!(answer!(self.link.call(&call).await, MarkPassed))
    }

    // Standing files and folds
    /// The arithmetic is the child's and sends nothing (§16.3a 4): what a write over its ceiling
    /// moves waits in the answer for [`standing_settle`](Self::standing_settle) (UNBLOCK-18 F6).
    async fn standing_retired(&self, root: FileRoot, path: &str, text: String)
        -> Outcome<Landed>
    {
        // STATE.md lands by section (PL-A2): the store reads, the child lands, as the local host.
        if crate::tools::standing_leaf(path) == Some(crate::tools::STATE_FILE) && !off("state") {
            let id = crate::tools::diamond_of_path(path);
            let call = StoreCall::StateRead { id: id.clone(), root, path: s(path) };
            let (old, touched) = res!(res!(answer!(self.link.call(&call).await, StateRead)));
            // Read as `state_landed` reads them: absent is empty, and `from` is what was read.
            let old = match old {
                Some(r) => Some(res!(self.get(&id, &r).await)),
                None    => None,
            };
            let touched = match touched {
                Some(r) => res!(self.get(&id, &r).await),
                None    => Vec::new(),
            };
            let from = crate::diamond_versions::Seen::of(old.as_deref());
            let utf8 = |b: Vec<u8>, what: &str| match String::from_utf8(b) {
                Ok(t)   => Ok(t),
                Err(e)  => Err(err!(e, "The store's {} of '{}' is not UTF-8.", what, path;
                    Decode, Wire)),
            };
            let old = res!(utf8(old.unwrap_or_default(), "STATE.md"));
            let touched = res!(utf8(touched, "touched record"));
            let mut out = crate::store::diamond::state_split(&old, text, &touched,
                crate::store::own::now_ms() as u64, &crate::store::diamond::today());
            out.from = Some(from);
            return Ok(out);
        }
        let landed = match standing_split(path, text) {
            Retire::Keep(text) if !off("standing") => Landed::kept(text),
            // The red: the arithmetic's answer as if every write moved, so a plain write crosses.
            Retire::Keep(text)  => Landed::moved(path, crate::store::diamond::Retired {
                kept: text.clone(), retired: text, said: String::new() }),
            Retire::Move(r)     => Landed::moved(path, r),
        };
        Ok(landed)
    }
    /// A phase with nothing to settle sends nothing; otherwise one `standing_settle` carries
    /// that phase's side files alone, each body uploaded first (held-lock settle P2).
    async fn standing_settle(&self, root: FileRoot, path: &str, landed: &Landed,
        phase: SettlePhase) -> Outcome<()>
    {
        let landed = landed.part(phase);
        if let Some(r) = self.gathering(path, &landed, phase) {
            return r;
        }
        if landed.settles_nothing() {
            return Ok(());
        }
        let id = crate::tools::diamond_of_path(path);
        let mut have: Vec<&[u8]> = Vec::new();
        let archive = landed.archive.iter().map(|(leaf, t)| {
            have.push(t.as_bytes());
            (leaf.clone(), BodyRef::of(t.as_bytes()))
        }).collect();
        let call = StoreCall::StandingSettle {
            id: id.clone(), root, path: s(path), phase, archive,
            noted: landed.noted.clone(), touched: landed.touched.clone(), at: landed.at,
        };
        res!(answer!(self.send(&id, call, &have).await, StandingSettle))
    }
    async fn absorb_fold_notes(&self, id: &str, notes: &FoldNotes) -> Option<FoldNotes> {
        let call = StoreCall::AbsorbFoldNotes { id: s(id), notes: notes.clone() };
        answer!(self.link.call(&call).await, AbsorbFoldNotes).unwrap_or(None)
    }

    // Links
    async fn add_link(
        &self,
        owner: &str,
        from:  &str,
        to:    &str,
        rel:   &str,
        note:  &str,
        by:    &str,
    )
        -> Outcome<String>
    {
        let call = StoreCall::AddLink {
            owner: s(owner), from: s(from), to: s(to), rel: s(rel), note: s(note), by: s(by),
        };
        res!(answer!(self.link.call(&call).await, AddLink))
    }
    async fn all_links(&self) -> Outcome<String> {
        res!(answer!(self.link.call(&StoreCall::AllLinks {}).await, AllLinks))
    }
    async fn links_json(&self, node_ref: &str) -> Outcome<String> {
        res!(answer!(self.link.call(&StoreCall::LinksJson { node_ref: s(node_ref) }).await,
            LinksJson))
    }
    /// A removal answers a count; the links left are read back by `links_page`, a view that is
    /// never written back (see [`Unlinked`](crate::store::call::Unlinked)).
    async fn remove_link_by_model(&self, owner: &str, link_id: &str) -> Outcome<Unlink> {
        let call = StoreCall::RemoveLinkByModel { owner: s(owner), link_id: s(link_id) };
        let got = res!(res!(answer!(self.link.call(&call).await, RemoveLinkByModel)));
        let left = match got {
            crate::store::call::Unlinked::Removed { .. } if !off("unlink") =>
                res!(self.links_left(owner)),
            _ => Vec::new(),
        };
        Ok(got.rebuild(left))
    }
    async fn diamond_exists(&self, id: &str) -> bool {
        answer!(self.link.call(&StoreCall::DiamondExists { id: s(id) }).await, DiamondExists)
            .unwrap_or(false)
    }

    // The activity record and the no-progress K (PORT-PL-B).  A record that cannot be read is
    // none, as the store's own reader answers an unreadable file; the turn crosses as its line.
    async fn activity_read_all(&self, id: &str) -> Vec<(String, String)> {
        match answer!(self.link.call(&StoreCall::ActivityReadAll { id: s(id) }).await,
            ActivityReadAll)
        {
            Ok(Ok(files)) => files,
            _             => Vec::new(),
        }
    }
    async fn activity_append(&self, id: &str, turn: crate::activity::Turn, now: i64)
        -> Outcome<()>
    {
        let line = crate::activity::encode(&crate::activity::Entry::Turn(turn));
        let now = if now < 0 { 0 } else { now as u64 };
        res!(answer!(self.link.call(&StoreCall::ActivityAppend { id: s(id), line, now }).await,
            ActivityAppend))
    }
    async fn no_progress_rounds(&self, id: &str) -> usize {
        answer!(self.link.call(&StoreCall::NoProgressRounds { id: s(id) }).await,
            NoProgressRounds).unwrap_or(0)
    }

    // A turn's captures and copies
    /// A refusal is the answer, told in the act's (D1int); it is no longer kept for `drain_turn`.
    fn capture(&self, id: &str, raw: &str, change: Change) -> Outcome<()> {
        let have = bodies_of(&change);
        let mut wire = WireChange::refer(&change);
        if off("large") {
            if let crate::diamond_versions::Body::Held(b) = &change.after {
                wire.after = WireBody::Held(BodyRef::of(b));
            }
        }
        let call = StoreCall::Capture { id: s(id), raw: s(raw), change: wire };
        match answer!(self.send_blocking(id, call, &have), Capture) {
            Ok(Ok(()))                          => Ok(()),
            Ok(Err(_)) | Err(_) if off("keep")  => Ok(()),
            Ok(Err(e)) | Err(e)                 => Err(e),
        }
    }
    fn captured_room(&self, id: &str, path: &str, found: &Found, copy: Option<u64>,
        destroying: bool, room: u64) -> Result<bool, Short>
    {
        let call = StoreCall::CapturedRoom {
            id: s(id), path: s(path), found: found.clone(), copy, destroying, room,
        };
        // A store that refuses the claim is the reason the act is refused, said as the store
        // said it -- never a turn cap the turn did not reach (LOUD-FAIL, rc-a ruling B1).
        match answer!(self.link.call_blocking(&call), CapturedRoom) {
            Ok(r)                   => r,
            Err(_) if off("loud")   => Err(Short::Count),
            Err(e)                  => Err(Short::Store(fmt!("the store refused captured_room for \
                keeper '{}': {}", id, e.plain()))),
        }
    }
    async fn keep_room(&self, id: &str) -> u64 {
        answer!(self.link.call(&StoreCall::KeepRoom { id: s(id) }).await, KeepRoom).unwrap_or(0)
    }
    fn release(&self, id: &str, path: &str) {
        let _ = self.link.call_blocking(&StoreCall::Release { id: s(id), path: s(path) });
    }
    /// Read by key, page after page, sorted by path.  A failed page ends the list with what came.
    fn held_under(&self, id: &str, from: &str) -> Vec<(String, String, String)> {
        let mut all: Vec<(String, String, String)> = Vec::new();
        loop {
            let call = StoreCall::HeldUnder {
                id:     s(id),
                from:   s(from),
                after:  all.last().map(|e| e.0.clone()),
            };
            match answer!(self.link.call_blocking(&call), HeldUnder) {
                Ok(page) if !page.is_empty() && off("held") => { all.extend(page); return all; }
                Ok(page) if !page.is_empty()    => all.extend(page),
                _                               => return all,
            }
        }
    }
    async fn this_turn_found(&self, id: &str, path: &str, now: &[u8]) -> TurnFound {
        let call = StoreCall::ThisTurnFound { id: s(id), path: s(path), now: BodyRef::of(now) };
        let wire = match answer!(self.send_blocking(id, call, &[now]), ThisTurnFound) {
            Ok(w)   => w,
            Err(_)  => return TurnFound::Was(now.to_vec()),
        };
        wire.resolve(now, &mut |r| self.get_blocking(id, r))
            .unwrap_or_else(|_| TurnFound::Was(now.to_vec()))
    }
    async fn turns_found(&self, id: &str, path: &str, now: &[u8]) -> Option<Vec<u8>> {
        let call = StoreCall::TurnsFound { id: s(id), path: s(path), now: BodyRef::of(now) };
        match answer!(self.send(id, call, &[now]).await, TurnsFound) {
            Ok(None)                => None,
            Ok(Some(r)) if r.names(now) => Some(now.to_vec()),
            Ok(Some(r))             => Some(self.get(id, &r).await.unwrap_or_else(|_| now.to_vec())),
            Err(_)                  => Some(now.to_vec()),
        }
    }
    async fn measured_against(&self, id: &str, path: &str, now: &[u8]) -> Vec<u8> {
        let call = StoreCall::MeasuredAgainst { id: s(id), path: s(path), now: BodyRef::of(now) };
        match answer!(self.send(id, call, &[now]).await, MeasuredAgainst) {
            Ok(r) if r.names(now) && !off("mine") => now.to_vec(),
            Ok(r)                   => self.get(id, &r).await.unwrap_or_else(|_| now.to_vec()),
            Err(_)                  => now.to_vec(),
        }
    }
    fn seals_spent(&self, id: &str, path: &str, now: &[u8]) -> bool {
        let call = StoreCall::SealsSpent { id: s(id), path: s(path), now: BodyRef::of(now) };
        answer!(self.send_blocking(id, call, &[now]), SealsSpent).unwrap_or(true)
    }
    async fn seal_run(&self, id: &str, path: &str, now: &[u8]) -> Outcome<()> {
        let call = StoreCall::SealRun { id: s(id), path: s(path), now: BodyRef::of(now) };
        res!(answer!(self.send(id, call, &[now]).await, SealRun))
    }
    async fn pend(&self, id: &str, path: &str, before: &[u8], deleting: bool, mark: bool)
        -> Outcome<bool>
    {
        let call = StoreCall::Pend {
            id: s(id), path: s(path), before: BodyRef::of(before), deleting, mark,
        };
        res!(answer!(self.send(id, call, &[before]).await, Pend))
    }
    async fn unpend(&self, id: &str, path: &str) {
        let _ = self.link.call(&StoreCall::Unpend { id: s(id), path: s(path) }).await;
    }
    /// A lost mark is kept, so the turn end never trusts its captures after a command it did not
    /// see (D1r1 check D-Q1d).
    fn ran_opaque(&self, id: &str) {
        match answer!(self.link.call_blocking(&StoreCall::RanOpaque { id: s(id) }), RanOpaque) {
            Ok(())                      => (),
            Err(_) if off("opaque")     => (),
            Err(e)                      => self.keep(id, e),
        }
    }
    /// By hash alone: the bytes are not uploaded.
    async fn note_output(&self, id: &str, tool: &str, path: &str, bytes: &[u8]) {
        let call = StoreCall::NoteOutput {
            id: s(id), tool: s(tool), path: s(path), bytes: BodyRef::of(bytes),
        };
        let _ = self.link.call(&call).await;
    }
    async fn output_is_own(&self, id: &str, tool: &str, path: &str, bytes: &[u8]) -> bool {
        let call = StoreCall::OutputIsOwn {
            id: s(id), tool: s(tool), path: s(path), bytes: BodyRef::of(bytes),
        };
        answer!(self.link.call(&call).await, OutputIsOwn).unwrap_or(false)
    }
    /// The store's refusal is the caller's to say (LOUD-FAIL): it sends no file as the
    /// Diamond's, which is the safe side, and says why.
    async fn made_files(&self, id: &str) -> Outcome<Vec<(String, String)>> {
        match answer!(self.link.call(&StoreCall::MadeFiles { id: s(id) }).await, MadeFiles) {
            Ok(m)                   => Ok(m),
            Err(_) if off("loud")   => Ok(Vec::new()),
            Err(e)                  => Err(e),
        }
    }
    /// The store's refusal is the caller's to say (LOUD-FAIL): those files are then the user's to
    /// the next command, and the turn end says the record lacks them.
    async fn ran_made(&self, id: &str, by: Option<Author>, files: Vec<(String, String, bool)>,
        capped: bool) -> Outcome<()>
    {
        match answer!(self.link.call(&StoreCall::RanMade { id: s(id), by, files, capped }).await,
            RanMade)
        {
            Ok(())                  => Ok(()),
            Err(_) if off("loud")   => Ok(()),
            Err(e)                  => Err(e),
        }
    }
    fn theirs(&self, id: &str, path: &str) -> bool {
        answer!(self.link.call_blocking(&StoreCall::Theirs { id: s(id), path: s(path) }), Theirs)
            .unwrap_or(true)
    }
    fn folder_of(&self, path: &str) -> Option<String> {
        answer!(self.link.call_blocking(&StoreCall::FolderOf { path: s(path) }), FolderOf)
            .unwrap_or(None)
    }
    fn versionable(&self, id: &str, path: &str) -> bool {
        answer!(self.link.call_blocking(&StoreCall::Versionable { id: s(id), path: s(path) }),
            Versionable).unwrap_or(true)
    }
    async fn authored_by_user(&self, id: &str, path: &str, now: &[u8]) -> bool {
        let call = StoreCall::AuthoredByUser { id: s(id), path: s(path), now: BodyRef::of(now) };
        answer!(self.send(id, call, &[now]).await, AuthoredByUser).unwrap_or(true)
    }
    fn change_refused(&self, id: &str, path: &str) -> bool {
        answer!(self.link.call_blocking(&StoreCall::ChangeRefused { id: s(id), path: s(path) }),
            ChangeRefused).unwrap_or(true)
    }
    fn refuse_change(&self, id: &str, path: &str) {
        let _ = self.link.call_blocking(&StoreCall::RefuseChange { id: s(id), path: s(path) });
    }

    // Deletes from the open folder
    fn open_delete_room(&self, id: &str, file: &str) -> OpenDelete {
        answer!(self.link.call_blocking(&StoreCall::OpenDeleteRoom { id: s(id), file: s(file) }),
            OpenDeleteRoom).unwrap_or(OpenDelete::Stopped(0))
    }
    fn open_delete_answer(&self, id: &str, ticket: u64, allow: bool) {
        let _ = self.link.call_blocking(&StoreCall::OpenDeleteAnswer { id: s(id), ticket, allow });
    }
    fn open_delete_release(&self, id: &str, file: &str) {
        let _ = self.link.call_blocking(&StoreCall::OpenDeleteRelease { id: s(id), file: s(file) });
    }

    // Windows around a call
    async fn open_window(&self, id: &str, by: Option<Author>) -> Ticket<L> {
        let got = answer!(self.link.call(&StoreCall::OpenWindow { id: s(id), by }).await,
            OpenWindow);
        Ticket::new(&self.link, got.ok())
    }
    async fn close_window(&self, around: Ticket<L>) {
        if let Some(window) = around.take() {
            let _ = self.link.call(&StoreCall::CloseWindow { window }).await;
        }
    }

    // Versions
    async fn versions_record(
        &self,
        id:      &str,
        cause:   Cause,
        turn:    &str,
        note:    &str,
        change:  Change,
    )
        -> Outcome<Option<(u64, Vec<String>)>>
    {
        let (note_w, mut have) = wire_text(note);
        have.extend(bodies_of(&change));
        let call = StoreCall::VersionsRecord {
            id:         s(id),
            cause,
            turn:       s(turn),
            note:       note_w,
            change:     WireChange::refer(&change),
        };
        let got = answer!(self.send(id, call, &have).await, VersionsRecord);
        self.names(id, res!(got)).await
    }
    async fn versions_body(&self, id: &str, hash: &str) -> Outcome<Option<Vec<u8>>> {
        let hash = match HexHash::new(hash) {
            Ok(h)   => h,
            Err(_)  => return Err(crate::store::diamond::not_a_body(hash)),  // the direct words
        };
        let call = StoreCall::VersionsBody { id: s(id), hash };
        match res!(res!(answer!(self.link.call(&call).await, VersionsBody))) {
            None    => Ok(None),
            Some(r) => Ok(Some(res!(self.get(id, &r).await))),
        }
    }
    async fn versions_undo_target(&self, id: &str, path: &str, at: Option<u64>)
        -> Outcome<Option<(u64, String, bool, Option<String>)>>
    {
        let call = StoreCall::VersionsUndoTarget { id: s(id), path: s(path), at };
        res!(answer!(self.link.call(&call).await, VersionsUndoTarget))
    }

    // Restores
    fn route_here(&self, row: &str, row_folder: Option<&str>, landed: &str, overwrites: bool)
        -> Route
    {
        let call = StoreCall::RouteHere {
            row: s(row), row_folder: row_folder.map(s), landed: s(landed), overwrites,
        };
        answer!(self.link.call_blocking(&call), RouteHere).unwrap_or(Route::Left)
    }
    /// A fault answers `None`, which every caller refuses on as a restore ended.
    fn restore_store(&self, ticket: u64) -> Option<String> {
        self.restore_of(ticket).unwrap_or(None)
    }
    fn restore_route(
        &self,
        ticket:  u64,
        spelled: &str,
        landed:  &str,
        now:     Option<&[u8]>,
        puts:    Option<&[u8]>,
    )
        -> Act
    {
        let id = match self.restore_of(ticket) {
            Ok(id)  => id,
            Err(_)  => return Act::Unanswered,
        };
        let call = StoreCall::RestoreRoute {
            ticket,
            spelled:    s(spelled),
            landed:     s(landed),
            now:        now.map(BodyRef::of),
            puts:       puts.map(BodyRef::of),
        };
        let have: Vec<&[u8]> = now.into_iter().chain(puts).collect();
        // No restore open: no Diamond to upload into, so the call goes alone (D1r1d), and where
        // the binding says no restore holds the ticket, the answer is the direct store's, which
        // with no handout is `act`'s first arm whatever the bodies.
        let r = match id {
            Some(id)    => self.send_blocking(&id, call, &have),
            None        => self.link.call_blocking(&call),
        };
        if no_restore(&r, ticket) {
            return crate::diamond_versions::act(None, landed, None, now, puts);
        }
        answer!(r, RestoreRoute).unwrap_or(Act::Unanswered)
    }
    fn restore_look(&self, ticket: u64, spelled: &str, now: Seen) -> Option<bool> {
        let call = StoreCall::RestoreLook { ticket, spelled: s(spelled), now };
        answer!(self.link.call_blocking(&call), RestoreLook).unwrap_or(None)
    }
    fn restore_asked(&self, ticket: u64, spelled: &str, now: Seen) {
        let _ = self.link.call_blocking(&StoreCall::RestoreAsked {
            ticket, spelled: s(spelled), now,
        });
    }
    async fn restore_keep(&self, ticket: u64, path: &str, now: Option<&[u8]>, deleting: bool)
        -> Outcome<()>
    {
        let call = StoreCall::RestoreKeep { ticket, path: s(path), now: now.map(BodyRef::of), deleting };
        let have: Vec<&[u8]> = now.into_iter().collect();
        let r = match res!(self.restore_of(ticket)) {
            Some(id)    => self.send(&id, call, &have).await,
            None        => self.link.call(&call).await,     // no restore open (D1r1d)
        };
        if no_restore(&r, ticket) {
            return Err(restore_ended(path));
        }
        res!(answer!(r, RestoreKeep))
    }
    async fn restore_let_go(&self, ticket: u64, path: &str) {
        let _ = self.link.call(&StoreCall::RestoreLetGo { ticket, path: s(path) }).await;
    }
    /// A refusal is kept for the restore's Diamond's `drain_turn`, as a capture's is.  Where that
    /// Diamond could not be asked, or none is open and the call is refused on other grounds, it is
    /// kept for the run, which every turn end checks.
    /// A refusal is the answer, as `capture`'s, and a fault asking for the restore's Diamond too.
    fn restore_landed(&self, ticket: u64, change: Change) -> Outcome<()> {
        let id = match self.restore_of(ticket) {
            Ok(id)                          => id,
            Err(_) if off("restore_fault")  => None,
            Err(e)                          => return Err(e),
        };
        let have = bodies_of(&change);
        let call = StoreCall::RestoreLanded { ticket, change: WireChange::refer(&change) };
        let r = match &id {
            Some(id)    => self.send_blocking(id, call, &have),
            None        => self.link.call_blocking(&call),      // no restore open (D1r1d)
        };
        if no_restore(&r, ticket) {
            return Ok(());  // the direct store keeps nothing for a restore that is not open
        }
        match answer!(r, RestoreLanded) {
            Ok(Ok(()))          => Ok(()),
            Ok(Err(e)) | Err(e) => Err(e),
        }
    }

    // The turn end
    async fn hold_versions(&self, id: &str) -> Outcome<Ticket<L>> {
        let h = res!(res!(answer!(self.link.call(&StoreCall::HoldVersions { id: s(id) }).await,
            HoldVersions)));
        Ok(Ticket::new(&self.link, Some(h)))
    }
    /// A refusal is the store's reason, for the turn end to say (LOUD-FAIL): never "steering",
    /// which stopped the turn end before `hold_versions` and recorded nothing, silently.
    fn is_steering(&self, id: &str) -> Outcome<bool> {
        match answer!(self.link.call_blocking(&StoreCall::IsSteering { id: s(id) }), IsSteering) {
            Ok(b)                   => Ok(b),
            Err(_) if off("loud")   => Ok(true),
            Err(e)                  => Err(e),
        }
    }
    fn steering(&self, id: &str) -> Ticket<L> {
        let got = answer!(self.link.call_blocking(&StoreCall::Steering { id: s(id) }), Steering);
        Ticket::new(&self.link, got.ok())
    }
    fn drain_dirty(&self, id: &str) -> Vec<Ticket<L>> {
        answer!(self.link.call_blocking(&StoreCall::DrainDirty { id: s(id) }), DrainDirty)
            .unwrap_or_default()
            .into_iter()
            .map(|h| Ticket::new(&self.link, Some(h)))
            .collect()
    }
    /// The dirty group records through `versions_record_dirty` (R7a), so no change crosses here:
    /// the marks are let go and none is answered.
    async fn dirty_changes(&self, _id: &str, dirty: Vec<Ticket<L>>) -> Vec<Change> {
        drop(dirty);
        Vec::new()
    }
    /// The turn's snapshot, read and staged through `ctx` ([`turn`]), then the slot's drain.  A
    /// lost opaque-run mark refuses the turn end.
    async fn drain_turn<H: Host>(&self, hold: &Ticket<L>, id: &str, ctx: &ToolContext<H>)
        -> Outcome<Drained>
    {
        if let Some(e) = self.kept_of(id) {
            return Err(err!(e, "A command's mark for '{}' this turn was lost by the store.", id;
                Invalid, Input));
        }
        let hold = match hold.handle() {
            Some(h) => h,
            None    => return Err(err!("No versions hold of '{}' was given.", id; Missing, Data)),
        };
        res!(self.stage_turn(id, ctx).await);
        if off("late") {
            // The red of the late-arrival rule: a second snapshot, taken after the first's reads.
            res!(self.stage_turn(id, ctx).await);
        }
        res!(answer!(self.link.call(&StoreCall::DrainTurn { hold, id: s(id) }).await, DrainTurn))
    }
    async fn turn_uncovered(&self, hold: &Ticket<L>, id: &str, wrote: &[String])
        -> Outcome<Vec<String>>
    {
        let hold = match hold.handle() {
            Some(h) => h,
            None    => return Err(err!("No versions hold of '{}' was given.", id; Missing, Data)),
        };
        let mut all = Vec::new();
        for page in wrote.chunks(crate::store::call::LIST_PAGE) {
            let call = StoreCall::TurnUncovered { hold, id: s(id), wrote: page.to_vec() };
            all.extend(res!(res!(answer!(self.link.call(&call).await, TurnUncovered))));
        }
        Ok(all)
    }
    async fn turn_add(&self, hold: &Ticket<L>, id: &str, change: Change) -> Outcome<()> {
        let hold = match hold.handle() {
            Some(h) => h,
            None    => return Err(err!("No versions hold of '{}' was given.", id; Missing, Data)),
        };
        let have = bodies_of(&change);
        let call = StoreCall::TurnAdd { hold, id: s(id), change: WireChange::refer(&change) };
        res!(answer!(self.send(id, call, &have).await, TurnAdd))
    }
    async fn drain_windows(&self, hold: &Ticket<L>, id: &str) -> Outcome<u32> {
        let hold = match hold.handle() {
            Some(h) => h,
            None    => return Err(err!("No versions hold of '{}' was given.", id; Missing, Data)),
        };
        res!(answer!(self.link.call(&StoreCall::DrainWindows { hold, id: s(id) }).await,
            DrainWindows))
    }
    async fn versions_record_held(
        &self,
        hold:  &Ticket<L>,
        id:    &str,
        at:    Option<u64>,
        cause: Cause,
        turn:  &str,
        note:  &str,
    )
        -> Outcome<Option<(u64, Vec<String>)>>
    {
        let hold = match hold.handle() {
            Some(h) => h,
            None    => return Err(err!("No versions hold of '{}' was given.", id; Missing, Data)),
        };
        let (note_w, have) = wire_text(note);
        let call = StoreCall::VersionsRecordHeld {
            hold, id: s(id), at, cause, turn: s(turn), note: note_w,
        };
        let got = answer!(self.send(id, call, &have).await, VersionsRecordHeld);
        self.names(id, res!(got)).await
    }
    async fn record_steer(&self, hold: &Ticket<L>, id: &str, json: &str, instruction: &str)
        -> Outcome<u64>
    {
        let hold = match hold.handle() {
            Some(h) => h,
            None    => return Err(err!("No versions hold of '{}' was given.", id; Missing, Data)),
        };
        let (json_w, mut have) = wire_text(json);
        let (instruction_w, more) = wire_text(instruction);
        have.extend(more);
        let call = StoreCall::RecordSteer { hold, id: s(id), json: json_w, instruction: instruction_w };
        res!(answer!(self.send(id, call, &have).await, RecordSteer))
    }
    fn end_turn_counts(&self, id: &str) {
        let _ = self.link.call_blocking(&StoreCall::EndTurnCounts { id: s(id) });
    }

    // Marks and the trail
    async fn live_bounds(&self, live: &Live) -> Outcome<Vec<Bound>> {
        res!(answer!(self.link.call(&StoreCall::LiveBounds { live: live.clone() }).await,
            LiveBounds))
    }
    async fn reach(&self, target: &Live) -> Outcome<Reach> {
        match answer!(self.link.call(&StoreCall::Reach { target: target.clone() }).await, Reach) {
            Ok(r)   => r,
            Err(e)  => Err(err!(e, "{}", crate::marks::UNREAD; Invalid, Input)),
        }
    }
    fn trail(&self, what: &str, detail: &str) {
        let _ = self.link.call_blocking(&StoreCall::Trail { what: s(what), detail: s(detail) });
    }

    // The run journals (U4e): each round in `BODY_CHUNK` chunks, as a body crosses.
    async fn journal_put(&self, run: &str, round: u64, record: &[u8]) -> Outcome<()> {
        self.record_put(run, JournalKey::Round(round), record).await
    }
    async fn journal_read(&self, run: &str) -> Outcome<Vec<(u64, Vec<u8>)>> {
        let mut out = Vec::new();
        let mut from = 0;
        loop {
            let round = match res!(self.record_read(run, JournalKey::Round(from)).await) {
                Some((JournalKey::Round(r), bytes)) => { out.push((r, bytes)); r },
                _ => return Ok(out),
            };
            from = match round.checked_add(1) {
                Some(n) => n,
                None    => return Ok(out),
            };
        }
    }
    async fn journal_drop(&self, run: &str) -> Outcome<()> {
        res!(answer!(self.link.call(&StoreCall::JournalDrop { run: s(run) }).await, JournalDrop))
    }
}

#[cfg(test)]
#[path = "remote_tests.rs"]
mod tests;

#[path = "remote_turn.rs"]
mod turn;
