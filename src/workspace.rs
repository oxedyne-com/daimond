//! Per-user workspace — the sandboxed directory the agent operates in.
//!
//! A workspace is a single directory on the Daimond host.  All agent file
//! operations resolve through `resolve()`, which jails paths to the
//! workspace root.  In the trusted, self-hosted environment (plan D0)
//! this is an *accident* guardrail — keeping the agent inside the
//! workspace by default — not a hardened *attack* boundary.
//!
//! The `resolve` / `display_rel` path logic is pure and target-agnostic.
//! The backing store is `std::fs`, which compiles on wasm32 but returns
//! "unsupported" at runtime — the browser filesystem is OPFS.
// TODO(wasm-opfs): back `Workspace` (and the file tools in `tools.rs`)
// with an OPFS-backed store on wasm32.  This requires an async fs
// surface (OPFS access is async), so it is deferred to the browser
// tool-execution stage rather than bolted on here.

use oxedyne_fe2o3_core::prelude::*;

use std::path::{Component, Path, PathBuf};


/// A sandboxed working directory for one user.
#[derive(Clone, Debug)]
pub struct Workspace {
    /// Canonical absolute path to the workspace root.
    root: PathBuf,
    /// The folder, relative to the root, that a path a model writes relative is read from
    /// (UNBLOCK-32 F2b): a runner's run rooted at a machine folder (`usr`) has the whole home as
    /// its workspace and that folder as its base.  Empty: the root itself, as before.
    base: String,
    home: Option<PathBuf>,    // The device user's home, absolute, which `~` names; `None` where the run was not told it
}

impl Workspace {

    /// Open (creating if necessary) a workspace rooted at `root`.
    pub fn new(root: PathBuf) -> Outcome<Self> {
        if !root.exists() {
            res!(std::fs::create_dir_all(&root)
                .map_err(|e| err!(e, "Workspace: create root {:?} failed.", root; IO, File)));
        }
        let root = res!(std::fs::canonicalize(&root)
            .map_err(|e| err!(e, "Workspace: canonicalise {:?} failed.", root; IO, File)));
        Ok(Self { root, base: String::new(), home: None })
    }

    /// Construct a workspace from an already-trusted root without
    /// touching the filesystem.
    ///
    /// [`new`](Self::new) canonicalises the root against `std::fs`, which
    /// is unavailable at runtime on `wasm32` (the browser store is OPFS).
    /// This constructor stores the path verbatim, for callers that supply
    /// a canonical root or back the workspace with a non-`std::fs` store.
    /// Path jailing in [`resolve`](Self::resolve) is purely lexical and
    /// remains sound regardless of the backing store.
    pub fn unchecked(root: PathBuf) -> Self {
        Self { root, base: String::new(), home: None }
    }

    /// The workspace root path.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// This workspace with `base` (relative to the root, one canonical relative path) as the
    /// folder a relative path is read from (UNBLOCK-32 F2b).  The jail stays the root.
    pub fn with_base(mut self, base: &str) -> Self {
        let b = base.trim_matches('/');
        self.base = if b == "." { String::new() } else { b.to_string() };
        self
    }

    /// This workspace with `home`, the device user's home, as the folder `~` names.  An empty or
    /// relative `home` names none.
    pub fn with_home(mut self, home: &str) -> Self {
        self.home = match home.starts_with('/') {
            true    => Some(PathBuf::from(home)),
            false   => None,
        };
        self
    }

    /// The folder a relative path is read from, relative to the root; empty for the root.
    pub fn base(&self) -> &str {
        &self.base
    }

