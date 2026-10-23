//! The fence check at dispatch (UNBLOCK-16 F6, u3a_plan §9.1 rows 5-6, §9.7 B1, 16 Oct 2026).
//!
//! **The fence judged here is the worker's, never the conductor's.**  An unscoped conductor reads
//! and writes everything, so a check against `ctx.may_read` passed every brief it was given; the
//! worker gets its own fence when the page scopes it, from the Diamond or chat it works for.  That
//! fence is built here by [`worker_fence`], the one construction both scope exports call.
//!
//! **What the two real briefs showed** (`dev/fixtures/briefs/README.md`): neither w114's nor w127's
//! brief names a path its worker could not reach.  Both workers were refused paths they composed
//! themselves (the folder `.daimond/starters`; a `..` climb).  The check still refuses a brief that
//! does name one, before anything is spent.
//!
//! **A brief is judged for reading only** (lead ruling, 16 Oct 2026: no write-verb rule).  Reading
//! is free under every fence, so what a brief can name and be refused for is Daimond's own
//! directory, a `..` climb, or a target whose scope names no folder at all.

use crate::{
    engine::host::{
        Host,
        store::HostStore,
    },
    marks::{
        DiamondId,
        Live,
        Reach,
        UNREAD,
    },
    tools::{
        self,
        Bound,
        Tool,
        ToolContext,
    },
};

use oxedyne_fe2o3_core::prelude::*;


const MAX_PATHS: usize = 32;

/// Why a spawn is refused when the record of the marks cannot be read: [`UNREAD`]'s cause in a
/// clause of its own, since a refused spawn neither writes nor deletes, and the sentence it
/// completes ("the worker was NOT started, because ...") is already under way.
pub const SPAWN_UNREAD: &str = "this device's record of the folders marked here could not be read \
    (the account is locked, or this browser's storage could not be read, or the record is missing \
    or damaged), so the worker could not be given the fence it would run in. Unlock the account \
    and try again.";

/// THE ONE CONSTRUCTION OF A SCOPED AGENT'S FENCE: the bounds and the marks waiting for a press.
///
/// `set_diamond_scope`, `set_chat_scope`, the live re-read at every call and the dispatch check
/// all build it here, so the fence a brief is judged against is the one its worker then runs in.
/// `toolkits` is `None` for a chat, which is granted no toolchain at all: [`tools::toolkit_bounds`]
/// of an empty list is not empty (it grants the remote toolkit), so a chat must not reach it.
///
/// # Arguments
/// * `own` - The Diamond's own directory, or the chat's scratch.
pub fn worker_fence(
    own:      &str,
    reach:    &Reach,
    toolkits: Option<&[String]>,
)
    -> (Vec<Bound>, Vec<String>)
{
    let mut bounds = tools::diamond_bounds(own, &reach.places(), &reach.read_only);
    // Appended, never merged in earlier: a toolkit widens what a COMMAND may touch and nothing else.
    if let Some(kits) = toolkits {
        bounds.extend(tools::toolkit_bounds(kits));
    }
    (bounds, reach.unconfirmed.clone())
}

/// The fence a worker for `target` runs in, given what `target` reaches now.
pub fn fence_of(target: &Live, reach: &Reach) -> (Vec<Bound>, Vec<String>) {
    match target {
        Live::Diamond(id, kits) => worker_fence(&id.dir(), reach, Some(kits)),
        Live::Chat(chat, _)     => worker_fence(&tools::chat_scratch(chat), reach, None),
    }
}

/// Whom a worker dispatched from this turn works for, as the page will scope it: the Diamond or
/// chat whose marks hold the conductor, else the Diamond the conductor acts for.  `None` where the
/// engine cannot know, and then no early check is made; the worker's own fence still holds.
pub fn target_of<H: Host>(ctx: &ToolContext<H>) -> Option<Live> {
    match &ctx.live {
        Some(live) => Some(live.clone()),
        None       => match DiamondId::parse(&ctx.daimon_of) {
            Ok(id) => Some(Live::Diamond(id, Vec::new())),
            Err(_) => None,
        },
    }
}

