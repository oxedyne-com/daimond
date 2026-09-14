//! What a model's own dialect needs, read off the provider's slug.
//!
//! **Every figure here came off the tune bank, and none of it is a guess about a vendor.**  Six
//! open-weight models were run over the same twelve tasks in `r1` and `rexp2`, 1,467 relay rows,
//! and the tool failures sorted into four shapes that are each one family's and nobody else's:
//! Kimi sending `file_edit` with `path` and nothing else fifty times out of fifty, Qwen sending
//! `options` and `edits` as quoted JSON strings, DeepSeek re-sending a whole multi-hunk edit when
//! one hunk drifted, MiniMax reaching for keys no schema names.  A note addressed to all of them
//! is paid for by all of them and acted on by one, so each family carries its own.
//!
//! **Claude and GPT carry nothing**, which is the point of measuring: they did not make these
//! mistakes, and a prompt that warns them off a thing they never do is a tax with no yield.
//!
//! Why this is Rust and not a table in `models.js`: the three consumers are the prompt composer,
//! the tool roster and the argument pre-pass, and all three are Rust.  A JS table would be a
//! second source of truth serialised on every app construction, and unreachable from the unit
//! tests that hold the wire fixtures these rules were written against.

use crate::tools::Tool;

use oxedyne_fe2o3_core::prelude::*;

use std::borrow::Cow;


/// Which family of model is carrying the request, read off the provider's slug.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Family {
	Claude,
	Gpt,		// the default shape every other OpenAI-dialect model is measured against
	DeepSeek,
	Qwen,
	Glm,
	MiniMax,
	Kimi,
	Unknown,	// every note, every tool, the schema as written
}

impl Family {

	/// The family a slug names, or [`Family::Unknown`].
	///
	/// Matched on the whole string case-folded, so a prefix (`anthropic/claude-opus-5`), a bare
	/// name (`claude-haiku-4.5-20260224`) and a router's own path
	/// (`accounts/fireworks/models/glm-5p2`) all answer the same.  The empty model is `Unknown`
	/// and not "needs nothing", for [`crate::prompts::measured_spare`]'s reason: a caller that
	/// has not been taught to pass a model must not silently lose what a model would have got.
	pub fn detect(model: &str) -> Self {
		let m = model.trim().to_lowercase();
		if m.is_empty() {
			return Self::Unknown;
		}
		// Ordered so the specific wins: `moonshotai/kimi-k2.7-code` carries neither of the two
		// substrings the looser families match, but an unordered scan over a longer table is how
		// a `gpt-oss` slug ends up answering for OpenAI.
		if m.contains("claude") || m.starts_with("anthropic/") || m.starts_with("anthropic.") {
			return Self::Claude;
		}
		if m.contains("deepseek")	{ return Self::DeepSeek; }
		if m.contains("qwen") || m.contains("qwq")	{ return Self::Qwen; }
		if m.contains("glm-") || m.starts_with("z-ai/") || m.contains("zhipu") {
			return Self::Glm;
		}
		if m.contains("minimax")	{ return Self::MiniMax; }
		if m.contains("kimi") || m.contains("moonshot")	{ return Self::Kimi; }
		// LAST, and deliberately.  `gpt-oss-120b` is an open-weight model in the OpenAI dialect
		// and belongs here; putting this test first would also claim every slug that merely
		// carries `o3-` inside a longer name.
		if m.contains("gpt-") || m.starts_with("openai/")
			|| m.starts_with("o1-") || m.starts_with("o3-") || m.starts_with("o4-")
		{
			return Self::Gpt;
		}
		Self::Unknown
	}

	/// The family a trial arm forced, for `set_tune {"family": "kimi"}`.
	///
	/// `None` for a name no family answers to, so an arm cannot measure the default while its
	/// report says it measured a profile.
	pub fn from_name(name: &str) -> Option<Self> {
		match name.trim().to_lowercase().as_str() {
			"claude"	=> Some(Self::Claude),
			"gpt"		=> Some(Self::Gpt),
			"deepseek"	=> Some(Self::DeepSeek),
			"qwen"		=> Some(Self::Qwen),
			"glm"		=> Some(Self::Glm),
			"minimax"	=> Some(Self::MiniMax),
			"kimi"		=> Some(Self::Kimi),
			"unknown"	=> Some(Self::Unknown),
			_			=> None,
		}
	}

