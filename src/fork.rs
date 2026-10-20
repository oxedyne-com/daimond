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

	/// The memory the copy holds, in bytes.  Unlike [`Fork::bytes`], which weighs a picture by
	/// what it costs the model, this counts its raw bytes, which is what the store keeps.
	pub fn held_bytes(&self) -> usize {
		let mut n = self.system.len() + self.tools.as_ref().map(|t| t.len()).unwrap_or(0);
		for m in &self.messages {
			let mut w = crate::agent::compact::msg_bytes(m) as usize;
			for img in m.content().images() {
				w = w.saturating_sub(crate::agent::compact::image_bytes(img) as usize);
				w += img.data.len() + img.source.len();
			}
			n += w;
		}
		for (k, v) in &self.carry {
			n += k.len() + v.iter().map(|t| t.len()).sum::<usize>();
		}
		n
	}
}

// Issued copies
//
// Bounded by the memory they hold, oldest out.  A Mutex and not a thread-local, because the
// native tool loop may hop threads.
//
// 32 MiB, because the page runs at most 8 workers at once (`Workers.MAX`) and each may hold a
// copy from a different round.  A copy's text is bounded by compaction (120k tokens, about
// 480 KB), so what fills the store is pictures: 8 copies of a conversation carrying a few
// photos (about 4 MiB each) fit, and that is a small share of a phone tab's memory.  A copy is
// counted once however many workers of one fan-out share it, and the newest is always kept,
// whatever its size, so the worker it was issued for still finds it.
const ISSUED_MAX_BYTES: usize = 32 * 1024 * 1024;

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
	trim(&mut g, ISSUED_MAX_BYTES);
	id
}

/// Drop the oldest copies until the distinct copies held weigh at most `cap` bytes, keeping the
/// newest whatever its size.
fn trim(v: &mut Vec<(String, Arc<Fork>)>, cap: usize) {
	loop {
		let mut seen: Vec<&Arc<Fork>> = Vec::new();
		let mut total = 0usize;
		for (_, f) in v.iter() {
			if !seen.iter().any(|s| Arc::ptr_eq(s, f)) {
				total += f.held_bytes();
				seen.push(f);
			}
		}
		if total <= cap || v.len() <= 1 { return; }
		v.remove(0);
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::protocol::ImageMedia;
	use crate::protocol::ImagePart;
	use crate::protocol::MessageContent;
	use crate::protocol::ContentPart;

	fn pictured(n: usize) -> Arc<Fork> {
		let img = ImagePart::new(ImageMedia::Png, vec![0u8; n], "p.png".to_string());
		Arc::new(Fork {
			messages: vec![ChatMessage::user(MessageContent::Parts(vec![ContentPart::Image(img)]))],
			..Default::default()
		})
	}

	#[test]
	fn test_a_copy_is_weighed_by_its_raw_picture_bytes() {
		let f = pictured(1_000_000);
		assert!(f.held_bytes() >= 1_000_000, "held {} for a 1 MB picture", f.held_bytes());
	}

	#[test]
	fn test_the_store_is_bounded_by_bytes_oldest_out_and_a_shared_copy_counts_once() {
		let mut v: Vec<(String, Arc<Fork>)> = Vec::new();
		let shared = pictured(400_000);
		for i in 0..3 { v.push((fmt!("s{}", i), shared.clone())); }
		trim(&mut v, 1_000_000);
		assert_eq!(v.len(), 3, "one copy shared by a fan-out was counted three times");
		v.push((fmt!("a"), pictured(400_000)));
		v.push((fmt!("b"), pictured(400_000)));
		trim(&mut v, 1_000_000);
		let ids: Vec<&str> = v.iter().map(|(k, _)| k.as_str()).collect();
		assert_eq!(ids, vec!["a", "b"], "the oldest copy did not go first");
		v.push((fmt!("huge"), pictured(5_000_000)));
		trim(&mut v, 1_000_000);
		let ids: Vec<&str> = v.iter().map(|(k, _)| k.as_str()).collect();
		assert_eq!(ids, vec!["huge"], "the newest copy must stay, whatever its size");
	}
}

/// The copy filed under `id`, left in place so a re-minted worker can take it again.
pub fn get(id: &str) -> Option<Arc<Fork>> {
	issued().iter().find(|(k, _)| k == id).map(|(_, f)| f.clone())
}

/// Drop the copy filed under `id`; the worker has ended.
pub fn forget(id: &str) {
	issued().retain(|(k, _)| k != id);
}
