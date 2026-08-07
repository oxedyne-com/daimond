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

// ┌───────────────────────────────────────────────────────────────┐
// │ Message content                                                │
// └───────────────────────────────────────────────────────────────┘

/// An image format both wire dialects accept.
///
/// An enum rather than a free `String` media type, because the set is closed: Anthropic's
/// Messages API takes exactly these four and rejects anything else, and OpenAI's `image_url`
/// carries the same four in a `data:` URL.  A media type the model cannot decode is a provider
/// 400, which is the failure this type exists to make unreachable.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ImageMedia {
    Png,
    Jpeg,
    Gif,
    WebP,
}

impl ImageMedia {

    /// The IANA media type, as both dialects spell it.
    pub fn mime(&self) -> &'static str {
        match self {
            Self::Png  => "image/png",
            Self::Jpeg => "image/jpeg",
            Self::Gif  => "image/gif",
            Self::WebP => "image/webp",
        }
    }

    /// The media type read from the bytes themselves, or `None` when they are not an image.
    ///
    /// Sniffed rather than taken from the file extension: the extension is whatever the user
    /// typed, and a `.png` holding JPEG bytes is a provider 400 with a message about the media
    /// type that names the wrong one.  The magic numbers are each format's own header --
    /// PNG's signature, JPEG's start-of-image marker, GIF's version string, and RIFF/WEBP.
    ///
    /// # Arguments
    /// * `bytes` - The start of the file; four bytes are enough for three of the four.
    pub fn sniff(bytes: &[u8]) -> Option<Self> {
        const PNG: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        if bytes.len() >= 8 && bytes[..8] == PNG {
            return Some(Self::Png);
        }
        if bytes.len() >= 3 && bytes[..3] == [0xFF, 0xD8, 0xFF] {
            return Some(Self::Jpeg);
        }
        if bytes.len() >= 6 && (&bytes[..6] == b"GIF87a" || &bytes[..6] == b"GIF89a") {
            return Some(Self::Gif);
        }
        // RIFF containers hold more than WebP, so the form marker at offset 8 decides.
        if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
            return Some(Self::WebP);
        }
        None
    }

    /// The media type spelled the way [`mime`](Self::mime) spells it, for reading a stored part
    /// back.  An unknown string is refused rather than guessed: a part whose media type cannot be
    /// named cannot be sent.
    pub fn from_mime(s: &str) -> Option<Self> {
        match s {
            "image/png"  => Some(Self::Png),
            "image/jpeg" => Some(Self::Jpeg),
            "image/gif"  => Some(Self::Gif),
            "image/webp" => Some(Self::WebP),
            _ => None,
        }
    }
}

/// An image inside a message, held as the bytes that came off disk.
///
/// Bytes rather than base64: base64 is a wire encoding, and holding it would mean storing a third
/// more than the image weighs and re-decoding it to read the header.  It is encoded once per
/// request, in whichever dialect is being spoken, by the serialiser that needs it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ImagePart {
    /// What the bytes are, sniffed from the bytes.
    pub media:  ImageMedia,
    /// The file's own bytes, undecoded.
    pub data:   Vec<u8>,
    /// Where it came from, as the model asked for it.
    ///
    /// The whole reason an elided image is not a loss: the line left behind names the file, and
    /// the model can read it again.  See `crate::compact::elide_bulk`.
    pub source: String,
}

impl ImagePart {

    /// A new part from bytes whose media type has already been settled.
    ///
    /// # Arguments
    /// * `media` - What the bytes are.
    /// * `data` - The file's bytes.
    /// * `source` - The path the model asked for.
    pub fn new(media: ImageMedia, data: Vec<u8>, source: String) -> Self {
        Self { media, data, source }
    }

