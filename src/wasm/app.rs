//! The browser agent surface — a `#[wasm_bindgen]` [`DaimondApp`] that runs a
//! real [`Agent`] turn and streams [`AgentEvent`]s to a JS callback.
//!
//! This is the Stage 3 completion: the agent loop itself running in the
//! browser, not merely a transport probe.  A [`DaimondApp`] owns a
//! [`Session`], an [`Agent`] (built on the wasm [`LlmClient`]), and a
//! [`ToolRegistry`].  [`DaimondApp::run_turn`] drives
//! [`Agent::run_turn`](crate::agent::Agent::run_turn), forwarding each
//! streamed event to the supplied `on_event` function as a plain JS
//! object.
//!
//! With tools disabled the turn takes the pure-streaming path (SSE token
//! deltas); with tools enabled it takes the agentic tool loop, whose file
//! tools are backed by the OPFS edge (see [`crate::tools`]).

use crate::agent::Agent;
use crate::llm::{LlmClient, parse_json_string_array};
use crate::prompts::Role;
use crate::protocol::{AgentEvent, ChatMessage, Session, ToolCall, generate_session_id};
use crate::tools::{Tool, ToolContext, ToolRegistry};
use crate::executor::Executor;
use crate::workspace::Workspace;
use crate::wasm::{diamond, js_prop, to_js_err};

use oxedyne_fe2o3_core::prelude::*;

use std::cell::RefCell;
use std::path::PathBuf;

use wasm_bindgen::prelude::*;


/// The browser-side Daimond application: one session driven by the agent
/// loop over the wasm transport.
///
/// The `session` sits behind a [`RefCell`] so [`DaimondApp::run_turn`] can
/// take `&self` rather than `&mut self`.  That matters for cancellation:
/// wasm-bindgen guards each exported call with a shared/exclusive borrow
/// of the whole object, so a `&mut self` turn held across `await` would
/// block a concurrent [`DaimondApp::abort`] call (an exclusive borrow cannot
/// coexist).  With both taking `&self`, their shared borrows coexist and
/// the Stop button can fire mid-turn.
#[wasm_bindgen]
pub struct DaimondApp {
    agent:    Agent,
    session:  RefCell<Session>,
    registry: ToolRegistry,
    /// The user's standing instructions (their `DAIMOND.md`), prepended to the
    /// system prompt of every turn this app runs.  Chats and workers are
    /// constructed with their system prompt already composed, but the
    /// daimon's and the reducer's are built here, so they read it from this.
    instructions: RefCell<String>,
    /// The user's replacement for the daimon's role prompt, if they have
    /// written one (`prompts/daimon.md`).  Empty means the default.
    ///
    /// Only these two roles are held here.  A chat and a worker are constructed
    /// with their prompt already composed by the caller, so their file is read
    /// in the browser; the daimon and the reducer are built inside this
    /// module, where the file is not in reach.
    daimon_prompt: RefCell<String>,
    /// The same, for the reducer (`prompts/reducer.md`).
    reducer_prompt: RefCell<String>,
}

#[wasm_bindgen]
impl DaimondApp {

    /// Construct a [`DaimondApp`].
    ///
    /// `base_url` is the full chat-completions endpoint, e.g.
    /// `https://api.provider.com/v1/chat/completions` or, for a local
    /// mock, `http://127.0.0.1:8081/v1/chat/completions`; the scheme
    /// selects the transport's `secure` flag.  When `enable_tools` is
    /// set, the OPFS-backed file tools (`file_write`, `file_read`) are
    /// registered and the turn runs the agentic tool loop.
    #[wasm_bindgen(constructor)]
    pub fn new(
        base_url:      String,
        api_key:       String,
        model:         String,
        max_tokens:    u32,
        system_prompt: String,
        enable_tools:  bool,
    )
        -> Result<DaimondApp, JsValue>
    {
        Self::build(&base_url, &api_key, &model, max_tokens, &system_prompt, enable_tools)
            .map_err(to_js_err)
    }

    /// Inner constructor returning an [`Outcome`], so the URL parse and
    /// client build use the error macros; the `#[wasm_bindgen]` wrapper
    /// maps the result to the JS boundary.
    fn build(
        base_url:      &str,
        api_key:       &str,
        model:         &str,
        max_tokens:    u32,
        system_prompt: &str,
        enable_tools:  bool,
    )
        -> Outcome<DaimondApp>
    {
        let (secure, host, port, path) = res!(parse_base_url(base_url));
        let llm = LlmClient::new_with_scheme(&host, port, &path, api_key, model, max_tokens, secure);
        let agent = Agent::new(llm, system_prompt);

        let session = Session::new(
            crate::protocol::generate_session_id(),
            "browser".to_string(),
            model.to_string(),
        );

        // The OPFS edge does its own path jailing, so the workspace root
        // is nominal; `Executor::Wasm` escalates any shell attempt.
        let ctx = ToolContext {
            workspace:   Workspace::unchecked(PathBuf::from("/")),
            executor:    Executor::Wasm,
            cwd:         String::new(),
            path_prefix: String::new(),
            // The main workspace agent follows an FSA real folder when one
            // is open, else the OPFS sandbox.
            root:        crate::tools::FileRoot::Workspace,
            read_seen:   crate::tools::new_read_cache(),
            // The browser agent is the user's own, not a skill's, so nothing is locked out of it.
            // A skill turn narrows this in the handler, where the declaration is known.
            no_write:    Vec::new(),
            // A chat acts for no Diamond, so a link tool in one must be told which it means.
            daimon_of:   String::new(),
        };
        // The whole file toolset is OPFS-backed in the browser; only the
        // shell tool has no in-browser executor, so it is left out.
        //
        // The web tools come too.  They are offered even when no driver is
        // attached, because `web_fetch` reads any page through the gateway
        // whatever the browser allows, and because the rest refuse in plain
        // English that tells the model what to do instead -- which is more
        // use to it than not knowing the web exists.
        let tools = if enable_tools {
            Tool::browser()
        } else {
            Vec::new()
        };
        let registry = ToolRegistry::new(tools, ctx);

        Ok(DaimondApp {
            agent,
            session: RefCell::new(session),
            registry,
            instructions:     RefCell::new(String::new()),
            daimon_prompt: RefCell::new(String::new()),
            reducer_prompt:   RefCell::new(String::new()),
        })
    }

    /// Run one agent turn for `user_msg`, invoking `on_event` once per
    /// streamed [`AgentEvent`] with a plain JS object (see
    /// [`event_to_js`]).  Resolves when the turn completes; rejects with
    /// the stringified error on failure.
    pub async fn run_turn(
        &self,
        user_msg: String,
        on_event: js_sys::Function,
    )
        -> Result<(), JsValue>
    {
        // A `/name` the user typed, resolved to the file's own text BEFORE the turn starts.
        // Deterministic, and it either happens or is refused out loud -- unlike telling the model
        // to go and read the file, where a model that does not bother produces a plausible session
        // that skipped the instructions and nobody can tell.
        let user_msg = match open_command(user_msg).await {
            Opened::Send(text)  => text,
            Opened::Refuse(msg) => return Err(to_js_err(refuse(&msg))),
        };
        // Which model is carrying this turn, and what it can reach, refreshed now rather than at
        // construction: the fence depends on the Diamond's bounds and on whether the turn is
        // tainted, and asking the hand needs an await the constructor does not have.
        let brief = self.briefing(&self.registry).await;
        self.agent.set_briefing(&brief);

        let mut sink = |ev: AgentEvent| {
            let js = event_to_js(&ev);
            // A callback that throws must not abort the turn; ignore the
            // JS-side result deliberately.
            let _ = on_event.call1(&JsValue::NULL, &js);
        };
        let mut session = self.session.borrow_mut();
        self.agent
            .run_turn(&mut session, user_msg, &self.registry, &mut sink)
            .await
            .map_err(to_js_err)
    }

    /// Cancel the in-flight turn.  Fires the transport's abort signal, so
    /// the streaming `fetch` errors out, the current round ends, and
    /// [`DaimondApp::run_turn`] resolves with the partial answer kept.  Safe
    /// to call when idle: with no request in flight it is a no-op.
    pub fn abort(&self) {
        self.agent.llm.abort();
    }

    // ── Speaking into a turn that is already running ─────────────────────
    //
    // The four calls the browser needs to put a mid-turn correction where a model
    // can act on it, and to get it back if it never got there.  All take `&self`,
    // like [`DaimondApp::abort`] and for the same reason: wasm-bindgen guards each
    // exported call with a borrow of the whole object, and an exclusive one could
    // not coexist with the turn already running.
    //
    // Nothing here reaches the provider.  The queue is read at the seam between
    // one round and the next (see [`crate::agent::Interjections`]), so a turn
    // spending its whole length writing prose has nowhere to put one, and
    // [`DaimondApp::take_interjections`] is how the browser gets it back rather
    // than losing it.

    /// Say something into the turn this app is running.
    ///
    /// Returns how many are now waiting, so the caller can draw them without
    /// reaching into the queue.  Blank input is ignored rather than queued.
    ///
    /// # Arguments
    /// * `text` - What the user said while the turn was in flight.
    pub fn interject(&self, text: String) -> usize {
        self.agent.interject(&text)
    }

    /// Take back everything that never made it in, leaving the queue empty.
    ///
    /// Called by the browser when the turn ends.  A turn with no tool call in it
    /// has no seam, so what the user typed can still be waiting when it finishes;
    /// handing it back here is what lets the browser fall back to sending it as
    /// its own turn -- or returning it to the composer, if the turn failed or was
    /// stopped.  Silently dropping it would be the one outcome a correction must
    /// never have.
    pub fn take_interjections(&self) -> js_sys::Array {
        let out = js_sys::Array::new();
        let mut q = self.agent.interject.borrow_mut();
        for said in std::mem::take(&mut *q) {
            out.push(&JsValue::from_str(&said));
        }
        out
    }

    /// Take one waiting message back out, by position, returning what it said.
    ///
    /// Backs the × and the click-to-edit on a waiting bubble: a message not yet
    /// delivered must be as easy to withdraw as it was to type.  A position past
    /// the end yields `None` rather than an error -- the queue drains on its own
    /// timing, so the row a click was aimed at may already have gone in.
    ///
    /// # Arguments
    /// * `index` - Position in the queue, oldest first.
    pub fn drop_interjection(&self, index: usize) -> Option<String> {
        let mut q = self.agent.interject.borrow_mut();
        if index >= q.len() {
            return None;
        }
        Some(q.remove(index))
    }

    /// Whether this app's turn has taken in content from outside the user — a fetched page, a
    /// mail message, a command's output.
    ///
    /// The daimon reads this after a steering turn to find out whether the tasks it is about to
    /// hand out derive from a stranger's words.
    pub fn is_tainted(&self) -> bool {
        self.registry.ctx.is_tainted()
    }

    /// Mark this app's turn as carrying content from outside the user, without reading any.
    ///
    /// One-way, like the flag itself.  A worker starts with a clean flag, so instructions absorbed
    /// from a stranger could be laundered through a worker that does not know it is carrying them;
    /// the daimon closes that by setting this on each worker it starts.
    pub fn set_tainted(&self) {
        self.registry.ctx.set_tainted();
    }

    /// Mark this agent as acting ALONE: a dispatched worker, with nobody reading its transcript
    /// and no way to put a question.
    ///
    /// Called on every worker, from a chat and from a Diamond alike, and on nothing else.
    ///
    /// It is not a fence and does not pretend to be.  The fence is a list of paths; what this
    /// governs is the two things the fence has no vocabulary for -- pressing a button on a page
    /// the user is signed into, and reaching the network from inside a command.  Both are named in
    /// [`crate::prompts::SAFETY_CLAUSE`], which every worker is told and no worker can obey,
    /// because the same prompt tells it that it cannot ask questions.  So the app asks instead.
    ///
    /// One-way, like [`DaimondApp::set_tainted`], and for the same reason: an agent does not
    /// acquire a supervisor part way through.
    pub fn set_unsupervised(&self) {
        self.registry.ctx.set_unsupervised();
    }

    /// Whether this agent is acting alone, so a caller can prove the mark went on rather than
    /// assume it.
    ///
    /// The same discipline the scope is read back with: everything that can go wrong when a
    /// security mark is set from JavaScript is silent, and every silent failure is in the
    /// direction of less asking.
    pub fn is_unsupervised(&self) -> bool {
        self.registry.ctx.is_unsupervised()
    }

    /// What this chat's commands may do about the network, in one word for the control that shows
    /// it.
    ///
    /// Composed by [`crate::tools::net_step`], the same function [`crate::tools::Tool::run`] builds
    /// the fence from, so the word on screen and the network a command actually gets are one
    /// decision.  A second reading of the flags here would be a view that can disagree with the
    /// wire, which is the fault the Wire view exists to avoid.
    ///
    /// Until this existed there was no way to find out whether a chat was cut off except to run a
    /// command and be interrupted by the question.
    ///
    /// * `open` -- nothing is withheld: the chat has read nothing from outside, or the rung
    ///   withholds nothing.
    /// * `cut` -- withheld, and the next command puts the question.
    /// * `allowed` -- withheld, and the user gave it back.
    /// * `refused` -- withheld, and the user said no.
    /// * `alone` -- withheld with nobody to ask, which is a worker rather than a chat.
    pub fn net_state(&self) -> String {
        let ctx  = &self.registry.ctx;
        let step = crate::tools::net_step(
            crate::tools::mode(), ctx.net_risk(), ctx.is_unsupervised(), ctx.net_consent());
        match step {
            crate::tools::NetStep::Give     => "open",
            crate::tools::NetStep::Restored => "allowed",
            crate::tools::NetStep::Ask      => "cut",
            crate::tools::NetStep::Withhold =>
                if ctx.is_unsupervised() { "alone" } else { "refused" },
        }.to_string()
    }

