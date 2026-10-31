use super::*;

// ── Two filesystems, and which one a file tool just answered about ───────────
//
// AUTHORED BY A DAIMON, through `dev/reflux.mjs --task opfssay`, 2026-08-24.  The guard
// condition, the `folder_open`/`present` pair and the shape of the sentence are the daimon's;
// what it never reached, and what is written here by hand, is the wiring at the two call sites
// and the `Absence` enum in place of its `for_list: bool`.  `dev/HATES.md` records where it
// stopped and what that cost.

// The clause both file tools share, spelled once so that they cannot drift apart.  It is also
// the anchor `dev/reflux.mjs` keys its `opfsSplit` allowance on, so a reword here is a reword
// there.
pub(super) const SECOND_FILESYSTEM: &str = ", which is the only filesystem the file tools reach while no \
    folder is open. The granted folder on this computer is a second one, which the run tool \
    reaches and a file tool cannot. Nothing here says the path is wrong: it may be sitting on \
    disk. Reach it with run -- its 'argv' takes the machine's own absolute paths, and its 'cwd' \
    names a folder in this workspace. Ask the user to open the folder if both should see one \
    place.";

/// What a file tool found in browser storage, which is not what it would have found on the
/// machine.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Absence {
    Missing,	// no entry of that name at all
    Empty,	// a folder, holding nothing
}

/// The note a file tool adds once it has answered about browser storage and the machine is a
/// second filesystem it cannot see.
///
/// **"Empty" and "not here" are different answers and only one of them is true.**  That is the
/// reasoning [`stopped_empty`] is built on, met again in a different tool: a `file_read` that
/// answers the browser's own `NotFoundError` and a `file_list` that answers *"x is empty."* are
/// both true OF BROWSER STORAGE, and neither says so.  A model reads the more specific-sounding
/// of the two as the path being wrong and stops.  Two live runs of 2026-08-24 ended exactly
/// there, and sonnet-4.5 named the wall in its own words -- *"that path isn't accessible to my
/// file tools -- they only reach the workspace copy, which is empty"* -- every clause of which
/// is true and whose conclusion is wrong.
///
/// It parts company with [`stopped_empty`] in what it does about it.  A stopped walk cannot
/// answer at all, so it refuses; a file tool here CAN answer, truthfully and completely, about
/// the place it looked.  What it may not do is let that answer be read as being about the other
/// place.  So the answer stays and the place is named.
///
/// # Arguments
/// * `path` - The path as the model wrote it, which is the one it must use again.
/// * `absence` - What was actually found, which is what the sentence must not overstate.
pub(crate) fn two_places_said(path: &str, absence: Absence) -> String {
    let head = match absence {
        Absence::Missing => fmt!("'{}' is not in this browser's own storage", path),
        Absence::Empty   => fmt!("'{}' is empty in this browser's own storage", path),
    };
    fmt!("{}{}", head, SECOND_FILESYSTEM)
}

/// [`two_places_said`], said only where there really are two places.
///
/// `None` where there is one: with a real folder open the file tools and a command see the same
/// filesystem, so "not here" IS about the machine and this would be false; with no hand paired
/// there is nowhere else to look and no `run` to name, so it would be noise on every miss.  A
/// sentence that appears when it is not true is how a reader learns to skip the one that is.
pub(super) fn two_places_note<H: Host>(path: &str, absence: Absence, host: &H) -> Option<String> {
    if !two_places(host) {
        return None;
    }
    Some(two_places_said(path, absence))
}

/// Are there two filesystems here at all?
///
/// A real folder open means the file tools and a command see one place, so "not here" IS about
/// the machine; no hand paired means there is nowhere else to look and no `run` to name. Spelled
/// once because four sentences now turn on it, and four copies of a condition is how three of
/// them come to be right.
pub(super) fn two_places<H: Host>(host: &H) -> bool {
    !host.fs().folder_open() && host.exec().present()
}

/// Is the entry a file tool was sent for absent from browser storage altogether -- and is there a
/// second filesystem it might be on?  The note to answer with, where both are true.
///
/// [`Tool::FileRead`] rules out cloud storage and a directory itself before it asks
/// [`two_places_note`], because its own failure has several causes.  The arms that touch one
/// entry and nothing else can ask this instead, and the `exists` call is what makes it safe: a
/// read that failed with the entry PRESENT failed for some other reason -- it is a directory, it
/// is being written -- and answering that with a sentence about a second filesystem would send
/// the model somewhere the file is not either.
///
/// # Arguments
/// * `raw` - The path as the model wrote it, which is the one the sentence must name.
/// * `path` - The same path, scoped, which is the one browser storage is asked about.
pub(super) async fn absent_here<H: Host>(ctx: &ToolContext<H>, raw: &str, path: &str) -> Option<String> {
    if matches!(ctx.host().fs().exists(ctx.root, path).await, Ok(true)) {
        return None;
    }
    two_places_note(raw, Absence::Missing, ctx.host())
}

// ── Which filesystem a write is about to land in ─────────────────────────────
//
// Every arm above answers a tool that FAILED, which is what lets them all ask `absent_here`:
// a read that could not find its entry has already told the caller something.  A write has
// nothing to ask.  The entry not being there is the ordinary case, and `opfs::descend` calls
// `set_create(true)` on every component it walks, so a write into a folder browser storage
// does not hold MAKES THE FOLDER rather than failing.
//
// So `file_write`'s half of the split is the opposite shape and the worse one.  The write
// SUCCEEDS -- folders invented, bytes stored, `done` returned -- while the daimon believes it
// has edited a file on the machine.  And it goes on succeeding.  A `file_read` of that path
// now works, a `file_list` of the invented folder lists what is in it, and `absent_here` says
// nothing anywhere, because the entry is present.  Every check the daimon can afterwards make
// AGREES with the answer it was given, which is why a sentence alone is not enough here: one
// line contradicted by every later signal is not a line a model can act on.
//
// Hence a refusal, and hence a narrow one.  It fires only where a second filesystem exists at
// all, only where the write would CREATE a folder to land -- which is the act nobody
// sanctioned, and the one a write aimed at the machine never needed -- and never on
// `diamonds/`, `chats/` or `mail/`, which ARE browser storage by design and which the page
// writes to itself on every mail refresh.  Everything else lands, and is told where.

// The clause `SECOND_FILESYSTEM` opens with, spelled again rather than borrowed.
// `dev/reflux.mjs` keys `opfsSplit` on these words, so both must carry them; and its
// `withoutNote` cuts the section above out of the `opfssay` fixture whole, so a constant taken
// from there would leave this one naming nothing.
pub(super) const ONLY_FILESYSTEM: &str = "this browser's own storage, which is the only filesystem the \
    file tools reach while no folder is open";

/// Where a `file_write` is about to put its bytes, on a page where a file tool and a command
/// see two different filesystems.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum WritePlace {
    NotInDoubt,		// one filesystem, or a path that is browser storage by design
    Storage,		// two of them, and this write lands in the browser's
    Inventing(String),	// two of them, and the write would make this folder to get there
}

/// What a write that landed in browser storage says under its own answer.
///
/// A second line, never a replacement: `dev/verify_replylen.mjs` reads the byte count off the
/// first, and `dev/verify_refusedpath.mjs` check 1c records what happens to a reader that stops
/// recognising an answer -- it does not read it as unknown, it reads it as something else.
pub(crate) fn landed_in_storage() -> String {
    fmt!("Written into {}. No folder on this computer changed; only run reaches those.",
        ONLY_FILESYSTEM)
}

/// The refusal a write earns when it would have to invent a folder in browser storage to land.
///
/// It says what would have happened rather than only that something was stopped, because the
/// thing worth knowing is that the success would have been indistinguishable from a real one.
///
/// # Arguments
/// * `path` - The path as the model wrote it, which is the one it must use again.
/// * `dir` - The outermost folder that is not there, which is the one worth naming.
/// * `marks` - The folders this turn marked in, comma-separated, or empty where it marked none.
pub(crate) fn would_invent_said(path: &str, dir: &str, marks: &str) -> String {
    // THE THREE PLACES BY NAME, because "reach it with run" is the one of them the model cannot
    // act on without knowing WHERE, and a refusal that leaves the reader to guess buys a round.
    let machine = if marks.is_empty() {
        fmt!("If you mean the file on this computer, no folder has been added to this chat, so \
            neither a file tool nor run reaches one -- ask the user to add one with the + in the \
            Workspace group.")
    } else {
        fmt!("If you mean the file on this computer, write it under {}, which a file tool reaches \
            as the real file and run reaches too.", marks)
    };
    fmt!(
        "Writing '{}' would put it in {}, and reaching it would create the folder '{}' there. \
        Nothing on this computer would change, and nothing afterwards would say so: the file \
        would read back and the folder would list. So it has not been written. {} If you mean \
        browser storage, make the folder with dir_create and write again. If you mean this \
        Diamond's own files, diamonds/<id>/ is always writable and is never on the machine. \
        Ask the user to open the folder if both should see one place.",
        path, ONLY_FILESYSTEM, dir, machine)
}

/// Every directory a path would need, outermost first, without its leaf.
///
/// `a/b/c.txt` gives `a`, then `a/b`.  A name at the workspace root gives nothing at all, which
/// is the answer that carries the rule: a write there invents no folder and is never refused.
pub(crate) fn dirs_needed(path: &str) -> Vec<String> {
    let p = normalise(path);
    let mut segs: Vec<&str> = p.split('/').filter(|s| !s.is_empty()).collect();
    segs.pop();	// the last component is the file being written, not a folder
    let mut out = Vec::new();
    let mut so_far = String::new();
    for s in segs {
        if !so_far.is_empty() {
            so_far.push('/');
        }
        so_far.push_str(s);
        out.push(so_far.clone());
    }
    out
}

/// Where this write will land, decided before it lands.
///
/// The cheap facts settle it first: with a real folder open, or with no hand paired, there is
/// one filesystem and nothing to decide; and a store path is browser storage whatever else is
/// true.  Only past those is browser storage asked anything, at one `exists` per directory
/// level -- and a path that reaches here is one the model wrote itself, because `scoped` only
/// ever prefixes with `diamonds/<id>`, which the store test has already sent home.
///
/// # Arguments
/// * `raw` - The path as the model wrote it, which is the one a sentence must name.
/// * `path` - The same path, scoped, which is the one browser storage is asked about.
pub(super) async fn write_place<H: Host>(ctx: &ToolContext<H>, raw: &str, path: &str) -> Outcome<WritePlace> {
    if ctx.host().fs().folder_open() || !ctx.host().exec().present() {
        return Ok(WritePlace::NotInDoubt);
    }
    if is_store_path(raw) || is_store_path(path) {
        return Ok(WritePlace::NotInDoubt);
    }
    for dir in dirs_needed(path) {
        if !res!(ctx.host().fs().exists(ctx.root, &dir).await) {
            return Ok(WritePlace::Inventing(dir));
        }
    }
    Ok(WritePlace::Storage)
}

// ── The file tools' door onto the machine ───────────────────────────────────
//
// `dev/BLOCKERS.md` B2: a daimon could run a program that changes a file and could not ask
// for a file to be changed, so every edit was spelled as `sed`, and one apostrophe cost 71
// of a run's 91 calls. The hand has carried a `file` request since the commit before this
// one; what follows is which paths go through it.
//
// **THE RULE IS THE MARKS, AND IT IS THE COMMAND FENCE'S OWN RULE.** A path under a folder
// the user marked into this turn is a path on the machine; everything else is browser
// storage, exactly as before. That is not a convenience: `fence_spec` builds a command's
// fence out of the same `Bound::OnlyUnder` / `Bound::OnlyWriteUnder` list, for reading as
// well as for writing, so a file tool reaching the machine reaches EXACTLY the roots a
// command reaches and not one directory more. The long comment in `fence_spec` explains why
// a command's read is fenced when a file tool's is free -- reading is free where Daimond can
// see what is read, and a command is opaque -- and that reasoning is why this door does not
// widen: a file tool WRITING to the machine is a write, and the two legs of the
// exfiltration path it describes are both inside the marks either way.
//
// Three things follow, and each closes a way this could have gone wrong:
//
//   * **An unmarked turn reaches nothing.** No marks, no machine paths, whatever the hand
//     was granted. `fence_spec` turns an absent allow-list into the granted root; this does
//     the opposite and fails closed, because a chat that never marked a folder in has not
//     asked for one.
//   * **The store is never on the machine.** `diamonds/<id>`, `chats/<id>/work` and
//     `mail/<address>` are browser storage by design and by construction, so they are
//     dropped here exactly as `fence_spec` drops them -- and for the stronger reason, that
//     they are not places on this machine at all.
//   * **An open folder settles it outright.** With a real folder open the file tools and a
//     command already see one filesystem, and routing through the hand would be a second
//     road to the same file with a different set of rules on it.

/// Every folder this turn marked in, normalised, in the form a path is tested against.
///
/// The same read `fence_spec` makes of the same bounds, deliberately: a mark that is dropped
/// there -- an empty prefix, a path in the store -- is dropped here, so the door and the
/// fence cannot come to disagree about what the marks are.
///
/// # Arguments
/// * `bounds` - The turn's rules, as `ToolContext::no_write` holds them.
pub(crate) fn marks_of(bounds: &[Bound]) -> Vec<String> {
    bounds.iter()
        .filter_map(|b| match b {
            Bound::OnlyUnder(p) | Bound::OnlyWriteUnder(p) => Some(normalise(p)),
            _ => None,
        })
        .filter(|p| !p.is_empty())
        .filter(|p| !is_store_path(p))
        // Dropped for the same reason `fence_spec` drops it: a mark under Daimond's own
        // directory can never be granted, so the door must not name it either, or the door and
        // the fence disagree about what the marks are.  By the same predicate, so they cannot.
        .filter(|p| !in_daimond_dir(p))
        .collect()
}

/// The mark a path sits under, where it sits under one.
///
/// Answers the mark rather than a yes, because the caller needs it: it is where the
/// operation runs, and a working directory that is not inside the fence is refused by the
/// hand before anything is opened.
///
/// # Arguments
/// * `bounds` - The turn's rules.
/// * `path` - A workspace-relative path, already normalised.
pub(crate) fn mark_over(bounds: &[Bound], path: &str) -> Option<String> {
    if is_store_path(path) {
        return None;
    }
    marks_of(bounds).into_iter().find(|m| under(path, m))
}

// ── One filesystem, four places ──────────────────────────────────────────────
//
// The workspace is ONE tree of relative paths, and the model must never have to work out which
// storage a path lives in before it can name one.  What it does need is to be TOLD, in the
// listing and in a refusal, because the four places behave differently when something goes
// wrong: a cloud-only file needs fetching, a machine file is reachable by `run` as well, and the
// store is browser storage whatever folder is open.

/// The largest cloud-only file a `file_read` or `file_edit` brings down for itself, in bytes.
///
/// 256 KiB, which is about a long source file and well under the read window's own 512 KiB cut --
/// so a fetch this makes is a fetch the read was going to want the whole of.  Past it the refusal
/// stands and `file_fetch` is named, because a transfer worth a sentence is a transfer worth the
/// model deciding on: the user is paying for the bytes.
pub(crate) const AUTO_FETCH_MAX: u64 = 256 * 1024;

/// Which of the workspace's places a path is in, as `file_list` says it and a refusal names it.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Where {
    Local,		// OPFS, or the open folder: the default, and unannotated
    Machine,	// under a mark, reached through the hand
    Cloud,		// in the cloud index and not on this device
    Store,		// diamonds/, chats/<id>/work, mail/<address>: browser storage by design
}

/// Which place a path is in, decided from facts the caller has already established.
///
/// The environment is passed in rather than read here so that the whole decision is one pure
/// function with a unit test per answer: the wasm arms know whether there are two filesystems and
/// what the cloud index says, and the native build has neither and passes `false`/`None`.
///
/// Order matters and is the point.  The store is asked first because it is the one answer that is
/// true whatever else is -- `diamonds/<id>` resolves to browser storage even when the path also
/// sits under a mark -- and the mark is asked before the cloud index because a marked folder holds
/// the real file, so a stale cloud entry for it must not send the model off to fetch a copy.
///
/// # Arguments
/// * `bounds` - The turn's rules, as [`ToolContext::no_write`] holds them.
/// * `path` - The workspace-relative path, scoped.
/// * `two_places` - Whether a hand is paired with no folder open, i.e. whether a mark means the
///   machine at all.
/// * `cloud_size` - What the cloud index says about this path, or `None`.
pub(crate) fn where_of(
    bounds:     &[Bound],
    path:       &str,
    two_places: bool,
    cloud_size: Option<u64>,
)
    -> Where
{
    if is_store_path(path) {
        return Where::Store;
    }
    if two_places && mark_over(bounds, &normalise(path)).is_some() {
        return Where::Machine;
    }
    if cloud_size.is_some() {
        return Where::Cloud;
    }
    Where::Local
}

