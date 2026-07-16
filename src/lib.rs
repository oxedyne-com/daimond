//! Daimond, the browser-first agentic workspace client.
//!
//! This crate is the Daimond client.  The same source compiles two ways: to
//! WebAssembly (`wasm32`), which is the code that runs in the browser and does
//! the work on the user's device, and to a native library used by the smoke
//! example and by server-side integration.  It talks to any OpenAI-compatible
//! model with the user's own key and can act through a small set of tools.
//!
//! It is published as source-available so the privacy claim can be verified:
//! the client encrypts on the device and only ciphertext crosses the wire.  See
//! the repository README for what that does and does not let you verify.
//!
//! Key components:
//!
//! - [`llm`] — async LLM client with SSE streaming
//! - [`session`] — per-user session and conversation storage (O3db)
//! - [`agent`] — the agent loop: message → LLM → tools → streamed response
//! - [`protocol`] — WS message types (JDAT serialisation)
//! - [`handler`] — `WebSocketHandler` impl for Steel integration

#![forbid(unsafe_code)]

pub mod agent;
pub mod executor;
/// The Steel WebSocket handler is a native-only server concern; the
/// browser (wasm32) build drives the agent directly, so this module is
/// gated out of the wasm target.
#[cfg(not(target_arch = "wasm32"))]
pub mod handler;
pub mod llm;
pub mod protocol;
pub mod session;
pub mod skills;
pub mod syntax;
pub mod tools;
/// The browser (wasm32) entry surface — a `#[wasm_bindgen]` API plus the
/// OPFS filesystem edge.  Gated to wasm32 so the native build never sees
/// `wasm-bindgen`'s generated glue.
#[cfg(target_arch = "wasm32")]
pub mod wasm;
pub mod workspace;
