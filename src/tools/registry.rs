use super::*;

// ── Several reads in one round ───────────────────────────────────────
//
// **A daimon's excess rounds are mostly reads, and they are mostly reads that belong together.**
// Measured on 2026-09-13 over eight tasks matched against Claude Code: opus spent 8.0 rounds a
// task in Daimond against 4.1 in Claude Code, and twelve of the thirty-eight excess rounds were
// a single file read on its own -- list, then read what the listing named, then search for the
// name that file used, then read where the search pointed. Every one of those is a full request
// of the standing context bought for a few kilobytes of answer.
//
// A shell hands that saving over for nothing: `ls -R; cat src/*.js` is ONE command, and a model
// that has a shell composes one without being told to. [`Tool::Compound`] is that move, with the
// shell left out of it -- the ops are named, their arguments are the primitives' own, and each
// one is dispatched through [`ToolRegistry::dispatch_op`], the same door the primitive goes
// through when the model calls it alone. So the scope fence, the machine reach and every refusal
// are written once, in the primitive, and this file adds no path handling of any kind.
//
// **What is new here is the BUDGET and the LABELS**, which is the whole of the design worth
// arguing about. Six reads in one call can be six times [`MAX_OUTPUT`], so a compound has to
// decide what to leave out; and a result carrying six answers has to say which answer is which,
// or the model reads the second file's contents as the first's.

/// The most bytes a compound's ops return between them when the call did not name a figure.
///
/// A quarter of [`TURN_SPEND_BUDGET`] and about 8,000 tokens: enough for a listing, two source
/// files and a search, which is the shape the measurement is about, and small enough that a
/// compound of six large files cannot spend a turn's whole allowance in one round.
pub(super) const COMPOUND_BUDGET_DEFAULT: usize = 32 * 1024;

// The least a compound is cut to, however little the turn has left.
//
// The clamp to `spend_left` is right and would otherwise reach zero, which is a result with no
// header and no labels -- a model told nothing at all about what it just asked for. At this size
// the header and every op's own line still arrive, so the answer is "this turn has no room left",
// said in a form the model can act on.
pub(super) const COMPOUND_BUDGET_FLOOR: usize = 2_000;

// The most ops one compound may hold, which is the `maxItems` its schema declares.
//
// Not a correctness bound: the byte budget is what stops a compound being expensive. It is a
// bound on the SHARE -- twelve ops of a 32 KB budget is 2,700 bytes each, and past that the
// per-op answers stop being worth reading.
pub(super) const COMPOUND_OPS_MAX: usize = 12;

/// The op names, in the order the schema lists them, for a refusal to name.
pub(super) const COMPOUND_OPS: [&str; 5] = ["list", "read", "search", "glob", "outline"];

/// The primitive one `op` names, or `None` where it names nothing a compound runs.
///
/// Each op is spelled twice on purpose -- the short name the schema asks for and the tool's own
/// wire name -- because a model that has been reading `file_read` in its toolbelt all turn will
/// write `file_read` here, and a refusal over the spelling costs the round this tool exists to
/// save. Generous in what it accepts; exact in what it refuses.
pub(super) fn compound_tool(op: &str) -> Option<Tool> {
    match op.trim() {
        "list"    | "file_list"   => Some(Tool::FileList),
        "read"    | "file_read"   => Some(Tool::FileRead),
        "search"  | "file_search" => Some(Tool::FileSearch),
        "glob"    | "file_glob"   => Some(Tool::FileGlob),
        "outline"                 => Some(Tool::Outline),
        _                         => None,
    }
}

/// One op named the way a person reads it: the verb, then what it was asked about.
///
/// **Read off the ARGUMENTS and never off the answer.** A label built from the primitive's own
/// notice would be a fact derived from a sentence, which is the defect [`call_outcome`] exists to
/// close -- and it would be wrong in exactly the case that matters, a refused op, whose answer
/// says nothing about what was asked.
///
/// The one namer for both places a compound's ops are named: the `--- [n]` header inside the
/// result, and the retirement stub `crate::agent::compact::call_label` composes once the result
/// is too old to carry. A stub that named no ops would tell the model it had already looked and
/// not say at what.
///
/// # Arguments
/// * `op_json` - One element of `ops`, as the model wrote it.
pub(crate) fn compound_op_label(op_json: &str) -> String {
    let arg = |k: &str| extract_json_string(op_json, k).unwrap_or_default();
    let num = |k: &str| crate::llm::extract_json_number(op_json, k);
    let op  = arg("op");
    match compound_tool(&op) {
        Some(Tool::FileList) => match arg("path") {
            p if p.is_empty() => fmt!("list ."),
            p                 => fmt!("list {}", clip_label(&p)),
        },
        Some(Tool::FileRead) => {
            // SEVERAL FILES ARE COUNTED, NOT LISTED. A label is one line, and a `paths` of nine
            // would be the whole of it -- the paths are in the per-file headers `file_read`
            // writes inside its own answer, where they belong.
            if let Some(ps) = crate::llm::extract_json_string_array(op_json, "paths") {
                match ps.len() {
                    0 => (),
                    1 => return fmt!("read {}", clip_label(&ps[0])),
                    n => return fmt!("read {} files", n),
                }
            }
            let from = num("offset").unwrap_or(1);
            let range = match (num("end"), num("limit")) {
                (Some(to), _)            => fmt!(" ({}-{})", from, to),
                (None, Some(n))          => fmt!(" ({}-{})", from, from + n.saturating_sub(1)),
                (None, None) if from > 1 => fmt!(" (from {})", from),
                _                        => String::new(),
            };
            fmt!("read {}{}", clip_label(&arg("path")), range)
        },
        Some(Tool::FileSearch) => match arg("path") {
            p if p.is_empty() || p == "." => fmt!("search {}", clip_label(&arg("query"))),
            p => fmt!("search {} in {}", clip_label(&arg("query")), clip_label(&p)),
        },
        Some(Tool::FileGlob)   => fmt!("glob {}", clip_label(&arg("pattern"))),
        Some(Tool::Outline)    => fmt!("outline {}", clip_label(&arg("path"))),
        // Every other arm is unreachable -- `compound_tool` answers five tools and no more --
        // and an op this build does not know is named as the model wrote it, so the refusal
        // beside it reads as being about that word.
        _ => match op.trim() {
            ""    => fmt!("(no op named)"),
            other => clip_label(other),
        },
    }
}

// The most of one argument a label carries.
//
// A label is a line in a header and a phrase in a retirement stub, and a query or a glob can be
// any length the model likes.
pub(super) const COMPOUND_LABEL_CAP: usize = 80;

/// `s` inside [`COMPOUND_LABEL_CAP`] bytes, cut on a character boundary.
pub(super) fn clip_label(s: &str) -> String {
    if s.len() <= COMPOUND_LABEL_CAP {
        return s.to_string();
    }
    let mut end = COMPOUND_LABEL_CAP;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    fmt!("{}…", &s[..end])
}

/// How much of `room` each answer may take, given what each of them actually weighs.
///
/// **An even split would be the wrong answer to the question a compound asks.** Six ops of a
/// 32 KB budget is 5,461 bytes each; five of them a few hundred bytes long and the sixth a whole
/// source file, and the even split cuts the only answer anybody wanted while handing 25 KB of
/// unused room back to nobody. So the room a small answer does not need is given to the answers
/// that do: each round of the loop shares what is left equally between the answers still over
/// their share, and every answer that comes in under it is settled and releases the rest.
///
/// Every answer that fits gets all of itself, and the shares sum to at most `room`.
///
/// # Arguments
/// * `sizes` - What each answer weighs, in the order the ops were asked.
/// * `room` - The bytes there are to divide.
pub(super) fn compound_shares(sizes: &[usize], room: usize) -> Vec<usize> {
    let mut out    = vec![0usize; sizes.len()];
    let mut open:   Vec<usize> = (0..sizes.len()).collect();
    let mut left   = room;
    while !open.is_empty() {
        let share = left / open.len();
        // Nothing left to divide, or so little that a further round would hand out nought
        // apiece: the remainder goes to the first answer still open rather than evaporating.
        if share == 0 {
            if let Some(&i) = open.first() {
                out[i] += left;
            }
            return out;
        }
        let mut still: Vec<usize> = Vec::new();
        let mut spent = 0usize;
        for &i in &open {
            if sizes[i] <= share {
                out[i]  = sizes[i];
                spent  += sizes[i];
            } else {
                still.push(i);
            }
        }
        if still.len() == open.len() {
            // Every answer left is over its share, so the split is final.
            for &i in &open {
                out[i] = share;
            }
            return out;
        }
        left -= spent;
        open  = still;
    }
    out
}

// Room kept back for the header line, which is composed after the answers are cut and so cannot
// be measured before them.
//
// Generous on purpose: the line is about eighty bytes and the slack is what lets the reservation
// be one subtraction rather than a composition run twice to find out its own length.
pub(super) const COMPOUND_HEADER_ROOM: usize = 160;

/// What a correct call looks like, for a refusal to show rather than describe.
///
/// The same discipline as [`EDIT_EXAMPLE`], and for the same measured reason: a refusal that
/// describes a shape costs another round, and one that shows a call that works does not.
pub(super) const COMPOUND_EXAMPLE: &str =
    "{\"ops\":[{\"op\":\"list\",\"path\":\"src\"},{\"op\":\"read\",\"path\":\"src/main.rs\"}]}";

/// The line one op's answer opens with: its number, so the model can name it, and its label.
pub(super) fn compound_head(n: usize, label: &str) -> String {
    fmt!("--- [{}] {}\n", n, label)
}

