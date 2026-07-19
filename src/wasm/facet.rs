//! Facet / brief / fold substrate — the durable core of Daimond in the
//! browser.
//!
//! A **Facet** is a durable container for a pursuit.  Its reduced state is
//! the **brief** (`brief.md`); a **fold** re-reduces a delta into the
//! brief; the **log** is per-Facet and append-only.  This module owns the
//! OPFS layout and the pure store operations; the `#[wasm_bindgen]`
//! surface that drives the brief and reducer agents lives on
//! [`DaimondApp`](crate::wasm::app::DaimondApp) in [`crate::wasm::app`].
//!
//! OPFS layout, per Facet id:
//!
//! ```text
//! facets/<id>/brief.md                  the reduced state (agent writes, user may edit)
//! facets/<id>/versions/NNNN.md          a snapshot per brief version (0-padded)
//! facets/<id>/.daimond/meta.json        { name, brief_version, updated, tags }
//! facets/<id>/.daimond/log              append-only, one JSON record per line
//! facets/<id>/.daimond/deltas/NNNN.md   the raw delta a fold consumed, referenced by delta_ref
//! ```
//!
//! Each log record is a single-line JSON object:
//! `{ id, ts, kind, agent, task, parent_brief_version, brief_version,
//!    delta_ref, note }` with `kind` one of `create`, `edit`, `fold`.
//!
//! The store is app-local for now (a candidate for extraction into
//! `fe2o3_data` once its shape settles, per the v1 plan's D22); it is not
//! extracted here.  Whole-file read-modify-write backs the append (the
//! synchronous single-writer OPFS path is deferred); single-user,
//! single-Facet-at-a-time makes that sufficient for this stage.

use crate::facet_link::{Link, Node, normalise_note, normalise_rel, parse_links, write_links};
use crate::facet_meta::{Meta, normalise_tags};
use crate::llm::json_escape;
use crate::protocol::generate_session_id;
use crate::tools::FileRoot;
use crate::wasm::opfs;

use oxedyne_fe2o3_core::prelude::*;
use oxedyne_fe2o3_core::wasm::{console_log, now_ms};


/// The brief agent's role: it maintains one Facet's brief, resolving an
/// instruction to a file edit or to one or more errors, never to chat.
pub const BRIEF_AGENT_PROMPT: &str =
    "You are the conductor of this Facet. You take instructions from the user \
     and act; you do not converse. Two things are yours to do.\n\n\
     First, the brief. `brief.md` is the reduced state of this Facet. Edit it \
     with your file tools when the user tells you something worth keeping.\n\n\
     Second, agents. When a task needs work done rather than merely recorded, \
     dispatch a worker with `spawn_agent`. Each worker runs in its OWN context \
     with the full workspace file tools; it cannot see this conversation, so \
     the `task` you give it must say everything it needs to know. To run \
     several agents at once, call `spawn_agent` several times in the SAME turn \
     — they then run in parallel. If the user asks for two agents, call it \
     twice. Each reports back a summary the user can fold into the brief.\n\n\
     Use the tools you have. If an instruction cannot be carried out, say why, \
     briefly.";

/// A dispatched worker's role: one bounded task, in its own context, over the
/// user's real workspace, ending in a summary terse enough to fold.
pub const WORKER_PROMPT: &str =
    "You are a worker agent dispatched to carry out exactly one task. You have \
     the workspace file tools. You cannot ask questions — the task is all you \
     get, so use your judgement and finish it.\n\n\
     When you are done, end with a short summary of what you found or changed: \
     what a colleague would need to know, and nothing else. That summary is \
     folded into a shared brief, so keep it dense and free of filler.";

/// The reducer's role: fold exactly one delta into the current brief and
/// emit only the new brief markdown.  A fresh reducer holds no history,
/// so it cannot itself rot.
pub const REDUCER_PROMPT: &str =
    "Given the current brief and one delta, output the new brief. Keep the \
     goal, decisions and open threads; drop what the delta supersedes; \
     output only the new brief markdown.";


// ┌───────────────────────────────────────────────────────────────┐
// │ Path helpers                                                   │
// └───────────────────────────────────────────────────────────────┘

/// Daimond's own directory inside a Facet: the metadata, the log, the deltas.
const STORE_DIR: &str = ".daimond";

/// What that directory was called before the Red -> Daimond rename, and still is in
/// every workspace made before it.  See [`migrate`].
const LEGACY_STORE_DIR: &str = ".red";

/// The Facet root directory.
const ROOT_DIR: &str = "facets";

