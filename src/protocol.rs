//! WS protocol types for Daimond — JDAT serialisation.
//!
//! All messages between the browser and Steel use the existing syntax
//! protocol with JDAT values.  This module defines the command and
//! response types and their JDAT conversion functions.

use oxedyne_fe2o3_core::prelude::*;
use oxedyne_fe2o3_jdat::prelude::*;


// ┌───────────────────────────────────────────────────────────────┐
// │ Wall-clock helpers                                             │
// └───────────────────────────────────────────────────────────────┘

/// Current Unix time in whole seconds.
///
/// The native path reads `std::time::SystemTime`; on `wasm32` that
/// panics ("time not implemented on this platform"), so the browser
/// path reads the core `Date.now()` clock shim instead.
#[cfg(not(target_arch = "wasm32"))]
fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Current Unix time in whole seconds (browser clock shim).
#[cfg(target_arch = "wasm32")]
fn now_secs() -> u64 {
    (oxedyne_fe2o3_core::wasm::now_ms() / 1000.0) as u64
}

/// Current Unix time in whole milliseconds.
#[cfg(not(target_arch = "wasm32"))]
fn now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Current Unix time in whole milliseconds (browser clock shim).
#[cfg(target_arch = "wasm32")]
fn now_millis() -> u128 {
    oxedyne_fe2o3_core::wasm::now_ms() as u128
}


// ┌───────────────────────────────────────────────────────────────┐
// │ Chat messages                                                  │
// └───────────────────────────────────────────────────────────────┘

/// A single tool call requested by the assistant.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToolCall {
    pub id:        String,
    pub name:      String,
    /// Raw JSON arguments object as produced by the model.
    pub arguments: String,
}

impl ToolCall {

    /// Serialise to a JDAT map for the session store.
    ///
    /// Flat, rather than the provider's `{"type":"function","function":{..}}` nesting:
    /// this is Daimond's own record of what was asked for, and the wire form is built
    /// separately by `llm::message_to_json` in whichever dialect the endpoint speaks.
    pub fn to_datmap(&self) -> DaticleMap {
        let mut m = DaticleMap::new();
        m.insert(dat!("id"), dat!(self.id.clone()));
        m.insert(dat!("name"), dat!(self.name.clone()));
        m.insert(dat!("arguments"), dat!(self.arguments.clone()));
        m
    }

    /// Deserialise from a JDAT map.
    ///
    /// The id is required, because it is what pairs the call with its reply and a call
    /// that cannot be paired is worse than one that was never read.  The other two are
    /// tolerated absent, since an empty argument object is a legal call.
    pub fn from_datmap(m: &DaticleMap) -> Outcome<Self> {
        let id = match m.get(&dat!("id")) {
            Some(Dat::Str(s)) => s.clone(),
            _ => return Err(err!("ToolCall: missing 'id'."; Invalid, Input)),
        };
        let name = match m.get(&dat!("name")) {
            Some(Dat::Str(s)) => s.clone(),
            _ => String::new(),
        };
        let arguments = match m.get(&dat!("arguments")) {
            Some(Dat::Str(s)) => s.clone(),
            _ => String::new(),
        };
        Ok(Self { id, name, arguments })
    }
}

/// A single message in a conversation, mirroring the OpenAI API format.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ChatMessage {
    System { content: String },
    User { content: String },
    /// Assistant turn, with whatever tool calls it asked for.
    ///
    /// The calls are part of the message and are persisted with it.  They used to be
    /// dropped on the way to storage, which made a reloaded session illegal rather than
    /// merely lossy: the assistant turn came back bare and the `tool` replies that
    /// followed it answered nothing, and an OpenAI-compatible provider rejects that
    /// outright on every subsequent turn.
    Assistant { content: String, tool_calls: Vec<ToolCall> },
    /// Tool call result returned to the LLM.
    Tool { tool_call_id: String, content: String },
}

impl ChatMessage {

