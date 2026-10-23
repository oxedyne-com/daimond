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
mod tests {
    use crate::{
        engine::host::{
            Host,
            fs::HostFs,
            test::TestHost,
        },
        executor::Executor,
        tools::{
            FileRoot,
            ToolContext,
            new_read_cache,
        },
        workspace::Workspace,
    };

    use oxedyne_fe2o3_core::prelude::*;

    /// A turn on a fresh TestHost, unbounded and the user's own, so every licence is granted.
    fn ctx() -> ToolContext<TestHost> {
        let dir = match oxedyne_fe2o3_test::scratch::scratch_dir("daimond_testhost_fs") {
            Ok(d)  => d,
            Err(e) => panic!("a scratch directory: {}", e),
        };
        let ws = match Workspace::new(dir) {
            Ok(w)  => w,
            Err(e) => panic!("a workspace: {}", e),
        };
        ToolContext {
            workspace:   ws,
            executor:    Executor::local_default(),
            cwd:         String::new(),
            path_prefix: String::new(),
            root:        FileRoot::Workspace,
            read_seen:   new_read_cache(),
            no_write:    Vec::new(),
            daimon_of:   String::new(),
            turn:        String::new(),
            keeper:      String::new(),
            unconfirmed: Vec::new(),
            live:        None,
            by_model:    false,
            restoring:   0,
            by:          None,
            host:        TestHost::default(),
        }
    }

    fn lic(ctx: &ToolContext<TestHost>, path: &str) -> crate::tools::Licence {
        match ctx.licence(path) {
            Ok(l)  => l,
            Err(e) => panic!("a licence for '{}': {}", path, e),
        }
    }

    #[tokio::test]
    async fn fs_write_then_read() {
        let c = ctx();
        let fs = c.host().fs();
        assert!(!fs.exists(FileRoot::Workspace, "a.txt").await.expect("exists"));
        fs.write_licensed(FileRoot::Workspace, &lic(&c, "a.txt"), b"hello").await.expect("write");
        assert_eq!(fs.read_file(FileRoot::Workspace, "a.txt").await.expect("read"), b"hello");
        assert!(fs.exists(FileRoot::Workspace, "a.txt").await.expect("exists"));
        assert!(!fs.is_directory(FileRoot::Workspace, "a.txt").await.expect("is dir"));
        let (head, size) = fs.read_file_capped(FileRoot::Workspace, "a.txt", 2).await.expect("capped");
        assert_eq!((head.as_slice(), size), (&b"he"[..], 5.0));
        let (mid, size) = fs.read_file_range(FileRoot::Workspace, "a.txt", 1.0, 3).await.expect("range");
        assert_eq!((mid.as_slice(), size), (&b"ell"[..], 5.0));
        // A clone shares the disk, as every ToolContext clone of one turn must.
        let other = c.host().clone();
        assert_eq!(other.fs().read_file(FileRoot::Workspace, "a.txt").await.expect("read"), b"hello");
        assert!(fs.read_file(FileRoot::Workspace, "b.txt").await.is_err(), "a missing file reads");
        assert_eq!(fs.writes(), 1);
        assert!(fs.log().iter().any(|l| l == "write a.txt"), "{:?}", fs.log());
    }

    /// The name of a unit of `tools.rs` from its opening line: the function, or the tool's arm.
    fn unit_name(head: &str) -> &str {
        let end = head.find(|c| c == '(' || c == '<').or_else(|| head.find(" =>"))
            .unwrap_or(head.len());
        head[..end].trim()
    }

