//! The fs port: read, write, list, delete and move, inside the fence.
//!
//! Every method that changes a path takes a [`Licence`], which only `ToolContext::licence` mints,
//! so no port is a door around the write fence.  The plain doors stay `pub(in crate::wasm)`.

use crate::{
    diamond_versions::Seen,
    tools::{
        FileRoot,
        Licence,
        Storage,
    },
};

use oxedyne_fe2o3_core::prelude::*;

use std::future::Future;

/// The fs port a [`Host`](super::Host) carries: today's `opfs` and `cloud` doors, by the same
/// names, except `cloud_fetch`, `cloud_forget_licensed` and `cloud_size_of`.
#[allow(async_fn_in_trait)]
pub trait HostFs {
    fn folder_open(&self) -> bool;
    async fn exists(&self, root: FileRoot, path: &str) -> Outcome<bool>;
    async fn is_directory(&self, root: FileRoot, path: &str) -> Outcome<bool>;
    async fn list_dir(&self, root: FileRoot, path: &str) -> Outcome<Vec<(String, bool, u64)>>;
    async fn list_dir_stamped(&self, root: FileRoot, path: &str)
        -> Outcome<Vec<(String, bool, u64, Option<f64>)>>;
    async fn read_file(&self, root: FileRoot, path: &str) -> Outcome<Vec<u8>>;
    async fn read_file_capped(&self, root: FileRoot, path: &str, max: u32) -> Outcome<(Vec<u8>, f64)>;
    async fn read_file_range(&self, root: FileRoot, path: &str, offset: f64, len: u32)
        -> Outcome<(Vec<u8>, f64)>;
    async fn write_licensed(&self, root: FileRoot, lic: &Licence, content: &[u8]) -> Outcome<()>;
    /// [`write_licensed_then`](Self::write_licensed_then) with nothing to do before the bytes
    /// land: every impl routes it there, so there is one code path.
    async fn write_licensed_if(&self, root: FileRoot, lic: &Licence, content: &[u8], expect: &Seen)
        -> Outcome<Option<Seen>>;
    /// [`write_licensed_if`](Self::write_licensed_if), with `pre` run under the file's lock once
    /// the compare has passed and before the bytes land (held-lock settle P1).  `expect` of `None`
    /// compares nothing (the plain write, still under the lock).  `Ok(None)` once written;
    /// `Ok(Some(found))` refused, with `pre` NOT run and nothing written; `Err` from the lock,
    /// from `pre` (then nothing is written) or from the write.
    async fn write_licensed_then<P, F>(&self, root: FileRoot, lic: &Licence, content: &[u8],
        expect: Option<&Seen>, pre: P) -> Outcome<Option<Seen>>
    where
        P: FnOnce() -> F,
        F: Future<Output = Outcome<()>>;
    async fn create_dir_licensed(&self, root: FileRoot, lic: &Licence) -> Outcome<()>;
    async fn delete_licensed(&self, root: FileRoot, lic: &Licence) -> Outcome<()>;
    async fn move_licensed(&self, root: FileRoot, from: &Licence, to: &Licence) -> Outcome<()>;
    fn storage_of(&self, root: FileRoot, path: &str) -> Storage;
    fn thrown(&self) -> String;
    fn take_thrown(&self) -> String;
    fn arm_folder_watch(&self);
    fn notify_folder_lost(&self);
    fn children_of(&self, dir: &str) -> Vec<(String, bool, u64)>;
    async fn cloud_fetch(&self, path: &str) -> Outcome<String>;
    async fn cloud_forget_licensed(&self, lic: &Licence) -> Outcome<String>;
    fn cloud_size_of(&self, path: &str) -> Option<u64>;
}