    /// Serialise to a JDAT map, for the session store and the session export.
    ///
    /// Not the LLM request body: that is built by `llm::message_to_json`, in the
    /// provider's own JSON and in whichever dialect the endpoint speaks.  What this has
    /// to survive is a round trip through storage, which means an assistant turn's tool
    /// calls travel with it -- an assistant message that loses them leaves the `tool`
    /// replies after it answering nothing, and a provider refuses such a conversation
    /// outright.
    ///
    /// Produces maps like:
    ///   { "role": "system", "content": "..." }
    ///   { "role": "user", "content": "..." }
    ///   { "role": "assistant", "content": "..." }
    ///   { "role": "assistant", "content": "...",
    ///     "tool_calls": [ { "id": "...", "name": "...", "arguments": "..." } ] }
    ///   { "role": "tool", "tool_call_id": "...", "content": "..." }
    pub fn to_datmap(&self) -> DaticleMap {
        let mut m = DaticleMap::new();
        match self {
            Self::System { content } => {
                m.insert(dat!("role"), dat!("system"));
                m.insert(dat!("content"), dat!(content.clone()));
            }
            Self::User { content } => {
                m.insert(dat!("role"), dat!("user"));
                m.insert(dat!("content"), dat!(content.clone()));
            }
            Self::Assistant { content, tool_calls } => {
                m.insert(dat!("role"), dat!("assistant"));
                m.insert(dat!("content"), dat!(content.clone()));
                // Written only when there are any, so an ordinary answer's map is the
                // shape it always was and a reader of an older snapshot sees no change.
                if !tool_calls.is_empty() {
                    let calls: Vec<Dat> = tool_calls.iter()
                        .map(|tc| Dat::Map(tc.to_datmap()))
                        .collect();
                    m.insert(dat!("tool_calls"), Dat::List(calls));
                }
            }
            Self::Tool { tool_call_id, content } => {
                m.insert(dat!("role"), dat!("tool"));
                m.insert(dat!("tool_call_id"), dat!(tool_call_id.clone()));
                m.insert(dat!("content"), dat!(content.clone()));
            }
        }
        m
    }

    /// Deserialise from a JDAT map.
    pub fn from_datmap(m: &DaticleMap) -> Outcome<Self> {
        let role = match m.get(&dat!("role")) {
            Some(Dat::Str(s)) => s.clone(),
            _ => return Err(err!("ChatMessage: missing 'role'."; Invalid, Input)),
        };
        let content = match m.get(&dat!("content")) {
            Some(Dat::Str(s)) => s.clone(),
            _ => return Err(err!("ChatMessage: missing 'content'."; Invalid, Input)),
        };
        match role.as_str() {
            "system" => Ok(Self::System { content }),
            "user" => Ok(Self::User { content }),
            "assistant" => {
                // Absent is an assistant turn that asked for nothing, and every snapshot
                // written before the calls were persisted at all.  A malformed entry is
                // skipped rather than refusing the message: half a conversation read back
                // is worth more to the user than an error, and `compact::orphan_count`
                // already treats what is left as the broken pairing it is.
                let mut tool_calls = Vec::new();
                if let Some(Dat::List(list)) = m.get(&dat!("tool_calls")) {
                    for item in list {
                        if let Dat::Map(tc_m) = item {
                            if let Ok(tc) = ToolCall::from_datmap(tc_m) {
                                tool_calls.push(tc);
                            }
                        }
                    }
                }
                Ok(Self::Assistant { content, tool_calls })
            }
            "tool" => {
                let tool_call_id = match m.get(&dat!("tool_call_id")) {
                    Some(Dat::Str(s)) => s.clone(),
                    _ => return Err(err!("ChatMessage: tool missing 'tool_call_id'."; Invalid, Input)),
                };
                Ok(Self::Tool { tool_call_id, content })
            }
            _ => Err(err!("ChatMessage: unknown role '{}'.", role; Invalid, Input)),
        }
    }

    pub fn role(&self) -> &'static str {
        match self {
            Self::System { .. } => "system",
            Self::User { .. } => "user",
            Self::Assistant { .. } => "assistant",
            Self::Tool { .. } => "tool",
        }
    }

    pub fn content(&self) -> &str {
        match self {
            Self::System { content }
            | Self::User { content }
            | Self::Assistant { content, .. }
            | Self::Tool { content, .. } => content,
        }
    }
}


