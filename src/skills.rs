//! Skills — named instruction bundles the agent can invoke.
//!
//! A skill takes one of two shapes, and both are skills in every other respect — same
//! frontmatter, same name resolution, same invocation:
//!
//! ```text
//! .daimond/skills/<name>.md            a skill that is only instructions
//! .daimond/skills/<name>/SKILL.md      a skill that also ships files
//!            .../references/…      documents it reads
//!            .../scripts/…         executable code it runs
//! ```
//!
//! The directory form exists because a skill worth sharing is rarely only prose: it quotes a
//! reference document, or it runs a script.  A directory that holds no `SKILL.md` is not a skill;
//! it is someone's notes, and it is skipped rather than complained about.
//!
//! The frontmatter is a light YAML-ish block:
//!
//! ```text
//! ---
//! name: review
//! description: Review a diff for bugs
//! uses: [file_read]
//! ---
//! <the markdown instruction body...>
//! ```
//!
//! Skills are invoked two ways, and both end in the same place -- the file's text in front of the
//! model before the turn starts, rather than an instruction to the model to go and read it.
//!
//! The first is a slash command, `/name the rest of the message`, which is what a person types.
//! It is resolved by [`parse_command`] against the directories [`command_dirs`] names, and a name
//! that resolves to no file is REFUSED rather than sent on as ordinary chat: a user who types
//! `/pickup` and gets a plausible answer that skipped the workflow has no way to tell.
//!
//! The second is an angle-tag directive
//! `<name args...>`, optionally closed with `</name>` or a bare `</>`.
//! Parsing is deliberately tolerant (plan D9): only the *opening* tag is
//! terminated by `>`, so a `>` inside the body — such as `Vec<T>` or
//! `->` — is safe and does not end the directive.  A missing `>` on the
//! opening tag recovers to end-of-line, and a missing closing tag
//! recovers to end-of-message.

use oxedyne_fe2o3_core::prelude::*;

use crate::tools::Tool;
use crate::workspace::Workspace;

use std::path::Path;


/// A named instruction bundle, which may also ship the files it works from.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Skill {
    /// The skill's invocation name (frontmatter `name`, or the file/directory stem).
    pub name:        String,
    /// One-line description for autocomplete and listings.
    pub description: String,
    /// The tools this skill says it needs, from the frontmatter `uses` line. `None` means it
    /// declared nothing and runs with whatever the agent already holds.
    ///
    /// A skill is instructions, so its power is the agent's power: whatever the agent can do, a
    /// skill can tell it to do. Declaring the tools it needs is therefore the only thing that
    /// bounds it, and the bound is real rather than advisory -- the turn runs against a registry
    /// narrowed to the declared set, so a skill that asked for `file_read` cannot send mail,
    /// cannot spawn an agent and cannot drive a logged-in browser, whatever its text says and
    /// however cleverly it says it. The model is not even offered the others.
    ///
    /// Undeclared is unrestricted, which is right for a skill the user wrote themselves and wrong
    /// for one that arrived from a stranger. When skills can be imported, an imported one without
    /// this line must be refused: a skill unwilling to say what it needs has said something.
    pub uses:        Option<Vec<String>>,
    /// The markdown instruction body (everything after the frontmatter).
    pub body:        String,
    /// The skill's own directory, workspace-relative (`.daimond/skills/<dir>`), for the directory form.
    /// `None` for a single-file skill, which ships nothing and so has nowhere of its own.
    pub dir:         Option<String>,
    /// The executable code the skill ships under its `scripts/` directory, workspace-relative and
    /// sorted. Shipping any is a request for `shell`, and [`undeclared_script`](Skill::undeclared_script)
    /// is where that request is made to show itself.
    pub scripts:     Vec<String>,
}

impl Skill {

    /// A script this skill ships without having declared the tool that would run it, if any.
    ///
    /// A skill that ships a script and expects it to be run is asking for `shell`, and the user
    /// deserves to see that in the declaration rather than discover it when the script runs. So a
    /// shipped script with no `shell` in `uses` is not quietly narrowed away -- it is refused, and
    /// said out loud. Silence here is not a smaller request; it is an undisclosed one, and a skill
    /// unwilling to say what it needs has said something.
    pub fn undeclared_script(&self) -> Option<&str> {
        let script = match self.scripts.first() {
            Some(s) => s.as_str(),
            None    => return None,     // ships no code, so has nothing to disclose
        };
        let declared = match &self.uses {
            Some(names) => names.iter().any(|n| n == Tool::Shell.name()),
            None        => false,       // declaring nothing is not declaring shell
        };
        if declared { None } else { Some(script) }
    }
}

/// What expanding a message produced: the text the model will see, and the skills that were
/// injected into it, so the caller can bound the turn by what they declared.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Expansion {
    /// The message, with any skill's instructions injected.
    pub text:    String,
    /// The skills that were injected. Empty when the message invoked none.
    pub invoked: Vec<Skill>,
    /// Why the invoked skill was refused rather than injected, if it was.
    ///
    /// A refusal leaves `invoked` empty and puts the refusal in `text` as well as here, so a
    /// caller that forgets to look at this field still cannot run the skill: the failure mode is
    /// the skill not running, never the skill running unannounced.
    pub refused: Option<String>,
}

impl Expansion {

