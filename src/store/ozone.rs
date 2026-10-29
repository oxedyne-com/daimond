//! The Diamond store's Ozone backend (d1_plan §3 D1o): the store's area as a path namespace
//! ([`ns`](oxedyne_fe2o3_o3db_sync::ns)) in an Ozone store of the parent's own, and its named
//! locks as an in-process table.
//!
//! **OPFS is the reference**, as for the memory store, and `store::conformance` holds this
//! backend to it: a key splits as [`mem::split`] splits it, a write makes the folders above it, a
//! move never lands on an existing entry, a non-recursive delete of a folder with anything in it
//! fails, and a conditional write or delete compares and lands in one step -- `ns` runs the
//! comparison under its mutation lane, and the [`Seen`] it compares is judged as the memory store
//! judges it: a file by the hash of its bytes, a folder or nothing as [`Seen::Absent`].
//!
//! **The parent alone opens the store.**  [`OzoneBackend::open`] is the one place Daimond starts
//! an Ozone store; Ozone's `ozone.lock` refuses a second open, in this process or another, and
//! that refusal comes back tagged `Lock` and `Conflict`.  The root is made `0700`.
//!
//! **One caller, blocking.**  `ns` is meant for a single caller thread and every call blocks
//! until Ozone acks it, so the backend is installed on the store thread and its calls stay there;
//! no call scans the store (`ns::orphans` and the sweep are never run per call).
//!
//! The handle is cheap to clone, and every clone is the same store.  The last clone dropped
//! closes the store if [`OzoneBackend::close`] has not.

use crate::{
    diamond_versions::Seen,
    store::{
        LockHow,
        Locked,
        StoreBackend,
        mem::{self, MemBackend, MemLock},
    },
};

use oxedyne_fe2o3_core::prelude::*;
use oxedyne_fe2o3_o3db_sync::{
    O3db,
    base::{
        cfg::OzoneConfig,
        constant,
    },
    data::core::RestSchemesInput,
    gateway::{self, Db, Uid},
    ns::{Capped, Entry},
};
use oxedyne_fe2o3_hash::csum::ChecksumScheme;

use std::{
    fmt,
    fs,
    os::unix::fs::{DirBuilderExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::Arc,
};

const WHO: &str = "Ozone store";

/// The `ns` space the store's area lives in.
const SPACE: &str = "diamond";

/// The log stream Ozone writes the store's lines to.
const STREAM: &str = "daimond-store";

/// The store's Ozone configuration, sized for the parent process.
///
/// Ozone's defaults otherwise: 1 MiB data files, two bots of each kind per zone, a 200 ms group-commit fsync window.
pub fn config() -> OzoneConfig {
    let mut cfg = OzoneConfig::default();
    // Two zones (the default): the store has one caller, so more zones buy no parallelism, and
    // each zone costs its own bots, caches and files; one zone would put every write behind one
    // writer's fsync window with nothing to gain.
    cfg.num_zones = 2;
    // 32 MiB over every cache, not the default 1 GiB: the parent's budget is ~100 MB RSS
    // (spec §16.3a), and the store's records are small (crystal deltas, version rows, notes);
    // a body over the cap is read from its file.  D1x2b measures RSS and may retune this.
    cfg.cache_size_limit_bytes = 32 * 1024 * 1024;
    cfg
}

/// The open store: its `ns`, and where it lives.  Dropped last, it closes the store.
struct Open {
    ns:     gateway::Ns,
    root:   PathBuf,
}

impl Drop for Open {
    fn drop(&mut self) {
        // A closed store answers at once; one never closed is stopped here, within a bound, so
        // its bots do not run on over the files and the lock goes with them.
        if let Err(e) = self.ns.db().close_within(constant::USER_REQUEST_TIMEOUT) {
            error!(e, "The Diamond store at {:?} was dropped without a close, and did not shut \
                down cleanly.", self.root);
        }
    }
}

/// The store's area in an Ozone store.
#[derive(Clone)]
pub struct OzoneBackend {
    open:   Arc<Open>,
    locks:  MemBackend, // the named locks only; no file is ever written to it
}

impl fmt::Debug for OzoneBackend {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("OzoneBackend").field("root", &self.open.root).finish()
    }
}

