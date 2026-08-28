//! The `#[wasm_bindgen]` API surface exposed to the browser.
//!
//! Three probes prove the browser vertical end-to-end, no server
//! involved:
//!
//! 1. [`core_probe`] — the wasm module instantiates and a `fe2o3_core`
//!    call path (getrandom-backed RNG, the wasm clock shim, the error
//!    machinery) executes without panicking.
//! 2. [`write_file`] / [`read_file`] — a byte-exact OPFS round trip
//!    through the [`opfs`](crate::wasm::opfs) edge.
//! 3. [`llm_probe`] — the real wasm [`LlmClient`](crate::llm::LlmClient)
//!    transport issues a cross-origin `fetch` to a provider and returns
//!    the HTTP status.
//!
//! Async functions surface to JS as `Promise`s (via
//! `wasm-bindgen-futures`); [`Outcome`] errors are mapped to a rejected
//! `Promise` through [`to_js_err`](crate::wasm::to_js_err).

use crate::llm::LlmClient;
use crate::tools::FileRoot;
use crate::wasm::{diamond, opfs, to_js_err};

use oxedyne_fe2o3_graphics::qr::{
    encode,
    QrEcc,
};
use oxedyne_fe2o3_sbj::{
    card::{
        self,
        Card,
        Role,
    },
    doc::{
        self,
        Payload,
    },
    envelope,
    post::{
        Post,
        Reference,
        Target,
    },
    share::{
        self,
        Share,
    },
};
use oxedyne_fe2o3_stds::media;

use oxedyne_fe2o3_core::prelude::*;
use oxedyne_fe2o3_core::rand::Rand;
use oxedyne_fe2o3_core::wasm::{console_log, now_ms};

use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;
use web_sys::FileSystemDirectoryHandle;


/// Default per-turn token cap for the probe client.  The value is
/// irrelevant to a dummy-key probe (the request never reaches
/// generation), but the field must be set.
const PROBE_MAX_TOKENS: u32 = 16;


/// Send a Rust panic somewhere a person can read it.
///
/// WHY THIS EXISTS. There was no panic hook at all, and a wasm panic without one
/// is the most opaque failure this app can produce: the browser reports a bare
/// `"Script error."` with no file, no line and no message, the `Promise` the
/// call was made through NEVER SETTLES, and the module is left poisoned. An
/// iPhone looped on exactly that for four sessions -- the trail showed
/// `unlocked`, then `Script error.`, then the step that had started simply never
/// reporting either way, and then the tab dying. Every diagnosis was a guess
/// because the one thing that knew what happened had nowhere to say it.
///
/// The panic goes to the console AND to `window.DaimondTrail`, which is durable
/// and survives the reload -- a console nobody can open on a phone is the reason
/// this took four attempts.
///
/// Installed by [`install_panic_hook`], called from every entry point that can
/// be the first one, because there is no `#[wasm_bindgen(start)]` here.
fn report_panic(info: &std::panic::PanicHookInfo<'_>) {
    let msg = fmt!("{}", info);
    console_log(&msg);
    let win = match web_sys::window() {
        Some(w) => w,
        None    => return,          // a worker: the console line is all there is
    };
    // `window.DaimondTrail.note('wasm panic', msg)`, reached reflectively so a
    // page without the trail is simply a page that gets the console line.
    let trail = match js_sys::Reflect::get(&win, &JsValue::from_str("DaimondTrail")) {
        Ok(t)  => t,
        Err(_) => return,
    };
    let note = match js_sys::Reflect::get(&trail, &JsValue::from_str("note")) {
        Ok(n)  => n,
        Err(_) => return,
    };
    if let Ok(f) = note.dyn_into::<js_sys::Function>() {
        let _ = f.call2(&trail, &JsValue::from_str("WASM PANIC"), &JsValue::from_str(&msg));
    }
}

/// Write one line into the durable trail from Rust.
///
/// The same reflective call [`report_panic`] makes, exposed for the places where
/// a step can hang rather than fail. A hang has no error to report and no panic
/// to hook -- the caller's `Promise` simply never settles -- so the only way to
/// find it is for the code to say where it got to before it stopped.
///
/// Costs a JS call, so it goes at the boundaries of long operations and never
/// inside a per-file loop.
pub fn trail(what: &str, detail: &str) {
    let win = match web_sys::window() {
        Some(w) => w,
        None    => return,
    };
    let t = match js_sys::Reflect::get(&win, &JsValue::from_str("DaimondTrail")) {
        Ok(t)  => t,
        Err(_) => return,
    };
    let n = match js_sys::Reflect::get(&t, &JsValue::from_str("note")) {
        Ok(n)  => n,
        Err(_) => return,
    };
    if let Ok(f) = n.dyn_into::<js_sys::Function>() {
        let _ = f.call2(&t, &JsValue::from_str(what), &JsValue::from_str(detail));
    }
}

/// Grow the linear memory on purpose, so the gauge itself can be proved.
///
/// WHY THIS EXISTS, and it is the same reason [`panic_on_purpose`] exists. The
/// heap gauge read exactly 1 MB through every local experiment — fifteen
/// Diamonds, seven hundred and fifty version files, twenty engine instances —
/// and a number that never moves is indistinguishable from a number that cannot.
/// The phone's trail shows it going 1 → 235 → 1639, so it is not stuck there;
/// but "it moved once on a device I cannot inspect" is not proof that it tracks
/// allocation, and four sessions were lost to instruments nobody had watched
/// working.
///
/// Allocates `mb` megabytes, touches every page so nothing is optimised away,
/// and leaks it deliberately: linear memory never shrinks, so returning it would
/// prove nothing about the number this reports.
#[wasm_bindgen]
pub fn grow_on_purpose(mb: u32) -> f64 {
    let bytes = (mb as usize) * 1_048_576;
    let mut v: Vec<u8> = Vec::with_capacity(bytes);
    // Written, not merely reserved: an untouched reservation can be a mapping
    // the allocator has not asked the runtime for yet.
    for i in 0..bytes {
        v.push((i & 0xff) as u8);
    }
    std::mem::forget(v);
    heap_bytes()
}

/// The linear memory in whole megabytes, for a trail line.
///
/// Separate from [`heap_bytes`] because the JS side wants bytes and every caller
/// in Rust wants a short number to put beside what it just did.
pub fn heap_mb() -> u32 {
    (heap_bytes() / 1_048_576.0) as u32
}

/// Spell one path component the way the filesystem edge will store it.
///
/// Exported so the JavaScript copy of the codec in `cloud.js` can be held to this one rather than
/// to a reading of it.  There are two implementations because the workspace walkers in
/// `daimond.js` reach the browser's handles directly, and two implementations that are never
/// compared are two implementations that will drift; `dev/verify_mailnames.mjs` drives both over
/// one corpus.  Nothing in the app calls this — the edge applies the codec itself.
#[wasm_bindgen]
pub fn fs_disk_name(name: &str) -> String {
    crate::fsname::encode(name)
}

/// Read a stored component back the way the workspace spells it.  The inverse of [`fs_disk_name`],
/// and exported for the same reason.
#[wasm_bindgen]
pub fn fs_logical_name(name: &str) -> String {
    crate::fsname::decode(name)
}

/// Panic on purpose, so the hook itself can be proved rather than assumed.
///
/// A diagnostic that has never been seen working is a diagnostic nobody should
/// trust the silence of. `verify_wasmpanic` calls this and requires the trail to
/// name the file and the line.
#[wasm_bindgen]
pub fn panic_on_purpose() {
    panic!("panic_on_purpose: proving the hook reports");
}

