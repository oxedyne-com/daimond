//! The Diamond store's backend on the native target (d1_plan §2, §9.2 D1cm).
//!
//! [`NativeBackend`] is chosen by enum, never by trait object: the memory store, or Ozone.
//! [`install`] puts one in place for the calling thread, and every `own::` call on that thread
//! runs over it.  With none installed every primitive refuses and no lock is managed: closed,
//! never "go".  The folder, the folders known and the page are the calling run's
//! ([`run::RunEnv`]); there is no page trail and no machine door.
//!
//! A path the store names against a user root is routed as the tab routes it ([`route`]): a
//! Diamond's own files go to the backend under any Workspace spelling, and the person's own files
//! are read as `Unreadable` and never written (spec §16.2), except inside a door errand, which
//! reads them, and only reads them, through its [`door::UserLink`] (spec §16.4).

use crate::{
    diamond_versions::Seen,
    store::{
        LockHow,
        Locked,
        StoreBackend,
        StoreEnv,
        call::Unreadable,
        door,
        mem::{MemBackend, MemLock},
        ozone::OzoneBackend,
        run,
    },
    tools::{FileRoot, Storage},
};

use oxedyne_fe2o3_core::prelude::*;
use oxedyne_fe2o3_datime::time::CalClockZone;

use std::cell::RefCell;

/// The store's backend natively.
#[derive(Clone, Debug, Default)]
pub enum NativeBackend {
    /// None installed: every call refuses.
    #[default]
    Closed,
    /// The store held in memory.
    Mem(MemBackend),
    /// The store in an Ozone store of the parent's own (D1o).
    Ozone(OzoneBackend),
    /// A memory store that panics when it is touched while [`in_sync`] is up: the seam that shows
    /// a sync call is answered with no await on the backend (d1v1 §3).
    #[cfg(test)]
    Tripwire(MemBackend),
    /// A memory store that holds the store's thread for a fixed time and then yields once,
    /// before each read, write and look, as a backend that works and then awaits does: the seam
    /// that shows two edits of one file interleave (D1r1e, with no hold), and that a sync call
    /// is answered ahead of the wait calls' backend work (D1x2b).
    #[cfg(test)]
    Slow(MemBackend, std::time::Duration),
    /// A memory store that lies about a version snapshot it has just written: read straight
    /// back, the key last written under a `versions/` directory answers altered bytes (D1t2
    /// rider).  The seam that reaches the keyframe's read-back refusal, which a store that keeps
    /// what it is given never does.
    #[cfg(test)]
    Lying(MemBackend),
}

#[cfg(test)]
thread_local! {
    static IN_SYNC: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    /// The `versions/` key a [`NativeBackend::Lying`] wrote last, which it lies about.
    static LIE_AT: RefCell<String> = const { RefCell::new(String::new()) };
}

/// The pauses every [`NativeBackend::Slow`] has made, on any thread: a test's evidence that its
/// calls reached the slow backend.
#[cfg(test)]
pub static SLOW_PAUSES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Runs `f` with the tripwire up: a [`NativeBackend::Tripwire`] touched inside it panics.
#[cfg(test)]
pub fn in_sync<R>(f: impl FnOnce() -> R) -> R {
    let was = IN_SYNC.with(|s| s.replace(true));
    let r = f();
    IN_SYNC.with(|s| s.set(was));
    r
}

