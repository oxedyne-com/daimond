//! The Diamond store's backend: the primitives it reaches its own area through, and the
//! environment it runs in (d1_plan §2, D1s0).
//!
//! The store keeps every record as a file keyed by its OPFS path (`diamonds/<id>/…`).  A backend
//! answers the sixteen OPFS primitives on that area, takes and queries the named locks the store
//! serialises its mints and restores under, and answers the environment questions a tab answers
//! from its page: the folder open, the folders this device knows, this page's name, and the reads
//! and writes the store makes on a user root.
//!
//! The backend is chosen statically ([`Backend`]), never threaded through the store's calls:
//! [`own`] holds facade functions under the `opfs::` names, which the store calls in place of
//! `opfs::` with `FileRoot::Opfs`.

pub mod call;
pub mod conformance;
pub mod diamond;
#[cfg(not(target_arch = "wasm32"))]
pub mod door;
#[cfg(not(target_arch = "wasm32"))]
pub mod mem;
#[cfg(not(target_arch = "wasm32"))]
pub mod native;
#[cfg(not(target_arch = "wasm32"))]
pub mod ozone;
pub mod own;
#[cfg(not(target_arch = "wasm32"))]
pub mod pipe;
#[cfg(not(target_arch = "wasm32"))]
pub mod remote;
#[cfg(not(target_arch = "wasm32"))]
pub mod run;
#[cfg(not(target_arch = "wasm32"))]
pub mod server;
pub mod standing;
#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests_serial;
#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests_limits;

#[cfg(not(target_arch = "wasm32"))]
pub use native::install;

