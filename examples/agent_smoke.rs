//! End-to-end smoke test of the agentic tool loop against a real
//! OpenAI-compatible endpoint.  Not a unit test (it needs network and
//! an API key); run manually:
//!
//! ```bash
//! RED_LLM_KEY=fw_... cargo run --example agent_smoke -p oxedyne_daimond
//! ```

use oxedyne_fe2o3_core::prelude::*;
use oxedyne_daimond::agent::{Agent, build_tls_client_config};
use oxedyne_daimond::executor::Executor;
use oxedyne_daimond::llm::LlmClient;
use oxedyne_daimond::protocol::{AgentEvent, Session};
use oxedyne_daimond::tools::{Tool, ToolContext, ToolRegistry};
use oxedyne_daimond::workspace::Workspace;

#[tokio::main]
async fn main() {
    match run().await {
        Ok(()) => println!("\n=== smoke test OK ==="),
        Err(e) => { eprintln!("smoke test failed: {}", e); std::process::exit(1); }
    }
}

async fn run() -> Outcome<()> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    // Provide your own key: this smoke test talks to a real provider.
    let key = res!(std::env::var("RED_LLM_KEY").map_err(|_| err!(
        "set RED_LLM_KEY to your provider API key to run this smoke test";
        Init, Missing)));
    let tls = res!(build_tls_client_config());
    let llm = LlmClient::new(
        "api.fireworks.ai", 443, "/inference/v1/chat/completions",
        &key, "accounts/fireworks/models/glm-5p2", 2048, tls,
    );
    let agent = Agent::new(llm, "You are Daimond, a coding agent.");

    // Fresh temp workspace.
    let mut dir = std::env::temp_dir();
    let n = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    dir.push(fmt!("daimond_smoke_{}", n));
    let ws = res!(Workspace::new(dir.clone()));
    let ctx = ToolContext { workspace: ws, executor: Executor::local_default(), cwd: String::new(), path_prefix: String::new(), root: oxedyne_daimond::tools::FileRoot::Workspace, read_seen: oxedyne_daimond::tools::new_read_cache(), no_write: Vec::new() };
    let registry = ToolRegistry::new(Tool::defaults(), ctx);

    let mut session = Session::new("smoke".to_string(), "Smoke".to_string(),
        "accounts/fireworks/models/glm-5p2".to_string());

    let prompt = "Create a file called hello.txt containing exactly the text \
                  'Hi from Daimond', then read it back and confirm its contents. \
                  Use your tools.".to_string();

    println!("workspace: {:?}\nprompt: {}\n--- events ---", dir, prompt);
    let mut on_event = |ev: AgentEvent| {
        match ev {
            AgentEvent::Text(t) => print!("{}", t),
            AgentEvent::ToolCall { name, args } => println!("\n[tool_call] {} {}", name, args),
            AgentEvent::ToolResult { name, result } => {
                let r = if result.len() > 200 { &result[..200] } else { &result };
                println!("[tool_result] {} -> {}", name, r);
            }
            AgentEvent::Done => println!("\n[done]"),
            AgentEvent::Error(e) => println!("\n[error] {}", e),
        }
    };
    res!(agent.run_turn(&mut session, prompt, &registry, &mut on_event).await);

    // Verify the file exists with the expected content.
    let created = dir.join("hello.txt");
    match std::fs::read_to_string(&created) {
        Ok(c) => println!("\n--- hello.txt on disk: {:?}", c.trim()),
        Err(e) => return Err(err!(e, "hello.txt was not created."; Test, File)),
    }
    println!("session tokens: prompt={} completion={}",
        session.prompt_tokens, session.completion_tokens);
    Ok(())
}