/// What the root was called before the Focus -> Facet rename.  A workspace made
/// before it still holds `foci/` on disk.  See [`migrate_root`].
const LEGACY_ROOT_DIR: &str = "foci";

/// The Facet directory, `facets/<id>`.
pub fn facet_dir(id: &str) -> String {
    fmt!("facets/{}", id)
}

/// The brief content file, `facets/<id>/brief.md`.
fn brief_path(id: &str) -> String {
    fmt!("facets/{}/brief.md", id)
}

/// The append-only log, `facets/<id>/.daimond/log`.
fn log_path(id: &str) -> String {
    fmt!("facets/{}/{}/log", id, STORE_DIR)
}

/// The metadata file, `facets/<id>/.daimond/meta.json`.
fn meta_path(id: &str) -> String {
    fmt!("facets/{}/{}/meta.json", id, STORE_DIR)
}

/// A brief-version snapshot, `facets/<id>/versions/NNNN.md`.
fn version_path(id: &str, version: u64) -> String {
    fmt!("facets/{}/versions/{:04}.md", id, version)
}

/// A stored raw delta, `facets/<id>/.daimond/deltas/NNNN.md`, keyed by the
/// brief version the fold produced.
fn delta_path(id: &str, version: u64) -> String {
    fmt!("facets/{}/{}/deltas/{:04}.md", id, STORE_DIR, version)
}


// ┌───────────────────────────────────────────────────────────────┐
// │ Migration                                                      │
// └───────────────────────────────────────────────────────────────┘

/// Move the whole Facet root from `foci/` to `facets/`, so a workspace made before the
/// Focus -> Facet rename opens with every pursuit intact.
///
/// This runs before [`list`] reads the root, and before the per-Facet [`migrate`], because
/// everything below depends on the new root existing.  Without it a user's Foci would
/// simply not be found: `list_dir("facets")` would fail, the rail would come up empty, and
/// every brief, version and fold record would read as though it had never existed.
///
/// The logs are rewritten too.  A log record's `delta_ref` holds a *path* written when the
/// fold was applied, so every historical record still points into `foci/`; left alone,
/// "view this delta" would fail on every fold the user has.  The rewrite is `foci/<id>/`
/// to `facets/<id>/`, which covers both the `.red/` and `.daimond/` store layouts, so a
/// workspace old enough to need both migrations gets this one first and the store move
/// second.
///
/// Idempotent, and it never clobbers: a workspace already migrated has no `foci/` to move,
/// and one holding both roots is left entirely alone rather than merged.  Returns whether
/// anything moved.
async fn migrate_root() -> Outcome<bool> {
    if !res!(opfs::exists(FileRoot::Opfs, LEGACY_ROOT_DIR).await) {
        return Ok(false);       // nothing to move: a new workspace, or one already migrated
    }
    if res!(opfs::exists(FileRoot::Opfs, ROOT_DIR).await) {
        return Ok(false);       // both present: not ours to reconcile, and not ours to destroy
    }
    res!(opfs::move_entry(FileRoot::Opfs, LEGACY_ROOT_DIR, ROOT_DIR).await);

    // Every log points at its deltas by a path that has just moved.
    let entries = match opfs::list_dir(FileRoot::Opfs, ROOT_DIR).await {
        Ok(e)  => e,
        Err(_) => return Ok(true),      // moved, but nothing to walk
    };
    for (id, is_dir, _size) in entries {
        if !is_dir {
            continue;
        }
        // The log is wherever this Facet's store currently is, and a workspace old enough to
        // predate this rename may still be on `.red/` -- [`migrate`] has not run yet, and
        // cannot, because it addresses the new root this function is only now creating. So
        // both are tried: looking only at `.daimond/` would skip exactly the oldest
        // workspaces, leaving their `delta_ref` paths pointing at a root that no longer
        // exists, which no later migration would match either.
        for store in [STORE_DIR, LEGACY_STORE_DIR] {
            let log = fmt!("{}/{}/{}/log", ROOT_DIR, id, store);
            if !res!(opfs::exists(FileRoot::Opfs, &log).await) {
                continue;
            }
            let bytes = res!(opfs::read_file(FileRoot::Opfs, &log).await);
            let text  = String::from_utf8_lossy(&bytes).to_string();
            let fixed = text.replace(
                &fmt!("{}/{}/", LEGACY_ROOT_DIR, id),
                &fmt!("{}/{}/", ROOT_DIR, id),
            );
            if fixed != text {
                res!(opfs::write_file(FileRoot::Opfs, &log, fixed.as_bytes()).await);
            }
        }
    }
    Ok(true)
}