	/// The name `from_name` takes, for a tuned figure to be echoed back by.
	pub fn name(&self) -> &'static str {
		match self {
			Self::Claude	=> "claude",
			Self::Gpt		=> "gpt",
			Self::DeepSeek	=> "deepseek",
			Self::Qwen		=> "qwen",
			Self::Glm		=> "glm",
			Self::MiniMax	=> "minimax",
			Self::Kimi		=> "kimi",
			Self::Unknown	=> "unknown",
		}
	}

	/// What this family is told about calling tools, beyond what every model is told.
	///
	/// Empty for the three that earned nothing.  Each of the rest is one short section naming the
	/// mistake its own bank rows are full of, and nothing else: a second sentence about a mistake
	/// this family does not make is paid for on every request of every round.
	pub fn addendum(&self) -> &'static str {
		match self {
			Self::Kimi		=> KIMI_NOTE,
			Self::Qwen		=> QWEN_NOTE,
			Self::DeepSeek	=> DEEPSEEK_NOTE,
			Self::MiniMax	=> MINIMAX_NOTE,
			Self::Glm		=> GLM_NOTE,
			Self::Claude | Self::Gpt | Self::Unknown => "",
		}
	}

	/// Is this tool kept out of the offer for this family?
	///
	/// Withholding is measured and never precautionary: a tool a family reaches for and fails at
	/// costs a round each time, and a tool it never reaches for at all costs its schema on every
	/// request for nothing.
	pub fn withholds(&self, t: &Tool) -> bool {
		match self {
			// One dispatch on the whole bank and it went nowhere; and the turns that mattered
			// were spent repeating a malformed edit, which a worker cannot help with.
			Self::Kimi		=> matches!(t, Tool::SpawnAgent),
			// Two dispatches, both misdirected. It prefers whole-file writes and works alone.
			Self::MiniMax	=> matches!(t, Tool::SpawnAgent),
			_				=> false,
		}
	}

	/// Does `file_edit` offer this family the single-edit schema alone?
	///
	/// **Kimi's `edits` never reaches us.**  The raw upstream SSE was captured on 2026-09-13
	/// (`dev/tune/relay.mjs --raw`): every `arguments` delta the provider sent was a JSON string,
	/// they joined correctly, and what the model's own `file_edit` call contained was
	/// ` {"path": "…/src/report.js"} ` -- leading and trailing space, no hunk of any kind, six
	/// times in a row before it gave up and rewrote the whole file.  So the loss is upstream of
	/// this app, in the provider's parser for Kimi's native tool-call tokens, and no accumulator
	/// fix can recover it.  What CAN be done is to stop offering the shape that disappears: with
	/// `edits` out of the schema the model writes `old_string` and `new_string` at the top level,
	/// where they are ordinary string properties like `path` and survive.
	pub fn single_edit_only(&self) -> bool {
		matches!(self, Self::Kimi)
	}

	/// One line appended to a failed call's result, naming what this family got wrong.
	///
	/// `None` for a tool this family handles, and for every family that needs no hint.  The
	/// caller says it once per tool per turn: a line repeated on every round is a line a model
	/// learns to skip.
	pub fn hint(&self, tool: &str) -> Option<&'static str> {
		match (self, tool) {
			(Self::Kimi, "file_edit") => Some(
				"Send 'path' and the edit in the SAME object: \
				{\"path\":\"…\",\"old_string\":\"…\",\"new_string\":\"…\"}."),
			(Self::Qwen, "ask") | (Self::Qwen, "file_edit") => Some(
				"An array argument is a JSON array, never a quoted string holding one."),
			(Self::MiniMax, "file_edit") => Some(
				"file_edit changes part of a file; file_write replaces the whole of it."),
			(Self::DeepSeek, "file_edit") => Some(
				"Re-send only the edit the refusal named, copied again from a fresh file_read."),
			_ => None,
		}
	}

	/// One sentence appended to the nudge a LEAKED tool call earns, naming what this family
	/// wrote instead of a call.
	///
	/// `None` for every family that has not been caught doing it.  Glm earned it on
	/// 2026-09-14: turn 56 came back with `<tool_call>…<arg_key>…</arg_key>…</tool_call>` in
	/// `content` and no JSON `tool_calls` at all, so the app read an answer where a call had
	/// been meant.  Naming the syntax is the whole of the hint -- a model told only "that was
	/// wrong" has no way to know WHICH of the things it wrote was the mistake.
	pub fn leak_hint(&self) -> Option<&'static str> {
		match self {
			Self::Glm	=> Some(GLM_LEAK_HINT),
			_			=> None,
		}
	}

	/// The arguments as the tool should see them, generously read.
	///
	/// **Borrowed whenever nothing changed, which is the overwhelming case**, so the common path
	/// allocates nothing.  Each rule answers a shape that is on the bank and no shape that is
	/// not: guessing at a mistake nobody has made is how a pre-pass comes to rewrite a correct
	/// call into a wrong one.
	///
	/// Family-independent by design.  Both drifts below were sent by more than one family, and a
	/// tolerance gated on the slug would refuse the seventh model for a mistake the sixth is
	/// forgiven.  The parameter is kept because the rules ARE keyed to measurements of particular
	/// families, and the day one of them has to be narrowed the signature will not have to change.
	///
	/// # Arguments
	/// * `tool` - The wire name, which decides which keys are arrays.
	/// * `args` - The argument object exactly as the provider sent it.
	pub fn normalise_args<'a>(&self, tool: &str, args: &'a str) -> Cow<'a, str> {
		// Kimi wraps its object in a space at each end -- ` {"path": "…"} ` -- on every call it
		// makes, which no JSON reader here minds and every log reader has to squint at.
		let t = args.trim();
		let mut out: Cow<'a, str> = if t.len() == args.len() {
			Cow::Borrowed(args)
		} else {
			Cow::Owned(t.to_string())
		};
		// An array written as a quoted string: `"options": "[{\"label\": …}]"`.  Qwen sends
		// `ask` this way; `edit_asks` has forgiven the same drift on `edits` since 2026-09-12,
		// and this generalises it so every array-typed key gets the same reading.
		for key in array_keys(tool) {
			if let Some(fixed) = unquoted_array(out.as_ref(), key) {
				out = Cow::Owned(fixed);
			}
		}
		out
	}
}