    /// The image's pixel dimensions, or `None` when this build cannot read that format's header.
    ///
    /// Header-only for both formats it knows -- neither reads a pixel -- because the only caller
    /// is the token estimate, which runs on every request of a long turn.  GIF and WebP return
    /// `None` and are estimated from their bytes instead; see `crate::compact::image_tokens`.
    pub fn dims(&self) -> Option<(usize, usize)> {
        match self.media {
            ImageMedia::Png  => oxedyne_fe2o3_graphics::png::dimensions(&self.data).ok(),
            ImageMedia::Jpeg => oxedyne_fe2o3_graphics::jpeg::dimensions(&self.data).ok(),
            ImageMedia::Gif | ImageMedia::WebP => None,
        }
    }

    /// The bytes as base64, which is the form both dialects put on the wire.
    pub fn base64(&self) -> String {
        oxedyne_fe2o3_text::base64::encode(&self.data)
    }

    /// The one line an elided image leaves behind, naming the file so it can be read again.
    pub fn elision(&self) -> String {
        fmt!("[image {} ({}, {} bytes) was dropped to fit the context window; read it again if \
             you need to look at it]", self.source, self.media.mime(), self.data.len())
    }
}

/// One piece of a message's content.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ContentPart {
    Text(String),
    Image(ImagePart),
}

/// What a message carries.
///
/// Two shapes rather than always a list, because the shapes are not equally common: nearly every
/// message in a session is plain text, and a list-of-one-text-part would make every caller,
/// every serialiser and every byte count walk a vector to find the string it already had.
/// [`Text`](Self::Text) is that case named, and [`Parts`](Self::Parts) is the case that needs a
/// list -- which today means an image, and tomorrow whatever else a model can be shown.
///
/// The invariant that keeps the two from drifting: [`Parts`](Self::Parts) is only ever built by
/// [`parts`](Self::parts), which collapses an all-text list back to [`Text`](Self::Text).  So two
/// contents that say the same thing compare equal, and no serialiser has to handle a `Parts`
/// carrying nothing but a string.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MessageContent {
    /// Plain text -- the overwhelmingly common case.
    Text(String),
    /// An ordered list of parts, at least one of which is not text.
    Parts(Vec<ContentPart>),
}

impl Default for MessageContent {
    fn default() -> Self {
        Self::Text(String::new())
    }
}

/// Content displays as its text, with each image named -- see [`MessageContent::as_text`].
///
/// Worth having rather than making every caller reach for `as_text`: the places that format a
/// message are error messages, log lines and test failures, and each of them wants exactly the
/// rendering `as_text` produces.
impl std::fmt::Display for MessageContent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.as_text())
    }
}

impl From<String> for MessageContent {
    fn from(s: String) -> Self { Self::Text(s) }
}

impl From<&str> for MessageContent {
    fn from(s: &str) -> Self { Self::Text(s.to_string()) }
}

impl MessageContent {

    /// Plain text content -- one call, which is what the common case deserves.
    pub fn text<S: Into<String>>(s: S) -> Self {
        Self::Text(s.into())
    }

    /// Content from a list of parts, collapsed to [`Text`](Self::Text) when nothing in it needs
    /// the list form.  See the type's own note on why that collapse is the invariant.
    pub fn parts(parts: Vec<ContentPart>) -> Self {
        if parts.iter().all(|p| matches!(p, ContentPart::Text(_))) {
            let mut s = String::new();
            for p in &parts {
                if let ContentPart::Text(t) = p {
                    if !s.is_empty() && !t.is_empty() {
                        s.push('\n');
                    }
                    s.push_str(t);
                }
            }
            return Self::Text(s);
        }
        Self::Parts(parts)
    }