/// Move a Facet's store from `.red/` to `.daimond/`, so a workspace made before the
/// rename opens with its history intact.
///
/// Without this a renamed Daimond simply would not find the old directory: [`read_meta`]
/// would fail, [`list`] would skip the Facet, and a real pursuit -- its brief versions, its
/// whole fold history -- would read as though it had never existed.  The brief itself
/// (`brief.md`) and its snapshots sit *outside* the store directory and are untouched
/// either way; what moves here is the metadata, the log and the retained deltas.
///
/// The log's `delta_ref` field holds a *path*, written when the fold was applied, so the
/// records are rewritten as the directory moves -- otherwise every historical delta would
/// still point into `.red/` and "view this delta" would fail on exactly the folds the user
/// has had longest.
///
/// Idempotent, and it never clobbers: a Facet already migrated has no `.red/` to move, and
/// one that somehow holds both directories is left entirely alone rather than merged.
/// Returns whether anything moved.
///
/// # Arguments
/// * `id` - The Facet whose store is to be migrated.
async fn migrate(id: &str) -> Outcome<bool> {
    let old = fmt!("facets/{}/{}", id, LEGACY_STORE_DIR);
    let new = fmt!("facets/{}/{}", id, STORE_DIR);
    if !res!(opfs::exists(FileRoot::Opfs, &old).await) {
        return Ok(false);       // nothing to move: a new Facet, or one already migrated
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
            &fmt!("facets/{}/{}/deltas/", id, LEGACY_STORE_DIR),
            &fmt!("facets/{}/{}/deltas/", id, STORE_DIR),
        );
        if fixed != text {
            res!(opfs::write_file(FileRoot::Opfs, &log, fixed.as_bytes()).await);
        }
    }
    Ok(true)
}


/// Read the brief as it stood at `version`.
///
/// Every fold and every hand-edit snapshots the brief, but nothing has ever
/// read one back, so an accepted fold that mangled the brief could not be
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

/// Read a Facet's metadata.
async fn read_meta(id: &str) -> Outcome<Meta> {
    let bytes = res!(opfs::read_file(FileRoot::Opfs, &meta_path(id)).await);
    let s = String::from_utf8_lossy(&bytes).to_string();
    Ok(Meta::from_json(&s))
}

/// Write a Facet's metadata.
async fn write_meta(id: &str, meta: &Meta) -> Outcome<()> {
    opfs::write_file(FileRoot::Opfs, &meta_path(id), meta.to_json().as_bytes()).await
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
              \"task\":\"{}\",\"parent_brief_version\":{},\
              \"brief_version\":{},\"delta_ref\":\"{}\",\"note\":\"{}\"}}",
            json_escape(&self.id), self.ts, self.kind, json_escape(&self.agent),
            json_escape(&self.task), self.parent, self.version,
            json_escape(&self.delta_ref), json_escape(&self.note),
        )
    }
}

/// Append a record to a Facet's log.
///
/// OPFS exposes whole-file writes only, so the append is read-modify-write
/// (single-user, single-Facet makes that safe for this stage; the
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
// │ Facet operations                                               │
// └───────────────────────────────────────────────────────────────┘

/// Create a Facet: its directory, an empty `brief.md`, version `0000`, a
/// `meta.json`, and a `create` log record.  Returns the new Facet id.
pub async fn create(name: &str) -> Outcome<String> {
    let id = generate_session_id();
    let now = now_ms() as u64;

    // Empty brief plus its version-0 snapshot.
    res!(opfs::write_file(FileRoot::Opfs, &brief_path(&id), b"").await);
    res!(opfs::write_file(FileRoot::Opfs, &version_path(&id, 0), b"").await);

    let meta = Meta { name: name.to_string(), version: 0, updated: now, tags: Vec::new() };
    res!(write_meta(&id, &meta).await);

    let rec = LogRecord {
        id:        generate_session_id(),
        ts:        now,
        kind:      "create",
        agent:     "user".to_string(),
        task:      "create facet".to_string(),
        parent:    -1,
        version:   0,
        delta_ref: String::new(),
        note:      name.to_string(),
    };
    res!(append_log(&id, &rec).await);
    Ok(id)
}

/// Rename a Facet, updating `meta.json`'s name and its `updated` stamp.
pub async fn rename(id: &str, name: &str) -> Outcome<()> {
    let mut meta = res!(read_meta(id).await);
    meta.name = name.to_string();
    meta.updated = now_ms() as u64;
    res!(write_meta(id, &meta).await);
    Ok(())
}