    /// Set what this chat's commands may do about the network, from the user's own control.
    ///
    /// Returns the state that is now in force, read back out of the engine rather than assumed --
    /// the discipline every security mark set from JavaScript is held to here, because every
    /// silent failure in this direction is a page claiming a fence it has not got.
    ///
    /// `allow` and `refuse` answer for this chat; anything else forgets the answer, so the next
    /// command asks again.  It may overwrite, which the dialog's own recorder may not: see
    /// [`crate::tools::ToolContext::override_net_consent`] for why those are different acts.
    ///
    /// # Arguments
    /// * `answer` - `allow`, `refuse`, or anything else to forget it.
    pub fn set_net_answer(&self, answer: &str) -> String {
        let v = match answer {
            "allow"  => Some(crate::tools::Verdict::Allow),
            "refuse" => Some(crate::tools::Verdict::Deny),
            _        => None,
        };
        self.registry.ctx.override_net_consent(v);
        self.net_state()
    }

    /// Offer this agent the dispatch tool, so the user's own chat can send workers out.
    ///
    /// NOT in [`crate::tools::Tool::browser`], which is the list a worker is built from too: a
    /// worker that could dispatch workers is a fan-out with no bottom.  So the capability is added
    /// after construction, by the one caller that builds a chat, and a worker never calls this.
    ///
    /// Idempotent, and one-way.  There is no taking it away: a capability that can be removed is
    /// one a caller can be persuaded to remove.
    pub fn allow_dispatch(&mut self) {
        if !self.registry.tools.contains(&Tool::SpawnAgent) {
            self.registry.tools.push(Tool::SpawnAgent);
        }
    }

    /// Whether this agent holds the dispatch tool.
    pub fn can_dispatch(&self) -> bool {
        self.registry.tools.contains(&Tool::SpawnAgent)
    }

    /// Confine a chat to its own WORKSPACE -- its own turn, and every worker it dispatches.
    ///
    /// **Call this on the chat's own app as well as on its workers.**  It was called on workers
    /// alone until 2026-08-11, which meant the confinement was drawn around the thing that was
    /// dispatched rather than around the conversation that dispatched it -- and the conversation is
    /// what actually edits files.  On that day a daimon in an ordinary chat edited two files of the
    /// user's own book, in a directory under no version control, and put them back only because it
    /// chose to.  A worker fence would not have stopped it, because no worker was involved.
    ///
    /// The remedy is a WORKING DIRECTORY and not a permission dialog.  Nothing here asks the user
    /// anything: the friction is paid once, when a folder is nominated with the paperclip, and
    /// inside that folder the model works exactly as freely as it did before.  Attaching is the
    /// permission.  A fence that also interrupts would have missed the point twice over -- and the
    /// permission ladder, which is where interruption lives, is a separate mechanism this does not
    /// touch.
    ///
    /// The bounds are [`crate::tools::chat_bounds`], which is [`crate::tools::diamond_bounds`]:
    /// **writing and running are fenced to the workspace, and reading is free** inside whatever the
    /// user already opened.  The verb decides, not the surface, and the argument for it is on
    /// [`crate::tools::Bound::OnlyWriteUnder`].  For one day in August 2026 this said the opposite,
    /// because the delegation that fenced the conversation also fenced its reading -- which nobody
    /// decided and which took the user's own files away from their own chat.
    ///
    /// **`workspace` is what the user MARKED into this chat's workspace, and not the paperclip's
    /// whole attachment list.**  An attachment carries two independent things: Note or Read, which
    /// is a cost decision about what is quoted into the prompt and grants no reach whatever; and
    /// the workspace mark, which is what reaches here.  A path can be in the workspace and Read at
    /// once.  A caller that handed over everything attached would have made Note into a grant.
    ///
    /// `scratch` is the chat's own working folder under [`crate::tools::CHAT_ROOT`], which is
    /// browser storage and therefore never a path on the user's disk -- so a chat with an empty
    /// workspace has somewhere to think and nowhere to run, exactly as a Diamond with no attachment
    /// does.  `read_only` is a JSON array of workspace paths to be consulted rather than edited; it
    /// may be omitted, and is today, because no control on the chat surface says that yet.
    /// Malformed input yields an empty list rather than an error, and an empty list still leaves
    /// the scratch: a scope that failed open would be the one bug in here that matters.
    ///
    /// COMPOSED and never assigned, exactly as [`DaimondApp::set_diamond_scope`] is: a second
    /// caller must not be able to widen what a first one set.  **A consequence the browser has to
    /// respect: composition INTERSECTS, so re-scoping a live chat after the user adds one more
    /// folder to its workspace does not widen it.**  A chat whose workspace has changed needs a
    /// fresh app, which is what the page's own turn path does when the marked set no longer matches
    /// the one its app was built with.
    ///
    /// # Arguments
    /// * `scratch` - The chat's own working directory, workspace-relative.
    /// * `workspace` - JSON array of paths the user marked into this chat's workspace.
    /// * `read_only` - JSON array of those that may be read but not written; may be omitted.
    pub fn set_chat_scope(
        &mut self,
        scratch:   String,
        workspace: String,
        read_only: Option<String>,
    ) {
        let paths = parse_path_array;
        let bounds = crate::tools::chat_bounds(
            &scratch,
            &paths(&workspace),
            &paths(&read_only.unwrap_or_default()));
        self.registry.ctx.no_write = crate::tools::compose(&self.registry.ctx.no_write, &bounds);
    }

    /// Confine this agent to a Diamond's workspace.
    ///
    /// Called on a dispatched WORKER, which is where the reach actually is: a Diamond's daimon is
    /// already pinned to `diamonds/<id>` on the OPFS root and cannot see the user's files at all,
    /// but every worker it dispatches was built as an ordinary workspace agent with the whole tree.
    /// So the daimon could not read a file and could ask something else to read it -- which is the
    /// leak that makes a claim about a daimon's reach worthless unless its workers are held to it
    /// too.
    ///
    /// `attached`, `read_only` and `toolkits` are JSON arrays of strings.  Malformed input yields an
    /// empty list rather than an error, and an empty list still bounds the agent to `own_dir`: a
    /// scope that failed open would be the one bug in here that matters.  An `own_dir` that names
    /// nothing bounds it to NOTHING -- see [`crate::tools::diamond_bounds`], where the empty prefix
    /// is dealt with, because the empty prefix means every path rather than none.
    ///
    /// **This scopes the whole turn, not only its files.**  The one bound list reaches both doors:
    /// `may_read` / `may_write` for the file tools, and [`crate::tools::fence_spec`] for the fence a
    /// command runs inside.  So calling this is what makes a command reach exactly the files this
    /// agent's `file_read` would have reached, and not calling it is what left a command fenced to
    /// the whole granted folder (`hand/REVIEW.md` §1.9).
    ///
    /// `path_prefix` is deliberately NOT set here.  A scoped worker's model writes whole
    /// workspace-relative paths -- `diamonds/<id>/notes.md`, not `notes.md` -- and a prefix would
    /// apply itself a second time on top of them.  What a command with no `cwd` defaults to comes
    /// from [`crate::tools::ToolContext::default_cwd`] instead, which reads the allow-list.
    ///
    /// The toolkits are the ones the USER granted this Diamond, and they arrive as recorded names
    /// for the same reason: a toolchain is a grant, and a grant is never inferred from what the
    /// model asked to run.  A name this build does not know is dropped.
    ///
    /// # Arguments
    /// * `own_dir` - The Diamond's own directory, always in scope and always writable.
    /// * `attached` - JSON array of paths in this Diamond's workspace.
    /// * `read_only` - JSON array of those that may be read but not written.
    /// * `toolkits` - JSON array of granted toolkit names (`rust`, `node`, `python`, `go`).
    pub fn set_diamond_scope(
        &mut self,
        own_dir:   String,
        attached:  String,
        read_only: String,
        toolkits:  String,
    ) {
        let paths = parse_path_array;
        let mut bounds = crate::tools::diamond_bounds(
            &own_dir, &paths(&attached), &paths(&read_only));
        // Appended, never merged in earlier: a toolkit widens what a COMMAND may touch and nothing
        // else, and composing it here rather than inside `diamond_bounds` keeps the scope and the
        // grant visible as two separate decisions in the one expression.
        bounds.extend(crate::tools::toolkit_bounds(&paths(&toolkits)));
        // COMPOSED and never assigned, for the reason `hand/REVIEW.md` §1.12 gives: a second
        // caller must not be able to widen what a first one set.  On a freshly built app this is
        // the identity -- composing with an empty list is the other list -- so the browser's
        // per-dispatch call is unchanged.  Re-scoping the SAME Diamond is idempotent; re-scoping a
        // different one intersects to `Bound::Nowhere`, which `diamond_scope` reports and the
        // caller already refuses to start a turn on.
        self.registry.ctx.no_write = crate::tools::compose(&self.registry.ctx.no_write, &bounds);
    }

    /// What this agent is actually confined to, as the engine holds it.
    ///
    /// Exists so that [`DaimondApp::set_diamond_scope`] and [`DaimondApp::set_chat_scope`] can be
    /// checked rather than assumed.  A scope that was asked for and did not take leaves an agent
    /// with the reach of an ordinary workspace turn -- the whole workspace, and the whole granted
    /// folder for its commands -- and a caller that read success from the absence of an exception
    /// would never find out.  Failing open is the one way this can go wrong that matters, so the
    /// browser sets the scope, reads it back here, and refuses to run a turn on a disagreement.
    ///
    /// It answers for both surfaces because both carry the same kind of rule: a chat's scope
    /// arrives in `write_allow`, exactly as a Diamond's does, and a caller checking either looks
    /// for its own folder there.
    ///
    /// Returns a compact JSON object:
    ///
    /// ```text
    /// {"allow":[],"write_allow":["diamonds/d1","notes"],"no_write":[".daimond/"],"toolkits":["rust"],"nowhere":false}
    /// ```
    ///
    /// **`write_allow` is where a scope lands, and `allow` is empty for everything this build
    /// composes.**  A scope fences writing and running and leaves reading free (see
    /// [`crate::tools::Bound::OnlyWriteUnder`]), so a page that tests `allow` to decide whether a
    /// scope took is testing a field that can no longer be anything but empty -- and would refuse
    /// every turn on both surfaces.  Both are reported, never merged, because they are different
    /// fences and a caller that could not tell them apart would read a freely-reading turn as a
    /// confined one.
    ///
    /// Paths are normalised -- one the caller spelled `./notes/` comes back as `notes`, which is
    /// what the comparison must be made against.  `nowhere` is the scope that named no usable place
    /// at all: it is not an error, it is a turn that may touch nothing, and it has to be tellable
    /// apart from an unscoped turn, whose lists are also empty.
    pub fn diamond_scope(&self) -> String {
        let quoted = |v: Vec<String>| -> String {
            let items: Vec<String> = v.iter()
                .map(|s| fmt!("\"{}\"", crate::llm::json_escape(s)))
                .collect();
            fmt!("[{}]", items.join(","))
        };
        let bounds = &self.registry.ctx.no_write;
        let allow: Vec<String> = bounds.iter()
            .filter_map(|b| match b {
                crate::tools::Bound::OnlyUnder(p) => Some(crate::tools::normalise(p)),
                _ => None,
            })
            .collect();
        let no_write: Vec<String> = bounds.iter()
            .filter_map(|b| match b {
                crate::tools::Bound::NoWrite(p) => Some(crate::tools::normalise(p)),
                _ => None,
            })
            .collect();
        // The WRITE allow-list, which is WHERE A SCOPE LANDS on both surfaces. Reported beside
        // `allow` and never merged into it: they are different fences -- one governs both verbs,
        // the other governs writing and running -- and a caller that could not tell them apart
        // would read a freely-reading turn as a confined one, or the reverse.
        //
        // `allow` above is EMPTY for everything this build composes, and a page that tests it to
        // decide whether a scope took is testing a field that cannot be anything but empty. That
        // has now been wrong in both directions within a week, which is why both are reported and
        // why `scopeAgentTo` and `scopeChatTo` in daimond.js name the one they mean.
        let write_allow: Vec<String> = bounds.iter()
            .filter_map(|b| match b {
                crate::tools::Bound::OnlyWriteUnder(p) => Some(crate::tools::normalise(p)),
                _ => None,
            })
            .collect();
        fmt!(
            "{{\"allow\":{},\"write_allow\":{},\"no_write\":{},\"toolkits\":{},\"nowhere\":{}}}",
            quoted(allow),
            quoted(write_allow),
            quoted(no_write),
            crate::tools::toolkit_names_json(bounds),
            bounds.iter().any(|b| matches!(b, crate::tools::Bound::Nowhere)),
        )
    }

    /// Set the user's standing instructions — the contents of their `DAIMOND.md`.
    ///
    /// A dispatched agent starts from nothing: it cannot see the conversation
    /// that dispatched it, so without this it knows neither the house rules nor
    /// what the work is for, and begins from zero every time.
    pub fn set_instructions(&self, md: String) {
        *self.instructions.borrow_mut() = md;
    }

