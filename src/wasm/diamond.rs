//! Diamond / crystal / fold substrate — the durable core of Daimond in the
//! browser.
//!
//! A **Diamond** is a durable container for a pursuit.  Its reduced state is
//! the **crystal** (`crystal.md`); a **fold** re-reduces a delta into the
//! crystal; the **log** is per-Diamond and append-only.  This module owns the
//! OPFS layout and the pure store operations; the `#[wasm_bindgen]`
//! surface that drives the crystal and reducer agents lives on
//! [`DaimondApp`](crate::wasm::app::DaimondApp) in [`crate::wasm::app`].
//!
//! OPFS layout, per Diamond id:
//!
//! ```text
//! diamonds/<id>/crystal.md                  the reduced state (agent writes, user may edit)
//! diamonds/<id>/versions/NNNN.md          a snapshot per crystal version (0-padded)
//! diamonds/<id>/.daimond/meta.json        { name, crystal_version, updated, touched, tags }
//! diamonds/<id>/.daimond/log              append-only, one JSON record per line
//! diamonds/<id>/.daimond/deltas/NNNN.md   the raw delta a fold consumed, referenced by delta_ref
//! ```
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
use crate::llm::json_escape;
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

/// The crystal content file, `diamonds/<id>/crystal.md`.
fn crystal_path(id: &str) -> String {
    fmt!("diamonds/{}/crystal.md", id)
}

/// The append-only log, `diamonds/<id>/.daimond/log`.
fn log_path(id: &str) -> String {
    fmt!("diamonds/{}/{}/log", id, STORE_DIR)
}

/// The metadata file, `diamonds/<id>/.daimond/meta.json`.
fn meta_path(id: &str) -> String {
    fmt!("diamonds/{}/{}/meta.json", id, STORE_DIR)
}

/// A crystal-version snapshot, `diamonds/<id>/versions/NNNN.md`.
fn version_path(id: &str, version: u64) -> String {
    fmt!("diamonds/{}/versions/{:04}.md", id, version)
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
    let new = crystal_path(id);
    if !res!(opfs::exists(FileRoot::Opfs, &old).await) {
        return Ok(false);
    }
    if res!(opfs::exists(FileRoot::Opfs, &new).await) {
        return Ok(false);
    }
    res!(opfs::move_entry(FileRoot::Opfs, &old, &new).await);
    Ok(true)
}


/// Move a Diamond's store from `.red/` to `.daimond/`, so a workspace made before the
/// rename opens with its history intact.
///
/// Without this a renamed Daimond simply would not find the old directory: [`read_meta`]
/// would fail, [`list`] would skip the Diamond, and a real pursuit -- its crystal versions, its
/// whole fold history -- would read as though it had never existed.  The crystal itself
/// (`crystal.md`) and its snapshots sit *outside* the store directory and are untouched
/// either way; what moves here is the metadata, the log and the retained deltas.
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


/// Read the crystal as it stood at `version`.
///
/// Every fold and every hand-edit snapshots the crystal, but nothing has ever
/// read one back, so an accepted fold that mangled the crystal could not be
/// undone.  This is what makes the history recoverable rather than merely
/// recorded.
pub async fn read_version(id: &str, version: u64) -> Outcome<String> {
    let path = version_path(id, version);
    let bytes = res!(crate::wasm::opfs::read_file(crate::tools::FileRoot::Opfs, &path).await);
    Ok(String::from_utf8_lossy(&bytes).to_string())
}


// ┌───────────────────────────────────────────────────────────────┐
// │ Metadata                                                       │
// └───────────────────────────────────────────────────────────────┘