/// The target as the spawn payload carries it: `diamond:<id>` or `chat:<id>`.
pub fn target_word(target: &Live) -> String {
    match target {
        Live::Diamond(id, _) => fmt!("diamond:{}", id),
        Live::Chat(chat, _)  => fmt!("chat:{}", chat),
    }
}

/// The refusal a spawn of `task` from this turn meets, or `None` where it may start.
///
/// The reach is read fresh from the store, never taken from the conductor's bounds: the worker is
/// scoped afresh when it starts, and a conductor's own list may be composed with a skill's.  A
/// record that cannot be read refuses, as the scope export would.
pub async fn at_dispatch<H: Host + Clone>(task: &str, ctx: &ToolContext<H>) -> Option<String> {
    let target = match target_of(ctx) {
        Some(t) => t,
        None    => return None,
    };
    let reach = match ctx.host().store().reach(&target).await {
        Ok(r)  => r,
        Err(_) => return Some(not_started(SPAWN_UNREAD)),
    };
    judge(task, ctx, &target, &reach)
}

/// [`at_dispatch`] once the reach is read.
pub fn judge<H: Host + Clone>(
    task:   &str,
    ctx:    &ToolContext<H>,
    target: &Live,
    reach:  &Reach,
)
    -> Option<String>
{
    let (bounds, unconfirmed) = fence_of(target, reach);
    if bounds.iter().any(|b| matches!(b, Bound::Nowhere)) {
        return Some(not_started("the place it would work for names no folder at all, so it could \
            neither read nor write anything"));
    }
    // The worker's context: the conductor's, with the worker's fence in place of its own.
    let mut fence = ctx.clone();
    fence.no_write = bounds;
    fence.unconfirmed = unconfirmed;
    fence.live = Some(target.clone());
    fence.by_model = true;
    let bad = unreachable(&brief_paths(task), &fence);
    if bad.is_empty() {
        return None;
    }
    let mut list = String::new();
    for (path, why) in bad.iter() {
        list.push_str(&fmt!("\n- '{}': {}", path, why));
    }
    Some(tools::refusal_line(&fmt!(
        "the worker was NOT started, because its brief names {} it could not reach. Each is what \
         the worker itself would have been told:{}\n\nRewrite the brief without them, or give the \
         worker what it needs in the brief itself. Nothing is running and nothing was spent.",
        if bad.len() == 1 { "a path" } else { "paths" }, list)))
}

fn not_started(why: &str) -> String {
    tools::refusal_line(&fmt!("the worker was NOT started, because {} Nothing is running and \
        nothing was spent.", if why.ends_with('.') { why.to_string() } else { fmt!("{}.", why) }))
}

/// The paths of `paths` the worker in `fence` could not even read or walk, each with the sentence
/// it would have been refused in: a `..` climb, else the fence's own read rule.  A folder the
/// worker may list, search or glob ([`ToolContext::may_walk`]) is one it can use, so it passes
/// (QA1 F1).  A path is judged for reading only: what a brief asks to be written is not read off
/// its verbs (lead ruling, 16 Oct 2026), and the worker's own fence still refuses each write it
/// makes.
///
/// Refuse only what the worker could not even use (D4).  A spelling the file tools would refuse
/// but whose meaning is plain -- `./a.md`, a trailing `/` -- is judged as the place it names.
pub fn unreachable<H: Host>(paths: &[String], fence: &ToolContext<H>) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for path in paths.iter() {
        if path.split(|c| c == '/' || c == '\\').any(|s| s == "..") {
            if let Some(s) = tools::path_refusal(&Tool::FileRead, path) {
                out.push((path.clone(), tools::refusal_line(&s)));
            }
            continue;
        }
        let p = tools::normalise(path);
        if !fence.may_read(&p) && !fence.may_walk(&p) {
            out.push((path.clone(), fence.refusal(path, false)));
        }
    }
    out
}