    /// Set the user's replacement for a role's prompt, from `prompts/<role>.md`.
    ///
    /// Only `daimon`, `reducer` and `compactor` are held here — a chat and a
    /// worker are constructed with their prompt already composed (see the field
    /// docs). An empty `text` means "use the default", which is how deleting the
    /// file puts the shipped prompt back.
    ///
    /// The compactor is the odd one: it is not an agent this app builds but the
    /// tool-less model that summarises a conversation being folded, so its text
    /// goes to [`crate::agent::Agent::set_fold_prompt`] rather than into a field
    /// here.  Every agent built from this one adopts it (see
    /// [`crate::agent::Agent::adopt_limits`]), so the daimon and the reducer fold
    /// by the same instructions the chat does.
    ///
    /// # Arguments
    /// * `role` - The role's name: `daimon`, `reducer` or `compactor`.
    /// * `text` - What the user wrote, or empty for the default.
    ///
    /// # Errors
    /// Rejects a role this app does not build, rather than silently ignoring it:
    /// a prompt the user has edited and that never reaches a model is worse than
    /// an error saying so.
    pub fn set_role_prompt(&self, role: &str, text: String) -> Result<(), JsValue> {
        let which = match Role::parse(role) {
            Ok(r)  => r,
            Err(e) => return Err(to_js_err(e)),
        };
        match which {
            Role::Daimon => *self.daimon_prompt.borrow_mut() = text,
            Role::Reducer   => *self.reducer_prompt.borrow_mut() = text,
            Role::Compactor => self.agent.set_fold_prompt(&text),
            other => return Err(to_js_err(err!(
                "The {} prompt is composed in the browser, not here; pass it to the \
                 constructor instead.", other.name(); Invalid, Input))),
        }
        Ok(())
    }

    /// Compose a system prompt: the role, then the user's standing instructions.
    fn with_instructions(&self, role: &str) -> String {
        let md = self.instructions.borrow();
        if md.trim().is_empty() {
            return role.to_string();
        }
        fmt!("{}\n\n## Standing instructions from the user\n\n{}", role, md.trim())
    }

    /// Roll an ephemeral session's token usage into this app's cumulative
    /// counters.
    ///
    /// The Diamond surface (steer, fold) runs each turn in its own throwaway
    /// [`Session`], so its usage never reached [`DaimondApp::prompt_tokens`] and the
    /// browser could not bill it: steering a Diamond twenty times showed nothing
    /// spent.  The caller meters by the growth of these counters, so adding to
    /// them is all that is needed.
    fn absorb_usage(&self, session: &Session) {
        let mut own = self.session.borrow_mut();
        own.prompt_tokens      += session.prompt_tokens;
        own.completion_tokens  += session.completion_tokens;
        own.cached_tokens      += session.cached_tokens;
        own.cost_usd           += session.cost_usd;
        own.last_prompt_tokens  = session.last_prompt_tokens;
    }

    /// Seed a persisted conversation back into the session, so a chat
    /// reopened after a page reload keeps its history and its billing.
    ///
    /// Without this the browser rebuilds a `DaimondApp` with an empty
    /// `Session`: the transcript is still drawn from `localStorage`, but
    /// the model receives only the newest message and every reloaded
    /// chat silently becomes a one-shot.
    ///
    /// # Arguments
    /// * `msgs` - A JS array of `{ role, content }` objects, oldest
    ///   first.  Recognised roles are `user`, `assistant` and `system`;
    ///   any other role is skipped, since a tool result cannot be
    ///   replayed without the call that produced it.
    /// * `prompt_tokens` - Cumulative prompt tokens to restore.
    /// * `completion_tokens` - Cumulative completion tokens to restore.
    /// * `last_prompt_tokens` - Context-window usage of the last request.
    /// * `cached_tokens` - Cumulative cached prompt tokens to restore.  May be
    ///   omitted; a caller that does not pass it leaves the counter at zero,
    ///   which is what a store written before the field existed holds.
    /// * `cost_usd` - Cumulative provider-reported USD to restore.  Omissible
    ///   for the same reason.
    ///
    /// The token counters are restored alongside the messages because
    /// the caller meters a turn by the growth of the cumulative count;
    /// against a counter that restarted at zero the first turn after a
    /// reload prices as free and the running total jumps backwards.  The two
    /// trailing arguments carry the same risk for the reported cost, and are
    /// trailing and optional so a caller written against the older four-argument
    /// signature keeps working unchanged.
    pub fn restore(
        &self,
        msgs:               js_sys::Array,
        prompt_tokens:      f64,
        completion_tokens:  f64,
        last_prompt_tokens: f64,
        cached_tokens:      Option<f64>,
        cost_usd:           Option<f64>,
    ) {
        let mut session = self.session.borrow_mut();
        session.messages.clear();
        for item in msgs.iter() {
            let content = match js_prop(&item, "content") {
                Some(c) => c,
                None    => continue,
            };
            // The system prompt is prepended per request from the Agent,
            // never stored, so a persisted `system` role is dropped here
            // rather than duplicated into the working conversation.
            match js_prop(&item, "role").unwrap_or_default().as_str() {
                "user"      => session.messages.push(ChatMessage::user(content)),
                "assistant" => session.messages.push(ChatMessage::assistant(content)),
                _ => continue,
            }
        }
        session.prompt_tokens      = prompt_tokens      as u64;
        session.completion_tokens  = completion_tokens  as u64;
        session.last_prompt_tokens = last_prompt_tokens as u64;
        session.cached_tokens      = cached_tokens.unwrap_or(0.0) as u64;
        session.cost_usd           = cost_usd.unwrap_or(0.0);
    }

    // ── The conversation the MODEL holds ─────────────────────────────────
    //
    // [`DaimondApp::restore`] above rebuilds a session from the transcript on
    // SCREEN, which is a different thing: it carries prose and nothing else, so a
    // reloaded chat came back with the model's own tool calls amputated.  It could
    // not carry them, because the browser never had the provider's call ids -- it
    // mints a local `t1`, `t2` for its own rendering -- and an assistant turn whose
    // `tool_calls` cannot be paired with a reply is a request every provider
    // rejects outright.
    //
    // So the ids never leave Rust.  The pair below exports the session's own
    // message list, ids and all, and takes it back verbatim.  Two consequences fall
    // out of that and both are the point: a reload keeps the record of what was
    // read, written and run, and a conversation FOLDED by [`crate::compact`] stays
    // folded, because what is exported is the folded list rather than the untouched
    // transcript the screen still shows.

    /// The conversation exactly as this session holds it, for the browser to store
    /// and hand back after a reload.
    ///
    /// A JS array of plain objects mirroring [`ChatMessage::to_datmap`]:
    /// `{ role, content }`, with `tool_calls: [{ id, name, arguments }]` on an
    /// assistant turn that asked for tools and `tool_call_id` on a tool reply.
    /// Objects rather than a JSON string, so the browser can put the array straight
    /// into IndexedDB, which stores structured values and needs no parse.
    ///
    /// Read AFTER a turn, never during one: it borrows the session that
    /// [`DaimondApp::run_turn`] holds mutably, exactly as
    /// [`DaimondApp::cached_tokens`] does.
    pub fn export_session(&self) -> js_sys::Array {
        let out = js_sys::Array::new();
        for msg in self.session.borrow().messages.iter() {
            out.push(&message_to_js(msg));
        }
        out
    }

    /// Take a conversation exported by [`DaimondApp::export_session`] back, ids and
    /// all, replacing whatever this session held.
    ///
    /// Every role is carried, including `tool` and the `system` note a turn stopped
    /// at the round limit leaves behind — unlike [`DaimondApp::restore`], which
    /// drops both because a screen transcript cannot express them.
    ///
    /// What arrives is made WHOLE before it is accepted: see [`pair_up`].  The store
    /// this comes from is merged across tabs and devices and restored from backups,
    /// so a list that has lost a tool reply somewhere along the way is a thing that
    /// will happen — and it must cost that one call, not every turn from then on.
    ///
    /// # Arguments
    /// * `msgs` - The exported array, oldest first.
    /// * `prompt_tokens` - Cumulative prompt tokens to restore.
    /// * `completion_tokens` - Cumulative completion tokens to restore.
    /// * `last_prompt_tokens` - Context-window usage of the last request.
    /// * `cached_tokens` - Cumulative cached prompt tokens to restore.
    /// * `cost_usd` - Cumulative provider-reported USD to restore.
    ///
    /// # Returns
    /// How many messages were taken, after the pairing repair — so a caller that
    /// reads zero knows the store held nothing usable and can fall back to
    /// [`DaimondApp::restore`].
    pub fn restore_session(
        &self,
        msgs:               js_sys::Array,
        prompt_tokens:      f64,
        completion_tokens:  f64,
        last_prompt_tokens: f64,
        cached_tokens:      Option<f64>,
        cost_usd:           Option<f64>,
    )
        -> usize
    {
        let mut restored: Vec<ChatMessage> = Vec::new();
        for item in msgs.iter() {
            if let Some(m) = js_to_message(&item) {
                restored.push(m);
            }
        }
        let whole = pair_up(restored);
        let n = whole.len();
        let mut session = self.session.borrow_mut();
        session.messages           = whole;
        session.prompt_tokens      = prompt_tokens      as u64;
        session.completion_tokens  = completion_tokens  as u64;
        session.last_prompt_tokens = last_prompt_tokens as u64;
        session.cached_tokens      = cached_tokens.unwrap_or(0.0) as u64;
        session.cost_usd           = cost_usd.unwrap_or(0.0);
        n
    }

    /// Append a message to the restored conversation without going near a model.
    ///
    /// The store is merged across tabs, so a chat can hold turns this device's
    /// exported session never saw — another window's.  Those arrive as prose only,
    /// which is all a screen transcript holds, and they are appended here after
    /// [`DaimondApp::restore_session`] has laid down the part that carries ids.
    /// Only `user` and `assistant` are accepted, because a bare tool reply appended
    /// to a conversation answers nothing.
    ///
    /// # Arguments
    /// * `role` - `user` or `assistant`; anything else is ignored.
    /// * `content` - What was said.
    pub fn append_message(&self, role: String, content: String) {
        let mut session = self.session.borrow_mut();
        match role.as_str() {
            "user"      => session.messages.push(ChatMessage::user(content)),
            "assistant" => session.messages.push(ChatMessage::assistant(content)),
            _ => {},
        }
    }

    // ── What bounds a turn ───────────────────────────────────────────────

    /// Tell this agent how big the model's context window is, so a conversation is
    /// folded before the provider refuses it rather than after.
    ///
    /// `f64`, not `u64`: a `u64` argument arrives at the JS boundary as a `BigInt`,
    /// and `set_context_window(131072)` written with an ordinary Number would throw
    /// rather than set anything.  Zero, or anything below it, means nobody has
    /// published a window and the default assumption stands.
    ///
    /// # Arguments
    /// * `tokens` - The window the provider publishes for this model.
    pub fn set_context_window(&self, tokens: f64) {
        self.agent.set_context_window(if tokens > 0.0 { tokens as u64 } else { 0 });
    }

    /// How many tool-call rounds one turn of this agent may take.
    ///
    /// # Arguments
    /// * `n` - The ceiling; zero is ignored.
    pub fn set_max_rounds(&self, n: usize) {
        self.agent.set_max_rounds(n);
    }

    /// What a Diamond's crystal may weigh before a write that grows it is refused, in bytes.
    ///
    /// The crystal is the summary; the scope attached to a Diamond is what carries the data, and
    /// this is the rule that keeps the two apart.  A ceiling that suits one person's Diamonds is
    /// not a ceiling that suits everyone's, so it is theirs to set.
    ///
    /// # Arguments
    /// * `bytes` - The ceiling; zero restores the default.
    pub fn set_crystal_cap(&self, bytes: usize) {
        crate::tools::set_crystal_cap(bytes);
    }

    /// What a Diamond's PAGE may weigh before a write that grows it is refused, in bytes.
    ///
    /// A second ceiling rather than a share of the first, because the two files are different
    /// kinds of thing: the memory is what the Diamond knows and rides in the standing context of
    /// every turn, while the page is markup that nothing folds and nothing reduces.  The page is
    /// capped all the same -- it travels in every version snapshot where it changed and shares the
    /// sync budget with the memory, so exempting presentation would void the other ceiling's
    /// purpose.
    ///
    /// # Arguments
    /// * `bytes` - The ceiling; zero restores the default.
    pub fn set_crystal_page_cap(&self, bytes: usize) {
        crate::tools::set_crystal_page_cap(bytes);
    }

    /// Fold this agent's conversations with a different model from the one it chats
    /// with; empty means the chat's own.
    ///
    /// # Arguments
    /// * `model` - The provider's id for the folding model, or empty.
    pub fn set_fold_model(&self, model: String) {
        self.agent.set_fold_model(&model);
    }

    /// The context window this agent is folding against, in tokens.
    ///
    /// Zero means nobody has published one and [`crate::agent::compact::DEFAULT_WINDOW`]
    /// is assumed — so a caller drawing a meter should draw nothing rather than a full
    /// one, exactly as it does for [`DaimondApp::last_prompt_tokens`].
    ///
    /// It is not simply the figure handed to [`DaimondApp::set_context_window`]: a
    /// provider that refuses an oversized prompt teaches the agent a smaller one, and
    /// after that the meter drawn from the published figure is measuring against a
    /// window this chat has already been told it does not have.
    #[wasm_bindgen(getter)]
    pub fn context_window(&self) -> f64 {
        self.agent.limits().window as f64
    }

    /// The fraction of the window at which this agent folds, between 0 and 1.
    ///
    /// The number exists in `compact.rs` and has never been visible anywhere: a user
    /// watching a context meter climb had no way to know whether 78% meant "nearly
    /// there" or "plenty of room".
    #[wasm_bindgen(getter)]
    pub fn fold_at(&self) -> f64 {
        self.agent.limits().fold_at
    }