/// The clause naming which ops the budget cut, or nothing where it cut none.
///
/// **The header says WHICH, never merely that something was cut.** An answer cut without being
/// named leaves the model with no way to tell a short file from a truncated one, and the repair
/// it reaches for is to send the whole compound again -- which is the round this tool saves,
/// spent twice.
pub(super) fn compound_cut_said(cut: &[usize]) -> String {
    match cut.len() {
        0 => String::new(),
        1 => fmt!("; op {} was cut to fit -- ask for it alone, or raise 'budget'", cut[0]),
        _ => fmt!("; ops {} were cut to fit -- ask for them alone, or raise 'budget'",
            cut.iter().map(|n| n.to_string()).collect::<Vec<_>>().join(", ")),
    }
}


/// The set of tools available to the agent, plus the context they run in.
#[derive(Clone, Debug)]
pub struct ToolRegistry<H: Host = DefaultHost> {
    pub tools:  Vec<Tool>,
    pub ctx:    ToolContext<H>,
    /// Which model dialect this registry is answering, which decides the roster, the `file_edit`
    /// schema and how generously an argument object is read.
    ///
    /// In a cell because a trial arm may force it after construction -- `set_tune {"family":…}` --
    /// and the registry is built before the page has said anything.
    pub(super) family: std::cell::Cell<crate::profile::Family>,
    /// Whether a Claude-family registry shows the Claude Code alias for a tool that has one
    /// (`Read`, `Edit`, `Write`, `Grep`, `Glob`, `LS`, `Bash`) instead of Daimond's own name.
    ///
    /// Off by default even when `family` is [`crate::profile::Family::Claude`]: this is the
    /// measured arm (`arms.json`'s `claudenames`, `set_tune {"claude_names":true}`), not a
    /// standing change to what a real Claude session is shown, so `cur` and `claudenames`
    /// differ in exactly this one setting and nothing else.
    pub(super) claude_names: std::cell::Cell<bool>,
    /// The tools a family hint has already been given for, this turn.
    ///
    /// A hint is worth a line the first time and is noise every time after: a model that did not
    /// act on it will not act on the fourth copy, and the fourth copy is paid for on a result the
    /// turn is already short of room for.  Cleared where `read_seen` is, at `begin_turn`.
    pub(super) hinted: std::rc::Rc<std::cell::RefCell<Vec<&'static str>>>,
    pub(super) machine: std::cell::Cell<Option<bool>>, // A folder reachable when this turn was briefed?
}

// Concrete until U2c4: these methods hand `self.ctx` to tools that take a `ToolContext` on the
// default host, and `Tool::execute` goes generic there, with the hosted half.
impl ToolRegistry {

    /// A registry on the build's own host ([`ToolRegistry::new_on`]).
    ///
    /// Concrete and not generic, because a host type is not inferred from a default: the callers
    /// that build a [`ToolContext`] with `host: Default::default()` (the native handler, the
    /// examples and the tests) would each have to name one.
    pub fn new(tools: Vec<Tool>, ctx: ToolContext) -> Self {
        Self::new_on(tools, ctx)
    }
}

impl<H: Host> ToolRegistry<H> {

    /// Where a destructive call's path sits, asked BEFORE the call runs, for the lens -- or `None`
    /// for a call that removes and replaces nothing.  See [`PathClass`].
    ///
    /// Asked before and not after, because after a delete there is nothing left to ask about, and
    /// "was this a folder" and "was there a file here to overwrite" are questions about the state
    /// the call met.
    pub async fn path_class(&self, name: &str, args: &str) -> Option<PathClass> {
        if !is_destructive(name) {
            return None;
        }
        let raw = match extract_json_string(args, "path") {
            Some(p) => p,
            None    => return None,
        };
        let norm = normalise(&raw);
        let depth = if norm.is_empty() { 0 } else { norm.split('/').count() };
        #[cfg(not(target_arch = "wasm32"))]
        if !H::HOSTED {
            let kind = match self.ctx.workspace.resolve(&raw)
                .ok()
                .and_then(|p| std::fs::symlink_metadata(p).ok())
            {
                Some(m) if m.is_dir() => PathKind::Folder,
                Some(_)               => PathKind::File,
                None                  => PathKind::Absent,
            };
            return Some(PathClass { depth, kind, open: false });
        }
        let root = self.ctx.root;
        let open = root == FileRoot::Workspace && self.ctx.host().fs().folder_open()
            && !is_store_path(&norm);
        let kind = if norm.is_empty() {
            PathKind::Folder
        } else if let Ok(true) = self.ctx.host().fs().is_directory(root, &norm).await {
            PathKind::Folder
        } else if let Ok(true) = self.ctx.host().fs().exists(root, &norm).await {
            PathKind::File
        } else {
            PathKind::Absent
        };
        Some(PathClass { depth, kind, open })
    }

    /// A registry for a caller that does not know which model will carry the request.
    ///
    /// [`Family::Unknown`](crate::profile::Family::Unknown) is every tool and the schema as
    /// written, so a caller that has not been taught to pass a model loses nothing -- which keeps
    /// the ~20 test constructors and the panel's own registry compiling unchanged.
    ///
    /// On any host; [`ToolRegistry::new`] is this on the build's own, so that a caller building a
    /// [`ToolContext`] with `host: Default::default()` needs to name no host at all.
    pub fn new_on(tools: Vec<Tool>, ctx: ToolContext<H>) -> Self {
        Self { tools, ctx, family: std::cell::Cell::new(crate::profile::Family::Unknown),
            claude_names: std::cell::Cell::new(false),
            hinted: std::rc::Rc::new(std::cell::RefCell::new(Vec::new())),
            machine: std::cell::Cell::new(None) }
    }

    /// Record whether a command has anywhere to run, as this turn's briefing found out; `None`
    /// where the briefing did not ask, which offers the machine tools.
    ///
    /// Set by the turn's owner from what [`crate::prompts::machine_briefing`] returned, once, before
    /// the request is built, and never by a view of the request: the offer must not change
    /// mid-turn, or the prefix cache misses and a call the turn could make is refused.
    pub fn set_machine_rooted(&self, rooted: Option<bool>) {
        self.machine.set(rooted);
    }

    /// Whether a command has anywhere to run, as this turn was briefed; `None` until asked.
    pub fn machine_rooted(&self) -> Option<bool> {
        self.machine.get()
    }

    /// The same registry, answering `f`'s dialect.
    pub fn with_family(self, f: crate::profile::Family) -> Self {
        self.family.set(f);
        self
    }

    /// Answer `f`'s dialect from here on.
    ///
    /// The door a trial arm comes through, so a profile can be forced without a rebuild and
    /// [`crate::wasm::app::DaimondApp::turn_limits`] can echo what was taken.
    pub fn set_family(&self, f: crate::profile::Family) {
        self.family.set(f);
    }

    /// Which dialect this registry is answering.
    pub fn family(&self) -> crate::profile::Family {
        self.family.get()
    }

    /// The same registry, with the Claude Code alias table on or off.
    pub fn with_claude_names(self, on: bool) -> Self {
        self.claude_names.set(on);
        self
    }

    /// Turn the Claude Code alias table on or off from here on.
    ///
    /// The door `set_tune {"claude_names":…}` comes through, exactly as [`Self::set_family`] is
    /// for `family` -- see the field's own doc for why the switch is independent of it.
    pub fn set_claude_names(&self, on: bool) {
        self.claude_names.set(on);
    }

    /// Whether a Claude-family registry is showing the Claude Code alias for the tools that
    /// have one.
    pub fn claude_names(&self) -> bool {
        self.claude_names.get()
    }

    /// Open a turn: the context's own ledger, and the hints already given.
    ///
    /// One door rather than two, because the two must be reset together -- a hint held over from
    /// a previous turn is a line the model never sees.
    ///
    /// Answers the guard that ends the turn: what the turn holds (a toolkit or a place the user
    /// said yes to) is dropped when the guard is, however the turn left.
    #[must_use]
    pub fn begin_turn(&self) -> TurnEnd<H> {
        self.ctx.begin_turn();
        self.hinted.borrow_mut().clear();
        TurnEnd { ctx: self.ctx.clone() }
    }

    /// True if no tools are enabled (pure-chat mode).
    ///
    /// What it HOLDS and not what it [`offers`](Self::offered): this is what decides whether a
    /// turn takes the tool loop at all, and a registry whose only tools were the two a worker is
    /// withheld is not a case any caller builds.
    pub fn is_empty(&self) -> bool {
        self.tools.is_empty()
    }

    /// The same registry, holding only the tools named -- and only those it already held.
    ///
    /// This is what bounds a skill. A skill is instructions, so its power is the agent's power:
    /// whatever the agent can do, a skill's text can tell it to do, and no amount of reading that
    /// text will reliably tell you whether it means to. So the text is not what is trusted -- the
    /// declaration is, and it is enforced here. A skill that asked for `file_read` runs against a
    /// registry holding `file_read`, and the tools it did not ask for are not merely refused at
    /// dispatch: [`definitions_json`](Self::definitions_json) is built from this vector, so the
    /// model is never even *offered* them, and cannot call what it was never shown.
    ///
    /// The intersection is deliberate. A declaration may only ever narrow: a skill cannot conjure
    /// a tool the agent was not given, so asking for one it does not hold is not a grant, it is a
    /// no-op that the caller can then report.
    ///
    /// # Arguments
    /// * `names` - The wire names of the tools to keep.
    pub fn narrowed(&self, names: &[String]) -> Self {
        let tools = self.tools.iter()
            .filter(|t| names.iter().any(|n| n == t.name()))
            .cloned()
            .collect();
        Self {
            tools,
            ctx:    self.ctx.clone(),
            family: std::cell::Cell::new(self.family.get()),
            claude_names: std::cell::Cell::new(self.claude_names.get()),
            // The same cell, not a copy: a skill turn is the same turn, and a hint already given
            // must not be given again because the registry was narrowed between rounds.
            hinted: self.hinted.clone(),
            machine: std::cell::Cell::new(self.machine.get()),
        }
    }

