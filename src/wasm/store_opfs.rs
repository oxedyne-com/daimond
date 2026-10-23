//! The Diamond store's backend in the tab: OPFS, Web Locks and the page (d1_plan §2, D1s0).
//!
//! Every primitive is one call to the `opfs::` function of its name with `FileRoot::Opfs`; the
//! locks are `navigator.locks`, moved here from `wasm::diamond` as they were.

use crate::{
    diamond_versions::Seen,
    protocol::generate_session_id,
    store::{LockHow, Locked, StoreBackend, StoreEnv},
    tools::FileRoot,
    wasm::{js_str, opfs},
};

use oxedyne_fe2o3_core::prelude::*;
use oxedyne_fe2o3_core::wasm::console_log;

use wasm_bindgen::{JsCast, JsValue};

thread_local! {
    /// This page's own name for the copies it notes mid-turn, so a note left by an earlier life of
    /// the page -- one that was reloaded, closed or killed before its turn ended -- can be told
    /// from one whose turn is still running.  See `diamond::pend`.
    static PAGE: String = generate_session_id();
}

/// The store's backend in the tab.
#[derive(Clone, Copy, Debug, Default)]
pub struct OpfsBackend;

/// A web lock this page holds, given back by [`StoreBackend::release`], when dropped -- a future
/// the page dropped included -- and with the page.
///
/// `release` resolves the promise the lock's callback returned, which only starts the release: the
/// lock manager lets the lock go one task later.  The promise `navigator.locks.request` returned
/// (`asked`) settles once it has, so an awaited release waits on that one, and a drop, which
/// cannot wait, leaves the lock free by the next task.
pub struct WebLock {
    release:    Option<js_sys::Function>,
    asked:      Option<JsValue>,
}

impl WebLock {
    /// Resolve the callback's promise, so the lock manager lets the lock go, and hand back the
    /// promise that settles once it has.
    fn let_go(&mut self) -> Option<JsValue> {
        if let Some(release) = self.release.take() {
            let _ = release.call0(&JsValue::NULL);
        }
        self.asked.take()
    }
}

impl Drop for WebLock {
    fn drop(&mut self) {
        let _ = self.let_go();
    }
}

impl OpfsBackend {
    /// The held, bound write of `key` in the store's own area (HL6): the file's lock held, both
    /// compares, then `pre`, then the `close` ([`opfs::write_file_then`]).  The fold's door.
    pub async fn write_file_then<P, F>(&self, key: &str, bytes: &[u8], expect: Option<&Seen>,
        pre: P)
        -> Outcome<Option<Seen>>
    where
        P: FnOnce() -> F,
        F: std::future::Future<Output = Outcome<()>>,
    {
        opfs::write_file_then(FileRoot::Opfs, key, bytes, expect, pre).await
    }
}

impl StoreBackend for OpfsBackend {
    type Lock = WebLock;

    async fn read_file(&self, key: &str) -> Outcome<Vec<u8>> {
        opfs::read_file(FileRoot::Opfs, key).await
    }
    async fn read_file_capped(&self, key: &str, max: u32) -> Outcome<(Vec<u8>, f64)> {
        opfs::read_file_capped(FileRoot::Opfs, key, max).await
    }
    async fn write_file(&self, key: &str, bytes: &[u8]) -> Outcome<()> {
        opfs::write_file(FileRoot::Opfs, key, bytes).await
    }
    async fn write_file_if(&self, key: &str, bytes: &[u8], expect: Option<&Seen>)
        -> Outcome<Option<Seen>>
    {
        opfs::write_file_if(FileRoot::Opfs, key, bytes, expect).await
    }
    async fn exists(&self, key: &str) -> Outcome<bool> {
        opfs::exists(FileRoot::Opfs, key).await
    }
    async fn list_dir(&self, dir: &str) -> Outcome<Vec<(String, bool, u64)>> {
        opfs::list_dir(FileRoot::Opfs, dir).await
    }
    async fn list_dir_stamped(&self, dir: &str) -> Outcome<Vec<(String, bool, u64, Option<f64>)>> {
        opfs::list_dir_stamped(FileRoot::Opfs, dir).await
    }
    async fn stamp(&self, key: &str) -> Outcome<Option<(f64, f64)>> {
        opfs::stamp(FileRoot::Opfs, key).await
    }
    async fn delete_file(&self, key: &str) -> Outcome<()> {
        opfs::delete_file(FileRoot::Opfs, key).await
    }
    async fn delete_file_if(&self, key: &str, expect: &Seen) -> Outcome<Option<Seen>> {
        opfs::delete_file_if(FileRoot::Opfs, key, expect).await
    }
    async fn delete_entry(&self, key: &str, recursive: bool) -> Outcome<()> {
        opfs::delete_entry(FileRoot::Opfs, key, recursive).await
    }
    async fn move_entry(&self, from: &str, to: &str) -> Outcome<()> {
        opfs::move_entry(FileRoot::Opfs, from, to).await
    }
    async fn lock(&self, name: &str, how: LockHow) -> Locked<WebLock> {
        web_lock_in(name, how).await
    }
    async fn lock_held(&self, name: &str) -> Option<bool> {
        web_lock_held(name).await
    }
    async fn release(&self, mut lock: WebLock) {
        // The request's own promise settles -- fulfilled with what the callback's promise was
        // resolved with -- only after the lock manager has let the lock go, in every tab.
        if let Some(asked) = lock.let_go() {
            let _ = crate::wasm::settle_js(asked).await;
        }
    }
}

