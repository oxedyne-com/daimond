//! NativeHost's fs port: the run's own workspace on this machine's disk (R1 capture gate).
//!
//! The runner runs the HOSTED tool half, the one the tab runs, so a `file_write` or a
//! `file_delete` there is the tab's door: the write fence's licence first, the copy into the
//! keeper's store (the parent's, over the pipe) before the bytes go, and a History row at the
//! turn end.  This port is only where the bytes land.  Every path is the workspace's, jailed by
//! [`Workspace`]: a follow-links act (a read, a write, a listing, a folder made) goes where
//! [`Workspace::real_followed`] proves it lands, and an act on the link itself (a delete, a move)
//! goes through the folder [`Workspace::pin`] holds open.  The run's Landlock fence is the second
//! wall behind both.
//!
//! A port with no workspace (the default host) refuses every call, as LocalHost's does.
//!
//! **A store-owned path is the store's, never the disk's** (HL5a, lead ruling 3; I-HL5).  A path
//! at or under `diamonds/<id>/` ([`store_owned`]) is a runner Diamond's: its standing files, their
//! `.daimond/` archive and touched record, its crystal.  Its reads (`exists`, `is_directory`,
//! `list_dir`, `list_dir_stamped`, `read_file`, `read_file_capped`, `read_file_range`, and so the
//! walk, grep and `recall` over them) go to the parent's store over the pipe
//! ([`RemoteStore::store_file_read`], [`RemoteStore::store_file_list`]).  What is not there is
//! absent; what stands there and will not read is an `Err`, never absent and never empty (I-HL4).
//! A file a command left on the disk at such a path is not read, and the turn's reply says so
//! ([`NativeFs::strays`]).
//!
//! **Its writes are the store's too** (HL5b, lead ruling 2; HL5c).  A write of a Diamond's file --
//! its standing files, its crystal, its work files -- is one store op, its compare, a standing
//! file's ARCHIVE settle and its bytes under the store's lock for the file; a folder, a delete or
//! a move there is one store op too ([`RemoteStore::store_file_act`]).  Its keeper records
//! (`versions/`, `.daimond/`, `.red/`) and `meta.json` are refused ([`store_writable`]), and a move
//! across a Diamond's edge is refused, so nothing store-owned lands on this disk.  The version rows
//! come as in the tab: the tool's capture and the turn end, through the store.
//!
//! [`RemoteStore::store_file_act`]: crate::store::remote::RemoteStore::store_file_act
//! [`store_writable`]: crate::tools::store_writable
//!
//! **A rule for staged writes (SW r2):** a staged write must exempt a store-owned path, which is
//! never the run's disk to stage.

use crate::{
    diamond_versions::Seen,
    engine::host::{
        fs::HostFs,
        local::fs::unavailable,
        types::store::FileAct,
    },
    tools::{
        FileRoot,
        Licence,
        Storage,
        storage_for,
        store_owned,
        STORE_ROOT,
    },
    workspace::Workspace,
};
use super::NativeStore;

use oxedyne_fe2o3_core::prelude::*;

use std::{
    future::Future,
    io::Read,
    path::PathBuf,
    sync::Arc,
};

/// The most store-owned files on the disk a turn's reply names; the rest are counted.
pub const STRAYS_NAMED: usize = 16;
/// The most entries the search for them visits, so a vast folder cannot hold the turn end.
const STRAYS_VISIT: usize = 10_000;

/// NativeHost's fs port: the run's workspace, or none, and the store a store-owned path is read
/// from, or none.
#[derive(Clone, Default)]
pub struct NativeFs {
    ws:     Option<Workspace>,
    store:  Option<Arc<NativeStore>>,
}

impl std::fmt::Debug for NativeFs {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NativeFs").field("ws", &self.ws).field("store", &self.store.is_some())
            .finish()
    }
}

/// What a store-owned read found: the store's answer, or the path is not store-owned.
enum Owned<T> {
    Store(Outcome<T>),
    Disk,
}