    /// The names in `names` that no tool answers to, so a skill declaring a tool that does not
    /// exist -- a typo, or a lie about itself -- is caught and said out loud rather than silently
    /// dropped into an empty toolbelt.
    ///
    /// # Arguments
    /// * `names` - The wire names a skill declared.
    pub fn unknown_tools(&self, names: &[String]) -> Vec<String> {
        names.iter()
            .filter(|n| Tool::from_name(n).is_none())
            .cloned()
            .collect()
    }

    /// The tools this registry actually OFFERS, which is not always everything it holds.
    ///
    /// **A dispatched worker is offered exactly what its parent is** (r578c, 2026-10-20): it starts
    /// as a copy of the parent's request, tools array included, so its first round reuses the
    /// parent's cache.  What a worker may not do -- `file_show`, `ask`, `spawn_agent`, `gather` --
    /// is refused AT THE CALL with a plain tool error; see [`Tool::worker_may_not_show`] and
    /// [`Self::try_dispatch_asking`].  An offer that differed was a cache miss on every worker.
    ///
    /// **The `say` tool stood here beside it and no longer exists.**  Folding an answer is written
    /// into the model's own prose as a `<details>` element now, so what withholds it from a worker
    /// is [`Role::can_show`](crate::prompts::Role::can_show) declining to append
    /// [`FOLD_NOTE`](crate::prompts::FOLD_NOTE) -- a prompt sentence rather than a schema, which
    /// costs a worker nothing per round.
    ///
    /// Filtered HERE and not in [`Tool::browser`], because that vector is also the list the Tools
    /// panel shows a person about their own chat, where the tool is real.  The mark is read each
    /// time rather than at construction, because it is set on the context after the app is built
    /// -- see [`ToolContext::set_unsupervised`].
    ///
    /// [`dispatch`](Self::dispatch) still resolves it, so a worker that names it anyway gets the
    /// refusal that tells it what to do instead, and not "tool 'file_show' is not available here."
    pub fn offered(&self) -> Vec<Tool> {
        // AND NOT THE MACHINE TOOLS WHERE THERE IS NO MACHINE FOLDER.  `run`, `runs` and `verify`
        // come to about 1,600 tokens of schema between them -- `run`'s description alone is a
        // paragraph -- and they rode on every request of every round of every turn on a page with
        // no hand attached, which is most pages and every phone.  All three refuse in that case
        // and say why, so what was paid for was the chance to be refused: see `Tool::run`'s own
        // check on `Machine::rooted`, and `reach_of`'s.
        //
        // `machine_rooted` and not a fresh `status()` call: this is synchronous and is asked
        // once per round.  The briefing establishes the fact once per turn, before the schema is
        // built, and `prompts::NO_MACHINE_NOTE` then tells the model in one sentence that the
        // tools are not there -- without which the model does not merely fail to run a command,
        // it probes for a tool it cannot see and reports the app as broken.
        self.tools.iter()
            .filter(|t| !self.wants_machine(t))
            // AND NOT A TOOL THE ACCOUNT HAS NOT BOUGHT, which is the prefix half of the gate
            // `guard` already holds.  A locked tool's description and schema were sent on every
            // request of every round -- the four mail tools and the Typst compiler come to
            // ~9,500 characters, about 2,400 tokens, and a daimon pays them ~150 times a turn --
            // for a tool that could only ever answer with the refusal `pack_refusal` composes.
            // The one thing lost is the model's chance to NAME the pack, which is why
            // `locked_pack_note` puts it in the briefing instead, in one sentence.
            //
            // Asked here rather than in the belt vectors because those are also what the Tools
            // panel shows a person, where an unbought tool is real and is what they would buy.
            .filter(|t| !t.pack_unbought())
            // AND NOT A MEASURE THAT IS STILL UNDER TRIAL.  `compound` is held on every belt
            // and offered only where the turn has switched it on, so the parity bank's `cur`
            // arm is a control rather than a second copy of the treatment -- and an account
            // that never runs the arm pays not one byte of its 2,200-character prefix.  The
            // gate is the OFFER and not the dispatch, exactly as `file_show`'s is: a model that
            // names it anyway gets the tool, which costs nothing and surprises nobody.
            .filter(|t| !(matches!(t, Tool::Compound) && !self.ctx.compound_on()))
            // `pending_none` IS OFFERED ON EVERY TURN and refused at the call outside a
            // pending-only one (r578b A1): offered on that turn alone, it changed the tools array
            // and the system message's tool sentence going in and coming out, two full misses of
            // the provider's cache.  See `pending_none`.
            // AND NOT A TOOL THIS FAMILY DOES NOT ADDRESS.  Measured, never precautionary: see
            // `crate::profile::Family::withholds` for the bank row behind each one.
            .filter(|t| !self.family.get().withholds(t))
            .cloned()
            .collect()
    }

    /// Is this tool on the belt but withheld because no folder on this computer is reachable?
    ///
    /// The one test [`offered`](Self::offered) and the turn's engine both read (UNBLOCK-32 F4).
    /// A call to such a tool can only be refused, so the engine does not send it: the turn ends
    /// on one plain question saying what is missing -- see `agent::wanting_told`.  Probing on
    /// with the file tools is what the Nancy Hopkins turn of 22 Oct did for 15 minutes after it
    /// had named the blocker itself.
    pub fn wants_machine(&self, t: &Tool) -> bool {
        self.machine.get() == Some(false)
            && t.machine()
            && self.tools.contains(t)
    }

    /// Is this tool in the request as a stub, its schema withheld, so that a call to it is the
    /// model saying the ask needs a command?
    ///
    /// The one test [`machine_stub_json`](Self::machine_stub_json) and the turn's engine both
    /// read (UNBLOCK-32 F4b).  Only `run` has a stub: `runs`, `verify` and `serve` are not in the
    /// request at all, so a call to one is a habit (the worker role says to `verify` its work), not
    /// a statement of need, and it gets the tool's own refusal and the turn goes on, as Claude
    /// Code answers a tool it never offered.
    pub fn stubbed(&self, t: &Tool) -> bool {
        *t == Tool::Run && self.wants_machine(t) && !self.family.get().withholds(t)
    }

    /// The one line of schema that stands in for `run` where [`wants_machine`](Self::wants_machine)
    /// withholds it, or `None` where it does not.
    ///
    /// **A capability the model cannot see is one it probes for**, which is why `NO_MACHINE_NOTE`
    /// exists; but a sentence gives the engine nothing to act on.  This stub, about 90 tokens
    /// against the ~1,600 the machine schemas cost, lets the model SAY it needs a command the one
    /// way the engine can read -- by calling it -- and the engine then ends the turn and asks.
    pub fn machine_stub_json(&self) -> Option<String> {
        if !self.stubbed(&Tool::Run) {
            return None;
        }
        Some(fmt!(
            r#"{{"type":"function","function":{{"name":"{}","description":"{}","parameters":{}}}}}"#,
            Tool::Run.wire_name(self.family.get(), self.claude_names.get()),
            json_escape(RUN_STUB_DESC), RUN_STUB_PARAMS,
        ))
    }

    /// One sentence naming the packs this account has not bought, for the turn's briefing, or
    /// `None` where it holds everything its belt is sold under.
    ///
    /// [`offered`](Self::offered) withholds an unbought tool's schema, so without this the model
    /// would not merely be unable to typeset -- it would have no way to know the capability
    /// exists, and would tell the user Daimond cannot do it.  Costs a few tokens against the
    /// ~2,400 the schemas cost, and costs nothing at all on an account that has bought the lot.
    pub fn locked_pack_note(&self) -> Option<String> {
        let mut packs: Vec<&'static str> = Vec::new();
        for t in &self.tools {
            if let Some(p) = t.pack() {
                if pack_locked(p) && !packs.contains(&p) {
                    packs.push(p);
                }
            }
        }
        if packs.is_empty() {
            return None;
        }
        Some(fmt!(
            "Some of Daimond's tools are sold in packs, and this account has not bought: {}. \
            Those tools are not on your belt, so do not try to call them. Where the user asks for \
            something one of them would have done, say plainly that it is a pack in the Tools \
            panel, bought once and kept, paid in money rather than out of their credits -- then \
            do what you can without it.",
            packs.join(", ")))
    }

    /// The wire names of the registered tools, in order.  The system prompt
    /// is built from this rather than from a fixed sentence, so it can never
    /// promise the model a tool that is not actually registered.
    ///
    /// Built from [`offered`](Self::offered), so the sentence naming the tools and the schema
    /// array beside it name the same set -- and both read [`Tool::wire_name`], so a Claude
    /// session with the alias switch on is told `Read`, `Edit`, `Grep`… in the tools sentence
    /// as well as the schema, never one and not the other.  `run`'s alias `Bash` therefore
    /// appears here only when `run` itself is offered, exactly as `run` would.
    pub fn tool_names(&self) -> Vec<String> {
        self.offered().iter()
            .map(|t| t.wire_name(self.family.get(), self.claude_names.get()).to_string())
            .collect()
    }

    /// The `tools` JSON array for the LLM request, or `None` if empty.
    pub fn definitions_json(&self) -> Option<String> {
        let offered = self.offered();
        if offered.is_empty() {
            return None;
        }
        let kept = runner_keeps(&self.ctx);
        let mut defs: Vec<String> = offered.iter()
            .map(|t| t.definition_json_where(self.family.get(), self.claude_names.get(), kept))
            .collect();
        // Not in `tool_names`: the briefing says plainly that run is not on the belt.
        defs.extend(self.machine_stub_json());
        Some(fmt!("[{}]", defs.join(",")))
    }