/// How much linear memory this module currently holds, in bytes.
///
/// WHY THIS EXISTS. The leading explanation for a phone that unlocks, shows the
/// app for a second and dies is that iOS Safari is killing the tab for using too
/// much memory -- there is no `pagehide`, so the tab is not reloading, it is
/// being taken away. That has been an explanation for four sessions and has
/// never once been a MEASUREMENT, because Safari exposes no
/// `performance.memory`. Wasm does: the linear memory only ever grows, and its
/// size is a number the module can read about itself.
///
/// Sampled at a high-water mark rather than on a timer (see `watchHeap` in
/// daimond.js), so a trail carries the growth curve in a dozen rows rather than
/// hundreds. If those rows climb to a few hundred megabytes and stop, the answer
/// is memory and the argument is over; if the tab dies at forty, it never was.
#[wasm_bindgen]
pub fn heap_bytes() -> f64 {
    #[cfg(target_arch = "wasm32")]
    {
        // One page is 64 KiB, by the specification, and this is the only place
        // the app can see its own footprint at all.
        (core::arch::wasm32::memory_size(0) as f64) * 65536.0
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        // The host build has an ordinary allocator and no linear memory to
        // report. Zero, so a caller reads "not measured" rather than a lie.
        0.0
    }
}

/// Install [`report_panic`], once.
///
/// Idempotent by a flag rather than by asking: `std::panic::set_hook` replaces
/// whatever is there, and replacing it on every call would be harmless but
/// wasteful on a path that runs per Diamond.
#[wasm_bindgen]
pub fn install_panic_hook() {
    use std::sync::atomic::{AtomicBool, Ordering};
    static DONE: AtomicBool = AtomicBool::new(false);
    if DONE.swap(true, Ordering::Relaxed) {
        return;
    }
    std::panic::set_hook(Box::new(report_panic));
}

/// Run a `fe2o3_core` call path in the browser and return a one-line
/// summary — the F2 proof that the gated core *runs*, not merely
/// compiles.
///
/// Exercises getrandom (via [`Rand::rand_u64`]), the wasm clock shim
/// ([`now_ms`]), the console shim ([`console_log`]) and the error
/// machinery ([`err`]).  Never panics.
#[wasm_bindgen]
pub fn core_probe() -> Result<String, JsValue> {
    // getrandom-backed RNG — panics on wasm if the `js` backend is not
    // wired, so a returned value is itself proof.
    let r = Rand::rand_u64();

    // Wall-clock via the JS `Date.now()` shim.
    let t = now_ms();

    // The error machinery must format cleanly under wasm.
    let sample: Error<ErrTag> = err!("probe sample error"; Test);
    let err_len = fmt!("{}", sample).len();

    let summary = fmt!(
        "core ok: rand_u64={:#018x}, now_ms={:.0}, err_fmt_len={}",
        r, t, err_len,
    );
    console_log(&summary);
    Ok(summary)
}

/// Write `content` (UTF-8) to `path` in the active Workspace root,
/// creating parents as needed.  Resolves against the FSA real folder when
/// one is open, else the OPFS sandbox.  Rejects on a jail violation or a
/// filesystem failure.
#[wasm_bindgen]
pub async fn write_file(path: String, content: String) -> Result<(), JsValue> {
    opfs::write_file(FileRoot::Workspace, &path, content.as_bytes()).await.map_err(to_js_err)
}

/// Read `path` from the active Workspace root (FSA real folder when open,
/// else OPFS) and return its contents as a UTF-8 string.
#[wasm_bindgen]
pub async fn read_file(path: String) -> Result<String, JsValue> {
    match opfs::read_file(FileRoot::Workspace, &path).await {
        Ok(bytes) => Ok(String::from_utf8_lossy(&bytes).to_string()),
        Err(e)    => Err(to_js_err(e)),
    }
}

// ── Bytes, and what they are ─────────────────────────────────────────────
//
// [`read_file`] above ends in `from_utf8_lossy`, which is right for the callers it was written
// for and catastrophic for the one that opens whatever the user clicked.  Every byte that is not
// valid UTF-8 becomes U+FFFD, so opening a PDF filled the document panel with replacement
// characters and no indication that anything had gone wrong -- the app looked broken rather than
// the format looking unsupported.
//
// There was a binary guard, and it never fired for a file in the user's own folder: it asked
// `DaimondCloud.fileAt`, which resolves through the cloud offload cache and not the workspace at
// all.  So the guard covered the files least likely to need it.
//
// These two functions are the fix, and they are deliberately separate.  [`file_probe`] says what a
// file IS without reading much of it; [`read_bytes`] hands over a range of it byte-exactly.  A
// caller asks the first, decides, and only then asks the second -- which is what keeps a 900 MB
// video from being materialised in wasm linear memory to find out that it is a video.

/// What a file is, without reading much of it: `{size, media, kind, mime, label, text, disagree}`.
///
/// The format comes from [`oxedyne_fe2o3_stds::media::identify`], which reads both the leading
/// bytes and the name and reports when they disagree.  `disagree` is not a warning about a
/// malformed file -- it is the interesting case, and a viewer that hides it hides how a person
/// finds a broken export.
///
/// Only the first 512 bytes are read, which recognises every format in the table except a tar
/// archive, whose signature sits at offset 257 and so needs 264 of them.
///
/// `media` and `kind` are the enum variant names (`"Png"`, `"Image"`), which are stable because
/// they are the API; `mime` is what to put on a `Blob`, and `label` is an English fallback for a
/// caller with nowhere to translate.
///
/// # Arguments
/// * `path` - The path, resolved against the active Workspace root.
#[wasm_bindgen]
pub async fn file_probe(path: String) -> Result<String, JsValue> {
    probe_at(FileRoot::Workspace, &path).await.map_err(to_js_err)
}

/// [`file_probe`], against Daimond's own store rather than the workspace.
#[wasm_bindgen]
pub async fn store_file_probe(path: String) -> Result<String, JsValue> {
    probe_at(FileRoot::Opfs, &path).await.map_err(to_js_err)
}

/// Read `len` bytes of a file from `offset`, byte-exactly.
///
/// No decoding of any kind happens here, which is the whole point.  A caller that wants
/// characters asks [`file_probe`] first and decodes only what it was told is text.
///
/// An `offset` past the end answers with an empty array rather than an error, so a caller can walk
/// to the end of a file without knowing in advance where the end is.
///
/// # Arguments
/// * `path` - The path, resolved against the active Workspace root.
/// * `offset` - Where to start, in bytes.
/// * `len` - How many bytes to take.
#[wasm_bindgen]
pub async fn read_bytes(path: String, offset: f64, len: u32) -> Result<js_sys::Uint8Array, JsValue> {
    match opfs::read_file_range(FileRoot::Workspace, &path, offset, len).await {
        Ok((bytes, _)) => Ok(js_sys::Uint8Array::from(&bytes[..])),
        Err(e)         => Err(to_js_err(e)),
    }
}

/// [`read_bytes`], against Daimond's own store rather than the workspace.
#[wasm_bindgen]
pub async fn store_read_bytes(
    path:   String,
    offset: f64,
    len:    u32,
)
    -> Result<js_sys::Uint8Array, JsValue>
{
    match opfs::read_file_range(FileRoot::Opfs, &path, offset, len).await {
        Ok((bytes, _)) => Ok(js_sys::Uint8Array::from(&bytes[..])),
        Err(e)         => Err(to_js_err(e)),
    }
}

