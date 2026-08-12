//! The Typst compiler edge — thin bindings to the JS driver `window.DaimondTypst`.
//!
//! The compiler itself is a 30 MB wasm module vendored under `www/vendor/typst`
//! and driven from `www/js/typst.js`.  It is reached the same way the Web panel
//! is: one object on `window`, one method, and a `Promise` awaited here.
//!
//! The division of labour matters.  This side does BYTES ONLY: the source text
//! goes out, PDF bytes come back, and every file touch -- reading the `.typ`,
//! writing the `.pdf` -- happens in Rust through [`crate::wasm::opfs`], so the
//! path jail, the per-account namespace and the real-folder override all apply.
//! The driver never learns a path.
//!
//! A driver that cannot load the compiler resolves with `{ error }` rather than
//! rejecting, so the wording the page already owns (`typst.load_failed`,
//! `typst.no_pdf`, `typst.compile_error`) reaches the model verbatim as the
//! reason the compile failed.
//!
//! # A book is not a file
//!
//! Until this module grew a gatherer, exactly one string went to the compiler and
//! the shadow filesystem was wiped before every compile, so `#import "template.typ"`
//! on line one of a real book could never resolve.  What came back was typst's
//! dummy-access-model message -- *cannot read file outside of project root, you can
//! adjust the project root with the --root argument* -- which is what that model
//! says about ANY path it cannot reach.  It reads like a settings problem with an
//! obvious fix, and in a real session it sent a daimon hunting for out-of-bounds
//! images that were never the problem.  A wrong message bought a wrong diagnosis.
//!
//! So [`gather`] builds the project here, in Rust, and hands the driver CONTENTS.
//! The paths that cross the boundary are virtual: they are positions inside the
//! compiler's in-memory shadow filesystem, rooted at `/`, and there is nothing at
//! the far end that could read one even if it wanted to.  Every byte the compiler
//! sees was read on this side, through [`crate::wasm::opfs`], under the same jail
//! as every other file the app touches.

use crate::tools::FileRoot;
use crate::wasm::{js_str, opfs};

use oxedyne_fe2o3_core::prelude::*;

use wasm_bindgen::prelude::wasm_bindgen;
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;


#[wasm_bindgen]
extern "C" {

    /// The driver object `www/js/typst.js` installs at `window.DaimondTypst`.
    #[wasm_bindgen(js_name = DaimondTypst)]
    type Driver;

    /// Compile a Typst source string, resolving `{ pdf }` or `{ error }`.
    #[wasm_bindgen(method)]
    fn compile(this: &Driver, source: &str) -> js_sys::Promise;

    /// Compile a gathered project, resolving `{ pdf }` or `{ error }`.
    #[wasm_bindgen(method, js_name = compileProject)]
    fn compile_project(this: &Driver, project: &JsValue) -> js_sys::Promise;
}


// ── Bounds ──────────────────────────────────────────────────────────────────
//
// A walk that follows whatever it finds is how a turn hung today.  Every limit
// below is a REFUSAL, not a truncation: a project gathered up to a cap and then
// compiled would produce a PDF missing a chapter, and the author would proofread
// it without ever being told.  Silence is the failure mode worth engineering
// against, so hitting any of these stops the compile and says which one it was.

/// The most files -- sources and assets together -- one project may gather.
const MAX_FILES: usize = 500;

/// The most bytes those files may come to, in total.
const MAX_BYTES: usize = 48 * 1024 * 1024;

/// The most font files one project may load.
const MAX_FONTS: usize = 48;

/// The most bytes those fonts may come to.
const MAX_FONT_BYTES: usize = 24 * 1024 * 1024;

/// How far above the main file's own directory the project root may be placed.
///
/// The author's book sits one level down and reaches one level up, so the true
/// root is the parent; four levels is room for a deeper tree without turning a
/// stray `"../../../../etc"` in prose into a walk of the whole workspace.
const MAX_UP: usize = 4;

/// How deep a font directory is searched.
const MAX_FONT_DEPTH: usize = 3;