impl StoreEnv for OpfsBackend {
    fn folder_id() -> Option<String> { opfs::folder_id() }
    fn folder_known(id: &str) -> bool { opfs::folder_known(id) }
    fn folder_open() -> bool { opfs::folder_open() }
    fn this_page() -> String { PAGE.with(|p| p.clone()) }
    fn page_is_live(page: &str) -> bool { PAGE.with(|p| p == page) }
    fn now_ms() -> f64 { oxedyne_fe2o3_core::wasm::now_ms() }
    fn today() -> String {
        let d = js_sys::Date::new_0();
        fmt!("{:04}-{:02}-{:02}",
            d.get_full_year(), d.get_month() + 1, d.get_date())
    }
    fn console_log(msg: &str) { console_log(msg) }
    fn console_warn(msg: &str) { web_sys::console::warn_1(&JsValue::from_str(msg)) }
    fn trail(what: &str, detail: &str) { crate::wasm::entry::trail(what, detail) }
    fn heap_mb() -> u32 { crate::wasm::entry::heap_mb() }
    fn forget_press(owner: &str, id: &str) -> Outcome<()> {
        crate::wasm::marks::forget_press(owner, id)
    }
    async fn machine_door_root(&self) -> Option<String> {
        crate::tools::machine_door_root(&crate::wasm::host::WasmHost::default()).await
    }

    async fn user_read_file(&self, root: FileRoot, path: &str) -> Outcome<Vec<u8>> {
        opfs::read_file(root, path).await
    }
    async fn user_read_file_capped(&self, root: FileRoot, path: &str, max: u32)
        -> Outcome<(Vec<u8>, f64)>
    {
        opfs::read_file_capped(root, path, max).await
    }
    async fn user_write_file(&self, root: FileRoot, path: &str, bytes: &[u8]) -> Outcome<()> {
        opfs::write_file(root, path, bytes).await
    }
    async fn user_write_file_if(&self, root: FileRoot, path: &str, bytes: &[u8],
        expect: Option<&Seen>) -> Outcome<Option<Seen>>
    {
        opfs::write_file_if(root, path, bytes, expect).await
    }
    async fn user_delete_file_if(&self, root: FileRoot, path: &str, expect: &Seen)
        -> Outcome<Option<Seen>>
    {
        opfs::delete_file_if(root, path, expect).await
    }
    async fn user_exists(&self, root: FileRoot, path: &str) -> Outcome<bool> {
        opfs::exists(root, path).await
    }
    async fn user_list_dir(&self, root: FileRoot, path: &str) -> Outcome<Vec<(String, bool, u64)>> {
        opfs::list_dir(root, path).await
    }
}

/// One file, held by one writer from before it opens the file until after it closes it, across
/// every tab of this origin (OPFS-LOCK, 2026-10-17): [`crate::fsname::file_lock_name`].  Every
/// write of the page (`www/js/filelock.js`) and of [`opfs`] ([`opfs::write_file_if`], so
/// [`OpfsBackend::write_file_if`] and every store write, and [`opfs::delete_file_if`]) takes it.
/// Given back when dropped.
///
/// **LOCK ORDER: three ranks, V → T → S** ([`hold_file`]).  A restore holding
/// `daimond-version-<id>` (taken first) and then this one cannot meet a holder of this one waiting
/// for the version lock.  Where the browser has no lock manager, nothing is held, as before: a
/// write there is the plain last-writer-wins it always was.
pub struct FileHold {
    _lock: Option<WebLock>,     // the web lock, let go by its own drop; `None` where there is none
}

/// How long a write waits for its file before it is refused, in ms:
/// [`crate::store::diamond::VERSION_WAIT_MS`]'s reasoning.  A page writer holds a file for one
/// write, or for one streamed download.
pub const FILE_WAIT_MS: u64 = 60_000;