    #[test]
    fn every_read_then_write_tool_binds_its_write_to_its_read() {
        // U3a RMW (check B D1-D3) and RMW2 (check C Q1, 2026-10-17): a tool that reads a file --
        // its own read, or the version capture's read of "before" -- and then writes it plainly
        // overwrites a save landing in between, and the capture records the old read as "before",
        // so the save is kept nowhere.  A fixed list of tools missed five such writes, so this
        // finds them: every plain write in the tools that follows, in the same function or tool
        // arm, a read of a file must be bound to that read ([`WriteBound`]) or named below with
        // the reason it has no read to bind.  A new read-then-write is red by default.
        const SRC: &str = include_str!("../../../tools.rs");
        // (the function or tool arm, why its plain write after a read is not a lost save)
        const UNBOUND: &[(&str, &str)] = &[];
        const READS: [&str; 4] = ["before_bytes(", "machine_before(", "before_output(", ".read_file("];
        // Always plain; and the doors that are plain where their binding argument is `None`.
        const PLAIN: [&str; 3] = [".write_licensed(", "MachineChange::Write(", "restore_write("];
        // `restore_store_write` takes the overwrite after its bound, so that is set aside first.
        const UNLESS_BOUND: [&str; 4] = ["guarded_store_write(", "restore_store_write(",
            "machine_write(", "write_over("];
        const HEADS: [&str; 6] = ["fn ", "async fn ", "pub fn ", "pub async fn ",
            "pub(crate) fn ", "pub(crate) async fn "];
        let code = &SRC[..SRC.find("#[cfg(test)]\nmod tests").expect("tools.rs has its tests")];
        let mut unit = (0usize, "");
        let mut at = 0usize;
        let mut found = 0usize;	// writes after a read, bound or not: the scan is looking
        let mut red: Vec<String> = Vec::new();
        let mut named = vec![false; UNBOUND.len()];
        for line in code.split('\n') {
            let t = line.trim();
            if HEADS.iter().any(|h| t.starts_with(h))
                || (t.starts_with("Tool::") && t.ends_with("=> {"))
            {
                unit = (at, unit_name(t.trim_start_matches("pub(crate) ")
                    .trim_start_matches("pub ").trim_start_matches("async ")));
            }
            for tok in PLAIN.iter().chain(UNLESS_BOUND.iter()) {
                let j = match line.find(tok) {
                    Some(j) if !line.contains(&fmt!("fn {}", tok)) => at + j,
                    _ => continue,
                };
                let reads: Vec<&str> = READS.iter().copied()
                    .filter(|r| code[unit.0..j].contains(r)).collect();
                if reads.is_empty() {
                    continue;
                }
                found += 1;
                let plain = PLAIN.contains(tok) || {
                    // The call's arguments, to its closing parenthesis: plain where the last is `None`.
                    let args = &code[j + tok.len()..];
                    let mut depth = 1usize;
                    let end = args.find(|c| {
                        match c { '(' => depth += 1, ')' => depth -= 1, _ => () }
                        depth == 0
                    }).expect("a call closes");
                    let args = args[..end].trim_end();
                    // The arguments after the bound: `restore_store_write`'s overwrite and
                    // landing, `write_over`'s landing (held-lock settle HL3).
                    let after = match *tok {
                        "restore_store_write(" => 2,
                        "write_over("          => 1,
                        _                      => 0,
                    };
                    let mut args = args;
                    for _ in 0..after {
                        args = args.rsplit_once(',').map(|(h, _)| h).unwrap_or(args).trim_end();
                    }
                    args.ends_with("None")
                };
                if !plain {
                    continue;
                }
                match UNBOUND.iter().position(|(u, _)| *u == unit.1) {
                    Some(k) => named[k] = true,
                    None    => red.push(fmt!("{}: `{}` writes plainly after its {}", unit.1, t,
                        reads.join(" / "))),
                }
            }
            at += line.len() + 1;
        }
        assert!(found >= 8, "the scan finds the bound read-then-writes too ({})", found);
        for (k, (u, _)) in UNBOUND.iter().enumerate() {
            if !named[k] {
                red.push(fmt!("{} is allowed a plain write it no longer makes", u));
            }
        }
        assert!(red.is_empty(), "{:#?}", red);
    }

    #[tokio::test]
    async fn a_read_then_write_tool_refuses_a_save_between_its_read_and_its_write() {
        // U3a RMW D1: file_edit, doc_edit and sheet_write read the bytes, build the new file
        // from them, and write it bound to that read.  A save in between is refused under the
        // lock, in the tool's own words, and stands.
        use crate::diamond_versions::Seen;
        use crate::tools::WriteBound;
        for tool in ["file_edit", "doc_edit", "sheet_write"] {
            let c = ctx();
            let fs = c.host().fs();
            let l = lic(&c, "d.docx");
            fs.write_licensed(FileRoot::Workspace, &l, b"what the tool read").await.expect("seed");
            let bytes = fs.read_file(FileRoot::Workspace, "d.docx").await.expect("read");
            fs.write_licensed(FileRoot::Workspace, &l, b"the person's save").await.expect("rival");
            let bound = WriteBound::Read(Seen::of(Some(&bytes)));
            let got = crate::tools::guarded_store_write(c.host(), FileRoot::Workspace, &l, tool,
                "d.docx", b"built from the old read", Some(&bound)).await;
            let why = fmt!("{:?}", got);
            assert!(got.is_err() && why.contains(tool) && why.contains("since you read it"),
                "{}: {}", tool, why);
            assert_eq!(fs.read_file(FileRoot::Workspace, "d.docx").await.expect("read"),
                b"the person's save", "{}: the save stands", tool);
            // Nothing in between: the edit lands.
            let bytes = fs.read_file(FileRoot::Workspace, "d.docx").await.expect("read");
            crate::tools::guarded_store_write(c.host(), FileRoot::Workspace, &l, tool, "d.docx",
                b"the edit", Some(&WriteBound::Read(Seen::of(Some(&bytes))))).await.expect("lands");
            assert_eq!(fs.read_file(FileRoot::Workspace, "d.docx").await.expect("read"), b"the edit");
        }
    }