/// How many directories a font search may open.
const MAX_FONT_DIRS: usize = 64;

/// Extensions the compiler can be handed as bytes and a source can name.
///
/// `.pdf` is deliberately absent: typst cannot place one, and a book directory
/// usually holds the last build, which would be the largest thing gathered and
/// the least use.
const ASSET_EXTS: &[&str] = &[
    "svg", "png", "jpg", "jpeg", "gif", "webp",
    "bib", "csv", "json", "yaml", "yml", "toml", "xml", "txt",
];

/// Extensions a font file carries.
const FONT_EXTS: &[&str] = &["ttf", "otf", "ttc", "otc"];

/// Directories searched for fonts, relative to the project root, mirroring what
/// `typst --font-path` is usually pointed at.
const FONT_DIRS: &[&str] = &["assets/fonts", "fonts"];


// ── Paths ───────────────────────────────────────────────────────────────────

/// Collapse `.` and `..` in a slash path.
///
/// `None` when the path climbs above the top, which for a workspace path means
/// out of the folder the user attached -- a condition worth a sentence of its
/// own rather than a silent clamp to the root.
fn norm(path: &str) -> Option<String> {
    let mut out: Vec<&str> = Vec::new();
    for seg in path.split('/') {
        match seg {
            "" | "." => {},
            ".."     => { if out.pop().is_none() { return None; } },
            s        => out.push(s),
        }
    }
    Some(out.join("/"))
}

/// The directory part of a slash path, or the empty string at the top.
fn parent(path: &str) -> String {
    match path.rfind('/') {
        Some(i) => path[..i].to_string(),
        None    => String::new(),
    }
}

/// Resolve `rel` against directory `dir`, both workspace-relative.
fn join(dir: &str, rel: &str) -> Option<String> {
    if dir.is_empty() { norm(rel) } else { norm(&fmt!("{}/{}", dir, rel)) }
}

/// The lower-case extension of a path, without the dot.
fn ext(path: &str) -> String {
    let name = match path.rfind('/') {
        Some(i) => &path[i + 1..],
        None    => path,
    };
    match name.rfind('.') {
        Some(i) => name[i + 1..].to_ascii_lowercase(),
        None    => String::new(),
    }
}

/// The deepest directory that contains every path in `paths`.
fn common_dir(paths: &[String]) -> String {
    let mut common: Option<Vec<String>> = None;
    for p in paths {
        let dir = parent(p);
        let segs: Vec<String> = if dir.is_empty() {
            Vec::new()
        } else {
            dir.split('/').map(|s| s.to_string()).collect()
        };
        common = Some(match common {
            None    => segs,
            Some(c) => {
                let n = c.iter().zip(segs.iter()).take_while(|(a, b)| a == b).count();
                c[..n].to_vec()
            },
        });
    }
    common.unwrap_or_default().join("/")
}

/// Express `path` relative to `root`, as the compiler's shadow filesystem wants
/// it: rooted at `/`, because that is where this build puts the project root.
fn under_root(root: &str, path: &str) -> Option<String> {
    if root.is_empty() {
        return Some(fmt!("/{}", path));
    }
    if path == root {
        return Some("/".to_string());
    }
    let pre = fmt!("{}/", root);
    path.strip_prefix(&pre).map(|r| fmt!("/{}", r))
}


// ── Reading a source for what it names ──────────────────────────────────────

/// Every double-quoted literal in `src`, with the byte offset it begins at.
///
/// Typst strings are double-quoted with backslash escapes, and a line comment
/// or a raw block may hold something that looks like one.  Over-reading is safe
/// here: a literal that names nothing resolves to no file and is dropped, and
/// the only cost of a false one is a lookup that finds nothing.
fn literals(src: &str) -> Vec<(usize, String)> {
    let b = src.as_bytes();
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < b.len() {
        if b[i] != b'"' { i += 1; continue; }
        let start = i;
        i += 1;
        let mut val = String::new();
        while i < b.len() && b[i] != b'"' {
            if b[i] == b'\\' && i + 1 < b.len() {
                // Only the separator matters for a path, so an escape is taken
                // literally rather than decoded.
                val.push(b[i + 1] as char);
                i += 2;
                continue;
            }
            if b[i] == b'\n' { break; }
            val.push(b[i] as char);
            i += 1;
        }
        if i < b.len() && b[i] == b'"' {
            out.push((start, val));
            i += 1;
        } else {
            i = start + 1;
        }
    }
    out
}

