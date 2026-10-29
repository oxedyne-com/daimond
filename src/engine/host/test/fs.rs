//! TestHost's fs port: an in-memory disk with a call log, shared by every clone of one host.
//!
//! Paths are filed by the storage they resolve in, by the same decision the tab takes
//! ([`crate::tools::storage_for`], with its own folder open), so Daimond's store is one storage
//! whichever root names it.  The disk is never borrowed across an await.

use crate::{
    diamond_versions::Seen,
    engine::host::fs::HostFs,
    tools::{
        FileRoot,
        Licence,
        Storage,
        storage_for,
    },
};

use oxedyne_fe2o3_core::prelude::*;

use std::{
    cell::RefCell,
    collections::{
        BTreeMap,
        BTreeSet,
    },
    future::Future,
    rc::Rc,
};

type Key = (u8, String);

#[derive(Debug, Default)]
struct Disk {
    files:  BTreeMap<Key, Vec<u8>>,
    dirs:   BTreeSet<Key>,          // made by create_dir; a file's parents are folders too
    log:    Vec<String>,
    before: Option<(String, Vec<u8>)>, // `save_before_lock`'s one-shot save, by cleaned path
}

impl Disk {
    fn is_dir(&self, key: &Key) -> bool {
        if key.1.is_empty() || self.dirs.contains(key) {
            return true;
        }
        let pre = fmt!("{}/", key.1);
        self.files.keys().chain(self.dirs.iter())
            .any(|(s, p)| *s == key.0 && p.starts_with(&pre))
    }

    /// Every file and made folder at or under `key`.
    fn under(&self, key: &Key) -> (Vec<Key>, Vec<Key>) {
        let pre = fmt!("{}/", key.1);
        let hit = |k: &&Key| k.0 == key.0 && (k.1 == key.1 || k.1.starts_with(&pre));
        (self.files.keys().filter(hit).cloned().collect(),
            self.dirs.iter().filter(hit).cloned().collect())
    }
}

/// TestHost's fs port.
#[derive(Clone, Debug, Default)]
pub struct TestFs {
    disk: Rc<RefCell<Disk>>,
}

impl TestFs {

    /// What the port was asked to change, one line per call, in order (`write a.txt`, ...).
    pub fn log(&self) -> Vec<String> { self.disk.borrow().log.clone() }

    /// How many writes reached the port.
    pub fn writes(&self) -> usize {
        self.disk.borrow().log.iter().filter(|l| l.starts_with("write ")).count()
    }

    /// The bytes at `path`, read past the port and its log.
    pub fn peek(&self, root: FileRoot, path: &str) -> Option<Vec<u8>> {
        match key(root, path) {
            Ok(k)  => self.disk.borrow().files.get(&k).cloned(),
            Err(_) => None,
        }
    }

    /// Arm a one-shot save of `bytes` at `path`, landed at the entry of the next held write of
    /// that path ([`HostFs::write_licensed_then`], and so `write_licensed_if`), before its compare:
    /// a rival's save between a guard's read and the write's lock.  Logged `save <path>`.
    pub fn save_before_lock(&self, path: &str, bytes: &[u8]) {
        let clean = path.split('/').filter(|s| !s.is_empty() && *s != ".").collect::<Vec<_>>()
            .join("/");
        self.disk.borrow_mut().before = Some((clean, bytes.to_vec()));
    }

    /// Land the armed save where `k` is its path, once.
    fn saved_before_lock(&self, k: &Key) {
        let armed = match &self.disk.borrow().before {
            Some((p, _)) => *p == k.1,
            None         => false,
        };
        if !armed {
            return;
        }
        let taken = self.disk.borrow_mut().before.take();
        if let Some((_, bytes)) = taken {
            self.note(fmt!("save {}", k.1));
            self.disk.borrow_mut().files.insert(k.clone(), bytes);
        }
    }

    fn note(&self, line: String) { self.disk.borrow_mut().log.push(line); }

    pub(crate) fn put(&self, root: FileRoot, path: &str, content: &[u8]) -> Outcome<()> {
        let k = res!(key(root, path));
        if k.1.is_empty() || self.disk.borrow().is_dir(&k) {
            return Err(err!("TestHost fs: '{}' is a folder.", path; IO, File, Write, Invalid));
        }
        self.note(fmt!("write {}", k.1));
        self.disk.borrow_mut().files.insert(k, content.to_vec());
        Ok(())
    }