/// The body of [`file_probe`], over either root.
///
/// # Arguments
/// * `root` - Which root to resolve `path` against.
/// * `path` - The path.
async fn probe_at(root: FileRoot, path: &str) -> Outcome<String> {
    // 512 rather than 264: the extra costs nothing (a `Blob` slice copies only what is read) and
    // it leaves room for the text-shaped formats, which are recognised from their opening tag.
    let (head, size) = res!(opfs::read_file_range(root, path, 0.0, 512).await);
    let id = media::identify(path, &head);
    // Both halves of a disagreement carry their LABEL as well as their variant name. The
    // variant name is an identifier -- `Pdf`, `Text` -- and a sentence built from it reads
    // "The bytes say Pdf", which is the code's word for the format leaking onto the screen.
    Ok(fmt!(
        "{{\"size\":{},\"media\":\"{:?}\",\"kind\":\"{:?}\",\"mime\":\"{}\",\"label\":\"{}\",\
        \"text\":{},\"chars\":{},\"byMagic\":\"{:?}\",\"byMagicLabel\":\"{}\",\
        \"byName\":\"{:?}\",\"byNameLabel\":\"{}\",\"disagree\":{}}}",
        size,
        id.media,
        id.media.kind(),
        id.media.mime(),
        id.media.label(),
        // `text`: both halves hold -- a format that IS text, and bytes that ARE characters.  A
        // `.json` full of NULs is not something to put on screen as characters however it is
        // named.  This is what a VIEWER wants, because it decides which structured view to draw.
        id.media.is_text() && media::looks_like_text(&head),
        // `chars`: the bytes alone.  This is what an EDITOR wants, and the two are not the same
        // question.  A `Makefile` or a `README` has no extension to recognise, so its format is
        // Unknown and `text` is false -- and it is plainly a file somebody wants to edit.  Asking
        // the narrower question would have sent it to a hex dump.
        media::looks_like_text(&head),
        id.by_magic,
        id.by_magic.label(),
        id.by_name,
        id.by_name.label(),
        id.disagree,
    ))
}

// ── Daimond's own store, pinned to OPFS ──────────────────────────────────
//
// Notes2: *"When I choose the Browser workspace, I see only a mail folder and a
// test.md, where are all the system files like DAIMOND.md??"*
//
// They were where they have always been — at the OPFS root — and the Workspace
// panel deliberately filtered them out, because a `×` beside `diamonds/` would
// delete every Diamond the user has.  Hiding them answered the wrong question:
// what was wanted is to SEE the store, not to be able to destroy it.
//
// These three are the read side of that, and they pin [`FileRoot::Opfs`] rather
// than `Workspace` — which is the whole point.  With a real folder open,
// `read_file` resolves against the folder, so a page asking for `DAIMOND.md`
// gets the PROJECT'S copy and Daimond's own store stays invisible exactly when
// the user is most likely to go looking for it.  `dev/ROOT_SEPARATION.md` §1.1
// is the map of which resolver does what.

/// List a directory in Daimond's own store (OPFS), never a real folder.
///
/// Returns one entry per line: `name\tdir|file\tbytes`.  A flat format because
/// the caller is one function in `daimond.js` and a JSON dependency here would
/// buy nothing; the names cannot contain a tab, since [`crate::tools`] refuses
/// a path with a control character in it.
///
/// # Arguments
/// * `path` - Store-relative, `""` or `"."` for the root.
#[wasm_bindgen]
pub async fn store_list(path: String) -> Result<String, JsValue> {
    let entries = opfs::list_dir(FileRoot::Opfs, &path).await.map_err(to_js_err)?;
    let mut out = String::new();
    for (name, is_dir, size) in entries {
        out.push_str(&fmt!("{}\t{}\t{}\n", name, if is_dir { "dir" } else { "file" }, size));
    }
    Ok(out)
}

/// Read a file from Daimond's own store (OPFS), never a real folder.
#[wasm_bindgen]
pub async fn store_read(path: String) -> Result<String, JsValue> {
    match opfs::read_file(FileRoot::Opfs, &path).await {
        Ok(bytes) => Ok(String::from_utf8_lossy(&bytes).to_string()),
        Err(e)    => Err(to_js_err(e)),
    }
}

/// Write a file into Daimond's own store (OPFS), never a real folder.
///
/// The user editing their own standing instructions or a role prompt while a
/// project folder is open: without this the save would land in the project and
/// the file they were looking at would be unchanged.
#[wasm_bindgen]
pub async fn store_write(path: String, content: String) -> Result<(), JsValue> {
    opfs::write_file(FileRoot::Opfs, &path, content.as_bytes()).await.map_err(to_js_err)
}

/// Write BYTES into Daimond's own store, for a file that is not text.
///
/// The counterpart of [`store_read_bytes`], which has existed all along -- so the store could be read
/// byte for byte and not written that way, and the gap was one-sided rather than a decision.
///
/// **This is the door a picture needs to land in a Diamond.** `store_write` takes a `String`, and
/// `DaimondApp::write_bytes` writes bytes to the WORKSPACE root, which is a real folder on the user's
/// machine whenever they have one open. So a share carrying a PNG had nowhere to put it inside the
/// Diamond: the wire was sound and the landing was not.
///
/// Everything [`store_write`] says about stamping applies here and applies more, because the files that
/// come this way are the large ones: a raw OPFS write moves nothing, and a Diamond written into without
/// being stamped is a Diamond the next sync silently replaces from the other device. Call
/// [`stamp_diamond`] after.
#[wasm_bindgen]
pub async fn store_write_bytes(path: String, bytes: Vec<u8>) -> Result<(), JsValue> {
    opfs::write_file(FileRoot::Opfs, &path, &bytes).await.map_err(to_js_err)
}

/// Stamp a Diamond as changed, so what was written inside it travels to the other devices.
///
/// **A crystal page writing its own log is a mutation like any other, and `touched` is what
/// decides whose copy the other device takes.**  `store_write` is a raw OPFS write and moves
/// nothing, so a capp that logged a meal on a phone left that phone looking STALE: the desktop's
/// copy was strictly fresher, `applyDiamonds` replaces a Diamond wholesale from the fresher side,
/// and the meal went with the copy it replaced.  That is the tag-loss failure of 2026-08-11
/// arriving through a new door, and it is why this is exported rather than left to the caller to
/// remember.
///
/// # Arguments
/// * `id` - The Diamond that was written into.
#[wasm_bindgen]
pub async fn touch_diamond(id: String) -> Result<(), JsValue> {
    diamond::touch(&id).await.map_err(to_js_err)
}

/// Point the file tools / Workspace at a real local folder (FSA mode).
///
/// `handle` is a `FileSystemDirectoryHandle` from `showDirectoryPicker()`
/// in JS, already permission-granted for read/write.  Once set, every
/// [`FileRoot::Workspace`] file tool (`file_read`/`write`/`list`/`edit`/
/// `delete`/`search`) resolves against the real folder.  Daimond's own
/// Diamond/crystal/`.daimond` storage is unaffected — it pins the OPFS sandbox.
#[wasm_bindgen]
pub fn set_workspace_dir(handle: FileSystemDirectoryHandle) {
    opfs::set_override(handle);
}

/// Clear any FSA override, returning the file tools / Workspace to the
/// OPFS sandbox root.
#[wasm_bindgen]
pub fn use_opfs_workspace() {
    opfs::clear_override();
}