    /// Is a path a tool named on the store NOW?
    ///
    /// The same jail the tools themselves go through, so the audit asks about the file the call
    /// actually wrote: the native side resolves against the workspace root and the browser side
    /// applies the Diamond prefix first, exactly as `file_write` does.
    ///
    /// **A path it cannot answer for comes back `true`,** and that is the design rather than a
    /// lapse.  This backs an audit; an audit that reports what it does not know is one people
    /// learn to ignore, and a store that will not say is not evidence that a file is gone.
    ///
    /// # Arguments
    /// * `rel` - The path as the model wrote it, before any prefix.
    pub async fn path_is_there(&self, rel: &str) -> bool {
        #[cfg(not(target_arch = "wasm32"))]
        if !H::HOSTED {
            return match self.ctx.workspace.resolve(rel) {
                Ok(abs) => abs.exists(),
                Err(_)  => true,
            };
        }
        match Tool::scoped(&self.ctx, rel) {
            Ok(p)  => self.ctx.host().fs().exists(self.ctx.root, &p).await.unwrap_or(true),
            Err(_) => true,
        }
    }

    /// Execute a tool call by name, returning its result.  Unknown
    /// tools and errors are returned as text so the LLM can recover.
    ///
    /// The result is [`MessageContent`] because `file_read` can return an image; every other tool
    /// returns the text it always did, and a caller that only wants text can ask for
    /// `MessageContent::as_text`.
    ///
    /// **This is the door the conversation comes through, and the turn is charged for it here.**
    /// A panel comes through [`dispatch_unbilled`](Self::dispatch_unbilled) instead.
    pub async fn dispatch(&self, name: &str, args_json: &str) -> MessageContent {
        let out = Self::flatten(self.try_dispatch(name, args_json).await);
        self.charge(out)
    }

    /// The same call, with a ROAD failure kept as an error instead of becoming a result.
    ///
    /// **This is the boundary the whole road/remote split turns on.**  Everything downstream of
    /// [`Self::flatten`] is looking at a `MessageContent`, and by then a request that never left
    /// the device is indistinguishable from a page that answered "no": both are text, and the
    /// information that told them apart has been destroyed.  So the split is made here, before
    /// the flattening, and nowhere else.
    ///
    /// **A NARROWING, NOT A REMOVAL.**  Only a failure carrying [`ROAD_MARK`] escapes as an
    /// error.  A tool that fails any other way -- a bad path, a refusal, a malformed argument, a
    /// host that answered with a 500 -- still becomes a result the model can read and adapt to,
    /// exactly as it always has.  One tool failing must not kill a turn, and anything this
    /// cannot confidently call the road is left alone.
    ///
    /// # Arguments
    /// * `name` - The tool's wire name.
    /// * `args_json` - The raw argument object.
    pub async fn try_dispatch(&self, name: &str, args_json: &str)
        -> Outcome<MessageContent>
    {
        self.try_dispatch_asking(name, args_json, |pa, id, turn| place_door(pa, id, turn, self.ctx.host())).await
    }

    /// [`Self::try_dispatch`], with the door a refused write is asked through given (E2).
    ///
    /// A write refused for being outside what the Diamond may change, where a yes could lift
    /// it, is put to `ask`.  A yes holds the place for the rest of the turn -- the page has
    /// written its mark -- and the call is made again, once.  A no answers with
    /// [`place_refusal`].  No door (`None`) leaves the refusal as it was.
    pub async fn try_dispatch_asking<A, F>(&self, name: &str, args_json: &str, ask: A)
        -> Outcome<MessageContent>
    where
        A: FnOnce(PlaceAsk, String, String) -> F,
        F: std::future::Future<Output = Option<Permit>>,
    {
        // THE MARKS AS THEY STAND AT THIS CALL, not as they stood when the turn began: a mark
        // withdrawn, or made read-only, while the turn waits on a question is not written
        // through by the turn's next call (QA B F3).
        let now = match self.ctx.bounds_now().await {
            Ok(b)  => ToolContext { no_write: b, ..self.ctx.clone() },
            Err(e) => return Ok(MessageContent::text(refusal_line(&e.plain()))),
        };
        // A MODEL IS CALLING, so the call is answered as a model's and never as the user's own
        // door: the record's fence holds whatever the turn's bounds (`ToolContext::may_write`).
        let model = || ToolContext { by_model: true, no_write: now.write_bounds(),
            ..now.clone() };
        let ctx = model();
        // A WORKER DOES NOT DISPATCH WORKERS.  It is offered `spawn_agent` and `gather` because its
        // tools array is its parent's (r578c), and refused here, at the call.
        if ctx.is_unsupervised() && matches!(Tool::from_name(name), Some(Tool::SpawnAgent | Tool::Gather)) {
            return Ok(MessageContent::text(refusal_line(
                "Nothing was started. You are a dispatched worker, and a worker does not dispatch \
                workers of its own or wait on any: do this part of the work yourself and say in \
                your report what is left.")));
        }
        // NOR DOES IT ACT AS ITS PARENT (QA r578c A3).  A full copy of a daimon carries the
        // daimon's tools array, and these six change the person's Pending panel or the parent's
        // Diamond record -- the parent's own acts, from a turn nobody watches.  Crystal reads,
        // recall and `link_list` stay open.
        if ctx.is_unsupervised() && matches!(Tool::from_name(name), Some(
            Tool::PendingRaise | Tool::PendingClear | Tool::PendingNone | Tool::StateSet
            | Tool::LinkAdd | Tool::LinkRemove))
        {
            return Ok(MessageContent::text(refusal_line(
                "Nothing was changed. You are a dispatched worker, and alerts, STATE.md and the \
                Diamond's links are your parent's to change: say in your report what should \
                change and why.")));
        }
        ctx.take_place_ask();
        let mut out = self.dispatch_in(name, args_json, &ctx).await;
        if let (Ok(_), Some(pa)) = (&out, ctx.take_place_ask()) {
            if ctx.can_ask_writes(mode()) {
                match ask(pa.clone(), ctx.daimon_of.clone(), ctx.turn_tag()).await {
                    Some(Permit::Allow) => {
                        ctx.grant_place(&pa.place);
                        let again = model();
                        out = self.dispatch_in(name, args_json, &again).await;
                        // Once: a second refusal is answered as it was said.
                        again.take_place_ask();
                    },
                    Some(Permit::No(no)) => out = Ok(MessageContent::text(place_refusal(&pa, no))),
                    None                 => {},
                }
            }
        }
        // Charged only on the answer.  A road failure carried nothing into the conversation --
        // it is about to be retried, and a turn that paid for each attempt would run out of
        // budget for having been on a train.
        match out {
            Ok(c)  => Ok(self.charge(c)),
            Err(e) => Err(e),
        }
    }

    /// A road failure, spent, as the sentence a caller that cannot act on it must fall back to.
    ///
    /// The one place the two halves rejoin, so a panel and an older caller behave exactly as they
    /// did before this split existed.
    pub(super) fn flatten(out: Outcome<MessageContent>) -> MessageContent {
        match out {
            Ok(c)  => c,
            // `plain()`, NEVER `Display`. See `error_line`.
            Err(e) => MessageContent::text(error_line(&e.plain())),
        }
    }

    /// Charge a result to the turn's ledger and append the budget line if it is time.
    pub(super) fn charge(&self, out: MessageContent) -> MessageContent {
        // THE TURN'S LEDGER, CHARGED IN ONE PLACE. Sized by the two accounts
        // `crate::agent::compact` folds by, so the ledger and the folder cannot disagree about
        // what a result costs. Here rather than at each door because a budget that counted `run`
        // alone would be blind to a turn that read the same megabyte through `file_read`.
        let cost = out.text_len()
            + out.images().map(|i| crate::agent::compact::image_bytes(i) as usize).sum::<usize>();
        self.ctx.charge_spend(cost);
        Self::with_budget_line(out, &self.ctx)
    }

    /// The same call, charged to nobody -- the door a PANEL comes through.
    ///
    /// A file-browser listing is not in the conversation, so it costs the turn nothing and must
    /// not narrow it.  The split is here and not at the two call sites because everything else
    /// about the two doors is identical, the folder-lost check included, and two copies of that
    /// would eventually be two different checks.
    ///
    /// # Arguments
    /// * `name` - The tool's wire name.
    /// * `args_json` - The raw argument object.
    pub async fn dispatch_unbilled(&self, name: &str, args_json: &str) -> MessageContent {
        Self::flatten(self.try_dispatch_unbilled(name, args_json).await)
    }

    /// A page door's write of `bytes` at `path`, byte for byte ([`Tool::write_bytes_page`]),
    /// answered as [`Self::put_back`] is.  The Files panel's Undo of a delete; in no model's roster.
    pub async fn write_bytes_door(&self, path: &str, bytes: Vec<u8>) -> MessageContent {
        self.ctx.host().fs().arm_folder_watch();
        let out = match Tool::write_bytes_page(path, bytes, &self.ctx).await {
            Ok(c)  => c,
            Err(e) => MessageContent::text(error_line(&e.plain())),
        };
        let thrown = self.ctx.host().fs().take_thrown();
        if self.ctx.host().fs().folder_open()
            && folder_loss_reported(call_outcome(&out.as_text()), &thrown)
        {
            self.ctx.host().fs().notify_folder_lost();
        }
        out
    }

    /// The page's look before a restore asks ([`Tool::restore_look_page`]).
    pub async fn restore_look(&self, args_json: &str) -> MessageContent {
        match Tool::restore_look_page(args_json, &self.ctx).await {
            Ok(c)  => c,
            Err(e) => MessageContent::text(error_line(&e.plain())),
        }
    }