impl NativeBackend {
    /// The store under this backend, or none where it is closed.
    fn pick(&self) -> Option<Pick<'_>> {
        match self {
            Self::Closed        => None,
            Self::Mem(m)        => Some(Pick::Mem(m)),
            Self::Ozone(o)      => Some(Pick::Ozone(o)),
            #[cfg(test)]
            Self::Tripwire(m)   => {
                if IN_SYNC.with(|s| s.get()) {
                    panic!("the store backend was reached inside a sync call");
                }
                Some(Pick::Mem(m))
            }
            #[cfg(test)]
            Self::Slow(m, _)    => Some(Pick::Mem(m)),
            #[cfg(test)]
            Self::Lying(m)      => Some(Pick::Mem(m)),
        }
    }

    /// Note a write where this is the lying double: a `versions/` key is the next one lied about.
    fn wrote(&self, _key: &str) {
        #[cfg(test)]
        if let Self::Lying(_) = self {
            if _key.contains("/versions/") {
                LIE_AT.with(|l| *l.borrow_mut() = _key.to_string());
            }
        }
    }

    /// What a read of `key` answers: `bytes`, except that the lying double alters the bytes of
    /// the `versions/` key it wrote last.
    fn told(&self, _key: &str, bytes: Vec<u8>) -> Vec<u8> {
        #[cfg(test)]
        if let Self::Lying(_) = self {
            if LIE_AT.with(|l| *l.borrow() == _key) {
                let mut bytes = bytes;
                bytes.push(b'!');
                return bytes;
            }
        }
        bytes
    }

    /// Hold the thread for the slow double's time and yield once, where this is the slow
    /// double, else nothing.
    async fn pause(&self) {
        #[cfg(test)]
        if let Self::Slow(_, hold) = self {
            SLOW_PAUSES.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            // Spun, not slept: a backend's own work on the thread, timed as one and not as a
            // sleeper's wake-up, which a loaded host stretches.
            let until = std::time::Instant::now() + *hold;
            while std::time::Instant::now() < until {
                std::hint::spin_loop();
            }
            let mut yielded = false;
            std::future::poll_fn(|cx| {
                if yielded {
                    std::task::Poll::Ready(())
                } else {
                    yielded = true;
                    cx.waker().wake_by_ref();
                    std::task::Poll::Pending
                }
            }).await;
        }
    }
}

/// A lock held on the native backend, given back when released or dropped, at once either way.
#[derive(Debug)]
pub enum NativeLock {
    Mem(MemLock),
}

