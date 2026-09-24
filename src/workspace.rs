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
        Ok(Self { root })
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
        Self { root }
    }

    /// The workspace root path.
    pub fn root(&self) -> &Path {
        &self.root
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
mod tests {
    use super::*;

    /// A workspace rooted on a scratch directory of this call's own.
    ///
    /// Under the user cache rather than `std::env::temp_dir()`: `/tmp` is a tmpfs
    /// here, so a fixture written there is resident memory charged to the test
    /// binary, and the fixtures left by earlier runs are swept as this one is made.
    fn tmp_ws() -> Workspace {
        let dir = match oxedyne_fe2o3_test::scratch::scratch_dir("daimond_ws_test") {
            Ok(d)  => d,
            Err(e) => panic!("a scratch directory: {}", e),
        };
        Workspace::new(dir).expect("workspace")
    }

    #[test]
    fn test_resolve_normal() {
        let ws = tmp_ws();
        let p = ws.resolve("sub/file.txt").expect("resolve");
        assert!(p.starts_with(ws.root()));
        assert!(p.ends_with("sub/file.txt"));
    }

    #[test]
    fn test_resolve_leading_slash_treated_relative() {
        let ws = tmp_ws();
        let p = ws.resolve("/etc/passwd").expect("resolve");
        assert!(p.starts_with(ws.root()));
        assert!(p.ends_with("etc/passwd"));
    }

    #[test]
    fn test_resolve_escape_rejected() {
        let ws = tmp_ws();
        assert!(ws.resolve("../../../etc/passwd").is_err());
        assert!(ws.resolve("a/../../b").is_err());
    }

    #[test]
    fn test_resolve_curdir_and_reentry_ok() {
        let ws = tmp_ws();
        assert!(ws.resolve("./a/b").is_ok());
        // Leaves a subdir then re-enters the root — stays inside.
        assert!(ws.resolve("a/../b").is_ok());
    }

    #[test]
    fn test_no_path_a_caller_can_write_ever_resolves_outside_the_root() {
        // A PROPERTY, where the three tests above are outcomes, and the difference was
        // measured rather than argued.  On 2026-08-28 `dev/mutate.mjs` deleted the final
        // `starts_with` guard from `resolve` and all 857 tests stayed green: the named
        // cases above are each caught earlier, in the loop, so nothing was left holding
        // the guarantee the guard exists for.  What the fence promises is not "these two
        // strings are refused" but "nothing a caller can write comes back pointing
        // outside the root", so that is what is asserted, over everything a model or a
        // user has plausibly typed.
        //
        // Note what this does NOT claim.  It does not kill that mutation, because the
        // loop really does catch every one of these before the guard is reached; the
        // guard is defence in depth against a future edit to the loop, and no test can
        // pin an unreachable line.  What this pins is the loop's own guarantee, so that
        // an edit which relaxes it is caught here instead of nowhere.
        let ws = tmp_ws();
        let hostile = [
            "..",
            "../",
            "../..",
            "../etc/passwd",
            "a/../..",
            "a/b/../../..",
            "./../..",
            "a/./../../b",
            "/../etc/passwd",
            "//../..",
            "a//..//..//b",
            "....//",
            "a/../a/../a/../..",
        ];
        for rel in hostile {
            match ws.resolve(rel) {
                Ok(p) => assert!(p.starts_with(ws.root()),
                    "'{}' resolved to '{}', which is outside '{}'",
                    rel, p.display(), ws.root().display()),
                // A refusal is the other correct answer; this asks only that a
                // SUCCESS is always inside.
                Err(_) => {}
            }
        }
    }

    /// **A folder swapped for a link after the check must not carry the act out.**  The audit of
    /// 2026-09-23 found `resolve_real` to be check-then-act: its answer is a path, and a path is
    /// re-walked by the `remove_file` that follows it.
    #[cfg(target_os = "linux")]
    #[test]
    fn test_a_folder_swapped_for_a_link_after_the_check_does_not_carry_the_act_out_00() {
        let ws = tmp_ws();
        let outside = match oxedyne_fe2o3_test::scratch::scratch_dir("daimond_ws_outside") {
            Ok(d)  => d,
            Err(e) => panic!("a scratch directory: {}", e),
        };
        std::fs::write(outside.join("victim.txt"), "keep").expect("seed outside");
        std::fs::create_dir(ws.root().join("sub")).expect("sub");
        std::fs::write(ws.root().join("sub/victim.txt"), "mine").expect("seed inside");
        let real = ws.resolve_real("sub/victim.txt").expect("resolve").expect("inside");
        let held = ws.pin_real(&real, false).expect("pin").expect("inside");
        // The swap, in the window between the check and the act.
        std::fs::rename(ws.root().join("sub"), ws.root().join("sub.was")).expect("move aside");
        std::os::unix::fs::symlink(&outside, ws.root().join("sub")).expect("link");
        // The premise: the checked answer, walked again, now lands outside.
        assert_eq!(std::fs::read_to_string(&real).expect("read"), "keep",
            "the swap did not redirect the checked path, so this test proves nothing");
        // A walk begun after the swap refuses.
        assert!(ws.pin_real(&real, false).expect("walk").is_none(),
            "a folder that is now a link was walked through");
        // One held before it acts in the folder it held.
        std::fs::remove_file(held.act()).expect("delete through the held folder");
        assert!(outside.join("victim.txt").is_file(), "the delete was carried out of the root");
        assert!(!ws.root().join("sub.was/victim.txt").exists(), "the held file was not the one removed");
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[test]
    fn test_display_rel() {
        let ws = tmp_ws();
        let p = ws.resolve("x/y.rs").expect("resolve");
        assert_eq!(ws.display_rel(&p), "x/y.rs");
        assert_eq!(ws.display_rel(ws.root()), ".");
    }
}
