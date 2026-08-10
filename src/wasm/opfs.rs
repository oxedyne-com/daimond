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
//! path can only ever address a descendant of the root handle.  The jail
//! is also what makes `.` and `..` unreachable as component NAMES — the
//! two strings the File System Standard refuses outright — because they
//! are consumed as navigation before any name is formed.
//!
//! ## Names the filesystem will take
//!
//! A workspace name is not always a filesystem name.  A Maildir message is called
//! `<uid>.<uidvalidity>.daimond:2,<flags>`, and a colon is refused by every root except a modern
//! browser's own sandbox — including the real local folder the user may have open, which is where
//! `mail/…` USED to land, and where a build before this one left it.  [`crate::fsname`] is the
//! codec that closes the gap, and [`disk_name`] is the single place in this module where it is
//! applied; [`read_entries`] is the single place the inverse is.  Nothing else may spell a name
//! for the browser.
//!
//! Because both ends go through that one pair, a file copied from the folder to the sandbox keeps
//! its WORKSPACE name across the crossing — decoded out of the folder's listing, encoded again for
//! whichever root it is written to — and so cannot arrive under a second spelling of itself.
//! Migrating `mail/` (see [`crate::wasm::diamond::adopt_from_folder`]) rests on exactly that.
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
//! uses is selected by [`crate::tools::FileRoot`] **and by the path**:
//! [`FileRoot::Workspace`](crate::tools::FileRoot::Workspace) honours the
//! override (the file tools / Workspace edit the real folder) for the user's
//! work, and pins the OPFS root for a path naming Daimond's own store
//! ([`is_store_path`](crate::tools::is_store_path)), so a Diamond is the same
//! Diamond in either mode;
//! [`FileRoot::Opfs`](crate::tools::FileRoot::Opfs) always pins the OPFS
//! root so Daimond's own Diamond/crystal/`.daimond` state can never pollute the user's
//! real repo; and [`FileRoot::Machine`](crate::tools::FileRoot::Machine) always
//! resolves to the real folder, for the one operation that copies out of it.
//!
//! The synchronous `createSyncAccessHandle` path (single-writer Worker,
//! for the append-only `.daimond` log) is deferred; this async edge covers
//! whole-file read and write, which is what the first vertical needs.
// TODO(wasm-opfs-sync): add a Worker-hosted `createSyncAccessHandle`
// backend for the append-only session log, where synchronous positioned
// writes matter.

use crate::fsname;
use crate::tools::FileRoot;
use crate::wasm::js_str;

use oxedyne_fe2o3_core::prelude::*;

use std::cell::RefCell;
use std::path::{Component, Path};

