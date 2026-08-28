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

    #[test]
    fn test_display_rel() {
        let ws = tmp_ws();
        let p = ws.resolve("x/y.rs").expect("resolve");
        assert_eq!(ws.display_rel(&p), "x/y.rs");
        assert_eq!(ws.display_rel(ws.root()), ".");
    }
}