    /// The content as text, with each image standing in for itself by name.
    ///
    /// Borrowed in the common case and built only when there are parts, so the panels, the ledger
    /// and the fold rendering -- all of which want a string and none of which can look at an
    /// image -- pay nothing on an ordinary message.
    pub fn as_text(&self) -> std::borrow::Cow<'_, str> {
        match self {
            Self::Text(s) => std::borrow::Cow::Borrowed(s.as_str()),
            Self::Parts(parts) => {
                let mut out = String::new();
                for p in parts {
                    if !out.is_empty() {
                        out.push('\n');
                    }
                    match p {
                        ContentPart::Text(t)  => out.push_str(t),
                        ContentPart::Image(i) => out.push_str(&fmt!(
                            "[image {} ({}, {} bytes)]", i.source, i.media.mime(), i.data.len())),
                    }
                }
                std::borrow::Cow::Owned(out)
            },
        }
    }

    /// Bytes of TEXT this content carries; an image's payload is not counted here.
    ///
    /// The separation is deliberate and is the whole of the token-accounting fix: an image costs
    /// what its pixels cost, not what its bytes cost, so it is measured by
    /// `crate::compact::image_bytes` instead and never by the text ratio.
    pub fn text_len(&self) -> usize {
        match self {
            Self::Text(s) => s.len(),
            Self::Parts(parts) => parts.iter().map(|p| match p {
                ContentPart::Text(t) => t.len(),
                // The `[image …]` stand-in a renderer would put here, near enough.
                ContentPart::Image(i) => i.source.len() + 32,
            }).sum(),
        }
    }

    /// Whether there is nothing to send.  An image alone is not empty.
    pub fn is_empty(&self) -> bool {
        match self {
            Self::Text(s) => s.is_empty(),
            Self::Parts(parts) => parts.is_empty(),
        }
    }

    /// The images this content carries, in order.
    pub fn images(&self) -> impl Iterator<Item = &ImagePart> {
        let slice: &[ContentPart] = match self {
            Self::Text(_) => &[],
            Self::Parts(parts) => parts.as_slice(),
        };
        slice.iter().filter_map(|p| match p {
            ContentPart::Image(i) => Some(i),
            ContentPart::Text(_)  => None,
        })
    }

    /// Whether there is an image in here.
    pub fn has_image(&self) -> bool {
        self.images().next().is_some()
    }

    /// The same content with every image replaced by the line that names it.
    ///
    /// What elision does to an image, and why elision is not a loss: the file is still named, and
    /// `file_read` will fetch it again.  See `crate::compact::elide_bulk`.
    pub fn without_images(&self) -> Self {
        match self {
            Self::Text(_) => self.clone(),
            Self::Parts(parts) => Self::parts(parts.iter().map(|p| match p {
                ContentPart::Text(t)  => ContentPart::Text(t.clone()),
                ContentPart::Image(i) => ContentPart::Text(i.elision()),
            }).collect()),
        }
    }

    /// Serialise to JDAT: a bare string for text, a list of typed maps for parts.
    ///
    /// The text case keeps the shape the store has always written, which is what lets a session
    /// snapshot round-trip without the reader knowing anything new.
    pub fn to_dat(&self) -> Dat {
        match self {
            Self::Text(s) => dat!(s.clone()),
            Self::Parts(parts) => {
                let items: Vec<Dat> = parts.iter().map(|p| {
                    let mut m = DaticleMap::new();
                    match p {
                        ContentPart::Text(t) => {
                            m.insert(dat!("type"), dat!("text"));
                            m.insert(dat!("text"), dat!(t.clone()));
                        },
                        ContentPart::Image(i) => {
                            m.insert(dat!("type"), dat!("image"));
                            m.insert(dat!("media_type"), dat!(i.media.mime()));
                            m.insert(dat!("source"), dat!(i.source.clone()));
                            // Bytes, not base64: the store holds what the file held, and BU64 is
                            // the byte vector JDAT reads back without a decode step.
                            m.insert(dat!("data"), Dat::BU64(i.data.clone()));
                        },
                    }
                    Dat::Map(m)
                }).collect();
                Dat::List(items)
            },
        }
    }

    /// Read back what [`to_dat`](Self::to_dat) wrote.
    ///
    /// A part that cannot be read -- an unknown media type, missing bytes -- is dropped rather
    /// than refusing the message: half a conversation read back is worth more to the user than an
    /// error, and the same reasoning already governs `ChatMessage::from_datmap`.
    pub fn from_dat(d: &Dat) -> Outcome<Self> {
        match d {
            Dat::Str(s) => Ok(Self::Text(s.clone())),
            Dat::List(items) => {
                let mut parts = Vec::with_capacity(items.len());
                for item in items {
                    let m = match item {
                        Dat::Map(m) => m,
                        _ => continue,
                    };
                    let kind = match m.get(&dat!("type")) {
                        Some(Dat::Str(s)) => s.as_str(),
                        _ => continue,
                    };
                    match kind {
                        "text" => {
                            if let Some(Dat::Str(t)) = m.get(&dat!("text")) {
                                parts.push(ContentPart::Text(t.clone()));
                            }
                        },
                        "image" => {
                            let media = match m.get(&dat!("media_type")) {
                                Some(Dat::Str(s)) => match ImageMedia::from_mime(s) {
                                    Some(mt) => mt,
                                    None => continue,
                                },
                                _ => continue,
                            };
                            let data = match m.get(&dat!("data")) {
                                Some(Dat::BU64(b)) => b.clone(),
                                _ => continue,
                            };
                            let source = match m.get(&dat!("source")) {
                                Some(Dat::Str(s)) => s.clone(),
                                _ => String::new(),
                            };
                            parts.push(ContentPart::Image(ImagePart::new(media, data, source)));
                        },
                        _ => continue,
                    }
                }
                Ok(Self::parts(parts))
            },
            _ => Err(err!("MessageContent: expected a string or a list of parts."; Invalid, Input)),
        }
    }
}