impl NativeFs {

    /// The port over `ws`.
    pub fn over(ws: Workspace) -> Self { Self { ws: Some(ws), store: None } }

    /// This port, reading a store-owned path from `store` (NativeHost's own).
    pub fn reading(self, store: Arc<NativeStore>) -> Self {
        Self { store: Some(store), ..self }
    }

    /// The store that owns `path` under `root`, with the Diamond's id, or `None` where the path
    /// is the disk's.  A store-owned path on a port with no store is refused, never read from the
    /// disk (I-HL5).
    fn owner(&self, root: FileRoot, path: &str, method: &str)
        -> Option<Outcome<(String, &NativeStore)>>
    {
        // A test's red: the rule off, every path reads from the disk.
        if crate::store::diamond::off("store_owned") {
            return None;
        }
        let id = match store_owned(root, path) {
            Some(id)    => id,
            None        => return None,
        };
        Some(match &self.store {
            Some(st)    => Ok((id, st.as_ref())),
            None        => Err(err!("fs.{}: '{}' is a Diamond's file, which is the store's, and \
                this port has no store to read it from.", method, path; IO, File, Missing)),
        })
    }

    /// At most `max` bytes of a store-owned `path` with its whole length, `None` where nothing
    /// stands there; [`Owned::Disk`] where the path is not store-owned.
    async fn owned_read(&self, root: FileRoot, path: &str, max: u32, method: &str)
        -> Owned<Option<(Vec<u8>, u64)>>
    {
        match self.owner(root, path, method) {
            None                => Owned::Disk,
            Some(Err(e))        => Owned::Store(Err(e)),
            Some(Ok((id, st)))  => Owned::Store(st.store_file_read(&id, path, max).await),
        }
    }

    /// A store-owned folder's listing; [`Owned::Disk`] where the path is not store-owned.
    async fn owned_list(&self, root: FileRoot, path: &str, method: &str)
        -> Owned<Vec<(String, bool, u64, Option<f64>)>>
    {
        match self.owner(root, path, method) {
            None                => Owned::Disk,
            Some(Err(e))        => Owned::Store(Err(e)),
            Some(Ok((id, st)))  => Owned::Store(st.store_file_list(&id, path).await),
        }
    }

    /// Whether a store-owned `path` stands, and whether it is a folder: `None` absent.  A file
    /// that will not read, and is not a folder, is the read's `Err`.
    async fn owned_entry(&self, root: FileRoot, path: &str, method: &str)
        -> Owned<Option<bool>>
    {
        let read = match self.owned_read(root, path, 0, method).await {
            Owned::Disk         => return Owned::Disk,
            Owned::Store(r)     => r,
        };
        Owned::Store(match read {
            Ok(Some(_))         => Ok(Some(false)),
            Ok(None)            => Ok(None),
            // It stands and will not read as a file: a folder, if it lists as one.
            Err(e)              => match self.owned_list(root, path, method).await {
                Owned::Store(Ok(_)) => Ok(Some(true)),
                _                   => Err(e),
            },
        })
    }

    /// The files at a store-owned path on this run's disk, which no read takes in (HL5a): at
    /// most [`STRAYS_NAMED`] of them, workspace-relative, and how many more there are.  A
    /// command can leave one there (a `run` that writes `diamonds/<id>/STATE.md`); the turn's
    /// reply names them rather than letting them pass unseen.
    pub fn strays(&self) -> (Vec<String>, usize) {
        let mut named: Vec<String> = Vec::new();
        let mut more = 0usize;
        let ws = match &self.ws {
            Some(w) => w,
            None    => return (named, more),
        };
        let top = match ws.real_followed(STORE_ROOT) {
            Ok(Some(p)) => p,
            _           => return (named, more),
        };
        let mut visited = 0usize;
        let mut todo: Vec<(PathBuf, String)> = vec![(top, STORE_ROOT.to_string())];
        while let Some((dir, rel)) = todo.pop() {
            let rd = match std::fs::read_dir(&dir) {
                Ok(rd)  => rd,
                Err(_)  => continue,
            };
            for entry in rd {
                visited += 1;
                if visited > STRAYS_VISIT {
                    return (named, more);
                }
                let e = match entry {
                    Ok(e)   => e,
                    Err(_)  => continue,
                };
                let name = fmt!("{}/{}", rel, e.file_name().to_string_lossy());
                // The entry itself, never what a link leads to.
                let kind = match std::fs::symlink_metadata(e.path()) {
                    Ok(m)   => m.file_type(),
                    Err(_)  => continue,
                };
                if kind.is_dir() {
                    todo.push((e.path(), name));
                } else if store_owned(FileRoot::Opfs, &name).is_some() {
                    if named.len() < STRAYS_NAMED {
                        named.push(name);
                    } else {
                        more += 1;
                    }
                }
            }
        }
        named.sort();
        (named, more)
    }

