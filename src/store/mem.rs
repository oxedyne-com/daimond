//! The Diamond store's in-memory backend (d1_plan §9.2 D1cm): the store's area as a map of keys,
//! and its named locks as an in-process table.
//!
//! OPFS is the reference.  Every primitive answers as `wasm::opfs` does on the store's own area:
//! parents are made by a write, a move never lands on an existing entry, a non-recursive delete of
//! a folder with anything in it fails, and a conditional write or delete compares and lands in one
//! step.  `store::conformance` holds both to that.
//!
//! The handle is cheap to clone, and every clone is the same store.

use crate::{
    diamond_versions::Seen,
    store::{LockHow, Locked, StoreBackend},
};

use oxedyne_fe2o3_core::prelude::*;

use std::{
    collections::{BTreeMap, BTreeSet},
    future::poll_fn,
    path::{Component, Path},
    sync::{Arc, Mutex, MutexGuard},
    task::{Poll, Waker},
    time::Duration,
};

/// One file: its bytes and when they were written, in ms since the epoch.
#[derive(Clone, Debug)]
struct File {
    bytes:  Vec<u8>,
    mtime:  f64,
}

/// A named lock: whether it is held, and who waits for it, one waker per waiter by its number.
#[derive(Debug, Default)]
struct Slot {
    held:       bool,
    waiters:    Vec<(u64, Waker)>,
}

#[derive(Debug, Default)]
struct Area {
    files:  BTreeMap<String, File>,
    dirs:   BTreeSet<String>,   // every folder but the root, which always stands
    locks:  BTreeMap<String, Slot>, // only locks someone holds or waits for
    waiter: u64,                // the last number given to a waiter
    #[cfg(test)]
    cas_off: bool,              // `write_if` writes whatever it finds (D1x1b's red)
    #[cfg(test)]
    unreadable: BTreeSet<String>, // QA: keys whose read fails though the file stands
    #[cfg(test)]
    unprobeable: BTreeSet<String>, // PLF-NF: keys whose lookup fails other than not-found
}

/// The store's area held in memory.
#[derive(Clone, Debug, Default)]
pub struct MemBackend {
    area: Arc<Mutex<Area>>,
}

/// A lock held on a [`MemBackend`], given back when released or dropped, at once either way.
#[derive(Debug)]
pub struct MemLock {
    area: Arc<Mutex<Area>>,
    name: String,
}

impl Drop for MemLock {
    fn drop(&mut self) {
        let mut a = lock_area(&self.area);
        // Every waiter is woken, and each that still wants the lock asks again, so the entry goes.
        if let Some(slot) = a.locks.remove(&self.name) {
            for (_, w) in slot.waiters {
                w.wake();
            }
        }
    }
}

/// A waiter's place in a lock's queue, given up when the wait ends or is dropped (a time-out).
struct Waiting<'a> {
    area:   &'a Mutex<Area>,
    name:   &'a str,
    id:     Option<u64>,
}

impl Drop for Waiting<'_> {
    fn drop(&mut self) {
        if let Some(id) = self.id {
            let mut a = lock_area(self.area);
            if let Some(slot) = a.locks.get_mut(self.name) {
                slot.waiters.retain(|(w, _)| *w != id);
                if !slot.held && slot.waiters.is_empty() {
                    a.locks.remove(self.name);
                }
            }
        }
    }
}

/// The area, taken whole.  A panic elsewhere while it was held leaves nothing half done, since no
/// step below panics between its read and its write, so a poisoned guard is taken as it stands.
fn lock_area(area: &Mutex<Area>) -> MutexGuard<'_, Area> {
    match area.lock() {
        Ok(g)  => g,
        Err(p) => p.into_inner(),
    }
}

/// `key`'s components as OPFS splits them: a leading `/` dropped, `.` skipped, `..` popping one,
/// and never above the root.  `who` names the store in a refusal; the Ozone store splits its keys
/// here too, so both answer one key alike.
pub(super) fn split(who: &str, key: &str) -> Outcome<Vec<String>> {
    let rel = key.trim_start_matches('/');
    let mut out: Vec<String> = Vec::new();
    for comp in Path::new(rel).components() {
        match comp {
            Component::Normal(c) => out.push(c.to_string_lossy().to_string()),
            Component::CurDir    => {},
            Component::ParentDir => if out.pop().is_none() {
                return Err(err!("{}: path '{}' escapes the store's root.", who, key;
                    Invalid, Input, Path));
            },
            Component::RootDir | Component::Prefix(_) => {
                return Err(err!("{}: absolute path '{}' is not allowed.", who, key;
                    Invalid, Input, Path));
            },
        }
    }
    Ok(out)
}