/// The keys a tool's schema types as an array, and which therefore may not be a string.
fn array_keys(tool: &str) -> &'static [&'static str] {
	match tool {
		"ask"			=> &["options"],
		"file_edit"		=> &["edits"],
		"doc_edit"		=> &["edits"],
		"sheet_write"	=> &["edits"],
		"run"			=> &["argv"],
		"gather"		=> &["names"],
		_				=> &[],
	}
}

/// `args` with `key`'s quoted JSON array unquoted in place, or `None` where there was nothing to
/// do.
///
/// Conservative on purpose: the value must be a string whose content, unescaped, opens with `[`
/// and closes with `]`.  Anything else is left exactly as it was, because a pre-pass that guesses
/// turns a refusal the model can read into a result it cannot.
fn unquoted_array(args: &str, key: &str) -> Option<String> {
	let enc = match crate::llm::extract_json_string(args, key) {
		Some(v) => v,
		None    => return None,
	};
	let t = enc.trim();
	if !(t.starts_with('[') && t.ends_with(']')) {
		return None;
	}
	let (from, to) = match string_span(args, key) {
		Some(pair) => pair,
		None       => return None,
	};
	let mut out = String::with_capacity(args.len());
	out.push_str(&args[..from]);
	out.push_str(t);
	out.push_str(&args[to..]);
	Some(out)
}

