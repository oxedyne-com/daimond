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

    // A fresh workspace under the user cache. Not `std::env::temp_dir()`: `/tmp`
    // is a tmpfs, so whatever the agent writes there stays resident in memory.
    let dir = res!(oxedyne_fe2o3_test::scratch::scratch_dir("daimond_smoke"));
    let ws = res!(Workspace::new(dir.clone()));
    let ctx = ToolContext { workspace: ws, executor: Executor::local_default(), cwd: String::new(), path_prefix: String::new(), root: oxedyne_daimond::tools::FileRoot::Workspace, read_seen: oxedyne_daimond::tools::new_read_cache(), no_write: Vec::new(),
        // The Diamond this turn belongs to. A smoke run belongs to none, which is
        // the same thing an ordinary chat says.
        daimon_of: String::new() };
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
            // `id` is the provider's own call id, which pairs a call with its reply.
            // A smoke run prints neither side by id, so it is named and dropped rather
            // than matched with `..` -- a new field should break this again on purpose.
            AgentEvent::ToolCall { name, args, id: _ } => println!("\n[tool_call] {} {}", name, args),
            // The OUTCOME is printed and never inferred from the text.  A smoke run
            // whose tool was refused prints the same 200 characters as one that
            // worked, and telling them apart by reading the prose is the defect the
            // outcome field was added to end.
            AgentEvent::ToolResult { name, result, outcome } => {
                let r = if result.len() > 200 { &result[..200] } else { &result };
                println!("[tool_result] {} {} -> {}", name, outcome.wire(), r);
            }
            AgentEvent::Done => println!("\n[done]"),
            AgentEvent::Error(e) => println!("\n[error] {}", e),
            // Printed rather than ignored: a smoke run whose turn was folded, cut
            // short by the provider, or interrupted looks identical to one that
            // simply answered, and the difference is the whole point of running it.
            AgentEvent::Compacted { folded, kept, note } =>
                println!("\n[compacted] folded {} kept {} — {}", folded, kept, note),
            AgentEvent::Truncated => println!("\n[truncated] the provider cut the reply short"),
            AgentEvent::Interjected(text) => println!("\n[interjected] {}", text),
            AgentEvent::Unseeable { images, model } =>
                println!("\n[unseeable] {} image(s) withheld from {}", images, model),
            // The working, not the answer.  Printed whole, because a smoke run is read
            // by a person deciding whether the turn went the way they meant.
            AgentEvent::Thinking(text) => println!("\n[thinking] {}", text),
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
