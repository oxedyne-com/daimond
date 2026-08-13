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
//!
//! # The root is not the search path
//!
//! Landing the gatherer was not enough, because it made ONE directory do three
//! jobs.  The compiler's project root has to sit high enough that
//! `#import "../style/glossary_index.typ"` resolves, which for the author's book
//! means the folder ABOVE it; fonts and root-relative pictures live inside the
//! book, one level DOWN from there.  Tying the font search to the root therefore
//! meant that the arrangement which made the imports work was the arrangement
//! which lost every font -- and the refusal, correctly, said the book asked for a
//! family it could not load.  Two right answers to two questions that were never
//! the same question.
//!
//! They are separated here.  The root is inferred from the import closure and
//! nothing else.  Assets and fonts are searched from the MAIN FILE'S OWN FOLDER
//! outward, at every ancestor up to the folder the user marked in, and a
//! root-relative reference is placed in the shadow filesystem at the path the
//! source names it by -- so `"/assets/svg/mark.svg"` is satisfied by
//! `<book>/assets/svg/mark.svg` whether the root came out at the book or three
//! levels above it, and a font beside the book is found whether the root reaches
//! it or not.
//!
//! Nothing asks the user where the root is.  Marking a folder into the workspace
//! is already a permission grant; asking for a second folder that satisfies an
//! import graph nobody can see is a configuration question wearing a permission's
//! hat, and it has no feedback until it fails.
//!
//! # The rule, so it cannot be re-coupled by accident
//!
//! **The ROOT says how the compiler ADDRESSES a file.  The MARK says what may be
//! READ.  They are different questions.**
//!
//! Two variables that look interchangeable, and joining them back together is a
//! two-character change that passes every test but one.  It was made once here
//! already, in the first version of this rewrite: the asset and font search was
//! capped at the inferred root, and a fixture that lost one import shrank the root
//! from `books` to `books/proj`, which put `books/assets/fonts` outside it.  The
//! compile was then refused for a missing font family -- while the actual fault was
//! a missing import, three inches up the same file.  A wrong message buying a wrong
//! diagnosis is the entire reason this module was rewritten, and it had grown back
//! in a smaller costume.
//!
//! So the search ceiling is the FLOOR -- the folder marked into the workspace, or
//! the compartment a turn works in -- and never the root.  Two consequences that
//! look like bugs to a reader who does not know why:
//!
//! - A file may be READ from above the inferred root.  That is not a hole: the
//!   mark is the permission, and the root is a conclusion drawn from the imports
//!   after the fact.  Nothing above the mark is ever reached, and `MAX_UP` bounds
//!   the climb whatever the mark is.
//! - A root-relative reference found above the root is still ADDRESSABLE, because
//!   it is placed in the shadow filesystem at the position the source named it by
//!   -- `"/assets/x.svg"` goes to `/assets/x.svg` -- and not at where it was found.
//!   The shadow filesystem is ours to lay out; it owes nothing to the disk.

use crate::tools::{FileRoot, ToolContext};
use crate::wasm::{js_str, opfs};

use oxedyne_fe2o3_core::prelude::*;

use std::cell::RefCell;

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

    /// Lay a gathered project out without writing it out, resolving
    /// `{ vector }` or `{ error }`.  What the live view draws.
    #[wasm_bindgen(method, js_name = compileProjectVector)]
    fn compile_project_vector(this: &Driver, project: &JsValue) -> js_sys::Promise;

    /// The watcher object `www/js/typstwatch.js` installs at
    /// `window.DaimondTypstWatch`, absent on a page that has no live view.
    #[wasm_bindgen(js_name = DaimondTypstWatch)]
    type Watcher;

    /// Tell the watcher a document has just been compiled from the page, so it
    /// can follow the file from here on.
    #[wasm_bindgen(method)]
    fn began(this: &Watcher, path: &str, watch: &JsValue);
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

/// How far above a file's own directory a reference may be searched for.
///
/// The author's book sits one level down and reaches one level up, so the true
/// root is the parent; four levels is room for a deeper tree without turning a
/// stray `"/usr/share/x.png"` in prose into a walk of the whole workspace.
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

/// Directories searched for fonts, relative to each folder on the search path,
/// mirroring what `typst --font-path` is usually pointed at.
const FONT_DIRS: &[&str] = &["assets/fonts", "fonts"];

/// Typst's own project manifest, which a self-declaring project puts at its root.
const MANIFEST: &str = "typst.toml";


// ── Fonts do not change between rebuilds ────────────────────────────────────
//
// The gather re-read 63 sources AND ELEVEN MEGABYTES OF FONTS ACROSS 24 FILES on
// every compile -- about 150 ms of a 430 ms rebuild, or a third of a watch loop,
// spent reading bytes that were byte-for-byte the ones read a second earlier.
//
// Sources have to be re-read: they are what changed.  Fonts do not.  So the font
// directories are still WALKED every time -- a listing is cheap and a font really
// can be dropped in mid-session -- but the bytes are only re-read when the walk
// produces a different answer.  "Different" is `lastModified` WITH `size`, per
// file, which is the same test `www/js/cloud.js` uses for cloud sync and the same
// one [`opfs::stamp`] exists to serve; a font edited in place to the same length
// within the same millisecond is the case it misses, and it is the case every
// mtime-based cache in the world misses.
//
// A stale font here would be worse than a slow one, which is why the key is per
// file and not a count: this module refuses to compile a book in a substitute
// font at all, on the grounds that the line breaks and the page count of what
// came back would not be the ones that print.  A cache that quietly served the
// wrong face would be the same lie by a different route.

/// Font bytes kept from the last gather, with the walk that justified them.
struct FontCache {
    /// One line per font file: path, size and modification time.  Any difference
    /// at all re-reads the whole set.
    key:   String,
    /// The bytes themselves, as `(workspace path, contents)`.
    fonts: Vec<(String, Vec<u8>)>,
}

thread_local! {
    /// The fonts of the last project gathered, so a rebuild does not re-read them.
    ///
    /// One slot, not a map: a watch loop compiles ONE project over and over, and a
    /// map keyed on project would hold every book of a long session in memory for
    /// the sake of a rebuild nobody is waiting on.
    static FONTS: RefCell<Option<FontCache>> = const { RefCell::new(None) };
}

