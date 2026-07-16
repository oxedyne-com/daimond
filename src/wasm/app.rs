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
use crate::llm::LlmClient;
use crate::protocol::{AgentEvent, ChatMessage, Session, generate_session_id};
use crate::tools::{Tool, ToolContext, ToolRegistry};
use crate::executor::Executor;
use crate::workspace::Workspace;
use crate::wasm::{focus, js_prop, to_js_err};

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
    /// The Focus surface (steer, fold) runs each turn in its own throwaway
    /// [`Session`], so its usage never reached [`DaimondApp::prompt_tokens`] and the
    /// browser could not bill it: steering a Focus twenty times showed nothing
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

    // ── Focus / brief / fold surface ─────────────────────────────────

    /// Create a Focus named `name`, returning its id.  Creates the Focus
    /// directory, an empty `brief.md`, version `0`, a `meta.json`, and a
    /// `create` log record.
    pub async fn create_focus(&self, name: String) -> Result<String, JsValue> {
        focus::create(&name).await.map_err(to_js_err)
    }

    /// List every Focus as a JSON array of
    /// `{ id, name, brief_version, updated }`, most-recently updated first.
    pub async fn list_foci(&self) -> Result<String, JsValue> {
        focus::list().await.map_err(to_js_err)
    }

    /// Rename a Focus.
    pub async fn rename_focus(&self, id: String, name: String) -> Result<(), JsValue> {
        focus::rename(&id, &name).await.map_err(to_js_err)
    }

    /// Delete a Focus and all its stored state.
    pub async fn delete_focus(&self, id: String) -> Result<(), JsValue> {
        focus::delete(&id).await.map_err(to_js_err)
    }

    /// Read a Focus's current brief markdown.
    pub async fn read_brief(&self, id: String) -> Result<String, JsValue> {
        focus::read_brief(&id).await.map_err(to_js_err)
    }

    /// Apply a user hand-edit to a Focus's brief: snapshots a new version
    /// and logs an `edit` record.
    pub async fn write_brief(&self, id: String, md: String) -> Result<(), JsValue> {
        focus::write_brief(&id, &md).await.map_err(to_js_err)
    }

    /// Read a Focus's append-only log as a JSON array of records.
    pub async fn log_read(&self, id: String) -> Result<String, JsValue> {
        focus::log_read(&id).await.map_err(to_js_err)
    }

    /// Read the brief as it stood at `version`, so a past state can be shown
    /// and, if the user wants it back, written to the head with
    /// [`DaimondApp::write_brief`].
    pub async fn read_version(&self, id: String, version: f64) -> Result<String, JsValue> {
        focus::read_version(&id, version as u64).await.map_err(to_js_err)
    }

    /// Steer a Focus's brief: run one brief-agent turn for `instruction`,
    /// streaming [`AgentEvent`]s to `on_event`.  The agent's file tools
    /// are scoped to `foci/<id>/`, so `file_read` / `file_write` on
    /// `brief.md` address the Focus's brief; it is stateless per
    /// instruction, reconstructing context from the current brief passed
    /// in its system prompt.  When the turn leaves `brief.md` changed, a
    /// new version is snapshotted and an `edit` record logged.
    pub async fn steer_brief(
        &self,
        id:          String,
        instruction: String,
        on_event:    js_sys::Function,
    )
        -> Result<(), JsValue>
    {
        self.steer_inner(&id, instruction, on_event).await.map_err(to_js_err)
    }

    /// Propose a fold: run a fresh reducer over the current brief plus one
    /// `delta`, returning the PROPOSED new brief markdown.  Writes
    /// nothing — the advisory half of the fold (H2); the delta is applied
    /// only on explicit confirm via [`DaimondApp::fold_apply`].
    pub async fn fold_propose(&self, id: String, delta: String) -> Result<String, JsValue> {
        self.fold_propose_inner(&id, &delta).await.map_err(to_js_err)
    }

    /// Apply a confirmed fold: write the accepted `new_brief`, snapshot a
    /// version, retain the raw `delta` under `.daimond/deltas/`, and append a
    /// `fold` record referencing it.  Called only after the user accepts
    /// the proposed diff, so a fold never auto-applies and never discards
    /// the raw delta.
    pub async fn fold_apply(
        &self,
        id:        String,
        new_brief: String,
        delta:     String,
        note:      String,
    )
        -> Result<(), JsValue>
    {
        focus::fold_apply(&id, &new_brief, &delta, &note).await.map_err(to_js_err)
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
}

