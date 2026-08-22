//! Diamond / crystal / fold substrate — the durable core of Daimond in the
//! browser.
//!
//! A **Diamond** is a durable container for a pursuit.  Its reduced state is
//! the **crystal**, which is two files -- `crystal.json`, the memory, and
//! `crystal.html`, the page that renders it; a **fold** re-reduces a delta into
//! the memory; the **log** is per-Diamond and append-only.  This module owns the
//! OPFS layout and the pure store operations; the `#[wasm_bindgen]`
//! surface that drives the crystal and reducer agents lives on
//! [`DaimondApp`](crate::wasm::app::DaimondApp) in [`crate::wasm::app`].
//!
//! OPFS layout, per Diamond id:
//!
//! ```text
//! diamonds/<id>/crystal.json              the memory (agent writes, user may edit)
//! diamonds/<id>/crystal.html              the page that renders it
//! diamonds/<id>/versions/NNNN.json        a data snapshot per version (0-padded), EVERY version
//! diamonds/<id>/versions/NNNN.html        a page snapshot, ONLY where the page changed
//! diamonds/<id>/versions/NNNN.md          pre-migration history: read-only, never written again
//! diamonds/<id>/.daimond/meta.json        { name, crystal_version, updated, touched, tags }
//! diamonds/<id>/.daimond/log              append-only, one JSON record per line
//! diamonds/<id>/.daimond/deltas/NNNN.md   the raw delta a fold consumed, referenced by delta_ref
//! ```
//!
//! One version counter, shared by both files.  A `versions/NNNN.html` exists only at the versions
//! where the page actually changed, so the page as at version N is the highest `M <= N` that has
//! one -- see [`read_version_page`].
//!
//! Each log record is a single-line JSON object:
//! `{ id, ts, kind, agent, task, parent_crystal_version, crystal_version,
//!    delta_ref, note }` with `kind` one of `create`, `edit`, `fold`.
//!
//! The store is app-local for now (a candidate for extraction into
//! `fe2o3_data` once its shape settles, per the v1 plan's D22); it is not
//! extracted here.  Whole-file read-modify-write backs the append (the
//! synchronous single-writer OPFS path is deferred); single-user,
//! single-Diamond-at-a-time makes that sufficient for this stage.

use crate::diamond_link::{
	Link,
	Node,
	fix_legacy_kinds,
	normalise_note,
	normalise_rel,
	parse_links,
	union_links,
	update_link_in,
	write_links,
};
use crate::diamond_meta::{Meta, normalise_tags};
use crate::llm::{extract_json_string, json_escape};
use crate::protocol::generate_session_id;
use crate::tools::FileRoot;
use crate::wasm::{js_prop, js_str, opfs};

use oxedyne_fe2o3_core::prelude::*;
use oxedyne_fe2o3_core::wasm::{console_log, now_ms};

use wasm_bindgen::prelude::wasm_bindgen;
use wasm_bindgen::{JsCast, JsValue};


// ┌───────────────────────────────────────────────────────────────┐
// │ Path helpers                                                   │
// └───────────────────────────────────────────────────────────────┘

/// Daimond's own directory inside a Diamond: the metadata, the log, the deltas.
const STORE_DIR: &str = ".daimond";

/// What that directory was called before the Red -> Daimond rename, and still is in
/// every workspace made before it.  See [`migrate`].
const LEGACY_STORE_DIR: &str = ".red";

/// The Diamond root directory.
const ROOT_DIR: &str = "diamonds";

/// What the root has been called before, oldest first.
///
/// The noun has moved twice: `foci` -> `facets` -> `diamonds`. A workspace is
/// migrated straight to the current root from whichever it holds, rather than
/// hop by hop, because a user who has not opened Daimond since before the first
/// rename would otherwise need two passes and there is no reason to make them
/// take one at a time. Order matters only for the message it lets us give.
const LEGACY_ROOT_DIRS: [&str; 2] = ["foci", "facets"];

/// What a Diamond's content file was called before the brief -> crystal rename.
const LEGACY_CRYSTAL_FILE: &str = "brief.md";

/// The Diamond directory, `diamonds/<id>`.
pub fn diamond_dir(id: &str) -> String {
    fmt!("diamonds/{}", id)
}

/// The crystal's memory, `diamonds/<id>/crystal.json`.
fn crystal_data_path(id: &str) -> String {
    fmt!("diamonds/{}/{}", id, crate::tools::CRYSTAL_DATA_FILE)
}

/// The crystal's page, `diamonds/<id>/crystal.html`.
fn crystal_page_path(id: &str) -> String {
    fmt!("diamonds/{}/{}", id, crate::tools::CRYSTAL_PAGE_FILE)
}

/// The crystal as it was before the migration, `diamonds/<id>/crystal.md`.
///
/// Read only, and only as the last thing tried: it is what a Diamond holds until [`list`] has
/// converted it, and what one holds for ever if the conversion could not be written.
fn crystal_legacy_path(id: &str) -> String {
    fmt!("diamonds/{}/{}", id, crate::tools::CRYSTAL_FILE_LEGACY)
}

/// The append-only log, `diamonds/<id>/.daimond/log`.
fn log_path(id: &str) -> String {
    fmt!("diamonds/{}/{}/log", id, STORE_DIR)
}

/// The metadata file, `diamonds/<id>/.daimond/meta.json`.
fn meta_path(id: &str) -> String {
    fmt!("diamonds/{}/{}/meta.json", id, STORE_DIR)
}

/// The directory a Diamond's snapshots live in, `diamonds/<id>/versions`.
fn versions_dir(id: &str) -> String {
    fmt!("diamonds/{}/versions", id)
}

/// A data snapshot, `diamonds/<id>/versions/NNNN.json`.  Written at every version.
fn version_data_path(id: &str, version: u64) -> String {
    fmt!("{}/{:04}.json", versions_dir(id), version)
}

/// A page snapshot, `diamonds/<id>/versions/NNNN.html`.
///
/// Written only at the versions where the page actually changed, because a page is presentation
/// and does not move on most edits: copying it into every snapshot would multiply the one file in
/// a Diamond that nothing folds and nothing reduces.
fn version_page_path(id: &str, version: u64) -> String {
    fmt!("{}/{:04}.html", versions_dir(id), version)
}

/// A snapshot from before the crystal became data, `diamonds/<id>/versions/NNNN.md`.
///
/// READ-ONLY, for ever.  Nothing writes one again; the history view renders what is there as the
/// markdown it is, and a version from before the migration has one of these and neither of the
/// other two.
fn version_legacy_path(id: &str, version: u64) -> String {
    fmt!("{}/{:04}.md", versions_dir(id), version)
}

/// A stored raw delta, `diamonds/<id>/.daimond/deltas/NNNN.md`, keyed by the
/// crystal version the fold produced.
fn delta_path(id: &str, version: u64) -> String {
    fmt!("diamonds/{}/{}/deltas/{:04}.md", id, STORE_DIR, version)
}


// ┌───────────────────────────────────────────────────────────────┐
// │ Migration                                                      │
// └───────────────────────────────────────────────────────────────┘