/// The current Workspace file-tool root mode: `"folder"` when an FSA real
/// folder is open, else `"opfs"`.
#[wasm_bindgen]
pub fn workspace_mode() -> String {
    opfs::workspace_mode()
}

/// Encode `text` as a QR Code and return its module grid, row-major, one byte
/// per module: `1` is a dark module, `0` a light one.
///
/// The side length is the square root of the returned length, so the caller
/// needs nothing else to draw the symbol. An empty array means the text would
/// not fit the largest QR version, which the caller reads as "fall back to the
/// typed code". Medium error correction is used: robust enough for a phone
/// camera reading the code off a screen, without inflating the version unduly.
#[wasm_bindgen]
pub fn qr_matrix(text: String) -> Vec<u8> {
    match encode(&text, QrEcc::Medium) {
        Ok(qr) => {
            let n = qr.size();
            let mut out = Vec::with_capacity(n * n);
            for y in 0..n {
                for x in 0..n {
                    out.push(if qr.get(x, y) { 1u8 } else { 0u8 });
                }
            }
            out
        }
        Err(_) => Vec::new(),
    }
}

/// Point every OPFS operation at the current account's subdirectory.
///
/// Empty means the primary account (the origin root, unchanged); any other value isolates this
/// account's workspace and Daimond's own state from every other account at this browser. Set once
/// at boot from `DaimondAccounts.opfsNs()`, before any file tool runs.
#[wasm_bindgen]
pub fn set_account_ns(ns: String) {
    opfs::set_account_ns(ns);
}

/// Which permission mode Daimond is in: `ask`, `guarded` or `bypass`.
///
/// See [`crate::tools::Mode`]. Read rather than remembered by the page, so a
/// control that failed to set one draws what is actually in force.
#[wasm_bindgen]
pub fn permission_mode() -> String {
    crate::tools::mode().name().to_string()
}

/// Did the command behind this tool result run with the network refused?
///
/// The user-facing half of a thing that had only ever had a model-facing one.  `Tool::run`
/// writes a note into the result so the MODEL knows why a fetch, install or clone failed and
/// does not report the project as broken; the person watching the build stop halfway was told
/// nothing at all, in any language, and learned the reason only if the model chose to relay a
/// bracketed English note written for itself.
///
/// Answered from the result rather than from the chat's state: the chat's state says what the
/// next command would get, and a line drawn under one command has to say what that one got.
///
/// # Arguments
/// * `result` - The tool result, as the page received it.
#[wasm_bindgen]
pub fn ran_without_net(result: &str) -> bool {
    crate::tools::ran_without_net(result)
}

/// Move to a permission mode, returning the one it replaced.
///
/// This is the ONLY way the mode moves. No tool reaches it, and nothing derived
/// from anything a model said reaches it: it is the user's own setting arriving
/// from their own control. A name this build does not know is REFUSED rather
/// than rounded to the nearest rung, and the mode is left exactly where it was
/// -- a page that cannot say what it wants keeps the guarded one it had.
///
/// # Arguments
/// * `name` - The mode's name, as `Mode::name` spells it.
#[wasm_bindgen]
pub fn set_permission_mode(name: String) -> Result<String, JsValue> {
    let m = match crate::tools::Mode::parse(&name) {
        Ok(m)  => m,
        Err(e) => return Err(crate::wasm::to_js_err(e)),
    };
    Ok(crate::tools::set_mode(m).name().to_string())
}

/// Probe the LLM transport: issue a real cross-origin `fetch` to
/// `base_url` with `api_key` and `model`, returning the HTTP status.
///
/// A `401` with a dummy key is success — it proves `fetch` + CORS + the
/// wasm transport path work end-to-end without a valid key.
#[wasm_bindgen]
pub async fn llm_probe(
    base_url: String,
    api_key:  String,
    model:    String,
) -> Result<u32, JsValue> {
    match run_llm_probe(&base_url, &api_key, &model).await {
        Ok(status) => Ok(status as u32),
        Err(e)     => Err(to_js_err(e)),
    }
}

/// Inner probe returning an [`Outcome`], so the transport path uses the
/// error macros throughout; the `#[wasm_bindgen]` wrapper maps the result
/// to the JS boundary.
async fn run_llm_probe(base_url: &str, api_key: &str, model: &str) -> Outcome<u16> {
    let (secure, host, port, path) = res!(parse_url(base_url));
    let client = LlmClient::new_with_scheme(
        &host, port, &path, api_key, model, PROBE_MAX_TOKENS, secure);
    let status = res!(client.probe_status().await);
    Ok(status)
}

/// Split a `scheme://host[:port]/path` URL into `(secure, host, port, path)`.
///
/// Both schemes are accepted, on the same terms as
/// [`crate::wasm::app`]'s `parse_base_url`: `https` for the real providers,
/// `http` for a local mock.  A probe that refused `http` would reject a base
/// URL the chat path goes on to accept.  The port defaults to the scheme's
/// own default when absent.
fn parse_url(url: &str) -> Outcome<(bool, String, u16, String)> {
    let (secure, default_port, rest) = if let Some(r) = url.strip_prefix("https://") {
        (true, 443u16, r)
    } else if let Some(r) = url.strip_prefix("http://") {
        (false, 80u16, r)
    } else {
        return Err(err!(
            "llm_probe: URL '{}' must start with http:// or https://.", url;
            Invalid, Input));
    };
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None    => (rest, "/"),
    };
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) => {
            let port = res!(p.parse::<u16>()
                .map_err(|e| err!(e, "llm_probe: bad port in '{}'.", url; Invalid, Input)));
            (h.to_string(), port)
        }
        None => (authority.to_string(), default_port),
    };
    if host.is_empty() {
        return Err(err!("llm_probe: empty host in '{}'.", url; Invalid, Input));
    }
    Ok((secure, host, port, path.to_string()))
}

/// What a role is told when the user has not written a prompt of their own.
///
/// The browser needs these for two jobs: composing the prompt of a chat or a
/// worker (both of which it constructs), and seeding `prompts/<role>.md` with
/// the real text the first time a user opens it to edit. Exporting them keeps
/// the one definition in [`crate::prompts`] rather than a copy in JavaScript,
/// where the wording would drift from what the model is actually sent.
///
/// An unknown role yields an empty string rather than an error: the caller is
/// building a prompt, and there is no useful half-measure to return.
#[wasm_bindgen]
pub fn default_prompt(role: &str) -> String {
    match crate::prompts::Role::parse(role) {
        Ok(r)  => r.default_prompt().to_string(),
        Err(_) => String::new(),
    }
}

/// A role's whole system prompt: the user's text (or the default, when it is
/// empty), plus the rules an edit cannot remove.
///
/// This is what the browser hands to a chat or a worker, so the composition is
/// done in the one place for every role rather than half here and half there.
#[wasm_bindgen]
pub fn compose_prompt(role: &str, text: &str) -> String {
    compose_prompt_for(role, text, "")
}

/// The same, for a page that knows which model will carry the request.
///
/// **Two of the notes are composed on the model** -- `VERIFY_NOTE` and `QUIET_NOTE`, each
/// measured to be worth its tokens on some models and not on others (see
/// `prompts::CONDITIONAL` and `dev/PROMPT_NOTES.md`).  A model this build has no measurement
/// for is given both, and so is the empty string, so a caller that does not know which client
/// will carry the request loses nothing by saying so.
///
/// Kept apart from [`compose_prompt`] rather than added as a third argument to it, because a
/// page that passed the WRONG model would drop a note the model needed -- and the failure of
/// an absent note is a lost turn, while the cost of a needless one is about a hundred tokens.
/// A caller with no model in hand should reach for the two-argument form and mean it.
///
/// # Arguments
/// * `model` - The model as the client is configured with it, in the provider's own spelling.
#[wasm_bindgen]
pub fn compose_prompt_for(role: &str, text: &str, model: &str) -> String {
    match crate::prompts::Role::parse(role) {
        Ok(r)  => r.compose_for(text, model),
        Err(_) => text.to_string(),
    }
}