    /// A restore's put-back of a stored body, byte for byte ([`Tool::put_back_page`]), answered as
    /// [`Self::dispatch_op`] answers a tool call: a failure as its sentence, and a lost folder
    /// reported.  A verb of the restore door alone, so it is in no model's roster.
    pub async fn put_back(&self, args_json: &str) -> MessageContent {
        self.ctx.host().fs().arm_folder_watch();
        let out = match Tool::put_back_page(args_json, &self.ctx).await {
            Ok(c)  => c,
            Err(e) => MessageContent::text(error_line(&e.plain())),
        };
        let thrown = self.ctx.host().fs().take_thrown();
        if self.ctx.host().fs().folder_open()
            && folder_loss_reported(call_outcome(&out.as_text()), &thrown)
        {
            self.ctx.host().fs().notify_folder_lost();
        }
        out
    }

    /// The panel's door, with a ROAD failure kept as an error.
    ///
    /// The counterpart of [`Self::try_dispatch`] for a caller that pays nothing, and the place
    /// the narrowing is actually written.  See that method for why the split has to be here.
    ///
    /// # Arguments
    /// * `name` - The tool's wire name.
    /// * `args_json` - The raw argument object.
    pub async fn try_dispatch_unbilled(&self, name: &str, args_json: &str)
        -> Outcome<MessageContent>
    {
        self.dispatch_in(name, args_json, &self.ctx).await
    }

    /// One call, answered in `ctx`: this registry's own for a panel, a model's for a turn
    /// ([`Self::try_dispatch`]).
    pub(super) async fn dispatch_in(&self, name: &str, args_json: &str, ctx: &ToolContext<H>)
        -> Outcome<MessageContent>
    {
        // THE ONE TOOL THAT IS NOT A TOOL CALL, intercepted before the name is resolved.  Its
        // ops are dispatched through `dispatch_op` -- everything below this line, factored out
        // -- so each is normalised, belt-checked, guarded and executed exactly as it would be
        // had the model called it on its own.  No recursion: `compound_tool` answers five reads
        // and never this, so a compound cannot hold a compound.
        if matches!(Tool::from_name(name), Some(Tool::Compound))
            && self.tools.contains(&Tool::Compound)
        {
            let args = self.family.get().normalise_args(name, args_json);
            return self.compound(args.as_ref(), ctx).await;
        }
        self.dispatch_op(name, args_json, ctx).await
    }

    /// One tool call, through every door a tool call goes through, charged to nobody.
    ///
    /// The body [`Self::try_dispatch_unbilled`] used to be, factored out so [`Self::compound`]
    /// can send its ops through it.  A second copy of this would eventually be a second, weaker
    /// set of checks -- and the checks here are the fence, the belt and the folder alarm.
    ///
    /// # Arguments
    /// * `name` - The tool's wire name.
    /// * `args_json` - The raw argument object.
    pub(super) async fn dispatch_op(&self, name: &str, args_json: &str, ctx: &ToolContext<H>)
        -> Outcome<MessageContent>
    {
        // THE ARGUMENTS AS THE TOOL SHOULD SEE THEM, read generously before anything acts on
        // them.  Borrowed whenever nothing changed, which is nearly always, so the common path
        // allocates nothing.  Two drifts and no more: an object wrapped in whitespace, and an
        // array written as a quoted string -- both on the bank, both costing a whole round.
        let args = self.family.get().normalise_args(name, args_json);
        // A run rooted at a machine folder (UNBLOCK-32 F2b): every path the call names, as the
        // place it reaches, before any door judges it.
        let based = match Tool::from_name(name) {
            Some(t) => based_args(&t, args.as_ref(), &ctx.workspace),
            None    => None,
        };
        let args_json: &str = match &based {
            Some(b) => b.as_str(),
            None    => args.as_ref(),
        };
        // A listing call's one trailing '/' (HATE-15), dropped before any door judges the path.
        let unslashed = match Tool::from_name(name) {
            Some(t) => trailing_slash_args(&t, args_json),
            None    => None,
        };
        let args_json: &str = match &unslashed {
            Some(u) => u.as_str(),
            None    => args_json,
        };
        // ARMED BEFORE THE CALL, so the alarm below can only ever be about this one. An exception
        // an earlier call caught and recovered from is not evidence about this one's folder.
        // The hosted half's alone, as every port reach below is: the native half has no folder
        // that can be taken away and no store to window.
        if H::HOSTED {
            ctx.host().fs().arm_folder_watch();
        }
        let out = match Tool::from_name(name) {
            // A tool must be REGISTERED, not merely known. Resolving by name
            // alone let a caller run a tool it was never offered: a chat that
            // named `spawn_agent` was answered "Dispatched agent …" while
            // nothing was dispatched, because only the conductor's registry
            // carries it.
            Some(t) if self.tools.contains(&t) => match {
                // A COMMAND OR A WORKER CHANGES FILES NO CAPTURE SEES, so the turn end cannot
                // tell its bytes from another tab's or the person's ([`crate::wasm::diamond::drain_turn`]).
                if H::HOSTED && t.opaque() {
                    if let Some(k) = ctx.keeper() {
                        ctx.host().store().ran_opaque(&k);
                    }
                }
                // A WINDOW ROUND THE CALL, where its file effects are ones no capture records: the
                // files are looked at before and after, and what moved is credited to the agent
                // whose context ran it -- never to whoever else was working in the store.
                let window = match (H::HOSTED && t.windowed(), ctx.keeper()) {
                    (true, Some(k)) => Some(ctx.host().store().open_window(&k, ctx.by.clone()).await),
                    _               => None,
                };
                let done = t.execute(args_json, ctx).await;
                if let Some(w) = window {
                    ctx.host().store().close_window(w).await;
                }
                done
            } {
                Ok(c)  => c,
                // THE ONE FAILURE THAT DOES NOT BECOME A SENTENCE. Everything else -- a bad
                // path, a refusal, a 500 from a host that answered -- is a fact about the world
                // and the model is entitled to read it.
                Err(e) if road_failed(&e) => return Err(e),
                // A PERSON'S PAUSE REFUSED IT, which is a refusal and not a fault: see
                // `PAUSE_MARK`. `plain()`, NEVER `Display`, otherwise. See `error_line`.
                Err(e) => match paused_refusal(&e) {
                    Some((node, said)) => MessageContent::text(paused_line(&node, &said)),
                    None               => MessageContent::text(error_line(&e.plain())),
                },
            },
            Some(_) => MessageContent::text(
                error_line(&fmt!("tool '{}' is not available here.", name))),
            None    => MessageContent::text(error_line(&fmt!("unknown tool '{}'.", name))),
        };
        // A real folder can be taken away mid-session, and every tool call that touches it then
        // fails while the app goes on believing the folder is open. This is where every tool
        // result becomes text -- the agent's and the panel's alike -- so it is the one place that
        // sees the failure whoever provoked it. Saying so here, rather than in the panel's own
        // listing, is the difference between the user being told and the agent failing quietly
        // against a folder the panel still names.
        //
        // ON THE CALL'S OUTCOME AND ON WHAT IT THREW, never on what it returned: see
        // `folder_loss_reported`, and turn 53, where a SEARCH HIT cost the user their folder.
        if H::HOSTED {
            let thrown = ctx.host().fs().take_thrown();
            if ctx.host().fs().folder_open()
                && folder_loss_reported(call_outcome(&out.as_text()), &thrown)
            {
                ctx.host().fs().notify_folder_lost();
            }
        }
        Ok(self.guided(name, args_json, out))
    }