/// Is there an EARLIER Diamond root whose entries have NOT been taken over?
///
/// After [`migrate_root`]'s merge, this is true only of a genuine id collision -- an id
/// present in both roots, which is the one case the merge leaves alone.  It used to answer
/// the much larger question "is there an old root that will now never be found", which the
/// merge has made unaskable.
pub async fn legacy_root_waiting() -> Outcome<bool> {
    for legacy in LEGACY_ROOT_DIRS.iter() {
        let entries = match opfs::list_dir(FileRoot::Opfs, legacy).await {
            Ok(e)  => e,
            Err(_) => continue,         // no such root here
        };
        if entries.iter().any(|(_, is_dir, _)| *is_dir) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Bring the Diamond root forward from `foci/` or `facets/` to `diamonds/`, so a workspace
/// made before the Focus -> Diamond rename opens with every pursuit intact.
///
/// This runs before [`list`] reads the root, and before the per-Diamond [`migrate`], because
/// everything below depends on the new root existing.  Without it a user's Foci would simply
/// not be found: `list_dir("diamonds")` would fail, the rail would come up empty, and every
/// crystal, version and fold record would read as though it had never existed.
///
/// Idempotent, and it never clobbers.  A workspace already migrated has nothing to move.  A
/// workspace holding BOTH roots has the entries that do not collide moved across, and the
/// ones that do left exactly where they are.
///
/// THE MERGE REPLACES A REFUSAL.  Until 2026-08-07 a workspace that arrived holding both
/// roots was left alone entirely, which sounds cautious and is not: the old root is a
/// directory nothing reads, so those Diamonds were invisible for ever -- and the state was
/// reachable by an ordinary sequence of events, since creating a single Diamond makes
/// `diamonds/` exist and a backup, a sync from an older device or a folder adopted afterwards
/// can each bring an older root along later.  Moving an entry whose id is not already in
/// `diamonds/` overwrites nothing, so it is strictly safer than leaving it unreachable.  A
/// genuine id collision is the one case where merging really could lose work, and it is the
/// one case this does not attempt.
///
/// Returns whether anything moved.
async fn migrate_root() -> Outcome<bool> {
    let mut moved = false;
    // Newest legacy root first, so a workspace somehow holding both is taken from
    // the one nearer to current and the older one merges around what it left.
    for legacy in LEGACY_ROOT_DIRS.iter().rev() {
        if !res!(opfs::exists(FileRoot::Opfs, legacy).await) {
            continue;
        }
        if res!(migrate_one_root(legacy).await) {
            moved = true;
        }
    }
    Ok(moved)
}

/// Take `legacy` over into `diamonds/`, whole if it can and entry by entry if it cannot.
async fn migrate_one_root(legacy: &str) -> Outcome<bool> {
    crate::wasm::entry::trail("migrate_one_root", legacy);
    // Nothing to merge into: the whole directory in one move.  Cheaper, and it
    // carries anything a `list_dir` walk would not report.
    if !res!(opfs::exists(FileRoot::Opfs, ROOT_DIR).await) {
        res!(opfs::move_entry(FileRoot::Opfs, legacy, ROOT_DIR).await);
        let ids = match opfs::list_dir(FileRoot::Opfs, ROOT_DIR).await {
            Ok(e)  => e.into_iter().filter(|(_, d, _)| *d).map(|(n, _, _)| n).collect(),
            Err(_) => Vec::new(),       // moved, but nothing to walk
        };
        res!(rewrite_delta_refs(legacy, &ids).await);
        return Ok(true);
    }

    // Both roots. Move what does not collide; leave what does.
    let entries = match opfs::list_dir(FileRoot::Opfs, legacy).await {
        Ok(e)  => e,
        Err(_) => return Ok(false),
    };
    let mut ids: Vec<String> = Vec::new();
    let mut collisions = 0usize;
    for (name, is_dir, _size) in entries {
        if !is_dir {
            continue;
        }
        let to = fmt!("{}/{}", ROOT_DIR, name);
        if res!(opfs::exists(FileRoot::Opfs, &to).await) {
            // The same id in both roots.  Which copy is the user's current work is
            // not answerable from here, and overwriting the one they can see with
            // one they cannot is the loss this whole function exists to avoid.
            collisions += 1;
            console_log(&fmt!(
                "A Diamond '{}' is in both '{}' and '{}'; the older copy is left where it is.",
                name, legacy, ROOT_DIR,
            ));
            continue;
        }
        let from = fmt!("{}/{}", legacy, name);
        res!(opfs::move_entry(FileRoot::Opfs, &from, &to).await);
        ids.push(name);
    }
    if ids.is_empty() && collisions > 0 {
        return Ok(false);
    }
    res!(rewrite_delta_refs(legacy, &ids).await);
    // An emptied legacy root is deleted, so the next boot has nothing to walk and
    // `legacy_root_waiting` stops reporting a root that holds nothing.  One that
    // still holds a collision stays, because it still holds the user's work.
    if collisions == 0 {
        if let Err(e) = opfs::delete_entry(FileRoot::Opfs, legacy, true).await {
            console_log(&fmt!("The emptied '{}' root could not be removed: {}.", legacy, e));
        }
    }
    Ok(!ids.is_empty())
}

/// Point every moved Diamond's log at its deltas under the new root.
///
/// A log record's `delta_ref` holds a *path* written when the fold was applied, so every
/// historical record still names `legacy/<id>/`; left alone, "view this delta" would fail on
/// every fold the user has.
async fn rewrite_delta_refs(legacy: &str, ids: &[String]) -> Outcome<()> {
    for id in ids {
        // The log is wherever this Diamond's store currently is, and a workspace
        // old enough to predate the Red -> Daimond rename may still be on
        // `.red/` -- [`migrate`] has not run yet, and cannot, because it
        // addresses the new root this function is only now creating. So both are
        // tried: looking only at `.daimond/` would skip exactly the oldest
        // workspaces, leaving their `delta_ref` paths pointing at a root that no
        // longer exists, which no later migration would match either.
        for store in [STORE_DIR, LEGACY_STORE_DIR] {
            let log = fmt!("{}/{}/{}/log", ROOT_DIR, id, store);
            if !res!(opfs::exists(FileRoot::Opfs, &log).await) {
                continue;
            }
            let bytes = res!(opfs::read_file(FileRoot::Opfs, &log).await);
            let text  = String::from_utf8_lossy(&bytes).to_string();
            let fixed = text.replace(
                &fmt!("{}/{}/", legacy, id),
                &fmt!("{}/{}/", ROOT_DIR, id),
            );
            if fixed != text {
                res!(opfs::write_file(FileRoot::Opfs, &log, fixed.as_bytes()).await);
            }
        }
    }
    Ok(())
}


/// Rename a Diamond's content file from `brief.md` to `crystal.md`.
///
/// The file holds the whole of what a Diamond knows, so this is the single most
/// destructive thing in the migration to get wrong: a Diamond whose crystal is not
/// found reads as an empty one, and an agent handed an empty crystal will happily
/// write a new one over the top of work it never saw.
///
/// Idempotent, and it never clobbers: a Diamond already migrated has no
/// `brief.md`, and one holding both files is left alone rather than merged.
async fn migrate_crystal_file(id: &str) -> Outcome<bool> {
    let old = fmt!("{}/{}/{}", ROOT_DIR, id, LEGACY_CRYSTAL_FILE);
    let new = crystal_legacy_path(id);
    if !res!(opfs::exists(FileRoot::Opfs, &old).await) {
        return Ok(false);
    }
    if res!(opfs::exists(FileRoot::Opfs, &new).await) {
        return Ok(false);
    }
    res!(opfs::move_entry(FileRoot::Opfs, &old, &new).await);
    Ok(true)
}


/// Convert a Diamond's crystal from markdown to data: `crystal.md` -> `crystal.json`.
///
/// Runs where [`migrate_crystal_file`] runs, on the same trigger, and carries the same two
/// properties for the same reason.  **Idempotent**: a Diamond already converted has a
/// `crystal.json`, and the second check below is what sees it -- the markdown is kept, so the
/// absence of the OLD file is not what makes this safe to re-run.  **It never clobbers**: a
/// Diamond holding both files is left exactly as it is rather than merged, because which of the
/// two is the user's current work is not answerable from here, and overwriting the one they can
/// see is the loss this whole function exists to avoid.
///
/// The conversion is [`crate::tools::crystal_from_markdown`], which enforces losslessness rather
/// than promising it: a shape it cannot render back byte for byte goes into one section verbatim.
/// It is still the most destructive thing in the migration to get wrong -- a Diamond whose crystal
/// is not found reads as an empty one, and an agent handed an empty crystal will write a new one
/// over the top of work it never saw.
///
/// **THE MARKDOWN IS KEPT.**  An earlier draft of this deleted `crystal.md` once the data was
/// written and read back, to save a migrated Diamond carrying two live crystals in every sync
/// parcel.  That trade is the wrong way round, and the asymmetry is the reason:
///
/// * The cost of keeping it is small and measured.  A real workspace was thirteen Diamonds in
///   15,786 bytes; doubling a crystal doubles a very small number.
/// * The cost of deleting it is unbounded.  The self-check proves the BYTES round-trip and cannot
///   prove the STRUCTURE is right -- a `##` inside a fenced code block rejoins to the same bytes
///   whether or not the fence was honoured -- so a conversion can be wrong in a way nothing here
///   detects.  Deleting on that would destroy the only correct copy, on every device, at the
///   moment of the release that introduced the bug.
/// * And it would not stay local.  [`import_diamond`] deletes a Diamond's directory before
///   rewriting it, so a bad conversion propagates back over a good copy on the next sync.  That is
///   the shape this project has already lost a user's tags to.
///
/// A later release removes the markdown, once the conversion has run against real workspaces
/// without complaint.  Nothing reads it while `crystal.json` is there; it is ballast, and ballast
/// is cheap.
///
/// The data snapshot is written here too, at the version the Diamond already stands at, so
/// `versions/NNNN.json` exists from the migration instant rather than from the next edit.  It is
/// written only where there is not one already, on the same never-clobber rule as everything else
/// in this function, and a Diamond whose metadata will not parse simply does not get one -- a
/// backfill is a convenience and must not be able to fail a migration.
///
/// # Arguments
/// * `id` - The Diamond whose crystal is to be converted.
async fn migrate_crystal_data(id: &str) -> Outcome<bool> {
    let old = crystal_legacy_path(id);
    let new = crystal_data_path(id);
    if !res!(opfs::exists(FileRoot::Opfs, &old).await) {
        return Ok(false);       // converted already, or a Diamond newer than markdown
    }
    if res!(opfs::exists(FileRoot::Opfs, &new).await) {
        return Ok(false);       // both present: not ours to reconcile, and not ours to destroy
    }
    let bytes = res!(opfs::read_file(FileRoot::Opfs, &old).await);
    let md    = String::from_utf8_lossy(&bytes).to_string();
    let json  = crate::tools::crystal_from_markdown(&md).to_json();
    res!(opfs::write_file(FileRoot::Opfs, &new, json.as_bytes()).await);

    // The backfill. Best-effort throughout: the conversion has already succeeded by this point,
    // and a Diamond that is converted but unsnapshotted is in a state `read_crystal_data` handles
    // -- it falls through to the markdown history -- while a migration that reported failure
    // would be re-run for ever over a file that is already there.
    if let Ok(meta) = read_meta(id).await {
        let at = version_data_path(id, meta.version);
        match opfs::exists(FileRoot::Opfs, &at).await {
            Ok(false) => {
                if let Err(e) = opfs::write_file(FileRoot::Opfs, &at, json.as_bytes()).await {
                    console_log(&fmt!(
                        "Diamond '{}' was converted, but version {} could not be snapshotted as \
                         data: {}. Its markdown snapshot still stands.", id, meta.version, e));
                }
            }
            _ => {},        // already there, or unreadable: either way, not ours to overwrite
        }
    }
    Ok(true)
}


/// Move a Diamond's store from `.red/` to `.daimond/`, so a workspace made before the
/// rename opens with its history intact.
///
/// Without this a renamed Daimond simply would not find the old directory: [`read_meta`]
/// would fail, [`list`] would skip the Diamond, and a real pursuit -- its crystal versions, its
/// whole fold history -- would read as though it had never existed.  The crystal itself
/// (`crystal.json` and `crystal.html`) and its snapshots sit *outside* the store directory and are
/// untouched either way; what moves here is the metadata, the log and the retained deltas.
///
/// The log's `delta_ref` field holds a *path*, written when the fold was applied, so the
/// records are rewritten as the directory moves -- otherwise every historical delta would
/// still point into `.red/` and "view this delta" would fail on exactly the folds the user
/// has had longest.
///
/// Idempotent, and it never clobbers: a Diamond already migrated has no `.red/` to move, and
/// one that somehow holds both directories is left entirely alone rather than merged.
/// Returns whether anything moved.
///
/// # Arguments
/// * `id` - The Diamond whose store is to be migrated.
async fn migrate(id: &str) -> Outcome<bool> {
    let old = fmt!("diamonds/{}/{}", id, LEGACY_STORE_DIR);
    let new = fmt!("diamonds/{}/{}", id, STORE_DIR);
    if !res!(opfs::exists(FileRoot::Opfs, &old).await) {
        return Ok(false);       // nothing to move: a new Diamond, or one already migrated
    }
    if res!(opfs::exists(FileRoot::Opfs, &new).await) {
        return Ok(false);       // both present: not ours to reconcile, and not ours to destroy
    }
    res!(opfs::move_entry(FileRoot::Opfs, &old, &new).await);

    // The log points at the deltas by path, and the deltas have just moved.
    let log = log_path(id);
    if res!(opfs::exists(FileRoot::Opfs, &log).await) {
        let bytes = res!(opfs::read_file(FileRoot::Opfs, &log).await);
        let text  = String::from_utf8_lossy(&bytes).to_string();
        let fixed = text.replace(
            &fmt!("diamonds/{}/{}/deltas/", id, LEGACY_STORE_DIR),
            &fmt!("diamonds/{}/{}/deltas/", id, STORE_DIR),
        );
        if fixed != text {
            res!(opfs::write_file(FileRoot::Opfs, &log, fixed.as_bytes()).await);
        }
    }
    Ok(true)
}


/// Read the crystal's memory as it stood at `version`.
///
/// Every fold and every hand-edit snapshots the crystal, but nothing has ever
/// read one back, so an accepted fold that mangled the crystal could not be
/// undone.  This is what makes the history recoverable rather than merely
/// recorded.
///
/// A version from before the migration has a `.md` and no `.json`, and it is returned as the
/// markdown it is: the caller renders what it is given rather than being told which it got, which
/// is what "the history view renders that as it always did" costs.
pub async fn read_version(id: &str, version: u64) -> Outcome<String> {
    if let Ok(bytes) = opfs::read_file(FileRoot::Opfs, &version_data_path(id, version)).await {
        return Ok(String::from_utf8_lossy(&bytes).to_string());
    }
    let bytes = res!(opfs::read_file(FileRoot::Opfs, &version_legacy_path(id, version)).await);
    Ok(String::from_utf8_lossy(&bytes).to_string())
}

/// Read the PAGE as it stood at `version`, by walking back to the last one that changed it.
///
/// **This walk is the whole cost of not copying the page into every snapshot.**  A
/// `versions/NNNN.html` is written only where the page actually moved, so most versions have
/// none, and asking for the page at one of those is not asking for nothing -- it is asking for
/// whatever page was on screen at the time, which is the last one written at or before it.  Read
/// naively, every version between two page edits would report a Diamond with no page at all, and
/// the history view would show the built-in fallback for stretches where the user was looking at
/// their own page the whole time.
///
/// An empty string means no page was ever stored at or before that version, which is what every
/// pre-migration version says.  Nothing here invents a default: the shipped page is a JS const,
/// and this stores bytes.
///
/// # Arguments
/// * `id` - The Diamond.
/// * `version` - The version to read the page as at.
pub async fn read_version_page(id: &str, version: u64) -> Outcome<String> {
    // One directory walk rather than a read per version stepping backwards.  A Diamond at version
    // 300 whose page never changed would otherwise cost 300 failed OPFS reads to answer "none",
    // on the device least able to afford them.
    let at = snapshot_versions(id, ".html").await
        .into_iter()
        .filter(|n| *n <= version)
        .max();
    let n = match at {
        Some(n) => n,
        None    => return Ok(String::new()),
    };
    let bytes = res!(opfs::read_file(FileRoot::Opfs, &version_page_path(id, n)).await);
    Ok(String::from_utf8_lossy(&bytes).to_string())
}

/// Every version a Diamond holds a snapshot for with the given extension, unordered.
///
/// A name that does not parse is somebody else's file and is passed over rather than guessed at.
/// A missing `versions/` directory is no snapshots, not a failure: a Diamond older than they are,
/// or one that has been emptied.
///
/// # Arguments
/// * `id` - The Diamond.
/// * `ext` - The extension including its dot: `.json`, `.html` or `.md`.
async fn snapshot_versions(id: &str, ext: &str) -> Vec<u64> {
    let entries = match opfs::list_dir(FileRoot::Opfs, &versions_dir(id)).await {
        Ok(e)  => e,
        Err(_) => return Vec::new(),
    };
    let mut out: Vec<u64> = Vec::new();
    for (name, is_dir, _size) in entries {
        if is_dir {
            continue;
        }
        if let Some(n) = name.strip_suffix(ext).and_then(|s| s.parse::<u64>().ok()) {
            out.push(n);
        }
    }
    out
}


// ┌───────────────────────────────────────────────────────────────┐
// │ Metadata                                                       │
// └───────────────────────────────────────────────────────────────┘

/// Read a Diamond's metadata.
/// The most a `meta.json` may be worth reading.
///
/// It holds a name, a version, two stamps, at most eight tags of at most
/// twenty-four characters, and a short list of toolkit names. A kilobyte is a
/// generous one; sixty-four is beyond argument. Anything past this is damage.
const META_MAX: u32 = 65_536;

/// A Diamond's name, read back off its own crystal.
///
/// The last resort for a Diamond whose `meta.json` lost its name. A crystal carries a `title` by
/// construction — the default Diamonds are written that way, the migration lifts it out of the
/// opening `# ` heading, and every fold is asked to keep it — so it is the one place the name
/// survives outside the metadata. [`read_crystal_data`] already falls back through the version
/// snapshots and through a legacy markdown crystal, so this reaches even a Diamond whose crystal
/// file has gone.
///
/// The `# ` scan stays as the second try, for a Diamond holding markdown that no conversion has
/// reached — this runs inside [`list`], which is also where the conversion runs, and the order of
/// two repairs over one file is not a thing to depend on.
///
/// Returns `None` rather than a guess when there is neither to read: an
/// invented name would be worse than an empty one, because the user could not
/// tell it from the name they chose.
async fn name_from_crystal(id: &str) -> Option<String> {
    let text = read_crystal_data(id).await.ok()?;
    if let Some(title) = extract_json_string(&text, "title") {
        let name: String = title.trim().chars().take(80).collect();
        if !name.is_empty() {
            return Some(name);
        }
    }
    for line in text.lines().take(20) {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("# ") {
            let name: String = rest.trim().chars().take(80).collect();
            if !name.is_empty() {
                return Some(name);
            }
        }
    }
    None
}

/// Read a Diamond's metadata, WITHOUT trusting the file's size.
///
/// THIS IS THE iPHONE LOOP. Two of one user's fifteen Diamonds had a `meta.json`
/// of roughly 117 MB and 702 MB, and this function read them whole — twice over,
/// because `from_utf8_lossy().to_string()` copies again. The device's own trail
/// caught it in the act:
///
///     list entry 19fb11892cdc heap 1M
///     HEAP GREW  read_meta +234M -> 235M
///     …
///     HEAP GREW  read_meta +1404M -> 1639M
///     boot                                  <- the tab is gone
///
/// Wasm linear memory never shrinks, so 1.6 GB stood for the life of the tab and
/// iOS took it away — on every boot, which is the whole of the login loop that
/// ran for five sessions and produced seven wrong diagnoses.
///
/// So the size is asked BEFORE the bytes are, and only the front of an oversized
/// file is read. That is a graceful degradation rather than a refusal: `to_json`
/// writes `name`, `crystal_version`, `updated` and `touched` FIRST, so a 64 KB
/// prefix still recovers everything that orders the rail and drives the merge.
/// What is lost is tags — which is the right thing to lose, because the tags
/// array is the only unbounded field in the file and therefore the prime
/// suspect for what made it enormous.
///
/// A Diamond whose metadata is damaged must still LIST and still OPEN. Dropping
/// it would be answering a bug the user can report with one they can only mourn.
async fn read_meta(id: &str) -> Outcome<Meta> {
    let (bytes, total) = res!(opfs::read_file_capped(FileRoot::Opfs, &meta_path(id), META_MAX).await);
    if total > META_MAX as f64 {
        // Loud, and in the durable trail: this is data damage, the user cannot
        // see it, and the next write is about to heal it silently.
        crate::wasm::entry::trail("META HUGE",
            &fmt!("{} is {}KB — read the first {}KB only", id,
                (total / 1024.0) as u64, META_MAX / 1024));
        console_log(&fmt!(
            "Diamond '{}' has a metadata file of {} bytes, which cannot be right. Only the first \
             {} were read; its tags are dropped and will be rewritten on the next change.",
            id, total as u64, META_MAX));
    }
    let s = String::from_utf8_lossy(&bytes);
    if total > META_MAX as f64 {
        // THE SHAPE OF THE DAMAGE, BEFORE THE REPAIR ERASES IT.
        //
        // The repair below is about to rewrite this file, and once it has, the
        // only record of what went wrong is gone. What is still not known is how
        // a metadata file reached 702 MB: forty million short tags, or one
        // enormous one, or a `name` that grew, are three different bugs with
        // three different fixes.
        //
        // COUNTS AND LENGTHS ONLY, never the text of a tag. A tag is something
        // the user typed, and `breadcrumb.js` promises the trail holds nothing
        // that could not be read aloud in a bug report. The shape answers the
        // question and the content is not needed for it.
        let prefix = &s[..s.len().min(META_MAX as usize)];
        let quotes = prefix.matches('"').count();
        let commas = prefix.matches(',').count();
        let tags_at = prefix.find("\"tags\":").map(|i| i as i64).unwrap_or(-1);
        let name_len = extract_json_string(prefix, "name").map(|n| n.len()).unwrap_or(0);
        crate::wasm::entry::trail("META SHAPE",
            &fmt!("{} name={}B tags@{} quotes={} commas={} in first {}KB",
                id, name_len, tags_at, quotes, commas, META_MAX / 1024));
    }
    let meta = Meta::from_json(&s);
    if total > META_MAX as f64 {
        // AND PUT IT RIGHT, HERE, rather than waiting for something else to
        // write. A read that merely tolerates the damage leaves 702 MB on disk
        // for ever, and the file's SIZE has consequences of its own: the sync
        // budget is estimated from bytes on disk (`export_size`), so an
        // unrepaired Diamond is one the account can never send again. The user
        // saw exactly that — the loop stopped and a notice said fifteen Diamonds
        // would not fit.
        //
        // Safe because `to_json` writes the name, the version and both stamps
        // FIRST, so the 64 KB prefix carried all of them; what is dropped is the
        // tags array, which is the damage. Best-effort: a repair that cannot be
        // written must not stop the Diamond being listed.
        // AND NEVER OVER A NAME IT COULD NOT READ. If the prefix did not yield a
        // name, the parse did not find what it expected and the file is not the
        // shape assumed here. Keeping 702 MB on disk is a bad outcome; replacing
        // a Diamond's name with nothing is a worse one, and it is not reversible.
        // The oversized file stays, `read_meta` keeps coping with it, and the
        // trail says the repair declined.
        if meta.name.trim().is_empty() {
            crate::wasm::entry::trail("META NOT HEALED", &fmt!("{} — no name parsed, file left alone", id));
        } else {
            match write_meta(id, &meta).await {
                Ok(())  => crate::wasm::entry::trail("META HEALED", id),
                Err(e)  => console_log(&fmt!("Diamond '{}' could not have its metadata repaired: {}", id, e)),
            }
        }
    }
    Ok(meta)
}

/// Write a Diamond's metadata.
async fn write_meta(id: &str, meta: &Meta) -> Outcome<()> {
    opfs::write_file(FileRoot::Opfs, &meta_path(id), meta.to_json().as_bytes()).await
}

/// Stamp a Diamond as changed, without saying it was worked on.
///
/// Every mutation of anything inside `diamonds/<id>/` moves `touched`, because
/// `touched` is what decides whose copy the other device takes.  A change that
/// moved nothing would simply not travel: the merge would find the two copies
/// equally fresh and keep its own, which is how tagging used to be invisible
/// across devices -- and worse, how a later stamped edit on the other device
/// came to look strictly fresher and replace the tagged copy wholesale.
///
/// `updated` is left alone here, deliberately.  It means *worked on* and orders
/// the rail; the callers that mean that (see [`rename`], [`snapshot`]) move it
/// themselves.
pub async fn touch(id: &str) -> Outcome<()> {
    let mut meta = res!(read_meta(id).await);
    meta.touched = now_ms() as u64;
    write_meta(id, &meta).await
}


// ┌───────────────────────────────────────────────────────────────┐
// │ Log records                                                    │
// └───────────────────────────────────────────────────────────────┘

/// One append-only log record.  `parent` uses `-1` for "no parent"
/// (the `create` record), matching the JSON the surface returns.
struct LogRecord {
    id:        String,
    ts:        u64,
    kind:      &'static str,
    agent:     String,
    task:      String,
    parent:    i64,
    version:   u64,
    delta_ref: String,
    note:      String,
}

impl LogRecord {

    /// Serialise to a compact single-line JSON object.
    fn to_json(&self) -> String {
        fmt!(
            "{{\"id\":\"{}\",\"ts\":{},\"kind\":\"{}\",\"agent\":\"{}\",\
              \"task\":\"{}\",\"parent_crystal_version\":{},\
              \"crystal_version\":{},\"delta_ref\":\"{}\",\"note\":\"{}\"}}",
            json_escape(&self.id), self.ts, self.kind, json_escape(&self.agent),
            json_escape(&self.task), self.parent, self.version,
            json_escape(&self.delta_ref), json_escape(&self.note),
        )
    }
}

/// Append a record to a Diamond's log.
///
/// OPFS exposes whole-file writes only, so the append is read-modify-write
/// (single-user, single-Diamond makes that safe for this stage; the
/// synchronous single-writer WAL is deferred).
async fn append_log(id: &str, rec: &LogRecord) -> Outcome<()> {
    let path = log_path(id);
    let mut buf = match opfs::exists(FileRoot::Opfs, &path).await {
        Ok(true) => {
            let bytes = res!(opfs::read_file(FileRoot::Opfs, &path).await);
            String::from_utf8_lossy(&bytes).to_string()
        }
        _ => String::new(),
    };
    buf.push_str(&rec.to_json());
    buf.push('\n');
    opfs::write_file(FileRoot::Opfs, &path, buf.as_bytes()).await
}


// ┌───────────────────────────────────────────────────────────────┐
// │ Diamond operations                                               │
// └───────────────────────────────────────────────────────────────┘

/// Create a Diamond: its directory, an empty `crystal.json`, version `0000`, a
/// `meta.json`, and a `create` log record.  Returns the new Diamond id.
///
/// No page.  A new Diamond renders on the shipped default until something writes one, and the
/// default is a JS const that this side never sees; writing an empty `crystal.html` here would
/// only put a file on disk that means the same as no file.
pub async fn create(name: &str) -> Outcome<String> {
    create_at(name, &generate_session_id()).await
}

/// Create a Diamond AT A KNOWN ID, or answer with the id if one is already there.
///
/// **This exists because a random id and a per-device flag cannot agree across a sync.** The two
/// default Diamonds are seeded by every device separately -- the "already seeded" fact lives in
/// `localStorage`, which does not travel -- and each minted its own random id, so two devices
/// produced two Optimisers and two Helps, and the merge kept all four. The name check in
/// `seedDefaultDiamonds` never saw it, because it reads the local list and the other device's
/// copy has not arrived yet.
///
/// Seeding at a fixed id makes the two devices create the SAME object, so the merge has one thing
/// to keep rather than two things to add. No flag, no coordination, no ordering.
///
/// It is idempotent by construction: a second call finds the meta already written and returns
/// without touching the crystal, so a device that seeds twice cannot flatten what the first pass
/// or the user has since put there.
///
/// # Arguments
/// * `name` - The Diamond's name.
/// * `id` - The id to create it at. Hex, in the shape [`generate_session_id`] produces.
pub async fn create_at(name: &str, id: &str) -> Outcome<String> {
    // ALREADY THERE IS A SUCCESS, and it must not rewrite anything: this is the path a second
    // device takes, and by then the Diamond may hold a crystal somebody has worked on.
    if read_meta(id).await.is_ok() {
        return Ok(id.to_string());
    }
    create_fresh(name, id).await
}

async fn create_fresh(name: &str, id: &str) -> Outcome<String> {
    let id = id.to_string();
    let now = now_ms() as u64;

    // Empty crystal plus its version-0 snapshot.
    res!(opfs::write_file(FileRoot::Opfs, &crystal_data_path(&id), b"").await);
    res!(opfs::write_file(FileRoot::Opfs, &version_data_path(&id, 0), b"").await);

    let meta = Meta {
        name:    name.to_string(),
        version: 0,
        updated: now,
        touched: now,
        tags:    Vec::new(),
        // Off by default, which is the whole shape of a grant: nobody has said yes yet.
        kits:    Vec::new(),
    };
    res!(write_meta(&id, &meta).await);

    let rec = LogRecord {
        id:        generate_session_id(),
        ts:        now,
        kind:      "create",
        agent:     "user".to_string(),
        task:      "create diamond".to_string(),
        parent:    -1,
        version:   0,
        delta_ref: String::new(),
        note:      name.to_string(),
    };
    res!(append_log(&id, &rec).await);
    Ok(id)
}

/// Rename a Diamond, updating `meta.json`'s name and both its stamps.
pub async fn rename(id: &str, name: &str) -> Outcome<()> {
    let now = now_ms() as u64;
    let mut meta = res!(read_meta(id).await);
    meta.name = name.to_string();
    meta.updated = now;
    meta.touched = now;
    res!(write_meta(id, &meta).await);
    Ok(())
}

/// Set a Diamond's tags, replacing whatever it held, and stamp it updated.
///
/// The tags are normalised here rather than taken on trust, so the store stays
/// clean whatever the caller sends (see
/// [`normalise_tags`](crate::diamond_meta::normalise_tags)).
///
/// Nothing is appended to the log, because the log is the crystal's audit trail
/// and a tag is not crystal state.  Tagging leaves the version alone.
///
/// It leaves `updated` alone too, which is deliberate.  The rail is ordered by
/// `updated`, meaning most recently worked on; filing is not working on it, so
/// tagging must not reorder the rail.  Otherwise tidying a few Diamonds in one
/// sitting would shuffle them all to the top and lose the order that was the
/// point of the sort.  This is why it differs from `rename`, which does stamp.
///
/// It does move `touched`, because the tags are content and content has to
/// travel.  While there was one stamp this could not be had both ways: leaving
/// it alone meant the tags never reached the other device AND that the other
/// device's untagged copy became strictly fresher the moment anything there was
/// renamed or edited, at which point the merge replaced the tagged copy with it
/// and the tags were gone.  A user lost real tags that way.
pub async fn set_tags(id: &str, tags: &[String]) -> Outcome<()> {
    let mut meta = res!(read_meta(id).await);
    meta.tags = normalise_tags(tags);
    meta.touched = now_ms() as u64;
    res!(write_meta(id, &meta).await);
    Ok(())
}

/// Set which toolchains this Diamond is granted, replacing whatever it held.
///
/// Stamped and normalised exactly as [`set_tags`] is, and for the same two reasons: filing a
/// permission is not working on the Diamond, so the rail must not reorder; and the grant is content
/// that has to reach the user's other devices, so `touched` moves.
///
/// The names are normalised here rather than taken on trust (see
/// [`normalise_kits`](crate::diamond_meta::normalise_kits)) -- and unlike a tag, a name this build
/// does not know is dropped, because what is stored here decides what a command may reach outside
/// the workspace and a grant nobody can act on is not a grant.
///
/// # Arguments
/// * `id` - The Diamond.
/// * `kits` - The toolkit names the user granted, as `Toolkit::name` spells them.
pub async fn set_toolkits(id: &str, kits: &[String]) -> Outcome<()> {
    let mut meta = res!(read_meta(id).await);
    meta.kits = crate::diamond_meta::normalise_kits(kits);
    meta.touched = now_ms() as u64;
    res!(write_meta(id, &meta).await);
    Ok(())
}

/// Delete a Diamond: remove its whole directory (crystal, versions, log, meta).
pub async fn delete(id: &str) -> Outcome<()> {
    opfs::delete_entry(FileRoot::Opfs, &diamond_dir(id), true).await
}

/// List every Diamond, returning a JSON array of
/// `{ id, name, crystal_version, updated, touched, tags }` ordered by
/// most-recently updated first.
///
/// Both stamps travel in the row because they answer different questions: the
/// order below is `updated` (worked on), while the cross-device merge compares
/// `touched` (changed at all).
///
/// This is the one door every Diamond passes through before it can be opened, so it is where
/// a workspace made before the rename is migrated (see [`migrate`]).  A Diamond that fails to
/// migrate is left in the list rather than dropped from it: the metadata read below decides
/// that, and a Diamond the user can see and cannot open is a bug they can report, while one
/// that has silently vanished is a bug they can only mourn.
pub async fn list() -> Outcome<String> {
    // INSTRUMENTED, because this is the call that hangs on one iPhone and a hang
    // has nothing to report: no error, no panic, just a `Promise` that never
    // settles. Four diagnoses were made from reading this file and all four were
    // wrong. The lines below are what the device says about itself.
    crate::wasm::entry::trail("list_diamonds", "start");

    // Before the root is read, because before the rename the root itself was elsewhere.
    crate::wasm::entry::trail("list", "migrate_root");
    if let Err(e) = migrate_root().await {
        console_log(&fmt!("The diamonds/ root could not be migrated from an earlier one: {}", e));
    }
    // A missing `diamonds/` root simply means no Diamonds yet.
    let entries = match opfs::list_dir(FileRoot::Opfs, ROOT_DIR).await {
        Ok(e)  => e,
        Err(_) => { crate::wasm::entry::trail("list", "no diamonds/ root"); return Ok("[]".to_string()); },
    };
    crate::wasm::entry::trail("list", &fmt!("{} entries", entries.len()));
    let mut rows: Vec<(String, Meta)> = Vec::new();
    for (name, is_dir, _size) in entries {
        if !is_dir {
            continue;
        }
        // THE HEAP, PER CALL, AND THIS IS WHY.
        //
        // The phone's trail settled that wasm linear memory reaches 1639 MB
        // inside this loop and that the tab is killed a second later. It reaches
        // 235 MB across the first three entries and 1639 MB across the next four,
        // and it does so with the sync engine switched off — so the walk itself is
        // the whole of it. What the trail could NOT say is which of the three
        // calls below allocates, because they were one line together.
        //
        // Growth only, and only when it crosses a megabyte, so an ordinary walk
        // writes one row per entry rather than four. Six diagnoses of this bug
        // were made by reading source and all six were wrong; this is the line
        // that makes a seventh unnecessary.
        let mut was = crate::wasm::entry::heap_mb();
        crate::wasm::entry::trail("list entry", &fmt!("{} heap {}M", name, was));
        let grew = |phase: &str, was: &mut u32| {
            let now = crate::wasm::entry::heap_mb();
            if now > *was {
                crate::wasm::entry::trail("HEAP GREW", &fmt!("{} +{}M -> {}M", phase, now - *was, now));
                *was = now;
            }
        };
        // Before the metadata is read, because before the rename it was somewhere else.
        if let Err(e) = migrate(&name).await {
            console_log(&fmt!("Diamond '{}' could not be migrated to .daimond/: {}", name, e));
        }
        grew("migrate", &mut was);
        // And before the crystal is read, because it was called brief.md.
        if let Err(e) = migrate_crystal_file(&name).await {
            console_log(&fmt!("Diamond '{}' could not have its crystal renamed: {}", name, e));
        }
        grew("migrate_crystal", &mut was);
        // And then, on the same trigger and for the same reason, because it was markdown.
        if let Err(e) = migrate_crystal_data(&name).await {
            console_log(&fmt!("Diamond '{}' could not have its crystal converted: {}", name, e));
        }
        grew("migrate_crystal_data", &mut was);
        let mut meta = match read_meta(&name).await {
            Ok(m)  => m,
            Err(_) => continue, // not a Diamond dir / no metadata
        };
        grew("read_meta", &mut was);
        // A NAMELESS DIAMOND GETS ITS NAME BACK OFF ITS OWN CRYSTAL.
        //
        // This exists because a repair of mine destroyed fifteen of them. An
        // earlier build rebuilt every imported `meta.json` and wrote whatever it
        // parsed, so one sync left a user with fifteen tiles carrying nothing but
        // a cog. The guards in `import_diamond` and `read_meta` stop it happening
        // again; this is what puts right the accounts it already happened to.
        //
        // The crystal opens `# <name>` — `seedDefaultDiamonds` writes it that way
        // and so does every fold — so the heading is the name, recoverable from
        // the one file a Diamond certainly has. Written back, so it costs one
        // read per damaged Diamond once and nothing ever again.
        if meta.name.trim().is_empty() {
            if let Some(from_crystal) = name_from_crystal(&name).await {
                crate::wasm::entry::trail("NAME RECOVERED", &name);
                meta.name = from_crystal;
                if let Err(e) = write_meta(&name, &meta).await {
                    console_log(&fmt!("Diamond '{}' could not keep its recovered name: {}", name, e));
                }
            }
        }
        rows.push((name, meta));
    }
    // Most-recently updated first.
    rows.sort_by(|a, b| b.1.updated.cmp(&a.1.updated));
    let items: Vec<String> = rows.iter().map(|(id, m)| {
        fmt!(
            "{{\"id\":\"{}\",\"name\":\"{}\",\"crystal_version\":{},\"updated\":{},\
              \"touched\":{},\"tags\":{},\"toolkits\":{}}}",
            json_escape(id), json_escape(&m.name), m.version, m.updated,
            m.touched, m.tags_json(), m.kits_json(),
        )
    }).collect();
    Ok(fmt!("[{}]", items.join(",")))
}

/// Read a Diamond's current crystal data, as the JSON text it is stored as.
///
/// A Diamond that LISTS must OPEN.  [`list`] admits one on its metadata alone -- deliberately, so
/// that a broken Diamond is a bug the user can report rather than one they can only mourn -- and
/// this used to be a bare read, so a Diamond whose crystal was missing threw `NotFoundError`
/// at the panel and could not be opened at all.  Four live paths arrive at that state, an
/// interrupted import among them.
///
/// So the version snapshots are used for what they have always been: the store's own redundancy.
/// Four things are tried, in this order, and the order is the whole point:
///
/// 1. `crystal.json`, which is where it should be.
/// 2. The newest `versions/NNNN.json`, the store's own copy of the same bytes.
/// 3. A legacy markdown crystal -- `crystal.md`, then the newest `versions/NNNN.md` -- converted
///    on the way out.  This reaches a Diamond that has never been through [`list`], one whose
///    conversion could not be written, and -- because [`migrate_crystal_data`] deliberately keeps
///    the markdown rather than deleting it -- any migrated Diamond that later loses its data file.
/// 4. Empty, with a console line saying so.
///
/// **The last of those is the most destructive failure in this whole change**, which is why there
/// are three things before it: a Diamond whose crystal is not found reads as an empty one, and an
/// agent handed an empty crystal will happily write a new one over the top of work it never saw.
pub async fn read_crystal_data(id: &str) -> Outcome<String> {
    if let Ok(bytes) = opfs::read_file(FileRoot::Opfs, &crystal_data_path(id)).await {
        return Ok(String::from_utf8_lossy(&bytes).to_string());
    }
    if let Some((n, json)) = res!(newest_version(id, ".json").await) {
        console_log(&fmt!(
            "Diamond '{}' has no crystal.json; read version {} instead.", id, n));
        return Ok(json);
    }
    // The markdown a migration has not reached, or could not finish.  Converted rather than
    // returned as it stands, because every caller above this now reads data.
    if let Ok(bytes) = opfs::read_file(FileRoot::Opfs, &crystal_legacy_path(id)).await {
        console_log(&fmt!(
            "Diamond '{}' still has a markdown crystal; it is read as data without being \
             converted on disk.", id));
        let md = String::from_utf8_lossy(&bytes).to_string();
        return Ok(crate::tools::crystal_from_markdown(&md).to_json());
    }
    if let Some((n, md)) = res!(newest_version(id, ".md").await) {
        console_log(&fmt!(
            "Diamond '{}' has no crystal at all; markdown version {} is read as data instead.",
            id, n));
        return Ok(crate::tools::crystal_from_markdown(&md).to_json());
    }
    console_log(&fmt!(
        "Diamond '{}' has no crystal and no version to fall back on; it opens empty.", id));
    Ok(String::new())
}

/// Read a Diamond's current page, or empty when it has none.
///
/// Empty is an ordinary answer and not a failure: a Diamond created before pages existed has no
/// `crystal.html`, and one whose page was reset has whatever the caller supplies instead.  **Rust
/// never sees the default page** -- it is a JS const, so the protocol and the page that speaks it
/// live in one file -- so this reports the absence and the caller fills it.
///
/// The snapshots back it up exactly as they back the data up, through the walk in
/// [`read_version_page`], so a page lost from its own file is recovered from the last version
/// that changed it.
pub async fn read_crystal_page(id: &str) -> Outcome<String> {
    if let Ok(bytes) = opfs::read_file(FileRoot::Opfs, &crystal_page_path(id)).await {
        return Ok(String::from_utf8_lossy(&bytes).to_string());
    }
    // Unreadable metadata means no page, not a throw. A Diamond that LISTS must OPEN, and the
    // panel opening on the built-in view beats it not opening at all.
    let at = match read_meta(id).await {
        Ok(m)  => m.version,
        Err(_) => return Ok(String::new()),
    };
    read_version_page(id, at).await
}

/// The page a Diamond has on disk right now, with no fallback of any kind.
///
/// [`read_crystal_page`] reaches for a snapshot when the file is not there, which is right for a
/// reader and wrong for [`snapshot`]: a recovered page is not a page the user changed, and
/// treating it as one would write a fresh page snapshot at a version where nothing moved.
async fn page_on_disk(id: &str) -> String {
    match opfs::read_file(FileRoot::Opfs, &crystal_page_path(id)).await {
        Ok(bytes) => String::from_utf8_lossy(&bytes).to_string(),
        Err(_)    => String::new(),
    }
}

/// The highest-numbered snapshot a Diamond holds with the given extension, with its text.
///
/// The numbering is zero-padded and monotonic, so the highest that PARSES is the newest.
///
/// # Arguments
/// * `id` - The Diamond.
/// * `ext` - The extension including its dot: `.json` for data, `.md` for pre-migration history.
async fn newest_version(id: &str, ext: &str) -> Outcome<Option<(u64, String)>> {
    let n = match snapshot_versions(id, ext).await.into_iter().max() {
        Some(n) => n,
        None    => return Ok(None),
    };
    let path = fmt!("{}/{:04}{}", versions_dir(id), n, ext);
    let bytes = res!(opfs::read_file(FileRoot::Opfs, &path).await);
    Ok(Some((n, String::from_utf8_lossy(&bytes).to_string())))
}

/// Snapshot a new crystal version and return its number.
///
/// **The two files are snapshotted on different rules, and that asymmetry is the design.**  The
/// data is written at every version, so `versions/NNNN.json` exists for every N from the migration
/// onward and the history is complete without a walk.  The page is written only where its bytes
/// differ from the page as at the PARENT version -- not from the file on disk, which the daimon
/// may already have overwritten during the turn being recorded.  Most edits do not touch the page,
/// and copying it into every snapshot would multiply the one file in a Diamond that nothing folds
/// and nothing reduces.
///
/// The other door on the two ceilings.  `Tool::FileWrite` and `Tool::FileEdit` catch a daimon
/// growing either file past its cap; this catches a hand edit and a fold, which reach the files
/// through the store instead and would otherwise walk straight past the rule.
///
/// # Arguments
/// * `id` - The Diamond.
/// * `data` - The crystal data this version holds.
/// * `page` - The page this version holds, or `None` for whatever is on disk -- which is what a
///   turn that edited the page through the file tools leaves behind.
/// * `now` - The stamp both `updated` and `touched` take.
async fn snapshot(id: &str, data: &str, page: Option<&str>, now: u64) -> Outcome<u64> {
    let old = opfs::read_file(FileRoot::Opfs, &crystal_data_path(id)).await
        .map(|b| b.len())
        .unwrap_or(0);
    if crate::tools::crystal_write_refused(data.len(), old) {
        return Err(err!("{}", crate::tools::crystal_cap_message(data.len()); Invalid, Input, Size));
    }
    let disk = page_on_disk(id).await;
    let want: &str = page.unwrap_or(disk.as_str());
    if crate::tools::crystal_page_write_refused(want.len(), disk.len()) {
        return Err(err!("{}", crate::tools::crystal_page_cap_message(want.len());
            Invalid, Input, Size));
    }

    let mut meta = res!(read_meta(id).await);
    let next = meta.version + 1;
    // Against the parent version rather than against the file, so a page the daimon wrote itself
    // during the turn is still recognised as a change and still gets its snapshot.
    let changed = want != res!(read_version_page(id, meta.version).await);

    res!(opfs::write_file(FileRoot::Opfs, &crystal_data_path(id), data.as_bytes()).await);
    res!(opfs::write_file(FileRoot::Opfs, &version_data_path(id, next), data.as_bytes()).await);
    if want != disk {
        res!(opfs::write_file(FileRoot::Opfs, &crystal_page_path(id), want.as_bytes()).await);
    }
    if changed {
        res!(opfs::write_file(FileRoot::Opfs, &version_page_path(id, next), want.as_bytes()).await);
    }

    meta.version = next;
    meta.updated = now;
    meta.touched = now;        // a new crystal is both work and a change
    res!(write_meta(id, &meta).await);
    Ok(next)
}

/// Apply a user hand-edit to the crystal's data: snapshot a new version and log an
/// `edit` record.
///
/// The page is left exactly as it is, so an edit to the memory does not cost a page snapshot.
pub async fn write_crystal_data(id: &str, json: &str) -> Outcome<()> {
    let now = now_ms() as u64;
    let parent = res!(read_meta(id).await).version;
    let version = res!(snapshot(id, json, None, now).await);
    let rec = LogRecord {
        id:        generate_session_id(),
        ts:        now,
        kind:      "edit",
        agent:     "user".to_string(),
        task:      "edit crystal".to_string(),
        parent:    parent as i64,
        version:   version,
        delta_ref: String::new(),
        note:      String::new(),
    };
    append_log(id, &rec).await
}

/// Replace a Diamond's page: snapshot a new version and log an `edit` record.
///
/// A version of its own, sharing the one counter with the data, because a page IS the Diamond as
/// the user meets it: a page edit that could not be undone would be the one change in a Diamond
/// with no way back.  The data is carried through unchanged and still snapshotted, which is what
/// keeps `versions/NNNN.json` complete for every N.
///
/// # Arguments
/// * `id` - The Diamond.
/// * `html` - The page, self-contained; empty resets it to nothing and lets the caller's default
///   stand.
pub async fn write_crystal_page(id: &str, html: &str) -> Outcome<()> {
    let now = now_ms() as u64;
    let parent = res!(read_meta(id).await).version;
    let data = res!(read_crystal_data(id).await);
    let version = res!(snapshot(id, &data, Some(html), now).await);
    let rec = LogRecord {
        id:        generate_session_id(),
        ts:        now,
        kind:      "edit",
        agent:     "user".to_string(),
        task:      "edit crystal page".to_string(),
        parent:    parent as i64,
        version:   version,
        delta_ref: String::new(),
        note:      String::new(),
    };
    append_log(id, &rec).await
}

/// Write both halves of a crystal as ONE version: one version number, one snapshot pair, one log
/// record.
///
/// For a restore and for a backup import, which set the data and the page together and are one
/// action as far as the person doing them is concerned.  Doing it as
/// [`write_crystal_data`] followed by [`write_crystal_page`] works and writes two versions, so the
/// history shows two rows for one click -- and neither row is wrong, which is what makes it worth
/// fixing rather than tolerating.  The log is the record of a Diamond's discontinuities, and a
/// reader counting them would count one restore as two.
///
/// The page still obeys the rule the other paths obey, because [`snapshot`] owns it: a page whose
/// bytes match the parent version's writes no `.html` at all, so restoring a version whose page
/// never differed costs nothing extra.
///
/// **`html` is taken literally, empty included.**  Restoring a version from before pages existed
/// means passing an empty page, and that is what the Diamond looked like -- so the page goes back
/// to none and the caller's default renders.  A caller that would rather keep the page it has
/// should pass the page it has; this does not guess which was meant.
///
/// # Arguments
/// * `id` - The Diamond.
/// * `json` - The crystal data to put at the head.
/// * `html` - The page to put at the head; empty leaves the Diamond with no page of its own.
pub async fn write_crystal_both(id: &str, json: &str, html: &str) -> Outcome<()> {
    let now = now_ms() as u64;
    let parent = res!(read_meta(id).await).version;
    let version = res!(snapshot(id, json, Some(html), now).await);
    let rec = LogRecord {
        id:        generate_session_id(),
        ts:        now,
        kind:      "edit",
        agent:     "user".to_string(),
        task:      "edit crystal and page".to_string(),
        parent:    parent as i64,
        version:   version,
        delta_ref: String::new(),
        note:      String::new(),
    };
    append_log(id, &rec).await
}

/// Record that this Diamond's daimon changed model, in the crystal's own history.
///
/// A Diamond's primary model may be changed at any time, and because the daimon is
/// meant to be persistent the change ends one daimon and starts another.  That is a
/// discontinuity in the Diamond, so it is written where the Diamond's other
/// discontinuities are written rather than left as a silent flip of a browser setting.
///
/// The crystal is snapshotted UNCHANGED.  There is nothing to edit -- the crystal is
/// what the old daimon left and what the new one inherits -- and the version exists so
/// that "what did this Diamond look like when it was still on the old model" is a
/// question with an answer.
///
/// # Arguments
/// * `id` - The Diamond.
/// * `note` - What changed, in the user's own language, for the history row to show.
pub async fn record_model_change(id: &str, note: &str) -> Outcome<()> {
    let now = now_ms() as u64;
    let meta = res!(read_meta(id).await);
    let parent = meta.version;
    let crystal = res!(read_crystal_data(id).await);
    let version = res!(snapshot(id, &crystal, None, now).await);
    let rec = LogRecord {
        id:        generate_session_id(),
        ts:        now,
        kind:      "model",
        agent:     "user".to_string(),
        task:      "change model".to_string(),
        parent:    parent as i64,
        version:   version,
        delta_ref: String::new(),
        note:      note.to_string(),
    };
    append_log(id, &rec).await
}

/// Record a crystal change made by the crystal agent (a steer that edited
/// `crystal.json`, or `crystal.html`, or both): snapshot a version and log an `edit` record whose
/// task is the instruction.  Called by [`crate::wasm::app`] after the agent turn,
/// only when the crystal actually changed.
///
/// The page is not an argument, because the turn has already written it: [`snapshot`] takes
/// whatever is on disk and compares it with the parent version, which is how a turn that changed
/// only the page still earns a page snapshot.
pub async fn record_steer(id: &str, json: &str, instruction: &str) -> Outcome<()> {
    let now = now_ms() as u64;
    let parent = res!(read_meta(id).await).version;
    let version = res!(snapshot(id, json, None, now).await);
    let rec = LogRecord {
        id:        generate_session_id(),
        ts:        now,
        kind:      "edit",
        agent:     "crystal-agent".to_string(),
        task:      instruction.to_string(),
        parent:    parent as i64,
        version:   version,
        delta_ref: String::new(),
        note:      String::new(),
    };
    append_log(id, &rec).await
}

/// Apply a confirmed fold: write the new crystal, snapshot a version, store
/// the raw delta under `.daimond/deltas/`, and append a `fold` record that
/// references the stored delta.  Advisory-fold discipline: this runs only
/// after the user accepts the proposed crystal; the raw delta is always
/// retained.
pub async fn fold_apply(id: &str, new_crystal: &str, delta: &str, note: &str) -> Outcome<()> {
    let now = now_ms() as u64;
    let parent = res!(read_meta(id).await).version;
    let version = res!(snapshot(id, new_crystal, None, now).await);

    // Retain the raw delta, referenced by the log record.
    let dref = delta_path(id, version);
    res!(opfs::write_file(FileRoot::Opfs, &dref, delta.as_bytes()).await);

    let rec = LogRecord {
        id:        generate_session_id(),
        ts:        now,
        kind:      "fold",
        agent:     "reducer".to_string(),
        task:      "fold delta".to_string(),
        parent:    parent as i64,
        version:   version,
        delta_ref: dref,
        note:      note.to_string(),
    };
    append_log(id, &rec).await
}

/// Read a Diamond's log as a JSON array of records (each stored line is
/// already a JSON object).
pub async fn log_read(id: &str) -> Outcome<String> {
    let path = log_path(id);
    let bytes = match opfs::exists(FileRoot::Opfs, &path).await {
        Ok(true) => res!(opfs::read_file(FileRoot::Opfs, &path).await),
        _        => return Ok("[]".to_string()),
    };
    let text = String::from_utf8_lossy(&bytes);
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    Ok(fmt!("[{}]", lines.join(",")))
}


// ┌───────────────────────────────────────────────────────────────┐
// │ Links                                                          │
// └───────────────────────────────────────────────────────────────┘

/// A Diamond's link sidecar, `diamonds/<id>/.daimond/links.jsonl`.
///
/// It sits beside the log rather than inside `crystal.json` for two reasons.  A
/// fold rewrites the crystal wholesale -- the reducer is asked for the new crystal
/// and returns the whole of it -- so anything structural kept in there is
/// at a model's mercy on every fold.  And the crystal is handed to the conductor
/// and to every worker it dispatches, so a growing list of links would be paid
/// for in tokens on every turn, by agents that have the file tools anyway.
fn links_path(id: &str) -> String {
    fmt!("{}/{}/{}/links.jsonl", ROOT_DIR, id, STORE_DIR)
}

/// Read one Diamond's links.  A missing sidecar is no links, not a failure.
pub async fn read_links(id: &str) -> Outcome<Vec<Link>> {
    let path = links_path(id);
    if !res!(opfs::exists(FileRoot::Opfs, &path).await) {
        return Ok(Vec::new());
    }
    let bytes = res!(opfs::read_file(FileRoot::Opfs, &path).await);
    let text  = String::from_utf8_lossy(&bytes).to_string();

    // A sidecar written before the rename names its ends `facet:<id>` -- what a
    // Diamond was called when the link substrate shipped. The
    // substrate keeps an unknown kind rather than refusing it, so those links
    // would survive -- but they would survive pointing at a kind nothing
    // resolves any more, which is a link that renders as a dead end rather than
    // as the Diamond it means. Rewriting on read is enough: the file is
    // rewritten whenever a link is added or removed, and until then the
    // in-memory view is already correct.
    let fixed = fix_legacy_kinds(&text);
    if fixed != text {
        res!(opfs::write_file(FileRoot::Opfs, &path, fixed.as_bytes()).await);
    }
    Ok(parse_links(&fixed))
}

/// Write one Diamond's links, replacing the sidecar.
async fn write_links_for(id: &str, links: &[Link]) -> Outcome<()> {
    opfs::write_file(FileRoot::Opfs, &links_path(id), write_links(links).as_bytes()).await
}

/// Assert a link from one node to another, and return its id.
///
/// The record is stored once, on the Diamond named by `from` when that end is a
/// Diamond, and otherwise on `owner`.  It is never written twice: a link is found
/// from either end by [`links_touching`], which is what makes the graph two-way
/// without a second copy to keep consistent.
///
/// # Arguments
/// * `owner` - The Diamond whose sidecar holds the record.
/// * `from`  - The end the link is asserted from, as `kind:rest`.
/// * `to`    - The end it points at, as `kind:rest`.
/// * `rel`   - What kind of relation it is; may be empty.
/// * `note`  - A free sentence about it; may be empty.
/// * `by`    - Who asserted it: `user`, or `agent:<name>`.
pub async fn add_link(
    owner: &str,
    from:  &str,
    to:    &str,
    rel:   &str,
    note:  &str,
    by:    &str,
)
    -> Outcome<String>
{
    let from_node = match Node::parse(from) {
        Some(n) => n,
        None    => return Err(err!("'{}' is not a kind:rest reference.", from; Invalid, Input)),
    };
    let to_node = match Node::parse(to) {
        Some(n) => n,
        None    => return Err(err!("'{}' is not a kind:rest reference.", to; Invalid, Input)),
    };
    // A link from a thing to itself says nothing, and would draw a loop on
    // every view that ever renders this.
    if from_node == to_node {
        return Err(err!("A link joins two different things."; Invalid, Input));
    }
    let link = Link {
        id:   generate_session_id(),
        ts:   now_ms() as u64,
        from: from_node,
        to:   to_node,
        rel:  normalise_rel(rel),
        note: normalise_note(note),
        by:   if by.trim().is_empty() { fmt!("user") } else { by.trim().to_string() },
    };
    let id = link.id.clone();
    let mut links = res!(read_links(owner).await);
    links.push(link);
    res!(write_links_for(owner, &links).await);
    // The sidecar rides inside the owner's directory, so a link is part of what
    // that Diamond IS, and the merge carries the directory whole.  Without the
    // stamp the new link would not travel, and the other device's copy would
    // eventually come back over it carrying the links it had instead.
    touch_after_link(owner).await;
    Ok(id)
}

/// Whether a Diamond is actually here, judged by the one file every Diamond has.
///
/// Written for the link tools, and needed because they let something OTHER than the page
/// choose the owner.  Every earlier caller of [`add_link`] passed an id it had just read off
/// the rail; a model passes a string it wrote, and a mistyped one would have a sidecar
/// written for it -- which creates the directory, and [`all_links`] walks directories rather
/// than the rail, so the graph would gain links belonging to a Diamond nothing lists.  That
/// is the same hazard [`union_links_from`] guards against, arriving from the other side.
pub async fn diamond_exists(id: &str) -> bool {
    if id.trim().is_empty() {
        return false;
    }
    opfs::exists(FileRoot::Opfs, &meta_path(id)).await.unwrap_or(false)
}

/// Revise the relation and note of a link already in a Diamond's sidecar.
/// Returns whether anything moved.
///
/// The store had `add_link` and `remove_link` and nothing between them, so every
/// surface that let a person correct a relation did it by deleting the record and
/// asserting a fresh one -- a new id and a new `ts`.  That loses the one fact
/// nothing else holds: when the two things were FIRST said to be related.  A
/// relation is a judgement about a joining that already existed, and refining the
/// judgement is not a new joining.  [`update_link_in`] therefore edits the record
/// in place and this writes it back.
///
/// The ends are not revisable: a link between two OTHER things is a new claim and
/// costs a new record, which [`add_link`] already makes.
///
/// Nothing is written when nothing moved, and that is load-bearing rather than an
/// optimisation.  A write stamps the Diamond, the merge reads that stamp, and a
/// no-op that stamped would make this device the fresher copy for having done
/// nothing -- carrying its whole directory over a real edit made elsewhere.
///
/// **A revision does not travel by [`union_links_from`].**  The union keys on the
/// id and keeps the copy already held, precisely so a link is never merged field
/// by field; what carries a revision is the stamp, and the wholesale merge that
/// reads it -- exactly as for [`remove_link`].
///
/// # Arguments
/// * `owner`   - The Diamond whose sidecar holds the record.
/// * `link_id` - The link to revise.
/// * `rel`     - The relation it should now carry; may be empty.
/// * `note`    - The note it should now carry; may be empty.
pub async fn update_link(owner: &str, link_id: &str, rel: &str, note: &str) -> Outcome<bool> {
    let mut links = res!(read_links(owner).await);
    if !update_link_in(&mut links, link_id, rel, note) {
        return Ok(false);
    }
    res!(write_links_for(owner, &links).await);
    touch_after_link(owner).await;      // the sidecar changed; see [`add_link`]
    Ok(true)
}

/// Remove a link from a Diamond's sidecar.  Returns whether one went.
pub async fn remove_link(owner: &str, link_id: &str) -> Outcome<bool> {
    let links = res!(read_links(owner).await);
    let kept: Vec<Link> = links.iter().filter(|l| l.id != link_id).cloned().collect();
    if kept.len() == links.len() {
        return Ok(false);
    }
    res!(write_links_for(owner, &kept).await);
    touch_after_link(owner).await;      // the sidecar changed; see [`add_link`]
    Ok(true)
}

/// Take into a Diamond's sidecar every link another device's copy of it holds
/// and this one does not.  True when something was written.
///
/// The merge carries a Diamond wholesale on the freshest copy, and refuses to
/// choose when the two are equally fresh.  Equally fresh with different links is
/// exactly the state a build that stamped nothing when a link changed used to
/// leave behind, and no wholesale choice can repair it: whichever copy is
/// picked, the other's links go.  A union can, because links are a set of
/// records with ids, and taking both copies' records is not a judgement about
/// either -- the same reasoning that lets tags be unioned (see
/// [`set_tags`]).
///
/// It settles.  Writing stamps the Diamond, so this side becomes the fresher one
/// and the union travels back to be taken wholesale; an import lays the stamps
/// down verbatim, so nothing bounces back again; and once the two sidecars agree
/// [`union_links`] adds nothing, nothing is written and no stamp moves.
///
/// It cannot resurrect a deletion.  [`remove_link`] stamps the Diamond, so the
/// copy that lost the link is the fresher one and is taken wholesale, and this
/// is reached only where neither copy is fresher.  What it can repair is
/// therefore only the divergence the missing stamp left behind, which is what it
/// is for.
///
/// # Arguments
/// * `owner`   - The Diamond whose sidecar is being reconciled.
/// * `sidecar` - The other device's copy of it, as stored text.
pub async fn union_links_from(owner: &str, sidecar: &str) -> Outcome<bool> {
    // Another device's file, so the same fixup a read applies: a link arriving
    // under the old kind is the same link, and writing it down unrepaired would
    // put a dead end in a file this device had already cleaned.
    let theirs = parse_links(&fix_legacy_kinds(sidecar));
    if theirs.is_empty() {
        return Ok(false);
    }
    // A Diamond that is not here is not one to write a sidecar for.  Writing
    // would create the directory, and [`all_links`] walks directories rather
    // than the rail, so the graph would gain links belonging to a Diamond
    // nothing lists -- and the stamp afterwards would fail anyway, there being
    // no metadata to move.
    if !res!(opfs::exists(FileRoot::Opfs, &meta_path(owner)).await) {
        return Ok(false);
    }
    let mine = res!(read_links(owner).await);
    let merged = match union_links(&mine, &theirs) {
        Some(m) => m,
        None    => return Ok(false),        // they agree: write nothing, stamp nothing
    };
    res!(write_links_for(owner, &merged).await);
    touch_after_link(owner).await;
    Ok(true)
}

/// Stamp the owner of a sidecar that has just changed, best effort.
///
/// Best effort because the link is already written: a Diamond whose `meta.json`
/// cannot be read is one whose link should still exist here, and failing the
/// call after the fact would tell the caller nothing happened when something
/// did.  What is lost is that the link may not travel until the Diamond is
/// changed again, which is the same position it was in before this existed.
async fn touch_after_link(owner: &str) {
    if let Err(e) = touch(owner).await {
        console_log(&fmt!("Diamond '{}' could not be stamped after a link changed: {}", owner, e));
    }
}

/// Every link touching `node`, from whichever Diamond's sidecar holds it.
///
/// This is the read that makes the links two-way.  A record is stored once, in
/// one direction, so what points AT something is found by scanning rather than
/// by keeping a mirrored copy -- there is no second copy to fall out of step,
/// and a link hand-written into either end's sidecar counts just the same.
///
/// The scan walks every Diamond, which is the same walk [`list`] already does on
/// each load of the rail.
pub async fn links_touching(node_ref: &str) -> Outcome<Vec<(String, Link)>> {
    let node = match Node::parse(node_ref) {
        Some(n) => n,
        None    => return Err(err!("'{}' is not a kind:rest reference.", node_ref; Invalid, Input)),
    };
    let mut out: Vec<(String, Link)> = Vec::new();
    let entries = match opfs::list_dir(FileRoot::Opfs, ROOT_DIR).await {
        Ok(e)  => e,
        Err(_) => return Ok(out),
    };
    for (id, is_dir, _size) in entries {
        if !is_dir {
            continue;
        }
        // One unreadable sidecar must not hide every other Diamond's links.
        let links = match read_links(&id).await {
            Ok(l)  => l,
            Err(e) => {
                console_log(&fmt!("Diamond '{}' has an unreadable link sidecar: {}", id, e));
                continue;
            }
        };
        for l in links {
            if l.touches(&node) {
                out.push((id.clone(), l));
            }
        }
    }
    Ok(out)
}

/// Every link in the store, as the JSON array the surface returns.
///
/// One walk of `diamonds/` answers the whole graph, where asking node by node
/// would walk the store once per Diamond and read every sidecar as many times
/// over.  The walk is [`links_touching`]'s, with the node test dropped.
///
/// Each entry carries the Diamond whose sidecar holds the record, exactly as
/// [`links_json`] does, so a caller can delete a link without searching for it.
/// There is no `other` field: no one end was asked about, so neither end is the
/// other one.
pub async fn all_links() -> Outcome<String> {
    let entries = match opfs::list_dir(FileRoot::Opfs, ROOT_DIR).await {
        Ok(e)  => e,
        Err(_) => return Ok("[]".to_string()),
    };
    let mut items: Vec<String> = Vec::new();
    for (id, is_dir, _size) in entries {
        if !is_dir {
            continue;
        }
        // One unreadable sidecar must not hide every other Diamond's links.
        let links = match read_links(&id).await {
            Ok(l)  => l,
            Err(e) => {
                console_log(&fmt!("Diamond '{}' has an unreadable link sidecar: {}", id, e));
                continue;
            }
        };
        for l in links {
            items.push(fmt!(
                "{{\"owner\":\"{}\",\"id\":\"{}\",\"ts\":{},\"from\":\"{}\",\"to\":\"{}\",\
                  \"rel\":\"{}\",\"note\":\"{}\",\"by\":\"{}\"}}",
                json_escape(&id), json_escape(&l.id), l.ts,
                json_escape(&l.from.to_ref()), json_escape(&l.to.to_ref()),
                json_escape(&l.rel), json_escape(&l.note), json_escape(&l.by),
            ));
        }
    }
    Ok(fmt!("[{}]", items.join(",")))
}

/// Every link touching `node`, as the JSON array the surface returns.
///
/// Each entry carries the Diamond whose sidecar holds the record, so a caller can
/// delete it without searching for it again, and `other` -- the end that is not
/// the one asked about -- so a view has what it draws without re-deriving the
/// direction.
pub async fn links_json(node_ref: &str) -> Outcome<String> {
    let node = match Node::parse(node_ref) {
        Some(n) => n,
        None    => return Err(err!("'{}' is not a kind:rest reference.", node_ref; Invalid, Input)),
    };
    let found = res!(links_touching(node_ref).await);
    let items: Vec<String> = found.iter().map(|(owner, l)| {
        fmt!(
            "{{\"owner\":\"{}\",\"id\":\"{}\",\"ts\":{},\"from\":\"{}\",\"to\":\"{}\",\
              \"rel\":\"{}\",\"note\":\"{}\",\"by\":\"{}\",\"other\":\"{}\"}}",
            json_escape(owner), json_escape(&l.id), l.ts,
            json_escape(&l.from.to_ref()), json_escape(&l.to.to_ref()),
            json_escape(&l.rel), json_escape(&l.note), json_escape(&l.by),
            json_escape(&l.other(&node).map(|n| n.to_ref()).unwrap_or_default()),
        )
    }).collect();
    Ok(fmt!("[{}]", items.join(",")))
}


// ┌───────────────────────────────────────────────────────────────┐
// │ Whole-directory export / import                                │
// └───────────────────────────────────────────────────────────────┘

/// Whether a path from an export addresses something inside the Diamond.
///
/// The paths in an export were written by another device, so they are checked
/// rather than trusted: a `..` component would climb out of `diamonds/<id>/`
/// and land the file in some other Diamond, or beside them all.
fn is_safe_rel(rel: &str) -> bool {
    if rel.is_empty() || rel.starts_with('/') || rel.contains('\\') {
        return false;
    }
    rel.split('/').all(|c| !c.is_empty() && c != "." && c != "..")
}

/// Export a whole Diamond as JSON:
/// `{"id":..,"touched":..,"files":{"<path>":"<content>",..}}`, each path
/// relative to `diamonds/<id>/`.
///
/// Filesystem-level on purpose rather than field by field.  Everything a
/// Diamond *is* lives under its directory -- the crystal, every version
/// snapshot, the metadata, the log, the retained deltas, the link sidecar -- so
/// a per-Diamond file added later travels with it and nothing carrying a
/// Diamond about has to learn the new file's name.  Every file is read as text,
/// which is what all of them are.
///
/// The paths come out sorted, so two exports of an unchanged Diamond are the
/// same bytes and a caller comparing states sees no change where there is none.
///
/// `touched` -- when anything under the directory last changed -- is repeated at
/// the top level, so a carrier can tell two copies apart without opening a file
/// inside the pack.  It is a copy of what `.daimond/meta.json` says, not a
/// second source of truth: an import lays the file down verbatim and the file
/// wins from then on.
/// What [`export_diamond`] would weigh, WITHOUT building it.
///
/// The sync builds a parcel under a byte budget, and it used to find out whether
/// a Diamond fitted by exporting it and measuring the result -- so every Diamond
/// was materialised in full, and the ones over budget were thrown away after the
/// fact. The budget capped what was SENT and not what was HELD.
///
/// On this machine that is invisible. On a phone with fifteen Diamonds carrying
/// un-pruned version history it is the whole store in memory at once, which is
/// what an iPhone's tab is killed for. `list_dir` already reports each entry's
/// size, so the answer costs a directory walk and not one byte of content.
///
/// An OVER-estimate by design: the JSON envelope and escaping only ever add to
/// it, so a Diamond this says fits might still be trimmed by the caller, and one
/// it says does not fit certainly does not.
pub async fn export_size(id: &str) -> Outcome<u64> {
    let root = diamond_dir(id);
    if !res!(opfs::exists(FileRoot::Opfs, &root).await) {
        return Ok(0);
    }
    let mut total: u64 = 0;
    let mut todo: Vec<String> = vec![String::new()];
    while let Some(rel) = todo.pop() {
        let dir = if rel.is_empty() { root.clone() } else { fmt!("{}/{}", root, rel) };
        let entries = match opfs::list_dir(FileRoot::Opfs, &dir).await {
            Ok(e)  => e,
            Err(_) => continue,
        };
        for (name, is_dir, size) in entries {
            let child = if rel.is_empty() { name.clone() } else { fmt!("{}/{}", rel, name) };
            if is_dir {
                todo.push(child);
            } else {
                // The path travels in the envelope too, and a Diamond with many
                // version files carries a lot of path.  A binary file travels as base64, which is
                // four bytes for every three, so the allowance is made for every file: it keeps this
                // an over-estimate without a second directory walk to find out which are which.
                let weight = size.saturating_mul(4) / 3;
                total = total.saturating_add(weight).saturating_add(child.len() as u64);
            }
        }
    }
    Ok(total)
}

pub async fn export_diamond(id: &str) -> Outcome<String> {
    let files = res!(diamond_files(id).await);
    // A Diamond with no readable metadata still exports; it simply carries no
    // stamp, and a carrier falls back to whatever the pack itself says.
    let touched = read_meta(id).await.map(|m| m.touched).unwrap_or(0);
    Ok(crate::protocol::pack_diamond(id, touched, &files))
}

/// Every file under `diamonds/<id>/`, by its path relative to it.
///
/// Bytes, not text.  What each file IS, is decided by [`crate::protocol::pack_diamond`], which is
/// the one place that knows the pack's shape and the one place a test can reach.
async fn diamond_files(id: &str) -> Outcome<Vec<(String, Vec<u8>)>> {
    let root = diamond_dir(id);
    if !res!(opfs::exists(FileRoot::Opfs, &root).await) {
        return Err(err!("There is no Diamond '{}' to export.", id; Missing, Data));
    }
    // Recursion is spelled out with an explicit stack: an `async fn` cannot
    // recurse without boxing its future (as `opfs::copy_dir` does the same).
    let mut files: Vec<(String, Vec<u8>)> = Vec::new();
    let mut todo: Vec<String> = vec![String::new()];
    while let Some(rel) = todo.pop() {
        let dir = if rel.is_empty() { root.clone() } else { fmt!("{}/{}", root, rel) };
        let entries = match opfs::list_dir(FileRoot::Opfs, &dir).await {
            Ok(e)  => e,
            Err(_) => continue,     // a directory that has gone carries nothing
        };
        for (name, is_dir, _size) in entries {
            let child = if rel.is_empty() { name.clone() } else { fmt!("{}/{}", rel, name) };
            if is_dir {
                todo.push(child);
                continue;
            }
            // One unreadable file must not lose the whole Diamond.
            let bytes = match opfs::read_file(FileRoot::Opfs, &fmt!("{}/{}", root, child)).await {
                Ok(b)  => b,
                Err(e) => {
                    console_log(&fmt!("Diamond '{}' has an unreadable file '{}': {}", id, child, e));
                    continue;
                }
            };
            files.push((child, bytes));
        }
    }
    Ok(files)
}

/// Export a Diamond's SHAPE as a template anybody can open: the page it renders through, its
/// automation, and whatever a capp keeps beside itself -- and none of what has been recorded in it.
///
/// The line is drawn by [`crate::protocol::template_carries`], which is where the reasoning for
/// each path is written and where it is tested.  Unsealed, deliberately: a share is sealed to one
/// named recipient's key and so cannot reach anybody without an account, which is the whole reason
/// this second door exists.
///
/// # Arguments
/// * `id` - The Diamond to take the shape of.
/// * `with_conversation` - Carry everything instead, which is the door back to a complete copy.
///   It is still a template, so it still opens as a NEW Diamond.
pub async fn export_template(id: &str, with_conversation: bool) -> Outcome<String> {
    let files = res!(diamond_files(id).await);
    let kept  = crate::protocol::template_files(&files, with_conversation);
    // The name has to come out of the metadata here, because the metadata itself does not travel:
    // a template carries the name at the top of the pack and nothing else from `.daimond/`.  A
    // Diamond whose name cannot be read is refused rather than sent nameless -- what would arrive
    // is a tile with nothing on it but a cog, and the person opening it would have no way to know
    // what they had been given.
    let meta = res!(read_meta(id).await);
    let name = meta.name.trim().to_string();
    if name.is_empty() {
        return Err(err!(
            "Diamond '{}' has no name, so a template made from it would arrive with nothing to \
            call it. Name the Diamond and export it again.", id; Missing, Data));
    }
    Ok(crate::protocol::pack_template(id, meta.touched, &name, &kept))
}

/// Recreate a Diamond from an [`export_diamond`] JSON, REPLACING whatever this
/// device held under that id.
///
/// Wholesale, so that "the freshest copy wins" means something predictable: what
/// arrives *is* the Diamond, rather than being merged into what was here.  Two
/// devices that edited the same Diamond between syncs therefore lose the older
/// side entirely, links included, which is the accepted cost of carrying a
/// directory rather than reconciling one.
///
/// Every file is laid down exactly as it arrived, `meta.json` and its two stamps
/// included.  Re-stamping on arrival would be wrong twice over: an import is not
/// the user working on this device, so the rail would reorder itself on a pull;
/// and a copy that stamped itself fresh on landing would be handed straight back
/// as the newer one, so the two devices would take turns overwriting each other
/// for ever.
///
/// The read and the parse both happen before anything is deleted, so a malformed
/// export cannot leave the user with neither copy.  The window between the delete
/// and the last write remains: a failure inside it leaves the Diamond gone from
/// this device, and the next pull brings it back.
pub async fn import_diamond(json: &str) -> Outcome<()> {
    // The browser's own parser, not a second one written here.  This JSON holds
    // whole files, and a hand-rolled scan would be a second unescaping
    // implementation to keep exactly in step with the first.
    let val = res!(js_sys::JSON::parse(json)
        .map_err(|e| err!("A Diamond export could not be parsed: {}.", js_str(&e); Invalid, Input)));
    let id = match js_prop(&val, "id") {
        Some(i) => i,
        None    => return Err(err!("A Diamond export carries no id."; Invalid, Input)),
    };
    // The id becomes a path component, so it is checked rather than trusted.
    if !is_safe_rel(&id) || id.contains('/') {
        return Err(err!("'{}' is not a Diamond id.", id; Invalid, Input, Path));
    }
    // A TEMPLATE MAY NOT COME THROUGH THIS DOOR. Everything below deletes the directory the pack
    // names, and a template names where it CAME FROM -- so the owner opening his own Log Life
    // template on this path would destroy the Log Life he made it from. `import_template` mints an
    // id instead. A kind this build has never heard of still lands as it always did; only the one
    // that is known to mean something else is refused.
    if crate::protocol::PackKind::of(json) == crate::protocol::PackKind::Template {
        return Err(err!(
            "That is a Diamond template, not a Diamond export. It says it came from '{}', which is \
            a note about where it was made and not a place to write it; open it as a template and \
            it becomes a new Diamond.", id; Invalid, Input));
    }
    let mut writes = res!(pack_files(&val));
    // An export with nothing in it would otherwise delete the Diamond it claims
    // to be, which is a deletion nobody asked for.
    if writes.is_empty() {
        return Err(err!("The export of Diamond '{}' holds no files.", id; Invalid, Input));
    }

    // The metadata goes LAST, whatever order it arrived in.  `list` admits a Diamond on its
    // metadata alone, so an import that fails half way with the metadata already down leaves a
    // Diamond that lists, opens, and throws on a crystal that never arrived.  Written last, the
    // same failure leaves it invisible, and the next pull brings the whole of it back.  The order
    // used to be the export's own, which sorts paths -- and `.daimond/meta.json` sorts BEFORE
    // `crystal.json`, so the bad case was the ordinary one.
    let meta_rel = fmt!("{}/meta.json", STORE_DIR);
    writes.sort_by_key(|(rel, _)| (*rel == meta_rel) as u8);

    let dir = diamond_dir(&id);
    if res!(opfs::exists(FileRoot::Opfs, &dir).await) {
        res!(opfs::delete_entry(FileRoot::Opfs, &dir, true).await);
    }
    for (rel, body) in writes {
        // THE METADATA IS REBUILT, NOT COPIED. Every other file in an export is
        // the user's content and travels byte for byte; `meta.json` is a record
        // this app owns, and writing another device's copy verbatim is how a
        // damaged one spreads. Two of one user's Diamonds arrived carrying a
        // metadata file of 117 MB and 702 MB, and reading it killed their phone
        // (see `read_meta`) — a normaliser existed the whole time and this path
        // went round it.
        //
        // ONLY WHERE THERE IS DAMAGE, AND NEVER OVER A NAME IT COULD NOT READ.
        //
        // The first version of this rebuilt EVERY imported `meta.json`, healthy
        // or not, and it cost the user every Diamond name on their phone in one
        // sync: fifteen tiles with nothing on them but a cog. A repair that runs
        // on undamaged input is not a repair, it is a rewrite — and a rewrite
        // that drops what it failed to parse is data loss dressed as a fix.
        //
        // So: a file of a sane size is written through untouched, exactly as
        // every other file in the export is. An oversized one is rebuilt, and
        // even then only if the rebuild recovered a name — because a nameless
        // Meta means the parse did not find what it was looking for, and the
        // right answer to that is to keep the bytes and let `read_meta` deal with
        // them, not to overwrite them with blanks.
        let bytes = if rel == meta_rel && body.len() > META_MAX as usize {
            let text = String::from_utf8_lossy(&body).to_string();
            let rebuilt = Meta::from_json(&text);
            if rebuilt.name.trim().is_empty() {
                crate::wasm::entry::trail("META KEPT",
                    &fmt!("{} is {}KB but its name did not parse — left as it came",
                        id, body.len() / 1024));
                body
            } else {
                crate::wasm::entry::trail("META REBUILT",
                    &fmt!("{} {}KB -> {}B", id, body.len() / 1024, rebuilt.to_json().len()));
                rebuilt.to_json().into_bytes()
            }
        } else {
            body
        };
        res!(opfs::write_file(FileRoot::Opfs, &fmt!("{}/{}", dir, rel), &bytes).await);
    }
    Ok(())
}

/// The files a pack carries, text and base64 alike, each path checked against the Diamond it is
/// landing in.
///
/// One reader for both doors, so an import and a template import cannot come to disagree about
/// what a pack holds.  A `files` entry that is not a string is skipped rather than refused, which
/// is the tolerance [`crate::protocol::pack_diamond`] promises: a pack may carry things this build
/// does not understand and must still lay down the files it does.
fn pack_files(val: &JsValue) -> Outcome<Vec<(String, Vec<u8>)>> {
    let files_val = res!(js_sys::Reflect::get(val, &JsValue::from_str("files"))
        .map_err(|e| err!("A Diamond export has no files: {}.", js_str(&e); Invalid, Input)));
    let files: js_sys::Object = res!(files_val.dyn_into()
        .map_err(|_| err!("A Diamond export's files were not an object."; Invalid, Input)));

    let mut writes: Vec<(String, Vec<u8>)> = Vec::new();
    for pair in js_sys::Object::entries(&files).iter() {
        let pair: js_sys::Array = match pair.dyn_into() {
            Ok(a)  => a,
            Err(_) => continue,
        };
        let rel = match pair.get(0).as_string() {
            Some(p) => p,
            None    => continue,
        };
        let body = match pair.get(1).as_string() {
            Some(c) => c,
            None    => continue,        // not a string; `files` carries only text
        };
        if !is_safe_rel(&rel) {
            return Err(err!("A Diamond export names '{}', which is not a path inside it.", rel;
                Invalid, Input, Path));
        }
        writes.push((rel, body.into_bytes()));
    }
    // The pictures, the fonts, the compiled PDFs -- everything that is not text. A pack from a build
    // that predates them simply has no `binary`, and lands as it always did.
    if let Ok(blobs) = js_sys::Reflect::get(val, &JsValue::from_str(crate::protocol::PACK_BINARY)) {
        if let Ok(blobs) = blobs.dyn_into::<js_sys::Object>() {
            for pair in js_sys::Object::entries(&blobs).iter() {
                let pair: js_sys::Array = match pair.dyn_into() {
                    Ok(a)  => a,
                    Err(_) => continue,
                };
                let rel = match pair.get(0).as_string() {
                    Some(p) => p,
                    None    => continue,
                };
                let body = match pair.get(1).as_string() {
                    Some(c) => c,
                    None    => continue,
                };
                if !is_safe_rel(&rel) {
                    return Err(err!(
                        "A Diamond export names '{}', which is not a path inside it.", rel;
                        Invalid, Input, Path));
                }
                // A file whose base64 is damaged is REFUSED rather than written as whatever decoded.
                // Half a picture written over a good one is the corruption this whole change exists
                // to remove, and it would arrive looking like a successful sync.
                let bytes = res!(crate::protocol::unpack_binary(&rel, &body));
                writes.push((rel, bytes));
            }
        }
    }
    Ok(writes)
}

/// Open a template as a NEW Diamond, answering its id.
///
/// **Nothing that is already here is written over, whatever the pack says.**  [`import_diamond`]
/// takes the id from the pack and deletes that directory before rewriting it, which is right for a
/// sync and catastrophic for a template: the id in a template is where it was MADE, so the person
/// most likely to open a Log Life template is the one whose Log Life would be destroyed by it.  The
/// id is minted here instead ([`crate::protocol::fresh_id`]) and checked against the store a second
/// time before a byte is written.
///
/// A plain Diamond export opens here too, and makes a copy rather than a replacement.  That is a
/// door worth leaving open -- duplicating a Diamond is a thing people want and this path cannot
/// destroy anything -- and it costs nothing, since a pack that names no name has one in the
/// `.daimond/meta.json` it carries.
pub async fn import_template(json: &str) -> Outcome<String> {
    // The browser's own parser, for the reason `import_diamond` gives: this JSON holds whole files
    // and a hand-rolled scan would be a second unescaping implementation to keep in step.
    let val = res!(js_sys::JSON::parse(json)
        .map_err(|e| err!("A Diamond template could not be parsed: {}.", js_str(&e);
            Invalid, Input)));
    // Provenance only. It is never a path here, so it is not checked as one; it is used to
    // readdress the two files that name the Diamond they were written in.
    let old_id = js_prop(&val, "id").unwrap_or_default();
    let mut writes = res!(pack_files(&val));
    if writes.is_empty() {
        return Err(err!("A Diamond template holds no files, so there is nothing to open.";
            Invalid, Input));
    }

    // The name, from the top of the pack where a template carries it, or out of the metadata where
    // a whole-Diamond export carries it instead.
    let mut name = js_prop(&val, crate::protocol::PACK_NAME).unwrap_or_default();
    if name.trim().is_empty() {
        let meta_rel = fmt!("{}/meta.json", STORE_DIR);
        if let Some((_, body)) = writes.iter().find(|(rel, _)| *rel == meta_rel) {
            name = Meta::from_json(&String::from_utf8_lossy(body)).name;
        }
    }
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(err!("A Diamond template carries nothing to call the Diamond it opens as.";
            Missing, Input));
    }

    // Every id the store holds, so the mint has something to avoid. A root that cannot be listed is
    // a store with no Diamonds in it yet, which is the ordinary state on a device's first run.
    let taken: Vec<String> = match opfs::list_dir(FileRoot::Opfs, ROOT_DIR).await {
        Ok(entries) => entries.into_iter()
            .filter(|(_, is_dir, _)| *is_dir)
            .map(|(name, _, _)| name)
            .collect(),
        Err(_) => Vec::new(),
    };
    let new_id = res!(crate::protocol::fresh_id(&taken));
    // ASKED OF THE STORE, not of the listing. The listing is a moment old and the mint is a clock;
    // this is the check that has to be true, and it costs one lookup.
    if res!(opfs::exists(FileRoot::Opfs, &diamond_dir(&new_id)).await) {
        return Err(err!(
            "A template was to open as Diamond '{}' and there is already one there, so nothing was \
            written.", new_id; Conflict, Data));
    }

    // The skeleton first, by the same function that makes any other Diamond: an empty crystal, its
    // version-0 snapshot, the metadata and a `create` record. A template that carries any of those
    // then lands on top of them.
    res!(create_fresh(&name, &new_id).await);

    // The metadata goes LAST, for the reason `import_diamond` gives: `list` admits a Diamond on its
    // metadata alone, so a half-written one that already has metadata lists, opens and throws.
    let meta_rel = fmt!("{}/meta.json", STORE_DIR);
    let carries_crystal = writes.iter().any(|(rel, _)| rel == crate::tools::CRYSTAL_DATA_FILE);
    writes.sort_by_key(|(rel, _)| (*rel == meta_rel) as u8);
    for (rel, body) in writes {
        let bytes = crate::protocol::retarget(&rel, body, &old_id, &new_id);
        res!(opfs::write_file(FileRoot::Opfs,
            &fmt!("{}/{}", diamond_dir(&new_id), rel), &bytes).await);
    }

    // A CRYSTAL WITH SOMETHING IN IT, because a page without one never appears. `renderCrystal`
    // draws its "nothing here yet" line INSTEAD OF MOUNTING THE PAGE when the crystal is empty, so
    // a Diamond furnished with a capp and an empty crystal is one whose capp is invisible -- which
    // is what happened the first time a template that shipped no `crystal.json` was delivered.
    // The title is the name, which is already at the top of the pack: this seeds nothing the
    // template did not already say about itself.
    if !carries_crystal {
        let seed = crate::tools::CrystalData {
            title: name.clone(),
            ..Default::default()
        }.to_json();
        res!(opfs::write_file(FileRoot::Opfs, &crystal_data_path(&new_id), seed.as_bytes()).await);
        res!(opfs::write_file(FileRoot::Opfs, &version_data_path(&new_id, 0), seed.as_bytes())
            .await);
    }

    // AND THE METADATA IS PUT RIGHT, whichever way it arrived.
    //
    // The grants are the reason. `kits` decides what a COMMAND may touch outside the workspace, and
    // a template is opened by somebody who has never met the person who made it: a grant that
    // travelled would be a permission nobody on this device gave. A toolkit is off by default and
    // it stays off, so what the template wanted is a question for whoever opens it, not a fact it
    // brings with it. The tags go for a smaller reason -- they are the sender's filing, not the
    // Diamond's shape -- and both stamps say now, because a copy that has just landed here was not
    // worked on last year.
    let mut meta = res!(read_meta(&new_id).await);
    let now = now_ms() as u64;
    meta.name    = name;
    meta.tags    = Vec::new();
    meta.kits    = Vec::new();
    meta.updated = now;
    meta.touched = now;
    res!(write_meta(&new_id, &meta).await);

    Ok(new_id)
}


// ┌───────────────────────────────────────────────────────────────┐
// │ Bringing home what an earlier build left in a folder           │
// └───────────────────────────────────────────────────────────────┘

/// The most one adoption run copies out of the folder in total.
///
/// A ceiling exists because the folder is the user's own project and nothing says what an earlier
/// build put under `diamonds/` there.  Copying is into OPFS, which the browser may evict wholesale
/// when it fills, so an unbounded copy could cost the user their whole store to save a directory
/// they can still see on disk.
const ADOPT_TOTAL_MAX: u64 = 64 * 1024 * 1024;

/// The largest single file one adoption run copies out of the folder.
const ADOPT_FILE_MAX: u64 = 8 * 1024 * 1024;

/// What is inserted before a clashing file's extension, so the folder's copy is kept beside the
/// store's and still opens as the kind of file it is.
const FROM_MACHINE: &str = ".from-machine";

/// What became of one file the folder was holding.
enum Took {
    /// It was not in the store, and now it is.
    Copied,
    /// The store already had it, byte for byte, so nothing was written.
    Same,
    /// The store had it with DIFFERENT bytes.  The store's copy stands and the folder's was
    /// written beside it, at the path carried here.
    Kept(String),
    /// Too large for the budget, and so left exactly where it is.
    Skipped,
}

/// Where a clashing file's folder copy is written: `note.md` -> `note.from-machine.md`.
///
/// Before the extension rather than after it, so the kept copy still opens as markdown -- the user
/// is being asked to compare two files, and one of them arriving as an unopenable
/// `note.md.from-machine` would make that harder than it needs to be.
fn beside_path(rel: &str) -> String {
    let (dir, leaf) = match rel.rfind('/') {
        Some(i) => (&rel[..i + 1], &rel[i + 1..]),
        None    => ("", rel),
    };
    match leaf.rfind('.') {
        // A leading dot is the whole name of a dotfile, not an extension.
        Some(i) if i > 0 => fmt!("{}{}{}{}", dir, &leaf[..i], FROM_MACHINE, &leaf[i..]),
        _                => fmt!("{}{}{}", dir, leaf, FROM_MACHINE),
    }
}

/// Whether a directory under the folder's `diamonds/` is a Diamond at all.
///
/// Two ways to be one, and the second is what makes a Diamond the store has never seen adoptable:
/// the store already holds it under that id, or the folder's copy carries the metadata that makes
/// a Diamond a Diamond.  Anything else is a directory of the user's that happens to live under
/// `diamonds/` -- notes, a build output, a folder they made -- and it is left alone.
///
/// The test is not "does it look like it might be one".  Materialising a shell of a Diamond out of
/// a user's own directory would put a row on the rail that opens on a `NotFoundError`, which is
/// the failure this whole change is trying to stop happening.
///
/// # Arguments
/// * `id` - The directory name under `diamonds/` in the folder.
async fn is_diamond(id: &str) -> Outcome<bool> {
    if res!(opfs::exists(FileRoot::Opfs, &diamond_dir(id)).await) {
        return Ok(true);
    }
    opfs::exists(FileRoot::Machine, &meta_path(id)).await
}

/// Take one file out of the folder and into the store, and say what that came to.
///
/// The store always wins a clash, per file rather than per Diamond.  The folder's copy is never
/// dropped and never deleted: it is written beside the store's under [`beside_path`] and named in
/// the report, because the two differing copies are the user's to reconcile and we cannot know
/// which they wanted.
///
/// Idempotent by comparison rather than by a flag.  A second run finds the store's copy identical
/// (or the kept copy identical) and writes nothing, which is what lets adoption run on EVERY folder
/// activation for ever -- there is no moment at which we could prove every folder has been seen, so
/// there is no moment at which it would be safe to stop looking.
///
/// # Arguments
/// * `rel` - The workspace-relative path, the same on both sides.
/// * `size` - What the folder says the file weighs, so the budget is checked before it is read.
/// * `used` - How much this run has copied so far, added to here.
async fn take_file(rel: &str, size: u64, used: &mut u64) -> Outcome<Took> {
    if size > ADOPT_FILE_MAX || *used + size > ADOPT_TOTAL_MAX {
        return Ok(Took::Skipped);
    }
    let bytes = res!(opfs::read_file(FileRoot::Machine, rel).await);
    if !res!(opfs::exists(FileRoot::Opfs, rel).await) {
        res!(opfs::write_file(FileRoot::Opfs, rel, &bytes).await);
        *used += size;
        return Ok(Took::Copied);
    }
    let held = res!(opfs::read_file(FileRoot::Opfs, rel).await);
    if held == bytes {
        return Ok(Took::Same);
    }
    // Kept on an earlier run: the copy beside it already holds exactly these bytes, so this run
    // has nothing to add and must not make a second copy of the second copy.
    let beside = beside_path(rel);
    if res!(opfs::exists(FileRoot::Opfs, &beside).await) {
        let there = res!(opfs::read_file(FileRoot::Opfs, &beside).await);
        if there == bytes {
            return Ok(Took::Same);
        }
    }
    res!(opfs::write_file(FileRoot::Opfs, &beside, &bytes).await);
    *used += size;
    Ok(Took::Kept(beside))
}

/// Every file the folder holds under `root`, workspace-relative, with the size the folder reports
/// for it.  Sorted, so a run's order does not depend on how the browser iterates.
///
/// A directory the folder does not have holds nothing, which is the ordinary case and not a
/// failure: most folders have neither a `diamonds/` nor a `mail/` in them.
///
/// Recursion is spelled out with an explicit stack, as [`export_diamond`] does and for the same
/// reason: an `async fn` cannot recurse without boxing its future.
///
/// # Arguments
/// * `root` - The workspace-relative directory to walk, on the machine folder.
async fn folder_files(root: &str) -> Outcome<Vec<(String, u64)>> {
    let mut out: Vec<(String, u64)> = Vec::new();
    let mut todo: Vec<String> = vec![root.to_string()];
    while let Some(dir) = todo.pop() {
        let entries = match opfs::list_dir(FileRoot::Machine, &dir).await {
            Ok(e)  => e,
            Err(_) => continue,     // a directory that has gone holds nothing
        };
        for (name, is_dir, size) in entries {
            let child = fmt!("{}/{}", dir, name);
            if is_dir {
                todo.push(child);
            } else {
                out.push((child, size));
            }
        }
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(out)
}

/// Bring one Diamond's files home.  True when anything was actually taken.
///
/// **The order is the correctness.**  The crystal is copied FIRST and `.daimond/meta.json` LAST,
/// because [`list`] admits a Diamond on its metadata alone and [`read_crystal_data`] looks for the
/// crystal where it should be.  Metadata written first, and a run interrupted between the two,
/// leaves a Diamond that lists, opens, and throws -- visible and broken.  Metadata written last
/// leaves a half-adopted Diamond *invisible*, and the next activation completes it.  Nothing is
/// ever deleted from the folder, so an interruption costs nothing at all.
///
/// For the same reason the metadata is not written when the crystal is not in the store
/// afterwards: a Diamond whose crystal was too large for the budget, or unreadable, stays out of
/// the rail rather than joining it broken.
///
/// "The crystal" is either name.  A folder left by a build older than the conversion holds
/// `crystal.md` and no `crystal.json`, and refusing to adopt it because the data file is absent
/// would leave the user's Diamond in a directory nothing reads -- [`list`] converts it once it is
/// home.
///
/// # Arguments
/// * `id` - The Diamond.
/// * `used` - The run's byte accumulator.
/// * `kept` - Collects the paths where a clashing folder copy was kept.
/// * `skipped` - Collects the paths this run did not take.
async fn adopt_one(
    id:      &str,
    used:    &mut u64,
    kept:    &mut Vec<String>,
    skipped: &mut Vec<String>,
)
    -> Outcome<bool>
{
    let files   = res!(folder_files(&diamond_dir(id)).await);
    let meta    = meta_path(id);
    // Both live names and the one they replaced, in the order they matter: the memory, then the
    // page, then whatever markdown a Diamond has not been converted from yet.
    let crystals = [crystal_data_path(id), crystal_page_path(id), crystal_legacy_path(id)];
    let mut ordered: Vec<(String, u64)> = Vec::new();
    for c in crystals.iter() {
        if let Some(f) = files.iter().find(|(p, _)| p == c) {
            ordered.push(f.clone());
        }
    }
    for f in &files {
        if crystals.contains(&f.0) || f.0 == meta {
            continue;
        }
        ordered.push(f.clone());
    }
    let mut took_any = false;
    for (rel, size) in &ordered {
        // One unreadable file must not lose the rest of the Diamond, nor the rest of the run.
        match take_file(rel, *size, used).await {
            Ok(Took::Copied)     => took_any = true,
            Ok(Took::Kept(path)) => { kept.push(path); took_any = true; },
            Ok(Took::Same)       => {},
            Ok(Took::Skipped)    => skipped.push(rel.clone()),
            Err(e) => {
                console_log(&fmt!("'{}' could not be brought home from the folder: {}", rel, e));
                skipped.push(rel.clone());
            }
        }
    }
    // Last, and only over a crystal that is there to be read -- in either of the two forms a
    // Diamond's memory can arrive in.
    if let Some((rel, size)) = files.iter().find(|(p, _)| *p == meta) {
        let data   = res!(opfs::exists(FileRoot::Opfs, &crystal_data_path(id)).await);
        let legacy = res!(opfs::exists(FileRoot::Opfs, &crystal_legacy_path(id)).await);
        if !data && !legacy {
            skipped.push(rel.clone());
            return Ok(took_any);
        }
        match take_file(rel, *size, used).await {
            Ok(Took::Copied)     => took_any = true,
            Ok(Took::Kept(path)) => { kept.push(path); took_any = true; },
            Ok(Took::Same)       => {},
            Ok(Took::Skipped)    => skipped.push(rel.clone()),
            Err(e) => {
                console_log(&fmt!("'{}' could not be brought home from the folder: {}", rel, e));
                skipped.push(rel.clone());
            }
        }
    }
    Ok(took_any)
}

/// What became of one mail file the folder was holding.
enum Brought {
    /// It was not in the store, and now it is.
    Copied,
    /// The store already has a file at that path, so nothing was read, written or compared.
    Held,
    /// Too large for what is left of the budget, and so left exactly where it is for a later run.
    Skipped,
}

/// Take one mail file out of the folder and into the store.
///
/// **A CLASH IS NOT RECONCILED AND NOT COPIED BESIDE**, which is where this parts company with
/// [`take_file`].  A Maildir name is derived from the message's UID and the mailbox generation
/// (`maildirName` in `www/js/mail.js`), so a file already at that path IS that message: a second
/// copy under `.from-machine` would show up as a duplicate message in the panel, hand the agent
/// the same stranger's words twice, and ride in the sync parcel for ever.  A draft is the same
/// argument the other way round -- the store's copy is the one the user has been editing, and the
/// folder's is whatever an older build last wrote.
///
/// The store's presence is therefore checked FIRST, before the folder's bytes are read at all, so
/// the second run over a mailbox of ten thousand messages costs ten thousand lookups and not one
/// byte of transfer.
///
/// Bytes throughout, never text: a message with a JPEG attached is not a string, and a lossy
/// decode on the way through would corrupt it silently.
///
/// # Arguments
/// * `rel` - The workspace-relative path, the same on both sides.
/// * `size` - What the folder says the file weighs, so the budget is checked before it is read.
/// * `used` - How much this run has copied so far, added to here.
async fn take_message(rel: &str, size: u64, used: &mut u64) -> Outcome<Brought> {
    if size > ADOPT_FILE_MAX || *used + size > ADOPT_TOTAL_MAX {
        return Ok(Brought::Skipped);
    }
    if res!(opfs::exists(FileRoot::Opfs, rel).await) {
        return Ok(Brought::Held);
    }
    let bytes = res!(opfs::read_file(FileRoot::Machine, rel).await);
    res!(opfs::write_file(FileRoot::Opfs, rel, &bytes).await);
    *used += size;
    Ok(Brought::Copied)
}

/// Bring home every message and draft an earlier build left in the open folder.
///
/// Until `mail/` became store state (see [`crate::tools::MAIL_ROOT`]) a mailbox followed the
/// workspace root, so a sync made with a folder open wrote the messages into the user's project.
/// This copies them into the store, where a mailbox belongs to the account rather than to whatever
/// folder happened to be open.
///
/// **IT COPIES AND IT NEVER DELETES.**  A move would be tidier and it is not available here: a
/// draft exists on no server and in no gateway, so an interruption or a mistake between the read
/// and the delete would destroy the only copy of a message an agent prepared for its user to send.
/// The worst this can leave behind is a second copy of a mailbox in a folder the user can see and
/// remove themselves.
///
/// Three properties, each of which the shape above is what buys:
///
/// * **Idempotent.**  A second run finds every file already in the store and writes nothing.  It
///   is not idempotent by a flag or a stamp -- there is no moment at which every folder could be
///   proved to have been seen -- but by asking the store, per file, every time.
/// * **It never clobbers.**  A path the store already holds is left alone on both sides.
/// * **A partial run costs nothing.**  Nothing is deleted and no file depends on another, so an
///   interruption leaves both trees readable and the next activation finishes the job -- including
///   over the budget, which resets each run while the files already home are skipped for free.
///
/// Only the mailboxes are taken, never the whole directory, for the reason [`is_mailbox`] gives.
///
/// Returns how many files were copied, and the paths this run did not take.
///
/// # Arguments
/// * `used` - The run's byte accumulator, shared with the Diamond adoption above so one activation
///   has one budget.
async fn bring_mail_home(used: &mut u64) -> Outcome<(usize, Vec<String>)> {
    let mut copied = 0usize;
    let mut left: Vec<String> = Vec::new();
    // A folder with no `mail/` in it is the ordinary case, and it is not a failure.
    let entries = match opfs::list_dir(FileRoot::Machine, crate::tools::MAIL_ROOT).await {
        Ok(e)  => e,
        Err(_) => return Ok((0, left)),
    };
    for (name, is_dir, _size) in entries {
        if !is_dir || !res!(is_mailbox(&name).await) {
            continue;
        }
        let files = res!(folder_files(&fmt!("{}/{}", crate::tools::MAIL_ROOT, name)).await);
        for (rel, size) in &files {
            // One unreadable message must not lose the rest of the mailbox, nor the rest of the
            // run.
            match take_message(rel, *size, used).await {
                Ok(Brought::Copied)  => copied += 1,
                Ok(Brought::Held)    => {},
                Ok(Brought::Skipped) => left.push(rel.clone()),
                Err(e) => {
                    console_log(&fmt!(
                        "'{}' could not be brought home from the folder: {}", rel, e));
                    left.push(rel.clone());
                }
            }
        }
    }
    Ok((copied, left))
}

/// Whether a directory under the folder's `mail/` is one of Daimond's mailboxes.
///
/// The mirror of [`is_diamond`], and it earns its place the same way: `mail/` is now one of
/// Daimond's own roots, but a user may have had a directory of that name in their project for
/// years -- an archive, a mail module, a year's correspondence -- and copying it wholesale into the
/// browser's storage would be an app helping itself to somebody's files.
///
/// Two ways to be a mailbox, and neither guesses.  The store already holds one under that name, or
/// the name carries an `@`: a mailbox directory is the account's ADDRESS with the characters a
/// filesystem refuses replaced (`mailDir` in `www/js/mail.js`), and an address without an `@` is
/// not an address.
///
/// # Arguments
/// * `name` - The directory name under `mail/` in the folder.
async fn is_mailbox(name: &str) -> Outcome<bool> {
    let here = fmt!("{}/{}", crate::tools::MAIL_ROOT, name);
    if res!(opfs::exists(FileRoot::Opfs, &here).await) {
        return Ok(true);
    }
    Ok(name.contains('@'))
}

/// Bring home every Diamond an earlier build left in the open folder, and report what was done.
///
/// A build before this one let Daimond's own store follow the workspace root, so a Diamond worked
/// on with a folder open wrote `diamonds/<id>/...` into the user's project: outside the sync
/// parcel, invisible to the panel the moment they switched back, and absent from a backup.  This
/// copies those files into the store.
///
/// Three rules, and each is a thing that could be got dangerously wrong:
///
/// * **Nothing is ever deleted from the folder.**  Deleting from a user's own project to tidy up
///   after our own bug is the more dangerous of the two mistakes available here, and leaving the
///   copies also makes an interrupted run free to repeat.
/// * **The store wins a clash, and the folder's copy is kept beside it** (see [`take_file`]).
/// * **It runs on every activation, for ever**, boot reconnect included, because there is no
///   moment at which every folder can be proved to have been seen.  So it is silent when it finds
///   nothing: the caller shows the user nothing at all when `adopted` is empty.
///
/// **THE MAILBOX COMES HOME HERE TOO**, on the same trigger and by the same three rules (see
/// [`bring_mail_home`]).  It is here rather than in [`list`], where the other migrations run,
/// because this is the only place that is guaranteed a folder is open: everything under `mail/`
/// has to be read through [`FileRoot::Machine`], which resolves to the folder or to nothing at
/// all.  A user who has never opened one has no mail in a folder, and this returns before looking.
///
/// Returns `{"folder":bool,"adopted":[{"id","name","kept":[..]}],"left":[..],"skipped":[..],
/// "mail":{"copied":n,"left":[..]}}`.  `folder` is false when none is open, which is not an error
/// and must not be reported as one.  Mail is reported under its own key rather than folded into
/// `skipped`, which drives a dialog about Diamonds.
pub async fn adopt_from_folder() -> Outcome<String> {
    if !opfs::folder_open() {
        return Ok(fmt!(
            "{{\"folder\":false,\"adopted\":[],\"left\":[],\"skipped\":[],\
             \"mail\":{{\"copied\":0,\"left\":[]}}}}"));
    }
    let mut adopted: Vec<(String, String, Vec<String>)> = Vec::new();
    let mut left:    Vec<String> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    let mut used = 0u64;
    // A folder with no `diamonds/` in it is the ordinary case, and it is not a failure -- and it
    // says nothing about whether the folder is holding a mailbox, which is why this is an empty
    // list to walk rather than an early return.
    let entries = match opfs::list_dir(FileRoot::Machine, ROOT_DIR).await {
        Ok(e)  => e,
        Err(_) => Vec::new(),
    };
    for (name, is_dir, _size) in entries {
        let here = fmt!("{}/{}", ROOT_DIR, name);
        if !is_dir {
            left.push(here);
            continue;
        }
        match is_diamond(&name).await {
            Ok(true)  => {},
            Ok(false) => { left.push(here); continue; },
            Err(e) => {
                console_log(&fmt!("'{}' in the folder could not be examined: {}", here, e));
                left.push(here);
                continue;
            }
        }
        let mut kept: Vec<String> = Vec::new();
        let took = match adopt_one(&name, &mut used, &mut kept, &mut skipped).await {
            Ok(t) => t,
            Err(e) => {
                console_log(&fmt!("Diamond '{}' could not be brought home: {}", name, e));
                continue;
            }
        };
        if !took {
            continue;       // already home: say nothing, or every boot would announce itself
        }
        // The name the rail will show, read from the store now that the metadata is in it.
        let label = read_meta(&name).await.map(|m| m.name).unwrap_or_else(|_| name.clone());
        adopted.push((name, label, kept));
    }
    // The mailbox, on the remaining budget. A failure here is reported and does not fail the run:
    // the Diamonds are already home by this point, and nothing has been deleted from the folder.
    let (mail_copied, mail_left) = match bring_mail_home(&mut used).await {
        Ok(v) => v,
        Err(e) => {
            console_log(&fmt!("The mailbox in the folder could not be brought home: {}", e));
            (0usize, Vec::new())
        }
    };
    let rows: Vec<String> = adopted.iter().map(|(id, name, kept)| {
        let ks: Vec<String> = kept.iter().map(|k| fmt!("\"{}\"", json_escape(k))).collect();
        fmt!(
            "{{\"id\":\"{}\",\"name\":\"{}\",\"kept\":[{}]}}",
            json_escape(id), json_escape(name), ks.join(","),
        )
    }).collect();
    let quote = |v: &[String]| -> String {
        let items: Vec<String> = v.iter().map(|s| fmt!("\"{}\"", json_escape(s))).collect();
        items.join(",")
    };
    Ok(fmt!(
        "{{\"folder\":true,\"adopted\":[{}],\"left\":[{}],\"skipped\":[{}],\
         \"mail\":{{\"copied\":{},\"left\":[{}]}}}}",
        rows.join(","), quote(&left), quote(&skipped), mail_copied, quote(&mail_left),
    ))
}

/// Bring home every Diamond the open folder is holding, as the page calls it.
///
/// Called from `activateFolder` in `daimond.js`, which runs on every folder activation including
/// the silent reconnect at boot -- so a user of yesterday's build gets their stranded Diamonds back
/// on their next page load with no action at all.  See [`adopt_from_folder`] for what it does and
/// what it refuses to do.
#[wasm_bindgen]
pub async fn adopt_folder_diamonds() -> Result<String, JsValue> {
    adopt_from_folder().await.map_err(crate::wasm::to_js_err)
}