    /// Fold this conversation now, because the user asked.
    ///
    /// Resolves to `true` when something actually moved.  A short conversation cannot be
    /// folded — there is no tail to cut below [`crate::agent::compact::MIN_KEEP_MESSAGES`]
    /// and no bulky tool result to shorten — and `false` is how the caller says so instead
    /// of reporting a fold that changed nothing.
    ///
    /// A paid call: the summary is written by a model.  The caller is the one that knows
    /// whether the user has been told that, so nothing here asks.
    ///
    /// # Arguments
    /// * `on_event` - The same sink a turn uses; the fold announces itself through it.
    ///
    /// # Errors
    /// Refuses while a turn holds the session, rather than panicking the `RefCell` the
    /// way a mid-turn `cached_tokens` read does.
    pub async fn fold_now(&self, on_event: js_sys::Function) -> Result<bool, JsValue> {
        let mut session = match self.session.try_borrow_mut() {
            Ok(s)  => s,
            Err(_) => return Err(to_js_err(err!(
                "This chat is in the middle of a turn; wait for it to finish before \
                 folding by hand."; Invalid, Conflict))),
        };
        let mut sink = |ev: AgentEvent| {
            let js = event_to_js(&ev);
            let _ = on_event.call1(&JsValue::NULL, &js);
        };
        Ok(self.agent.fold_by_hand(&mut session, &mut sink).await)
    }

    // ── The credential a push travels with ───────────────────────────────
    //
    // **It does not survive a page reload, and nothing else clears it.**  Both halves are
    // established from the code rather than assumed, because a push that worked yesterday and
    // silently refuses today is the failure this whole arrangement is written against.
    //
    // * **Nothing else clears it.**  It lives in one `thread_local!` in `crate::tools`, and the
    //   only write to that cell is `tools::set_push_cred`, which nothing but the two calls below
    //   reaches.  `set_diamond_scope`, `set_toolkits`, `set_permission_mode`, `set_account_ns` and
    //   building another `DaimondApp` all leave it exactly where it was -- it is a setting of the
    //   app, as the permission rung is, and not a field of a turn or of a Diamond.
    // * **A reload loses it.**  The cell belongs to the wasm instance, which is built fresh on
    //   every load; there are no workers, so there is one instance and one credential per tab.
    //   Switching account, adding one, erasing one, restoring a backup and taking an update all
    //   end in `location.reload()`, so each of those loses it too -- which is the right default,
    //   since one account's token must not be left standing for the next.
    //
    // So **the page must call `set_push_cred` on every load**, from whatever it stores the
    // credential in, for the account that is now current.  There is no other way it comes back.

    /// Hold the credential Daimond pushes with, or clear it.  The token never leaves this call.
    ///
    /// An empty or whitespace `token` CLEARS the credential rather than storing an empty one: a
    /// stored empty token would fail to authenticate at the remote, and "there is no credential"
    /// is a sentence a model can act on where "authentication failed" is not.
    ///
    /// Nothing derived from anything a model said reaches this.  It is the user's own setting
    /// arriving from their own control, exactly as `set_permission_mode` is, and the token has no
    /// accessor once it is here -- see [`crate::tools::PushCred`], which writes its own `Debug` so
    /// that a struct printed in anger cannot publish it.
    ///
    /// # Arguments
    /// * `host` - The bare host, as in `github.com`: no scheme, no port, no user and no path.
    ///   Folded and validated by [`crate::tools::PushCred::new`], which is the one place that
    ///   decides what a host is.
    /// * `user` - The name the token travels as, or empty for GitHub's `x-access-token`.  GitLab
    ///   wants `oauth2`.
    /// * `token` - The secret, or empty to clear.
    ///
    /// # Returns
    /// Whether a credential is held afterwards, so a caller that clears one gets `false` and a
    /// caller that set one gets `true` without having to ask a second question.
    ///
    /// # Errors
    /// A malformed host, user or token is refused, and the refusal names the field and never the
    /// value.
    pub fn set_push_cred(&self, host: String, user: String, token: String)
        -> Result<bool, JsValue>
    {
        if token.trim().is_empty() {
            return Ok(crate::tools::set_push_cred(None));
        }
        match crate::tools::PushCred::new(&host, &user, &token) {
            Ok(c)  => Ok(crate::tools::set_push_cred(Some(c))),
            Err(e) => Err(to_js_err(e)),
        }
    }

    /// The host a push would reach, or empty where no credential is held.
    ///
    /// For the settings panel to draw what is actually set rather than what it last sent, which is
    /// the only way a page can notice that a reload lost it.  The token is not readable here or
    /// anywhere else.
    pub fn push_host(&self) -> String {
        crate::tools::push_host().unwrap_or_default()
    }

    /// Invoke a single tool directly by wire name with a raw-JSON argument
    /// object, returning its result text — the same path the agent loop
    /// takes, without an LLM turn.  This backs UI affordances such as a
    /// file-browser panel (list/read/delete) that act on OPFS directly.
    /// Tool errors are returned as `Error: …` text (never a rejection), so
    /// the browser can surface them inline.
    ///
    /// The TEXT of the result: a panel draws strings, and an image read this way is named rather
    /// than carried. The model's route to an image is the agent loop, where the part survives.
    pub async fn run_tool(&self, name: String, args_json: String) -> String {
        self.registry.dispatch(&name, &args_json).await.as_text().into_owned()
    }

    // ── Diamond / crystal / fold surface ─────────────────────────────────

    /// Create a Diamond named `name`, returning its id.  Creates the Diamond
    /// directory, an empty `crystal.json`, version `0`, a `meta.json`, and a
    /// `create` log record.  No page: a new Diamond renders on the shipped default until
    /// something writes one.
    pub async fn create_diamond(&self, name: String) -> Result<String, JsValue> {
        diamond::create(&name).await.map_err(to_js_err)
    }

    /// Tell the engine which `say` folds the user has OPEN, by tool-call id.
    ///
    /// Called before every turn, with the whole set, because a fold can be opened and closed
    /// between two turns and the payload must follow. An open fold's detail travels; a closed
    /// one's does not. See [`crate::llm::OpenFolds`].
    pub fn set_open_folds(&self, ids_json: String) {
        let mut ids = Vec::new();
        // Read leniently: a page that sends nothing readable means "none open", which is the
        // behaviour before this existed and the cheaper of the two mistakes.
        let mut cur = String::new();
        let mut inside = false;
        for c in ids_json.chars() {
            match c {
                '"' if inside => { if !cur.is_empty() { ids.push(cur.clone()); } cur.clear(); inside = false; },
                '"'           => inside = true,
                _ if inside   => cur.push(c),
                _             => {},
            }
        }
        self.agent.llm.set_open_folds(ids);
    }

    /// What this app would send as its system message, and the tool schemas beside it, as JSON.
    ///
    /// **THE WIRE VIEW'S SOURCE, and it is composed by the code that composes the request.**
    /// `Agent::system_parts` is called here and by `run_turn`, so what a person is shown cannot
    /// drift from what goes out -- which is the only property that makes such a view worth having.
    /// A second assembly agreeing today is a second assembly disagreeing later, silently.
    ///
    /// The parts are named rather than concatenated, because the question the view answers is
    /// WHOSE each paragraph is: the role prompt is the user's and they may rewrite it, the safety
    /// clause is appended after their edits and they may not, the tool sentence is derived from
    /// the registry, and the machine note is derived from the fence. A single blob answers none
    /// of that.
    pub fn wire_system(&self) -> String {
        let (role, tools, brief) = self.agent.system_parts(&self.registry);
        let defs = self.registry.definitions_json().unwrap_or_else(|| fmt!("[]"));
        fmt!(
            "{{\"role\":\"{}\",\"tools_sentence\":\"{}\",\"machine\":\"{}\",\"schemas\":{},\"names\":{}}}",
            crate::llm::json_escape(&role),
            crate::llm::json_escape(&tools),
            crate::llm::json_escape(&brief),
            defs,
            fmt!("[{}]", self.registry.tool_names().iter()
                .map(|n| fmt!("\"{}\"", crate::llm::json_escape(n)))
                .collect::<Vec<_>>().join(",")))
    }

    /// Create a Diamond at a KNOWN id, or answer with the id if it is already there.
    ///
    /// Only the two seeded defaults use this, and the reason is a sync: every device seeds them
    /// separately -- the "already seeded" flag is `localStorage` and does not travel -- so a
    /// random id per device produced one Optimiser per device and the merge kept them all. A fixed
    /// id makes two devices create one object. See [`diamond::create_at`].
    pub async fn create_diamond_at(&self, name: String, id: String) -> Result<String, JsValue> {
        diamond::create_at(&name, &id).await.map_err(to_js_err)
    }

    /// List every Diamond as a JSON array of
    /// `{ id, name, crystal_version, updated, tags }`, most-recently updated
    /// first.
    pub async fn list_diamonds(&self) -> Result<String, JsValue> {
        diamond::list().await.map_err(to_js_err)
    }

    /// Every link touching a node, as a JSON array.
    ///
    /// The node is a `kind:rest` reference -- `diamond:<id>`, `file:<path>`,
    /// `url:<url>`, `chat:<id>` -- and a link is found whichever end names it,
    /// so this answers both "what does this point at" and "what points at
    /// this" from the one stored record.
    pub async fn links_touching(&self, node_ref: String) -> Result<String, JsValue> {
        diamond::links_json(&node_ref).await.map_err(to_js_err)
    }

    /// Every link in the store, as a JSON array.
    ///
    /// The whole graph in one read, for a view that draws all of it at once:
    /// each entry carries the Diamond whose sidecar holds the record, and both
    /// ends as `kind:rest` references, so nothing has to be asked for twice.
    pub async fn all_links(&self) -> Result<String, JsValue> {
        diamond::all_links().await.map_err(to_js_err)
    }

    /// Export a whole Diamond as JSON:
    /// `{"id":..,"files":{"<path>":"<text>",..},"binary":{"<path>":"<base64>",..}}`.
    ///
    /// Every file under `diamonds/<id>/` travels, so a Diamond carried to another
    /// device arrives whole -- crystal, versions, log, deltas, tags and links --
    /// and a per-Diamond file added later needs nothing to learn its name.  A file
    /// that is not valid UTF-8 travels in `binary` as base64 and arrives byte for
    /// byte; see [`diamond::export_diamond`] on what carrying one as text cost.
    /// What `export_diamond` would weigh, without building it. See
    /// [`diamond::export_size`] -- the sync uses this to decide what fits BEFORE
    /// materialising it, which is the difference between a bounded parcel and
    /// the whole store in memory.
    pub async fn export_diamond_size(&self, id: String) -> Result<f64, JsValue> {
        match diamond::export_size(&id).await {
            Ok(n)  => Ok(n as f64),
            Err(e) => Err(to_js_err(e)),
        }
    }

    pub async fn export_diamond(&self, id: String) -> Result<String, JsValue> {
        diamond::export_diamond(&id).await.map_err(to_js_err)
    }

    /// Recreate a Diamond from an [`DaimondApp::export_diamond`] JSON, replacing
    /// whatever this device held under that id.
    pub async fn import_diamond(&self, json: String) -> Result<(), JsValue> {
        diamond::import_diamond(&json).await.map_err(to_js_err)
    }

    /// Assert a link, returning its id.
    ///
    /// `owner` is the Diamond whose sidecar holds the record; `rel` and `note`
    /// may both be empty, and `by` names who asserted it (`user`, or
    /// `agent:<name>`) so a later reader can tell a drawn line from a
    /// suggested one.
    pub async fn add_link(
        &self,
        owner: String,
        from:  String,
        to:    String,
        rel:   String,
        note:  String,
        by:    String,
    )
        -> Result<String, JsValue>
    {
        diamond::add_link(&owner, &from, &to, &rel, &note, &by).await.map_err(to_js_err)
    }

    /// Revise a link's relation and note in place.  True when anything moved.
    ///
    /// The way to correct a relation, and the reason it exists is that the
    /// alternative destroys evidence: removing the record and asserting a fresh
    /// one mints a new id and a new timestamp, so the moment the two things were
    /// first said to be related is gone, and anything holding the old id is left
    /// holding nothing.  The ends are not revisable -- a link between two other
    /// things is a new claim, and `add_link` makes it.
    pub async fn update_link(
        &self,
        owner:   String,
        link_id: String,
        rel:     String,
        note:    String,
    )
        -> Result<bool, JsValue>
    {
        diamond::update_link(&owner, &link_id, &rel, &note).await.map_err(to_js_err)
    }

    /// Remove a link from a Diamond's sidecar.  True when one went.
    pub async fn remove_link(&self, owner: String, link_id: String) -> Result<bool, JsValue> {
        diamond::remove_link(&owner, &link_id).await.map_err(to_js_err)
    }

    /// Take into a Diamond's sidecar every link another device's copy of it
    /// holds and this one does not.  True when something was written, which is
    /// also when the Diamond was stamped.
    ///
    /// `sidecar` is that device's `links.jsonl` as stored text, lifted out of a
    /// Diamond export.  For the merge that calls it, and why a union is what an
    /// equal-stamp disagreement wants, see
    /// [`union_links_from`](crate::wasm::diamond::union_links_from).
    pub async fn union_links(&self, owner: String, sidecar: String) -> Result<bool, JsValue> {
        diamond::union_links_from(&owner, &sidecar).await.map_err(to_js_err)
    }

    /// Rename a Diamond.
    pub async fn rename_diamond(&self, id: String, name: String) -> Result<(), JsValue> {
        diamond::rename(&id, &name).await.map_err(to_js_err)
    }