/// A test's own folder, `name` and the process id under `DAIMOND_TEST_TMP`, emptied first: every
/// store test that touches disk makes its folder here, and never under `/tmp`, which is memory on
/// the fleet's hosts.  A run without the variable set refuses; the build command exports it.
#[cfg(all(test, not(target_arch = "wasm32")))]
pub(crate) fn test_dir(name: &str) -> std::path::PathBuf {
    let base = match std::env::var("DAIMOND_TEST_TMP") {
        Ok(b) if !b.is_empty()  => std::path::PathBuf::from(b),
        _                       => panic!("DAIMOND_TEST_TMP is not set, so the test '{}' has no \
            folder to work in: export it to a directory off /tmp.", name),
    };
    let dir = base.join(fmt!("{}-{}", name, std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    if let Err(e) = std::fs::create_dir_all(&dir) {
        panic!("the test folder {:?}: {}", dir, e);
    }
    dir
}

use crate::{
    diamond_versions::Seen,
    tools::FileRoot,
};

use oxedyne_fe2o3_core::prelude::*;

/// The backend this build's store runs over: OPFS in the tab.
#[cfg(target_arch = "wasm32")] pub type Backend = crate::wasm::store_opfs::OpfsBackend;
/// The backend this build's store runs over natively.
#[cfg(not(target_arch = "wasm32"))] pub type Backend = native::NativeBackend;

/// The backend this thread's store runs over.
#[cfg(target_arch = "wasm32")]
pub fn backend() -> Backend { Backend::default() }
/// The backend this thread's store runs over: the one [`install`]ed here, or none.
#[cfg(not(target_arch = "wasm32"))]
pub fn backend() -> Backend { native::installed() }

/// How a lock is asked for.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LockHow {
    /// Wait for as long as it takes.
    Wait,
    /// Take it only where nobody holds it.
    IfAvailable,
    /// Wait at most this many ms.
    Timeout(u64),
}

/// What asking for a lock came to.
#[derive(Debug)]
pub enum Locked<L> {
    /// Granted; given back when dropped.
    Held(L),
    /// This environment has no lock manager.
    NoManager,
    /// Still held elsewhere when the wait ran out.
    TimedOut,
    /// Held elsewhere, asked for only if free.
    Busy,
    /// The lock manager refused the request, in its words.
    Refused(String),
}

/// The primitives on the store's own area.  Keys are the store's OPFS paths.
#[allow(async_fn_in_trait)]
pub trait StoreBackend {
    /// A held lock.  [`StoreBackend::release`] gives it back and says when that is done; a lock
    /// that is only dropped -- a scope left, a `?` return, a future dropped, the page gone -- is
    /// given back too, but is free by the next task, not at once (in the tab, the lock manager
    /// lets it go one task after the drop).
    type Lock;

    async fn read_file(&self, key: &str) -> Outcome<Vec<u8>>;
    async fn read_file_capped(&self, key: &str, max: u32) -> Outcome<(Vec<u8>, f64)>;
    async fn write_file(&self, key: &str, bytes: &[u8]) -> Outcome<()>;
    async fn write_file_if(&self, key: &str, bytes: &[u8], expect: Option<&Seen>)
        -> Outcome<Option<Seen>>;
    async fn exists(&self, key: &str) -> Outcome<bool>;
    async fn list_dir(&self, dir: &str) -> Outcome<Vec<(String, bool, u64)>>;
    async fn list_dir_stamped(&self, dir: &str) -> Outcome<Vec<(String, bool, u64, Option<f64>)>>;
    async fn stamp(&self, key: &str) -> Outcome<Option<(f64, f64)>>;
    async fn delete_file(&self, key: &str) -> Outcome<()>;
    async fn delete_file_if(&self, key: &str, expect: &Seen) -> Outcome<Option<Seen>>;
    async fn delete_entry(&self, key: &str, recursive: bool) -> Outcome<()>;
    async fn move_entry(&self, from: &str, to: &str) -> Outcome<()>;

    /// Take the lock `name`, as `how` says.
    async fn lock(&self, name: &str, how: LockHow) -> Locked<Self::Lock>;
    /// Is the lock `name` held by anyone?  `None` where the environment cannot say.
    async fn lock_held(&self, name: &str) -> Option<bool>;
    /// Give `lock` back, and return only once it is free: from then on `lock_held` of its name
    /// reads `Some(false)` and a `lock` of it with [`LockHow::IfAvailable`] is granted, in this
    /// page and in every other, until someone takes it again.
    async fn release(&self, lock: Self::Lock);
}

/// The environment the store runs in: per page in the tab.
///
/// Besides the folder and the page, the environment answers for the clock, the console, the
/// diagnostic trail and the heap, and for this device's press of a link.
#[allow(async_fn_in_trait)]
pub trait StoreEnv {
    /// The id of the folder open on this computer, if one is.
    fn folder_id() -> Option<String>;
    /// Does this device know the folder `id`?
    fn folder_known(id: &str) -> bool;
    /// Is a folder open?
    fn folder_open() -> bool;
    /// This page's own name, stamped on the notes it leaves.
    fn this_page() -> String;
    /// Is the page `page` still live, so a note it left is its own?  In the tab, only this page.
    fn page_is_live(page: &str) -> bool;
    /// Milliseconds since the epoch, on the wall clock.
    fn now_ms() -> f64;
    /// Today, as `YYYY-MM-DD`, on the clock of the person whose record this is.
    fn today() -> String;
    /// Note `msg` where the environment keeps its log.
    fn console_log(msg: &str);
    /// Warn of `msg` where the environment keeps its warnings.
    fn console_warn(msg: &str);
    /// Leave `what` and `detail` on the diagnostic trail, where the environment keeps one.
    fn trail(what: &str, detail: &str);
    /// The heap in use, in MB, where the environment can tell (0 where not).
    fn heap_mb() -> u32;
    /// Drop this device's press of the link `id` of the Diamond `owner`.
    fn forget_press(owner: &str, id: &str) -> Outcome<()>;
    /// The root a paired machine hands out, where no folder is open and a hand holds its mark.
    async fn machine_door_root(&self) -> Option<String>;

    // The store's reads and writes on a user root (`Workspace`, `Machine`).
    async fn user_read_file(&self, root: FileRoot, path: &str) -> Outcome<Vec<u8>>;
    async fn user_read_file_capped(&self, root: FileRoot, path: &str, max: u32)
        -> Outcome<(Vec<u8>, f64)>;
    async fn user_write_file(&self, root: FileRoot, path: &str, bytes: &[u8]) -> Outcome<()>;
    async fn user_write_file_if(&self, root: FileRoot, path: &str, bytes: &[u8],
        expect: Option<&Seen>) -> Outcome<Option<Seen>>;
    async fn user_delete_file_if(&self, root: FileRoot, path: &str, expect: &Seen)
        -> Outcome<Option<Seen>>;
    async fn user_exists(&self, root: FileRoot, path: &str) -> Outcome<bool>;
    async fn user_list_dir(&self, root: FileRoot, path: &str) -> Outcome<Vec<(String, bool, u64)>>;
}

#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "tests.rs"]
mod store_tests;

#[cfg(test)]
#[path = "../../tests/unit/store/tests.rs"]
mod tests;