    fn get(&self, root: FileRoot, path: &str) -> Outcome<Vec<u8>> {
        let k = res!(key(root, path));
        match self.disk.borrow().files.get(&k) {
            Some(b) => Ok(b.clone()),
            None    => Err(err!("TestHost fs: no file '{}'.", path; IO, File, Missing)),
        }
    }
}

/// The storage `path` is filed under, and the path with `.` and empty steps dropped; `..` is
/// refused, as the tab's jail refuses it.
fn key(root: FileRoot, path: &str) -> Outcome<Key> {
    let mut steps = Vec::new();
    for s in path.split('/') {
        match s {
            "" | "." => {},
            ".."     => return Err(err!("TestHost fs: '{}' climbs out.", path; IO, File, Invalid)),
            s        => steps.push(s),
        }
    }
    let clean = steps.join("/");
    let store = match storage_for(root, &clean, Some(0), "") {
        Storage::Folder(_)  => 0,
        Storage::Sandbox(_) => 1,
        Storage::Machine(_) | Storage::Nowhere => 2,
    };
    Ok((store, clean))
}

fn parent_and_leaf(path: &str) -> (&str, &str) {
    match path.rfind('/') {
        Some(i) => (&path[..i], &path[i + 1..]),
        None    => ("", path),
    }
}

impl HostFs for TestFs {
    // Its own in-memory root stands open, as a real folder would.
    fn folder_open(&self) -> bool { true }

    async fn exists(&self, root: FileRoot, path: &str) -> Outcome<bool> {
        let k = res!(key(root, path));
        let d = self.disk.borrow();
        Ok(d.files.contains_key(&k) || d.is_dir(&k))
    }

    async fn is_directory(&self, root: FileRoot, path: &str) -> Outcome<bool> {
        let k = res!(key(root, path));
        Ok(self.disk.borrow().is_dir(&k))
    }

    async fn list_dir(&self, root: FileRoot, path: &str) -> Outcome<Vec<(String, bool, u64)>> {
        let k = res!(key(root, path));
        let d = self.disk.borrow();
        if !d.is_dir(&k) {
            return Err(err!("TestHost fs: no folder '{}'.", path; IO, File, Missing));
        }
        let pre = if k.1.is_empty() { String::new() } else { fmt!("{}/", k.1) };
        let mut out: BTreeMap<String, (bool, u64)> = BTreeMap::new();
        for ((s, p), len) in d.files.iter().map(|(k, b)| (k, Some(b.len() as u64)))
            .chain(d.dirs.iter().map(|k| (k, None)))
        {
            if *s != k.0 { continue; }
            if let Some(rest) = p.strip_prefix(&pre) {
                if rest.is_empty() { continue; }
                match (rest.find('/'), len) {
                    (None, Some(n))  => { out.insert(rest.to_string(), (false, n)); },
                    (None, None)     => { out.insert(rest.to_string(), (true, 0)); },
                    (Some(i), _)     => { out.insert(rest[..i].to_string(), (true, 0)); },
                }
            }
        }
        Ok(out.into_iter().map(|(n, (dir, len))| (n, dir, len)).collect())
    }

    async fn list_dir_stamped(&self, root: FileRoot, path: &str)
        -> Outcome<Vec<(String, bool, u64, Option<f64>)>>
    {
        let got = res!(self.list_dir(root, path).await);
        Ok(got.into_iter().map(|(n, dir, len)| (n, dir, len, None)).collect())
    }

    async fn read_file(&self, root: FileRoot, path: &str) -> Outcome<Vec<u8>> {
        self.get(root, path)
    }

    async fn read_file_capped(&self, root: FileRoot, path: &str, max: u32)
        -> Outcome<(Vec<u8>, f64)>
    {
        let b = res!(self.get(root, path));
        let size = b.len() as f64;
        Ok((b.into_iter().take(max as usize).collect(), size))
    }

    async fn read_file_range(&self, root: FileRoot, path: &str, offset: f64, len: u32)
        -> Outcome<(Vec<u8>, f64)>
    {
        let b = res!(self.get(root, path));
        let size = b.len() as f64;
        let from = (offset.max(0.0) as usize).min(b.len());
        let to = from.saturating_add(len as usize).min(b.len());
        Ok((b[from..to].to_vec(), size))
    }