    /// Run one `compound` call: every op in order, each answer under its own label, the lot
    /// inside one byte budget.
    ///
    /// **On the registry and not on the tool, because the ops go through the registry's own
    /// door.** [`Self::dispatch_op`] is the door -- the dialect pre-pass, the belt check, the
    /// guard and `Tool::execute` -- so an op is refused exactly where the primitive is refused,
    /// by the primitive's own sentence, and this function composes rather than decides. It is
    /// also what closes the obvious escape: a skill narrowed to `["compound"]` holds no
    /// `file_read`, `dispatch_op` sees that, and every op is answered "not available here".
    ///
    /// **Charged once, by [`Self::try_dispatch`]**, which charges what this returns. The ops run
    /// unbilled underneath, so the turn's ledger counts the bytes that actually reach the
    /// conversation and not the bytes that were read and then cut.
    ///
    /// **Text, always.** `file_read` can answer with a picture; a compound cannot carry one and
    /// does not pretend to -- an op naming `as` is refused with `file_read` named as the way to
    /// look at an image, rather than handed back a caption with no picture attached to it.
    ///
    /// # Arguments
    /// * `args_json` - The call's arguments, after the dialect pre-pass.
    pub(super) async fn compound(&self, args_json: &str, ctx: &ToolContext<H>) -> Outcome<MessageContent> {
        let asks = match crate::llm::extract_json_objects(args_json, "ops") {
            Some(a) => a,
            None    => return Ok(MessageContent::text(refusal_line(&fmt!(
                "compound: 'ops' must be a JSON array of objects and this call carried {}. \
                Nothing has been read. One that works: {}",
                shape_of(args_json), COMPOUND_EXAMPLE)))),
        };
        if asks.is_empty() {
            return Ok(MessageContent::text(refusal_line(&fmt!(
                "compound: 'ops' is empty, so there is nothing to read. One that works: {}",
                COMPOUND_EXAMPLE))));
        }
        if asks.len() > COMPOUND_OPS_MAX {
            return Ok(MessageContent::text(refusal_line(&fmt!(
                "compound: {} ops is more than the {} one call carries, and past that each \
                answer's share of the budget is too small to read. Nothing has been read: send \
                the first {} and the rest in a second call.",
                asks.len(), COMPOUND_OPS_MAX, COMPOUND_OPS_MAX))));
        }
        // CLAMPED TO WHAT THE TURN HAS LEFT, not merely to the result ceiling: a compound is the
        // one tool that can ask for six results at once, so a turn already near
        // `TURN_SPEND_BUDGET` must not be able to step over it in a single call.  The floor keeps
        // the header and the labels arriving when there is nothing left -- see
        // `COMPOUND_BUDGET_FLOOR`.
        let asked = crate::llm::extract_json_number(args_json, "budget").unwrap_or(0) as usize;
        let budget = match asked {
                0 => COMPOUND_BUDGET_DEFAULT,
                n => n,
            }
            .min(MAX_OUTPUT)
            .min(self.ctx.spend_left().max(COMPOUND_BUDGET_FLOOR));

        // Every op run before anything is cut, because the cut depends on what the answers
        // WEIGH and that is not known until they are in hand.  They are reads, so running them
        // all costs the time it costs and nothing else; what the turn pays for is the bytes that
        // survive the budget.
        let mut labels: Vec<String> = Vec::with_capacity(asks.len());
        let mut bodies: Vec<String> = Vec::with_capacity(asks.len());
        for one in &asks {
            labels.push(compound_op_label(one));
            let named = extract_json_string(one, "op").unwrap_or_default();
            let text = match compound_tool(&named) {
                Some(_) if extract_json_string(one, "as").is_some() => refusal_line(&fmt!(
                    "compound answers in text, so it cannot carry the picture 'as' asks for. \
                    Read the image with file_read on its own.")),
                Some(t) => {
                    // `op` is this tool's key and not the primitive's: handed on it would be
                    // reported back as an unknown argument by `guided`, naming a key the model
                    // was told to write.
                    let op_args = crate::llm::json_without_key(one, "op");
                    match self.dispatch_op(t.name(), &op_args, ctx).await {
                        Ok(c) => c.as_text().into_owned(),
                        // THE ROAD, WHICH IS NOT AN ANSWER. Written into an op's slot it would
                        // become text, and by then nothing can tell a request that never left
                        // the device from a host that said no -- the split `try_dispatch` turns
                        // on. The whole call fails and is climbed instead; every op is a read,
                        // so redoing them costs only the reading (`Tool::road_retryable`).
                        Err(e) => return Err(e),
                    }
                },
                None => refusal_line(&fmt!(
                    "compound: there is no '{}' op. The ops are {}, and every other key in the \
                    object is that op's own argument.",
                    clip_label(named.trim()), COMPOUND_OPS.join(", "))),
            };
            bodies.push(text);
        }

        // What became of each call, from its own opening word rather than from anything this
        // function believes about it: see `call_outcome`.
        let marks: Vec<CallOutcome> = bodies.iter().map(|b| call_outcome(b)).collect();
        let done    = marks.iter().filter(|m| matches!(m, CallOutcome::Done)).count();
        let refused = marks.iter().filter(|m| matches!(m, CallOutcome::Refused)).count();
        let failed  = marks.iter().filter(|m| matches!(m, CallOutcome::Failed)).count();

        // The frame -- the header line and every op's label -- is taken out of the budget before
        // the answers divide it, so a compound cannot be cut to the point where the labels
        // themselves go and the model is left with bodies it cannot tell apart.
        let frame: usize = COMPOUND_HEADER_ROOM
            + labels.iter().enumerate().map(|(i, l)| compound_head(i + 1, l).len()).sum::<usize>();
        let sizes: Vec<usize> = bodies.iter().map(|b| b.len()).collect();
        let shares = compound_shares(&sizes, budget.saturating_sub(frame));

        let mut cut: Vec<usize> = Vec::new();
        let mut body = String::with_capacity(budget.min(sizes.iter().sum::<usize>() + frame));
        for (i, text) in bodies.iter().enumerate() {
            body.push_str(&compound_head(i + 1, &labels[i]));
            if text.len() > shares[i] {
                cut.push(i + 1);
                // HEAD AND TAIL, never the head alone. A `file_read` page carries the notice
                // saying which lines it holds and the call that fetches the rest in its FOOT,
                // and so does a stopped search -- cut to its head, an answer loses the one
                // sentence that says how to get what is missing.
                body.push_str(&head_and_tail(text, shares[i]));
            } else {
                body.push_str(text);
            }
            body.push('\n');
        }

        let mut out = fmt!("compound: {} ops, {} done{}{}, {}/{} bytes{}\n",
            asks.len(), done,
            match refused { 0 => String::new(), n => fmt!(", {} refused", n) },
            match failed  { 0 => String::new(), n => fmt!(", {} failed", n) },
            body.len(), budget, compound_cut_said(&cut));
        out.push_str(&body);
        // A backstop and nothing more: the frame reservation above is what keeps the answers
        // inside the budget, and this is what makes the guarantee true whatever the labels came
        // out weighing.
        truncate_output(&mut out, budget.max(COMPOUND_BUDGET_FLOOR));
        // THE HEADER CARRIES THE VERDICT, so `call_outcome` reads one word about the call as a
        // whole while each op's own verdict stays in its slot. A compound where something was
        // read is work that was done, whatever else was refused beside it; one where nothing was
        // read is a refusal, and the model must not be able to book it as a read.
        Ok(MessageContent::text(match (done, refused, failed) {
            (0, r, 0) if r > 0 => refusal_line(&out),
            (0, _, f) if f > 0 => error_line(&out),
            _                  => out,
        }))
    }

    /// A failed call's result, with the two lines that say what to change.
    ///
    /// Both are silent on a call that worked, and both are about the CALL rather than the world:
    /// a key the schema does not name, and the one mistake this family makes with this tool.
    /// Returned unchanged in every other case, so a result that is already the answer is not
    /// lengthened by advice.
    ///
    /// # Arguments
    /// * `name` - The tool's wire name.
    /// * `args_json` - The arguments, after the pre-pass.
    pub(super) fn guided(&self, name: &str, args_json: &str, out: MessageContent) -> MessageContent {
        let text = out.as_text();
        if matches!(call_outcome(&text), CallOutcome::Done) {
            return out;
        }
        let mut add = String::new();
        // THE KEY IT INVENTED, echoed back. MiniMax sent `file_search {all, path, query}` and was
        // answered about the search rather than about the key, so it sent it again. A tool ignores
        // an unknown key silently, which is exactly why nothing was telling the model.
        if let Some(t) = Tool::from_name(name) {
            let known = schema_property_names(t.parameters());
            // A key the tool reads although its schema does not offer it is not unknown:
            // `capture` measures the `targets` a `crystal_look`, or the engine's own look, hands it.
            // `ask` reads `app`: the app's own Decision when a turn is blocked (`blocked_ask_args`)
            // carries it, so the page draws that card in the user's language; flagging it told
            // the daimon the app's key was its mistake (2026-10-12).
            let unoffered: &[&str] = match t {
                Tool::Capture	=> &["targets"],
                Tool::Ask		=> &["app"],
                _				=> &[],
            };
            let unknown: Vec<String> = crate::llm::json_top_level_keys(args_json).into_iter()
                .filter(|k| !known.iter().any(|p| p == k) && !unoffered.contains(&k.as_str()))
                .collect();
            if !unknown.is_empty() && !known.is_empty() {
                add.push_str(&fmt!("\nUnknown key(s) {}: {} reads {}.",
                    unknown.iter().map(|k| fmt!("'{}'", k)).collect::<Vec<_>>().join(", "),
                    name,
                    known.iter().map(|k| fmt!("'{}'", k)).collect::<Vec<_>>().join(", ")));
            }
        }
        // AND THE FAMILY'S OWN LINE, once per tool per turn.
        if let Some(hint) = self.family.get().hint(name) {
            let mut seen = self.hinted.borrow_mut();
            if !seen.contains(&hint) {
                seen.push(hint);
                add.push_str("\n");
                add.push_str(hint);
            }
        }
        if add.is_empty() {
            return out;
        }
        match out {
            MessageContent::Text(mut t) => {
                t.push_str(&add);
                MessageContent::text(t)
            },
            MessageContent::Parts(mut v) => {
                v.push(ContentPart::Text(add));
                MessageContent::parts(v)
            },
        }
    }

    /// The turn's own account of where it stands, appended once it is worth saying.
    ///
    /// **This is the half a per-call ceiling cannot do.** A model that learns the budget exists
    /// only when it is exhausted cannot plan around it, and the two calls that provoked this took
    /// 161,378 bytes without either of them being told anything at all.  So the line goes on the
    /// FIRST result that puts the turn past halfway, which is the result the model reads before it
    /// decides on the second read.
    ///
    /// **It names no allowance, and that is deliberate.**  Three sentences were scored against
    /// real model behaviour on 2026-08-25: a brief naming a tool moved an arm to use it, a refusal
    /// naming a byte figure moved a model to send that figure, and a brief forbidding a command
    /// changed nothing.  A number a model can watch approaching a wall is a number it will spend
    /// to.  What is here instead is the state in words and the cheaper commands by name.
    ///
    /// # Arguments
    /// * `out` - The tool's result, returned unchanged while the turn has room.
    /// * `ctx` - The turn whose ledger is read.
    pub(super) fn with_budget_line(out: MessageContent, ctx: &ToolContext<H>) -> MessageContent {
        if !ctx.spend_is_short() {
            return out;
        }
        // Whether the cheaper commands have ALREADY been named in this very result, by the spend
        // notice on the command that provoked the line. Where they have, the turn's line says only
        // what the notice could not -- that this is about the turn and not about that one command.
        let priced = out.as_text().contains(SPEND_NOTICE_MARK);
        let line = match (ctx.spend_left() == 0, priced) {
            // Said, in this result, in the notice above. Saying it twice is how a reader learns to
            // skip both.
            (true, true)   => return out,
            (true, false)  =>
                "\n[budget] Results are being narrowed from here, and the turn continues. A question whose \
                ANSWER is small still arrives whole: grep -n for a name, sed -n for a line range, \
                wc -l for a count. A whole file will not arrive.",
            (false, true)  =>
                "\n[budget] Results are being narrowed and the turn continues. The narrower question \
                just named is the one to ask next as well, not only for this file.",
            (false, false) =>
                "\n[budget] Results are being narrowed from here, and the turn continues. Ask for the \
                part you need from here -- grep -n for a name, sed -n for a line range, wc -l for \
                a count -- rather than for a whole file, which will be cut.",
        };
        match out {
            MessageContent::Text(mut t) => {
                t.push_str(line);
                MessageContent::text(t)
            },
            MessageContent::Parts(mut v) => {
                v.push(ContentPart::Text(line.to_string()));
                MessageContent::parts(v)
            },
        }
    }
}