/// The backend a call runs over.  Both hold their named locks in a memory table.
enum Pick<'a> {
    Mem(&'a MemBackend),
    Ozone(&'a OzoneBackend),
}

/// Run `$call` on the picked backend `$b`, or `$closed` where none is installed.
macro_rules! on {
    ($self:ident, $b:ident => $call:expr, $closed:expr) => {
        match $self.pick() {
            None                    => $closed,
            Some(Pick::Mem($b))     => $call,
            Some(Pick::Ozone($b))   => $call,
        }
    };
}

thread_local! {
    static INSTALLED: RefCell<NativeBackend> = RefCell::new(NativeBackend::Closed);
}

/// Put `backend` in place for this thread's store, answering what stood before.
pub fn install(backend: NativeBackend) -> NativeBackend {
    INSTALLED.with(|b| b.replace(backend))
}

/// The backend this thread's store runs over.
pub fn installed() -> NativeBackend {
    INSTALLED.with(|b| b.borrow().clone())
}

impl NativeBackend {
    /// The TTL sweep of folder `dir` on whichever store this is (R1f3, R1i): each entry at least
    /// `ttl_ms` old at `now_ms`, the caller's clock, deleted.  The values deleted.
    pub fn sweep_expired(&self, dir: &str, ttl_ms: u64, now_ms: u64) -> Outcome<usize> {
        on!(self, m => m.sweep_expired(dir, ttl_ms, now_ms), refused("sweep", dir))
    }
}

fn refused<V>(what: &str, key: &str) -> Outcome<V> {
    Err(err!("The Diamond store has no backend on this build, so '{}' of '{}' was refused.",
        what, key; Missing, Configuration))
}

fn mem_lock(l: Locked<MemLock>) -> Locked<NativeLock> {
    match l {
        Locked::Held(l)     => Locked::Held(NativeLock::Mem(l)),
        Locked::NoManager   => Locked::NoManager,
        Locked::TimedOut    => Locked::TimedOut,
        Locked::Busy        => Locked::Busy,
        Locked::Refused(w)  => Locked::Refused(w),
    }
}

/// How long a write of a store-owned key waits for its file before it is refused, in ms: the
/// tab's `FILE_WAIT_MS` (`wasm/store_opfs.rs`), for the same reason.
pub const FILE_WAIT_MS: u64 = 60_000;

/// The lock a mutation of `key` takes (HL5b): a store-owned key's file lock, named as the tab names
/// it ([`crate::fsname::file_lock_name`]), or `None` for a key no Diamond owns.
pub fn file_lock(key: &str) -> Option<String> {
    crate::tools::store_owned(FileRoot::Opfs, key)
        .map(|_| crate::fsname::file_lock_name(false, key))
}

impl NativeBackend {

    /// Wait for the file lock of `key` and hold it (HL5b): every mutation of a store-owned key
    /// takes it, as every OPFS write takes the tab's `hold_file`, so a plain write meets a held
    /// write and waits.  `None` where `key` is no Diamond's, or where no lock is managed.  **Not
    /// re-entrant**: what holds it writes through the `_unlocked` primitives.
    pub async fn hold_file(&self, key: &str) -> Outcome<Option<NativeLock>> {
        let name = match file_lock(key) {
            Some(n) => n,
            None    => return Ok(None),
        };
        match self.lock(&name, LockHow::Timeout(FILE_WAIT_MS)).await {
            Locked::Held(l)                 => Ok(Some(l)),
            Locked::NoManager               => Ok(None),
            Locked::TimedOut | Locked::Busy => Err(err!("'{}' has been held by another write for \
                over {} seconds, so nothing was written.  Try again in a moment.", key,
                FILE_WAIT_MS / 1000; Lock, Timeout)),
            Locked::Refused(why)            => Err(err!("The store would not lock '{}' for \
                writing ({}), so nothing was written.", key, why; Lock)),
        }
    }

    /// The file lock of `key` for a plain mutation: held, except under the test's red that takes
    /// it on the conditional write alone (`off("plain_lock")`).
    async fn hold_plain(&self, key: &str) -> Outcome<Option<NativeLock>> {
        if crate::store::diamond::off("plain_lock") {
            return Ok(None);
        }
        self.hold_file(key).await
    }

    /// The held, bound write of the store-owned `key` (HL6, held-lock settle P1 at the store):
    /// holding its file lock, compare what stands with `expect` (`Ok(Some(found))` refused, and
    /// `pre` not run), run `pre`, then write through the unlocked inner write.  A `pre` that
    /// fails leaves the file unwritten.  The fold's door, as `store_write_then` is a run's.
    pub async fn write_file_then<P, F>(&self, key: &str, bytes: &[u8], expect: Option<&Seen>,
        pre: P)
        -> Outcome<Option<Seen>>
    where
        P: FnOnce() -> F,
        F: std::future::Future<Output = Outcome<()>>,
    {
        if let Some(Seen::Unread) = expect {
            return Err(err!("A write of '{}' was bound to bytes that could not be read, so there \
                is nothing to compare.", key; Invalid, Input));
        }
        let _held = res!(self.hold_file(key).await);
        if let Some(want) = expect {
            let found = res!(self.found(key).await);
            if &found != want {
                return Ok(Some(found));
            }
        }
        res!(pre().await);
        res!(self.write_file_unlocked(key, bytes).await);
        Ok(None)
    }

    /// What stands at `key`, read by the holder of its file lock: its bytes, or absent.
    async fn found(&self, key: &str) -> Outcome<Seen> {
        match self.read_file(key).await {
            Ok(b)   => Ok(Seen::of(Some(&b))),
            Err(e)  => match self.exists(key).await {
                Ok(false)   => Ok(Seen::Absent),
                Ok(true)    => Err(err!(e, "'{}' stands but would not read, so nothing was \
                    changed.", key; IO, File, Read)),
                Err(e2)     => Err(err!(e2, "'{}' would not read and could not be found absent \
                    ({}), so nothing was changed.", key, e; IO, File, Read)),
            },
        }
    }

    /// The held, bound delete of `key` (QA1 F1): holding its file lock, compare what stands with
    /// `expect` (`Ok(Some(found))` refused, and `pre` not run), run `pre`, then delete.  A `pre`
    /// that fails leaves the file.  A run's `StoreFileAct` delete, its commit point in `pre`.
    pub async fn delete_file_then<P, F>(&self, key: &str, expect: &Seen, pre: P)
        -> Outcome<Option<Seen>>
    where
        P: FnOnce() -> F,
        F: std::future::Future<Output = Outcome<()>>,
    {
        let _held = res!(self.hold_file(key).await);
        let found = res!(self.found(key).await);
        if &found != expect {
            return Ok(Some(found));
        }
        res!(pre().await);
        on!(self, m => res!(m.delete_file(key).await), return refused("delete", key));
        Ok(None)
    }

    /// The held move of `from` to `to` (QA1 F1): both names' file locks held, as
    /// [`move_entry`](StoreBackend::move_entry) holds them, then `pre`, then the move.  A `pre`
    /// that fails moves nothing.  A run's `StoreFileAct` folder move, its commit point in `pre`.
    pub async fn move_entry_then<P, F>(&self, from: &str, to: &str, pre: P) -> Outcome<()>
    where
        P: FnOnce() -> F,
        F: std::future::Future<Output = Outcome<()>>,
    {
        let (_one, _two) = res!(self.hold_both(from, to).await);
        res!(pre().await);
        on!(self, m => m.move_entry(from, to).await, refused("move", from))
    }

    /// Both names' file locks, in one order (the names'), so two moves across the same pair
    /// cannot each hold one and wait for the other.
    async fn hold_both(&self, from: &str, to: &str)
        -> Outcome<(Option<NativeLock>, Option<NativeLock>)>
    {
        let (first, second) = match file_lock(from) <= file_lock(to) {
            true    => (from, to),
            false   => (to, from),
        };
        let one = res!(self.hold_plain(first).await);
        let two = match file_lock(first) == file_lock(second) {
            true    => None,
            false   => res!(self.hold_plain(second).await),
        };
        Ok((one, two))
    }

    /// The plain write of `key`, taking no lock: for the holder of its file lock alone (HL5b).
    pub async fn write_file_unlocked(&self, key: &str, bytes: &[u8]) -> Outcome<()> {
        self.pause().await;
        on!(self, m => {
            res!(m.write_file(key, bytes).await);
            self.wrote(key);
            Ok(())
        }, refused("write", key))
    }
}

impl StoreBackend for NativeBackend {
    type Lock = NativeLock;

    async fn read_file(&self, key: &str) -> Outcome<Vec<u8>> {
        self.pause().await;
        on!(self, m => Ok(self.told(key, res!(m.read_file(key).await))), refused("read", key))
    }
    async fn read_file_capped(&self, key: &str, max: u32) -> Outcome<(Vec<u8>, f64)> {
        on!(self, m => m.read_file_capped(key, max).await, refused("read", key))
    }
    // Every mutation of a store-owned key holds its file lock (HL5b), so none lands between a
    // held write's compare and its bytes.
    async fn write_file(&self, key: &str, bytes: &[u8]) -> Outcome<()> {
        let _held = res!(self.hold_plain(key).await);
        self.write_file_unlocked(key, bytes).await
    }
    async fn write_file_if(&self, key: &str, bytes: &[u8], expect: Option<&Seen>)
        -> Outcome<Option<Seen>>
    {
        let _held = res!(self.hold_file(key).await);
        on!(self, m => m.write_file_if(key, bytes, expect).await, refused("write", key))
    }
    async fn exists(&self, key: &str) -> Outcome<bool> {
        self.pause().await;
        on!(self, m => m.exists(key).await, refused("exists", key))
    }
    async fn list_dir(&self, dir: &str) -> Outcome<Vec<(String, bool, u64)>> {
        on!(self, m => m.list_dir(dir).await, refused("list", dir))
    }
    async fn list_dir_stamped(&self, dir: &str) -> Outcome<Vec<(String, bool, u64, Option<f64>)>> {
        on!(self, m => m.list_dir_stamped(dir).await, refused("list", dir))
    }
    async fn stamp(&self, key: &str) -> Outcome<Option<(f64, f64)>> {
        on!(self, m => m.stamp(key).await, refused("stamp", key))
    }
    async fn delete_file(&self, key: &str) -> Outcome<()> {
        let _held = res!(self.hold_plain(key).await);
        on!(self, m => m.delete_file(key).await, refused("delete", key))
    }
    async fn delete_file_if(&self, key: &str, expect: &Seen) -> Outcome<Option<Seen>> {
        let _held = res!(self.hold_file(key).await);
        on!(self, m => m.delete_file_if(key, expect).await, refused("delete", key))
    }
    async fn delete_entry(&self, key: &str, recursive: bool) -> Outcome<()> {
        on!(self, m => m.delete_entry(key, recursive).await, refused("delete", key))
    }
    async fn move_entry(&self, from: &str, to: &str) -> Outcome<()> {
        let (_one, _two) = res!(self.hold_both(from, to).await);
        on!(self, m => m.move_entry(from, to).await, refused("move", from))
    }

    async fn lock(&self, name: &str, how: LockHow) -> Locked<NativeLock> {
        on!(self, m => mem_lock(m.lock(name, how).await), Locked::NoManager)
    }
    async fn lock_held(&self, name: &str) -> Option<bool> {
        on!(self, m => m.lock_held(name).await, None)
    }
    async fn release(&self, lock: NativeLock) {
        drop(lock);
    }
}

/// Days since 1970-01-01 as a civil `(year, month, day)` (Howard Hinnant's `civil_from_days`).
fn civil(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    (y, m, d)
}

/// The host's zone, read once.
fn host_zone() -> &'static CalClockZone {
    static ZONE: std::sync::OnceLock<CalClockZone> = std::sync::OnceLock::new();
    ZONE.get_or_init(CalClockZone::here)
}

