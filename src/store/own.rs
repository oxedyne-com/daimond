//! The store's own area, under the `opfs::` names, over this build's [`Backend`].
//!
//! A call `opfs::read_file(FileRoot::Opfs, &p)` is `own::read_file(&p)` here; a read or write on a
//! user root is `own::user_*` with its root; the page's environment is [`folder_id`],
//! [`folder_known`], [`folder_open`], [`this_page`] and [`page_is_live`].

use crate::{
    diamond_versions::Seen,
    store::{Backend, LockHow, Locked, StoreBackend, StoreEnv},
    tools::FileRoot,
};

use oxedyne_fe2o3_core::prelude::*;

/// A lock held on this build's backend: given back by [`release`], or when dropped (free by the
/// next task, not at once).
pub type Held = <Backend as StoreBackend>::Lock;

fn b() -> Backend { crate::store::backend() }

pub async fn read_file(key: &str) -> Outcome<Vec<u8>> { b().read_file(key).await }

pub async fn read_file_capped(key: &str, max: u32) -> Outcome<(Vec<u8>, f64)> {
    b().read_file_capped(key, max).await
}

pub async fn write_file(key: &str, bytes: &[u8]) -> Outcome<()> { b().write_file(key, bytes).await }

pub async fn write_file_if(key: &str, bytes: &[u8], expect: Option<&Seen>) -> Outcome<Option<Seen>> {
    b().write_file_if(key, bytes, expect).await
}

/// [`write_file_if`], with `pre` run holding the file's lock once the compare has passed and
/// before the bytes land (HL6): a refusal runs no `pre`, and a `pre` that fails writes nothing.
pub async fn write_file_then<P, F>(key: &str, bytes: &[u8], expect: Option<&Seen>, pre: P)
    -> Outcome<Option<Seen>>
where
    P: FnOnce() -> F,
    F: std::future::Future<Output = Outcome<()>>,
{
    b().write_file_then(key, bytes, expect, pre).await
}

pub async fn exists(key: &str) -> Outcome<bool> { b().exists(key).await }

pub async fn list_dir(dir: &str) -> Outcome<Vec<(String, bool, u64)>> { b().list_dir(dir).await }

pub async fn list_dir_stamped(dir: &str) -> Outcome<Vec<(String, bool, u64, Option<f64>)>> {
    b().list_dir_stamped(dir).await
}

pub async fn stamp(key: &str) -> Outcome<Option<(f64, f64)>> { b().stamp(key).await }

pub async fn delete_file(key: &str) -> Outcome<()> { b().delete_file(key).await }

pub async fn delete_file_if(key: &str, expect: &Seen) -> Outcome<Option<Seen>> {
    b().delete_file_if(key, expect).await
}

/// Removes `key`, a folder whole where `recursive`, under no lock: the store's own door, never
/// a run's (QA1 F3).  Only the store's own housekeeping calls it (a Diamond's whole delete, its
/// pending and version stores, a migration or a rebase); a run's delete goes through
/// `store_file_act`, which removes one ordinary file under its lock.
/// `qa1_f3_delete_entry_is_the_stores_own_door` pins its callers.
pub async fn delete_entry(key: &str, recursive: bool) -> Outcome<()> {
    b().delete_entry(key, recursive).await
}

pub async fn move_entry(from: &str, to: &str) -> Outcome<()> { b().move_entry(from, to).await }

/// [`delete_file_if`], with `pre` run holding the file's lock once the compare has passed and
/// before the file goes (QA1 F1): a refusal runs no `pre`, and a `pre` that fails deletes nothing.
#[cfg(not(target_arch = "wasm32"))]
pub async fn delete_file_then<P, F>(key: &str, expect: &Seen, pre: P) -> Outcome<Option<Seen>>
where
    P: FnOnce() -> F,
    F: std::future::Future<Output = Outcome<()>>,
{
    b().delete_file_then(key, expect, pre).await
}

/// [`move_entry`], with `pre` run holding both names' locks before anything moves (QA1 F1): a
/// `pre` that fails moves nothing.
#[cfg(not(target_arch = "wasm32"))]
pub async fn move_entry_then<P, F>(from: &str, to: &str, pre: P) -> Outcome<()>
where
    P: FnOnce() -> F,
    F: std::future::Future<Output = Outcome<()>>,
{
    b().move_entry_then(from, to, pre).await
}

/// Take the lock `name`, as `how` says.
pub async fn lock(name: &str, how: LockHow) -> Locked<Held> { b().lock(name, how).await }

/// Is the lock `name` held by anyone?  `None` where this environment cannot say.
pub async fn lock_held(name: &str) -> Option<bool> { b().lock_held(name).await }

/// Give `held` back, and return once it is free in every page (see [`StoreBackend::release`]).
pub async fn release(held: Held) { b().release(held).await }

pub fn folder_id() -> Option<String> { Backend::folder_id() }

pub fn folder_known(id: &str) -> bool { Backend::folder_known(id) }

pub fn folder_open() -> bool { Backend::folder_open() }

pub fn this_page() -> String { Backend::this_page() }

pub fn page_is_live(page: &str) -> bool { Backend::page_is_live(page) }

pub fn now_ms() -> f64 { Backend::now_ms() }

pub fn today() -> String { Backend::today() }

pub fn console_log(msg: &str) { Backend::console_log(msg) }

pub fn console_warn(msg: &str) { Backend::console_warn(msg) }

pub fn trail(what: &str, detail: &str) { Backend::trail(what, detail) }

pub fn heap_mb() -> u32 { Backend::heap_mb() }

pub fn forget_press(owner: &str, id: &str) -> Outcome<()> { Backend::forget_press(owner, id) }

pub async fn machine_door_root() -> Option<String> { b().machine_door_root().await }

pub async fn user_read_file(root: FileRoot, path: &str) -> Outcome<Vec<u8>> {
    b().user_read_file(root, path).await
}

pub async fn user_read_file_capped(root: FileRoot, path: &str, max: u32)
    -> Outcome<(Vec<u8>, f64)>
{
    b().user_read_file_capped(root, path, max).await
}

pub async fn user_write_file(root: FileRoot, path: &str, bytes: &[u8]) -> Outcome<()> {
    b().user_write_file(root, path, bytes).await
}

pub async fn user_write_file_if(root: FileRoot, path: &str, bytes: &[u8], expect: Option<&Seen>)
    -> Outcome<Option<Seen>>
{
    b().user_write_file_if(root, path, bytes, expect).await
}

pub async fn user_delete_file_if(root: FileRoot, path: &str, expect: &Seen)
    -> Outcome<Option<Seen>>
{
    b().user_delete_file_if(root, path, expect).await
}

pub async fn user_exists(root: FileRoot, path: &str) -> Outcome<bool> {
    b().user_exists(root, path).await
}

pub async fn user_list_dir(root: FileRoot, path: &str) -> Outcome<Vec<(String, bool, u64)>> {
    b().user_list_dir(root, path).await
}
