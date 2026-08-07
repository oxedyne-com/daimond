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
use crate::wasm::{opfs, to_js_err};

use oxedyne_fe2o3_graphics::qr::{
    encode,
    QrEcc,
};

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
    match crate::prompts::Role::parse(role) {
        Ok(r)  => r.compose(text),
        Err(_) => text.to_string(),
    }
}

/// The rules appended to every tool-holding role, which a user's edit cannot
/// take away.  Shown above the editor so it is plain what is fixed and why.
#[wasm_bindgen]
pub fn safety_clause() -> String {
    crate::prompts::SAFETY_CLAUSE.to_string()
}

/// The tools this build gives a chat, as JSON: `[{"tool":…,"blurb":…}]`.
///
/// The Tools panel tells a user what Daimond can do, and the only honest source for that is
/// the registry the agent is actually handed -- a list written out again in JavaScript would
/// drift, and the first a user would know of it is a tool that does not work or one they never
/// knew they had.
#[wasm_bindgen]
pub fn builtin_tools() -> String {
    let items = crate::tools::Tool::browser()
        .iter()
        .map(|t| fmt!(
            r#"{{"tool":"{}","blurb":"{}"}}"#,
            t.name(),
            crate::llm::json_escape(t.summary()),
        ))
        .collect::<Vec<String>>();
    fmt!("[{}]", items.join(","))
}