    /// The tool names this expansion permits, or `None` when nothing was declared and the turn
    /// runs unrestricted.
    ///
    /// A skill that declares nothing contributes everything, so declaring narrows and staying
    /// silent does not. Where several skills are injected, each needs what it needs, so the
    /// permitted set is their union -- and the caller intersects that with the tools the agent
    /// actually holds, since a skill cannot conjure a tool the agent was never given.
    pub fn declared_tools(&self) -> Option<Vec<String>> {
        if self.invoked.is_empty() {
            return None;
        }
        let mut union: Vec<String> = Vec::new();
        for skill in &self.invoked {
            match &skill.uses {
                None => return None,        // one silent skill and the turn is unrestricted
                Some(names) => {
                    for n in names {
                        if !union.contains(n) {
                            union.push(n.clone());
                        }
                    }
                },
            }
        }
        Some(union)
    }

    /// The directories of the skills injected here, workspace-relative.
    ///
    /// These are the places a bounded turn may always read, whatever it declared: a skill's
    /// `references/` are part of the skill, and refusing it access to its own shipped documents
    /// would make shipping them pointless. Reading only -- writing there is what the lockout is
    /// for. See [`crate::tools::skill_bounds`].
    pub fn skill_dirs(&self) -> Vec<String> {
        self.invoked.iter().filter_map(|s| s.dir.clone()).collect()
    }
}

/// A parsed chat invocation of a skill directive.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SkillInvocation {
    /// The skill name from the opening tag.
    pub name: String,
    /// The remainder of the opening tag after the name, trimmed.
    pub args: String,
    /// The directive body between the opening and closing tags.
    pub body: String,
}


/// True if `c` is a legal character in a skill name / tag identifier.
fn is_ident(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '-'
}
// The workspace-relative directory skills are stored in.
/// The workspace-relative directory skills are stored in.
// The same two strings the fence is written against, and never a second spelling of
// them: `tools::is_skills_disclosure` decides what a fenced turn may read here, and a
// module that carried its own copy could drift into naming a directory the fence does
// not know about -- a skill loader and a fence disagreeing about where skills live is
// the one disagreement neither of them can detect.
use crate::tools::{SKILLS_DIR as SKILLS_DIR_SLASH, SKILL_MANIFEST as SKILL_FILE};

/// The skills directory without its trailing separator, which is how every path in this
/// module is composed.
fn skills_dir() -> &'static str { SKILLS_DIR_SLASH.trim_end_matches('/') }


/// The subdirectory of a skill directory that holds executable code.
const SCRIPTS_DIR: &str = "scripts";

/// The file that names any FURTHER directories a `/name` command should look in, one
/// workspace-relative directory per line.  Absent is the ordinary case and means the only place
/// searched is [`skills_dir`].
///
/// This file exists because two facts pull against each other.  A person who has been typing
/// `/pickup` for months keeps their skills wherever they already keep them, and copying every one
/// of them into a second directory before the app will honour a command it told them to type is
/// not a fix.  But the layout of one person's home directory is not a fact about Daimond, and a
/// build that carries it publishes where its author keeps their files -- `src/` is carved into a
/// public mirror.  So the search path is *data in the workspace*, not a constant in the binary:
/// the shipped artefact is identical for everybody, and the person with the directories writes one
/// short file naming them.
///
/// It sits under `.daimond/`, which the file tools refuse to write ([`crate::tools::DAIMOND_DIR`]),
/// and that placement is load-bearing rather than tidy.  A skill is injected verbatim as the user
/// speaking, so whoever controls the search path controls what counts as the user's own words: a
/// model able to add a directory here could point the resolver at content it had downloaded and
/// have it trusted.  The search path is the user's to set and nobody else's.
pub const SEARCH_PATH_FILE: &str = ".daimond/skills.path";

/// The most directories the search path may add.
///
/// Every directory costs two file reads on every slash command, including the ones that resolve to
/// nothing, so an unbounded list turns a mistyped `/pickpu` into an unbounded number of reads.
/// Eight is far past what a person keeps and small enough that the worst case is unremarkable.
const MAX_SEARCH_DIRS: usize = 8;

/// Read [`SEARCH_PATH_FILE`]'s text into the extra directories a `/name` should be looked for in.
///
/// One workspace-relative directory per line.  Blank lines and lines beginning `#` are comments.
/// An entry is DROPPED, rather than the file rejected, when it is absolute, names a `..` or `.`
/// component, or repeats one already listed -- a typo in a preferences file should cost the user
/// the line they got wrong and nothing else.  Refusing the escapes here is the same rule
/// [`command_paths`] applies to the skill name: nothing in this path may reach outside the
/// workspace.
///
/// # Arguments
/// * `text` - The file's whole text.
pub fn parse_search_path(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for line in text.lines() {
        let dir = line.trim().trim_end_matches('/');
        if dir.is_empty() || dir.starts_with('#') {
            continue;                                   // blank, or a comment
        }
        if dir.starts_with('/') || dir.starts_with('~') || dir.starts_with('\\') {
            continue;                                   // not workspace-relative
        }
        if dir.split('/').any(|seg| seg == ".." || seg == "." || seg.is_empty()) {
            continue;                                   // reaches out, or is not a path at all
        }
        if dir == skills_dir() || out.iter().any(|d| d == dir) {
            continue;                                   // already searched
        }
        out.push(dir.to_string());
        if out.len() >= MAX_SEARCH_DIRS {
            break;
        }
    }
    out
}

/// The directories a `/name` command looks in, in order, each workspace-relative.
///
/// Daimond's own is always first and is the one [`list_skills`] walks, so a skill Daimond created
/// is never shadowed by one it did not.  Whatever the workspace's [`SEARCH_PATH_FILE`] added
/// follows, in the order it named them.
///
/// # Arguments
/// * `extra` - The directories from [`parse_search_path`], or an empty slice.
pub fn command_dirs(extra: &[String]) -> Vec<String> {
    let mut out = Vec::with_capacity(1 + extra.len());
    out.push(skills_dir().to_string());
    out.extend(extra.iter().cloned());
    out
}