/// The byte range of `key`'s string literal in `args`, quotes included.
///
/// Written here rather than borrowed because `extract_json_string` answers with the DECODED value
/// and this needs the span the encoded one occupies.  The scan honours `\\` inside the literal, so
/// a value ending in a backslash is not read as running to the end of the object.
fn string_span(args: &str, key: &str) -> Option<(usize, usize)> {
	let needle = fmt!("\"{}\"", key);
	let mut at = 0usize;
	while let Some(i) = args[at..].find(&needle) {
		let after = at + i + needle.len();
		let rest = &args[after..];
		let colon = match rest.find(|c: char| !c.is_whitespace()) {
			Some(j) if rest.as_bytes()[j] == b':' => after + j + 1,
			_ => { at = after; continue; },
		};
		let tail = &args[colon..];
		let open = match tail.find(|c: char| !c.is_whitespace()) {
			Some(j) if tail.as_bytes()[j] == b'"' => colon + j,
			// The value is not a string at all, which is the correct shape and nothing to do.
			_ => return None,
		};
		let bytes = args.as_bytes();
		let mut k = open + 1;
		while k < bytes.len() {
			match bytes[k] {
				b'\\' => k += 2,
				b'"'  => return Some((open, k + 1)),
				_     => k += 1,
			}
		}
		return None;
	}
	None
}

// ── The addenda ─────────────────────────────────────────────────────
//
// Each is ONE section, appended by `Role::compose_for` beside `VISION_NOTE` -- outside
// `prompts/<role>.md`, so a user's rewrite of their own prompt cannot lose it and the editor does
// not show it.  That is the standing trade for every composed note; what is different here is
// that these are ADDED where measurement said they were needed, rather than dropped where it said
// they were spare.  See `CONDITIONAL` in `crate::prompts` for the other mechanism.

/// Kimi: the call that arrived fifty times out of fifty with `path` and nothing else.
pub const KIMI_NOTE: &str =
	"## Tool calls\n\n\
	 Put every argument of a call in ONE JSON object: file_edit takes 'path' with 'old_string' \
	 and 'new_string' together, never 'path' alone. A refusal that names the keys you sent is \
	 the answer; do not send the same call again.";

/// Qwen: arrays as quoted strings, and `old_string` copied with the drift of a retyped line.
pub const QWEN_NOTE: &str =
	"## Tool calls\n\n\
	 Arrays are JSON arrays, never a quoted string: 'options' and 'edits' are lists of objects. \
	 Copy 'old_string' byte for byte from a file_read, tabs included, with the line-number \
	 prefix stripped.";

/// DeepSeek: a correct multi-hunk edit, re-sent whole when one hunk drifted.
pub const DEEPSEEK_NOTE: &str =
	"## Tool calls\n\n\
	 When a multi-hunk file_edit is refused it names the hunk that failed; re-send only that \
	 one, copied again from a fresh file_read.";

/// MiniMax: keys no schema names, and a whole-file write where an edit was meant.
pub const MINIMAX_NOTE: &str =
	"## Tool calls\n\n\
	 To change part of a file use file_edit with 'old_string'/'new_string'; file_write replaces \
	 the whole file and is for new files. Only the keys a tool's schema names are read.";

/// Glm: its own `<tool_call>` markup, written into the reply text.
///
/// One sentence, and it names the tags: the fragment the owner met carried
/// `</arg_key><arg_value>daimonfold</arg_value>` and nothing else, so a model told only that
/// its call was malformed would have no way to tell which of the things it wrote was meant.
pub const GLM_LEAK_HINT: &str =
	"Never write <tool_call>, <arg_key> or <arg_value> into the reply text; \
	 the call goes in the request's own tool_calls field.";

/// Glm: nine writes refused for being under the wrong folder.
pub const GLM_NOTE: &str =
	"## Tool calls\n\n\
	 Write only under the folders the briefing names as this chat's workspace; a path under \
	 another folder is refused, and the refusal lists where you may write.";


// ┌───────────────────────────────────────────────────────────────┐
// │ Tests                                                          │
// └───────────────────────────────────────────────────────────────┘

#[cfg(test)]
mod tests {
	use super::*;