    #[tokio::test]
    async fn a_blind_write_is_bound_to_the_version_captures_read() {
        // U3a RMW, ruling 3: file_write of a file the agent never read is bound to the version
        // capture's `keep` read.  A save between that read and the write is refused as having
        // changed just now, and stands; with nothing in between the write lands as before.
        use crate::diamond_versions::Seen;
        use crate::tools::WriteBound;
        let c = ctx();
        let fs = c.host().fs();
        let l = lic(&c, "b.txt");
        fs.write_licensed(FileRoot::Workspace, &l, b"what stood there").await.expect("seed");
        let kept = fs.read_file(FileRoot::Workspace, "b.txt").await.expect("keep read");
        fs.write_licensed(FileRoot::Workspace, &l, b"the person's save").await.expect("rival");
        let bound = WriteBound::of(None, Some(Seen::of(Some(&kept)))).expect("bound");
        assert!(matches!(bound, WriteBound::Kept(_)));
        let got = crate::tools::guarded_store_write(c.host(), FileRoot::Workspace, &l,
            "file_write", "b.txt", b"blind", Some(&bound)).await;
        assert!(fmt!("{:?}", got).contains("file_write: 'b.txt' changed just now; read it again \
            before writing."), "{:?}", got);
        assert_eq!(fs.read_file(FileRoot::Workspace, "b.txt").await.expect("read"),
            b"the person's save");
        // A file that was not there when kept, and is created before the write: kept too.
        let m = lic(&c, "new.txt");
        let bound = WriteBound::of(None, Some(Seen::of(None))).expect("bound");
        fs.write_licensed(FileRoot::Workspace, &m, b"theirs").await.expect("rival");
        assert!(crate::tools::guarded_store_write(c.host(), FileRoot::Workspace, &m, "file_write",
            "new.txt", b"blind", Some(&bound)).await.is_err());
        assert_eq!(fs.read_file(FileRoot::Workspace, "new.txt").await.expect("read"), b"theirs");
        // Nothing in between: the blind write lands.
        let bound = WriteBound::of(None, Some(Seen::of(Some(b"the person's save")))).expect("b");
        crate::tools::guarded_store_write(c.host(), FileRoot::Workspace, &l, "file_write",
            "b.txt", b"blind", Some(&bound)).await.expect("lands");
        assert_eq!(fs.read_file(FileRoot::Workspace, "b.txt").await.expect("read"), b"blind");
        // The guard's read wins over the capture's: the agent read it.
        let r = WriteBound::of(Some(Seen::Absent), Some(Seen::of(Some(b"x")))).expect("b");
        assert_eq!(r, WriteBound::Read(Seen::Absent));
        assert_eq!(WriteBound::of(None, None), None);
    }

    #[test]
    fn file_writes_machine_arm_sends_a_bound_write_where_the_hand_compares() {
        // U3a RMW D2 and RMW2: past the guard, the hand is sent the guard's read as `expect`; a
        // write with no read to bind is plain; a restore keeps its own hold.  Every hand a change
        // reaches compares as it writes -- one that does not is refused at the link -- so there
        // is no plain write kept for an older hand.
        use crate::diamond_versions::Seen;
        use crate::tools::{machine_write, MachineChange, WriteBound};
        let c = ctx();
        let l = lic(&c, "m.txt");
        let read = Seen::of(Some(b"what the guard read"));
        let bound = WriteBound::Read(read.clone());
        let held = Seen::of(Some(b"what the restore found"));
        match machine_write(false, &l, "new", &Seen::Unread, Some(&bound)) {
            MachineChange::WriteIf(_, "new", s) => assert_eq!(s, &read),
            _ => panic!("a guarded write is bound to the guard's read"),
        }
        let kept = WriteBound::Kept(Seen::Absent);
        match machine_write(false, &l, "new", &Seen::Unread, Some(&kept)) {
            MachineChange::WriteIf(_, "new", s) => assert_eq!(s, &Seen::Absent),
            _ => panic!("a write after the capture's read is bound to it"),
        }
        assert!(matches!(machine_write(false, &l, "new", &Seen::Unread, None),
            MachineChange::Write(_, "new")), "nothing read, nothing kept: a plain write");
        match machine_write(true, &l, "new", &held, Some(&bound)) {
            MachineChange::WriteIf(_, _, s) => assert_eq!(s, &held),
            _ => panic!("a restore's write is bound to its hold"),
        }
        // The hand's refusal is answered in the guard's words.
        let said = fmt!("write refused: m.txt {} -- now sha256 {}", crate::tools::HAND_WRITE_CHANGED,
            "a".repeat(64));
        let why = bound.hand_refusal("file_write", "m.txt", &said).expect("the refusal");
        assert!(why.contains("changed on disk since you read it"), "{}", why);
        assert_eq!(bound.hand_refusal("file_write", "m.txt", "permission denied"), None);
    }

    #[tokio::test]
    async fn fs_write_if_binds_to_what_was_seen() {
        use crate::diamond_versions::Seen;
        let c = ctx();
        let fs = c.host().fs();
        let l = lic(&c, "r.txt");
        let got = fs.write_licensed_if(FileRoot::Workspace, &l, b"one", &Seen::Absent).await;
        assert_eq!(got.expect("first"), None);
        // Something else stands there now, so the write is refused with what it found.
        let got = fs.write_licensed_if(FileRoot::Workspace, &l, b"two", &Seen::Absent).await;
        assert_eq!(got.expect("second"), Some(Seen::of(Some(b"one"))));
        assert_eq!(fs.read_file(FileRoot::Workspace, "r.txt").await.expect("read"), b"one");
        assert!(fs.write_licensed_if(FileRoot::Workspace, &l, b"x", &Seen::Unread).await.is_err());
    }