    async fn write_licensed(&self, root: FileRoot, lic: &Licence, content: &[u8]) -> Outcome<()> {
        self.put(root, lic.path(), content)
    }

    async fn write_licensed_if(&self, root: FileRoot, lic: &Licence, content: &[u8], expect: &Seen)
        -> Outcome<Option<Seen>>
    {
        self.write_licensed_then(root, lic, content, Some(expect), || async { Ok(()) }).await
    }

    async fn write_licensed_then<P, F>(&self, root: FileRoot, lic: &Licence, content: &[u8],
        expect: Option<&Seen>, pre: P) -> Outcome<Option<Seen>>
    where
        P: FnOnce() -> F,
        F: Future<Output = Outcome<()>>,
    {
        let k = res!(key(root, lic.path()));
        self.saved_before_lock(&k);
        if let Some(want) = expect {
            if let Seen::Unread = want {
                return Err(err!("TestHost fs: a write of '{}' was bound to bytes that could not \
                    be read, so there is nothing to compare.", lic.path(); IO, File, Write, Invalid));
            }
            let found = Seen::of(self.peek(root, lic.path()).as_deref());
            if &found != want {
                return Ok(Some(found));
            }
        }
        res!(pre().await);
        res!(self.put(root, lic.path(), content));
        Ok(None)
    }

    async fn create_dir_licensed(&self, root: FileRoot, lic: &Licence) -> Outcome<()> {
        let k = res!(key(root, lic.path()));
        if self.disk.borrow().files.contains_key(&k) {
            return Err(err!("TestHost fs: '{}' is a file.", lic.path(); IO, File, Invalid));
        }
        self.note(fmt!("mkdir {}", k.1));
        self.disk.borrow_mut().dirs.insert(k);
        Ok(())
    }

    async fn delete_licensed(&self, root: FileRoot, lic: &Licence) -> Outcome<()> {
        let k = res!(key(root, lic.path()));
        if self.disk.borrow().files.contains_key(&k) {
            self.note(fmt!("delete {}", k.1));
            self.disk.borrow_mut().files.remove(&k);
            return Ok(());
        }
        Err(err!("TestHost fs: no file '{}' to delete.", lic.path(); IO, File, Missing))
    }

    async fn move_licensed(&self, root: FileRoot, from: &Licence, to: &Licence) -> Outcome<()> {
        let (a, b) = (res!(key(root, from.path())), res!(key(root, to.path())));
        let (files, dirs) = self.disk.borrow().under(&a);
        if files.is_empty() && dirs.is_empty() {
            return Err(err!("TestHost fs: nothing at '{}' to move.", from.path(); IO, File, Missing));
        }
        let moved = |k: &Key| (b.0, fmt!("{}{}", b.1, &k.1[a.1.len()..]));
        self.note(fmt!("move {} {}", a.1, b.1));
        let mut d = self.disk.borrow_mut();
        for k in files {
            if let Some(bytes) = d.files.remove(&k) {
                d.files.insert(moved(&k), bytes);
            }
        }
        for k in dirs {
            d.dirs.remove(&k);
            d.dirs.insert(moved(&k));
        }
        let (parent, _) = parent_and_leaf(&b.1);
        if !parent.is_empty() {
            d.dirs.insert((b.0, parent.to_string()));
        }
        Ok(())
    }

    fn storage_of(&self, root: FileRoot, path: &str) -> Storage {
        storage_for(root, path, Some(0), "")
    }

    fn thrown(&self) -> String { String::new() }
    fn take_thrown(&self) -> String { String::new() }
    fn arm_folder_watch(&self) {}
    fn notify_folder_lost(&self) {}

    // The cloud is another storage, and TestHost has none.
    fn children_of(&self, _dir: &str) -> Vec<(String, bool, u64)> { Vec::new() }
    async fn cloud_fetch(&self, _path: &str) -> Outcome<String> {
        crate::engine::host::local::fs::unavailable("fs", "cloud_fetch")
    }
    async fn cloud_forget_licensed(&self, _lic: &Licence) -> Outcome<String> {
        crate::engine::host::local::fs::unavailable("fs", "cloud_forget_licensed")
    }
    fn cloud_size_of(&self, _path: &str) -> Option<u64> { None }
}

#[cfg(test)]
#[path = "../../../../tests/unit/engine/host/test/fs/tests.rs"]
mod tests;