	/// Every spelling a router has actually offered, answered by the right family.
	#[test]
	fn test_each_slug_a_router_offers_names_its_own_family() {
		let cases: &[(&str, Family)] = &[
			("anthropic/claude-opus-5",			Family::Claude),
			("claude-haiku-4.5-20260224",		Family::Claude),
			("openai/gpt-5",					Family::Gpt),
			("gpt-oss-120b",					Family::Gpt),
			("deepseek/deepseek-v4-pro",		Family::DeepSeek),
			("deepseek/deepseek-v4.1-flash",	Family::DeepSeek),
			("qwen/qwen3-coder-next",			Family::Qwen),
			("qwen/qwq-32b",					Family::Qwen),
			("z-ai/glm-5.3",					Family::Glm),
			("accounts/fireworks/models/glm-5p2",	Family::Glm),
			("minimax/minimax-m2.7",			Family::MiniMax),
			("moonshotai/kimi-k2.7-code",		Family::Kimi),
			("MoonshotAI/Kimi-K2.7-Code",		Family::Kimi),
		];
		for (slug, want) in cases {
			assert_eq!(*want, Family::detect(slug), "the family of {:?}", slug);
		}
	}

	/// A model nobody has measured is UNKNOWN, and unknown is everything as written.
	///
	/// The empty model is the one that matters: `compose` is reached from callers that do not
	/// always know which client will carry the request, and answering "needs nothing" there
	/// would quietly drop a note on every path that had not been taught to pass a model.
	#[test]
	fn test_an_unmeasured_model_and_an_empty_one_are_both_unknown() {
		for slug in ["a-model-nobody-knows", "", "   ", "llama-4-70b"] {
			assert_eq!(Family::Unknown, Family::detect(slug), "the family of {:?}", slug);
		}
		let u = Family::Unknown;
		assert_eq!("", u.addendum(), "an unknown model carries an addendum");
		assert!(!u.single_edit_only(), "an unknown model is offered a narrowed schema");
		assert!(!u.withholds(&Tool::SpawnAgent), "an unknown model is withheld a tool");
		assert_eq!(None, u.hint("file_edit"), "an unknown model is hinted at");
	}

	/// Price differs; dialect does not.
	#[test]
	fn test_the_flash_and_the_pro_of_one_family_are_one_family() {
		assert_eq!(Family::detect("deepseek/deepseek-v4.1-flash"),
			Family::detect("deepseek/deepseek-v4-pro"),
			"flash and pro differ in price, not in dialect");
	}

	/// The name a trial arm forces a profile by, round-tripped.
	#[test]
	fn test_a_trial_arm_can_force_a_profile_and_cannot_invent_one() {
		for f in [Family::Claude, Family::Gpt, Family::DeepSeek, Family::Qwen, Family::Glm,
			Family::MiniMax, Family::Kimi, Family::Unknown]
		{
			assert_eq!(Some(f), Family::from_name(f.name()), "the name of {:?}", f);
		}
		assert_eq!(None, Family::from_name("nonsense"),
			"an arm may name a family that does not exist");
	}

	/// The two families that earned a withholding, and the five that did not.
	#[test]
	fn test_only_a_measured_family_is_withheld_a_tool() {
		for f in [Family::Kimi, Family::MiniMax] {
			assert!(f.withholds(&Tool::SpawnAgent), "{:?} still offers spawn_agent", f.name());
			assert!(!f.withholds(&Tool::FileRead), "{:?} is withheld a file tool", f.name());
		}
		for f in [Family::Claude, Family::Gpt, Family::DeepSeek, Family::Qwen, Family::Glm,
			Family::Unknown]
		{
			for t in [Tool::SpawnAgent, Tool::FileEdit, Tool::FileRead] {
				assert!(!f.withholds(&t), "{:?} is withheld {}", f.name(), t.name());
			}
		}
	}