/// A slash command the user typed: `/name` and everything after it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Command {
    /// The skill's name, from the leading token.
    pub name: String,
    /// The rest of the message, trimmed.  Empty when the command was typed on its own.
    pub args: String,
}

/// Read a leading `/name` slash command out of a message, or `None` where there is none.
///
/// The name must be a whole token: a message beginning `/home/u/notes` is a path the user typed,
/// and reading it as a command would refuse an ordinary message that was never one -- which is a
/// worse failure than missing a command, because the user's words are then thrown away.
///
/// # Arguments
/// * `input` - The message exactly as the user typed it.
pub fn parse_command(input: &str) -> Option<Command> {
    let rest = match input.trim_start().strip_prefix('/') {
        Some(r) => r,
        None    => return None,
    };
    let len = rest.find(|c: char| !is_ident(c)).unwrap_or(rest.len());
    if len == 0 {
        return None;                            // a bare `/`, or `//…`
    }
    match rest[len..].chars().next() {
        Some(c) if !c.is_whitespace() => return None,   // `/home/u`, `/v1.2` — not a command
        _ => {},
    }
    Some(Command {
        name: rest[..len].to_string(),
        args: rest[len..].trim().to_string(),
    })
}

/// Every file a `/name` command could mean, workspace-relative and in the order to try them.
///
/// Both skill forms in every directory: `<dir>/<name>/SKILL.md` for a skill that ships files, and
/// `<dir>/<name>.md` for one that is only instructions.  An empty vector for a name that is not a
/// bare identifier, so a caller that did not come through [`parse_command`] cannot reach out of the
/// skills directories with one.
///
/// # Arguments
/// * `name` - The skill's name, as typed after the slash.
/// * `extra` - Any further directories from the workspace's [`SEARCH_PATH_FILE`].
pub fn command_paths(name: &str, extra: &[String]) -> Vec<String> {
    if name.is_empty() || !name.chars().all(is_ident) {
        return Vec::new();
    }
    let dirs = command_dirs(extra);
    let mut out = Vec::with_capacity(dirs.len() * 2);
    for dir in &dirs {
        out.push(fmt!("{}/{}/{}", dir, name, SKILL_FILE));
        out.push(fmt!("{}/{}.md", dir, name));
    }
    out
}

/// What the model is sent when a `/name` resolved: the skill's instructions, named, then whatever
/// else the user typed.
///
/// The file it came from is named in the text rather than only in the app, so the model can say
/// which instructions it is following and the user can catch it following the wrong ones.  That is
/// the whole failure this replaces: a skill silently not read looks exactly like a skill read.
///
/// # Arguments
/// * `name` - The skill's name.
/// * `path` - The file it was read from, workspace-relative.
/// * `body` - The instruction body, frontmatter already stripped.
/// * `args` - The rest of the user's message.
pub fn compose_command(name: &str, path: &str, body: &str, args: &str) -> String {
    let mut s = fmt!("Skill '{}', from '{}':\n\n{}", name, path, body.trim());
    if !args.trim().is_empty() {
        s.push_str(&fmt!("\n\nUser request: {}", args.trim()));
    }
    s
}

/// What the user is told when they invoked a skill that is not there.
///
/// It says that nothing ran, first, because that is the part they cannot otherwise find out: a
/// `/name` quietly passed on as ordinary chat produces a perfectly plausible answer that skipped
/// the workflow, and the user believes the workflow ran.
///
/// The directories are the ones actually searched, passed in rather than assumed, so a user who
/// has added their own through [`SEARCH_PATH_FILE`] is told about those too -- and one who has
/// added a directory that is not being searched can see that from the same sentence.
///
/// # Arguments
/// * `name` - The name they typed after the slash.
/// * `dirs` - The directories that were searched, workspace-relative.
pub fn no_such_skill(name: &str, dirs: &[String]) -> String {
    fmt!(
        "There is no skill called '{}', so nothing ran -- this message was not sent to the model. \
        Daimond looked for '{}/SKILL.md' and '{}.md' under each of {}, in your workspace and in \
        Daimond's own storage. Write one of those files, name another directory in '{}', or send \
        the message again without the leading slash.",
        name, name, name, dirs.join(", "), SEARCH_PATH_FILE)
}


// ┌───────────────────────────────────────────────────────────────────────────┐
// │ A DAIMON DRAFTS; THE OWNER INSTALLS                                        │
// └───────────────────────────────────────────────────────────────────────────┘
//
// `.daimond/` is a denied subtree and stays one.  It holds the standing instructions, and
// the thing that makes a skill worth obeying is that it came from the person: anything that
// can write there can rewrite the rules it is judged by.  So the boundary is not moved --
// what is added is the half that was missing on the other side of it.
//
// A daimon writes a DRAFT with the file tools it already has, into
// `<its own folder>/skill-drafts/<name>.md`.  That directory was chosen for three reasons
// and each is a property nothing else here has:
//
// * **It is the one place every turn may write.**  A chat's own folder is `chats/<id>/work`
//   and a Diamond's is `diamonds/<id>`, and both are always in the write allow-list -- see
//   `tools::tests::test_a_daimon_always_has_its_own_directory_00`.  No attachment is needed
//   and no permission is asked for.
// * **It survives the tab.**  A draft held in the page's memory dies on reload, which is
//   what `Pending`'s own comment says of a consent promise.  A file does not.
// * **It belongs to the conversation that produced it**, so the person meets the draft where
//   they were already looking rather than in a directory they have to go and find.
//
// The install is the person's, in one tap, and it follows `social_send`'s shape rather than
// inventing a second: the draft's exact bytes are put on the screen, the person answers, and
// what is written is what they were shown.  Nothing is remembered -- there is no "always
// install drafts", because a standing yes to a class of writes into `.daimond/` is the
// boundary given away by another name.