    /// `path` as a model wrote it, as the root-relative path every fence judges -- the one path
    /// resolver every file tool and `run`'s `cwd` pass through, before any check.
    ///
    /// A relative path is read from the base (UNBLOCK-32 F2b): with base `usr`, `code/bash/x` is
    /// `usr/code/bash/x`, so a read-only row on `usr/code/bash` holds; `""` and `"."` are the base
    /// itself.  `~` and `~/x` are the device user's home and `x` in it, and an absolute path is
    /// taken as given: either lands inside the root as its root-relative tail, or stays the
    /// absolute path it resolved to and meets [`crate::tools::path_refusal`], which names it and
    /// the root it is outside.  `~` with no home known, or any machine path in the browser's
    /// store (no [machine root](Self::machine_root)), is left as written for the same refusal.
    pub fn based(&self, path: &str) -> String {
        let tilde = match path.strip_prefix('~') {
            Some(r) if r.is_empty() || r.starts_with('/') => Some(r.trim_start_matches('/')),
            _                                             => None,
        };
        // A base is only ever set on a run whose workspace is the whole home (F2b), so there the
        // root is the home even where the home was not told.
        let home = match (&self.home, self.base.is_empty()) {
            (Some(h), _)    => Some(h),
            (None, false)   => Some(&self.root),
            (None, true)    => None,
        };
        let place = match (tilde, home) {
            (Some(_), None)                     => return path.to_string(),
            (Some(r), Some(h)) if r.is_empty()  => h.clone(),
            (Some(r), Some(h))                  => h.join(r),
            (None, _) if path.starts_with('/')  => PathBuf::from(path),
            (None, _)                           => {
                if self.base.is_empty() {
                    return path.to_string();
                }
                if path.is_empty() || path == "." {
                    return self.base.clone();
                }
                return fmt!("{}/{}", self.base, path);
            },
        };
        if self.machine_root().is_none() {
            return path.to_string();
        }
        match place.strip_prefix(&self.root) {
            Ok(r) if r.as_os_str().is_empty()   => String::from("."),
            Ok(r)                               => r.to_string_lossy().to_string(),
            Err(_)                              => place.to_string_lossy().to_string(),
        }
    }

    /// The root as a folder on this machine, or `None` for the browser's store, whose root `/`
    /// names no folder on any machine (UNBLOCK-58): an absolute path is then never rebased, and
    /// the briefing names no root.
    pub fn machine_root(&self) -> Option<&str> {
        match self.root.to_str() {
            Some("/") | Some("") | None => None,
            Some(r)                     => Some(r),
        }
    }

    /// A root-relative path as the model should write it back (UNBLOCK-32 F2b), the inverse of
    /// [`based`](Self::based): beneath the base it is relative to the base, elsewhere `~/`-rooted,
    /// so a path a listing names is the path that reaches it again.  With no base, `rel`.
    pub fn shown(&self, rel: &str) -> String {
        if self.base.is_empty() {
            return rel.to_string();
        }
        if rel == self.base {
            return String::from(".");
        }
        match rel.strip_prefix(self.base.as_str()).and_then(|r| r.strip_prefix('/')) {
            Some(r) => r.to_string(),
            None    => if rel.is_empty() || rel == "." { String::from("~") } else { fmt!("~/{}", rel) },
        }
    }

    /// Resolve a workspace-relative path to an absolute path, jailed to
    /// the root.  Absolute inputs and `..` traversal that escapes the
    /// root are rejected.  The path is built lexically (no filesystem
    /// access), then checked to remain within the root.
    pub fn resolve(&self, rel: &str) -> Outcome<PathBuf> {
        let rel = rel.trim_start_matches('/');
        let mut out = self.root.clone();
        for comp in Path::new(rel).components() {
            match comp {
                Component::Normal(c) => out.push(c),
                Component::CurDir    => {},
                Component::ParentDir => {
                    // Pop, but never above the root.
                    if !out.pop() || !out.starts_with(&self.root) {
                        return Err(err!(
                            "Workspace: path '{}' escapes the workspace.", rel;
                            Invalid, Input, Path));
                    }
                }
                Component::RootDir | Component::Prefix(_) => {
                    return Err(err!(
                        "Workspace: absolute path '{}' is not allowed.", rel;
                        Invalid, Input, Path));
                }
            }
        }
        if !out.starts_with(&self.root) {
            return Err(err!(
                "Workspace: path '{}' escapes the workspace.", rel;
                Invalid, Input, Path));
        }
        Ok(out)
    }