	/// Only Kimi is offered the narrowed `file_edit`, because only Kimi's `edits` is dropped
	/// before it arrives.
	#[test]
	fn test_the_single_edit_schema_goes_to_the_one_family_whose_edits_never_arrive() {
		assert!(Family::Kimi.single_edit_only());
		for f in [Family::Claude, Family::Gpt, Family::DeepSeek, Family::Qwen, Family::Glm,
			Family::MiniMax, Family::Unknown]
		{
			assert!(!f.single_edit_only(), "{:?} is offered the narrowed schema", f.name());
		}
	}

	/// Kimi's own wire bytes: the object is wrapped in a space at each end.
	///
	/// Captured from the upstream SSE on 2026-09-13, not typed out from memory.
	#[test]
	fn test_the_object_kimi_wraps_in_whitespace_is_unwrapped() {
		let args = " {\"path\": \"t_model-cur-moonshotai-kimi-k2-7-code-big-result-r1/src/report.js\"} ";
		let out = Family::Kimi.normalise_args("file_edit", args);
		assert!(out.starts_with('{') && out.ends_with('}'),
			"the object is still wrapped: {:?}", out.as_ref());
		assert!(matches!(out, Cow::Owned(_)), "a changed object was borrowed");
		// And an object that needed nothing is not copied.
		let clean = "{\"path\":\"a.rs\"}";
		assert!(matches!(Family::Kimi.normalise_args("file_edit", clean), Cow::Borrowed(_)),
			"an object that needed nothing was copied");
	}

	/// Qwen's own wire bytes: `options` as a quoted JSON string.
	#[test]
	fn test_an_array_written_as_a_quoted_string_is_unquoted_in_place() {
		let args = "{\"question\":\"Which?\",\"options\":\"[{\\\"label\\\": \\\"Create the files\\\", \
			\\\"means\\\": \\\"writes them\\\"}, {\\\"label\\\": \\\"Stop\\\", \\\"means\\\": \\\"does nothing\\\"}]\",\
			\"recommend\":\"Stop\"}";
		let out = Family::Qwen.normalise_args("ask", args);
		let got = crate::llm::extract_json_objects(out.as_ref(), "options");
		assert_eq!(2, got.map(|v| v.len()).unwrap_or(0),
			"options did not parse as two objects: {:?}", out.as_ref());
		assert!(out.contains("\"recommend\":\"Stop\""),
			"the rest of the object did not survive: {:?}", out.as_ref());
	}

	/// A value that is a string and is NOT an array is left exactly as it was.
	///
	/// The guard that keeps the pre-pass from inventing: a `question` holding a square bracket
	/// is prose, and rewriting it would turn a call that works into one that does not.
	#[test]
	fn test_a_string_that_is_not_an_array_is_left_alone() {
		let args = "{\"question\":\"Should we use [square brackets]?\",\"options\":\"nonsense\"}";
		assert!(matches!(Family::Qwen.normalise_args("ask", args), Cow::Borrowed(_)),
			"a string that is not an array was rewritten");
	}

	/// `gather`'s worker names are an array, and get the same forgiveness.
	///
	/// The rule this table exists for, arriving at the tool the pair added: a model that sends
	/// `"names": "[\"audit\"]"` would otherwise be told it named no worker this turn started,
	/// wait out the whole timeout, and learn nothing.
	#[test]
	fn test_gathers_worker_names_are_read_as_an_array() {
		let args = "{\"names\":\"[\\\"audit\\\", \\\"census\\\"]\",\"timeout_s\":60}";
		let out = Family::Qwen.normalise_args("gather", args);
		let got = crate::llm::extract_json_string_array(out.as_ref(), "names").unwrap_or_default();
		assert_eq!(vec![fmt!("audit"), fmt!("census")], got,
			"gather's names did not parse as two workers: {:?}", out.as_ref());
		assert!(out.contains("\"timeout_s\":60"),
			"the rest of the object did not survive: {:?}", out.as_ref());
	}

	/// A key no schema types as an array is not touched, whatever it holds.
	#[test]
	fn test_only_the_keys_a_schema_types_as_arrays_are_unquoted() {
		let args = "{\"path\":\"[a]\",\"content\":\"[1,2,3]\"}";
		assert!(matches!(Family::Qwen.normalise_args("file_write", args), Cow::Borrowed(_)),
			"file_write has no array key and something was rewritten");
	}

