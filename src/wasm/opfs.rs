//! OPFS filesystem edge — the browser's persistent storage for Daimond.
//!
//! The Origin Private File System (OPFS) is reached on the main thread
//! via `navigator.storage.getDirectory()`, which yields the origin's
//! private root directory.  All access is asynchronous, so this edge is
//! built on `wasm-bindgen-futures`.
//!
//! Paths are workspace-relative and jailed with the same lexical
//! discipline as [`crate::workspace::Workspace::resolve`]: absolute
//! paths and `..` traversal that escapes the root are rejected, so a
//! path can only ever address a descendant of the root handle.
//!
//! ## Two roots, one interface (FSA real-folder mode)
//!
//! Every operation resolves against a [`FileSystemDirectoryHandle`].  Two
//! handles are possible and share the same interface:
//!
//! - the **OPFS root** from `navigator.storage.getDirectory()` (the
//!   zero-setup sandbox), and
//! - an **FSA folder** from `showDirectoryPicker()` — a real local
//!   directory the user grants read/write to.
//!
//! FSA mode is therefore not a new filesystem but a *swapped root handle*.
//! A thread-local override (wasm is single-threaded, so no `Send` bound is
//! needed) holds the FSA handle when one is open.  Which root a given call
//! uses is selected by [`crate::tools::FileRoot`]:
//! [`FileRoot::Workspace`](crate::tools::FileRoot::Workspace) honours the
//! override (the file tools / Workspace edit the real folder), while
//! [`FileRoot::Opfs`](crate::tools::FileRoot::Opfs) always pins the OPFS
//! root so Daimond's own Diamond/crystal/`.daimond` state can never pollute the user's
//! real repo.
//!
//! The synchronous `createSyncAccessHandle` path (single-writer Worker,
//! for the append-only `.daimond` log) is deferred; this async edge covers
//! whole-file read and write, which is what the first vertical needs.
// TODO(wasm-opfs-sync): add a Worker-hosted `createSyncAccessHandle`
// backend for the append-only session log, where synchronous positioned
// writes matter.

use crate::tools::FileRoot;
use crate::wasm::js_str;

use oxedyne_fe2o3_core::prelude::*;

use std::cell::RefCell;
use std::path::{Component, Path};

use wasm_bindgen::JsCast;
use wasm_bindgen::JsValue;
use wasm_bindgen_futures::JsFuture;
use web_sys::{
    File,
    FileSystemDirectoryHandle,
    FileSystemFileHandle,
    FileSystemGetDirectoryOptions,
    FileSystemGetFileOptions,
    FileSystemRemoveOptions,
    FileSystemWritableFileStream,
};


thread_local! {
    /// The active FSA real-folder handle, or `None` for OPFS-only mode.
    ///
    /// Set by [`set_override`] when the user opens a folder and reused
    /// across the session; only [`FileRoot::Workspace`] resolution
    /// consults it, so Daimond's own state ([`FileRoot::Opfs`]) is never
    /// affected.  A thread-local suffices because wasm runs single-
    /// threaded, which also keeps the handle off any `Send` bound.
    static WORKSPACE_OVERRIDE: RefCell<Option<FileSystemDirectoryHandle>> =
        const { RefCell::new(None) };

    /// The current account's OPFS subdirectory, or empty for the primary account.
    ///
    /// Several people may share one browser, one at a time; each account's workspace and Daimond's
    /// own `.daimond` state must be invisible to the others.  When this is non-empty, EVERY OPFS
    /// operation -- both [`FileRoot::Workspace`] and [`FileRoot::Opfs`] -- resolves inside a
    /// per-account subdirectory of the origin root, so no account can see another's files.  The
    /// primary account leaves this empty and uses the root exactly as a single-account install
    /// always did, so nothing has to move when accounts are introduced.
    static ACCOUNT_NS: RefCell<String> = const { RefCell::new(String::new()) };
}

/// Point every OPFS operation at the given account's subdirectory (empty for the primary account,
/// i.e. the origin root).  Set once at boot and again on an account switch.
pub fn set_account_ns(ns: String) {
    ACCOUNT_NS.with(|c| *c.borrow_mut() = ns);
}