// ┌───────────────────────────────────────────────────────────────┐
// │ Session                                                        │
// └───────────────────────────────────────────────────────────────┘

/// A chat session belonging to a user.
#[derive(Clone, Debug)]
pub struct Session {
    pub id:                  String,
    pub name:                String,
    pub created_at:          u64,
    pub model:               String,
    pub messages:            Vec<ChatMessage>,
    /// Cumulative prompt tokens across all turns (for billing).
    pub prompt_tokens:       u64,
    /// Cumulative completion tokens across all turns (for billing).
    pub completion_tokens:   u64,
    /// Prompt tokens of the most recent request — the current context
    /// window usage (not cumulative), for the live meter.
    pub last_prompt_tokens:  u64,
    /// Cumulative prompt tokens the provider served from its cache, across all
    /// turns.  A subset of `prompt_tokens`, never added to it.
    pub cached_tokens:       u64,
    /// Cumulative USD the provider says these turns actually cost.
    ///
    /// Zero means no provider reported a figure, not that the session was
    /// free; the caller prices those turns from its table instead.
    pub cost_usd:            f64,
}

impl Session {

    pub fn new(id: String, name: String, model: String) -> Self {
        Self {
            id,
            name,
            created_at: now_secs(),
            model,
            messages: Vec::new(),
            prompt_tokens: 0,
            completion_tokens: 0,
            last_prompt_tokens: 0,
            cached_tokens: 0,
            cost_usd: 0.0,
        }
    }

    /// Serialise metadata (without messages) to a JDAT map.
    pub fn to_meta_datmap(&self) -> DaticleMap {
        let mut m = DaticleMap::new();
        m.insert(dat!("id"), dat!(self.id.clone()));
        m.insert(dat!("name"), dat!(self.name.clone()));
        m.insert(dat!("created_at"), Dat::U64(self.created_at));
        m.insert(dat!("model"), dat!(self.model.clone()));
        m.insert(dat!("prompt_tokens"), Dat::U64(self.prompt_tokens));
        m.insert(dat!("completion_tokens"), Dat::U64(self.completion_tokens));
        m.insert(dat!("last_prompt_tokens"), Dat::U64(self.last_prompt_tokens));
        m.insert(dat!("cached_tokens"), Dat::U64(self.cached_tokens));
        m.insert(dat!("cost_usd"), dat!(self.cost_usd));
        m
    }

    /// Serialise full session (with messages) to a JDAT map.
    pub fn to_datmap(&self) -> DaticleMap {
        let mut m = self.to_meta_datmap();
        let msgs: Vec<Dat> = self.messages.iter()
            .map(|msg| Dat::Map(msg.to_datmap()))
            .collect();
        m.insert(dat!("messages"), Dat::List(msgs));
        m
    }

    /// Deserialise from a JDAT map.
    pub fn from_datmap(m: &DaticleMap) -> Outcome<Self> {
        let id = match m.get(&dat!("id")) {
            Some(Dat::Str(s)) => s.clone(),
            _ => return Err(err!("Session: missing 'id'."; Invalid, Input)),
        };
        let name = match m.get(&dat!("name")) {
            Some(Dat::Str(s)) => s.clone(),
            _ => return Err(err!("Session: missing 'name'."; Invalid, Input)),
        };
        let created_at = match m.get(&dat!("created_at")) {
            Some(Dat::U64(n)) => *n,
            _ => 0,
        };
        let model = match m.get(&dat!("model")) {
            Some(Dat::Str(s)) => s.clone(),
            _ => String::new(),
        };
        let messages = match m.get(&dat!("messages")) {
            Some(Dat::List(list)) => {
                let mut msgs = Vec::new();
                for item in list {
                    if let Dat::Map(msg_m) = item {
                        msgs.push(res!(ChatMessage::from_datmap(msg_m)));
                    }
                }
                msgs
            }
            _ => Vec::new(),
        };
        let prompt_tokens = match m.get(&dat!("prompt_tokens")) {
            Some(Dat::U64(n)) => *n,
            _ => 0,
        };
        let completion_tokens = match m.get(&dat!("completion_tokens")) {
            Some(Dat::U64(n)) => *n,
            _ => 0,
        };
        let last_prompt_tokens = match m.get(&dat!("last_prompt_tokens")) {
            Some(Dat::U64(n)) => *n,
            _ => 0,
        };
        // OPTIONAL, and it has to be: a snapshot written before these two fields
        // existed must still load.  Every field here is decoded with a `_ => 0`
        // arm for that reason -- a required field would refuse the user's own
        // history the moment the shape grew, which is how a session store gets
        // bricked by an upgrade.
        let cached_tokens = match m.get(&dat!("cached_tokens")) {
            Some(Dat::U64(n)) => *n,
            _ => 0,
        };
        let cost_usd = match m.get(&dat!("cost_usd")) {
            Some(Dat::F64(f)) => **f,
            _ => 0.0,
        };
        Ok(Self {
            id, name, created_at, model, messages,
            prompt_tokens, completion_tokens, last_prompt_tokens,
            cached_tokens, cost_usd,
        })
    }
}