/// As [`split`], for a path that must name an entry rather than the root.
pub(super) fn jail(who: &str, key: &str) -> Outcome<Vec<String>> {
    let out = res!(split(who, key));
    if out.is_empty() {
        return Err(err!("{}: path '{}' has no file component.", who, key; Invalid, Input, Path));
    }
    Ok(out)
}

const WHO: &str = "Memory store";

fn now_ms() -> f64 {
    match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        Ok(d)  => d.as_millis() as f64,
        Err(_) => 0.0,
    }
}

impl Area {

    fn is_dir(&self, key: &str) -> bool { key.is_empty() || self.dirs.contains(key) }

    /// Do the folders above the entry `comps` names all stand?
    fn parent_stands(&self, comps: &[String]) -> bool {
        (1..comps.len()).all(|i| self.dirs.contains(&comps[..i].join("/")))
    }

    /// Make every folder above `comps`, as a write does; a file in the way refuses.
    fn make_parents(&mut self, comps: &[String], key: &str) -> Outcome<()> {
        for i in 1..comps.len() {
            let dir = comps[..i].join("/");
            if self.files.contains_key(&dir) {
                return Err(err!("Memory store: '{}' is a file, so '{}' cannot be made under it.",
                    dir, key; IO, File, Write));
            }
            self.dirs.insert(dir);
        }
        Ok(())
    }

    /// Make the folder `comps` and every folder above it.
    fn make_dir(&mut self, comps: &[String], key: &str) -> Outcome<()> {
        res!(self.make_parents(comps, key));
        let dir = comps.join("/");
        if self.files.contains_key(&dir) {
            return Err(err!("Memory store: '{}' is a file, not a folder.", key; IO, File, Write));
        }
        self.dirs.insert(dir);
        Ok(())
    }

    /// What stands at `key` as a [`Seen`]: a folder or nothing is [`Seen::Absent`], as OPFS finds
    /// no file handle there.
    fn seen(&self, key: &str) -> Seen {
        match self.files.get(key) {
            Some(f) => Seen::of(Some(&f.bytes)),
            None    => Seen::Absent,
        }
    }

    /// The entries strictly below the folder `dir` ("" is the root), as keys.
    fn below(&self, dir: &str) -> (Vec<String>, Vec<String>) {
        let pre = if dir.is_empty() { String::new() } else { fmt!("{}/", dir) };
        let files = self.files.range(pre.clone()..)
            .take_while(|(k, _)| k.starts_with(&pre))
            .map(|(k, _)| k.clone())
            .collect();
        let dirs = self.dirs.range(pre.clone()..)
            .take_while(|k| k.starts_with(&pre))
            .cloned()
            .collect();
        (files, dirs)
    }

    fn write_if(&mut self, key: &str, bytes: &[u8], expect: Option<&Seen>) -> Outcome<Option<Seen>> {
        let comps = res!(jail(WHO, key));
        let k = comps.join("/");
        if let Some(Seen::Unread) = expect {
            return Err(err!("Memory store: a write of '{}' was bound to bytes that could not be \
                read, so there is nothing to compare.", key; IO, File, Write, Invalid));
        }
        // Parents first, as OPFS descends with `create` before it compares.
        res!(self.make_parents(&comps, key));
        // Then the compare, before the folder check, as OPFS finds no file handle on a folder
        // before it fails to open one.
        if let Some(want) = expect.filter(|_| self.compares()) {
            let found = self.seen(&k);
            if &found != want {
                return Ok(Some(found));
            }
        }
        if self.dirs.contains(&k) {
            return Err(err!("Memory store: '{}' is a folder, not a file.", key; IO, File, Write));
        }
        self.files.insert(k, File { bytes: bytes.to_vec(), mtime: now_ms() });
        Ok(None)
    }

    #[cfg(test)]
    fn compares(&self) -> bool { !self.cas_off }

    #[cfg(not(test))]
    #[inline(always)]
    fn compares(&self) -> bool { true }