/// The sentence a store root carries in a root listing, or `None` for an ordinary folder.
///
/// Only at the ROOT, and only on these three names: they are the workspace's own furniture, and a
/// model that reads `diamonds/` as a project folder writes into it.  Every other entry says
/// nothing, because the default -- on this device, ordinary storage -- is what silence means.
pub(crate) fn store_root_note(name: &str) -> Option<&'static str> {
    match name {
        STORE_ROOT => Some("Daimond's own store: browser storage on this device, never on the machine"),
        CHAT_ROOT  => Some("this device's chat workspaces: browser storage"),
        MAIL_ROOT  => Some("synced mailboxes: browser storage"),
        _          => None,
    }
}

/// One entry of a `file_list` answer, with where it is inside the parentheses the page's readers
/// already parse.
///
/// **Nothing is ever added as a bare line.**  Two page-side readers turn this text into entries --
/// the Work panel's and the sync census's -- and a line neither recognises becomes a phantom file
/// that another device then syncs against.  `dev/verify_refusedpath.mjs` check 1c is the write-up
/// of the last time that happened, so every annotation goes inside the existing parentheses.
///
/// # Arguments
/// * `at_root` - Whether this listing is of the workspace root, which is the only place the three
///   store notes belong.
/// * `host` - The machine's name, for a `Where::Machine` entry; empty prints "on the machine".
pub(crate) fn listing_line(
    name:    &str,
    is_dir:  bool,
    size:    u64,
    w:       Where,
    at_root: bool,
    host:    &str,
)
    -> String
{
    let note = match w {
        Where::Store if at_root => store_root_note(name).map(|n| n.to_string()),
        Where::Store            => None,
        Where::Cloud            => Some("in cloud storage".to_string()),
        Where::Machine          => Some(if host.is_empty() {
            "on the machine".to_string()
        } else {
            fmt!("on {}", host)
        }),
        Where::Local            => None,
    };
    match (is_dir, note) {
        (true,  None)    => fmt!("{}/\n", name),
        (true,  Some(n)) => fmt!("{}/  ({})\n", name, n),
        (false, None)    => fmt!("{}  ({} bytes)\n", name, size),
        (false, Some(n)) => fmt!("{}  ({} bytes, {})\n", name, size, n),
    }
}

/// What a file tool answers when the path is nowhere in the workspace and there is no second
/// filesystem to blame.
///
/// **This is the largest single bucket of tool failures on the bank**: ~80 of 141 errors in r1
/// were a `file_read` or `file_list` of a path the model had spelled relative to the wrong root --
/// `src/util.js` where the workspace holds `t_model-…/src/util.js`.  With no hand paired
/// `two_places_note` answers `None`, the arm fell through to the raw read, and what reached the
/// model was the browser's own exception: `Error: OPFS: open dir 'src' failed:
/// JsValue(NotFoundError: …)`.  An envelope addressed to a developer, carrying no clue about
/// the rule it broke.
///
/// So the sentence names the rule, the nearest folder that does exist, and what IS at the root --
/// which is what makes the fix cost zero extra rounds: the model does not have to spend a
/// `file_list '.'` to find out where it is.
///
/// # Arguments
/// * `raw` - The path as the model wrote it, which is the one it must correct.
/// * `nearest` - The deepest ancestor that does exist, `.` for the root.
/// * `roots` - The root's top-level entries, comma-separated, or empty where none could be read.
pub(crate) fn not_in_workspace_said(raw: &str, nearest: &str, roots: &str) -> String {
    let mut s = fmt!(
        "'{}' is not in the workspace. Paths are relative to the workspace root, not to any \
        folder inside it, and the nearest folder that does exist is '{}'.", raw, nearest);
    if roots.is_empty() {
        s.push_str(" file_list '.' shows what is here.");
        return s;
    }
    s.push_str(&fmt!(" The workspace root holds: {}.", roots));
    // The likely correction, spelled out, where the root has exactly one folder the model could
    // have meant.  Naming it is worth a round: the model that wrote `src/util.js` meant
    // `<somewhere>/src/util.js` and has to guess which `<somewhere>` otherwise.
    let lead = normalise(raw);
    let first = lead.split('/').next().unwrap_or("");
    let dirs: Vec<&str> = roots.split(", ")
        .map(|e| e.trim_end_matches('/'))
        .filter(|e| !e.is_empty() && *e != first
            && store_root_note(e).is_none())
        .collect();
    if dirs.len() == 1 {
        s.push_str(&fmt!(" So the file you mean is probably '{}/{}'.", dirs[0], lead));
    }
    s
}

/// The workspace root's top-level entries, for a prompt or a refusal to name.
///
/// Capped in both directions -- at most [`ROOT_LIST_MAX`] names and [`ROOT_LIST_CHARS`]
/// characters -- because this rides on every request of every round and an enormous root would
/// otherwise buy orientation at the price of the context it was meant to save.  Directories keep
/// their trailing slash, so the model can tell a folder to descend into from a file to read.
pub(crate) fn root_entries_said(entries: &[(String, bool)]) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut chars = 0usize;
    let mut cut = false;
    for (name, is_dir) in entries.iter().take(ROOT_LIST_MAX) {
        let one = if *is_dir { fmt!("{}/", name) } else { name.clone() };
        if chars + one.len() + 2 > ROOT_LIST_CHARS {
            cut = true;
            break;
        }
        chars += one.len() + 2;
        out.push(one);
    }
    if entries.len() > out.len() {
        cut = true;
    }
    if out.is_empty() {
        return String::new();
    }
    let mut s = out.join(", ");
    if cut {
        s.push_str(", …");
    }
    s
}

/// Most entries the root listing in a prompt or refusal names.
pub(crate) const ROOT_LIST_MAX: usize = 40;

/// Most characters that listing may take.
pub(crate) const ROOT_LIST_CHARS: usize = 300;

/// The orientation note a turn carries: where the model is, and what is at the root.
///
/// **The biggest round sink measured on the bank, and it is not a tool failure at all.**  21 of
/// 27 Claude trials opened by reading a path spelled relative to the wrong root, met the browser's
/// not-found, spent a `file_list '.'` and read again: 44 rounds over 16 trials, more than any
/// single tool cost.  A shell agent never pays this because its prompt says what its working
/// directory is; this says the same thing, once per turn.
///
/// Composed rather than written into `prompts/chat.md`, for [`crate::prompts::VISION_NOTE`]'s
/// reason: it is a FACT about this turn, it changes between turns, and a user's rewrite of their
/// own prompt must not be able to lose it.
///
/// Empty where the root could not be read or holds nothing, because a sentence naming no entries
/// teaches the model only that the app does not know either.
///
/// # Arguments
/// * `entries` - The root's top-level entries as `(name, is_dir)`, in the listing's own order.
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub(crate) fn orientation_note(entries: &[(String, bool)]) -> String {
    let roots = root_entries_said(entries);
    if roots.is_empty() {
        return String::new();
    }
    fmt!(
        "## Where you are\n\nEvery path a file tool takes is relative to the workspace root, \
        never to a folder inside it. The root holds: {}", roots)
}

/// Most characters [`format_orientation_tree`] may spend on the tree itself.
///
/// Measured against Claude Code's own directory snapshot -- a handful of screens' worth costs one
/// cache write per turn (see the module note on hot vs cold) and nothing past it is worth the
/// tokens; [`file_glob`](Tool::FileGlob) reaches the rest on demand.
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub(crate) const ORIENTATION_TREE_CHARS: usize = 1_500;

/// One entry the orientation walk found, already stamped with its own depth.
///
/// Depth is relative to the walk's OWN start -- 0 for a start's immediate children -- because the
/// root walk and each attached mark's walk are separate calls with separate caps (depth 2 under
/// the root, depth 3 under a mark; see [`orientation_tree_note`]).  Held flat rather than nested:
/// the entries a caller passes are already in the order the walk found them, and a flat slice is
/// what [`format_orientation_tree`] needs to decide, per entry, whether it survives the cap.
#[derive(Clone, Debug, Eq, PartialEq)]
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub(crate) struct TreeNode {
    pub path:      String,       // workspace-relative from the walk's own start, e.g. "packages/x/src"
    pub is_dir:    bool,
    pub files:     usize,        // files under a directory, recursively; 0 for a plain file
    pub bytes:     u64,          // total size in bytes; a directory sums its descendants
    pub depth:     usize,        // 0 = the walk's own immediate children
}

/// One line of [`format_orientation_tree`]'s output for a single entry.
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub(super) fn tree_line(node: &TreeNode) -> String {
    let indent = "  ".repeat(node.depth);
    if node.is_dir {
        if node.files == 0 {
            fmt!("{}{}/", indent, node.path)
        } else {
            fmt!("{}{}/ ({} file{}, {})", indent, node.path, node.files,
                if node.files == 1 { "" } else { "s" }, in_units(node.bytes as usize))
        }
    } else {
        fmt!("{}{} ({})", indent, node.path, in_units(node.bytes as usize))
    }
}

/// Does a directory's own name look like the source or test tree itself, rather than packaging
/// or metadata sitting beside it?
///
/// Used only to order which children of an oversized kept root are cut (see
/// [`fit_root_within`]): a `package.json` sibling of `src/` and `test/` is exactly the kind of
/// small, easily-fitting file that used to survive a size-first cut while the two folders the
/// model actually needed were dropped.
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub(super) fn looks_like_source_dir(path: &str) -> bool {
    let leaf = path.rsplit('/').next().unwrap_or(path).to_lowercase();
    matches!(leaf.as_str(), "src" | "source" | "lib" | "test" | "tests")
}

/// The position in `recent` (0 = newest) of the freshest file the walk found at or under `root`,
/// or `None` where nothing under it carries a known modification time.
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub(super) fn root_recency(root: &str, recent: &[String]) -> Option<usize> {
    let prefix = fmt!("{}/", root);
    recent.iter().position(|p| p == root || p.starts_with(&prefix))
}

/// Is `cwd` this root itself, or does it sit under it?
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub(super) fn root_holds_cwd(root: &str, cwd: &str) -> bool {
    !cwd.is_empty() && (cwd == root || cwd.starts_with(&fmt!("{}/", root)))
}

/// One past the last descendant of `kept[start]`: everything following it that sits deeper than
/// it does, which for a pre-order walk is exactly its own subtree.
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub(super) fn subtree_end(kept: &[&TreeNode], start: usize) -> usize {
    let depth = kept[start].depth;
    let mut end = start + 1;
    while end < kept.len() && kept[end].depth > depth {
        end += 1;
    }
    end
}

/// Trims one root that must be kept whole in principle down to `budget` characters, by dropping
/// whole direct children (each with its own descendants) rather than individual lines -- a
/// `src/` missing half its files would mislead more than one named as cut.
///
/// Drop order is non-source children first, stalest first within that group, and only then a
/// `src`/`test`/`lib`-like child, itself stalest first -- never the reverse, so the folder a task
/// actually needs is the last thing this gives up. At least the root's own line, plus its single
/// highest-priority child's subtree, always survives, matching the guarantee
/// [`format_orientation_tree`] gives every other root.
///
/// # Arguments
/// * `kept` - The full depth-filtered node list `root`'s indices are into.
/// * `root` - Index of the root's own line.
/// * `end` - One past the root's last descendant, i.e. [`subtree_end`] of `root`.
/// * `budget` - Most characters this root's own contribution may spend, its own line included.
/// * `recent` - Full-depth paths, newest first, used to rank each child's own staleness.
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub(super) fn fit_root_within(
    kept:   &[&TreeNode],
    root:   usize,
    end:    usize,
    budget: usize,
    recent: &[String],
)
    -> (Vec<String>, usize, usize)
{
    let root_line = tree_line(kept[root]);
    let mut used = root_line.chars().count() + 1;
    let depth = kept[root].depth;
    let children: Vec<usize> = (root + 1..end).filter(|&k| kept[k].depth == depth + 1).collect();

    // Kept preferentially: source-like children first, then freshest first within a tier -- the
    // exact reverse of the order they would be dropped in.
    let mut priority = children.clone();
    priority.sort_by_key(|&c| (
        !looks_like_source_dir(&kept[c].path),
        root_recency(&kept[c].path, recent).unwrap_or(usize::MAX),
    ));

    let mut keep: HashSet<usize> = HashSet::new();
    for &c in &priority {
        let ce = subtree_end(kept, c);
        let cost: usize = kept[c..ce].iter().map(|n| tree_line(n).chars().count() + 1).sum();
        if used + cost <= budget || keep.is_empty() {
            used += cost;
            keep.insert(c);
        }
    }

    let mut cut_dirs = 0usize;
    let mut cut_files = 0usize;
    let mut lines = vec![root_line];
    for &c in &children {
        if keep.contains(&c) {
            let ce = subtree_end(kept, c);
            lines.extend(kept[c..ce].iter().map(|n| tree_line(n)));
        } else if kept[c].is_dir {
            cut_dirs += 1;
        } else {
            cut_files += 1;
        }
    }
    (lines, cut_dirs, cut_files)
}