/// The skills this build carries, one name per line, for the `/` menu to list beside the
/// workspace's own.
///
/// A shipped skill has no file, so the menu -- which lists a directory -- cannot see it, and a
/// command nobody can discover is a command nobody types. `skills::shipped_names` is the one
/// table both this and `open_command` read, so the menu cannot offer a name that then refuses.
#[wasm_bindgen]
pub fn shipped_skills() -> String {
    crate::skills::shipped_names().join("\n")
}

/// The subdirectory of a turn's own folder a drafted skill is written into.
///
/// The page lists it and the standing prompt names it, and neither carries its own spelling:
/// a menu looking in one directory while a daimon is told to write in another is a draft
/// nobody ever sees, and nothing anywhere would say so.
#[wasm_bindgen]
pub fn skill_drafts_dir() -> String {
    crate::skills::DRAFTS_DIR.to_string()
}

/// Where a drafted skill of `name` is installed, or empty for a name a `/name` could not reach.
///
/// **Empty is a refusal and must be treated as one.** `.daimond/` is a denied subtree, and this
/// is the one write into it the app makes -- at the person's own tap, and only ever at a path
/// composed here from a bare identifier.
///
/// # Arguments
/// * `name` - The skill's name, as it would be typed after the slash.
#[wasm_bindgen]
pub fn skill_install_path(name: &str) -> String {
    crate::skills::install_path(name)
}

/// Why this draft is not worth offering to install, or empty where it is.
///
/// # Arguments
/// * `name` - The name taken from the draft file's own stem.
/// * `text` - The draft file's whole text.
#[wasm_bindgen]
pub fn skill_draft_refusal(name: &str, text: &str) -> String {
    crate::skills::draft_refusal(name, text).unwrap_or_default()
}

/// The starter `DAIMOND.md` a store that has never held one is given, once.
///
/// The text lives in `prompts::INSTRUCTIONS_SEED` rather than in the page, for
/// `shipped_skills`'s reason: it is checked natively against the skills this build really
/// carries, so the file cannot tell a user to type a command that would refuse.
#[wasm_bindgen]
pub fn instructions_seed() -> String {
    crate::prompts::INSTRUCTIONS_SEED.to_string()
}

/// Tell this build what has been measured about which models need which notes.
///
/// The shipped table is right on the day it ships and a new model appears every few weeks, so
/// the findings are data rather than a release -- the same arrangement `set_locked_packs`
/// uses.  Empty text restores the shipped default rather than clearing the table.
///
/// # Arguments
/// * `text` - The table, in `prompts::NOTE_FINDINGS_SHIPPED`'s format: one model to a line,
///   `<model>: <NOTE> <NOTE>`, `#` opening a comment.
#[wasm_bindgen]
pub fn set_note_findings(text: &str) {
    crate::prompts::set_note_findings(text);
}

/// The findings table in force, which is the shipped one until a page replaces it.
///
/// Handed back as the text that is really running, so an operator console shows a person the
/// table rather than this build's opinion of it.
#[wasm_bindgen]
pub fn note_findings() -> String {
    crate::prompts::note_findings()
}

/// The rules appended to every tool-holding role, which a user's edit cannot
/// take away.  Shown above the editor so it is plain what is fixed and why.
#[wasm_bindgen]
pub fn safety_clause() -> String {
    crate::prompts::SAFETY_CLAUSE.to_string()
}

/// The tools this build gives a chat, as JSON: `[{"tool":…,"blurb":…,"pack":…}]`.
///
/// The Tools panel tells a user what Daimond can do, and the only honest source for that is
/// the registry the agent is actually handed -- a list written out again in JavaScript would
/// drift, and the first a user would know of it is a tool that does not work or one they never
/// knew they had.
///
/// `pack` is the catalogue key of the pack a tool is sold in, and empty for one Daimond ships
/// free.  It is here because the belt and the shop are no longer the same list: a tool with a
/// non-empty `pack` is priced by the gateway and listed by `/api/tools`, and a panel that also
/// showed it under "Built in" would be telling the user it was free.
#[wasm_bindgen]
pub fn builtin_tools() -> String {
    let items = crate::tools::Tool::browser()
        .iter()
        .map(|t| fmt!(
            r#"{{"tool":"{}","blurb":"{}","pack":"{}"}}"#,
            t.name(),
            crate::llm::json_escape(t.summary()),
            t.pack().unwrap_or(""),
        ))
        .collect::<Vec<String>>();
    fmt!("[{}]", items.join(","))
}

/// Tell this build which tool packs the account has not bought, comma separated.
///
/// The gateway is the authority -- `/api/tools` answers, per account, which unlocks are held --
/// and the page is the courier: it calls this after each read with the packs that came back
/// locked.  Nothing else calls it, and in particular nothing derived from anything a model said
/// does, exactly as with [`set_permission_mode`].
///
/// Passing an empty string locks nothing, which is what a device that has never reached the
/// gateway is left with.  See the section note in [`crate::tools`] for why that is the safe
/// default rather than the lax one.
///
/// # Arguments
/// * `csv` - The locked pack keys, as the gateway's catalogue spells them.
#[wasm_bindgen]
pub fn set_locked_packs(csv: String) {
    crate::tools::set_locked_packs(&csv);
}

/// Which packs this build currently holds locked, comma separated.
///
/// Read rather than remembered by the page, for the same reason [`permission_mode`] is: a caller
/// that failed to set one should see what is actually in force, not what it meant to set.
#[wasm_bindgen]
pub fn locked_packs() -> String {
    crate::tools::locked_packs().join(",")
}

/// Whether a named tool is sold in a pack this account has not bought.
///
/// The whole question in one call, so a caller in JavaScript holds NO copy of a pack key: it names
/// the tool it is about to run and is told whether it may.  The mapping from tool to pack and the
/// state of that pack both live in [`crate::tools`], which is also what
/// [`Tool::guard`](crate::tools::Tool::guard) consults -- so the human's Compile button and the
/// model's `typst_compile` cannot come to different conclusions about the same purchase.
///
/// A tool this build does not know, and a tool that is shipped free, both answer `false`: there is
/// nothing to have bought.
///
/// # Arguments
/// * `name` - The tool's stable name, as `Tool::name` spells it, e.g. `typst_compile`.
#[wasm_bindgen]
pub fn tool_locked(name: String) -> bool {
    match crate::tools::Tool::from_name(&name).and_then(|t| t.pack()) {
        Some(pack) => crate::tools::pack_locked(pack),
        None       => false,
    }
}