/// Read a Diamond's metadata.
async fn read_meta(id: &str) -> Outcome<Meta> {
    let bytes = res!(opfs::read_file(FileRoot::Opfs, &meta_path(id)).await);
    let s = String::from_utf8_lossy(&bytes).to_string();
    Ok(Meta::from_json(&s))
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
async fn touch(id: &str) -> Outcome<()> {
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

/// Create a Diamond: its directory, an empty `crystal.md`, version `0000`, a
/// `meta.json`, and a `create` log record.  Returns the new Diamond id.
pub async fn create(name: &str) -> Outcome<String> {
    let id = generate_session_id();
    let now = now_ms() as u64;

    // Empty crystal plus its version-0 snapshot.
    res!(opfs::write_file(FileRoot::Opfs, &crystal_path(&id), b"").await);
    res!(opfs::write_file(FileRoot::Opfs, &version_path(&id, 0), b"").await);

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
        crate::wasm::entry::trail("list entry", &name);
        // Before the metadata is read, because before the rename it was somewhere else.
        if let Err(e) = migrate(&name).await {
            console_log(&fmt!("Diamond '{}' could not be migrated to .daimond/: {}", name, e));
        }
        // And before the crystal is read, because it was called brief.md.
        if let Err(e) = migrate_crystal_file(&name).await {
            console_log(&fmt!("Diamond '{}' could not have its crystal renamed: {}", name, e));
        }
        let meta = match read_meta(&name).await {
            Ok(m)  => m,
            Err(_) => continue, // not a Diamond dir / no metadata
        };
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

/// Read a Diamond's current crystal markdown.
///
/// A Diamond that LISTS must OPEN.  [`list`] admits one on its metadata alone -- deliberately, so
/// that a broken Diamond is a bug the user can report rather than one they can only mourn -- and
/// this used to be a bare read, so a Diamond whose `crystal.md` was missing threw `NotFoundError`
/// at the panel and could not be opened at all.  Four live paths arrive at that state, an
/// interrupted import among them.
///
/// So the version snapshots are used for what they have always been: the store's own redundancy.
/// The newest `versions/NNNN.md` is read when the crystal is not there, and a Diamond with neither
/// opens empty and says so in the console rather than refusing to open.  Nothing else reads the
/// snapshots back except [`read_version`], so this costs nothing and turns a dead Diamond into a
/// recoverable one.
pub async fn read_crystal(id: &str) -> Outcome<String> {
    if let Ok(bytes) = opfs::read_file(FileRoot::Opfs, &crystal_path(id)).await {
        return Ok(String::from_utf8_lossy(&bytes).to_string());
    }
    match res!(newest_version(id).await) {
        Some((n, md)) => {
            console_log(&fmt!(
                "Diamond '{}' has no crystal.md; read version {} instead.", id, n));
            Ok(md)
        }
        None => {
            console_log(&fmt!(
                "Diamond '{}' has no crystal.md and no version to fall back on; it opens empty.",
                id));
            Ok(String::new())
        }
    }
}

/// The highest-numbered version snapshot a Diamond holds, with its text.
///
/// The numbering is `versions/NNNN.md`, zero-padded and monotonic, so the highest that PARSES is
/// the newest; a file that does not parse is somebody else's and is passed over rather than
/// guessed at.
async fn newest_version(id: &str) -> Outcome<Option<(u64, String)>> {
    let dir = fmt!("diamonds/{}/versions", id);
    let entries = match opfs::list_dir(FileRoot::Opfs, &dir).await {
        Ok(e)  => e,
        Err(_) => return Ok(None),      // no snapshots: a Diamond older than they are, or emptied
    };
    let mut best: Option<u64> = None;
    for (name, is_dir, _size) in entries {
        if is_dir {
            continue;
        }
        let n = match name.strip_suffix(".md").and_then(|s| s.parse::<u64>().ok()) {
            Some(n) => n,
            None    => continue,
        };
        if best.map(|b| n > b).unwrap_or(true) {
            best = Some(n);
        }
    }
    let n = match best {
        Some(n) => n,
        None    => return Ok(None),
    };
    let bytes = res!(opfs::read_file(FileRoot::Opfs, &version_path(id, n)).await);
    Ok(Some((n, String::from_utf8_lossy(&bytes).to_string())))
}

/// Snapshot a new crystal version and return its number.
///
/// Writes `crystal.md`, bumps the version, writes the `versions/NNNN.md`
/// snapshot and updates `meta.json`.  The caller appends the matching log
/// record.
async fn snapshot(id: &str, md: &str, now: u64) -> Outcome<u64> {
    // The other door on the ceiling. `Tool::FileWrite` catches a daimon growing the crystal past
    // it; this catches a hand edit and a fold, which reach the file through the store instead and
    // would otherwise walk straight past the rule.
    let old = opfs::read_file(FileRoot::Opfs, &crystal_path(id)).await
        .map(|b| b.len())
        .unwrap_or(0);
    if crate::tools::crystal_write_refused(md.len(), old) {
        return Err(err!("{}", crate::tools::crystal_cap_message(md.len()); Invalid, Input, Size));
    }
    let mut meta = res!(read_meta(id).await);
    let next = meta.version + 1;
    res!(opfs::write_file(FileRoot::Opfs, &crystal_path(id), md.as_bytes()).await);
    res!(opfs::write_file(FileRoot::Opfs, &version_path(id, next), md.as_bytes()).await);
    meta.version = next;
    meta.updated = now;
    meta.touched = now;        // a new crystal is both work and a change
    res!(write_meta(id, &meta).await);
    Ok(next)
}

/// Apply a user hand-edit to the crystal: snapshot a new version and log an
/// `edit` record.
pub async fn write_crystal(id: &str, md: &str) -> Outcome<()> {
    let now = now_ms() as u64;
    let parent = res!(read_meta(id).await).version;
    let version = res!(snapshot(id, md, now).await);
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
    let crystal = res!(read_crystal(id).await);
    let version = res!(snapshot(id, &crystal, now).await);
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
/// `crystal.md`): snapshot a version and log an `edit` record whose task is
/// the instruction.  Called by [`crate::wasm::app`] after the agent turn,
/// only when the crystal content actually changed.
pub async fn record_steer(id: &str, md: &str, instruction: &str) -> Outcome<()> {
    let now = now_ms() as u64;
    let parent = res!(read_meta(id).await).version;
    let version = res!(snapshot(id, md, now).await);
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
    let version = res!(snapshot(id, new_crystal, now).await);

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
/// It sits beside the log rather than inside `crystal.md` for two reasons.  A
/// fold rewrites the crystal wholesale -- the reducer is asked for the new crystal
/// and returns the whole of it -- so anything structural kept in that prose is
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
pub async fn export_diamond(id: &str) -> Outcome<String> {
    let root = diamond_dir(id);
    if !res!(opfs::exists(FileRoot::Opfs, &root).await) {
        return Err(err!("There is no Diamond '{}' to export.", id; Missing, Data));
    }
    // Recursion is spelled out with an explicit stack: an `async fn` cannot
    // recurse without boxing its future (as `opfs::copy_dir` does the same).
    let mut files: Vec<(String, String)> = Vec::new();
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
            files.push((child, String::from_utf8_lossy(&bytes).to_string()));
        }
    }
    files.sort_by(|a, b| a.0.cmp(&b.0));
    let items: Vec<String> = files.iter()
        .map(|(p, c)| fmt!("\"{}\":\"{}\"", json_escape(p), json_escape(c)))
        .collect();
    // A Diamond with no readable metadata still exports; it simply carries no
    // stamp, and a carrier falls back to whatever the pack itself says.
    let touched = read_meta(id).await.map(|m| m.touched).unwrap_or(0);
    Ok(fmt!(
        "{{\"id\":\"{}\",\"touched\":{},\"files\":{{{}}}}}",
        json_escape(id), touched, items.join(","),
    ))
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
    let files_val = res!(js_sys::Reflect::get(&val, &JsValue::from_str("files"))
        .map_err(|e| err!("A Diamond export has no files: {}.", js_str(&e); Invalid, Input)));
    let files: js_sys::Object = res!(files_val.dyn_into()
        .map_err(|_| err!("A Diamond export's files were not an object."; Invalid, Input)));

    let mut writes: Vec<(String, String)> = Vec::new();
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
            None    => continue,        // not text; nothing a Diamond stores is
        };
        if !is_safe_rel(&rel) {
            return Err(err!("A Diamond export names '{}', which is not a path inside it.", rel;
                Invalid, Input, Path));
        }
        writes.push((rel, body));
    }
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
    // `crystal.md`, so the bad case was the ordinary one.
    let meta_rel = fmt!("{}/meta.json", STORE_DIR);
    writes.sort_by_key(|(rel, _)| (*rel == meta_rel) as u8);

    let dir = diamond_dir(&id);
    if res!(opfs::exists(FileRoot::Opfs, &dir).await) {
        res!(opfs::delete_entry(FileRoot::Opfs, &dir, true).await);
    }
    for (rel, body) in writes {
        res!(opfs::write_file(FileRoot::Opfs, &fmt!("{}/{}", dir, rel), body.as_bytes()).await);
    }
    Ok(())
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

/// Every file the folder holds under one Diamond, workspace-relative, with the size the folder
/// reports for it.  Sorted, so a run's order does not depend on how the browser iterates.
///
/// Recursion is spelled out with an explicit stack, as [`export_diamond`] does and for the same
/// reason: an `async fn` cannot recurse without boxing its future.
async fn folder_files(id: &str) -> Outcome<Vec<(String, u64)>> {
    let mut out: Vec<(String, u64)> = Vec::new();
    let mut todo: Vec<String> = vec![diamond_dir(id)];
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
/// **The order is the correctness.**  `crystal.md` is copied FIRST and `.daimond/meta.json` LAST,
/// because [`list`] admits a Diamond on its metadata alone and [`read_crystal`] looks for the
/// crystal where it should be.  Metadata written first, and a run interrupted between the two,
/// leaves a Diamond that lists, opens, and throws -- visible and broken.  Metadata written last
/// leaves a half-adopted Diamond *invisible*, and the next activation completes it.  Nothing is
/// ever deleted from the folder, so an interruption costs nothing at all.
///
/// For the same reason the metadata is not written when the crystal is not in the store
/// afterwards: a Diamond whose crystal was too large for the budget, or unreadable, stays out of
/// the rail rather than joining it broken.
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
    let files   = res!(folder_files(id).await);
    let crystal = crystal_path(id);
    let meta    = meta_path(id);
    let mut ordered: Vec<(String, u64)> = Vec::new();
    if let Some(f) = files.iter().find(|(p, _)| *p == crystal) {
        ordered.push(f.clone());
    }
    for f in &files {
        if f.0 == crystal || f.0 == meta {
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
    // Last, and only over a crystal that is there to be read.
    if let Some((rel, size)) = files.iter().find(|(p, _)| *p == meta) {
        if !res!(opfs::exists(FileRoot::Opfs, &crystal).await) {
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
/// Returns `{"folder":bool,"adopted":[{"id","name","kept":[..]}],"left":[..],"skipped":[..]}`.
/// `folder` is false when none is open, which is not an error and must not be reported as one.
pub async fn adopt_from_folder() -> Outcome<String> {
    if !opfs::folder_open() {
        return Ok(fmt!("{{\"folder\":false,\"adopted\":[],\"left\":[],\"skipped\":[]}}"));
    }
    let mut adopted: Vec<(String, String, Vec<String>)> = Vec::new();
    let mut left:    Vec<String> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    // A folder with no `diamonds/` in it is the ordinary case, and it is not a failure.
    let entries = match opfs::list_dir(FileRoot::Machine, ROOT_DIR).await {
        Ok(e)  => e,
        Err(_) => return Ok(fmt!("{{\"folder\":true,\"adopted\":[],\"left\":[],\"skipped\":[]}}")),
    };
    let mut used = 0u64;
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
        "{{\"folder\":true,\"adopted\":[{}],\"left\":[{}],\"skipped\":[{}]}}",
        rows.join(","), quote(&left), quote(&skipped),
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