    /// The workspace, or the refusal a port with none gives.
    fn ws(&self, method: &str) -> Outcome<&Workspace> {
        match &self.ws {
            Some(w) => Ok(w),
            None    => unavailable("fs", method),
        }
    }

    /// The workspace for `root`.  The machine root is the tab's name for a folder reached
    /// through the hand; on the runner the workspace IS the machine, and nothing else is.
    fn rooted(&self, root: FileRoot, method: &str) -> Outcome<&Workspace> {
        match root {
            FileRoot::Workspace | FileRoot::Opfs => self.ws(method),
            FileRoot::Machine                    => unavailable("fs", method),
        }
    }

    /// Where `path` really lands for an act that follows links, or the refusal of a path a link
    /// carries out of the workspace.
    fn followed(&self, root: FileRoot, path: &str, method: &str) -> Outcome<PathBuf> {
        let ws = res!(self.rooted(root, method));
        match res!(ws.real_followed(path)) {
            Some(p) => Ok(p),
            None    => Err(err!("fs.{}: '{}' leads out of the workspace.", method, path;
                Security, IO, File, Invalid)),
        }
    }

    /// The bytes at `path`, or `None` where nothing stands there.
    fn bytes_now(&self, root: FileRoot, path: &str, method: &str) -> Outcome<Option<Vec<u8>>> {
        let abs = res!(self.followed(root, path, method));
        match std::fs::read(&abs) {
            Ok(b)                                                  => Ok(Some(b)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound      => Ok(None),
            Err(e) => Err(err!(e, "fs.{}: cannot read '{}'.", method, path; IO, File, Read)),
        }
    }

    fn put(&self, root: FileRoot, path: &str, content: &[u8], method: &str) -> Outcome<()> {
        let abs = res!(self.followed(root, path, method));
        if abs.is_dir() {
            return Err(err!("fs.{}: '{}' is a folder.", method, path; IO, File, Write, Invalid));
        }
        if let Some(parent) = abs.parent() {
            res!(std::fs::create_dir_all(parent)
                .map_err(|e| err!(e, "fs.{}: cannot make the folders for '{}'.", method, path;
                    IO, File, Write)));
        }
        res!(std::fs::write(&abs, content)
            .map_err(|e| err!(e, "fs.{}: cannot write '{}'.", method, path; IO, File, Write)));
        Ok(())
    }

    /// The one held write behind `write_licensed`, `write_licensed_if` and `write_licensed_then`:
    /// compare, then `pre`, then the bytes.
    ///
    /// **A store-owned path is one store op** (HL5b, lead ruling 2): its lock is the parent
    /// store's, so the whole sequence crosses as one [`RemoteStore::store_write_then`], with
    /// `pre`'s ARCHIVE settle gathered into it rather than sent on its own
    /// ([`RemoteStore::gather`]); no lock is held across a wire round trip, and nothing lands on
    /// this disk.  A keeper record or `meta.json` is refused here, as the store refuses it
    /// ([`NativeFs::writable`]).
    ///
    /// **Any other path** has no lock table (held-lock settle P1, review 5): the compare and the
    /// `put` have no await between them, and the child runs one turn on a current-thread runtime,
    /// so the pair is already atomic in-process.  A `pre` step would open an await between them,
    /// so a write with one (`Some`) is refused there, before its compare and with `pre` never
    /// run.  `None` is the no-op.
    ///
    /// [`RemoteStore::store_write_then`]: crate::store::remote::RemoteStore::store_write_then
    /// [`RemoteStore::gather`]: crate::store::remote::RemoteStore::gather
    async fn held_write<P, F>(&self, root: FileRoot, lic: &Licence, content: &[u8],
        expect: Option<&Seen>, pre: Option<P>, method: &str) -> Outcome<Option<Seen>>
    where
        P: FnOnce() -> F,
        F: Future<Output = Outcome<()>>,
    {
        match self.owner(root, lic.path(), method) {
            None                => {},
            Some(Err(e))        => return Err(e),
            Some(Ok((id, st)))  => {
                res!(Self::writable(lic.path(), method));
                let archive = match pre {
                    None    => Vec::new(),
                    // A test's red: `pre` run un-gathered, its ARCHIVE sent on its own before
                    // the store compares (the child's QA-A2).
                    Some(p) if crate::store::diamond::off("gather") => {
                        res!(p().await);
                        Vec::new()
                    },
                    Some(p) => {
                        res!(st.gather(lic.path()));
                        let ran = p().await;
                        let archive = st.gathered();
                        res!(ran);
                        archive
                    },
                };
                return st.store_write_then(&id, lic.path(), content, expect, &archive).await;
            },
        }
        if pre.is_some() {
            return Err(err!("fs.{}: a held write of '{}' with a step before its bytes land is \
                refused here: the runner's disk has no lock to hold across that step, and only a \
                store-owned path, whose lock is the store's, may take one.", method, lic.path();
                IO, File, Write, Unimplemented));
        }
        if let Some(want) = expect {
            if let Seen::Unread = want {
                return Err(err!("fs.{}: a write of '{}' was bound to bytes that could not be \
                    read, so there is nothing to compare.", method, lic.path();
                    IO, File, Write, Invalid));
            }
            let now = res!(self.bytes_now(root, lic.path(), method));
            let found = Seen::of(now.as_deref());
            if &found != want {
                return Ok(Some(found));
            }
        }
        res!(self.put(root, lic.path(), content, method));
        Ok(None)
    }

    /// A store-owned `path` this port may change through the store ([`store_writable`], HL5c):
    /// any file or folder of a Diamond's but its keeper records and `meta.json`, which are the
    /// store's own to write.
    ///
    /// [`store_writable`]: crate::tools::store_writable
    fn writable(path: &str, method: &str) -> Outcome<()> {
        match crate::tools::store_writable(path) {
            true    => Ok(()),
            false   => Err(err!("fs.{}: '{}' is a Diamond's own record, which only the store \
                writes, so nothing was changed.", method, path; IO, File, Write, Unauthorised)),
        }
    }

    /// A folder, delete or move of a store-owned path, sent to the store as one
    /// [`RemoteStore::store_file_act`] (HL5c), never done on this disk; `None` where `path` is the
    /// disk's.  A move with one end in a Diamond and one out of it, or across two, is refused: the
    /// store moves only inside the one Diamond.
    ///
    /// [`RemoteStore::store_file_act`]: crate::store::remote::RemoteStore::store_file_act
    async fn owned_act(&self, root: FileRoot, path: &str, act: FileAct, method: &str)
        -> Option<Outcome<()>>
    {
        let to = match &act {
            FileAct::Move(to)   => Some(self.owner(root, to, method).map(|o| o.map(|(id, _)| id))),
            _                   => None,
        };
        let (id, st) = match self.owner(root, path, method) {
            None                => match to {
                Some(Some(_))   => return Some(Err(self.across(path, method))),
                _               => return None,
            },
            Some(Err(e))        => return Some(Err(e)),
            Some(Ok(o))         => o,
        };
        match to {
            Some(Some(Ok(ref other))) if *other == id => {},
            Some(Some(Err(e)))  => return Some(Err(e)),
            Some(_)             => return Some(Err(self.across(path, method))),
            None                => {},
        }
        if let Err(e) = Self::writable(path, method) {
            return Some(Err(e));
        }
        if let FileAct::Move(to) = &act {
            if let Err(e) = Self::writable(to, method) {
                return Some(Err(e));
            }
        }
        Some(st.store_file_act(&id, path, act).await)
    }

    /// The refusal of a move across a Diamond's edge.
    fn across(&self, path: &str, method: &str) -> Error<ErrTag> {
        err!("fs.{}: '{}' would move across a Diamond's edge, which a run does not do: a Diamond's \
            files move only within it, so nothing was moved.", method, path;
            IO, File, Write, Unauthorised)
    }

    fn listed(&self, root: FileRoot, path: &str, method: &str)
        -> Outcome<Vec<(String, bool, u64, Option<f64>)>>
    {
        let abs = res!(self.followed(root, path, method));
        let rd = res!(std::fs::read_dir(&abs)
            .map_err(|e| err!(e, "fs.{}: no folder '{}'.", method, path; IO, File, Missing)));
        let mut out = Vec::new();
        for entry in rd {
            let e = match entry {
                Ok(e)  => e,
                Err(_) => continue,
            };
            let name = e.file_name().to_string_lossy().to_string();
            let meta = match e.metadata() {
                Ok(m)  => m,
                Err(_) => continue,
            };
            let stamp = meta.modified().ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as f64);
            out.push((name, meta.is_dir(), if meta.is_dir() { 0 } else { meta.len() }, stamp));
        }
        out.sort_by(|a, b| a.0.cmp(&b.0));
        Ok(out)
    }
}