    fn list(&self, dir: &str) -> Outcome<Vec<(String, bool, u64, Option<f64>)>> {
        let k = res!(split(WHO, dir)).join("/");
        if !self.is_dir(&k) {
            return Err(err!("Memory store: no folder '{}' to list.", dir; IO, File, Read));
        }
        let pre = if k.is_empty() { String::new() } else { fmt!("{}/", k) };
        let mut out = Vec::new();
        for (key, f) in self.files.range(pre.clone()..).take_while(|(key, _)| key.starts_with(&pre)) {
            let name = &key[pre.len()..];
            if !name.contains('/') {
                out.push((name.to_string(), false, f.bytes.len() as u64, Some(f.mtime)));
            }
        }
        for key in self.dirs.range(pre.clone()..).take_while(|key| key.starts_with(&pre)) {
            let name = &key[pre.len()..];
            if !name.contains('/') {
                out.push((name.to_string(), true, 0, None));
            }
        }
        Ok(out)
    }

    fn delete_entry(&mut self, key: &str, recursive: bool) -> Outcome<()> {
        let comps = res!(jail(WHO, key));
        let k = comps.join("/");
        if !self.parent_stands(&comps) {
            return Err(err!("Memory store: no folder above '{}'.", key; IO, File));
        }
        if self.files.remove(&k).is_some() {
            return Ok(());
        }
        if !self.dirs.contains(&k) {
            return Err(err!("Memory store: nothing at '{}' to remove.", key; IO, File));
        }
        let (files, dirs) = self.below(&k);
        if !recursive && !(files.is_empty() && dirs.is_empty()) {
            return Err(err!("Memory store: '{}' is a folder with something in it, and the remove \
                was not recursive.", key; IO, File));
        }
        for f in files {
            self.files.remove(&f);
        }
        for d in dirs {
            self.dirs.remove(&d);
        }
        self.dirs.remove(&k);
        Ok(())
    }

    fn move_entry(&mut self, from: &str, to: &str) -> Outcome<()> {
        let src = res!(jail(WHO, from));
        let dst = res!(jail(WHO, to));
        let (s, d) = (src.join("/"), dst.join("/"));
        if self.parent_stands(&dst) && (self.files.contains_key(&d) || self.dirs.contains(&d)) {
            return Err(err!("'{}' already exists.", to; Invalid, Input));
        }
        if let Some(f) = self.files.get(&s).cloned() {
            if !self.parent_stands(&src) {
                return Err(err!("Memory store: no folder above '{}'.", from; IO, File, Read));
            }
            res!(self.make_parents(&dst, to));
            self.files.insert(d, f);
            self.files.remove(&s);
            return Ok(());
        }
        if !self.dirs.contains(&s) {
            return Err(err!("Memory store: nothing at '{}' to move.", from; IO, File, Read));
        }
        if d.starts_with(&fmt!("{}/", s)) {
            return Err(err!("Memory store: '{}' cannot be moved into itself at '{}'.", from, to;
                Invalid, Input));
        }
        res!(self.make_dir(&dst, to));
        let (files, dirs) = self.below(&s);
        for dir in &dirs {
            self.dirs.insert(fmt!("{}{}", d, &dir[s.len()..]));
        }
        for f in &files {
            if let Some(file) = self.files.remove(f) {
                self.files.insert(fmt!("{}{}", d, &f[s.len()..]), file);
            }
        }
        for dir in dirs {
            self.dirs.remove(&dir);
        }
        self.dirs.remove(&s);
        Ok(())
    }
}

impl MemBackend {

    /// The TTL sweep of folder `dir`, as Ozone's `Ns::sweep_expired` (R1f3) judges it: each entry
    /// whose age at `now_ms` is at least `ttl_ms` is deleted, a file aged from its mtime and a
    /// folder from the newest mtime under it (one with none, from 0); a mtime after `now_ms` is
    /// age 0.  The files deleted; a folder that does not stand has none.
    pub fn sweep_expired(&self, dir: &str, ttl_ms: u64, now_ms: u64) -> Outcome<usize> {
        let k = res!(split(WHO, dir)).join("/");
        let mut a = self.area();
        if !a.is_dir(&k) {
            return Ok(0);
        }
        let pre = if k.is_empty() { String::new() } else { fmt!("{}/", k) };
        let mut newest: BTreeMap<String, f64> = BTreeMap::new();
        for (key, f) in a.files.range(pre.clone()..).take_while(|(key, _)| key.starts_with(&pre)) {
            let name = key[pre.len()..].split('/').next().unwrap_or("").to_string();
            let n = newest.entry(name).or_insert(0.0);
            if f.mtime > *n { *n = f.mtime; }
        }
        for key in a.dirs.range(pre.clone()..).take_while(|key| key.starts_with(&pre)) {
            let name = key[pre.len()..].split('/').next().unwrap_or("").to_string();
            newest.entry(name).or_insert(0.0);
        }
        let mut gone = 0;
        for (name, at) in newest {
            let age = now_ms.saturating_sub(at.max(0.0) as u64);
            if name.is_empty() || age < ttl_ms {
                continue;
            }
            let path = fmt!("{}{}", pre, name);
            if a.files.remove(&path).is_some() {
                gone += 1;
                continue;
            }
            let (files, dirs) = a.below(&path);
            gone += files.len();
            for f in files {
                a.files.remove(&f);
            }
            for d in dirs {
                a.dirs.remove(&d);
            }
            a.dirs.remove(&path);
        }
        Ok(gone)
    }