// ┌───────────────────────────────────────────────────────────────┐
// │ Tests                                                          │
// └───────────────────────────────────────────────────────────────┘


// Test-only synchronous shim for the file tools (which are sync anyway).
#[cfg(test)]
impl Tool {
    /// The synchronous path used by the tests, through the same guard the dispatcher applies, so a
    /// test cannot pass through a door the real code closes.
    pub(super) fn execute_sync_guarded(&self, args: &str, ctx: &ToolContext) -> Outcome<MessageContent> {
        let unslashed = trailing_slash_args(self, args);
        let args = match &unslashed {
            Some(u) => u.as_str(),
            None    => args,
        };
        if let Some(refusal) = res!(self.guard(args, ctx)) {
            return Ok(MessageContent::text(refusal));
        }
        self.execute_sync(args, ctx)
    }

    pub(super) fn execute_sync(&self, args: &str, ctx: &ToolContext) -> Outcome<MessageContent> {
        let text = res!(match self {
            Tool::FileRead   => return Self::local_file_read(args, ctx),
            Tool::FileWrite  => Self::local_file_write(args, ctx),
            Tool::FileEdit   => Self::local_file_edit(args, ctx),
            Tool::FileList   => Self::local_file_list(args, ctx),
            Tool::FileSearch => Self::local_file_search(args, ctx),
            Tool::Outline    => Self::local_outline(args, ctx),
            Tool::FileGlob   => Self::local_file_glob(args, ctx),
            Tool::FileDelete => Self::local_file_delete(args, ctx),
            Tool::FileRevert => Err(err!(
                "Tool 'file_revert' puts a file back from a Diamond's version store, which the \
                browser build keeps; this is the native build, which has no Diamond and no \
                store."; Unimplemented)),
            Tool::FileMove   => Self::local_file_move(args, ctx),
            Tool::DirCreate  => Self::local_dir_create(args, ctx),
            Tool::SheetRead  => Self::local_sheet_read(args, ctx),
            Tool::DocEdit    => Self::local_doc_edit(args, ctx),
            Tool::SheetWrite => Self::local_sheet_write(args, ctx),
            Tool::ArtefactAdd => Err(err!("use execute() for artefact_add"; Invalid)),
            Tool::FileFetch  => Self::local_cloud_unavailable(),
            // There is no panel in a test process and no user in front of one.  What IS testable
            // here is the sentence the tool composes about what it drew, and `show_result` is
            // called directly for that -- see the `file_show` tests.
            Tool::FileShow   => Err(err!(
                "file_show needs the browser's document panel."; Unimplemented)),
            // The picture is drawn from the browser's live DOM through `DaimondShot`, and a test
            // process has no page to photograph -- the same shape as `file_show` above.
            Tool::Capture    => Err(err!(
                "capture needs the browser's DOM to photograph."; Unimplemented)),
            Tool::CrystalLook => Err(err!(
                "crystal_look needs the browser to draw the page."; Unimplemented)),
            // The policy is `ask_step`, which is pure and is called directly by the tests.  What
            // is left here is the card and the person in front of it, and a test process has
            // neither.
            Tool::Ask        => Err(err!(
                "ask needs the browser's question card."; Unimplemented)),
            // The policy in both of these is `social_read_step` and `social_send_step`, which
            // are pure and are called directly by the tests.  What is left here is the panel and
            // the person in front of it, and a test process has neither.
            Tool::SocialRead | Tool::SocialSend => Err(err!(
                "social_read and social_send need the browser's Social panel."; Unimplemented)),
            Tool::Shell      => Err(err!("use execute() for shell"; Invalid)),
            Tool::Run        => Err(err!("use execute() for run"; Invalid)),
            Tool::Runs       => Err(err!("use execute() for runs"; Invalid)),
            Tool::Verify     => Err(err!("use execute() for verify"; Invalid)),
            Tool::Serve      => Err(err!("use execute() for serve"; Invalid)),
            Tool::SpawnAgent => Self::spawn_agent(args, ctx),
            Tool::Gather     => Self::gather_scripted(args, ctx),
            Tool::WebOpen
            | Tool::WebClose
            | Tool::WebFetch
            | Tool::WebSearch
            | Tool::WebSnapshot
            | Tool::WebRead
            | Tool::WebClick
            | Tool::WebType
            | Tool::WebScroll => Self::local_web_unavailable(),
            Tool::TypstCompile => Err(err!(
                "typst_compile needs the browser's bundled compiler."; Unimplemented)),
            Tool::LinkList | Tool::LinkAdd | Tool::LinkRemove => Self::links_unavailable(),
            Tool::CrystalRead | Tool::Recall => Err(err!(
                "crystal_read and recall reach the Diamond store, which is the browser's.";
                Unimplemented)),
            // The transport is the browser's `DaimondOcr`; the testable half is the body
            // builders and response parsers, which the OCR tests call directly.
            Tool::Ocr        => Err(err!(
                "ocr needs the browser's OCR bridge."; Unimplemented)),
            Tool::ImageEdit  => Err(err!(
                "image_edit needs the browser's or the runner's image route."; Unimplemented)),
            Tool::MailList | Tool::MailSearch | Tool::MailRead | Tool::MailDraft =>
                Self::mail_unavailable(),
            Tool::PendingNone => pending_none(ctx),
            Tool::StateSet => Err(err!(
                "Tool 'state_set' sets a section of a Diamond's STATE.md in the browser's storage; \
                this is the native build, which has no Diamonds in it."; Unimplemented)),
            Tool::PendingRaise | Tool::PendingClear => Err(err!(
                "Tool '{}' puts an alert on Daimond's Pending panel, which is part of the browser \
                page; this is the native build, which has no panel and nobody reading one.",
                self.name(); Unimplemented)),
            // The registry runs this one; the tests reach it through `ToolRegistry::compound`.
            Tool::Compound   => Err(err!("use ToolRegistry::compound for compound"; Invalid)),
        });
        Ok(MessageContent::text(text))
    }

}





// ┌───────────────────────────────────────────────────────────────┐
// │ Tests: what a call claims about the store                      │
// └───────────────────────────────────────────────────────────────┘


// ┌───────────────────────────────────────────────────────────────┐
// │ The load proof, taken from outside the page (K1, K3)          │
// └───────────────────────────────────────────────────────────────┘
//
// D-20261008-08: a daimon wrote the Ontheism infographic, the page drew an empty card, a JSON dump
// and a key map for two turns, and the daimon said it was done.  Its own probe measured boxes, not
// whether the reader could see the crystal.  The proof reads the page as the owner does -- its
// visible text and what it draws -- after every edit of the page or its data, and a page that
// fails it is a must-fix line in that edit's result and the turn's `Blocked` reason (unit G).

// 9 Oct 2026: the Life log daimon was asked to "make the button heights consistent", added the same
// rule to both button classes, made every button 3.3 px shorter and said it was done; it had never
// seen the page.  `crystal_look` draws the page as the owner sees it and measures what is named,
// and since D-20261009-27 the engine looks itself after a page edit (`auto_look_args`).

pub const LOOK_TARGETS_MAX:  usize = 8;     // targets one crystal_look measures
pub const LOOK_TARGET_CHARS: usize = 120;   // the longest target
pub const LOOK_TAPS_MAX:     usize = 4;     // taps before one crystal_look measures
pub const LOOK_MAX_W:        u32   = 960;   // the picture's widest, px
pub const LOOK_DESK:         u32   = 1440;
pub const LOOK_PHONE:        u32   = 390;
/// How an edit's result opens the measurement it took again by itself after a look.
pub const REMEASURE_HEAD: &str = "After this edit, the same measurement";

// D-20261009-27 ("it should be able to view the crystal pixels itself, can it, and why isn't it??"):
// a look the daimon must remember to take is a look a text-only daimon skips.  So the ENGINE looks:
// a turn that wrote the page and has not looked since is handed one look, at a phone and a desktop
// width, before it may end, measuring the selectors its style edits named.

pub const LOOK_AUTO_ID: &str = "look_auto";   // the id the engine's own look is called by
/// What opens the result of the engine's own look, so the daimon reads it as its page now.
pub const LOOK_AUTO_HEAD: &str = "The engine looked at your page as its owner sees it, after your \
    last edit. Compare it with what was asked and with what it measured before, and put the \
    measured difference in your answer; if nothing changed, say so plainly.";
// The tags a style edit's selector may name bare; anything else needs a class, id or attribute,
// so `else {` or `try {` in a script is not taken for a selector.
pub(super) const LOOK_TAGS: &[&str] = &[
    "a", "body", "button", "div", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header",
    "img", "input", "label", "li", "main", "nav", "ol", "p", "section", "select", "span", "svg",
    "table", "td", "textarea", "th", "tr", "ul",
];