    #[tokio::test]
    async fn file_write_binds_its_write_to_what_its_stale_read_guard_read() {
        // U3a SA3: the guard reads the file, a save lands before the write takes the lock, and
        // the write must be refused under the lock rather than overwrite it.
        use crate::diamond_versions::Seen;
        use crate::tools::WriteBound;
        let c = ctx();
        let fs = c.host().fs();
        let l = lic(&c, "g.txt");
        fs.write_licensed(FileRoot::Workspace, &l, b"what the daimon read").await.expect("seed");
        let read = fs.read_file(FileRoot::Workspace, "g.txt").await.expect("guard read");
        let seen = Seen::of(Some(&read));
        fs.write_licensed(FileRoot::Workspace, &l, b"the person's save").await.expect("rival");
        let got = crate::tools::guarded_store_write(c.host(), FileRoot::Workspace, &l, "file_write",
            "g.txt", b"the daimon's write", Some(&WriteBound::Read(seen))).await;
        assert!(got.is_err(), "a write past a save it never read is refused: {:?}", got);
        assert_eq!(fs.read_file(FileRoot::Workspace, "g.txt").await.expect("read"),
            b"the person's save", "the rival's save stands");
        // Nothing in between: the write lands.
        let seen = Seen::of(Some(b"the person's save"));
        crate::tools::guarded_store_write(c.host(), FileRoot::Workspace, &l, "file_write",
            "g.txt", b"the daimon's write", Some(&WriteBound::Read(seen))).await.expect("lands");
        assert_eq!(fs.read_file(FileRoot::Workspace, "g.txt").await.expect("read"),
            b"the daimon's write");
        // A file the guard did not read (deleted since): a re-creation over a delete is refused.
        fs.delete_licensed(FileRoot::Workspace, &l).await.expect("delete");
        let got = crate::tools::guarded_store_write(c.host(), FileRoot::Workspace, &l, "file_write",
            "g.txt", b"again", Some(&WriteBound::Read(Seen::of(Some(b"the daimon's write"))))).await;
        assert!(got.is_err(), "{:?}", got);
        // No guard read: written as before.
        crate::tools::guarded_store_write(c.host(), FileRoot::Workspace, &l, "file_write",
            "g.txt", b"new", None).await.expect("unbound");
        assert_eq!(fs.read_file(FileRoot::Workspace, "g.txt").await.expect("read"), b"new");
    }

    #[tokio::test]
    async fn fs_list_after_create() {
        let c = ctx();
        let fs = c.host().fs();
        fs.create_dir_licensed(FileRoot::Workspace, &lic(&c, "d")).await.expect("mkdir");
        fs.write_licensed(FileRoot::Workspace, &lic(&c, "d/x.txt"), b"abc").await.expect("write");
        fs.write_licensed(FileRoot::Workspace, &lic(&c, "d/sub/y.txt"), b"").await.expect("write");
        assert!(fs.is_directory(FileRoot::Workspace, "d").await.expect("is dir"));
        assert!(fs.is_directory(FileRoot::Workspace, "d/sub").await.expect("is dir"));
        let got = fs.list_dir(FileRoot::Workspace, "d").await.expect("list");
        assert_eq!(got, vec![(fmt!("sub"), true, 0), (fmt!("x.txt"), false, 3)]);
        let root = fs.list_dir(FileRoot::Workspace, "").await.expect("list root");
        assert_eq!(root, vec![(fmt!("d"), true, 0)]);
        let stamped = fs.list_dir_stamped(FileRoot::Workspace, "d").await.expect("stamped");
        assert_eq!(stamped.len(), 2);
        assert!(fs.list_dir(FileRoot::Workspace, "nowhere").await.is_err());
        // Daimond's own store is one storage, whichever root names it.
        fs.write_licensed(FileRoot::Opfs, &lic(&c, "diamonds/s.json"), b"{}").await.expect("store");
        assert!(fs.exists(FileRoot::Workspace, "diamonds/s.json").await.expect("exists"));
        assert!(!fs.exists(FileRoot::Opfs, "d/x.txt").await.expect("exists"),
            "the folder and the sandbox are two storages");
    }