/// The subdirectory of a turn's own folder a drafted skill is written into.
///
/// Named apart from `skills` because a folder called `skills` inside somebody's own working
/// directory is a folder they may already keep, and a listing that took every `.md` in it for
/// a pending draft would offer to install their notes.
pub const DRAFTS_DIR: &str = "skill-drafts";

/// Where a draft of `name` goes, for a turn whose own folder is `own`.
///
/// The empty string where either is unusable -- a turn with no folder of its own, or a name
/// that is not a bare identifier.  A caller that gets one has nowhere to write and should say
/// so rather than compose a path out of what it was given: `../../.daimond/skills/x` is a
/// perfectly good file name to somebody who is not checking.
///
/// # Arguments
/// * `own` - The turn's own folder, workspace-relative.
/// * `name` - The skill's name, as it would be typed after the slash.
pub fn draft_path(own: &str, name: &str) -> String {
    let own = own.trim().trim_end_matches('/');
    if own.is_empty() || !name_ok(name) {
        return String::new();
    }
    fmt!("{}/{}/{}.md", own, DRAFTS_DIR, name)
}

/// Where an INSTALLED skill of `name` lives, which is inside the denied subtree.
///
/// Composed here so the one place that writes it -- the page, at the person's tap -- spells
/// it the same way [`command_paths`] reads it.  Empty for a name that is not a bare
/// identifier, which is the whole of the guard: the person taps `Install` on a name, and a
/// name that could climb out of the skills directory must never reach the write.
///
/// # Arguments
/// * `name` - The skill's name, as it would be typed after the slash.
pub fn install_path(name: &str) -> String {
    if !name_ok(name) {
        return String::new();
    }
    fmt!("{}/{}.md", skills_dir(), name)
}

/// Is this a name a `/name` could reach, and nothing more?
///
/// The same rule [`command_paths`] applies, kept as one predicate so the resolver and the
/// installer cannot come to disagree about what a skill may be called.  Bounded in length as
/// well, because a name is a file name and the page draws it in a menu, and never one of
/// [`NOT_SKILLS`], so the index, the installer and the fenced read agree on what is a skill.
pub(crate) fn name_ok(name: &str) -> bool {
    !name.is_empty() && name.len() <= 48 && name.chars().all(is_ident)
        && !NOT_SKILLS.iter().any(|n| n.eq_ignore_ascii_case(name))
}

/// File names a skills folder may hold that are about the folder and not a skill: never offered,
/// installed, listed as installed or granted to a fenced read (WALK check D1).  A `README.md`
/// is the one a person actually keeps there; the rest are its usual company.
const NOT_SKILLS: &[&str] = &["README", "LICENSE", "LICENCE", "CHANGELOG", "CONTRIBUTING",
    "NOTICE", "SKILL"];

/// Is `file`, a name directly inside the skills directory, a flat skill's declaration -- the
/// `<name>.md` [`install_path`] writes, for a name [`name_ok`] allows?
///
/// # Arguments
/// * `file` - The entry's own name, with no folder.
pub(crate) fn is_flat_declaration(file: &str) -> bool {
    match file.strip_suffix(".md") {
        Some(stem) => name_ok(stem),
        None       => false,
    }
}

/// What a draft file must carry before it is worth offering to install, or `None` when it is.
///
/// Pure, and it is the whole of the policy: the page shows the person exactly these bytes and
/// then writes exactly these bytes, so everything that can be decided about a draft has to be
/// decided here, where a test can put the cases to it.
///
/// Three refusals, and each is a thing the person would otherwise find out afterwards.  A
/// draft with no frontmatter name resolves under its file's stem and the two can differ.  A
/// draft with no body is a command that runs and does nothing.  A draft whose frontmatter
/// names a DIFFERENT skill would install under one name and announce another.
///
/// # Arguments
/// * `name` - The name taken from the draft file's own stem.
/// * `text` - The draft file's whole text.
pub fn draft_refusal(name: &str, text: &str) -> Option<String> {
    if !name_ok(name) {
        return Some(fmt!(
            "'{}' is not a name a skill can have. A skill is reached by typing '/name', so the \
            name may hold letters, digits, '-' and '_' and nothing else.",
            name.chars().take(48).collect::<String>()));
    }
    let sk = parse_skill(text, name);
    if sk.body.trim().is_empty() {
        return Some(fmt!(
            "The draft of '{}' has no instructions in it, only its heading. Installing it would \
            give you a command that runs and does nothing.", name));
    }
    if sk.name != name {
        return Some(fmt!(
            "The draft is filed as '{}' and its own frontmatter calls it '{}'. It would install \
            as one and announce itself as the other, so fix the 'name:' line or rename the file.",
            name, sk.name));
    }
    None
}