// ┌───────────────────────────────────────────────────────────────┐
// │ User configuration                                             │
// └───────────────────────────────────────────────────────────────┘

/// Per-user configuration stored in O3db.
///
/// Supports multi-user with individual model selection — the foundation
/// for a future commercial offering with billing.
#[derive(Clone, Debug)]
pub struct UserConfig {
    pub username:       String,
    pub default_model:  String,
    pub created_at:     u64,
}

impl UserConfig {

    pub fn new(username: String, default_model: String) -> Self {
        Self {
            username,
            default_model,
            created_at: now_secs(),
        }
    }

    pub fn to_datmap(&self) -> DaticleMap {
        let mut m = DaticleMap::new();
        m.insert(dat!("username"), dat!(self.username.clone()));
        m.insert(dat!("default_model"), dat!(self.default_model.clone()));
        m.insert(dat!("created_at"), Dat::U64(self.created_at));
        m
    }

    pub fn from_datmap(m: &DaticleMap) -> Outcome<Self> {
        let username = match m.get(&dat!("username")) {
            Some(Dat::Str(s)) => s.clone(),
            _ => return Err(err!("UserConfig: missing 'username'."; Invalid, Input)),
        };
        let default_model = match m.get(&dat!("default_model")) {
            Some(Dat::Str(s)) => s.clone(),
            _ => String::new(),
        };
        let created_at = match m.get(&dat!("created_at")) {
            Some(Dat::U64(n)) => *n,
            _ => 0,
        };
        Ok(Self { username, default_model, created_at })
    }
}


// ┌───────────────────────────────────────────────────────────────┐
// │ Agent events                                                   │
// └───────────────────────────────────────────────────────────────┘

/// Events emitted by the agent loop, sent to the client over WS.
#[derive(Clone, Debug)]
pub enum AgentEvent {
    /// Streamed LLM response text (a token or chunk).
    Text(String),
    /// The agent is invoking a tool (name + raw JSON args).
    ToolCall { name: String, args: String },
    /// A tool returned a result (name + result text).
    ToolResult { name: String, result: String },
    /// The user said something while the turn was running, and it has now been put
    /// into the conversation at the seam between two rounds.
    ///
    /// Emitted so the thread can show WHERE the user cut in. A correction that
    /// appears at the end, after the work it was meant to redirect, reads as though
    /// it was ignored -- and the one thing an interjection must never look like is
    /// something that arrived too late.
    Interjected(String),
    /// The conversation was folded to fit the model's context window.
    ///
    /// Its own variant rather than a line of assistant text: a fold is something the APP
    /// did, it is lossy, and the user is entitled to see it as an act rather than as prose
    /// the model produced.
    Compacted { folded: usize, kept: usize, note: String },
    /// The provider stopped generating because the reply reached the output limit.
    ///
    /// Said outright rather than inferred.  A tool call cut at the limit arrives as
    /// malformed JSON, so the browser had to guess truncation from arguments that would
    /// not parse -- a guess that is right in practice and cannot see a plain text reply
    /// cut short, which is the case with no other symptom at all.
    ///
    /// It is not an error.  The request succeeded; a setting was reached.
    Truncated,
    /// Agent turn complete.
    Done,
    /// Error occurred.
    Error(String),
}

