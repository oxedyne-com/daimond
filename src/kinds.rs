// Kinds of worker (KINDS-1, 8 Nov 2026): a file per kind under `.daimond/agents/`, in Claude Code's
// agent-file shape (name, description, model, effort, tools; the body is the kind's prompt), read
// from the user's own layer (Daimond's store) and the open folder's, the folder's winning by name.
// Claude Code's own `~/.claude*/agents` are never read: their models are Claude's (D-20261105-04).

use crate::{
    engine::host::{
        Host,
        fs::HostFs,
    },
    llm::Effort,
    skills::{
        frontmatter,
        parse_uses,
    },
    tools::{
        FileRoot,
        Tool,
        ToolContext,
    },
};

use oxedyne_fe2o3_core::prelude::*;

/// Where a layer keeps its kinds, relative to its root.  Under `.daimond/`, which the file tools
/// refuse to write, so a model cannot make itself a kind or change the model one runs on.
pub const KINDS_DIR: &str = ".daimond/agents";

#[derive(Clone, Debug, PartialEq)]
pub struct Kind {
    pub name:        String,
    pub description: String,
    pub provider:    String,                // empty: the provider the model resolves to
    pub model:       String,                // empty: the dispatching chat's worker model
    pub effort:      Option<Effort>,        // none: the model's own default
    pub tools:       Option<Vec<String>>,   // none: the worker's whole belt
    pub prompt:      String,
}

/// Read one kind file.  `stem` names it where the header does not.
pub fn parse(text: &str, stem: &str) -> Outcome<Kind> {
    let (pairs, prompt) = match frontmatter(text) {
        Some(f) => f,
        None    => return Err(err!("Kind file '{}.md' does not open with a '---' header naming \
            its model.", stem; Invalid, Input)),
    };
    let mut kind = Kind {
        name:        stem.to_string(),
        description: String::new(),
        provider:    String::new(),
        model:       String::new(),
        effort:      None,
        tools:       None,
        prompt,
    };
    for (key, val) in pairs {
        match key {
            "name" if !val.is_empty()   => kind.name = val.to_string(),
            "description"               => kind.description = val.to_string(),
            "provider"                  => kind.provider = val.to_string(),
            "model"                     => kind.model = val.to_string(),
            "effort" if !val.is_empty() => kind.effort = Some(res!(Effort::from_wire(val)
                .ok_or_else(|| err!("Kind '{}': effort '{}' is not one of low, medium, high, \
                    xhigh, max.", stem, val; Invalid, Input)))),
            "tools"                     => kind.tools = Some(parse_uses(val)),
            _                           => {}
        }
    }
    if kind.name.is_empty() || !kind.name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(err!("Kind file '{}.md' names itself '{}', which is not a plain name of \
            letters, digits, '-' and '_'.", stem, kind.name; Invalid, Input));
    }
    if let Some(tools) = &kind.tools {
        let unknown: Vec<&str> = tools.iter()
            .filter(|t| Tool::from_name(t).is_none())
            .map(|t| t.as_str())
            .collect();
        if !unknown.is_empty() {
            return Err(err!("Kind '{}': no tool is called {}.", kind.name,
                unknown.join(", "); Invalid, Input));
        }
    }
    Ok(kind)
}

/// The kinds in force, and the files that could not be read as one.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Kinds {
    pub found:  Vec<Kind>,                  // sorted by name
    pub faults: Vec<(String, String)>,      // (file stem, why)
}

impl Kinds {

    /// The user's own kinds, each replaced by the tree's of the same name.
    pub fn merge(user: Kinds, tree: Kinds) -> Kinds {
        let mut found = tree.found;
        for k in user.found {
            if !found.iter().any(|t| t.name == k.name) {
                found.push(k);
            }
        }
        found.sort_by(|a, b| a.name.cmp(&b.name));
        let mut faults = tree.faults;
        for f in user.faults {
            if !found.iter().any(|k| k.name == f.0) && !faults.iter().any(|t| t.0 == f.0) {
                faults.push(f);
            }
        }
        Kinds { found, faults }
    }

    pub fn is_empty(&self) -> bool { self.found.is_empty() }

    /// The kind `asked` names, or a refusal naming the kinds there are.
    pub fn resolve(&self, asked: &str) -> Outcome<&Kind> {
        if let Some(k) = self.found.iter().find(|k| k.name == asked) {
            return Ok(k);
        }
        if let Some((_, why)) = self.faults.iter().find(|f| f.0 == asked) {
            return Err(err!("spawn_agent: the kind '{}' could not be read, so no worker was \
                started: {}", asked, why; Invalid, Input));
        }
        let names: Vec<&str> = self.found.iter().map(|k| k.name.as_str()).collect();
        let there = match names.is_empty() {
            true    => fmt!("there are none; leave out 'kind' for an ordinary worker"),
            false   => fmt!("the kinds are {}; or leave out 'kind' for an ordinary worker",
                names.join(", ")),
        };
        Err(err!("spawn_agent: there is no kind '{}', so no worker was started: {}.", asked,
            there; Invalid, Input))
    }