/// Whether a literal looks like a path this compiler could be handed.
fn is_path_ref(s: &str) -> bool {
    let e = ext(s);
    e == "typ" || ASSET_EXTS.contains(&e.as_str()) || FONT_EXTS.contains(&e.as_str())
}

// ── The gathered project ────────────────────────────────────────────────────

/// A project, read on this side and ready to hand across as contents.
struct Project {
    /// Workspace-relative directory that becomes the compiler's project root.
    root:      String,
    /// The file to compile, as a shadow path under that root.
    main:      String,
    /// `.typ` files, as (shadow path, text).
    sources:   Vec<(String, String)>,
    /// Everything else the sources name, as (shadow path, bytes).
    assets:    Vec<(String, Vec<u8>)>,
    /// Font files, as (workspace path, bytes).  Fonts live in the compiler's
    /// font book, not its filesystem, so they carry no shadow path.
    fonts:     Vec<(String, Vec<u8>)>,
    /// Where fonts were looked for, so a refusal can say where to put one.
    font_dirs: Vec<String>,
}

/// Read a file as text, or `None` when it is not there.
async fn read_text(root: FileRoot, path: &str) -> Option<String> {
    match opfs::read_file(root, path).await {
        Ok(b)  => Some(String::from_utf8_lossy(&b).to_string()),
        Err(_) => None,
    }
}

