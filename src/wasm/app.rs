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
use crate::llm::{Halt, LlmClient, parse_json_string_array};
use crate::prompts::Role;
use crate::protocol::{AgentEvent, ChatMessage, Session, ToolCall, generate_session_id};
use crate::tools::{Tool, ToolContext, ToolRegistry};
use crate::executor::Executor;
use crate::workspace::Workspace;
use crate::diamond_versions::{self as versions, Cause};
use crate::wasm::{diamond, js_prop, to_js_err};

use oxedyne_fe2o3_core::prelude::*;
use oxedyne_fe2o3_jdat::Dat;

use std::cell::RefCell;
use std::path::PathBuf;

use wasm_bindgen::prelude::*;


/// What a version-recording call answers with, or `{}` where nothing had changed.
///
/// Its own function because two exports answer in the same shape, and a caller that had to tell
/// them apart would be reading two spellings of one fact.
fn versions_said(got: Option<(u64, Vec<String>)>) -> Result<String, JsValue> {
    let (version, files) = match got {
        Some(v) => v,
        None    => return Ok("{}".to_string()),
    };
    let names: Vec<String> = files.iter()
        .map(|f| fmt!("\"{}\"", crate::llm::json_escape(f)))
        .collect();
    Ok(fmt!("{{\"version\":{},\"files\":[{}]}}", version, names.join(",")))
}

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
    // The turns running on this app, by the tag the page gave each (see `set_turn_tag`), so a
    // Stop or a pause reaches the one turn it is about.  A Diamond's app is shared by every
    // Diamond on one model; see [`DaimondApp::abort_turn`].
    turns:          RefCell<Vec<(String, Halt)>>,
    early:          RefCell<Vec<String>>,       // stopped before their turn had begun
    ended:          RefCell<Vec<String>>,       // lately ended, so a late stop is not kept
}

/// A turn's place in its app's list of running turns, given up when the turn ends -- however it
/// ends, a future the page dropped included.
struct Running<'a> {
    app:  &'a DaimondApp,
    tag:  String,
    halt: Halt,
}

impl Drop for Running<'_> {
    fn drop(&mut self) {
        if let Ok(mut turns) = self.app.turns.try_borrow_mut() {
            turns.retain(|(_, h)| !h.same(&self.halt));
        }
        if !self.tag.is_empty() {
            if let Ok(mut ended) = self.app.ended.try_borrow_mut() {
                ended.push(self.tag.clone());
                let over = ended.len().saturating_sub(STOP_TAGS_KEPT);
                ended.drain(..over);
            }
        }
    }
}