/// Claude-Code-grade directory snapshot: a depth-limited tree, cut by relevance rather than size
/// when it does not fit [`ORIENTATION_TREE_CHARS`].
///
/// **Cut order is by staleness, whole subtrees at a time, not by size.** The top-level entry
/// holding the newest file `recent` names, and the one holding `cwd`, are kept whole; the rest
/// are added in the same order a "Recently changed" line would name them, freshest first, until
/// the next one would not fit -- everything from there on, no fresher than what just failed, is
/// cut as one stale block. `package.json (122 bytes)` surviving while `src/` and `test/` are cut
/// -- the failure this replaces -- can no longer happen: a small, stale sibling is worth less
/// than a large, relevant one, not more.
///
/// A root that alone exceeds what is left of the budget is not dropped for being kept whole
/// wrongly -- see [`fit_root_within`] for how it gives up its own least-relevant children first.
///
/// Depth is enforced here as well as by the walker that built `nodes`, so a caller's mistake does
/// not silently reach the model as a wider tree than the design allows.
///
/// # Arguments
/// * `nodes` - Every candidate entry the walk found.
/// * `max_depth` - The deepest depth (inclusive) shown; anything deeper is dropped before sizing.
/// * `cap` - Most characters the rendered tree, including its own cut notice, may take.
/// * `cwd` - The turn's own working folder, workspace-relative; empty for the workspace root.
/// * `recent` - Full-depth paths the same walk found, newest first (see [`orientation_tree`]).
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub(crate) fn format_orientation_tree(
    nodes:     &[TreeNode],
    max_depth: usize,
    cap:       usize,
    cwd:       &str,
    recent:    &[String],
)
    -> String
{
    let kept: Vec<&TreeNode> = nodes.iter().filter(|n| n.depth <= max_depth).collect();
    if kept.is_empty() {
        return String::new();
    }
    let mut roots: Vec<usize> = (0..kept.len()).filter(|&i| kept[i].depth == 0).collect();
    if roots.is_empty() {
        // A real walk always pushes depth 0 first; this is only a safety net against malformed
        // input, so it skips the relevance ordering below rather than mis-deriving it.
        return kept.iter().map(|n| tree_line(n)).collect::<Vec<_>>().join("\n");
    }

    let recent_root_idx = roots.iter().copied()
        .filter_map(|i| root_recency(&kept[i].path, recent).map(|r| (r, i)))
        .min()
        .map(|(_, i)| i);
    let cwd_root_idx = roots.iter().copied().find(|&i| root_holds_cwd(&kept[i].path, cwd));

    let mut order: Vec<usize> = Vec::with_capacity(roots.len());
    for i in [recent_root_idx, cwd_root_idx].into_iter().flatten() {
        if !order.contains(&i) {
            order.push(i);
        }
    }
    let priority: HashSet<usize> = order.iter().copied().collect();
    roots.sort_by_key(|&i| root_recency(&kept[i].path, recent).unwrap_or(usize::MAX));
    for i in roots {
        if !order.contains(&i) {
            order.push(i);
        }
    }

    // Greedily fills `order` into `budget` characters, whole subtrees at a time. Run twice when
    // something is cut: the first pass does not know how long its own cut notice will be, so a
    // second pass against `cap` minus that notice's length is what keeps the total at or under
    // `cap` -- the notice's own wording can only shrink on the retry (fewer units fit a smaller
    // budget, never more), so one retry is enough to converge.
    let fit_at = |budget: usize| -> (Vec<String>, usize, usize) {
        let mut lines: Vec<String> = Vec::new();
        let mut used = 0usize;
        let mut cut_dirs = 0usize;
        let mut cut_files = 0usize;
        for (pos, &i) in order.iter().enumerate() {
            let end = subtree_end(&kept, i);
            let unit_lines: Vec<String> = kept[i..end].iter().map(|n| tree_line(n)).collect();
            let unit_cost: usize = unit_lines.iter().map(|l| l.chars().count() + 1).sum();
            if used + unit_cost <= budget {
                used += unit_cost;
                lines.extend(unit_lines);
                continue;
            }
            if priority.contains(&i) || lines.is_empty() {
                // Kept whole is the rule, and a first root emptying the tree entirely is worse
                // than one over budget: either way, give up only its own least-relevant children.
                let (fitted, dirs, files) = fit_root_within(
                    &kept, i, end, budget.saturating_sub(used).max(1), recent);
                used += fitted.iter().map(|l| l.chars().count() + 1).sum::<usize>();
                lines.extend(fitted);
                cut_dirs += dirs;
                cut_files += files;
                continue;
            }
            // Nothing from here on is fresher than the root that just failed to fit: cut the
            // rest of `order` as one stale block rather than hunting for a smaller straggler.
            for &j in &order[pos..] {
                if kept[j].is_dir { cut_dirs += 1 } else { cut_files += 1 }
            }
            break;
        }
        (lines, cut_dirs, cut_files)
    };

    let notice = |dropped: usize, cut_dirs: usize, cut_files: usize| -> String {
        if dropped == 0 {
            return String::new();
        }
        let mut kind = Vec::new();
        if cut_dirs > 0 {
            kind.push(fmt!("{} stale director{}", cut_dirs, if cut_dirs == 1 { "y" } else { "ies" }));
        }
        if cut_files > 0 {
            kind.push(fmt!("{} stale file{}", cut_files, if cut_files == 1 { "" } else { "s" }));
        }
        let kind_desc = if kind.is_empty() { fmt!("entries") } else { kind.join(", ") };
        fmt!("\n{}{} more ({}); file_glob to see them", ORIENTATION_CUT_LEAD, dropped, kind_desc)
    };

    let (lines, cut_dirs, cut_files) = fit_at(cap);
    let tail = notice(kept.len() - lines.len(), cut_dirs, cut_files);
    let (lines, tail) = if tail.is_empty() {
        (lines, tail)
    } else if lines.join("\n").chars().count() + tail.chars().count() <= cap {
        (lines, tail)
    } else {
        // The first pass could not know its own notice's length before choosing what to keep.
        // Retried once against a worst-case reserve for that notice -- every count it could ever
        // name is at most `kept.len()`, so sizing the reserve off that (not off the pass-1 tail,
        // which under-reserves whenever the retry itself drops something further) guarantees this
        // second selection is final: whatever it actually drops, the true notice for it is no
        // longer than the reserve, so it is never re-derived out from under a choice already made.
        let reserve = notice(kept.len(), kept.len(), kept.len()).chars().count();
        let (lines2, dirs2, files2) = fit_at(cap.saturating_sub(reserve));
        (lines2.clone(), notice(kept.len() - lines2.len(), dirs2, files2))
    };
    let mut body = lines.join("\n");
    body.push_str(&tail);
    body
}

/// The one-line "where you are" a Claude-Code-style cwd sentence gives for free.
///
/// # Arguments
/// * `cwd` - The turn's own working folder, workspace-relative; empty for the workspace root.
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub(crate) fn orientation_cwd_line(cwd: &str) -> String {
    if cwd.is_empty() {
        fmt!("{} the workspace root; paths are relative to it.", ORIENTATION_CWD_LEAD)
    } else {
        fmt!("{} `{}/`; paths are relative to the workspace root, not to this folder.",
            ORIENTATION_CWD_LEAD, cwd)
    }
}

// How the orientation note's own lines open, which is how one copy's line is matched to
// another's in a change list (`orientation_line_key`).
pub(super) const ORIENTATION_CWD_LEAD:     &str = "Your working folder is";
pub(super) const ORIENTATION_RECENT_LEAD:  &str = "Recently changed:";
pub(super) const ORIENTATION_CUT_LEAD:     &str = "\u{2026} ";

/// What one line of the orientation note is about, so two copies of the tree can be compared
/// entry by entry (r578c, D-20261020-03): an entry's path without its size, or the lead of one
/// of the note's own sentences.  A line's indent is not part of it.
pub(crate) fn orientation_line_key(line: &str) -> &str {
    let l = line.trim();
    for lead in [ORIENTATION_CWD_LEAD, ORIENTATION_RECENT_LEAD, ORIENTATION_CUT_LEAD] {
        if l.starts_with(lead) {
            return lead;
        }
    }
    // `path (12 B)` or `dir/ (3 files, 1 KB)`; a name may hold " (" itself, so the last one.
    match (l.ends_with(')'), l.rfind(" (")) {
        (true, Some(i)) => &l[..i],
        _               => l,
    }
}

/// The "recent changes" substitute for git status: the newest-modified files the same walk found,
/// newest first, capped to a handful of lines.
///
/// # Arguments
/// * `recent` - Paths with a known modification time, already sorted newest first.
/// * `max` - Most lines shown.
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub(crate) fn orientation_recent_lines(recent: &[String], max: usize) -> String {
    if recent.is_empty() {
        return String::new();
    }
    let shown: Vec<&String> = recent.iter().take(max).collect();
    fmt!("{} {}", ORIENTATION_RECENT_LEAD, shown.iter().map(|s| s.as_str())
        .collect::<Vec<_>>().join(", "))
}

/// The full Claude-Code-grade orientation note: cwd, a depth-limited tree, and recent changes --
/// composed once per turn (see the module note on hot vs cold: it must be byte-stable within a
/// turn, never re-listed mid-turn).
///
/// Empty only where `nodes` is empty, matching [`orientation_note`]'s own rule: a sentence naming
/// nothing teaches the model only that the app does not know either.
///
/// # Arguments
/// * `cwd` - The turn's own working folder, workspace-relative.
/// * `nodes` - Every candidate entry the walk found: depth 0-2 under the root, or 0-3 under a mark.
/// * `max_depth` - Passed straight to [`format_orientation_tree`].
/// * `recent` - Full-depth paths the same walk found, newest first; passed whole to
///   [`format_orientation_tree`] for its relevance ordering, then only the first 8 are shown via
///   [`orientation_recent_lines`].
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub(crate) fn orientation_tree_note(
    cwd:       &str,
    nodes:     &[TreeNode],
    max_depth: usize,
    recent:    &[String],
)
    -> String
{
    let tree = format_orientation_tree(nodes, max_depth, ORIENTATION_TREE_CHARS, cwd, recent);
    if tree.is_empty() {
        return String::new();
    }
    let mut s = fmt!("## Where you are\n\n{}\n\n{}", orientation_cwd_line(cwd), tree);
    let recent = orientation_recent_lines(recent, 8);
    if !recent.is_empty() {
        s.push_str("\n\n");
        s.push_str(&recent);
    }
    s
}

/// The names [`SKIP_DIRS`] already passes over, plus a Diamond's own version history -- noise for
/// an orientation snapshot, since it is never where a user's own work sits.
///
/// # Arguments
/// * `path` - A directory's own workspace-relative path, from the walk's own start.
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub(super) fn orientation_skips(path: &str) -> bool {
    let segs: Vec<&str> = path.trim_matches('/').split('/').collect();
    let name = segs.last().copied().unwrap_or("");
    Skips::default_rule().skips(name)
        || (segs.len() >= 3 && segs[0] == "diamonds" && segs[2] == "versions")
}

/// Every workspace-relative path an [`orientation_tree`] walk should start from: the workspace
/// root always, plus one entry per attached mark (skipping Daimond's own store, which the hand
/// cannot see and the tree would only mislead about).
///
/// # Arguments
/// * `bounds` - The turn's [`Bound`] rules, in the order they were declared.
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub(super) fn orientation_marks(bounds: &[Bound]) -> Vec<String> {
    let mut out = Vec::new();
    for b in bounds {
        let p = match b {
            Bound::OnlyUnder(p) | Bound::OnlyWriteUnder(p) => p,
            _ => continue,
        };
        let n = normalise(p);
        if !n.is_empty() && !is_store_path(&n) && !out.contains(&n) {
            out.push(n);
        }
    }
    out
}

/// Walks one directory to `max_depth`, gathering [`TreeNode`]s and the newest modification times
/// it saw, for [`orientation_tree`].
///
/// Boxed for recursion (`async fn` cannot recurse directly) and bounded by [`WALK_ENTRIES_MAX`]
/// the same way every other walk in this file is, so a huge marked folder cannot turn one turn's
/// briefing into an unbounded scan.
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub(super) fn walk_orientation<'a, H: Host>(
    ctx:      &'a ToolContext<H>,
    start:    &'a str,
    rel:      &'a str,
    depth:    usize,
    max_depth: usize,
    budget:   &'a mut WalkBudget,
    out:      &'a mut Vec<TreeNode>,
    recent:   &'a mut Vec<(String, f64)>,
)
    -> std::pin::Pin<Box<dyn std::future::Future<Output = (usize, u64)> + 'a>>
{
    Box::pin(async move {
        let full = if rel.is_empty() { start.to_string() } else { fmt!("{}/{}", start, rel) };
        let entries = match ctx.host().fs().list_dir_stamped(ctx.root, &full).await {
            Ok(e)  => e,
            Err(_) => return (0, 0),
        };
        let mut files = 0usize;
        let mut bytes = 0u64;
        for (name, is_dir, size, when) in entries {
            // `full` is the walk's own spelling of where it is, which is workspace-relative from
            // either start -- the root (empty) or a mark -- and so is what a notice would name.
            if !budget.spend(&full) {
                break;
            }
            let child_rel = if rel.is_empty() { name.clone() } else { fmt!("{}/{}", rel, name) };
            if is_dir {
                if orientation_skips(&child_rel) {
                    continue;
                }
                // Claimed BEFORE the recursion, not after: a directory's totals are only known
                // once its children are counted, but the LINE must print above them or the tree
                // reads bottom-up -- pushing here only once the count was in hand put every
                // directory's line under its own children.  The slot holds the line's position;
                // the totals are patched in once the recursion below has them.
                let slot = out.len();
                out.push(TreeNode {
                    path: child_rel.clone(), is_dir: true, files: 0, bytes: 0, depth,
                });
                let (sub_files, sub_bytes) = if depth < max_depth {
                    walk_orientation(ctx, start, &child_rel, depth + 1, max_depth, budget, out,
                        recent).await
                } else {
                    (0, 0)
                };
                files += sub_files;
                bytes += sub_bytes;
                out[slot].files = sub_files;
                out[slot].bytes = sub_bytes;
            } else {
                files += 1;
                bytes += size;
                if depth <= max_depth {
                    out.push(TreeNode {
                        path: child_rel.clone(), is_dir: false, files: 0, bytes: size, depth,
                    });
                }
                if let Some(ms) = when {
                    recent.push((child_rel, ms));
                }
            }
        }
        (files, bytes)
    })
}

/// Removes a later entry whose full path repeats one already recorded, keeping the first.
///
/// The root walk and each mark's own walk are separate calls that can name the same file twice:
/// a mark shallow enough to sit inside the root's own depth-2 cap is walked again from its own
/// start, and without this the tree printed `docs/` from the root walk and then `plan.md` again
/// from the mark's, the prefix stripped because the mark's own walk numbers paths from itself.
/// Keyed on the full path alone, so it makes no difference which walk found the duplicate first
/// structurally, only which the caller pushed first into `nodes` -- the root's copy, pushed
/// first below, is what survives.
///
/// # Arguments
/// * `nodes` - Every candidate the root walk and each mark's own walk found, in push order.
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub(crate) fn dedupe_orientation_nodes(nodes: Vec<TreeNode>) -> Vec<TreeNode> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut out = Vec::with_capacity(nodes.len());
    for node in nodes {
        if seen.insert(node.path.clone()) {
            out.push(node);
        }
    }
    out
}

/// Removes a later path that repeats one already listed, keeping the first -- the newest, since
/// the caller sorts before calling this.  The same spelling collision that duplicated the tree
/// (see [`dedupe_orientation_nodes`]) duplicated `Recently changed` too, because both are fed by
/// the same two walks over the same paths.
///
/// # Arguments
/// * `paths` - Full workspace-relative paths, newest first.
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub(crate) fn dedupe_recent_paths(paths: Vec<String>) -> Vec<String> {
    let mut seen: HashSet<String> = HashSet::new();
    paths.into_iter().filter(|p| seen.insert(p.clone())).collect()
}

/// The Claude-Code-grade orientation note for one turn: [`orientation_tree_note`] fed from a real
/// walk of the workspace root (depth 2) and every attached mark (depth 3).
///
/// # Arguments
/// * `ctx` - This turn's tool context, which decides which filesystem root is walked.
/// * `cwd` - The turn's own working folder, as shown in the cwd line.
/// * `bounds` - The turn's [`Bound`] rules; see [`orientation_marks`].
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub(crate) async fn orientation_tree<H: Host>(ctx: &ToolContext<H>, cwd: &str, bounds: &[Bound]) -> String {
    let mut nodes: Vec<TreeNode> = Vec::new();
    let mut recent: Vec<(String, f64)> = Vec::new();
    let mut budget = WalkBudget::new();
    let _ = walk_orientation(ctx, "", "", 0, 2, &mut budget, &mut nodes, &mut recent).await;
    for mark in orientation_marks(bounds) {
        // Named as a bare heading, ahead of what is under it -- unlike a nested directory found
        // BY the walk, a mark is a second walk's own starting point, so there is no enclosing
        // recursion to fold its totals into.
        nodes.push(TreeNode { path: mark.clone(), is_dir: true, files: 0, bytes: 0, depth: 0 });
        // The mark's own walk numbers every path from ITS start, so a bare `walk_orientation`
        // call here would hand back `plan.md` for a file the root already knows as `docs/plan.md`
        // -- two spellings of the same entry.  Walked into scratch vectors and re-prefixed with
        // the mark before joining `nodes`/`recent`, so every path leaving this function is whole
        // and workspace-relative, and the de-dupe below can compare them as the same entry.
        let mut mark_nodes:  Vec<TreeNode>       = Vec::new();
        let mut mark_recent: Vec<(String, f64)>  = Vec::new();
        let _ = walk_orientation(ctx, &mark, "", 0, 3, &mut budget, &mut mark_nodes,
            &mut mark_recent).await;
        for node in mark_nodes {
            nodes.push(TreeNode { path: fmt!("{}/{}", mark, node.path), ..node });
        }
        for (path, when) in mark_recent {
            recent.push((fmt!("{}/{}", mark, path), when));
        }
    }
    let nodes = dedupe_orientation_nodes(nodes);
    recent.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    // Passed whole, not pre-truncated: `format_orientation_tree` ranks every root's staleness
    // against the full list, and `orientation_tree_note` is what caps the printed line to 8.
    let recent_paths = dedupe_recent_paths(recent.into_iter().map(|(p, _)| p).collect());
    orientation_tree_note(cwd, &nodes, 3, &recent_paths)
}