// ┌───────────────────────────────────────────────────────────────────────────┐
// │ THE SKILLS THAT ARE THERE BEFORE ANYBODY WRITES A FILE                     │
// └───────────────────────────────────────────────────────────────────────────┘
//
// A skill is a file, and every skill was somebody's file first.  That is right for the ones
// a person invents and wrong for the two that decide whether a day's work survives the tab:
// `/handover` and `/pickup` are the pair that turns an app which must be re-briefed every
// time into one that is already oriented, and until now a fresh workspace had neither, so
// the first thing anybody had to do was write them.  `dev/PARITY.md` §2.1 called that the
// cheapest large win in the document and costed it at two text files; what it did not say
// is where the two files come from.  Shipping them is where.
//
// Three rules hold the arrangement together:
//
// * **A file wins.**  [`resolve_skill`] takes what the workspace found and hands the shipped
//   text back only when the workspace found nothing, so writing `.daimond/skills/pickup.md`
//   replaces this one exactly as deleting `prompts/daimon.md` restores that default.  The
//   precedence is a named function rather than the order of two branches in an async wasm
//   path, because that ordering is the whole behaviour and nothing native could see it.
// * **They say where they came from.**  [`shipped_path`] is not a workspace path, because
//   there is no file there; `compose_command` puts it in front of the model, so a user
//   reading the turn can tell a shipped skill from their own and can see which one ran.
// * **They name actions.**  Measured on this codebase, a sentence that names an action
//   changes what a model does and a sentence that names a prohibition does not, so every
//   step below is a thing to do.  `test_no_step_of_a_shipped_skill_is_a_bare_prohibition`
//   is what keeps a later edit from drifting back into rules.

// `/handover`: write down where the work stands, in the Diamond's own folder, which is the
// one place a daimon may write and the one place that survives the tab.
const SHIPPED_HANDOVER: &str = "\
---\n\
name: handover\n\
description: Write down where the work stands, so the next session can carry it on.\n\
---\n\
\n\
# Handover\n\
\n\
Write a handover now, into this Diamond's own folder -- its path is named at the top of your \
instructions -- under `handover/`, as `<YYYY-MM-DD>-<nn>.md`. List that folder first and take \
the next free number for today, so a second handover on the same day sits beside the first \
rather than over it.\n\
\n\
Put these five sections in it, in this order, each carrying facts rather than a summary of \
them:\n\
\n\
1. Where the work stands: the objective, and how far it has got.\n\
2. What changed this session, each item naming the file it touched.\n\
3. What remains, each item naming the next action, in the order to do them.\n\
4. What is broken or unproven, and the command or check that would settle it.\n\
5. Read these first: every file the next session must open, in the order to open them, each \
with one line saying why.\n\
\n\
Take each fact from the work itself: open the file again rather than quoting it from memory, \
and where you are unsure of something, write that you are unsure of it.\n\
\n\
Then fold what the crystal is now missing into `crystal.json` -- the open threads especially -- \
and tell the user the handover's path in one line.\n\
\n\
In an ordinary chat there is no Diamond and no folder that outlives it, so say that the work \
wants a Diamond to be kept in, and write the same five sections into the reply instead.\n\
\n\
This skill ships with Daimond. Write your own at `.daimond/skills/handover.md` to replace it.\n";

// `/pickup`: read the last handover, check it against the tree, and carry on.  The order is
// the point: a handover believed rather than checked is how a session inherits a stale claim.
const SHIPPED_PICKUP: &str = "\
---\n\
name: pickup\n\
description: Read the last handover and carry the work on from where it stopped.\n\
---\n\
\n\
# Pickup\n\
\n\
Read these four things, in this order, before you say anything:\n\
\n\
1. List `handover/` in this Diamond's own folder -- its path is named at the top of your \
instructions -- and read the newest file in it, whole. Where the user named a topic after the \
command, read the newest one about that topic instead.\n\
2. Read this Diamond's `crystal.json`, which is already in front of you, against what the \
handover says.\n\
3. Open every file the handover's `Read these first` list names, in the order it names them.\n\
4. Check the handover against the tree: open what it says it changed, and run what it says \
would prove it. Where the two disagree, the tree is right.\n\
\n\
Then say in five lines or fewer where the work stands, what the handover got wrong, and the one \
thing you are doing next -- and do it.\n\
\n\
Where there is no `handover/` folder or nothing in it, say so, say what you can see instead -- \
the crystal, the folders attached to this Diamond -- and ask for the one thing you need to \
start. In an ordinary chat there is no Diamond to look in: say that, and ask which Diamond \
the work is kept in.\n\
\n\
This skill ships with Daimond. Write your own at `.daimond/skills/pickup.md` to replace it.\n";

// `/status`: where the work stands, against the crystal and the tree rather than against the
// transcript, in five lines the owner can read without asking a second question.
const SHIPPED_STATUS: &str = "\
---\n\
name: status\n\
description: Say where the work stands in five lines or fewer, and what it needs from you.\n\
---\n\
\n\
# Status\n\
\n\
Read three things before you answer, in this order:\n\
\n\
1. This Diamond's `crystal.json`, which is already in front of you. Take the goal from it, and \
take the open threads, which are the work that is not finished.\n\
2. The newest file in `handover/` in this Diamond's own folder -- its path is named at the top \
of your instructions -- where there is one, for what the last session said it was doing.\n\
3. The tree itself: open what the crystal or the handover says was changed, and run whatever \
would prove it. Where the two disagree, the tree is right.\n\
\n\
Then answer in five lines or fewer, in this shape:\n\
\n\
1. The objective, and how far it has actually got.\n\
2. What changed since the last handover, taken from the files rather than from memory.\n\
3. What is running now, or the word `idle`.\n\
4. The single next action you recommend, in one line.\n\
5. A last line reading `Required from you:` and then the thing you really need -- an approval, \
a choice, a file -- or `nothing`, and what you are proceeding with instead.\n\
\n\
Quote a number you have measured, and write `unmeasured` beside one you worked out by eye.\n\
\n\
In an ordinary chat there is no Diamond and no crystal, so say what you can see instead -- this \
conversation, the folders attached to it -- and give the same five lines from that.\n\
\n\
This skill ships with Daimond. Write your own at `.daimond/skills/status.md` to replace it.\n";