use wasm_bindgen::JsCast;
use wasm_bindgen::JsValue;
use wasm_bindgen_futures::JsFuture;
use web_sys::{
    Blob,
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

/// Whether a real folder is open at all.
///
/// [`workspace_mode`] answers the same question for the page, which wants a word to render; a
/// caller that wants to know whether [`FileRoot::Machine`] can resolve wants a boolean, and
/// comparing strings to find out is how the two answers drift apart.
pub fn folder_open() -> bool {
    WORKSPACE_OVERRIDE.with(|c| c.borrow().is_some())
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

/// The name a component is actually stored under inside `dir`.
///
/// THE ONE PLACE A WORKSPACE NAME BECOMES A FILESYSTEM NAME.  Every call below that reaches
/// `getFileHandle`, `getDirectoryHandle` or `removeEntry` takes its name from here or from
/// [`descend`] / [`descend_dir`] / [`open_parent`], which take theirs from here — because a file
/// written under one spelling and looked for under another is worse than the loud failure this
/// fixes.  [`read_entries`] closes the loop in the other direction, decoding what it lists.
///
/// A name [`fsname::encode`] leaves alone is used exactly as it is, which is every ordinary name
/// and therefore the whole of an existing store: no walk, no rename, nothing moves.
///
/// A name it must escape is looked for UNESCAPED first.  A store written before this codec existed
/// holds it that way — a Maildir file on a browser whose sandbox accepted `:` is precisely that,
/// and those users' mail synced perfectly well — and reaching straight for the escaped name would
/// leave their messages on disk under a name nothing asks for any more, with a second copy growing
/// beside them.  Only when no such entry is there is the escaped name used, so a name that has
/// never been stored gets the legal spelling and one that has keeps the one it has.
///
/// # Arguments
/// * `dir` - The directory the component sits in.
/// * `name` - The component as the workspace spells it.
async fn disk_name(dir: &FileSystemDirectoryHandle, name: &str) -> String {
    let enc = fsname::encode(name);
    if enc == name {
        return enc;
    }
    // A browser that refuses the unescaped name REJECTS the promise (the File System Standard
    // says so, and the TypeError this whole module exists for arrived that way), so a lookup
    // costs nothing but an answer of "no".
    if JsFuture::from(dir.get_file_handle(name)).await.is_ok() {
        return name.to_string();
    }
    if JsFuture::from(dir.get_directory_handle(name)).await.is_ok() {
        return name.to_string();
    }
    enc
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
    // NOT through `disk_name`, and deliberately.  The namespace is `d~` and sixteen hex
    // characters, so the codec is the identity on it either way -- but `cloud.js`'s `opfsRoot`
    // and the account wipe in `daimond.js` reach this same directory by its literal name, and a
    // spelling rule applied here and not there is how one account's files end up somewhere the
    // other three doors cannot see.
    let opts = FileSystemGetDirectoryOptions::new();
    opts.set_create(true);
    let sub_val = res!(JsFuture::from(dir.get_directory_handle_with_options(&ns, &opts)).await
        .map_err(|e| err!("OPFS: opening account subdirectory '{}' failed: {}.", ns, js_str(&e); IO, File)));
    let sub: FileSystemDirectoryHandle = res!(sub_val.dyn_into()
        .map_err(|_| err!("OPFS: account subdirectory was not a directory handle."; IO, File)));
    Ok(sub)
}

/// Resolve the root handle a call operates against, for the path it is about to address.
///
/// [`FileRoot::Workspace`] returns the FSA override when one is open, else the OPFS root;
/// [`FileRoot::Opfs`] always returns the OPFS root; [`FileRoot::Machine`] always returns the
/// override and fails when there is none.
///
/// The path is what makes the first of those true of Daimond's own state as well as of the user's
/// work.  A Diamond lives at `diamonds/<id>`, and every reader of that path other than the store
/// itself -- the file tools, the Workspace panel, a dispatched worker -- asks for
/// [`FileRoot::Workspace`].  With a folder open they were reading and writing the user's project,
/// so a Diamond's own files vanished from the panel on a switch and a worker's output landed
/// outside the sync parcel where nothing would ever see it again.  The rule is one line and it is
/// applied here, once: a path naming the store resolves against OPFS whatever root is active (see
/// [`crate::tools::is_store_path`]).
///
/// A mailbox at `mail/<address>` is the same rule for a different reason, and it was missing:
/// mail belongs to an ACCOUNT, so following the folder put the messages inside whichever one
/// happened to be open, hid them when none was, and wrote them somewhere else again after a
/// switch.  A real folder would not even take the names -- a Maildir colon is refused outside the
/// sandbox.  See [`crate::tools::MAIL_ROOT`].
///
/// [`FileRoot::Opfs`] is NOT made redundant by that and must not be deleted as though it were.  It
/// is the belt to this test's braces: `crystal.json` is written through two doors and read through
/// a third, and the day one of them stops agreeing with the others is the day an agent reads an
/// empty crystal and writes over work it never saw.
///
/// # Arguments
/// * `root` - Which root the caller asked for.
/// * `path` - The workspace-relative path the call addresses; empty addresses the root itself.
async fn resolve_root(root: FileRoot, path: &str) -> Outcome<FileSystemDirectoryHandle> {
    match root {
        FileRoot::Workspace => {
            // Daimond's own store never follows the folder, whoever asked.
            if !crate::tools::is_store_path(path) {
                if let Some(h) = WORKSPACE_OVERRIDE.with(|c| c.borrow().clone()) {
                    return Ok(h);
                }
            }
            opfs_root().await
        }
        FileRoot::Opfs => opfs_root().await,
        // Never a fallback to the sandbox: the one caller is a copy OUT of the folder, and a
        // fallback would copy the sandbox onto itself and call it a migration.
        FileRoot::Machine => match WORKSPACE_OVERRIDE.with(|c| c.borrow().clone()) {
            Some(h) => Ok(h),
            None    => Err(err!(
                "OPFS: '{}' was addressed on the machine folder, and no folder is open.", path;
                IO, File, Missing)),
        },
    }
}

/// Descend into (creating as needed) the directory components of a
/// jailed path, returning the handle to the directory that will hold the
/// leaf file plus the leaf name.
///
/// The leaf comes back as its ON-DISK name (see [`disk_name`]), so a caller can hand it straight
/// to the browser without knowing that a spelling question exists.
async fn descend(
    root:       &FileSystemDirectoryHandle,
    components: Vec<String>,
)
    -> Outcome<(FileSystemDirectoryHandle, String)>
{
    let mut dir = root.clone();
    let last = components.len() - 1;
    let mut leaf = String::new();
    for (i, want) in components.into_iter().enumerate() {
        let name = disk_name(&dir, &want).await;
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
    for want in components {
        let name = disk_name(&dir, &want).await;
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
///
/// The leaf comes back as its ON-DISK name (see [`disk_name`]).
async fn open_parent(
    root:       &FileSystemDirectoryHandle,
    components: Vec<String>,
)
    -> Outcome<(FileSystemDirectoryHandle, String)>
{
    let mut dir = root.clone();
    let last = components.len() - 1;
    let mut leaf = String::new();
    for (i, want) in components.into_iter().enumerate() {
        let name = disk_name(&dir, &want).await;
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
    let handle = res!(resolve_root(root, path).await);
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

    // COPIED INTO A JS-OWNED BUFFER FIRST, AND THIS IS NOT AN OPTIMISATION.
    //
    // `write_with_u8_array(&[u8])` hands JavaScript a `Uint8Array` VIEW over wasm
    // linear memory — zero-copy, and pointing straight into this module's heap.
    // The write is then AWAITED. If wasm memory grows while that await is
    // outstanding, the engine replaces the backing `ArrayBuffer` and the view no
    // longer describes the bytes it was made from.
    //
    // THIS WROTE 216 MB OF RAW WASM MEMORY INTO EVERY ONE OF A USER'S FIFTEEN
    // `meta.json` FILES. Their phone's heap had ballooned to 235 MB, every write
    // in that window landed the wrong bytes, and all fifteen files came out
    // byte-identical in length — 235 MB of heap less a small offset — containing
    // no JSON at all: no name, no tags, not one quote character in the first
    // 64 KB. The Diamond names were not corrupted, they were overwritten with a
    // photograph of the heap.
    //
    // `Uint8Array::new_with_length` allocates on the JAVASCRIPT heap, and
    // `copy_from` copies out of wasm memory immediately, before anything can be
    // awaited. Growing the wasm heap afterwards cannot touch it. The cost is one
    // copy of the file being written, which is the correct price.
    let buf = js_sys::Uint8Array::new_with_length(content.len() as u32);
    buf.copy_from(content);
    let write_promise = res!(writable.write_with_buffer_source(&buf)
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
    let handle = res!(resolve_root(root, path).await);
    let components = res!(jail_components(path));
    let mut dir = handle;
    for want in components {
        let name = disk_name(&dir, &want).await;
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
///
/// Each sub-call resolves the root for ITS OWN path (see [`resolve_root`]), so a move between
/// Daimond's store and the user's folder crosses roots correctly rather than half-happening: the
/// bytes are read from wherever `from` lives and written to wherever `to` lives.  What it is not is
/// a way to move a Diamond out of the store and have it still be a Diamond -- the store is where
/// the rail reads, so such a move REMOVES it, exactly as asked.
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
    let handle = res!(resolve_root(root, path).await);
    let components = res!(jail_components(path));
    let (dir, leaf) = res!(open_parent(&handle, components).await);
    Ok(JsFuture::from(dir.get_directory_handle(&leaf)).await.is_ok())
}

/// Read the entire contents of `path` under `root` as bytes.  Errors if
/// any path component (directory or the file itself) does not exist.
pub async fn read_file(root: FileRoot, path: &str) -> Outcome<Vec<u8>> {
    let handle = res!(resolve_root(root, path).await);
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

/// Read `len` bytes of a file from `offset`, and say how big the whole thing is.
///
/// [`read_file_capped`] below reads a prefix, which is what a caller wanting to know what a file
/// IS needs.  A caller wanting to SHOW a file needs to move through it -- the next page of a hex
/// dump, a later frame -- and reading from the start each time turns a walk through a large file
/// into a quadratic one.
///
/// The bytes never all exist at once: `slice` hands back another `Blob` and copies nothing until
/// it is read, and the size comes off the handle, which a `Blob` knows without anyone reading it.
/// An `offset` past the end is not an error; it answers with nothing and the true size, which is
/// what lets a caller walk to the end without knowing in advance where the end is.
///
/// # Arguments
/// * `root` - Which root to resolve `path` against.
/// * `path` - The workspace-relative path.
/// * `offset` - Where to start, in bytes.
/// * `len` - How many bytes to take.
pub async fn read_file_range(
    root:   FileRoot,
    path:   &str,
    offset: f64,
    len:    u32,
)
    -> Outcome<(Vec<u8>, f64)>
{
    let handle = res!(resolve_root(root, path).await);
    let components = res!(jail_components(path));
    let (dir, leaf) = res!(open_parent(&handle, components).await);

    let file_val = res!(JsFuture::from(dir.get_file_handle(&leaf)).await
        .map_err(|e| err!("OPFS: open file '{}' failed: {}.", leaf, js_str(&e); IO, File, Read)));
    let file_handle: FileSystemFileHandle = res!(file_val.dyn_into()
        .map_err(|_| err!("OPFS: file handle for '{}' was not a file.", leaf; IO, File, Read)));
    let blob_val = res!(JsFuture::from(file_handle.get_file()).await
        .map_err(|e| err!("OPFS: get file '{}' failed: {}.", leaf, js_str(&e); IO, File, Read)));
    let file: File = res!(blob_val.dyn_into()
        .map_err(|_| err!("OPFS: get_file for '{}' returned a non-file.", leaf; IO, File, Read)));

    let total = file.size();
    let from = if offset < 0.0 { 0.0 } else { offset };
    if from >= total {
        return Ok((Vec::new(), total));
    }
    let to = (from + len as f64).min(total);
    let want: &Blob = file.as_ref();
    // `slice_with_f64_and_f64` rather than the i32 pair: a file over 2 GiB is exactly the case
    // this function exists for, and an i32 offset would wrap silently in the middle of one.
    let part = res!(want.slice_with_f64_and_f64(from, to)
        .map_err(|e| err!("OPFS: slice '{}' failed: {}.", leaf, js_str(&e); IO, File, Read)));
    let buf_val = res!(JsFuture::from(part.array_buffer()).await
        .map_err(|e| err!("OPFS: read bytes of '{}' failed: {}.", leaf, js_str(&e); IO, File, Read)));
    Ok((js_sys::Uint8Array::new(&buf_val).to_vec(), total))
}

/// Read at most `max` bytes of a file, and say how big the whole thing is.
///
/// WHY THIS EXISTS. `read_file` above reads whatever is on disk into memory, and
/// on an iPhone that killed the app. A `meta.json` — a name, a version, two
/// stamps and a few tags — had grown to hundreds of megabytes on two of one
/// user's Diamonds, and `read_meta` slurped it on every boot: the device's own
/// trail recorded `HEAP GREW read_meta +1404M -> 1639M`, and iOS took the tab
/// away a second later. Wasm linear memory never shrinks, so every boot did it
/// again, which is the whole of the login loop that ran for five sessions.
///
/// The size comes off the `File` handle, which costs nothing — a `Blob` knows
/// its length without anyone reading it — and only the prefix is materialised.
/// Returns `(bytes, total)` so a caller can tell a whole small file from the
/// front of a huge one and say so.
///
/// A file this reads a prefix of is a file something is wrong with. The caller
/// decides what to do about that; what this guarantees is that finding out
/// cannot cost more than `max`.
pub async fn read_file_capped(root: FileRoot, path: &str, max: u32) -> Outcome<(Vec<u8>, f64)> {
    let handle = res!(resolve_root(root, path).await);
    let components = res!(jail_components(path));
    let (dir, leaf) = res!(open_parent(&handle, components).await);

    let file_val = res!(JsFuture::from(dir.get_file_handle(&leaf)).await
        .map_err(|e| err!("OPFS: open file '{}' failed: {}.", leaf, js_str(&e); IO, File, Read)));
    let file_handle: FileSystemFileHandle = res!(file_val.dyn_into()
        .map_err(|_| err!("OPFS: file handle for '{}' was not a file.", leaf; IO, File, Read)));
    let blob_val = res!(JsFuture::from(file_handle.get_file()).await
        .map_err(|e| err!("OPFS: get file '{}' failed: {}.", leaf, js_str(&e); IO, File, Read)));
    let file: File = res!(blob_val.dyn_into()
        .map_err(|_| err!("OPFS: get_file for '{}' returned a non-file.", leaf; IO, File, Read)));

    let total = file.size();
    // The whole file when it fits, and only the front of it when it does not.
    // `slice` hands back another Blob and copies nothing until it is read.
    let want: &Blob = file.as_ref();
    let part = if total > max as f64 {
        res!(want.slice_with_i32_and_i32(0, max as i32)
            .map_err(|e| err!("OPFS: slice '{}' failed: {}.", leaf, js_str(&e); IO, File, Read)))
    } else {
        want.clone()
    };
    let buf_val = res!(JsFuture::from(part.array_buffer()).await
        .map_err(|e| err!("OPFS: read bytes of '{}' failed: {}.", leaf, js_str(&e); IO, File, Read)));
    Ok((js_sys::Uint8Array::new(&buf_val).to_vec(), total))
}

/// Read the entries of `dir`, returning `(name, is_dir, size)` per entry.
///
/// The names come back AS THE WORKSPACE SPELLS THEM, not as the browser stores them: a listing
/// that returned `70074.3.daimond%3A2,S` would hand every caller a name that does not open, and
/// mail matches on the Maildir flags after the `:2,`, so it would read every message as unflagged.
/// [`fsname::decode`] is the inverse of the [`disk_name`] every lookup goes through, and it leaves
/// a name written before that codec existed exactly as it found it.
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
        out.push((fsname::decode(&name), is_dir, size));
    }
    Ok(out)
}

/// List the entries of the directory at `path` under `root`, returning
/// `(name, is_dir, size)` per entry (unsorted — the caller orders them).
/// An empty path addresses the root directory.
pub async fn list_dir(root: FileRoot, path: &str) -> Outcome<Vec<(String, bool, u64)>> {
    let handle = res!(resolve_root(root, path).await);
    let dir = res!(descend_dir(&handle, path).await);
    read_entries(&dir).await
}

/// Delete the entry at `path` under `root`.  With `recursive` set, a
/// directory and all its contents are removed; otherwise a non-empty
/// directory is rejected by the browser.  Errors if the entry or any
/// parent does not exist.
pub async fn delete_entry(root: FileRoot, path: &str, recursive: bool) -> Outcome<()> {
    let handle = res!(resolve_root(root, path).await);
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
    let handle = res!(resolve_root(root, path).await);
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