/// A hand's listing, re-printed with the host inside each entry's parentheses.
///
/// The hand answers with bare names and `name/` for a directory -- which is byte for byte what
/// browser storage answers with, so nothing in the text said which filesystem the model was
/// looking at.  Sizes are not added: the hand does not send them and inventing one would be worse
/// than the silence.
///
/// A line that already carries parentheses is left exactly as it is, so a future hand that starts
/// sending sizes is not mangled by this.
///
/// # Arguments
/// * `text` - The hand's own listing.
/// * `host` - This computer's name, or empty where the hand did not say it.
pub(crate) fn machine_listed(text: &str, host: &str) -> String {
    let mut out = String::with_capacity(text.len() + 32);
    for line in text.split('\n') {
        if line.trim().is_empty() {
            continue;
        }
        if line.ends_with(')') {
            out.push_str(line);
            out.push('\n');
            continue;
        }
        let is_dir = line.ends_with('/');
        let name = line.trim_end_matches('/');
        let note = if host.is_empty() { fmt!("on the machine") } else { fmt!("on {}", host) };
        if is_dir {
            out.push_str(&fmt!("{}/  ({})\n", name, note));
        } else {
            out.push_str(&fmt!("{}  ({})\n", name, note));
        }
    }
    out
}

/// This computer's name, as the hand says it, or empty.
pub(super) async fn host_name<H: Host>(host: &H) -> String {
    match host.exec().status().await {
        Ok(st) => Machine::from_status(&st).host.unwrap_or_default(),
        Err(_) => String::new(),
    }
}

/// The workspace root's top-level entries, as `(name, is_dir)`.
///
/// Cloud-only entries are in it, because the question this answers -- what is at the root -- is
/// about the workspace and not about this device.
pub(crate) async fn root_entries<H: Host>(ctx: &ToolContext<H>) -> Vec<(String, bool)> {
    let mut out: Vec<(String, bool)> = match ctx.host().fs().list_dir(ctx.root, "").await {
        Ok(e)  => e.into_iter().map(|(n, d, _)| (n, d)).collect(),
        Err(_) => Vec::new(),
    };
    for (name, is_dir, _) in ctx.host().fs().children_of("") {
        if !out.iter().any(|(n, _)| *n == name) {
            out.push((name, is_dir));
        }
    }
    out.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    out
}

/// [`not_in_workspace_said`] for a path browser storage does not hold, or `None` where it does.
///
/// `None` is the guard that keeps this honest: a call that failed with the entry PRESENT failed
/// for some other reason -- it is a directory, it is being written -- and answering THAT with a
/// sentence about the root would send the model to correct a path that was already right.
///
/// # Arguments
/// * `raw` - The path as the model wrote it, which is the one the sentence names.
/// * `path` - The same path, scoped, which is the one browser storage is asked about.
pub(super) async fn wrong_root_note<H: Host>(ctx: &ToolContext<H>, raw: &str, path: &str) -> Option<String> {
    // A grant the browser has just withdrawn is not a path spelled against the wrong root. The
    // sentence below would send the model to correct a path that was right, and the probes it
    // makes to compose it would fail for the same reason the call did.
    if is_withdrawn_grant(&ctx.host().fs().thrown()) {
        return None;
    }
    if matches!(ctx.host().fs().exists(ctx.root, path).await, Ok(true)) {
        return None;
    }
    // The deepest ancestor that does exist, walked outermost first so the last one to answer is
    // the deepest.  `.` where none of them does, which is the root and always exists.
    let mut nearest = fmt!(".");
    for dir in dirs_needed(path) {
        match ctx.host().fs().exists(ctx.root, &dir).await {
            Ok(true) => nearest = dir,
            _        => break,
        }
    }
    // What the model may write in, for a scoped turn; what is at the root otherwise.  A scoped
    // turn's answer is the more useful of the two -- it names the folders the work is in.
    let roots = {
        let scoped = ctx.allowed_places();
        if ctx.is_scoped() && scoped != "nothing at all" {
            scoped
        } else {
            root_entries_said(&root_entries(ctx).await)
        }
    };
    Some(not_in_workspace_said(raw, &nearest, &roots))
}

/// What a file tool call is about to do where it lands, which [`reach_of`] is told so that a
/// change is refused where the hand may not make one.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum Door {
    Look,	// read, list, search: nothing there changes
    Change,	// write, edit, move, make a folder, a fetch's `to`, a revert
}

/// A fence, and the link to the hand whose hello it was built from ([`bound_to_link`]).
pub(super) struct LinkedFence {
    pub(super) fence:    FenceSpec,
    pub(super) link:     Option<u64>,	// the relay's link the status was read on; `None` where it named none
}

/// `req`, a request for the hand, bound to the link whose hello it was built from (re-check of
/// 2026-09-23, H3).
///
/// Every fence is built from what one hand said in its hello, and a turn reads that, may wait on a
/// question -- the network, the command itself -- and only then sends.  A hand that went away in
/// the wait and came back as another, one older than the deletion meter say, was sent the fence
/// built for the one before it: a writable root, to a hand that meters nothing.  The relay
/// (`boundElsewhere` in `www/js/hand.js`) posts a bound request on the link it names or on none,
/// and says so.  A status that named no link binds nothing: that is a harness standing in for the
/// relay, which names one whenever a hand has said hello.
///
/// # Arguments
/// * `req` - The request as the wire's JSON object.
/// * `link` - The `link` the relay's status named.
pub(super) fn bound_to_link(req: String, link: Option<u64>) -> String {
    match (link, req.strip_suffix('}')) {
        (Some(n), Some(open)) => fmt!(r#"{},"link":{}}}"#, open, n),
        _                     => req,
    }
}

/// Where one file tool call is about to land.
pub(super) enum Reach {
    /// Browser storage, which is what every file tool did before this.
    Storage,
    /// The machine, through the hand, behind the fence `spec` describes.
    Machine {
        abs:  String,	// the file, as an absolute path on the machine
        cwd:  String,	// the mark it is under, absolute; the op runs there
        root: String,	// the folder the hand was granted, which every path here is under
        spec: LinkedFence,
    },
    /// It IS a machine path and the hand cannot serve it, and the model must be told which.
    Refuse(String),
}

/// The storage `path` resolves in for this context now ([`storage_for`]), for what this agent saw
/// of it.  A door takes it once, before its I/O, so its guard and the record it leaves both name
/// the storage it used.
pub(super) fn stored_in<H: Host>(ctx: &ToolContext<H>, path: &str) -> Storage {
    ctx.host().fs().storage_of(ctx.root, path)
}

/// Whether this turn runs on the runner, which keeps a file a change replaces before it goes, so
/// "Undo this turn" puts it back (QA R2 F1, M1): a native hosted engine, a folder on this computer
/// open, and a keeper for the turn.  The browser and Daimond's own storage answer `false`.
pub(super) fn runner_keeps<H: Host>(ctx: &ToolContext<H>) -> bool {
    !cfg!(target_arch = "wasm32") && H::HOSTED && ctx.host().fs().folder_open()
        && ctx.keeper().is_some()
}

/// `file_move`'s description where the runner keeps files ([`runner_keeps`]).
pub(super) const FILE_MOVE_KEPT_DESC: &str = "Move or rename a file or directory within the workspace. A file \
    already at 'to' is REPLACED: it is kept first, so \"Undo this turn\" restores it, and the reply \
    says it was replaced. Daimond's own storage (diamonds/...) still refuses a destination that is \
    already there.";

/// `file_move`'s schema where the runner keeps files ([`runner_keeps`]).
pub(super) const FILE_MOVE_KEPT_PARAMS: &str = r#"{"type":"object","properties":{"path":{"type":"string","description":"Existing workspace-relative path"},"to":{"type":"string","description":"New workspace-relative path. A file already there is replaced -- kept first, so \"Undo this turn\" restores it"}},"required":["path","to"]}"#;

/// The reply to a move that landed, which says when it replaced a file standing at `to`
/// (QA R2 M1), and that the file was kept first and "Undo this turn" restores it when it was.
pub(super) fn moved_line(from: &str, to: &str, replaced: bool, kept: bool) -> String {
    match (replaced, kept) {
        (false, _)    => fmt!("Moved {} to {}.", from, to),
        (true, false) => fmt!("Moved {} to {}, replacing the {} that was there.", from, to, to),
        (true, true)  => fmt!("Moved {} to {}, replacing the {} that was there. It was kept \
            first, so \"Undo this turn\" puts both back.", from, to, to),
    }
}

/// Which filesystem a file tool call is about, decided once and before it acts.
///
/// The cheap facts settle it first and none of them costs a round trip: a real folder open
/// means one filesystem, no hand means one filesystem, and a path under no mark is browser
/// storage whatever else is true. Only past those is the hand asked anything.
///
/// **Its fence is [`command_fence`], the one every door to the machine is sent** (re-check of
/// 2026-09-23, H1).  It was [`fence_spec`] until then, so a hand older than the deletion meter,
/// whose commands had nothing writable, still took a file tool's writes: the one door the gate
/// promised was closed was open for one named file at a time.  A [`Door::Change`] through such a
/// hand is refused here, before anything is read or held, in words that say why; the fence the
/// hand is sent for a look is read-only there, so the hand's own kernel fence is the second wall.
///
/// # Arguments
/// * `raw` - The path as the model wrote it, which a refusal must name.
/// * `path` - The same path, scoped, which is the one the marks are tested against.
/// * `door` - Whether the call looks or changes.
pub(super) async fn reach_of<H: Host>(ctx: &ToolContext<H>, raw: &str, path: &str, door: Door) -> Reach {
    if ctx.host().fs().folder_open() || !ctx.host().exec().present() {
        return Reach::Storage;
    }
    let rel = normalise(path);
    let mark = match mark_over(&ctx.no_write, &rel) {
        Some(m) => m,
        None    => return Reach::Storage,
    };
    let st = match ctx.host().exec().status().await {
        Ok(s)  => s,
        Err(e) => return Reach::Refuse(fmt!(
            "'{}' is in a folder on this computer and the machine hand could not be asked \
            about it ({}). Nothing was read or changed.", raw, e.msgs().join(" "))),
    };
    if extract_json_bool(&st, "paired") != Some(true) {
        return Reach::Refuse(fmt!("Refused: {}", extract_json_string(&st, "reason")
            .unwrap_or_else(|| fmt!(
                "There is no machine hand paired with this browser, so the folder '{}' is in \
                cannot be reached at all.", mark))));
    }
    let machine = Machine::from_status(&st);
    let link = extract_json_number(&st, "link");
    if !machine.rooted() {
        return Reach::Refuse(fmt!(
            "The machine hand did not say which folder it was granted, so there is no way to \
            say what a file tool may touch. It is not safe to guess, so nothing was done."));
    }
    // Release gate 1, for this door as for the other: a write that cannot be contained is
    // refused, never done and mentioned afterwards.
    if !fence_enforced(&machine.caps) {
        return Reach::Refuse(fmt!(
            "Refused: the machine hand on this computer cannot fence what it runs, so nothing \
            would stop a file tool reaching the rest of the machine. Daimond will not change \
            files it cannot contain. Tell the user."));
    }
    // NOTHING IS CHANGED THROUGH A HAND THAT DOES NOT METER, by any door (H1). `command_fence`
    // gives such a hand no writable root; this says so before a byte is read or a copy held.
    if door == Door::Change {
        if let Some(why) = change_refusal(&machine.caps, raw, machine.host.as_deref()) {
            return Reach::Refuse(why);
        }
    }
    // TAINTED, always. The `net` flag is the only thing that argument moves, a file
    // operation has no network to reach, and the tightest fence is therefore the honest one.
    let spec = command_fence(&ctx.no_write, &machine, true);
    if spec.rw.is_empty() && spec.ro.is_empty() {
        return Reach::Refuse(fmt!(
            "Refused: this turn's bounds do not describe any folder on this computer, so there \
            is no fence to change a file inside. Nothing was done."));
    }
    let root = machine.root.trim_end_matches('/').to_string();
    Reach::Machine {
        abs:  fmt!("{}/{}", root, rel),
        cwd:  fmt!("{}/{}", root, mark),
        root,
        spec: LinkedFence { fence: spec, link },
    }
}

/// The folder the machine hand was granted, where a path under a mark spelled relative to it
/// reaches the machine through [`reach_of`]: a hand present, paired and rooted, and no folder open
/// in the browser, which would take the same path instead.  `None` otherwise.
///
/// What a restore strips from a machine file's recorded absolute path to hand it to the fenced
/// door, which takes a workspace-relative path and routes it to the hand (R6 of the release 5.1
/// fix's QA).
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub(crate) async fn machine_door_root<H: Host>(host: &H) -> Option<String> {
    if host.fs().folder_open() || !host.exec().present() {
        return None;
    }
    match host.exec().status().await {
        Ok(st) => Machine::paired(&st).map(|m| m.root.trim_end_matches('/').to_string()),
        Err(_) => None,
    }
}

/// What stands at `path` now, as a turn's capture names it -- normalised, or absolute on this
/// computer -- for the turn end's question whether the turn's bytes are still there
/// ([`crate::wasm::diamond::drain_turn`]).  `None` where it cannot be told: a file that is there
/// and would not read, or a machine file with no hand that reaches it.
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub(crate) async fn standing_now<H: Host>(ctx: &ToolContext<H>, path: &str)
    -> Option<crate::diamond_versions::Body>
{
    use crate::diamond_versions::Body;
    if !path.starts_with('/') {
        let ceiling = crate::diamond_versions::VERSION_FILE_MAX as u32;
        return match ctx.host().fs().read_file_capped(FileRoot::Workspace, path, ceiling).await {
            Ok((b, total)) if total as usize <= crate::diamond_versions::VERSION_FILE_MAX =>
                Some(Body::Held(b)),
            Ok((_, total)) => Some(Body::TooLarge(total as u64)),
            Err(_)         => match ctx.host().fs().exists(FileRoot::Workspace, path).await {
                Ok(false) => Some(Body::Gone),
                _         => None,
            },
        };
    }
    // A machine file, read through the hand as the turn's own acts read it: by its spelling under
    // the granted folder, behind the turn's fence.
    let root = match machine_door_root(ctx.host()).await {
        Some(r) => r,
        None    => return None,
    };
    let rel = match path.strip_prefix(&fmt!("{}/", root)) {
        Some(r) => r.to_string(),
        None    => return None,
    };
    match reach_of(ctx, &rel, &rel, Door::Look).await {
        Reach::Machine { abs, cwd, spec, .. } =>
            match machine_before(&abs, &cwd, &spec, &ctx.no_write, ctx.host()).await {
                (Some(b), _)    => Some(Body::Held(b)),
                (None, None)    => Some(Body::Gone),
                (None, Some(_)) => None,
            },
        _ => None,
    }
}

/// Where a WALK is about to happen, for a call that names several starting points.
///
/// [`reach_of`] answers about one path and a walk has a list, and the two must not be allowed to
/// disagree: a search that walked one mark on the machine and another in browser storage would
/// merge two filesystems into one result and number the lines of both. So it is all or nothing --
/// every start on the machine, or the walk stays where it was.
pub(super) enum WalkReach {
    /// Browser storage, which is what both walks did before this.
    Storage,
    /// The machine, through the hand, behind the fence `spec` describes.
    Machine {
        abs:  Vec<String>,	// the starts on the machine, as absolute paths
        rest: Vec<String>,	// the starts that are not, walked in browser storage as before
        cwd:  String,		// the first mark, absolute; the op runs there
        root: String,		// the folder the hand was granted
        spec: LinkedFence,
    },
    /// They ARE machine paths and the hand cannot serve them.
    Refuse(String),
}

/// Which filesystem each of a walk's starting points is on.
///
/// **Both, routinely, and that is not a defect of the rule.** A Diamond's marks always include
/// its OWN directory, which is browser storage by design and by construction, so a turn that
/// searched only where every start agreed would search browser storage every time and the door
/// would never open. Measured on `dev/verify_scope.mjs`, 2026-08-25: the all-or-nothing version
/// of this function answered `Storage` for every default search a scoped Diamond makes.
///
/// So the list is SPLIT, and the two halves are walked by their own machinery and reported
/// through one. What made the mixed answer look dangerous -- that a reader could not tell which
/// filesystem a line came from -- is not true of the answer: every path in it is workspace
/// relative in the model's own spelling, `diamonds/<id>/notes.md` beside `work-a/src/lib.rs`,
/// and both hand straight back to `file_read`.
///
/// # Arguments
/// * `starts` - The walk's starting points, as the model wrote them.
pub(super) async fn walk_reach<H: Host>(ctx: &ToolContext<H>, starts: &[String]) -> WalkReach {
    let mut abs:  Vec<String> = Vec::new();
    let mut rest: Vec<String> = Vec::new();
    let mut cwd = String::new();
    let mut root = String::new();
    let mut spec: Option<LinkedFence> = None;
    for st in starts {
        let scoped = match Tool::scoped(ctx, st) {
            Ok(p)  => p,
            // A start this turn cannot even scope is left to the walk that already has a
            // sentence for it, rather than being turned into a machine path here.
            Err(_) => { rest.push(st.clone()); continue; },
        };
        match reach_of(ctx, st, &scoped, Door::Look).await {
            Reach::Refuse(why) => return WalkReach::Refuse(why),
            Reach::Machine { abs: a, cwd: c, root: r, spec: f } => {
                if cwd.is_empty() {
                    cwd = c;
                    root = r;
                }
                spec = Some(f);
                abs.push(a);
            },
            Reach::Storage => rest.push(st.clone()),
        }
    }
    match spec {
        Some(f) if !abs.is_empty() => WalkReach::Machine { abs, rest, cwd, root, spec: f },
        _                          => WalkReach::Storage,
    }
}

/// One file's matching lines as the hand wrote them: a number, a tab, and the line.
///
/// The parse is TOTAL, for the reason `walk_head`'s is: a block this build cannot read is a
/// file whose matches are unknown, and reporting the lines it could read as though they were
/// the file's answer is the shape of every blocker in `dev/BLOCKERS.md` that cost a turn.
///
/// # Arguments
/// * `block` - The bytes the record's length prefix counted.
pub(super) fn machine_lines(block: &str) -> Outcome<Vec<Numbered<'_>>> {
    let mut out: Vec<Numbered<'_>> = Vec::new();
    for piece in block.split_inclusive('\n') {
        let line = piece.strip_suffix('\n').unwrap_or(piece);
        let (num, text) = match line.split_once('\t') {
            Some(p) => p,
            None    => return Err(err!(
                "The machine hand sent a search result line with no line number on it, so \
                there is no saying which line of which file matched."; Invalid, Data)),
        };
        let n = match num.parse::<usize>() {
            Ok(n)  => n,
            Err(_) => return Err(err!(
                "The machine hand numbered a search result line '{}', which is not a line \
                number.", num; Invalid, Data)),
        };
        out.push((n, text));
    }
    Ok(out)
}