/// Gather the project `main_rel` belongs to.
///
/// Three phases, in this order because each needs the one before it:
///
/// 1. The source closure, followed through relative references only, in
///    workspace paths.  Relative references are the ones that can be resolved
///    without knowing the root.
/// 2. The root, taken as the deepest directory containing every source found.
///    That is exactly what `typst --root` is passed on the command line, and it
///    is why `../style/glossary_index.typ` resolves here as it does there.
/// 3. The assets, now that `/assets/…` means something, plus the fonts.
///
/// # Arguments
/// * `root` - Which filesystem root the workspace path is under.
/// * `main_rel` - Workspace-relative path of the `.typ` file to compile.
async fn gather(root: FileRoot, main_rel: &str) -> Outcome<Project> {
    let main = res!(norm(main_rel).ok_or_else(|| err!(
        "'{}' climbs above the workspace, so there is no file there to compile.", main_rel;
        Invalid, Input, Path)));
    let main_text = res!(read_text(root, &main).await.ok_or_else(|| err!(
        "There is no file at '{}' to compile.", main; Invalid, Input, Missing)));

    // ── Phase 1: the source closure ──────────────────────────────────────
    let mut srcs: Vec<(String, String)> = vec![(main.clone(), main_text)];
    let mut queue: Vec<usize> = vec![0];
    let mut escaped: Vec<(String, String)> = Vec::new();
    let mut bytes: usize = srcs[0].1.len();
    while let Some(idx) = queue.pop() {
        let (from, text) = (srcs[idx].0.clone(), srcs[idx].1.clone());
        let dir = parent(&from);
        for (_, lit) in literals(&text) {
            // A package import (`@preview/cetz:0.3.4`) names nothing on disk, and this
            // build has no registry to resolve it with.  It is left alone here and
            // explained by the driver from typst's own diagnostic, which names the file
            // and the line -- better than a list gathered up front could.
            if lit.starts_with('@') { continue; }
            if ext(&lit) != "typ" || lit.starts_with('/') { continue; }
            let path = match join(&dir, &lit) {
                Some(p) => p,
                None    => {
                    // A climb out of the attached folder, which is the shape of
                    // "the folder attached was one level too deep".
                    if !escaped.iter().any(|(_, r)| *r == lit) {
                        escaped.push((from.clone(), lit.clone()));
                    }
                    continue;
                },
            };
            if srcs.iter().any(|(p, _)| *p == path) { continue; }
            let text = match read_text(root, &path).await { Some(t) => t, None => continue };
            bytes += text.len();
            if bytes > MAX_BYTES {
                return Err(err!(
                    "This project's source files come to more than {} MB, which is past the \
                    limit this compiler gathers. Nothing was compiled rather than something \
                    incomplete.", MAX_BYTES / (1024 * 1024);
                    Invalid, Input, Size));
            }
            srcs.push((path, text));
            if srcs.len() > MAX_FILES {
                return Err(err!(
                    "This project reaches more than {} source files, which is past the limit \
                    this compiler gathers. Nothing was compiled -- a project cut off at a limit \
                    would have produced a PDF missing whatever fell outside it, and said nothing. \
                    Compile a smaller part of it, or attach a narrower folder.", MAX_FILES;
                    Invalid, Input, Size));
            }
            queue.push(srcs.len() - 1);
        }
    }
    if !escaped.is_empty() {
        let (from, lit) = escaped[0].clone();
        return Err(err!(
            "'{}' imports '{}', which is above the folder open in the workspace. \
            The compiler is given the files of one project and its root is the folder those \
            files sit in, so nothing above that folder exists as far as it is concerned. \
            Open or attach the PARENT folder -- the one that holds both '{}' and what it \
            reaches for -- and compile the same file from there.",
            from, lit, parent(&from);
            Invalid, Input, Path));
    }

    // ── Phase 2: the root ────────────────────────────────────────────────
    let paths: Vec<String> = srcs.iter().map(|(p, _)| p.clone()).collect();
    let mut proj_root = common_dir(&paths);
    // An absolute reference is root-relative, so the root has to be a directory
    // that actually holds its first segment.  When it does not, the project sits
    // deeper than its own root -- climb, up to the cap, and say so if it fails.
    let mut abs_first: Vec<String> = Vec::new();
    for (_, text) in srcs.iter() {
        for (_, lit) in literals(text) {
            if !lit.starts_with('/') || !is_path_ref(&lit) { continue; }
            let seg = lit.trim_start_matches('/').split('/').next().unwrap_or("").to_string();
            if !seg.is_empty() && !abs_first.contains(&seg) { abs_first.push(seg); }
        }
    }
    for seg in abs_first.iter() {
        let mut cand = proj_root.clone();
        let mut up = 0usize;
        loop {
            let probe = if cand.is_empty() { seg.clone() } else { fmt!("{}/{}", cand, seg) };
            if opfs::exists(root, &probe).await.unwrap_or(false) {
                proj_root = cand;
                break;
            }
            // Nothing above the workspace root exists, and four levels is the cap:
            // a stray "/usr/share" in prose must not turn into a walk upward.
            if cand.is_empty() || up >= MAX_UP { break; }
            cand = parent(&cand);
            up += 1;
        }
    }
    let main_shadow = res!(under_root(&proj_root, &main).ok_or_else(|| err!(
        "The project root worked out as '{}', which does not contain '{}'.", proj_root, main;
        Invalid, Input, Path)));

    // ── Phase 3: assets ──────────────────────────────────────────────────
    let mut assets: Vec<(String, Vec<u8>)> = Vec::new();
    for (from, text) in srcs.iter() {
        let dir = parent(from);
        for (_, lit) in literals(text) {
            let e = ext(&lit);
            if !ASSET_EXTS.contains(&e.as_str()) { continue; }
            let path = if let Some(rel) = lit.strip_prefix('/') {
                match join(&proj_root, rel) { Some(p) => p, None => continue }
            } else {
                match join(&dir, &lit) { Some(p) => p, None => continue }
            };
            let shadow = match under_root(&proj_root, &path) { Some(s) => s, None => continue };
            if assets.iter().any(|(p, _)| *p == shadow) { continue; }
            let data = match opfs::read_file(root, &path).await { Ok(d) => d, Err(_) => continue };
            bytes += data.len();
            if bytes > MAX_BYTES {
                return Err(err!(
                    "This project's files come to more than {} MB, which is past the limit this \
                    compiler gathers. Nothing was compiled, because a project cut short would \
                    have produced a PDF with pictures missing and no warning that they were.",
                    MAX_BYTES / (1024 * 1024);
                    Invalid, Input, Size));
            }
            assets.push((shadow, data));
            if srcs.len() + assets.len() > MAX_FILES {
                return Err(err!(
                    "This project reaches more than {} files, which is past the limit this \
                    compiler gathers. Nothing was compiled rather than something incomplete.",
                    MAX_FILES; Invalid, Input, Size));
            }
        }
    }

    // ── Phase 3b: fonts ──────────────────────────────────────────────────
    //
    // The command line passes `--font-path ./assets/fonts`; this looks in the
    // same two places under the root, and reports both whether it finds
    // anything or not, so a refusal can name a directory to put a font in.
    let mut fonts: Vec<(String, Vec<u8>)> = Vec::new();
    let mut font_dirs: Vec<String> = Vec::new();
    let mut font_bytes: usize = 0;
    for base in FONT_DIRS.iter() {
        let start = if proj_root.is_empty() { base.to_string() } else { fmt!("{}/{}", proj_root, base) };
        if !opfs::exists(root, &start).await.unwrap_or(false) { continue; }
        font_dirs.push(start.clone());
        let mut open: Vec<(String, usize)> = vec![(start, 0)];
        let mut opened = 0usize;
        while let Some((dir, depth)) = open.pop() {
            opened += 1;
            if opened > MAX_FONT_DIRS { break; }
            let entries = match opfs::list_dir(root, &dir).await { Ok(e) => e, Err(_) => continue };
            for (name, is_dir, _) in entries {
                let path = fmt!("{}/{}", dir, name);
                if is_dir {
                    if depth + 1 <= MAX_FONT_DEPTH { open.push((path, depth + 1)); }
                    continue;
                }
                if !FONT_EXTS.contains(&ext(&name).as_str()) { continue; }
                let data = match opfs::read_file(root, &path).await { Ok(d) => d, Err(_) => continue };
                font_bytes += data.len();
                if fonts.len() >= MAX_FONTS || font_bytes > MAX_FONT_BYTES {
                    return Err(err!(
                        "This project's font directories hold more than {} fonts or more than \
                        {} MB of them. Nothing was compiled: loading only some of them would \
                        typeset the book in whichever ones happened to be loaded first, and the \
                        line breaks and page count would be wrong in a way nothing would show.",
                        MAX_FONTS, MAX_FONT_BYTES / (1024 * 1024);
                        Invalid, Input, Size));
                }
                fonts.push((path, data));
            }
        }
    }

    // The sources were followed in workspace paths, because that is the only way
    // a relative import can be resolved before the root is known.  They cross the
    // boundary as shadow paths, so nothing on the far side ever holds a path that
    // addresses a real file.
    let mut shadow_srcs: Vec<(String, String)> = Vec::new();
    for (path, text) in srcs.into_iter() {
        let shadow = res!(under_root(&proj_root, &path).ok_or_else(|| err!(
            "'{}' is outside the project root '{}' this compile worked out.", path, proj_root;
            Invalid, Input, Path)));
        shadow_srcs.push((shadow, text));
    }

    Ok(Project {
        root: proj_root,
        main: main_shadow,
        sources: shadow_srcs,
        assets,
        fonts,
        font_dirs,
    })
}