// `/decisions`: one question at a time, each with an example, a pick and the reason for the pick.
// The order is what makes it answerable in one tap: a menu with no recommendation hands the work
// back to the person who asked for it.
const SHIPPED_DECISIONS: &str = "\
---\n\
name: decisions\n\
description: Put each open decision to the user one at a time, with a recommendation and its reason.\n\
---\n\
\n\
# Decisions\n\
\n\
Gather the decisions this work is really waiting on. Take them from this Diamond's `crystal.json` \
open threads, from the newest file in `handover/` in this Diamond's own folder, and from what you \
have just found in the tree -- a question you had to guess the answer to is a decision.\n\
\n\
Put them ONE AT A TIME, and put each one with the `ask` tool rather than in prose. It draws \
your options as buttons, so the answer costs one tap -- and a decision answered by typing is a \
decision put off. Its fields ARE these five things, and it refuses a call missing any of them:\n\
\n\
1. `question` -- the decision in one sentence of plain words, naming the thing it decides.\n\
2. A concrete example of what each answer would mean -- what the user would see, or get, or \
pay -- rather than the name of a category. Two to four of them go in `options`; each carries a \
`means`, which is that example and the trade-off it brings, and a `label`, the words on its \
button.\n\
3. Your recommendation, named as one of the options: `recommend`, matching a label exactly.\n\
4. The reason for it in one sentence, in the user's own terms -- their constraint, their cost, \
their users -- as `why`; and `if_silent`, which is what you will do if they answer nothing.\n\
5. `Decision 1 of N` is `n` and `of`, so the user can see how many follow.\n\
\n\
Your turn ENDS when you call it. Do not restate the question in prose underneath the card. The \
answer arrives as their next message: `Chose:` and the label they tapped, or `Other:` and words \
of their own, which may reject every option you offered -- that is the answer, so take it.\n\
\n\
Where this page cannot draw a card the tool says so, and you ask in prose instead, with the \
same five things.\n\
\n\
Take the answer, record it under the crystal's decisions with the reason the user gave, and go \
on to the next one.\n\
\n\
Where a decision is yours to make -- the work has an obvious answer and being wrong is cheap -- \
make it, say in one line that you did and why, and keep it off this list.\n\
\n\
Where you find nothing open, say so in one line and name the next action you would take instead.\n\
\n\
In an ordinary chat there is no Diamond and no crystal, so take the decisions from this \
conversation and from the files attached to it, and put them the same way.\n\
\n\
This skill ships with Daimond. Write your own at `.daimond/skills/decisions.md` to replace it.\n";

// Every skill this build carries, by the name typed after the slash.
//
// Four, and each is here for one reason: it is a thing the owner types at a session every day
// and could not type at Daimond.  `/handover` and `/pickup` are the pair that decides whether a
// day's work survives the tab; `/status` and `/decisions` are the two he asks for most often
// while the work is still running -- where does this stand, and what do you need from me.  A
// shipped skill is text the user did not write standing where their own words stand, so a fifth
// is a decision rather than a convenience, and the test of it is the same: it has to be
// something that must already exist before the day's work can start.
pub const SHIPPED: &[(&str, &str)] = &[
    ("handover",  SHIPPED_HANDOVER),
    ("pickup",    SHIPPED_PICKUP),
    ("status",    SHIPPED_STATUS),
    ("decisions", SHIPPED_DECISIONS),
];

/// The text of the skill this build ships under `name`, or `None` where it ships none.
///
/// # Arguments
/// * `name` - The skill's name, as typed after the slash.
pub fn shipped(name: &str) -> Option<&'static str> {
    SHIPPED.iter().find(|(n, _)| *n == name).map(|(_, text)| *text)
}

/// Every shipped skill's name, in the order the table holds them.
///
/// The `/` menu draws from this, so a name here that [`shipped`] does not answer for would be
/// a menu entry that refuses the turn it offers.
pub fn shipped_names() -> Vec<String> {
    SHIPPED.iter().map(|(n, _)| n.to_string()).collect()
}

/// Where a shipped skill came from, for the line `compose_command` puts in front of the model.
///
/// Deliberately not a workspace path: there is no file at one, and naming a path that does not
/// exist would send the user looking for it. The scheme says the build carries it, and the
/// skill's own last line says where to write the file that would replace it.
///
/// # Arguments
/// * `name` - The skill's name, as typed after the slash.
pub fn shipped_path(name: &str) -> String {
    fmt!("daimond:skills/{}.md", name)
}

/// Which of the two possible skills a `/name` means: the workspace's, or the shipped one.
///
/// **A file wins, always.** The workspace copy is the user's own words and the shipped one is
/// this build's, so a person who has written `.daimond/skills/pickup.md` must get theirs --
/// the same rule `prompts/<role>.md` follows, where deleting the file is how the default comes
/// back. Nothing merges: two sets of instructions for one command is the arrangement in which
/// neither is followed.
///
/// # Arguments
/// * `name` - The skill's name, as typed after the slash.
/// * `found` - What the workspace search turned up, as `(path, text)`, or `None`.
pub fn resolve_skill(name: &str, found: Option<(String, String)>) -> Option<(String, String)> {
    if let Some(pair) = found {
        return Some(pair);
    }
    shipped(name).map(|text| (shipped_path(name), text.to_string()))
}