    /// Every file's bytes by key: what a test compares two stores by.
    #[cfg(test)]
    pub fn files(&self) -> BTreeMap<String, Vec<u8>> {
        self.area().files.iter().map(|(k, f)| (k.clone(), f.bytes.clone())).collect()
    }

    fn area(&self) -> MutexGuard<'_, Area> { lock_area(&self.area) }

    /// Switches the compare-and-swap check off: from now on `write_file_if` writes whatever it
    /// finds (the red control of `tests_serial`'s two-client race).
    #[cfg(test)]
    pub fn cas_off(&self) { self.area().cas_off = true; }

    /// QA: the read of `key` fails while the file stands, as an OPFS read under another handle does.
    #[cfg(test)]
    pub fn unreadable(&self, key: &str) { self.area().unreadable.insert(key.to_string()); }

    /// PLF-NF: every lookup of `key` fails other than not-found, as a wasm `getFileHandle`
    /// rejecting with anything but `NotFoundError` does: `exists` and a bound write's compare
    /// are then faults, never "absent".
    #[cfg(test)]
    pub fn unprobeable(&self, key: &str) { self.area().unprobeable.insert(key.to_string()); }

    /// The PLF-NF fault on `key` at `phase`, if one is set.
    #[cfg(test)]
    fn probe_fault(&self, key: &str, phase: &str) -> Outcome<()> {
        let k = res!(jail(WHO, key)).join("/");
        if self.area().unprobeable.contains(&k) {
            return crate::diamond_versions::lookup_failed(Some("NotReadableError"), key, phase)
                .map(|_| ());
        }
        Ok(())
    }

    /// Wait until `name` is free, then hold it.  A waiter polled again replaces its own waker,
    /// and one dropped before it is granted takes its waker with it.
    async fn acquire(&self, name: &str) -> MemLock {
        let mut waiting = Waiting { area: &self.area, name, id: None };
        poll_fn(|cx| {
            let mut a = self.area();
            let id = match waiting.id {
                Some(id) => id,
                None     => {
                    a.waiter += 1;
                    waiting.id = Some(a.waiter);
                    a.waiter
                },
            };
            let slot = a.locks.entry(name.to_string()).or_default();
            slot.waiters.retain(|(w, _)| *w != id);
            if slot.held {
                slot.waiters.push((id, cx.waker().clone()));
                Poll::Pending
            } else {
                slot.held = true;
                Poll::Ready(MemLock { area: self.area.clone(), name: name.to_string() })
            }
        }).await
    }
}

impl StoreBackend for MemBackend {
    type Lock = MemLock;

    async fn read_file(&self, key: &str) -> Outcome<Vec<u8>> {
        let k = res!(jail(WHO, key)).join("/");
        #[cfg(test)]
        if self.area().unreadable.contains(&k) {
            return Err(err!("Memory store: '{}' would not read (QA fault).", key; IO, File, Read));
        }
        match self.area().files.get(&k) {
            Some(f) => Ok(f.bytes.clone()),
            None    => Err(err!("Memory store: no file '{}'.", key; IO, File, Read)),
        }
    }