/// Lay a gathered project out as the plain JS object the driver takes.
///
/// Contents cross, not paths to contents: the `path` on each entry is a position
/// in the compiler's shadow filesystem, which exists only inside the wasm module
/// and has no filesystem behind it.
fn to_js(p: &Project) -> Outcome<JsValue> {
    let obj = js_sys::Object::new();
    let set = |k: &str, v: &JsValue| -> Outcome<()> {
        res!(js_sys::Reflect::set(&obj, &JsValue::from_str(k), v)
            .map_err(|e| err!("Building the project object failed: {}.", js_str(&e); System)));
        Ok(())
    };
    let sources = js_sys::Array::new();
    for (path, text) in p.sources.iter() {
        let pair = js_sys::Array::new();
        pair.push(&JsValue::from_str(path));
        pair.push(&JsValue::from_str(text));
        sources.push(&pair);
    }
    let assets = js_sys::Array::new();
    for (path, data) in p.assets.iter() {
        let pair = js_sys::Array::new();
        pair.push(&JsValue::from_str(path));
        pair.push(&js_sys::Uint8Array::from(&data[..]));
        assets.push(&pair);
    }
    let fonts = js_sys::Array::new();
    for (name, data) in p.fonts.iter() {
        let pair = js_sys::Array::new();
        pair.push(&JsValue::from_str(name));
        pair.push(&js_sys::Uint8Array::from(&data[..]));
        fonts.push(&pair);
    }
    let dirs = js_sys::Array::new();
    for d in p.font_dirs.iter() { dirs.push(&JsValue::from_str(d)); }
    res!(set("root", &JsValue::from_str(if p.root.is_empty() { "the workspace root" } else { &p.root })));
    res!(set("main", &JsValue::from_str(&p.main)));
    res!(set("sources", &sources));
    res!(set("assets", &assets));
    res!(set("fonts", &fonts));
    res!(set("fontDirs", &dirs));
    Ok(obj.into())
}