/// The scripts a skill directory ships, workspace-relative and sorted.
///
/// Anything under `scripts/` counts, however deep: a skill that ships code ships code, whether it
/// sits at the top of the directory or three levels down.  A missing or unreadable `scripts/`
/// means the skill ships none.
///
/// # Arguments
/// * `abs` - The skill directory's absolute path.
/// * `rel` - The same directory, workspace-relative, for the paths that come back.
fn list_scripts(abs: &Path, rel: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack = vec![(abs.join(SCRIPTS_DIR), fmt!("{}/{}", rel, SCRIPTS_DIR))];
    while let Some((dir, dir_rel)) = stack.pop() {
        let rd = match std::fs::read_dir(&dir) {
            Ok(r)  => r,
            Err(_) => continue,     // no scripts/ here, so nothing is shipped from it
        };
        for ent in rd.filter_map(|e| e.ok()) {
            let name  = ent.file_name().to_string_lossy().to_string();
            let child = fmt!("{}/{}", dir_rel, name);
            if ent.path().is_dir() {
                stack.push((ent.path(), child));
            } else {
                out.push(child);
            }
        }
    }
    out.sort();
    out
}

/// List every skill in the workspace's `.daimond/skills` directory, in both forms.
///
/// A `*.md` file is a skill.  A directory holding a `SKILL.md` is a skill, and the files beside it
/// travel with it.  A directory holding no `SKILL.md` is not a skill: it is skipped, not an error,
/// because a workspace is the user's and they may keep whatever they like in it.
///
/// Returns an empty vector (not an error) when the skills directory does not exist.  Unreadable
/// files are skipped.  Results are sorted by name, a directory skill ahead of a file skill of the
/// same name -- the one that ships files is the one that wins the name.
pub fn list_skills(ws: &Workspace)
    -> Outcome<Vec<Skill>>
{
    let dir = res!(ws.resolve(skills_dir()));
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let rd = res!(std::fs::read_dir(&dir)
        .map_err(|e| err!(e, "list_skills: cannot read '{}'.", skills_dir(); IO, File, Read)));
    let mut out = Vec::new();
    for ent in rd.filter_map(|e| e.ok()) {
        let p = ent.path();
        if p.is_dir() {
            let stem = p.file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            // The SKILL.md is what makes the directory a skill; without it, this is not one.
            let text = match std::fs::read_to_string(p.join(SKILL_FILE)) {
                Ok(t)  => t,
                Err(_) => continue,
            };
            let rel = fmt!("{}/{}", skills_dir(), stem);
            let mut skill = parse_skill(&text, &stem);
            skill.scripts = list_scripts(&p, &rel);
            skill.dir     = Some(rel);
            out.push(skill);
        } else if p.extension().and_then(|e| e.to_str()) == Some("md") {
            let stem = p.file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            // A `README.md` is about the folder, and a name no `/name` could reach is no skill:
            // the index names what the installer could have written, and nothing more.
            if !name_ok(&stem) {
                continue;
            }
            // Skip files we cannot read as UTF-8 text.
            let text = match std::fs::read_to_string(&p) {
                Ok(t)  => t,
                Err(_) => continue,
            };
            out.push(parse_skill(&text, &stem));
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name).then(a.dir.is_none().cmp(&b.dir.is_none())));
    Ok(out)
}

/// Load a single skill by name, or `None` if no such skill exists.
pub fn load_skill(ws: &Workspace, name: &str)
    -> Outcome<Option<Skill>>
{
    let skills = res!(list_skills(ws));
    for s in skills {
        if s.name == name {
            return Ok(Some(s));
        }
    }
    Ok(None)
}

/// Read a frontmatter `uses` line into tool names.
///
/// Written either as a list or as a plain series, because a person writing a skill should not have
/// to remember which:
///
/// ```text
/// uses: [file_read, file_write]
/// uses: file_read, file_write
/// uses: file_read file_write
/// ```
///
/// An empty declaration (`uses:` or `uses: []`) is not the same as no declaration at all: it says
/// the skill needs no tools, and the turn is run with none.
fn parse_uses(val: &str) -> Vec<String> {
    val.trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .split(|c: char| c == ',' || c.is_whitespace())
        .map(|s| s.trim().trim_matches(|c| c == '"' || c == '\''))
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect()
}

/// Parse a skill file's text into a [`Skill`], using `stem` as the fallback name when the
/// frontmatter omits `name`.
///
/// Public because the browser reads a skill file itself, through OPFS, rather than through
/// [`list_skills`]: `std::fs` compiles on wasm32 and fails at runtime, so the directory walk that
/// serves the native handler cannot serve the page.  The parse is the same either way, and that is
/// the point of sharing it -- two readers of one file format eventually disagree about it.
///
/// # Arguments
/// * `text` - The file's whole text, frontmatter included.
/// * `stem` - The file or directory name, used when the frontmatter names none.
pub fn parse_skill(text: &str, stem: &str) -> Skill {
    let mut name        = stem.to_string();
    let mut description = String::new();
    let mut uses:  Option<Vec<String>> = None;

    let lines: Vec<&str> = text.lines().collect();
    // Frontmatter must open with a `---` line at the very top.
    if !lines.is_empty() && lines[0].trim() == "---" {
        // Find the closing `---` line.
        let mut close = None;
        for (i, line) in lines.iter().enumerate().skip(1) {
            if line.trim() == "---" {
                close = Some(i);
                break;
            }
        }
        if let Some(j) = close {
            // Parse `key: value` pairs between the fences.
            for line in &lines[1..j] {
                if let Some((k, v)) = line.split_once(':') {
                    let key = k.trim();
                    let val = v.trim();
                    match key {
                        "name" => {
                            // Only override the stem when a value is present.
                            if !val.is_empty() {
                                name = val.to_string();
                            }
                        }
                        "description" => description = val.to_string(),
                        // Present but empty means "no tools", which is a declaration. Absent means
                        // no declaration, which is not the same thing.
                        "uses"        => uses = Some(parse_uses(val)),
                        _             => {}
                    }
                }
            }
            let body = lines[j + 1..].join("\n").trim().to_string();
            return Skill { name, description, uses, body, dir: None, scripts: Vec::new() };
        }
    }
    // No frontmatter — the whole file is the body.
    Skill {
        name,
        description,
        uses: None,
        body: text.trim().to_string(),
        dir: None,
        scripts: Vec::new(),
    }
}


