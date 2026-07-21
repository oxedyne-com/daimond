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
use crate::protocol::{AgentEvent, ChatMessage, Session, generate_session_id};
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
    /// conductor's and the reducer's are built here, so they read it from this.
    instructions: RefCell<String>,
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
            instructions: RefCell::new(String::new()),
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

    /// Whether this app's turn has taken in content from outside the user — a fetched page, a
    /// mail message, a command's output.
    ///
    /// The conductor reads this after a steering turn to find out whether the tasks it is about to
    /// hand out derive from a stranger's words.
    pub fn is_tainted(&self) -> bool {
        self.registry.ctx.is_tainted()
    }

    /// Mark this app's turn as carrying content from outside the user, without reading any.
    ///
    /// One-way, like the flag itself.  A worker starts with a clean flag, so instructions absorbed
    /// from a stranger could be laundered through a worker that does not know it is carrying them;
    /// the conductor closes that by setting this on each worker it starts.
    pub fn set_tainted(&self) {
        self.registry.ctx.set_tainted();
    }

    /// Set the user's standing instructions — the contents of their `DAIMOND.md`.
    ///
    /// A dispatched agent starts from nothing: it cannot see the conversation
    /// that dispatched it, so without this it knows neither the house rules nor
    /// what the work is for, and begins from zero every time.
    pub fn set_instructions(&self, md: String) {
        *self.instructions.borrow_mut() = md;
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
    ///
    /// The token counters are restored alongside the messages because
    /// the caller meters a turn by the growth of the cumulative count;
    /// against a counter that restarted at zero the first turn after a
    /// reload prices as free and the running total jumps backwards.
    pub fn restore(
        &self,
        msgs:               js_sys::Array,
        prompt_tokens:      f64,
        completion_tokens:  f64,
        last_prompt_tokens: f64,
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
                "user"      => session.messages.push(ChatMessage::User { content }),
                "assistant" => session.messages.push(ChatMessage::Assistant {
                    content,
                    tool_calls: Vec::new(),
                }),
                _ => continue,
            }
        }
        session.prompt_tokens      = prompt_tokens      as u64;
        session.completion_tokens  = completion_tokens  as u64;
        session.last_prompt_tokens = last_prompt_tokens as u64;
    }

    /// Invoke a single tool directly by wire name with a raw-JSON argument
    /// object, returning its result text — the same path the agent loop
    /// takes, without an LLM turn.  This backs UI affordances such as a
    /// file-browser panel (list/read/delete) that act on OPFS directly.
    /// Tool errors are returned as `Error: …` text (never a rejection), so
    /// the browser can surface them inline.
    pub async fn run_tool(&self, name: String, args_json: String) -> String {
        self.registry.dispatch(&name, &args_json).await
    }

    // ── Diamond / crystal / fold surface ─────────────────────────────────

    /// Create a Diamond named `name`, returning its id.  Creates the Diamond
    /// directory, an empty `crystal.md`, version `0`, a `meta.json`, and a
    /// `create` log record.
    pub async fn create_diamond(&self, name: String) -> Result<String, JsValue> {
        diamond::create(&name).await.map_err(to_js_err)
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

    /// Remove a link from a Diamond's sidecar.  True when one went.
    pub async fn remove_link(&self, owner: String, link_id: String) -> Result<bool, JsValue> {
        diamond::remove_link(&owner, &link_id).await.map_err(to_js_err)
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

    /// Delete a Diamond and all its stored state.
    pub async fn delete_diamond(&self, id: String) -> Result<(), JsValue> {
        diamond::delete(&id).await.map_err(to_js_err)
    }

    /// Read a Diamond's current crystal markdown.
    pub async fn read_crystal(&self, id: String) -> Result<String, JsValue> {
        diamond::read_crystal(&id).await.map_err(to_js_err)
    }

    /// Apply a user hand-edit to a Diamond's crystal: snapshots a new version
    /// and logs an `edit` record.
    pub async fn write_crystal(&self, id: String, md: String) -> Result<(), JsValue> {
        diamond::write_crystal(&id, &md).await.map_err(to_js_err)
    }

    /// Read a Diamond's append-only log as a JSON array of records.
    pub async fn log_read(&self, id: String) -> Result<String, JsValue> {
        diamond::log_read(&id).await.map_err(to_js_err)
    }

    /// Read the crystal as it stood at `version`, so a past state can be shown
    /// and, if the user wants it back, written to the head with
    /// [`DaimondApp::write_crystal`].
    pub async fn read_version(&self, id: String, version: f64) -> Result<String, JsValue> {
        diamond::read_version(&id, version as u64).await.map_err(to_js_err)
    }

    /// Steer a Diamond's crystal: run one crystal-agent turn for `instruction`,
    /// streaming [`AgentEvent`]s to `on_event`.  The agent's file tools
    /// are scoped to `diamonds/<id>/`, so `file_read` / `file_write` on
    /// `crystal.md` address the Diamond's crystal; it is stateless per
    /// instruction, reconstructing context from the current crystal passed
    /// in its system prompt.  When the turn leaves `crystal.md` changed, a
    /// new version is snapshotted and an `edit` record logged.
    pub async fn steer_crystal(
        &self,
        id:          String,
        instruction: String,
        on_event:    js_sys::Function,
    )
        -> Result<(), JsValue>
    {
        self.steer_inner(&id, instruction, on_event).await.map_err(to_js_err)
    }

    /// Propose a fold: run a fresh reducer over the current crystal plus one
    /// `delta`, returning the PROPOSED new crystal markdown.  Writes
    /// nothing — the advisory half of the fold (H2); the delta is applied
    /// only on explicit confirm via [`DaimondApp::fold_apply`].
    pub async fn fold_propose(&self, id: String, delta: String) -> Result<String, JsValue> {
        self.fold_propose_inner(&id, &delta).await.map_err(to_js_err)
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
}

/// Inner helpers for the crystal and reducer turns.  Kept in a plain
/// `impl` (not `#[wasm_bindgen]`) so they can take Rust-only types and
/// return [`Outcome`], using the error macros throughout; the exported
/// wrappers above map the result to the JS boundary.
impl DaimondApp {

    /// Drive the crystal agent for one instruction (see
    /// [`DaimondApp::steer_crystal`]).
    async fn steer_inner(
        &self,
        id:          &str,
        instruction: String,
        on_event:    js_sys::Function,
    )
        -> Outcome<()>
    {
        // Stateless per instruction: reconstruct context from the crystal.
        let before = diamond::read_crystal(id).await.unwrap_or_default();
        let mut system = diamond::CRYSTAL_AGENT_PROMPT.to_string();
        system.push_str("\n\nCurrent crystal.md:\n");
        system.push_str(&before);

        // File tools scoped to this Diamond's directory.
        let ctx = ToolContext {
            workspace:   Workspace::unchecked(PathBuf::from("/")),
            executor:    Executor::Wasm,
            cwd:         String::new(),
            path_prefix: diamond::diamond_dir(id),
            // Daimond's own crystal lives in the OPFS sandbox, never the user's
            // real folder, so the crystal agent pins the OPFS root.
            root:        crate::tools::FileRoot::Opfs,
            // Shared with this app's own context, not fresh: a steering turn is stateless per
            // instruction, so a fresh cache would drop the taint the moment the turn ended and
            // `is_tainted` would answer no to the very question the conductor asks it.
            read_seen:   self.registry.ctx.read_seen.clone(),
            // The browser agent is the user's own, not a skill's, so nothing is locked out of it.
            // A skill turn narrows this in the handler, where the declaration is known.
            no_write:    Vec::new(),
        };
        let registry = ToolRegistry::new(
            vec![
                Tool::FileRead,
                Tool::FileWrite,
                Tool::FileEdit,
                Tool::FileList,
                Tool::FileSearch,
                Tool::FileDelete,
                Tool::FileMove,
                Tool::DirCreate,
                // The conductor commands agents; the workers do the work.
                Tool::SpawnAgent,
            ],
            ctx,
        );
        let agent = Agent::new(self.agent.llm.clone(), &self.with_instructions(&system));
        let mut session = Session::new(
            generate_session_id(),
            fmt!("crystal:{}", id),
            self.session.borrow().model.clone(),
        );
        let mut sink = |ev: AgentEvent| {
            let js = event_to_js(&ev);
            let _ = on_event.call1(&JsValue::NULL, &js);
        };
        res!(agent.run_turn(&mut session, instruction.clone(), &registry, &mut sink).await);
        self.absorb_usage(&session);

        // If the crystal changed, snapshot a version and log the edit so
        // every crystal mutation stays versioned and auditable.
        let after = diamond::read_crystal(id).await.unwrap_or_default();
        if after != before {
            res!(diamond::record_steer(id, &after, &instruction).await);
        }
        Ok(())
    }

    /// Drive the reducer for one delta, returning the proposed crystal (see
    /// [`DaimondApp::fold_propose`]).
    async fn fold_propose_inner(&self, id: &str, delta: &str) -> Outcome<String> {
        let crystal = res!(diamond::read_crystal(id).await);
        let user_msg = fmt!(
            "Current crystal:\n{}\n\n---\nDelta to fold in:\n{}",
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
        };
        let registry = ToolRegistry::new(Vec::new(), ctx);
        let agent = Agent::new(self.agent.llm.clone(), &self.with_instructions(diamond::REDUCER_PROMPT));
        let mut session = Session::new(
            generate_session_id(),
            fmt!("reducer:{}", id),
            self.session.borrow().model.clone(),
        );
        let mut out = String::new();
        {
            let mut sink = |ev: AgentEvent| {
                if let AgentEvent::Text(t) = &ev {
                    out.push_str(t);
                }
            };
            res!(agent.run_turn(&mut session, user_msg, &registry, &mut sink).await);
        }
        self.absorb_usage(&session);
        Ok(out)
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
        AgentEvent::ToolCall { name, args } => {
            set("type", &JsValue::from_str("tool_call"));
            set("name", &JsValue::from_str(name));
            set("args", &JsValue::from_str(args));
        }
        AgentEvent::ToolResult { name, result } => {
            set("type", &JsValue::from_str("tool_result"));
            set("name", &JsValue::from_str(name));
            set("content", &JsValue::from_str(result));
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