/// The date `now_ms` falls on `offset_ms` east of UTC, as `YYYY-MM-DD`.
fn local_date(now_ms: f64, offset_ms: i64) -> String {
    let (y, m, d) = civil(((now_ms + offset_ms as f64) / 86_400_000.0).floor() as i64);
    fmt!("{:04}-{:02}-{:02}", y, m, d)
}

impl StoreEnv for NativeBackend {
    fn folder_id() -> Option<String> { run::current(|e| e.folder_id.clone()).flatten() }
    fn folder_known(id: &str) -> bool { run::current(|e| e.known.contains(id)).unwrap_or(false) }
    fn folder_open() -> bool { Self::folder_id().is_some() }
    fn this_page() -> String { run::current(|e| e.page.clone()).unwrap_or_default() }
    fn page_is_live(page: &str) -> bool { run::page_is_live(page, &Self::this_page()) }
    fn now_ms() -> f64 {
        match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
            Ok(d)  => d.as_millis() as f64,
            Err(_) => 0.0,
        }
    }
    /// On the host's own clock, as the tab's `Date` answers: UTC only where no zone can be read.
    fn today() -> String {
        let now = Self::now_ms();
        let offset = match host_zone().offset_millis_at_time(now as i64) {
            Ok(ms) => ms as i64,
            Err(_) => 0,
        };
        local_date(now, offset)
    }
    fn console_log(msg: &str) { info!("{}", msg); }
    fn console_warn(msg: &str) { warn!("{}", msg); }
    /// To the process's stderr, which is the run's log on a runner: a trail line is a failure
    /// someone must be able to find (LOUD-FAIL; it was a no-op, so a refused turn record left
    /// no trace at all).
    fn trail(what: &str, detail: &str) { eprintln!("TRAIL {}: {}", what, detail); }
    fn heap_mb() -> u32 { 0 }
    /// No device presses are kept natively, so there is none to drop.
    fn forget_press(_owner: &str, _id: &str) -> Outcome<()> { Ok(()) }
    async fn machine_door_root(&self) -> Option<String> { None }

    async fn user_read_file(&self, root: FileRoot, path: &str) -> Outcome<Vec<u8>> {
        match route(root, path) {
            Route::Own(key) => self.read_file(&key).await,
            Route::User     => match door::current() {
                Some(d) => match res!(d.read_capped(path, u32::MAX).await) {
                    Some((body, _)) => Ok(body),
                    None            => not_there(path),
                },
                None    => unreadable(path),
            },
        }
    }
    async fn user_read_file_capped(&self, root: FileRoot, path: &str, max: u32)
        -> Outcome<(Vec<u8>, f64)>
    {
        match route(root, path) {
            Route::Own(key) => self.read_file_capped(&key, max).await,
            Route::User     => match door::current() {
                Some(d) => match res!(d.read_capped(path, max).await) {
                    Some((body, total)) => Ok((body, total as f64)),
                    None                => not_there(path),
                },
                None    => unreadable(path),
            },
        }
    }
    async fn user_write_file(&self, root: FileRoot, path: &str, bytes: &[u8]) -> Outcome<()> {
        match route(root, path) {
            Route::Own(key) => self.write_file(&key, bytes).await,
            Route::User     => unwritable("write", path),
        }
    }
    async fn user_write_file_if(&self, root: FileRoot, path: &str, bytes: &[u8],
        expect: Option<&Seen>) -> Outcome<Option<Seen>>
    {
        match route(root, path) {
            Route::Own(key) => self.write_file_if(&key, bytes, expect).await,
            Route::User     => unwritable("write", path),
        }
    }
    async fn user_delete_file_if(&self, root: FileRoot, path: &str, expect: &Seen)
        -> Outcome<Option<Seen>>
    {
        match route(root, path) {
            Route::Own(key) => self.delete_file_if(&key, expect).await,
            Route::User     => unwritable("delete", path),
        }
    }
    async fn user_exists(&self, root: FileRoot, path: &str) -> Outcome<bool> {
        match route(root, path) {
            Route::Own(key) => self.exists(&key).await,
            Route::User     => match door::current() {
                Some(d) => d.exists(path).await,
                None    => unreadable(path),
            },
        }
    }
    async fn user_list_dir(&self, root: FileRoot, path: &str) -> Outcome<Vec<(String, bool, u64)>> {
        match route(root, path) {
            Route::Own(key) => self.list_dir(&key).await,
            Route::User     => match door::current() {
                Some(d) => match res!(d.list(path).await) {
                    Some(entries) => Ok(entries),
                    None          => not_there(path),
                },
                None    => unreadable(path),
            },
        }
    }
}