/// Install `handle` as the FSA real-folder root for the file tools /
/// Workspace.  Subsequent [`FileRoot::Workspace`] operations resolve
/// against it until [`clear_override`] is called.
pub fn set_override(handle: FileSystemDirectoryHandle) {
    WORKSPACE_OVERRIDE.with(|c| *c.borrow_mut() = Some(handle));
}

/// Clear any FSA override, returning the file tools / Workspace to the
/// OPFS sandbox root.
pub fn clear_override() {
    WORKSPACE_OVERRIDE.with(|c| *c.borrow_mut() = None);
}

/// The current file-tool root mode: `"folder"` when an FSA real folder is
/// open, else `"opfs"`.
pub fn workspace_mode() -> String {
    WORKSPACE_OVERRIDE
        .with(|c| if c.borrow().is_some() { "folder" } else { "opfs" })
        .to_string()
}

/// The event dispatched on `window` when the browser takes the real folder away.
pub const FOLDER_LOST_EVENT: &str = "daimond:folder-lost";

/// Tell the page that the open folder is no longer reachable, so it can drop to the sandbox and
/// offer to reconnect.
///
/// A grant can be withdrawn at any time -- the browser revokes it, the user resets the
/// permission, the folder goes away -- and the file tools then fail with `NotAllowedError` while
/// the app carries on believing the folder is open.  That is the worst of both: the agent's
/// writes fail, and the panel still names a folder the agent cannot reach.  The rule the design
/// sets is that this must never be silent, so the edge says so out loud and the page decides what
/// to do about it (see `handlePermissionLoss` in `daimond.js`); the override is cleared there, in
/// one place, rather than half here and half there.
pub fn notify_folder_lost() {
    if let Some(win) = web_sys::window() {
        if let Ok(ev) = web_sys::CustomEvent::new(FOLDER_LOST_EVENT) {
            let _ = win.dispatch_event(&ev);
        }
    }
}

/// Whether a failed tool call failed *because the real folder was taken away*.
///
/// The browser reports a withdrawn grant as a `NotAllowedError`, which reaches here inside the
/// error text the tool returns.  A folder that is merely missing a file, or a path outside the
/// jail, is an ordinary error and must not be mistaken for a lost grant -- dropping the user's
/// folder on any failure at all would be its own bug.
///
/// # Arguments
/// * `result` - The text a tool call produced, whether it succeeded or failed.
pub fn is_folder_lost(result: &str) -> bool {
    workspace_mode() == "folder" && result.contains("NotAllowed")
}


/// Split a workspace-relative path into jailed components, tolerating an
/// empty result (which addresses the root directory itself).
///
/// Mirrors [`crate::workspace::Workspace::resolve`]: leading slashes are
/// stripped (treated as relative), `.` is skipped, and any absolute
/// component or `..` that would escape the root is rejected.  Returns the
/// ordered directory/file names; an empty vector means the root directory.
fn split_components(rel: &str) -> Outcome<Vec<String>> {
    let rel = rel.trim_start_matches('/');
    let mut out: Vec<String> = Vec::new();
    for comp in Path::new(rel).components() {
        match comp {
            Component::Normal(c) => out.push(c.to_string_lossy().to_string()),
            Component::CurDir    => {},
            Component::ParentDir => {
                // Never pop above the root.
                if out.pop().is_none() {
                    return Err(err!(
                        "OPFS: path '{}' escapes the workspace root.", rel;
                        Invalid, Input, Path));
                }
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err(err!(
                    "OPFS: absolute path '{}' is not allowed.", rel;
                    Invalid, Input, Path));
            }
        }
    }
    Ok(out)
}

/// Split a workspace-relative path into jailed components, requiring at
/// least one component (a leaf file or directory name).
///
/// A wrapper over [`split_components`] for the file-addressing tools,
/// which always name a leaf; the empty (root) case is rejected here.
fn jail_components(rel: &str) -> Outcome<Vec<String>> {
    let out = res!(split_components(rel));
    if out.is_empty() {
        return Err(err!(
            "OPFS: path '{}' has no file component.", rel;
            Invalid, Input, Path));
    }
    Ok(out)
}