/// Forget the cached fonts, so the next gather re-reads them.
///
/// Nothing calls this in the ordinary course; it exists so a caller that has just
/// written a font file can say so, and so the cache is not the only thing standing
/// between a changed font and a compile.
pub fn forget_fonts() {
    FONTS.with(|c| { *c.borrow_mut() = None; });
}


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

/// The file name of a slash path, lower-cased.
fn leaf(path: &str) -> String {
    match path.rfind('/') {
        Some(i) => path[i + 1..].to_ascii_lowercase(),
        None    => path.to_ascii_lowercase(),
    }
}

/// How many segments deep a directory is.
fn depth(dir: &str) -> usize {
    if dir.is_empty() { 0 } else { dir.split('/').count() }
}

/// The deepest directory that contains both directories `a` and `b`.
fn common_of(a: &str, b: &str) -> String {
    let sa: Vec<&str> = if a.is_empty() { Vec::new() } else { a.split('/').collect() };
    let sb: Vec<&str> = if b.is_empty() { Vec::new() } else { b.split('/').collect() };
    let n = sa.iter().zip(sb.iter()).take_while(|(x, y)| x == y).count();
    sa[..n].join("/")
}

/// The deepest directory that contains every path in `paths`.
fn common_dir(paths: &[String]) -> String {
    let mut common: Option<String> = None;
    for p in paths {
        let dir = parent(p);
        common = Some(match common {
            None    => dir,
            Some(c) => common_of(&c, &dir),
        });
    }
    common.unwrap_or_default()
}

/// Express `path` relative to `root`, as the compiler's shadow filesystem wants
/// it: rooted at `/`, because that is where this build puts the project root.
///
/// `None` when `path` is not inside `root`, which is also how containment is
/// asked here -- whole segments, so `alpha2` is not inside `alpha`.
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

/// `dir` and its ancestors, nearest first, stopping at `top` and never climbing
/// more than `up` levels.
fn chain(dir: &str, top: &str, up: usize) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut cur = dir.to_string();
    loop {
        if !out.contains(&cur) { out.push(cur.clone()); }
        if cur == top || cur.is_empty() || out.len() > up { break; }
        cur = parent(&cur);
    }
    out
}

/// Where a reference that its own directory does not satisfy is looked for.
///
/// The main file's folder comes first, because that is the book; then the folder
/// of whichever source named the reference; then upward from both, never above
/// the root.  This is the whole of the root/search-path separation: the root can
/// sit as high as the imports need it to, and `"/assets/fonts"` still means the
/// one inside the book.
fn search_dirs(main_dir: &str, from_dir: &str, root: &str) -> Vec<String> {
    let mut out = chain(main_dir, root, MAX_UP);
    for d in chain(from_dir, root, MAX_UP) {
        if !out.contains(&d) { out.push(d); }
    }
    out
}

/// A shadow path for a root-relative reference: the literal itself, cleaned.
fn abs_shadow(lit: &str) -> Option<String> {
    norm(lit).map(|p| fmt!("/{}", p))
}

/// Resolve `rel` against the shadow position of the file that names it.
///
/// `None` when it climbs above the shadow root, which this compiler cannot
/// address -- and neither can the command-line one, for the same reason.
fn shadow_join(from_shadow: &str, rel: &str) -> Option<String> {
    let dir = parent(from_shadow);
    join(dir.trim_start_matches('/'), rel).map(|p| fmt!("/{}", p))
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


// ── How far a gather may reach ──────────────────────────────────────────────

/// How far a gather may reach, since it follows paths the call never named.
///
/// The tool guard can only check the paths a call NAMES, and a project is a
/// closure: one path goes in and a hundred files are read.  `file_search` and
/// `file_glob` have exactly this shape and answer it by re-asking the turn about
/// every entry they reach, so this re-asks too rather than inventing a second
/// convention.  Dispatching the model's `typst_compile` at the gatherer without
/// this would have widened one named read into a walk that could climb out of a
/// chat's folder by writing `#import "../../elsewhere.typ"` in a source.
pub enum Reach<'a> {
    /// Anywhere in the workspace: the page's own Compile button, which is the
    /// user opening a file they marked in themselves.
    Workspace,
    /// Only what this turn may read, and never above its compartment.
    Turn(&'a ToolContext),
}

impl<'a> Reach<'a> {

    /// The deepest directory this gather may not climb above.
    fn floor(&self) -> String {
        match self {
            Self::Workspace => String::new(),
            Self::Turn(ctx) => norm(&ctx.path_prefix).unwrap_or_default(),
        }
    }

    /// Whether `path`, workspace-relative and normalised, may be read.
    fn allows(&self, path: &str) -> bool {
        match self {
            Self::Workspace => true,
            Self::Turn(ctx) => {
                let floor = self.floor();
                // A compartment and an allow-list are two ways of saying where a turn
                // lives, and a path is measured against one of them and never both --
                // `Tool::scoped` records why at length.
                if floor.is_empty() {
                    ctx.may_read(path)
                } else {
                    under_root(&floor, path).is_some()
                }
            },
        }
    }
}


// ── The gathered project ────────────────────────────────────────────────────

/// Where a gathered source sits in the compiler's shadow filesystem.
///
/// Two anchors rather than one, because a root-relative import names its own
/// position: `#import "/style/x.typ"` must be readable at `/style/x.typ` however
/// the root came out, while an ordinary import is placed where it really sits,
/// re-based on the root.  A file's relative imports are resolved against its own
/// anchor, so the two kinds nest without either one knowing about the other.
#[derive(Clone)]
enum Anchor {
    /// Under the project root: the shadow path is the workspace path, re-based.
    Root,
    /// At a position a root-relative reference named.
    Fixed(String),
}

/// One source, as read on this side.
struct Src {
    /// Workspace path the bytes came from.
    real:   String,
    /// Where the compiler will see it.
    anchor: Anchor,
    /// The text itself.
    text:   String,
}

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
    /// Which folders a root-relative reference was searched in, so a refusal can
    /// say where it looked rather than only that it failed.
    searched:  Vec<String>,
    /// Every REAL workspace path this compile read, so a watcher knows what to poll.
    ///
    /// The rest of this struct carries shadow paths, which address nothing on disk
    /// -- deliberately, and the module header says why at length.  A watch loop
    /// needs the other kind: the file the user is editing, spelled the way the
    /// workspace spells it.  It is the gatherer's answer because the gatherer is
    /// the only thing that knows which files a document actually reaches; a
    /// watcher that guessed from the directory would poll a build output and a
    /// backup and miss an import three folders up.
    watch:     Vec<String>,
}