    async fn read_file_capped(&self, key: &str, max: u32) -> Outcome<(Vec<u8>, f64)> {
        let k = res!(jail(WHO, key)).join("/");
        #[cfg(test)]
        if self.area().unreadable.contains(&k) {
            return Err(err!("Memory store: '{}' would not read (QA fault).", key; IO, File, Read));
        }
        match self.area().files.get(&k) {
            Some(f) => {
                let n = f.bytes.len().min(max as usize);
                Ok((f.bytes[..n].to_vec(), f.bytes.len() as f64))
            },
            None    => Err(err!("Memory store: no file '{}'.", key; IO, File, Read)),
        }
    }

    async fn write_file(&self, key: &str, bytes: &[u8]) -> Outcome<()> {
        match res!(self.area().write_if(key, bytes, None)) {
            None    => Ok(()),
            Some(_) => Err(err!("Memory store: an unconditional write of '{}' was refused as \
                changed.", key; IO, File, Write, Bug)),
        }
    }

    async fn write_file_if(&self, key: &str, bytes: &[u8], expect: Option<&Seen>)
        -> Outcome<Option<Seen>>
    {
        #[cfg(test)]
        if expect.is_some() {
            res!(self.probe_fault(key, "compare before a bound write"));
        }
        self.area().write_if(key, bytes, expect)
    }

    async fn exists(&self, key: &str) -> Outcome<bool> {
        #[cfg(test)]
        res!(self.probe_fault(key, "existence probe"));
        let comps = res!(jail(WHO, key));
        let a = self.area();
        if !a.parent_stands(&comps) {
            return Ok(false);
        }
        let k = comps.join("/");
        Ok(a.files.contains_key(&k) || a.dirs.contains(&k))
    }

    async fn list_dir(&self, dir: &str) -> Outcome<Vec<(String, bool, u64)>> {
        Ok(res!(self.area().list(dir))
            .into_iter()
            .map(|(name, is_dir, size, _)| (name, is_dir, size))
            .collect())
    }

    async fn list_dir_stamped(&self, dir: &str) -> Outcome<Vec<(String, bool, u64, Option<f64>)>> {
        self.area().list(dir)
    }

    async fn stamp(&self, key: &str) -> Outcome<Option<(f64, f64)>> {
        let k = res!(jail(WHO, key)).join("/");
        Ok(self.area().files.get(&k).map(|f| (f.mtime, f.bytes.len() as f64)))
    }

    async fn delete_file(&self, key: &str) -> Outcome<()> {
        let k = res!(jail(WHO, key)).join("/");
        match self.area().files.remove(&k) {
            Some(_) => Ok(()),
            None    => Err(err!("Memory store: '{}' is not a file, so it was not removed.", key;
                Invalid, Input, Path)),
        }
    }

    async fn delete_file_if(&self, key: &str, expect: &Seen) -> Outcome<Option<Seen>> {
        if let Seen::Unread = expect {
            return Err(err!("Memory store: a delete of '{}' was bound to bytes that could not be \
                read, so there is nothing to compare.", key; IO, File, Write, Invalid));
        }
        let k = res!(jail(WHO, key)).join("/");
        let mut a = self.area();
        let found = a.seen(&k);
        if &found != expect {
            return Ok(Some(found));
        }
        a.files.remove(&k);
        Ok(None)
    }

    async fn delete_entry(&self, key: &str, recursive: bool) -> Outcome<()> {
        self.area().delete_entry(key, recursive)
    }

    async fn move_entry(&self, from: &str, to: &str) -> Outcome<()> {
        self.area().move_entry(from, to)
    }

    async fn lock(&self, name: &str, how: LockHow) -> Locked<MemLock> {
        match how {
            LockHow::Wait           => Locked::Held(self.acquire(name).await),
            LockHow::IfAvailable    => {
                let mut a = self.area();
                let slot = a.locks.entry(name.to_string()).or_default();
                if slot.held {
                    Locked::Busy
                } else {
                    slot.held = true;
                    Locked::Held(MemLock { area: self.area.clone(), name: name.to_string() })
                }
            },
            LockHow::Timeout(ms)    => {
                match tokio::time::timeout(Duration::from_millis(ms), self.acquire(name)).await {
                    Ok(held) => Locked::Held(held),
                    Err(_)   => Locked::TimedOut,
                }
            },
        }
    }

    async fn lock_held(&self, name: &str) -> Option<bool> {
        Some(self.area().locks.get(name).map(|s| s.held).unwrap_or(false))
    }

    async fn release(&self, lock: MemLock) {
        drop(lock);
    }
}

#[cfg(test)]
#[path = "../../tests/unit/store/mem/tests.rs"]
mod tests;
