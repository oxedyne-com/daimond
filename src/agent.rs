//! Agent loop — the core Daimond agent that drives conversations.
//!
//! Receives a user message, sends it to the LLM with conversation
//! history, streams the response back to the client via events,
//! and stores the exchange in the session.

use oxedyne_fe2o3_core::prelude::*;

use std::cell::Cell;

use crate::llm::LlmClient;
use crate::protocol::{AgentEvent, ChatMessage, Session};
use crate::tools::ToolRegistry;

// The TLS client-config helper below is native-only; the wasm build
// delegates TLS trust to the browser and constructs `LlmClient`
// without a `ClientConfig`.
#[cfg(not(target_arch = "wasm32"))]
use std::sync::Arc;
#[cfg(not(target_arch = "wasm32"))]
use tokio_rustls::rustls::ClientConfig;

/// Upper bound on tool-call rounds in a single turn, to bound cost and
/// prevent a model from looping on tools indefinitely.
const MAX_TOOL_ROUNDS: usize = 25;


// ┌───────────────────────────────────────────────────────────────┐
// │ Agent                                                          │
// └───────────────────────────────────────────────────────────────┘

/// The Daimond agent — drives a single conversation turn.
///
/// Holds a reference to the LLM client (shared across sessions) and
/// the system prompt to prepend to every conversation.
#[derive(Clone, Debug)]
pub struct Agent {
    pub llm:           LlmClient,
    pub system_prompt: String,
    /// Cumulative prompt tokens for the turn in flight, updated round by round
    /// alongside the session total. Held here, outside the session, so the
    /// browser can read a running agent's spend without borrowing the session
    /// the turn already holds mutably -- reading it there would panic the
    /// `RefCell`, so a running tile could not show its cost.
    pub live_prompt:     Cell<u64>,
    /// Cumulative completion tokens for the turn in flight; see `live_prompt`.
    pub live_completion: Cell<u64>,
}

impl Agent {

    pub fn new(llm: LlmClient, system_prompt: &str) -> Self {
        Self {
            llm,
            system_prompt: system_prompt.to_string(),
            live_prompt:     Cell::new(0),
            live_completion: Cell::new(0),
        }
    }

    /// Run a single agent turn.
    ///
    /// 1. Append the user message to the session.
    /// 2. Build the LLM request: system prompt + conversation history.
    /// 3. Call the LLM with streaming.
    /// 4. Stream tokens back to the caller via `on_event`.
    /// 5. Append the assistant response to the session.
    /// 6. Emit `Done`.
    pub async fn run_turn(
        &self,
        session:    &mut Session,
        user_msg:   String,
        registry:   &ToolRegistry,
        on_event:   &mut impl FnMut(AgentEvent),
    ) -> Outcome<()> {
        // Append the user message to the persisted history.
        session.messages.push(ChatMessage::User { content: user_msg });

        // Build the working conversation: system prompt + history.
        let mut working = Vec::with_capacity(session.messages.len() + 1);
        if !self.system_prompt.is_empty() {
            let mut sys = self.system_prompt.clone();
            if !registry.is_empty() {
                // Name the tools that are actually registered. A fixed sentence
                // here once promised a shell tool the browser build does not
                // have, so a capable model would call it, fail, and report the
                // failure as work done.
                sys.push_str(&fmt!(
                    "\n\nYou have exactly these tools, all scoped to the user's \
                     workspace: {}. Use them to inspect and change the workspace \
                     when completing a task. You have no other tools; never claim \
                     to have performed an action you had no tool to perform.",
                    registry.tool_names().join(", ")));
            }
            working.push(ChatMessage::System { content: sys });
        }
        working.extend(session.messages.iter().cloned());

        if registry.is_empty() {
            return self.run_streaming(session, working, on_event).await;
        }
        self.run_tool_loop(session, working, registry, on_event).await
    }

