//! WasmHost's fs port: each method is one call to today's `opfs` or `cloud` door.

use crate::{
    diamond_versions::Seen,
    engine::host::fs::HostFs,
    tools::{
        FileRoot,
        Licence,
        Storage,
    },
    wasm::{
        cloud,
        opfs,
    },
};

use oxedyne_fe2o3_core::prelude::*;

use std::future::Future;

/// WasmHost's fs port.
#[derive(Clone, Debug, Default)]
pub struct WasmFs;

impl HostFs for WasmFs {
    fn folder_open(&self) -> bool { opfs::folder_open() }
    async fn exists(&self, root: FileRoot, path: &str) -> Outcome<bool> {
        opfs::exists(root, path).await
    }
    async fn is_directory(&self, root: FileRoot, path: &str) -> Outcome<bool> {
        opfs::is_directory(root, path).await
    }
    async fn list_dir(&self, root: FileRoot, path: &str) -> Outcome<Vec<(String, bool, u64)>> {
        opfs::list_dir(root, path).await
    }
    async fn list_dir_stamped(&self, root: FileRoot, path: &str)
        -> Outcome<Vec<(String, bool, u64, Option<f64>)>>
    {
        opfs::list_dir_stamped(root, path).await
    }
    async fn read_file(&self, root: FileRoot, path: &str) -> Outcome<Vec<u8>> {
        opfs::read_file(root, path).await
    }
    async fn read_file_capped(&self, root: FileRoot, path: &str, max: u32)
        -> Outcome<(Vec<u8>, f64)>
    {
        opfs::read_file_capped(root, path, max).await
    }
    async fn read_file_range(&self, root: FileRoot, path: &str, offset: f64, len: u32)
        -> Outcome<(Vec<u8>, f64)>
    {
        opfs::read_file_range(root, path, offset, len).await
    }
    async fn write_licensed(&self, root: FileRoot, lic: &Licence, content: &[u8]) -> Outcome<()> {
        opfs::write_licensed(root, lic, content).await
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
        opfs::write_licensed_then(root, lic, content, expect, pre).await
    }
    async fn create_dir_licensed(&self, root: FileRoot, lic: &Licence) -> Outcome<()> {
        opfs::create_dir_licensed(root, lic).await
    }
    async fn delete_licensed(&self, root: FileRoot, lic: &Licence) -> Outcome<()> {
        opfs::delete_licensed(root, lic).await
    }
    async fn move_licensed(&self, root: FileRoot, from: &Licence, to: &Licence) -> Outcome<()> {
        opfs::move_licensed(root, from, to).await
    }
    fn storage_of(&self, root: FileRoot, path: &str) -> Storage { opfs::storage_of(root, path) }
    fn thrown(&self) -> String { opfs::thrown() }
    fn take_thrown(&self) -> String { opfs::take_thrown() }
    fn arm_folder_watch(&self) { opfs::arm_folder_watch() }
    fn notify_folder_lost(&self) { opfs::notify_folder_lost() }
    fn children_of(&self, dir: &str) -> Vec<(String, bool, u64)> { cloud::children_of(dir) }
    async fn cloud_fetch(&self, path: &str) -> Outcome<String> { cloud::fetch(path).await }
    async fn cloud_forget_licensed(&self, lic: &Licence) -> Outcome<String> {
        cloud::forget_licensed(lic).await
    }
    fn cloud_size_of(&self, path: &str) -> Option<u64> { cloud::size_of(path) }
}