    #[tokio::test]
    async fn fs_move_and_delete() {
        let c = ctx();
        let fs = c.host().fs();
        fs.write_licensed(FileRoot::Workspace, &lic(&c, "a/one.txt"), b"1").await.expect("write");
        fs.write_licensed(FileRoot::Workspace, &lic(&c, "a/b/two.txt"), b"2").await.expect("write");
        fs.move_licensed(FileRoot::Workspace, &lic(&c, "a"), &lic(&c, "z")).await.expect("move");
        assert!(!fs.exists(FileRoot::Workspace, "a").await.expect("exists"));
        assert_eq!(fs.read_file(FileRoot::Workspace, "z/b/two.txt").await.expect("read"), b"2");
        fs.move_licensed(FileRoot::Workspace, &lic(&c, "z/one.txt"), &lic(&c, "one.txt")).await
            .expect("move file");
        assert_eq!(fs.read_file(FileRoot::Workspace, "one.txt").await.expect("read"), b"1");
        fs.delete_licensed(FileRoot::Workspace, &lic(&c, "one.txt")).await.expect("delete");
        assert!(!fs.exists(FileRoot::Workspace, "one.txt").await.expect("exists"));
        assert!(fs.delete_licensed(FileRoot::Workspace, &lic(&c, "one.txt")).await.is_err(),
            "a second delete finds nothing");
        assert!(fs.move_licensed(FileRoot::Workspace, &lic(&c, "gone"), &lic(&c, "x")).await.is_err());
    }

    #[tokio::test]
    async fn fs_its_own_folder_is_open() {
        let c = ctx();
        let fs = c.host().fs();
        assert!(fs.folder_open());
        assert_eq!(fs.thrown(), "");
        assert_eq!(fs.take_thrown(), "");
        assert!(fs.cloud_fetch("x").await.is_err());
        assert_eq!(fs.cloud_size_of("x"), None);
        assert!(fs.children_of("").is_empty());
    }

    /// HL1 (a), and `save_before_lock` itself: a rival's save landed at the held write's entry,
    /// before its compare, refuses the write with what it found, `pre` never run and nothing
    /// written.  The knob is one-shot: the next write, bound to the save, lands, with `pre` run
    /// before the bytes.
    #[tokio::test]
    async fn hl1_a_a_refused_compare_never_runs_pre() {
        use crate::diamond_versions::Seen;
        use std::cell::Cell;
        let c = ctx();
        let fs = c.host().fs();
        let l = lic(&c, "d/DECISIONS.md");
        fs.write_licensed(FileRoot::Workspace, &l, b"what the guard read").await.expect("seed");
        let seen = Seen::of(Some(b"what the guard read"));
        fs.save_before_lock("./d/DECISIONS.md", b"the person's save");
        let ran = Cell::new(0u8);
        let r = &ran;
        let got = fs.write_licensed_then(FileRoot::Workspace, &l, b"the daimon's write", Some(&seen),
            move || async move { r.set(r.get() + 1); Ok(()) }).await;
        assert_eq!(got.expect("refused, not failed"), Some(Seen::of(Some(b"the person's save"))));
        assert_eq!(ran.get(), 0, "a refused compare ran pre");
        assert_eq!(fs.peek(FileRoot::Workspace, "d/DECISIONS.md"), Some(b"the person's save".to_vec()));
        assert_eq!(fs.log().last().map(String::as_str), Some("save d/DECISIONS.md"),
            "the save landed and nothing was written after it: {:?}", fs.log());
        // Spent: the next write bound to the save lands, and `pre` saw the bytes before it.
        let before = Cell::new(None);
        let b = &before;
        let saved = Seen::of(Some(b"the person's save"));
        let got = fs.write_licensed_then(FileRoot::Workspace, &l, b"the daimon's write", Some(&saved),
            move || async move { b.set(fs.peek(FileRoot::Workspace, "d/DECISIONS.md")); Ok(()) }).await;
        assert_eq!(got.expect("lands"), None);
        assert_eq!(before.take(), Some(b"the person's save".to_vec()), "pre ran before the bytes");
        assert_eq!(fs.peek(FileRoot::Workspace, "d/DECISIONS.md"), Some(b"the daimon's write".to_vec()));
        // A plain refused compare (no knob) runs no `pre` either, through `write_licensed_if` too.
        let got = fs.write_licensed_then(FileRoot::Workspace, &l, b"x", Some(&Seen::Absent),
            move || async move { r.set(r.get() + 1); Ok(()) }).await;
        assert_eq!(got.expect("refused"), Some(Seen::of(Some(b"the daimon's write"))));
        assert_eq!(ran.get(), 0);
        // A knob armed for another path stays armed and changes nothing here.
        fs.save_before_lock("other.md", b"elsewhere");
        let got = fs.write_licensed_if(FileRoot::Workspace, &l, b"y", &Seen::of(Some(b"the daimon's write")))
            .await;
        assert_eq!(got.expect("lands"), None);
        assert_eq!(fs.peek(FileRoot::Workspace, "other.md"), None);
    }

    /// HL1 (b): a `pre` that fails writes nothing, bound or plain, and is the write's error.
    #[tokio::test]
    async fn hl1_b_a_failed_pre_writes_nothing() {
        use crate::diamond_versions::Seen;
        let c = ctx();
        let fs = c.host().fs();
        let l = lic(&c, "d/STATE.md");
        let got = fs.write_licensed_then(FileRoot::Workspace, &l, b"new", Some(&Seen::Absent),
            || async { Err(err!("the archive would not append."; IO, File, Write)) }).await;
        assert!(got.is_err(), "{:?}", got);
        assert_eq!(fs.peek(FileRoot::Workspace, "d/STATE.md"), None);
        assert_eq!(fs.writes(), 0);
        let got = fs.write_licensed_then(FileRoot::Workspace, &l, b"new", None,
            || async { Err(err!("the archive would not append."; IO, File, Write)) }).await;
        assert!(got.is_err(), "{:?}", got);
        assert_eq!(fs.peek(FileRoot::Workspace, "d/STATE.md"), None);
        assert_eq!(fs.writes(), 0);
    }