// ── Reaching the driver ─────────────────────────────────────────────────────

/// Reach the driver object on `window`, or refuse in the model's language.
fn driver() -> Outcome<Driver> {
    let win = res!(web_sys::window()
        .ok_or_else(|| err!("The Typst tool needs a browser window."; System, Missing)));
    let obj = res!(js_sys::Reflect::get(&win, &JsValue::from_str("DaimondTypst"))
        .map_err(|e| err!("Reading window.DaimondTypst failed: {}.", js_str(&e); System, Missing)));
    if obj.is_undefined() || obj.is_null() {
        return Err(err!(
            "The Typst compiler is not loaded in this page, so nothing can be typeset. \
            Tell the user, and carry on without it.";
            System, Missing));
    }
    Ok(obj.unchecked_into::<Driver>())
}

/// The `message` of a rejected JS `Error`, verbatim, falling back to the
/// value's own rendering when it is not an `Error`.
fn refusal(e: &JsValue) -> String {
    match js_sys::Reflect::get(e, &JsValue::from_str("message")) {
        Ok(m)  => m.as_string().unwrap_or_else(|| js_str(e)),
        Err(_) => js_str(e),
    }
}

/// Read the resolved `{ pdf }` / `{ error }` object into PDF bytes.
///
/// An `error` is passed through untouched: the page composed it from the
/// compiler's own diagnostics, which name the failing line and, since the
/// gatherer landed, the file that was asked for and not found.  Rewording it
/// would destroy the only thing the model can act on.
///
/// # Arguments
/// * `v` - What the driver's promise resolved with.
fn bytes_of(v: &JsValue) -> Outcome<Vec<u8>> {
    if v.is_undefined() || v.is_null() {
        return Err(err!(
            "The Typst compiler returned nothing at all."; Invalid, Data));
    }
    if let Ok(msg) = js_sys::Reflect::get(v, &JsValue::from_str("error")) {
        if let Some(text) = msg.as_string() {
            if !text.trim().is_empty() {
                return Err(err!("{}", text; Invalid, Data));
            }
        }
    }
    let pdf = res!(js_sys::Reflect::get(v, &JsValue::from_str("pdf"))
        .map_err(|e| err!(
            "Reading the compiled PDF failed: {}.", refusal(&e); Invalid, Data)));
    if pdf.is_undefined() || pdf.is_null() {
        return Err(err!(
            "The Typst compiler reported neither a PDF nor an error."; Invalid, Data));
    }
    let arr = res!(pdf.dyn_into::<js_sys::Uint8Array>()
        .map_err(|_| err!(
            "The Typst compiler returned a PDF that is not a byte array."; Invalid, Data)));
    let out = arr.to_vec();
    if out.len() < 5 {
        return Err(err!(
            "The Typst compiler returned {} bytes, which is not a PDF.", out.len();
            Invalid, Data));
    }
    Ok(out)
}