/// Wait for the write lock of `path` (stored in the opened folder where `folder`), and hold it.
/// Not re-entrant: nothing holding it asks again.
///
/// **Three ranks, always taken outer to inner** (held-lock settle P4, I-HL3): V, a Diamond's
/// version hold (`daimond-version-<id>`), then T, a target file outside `.daimond/`, then S, a
/// `.daimond/` side file (an archive, the touched record).  A V-holder may wait for T and S.  A
/// T-holder waits for S only, and only through the one `write_licensed_then` pre step, the
/// landing's ARCHIVE settle (`tools::landed_store_write`), or the fold's same ARCHIVE pre step
/// (`own::write_file_then`, HL6); it never takes a second T (RECORD
/// writes DECISIONS.md after the target's lock is given back) and never a V.  An S-holder waits
/// for nothing: each side write is one compare-and-write that reads again on a refusal.  T→S
/// edges only, with S a sink, leave no cycle.
pub(in crate::wasm) async fn hold_file(folder: bool, path: &str) -> Outcome<FileHold> {
    match web_lock_in(&crate::fsname::file_lock_name(folder, path), LockHow::Timeout(FILE_WAIT_MS)).await {
        Locked::Held(lock) => Ok(FileHold { _lock: Some(lock) }),
        Locked::NoManager  => Ok(FileHold { _lock: None }),
        Locked::TimedOut | Locked::Busy => Err(err!(
            "'{}' has been held by another write for over {} seconds, so nothing was written. Try \
             again in a moment.", path, FILE_WAIT_MS / 1000; Lock, Timeout)),
        Locked::Refused(why) => Err(err!(
            "The browser would not lock '{}' for writing ({}), so nothing was written.", path, why;
            Lock)),
    }
}

/// Run the store backend conformance suite on OPFS below `root`, which must lie under
/// `__conformance/`, and answer each case as JSON (`dev/verify_storebackend.mjs`).  Debug builds
/// and the `store_conformance` feature only.
#[cfg(any(debug_assertions, feature = "store_conformance"))]
#[wasm_bindgen::prelude::wasm_bindgen]
pub async fn __store_conformance(root: String) -> Result<String, JsValue> {
    if !root.starts_with("__conformance/") || root.contains("..") {
        return Err(JsValue::from_str("the conformance suite runs only below '__conformance/'"));
    }
    let cases = crate::store::conformance::run(&OpfsBackend, &root).await;
    let _ = opfs::delete_entry(FileRoot::Opfs, &root, true).await;
    // The folder above, which the first write made; not recursive, so a parallel run's survives.
    let _ = opfs::delete_entry(FileRoot::Opfs, "__conformance", false).await;
    Ok(crate::store::conformance::to_json(&cases))
}

/// An `AbortSignal` that fires after `ms`, or `None` where the browser cannot make one.
fn timeout_signal(ms: u64) -> Option<JsValue> {
    let global = js_sys::global();
    let ctor = match js_sys::Reflect::get(&global, &JsValue::from_str("AbortSignal")) {
        Ok(c)  => c,
        Err(_) => return None,
    };
    let make = match js_sys::Reflect::get(&ctor, &JsValue::from_str("timeout")) {
        Ok(m)  => m,
        Err(_) => return None,
    };
    let make = match make.dyn_into::<js_sys::Function>() {
        Ok(f)  => f,
        Err(_) => return None,
    };
    make.call1(&ctor, &JsValue::from_f64(ms as f64)).ok()
}