    /// HL1 (c): the runner's NativeFs has no lock to hold across a `pre` step, so a held write
    /// with one is refused on a workspace path that is not store-owned, before its compare, with
    /// `pre` never run and nothing written; the no-op route (`write_licensed_if`) still writes.
    /// Since HL5b a Diamond's path is the store's (`store/pipe_tests.rs`), so this one is not.
    #[tokio::test]
    async fn hl1_c_nativefs_refuses_a_pre_step_on_a_workspace_path() {
        use crate::diamond_versions::Seen;
        use crate::engine::host::native::fs::NativeFs;
        use std::cell::Cell;
        let c = ctx();
        let nfs = NativeFs::over(c.workspace.clone());
        let l = lic(&c, "notes/DECISIONS.md");
        nfs.write_licensed(FileRoot::Workspace, &l, b"old").await.expect("seed");
        let ran = Cell::new(0u8);
        let r = &ran;
        for root in [FileRoot::Workspace, FileRoot::Opfs] {
            for expect in [Some(Seen::of(Some(b"old"))), None] {
                let got = nfs.write_licensed_then(root, &l, b"new", expect.as_ref(),
                    move || async move { r.set(r.get() + 1); Ok(()) }).await;
                match got {
                    Err(e) => assert!(fmt!("{}", e).contains("whose lock is the store's"), "{}", e),
                    Ok(o)  => panic!("a pre step on a workspace path was taken: {:?}", o),
                }
            }
        }
        assert_eq!(ran.get(), 0, "a refused write ran pre");
        let on_disk = || std::fs::read(c.workspace.root().join("notes/DECISIONS.md"))
            .expect("read");
        assert_eq!(on_disk(), b"old");
        let got = nfs.write_licensed_if(FileRoot::Workspace, &l, b"new", &Seen::of(Some(b"old"))).await;
        assert_eq!(got.expect("the no-op route lands"), None);
        let got = nfs.write_licensed_if(FileRoot::Workspace, &l, b"newer", &Seen::of(Some(b"old"))).await;
        assert_eq!(got.expect("refused"), Some(Seen::of(Some(b"new"))));
        assert_eq!(on_disk(), b"new");
    }

    // ── HL3: the door (held-lock settle P3, P4) ──

    const DEC: &str = "diamonds/d/DECISIONS.md";
    const STA: &str = "diamonds/d/STATE.md";

    /// A turn on the store's own root, where a Diamond's standing files are.
    fn store_ctx() -> ToolContext<TestHost> {
        let mut c = ctx();
        c.root = FileRoot::Opfs;
        c
    }

    /// A DECISIONS.md landing that moves one line to its archive.
    fn dec_landing() -> crate::engine::host::types::store::Landed {
        crate::engine::host::types::store::Landed {
            said:    "\nOne line moved to the archive.".to_string(),
            archive: vec![(crate::tools::DECISIONS_FILE.to_string(), "- the oldest line\n".to_string())],
            ..Default::default()
        }
    }

    /// A STATE.md landing computed from `from`: a section to the archive, a DECISIONS line, a
    /// touched row.
    fn state_landing(from: Option<&[u8]>) -> crate::engine::host::types::store::Landed {
        crate::engine::host::types::store::Landed {
            said:    "\nA section moved.".to_string(),
            archive: vec![(crate::tools::STATE_FILE.to_string(), "## Old\n\nold\n".to_string())],
            noted:   vec!["- 2026-10-23 Old retired to the archive".to_string()],
            touched: vec!["1760832000000\tWhere".to_string()],
            from:    Some(crate::diamond_versions::Seen::of(from)),
            at:      1760832000000,
            ..Default::default()
        }
    }

    fn phases(c: &ToolContext<TestHost>) -> Vec<crate::engine::host::types::store::SettlePhase> {
        c.host().store().settled().into_iter().map(|(_, p)| p).collect()
    }

    async fn seed(c: &ToolContext<TestHost>, path: &str, bytes: &[u8]) {
        c.host().fs().write_licensed(FileRoot::Opfs, &lic(c, path), bytes).await.expect("seed");
    }

    async fn edit(c: &ToolContext<TestHost>, path: &str, old: &str, new: &str) -> Outcome<String> {
        let args = fmt!("{{\"path\":\"{}\",\"edits\":[{{\"old_string\":\"{}\",\"new_string\":\"{}\"}}]}}",
            path, old, new);
        crate::tools::Tool::FileEdit.execute(&args, c).await.map(|m| fmt!("{:?}", m))
    }

    async fn write(c: &ToolContext<TestHost>, path: &str, content: &str) -> Outcome<String> {
        let args = fmt!("{{\"path\":\"{}\",\"content\":\"{}\"}}", path, content);
        crate::tools::Tool::FileWrite.execute(&args, c).await.map(|m| fmt!("{:?}", m))
    }