/// The turn's reply line for the store-owned files on the run's disk ([`NativeFs::strays`]), or
/// nothing where there are none: refused in words, never silently passed over (HL5a).
pub fn strays_said(named: &[String], more: usize) -> String {
    if named.is_empty() {
        return String::new();
    }
    let mut list = named.iter().map(|p| fmt!("'{}'", p)).collect::<Vec<_>>().join(", ");
    if more > 0 {
        list = fmt!("{} and {} more", list, more);
    }
    let (stands, were) = if named.len() + more == 1 { ("stands", "it was") } else { ("stand", "they were") };
    fmt!("Refused: {} {} on this run's disk under {}/, which is the store's. A Diamond's files are \
        read from the store, never from the disk, so {} not taken in and the Diamond does not \
        hold {}. Write a Diamond's files with file_write or file_edit, never with a command.",
        list, stands, STORE_ROOT, were, if named.len() + more == 1 { "it" } else { "them" })
}

impl HostFs for NativeFs {
    // The run's folder stands open: it is the disk, never browser storage.
    fn folder_open(&self) -> bool { self.ws.is_some() }

    async fn exists(&self, root: FileRoot, path: &str) -> Outcome<bool> {
        if let Owned::Store(got) = self.owned_entry(root, path, "exists").await {
            return Ok(res!(got).is_some());
        }
        let abs = res!(self.followed(root, path, "exists"));
        Ok(abs.exists())
    }