/// What the client should DO about a refusal, beside being told about it.
///
/// Prose is not an action.  The refusal that prompted this said, correctly, to
/// open the folder above the one attached; the daimon reading it concluded the
/// compiler "can only handle self-contained single files" and told the user to
/// attach a folder that was already in the workspace and named in the same
/// sentence.  The translation from advice to action is where it went wrong, so
/// the action is carried alongside the words instead of being left to be
/// inferred from them.
enum Remedy {
    /// Mark in the folder ABOVE the one the workspace holds, because the project
    /// reaches past it.  Carries the file that reaches and what it reaches for.
    MarkAbove {
        /// The source that climbs out, workspace-relative.
        from: String,
        /// What it names.
        what: String,
    },
}

impl Remedy {

    /// The stable action word a client dispatches on.
    fn action(&self) -> &'static str {
        match self {
            Self::MarkAbove { .. } => "mark-above",
        }
    }

    /// The path the action is about.
    fn subject(&self) -> String {
        match self {
            Self::MarkAbove { from, .. } => parent(from),
        }
    }

    /// One line a model can act on without parsing English.
    ///
    /// Deliberately the LAST line and deliberately dull: a model that reads only
    /// the prose loses nothing, and one that looks for an action finds it in the
    /// same shape every time.
    fn line(&self) -> String {
        match self {
            Self::MarkAbove { from, what } => {
                let folder = self.subject();
                let folder = if folder.is_empty() { ".".to_string() } else { folder };
                fmt!("REMEDY mark-above folder={} because={} needs={}", folder, from, what)
            },
        }
    }
}

/// What a gather produced.
///
/// A refusal is a first-class result rather than an error, because most of them
/// are answers to the user -- the wrong folder is marked in, a font is not there
/// -- and one of them carries an action the client can offer.  Squeezing that
/// through a formatted error string would mean parsing back what was just
/// written.
enum Gathered {
    /// A project ready to compile.
    Ready(Project),
    /// Nothing was gathered, and this is why.
    Refused {
        /// The reason, in the language the model and the user both read.
        why:    String,
        /// What to do about it, when there is something to do.
        remedy: Option<Remedy>,
    },
}