/// The workspace paths a brief names, at most [`MAX_PATHS`], each once.
///
/// A path is a backticked or quoted token with no space that holds a `/` or starts with `.`, or a
/// bare word that starts with `.`, holds two `/`, or holds one and ends in an extension.  Fenced
/// code blocks are skipped (CSS and code are not paths), and so are URLs, numbers and dates, words
/// like `and/or`, and machine paths (`/usr/…`, `~/…`), which are `run`'s and not the file tools'.
pub fn brief_paths(task: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut fenced = false;
    for line in task.lines() {
        if line.trim_start().starts_with("```") {
            fenced = !fenced;
            continue;
        }
        if fenced {
            continue;
        }
        for (tok, quoted) in tokens(line) {
            if let Some(path) = candidate(&tok, quoted) {
                if out.len() < MAX_PATHS && !out.contains(&path) {
                    out.push(path);
                }
            }
        }
    }
    out
}

/// Every token of `line`: (text, quoted).
fn tokens(line: &str) -> Vec<(String, bool)> {
    let mut out = Vec::new();
    let chars: Vec<char> = line.chars().collect();
    let mut rest = String::with_capacity(line.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        // An apostrophe inside a word ("the starter's") opens nothing.
        let opens = c == '`' || c == '"'
            || (c == '\'' && (i == 0 || !chars[i - 1].is_alphanumeric()));
        if opens {
            if let Some(j) = (i + 1..chars.len()).find(|&j| chars[j] == c) {
                let inner: String = chars[i + 1..j].iter().collect();
                if !inner.is_empty() && !inner.chars().any(char::is_whitespace) {
                    out.push((inner, true));
                    for _ in i..=j {
                        rest.push(' ');
                    }
                    i = j + 1;
                    continue;
                }
            }
        }
        rest.push(c);
        i += 1;
    }
    // The bare words of what is left.
    let mut start: Option<usize> = None;
    for (k, c) in rest.char_indices().chain(std::iter::once((rest.len(), ' '))) {
        match (c.is_whitespace(), start) {
            (true, Some(s)) => {
                out.push((rest[s..k].to_string(), false));
                start = None;
            },
            (false, None) => start = Some(k),
            _             => {},
        }
    }
    out
}

/// The path `tok` names, or `None` where it names none.
fn candidate(tok: &str, quoted: bool) -> Option<String> {
    let t = if quoted {
        tok
    } else {
        tok.trim_start_matches(|c: char| "([{<'\"".contains(c))
            .trim_end_matches(|c: char| ".,;:!?)]}>'\"".contains(c))
    };
    if t.is_empty() || t.contains("://") || t.starts_with("www.") || t.starts_with("mailto:") {
        return None;
    }
    // A machine path, which only `run` takes and the fence does not judge by name.
    if t.starts_with('/') || t.starts_with('~') || t.starts_with('\\') {
        return None;
    }
    // Numbers, dates and ellipses.
    if !t.chars().any(char::is_alphabetic) {
        return None;
    }
    if t.chars().any(|c| "<>=(){}[]*|,;\"`$&?".contains(c)) {
        return None;
    }
    let t = t.strip_suffix('/').unwrap_or(t);
    let dotted = t.starts_with('.') && t[1..].chars().next()
        .map_or(false, |c| c.is_alphabetic() || c == '.' || c == '/' || c == '_');
    let slashes = t.matches('/').count();
    let ok = if quoted {
        slashes > 0 || dotted
    } else {
        dotted || slashes >= 2 || (slashes == 1 && has_extension(t))
    };
    if ok { Some(t.to_string()) } else { None }
}