    async fn is_directory(&self, root: FileRoot, path: &str) -> Outcome<bool> {
        if let Owned::Store(got) = self.owned_entry(root, path, "is_directory").await {
            return Ok(res!(got) == Some(true));
        }
        let abs = res!(self.followed(root, path, "is_directory"));
        Ok(abs.is_dir())
    }

    async fn list_dir(&self, root: FileRoot, path: &str) -> Outcome<Vec<(String, bool, u64)>> {
        let got = match self.owned_list(root, path, "list_dir").await {
            Owned::Store(got)   => res!(got),
            Owned::Disk         => res!(self.listed(root, path, "list_dir")),
        };
        Ok(got.into_iter().map(|(n, d, l, _)| (n, d, l)).collect())
    }

    async fn list_dir_stamped(&self, root: FileRoot, path: &str)
        -> Outcome<Vec<(String, bool, u64, Option<f64>)>>
    {
        if let Owned::Store(got) = self.owned_list(root, path, "list_dir_stamped").await {
            return got;
        }
        self.listed(root, path, "list_dir_stamped")
    }

    async fn read_file(&self, root: FileRoot, path: &str) -> Outcome<Vec<u8>> {
        if let Owned::Store(got) = self.owned_read(root, path, u32::MAX, "read_file").await {
            return match res!(got) {
                Some((b, _))    => Ok(b),
                None            => Err(err!("fs.read_file: no file '{}'.", path; IO, File, Missing)),
            };
        }
        match res!(self.bytes_now(root, path, "read_file")) {
            Some(b) => Ok(b),
            None    => Err(err!("fs.read_file: no file '{}'.", path; IO, File, Missing)),
        }
    }