    /// Pure-chat path: stream tokens as they arrive (no tools).
    async fn run_streaming(
        &self,
        session:    &mut Session,
        working:    Vec<ChatMessage>,
        on_event:   &mut impl FnMut(AgentEvent),
    ) -> Outcome<()> {
        let mut full = String::new();
        let result = self.llm.chat_stream(
            &working,
            &mut |token| {
                full.push_str(token);
                on_event(AgentEvent::Text(token.to_string()));
            },
        ).await;
        match result {
            Ok(resp) => {
                let content = if resp.content.is_empty() { full } else { resp.content };
                session.messages.push(ChatMessage::Assistant { content, tool_calls: Vec::new() });
                session.prompt_tokens += resp.prompt_tokens;
                session.completion_tokens += resp.completion_tokens;
                if resp.prompt_tokens > 0 { session.last_prompt_tokens = resp.prompt_tokens; }
                self.live_prompt.set(session.prompt_tokens);
                self.live_completion.set(session.completion_tokens);
                on_event(AgentEvent::Done);
                Ok(())
            }
            Err(e) => {
                on_event(AgentEvent::Error(e.to_string()));
                Err(e)
            }
        }
    }

    /// Agentic path: streaming request/response, executing tool calls
    /// between rounds until the model returns a final answer.  Each round
    /// streams with tools enabled, so assistant text arrives token by
    /// token even while tools are active (via `chat_stream_tools`); tool
    /// calls are reconstructed from the streamed fragments and fired as
    /// before.  The whole exchange -- the assistant turn that asked for the
    /// tools, each tool result, and the final answer -- is persisted to the
    /// session, so a later turn still sees what this agent did.  Persisting
    /// only the final text once left the model amnesiac: asked a follow-up, it
    /// had no record of its own tool calls and could not say what it had done.
    async fn run_tool_loop(
        &self,
        session:    &mut Session,
        mut working: Vec<ChatMessage>,
        registry:   &ToolRegistry,
        on_event:   &mut impl FnMut(AgentEvent),
    ) -> Outcome<()> {
        let tools_json = registry.definitions_json();
        for _ in 0..MAX_TOOL_ROUNDS {
            // Stream this round's assistant text as it arrives; the tool
            // calls (if any) are returned assembled once the round ends.
            let resp = match self.llm.chat_stream_tools(
                &working,
                tools_json.as_deref(),
                &mut |token| on_event(AgentEvent::Text(token.to_string())),
            ).await {
                Ok(r) => r,
                Err(e) => { on_event(AgentEvent::Error(e.to_string())); return Err(e); }
            };
            session.prompt_tokens += resp.prompt_tokens;
            session.completion_tokens += resp.completion_tokens;
            if resp.prompt_tokens > 0 { session.last_prompt_tokens = resp.prompt_tokens; }
            self.live_prompt.set(session.prompt_tokens);
            self.live_completion.set(session.completion_tokens);

            // Cancelled mid-stream: keep the partial answer already
            // streamed and end the turn cleanly, without an error.
            if resp.aborted {
                session.messages.push(ChatMessage::Assistant {
                    content: resp.content, tool_calls: Vec::new(),
                });
                on_event(AgentEvent::Done);
                return Ok(());
            }

            if resp.tool_calls.is_empty() {
                // Final answer — its text has already streamed via the
                // token callback, so it is not re-emitted here.
                session.messages.push(ChatMessage::Assistant {
                    content: resp.content, tool_calls: Vec::new(),
                });
                on_event(AgentEvent::Done);
                return Ok(());
            }

            // Any interim assistant text alongside the tool calls has already
            // streamed. Record the assistant turn in both the working vec, which
            // drives the rest of this turn, and the session, so a later turn
            // still carries it. The API also requires that an assistant turn
            // bearing tool_calls be followed by a tool reply for each of them,
            // which the loop below then supplies.
            let asked = ChatMessage::Assistant {
                content: resp.content.clone(),
                tool_calls: resp.tool_calls.clone(),
            };
            working.push(asked.clone());
            session.messages.push(asked);

            // Execute each requested tool call, recording every result in both
            // places for the same reason.
            for tc in &resp.tool_calls {
                on_event(AgentEvent::ToolCall { name: tc.name.clone(), args: tc.arguments.clone() });
                let result = registry.dispatch(&tc.name, &tc.arguments).await;
                on_event(AgentEvent::ToolResult { name: tc.name.clone(), result: result.clone() });
                let reply = ChatMessage::Tool { tool_call_id: tc.id.clone(), content: result };
                working.push(reply.clone());
                session.messages.push(reply);
            }
        }

        // Exceeded the tool-round budget.
        let msg = fmt!("Reached the tool-call round limit ({}).", MAX_TOOL_ROUNDS);
        on_event(AgentEvent::Error(msg.clone()));
        session.messages.push(ChatMessage::Assistant {
            content: fmt!("[{}]", msg), tool_calls: Vec::new(),
        });
        on_event(AgentEvent::Done);
        Ok(())
    }
}