/// Acquire the OPFS root directory handle for this origin.
///
/// Runs on the main thread via `window.navigator.storage`; a secure
/// context (https or localhost) is required, which the browser enforces.
async fn opfs_root() -> Outcome<FileSystemDirectoryHandle> {
    let win = res!(web_sys::window()
        .ok_or_else(|| err!("OPFS: no window (main-thread OPFS requires a document)."; System, Missing)));
    let storage = win.navigator().storage();
    // Feature-detect OPFS before calling it. A Safari without it -- older iOS, or
    // any iOS in Private Browsing, where the API is withdrawn -- has no
    // `getDirectory`, and the binding then throws SYNCHRONOUSLY (not a rejectable
    // promise the `map_err` below could catch), surfacing as an uncaught page
    // error at boot. Checking first turns that into a clean, handled Outcome.
    let has_opfs = js_sys::Reflect::get(storage.as_ref(), &JsValue::from_str("getDirectory"))
        .map(|f| f.is_function())
        .unwrap_or(false);
    if !has_opfs {
        return Err(err!("OPFS: this browser exposes no getDirectory (an older Safari, or \
            Private Browsing); persistent workspace storage is unavailable here."; IO, Missing));
    }
    let dir_val = res!(JsFuture::from(storage.get_directory()).await
        .map_err(|e| err!("OPFS: getDirectory failed: {}.", js_str(&e); IO, File)));
    let dir: FileSystemDirectoryHandle = res!(dir_val.dyn_into()
        .map_err(|_| err!("OPFS: getDirectory did not return a directory handle."; IO, File)));

    // A non-primary account resolves inside its own subdirectory of the root, so its files -- and
    // Daimond's own `.daimond` state -- are invisible to every other account at this browser. The
    // primary account leaves the namespace empty and uses the root unchanged.
    let ns = ACCOUNT_NS.with(|c| c.borrow().clone());
    if ns.is_empty() {
        return Ok(dir);
    }
    let opts = FileSystemGetDirectoryOptions::new();
    opts.set_create(true);
    let sub_val = res!(JsFuture::from(dir.get_directory_handle_with_options(&ns, &opts)).await
        .map_err(|e| err!("OPFS: opening account subdirectory '{}' failed: {}.", ns, js_str(&e); IO, File)));
    let sub: FileSystemDirectoryHandle = res!(sub_val.dyn_into()
        .map_err(|_| err!("OPFS: account subdirectory was not a directory handle."; IO, File)));
    Ok(sub)
}

/// Resolve the root handle a call operates against.
///
/// [`FileRoot::Workspace`] returns the FSA override when one is open, else
/// the OPFS root; [`FileRoot::Opfs`] always returns the OPFS root.
async fn resolve_root(root: FileRoot) -> Outcome<FileSystemDirectoryHandle> {
    match root {
        FileRoot::Workspace => {
            if let Some(h) = WORKSPACE_OVERRIDE.with(|c| c.borrow().clone()) {
                return Ok(h);
            }
            opfs_root().await
        }
        FileRoot::Opfs => opfs_root().await,
    }
}

/// Descend into (creating as needed) the directory components of a
/// jailed path, returning the handle to the directory that will hold the
/// leaf file plus the leaf name.
async fn descend(
    root:       &FileSystemDirectoryHandle,
    components: Vec<String>,
)
    -> Outcome<(FileSystemDirectoryHandle, String)>
{
    let mut dir = root.clone();
    let last = components.len() - 1;
    let mut leaf = String::new();
    for (i, name) in components.into_iter().enumerate() {
        if i == last {
            leaf = name;
            break;
        }
        let opts = FileSystemGetDirectoryOptions::new();
        opts.set_create(true);
        let next_val = res!(JsFuture::from(
                dir.get_directory_handle_with_options(&name, &opts)).await
            .map_err(|e| err!("OPFS: open/create dir '{}' failed: {}.", name, js_str(&e); IO, File)));
        dir = res!(next_val.dyn_into()
            .map_err(|_| err!("OPFS: dir handle for '{}' was not a directory.", name; IO, File)));
    }
    Ok((dir, leaf))
}