    /// Set a Diamond's tags, replacing whatever it held.  `tags_json` is a JSON
    /// array of strings, e.g. `["work","urgent"]`.
    ///
    /// The tags are normalised on this side of the boundary -- trimmed,
    /// lowercased, deduped, capped at 24 characters each and 8 in all -- so the
    /// caller need not, and cannot dirty the store by not doing so.  Which tags
    /// to offer is the interface's business: none is known here.
    pub async fn set_tags(&self, id: String, tags_json: String) -> Result<(), JsValue> {
        let tags = parse_json_string_array(&tags_json);
        diamond::set_tags(&id, &tags).await.map_err(to_js_err)
    }

    /// Set which toolchains a Diamond is granted, from a JSON array of names.
    ///
    /// A grant, and the only way one is ever made: [`crate::tools::Bound::Toolkit`] reaches a fence
    /// through this store and through nothing else, so what a command may touch outside the
    /// workspace is decided here, by the user, per Diamond -- never by what a model asked to run.
    ///
    /// # Arguments
    /// * `id` - The Diamond.
    /// * `kits_json` - A JSON array of names: `rust`, `node`, `python`, `go`.
    pub async fn set_toolkits(&self, id: String, kits_json: String) -> Result<(), JsValue> {
        let kits = parse_json_string_array(&kits_json);
        diamond::set_toolkits(&id, &kits).await.map_err(to_js_err)
    }

    /// Delete a Diamond and all its stored state.
    pub async fn delete_diamond(&self, id: String) -> Result<(), JsValue> {
        diamond::delete(&id).await.map_err(to_js_err)
    }

    /// Delete a destroyed chat's own directory: everything under `chats/<id>/`.
    ///
    /// A chat's scope lives on its record and dies with it, but its workers' scratch is a
    /// directory in the store, and a destroyed chat's id names nothing afterwards.  With expiry
    /// this is the ordinary end of every abandoned conversation rather than a deliberate act, so
    /// what is left here is left once per chat nobody came back to.
    ///
    /// The id is checked rather than trusted, and the root is [`FileRoot::Opfs`] rather than the
    /// workspace: this removes a directory RECURSIVELY, so an id carrying a separator or a `..`
    /// would delete somewhere else entirely, and a workspace root would put that somewhere on the
    /// user's own disk.  A bad id deletes nothing and says so.
    ///
    /// A missing directory is success, not failure: a chat whose workers never wrote anything has
    /// no scratch, and the caller is deleting it either way.
    ///
    /// # Arguments
    /// * `id` - The chat being destroyed.
    pub async fn remove_dir(&self, id: String) -> Result<(), JsValue> {
        let clean = id.trim();
        if clean.is_empty()
            || clean.contains('/') || clean.contains('\\')
            || clean.contains("..")
        {
            return Err(to_js_err(err!(
                "'{}' is not a chat id, so nothing was deleted.", id; Invalid, Input)));
        }
        let path = fmt!("{}/{}", crate::tools::CHAT_ROOT, clean);
        if !crate::wasm::opfs::exists(crate::tools::FileRoot::Opfs, &path).await
            .unwrap_or(false)
        {
            return Ok(());
        }
        crate::wasm::opfs::delete_entry(crate::tools::FileRoot::Opfs, &path, true)
            .await
            .map_err(to_js_err)
    }

    /// Read a Diamond's current crystal data, as the JSON text it is stored as.
    ///
    /// Parsing is the caller's, and so is coping with text that will not parse: this is a store,
    /// and a crystal a model has damaged must still reach the surface that can show the user what
    /// is in it.
    pub async fn read_crystal_data(&self, id: String) -> Result<String, JsValue> {
        diamond::read_crystal_data(&id).await.map_err(to_js_err)
    }

    /// Apply a user hand-edit to a Diamond's crystal data: snapshots a new version
    /// and logs an `edit` record.
    pub async fn write_crystal_data(&self, id: String, json: String) -> Result<(), JsValue> {
        diamond::write_crystal_data(&id, &json).await.map_err(to_js_err)
    }

    /// Read a Diamond's page, or empty when it has none.
    ///
    /// Empty is an ordinary answer: the shipped default page is a JS const, so the caller is the
    /// one that knows what a Diamond with no page of its own should render.
    pub async fn read_crystal_page(&self, id: String) -> Result<String, JsValue> {
        diamond::read_crystal_page(&id).await.map_err(to_js_err)
    }

    /// Replace a Diamond's page: snapshots a new version and logs an `edit` record.
    ///
    /// # Arguments
    /// * `id` - The Diamond.
    /// * `html` - The page, self-contained; empty resets it and lets the default stand.
    pub async fn write_crystal_page(&self, id: String, html: String) -> Result<(), JsValue> {
        diamond::write_crystal_page(&id, &html).await.map_err(to_js_err)
    }

    /// Write both halves of a crystal as ONE version: one version number, one log record.
    ///
    /// For a restore and for a backup import.  Setting the two halves with the two calls above
    /// works and writes two versions, so the Diamond's history shows two rows for one click of one
    /// button -- and neither row is wrong, which is why it wants fixing rather than tolerating.
    ///
    /// The page half still writes a snapshot only where the page actually changed, so restoring a
    /// version whose page never differed costs nothing extra.  `html` is taken literally: restoring
    /// a version from before pages existed means passing an empty page, and the Diamond goes back
    /// to having none.  A caller that would rather keep the page it has should pass that instead.
    ///
    /// # Arguments
    /// * `id` - The Diamond.
    /// * `json` - The crystal data to put at the head.
    /// * `html` - The page to put at the head; empty leaves the Diamond with no page of its own.
    pub async fn write_crystal_both(&self, id: String, json: String, html: String)
        -> Result<(), JsValue>
    {
        diamond::write_crystal_both(&id, &json, &html).await.map_err(to_js_err)
    }

    /// Is an earlier Diamond root still waiting to be moved to `diamonds/`?
    ///
    /// See [`diamond::legacy_root_waiting`]. Asked before anything creates a Diamond
    /// that the user did not ask for, because creating one makes `diamonds/` exist and
    /// a legacy root can then never be migrated.
    pub async fn legacy_diamond_root_waiting(&self) -> Result<bool, JsValue> {
        diamond::legacy_root_waiting().await.map_err(to_js_err)
    }

    /// Record in a Diamond's history that its daimon changed model.
    ///
    /// See [`diamond::record_model_change`].  The crystal is snapshotted unchanged;
    /// what is being recorded is the discontinuity, not an edit.
    pub async fn record_model_change(&self, id: String, note: String)
        -> Result<(), JsValue>
    {
        diamond::record_model_change(&id, &note).await.map_err(to_js_err)
    }

    /// Read a Diamond's append-only log as a JSON array of records.
    pub async fn log_read(&self, id: String) -> Result<String, JsValue> {
        diamond::log_read(&id).await.map_err(to_js_err)
    }

    /// Read the crystal's data as it stood at `version`, so a past state can be shown
    /// and, if the user wants it back, written to the head with
    /// [`DaimondApp::write_crystal_data`].
    ///
    /// A version from before the migration answers with the markdown it holds, because that is
    /// what is on disk and rewriting history to look like data would be inventing a past.  The
    /// caller renders what it is given.
    pub async fn read_version(&self, id: String, version: f64) -> Result<String, JsValue> {
        diamond::read_version(&id, version as u64).await.map_err(to_js_err)
    }

    /// Read the PAGE as it stood at `version`.
    ///
    /// Not the page written AT that version -- most versions did not change it -- but the page
    /// that was on screen then, which is the last one written at or before it.  See
    /// [`diamond::read_version_page`] for why the two are different questions.
    ///
    /// Empty means no page had been stored by then, which is every version from before the
    /// migration; the caller renders its default.
    pub async fn read_version_page(&self, id: String, version: f64) -> Result<String, JsValue> {
        diamond::read_version_page(&id, version as u64).await.map_err(to_js_err)
    }

    /// Steer a Diamond's crystal: run one daimon turn for `instruction`, streaming
    /// [`AgentEvent`]s to `on_event`, and return the daimon's conversation as it
    /// stands afterwards.
    ///
    /// The agent's file tools are scoped to `diamonds/<id>/`, so `file_read` /
    /// `file_write` on `crystal.json` address the Diamond's memory and `crystal.html` its page.
    /// When the turn leaves either of them changed, a new version is snapshotted and an `edit`
    /// record logged.
    ///
    /// **The daimon is persistent, and `prior` is how.** It used to be stateless per
    /// instruction, rebuilding what it knew from the crystal in its system prompt and
    /// nothing else — so it could not be asked a follow-up question, and the answer to
    /// a question that changed no file went into a box and was gone on the next steer.
    /// Notes2 says it plainly: *"the daimon is meant to be persistant"*. The
    /// conversation lives in the browser's store beside the chats, exactly as a chat's
    /// does, and travels through here on every turn.
    ///
    /// The turn is folded by the same figures as this app's own (see
    /// [`crate::agent::Agent::adopt_limits`]), so a daimon that has been talked to for
    /// a long time folds at its window rather than being refused by the provider —
    /// which is the other half of what notes2 asks for: *"automatically and visibly
    /// folded at the context threshold"*.
    ///
    /// **The marks travel with the instruction.** A daimon writes and runs only where the user
    /// attached something, and what is attached changes between one turn and the next -- so the
    /// browser reports it per turn rather than at construction, from the same `Files.bounds` that
    /// scopes a worker. Passing empty arrays is a turn confined to the Diamond's own directory,
    /// which is the safe reading of "nothing was said": the reach fails closed.
    ///
    /// # Arguments
    /// * `id` - The Diamond.
    /// * `instruction` - What the user said, before `/name` resolution.
    /// * `attached` - JSON array of the paths the user marked into this Diamond, as workspace-
    ///   relative strings, already filtered to those the OPEN workspace can reach.
    /// * `read_only` - JSON array of those of them to be consulted rather than edited.
    /// * `prior` - The daimon's conversation so far, in the shape
    ///   [`DaimondApp::export_session`] produces. Empty starts a new daimon.
    /// * `on_event` - The event sink.
    ///
    /// # Returns
    /// The conversation after the turn, to be stored and handed back next time.
    /// Returned even though the turn may have failed part-way — a turn that got three
    /// tool calls in before dying still happened, and dropping it would make the
    /// daimon forget work it has already been billed for.
    pub async fn steer_crystal(
        &self,
        id:          String,
        instruction: String,
        attached:    String,
        read_only:   String,
        prior:       js_sys::Array,
        on_event:    js_sys::Function,
    )
        -> Result<js_sys::Array, JsValue>
    {
        self.steer_inner(&id, instruction, attached, read_only, prior, on_event)
            .await
            .map_err(to_js_err)
    }

    /// Propose a fold: run a fresh reducer over the current crystal data plus one
    /// `delta`, returning the PROPOSED new crystal data.  Writes
    /// nothing — the advisory half of the fold (H2); the delta is applied
    /// only on explicit confirm via [`DaimondApp::fold_apply`].
    ///
    /// The page is not folded and is not shown to the reducer.  It is presentation, and a reducer
    /// asked to summarise a Diamond has no business rewriting how it looks.
    pub async fn fold_propose(&self, id: String, delta: String) -> Result<String, JsValue> {
        self.fold_propose_inner(&id, &delta).await.map_err(to_js_err)
    }

    /// Which top-level keys accepting `proposal` would drop from this Diamond's crystal, as a
    /// JSON array of names.  Empty means none.
    ///
    /// **The fold is the one path where a key can vanish on a single click**, and the schema's
    /// governing rule is that nothing may ever drop a key it does not recognise.  The reducer is a
    /// fresh, tool-less model under a user-editable prompt, rewriting the whole file from one
    /// sentence; key drift is its expected behaviour rather than a risk, and `{}` is a valid
    /// crystal, so no parse check can catch it.  Comparing the two key sets is what can.
    ///
    /// Names and not a sentence, deliberately: the warning is shown beside the Accept button and
    /// belongs in the user's own language, which this side does not speak.
    ///
    /// Asked separately from [`DaimondApp::fold_propose`] rather than folded into its result, so
    /// the existing single-string contract is untouched -- and because the honest moment to ask is
    /// when the user is about to accept, not when the proposal was made.  The crystal can move
    /// between the two, and this reads it as it stands now.
    ///
    /// # Arguments
    /// * `id` - The Diamond.
    /// * `proposal` - The proposed crystal, as [`DaimondApp::fold_propose`] returned it.
    pub async fn fold_keys_lost(&self, id: String, proposal: String)
        -> Result<String, JsValue>
    {
        self.fold_keys_lost_inner(&id, &proposal).await.map_err(to_js_err)
    }

    /// Apply a confirmed fold: write the accepted `new_crystal`, snapshot a
    /// version, retain the raw `delta` under `.daimond/deltas/`, and append a
    /// `fold` record referencing it.  Called only after the user accepts
    /// the proposed diff, so a fold never auto-applies and never discards
    /// the raw delta.
    pub async fn fold_apply(
        &self,
        id:        String,
        new_crystal: String,
        delta:     String,
        note:      String,
    )
        -> Result<(), JsValue>
    {
        diamond::fold_apply(&id, &new_crystal, &delta, &note).await.map_err(to_js_err)
    }

    /// Cumulative prompt tokens billed to this session.
    #[wasm_bindgen(getter)]
    pub fn prompt_tokens(&self) -> f64 {
        self.session.borrow().prompt_tokens as f64
    }

    /// Cumulative completion tokens billed to this session.
    #[wasm_bindgen(getter)]
    pub fn completion_tokens(&self) -> f64 {
        self.session.borrow().completion_tokens as f64
    }

    /// Cumulative prompt tokens for the turn IN FLIGHT, safe to read while it
    /// runs.
    ///
    /// The plain [`DaimondApp::prompt_tokens`] getter borrows the session, which
    /// [`DaimondApp::run_turn`] holds mutably for the whole turn, so reading it
    /// mid-turn panics the `RefCell`. These live counters sit on the agent,
    /// outside that borrow, and are updated round by round, so the browser can
    /// show a running worker's cost climbing on its tile.
    #[wasm_bindgen(getter)]
    pub fn live_prompt_tokens(&self) -> f64 {
        self.agent.live_prompt.get() as f64
    }