/// Refuse, with no action to offer.
fn refuse(why: String) -> Gathered {
    Gathered::Refused { why, remedy: None }
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
/// Four phases, in this order because each needs the one before it:
///
/// 1. The source closure.  A relative import is resolved against the importing
///    file; a root-relative one is searched for from the main file's folder
///    outward and then pinned at the position it named.
/// 2. The root, inferred and never asked for: the deepest directory holding
///    every ordinarily-imported source, raised if a picture sits above it, and
///    overridden by a `typst.toml` that declares one.
/// 3. The assets, now that a shadow position exists for everything.
/// 4. The fonts, searched from the main file's folder up to the root.
///
/// # Arguments
/// * `reach` - How far this caller may follow the closure.
/// * `root` - Which filesystem root the workspace path is under.
/// * `main_rel` - Workspace-relative path of the `.typ` file to compile.
async fn gather(reach: &Reach<'_>, root: FileRoot, main_rel: &str) -> Outcome<Gathered> {
    let floor = reach.floor();
    let main = match norm(main_rel) {
        Some(m) => m,
        None    => return Ok(refuse(fmt!(
            "'{}' climbs above the workspace, so there is no file there to compile.", main_rel))),
    };
    if !reach.allows(&main) {
        return Ok(refuse(fmt!(
            "'{}' is outside what this turn may read, so nothing was compiled.", main)));
    }
    let main_text = match read_text(root, &main).await {
        Some(t) => t,
        None    => return Ok(refuse(fmt!("There is no file at '{}' to compile.", main))),
    };
    let main_dir = parent(&main);

    // ── Phase 1: the source closure ──────────────────────────────────────
    let mut srcs: Vec<Src> = vec![Src {
        real: main.clone(), anchor: Anchor::Root, text: main_text }];
    let mut queue: Vec<usize> = vec![0];
    let mut escaped: Vec<(String, String)> = Vec::new();
    let mut outside: Vec<(String, String)> = Vec::new();
    let mut above:   Vec<(String, String)> = Vec::new();
    let mut bytes: usize = srcs[0].text.len();
    while let Some(idx) = queue.pop() {
        let from = srcs[idx].real.clone();
        let from_anchor = srcs[idx].anchor.clone();
        let text = srcs[idx].text.clone();
        let dir = parent(&from);
        for (_, lit) in literals(&text) {
            // A package import (`@preview/cetz:0.3.4`) names nothing on disk, and this
            // build has no registry to resolve it with.  It is left alone here and
            // explained by the driver from typst's own diagnostic, which names the file
            // and the line -- better than a list gathered up front could.
            if lit.starts_with('@') { continue; }
            if ext(&lit) != "typ" { continue; }
            let (path, anchor) = if lit.starts_with('/') {
                // Root-relative, and the root here is inferred rather than given, so the
                // file is looked for beside the main file first and upward from there.
                // Wherever it is found it is PLACED where the source named it, which is
                // what makes the position independent of where the root came out.
                let shadow = match abs_shadow(&lit) { Some(s) => s, None => continue };
                let mut hit: Option<String> = None;
                for base in search_dirs(&main_dir, &dir, &floor) {
                    let cand = match join(&base, lit.trim_start_matches('/')) {
                        Some(c) => c,
                        None    => continue,
                    };
                    if !reach.allows(&cand) { continue; }
                    if opfs::exists(root, &cand).await.unwrap_or(false) {
                        hit = Some(cand);
                        break;
                    }
                }
                match hit {
                    Some(p) => (p, Anchor::Fixed(shadow)),
                    // Nothing of that name anywhere on the search path.  Left for the
                    // compiler to fail on, because a literal that merely looks like a
                    // path -- a filename quoted in prose -- must not stop a compile.
                    None    => continue,
                }
            } else {
                let path = match join(&dir, &lit) {
                    Some(p) => p,
                    None    => {
                        // A climb out of the marked folder, which is the shape of
                        // "the folder marked in was one level too deep".
                        if !escaped.iter().any(|(_, r)| *r == lit) {
                            escaped.push((from.clone(), lit.clone()));
                        }
                        continue;
                    },
                };
                if !reach.allows(&path) {
                    if !outside.iter().any(|(_, r)| *r == lit) {
                        outside.push((from.clone(), lit.clone()));
                    }
                    continue;
                }
                let anchor = match &from_anchor {
                    Anchor::Root     => Anchor::Root,
                    Anchor::Fixed(f) => match shadow_join(f, &lit) {
                        Some(s) => Anchor::Fixed(s),
                        None    => {
                            // A file reached by a root-relative import, itself importing
                            // its way above the root. A different fault from the one below
                            // -- the folder marked in is not the problem, the source is --
                            // and the command-line compiler refuses it too.
                            if !above.iter().any(|(_, r)| *r == lit) {
                                above.push((from.clone(), lit.clone()));
                            }
                            continue;
                        },
                    },
                };
                (path, anchor)
            };
            let key = match &anchor {
                Anchor::Root     => String::new(),
                Anchor::Fixed(f) => f.clone(),
            };
            if srcs.iter().any(|s| s.real == path && match &s.anchor {
                Anchor::Root     => key.is_empty(),
                Anchor::Fixed(f) => *f == key,
            }) { continue; }
            let text = match read_text(root, &path).await { Some(t) => t, None => continue };
            bytes += text.len();
            if bytes > MAX_BYTES {
                return Ok(refuse(fmt!(
                    "This project's source files come to more than {} MB, which is past the \
                    limit this compiler gathers. Nothing was compiled rather than something \
                    incomplete.", MAX_BYTES / (1024 * 1024))));
            }
            srcs.push(Src { real: path, anchor, text });
            if srcs.len() > MAX_FILES {
                return Ok(refuse(fmt!(
                    "This project reaches more than {} source files, which is past the limit \
                    this compiler gathers. Nothing was compiled -- a project cut off at a limit \
                    would have produced a PDF missing whatever fell outside it, and said nothing. \
                    Compile a smaller part of it, or mark in a narrower folder.", MAX_FILES)));
            }
            queue.push(srcs.len() - 1);
        }
    }
    if !escaped.is_empty() {
        let (from, lit) = escaped[0].clone();
        let here = parent(&from);
        let here = if here.is_empty() { "the marked folder".to_string() } else { here };
        return Ok(Gathered::Refused {
            why: fmt!(
                "'{}' imports '{}', which is above the folder the workspace holds. The compiler \
                is given the files of one project, and nothing above the marked folder exists as \
                far as this page is concerned -- not because of a setting, but because that mark \
                is the whole of the permission it has. Mark in the folder ABOVE '{}' -- the one \
                that holds both it and what it reaches for -- and compile the same file from \
                there. Nothing else needs changing: the root is worked out from the imports \
                themselves, and pictures and fonts are still found inside the book.",
                from, lit, here),
            remedy: Some(Remedy::MarkAbove { from, what: lit }),
        });
    }
    if !outside.is_empty() {
        let (from, lit) = outside[0].clone();
        return Ok(refuse(fmt!(
            "'{}' imports '{}', which is outside the folder this turn works in. Nothing was \
            compiled. A compile gathers every file its source reaches, so it is held to the same \
            bounds as a read: what the turn may not read, it may not typeset either.", from, lit)));
    }
    if !above.is_empty() {
        let (from, lit) = above[0].clone();
        return Ok(refuse(fmt!(
            "'{}' was reached by a path beginning with '/', which places it at the top of the \
            project, and it imports '{}' -- above the top. Nothing was compiled. This is the \
            source's own arithmetic rather than anything about the folder marked in: the \
            command-line compiler refuses the same import for the same reason. Import it by a \
            path that stays inside the project.", from, lit)));
    }

    // ── Phase 2: the root, inferred ──────────────────────────────────────
    //
    // The deepest directory holding every ordinarily-imported source, which is
    // exactly what `typst --root` is passed on the command line and exactly what
    // the author's own build script passes (`typst compile --root .. book.typ`).
    // A file pinned by a root-relative import does not constrain it: that one
    // sits where it named itself.
    let anchored: Vec<String> = srcs.iter()
        .filter(|s| matches!(s.anchor, Anchor::Root))
        .map(|s| s.real.clone())
        .collect();
    let base_root = common_dir(&anchored);
    let mut proj_root = base_root.clone();
    // A picture beside the book rather than inside it raises the root, so long as
    // it really is there. Probed rather than assumed, because a quoted filename in
    // prose must not move the root of a project that has nothing to do with it.
    for s in srcs.iter() {
        if !matches!(s.anchor, Anchor::Root) { continue; }
        let dir = parent(&s.real);
        for (_, lit) in literals(&s.text) {
            if lit.starts_with('/') || lit.starts_with('@') { continue; }
            if !ASSET_EXTS.contains(&ext(&lit).as_str()) { continue; }
            let path = match join(&dir, &lit) { Some(p) => p, None => continue };
            if under_root(&proj_root, &path).is_some() { continue; }
            if !reach.allows(&path) { continue; }
            if !opfs::exists(root, &path).await.unwrap_or(false) { continue; }
            let want = common_of(&proj_root, &parent(&path));
            if depth(&base_root).saturating_sub(depth(&want)) <= MAX_UP
                && under_root(&floor, &want).is_some()
            {
                proj_root = want;
            }
        }
    }
    // Typst's own manifest declares a root, so a project that says where it is
    // gets taken at its word -- but only when the closure actually fits inside
    // it, since a manifest left behind by a package would otherwise cut the
    // book in half.
    for cand in chain(&main_dir, &floor, MAX_UP) {
        let manifest = if cand.is_empty() { MANIFEST.to_string() } else { fmt!("{}/{}", cand, MANIFEST) };
        if !opfs::exists(root, &manifest).await.unwrap_or(false) { continue; }
        if anchored.iter().all(|p| under_root(&cand, p).is_some()) {
            proj_root = cand;
        }
        break;
    }
    let main_shadow = match under_root(&proj_root, &main) {
        Some(s) => s,
        None    => return Ok(refuse(fmt!(
            "The project root worked out as '{}', which does not contain '{}'.", proj_root, main))),
    };

    // Every source's position, settled now that the root is.
    let mut shadows: Vec<String> = Vec::new();
    for s in srcs.iter() {
        let shadow = match &s.anchor {
            Anchor::Fixed(f) => f.clone(),
            Anchor::Root     => match under_root(&proj_root, &s.real) {
                Some(sh) => sh,
                None     => return Ok(refuse(fmt!(
                    "'{}' is outside the project root '{}' this compile worked out.",
                    s.real, proj_root))),
            },
        };
        shadows.push(shadow);
    }

    // ── Phase 3: assets ──────────────────────────────────────────────────
    //
    // The search runs from the main file's folder up to the FLOOR -- the folder
    // marked into the workspace, or the compartment a turn works in -- and not up
    // to the root. The root is where the imports put it and says how the compiler
    // ADDRESSES a file; the mark is the permission and says what may be READ. A
    // book whose fonts sit beside it rather than inside it has them above the
    // inferred root, and capping the search at the root would lose them exactly as
    // hanging it off the root did. Nothing above the mark is ever reached, and a
    // root-relative reference found above the root is still addressable, because it
    // is placed at the position the source named rather than where it was found.
    let searched = search_dirs(&main_dir, &main_dir, &floor);
    let mut assets: Vec<(String, Vec<u8>)> = Vec::new();
    // The real paths behind those assets, which the shadow positions deliberately
    // do not carry.  A picture is as much a reason to rebuild as a chapter is.
    let mut asset_reals: Vec<String> = Vec::new();
    for (i, s) in srcs.iter().enumerate() {
        let dir = parent(&s.real);
        for (_, lit) in literals(&s.text) {
            if lit.starts_with('@') { continue; }
            if !ASSET_EXTS.contains(&ext(&lit).as_str()) { continue; }
            let (shadow, path) = if lit.starts_with('/') {
                // Placed where the source names it, found wherever it lives on the
                // search path. This is what lets `"/assets/svg/mark.svg"` mean the one
                // inside the book while the root sits above the book.
                let shadow = match abs_shadow(&lit) { Some(s) => s, None => continue };
                let mut hit: Option<String> = None;
                for base in search_dirs(&main_dir, &dir, &floor) {
                    let cand = match join(&base, lit.trim_start_matches('/')) {
                        Some(c) => c,
                        None    => continue,
                    };
                    if !reach.allows(&cand) { continue; }
                    if opfs::exists(root, &cand).await.unwrap_or(false) {
                        hit = Some(cand);
                        break;
                    }
                }
                match hit { Some(p) => (shadow, p), None => continue }
            } else {
                let path = match join(&dir, &lit) { Some(p) => p, None => continue };
                if !reach.allows(&path) { continue; }
                let shadow = match shadow_join(&shadows[i], &lit) { Some(s) => s, None => continue };
                (shadow, path)
            };
            if assets.iter().any(|(p, _)| *p == shadow) { continue; }
            let data = match opfs::read_file(root, &path).await { Ok(d) => d, Err(_) => continue };
            bytes += data.len();
            if bytes > MAX_BYTES {
                return Ok(refuse(fmt!(
                    "This project's files come to more than {} MB, which is past the limit this \
                    compiler gathers. Nothing was compiled, because a project cut short would \
                    have produced a PDF with pictures missing and no warning that they were.",
                    MAX_BYTES / (1024 * 1024))));
            }
            assets.push((shadow, data));
            asset_reals.push(path);
            if srcs.len() + assets.len() > MAX_FILES {
                return Ok(refuse(fmt!(
                    "This project reaches more than {} files, which is past the limit this \
                    compiler gathers. Nothing was compiled rather than something incomplete.",
                    MAX_FILES)));
            }
        }
    }

    // ── Phase 4: fonts ───────────────────────────────────────────────────
    //
    // The command line passes `--font-path ./assets/fonts`; this looks in the
    // same two places at every folder from the book outward to the root, and
    // reports where it looked whether it found anything or not, so a refusal can
    // name a directory to put a font in.
    //
    // Outward rather than at the root alone, because the root is where the
    // IMPORTS put it and the fonts are where the BOOK is. Tying the two together
    // is what made the author's book compile without a single one of its fonts.
    //
    // The walk finds the files and stamps them; the BYTES are only read when the
    // stamps differ from the last gather's (see `FontCache` above).  The caps are
    // therefore checked against the stamped sizes, before anything is read, which
    // also means a project that is over the limit is refused without first pulling
    // twenty-four megabytes through the edge to find out.
    let mut font_dirs: Vec<String> = Vec::new();
    let mut found: Vec<(String, f64, f64)> = Vec::new();		// path, mtime, size
    let mut font_bytes: f64 = 0.0;
    let mut have: Vec<String> = Vec::new();
    for base in searched.iter() {
        for suffix in FONT_DIRS.iter() {
            let start = if base.is_empty() { suffix.to_string() } else { fmt!("{}/{}", base, suffix) };
            if !reach.allows(&start) { continue; }
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
                    // The same face reached twice -- a book folder whose `assets` is a
                    // link to the shared one, say -- is one font, not two, and loading it
                    // twice would spend the cap below on duplicates.
                    if have.contains(&leaf(&name)) { continue; }
                    let (mtime, size) = match opfs::stamp(root, &path).await {
                        Ok(Some(s)) => s,
                        _           => continue,
                    };
                    font_bytes += size;
                    if found.len() >= MAX_FONTS || font_bytes > MAX_FONT_BYTES as f64 {
                        return Ok(refuse(fmt!(
                            "This project's font directories hold more than {} fonts or more than \
                            {} MB of them. Nothing was compiled: loading only some of them would \
                            typeset the book in whichever ones happened to be loaded first, and the \
                            line breaks and page count would be wrong in a way nothing would show.",
                            MAX_FONTS, MAX_FONT_BYTES / (1024 * 1024))));
                    }
                    have.push(leaf(&name));
                    found.push((path, mtime, size));
                }
            }
        }
    }
    // One line per file, in walk order, so any difference at all -- a font added, a
    // font removed, a font rewritten -- produces a different key and re-reads the set.
    let font_key = found.iter()
        .map(|(p, m, s)| fmt!("{}\u{1}{}\u{1}{}", p, m, s))
        .collect::<Vec<String>>()
        .join("\n");
    let cached = FONTS.with(|c| {
        let c = c.borrow();
        match c.as_ref() {
            Some(fc) if fc.key == font_key => Some(fc.fonts.clone()),
            _                              => None,
        }
    });
    let fonts: Vec<(String, Vec<u8>)> = match cached {
        Some(f) => f,
        None    => {
            let mut read: Vec<(String, Vec<u8>)> = Vec::new();
            for (path, _, _) in found.iter() {
                let data = match opfs::read_file(root, path).await { Ok(d) => d, Err(_) => continue };
                read.push((path.clone(), data));
            }
            FONTS.with(|c| {
                *c.borrow_mut() = Some(FontCache { key: font_key.clone(), fonts: read.clone() });
            });
            read
        },
    };

    // The sources were followed in workspace paths, because that is the only way
    // a relative import can be resolved before the root is known.  They cross the
    // boundary as shadow paths, so nothing on the far side ever holds a path that
    // addresses a real file.
    let mut shadow_srcs: Vec<(String, String)> = Vec::new();
    let mut watch: Vec<String> = Vec::new();
    for (i, s) in srcs.into_iter().enumerate() {
        if !watch.contains(&s.real) { watch.push(s.real); }
        shadow_srcs.push((shadows[i].clone(), s.text));
    }
    for p in asset_reals.into_iter() {
        if !watch.contains(&p) { watch.push(p); }
    }
    for (p, _, _) in found.iter() {
        if !watch.contains(p) { watch.push(p.clone()); }
    }

    Ok(Gathered::Ready(Project {
        root: proj_root,
        main: main_shadow,
        sources: shadow_srcs,
        assets,
        fonts,
        font_dirs,
        searched,
        watch,
    }))
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
    let looked = js_sys::Array::new();
    for d in p.searched.iter() {
        looked.push(&JsValue::from_str(if d.is_empty() { "the workspace root" } else { d }));
    }
    // The one array here that names REAL files. It goes out because a watcher has to
    // know what to poll and only the gatherer knows; nothing on the far side reads a
    // file by it -- the poll comes back through `typst_watch_stamps`, on this side,
    // under the same jail as every other read.
    let watching = js_sys::Array::new();
    for w in p.watch.iter() { watching.push(&JsValue::from_str(w)); }
    res!(set("root", &JsValue::from_str(if p.root.is_empty() { "the workspace root" } else { &p.root })));
    res!(set("main", &JsValue::from_str(&p.main)));
    res!(set("sources", &sources));
    res!(set("assets", &assets));
    res!(set("fonts", &fonts));
    res!(set("fontDirs", &dirs));
    res!(set("searched", &looked));
    res!(set("watch", &watching));
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