// ┌───────────────────────────────────────────────────────────────┐
// │ TLS config helper                                              │
// └───────────────────────────────────────────────────────────────┘

/// Build a TLS client config using the system CA bundle.
///
/// Reused from Steel's `build_outbound_tls_client` — same approach
/// but kept here so `daimond` can be used standalone.
#[cfg(not(target_arch = "wasm32"))]
pub fn build_tls_client_config() -> Outcome<Arc<ClientConfig>> {
    use tokio_rustls::rustls::{
        ClientConfig,
        RootCertStore,
        pki_types::CertificateDer,
    };

    let ca_paths = [
        "/etc/ssl/certs/ca-certificates.crt",
        "/etc/pki/tls/certs/ca-bundle.crt",
        "/etc/ssl/cert.pem",
    ];
    let ca_file = match ca_paths.iter().find(|p| std::path::Path::new(p).exists()) {
        Some(p) => *p,
        None => return Err(err!(
            "No system CA bundle found."; Init, Missing, File)),
    };

    let pem_data = match std::fs::read(ca_file) {
        Ok(d) => d,
        Err(e) => return Err(err!(e, "Failed to read CA bundle."; File, Read)),
    };

    let mut roots = RootCertStore::empty();
    let certs: Vec<CertificateDer> = rustls_pemfile::certs(&mut pem_data.as_slice())
        .filter_map(|c| c.ok())
        .map(CertificateDer::from)
        .collect();
    for cert in certs {
        let _ = roots.add(cert);
    }

    let mut config = ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    // Advertise HTTP/1.1 via ALPN so CDN-fronted servers (e.g.
    // Fireworks.ai behind Cloudflare) don't close the connection
    // after the TLS handshake when no protocol is negotiated.
    config.alpn_protocols = vec![b"http/1.1".to_vec()];

    Ok(Arc::new(config))
}


// ┌───────────────────────────────────────────────────────────────┐
// │ Tests                                                          │
// └───────────────────────────────────────────────────────────────┘

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::LlmClient;

    fn make_test_agent() -> Agent {
        let tls = build_test_tls_config();
        let llm = LlmClient::new("api.test.com", 443, "/v1/chat", "key", "model", 4096, tls);
        Agent::new(llm, "You are Daimond, an AI assistant.")
    }

    fn build_test_tls_config() -> Arc<ClientConfig> {
        use rustls::crypto::ring;
        let _ = ring::default_provider().install_default();
        ClientConfig::builder()
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(crate::llm::tests::NoVerify))
            .with_no_client_auth().into()
    }

    #[test]
    fn test_agent_creation() {
        let agent = make_test_agent();
        assert_eq!(agent.system_prompt, "You are Daimond, an AI assistant.");
    }

    #[test]
fn test_agent_message_building() {
        let mut session = Session::new("s1".to_string(), "Test".to_string(), "model".to_string());
        session.messages.push(ChatMessage::User { content: "Hello".to_string() });
        assert_eq!(session.messages.len(), 1);
        assert_eq!(session.messages[0].role(), "user");
        assert_eq!(session.messages[0].content(), "Hello");
    }
}