impl AgentEvent {

    /// Convert to a JDAT map suitable for a WS `data` response.
    pub fn to_datmap(&self) -> DaticleMap {
        let mut m = DaticleMap::new();
        match self {
            Self::Text(text) => {
                m.insert(dat!("type"), dat!("text"));
                m.insert(dat!("content"), dat!(text.clone()));
            }
            Self::ToolCall { name, args } => {
                m.insert(dat!("type"), dat!("tool_call"));
                m.insert(dat!("name"), dat!(name.clone()));
                m.insert(dat!("args"), dat!(args.clone()));
            }
            Self::ToolResult { name, result } => {
                m.insert(dat!("type"), dat!("tool_result"));
                m.insert(dat!("name"), dat!(name.clone()));
                m.insert(dat!("content"), dat!(result.clone()));
            }
            Self::Interjected(text) => {
                m.insert(dat!("type"), dat!("interjected"));
                m.insert(dat!("content"), dat!(text.clone()));
            }
            Self::Compacted { folded, kept, note } => {
                m.insert(dat!("type"), dat!("compacted"));
                m.insert(dat!("folded"), Dat::U64(*folded as u64));
                m.insert(dat!("kept"), Dat::U64(*kept as u64));
                m.insert(dat!("content"), dat!(note.clone()));
            }
            Self::Truncated => {
                m.insert(dat!("type"), dat!("truncated"));
            }
            Self::Done => {
                m.insert(dat!("type"), dat!("done"));
            }
            Self::Error(msg) => {
                m.insert(dat!("type"), dat!("error"));
                m.insert(dat!("content"), dat!(msg.clone()));
            }
        }
        m
    }
}


// ┌───────────────────────────────────────────────────────────────┐
// │ O3db key helpers                                               │
// └───────────────────────────────────────────────────────────────┘

/// Build the O3db key for a user's session list.
pub fn sessions_key(username: &str) -> Dat {
    Dat::Str(fmt!("daimond:{}:sessions", username))
}

/// Build the O3db key for a specific session.
pub fn session_key(session_id: &str) -> Dat {
    Dat::Str(fmt!("daimond:session:{}", session_id))
}

/// Build the O3db key for a user's config.
pub fn user_config_key(username: &str) -> Dat {
    Dat::Str(fmt!("daimond:user:{}", username))
}

/// Generate a unique session ID (8 hex chars from timestamp + counter).
pub fn generate_session_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let ts = now_millis();
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    fmt!("{:x}{:x}", ts, n)
}