    /// Resolve `rel` as [`resolve`](Self::resolve) does, then prove the answer on disk, or
    /// `None` where the path really lands outside the root.
    ///
    /// `resolve` is lexical, so a folder inside the workspace that is a symbolic link to somewhere
    /// else carries every path beneath it out of the root while the string still reads as jailed.
    /// This canonicalises the deepest part of the path that exists and requires it to sit inside
    /// the canonical root.  The LEAF is never followed, so a link at the leaf is answered as the
    /// link and not as its target.  The verbs that destroy -- a delete, and a move, which deletes
    /// its source -- ask this rather than `resolve`.
    ///
    /// **It is a check, and the act comes after it.**  A folder swapped for a link between this
    /// answer and a `remove_file` or `rename` of the path it returned carries the act out of the
    /// root (audit of 2026-09-23).  So a verb that destroys acts through [`pin`](Self::pin),
    /// never on this answer.
    pub fn resolve_real(&self, rel: &str) -> Outcome<Option<PathBuf>> {
        let lex = res!(self.resolve(rel));
        let root = res!(std::fs::canonicalize(&self.root)
            .map_err(|e| err!(e, "Workspace: canonicalise {:?} failed.", self.root; IO, File)));
        if lex == self.root {
            return Ok(Some(root));
        }
        let (leaf, parent) = match (lex.file_name(), lex.parent()) {
            (Some(l), Some(p)) => (l.to_os_string(), p.to_path_buf()),
            _                  => return Ok(Some(root)),
        };
        // Walk up to what exists, so a destination whose folders are not made yet still resolves.
        // `symlink_metadata` rather than `exists`, which follows a link and would call a dangling
        // one absent and so step past it unexamined.
        let mut base = parent;
        let mut rest = Vec::new();
        while std::fs::symlink_metadata(&base).is_err() {
            match (base.file_name(), base.parent()) {
                (Some(n), Some(p)) => {
                    rest.push(n.to_os_string());
                    base = p.to_path_buf();
                }
                _ => break,
            }
        }
        let mut real = res!(std::fs::canonicalize(&base)
            .map_err(|e| err!(e, "Workspace: cannot resolve '{}' on disk.", rel; IO, File, Path)));
        if !real.starts_with(&root) {
            return Ok(None);
        }
        for n in rest.iter().rev() {
            real.push(n);
        }
        real.push(leaf);
        Ok(Some(real))
    }

    /// Resolve `rel` for an act that FOLLOWS links -- a read, a write, a listing, a folder made --
    /// or `None` where a link carries it outside the root.
    ///
    /// [`resolve_real`](Self::resolve_real) proves the folders on the way and leaves the leaf as
    /// it is, which is right for a delete or a move: they act on the link.  A read or a write acts
    /// on what the leaf points at, so here the leaf is followed too, and a link whose target is
    /// not there yet must still point inside, or the write would create it outside.  Until
    /// 2026-10-12 the native read and write asked only [`resolve`](Self::resolve), and both went
    /// through `lnk -> /outside` (CAPTURE-FENCE QA B F4).  The answer is the lexical path, which
    /// is what the callers quote back; like `resolve_real` it is a check, and the act follows it.
    /// Where the path really is comes from [`real_followed`](Self::real_followed).
    pub fn resolve_followed(&self, rel: &str) -> Outcome<Option<PathBuf>> {
        let lex = res!(self.resolve(rel));
        Ok(res!(self.real_followed(rel)).map(|_| lex))
    }

    /// Where `rel` REALLY is with every link on the way followed, the leaf too, or `None` where a
    /// link carries it outside the root.
    ///
    /// The deepest existing folder is canonicalised and the missing names below it appended (as
    /// [`resolve_real`](Self::resolve_real) does), then a link at the leaf, dangling or not, is
    /// followed hop by hop.  So the answer is the place an act that follows links would reach,
    /// however many folders are not made yet, and the fence judges THAT (U3a QC1 L2, 17 Oct 2026:
    /// the fence had judged the spelling where two folders were missing or the leaf dangled).
    pub fn real_followed(&self, rel: &str) -> Outcome<Option<PathBuf>> {
        let mut real = match res!(self.resolve_real(rel)) {
            Some(r) => r,
            None    => return Ok(None),
        };
        let root = res!(std::fs::canonicalize(&self.root)
            .map_err(|e| err!(e, "Workspace: canonicalise {:?} failed.", self.root; IO, File)));
        // A chain of links is followed hop by hop; the kernel's own bound on a chain is 40.
        for _ in 0..40 {
            match std::fs::symlink_metadata(&real) {
                Ok(m) if m.file_type().is_symlink() => {},
                _                                    => return Ok(Some(real)),
            }
            if let Ok(t) = std::fs::canonicalize(&real) {
                return Ok(if t.starts_with(&root) { Some(t) } else { None });
            }
            // Dangling: where it points must be inside, its folder proved on disk.
            let to = res!(std::fs::read_link(&real)
                .map_err(|e| err!(e, "Workspace: cannot read the link '{}'.", rel; IO, File)));
            let next = match real.parent() {
                Some(p) => p.join(to),
                None    => return Ok(None),
            };
            let (dir, name) = match (next.parent(), next.file_name()) {
                (Some(d), Some(n)) => (d.to_path_buf(), n.to_os_string()),
                _                  => return Ok(None),
            };
            real = match std::fs::canonicalize(&dir) {
                Ok(d) if d.starts_with(&root) => d.join(name),
                _                             => return Ok(None),
            };
        }
        Ok(None)
    }