    /// Cumulative completion tokens for the turn in flight; see
    /// [`DaimondApp::live_prompt_tokens`].
    #[wasm_bindgen(getter)]
    pub fn live_completion_tokens(&self) -> f64 {
        self.agent.live_completion.get() as f64
    }

    /// Cumulative prompt tokens this session's provider served from its cache.
    ///
    /// Borrows the session, so it is a POST-TURN read only: `run_turn` holds the
    /// session mutably for the whole turn and reading it mid-turn panics the
    /// `RefCell`.  Mid-turn, read [`DaimondApp::live_cached_tokens`].
    #[wasm_bindgen(getter)]
    pub fn cached_tokens(&self) -> f64 {
        self.session.borrow().cached_tokens as f64
    }

    /// Cumulative USD the provider says this session actually cost.
    ///
    /// Zero means no provider reported a figure -- never that the session was
    /// free -- so a caller reading zero prices the turn from its own table.
    /// Post-turn only, exactly as [`DaimondApp::cached_tokens`].
    #[wasm_bindgen(getter)]
    pub fn cost_usd(&self) -> f64 {
        self.session.borrow().cost_usd
    }

    /// Prompt tokens of the LAST request this session made — one round, not the
    /// turn's running total.
    ///
    /// This is the figure a context meter wants, and the only one that answers
    /// "how full is the window": what the model was actually sent most recently.
    /// A turn's cumulative prompt is a different quantity entirely — an agentic
    /// turn of twelve rounds sends the conversation twelve times, so summing the
    /// rounds reads roughly twelve times the context actually in use.  The
    /// browser had no way to ask for the per-round figure: [`DaimondApp::restore`]
    /// takes it as an argument and nothing read it back out.
    ///
    /// Borrows the session, so it is a POST-TURN read only, exactly as
    /// [`DaimondApp::cached_tokens`]; [`DaimondApp::run_turn`] holds the session
    /// mutably for the whole turn and a mid-turn read panics the `RefCell`.
    ///
    /// Zero means no round of this session ever reported a prompt count — never
    /// that the last request was empty — so a caller reading zero should draw
    /// nothing rather than a full meter.
    #[wasm_bindgen(getter)]
    pub fn last_prompt_tokens(&self) -> f64 {
        self.session.borrow().last_prompt_tokens as f64
    }

    /// Cumulative cached prompt tokens for the turn IN FLIGHT, safe to read
    /// while it runs; see [`DaimondApp::live_prompt_tokens`].
    #[wasm_bindgen(getter)]
    pub fn live_cached_tokens(&self) -> f64 {
        self.agent.live_cached.get() as f64
    }

    /// Cumulative provider-reported USD for the turn IN FLIGHT, safe to read
    /// while it runs; see [`DaimondApp::live_prompt_tokens`].
    #[wasm_bindgen(getter)]
    pub fn live_cost_usd(&self) -> f64 {
        self.agent.live_cost.get()
    }

    /// Write raw bytes to `path` in the ACTIVE workspace root.
    ///
    /// The one path by which the browser half can put bytes somewhere without
    /// reaching into OPFS itself.  It goes through [`crate::wasm::opfs`], so it
    /// inherits the lexical path jail, the real-folder override when one is
    /// open, AND the per-account namespace -- the last of which a hand-rolled
    /// `navigator.storage.getDirectory()` walk in the page does not, which is
    /// how a secondary account's compiled PDFs and saved mail landed in the
    /// primary account's workspace.
    ///
    /// # Arguments
    /// * `path` - Workspace-relative destination path.
    /// * `bytes` - The bytes to write, replacing any existing file.
    pub async fn write_bytes(&self, path: String, bytes: Vec<u8>) -> Result<(), JsValue> {
        crate::wasm::opfs::write_file(crate::tools::FileRoot::Workspace, &path, &bytes)
            .await
            .map_err(to_js_err)
    }
}

/// Read a JSON array of plain strings, dropping anything blank.
///
/// A small reader rather than a JSON dependency: the input is written by our own caller, and the
/// failure mode that matters is "read nothing", not "read something wrong" -- an empty list still
/// leaves a scope bounded, where a wrong one would not.
///
/// # Arguments
/// * `src` - The JSON array, as the browser wrote it.
fn parse_path_array(src: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut chars = src.chars().peekable();
    let mut cur = String::new();
    let mut inside = false;
    let mut escaped = false;
    while let Some(c) = chars.next() {
        if escaped { cur.push(c); escaped = false; continue; }
        match c {
            '\\' if inside => escaped = true,
            '"' => {
                if inside {
                    if !cur.trim().is_empty() { out.push(cur.clone()); }
                    cur.clear();
                }
                inside = !inside;
            }
            _ if inside => cur.push(c),
            _ => {}
        }
    }
    out
}

/// Inner helpers for the crystal and reducer turns.  Kept in a plain
/// `impl` (not `#[wasm_bindgen]`) so they can take Rust-only types and
/// return [`Outcome`], using the error macros throughout; the exported
/// wrappers above map the result to the JS boundary.
impl DaimondApp {

    /// What this turn is told beyond its role: which model is carrying it, and what machine it can
    /// reach.
    ///
    /// Composed per TURN and not at construction, because both halves move under a built agent --
    /// the fence depends on the Diamond's bounds and on whether the turn has read a stranger's
    /// words, and asking the hand needs an await the constructor does not have.  Either half may
    /// come back empty (no model configured, no hand attached) and then it simply is not said:
    /// this rides on every request of every turn, so an absent capability is not worth describing.
    ///
    /// # Arguments
    /// * `registry` - The tools this turn will hold, which decide the fence and whether the model
    ///   is asked to judge its own fan-out.
    async fn briefing(&self, registry: &ToolRegistry) -> String {
        // Read off the client that will actually carry the request, never a constant: a written-
        // down model name is a lie the moment the user switches provider.
        let mut s = crate::prompts::model_note(
            &self.agent.llm.model,
            &self.agent.llm.host,
            registry.tools.contains(&Tool::SpawnAgent));
        // The machine only where a command can actually be run on it. A daimon holds file tools
        // and `spawn_agent` and no `run`, so a paragraph about which folders a command may touch
        // is a paragraph it can never act on -- and it would be paid for on every request of every
        // steering turn.
        if registry.tools.contains(&Tool::Run) {
            // The whole context, so the folders and the network sentence the model is shown are
            // the fence the command will actually run under -- which now includes what the user
            // has already said about this turn reaching out. A worker told it had the network and
            // then refused by the fence spends the turn debugging the app.
            let machine = crate::prompts::machine_briefing(&registry.ctx).await;
            if !machine.is_empty() {
                if !s.is_empty() {
                    s.push_str("\n\n");
                }
                s.push_str(&machine);
            }
        }
        s
    }

    /// Drive the crystal agent for one instruction (see
    /// [`DaimondApp::steer_crystal`]).
    async fn steer_inner(
        &self,
        id:          &str,
        instruction: String,
        attached:    String,
        read_only:   String,
        prior:       js_sys::Array,
        on_event:    js_sys::Function,
    )
        -> Outcome<js_sys::Array>
    {
        // What this daimon may write and run in, composed from the marks the browser reports.
        //
        // The same function a worker's scope is built from, called with this Diamond's own
        // directory, so the daimon and the workers it dispatches cannot come to hold different
        // ideas of where the work is.  It FAILS CLOSED, and that is deliberate: a caller that
        // passes nothing gets `Bound::Nowhere` beside the Diamond's own directory -- today's reach
        // exactly, minus the pin -- rather than an unbounded turn.  The marks arrive per turn
        // because they change per turn: the user attaches a folder and the next thing they do is
        // ask about it, and a scope composed once at construction would still be yesterday's.
        let marked = parse_path_array(&attached);
        let consult = parse_path_array(&read_only);
        let bounds = crate::tools::diamond_bounds(
            &diamond::diamond_dir(id), &marked, &consult);
        // A `/name` here matters more than in a chat, not less: a skill lives in the workspace, and
        // until this turn was given the workspace a daimon could not read one for itself, so the
        // prose convention failed here in total silence.
        //
        // What the user TYPED is kept for the log below. The record of why a crystal changed should
        // read `/pickup daimond`, which is what they did; the skill's whole text is in the skill.
        let typed = instruction.clone();
        let instruction = match open_command(instruction).await {
            Opened::Send(text)  => text,
            Opened::Refuse(msg) => return Err(refuse(&msg)),
        };
        // Stateless per instruction: reconstruct context from the crystal.
        //
        // The heading names the FILE, not the format, and that is what makes the standing context
        // and the file tools agree: a daimon told "here is the crystal" and left to find out where
        // it lives has to guess a name, and the name changed under it.
        let before = diamond::read_crystal_data(id).await.unwrap_or_default();
        // Read before the turn, compared after it. The page is not put in the prompt -- it is
        // markup the daimon can open with `file_read` when it has been asked to change it, and it
        // would otherwise be paid for on every request of every steering turn.
        let page_before = diamond::read_crystal_page(id).await.unwrap_or_default();
        let mut system = Role::Daimon.compose(&self.daimon_prompt.borrow());
        // Where this daimon stands, said per turn because only the turn knows the id and the marks.
        //
        // The role text cannot carry either: it is one constant shared by every Diamond, and the
        // user may edit it (`prompts/<role>.md`).  What goes here is the part that is true of THIS
        // Diamond at THIS moment -- its own folder, and what the paperclip has put in reach.
        //
        // Naming the marks is worth its tokens, and the reason is a real failure: a daimon whose
        // user had just attached a book spent a turn globbing for it, found nothing where it was
        // pinned, and reported that the book did not exist.  A model that is TOLD `books/x` is
        // attached does not have to discover it, and cannot conclude it is absent.
        system.push_str("\n\nThis Diamond's own folder is `");
        system.push_str(&diamond::diamond_dir(id));
        system.push_str("/`, so its crystal is `");
        system.push_str(&diamond::diamond_dir(id));
        system.push_str("/crystal.json` and its page is the `crystal.html` beside it. Paths you \
            give the file tools are whole workspace-relative paths, never bare names.");
        if marked.is_empty() && consult.is_empty() {
            system.push_str(" Nothing is attached to this Diamond yet, so the folder above is the \
                only place you may write. If the user asks for work on files that are not there, \
                say what needs attaching with the paperclip rather than creating it.");
        } else {
            system.push_str("\n\nAttached to this Diamond, and reachable now:\n");
            for p in &marked {
                system.push_str("- `");
                system.push_str(p);
                system.push_str("` (yours to edit)\n");
            }
            for p in &consult {
                system.push_str("- `");
                system.push_str(p);
                system.push_str("` (read it; do not edit it)\n");
            }
            system.push_str("Look at what is attached before you answer a question about it. You \
                may READ anywhere in the workspace, and you may write only in the places above.");
        }
        system.push_str("\n\nCurrent crystal.json:\n");
        system.push_str(&before);

        // The daimon reaches what its workers reach, and writes where the user marked.
        //
        // It was PINNED here until 2026-08-13 -- `path_prefix` at `diamonds/<id>` and the OPFS
        // root -- and the two together meant a daimon could not see the folder attached to its own
        // Diamond.  A user attached a 281-page book, asked the daimon to set up an editing loop
        // over it, and was told the book did not exist: the glob walked `diamonds/<id>` in browser
        // storage, found the crystal scaffold, and correctly reported no chapters.  It then offered
        // to CREATE the manuscript, which under the prefix would have written a skeleton into the
        // sandbox while the real book sat on disk.  The attachment had always reached the workers
        // (`scopeAgentTo` in `www/js/daimond.js`) and never the daimon commanding them.
        //
        // So the reach is now composed exactly as a worker's is, from the same function, and the
        // two cannot drift: read freely across the workspace, write and run only in this Diamond's
        // own directory and what the user marked into it.
        //
        // `FileRoot::Workspace` is what makes BOTH halves reachable at once, and it is not a
        // widening: `opfs::resolve_root` sends a store path to OPFS whatever folder is open, so
        // `diamonds/<id>/crystal.json` still lands in the sandbox and `books/x/ch05.typ` still
        // lands on the machine.  Pinning OPFS was what made the second impossible.
        let ctx = ToolContext {
            workspace:   Workspace::unchecked(PathBuf::from("/")),
            executor:    Executor::Wasm,
            cwd:         String::new(),
            // Empty, and that is the whole of the change: a prefix CONFINES, and this turn is
            // confined by its bounds instead.  Its own paths are whole and workspace-relative now,
            // exactly as a worker's are, which is what `DEFAULT_DAIMON` tells the model.
            path_prefix: String::new(),
            root:        crate::tools::FileRoot::Workspace,
            // Shared with this app's own context, not fresh: a steering turn is stateless per
            // instruction, so a fresh cache would drop the taint the moment the turn ended and
            // `is_tainted` would answer no to the very question the daimon asks it.
            read_seen:   self.registry.ctx.read_seen.clone(),
            no_write:    bounds,
            // Who this turn acts for, which the prefix used to say and no longer can.  A link this
            // daimon asserts goes in THIS Diamond's sidecar and is stamped `agent:daimon`.
            daimon_of:   id.to_string(),
        };
        let registry = ToolRegistry::new(
            vec![
                Tool::FileRead,
                Tool::FileWrite,
                Tool::FileEdit,
                Tool::FileList,
                Tool::FileSearch,
                Tool::FileGlob,
                Tool::FileDelete,
                Tool::FileMove,
                Tool::DirCreate,
                // The three a daimon went without, and the reason they were withheld expired
                // rather than being overruled.
                //
                // `Tool::Run` was refused on the ground that a turn pinned to `diamonds/<id>` on
                // the OPFS root has nowhere on the machine to run anything, so offering it would
                // produce only refusals. That was true and is not any more: the pin went when a
                // daimon proved unable to read the book attached to its own Diamond, and what
                // replaced it is `diamond_bounds` and a `start_dir` that names the first folder
                // the user marked in. A daimon asked to set up an editing loop over that book
                // could not open a terminal, could not put a file on the Doc panel, and could not
                // compile it -- three refusals in one turn, all of them structural.
                //
                // Each is fenced by something that already exists: `run` by `fence_spec` from the
                // same bounds a worker gets, and `typst_compile` by pack `drop01`, which refuses
                // on an account that has not bought it and says so. `file_show` is the one whose
                // absence was worst, and the catalogue says why -- a model with no way to show a
                // file does not merely fail to show one, it tells the user the app cannot.
                Tool::Run,
                Tool::FileShow,
                Tool::TypstCompile,
                // Counting a file as this Diamond's, which `DEFAULT_DAIMON` has instructed the
                // daimon to do since the tool was written -- while no registry anywhere offered
                // it.  A prompt naming a tool that is not there does not fail loudly: the model
                // reports that it cannot record the file, or invents a way to, and the user reads
                // either as the app being broken.  It belongs to this turn and no other, because
                // an artefact is recorded ON a Diamond and this is the turn that has one.
                Tool::ArtefactAdd,
                // The daimon commands agents; the workers do the work.
                Tool::SpawnAgent,
                // The world model.  These three are the daimon's and not the chat's, on the same
                // ground `spawn_agent` is: a link is kept ON a Diamond, and this is the only turn
                // that HAS one -- its `path_prefix` names the Diamond, so `link_add` knows where
                // the record goes without the model having to be right about it.  A chat is scoped
                // to no Diamond, so every write it made would be aimed by an argument the model
                // chose at a Diamond it does not belong to.
                Tool::LinkList,
                Tool::LinkAdd,
                Tool::LinkRemove,
            ],
            ctx,
        );
        let agent = Agent::new(self.agent.llm.clone(), &self.with_instructions(&system));
        // A fresh agent starts from the default limits, so without this a Diamond's
        // daimon would fold the same model's conversation at a different size from
        // the chat that dispatched it.
        agent.adopt_limits(&self.agent);
        // And it starts with no briefing at all, which left the ONE agent that dispatches workers
        // as the one agent that could not judge how many to dispatch.
        agent.set_briefing(&self.briefing(&registry).await);
        let mut session = Session::new(
            generate_session_id(),
            fmt!("crystal:{}", id),
            self.session.borrow().model.clone(),
        );
        // What this daimon already knows, made WHOLE before it is accepted -- the same
        // repair `restore_session` does, and for the same reason: this list has been
        // through the browser's store, which is merged across tabs and devices and
        // restored from backups, so a conversation that has lost a tool reply somewhere
        // along the way is a thing that will happen. It must cost this one call rather
        // than every turn from here on.
        let mut seeded: Vec<ChatMessage> = Vec::new();
        for item in prior.iter() {
            if let Some(m) = js_to_message(&item) {
                seeded.push(m);
            }
        }
        session.messages = pair_up(seeded);

        let mut sink = |ev: AgentEvent| {
            let js = event_to_js(&ev);
            let _ = on_event.call1(&JsValue::NULL, &js);
        };
        let ran = agent.run_turn(&mut session, instruction, &registry, &mut sink).await;
        self.absorb_usage(&session);

        // If the crystal changed, snapshot a version and log the edit so
        // every crystal mutation stays versioned and auditable.  Attempted even when
        // the turn ended badly: a turn that wrote the crystal and then died has still
        // changed it, and leaving that version unrecorded is the one outcome with no
        // way back.
        let after = diamond::read_crystal_data(id).await.unwrap_or_default();
        // THE PAGE COUNTS AS A CHANGE TOO. A turn asked to redesign how a Diamond looks writes
        // `crystal.html` and touches no data at all, and judging by the data alone would leave
        // that turn's work on disk with no version, no snapshot and no line in the log saying who
        // asked for it -- the one change in a Diamond with no way back.
        let page_after = diamond::read_crystal_page(id).await.unwrap_or_default();
        if after != before || page_after != page_before {
            res!(diamond::record_steer(id, &after, &typed).await);
        }
        // The conversation goes back whichever way the turn went, and a failed turn is
        // therefore NOT an error out of here. A turn that got three tool calls in before
        // failing still happened and was still paid for, and throwing would take the
        // whole conversation with it -- the daimon would forget work it has already been
        // billed for, every time a provider hiccupped.
        //
        // Nothing is hidden by that. Every `Err` return inside `run_turn` is preceded by
        // an `AgentEvent::Error` on this same sink, so the caller learns of the failure
        // through the events it is already reading; what it also gets, now, is the
        // conversation to keep. A failure BEFORE the turn -- an unresolvable `/name`, an
        // unreadable crystal -- still throws, because there is nothing to keep.
        if let Err(e) = ran {
            // Logged rather than swallowed: the event carried the message, but a
            // developer reading the console should not have to reconstruct which turn
            // it belonged to.
            web_sys::console::warn_1(&JsValue::from_str(
                &fmt!("daimon turn on {} ended early: {}", id, e)));
        }
        let out = js_sys::Array::new();
        for msg in session.messages.iter() {
            out.push(&message_to_js(msg));
        }
        Ok(out)
    }