/// Descend into an *existing* directory path (no creation) beneath `root`,
/// returning the handle.  An empty path (`""`, `"."`, `"/"`) resolves to
/// `root` itself.  Errors if any component does not exist or is not a
/// directory.
async fn descend_dir(
    root: &FileSystemDirectoryHandle,
    path: &str,
)
    -> Outcome<FileSystemDirectoryHandle>
{
    let components = res!(split_components(path));
    let mut dir = root.clone();
    for name in components {
        let next_val = res!(JsFuture::from(dir.get_directory_handle(&name)).await
            .map_err(|e| err!("OPFS: open dir '{}' failed: {}.", name, js_str(&e); IO, File, Read)));
        dir = res!(next_val.dyn_into()
            .map_err(|_| err!("OPFS: dir handle for '{}' was not a directory.", name; IO, File, Read)));
    }
    Ok(dir)
}

/// Descend into the *existing* parent directory of a jailed path (no
/// creation) beneath `root`, returning the parent handle plus the leaf
/// name.
async fn open_parent(
    root:       &FileSystemDirectoryHandle,
    components: Vec<String>,
)
    -> Outcome<(FileSystemDirectoryHandle, String)>
{
    let mut dir = root.clone();
    let last = components.len() - 1;
    let mut leaf = String::new();
    for (i, name) in components.into_iter().enumerate() {
        if i == last {
            leaf = name;
            break;
        }
        let next_val = res!(JsFuture::from(dir.get_directory_handle(&name)).await
            .map_err(|e| err!("OPFS: open dir '{}' failed: {}.", name, js_str(&e); IO, File)));
        dir = res!(next_val.dyn_into()
            .map_err(|_| err!("OPFS: dir handle for '{}' was not a directory.", name; IO, File)));
    }
    Ok((dir, leaf))
}

/// Write `content` to `path` under `root`, creating parent directories
/// and the file as needed, replacing any existing contents.
pub async fn write_file(root: FileRoot, path: &str, content: &[u8]) -> Outcome<()> {
    let handle = res!(resolve_root(root).await);
    let components = res!(jail_components(path));
    let (dir, leaf) = res!(descend(&handle, components).await);

    let opts = FileSystemGetFileOptions::new();
    opts.set_create(true);
    let file_val = res!(JsFuture::from(
            dir.get_file_handle_with_options(&leaf, &opts)).await
        .map_err(|e| err!("OPFS: open/create file '{}' failed: {}.", leaf, js_str(&e); IO, File)));
    let file: FileSystemFileHandle = res!(file_val.dyn_into()
        .map_err(|_| err!("OPFS: file handle for '{}' was not a file.", leaf; IO, File)));

    let writable_val = res!(JsFuture::from(file.create_writable()).await
        .map_err(|e| err!("OPFS: create writable for '{}' failed: {}.", leaf, js_str(&e); IO, File, Write)));
    let writable: FileSystemWritableFileStream = res!(writable_val.dyn_into()
        .map_err(|_| err!("OPFS: writable for '{}' had the wrong type.", leaf; IO, File, Write)));

    let write_promise = res!(writable.write_with_u8_array(content)
        .map_err(|e| err!("OPFS: queue write for '{}' failed: {}.", leaf, js_str(&e); IO, File, Write)));
    res!(JsFuture::from(write_promise).await
        .map_err(|e| err!("OPFS: write '{}' failed: {}.", leaf, js_str(&e); IO, File, Write)));

    // `close` is inherited from `WritableStream` and flushes the file.
    res!(JsFuture::from(writable.close()).await
        .map_err(|e| err!("OPFS: close '{}' failed: {}.", leaf, js_str(&e); IO, File, Write)));
    Ok(())
}

/// Create the directory `path` under `root`, and any parents it needs.
///
/// Only an agent could make a directory before this, and only as a side effect
/// of writing a file into one; the user had no way at all.
pub async fn create_dir(root: FileRoot, path: &str) -> Outcome<()> {
    let handle = res!(resolve_root(root).await);
    let components = res!(jail_components(path));
    let mut dir = handle;
    for name in components {
        let opts = FileSystemGetDirectoryOptions::new();
        opts.set_create(true);
        let next = res!(JsFuture::from(dir.get_directory_handle_with_options(&name, &opts)).await
            .map_err(|e| err!("OPFS: create dir '{}' failed: {}.", name, js_str(&e); IO, File)));
        dir = res!(next.dyn_into()
            .map_err(|_| err!("OPFS: handle for '{}' was not a directory.", name; IO, File)));
    }
    Ok(())
}