    /// Resolve `rel` as [`resolve_real`](Self::resolve_real) does, then hold its parent folder
    /// open, so a delete or rename acts in THAT folder whatever is swapped into the path after
    /// the check.  `None` where the path leads out of the root, or where a folder on the way was
    /// replaced while it was being walked.  `make` creates missing folders on the way, for the
    /// destination of a move.
    pub fn pin(&self, rel: &str, make: bool) -> Outcome<Option<Pinned>> {
        match res!(self.resolve_real(rel)) {
            Some(real) => self.pin_real(&real, make),
            None       => Ok(None),
        }
    }

    /// Hold open the parent of `real`, an answer of [`resolve_real`](Self::resolve_real).
    ///
    /// On Linux the walk opens each folder below the canonical root through the one before it
    /// (`/proc/self/fd/<n>/<name>`), refuses one that is a link now, and proves that what it
    /// opened is the folder it examined (device and inode) -- the `openat` descent, in std and
    /// without `unsafe`.  The leaf is then named through the last handle, so neither `unlink`
    /// nor `rename`, which do not follow a final link, can be carried elsewhere.  Elsewhere the
    /// answer is the checked path, and the window between check and act remains.
    pub fn pin_real(&self, real: &Path, make: bool) -> Outcome<Option<Pinned>> {
        let root = res!(std::fs::canonicalize(&self.root)
            .map_err(|e| err!(e, "Workspace: canonicalise {:?} failed.", self.root; IO, File)));
        let rest = match real.strip_prefix(&root) {
            Ok(r)  => r.to_path_buf(),
            Err(_) => return Ok(None),
        };
        let mut names = Vec::new();
        for c in rest.components() {
            match c {
                Component::Normal(n) => names.push(n.to_os_string()),
                _                    => return Ok(None),
            }
        }
        let leaf = match names.pop() {
            Some(l) => l,
            None    => return Err(err!(
                "Workspace: the root itself cannot be removed or moved."; Invalid, Input, Path)),
        };
        #[cfg(target_os = "linux")]
        {
            use std::os::unix::fs::MetadataExt;
            let mut held = res!(std::fs::File::open(&root)
                .map_err(|e| err!(e, "Workspace: cannot open the root {:?}.", root; IO, File)));
            // Fail closed where the descriptor table is not there to walk through: acting on the
            // checked path instead would be the race this exists to close.
            if let Err(e) = std::fs::symlink_metadata(through(&held, std::ffi::OsStr::new("."))) {
                return Err(err!(e, "Workspace: /proc/self/fd is not available, so '{}' cannot \
                    be held open.", real.display(); IO, File, System));
            }
            for n in names.iter() {
                let p = through(&held, n);
                let seen = match std::fs::symlink_metadata(&p) {
                    Ok(m) => m,
                    Err(e) if make && e.kind() == std::io::ErrorKind::NotFound => {
                        res!(std::fs::create_dir(&p).map_err(|e| err!(e,
                            "Workspace: cannot create '{}' under '{}'.",
                            n.to_string_lossy(), real.display(); IO, File)));
                        res!(std::fs::symlink_metadata(&p).map_err(|e| err!(e,
                            "Workspace: '{}' vanished as it was made.", n.to_string_lossy();
                            IO, File)))
                    },
                    Err(e) => return Err(err!(e, "Workspace: '{}' on the way to '{}' is not \
                        there.", n.to_string_lossy(), real.display(); IO, File, Missing)),
                };
                // A link now, where the check found a folder: swapped in after it.
                if seen.file_type().is_symlink() {
                    return Ok(None);
                }
                if !seen.is_dir() {
                    return Err(err!("Workspace: '{}' on the way to '{}' is not a folder.",
                        n.to_string_lossy(), real.display(); Invalid, Input, Path));
                }
                let next = res!(std::fs::File::open(&p).map_err(|e| err!(e,
                    "Workspace: cannot open '{}'.", n.to_string_lossy(); IO, File)));
                let got = res!(next.metadata().map_err(|e| err!(e,
                    "Workspace: cannot read '{}'.", n.to_string_lossy(); IO, File)));
                // Swapped between the look and the open: what was opened is not what was seen.
                if got.dev() != seen.dev() || got.ino() != seen.ino() {
                    return Ok(None);
                }
                held = next;
            }
            Ok(Some(Pinned { real: real.to_path_buf(), parent: held, leaf }))
        }
        #[cfg(not(target_os = "linux"))]
        {
            if make {
                if let Some(parent) = real.parent() {
                    res!(std::fs::create_dir_all(parent).map_err(|e| err!(e,
                        "Workspace: creating '{}'.", parent.display(); IO, File)));
                }
            }
            Ok(Some(Pinned { real: real.to_path_buf(), leaf }))
        }
    }