/// Set a Facet's tags, replacing whatever it held, and stamp it updated.
///
/// The tags are normalised here rather than taken on trust, so the store stays
/// clean whatever the caller sends (see
/// [`normalise_tags`](crate::facet_meta::normalise_tags)).
///
/// Nothing is appended to the log, because the log is the brief's audit trail
/// and a tag is not brief state.  Tagging leaves the version alone.
///
/// It leaves `updated` alone too, which is deliberate.  The rail is ordered by
/// `updated`, meaning most recently worked on; filing is not working on it, so
/// tagging must not reorder the rail.  Otherwise tidying a few Facets in one
/// sitting would shuffle them all to the top and lose the order that was the
/// point of the sort.  This is why it differs from `rename`, which does stamp.
pub async fn set_tags(id: &str, tags: &[String]) -> Outcome<()> {
    let mut meta = res!(read_meta(id).await);
    meta.tags = normalise_tags(tags);
    res!(write_meta(id, &meta).await);
    Ok(())
}

/// Delete a Facet: remove its whole directory (brief, versions, log, meta).
pub async fn delete(id: &str) -> Outcome<()> {
    opfs::delete_entry(FileRoot::Opfs, &facet_dir(id), true).await
}

/// List every Facet, returning a JSON array of
/// `{ id, name, brief_version, updated, tags }` ordered by most-recently
/// updated first.
///
/// This is the one door every Facet passes through before it can be opened, so it is where
/// a workspace made before the rename is migrated (see [`migrate`]).  A Facet that fails to
/// migrate is left in the list rather than dropped from it: the metadata read below decides
/// that, and a Facet the user can see and cannot open is a bug they can report, while one
/// that has silently vanished is a bug they can only mourn.
pub async fn list() -> Outcome<String> {
    // Before the root is read, because before the rename the root itself was elsewhere.
    if let Err(e) = migrate_root().await {
        console_log(&fmt!("The facets/ root could not be migrated from foci/: {}", e));
    }
    // A missing `facets/` root simply means no Facets yet.
    let entries = match opfs::list_dir(FileRoot::Opfs, ROOT_DIR).await {
        Ok(e)  => e,
        Err(_) => return Ok("[]".to_string()),
    };
    let mut rows: Vec<(String, Meta)> = Vec::new();
    for (name, is_dir, _size) in entries {
        if !is_dir {
            continue;
        }
        // Before the metadata is read, because before the rename it was somewhere else.
        if let Err(e) = migrate(&name).await {
            console_log(&fmt!("Facet '{}' could not be migrated to .daimond/: {}", name, e));
        }
        let meta = match read_meta(&name).await {
            Ok(m)  => m,
            Err(_) => continue, // not a Facet dir / no metadata
        };
        rows.push((name, meta));
    }
    // Most-recently updated first.
    rows.sort_by(|a, b| b.1.updated.cmp(&a.1.updated));
    let items: Vec<String> = rows.iter().map(|(id, m)| {
        fmt!(
            "{{\"id\":\"{}\",\"name\":\"{}\",\"brief_version\":{},\"updated\":{},\"tags\":{}}}",
            json_escape(id), json_escape(&m.name), m.version, m.updated, m.tags_json(),
        )
    }).collect();
    Ok(fmt!("[{}]", items.join(",")))
}

/// Read a Facet's current brief markdown.
pub async fn read_brief(id: &str) -> Outcome<String> {
    let bytes = res!(opfs::read_file(FileRoot::Opfs, &brief_path(id)).await);
    Ok(String::from_utf8_lossy(&bytes).to_string())
}

/// Snapshot a new brief version and return its number.
///
/// Writes `brief.md`, bumps the version, writes the `versions/NNNN.md`
/// snapshot and updates `meta.json`.  The caller appends the matching log
/// record.
async fn snapshot(id: &str, md: &str, now: u64) -> Outcome<u64> {
    let mut meta = res!(read_meta(id).await);
    let next = meta.version + 1;
    res!(opfs::write_file(FileRoot::Opfs, &brief_path(id), md.as_bytes()).await);
    res!(opfs::write_file(FileRoot::Opfs, &version_path(id, next), md.as_bytes()).await);
    meta.version = next;
    meta.updated = now;
    res!(write_meta(id, &meta).await);
    Ok(next)
}

/// Apply a user hand-edit to the brief: snapshot a new version and log an
/// `edit` record.
pub async fn write_brief(id: &str, md: &str) -> Outcome<()> {
    let now = now_ms() as u64;
    let parent = res!(read_meta(id).await).version;
    let version = res!(snapshot(id, md, now).await);
    let rec = LogRecord {
        id:        generate_session_id(),
        ts:        now,
        kind:      "edit",
        agent:     "user".to_string(),
        task:      "edit brief".to_string(),
        parent:    parent as i64,
        version:   version,
        delta_ref: String::new(),
        note:      String::new(),
    };
    append_log(id, &rec).await
}