/// Make the store's root, `0700`, or narrow it to `0700` where it stands.
fn make_root(root: &Path) -> Outcome<()> {
    if !root.exists() {
        res!(fs::DirBuilder::new().recursive(true).mode(0o700).create(root));
    }
    res!(fs::set_permissions(root, fs::Permissions::from_mode(0o700)));
    Ok(())
}

/// The `ns` path of `key`, which may be the root.
fn path_of(key: &str) -> Outcome<String> { Ok(res!(mem::split(WHO, key)).join("/")) }

/// The `ns` path of `key`, which must name an entry.
fn entry_of(key: &str) -> Outcome<String> { Ok(res!(mem::jail(WHO, key)).join("/")) }

fn no_file<V>(key: &str) -> Outcome<V> {
    Err(err!("Ozone store: no file '{}'.", key; IO, File, Read))
}

fn unread(what: &str, key: &str) -> Outcome<Option<Seen>> {
    Err(err!("Ozone store: a {} of '{}' was bound to bytes that could not be read, so there is \
        nothing to compare.", what, key; IO, File, Write, Invalid))
}

impl OzoneBackend {

    /// The TTL sweep of folder `dir` (R1f3's `Ns::sweep_expired`): each entry at least `ttl_ms`
    /// old at `now_ms` is deleted, a folder aged from the newest mtime under it.  It reads `dir`'s
    /// index records only, never the store.  The values deleted.
    pub fn sweep_expired(&self, dir: &str, ttl_ms: u64, now_ms: u64) -> Outcome<usize> {
        let k = res!(entry_of(dir));
        self.ns().sweep_expired(&k, ttl_ms, now_ms)
    }

    /// Open (or create) the store at `root`, start it, and turn its collector on.  A store already
    /// open, here or in another process, is refused, tagged `Init`, `Lock` and `Conflict`.
    pub fn open(root: &Path) -> Outcome<Self> {
        res!(make_root(root));
        // Keyless (spec §16.1, "it holds no key"): NO at-rest encryption scheme, a CRC-32 checksum
        // alone.  The store holds no secret to key one with, and a public key would be encryption
        // in name only; the store's privacy is its root's 0700 under the kimberlite uid.
        let schemes = RestSchemesInput::new(None, None, None, Some(ChecksumScheme::new_crc32()));
        let mut db: Db = res!(O3db::new(root, Some(config()), schemes, Uid::default()));
        if let Err(e) = O3db::start(&mut db, STREAM) {
            let tags = e.tags();
            if tags.contains(&ErrTag::Lock) && tags.contains(&ErrTag::Conflict) {
                return Err(err!(e, "The Diamond store at {:?} is open already, in this process \
                    or another.  Only the parent opens it.", root; Init, Lock, Conflict));
            }
            return Err(e);
        }
        let gc = match db.updated_api() {
            Ok(api) => api.activate_gc(true),
            Err(e)  => Err(e),
        };
        if let Err(e) = gc {
            // The bots are running, so stop them before reporting the fault.
            let _ = db.shutdown();
            return Err(e);
        }
        let db = Arc::new(db);
        let ns = match gateway::Ns::new(db.clone(), Uid::default(), SPACE) {
            Ok(ns)  => ns,
            Err(e)  => {
                let _ = db.close();
                return Err(e);
            },
        };
        Ok(Self {
            open:   Arc::new(Open { ns, root: root.to_path_buf() }),
            locks:  MemBackend::default(),
        })
    }

    /// Shut the store down, waiting for its bots, and let go of its lock: from then on it can be
    /// opened again.  Every clone is closed with it.
    pub fn close(&self) -> Outcome<()> {
        self.open.ns.db().close()
    }