/// Where a path the store names against a root lands natively.
#[derive(Debug, Eq, PartialEq)]
enum Route {
    /// The store's own area, under this key.
    Own(String),
    /// The person's own file, which the store reads only through a source it is handed and never
    /// writes (spec §16.2-§16.4).
    User,
}

/// The tab's own decision ([`crate::tools::storage_for`], as `opfs::resolve_root` takes it), with
/// the person's folder always open: on the runner the Workspace IS his folder.  So a store path
/// (`diamonds/<id>/`, `chats/<id>/`, mail; [`crate::tools::is_store_path`]) under the Workspace,
/// and anything under [`FileRoot::Opfs`], is the store's; every other Workspace path, and every
/// machine path, store-shaped or not (the folder's copy, as in the tab), is the person's.
fn route(root: FileRoot, path: &str) -> Route {
    match crate::tools::storage_for(root, path, Some(RUNNER_FOLDER), "") {
        // The path as given, so the backend's own check refuses an escape as OPFS does.
        Storage::Sandbox(_) => Route::Own(path.to_string()),
        Storage::Folder(_) | Storage::Machine(_) | Storage::Nowhere => Route::User,
    }
}

/// Is `path` under `root` the person's own file, which the store reads only through a source it is
/// handed ([`route`])?
pub fn is_user(root: FileRoot, path: &str) -> bool { route(root, path) == Route::User }