/// Does the last name of `p` end in an extension, `.md` or `.png`?
fn has_extension(p: &str) -> bool {
    let last = p.rsplit('/').next().unwrap_or(p);
    match last.rfind('.') {
        Some(i) if i > 0 && i + 1 < last.len() => {
            let ext = &last[i + 1..];
            ext.chars().all(|c| c.is_ascii_alphanumeric()) && ext.chars().any(|c| c.is_ascii_alphabetic())
        },
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        executor::Executor,
        marks::Hold,
        tools::{
            FileRoot,
            chat_bounds,
            chat_scratch,
            diamond_bounds,
            new_read_cache,
            toolkit_bounds,
        },
        workspace::Workspace,
    };

    const DIA: &str = "19fac707c542";

    fn ctx() -> ToolContext {
        let dir = match oxedyne_fe2o3_test::scratch::scratch_dir("daimond_brief_test") {
            Ok(d)  => d,
            Err(e) => panic!("a scratch directory: {}", e),
        };
        let ws = match Workspace::new(dir) {
            Ok(w)  => w,
            Err(e) => panic!("a workspace: {}", e),
        };
        ToolContext { workspace: ws, executor: Executor::local_default(), cwd: String::new(),
            turn: String::new(), path_prefix: String::new(), root: FileRoot::Workspace,
            read_seen: new_read_cache(), no_write: Vec::new(), daimon_of: String::new(),
            keeper: String::new(), unconfirmed: Vec::new(), live: None, by_model: false,
            restoring: 0, by: None, host: Default::default() }
    }

    fn dia() -> Live {
        match DiamondId::parse(DIA) {
            Ok(id) => Live::Diamond(id, Vec::new()),
            Err(e) => panic!("{}", e),
        }
    }

    fn strings(v: &[&str]) -> Vec<String> { v.iter().map(|s| s.to_string()).collect() }

    fn fixture(name: &str) -> String {
        let path = fmt!("{}/dev/fixtures/briefs/{}", env!("CARGO_MANIFEST_DIR"), name);
        match std::fs::read_to_string(&path) {
            Ok(s)  => s,
            Err(e) => panic!("{}: {}", path, e),
        }
    }

    /// w114 "page-fork": the starter to read and the Diamond's page to write.  Both reachable, so
    /// the brief passes: what blocked w114 was its own search of the FOLDER `.daimond/starters`.
    #[test]
    fn w114_real_brief_passes_the_fence() {
        let task = fixture("w114.txt");
        let named = brief_paths(&task);
        assert_eq!(named, vec![
            fmt!(".daimond/starters/crystal.html"),
            fmt!("diamonds/{}/crystal.html", DIA),
        ], "from: {}", task);
        assert_eq!(None, judge(&task, &ctx(), &dia(), &Reach::default()));
        // The folder the worker went on to search passes since WALK: it may search it (QA1 F1).
        // What lies beside the grant there is still refused.
        let mut fence = ctx();
        fence.no_write = fence_of(&dia(), &Reach::default()).0;
        assert!(unreachable(&[fmt!(".daimond/starters")], &fence).is_empty());
        let bad = unreachable(&[fmt!(".daimond/config.jdat")], &fence);
        assert_eq!(1, bad.len());
        assert!(bad[0].1.contains("inside Daimond's own directory"), "{}", bad[0].1);
    }

    /// w127 "visual-confirm": one screenshot to read, "Do not edit any file".  It passes: the `..`
    /// was the worker's own composition at round 7, which the same rule refuses at dispatch.
    #[test]
    fn w127_real_brief_passes_the_fence() {
        let task = fixture("w127.txt");
        assert_eq!(brief_paths(&task), vec![
            fmt!("diamonds/{}/shots/look-1440.png", DIA),
        ], "from: {}", task);
        assert_eq!(None, judge(&task, &ctx(), &dia(), &Reach::default()));
        let climbed = fmt!("Read `diamonds/{}/shots/../crystal.json` for the data.", DIA);
        match judge(&climbed, &ctx(), &dia(), &Reach::default()) {
            Some(s) => assert!(s.contains("uses '..'") && s.contains("NOT started"), "{}", s),
            None    => panic!("a brief naming a '..' path was passed"),
        }
    }

    #[test]
    fn unreachable_paths_are_refused() {
        let reach = Reach { attached: strings(&["docs"]), read_only: strings(&["ref"]),
            ..Default::default() };
        let task = "Read `.daimond/rules/agents.md` first, then ../secrets/key.txt.\n\
            Write your findings to `ref/out.md`, and save it to `src/new.rs` as well.";
        let said = match judge(task, &ctx(), &dia(), &reach) {
            Some(s) => s,
            None    => panic!("passed"),
        };
        assert!(said.starts_with("Refused: the worker was NOT started"), "{}", said);
        for (path, why) in [
            (".daimond/rules/agents.md",    "inside Daimond's own directory"),
            ("../secrets/key.txt",          "uses '..'"),
        ] {
            assert!(said.contains(&fmt!("'{}': ", path)), "{} unnamed in: {}", path, said);
            assert!(said.contains(why), "no '{}' in: {}", why, said);
        }
        // A read-only place named to be written is not refused here: a brief is judged for reading
        // only (lead ruling, 16 Oct 2026), and the worker's fence refuses the write itself.
        // Reading is free (`ToolContext::may_read`), so neither is a place outside the marks.
        for p in ["ref/out.md", "src/new.rs"] {
            assert!(!said.contains(&fmt!("'{}'", p)), "{} refused in: {}", p, said);
        }
        assert!(said.contains("Rewrite the brief without them"), "{}", said);
    }

    #[test]
    fn ordinary_paths_pass() {
        let reach = Reach { attached: strings(&["docs", "src"]), read_only: strings(&["ref"]),
            ..Default::default() };
        let task = fmt!("Read `docs/plan.md` and src/main.rs, and look in `docs/` and ./docs/old.md.\n\
            Then write the summary to `docs/summary.md` and to diamonds/{}/notes.md.\n\
            Do not edit `ref/a.md`; write a summary of `ref/b.md`, and file_read 'ref/c.md'.\n\
            Use .gitignore and the starter `.daimond/starters/crystal.html`.", DIA);
        let named = brief_paths(&task);
        assert!(named.len() >= 9, "{:?}", named);
        for p in ["docs/summary.md", "ref/a.md", "ref/b.md", "ref/c.md"] {
            assert!(named.iter().any(|n| n == p), "{} unnamed in {:?}", p, named);
        }
        assert_eq!(None, judge(&task, &ctx(), &dia(), &reach));
        // And no path at all is never refused.
        assert_eq!(None, judge("Find out why the build is slow and say so.", &ctx(), &dia(), &reach));
    }

    /// QA1: a folder the worker may walk (WALK: list/search/glob start where a grant lies
    /// beneath) is a folder it can use, so a brief naming it must not refuse the spawn (D4).
    #[test]
    fn qa1_a_brief_naming_a_walkable_folder_is_not_refused() {
        let mut fence = ctx();
        fence.no_write = fence_of(&dia(), &Reach::default()).0;
        for (folder, task) in [
            (".daimond/starters", "Fork the starter page you will find in `.daimond/starters/`."),
            (".daimond/skills/pickup", "Follow the skill in `.daimond/skills/pickup/` exactly."),
        ] {
            assert!(fence.may_walk(folder), "the worker may list/search {}", folder);
            assert_eq!(None, judge(task, &ctx(), &dia(), &Reach::default()), "{}", task);
        }
    }


    /// QC1: the walk widening passes folders only; files beside the grants are still refused.
    #[test]
    fn qc1_the_brief_still_refuses_files_beside_the_grants() {
        let mut fence = ctx();
        fence.no_write = fence_of(&dia(), &Reach::default()).0;
        for ok in [".daimond", ".daimond/skills", ".daimond/skills/pickup/", "./.daimond/starters"] {
            assert!(unreachable(&[ok.to_string()], &fence).is_empty(), "{} was refused", ok);
        }
        for bad in [".daimond/skills/README.md", ".daimond/skills/pickup/notes.md",
                    ".daimond/config.jdat", ".daimond/skills/README", ".daimond/starters/other.html",
                    ".daimond/skills/pickup/../../config.jdat"] {
            assert_eq!(1, unreachable(&[bad.to_string()], &fence).len(), "{} passed", bad);
        }
    }
    #[test]
    fn urls_and_prose_pass() {
        let task = "See https://example.com/a/b.html, www.x.org/y/z.html and mailto:a@b.c.\n\
            Pick and/or compare Ore/Scion on 16/10/2026 at 1/2 speed, e.g. TCP/IP... (label+value).\n\
            Run `/usr/bin/python3` on ~/notes/x.md and /etc/hosts, at 10² or 2×, and \"as\":\"image\".\n\
            ```\n.cmp{display:grid} ../../x.css `.daimond/a.md`\n```\n\
            And the starter's 'quoted words here' stay prose.";
        assert_eq!(brief_paths(task), Vec::<String>::new());
        assert_eq!(None, judge(task, &ctx(), &dia(), &Reach::default()));
    }

    /// The conductor here is a chat whose own app passes everything; its worker is held to the
    /// chat's workspace, and that is the fence the brief meets.
    #[test]
    fn unscoped_chat_target_uses_the_chats_fence() {
        let mut conductor = ctx();
        let holds = vec![Hold { r: fmt!("r1"), path: fmt!("notes"), ws: true, read: false }];
        conductor.live = Some(Live::Chat(fmt!("c1"), holds));
        assert!(conductor.may_read(".daimond/rules/agents.md"), "the conductor is unscoped");
        let target = match target_of(&conductor) {
            Some(t) => t,
            None    => panic!("no target"),
        };
        assert_eq!("chat:c1", target_word(&target));
        let reach = Reach::of_chat(strings(&["notes"]), strings(&["later"]));
        match judge("Follow `.daimond/rules/agents.md`.", &conductor, &target, &reach) {
            Some(s) => assert!(s.contains("inside Daimond's own directory"), "{}", s),
            None    => panic!("the chat's fence was not the one judged"),
        }
        let fine = fmt!("Write the report to `notes/out.md` and draft in `{}/draft.md`.",
            chat_scratch("c1"));
        assert_eq!(None, judge(&fine, &conductor, &target, &reach));
        // A turn acting for a Diamond, with no marks in hand, sends its worker to that Diamond.
        let mut daimon = ctx();
        daimon.daimon_of = fmt!("{}", DIA);
        assert_eq!(Some(dia()), target_of(&daimon));
        assert_eq!(None, target_of(&ctx()));
    }

    #[tokio::test]
    async fn unread_record_refuses_the_spawn() {
        let mut c = ctx();
        c.live = Some(dia());
        match at_dispatch("Read `docs/a.md`.", &c).await {
            Some(s) => {
                // Its own sentence: no write-and-delete clause lifted from the file tools'
                // refusal, and no capital letter after "because".
                assert!(s.contains(SPAWN_UNREAD) && s.contains("NOT started"), "{}", s);
                assert!(!s.contains(UNREAD) && !s.contains("write or delete"), "{}", s);
                assert!(s.contains("because this device's record"), "{}", s);
            },
            None    => panic!("a record that cannot be read let the spawn go"),
        }
        assert_eq!(None, at_dispatch("Read `docs/a.md`.", &ctx()).await);
    }

    /// The lift changed nothing: for three scopes, the bounds and the waiting marks the exports
    /// built inline before it are the ones [`worker_fence`] builds now.
    #[test]
    fn worker_fence_equals_the_exports_before_the_lift() {
        // A Diamond with places, a read-only mark, a nested one, toolkits and a mark waiting.
        let reach = Reach { attached: strings(&["docs", "b.md"]), read_only: strings(&["ref"]),
            unconfirmed: strings(&["away"]), nested: strings(&["docs/inner"]) };
        let kits = strings(&["rust", "node"]);
        let id = match DiamondId::parse(DIA) {
            Ok(id) => id,
            Err(e) => panic!("{}", e),
        };
        let mut before = diamond_bounds(&id.dir(), &reach.places(), &reach.read_only);
        before.extend(toolkit_bounds(&kits));
        let after = fence_of(&Live::Diamond(id.clone(), kits.clone()), &reach);
        assert_eq!((before, reach.unconfirmed.clone()), after);
        // A chat with its workspace and a hold waiting for a press.
        let (ws, wait) = (strings(&["notes", "x/y.md"]), strings(&["later"]));
        let before = (chat_bounds(&chat_scratch("c1"), &ws, &[]), wait.clone());
        let after = fence_of(&Live::Chat(fmt!("c1"), Vec::new()), &Reach::of_chat(ws, wait));
        assert_eq!(before, after);
        assert!(!after.0.iter().any(|b| matches!(b, Bound::Toolkit(_))), "a chat got a toolkit");
        // A scope that names nowhere stays nowhere.
        let mut before = diamond_bounds("", &[], &[]);
        before.extend(toolkit_bounds(&[]));
        assert_eq!((before, Vec::new()), worker_fence("", &Reach::default(), Some(&[])));
    }
}