/// How many tags [`DaimondApp`] remembers as stopped early, or as lately ended.
const STOP_TAGS_KEPT: usize = 32;

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
        // THE FAMILY'S OWN THINKING DEFAULT, applied here because this is the first place the
        // model is known.  `set_tune` moves it afterwards, and `turn_limits` reports whichever
        // is in force; see `crate::profile::Family::thinking_default`.
        let (thinking, effort) = crate::profile::Family::detect(model).thinking_default();
        agent.set_thinking(thinking, effort);

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
            keeper:      String::new(),
            unconfirmed: Vec::new(),
            by_model:    false,
            restoring:   0,
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
        // WHICH DIALECT WILL CARRY THIS, read off the slug the client was configured with.  It
        // decides the roster, the `file_edit` schema and how generously an argument object is
        // read: see `crate::profile`.  A worker is built through this same constructor with its
        // own model, so nothing on the JavaScript side has to know about any of it.
        let registry = ToolRegistry::new(tools, ctx)
            .with_family(crate::profile::Family::detect(model));

        Ok(DaimondApp {
            agent,
            session: RefCell::new(session),
            registry,
            instructions:     RefCell::new(String::new()),
            daimon_prompt: RefCell::new(String::new()),
            reducer_prompt:   RefCell::new(String::new()),
            turns:            RefCell::new(Vec::new()),
            early:            RefCell::new(Vec::new()),
            ended:            RefCell::new(Vec::new()),
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
        // ONE TURN AT A TIME ON THIS APP'S OWN CONVERSATION, asked before the halt is cleared:
        // clearing it under a turn still running would release that turn's Stop.
        if self.session.try_borrow_mut().is_err() {
            return Err(to_js_err(err!(
                "This conversation is in the middle of a turn, so another cannot start on it.";
                Invalid, Conflict)));
        }
        // THIS TURN'S STOP, cleared of the last turn's and held under the page's tag before
        // anything awaits, so a Stop or a pause pressed from here on reaches it; see [`Halt`].
        self.agent.llm.halt().rearm();
        let _running = self.hold_turn(self.registry.ctx.turn_tag_for(""), self.agent.llm.halt());
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
        let ran = {
            let mut session = self.session.borrow_mut();
            self.agent.run_turn(&mut session, user_msg, &self.registry, &mut sink).await
        };
        // WHAT A CHAT'S TURN REPLACED OR REMOVED BECOMES A VERSION OF THE CHAT'S STORE, whichever
        // way the turn went -- a turn that deleted a file and then died has still deleted it.  A
        // Diamond's worker keeps into its Diamond, whose daimon's turn end records it; a Diamond's
        // own thread is ended by the page, through [`DaimondApp::end_keeper_turn`].
        if let Some(key) = self.registry.ctx.keeper() {
            if key.starts_with(crate::tools::CHAT_KEEPER) {
                self.record_keeper_turn(&key, &on_event).await;
            }
        }
        ran.map_err(to_js_err)
    }

    /// End the store's turn for a Diamond's own conversation run on this app: record what the
    /// turn kept as one version of the Diamond's store, and end its counts, as a steer's turn end
    /// does.  A no-op for an app with no Diamond keeper.
    ///
    /// **The page's call and not [`DaimondApp::run_turn`]'s** (F6, 2026-09-25), because only the
    /// page knows this app is the thread's and not a worker's.  A worker keeps into its Diamond
    /// and its daimon's turn end records it; a thread's Continue, Run here, Re-run or gather round
    /// has no daimon's turn end, so without this it wrote no version of its own, and its seal count
    /// and the person's "go on" to deletes carried into the next steer.
    pub async fn end_keeper_turn(&self, on_event: js_sys::Function) {
        if let Some(key) = self.registry.ctx.keeper() {
            if !key.starts_with(crate::tools::CHAT_KEEPER) {
                self.record_keeper_turn(&key, &on_event).await;
            }
        }
    }

    /// Stop every turn running on this app.  The request in flight is cancelled, the round
    /// ends with its partial answer kept, and no further request of any of them goes out, so a
    /// Stop that lands while a round's tools run still stops the turn.  Safe to call when idle.
    ///
    /// **A Diamond's app is shared by every Diamond on one model**, so this stops all of them:
    /// a caller that means one turn calls [`DaimondApp::abort_turn`].
    pub fn abort(&self) {
        self.agent.llm.abort();
        for halt in self.halts_where(|_| true) {
            halt.fire();
        }
    }

    /// Stop the one turn the page tagged `tag` (see [`DaimondApp::set_turn_tag`]), and no
    /// other turn sharing this app.  A tag whose turn has not begun yet is remembered, and the
    /// turn stops as it begins.
    ///
    /// Answers whether a running turn was reached.
    pub fn abort_turn(&self, tag: String) -> bool {
        let hit = self.halts_where(|t| t == tag);
        for halt in hit.iter() {
            halt.fire();
        }
        if hit.is_empty() && !tag.is_empty()
            && !self.ended.borrow().iter().any(|t| *t == tag)
        {
            let mut early = self.early.borrow_mut();
            if !early.iter().any(|t| *t == tag) {
                early.push(tag);
                let over = early.len().saturating_sub(STOP_TAGS_KEPT);
                early.drain(..over);
            }
        }
        !hit.is_empty()
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

    /// Whether one conversation on this client has taken in content from outside the user — a
    /// fetched page, a mail message, a command's output.
    ///
    /// The daimon reads this after a steering turn to find out whether the tasks it is about to
    /// hand out derive from a stranger's words.
    ///
    /// A DIAMOND MUST NAME ITSELF, because the client is shared: `diamondApp` in
    /// www/js/daimond.js caches one per provider and model, so a Diamond that asked this without
    /// an argument was reading the shared client's own conversation and not its own — which is how
    /// a Research Diamond's page came to mark an Accounts Diamond's workers.  A chat and a worker
    /// each have a client to themselves and pass nothing.
    ///
    /// # Arguments
    /// * `who` - The Diamond whose conversation is being asked about, or nothing for this client's
    ///   own.
    pub fn is_tainted(&self, who: Option<String>) -> bool {
        match who {
            Some(id) => self.registry.ctx.is_tainted_for(&id),
            None     => self.registry.ctx.is_tainted(),
        }
    }

    /// Mark a conversation on this client as carrying content from outside the user, without
    /// reading any.
    ///
    /// One-way, like the flag itself.  A worker starts with a clean flag, so instructions absorbed
    /// from a stranger could be laundered through a worker that does not know it is carrying them;
    /// the daimon closes that by setting this on each worker it starts.
    ///
    /// # Arguments
    /// * `who` - The Diamond being marked, or nothing for this client's own conversation.  See
    ///   [`DaimondApp::is_tainted`] for why a Diamond has to say.
    pub fn set_tainted(&self, who: Option<String>) {
        match who {
            Some(id) => self.registry.ctx.set_tainted_for(&id),
            None     => self.registry.ctx.set_tainted(),
        }
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

    /// Forget what one conversation said about reaching websites, so the next question is put
    /// again.
    ///
    /// FOR "FRESH DAIMON", which discards a daimon's conversation and starts another.  The grant
    /// is scoped to a conversation ([`crate::tools::web_step`]), and ending one has to end it, or
    /// the new conversation would inherit a yes that was given in a conversation the user has just
    /// thrown away.
    ///
    /// A DIAMOND'S CLIENT IS SHARED, which is the whole reason this takes an argument: `diamondApp`
    /// in www/js/daimond.js caches one client per provider and model, so every Diamond on the same
    /// model reads and writes one of these caches.  The caller does not know which client holds the
    /// Diamond it is clearing, and does not have to: clearing a key that is not there does nothing,
    /// so it may be offered to all of them.
    ///
    /// # Arguments
    /// * `diamond` - The Diamond whose daimon is being started afresh, or the empty string for a
    ///   chat's own conversation.
    pub fn forget_web_consent(&self, diamond: &str) {
        self.registry.ctx.forget_web_consent(diamond);
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
        // THE TWO HALVES GO TOGETHER.  A conversation that can start a worker and cannot read
        // what it found is the shape this whole item removes -- it would spend a second turn on
        // the reading -- so there is no caller that wants one without the other.
        if !self.registry.tools.contains(&Tool::Gather) {
            self.registry.tools.push(Tool::Gather);
        }
    }

    /// Whether this agent holds the dispatch tool.
    pub fn can_dispatch(&self) -> bool {
        self.registry.tools.contains(&Tool::SpawnAgent)
    }

    /// Whether a DAIMON turn on this engine can read a worker back inside the turn.
    ///
    /// A DIFFERENT QUESTION FROM [`DaimondApp::can_gather`], and the difference is which registry
    /// answers.  A chat runs on this app's own belt, which is what that one reads; a Diamond's
    /// steering turn runs on a registry `compose_daimon` builds fresh from
    /// [`crate::tools::Tool::daimon`], and this app's belt says nothing about it.  Asked of the
    /// wrong one, the page took the old collect-and-start path for every daimon turn there was --
    /// which is the surface the whole saving was measured on.
    pub fn daimon_can_gather(&self) -> bool {
        Tool::daimon().contains(&Tool::Gather)
    }

    /// Tell the tool layer which turn the page is about to run, so a worker started from inside
    /// it can be attributed to the conversation that started it.
    ///
    /// **Called immediately before every `run_turn` or `steer_crystal`.**  One
    /// `window.DaimondWorkers` serves the whole page and several conversations run turns at once,
    /// so the pump cannot work out whose worker a bare `{name, task}` belongs to; this is what
    /// tells it.  `who` names the Diamond for the reason [`DaimondApp::set_tainted`] takes one:
    /// a daimon client is shared by every Diamond on one model.
    ///
    /// # Arguments
    /// * `who` - The Diamond, or nothing for this client's own conversation.
    /// * `tag` - The page's own id for the turn.
    pub fn set_turn_tag(&self, who: Option<String>, tag: String) {
        self.registry.ctx.set_turn_tag_for(&who.unwrap_or_default(), &tag);
    }

    /// Whether this agent can read a worker's report inside the turn that started it.
    ///
    /// **The page asks this to choose which path a `spawn_agent` call takes.**  With a gather
    /// -capable engine the call itself reaches `DaimondWorkers.spawn` and the worker is already
    /// running, so the page's own tool-call collector must NOT start a second copy; without one,
    /// the collector is the only thing that starts anything.  An engine that answers falsely
    /// either way is a fan-out run twice or not at all.
    pub fn can_gather(&self) -> bool {
        self.registry.tools.contains(&Tool::Gather)
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
    /// * `unconfirmed` - JSON array of the places marked into it that are NOT in force on this
    ///   device until the user confirms them here; may be omitted.  Named in a refusal of one of
    ///   them, so the model asks for the press (see [`crate::tools::ToolContext::unconfirmed`]).
    pub fn set_chat_scope(
        &mut self,
        scratch:     String,
        workspace:   String,
        read_only:   Option<String>,
        unconfirmed: Option<String>,
    ) {
        let paths = parse_path_array;
        let bounds = crate::tools::chat_bounds(
            &scratch,
            &paths(&workspace),
            &paths(&read_only.unwrap_or_default()));
        self.registry.ctx.no_write = crate::tools::compose(&self.registry.ctx.no_write, &bounds);
        // AND WHOSE STORE KEEPS WHAT IT REPLACES OR REMOVES: the chat's, read off its scratch.
        // A chat deleting a file in the user's open folder kept nothing until 2026-09-23.
        self.registry.ctx.keeper = crate::tools::keeper_of_dir(&scratch);
        self.registry.ctx.unconfirmed = paths(&unconfirmed.unwrap_or_default());
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
    /// * `unconfirmed` - JSON array of the places marked into the Diamond that are NOT in force
    ///   on this device until the user confirms them here; may be omitted.
    pub fn set_diamond_scope(
        &mut self,
        own_dir:     String,
        attached:    String,
        read_only:   String,
        toolkits:    String,
        unconfirmed: Option<String>,
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
        // A worker's changes are its Diamond's, kept in its store and recorded at the end of the
        // daimon's turn that dispatched it, beside the daimon's own.
        self.registry.ctx.keeper = crate::tools::keeper_of_dir(&own_dir);
        self.registry.ctx.unconfirmed = paths(&unconfirmed.unwrap_or_default());
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
        let whole = crate::protocol::pair_up(restored);
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

    /// Set which upstream providers OpenRouter should try for this agent's model, from the
    /// setting on its own row (`www/js/models.js`, `DaimondModels.routing`).  Inert against a
    /// direct provider.
    ///
    /// # Arguments
    /// * `order` - Comma-separated provider names to try first, in that order.
    /// * `ignore` - Comma-separated provider names never to route to.
    /// * `only` - Refuse every provider but `order` rather than falling back past it.
    pub fn set_provider_routing(&self, order: String, ignore: String, only: bool) {
        self.agent.set_provider_routing(&order, &ignore, only);
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

    /// What of a crystal rides in the daimon's system message on every round, in bytes.
    ///
    /// The third ceiling, and the only one of the three that is a per-round bill: the other two
    /// bound what the browser stores and syncs.  Zero restores the default.
    ///
    /// # Arguments
    /// * `bytes` - The ceiling; zero restores the default.
    pub fn set_crystal_hot_cap(&self, bytes: usize) {
        crate::tools::set_crystal_hot_cap(bytes);
    }

    /// The hot ceiling THIS ENGINE would enforce with nothing set, in bytes.
    ///
    /// **The settings pane names a ceiling, and until now it named a copy.**
    /// `DEFAULT_CRYSTAL_HOT_KB` in `www/js/daimond.js` is a hand-kept duplicate of
    /// [`tools::CRYSTAL_HOT_CAP_DEFAULT`], checked against the source by
    /// `dev/verify_crystalcap.mjs` -- which compares two files on disk and therefore
    /// cannot see the one case that matters at RUN time: a page whose wasm is older
    /// than its JavaScript.  On 2026-09-14 the default was raised from 4 KiB to 16 KiB
    /// and a write was refused at 4096 bytes with no setting anywhere holding a 4, and
    /// there was no way to ask the engine what it thought the figure was.  This is the
    /// way to ask.
    pub fn crystal_hot_cap_default(&self) -> usize {
        crate::tools::CRYSTAL_HOT_CAP_DEFAULT
    }

    /// The hot ceiling actually in force, in bytes: the setting, or the default where none is set.
    pub fn crystal_hot_cap(&self) -> usize {
        crate::tools::crystal_hot_cap()
    }

    /// A Diamond's crystal as the PROMPT carries it: the hot part and the outline of the rest.
    ///
    /// **One implementation of the split, and this export is what keeps it one.**  A worker is
    /// handed its dispatching Diamond's crystal by the page, and the page writing its own
    /// hot/cold split in JavaScript would be the second implementation -- which is the fault
    /// `dev/CONTRACT_FOLD.md` §2 is written about.
    ///
    /// # Arguments
    /// * `id` - The Diamond whose crystal is wanted.
    pub async fn crystal_hot_text(&self, id: String) -> Result<String, JsValue> {
        let json  = diamond::read_crystal_data(&id).await.unwrap_or_default();
        let files = diamond::read_standing(&id).await;
        let split = crate::tools::crystal_split(
            &json, crate::tools::crystal_hot_room(files.hot_bytes())).map_err(to_js_err)?;
        Ok(crate::tools::crystal_prompt_text(&split, &files))
    }

    /// What a Diamond's crystal weighs, hot and whole, as `{hot, total, hot_cap, cap}`.
    ///
    /// Deliberately NOT a session-borrowing call: it reads one file and the two ceilings, so the
    /// Memory panel can draw the gauge on every render without the reentrancy that cost a
    /// regression on 2026-09-12.
    ///
    /// # Arguments
    /// * `id` - The Diamond whose sizes are wanted.
    pub async fn crystal_split_sizes(&self, id: String) -> Result<String, JsValue> {
        let json  = diamond::read_crystal_data(&id).await.unwrap_or_default();
        // THE ROOM RATHER THAN THE CEILING, because the gauge is what a user checks a refusal
        // against: a panel drawing "hot 3.1 of 16.0 KB" beside a refusal at 15,100 would have
        // the user reading the three files' share as a bug.  `files` is what they weigh.
        let files = diamond::read_standing(&id).await;
        let hot   = crate::tools::crystal_hot_room(files.hot_bytes());
        let split = crate::tools::crystal_split(&json, hot).map_err(to_js_err)?;
        Ok(fmt!(
            r#"{{"hot":{},"total":{},"hot_cap":{},"cap":{},"whole":{},"files":{}}}"#,
            split.hot_bytes, split.total_bytes, hot, crate::tools::crystal_cap(), split.whole,
            files.hot_bytes()))
    }

    /// Fold this conversation at a different fraction of the window from the shipped one.
    ///
    /// `f64` for the reason [`DaimondApp::set_context_window`] gives, and because the figure
    /// is a fraction: zero, or anything below it, means the user has not chosen and the
    /// engine's own default stands.  Anything outside
    /// [`crate::agent::compact::FOLD_AT_MIN`]..[`crate::agent::compact::FOLD_AT_MAX`] is held
    /// at the band rather than refused -- the control is a pulldown, so a figure off the
    /// ladder can only arrive from a stored setting an older build wrote.
    ///
    /// # Arguments
    /// * `fraction` - Where to fold, as a share of the window; zero leaves the default.
    pub fn set_fold_at(&self, fraction: f64) {
        self.agent.set_fold_at(fraction);
    }

    /// The most context one round may carry, in tokens, whatever the model's window.
    ///
    /// **The figure that decides what a long turn costs, and until now the only one of the three
    /// the user could not see.**  `fold_at` is a FRACTION, so on a million-token window it folds
    /// near a million; this is the ceiling that fraction is held under, and a turn whose prompt
    /// settles just below it re-sends that prompt on every round of the turn at the cached-input
    /// rate.  Lower it and a long turn folds and carries less; raise it and it keeps more of
    /// itself word for word and costs more per round.
    ///
    /// `f64` for the reason [`DaimondApp::set_context_window`] gives.  Zero restores the shipped
    /// default, as zero does for [`DaimondApp::set_fold_at`]; anything outside
    /// [`crate::agent::compact::CONTEXT_CAP_MIN`]..[`crate::agent::compact::CONTEXT_CAP_MAX`] is
    /// held at the band rather than refused.
    ///
    /// # Arguments
    /// * `tokens` - The ceiling; zero leaves the default.
    pub fn set_context_cap(&self, tokens: f64) {
        self.agent.set_context_cap(if tokens > 0.0 { tokens as u64 } else { 0 });
    }

    /// The most one turn may spend, in US dollars.
    ///
    /// **The ceiling that holds a runaway now that the round limit does not.**  A turn that reaches
    /// the round cap carries itself on -- see [`crate::agent::compact::MAX_CONTINUATIONS`] -- so
    /// six hundred rounds of an expensive model is a thing the app will now do unattended, and the
    /// figure that stops it has to be the user's: five dollars is a day's work on a cheap model and
    /// two legs on a costly one.
    ///
    /// Not enforced on a turn whose provider reported no cost at all; see
    /// `Agent::over_the_spend_cap` for why a guessed price would be worse than none.
    ///
    /// `f64` for the reason [`DaimondApp::set_context_window`] gives, and because the figure is
    /// money.  Zero restores the shipped default, as it does for
    /// [`DaimondApp::set_context_cap`]; anything outside
    /// [`crate::agent::compact::SPEND_CAP_MIN_USD`]..[`crate::agent::compact::SPEND_CAP_MAX_USD`]
    /// is held at the band rather than refused.
    ///
    /// # Arguments
    /// * `usd` - The ceiling; zero leaves the default.
    pub fn set_spend_cap_usd(&self, usd: f64) {
        self.agent.set_spend_cap_usd(usd);
    }

    /// Say that the turn which dispatched this worker has ended, so nothing is waiting for its
    /// report.
    ///
    /// Called from the page's `Workers.releaseTurn` for every run of a turn that is still
    /// going when the turn goes.  It bounds the worker in ROUNDS rather than aborting it --
    /// see [`crate::agent::compact::ORPHAN_GRACE_ROUNDS`] -- so what it has already done is kept and
    /// its report still comes back; what it may not do is spend another two hundred rounds on
    /// work nobody is holding a promise on.
    ///
    /// Takes `&self`, like [`DaimondApp::abort`] and for the same reason: the turn it is about
    /// is already running.
    pub fn orphan_worker(&self) {
        self.agent.orphan();
    }


    /// Hold this agent to a dispatched worker's ceiling, whatever the chat is set to.
    ///
    /// **A worker has always run on the chat's own figures**, because `Workers.start` applies the
    /// user's settings to a worker's app exactly as it does to the chat's, and the only mark that
    /// ever said a worker was different is [`DaimondApp::set_unsupervised`] -- which governs what
    /// it may ASK, not what it may spend.  So one dispatched errand inherited 150 rounds times four
    /// legs, a 120,000-token carry and the whole of the user's per-turn dollar ceiling, with
    /// several of them running at once and nobody reading any of them.
    ///
    /// Every figure is a ceiling rather than a setting -- see
    /// [`crate::agent::compact::Limits::hold_to_worker`] -- so this may be called before or after
    /// the chat's settings reach the app and a user's tighter leash is kept either way.  One-way,
    /// like [`DaimondApp::set_unsupervised`].
    pub fn set_worker_limits(&self) {
        self.agent.set_worker_limits();
    }

    /// Set the compaction and worker-preset figures from one flat JSON object.
    ///
    /// One door for a dozen knobs that were compile-time constants until 2026-09-12, so that the
    /// tune loop in `dev/tune/` can turn each measure off and say what it was worth.  Absent keys
    /// and zeroes are left alone, so `{}` changes nothing and the shipped defaults live in
    /// `compact.rs` rather than being restated in the page.
    ///
    /// # Arguments
    /// * `json` - A flat JSON object; empty changes nothing.
    ///
    /// # Errors
    /// Rejects text that is not an object rather than silently tuning nothing: a settings string
    /// with a typo in it that quietly measures the default is how an arm reports a figure about
    /// the wrong engine.
    pub fn set_tune(&self, json: String) -> Result<(), JsValue> {
        // THE PROFILE, forced by name, so a trial arm can measure one family's rules against
        // another's without a rebuild.  A name no family answers to is refused rather than
        // ignored: an arm that silently measured the default would report the wrong engine.
        if let Some(name) = crate::llm::extract_json_string(&json, "family") {
            match crate::profile::Family::from_name(&name) {
                Some(f) => self.registry.set_family(f),
                None    => return Err(to_js_err(err!(
                    "set_tune: no model family is called {:?}. The names are claude, gpt, \
                    deepseek, qwen, glm, minimax, kimi and unknown.", name; Invalid, Input))),
            }
        }
        // THE CLAUDE CODE ALIAS TABLE, same door as `family` and for the same reason: it lives
        // on the registry, which `Agent::set_tune` cannot reach. Independent of `family` on
        // purpose -- see `ToolRegistry::claude_names` -- so `claudenames` can differ from `cur`
        // in exactly this one setting on a model that is already Claude by detection.
        if let Some(b) = crate::llm::extract_json_bool(&json, "claude_names") {
            self.registry.set_claude_names(b);
        }
        // AND THE COMPOUND SWITCH, through the same door and for the same reason. The
        // schema array is built off the REGISTRY (`ToolRegistry::offered` asks
        // `ctx.compound_on()`), and the Wire view builds one without running a turn -- so a
        // switch that reached `Limits` alone was invisible until the first turn pushed it
        // across, and an arm that read the wire before turning would have measured the
        // control. `Agent::run_turn` still pushes it every turn, which is what makes a
        // worker's own preset apply; this makes the setting true the moment it is set.
        if let Some(b) = crate::llm::extract_json_bool(&json, "compound") {
            self.registry.ctx.set_compound(b);
        }
        match self.agent.set_tune(&json) {
            Ok(())  => Ok(()),
            Err(e)  => Err(to_js_err(e)),
        }
    }

    /// What bounds this agent's turns, as the JSON object a worker dock can draw.
    ///
    /// `worker` says whether the figures beside it are a worker's ceiling or the user's own
    /// settings, which is the one thing a reader of a worker's tile cannot otherwise tell: a
    /// worker that stopped at sixty rounds and a chat that stopped at a hundred and fifty both
    /// report "reached the tool-call round limit", and until this there was nothing to show which
    /// limit that was.  Read back out of the engine rather than remembered by the caller, so the
    /// figures shown are the ones the arithmetic used after every band and ceiling has been
    /// applied.
    #[wasm_bindgen(getter)]
    pub fn turn_limits(&self) -> String {
        let l = self.agent.limits();
        // THE TUNED FIGURES ARE ECHOED TOO, and they have to be: a trial that set them through
        // `DaimondApp::set_tune` has no other way to confirm the engine took what it was handed,
        // and a measurement against an arm that silently stayed on the defaults is a figure about
        // the wrong engine. Read out of `Limits` after every band and ceiling, as the rest are.
        fmt!("{{\"worker\":{},\"max_rounds\":{},\"continuations\":{},\"context_cap\":{},\
            \"keep\":{},\"spend_cap_usd\":{},\"fold_at\":{},\"retire_prior\":{},\
            \"retire_keep_turns\":{},\
            \"written_age\":{},\"result_age\":{},\"result_cap\":{},\"sweep_every\":{},\
            \"worker_max_rounds\":{},\"worker_continuations\":{},\"worker_context_cap\":{},\
            \"worker_keep\":{},\"worker_spend_usd\":{},\"gather_timeout_s\":{},\
            \"orphan_grace_rounds\":{},\
            \"batch_line\":{},\
            \"compound\":{},\
            \"standing\":{},\"briefing_top3\":{},\"task_log\":{},\"tail_note\":{},\
            \"thinking\":\"{}\",\"effort\":\"{}\",\
            \"stream_idle_ms\":{},\
            \"fold_shape\":\"{}\",\"family\":\"{}\",\"claude_names\":{}}}",
            l.worker, l.max_rounds, l.max_continuations, l.context_cap, l.keep, l.spend_cap_usd,
            l.fold_at, l.retire_prior,
            l.retire_keep_turns,
            l.written_age, l.result_age, l.result_cap, l.sweep_every,
            l.worker_max_rounds, l.worker_continuations, l.worker_context_cap,
            l.worker_keep, l.worker_spend_usd, l.gather_timeout_s,
            l.orphan_grace_rounds,
            l.batch_line, l.compound,
            l.standing_files, l.briefing_top3, l.task_log, l.tail_note,
            l.thinking.wire(), l.effort.wire(),
            l.stream_idle_ms,
            l.fold_shape.wire(),
            self.registry.family().name(), self.registry.claude_names())
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

    /// The ceiling the fraction above is held under, in tokens.
    ///
    /// A meter drawn from `fold_at` alone marks the fold in the wrong place on any model with a
    /// large window: the conversation folds at whichever of the two comes FIRST.  See
    /// [`DaimondApp::set_context_cap`].
    #[wasm_bindgen(getter)]
    pub fn context_cap(&self) -> f64 {
        self.agent.limits().context_cap as f64
    }

    /// The most one of this agent's turns may spend, in US dollars.
    ///
    /// See [`DaimondApp::set_spend_cap_usd`].  Read back rather than remembered by the caller, so a
    /// control shows the figure that is in force after the band has been applied.
    #[wasm_bindgen(getter)]
    pub fn spend_cap_usd(&self) -> f64 {
        self.agent.limits().spend_cap_usd
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
        // The fold's request is a request of this conversation's, so it takes the conversation's
        // stop, cleared of the last turn's, as a turn does.
        self.agent.llm.halt().rearm();
        let _running = self.hold_turn(String::new(), self.agent.llm.halt());
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
    ///
    /// **The text is not a status.**  A caller that does anything with the answer other than draw
    /// it wants [`Self::run_tool_outcome`], which states what became of the call instead of
    /// leaving it to be read out of the prose.
    pub async fn run_tool(&self, name: String, args_json: String) -> String {
        self.registry.dispatch_unbilled(&name, &args_json).await.as_text().into_owned()
    }

    /// The same call as [`Self::run_tool`], answering with BOTH halves of what happened:
    /// `{ text, outcome }`, where `outcome` is exactly `done`, `refused` or `failed`.
    ///
    /// **The outcome is the tool layer's, not a reading of its words.**  It is
    /// [`crate::tools::call_outcome`] over the reply -- the one classifier, the same one
    /// `src/agent.rs` sets on `AgentEvent::ToolResult`, spelled by the same
    /// [`CallOutcome::wire`](crate::tools::CallOutcome::wire).  So the browser reads one
    /// vocabulary of three words whichever door a result came through, and a fourth spelling
    /// cannot be invented here (`dev/CONTRACT_OUTCOME.md` §1).
    ///
    /// It exists because `run_tool` hands back a bare string and every caller that needed to know
    /// whether the call worked read that string -- each of them for `Error:` alone, while a
    /// refusal opens `Refused:` ([`crate::tools::refusal_line`] prefixes it across some twenty
    /// sites).  A `file_list` the scope fence had just refused therefore read as an ordinary
    /// listing: the sync census parsed the refusal sentence as directory entries and still
    /// reported the collection COMPLETE, and completeness is the one thing that entitles the
    /// other device to read an absent path as a deletion.
    ///
    /// An object rather than a delimited string, because a listing, a refusal and a file's
    /// contents are all arbitrary text: any separator this could pick is text some tool may
    /// legitimately return, and the parse would then be a second place for the two halves to come
    /// apart.  Built with `Reflect::set` for the same reason [`event_to_js`] is -- the JS side
    /// receives a structured object, not a string it must re-parse.
    pub async fn run_tool_outcome(&self, name: String, args_json: String) -> js_sys::Object {
        let text = self.registry.dispatch_unbilled(&name, &args_json).await.as_text().into_owned();
        let outcome = crate::tools::call_outcome(&text);
        let obj = js_sys::Object::new();
        let set = |k: &str, v: &JsValue| {
            // `Reflect::set` on a fresh object cannot fail; ignore the result.
            let _ = js_sys::Reflect::set(&obj, &JsValue::from_str(k), v);
        };
        set("text",    &JsValue::from_str(&text));
        set("outcome", &JsValue::from_str(outcome.wire()));
        obj
    }

    /// Write `bytes` at `path` through this app's own tool door, byte for byte: the Files panel's
    /// Undo of a delete, which wrote the file back as text through `file_write` and so corrupted
    /// anything that was not (release 5.1 QA round 3, FP).  `{text, outcome}`, as
    /// [`Self::run_tool_outcome`] answers.
    pub async fn write_file_bytes(&self, path: String, bytes: Vec<u8>) -> js_sys::Object {
        let text = self.registry.write_bytes_door(&path, bytes).await.as_text().into_owned();
        let outcome = crate::tools::call_outcome(&text);
        let obj = js_sys::Object::new();
        let _ = js_sys::Reflect::set(&obj, &JsValue::from_str("text"), &JsValue::from_str(&text));
        let _ = js_sys::Reflect::set(&obj, &JsValue::from_str("outcome"),
            &JsValue::from_str(outcome.wire()));
        obj
    }

    /// The same call as [`Self::run_tool_outcome`], fenced by ONE Diamond's bounds and leaving
    /// this app's own unchanged.
    ///
    /// The door the page's Restore writes a marked file back through.  It cannot use
    /// [`Self::set_diamond_scope`]: that COMPOSES rather than assigns, deliberately, so the one
    /// shared tool runner the panels hold cannot be pointed at a second Diamond without
    /// intersecting the two to [`Bound::Nowhere`](crate::tools::Bound::Nowhere) -- and it must
    /// not be pointed at the first one permanently either, since a panel writing an ordinary
    /// workspace file a moment later would then be refused.  So the bounds are built here, per
    /// call, by the same [`crate::tools::diamond_bounds`] a turn is built from, and thrown away
    /// with the registry that carried them.
    ///
    /// **This is what makes a restore obey a mark that has since been withdrawn.**  Run
    /// unfenced, the restore wrote the old bytes into a folder the Diamond no longer reaches,
    /// which is the one thing `dev/VERSIONS_CONTRACT.md` §6 says it must not do.
    ///
    /// **And what makes it keep what it replaces** (R1-R3 of the release 5.1 fix's QA,
    /// 2026-09-25).  A write or a delete here is a restore's act: once the fence has passed and
    /// immediately before the act, it keeps what stands there -- the person's own save since the
    /// version, or one made while the restore's question was open -- into the restore's record
    /// ([`DaimondApp::versions_restore_open`]).  A call with no restore open is a restore of its
    /// own, recorded as it lands.  This door reads, puts back, writes and deletes, and does
    /// nothing else: no other verb here keeps a copy.
    ///
    /// **A restore's write is `file_put_back`, `{path, hash}`** (release 5.1's restore follow-ups,
    /// 2026-09-25): the body the store holds under `hash`, byte for byte, so a person's PNG, PDF or
    /// Word file comes back as it was ([`crate::tools::ToolRegistry::put_back`]).  `file_write`'s
    /// `content` is text, and wrote such a file back corrupt.
    ///
    /// **The door is the person's, not an agent's** (U2 of the release 5.1 fix's second QA,
    /// 2026-09-25).  It carries a read cache of its own, so it neither answers to what the
    /// Diamond's daimon last read nor tells the daimon it has read anything.  It shared the app's
    /// until then -- the one a steer on this page writes into -- so once a steer had touched a
    /// file and the person had saved it, the door's write met the daimon's stale-read guard and no
    /// Restore could put that file back.  What the daimon read stays in the app's cache, so its
    /// next write from that read is refused and it reads the file again; what an act left is noted
    /// beside it, so the refusal says the person restored the file ([`crate::tools::note_restored`]).
    ///
    /// # Arguments
    /// * `id` - The Diamond whose reach this call gets.
    /// * `attached` - JSON array of the paths marked into it, as `Files.bounds` reports them.
    /// * `read_only` - JSON array of those that may be read but not written.
    /// * `ticket` - The restore this act belongs to, from `versions_restore_open`; absent for a
    ///   lone act.
    pub async fn run_diamond_tool(
        &self,
        id:        String,
        attached:  String,
        read_only: String,
        name:      String,
        args_json: String,
        ticket:    Option<f64>,
    )
        -> js_sys::Object
    {
        let obj = js_sys::Object::new();
        let set = |k: &str, v: &JsValue| {
            let _ = js_sys::Reflect::set(&obj, &JsValue::from_str(k), v);
        };
        let acts = match name.as_str() {
            "file_put_back" | "file_write" | "file_delete" => true,
            "file_read" | "file_list"                      => false,
            _ => {
                let text = crate::tools::refusal_line(&fmt!(
                    "{} is not a restore's verb: this door reads, puts back, writes and deletes, \
                    and keeps a copy of what it replaces. Nothing was done.", name));
                set("outcome", &JsValue::from_str(crate::tools::call_outcome(&text).wire()));
                set("text",    &JsValue::from_str(&text));
                return obj;
            },
        };
        // The restore this act keeps into: the one named, where it is open for this Diamond, or
        // one of its own.
        let (restoring, lone) = match ticket {
            Some(t) if t >= 1.0 && diamond::restore_store(t as u64).as_deref() == Some(id.as_str())
                => (t as u64, false),
            _ if acts => (diamond::restore_lone(&id).await, true),
            _         => (0, false),
        };
        let bounds = crate::tools::diamond_bounds(
            &diamond::diamond_dir(&id),
            &parse_path_array(&attached),
            &parse_path_array(&read_only));
        let ctx = ToolContext {
            workspace:   Workspace::unchecked(PathBuf::from("/")),
            executor:    Executor::Wasm,
            cwd:         String::new(),
            path_prefix: String::new(),
            root:        crate::tools::FileRoot::Workspace,
            // ITS OWN, and thrown away with the call: see above.
            read_seen:   crate::tools::new_read_cache(),
            no_write:    bounds,
            // EMPTY, both, and that is not an oversight. `ctx.keeper()` is what makes the write
            // door keep the bytes it is replacing for the TURN to record -- and this is not a
            // turn. A restore recorded that way would land in the next turn's manifest under the
            // daimon's name, for a change the user made.
            daimon_of:   String::new(),
            keeper:      String::new(),
            unconfirmed: Vec::new(),
            by_model:    false,
            restoring,
        };
        let registry = ToolRegistry::new(Tool::daimon(), ctx);
        let text = match name.as_str() {
            "file_put_back" => registry.put_back(&args_json).await,
            _               => registry.dispatch_unbilled(&name, &args_json).await,
        }.as_text().into_owned();
        // A lone act is recorded as it lands; a refused one recorded nothing and writes nothing.
        if lone {
            if let Err(e) = diamond::versions_restore_close(&id, restoring).await {
                web_sys::console::warn_1(&JsValue::from_str(&fmt!(
                    "the restore of a file in {} could not be recorded (its copy is noted for the \
                    next turn end): {}", id, e)));
            }
        }
        let outcome = crate::tools::call_outcome(&text);
        // WHAT THE ACT LEFT, beside what the daimon read, as the engine's own restore writes are
        // ([`DaimondApp::versions_restore_close`]).
        if acts && outcome == crate::tools::CallOutcome::Done {
            if let Some(path) = crate::llm::extract_json_string(&args_json, "path") {
                note_restores(&self.registry.ctx.read_seen, &[path]).await;
            }
            // A machine file's, noted at the act through the hand (fix/r51e).
            crate::tools::carry_restored(&registry.ctx.read_seen, &self.registry.ctx.read_seen);
        }
        set("text",    &JsValue::from_str(&text));
        set("outcome", &JsValue::from_str(outcome.wire()));
        obj
    }

    // ── Diamond / crystal / fold surface ─────────────────────────────────

    /// Create a Diamond named `name`, returning its id.  Creates the Diamond
    /// directory, an empty `crystal.json`, version `0`, a `meta.json`, and a
    /// `create` log record.  No page: a new Diamond renders on the shipped default until
    /// something writes one.
    pub async fn create_diamond(&self, name: String) -> Result<String, JsValue> {
        diamond::create(&name).await.map_err(to_js_err)
    }

    /// Tell the engine which folds the user has OPEN.
    ///
    /// Called before every turn, with the whole set, because a fold can be opened and closed
    /// between two turns and the payload must follow. An open fold's detail travels; a closed
    /// one's does not. See [`crate::llm::OpenFolds`].
    ///
    /// Two kinds of key share this one set: a `say` call's tool-call id, and a `<details>` fold's
    /// `<ordinal>:<summary>` (`dev/CONTRACT_FOLD.md` §2).
    ///
    /// **The escapes are decoded, not scanned past.**  This read the array by hunting for `"`,
    /// which was safe while every key was a tool-call id -- those carry no quote and no backslash.
    /// A fold's key ends in a summary the MODEL wrote, so `He said "no"` arrives from
    /// `JSON.stringify` as `He said \"no\"`; a scan ends the string at the first escaped quote,
    /// and the fold then never matches, its body never travels, and nothing reports it.
    /// [`parse_json_string_array`](crate::llm::parse_json_string_array) already handled every
    /// escape `json_escape` emits and was three modules away the whole time.
    ///
    /// Reading stays lenient: a page that sends nothing readable means "none open", which is the
    /// behaviour before this existed and the cheaper of the two mistakes.
    pub fn set_open_folds(&self, ids_json: String) {
        self.agent.llm.set_open_folds(crate::llm::parse_json_string_array(&ids_json));
    }

    /// What this app would send as its system message, and the tool schemas beside it, as JSON.
    ///
    /// **THE WIRE VIEW'S SOURCE, and it is composed by the code that composes the request.**
    /// `Agent::system_parts` is called here and by `run_turn`, so what a person is shown cannot
    /// drift from what goes out -- which is the only property that makes such a view worth having.
    /// A second assembly agreeing today is a second assembly disagreeing later, silently.
    ///
    /// **There are TWO turns behind this app and each composes its own.**  A chat's is this app's
    /// agent and registry; a Diamond's daimon is [`DaimondApp::compose_daimon`], which builds its
    /// own agent over its own tool vector -- and until the Diamond's id was asked for here, a
    /// daimon thread was shown the chat's: `say` and the nine web tools it has never held, while
    /// its owner sat asking why it never used one.  So the caller must say which thread it means,
    /// and each answer is composed by the code that runs that thread.
    ///
    /// The parts are named rather than concatenated, because the question the view answers is
    /// WHOSE each paragraph is: the role prompt is the user's and they may rewrite it, the safety
    /// clause is appended after their edits and they may not, the tool sentence is derived from
    /// the registry, and the machine note is derived from the fence. A single blob answers none
    /// of that.
    ///
    /// # Arguments
    /// * `diamond_id` - The Diamond whose daimon owns the thread being shown, or empty for an
    ///   ordinary chat.  IT IS NOT OPTIONAL DECORATION: a daimon's turn is composed by
    ///   [`DaimondApp::compose_daimon`] and never by [`DaimondApp::run_turn`], so a Diamond's
    ///   thread answered from this app's own agent and registry is answered about a conversation
    ///   that is not happening.
    /// * `attached` - JSON array of the paths marked into that Diamond, exactly as
    ///   [`DaimondApp::steer_crystal`] takes them.  Ignored for a chat.
    /// * `read_only` - Those of them to be consulted rather than edited.
    /// * `toolkits` - The toolchains granted to that Diamond, so the view of the request says
    ///   what the turn will actually carry.  A view composed without them described a briefing
    ///   nobody would be sent.
    /// * `unconfirmed` - The places marked into it that are not in force on this device, as
    ///   [`DaimondApp::steer_crystal`] takes them; optional.
    pub async fn wire_system(
        &self,
        diamond_id:  String,
        attached:    String,
        read_only:   String,
        toolkits:    String,
        unconfirmed: Option<String>,
    )
        -> Result<String, JsValue>
    {
        if diamond_id.trim().is_empty() {
            // Refreshed here rather than read as it stands, because `run_turn` refreshes it on the
            // way out and the constructor cannot: it needs an await to ask the hand.  Without this
            // the band naming this computer is empty until a first turn has gone, which is the
            // same drift in miniature -- a view of the request that is only true afterwards.
            let brief = self.briefing(&self.registry).await;
            self.agent.set_briefing(&brief);
            return Ok(wire_json(&self.agent, &self.registry, ""));
        }
        let turn = self.compose_daimon(&diamond_id, &attached, &read_only, &toolkits,
            &unconfirmed.unwrap_or_default()).await;
        Ok(wire_json(&turn.agent, &turn.registry, &turn.local))
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
    ///
    /// `keep_conflict` is the caller's word that this device ALSO moved the Diamond since
    /// the copy both sides last agreed on, so the local state is kept as a recoverable
    /// version before the replace rather than lost (S-SYNC #4).  A one-sided pull passes
    /// `false`; either way `versions/` is preserved.
    pub async fn import_diamond(&self, json: String, keep_conflict: bool) -> Result<(), JsValue> {
        diamond::import_diamond(&json, keep_conflict).await.map_err(to_js_err)
    }

    /// Export a Diamond's SHAPE as a template anybody can open, sealed to nobody.
    ///
    /// The page it renders through, its automation and whatever a capp keeps beside itself
    /// travel; the memory, its history, the kept conversation, the fold record and a capp's
    /// entries do not.  [`diamond::export_template`] names the line and
    /// `protocol::template_carries` draws it, file by file, with the reasoning for each.
    ///
    /// # Arguments
    /// * `with_conversation` - Carry everything instead, which is the door back to a complete
    ///   copy.  It is still a template and still opens as a new Diamond.
    pub async fn export_template(
        &self,
        id:                String,
        with_conversation: bool,
    )
        -> Result<String, JsValue>
    {
        diamond::export_template(&id, with_conversation).await.map_err(to_js_err)
    }

    /// Open a template as a NEW Diamond, answering its id.
    ///
    /// Nothing already on this device is written over, whatever the pack says its id is -- which
    /// is the whole difference between this and [`DaimondApp::import_diamond`], and the reason
    /// the two are separate doors.
    pub async fn import_template(&self, json: String) -> Result<String, JsValue> {
        diamond::import_template(&json).await.map_err(to_js_err)
    }

    /// Assert a link, returning its id.
    ///
    /// `owner` is the Diamond whose sidecar holds the record; `rel` and `note`
    /// may both be empty, and `by` names who asserted it (`user`, or
    /// `agent:<name>`) so a later reader can tell a drawn line from a
    /// suggested one.  `share`, left out for off, flags a mark the user is
    /// confirming here with the copy grant it already had; it is refused on
    /// anything but the user's own mark.
    pub async fn add_link(
        &self,
        owner: String,
        from:  String,
        to:    String,
        rel:   String,
        note:  String,
        by:    String,
        share: Option<bool>,
    )
        -> Result<String, JsValue>
    {
        diamond::add_link_with(&owner, &from, &to, &rel, &note, &by, share.unwrap_or(false)).await
            .map_err(to_js_err)
    }

    /// Flag a mark to be copied to the devices of this account that cannot open it, or take the
    /// flag off.  True when anything moved.  The user's own ⇄, and refused on any link that is not
    /// the user's mark: see [`diamond::set_link_share`].
    pub async fn set_link_share(&self, owner: String, link_id: String, on: bool)
        -> Result<bool, JsValue>
    {
        diamond::set_link_share(&owner, &link_id, on).await.map_err(to_js_err)
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

    // ── The file version store ──────────────────────────────────────────────
    //
    // Beside the crystal's own chain and on the same counter, so one History row can carry both
    // halves of what a version was. What each of these is FOR is written where it is done, in
    // `crate::wasm::diamond`; here is only the boundary.

    /// Every file manifest this Diamond holds, newest first, each with its version number.
    ///
    /// The rows the History draws, joined to `log_read`'s by that number.
    pub async fn versions_list(&self, id: String) -> Result<String, JsValue> {
        diamond::versions_list(&id).await.map_err(to_js_err)
    }

    /// What the file version store weighs against what it may weigh:
    /// `{bytes, cap, manifests, manifests_cap, file_max}`.
    ///
    /// The gauge in the History bar. `bytes` counts only bodies this device actually holds, so a
    /// store the user cannot empty is never charged for.
    pub async fn versions_state(&self, id: String) -> Result<String, JsValue> {
        diamond::versions_gauge(&id).await.map_err(to_js_err)
    }

    /// One stored body, by its content hash.
    ///
    /// An EMPTY string means this device has not got it -- the "Not on this device" row -- which
    /// is not an error: a Diamond travels whole, and the next full pull from the device that has
    /// it brings it. Answered as text, lossily where the body is not UTF-8, because the two
    /// callers are the diff view and the page's own write door.
    pub async fn versions_body(&self, id: String, hash: String) -> Result<String, JsValue> {
        match ok!(diamond::versions_body(&id, &hash).await.map_err(to_js_err)) {
            Some(b) => Ok(String::from_utf8_lossy(&b).to_string()),
            None    => Ok(String::new()),
        }
    }

    /// The OPFS store PATH of a version body, `diamonds/<id>/versions/b/<hash>`, so the JS
    /// viewer can read its bytes through `store_read_bytes` and render a BINARY changed file
    /// through the viewer door rather than `versions_body`'s lossy UTF-8 (S-HAND #4). The
    /// path is formed whether or not the body is present; the read decides that.
    pub fn versions_body_path(&self, id: String, hash: String) -> String {
        diamond::body_path(&id, &hash)
    }

    /// Two stored bodies as the lines that differ: `{add, del, rows:[{k, t}]}`, `k` one of
    /// `" "`, `"-"`, `"+"`.
    ///
    /// An empty hash is an empty side, which is how a file's creation and its deletion are shown.
    /// A body that is not text, one this device has not got, and a file past the line ceiling all
    /// come back as an error for the caller to render as "Cannot compare".
    pub async fn versions_diff(&self, id: String, was: String, now: String)
        -> Result<String, JsValue>
    {
        diamond::versions_diff(&id, &was, &now).await.map_err(to_js_err)
    }

    /// Put the Diamond's files back as they stood at `version`, and say what became of each:
    /// `{version, restored, missing, refused, machine}`.
    ///
    /// **Never destructive**: what is on disk now is recorded as a `restore` version before a
    /// byte is written, so the state a restore replaced is one row up in the same history.
    ///
    /// Paths under `machine` are files on the user's computer. They are NOT written here -- the
    /// hand is reached only from inside a fenced turn -- and come back with the body to write for
    /// the caller that does have a door, which is the same `file_write` the Files panel uses.
    ///
    /// # Arguments
    /// * `path` - One path, or empty for the whole version, which also REMOVES a file that did
    ///   not exist at `version`.
    pub async fn versions_restore(&self, id: String, version: f64, path: String)
        -> Result<String, JsValue>
    {
        let one = path.trim();
        let want = if one.is_empty() { None } else { Some(one) };
        let (said, wrote) = ok!(diamond::versions_restore(&id, version as u64, want).await
            .map_err(to_js_err));
        // WHAT THE RESTORE LEFT, noted beside what the agent last read of these files, which
        // stays. The write guard in `Tool::FileWrite` refuses a write whose file has moved since
        // this agent read it, and a Restore moves it from outside the turn: the daimon's next
        // write from its old read is refused, in words that say the person restored the file,
        // and it reads the file again. Forgetting the read instead, as this did until RD of the
        // release 5.1 fix's third QA, let that write put the daimon's text back over the restore.
        note_restores(&self.registry.ctx.read_seen, &wrote).await;
        Ok(said)
    }

    /// Open a restore of the Diamond's files to `version`: `{version, ticket, machine}`, and
    /// nothing written.  The page's two-part Restore: each file under `machine` is the person's,
    /// written or deleted through [`DaimondApp::run_diamond_tool`] with the ticket, and
    /// [`DaimondApp::versions_restore_close`] then puts the Diamond's own files back and records
    /// the whole restore as one version.
    ///
    /// # Arguments
    /// * `path` - One path, or empty for the whole version.
    pub async fn versions_restore_open(&self, id: String, version: f64, path: String)
        -> Result<String, JsValue>
    {
        let one = path.trim();
        let want = if one.is_empty() { None } else { Some(one) };
        let plan = diamond::Plan::At(version as u64, want.map(|p| p.to_string()));
        let opened = ok!(diamond::versions_restore_open(&id, plan).await.map_err(to_js_err));
        Ok(opened.said(version as u64))
    }

    /// Open the undo of `version`: `{version, ticket, machine}`, acted on and closed as
    /// [`DaimondApp::versions_restore_open`]'s restore is, and recorded as one version.
    ///
    /// **Each path goes back to what the version replaced there**, its own row's `was` (U1 of the
    /// release 5.1 fix's second QA, 2026-09-25).  The Undo was a restore of each path to the
    /// version BEFORE, one restore a file: where the person had saved the file between the two,
    /// that put back the older text over their save, and a Restore's own Undo minted a version a
    /// file (U4).  A path the version made is handed out `gone`, for the person's yes.
    ///
    /// # Arguments
    /// * `paths` - JSON array of the paths to undo, as the store names them; empty for every path
    ///   the version changed.
    pub async fn versions_undo_open(&self, id: String, version: f64, paths: String)
        -> Result<String, JsValue>
    {
        let plan = diamond::Plan::Undo(version as u64,
            crate::llm::parse_json_string_array(&paths));
        let opened = ok!(diamond::versions_restore_open(&id, plan).await.map_err(to_js_err));
        Ok(opened.said(version as u64))
    }

    /// Close the restore `ticket` opened: `{version, recorded, restored, missing, refused}`.
    /// Called whatever became of its acts, so the copies they kept are recorded.
    pub async fn versions_restore_close(&self, id: String, ticket: f64) -> Result<String, JsValue> {
        let closed = ok!(diamond::versions_restore_close(&id, ticket as u64).await
            .map_err(to_js_err));
        // What the engine's own writes left, beside what the agent last read; see
        // [`DaimondApp::versions_restore`].
        note_restores(&self.registry.ctx.read_seen, &closed.wrote).await;
        Ok(closed.said(None))
    }

    /// Bring the store back inside its ceilings now, rather than at the next write:
    /// `{manifests, bodies}`, counting what went.
    pub async fn versions_prune(&self, id: String) -> Result<String, JsValue> {
        let (m, b) = ok!(diamond::versions_prune(&id).await.map_err(to_js_err));
        Ok(fmt!("{{\"manifests\":{},\"bodies\":{}}}", m, b))
    }

    /// Save a version the user asked for: every file in the Diamond's own directory, with the
    /// name they typed. Answers `{version, files}`, or `{}` where nothing had changed.
    ///
    /// Pruned LAST of all the causes, which is what makes the button mean something.
    pub async fn versions_save_user(&self, id: String, note: String) -> Result<String, JsValue> {
        versions_said(ok!(diamond::versions_save(&id, &note).await.map_err(to_js_err)))
    }

    /// Record what a Diamond arrived holding, after a share has been landed.
    ///
    /// Called once the files are written, because the version IS what arrived: a share that later
    /// turns out to be wrong can be walked back to the moment it landed.
    pub async fn versions_landed(&self, id: String) -> Result<String, JsValue> {
        versions_said(ok!(diamond::versions_landed(&id).await.map_err(to_js_err)))
    }

    /// Note that one of the user's own doors changed a file in this Diamond.
    ///
    /// `writeOpenFile`, the Files panel's create and delete, and a capp page's Save each call
    /// this with the path they wrote. The set is drained at the START of the next turn and
    /// recorded as one `user` version, so a turn can be undone back past the user's own last
    /// edit and a version is not minted per keystroke-adjacent save.
    pub fn versions_mark_dirty(&self, id: String, path: String) {
        diamond::mark_dirty(&id, &path);
    }

    /// [`Self::versions_mark_dirty`] for a door that marks BEFORE it writes, as the Doc panel's
    /// save and the Files panel's delete do: what the file holds now is kept as the row's `was`
    /// ([`diamond::mark_dirty_before`]).  Awaited before the write, so the bytes are the ones it
    /// replaces.
    pub async fn versions_mark_before(&self, id: String, path: String) {
        diamond::mark_dirty_before(&id, &path).await;
    }

    /// What all of one Diamond's stored bodies may weigh, in bytes; zero restores the default.
    ///
    /// The settings pulldown, and the test setter: 0.5 / 1 / 2 / 4 MiB. The ceiling is four
    /// because a Diamond's export is built as one string in wasm memory and wasm memory never
    /// shrinks.
    pub fn set_versions_cap(&self, bytes: f64) {
        versions::set_versions_bytes_cap(bytes.max(0.0) as u64);
    }

    /// How many files a turn may delete from the folder the user opened on this computer before
    /// they are asked whether it may go on; a negative number restores the default of eight.
    ///
    /// The settings pulldown, and the test setter.  Held at the store's own per-turn bound at
    /// most, past which a turn is stopped whatever was asked.
    pub fn set_open_deletes_ask(&self, n: f64) {
        versions::set_open_deletes_ask(if n.is_nan() || n < 0.0 { None } else { Some(n as usize) });
    }

    /// The limit [`DaimondApp::set_open_deletes_ask`] set, as a turn will apply it.
    pub fn open_deletes_ask(&self) -> f64 {
        versions::open_deletes_ask() as f64
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
    /// * `unconfirmed` - JSON array of the places marked into this Diamond that are NOT in force
    ///   on this device until the user confirms them here, which the daimon is told so that it
    ///   asks for the press rather than working around a refusal.  Last and optional, so a caller
    ///   that says nothing is a turn with none waiting.
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
        toolkits:    String,
        prior:       js_sys::Array,
        on_event:    js_sys::Function,
        unconfirmed: Option<String>,
    )
        -> Result<js_sys::Array, JsValue>
    {
        self.steer_inner(&id, instruction, attached, read_only, toolkits,
            unconfirmed.unwrap_or_default(), prior, on_event)
            .await
            .map_err(to_js_err)
    }

    /// Propose a fold: run a fresh reducer over the current crystal and the three files beside
    /// it plus one `delta`, and answer with what it proposes for all four.  Writes nothing.
    ///
    /// The answer is a JSON envelope -- `{"crystal": "…", "requirements": "…", "decisions": "…",
    /// "state": "…"}` -- with a file present only where the reducer rewrote it, which
    /// [`DaimondApp::fold_apply`] takes back unchanged.  It is an envelope rather than the bare
    /// crystal because the fold now returns four documents and a second call to fetch the other
    /// three would run the reducer twice.
    ///
    /// **A proposal that would DESTROY something is refused here**, not reported: a populated
    /// crystal key, every hot flag, a ticked task or a line of the append-only decisions.  The
    /// reducer is run once more with the loss named, and only a second failure comes back as an
    /// error.  See `dev/CRYSTAL_CONTRACT.md` §13 -- one click commits, so there is no moment at
    /// which a person reads a warning and no undo but the version history.
    ///
    /// The page is not folded and is not shown to the reducer.  It is presentation, and a reducer
    /// asked to summarise a Diamond has no business rewriting how it looks.
    pub async fn fold_propose(&self, id: String, delta: String) -> Result<String, JsValue> {
        self.fold_propose_inner(&id, &delta).await.map_err(to_js_err)
    }

    /// Apply a confirmed fold: write the accepted crystal and any of the three files the
    /// proposal carries, snapshot a version, retain the raw `delta` under `.daimond/deltas/`,
    /// and append a `fold` record referencing it.
    ///
    /// # Arguments
    /// * `id` - The Diamond.
    /// * `proposal` - The envelope [`DaimondApp::fold_propose`] returned, unchanged.
    /// * `delta` - What was folded in, kept beside the version it produced.
    /// * `note` - What the log record says about who asked.
    pub async fn fold_apply(
        &self,
        id:        String,
        proposal:  String,
        delta:     String,
        note:      String,
    )
        -> Result<(), JsValue>
    {
        self.fold_apply_inner(&id, &proposal, &delta, &note).await.map_err(to_js_err)
    }

    /// Cumulative prompt tokens billed to this session.
    ///
    /// Borrows the session, so it is a POST-TURN read: [`DaimondApp::run_turn`] holds the
    /// session mutably for the whole turn, and a bare `borrow()` reading mid-turn would panic
    /// the `RefCell` -- which is exactly what happened live, on [`DaimondApp::last_prompt_tokens`],
    /// when the browser's stats seam read a getter while a turn was in flight.  `try_borrow`
    /// instead, so a mid-turn read draws zero rather than crashing the page; mid-turn,
    /// [`DaimondApp::live_prompt_tokens`] is the figure to read.
    #[wasm_bindgen(getter)]
    pub fn prompt_tokens(&self) -> f64 {
        self.session.try_borrow().map(|s| s.prompt_tokens as f64).unwrap_or(0.0)
    }

    /// Cumulative completion tokens billed to this session.
    ///
    /// Post-turn only; see [`DaimondApp::prompt_tokens`] for why this reads with `try_borrow`
    /// rather than a bare `borrow()`.  Mid-turn, read [`DaimondApp::live_completion_tokens`].
    #[wasm_bindgen(getter)]
    pub fn completion_tokens(&self) -> f64 {
        self.session.try_borrow().map(|s| s.completion_tokens as f64).unwrap_or(0.0)
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
    /// session mutably for the whole turn, so this reads with `try_borrow` and draws
    /// zero rather than panicking the `RefCell` on a mid-turn read.  Mid-turn, read
    /// [`DaimondApp::live_cached_tokens`].
    #[wasm_bindgen(getter)]
    pub fn cached_tokens(&self) -> f64 {
        self.session.try_borrow().map(|s| s.cached_tokens as f64).unwrap_or(0.0)
    }

    /// Cumulative USD the provider says this session actually cost.
    ///
    /// Zero means no provider reported a figure -- never that the session was
    /// free -- so a caller reading zero prices the turn from its own table. The
    /// same zero is what a mid-turn `try_borrow` failure draws, exactly as
    /// [`DaimondApp::cached_tokens`]; post-turn is the only reading that tells the
    /// two apart, so a live figure wants [`DaimondApp::live_cost_usd`] instead.
    #[wasm_bindgen(getter)]
    pub fn cost_usd(&self) -> f64 {
        self.session.try_borrow().map(|s| s.cost_usd).unwrap_or(0.0)
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
    ///
    /// Read with `try_borrow` rather than a bare `borrow()`: the browser's sync
    /// pull-merge / stats seam calls this getter from JS while [`DaimondApp::run_turn`]
    /// may be sitting mid-`await` with the session already borrowed mutably, and a bare
    /// `borrow()` there panics the `RefCell` -- seen live as three `RefCell already
    /// mutably borrowed` panics at 2026-09-13 01:26-01:30Z.  A failed borrow draws zero,
    /// same as the "no round has reported yet" case below, rather than crashing the page.
    #[wasm_bindgen(getter)]
    pub fn last_prompt_tokens(&self) -> f64 {
        self.session.try_borrow().map(|s| s.last_prompt_tokens as f64).unwrap_or(0.0)
    }

    /// Prompt tokens of the last round the turn IN FLIGHT has sent, safe to read
    /// while it runs; see [`DaimondApp::live_prompt_tokens`].
    ///
    /// [`DaimondApp::last_prompt_tokens`] borrows the session and draws zero mid-turn,
    /// so a context meter reading it while a turn runs sees nothing until the turn ends.
    /// This sits on the agent, outside that borrow, and is set round by round.
    #[wasm_bindgen(getter)]
    pub fn live_last_prompt_tokens(&self) -> f64 {
        self.agent.live_last_prompt.get() as f64
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

/// The Wire view's JSON: the system message in its named parts, and the tool schemas.
///
/// ONE formatter for both threads, taking the agent and the registry rather than reaching for an
/// app's own -- which is what lets a daimon's answer be composed by the daimon's own code and
/// still arrive in the shape the band already draws.
///
/// # Arguments
/// * `local` - The slice of the system message that is true of this turn only, which a daimon has
///   and a chat has not.  It is a SUBSTRING of `role`, not an addition to it: the band strips it
///   out to draw it under its own heading, so that a Diamond's crystal is not filed under
///   "Safety clause".  Empty for a chat.
///
/// `schemas_len` is measured here and handed over because the caller cannot measure it: the band
/// re-indents the schemas to make them readable, and counting THAT copy is counting characters no
/// request has ever carried -- about four thousand of them for the browser toolbelt, a thousand
/// tokens, twelve per cent, all of it the viewer's own formatting.  The figure quoted from this
/// band has been reasoned from in a handover, so it is the sent bytes or it is nothing.  It is the
/// same `len()` [`Agent::run_tool_loop`] budgets the window with, so the band and the fold agree.
///
/// BYTES, and a reader in the page has to convert to compare.  A Rust `len()` counts UTF-8; the
/// same array measured with JavaScript's `String.length` counts UTF-16 code units, which for the
/// browser toolbelt is 41,964 against this figure's 41,998.  Thirty-four bytes is nothing until
/// it straddles a rounding step, and on 2026-08-25 it straddled 10,500: one number drew "11k" and
/// the other "10k", and a release lane read that as the band having drifted from the request.  It
/// had not.  A page comparing the two must encode first.
fn wire_json(
    agent:    &Agent,
    registry: &ToolRegistry,
    local:    &str,
)
    -> String
{
    let (role, tools, brief) = agent.system_parts(registry);
    let defs = registry.definitions_json().unwrap_or_else(|| fmt!("[]"));
    fmt!(
        "{{\"role\":\"{}\",\"tools_sentence\":\"{}\",\"machine\":\"{}\",\"local\":\"{}\",\
         \"schemas_len\":{},\"schemas\":{},\"names\":{}}}",
        crate::llm::json_escape(&role),
        crate::llm::json_escape(&tools),
        crate::llm::json_escape(&brief),
        crate::llm::json_escape(local),
        defs.len(),
        defs,
        fmt!("[{}]", registry.tool_names().iter()
            .map(|n| fmt!("\"{}\"", crate::llm::json_escape(n)))
            .collect::<Vec<_>>().join(",")))
}

/// Note in `cache` what a restore left at each of `paths`, read back off the disk: a file it
/// deleted, or one this door cannot read, notes nothing ([`crate::tools::note_restored`]).
async fn note_restores(cache: &crate::tools::ReadCache, paths: &[String]) {
    for p in paths.iter() {
        if let Ok(b) = crate::wasm::opfs::read_file(crate::tools::FileRoot::Workspace, p).await {
            crate::tools::note_restored(cache, p, &b);
        }
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

/// Everything ONE steering turn on a Diamond is composed of.
///
/// Split out of [`DaimondApp::steer_inner`] so the Wire can be handed the very objects the request
/// is built from; [`DaimondApp::compose_daimon`] says why that is not a tidying.
struct DaimonTurn {
    agent:    Agent,        // the daimon, its system message composed and this app's limits adopted
    registry: ToolRegistry, // exactly the tools this turn holds, and nothing else
    crystal:  String,       // crystal.json as it stood before the turn, for the comparison after it
    standing: crate::tools::Standing, // the three files as the turn found them, for the same reason
    local:    String,       // the slice of the system message true of this turn only, for the Wire
}

/// Inner helpers for the crystal and reducer turns.  Kept in a plain
/// `impl` (not `#[wasm_bindgen]`) so they can take Rust-only types and
/// return [`Outcome`], using the error macros throughout; the exported
/// wrappers above map the result to the JS boundary.
impl DaimondApp {

    /// Record what a turn keeping into `key`'s store captured as one version of it -- a chat's,
    /// or a Diamond's own thread's -- and tell the page with a `versions` event:
    /// `{type, keeper, version, files}`, so it can offer the way back.
    ///
    /// Best effort, like the daimon's: a turn the user asked for is not failed because its
    /// history could not be written, and the console says so.
    async fn record_keeper_turn(&self, key: &str, on_event: &js_sys::Function) {
        // A STEER RUNNING ON THE SAME DIAMOND ENDS THE STORE'S TURN ITSELF, and a thread's turn
        // end must not take its captures, its seal count or the person's "go on" from under it.
        // Asked again once the store is held (R4 of the release 5.1 fix's QA, 2026-09-25): the page
        // asked once, before the wait, and a steer that started during the wait -- an import holding
        // the store -- had its first captures filed under the thread's version.
        if diamond::is_steering(key) {
            return;
        }
        // With the copies noted on disk before each act, including any an earlier life of the
        // page left unrecorded -- which are recorded under the same hold, as versions of their own,
        // before this turn's (R2-2).
        let hold = match diamond::hold_versions(key).await {
            Ok(h)  => h,
            Err(e) => {
                // Left for the next turn end: the captures stay in memory and the notes on disk.
                // The turn's counts end here all the same (F4).
                diamond::end_turn_counts(key);
                web_sys::console::warn_1(&JsValue::from_str(&fmt!(
                    "the files the turn in {} changed could not be recorded: {}", key, e)));
                return;
            },
        };
        if diamond::is_steering(key) {
            return;
        }
        let (captured, notes, _) = diamond::drain_turn(&hold, key, &self.registry.ctx).await;
        if captured.is_empty() {
            drop(hold);
            diamond::settle(key, &notes).await;
            return;
        }
        let changes = captured.into_iter().map(|(_, ch)| ch).collect();
        let recorded = diamond::versions_record_held(&hold, key, None, Cause::Turn, "", "", changes)
            .await;
        drop(hold);
        if recorded.is_ok() {
            diamond::settle(key, &notes).await;
        }
        match recorded {
            Ok(Some((v, files))) => {
                let ev = js_sys::Object::new();
                let list = js_sys::Array::new();
                for f in files.iter() {
                    list.push(&JsValue::from_str(f));
                }
                let _ = js_sys::Reflect::set(&ev, &JsValue::from_str("type"),
                    &JsValue::from_str("versions"));
                let _ = js_sys::Reflect::set(&ev, &JsValue::from_str("keeper"),
                    &JsValue::from_str(key));
                let _ = js_sys::Reflect::set(&ev, &JsValue::from_str("version"),
                    &JsValue::from_f64(v as f64));
                let _ = js_sys::Reflect::set(&ev, &JsValue::from_str("files"), &list);
                let _ = on_event.call1(&JsValue::NULL, &ev);
            },
            Ok(None) => {},
            Err(e)   => web_sys::console::warn_1(&JsValue::from_str(&fmt!(
                "the files the turn in {} changed could not be recorded: {}", key, e))),
        }
    }


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
        // WHERE THE TURN IS, before anything else it may need to know.
        //
        // The largest round sink measured on the bank is not a tool failure at all: 21 of 27
        // Claude trials opened by reading a path spelled relative to the wrong root, met a
        // not-found, spent a `file_list '.'` and read again -- 44 rounds over 16 trials. A shell
        // agent never pays that because its prompt says what its working directory is. This says
        // the same thing once per turn, and costs a listing the page has already cached.
        //
        // Only where the turn holds file tools: a role with none cannot act on it.
        if registry.tools.iter().any(|t| matches!(t, Tool::FileRead | Tool::FileList)) {
            let note = crate::tools::orientation_tree(
                &registry.ctx, &registry.ctx.cwd, &registry.ctx.no_write).await;
            if !note.is_empty() {
                if !s.is_empty() {
                    s.push_str("\n\n");
                }
                s.push_str(&note);
            }
        }
        // What the account has NOT bought, in one sentence, because the tools themselves are no
        // longer in the request at all -- see `ToolRegistry::offered`.  Absent, and free, on an
        // account that holds every pack its belt is sold under.
        if let Some(packs) = registry.locked_pack_note() {
            if !s.is_empty() {
                s.push_str("\n\n");
            }
            s.push_str(&packs);
        }
        s
    }

    /// The daimon, the tools and the crystal ONE steering turn on `id` runs with.
    ///
    /// **THE ONE COMPOSITION, read by the turn and by the Wire.**  A daimon's turn does not go
    /// through [`DaimondApp::run_turn`] at all -- a Diamond's thread is routed to `doSteer` in the
    /// browser and lands in [`DaimondApp::steer_inner`] -- so the Wire, whose only getter read a
    /// CHAT's agent and registry, described a conversation that was not happening: 28 tools
    /// including `say` and the nine web tools, where the daimon in front of the user held 17 and
    /// none of those.  The band's whole claim is that it cannot drift from the request, and it
    /// could, because there were two composers and only one of them had a getter.
    ///
    /// A second copy of the tool vector or of the system text would be that same defect with an
    /// extra step in it, so there is one copy here and both callers take it.
    ///
    /// # Arguments
    /// * `id` - The Diamond.  It decides the reach, the folder named in the prompt, and where a
    ///   link this daimon asserts is kept.
    /// * `attached` - JSON array of the paths marked into this Diamond, as `Files.bounds` reports
    ///   them.  Read per turn because they change per turn; empty is a turn confined to the
    ///   Diamond's own directory, which is the safe reading of "nothing was said".
    /// * `read_only` - Those of them to be consulted rather than edited.
    /// * `toolkits` - JSON array of the toolchain names the user granted this Diamond, as
    ///   `Files.bounds` reports them.
    /// * `unconfirmed` - JSON array of the places marked into this Diamond that are not in force
    ///   on this device until the user confirms them here, as `Files.bounds` reports them.
    /// The stops of the running turns whose tag `pick` accepts, cloned out so none is fired
    /// under the borrow.
    fn halts_where(&self, pick: impl Fn(&str) -> bool) -> Vec<Halt> {
        self.turns.borrow().iter()
            .filter(|(t, _)| pick(t))
            .map(|(_, h)| h.clone())
            .collect()
    }

    /// Hold a turn's stop under its tag until the answer is dropped, firing it at once where
    /// the page stopped that tag before the turn began.
    fn hold_turn(&self, tag: String, halt: Halt) -> Running<'_> {
        if !tag.is_empty() {
            let mut early = self.early.borrow_mut();
            if let Some(at) = early.iter().position(|t| *t == tag) {
                early.remove(at);
                halt.fire();
            }
        }
        self.turns.borrow_mut().push((tag.clone(), halt.clone()));
        Running { app: self, tag, halt }
    }

    async fn compose_daimon(
        &self,
        id:          &str,
        attached:    &str,
        read_only:   &str,
        toolkits:    &str,
        unconfirmed: &str,
    )
        -> DaimonTurn
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
        let marked = parse_path_array(attached);
        let consult = parse_path_array(read_only);
        let mut bounds = crate::tools::diamond_bounds(
            &diamond::diamond_dir(id), &marked, &consult);
        // THE TOOLCHAINS THE USER TICKED ON THIS DIAMOND, and they were missing here.
        //
        // [`DaimondApp::set_diamond_scope`] has extended a worker's bounds with these since the
        // grant existed; this composer never did.  So ticking Git on a Diamond granted it to the
        // workers that Diamond dispatched and NOT to the daimon the user was talking to -- the
        // one surface where the grant is made.  The daimon's own briefing said "No toolchain is
        // granted to this Diamond" while the panel beside it drew the chip as on.
        //
        // Measured, not reasoned: `dev/reflux.mjs` gave a real model a repository and a granted
        // Git toolkit and watched it spend twenty-seven tool calls on
        // `unable to access '/home/jason/.gitconfig': Permission denied`, reaching in the end for
        // `chmod o+x /home/jason` and `mv ~/.gitconfig ~/.gitconfig.bak` -- both refused by the
        // fence, and both what a missing grant provokes.  The hand's journal for that turn
        // recorded `"ro": []`.
        bounds.extend(crate::tools::toolkit_bounds(&parse_path_array(toolkits)));
        // Stateless per instruction: reconstruct context from the crystal.
        //
        // The heading names the FILE, not the format, and that is what makes the standing context
        // and the file tools agree: a daimon told "here is the crystal" and left to find out where
        // it lives has to guess a name, and the name changed under it.
        let before = diamond::read_crystal_data(id).await.unwrap_or_default();
        // COMPOSED FOR THE MODEL THAT WILL CARRY THE REQUEST, read off the client rather than
        // from a constant, exactly as `briefing` reads it: two of the notes are dropped for a
        // model measured not to need them, and a model this build has not heard of is given all
        // of them.  See `prompts::CONDITIONAL` and `dev/PROMPT_NOTES.md`.
        let standing = Role::Daimon.compose_wire(
            &self.daimon_prompt.borrow(), &self.agent.llm.model, self.registry.claude_names());
        // Named apart from the standing text rather than pushed onto it, and the reason is the
        // question the Wire asks of every paragraph: WHOSE is it.  The role prompt above is one
        // constant every Diamond shares and its owner may rewrite; what follows is true of THIS
        // Diamond on THIS turn and of no other.  They are joined below in send order, so nothing
        // here changes a byte of what the model reads.
        let mut local = String::new();
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
        local.push_str("\n\nThis Diamond's own folder is `");
        local.push_str(&diamond::diamond_dir(id));
        local.push_str("/`, so its crystal is `");
        local.push_str(&diamond::diamond_dir(id));
        local.push_str("/crystal.json` and its page is the `crystal.html` beside it. Paths you \
            give the file tools are whole workspace-relative paths, never bare names.");
        // MARKED, AND NOT IN FORCE ON THIS DEVICE.  A mark is in force only on a device where
        // the user made it or confirmed it, so every mark made elsewhere -- and every one made
        // before marks said who made them -- is out of reach here until they press to confirm it.
        // A daimon not told that meets a plain refusal and concludes the folder is not its to use,
        // or goes looking for another way in; told, it asks the user for the one press.
        let waiting = parse_path_array(unconfirmed);
        if marked.is_empty() && consult.is_empty() && waiting.is_empty() {
            local.push_str(" Nothing is attached to this Diamond yet, so the folder above is the \
                only place you may write. If the user asks for work on files that are not there, \
                say what needs marking in with the + in the Workspace group rather than creating it.");
        } else if marked.is_empty() && consult.is_empty() {
            local.push_str(" Nothing attached to this Diamond is in force on this device yet, so \
                the folder above is the only place you may write.");
        } else {
            local.push_str("\n\nAttached to this Diamond, and reachable now:\n");
            for p in &marked {
                local.push_str("- `");
                local.push_str(p);
                local.push_str("` (yours to edit)\n");
            }
            for p in &consult {
                local.push_str("- `");
                local.push_str(p);
                local.push_str("` (read it; do not edit it)\n");
            }
            local.push_str("Look at what is attached before you answer a question about it. You \
                may READ anywhere in the workspace, and you may write only in the places above.");
        }
        if !waiting.is_empty() {
            local.push_str("\n\nMarked into this Diamond on another device, or before this \
                device recorded marks, and NOT in force on this device until the user confirms \
                them here:\n");
            for p in &waiting {
                local.push_str("- `");
                local.push_str(p);
                local.push_str("` (unconfirmed on this device)\n");
            }
            local.push_str("You may read these but not write in them yet. If the work needs one, \
                tell the user it is unconfirmed on this device and ask them to confirm it -- one \
                press on the notice above the message box -- rather than working around it.");
        }
        // THE SAME DEPTH-LIMITED TREE A CHAT TURN GETS, not a bespoke sentence of its own -- see
        // `DaimondApp::briefing`, called near the bottom of this function to build the agent's
        // briefing.  It was ALSO composed here until measured: a daimon turn's `machine` carried
        // one tree and its `local` carried a second, ~3,200 further characters against a cap
        // (`ORIENTATION_TREE_CHARS`) meant to hold one.  `briefing()` already walks the same root
        // with the same bounds, so a second walk here bought nothing but the duplicate -- the
        // paragraph above, naming WHAT is attached and who may edit it, is the orientation this
        // function itself still owns; WHAT IS IN each of those places is `briefing()`'s alone now.
        // THE HOT PART AND AN OUTLINE OF THE REST, which is the seam the split is made at.
        //
        // `local` is per-turn truth the user cannot edit away -- the role prompt is theirs
        // (`prompts/<role>.md`) -- and the outline is itself the proof that the cold part exists:
        // a sentence saying "there is more" with nothing naming it is a sentence a model has no
        // way to act on. A crystal under the hot ceiling composes exactly as it always did, which
        // is every small crystal.
        //
        // `DaimonTurn.crystal` below stays the WHOLE text: the after-turn comparison diffs the
        // FILE, and diffing the hot part would report every cold edit as no change at all.
        // THE THREE FILES BESIDE IT, created on the spot for a Diamond that predates them, and
        // read ONCE here so the block is byte-stable for every round of this turn -- exactly as
        // the crystal above is.  A file re-read per round would change the system message under
        // a turn that had already sent it, which is the one thing a standing context may not do.
        let files = diamond::ensure_standing(id).await;
        // THE `nofiles` MEASUREMENT ARM'S OWN DOOR. `files` itself is read and tracked
        // regardless -- the turn-end check below still needs the true content to diff against
        // -- but what goes into THIS turn's prompt is an empty `Standing` when the switch is
        // off, so the crystal gets the hot room back rather than paying for files it is not
        // shown. See `dev/CRYSTAL_CONTRACT.md` §5 and `dev/tune/arms.json`'s `nofiles` arm.
        let tune = self.agent.limits();
        let prompt_files = if tune.standing_files {
            files.clone()
        } else {
            crate::tools::Standing::default()
        };
        let split = crate::tools::crystal_split(
            &before, crate::tools::crystal_hot_room(prompt_files.hot_bytes())).unwrap_or_default();
        local.push_str(&crate::tools::crystal_prompt_text(&split, &prompt_files));

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
        // In send order, and this is the join the turn and the band both depend on: the band is
        // handed `local` to draw apart, and finds it by looking for it in the whole.
        let system = fmt!("{}{}", standing, local);
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
            keeper:      id.to_string(),
            unconfirmed: waiting,
            by_model:    false,
            restoring:   0,
        };
        let registry = ToolRegistry::new(Tool::daimon(), ctx)
            .with_family(self.registry.family());
        // A STOP OF ITS OWN: this app is shared by every Diamond on one model, and a daimon
        // stopped with the app's halt would stop them all.  `steer_inner` holds it under the
        // page's tag.
        let agent = Agent::new(self.agent.llm.with_halt(Halt::new()),
            &self.with_instructions(&system));
        // A fresh agent starts from the default limits, so without this a Diamond's
        // daimon would fold the same model's conversation at a different size from
        // the chat that dispatched it.
        agent.adopt_limits(&self.agent);
        // And it starts with no briefing at all, which left the ONE agent that dispatches workers
        // as the one agent that could not judge how many to dispatch.
        let mut brief = self.briefing(&registry).await;
        // "N objectives, M open tasks; top three: …" -- parsed from the SAME read of
        // `REQUIREMENTS.md` the hot block above carries, not a second one, so the figure agrees
        // with what the model is also being shown in the prompt and stays byte-stable for every
        // round of this turn. See `dev/CRYSTAL_CONTRACT.md` §5.1.
        let objectives = crate::tools::requirements_briefing(&files.requirements, tune.briefing_top3);
        if !objectives.is_empty() {
            if !brief.is_empty() {
                brief.push_str("\n\n");
            }
            brief.push_str(&objectives);
        }
        agent.set_briefing(&brief);
        // WHICH DIAMOND, so that a fold mid-turn can file what it is about to forget into
        // `REQUIREMENTS.md`, `DECISIONS.md` and `STATE.md` rather than into a note that is
        // re-summarised at the next fold. `Agent::fold_if_needed` is handed the conversation and
        // nothing that names a Diamond, and this is the only place the name is in hand. See
        // `dev/CRYSTAL_CONTRACT.md` §13.
        agent.set_diamond(id);
        DaimonTurn { agent, registry, crystal: before, standing: files, local }
    }

    /// Drive the crystal agent for one instruction (see
    /// [`DaimondApp::steer_crystal`]).
    async fn steer_inner(
        &self,
        id:          &str,
        instruction: String,
        attached:    String,
        read_only:   String,
        toolkits:    String,
        unconfirmed: String,
        prior:       js_sys::Array,
        on_event:    js_sys::Function,
    )
        -> Outcome<js_sys::Array>
    {
        // A `/name` here matters more than in a chat, not less: a skill lives in the workspace, and
        // until this turn was given the workspace a daimon could not read one for itself, so the
        // prose convention failed here in total silence.
        //
        // What the user TYPED is kept for the log below. The record of why a crystal changed should
        // read `/pickup daimond`, which is what they did; the skill's whole text is in the skill.
        let typed = instruction.clone();
        // THIS TURN'S STOP, held under the tag the page gave this Diamond's turn before anything
        // awaits, so pausing or stopping this Diamond reaches this turn and no other Diamond's
        // sharing the app; see [`DaimondApp::abort_turn`].
        let halt = Halt::new();
        let _running = self.hold_turn(self.registry.ctx.turn_tag_for(id), halt.clone());
        // THIS DIAMOND IS STEERING, counted before anything awaits and until this turn's end has
        // drained the captures, so a thread's turn end that waited on the store and then finds it
        // counted leaves the store's turn to this one (R4 of the release 5.1 fix's QA).
        let mut steering = Some(diamond::steering(id));
        let instruction = match open_command(instruction).await {
            Opened::Send(text)  => text,
            Opened::Refuse(msg) => return Err(refuse(&msg)),
        };
        // What this turn is made of, composed by the one function the Wire is shown as well.  The
        // marks, the bounds, the Diamond's own paragraph and the tool vector all used to stand
        // here; they were MOVED and not copied, because a copy is how the band came to describe a
        // registry the daimon has not got.
        //
        // `local` is dropped here and taken only by the Wire: the turn wants the joined message,
        // which the agent already holds, and a second copy of half of it would be one more thing
        // able to disagree with the first.
        let DaimonTurn { mut agent, registry, crystal: before, standing: standing_before, .. } =
            self.compose_daimon(id, &attached, &read_only, &toolkits, &unconfirmed).await;
        agent.llm = agent.llm.with_halt(halt);
        // THE USER'S OWN EDITS BECOME A VERSION BEFORE THE TURN CAN WRITE OVER THEM.
        //
        // The Files panel, a capp's Save and a landed Diamond each marked the path they wrote,
        // and nothing has recorded them yet -- deliberately, because recording at the moment of
        // every keystroke-adjacent save would mint a version per save.  Draining the set here is
        // what makes "put it back to how it was before this turn" true of the USER'S last edit
        // and not merely of the daimon's.
        //
        // Best effort, and it must stay that way: a turn the user asked for is not refused
        // because the history could not be written.
        let dirty = diamond::drain_dirty(id);
        if !dirty.is_empty() {
            let changes = diamond::dirty_changes(id, dirty).await;
            if let Err(e) = diamond::versions_record(id, Cause::User, "", "", changes).await {
                web_sys::console::warn_1(&JsValue::from_str(&fmt!(
                    "the state of {} before this turn could not be recorded: {}", id, e)));
            }
        }
        // Read before the turn, compared after it. The page is not put in the prompt -- it is
        // markup the daimon can open with `file_read` when it has been asked to change it, and it
        // would otherwise be paid for on every request of every steering turn.
        let page_before = diamond::read_crystal_page(id).await.unwrap_or_default();
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
        session.messages = crate::protocol::pair_up(seeded);
        // THE LAST WORD OF THE TURN BEFORE THIS ONE, for the tail note's "never twice in a row"
        // -- cloned out now, because a fold during the turn may replace it with a notice and a
        // read after the turn would need a second, overlapping borrow of `session.messages`.
        let prior_tail = session.messages.last().cloned();

        let mut sink = |ev: AgentEvent| {
            let js = event_to_js(&ev);
            let _ = on_event.call1(&JsValue::NULL, &js);
        };
        let ran = agent.run_turn(&mut session, instruction, &registry, &mut sink).await;
        self.absorb_usage(&session);
        // WHERE THIS TURN'S OWN MESSAGES START, so its ledger can be read apart from every turn
        // before it -- `ledger_of` over the whole session would answer the same "files written"
        // for turn forty as for turn one, and the turn-end check below needs to know what THIS
        // turn did, not what the conversation has ever done.  READ FROM THE AGENT AFTER THE TURN,
        // never as the length the list had before it: a fold inside `run_turn` replaces the folded
        // prefix with one notice, so a 200-message prior became 27 and the length taken before the
        // turn was an index past the end.  In wasm that slice is a trap, the future never settles,
        // and the caller's promise sat until its timeout -- `dev/verify_foldabsorb.mjs`'s first
        // padded fold, 2026-09-15. See `Agent::turn_start`.
        let turn_start = agent.turn_start().min(session.messages.len());
        // ARITHMETIC, NOT JUDGEMENT -- the same ledger a context fold reconciles a claimed edit
        // against ([`crate::agent::compact::reconcile`]), read over exactly this turn's own messages.
        let ledger = crate::agent::compact::ledger_of(&session.messages[turn_start..]);

        // If the crystal, the page, or any of the three standing files changed, snapshot a
        // version and log the edit so every mutation stays versioned and auditable.  Attempted
        // even when the turn ended badly: a turn that wrote a file and then died has still
        // changed it, and leaving that version unrecorded is the one outcome with no way back.
        let after = diamond::read_crystal_data(id).await.unwrap_or_default();
        // THE PAGE COUNTS AS A CHANGE TOO. A turn asked to redesign how a Diamond looks writes
        // `crystal.html` and touches no data at all, and judging by the data alone would leave
        // that turn's work on disk with no version, no snapshot and no line in the log saying who
        // asked for it -- the one change in a Diamond with no way back.
        let page_after = diamond::read_crystal_page(id).await.unwrap_or_default();
        // AND SO DO THE THREE STANDING FILES. A turn that ticks a task or rewrites `STATE.md` and
        // touches neither `crystal.json` nor `crystal.html` is a turn with real work to show for
        // it, and judging by the crystal alone would leave it with no version either -- exactly
        // the gap `dev/CRYSTAL_CONTRACT.md` §5 exists to close. `snapshot` mints the next version
        // number on every call regardless of whether `crystal.json` itself moved, so calling
        // `record_steer` here is what earns the version; it does not need `after` to differ from
        // `before` to do it.
        let standing_after = diamond::read_standing(id).await;
        let tune = agent.limits();
        // THE VERSION STORE IS HELD FROM THE CRYSTAL'S MINT TO THE FILES' MANIFEST, so no seal, no
        // revert and no other tab mints between them (R2-1; see `diamond::VersionHold`).
        // A STORE ANOTHER ACT HOLDS PAST THE WAIT IS NOT WAITED ON FOR EVER (the engine unit's open
        // item 2): the turn's changes stay on disk as it left them, its captures and notes stay for
        // the next turn end to adopt, and the daimon is told below.
        let recorded = match diamond::hold_versions(id).await {
            Ok(hold) => {
                let mut minted: Option<u64> = None;
                // THE COPIES AN EARLIER LIFE OF THE PAGE LEFT ARE RECORDED FIRST (R2-2), each run
                // it began on a path this life then changed again as a version of its own, below
                // the one this turn takes -- the older copy under the older number.
                let (captured, notes, left) = diamond::drain_turn(&hold, id, &registry.ctx).await;
                // The captures are this turn's now: a thread's turn end from here takes only what
                // lands after them.
                steering.take();
                if after != before || page_after != page_before || standing_after != standing_before {
                    let version = res!(diamond::record_steer(&hold, id, &after, &typed).await);
                    minted = Some(version);
                    // ONE `kind:"task"` RECORD PER TICK, carrying what the ledger shows behind it. A
                    // task that went from `- [ ]` to `- [x]` in `before`/`after` earns one whether or not
                    // anything else changed in the same turn -- ticking three tasks with one file write
                    // between them is still three claims, each its own line. Gated on `task_log` alone:
                    // the version above is still minted with it off, so a Diamond still gets one, and
                    // only the per-task record and its flag disappear.
                    if tune.task_log {
                        let parent = version as i64 - 1;
                        // THE TICK'S OWN WRITE DOES NOT COUNT AS ITS BACKING. Ticking a task is ITSELF a
                        // `file_edit` of `REQUIREMENTS.md`, so `ledger.wrote` always holds that one path
                        // however the tick was arrived at -- checking for "anything written" would make
                        // the flag fire on nothing a bare tick could ever trigger it on, which is exactly
                        // the never-forget file's own failure mode. What counts is a write to something
                        // ELSE: the file the work actually landed in, or `STATE.md`/`DECISIONS.md`
                        // alongside it.
                        let backed = if ledger.wrote.iter().any(|w|
                            crate::tools::standing_leaf(w) != Some(crate::tools::REQUIREMENTS_FILE))
                        {
                            Some("an edit")
                        } else if !ledger.reported.is_empty() {
                            Some("a worker report")
                        } else {
                            None
                        };
                        for task_id in crate::tools::ticked_tasks(
                            &standing_before.requirements, &standing_after.requirements)
                        {
                            res!(diamond::record_task_tick(id, version, parent, &task_id, backed).await);
                        }
                    }
                }
                // WHAT THIS TURN CHANGED IN FILES, against the same version the crystal took.
                //
                // The ledger is arithmetic and not judgement -- it holds the paths the tool layer says
                // were actually written -- so this records what happened rather than what the model said
                // it did.  Three sources join here and each covers what the others cannot:
                //
                // * the ledger's own paths, for everything written through a named door;
                // * what the file tools captured mid-turn, which is the only account there will ever be
                //   of a machine file's bytes before the daimon overwrote them (see `diamond::capture`);
                // * and, only where the turn ran something OPAQUE, a walk of the Diamond's own directory
                //   -- a command, a verifier or a worker names no path at all, and the honest answer to
                //   "what did it change" is to look.
                //
                // Attempted even when the turn ended badly, for the reason the version above is: a turn
                // that wrote a file and then died has still changed it.
                // The copies were noted on disk before each act (`diamond::pend`), so a turn that died
                // mid-way, or a page reloaded under a worker, left them for this turn end to adopt.
                // A capture sealed because its file changed after the turn's last act is covered
                // too: read again from the ledger, it would be the turn's row once more.
                let covered: std::collections::BTreeSet<&str> =
                    captured.iter().map(|(raw, _)| raw.as_str())
                        .chain(left.iter().map(|raw| raw.as_str()))
                        .collect();
                let mut named: Vec<String> = Vec::new();
                for wrote in ledger.wrote.iter() {
                    // A move is one ledger line naming two paths, and both of them moved.
                    for half in wrote.split(" -> ") {
                        let half = half.trim();
                        if !half.is_empty() && !covered.contains(half) {
                            named.push(half.to_string());
                        }
                    }
                }
                let mut changes = diamond::versions_changes(id, &named).await;
                changes.extend(captured.into_iter().map(|(_, ch)| ch));
                if !ledger.ran.is_empty() || !ledger.spawned.is_empty() {
                    changes.extend(diamond::versions_walk(id).await);
                }
                // The turn's own id is the browser's (`iturn`, the user message's `mid`) and does not
                // cross the wasm boundary today, so the manifest is joined to its History row by VERSION
                // NUMBER, which is what `showCrystalHistory` joins on anyway. The field stays, for the
                // caller that will one day have the id.
                let recorded = diamond::versions_record_held(&hold, id, minted, Cause::Turn, "", &typed,
                    changes).await;
                drop(hold);
                // Settled only once the manifest is written: a note outliving a failed record is adopted
                // by the next turn end instead of lost.
                if recorded.is_ok() {
                    diamond::settle(id, &notes).await;
                }
                recorded
            },
            Err(e) => {
                // The turn is over even though its record is not: its counts end with it (F4).
                diamond::end_turn_counts(id);
                Err(e)
            },
        };
        match recorded {
            // THE DAIMON IS TOLD, in one sentence, and only where a manifest was actually
            // written. A model with no way to undo its own work does not merely fail to undo it:
            // it reports that the app cannot, which is the defect `Tool::FileShow` was written
            // for arriving by another road.
            Ok(Some((v, files))) => session.messages.push(
                ChatMessage::user(versions::tail_note(v, &files))),
            Ok(None) => {},         // nothing moved, so there is nothing to say
            Err(e)   => {
                web_sys::console::warn_1(&JsValue::from_str(&fmt!(
                    "the files {} changed this turn could not be recorded: {}", id, e)));
                // Told, so the daimon does not report a way back the History does not hold.
                session.messages.push(ChatMessage::user(fmt!(
                    "What this turn changed is on disk as you left it, but it could not be \
                     recorded as a version: {}", e.plain())));
            },
        }
        // THE TAIL NOTE, said once and never twice running: a turn that edited a file or read a
        // worker's report and left `REQUIREMENTS.md` and `STATE.md` exactly as they were is a
        // turn that did work the never-forget file does not yet know about. See
        // `dev/CRYSTAL_CONTRACT.md` §5.2 and [`crate::agent::compact::note_reconcile`].
        if tune.tail_note
            && (!ledger.wrote.is_empty() || !ledger.reported.is_empty())
            && standing_before.requirements == standing_after.requirements
            && standing_before.state == standing_after.state
        {
            crate::agent::compact::note_reconcile(&mut session.messages, prior_tail.as_ref());
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

    /// Apply a confirmed fold (see [`DaimondApp::fold_apply`]).
    async fn fold_apply_inner(&self, id: &str, proposal: &str, delta: &str, note: &str)
        -> Outcome<()>
    {
        let want = res!(Self::proposal_of(proposal));
        // BEFORE THE FOLD REWRITES ANYTHING. The crystal chain takes its own snapshot inside
        // `fold_apply`; what has no chain is whatever the user's own doors changed since the last
        // version, and the fold is about to be the thing that stands between them and it. The
        // dirty set is the whole of it -- the three files below are the fold's own work and are
        // recorded by the version it mints, not by this one -- so a fold that follows no user
        // edit writes no manifest at all.
        let dirty = diamond::drain_dirty(id);
        if !dirty.is_empty() {
            let changes = diamond::dirty_changes(id, dirty).await;
            if let Err(e) = diamond::versions_record(id, Cause::Fold, "", note, changes).await
            {
                web_sys::console::warn_1(&JsValue::from_str(&fmt!(
                    "the state of {} before this fold could not be recorded: {}", id, e)));
            }
        }
        // The three files first, and the crystal last, so the version the snapshot mints is
        // taken with the Diamond in the state the fold left it: `record_steer` and
        // `diamond::fold_apply` both read the store as it stands.
        for (leaf, text) in [
            (crate::tools::REQUIREMENTS_FILE, &want.requirements),
            (crate::tools::DECISIONS_FILE,    &want.decisions),
            (crate::tools::STATE_FILE,        &want.state),
        ] {
            let text = match text {
                Some(t) => t.clone(),
                None    => continue,
            };
            res!(diamond::write_standing(id, leaf, &text).await);
        }
        diamond::fold_apply(id, &want.crystal, delta, note).await
    }

    /// The envelope [`DaimondApp::fold_propose`] answers with, read back.
    ///
    /// # Arguments
    /// * `json` - The envelope, exactly as it was handed out.
    fn proposal_of(json: &str) -> Outcome<crate::agent::compact::FoldProposal> {
        let cfg = crate::agent::compact::json_cfg();
        let map = match Dat::decode_string_with_config(json.trim(), &cfg) {
            Ok(Dat::Map(m)) => m,
            _ => return Err(err!(
                "A fold is applied from the envelope fold_propose answered with, and this is \
                not one: {}", json.chars().take(80).collect::<String>(); Invalid, Input)),
        };
        let text = |k: &str| -> Option<String> {
            match map.get(&Dat::Str(fmt!("{}", k))) {
                Some(Dat::Str(t)) if !t.trim().is_empty() => Some(t.clone()),
                _                                         => None,
            }
        };
        let crystal = match text("crystal") {
            Some(c) => c,
            None    => return Err(err!(
                "The fold envelope carries no crystal, so there is nothing to write.";
                Invalid, Input)),
        };
        Ok(crate::agent::compact::FoldProposal {
            crystal,
            requirements: text("requirements"),
            decisions:    text("decisions"),
            state:        text("state"),
        })
    }

    /// The envelope, as JSON, for the page to carry back to [`DaimondApp::fold_apply`].
    fn proposal_json(p: &crate::agent::compact::FoldProposal) -> String {
        let esc = crate::llm::json_escape;
        let mut out = fmt!("{{\"crystal\":\"{}\"", esc(&p.crystal));
        for (k, v) in [
            ("requirements", &p.requirements),
            ("decisions",    &p.decisions),
            ("state",        &p.state),
        ] {
            if let Some(t) = v {
                out.push_str(&fmt!(",\"{}\":\"{}\"", k, esc(t)));
            }
        }
        out.push('}');
        out
    }

    /// Drive the reducer for one delta, returning the whole proposal (see
    /// [`DaimondApp::fold_propose`]).
    ///
    /// **Two rounds at most.**  The first is the fold.  If what came back would destroy something
    /// no later turn can recover -- a populated crystal key, every hot flag, a ticked task, a
    /// line of the append-only decisions -- the reducer is asked again with the loss named, and
    /// a second such answer is refused outright.  Nothing is written by either round.
    async fn fold_propose_inner(&self, id: &str, delta: &str) -> Outcome<String> {
        let crystal = res!(diamond::read_crystal_data(id).await);
        // The three files ride with the crystal, because the reducer is now asked to rewrite
        // them too and a model cannot rewrite a file it has not been shown. Read once, before
        // either round, so the two rounds fold the same delta into the same state.
        let files = diamond::read_standing(id).await;
        let mut want = res!(self.reduce_round(id, delta, &crystal, &files, "").await);
        let lost = crate::agent::compact::fold_losses(&crystal, &files, &want);
        if !lost.is_empty() {
            // ONE RETRY, AND ONLY ONE. A reducer that destroys the record twice in a row is
            // not going to be talked round by a third sentence, and the user is waiting.
            crate::wasm::entry::trail("FOLD WOULD DESTROY",
                &fmt!("{} — {}", id, lost.join("; ")));
            let again = res!(self.reduce_round(id, delta, &crystal, &files,
                &Self::loss_note(&lost)).await);
            let still = crate::agent::compact::fold_losses(&crystal, &files, &again);
            if !still.is_empty() {
                return Err(err!(
                    "This fold would delete what nothing can put back, and the reducer did it \
                    again when told: {}. The crystal and its files are unchanged. Steer the \
                    Diamond instead, or fold a smaller delta.",
                    still.join("; "); Invalid, Data));
            }
            want = again;
        }
        Ok(Self::proposal_json(&want))
    }

    /// What the reducer is told it dropped, in the words it can act on.
    ///
    /// # Arguments
    /// * `lost` - What [`crate::agent::compact::fold_losses`] named.
    fn loss_note(lost: &[String]) -> String {
        fmt!(
            "\n\n---\nYour last answer DELETED things that must be carried through, and it was \
            not accepted:\n\n{}\n\nWrite the whole answer again, with every one of those kept \
            exactly as it stands above. A ticked task and a decision line are records of \
            something that already happened; you cannot know what they knew.",
            lost.iter().map(|l| fmt!("- {}\n", l)).collect::<String>())
    }

    /// One reducer round: the crystal, the three files and the delta in, a parsed proposal out.
    ///
    /// # Arguments
    /// * `id` - The Diamond, for the session's own name.
    /// * `delta` - What is being folded in.
    /// * `crystal` - The crystal as it stands on disk.
    /// * `files` - The three files as they stand on disk.
    /// * `tail` - Appended to the user message; the loss note on the second round, empty on the
    ///   first.
    async fn reduce_round(
        &self,
        id:      &str,
        delta:   &str,
        crystal: &str,
        files:   &crate::tools::Standing,
        tail:    &str,
    )
        -> Outcome<crate::agent::compact::FoldProposal>
    {
        let standing = |leaf: &str, text: &str| -> String {
            if text.trim().is_empty() {
                return String::new();
            }
            fmt!("\n\n---\nCurrent {}:\n{}", leaf, text.trim_end())
        };
        let user_msg = fmt!(
            "Current crystal.json:\n{}{}{}{}\n\n---\nDelta to fold in:\n{}{}",
            crystal,
            standing(crate::tools::REQUIREMENTS_FILE, &files.requirements),
            standing(crate::tools::DECISIONS_FILE,    &files.decisions),
            standing(crate::tools::STATE_FILE,        &files.state),
            delta,
            tail,
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
            keeper:      String::new(),
            unconfirmed: Vec::new(),
            by_model:    false,
            restoring:   0,
        };
        let registry = ToolRegistry::new(Vec::new(), ctx);
        let reducer = Role::Reducer.compose(&self.reducer_prompt.borrow());
        // Its own stop, reached by `abort` and by no other turn's.
        let agent = Agent::new(self.agent.llm.with_halt(Halt::new()),
            &self.with_instructions(&reducer));
        let _running = self.hold_turn(String::new(), agent.llm.halt());
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
        // `fold_proposal` splits the reply at the file headings first and puts the part before
        // them through exactly that check, so a reply with no headings in it is the old reply
        // parsed the old way. A block that arrived EMPTY leaves its file alone rather than
        // emptying it, which is the same rule at a second door.
        crate::agent::compact::fold_proposal(&out)
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
    // NOTHING IN EITHER STORE, so the one this build carries -- and only now.
    //
    // `/handover` and `/pickup` are the pair that decides whether a day's work survives the
    // tab, and a fresh workspace held neither: the first thing anybody had to do before they
    // could carry work on was write the file that carries it on.  `resolve_skill` is the
    // precedence, named and tested natively rather than left as the order of two branches in
    // here, because the ordering IS the behaviour and nothing native could see it -- a user's
    // own `.daimond/skills/pickup.md` wins, and this is reached only when there is none.
    if let Some((path, text)) = crate::skills::resolve_skill(&cmd.name, None) {
        let sk = crate::skills::parse_skill(&text, &cmd.name);
        return Opened::Send(
            crate::skills::compose_command(&sk.name, &path, &sk.body, &cmd.args));
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
        AgentEvent::Thinking(text) => {
            set("type", &JsValue::from_str("thinking"));
            set("content", &JsValue::from_str(text));
        }
        AgentEvent::Ended { how, offered, rounds, calls, refused, failed, missing, malformed, reasoned } => {
            set("type",      &JsValue::from_str("ended"));
            set("how",       &JsValue::from_str(how));
            set("offered",   &JsValue::from_f64(*offered   as f64));
            set("rounds",    &JsValue::from_f64(*rounds    as f64));
            set("calls",     &JsValue::from_f64(*calls     as f64));
            set("refused",   &JsValue::from_f64(*refused   as f64));
            set("failed",    &JsValue::from_f64(*failed    as f64));
            set("malformed", &JsValue::from_f64(*malformed as f64));
            set("reasoned",  &JsValue::from_f64(*reasoned  as f64));
            let arr = js_sys::Array::new();
            for p in missing { arr.push(&JsValue::from_str(p)); }
            set("missing", &arr);
        }
        AgentEvent::Leaked { fragment, recovered } => {
            set("type",      &JsValue::from_str("leaked"));
            set("fragment",  &JsValue::from_str(fragment));
            set("recovered", &JsValue::from_bool(*recovered));
        }
        AgentEvent::ToolCall { id, name, args } => {
            set("type", &JsValue::from_str("tool_call"));
            set("id",   &JsValue::from_str(id));
            set("name", &JsValue::from_str(name));
            set("args", &JsValue::from_str(args));
        }
        AgentEvent::ToolResult { name, result, outcome, class, paused } => {
            set("type", &JsValue::from_str("tool_result"));
            set("name", &JsValue::from_str(name));
            set("content", &JsValue::from_str(result));
            // Passed through, never recomputed. `src/agent.rs` set it from `call_outcome` at the
            // one place the event is built; this encoder only spells it.
            set("outcome", &JsValue::from_str(outcome.wire()));
            // A destructive call's path class, a JSON object carrying no path; absent otherwise.
            if !class.is_empty() {
                set("class", &JsValue::from_str(class));
            }
            // The pause node that refused it, absent otherwise; see `crate::tools::PAUSE_MARK`.
            if !paused.is_empty() {
                set("paused", &JsValue::from_str(paused));
            }
        }
        AgentEvent::Interjected(text) => {
            set("type", &JsValue::from_str("interjected"));
            set("content", &JsValue::from_str(text));
        }
        AgentEvent::Compacted { folded, kept, note, structured } => {
            set("type", &JsValue::from_str("compacted"));
            set("folded", &JsValue::from_f64(*folded as f64));
            set("kept", &JsValue::from_f64(*kept as f64));
            set("content", &JsValue::from_str(note));
            // WHICH SHAPE THE NOTE CAME BACK IN, so the feed can carry it and the bank can
            // count it. A structured fold that quietly stopped parsing would otherwise show as
            // an ordinary fold for ever, which is the reading the measurement most needs.
            set("shape", &JsValue::from_str(if *structured { "structured" } else { "prose" }));
        }
        AgentEvent::Unseeable { images, model } => {
            set("type", &JsValue::from_str("unseeable"));
            set("images", &JsValue::from_f64(*images as f64));
            set("model", &JsValue::from_str(model));
        }
        AgentEvent::Roading { name, attempt, of, wait_ms } => {
            set("type",    &JsValue::from_str("roading"));
            set("name",    &JsValue::from_str(name));
            set("attempt", &JsValue::from_f64(*attempt as f64));
            set("of",      &JsValue::from_f64(*of      as f64));
            set("wait_ms", &JsValue::from_f64(*wait_ms as f64));
        }
        AgentEvent::Truncated => {
            set("type", &JsValue::from_str("truncated"));
        }
        AgentEvent::RoundMeta { gen_id, finish_reason, native_finish_reason, provider, stalled } => {
            set("type",     &JsValue::from_str("round_meta"));
            set("gen",      &JsValue::from_str(gen_id));
            set("finish",   &JsValue::from_str(finish_reason));
            set("nfinish",  &JsValue::from_str(native_finish_reason));
            set("provider", &JsValue::from_str(provider));
            set("stalled",  &JsValue::from_bool(*stalled));
        }
        AgentEvent::Continued { n, rounds_so_far } => {
            set("type",   &JsValue::from_str("continued"));
            set("n",      &JsValue::from_f64(*n as f64));
            set("rounds", &JsValue::from_f64(*rounds_so_far as f64));
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