/// What the hand answered a read with: the file's own numbers, and the lines this answer holds.
pub(super) struct MachineRead<'a> {
    pub(super) lines: usize,	// lines the WHOLE file holds
    pub(super) bytes: usize,	// the whole file's length
    pub(super) body:  &'a str,	// the lines that came back, from the offset that was asked for
    pub(super) held:  usize,	// how many lines that is, as the hand counted them
}

/// Read the three numbers a machine read opens with, and the lines after them.
///
/// The parse is TOTAL and the two counts are checked against each other, because the failure
/// this closes is not a crash: a read whose extent is unknown, rendered as a whole file, is a
/// daimon told it has seen all of something it has seen 44% of (`dev/BLOCKERS.md` B18). A
/// header this build cannot read is refused rather than guessed at.
///
/// # Arguments
/// * `answer` - The whole `Filed` text as the hand sent it.
pub(super) fn machine_read(answer: &str) -> Outcome<MachineRead<'_>> {
    let (head, body) = match answer.split_once('\n') {
        Some(p) => p,
        None    => (answer, ""),
    };
    let c: Vec<&str> = head.split('\t').collect();
    let n = |i: usize| -> Option<usize> { c.get(i).and_then(|f| f.parse::<usize>().ok()) };
    let (lines, bytes, held) = match (n(0), n(1), n(2)) {
        (Some(l), Some(b), Some(h)) => (l, b, h),
        _ => return Err(err!(
            "The machine hand answered a read with a header this build cannot read, so there \
            is no way to say how much of the file arrived. Part of a file rendered as the whole \
            of one is worse than no answer at all -- update the hand, or the page, so the two \
            speak the same protocol."; Invalid, Data)),
    };
    let came = split_lines(body).len();
    if came != held {
        return Err(err!(
            "The machine hand said it was sending {} line(s) and {} arrived, so this answer is \
            not the window it claims to be and nothing can be said about where in the file it \
            sits.", held, came; Invalid, Data));
    }
    Ok(MachineRead { lines, bytes, body, held })
}