// ┌───────────────────────────────────────────────────────────────┐
// │ Tests                                                          │
// └───────────────────────────────────────────────────────────────┘

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_chat_message_roundtrip() {
        let msg = ChatMessage::User { content: "Hello".to_string() };
        let dm = msg.to_datmap();
        let msg2 = ChatMessage::from_datmap(&dm).unwrap();
        assert_eq!(msg, msg2);
    }

    #[test]
    fn test_chat_message_tool_roundtrip() {
        let msg = ChatMessage::Tool {
            tool_call_id: "call_123".to_string(),
            content: "42".to_string(),
        };
        let dm = msg.to_datmap();
        let msg2 = ChatMessage::from_datmap(&dm).unwrap();
        assert_eq!(msg, msg2);
    }

    #[test]
    fn test_session_roundtrip() {
        let mut s = Session::new("s1".to_string(), "Test".to_string(), "glm-5p2".to_string());
        s.messages.push(ChatMessage::User { content: "Hi".to_string() });
        s.messages.push(ChatMessage::Assistant { content: "Hello!".to_string(), tool_calls: Vec::new() });
        let dm = s.to_datmap();
        let s2 = Session::from_datmap(&dm).unwrap();
        assert_eq!(s.id, s2.id);
        assert_eq!(s.name, s2.name);
        assert_eq!(s.model, s2.model);
        assert_eq!(s.messages.len(), s2.messages.len());
        assert_eq!(s.messages[0], s2.messages[0]);
        assert_eq!(s.messages[1], s2.messages[1]);
    }

    #[test]
    fn test_user_config_roundtrip() {
        let uc = UserConfig::new("jason".to_string(), "glm-5p2".to_string());
        let dm = uc.to_datmap();
        let uc2 = UserConfig::from_datmap(&dm).unwrap();
        assert_eq!(uc.username, uc2.username);
        assert_eq!(uc.default_model, uc2.default_model);
    }

    #[test]
    fn test_agent_event_text() {
        let ev = AgentEvent::Text("hello".to_string());
        let dm = ev.to_datmap();
        assert_eq!(dm.get(&dat!("type")), Some(&dat!("text")));
        assert_eq!(dm.get(&dat!("content")), Some(&dat!("hello")));
    }

    #[test]
    fn test_agent_event_done() {
        let ev = AgentEvent::Done;
        let dm = ev.to_datmap();
        assert_eq!(dm.get(&dat!("type")), Some(&dat!("done")));
    }

    #[test]
    fn test_session_id_unique() {
        let id1 = generate_session_id();
        let id2 = generate_session_id();
        assert_ne!(id1, id2);
    }

    #[test]
    fn test_session_datmap_round_trip() {
        let mut s = Session::new("s1".to_string(), "Test".to_string(), "glm-5.2".to_string());
        s.prompt_tokens      = 10240;
        s.completion_tokens  = 512;
        s.last_prompt_tokens = 8192;
        s.cached_tokens      = 9216;
        s.cost_usd           = 0.0021;
        let back = match Session::from_datmap(&s.to_datmap()) {
            Ok(v)  => v,
            Err(e) => panic!("round trip failed: {}", e),
        };
        assert_eq!(back.cached_tokens, 9216);
        assert_eq!(back.cost_usd, 0.0021);
        assert_eq!(back.prompt_tokens, 10240);
    }

    #[test]
    fn test_session_datmap_without_new_fields() {
        // A snapshot written before `cached_tokens` and `cost_usd` existed.  It
        // must still load, at zero -- this is what makes the two fields optional
        // in practice, and a required field here would refuse a real history.
        let mut m = DaticleMap::new();
        m.insert(dat!("id"), dat!("s1"));
        m.insert(dat!("name"), dat!("Old"));
        m.insert(dat!("created_at"), Dat::U64(1));
        m.insert(dat!("model"), dat!("glm-5.2"));
        m.insert(dat!("prompt_tokens"), Dat::U64(7));
        m.insert(dat!("completion_tokens"), Dat::U64(3));
        m.insert(dat!("last_prompt_tokens"), Dat::U64(7));
        let s = match Session::from_datmap(&m) {
            Ok(v)  => v,
            Err(e) => panic!("an older snapshot must still load: {}", e),
        };
        assert_eq!(s.prompt_tokens, 7);
        assert_eq!(s.cached_tokens, 0);
        assert_eq!(s.cost_usd, 0.0);
    }

    // ── What a session store must give back ─────────────────────────────
    //
    // The rule every OpenAI-compatible provider enforces, written here and nowhere
    // else in the file: an assistant message bearing `tool_calls` must be followed
    // by one `tool` reply per call, in order, and a `tool` reply must answer a
    // call.  Deliberately not `compact::orphan_count` -- a round trip checked with
    // the app's own notion of pairing proves only that the app agrees with itself.

    /// Tool calls with no reply, plus tool replies with no call.
    fn unanswered(msgs: &[ChatMessage]) -> usize {
        let mut n = 0;
        let mut i = 0;
        while i < msgs.len() {
            match &msgs[i] {
                ChatMessage::Assistant { tool_calls, .. } if !tool_calls.is_empty() => {
                    let mut k = 0;
                    while k < tool_calls.len() {
                        match msgs.get(i + 1 + k) {
                            Some(ChatMessage::Tool { tool_call_id, .. })
                                if *tool_call_id == tool_calls[k].id => k += 1,
                            _ => break,
                        }
                    }
                    n += tool_calls.len() - k;
                    i += 1 + k;
                }
                ChatMessage::Tool { .. } => { n += 1; i += 1; }
                _ => i += 1,
            }
        }
        n
    }

    /// A session in the shape a tool loop leaves behind: a question, the assistant
    /// turn that asked for a tool, the reply, and the answer.
    fn session_with_a_tool_call() -> Session {
        let mut s = Session::new(fmt!("s1"), fmt!("Work"), fmt!("glm-5.2"));
        s.messages.push(ChatMessage::User { content: fmt!("read the parser") });
        s.messages.push(ChatMessage::Assistant {
            content:    fmt!("Looking."),
            tool_calls: vec![ToolCall {
                id:        fmt!("call_abc"),
                name:      fmt!("file_read"),
                arguments: fmt!("{{\"path\":\"src/parse.rs\"}}"),
            }],
        });
        s.messages.push(ChatMessage::Tool {
            tool_call_id: fmt!("call_abc"),
            content:      fmt!("fn parse() {{}}"),
        });
        s.messages.push(ChatMessage::Assistant {
            content: fmt!("It is one function."), tool_calls: Vec::new(),
        });
        s
    }

    /// Store and fetch a session the way `SessionStore` does: a `Dat::Map` written
    /// as bytes and read back.
    fn round_trip(s: &Session) -> Session {
        let stored = Dat::Map(s.to_datmap());
        let bytes = match stored.to_bytes(Vec::new()) {
            Ok(b)  => b,
            Err(e) => panic!("a session must be storable: {}", e),
        };
        let (back, _) = match Dat::from_bytes(&bytes) {
            Ok(v)  => v,
            Err(e) => panic!("a stored session must be readable: {}", e),
        };
        match back {
            Dat::Map(m) => match Session::from_datmap(&m) {
                Ok(v)  => v,
                Err(e) => panic!("a stored session must decode: {}", e),
            },
            other => panic!("a session stored as a map came back as {:?}", other.kind()),
        }
    }

    #[test]
    fn test_a_reloaded_session_is_one_a_provider_would_accept_00() {
        // The bug this replaces: `to_datmap` dropped `tool_calls`, so a session read
        // back had a bare assistant turn followed by a `tool` message answering
        // nothing.  Every OpenAI-compatible provider rejects that outright -- so the
        // native and Steel paths broke on any reload after a tool call, and went on
        // breaking, because the same conversation was sent every turn.
        let s = session_with_a_tool_call();
        assert_eq!(unanswered(&s.messages), 0, "the fixture must start whole");
        let back = round_trip(&s);
        assert_eq!(unanswered(&back.messages), 0,
            "a reloaded session has {} unpaired tool calls; a provider refuses it",
            unanswered(&back.messages));
    }

    #[test]
    fn test_a_reloaded_session_still_knows_what_it_asked_for_00() {
        // Pairing alone is not enough: the call has to come back whole, or the model
        // reads a conversation in which it asked for nothing and was answered anyway.
        let back = round_trip(&session_with_a_tool_call());
        assert_eq!(back.messages, session_with_a_tool_call().messages);
        match &back.messages[1] {
            ChatMessage::Assistant { tool_calls, .. } => {
                assert_eq!(tool_calls.len(), 1);
                assert_eq!(tool_calls[0].id, "call_abc");
                assert_eq!(tool_calls[0].name, "file_read");
                assert!(tool_calls[0].arguments.contains("src/parse.rs"),
                    "the arguments were lost: {}", tool_calls[0].arguments);
            }
            other => panic!("message 1 came back as {}", other.role()),
        }
    }

    #[test]
    fn test_an_assistant_turn_that_asked_for_nothing_is_stored_as_it_always_was_00() {
        // The key is written only when there are calls, so nothing changes for the
        // ordinary answer -- and a reader of an older snapshot sees the same map.
        let m = ChatMessage::Assistant { content: fmt!("Hello."), tool_calls: Vec::new() };
        assert!(m.to_datmap().get(&dat!("tool_calls")).is_none());
        assert_eq!(ChatMessage::from_datmap(&m.to_datmap()).ok(), Some(m));
    }

    #[test]
    fn test_a_snapshot_written_before_tool_calls_were_kept_still_loads_00() {
        // What is already in every user's store.  It loads, with no calls, exactly as
        // it did -- a required field here would refuse their own history.
        let mut m = DaticleMap::new();
        m.insert(dat!("role"), dat!("assistant"));
        m.insert(dat!("content"), dat!("older"));
        match ChatMessage::from_datmap(&m) {
            Ok(ChatMessage::Assistant { content, tool_calls }) => {
                assert_eq!(content, "older");
                assert!(tool_calls.is_empty());
            }
            Ok(other) => panic!("it came back as {}", other.role()),
            Err(e)    => panic!("an older snapshot must still load: {}", e),
        }
    }

    #[test]
    fn test_a_call_with_no_id_is_dropped_rather_than_losing_the_message_00() {
        // An id is what pairs a call with its reply, so a call without one can never
        // be answered.  Half a conversation is worth more to the user than an error,
        // and what is left reads as the broken pairing it is.
        let mut bad = DaticleMap::new();
        bad.insert(dat!("name"), dat!("file_read"));
        let mut m = DaticleMap::new();
        m.insert(dat!("role"), dat!("assistant"));
        m.insert(dat!("content"), dat!("hm"));
        m.insert(dat!("tool_calls"), Dat::List(vec![Dat::Map(bad)]));
        match ChatMessage::from_datmap(&m) {
            Ok(ChatMessage::Assistant { tool_calls, .. }) => assert!(tool_calls.is_empty()),
            Ok(other) => panic!("it came back as {}", other.role()),
            Err(e)    => panic!("a malformed call must not lose the message: {}", e),
        }
    }

    // ── A fold is its own event ─────────────────────────────────────────

    #[test]
    fn test_a_fold_announces_itself_as_a_fold_00() {
        // It used to borrow the tool-call surface, which drew it as an action row the
        // model had taken.  A fold is something the APP did to the user's
        // conversation, and it is lossy; it says so in its own variant, with the two
        // counts beside the sentence so a client need not parse prose to draw it.
        let ev = AgentEvent::Compacted {
            folded: 41, kept: 7, note: fmt!("Folded 41 earlier messages."),
        };
        let dm = ev.to_datmap();
        assert_eq!(dm.get(&dat!("type")), Some(&dat!("compacted")));
        assert_eq!(dm.get(&dat!("folded")), Some(&Dat::U64(41)));
        assert_eq!(dm.get(&dat!("kept")), Some(&Dat::U64(7)));
        assert_eq!(dm.get(&dat!("content")), Some(&dat!("Folded 41 earlier messages.")));
        // And it is not a tool row: a client keying off `type` must not confuse the
        // two, because one is collapsible machine output and the other is a notice.
        assert_ne!(dm.get(&dat!("type")), Some(&dat!("tool_call")));
        assert_ne!(dm.get(&dat!("type")), Some(&dat!("tool_result")));
    }

    #[test]
    fn test_a_cut_reply_says_so_and_is_not_an_error_00() {
        // The browser used to infer this from tool arguments that would not parse, which
        // says nothing about a plain text reply cut short. It is not an `error` either:
        // the request succeeded and a setting was reached, and a client that drew it in
        // red would be reporting a failure that did not happen.
        let dm = AgentEvent::Truncated.to_datmap();
        assert_eq!(dm.get(&dat!("type")), Some(&dat!("truncated")));
        assert_ne!(dm.get(&dat!("type")), Some(&dat!("error")));
        assert_ne!(dm.get(&dat!("type")), Some(&dat!("done")));
    }

    #[test]
    fn test_o3db_keys() {
        assert_eq!(sessions_key("jason"), Dat::Str("daimond:jason:sessions".to_string()));
        assert_eq!(session_key("s1"), Dat::Str("daimond:session:s1".to_string()));
        assert_eq!(user_config_key("jason"), Dat::Str("daimond:user:jason".to_string()));
    }
}