    /// One line per kind for `spawn_agent`'s description: at most `shown` kinds, each
    /// description cut to `chars` characters.
    pub fn listing(&self, shown: usize, chars: usize) -> String {
        let mut out: Vec<String> = self.found.iter().take(shown)
            .map(|k| {
                let said: String = k.description.chars().take(chars).collect();
                match said.is_empty() {
                    true    => k.name.clone(),
                    false   => fmt!("{}: {}", k.name, said),
                }
            })
            .collect();
        if self.found.len() > shown {
            out.push(fmt!("and {} more", self.found.len() - shown));
        }
        out.join("; ")
    }
}

/// What a worker of `kind` is handed: the kind's prompt, then its task.  In the task rather than
/// the system message, so a worker started as a copy of its parent keeps the parent's system
/// message byte for byte and a brief worker its own role.
pub fn task_for(kind: &Kind, task: &str) -> String {
    match kind.prompt.is_empty() {
        true    => task.to_string(),
        false   => fmt!("{}\n\n## Your task\n\n{}", kind.prompt, task),
    }
}

/// Read every `*.md` under [`KINDS_DIR`] in one layer.  A missing directory is no kinds.
async fn layer<H: Host>(ctx: &ToolContext<H>, root: FileRoot) -> Kinds {
    let mut files: Vec<(String, String)> = Vec::new();
    #[cfg(not(target_arch = "wasm32"))]
    if !H::HOSTED {
        // The bare half has no store, so its one layer is the workspace on disk.
        if let Ok(dir) = ctx.workspace.resolve(KINDS_DIR) {
            if let Ok(rd) = std::fs::read_dir(&dir) {
                for e in rd.flatten() {
                    let name = e.file_name().to_string_lossy().to_string();
                    if let (true, Ok(text)) = (name.ends_with(".md"), std::fs::read_to_string(e.path())) {
                        files.push((name, text));
                    }
                }
            }
        }
        return read_all(files);
    }
    let fs = ctx.host().fs();
    if let Ok(list) = fs.list_dir(root, KINDS_DIR).await {
        for (name, dir, _) in list {
            if dir || !name.ends_with(".md") {
                continue;
            }
            if let Ok(bytes) = fs.read_file(root, &fmt!("{}/{}", KINDS_DIR, name)).await {
                files.push((name, String::from_utf8_lossy(&bytes).to_string()));
            }
        }
    }
    read_all(files)
}

fn read_all(files: Vec<(String, String)>) -> Kinds {
    let mut out = Kinds::default();
    for (name, text) in files {
        let stem = name.trim_end_matches(".md");
        match parse(&text, stem) {
            Ok(k)  => out.found.push(k),
            Err(e) => out.faults.push((stem.to_string(), e.plain())),
        }
    }
    out.found.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// The kinds in force for `ctx`: the store's, under the open folder's.  With no folder open the
/// two roots are one, so it is read once.
pub async fn load<H: Host>(ctx: &ToolContext<H>) -> Kinds {
    let tree = layer(ctx, FileRoot::Workspace).await;
    if !H::HOSTED || !ctx.host().fs().folder_open() {
        return tree;
    }
    Kinds::merge(layer(ctx, FileRoot::Opfs).await, tree)
}

/// The two kinds a store is given once, as (path, text), each on the worker model the user has
/// picked (`provider`, `model`).  No effort is written: the model's default stands until the
/// user sets one.
pub fn seeds(provider: &str, model: &str) -> Vec<(String, String)> {
    let head = |name: &str, said: &str, tools: &str| fmt!(
        "---\nname: {}\ndescription: {}\nprovider: {}\nmodel: {}\n{}---\n\n",
        name, said, provider, model, tools);
    vec![
        (fmt!("{}/builder.md", KINDS_DIR), fmt!("{}{}",
            head("builder", "Makes one bounded change and checks it.", ""),
            "Make the one change the task names and nothing beside it. Read the code you will \
             change before you change it, and check the result with the project's own verifier. \
             Report what you changed, by file and line, and what you could not check.\n")),
        (fmt!("{}/reviewer.md", KINDS_DIR), fmt!("{}{}",
            head("reviewer", "Reviews work it did not write and reports faults; changes nothing.",
                "tools: file_read, file_list, file_search, file_glob, outline\n"),
            "Review the work the task names. Read the change and what it touches, and look for \
             faults that would show in use. Report each fault with its file and line, the case \
             that fails and the fix you recommend. Say plainly when you found none, and what you \
             did not check.\n")),
    ]
}

#[cfg(test)]
#[path = "../tests/unit/kinds/tests.rs"]
mod tests;