    /// Which keys a proposal would drop, as a JSON array (see [`DaimondApp::fold_keys_lost`]).
    async fn fold_keys_lost_inner(&self, id: &str, proposal: &str) -> Outcome<String> {
        let crystal = res!(diamond::read_crystal_data(id).await);
        let lost = crate::agent::compact::crystal_keys_lost(&crystal, proposal);
        let items: Vec<String> = lost.iter()
            .map(|k| fmt!("\"{}\"", crate::llm::json_escape(k)))
            .collect();
        Ok(fmt!("[{}]", items.join(",")))
    }

    /// Drive the reducer for one delta, returning the proposed crystal (see
    /// [`DaimondApp::fold_propose`]).
    async fn fold_propose_inner(&self, id: &str, delta: &str) -> Outcome<String> {
        let crystal = res!(diamond::read_crystal_data(id).await);
        let user_msg = fmt!(
            "Current crystal.json:\n{}\n\n---\nDelta to fold in:\n{}",
            crystal, delta,
        );
        // The reducer only emits text — no tools, so it cannot write.
        let ctx = ToolContext {
            workspace:   Workspace::unchecked(PathBuf::from("/")),
            executor:    Executor::Wasm,
            cwd:         String::new(),
            path_prefix: String::new(),
            // The reducer is tool-less; pin OPFS for consistency with the
            // other Diamond contexts.
            root:        crate::tools::FileRoot::Opfs,
            read_seen:   crate::tools::new_read_cache(),
            // The browser agent is the user's own, not a skill's, so nothing is locked out of it.
            // A skill turn narrows this in the handler, where the declaration is known.
            no_write:    Vec::new(),
            // The reducer holds no tools, so it asserts nothing and owns nothing.
            daimon_of:   String::new(),
        };
        let registry = ToolRegistry::new(Vec::new(), ctx);
        let reducer = Role::Reducer.compose(&self.reducer_prompt.borrow());
        let agent = Agent::new(self.agent.llm.clone(), &self.with_instructions(&reducer));
        // The reducer folds by the same figures as the chat, for the same reason the
        // daimon does.
        agent.adopt_limits(&self.agent);
        let mut session = Session::new(
            generate_session_id(),
            fmt!("reducer:{}", id),
            self.session.borrow().model.clone(),
        );
        let mut out = String::new();
        // What the reducer said went wrong.  The sink used to keep only `Text`,
        // so a turn that failed -- a refused key, a rate limit, a model that
        // errored -- accumulated nothing and this returned `Ok("")`: an EMPTY
        // proposal, which the caller then offered the user as a fold that
        // deletes the whole crystal.  An error is now carried out, and an empty
        // proposal is refused whatever its cause.
        let mut failure = String::new();
        {
            let mut sink = |ev: AgentEvent| {
                match &ev {
                    AgentEvent::Text(t)  => out.push_str(t),
                    AgentEvent::Error(m) => if failure.is_empty() { failure = m.clone(); },
                    _                    => {},
                }
            };
            res!(agent.run_turn(&mut session, user_msg, &registry, &mut sink).await);
        }
        self.absorb_usage(&session);
        if !failure.is_empty() {
            return Err(err!(
                "The reducer could not propose a fold: {}", failure; Network, Invalid));
        }
        // THE PROPOSAL IS PARSED BEFORE IT IS OFFERED. This subsumes the bare "not empty" check
        // that used to stand here, which was the only gate a proposal passed through.
        //
        // Emptiness was never the dangerous case. A reply cut off at the output limit is the
        // commonest fold failure there is, and jdat's text decoder returns `Ok` for a map whose
        // input simply stops -- `{"title": "half` decodes happily where `JSON.parse` refuses it.
        // So a truncated crystal reached the user as a proposal they could accept, and accepting
        // it wiped everything after the cut.
        //
        // The RETURNED string is what goes onward, never `out`: it comes back unfenced and
        // trimmed, and handing the raw model output on instead would write a markdown fence into
        // the crystal.
        let proposal = res!(crate::agent::compact::crystal_proposal(&out));

        // A KEY THAT WOULD VANISH IS RECORDED HERE AND REFUSED NOWHERE.
        //
        // `{}` is a valid crystal under the schema, so no parse check can tell a legitimately
        // empty one from a fold that dropped everything. What answers it is comparing the two key
        // sets, and the user is the one who decides -- so this does not refuse. What it must not
        // do is bake the key names into an English sentence: the warning belongs beside the
        // Accept button in the user's own language, which is [`DaimondApp::fold_keys_lost`]'s job.
        //
        // The line below is the backstop, not the mechanism. It costs nothing, it cannot mislead,
        // and it means a dropped key is in the console and the durable trail even on a build where
        // the warning has not been wired up yet.
        let lost = crate::agent::compact::crystal_keys_lost(&crystal, &proposal);
        if !lost.is_empty() {
            crate::wasm::entry::trail("FOLD DROPS KEYS", &fmt!("{} — {}", id, lost.join(", ")));
            web_sys::console::warn_1(&JsValue::from_str(&fmt!(
                "The fold proposed for Diamond {} drops {} from its crystal.",
                id, lost.join(", "))));
        }
        Ok(proposal)
    }
}

// ── The slash command a person types ─────────────────────────────────────────
//
// `DAIMOND.md` tells the model that a `/name` means "read
// `code/ai/context/dump/skills/claude/<name>/SKILL.md` and follow it".  That is prose, and prose is
// enforced by the model's willingness: it half-works, and when it does not work it fails SILENTLY
// -- a model that does not bother, or reads the wrong file, produces a perfectly plausible session
// that skipped the instructions, and nobody can tell from the outside.  In the browser, which is
// the only place the user actually works, nothing read a skill at all: `skills::expand` has one
// caller and it is in `handler`, which `lib.rs` gates out of the wasm build.
//
// So the page resolves it instead, here, before the turn starts.  Three properties follow, and
// they are the whole of why this is not left to the model:
//
// * **It happens or it is refused.**  A name that resolves to no file ends the turn with a message
//   saying so, and nothing reaches the provider.  Falling through to ordinary chat is the one
//   outcome that must never happen, because the user then believes a workflow ran.
// * **The file's own text goes in.**  Not a path for the model to fetch, so a skill works for a
//   turn whose file tools are pinned somewhere else entirely -- which is exactly a Diamond's
//   daimon, fenced to `diamonds/<id>` and unable to read `.daimond/skills` at all.
// * **It is the user's own instruction, so it is trusted as one.**  A skill is a file the user
//   wrote in their own workspace, standing where `DAIMOND.md` and `prompts/<role>.md` already
//   stand, and it is injected verbatim rather than wrapped as untrusted content.  That judgement
//   rests entirely on where it came from: the day a skill can be IMPORTED from a stranger, it stops
//   being the user speaking and the `uses` declaration in [`crate::skills::Skill`] is what has to
//   start being enforced here, as it already is in `handler`.

/// A message the user typed, once any `/name` in it has been resolved.
///
/// An enum rather than an `Option<String>` because the two outcomes are not "changed" and
/// "unchanged" -- one sends a turn and one refuses to, and a caller that muddled them would send
/// the refusal to the model.
enum Opened {
    /// Send this: the message unchanged, or a skill's instructions with the rest of it.
    Send(String),
    /// Show this and run nothing: the user named a skill that is not there.
    Refuse(String),
}

/// Resolve a leading `/name` to the skill file's own text, or pass the message through untouched.
///
/// # Arguments
/// * `msg` - The message exactly as the user typed it.
async fn open_command(msg: String) -> Opened {
    let cmd = match crate::skills::parse_command(&msg) {
        Some(c) => c,
        None    => return Opened::Send(msg),    // not a command; an ordinary message
    };
    let mut roots = vec![crate::tools::FileRoot::Workspace];
    // Only while a folder is open are these two different stores; without one they are the same
    // directory, and searching it twice would double the cost of every refusal.
    if crate::wasm::opfs::workspace_mode() == "folder" {
        roots.push(crate::tools::FileRoot::Opfs);
    }
    // What was actually searched, for the refusal.  Each store brings its own search path, so this
    // is a union and not a constant -- a user who named a directory in the folder they have open
    // should be told it was looked in, and one who named it in the other store should be able to
    // see from the same sentence that it was not.
    let mut looked_in: Vec<String> = Vec::new();
    for root in roots {
        let extra = search_path(root).await;
        for dir in crate::skills::command_dirs(&extra) {
            if !looked_in.contains(&dir) {
                looked_in.push(dir);
            }
        }
        if let Some((path, text)) = read_skill(root, &cmd.name, &extra).await {
            let sk = crate::skills::parse_skill(&text, &cmd.name);
            return Opened::Send(
                crate::skills::compose_command(&sk.name, &path, &sk.body, &cmd.args));
        }
    }
    Opened::Refuse(crate::skills::no_such_skill(&cmd.name, &looked_in))
}