/// The number the runner's routing gives the person's folder, which is always open.
const RUNNER_FOLDER: u64 = 0;

/// A read of the person's file with no source to read it through: not known, never absent.
fn unreadable<V>(path: &str) -> Outcome<V> {
    Err(Unreadable {
        path:   path.to_string(),
        why:    "the store reads the person's files only through the run that holds them".to_string(),
    }.to_error())
}

/// The person's path, read through the door, where nothing is: absence, which is not
/// [`Unreadable`].
fn not_there<V>(path: &str) -> Outcome<V> {
    Err(err!("'{}' is not in the person's folder.", path; Missing, File))
}

/// A write, swap or delete of the person's file: the store never makes one.
fn unwritable<V>(what: &str, path: &str) -> Outcome<V> {
    Err(err!("The Diamond store does not {} the person's own files, so '{}' was refused.",
        what, path; Unauthorised, Write))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{call::is_unreadable, conformance, own};

    /// With nothing installed the store refuses, and no lock is managed.
    #[tokio::test]
    async fn closed_until_installed() {
        let _ = install(NativeBackend::Closed);
        assert!(own::read_file("diamonds/x/meta.json").await.is_err());
        assert!(own::write_file("diamonds/x/meta.json", b"{}").await.is_err());
        assert!(matches!(own::lock("v", LockHow::IfAvailable).await, Locked::NoManager));
        assert_eq!(own::lock_held("v").await, None);
    }

    /// Installed on this thread, the memory store is what `own::` reaches, and it conforms.
    #[tokio::test]
    async fn installed_mem_conforms() {
        let mem = MemBackend::default();
        let _ = install(NativeBackend::Mem(mem.clone()));
        assert!(own::write_file("diamonds/x/meta.json", b"{}").await.is_ok(), "an installed write");
        assert_eq!(mem.read_file("diamonds/x/meta.json").await.ok(), Some(b"{}".to_vec()));
        let bad: Vec<String> = conformance::run(&installed(), "__conformance/installed").await
            .into_iter()
            .filter_map(|c| c.failed.map(|w| fmt!("{}: {}", c.name, w)))
            .collect();
        let _ = install(NativeBackend::Closed);
        assert!(bad.is_empty(), "the installed backend fails:\n{}", bad.join("\n"));
    }

    /// A Diamond's own file, spelled against the person's Workspace, is the store's and goes to
    /// the backend, as the tab's `opfs::resolve_root` sends it to OPFS (spec §16.2).
    #[tokio::test]
    async fn store_path_on_the_workspace_goes_to_the_backend() {
        let mem = MemBackend::default();
        let _ = install(NativeBackend::Mem(mem.clone()));
        let path = "diamonds/d1/x.md";
        let wrote = own::user_write_file(FileRoot::Workspace, path, b"hi").await;
        let held = mem.read_file(path).await;
        let read = own::user_read_file(FileRoot::Workspace, path).await;
        let capped = own::user_read_file_capped(FileRoot::Workspace, path, 1024).await;
        let there = own::user_exists(FileRoot::Workspace, path).await;
        let listed = own::user_list_dir(FileRoot::Workspace, "diamonds/d1").await;
        let swapped = own::user_write_file_if(FileRoot::Workspace, path, b"ho",
            Some(&Seen::of(Some(b"hi")))).await;
        let gone = own::user_delete_file_if(FileRoot::Workspace, path, &Seen::of(Some(b"ho"))).await;
        let after = mem.exists(path).await;
        let _ = install(NativeBackend::Closed);
        assert!(wrote.is_ok(), "the store path written: {:?}", wrote.err());
        assert_eq!(held.ok(), Some(b"hi".to_vec()), "it landed in the backend");
        assert_eq!(read.ok(), Some(b"hi".to_vec()));
        assert_eq!(capped.ok().map(|(b, n)| (b, n as u64)), Some((b"hi".to_vec(), 2)));
        assert_eq!(there.ok(), Some(true));
        assert_eq!(listed.ok().map(|l| l.into_iter().map(|(n, _, _)| n).collect::<Vec<_>>()),
            Some(vec!["x.md".to_string()]));
        assert!(matches!(swapped, Ok(None)), "the swap bound to what stood: {:?}", swapped);
        assert!(matches!(gone, Ok(None)), "the delete bound to what stood: {:?}", gone);
        assert_eq!(after.ok(), Some(false));
    }

    /// The person's own file, with no source to read it through, is refused: a read as
    /// `Unreadable` (never absent), and a write, a swap and a delete outright, with nothing
    /// written anywhere.  A store path under the machine root is the folder's copy, never the
    /// store's, as the tab's `storage_for` says (spec §16.2).
    #[tokio::test]
    async fn user_path_with_no_source_is_refused() {
        let mem = MemBackend::default();
        let _ = install(NativeBackend::Mem(mem.clone()));
        let _ = mem.write_file("diamonds/d1/x.md", b"store").await;
        let mut wrong: Vec<String> = Vec::new();
        for (root, path) in [
            (FileRoot::Workspace, "src/a.md"),
            (FileRoot::Machine, "src/a.md"),
            (FileRoot::Machine, "diamonds/d1/x.md"),
        ] {
            let at = fmt!("{:?} '{}'", root, path);
            if !own::user_read_file(root, path).await.err().is_some_and(|e| is_unreadable(&e)) {
                wrong.push(fmt!("{}: read not Unreadable", at));
            }
            if !own::user_read_file_capped(root, path, 64).await.err()
                .is_some_and(|e| is_unreadable(&e))
            {
                wrong.push(fmt!("{}: capped read not Unreadable", at));
            }
            if !own::user_exists(root, path).await.err().is_some_and(|e| is_unreadable(&e)) {
                wrong.push(fmt!("{}: exists not Unreadable", at));
            }
            if !own::user_list_dir(root, path).await.err().is_some_and(|e| is_unreadable(&e)) {
                wrong.push(fmt!("{}: list not Unreadable", at));
            }
            if own::user_write_file(root, path, b"w").await.is_ok() {
                wrong.push(fmt!("{}: write let through", at));
            }
            if own::user_write_file_if(root, path, b"w", None).await.is_ok() {
                wrong.push(fmt!("{}: swap let through", at));
            }
            if own::user_delete_file_if(root, path, &Seen::Absent).await.is_ok() {
                wrong.push(fmt!("{}: delete let through", at));
            }
        }
        let user = mem.exists("src/a.md").await;
        let store = mem.read_file("diamonds/d1/x.md").await;
        let _ = install(NativeBackend::Closed);
        assert!(wrong.is_empty(), "{}", wrong.join("\n"));
        assert_eq!(user.ok(), Some(false), "nothing written for the person's path");
        assert_eq!(store.ok(), Some(b"store".to_vec()), "the store's own copy untouched");
    }

    /// A path that climbs above the root is refused, as the tab's `split_components` refuses it,
    /// and never quietly reaches the store's file it would name with the `..` dropped.
    #[tokio::test]
    async fn escaping_path_is_refused() {
        let mem = MemBackend::default();
        let _ = install(NativeBackend::Mem(mem.clone()));
        let _ = mem.write_file("diamonds/d1/x.md", b"store").await;
        let path = "../diamonds/d1/x.md";
        let mut wrong: Vec<String> = Vec::new();
        for root in [FileRoot::Workspace, FileRoot::Opfs] {
            let at = fmt!("{:?} '{}'", root, path);
            if own::user_read_file(root, path).await.is_ok() {
                wrong.push(fmt!("{}: read let through", at));
            }
            if own::user_read_file_capped(root, path, 64).await.is_ok() {
                wrong.push(fmt!("{}: capped read let through", at));
            }
            if own::user_exists(root, path).await.is_ok() {
                wrong.push(fmt!("{}: exists let through", at));
            }
            if own::user_list_dir(root, "../diamonds/d1").await.is_ok() {
                wrong.push(fmt!("{}: list let through", at));
            }
            if own::user_write_file(root, path, b"w").await.is_ok() {
                wrong.push(fmt!("{}: write let through", at));
            }
            if own::user_write_file_if(root, path, b"w", None).await.is_ok() {
                wrong.push(fmt!("{}: swap let through", at));
            }
            if own::user_delete_file_if(root, path, &Seen::of(Some(b"store"))).await.is_ok() {
                wrong.push(fmt!("{}: delete let through", at));
            }
        }
        let store = mem.read_file("diamonds/d1/x.md").await;
        let _ = install(NativeBackend::Closed);
        assert!(wrong.is_empty(), "{}", wrong.join("\n"));
        assert_eq!(store.ok(), Some(b"store".to_vec()), "the store's own copy untouched");
    }

    /// A file that cannot be read is recorded as unseen, which reads as `Seen::Unread`, never as
    /// gone; only a file that is not there is gone (spec §16.2).
    #[tokio::test]
    async fn unreadable_is_unseen_never_gone() {
        use crate::{diamond_versions::Body, store::diamond::versions_changes};
        let mem = MemBackend::default();
        let _ = install(NativeBackend::Mem(mem.clone()));
        let _ = mem.write_file("diamonds/d1/kept.md", b"k").await;
        let paths = vec![
            "notes/a.md".to_string(),               // the person's: Unreadable here
            "diamonds/d1/kept.md".to_string(),
            "diamonds/d1/lost.md".to_string(),
        ];
        let changes = versions_changes("d1", &paths).await;
        let _ = install(NativeBackend::Closed);
        let after: Vec<(String, Body)> = changes.into_iter().map(|c| (c.path, c.after)).collect();
        assert_eq!(after, vec![
            ("notes/a.md".to_string(), Body::Unseen),
            ("diamonds/d1/kept.md".to_string(), Body::Held(b"k".to_vec())),
            ("diamonds/d1/lost.md".to_string(), Body::Gone),
        ]);
    }

    #[test]
    fn civil_dates() {
        assert_eq!(civil(0), (1970, 1, 1));
        assert_eq!(civil(11_016), (2000, 2, 29));
        assert_eq!(civil(20_743), (2026, 10, 17));
    }

    /// A decision is dated on the person's clock, as the tab's `Date` dates it: near midnight
    /// the local day is not UTC's.
    #[test]
    fn today_is_local_near_midnight() {
        // 2026-10-16 22:30 UTC.
        let now = (20_742.0 * 24.0 + 22.5) * 3_600_000.0;
        assert_eq!(local_date(now, 0), "2026-10-16");
        assert_eq!(local_date(now, 8 * 3_600_000), "2026-10-17", "Perth is already tomorrow");
        assert_eq!(local_date(now, -5 * 3_600_000), "2026-10-16");
        // 2026-10-17 00:30 UTC, an hour behind: still yesterday.
        let early = (20_743.0 * 24.0 + 0.5) * 3_600_000.0;
        assert_eq!(local_date(early, -3_600_000), "2026-10-16");
    }
}