/// Parse the first skill-directive opening tag in `input`.
///
/// Returns `None` when there is no plausible opening tag (a `<` followed
/// by an identifier character).  This is purely syntactic; matching the
/// name against real skills happens in [`expand`].
pub fn parse_invocation(input: &str) -> Option<SkillInvocation> {
    // Find the first `<` immediately followed by an identifier character.
    for (lt, _) in input.match_indices('<') {
        let name_start = lt + 1;
        let after = &input[name_start..];
        // The name is the leading run of identifier characters.
        let name_len = after
            .find(|c: char| !is_ident(c))
            .unwrap_or(after.len());
        if name_len == 0 {
            continue; // e.g. a closing `</...>` or a bare `<`.
        }
        let name = after[..name_len].to_string();
        let name_end = name_start + name_len;
        let rest = &input[name_end..]; // args, `>`, then the body.

        // Terminate the opening tag at the first `>`, unless a newline
        // comes first (a missing `>` recovers to end-of-line).
        let gt = rest.find('>');
        let nl = rest.find('\n');
        let (args, body_start) = match gt {
            Some(g) if nl.map_or(true, |n| g < n) => {
                // Normal case: opening tag closed by `>`.
                (rest[..g].trim().to_string(), name_end + g + 1)
            }
            _ => {
                // Missing `>`: recover to end-of-line (or end of input).
                match nl {
                    Some(n) => (rest[..n].trim().to_string(), name_end + n + 1),
                    None    => (rest.trim().to_string(), input.len()),
                }
            }
        };

        // The body runs to a matching `</name>` or bare `</>`, else to
        // the end of the input.
        let region = &input[body_start..];
        let close_named = fmt!("</{}>", name);
        let end_named   = region.find(&close_named);
        let end_bare    = region.find("</>");
        let end = match (end_named, end_bare) {
            (Some(a), Some(b)) => a.min(b),
            (Some(a), None)    => a,
            (None, Some(b))    => b,
            (None, None)       => region.len(),
        };
        let body = region[..end].trim().to_string();

        return Some(SkillInvocation { name, args, body });
    }
    None
}

/// Expand a chat message, injecting a matching skill's instructions.
///
/// If the message opens with a skill directive whose name resolves to a stored skill, the returned
/// text is the skill's instruction body followed by the user's supplied args/body.  Otherwise the
/// input is returned unchanged.
///
/// The skills that were injected come back with it, because what a skill declares it needs is the
/// only thing that bounds what it can make the agent do -- and the caller cannot honour a
/// declaration it was never told about.
///
/// This is also the one door a skill passes through on its way into a turn, so it is where a skill
/// that ships code without disclosing it is refused: the check cannot be forgotten by a caller,
/// because a caller who forgets it gets a refusal in `text` and no skill in `invoked`.
pub fn expand(input: &str, ws: &Workspace)
    -> Outcome<Expansion>
{
    if let Some(inv) = parse_invocation(input) {
        if let Some(skill) = res!(load_skill(ws, &inv.name)) {
            // A skill that ships a script is asking for `shell` whether or not it says so, and the
            // asking is the part the user must see. Refuse it rather than narrow it away: narrowing
            // would leave a skill whose instructions say "run the script" against a toolbelt that
            // cannot, which fails obscurely and teaches the author nothing.
            if let Some(script) = skill.undeclared_script() {
                let msg = fmt!(
                    "Refused: the skill '{}' ships a script ('{}') but does not declare the tool \
                    that runs it. A skill that ships code means it to be run, so it must say so: \
                    add 'shell' to its 'uses' line. Then you will see what it asked for before it \
                    runs, which is the whole point of the line.",
                    skill.name, script);
                return Ok(Expansion {
                    text:    msg.clone(),
                    invoked: Vec::new(),
                    refused: Some(msg),
                });
            }
            // Combine the invocation's args and body into one request.
            let mut request = inv.args.clone();
            if !inv.body.is_empty() {
                if !request.is_empty() {
                    request.push('\n');
                }
                request.push_str(&inv.body);
            }
            let composed = fmt!("{}\n\nUser request: {}", skill.body, request);
            return Ok(Expansion { text: composed, invoked: vec![skill], refused: None });
        }
    }
    Ok(Expansion { text: input.to_string(), invoked: Vec::new(), refused: None })
}


// ┌───────────────────────────────────────────────────────────────┐
// │ Tests                                                          │
// └───────────────────────────────────────────────────────────────┘

#[cfg(test)]
#[path = "../tests/unit/skills/tests.rs"]
mod tests;