/// A single message in a conversation, mirroring the OpenAI API format.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ChatMessage {
    System { content: MessageContent },
    User { content: MessageContent },
    /// Assistant turn, with whatever tool calls it asked for.
    ///
    /// The calls are part of the message and are persisted with it.  They used to be
    /// dropped on the way to storage, which made a reloaded session illegal rather than
    /// merely lossy: the assistant turn came back bare and the `tool` replies that
    /// followed it answered nothing, and an OpenAI-compatible provider rejects that
    /// outright on every subsequent turn.
    Assistant { content: MessageContent, tool_calls: Vec<ToolCall> },
    /// Tool call result returned to the LLM.
    Tool { tool_call_id: String, content: MessageContent },
}

impl ChatMessage {

    /// A system message.  One call, because the common case is a bare string.
    pub fn system<C: Into<MessageContent>>(content: C) -> Self {
        Self::System { content: content.into() }
    }

    /// A user message.
    pub fn user<C: Into<MessageContent>>(content: C) -> Self {
        Self::User { content: content.into() }
    }

    /// An assistant message that asked for nothing.
    pub fn assistant<C: Into<MessageContent>>(content: C) -> Self {
        Self::Assistant { content: content.into(), tool_calls: Vec::new() }
    }

    /// An assistant message and the tool calls it made.
    pub fn assistant_calling<C: Into<MessageContent>>(content: C, tool_calls: Vec<ToolCall>)
        -> Self
    {
        Self::Assistant { content: content.into(), tool_calls }
    }

