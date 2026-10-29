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
#[path = "../../../tests/unit/engine/worker/brief/tests.rs"]
mod tests;