/// The extra directories this store's own `.daimond/skills.path` names, or none.
///
/// A store without the file is the ordinary case, not a fault: nothing is logged and the only
/// place searched is Daimond's own skills directory.  See [`crate::skills::SEARCH_PATH_FILE`] for
/// why the list is data in the workspace rather than a constant in the binary.
///
/// # Arguments
/// * `root` - The store to read it from.
async fn search_path(root: crate::tools::FileRoot) -> Vec<String> {
    let bytes = match crate::wasm::opfs::read_file(root, crate::skills::SEARCH_PATH_FILE).await {
        Ok(b)  => b,
        Err(_) => return Vec::new(),
    };
    match String::from_utf8(bytes) {
        Ok(text) => crate::skills::parse_search_path(&text),
        Err(_)   => Vec::new(),
    }
}

/// Read the skill a `/name` invoked out of ONE store, as `(path, text)`, or `None` where no such
/// file is there.
///
/// Two stores are searched, not one, and [`open_command`] is where that happens.  The user's real
/// folder is where their skills actually live, and it is not open in Browser mode -- so a lookup
/// that knew only about it would answer "no such skill" for every skill they have, in the one mode
/// that always works.  Daimond's own OPFS store is the place that is always there, and it is
/// searched second so a real folder's copy wins.  Nothing syncs between the two: putting a skill
/// in the sandbox is a file the user writes there (through the Workspace panel, like any other),
/// and making that automatic would need a sync of `.daimond/skills` on folder open, which is not
/// built here.
///
/// A file that exists but is blank is passed over rather than injected: an empty skill is
/// indistinguishable, once in front of the model, from no skill at all, and the refusal that
/// follows at least names what was looked for.
///
/// # Arguments
/// * `root` - The store to search.
/// * `name` - The skill's name, as typed after the slash.
/// * `extra` - The directories this store's own search path added, beyond Daimond's.
async fn read_skill(root: crate::tools::FileRoot, name: &str, extra: &[String])
    -> Option<(String, String)>
{
    for path in crate::skills::command_paths(name, extra) {
        let bytes = match crate::wasm::opfs::read_file(root, &path).await {
            Ok(b)  => b,
            Err(_) => continue,     // not there, or not readable: try the next place
        };
        if let Ok(text) = String::from_utf8(bytes) {
            if !text.trim().is_empty() {
                return Some((path, text));
            }
        }
    }
    None
}

/// The refusal a turn ends with when the user named a skill that is not there.
///
/// Carried by the REJECTION rather than by an `Error` event, and it has to be, because a Diamond's
/// status line is wiped the instant a steer resolves: an event there would flash and vanish, which
/// is the failure this whole path exists to end.  Every surface already draws what a rejection
/// carries -- a chat writes it into its transcript, a worker onto its tile, a Diamond into its
/// status line -- so none of them has to learn anything new, and each reports it exactly once.
///
/// # Arguments
/// * `msg` - What to tell the user.
fn refuse(msg: &str) -> Error<ErrTag> {
    err!("{}", msg; Invalid, Input)
}

/// Convert a [`ChatMessage`] to a plain JS object mirroring
/// [`ChatMessage::to_datmap`], so the browser can store the conversation the
/// model holds without inventing a second shape for it.
///
/// **`content` crosses this boundary as a STRING, always -- an image is written as the line that
/// names it and its bytes stay in Rust.**  Not an oversight; the alternative was weighed and
/// refused.  What is on the other side of this function is `chat.session.msgs`, which the browser
/// puts in its own store and hands back on the next reload, and which the journal's write-ahead
/// log copies through on every turn.  Carrying a megabyte of base64 there would put a screenshot
/// into the store, into the sync parcel, and into the log, on every turn that held one -- to buy
/// what?  The model does not need it: the line names the file, `file_read` fetches it again, and
/// a reloaded chat is a chat the model is re-reading anyway.  It is the same trade
/// `crate::compact::elide_bulk` makes when the window fills, made for the same reason.
fn message_to_js(msg: &ChatMessage) -> JsValue {
    let obj = js_sys::Object::new();
    let set = |k: &str, v: &JsValue| {
        // `Reflect::set` on a fresh object cannot fail; ignore the result.
        let _ = js_sys::Reflect::set(&obj, &JsValue::from_str(k), v);
    };
    match msg {
        ChatMessage::System { content } => {
            set("role", &JsValue::from_str("system"));
            set("content", &JsValue::from_str(&content.as_text()));
        }
        ChatMessage::User { content } => {
            set("role", &JsValue::from_str("user"));
            set("content", &JsValue::from_str(&content.as_text()));
        }
        ChatMessage::Assistant { content, tool_calls } => {
            set("role", &JsValue::from_str("assistant"));
            set("content", &JsValue::from_str(&content.as_text()));
            // Written only when there are any, exactly as the JDAT form does, so an
            // ordinary answer keeps the shape it always had.
            if !tool_calls.is_empty() {
                let calls = js_sys::Array::new();
                for tc in tool_calls {
                    let c = js_sys::Object::new();
                    let cs = |k: &str, v: &str| {
                        let _ = js_sys::Reflect::set(
                            &c, &JsValue::from_str(k), &JsValue::from_str(v));
                    };
                    cs("id", &tc.id);
                    cs("name", &tc.name);
                    cs("arguments", &tc.arguments);
                    calls.push(&c);
                }
                set("tool_calls", &calls);
            }
        }
        ChatMessage::Tool { tool_call_id, content } => {
            set("role", &JsValue::from_str("tool"));
            set("tool_call_id", &JsValue::from_str(tool_call_id));
            set("content", &JsValue::from_str(&content.as_text()));
        }
    }
    obj.into()
}

/// Read a [`ChatMessage`] back out of a plain JS object written by
/// [`message_to_js`], or `None` when the object is not one.
///
/// A tool reply with no `tool_call_id` is refused rather than given an empty one:
/// an id is what pairs it with its call, and a reply that cannot be paired is worse
/// than one that was never read.
fn js_to_message(item: &JsValue) -> Option<ChatMessage> {
    let content = js_prop(item, "content").unwrap_or_default();
    match js_prop(item, "role").unwrap_or_default().as_str() {
        "system" => Some(ChatMessage::system(content)),
        "user"   => Some(ChatMessage::user(content)),
        "tool"   => match js_prop(item, "tool_call_id") {
            Some(id) if !id.is_empty() => Some(ChatMessage::tool(id, content)),
            _ => None,
        },
        "assistant" => {
            let mut tool_calls = Vec::new();
            if let Ok(v) = js_sys::Reflect::get(item, &JsValue::from_str("tool_calls")) {
                if let Some(arr) = v.dyn_ref::<js_sys::Array>() {
                    for call in arr.iter() {
                        let id = js_prop(&call, "id").unwrap_or_default();
                        if id.is_empty() {
                            continue;       // unpairable, so not a call at all
                        }
                        tool_calls.push(ToolCall {
                            id,
                            name:      js_prop(&call, "name").unwrap_or_default(),
                            arguments: js_prop(&call, "arguments").unwrap_or_default(),
                        });
                    }
                }
            }
            Some(ChatMessage::assistant_calling(content, tool_calls))
        }
        _ => None,
    }
}

/// Make a restored conversation legal: every tool call answered, every tool reply
/// answering something.
///
/// The provider's rule is not a preference.  An assistant turn bearing `tool_calls`
/// must be followed by one `tool` message per call, and a `tool` message must follow
/// the assistant turn that asked for it; a conversation that breaks either is
/// rejected WHOLE, so one lost reply from one turn last Tuesday takes every turn
/// after it with it.  A store merged across tabs, synced between devices and
/// restored from backups will eventually hand over such a list, so it is repaired
/// here rather than trusted.
///
/// Two edits, and only these two: a call with no reply in the run of `tool` messages
/// directly after it is dropped from the assistant turn (its prose stays), and a
/// reply that answers no call in the assistant turn directly before it is dropped
/// entirely.  Nothing is reordered and nothing is invented — a call that lost its
/// result is a call the model must be allowed to make again, not one to answer with
/// a guess.
///
/// # Arguments
/// * `msgs` - The restored conversation, oldest first.
fn pair_up(msgs: Vec<ChatMessage>) -> Vec<ChatMessage> {
    let mut out: Vec<ChatMessage> = Vec::with_capacity(msgs.len());
    let mut i = 0usize;
    while i < msgs.len() {
        match &msgs[i] {
            ChatMessage::Assistant { content, tool_calls } if !tool_calls.is_empty() => {
                // The run of tool replies that directly follows, which is the only
                // place a reply to this turn may legally sit.
                let mut answered: Vec<String> = Vec::new();
                let mut j = i + 1;
                while j < msgs.len() {
                    match &msgs[j] {
                        ChatMessage::Tool { tool_call_id, .. } => {
                            answered.push(tool_call_id.clone());
                            j += 1;
                        }
                        _ => break,
                    }
                }
                let kept: Vec<ToolCall> = tool_calls.iter()
                    .filter(|tc| answered.iter().any(|id| id == &tc.id))
                    .cloned()
                    .collect();
                out.push(ChatMessage::Assistant {
                    content:    content.clone(),
                    tool_calls: kept.clone(),
                });
                // Then the replies, keeping only those that answer a call we kept.
                for k in (i + 1)..j {
                    if let ChatMessage::Tool { tool_call_id, content } = &msgs[k] {
                        if kept.iter().any(|tc| &tc.id == tool_call_id) {
                            out.push(ChatMessage::Tool {
                                tool_call_id: tool_call_id.clone(),
                                content:      content.clone(),
                            });
                        }
                    }
                }
                i = j;
            }
            // A tool reply reached here without an asking turn in front of it.
            ChatMessage::Tool { .. } => { i += 1; }
            other => { out.push(other.clone()); i += 1; }
        }
    }
    out
}

/// Convert an [`AgentEvent`] to a plain JS object mirroring
/// [`AgentEvent::to_datmap`]: a `type` discriminator plus the variant's
/// fields.  Built directly with `Reflect::set` so the JS side receives a
/// structured object, not a string it must re-parse.
fn event_to_js(ev: &AgentEvent) -> JsValue {
    let obj = js_sys::Object::new();
    let set = |k: &str, v: &JsValue| {
        // `Reflect::set` on a fresh object cannot fail; ignore the result.
        let _ = js_sys::Reflect::set(&obj, &JsValue::from_str(k), v);
    };
    match ev {
        AgentEvent::Text(text) => {
            set("type", &JsValue::from_str("text"));
            set("content", &JsValue::from_str(text));
        }
        AgentEvent::ToolCall { id, name, args } => {
            set("type", &JsValue::from_str("tool_call"));
            set("id",   &JsValue::from_str(id));
            set("name", &JsValue::from_str(name));
            set("args", &JsValue::from_str(args));
        }
        AgentEvent::ToolResult { name, result } => {
            set("type", &JsValue::from_str("tool_result"));
            set("name", &JsValue::from_str(name));
            set("content", &JsValue::from_str(result));
        }
        AgentEvent::Interjected(text) => {
            set("type", &JsValue::from_str("interjected"));
            set("content", &JsValue::from_str(text));
        }
        AgentEvent::Compacted { folded, kept, note } => {
            set("type", &JsValue::from_str("compacted"));
            set("folded", &JsValue::from_f64(*folded as f64));
            set("kept", &JsValue::from_f64(*kept as f64));
            set("content", &JsValue::from_str(note));
        }
        AgentEvent::Truncated => {
            set("type", &JsValue::from_str("truncated"));
        }
        AgentEvent::Done => {
            set("type", &JsValue::from_str("done"));
        }
        AgentEvent::Error(msg) => {
            set("type", &JsValue::from_str("error"));
            set("content", &JsValue::from_str(msg));
        }
    }
    obj.into()
}

/// Split a full `scheme://host[:port]/path` base URL into
/// `(secure, host, port, path)`.
///
/// `https` and `http` are both accepted — the former for real providers,
/// the latter for a local mock over `127.0.0.1`.  The port defaults to
/// the scheme default (443 / 80) when absent; the path defaults to `/`.
fn parse_base_url(url: &str) -> Outcome<(bool, String, u16, String)> {
    let (secure, default_port, rest) = if let Some(r) = url.strip_prefix("https://") {
        (true, 443u16, r)
    } else if let Some(r) = url.strip_prefix("http://") {
        (false, 80u16, r)
    } else {
        return Err(err!(
            "DaimondApp: base URL '{}' must start with http:// or https://.", url;
            Invalid, Input));
    };
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None    => (rest, "/"),
    };
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) => {
            let port = res!(p.parse::<u16>()
                .map_err(|e| err!(e, "DaimondApp: bad port in '{}'.", url; Invalid, Input)));
            (h.to_string(), port)
        }
        None => (authority.to_string(), default_port),
    };
    if host.is_empty() {
        return Err(err!("DaimondApp: empty host in '{}'.", url; Invalid, Input));
    }
    Ok((secure, host, port, path.to_string()))
}