/// Move (or rename) `from` to `to` under `root`.
///
/// OPFS has no rename, so this copies and then deletes.  Directories are copied
/// recursively.  The destination must not already exist, so a move can never
/// silently clobber the user's work.
pub async fn move_entry(root: FileRoot, from: &str, to: &str) -> Outcome<()> {
    if res!(exists(root, to).await) {
        return Err(err!("'{}' already exists.", to; Invalid, Input));
    }
    let is_dir = res!(is_directory(root, from).await);
    if is_dir {
        res!(copy_dir(root, from, to).await);
    } else {
        let bytes = res!(read_file(root, from).await);
        res!(write_file(root, to, &bytes).await);
    }
    res!(delete_entry(root, from, is_dir).await);
    Ok(())
}

/// Copy a directory and everything under it.  Recursion is spelled out with an
/// explicit stack: an `async fn` cannot recurse without boxing its future.
async fn copy_dir(root: FileRoot, from: &str, to: &str) -> Outcome<()> {
    res!(create_dir(root, to).await);
    let mut todo = vec![(from.to_string(), to.to_string())];
    while let Some((src, dst)) = todo.pop() {
        for (name, is_dir, _) in res!(list_dir(root, &src).await) {
            let s = fmt!("{}/{}", src, name);
            let d = fmt!("{}/{}", dst, name);
            if is_dir {
                res!(create_dir(root, &d).await);
                todo.push((s, d));
            } else {
                let bytes = res!(read_file(root, &s).await);
                res!(write_file(root, &d, &bytes).await);
            }
        }
    }
    Ok(())
}

/// True when `path` names a directory.
async fn is_directory(root: FileRoot, path: &str) -> Outcome<bool> {
    let handle = res!(resolve_root(root).await);
    let components = res!(jail_components(path));
    let (dir, leaf) = res!(open_parent(&handle, components).await);
    Ok(JsFuture::from(dir.get_directory_handle(&leaf)).await.is_ok())
}

/// Read the entire contents of `path` under `root` as bytes.  Errors if
/// any path component (directory or the file itself) does not exist.
pub async fn read_file(root: FileRoot, path: &str) -> Outcome<Vec<u8>> {
    let handle = res!(resolve_root(root).await);
    let components = res!(jail_components(path));
    let (dir, leaf) = res!(open_parent(&handle, components).await);

    let file_val = res!(JsFuture::from(dir.get_file_handle(&leaf)).await
        .map_err(|e| err!("OPFS: open file '{}' failed: {}.", leaf, js_str(&e); IO, File, Read)));
    let file_handle: FileSystemFileHandle = res!(file_val.dyn_into()
        .map_err(|_| err!("OPFS: file handle for '{}' was not a file.", leaf; IO, File, Read)));

    // `get_file` yields a `File` (a `Blob`); read its bytes via
    // `arrayBuffer`, which returns the whole contents.
    let blob_val = res!(JsFuture::from(file_handle.get_file()).await
        .map_err(|e| err!("OPFS: get file '{}' failed: {}.", leaf, js_str(&e); IO, File, Read)));
    let file: File = res!(blob_val.dyn_into()
        .map_err(|_| err!("OPFS: get_file for '{}' returned a non-file.", leaf; IO, File, Read)));
    let buf_val = res!(JsFuture::from(file.array_buffer()).await
        .map_err(|e| err!("OPFS: read bytes of '{}' failed: {}.", leaf, js_str(&e); IO, File, Read)));
    let bytes = js_sys::Uint8Array::new(&buf_val).to_vec();
    Ok(bytes)
}