    pub fn root(&self) -> &Path { &self.open.root }

    fn ns(&self) -> &gateway::Ns { &self.open.ns }

    /// What stands at `path`, found as `entry`, as a [`Seen`], judged as the memory store judges
    /// it: a file by its bytes, a folder or nothing as `Absent`.
    fn seen(&self, path: &str, entry: Option<&Entry>) -> Outcome<Seen> {
        match entry {
            Some(e) if !e.is_dir    => Ok(Seen::of(res!(self.ns().get(path)).as_deref())),
            _                       => Ok(Seen::Absent),
        }
    }

    fn write_if(&self, key: &str, bytes: &[u8], expect: Option<&Seen>) -> Outcome<Option<Seen>> {
        let k = res!(entry_of(key));
        let want = match expect {
            None                => {
                res!(self.ns().put(&k, bytes));
                return Ok(None);
            },
            Some(Seen::Unread)  => return unread("write", key),
            Some(want)          => want,
        };
        // OPFS makes the folders above on its way down, before it compares (`opfs.rs` ~654), so
        // they stand whatever the compare says, and a file in the way fails the write.
        if let Some((parent, _)) = k.rsplit_once('/') {
            if let Err(e) = self.ns().make_dirs(parent) {
                if e.tags().contains(&ErrTag::Conflict) {
                    return Err(err!(e, "Ozone store: a file stands above '{}', so it cannot be \
                        made.", key; IO, File, Write));
                }
                return Err(e);
            }
        }
        let mut found = Seen::Absent;
        let mut fault = None;
        let put = res!(self.ns().put_if(&k, bytes, |e| match self.seen(&k, e) {
            Ok(s)   => {
                let go = &s == want && !matches!(e, Some(e) if e.is_dir);
                found = s;
                go
            },
            Err(x)  => {
                fault = Some(x);
                false
            },
        }));
        if let Some(x) = fault {
            return Err(x);
        }
        if put {
            Ok(None)
        } else if &found != want {
            Ok(Some(found))
        } else {
            // It compared (a folder reads as nothing there), but a file cannot replace a folder.
            Err(err!("Ozone store: '{}' is a folder, not a file.", key; IO, File, Write))
        }
    }

    fn list(&self, dir: &str) -> Outcome<Vec<(String, bool, u64, Option<f64>)>> {
        let k = res!(path_of(dir));
        match res!(self.ns().list(&k)) {
            None        => Err(err!("Ozone store: no folder '{}' to list.", dir; IO, File, Read)),
            Some(live)  => Ok(live.into_iter()
                .map(|(name, e)| if e.is_dir {
                    (name, true, 0, None)
                } else {
                    (name, false, e.size, Some(e.mtime_ms as f64))
                })
                .collect()),
        }
    }
}

impl StoreBackend for OzoneBackend {
    type Lock = MemLock;

    async fn read_file(&self, key: &str) -> Outcome<Vec<u8>> {
        let k = res!(entry_of(key));
        match res!(self.ns().get_capped(&k, u64::MAX)) {
            Capped::Whole(b)    => Ok(b),
            _                   => no_file(key),
        }
    }

    async fn read_file_capped(&self, key: &str, max: u32) -> Outcome<(Vec<u8>, f64)> {
        let k = res!(entry_of(key));
        match res!(self.ns().get_capped(&k, max as u64)) {
            Capped::Absent      => no_file(key),
            Capped::Whole(b)    => {
                let total = b.len() as f64;
                Ok((b, total))
            },
            // `ns` reads a value whole or not at all, so the head of one over the cap is cut from
            // the whole value.
            Capped::Over(total) => match res!(self.ns().get(&k)) {
                Some(mut b) => {
                    b.truncate(max as usize);
                    Ok((b, total as f64))
                },
                None        => no_file(key),
            },
        }
    }