/// Take the named web lock: waiting at most `ms` with [`LockHow::Timeout`], not at all with
/// [`LockHow::IfAvailable`] (which the lock manager refuses beside a signal), or for as long as it
/// takes with [`LockHow::Wait`].
///
/// `navigator.locks.request` holds a lock for as long as the promise its callback returns is
/// pending, so the callback returns one whose resolver is handed out as the release.  The wait is
/// bounded by an `AbortSignal`: a request still queued when it fires is withdrawn by the lock
/// manager, so nothing is held for a waiter that has gone.
async fn web_lock_in(name: &str, how: LockHow) -> Locked<WebLock> {
    use wasm_bindgen::closure::Closure;
    let got = |obj: &JsValue, key: &str| match js_sys::Reflect::get(obj, &JsValue::from_str(key)) {
        Ok(v) if !v.is_undefined() && !v.is_null() => Some(v),
        _                                          => None,
    };
    let locks = match got(&js_sys::global(), "navigator").and_then(|n| got(&n, "locks")) {
        Some(l) => l,
        None    => return Locked::NoManager,
    };
    let request = match got(&locks, "request").map(|f| f.dyn_into::<js_sys::Function>()) {
        Some(Ok(f)) => f,
        _           => return Locked::NoManager,
    };
    let opts = js_sys::Object::new();
    let _ = js_sys::Reflect::set(&opts, &JsValue::from_str("mode"), &JsValue::from_str("exclusive"));
    // A browser with a lock manager and no `AbortSignal.timeout` is past every engine this build
    // runs on; were there one, it would wait as it did before, and say so.
    let wait_ms = match how {
        LockHow::Wait          => 0,
        LockHow::IfAvailable   => {
            let _ = js_sys::Reflect::set(&opts, &JsValue::from_str("ifAvailable"), &JsValue::TRUE);
            0
        },
        LockHow::Timeout(wait_ms) => {
            match timeout_signal(wait_ms) {
                Some(sig) => { let _ = js_sys::Reflect::set(&opts, &JsValue::from_str("signal"), &sig); },
                None      => console_log(&fmt!("the lock '{}' is asked for with no time limit: \
                    this browser cannot make a timed signal.", name)),
            }
            wait_ms
        },
    };
    let name = JsValue::from_str(name);
    // The request's own promise, kept so an awaited release can wait until the lock is let go.
    let mut kept: Option<JsValue> = None;
    let granted = js_sys::Promise::new(&mut |handed: js_sys::Function, reject: js_sys::Function| {
        let hand = Closure::once_into_js(move |lock: JsValue| -> JsValue {
            // `ifAvailable` and held elsewhere: nothing is granted, and nothing is held.
            if lock.is_null() {
                let _ = handed.call1(&JsValue::NULL, &JsValue::NULL);
                return JsValue::UNDEFINED;
            }
            let held = js_sys::Promise::new(&mut |release: js_sys::Function, _: js_sys::Function| {
                let _ = handed.call1(&JsValue::NULL, &release);
            });
            held.into()
        });
        match request.call3(&locks, &name, &opts, &hand) {
            // A request refused before the lock is granted says so here, and the caller falls
            // back to this page's own gate rather than waiting on a lock that will never come.
            Ok(asked) => {
                let failed = reject.clone();
                let on_err = Closure::once_into_js(move |e: JsValue| {
                    let _ = failed.call1(&JsValue::NULL, &e);
                });
                if let Ok(catch) = js_sys::Reflect::get(&asked, &JsValue::from_str("catch"))
                    .and_then(|f| f.dyn_into::<js_sys::Function>().map_err(JsValue::from))
                {
                    let _ = catch.call1(&asked, &on_err);
                }
                kept = Some(asked);
            },
            Err(e) => { let _ = reject.call1(&JsValue::NULL, &e); },
        }
    });
    match crate::wasm::settle_js(granted).await {
        Ok(release) if release.is_null() => Locked::Busy,
        Ok(release) => match release.dyn_into::<js_sys::Function>() {
            Ok(f)  => Locked::Held(WebLock { release: Some(f), asked: kept }),
            Err(_) => Locked::Refused("the lock manager handed back no release".to_string()),
        },
        Err(e)      => {
            // The signal's own reason is a `TimeoutError`; an abort by any other road is the
            // same wait run out.
            let kind = got(&e, "name").and_then(|n| n.as_string()).unwrap_or_default();
            if kind == "TimeoutError" || kind == "AbortError" {
                console_log(&fmt!("the lock '{}' was still held elsewhere after {} ms; the \
                    act waiting for it is refused.", name.as_string().unwrap_or_default(), wait_ms));
                Locked::TimedOut
            } else {
                Locked::Refused(js_str(&e))
            }
        },
    }
}

/// Is the web lock `name` held by any tab of this origin?  `None` where the browser cannot say.
async fn web_lock_held(name: &str) -> Option<bool> {
    let got = |obj: &JsValue, key: &str| match js_sys::Reflect::get(obj, &JsValue::from_str(key)) {
        Ok(v) if !v.is_undefined() && !v.is_null() => Some(v),
        _                                          => None,
    };
    let locks = match got(&js_sys::global(), "navigator").and_then(|n| got(&n, "locks")) {
        Some(l) => l,
        None    => return None,
    };
    let query = match got(&locks, "query").map(|f| f.dyn_into::<js_sys::Function>()) {
        Some(Ok(f)) => f,
        _           => return None,
    };
    let asked = match query.call0(&locks).map(|p| p.dyn_into::<js_sys::Promise>()) {
        Ok(Ok(p)) => p,
        _         => return None,
    };
    let snapshot = match crate::wasm::settle_js(asked).await {
        Ok(s)  => s,
        Err(_) => return None,
    };
    let held = match got(&snapshot, "held") {
        Some(h) => js_sys::Array::from(&h),
        None    => return Some(false),
    };
    Some(held.iter().any(|l| got(&l, "name").and_then(|n| n.as_string()).as_deref() == Some(name)))
}