/// Record a brief change made by the brief agent (a steer that edited
/// `brief.md`): snapshot a version and log an `edit` record whose task is
/// the instruction.  Called by [`crate::wasm::app`] after the agent turn,
/// only when the brief content actually changed.
pub async fn record_steer(id: &str, md: &str, instruction: &str) -> Outcome<()> {
    let now = now_ms() as u64;
    let parent = res!(read_meta(id).await).version;
    let version = res!(snapshot(id, md, now).await);
    let rec = LogRecord {
        id:        generate_session_id(),
        ts:        now,
        kind:      "edit",
        agent:     "brief-agent".to_string(),
        task:      instruction.to_string(),
        parent:    parent as i64,
        version:   version,
        delta_ref: String::new(),
        note:      String::new(),
    };
    append_log(id, &rec).await
}

/// Apply a confirmed fold: write the new brief, snapshot a version, store
/// the raw delta under `.daimond/deltas/`, and append a `fold` record that
/// references the stored delta.  Advisory-fold discipline: this runs only
/// after the user accepts the proposed brief; the raw delta is always
/// retained.
pub async fn fold_apply(id: &str, new_brief: &str, delta: &str, note: &str) -> Outcome<()> {
    let now = now_ms() as u64;
    let parent = res!(read_meta(id).await).version;
    let version = res!(snapshot(id, new_brief, now).await);

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

/// Read a Facet's log as a JSON array of records (each stored line is
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

/// A Facet's link sidecar, `facets/<id>/.daimond/links.jsonl`.
///
/// It sits beside the log rather than inside `brief.md` for two reasons.  A
/// fold rewrites the brief wholesale -- the reducer is asked for the new brief
/// and returns the whole of it -- so anything structural kept in that prose is
/// at a model's mercy on every fold.  And the brief is handed to the conductor
/// and to every worker it dispatches, so a growing list of links would be paid
/// for in tokens on every turn, by agents that have the file tools anyway.
fn links_path(id: &str) -> String {
    fmt!("{}/{}/{}/links.jsonl", ROOT_DIR, id, STORE_DIR)
}

/// Read one Facet's links.  A missing sidecar is no links, not a failure.
pub async fn read_links(id: &str) -> Outcome<Vec<Link>> {
    let path = links_path(id);
    if !res!(opfs::exists(FileRoot::Opfs, &path).await) {
        return Ok(Vec::new());
    }
    let bytes = res!(opfs::read_file(FileRoot::Opfs, &path).await);
    Ok(parse_links(&String::from_utf8_lossy(&bytes)))
}

/// Write one Facet's links, replacing the sidecar.
async fn write_links_for(id: &str, links: &[Link]) -> Outcome<()> {
    opfs::write_file(FileRoot::Opfs, &links_path(id), write_links(links).as_bytes()).await
}

/// Assert a link from one node to another, and return its id.
///
/// The record is stored once, on the Facet named by `from` when that end is a
/// Facet, and otherwise on `owner`.  It is never written twice: a link is found
/// from either end by [`links_touching`], which is what makes the graph two-way
/// without a second copy to keep consistent.
///
/// # Arguments
/// * `owner` - The Facet whose sidecar holds the record.
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
    Ok(id)
}

/// Remove a link from a Facet's sidecar.  Returns whether one went.
pub async fn remove_link(owner: &str, link_id: &str) -> Outcome<bool> {
    let links = res!(read_links(owner).await);
    let kept: Vec<Link> = links.iter().filter(|l| l.id != link_id).cloned().collect();
    if kept.len() == links.len() {
        return Ok(false);
    }
    res!(write_links_for(owner, &kept).await);
    Ok(true)
}

/// Every link touching `node`, from whichever Facet's sidecar holds it.
///
/// This is the read that makes the links two-way.  A record is stored once, in
/// one direction, so what points AT something is found by scanning rather than
/// by keeping a mirrored copy -- there is no second copy to fall out of step,
/// and a link hand-written into either end's sidecar counts just the same.
///
/// The scan walks every Facet, which is the same walk [`list`] already does on
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
        // One unreadable sidecar must not hide every other Facet's links.
        let links = match read_links(&id).await {
            Ok(l)  => l,
            Err(e) => {
                console_log(&fmt!("Facet '{}' has an unreadable link sidecar: {}", id, e));
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

/// Every link touching `node`, as the JSON array the surface returns.
///
/// Each entry carries the Facet whose sidecar holds the record, so a caller can
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
