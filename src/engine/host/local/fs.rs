//! LocalHost's fs port.  The native half reads and writes through `std::fs` and never calls it.

use crate::{
    diamond_versions::Seen,
    engine::host::fs::HostFs,
    tools::{
        FileRoot,
        Licence,
        Storage,
    },
};

use oxedyne_fe2o3_core::prelude::*;

use std::future::Future;

/// The refusal a port gives where its host has no such reach: `"<port>.<method> is not available
/// on this build"`.  LocalHost's ports give it everywhere, and TestHost's Exec, Net, Web and Ui
/// give it by delegating to LocalHost's.
pub fn unavailable<T>(port: &str, method: &str) -> Outcome<T> {
    Err(err!("{}.{} is not available on this build", port, method; Unimplemented))
}

/// LocalHost's fs port.
#[derive(Clone, Debug, Default)]
pub struct LocalFs;

impl HostFs for LocalFs {
    fn folder_open(&self) -> bool { false }
    async fn exists(&self, _root: FileRoot, _path: &str) -> Outcome<bool> {
        unavailable("fs", "exists")
    }
    async fn is_directory(&self, _root: FileRoot, _path: &str) -> Outcome<bool> {
        unavailable("fs", "is_directory")
    }
    async fn list_dir(&self, _root: FileRoot, _path: &str) -> Outcome<Vec<(String, bool, u64)>> {
        unavailable("fs", "list_dir")
    }
    async fn list_dir_stamped(&self, _root: FileRoot, _path: &str)
        -> Outcome<Vec<(String, bool, u64, Option<f64>)>>
    {
        unavailable("fs", "list_dir_stamped")
    }
    async fn read_file(&self, _root: FileRoot, _path: &str) -> Outcome<Vec<u8>> {
        unavailable("fs", "read_file")
    }
    async fn read_file_capped(&self, _root: FileRoot, _path: &str, _max: u32)
        -> Outcome<(Vec<u8>, f64)>
    {
        unavailable("fs", "read_file_capped")
    }
    async fn read_file_range(&self, _root: FileRoot, _path: &str, _offset: f64, _len: u32)
        -> Outcome<(Vec<u8>, f64)>
    {
        unavailable("fs", "read_file_range")
    }
    async fn write_licensed(&self, _root: FileRoot, _lic: &Licence, _content: &[u8]) -> Outcome<()> {
        unavailable("fs", "write_licensed")
    }
    async fn write_licensed_if(&self, root: FileRoot, lic: &Licence, content: &[u8], expect: &Seen)
        -> Outcome<Option<Seen>>
    {
        self.write_licensed_then(root, lic, content, Some(expect), || async { Ok(()) }).await
    }
    async fn write_licensed_then<P, F>(&self, _root: FileRoot, _lic: &Licence, _content: &[u8],
        _expect: Option<&Seen>, _pre: P) -> Outcome<Option<Seen>>
    where
        P: FnOnce() -> F,
        F: Future<Output = Outcome<()>>,
    {
        unavailable("fs", "write_licensed_then")
    }
    async fn create_dir_licensed(&self, _root: FileRoot, _lic: &Licence) -> Outcome<()> {
        unavailable("fs", "create_dir_licensed")
    }
    async fn delete_licensed(&self, _root: FileRoot, _lic: &Licence) -> Outcome<()> {
        unavailable("fs", "delete_licensed")
    }
    async fn move_licensed(&self, _root: FileRoot, _from: &Licence, _to: &Licence) -> Outcome<()> {
        unavailable("fs", "move_licensed")
    }
    fn storage_of(&self, _root: FileRoot, _path: &str) -> Storage { Storage::Nowhere }
    fn thrown(&self) -> String { String::new() }
    fn take_thrown(&self) -> String { String::new() }
    fn arm_folder_watch(&self) {}
    fn notify_folder_lost(&self) {}
    fn children_of(&self, _dir: &str) -> Vec<(String, bool, u64)> { Vec::new() }
    async fn cloud_fetch(&self, _path: &str) -> Outcome<String> {
        unavailable("fs", "cloud_fetch")
    }
    async fn cloud_forget_licensed(&self, _lic: &Licence) -> Outcome<String> {
        unavailable("fs", "cloud_forget_licensed")
    }
    fn cloud_size_of(&self, _path: &str) -> Option<u64> { None }
}