/// The driver's own `error` string, when it reported one.
///
/// **A failed compile is an ANSWER, not a fault**, and this is the only shape it
/// arrives in.  `www/js/typst.js` composes it out of typst's diagnostics -- the
/// file, the line, the literal the line names, and what the compiler was actually
/// given -- and that is the whole of what a reader or a daimon can act on.
///
/// It is read out separately, and BEFORE anything is turned into an
/// [`Error`](oxedyne_fe2o3_core::error::Error), because turning it into one is how
/// it gets destroyed.  A fe2o3 error renders as `LocalErr{[Invalid Data] "…"}`,
/// with ANSI colour codes and the source position of the Rust line that raised it,
/// and every layer that touches it adds another.  A person pressing ⚙ Compile with
/// no Typst pack was shown exactly that -- escape codes included, unchanged by the
/// locale -- in place of the sentence the refusal was written as.
///
/// Which was the very failure this module was rewritten for: a message about the
/// machinery in place of a message about the problem.  It matters more now than it
/// did, because the live view puts a failed build in front of the reader every time
/// a brace is mistyped, rather than once when a button is pressed.
fn driver_error(v: &JsValue) -> Option<String> {
    let msg = match js_sys::Reflect::get(v, &JsValue::from_str("error")) {
        Ok(m)  => m,
        Err(_) => return None,
    };
    match msg.as_string() {
        Some(t) if !t.trim().is_empty() => Some(t),
        _                               => None,
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
/// * `v`     - What the driver's promise resolved with.
/// * `field` - Which byte field to take: `"pdf"` or `"vector"`.
fn bytes_of(v: &JsValue, field: &str) -> Outcome<Vec<u8>> {
    if v.is_undefined() || v.is_null() {
        return Err(err!(
            "The Typst compiler returned nothing at all."; Invalid, Data));
    }
    if let Some(text) = driver_error(v) {
        return Err(err!("{}", text; Invalid, Data));
    }
    let got = res!(js_sys::Reflect::get(v, &JsValue::from_str(field))
        .map_err(|e| err!(
            "Reading the compiled document failed: {}.", refusal(&e); Invalid, Data)));
    if got.is_undefined() || got.is_null() {
        return Err(err!(
            "The Typst compiler reported neither a document nor an error."; Invalid, Data));
    }
    let arr = res!(got.dyn_into::<js_sys::Uint8Array>()
        .map_err(|_| err!(
            "The Typst compiler returned a document that is not a byte array."; Invalid, Data)));
    let out = arr.to_vec();
    if out.len() < 5 {
        return Err(err!(
            "The Typst compiler returned {} bytes, which is not a document.", out.len();
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
/// **Not the door for a workspace file.**  It was, until seq 117, and that is the
/// whole reason the author's book failed: the model's `typst_compile` read one
/// file and handed the string here, so a book's first `#import` failed with a
/// refusal that was accurate, well written, and about a situation the caller had
/// created for no reason.
///
/// # Arguments
/// * `source` - The whole Typst document, self-contained.
pub async fn compile(source: &str) -> Outcome<Vec<u8>> {
    let d = res!(driver());
    match JsFuture::from(d.compile(source)).await {
        Ok(v)  => bytes_of(&v, "pdf"),
        Err(e) => Err(err!("{}", refusal(&e); Invalid, Data)),
    }
}

/// Compile the project that `main_rel` belongs to, in the browser.
///
/// # Arguments
/// * `reach` - How far the closure may be followed, which is the caller's bounds.
/// * `root` - Which filesystem root the workspace path is under.
/// * `main_rel` - Workspace-relative path of the `.typ` file to compile.
pub async fn compile_project(
    reach:    &Reach<'_>,
    root:     FileRoot,
    main_rel: &str,
)
    -> Outcome<Vec<u8>>
{
    let d = res!(driver());
    let has = js_sys::Reflect::has(&d, &JsValue::from_str("compileProject")).unwrap_or(false);
    if !has {
        return Err(err!(
            "The Typst driver in this page is an older one that compiles a single file only. \
            Reload the page to pick up the current one."; System, Missing));
    }
    let project = match res!(gather(reach, root, main_rel).await) {
        Gathered::Ready(p) => p,
        Gathered::Refused { why, remedy } => {
            return Err(match remedy {
                Some(r) => err!("{}\n\n{}", why, r.line(); Invalid, Input),
                None    => err!("{}", why; Invalid, Input),
            });
        },
    };
    let arg = res!(to_js(&project));
    match JsFuture::from(d.compile_project(&arg)).await {
        Ok(v)  => bytes_of(&v, "pdf"),
        Err(e) => Err(err!("{}", refusal(&e); Invalid, Data)),
    }
}


// ── The page's door ─────────────────────────────────────────────────────────

/// Compile the project a workspace `.typ` file belongs to, for the Doc panel's
/// Compile button, resolving `{ pdf }` or `{ error, remedy }`.
///
/// The button read the source in JavaScript and handed the driver a string, which
/// is why it could only ever compile one file.  It comes through here instead, so
/// there is exactly ONE gatherer and the button and the model's `typst_compile`
/// tool cannot disagree about what a project is -- and so the reading still
/// happens on this side, under the path jail.
///
/// `remedy`, when present, is `{ action, path, line }`: something the page can
/// offer as a button rather than prose the reader has to turn into an action.
/// `action` is a stable word -- `mark-above` is the only one so far -- and `path`
/// is what it is about.
///
/// # Arguments
/// * `path` - Workspace-relative path of the `.typ` file to compile.
#[wasm_bindgen]
pub async fn typst_compile_project(path: String) -> js_sys::Object {
    page_compile(&path, Want::Pdf).await
}

/// Lay out the project a workspace `.typ` file belongs to, WITHOUT writing a PDF,
/// resolving `{ vector, watch, pages }` or `{ error, remedy }`.
///
/// The live view's door, and the whole reason it is affordable.  Measured on the
/// author's 281-page book, same compiler and same layout: writing the PDF is
/// 1834-2069 ms and laying the pages out is 235-272 ms.  A watch loop that produced
/// a PDF on every save would spend seven eighths of its life writing a file nobody
/// opens, because the reader is looking at the screen.
///
/// `watch` is the list of REAL workspace paths this compile read -- what a watcher
/// polls, and the only place real paths cross out of this module.  See
/// [`typst_watch_stamps`], which is how they come back.
///
/// # Arguments
/// * `path` - Workspace-relative path of the `.typ` file to lay out.
#[wasm_bindgen]
pub async fn typst_compile_project_vector(path: String) -> js_sys::Object {
    page_compile(&path, Want::Vector).await
}

/// Which artifact the page's door is being asked for.
enum Want {
    /// The published document: real bytes, written to disk, opened by a reader.
    Pdf,
    /// The laid-out pages, for the live view.
    Vector,
}

impl Want {

    /// The field the driver answers in, which is also the field this answers in.
    fn field(&self) -> &'static str {
        match self {
            Self::Pdf    => "pdf",
            Self::Vector => "vector",
        }
    }
}

/// Gather and compile for the PAGE -- the Compile button and the live view alike.
///
/// One gatherer, one refusal vocabulary and one remedy, whichever artifact was
/// asked for.  Two copies of this would be two answers to "what is a project", and
/// the live view would drift from the PDF it is supposed to be a preview of.
///
/// # Arguments
/// * `path` - Workspace-relative path of the `.typ` file.
/// * `want` - Which artifact to ask the driver for.
async fn page_compile(path: &str, want: Want) -> js_sys::Object {
    let obj = js_sys::Object::new();
    let set = |k: &str, v: &JsValue| {
        let _ = js_sys::Reflect::set(&obj, &JsValue::from_str(k), v);
    };
    // The page's own button is the user acting on a folder they marked in
    // themselves, so it carries the workspace's reach and not a turn's.
    let reach = Reach::Workspace;
    let gathered = match gather(&reach, FileRoot::Workspace, path).await {
        Ok(g)  => g,
        Err(e) => {
            set("error", &JsValue::from_str(&fmt!("{}", e)));
            return obj;
        },
    };
    let project = match gathered {
        Gathered::Ready(p) => p,
        Gathered::Refused { why, remedy } => {
            set("error", &JsValue::from_str(&why));
            if let Some(r) = remedy {
                let rem = js_sys::Object::new();
                let _ = js_sys::Reflect::set(
                    &rem, &JsValue::from_str("action"), &JsValue::from_str(r.action()));
                let _ = js_sys::Reflect::set(
                    &rem, &JsValue::from_str("path"), &JsValue::from_str(&r.subject()));
                let _ = js_sys::Reflect::set(
                    &rem, &JsValue::from_str("line"), &JsValue::from_str(&r.line()));
                set("remedy", &rem.into());
            }
            return obj;
        },
    };
    // The watch list goes out even when the compile then FAILS, and that is the
    // point: a broken source is exactly when a watcher most needs to know which
    // files to keep an eye on, since the next save is the one that fixes it.
    let watching = js_sys::Array::new();
    for w in project.watch.iter() { watching.push(&JsValue::from_str(w)); }
    set("watch", &watching);
    let arg = match to_js(&project) {
        Ok(a)  => a,
        Err(e) => {
            set("error", &JsValue::from_str(&fmt!("{}", e)));
            return obj;
        },
    };
    let d = match driver() {
        Ok(d)  => d,
        Err(e) => {
            set("error", &JsValue::from_str(&fmt!("{}", e)));
            return obj;
        },
    };
    let promise = match want {
        Want::Pdf    => d.compile_project(&arg),
        Want::Vector => {
            let has = js_sys::Reflect::has(&d, &JsValue::from_str("compileProjectVector"))
                .unwrap_or(false);
            if !has {
                set("error", &JsValue::from_str(
                    "The Typst driver in this page is an older one with no live view in it. \
                    Reload the page to pick up the current one."));
                return obj;
            }
            d.compile_project_vector(&arg)
        },
    };
    // THE COMPILER'S OWN WORDS, VERBATIM, AND NOT A RUST ERROR RENDERED AS ONE.
    //
    // This arm used to hand the whole resolved value to `bytes_of`, which wraps a
    // reported `{error}` in `err!()` so it can be returned as an `Outcome` -- right
    // for the model's tool, which has to return one, and wrong here, where the string
    // goes straight to a person.  `fmt!("{}", e)` on a fe2o3 error is
    // `LocalErr{[Invalid Data] "src/wasm/typst.rs:…: …"}`, ANSI escapes and all, and
    // that is what somebody pressing ⚙ Compile without the pack was shown: a Rust
    // debug dump, in English whatever their locale, in place of a sentence written
    // for them.  The error is read out FIRST and passed through untouched, which is
    // what `bytes_of`'s own doc comment always said happened.
    match JsFuture::from(promise).await {
        Ok(v) => match driver_error(&v) {
            Some(text) => set("error", &JsValue::from_str(&text)),
            None       => match bytes_of(&v, want.field()) {
                Ok(b)  => {
                    set(want.field(), &js_sys::Uint8Array::from(&b[..]).into());
                    // COMPILING IS WHAT STARTS THE WATCH, and this is where that is
                    // said -- once, at the page's own door, after a compile that
                    // WORKED.  Not a toggle, not a setting, and nothing that starts a
                    // compiler on its own: the user pressed Compile, so from here the
                    // document follows the file.  A vector compile does not re-arm it,
                    // or every rebuild would arm the loop that produced it.
                    if matches!(want, Want::Pdf) {
                        if let Ok(w) = watcher() {
                            w.began(path, &watching);
                        }
                    }
                },
                // Everything reaching here is about the SHAPE of what came back --
                // no bytes, the wrong type, a length that is not a document -- and
                // never the compiler's opinion of the source, which was taken above.
                // A fe2o3 error is the right carrier for a broken contract and the
                // wrong one for a diagnostic.
                Err(e) => set("error", &JsValue::from_str(&fmt!("{}", e))),
            },
        },
        Err(e) => set("error", &JsValue::from_str(&refusal(&e))),
    }
    obj
}

/// Reach the watcher object on `window`, or say there is none.
///
/// Absent is ORDINARY, not an error: a build with no live view in it, or a page
/// where the module has not been evaluated yet, simply compiles and shows a PDF
/// exactly as it did before.  Nothing above treats this as a failure.
fn watcher() -> Outcome<Watcher> {
    let win = res!(web_sys::window()
        .ok_or_else(|| err!("No browser window."; System, Missing)));
    let obj = res!(js_sys::Reflect::get(&win, &JsValue::from_str("DaimondTypstWatch"))
        .map_err(|e| err!("Reading window.DaimondTypstWatch failed: {}.", js_str(&e); System, Missing)));
    if obj.is_undefined() || obj.is_null() {
        return Err(err!("There is no live view on this page."; System, Missing));
    }
    Ok(obj.unchecked_into::<Watcher>())
}

/// When each of `paths` was last written, and how long it is.
///
/// The answer is one string per path, `"<lastModified>:<size>"`, in the order asked.
/// A file that is not there answers `"0:-1"`, which is a change like any other: a
/// chapter deleted under a watcher is a rebuild, not a silence.
///
/// A string rather than a pair of numbers because the only question ever asked of it
/// is whether it is the SAME as last time, and a string compares in one operation
/// with no chance of a caller comparing the modification time and forgetting the
/// size.  Two answers to "has this changed" is how one caller decides a file is
/// fresh while another decides it is stale.
///
/// **Polling is the only mechanism there is.**  The File System Access API has no
/// change events for a real folder, so a watcher on the author's own directory has
/// to ask.  Asking is cheap: sixty-three files answered in thirteen milliseconds,
/// three runs, measured in `dev/measure_typstbook.mjs`.  The test itself --
/// `lastModified` WITH `size` -- is the one `www/js/cloud.js` already uses for cloud
/// sync, deliberately, and [`opfs::stamp`] is the one place either is read.
///
/// Every path goes through the same OPFS edge as every other read, so the jail, the
/// per-account namespace and the real-folder override all apply.  A watcher cannot
/// use this to look at anything it could not already read.
///
/// # Arguments
/// * `paths` - Workspace-relative paths, as the project's `watch` handed them out.
#[wasm_bindgen]
pub async fn typst_watch_stamps(paths: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(paths.len());
    for p in paths.iter() {
        let (m, s) = match opfs::stamp(FileRoot::Workspace, p).await {
            Ok(Some(v)) => v,
            _           => (0.0, -1.0),
        };
        out.push(fmt!("{}:{}", m, s));
    }
    out
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
// refusal it is supposed to produce.  It drives them THROUGH THE MODEL'S TOOL,
// because the first version of this module was proved by calling the gatherer
// directly and passed 24 checks while production still compiled one string.
