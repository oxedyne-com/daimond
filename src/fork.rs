//! A worker's copy of its parent (r578c, 2026-10-20).
//!
//! A dispatched worker used to start from a written brief: the parent's role prompt was swapped
//! for the worker's, the conversation was left behind, and the `task` string was all it got.  The
//! owner's attachments, pictures, steering notes and the Diamond crystal never reached it, and a
//! parent writing "everything it needs" into one string was the whole hand-off.
//!
//! Now the parent's latest request is held, as sent, at the round that asks for a worker, and the
//! worker starts from it: the same system message, the same tools array and every message, byte
//! for byte, then one appended user message with the worker role and its task.  Same model and
//! host, so round one reuses the parent's cache.
//!
//! **The copy stays in Rust.**  The parent's session is mutably held by its own turn while the
//! tools run, so the page cannot export it at that moment, and the page's message form drops
//! images.  So the engine takes it at the call and the page carries only an id: [`issue`] files
//! it here, and the worker's app takes it with [`get`] -- again on a re-mint -- until [`forget`].

use crate::protocol::ChatMessage;
use crate::protocol::HostPin;
use crate::tools::Tool;

use oxedyne_fe2o3_core::prelude::*;

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

/// The parent's latest request as it was sent, and what a worker needs to send it again.
#[derive(Clone, Debug, Default)]
pub struct Fork {
	pub model:     String,							// the parent's model id
	pub system:    String,							// exact system message text sent, "" for none
	pub tools:     Option<String>,					// exact tools array sent
	pub belt:      Vec<Tool>,						// the parent's registry, so dispatch resolves alike
	pub daimon_of: String,							// the Diamond, so crystal_read and recall work
	pub messages:  Vec<ChatMessage>,				// the conversation as sent, no system message
	pub carry:     Vec<(String, Vec<String>)>,		// thinking blocks by tool-call id
	pub pin:       Option<HostPin>,					// the r578 host pin
}

impl Fork {
	/// Split a request as sent into the system text and the conversation.
	pub fn from_working(working: &[ChatMessage]) -> (String, Vec<ChatMessage>) {
		match working.first() {
			Some(ChatMessage::System { content }) =>
				(content.as_text().into_owned(), working[1..].to_vec()),
			_ => (String::new(), working.to_vec()),
		}
	}

	/// The size of the prompt copied, in bytes: system, tools and conversation.
	pub fn bytes(&self) -> usize {
		self.system.len()
			+ self.tools.as_ref().map(|t| t.len()).unwrap_or(0)
			+ crate::agent::compact::conversation_bytes(&self.messages) as usize
	}
}

// Issued copies
//
// Bounded, oldest out: a worker that never reached its app leaves its copy here until 64 more have
// been issued.  A Mutex and not a thread-local, because the native tool loop may hop threads.
const ISSUED_MAX: usize = 64;

static ISSUED: Mutex<Vec<(String, Arc<Fork>)>> = Mutex::new(Vec::new());
static NEXT: AtomicU64 = AtomicU64::new(1);

fn issued() -> std::sync::MutexGuard<'static, Vec<(String, Arc<Fork>)>> {
	match ISSUED.lock() {
		Ok(g)  => g,
		Err(p) => p.into_inner(),
	}
}

/// File a held copy for one worker, and name it.
pub fn issue(f: Arc<Fork>) -> String {
	let id = fmt!("f{}", NEXT.fetch_add(1, Ordering::Relaxed));
	let mut g = issued();
	g.push((id.clone(), f));
	if g.len() > ISSUED_MAX {
		let drop = g.len() - ISSUED_MAX;
		g.drain(..drop);
	}
	id
}

/// The copy filed under `id`, left in place so a re-minted worker can take it again.
pub fn get(id: &str) -> Option<Arc<Fork>> {
	issued().iter().find(|(k, _)| k == id).map(|(_, f)| f.clone())
}

/// Drop the copy filed under `id`; the worker has ended.
pub fn forget(id: &str) {
	issued().retain(|(k, _)| k != id);
}