// ─────────────────────────────────────────────────────────────────────────────
// SIGNED ARTEFACTS: MESSAGES AND IDENTITY CARDS
// ─────────────────────────────────────────────────────────────────────────────
//
// A message and an identity card travel as SBJ artefacts: a signed envelope around a canonical
// payload, whose hash IS the artefact's address.  Everything below is the byte work -- canonical
// encoding, the SHA3-256 address, the envelope, the signing input, the assembled file -- and NONE
// of it is the signing.
//
// THE SEAM, AND WHY IT IS HERE.  The device signing key is a non-extractable WebCrypto `CryptoKey`
// held by `identity.js`.  It cannot be exported, so it cannot be handed to wasm, and that is a
// property worth keeping rather than a limitation to work around: a key that never crosses a
// module boundary cannot be leaked by anything on the other side of it.  So wasm hands out a
// SIGNING INPUT and takes a SIGNATURE back, and never sees a secret in either direction.
//
// The work is here rather than in JavaScript because the address function is SHA3-256, which
// WebCrypto does not implement, and because a canonical encoding written twice is a canonical
// encoding that will eventually disagree with itself -- and two encodings of one message are two
// addresses.

/// A message being composed, before it is encoded and signed.
///
/// A struct rather than one call with a dozen parameters, because a message may carry up to four
/// references and each of the four kinds is named differently.  Nothing here is signed or sealed;
/// this is a draft, and [`PostDraft::encode`] is where it becomes bytes.
#[wasm_bindgen]
pub struct PostDraft {
    /// The message under construction.
    inner: Post,
}

#[wasm_bindgen]
impl PostDraft {

    /// Start a message: its text, the recipient's public key, and this message's nonce.
    ///
    /// The nonce is the caller's, from `crypto.getRandomValues`, and it is signed: two identical
    /// messages to one recipient are two addresses rather than one message that appears to have
    /// been sent once.
    ///
    /// # Arguments
    /// * `body` - The message text.
    /// * `to` - The recipient's 32-byte public key.
    /// * `nonce` - 16 random bytes.
    #[wasm_bindgen(constructor)]
    pub fn new(body: String, to: Vec<u8>, nonce: Vec<u8>) -> PostDraft {
        PostDraft {
            inner: Post {
                body,
                to,
                nonce,
                reply_to: None,
                refs:     Vec::new(),
            },
        }
    }

    /// Say which message this one answers, by that message's address.
    #[wasm_bindgen(js_name = replyTo)]
    pub fn reply_to(&mut self, addr: Vec<u8>) {
        self.inner.reply_to = Some(addr);
    }

    /// Point at a proposal on a forge repository.
    #[wasm_bindgen(js_name = addProposal)]
    pub fn add_proposal(&mut self, account: String, repo: String, number: u32, fallback: String) {
        self.inner.refs.push(Reference {
            target: Target::Proposal { account, repo, number },
            fallback,
        });
    }

    /// Point at a release build.
    #[wasm_bindgen(js_name = addBuild)]
    pub fn add_build(&mut self, id: String, fallback: String) {
        self.inner.refs.push(Reference {
            target: Target::Build { id },
            fallback,
        });
    }

    /// Point at a panel in the reader's own client.
    #[wasm_bindgen(js_name = addPanel)]
    pub fn add_panel(&mut self, name: String, fallback: String) {
        self.inner.refs.push(Reference {
            target: Target::Panel { name },
            fallback,
        });
    }

    /// Point at a page of the in-app guide, optionally at an anchor within it.
    ///
    /// An empty anchor is an ABSENT anchor, not an empty one: an optional field encoded as present
    /// and empty would be a second encoding of the same message, and so a second address.
    #[wasm_bindgen(js_name = addGuide)]
    pub fn add_guide(&mut self, page: String, anchor: String, fallback: String) {
        self.inner.refs.push(Reference {
            target: Target::Guide {
                page,
                anchor: if anchor.is_empty() { None } else { Some(anchor) },
            },
            fallback,
        });
    }

    /// The canonical bytes of this message, which are what the address is taken over.
    ///
    /// Every rule the schema declares is enforced here, so a message that no reader would accept
    /// is never given a signature: an over-long body, a nonce of the wrong width, a fifth
    /// reference, a recipient key that is not 32 bytes.  The refusal names what was wrong.
    pub fn encode(&self) -> Result<Vec<u8>, JsValue> {
        self.inner.encode().map_err(to_js_err)
    }
}

/// A share being composed, before it is encoded and signed.
///
/// A struct rather than one call, because a share carries a list of files and each is handed over
/// with its own bytes.  Nothing here is signed or sealed; this is a draft, and
/// [`ShareDraft::encode`] is where it becomes bytes.
///
/// **A share is a COPY the receiver comes to own.**  It is re-sealed to their key by the caller,
/// it lands in their workspace as theirs, and neither side sees the other's changes to it
/// afterwards.  There is no live view here to keep in step and nothing to revoke.
#[wasm_bindgen]
pub struct ShareDraft {
    /// The display name of the thing being shared.
    name:  String,
    /// The recipient's 32-byte public key.
    to:    Vec<u8>,
    /// This share's 16 random bytes.
    nonce: Vec<u8>,
    /// The sender's covering sentence, if they wrote one.
    note:  Option<String>,
    /// The files, in whatever order the caller added them.  `encode` puts them in path order.
    files: Vec<share::File>,
}

#[wasm_bindgen]
impl ShareDraft {

    /// Start a share: the display name, the recipient's public key, and this share's nonce.
    ///
    /// # Arguments
    /// * `name` - The display name of the thing being shared.  Advisory, and never an identity.
    /// * `to` - The recipient's 32-byte public key.
    /// * `nonce` - 16 random bytes, from `crypto.getRandomValues`.
    #[wasm_bindgen(constructor)]
    pub fn new(name: String, to: Vec<u8>, nonce: Vec<u8>) -> ShareDraft {
        ShareDraft { name, to, nonce, note: None, files: Vec::new() }
    }

    /// Say a covering sentence.  An empty one is an ABSENT one, never an empty field.
    pub fn note(&mut self, text: String) {
        self.note = if text.is_empty() { None } else { Some(text) };
    }

    /// Add one file: where it goes in the receiver's copy, and what is in it.
    ///
    /// The path is checked when the share is encoded, not here, so that a caller adding a folder
    /// of files is told once what is wrong with it rather than having to catch each addition.
    #[wasm_bindgen(js_name = addFile)]
    pub fn add_file(&mut self, path: String, body: Vec<u8>) {
        self.files.push(share::File { path, body });
    }

    /// Whether what has been added so far carries a program.
    ///
    /// For the sender's own screen, so that "this includes a page they will be asked to accept"
    /// can be said BEFORE anything is signed.  It is the same rule the payload's `code` bit is
    /// computed from, asked of the same crate, so the sentence a sender reads and the claim their
    /// signature carries cannot disagree.
    #[wasm_bindgen(js_name = carriesCode)]
    pub fn carries_code(&self) -> bool {
        share::code_file(&self.files).is_some()
    }

    /// The canonical bytes of this share, which are what the address is taken over.
    ///
    /// Every rule the schema declares is enforced here, so a share no reader would accept is never
    /// given a signature: a path that walks out of the Diamond, a path under the sender's own
    /// `.daimond/` record, a capp delivery record, a duplicate path, too many files, too many
    /// bytes.  The refusal names what was wrong.
    pub fn encode(&self) -> Result<Vec<u8>, JsValue> {
        // `plain` rather than `to_js_err`, for the reason [`sbj_read`] gives: `Display` carries
        // ANSI colour, which is rubbish on a screen rather than colour on it, and names a file and
        // a line nobody being told why their share was refused wants to read.
        Share::new(
            self.name.clone(),
            self.to.clone(),
            self.nonce.clone(),
            self.note.clone(),
            self.files.clone(),
        ).encode().map_err(|e| JsValue::from_str(&e.plain()))
    }
}