    /// Display a resolved path as a workspace-relative string (for
    /// user-facing tool output).  Falls back to the full path if the
    /// path is somehow outside the root.
    pub fn display_rel(&self, p: &Path) -> String {
        match p.strip_prefix(&self.root) {
            Ok(r) => {
                let s = r.to_string_lossy().to_string();
                if s.is_empty() { ".".to_string() } else { s }
            }
            Err(_) => p.to_string_lossy().to_string(),
        }
    }
}

/// A path in the workspace whose parent folder is held open; see [`Workspace::pin`].
#[derive(Debug)]
pub struct Pinned {
    real:   PathBuf,            // the checked, canonical path, for messages and comparisons
    #[cfg(target_os = "linux")]
    parent: std::fs::File,      // the parent folder, held open
    leaf:   std::ffi::OsString,
}

impl Pinned {
    pub fn real(&self) -> &Path { &self.real }

    /// The path to hand `remove_file`, `rename` or `symlink_metadata`: the leaf named through the
    /// held parent, so the act lands in the folder that was checked.
    pub fn act(&self) -> PathBuf {
        #[cfg(target_os = "linux")]
        { through(&self.parent, &self.leaf) }
        #[cfg(not(target_os = "linux"))]
        { let _ = &self.leaf; self.real.clone() }
    }

    /// `name` beside the leaf, in the held parent.
    fn beside(&self, name: &std::ffi::OsStr) -> PathBuf {
        #[cfg(target_os = "linux")]
        { through(&self.parent, name) }
        #[cfg(not(target_os = "linux"))]
        { self.real.with_file_name(name) }
    }

    /// Writes `bytes` as the file this names, by replace: a new file in the held parent, renamed
    /// over the leaf (UNBLOCK-82 F5).  A write in place truncates the inode the name reaches, and
    /// a hard link in the workspace is a regular file inside the root that the link checks admit,
    /// so `std::fs::write` through it rewrote the file it shares an inode with, wherever that
    /// lies (the clean warm cargo target, measured).  The rename gives the name a new inode, so
    /// no other name of the old one is touched; it also lands in the folder that was checked,
    /// whatever is swapped into the path after the check.  A file there before keeps its mode.
    pub fn replace(&self, bytes: &[u8]) -> Outcome<()> {
        use std::io::Write;
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let act = self.act();
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos()).unwrap_or(0);
        let name = fmt!(".daimond-write-{}-{}-{}", std::process::id(), nanos,
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed));
        let tmp = self.beside(std::ffi::OsStr::new(&name));
        let mut f = res!(std::fs::OpenOptions::new().write(true).create_new(true).open(&tmp)
            .map_err(|e| err!(e, "Workspace: cannot make a file beside '{}'.", self.real.display();
            IO, File, Write)));
        let kept = match std::fs::symlink_metadata(&act) {
            Ok(m) if m.is_file()    => Some(m.permissions()),
            _                       => None,
        };
        let done = f.write_all(bytes)
            .and_then(|_| match kept {
                Some(p) => f.set_permissions(p),
                None    => Ok(()),
            })
            .and_then(|_| { drop(f); std::fs::rename(&tmp, &act) });
        if let Err(e) = done {
            let _ = std::fs::remove_file(&tmp);
            return Err(err!(e, "Workspace: cannot write '{}'.", self.real.display(); IO, File, Write));
        }
        Ok(())
    }
}

/// `name` inside the open folder `dir`, as a path the kernel resolves through the descriptor.
#[cfg(target_os = "linux")]
fn through(dir: &std::fs::File, name: &std::ffi::OsStr) -> PathBuf {
    use std::os::unix::io::AsRawFd;
    let mut p = PathBuf::from(fmt!("/proc/self/fd/{}", dir.as_raw_fd()));
    p.push(name);
    p
}

// ┌───────────────────────────────────────────────────────────────┐
// │ Tests                                                          │
// └───────────────────────────────────────────────────────────────┘

#[cfg(test)]
#[path = "../tests/unit/workspace/tests.rs"]
mod tests;