/// Inner helpers for the brief and reducer turns.  Kept in a plain
/// `impl` (not `#[wasm_bindgen]`) so they can take Rust-only types and
/// return [`Outcome`], using the error macros throughout; the exported
/// wrappers above map the result to the JS boundary.
impl DaimondApp {

    /// Drive the brief agent for one instruction (see
    /// [`DaimondApp::steer_brief`]).
    async fn steer_inner(
        &self,
        id:          &str,
        instruction: String,
        on_event:    js_sys::Function,
    )
        -> Outcome<()>
    {
        // Stateless per instruction: reconstruct context from the brief.
        let before = focus::read_brief(id).await.unwrap_or_default();
        let mut system = focus::BRIEF_AGENT_PROMPT.to_string();
        system.push_str("\n\nCurrent brief.md:\n");
        system.push_str(&before);

        // File tools scoped to this Focus's directory.
        let ctx = ToolContext {
            workspace:   Workspace::unchecked(PathBuf::from("/")),
            executor:    Executor::Wasm,
            cwd:         String::new(),
            path_prefix: focus::focus_dir(id),
            // Daimond's own brief lives in the OPFS sandbox, never the user's
            // real folder, so the brief agent pins the OPFS root.
            root:        crate::tools::FileRoot::Opfs,
            read_seen:   crate::tools::new_read_cache(),
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
            fmt!("brief:{}", id),
            self.session.borrow().model.clone(),
        );
        let mut sink = |ev: AgentEvent| {
            let js = event_to_js(&ev);
            let _ = on_event.call1(&JsValue::NULL, &js);
        };
        res!(agent.run_turn(&mut session, instruction.clone(), &registry, &mut sink).await);
        self.absorb_usage(&session);

        // If the brief changed, snapshot a version and log the edit so
        // every brief mutation stays versioned and auditable.
        let after = focus::read_brief(id).await.unwrap_or_default();
        if after != before {
            res!(focus::record_steer(id, &after, &instruction).await);
        }
        Ok(())
    }

    /// Drive the reducer for one delta, returning the proposed brief (see
    /// [`DaimondApp::fold_propose`]).
    async fn fold_propose_inner(&self, id: &str, delta: &str) -> Outcome<String> {
        let brief = res!(focus::read_brief(id).await);
        let user_msg = fmt!(
            "Current brief:\n{}\n\n---\nDelta to fold in:\n{}",
            brief, delta,
        );
        // The reducer only emits text — no tools, so it cannot write.
        let ctx = ToolContext {
            workspace:   Workspace::unchecked(PathBuf::from("/")),
            executor:    Executor::Wasm,
            cwd:         String::new(),
            path_prefix: String::new(),
            // The reducer is tool-less; pin OPFS for consistency with the
            // other Focus contexts.
            root:        crate::tools::FileRoot::Opfs,
            read_seen:   crate::tools::new_read_cache(),
            // The browser agent is the user's own, not a skill's, so nothing is locked out of it.
            // A skill turn narrows this in the handler, where the declaration is known.
            no_write:    Vec::new(),
        };
        let registry = ToolRegistry::new(Vec::new(), ctx);
        let agent = Agent::new(self.agent.llm.clone(), &self.with_instructions(focus::REDUCER_PROMPT));
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