/// A share that has been verified, so that its files can be taken out one at a time.
///
/// [`sbj_read`] says what an artefact IS, in JSON, and a share's file bodies have no business in a
/// JSON string: they are bytes, they may be a megabyte of them, and hexadecimal would double that
/// on the way through.  So the generic reader names a share and lists its paths, and a caller that
/// means to open one asks here and takes the bodies as bytes.
///
/// Holding one *is* holding an artefact whose header, envelope, hash, signature, canonical
/// encoding and schema all checked out: [`share_read`] is the only way to obtain one.
#[wasm_bindgen]
pub struct ShareRead {
    /// The verified payload.
    inner:  Share,
    /// The author of the artefact, which is the SENDER's signing key.
    author: Vec<u8>,
    /// The artefact's address.
    addr:   Vec<u8>,
    /// The envelope's time, in Unix milliseconds.
    time:   u64,
}

#[wasm_bindgen]
impl ShareRead {

    /// The display name the sender gave what they sent.  Advisory.
    pub fn name(&self) -> String {
        self.inner.name.clone()
    }

    /// Whether the sender marked this share as carrying a program.
    ///
    /// **The claim is the sender's and the signature covers it.**  A relay carrying this artefact
    /// cannot set it, clear it, or reach it at all without the signature ceasing to verify, which
    /// is the only reason it is worth showing a person.
    pub fn code(&self) -> bool {
        self.inner.code
    }

    /// The sender's covering sentence, or an empty string where they wrote none.
    pub fn note(&self) -> String {
        self.inner.note.clone().unwrap_or_default()
    }

    /// The key this share was addressed to, which the caller must check is their own.
    pub fn to(&self) -> Vec<u8> {
        self.inner.to.clone()
    }

    /// The sender's signing key.
    pub fn author(&self) -> Vec<u8> {
        self.author.clone()
    }

    /// The artefact's address, as lowercase hexadecimal.
    pub fn address(&self) -> String {
        to_hex(&self.addr)
    }

    /// When the sender says they signed it, in Unix milliseconds.  Advisory: it is a clock nobody
    /// else can check.
    pub fn time(&self) -> f64 {
        self.time as f64
    }

    /// How many files the share carries.
    pub fn count(&self) -> usize {
        self.inner.files.len()
    }

    /// The path of file `i`, or an empty string where there is no such file.
    pub fn path(&self, i: usize) -> String {
        self.inner.files.get(i).map(|f| f.path.clone()).unwrap_or_default()
    }

    /// The bytes of file `i`, or nothing where there is no such file.
    pub fn body(&self, i: usize) -> Vec<u8> {
        self.inner.files.get(i).map(|f| f.body.clone()).unwrap_or_default()
    }

    /// Whether file `i` is one this build considers code.
    ///
    /// Asked per file so that the receiving side can name what it is asking them to accept, rather
    /// than saying "this contains code somewhere".
    #[wasm_bindgen(js_name = isCode)]
    pub fn is_code(&self, i: usize) -> bool {
        self.inner.files.get(i).map(|f| share::is_code_path(&f.path)).unwrap_or(false)
    }
}

/// Verify an artefact and take it apart as a share.
///
/// Everything [`sbj_read`] does, and then the payload as bytes rather than as JSON.  An artefact
/// that is not a share is refused by name rather than read as the nearest thing: a caller that
/// asked to open a share and was handed a message must be told so.
#[wasm_bindgen]
pub fn share_read(bytes: &[u8]) -> Result<ShareRead, JsValue> {
    let art = match doc::read_artefact(bytes) {
        Ok(a)  => a,
        Err(e) => return Err(JsValue::from_str(&e.plain())),
    };
    let (env, payload) = art.into_parts();
    match payload {
        Payload::Share(s) => Ok(ShareRead {
            inner:  s,
            author: env.author,
            addr:   env.hash,
            time:   env.time,
        }),
        other => Err(JsValue::from_str(&fmt!(
            "That is not a share; it declares the schema '{}'.", other.schema()))),
    }
}

/// The canonical bytes of an identity card: what a QR code and a paste carry.
///
/// A bare public key says nothing about which key seals and which signs, carries no label, and
/// gives a reader no way to tell a first key from one that replaced another.  This says all three.
/// The signing key is not a field here: it is the envelope's `author`, so a card has exactly one
/// place that says which key composed it.
///
/// # Arguments
/// * `label` - The display name the holder chose.  Advisory, and never an identity.
/// * `enc` - The holder's 32-byte encryption subkey, which is not the signing key.
/// * `prev` - The 32-byte key this one supersedes, or empty for a first card.
#[wasm_bindgen]
pub fn card_encode(label: String, enc: Vec<u8>, prev: Vec<u8>) -> Result<Vec<u8>, JsValue> {
    let card = Card {
        label,
        enc,
        // The only role v0 admits.  A second one would be a versioned act rather than a new string
        // appearing on the wire, which is why this is not a parameter.
        role: Role::Root,
        prev: if prev.is_empty() { None } else { Some(prev) },
    };
    card.encode().map_err(to_js_err)
}

/// The address of a payload: the SHA3-256 digest its envelope will declare.
///
/// Here rather than in JavaScript because WebCrypto offers SHA-1, SHA-256, SHA-384 and SHA-512 and
/// no SHA-3 at all.  A caller may show an address before anything is signed, since the address is
/// a property of the payload alone.
#[wasm_bindgen]
pub fn sbj_address(payload: &[u8]) -> Result<Vec<u8>, JsValue> {
    doc::hash_tree(envelope::HASH_SCHEME_SHA3_256, payload).map_err(to_js_err)
}

/// The bytes the device key must sign for this payload to become an artefact.
///
/// Half of the seam: the envelope is built here, its signing input handed out, and the secret that
/// signs it stays where it is.  The envelope is a pure function of these four arguments, which is
/// what makes the seam safe to cross -- [`sbj_assemble`] rebuilds the same envelope from the same
/// arguments, so a caller cannot sign one envelope and assemble a different one.
///
/// # Arguments
/// * `payload` - The canonical payload bytes.
/// * `schema` - The payload's schema, e.g. `daimond/post/0`.
/// * `author` - The signer's 32-byte Ed25519 public key.
/// * `time` - Unix milliseconds, as `Date.now()` gives them.  A `f64` rather than a `u64` because
///   a `u64` crosses to JavaScript as a `BigInt`, which every caller would then have to build.
#[wasm_bindgen]
pub fn sbj_signing_input(
    payload: &[u8],
    schema:  String,
    author:  &[u8],
    time:    f64,
)
    -> Result<Vec<u8>, JsValue>
{
    let env = match doc::envelope_for(payload, &schema, author, time as u64) {
        Ok(e)  => e,
        Err(e) => return Err(to_js_err(e)),
    };
    Ok(env.signing_input())
}

/// The finished artefact: header, envelope, payload, with the signature the caller brings back.
///
/// The other half of the seam.  The signature is not checked here, because what makes an artefact
/// sound is that a reader accepts it and nothing else; a signature that does not verify produces a
/// file that every reader refuses, including this one.
///
/// # Arguments
/// * `payload` - The same bytes handed to [`sbj_signing_input`].
/// * `schema` - The same schema.
/// * `author` - The same public key.
/// * `time` - The same time.  A different one gives a different envelope and a signature over
///   nothing.
/// * `sig` - The 64-byte Ed25519 signature over the signing input.
#[wasm_bindgen]
pub fn sbj_assemble(
    payload: &[u8],
    schema:  String,
    author:  &[u8],
    time:    f64,
    sig:     Vec<u8>,
)
    -> Result<Vec<u8>, JsValue>
{
    let mut env = match doc::envelope_for(payload, &schema, author, time as u64) {
        Ok(e)  => e,
        Err(e) => return Err(to_js_err(e)),
    };
    env.sig = sig;
    doc::assemble(&env, payload).map_err(to_js_err)
}