    /// HL3 (a), QA-A2's red: a save between `file_edit`'s read of DECISIONS.md and its write is
    /// refused under the lock, and the landing's archive is not written for the refused write.
    #[tokio::test]
    async fn hl3_a_a_refused_edit_settles_nothing() {
        let c = store_ctx();
        seed(&c, DEC, b"- the oldest line\n- one\n").await;
        c.host().store().land_as(dec_landing());
        c.host().fs().save_before_lock(DEC, b"the person's save");
        let got = edit(&c, DEC, "- one", "- two").await;
        assert!(fmt!("{:?}", got).contains("since you read it"), "{:?}", got);
        assert_eq!(c.host().fs().peek(FileRoot::Opfs, DEC), Some(b"the person's save".to_vec()));
        assert_eq!(phases(&c), vec![], "a refused edit settled its landing");
        // Nothing in between: the edit lands, archive first, its landing said.
        seed(&c, DEC, b"- the oldest line\n- one\n").await;
        let got = edit(&c, DEC, "- one", "- two").await;
        assert!(fmt!("{:?}", got).contains("One line moved"), "{:?}", got);
        assert_eq!(c.host().fs().peek(FileRoot::Opfs, DEC),
            Some(b"- the oldest line\n- two\n".to_vec()));
        assert_eq!(phases(&c), vec![crate::engine::host::types::store::SettlePhase::Archive]);
    }

    /// HL3 (b): the same through `file_write` under a restore, whose held arm compares with the
    /// bytes the restore read: a save since is refused with nothing settled, the hold given back
    /// and the person asked again.
    #[tokio::test]
    async fn hl3_b_a_refused_restore_settles_nothing() {
        let mut c = store_ctx();
        c.restoring = 7;
        c.host().store().restore_in("d");
        seed(&c, DEC, b"- the oldest line\n- one\n").await;
        c.host().store().land_as(dec_landing());
        c.host().fs().save_before_lock(DEC, b"the person's save");
        let got = write(&c, DEC, "- restored\\n").await;
        assert_eq!(c.host().fs().peek(FileRoot::Opfs, DEC), Some(b"the person's save".to_vec()),
            "{:?}", got);
        assert_eq!(phases(&c), vec![], "a refused restore settled its landing: {:?}", got);
        assert_eq!(c.host().store().restores(), vec!["let go".to_string(), "asked".to_string()]);
    }

    /// HL3 (c): a STATE.md landing whose write is refused calls neither phase; an accepted one
    /// archives before the bytes land and records after; a failed archive writes nothing.
    #[tokio::test]
    async fn hl3_c_state_landing_order() {
        use crate::engine::host::types::store::SettlePhase;
        let old: &[u8] = b"# State\n\n## Old\n\nold\n";
        // Refused: the landing was computed from `old`, and a save landed since.
        let c = store_ctx();
        seed(&c, STA, old).await;
        c.host().store().land_as(state_landing(Some(old)));
        c.host().fs().save_before_lock(STA, b"the person's save");
        let got = write(&c, STA, "# State\\n").await;
        assert_eq!(c.host().fs().peek(FileRoot::Opfs, STA), Some(b"the person's save".to_vec()),
            "a STATE write landed over a save its landing never read: {:?}", got);
        assert_eq!(phases(&c), vec![], "{:?}", got);
        // A failed archive: nothing written, nothing recorded.
        let c = store_ctx();
        seed(&c, STA, old).await;
        c.host().store().land_as(state_landing(Some(old)));
        c.host().store().fail_archive();
        let got = write(&c, STA, "# State\\n").await;
        assert!(got.is_err(), "{:?}", got);
        assert_eq!(c.host().fs().peek(FileRoot::Opfs, STA), Some(old.to_vec()));
        assert_eq!(phases(&c), vec![SettlePhase::Archive]);
        // Accepted: Archive, then the bytes, then Record.
        let c = store_ctx();
        seed(&c, STA, old).await;
        c.host().store().land_as(state_landing(Some(old)));
        let got = write(&c, STA, "# State\\n").await;
        assert!(got.is_ok(), "{:?}", got);
        assert_eq!(c.host().fs().peek(FileRoot::Opfs, STA), Some(b"# State\n".to_vec()));
        assert_eq!(phases(&c), vec![SettlePhase::Archive, SettlePhase::Record]);
    }

    /// HL3 (d): a `Record` that fails does not fail a write that has landed: the reply says it
    /// landed and that its DECISIONS note could not be added.
    #[tokio::test]
    async fn hl3_d_a_failed_record_is_a_landed_write_with_a_note() {
        use crate::engine::host::types::store::SettlePhase;
        let old: &[u8] = b"# State\n\n## Old\n\nold\n";
        let c = store_ctx();
        seed(&c, STA, old).await;
        c.host().store().land_as(state_landing(Some(old)));
        c.host().store().fail_record();
        let got = write(&c, STA, "# State\\n").await;
        let said = fmt!("{:?}", got);
        assert!(got.is_ok() && said.contains("Wrote") && said.contains("could not be added"),
            "{}", said);
        assert_eq!(c.host().fs().peek(FileRoot::Opfs, STA), Some(b"# State\n".to_vec()));
        assert_eq!(phases(&c), vec![SettlePhase::Archive, SettlePhase::Record]);
    }

