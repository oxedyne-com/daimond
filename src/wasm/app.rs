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
        // What this turn can reach, refreshed now rather than at construction: the fence
        // depends on the Diamond's bounds and on whether the turn is tainted, and asking the
        // hand needs an await the constructor does not have. Empty when no hand is attached,
        // and then nothing is added to the prompt at all.
        let brief = crate::prompts::machine_briefing(
            &self.registry.ctx.no_write, self.registry.ctx.is_tainted()).await;
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
        let paths = |src: &str| -> Vec<String> {
            let mut out = Vec::new();
            // A small reader rather than a JSON dependency: the input is an array of plain strings
            // written by our own caller, and the failure mode that matters is "read nothing", not
            // "read something wrong".
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
        };
        let mut bounds = crate::tools::diamond_bounds(
            &own_dir, &paths(&attached), &paths(&read_only));
        // Appended, never merged in earlier: a toolkit widens what a COMMAND may touch and nothing
        // else, and composing it here rather than inside `diamond_bounds` keeps the scope and the
        // grant visible as two separate decisions in the one expression.
        bounds.extend(crate::tools::toolkit_bounds(&paths(&toolkits)));
        self.registry.ctx.no_write = bounds;
    }

    /// What this agent is actually confined to, as the engine holds it.
    ///
    /// Exists so that [`DaimondApp::set_diamond_scope`] can be checked rather than assumed.  A
    /// scope that was asked for and did not take leaves an agent with the reach of an ordinary
    /// workspace turn -- fenced to the whole granted folder rather than to one Diamond -- and a
    /// caller that read success from the absence of an exception would never find out.  Failing
    /// open is the one way this can go wrong that matters, so the browser sets the scope, reads it
    /// back here, and refuses to run a turn on a disagreement.
    ///
    /// Returns a compact JSON object:
    ///
    /// ```text
    /// {"allow":["diamonds/d1","notes"],"no_write":[".daimond/"],"toolkits":["rust"],"nowhere":false}
    /// ```
    ///
    /// `allow` is the allow-list as [`crate::tools::Bound::OnlyUnder`] holds it, normalised -- so a
    /// path the caller spelled `./notes/` comes back as `notes`, which is what the comparison must
    /// be made against.  `nowhere` is the scope that named no usable place at all: it is not an
    /// error, it is a turn that may touch nothing, and it has to be tellable apart from an unscoped
    /// turn, whose `allow` is also empty.
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
        fmt!(
            "{{\"allow\":{},\"no_write\":{},\"toolkits\":{},\"nowhere\":{}}}",
            quoted(allow),
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
    /// Only `daimon` and `reducer` are held here — a chat and a worker are
    /// constructed with their prompt already composed (see the field docs). An
    /// empty `text` means "use the default", which is how deleting the file puts
    /// the shipped prompt back.
    ///
    /// # Arguments
    /// * `role` - The role's name: `daimon` or `reducer`.
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
            "user"      => session.messages.push(ChatMessage::User { content }),
            "assistant" => session.messages.push(ChatMessage::Assistant {
                content,
                tool_calls: Vec::new(),
            }),
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

    /// Fold this agent's conversations with a different model from the one it chats
    /// with; empty means the chat's own.
    ///
    /// # Arguments
    /// * `model` - The provider's id for the folding model, or empty.
    pub fn set_fold_model(&self, model: String) {
        self.agent.set_fold_model(&model);
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

    /// Every link in the store, as a JSON array.
    ///
    /// The whole graph in one read, for a view that draws all of it at once:
    /// each entry carries the Diamond whose sidecar holds the record, and both
    /// ends as `kind:rest` references, so nothing has to be asked for twice.
    pub async fn all_links(&self) -> Result<String, JsValue> {
        diamond::all_links().await.map_err(to_js_err)
    }

    /// Export a whole Diamond as JSON: `{"id":..,"files":{"<path>":"<content>",..}}`.
    ///
    /// Every file under `diamonds/<id>/` travels, so a Diamond carried to another
    /// device arrives whole -- crystal, versions, log, deltas, tags and links --
    /// and a per-Diamond file added later needs nothing to learn its name.
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
        let mut system = Role::Daimon.compose(&self.daimon_prompt.borrow());
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
            // `is_tainted` would answer no to the very question the daimon asks it.
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
                Tool::FileGlob,
                Tool::FileDelete,
                Tool::FileMove,
                Tool::DirCreate,
                // The daimon commands agents; the workers do the work.
                Tool::SpawnAgent,
            ],
            ctx,
        );
        let agent = Agent::new(self.agent.llm.clone(), &self.with_instructions(&system));
        // A fresh agent starts from the default limits, so without this a Diamond's
        // daimon would fold the same model's conversation at a different size from
        // the chat that dispatched it.
        agent.adopt_limits(&self.agent);
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
        if out.trim().is_empty() {
            return Err(err!(
                "The reducer returned an empty proposal, so there is nothing to fold in. \
                A fold never empties a crystal; try again, or steer the Diamond instead.";
                Invalid, Data));
        }
        Ok(out)
    }
}

/// Convert a [`ChatMessage`] to a plain JS object mirroring
/// [`ChatMessage::to_datmap`], so the browser can store the conversation the
/// model holds without inventing a second shape for it.
fn message_to_js(msg: &ChatMessage) -> JsValue {
    let obj = js_sys::Object::new();
    let set = |k: &str, v: &JsValue| {
        // `Reflect::set` on a fresh object cannot fail; ignore the result.
        let _ = js_sys::Reflect::set(&obj, &JsValue::from_str(k), v);
    };
    match msg {
        ChatMessage::System { content } => {
            set("role", &JsValue::from_str("system"));
            set("content", &JsValue::from_str(content));
        }
        ChatMessage::User { content } => {
            set("role", &JsValue::from_str("user"));
            set("content", &JsValue::from_str(content));
        }
        ChatMessage::Assistant { content, tool_calls } => {
            set("role", &JsValue::from_str("assistant"));
            set("content", &JsValue::from_str(content));
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
            set("content", &JsValue::from_str(content));
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
        "system" => Some(ChatMessage::System { content }),
        "user"   => Some(ChatMessage::User { content }),
        "tool"   => match js_prop(item, "tool_call_id") {
            Some(id) if !id.is_empty() => Some(ChatMessage::Tool { tool_call_id: id, content }),
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
            Some(ChatMessage::Assistant { content, tool_calls })
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