/// A short rendering of a key, for a person's eye.  **It decides nothing.**
///
/// Eighty bits of `SHA-256(domain ‖ key)` in Crockford base 32, in four groups of four.  Equality
/// is always the full 32-byte key, everywhere, without exception: eighty bits is well within reach
/// of somebody who wants two keys to look alike in a list, and anything that COMPARED fingerprints
/// to decide whether two keys are the same would be a defect.
///
/// One implementation, in the format's own crate, called from here.  Two renderings of one key
/// would eventually differ on a key nobody had tested, and a user would read that as their
/// correspondent's key having changed.
#[wasm_bindgen]
pub fn identity_fingerprint(key: &[u8]) -> String {
    card::fingerprint(key)
}

/// The number two people read to each other to check they hold each other's real keys.
///
/// Sixty decimal digits in twelve groups of five, over both keys sorted, so both parties compute
/// the same number without having to agree who is first.
///
/// It is read over a channel an attacker cannot silently rewrite -- a voice call, or in person.
/// Read over the same channel the keys arrived on it proves nothing, since whatever substituted
/// the keys can substitute the number.
#[wasm_bindgen]
pub fn identity_safety_number(a: &[u8], b: &[u8]) -> String {
    card::safety_number(a, b)
}

/// Verify an artefact and say what it turned out to be, as JSON.
///
/// THE READER CHECKS, AND NOBODY ELSE.  A signature exists so that the person receiving a message
/// can check who wrote it; if a server checked it and handed over a tidy result, the recipient
/// would have learned only that the server says so, and the signature might as well not be there.
/// So the whole verification runs here, on the recipient's own device: magic, envelope, tree
/// length, address, signature, and only then is a byte of the payload decoded.
///
/// What crosses back has passed every one of those.  A failure crosses as the words of the error
/// and nothing else -- not the file and line, which is the developer's business and not the
/// reader's.
///
/// JSON rather than markup, and read into the DOM with `textContent` rather than `innerHTML`: a
/// format whose whole claim is that a message cannot carry code must not have its own reader
/// building HTML by string concatenation.
///
/// # Arguments
/// * `bytes` - The whole artefact, header included.
#[wasm_bindgen]
pub fn sbj_read(bytes: &[u8]) -> Result<String, JsValue> {
    let art = match doc::read_artefact(bytes) {
        Ok(a)  => a,
        // `plain` is the words of the error. `Display` carries ANSI colour, which is rubbish on a
        // screen rather than colour on it, and `Debug` names a file and a line nobody reading a
        // message wants.
        Err(e) => return Err(JsValue::from_str(&e.plain())),
    };
    let (env, payload) = art.into_parts();
    let mut out = String::with_capacity(512);
    out.push('{');
    out.push_str(&fmt!("\"schema\":{},", json_str(&env.schema)));
    out.push_str(&fmt!("\"author\":{},", json_str(&to_hex(&env.author))));
    out.push_str(&fmt!("\"address\":{},", json_str(&to_hex(&env.hash))));
    // A `f64` because the time crosses to JavaScript, where every number is one, and a `u64`
    // written into JSON as an integer past 2^53 would be read back changed. A Unix millisecond is
    // nowhere near that, so this is exact.
    out.push_str(&fmt!("\"time\":{},", env.time as f64));
    out.push_str(&fmt!("\"fingerprint\":{},", json_str(&card::fingerprint(&env.author))));
    match payload {
        Payload::Card(c) => {
            out.push_str("\"kind\":\"card\",\"card\":{");
            out.push_str(&fmt!("\"label\":{},", json_str(&c.label)));
            out.push_str(&fmt!("\"enc\":{},", json_str(&to_hex(&c.enc))));
            out.push_str(&fmt!("\"role\":{}", json_str(c.role.as_str())));
            match &c.prev {
                Some(p) => out.push_str(&fmt!(",\"prev\":{}", json_str(&to_hex(p)))),
                None    => {},
            }
            out.push('}');
        },
        Payload::Post(p) => {
            out.push_str("\"kind\":\"post\",\"post\":{");
            out.push_str(&fmt!("\"body\":{},", json_str(&p.body)));
            out.push_str(&fmt!("\"to\":{},", json_str(&to_hex(&p.to))));
            out.push_str(&fmt!("\"nonce\":{}", json_str(&to_hex(&p.nonce))));
            match &p.reply_to {
                Some(a) => out.push_str(&fmt!(",\"replyTo\":{}", json_str(&to_hex(a)))),
                None    => {},
            }
            if !p.refs.is_empty() {
                out.push_str(",\"refs\":[");
                for (i, r) in p.refs.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    out.push_str(&fmt!("{{\"kind\":{},\"fallback\":{}}}",
                        json_str(r.target.key()), json_str(&r.fallback)));
                }
                out.push(']');
            }
            out.push('}');
        },
        Payload::Share(s) => {
            // The file BODIES are deliberately absent: they are bytes, there may be a great many
            // of them, and hexadecimal through a JSON string would double that on the way. This
            // says what the artefact is and what it would write; `share_read` hands over the
            // bytes.
            out.push_str("\"kind\":\"share\",\"share\":{");
            out.push_str(&fmt!("\"name\":{},", json_str(&s.name)));
            out.push_str(&fmt!("\"to\":{},", json_str(&to_hex(&s.to))));
            out.push_str(&fmt!("\"nonce\":{},", json_str(&to_hex(&s.nonce))));
            // The sender's signed claim about whether any of this is a program. It is reported
            // whether it is true or false, because a receiver being told nothing and a receiver
            // being told "no code" must not look the same on this side either.
            out.push_str(&fmt!("\"code\":{},", s.code));
            if let Some(n) = &s.note {
                out.push_str(&fmt!("\"note\":{},", json_str(n)));
            }
            out.push_str("\"files\":[");
            for (i, f) in s.files.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&fmt!("{{\"path\":{},\"bytes\":{},\"code\":{}}}",
                    json_str(&f.path), f.body.len(), share::is_code_path(&f.path)));
            }
            out.push_str("]}");
        },
        // A node tree is an oxeweb document, which this app has no renderer for. Named rather than
        // guessed at: a reader that quietly returned nothing would look like a verification
        // failure, which this is not.
        Payload::Tree { .. } => out.push_str("\"kind\":\"tree\""),
    }
    out.push('}');
    Ok(out)
}

/// Bytes as lowercase hexadecimal, which is how they cross to JavaScript: JSON has no byte string.
fn to_hex(b: &[u8]) -> String {
    let mut s = String::with_capacity(b.len() * 2);
    for byte in b {
        s.push_str(&fmt!("{:02x}", byte));
    }
    s
}

/// A string as a JSON string literal, with everything JSON requires escaped.
///
/// The reader builds its DOM with `textContent`, so an escape missed here could not become a
/// script. This is the belt; that is the braces.
fn json_str(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"'  => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0C}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => out.push_str(&fmt!("\\u{:04x}", c as u32)),
            c    => out.push(c),
        }
    }
    out.push('"');
    out
}