    async fn read_file_capped(&self, root: FileRoot, path: &str, max: u32)
        -> Outcome<(Vec<u8>, f64)>
    {
        if let Owned::Store(got) = self.owned_read(root, path, max, "read_file_capped").await {
            return match res!(got) {
                Some((b, total))    => Ok((b, total as f64)),
                None                => Err(err!("fs.read_file_capped: no file '{}'.", path;
                    IO, File, Missing)),
            };
        }
        let abs = res!(self.followed(root, path, "read_file_capped"));
        let f = res!(std::fs::File::open(&abs)
            .map_err(|e| err!(e, "fs.read_file_capped: no file '{}'.", path; IO, File, Missing)));
        let size = match f.metadata() {
            Ok(m)  => m.len() as f64,
            Err(e) => return Err(err!(e, "fs.read_file_capped: cannot stat '{}'.", path; IO, File)),
        };
        let mut b = Vec::new();
        res!(f.take(max as u64).read_to_end(&mut b)
            .map_err(|e| err!(e, "fs.read_file_capped: cannot read '{}'.", path; IO, File, Read)));
        Ok((b, size))
    }

    async fn read_file_range(&self, root: FileRoot, path: &str, offset: f64, len: u32)
        -> Outcome<(Vec<u8>, f64)>
    {
        let b = res!(self.read_file(root, path).await);
        let size = b.len() as f64;
        let from = (offset.max(0.0) as usize).min(b.len());
        let to = from.saturating_add(len as usize).min(b.len());
        Ok((b[from..to].to_vec(), size))
    }

    async fn write_licensed(&self, root: FileRoot, lic: &Licence, content: &[u8]) -> Outcome<()> {
        let none: Option<fn() -> std::future::Ready<Outcome<()>>> = None;
        match res!(self.held_write(root, lic, content, None, none, "write_licensed").await) {
            None        => Ok(()),
            // Nothing is compared, so nothing refuses; said, should a store ever answer so.
            Some(_)     => Err(err!("fs.write_licensed: the write of '{}' was refused.",
                lic.path(); IO, File, Write)),
        }
    }

    async fn write_licensed_if(&self, root: FileRoot, lic: &Licence, content: &[u8], expect: &Seen)
        -> Outcome<Option<Seen>>
    {
        let none: Option<fn() -> std::future::Ready<Outcome<()>>> = None;
        self.held_write(root, lic, content, Some(expect), none, "write_licensed_if").await
    }

    async fn write_licensed_then<P, F>(&self, root: FileRoot, lic: &Licence, content: &[u8],
        expect: Option<&Seen>, pre: P) -> Outcome<Option<Seen>>
    where
        P: FnOnce() -> F,
        F: Future<Output = Outcome<()>>,
    {
        self.held_write(root, lic, content, expect, Some(pre), "write_licensed_then").await
    }