    /// A tool reply, paired to the call it answers.
    pub fn tool<C: Into<MessageContent>>(tool_call_id: String, content: C) -> Self {
        Self::Tool { tool_call_id, content: content.into() }
    }

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
                m.insert(dat!("content"), content.to_dat());
            }
            Self::User { content } => {
                m.insert(dat!("role"), dat!("user"));
                m.insert(dat!("content"), content.to_dat());
            }
            Self::Assistant { content, tool_calls } => {
                m.insert(dat!("role"), dat!("assistant"));
                m.insert(dat!("content"), content.to_dat());
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
                m.insert(dat!("content"), content.to_dat());
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
            Some(d) => res!(MessageContent::from_dat(d)),
            None => return Err(err!("ChatMessage: missing 'content'."; Invalid, Input)),
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

    /// What this message carries, whole.
    pub fn content(&self) -> &MessageContent {
        match self {
            Self::System { content }
            | Self::User { content }
            | Self::Assistant { content, .. }
            | Self::Tool { content, .. } => content,
        }
    }

    /// What this message says, as text, with any image standing in for itself by name.
    ///
    /// Borrowed on an ordinary message; see [`MessageContent::as_text`].
    pub fn text(&self) -> std::borrow::Cow<'_, str> {
        self.content().as_text()
    }

    /// The same message with its content replaced.  Role, tool calls and pairing id are kept,
    /// which is what makes an in-place elision safe: nothing a provider pairs on is touched.
    ///
    /// # Arguments
    /// * `content` - What to put in place of the old content.
    pub fn with_content(&self, content: MessageContent) -> Self {
        match self {
            Self::System { .. } => Self::System { content },
            Self::User { .. }   => Self::User { content },
            Self::Assistant { tool_calls, .. } =>
                Self::Assistant { content, tool_calls: tool_calls.clone() },
            Self::Tool { tool_call_id, .. } =>
                Self::Tool { tool_call_id: tool_call_id.clone(), content },
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
mod content_tests {
    use super::*;

    /// The one-pixel PNG Anthropic prints in its vision documentation, decoded.
    ///
    /// Source: `platform.claude.com/docs/en/build-with-claude/vision`.  Real bytes from a real
    /// provider document rather than a header this test invented, so the sniffer is being checked
    /// against a file the world agrees is a PNG.
    fn doc_png() -> Vec<u8> {
        oxedyne_fe2o3_text::base64::decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLv\
             AAAAAElFTkSuQmCC").expect("the documented base64 must decode")
    }

    /// Each format is recognised from its own header, and a RIFF container that is not a WebP is
    /// not mistaken for one.
    #[test]
    fn test_the_media_type_is_read_from_the_bytes() {
        assert_eq!(Some(ImageMedia::Png), ImageMedia::sniff(&doc_png()));
        assert_eq!(Some(ImageMedia::Jpeg), ImageMedia::sniff(&[0xFF, 0xD8, 0xFF, 0xE0, 0, 0]));
        assert_eq!(Some(ImageMedia::Gif), ImageMedia::sniff(b"GIF89a\x01\x00"));
        assert_eq!(Some(ImageMedia::WebP), ImageMedia::sniff(b"RIFF\x24\x00\x00\x00WEBPVP8 "));
        // A WAV is a RIFF too, and is not an image.
        assert_eq!(None, ImageMedia::sniff(b"RIFF\x24\x00\x00\x00WAVEfmt "));
        assert_eq!(None, ImageMedia::sniff(b"fn main() {}"));
        assert_eq!(None, ImageMedia::sniff(b""));
    }

    /// The media type survives a round trip through its own spelling, and an unknown spelling is
    /// refused rather than guessed.
    #[test]
    fn test_a_media_type_round_trips_through_its_mime() {
        for m in [ImageMedia::Png, ImageMedia::Jpeg, ImageMedia::Gif, ImageMedia::WebP] {
            assert_eq!(Some(m), ImageMedia::from_mime(m.mime()));
        }
        assert_eq!(None, ImageMedia::from_mime("image/tiff"));
    }

    /// A list of nothing but text collapses back to text, so two contents that say the same thing
    /// are the same content.
    #[test]
    fn test_an_all_text_parts_list_collapses() {
        let c = MessageContent::parts(vec![
            ContentPart::Text("one".to_string()),
            ContentPart::Text("two".to_string()),
        ]);
        assert_eq!(MessageContent::text("one\ntwo"), c);
        assert!(!c.has_image());

        let with_image = MessageContent::parts(vec![
            ContentPart::Text("look".to_string()),
            ContentPart::Image(ImagePart::new(ImageMedia::Png, doc_png(), "a.png".to_string())),
        ]);
        assert!(matches!(with_image, MessageContent::Parts(_)));
        assert!(with_image.has_image());
        assert_eq!(1, with_image.images().count());
    }

    /// An image's bytes are not counted as text, and its stand-in names it.
    #[test]
    fn test_an_image_is_named_in_the_text_and_not_weighed_as_text() {
        let c = MessageContent::parts(vec![
            ContentPart::Text("look".to_string()),
            ContentPart::Image(ImagePart::new(
                ImageMedia::Png, vec![0u8; 100_000], "shots/a.png".to_string())),
        ]);
        assert!(c.text_len() < 200, "the image's bytes were counted as text: {}", c.text_len());
        let t = c.as_text();
        assert!(t.contains("shots/a.png"), "{}", t);
        assert!(t.contains("image/png"), "{}", t);
    }

    /// Dropping the images leaves a line naming each, and nothing else changes.
    #[test]
    fn test_dropping_the_images_leaves_their_names() {
        let c = MessageContent::parts(vec![
            ContentPart::Text("here it is".to_string()),
            ContentPart::Image(ImagePart::new(
                ImageMedia::Png, doc_png(), "shots/a.png".to_string())),
        ]);
        let out = c.without_images();
        assert!(!out.has_image());
        let t = out.as_text();
        assert!(t.contains("here it is"), "the prose was lost: {}", t);
        assert!(t.contains("shots/a.png"), "the file was not named: {}", t);
        assert!(t.contains("read it again"), "the model was not told what to do: {}", t);
    }

    /// A message carrying an image survives storage byte for byte.
    ///
    /// The store is where a session lives between turns; a part that cannot be written and read
    /// back is a part the model loses on the first reload, silently.
    #[test]
    fn test_a_message_with_an_image_round_trips_through_the_store() {
        let img = ImagePart::new(ImageMedia::Png, doc_png(), "shots/a.png".to_string());
        let msg = ChatMessage::tool("call_1".to_string(), MessageContent::parts(vec![
            ContentPart::Text("Read the image shots/a.png.".to_string()),
            ContentPart::Image(img.clone()),
        ]));
        let back = ChatMessage::from_datmap(&msg.to_datmap()).expect("read back");
        assert_eq!(msg, back);
        let got = back.content().images().next().expect("the image was lost").clone();
        assert_eq!(img.data, got.data, "the bytes changed in storage");
        assert_eq!(ImageMedia::Png, got.media);
        assert_eq!("shots/a.png", got.source);
    }

    /// Plain text still writes the bare string the store has always held, so a snapshot from
    /// before this change reads back unchanged.
    #[test]
    fn test_plain_text_keeps_the_shape_the_store_always_had() {
        let msg = ChatMessage::user("hello".to_string());
        let m = msg.to_datmap();
        assert_eq!(Some(&dat!("hello")), m.get(&dat!("content")),
            "text content is no longer a bare string in the store");
        assert_eq!(msg, ChatMessage::from_datmap(&m).expect("read back"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_chat_message_roundtrip() {
        let msg = ChatMessage::user("Hello".to_string());
        let dm = msg.to_datmap();
        let msg2 = ChatMessage::from_datmap(&dm).unwrap();
        assert_eq!(msg, msg2);
    }

    #[test]
    fn test_chat_message_tool_roundtrip() {
        let msg = ChatMessage::Tool {
            tool_call_id: "call_123".to_string(),
            content: MessageContent::text("42"),
        };
        let dm = msg.to_datmap();
        let msg2 = ChatMessage::from_datmap(&dm).unwrap();
        assert_eq!(msg, msg2);
    }

    #[test]
    fn test_session_roundtrip() {
        let mut s = Session::new("s1".to_string(), "Test".to_string(), "glm-5p2".to_string());
        s.messages.push(ChatMessage::user("Hi".to_string()));
        s.messages.push(ChatMessage::assistant("Hello!".to_string()));
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
        s.messages.push(ChatMessage::user(fmt!("read the parser")));
        s.messages.push(ChatMessage::Assistant {
            content:    MessageContent::text(fmt!("Looking.")),
            tool_calls: vec![ToolCall {
                id:        fmt!("call_abc"),
                name:      fmt!("file_read"),
                arguments: fmt!("{{\"path\":\"src/parse.rs\"}}"),
            }],
        });
        s.messages.push(ChatMessage::Tool {
            tool_call_id: fmt!("call_abc"),
            content:      MessageContent::text(fmt!("fn parse() {{}}")),
        });
        s.messages.push(ChatMessage::Assistant {
            content: MessageContent::text(fmt!("It is one function.")), tool_calls: Vec::new(),
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
        let m = ChatMessage::assistant(fmt!("Hello."));
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
                assert_eq!(content.as_text(), "older");
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