/// The selectors of the CSS rules a page edit's arguments name, pseudo-classes dropped, in order,
/// once each, at most [`LOOK_TARGETS_MAX`].
pub fn style_targets(args: &str) -> Vec<String> {
    let text = args.replace("\\n", "\n").replace("\\t", " ").replace("\\\"", "\"");
    let mut out: Vec<String> = Vec::new();
    let mut from = 0;
    for (i, c) in text.char_indices() {
        // A quote ends a segment too: in the arguments' JSON the page's text opens after one.
        if c == '}' || c == ';' || c == '>' || c == '\n' || c == '"' {
            from = i + 1;
        } else if c == '{' {
            for sel in text[from..i].split(',') {
                let sel = sel.split(':').next().unwrap_or_default().trim();
                let tag = sel.chars().all(|c| c.is_ascii_alphanumeric()) && LOOK_TAGS.contains(&sel);
                let ok = !sel.is_empty() && sel.chars().count() <= LOOK_TARGET_CHARS
                    && (tag || sel.contains('.') || sel.contains('#') || sel.contains('['))
                    && sel.chars().all(|c| c.is_ascii_alphanumeric() || " .#-_[]=+~*".contains(c));
                if ok && !out.iter().any(|o| o == sel) && out.len() < LOOK_TARGETS_MAX {
                    out.push(sel.to_string());
                }
            }
            from = i + 1;
        }
    }
    out
}

/// The `capture` arguments of the engine's own look at Diamond `id`: the stored page at a phone
/// and a desktop width, pictures capped as `crystal_look`'s are, measuring `targets`.
pub fn auto_look_args(id: &str, targets: &[String]) -> String {
    let each: Vec<String> = targets.iter().map(|t| fmt!("\"{}\"", json_escape(t))).collect();
    fmt!(r#"{{"in":"crystal","max_w":{},"path":"diamonds/{}/shots/look.png","targets":[{}]}}"#,
        LOOK_MAX_W, json_escape(id), each.join(","))
}

pub const PROOF_GRAPHICS_MIN: u32 = 3;     // svg, canvas, img, bar or chart elements an infographic draws
pub const PROOF_WIDTH:        u32 = 1440;  // a desktop's, where the owner reads it

/// The fewest graphics the page must draw for an ask: [`PROOF_GRAPHICS_MIN`] when the ask names
/// an infographic, else 0.
pub fn proof_graphics_min(ask: &str) -> u32 {
    let low = ask.to_lowercase();
    if ["infographic", "info-graphic", "info graphic"].iter().any(|w| low.contains(w)) {
        PROOF_GRAPHICS_MIN
    } else {
        0
    }
}

/// What the load proof found, as the driver answered it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct CrystalProof {
    pub pass:   bool,
    pub why:    String,     // the driver's reasons, empty on a pass
    pub debug:  u32,        // debug nodes shown: #dbg, <pre>, KEYMAP, DKEYS
    pub before: Option<u32>,// debug nodes at the last passing version, when one is marked
    pub page:   Option<String>,// mark of the page it read (`crystal_page_mark`), None if unread
    pub wrote:  bool,       // the turn wrote that page itself, by this write or an earlier one
}

impl CrystalProof {
    /// Read the driver's `proof` line, `pass` or `FAIL: <reasons>`, with its debug count.
    pub fn from_driver(line: &str, debug: u32) -> Option<Self> {
        let line = line.trim();
        if line == "pass" {
            return Some(Self { pass: true, why: String::new(), debug, before: None, page: None, wrote: false });
        }
        line.strip_prefix("FAIL:").map(|why| Self {
            pass: false, why: why.trim().chars().take(400).collect(), debug, before: None, page: None, wrote: false })
    }

    /// The line the turn may not end over, or `None` when the page passes and holds no new
    /// debug node.
    pub fn must_fix(&self) -> Option<String> {
        if !self.pass {
            return Some(fmt!(
                "MUST FIX before this turn ends: the Diamond's page fails the load proof, read from \
                 outside as the owner sees it -- {}. Mend crystal.html or crystal.json; the page is \
                 not delivered until it passes.", self.why.trim_end_matches('.')));
        }
        debug_node_check(self.debug, self.before)
    }

    /// The sentence a turn ended over a failing proof gives the person, or `None` on a pass.
    pub fn said(&self) -> Option<String> {
        if !self.pass {
            return Some(fmt!("Not done: the page does not load as you would see it -- {}.",
                self.why.trim_end_matches('.')));
        }
        debug_node_check(self.debug, self.before).map(|_| "Not done: the page still shows debug \
            output (#dbg, <pre>, KEYMAP or DKEYS) its last working version did not.".to_string())
    }

    /// What an edit's result says of the proof.
    pub fn line(&self) -> String {
        match self.must_fix() {
            Some(m) => m,
            None    => "Load proof: pass -- the page shows its title, summary and every section, \
                        and no debug output.".to_string(),
        }
    }
}

/// K3: a debug node the page shows at the turn's end that its last passing version did not is a
/// must-fix: `#dbg`, a `<pre>`, a KEYMAP or a DKEYS left on screen is a page still being debugged.
///
/// # Arguments
/// * `now` - Debug nodes the page shows now.
/// * `before` - Debug nodes at the last version that passed, `None` when none is marked.
pub fn debug_node_check(now: u32, before: Option<u32>) -> Option<String> {
    let was = before.unwrap_or(0);
    if now <= was {
        return None;
    }
    Some(fmt!(
        "MUST FIX before this turn ends: the Diamond's page shows {} debug node{} (#dbg, <pre>, \
         KEYMAP or DKEYS) its last passing version did not. Take {} out.",
        now - was, if now - was == 1 { "" } else { "s" }, if now - was == 1 { "it" } else { "them" }))
}

/// The last version of a Diamond's page that passed the load proof, as
/// `.daimond/crystal_passed.json` holds it.  The interface K2 restores from.
#[derive(Clone, Debug, Default, PartialEq, ToDat, FromDat)]
pub struct CrystalPassed {
    pub version: u64,       // the newest recorded version when it passed
    pub at:      u64,       // ms since the epoch
    pub page:    String,    // sha256 of crystal.html as it passed, empty for the shipped page
    pub data:    String,    // sha256 of crystal.json as it passed
    pub debug:   u32,       // debug nodes it showed
}

impl CrystalPassed {
    pub fn to_json(&self) -> String {
        fmt!(r#"{{"version":{},"at":{},"page":"{}","data":"{}","debug":{}}}"#,
            self.version, self.at, json_escape(&self.page), json_escape(&self.data), self.debug)
    }

    pub fn from_json(s: &str) -> Option<Self> {
        let version = match extract_json_number(s, "version") {
            Some(v) => v as u64,
            None    => return None,
        };
        Some(Self {
            version,
            at:      extract_json_number(s, "at").unwrap_or(0) as u64,
            page:    extract_json_string(s, "page").unwrap_or_default(),
            data:    extract_json_string(s, "data").unwrap_or_default(),
            debug:   extract_json_number(s, "debug").unwrap_or(0) as u32,
        })
    }
}

/// The page's console and channel messages as a block for a tool result, `""` when it said
/// nothing.  The driver has already capped and scrubbed the lines.
pub fn page_trace_block(trace: &str) -> String {
    let t = trace.trim();
    if t.is_empty() {
        return String::new();
    }
    fmt!("\nThe page's console and messages while it drew, oldest first:\n{}\n\n", t)
}

/// What the person's viewer showed in place of the page since the daimon's last turn, as a note
/// for its next one: one line a fallback, newest last, at most `n` of them.
///
/// # Arguments
/// * `jsonl` - `.daimond/crystal_viewer.jsonl`, one `{"reason":..,"missed":[..]}` a line.
pub fn viewer_fallback_note(jsonl: &str, n: usize) -> String {
    let mut lines: Vec<String> = Vec::new();
    for raw in jsonl.lines().filter(|l| !l.trim().is_empty()) {
        let why    = extract_json_string(raw, "reason").unwrap_or_default();
        let missed = extract_json_string_array(raw, "missed").unwrap_or_default();
        let what = match why.as_str() {
            "timeout"  => "did not load, so the plain data view stood in".to_string(),
            "undrawn"  => fmt!("loaded but did not draw: {}", missed.join(", ")),
            "partial"  => "did not show everything it holds, so the plain data view stood in".to_string(),
            other      => fmt!("fell back ({})", other.chars().take(24).collect::<String>()),
        };
        lines.push(fmt!("- the page {}", what));
    }
    if lines.is_empty() {
        return String::new();
    }
    let over = lines.len().saturating_sub(n);
    fmt!("Since your last turn, the person's viewer showed this Diamond's page fail:\n{}",
        lines[over..].join("\n"))
}

// ┌───────────────────────────────────────────────────────────────┐
// │ The crystal load proof (r542 K1)                              │
// └───────────────────────────────────────────────────────────────┘



/// A page as [`CrystalPassed::page`] names it: the sha256 of the page, or empty for no page of its
/// own, which shows the shipped one.
pub fn crystal_page_mark(page: &str) -> String {
    if page.trim().is_empty() {
        String::new()
    } else {
        crate::diamond_versions::hash_of(page.as_bytes())
    }
}

/// The failing load proof a turn's end warns over (K2), or `None` when it says nothing.
///
/// Only this turn's own verdict counts: the last proof the turn took failed, the page it read is
/// one this turn wrote, and that page is still in place.  A page written
/// elsewhere, one the daimon put back with `file_revert`, or one no proof read this turn was
/// never judged by this turn, and a false "fix it" is worse than no warning.
///
/// # Arguments
/// * `last` - the turn's last proof ([`ToolContext::last_proof`]).
/// * `after` - the page as the turn left it.
pub fn unproven_left(last: Option<CrystalProof>, after: &str) -> Option<CrystalProof> {
    let mark = crystal_page_mark(after);
    last.filter(|p| !p.pass && p.wrote && p.page.as_deref() == Some(mark.as_str()))
}



// ┌───────────────────────────────────────────────────────────────┐
// │ The mend of a broken crystal under the hot ceiling (r546)     │
// └───────────────────────────────────────────────────────────────┘