    async fn write_file(&self, key: &str, bytes: &[u8]) -> Outcome<()> {
        match res!(self.write_if(key, bytes, None)) {
            None    => Ok(()),
            Some(_) => Err(err!("Ozone store: an unconditional write of '{}' was refused as \
                changed.", key; IO, File, Write, Bug)),
        }
    }

    async fn write_file_if(&self, key: &str, bytes: &[u8], expect: Option<&Seen>)
        -> Outcome<Option<Seen>>
    {
        self.write_if(key, bytes, expect)
    }

    async fn exists(&self, key: &str) -> Outcome<bool> {
        let k = res!(entry_of(key));
        Ok(res!(self.ns().stat(&k)).is_some())
    }

    async fn list_dir(&self, dir: &str) -> Outcome<Vec<(String, bool, u64)>> {
        Ok(res!(self.list(dir))
            .into_iter()
            .map(|(name, is_dir, size, _)| (name, is_dir, size))
            .collect())
    }

    async fn list_dir_stamped(&self, dir: &str) -> Outcome<Vec<(String, bool, u64, Option<f64>)>> {
        self.list(dir)
    }

    async fn stamp(&self, key: &str) -> Outcome<Option<(f64, f64)>> {
        let k = res!(entry_of(key));
        Ok(match res!(self.ns().stat(&k)) {
            Some(e) if !e.is_dir    => Some((e.mtime_ms as f64, e.size as f64)),
            _                       => None,
        })
    }

    async fn delete_file(&self, key: &str) -> Outcome<()> {
        let k = res!(entry_of(key));
        if res!(self.ns().delete_if(&k, |e| matches!(e, Some(e) if !e.is_dir))) {
            Ok(())
        } else {
            Err(err!("Ozone store: '{}' is not a file, so it was not removed.", key;
                Invalid, Input, Path))
        }
    }

    async fn delete_file_if(&self, key: &str, expect: &Seen) -> Outcome<Option<Seen>> {
        if let Seen::Unread = expect {
            return unread("delete", key);
        }
        let k = res!(entry_of(key));
        let mut found = Seen::Absent;
        let mut fault = None;
        let gone = res!(self.ns().delete_if(&k, |e| match self.seen(&k, e) {
            Ok(s)   => {
                // Only a file goes: a folder compares as nothing there, and is left standing.
                let go = &s == expect && matches!(e, Some(e) if !e.is_dir);
                found = s;
                go
            },
            Err(x)  => {
                fault = Some(x);
                false
            },
        }));
        if let Some(x) = fault {
            return Err(x);
        }
        if gone || &found == expect {
            Ok(None)
        } else {
            Ok(Some(found))
        }
    }

    async fn delete_entry(&self, key: &str, recursive: bool) -> Outcome<()> {
        let k = res!(entry_of(key));
        match res!(self.ns().stat(&k)) {
            None                    => Err(err!("Ozone store: nothing at '{}' to remove.", key;
                IO, File)),
            Some(e) if e.is_dir && recursive => {
                res!(self.ns().delete_tree(&k));
                Ok(())
            },
            // A file, or a folder `ns` removes only while it is empty.
            Some(_)                 => {
                res!(self.ns().delete(&k));
                Ok(())
            },
        }
    }

    async fn move_entry(&self, from: &str, to: &str) -> Outcome<()> {
        let (s, d) = (res!(entry_of(from)), res!(entry_of(to)));
        if res!(self.ns().stat(&d)).is_some() {
            return Err(err!("'{}' already exists.", to; Invalid, Input));
        }
        res!(self.ns().rename(&s, &d));
        Ok(())
    }

    async fn lock(&self, name: &str, how: LockHow) -> Locked<MemLock> {
        self.locks.lock(name, how).await
    }

    async fn lock_held(&self, name: &str) -> Option<bool> {
        self.locks.lock_held(name).await
    }

    async fn release(&self, lock: MemLock) {
        self.locks.release(lock).await
    }
}

#[cfg(test)]
#[path = "../../tests/unit/store/ozone/tests.rs"]
pub(crate) mod tests;