/// Compile `source` to PDF bytes in the browser, as ONE self-contained file.
///
/// Kept for a source that has no project behind it -- a string composed in the
/// page rather than read off disk.  Anything that imports, includes or names a
/// picture wants [`compile_project`] instead; this one really can see nothing
/// but the string it is given, and now says so when a source reaches further.
///
/// # Arguments
/// * `source` - The whole Typst document, self-contained.
pub async fn compile(source: &str) -> Outcome<Vec<u8>> {
    let d = res!(driver());
    match JsFuture::from(d.compile(source)).await {
        Ok(v)  => bytes_of(&v),
        Err(e) => Err(err!("{}", refusal(&e); Invalid, Data)),
    }
}

/// Compile the project that `main_rel` belongs to, in the browser.
///
/// # Arguments
/// * `root` - Which filesystem root the workspace path is under.
/// * `main_rel` - Workspace-relative path of the `.typ` file to compile.
pub async fn compile_project(root: FileRoot, main_rel: &str) -> Outcome<Vec<u8>> {
    let d = res!(driver());
    let has = js_sys::Reflect::has(&d, &JsValue::from_str("compileProject")).unwrap_or(false);
    if !has {
        return Err(err!(
            "The Typst driver in this page is an older one that compiles a single file only. \
            Reload the page to pick up the current one."; System, Missing));
    }
    let project = res!(gather(root, main_rel).await);
    let arg = res!(to_js(&project));
    match JsFuture::from(d.compile_project(&arg)).await {
        Ok(v)  => bytes_of(&v),
        Err(e) => Err(err!("{}", refusal(&e); Invalid, Data)),
    }
}


// ── The page's door ─────────────────────────────────────────────────────────

/// Compile the project a workspace `.typ` file belongs to, for the Doc panel's
/// Compile button, resolving `{ pdf }` or `{ error }`.
///
/// The button used to read the source in JavaScript and hand the driver a string,
/// which is why it could only ever compile one file.  It comes through here now,
/// so there is exactly ONE gatherer and the button and the model's `typst_compile`
/// tool cannot disagree about what a project is -- and so the reading still
/// happens on this side, under the path jail.
///
/// # Arguments
/// * `path` - Workspace-relative path of the `.typ` file to compile.
#[wasm_bindgen]
pub async fn typst_compile_project(path: String) -> js_sys::Object {
    let obj = js_sys::Object::new();
    match compile_project(FileRoot::Workspace, &path).await {
        Ok(pdf) => {
            let _ = js_sys::Reflect::set(
                &obj, &JsValue::from_str("pdf"), &js_sys::Uint8Array::from(&pdf[..]));
        },
        Err(e) => {
            let _ = js_sys::Reflect::set(
                &obj, &JsValue::from_str("error"), &JsValue::from_str(&fmt!("{}", e)));
        },
    }
    obj
}


// ── Where these are checked ─────────────────────────────────────────────────
//
// Not here.  `src/wasm` is gated to `wasm32`, and nothing in this tree runs a
// wasm test runner, so a `#[cfg(test)] mod tests` in this file would compile for
// no target anybody builds and could never go red -- a check that cannot fail is
// worse than none, because it reads as coverage.
//
// The path arithmetic above, the closure, the caps and the font refusal are all
// proved in `dev/verify_typstproject.mjs`, which drives the real gatherer against
// real files in a real OPFS workspace, and withholds each file in turn to see the
// refusal it is supposed to produce.