    async fn create_dir_licensed(&self, root: FileRoot, lic: &Licence) -> Outcome<()> {
        if let Some(r) = self.owned_act(root, lic.path(), FileAct::Mkdir, "create_dir_licensed")
            .await
        {
            return r;
        }
        let abs = res!(self.followed(root, lic.path(), "create_dir_licensed"));
        if abs.is_file() {
            return Err(err!("fs.create_dir_licensed: '{}' is a file.", lic.path(); IO, File, Invalid));
        }
        res!(std::fs::create_dir_all(&abs)
            .map_err(|e| err!(e, "fs.create_dir_licensed: cannot make '{}'.", lic.path(); IO, File)));
        Ok(())
    }

    async fn delete_licensed(&self, root: FileRoot, lic: &Licence) -> Outcome<()> {
        if let Some(r) = self.owned_act(root, lic.path(), FileAct::Delete, "delete_licensed").await {
            return r;
        }
        let ws = res!(self.rooted(root, "delete_licensed"));
        // Held, not just checked: the delete acts in the folder proved inside the workspace.
        let pin = match res!(ws.pin(lic.path(), false)) {
            Some(p) => p,
            None    => return Err(err!("fs.delete_licensed: '{}' leads out of the workspace.",
                lic.path(); Security, IO, File, Invalid)),
        };
        let at = pin.act();
        // One ordinary file, never a folder: a link at the leaf is the link.
        match std::fs::symlink_metadata(&at) {
            Ok(m) if m.is_file() => {},
            Ok(_)  => return Err(err!("fs.delete_licensed: '{}' is not an ordinary file.",
                lic.path(); IO, File, Invalid)),
            Err(e) => return Err(err!(e, "fs.delete_licensed: no file '{}' to delete.",
                lic.path(); IO, File, Missing)),
        }
        res!(std::fs::remove_file(&at)
            .map_err(|e| err!(e, "fs.delete_licensed: cannot delete '{}'.", lic.path(); IO, File)));
        Ok(())
    }

    async fn move_licensed(&self, root: FileRoot, from: &Licence, to: &Licence) -> Outcome<()> {
        if let Some(r) = self.owned_act(root, from.path(), FileAct::Move(to.path().to_string()),
            "move_licensed").await
        {
            return r;
        }
        let ws = res!(self.rooted(root, "move_licensed"));
        let a = match res!(ws.pin(from.path(), false)) {
            Some(p) => p,
            None    => return Err(err!("fs.move_licensed: '{}' leads out of the workspace.",
                from.path(); Security, IO, File, Invalid)),
        };
        let b = match res!(ws.pin(to.path(), true)) {
            Some(p) => p,
            None    => return Err(err!("fs.move_licensed: '{}' leads out of the workspace.",
                to.path(); Security, IO, File, Invalid)),
        };
        res!(std::fs::rename(a.act(), b.act())
            .map_err(|e| err!(e, "fs.move_licensed: cannot move '{}' to '{}'.", from.path(),
                to.path(); IO, File)));
        Ok(())
    }

    // One folder, open: the tab's decision with its own folder open, as TestHost files it.
    fn storage_of(&self, root: FileRoot, path: &str) -> Storage {
        match &self.ws {
            Some(_) => storage_for(root, path, Some(0), ""),
            None    => Storage::Nowhere,
        }
    }

    fn thrown(&self) -> String { String::new() }
    fn take_thrown(&self) -> String { String::new() }
    fn arm_folder_watch(&self) {}
    fn notify_folder_lost(&self) {}

    // The cloud is the tab's storage, and the runner has none.
    fn children_of(&self, _dir: &str) -> Vec<(String, bool, u64)> { Vec::new() }
    async fn cloud_fetch(&self, _path: &str) -> Outcome<String> {
        unavailable("fs", "cloud_fetch")
    }
    /// A runner keeps no cloud copy, so a delete has none to forget: nothing, not a refusal, or
    /// every delete's answer would say a cloud copy was left behind.
    async fn cloud_forget_licensed(&self, _lic: &Licence) -> Outcome<String> { Ok(String::new()) }
    fn cloud_size_of(&self, _path: &str) -> Option<u64> { None }
}