/// Read the entries of `dir`, returning `(name, is_dir, size)` per entry.
///
/// OPFS directory iteration is exposed as an async iterator via
/// `FileSystemDirectoryHandle.entries()` (web-sys returns a
/// [`js_sys::AsyncIterator`]).  Each `next()` yields a `Promise` resolving
/// to an `{ done, value }` record whose `value` is a `[name, handle]`
/// pair; the record fields are read with [`js_sys::Reflect`].  A file
/// entry's size comes from its [`File`] (`getFile().size`); directory
/// entries report a size of zero.
async fn read_entries(dir: &FileSystemDirectoryHandle) -> Outcome<Vec<(String, bool, u64)>> {
    let iter = dir.entries();
    let mut out: Vec<(String, bool, u64)> = Vec::new();
    loop {
        let promise = res!(iter.next()
            .map_err(|e| err!("OPFS: directory iterator next() failed: {}.", js_str(&e); IO, File, Read)));
        let record = res!(JsFuture::from(promise).await
            .map_err(|e| err!("OPFS: awaiting directory entry failed: {}.", js_str(&e); IO, File, Read)));

        // `done` signals iterator exhaustion; treat a missing/unreadable
        // flag as done so a malformed record cannot spin forever.
        let done = js_sys::Reflect::get(&record, &JsValue::from_str("done"))
            .ok()
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        if done {
            break;
        }

        let value = res!(js_sys::Reflect::get(&record, &JsValue::from_str("value"))
            .map_err(|e| err!("OPFS: read directory entry value failed: {}.", js_str(&e); IO, File, Read)));
        let pair = js_sys::Array::from(&value);
        let name = pair.get(0).as_string().unwrap_or_default();
        let handle = pair.get(1);

        // The handle's `kind` distinguishes files from directories.
        let is_dir = js_sys::Reflect::get(&handle, &JsValue::from_str("kind"))
            .ok()
            .and_then(|v| v.as_string())
            .map(|k| k == "directory")
            .unwrap_or(false);

        let size = if is_dir {
            0u64
        } else {
            match handle.dyn_into::<FileSystemFileHandle>() {
                Ok(fh) => {
                    let file_val = res!(JsFuture::from(fh.get_file()).await
                        .map_err(|e| err!("OPFS: get file '{}' failed: {}.", name, js_str(&e); IO, File, Read)));
                    match file_val.dyn_into::<File>() {
                        Ok(f)  => f.size() as u64,
                        Err(_) => 0u64,
                    }
                }
                Err(_) => 0u64,
            }
        };
        out.push((name, is_dir, size));
    }
    Ok(out)
}

/// List the entries of the directory at `path` under `root`, returning
/// `(name, is_dir, size)` per entry (unsorted — the caller orders them).
/// An empty path addresses the root directory.
pub async fn list_dir(root: FileRoot, path: &str) -> Outcome<Vec<(String, bool, u64)>> {
    let handle = res!(resolve_root(root).await);
    let dir = res!(descend_dir(&handle, path).await);
    read_entries(&dir).await
}

/// Delete the entry at `path` under `root`.  With `recursive` set, a
/// directory and all its contents are removed; otherwise a non-empty
/// directory is rejected by the browser.  Errors if the entry or any
/// parent does not exist.
pub async fn delete_entry(root: FileRoot, path: &str, recursive: bool) -> Outcome<()> {
    let handle = res!(resolve_root(root).await);
    let components = res!(jail_components(path));
    let (dir, leaf) = res!(open_parent(&handle, components).await);
    let opts = FileSystemRemoveOptions::new();
    opts.set_recursive(recursive);
    res!(JsFuture::from(dir.remove_entry_with_options(&leaf, &opts)).await
        .map_err(|e| err!("OPFS: remove '{}' failed: {}.", leaf, js_str(&e); IO, File)));
    Ok(())
}

/// Whether an entry (file or directory) exists at `path` under `root`.
pub async fn exists(root: FileRoot, path: &str) -> Outcome<bool> {
    let handle = res!(resolve_root(root).await);
    let components = res!(jail_components(path));
    let (dir, leaf) = match open_parent(&handle, components).await {
        Ok(v)  => v,
        Err(_) => return Ok(false),
    };
    if JsFuture::from(dir.get_file_handle(&leaf)).await.is_ok() {
        return Ok(true);
    }
    if JsFuture::from(dir.get_directory_handle(&leaf)).await.is_ok() {
        return Ok(true);
    }
    Ok(false)
}