	/// Glm's leak hint, against the bytes that earned it.
	///
	/// Both forms of the live fragment: the one the page actually received, with
	/// `<tool_call>verify<arg_key>` consumed upstream, and the same call whole.  Kept together
	/// here because the hint has to be right for BOTH -- the model wrote one and the reader
	/// met the other, and a note aimed only at the shape that survives the wire would be
	/// addressed to a mistake nobody made.
	#[test]
	fn test_glms_leak_hint_names_the_tags_in_the_fragment_that_earned_it() {
		use crate::llm::tests::{LEAK_HEADLESS, LEAK_WHOLE};
		let hint = Family::Glm.leak_hint().unwrap_or("");
		assert!(!hint.is_empty(), "Glm carries no leak hint");
		// It names the tags, because "your call was malformed" tells a model nothing about
		// WHICH of the things it wrote was the mistake.
		for tag in ["<tool_call>", "<arg_key>", "<arg_value>"] {
			assert!(hint.contains(tag), "the hint does not name {}: {}", tag, hint);
			assert!(LEAK_WHOLE.contains(tag),
				"the fixture no longer holds {}, so the hint is aimed at nothing", tag);
		}
		// ONE SENTENCE.  It rides on a round the user is already paying for twice.
		assert_eq!(1, hint.matches('.').count(), "the hint grew past one sentence: {}", hint);

		// The head-stripped form is a leak and is NOT recoverable: no name, nothing to
		// dispatch, and a nudge is all that is left.
		let headless = crate::llm::leaked_tool_call(LEAK_HEADLESS)
			.unwrap_or_else(|| panic!("the live fragment reads as prose"));
		assert_eq!(None, headless.recovered);
		// The whole one recovers, which is why the nudge is not the only answer.
		let whole = crate::llm::leaked_tool_call(LEAK_WHOLE)
			.unwrap_or_else(|| panic!("a whole leaked call reads as prose"));
		match whole.recovered {
			Some(c) => assert_eq!("verify", c.name),
			None    => panic!("a whole call was not recovered: {}", whole.fragment),
		}
	}

	/// The hint belongs to the family that earned it, and to no other.
	#[test]
	fn test_only_the_family_caught_leaking_carries_the_leak_hint() {
		for f in [Family::Claude, Family::Gpt, Family::DeepSeek, Family::Qwen,
			Family::MiniMax, Family::Kimi, Family::Unknown]
		{
			assert_eq!(None, f.leak_hint(), "{:?} carries a hint it did not earn", f.name());
		}
	}

	/// A hint is a line for the family that earned it, and nothing for the rest.
	#[test]
	fn test_a_hint_belongs_to_the_family_that_earned_it() {
		let kimi = Family::Kimi.hint("file_edit").unwrap_or("");
		assert!(kimi.contains("SAME object"), "Kimi's hint does not say the thing: {}", kimi);
		assert_eq!(None, Family::Kimi.hint("file_read"),
			"Kimi is hinted at over a tool it handles");
		assert_eq!(None, Family::Claude.hint("file_edit"), "Claude is hinted at");
		assert_eq!(None, Family::Gpt.hint("file_edit"), "GPT is hinted at");
	}

	/// Each addendum names the mistake its own bank rows are full of, and no other family's.
	#[test]
	fn test_each_addendum_names_its_own_familys_mistake() {
		assert!(Family::Kimi.addendum().contains("ONE JSON object"));
		assert!(Family::Qwen.addendum().contains("never a quoted string"));
		assert!(Family::DeepSeek.addendum().contains("re-send only that"));
		assert!(Family::MiniMax.addendum().contains("file_write replaces"));
		assert!(Family::Glm.addendum().contains("workspace"));
		for f in [Family::Claude, Family::Gpt, Family::Unknown] {
			assert_eq!("", f.addendum(),
				"{:?} carries an addendum it did not earn", f.name());
		}
	}
}