    /// HL3 (e): a write bound to one read and a landing computed from another is refused before
    /// the lock, with nothing settled; under a restore, the hold is given back and the person is
    /// not asked about bytes nobody found.
    #[tokio::test]
    async fn hl3_e_bound_and_from_differing_is_refused_before_the_lock() {
        let old: &[u8] = b"# State\n\n## Old\n\nold\n";
        let c = store_ctx();
        seed(&c, STA, old).await;
        c.host().store().land_as(state_landing(Some(b"another read")));
        let writes = c.host().fs().writes();
        let got = edit(&c, STA, "old", "new").await;
        assert!(fmt!("{:?}", got).contains("changed just now"), "{:?}", got);
        assert_eq!(c.host().fs().peek(FileRoot::Opfs, STA), Some(old.to_vec()));
        assert_eq!(phases(&c), vec![]);
        assert_eq!(c.host().fs().writes(), writes, "{:?}", c.host().fs().log());
        let mut c = store_ctx();
        c.restoring = 7;
        c.host().store().restore_in("d");
        seed(&c, STA, old).await;
        c.host().store().land_as(state_landing(Some(b"another read")));
        let got = write(&c, STA, "# State\\n").await;
        assert_eq!(c.host().fs().peek(FileRoot::Opfs, STA), Some(old.to_vec()), "{:?}", got);
        assert_eq!(phases(&c), vec![], "{:?}", got);
        assert_eq!(c.host().store().restores(), vec!["let go".to_string()], "{:?}", got);
    }

    /// HL3 (f): the door's shape, read from the source.  Neither page door nor `write_over`
    /// settles for itself; there is one `write_licensed_then` with a pre step in the crate, the
    /// door's, and its ARCHIVE arm reaches nothing that could wait on a person or a version hold.
    #[test]
    fn hl3_f_one_door_and_its_archive_arm_waits_on_nothing() {
        const SRC: &str = include_str!("../../../tools.rs");
        let at = |src: &str, what: &str| match src.find(what) {
            Some(i) => i,
            None    => panic!("not found: {}", what),
        };
        let code = &SRC[..at(SRC, "#[cfg(test)]\nmod tests")];
        let body = |head: &str| {
            let f = &code[at(code, head)..];
            &f[..at(&f[1..], "\n    async fn ") + 1]
        };
        for head in ["async fn file_write_page<", "async fn file_edit_page<", "async fn write_over<"] {
            assert!(!body(head).contains("standing_settle("), "{} settles for itself", head);
        }
        // Every `.write_licensed_then(` call in the crate with a step that does something is the
        // door's; the HostFs impls route their own no-op through it.
        let mut dirs = vec![std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src")];
        let mut calls: Vec<String> = Vec::new();
        while let Some(dir) = dirs.pop() {
            for e in std::fs::read_dir(&dir).expect("src reads").flatten() {
                let p = e.path();
                if p.is_dir() {
                    dirs.push(p);
                    continue;
                }
                if p.extension().map_or(true, |x| x != "rs") {
                    continue;
                }
                // A test module in a file of its own (`pipe_tests.rs`, HL5b) drives the door's
                // landing as a test, not as a second door.
                if p.file_stem().map_or(false, |s| s.to_string_lossy().ends_with("tests")) {
                    continue;
                }
                let src = std::fs::read_to_string(&p).expect("a source file reads");
                let code = match src.find("#[cfg(test)]\nmod tests") {
                    Some(i) => &src[..i],
                    None    => &src[..],
                };
                for (i, _) in code.match_indices(".write_licensed_then(") {
                    let call = &code[i..];
                    let call = &call[..call.find(".await").unwrap_or(call.len())];
                    if !call.contains("|| async { Ok(()) }") {
                        calls.push(fmt!("{}", p.display()));
                    }
                }
            }
        }
        assert_eq!(calls.len(), 1, "one held write with a pre step in the crate: {:?}", calls);
        assert!(calls[0].ends_with("src/tools.rs"), "{:?}", calls);
        let door = &code[at(code, "pub async fn landed_store_write<")..];
        let door = &door[..at(door, "\n}\n")];
        let pre = &door[at(door, ".write_licensed_then(")..];
        let pre = &pre[..at(pre, ".await")];
        assert!(pre.contains("SettlePhase::Archive"), "the pre step is not the archive: {}", pre);
        for bad in ["restore_", "versions", "ask_change", "hand_door", "HostUi"] {
            assert!(!pre.contains(bad), "the archive arm names {}: {}", bad, pre);
        }
        // Order: the archive under the lock, then the record after it.
        assert!(at(door, "settle_check(") < at(door, ".write_licensed_then(")
            && at(door, ".write_licensed_then(") < at(door, "SettlePhase::Record"), "I-HL1 order");
    }
}