/// The bytes a file on this computer holds RIGHT NOW, read through the hand inside the fence that
/// is about to change it.
///
/// **There is no second chance at this.** The hand keeps no journal and its write and edit ops
/// return no prior content, so the only moment a machine file's old bytes exist anywhere the app
/// can reach is between this read and the write after it -- which is why the read is here, in the
/// same fenced sequence, rather than anywhere tidier.
///
/// **It can refuse nothing.** A snapshot that could stop a write the fence allowed would be a new
/// way for the app to fail at the one thing it is for, so every failure comes back as a reason to
/// record beside the row and the caller writes anyway.
///
/// The answer is `(the bytes, why there are none)`. Both `None` means a file that was not there
/// -- a new file has no prior bytes by definition, and that is not a fault to report.
///
/// # Returns
/// The reason is one word the History renders: `size` where the answer was cut by the hand's
/// frame, `binary` where the file is not text and so did not survive the wire, `unreadable`
/// otherwise.
pub(super) async fn machine_before<H: Host>(abs: &str, cwd: &str, spec: &LinkedFence, kits: &[Bound], host: &H)
    -> (Option<Vec<u8>>, Option<String>)
{
    // The whole file: offset 1, no limit. `read_op` adds no line numbers -- those are this
    // module's -- so what comes back after the header is the file's own characters.
    let got = match machine_op("file_read", "read", abs, cwd, spec, kits,
        r#","offset":1,"limit":0"#, host).await
    {
        Ok(g)  => g,
        Err(e) => return (None, Some(fmt!("unreadable: {}", e.plain()))),
    };
    let text = match got {
        Ok(t)  => t,
        // NOT THERE YET, which is a new file -- and only that.  Every other refusal (the fence,
        // a permission, a file mid-write, an answer this build cannot read) was read as a new
        // file until 2026-09-23, so its overwrite was neither kept nor counted.
        Err(why) if hand_said_absent(&why) => return (None, None),
        Err(why) => return (None, Some(fmt!("unreadable: {}", why))),
    };
    match machine_read(&text) {
        Ok(r)  => machine_body(&r),
        Err(_) => (None, Some("unreadable".to_string())),
    }
}

/// Did the hand answer a read with "there is no such file", and nothing else?
///
/// The hand's own sentence for `NotFound` (`fs_said` in `hand/src/exec.rs`), after the tool name
/// `machine_op` puts in front of it.  Matched whole rather than by a word in it, because every
/// other answer -- a refusal, a permission, an error this build has not seen -- must read as a
/// file that is there and could not be kept, never as a new one.
pub(super) fn hand_said_absent(said: &str) -> bool {
    let rest = match said.split_once(": ") {
        Some((_, r)) => r.trim(),
        None         => said.trim(),
    };
    rest.starts_with("There is no '") && rest.ends_with("' on this machine.")
}

/// Did the hand answer a read with "that is a folder"?  The sentence is the hand's own for
/// `IsADirectory` (`fs_said` in `hand/src/exec.rs`), as [`machine_before`] passes it on.
pub(super) fn hand_said_directory(said: &str) -> bool {
    said.contains("' is a directory, not a file.")
}

/// What a machine arm's read before its act found there, for the capture's merge
/// ([`crate::diamond_versions::capture_into`]): the bytes, nothing, or a file it could not read.
pub(super) fn machine_found(before: &Option<Vec<u8>>, refused: &Option<String>) -> Found {
    match (before, refused) {
        (Some(b), _)    => Found::of(Some(b)),
        (None, None)    => Found::Nothing,
        (None, Some(_)) => Found::Unread,
    }
}

/// The refusal a model's overwrite meets where what the file holds now could not be kept, so
/// the overwrite could not be undone: the delete's rule, at every write door.
///
/// # Arguments
/// * `raw` - The path as the model wrote it.
/// * `why` - Why no copy could be taken: the hand's word (`binary`, `size`) or the read's error.
pub(super) fn overwrite_unkept_refusal(raw: &str, why: &str) -> String {
    let said = match why {
        "binary" => "it is not text, and the machine hand carries text only".to_string(),
        "size"   => "it is larger than the machine hand returns whole".to_string(),
        other if other.starts_with("it is ") => other.to_string(),
        other    => fmt!("it is there but could not be read: {}",
            other.strip_prefix("unreadable: ").unwrap_or(other)),
    };
    fmt!("Refused: no copy of what '{}' holds now could be kept ({}), so overwriting it could \
        not be undone, and it was left as it is. Do not look for another way to change it. If it \
        should change, tell the user which file and why, and let them do it.", raw, said)
}

/// A change to a file of the user's that the person already declined this turn, or one inside or
/// around it (UNBLOCK-26 U3): refused without asking again.
pub(super) fn change_declined_refusal(raw: &str) -> String {
    refusal_line(&fmt!("The user already chose not to have '{}' changed in this turn. Nothing \
        was changed. Do not ask again or make this change another way; finish the rest and say in \
        your answer what you would have changed.", raw))
}

/// The user's file changed while they were asked about changing it: the change they agreed to was
/// to the file as it was shown, so it is not written over what stands there now.
pub(super) fn changed_while_asked_refusal(raw: &str) -> String {
    refusal_line(&fmt!("'{}' changed while the user was being asked, so nothing was written: they \
        agreed to the change against the file as it was then. Read it again, and if the change is \
        still wanted, make it against the file as it is now.", raw))
}

/// A change to a file of the user's that cannot be shown to them, so cannot be asked about.
pub(super) fn change_unshown_refusal(raw: &str) -> String {
    refusal_line(&fmt!("'{}' is the user's file and this change to it cannot be shown to them (it \
        is not text), so it was not made. Nothing was changed. Tell the user what you would \
        change and let them do it.", raw))
}

/// The file's own bytes out of a whole-file read, or the reason they are not recoverable.
///
/// Its own function so a native test can reach it: the caller is compiled for the browser alone,
/// and the arithmetic below is where a restore either writes the file back exactly or does not.
///
/// EVERY line the hand sends ends with a newline, the last one included, so a file that does not
/// end with one comes back a byte longer than it is.  The header says how long it really is,
/// which is what makes that recoverable rather than guessed at -- and it is what catches the two
/// answers that are not the file: one cut by the hand's frame, which is shorter, and one whose
/// bytes are not text, which came back with replacement characters in them and is longer.
pub(super) fn machine_body(read: &MachineRead<'_>) -> (Option<Vec<u8>>, Option<String>) {
    if read.held < read.lines {
        return (None, Some("size".to_string()));
    }
    let mut body = read.body.as_bytes().to_vec();
    if body.len() == read.bytes + 1 && body.last() == Some(&b'\n') {
        body.pop();
    }
    if body.len() < read.bytes {
        return (None, Some("size".to_string()));
    }
    if body.len() != read.bytes {
        // Writing THAT back would be corruption wearing the name of a restore.
        return (None, Some("binary".to_string()));
    }
    (Some(body), None)
}

/// Does a restore of `path` have to go back through the fence rather than straight to disk?
///
/// True for everything outside the keeper's home (see [`keeper_home`]), and it is a question
/// about the ROOT and not about the machine: [`FileRoot::Workspace`] sends any path that is not
/// store state to the real folder the user has open, so a path outside `diamonds/<id>/` or
/// `chats/<id>/` is one the turn reached only because the user marked it in.  Recording it as a
/// mark is what sends the restore down the fenced `file_write` under the current marks -- so a
/// mark since withdrawn is refused in the fence's own words instead of being written into a
/// folder the turn no longer reaches.
///
/// # Arguments
/// * `dia` - The keeper whose store records the change.
/// * `path` - The SCOPED path, as the write door resolved it.
pub(crate) fn stored_is_mark(dia: &str, path: &str) -> bool {
    crate::diamond_versions::is_users_path(&keeper_home(dia), path)
}

/// Does writing `after` over `before` at `path` leave less than half of what was there
/// ([`crate::diamond_versions::wipes`])?
///
/// **A document is compared by the text a person reads in it, never by its archive.**  A `.docx`
/// changed in one word is a new zip whose bytes share nothing with the old, and read as bytes an
/// ordinary `doc_edit` would count as wiping the document.  Every other file is compared as it
/// stands.
///
/// # Arguments
/// * `path` - The path written, whose name says whether it is a document.
/// * `before` - What stood there.
/// * `after` - What the write leaves there.
pub(crate) fn wiped(path: &str, before: &[u8], after: &[u8]) -> bool {
    let view = |b: &[u8]| -> Vec<u8> {
        match office_view(path, b) {
            Some(Ok((text, _))) => text.into_bytes(),
            _                   => b.to_vec(),
        }
    };
    crate::diamond_versions::wipes(&view(before), &view(after))
}

/// Note what a restore left at `path`, and keep what this agent last read of it.
///
/// **The daimon reads a restored file again before it writes it** (RD of the release 5.1 fix's
/// third QA, 2026-09-25).  A Restore changes a file from outside the turn.  It forgot the path
/// here until then, so the guard in `Tool::FileWrite` had nothing to compare, and the daimon's
/// next write -- made from what it read before the Restore -- silently put its own text back over
/// what the person restored.  The anchor now stays, so that write is refused.  This note is what
/// lets the refusal say the person restored the file: the path was forgotten in the first place
/// because the refusal blamed "another agent", naming one that does not exist.
///
/// Filed under one spelling ([`Seen`]), because the model names a file as it likes
/// (`./notes/a.md`) and a restore names it as the store does; and under `at`, the storage the
/// restore wrote in, as what the agent saw is.
pub fn note_restored(cache: &ReadCache, at: &Storage, path: &str, bytes: &[u8]) {
    lock_cache(cache).seen.left.insert(seen_key(at, path), Some(content_hash(bytes)));
}

/// Note that a restore deleted `path` in `at`, so the refusal of the daimon's next write to it
/// names the restore (RD2 of the release 5.1 fix's third QA, 2026-09-25).
pub fn note_restored_gone(cache: &ReadCache, at: &Storage, path: &str) {
    lock_cache(cache).seen.left.insert(seen_key(at, path), None);
}

/// Does `path` in `at` hold exactly what a restore left there, `now` being its bytes, or `None`
/// where nothing is there?
pub fn holds_restored(cache: &ReadCache, at: &Storage, path: &str, now: Option<&[u8]>) -> bool {
    lock_cache(cache).seen.left.get(&seen_key(at, path)) == Some(&now.map(content_hash))
}

/// Carry what a restore's door noted it left into `into`, the cache whose reads the write guard
/// answers to.  The door keeps a cache of its own (U2), so a note taken at its act, which is the
/// only moment a machine file's restored bytes are in hand, would otherwise go with it.
pub fn carry_restored(from: &ReadCache, into: &ReadCache) {
    let noted: Vec<((Storage, String), Option<u64>)> = lock_cache(from).seen.left.iter()
        .map(|(k, h)| (k.clone(), *h)).collect();
    let mut c = lock_cache(into);
    for (k, h) in noted {
        c.seen.left.insert(k, h);
    }
}

/// The stale-read guard of a whole-file write: the refusal where this agent last read `path` as
/// something other than `now`, what the file holds at the write.
///
/// **One sentence for every door** (fix/r51e, 2026-09-25).  Only browser storage asked this until
/// then.  A write through the machine hand went ahead over whatever the file held, so a daimon
/// that read a file the person then edited in their own editor wrote its old read back over their
/// edit; the turn kept their bytes, but nothing told the daimon it had missed them.
///
/// **A file deleted since the read has changed too** (RD2 of the same QA).  Only a file that read
/// was compared, so a file the person deleted -- through a Restore, or by any other hand -- was
/// made again from the daimon's old read, and their delete was undone.  It is refused, and the
/// daimon's own read of the path, finding nothing, is what lets its next write land.
///
/// **Only a read of the same storage counts** (E2b, 2026-09-27): what this agent saw of `path` in
/// browser storage says nothing about the file at `path` in a folder, whether it is there or not,
/// so a write there is not refused over it.
///
/// # Arguments
/// * `at` - The storage the write lands in, taken before its I/O.
/// * `path` - The path as this agent's reads are filed, the scoped spelling.
/// * `also` - Another spelling a restore may have noted the file under: the absolute path, where
///   the file is on the machine.
/// * `now` - What the file holds at the write, or `None` where nothing is there.
pub fn stale_write(cache: &ReadCache, at: &Storage, path: &str, also: Option<&str>,
    now: Option<&[u8]>)
    -> Option<String>
{
    let prev = match lock_cache(cache).seen.get(at, path).copied() {
        Some(h) => h,
        None    => return None,
    };
    if now.map(content_hash) == Some(prev) {
        return None;
    }
    let restored = holds_restored(cache, at, path, now)
        || also.map_or(false, |a| holds_restored(cache, at, a, now));
    Some(match (now, restored) {
        (Some(_), true)  => fmt!("file_write: '{}' changed on disk since you read it -- the \
            person restored it from its History. Read it again and apply your change to what they \
            restored, so the restore is not undone.", path),
        (Some(_), false) => fmt!("file_write: '{}' changed on disk since you read it -- another \
            agent edited it. Re-read the file and reapply your change so theirs is not lost.", path),
        (None, true)     => fmt!("file_write: '{}' was deleted since you read it -- the person \
            restored an earlier version from its History, which did not have it. It was not \
            written back from your old read, so the restore is not undone. Read it again, and \
            write it only if it should exist after all.", path),
        (None, false)    => fmt!("file_write: '{}' was deleted since you read it -- the person or \
            another agent removed it. It was not written back from your old read, so their delete \
            is not undone. Read it again, and write it only if it should exist after all.", path),
    })
}

/// What an engine write that follows a read of the same file is bound to: that read's [`Seen`],
/// and whose read it was, which decides the sentence a mismatch is refused in.
///
/// **One rule for every read-then-write tool** (U3a RMW, 2026-10-17): `file_edit`, `doc_edit`
/// and `sheet_write` read the file, built new bytes from it and wrote plainly, and `file_write`
/// bound only what its stale-read guard read.  A save landing in between -- the person's Doc
/// editor, another tab, the folder merge -- was written over, and because the version capture
/// records the old read as "before", it was kept nowhere.  Every such write now carries the read
/// it follows, through [`guarded_store_write`] in storage and [`machine_write`] on the machine.
///
/// [`Seen`]: crate::diamond_versions::Seen
#[derive(Clone, Debug, PartialEq)]
pub enum WriteBound {
    /// The agent read the file: the stale-read guard's read, or the tool's own read it edits.
    Read(crate::diamond_versions::Seen),
    /// The agent never read it; the version capture read it the moment before (`keep`).
    Kept(crate::diamond_versions::Seen),
    /// The person was shown these bytes and applied the change to them (UNBLOCK-26 U3): the write
    /// lands over them alone, whatever the agent read ([`Tool::write_over`]).
    Shown(crate::diamond_versions::Seen),
}

impl WriteBound {
    /// The guard's read where the agent read the file, else the version capture's.
    pub fn of(read: Option<crate::diamond_versions::Seen>,
        kept: Option<crate::diamond_versions::Seen>) -> Option<Self>
    {
        read.map(Self::Read).or(kept.map(Self::Kept))
    }

    /// The bytes, or their absence, the write may land only over.
    pub fn seen(&self) -> &crate::diamond_versions::Seen {
        match self {
            Self::Read(s) | Self::Kept(s) | Self::Shown(s) => s,
        }
    }

    /// The refusal for a write that found `found` where it was bound to [`Self::seen`].
    pub fn refusal(&self, tool: &str, path: &str, found: &crate::diamond_versions::Seen) -> String {
        refusal_line(&self.refusal_said(tool, path, found))
    }

    // The sentence alone; refusal composes it as a refusal (TOOLROW-STATUS).
    fn refusal_said(&self, tool: &str, path: &str, found: &crate::diamond_versions::Seen) -> String {
        use crate::diamond_versions::Seen;
        match (self, found) {
            (Self::Shown(_), _)          => fmt!("{}: {}", tool, changed_while_asked_refusal(path)),
            (Self::Kept(_), _)           => fmt!("{}: '{}' changed just now; read it again before \
                writing.", tool, path),
            (Self::Read(_), Seen::Absent) => fmt!("{}: '{}' was deleted since you read it -- the \
                person or another agent removed it. It was not written back from your old read, so \
                their delete is not undone. Read it again, and write it only if it should exist \
                after all.", tool, path),
            (Self::Read(_), _)           => fmt!("{}: '{}' changed on disk since you read it -- it \
                was saved again while this write waited for it. Re-read the file and reapply your \
                change so that save is not lost.", tool, path),
        }
    }

    /// The refusal for a machine write the hand refused as changed since it was read: `None`
    /// where `said` is not that refusal ([`hand_found`]).
    pub fn hand_refusal(&self, tool: &str, path: &str, said: &str) -> Option<String> {
        self.hand_refusal_said(tool, path, said).map(|s| refusal_line(&s))
    }

    // The sentence alone; hand_refusal composes it as a refusal (TOOLROW-STATUS).
    fn hand_refusal_said(&self, tool: &str, path: &str, said: &str) -> Option<String> {
        hand_found(said).map(|found| self.refusal(tool, path, &found))
    }
}

/// A write into storage, bound to the read it follows (see [`WriteBound`]).
///
/// **A read before the write took the file's lock** (U3a SA3 and RMW, 2026-10-17): where the
/// write is bound, it is compared again under the lock and refused with what stands there
/// instead.  `None` is a write with no read to bind: a restore's own hold, or a turn that keeps
/// no version and never read the file.  [`landed_store_write`] with no landing.
pub async fn guarded_store_write<H: Host>(host: &H, root: FileRoot, lic: &Licence, tool: &str,
    path: &str, bytes: &[u8], bound: Option<&WriteBound>)
    -> Outcome<()>
{
    let got = res!(landed_store_write(host, root, lic, lic.path(), bytes, bound.map(WriteBound::seen),
        None).await);
    match (got, bound) {
        (Written::Landed { .. }, _)       => Ok(()),
        (Written::Refused(found), Some(b)) => Err(err!("{}", b.refusal(tool, path, &found);
            Invalid, Input, Mismatch)),
        (Written::Refused(found), None)    => Err(err!("{}",
            WriteBound::Kept(found.clone()).refusal(tool, path, &found); Invalid, Input, Mismatch)),
    }
}

/// What [`landed_store_write`] did.
#[derive(Clone, Debug, PartialEq)]
pub enum Written {
    /// The bytes landed.  `unrecorded` is empty, or the sentence saying the landing's DECISIONS
    /// note or touched rows could not be added after it, for the tool to append to its reply.
    Landed { unrecorded: String },
    /// The compare under the lock found these bytes instead: nothing written, nothing settled.
    Refused(crate::diamond_versions::Seen),
}

/// The accepted write of a landing (held-lock settle P3): under the file's lock, compared, its
/// archive appended, the file written; then its DECISIONS lines and touched rows.  `landed` of
/// `None`, or one that settles nothing, is exactly the bound write it replaces.
///
/// **The order is the one a crash cannot make false** (I-HL1): compare → ARCHIVE → write under
/// the lock, RECORD after it is given back.  A crash before the write leaves at worst a duplicate
/// archive entry, and one after it a missing note or row, never a false one.  A refused compare
/// settles nothing (I-HL2), so a retry appends no second entry.  The ARCHIVE step is the only
/// `write_licensed_then` pre step in the crate (I-HL3): it writes only `.daimond/` side files,
/// which wait for nothing, and never asks, holds a version or reaches the hand.
///
/// The write is bound to `expect` where given, else to the bytes the landing was worked out from
/// (`Landed::from`); where both are given and differ, it is refused before the lock.  A RECORD
/// that fails does not fail the write, which has landed: it comes back as `unrecorded`.
///
/// # Arguments
/// * `host` - Whose filesystem and store.
/// * `root` - Where the file is.
/// * `lic` - The licence to write it.
/// * `path` - The file, as the store names it, for the landing's checks and side files.
/// * `bytes` - What lands.
/// * `expect` - The bytes, or their absence, the write may land only over.
/// * `landed` - What `standing_retired` answered for the write, if anything.
pub async fn landed_store_write<H: Host>(host: &H, root: FileRoot, lic: &Licence, path: &str,
    bytes: &[u8], expect: Option<&crate::diamond_versions::Seen>, landed: Option<&Landed>)
    -> Outcome<Written>
{
    use crate::engine::host::{fs::HostFs, store::HostStore};
    // 1. The whole landing, before any lock is taken.
    if let Some(l) = landed {
        res!(crate::store::diamond::settle_check(path, l));
    }
    // 2. A target that is one of its own side files would wait on its own lock for 60 s.
    let sides = match landed {
        Some(l) => res!(crate::store::diamond::settle_sides(path, l)),
        None    => Vec::new(),
    };
    let target = normalise(lic.path());
    if sides.iter().any(|s| normalise(s) == target || normalise(s) == normalise(path)) {
        return Err(err!("'{}' is one of its own landing's side files, so nothing was written.",
            path; Invalid, Input));
    }
    let from = landed.and_then(|l| l.from.as_ref());
    let expect = match (expect, from) {
        (Some(e), Some(f)) if e != f => return Err(err!("'{}' changed just now: this write was \
            bound to one read of it and its landing was worked out from another, so nothing was \
            written or settled. Read it again before writing.", path; Invalid, Input, Mismatch)),
        (Some(e), _)                 => Some(e),
        (None, f)                    => f,
    };
    // 3. Under the lock: the compare, then the archive, then the bytes.
    let archive = match landed {
        Some(l) => l.part(SettlePhase::Archive),
        None    => Landed::default(),
    };
    let found = if archive.settles_nothing() {
        match expect {
            Some(e) => res!(host.fs().write_licensed_if(root, lic, bytes, e).await),
            None    => {
                res!(host.fs().write_licensed(root, lic, bytes).await);
                None
            },
        }
    } else {
        res!(host.fs().write_licensed_then(root, lic, bytes, expect,
            || host.store().standing_settle(root, path, &archive, SettlePhase::Archive)).await)
    };
    // 4. Refused: nothing written, nothing settled.
    if let Some(found) = found {
        return Ok(Written::Refused(found));
    }
    // 5. Landed: the record, which can no longer fail the write.
    let record = match landed {
        Some(l) => l.part(SettlePhase::Record),
        None    => Landed::default(),
    };
    if record.settles_nothing() {
        return Ok(Written::Landed { unrecorded: String::new() });
    }
    let unrecorded = match host.store().standing_settle(root, path, &record, SettlePhase::Record)
        .await
    {
        Ok(())  => String::new(),
        Err(e)  => fmt!("\n'{}' was written; its {} note could not be added: {}", path,
            DECISIONS_FILE, e.plain()),
    };
    Ok(Written::Landed { unrecorded })
}

/// The header every walk's answer opens with, as the page reads it back.
///
/// Ten counts and a directory name, tab separated. A private convention between two halves of
/// one build, and the parse is total: a header this build cannot read is a walk whose extent is
/// unknown, and an unknown extent must never be reported as a complete one.
pub(super) struct WalkHead {
    pub(super) spent:    usize,
    pub(super) stop:     Option<String>,
    pub(super) queued:   usize,
    pub(super) skipped:  usize,
    pub(super) filtered: usize,
    pub(super) too_big:  usize,
    pub(super) binary:   usize,
    pub(super) files:    usize,
    pub(super) left:     usize,
    pub(super) denied:   usize,
}

/// Read the header line, and the rest of the answer after it.
///
/// # Arguments
/// * `text` - The whole answer as the hand sent it.
pub(super) fn walk_head(text: &str) -> Outcome<(WalkHead, &str)> {
    let (head, rest) = match text.split_once('\n') {
        Some(p) => p,
        None    => (text, ""),
    };
    let c: Vec<&str> = head.split('\t').collect();
    if c.len() < 10 {
        return Err(err!(
            "The machine hand answered a walk with a summary this build cannot read, so there \
            is no way to say how much of the tree it looked at. A short answer whose extent is \
            unknown must not be reported as a whole one."; Invalid, Data));
    }
    let n = |i: usize| -> usize { c[i].parse::<usize>().unwrap_or(0) };
    Ok((WalkHead {
        spent:    n(0),
        // Empty means the walk finished, which is NOT the same as having stopped at the root.
        stop:     if c[1].is_empty() { None } else { Some(c[1].to_string()) },
        queued:   n(2),
        skipped:  n(3),
        filtered: n(4),
        too_big:  n(5),
        binary:   n(6),
        files:    n(7),
        left:     n(8),
        denied:   n(9),
    }, rest))
}

/// One absolute machine path, as this turn's model spells it.
///
/// The hand answers in the machine's own paths and the model works in the workspace's, and the
/// difference is exactly the granted root plus the Diamond's own prefix.  Every path that
/// reaches a report goes through here, so a path the model is shown is one it can hand straight
/// back to `file_read`.
///
/// A path that is somehow not under the root is returned as it came: a wrong path said plainly
/// is recoverable, and a wrong path with a prefix silently sliced off it is not.
///
/// # Arguments
/// * `root` - The folder the hand was granted, absolute.
/// * `abs` - The path the hand named.
/// * `strip` - The Diamond's own prefix, with its trailing slash, or empty.
pub(crate) fn machine_rel(root: &str, abs: &str, strip: &str) -> String {
    let base = root.trim_end_matches('/');
    let rel = match abs.strip_prefix(base).and_then(|r| r.strip_prefix('/')) {
        Some(r) => r,
        None    => return abs.to_string(),
    };
    if strip.is_empty() {
        return rel.to_string();
    }
    rel.strip_prefix(strip).unwrap_or(rel).to_string()
}

/// What a walk on the machine could not carry back, said out loud.
///
/// Two counts the browser-storage walk cannot produce and this one can, and both are the kind
/// of absence that reads as an answer if nobody names it: files that matched and would not fit
/// in one message, and directories the walk could not open at all.
///
/// **The second is the fence, seen from the inside.** A fenced-off subtree fails `read_dir`
/// exactly as a missing one does, so a walk that swallowed the difference would report "nothing
/// there" about a folder the user simply has not marked in -- which is `dev/BLOCKERS.md` B1's
/// whole complaint, one layer down.
///
/// # Arguments
/// * `tool` - The tool's name, for the `[tool]` prefix the other notices use.
/// * `left` - Files that matched and did not fit.
/// * `denied` - Directories the walk could not open.
pub(crate) fn walk_residue(tool: &str, left: usize, denied: usize) -> String {
    let mut out = String::new();
    if left > 0 {
        // WHAT THE CALLER CAN DO ABOUT IT, which the old wording could not say. It offered
        // 'glob' and 'path' to both tools, and for a search neither makes one file smaller: a
        // daimon narrowed eight times against a file whose whole text would not cross the wire
        // and got the same "No matches" every time (`dev/BLOCKERS.md` B17). Only the lines that
        // matched cross now, so what is left over is a question of how MUCH matched -- which a
        // caller can change, and which is not what is left over from a walk that reads nothing.
        out.push_str(&match tool {
            "file_glob" => fmt!(
                "\n[{}] {} further path(s) matched and would not fit in one message. Narrow the \
                pattern, or set 'path' to a directory further down, and ask again.", tool, left),
            _ => fmt!(
                "\n[{}] {} further file(s) matched, and so much of each matched that their \
                lines would not fit in one message. That is how much matched, not how big the \
                files are: make the query more specific, or ask for fewer surrounding lines \
                with 'before' and 'after', and ask again.", tool, left),
        });
    }
    if denied > 0 {
        out.push_str(&fmt!(
            "\n[{}] {} director(ies) under the walk could not be opened at all. That is this \
            turn's fence rather than a missing folder: a command reaches exactly the folders \
            added to this Diamond and so does a file tool. Nothing inside them was looked \
            at, so a short answer here is not evidence that there is nothing to find. Ask the \
            user to add the folder with the + in the Workspace group if it should be reachable.", tool, denied));
    }
    out
}

/// What a walk could not open, said out loud, on whichever filesystem it was walking.
///
/// The mirror of [`walk_residue`], which says the same two things about the half of a walk that
/// runs on the machine through the hand. Every OTHER walk swallowed both until 2026-08-25:
/// `list_dir`, `read_file`, `read_dir` and `std::fs::read` were each matched with a bare
/// `continue`, so a starting point the filesystem being walked does not hold was walked as
/// though it were a tree with nothing in it, and the answer came back `No matches for
/// '<query>'.` That is `dev/BLOCKERS.md` B1 in the two tools a daimon reaches for FIRST, and the
/// two that state an absence most confidently.
///
/// Neutral about which filesystem, deliberately: the same silence was in the browser walk, the
/// native walk and both tools, and one sentence keeps the four from drifting apart. WHICH world
/// an empty answer is about is [`walked_here`]'s sentence and not this one.
///
/// # Arguments
/// * `tool` - The tool's name, for the `[tool]` prefix the other notices use.
/// * `unopened` - Directories that would not open, the walk's own starting points included.
/// * `unread` - Files that would not open, which a search counts and a glob never opens at all.
pub(crate) fn unopened_residue(tool: &str, unopened: usize, unread: usize) -> String {
    let mut out = String::new();
    if unopened > 0 {
        out.push_str(&fmt!(
            "\n[{}] {} director(ies) named in this walk would not open, so nothing in them was \
            walked. A directory that will not open is not a directory with nothing in it, and a \
            short answer here is not evidence that there is nothing to find.", tool, unopened));
    }
    if unread > 0 {
        out.push_str(&fmt!(
            "\n[{}] {} file(s) would not open and so were not searched. Their contents are \
            unknown rather than free of the pattern.", tool, unread));
    }
    out
}

/// The note a WALK adds once it has answered about browser storage and found nothing there.
///
/// [`two_places_said`] says this of the one path a tool was sent for; a walk has a list of
/// starting points and no single entry to name, so the sentence it needs is about where it
/// LOOKED rather than about what it did not find. Written because `No matches for '<query>'.`
/// was the most confident false sentence in the product, said by the first tool a daimon
/// reaches for -- `dev/BLOCKERS.md` B1.
///
/// # Arguments
/// * `tool` - The tool's name, for the `[tool]` prefix the other notices use.
/// * `start` - The starting points, as the model wrote them.
/// * `host` - The host its hand and folder are asked through.
pub(crate) fn walked_here_said(tool: &str, start: &str) -> String {
    fmt!("\n[{}] Nothing was found, and this walk ran over '{}' in this browser's own storage{}",
        tool, start, SECOND_FILESYSTEM)
}

/// [`walked_here_said`], said only where there really are two places and the walk stayed in one.
///
/// `None` on the same two conditions as [`two_places_note`] -- a real folder is open, or no hand
/// is paired -- and on a third that a walk has and a single path cannot: a call whose starting
/// points SPLIT reached the machine for part of its answer, so an empty result from it is not
/// browser storage speaking alone and this sentence would be false about half of it.
///
/// # Arguments
/// * `tool` - The tool's name, for the `[tool]` prefix the other notices use.
/// * `start` - The starting points, as the model wrote them.
/// * `whole` - Whether EVERY starting point was walked in browser storage.
pub(super) fn walked_here<H: Host>(tool: &str, start: &str, whole: bool, host: &H) -> Option<String> {
    if !whole || !two_places(host) {
        return None;
    }
    Some(walked_here_said(tool, start))
}

/// The hand's file ops that change nothing, and so may be sent with no licence.
pub(super) const MACHINE_LOOKS: [&str; 4] = ["read", "list", "search", "glob"];

/// A change a file tool asks the hand to make on this computer, named by the licence that
/// allows it (see [`Licence`]).
pub(crate) enum MachineChange<'a> {
    Write(&'a Licence, &'a str),        // the file's whole text
    WriteIf(&'a Licence, &'a str, &'a crate::diamond_versions::Seen), // only over what was seen
    Edit(&'a Licence, &'a str, &'a str), // one hunk: the text found, and what replaces it
    Mkdir(&'a Licence),
    Move(&'a Licence, &'a Licence),     // from, and to
}

/// A whole-file write on the machine, bound as [`guarded_store_write`] binds one in storage: under
/// a restore's hold (`held`), only over what the act found (`seen`); otherwise, where the write
/// follows a read of the file (`bound`), only over that read; else, with no read to bind, over
/// whatever stands there (U3a RMW and RMW2, 2026-10-17).  Every hand a change is sent to compares
/// as it writes: one that does not is refused at the link ([`change_refusal`]).
pub(crate) fn machine_write<'a>(held: bool, lic: &'a Licence, text: &'a str,
    seen: &'a crate::diamond_versions::Seen, bound: Option<&'a WriteBound>)
    -> MachineChange<'a>
{
    match (held, bound) {
        (true, _)        => MachineChange::WriteIf(lic, text, seen),
        (false, Some(b)) => MachineChange::WriteIf(lic, text, b.seen()),
        (false, None)    => MachineChange::Write(lic, text),
    }
}

/// The machine hand's file door, as the tools reach it: [`machine_op`] to look, [`machine_change`]
/// to change, and nothing else.  The request itself is sent by a function private to this module,
/// so a changing op cannot be sent without a licence -- the hand's own fence is the second wall,
/// not the only one.
pub(super) mod hand_door {
    use super::*;

    /// Send one file request to the hand, and hand back what it said.
    ///
    /// # Arguments
    /// * `tool` - The tool's name, for the refusal's opening clause.
    /// * `op` - The wire's word: `read`, `write`, `edit`, `move`, `list`, `mkdir`, `search`, `glob`.
    /// * `fields` - The op's own JSON fields, already rendered and escaped, with a leading comma.
    /// * `host` - The host the hand is reached through.
    ///
    /// # Returns
    /// The answer where the hand did it, and the sentence to show where it did not.
    async fn send<H: Host>(
        tool:   &str,
        op:     &str,
        abs:    &str,
        cwd:    &str,
        spec:   &LinkedFence,
        kits:   &[Bound],
        fields: &str,
        host:   &H,
    )
        -> Outcome<Result<String, String>>
    {
        let req = bound_to_link(fmt!(
            r#"{{"t":"file","id":"{}","op":"{}","path":"{}","cwd":"{}","fence":{},"toolkits":{}{}}}"#,
            json_escape(&fmt!("f-{}", op)),
            op,
            json_escape(abs),
            json_escape(cwd),
            spec.fence.to_json(),
            toolkit_names_json(kits),
            fields,
        ), spec.link);
        let res = res!(host.exec().file(&req).await);
        // A relay that refused never reached the hand, so nothing was done and the sentence it
        // carries is the only instruction the model gets. Passed through whole.
        if let Some(why) = extract_json_string(&res, "refused") {
            return Ok(Err(fmt!("{}: {}", tool, why)));
        }
        let text = extract_json_string(&res, "text").unwrap_or_default();
        match extract_json_bool(&res, "ok") {
            Some(true) => Ok(Ok(text)),
            Some(false) => Ok(Err(fmt!("{}: {}", tool, text))),
            // Neither answer. The hand said something this build cannot read, and the one thing
            // that must not be said about a write is that it did not happen.
            None => Ok(Err(fmt!(
                "{}: the machine hand answered '{}' with something this build cannot read. Do not \
                assume the file is unchanged.", tool, abs))),
        }
    }

    /// Ask the hand to LOOK at a file or a folder on this computer: read, list, search or glob.
    ///
    /// A changing op is answered with a sentence and never sent: a change goes through
    /// [`machine_change`], which takes the licence the fence minted for it.
    pub(in crate::tools) async fn machine_op<H: Host>(
        tool:   &str,
        op:     &str,
        abs:    &str,
        cwd:    &str,
        spec:   &LinkedFence,
        kits:   &[Bound],
        fields: &str,
        host:   &H,
    )
        -> Outcome<Result<String, String>>
    {
        if !MACHINE_LOOKS.contains(&op) {
            return Ok(Err(fmt!(
                "{}: '{}' changes a file, and a change reaches the machine only with the write \
                fence's licence. Nothing was changed.", tool, op)));
        }
        send(tool, op, abs, cwd, spec, kits, fields, host).await
    }

    /// Ask the hand to CHANGE a file on this computer, at exactly the path the licence names.
    ///
    /// The absolute path is made here, from the granted `root` and the licence, rather than
    /// taken from the caller: a licence for one path cannot be spent on another.
    ///
    /// # Arguments
    /// * `root` - The folder the hand was granted, which every path here is under.
    /// * `cwd` - The mark the change is under, absolute; the op runs there.
    /// * `host` - The host the hand is reached through.
    pub(in crate::tools) async fn machine_change<H: Host>(
        tool:   &str,
        change: MachineChange<'_>,
        root:   &str,
        cwd:    &str,
        spec:   &LinkedFence,
        kits:   &[Bound],
        host:   &H,
    )
        -> Outcome<Result<String, String>>
    {
        let at = |lic: &Licence| fmt!("{}/{}", root.trim_end_matches('/'), normalise(lic.path()));
        let (op, abs, fields) = match change {
            MachineChange::Write(lic, text) =>
                ("write", at(lic), fmt!(r#","text":"{}""#, json_escape(text))),
            // Only ever sent to a hand that compares as it writes: one that does not is refused
            // any change at the link ([`change_refusal`], U3a RMW2).
            MachineChange::WriteIf(lic, text, seen) => {
                let expect = match seen {
                    crate::diamond_versions::Seen::Bytes(h) => h.as_str(),
                    crate::diamond_versions::Seen::Absent   => "absent",
                    crate::diamond_versions::Seen::Unread   => return Ok(Err(fmt!(
                        "{}: what stands at '{}' could not be read, so there is nothing to write \
                        only over. Nothing was changed.", tool, lic.path()))),
                };
                ("write", at(lic), fmt!(r#","text":"{}","expect":"{}""#,
                    json_escape(text), expect))
            },
            MachineChange::Edit(lic, old, new) =>
                ("edit", at(lic), fmt!(r#","text":"{}","text2":"{}""#,
                    json_escape(old), json_escape(new))),
            MachineChange::Mkdir(lic) =>
                ("mkdir", at(lic), String::new()),
            MachineChange::Move(from, to) =>
                ("move", at(from), fmt!(r#","to":"{}""#, json_escape(&at(to)))),
        };
        send(tool, op, &abs, cwd, spec, kits, &fields, host).await
    }
}
pub(super) use hand_door::machine_op;
pub(super) use hand_door::machine_change;

// ── Two scripts a command cannot run, told apart before it tries ─────────────
//
// Both rules below refuse an `argv` before the hand is asked anything, and both exist for the
// same measured failure: a model that meets a bare `Permission denied` or a missing dependency
// spends the turn on it. They are kept separate because the REASONS are different and a reader
// has to be able to tell which one fired -- a verifier is absent from the fence, a linking script
// is refused a capability inside it.
//
// What they share is the narrowness, which is the whole of the care. An argument is only looked
// at where it is the thing the command would START: a path handed to `rg`, to `cat` or to
// `git commit -m` is being talked about, not run, and a refusal there costs the turn the rules
// exist to save.

// Interpreters
pub(super) const NODE_RUNNERS:  [&str; 2] = ["node", "nodejs"];             // would run a .mjs
pub(super) const SHELL_RUNNERS: [&str; 4] = ["bash", "sh", "dash", "zsh"];  // would run a .sh

/// Whether the argument at `i` is the one this command would actually start.
///
/// True for an argument to a named interpreter, and true for `argv[0]` itself where that is not
/// an interpreter -- which is the self-executing spelling, `./dev/gate.sh`.  False everywhere
/// else, and that is what keeps `git commit -m "dev/gate.sh"` from being refused.
///
/// # Arguments
/// * `argv` - The command, as the model wrote it.
/// * `i` - Which argument is being asked about.
/// * `runners` - The interpreters that would run this kind of file.
pub(super) fn started_here(argv: &[String], i: usize, runners: &[&str]) -> bool {
    let prog = match argv.first() {
        Some(a) => a.rsplit('/').next().unwrap_or(""),
        None    => return false,
    };
    let by_runner = runners.contains(&prog);
    if i == 0 { !by_runner } else { by_runner }
}

/// A path's last two segments as `dev/<file>`, where it names something in `dev/`.
///
/// One spelling out of the several a model writes: `dev/gate.sh`, `./dev/gate.sh` and the
/// absolute path all answer `dev/gate.sh`, and a bare `gate.sh` does too, since a command whose
/// `cwd` is `dev` needs no directory part.  Anything under another directory answers nothing.
///
/// # Arguments
/// * `arg` - One element of an `argv`, as the model wrote it.
pub(super) fn dev_script(arg: &str) -> Option<String> {
    let mut segs = arg.rsplit('/');
    let file = match segs.next() {
        Some(f) if !f.is_empty() => f,
        _                        => return None,
    };
    match segs.next() {
        None | Some("dev") => Some(fmt!("dev/{}", file)),
        Some(_)            => None,
    }
}

// ── A verifier asked for through the wrong door ──────────────────────────────

/// The verifier a path names, where it names one.
///
/// Segment-wise and narrow, in the same spirit as [`names_segment`]: the last segment must be
/// `verify_<name>.mjs`, the directory part must be `dev` or absent, and the name must pass
/// [`verify_name_ok`], which is the alphabet the tool itself looks a verifier up by.  So
/// `dev/verify_graph.mjs`, `./dev/verify_graph.mjs` and the absolute spelling all answer `graph`,
/// while `tools/verify_thing.mjs`, `dev/sweep.mjs` and `dev/verify_graph.mjs.bak` answer nothing.
///
/// # Arguments
/// * `arg` - One element of an `argv`, as the model wrote it.
pub(super) fn verifier_name(arg: &str) -> Option<String> {
    let mut segs = arg.rsplit('/');
    let file = match segs.next() {
        Some(f) => f,
        None    => return None,
    };
    let stem = match file.strip_suffix(".mjs") {
        Some(s) => s,
        None    => return None,
    };
    let name = match stem.strip_prefix("verify_") {
        Some(n) => n,
        None    => return None,
    };
    // A verifier lives in `dev/`. A file spelled like one somewhere else is somebody else's
    // script, and refusing it would be this guard costing a turn rather than saving one.
    match segs.next() {
        None | Some("dev") => (),
        Some(_)            => return None,
    }
    if !verify_name_ok(name) {
        return None;
    }
    Some(name.to_string())
}

/// The refusal a `run` gets for an `argv` that would start one of `dev/`'s verifiers, or `None`
/// where it would not.
///
/// **Measured on a live daimon turn, 2026-08-23: forty-one tool calls and nothing verified.**
/// Asked to check the work it had just done, the daimon reached for `run`.  It stood up a dev
/// server, hunted the tree for `playwright-core`, tested whether the network answered, and came
/// away with not one check proved.  It could never have worked: a verifier is run OUTSIDE the
/// command fence deliberately, because it is tracked repository code rather than something a
/// model wrote (`hand/src/verify.rs`), and inside the fence playwright is absent and there is no
/// network to fetch it from.  The turn was not slow, it was impossible, and nothing the model
/// could see said so.
///
/// So the answer is given before the hand is asked anything -- no fact about the machine changes
/// it -- and it names the tool and the argument that work.  A refusal that only said no would
/// send the model back for another forty-one.
///
/// # Arguments
/// * `argv` - The command, as the model wrote it.
pub fn verifier_refusal(argv: &[String]) -> Option<String> {
    for (i, a) in argv.iter().enumerate() {
        // Only the argument node would actually run; see `started_here`.
        if !started_here(argv, i, &NODE_RUNNERS) {
            continue;
        }
        if let Some(name) = verifier_name(a) {
            return Some(fmt!(
                "Refused: '{}' is one of this repository's verifiers, and a verifier cannot run \
                inside the fence a command runs in -- playwright is not installed there and there \
                is no network to fetch it from, so this would fail slowly having proved nothing. \
                The 'verify' tool runs it OUTSIDE the fence, which is the whole reason that tool \
                exists: verify {{\"name\":\"{}\"}}. It reports what the clean pass proved, every \
                break the verifier declares, and any break that proved nothing. Nothing was run.",
                a, name));
        }
    }
    None
}

// ── A script the fence has taken a capability away from ──────────────────────
//
// A writable grant no longer carries `LANDLOCK_ACCESS_FS_MAKE_SYM`, so a fenced command cannot
// create a symbolic link ANYWHERE -- not in the folders it may write, not in its own scratch --
// and `ln -s` and `symlink(2)` answer "Permission denied".  The right was withheld because a link
// is half of a leak: the command makes it, and whatever later follows it supplies the other half.
// Ore is the case that was measured, and it is the sharp one here -- it absorbs the CONTENT of a
// link that leaves the working copy, under the link's own path, into a signed history with no
// forget, and the global `post-commit` hook runs it on the owner's key from outside the fence.
//
// The cost is four scripts in this tree, and it is paid in the worst possible currency: `ln`
// fails PART WAY THROUGH, after the script has made a worktree or a directory, so the model gets
// a bare permission error attached to work that half happened.  Naming them here turns that into
// one sentence before anything runs.
//
// The list is short because it was gathered by reading the tree rather than guessed, and it is a
// list rather than a pattern for the same reason `SKIP_DIRS` is: a rule that tried to detect
// "would this create a link" from an `argv` would be wrong in both directions.  A script added
// later that links will not be named here, and will fail the way it did before this existed.

/// One `dev/` script a fenced command cannot run, and what to do about it.
pub(super) struct Linking {
    pub(super) path:    &'static str,  // as the tree spells it, from the repository root
    pub(super) does:    &'static str,  // what it links, in a clause that completes "it links ..."
    pub(super) instead: &'static str,  // the sentence the refusal ends on
}

/// The scripts in `dev/` that create a symbolic link, with the line each does it on at the time
/// of writing: `gate.sh:135` and `:147`, `attribute.sh:72`, `devgw.sh:26`, `shot_betatier.mjs:80`,
/// `verify_deploy_provmatch.sh:21`, `install_runner_system.test.sh:128`, `runner_n1_check.sh:110`,
/// `install_dev_userns_profile.test.sh:36`, `probe_agentsacross.mjs:50`,
/// `testnet_standup.sh:208`.
pub(super) const LINKING_SCRIPTS: &[Linking] = &[
    Linking {
        path: "dev/gate.sh",
        does: "the vendored Typst compiler, and the gateway's keys and store, into a worktree",
        instead: "It is the release gate in any case, which is a two-hour job and not yours to \
            start: run the one verifier you actually need with the 'verify' tool, and ask the \
            user when a release is what is wanted.",
    },
    Linking {
        path: "dev/attribute.sh",
        does: "the built wasm into a worktree checked out at an older commit",
        instead: "Ask the user to run it outside Daimond, and say which commit you wanted \
            attributed.",
    },
    Linking {
        path: "dev/devgw.sh",
        does: "the sandbox keys and the live store into the dev gateway's directory",
        instead: "Ask the user to start the dev gateway; the links it needs are exactly what the \
            fence withholds, and a copy would not do -- a webhook signature is checked against \
            those keys.",
    },
    Linking {
        path: "dev/testnet_standup.sh",
        does: "the test gateway's keys directory to its key root on the host it stands the testnet up on",
        instead: "It stands up the testnet beside production over ssh, which is the owner's \
            operation and not a check you run inside a turn. Ask the user to run it, and say \
            which step you wanted.",
    },
    Linking {
        path: "dev/reflux.mjs",
        does: "a file inside its own fixture tree, to prove that its symlink task can go red",
        instead: "It drives a real browser, a real model and real spending, and is the loop the \
            owner starts rather than a check you run inside a turn. Ask the user to run it, and \
            say which task you wanted measured.",
    },
    Linking {
        path: "dev/refluxduo.mjs",
        does: "the gateway's own keys into the scratch directory it stands its gateway up in",
        instead: "It stands up a gateway, a forge, a front door and two browsers, and spends \
            real money against a real provider on two models at once. It is the loop the owner \
            starts rather than a check you run inside a turn. Ask the user to run it, and say \
            which journey you wanted measured.",
    },
    Linking {
        path: "dev/shot_betatier.mjs",
        does: "a signing key into the work directory it shoots from",
        instead: "Ask the user to run it, or take the shots you need from a page that does not \
            need the gateway.",
    },
    Linking {
        path: "dev/soak_sync.mjs",
        does: "the gateway's own keys into the scratch directory it stands its gateway up in",
        instead: "It stands up a gateway, a mock model and three browsers on one account for \
            minutes at a time: a soak a release lane starts, not a check you run inside a turn. \
            Ask the user to run it, and say which schedule you wanted soaked.",
    },
    Linking {
        path: "dev/probe_r53_u8.mjs",
        does: "the gateway's own keys into the scratch directory it stands its gateway up in",
        instead: "It stands up a gateway, a mock model and two browsers, a phone and a desktop \
            paired on one account, to probe a typed turn around a pause: a verifier a release \
            lane starts, not a check you run inside a turn. Ask the user to run it, and say \
            which journey you wanted probed.",
    },
    Linking {
        path: "dev/probe_agentsacross.mjs",
        does: "the gateway's own keys into the scratch directory it stands its gateway up in",
        instead: "It claims a world, stands up its own gateway and two paired pages of one \
            account, to probe that a worker on one device shows in every device's Agents grid: \
            a verifier a release lane starts, not a check you run inside a turn. Ask the user to \
            run it, and say which journey you wanted probed.",
    },
    Linking {
        path: "dev/qa_r53_u8.mjs",
        does: "the gateway's own keys into the scratch directory it stands its gateway up in",
        instead: "It stands up a gateway, a mock model and two browsers, a phone and a desktop \
            paired on one account, and attacks a fix for minutes at a time: a QA round a release \
            lane starts, not a check you run inside a turn. Ask the user to run it, and say \
            which section you wanted run.",
    },
    Linking {
        path: "dev/qa_r53_u8b.mjs",
        does: "the gateway's own keys into the scratch directory it stands its gateway up in",
        instead: "It stands up a gateway, a mock model and two browsers, a phone and a desktop \
            paired on one account, and attacks a fix for minutes at a time: a QA round a release \
            lane starts, not a check you run inside a turn. Ask the user to run it, and say \
            which section you wanted run.",
    },
    Linking {
        path: "dev/foldershare_book.mjs",
        does: "an `assets` folder into the test book it generates, from the top and from an \
            archived snapshot",
        instead: "It builds the fixture dev/verify_foldershare.mjs shares and is not a check of \
            its own. Ask the user to run that verifier, and say what you wanted shared.",
    },
    Linking {
        path: "dev/verify_deploy_provmatch.sh",
        does: "a symlinked fe2o3 checkout into the fixture directory it checks the deploy \
            script's crate record against",
        instead: "It drives dev/deploy.sh, the release's own script, and is a check a release \
            lane runs, not one you run inside a turn. Ask the user to run it, and say what \
            you wanted checked about the gateway's crate record.",
    },
    Linking {
        path: "dev/rehearse_c6_rollback.mjs",
        does: "the gateway's own keys into the scratch store it stands the base and C6 gateways \
            up on",
        instead: "It is the C6 KEEP release rehearsal, a restart and rollback between two \
            gateway builds, and a release lane runs it, not a turn. Ask the user to run it, and \
            say what you wanted rehearsed.",
    },
    Linking {
        path: "dev/install_runner_system.test.sh",
        does: "a fixture var/lib under its scratch root, to prove the runner installer refuses a \
            symlinked path",
        instead: "It is the runner installer's own test, which a runner lane runs outside \
            Daimond. Ask the user to run it, and say which installer case you wanted.",
    },
    Linking {
        path: "dev/install_dev_userns_profile.test.sh",
        does: "a fixture cargo target root through a symlink under its scratch HOME, to prove the \
            developer userns profile attaches to the resolved path",
        instead: "It is the developer profile installer's own test (SW-0b), which a runner lane \
            runs outside Daimond. Ask the user to run it, and say which case you wanted.",
    },
    Linking {
        path: "dev/runner_n1_check.sh",
        does: "the gateway's keys into the scratch directory it stands its gateway up in",
        instead: "It builds and stands up a gateway and replays the runner's golden exchanges \
            against it: a release lane's version-skew check, not one you run inside a turn. Ask \
            the user to run it, and say which runner version you wanted checked.",
    },
    Linking {
        path: "dev/turn_parity.sh",
        does: "the sandbox gateway keys into the page export's gateway directory (--two)",
        instead: "It builds a runner and a page, stands up a world and a gateway and drives a \
            browser: it is the release gate's turn check, not one to run inside a turn. Ask the \
            user to run it, and say which runner and page you wanted compared.",
    },
    Linking {
        path: "dev/turn_parity.mjs",
        does: "the page's gateway keys into the scratch directory its two-device gateway runs in",
        instead: "turn_parity.sh drives it with the world it needs; ask the user to run that, and \
            say which runner and page you wanted compared.",
    },
];

/// The linking script a path names, where it names one.
///
/// # Arguments
/// * `arg` - One element of an `argv`, as the model wrote it.
pub(super) fn linking_script(arg: &str) -> Option<&'static Linking> {
    let named = match dev_script(arg) {
        Some(n) => n,
        None    => return None,
    };
    LINKING_SCRIPTS.iter().find(|s| s.path == named)
}

/// Does `a` spell the long flag that asks for a symbolic link, in full or as the unambiguous
/// abbreviation `getopt_long` itself would accept?
///
/// `ln`'s `--symbolic` and `cp`'s `--symbolic-link` are the only long options either program has
/// starting `--sym`, so any prefix of one -- `--sym`, `--symb`, `--symbo`, and so on up to the
/// full spelling -- names it exactly as `getopt_long` resolves an abbreviation: matched against
/// `long` rather than against a bare `starts_with`, so a token that merely shares the prefix
/// without being one, such as a typo past the end of the real flag, is not caught by accident.
///
/// # Arguments
/// * `a` - One token of `argv`.
/// * `long` - The long flag's full spelling, e.g. `"--symbolic"`.
pub(super) fn is_symbolic_long_flag(a: &str, long: &str) -> bool {
    a.starts_with("--sym") && long.starts_with(a)
}

/// Does `rest` -- an `argv` with the program itself already stripped off -- carry the flag that
/// asks for a symbolic link, spelled either as `long` (or an abbreviation of it, see
/// [`is_symbolic_long_flag`]) or bundled into a short-flag cluster with `short`?
///
/// A bare `--` ends option parsing: everything after it is an operand, matched or not, so
/// `ln -s -- -sf x` links a file literally named `-sf` rather than asking twice. Before that, any
/// token starting with a single `-` (not `--`) is a cluster of short flags -- `-sf`, `-fs` and
/// `-sn` all carry `-s` -- so the letter is looked for among a token's characters in order, not
/// just checked against the whole token.
///
/// The scan of a cluster stops the moment it meets `t` or `S` -- `-t`/`--target-directory` and
/// `-S`/`--suffix`, on both `ln` and `cp` -- because both TAKE an argument that may be glued
/// straight onto the flag: `ln -tsrc a` links `a` into the directory `src`, and the `s` inside
/// `"src"` is that argument's text, not a second flag. Scanning past it is how `-tsrc` was
/// wrongly refused as if it were `-t` plus `-s`.
///
/// # Arguments
/// * `rest` - `argv[1..]`, the program's own arguments.
/// * `short` - The short flag's letter, e.g. `'s'`.
/// * `long` - The long flag's own spelling, e.g. `"--symbolic"`.
pub(super) fn asks_for_symlink(rest: &[String], short: char, long: &str) -> bool {
    for a in rest {
        if a == "--" {
            break;
        }
        if is_symbolic_long_flag(a, long) {
            return true;
        }
        if a.starts_with('-') && !a.starts_with("--") {
            for c in a.chars().skip(1) {
                if c == short {
                    return true;
                }
                if c == 't' || c == 'S' {
                    break; // the rest of this token is that option's glued-on argument
                }
            }
        }
    }
    false
}

/// Does `argv` invoke `ln` or `cp` asking, directly, for a symbolic link -- `ln -s`, `ln -sf`,
/// `ln --symbolic`, `cp -s`, `cp --symbolic-link` -- as opposed to a hard link (`ln a b`, no `-s`
/// anywhere) or a command that merely shares the letter for an unrelated reason (`ls -s` is a
/// different program, checked by its exact name, not by the flags it happens to take)?
///
/// # Arguments
/// * `argv` - The command, as the model wrote it.
pub(super) fn direct_symlink_command(argv: &[String]) -> bool {
    let prog = match argv.first() {
        Some(a) => a.rsplit('/').next().unwrap_or(""),
        None    => return false,
    };
    match prog {
        "ln" => asks_for_symlink(&argv[1..], 's', "--symbolic"),
        "cp" => asks_for_symlink(&argv[1..], 's', "--symbolic-link"),
        _    => false,
    }
}

/// The refusal a `run` gets for an `argv` that would start one of the scripts that cannot work
/// under the fence, or that itself asks `ln`/`cp` to create a symbolic link directly, or `None`
/// where neither is true.
///
/// Deliberately not the same sentence as [`verifier_refusal`], because it is not the same fault.
/// A verifier is refused for something ABSENT from the fence -- playwright, and the network to
/// fetch it with.  These are refused for a capability withheld INSIDE it, on purpose, and one
/// that no amount of installing anything will restore.  A model told the wrong reason goes
/// looking for the wrong fix, which is the whole failure both rules exist against.
///
/// # Arguments
/// * `argv` - The command, as the model wrote it.
pub fn symlink_refusal(argv: &[String]) -> Option<String> {
    if direct_symlink_command(argv) {
        return Some(fmt!(
            "Refused: '{}' asks to create a symbolic link, and a fenced command cannot create \
            one anywhere: not in the folders it may write, not in its own scratch directory. \
            'ln -s' and 'cp -s' answer 'Permission denied', and that is the fence working rather \
            than a fault -- not a transient permission error and not something a retry or an \
            install fixes. The capability is withheld by design, because a link is half of a \
            leak: this command would make it, and whatever later follows it supplies the other \
            half -- including the Ore replica this tree records into, which absorbs the CONTENT \
            of a link that leaves the working copy into a signed history that cannot forget. Do \
            not attempt to create the link. Where a reference inside the workspace will do, copy \
            instead -- 'cp -r' for a directory, a plain 'cp' for a file -- and reach for a hard \
            link only where the target is a single file on the same filesystem; where the link \
            genuinely needs to reach outside the workspace, ask the user to make it themselves. \
            Nothing was run.",
            argv.join(" ")));
    }
    for (i, a) in argv.iter().enumerate() {
        // A `.sh` is started by a shell or by itself, a `.mjs` by node or by itself. Asked of
        // both sets rather than of the file's extension, so that `bash dev/shot_betatier.mjs` --
        // wrong, but a thing a model writes -- is refused for the right reason instead of running
        // and failing at the link.
        let started = started_here(argv, i, &SHELL_RUNNERS)
            || started_here(argv, i, &NODE_RUNNERS);
        if !started {
            continue;
        }
        if let Some(s) = linking_script(a) {
            return Some(fmt!(
                "Refused: '{}' creates a symbolic link -- it links {} -- and a fenced command \
                cannot create one anywhere: not in the folders it may write, not in its own \
                scratch directory. 'ln -s' answers 'Permission denied', and that is the fence \
                working rather than a fault. The capability is withheld because a link is half of \
                a leak: this command would make it, and whatever later follows it supplies the \
                other half -- including the Ore replica this tree records into, which absorbs the \
                CONTENT of a link that leaves the working copy into a signed history that cannot \
                forget. So the script cannot be made to work from in here, and nothing you \
                install will change that. {} Nothing was run.",
                a, s.does, s.instead));
        }
    }
    None
}

/// Does this stderr read as a symbolic link the fence denied, however the command reached it?
///
/// [`symlink_refusal`] is the cheap fast path -- it reads `argv` before anything runs -- but it
/// only sees a call spelled out directly. A shell (`bash -c 'ln -s a b'`), another interpreter
/// (`python3 -c 'import os; os.symlink(a, b)'`, `node -e 'fs.symlinkSync(a, b)'`, `perl -e
/// 'symlink(...)'`) or a program that makes links as a side effect (`tar`, `rsync -l`, `cp -a`)
/// hides the call from argv entirely, and what comes back is a bare "Permission denied" with
/// nothing to say why -- the exact symptom the pre-emptive check exists to kill. This is the
/// other half: read on the stderr the command actually printed, after the fact, whatever produced
/// it. Matched case-insensitively and on substrings rather than one error format, because every
/// runtime spells the same denial differently -- coreutils capitalises ("Permission denied"),
/// Node's libuv does not ("EACCES: permission denied, symlink '...'"), and Python's OSError
/// repeats the OS text verbatim.
///
/// # Arguments
/// * `err` - The command's stderr, as the hand returned it.
pub(super) fn looks_like_symlink_denial(err: &str) -> bool {
    let hay = err.to_ascii_lowercase();
    (hay.contains("symbolic link") || hay.contains("symlink"))
        && (hay.contains("permission denied") || hay.contains("operation not permitted"))
}
